"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { useState, useMemo, useEffect, useRef } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { buildRunActors, subagentBaseNameOf, type RunActor } from "@/components/observe/run-actor"
import { fallbackAgentDisplayName, mainAgentDisplayName } from "@/components/observe/agent-display-name"
import type { TurnRowItem } from "@/components/observe/ContextTracker"
import { contextAgentKeyOf, contextColorMapOf, contextLegendKeyOf } from "@/components/observe/context-legend"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

function formatTokenCount(n: number): string {
  if (n === 0) return "0"
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return `${n}`
}

interface AgentTimeline {
  sessionId: string
  agentName: string
  isRoot: boolean
  /** root 道名（run 视图成员短名，与泳道/ContextTracker 同源；单会话 null） */
  memberLabel: string | null
  /** 子代理类型（命名/配色键 = `subagentType ?? agentName`，与泳道图例一致） */
  subagentType: string | null
  color: string
  spawnStep: number
  deathStep: number
  points: Array<{
    step: number
    turnIndex: number
    inputTokens: number
    contextWindowPct: number | null
    timestamp: string | null
  }>
}

/** 回放步进轴：run 视图（member 归因在场）按合并时间序全局排名——各成员
 *  turnIndex 空间互不相通，同 index 撞步会把多成员轮混进同一帧；session/
 *  export 路径保持 turnIndex 旧口径（无归因即单会话，两轴天然同构） */
function computeStepOf(turns: TurnRowItem[]): Map<string, number> {
  const m = new Map<string, number>()
  if (!turns.some(t => t.member != null)) {
    for (const t of turns) m.set(t.turnId, t.turnIndex)
    return m
  }
  const tsOf = (t: TurnRowItem) => (t.createdAt ? new Date(t.createdAt).getTime() : 0)
  const sorted = [...turns].sort(
    (a, b) => (tsOf(a) - tsOf(b)) || (a.turnIndex - b.turnIndex) || a.turnId.localeCompare(b.turnId),
  )
  sorted.forEach((t, i) => m.set(t.turnId, i))
  return m
}

function computeTimelines(turns: TurnRowItem[], stepOf: Map<string, number>): AgentTimeline[] {
  const sessionMap = new Map<string, TurnRowItem[]>()
  for (const t of turns) {
    if ((t.inputTokens + t.cacheReadTokens) <= 0) continue
    const sid = contextAgentKeyOf(t)
    if (!sessionMap.has(sid)) sessionMap.set(sid, [])
    sessionMap.get(sid)!.push(t)
  }

  // 类型配色：黄金角度序列（context-legend 单一源）——键序规范排序与
  // ContextTracker 图例/曲线同源，回放与趋势图同色
  const colorMap = (() => {
    const seen = new Map<string, { sessionId: string; agentName: string; isRoot: boolean; subagentType: string | null }>()
    for (const t of turns) {
      const sid = contextAgentKeyOf(t)
      if (!seen.has(sid)) {
        seen.set(sid, {
          sessionId: sid,
          agentName: fallbackAgentDisplayName({ isSubagent: t.isSubagent, agentName: t.agentName }),
          isRoot: !t.isSubagent,
          subagentType: t.isSubagent ? t.subagentType ?? null : null,
        })
      }
    }
    return contextColorMapOf([...seen.values()])
  })()

  const stepOfTurn = (t: TurnRowItem) => stepOf.get(t.turnId) ?? t.turnIndex
  const timelines: AgentTimeline[] = []

  for (const [sid, agentTurns] of sessionMap) {
    const isRoot = !agentTurns[0].isSubagent
    const agentName = fallbackAgentDisplayName({
      isSubagent: !isRoot,
      memberLabel: agentTurns[0].member?.label,
      agentName: agentTurns[0].agentName,
    })
    const memberLabel = agentTurns[0].member?.label ?? null
    const subagentType = isRoot ? null : agentTurns[0].subagentType ?? null
    const color = colorMap.get(contextLegendKeyOf({ sessionId: sid, agentName, isRoot, subagentType })) ?? "#94a3b8"
    const spawnStep = stepOfTurn(agentTurns[0])
    const deathStep = stepOfTurn(agentTurns[agentTurns.length - 1])
    const points = agentTurns.map(t => ({
      step: stepOfTurn(t),
      turnIndex: t.turnIndex,
      inputTokens: t.inputTokens + t.cacheReadTokens,
      contextWindowPct: t.contextWindowPct,
      timestamp: t.createdAt,
    }))
    timelines.push({ sessionId: sid, agentName, isRoot, memberLabel, subagentType, color, spawnStep, deathStep, points })
  }

  timelines.sort((a, b) => {
    if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1
    return a.spawnStep - b.spawnStep
  })

  return timelines
}

