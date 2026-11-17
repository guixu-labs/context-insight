"use client"
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Perf 观测域共享层（run 视角）：数据类型（执行切片 / 轮次 / 桥 / 泳道）、
// 口径格式化、耗时活动分解、分段控制与效率分布图。执行切片即泳道图的
// agent 单元（ExecItem = AgentItem 超集，同源 /executions 端点），基础单元
// ——成员会话（agent）与子代理（subagent）同构呈现，定位统一收敛到
// turnId（Turns 深链管线）。

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import { MaximizeIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentItem, BridgeItem } from "./AgentCallGraph"

export type BridgePerf = BridgeItem

export interface TurnPerf {
  turnId: string
  turnIndex: number
  role: string
  agentName: string | null
  isSubagent: boolean
  subagentName: string | null
  subagentSessionId: string | null
  /** 子代理类型（resolveSubagentIdentity 唯一入口；原生形态 subagentName
   *  泛化（全体 "design"），真类型走桥 join 回填） */
  subagentType?: string | null
  /** 派发步骤（proxy 形态 = cpx meta.name；原生形态取桥 dispatchContent） */
  dispatchStep?: string | null
  /** 成员归因（run 合并视图） */
  member?: { taskId: string; label: string | null } | null
  contentSummary: string | null
  createdAt: string | null
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  contextWindowPct: number | null
  latencyMs: number
  model: string | null
  toolCalls: Array<{
    toolName: string
    durationMs: number
    state: string
  }>
}

/** 执行切片 = 泳道图的 agent 单元（同源 /executions 端点）：AgentItem
 *  （时间跨度/活跃区间供时间线）+ Perf 消费的 token 细分与工具错误计数 */
export interface ExecItem extends AgentItem {
  subagentName: string | null
  depth: number
  tokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  toolCallCount: number
  toolCallErrorCount: number
  llmCallCount: number
  cost: number
  latencyMs: number
  model: string | null
  createdAt: string
}

/** 泳道 = run 观测基础单元：成员会话（agent）或子代理（subagent）。
 *  子代理泳道经 owner 标注父成员；firstTurnId 是该泳道首个轮次
 *  （Turns 深链管线入态）。 */
export interface PerfLaneStat {
  laneId: string
  kind: "agent" | "subagent"
  name: string
  owner: string | null
  /** 子代理类型（桥 join，resolveSubagentIdentity 唯一入口）：行首橙色胶囊
   *  徽章；无类型（codex spawn 系）回落 taskDescription 小字 */
  subagentType: string | null
  taskDescription: string | null
  turns: TurnPerf[]
  totalMs: number
  totalTokens: number
  totalGenTokens: number
  tps: number
  cacheRead: number
  inputTokens: number
  cacheHitRate: number
  firstTurnId: string | null
}

/** 泳道内执行切片：按全局执行序号（createdAt 升序）编 #N；墙钟取该执行
 *  自身 span，活跃/非活跃由该执行的 activeIntervals 计算，不复用全局切片 */
export interface LaneExec {
  ord: number
  wallMs: number
  activeMs: number
  inactiveMs: number
  exec: ExecItem
}

// ── 固定配色：token 种类 / 单元种类恒定，不随排序变化 ──────────────────────
export const TOKEN_COLORS = {
  input: "#4E79A7",
  cacheRead: "#A0CBE8",
  cacheWrite: "#F1CE63",
  output: "#59A14F",
  reasoning: "#8b5cf6",
}
export const LANE_COLORS = { agent: "#2563eb", subagent: "#16a34a" }
export const PERF_COLORS = { axis: "#94a3b8", grid: "#e2e8f0", danger: "#dc2626" }

