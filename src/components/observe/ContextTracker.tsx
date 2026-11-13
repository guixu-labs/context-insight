"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useState, useMemo, useCallback, useEffect, useRef } from "react"
import { Badge } from "@/components/ui/badge"
import { ScrollFade } from "@/components/ui/scroll-fade"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ZoomInIcon, ZoomOutIcon, MaximizeIcon, ChevronRightIcon, PlayIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { ContextReplayDialog } from "@/components/observe/ContextReplayDialog"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { isCommandTurn, isContinuationTurn, parseCommandTurns, formatCommandDisplay } from "@/lib/shared/command-parser"
import { buildRunActors, subagentBaseNameOf, type RunActor } from "@/components/observe/run-actor"
import { fallbackAgentDisplayName, mainAgentDisplayName } from "@/components/observe/agent-display-name"
import { contextAgentKeyOf, contextLegendKeyOf, contextColorMapOf } from "@/components/observe/context-legend"
import { lttb, monotonePath } from "@/components/observe/chart-geometry"

export interface TurnRowItem {
  turnId: string
  turnIndex: number
  role: string
  contentSummary: string | null
  agentName: string | null
  isSubagent: boolean
  subagentName: string | null
  subagentSessionId: string | null
  /** 子代理类型（泳道图例同款键 `subagentType ?? agentName` 的前半；缺省回
   *  落 agentName（session/export 载荷），行为不变 */
  subagentType?: string | null
  parentExecutionId: string | null
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  inputMessagesTokens: number
  contextWindowPct: number | null
  latencyMs: number
  createdAt: string | null
  completedAt: string | null
  model: string | null
  /** 成员归因（run 视图：root 分组键 + 道名源；session/export 载荷缺省） */
  member?: { taskId: string; label: string | null } | null
}

/** agent 分组键（ContextTracker 与 ContextReplayDialog 同构，泳道同款结构）：
 *  root 按成员会话（session 即 agent）、subagent 按 sid 全局池化；无 member
 *  归因回落单 root（session/export 路径旧口径）——实现移至 context-legend.ts
 *  共享模块（斩断两组件循环依赖），此处经 import 消费 */
export { contextAgentKeyOf } from "@/components/observe/context-legend"

function formatTokenCount(n: number): string {
  if (n === 0) return "0"
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return `${n}`
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return ""
  try {
    const d = new Date(ts)
    const m = String(d.getMonth() + 1)
    const day = String(d.getDate())
    const h = String(d.getHours()).padStart(2, "0")
    const min = String(d.getMinutes()).padStart(2, "0")
    return `${m}/${day} ${h}:${min}`
  } catch {
    return ts
  }
}

function validTimestampMs(ts: string | null): number | null {
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

interface AgentStats {
  sessionId: string
  agentName: string
  isRoot: boolean
  /** 子代理类型（卡名/配色键 = `subagentType ?? agentName`，与泳道图例一致；
   *  root / 缺省载荷为 null → 回落 agentName） */
  subagentType: string | null
  /** run 视图成员归因（root：成员会话 taskId；subagent/单会话为 null） */
  memberTaskId: string | null
  /** root 道名（成员短名，与泳道 root 道同源；单会话为 null → 回落 agentName） */
  memberLabel: string | null
  /** 该 agent 的上下文窗口上限（run 视图服务端预算；单会话 = session 模型上限） */
  contextLimit: number
  turns: TurnRowItem[]
  peak: number
  average: number
  min: number
  totalTurns: number
  avgGrowthPerTurn: number
  cacheHitRate: number
  maxContextWindowPct: number
  events: ContextEvent[]
  /** 初始轮（该 agent 的首个原始轮——常为 0-token 派发消息，不在 turns 里）：
   *  增长曲线的原点锚——曲线从 0 生长到初始上下文；初始轮即首数据轮（无
   *  0-token 轮）时锚与首数据点同 x（零宽 riser） */
  birth: TurnRowItem | null
}

interface ContextEvent {
  type: "start" | "growth" | "peak" | "warning" | "end" | "compact"
  turnIndex: number
  timestamp: string | null
  contextSize: number
  note?: string
  growth?: number
  contTurnIndex?: number
  contTimestamp?: string | null
  preCompactTokens?: number
  postCompactTokens?: number
}

/** 图例组（胶囊/组详情弹窗同构）：root 一键一会话、type 聚合 ×N */
interface LegendGroup {
  key: string
  kind: "root" | "type"
  label: string
  color: string
  sessionIds: string[]
  count: number
  visibleCount: number
}

/** /compact + continuation 事件检测（单个 root 分组内）：命令轮常
 *  totalTokens=0，不进统计分组，须扫该分组的原始轮次；run 视图多成员时
 *  各成员独立检测，preTurn/postToken 不得跨成员错配 */
function detectCompactEvents(memberTurns: TurnRowItem[]): ContextEvent[] {
  const compactList: Array<{ turnIndex: number; timestamp: string | null; note: string }> = []
  const contList: Array<{ turnIndex: number; timestamp: string | null }> = []
  for (const t of memberTurns) {
    if (t.isSubagent) continue
    const text = t.contentSummary ?? ""
    if (t.agentName === 'compaction-boundary') {
      compactList.push({ turnIndex: t.turnIndex, timestamp: t.createdAt, note: text || "/compact" })
      contList.push({ turnIndex: t.turnIndex, timestamp: t.createdAt })
      continue
    }
    if (t.role !== "user") continue
    if (isCommandTurn(text)) {
      const texts = [text]
      const idx = memberTurns.indexOf(t)
      for (let j = idx + 1; j < memberTurns.length; j++) {
        const nextText = memberTurns[j].contentSummary ?? ""
        if (nextText.includes("<local-command-caveat>") || nextText.includes("<local-command-stdout>")) { texts.push(nextText) } else break
      }
      const info = parseCommandTurns(texts)
      if (info.name === "/compact" || info.name === "compact") {
        compactList.push({ turnIndex: t.turnIndex, timestamp: t.createdAt, note: formatCommandDisplay(info) })
      }
    }
    if (isContinuationTurn(text)) {
      contList.push({ turnIndex: t.turnIndex, timestamp: t.createdAt })
    }
  }
  compactList.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
    return ta - tb
  })
  contList.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
    return ta - tb
  })
  // Find context drop data for each compact event pair
  const rootDataTurns = memberTurns.filter(t => !t.isSubagent && t.totalTokens > 0)
  const merged: ContextEvent[] = []
  for (let i = 0; i < compactList.length; i++) {
    const c = compactList[i]
    const cont = i < contList.length ? contList[i] : null
    const compactTsMs = c.timestamp ? new Date(c.timestamp).getTime() : 0
    const contTsMs = cont?.timestamp ? new Date(cont.timestamp).getTime() : 0
    const preTurn = [...rootDataTurns].reverse().find(t => {
      const tTs = t.createdAt ? new Date(t.createdAt).getTime() : 0
      return tTs <= compactTsMs
    })
    const postTurn = contTsMs > 0
      ? rootDataTurns.find(t => {
          const tTs = t.createdAt ? new Date(t.createdAt).getTime() : 0
          return tTs >= contTsMs
        })
      : rootDataTurns.find(t => {
          const tTs = t.createdAt ? new Date(t.createdAt).getTime() : 0
          return tTs >= compactTsMs
        })
    const preTokens = preTurn?.totalTokens ?? 0
    const postTokens = postTurn?.totalTokens ?? 0
    const dropPct = preTokens > 0 && postTokens > 0 ? Math.round((1 - postTokens / preTokens) * 100) : 0
    merged.push({
      type: "compact",
      turnIndex: c.turnIndex,
      timestamp: c.timestamp,
      contextSize: 0,
      contTurnIndex: cont?.turnIndex ?? undefined,
      contTimestamp: cont?.timestamp ?? undefined,
      preCompactTokens: preTokens > 0 ? preTokens : undefined,
      postCompactTokens: postTokens > 0 ? postTokens : undefined,
      note: cont
        ? `⚡ /compact ↓${dropPct > 0 ? `-${dropPct}%` : ""}`
        : `⚡ /compact (#${c.turnIndex})`,
    })
  }
  return merged
}

function computeAgentStats(turns: TurnRowItem[], limitOf: (sid: string) => number): AgentStats[] {
  const sessionMap = new Map<string, TurnRowItem[]>()
  // 初始轮（该 agent 键的首个原始轮——常为 0-token 派发消息，被统计过滤
  // 排除）：增长曲线的原点锚。context 从 0 生长，曲线须以「0 → 初始上下文」
  // 开局，而非从首个测量值起步
  const birthMap = new Map<string, TurnRowItem>()

  for (const t of turns) {
    const sid = contextAgentKeyOf(t)
    if (!birthMap.has(sid)) birthMap.set(sid, t)
    if (t.totalTokens <= 0) continue
    if (!sessionMap.has(sid)) sessionMap.set(sid, [])
    sessionMap.get(sid)!.push(t)
  }

  // /compact 检测按 root 分组独立进行（run 视图多成员）
  const rootGroups = new Map<string, TurnRowItem[]>()
  for (const t of turns) {
    if (t.isSubagent) continue
    const key = contextAgentKeyOf(t)
    if (!rootGroups.has(key)) rootGroups.set(key, [])
    rootGroups.get(key)!.push(t)
  }
  const compactByRoot = new Map<string, ContextEvent[]>()
  for (const [key, group] of rootGroups) compactByRoot.set(key, detectCompactEvents(group))

  const stats: AgentStats[] = []

  for (const [sid, agentTurns] of sessionMap) {
    const isRoot = !agentTurns[0].isSubagent
    const member = agentTurns[0].member ?? null
    const contextLimit = limitOf(sid)
    const subagentType = isRoot ? null : agentTurns[0].subagentType ?? null
    const agentName = fallbackAgentDisplayName({
      isSubagent: !isRoot,
      memberLabel: member?.label,
      agentName: agentTurns[0].agentName,
    })
    const realInput = agentTurns.map(t => t.inputMessagesTokens || t.totalTokens)
    const cacheRead = agentTurns.map(t => t.cacheReadTokens ?? 0)
    const ctxPcts = agentTurns.map(t => t.contextWindowPct ?? 0).filter(p => p > 0)

    const peak = Math.max(...realInput)
    const average = Math.round(realInput.reduce((s, v) => s + v, 0) / realInput.length)
    const min = Math.min(...realInput)
    const avgGrowthPerTurn = agentTurns.length > 1
      ? Math.round((realInput[realInput.length - 1] - realInput[0]) / (agentTurns.length - 1))
      : 0

    let totalCacheHit = 0
    let totalTokensForCache = 0
    for (let i = 0; i < realInput.length; i++) {
      const it = realInput[i]
      const cr = cacheRead[i]
      if (it + cr > 0) {
        totalCacheHit += cr
        totalTokensForCache += it + cr
      }
    }
    const cacheHitRate = totalTokensForCache > 0 ? totalCacheHit / totalTokensForCache : 0
    const maxContextWindowPct = ctxPcts.length > 0 ? Math.max(...ctxPcts) : 0

    const events: ContextEvent[] = []

    if (agentTurns.length > 0) {
      events.push({ type: "start", turnIndex: agentTurns[0].turnIndex, timestamp: agentTurns[0].createdAt, contextSize: agentTurns[0].totalTokens, note: isRoot ? "Session 启动" : "Subagent 启动" })
    }

    for (let i = 1; i < agentTurns.length; i++) {
      const growth = agentTurns[i].totalTokens - agentTurns[i - 1].totalTokens
      if (growth > 5000) {
        events.push({ type: "growth", turnIndex: agentTurns[i].turnIndex, timestamp: agentTurns[i].createdAt, contextSize: agentTurns[i].totalTokens, growth, note: `增长 ${formatTokenCount(growth)}` })
      }
    }

    const peakTurn = agentTurns.reduce((max, t) => (t.inputMessagesTokens || t.totalTokens) > (max.inputMessagesTokens || max.totalTokens) ? t : max, agentTurns[0])
    if (peakTurn.totalTokens > 0) {
      const pct = peakTurn.contextWindowPct ?? (peakTurn.totalTokens / contextLimit * 100)
      const note = pct > 80 ? `⚠️ 接近模型限制 (${contextLimit / 1000}K)` : "峰值"
      events.push({ type: "peak", turnIndex: peakTurn.turnIndex, timestamp: peakTurn.createdAt, contextSize: peakTurn.totalTokens, note })
    }

    const warningTurns = agentTurns.filter(t => {
      const pct = t.contextWindowPct ?? (t.totalTokens / contextLimit * 100)
      return pct > 80
    })
    for (const t of warningTurns) {
      if (!events.some(e => e.turnIndex === t.turnIndex && e.type === "peak")) {
        events.push({ type: "warning", turnIndex: t.turnIndex, timestamp: t.createdAt, contextSize: t.totalTokens, note: `窗口占比 ${(t.contextWindowPct ?? 0).toFixed(1)}%` })
      }
    }

    if (agentTurns.length > 0) {
      events.push({ type: "end", turnIndex: agentTurns[agentTurns.length - 1].turnIndex, timestamp: agentTurns[agentTurns.length - 1].createdAt, contextSize: agentTurns[agentTurns.length - 1].totalTokens, note: isRoot ? "Session 结束" : "Subagent 结束" })
    }

    events.sort((a, b) => a.turnIndex - b.turnIndex)

    // Merge compact events into the (member) root agent's timeline
    const compactEvents = isRoot ? compactByRoot.get(sid) ?? [] : []
    if (compactEvents.length > 0) {
      events.push(...compactEvents)
      events.sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
        return ta - tb
      })
    }

    stats.push({ sessionId: sid, agentName, isRoot, subagentType, memberTaskId: member?.taskId ?? null, memberLabel: member?.label ?? null, contextLimit, turns: agentTurns, peak, average, min, totalTurns: agentTurns.length, avgGrowthPerTurn, cacheHitRate, maxContextWindowPct, events, birth: birthMap.get(sid) ?? null })
  }

  stats.sort((a, b) => {
    if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1
    return b.peak - a.peak
  })

  return stats
}