function displayLabel(s: AgentTimeline, actors: Map<string, RunActor>): string {
  // 命名单一源（run-actor）：道名与趋势卡/图例同源；目录缺项兜底
  return actors.get(s.sessionId)?.displayName
    ?? (s.isRoot
      ? mainAgentDisplayName({ memberLabel: s.memberLabel, agentName: s.agentName })
      : subagentBaseNameOf(s))
}

function turnDisplayLabel(t: TurnRowItem, actors: Map<string, RunActor>): string {
  const actor = actors.get(contextAgentKeyOf(t));
  if (actor) return actor.displayName;
  return fallbackAgentDisplayName({
    isSubagent: t.isSubagent,
    memberLabel: t.member?.label,
    agentName: t.isSubagent ? (t.subagentType ?? t.agentName) : t.agentName,
  });
}

interface ContextReplayDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  turns: TurnRowItem[]
  /** 各 agent 上限最大值（ContextTracker 单源传入，不再逐模型拉 config） */
  contextWindowLimit: number
}

export function ContextReplayDialog({ open, onOpenChange, turns, contextWindowLimit }: ContextReplayDialogProps) {
  const stepOf = useMemo(() => computeStepOf(turns), [turns])
  const timelines = useMemo(() => computeTimelines(turns, stepOf), [turns, stepOf])
  // 命名单一源（run-actor）：回放道名与趋势卡/图例同源，别名表不再拷贝
  const actors = useMemo(() => buildRunActors(turns), [turns])

  if (!open || timelines.length === 0) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[900px] max-w-[calc(100%-1rem)] max-h-[90vh] overflow-y-auto p-4 gap-2"
        showCloseButton={true}
      >
        <DialogTitle className="text-base">⏯ Context Replay — 上下文演变动画</DialogTitle>
        <DialogDescription className="text-xs text-muted-foreground">
          播放整个会话的上下文窗口变化过程，观察 root agent 和 subagent 的 context 生长与消亡
        </DialogDescription>
        <ContextReplayPlayer
          timelines={timelines}
          turns={turns}
          contextWindowLimit={contextWindowLimit}
          actors={actors}
          stepOf={stepOf}
        />
      </DialogContent>
    </Dialog>
  )
}

const SPEED_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: "1x" },
  { value: 2, label: "2x" },
  { value: 4, label: "4x" },
]

const BASE_DELAY_MS = 120

