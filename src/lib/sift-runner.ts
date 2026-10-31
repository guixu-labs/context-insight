// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/**
 * Server-only（spawn/child_process）：spawn sift audit，流式读 stdout，解析 on_progress
 * 输出算百分比，事件以 NDJSON 回传前端。管道模式（非 tty）下 rich 输出纯文本，可可靠解析。
 *
 * 进度结构（auditor.py 的 on_progress）：
 *   "对账 transcript k/N: name"                          — transcript 层进度
 *   "  [精筛] 批 k/total 判定 N 条…" / "…完成 ⏱ Xs"      — 精筛(refine)
 *   "  [headline] 批 k/total 判定 N 条…" / "…完成 ⏱ Xs"  — headline
 *   "  [条件性|禁令|步骤] 批 k/total 判定 N 条…"          — 3 类 LLM 判定并发
 *   "  [条件性|禁令|步骤] 批 k/total 完成 ⏱ Xs"
 *
 * 进度模型（v2.03 修正）：预处理（精筛+headline）占 0→15%；判定段 15→95% 按**全局批计数**
 * ——所有已见过的 [label] 批 k/total 累计（完成批数/总批数），不再"3 类各自平均"：
 * 步骤类 24 批 × 禁令/条件性各 3 批的真实场景下，快类提前完成曾把三类平均顶到高位、
 * 之后长时间不动（"卡 95%"观感）。95→100% 由 close 时读报告/发 result 填上，无静默段。
 *
 * 看门狗：LLM 批次实测 40s~21min（thinking 顶满 max_tokens 触发整批重试），正常静默可很长；
 * 但进程崩溃/孤儿化（实测出现过：sift 死、claude 孤儿、close 不来）会让流永远挂着。
 * SILENCE_KILL_MS（默认 12min）内无任何 stdout 输出 → 判定挂死，SIGKILL + error 事件收尾。
 */
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { AuditLayerInfo, AuditMemberMap, AuditMemberRef } from "@/lib/sift-audit-types"
import { logError, logInfo, logWarn } from "@/lib/logger"

export interface SiftEvent {
  stage: "progress" | "result" | "error"
  percent?: number
  msg?: string
  /** 组合进度行（判定 12/72 批 · transcript 3/8），面板 running 态主显。 */
  status?: string
  report?: unknown
  _html?: string
  /** root 组合声明的层信息（规程/计划），随 result 事件回传供前端 finding 分层徽章。 */
  _layers?: AuditLayerInfo[]
  /** run 级对账的成员映射（transcript 文件名 → 成员），随 result 事件回传供 finding 深链。 */
  _members?: AuditMemberMap
}

/** 判定段阶段名（每个 transcript 切片独立重跑；单批时无批号）。
 * headline 标签是 ASCII：sift CLI 的 rich console 把 `[headline]` 当标记语言标签
 * 吞掉，stdout 里以裸「批 k/N」形态到达（中文标签不匹配 tag 正则，原样保留）。 */
type JudgeKey = "条件性" | "禁令" | "步骤" | "控制流"

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

/** 看门狗：连续静默超过此时长（无 stdout 行）→ 判挂死杀进程。LLM 单批实测可达 21min，
 * 取 12min：比正常最慢批次略宽，又能比 30min 硬超时更早暴露孤儿/死进程。 */
export const SILENCE_KILL_MS = 12 * 60 * 1000

// ── 进度模型（完成行驱动 + 成本加权 + 全程单调） ───────────────────────────
// 实测口径（8 成员 run，~590s）：「批 k/N 判定 N 条…」是开始行——sift 并行提交
// 一次性全发，不构成进度；「…完成 ⏱」才是真实推进。每切片独立重跑判定 4 类，
// 跨切片累计。百分比 = 完成成本 / 预期成本（单元数 × 实测单元耗时），分母在
// 阶段揭示前用典型值占位、揭示后自我修正，全程单调不减。

/** 单元成本（秒）：精筛 ~1.4s/批、headline ~2s/批、判定段（4 类合一）~8s/批。 */
const REFINE_UNIT_S = 1.5
const HEADLINE_UNIT_S = 2
const JUDGE_UNIT_S = 8
/** 判定后的收尾（写报告/发 result）固定预估。 */
const TAIL_UNIT_S = 10
/** 判定段单切片默认单元数（3+3+2+1 实测口径），切片揭示后按实际修正。 */
const JUDGE_UNITS_PER_SLICE = 9
/** 精筛/headline 未揭示时的占位成本（缓存命中时无批行，判定段开始后归零）。 */
const PREPROCESS_PLACEHOLDER_S = 12

