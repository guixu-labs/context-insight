// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话资产描述符（design: docs/design/unified-workbench/design.md §2）。
// Session 域读侧单点：run 会话隔离闸（excludedSessionIds）在此生效——
// SSR 首屏与 /api/observe/data 共用，修复此前翻页/搜索路由未隔离的缺口。

import type { PrismaClient } from '@prisma/client';
import { excludedSessionIds } from '@/lib/run/session-scope';
import { runsRoot } from '@/lib/run/run-store';
import { getLlmActiveMsMap } from '@/lib/llm-active-map';
import { getActiveSplitMap } from '@/lib/active-time-map';
import { sessionDurationMs } from '@/lib/session-duration';
import { countToolCallErrors } from '@/lib/tool-call-errors';
import type { SessionAssetItem } from './types';

export interface SessionRow {
  id: string;
  taskId: string;
  query: string | null;
  framework: string | null;
  version: string | null;
  startTime: Date;
  endTime: Date | null;
  totalTokens: number;
  totalCost: number;
  totalLatencyMs: number;
  totalToolCallCount: number;
  totalSkillLoadCount: number;
  totalSubagentCount: number;
  model: string | null;
  user: string | null;
  sourcePath: string | null;
  createdAt: Date;
}

const SESSION_SELECT = {
  id: true,
  taskId: true,
  query: true,
  framework: true,
  version: true,
  startTime: true,
  endTime: true,
  totalTokens: true,
  totalCost: true,
  totalLatencyMs: true,
  totalToolCallCount: true,
  totalSkillLoadCount: true,
  totalSubagentCount: true,
  model: true,
  user: true,
  sourcePath: true,
  createdAt: true,
} as const;

export interface SessionFilter {
  q?: string;
  user?: string;
  isSubagent?: string;
}

/** run 域会话隔离闸：bundle 导入的成员行不进统一列表。空 run 集 = 零开销短路。 */
export async function buildSessionScope(
  prisma: PrismaClient,
  root?: string,
): Promise<{ id: { notIn: string[] } } | null> {
  const excluded = await excludedSessionIds(prisma, root ?? runsRoot());
  return excluded.length > 0 ? { id: { notIn: excluded } } : null;
}

function buildWhere(filter: SessionFilter, scope: { id: { notIn: string[] } } | null) {
  const conditions: Record<string, unknown>[] = [];
  if (scope) conditions.push(scope);
  if (filter.user) conditions.push({ user: filter.user });
  if (filter.isSubagent) conditions.push({ executions: { some: { isSubagent: filter.isSubagent === 'true' } } });
  const q = filter.q?.trim();
  if (q) conditions.push({ OR: [{ taskId: { contains: q } }, { query: { contains: q } }, { label: { contains: q } }] });
  return conditions.length > 0 ? { AND: conditions } : {};
}

export async function listSessionRows(
  prisma: PrismaClient,
  filter: SessionFilter & { take?: number; skip?: number },
  scope: { id: { notIn: string[] } } | null,
): Promise<SessionRow[]> {
  return prisma.session.findMany({
    where: buildWhere(filter, scope),
    orderBy: { createdAt: 'desc' },
    ...(filter.skip != null ? { skip: filter.skip } : {}),
    ...(filter.take != null ? { take: filter.take } : {}),
    select: SESSION_SELECT,
  });
}

export async function countSessions(
  prisma: PrismaClient,
  filter: SessionFilter,
  scope: { id: { notIn: string[] } } | null,
): Promise<number> {
  return prisma.session.count({ where: buildWhere(filter, scope) });
}

/** 指标卡口径：计数/Σtokens/Σcost/Σ时长 带隔离；时长墙钟（endTime 缺失回落 latency） */
export async function sessionAggregates(
  prisma: PrismaClient,
  scope: { id: { notIn: string[] } } | null,
): Promise<{ count: number; totalTokens: number; totalCost: number; totalDurationMs: number }> {
  const count = await prisma.session.count(scope ? { where: scope } : undefined);
  const aggregates = await prisma.session.aggregate({
    ...(scope ? { where: scope } : {}),
    _sum: { totalTokens: true, totalCost: true },
  });
  const wallRows = await prisma.session.findMany({
    ...(scope ? { where: scope } : {}),
    select: { startTime: true, endTime: true, totalLatencyMs: true },
  });
  const totalDurationMs = wallRows.reduce(
    (sum, s) => sum + sessionDurationMs(s.startTime, s.endTime, s.totalLatencyMs), 0,
  );
  return {
    count,
    totalTokens: aggregates._sum.totalTokens ?? 0,
    totalCost: aggregates._sum.totalCost ?? 0,
    totalDurationMs,
  };
}

/** 行级富化（仅对最终切片批量计算，避免整页全量算活跃窗口）：
 *  llmActive = LLM 推理时间；activeSplit = 活跃/墙钟拆分 */
export async function enrichSessionItems(
  prisma: PrismaClient,
  rows: SessionRow[],
): Promise<SessionAssetItem[]> {
  const [llmActive, activeSplit] = await Promise.all([
    getLlmActiveMsMap(rows.map(r => r.id)),
    getActiveSplitMap(rows),
  ]);
  return rows.map(s => ({
    kind: 'session' as const,
    key: `session:${s.id}`,
    sessionId: s.id,
    taskId: s.taskId,
    query: s.query,
    framework: s.framework,
    version: s.version,
    startTime: s.startTime.toISOString(),
    endTime: s.endTime ? s.endTime.toISOString() : null,
    importedAt: s.createdAt.toISOString(),
    totalTokens: s.totalTokens,
    totalCost: s.totalCost,
    totalLatencyMs: s.totalLatencyMs,
    llmActiveMs: llmActive.get(s.id) ?? null,
    activeMs: activeSplit.get(s.id)?.activeMs ?? null,
    wallMs: activeSplit.get(s.id)?.wallMs ?? null,
    totalToolCallCount: s.totalToolCallCount,
    totalSkillLoadCount: s.totalSkillLoadCount,
    totalSubagentCount: s.totalSubagentCount,
    model: s.model,
    user: s.user,
    sourcePath: s.sourcePath,
  }));
}

/** Errors 指标卡：当前页会话的工具调用/技能失败计数（页级口径，维持原语义） */
export async function pageSessionErrorTotal(prisma: PrismaClient, rowIds: string[]): Promise<number> {
  if (rowIds.length === 0) return 0;
  const errorToolCalls = await prisma.toolCall.findMany({
    where: {
      turn: { sessionId: { in: rowIds } },
      OR: [
        { state: { in: ['error', 'failed'] } },
        { errorType: { not: null } },
        { resultJson: { contains: '<tool_use_error>' } },
        { resultJson: { contains: 'Exit code' } },
      ],
    },
    select: {
      id: true,
      toolName: true,
      resultJson: true,
      state: true,
      errorType: true,
      errorMessage: true,
      turn: { select: { sessionId: true, turnIndex: true } },
    },
  });
  const errorSkillEvents = await prisma.skillEvent.findMany({
    where: {
      turn: { sessionId: { in: rowIds } },
      success: false,
      errorMessage: { not: null },
    },
    select: {
      skillName: true,
      eventType: true,
      success: true,
      errorMessage: true,
      turn: { select: { sessionId: true, turnIndex: true } },
    },
  });
  const errorCounts = countToolCallErrors(errorToolCalls, errorSkillEvents);
  return rowIds.reduce((sum, sid) => sum + (errorCounts.get(sid)?.count ?? 0), 0);
}