interface ContextTrackerProps {
  turns: TurnRowItem[]
  sessionModel: string | null
  /** 每 agent 的上下文窗口上限（run 视图服务端预算，key = contextAgentKeyOf）；
   *  缺省回落 config fetch（session/export 路径，单模型单限旧口径） */
  agentContextLimits?: Record<string, number> | null
  onNavigateToTurn?: (turnId: string, memberTaskId?: string | null) => void
}

export function ContextTracker({ turns, sessionModel, agentContextLimits, onNavigateToTurn }: ContextTrackerProps) {
  const [configLimit, setConfigLimit] = useState(1000000)
  const [showReplay, setShowReplay] = useState(false)

  useEffect(() => {
    if (agentContextLimits) return // run 视图：服务端已预算每 agent 上限
    fetch(`/api/config/context-windows?model=${encodeURIComponent(sessionModel ?? "")}`)
      .then(r => r.json())
      .then(data => setConfigLimit(data.limit ?? 1000000))
      .catch(() => setConfigLimit(1000000))
  }, [sessionModel, agentContextLimits])

  const limitOf = useCallback((sid: string) => agentContextLimits?.[sid] ?? configLimit, [agentContextLimits, configLimit])
  const agentStats = useMemo(() => computeAgentStats(turns, limitOf), [turns, limitOf])

  // 图表/回放/图例的单限 = 各 agent 上限最大值（单会话/同模型即旧口径原值；
  // 混模型 run 取最大窗口作保守参考线——各 agent 精确限在卡片统计与悬浮里）
  const chartLimit = useMemo(
    () => (agentStats.length > 0 ? Math.max(...agentStats.map(s => s.contextLimit)) : configLimit),
    [agentStats, configLimit],
  )

  // run 参与者目录（单一源）：身份/图例/展示名（别名归一 + 同名编号 + 派发
  // 步骤回落）一律经 run-actor 组合——卡片/图例/摘要/详情不再内联命名规则
  const actors = useMemo(() => buildRunActors(turns), [turns])
  const displayLabel = useCallback((s: AgentStats) => {
    return actors.get(s.sessionId)?.displayName
      // 目录缺项兜底（载荷异常保底，理论不可达）
      ?? (s.isRoot
        ? mainAgentDisplayName({ memberLabel: s.memberLabel, agentName: s.agentName })
        : subagentBaseNameOf(s))
  }, [actors])

  if (agentStats.length === 0) {
    // 区分病因：有轮次但全 0 token = 源日志 assistant 行缺 message.usage
    //（第三方转换件常见），与"真的没数据"提示不同，避免被当成页面坏了
    const noTokenData = turns.length > 0 && !turns.some(t => t.totalTokens > 0)
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 p-8">
        <div className="text-muted-foreground text-sm">
          {noTokenData ? "无 token 用量数据，无法绘制上下文曲线" : "No context data available"}
        </div>
        {noTokenData && (
          <div className="text-muted-foreground/70 max-w-lg text-center text-xs leading-relaxed">
            本会话 {turns.length} 个轮次的 token 计数全为 0——源日志的 assistant 行缺少
            message.usage（常见于第三方格式转换件未输出 usage 字段）。轮次与耗时数据正常，
            可查看其它页签；源数据补上 usage 后重新导入即可恢复本页。
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-full flex-col gap-3 p-4">
      <ContextReplayDialog
        open={showReplay}
        onOpenChange={setShowReplay}
        turns={turns}
        contextWindowLimit={chartLimit}
      />
      <GrowthChart
        agentStats={agentStats}
        contextWindowLimit={chartLimit}
        displayLabel={displayLabel}
        actors={actors}
        onNavigateToTurn={onNavigateToTurn}
        onOpenReplay={() => setShowReplay(true)}
      />
    </div>
  )
}

type HoveredPoint = {
  sessionId: string; groupKey: string; turnIndex: number; x: number; y: number
  tokens: number; cacheRead: number; newInput: number; cacheWrite: number
  contextWindowPct: number | null; time: string; label: string; color: string; turn: TurnRowItem
  /** 初始锚点（0-token 派发轮）：tooltip 走派发轮形态（消息摘要，无 token
   *  计量段） */
  isBirth?: boolean
  /** 悬浮命中时快照的视口坐标 + 视口尺寸（渲染期零 ref 访问——事件回调
   *  里算好入 state，React 渲染纯函数化） */
  screen: { x: number; y: number; vpW: number; vpH: number }
}

/** 命中域点（主图悬浮/点选）：数据轮 + 初始锚。初始锚是真实 user 轮——
 *  可悬浮（tooltip 展示派发细节）、原地点击跳转该轮；零值不入统计口径 */
type GrowthHitPoint = {
  x: number; y: number
  tokens: number; cacheRead: number; newInput: number; cacheWrite: number
  contextWindowPct: number | null
  turnIndex: number; time: string; turn: TurnRowItem
  isBirth?: boolean
}

/** 趋势图几何缺省（viewBox 单位）：真实尺寸跟随视口自适应（ResizeObserver
 *  直写 world——绘图区铺满全宽，宽屏无两侧留白）；无布局环境（happy-dom/
 *  SSR）保持该缺省，测试坐标可解析推演 */
const SVG_HEIGHT = 460
const SVG_W = 1200
const SVG_H = SVG_HEIGHT

/** 大 run 自适应阈值：agent/图例组 ≤ INLINE_GROUPS_MAX 时全量平铺（单会
 *  话/小 run 与既有行为零差异）；超出启用聚焦模式——曲线默认只画峰值
 *  Top-K（百级成员的曲线墙既不可读也难渲染）、图例胶囊折叠区 + 搜索 */
const INLINE_GROUPS_MAX = 12
const FOCUS_TOP_K = 8
const COLLAPSED_PILLS = 16

function GrowthChart({ agentStats, contextWindowLimit, displayLabel, actors, onNavigateToTurn, onOpenReplay }: {
  agentStats: AgentStats[]
  contextWindowLimit: number
  displayLabel: (s: AgentStats) => string
  /** run 参与者目录（命名单一源）：图例基名/卡片出处徽标在此消费 */
  actors: Map<string, RunActor>
  onNavigateToTurn?: (turnId: string, memberTaskId?: string | null) => void
  onOpenReplay?: () => void
}) {
  const PADDING_TOP = 40
  const PADDING_BOTTOM = 40
  const PADDING_LEFT = 60
  const PADDING_RIGHT = 40

  const viewportRef = useRef<HTMLDivElement>(null)
  // 趋势图世界：跟随视口自适应（state 驱动几何重算）
  const [world, setWorld] = useState({ w: SVG_W, h: SVG_H })
  // 大 run 聚焦模式：agent 数超阈值时默认只画峰值 Top-K（曲线墙不可读）；
  // 小 run / 单会话保持全显（用户拍板的原语义——子代理不按阈值折叠）
  const topKSessionIds = useMemo(() => new Set(
    [...agentStats].sort((a, b) => b.peak - a.peak).slice(0, FOCUS_TOP_K).map(s => s.sessionId),
  ), [agentStats])
  const [visibleSessions, setVisibleSessions] = useState<Set<string>>(
    () => (agentStats.length <= INLINE_GROUPS_MAX ? new Set(agentStats.map(s => s.sessionId)) : new Set(topKSessionIds)),
  )
  const [hoveredPoint, setHoveredPoint] = useState<HoveredPoint | null>(null)
  const hoveredRef = useRef<HoveredPoint | null>(null)
  const [highlightKey, setHighlightKey] = useState<string | null>(null)
  // 图内点选聚焦：原地点击曲线选中该组（其余变灰、选中变亮），再点同线或点
  // 空白取消——持久态，与悬浮/胶囊 hover 的瞬时高亮叠加（hover 优先）；表
  // 卡片不参与联动
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<"area" | "line">("area")
  // 大 run 图例治理：胶囊折叠区（预览前 N + 展开限高滚动）+ 前缀搜索
  // （百级组里找任务是刚需）
  const [legendExpanded, setLegendExpanded] = useState(false)
  const [legendQuery, setLegendQuery] = useState("")
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [detailSid, setDetailSid] = useState<string | null>(null)

  // ── 时间窗模型（Perf 效率分布同款）：图框恒定（SVG 随视口满铺，缩放绝不
  // 作用于图框本身），缩放/平移只改时间轴——窗口内重新采样（LTTB）+ 刻度
  // 随窗进位 + y 量程随窗口自适应（可见范围即分析范围；80/100% 参考线随
  // 窗口量程进出画面）。窗口状态携带数据源身份：失配即视为全程（切数据
  // 自动复位，无需副作用链）
  const [winState, setWinState] = useState<{ src: AgentStats[]; range: [number, number] | null }>({ src: agentStats, range: null })
  const win = winState.src === agentStats ? winState.range : null
  const setWin = useCallback((range: [number, number] | null) => setWinState({ src: agentStats, range }), [agentStats])
  // 缩放回调经 ref 透传给一次性挂载的原生滚轮监听（恒取最新渲染闭包，
  // 免重挂监听）
  const zoomAtRef = useRef<(factor: number, vx?: number) => void>(() => {})
  // 缩放落定后的悬浮重算请求（窗口几何在渲染提交后才就绪——立即算会用旧几何）
  const pendingHoverRef = useRef<{ x: number; y: number } | null>(null)
  const panMovedRef = useRef(false)
  const panningRef = useRef(false)

  // 视口尺寸自适应（图框随视口重建，时间窗几何按新框重算）；无布局环境
  //（happy-dom/SSR）保持缺省世界（测试坐标可解析推演）
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(entries => {
      const w = Math.round(entries[0].contentRect.width)
      const h = Math.round(entries[0].contentRect.height)
      if (w <= 0 || h <= 0) return
      setWorld(prev => (Math.abs(prev.w - w) < 4 && Math.abs(prev.h - h) < 4 ? prev : { w, h }))
    })
    ro.observe(vp)
    return () => ro.disconnect()
  }, [])

  // 类型配色（黄金角度序列）：全量 agents 计算而非可见集——显隐切换不改色，
  // 图例/曲线/回放三处同源同色
  const colorMap = useMemo(() => contextColorMapOf(agentStats), [agentStats])

  // 图例分组：root 一键一会话（成员短名）、subagent 按类型聚合（×N 计数）——
  // 百级子代理折叠成十级类型条目，与泳道图例同构
  const groups = useMemo(() => {
    const byKey = new Map<string, LegendGroup>()
    for (const s of agentStats) {
      const key = contextLegendKeyOf(s)
      let g = byKey.get(key)
      if (!g) {
        g = {
          key,
          kind: s.isRoot ? "root" : "type",
          // 图例基名与卡片同源（run-actor 单一源）：别名归一在此同步生效，
          // 胶囊与卡片的命名群体不再分裂
          label: s.isRoot ? displayLabel(s) : (actors.get(s.sessionId)?.baseName ?? subagentBaseNameOf(s)),
          color: colorMap.get(key) ?? "#94a3b8",
          sessionIds: [],
          count: 0,
          visibleCount: 0,
        }
        byKey.set(key, g)
      }
      g.sessionIds.push(s.sessionId)
      g.count += 1
      if (visibleSessions.has(s.sessionId)) g.visibleCount += 1
    }
    // 规范键序（root 在前、同层字典序）：与配色分配同序——图例条目、曲线、
    // 回放三处颜色对位一致，且不随 stats 排序（peak）漂移
    return [...byKey.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "root" ? -1 : 1
      return a.key.localeCompare(b.key)
    })
  }, [agentStats, visibleSessions, colorMap, displayLabel, actors])

  const activeHighlight = hoveredPoint?.groupKey ?? highlightKey ?? selectedKey

  // ── 大 run 自适应（组数/卡数超阈值才生效，小 run/单会话零变化）──────────
  // 图例展示序：可见组前置（折叠预览先回答「图上正画着谁」），组内保持规范
  // 键序（配色分配同序不漂移）；小 run 保持纯规范序（行为零变化）
  const legendBig = groups.length > INLINE_GROUPS_MAX
  const orderedGroups = useMemo(() => {
    if (!legendBig) return groups
    const visible: typeof groups = []
    const hidden: typeof groups = []
    for (const g of groups) (g.visibleCount > 0 ? visible : hidden).push(g)
    return [...visible, ...hidden]
  }, [groups, legendBig])
  const legendQueryLower = legendQuery.trim().toLowerCase()
  const matchedGroups = legendQueryLower
    ? orderedGroups.filter(g => g.label.toLowerCase().includes(legendQueryLower))
    : orderedGroups
  const legendShowAll = legendExpanded || legendQueryLower.length > 0
  const shownGroups = legendShowAll ? matchedGroups : matchedGroups.slice(0, COLLAPSED_PILLS)
  // 峰值 Top 快捷键激活判定（集合等值）
  const topKActive = visibleSessions.size === topKSessionIds.size
    && [...topKSessionIds].every(id => visibleSessions.has(id))

  const filteredStats = useMemo(() => agentStats.filter(s => visibleSessions.has(s.sessionId)), [agentStats, visibleSessions])
  // 悬浮窗口占比回落用的每 agent 精确限（chart 单限是各 agent 最大值参考线）
  const limitBySid = useMemo(() => new Map(agentStats.map(s => [s.sessionId, s.contextLimit])), [agentStats])

  const allPoints = useMemo(() => {
    const pts: Array<{ turnIndex: number; timestamp: number; inputTokens: number }> = []
    for (const s of filteredStats) {
      for (const t of s.turns) {
        const timestamp = validTimestampMs(t.createdAt)
        if (timestamp != null) pts.push({ turnIndex: t.turnIndex, timestamp, inputTokens: t.inputMessagesTokens })
      }
      // 初始轮入时间域：run 时间线自派发消息起算（曲线原点锚可及），但
      // 不占 y 量程（inputTokens=0）也不进命中/悬浮域（allPoints 只供
      // minTime/maxTime/globalMaxInput）
      const birthTimestamp = validTimestampMs(s.birth?.createdAt ?? null)
      if (s.birth && birthTimestamp != null) {
        pts.push({ turnIndex: s.birth.turnIndex, timestamp: birthTimestamp, inputTokens: 0 })
      }
    }
    return pts
  }, [filteredStats])

  const geo = useMemo(() => {
    const minTime = allPoints.length > 0 ? Math.min(...allPoints.map(p => p.timestamp)) : 0
    const maxTime = allPoints.length > 0 ? Math.max(...allPoints.map(p => p.timestamp)) : 0
    const fullSpan = maxTime - minTime
    const v0 = win ? Math.max(win[0], minTime) : minTime
    const v1 = win ? Math.min(win[1], maxTime) : maxTime
    const tSpan = Math.max(v1 - v0, 0)

    const chartWidth = world.w
    const plotWidth = chartWidth - PADDING_LEFT - PADDING_RIGHT
    const plotHeight = world.h - PADDING_TOP - PADDING_BOTTOM
    const baselineY = world.h - PADDING_BOTTOM

    // y 量程随窗口：可见峰值整步上取（1.15 余量），仍钳在窗口上限 1.1 倍内
    //（逼近限制时 100% 参考线可及）；空窗回落全程峰值（网格结构不塌）
    const globalMaxInput = Math.max(...allPoints.map(p => p.inputTokens), 1)
    const winTurns: TurnRowItem[] = []
    for (const s of filteredStats) {
      for (const t of s.turns) {
        const ts = validTimestampMs(t.createdAt)
        if (ts != null && ts >= v0 && ts <= v1) winTurns.push(t)
      }
    }
    const winMaxInput = winTurns.length > 0 ? Math.max(...winTurns.map(t => t.inputMessagesTokens), 1) : globalMaxInput
    const yMax = Math.min(Math.ceil(winMaxInput * 1.15 / 10000) * 10000, contextWindowLimit * 1.1)

    const toXFn = (ts: number) => PADDING_LEFT + ((ts - v0) / (tSpan || 1)) * plotWidth
    const toYFn = (tokens: number) => PADDING_TOP + plotHeight - (tokens / yMax) * plotHeight

    // Y 轴：nice step（1/2/2.5/5×10^n，~5 条刻度），替代死档位
    const yTicks: Array<{ value: number; y: number; label: string }> = (() => {
      const raw = yMax / 5
      const mag = Math.pow(10, Math.floor(Math.log10(raw)))
      const norm = raw / mag
      const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
      const ticks: Array<{ value: number; y: number; label: string }> = []
      for (let v = 0; v <= yMax; v += step) ticks.push({ value: v, y: toYFn(v), label: formatTokenCount(v) })
      return ticks
    })()

    // X 轴：等分 ~5 刻度，格式随窗口跨度进位（<10min 秒级，<24h 仅时分，
    // <3d 月/日+时分，更长仅月/日）——放大后刻度才会变细
    const timeTicks: Array<{ x: number; label: string }> = (() => {
      const spanHours = tSpan / 3600000
      const target = 5
      const stepMs = (tSpan || 1) / target
      const ticks: Array<{ x: number; label: string }> = []
      for (let i = 0; i <= target; i++) {
        const ts = v0 + stepMs * i
        const d = new Date(ts)
        const two = (x: number) => String(x).padStart(2, "0")
        const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
        const label = spanHours < 1 / 6
          ? `${hm}:${two(d.getSeconds())}`
          : spanHours < 24 ? hm : spanHours < 72 ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : `${d.getMonth() + 1}/${d.getDate()}`
        ticks.push({ x: toXFn(ts), label })
      }
      return ticks
    })()

    const cautionY = PADDING_TOP + plotHeight - (contextWindowLimit * 0.8 / yMax) * plotHeight
    const limitY = PADDING_TOP + plotHeight - (contextWindowLimit / yMax) * plotHeight

    const pctMarkers: Array<{ pct: number; y: number; label: string; color: string }> = []
    if (cautionY >= PADDING_TOP && cautionY <= baselineY) pctMarkers.push({ pct: 80, y: cautionY, label: "80%", color: "#eab308" })
    if (limitY >= PADDING_TOP && limitY <= baselineY) pctMarkers.push({ pct: 100, y: limitY, label: "100%", color: "#ef4444" })

    // 渲染降采样目标：~1 点/2px（LTTB）——悬浮命中/tooltip 仍走全量点，精度无损
    const RENDER_PT_TARGET = Math.max(120, Math.floor(plotWidth / 2))

    const agentLines = filteredStats.map(s => {
      const groupKey = contextLegendKeyOf(s)
      const color = colorMap.get(groupKey) ?? "#94a3b8"
      const label = displayLabel(s)
      const isRoot = s.isRoot
      const points = s.turns
        .filter(t => {
          const ts = validTimestampMs(t.createdAt)
          return ts != null && ts >= v0 && ts <= v1
        })
        .map(t => ({
          x: toXFn(validTimestampMs(t.createdAt)!),
          y: toYFn(t.inputMessagesTokens),
          tokens: t.totalTokens,
          cacheRead: t.cacheReadTokens,
          newInput: t.inputTokens,
          cacheWrite: t.cacheWriteTokens,
          contextWindowPct: t.contextWindowPct,
          turnIndex: t.turnIndex,
          time: formatTimestamp(t.createdAt),
          turn: t,
        }))
      const peakInput = points.reduce((m, p) => Math.max(m, p.turn.inputMessagesTokens), 0)
      const ltp = lttb(points, RENDER_PT_TARGET)
      // 初始锚点：曲线从 0 生长——锚在初始轮时刻（初始轮即首数据轮时与其
      // 同 x，零宽 riser；monotonePath 零宽段直线跳转）；单轮 agent 不锚
      // （保留在场点口径）。锚只进绘制序列（线 + 面积）与命中域，统计口径
      // 不动。x 取 min(birth, 首点)——序列保单调（原始轮序异常时不出回拐）
      const birthTs = validTimestampMs(s.birth?.createdAt ?? null)
      const anchor = points.length >= 2
        ? { x: Math.min(birthTs != null ? toXFn(birthTs) : points[0].x, points[0].x), y: toYFn(0) }
        : null
      // 命中负载：初始锚是真实原始轮（与首数据轮不同轮时）——可悬浮、可
      // 原地点击跳转；初始轮即首数据轮（无 0-token 轮）时锚纯几何，该点
      // 由数据点自身承载悬浮
      const anchorHit: GrowthHitPoint | null = anchor && s.birth && !s.turns.includes(s.birth)
        ? {
            ...anchor,
            tokens: 0, cacheRead: 0, newInput: 0, cacheWrite: 0, contextWindowPct: null,
            turnIndex: s.birth.turnIndex,
            time: formatTimestamp(s.birth.createdAt),
            turn: s.birth,
            isBirth: true,
          }
        : null
      const renderPoints = anchor ? [anchor, ...ltp] : ltp
      const areaPoints = anchor ? [anchor, ...points] : points
      const hitPoints: GrowthHitPoint[] = anchorHit ? [anchorHit, ...points] : points
      return { sessionId: s.sessionId, groupKey, color, label, isRoot, points, renderPoints, areaPoints, hitPoints, totalTurns: s.totalTurns, peakInput }
    })

    return {
      minTime, maxTime, fullSpan, v0, v1, tSpan,
      chartWidth, plotWidth, plotHeight, baselineY, yMax,
      toXFn, toYFn, yTicks, timeTicks, cautionY, limitY, pctMarkers, agentLines,
      emptyWin: win != null && winTurns.length === 0,
    }
  }, [allPoints, filteredStats, win, world, contextWindowLimit, colorMap, displayLabel, PADDING_TOP, PADDING_BOTTOM, PADDING_LEFT, PADDING_RIGHT])

  const { minTime, maxTime, fullSpan, v0, v1, chartWidth, plotWidth, plotHeight, baselineY, yMax, toXFn, toYFn, yTicks, timeTicks, cautionY, limitY, pctMarkers, agentLines, emptyWin } = geo

  // 时间窗缩放：光标时刻锚定（缩放后该时刻的屏幕位置不动），窗口钳制在
  // 全程内；窗宽下限防退化，放大到全程即复位
  const zoomAt = (factor: number, vxRaw?: number) => {
    if (fullSpan <= 0) return
    const vx = Math.min(chartWidth - PADDING_RIGHT, Math.max(PADDING_LEFT, vxRaw ?? (PADDING_LEFT + plotWidth / 2)))
    const w0 = win ? win[0] : minTime
    const w1 = win ? win[1] : maxTime
    const span = w1 - w0
    const next = Math.min(fullSpan, Math.max(Math.max(1000, fullSpan / 240), span / factor))
    if (next >= fullSpan - 1) { setWin(null); return }
    if (Math.abs(next - span) < 1) return
    const ta = w0 + ((vx - PADDING_LEFT) / plotWidth) * span
    let n0 = ta - ((ta - w0) / span) * next
    let n1 = n0 + next
    if (n0 < minTime) { n0 = minTime; n1 = n0 + next }
    if (n1 > maxTime) { n1 = maxTime; n0 = n1 - next }
    setWin([n0, n1])
  }
  useEffect(() => { zoomAtRef.current = zoomAt })

  function areaPathStr(pts: Array<{ x: number; y: number }>): string {
    if (pts.length < 2) return ""
    return `${monotonePath(pts)} L ${pts[pts.length - 1].x},${baselineY} L ${pts[0].x},${baselineY} Z`
  }

  // 悬浮命中：client → 视口 → svg 用户坐标（图框恒定 1:1，手动数学，不依赖
  // getScreenCTM——测试环境无 CTM 也可精确推演）。ref 持有最新闭包：滚轮/
  // 拖拽等原生监听不因渲染抖动重挂
  function findNearestPoint(svgX: number, svgY: number) {
    let bestDist = Infinity
    let bestPoint: typeof hoveredPoint | null = null
    const HIT_RADIUS_SQ = 2500
    for (const line of agentLines) {
      for (const p of line.hitPoints) {
        const dx = p.x - svgX
        const dy = p.y - svgY
        const dist = dx * dx + dy * dy
        if (dist < bestDist && dist < HIT_RADIUS_SQ) {
          bestDist = dist
          bestPoint = {
            sessionId: line.sessionId, groupKey: line.groupKey, turnIndex: p.turnIndex, x: p.x, y: p.y,
            tokens: p.tokens, cacheRead: p.cacheRead, newInput: p.newInput, cacheWrite: p.cacheWrite,
            contextWindowPct: p.contextWindowPct, time: p.time, label: line.label, color: line.color, turn: p.turn,
            isBirth: p.isBirth,
            screen: { x: 0, y: 0, vpW: 0, vpH: 0 },
          }
        }
      }
    }
    return bestPoint
  }

  // 曲线命中（点选聚焦用）：各可见线在该 x 处的线性插值 y，取最小 |dy|，
  // 阈值 14px（monotone 路径与线性插值近似贴合）
  function findNearestCurve(svgX: number, svgY: number): string | null {
    let bestKey: string | null = null
    let bestDy = 14
    for (const line of agentLines) {
      const pts = line.points
      if (pts.length < 2) continue
      if (svgX < pts[0].x || svgX > pts[pts.length - 1].x) continue
      for (let i = 1; i < pts.length; i++) {
        if (svgX <= pts[i].x) {
          const a = pts[i - 1]
          const b = pts[i]
          const t = (svgX - a.x) / (b.x - a.x || 1)
          const dy = Math.abs(a.y + (b.y - a.y) * t - svgY)
          if (dy < bestDy) {
            bestDy = dy
            bestKey = line.groupKey
          }
          break
        }
      }
    }
    return bestKey
  }

  const updateHoverRef = useRef<(clientX: number, clientY: number) => void>(() => {})
  useEffect(() => {
    updateHoverRef.current = (clientX: number, clientY: number) => {
      if (panningRef.current) return
      const vp = viewportRef.current
      if (!vp) return
      const rect = vp.getBoundingClientRect()
      const nearest = findNearestPoint(clientX - rect.left, clientY - rect.top)
      if (nearest) {
        // 视口坐标快照入 state：tooltip 渲染期零 ref 访问（图框恒定，svg
        // 用户坐标即视口像素坐标）
        nearest.screen = {
          x: nearest.x,
          y: nearest.y,
          vpW: vp.clientWidth || world.w,
          vpH: vp.clientHeight || world.h,
        }
      }
      setHoveredPoint(nearest)
      hoveredRef.current = nearest
      setHighlightKey(nearest ? nearest.groupKey : null)
    }
  })


  // Ctrl/⌘+滚轮光标锚定缩放：原生 non-passive 监听（React 的 onWheel 挂
  // passive 通道，preventDefault() 无效，手势会被浏览器页面缩放劫持）。
  // 缩放落定后按新几何重算悬浮（tooltip 跟随新点位，不闪不漂）——窗口
  // 几何在渲染提交后才就绪，经 pendingHover 在提交后权威重算一次
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAtRef.current(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left)
      pendingHoverRef.current = { x: e.clientX, y: e.clientY }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])
  useEffect(() => {
    if (!pendingHoverRef.current || panningRef.current) return
    const { x, y } = pendingHoverRef.current
    pendingHoverRef.current = null
    updateHoverRef.current(x, y)
  })

  // 拖拽平移（时间窗整体推移，钳制在全程内；全程视图无平移域——内容已铺
  // 满窗口）：手势中隐藏 tooltip；原地点击且命中数据点 → 跳转该轮（与拖拽
  // 互斥，不误触）
  const onViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startWin = win && fullSpan > 0 ? { v0: win[0], v1: win[1] } : null
    panMovedRef.current = false
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!panMovedRef.current && Math.abs(dx) > 4 && startWin) {
        panMovedRef.current = true
        panningRef.current = true
        viewportRef.current?.classList.add("run-gesture")
        setHoveredPoint(null)
        hoveredRef.current = null
        setHighlightKey(null)
      }
      if (panMovedRef.current && startWin) {
        const span = startWin.v1 - startWin.v0
        const n0 = Math.min(Math.max(startWin.v0 - (dx / plotWidth) * span, minTime), maxTime - span)
        setWin([n0, n0 + span])
      }
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      if (panMovedRef.current) {
        panningRef.current = false
        viewportRef.current?.classList.remove("run-gesture")
      } else if (hoveredRef.current && onNavigateToTurn) {
        onNavigateToTurn(hoveredRef.current.turn.turnId, hoveredRef.current.turn.member?.taskId ?? null)
      } else {
        // 原地点击未命中数据点：曲线命中 → 点选聚焦（由灰变亮，再点同线取
        // 消）；空白 → 清除选择
        const vp = viewportRef.current
        if (vp) {
          const rect = vp.getBoundingClientRect()
          const key = findNearestCurve(ev.clientX - rect.left, ev.clientY - rect.top)
          setSelectedKey(prev => (key == null ? null : prev === key ? null : key))
        }
      }
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  // 端标注只画 root（少而稳）+ 高亮类型的峰值线（瞬时辨识）：百级子代理
  // 逐线标注即用户所见的密集重叠源，识别交给图例悬浮与 tooltip
  const lineLabels = (() => {
    const labeled = agentLines.filter(l => l.isRoot && l.points.length >= 2)
    if (activeHighlight != null) {
      const actives = agentLines.filter(l => !l.isRoot && l.groupKey === activeHighlight && l.points.length >= 1)
      if (actives.length > 0) labeled.push(actives.reduce((best, l) => l.peakInput > best.peakInput ? l : best))
    }
    const items = labeled
      .map(line => {
        const lastPt = line.points[line.points.length - 1]
        const estWidth = line.label.length * 6.5 + 14
        const rightSpace = chartWidth - PADDING_RIGHT - lastPt.x
        return {
          sessionId: line.sessionId, groupKey: line.groupKey, label: line.label, color: line.color, isRoot: line.isRoot,
          endX: lastPt.x, endY: lastPt.y, targetY: lastPt.y,
          textAnchor: rightSpace > estWidth + 10 ? "start" as const : "end" as const,
          offsetX: rightSpace > estWidth + 10 ? 6 : -6,
          estWidth,
        }
      })
    const MIN_GAP = 17
    items.sort((a, b) => a.targetY - b.targetY)
    for (let i = 1; i < items.length; i++) {
      if (items[i].targetY - items[i - 1].targetY < MIN_GAP) {
        items[i].targetY = items[i - 1].targetY + MIN_GAP
      }
    }
    for (const item of items) {
      item.targetY = Math.max(PADDING_TOP + 10, Math.min(baselineY - 10, item.targetY))
    }
    return items
  })()

  // 头部摘要：全局统计一行（agent 数/轮次/峰值水位/缓存命中——旧统计卡
  // 网格的信息收敛，逐 agent 深度数据在胶囊详情里渐进披露）
  const summary = (() => {
    const totalTurns = agentStats.reduce((s, a) => s + a.totalTurns, 0)
    const peakAgent = agentStats.reduce((m, a) => (a.peak > m.peak ? a : m), agentStats[0])
    let cacheHit = 0
    let cacheTotal = 0
    for (const s of agentStats) {
      for (const t of s.turns) {
        const it = t.inputMessagesTokens || t.totalTokens
        const cr = t.cacheReadTokens ?? 0
        if (it + cr > 0) { cacheHit += cr; cacheTotal += it + cr }
      }
    }
    return { totalTurns, peakAgent, cachePct: cacheTotal > 0 ? Math.round((cacheHit / cacheTotal) * 100) : 0 }
  })()

  // 当前窗宽相对全程的倍率（工具条读数；全程恒 100%）
  const ratio = win && fullSpan > 0 ? Math.round(fullSpan / Math.max(win[1] - win[0], 1) * 100) : 100

  return (
    <>
    <Card size="sm" className="flex min-h-0 flex-1 flex-col">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle>上下文增长趋势</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {agentStats.length} agents · {summary.totalTurns} 轮次 · 峰值 {formatTokenCount(summary.peakAgent.peak)}（{displayLabel(summary.peakAgent)}）· 缓存命中 {summary.cachePct}%
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* 分段控件：面积/折线 */}
            <div className="inline-flex items-center gap-0.5 rounded-full bg-muted p-0.5" role="group" aria-label="图表模式">
              {(["area", "line"] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={viewMode === m}
                  onClick={() => setViewMode(m)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs transition-all duration-300",
                    viewMode === m ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m === "area" ? "面积" : "折线"}
                </button>
              ))}
            </div>
            {onOpenReplay && (
              <Button variant="outline" size="sm" className="h-7 gap-1.5 rounded-full px-3 text-xs" onClick={onOpenReplay}>
                <PlayIcon className="size-3" />
                回放
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="relative min-h-[380px] flex-1">
          <div
            ref={viewportRef}
            data-viewport="growth"
            className="run-viewport absolute inset-0 overflow-hidden rounded-xl border bg-muted/25"
            onPointerDown={onViewportPointerDown}
            onMouseMove={e => updateHoverRef.current(e.clientX, e.clientY)}
            onMouseLeave={() => { setHoveredPoint(null); hoveredRef.current = null; setHighlightKey(null) }}
          >
              <svg data-chart="growth" width={world.w} height={world.h} viewBox={`0 0 ${world.w} ${world.h}`} className="block">
                <defs>
                  {agentLines.map(line => (
                    <linearGradient key={line.sessionId} id={`areaGrad-${line.sessionId}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={line.color} stopOpacity={0.32} />
                      <stop offset="100%" stopColor={line.color} stopOpacity={0.05} />
                    </linearGradient>
                  ))}
                  <clipPath id="plotClip">
                    <rect x={PADDING_LEFT} y={PADDING_TOP} width={plotWidth} height={plotHeight} />
                  </clipPath>
                </defs>

                {/* 80% 警戒线（虚线弱化）；100% 限制线 + 标签 */}
                {cautionY > PADDING_TOP && cautionY < baselineY && (
                  <line x1={PADDING_LEFT} y1={cautionY} x2={chartWidth - PADDING_RIGHT} y2={cautionY} stroke="#eab308" strokeWidth={1} strokeDasharray="6 4" opacity={0.4} />
                )}

                {/* Context limit line + label */}
                {contextWindowLimit <= yMax && limitY >= PADDING_TOP && (
                  <>
                    <line x1={PADDING_LEFT} y1={limitY} x2={chartWidth - PADDING_RIGHT} y2={limitY} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="8 4" />
                    <text x={PADDING_LEFT + 6} y={limitY - 5} fontSize={9} fill="#ef4444" fontFamily="system-ui, sans-serif">模型限制 {formatTokenCount(contextWindowLimit)}</text>
                  </>
                )}

                {/* Grid lines（仅水平，弱化；基线略实） */}
                {yTicks.map(tick => (
                  <g key={tick.value}>
                    <line x1={PADDING_LEFT} y1={tick.y} x2={chartWidth - PADDING_RIGHT} y2={tick.y} style={{ stroke: "var(--ctx-grid)" }} strokeWidth={tick.value === 0 ? 1 : 0.5} opacity={tick.value === 0 ? 0.9 : 0.5} />
                    <text x={PADDING_LEFT - 5} y={tick.y + 4} textAnchor="end" fontSize={10} style={{ fill: "var(--ctx-tick)" }}>{tick.label}</text>
                  </g>
                ))}

                {/* Right Y-axis: context % markers */}
                {pctMarkers.map(m => (
                  <text key={m.pct} x={chartWidth - PADDING_RIGHT + 5} y={m.y + 4} fontSize={9} fill={m.color} fontFamily="system-ui, sans-serif" fontWeight="bold">{m.label}</text>
                ))}

                {/* X-axis labels（无刻度线，纯标签） */}
                {timeTicks.map((tick, i) => (
                  <text key={i} x={tick.x} y={baselineY + 16} textAnchor="middle" fontSize={9} style={{ fill: "var(--ctx-tick)" }}>{tick.label}</text>
                ))}

                {/* Area fills：root 常显（水位故事），子代理类型高亮时随线浮现 */}
                {viewMode === "area" && agentLines.map(line => {
                  const isActive = activeHighlight === line.groupKey
                  const isWeakened = activeHighlight != null && !isActive
                  if (line.points.length < 2) return null
                  if (!line.isRoot && !isActive) return null
                  return (
                    <g key={`area-${line.sessionId}`} opacity={isWeakened ? 0.06 : isActive ? 1 : line.isRoot ? 0.75 : 0.5} clipPath="url(#plotClip)">
                      <path className="ctx-area-in" d={areaPathStr(line.areaPoints)} fill={`url(#areaGrad-${line.sessionId})`} />
                    </g>
                  )
                })}

                {/* Agent lines：root 主线粗、子代理细线弱透明；逐轮圆点退役（悬浮
                    定位环仍在 tooltip 层），单轮子代理保留一个点——在场可证。
                    组带 plotClip：初始锚点可能在缩放窗左缘之外（初始轮早于窗口） */}
                {agentLines.map(line => {
                  const isActive = activeHighlight === line.groupKey
                  const isWeakened = activeHighlight != null && !isActive
                  const d = line.renderPoints.length >= 2 ? monotonePath(line.renderPoints) : ""
                  return (
                    <g key={line.sessionId} opacity={isWeakened ? 0.12 : 1} clipPath="url(#plotClip)">
                      {d ? (
                        <path
                          d={d}
                          className="ctx-line-draw"
                          pathLength={1}
                          strokeDasharray={1}
                          fill="none"
                          stroke={line.color}
                          strokeWidth={isActive ? 2.75 : line.isRoot ? 2.25 : 1.25}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          opacity={line.isRoot || isActive ? 1 : 0.8}
                        />
                      ) : line.points.length === 1 ? (
                        <circle cx={line.points[0].x} cy={line.points[0].y} r={isActive ? 4 : 3} fill={line.color} opacity={line.isRoot ? 1 : 0.85} />
                      ) : null}
                    </g>
                  )
                })}

                {/* End-of-line labels */}
                {lineLabels.map(l => {
                  const isActive = activeHighlight === l.groupKey
                  const isWeakened = activeHighlight != null && !isActive
                  const bgX = l.textAnchor === "start" ? l.endX + l.offsetX - 4 : l.endX + l.offsetX - l.estWidth + 4
                  const pushed = Math.abs(l.targetY - l.endY) > 5
                  return (
                    <g key={`label-${l.sessionId}`} opacity={isWeakened ? 0.25 : isActive ? 1 : 0.75}>
                      <rect x={bgX} y={l.targetY - 7} width={l.estWidth} height={14} rx={4} fill="var(--ctx-label-bg)" fillOpacity={isActive ? 0.92 : 0.8} stroke={l.color} strokeWidth={isActive ? 1 : 0.5} strokeOpacity={0.35} />
                      <text x={l.endX + l.offsetX} y={l.targetY + 3.5} fontSize={9} textAnchor={l.textAnchor} fill={l.color} fontWeight={l.isRoot ? "600" : "400"} fontFamily="system-ui, sans-serif"
                        onMouseOver={() => setHighlightKey(l.groupKey)} onMouseLeave={() => setHighlightKey(null)}
                        style={{ cursor: "pointer" }}
                      >{l.label}</text>
                      {pushed && (
                        <line x1={l.endX} y1={l.endY} x2={l.endX + (l.textAnchor === "start" ? 3 : -3)} y2={l.targetY} stroke={l.color} strokeWidth={0.5} strokeDasharray="2 2" opacity={0.3} />
                      )}
                    </g>
                  )
                })}

                {/* Compact event markers with context drop annotation */}
                {(() => {
                  // run 视图多 root：各成员的 /compact 标记全画（纵向错位防叠）——仅可见 root，
                  // 且落在当前时间窗内（窗外事件随窗口进出画面）
                  const compactEvts = agentStats
                    .filter(s => s.isRoot && visibleSessions.has(s.sessionId))
                    .flatMap(s => s.events.filter(e => e.type === "compact"))
                    .filter(e => {
                      const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0
                      return ts >= v0 && ts <= v1
                    })
                  if (compactEvts.length === 0) return null
                  const ICON_Y = PADDING_TOP + 5
                  const LABEL_Y = ICON_Y + 16
                  return compactEvts.map((evt, i) => {
                    const compactTs = evt.timestamp ? new Date(evt.timestamp).getTime() : 0
                    const contTs = evt.contTimestamp ? new Date(evt.contTimestamp).getTime() : 0
                    if (!compactTs) return null
                    const xCompact = toXFn(compactTs)
                    const xCont = contTs > 0 ? toXFn(contTs) : xCompact
                    const labelOffsetY = i * 14

                    // Drop annotation: bracket from pre-compact to post-compact context level
                    const dropAnnotation = (() => {
                      const pre = evt.preCompactTokens ?? 0
                      const post = evt.postCompactTokens ?? 0
                      if (pre <= 0 || post <= 0) return null
                      const yPre = toYFn(pre)
                      const yPost = toYFn(post)
                      const dropPct = Math.round((1 - post / pre) * 100)
                      const bracketX = Math.max(xCompact, xCont) + 4
                      return (
                        <g>
                          {/* Vertical bracket showing the drop */}
                          <line x1={bracketX} y1={yPre} x2={bracketX} y2={yPost} stroke="#8b5cf6" strokeWidth={1.5} opacity={0.7} />
                          {/* Horizontal ticks at top and bottom */}
                          <line x1={bracketX - 3} y1={yPre} x2={bracketX + 3} y2={yPre} stroke="#8b5cf6" strokeWidth={1} opacity={0.7} />
                          <line x1={bracketX - 3} y1={yPost} x2={bracketX + 3} y2={yPost} stroke="#8b5cf6" strokeWidth={1} opacity={0.7} />
                          {/* Drop arrow */}
                          <polygon points={`${bracketX},${yPost} ${bracketX - 2},${yPost + 6} ${bracketX + 2},${yPost + 6}`} fill="#8b5cf6" opacity={0.7} transform={`rotate(180, ${bracketX}, ${yPost})`} />
                          {/* Drop label */}
                          <text x={bracketX + 6} y={yPre + 2} fontSize={8} fill="#8b5cf6" textAnchor="start" fontFamily="system-ui, sans-serif">{formatTokenCount(pre)}</text>
                          <text x={bracketX + 6} y={yPost + 2} fontSize={8} fill="#8b5cf6" textAnchor="start" fontFamily="system-ui, sans-serif" fontWeight="bold">↓ {formatTokenCount(post)} (-{dropPct}%)</text>
                        </g>
                      )
                    })()

                    return (
                      <g key={`compact-${i}`} clipPath="url(#plotClip)">
                        {/* Shaded zone between /compact and continuation */}
                        {contTs > 0 && contTs !== compactTs && (
                          <rect x={xCompact} y={PADDING_TOP} width={xCont - xCompact} height={plotHeight} fill="#8b5cf6" opacity={0.06} />
                        )}
                        {/* Dashed line at /compact command */}
                        <line x1={xCompact} y1={PADDING_TOP} x2={xCompact} y2={baselineY} stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="6 3" opacity={0.6} />
                        {/* Thin line at continuation point */}
                        {contTs > 0 && contTs !== compactTs && (
                          <line x1={xCont} y1={PADDING_TOP} x2={xCont} y2={baselineY} stroke="#8b5cf6" strokeWidth={1} strokeDasharray="3 3" opacity={0.4} />
                        )}
                        {/* Icon badge */}
                        <rect x={xCompact - 5} y={ICON_Y} width={10} height={12} rx={2} fill="#8b5cf6" opacity={0.9} />
                        <text x={xCompact} y={ICON_Y + 9} fontSize={7} fill="white" textAnchor="middle" fontWeight="bold" fontFamily="system-ui, sans-serif">⚡</text>
                        {/* Label */}
                        <text x={xCompact + 8} y={LABEL_Y + labelOffsetY} fontSize={8} fill="#8b5cf6" textAnchor="start" fontFamily="system-ui, sans-serif">{evt.note}</text>
                        {/* Drop annotation */}
                        {dropAnnotation}
                      </g>
                    )
                  }).filter(Boolean)
                })()}

                {/* 空窗提示（缩放/平移到无轮次的时间段） */}
                {emptyWin && (
                  <text x={PADDING_LEFT + plotWidth / 2} y={PADDING_TOP + plotHeight / 2} textAnchor="middle" fontSize={10} style={{ fill: "var(--ctx-tick)" }}>该时间窗内无轮次</text>
                )}

                {/* Crosshair + 悬浮点定位环（tooltip 本体是 HTML 层） */}
                {hoveredPoint && (
                  <g style={{ pointerEvents: "none" }}>
                    <line x1={hoveredPoint.x} y1={PADDING_TOP} x2={hoveredPoint.x} y2={baselineY} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} clipPath="url(#plotClip)" />
                    <line x1={PADDING_LEFT} y1={hoveredPoint.y} x2={chartWidth - PADDING_RIGHT} y2={hoveredPoint.y} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" opacity={0.5} clipPath="url(#plotClip)" />
                    <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r={7} fill="none" stroke={hoveredPoint.color} strokeWidth={2.5} opacity={0.8} />
                    <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r={3} fill={hoveredPoint.color} opacity={0.6} />
                  </g>
                )}


              </svg>

            {/* HTML 悬浮层：恒定像素尺寸（图框恒定，此处为 HTML 覆盖层的天然
                语义）、点位右侧 + 右缘自动翻左（不遮被检曲线）、主题化卡片样式
                （Grafana/Recharts 同款交互形态） */}
            {hoveredPoint && (() => {
              const tt = hoveredPoint
              const inputTotal = tt.turn.inputTokens + tt.turn.cacheReadTokens + tt.turn.cacheWriteTokens
              const cachePct = inputTotal > 0 ? tt.cacheRead / inputTotal * 100 : 0
              const newInputPct = inputTotal > 0 ? tt.newInput / inputTotal * 100 : 0
              const cacheWritePct = inputTotal > 0 ? tt.cacheWrite / inputTotal * 100 : 0
              const agentLimit = limitBySid.get(tt.sessionId) ?? contextWindowLimit
              const ctxPct = tt.contextWindowPct ?? (inputTotal / agentLimit * 100)
              const ctxPctDisplay = tt.contextWindowPct != null ? `${tt.contextWindowPct.toFixed(1)}%` : `≈${ctxPct.toFixed(1)}%`
              const ctxFillPct = Math.min(Math.max(ctxPct / 100, 0), 1)
              const ctxBarColor = ctxPct < 50 ? "#22c55e" : ctxPct < 80 ? "#eab308" : "#ef4444"

              // 视口坐标在悬浮命中时已快照（相机变换后的点位 + 视口尺寸）：
              // 右侧放置 + 右缘自动翻左 + 上下钳制，不遮被检曲线与数据点
              const TT_W = 270
              const TT_H = 170
              const { x: px, y: py, vpW, vpH } = tt.screen
              const flip = px + 16 + TT_W > vpW - 4
              const left = Math.max(4, Math.min(flip ? px - 16 - TT_W : px + 16, vpW - TT_W - 4))
              const top = Math.max(4, Math.min(py - TT_H / 2, vpH - TT_H - 4))

              return (
                <div
                  data-tooltip="growth"
                  className="pointer-events-none absolute z-10 w-[270px] rounded-lg border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur-sm"
                  style={{ left, top }}
                >
                  <div className="flex items-center justify-between gap-2 border-b pb-1.5">
                    <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
                      <span className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: tt.color }} />
                      <span className="truncate">{tt.label} #{tt.turnIndex}</span>
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{tt.time}</span>
                  </div>

                  {tt.isBirth ? (
                    /* 初始轮（0-token 派发消息）：无 token 计量段——细节 =
                       消息本体摘要；点击可跳转该 user 轮 */
                    <div className="space-y-1.5 pt-2">
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">初始轮</span>
                        <span className="text-muted-foreground">上下文自此生长{tt.turn.role === "user" ? " · 派发消息" : ""}</span>
                      </div>
                      {tt.turn.contentSummary && (
                        <p className="line-clamp-3 rounded-md border-l-2 border-border bg-muted/50 px-2 py-1 text-[10px] leading-relaxed text-muted-foreground">
                          {tt.turn.contentSummary}
                        </p>
                      )}
                      <p className="text-[10px] text-muted-foreground">此轮无 token 计量 · 消息全文见 Turns</p>
                    </div>
                  ) : (
                    <>
                      <div className="pt-2">
                        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
                          <div className="h-full bg-amber-500" style={{ width: `${cachePct}%` }} />
                          <div className="h-full bg-blue-500" style={{ width: `${newInputPct}%` }} />
                          {cacheWritePct > 0 && <div className="h-full bg-orange-500" style={{ width: `${cacheWritePct}%` }} />}
                        </div>
                        <div className="flex items-center gap-3 pt-1 text-[10px]">
                          <span className="text-amber-600 dark:text-amber-400">Cache {cachePct.toFixed(0)}%</span>
                          <span className="text-blue-600 dark:text-blue-400">Input {newInputPct.toFixed(0)}%</span>
                          {cacheWritePct > 0 && <span className="text-orange-600 dark:text-orange-400">CW {cacheWritePct.toFixed(0)}%</span>}
                        </div>
                      </div>

                      <div className="pt-2">
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>窗口占比（限 {formatTokenCount(agentLimit)}）</span>
                          <span style={{ color: ctxBarColor }}>{ctxPctDisplay}</span>
                        </div>
                        <div className="mt-1 h-1.5 w-full rounded-full bg-muted">
                          <div className="h-full rounded-full" style={{ width: `${ctxFillPct * 100}%`, backgroundColor: ctxBarColor }} />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 pt-2 text-[11px] text-muted-foreground">
                        <span>总量 <span className="font-medium text-foreground">{formatTokenCount(tt.tokens)}</span></span>
                        <span>输入 <span className="font-medium text-foreground">{formatTokenCount(inputTotal)}</span></span>
                        <span>新输入 <span className="font-medium text-foreground">{formatTokenCount(tt.newInput)}</span></span>
                        <span>输出 <span className="font-medium text-foreground">{formatTokenCount(tt.turn.outputTokens)}</span></span>
                      </div>
                    </>
                  )}

                  <div className="pt-1.5 text-[10px] text-muted-foreground">
                    {tt.turn.model ?? "—"} · {tt.turn.role} · 点击图区跳转该轮
                  </div>
                </div>
              )
            })()}
          </div>

          {/* 画布内快捷显隐（玻璃分段控件，与右下缩放工具条对仗）：全部 / 仅 Root */}
        <div data-quick-filter role="group" aria-label="显隐快捷" className="run-glass absolute top-3 left-3 flex items-center gap-0.5 rounded-full p-0.5">
          <button
            type="button"
            onClick={() => setVisibleSessions(new Set(agentStats.map(s => s.sessionId)))}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs transition-all duration-300",
              visibleSessions.size === agentStats.length
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            全部
          </button>
          <button
            type="button"
            onClick={() => setVisibleSessions(new Set(agentStats.filter(s => s.isRoot).map(s => s.sessionId)))}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs transition-all duration-300",
              visibleSessions.size > 0 && agentStats.every(s => s.isRoot === visibleSessions.has(s.sessionId))
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            仅 Root
          </button>
          {agentStats.length > INLINE_GROUPS_MAX && (
            <button
              type="button"
              data-quick-top
              onClick={() => setVisibleSessions(new Set(topKSessionIds))}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs transition-all duration-300",
                topKActive
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {`峰值 Top${FOCUS_TOP_K}`}
            </button>
          )}
        </div>

        {/* 玻璃工具条（Perf 同款浮层 chrome）：时间窗缩放/平移/适配全程 */}
          <div className="run-glass absolute right-3 bottom-3 flex items-center rounded-xl">
            <button
              type="button" title="缩小（Ctrl + 滚轮）" aria-label="缩小"
              onClick={() => zoomAt(1 / 1.15)}
              className="run-tool-btn flex size-7 items-center justify-center text-[#57606a] hover:bg-black/[0.05] hover:text-[#1f2328]"
            >
              <ZoomOutIcon className="size-3.5" />
            </button>
            <span
              data-zoom-label title="当前时间窗倍率"
              className="w-11 text-center text-[11px] tabular-nums text-[#57606a]"
            >{ratio}%</span>
            <button
              type="button" title="放大（Ctrl + 滚轮）" aria-label="放大"
              onClick={() => zoomAt(1.15)}
              className="run-tool-btn flex size-7 items-center justify-center text-[#57606a] hover:bg-black/[0.05] hover:text-[#1f2328]"
            >
              <ZoomInIcon className="size-3.5" />
            </button>
            <span className="h-3.5 w-px bg-black/10" aria-hidden />
            <button
              type="button" title="适配全程" aria-label="适配全程" data-zoom-fit
              onClick={() => setWin(null)}
              className="run-tool-btn flex size-7 items-center justify-center text-[#57606a] hover:bg-black/[0.05] hover:text-[#1f2328]"
            >
              <MaximizeIcon className="size-3.5" />
            </button>
          </div>
        </div>

        {/* 图例胶囊（纯图例职责）：色点/×N；点击整组显隐、悬停联动高亮、chevron
            展开组详情弹窗——数字（趋势小图/概览卡/组成/事件/缓存）全归弹窗，
            曲线归形状。大 run（组数超阈值）：行首搜索（按名过滤）+ 折叠区
            （预览前 N，可见组前置）+ 展开限高滚动 */}
        <div className="flex shrink-0 flex-col gap-1.5">
          {legendBig && (
            <div className="flex items-center gap-2">
              <input
                data-legend-search
                value={legendQuery}
                onChange={e => setLegendQuery(e.target.value)}
                placeholder="搜索成员 / 类型…"
                className="h-7 w-44 shrink-0 rounded-full border border-border bg-background px-3 text-xs outline-none placeholder:text-muted-foreground/60 focus:ring-1 focus:ring-foreground/20"
              />
              {legendQueryLower && (
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{matchedGroups.length}/{groups.length}</span>
              )}
              {legendExpanded && !legendQueryLower && (
                <button
                  type="button"
                  onClick={() => setLegendExpanded(false)}
                  className="shrink-0 rounded-full px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                >收起</button>
              )}
            </div>
          )}
          <ScrollFade className={cn("flex flex-wrap items-center gap-1.5", legendBig && legendShowAll && "max-h-40 overflow-y-auto")}>
            {shownGroups.map(g => {
            const on = g.visibleCount > 0
            return (
              <span
                key={g.key}
                className={cn(
                  // 胶囊常亮（不随图中悬浮/点选亮起——图选只在图内表达）；
                  // 隐藏组淡出是显隐语义，保留
                  "ctx-chip inline-flex items-stretch overflow-hidden rounded-full border border-border",
                  !on && "opacity-45",
                )}
              >
                <label
                  data-legend={g.label}
                  className="flex cursor-pointer select-none items-center gap-1.5 py-1 pr-1.5 pl-2 text-xs"
                  onMouseOver={() => setHighlightKey(g.key)}
                  onMouseLeave={() => setHighlightKey(null)}
                >
                  <input
                    type="checkbox" className="sr-only" checked={on}
                    onChange={() => {
                      setVisibleSessions(prev => {
                        const next = new Set(prev)
                        if (on) g.sessionIds.forEach(id => next.delete(id))
                        else g.sessionIds.forEach(id => next.add(id))
                        return next
                      })
                    }}
                  />
                  <span className="size-2 shrink-0 rounded-full transition-colors" style={{ backgroundColor: on ? g.color : "#cbd5e1" }} />
                  <span className={cn("max-w-44 truncate", on ? "font-medium" : "text-muted-foreground")}>{g.label}</span>
                  {g.kind === "type" && <span className="text-muted-foreground">×{g.count}</span>}
                </label>
                <button
                  type="button" title="组详情" aria-label={g.label + " 详情"}
                  onClick={() => { setDetailKey(prev => prev === g.key ? null : g.key); setDetailSid(null) }}
                  className={cn(
                    "flex items-center border-l border-border/60 px-1.5 text-muted-foreground/60 transition-colors hover:text-foreground",
                    detailKey === g.key && "text-foreground",
                  )}
                >
                  <ChevronRightIcon className={cn("size-3 transition-transform duration-300", detailKey === g.key && "rotate-90")} />
                </button>
              </span>
            )
          })}
            {legendBig && !legendShowAll && matchedGroups.length > COLLAPSED_PILLS && (
              <button
                type="button"
                data-legend-expand
                onClick={() => setLegendExpanded(true)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >{`+${matchedGroups.length - COLLAPSED_PILLS}`}</button>
            )}
          </ScrollFade>
        </div>
      </CardContent>
    </Card>

    {/* 组详情（第四层）——右侧滑出弹窗 = 该 agent 的上下文档案：胶囊
        chevron 是唯一入口（默认选中峰值最高实例，实例清单行即切换器）。
        档案结构：身份行 → 关键四数（峰值/水位/增速/缓存命中）→ 增长趋势
        小图 → 风险时刻（/compact 落差 + 越限警告，无则隐去）→ 缓存效率
        （峰值轮构成 + 命中/节省/倍数）→ → Turns */}

    <AgentDetailDialog
      open={detailKey != null}
      onOpenChange={o => { if (!o) { setDetailKey(null); setDetailSid(null) } }}
      group={groups.find(x => x.key === detailKey) ?? null}
      agentStats={agentStats}
      selectedSid={detailSid}
      onSelectSid={setDetailSid}
      displayLabel={displayLabel}
      actors={actors}
      onNavigateToTurn={onNavigateToTurn}
    />
    </>
  )
}

