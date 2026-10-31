// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 合并技能 collector（design: docs/design/run-observe-parity/design.md §3.2，刀D）。
// 作用域内成员会话的 SessionSkill 聚合（按 skillName 合并、invocationCount 求
// 和）+ SkillEvent 按事件时间平铺（SkillDetail 的 SkillEventItem 形状 + member
// 归因；session 页同域数据是从 turns 投影自组装的，此处单点直出真值——
// skillVersion/durationMs/errorMessage 不再置空回退）。turnIndex 为成员内
// 局部序，跨成员混排仅供事件列表展示（跳转/对账入口 run 侧不启用）。

import type { PrismaClient } from '@prisma/client';
import type { ObserveScope } from '@/lib/observe/scope';
import { memberByRowId, memberByTaskId } from '@/lib/observe/scope';
import { isSoloRunId } from '@/lib/run/identity';

export interface MergedSkillItem {
  skillName: string;
  version: number | null;
  invocationCount: number;
  /** 使用该技能的成员标签（run 合并视图归因；去重，按首见序） */
  members: string[];
}

export interface MergedSkillEventItem {
  id: string;
  skillName: string;
  skillVersion: number | null;
  eventType: string;
  success: boolean;
  errorMessage: string | null;
  durationMs: number;
  turnIndex: number;
  /** 事件所属 turn（run 时间观测的跳转闭环：turnId → Turns 深链） */
  turnId: string;
  /** turn 时间（createdAt_ts 回退 createdAt；缺失为 null——时间轴按事件序回落） */
  turnCreatedAt: string | null;
  agentName: string | null;
  isSubagent: boolean;
  subagentSessionId: string | null;
  turnTokens: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  member: { taskId: string; label: string | null } | null;
}

export interface CollectSkillsOptions {
  /** 成员 taskId 过滤（须在作用域内；调用方校验） */
  member?: string | null;
}

/** 派发观测项（run 时间观测的第二种群：子代理派发）。双源合一、按子代理
 * 会话去重——claude 真值优先（eventType=dispatch 的 SkillEvent，skillName=
 * 子代理名），未被覆盖的 run 成员按会话首 turn 推导（opencode 等框架无
 * dispatch 事件，成员本身就是被派发的子代理；solo 单会话不是派发种群，
 * 不推导）。 */
export interface MergedDispatchItem {
  id: string;
  /** 子代理基名：事件路径=skillName；推导路径=图结构 nodeId（verify 角色
   *  加 ·验收，与成员短名基名同规则），无图结构回落成员标签 */
  name: string;
  /** 派发动作所在 turn（事件路径）或子代理会话首 turn（推导路径） */
  turnId: string;
  at: string | null;
  /** 验收角色（仅推导路径有意义；事件路径无角色信息为 false） */
  verify: boolean;
  /** 归因成员：事件路径=派发动作所在父成员；推导路径=被派发的子代理成员 */
  member: { taskId: string; label: string | null; framework: string | null } | null;
  /** 子代理会话 token 合计（null = 子代理会话未入库，无从计量） */
  tokens: number | null;
  source: 'event' | 'member';
}

