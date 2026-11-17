"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.
// Overview 组合面板（单一源，run 形状）：run 是基本单元——本面板渲染「一个
// 执行单元」的总览（总览头 / Agent 泳道图 V2 / Skills / Tool Calls /
// Error Turns），不感知 session/run 之分：线上工作台（RunOverviewTab，run 级
// 端点取数，solo = 单成员退化）与离线导出（run 工作台自身即查看器，离线
// 内核按档案应答同一 run 端点）同源消费，展示零复制。
// 总览头 = 身份 + Σ指标一体：标题位（run 详情 = identity.run 下放身份
// [短标题/状态/类型/runId]；session/导出查看器 = 框架名大标题）、元信息行
// （框架[run 形态降入]/模型/成员/时间窗/代码统计/来源）、指标瓦片网格、
// Wall Clock 活动圆环、Errors 可点击深链首个错误轮。
// 纯展示契约：数据全走 props（identity/metrics 为聚合形状——run 级 = Σ成员，
// 会话级 = 单成员值）；轮次跳转经 onOpenTurns 回调（member 归因随行——run
// 工作台深链定位成员，session 视图无此维度时忽略即可）。时间维度（Agent
// 泳道）不在此面——性能观测归 Perf 页执行时间线。

import { useMemo, useState, useCallback } from "react"
import type { ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { CopyButton } from "@/components/observe/CopyButton"
import type { AgentItem, BridgeItem } from "@/components/observe/AgentCallGraph"
import { isProxyVersion } from "@/lib/shared/session-format"
import { buildSubagentNumbers } from "@/lib/subagent-numbering"
import { summarizeToolCallErrors, toolCallErrorMessage, type TurnErrorDigest } from "@/lib/tool-call-errors"
import { dispatchOnlySkillNames } from "@/lib/sift-audit"

export type OverviewAgent = AgentItem
export type OverviewBridge = BridgeItem

export interface OverviewSkill {
  skillName: string
  version: number | null
  invocationCount: number
}

/** run 详情身份（标题位数据）：run 名/状态/类型/runId——session 视图
 *  与离线导出查看器缺省（框架即标题本体），presence 驱动卡片标题形态 */
export interface OverviewRunIdentity {
  /** 展示短标题（prompt 自动命名的长文在消费侧截短；全文进 titleHint） */
  title: string
  titleHint?: string | null
  kindLabel: string
  kindVariant: "blue" | "purple"
  incomplete: boolean
  runId: string
}

/** 单元身份（元信息卡）：会话级 = 该会话；run 级 = run + 成员概览 */
export interface OverviewIdentity {
  framework: string | null
  frameworkVersion: string | null
  /** 成员会话数（run 级；>1 时显示 Members 行与错误轮成员归因） */
  memberCount: number
  model: string | null
  codeStats?: { additions: number; deletions: number; files: number } | null
  startTime: string | null
  endTime: string | null
  sourcePath: string | null
  /** run 详情身份（有则标题位 = run 短标题，框架降入元信息行） */
  run?: OverviewRunIdentity | null
}

/** 聚合指标（指标卡）：run 级 = Σ成员（memberStats + executions Σ），会话级 = 单成员值 */
export interface OverviewMetrics {
  totalTokens: number
  totalCost: number
  wallMs: number | null
  activeMs: number | null
  llmActiveMs: number | null
  llmCallCount: number
  toolCallCount: number
  subagentCount: number
  errorCount: number
  /** run 级 Σ轮次（memberStats；会话视图缺省——不显示 Turns 瓦片） */
  totalTurns?: number | null
}

export interface OverviewTurn {
  turnId: string
  turnIndex: number
  role: string
  contentSummary: string | null
  agentName: string | null
  isSubagent: boolean
  subagentName: string | null
  subagentSessionId: string | null
  /** resolveSubagentIdentity 产出的子代理类型（turns API 回填）：编号按类型分组 */
  subagentType?: string | null
  model: string | null
  finishReason: string | null
  totalTokens: number
  createdAt: string | null
  completedAt?: string | null
  latencyMs?: number
  toolCalls: Array<{ toolCallId: string; toolName: string; resultJson?: string | null; state: string; durationMs: number }>
  skillEvents: Array<{ skillName: string; eventType: string; success: boolean; errorMessage: string | null }>
  /** run 级成员归因（run turns 收集器注入）；session 视图缺省 null */
  member?: { taskId: string; label: string | null } | null
  /** 服务端预算的错误摘要（includeErrorDigest）：有它则无需 resultJson 原文；
   *  离线导出查看器（session 载荷带原文）缺省走客户端计算——两路同口径 */
  errorDigest?: TurnErrorDigest
}

/** 轮级错误信息统一取用（单一渲染路径，双数据源）：优先服务端 digest，
 *  缺省从原文（离线导出载荷）就地计算——计数/明细/消息提取共享同一实现 */
function errorInfoOf(t: OverviewTurn): { summary: ReturnType<typeof summarizeToolCallErrors>; messages: Array<{ toolName: string; message: string }>; skillMessages: Array<{ skillName: string; message: string }> } {
  if (t.errorDigest) return { summary: t.errorDigest, messages: t.errorDigest.messages, skillMessages: t.errorDigest.skillMessages }
  return {
    summary: summarizeToolCallErrors(t.toolCalls, t.skillEvents, t.finishReason),
    messages: t.toolCalls
      .map(tc => ({ toolName: tc.toolName, message: toolCallErrorMessage(tc) }))
      .filter(m => m.message !== ""),
    skillMessages: t.skillEvents
      .filter(se => !se.success && se.errorMessage)
      .map(se => ({ skillName: se.skillName, message: se.errorMessage!.substring(0, 60) })),
  }
}

export interface OverviewOpenTurnsTarget {
  turnId?: string | null
  subagentHighlightId?: string | null
  /** 错误轮/泳道条所属成员（run 工作台深链定位；session 视图无此维度） */
  member?: string | null
}

interface OverviewPanelsProps {
  identity: OverviewIdentity
  metrics: OverviewMetrics
  turns: OverviewTurn[]
  skills: OverviewSkill[]
  /** 客户端面板数据在途（线上工作台预取期）：客户端派生瓦片 shimmer、
   *  列表区骨架屏——不渲染空态误导；离线导出查看器恒 false（载荷即数据） */
  pending?: boolean
  onOpenTurns: (target: OverviewOpenTurnsTarget) => void
  /** 仅分派子代理排除提示的跳转（Skills 页派发排行）；线上工作台提供，离线查看器缺省不可点 */
  onOpenSkills?: () => void
}

export function formatTokenCount(n: number): string {
  if (n === 0) return "0"
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00"
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

export function formatLatency(ms: number): string {
  if (ms === 0) return "0ms"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}min`
}

type WallUnit = "s" | "min" | "h" | "d"

function wallUnitFor(ms: number): WallUnit {
  if (ms < 60_000) return "s"
  if (ms < 3_600_000) return "min"
  if (ms < 604_800_000) return "h"
  return "d"
}

export function formatWallSplit(wallMs: number, activeMs: number): { wall: string; active: string; inactive: string } {
  const unit = wallUnitFor(wallMs)
  const div = unit === "s" ? 1_000 : unit === "min" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  const r = (x: number) => Math.round((x / div) * 10) / 10
  const wall = r(wallMs)
  const active = r(activeMs)
  const inactive = Math.round((wall - active) * 10) / 10
  return { wall: `${wall.toFixed(1)}${unit}`, active: `${active.toFixed(1)}${unit}`, inactive: `${inactive.toFixed(1)}${unit}` }
}

export function formatTimestamp(ts: string | null): string {
  if (!ts) return "N/A"
  try {
    const d = new Date(ts)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1)
    const day = String(d.getDate())
    const hour = String(d.getHours()).padStart(2, '0')
    const minute = String(d.getMinutes()).padStart(2, '0')
    return `${year}/${month}/${day} ${hour}:${minute}`
  } catch {
    return ts
  }
}

/** 长标识/路径中段省略：保留首尾可辨认（悬停与复制给全文） */
function elideMiddle(s: string, max = 20): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

/** 展示用 runId：solo 前缀与类型药丸重复，省去；余下中段省略 */
function runIdDisplay(runId: string): string {
  const bare = runId.startsWith("solo:") ? runId.slice(5) : runId
  return elideMiddle(bare, 18)
}

/** 人读时长：单位随量级进位（1017.6min → 17.0h） */
export function formatDuration(ms: number): string {
  if (ms === 0) return "0ms"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${(ms / 86_400_000).toFixed(1)}d`
}

/** 时间窗（紧凑）：同年省年、同日只给时刻；全年份全文进悬停 */
function formatWindow(start: string | null, end: string | null): string {
  if (!start) return "N/A"
  try {
    const s = new Date(start)
    const pad = (n: number) => String(n).padStart(2, "0")
    const md = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`
    const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
    if (!end) return `${md(s)} ${hm(s)}`
    const e = new Date(end)
    if (s.getFullYear() !== e.getFullYear()) {
      return `${s.getFullYear()}/${md(s)} ${hm(s)} → ${e.getFullYear()}/${md(e)} ${hm(e)}`
    }
    if (md(s) === md(e)) return `${md(s)} ${hm(s)} → ${hm(e)}`
    return `${md(s)} ${hm(s)} → ${md(e)} ${hm(e)}`
  } catch {
    return start
  }
}

function frameworkDisplayName(framework: string | null): string {
  if (framework === "opencode") return "OpenCode"
  if (framework === "claude-code") return "Claude Code"
  if (framework === "codex") return "Codex"
  return framework ?? "N/A"
}

/** 技能行首彩点：名字哈希到稳定色相（行首色标） */
function dotColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 65% 55%)`
}

/** 活动圆环：外圈灰轨 + 绿色弧 = 活跃占比；
 *  stroke-dashoffset 过渡让数据到达时圆环“长”出来（GPU 无布局） */
function ActivityRing({ pct, size = 20, stroke = 3 }: { pct: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-foreground/[0.08]" />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
        className="stroke-green-500 transition-[stroke-dashoffset] duration-700 ease-out dark:stroke-green-400"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, Math.max(0, pct)) / 100)}
      />
    </svg>
  )
}

