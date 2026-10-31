// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 合并上下文 collector（run 视角 Context tab 唯一数据源——旧 session 视图
// ContextTracker 的 run 泛化，泳道同款结构）。agent 划分与泳道一致：
//   root agent = 成员会话（session 即 agent，道名/卡名用成员短名，与泳道
//     root 道同源——scope.member.label 即 memberShortNames 产物）
//   subagent   = subagentSessionId（sid 全局唯一，跨成员池化）
// 产物两件：
//   turns       —— ContextTracker 可直食的瘦轮次投影（无 toolCalls/
//                  skillEvents/content 重负载字段，恒比旧 session 页的全量
//                  轮次载荷轻）+ member 归因
//   agentLimits —— 每 agent 的模型/上下文窗口上限（root 取会话模型、
//                  subagent 取首见非空轮模型归一；getContextWindowLimit
//                  服务端单点，客户端不再逐模型拉 config）
// 曲线/事件/悬浮等交互粒度依赖轮次级数据，与旧 session 视图同口径（全量
// 轮次进客户端计算）；大 run 载荷护栏 = 瘦投影本身。

import type { PrismaClient } from '@prisma/client';
import type { ObserveScope } from '@/lib/observe/scope';
import { memberByRowId } from '@/lib/observe/scope';
import { getContextWindowLimit } from '@/lib/context-window-config';
import { isProxyVersion } from '@/lib/shared/session-format';
import { joinSubagentIdentities } from '@/lib/observe/turn-identity';
import { fetchContentHeads } from '@/lib/observe/collectors/content-heads';

/** 瘦轮次投影：ContextTracker 分组/统计/事件/回放所需字段（无重负载列） */
export interface ContextTurnItem {
  turnId: string;
  turnIndex: number;
  role: string;
  contentSummary: string | null;
  agentName: string | null;
  isSubagent: boolean;
  subagentName: string | null;
  subagentSessionId: string | null;
  parentExecutionId: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputMessagesTokens: number;
  contextWindowPct: number | null;
  latencyMs: number;
  createdAt: string | null;
  completedAt: string | null;
  model: string | null;
  /** 子代理类型（identityOf 同源：joinSubagentIdentities 回填，泳道图例同款
   *  键 `subagentType ?? agentName` 的前半）；root 轮恒 null */
  subagentType: string | null;
  /** 成员归因（root 分组键 + 道名源；session 作用域/export 载荷为 null） */
  member: { taskId: string; label: string | null } | null;
}

/** 每 agent 的窗口上限：key 与 ContextTracker 分组键同构
 *  （root:`<memberTaskId>` / 裸 subagentSessionId） */
export interface ContextAgentLimit {
  key: string;
  kind: 'root' | 'subagent';
  model: string | null;
  contextLimit: number | null;
}

export interface ScopeContextData {
  turns: ContextTurnItem[];
  agentLimits: ContextAgentLimit[];
}

