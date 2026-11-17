"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 热点排行（run 观测核心面板）：基础单元 = 成员会话（agent）与子代理
// （subagent）同表呈现，按耗时/Tokens/顺序排序，子代理带父成员归属徽标。
// 行展开三级递进：逐轮明细（耗时占比 / Cache 命中 / TPS / 活动构成环图）
// → 该单元的执行切片（与画像墙钟同口径）。定位出口唯一收敛到 turnId
// （Turns 深链管线）：行内定位角标与轮次行点击都走 onOpenTurn。行属性
// data-lane-row——时间线卡的 data-lane 是泳道容器，两者共存于 Perf 页
// 须可区分。按 agent 名的跨单元聚合不在此呈现（多成员 run 同名混聚，
// 类型视角由时间线图例分槽承载；Σ总量归 Overview）。

import { useState } from "react"
import { ChevronRightIcon, LocateIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  PerfSegmented, computeTurnSegments, fmtMs, fmtTok, fmtOffset,
  LANE_COLORS, PERF_COLORS, perfEntrance, PERF_CARD_SM,
  type PerfLaneStat, type LaneExec,
} from "./perf-shared"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

type SortKey = "ms" | "tokens" | "order"

const HAIRLINE = "border-black/[0.05] dark:border-white/[0.07]"

