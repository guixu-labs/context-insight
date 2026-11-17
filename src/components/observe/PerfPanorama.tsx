"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Perf 全景（run 视角）：画像（时间与 Token 构成——总量瓦片归 Overview，
// 不复读）→ 执行时间线（AgentSwimlaneV2，自 Overview 迁入——真实时间轴/
// 并发/空档是时间维度的唯一视图，量级对比由热点排行承接，不再摆执行序
// 列柱状图）→ 热点排行（PerfLaneList）→ 效率分布。取数恒为 run 合并端点
// （executions / turns / bridges / lanes 镜像形状），无会话隔离；定位出口
// 唯一收敛到 turnId（时间线条子/热点行/效率柱 → 泳道首轮），由装配层接
// Turns 深链管线。

import { useEffect, useMemo, useState } from "react"
import {
  PerfBenchmarkChart, perfEntrance, PERF_CARD_CLS, PERF_CARD_SM,
  fmtMs, fmtTok, TOKEN_COLORS,
  type TurnPerf, type BridgePerf, type ExecItem, type PerfLaneStat, type LaneExec,
} from "./perf-shared"
import { PerfLaneList } from "./PerfLaneList"
import { PerfToolTime } from "./PerfToolTime"
import { AgentSwimlaneV2, DEFAULT_SWIMLANE_THRESHOLD_MS, type SwimTurnTarget } from "./AgentSwimlaneV2"
import type { AgentItem, BridgeItem } from "./AgentCallGraph"
import type { RunToolStats } from "@/lib/observe/collectors/tool-stats"
import { ACTIVE_GAP_THRESHOLD_MS, ACTIVE_LATENCY_CAP_MS, clusterActiveSegments } from "@/lib/active-time"
import type { RunTimeSummary } from "@/lib/observe/run-time-summary"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface Props {
  /** run 合并端点（executions / turns / bridges / lanes，返回形状镜像） */
  endpoints: { executions: string; turns: string; bridges: string; lanes?: string; toolStats?: string }
  /** 定位出口：统一收敛到 turnId（Turns 深链管线入态） */
  onOpenTurn?: (turnId: string) => void
  /** 搜索出口：Turns 搜索语法深链（工具耗时卡的行/格下钻——命中索引即调用清单） */
  onOpenSearch?: (q: string) => void
  /** 时间线载荷直供（离线导出查看器）：提供时时间线卡与跳转解析免请求渲染 */
  swimlanePayload?: {
    agents: AgentItem[]
    bridges: BridgeItem[]
    lanes?: string[]
    /** 跳转解析用轮次（载荷直供时优先于端点取数） */
    turns?: TurnPerf[]
  } | null
  /** Run 级统一时间摘要：Overview 与 Perf 数值单一源 */
  timeSummary?: RunTimeSummary | null
}

interface PerfModel {
  sub: ExecItem[]
  totalTokens: number
  totalInput: number
  totalOutput: number
  totalReasoning: number
  totalCacheRead: number
  totalCacheWrite: number
  totalWall: number
  totalActive: number
  totalInactive: number
  totalNonLlm: number
  t0: number
}

// ── 墙钟 = 全部执行 span 的包络：最早开始 → 最晚结束。不能按最后创建的
//    执行 latency 收尾：最后创建的子代理可能先结束，也可能有后台子代理在主
//    Agent 结束后才结束。切片仅用于 LLM 口径的逐任务钳制，不决定总墙钟。
function computeWall(subtasks: ExecItem[]): { slices: number[]; start: number; end: number } {
  const ranges = subtasks.map(r => {
    const start = r.span?.start ?? new Date(r.createdAt).getTime()
    const end = r.span?.end ?? start + Math.max(0, r.latencyMs)
    return { start, end: Math.max(start, end) }
  })
  const start = Math.min(...ranges.map(r => r.start))
  const end = Math.max(...ranges.map(r => r.end))
  const slices: number[] = []
  for (let i = 0; i < ranges.length; i++) {
    const sliceEnd = i < ranges.length - 1 ? Math.min(ranges[i + 1].start, end) : end
    slices.push(Math.max(0, sliceEnd - ranges[i].start))
  }
  return { slices, start, end }
}

