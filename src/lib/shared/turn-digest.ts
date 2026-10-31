// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/**
 * 轮次轻摘要（turn-digest）共享契约（server handler 与 client 消费方共用，
 * 纯类型 + 纯函数，无 server 依赖——客户端组件可直接 import）。
 *
 * 服务聚合型消费面（Audit 审计目标发现 / Score 评分卡跳转映射）：只要
 * turnIndex→turnId 映射与 skill 事件聚合，不要轮次正文/token/开销字段——
 * 走本摘要而非 member-turns 全量轮次（2504 轮会话实测 2.7MB/29 字段 vs
 * 摘要 ~160KB/3 字段，且免 overhead N+1 与 wire 解压）。
 */

export interface TurnDigestTurn {
  turnId: string;
  turnIndex: number;
  isSubagent: boolean;
}

export interface TurnDigestSkillEvent {
  skillName: string;
  eventType: string;
  count: number;
}

export interface TurnDigest {
  turns: TurnDigestTurn[];
  skillEvents: TurnDigestSkillEvent[];
}

/**
 * turnIndex → turnId：主 agent 轮优先（subagent 的成员内局部序不遮蔽主轮），
 * 无主轮的 index 回退任一轮。Audit §N 跳转与 Score 证据跳转共用。
 */
export function buildMainAgentTurnMap(turns: TurnDigestTurn[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const t of turns) {
    if (!t.isSubagent && !map.has(t.turnIndex)) map.set(t.turnIndex, t.turnId);
  }
  for (const t of turns) {
    if (!map.has(t.turnIndex)) map.set(t.turnIndex, t.turnId);
  }
  return map;
}

/** 聚合事件展开回事件对序列（保留重复 count 次，喂 deriveAuditableTargets 的原始形状）。 */
export function expandSkillEvents(events: TurnDigestSkillEvent[]): Array<{ skillName: string; eventType: string }> {
  const out: Array<{ skillName: string; eventType: string }> = [];
  for (const e of events) {
    for (let i = 0; i < e.count; i++) out.push({ skillName: e.skillName, eventType: e.eventType });
  }
  return out;
}
