// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// viewModel 成员引用拍平（纯函数）：run 页成员维度单点——
// Overview 成员表（全字段）与 Audit 成员钻取（身份子集）同源，
// 拍平规则（execute/verify/pending 全收 + sid 去重）不复制。

import type { RunViewModel, SessionMemberRef } from './view-model';

export interface RunMemberRow {
  taskId: string;
  framework: string;
  displayName: string;
  role: string;
  nodeId: string;
  generation: number;
  attempt: number;
  model: string | null;
  turns: number;
  totalTokens: number;
  totalCost: number | null;
  durationMs: number | null;
  contextPeakPct: number | null;
  /** 会话源路径（页头刷新/自动同步能力判定：无源不可增量刷新） */
  sourcePath: string | null;
}

export interface MemberShortNameInput {
  taskId: string;
  nodeId: string | null;
  generation: number | null;
  attempt: number | null;
  role: string | null;
  memberName: string | null;
}

/** 成员短名（run 页成员维度单点）：run = 一个 agent，成员会话 = 泳道。
 *  名字取图结构逻辑名（nodeId，跨代稳定），不用 session.label（首条 prompt
 *  开头，不可读）。规则：
 *  - 基名 = nodeId（verify 角色加 ·验收）；无图结构回落 run-store 成员名 →
 *    短 taskId（12 字符）
 *  - 重名消歧（同节点跨代/多尝试各占一条会话）：·g{generation} → 仍重名补
 *    ·{attempt} → 仍重名补序号——逐级叠加，全部成员同轮计算保证稳定 */
export function memberShortNames(rows: MemberShortNameInput[]): string[] {
  const base = rows.map(r => {
    if (r.nodeId) return r.role === "verify" ? `${r.nodeId}·验收` : r.nodeId;
    // 无图结构成员的 run-store 名常带「：第 N 代第 M 次执行/验收」装饰——
    // 泳道道名/归因徽标要的是会话基名（如 setup-ops-test-kit），剥掉装饰
    if (r.memberName) return r.memberName.replace(/：第\s*\d+\s*代.*$/, '');
    return r.taskId.length > 12 ? `${r.taskId.slice(0, 12)}…` : r.taskId;
  });
  const renameCollided = (names: string[], suffixOf: (i: number) => string | null): string[] => {
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    return names.map((n, i) => {
      if ((counts.get(n) ?? 0) <= 1) return n;
      const s = suffixOf(i);
      return s != null ? `${n}${s}` : n;
    });
  };
  let names = renameCollided(base, i => {
    const g = rows[i].generation;
    return g != null ? `·g${g}` : null;
  });
  names = renameCollided(names, i => {
    const a = rows[i].attempt;
    return a != null ? `·${a}` : null;
  });
  return renameCollided(names, i => `·${i + 1}`);
}

/** execute/verify/pending 全收，按 sid 去重——同一会话被多位引用时保留
 *  首个结构归因（与 resolveRunScope 的 rowId 去重同口径）。 */
export function runMemberRowsOf(vm: RunViewModel): RunMemberRow[] {
  const bySid = new Map<string, RunMemberRow>();
  const push = (ref: SessionMemberRef, nodeId: string, generation: number, attempt: number): void => {
    if (!ref.sessionId || !ref.session) return;
    if (bySid.has(ref.sessionId)) return;
    bySid.set(ref.sessionId, {
      taskId: ref.sessionId,
      framework: ref.session.framework,
      displayName: "",
      role: ref.role,
      nodeId,
      generation,
      attempt,
      model: ref.session.model ?? null,
      turns: ref.session.turns,
      totalTokens: ref.session.totalTokens,
      totalCost: ref.session.totalCost ?? null,
      durationMs: ref.session.durationMs,
      contextPeakPct: ref.session.contextPeakPct ?? null,
      sourcePath: ref.session.sourcePath ?? null,
    });
  };
  for (const node of vm.nodes) {
    for (const attempt of node.attempts) {
      push(attempt.executeMember, node.nodeId, node.generation, attempt.ordinal);
      if (attempt.verifyMember) push(attempt.verifyMember, node.nodeId, node.generation, attempt.ordinal);
    }
    for (const pending of node.pendingMembers) {
      push(pending, node.nodeId, node.generation, 0);
    }
  }
  const rows = [...bySid.values()];
  const names = memberShortNames(rows.map(r => ({
    taskId: r.taskId, nodeId: r.nodeId, generation: r.generation, attempt: r.attempt,
    role: r.role, memberName: null,
  })));
  rows.forEach((r, i) => { r.displayName = names[i] ?? r.taskId; });
  return rows;
}
