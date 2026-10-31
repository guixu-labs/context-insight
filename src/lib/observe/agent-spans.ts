// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// agent 跨度/活跃区间（纯函数，会话与 run 双口径同源）：
// run 是基本单元——session 详情（单会话）与 run executions 收集器（跨成员）
// 用同一把尺子算每个 agent 的 turns 跨度与原始活跃区间，泳道图（V2）在两
// 种视图下口径不可能分裂。
//
// span：身份与 Turns 页签的 subagent 分组一致（subagentSessionId = transcript
//   文件名 stem），跨度 = 首条 turn 的 createdAt_ts → 末条 turn 的 completedAt。
//   **含休眠空档**，所以一根条子 = 这个 subagent 的一生。
// intervals：每个 turn 的原始 [start, end]，**不合并、不截断**——休眠阈值
//   （单条 turn 最多算多久活跃 + 相邻间隔多大算断开）由前端预设档位控制，
//   调档位在前端重聚类，无需重新请求。
// proxy（cpx 捕获）assistant 行的 completedAt 系统性缺失：createdAt_ts 就是
//   响应完成时刻，在途窗口是 [t - latencyMs, t]（latencyMs = wire
//   duration_ms）——不补起点的话每条 interval 都塌成零宽。native 行不适用：
//   它的 completedAt 缺失时 latencyMs 可能是「到下一轮的间隔」（含小时级
//   空闲段），展开会把空闲画成活跃。isProxy 按会话行传入（run 级成员可能
//   混布，逐成员判定）。

export interface AgentSpanTurn {
  isSubagent: boolean
  subagentSessionId: string | null
  createdAt_ts: Date | null
  completedAt: Date | null
  latencyMs: number
}

export interface AgentSpanEntry {
  span: { start: number; end: number } | null
  activeIntervals: Array<{ start: number; end: number }>
}

// 身份键必须让 root 与任何 subagent 互不重叠：subagentSessionId 在 schema 里
// 可空（isSubagent=true + null 行），`?? ''` 会与 root 的 key 撞车，把这类 turn
// 并进主 agent 的 span / activeIntervals（主条子跨度与活跃段被污染）。其余按
// subagentSessionId 分组的查询都是 `{ not: null }` 口径——这里用哨兵前缀保持
// 同一口径，同时不丢数据（不会被任何 execution 命中，也就不参与绘制）。
export function agentSpanKey(isSubagent: boolean, agentSessionId: string | null): string {
  return isSubagent ? `sub:${agentSessionId ?? ''}` : 'root'
}

export function buildAgentSpans(turns: AgentSpanTurn[], isProxy: boolean): Map<string, AgentSpanEntry> {
  const spanByKey = new Map<string, { start: number; end: number }>()
  const intervalsByKey = new Map<string, Array<{ start: number; end: number }>>()
  for (const t of turns) {
    const key = agentSpanKey(t.isSubagent, t.subagentSessionId)
    const rawStart = t.createdAt_ts ?? t.completedAt
    if (!rawStart) continue
    const start = rawStart.getTime()
    const end = Math.max(start, (t.completedAt ?? rawStart).getTime())
    const intervalStart = isProxy && !t.completedAt && t.latencyMs > 0
      ? start - t.latencyMs
      : start

    const sp = spanByKey.get(key)
    if (!sp) spanByKey.set(key, { start, end })
    else { sp.start = Math.min(sp.start, start); sp.end = Math.max(sp.end, end) }

    const arr = intervalsByKey.get(key) ?? []
    arr.push({ start: intervalStart, end })
    intervalsByKey.set(key, arr)
  }
  const out = new Map<string, AgentSpanEntry>()
  for (const key of new Set([...spanByKey.keys(), ...intervalsByKey.keys()])) {
    out.set(key, {
      span: spanByKey.get(key) ?? null,
      activeIntervals: intervalsByKey.get(key) ?? [],
    })
  }
  return out
}