/** 单个批式阶段（精筛/headline；整个 run 一轮，以「总批数变化」识别新波次）。
 * 只数完成行并按批号去重。 */
class BatchPhase {
  private waveN = 0
  private seen = new Set<number>()
  private totalAcc = 0
  private doneAcc = 0
  private pinned = false

  onBatch(k: number, n: number, done: boolean): void {
    if (n !== this.waveN) {
      this.totalAcc += this.waveN
      this.doneAcc += this.seen.size
      this.seen.clear()
      this.waveN = n
    }
    if (done) this.seen.add(k)
  }

  /** 收口：缓存命中（无批行）或判定段已开始（预处理严格在判定前，视作完成）。 */
  pin(): void {
    this.totalAcc += this.waveN
    this.doneAcc += this.seen.size
    this.seen.clear()
    this.waveN = 0
    this.pinned = true
  }

  get total(): number {
    return this.totalAcc + this.waveN
  }

  get done(): number {
    const d = this.doneAcc + this.seen.size
    return this.pinned ? this.total : Math.min(d, this.total)
  }
}

/** sift stdout 进度模型。 */
export class SiftProgressModel {
  private started = false
  private lastPct = 0
  private expectedSlices: number
  private transcriptTotal = 1
  private sliceIdx = 0
  private judgesStarted = false
  private readonly refine = new BatchPhase()
  private readonly headline = new BatchPhase()
  private judgeDone = 0
  private sliceSeen = new Set<string>()
  private stageRevealed: Partial<Record<JudgeKey, number>> = {}
  private maxSliceUnits = JUDGE_UNITS_PER_SLICE

  constructor(expectedSlices = 1) {
    this.expectedSlices = Math.max(1, Math.floor(expectedSlices) || 1)
  }

  onLine(line: string): void {
    this.started = true
    const tm = line.match(/对账 transcript\s+(\d+)\/(\d+)/)
    if (tm) {
      this.enterSlice(parseInt(tm[1], 10), parseInt(tm[2], 10))
      return
    }
    const lm = line.match(/^\[(精筛|条件性|禁令|步骤|控制流)\]\s*(.*)$/)
    if (lm) {
      this.onStageLine(lm[1] as JudgeKey | "精筛", lm[2] ?? "")
      return
    }
    const bm = line.match(/^批\s*(\d+)\/(\d+)/)
    if (bm) {
      // rich 吞掉 [headline] 标签后的裸批行
      this.headline.onBatch(parseInt(bm[1], 10), parseInt(bm[2], 10), line.includes("完成"))
    }
    // 其余行（重试/通道回退/文件名/警告）只作活性信号，不入账
  }

  private enterSlice(idx: number, total: number): void {
    this.markJudgesStarted()
    this.sliceIdx = idx
    this.transcriptTotal = Math.max(1, total)
    // 收口上一片：单切片单元数取历史最大，外推剩余切片的分母
    this.maxSliceUnits = Math.max(this.maxSliceUnits, this.sliceUnits())
    this.sliceSeen = new Set()
    this.stageRevealed = {}
  }

  private onStageLine(stage: JudgeKey | "精筛", rest: string): void {
    if (stage === "精筛") {
      const bm = rest.match(/批\s*(\d+)\/(\d+)/)
      if (bm) {
        this.refine.onBatch(parseInt(bm[1], 10), parseInt(bm[2], 10), rest.includes("完成"))
      } else if (rest.includes("判定")) {
        this.refine.onBatch(1, 1, rest.includes("完成"))
      } else if (rest.includes("完成")) {
        // 单发精筛（只一批时无批号）的完成行
        this.refine.onBatch(1, 1, true)
      } else if (rest.includes("滤除") || rest.includes("无候选")) {
        this.refine.pin()
      }
      return
    }
    this.markJudgesStarted()
    const bm = rest.match(/批\s*(\d+)\/(\d+)/)
    if (bm) {
      const k = parseInt(bm[1], 10)
      const n = parseInt(bm[2], 10)
      this.stageRevealed[stage] = Math.max(this.stageRevealed[stage] ?? 0, n)
      if (rest.includes("完成") && !this.sliceSeen.has(`${stage}:${k}`)) {
        this.sliceSeen.add(`${stage}:${k}`)
        this.judgeDone += 1
      }
      return
    }
    // 单发（该类只一批时无批号）：判定 = 揭示 1 单元；完成 = 入账 1 单元
    if (rest.includes("判定")) {
      this.stageRevealed[stage] = Math.max(this.stageRevealed[stage] ?? 0, 1)
    } else if (rest.includes("完成") && !this.sliceSeen.has(`${stage}:~`)) {
      this.sliceSeen.add(`${stage}:~`)
      this.judgeDone += 1
    }
  }