function normalizedActiveIntervals(exec: ExecItem): Array<{ start: number; end: number }> {
  return (exec.activeIntervals ?? []).map(iv => iv.inferred
    ? { start: Math.max(iv.start, iv.end - ACTIVE_LATENCY_CAP_MS), end: iv.end }
    : { start: iv.start, end: iv.end })
}

function activeMsWithin(
  intervals: Array<{ start: number; end: number }>,
  start: number,
  end: number,
): number {
  const clipped: Array<[number, number]> = intervals
    .map(iv => [Math.max(start, iv.start), Math.min(end, iv.end)] as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
  return clusterActiveSegments(clipped, ACTIVE_GAP_THRESHOLD_MS)
    .reduce((sum, seg) => sum + Math.max(0, seg.end - seg.start), 0)
}

const DUR_ACTIVE = "#6366f1"
const DUR_INACTIVE = "#f59e0b"

export function PerfPanorama({ endpoints, onOpenTurn, onOpenSearch, swimlanePayload, timeSummary = null }: Props) {
  const [items, setItems] = useState<ExecItem[] | null>(null)
  const [thresholdMs, setThresholdMs] = useState(DEFAULT_SWIMLANE_THRESHOLD_MS)
  const [turns, setTurns] = useState<TurnPerf[] | null>(null)
  const [bridges, setBridges] = useState<BridgePerf[]>([])
  const [laneTable, setLaneTable] = useState<string[]>([])
  const [laneTableInferred, setLaneTableInferred] = useState(false)
  const [toolStats, setToolStats] = useState<RunToolStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const fetchJson = (url: string) => fetch(url).then(r => r.json())
    const lanesP = endpoints.lanes
      ? fetchJson(endpoints.lanes).catch(() => null)
      : Promise.resolve(null)
    const toolStatsP = endpoints.toolStats
      ? fetchJson(endpoints.toolStats).catch(() => null)
      : Promise.resolve(null)
    Promise.all([
      fetchJson(endpoints.executions),
      fetchJson(endpoints.turns),
      fetchJson(endpoints.bridges),
      lanesP,
      toolStatsP,
    ])
      .then(([execData, turnsData, bridgesData, lanesData, toolStatsData]) => {
        if (cancelled) return
        setItems(execData.items ?? [])
        setTurns(turnsData.items ?? [])
        setBridges(bridgesData.items ?? [])
        setLaneTable(Array.isArray(lanesData?.lanes) ? lanesData.lanes : [])
        setLaneTableInferred(lanesData?.source === "inferred")
        setToolStats(toolStatsData?.tools?.length > 0 ? toolStatsData : null)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setItems(null)
        setTurns(null)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [endpoints])

  // 时间线数据：载荷直供（离线导出）优先，线上回落同源端点取数
  const swimAgents: AgentItem[] = swimlanePayload?.agents ?? items ?? []
  const swimBridges: BridgeItem[] = swimlanePayload?.bridges ?? bridges
  const swimLanes: string[] = swimlanePayload?.lanes ?? laneTable

  // 热点排行模型（run 观测基础单元）：子代理轮按 subagentSessionId 归组
  //（owner = 父成员）；成员 root 轮按成员归组（成员会话即一级单元）。
  // firstTurnId = 该单元首个轮次（Turns 深链入态）。
  const lanes = useMemo<PerfLaneStat[]>(() => {
    if (!turns || turns.length === 0) return []
    const bridgeBySession = new Map(bridges.map(b => [b.subagentSessionId ?? "", b]))
    const m = new Map<string, PerfLaneStat>()
    for (const t of turns) {
      const lane = t.isSubagent
        ? {
          laneId: t.subagentSessionId ?? "unknown",
          kind: "subagent" as const,
          // 主标题=派发步骤（API 已按 proxy/原生优先级解析），subagentName 仅兜底
          name: t.dispatchStep ?? t.subagentName ?? "unknown",
          owner: t.member?.label ?? t.member?.taskId ?? null,
          subagentType: t.subagentType ?? null,
        }
        : t.member
          ? { laneId: t.member.taskId, kind: "agent" as const, name: t.member.label ?? t.member.taskId, owner: null, subagentType: null }
          : null
      if (lane == null) continue
      const ex = m.get(lane.laneId) ?? {
        laneId: lane.laneId, kind: lane.kind, name: lane.name, owner: lane.owner,
        subagentType: lane.subagentType, taskDescription: null, turns: [], totalMs: 0, totalTokens: 0, totalGenTokens: 0,
        tps: 0, cacheRead: 0, inputTokens: 0, cacheHitRate: 0, firstTurnId: t.turnId,
      }
      ex.turns.push(t)
      ex.totalMs += t.latencyMs
      ex.totalTokens += t.totalTokens
      ex.totalGenTokens += (t.outputTokens ?? 0) + (t.reasoningTokens ?? 0)
      ex.cacheRead += t.cacheReadTokens
      ex.inputTokens += t.inputTokens
      m.set(lane.laneId, ex)
    }
    for (const s of m.values()) {
      const bridge = bridgeBySession.get(s.laneId)
      const dc = bridge?.dispatchContent
      if (dc) {
        const cleaned = dc.replace(/[\n\r]+/g, " ").trim()
        s.taskDescription = cleaned.length > 50 ? cleaned.slice(0, 49) + "…" : cleaned
      }
      s.cacheHitRate = s.cacheRead + s.inputTokens > 0 ? (s.cacheRead / (s.cacheRead + s.inputTokens)) * 100 : 0
      s.tps = s.totalMs > 0 ? s.totalGenTokens / (s.totalMs / 1000) : 0
    }
    return [...m.values()]
  }, [turns, bridges])

  // 工具耗时卡的成员轴（taskId → 显示名）：turns 的 member 投影——与泳道
  // 命名同源（member.label ?? taskId 由卡片兜底），去重保首见
  const memberAxis = useMemo(() => {
    const m = new Map<string, { taskId: string; label: string | null }>()
    for (const t of turns ?? []) {
      if (t.member && !m.has(t.member.taskId)) {
        m.set(t.member.taskId, { taskId: t.member.taskId, label: t.member.label ?? null })
      }
    }
    return [...m.values()]
  }, [turns])

  // 效率序列：主 agent 轮（root）TPS / TPOT，x 轴按轮次时刻呈现（真实
  // 时间轴——turnIndex 是会话内局部序号，多成员混排不可作轴），排除压
  // 缩/续写与派发轮；仅 assistant 轮（result 轮 tokens 恒 0，混入只会产
  // tps=0/tpot=0 零值噪声点）
  const perfSeries = useMemo(() => {
    if (!turns || turns.length === 0) return []
    const rootTurns = turns.filter(t => !t.isSubagent)
    const dispatchTurnIds = new Set(bridges.map(b => b.dispatchTurnId).filter(Boolean) as string[])
    return rootTurns
      .filter(t => t.role === "assistant" && t.latencyMs > 0 && t.agentName !== "compaction" && t.agentName !== "continuation" && !dispatchTurnIds.has(t.turnId))
      .map(t => {
        const gen = (t.outputTokens ?? 0) + (t.reasoningTokens ?? 0)
        const tpot = gen > 0 ? t.latencyMs / gen : 0
        const tps = t.latencyMs > 0 ? gen / (t.latencyMs / 1000) : 0
        return { turnIndex: t.turnIndex, turnId: t.turnId, createdAt: t.createdAt, tpot, tps }
      })
  }, [turns, bridges])

  const model = useMemo<PerfModel | null>(() => {
    if (!items || items.length === 0) return null
    const sub = items
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    if (sub.length === 0) return null
    const { slices, start: fallbackStart, end: wallEnd } = computeWall(sub)
    const summaryStart = timeSummary?.start ? new Date(timeSummary.start).getTime() : NaN
    const t0 = Number.isFinite(summaryStart) ? summaryStart : fallbackStart
    const totalWall = timeSummary?.wallMs ?? Math.max(0, wallEnd - t0)
    const totalTokens = sub.reduce((s, r) => s + r.tokens, 0)
    const totalInput = sub.reduce((s, r) => s + r.inputTokens, 0)
    const totalOutput = sub.reduce((s, r) => s + r.outputTokens, 0)
    const totalReasoning = sub.reduce((s, r) => s + r.reasoningTokens, 0)
    const totalCacheRead = sub.reduce((s, r) => s + r.cacheReadInputTokens, 0)
    const totalCacheWrite = sub.reduce((s, r) => s + r.cacheCreationInputTokens, 0)
    // 逐任务钳制：LLM 耗时 = Σ min(latency, slice)；LLM 外 = 总 - LLM。处处闭合。
    const totalLlmCapped = sub.reduce((s, r, i) => s + Math.min(r.latencyMs, slices[i]), 0)
    const fallbackActive = activeMsWithin(
      sub.flatMap(r => normalizedActiveIntervals(r)),
      t0,
      wallEnd,
    )
    const totalActive = timeSummary?.activeMs ?? fallbackActive
    const totalInactive = timeSummary?.idleMs ?? Math.max(0, totalWall - totalActive)
    const totalNonLlm = timeSummary
      ? Math.max(0, totalWall - timeSummary.llmActiveMs)
      : Math.max(0, totalWall - totalLlmCapped)

    return {
      sub,
      totalTokens, totalInput, totalOutput, totalReasoning, totalCacheRead, totalCacheWrite,
      totalWall, totalActive, totalInactive, totalNonLlm,
      t0,
    }
  }, [items, timeSummary])

  // 执行切片按单元归组：墙钟/活跃取该执行自身 span，不与其他执行共享切片。
  const laneExecs = useMemo(() => {
    const map = new Map<string, LaneExec[]>()
    if (!model) return map
    model.sub.forEach((exec, i) => {
      const key = exec.isSubagent ? exec.agentSessionId : exec.member?.taskId ?? null
      if (!key) return
      const start = exec.span?.start ?? new Date(exec.createdAt).getTime()
      const end = exec.span?.end ?? start + Math.max(0, exec.latencyMs)
      const wallMs = Math.max(0, end - start)
      const activeMs = activeMsWithin(normalizedActiveIntervals(exec), start, end)
      const arr = map.get(key) ?? []
      arr.push({ ord: i + 1, wallMs, activeMs, inactiveMs: Math.max(0, wallMs - activeMs), exec })
      map.set(key, arr)
    })
    return map
  }, [model])

  // 时间线跳转：子代理条 → 该会话首轮（多次派发时按派发时刻后定位）；
  // 主泳道承接 subagent 结束的活跃段 → 父 Agent 接收回复的 turn；无则回退子代理末轮；
  // root 条 → 该成员首轮。
  // 唯一出口 onOpenTurn(turnId)；解析用轮次载荷直供优先（离线导出），线上回落端点取数
  const jumpTurns = swimlanePayload?.turns ?? turns
  const openSwimTurn = (agentSessionId: string | null, sinceMs?: number, memberTaskId?: string | null, target?: SwimTurnTarget) => {
    if (!onOpenTurn || !jumpTurns) return
    if (agentSessionId) {
      const subs = jumpTurns
        .filter(t => t.isSubagent && t.subagentSessionId === agentSessionId)
        .sort((a, b) => {
          const at = a.createdAt ? new Date(a.createdAt).getTime() : Number.POSITIVE_INFINITY
          const bt = b.createdAt ? new Date(b.createdAt).getTime() : Number.POSITIVE_INFINITY
          return (at - bt) || (a.turnIndex - b.turnIndex)
        })
      if (target?.position === "last") {
        if (target.parentTurnId) {
          onOpenTurn(target.parentTurnId)
          return
        }
        const bounded = target.atMs == null
          ? subs
          : subs.filter(t => t.createdAt && new Date(t.createdAt).getTime() <= target.atMs!)
        const last = bounded.at(-1) ?? subs.at(-1)
        if (last) onOpenTurn(last.turnId)
        return
      }
      const first = sinceMs
        ? subs.find(t => t.createdAt && new Date(t.createdAt).getTime() >= sinceMs) ?? subs[0]
        : subs[0]
      if (first) onOpenTurn(first.turnId)
      return
    }
    const roots = memberTaskId
      ? jumpTurns.filter(t => !t.isSubagent && t.member?.taskId === memberTaskId)
      : jumpTurns.filter(t => !t.isSubagent)
    if (roots[0]) onOpenTurn(roots[0].turnId)
  }

  if (loading) return <PerfSkeleton />

  if (!model && lanes.length === 0 && swimAgents.length === 0) {
    return (
      <Card {...perfEntrance(0, PERF_CARD_SM)} size="sm">
        <CardContent className="px-5 py-6 text-xs text-muted-foreground">暂无执行数据</CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {model && <ProfileCard model={model} />}
      {swimAgents.length > 0 && (
        <div {...perfEntrance(75)}>
          <AgentSwimlaneV2
            agents={swimAgents}
            bridges={swimBridges}
            lanes={swimLanes}
            lanesInferred={laneTableInferred}
            thresholdMs={thresholdMs}
            onThresholdChange={setThresholdMs}
            onViewTurns={openSwimTurn}
          />
        </div>
      )}
      {lanes.length > 0 && (
        <PerfLaneList
          lanes={lanes}
          laneExecs={laneExecs}
          t0={model?.t0 ?? 0}
          onOpenTurn={onOpenTurn}
        />
      )}
      {toolStats && (
        <PerfToolTime
          stats={toolStats}
          members={memberAxis}
          totalNonLlmMs={model?.totalNonLlm ?? null}
          onOpenTurn={onOpenTurn}
          onOpenSearch={onOpenSearch}
        />
      )}
      {perfSeries.length > 1 && (
        <Card {...perfEntrance(225, PERF_CARD_SM)} data-testid="perf-benchmark-card" size="sm">
          <CardHeader>
            <CardTitle>效率分布</CardTitle>
            <span className="self-center text-[11px] text-muted-foreground">主 agent 轮 TPS / TPOT · 真实时间轴 · 悬停看数值</span>
          </CardHeader>
          <CardContent>
            <PerfBenchmarkChart points={perfSeries} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ── 运行画像（两区头卡，发丝分隔）：墙钟 hero（活跃/非活跃时间构成）→
//    Token 构成。总量类指标（Tokens/Cost/LLM 调用/工具调用）不在此重复——
//    Overview Σ瓦片单一源，Perf 只摆分解与比率 ─────────────────────────────
function ProfileCard({ model }: { model: PerfModel }) {
  const activePct = model.totalWall > 0 ? (model.totalActive / model.totalWall * 100) : 0
  const tokTotal = model.totalInput + model.totalCacheRead + model.totalCacheWrite + model.totalOutput + model.totalReasoning || 1
  const tokSegs = [
    { label: "输入", v: model.totalInput, c: TOKEN_COLORS.input },
    { label: "缓存读", v: model.totalCacheRead, c: TOKEN_COLORS.cacheRead },
    { label: "缓存写", v: model.totalCacheWrite, c: TOKEN_COLORS.cacheWrite },
    { label: "输出", v: model.totalOutput, c: TOKEN_COLORS.output },
    { label: "推理", v: model.totalReasoning, c: TOKEN_COLORS.reasoning },
  ]
  return (
    <Card {...perfEntrance(0, PERF_CARD_CLS)} data-testid="perf-profile-card">
      <CardContent className="px-5 pt-4 pb-4">
        <div className="divide-y divide-foreground/[0.06]">
          {/* 区一：墙钟 hero + 活跃/非活跃构成条 */}
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3 pb-3.5">
            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-semibold">运行画像</span>
                <span className="text-[11px] text-muted-foreground">{model.sub.length} 条执行 · 全成员融合</span>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">总耗时（墙钟）</div>
              <div className="text-[26px] font-semibold leading-tight tabular-nums">{fmtMs(model.totalWall)}</div>
            </div>
            <div className="min-w-[240px] flex-1">
              <div className="flex h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full transition-[width] duration-500 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]"
                  style={{ width: `${activePct}%`, background: DUR_ACTIVE }}
                />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] tabular-nums">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm" style={{ background: DUR_ACTIVE }} />
                  活跃 {fmtMs(model.totalActive)} · {activePct.toFixed(0)}%
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm" style={{ background: DUR_INACTIVE }} />
                  非活跃 {fmtMs(model.totalInactive)} · {(100 - activePct).toFixed(0)}%
                </span>
              </div>
            </div>
          </div>
          {/* 区二：Token 构成（五段胶囊条 + 图例） */}
          <div className="py-3.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">Token 构成</span>
              <span className="text-[11px] tabular-nums text-muted-foreground/70">{fmtTok(model.totalTokens)} tokens</span>
            </div>
            <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-muted">
              {tokSegs.map(s => s.v > 0 && (
                <div
                  key={s.label}
                  className="h-full transition-[width] duration-500 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]"
                  style={{ width: `${(s.v / tokTotal) * 100}%`, background: s.c }}
                  title={`${s.label}: ${fmtTok(s.v)} (${(s.v / tokTotal * 100).toFixed(1)}%)`}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
              {tokSegs.map(s => (
                <span key={s.label} className="flex items-center gap-1.5 text-[11px] tabular-nums">
                  <span className="size-2 rounded-sm" style={{ background: s.c }} />
                  <span className="text-muted-foreground">{s.label}</span>
                  <span className="font-semibold">{fmtTok(s.v)}</span>
                  <span className="text-muted-foreground">({(s.v / tokTotal * 100).toFixed(1)}%)</span>
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-3 text-[10px] text-muted-foreground/70">
          总耗时 = 全执行 span 包络 · 活跃 = 工作窗口并集（固定 5min 聚类） · 显示阈值只影响泳道分段 · 非活跃 = 墙钟 − 活跃
        </div>
      </CardContent>
    </Card>
  )
}

// ── 加载骨架：画像 / 时间线 / 排行三卡形态，不谎报结构；入场与内容卡同一
// 阶梯节奏（display 翻转重放），加载即有形态而非空白 ─────────────────────────
function PerfSkeleton() {
  return (
    <div className="space-y-4">
      <section {...perfEntrance(0, "rounded-2xl bg-card p-5 ring-1 ring-foreground/[0.06]")}>
        <div className="h-3.5 w-16 animate-pulse rounded bg-foreground/[0.07]" />
        <div className="mt-3 h-8 w-28 animate-pulse rounded bg-foreground/[0.09]" />
        <div className="mt-4 h-2 flex-1 animate-pulse rounded-full bg-foreground/[0.06]" />
        <div className="mt-5 h-2.5 w-full animate-pulse rounded-full bg-foreground/[0.05]" />
        <div className="mt-2.5 flex gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="h-2.5 w-16 animate-pulse rounded bg-foreground/[0.06]" style={{ animationDelay: `${60 + i * 30}ms` }} />
          ))}
        </div>
      </section>
      <section {...perfEntrance(70, "rounded-2xl bg-card p-5 ring-1 ring-foreground/[0.06]")}>
        <div className="h-3.5 w-20 animate-pulse rounded bg-foreground/[0.07]" />
        <div className="mt-4 h-36 w-full animate-pulse rounded-xl bg-foreground/[0.04]" />
      </section>
      <section {...perfEntrance(140, "rounded-2xl bg-card p-5 ring-1 ring-foreground/[0.06]")}>
        <div className="h-3.5 w-14 animate-pulse rounded bg-foreground/[0.07]" />
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="mt-3.5 flex items-center gap-3">
            <div className="size-3 animate-pulse rounded-full bg-foreground/[0.06]" />
            <div className="h-3 flex-1 animate-pulse rounded bg-foreground/[0.05]" style={{ animationDelay: `${i * 40}ms` }} />
            <div className="h-3 w-24 animate-pulse rounded bg-foreground/[0.06]" />
          </div>
        ))}
      </section>
    </div>
  )
}
