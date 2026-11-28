// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Perf 热点排行 ↔ Turns 对应 IT（run 视角）：执行时间线已迁至 Turns 顶部
// （RunTurnsTimeline，单击即跳），Perf 页不再有时间线卡、不取车道表；行内
// 定位角标与轮次行点击走同一 onOpenTurn 出口——定位出口唯一收敛到 turnId，
// 由装配层接 Turns 深链管线。

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { PerfPanorama } from '@/components/observe/PerfPanorama'

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  vi.unstubAllGlobals()
  if (root) { act(() => { root!.unmount() }) }
  container?.remove()
  root = null
  container = null
})

const SUB_EXEC = {
  executionId: 'exec-sub-1',
  agentName: 'general',
  isSubagent: true,
  subagentName: '探索',
  agentSessionId: 'ses_sub_jump_1',
  member: { taskId: 'm-jump', label: '成员甲' },
  depth: 1,
  tokens: 5000,
  inputTokens: 4000,
  outputTokens: 800,
  reasoningTokens: 200,
  cacheReadInputTokens: 3000,
  cacheCreationInputTokens: 0,
  maxSingleCallTokens: 2000,
  skillLoadCount: 0,
  firstPrompt: '探索任务',
  cost: 0,
  latencyMs: 120_000,
  toolCallCount: 2,
  toolCallErrorCount: 0,
  llmCallCount: 3,
  model: 'glm-5.3',
  createdAt: '2026-09-15T10:00:00Z',
}

const TURNS = [{
  turnId: 'turn-sub-jump', turnIndex: 0, role: 'assistant', agentName: 'general', isSubagent: true,
  subagentName: '探索', subagentSessionId: 'ses_sub_jump_1',
  member: { taskId: 'm-jump', label: '成员甲' }, contentSummary: null,
  createdAt: '2026-09-15T10:00:30Z',
  totalTokens: 500, inputTokens: 300, outputTokens: 150, reasoningTokens: 50,
  cacheReadTokens: 100, cacheWriteTokens: 20, contextWindowPct: null, latencyMs: 1500,
  model: 'glm-5.3', toolCalls: [],
}]

const ENDPOINTS = {
  executions: '/perf-jump/executions',
  turns: '/perf-jump/turns',
  bridges: '/perf-jump/bridges',
}

async function renderPanorama(onOpenTurn?: (turnId: string) => void) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }))
    if (url.includes('/perf-jump/executions')) return json({ items: [SUB_EXEC] })
    if (url.includes('/perf-jump/turns')) return json({ items: TURNS })
    if (url.includes('/perf-jump/bridges')) return json({ items: [] })
    return json({})
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(PerfPanorama, { endpoints: ENDPOINTS, onOpenTurn }))
  })
  await act(async () => { })
}

describe('PerfPanorama 热点排行 → Turns 对应（run 视角）', () => {
  it('Perf 页无执行时间线卡、不取车道表；热点行定位角标 → onOpenTurn(会话首轮)', async () => {
    const opened: string[] = []
    await renderPanorama(turnId => { opened.push(turnId) })

    // ① 执行时间线不在 Perf（已迁 Turns 顶部）：无时间线卡、无条子、无车道表请求
    expect(container!.textContent).not.toContain('Agent Swimlane')
    expect(container!.querySelector('[data-bar]')).toBeNull()
    expect(vi.mocked(fetch).mock.calls.some(c => String(c[0]).includes('/lanes'))).toBe(false)

    // ② 热点排行行内定位角标 → 唯一定位出口
    const laneRow = container!.querySelector('[data-lane-row="ses_sub_jump_1"]')
    expect(laneRow).toBeTruthy()
    expect(laneRow!.textContent).toContain('子代理 · 成员甲')
    const locateBtn = laneRow!.querySelector('[title="在 Turns 时间线定位该单元"]')
    expect(locateBtn).toBeTruthy()
    await act(async () => {
      locateBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(opened).toEqual(['turn-sub-jump'])
  })

  it('热点行展开 → 轮次行点击 → onOpenTurn(该轮 turnId)；展开内含执行切片', async () => {
    const opened: string[] = []
    await renderPanorama(turnId => { opened.push(turnId) })

    const laneRow = container!.querySelector('[data-lane-row="ses_sub_jump_1"]')!
    await act(async () => {
      laneRow.querySelector('[role="button"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // 展开面板：轮次 + 执行切片（#1 全局序号与画像墙钟同口径）
    const panelText = laneRow.textContent ?? ''
    expect(panelText).toContain('轮次 · 1')
    expect(panelText).toContain('执行切片 · 1')
    expect(panelText).toContain('#1')

    const turnRow = laneRow.querySelector('[data-turn="turn-sub-jump"]')!
    expect(turnRow).toBeTruthy()
    await act(async () => {
      turnRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(opened).toEqual(['turn-sub-jump'])
  })
})
