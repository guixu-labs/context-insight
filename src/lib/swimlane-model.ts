// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 泳道模型（纯函数、零 React 依赖）：执行切片 + 桥 + 车道表 → 可直接摆上屏幕的
// 泳道布局，外加「时刻 → 轮次」解析。Turns 顶部时间线的全部推导都在这里——
// 组件只负责定位、交互态与播放头，口径不可能在渲染层漂移。
//
// 结构：
// ① 身份与配色：类型 = 图例键/配色键（resolveSubagentIdentity 唯一入口），
//    黄金角度色相保证任意类型数不回绕撞色，顺序取首现序，数据不变则配色稳定；
// ② 条：root 执行按成员分道（多成员时成员 = 道，单成员合并 root 单道）；
//    子代理会话被多次派发时按派发拆条，返工的时间位置独立可见；
// ③ 槽位：车道池（声明车道按序占 ⌈内部并发⌉ 槽）+ 未分类贪心（swimlane-slots）；
// ④ 活跃段：每条按「休眠阈值」重聚类逐轮区间，深色为活跃、浅色为休眠；
// ⑤ 跳转目标：每条 / 每条 root 道各带一份「可见轮」时间窗（升序），点击的
//    时刻经 pickTurnAt 二分落到最近一轮——列表里没有行的命令附注轮不进窗口。

import { ACTIVE_LATENCY_CAP_MS, clusterActiveSegments } from '@/lib/active-time'
import { resolveSubagentIdentity } from '@/lib/subagent-identity'
import { resolveLaneKey } from '@/lib/swimlane-lanes'
import { assignLaneSlots, computeMaxConcurrency } from '@/lib/swimlane-slots'

/** 执行切片（/executions 端点条目的结构子集——lib 不依赖组件类型） */
export interface SwimAgent {
  executionId: string
  agentName: string | null
  agentSessionId: string | null
  isSubagent: boolean
  parentExecutionId: string | null
  rootExecutionId?: string | null
  tokens: number
  maxSingleCallTokens: number
  toolCallCount: number
  model: string | null
  createdAt: string
  latencyMs: number
  /** turns 跨度（首条 turn 的 createdAt_ts → 末条 completedAt） */
  span?: { start: number; end: number } | null
  /** 逐轮原始区间（升序，带 turnId） */
  activeIntervals?: SwimInterval[]
  firstPrompt: string | null
  member?: { taskId: string; label: string | null; isProxy?: boolean } | null
}

export interface SwimInterval {
  start: number
  end: number
  inferred?: boolean
  turnId?: string
  /** 列表里没有行的轮（命令 caveat / stdout 附注轮）——不作跳转目标 */
  hidden?: boolean
}

/** 桥（/bridges 端点条目的结构子集） */
export interface SwimBridge {
  bridgeId: string
  dispatchContent: string | null
  dispatchTimestamp: string | null
  responseTimestamp: string | null
  subagentSessionId: string | null
  subagentType: string | null
  status: string
}

/** 一轮的时间窗：播放头取 start，点击落点按 [start, end] 判归属 */
export interface SwimTurnWindow {
  turnId: string
  start: number
  end: number
}

export const ROOT_KEY = 'root'
export const ROOT_COLOR = '#3b82f6'
/** 条的最小宽度（% 整段时长）：瞬时子代理也要留出可点的像素 */
export const MIN_BAR_PCT = 0.15

/** 条高 12 + 条距 3；单条道最小 20 高（条垂直居中） */
export const SWIM_BAR_H = 12
export const SWIM_BAR_GAP = 3
const LANE_MIN_H = 20

export function swimLaneHeight(rows: number): number {
  return Math.max(LANE_MIN_H, rows * SWIM_BAR_H + (rows + 1) * SWIM_BAR_GAP)
}

/** 条在道内的纵向位置：多行等距，单行居中 */
export function swimBarTop(rows: number, row: number): number {
  return rows > 1 ? SWIM_BAR_GAP + row * (SWIM_BAR_H + SWIM_BAR_GAP) : (swimLaneHeight(rows) - SWIM_BAR_H) / 2
}

/** 活跃切片：相对条盒的百分比位置（0–100） */
export interface SwimPiece {
  leftPct: number
  widthPct: number
}

/** 悬停浮窗的数据（文案拼装在组件层，这里只给事实） */
export interface SwimTip {
  label: string
  step: string | null
  /** 拆分条恒 1；整段条 = 该会话派发总数 */
  dispatchCount: number
  firstPrompt: string | null
  tokens: number
  maxSingleCallTokens: number
  toolCallCount: number
  model: string | null
  startMs: number
  endMs: number
  failed: boolean
}

