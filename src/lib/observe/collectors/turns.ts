// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 合并轮次 collector（design: docs/design/run-observe-parity/design.md §3.2）。
// 作用域内全部成员会话的 turn 按事件时间（createdAt_ts，缺省回落 createdAt）
// 全局混排——run : 成员会话 ≈ session : 子代理的对称观测面。投影恒 light
//（轮次列表可食的形状 + member 归因 + inputMessagesCount 轻字段）：重负载
// 字段（inputMessagesJson / wire 原文 / 大捕获）不进本层——单 turn 深钻走
// 既有 /api/observe/turn/[turnId]（turnId 全局唯一），不在此复制。
//
// 排序三键 [createdAt_ts asc nulls-last, createdAt asc, id asc] 确定性全序；
// 事件时间列可空使 coalesce 键集游标在 Prisma 下不可表达，故取稳定全序 +
// offset 分页（run 导入后静态，无活写入位移风险）。

import type { PrismaClient } from '@prisma/client';
import type { ObserveScope } from '@/lib/observe/scope';
import { memberByRowId, memberByTaskId } from '@/lib/observe/scope';
import { joinSubagentIdentities, type TurnIdentity } from '@/lib/observe/turn-identity';
import { isProxyVersion } from '@/lib/shared/session-format';
import { wireToolDurations } from '@/lib/tool-timing';
import { fetchContentHeads } from '@/lib/observe/collectors/content-heads';
import { summarizeToolCallErrors, toolCallErrorMessage, type TurnErrorDigest } from '@/lib/tool-call-errors';

export interface MergedToolCallItem {
  toolCallId: string;
  toolName: string;
  state: string;
  durationMs: number;
  /** 错误信息抽取（Error Turns 卡：Exit code / <tool_use_error>）——与 session
   *  turns 同契约；Overview 全量消费方与 Turns 页签共用本端点 */
  resultJson?: string | null;
}

export interface MergedSkillEventItem {
  skillName: string;
  eventType: string;
  success: boolean;
  errorMessage: string | null;
}

/** 合并轮次（TurnTimeline TurnRowItem / PerfPanorama TurnPerf 兼容 +
 *  member 归因；session 作用域 member=null） */
export interface MergedTurnItem {
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
  /** LLM 输入消息条数（Turns 节点 Δ 输入卡的历史边界） */
  inputMessagesCount: number;
  contextWindowPct: number | null;
  latencyMs: number;
  createdAt: string | null;
  completedAt: string | null;
  model: string | null;
  finishReason: string | null;
  /** 子代理身份双字段（lib/observe/turn-identity join 回填） */
  subagentType: string | null;
  dispatchStep: string | null;
  toolCalls: MergedToolCallItem[];
  skillEvents: MergedSkillEventItem[];
  member: { taskId: string; label: string | null } | null;
  /** 轮级错误摘要（includeErrorDigest 时仅错误轮携带）：Overview Error
   *  Turns 卡/Errors 瓦片消费——替代 includeToolResult 原文全量下发 */
  errorDigest?: TurnErrorDigest;
}

export interface CollectTurnsOptions {
  /** 成员 taskId 过滤（须在作用域内；调用方校验） */
  member?: string | null;
  /** 1 起 */
  page?: number;
  /** 默认 200，硬上限 500（性能护栏：turns 恒分页） */
  pageSize?: number;
  /** 工具调用结果原文（Error Turns 卡错误信息抽取）：轻投影缺省不带——
   *  Turns tab 单轮深钻走顶级 turn 端点；Overview 全量消费方请改用
   *  includeErrorDigest（服务端预算错误摘要，无需 18MB 级原文进响应） */
  includeToolResult?: boolean;
  /** 轮级错误摘要服务端预算（Overview 消费）：错误工具调用经独立过滤查询
   *  （state/errorType/原文标记，超集于客户端分类条件），摘要与消息提取
   *  与客户端 summarizeToolCallErrors/toolCallErrorMessage 单一源同口径 */
  includeErrorDigest?: boolean;
}

