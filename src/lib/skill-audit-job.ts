// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/**
 * Skill audit job store：把单个 target 的 running/result/error 提升到模块级，让组件 unmount
 *（切到别的 tab）后正在跑的 fetch 继续在后台、状态保留；切回来 useSyncExternalStore 读回
 * running/result。cross-tab resume 模式，按 selKey 分键支持多 target 并发。
 *
 * result 同步写 sessionStorage（reload 后可恢复）；首次挂载时 hydrate 把 sessionStorage 灌进 store。
 */

import type { AuditLayerInfo, AuditMemberMap, AuditReport, SkillAuditStoredResult } from "@/lib/sift-audit-types"

export type AuditKind = "skill" | "agent" | "root" | "llm-root" | "run"

/**
 * store 侧的 result：AuditReport + 可选 _html（"在新页打开原始 HTML"逃生口）。
 * 从 sessionStorage 恢复 / NDJSON result 事件物化都是此 shape。
 */
export type SkillAuditResult = SkillAuditStoredResult

export interface SkillAuditJobState {
  running: boolean
  error: string | null
  result: SkillAuditResult | null
  /** 最新进度消息（sift on_progress 输出的一行）。 */
  progress: string | null
  /** 0-100，按 sift 的批次/完成解析的粗略百分比。 */
  percent: number
  /** 对账开始时间戳（ms），用于前端计算耗时。 */
  startedAt: number | null
  /** 最近一次进度输出的时间戳（ms）；与 startedAt 的差即"进度停滞时长"，
   * LLM 批次慢时 stagnation 大是正常（单批可达 20min），供前端给慢告警文案。 */
  lastProgressAt: number | null
}

const EMPTY_STATE: SkillAuditJobState = { running: false, error: null, result: null, progress: null, percent: 0, startedAt: null, lastProgressAt: null }

export function skillAuditKey(taskId: string, kind: AuditKind, name: string): string {
  return `${kind}:${taskId}:${name}`
}

/** run 级对账键：runId + kind + name（成员集由目标注册表确定性派生，不进键）。 */
export function runAuditKey(runId: string, kind: AuditKind, name: string): string {
  return `run:${runId}:${kind}:${name}`
}

const MAX_HTML_SIZE = 2_000_000
const STORAGE_KEY = (taskId: string, kind: AuditKind, name: string) => `skill-audit-${taskId}-${kind}-${name}`
const RUN_STORAGE_KEY = (runId: string, kind: AuditKind, name: string) => `run-audit-${runId}-${kind}-${name}`

const states = new Map<string, SkillAuditJobState>()
const snapshots = new Map<string, SkillAuditJobState>()
const listeners = new Set<() => void>()
/** 全局版本号：任一 job 更新即自增，订阅方（域摘要等聚合视图）据此重算。 */
let storeVersion = 0

function emit(): void {
  for (const l of listeners) l()
}

function update(key: string, patch: Partial<SkillAuditJobState>): void {
  const prev = states.get(key) ?? EMPTY_STATE
  const next: SkillAuditJobState = { ...prev, ...patch }
  states.set(key, next)
  snapshots.set(key, next)
  storeVersion += 1
  emit()
}

