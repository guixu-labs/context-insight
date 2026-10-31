// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Overview 面板数据预取层（客户端）：三个面板端点（executions / turns /
// skills）全部并行发起，模块级 promise 缓存按 runId 复用。
// 动机——详情页两级瀑布是 Overview 初载顿挫的根因：面板取数原先挂在
// RunOverviewTab 挂载之后，而 tab 又要等页面级 run 详情往返才挂载（第一级）。
// 预取让页面挂载瞬间（详情 fetch 同刻）就把全部面板请求打出去，总耗时从
// 「详情 + 面板」收敛为「max(全部并行)」；重挂载（refreshEpoch）经 fresh
// 换新 promise 重取。时间维度的 bridges / lanes 归 Perf 页时间线自取。
import type { AgentItem } from "@/components/observe/AgentCallGraph"
import type { OverviewSkill, OverviewTurn } from "@/components/observe/OverviewPanels"

export interface RunOverviewPanelData {
  agents: AgentItem[]
  subagentCount: number
  turns: OverviewTurn[]
  skills: OverviewSkill[]
}

const cache = new Map<string, { p: Promise<RunOverviewPanelData>; ts: number }>()
const CACHE_LIMIT = 8
/** 命中窗口：窗口内复用（返回导航秒开），窗口外重取（离开再进入拿新数据，
 *  与旧行为的鲜活度对齐——run 数据除 solo 增量刷新外基本不可变，60s 足够） */
const CACHE_TTL_MS = 60_000

export function prefetchRunOverview(runId: string, opts?: { fresh?: boolean }): Promise<RunOverviewPanelData> {
  if (!opts?.fresh) {
    const hit = cache.get(runId)
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.p
  }
  const base = `/api/observe/run/${encodeURIComponent(runId)}`
  const p = (async (): Promise<RunOverviewPanelData> => {
    // 三端点并行（executions 供 Σ指标瓦片 / turns 全量消费 / skills 列表）；
    // 时间维度的 bridges / lanes 归 Perf 页时间线自取，Overview 不再预取
    const [execRes, turnsRes, skillsRes] = await Promise.all([
      fetch(`${base}/executions`),
      // Overview 全量消费（Perf 全景同款先例）：单页放行至硬上限，跨成员轮次混排；
      // 错误信息经服务端预算摘要（includeErrorDigest）——不请求工具结果原文
      fetch(`${base}/turns?page=1&pageSize=20000&includeErrorDigest=true`),
      fetch(`${base}/skills`),
    ])
    if (!execRes.ok) throw new Error(`executions ${execRes.status}`)
    const execData = (await execRes.json()) as { items?: AgentItem[]; subagentCount?: number }
    const turnsData = turnsRes.ok ? await turnsRes.json() : null
    const skillsData = skillsRes.ok ? await skillsRes.json() : null
    return {
      agents: Array.isArray(execData.items) ? execData.items : [],
      subagentCount: typeof execData.subagentCount === "number" ? execData.subagentCount : 0,
      turns: Array.isArray(turnsData?.items) ? turnsData.items : [],
      skills: Array.isArray(skillsData?.skills) ? skillsData.skills : [],
    }
  })()
  // 失败不缓存（下次进入重试）；同时为页面级 fire-and-forget 预取兜住未处理拒绝
  p.catch(() => { const e = cache.get(runId); if (e?.p === p) cache.delete(runId) })
  cache.set(runId, { p, ts: Date.now() })
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest != null && oldest !== runId) cache.delete(oldest)
  }
  return p
}

/** 测试隔离出口：IT 逐例重置模块级缓存（每例重 stub fetch 断言请求形状，
 *  缓存跨例存活会让后续例零请求——与生产行为无关，仅测试卫生） */
export function resetRunOverviewPrefetchCache(): void {
  cache.clear()
}