export interface SwimBar {
  /** executionId；拆分条 = `executionId#序号` */
  key: string
  row: number
  color: string
  failed: boolean
  /** 相对整段时长（0–100）：条盒与活跃切片的换算基准 */
  startPct: number
  widthPct: number
  pieces: SwimPiece[]
  /** 该条覆盖的可见轮——点击落点的解析窗口 */
  windows: SwimTurnWindow[]
  tip: SwimTip
}

export interface SwimLane {
  /** root 道 = 成员 taskId（单成员时恒 'root'）；槽道 = `slot-序号` */
  key: string
  label: string
  kind: 'root' | 'slot'
  color: string
  rows: number
  bars: SwimBar[]
  /** 跳转窗口：root 道整道横向可点；槽道只在条上可点（逐条 windows） */
  windows: SwimTurnWindow[]
}

export interface SwimLegendItem {
  key: string
  color: string
  /** 派发次数（按拆分后条数计） */
  count: number
}

export interface SwimlaneModel {
  lanes: SwimLane[]
  startMs: number
  endMs: number
  totalMs: number
  /** 子代理类型图例（root 不在内），首现序 */
  legend: SwimLegendItem[]
  agentCount: number
  subagentCount: number
  maxConcurrency: number
  /** turnId → 时间窗：播放头定位 */
  windowOfTurn: ReadonlyMap<string, SwimTurnWindow>
}

export interface SwimlaneInput {
  agents: SwimAgent[]
  bridges: SwimBridge[]
  /** 声明车道表（可为空） */
  lanes: string[]
  /** 休眠阈值：相邻轮间隔超过它即断开成新的活跃段 */
  thresholdMs: number
  /** 图例里被勾掉的类型 */
  hiddenTypes?: ReadonlySet<string>
}

interface Span {
  agent: SwimAgent
  start: number
  end: number
  key: string
  /** 拆分条所属的那一次派发 */
  bridge?: SwimBridge
  laneKey?: string | null
}

/** 同一子代理会话可能被多次派发（首发 + 返工重入）——收集全部并按派发时间升序 */
function bridgesBySession(bridges: SwimBridge[]): Map<string, SwimBridge[]> {
  const map = new Map<string, SwimBridge[]>()
  for (const b of bridges) {
    if (!b.subagentSessionId) continue
    const list = map.get(b.subagentSessionId)
    if (list) list.push(b)
    else map.set(b.subagentSessionId, [b])
  }
  for (const list of map.values()) list.sort((x, y) => tOf(x.dispatchTimestamp) - tOf(y.dispatchTimestamp))
  return map
}

function tOf(v: string | null | undefined): number {
  const t = v ? new Date(v).getTime() : NaN
  return Number.isFinite(t) ? t : NaN
}

/** 区间基：后端 turns 跨度，缺省退化 createdAt + latency。
 *  不能用 wall（start→next start）口径——首尾相接永不重叠，并发恒为 1 */
function spanOf(a: SwimAgent): { start: number; end: number } {
  if (a.span) return a.span
  const start = new Date(a.createdAt).getTime()
  return { start, end: start + Math.max(0, a.latencyMs) }
}

/** 可见轮窗口：升序 + 去重 + 排除无行轮；与 [lo, hi] 有交叠才计入 */
function windowsOf(agents: readonly SwimAgent[], lo = -Infinity, hi = Infinity): SwimTurnWindow[] {
  const seen = new Set<string>()
  const out: SwimTurnWindow[] = []
  for (const a of agents) {
    for (const iv of a.activeIntervals ?? []) {
      if (!iv.turnId || iv.hidden || seen.has(iv.turnId)) continue
      if (iv.end < lo || iv.start > hi) continue
      seen.add(iv.turnId)
      out.push({ turnId: iv.turnId, start: iv.start, end: Math.max(iv.start, iv.end) })
    }
  }
  out.sort((x, y) => x.start - y.start || x.end - y.end)
  return out
}

/**
 * 时刻 → 轮次（窗口须按 start 升序）。点在某轮区间内即该轮；落在空档取边界
 * 最近的一轮（等距取前一轮）。
 */
export function pickTurnAt(windows: readonly SwimTurnWindow[], t: number): SwimTurnWindow | null {
  if (windows.length === 0) return null
  let lo = 0
  let hi = windows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (windows[mid].start <= t) lo = mid + 1
    else hi = mid
  }
  const prev = windows[lo - 1]
  const next = windows[lo]
  if (prev && prev.end >= t) return prev
  if (!prev) return next ?? null
  if (!next) return prev
  return next.start - t < t - prev.end ? next : prev
}

