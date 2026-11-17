// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 级时间口径单一源：Overview 与 Perf 均消费本结果。
// wall = 全部执行 span 的最早开始 → 最晚结束；
// active = 全部执行活动窗口并集（固定 5min 间隔聚类）；
// llmActive = 主 Agent 与 subagent 的 assistant 推理窗口并集（重叠只算一次）。
// proxy 反推窗口以完成时刻为锚向前截断，避免保留错误起点而裁掉真实响应端点。

import {
  ACTIVE_GAP_THRESHOLD_MS,
  ACTIVE_LATENCY_CAP_MS,
  clusterActiveSegments,
} from '@/lib/active-time'
import { buildAgentSpans } from '@/lib/observe/agent-spans'
import { isProxyVersion } from '@/lib/shared/session-format'

export interface RunTimeSessionRow {
  id: string
  startTime: Date
  endTime: Date | null
  version: string | null
}

export interface RunTimeTurnRow {
  sessionId: string
  role: string
  isSubagent: boolean
  subagentSessionId: string | null
  createdAt_ts: Date | null
  completedAt: Date | null
  latencyMs: number
}

export interface RunTimeSummary {
  start: string | null
  end: string | null
  wallMs: number
  activeMs: number | null
  idleMs: number | null
  llmActiveMs: number
}

function sumSegments(segments: Array<{ start: number; end: number }>): number {
  return segments.reduce((sum, seg) => sum + Math.max(0, seg.end - seg.start), 0)
}

function clipIntervals(
  intervals: Array<{ start: number; end: number }>,
  start: number,
  end: number,
): Array<[number, number]> {
  return intervals
    .map(iv => [Math.max(start, iv.start), Math.min(end, iv.end)] as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
}

function llmWindowOf(turn: RunTimeTurnRow, isProxy: boolean): [number, number] | null {
  const ts = turn.createdAt_ts?.getTime()
  if (!Number.isFinite(ts) || turn.role !== 'assistant' || turn.latencyMs <= 0) return null
  const latency = isProxy && !turn.completedAt
    ? Math.min(turn.latencyMs, ACTIVE_LATENCY_CAP_MS)
    : turn.latencyMs
  if (isProxy && !turn.completedAt) return [ts! - latency, ts!]
  const completed = turn.completedAt?.getTime()
  const end = Number.isFinite(completed) ? Math.min(ts! + latency, completed!) : ts! + latency
  return end > ts! ? [ts!, end] : null
}

export function buildRunTimeSummary(
  sessions: RunTimeSessionRow[],
  turns: RunTimeTurnRow[],
): RunTimeSummary {
  const turnsBySession = new Map<string, RunTimeTurnRow[]>()
  for (const turn of turns) {
    const rows = turnsBySession.get(turn.sessionId) ?? []
    rows.push(turn)
    turnsBySession.set(turn.sessionId, rows)
  }

  const spans: Array<{ start: number; end: number }> = []
  const activeWindows: Array<{ start: number; end: number; inferred?: boolean }> = []
  const llmWindows: Array<[number, number]> = []
  for (const session of sessions) {
    const isProxy = isProxyVersion(session.version)
    const rows = turnsBySession.get(session.id) ?? []
    for (const entry of buildAgentSpans(rows, isProxy).values()) {
      if (entry.span) spans.push(entry.span)
      activeWindows.push(...entry.activeIntervals)
    }
    for (const turn of rows) {
      const window = llmWindowOf(turn, isProxy)
      if (window) llmWindows.push(window)
    }
  }

  const sessionStarts = sessions.map(s => s.startTime.getTime()).filter(Number.isFinite)
  const sessionEnds = sessions.map(s => s.endTime?.getTime()).filter((v): v is number => Number.isFinite(v))
  const start = spans.length > 0 ? Math.min(...spans.map(s => s.start)) : (sessionStarts.length > 0 ? Math.min(...sessionStarts) : null)
  const end = spans.length > 0 ? Math.max(...spans.map(s => s.end)) : (sessionEnds.length > 0 ? Math.max(...sessionEnds) : null)
  if (start == null || end == null || end <= start) {
    return {
      start: start != null ? new Date(start).toISOString() : null,
      end: end != null ? new Date(end).toISOString() : null,
      wallMs: 0,
      activeMs: null,
      idleMs: null,
      llmActiveMs: 0,
    }
  }

  const normalizedActive = activeWindows.map(iv => iv.inferred
    ? { start: Math.max(iv.start, iv.end - ACTIVE_LATENCY_CAP_MS), end: iv.end }
    : { start: iv.start, end: iv.end })

  const llmClipped = clipIntervals(llmWindows.map(([a, b]) => ({ start: a, end: b })), start, end)
  const llmActiveMs = sumSegments(clusterActiveSegments(llmClipped, 0))
  const activeClipped = clipIntervals(
    [...normalizedActive, ...llmWindows.map(([a, b]) => ({ start: a, end: b }))],
    start,
    end,
  )
  const activeMs = sumSegments(clusterActiveSegments(activeClipped, ACTIVE_GAP_THRESHOLD_MS))
  const wallMs = end - start
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    wallMs,
    activeMs: Math.min(activeMs, wallMs),
    idleMs: Math.max(0, wallMs - activeMs),
    llmActiveMs: Math.min(llmActiveMs, activeMs, wallMs),
  }
}