export async function collectScopeContext(
  prisma: PrismaClient,
  scope: ObserveScope,
): Promise<ScopeContextData> {
  if (scope.members.length === 0) return { turns: [], agentLimits: [] };
  const rowIds = scope.members.map(m => m.rowId);

  const [rows, sessionModels] = await Promise.all([
    prisma.turn.findMany({
      where: { sessionId: { in: rowIds } },
      select: {
        id: true, sessionId: true, turnIndex: true, role: true, contentSummary: true,
        agentName: true, isSubagent: true, subagentName: true, subagentSessionId: true,
        parentExecutionId: true, totalTokens: true, inputTokens: true, outputTokens: true,
        reasoningTokens: true, cacheReadTokens: true, cacheWriteTokens: true,
        inputMessagesTokens: true, contextWindowPct: true, latencyMs: true,
        createdAt_ts: true, createdAt: true, completedAt: true, model: true,
      },
      orderBy: [{ sessionId: 'asc' }, { turnIndex: 'asc' }],
    }),
    prisma.session.findMany({
      where: { id: { in: rowIds } },
      select: { id: true, model: true, version: true },
    }),
  ]);
  // contentSummary 缺失回退：substr 下推 SQLite（content 列 35MB 级，按列全取
  // 物化后只取 200 字符是纯浪费——瘦投影语义不变，载荷路径变轻）
  const contentHeads = rows.some(r => r.contentSummary == null)
    ? await fetchContentHeads(prisma, rowIds, 200)
    : new Map<string, string>();
  const modelByRow = new Map(sessionModels.map(s => [s.id, s.model]));
  const isProxyByRowId = new Map(sessionModels.map(s => [s.id, isProxyVersion(s.version)]));
  const byRowId = memberByRowId(scope);

  // 子代理类型回填（与 turns 收集器 / 泳道同一 join——各 tab 图例/卡名键
  // `subagentType ?? agentName` 的前半，口径不分裂）
  const identityBySession = rows.some(r => r.subagentSessionId)
    ? await (async () => {
        const bridgeRows = await prisma.interactionBridge.findMany({
          where: { sessionId: { in: rowIds }, subagentSessionId: { not: null } },
          orderBy: [{ dispatchTimestamp: 'asc' }],
          select: { sessionId: true, subagentSessionId: true, subagentType: true, dispatchContent: true },
        });
        return joinSubagentIdentities(
          rows.map(r => ({ sessionId: r.sessionId, subagentSessionId: r.subagentSessionId, subagentName: r.subagentName })),
          bridgeRows,
          sid => isProxyByRowId.get(sid) ?? false,
        );
      })()
    : new Map<string, { subagentType: string | null; step: string | null }>();

  // subagent 模型归一：首见非空轮模型（与 collectScopeTurns 同口径——子代理
  // 轮的 model 常缺失，窗口上限不能逐轮抖动）
  const subModelBySid = new Map<string, string>();
  for (const r of rows) {
    if (!r.isSubagent || !r.subagentSessionId || !r.model) continue;
    if (!subModelBySid.has(r.subagentSessionId)) subModelBySid.set(r.subagentSessionId, r.model);
  }

  const turns: ContextTurnItem[] = rows.map(r => {
    const member = byRowId.get(r.sessionId);
    return {
      turnId: r.id,
      turnIndex: r.turnIndex,
      role: r.role,
      contentSummary: r.contentSummary ?? contentHeads.get(r.id) ?? null,
      agentName: r.agentName,
      isSubagent: r.isSubagent,
      subagentName: r.subagentName,
      subagentSessionId: r.subagentSessionId,
      subagentType: r.isSubagent && r.subagentSessionId
        ? identityBySession.get(r.subagentSessionId)?.subagentType ?? null
        : null,
      parentExecutionId: r.parentExecutionId,
      totalTokens: r.totalTokens,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      reasoningTokens: r.reasoningTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      inputMessagesTokens: r.inputMessagesTokens,
      contextWindowPct: r.contextWindowPct,
      latencyMs: r.latencyMs,
      createdAt: (r.createdAt_ts ?? r.createdAt)?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      model: r.model,
      member: member ? { taskId: member.taskId, label: member.label } : null,
    };
  });

  const agentLimits: ContextAgentLimit[] = [];
  for (const m of scope.members) {
    const model = modelByRow.get(m.rowId) ?? null;
    agentLimits.push({
      key: `root:${m.taskId}`,
      kind: 'root',
      model,
      contextLimit: model ? getContextWindowLimit(model) : null,
    });
  }
  const seenSub = new Set<string>();
  for (const r of rows) {
    if (!r.isSubagent || !r.subagentSessionId || seenSub.has(r.subagentSessionId)) continue;
    seenSub.add(r.subagentSessionId);
    const model = subModelBySid.get(r.subagentSessionId) ?? modelByRow.get(r.sessionId) ?? null;
    agentLimits.push({
      key: r.subagentSessionId,
      kind: 'subagent',
      model,
      contextLimit: model ? getContextWindowLimit(model) : null,
    });
  }

  return { turns, agentLimits };
}
