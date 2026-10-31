// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一列表编排（design: docs/design/unified-workbench/design.md §3.2）。
// 单表混排：会话行（Prisma，隔离闸）与 run 行（run-store 扫描）按导入时间
// 倒序归并。混排分页取会话 take = page*pageSize——run 行在时间线上任意
// 穿插，只有取到本页末尾才能正确切片（正确性：第 k 个会话的归并位次 ≥ k，
// 故本页切片所需会话的 k < page*pageSize）。SSR 首屏与 /api/observe/data
// 共用本单点（隔离闸随 session-asset 下沉，两路一致）。

import type { PrismaClient } from '@prisma/client';
import { runsRoot } from '@/lib/run/run-store';
import type { AssetItem, AssetKindFilter, AssetQuery, AssetSummary, RunAssetItem } from './types';
import {
  buildSessionScope,
  countSessions,
  enrichSessionItems,
  listSessionRows,
  sessionAggregates,
  type SessionRow,
} from './session-asset';
import { filterRunItems, listRunItems } from './run-asset';

export interface AssetListResult {
  items: AssetItem[];
  /** 过滤后总数（kind + q） */
  total: number;
  /** 未过滤总数（q 搜索时显示 N of M；无搜索 = null） */
  totalCount: number | null;
  /** run-store 扫描降级警告（坏目录占位） */
  runWarnings: string[];
}

type MergeEntry =
  | { type: 'session'; row: SessionRow; sortKey: string }
  | { type: 'run'; item: RunAssetItem; sortKey: string };

export async function queryAssetList(
  prisma: PrismaClient,
  query: AssetQuery,
  root?: string,
): Promise<AssetListResult> {
  const q = query.q?.trim() ?? '';
  const kind: AssetKindFilter = query.kind ?? 'all';
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(100, Number(query.pageSize ?? 20)));
  const runsHome = root ?? runsRoot();
  const filter = { q, user: query.user, isSubagent: query.isSubagent };

  if (kind === 'run') {
    const { items, warnings } = await listRunItems({ root: runsHome, prisma });
    const filtered = filterRunItems(items, q);
    const slice = filtered.slice((page - 1) * pageSize, page * pageSize);
    return {
      items: slice,
      total: filtered.length,
      totalCount: q ? items.length : null,
      runWarnings: warnings,
    };
  }

  const scope = await buildSessionScope(prisma, runsHome);

  if (kind === 'session') {
    const rows = await listSessionRows(prisma, {
      ...filter,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }, scope);
    const [items, total, totalCount] = await Promise.all([
      enrichSessionItems(prisma, rows),
      countSessions(prisma, filter, scope),
      q ? countSessions(prisma, {}, scope) : Promise.resolve(null),
    ]);
    return { items, total, totalCount, runWarnings: [] };
  }

  // kind=all：run 全量（量级小）+ 会话取到本页末尾，时间线归并后切片
  const [{ items: runItems, warnings }, rows] = await Promise.all([
    listRunItems({ root: runsHome, prisma }),
    listSessionRows(prisma, { ...filter, take: page * pageSize }, scope),
  ]);
  const runFiltered = filterRunItems(runItems, q);

  const entries: MergeEntry[] = [
    ...rows.map(row => ({ type: 'session' as const, row, sortKey: row.createdAt.toISOString() })),
    ...runFiltered.map(item => ({ type: 'run' as const, item, sortKey: item.importedAt ?? '' })),
  ];
  entries.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  const sliceEntries = entries.slice((page - 1) * pageSize, page * pageSize);
  const sliceRows = sliceEntries.filter((e): e is Extract<MergeEntry, { type: 'session' }> => e.type === 'session').map(e => e.row);
  const [enriched, total, totalCount] = await Promise.all([
    enrichSessionItems(prisma, sliceRows),
    countSessions(prisma, filter, scope),
    q ? countSessions(prisma, {}, scope) : Promise.resolve(null),
  ]);
  const enrichedByKey = new Map(enriched.map(i => [i.key, i]));
  const items: AssetItem[] = sliceEntries.map(e =>
    e.type === 'run' ? e.item : enrichedByKey.get(`session:${e.row.id}`)!,
  );

  return {
    items,
    total: total + runFiltered.length,
    totalCount: totalCount != null ? totalCount + runItems.length : null,
    runWarnings: warnings,
  };
}

/** 指标卡口径（系统总消耗）：Σ指标 = 独立会话（隔离闸内）+ run 成员
 *  （memberStats 复用列表行同一聚合单点；join 不到库的成员两侧都不计，
 *  与行内口径一致）。Total Duration = Σ时长（独立 + 成员）。 */
export async function assetSummary(prisma: PrismaClient, root?: string): Promise<AssetSummary> {
  const runsHome = root ?? runsRoot();
  const [scope, { items: runItems }] = await Promise.all([
    buildSessionScope(prisma, runsHome),
    listRunItems({ root: runsHome, prisma }),
  ]);
  const aggregates = await sessionAggregates(prisma, scope);
  const runTokens = runItems.reduce((s, r) => s + (r.memberStats?.totalTokens ?? 0), 0);
  const runCost = runItems.reduce((s, r) => s + (r.memberStats?.totalCost ?? 0), 0);
  const runDurationMs = runItems.reduce((s, r) => s + (r.memberStats?.totalDurationMs ?? 0), 0);
  const runMemberCount = runItems.reduce((s, r) => s + (r.memberStats?.joinedCount ?? 0), 0);
  return {
    sessionCount: aggregates.count,
    runCount: runItems.length,
    runMemberCount,
    totalTokens: aggregates.totalTokens + runTokens,
    totalCost: aggregates.totalCost + runCost,
    totalDurationMs: aggregates.totalDurationMs + runDurationMs,
  };
}