export interface CollectTurnsResult {
  items: MergedTurnItem[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 200;
/** 页容量上限（刀F 统一）：单成员 = session 端点同款负载；跨成员混排同样
 *  放行到 20000——light 投影比 session 全量投影更轻，Perf 全景等整段消费方
 *  需要全量（Turns tab UI 自身恒请求 ≤500，护栏由调用方控制而非 API 钳制） */
const MAX_PAGE_SIZE = 20_000;

/** 校验 member 过滤参数；返回错误原因（null = 通过：未传或在作用域内） */
export function validateScopeMember(scope: ObserveScope, member: string | null | undefined): string | null {
  if (member == null || member === '') return null;
  return memberByTaskId(scope).has(member) ? null : 'member-not-in-run';
}

export async function collectScopeTurns(
  prisma: PrismaClient,
  scope: ObserveScope,
  options: CollectTurnsOptions = {},
): Promise<CollectTurnsResult> {
  const page = Number.isFinite(options.page) && (options.page ?? 1) > 0 ? Math.floor(options.page!) : 1;
  const requestedPageSize = Number.isFinite(options.pageSize) && (options.pageSize ?? 0) > 0 ? Math.floor(options.pageSize!) : DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);
  if (scope.members.length === 0) return { items: [], total: 0, page, pageSize };

  const memberRowIds = options.member
    ? [memberByTaskId(scope).get(options.member)?.rowId].filter((r): r is string => r != null)
    : scope.members.map(m => m.rowId);
  if (memberRowIds.length === 0) return { items: [], total: 0, page, pageSize };

  const where = { sessionId: { in: memberRowIds } };
  // 显式轻投影（性能层）：不带顶层 select 时 Prisma 物化 Turn 全部标量列
  //（content/contentJson/inputMessagesJson 等 35MB 级全文）后丢弃——重列
  // 只留 contentSummary；其缺失回退经 fetchContentHeads 把 substr 下推
  // SQLite，不再整列进 JS
  const [rows, total] = await Promise.all([
    prisma.turn.findMany({
      where,
      orderBy: [
        { createdAt_ts: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      select: {
        id: true, sessionId: true, turnIndex: true, role: true, contentSummary: true,
        agentName: true, isSubagent: true, subagentName: true, subagentSessionId: true,
        parentExecutionId: true, totalTokens: true, inputTokens: true, outputTokens: true,
        reasoningTokens: true, cacheReadTokens: true, cacheWriteTokens: true,
        inputMessagesCount: true,
        contextWindowPct: true, latencyMs: true, createdAt_ts: true, createdAt: true,
        completedAt: true, model: true, finishReason: true,
        toolCalls: { select: { toolCallId: true, toolName: true, state: true, durationMs: true, ...(options.includeToolResult ? { resultJson: true } : {}) } },
        skillEvents: { select: { skillName: true, eventType: true, success: true, errorMessage: true } },
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.turn.count({ where }),
  ]);
  const contentHeads = rows.some(t => t.contentSummary == null)
    ? await fetchContentHeads(prisma, memberRowIds, 200)
    : new Map<string, string>();

  // 混模成员：subagent 的 null-model turn 回退该 subagent 首个 assistant 的
  // model（session turns 端点同款归一；批查一次、首见即定，无逐 turn N+1）
  const subagentModels = new Map<string, string>();
  if (rows.some(t => !t.model && t.subagentSessionId)) {
    const subs = await prisma.turn.findMany({
      where: { sessionId: { in: memberRowIds }, subagentSessionId: { not: null }, role: 'assistant', model: { not: null } },
      select: { subagentSessionId: true, model: true },
      orderBy: [{ turnIndex: 'asc' }],
    });
    for (const r of subs) {
      if (r.subagentSessionId == null || r.model == null) continue;
      if (!subagentModels.has(r.subagentSessionId)) subagentModels.set(r.subagentSessionId, r.model);
    }
  }

  // 成员会话行元数据（子代理身份 isProxy 判定 + wire 时长增补共用）：一次
  // 批查拿齐 per-row framework/version/sourcePath
  const memberSessions = await prisma.session.findMany({
    where: { id: { in: memberRowIds } },
    select: { id: true, taskId: true, framework: true, version: true, sourcePath: true },
  });
  const memberSessionByRowId = new Map(memberSessions.map(s => [s.id, s]));
  const isProxyByRowId = new Map(memberSessions.map(s => [s.id, isProxyVersion(s.version)]));

  // wire 轮间隙推导（cpx 捕获）：DB per-call durationMs 采集侧未回填（全 0），
  // 与 session turns 处理器同口径——durationMs > 0 优先、wire 兜底、无 wire
  // 保持 0。懒加载（仅当页内出现 0 时长工具调用才读捕获）；非 claude-format
  // 成员（原生 opencode 无 wire）wireToolDurations 内部短路 null
  const wireCache = new Map<string, Map<string, number> | null>();
  const wireOf = (rowId: string): Map<string, number> | null => {
    if (wireCache.has(rowId)) return wireCache.get(rowId) ?? null;
    const s = memberSessionByRowId.get(rowId);
    const w = s ? wireToolDurations(s.sourcePath, s.taskId, s.framework, s.version) : null;
    wireCache.set(rowId, w);
    return w;
  };

  const byRowId = memberByRowId(scope);
  // 子代理身份双字段（类型 + 派发步骤）：join 算法在 lib/observe/turn-identity
  // （session turns 处理器同源）——run 级成员可能混布 proxy/native，isProxy 按
  // turn 所属会话行判定
  const identityBySession = rows.some(t => t.subagentSessionId)
    ? await (async () => {
        const bridgeRows = await prisma.interactionBridge.findMany({
          where: { sessionId: { in: memberRowIds }, subagentSessionId: { not: null } },
          orderBy: [{ dispatchTimestamp: 'asc' }],
          select: { sessionId: true, subagentSessionId: true, subagentType: true, dispatchContent: true },
        });
        return joinSubagentIdentities(
          rows.map(t => ({ sessionId: t.sessionId, subagentSessionId: t.subagentSessionId, subagentName: t.subagentName })),
          bridgeRows,
          (sid) => isProxyByRowId.get(sid) ?? false,
        );
      })()
    : new Map<string, TurnIdentity>();
  // 轮级错误摘要（includeErrorDigest）：错误工具调用先经独立过滤查询收齐
  //（state/errorType/原文标记——消费端分类条件的超集，非错误轮零参与），
  // 再用共享 summarizeToolCallErrors/toolCallErrorMessage 预算摘要——与客
  // 户端原文计算逐值同口径（IT 锁 parity），Overview 响应不再携带 resultJson
  const digestByTurnId = options.includeErrorDigest
    ? await (async () => {
        const errorCalls = await prisma.toolCall.findMany({
          where: {
            turn: { sessionId: { in: memberRowIds } },
            OR: [
              { state: { in: ['error', 'failed'] } },
              { errorType: { not: null } },
              { resultJson: { contains: '<tool_use_error>' } },
              { resultJson: { contains: 'Exit code' } },
            ],
          },
          select: { turnId: true, toolCallId: true, toolName: true, state: true, errorType: true, resultJson: true },
        });
        const errByToolCallId = new Map(errorCalls.map(c => [c.toolCallId, c]));
        const byTurn = new Map<string, typeof errorCalls>();
        for (const c of errorCalls) {
          const list = byTurn.get(c.turnId) ?? [];
          list.push(c);
          byTurn.set(c.turnId, list);
        }
        const digest = new Map<string, TurnErrorDigest>();
        for (const t of rows) {
          const errCalls = byTurn.get(t.id);
          const skillFail = t.skillEvents.some(se => !se.success && se.errorMessage != null);
          const truncated = t.finishReason === 'length' || t.finishReason === 'max_tokens';
          if ((errCalls?.length ?? 0) === 0 && !skillFail && !truncated) continue;
          const patched = t.toolCalls.map(tc => {
            const err = errByToolCallId.get(tc.toolCallId);
            return err != null
              ? { toolName: tc.toolName, state: tc.state, errorType: err.errorType, resultJson: err.resultJson }
              : tc;
          });
          const summary = summarizeToolCallErrors(patched, t.skillEvents, t.finishReason);
          if (summary.total === 0) continue;
          digest.set(t.id, {
            ...summary,
            messages: patched
              .map(tc => ({ toolName: tc.toolName, message: toolCallErrorMessage(tc) }))
              .filter(m => m.message !== ''),
            skillMessages: t.skillEvents
              .filter(se => !se.success && se.errorMessage != null)
              .map(se => ({ skillName: se.skillName, message: se.errorMessage!.substring(0, 60) })),
          });
        }
        return digest;
      })()
    : new Map<string, TurnErrorDigest>();
  const items: MergedTurnItem[] = rows.map(t => {
    const member = byRowId.get(t.sessionId);
    return {
      turnId: t.id,
      turnIndex: t.turnIndex,
      role: t.role,
      contentSummary: t.contentSummary ?? contentHeads.get(t.id) ?? null,
      agentName: t.agentName,
      isSubagent: t.isSubagent,
      subagentName: t.subagentName,
      subagentSessionId: t.subagentSessionId,
      parentExecutionId: t.parentExecutionId,
      totalTokens: t.totalTokens,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      reasoningTokens: t.reasoningTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      inputMessagesCount: t.inputMessagesCount,
      contextWindowPct: t.contextWindowPct,
      latencyMs: t.latencyMs,
      createdAt: t.createdAt_ts?.toISOString() ?? t.createdAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null,
      model: t.model || (t.subagentSessionId ? subagentModels.get(t.subagentSessionId) ?? null : null),
      finishReason: t.finishReason,
      subagentType: identityBySession.get(t.subagentSessionId ?? '')?.subagentType ?? null,
      dispatchStep: identityBySession.get(t.subagentSessionId ?? '')?.step ?? null,
      toolCalls: t.toolCalls.map(tc => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        state: tc.state,
        durationMs: tc.durationMs > 0
          ? tc.durationMs
          : (wireOf(t.sessionId)?.get(tc.toolCallId) ?? tc.durationMs),
        resultJson: (tc as { resultJson?: string | null }).resultJson,
      })),
      ...(digestByTurnId.has(t.id) ? { errorDigest: digestByTurnId.get(t.id)! } : {}),
      skillEvents: t.skillEvents.map(se => ({
        skillName: se.skillName,
        eventType: se.eventType,
        success: se.success,
        errorMessage: se.errorMessage,
      })),
      member: member ? { taskId: member.taskId, label: member.label } : null,
    };
  });
  return { items, total, page, pageSize };
}