  private markJudgesStarted(): void {
    if (this.judgesStarted) return
    this.judgesStarted = true
    this.refine.pin()
    this.headline.pin()
  }

  private sliceUnits(): number {
    let s = 0
    for (const n of Object.values(this.stageRevealed)) s += n ?? 0
    return s
  }

  private judgeExpected(): number {
    const perSlice = Math.max(this.maxSliceUnits, this.sliceUnits())
    const total = perSlice * Math.max(this.transcriptTotal, this.expectedSlices)
    return Math.max(this.judgeDone, total)
  }

  percent(): number {
    if (!this.started) return 0
    const refineS = this.refine.total > 0 ? this.refine.total * REFINE_UNIT_S : this.judgesStarted ? 0 : PREPROCESS_PLACEHOLDER_S
    const headS = this.headline.total > 0 ? this.headline.total * HEADLINE_UNIT_S : this.judgesStarted ? 0 : PREPROCESS_PLACEHOLDER_S
    const expected = refineS + headS + this.judgeExpected() * JUDGE_UNIT_S + TAIL_UNIT_S
    const done =
      Math.min(this.refine.done, this.refine.total) * REFINE_UNIT_S +
      Math.min(this.headline.done, this.headline.total) * HEADLINE_UNIT_S +
      this.judgeDone * JUDGE_UNIT_S
    const frac = expected > 0 ? Math.min(done / expected, 1) : 0
    const pct = Math.min(95, Math.max(3, Math.round(3 + 92 * frac)))
    this.lastPct = Math.max(this.lastPct, pct)
    return this.lastPct
  }

  /** 面板 running 态的组合进度行（原始行仍随 msg 透传，title 里可见）。 */
  describe(): string {
    if (!this.started) return "sift 对账启动中…"
    if (this.judgesStarted) {
      const exp = this.judgeExpected()
      if (this.judgeDone >= exp) return "汇总判定结果…"
      const slice = this.transcriptTotal > 1 && this.sliceIdx > 0 ? ` · transcript ${this.sliceIdx}/${this.transcriptTotal}` : ""
      return `判定 ${this.judgeDone}/${exp} 批${slice}`
    }
    if (this.refine.total > 0) return `精筛 ${Math.min(this.refine.done, this.refine.total)}/${this.refine.total}`
    if (this.headline.total > 0) return `标题生成 ${Math.min(this.headline.done, this.headline.total)}/${this.headline.total}`
    return "预处理声明中…"
  }
}

/**
 * result 时点解析成员映射（finding.transcript → 成员）：
 * - `--run` 原生对账：report.run.units 是权威（auditUnitId = 审计单元显示名，
 *   即 findings.transcript 的取值域），按 sessionId 归到成员；
 * - DB transcript 路径：`--kind` 切片名 = `{原始stem}-{name}-{ti}-{i}.jsonl`
 *   （切片文件名即 findings.transcript），按 stem 前缀回映射——路由侧预置的
 *   `成员A.json` 键覆盖不到切片名，此处补齐（最长 stem 优先，防标签前缀重叠）。
 */