// ── 口径格式化 ────────────────────────────────────────────────────────────────
export function fmtMs(ms: number): string {
  // 单位阶梯：满 1s 才用 s、满 1min 才用 min（依此类推 h）——亚秒级一律
  // ms 整数（X.Xs 四舍五入会把 40ms 挤成 0.0s，轴不撒谎从单位开始）
  if (ms <= 0) return "0ms"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}min`
  return `${(ms / 3600000).toFixed(1)}h`
}

export function fmtTok(n: number): string {
  if (n === 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}

export function fmtOffset(base: number, ts: string): string {
  const t = new Date(ts).getTime()
  if (!base || !t) return "—"
  const d = Math.max(0, Math.floor((t - base) / 1000))
  const h = Math.floor(d / 3600)
  const m = Math.floor((d % 3600) / 60)
  const s = d % 60
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
}

// ── 耗时活动分解：LLM 思考 vs 工具调用（无时长工具按占比估计） ───────────────
function categorizeTool(name: string): string {
  const n = name.toLowerCase()
  if (["read", "glob", "grep", "webfetch", "search", "list"].some(t => n.includes(t))) return "分析"
  if (["write", "edit", "create", "str_replace"].some(t => n.includes(t))) return "编写"
  if (["bash", "terminal", "shell", "test", "run", "python", "pytest"].some(t => n.includes(t))) return "执行"
  return "其他"
}

const ACTIVITY_COLOR: Record<string, string> = {
  "LLM思考": "#8b5cf6",
  "分析": "#2563eb",
  "编写": "#16a34a",
  "执行": "#f59e0b",
  "其他": "#6b7280",
}

export function computeTurnSegments(t: TurnPerf): { label: string; ms: number; color: string }[] {
  const tools = t.toolCalls ?? []
  const toolMs = tools.reduce((sum, tc) => sum + Math.max(0, tc.durationMs), 0)

  if (toolMs > 0) {
    const llmMs = Math.max(0, t.latencyMs - toolMs)
    return [
      { label: "LLM思考", ms: llmMs, color: ACTIVITY_COLOR["LLM思考"] },
      { label: "工具调用", ms: toolMs, color: ACTIVITY_COLOR["分析"] },
    ].filter(s => s.ms > 0)
  }

  if (tools.length === 0) {
    return [{ label: "LLM思考", ms: t.latencyMs, color: ACTIVITY_COLOR["LLM思考"] }]
  }

  const tokens = (t.outputTokens ?? 0) + (t.reasoningTokens ?? 0)
  const estLlmMs = Math.min(t.latencyMs * 0.6, Math.max(500, tokens * 10))
  const estToolMs = Math.max(0, t.latencyMs - estLlmMs)

  const cats = tools.map(tc => categorizeTool(tc.toolName))
  const cat = cats.sort((a, b) =>
    cats.filter(c => c === b).length - cats.filter(c => c === a).length
  )[0]

  return [
    { label: "LLM思考", ms: estLlmMs, color: ACTIVITY_COLOR["LLM思考"] },
    { label: cat, ms: estToolMs, color: ACTIVITY_COLOR[cat] ?? ACTIVITY_COLOR["其他"] },
  ].filter(s => s.ms > 0)
}

// ── 卡片入场：阶梯节奏（0/75/150/225ms），纯 transform/opacity。
// extra 用于合并卡片外观类——展开后再写 className 会整体覆盖入场类，
// 一律经此合并，调用点不得再单独传 className ──────────────────────
const PERF_ENTRANCE_CLS = "animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-backwards"

export function perfEntrance(ms: number, extra?: string): { className: string; style: { animationDelay: string } } {
  return { className: cn(PERF_ENTRANCE_CLS, extra), style: { animationDelay: `${ms}ms` } }
}

/** 头卡外观（与 Overview 总览头同款：圆角环线 + 双层投影） */
export const PERF_CARD_CLS = "rounded-2xl ring-foreground/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_-24px_rgba(0,0,0,0.28)]"
/** 次级卡外观（与 Overview 次级卡同款：环线、无投影，配 size="sm"） */
export const PERF_CARD_SM = "rounded-2xl ring-foreground/[0.06]"

// ── 分段控制（胶囊分段：卡片头内联，选项互斥） ───────────────────────────
export function PerfSegmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex items-center gap-0.5 rounded-full bg-muted p-0.5">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-medium transition-[color,background-color,box-shadow,transform] duration-200 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] active:scale-95",
            value === o.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// 效率分布样本点：主 agent 轮的效率双镜头值 + 时刻
type BenchPoint = { turnIndex: number; turnId?: string; createdAt: string | null; tpot: number; tps: number }

// 效率分布图几何常量：高度与内边距固定，宽度不锁死——卡片实测像素宽
// 直写 viewBox（绘图 1:1 满铺宽卡片，两侧不再因 meet 居中留白而显小）；
// W_FALLBACK 供首帧与无测量环境（水合帧 / 无布局测试环境）兜底
const W_FALLBACK = 720, H = 200
const padL = 36, padR = 12, padT = 24, padB = 26
const chartH = H - padT - padB

// 宽度未测得（回退几何）时 svg 按默认 preserveAspectRatio=meet 均匀缩
// 放：宽卡片下元素远宽于 viewBox，绘图居中、两侧留白——像素 → viewBox
// 的 x 映射必须走缩放与居中偏移（无布局环境退化为恒等）。通用版（任意
// viewBox 尺寸，跨图复用）；viewXOf / viewScaleOf 是本图特化（宽度随实测）
export const svgViewX = (rect: DOMRect, clientX: number, w: number, h: number) => {
  if (rect.width <= 0) return clientX
  const scale = Math.min(rect.width / w, rect.height / h) || 1
  return (clientX - rect.left - (rect.width - w * scale) / 2) / scale
}
const viewXOf = (rect: DOMRect, clientX: number, w: number) => svgViewX(rect, clientX, w, H)
const viewScaleOf = (rect: DOMRect, w: number) => (rect.width > 0 ? Math.min(rect.width / w, rect.height / H) || 1 : 1)

// 单图样本容量：超出即按时间桶聚合（均值成线 + min-max 包络带保峰），
// 与观测工具的高密度时序呈现一致
const SAMPLE_MAX = 160

// 单调三次平滑（调和均值切线）：曲线严格过采样点且不过冲——平滑观感
// 与数值诚实兼得；lead 控制首指令（包络下缘以 L 续接上缘）
function smoothPath(pts: { x: number; y: number }[], lead: "M" | "L" = "M"): string {
  if (pts.length === 0) return ""
  if (pts.length === 1) return `${lead}${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
  const d: number[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x
    d.push(dx !== 0 ? (pts[i + 1].y - pts[i].y) / dx : 0)
  }
  const tg = [d[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    tg.push(d[i - 1] * d[i] <= 0 ? 0 : 2 / (1 / d[i - 1] + 1 / d[i]))
  }
  tg.push(d[d.length - 1])
  let s = `${lead}${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const h = pts[i + 1].x - pts[i].x
    const c1y = pts[i].y + (tg[i] * h) / 3
    const c2y = pts[i + 1].y - (tg[i + 1] * h) / 3
    s += ` C${(pts[i].x + h / 3).toFixed(1)} ${c1y.toFixed(1)} ${(pts[i + 1].x - h / 3).toFixed(1)} ${c2y.toFixed(1)} ${pts[i + 1].x.toFixed(1)} ${pts[i + 1].y.toFixed(1)}`
  }
  return s
}

// ── 效率分布：主 agent 轮 TPS / TPOT 序列，x 轴 = 真实时间轴（轮次时刻
//    定位——run 合并视角的统一时间轴；turnIndex 是会话内局部序号，多成
//    员混排不可作轴）。TPS 与 TPOT 互为倒数（同信息双镜头），分段控制单
//    图切换。折线 + 线下渐变面积呈现；样本数超出容量时按时间桶聚合——
//    均值成线、min-max 成包络带（峰值不因平滑而抹平）；y 轴 = 峰值整步
//    上取（轴覆盖全部数值，不做分位钳制）。时间窗缩放：Ctrl/⌘+滚轮锚定
//    放大、拖拽平移、工具条适配——窗口内重新采样分桶，放大即细节；统计
//    口径随窗口（可见范围即分析范围）。路径在 memo 内构建——悬停十字
//    线/气泡只重渲染轻量子树；纯观测无跳转（归因下钻归热点排行）。
//    呈现：宽度随卡片实测满铺（ResizeObserver 直写 viewBox）；入场动效
//    走纯 CSS 一次性动画（描画/渐显/统计条错峰），指标切换重挂重放───
export function PerfBenchmarkChart({ points }: {
  points: BenchPoint[]
}) {
  const [metric, setMetric] = useState<"tps" | "tpot">("tps")
  // 光标 x（viewBox 坐标；null = 图外）——十字线随光标，焦点点骑线内插
  const [cursor, setCursor] = useState<number | null>(null)
  // 时间窗（null = 全程）：Ctrl/⌘+滚轮锚定缩放、拖拽平移——窗口内重新
  // 采样分桶，放大即细节（稠密包络 → 逐轮真值）；统计口径随窗口（可
  // 见范围即分析范围）。窗口状态携带数据源身份：失配即视为全程（切
  // run 自动复位，无需副作用链）
  const [winState, setWinState] = useState<{ pts: BenchPoint[]; range: [number, number] | null }>({ pts: points, range: null })
  const win = winState.pts === points ? winState.range : null
  const setWin = (range: [number, number] | null) => setWinState({ pts: points, range })
  const [dragging, setDragging] = useState(false)
  // 实测绘图宽（0 = 未测得 → 回退 W_FALLBACK）：容器像素宽直写 viewBox，
  // 宽卡片 1:1 满铺；步进阈值防抖（细微宽度抖动不触发重排），采样/路径
  // 等重活随宽在 memo 内重算
  const [wrapW, setWrapW] = useState(0)
  const drawW = wrapW > 0 ? wrapW : W_FALLBACK
  const cw = drawW - padL - padR

  const m = useMemo(() => metric === "tps"
    ? { key: "tps" as const, unit: "tok/s", color: TOKEN_COLORS.output }
    : { key: "tpot" as const, unit: "ms/tok", color: TOKEN_COLORS.reasoning }, [metric])

  // 预排序（时间单调）与全程边界：缩放/平移的钳制基准，窗口切换零重排
  const sorted = useMemo(
    () => points
      .map(p => ({ ...p, ts: p.createdAt ? new Date(p.createdAt).getTime() : 0 }))
      .sort((a, b) => a.ts - b.ts),
    [points],
  )
  const full = useMemo(
    () => (sorted.length > 0 ? { tMin: sorted[0].ts, tMax: sorted[sorted.length - 1].ts } : null),
    [sorted],
  )
  const dragRef = useRef<{ x: number; v0: number; v1: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  // 实测宽镜像：供一次性挂载的原生滚轮监听取最新值（避免闭包过期）
  const drawWRef = useRef(W_FALLBACK)
  // 缩放回调经 ref 透传给一次性挂载的原生滚轮监听（恒取最新渲染闭包，
  // 免重挂监听）
  const zoomAtRef = useRef<(factor: number, vx: number) => void>(() => {})

  // 时间窗缩放：光标时刻锚定（缩放后该时刻的屏幕位置不动），窗口钳制
  // 在全程内；窗宽下限防退化，放大到全程即复位
  const zoomAt = (factor: number, vxRaw: number) => {
    const f = full
    if (!f || f.tMax - f.tMin <= 0) return
    const vx = Math.min(drawW - padR, Math.max(padL, vxRaw))
    const w = win
    const v0 = w ? w[0] : f.tMin
    const v1 = w ? w[1] : f.tMax
    const span = v1 - v0
    const fullSpan = f.tMax - f.tMin
    const next = Math.min(fullSpan, Math.max(Math.max(1000, fullSpan / 240), span / factor))
    if (next >= fullSpan - 1) { setWin(null); return }
    if (Math.abs(next - span) < 1) return
    const ta = v0 + ((vx - padL) / cw) * span
    let n0 = ta - ((ta - v0) / span) * next
    let n1 = n0 + next
    if (n0 < f.tMin) { n0 = f.tMin; n1 = n0 + next }
    if (n1 > f.tMax) { n1 = f.tMax; n0 = n1 - next }
    setWin([n0, n1])
  }
  useEffect(() => { zoomAtRef.current = zoomAt; drawWRef.current = drawW })

  // Ctrl/⌘+滚轮锚定缩放：原生 non-passive 监听（React onWheel 走 passive
  // 通道，preventDefault 无效，手势会被浏览器页面缩放劫持）；挂在稳定包
  // 装层上，指标切换重挂 svg 无需重挂监听
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const vx = svgViewX(rect, e.clientX, drawWRef.current, H)
      zoomAtRef.current(e.deltaY < 0 ? 1.12 : 1 / 1.12, vx)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // 拖拽释放兜底：鼠标在图外松开也能结束平移
  useEffect(() => {
    const up = () => {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener("mouseup", up)
    return () => window.removeEventListener("mouseup", up)
  }, [])

  const geo = useMemo(() => {
    if (sorted.length === 0) return null
    const tMin = sorted[0].ts
    const tMax = sorted[sorted.length - 1].ts
    const v0 = win ? Math.max(win[0], tMin) : tMin
    const v1 = win ? Math.min(win[1], tMax) : tMax
    const tSpan = Math.max(v1 - v0, 0)
    const tsPoints = win ? sorted.filter(p => p.ts >= v0 && p.ts <= v1) : sorted
    const fmtTime = (ts: number) => {
      const d = new Date(ts)
      return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`
    }
    const n = tsPoints.length
    const vals = tsPoints.map(p => p[m.key])
    const maxVal = n > 0 ? Math.max(...vals, 1) : 0
    const minVal = n > 0 ? Math.min(...vals) : 0
    const avgVal = n > 0 ? vals.reduce((s, v) => s + v, 0) / n : 0
    // y 轴 = 峰值整步上取（1/2/5×10^k）：轴刻度永远覆盖全部数值——分位
    // 钳制会让轴与实际数值自相矛盾；空窗给占位量程（网格结构不塌）
    const yMax = n > 0
      ? (() => {
          const base = maxVal > 0 ? maxVal : 1
          const mag = Math.pow(10, Math.floor(Math.log10(base)))
          const norm = base / mag
          return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
        })()
      : 2
    const xOf = (ts: number) => (tSpan > 0 ? padL + ((ts - v0) / tSpan) * cw : padL + cw / 2)
    const tOf = (x: number) => (tSpan > 0 ? v0 + ((x - padL) / cw) * tSpan : v0)
    const toY = (v: number) => padT + chartH - (Math.min(v, yMax) / yMax) * chartH
    const avgY = toY(avgVal)
    const fmtVal = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)
    // 时间刻度格式：按窗口跨度进位（秒/分/日）
    const two = (x: number) => x.toString().padStart(2, "0")
    const fmtTick = (ts: number) => {
      const d = new Date(ts)
      if (tSpan >= 24 * 3600_000) return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
      if (tSpan < 10 * 60_000) return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
      return `${two(d.getHours())}:${two(d.getMinutes())}`
    }
    const xTicks = Array.from({ length: 5 }, (_, i) => v0 + (tSpan * i) / 4)
    // 气泡宽度按视觉列宽估算（CJK 双宽；10px 字号下的实测近似）
    const textW = (s: string) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 12.6 : 6.3), 0)
    // 采样：稀疏序列逐点成线；超出容量按窗口时间桶聚合——均值成线，
    // min-max 成包络带（峰值不因聚合而抹平，轴与包络顶处处一致）
    const samples: { ts: number; v: number; lo: number; hi: number; cnt: number }[] = []
    if (n <= SAMPLE_MAX) {
      for (const p of tsPoints) {
        const v = p[m.key]
        samples.push({ ts: p.ts, v, lo: v, hi: v, cnt: 1 })
      }
    } else {
      const acc: ({ sum: number; cnt: number; lo: number; hi: number; tSum: number } | null)[] = new Array(SAMPLE_MAX).fill(null)
      for (const p of tsPoints) {
        const v = p[m.key]
        const bi = tSpan > 0 ? Math.min(SAMPLE_MAX - 1, Math.floor(((p.ts - v0) / tSpan) * SAMPLE_MAX)) : 0
        const b = acc[bi] ??= { sum: 0, cnt: 0, lo: Infinity, hi: -Infinity, tSum: 0 }
        b.sum += v
        b.cnt += 1
        b.lo = Math.min(b.lo, v)
        b.hi = Math.max(b.hi, v)
        b.tSum += p.ts
      }
      for (const b of acc) {
        if (b) samples.push({ ts: b.tSum / b.cnt, v: b.sum / b.cnt, lo: b.lo, hi: b.hi, cnt: b.cnt })
      }
    }
    // 路径：均值线（平滑）+ 线下渐变面积 + 聚合时的 min-max 包络带
    const yBase = padT + chartH
    const linePts = samples.map(s => ({ x: xOf(s.ts), y: toY(s.v) }))
    const lineD = smoothPath(linePts)
    const single = samples.length <= 1
    const areaD = single ? "" : `${lineD} L${linePts[linePts.length - 1].x.toFixed(1)} ${yBase} L${linePts[0].x.toFixed(1)} ${yBase} Z`
    const bandD = samples.length > 1 && samples.length < n
      ? `${smoothPath(samples.map(s => ({ x: xOf(s.ts), y: toY(s.hi) })))} ${smoothPath([...samples].reverse().map(s => ({ x: xOf(s.ts), y: toY(s.lo) })), "L")} Z`
      : null
    // 峰值样本（含全局峰值的桶/点）
    let iPeakS = 0
    samples.forEach((s, i) => { if (s.hi > samples[iPeakS].hi) iPeakS = i })
    // 统计口径随窗口（可见范围即分析范围）；空窗不给假数值
    const stats = n === 0
      ? [
          { label: "均值", v: "—" },
          { label: "峰值", v: "—" },
          { label: "谷值", v: "—" },
          { label: "轮次", v: "0" },
        ]
      : [
          { label: "均值", v: fmtVal(avgVal) },
          { label: "峰值", v: fmtVal(maxVal) },
          { label: "谷值", v: fmtVal(minVal) },
          { label: "轮次", v: String(n) },
        ]
    return { samples, lineD, areaD, bandD, single, empty: n === 0, iPeakS, maxVal, avgVal, yMax, xOf, tOf, toY, avgY, fmtVal, fmtTick, xTicks, textW, fmtTime, stats }
  }, [sorted, m, win, cw])

  // 容器宽实测：像素宽直写 viewBox（1:1 满铺，meet 留白退场）；无测量
  // 环境保持回退几何。挂载点随数据在场与否变化（空态早退无 wrap div），
  // 观测随其重建
  const hasGeo = geo != null
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width)
      if (w <= 0) return
      setWrapW(prev => (Math.abs(prev - w) < 4 ? prev : w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasGeo])

  if (!geo) {
    return <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">暂无性能数据</div>
  }

  const { samples, lineD, areaD, bandD, single, empty, iPeakS, maxVal, avgVal, yMax, xOf, tOf, toY, avgY, fmtVal, fmtTick, xTicks, textW, fmtTime, stats } = geo

  // 光标读数：相邻样本线性内插——焦点点骑线随鼠标（端点外钳到首尾样
  // 本，线不存在处不悬空）；稠密桶的 lo~hi 取最近桶作上下文
  const readAt = (x: number) => {
    if (samples.length === 0) return null
    let prev = samples[0]
    for (let i = 1; i < samples.length; i++) {
      const cur = samples[i]
      const x1 = xOf(cur.ts)
      if (x <= x1) {
        const x0 = xOf(prev.ts)
        const f = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 0
        return { v: prev.v + (cur.v - prev.v) * f, near: f < 0.5 ? prev : cur }
      }
      prev = cur
    }
    return { v: prev.v, near: prev }
  }

  // 拖拽平移：按下即以像素→时间比例移动窗口（钳制在全程内），内容跟手；
  // 未按下时走悬停定位——viewBox 坐标反演 + 最近样本。重活路径在 memo
  // 内，重渲染只触十字线/气泡/窗口轻量子树
  const onMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (dragRef.current && full && full.tMax - full.tMin > 0) {
      const { x, v0, v1 } = dragRef.current
      const span = v1 - v0
      const dxv = (e.clientX - x) / viewScaleOf(rect, drawW)
      const n0 = Math.min(Math.max(v0 - (dxv / cw) * span, full.tMin), full.tMax - span)
      dragRef.current = { x: e.clientX, v0: n0, v1: n0 + span }
      setWin([n0, n0 + span])
      return
    }
    const vx = viewXOf(rect, e.clientX, drawW)
    if (vx < padL - 2 || vx > drawW - padR + 2) {
      setCursor(null)
      return
    }
    setCursor(Math.round(Math.min(drawW - padR, Math.max(padL, vx))))
  }

  const onDown = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (!win || !full || full.tMax - full.tMin <= 0) return
    dragRef.current = { x: e.clientX, v0: win[0], v1: win[1] }
    setDragging(true)
  }
  const endDrag = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
  }

  // 当前窗宽相对全程的倍率（工具条读数；全程恒 100%）
  const ratio = full && win ? Math.round(((full.tMax - full.tMin) / Math.max(win[1] - win[0], 1)) * 100) : 100

  return (
    <div>
      {/* 统计条 + 指标切换：标签上/值下，互为倒数的双镜头单图呈现；指标
          切换重挂重放错峰上浮入场 */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pb-3">
        <div key={m.key} className="flex items-end gap-x-7 animate-in fade-in slide-in-from-bottom-1 duration-300">
          {stats.map((s, i) => (
            <div key={s.label} className="perf-stat-in" style={{ animationDelay: `${i * 45}ms` }}>
              <div className="text-[10.5px] font-medium tracking-wide text-muted-foreground/80">{s.label}</div>
              <div className="text-[17px] leading-6 font-semibold tabular-nums">{s.v}</div>
            </div>
          ))}
          <div className="pb-1 text-[10.5px] text-muted-foreground/70">{m.unit}</div>
        </div>
        <PerfSegmented
          ariaLabel="效率指标切换"
          value={metric}
          options={[{ value: "tps" as const, label: "TPS" }, { value: "tpot" as const, label: "TPOT" }]}
          onChange={setMetric}
        />
      </div>

      <div ref={wrapRef} className="relative">
        <svg
          key={m.key}
          data-bench=""
          viewBox={`0 0 ${drawW} ${H}`}
          width="100%"
          height={H}
          className={cn(
            "block select-none animate-in fade-in slide-in-from-bottom-1 duration-300",
            dragging ? "cursor-grabbing" : win ? "cursor-grab" : "",
          )}
          onMouseMove={onMove}
          onMouseDown={onDown}
          onMouseUp={endDrag}
          onMouseLeave={() => { endDrag(); setCursor(null) }}
        >
        <defs>
          <linearGradient id={`perf-bench-${m.key}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={m.color} stopOpacity={0.16} />
            <stop offset="1" stopColor={m.color} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* 发丝网格（顶/中虚线 + 基线实线）与刻度 */}
        {[yMax, yMax / 2, 0].map((v, i) => {
          const y = toY(v)
          return (
            <g key={i}>
              {v > 0
                ? <line x1={padL} y1={y} x2={drawW - padR} y2={y} stroke={PERF_COLORS.grid} strokeWidth={0.5} strokeDasharray="2 3" />
                : <line x1={padL} y1={y} x2={drawW - padR} y2={y} stroke={PERF_COLORS.axis} strokeWidth={1} />}
              <text x={padL - 5} y={y + 3.5} textAnchor="end" fontSize="10" className="fill-muted-foreground tabular-nums">{fmtVal(v)}</text>
            </g>
          )
        })}

        {/* 均值参考线（空窗不给假数值） */}
        {!empty && (
          <>
            <line x1={padL} y1={avgY} x2={drawW - padR} y2={avgY} stroke={m.color} strokeWidth={1} strokeDasharray="4 3" opacity={0.5} />
            <text x={drawW - padR} y={avgY - 4} textAnchor="end" fontSize="10" fill={m.color} className="tabular-nums">均值 {fmtVal(avgVal)}</text>
          </>
        )}

        {/* min-max 包络带（样本聚合时）：离群峰不因平滑而抹平 */}
        {bandD && <path d={bandD} fill={m.color} opacity={0.12} className="perf-band-in" />}

        {/* 平滑折线 + 线下渐变面积；单点退化为圆点。入场走归一化描画
            （pathLength=1 + dash 动画），指标切换重挂重放 */}
        {empty ? null : single
          ? <circle cx={xOf(samples[0].ts)} cy={toY(samples[0].v)} r={3} fill={m.color} />
          : <>
              <path d={areaD} fill={`url(#perf-bench-${m.key})`} className="perf-area-in" />
              <path d={lineD} fill="none" stroke={m.color} strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" className="perf-line-draw" />
            </>}

        {/* 峰值点标值（峰值样本所在时刻）：光晕环 + 实心点，弹出入场 */}
        {!empty && (() => {
          const s = samples[iPeakS]
          const px = xOf(s.ts)
          return (
            <g className="perf-peak-in">
              <circle cx={px} cy={toY(maxVal)} r={5} fill="none" stroke={m.color} strokeWidth={1} opacity={0.35} />
              <circle cx={px} cy={toY(maxVal)} r={2.5} fill={m.color} />
              <text
                x={px}
                y={toY(maxVal) - 7}
                textAnchor={px > drawW - padR - 44 ? "end" : px < padL + 44 ? "start" : "middle"}
                fontSize="10.5"
                fontWeight={600}
                fill={m.color}
                className="tabular-nums"
              >
                {fmtVal(maxVal)}
              </text>
            </g>
          )
        })()}

        {/* x 轴时间刻度（首尾贴边对齐，中间居中） */}
        {xTicks.map((ts, i) => (
          <text
            key={i}
            x={xOf(ts)}
            y={H - 8}
            textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
            fontSize="10"
            className="fill-muted-foreground tabular-nums"
          >
            {fmtTick(ts)}
          </text>
        ))}

        {/* 空窗提示（缩放/平移到无轮次的时间段） */}
        {empty && (
          <text x={padL + cw / 2} y={padT + chartH / 2 + 3.5} textAnchor="middle" fontSize="10" className="fill-muted-foreground">
            该时间窗内无轮次
          </text>
        )}

        {/* 悬停：十字线随光标 + 骑线焦点（内插跟手）+ 数值气泡（SVG 内定位，不随容器缩放错位） */}
        {cursor != null && (() => {
          const r = readAt(cursor)
          if (!r) return null
          // 焦点钳在线的横向范围内（线外区域十字线仍随光标，点不悬空）
          const dx = Math.min(Math.max(cursor, xOf(samples[0].ts)), xOf(samples[samples.length - 1].ts))
          const hy = toY(r.v)
          const tAt = tOf(dx)
          const l1 = tAt ? fmtTime(tAt) : "—"
          const l2 = r.near.cnt > 1 ? `均值 ${fmtVal(r.v)} · ${fmtVal(r.near.lo)}~${fmtVal(r.near.hi)} ${m.unit}` : `${fmtVal(r.v)} ${m.unit}`
          const w = Math.max(textW(l1), textW(l2)) + 18
          const bx = Math.max(padL, Math.min(drawW - padR - w, cursor - w / 2))
          const by = Math.max(2, hy - 46)
          return (
            <g pointerEvents="none" className="animate-in fade-in duration-150">
              <line x1={cursor} y1={padT} x2={cursor} y2={padT + chartH} stroke={PERF_COLORS.axis} strokeWidth={1} strokeDasharray="3 3" opacity={0.55} />
              <circle cx={dx} cy={hy} r={7} fill={m.color} opacity={0.14} />
              <circle cx={dx} cy={hy} r={3} fill={m.color} />
              <rect x={bx} y={by} width={w} height={34} rx={9} className="fill-card" stroke={PERF_COLORS.axis} strokeOpacity={0.4} strokeWidth={1} />
              <text x={bx + w / 2} y={by + 13.5} textAnchor="middle" fontSize="10" className="fill-muted-foreground tabular-nums">{l1}</text>
              <text x={bx + w / 2} y={by + 27.5} textAnchor="middle" fontSize="11.5" fontWeight={700} fill={m.color} className="tabular-nums">{l2}</text>
            </g>
          )
        })()}
        </svg>

        {/* 玻璃工具条（Context 趋势图同款浮层 chrome）：时间窗缩放/平移/适配 */}
        <div className="run-glass absolute right-2 bottom-2 flex items-center rounded-xl">
          <button
            type="button" title="缩小（Ctrl + 滚轮）" aria-label="缩小"
            onClick={() => zoomAt(1 / 1.15, padL + cw / 2)}
            className="run-tool-btn flex size-7 items-center justify-center text-[#57606a] hover:bg-black/[0.05] hover:text-[#1f2328]"
          >
            <ZoomOutIcon className="size-3.5" />
          </button>
          <span className="w-11 text-center text-[11px] tabular-nums text-[#57606a]" title="当前时间窗倍率">{ratio}%</span>
          <button
            type="button" title="放大（Ctrl + 滚轮）" aria-label="放大"
            onClick={() => zoomAt(1.15, padL + cw / 2)}
            className="run-tool-btn flex size-7 items-center justify-center text-[#57606a] hover:bg-black/[0.05] hover:text-[#1f2328]"
          >
            <ZoomInIcon className="size-3.5" />
          </button>
          <span className="h-3.5 w-px bg-black/10" aria-hidden />
          <button
            type="button" title="适配全程" aria-label="适配全程"
            onClick={() => setWin(null)}
            className="run-tool-btn flex size-7 items-center justify-center text-[#57606a] hover:bg-black/[0.05] hover:text-[#1f2328]"
          >
            <MaximizeIcon className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