export async function collectScopeSkills(
  prisma: PrismaClient,
  scope: ObserveScope,
  options: CollectSkillsOptions = {},
) {
  if (scope.members.length === 0) return { skills: [], events: [], dispatches: [], total: 0 };
  const memberRowIds = options.member
    ? [memberByTaskId(scope).get(options.member)?.rowId].filter((r): r is string => r != null)
    : scope.members.map(m => m.rowId);
  if (memberRowIds.length === 0) return { skills: [], events: [], dispatches: [], total: 0 };

  const [skillRows, turnRows] = await Promise.all([
    prisma.sessionSkill.findMany({
      where: { sessionId: { in: memberRowIds } },
      select: { sessionId: true, skillName: true, skillVersion: true, invocationCount: true },
    }),
    prisma.turn.findMany({
      where: { sessionId: { in: memberRowIds } },
      select: {
        id: true,
        sessionId: true,
        turnIndex: true,
        agentName: true,
        isSubagent: true,
        subagentSessionId: true,
        createdAt: true,
        createdAt_ts: true,
        totalTokens: true,
        inputTokens: true,
        outputTokens: true,
        reasoningTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        skillEvents: {
          select: { skillName: true, skillVersion: true, eventType: true, success: true, errorMessage: true, durationMs: true, createdAt: true },
        },
      },
      orderBy: [
        { createdAt_ts: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    }),
  ]);

  // 嵌套 skillEvents 排序上移 JS：Prisma 6.19 引擎在「嵌套关系 orderBy + 全量
  // 父行拉取（约 ≥1000 行）」时 panic（record.rs no entry found for key，
  // 见 tests/ut/run-skills-engine-panic.test.ts）。升序 + null 首（与引擎
  // asc 语义一致），sort 稳定（同刻保持写入序）。
  for (const t of turnRows) {
    t.skillEvents.sort(
      (a, b) => (a.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY) - (b.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY),
    );
  }

  // SessionSkill 聚合：跨成员同名技能合并（invocationCount 求和、version 取最大、
  // members 收集使用成员标签）
  const byRowId = memberByRowId(scope);
  const byName = new Map<string, MergedSkillItem>();
  for (const r of skillRows) {
    const member = byRowId.get(r.sessionId);
    const memberLabel = member ? member.label ?? member.taskId : null;
    const cur = byName.get(r.skillName);
    if (!cur) {
      byName.set(r.skillName, {
        skillName: r.skillName,
        version: r.skillVersion,
        invocationCount: r.invocationCount,
        members: memberLabel != null ? [memberLabel] : [],
      });
    } else {
      cur.invocationCount += r.invocationCount;
      if (memberLabel != null && !cur.members.includes(memberLabel)) cur.members.push(memberLabel);
      if (r.skillVersion != null && (cur.version == null || r.skillVersion > cur.version)) cur.version = r.skillVersion;
    }
  }
  const skills = [...byName.values()].sort((a, b) => b.invocationCount - a.invocationCount || a.skillName.localeCompare(b.skillName));

  const events: MergedSkillEventItem[] = [];
  const dispatches: MergedDispatchItem[] = [];
  const dispatchedSids = new Set<string>();
  // 派发项 → 子代理会话 sid（token 回填键；事件路径=Turn.subagentSessionId，
  // 推导路径=成员自身）
  const subagentSidOf = new Map<string, string>();
  // 名单分拣：invoke/use/load/unload 见过的名字是真技能；只出现在 dispatch 事件
  // 里的名字是子代理（SessionSkill 聚合行也含它们——摄取口径故意计 dispatch），
  // 技能维不留幽灵行，派发维才是它们的归宿
  const actionNames = new Set<string>();
  const dispatchNames = new Set<string>();
  const firstTurnByRowId = new Map<string, { id: string; ts: Date | null }>();
  for (const t of turnRows) {
    const member = byRowId.get(t.sessionId);
    // turn 时间：createdAt_ts 优先回退 createdAt（同 API 层口径），双双缺失置
    // null——时间轴按事件序回落，不伪造时间
    const turnTs = t.createdAt_ts ?? t.createdAt ?? null;
    if (!firstTurnByRowId.has(t.sessionId)) firstTurnByRowId.set(t.sessionId, { id: t.id, ts: turnTs });
    for (const se of t.skillEvents) {
      // dispatch 是派发种群（MergedDispatchItem），不混进技能事件。
      // 派发的子代理会话在 Turn.subagentSessionId（派发动作所在轮）
      if (se.eventType === 'dispatch') {
        dispatchNames.add(se.skillName);
        if (t.subagentSessionId) dispatchedSids.add(t.subagentSessionId);
        const evId = `ev-${t.id}-${se.skillName}`;
        if (t.subagentSessionId) subagentSidOf.set(evId, t.subagentSessionId);
        dispatches.push({
          id: evId,
          name: se.skillName,
          turnId: t.id,
          at: turnTs != null ? turnTs.toISOString() : null,
          verify: false,
          member: member ? { taskId: member.taskId, label: member.label, framework: member.framework } : null,
          tokens: null,
          source: 'event',
        });
        continue;
      }
      actionNames.add(se.skillName);
      events.push({
        id: `${t.id}-${se.skillName}-${se.eventType}`,
        skillName: se.skillName,
        skillVersion: se.skillVersion,
        eventType: se.eventType,
        success: se.success,
        errorMessage: se.errorMessage,
        durationMs: se.durationMs,
        turnIndex: t.turnIndex,
        turnId: t.id,
        turnCreatedAt: turnTs != null ? turnTs.toISOString() : null,
        agentName: t.agentName,
        isSubagent: t.isSubagent,
        subagentSessionId: t.subagentSessionId,
        turnTokens: {
          totalTokens: t.totalTokens,
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          reasoningTokens: t.reasoningTokens,
          cacheReadTokens: t.cacheReadTokens,
          cacheWriteTokens: t.cacheWriteTokens,
        },
        member: member ? { taskId: member.taskId, label: member.label } : null,
      });
    }
  }
  // 成员首 turn 推导（opencode 等无 dispatch 事件的框架）：真 run 作用域才推
  //（solo 也是 kind:'run'，但单会话不是派发种群，isSoloRunId 除外）；claude
  // 真值覆盖的子代理会话不重复推导；无 turn 成员无从观测派发时刻，跳过
  if (scope.kind === 'run' && !isSoloRunId(scope.runId ?? '')) {
    const memberRowIdSet = new Set(memberRowIds);
    for (const m of scope.members) {
      if (!memberRowIdSet.has(m.rowId)) continue;
      if (dispatchedSids.has(m.taskId)) continue;
      const ft = firstTurnByRowId.get(m.rowId);
      if (!ft) continue;
      const memberId = `member-${m.taskId}`;
      subagentSidOf.set(memberId, m.taskId);
      dispatches.push({
        id: memberId,
        name: m.structure
          ? `${m.structure.nodeId}${m.structure.role === 'verify' ? '·验收' : ''}`
          : (m.label ?? m.taskId),
        turnId: ft.id,
        at: ft.ts != null ? ft.ts.toISOString() : null,
        verify: m.structure?.role === 'verify',
        member: { taskId: m.taskId, label: m.label, framework: m.framework },
        tokens: null,
        source: 'member',
      });
    }
  }
  // token 回填：子代理会话的 token 合计。成员会话按 rowId 直查（同 sid 双记录
  // 由作用域行号消歧）；事件路径的外部子代理按 taskId 查库、同 sid 双记录取
  // 大值（同一会话两种捕获不双计）。未入库的子代理保持 null——不伪造 0
  if (dispatches.length > 0) {
    const [memberTokRows, extTokRows] = await Promise.all([
      prisma.session.findMany({
        where: { id: { in: scope.members.map(m => m.rowId) } },
        select: { id: true, totalTokens: true },
      }),
      dispatchedSids.size > 0
        ? prisma.session.findMany({
            where: { taskId: { in: [...dispatchedSids] } },
            select: { taskId: true, totalTokens: true },
          })
        : Promise.resolve([] as Array<{ taskId: string; totalTokens: number | null }>),
    ]);
    const tokensBySid = new Map<string, number>();
    const sidByRowId = new Map(scope.members.map(m => [m.rowId, m.taskId] as const));
    for (const r of memberTokRows) {
      const sid = sidByRowId.get(r.id);
      if (sid != null && r.totalTokens != null) tokensBySid.set(sid, r.totalTokens);
    }
    const extMax = new Map<string, number>();
    for (const r of extTokRows) {
      if (r.totalTokens == null) continue;
      extMax.set(r.taskId, Math.max(extMax.get(r.taskId) ?? 0, r.totalTokens));
    }
    for (const [sid, tok] of extMax) if (!tokensBySid.has(sid)) tokensBySid.set(sid, tok);
    for (const d of dispatches) {
      const sid = subagentSidOf.get(d.id);
      d.tokens = sid != null ? tokensBySid.get(sid) ?? null : null;
    }
  }
  dispatches.sort((a, b) =>
    (a.at ?? '9999-').localeCompare(b.at ?? '9999-') || a.id.localeCompare(b.id),
  );
  // 幽灵行剔除：只在 dispatch 事件里出现、且无任何 invoke/use/load/unload 事件的
  // 名字是子代理（SessionSkill 聚合行含它们）——技能维剔除，派发维承载
  const visibleSkills = dispatchNames.size > 0
    ? skills.filter(s => actionNames.has(s.skillName) || !dispatchNames.has(s.skillName))
    : skills;
  return { skills: visibleSkills, events, dispatches, total: events.length };
}