export function buildSwimlaneModel(input: SwimlaneInput): SwimlaneModel {
  const { agents, bridges, lanes, thresholdMs, hiddenTypes } = input
  const bridgeMap = bridgesBySession(bridges)

  // ① 身份与配色
  const identityCache = new Map<string, { subagentType: string | null; step: string | null; bridges: SwimBridge[] }>()
  const identityOf = (a: SwimAgent) => {
    const hit = identityCache.get(a.executionId)
    if (hit) return hit
    const bs = a.agentSessionId ? bridgeMap.get(a.agentSessionId) ?? [] : []
    const entry = {
      ...(a.isSubagent && a.agentSessionId
        ? resolveSubagentIdentity({
            subagentName: a.agentName,
            bridge: bs[0] ?? null,
            isProxy: a.member?.isProxy ?? false,
          })
        : { subagentType: null, step: null }),
      bridges: bs,
    }
    identityCache.set(a.executionId, entry)
    return entry
  }
  const typeOf = (a: SwimAgent): string =>
    a.isSubagent ? (identityOf(a).subagentType ?? a.agentName ?? 'unknown') : ROOT_KEY

  const sorted = [...agents].sort((a, b) => tOf(a.createdAt) - tOf(b.createdAt))
  const legendKeys: string[] = []
  for (const a of sorted) {
    const k = typeOf(a)
    if (k !== ROOT_KEY && !legendKeys.includes(k)) legendKeys.push(k)
  }
  const colorOf = new Map<string, string>([[ROOT_KEY, ROOT_COLOR]])
  legendKeys.forEach((k, i) => colorOf.set(k, `hsl(${Math.round((i * 137.508) % 360)} 65% 55%)`))

  const visible = sorted.filter(a => !hiddenTypes?.has(typeOf(a)))
  const rootAgents = visible.filter(a => !a.isSubagent)
  const subAgents = visible.filter(a => a.isSubagent)

  const startMs = visible.length === 0 ? 0 : Math.min(...visible.map(a => spanOf(a).start))
  const rawEnd = visible.length === 0 ? 1 : Math.max(...visible.map(a => spanOf(a).end))
  const endMs = Number.isFinite(rawEnd) ? rawEnd : 1
  const totalMs = Math.max(1, endMs - startMs)
  const pctOf = (ms: number) => ((ms - startMs) / totalMs) * 100

  // ④ 活跃段：单轮最长计入 min(阈值, 10min)，inferred 同口径收口
  const segmentsOf = (a: SwimAgent): Array<{ start: number; end: number }> => {
    const ivs: Array<[number, number]> = (a.activeIntervals ?? []).map(s => {
      const cap = s.inferred ? Math.min(thresholdMs, ACTIVE_LATENCY_CAP_MS) : thresholdMs
      return [s.start, Math.min(s.end, s.start + cap)]
    })
    return clusterActiveSegments(ivs, thresholdMs)
  }
  const piecesOf = (segments: Array<{ start: number; end: number }>, barStart: number, barEnd: number): SwimPiece[] => {
    const barMs = Math.max(1, barEnd - barStart)
    const out: SwimPiece[] = []
    for (const seg of segments) {
      const s = Math.max(seg.start, barStart)
      const e = Math.min(seg.end, barEnd)
      if (e <= s) continue
      out.push({ leftPct: ((s - barStart) / barMs) * 100, widthPct: ((e - s) / barMs) * 100 })
    }
    return out
  }

  const makeBar = (sp: Span, color: string, row: number, windows: SwimTurnWindow[]): SwimBar => {
    const id = sp.agent.isSubagent && sp.agent.agentSessionId ? identityOf(sp.agent) : null
    const steps = (sp.bridge ? [sp.bridge] : id?.bridges ?? [])
      .map(b => b.dispatchContent?.replace(/[\n\r]+/g, ' ').trim())
      .filter((v): v is string => Boolean(v))
    const failed = Boolean(sp.agent.isSubagent && sp.bridge && ['error', 'failed'].includes(sp.bridge.status))
    return {
      key: sp.key,
      row,
      color,
      failed,
      startPct: pctOf(sp.start),
      widthPct: Math.max(MIN_BAR_PCT, pctOf(sp.end) - pctOf(sp.start)),
      pieces: piecesOf(segmentsOf(sp.agent), sp.start, sp.end),
      windows,
      tip: {
        label: id ? (id.subagentType ?? sp.agent.agentName ?? 'subagent') : 'root',
        step: steps.length > 0 ? steps.join(' · ') : (id?.step ?? null),
        dispatchCount: sp.bridge ? 1 : (id?.bridges.length ?? 0),
        firstPrompt: sp.agent.firstPrompt,
        tokens: sp.agent.tokens,
        maxSingleCallTokens: sp.agent.maxSingleCallTokens,
        toolCallCount: sp.agent.toolCallCount,
        model: sp.agent.model,
        startMs: sp.start,
        endMs: sp.end,
        failed,
      },
    }
  }

  // ② root 道：多成员时成员 = 道，按最早跨度排序；单成员/无归因合并 root 单道
  const rootGroups = new Map<string, { label: string; spans: Span[] }>()
  for (const a of rootAgents) {
    const sp = spanOf(a)
    const mk = a.member?.taskId ?? ROOT_KEY
    const g = rootGroups.get(mk) ?? { label: mk === ROOT_KEY ? ROOT_KEY : (a.member?.label ?? mk), spans: [] }
    g.spans.push({ agent: a, start: sp.start, end: Math.max(sp.start + 1, sp.end), key: a.executionId })
    rootGroups.set(mk, g)
  }
  for (const g of rootGroups.values()) g.spans.sort((x, y) => x.start - y.start)
  let rootLaneDefs = [...rootGroups.entries()].map(([key, g]) => ({ key, label: g.label, spans: g.spans }))
  if (rootLaneDefs.length === 1) {
    rootLaneDefs = [{ key: ROOT_KEY, label: ROOT_KEY, spans: rootLaneDefs[0]!.spans }]
  }
  // 同起点（同刻并行派发的成员）按道键定序——布局不依赖传入顺序
  rootLaneDefs.sort((a, b) =>
    Math.min(...a.spans.map(s => s.start)) - Math.min(...b.spans.map(s => s.start)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  // ② 子代理条：多次派发按派发拆条——各根区间取该次桥的 dispatch→response，
  // 端点钳到下次派发（ingest [dispatch_i, dispatch_{i+1}) 同口径）；仅一次派发
  // 或缺时间戳回落整段会话口径
  const subSpans: Span[] = []
  for (const a of subAgents) {
    const sp = spanOf(a)
    const usable = identityOf(a).bridges.filter(b => Number.isFinite(tOf(b.dispatchTimestamp)))
    if (usable.length >= 2) {
      usable.forEach((b, i) => {
        const start = tOf(b.dispatchTimestamp)
        const candidates = [tOf(b.responseTimestamp), tOf(usable[i + 1]?.dispatchTimestamp)].filter(Number.isFinite)
        const end = candidates.length > 0 ? Math.min(...candidates) : sp.end
        subSpans.push({
          agent: a, start, end: Math.max(start + 1, end), key: `${a.executionId}#${i}`, bridge: b,
          laneKey: resolveLaneKey(b.dispatchContent, lanes),
        })
      })
    } else {
      // 整段条：车道匹配优先用桥派发内容（与浮窗同源）——proxy 形态的 agentName
      // 常是类型名（不含车道词），先用它会把带车道词的条漏到贪心槽
      const joinedSteps = usable.map(b => b.dispatchContent).filter(Boolean).join(' · ')
      subSpans.push({
        agent: a, start: sp.start, end: Math.max(sp.start + 1, sp.end), key: a.executionId,
        laneKey: resolveLaneKey(joinedSteps, lanes) ?? resolveLaneKey(identityOf(a).step, lanes),
      })
    }
  }

  // ③ 槽位
  const slotAssignment = assignLaneSlots(subSpans, lanes)
  const slotLabels = slotAssignment.labels

  const lanesOut: SwimLane[] = rootLaneDefs.map(def => {
    const agentsInLane = def.spans.map(s => s.agent)
    const windows = windowsOf(agentsInLane)
    return {
      key: def.key,
      label: def.label,
      kind: 'root',
      color: ROOT_COLOR,
      rows: def.spans.length,
      bars: def.spans.map((sp, i) => makeBar(sp, ROOT_COLOR, i, windows)),
      windows,
    }
  })
  slotLabels.forEach((label, i) => {
    const spans = subSpans.filter(s => (slotAssignment.slotOf.get(s.key) ?? 0) === i)
    lanesOut.push({
      key: `slot-${i + 1}`,
      label,
      kind: 'slot',
      color: spans[0] ? colorOf.get(typeOf(spans[0].agent))! : ROOT_COLOR,
      rows: 1,
      bars: spans.map(sp => makeBar(sp, colorOf.get(typeOf(sp.agent))!, 0, windowsOf([sp.agent], sp.start, sp.end))),
      windows: [],
    })
  })

  const countByKey = new Map<string, number>()
  for (const sp of subSpans) {
    const k = typeOf(sp.agent)
    countByKey.set(k, (countByKey.get(k) ?? 0) + 1)
  }

  const windowOfTurn = new Map<string, SwimTurnWindow>()
  for (const w of windowsOf(visible)) if (!windowOfTurn.has(w.turnId)) windowOfTurn.set(w.turnId, w)

  return {
    lanes: lanesOut,
    startMs,
    endMs,
    totalMs,
    legend: legendKeys.map(k => ({ key: k, color: colorOf.get(k)!, count: countByKey.get(k) ?? 0 })),
    agentCount: agents.length,
    subagentCount: agents.filter(a => a.isSubagent).length,
    maxConcurrency: computeMaxConcurrency(subSpans),
    windowOfTurn,
  }
}