export function subscribeSkillAudit(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getSkillAuditSnapshot(key: string): SkillAuditJobState {
  return snapshots.get(key) ?? EMPTY_STATE
}

export function getSkillAuditServerSnapshot(): SkillAuditJobState {
  return EMPTY_STATE
}

/** store 版本快照（useSyncExternalStore 的聚合订阅锚：值变即重渲）。 */
export function getSkillAuditVersion(): number {
  return storeVersion
}

function persistToStorage(taskId: string, kind: AuditKind, name: string, r: SkillAuditResult): void {
  let toStore = r
  if (r._html && r._html.length > MAX_HTML_SIZE) toStore = { ...r, _html: undefined }
  try {
    sessionStorage.setItem(STORAGE_KEY(taskId, kind, name), JSON.stringify(toStore))
  } catch {
    /* quota */
  }
}

function persistRunToStorage(runId: string, kind: AuditKind, name: string, r: SkillAuditResult): void {
  let toStore = r
  if (r._html && r._html.length > MAX_HTML_SIZE) toStore = { ...r, _html: undefined }
  try {
    sessionStorage.setItem(RUN_STORAGE_KEY(runId, kind, name), JSON.stringify(toStore))
  } catch {
    /* quota */
  }
}

export function loadSkillAuditFromStorage(taskId: string, kind: AuditKind, name: string): SkillAuditResult | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY(taskId, kind, name))
    return raw ? (JSON.parse(raw) as SkillAuditResult) : null
  } catch {
    return null
  }
}

export function loadRunAuditFromStorage(runId: string, kind: AuditKind, name: string): SkillAuditResult | null {
  try {
    const raw = sessionStorage.getItem(RUN_STORAGE_KEY(runId, kind, name))
    return raw ? (JSON.parse(raw) as SkillAuditResult) : null
  } catch {
    return null
  }
}

/**
 * 首次挂载/reload 时把 sessionStorage 已有结果灌进 store（store 已有 live state 则跳过，免覆盖正在跑的）。
 * entries = 本 session 所有可对账 target，逐个尝试 hydrate。
 */
export function hydrateSkillAuditFromStorage(
  taskId: string,
  entries: Array<{ name: string; kind: AuditKind }>,
): void {
  for (const e of entries) {
    const key = skillAuditKey(taskId, e.kind, e.name)
    if (states.has(key)) continue
    const loaded = loadSkillAuditFromStorage(taskId, e.kind, e.name)
    if (loaded) update(key, { result: loaded })
  }
}

/** run 级对账的 hydrate（同 session 版语义）。 */
export function hydrateRunAuditFromStorage(
  runId: string,
  entries: Array<{ name: string; kind: AuditKind }>,
): void {
  for (const e of entries) {
    const key = runAuditKey(runId, e.kind, e.name)
    if (states.has(key)) continue
    const loaded = loadRunAuditFromStorage(runId, e.kind, e.name)
    if (loaded) update(key, { result: loaded })
  }
}

export function startSkillAudit(opts: {
  taskId: string
  kind: AuditKind
  name: string
  framework?: string
}): void {
  const { taskId, kind, name, framework } = opts
  const key = skillAuditKey(taskId, kind, name)
  if (states.get(key)?.running) return // 去重：已在跑则不重发（重跑 finished 时 running=false 可重启）
  update(key, { running: true, error: null, result: null, progress: null, percent: 0, startedAt: Date.now(), lastProgressAt: null })
  void runSkillAudit(taskId, kind, name, framework).catch((e: unknown) => {
    update(key, { running: false, error: e instanceof Error ? e.message : String(e), progress: null, startedAt: null, lastProgressAt: null })
  })
}