/** inset 紧凑指标瓦片（并排块状）：浅底圆角块、小标签上 / tabular 数值
 *  下、可选 sub 行（Wall Clock 活跃占比），收紧内距与字号（原大留白瓦片的
 *  紧凑版）；pending 时数值位 shimmer（等客户端面板数据，不闪误导性的 0）；
 *  error 色调 + onClick = Errors 深链首个错误轮 */
function MetricTile({ label, value, sub, tone, onClick, pending }: {
  label: string
  value: string
  sub?: ReactNode
  tone?: "error"
  onClick?: () => void
  pending?: boolean
}) {
  const clickable = onClick != null
  return (
    <div
      data-metric={label}
      className={cn(
        "min-w-0 rounded-xl bg-foreground/[0.04] px-2.5 py-2 transition-colors dark:bg-foreground/[0.07]",
        tone === "error" && "bg-red-500/[0.08] dark:bg-red-500/[0.14]",
        clickable && "cursor-pointer hover:bg-red-500/[0.14] dark:hover:bg-red-500/[0.2]",
      )}
      onClick={onClick}
      title={clickable ? "定位首个错误轮" : undefined}
    >
      <div className={cn("truncate text-[11px] font-medium text-muted-foreground", tone === "error" && "text-red-600 dark:text-red-400")}>{label}</div>
      {pending ? (
        <div className="mt-1.5 h-5 w-14 animate-pulse rounded bg-foreground/[0.08]" />
      ) : (
        <div className={cn("mt-0.5 truncate text-[18px] font-semibold leading-7 tracking-tight tabular-nums", tone === "error" && "text-red-600 dark:text-red-400")}>
          {value}
        </div>
      )}
      {sub != null ? <div className="mt-0.5">{sub}</div> : null}
    </div>
  )
}