function resolveMemberMap(
  report: unknown,
  members: AuditMemberMap | undefined,
  memberBySession: Record<string, AuditMemberRef> | undefined,
): AuditMemberMap | undefined {
  if (members == null && memberBySession == null) return undefined
  const typed = report as { transcripts?: string[]; run?: { units?: Array<{ auditUnitId: string; sessionId: string }> } }
  const units = typed?.run?.units
  if (units?.length && memberBySession != null) {
    const out: AuditMemberMap = { ...(members ?? {}) }
    for (const u of units) {
      const ref = memberBySession[u.sessionId]
      if (ref) out[u.auditUnitId] = ref
    }
    return out
  }
  if (members == null) return undefined
  const transcripts = typed?.transcripts
  if (!transcripts?.length) return members
  const stems = Object.keys(members)
    .map(k => ({ key: k, stem: k.replace(/\.(json|jsonl)$/, "") }))
    .sort((a, b) => b.stem.length - a.stem.length)
  const out: AuditMemberMap = { ...members }
  for (const t of transcripts) {
    if (out[t] != null) continue
    const hit = stems.find(s => t === s.key || t.startsWith(`${s.stem}-`))
    if (hit) out[t] = members[hit.key]
  }
  return out
}

function runSiftAuditStreaming(opts: {
  args: string[]
  outputDir: string
  onEvent: (e: SiftEvent) => void
  timeoutMs?: number
  silenceKillMs?: number
  layers?: AuditLayerInfo[]
  members?: AuditMemberMap
  /** `--run` 原生对账：sessionId → 成员（report.run.units 归因用）。 */
  memberBySession?: Record<string, AuditMemberRef>
  /** 进度分母外推用的切片数提示（DB 路径 = transcript 数；--run = 成员数）。 */
  expectedSlices?: number
}): Promise<void> {
  const { args, outputDir, onEvent, layers, members, memberBySession, expectedSlices, timeoutMs = 1_800_000, silenceKillMs = SILENCE_KILL_MS } = opts
  return new Promise<void>((resolve) => {
    const model = new SiftProgressModel(expectedSlices ?? 1)
    let lastProgressMsg = ""
    let settled = false
    // 前置声明（finish/resetSilenceTimer 引用，赋值在 spawn 之后）
    const timerRef: { t?: ReturnType<typeof setTimeout> } = {}
    let silenceTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timerRef.t)
      clearTimeout(silenceTimer)
      resolve()
    }

    function handleLine(raw: string): void {
      const line = raw.replace(ANSI_RE, "").replace(/\r/g, "").trim()
      if (!line) return
      lastProgressMsg = line
      // 看门狗喂狗：sift 还在输出（哪怕只是重试提示）就不算挂死
      resetSilenceTimer()

      model.onLine(line)
      onEvent({ stage: "progress", percent: model.percent(), msg: line, status: model.describe() })
    }

    const t0 = Date.now()
    logInfo("sift", "audit start", { kind: args.includes("--kind") ? (args[args.indexOf("--kind") + 1] ?? "") : "", outputDir })
    let proc: ChildProcess
    try {
      proc = spawn("sift", args, {
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (e: unknown) {
      onEvent({ stage: "error", msg: e instanceof Error ? e.message : String(e) })
      resolve()
      return
    }

    let stdoutBuf = ""
    let stderrBuf = ""
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8")
      const lines = stdoutBuf.split(/\n/)
      stdoutBuf = lines.pop() ?? ""
      for (const l of lines) handleLine(l)
    })
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8")
    })

    timerRef.t = setTimeout(() => {
      try {
        proc.kill("SIGKILL"); logWarn("sift", "静默超时击杀", { ms: Date.now() - t0 })
      } catch {
        /* ignore */
      }
      onEvent({
        stage: "error",
        msg: `sift audit 超过 ${Math.round(timeoutMs / 60000)} 分钟总时限，已终止（LLM 判定批次过慢，可减小声明规模后重跑）。`,
      })
      finish()
    }, timeoutMs)

    // 静默看门狗：每次 stdout 输出重置；连续静默超 silenceKillMs → 判挂死。
    // LLM 单批实测可达 21min（thinking 顶满 max_tokens 整批重试），静默阈值须比单批
    // 慢尾更宽才不误杀——默认 SILENCE_KILL_MS=12min 对慢批会误杀？
    // 不会：单批执行期间每 40s~257s 有 "判定 N 条…" / "重试 k/4…" 输出持续喂狗，
    // 真正的静默只出现在进程死亡（close 丢失）或 LLM 彻底无响应。
    function resetSilenceTimer(): void {
      clearTimeout(silenceTimer)
      silenceTimer = setTimeout(() => {
        if (settled) return
        try {
          proc.kill("SIGKILL"); logWarn("sift", "静默超时击杀（兜底）", { ms: Date.now() - t0 })
        } catch {
          /* ignore */
        }
        onEvent({
          stage: "error",
          msg: `sift audit 已 ${Math.round(silenceKillMs / 60000)} 分钟无任何输出，判定挂死（进程崩溃或 LLM 无响应），已终止。最后输出：${(lastProgressMsg || "(无)").slice(0, 200)}`,
        })
        finish()
      }, silenceKillMs)
    }
    resetSilenceTimer()

    proc.on("error", (e: Error & { code?: string }) => {
      if (settled) { resolve(); return }
      settled = true
      clearTimeout(timerRef.t)
      clearTimeout(silenceTimer)
      if (e.code === "ENOENT") {
        logError("sift", "sift 未找到（不在 PATH）", { ms: Date.now() - t0 })
        onEvent({ stage: "error", msg: "sift 未找到：装好 sift 并确保 `sift` 在 PATH。" })
      } else {
        logError("sift", "spawn 失败", { error: e.message, ms: Date.now() - t0 })
        onEvent({ stage: "error", msg: e.message })
      }
      resolve()
    })

    proc.on("close", (code: number | null) => {
      if (settled) { resolve(); return }
      settled = true
      clearTimeout(timerRef.t)
      clearTimeout(silenceTimer)
      if (stdoutBuf) handleLine(stdoutBuf)
      if (code !== 0) {
        const tail = stderrBuf.trim().slice(-500)
        logError("sift", "audit 失败", { code: code ?? null, tail: tail.slice(0, 300), ms: Date.now() - t0 })
        onEvent({
          stage: "error",
          msg: `sift audit 失败${code != null ? ` (exit ${code})` : ""}${tail ? `: ${tail}` : ""}`,
        })
        resolve()
        return
      }
      const reportPath = path.join(outputDir, "audit-report.json")
      if (!fs.existsSync(reportPath)) {
        logError("sift", "跑完但报告缺失", { reportPath, ms: Date.now() - t0 })
        onEvent({ stage: "error", msg: "sift 跑完但没产出 audit-report.json。" })
        resolve()
        return
      }
      let report: unknown
      try {
        report = JSON.parse(fs.readFileSync(reportPath, "utf8"))
      } catch (e: unknown) {
        logError("sift", "报告解析失败", { error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 })
        onEvent({ stage: "error", msg: `audit-report.json 解析失败：${e instanceof Error ? e.message : String(e)}` })
        resolve()
        return
      }
      const htmlPath = path.join(outputDir, "audit-report.html")
      const _html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : undefined
      logInfo("sift", "audit done", { ms: Date.now() - t0 })
      onEvent({ stage: "result", percent: 100, report, _html, _layers: layers, _members: resolveMemberMap(report, members, memberBySession) })
      resolve()
    })
  })
}

