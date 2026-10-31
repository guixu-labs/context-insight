// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 合并执行切片 collector（design: docs/design/run-observe-parity/design.md §3.2）。
// 作用域内成员会话的 Execution（root + subagent 切片，含技能挂接）批量收齐，
// 映射与 /api/observe/executions 同构——PerfPanorama 经端点覆盖直食，语义
// 单点不复制。Perf 观测按成员单选消费（turnIndex 轴在成员内才有意义）。

import type { PrismaClient } from '@prisma/client';
import type { ObserveScope } from '@/lib/observe/scope';
import { memberByRowId, memberByTaskId } from '@/lib/observe/scope';
import { buildAgentSpans, agentSpanKey } from '@/lib/observe/agent-spans';
import { isProxyVersion } from '@/lib/shared/session-format';
import { fetchContentHeads } from '@/lib/observe/collectors/content-heads';

export interface CollectExecutionsOptions {
  /** 成员 taskId 过滤（须在作用域内；调用方校验） */
  member?: string | null;
}

export async function collectScopeExecutions(
  prisma: PrismaClient,
  scope: ObserveScope,
  options: CollectExecutionsOptions = {},
) {
  if (scope.members.length === 0) {
    return { items: [], root: [], subagents: [], totalExecutions: 0, subagentCount: 0 };
  }
  const memberRowIds = options.member
    ? [memberByTaskId(scope).get(options.member)?.rowId].filter((r): r is string => r != null)
    : scope.members.map(m => m.rowId);
  if (memberRowIds.length === 0) {
    return { items: [], root: [], subagents: [], totalExecutions: 0, subagentCount: 0 };
  }

  const executions = await prisma.execution.findMany({
    where: { sessionId: { in: memberRowIds } },
    orderBy: [{ isSubagent: 'asc' }, { createdAt: 'asc' }],
    include: {
      executionSkills: {
        select: { skillName: true, skillVersion: true, isPrimary: true },
      },
    },
  });

  // 泳道数据（run 级 agent 全景）：每个 agent 的 turns 跨度 + 原始活跃区间
  // （算法在 lib/observe/agent-spans，与 session 详情同源）与首条用户提示
  // （泳道悬停）。proxy 判定按成员会话行（run 级成员可能混布 proxy/native）。
  const [turnTimes, userTurns, memberSessions] = await Promise.all([
    prisma.turn.findMany({
      where: { sessionId: { in: memberRowIds } },
      select: { sessionId: true, isSubagent: true, subagentSessionId: true, createdAt_ts: true, completedAt: true, latencyMs: true },
    }),
    prisma.turn.findMany({
      where: { sessionId: { in: memberRowIds }, role: 'user' },
      orderBy: [{ sessionId: 'asc' }, { turnIndex: 'asc' }],
      select: { id: true, sessionId: true, isSubagent: true, subagentSessionId: true, contentSummary: true },
    }),
    prisma.session.findMany({
      where: { id: { in: memberRowIds } },
      select: { id: true, version: true },
    }),
  ]);
  // 首条用户提示的 contentSummary 缺失回退：substr(1,80) 下推 SQLite（content
  // 按列全取只为 80 字符头——投影纪律与 turns/context 收集器同一单源）
  const userTurnHeads = userTurns.some(t => t.contentSummary == null)
    ? await fetchContentHeads(prisma, memberRowIds, 80)
    : new Map<string, string>();
  const isProxyByRowId = new Map(memberSessions.map(s => [s.id, isProxyVersion(s.version)]));
  const spansBySession = new Map<string, ReturnType<typeof buildAgentSpans>>();
  for (const rowId of memberRowIds) {
    spansBySession.set(rowId, buildAgentSpans(
      turnTimes.filter(t => t.sessionId === rowId),
      isProxyByRowId.get(rowId) ?? false,
    ));
  }
  // 首条用户提示：root 取该成员首条 user turn，subagent 按会话内首条（与
  // session 详情同口径：contentSummary 优先，缺省回落 content 前 80 字符）
  const firstPromptBySession = new Map<string, string | null>();
  for (const t of userTurns) {
    const key = `${t.sessionId}\u0000${agentSpanKey(t.isSubagent, t.subagentSessionId)}`;
    if (firstPromptBySession.has(key)) continue;
    firstPromptBySession.set(key, t.contentSummary ?? userTurnHeads.get(t.id) ?? null);
  }

  const subagentExecutions = executions.filter(e => e.isSubagent);
  const byRowId = memberByRowId(scope);
  const memberOf = (sessionId: string) => {
    const m = byRowId.get(sessionId);
    return m ? { taskId: m.taskId, label: m.label, isProxy: isProxyByRowId.get(sessionId) ?? false } : null;
  };

  const items = executions.map(e => ({
    executionId: e.id,
    sessionId: e.sessionId,
    agentName: e.agentName,
    agentSessionId: e.agentSessionId,
    isSubagent: e.isSubagent,
    subagentType: e.subagentType,
    subagentName: e.subagentName,
    parentExecutionId: e.parentExecutionId,
    rootExecutionId: e.rootExecutionId,
    depth: e.depth,
    tokens: e.tokens,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    reasoningTokens: e.reasoningTokens,
    cacheReadInputTokens: e.cacheReadInputTokens,
    cacheCreationInputTokens: e.cacheCreationInputTokens,
    cost: e.cost,
    latencyMs: e.latencyMs,
    toolCallCount: e.toolCallCount,
    toolCallErrorCount: e.toolCallErrorCount,
    llmCallCount: e.llmCallCount,
    skillLoadCount: e.skillLoadCount,
    skillInvokeCount: e.skillInvokeCount,
    maxSingleCallTokens: e.maxSingleCallTokens,
    model: e.model,
    createdAt: e.createdAt.toISOString(),
    span: spansBySession.get(e.sessionId)?.get(agentSpanKey(e.isSubagent, e.agentSessionId))?.span ?? null,
    activeIntervals: spansBySession.get(e.sessionId)?.get(agentSpanKey(e.isSubagent, e.agentSessionId))?.activeIntervals ?? [],
    firstPrompt: firstPromptBySession.get(`${e.sessionId}\u0000${agentSpanKey(e.isSubagent, e.agentSessionId)}`) ?? null,
    member: memberOf(e.sessionId),
    skills: e.executionSkills.map(s => ({
      skillName: s.skillName,
      skillVersion: s.skillVersion,
      isPrimary: s.isPrimary,
    })),
  }));

  const root = executions.filter(e => !e.isSubagent).map(e => ({
    executionId: e.id,
    agentName: e.agentName,
    agentSessionId: e.agentSessionId,
    isSubagent: e.isSubagent,
    member: memberOf(e.sessionId),
    tokens: e.tokens,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    reasoningTokens: e.reasoningTokens,
    cacheReadInputTokens: e.cacheReadInputTokens,
    cacheCreationInputTokens: e.cacheCreationInputTokens,
    cost: e.cost,
    latencyMs: e.latencyMs,
    toolCallCount: e.toolCallCount,
    skillLoadCount: e.skillLoadCount,
    skillInvokeCount: e.skillInvokeCount,
    llmCallCount: e.llmCallCount,
    model: e.model,
    subagentCount: subagentExecutions.length,
    createdAt: e.createdAt.toISOString(),
  }));

  const subagents = subagentExecutions.map(e => ({
    executionId: e.id,
    agentName: e.agentName,
    agentSessionId: e.agentSessionId,
    isSubagent: e.isSubagent,
    member: memberOf(e.sessionId),
    subagentType: e.subagentType,
    subagentName: e.subagentName,
    parentExecutionId: e.parentExecutionId,
    rootExecutionId: e.rootExecutionId,
    depth: e.depth,
    tokens: e.tokens,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cost: e.cost,
    latencyMs: e.latencyMs,
    toolCallCount: e.toolCallCount,
    skillLoadCount: e.skillLoadCount,
    skillInvokeCount: e.skillInvokeCount,
    llmCallCount: e.llmCallCount,
    model: e.model,
    createdAt: e.createdAt.toISOString(),
  }));

  return {
    items,
    root,
    subagents,
    totalExecutions: executions.length,
    subagentCount: subagentExecutions.length,
  };
}