/** run 级对账：kind/name + 涉事成员 taskId 列表（缺省由端点取 run 全体；root 恒单成员）。 */
export function startRunAudit(opts: {
  runId: string
  kind: AuditKind
  name: string
  members?: string[]
}): void {
  const { runId, kind, name, members } = opts
  const key = runAuditKey(runId, kind, name)
  if (states.get(key)?.running) return
  update(key, { running: true, error: null, result: null, progress: null, percent: 0, startedAt: Date.now(), lastProgressAt: null })
  void (async () => {
    const res = await fetch(`/api/observe/run/${encodeURIComponent(runId)}/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, name, members }),
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const j = (await res.json()) as { error?: string }
        if (j?.error) msg = j.error
      } catch {
        /* 非 JSON 错误体则用 HTTP 状态 */
      }
      throw new Error(msg)
    }
    await consumeAuditStream(res, key, r => persistRunToStorage(runId, kind, name, r))
  })().catch((e: unknown) => {
    update(key, { running: false, error: e instanceof Error ? e.message : String(e), progress: null, startedAt: null, lastProgressAt: null })
  })
}

interface SiftStreamEvent {
  stage: "progress" | "result" | "error"
  percent?: number
  msg?: string
  /** 组合进度行（判定 12/72 批 · transcript 3/8），优先于原始 msg 展示。 */
  status?: string
  report?: AuditReport
  _html?: string
  /** root 组合声明的层信息（规程/计划），FindingCard 归层徽章用。 */
  _layers?: AuditLayerInfo[]
  /** run 级对账的成员映射（transcript 文件名 → 成员），finding 深链用。 */
  _members?: AuditMemberMap
}

/** NDJSON 对账流消费：progress → state 更新；result → persist + 落 store；error → 落 error。 */
async function consumeAuditStream(
  res: Response,
  key: string,
  persist: (r: SkillAuditResult) => void,
): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error("无法读取对账流")
  const decoder = new TextDecoder()
  let buf = ""
  const handle = (evt: SiftStreamEvent): void => {
    if (evt.stage === "progress") {
      update(key, { running: true, progress: evt.status ?? evt.msg ?? null, percent: evt.percent ?? 0, lastProgressAt: Date.now() })
    } else if (evt.stage === "result") {
      const r = {
        ...(evt.report ?? {}),
        _html: evt._html,
        _layers: evt._layers,
        _members: evt._members,
      } as SkillAuditResult
      persist(r)
      update(key, { running: false, result: r, progress: null, percent: 100, startedAt: null, lastProgressAt: null })
    } else if (evt.stage === "error") {
      update(key, { running: false, error: evt.msg ?? "对账失败", progress: null, startedAt: null, lastProgressAt: null })
    }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        handle(JSON.parse(line) as SiftStreamEvent)
      } catch {
        /* 半行 / 非 JSON 忽略 */
      }
    }
  }
  if (buf.trim()) {
    try {
      handle(JSON.parse(buf) as SiftStreamEvent)
    } catch {
      /* 尾行残缺忽略 */
    }
  }
  // 流结束若仍是 running（未收 result/error 事件）→ 视为异常结束
  if (states.get(key)?.running) {
    update(key, { running: false, error: "对账流结束但未收到结果", progress: null, startedAt: null, lastProgressAt: null })
  }
}

async function runSkillAudit(
  taskId: string,
  kind: AuditKind,
  name: string,
  framework?: string,
): Promise<void> {
  const key = skillAuditKey(taskId, kind, name)
  // skill / root 都走 audit-skillsift（root 的声明同 skill——从 session 恢复 SKILL.md，
  // 只是 --kind root 切主 agent 作用域）；agent 走 audit-agentsift。skill 路由按 body.kind 选 --kind。
  const useSkillRoute = kind === "skill" || kind === "root" || kind === "llm-root"
  try {
    const res = await fetch(useSkillRoute ? "/api/ai/audit-skillsift" : "/api/ai/audit-agentsift", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        useSkillRoute ? { taskId, skillName: name, kind, framework } : { taskId, agentName: name, framework },
      ),
    })
    if (!res.ok) {
      // 路由 prep 失败返回 JSON {error}；流式端点正常时 res.ok 且 body 是 NDJSON
      let msg = `HTTP ${res.status}`
      try {
        const j = (await res.json()) as { error?: string }
        if (j?.error) msg = j.error
      } catch {
        /* 非 JSON 错误体则用 HTTP 状态 */
      }
      throw new Error(msg)
    }
    await consumeAuditStream(res, key, r => persistToStorage(taskId, kind, name, r))
  } catch (e: unknown) {
    update(key, { running: false, error: e instanceof Error ? e.message : String(e), progress: null, startedAt: null, lastProgressAt: null })
  }
}

export function __resetSkillAuditForTests(): void {
  states.clear()
  snapshots.clear()
  listeners.clear()
}