/** 详情弹窗内的独立增长趋势小图：逐轮轴（agent 自身轮序，非全局时间轴——
 *  单 agent 的增长故事按轮读最直观），y = 实际输入（含缓存读），底部琥珀
 *  带为缓存读份额；曲线自初始锚（0-token 派发轮）从 0 生长——初始轮占
 *  独立槽位，无独立初始轮时锚在首数据轮处（零宽 riser）；80%/100% 上下文
 *  窗口参考线 + /compact 标记 + 关键事件点；多实例组以灰线同框对比形态。
 *  静态图（无缩放——聚焦单 agent 不需要窗口操作，主图的窗口交互在趋势卡上） */
const TREND_W = 560
const TREND_H = 220
const TREND_PAD_L = 46
const TREND_PAD_R = 14
const TREND_PAD_T = 14
const TREND_PAD_B = 20

const TREND_EVENT_COLORS: Record<string, string> = {
  start: "#22c55e", growth: "#3b82f6", peak: "#eab308", warning: "#ef4444", compact: "#a855f7", end: "#94a3b8",
}

function AgentTrendChart({ stats, color, peers }: { stats: AgentStats; color: string; peers: AgentStats[] }) {
  const plotW = TREND_W - TREND_PAD_L - TREND_PAD_R
  const plotH = TREND_H - TREND_PAD_T - TREND_PAD_B
  const baselineY = TREND_H - TREND_PAD_B

  // 时间序（缺失回落原序）：agent 自身轮序即 x 轴
  const turns = useMemo(() => {
    const arr = stats.turns.map((t, i) => ({ t, i }))
    arr.sort((a, b) => {
      const ta = a.t.createdAt ? new Date(a.t.createdAt).getTime() : a.i
      const tb = b.t.createdAt ? new Date(b.t.createdAt).getTime() : b.i
      return (ta - tb) || (a.i - b.i)
    })
    return arr.map(({ t }) => t)
  }, [stats])
  // 初始锚点：context 从 0 生长——初始轮（0-token 派发消息，独立轮号/时刻）
  // 在轴上占自己的槽位；初始轮即首数据轮（无 0-token 轮）时锚与首数据轮
  // 同 x——零宽 riser（monotonePath 零宽段直线跳转）。数据轮槽位统一后移
  const anchorTurn = stats.birth && !turns.includes(stats.birth) ? stats.birth : null
  const dataAt = anchorTurn ? 1 : 0
  const slots = anchorTurn ? [anchorTurn, ...turns] : turns
  const n = slots.length
  const yOf = (t: TurnRowItem) => t.inputMessagesTokens || t.totalTokens
  const peak = Math.max(...turns.map(yOf), 1)
  // y 量程与主图同式（可见峰值 1.15 余量整步上取，钳窗口 1.1 倍——逼近时
  // 100% 参考线可及）
  const yMax = Math.min(Math.ceil(peak * 1.15 / 10000) * 10000, stats.contextLimit * 1.1)
  const xAt = (i: number) => TREND_PAD_L + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const yAt = (v: number) => TREND_PAD_T + plotH - (Math.min(v, yMax) / yMax) * plotH

  // 渲染点：初始锚在槽 0（y=0 基线，缓存份额 0；真实初始轮 yOf 亦为 0）
  const points = [
    { x: xAt(0), y: yAt(0), cache: 0 },
    ...turns.map((t, i) => ({ x: xAt(i + dataAt), y: yAt(yOf(t)), cache: Math.min(t.cacheReadTokens ?? 0, yOf(t)) })),
  ]
  const renderPoints = turns.length > 160 ? lttb(points, 140) : points

  const yTicks = (() => {
    const raw = yMax / 4
    const mag = Math.pow(10, Math.floor(Math.log10(raw)))
    const norm = raw / mag
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
    const ticks: Array<{ y: number; label: string }> = []
    for (let v = 0; v <= yMax; v += step) ticks.push({ y: yAt(v), label: formatTokenCount(v) })
    return ticks
  })()

  const xTicks = (() => {
    if (n <= 1) return [{ x: xAt(0), label: `#${slots[0]?.turnIndex ?? 0}` }]
    const target = Math.min(5, n - 1)
    const ticks: Array<{ x: number; label: string }> = []
    const seen = new Set<number>()
    for (let k = 0; k <= target; k++) {
      const idx = Math.round((k * (n - 1)) / target)
      if (seen.has(idx)) continue
      seen.add(idx)
      ticks.push({ x: xAt(idx), label: `#${slots[idx].turnIndex}` })
    }
    return ticks
  })()

  // 事件点位：turnIndex 直配（start/growth/peak/warning/end 出自 stats 轮）；
  // /compact 命令轮常 0 token 不在 stats 轮里，回落时间序首个 ≥ 命令时刻的
  // 轮。槽位 = 数据序 + 初始锚占位数（anchorTurn 时 dataAt=1）
  const posOfTurnIndex = new Map<number, number>()
  turns.forEach((t, i) => { if (!posOfTurnIndex.has(t.turnIndex)) posOfTurnIndex.set(t.turnIndex, i + dataAt) })
  const evtPos = (evt: ContextEvent): number | null => {
    const direct = posOfTurnIndex.get(evt.turnIndex)
    if (direct != null) return direct
    if (!evt.timestamp) return null
    const ts = new Date(evt.timestamp).getTime()
    for (let i = 0; i < turns.length; i++) {
      const at = turns[i].createdAt
      if (at && new Date(at).getTime() >= ts) return i + dataAt
    }
    return turns.length - 1 + dataAt
  }
  const markers = stats.events
    .map(evt => ({ evt, i: evtPos(evt) }))
    .filter((m): m is { evt: ContextEvent; i: number } => m.i != null)

  const limitY = yAt(stats.contextLimit)
  const cautionY = yAt(stats.contextLimit * 0.8)
  const showLimit = stats.contextLimit <= yMax * 1.05

  // 对比实例（灰线）：同管线（时间序 + LTTB + 初始锚——灰线也从 0 生长），
  // 无标签无事件——形态对比；单轮实例画 riser（与选中实例口径一致）。
  // y 计算内联（yAt 是每渲染新建闭包，进依赖数组会击穿 memo；量程只随
  // stats/peers 变化）
  const peerLines = useMemo(() => peers.map(p => {
    const arr = p.turns.map((t, i) => ({ t, i }))
    arr.sort((a, b) => {
      const ta = a.t.createdAt ? new Date(a.t.createdAt).getTime() : a.i
      const tb = b.t.createdAt ? new Date(b.t.createdAt).getTime() : b.i
      return (ta - tb) || (a.i - b.i)
    })
    const pn = arr.length
    const pts = [
      { x: TREND_PAD_L, y: TREND_PAD_T + plotH },
      ...arr.map(({ t }, i) => ({
        x: TREND_PAD_L + ((i + 1) / pn) * plotW,
        y: TREND_PAD_T + plotH - (Math.min(yOf(t), yMax) / yMax) * plotH,
      })),
    ]
    return { sessionId: p.sessionId, d: monotonePath(pts.length > 161 ? lttb(pts, 140) : pts) }
  }).filter((x): x is { sessionId: string; d: string } => x != null), [peers, plotW, plotH, yMax])

  // 数据轮 ≥ 1 即有轨迹（初始锚 + 数据点 ≥ 2 点）——riser 也是增长故事
  const lineD = monotonePath(renderPoints)
  const areaD = monotonePath(renderPoints)
  const cacheD = monotonePath(renderPoints.map(p => ({ x: p.x, y: TREND_PAD_T + plotH - (p.cache / yMax) * plotH })))

  return (
    <div className="rounded-xl border bg-card p-2">
      <svg data-chart="agent-trend" viewBox={`0 0 ${TREND_W} ${TREND_H}`} width="100%" role="img" aria-label="上下文增长趋势" className="block">
        {/* 网格 + y 刻度 */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line x1={TREND_PAD_L} y1={tick.y} x2={TREND_W - TREND_PAD_R} y2={tick.y} stroke="currentColor" strokeOpacity={0.06} />
            <text x={TREND_PAD_L - 6} y={tick.y + 3} fontSize={9} textAnchor="end" fill="currentColor" fillOpacity={0.5}>{tick.label}</text>
          </g>
        ))}
        {/* x 刻度（agent 自身轮序，标全局轮号——与关键事件行 #N 对位） */}
        {xTicks.map((tick, i) => (
          <text key={i} x={tick.x} y={baselineY + 14} fontSize={9} textAnchor="middle" fill="currentColor" fillOpacity={0.5}>{tick.label}</text>
        ))}
        <line x1={TREND_PAD_L} y1={baselineY} x2={TREND_W - TREND_PAD_R} y2={baselineY} stroke="currentColor" strokeOpacity={0.15} />

        {/* 上下文窗口参考线（该 agent 精确限） */}
        {showLimit && (
          <>
            <line x1={TREND_PAD_L} y1={limitY} x2={TREND_W - TREND_PAD_R} y2={limitY} stroke="#ef4444" strokeWidth={1} strokeDasharray="5 4" opacity={0.65} />
            <text x={TREND_W - TREND_PAD_R} y={limitY - 4} fontSize={9} textAnchor="end" fill="#ef4444" opacity={0.8}>100%</text>
            <line x1={TREND_PAD_L} y1={cautionY} x2={TREND_W - TREND_PAD_R} y2={cautionY} stroke="#eab308" strokeWidth={1} strokeDasharray="5 4" opacity={0.5} />
            <text x={TREND_W - TREND_PAD_R} y={cautionY - 4} fontSize={9} textAnchor="end" fill="#eab308" opacity={0.75}>80%</text>
          </>
        )}

        {/* 对比实例（组内其他实例，灰线形态对比） */}
        {peerLines.map(p => (
          <path key={p.sessionId} d={p.d} fill="none" stroke="#94a3b8" strokeWidth={1} opacity={0.35} />
        ))}

        {/* 缓存读份额（底部琥珀带）：曲线下沿到缓存份额的堆叠带（数据轮
            ≥1 即有——初始锚也是轨迹的一部分） */}
        <>
          <path d={`${cacheD} L ${renderPoints[renderPoints.length - 1].x} ${baselineY} L ${renderPoints[0].x} ${baselineY} Z`} fill="#eab308" opacity={0.18} />
          <path d={`${areaD} L ${renderPoints[renderPoints.length - 1].x} ${baselineY} L ${renderPoints[0].x} ${baselineY} Z`} fill={color} opacity={0.12} />
          <path d={lineD} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </>
        {turns.length === 1 && (
          <circle cx={xAt(dataAt)} cy={yAt(yOf(turns[0]))} r={4} fill={color} />
        )}

        {/* /compact 标记（纵虚线 + ⚡）与关键事件点 */}
        {markers.map((m, i) => {
          const x = xAt(m.i)
          const c = TREND_EVENT_COLORS[m.evt.type] ?? "#94a3b8"
          if (m.evt.type === "compact") {
            return (
              <g key={`mk-${i}`}>
                <line x1={x} y1={TREND_PAD_T} x2={x} y2={baselineY} stroke={c} strokeWidth={1} strokeDasharray="3 3" opacity={0.55} />
                <text x={x} y={TREND_PAD_T - 3} fontSize={9} textAnchor="middle" fill={c}>⚡</text>
              </g>
            )
          }
          const y = yAt(yOf(slots[m.i]))
          return <circle key={`mk-${i}`} cx={x} cy={y} r={m.evt.type === "peak" || m.evt.type === "warning" ? 3.5 : 2.5} fill={c} opacity={0.9} />
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 pt-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-sm" style={{ backgroundColor: color, opacity: 0.6 }} />实际输入</span>
        <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-sm bg-yellow-500/40" />缓存读份额</span>
        {showLimit && <span className="flex items-center gap-1"><span className="inline-block h-0 w-3 border-t border-dashed border-red-500" />窗口上限</span>}
      </div>
    </div>
  )
}

/** 组详情弹窗（右侧滑出抽屉）= 该 agent 的上下文档案：胶囊 chevron 是唯一
 *  入口。自上而下：身份行（组名 + root/subagent/派发徽标 + 轮次；多实例组
 *  附 Σ 摘要与实例清单——行即切换器）→ 关键四数（峰值 / 窗口水位 / 增速 /
 *  缓存命中——一次扫读拿全档案骨架）→ 增长趋势小图（逐轮轴 + 缓存份额带 +
 *  窗口参考线 + /compact 标记，多实例组灰线同框）→ 风险时刻胶囊（只留
 *  /compact 落差与越限警告——背景事件曲线已表达，无风险整节隐去）→ 缓存
 *  效率卡（峰值轮构成 = 命中率的解释面 + 命中/节省/无缓存倍数）→ → Turns */
function AgentDetailDialog({ open, onOpenChange, group, agentStats, selectedSid, onSelectSid, displayLabel, actors, onNavigateToTurn }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  group: LegendGroup | null
  agentStats: AgentStats[]
  selectedSid: string | null
  onSelectSid: (sid: string) => void
  displayLabel: (s: AgentStats) => string
  actors: Map<string, RunActor>
  onNavigateToTurn?: (turnId: string, memberTaskId?: string | null) => void
}) {
  const members = useMemo(
    () => (group ? agentStats.filter(s => group.sessionIds.includes(s.sessionId)).sort((a, b) => b.peak - a.peak) : []),
    [group, agentStats],
  )
  const sel = members.find(m => m.sessionId === selectedSid) ?? members[0] ?? null
  const sumTurns = members.reduce((s, m) => s + m.totalTurns, 0)
  const sumPeak = members.reduce((s, m) => s + m.peak, 0)
  const sumSaved = members.reduce((s, m) => s + m.turns.reduce((x, t) => x + (t.cacheReadTokens ?? 0), 0), 0)

  const body = (() => {
    if (!group || !sel) return null
    const actor = actors.get(sel.sessionId)
    const winPct = sel.maxContextWindowPct
    const winColor = winPct > 80 ? "#ef4444" : winPct > 50 ? "#eab308" : undefined

    const peakTurn = sel.turns.reduce((max, t) => t.totalTokens > max.totalTokens ? t : max, sel.turns[0])
    const peakCacheRead = peakTurn.cacheReadTokens ?? 0
    const peakRealInput = peakTurn.inputTokens + peakTurn.cacheReadTokens + peakTurn.cacheWriteTokens
    const peakNewInput = peakTurn.inputTokens
    const peakCachePct = peakRealInput > 0 ? (peakCacheRead / peakRealInput * 100) : 0
    const totalSaved = sel.turns.reduce((s, t) => s + (t.cacheReadTokens ?? 0), 0)
    const totalInput = sel.turns.reduce((s, t) => s + t.totalTokens, 0)

    // 风险时刻只留可操作项（/compact 落差 + 越限警告）；start/growth/peak/end
    // 是背景信息（曲线已表达），不占阅读带宽
    const riskEvents = sel.events.filter(e => e.type === "compact" || e.type === "warning")

    return (
      <ScrollFade className="flex-1 space-y-2.5 overflow-y-auto p-4 pt-9">
        {/* 头：身份一行——组名 + 归属徽标（root/subagent、派发出处）+ 轮次；
            Σ 摘要仅多实例组 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: group.color }} />
          <span className="text-sm font-semibold">{group.label}</span>
          <Badge variant="outline" className="text-[10px]">{sel.isRoot ? "root" : "subagent"}</Badge>
          {!sel.isRoot && actor?.nameSource === "step" && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">派发</Badge>
          )}
          {members.length > 1 && <Badge variant="outline" className="text-[10px]">{members.length} 个实例</Badge>}
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{sel.totalTurns} 轮</span>
        </div>
        {members.length > 1 && (
          <div className="text-xs text-muted-foreground">Σ {sumTurns} 轮 · Σ 峰值 {formatTokenCount(sumPeak)} · Σ 缓存节省 {formatTokenCount(sumSaved)}</div>
        )}

        {/* 实例清单（多实例组）：行即切换器——先选实例，再看档案 */}
        {members.length > 1 && (
          <div data-agent-instances className="space-y-1">
            {members.map(m => {
              const mWinPct = m.maxContextWindowPct
              const mBarColor = mWinPct > 80 ? "#ef4444" : mWinPct > 50 ? "#eab308" : "#22c55e"
              return (
                <button
                  key={m.sessionId} type="button"
                  onClick={() => onSelectSid(m.sessionId)}
                  className={cn(
                    "flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-1.5 text-left text-xs transition-colors",
                    m.sessionId === sel.sessionId ? "border-foreground/25 bg-accent/50" : "hover:bg-accent/40",
                  )}
                >
                  <span className="font-medium whitespace-nowrap">{displayLabel(m)}</span>
                  {m.memberTaskId && <Badge variant="slate" className="text-xs">{m.memberLabel ?? m.memberTaskId}</Badge>}
                  <span className="text-muted-foreground tabular-nums">{m.totalTurns} 轮</span>
                  <span className="text-muted-foreground tabular-nums">峰值 {formatTokenCount(m.peak)}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full rounded-full" style={{ width: `${Math.min(100, Math.max(2, mWinPct))}%`, backgroundColor: mBarColor }} />
                    </span>
                    <span className="w-9 text-right tabular-nums text-muted-foreground">{mWinPct.toFixed(0)}%</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {/* 关键四数：峰值 / 窗口水位（Context 风险主指标，水位着色）/ 增速
            （逼近窗口的速度）/ 缓存命中 */}
        <div data-agent-stats className="grid grid-cols-4 divide-x divide-border rounded-lg border bg-muted/30 text-center">
          <div className="px-1.5 py-1.5">
            <div className="text-[10px] text-muted-foreground">峰值</div>
            <div className="text-sm font-semibold tabular-nums">{formatTokenCount(sel.peak)}</div>
          </div>
          <div className="px-1.5 py-1.5">
            <div className="text-[10px] text-muted-foreground">窗口水位</div>
            <div className="text-sm font-semibold tabular-nums" style={winColor ? { color: winColor } : undefined}>
              {winPct > 0 ? `${winPct.toFixed(1)}%` : "—"}
            </div>
          </div>
          <div className="px-1.5 py-1.5">
            <div className="text-[10px] text-muted-foreground">增速</div>
            <div className="text-sm font-semibold tabular-nums">
              {formatTokenCount(sel.avgGrowthPerTurn)}<span className="text-[10px] font-normal text-muted-foreground">/轮</span>
            </div>
          </div>
          <div className="px-1.5 py-1.5">
            <div className="text-[10px] text-muted-foreground">缓存命中</div>
            <div className="text-sm font-semibold tabular-nums">{(sel.cacheHitRate * 100).toFixed(0)}%</div>
          </div>
        </div>

        {/* 增长趋势（逐轮） */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>增长趋势（逐轮）</span>
            {members.length > 1 && <span>灰线 = 组内其他实例</span>}
          </div>
          <AgentTrendChart stats={sel} color={group.color} peers={members.filter(m => m.sessionId !== sel.sessionId)} />
        </div>

        {/* 风险时刻：/compact 落差（pre→post ↓%）与越限警告；无风险即整节隐去 */}
        {riskEvents.length > 0 && (
          <div data-agent-events className="flex flex-wrap gap-1.5">
            {riskEvents.map((evt, i) => {
              if (evt.type === "compact") {
                const pre = evt.preCompactTokens ?? 0
                const post = evt.postCompactTokens ?? 0
                const drop = pre > 0 && post > 0 ? Math.round((1 - post / pre) * 100) : 0
                return (
                  <span
                    key={i} data-agent-event="compact" title={evt.note}
                    className="inline-flex items-center gap-1.5 rounded-md border border-purple-500/30 bg-purple-500/10 px-2 py-1 text-xs tabular-nums text-purple-600 dark:text-purple-400"
                  >
                    <span>⚡</span>
                    <span className="font-mono text-[10px]">#{evt.turnIndex}</span>
                    <span>{pre > 0 && post > 0 ? `${formatTokenCount(pre)}→${formatTokenCount(post)} ↓-${drop}%` : "/compact"}</span>
                  </span>
                )
              }
              return (
                <span
                  key={i} data-agent-event="warning"
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs tabular-nums text-red-600 dark:text-red-400"
                >
                  <span>⚠️</span>
                  <span className="font-mono text-[10px]">#{evt.turnIndex}</span>
                  <span>{evt.note}</span>
                </span>
              )
            })}
          </div>
        )}

        {/* 缓存效率：峰值轮构成（缓存读 vs 新输入——命中率的解释面）+ 全程三数 */}
        <div data-cache-card className="space-y-1.5 rounded-lg border p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">缓存效率</span>
            <span className="text-[10px] text-muted-foreground">峰值轮 #{peakTurn.turnIndex} 构成</span>
          </div>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-yellow-500" style={{ width: `${peakCachePct}%` }} />
            <div className="h-full bg-blue-500" style={{ width: `${100 - peakCachePct}%`, minWidth: peakCachePct < 100 ? "2px" : "0" }} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums">
            <span className="text-yellow-600 dark:text-yellow-400">缓存读 {formatTokenCount(peakCacheRead)}（{peakCachePct.toFixed(0)}%）</span>
            <span className="text-blue-600 dark:text-blue-400">新输入 {formatTokenCount(Math.max(peakNewInput, 0))}（{(100 - peakCachePct).toFixed(0)}%）</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t pt-1.5 text-xs tabular-nums text-muted-foreground">
            <span>命中 <span className="font-medium text-foreground">{(sel.cacheHitRate * 100).toFixed(0)}%</span></span>
            <span>节省 <span className="font-medium text-foreground">{formatTokenCount(totalSaved)}</span></span>
            <span>无缓存消耗 <span className="font-medium text-foreground">×{totalInput > 0 ? ((totalSaved + totalInput) / totalInput).toFixed(1) : "1"}</span></span>
          </div>
        </div>

        {/* 动作：跳转该 agent 的 Turns */}
        {onNavigateToTurn && (
          <div className="flex justify-end">
            <Button
              variant="outline" size="sm" className="h-6 text-xs"
              onClick={() => onNavigateToTurn(sel.turns[0].turnId, sel.memberTaskId)}
            >
              → Turns
            </Button>
          </div>
        )}
      </ScrollFade>
    )
  })()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent side="right" data-agent-detail className="flex max-w-full flex-col gap-0 p-0 sm:max-w-[620px]">
        <DialogTitle className="sr-only">Agent 上下文档案</DialogTitle>
        <DialogDescription className="sr-only">增长趋势、窗口水位与缓存效率</DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  )
}
