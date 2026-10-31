// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 轮次关键词搜索纯函数（design: docs/design/run-observe-parity/design.md §3.2）。
// 从 /api/observe/session/turns/search 原位抽取：content / contentSummary /
// 工具调用 args / result / error 五路匹配 + 「同 turn 先命中正文则不再出
// 工具条目」去重 + 上下文截取。session 与 run 两个端点共用（run 侧跨成员
// 全域搜索、按 sessionId 归因 member），匹配语义单点不复制。

export interface TurnSearchRow {
  id: string;
  sessionId: string;
  turnIndex: number;
  role: string;
  content: string | null;
  contentSummary: string | null;
  agentName: string | null;
  isSubagent: boolean;
  subagentName: string | null;
  subagentSessionId: string | null;
  createdAt_ts: Date | null;
  createdAt: Date;
  /** 命中轮的思维链 token 数（可选——命中索引的 thinking 过滤面；行源缺省则该面不可用） */
  reasoningTokens?: number | null;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    dispatchBridgeId: string | null;
    argsJson: string | null;
    resultJson: string | null;
    errorMessage: string | null;
  }>;
}

export interface TurnSearchItem {
  turnId: string;
  turnIndex: number;
  role: string;
  agentName: string | null;
  isSubagent: boolean;
  subagentName: string | null;
  subagentSessionId: string | null;
  contentSummary: string | null;
  matchContext: string;
  matchField: 'content' | 'contentSummary' | 'toolResult' | 'toolError' | 'toolArgs';
  toolName?: string;
  createdAt: string;
  hasDispatchBridge: boolean;
  /** 命中轮的思维链 token 数（可选——thinking 过滤面） */
  reasoningTokens?: number | null;
  /** 命中轮用过的工具名全集（小写去重，可选——工具过滤面） */
  toolNames?: string[];
  /** run 作用域归因（session 端点不传 memberOf 时不出现，响应字节不变） */
  member?: { taskId: string; label: string | null } | null;
}

function extractMatchContext(text: string, keyword: string, contextRadius: number = 60): string {
  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const idx = lowerText.indexOf(lowerKeyword);
  if (idx === -1) return text.substring(0, contextRadius * 2);
  const start = Math.max(0, idx - contextRadius);
  const end = Math.min(text.length, idx + keyword.length + contextRadius);
  let context = text.substring(start, end);
  if (start > 0) context = '...' + context;
  if (end < text.length) context = context + '...';
  return context;
}

export interface MatchTurnSearchOptions {
  /** sessionId → 成员归因（run 作用域）；缺省不附 member */
  memberOf?: (sessionId: string) => { taskId: string; label: string | null } | null;
}

export function matchTurnSearch(rows: TurnSearchRow[], keyword: string, options: MatchTurnSearchOptions = {}): TurnSearchItem[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (normalizedKeyword.length === 0) return [];
  const seenTurnIds = new Set<string>();
  const items: TurnSearchItem[] = [];
  const memberOf = options.memberOf;

  for (const t of rows) {
    const contentLower = (t.content ?? '').toLowerCase();
    const summaryLower = (t.contentSummary ?? '').toLowerCase();
    const contentMatch = contentLower.includes(normalizedKeyword);
    const summaryMatch = summaryLower.includes(normalizedKeyword);
    const member = memberOf ? memberOf(t.sessionId) : undefined;
    // 过滤面数据（同轮三路命中共用）：工具名全集（小写去重）+ 思维链 token 数
    const toolNames = [...new Set(t.toolCalls.map(tc => tc.toolName.toLowerCase()))];
    const reasoningTokens = t.reasoningTokens ?? null;

    if (contentMatch) {
      seenTurnIds.add(t.id);
      items.push({
        turnId: t.id,
        turnIndex: t.turnIndex,
        role: t.role,
        agentName: t.agentName,
        isSubagent: t.isSubagent,
        subagentName: t.subagentName,
        subagentSessionId: t.subagentSessionId,
        contentSummary: t.contentSummary ?? t.content?.substring(0, 200) ?? null,
        matchContext: extractMatchContext(t.content ?? '', keyword.trim()),
        matchField: 'content',
        createdAt: t.createdAt_ts?.toISOString() ?? t.createdAt.toISOString(),
        hasDispatchBridge: t.toolCalls.some(tc => tc.dispatchBridgeId !== null && tc.dispatchBridgeId !== undefined),
        reasoningTokens,
        toolNames,
        ...(member !== undefined ? { member } : {}),
      });
    } else if (summaryMatch) {
      seenTurnIds.add(t.id);
      items.push({
        turnId: t.id,
        turnIndex: t.turnIndex,
        role: t.role,
        agentName: t.agentName,
        isSubagent: t.isSubagent,
        subagentName: t.subagentName,
        subagentSessionId: t.subagentSessionId,
        contentSummary: t.contentSummary ?? t.content?.substring(0, 200) ?? null,
        matchContext: extractMatchContext(t.contentSummary ?? t.content?.substring(0, 200) ?? '', keyword.trim()),
        matchField: 'contentSummary',
        createdAt: t.createdAt_ts?.toISOString() ?? t.createdAt.toISOString(),
        hasDispatchBridge: t.toolCalls.some(tc => tc.dispatchBridgeId !== null && tc.dispatchBridgeId !== undefined),
        reasoningTokens,
        toolNames,
        ...(member !== undefined ? { member } : {}),
      });
    }

    for (const tc of t.toolCalls) {
      const argsLower = (tc.argsJson ?? '').toLowerCase();
      const resultLower = (tc.resultJson ?? '').toLowerCase();
      const errorLower = (tc.errorMessage ?? '').toLowerCase();
      const argsMatch = argsLower.includes(normalizedKeyword);
      const resultMatch = resultLower.includes(normalizedKeyword);
      const errorMatch = errorLower.includes(normalizedKeyword);

      if (argsMatch || resultMatch || errorMatch) {
        if (seenTurnIds.has(t.id) && items.some(it => it.turnId === t.id && (it.matchField === 'content' || it.matchField === 'contentSummary'))) continue;
        seenTurnIds.add(t.id);
        let matchText = '';
        let field: 'toolArgs' | 'toolResult' | 'toolError' = 'toolArgs';
        if (argsMatch) { matchText = tc.argsJson ?? ''; field = 'toolArgs'; }
        else if (resultMatch) { matchText = tc.resultJson ?? ''; field = 'toolResult'; }
        else { matchText = tc.errorMessage ?? ''; field = 'toolError'; }
        items.push({
          turnId: t.id,
          turnIndex: t.turnIndex,
          role: t.role,
          agentName: t.agentName,
          isSubagent: t.isSubagent,
          subagentName: t.subagentName,
          subagentSessionId: t.subagentSessionId,
          contentSummary: t.contentSummary ?? t.content?.substring(0, 200) ?? null,
          matchContext: `🔧 ${tc.toolName}: ${extractMatchContext(matchText, keyword.trim())}`,
          matchField: field,
          toolName: tc.toolName,
          createdAt: t.createdAt_ts?.toISOString() ?? t.createdAt.toISOString(),
          hasDispatchBridge: tc.dispatchBridgeId !== null && tc.dispatchBridgeId !== undefined,
          reasoningTokens,
          toolNames,
          ...(member !== undefined ? { member } : {}),
        });
      }
    }
  }

  return items;
}