/**
 * 把一次 sift audit 跑成 NDJSON 流式 Response（progress → result/error）。
 * 路由 prep 好 args + outputDir 后调用本函数返回给前端。
 * cleanup 在流结束（无论成功/失败）后调用——tmp 目录的清理必须等流消费完（sift 跑完），
 * 不能在路由 return 时就删（否则 sift 还没读到 SKILL.md/session.json）。
 * extras._layers：root 组合声明的层信息，随 result 事件一并回传（前端 finding 归层徽章）。
 * extras._members：run 级对账的成员映射（transcript 文件名 → 成员，前端 finding 深链）。
 * extras._memberBySession：`--run` 原生对账的 sessionId → 成员表（report.run.units 归因）。
 * extras.expectedSlices：进度分母外推的切片数提示（不传按 1，transcript 头输出后自动修正）。
 */
export function makeStreamingAuditResponse(
  args: string[],
  outputDir: string,
  cleanup?: () => void,
  extras?: { _layers?: AuditLayerInfo[]; _members?: AuditMemberMap; _memberBySession?: Record<string, AuditMemberRef>; expectedSlices?: number },
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: SiftEvent): void => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"))
      }
      try {
        await runSiftAuditStreaming({
          args,
          outputDir,
          onEvent: send,
          layers: extras?._layers,
          members: extras?._members,
          memberBySession: extras?._memberBySession,
          expectedSlices: extras?.expectedSlices,
        })
      } catch (e: unknown) {
        send({ stage: "error", msg: e instanceof Error ? e.message : String(e) })
      } finally {
        try {
          cleanup?.()
        } catch {
          /* cleanup 失败忽略 */
        }
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