/** 元信息项：小标签上 / 值下——与指标瓦片同一排版语法，纯文本无底色；
 *  长值截断（悬停全文），copyText 提供则随行复制钮 */
function MetaItem({ label, value, mono = false, copyText, title }: {
  label: string
  value: ReactNode
  mono?: boolean
  copyText?: string
  title?: string
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[10px] font-medium text-muted-foreground/80">{label}</div>
      <div className={cn(
        "mt-0.5 flex min-w-0 items-center gap-1 text-[13px] font-medium text-foreground/90",
        mono && "font-mono text-[12px]",
      )}>
        <span className="min-w-0 truncate">{value}</span>
        {copyText ? (
          <CopyButton text={copyText} className="size-3.5 shrink-0 text-muted-foreground/60 hover:text-foreground" />
        ) : null}
      </div>
    </div>
  )
}

/** inset 分组列表骨架（pending 态）：行形状与真实列表一致，逐行延迟 pulse */
function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y divide-foreground/[0.06] overflow-hidden rounded-xl bg-foreground/[0.03] dark:bg-foreground/[0.06]">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-foreground/[0.08]" style={{ animationDelay: `${i * 120}ms` }} />
          <span className="h-3.5 w-28 animate-pulse rounded-md bg-foreground/[0.08]" style={{ animationDelay: `${i * 120 + 80}ms` }} />
          <span className="ml-auto h-3.5 w-10 animate-pulse rounded-md bg-foreground/[0.08]" style={{ animationDelay: `${i * 120 + 160}ms` }} />
        </div>
      ))}
    </div>
  )
}

