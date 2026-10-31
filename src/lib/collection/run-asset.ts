// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 资产描述符（design: docs/design/unified-workbench/design.md §2）。
// run-store 列表投影 + Σ成员会话指标（session-link join，唯一触 DB 点 →
// aggregateMemberStats 纯函数聚合单点）；join 失败不阻断列表
// （memberStats = null，指标列显示 —）。

import type { PrismaClient } from '@prisma/client';
import { displayModel } from '@/lib/collection/model-display';
import { listRuns, readRun } from '@/lib/run/run-store';
import { joinSessionRefs } from '@/lib/run/session-link';
import type { SessionRef } from '@/lib/run/model';
import { getActiveSplitMap } from '@/lib/active-time-map';
import { sessionDurationMs } from '@/lib/session-duration';
import type { RunAssetItem, RunMemberStats } from './types';

export interface RunAssetList {
  items: RunAssetItem[];
  warnings: string[];
}

/** 成员会话 join 结果 → run 行聚合指标（纯函数，无 IO）。tokens/cost/活跃时间
 *  累加、模型按会话计数分布、起止取成员极值——新增指标只动这里与
 *  RunMemberStats；活跃时间由 activeByRow 注入（turn 时间轴窗口，rowId 键，
 *  与会话行 Active 列同一实现，批量取数在 listRunItems）。 */
export function aggregateMemberStats(
  refs: Map<string, SessionRef>,
  activeByRow?: Map<string, { activeMs: number | null }>,
): RunMemberStats {
  const modelCount = new Map<string, number>();
  let totalTokens = 0;
  let totalCost = 0;
  let totalTurns = 0;
  let totalActiveMs: number | null = null;
  let totalDurationMs = 0;
  const memberRowIds: string[] = [];
  let earliestStart: number | null = null;
  let latestEnd: number | null = null;
  for (const ref of refs.values()) {
    totalTokens += ref.totalTokens;
    totalCost += ref.totalCost ?? 0;
    totalTurns += ref.turns;
    const model = displayModel(ref.model);
    if (model) modelCount.set(model, (modelCount.get(model) ?? 0) + 1);
    const active = activeByRow?.get(ref.rowId)?.activeMs;
    if (active != null) totalActiveMs = (totalActiveMs ?? 0) + active;
    memberRowIds.push(ref.rowId);
    // 时长口径同 sessionAggregates：墙钟（起止跨度），endTime 缺端点回落 latency
    totalDurationMs += sessionDurationMs(ref.startTime, ref.endTime, ref.totalLatencyMs ?? null);
    const st = ref.startTime != null ? Date.parse(ref.startTime) : NaN;
    if (Number.isFinite(st) && (earliestStart == null || st < earliestStart)) earliestStart = st;
    const en = ref.endTime != null ? Date.parse(ref.endTime) : NaN;
    if (Number.isFinite(en) && (latestEnd == null || en > latestEnd)) latestEnd = en;
  }
  return {
    joinedCount: refs.size,
    totalTokens,
    totalCost,
    totalTurns,
    totalActiveMs,
    totalDurationMs,
    memberRowIds,
    models: [...modelCount.entries()]
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model)),
    earliestStart: earliestStart != null ? new Date(earliestStart).toISOString() : null,
    latestEnd: latestEnd != null ? new Date(latestEnd).toISOString() : null,
  };
}

function runItemOf(run: ReturnType<typeof listRuns>['runs'][number], memberStats: RunMemberStats | null): RunAssetItem {
  return {
    kind: 'run',
    key: `run:${run.runId}`,
    runId: run.runId,
    name: run.name,
    status: run.status,
    exportDataComplete: run.exportDataComplete,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    importedAt: run.importedAt,
    generations: run.generations,
    nodeCount: run.nodeCount,
    memberCount: run.memberCount,
    sessionMemberCount: run.sessionMemberCount,
    rollbackCount: run.rollbackCount,
    subgraphCount: run.subgraphCount,
    warnings: run.warnings,
    memberStats,
  };
}

export async function listRunItems(
  opts?: { root?: string; prisma?: PrismaClient | null },
): Promise<RunAssetList> {
  const { runs, warnings } = listRuns(opts?.root);
  // 无 prisma（如 assetSummary 只取 runCount）：跳过 join/聚合，memberStats 全 null
  if (!opts?.prisma) {
    return { items: runs.map(run => runItemOf(run, null)), warnings };
  }
  // 两段式：先逐 run join 成员会话（session-link，唯一触 DB 点），再对全部
  // 成员行一次批量活跃拆分（getActiveSplitMap 单 turns 查询——与会话行
  // enrichSessionItems 同款批量口径），最后纯函数聚合
  const refsByRun = new Map<string, Map<string, SessionRef>>();
  const allRefsByRow = new Map<string, SessionRef>();
  for (const run of runs) {
    const stored = readRun(run.runId, opts.root);
    if (!stored) continue;
    try {
      const refs = await joinSessionRefs(stored.index, opts.prisma);
      refsByRun.set(run.runId, refs);
      for (const ref of refs.values()) allRefsByRow.set(ref.rowId, ref);
    } catch { /* join 失败不阻断列表 */ }
  }
  const activeByRow = await getActiveSplitMap(
    [...allRefsByRow.values()]
      .filter(r => r.startTime != null)
      .map(r => ({
        id: r.rowId,
        startTime: new Date(r.startTime!),
        endTime: r.endTime != null ? new Date(r.endTime) : null,
        version: r.version ?? null,
      })),
  );
  const items = runs.map(run => {
    const refs = refsByRun.get(run.runId);
    return runItemOf(run, refs ? aggregateMemberStats(refs, activeByRow) : null);
  });
  return { items, warnings };
}

/** q 过滤（runId / name 子串，大小写不敏感）——统一列表搜索的 run 侧投影 */
export function filterRunItems(items: RunAssetItem[], q: string): RunAssetItem[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(i =>
    i.runId.toLowerCase().includes(needle)
    || (i.name ?? '').toLowerCase().includes(needle),
  );
}