export function PerfLaneList({ lanes, laneExecs, t0, onOpenTurn }: {
  lanes: PerfLaneStat[]
  laneExecs: Map<string, LaneExec[]>
  t0: number
  onOpenTurn?: (turnId: string) => void
}) {
  const [sortKey, setSortKey] = useState<SortKey>("ms")
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showAllTurns, setShowAllTurns] = useState<Set<string>>(new Set())
  const [showBreakdown, setShowBreakdown] = useState<Set<string>>(new Set())
  const [showAllLanes, setShowAllLanes] = useState(false)

  const getVal = (s: PerfLaneStat, key: SortKey): number =>
    key === "ms" ? s.totalMs : key === "tokens" ? s.totalTokens : s.turns[0]?.turnIndex ?? 0

  const sorted = [...lanes].sort((a, b) => {
    if (sortKey === "order") return getVal(a, sortKey) - getVal(b, sortKey)
    return getVal(b, sortKey) - getVal(a, sortKey)
  })
  const totalVal = sorted.reduce((s, l) => s + getVal(l, sortKey), 0)
  const barColor = sortKey === "ms" ? "#6366f1" : sortKey === "tokens" ? "#2563eb" : "#16a34a"

  const sortTurns = (lane: PerfLaneStat) => {
    const turns = lane.turns
    if (sortKey === "order") return [...turns].sort((a, b) => a.turnIndex - b.turnIndex)
    const val = (t: (typeof turns)[number]): number =>
      sortKey === "tokens" ? t.totalTokens : t.latencyMs
    return [...turns].sort((a, b) => val(b) - val(a))
  }

  const toggleSet = (set: Set<string>, id: string) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }

  const visibleLanes = showAllLanes ? sorted : sorted.slice(0, 10)

  return (
    <Card
      {...perfEntrance(150, PERF_CARD_SM)}
      data-testid="perf-lane-card" size="sm"
    >
      <CardHeader>
        <CardTitle>热点排行</CardTitle>
        <span className="text-[11px] text-muted-foreground">
          {lanes.length} 条 · 成员 agent 与子代理同表
        </span>
        <CardAction>
          <PerfSegmented
            ariaLabel="热点排序"
            value={sortKey}
            options={[
              { value: "ms", label: "耗时" },
              { value: "tokens", label: "Tokens" },
              { value: "order", label: "顺序" },
            ]}
            onChange={setSortKey}
          />
        </CardAction>
      </CardHeader>

      <CardContent>
        {lanes.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">暂无热点数据</div>
        ) : (
          <div className="divide-y divide-foreground/[0.06] overflow-hidden rounded-xl bg-foreground/[0.03] dark:bg-foreground/[0.06]">
            {visibleLanes.map(lane => {
              const isOpen = expanded === lane.laneId
              const pct = totalVal > 0 ? (getVal(lane, sortKey) / totalVal) * 100 : 0
              const laneColor = lane.kind === "agent" ? LANE_COLORS.agent : LANE_COLORS.subagent
              return (
                <div key={lane.laneId} data-lane-row={lane.laneId} className="group">
                  <div
                    role="button"
                    tabIndex={0}
                    className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-foreground/[0.04]"
                    onClick={() => setExpanded(isOpen ? null : lane.laneId)}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") setExpanded(isOpen ? null : lane.laneId) }}
                  >
                  <ChevronRightIcon
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-300 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]",
                      isOpen && "rotate-90",
                    )}
                  />
                  <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: laneColor }} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="truncate text-[13px] font-medium">{lane.name}</span>
                      {lane.subagentType && (
                        <Badge variant="orange" className="shrink-0 text-[10px] font-mono max-w-[220px] truncate" title={lane.taskDescription ?? lane.subagentType}>🔗 {lane.subagentType}</Badge>
                      )}
                      <span className={cn("shrink-0 rounded-full border px-1.5 py-px text-[10px] leading-4 text-muted-foreground", HAIRLINE)}>
                        {lane.kind === "subagent" ? `子代理 · ${lane.owner ?? "—"}` : "成员"}
                      </span>
                    </div>
                    {!lane.subagentType && lane.taskDescription && (
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={lane.taskDescription}>{lane.taskDescription}</div>
                    )}
                    {sortKey !== "order" && (
                      <div
                        className="mt-1.5 h-1 max-w-[340px] overflow-hidden rounded-full bg-muted"
                        title={`占 ${sortKey === "ms" ? "耗时" : "Tokens"} ${pct.toFixed(1)}%`}
                      >
                        <div
                          className="h-full rounded-full transition-[width] duration-300 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]"
                          style={{ width: `${Math.max(pct, 1)}%`, background: barColor }}
                        />
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    <div className="flex flex-col items-end leading-tight">
                      <span className="text-[10px] text-muted-foreground">耗时</span>
                      <span className="text-xs font-semibold tabular-nums">{fmtMs(lane.totalMs)}</span>
                    </div>
                    <div className="flex flex-col items-end leading-tight">
                      <span className="text-[10px] text-muted-foreground">Tokens</span>
                      <span className="text-xs font-semibold tabular-nums">{fmtTok(lane.totalTokens)}</span>
                    </div>
                    <div className="hidden flex-col items-end leading-tight sm:flex">
                      <span className="text-[10px] text-muted-foreground">TPS</span>
                      <span className="text-xs font-semibold tabular-nums">{lane.tps.toFixed(1)}</span>
                    </div>
                  </div>
                  {onOpenTurn && lane.firstTurnId && (
                    <span
                      role="button"
                      tabIndex={0}
                      title="在 Turns 时间线定位该单元"
                      className="mt-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/50 opacity-0 transition-opacity duration-200 hover:bg-foreground/[0.06] hover:text-foreground group-hover:opacity-100"
                      onClick={e => { e.stopPropagation(); onOpenTurn(lane.firstTurnId!) }}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onOpenTurn(lane.firstTurnId!) } }}
                    >
                      <LocateIcon className="size-3.5" />
                    </span>
                  )}
                </div>

                {isOpen && (() => {
                  const allTurns = sortTurns(lane)
                  const isShowAll = showAllTurns.has(lane.laneId)
                  const visibleTurns = isShowAll ? allTurns : allTurns.slice(0, 10)
                  const execs = laneExecs.get(lane.laneId) ?? []
                  return (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 mx-3 mb-3 overflow-hidden rounded-lg border border-foreground/[0.06] bg-card">
                      {allTurns.length > 0 && (
                        <>
                          <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            轮次 · {allTurns.length}
                          </div>
                          {visibleTurns.map(t => {
                            const segments = computeTurnSegments(t)
                            const segTotal = segments.reduce((sum, seg) => sum + seg.ms, 0)
                            const cachePct = t.cacheReadTokens + t.inputTokens > 0
                              ? (t.cacheReadTokens / (t.cacheReadTokens + t.inputTokens)) * 100
                              : null
                            return (
                              <div
                                key={t.turnId}
                                data-turn={t.turnId}
                                className="flex cursor-pointer flex-col gap-1 border-b border-black/[0.04] px-3 py-1.5 text-[11px] tabular-nums transition-colors last:border-0 hover:bg-muted/50 dark:border-white/[0.05]"
                                onClick={() => onOpenTurn?.(t.turnId)}
                              >
                                <div className="flex items-center gap-3">
                                  <span className="w-8 shrink-0 text-center font-mono text-muted-foreground">#{t.turnIndex}</span>
                                  <span className="w-[88px] shrink-0 text-center font-semibold text-indigo-600 dark:text-indigo-400">
                                    {fmtMs(t.latencyMs)}
                                    <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">
                                      ({lane.totalMs > 0 ? `${(t.latencyMs / lane.totalMs * 100).toFixed(0)}%` : "—"})
                                    </span>
                                  </span>
                                  <span className="w-14 shrink-0 text-center">{fmtTok(t.totalTokens)}</span>
                                  <span
                                    className="w-[86px] shrink-0 whitespace-nowrap text-center"
                                    style={{ color: cachePct != null && cachePct < 50 ? PERF_COLORS.danger : "#16a34a" }}
                                    title={`Cache read: ${fmtTok(t.cacheReadTokens)} / Non-cached input (miss): ${fmtTok(t.inputTokens)}`}
                                  >
                                    {cachePct != null ? `Cache ${cachePct.toFixed(2)}%` : "—"}
                                  </span>
                                  <span className="w-[68px] shrink-0 whitespace-nowrap text-center">
                                    {t.latencyMs > 0 ? `TPS ${(((t.outputTokens ?? 0) + (t.reasoningTokens ?? 0)) / (t.latencyMs / 1000)).toFixed(1)}` : "—"}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                    {(t.toolCalls?.length ?? 0)} tools · {t.model ?? "?"}
                                  </span>
                                  {segTotal > 0 && (
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      className="flex shrink-0 cursor-pointer items-center gap-0.5 whitespace-nowrap text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                                      onClick={e => { e.stopPropagation(); setShowBreakdown(prev => toggleSet(prev, t.turnId)) }}
                                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setShowBreakdown(prev => toggleSet(prev, t.turnId)) } }}
                                    >
                                      活动
                                      <ChevronRightIcon
                                        className={cn(
                                          "size-3 transition-transform duration-300 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]",
                                          showBreakdown.has(t.turnId) && "rotate-90",
                                        )}
                                      />
                                    </span>
                                  )}
                                </div>
                                {segTotal > 0 && showBreakdown.has(t.turnId) && (
                                  <div className="flex items-center gap-4 py-1 pl-11">
                                    <svg viewBox="0 0 80 80" width="72" height="72" className="flex-shrink-0">
                                      <g transform="rotate(-90 40 40)">
                                        {(() => {
                                          const radius = 30
                                          const strokeWidth = 10
                                          const circumference = 2 * Math.PI * radius
                                          let offset = 0
                                          return segments.map((seg, i) => {
                                            const frac = seg.ms / segTotal
                                            const length = frac * circumference
                                            const circle = (
                                              <circle key={i} cx="40" cy="40" r={radius} fill="none"
                                                stroke={seg.color} strokeWidth={strokeWidth}
                                                strokeDasharray={`${length} ${circumference - length}`}
                                                strokeDashoffset={-offset} />
                                            )
                                            offset += length
                                            return circle
                                          })
                                        })()}
                                      </g>
                                      <text x="40" y="44" textAnchor="middle" fontSize="12" fontWeight="700" className="fill-foreground">
                                        {fmtMs(segTotal)}
                                      </text>
                                    </svg>
                                    <div className="flex flex-col gap-1.5">
                                      {segments.map(seg => {
                                        const desc = seg.label === "分析" ? "read/grep/glob 读取搜索"
                                          : seg.label === "编写" ? "write/edit 文件修改"
                                          : seg.label === "执行" ? "bash/test 命令执行"
                                          : seg.label === "LLM思考" ? "无工具纯推理"
                                          : ""
                                        return (
                                          <span key={seg.label} className="flex items-center gap-1.5 text-[10px]">
                                            <span className="inline-block size-2.5 rounded-sm flex-shrink-0" style={{ background: seg.color }} />
                                            <span className="w-14 text-muted-foreground">{seg.label}</span>
                                            <span className="w-12 font-semibold tabular-nums">{fmtMs(seg.ms)}</span>
                                            <span className="w-10 text-muted-foreground tabular-nums">({(seg.ms / segTotal * 100).toFixed(0)}%)</span>
                                            <span className="text-[9px] text-muted-foreground/60">{desc}</span>
                                          </span>
                                        )
                                      })}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                          {allTurns.length > 10 && (
                            <div
                              className="cursor-pointer select-none px-3 py-1.5 text-[11px] text-blue-600 transition-colors hover:underline dark:text-blue-400"
                              onClick={e => { e.stopPropagation(); setShowAllTurns(prev => toggleSet(prev, lane.laneId)) }}
                            >
                              {isShowAll ? "收起" : `展开全部 (${allTurns.length} turns)`}
                            </div>
                          )}
                        </>
                      )}

                      {execs.length > 0 && (
                        <>
                          <div className={cn("border-t px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground", HAIRLINE)}>
                            执行切片 · {execs.length}
                          </div>
                          <div className="flex items-center gap-3 px-3 pb-1 text-[10px] text-muted-foreground/70">
                            <span className="w-8 shrink-0 text-center">#</span>
                            <span className="w-[72px] shrink-0 text-center">+Offset</span>
                            <span className="w-[80px] shrink-0 text-center">墙钟</span>
                            <span className="w-[72px] shrink-0 text-center">活跃</span>
                            <span className="w-[72px] shrink-0 text-center">非活跃</span>
                            <span className="min-w-0 flex-1 text-right">用量</span>
                          </div>
                          {execs.map(({ ord, wallMs, activeMs, inactiveMs, exec }) => (
                            <div
                              key={exec.executionId}
                              className="border-b border-black/[0.04] px-3 py-1.5 text-[11px] tabular-nums last:border-0 dark:border-white/[0.05]"
                              title={`In ${fmtTok(exec.inputTokens)} · CacheR ${fmtTok(exec.cacheReadInputTokens)} · CacheW ${fmtTok(exec.cacheCreationInputTokens)} · Out ${fmtTok(exec.outputTokens)}\n模型 ${exec.model ?? "?"}`}
                            >
                              <div className="flex items-center gap-3">
                                <span className="w-8 shrink-0 text-center font-mono text-muted-foreground">#{ord}</span>
                                <span className="w-[72px] shrink-0 text-center text-muted-foreground">{fmtOffset(t0, exec.createdAt)}</span>
                                <span className="w-[80px] shrink-0 text-center font-semibold text-rose-600 dark:text-rose-400">{fmtMs(wallMs)}</span>
                                <span className="w-[72px] shrink-0 text-center text-indigo-600 dark:text-indigo-400">{fmtMs(activeMs)}</span>
                                <span className="w-[72px] shrink-0 text-center text-amber-600 dark:text-amber-500">{fmtMs(inactiveMs)}</span>
                                <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                                  {fmtTok(exec.tokens)} tok · LLM {exec.llmCallCount} · 工具 {exec.toolCallCount}
                                  {exec.toolCallErrorCount > 0 ? ` · 错 ${exec.toolCallErrorCount}` : ""}
                                </span>
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )
                })()}
              </div>
            )
          })}

          {sorted.length > 10 && (
            <div
              className="cursor-pointer select-none px-3 py-2 text-center text-xs text-blue-600 transition-colors hover:underline dark:text-blue-400"
              onClick={() => setShowAllLanes(!showAllLanes)}
            >
              {showAllLanes ? "收起" : `展开全部 (${sorted.length} 条)`}
            </div>
          )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