export function OverviewPanels({ identity, metrics, turns, skills, pending = false, onOpenTurns, onOpenSkills }: OverviewPanelsProps) {
  const [showAllErrorTurns, setShowAllErrorTurns] = useState(false)
  const subagentNumbers = useMemo(() => buildSubagentNumbers(turns), [turns])
  const withSubagentNum = useCallback((base: string, sid: string | null): string => {
    const num = sid ? subagentNumbers.get(sid) : undefined
    return num !== undefined ? `${base} #${num}` : base
  }, [subagentNumbers])
  const multiMember = identity.memberCount > 1
  // proxy 捕获的 version = '<agent版本>-<marker>'：版本号取剥离值，proxy 徽标按谓词
  const frameworkVer = identity.frameworkVersion?.replace(/-(claude|opencode)-proxy$/, "") ?? null
  const isProxy = isProxyVersion(identity.frameworkVersion)
  const wallSplit = metrics.wallMs != null && metrics.activeMs != null
    ? formatWallSplit(metrics.wallMs, metrics.activeMs)
    : null
  // Skills 计数/列表排除仅 dispatch 的子代理（如 blackbox-designer），与 Skills
  // 表/图表、Audit 的 agent/skill 划分对齐；事件与 token 汇总由 turns 就地拍平。
  const skillEventsFlat = useMemo(() => turns.flatMap(t =>
    (t.skillEvents ?? []).map(se => ({
      skillName: se.skillName,
      eventType: se.eventType,
      isSubagent: t.isSubagent,
      turnTokens: { totalTokens: t.totalTokens },
    }))
  ), [turns])
  const dispatchOnlyNames = useMemo(() => dispatchOnlySkillNames(skillEventsFlat), [skillEventsFlat])
  const displaySkills = useMemo(() => skills.filter(sn => !dispatchOnlyNames.has(sn.skillName)), [skills, dispatchOnlyNames])
  const toolCallStats = useMemo(() => {
    const grouped = new Map<string, { count: number; avgDuration: number; errorCount: number }>()
    for (const tc of turns.flatMap(t => t.toolCalls ?? [])) {
      const existing = grouped.get(tc.toolName) ?? { count: 0, avgDuration: 0, errorCount: 0 }
      existing.count++
      existing.avgDuration += tc.durationMs
      if (tc.state === "error") existing.errorCount++
      grouped.set(tc.toolName, existing)
    }
    return [...grouped.entries()].sort((a, b) => b[1].count - a[1].count)
  }, [turns])

  return (
    <div className="space-y-4">
      {/* ── 总览头（三区结构，发丝分隔）：身份区（标题 + 药丸）→
          元信息键值网格 → Σ指标瓦片行 ── */}
      <Card className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-backwards overflow-hidden rounded-2xl ring-foreground/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_-24px_rgba(0,0,0,0.28)]">
        <CardContent className="px-5 pt-4 pb-4">
          <div className="divide-y divide-foreground/[0.06]">
          {/* 身份区：run = 短标题（prompt 长名截短，全文/runId 悬停）+
              状态/类型/完整性药丸 + runId（solo 前缀与类型药丸重复故省去，
              中段省略 + 复制全文）；session/导出查看器 = 框架名大标题 */}
          <div className="min-w-0 pb-3.5">
            {identity.run ? (
              <>
                <h1 className="truncate text-[22px] font-semibold leading-8 tracking-tight" title={identity.run.titleHint ?? identity.run.title}>
                  {identity.run.title}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <Badge variant={identity.run.kindVariant} className="text-[11px]">{identity.run.kindLabel}</Badge>
                  {identity.run.incomplete ? (
                    <Badge variant="yellow" className="text-[11px]">数据不完整</Badge>
                  ) : null}
                  <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/80">
                    <span className="truncate font-mono" title={identity.run.runId}>{runIdDisplay(identity.run.runId)}</span>
                    <CopyButton text={identity.run.runId} className="size-3.5 shrink-0 text-muted-foreground/60 hover:text-foreground" />
                  </span>
                </div>
              </>
            ) : (
              <span className="inline-flex items-baseline gap-2 text-[26px] font-bold leading-9 tracking-tight">
                {frameworkDisplayName(identity.framework)}
                {frameworkVer ? <span className="text-sm font-normal text-muted-foreground">v{frameworkVer}</span> : null}
                {isProxy ? <Badge variant="yellow" className="mb-1">proxy</Badge> : null}
              </span>
            )}
          </div>
          {/* 元信息区：键值网格（小标签上/值下，与指标瓦片同一排版语法）；
              时间窗同年省年、同日省重复日期（全年份悬停）；路径中段省略 + 复制 */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-4 gap-y-3 py-3.5">
            {identity.run ? (
              <MetaItem
                label="框架"
                title={identity.framework ?? undefined}
                value={
                  <>
                    {frameworkDisplayName(identity.framework)}
                    {frameworkVer ? <span className="ml-1 font-normal text-muted-foreground">v{frameworkVer}</span> : null}
                    {isProxy ? <Badge variant="yellow" className="ml-1 px-1.5 py-0 text-[10px]">proxy</Badge> : null}
                  </>
                }
              />
            ) : null}
            {identity.model ? (
              <MetaItem label="模型" value={identity.model} title={identity.model ?? undefined} />
            ) : null}
            {multiMember ? (
              <MetaItem label="成员" value={`${identity.memberCount} 个会话`} />
            ) : null}
            <MetaItem
              label="时间窗"
              value={formatWindow(identity.startTime, identity.endTime)}
              title={`${formatTimestamp(identity.startTime)}${identity.endTime ? ` → ${formatTimestamp(identity.endTime)}` : ""}`}
            />
            {identity.codeStats && identity.codeStats.files > 0 ? (
              <MetaItem
                label="代码"
                value={
                  <span className="tabular-nums">
                    <span className="text-green-600 dark:text-green-400">+{identity.codeStats.additions}</span>{" "}
                    <span className="text-red-500 dark:text-red-400">-{identity.codeStats.deletions}</span>
                    <span className="font-normal text-muted-foreground"> · {identity.codeStats.files} files</span>
                  </span>
                }
              />
            ) : null}
            {identity.sourcePath ? (
              <MetaItem
                label="来源"
                mono
                value={elideMiddle(identity.sourcePath, 30)}
                copyText={identity.sourcePath}
                title={identity.sourcePath}
              />
            ) : null}
          </div>
          {/* Σ指标区：单行自适应瓦片网格（容器够宽全部一行，窄窗口自动折行）；
              Tool Calls 不重复摆（下方 Tool Calls 分组列表承载）；Wall Clock
              活动圆环 + 活跃时长 sub（完整拆分悬停）；Errors 红色深链首错轮 */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(104px,1fr))] gap-2 pt-3.5">
            <MetricTile label="Tokens" value={formatTokenCount(metrics.totalTokens)} />
            <MetricTile label="Cost" value={formatCost(metrics.totalCost)} />
            {(() => {
              if (metrics.wallMs == null) return <MetricTile label="Wall Clock" value="—" />
              if (metrics.activeMs == null) {
                const start = identity.startTime ? new Date(identity.startTime).getTime() : 0
                const end = identity.endTime ? new Date(identity.endTime).getTime() : start
                return <MetricTile label="Wall Clock" value={formatLatency(Math.max(0, end - start))} />
              }
              const activePct = metrics.wallMs > 0 ? Math.min(100, Math.round((metrics.activeMs / metrics.wallMs) * 100)) : 0
              return (
                <MetricTile
                  label="Wall Clock"
                  value={wallSplit!.wall}
                  sub={
                    <div
                      className="flex items-center gap-1.5"
                      title={`活跃 ${wallSplit!.active} · 非活跃 ${wallSplit!.inactive}（LLM/工具等工作窗口并集；固定 5min 间隔聚类）`}
                    >
                      <ActivityRing pct={activePct} size={14} stroke={2.5} />
                      <span className="min-w-0 flex-1 truncate text-[10px] font-medium tabular-nums leading-4 text-green-600 dark:text-green-400">
                        活跃 {wallSplit!.active}
                      </span>
                    </div>
                  }
                />
              )
            })()}
            <MetricTile label="LLM Active" value={metrics.llmActiveMs != null ? formatDuration(metrics.llmActiveMs) : "—"} pending={pending} />
            <MetricTile label="LLM Calls" value={String(metrics.llmCallCount)} pending={pending} />
            {/* Skills 瓦片 = 去重技能数，与下方 Skills 列表头同口径（原 skillLoadCount
                只计 load 事件，opencode 等源只产 use/invoke 事件会误显 0） */}
            <MetricTile label="Skills" value={String(displaySkills.length)} pending={pending} />
            <MetricTile label="Subagents" value={String(metrics.subagentCount)} pending={pending} />
            {metrics.totalTurns != null ? (
              <MetricTile label="Turns" value={formatTokenCount(metrics.totalTurns)} />
            ) : null}
            {metrics.errorCount > 0 ? (
              <MetricTile
                label="⚠ Errors"
                value={String(metrics.errorCount)}
                tone="error"
                onClick={() => {
                  const first = turns
                    .map(t => ({ turn: t, errors: errorInfoOf(t).summary }))
                    .find(({ errors }) => errors.total > 0)
                  if (first) {
                    onOpenTurns({ turnId: first.turn.turnId, member: first.turn.member?.taskId ?? null })
                  }
                }}
              />
            ) : null}
          </div>
          </div>
        </CardContent>
      </Card>

      {/* Skills / Tool Calls 双列并排：inset 分组列表（发丝分隔 + 悬停高亮），
          pending 骨架行不渲染空态误导 */}
      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-backwards grid gap-4 delay-75 lg:grid-cols-2">
        <Card size="sm" className="min-w-0 rounded-2xl ring-foreground/[0.06]">
          <CardHeader>
            <CardTitle>Skills ({displaySkills.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {pending ? <ListSkeleton rows={3} /> : displaySkills.length === 0 ? (
              <div className="text-sm text-muted-foreground">No skills loaded</div>
            ) : (
              <div className="divide-y divide-foreground/[0.06] overflow-hidden rounded-xl bg-foreground/[0.03] dark:bg-foreground/[0.06]">
                {displaySkills.map(sn => {
                  const skillEvents = skillEventsFlat.filter(e => e.skillName === sn.skillName)
                  const skillTokens = skillEvents.reduce((sum, e) => sum + e.turnTokens.totalTokens, 0)
                  const formatT = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
                  return (
                    <div key={sn.skillName} className="flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-foreground/[0.04]">
                      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor(sn.skillName) }} />
                      <span className="min-w-0 truncate text-[13px] font-medium">{sn.skillName}</span>
                      {sn.version != null && <span className="shrink-0 text-xs text-muted-foreground">v{sn.version}</span>}
                      <span className="ml-auto flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                        {skillTokens > 0 && <span>{formatT(skillTokens)}t</span>}
                        <Badge variant="green" className="text-xs">{sn.invocationCount}x</Badge>
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
            {dispatchOnlyNames.size > 0 && (
              <div
                className="mt-2 cursor-pointer text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => onOpenSkills?.()}
              >
                已排除 {dispatchOnlyNames.size} 个仅分派的子代理（见 Skills 页派发排行）
              </div>
            )}
          </CardContent>
        </Card>

        <Card size="sm" className="min-w-0 rounded-2xl ring-foreground/[0.06]">
          <CardHeader>
            <CardTitle>Tool Calls ({toolCallStats.reduce((sum, [, st]) => sum + st.count, 0)})</CardTitle>
          </CardHeader>
          <CardContent>
            {pending ? <ListSkeleton rows={3} /> : toolCallStats.length === 0 ? (
              <div className="text-xs text-muted-foreground">No tool calls</div>
            ) : (
              <div className="divide-y divide-foreground/[0.06] overflow-hidden rounded-xl bg-foreground/[0.03] dark:bg-foreground/[0.06]">
                {toolCallStats.map(([name, stats]) => (
                  <div key={name} className="flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-foreground/[0.04]">
                    <span className="min-w-0 truncate font-mono text-xs font-medium">{name}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                      <span>{formatLatency(Math.round(stats.avgDuration / stats.count))}</span>
                      <Badge variant="outline" className="text-xs">{stats.count}x</Badge>
                      {stats.errorCount > 0 && <Badge variant="red" className="text-xs">{stats.errorCount} err</Badge>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {(() => {
        if (pending) return null
        const errorTurns = turns
          .map(t => ({ turn: t, info: errorInfoOf(t) }))
          .filter(({ info }) => info.summary.total > 0)

        if (errorTurns.length === 0) return <div />

        const visibleErrorTurns = showAllErrorTurns ? errorTurns : errorTurns.slice(0, 3)

        return (
          <Card size="sm" className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-backwards delay-150 rounded-2xl ring-red-500/20">
            <CardHeader>
              <CardTitle className="text-red-600 dark:text-red-400">⚠ Error Turns ({errorTurns.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y divide-red-500/[0.08] overflow-hidden rounded-xl bg-red-500/[0.04] dark:bg-red-500/[0.06]">
                {visibleErrorTurns.map(({ turn: t, info }) => {
                  const errors = info.summary
                  return (
                  <button
                    key={t.turnId}
                    className="w-full px-3 py-2 text-left text-xs transition-colors hover:bg-red-500/[0.07] cursor-pointer"
                    onClick={() => {
                      onOpenTurns({ turnId: t.turnId, member: t.member?.taskId ?? null })
                    }}
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono text-muted-foreground">#{t.turnIndex}</span>
                      {multiMember && t.member && <Badge variant="slate" className="text-xs">{t.member.label ?? t.member.taskId.slice(0, 12)}</Badge>}
                      <Badge variant="outline" className="text-xs">{t.role}</Badge>
                      {t.isSubagent && t.subagentName && <Badge variant="orange" className="text-xs">🔗 {withSubagentNum(t.subagentName, t.subagentSessionId)}</Badge>}
                      {errors.cancelled > 0 && <Badge variant="orange" className="text-xs">{errors.cancelled} cancelled</Badge>}
                      {errors.failed > 0 && <Badge variant="red" className="text-xs">{errors.failed} failed</Badge>}
                      {errors.skillFail > 0 && <Badge variant="red" className="text-xs">{errors.skillFail} skill_fail</Badge>}
                      {errors.truncated > 0 && <Badge variant="red" className="text-xs">⛔ max_tokens 截断</Badge>}
                      {t.model && <span className="text-muted-foreground ml-auto">{t.model}</span>}
                    </div>
                    {t.contentSummary && (
                      <p className="text-foreground/80 truncate mb-0.5">{t.contentSummary.substring(0, 80)}</p>
                    )}
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
                      {errors.details.map((d, i) => (
                        <span key={i} className={d.type === "cancelled" ? "text-orange-500" : "text-red-500 dark:text-red-400"}>
                          {d.type === "skill_fail" ? "⚡" : d.type === "truncated" ? "⛔" : "🔧"} {d.toolName}
                        </span>
                      ))}
                      {info.messages.map(m => (
                        <span key={`${m.toolName}-${m.message}`} className="text-red-500/80 dark:text-red-400/80 truncate max-w-[180px]">{m.toolName}: {m.message}</span>
                      ))}
                      {info.skillMessages.map(m => (
                        <span key={`${m.skillName}-${m.message}`} className="text-red-500/80 dark:text-red-400/80 truncate max-w-[180px]">⚡ {m.skillName}: {m.message}</span>
                      ))}
                    </div>
                  </button>
                  )
                })}
              </div>
              {errorTurns.length > 3 && (
                <button
                  className="w-full mt-1.5 py-1.5 rounded-xl bg-red-500/[0.06] text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-500/[0.1] transition-colors cursor-pointer"
                  onClick={() => setShowAllErrorTurns(v => !v)}
                >
                  {showAllErrorTurns ? "收起" : `展开全部 (${errorTurns.length})`}
                </button>
              )}
            </CardContent>
          </Card>
        )
      })()}
    </div>
  )
}