function ContextReplayPlayer({
  timelines,
  turns,
  contextWindowLimit,
  actors,
  stepOf,
}: {
  timelines: AgentTimeline[]
  turns: TurnRowItem[]
  contextWindowLimit: number
  actors: Map<string, RunActor>
  stepOf: Map<string, number>
}) {
  const maxStep = Math.max(...turns.map(t => stepOf.get(t.turnId) ?? t.turnIndex), 0)
  const [currentTurn, setCurrentTurn] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [hoverPoint, setHoverPoint] = useState<{ sessionId: string; step: number; turnIndex: number; inputTokens: number } | null>(null)
  const animRef = useRef<number | null>(null)
  const lastTickRef = useRef<number>(0)
  // 步进值镜像：RAF 回调里读最新帧（回调异步，规避 effect 体内同步 setState
  // 的级联渲染——lint set-state-in-effect）
  const currentTurnRef = useRef(currentTurn)
  useEffect(() => { currentTurnRef.current = currentTurn }, [currentTurn])

  useEffect(() => {
    if (!isPlaying) {
      if (animRef.current) {
        cancelAnimationFrame(animRef.current)
        animRef.current = null
      }
      return
    }

    const delay = BASE_DELAY_MS / speed

    function tick(now: number) {
      if (now - lastTickRef.current >= delay) {
        lastTickRef.current = now
        const next = currentTurnRef.current + 1
        setCurrentTurn(Math.min(next, maxStep))
        // 步进到末帧即停（原独立 effect 里的同步 setState 触发级联渲染）
        if (next >= maxStep) {
          setIsPlaying(false)
          return
        }
      }
      animRef.current = requestAnimationFrame(tick)
    }

    lastTickRef.current = performance.now()
    animRef.current = requestAnimationFrame(tick)

    return () => {
      if (animRef.current) {
        cancelAnimationFrame(animRef.current)
        animRef.current = null
      }
    }
  }, [isPlaying, speed, maxStep])

  function handlePlay() {
    if (currentTurn >= maxStep) {
      setCurrentTurn(0)
    }
    setIsPlaying(true)
  }

  function handlePause() {
    setIsPlaying(false)
  }

  function handleReset() {
    setIsPlaying(false)
    setCurrentTurn(0)
  }

  const SVG_HEIGHT = 420
  const PADDING_TOP = 20
  const PADDING_BOTTOM = 30
  const PADDING_LEFT = 55
  const PADDING_RIGHT = 20
  const chartWidth = 1100
  const plotWidth = chartWidth - PADDING_LEFT - PADDING_RIGHT
  const plotHeight = SVG_HEIGHT - PADDING_TOP - PADDING_BOTTOM

  const currentTurnPoints = useMemo(() => {
    return timelines.map(tl => {
      const visible = tl.points.filter(p => p.step <= currentTurn)
      const isAlive = currentTurn <= tl.deathStep || tl.isRoot
      return { ...tl, visiblePoints: visible, isAlive }
    })
  }, [timelines, currentTurn])

  const allVisibleTokens = currentTurnPoints.flatMap(tl => tl.visiblePoints.map(p => p.inputTokens))
  const yMax = Math.min(
    Math.ceil((Math.max(...allVisibleTokens, 1) * 1.15) / 10000) * 10000,
    contextWindowLimit * 1.1
  )

  function toX(step: number): number {
    if (maxStep === 0) return PADDING_LEFT + plotWidth / 2
    return PADDING_LEFT + (step / maxStep) * plotWidth
  }
  function toY(tokens: number): number {
    return PADDING_TOP + plotHeight - (tokens / yMax) * plotHeight
  }

  const yTicks: Array<{ value: number; y: number; label: string }> = []
  const yStep = yMax <= 20000 ? 5000 : yMax <= 100000 ? 20000 : 40000
  for (let v = 0; v <= yMax; v += yStep) {
    yTicks.push({ value: v, y: toY(v), label: formatTokenCount(v) })
  }

  const xStep = maxStep <= 20 ? 1 : maxStep <= 50 ? 5 : maxStep <= 100 ? 10 : maxStep <= 200 ? 20 : 50
  const xTicks: Array<{ value: number; x: number; label: string }> = []
  for (let v = 0; v <= maxStep; v += xStep) {
    xTicks.push({ value: v, x: toX(v), label: `${v}` })
  }

  const limitY = toY(contextWindowLimit)
  const scanX = toX(currentTurn)

  const currentTurnData = useMemo(() => {
    const turnRows = turns.filter(t => (stepOf.get(t.turnId) ?? t.turnIndex) === currentTurn)
    return turnRows
  }, [turns, stepOf, currentTurn])

  return (
    <div className="space-y-2">
      <div className="relative">
        <svg
          width="100%"
          height={SVG_HEIGHT}
          viewBox={`0 0 ${chartWidth} ${SVG_HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          className="min-w-[500px]"
        >
          {yTicks.map(tick => (
            <g key={tick.value}>
              <line x1={PADDING_LEFT} y1={tick.y} x2={chartWidth - PADDING_RIGHT} y2={tick.y} stroke="#e5e7eb" strokeWidth={0.5} />
              <text x={PADDING_LEFT - 5} y={tick.y + 4} textAnchor="end" fontSize={9} fill="#6b7280">{tick.label}</text>
            </g>
          ))}

          {xTicks.map(tick => (
            <g key={tick.value}>
              <line x1={tick.x} y1={PADDING_TOP} x2={tick.x} y2={SVG_HEIGHT - PADDING_BOTTOM} stroke="#e5e7eb" strokeWidth={0.5} />
              <text x={tick.x} y={SVG_HEIGHT - 8} textAnchor="middle" fontSize={9} fill="#6b7280">{tick.label}</text>
            </g>
          ))}

          {contextWindowLimit < yMax && (
            <line
              x1={PADDING_LEFT}
              y1={limitY}
              x2={chartWidth - PADDING_RIGHT}
              y2={limitY}
              stroke="#ef4444"
              strokeWidth={1}
              strokeDasharray="6 3"
            />
          )}

          {currentTurnPoints.map(tl => {
            const pts = tl.visiblePoints
            if (pts.length === 0) return null

            const label = displayLabel(tl, actors)
            const isDead = !tl.isAlive && currentTurn > tl.deathStep
            const activeColor = isDead ? "#9ca3af" : tl.color
            const strokeW = tl.isRoot ? 2.5 : 1.5
            const opacity = isDead ? 0.4 : 1
            const dashArray = isDead ? "4 2" : undefined

            const polyline = pts.map(p => `${toX(p.step)},${toY(p.inputTokens)}`).join(" ")

            return (
              <g key={tl.sessionId} opacity={opacity}>
                <polyline
                  points={polyline}
                  fill="none"
                  stroke={activeColor}
                  strokeWidth={strokeW}
                  strokeLinejoin="round"
                  strokeDasharray={dashArray}
                />
                {pts.map(p => (
                  <circle
                    key={`${tl.sessionId}-${p.step}`}
                    cx={toX(p.step)}
                    cy={toY(p.inputTokens)}
                    r={tl.isRoot ? 3 : 2}
                    fill={activeColor}
                    stroke="white"
                    strokeWidth={1}
                    onMouseEnter={() => setHoverPoint({ sessionId: tl.sessionId, step: p.step, turnIndex: p.turnIndex, inputTokens: p.inputTokens })}
                    onMouseLeave={() => setHoverPoint(null)}
                  >
                    <title>{label} #{p.turnIndex} | {formatTokenCount(p.inputTokens)} | {(p.contextWindowPct ?? 0).toFixed(1)}%</title>
                  </circle>
                ))}

                {!tl.isRoot && pts.length > 0 && (
                  <g>
                    <circle
                      cx={toX(tl.spawnStep)}
                      cy={toY(pts[0].inputTokens)}
                      r={5}
                      fill="#10b981"
                      stroke="white"
                      strokeWidth={1.5}
                    />
                    <text
                      x={toX(tl.spawnStep) + 8}
                      y={toY(pts[0].inputTokens) - 2}
                      fontSize={8}
                      fill="#10b981"
                      fontWeight="bold"
                    >
                      🟢 {label}
                    </text>
                  </g>
                )}

                {!tl.isRoot && isDead && tl.points.length > 0 && (
                  <g>
                    <circle
                      cx={toX(tl.deathStep)}
                      cy={toY(tl.points[tl.points.length - 1].inputTokens)}
                      r={5}
                      fill="#ef4444"
                      stroke="white"
                      strokeWidth={1.5}
                    />
                    <text
                      x={toX(tl.deathStep) + 8}
                      y={toY(tl.points[tl.points.length - 1].inputTokens) - 2}
                      fontSize={8}
                      fill="#ef4444"
                      fontWeight="bold"
                    >
                      ✕
                    </text>
                  </g>
                )}
              </g>
            )
          })}

          <line
            x1={scanX}
            y1={PADDING_TOP}
            x2={scanX}
            y2={SVG_HEIGHT - PADDING_BOTTOM}
            stroke="#3b82f6"
            strokeWidth={1.5}
            opacity={0.3}
            strokeDasharray="3 3"
          />

          {hoverPoint && (
            <g>
              <circle
                cx={toX(hoverPoint.step)}
                cy={toY(hoverPoint.inputTokens)}
                r={6}
                fill="none"
                stroke="#3b82f6"
                strokeWidth={2}
              />
              <rect
                x={toX(hoverPoint.step) + 10}
                y={toY(hoverPoint.inputTokens) - 14}
                width={120}
                height={22}
                rx={4}
                fill="white"
                stroke="#e5e7eb"
                strokeWidth={1}
              />
              <text
                x={toX(hoverPoint.step) + 16}
                y={toY(hoverPoint.inputTokens)}
                fontSize={9}
                fill="#1f2937"
              >
                #{hoverPoint.turnIndex} {formatTokenCount(hoverPoint.inputTokens)}
              </text>
            </g>
          )}
        </svg>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-xs"
          onClick={isPlaying ? handlePause : handlePlay}
        >
          {isPlaying ? "⏸ Pause" : "▶ Play"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-xs"
          onClick={handleReset}
        >
          ↺ Reset
        </Button>

        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Speed:</span>
          {SPEED_OPTIONS.map(opt => (
            <Button
              key={opt.value}
              size="sm"
              variant={speed === opt.value ? "default" : "outline"}
              className="h-6 text-xs px-2"
              onClick={() => setSpeed(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>

        <div className="flex-1 flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            Turn {currentTurn}/{maxStep}
          </span>
          <input
            type="range"
            min={0}
            max={maxStep}
            value={currentTurn}
            onChange={(e) => {
              setIsPlaying(false)
              setCurrentTurn(Number(e.target.value))
            }}
            className="flex-1 h-1.5 accent-blue-500"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 items-center border-t pt-2 max-h-[80px] overflow-y-auto">
        <span className="text-xs text-muted-foreground shrink-0">Agents ({timelines.length}):</span>
        {currentTurnPoints.map(tl => {
          const label = displayLabel(tl, actors)
          const isDead = !tl.isAlive && currentTurn > tl.deathStep
          const hasTokens = tl.visiblePoints.length > 0
          return (
            <div key={tl.sessionId} className="flex items-center gap-1 text-xs">
              <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: isDead ? "#9ca3af" : tl.color, opacity: isDead ? 0.4 : 1 }} />
              <span className={cn(hasTokens ? "font-medium" : "text-muted-foreground", tl.isRoot && hasTokens && "text-blue-600 dark:text-blue-400")}>
                {label}
              </span>
              {hasTokens && (
                <span className="text-muted-foreground tabular-nums">
                  {formatTokenCount(tl.visiblePoints[tl.visiblePoints.length - 1].inputTokens)}
                </span>
              )}
              {!tl.isRoot && isDead && (
                <Badge variant="red" className="text-xs">✕ dead</Badge>
              )}
              {!tl.isRoot && !isDead && tl.visiblePoints.length > 0 && (
                <Badge variant="green" className="text-xs">🟢 active</Badge>
              )}
              {!tl.isRoot && !isDead && tl.visiblePoints.length === 0 && currentTurn < tl.spawnStep && (
                <Badge variant="outline" className="text-xs">waiting</Badge>
              )}
            </div>
          )
        })}
        {contextWindowLimit < yMax && (
          <div className="flex items-center gap-1.5 text-xs ml-2">
            <span className="inline-block w-4 h-0 border-t-2 border-dashed border-red-500" />
            <span className="text-red-500">Limit ({formatTokenCount(contextWindowLimit)})</span>
          </div>
        )}
      </div>

      {currentTurnData.length > 0 && (
        <div className="border rounded-lg px-3 py-2 space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium">Turn #{currentTurn}</span>
            {currentTurnData.map(t => (
              <Badge key={t.turnId} variant={t.isSubagent ? "orange" : "blue"} className="text-xs">
                {turnDisplayLabel(t, actors)}
              </Badge>
            ))}
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {currentTurnData.map(t => (
              <span key={t.turnId}>
                {turnDisplayLabel(t, actors)}: {formatTokenCount(t.inputTokens)} input
                {t.contextWindowPct != null && t.contextWindowPct > 0 && ` (${t.contextWindowPct.toFixed(1)}%)`}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
