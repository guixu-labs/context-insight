// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Run 详情页工作台渲染 IT：真实 fixture（mini-bundle）→ 真实 view-model →
// mock fetch → 组件树断言。锁四件事：① 工作台结构（视图标题/图例/概览侧栏，
// 子图为弹窗不占顶层视图）；② 节点点击后侧栏切换为运行历史；③ 概览统计与
// 代际信息来自真实数据；④ 画布缩放（工具条按钮 + Ctrl 滚轮）与跑马灯按需
// 点亮（选中节点 → 关联边状态色加粗 + 白色蚂蚁线，点击空白熄灭）；另设
// 确定性几何拓扑锁 PCB 交叉跳线、回滚 fixture 锁子图弹窗（代际切换）、
// 返回栈锁（tab 切换逐步回退，栈空离页兜底恰一次）。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import RunDetailPage from '@/app/run/[runId]/page';
import { RunOfflineHostCapsProvider } from '@/lib/run/host-caps';
import { createOfflineFetch, type OfflineMemberTurns } from '@/export-view/offline-kernel';
import { urlKeyOf } from '@/lib/observe/export-html';
import { parseAndIndex } from '@/lib/run/reader';
import { buildViewModel } from '@/lib/run/view-model';
import { attachSessionRefs } from '@/lib/run/session-link';
import type { NodeInstance, RunView } from '@/lib/run/view-model';
import { RunGraph } from '@/components/run/RunGraph';
import { METRIC_EMPTY, RUN_COLORS, flowColor, statusColor } from '@/components/run/run-theme';
import type { RunImportMeta } from '@/lib/run/run-store';
import { toast } from 'sonner'
import * as NoticeHud from '@/components/NoticeHud'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const nav = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn(), push: vi.fn() }))
// useSearchParams 读可变 search：用例可深链 ?tab=graph（run-view URL 镜像）
const searchState = vi.hoisted(() => ({ current: '' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, back: nav.back, refresh: () => {} }),
  usePathname: () => '/run/minidemo01',
  useSearchParams: () => new URLSearchParams(searchState.current),
}))

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'),
) as unknown;
const index = parseAndIndex(fixture);
const viewModel = buildViewModel(index);
// 成员引用挂接（Overview 成员表数据源）：ses_mini_a 一行 join（build g0 execute）
attachSessionRefs(viewModel, new Map([
  ['ses_mini_a', {
    taskId: 'ses_mini_a', framework: 'opencode', rowId: 'row_a', turns: 7,
    totalTokens: 2300, durationMs: 60000, label: null,
    startTime: '2026-10-13T02:00:12.000Z', endTime: '2026-10-13T02:01:12.000Z',
    cacheReadTokens: 0, contextPeakPct: 72.5, model: 'volc-gateway/glm-4.7',
    totalCost: 0.2, version: null, totalLatencyMs: 60000,
  }],
]));
const importMeta: RunImportMeta['data'] = {
  importedAt: '2026-10-15T10:00:00+08:00',
  sourceDir: '/bundle/mini',
  manifestFile: 'workflow.json',
  exportDataComplete: true,
  sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
  failures: [],
  warnings: [],
};
const responseBody = {
  run: {
    runId: 'minidemo01',
    name: index.manifest.name ?? null,
    status: viewModel.status,
    exportDataComplete: viewModel.exportDataComplete,
    startedAt: viewModel.startedAt,
    finishedAt: viewModel.finishedAt,
    import: importMeta,
  },
  viewModel,
  memberStats: {
    joinedCount: 1,
    totalTokens: 2300,
    totalCost: 0.2,
    totalTurns: 7,
    totalActiveMs: 1_110_000,
    totalDurationMs: 7_440_000,
    memberRowIds: ['row_a'],
    models: [{ model: 'glm-4.7', count: 1 }],
    earliestStart: '2026-10-13T02:00:12.000Z',
    latestEnd: '2026-10-13T02:01:12.000Z',
  },
  totalErrors: 2,
  members: [
    { taskId: 'ses_mini_a', framework: 'opencode', version: null, label: 'build 执行' },
  ],
};

vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true,
  json: async () => responseBody,
})))

let root: Root | null = null

// history.pushState 间谍（条目栈 URL 镜像断言锚）：懒建 + renderPage 复位。
// 调用形态 (state, unused, url)——url 断言取第三参
let pushSpy: ReturnType<typeof vi.spyOn> | null = null
function ensurePushSpy() {
  if (!pushSpy) pushSpy = vi.spyOn(window.history, 'pushState')
  return pushSpy
}

async function renderPage(initialSearch = '') {
  searchState.current = initialSearch
  // history 条目栈测试基建：重置当前条目 state（happy-dom 的 Window 在文件
  // 内共享——上一用例的 runNavSeq/runView 标残留会让 mount 盖标跳过、goBack
  // 误判有栈）+ pushState 间谍作 URL 镜像断言锚（happy-dom 的 pushState 不
  // 更新 location，URL 断言走调用记录）。受限宿主用例（replaceState 抛错）
  // 下重置跳过
  try { window.history.replaceState(null, '', `/run/minidemo01${initialSearch}`) } catch { /* 受限宿主：跳过 */ }
  ensurePushSpy().mockClear()
  nav.replace.mockClear()
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(
        Suspense,
        { fallback: null },
        createElement(RunDetailPage, { params: Promise.resolve({ runId: 'minidemo01' }) }),
      ),
    )
  })
  await act(async () => {
    await new Promise(r => setTimeout(r, 0))
  })
}

function clickNode(labelPart: string) {
  const node = Array.from(document.querySelectorAll('.run-node')).find(g =>
    g.textContent?.includes(labelPart),
  )
  expect(node, `图上应存在含「${labelPart}」的节点`).toBeTruthy()
  node!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/** 离线宿主渲染：离线内核（静态档案 = 本文件 fixture 的 run 详情 + 空成员
 *  富轮仓）+ offline caps provider——模拟导出 HTML 里挂载的真实工作台 */
async function renderOfflinePage() {
  const archive = { [urlKeyOf('/api/observe/run/minidemo01')]: responseBody };
  const members: OfflineMemberTurns[] = [
    { member: { taskId: 'ses_mini_a', label: 'build 执行' }, sessionId: 'ses_mini_a', framework: 'opencode', items: [] },
  ];
  const orig = vi.fn(async () => new Response('x'));
  const offlineFetch = createOfflineFetch(members, archive, 'minidemo01', orig as unknown as typeof fetch);
  const prevFetch = (globalThis as unknown as { fetch: unknown }).fetch;
  vi.stubGlobal('fetch', offlineFetch);
  try {
    searchState.current = ''
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        createElement(
          Suspense,
          { fallback: null },
          createElement(
            RunOfflineHostCapsProvider,
            null,
            createElement(RunDetailPage, { params: Promise.resolve({ runId: 'minidemo01' }) }),
          ),
        ),
      )
    })
    await act(async () => {
      await new Promise(r => setTimeout(r, 0))
    })
    const body = document.body.textContent ?? ''
    // 离线宿主：服务端协作动作全隐藏（刷新/导出/上传），工作台数据照常渲染
    expect(document.querySelector('button[title="立即刷新"]')).toBeNull()
    expect(document.querySelector('button[title="导出 SQLite 数据库"]')).toBeNull()
    expect(document.querySelector('button[title="导出 Markdown"]')).toBeNull()
    expect(document.querySelector('button[title="导出离线 HTML"]')).toBeNull()
    expect([...document.querySelectorAll('button')].find(b => b.textContent?.includes('上传到'))).toBeUndefined()
    // 页头在离线档案里照常是单行应用栏（返回 + 品牌 + tab 导航），右翼是
    // 空的——它与左翼配平让 tab 条居中，只是没有任何动作
    const header = document.querySelector('[data-run-header]') as HTMLElement
    expect(header.querySelector('button[title="返回上一步"]')).toBeTruthy()
    expect(header.querySelector('[data-run-tabbar]')).toBeTruthy()
    expect(header.querySelector('[data-run-header-zone="actions"]')?.children.length).toBe(0)
    expect(header.querySelector('[data-run-header-actions]')).toBeNull()
    expect(body).toContain('Context')
    expect(body).toContain('minidemo01')
    // 详情经内核静态档案应答（非原 fetch 直通）
    expect(orig).not.toHaveBeenCalled()
  } finally {
    vi.stubGlobal('fetch', prevFetch)
  }
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

/** 打开页头「导出」菜单（base-ui Menu 的触发器按指针序列开合，jsdom 下把
 *  一次真实点击的事件序列补齐），等条目渲染出来。 */
async function openExportMenu(): Promise<void> {
  const trigger = document.querySelector('button[title="导出"]') as HTMLButtonElement
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      trigger.dispatchEvent(type.startsWith('pointer')
        ? new PointerEvent(type, { bubbles: true, button: 0, pointerType: 'mouse' })
        : new MouseEvent(type, { bubbles: true, button: 0 }))
    }
    await new Promise(r => setTimeout(r, 0))
  })
}

const exportItems = (): HTMLElement[] => [...document.querySelectorAll('[data-run-export]')] as HTMLElement[]
const exportItem = (id: string): HTMLElement => document.querySelector(`[data-run-export="${id}"]`) as HTMLElement

describe('Run 详情页暗色工作台', () => {
  it('Overview 默认 tab：总览头（身份 + Σ指标瓦片）+ 结构/导入卡；Graph 切换走 URL 镜像', async () => {
    await renderPage()

    // 默认 Overview（无 tab 参数回落）；Graph 挂载但隐藏（hidden 切换保状态）
    const overview = document.querySelector('[data-run-tab="overview"]')
    const graph = document.querySelector('[data-run-tab="graph"]')
    expect(overview).toBeTruthy()
    expect(graph).toBeTruthy()
    expect(graph!.classList.contains('hidden')).toBe(true)
    expect(document.querySelector('.run-canvas')).toBeTruthy()

    const ovText = overview!.textContent ?? ''
    // 统一总览（run-first）：总览头 = 身份 + Σ指标大瓦片（memberStats +
    // totalErrors → 瓦片值；泳道/轮次面板取数失败时空态降级，不阻塞框架区块）
    expect(ovText).toContain('OpenCode')
    expect(ovText).toContain('glm-4.7')
    expect(ovText).toContain('2.3k')
    expect(ovText).toContain('$0.20')
    expect(ovText).toContain('2.1h')
    expect(ovText).toContain('活跃 0.3h')
    expect(ovText).toContain('⚠ Errors')
    // 成员维度不在 Overview 摆表（泳道分道 + Members 徽标承载；逐成员指标属 Turns tab）
    expect(ovText).not.toContain('成员会话')
    // 结构卡 / 导入信息卡
    expect(ovText).toContain('执行结构')
    expect(ovText).toContain('第 1 次运行')
    expect(ovText).toContain('导入信息')

    // 切 Graph：navigate 单点入条目栈（真实 history 条目——URL 镜像随
    // pushState 走、视图态随条目 state 走），两个 tab 容器 hidden 互换（均保持挂载）
    const graphTab = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Graph'))
    expect(graphTab).toBeTruthy()
    await act(async () => {
      graphTab!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(ensurePushSpy().mock.calls.some(([, , url]) => url === '?tab=graph')).toBe(true)
    expect((window.history.state as { runView?: { tab?: string } })?.runView?.tab).toBe('graph')
    expect(overview!.classList.contains('hidden')).toBe(true)
    expect(graph!.classList.contains('hidden')).toBe(false)
  });

  it('返回栈：tab 切换逐步回退上一个工作台动作（Score→Files→返回→Files→返回→Overview），栈空离页兜底恰一次', async () => {
    // Files 面板取数单独兜底（其余端点沿用 responseBody 通用 mock）
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/file-reads')) return { ok: true, json: async () => ({ files: [] }) }
      return { ok: true, json: async () => responseBody }
    }))
    try {
      await renderPage()
      const tabBtn = (label: string) =>
        [...document.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement
      const backBtn = () => document.querySelector('button[title="返回上一步"]') as HTMLButtonElement
      const visibleTab = (key: string) =>
        document.querySelector(`[data-run-tab="${key}"]`)?.className ?? ''

      // Score → Files：两个动作依次入条目栈（真实 history 条目）
      await act(async () => { tabBtn('Files').click() })
      expect(visibleTab('files')).toContain('flex')
      await act(async () => { tabBtn('Score').click() })
      expect(visibleTab('score')).toContain('flex')
      expect(visibleTab('files')).toContain('hidden')
      expect((window.history.state as { runNavSeq?: number })?.runNavSeq).toBe(2)

      // 返回 → Files（上一个动作）：history.back → popstate 按条目 state
      // 的 runView 恢复（与鼠标侧键同一出口）
      await act(async () => { backBtn().click() })
      expect(visibleTab('files')).toContain('flex')
      expect(visibleTab('score')).toContain('hidden')
      expect((window.history.state as { runView?: { tab?: string } })?.runView?.tab).toBe('files')

      // 再返回 → Overview（初始条目，栈逐步退空）
      await act(async () => { backBtn().click() })
      expect(visibleTab('overview')).toContain('flex')
      expect((window.history.state as { runView?: { tab?: string } })?.runView?.tab).toBe('overview')
      expect((window.history.state as { runNavSeq?: number })?.runNavSeq).toBe(0)

      // 栈空 → 离页兜底恰一次（回上页或首页，二者恰一）
      nav.back.mockClear()
      nav.push.mockClear()
      await act(async () => { backBtn().click() })
      expect(nav.back.mock.calls.length + nav.push.mock.calls.length).toBe(1)
    } finally {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => responseBody })))
    }
  });

  it('鼠标侧键后退语义：浏览器历史条目承载工作台动作——popstate 逐步回退、前进键重放、chrome 返回钮同出口', async () => {
    // Files 面板取数单独兜底（其余端点沿用 responseBody 通用 mock）
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/file-reads')) return { ok: true, json: async () => ({ files: [] }) }
      return { ok: true, json: async () => responseBody }
    }))
    try {
      await renderPage()
      const tabBtn = (label: string) =>
        [...document.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement
      const visibleTab = (key: string) =>
        document.querySelector(`[data-run-tab="${key}"]`)?.className ?? ''
      // 返回钮残影双 chevron：第二个 path 的 opacity 属性是 canBack 的镜像
      const ghostOpacity = () =>
        document.querySelectorAll('button[title="返回上一步"] svg path')[1]?.getAttribute('opacity')

      // 两个动作入条目栈（每个工作台动作 = 真实 history 条目，视图态随条目 state 走）
      await act(async () => { tabBtn('Files').click() })
      await act(async () => { tabBtn('Score').click() })
      expect(visibleTab('score')).toContain('flex')
      expect(ghostOpacity()).toBe('0.32')

      // 鼠标侧键后退 = history.back + popstate → 回退上一个工作台动作（Files）
      //（此前侧键直接离页：router.replace 单条目下浏览器历史里没有工作台条目）
      await act(async () => { window.history.back() })
      expect(visibleTab('files')).toContain('flex')
      expect(visibleTab('score')).toContain('hidden')
      expect((window.history.state as { runView?: { tab?: string } })?.runView?.tab).toBe('files')
      expect(ghostOpacity()).toBe('0.32')

      // 再退 → 初始条目（Overview），可达性归零、残影熄灭
      await act(async () => { window.history.back() })
      expect(visibleTab('overview')).toContain('flex')
      expect((window.history.state as { runNavSeq?: number })?.runNavSeq).toBe(0)
      expect(ghostOpacity()).toBe('0')

      // 前进键重放（此前内存栈无前进概念——真实历史条目天然支持）
      await act(async () => { window.history.forward() })
      expect(visibleTab('files')).toContain('flex')
      expect(ghostOpacity()).toBe('0.32')

      // chrome 返回钮与侧键同一出口（goBack = history.back，popstate 恢复）
      await act(async () => {
        (document.querySelector('button[title="返回上一步"]') as HTMLButtonElement).click()
      })
      expect(visibleTab('overview')).toContain('flex')
      expect((window.history.state as { runNavSeq?: number })?.runNavSeq).toBe(0)
    } finally {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => responseBody })))
    }
  });

  it('离线导出降级：history 抛 SecurityError（file:// 宿主）→ 内存栈承载回退，返回语义与历史模式同构', async () => {
    // 模拟受限宿主：replaceState/pushState 对 file:// origin null 抛
    // SecurityError（Chrome 行为）——mount 探测即落空，本页降级内存栈。
    // 前置清当前条目标：上一用例可能已盖 runNavSeq，而 mount 盖标有「已带
    // 标则跳过」守卫——带标宿主不触碰 replaceState，降级探测永不触发
    window.history.replaceState(null, '', '/run/minidemo01')
    const pushStub = ensurePushSpy();
    pushStub.mockImplementation(() => { throw new Error('SecurityError: file:// origin') });
    const replaceStub = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new Error('SecurityError: file:// origin');
    });
    // Files 面板取数单独兜底（其余端点沿用 responseBody 通用 mock）
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/file-reads')) return { ok: true, json: async () => ({ files: [] }) }
      return { ok: true, json: async () => responseBody }
    }));
    try {
      await renderPage()
      const tabBtn = (label: string) =>
        [...document.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement
      const backBtn = () => document.querySelector('button[title="返回上一步"]') as HTMLButtonElement
      const visibleTab = (key: string) =>
        document.querySelector(`[data-run-tab="${key}"]`)?.className ?? ''

      // 两个动作入内存栈（pushState 从未被调——mount 探测在 replaceState 就落空）
      await act(async () => { tabBtn('Files').click() })
      expect(visibleTab('files')).toContain('flex')
      await act(async () => { tabBtn('Score').click() })
      expect(visibleTab('score')).toContain('flex')
      expect(pushStub.mock.calls.length).toBe(0)

      // 返回 → Files（内存栈弹出恢复）→ 再返回 → Overview，语义与历史模式同构
      await act(async () => { backBtn().click() })
      expect(visibleTab('files')).toContain('flex')
      expect(visibleTab('score')).toContain('hidden')
      await act(async () => { backBtn().click() })
      expect(visibleTab('overview')).toContain('flex')

      // 栈空 → 离页兜底恰一次（回上页或首页，二者恰一）
      nav.back.mockClear()
      nav.push.mockClear()
      await act(async () => { backBtn().click() })
      expect(nav.back.mock.calls.length + nav.push.mock.calls.length).toBe(1)
    } finally {
      // mockReset 将 spyOn 间谍恢复原实现（后续用例继续记录真实 pushState）
      pushStub.mockReset()
      replaceStub.mockRestore()
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => responseBody })))
    }
  });

  it('工作台结构：视图标题、图例、Run 概览侧栏（子图为弹窗，不占顶层视图）', async () => {
    await renderPage('?tab=graph')

    expect(document.querySelector('.run-canvas')).toBeTruthy()
    // 页面 tab 栏为普通 button（无 ARIA tab 角色）；工具条模式组同无 role=tab
    expect(document.querySelectorAll('[role="tab"]').length).toBe(0)
    expect(document.body.textContent).toContain('主图（所有代）')

    // 返回钮在导航行（title=返回上一步）：深链直入、工作台内无回退历史 →
    // 离页兜底（回上页或首页，二者恰一）；回归：此前指向 /?kind=run 会把
    // 列表过滤成 Run
    const back = document.querySelector('button[title="返回上一步"]')
    expect(back).toBeTruthy()
    nav.back.mockClear()
    nav.push.mockClear()
    back!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(nav.back.mock.calls.length + nav.push.mock.calls.length).toBe(1)

    const text = document.body.textContent ?? ''
    expect(text).toContain('依赖')
    expect(text).toContain('回滚')
    expect(text).toContain('Run 概览')
    expect(text).toContain('节点')
    // 导入计数（原页头 sessionStats 移入）：导入信息卡给完整分解口径
    expect(text).toContain('会话：新导入 3 · 已存在 0 · 引用 3')
    expect(text).toContain('第 1 次运行')

    // 边渲染：默认全部静止（跑马灯按需点亮——见下个用例），正交走线无三次贝塞尔
    expect(document.querySelectorAll('.run-edge-flow').length).toBe(0)
    expect(document.querySelectorAll('.run-rb-flow').length).toBe(0)
    const depPaths = document.querySelectorAll('path.run-dep')
    expect(depPaths.length).toBeGreaterThan(0)
    for (const p of depPaths) {
      const d = p.getAttribute('d') ?? ''
      expect(d).toMatch(/^M [\d.]+ [\d.]+ (L|Q) /)
      expect(d).not.toContain('C ') // 无三次贝塞尔（曲线走线禁用）
    }

    // 侧栏宽度 360px（工作台标准侧栏）
    const aside = document.querySelector('aside')
    expect(aside?.className).toContain('w-[360px]')
  })

  it('选中节点点亮关联边跑马灯（状态色加粗 + 白色蚂蚁线），点击空白熄灭', async () => {
    await renderPage('?tab=graph')
    const main = viewModel.views[0]
    const byKey = new Map(viewModel.nodes.map(n => [n.key, n]))
    const initKey = main.nodeKeys.find(k => byKey.get(k)!.nodeId === 'init')!

    // 点击 init：其关联边（直接连出/连入）点亮
    await act(async () => {
      clickNode('init')
    })
    const relatedCount = main.edgeChains.filter(c => c.from === initKey || c.to === initKey).length
    expect(relatedCount).toBeGreaterThan(0)
    const flows = document.querySelectorAll('.run-edge-flow')
    expect(flows.length).toBe(relatedCount)
    for (const p of flows) {
      expect(p.getAttribute('stroke')).toBe(RUN_COLORS.canvas) // 白色蚂蚁线
    }
    // 关联边 base 以目标状态色加粗，未关联边保持灰色
    const depBase = document.querySelectorAll('path.run-dep')
    expect(depBase.length).toBe(main.edgeChains.length)
    main.edgeChains.forEach((c, i) => {
      const related = c.from === initKey || c.to === initKey
      expect(depBase[i].getAttribute('stroke')).toBe(
        related ? flowColor(byKey.get(c.to)!.status) : RUN_COLORS.edge,
      )
      expect(depBase[i].getAttribute('stroke-width')).toBe(related ? '2' : '1.25')
    })
    // 回滚边不关联 init → 保持静止（爬行只在关联时点亮）
    expect(document.querySelectorAll('.run-rb-flow').length).toBe(0)

    // 点击画布空白（非节点、非拖拽）→ 取消选中，跑马灯熄灭
    const canvas = document.querySelector('.run-canvas') as HTMLElement
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(document.querySelectorAll('.run-edge-flow').length).toBe(0)
    expect(document.querySelectorAll('.run-rb-flow').length).toBe(0)
  })

  it('画布缩放：工具条按钮 / Ctrl+滚轮 / 重置 / 适配', async () => {
    await renderPage('?tab=graph')
    const zoomLabel = () => document.querySelector('[aria-label="重置缩放"]')!.textContent
    expect(zoomLabel()).toBe('100%')

    await act(async () => {
      ;(document.querySelector('[aria-label="放大"]') as HTMLElement).click()
    })
    expect(zoomLabel()).toBe('115%')

    // Ctrl + 滚轮以光标为锚缩放（native listener，passive: false）。
    // happy-dom 的 WheelEvent 不读修饰键 init，用 MouseEvent 补 deltaY 模拟
    const canvas = document.querySelector('.run-canvas') as HTMLElement
    await act(async () => {
      const ev = new MouseEvent('wheel', { ctrlKey: true, cancelable: true })
      Object.defineProperty(ev, 'deltaY', { value: -100 })
      canvas.dispatchEvent(ev)
    })
    expect(zoomLabel()).toBe('129%') // 1.15 × 1.12 = 1.288

    await act(async () => {
      ;(document.querySelector('[aria-label="缩小"]') as HTMLElement).click()
    })
    expect(zoomLabel()).toBe('112%') // 1.288 / 1.15

    await act(async () => {
      ;(document.querySelector('[aria-label="重置缩放"]') as HTMLElement).click()
    })
    expect(zoomLabel()).toBe('100%')

    // 适配画布（happy-dom 视口为 0 → 兜底重置为 100%）
    await act(async () => {
      ;(document.querySelector('[aria-label="放大"]') as HTMLElement).click()
    })
    expect(zoomLabel()).toBe('115%')
    await act(async () => {
      ;(document.querySelector('[aria-label="适配画布"]') as HTMLElement).click()
    })
    expect(zoomLabel()).toBe('100%')
  })

  it('相机模型：缩放/平移直改 camera transform 与百分比同步，手势期间挂 run-gesture 暂停动画', async () => {
    await renderPage('?tab=graph')
    const camera = document.querySelector('.run-camera') as HTMLElement
    const viewport = document.querySelector('.run-viewport') as HTMLElement
    const svg = document.querySelector('.run-canvas svg') as SVGSVGElement
    const label = () => document.querySelector('[aria-label="重置缩放"]')!.textContent
    const svgW = () => Number(svg.getAttribute('width'))

    // 初始：单位相机（SVG 按内容尺寸矢量栅格，CSS 无缩放分量）
    const w0 = svgW()
    expect(w0).toBeGreaterThan(0)
    expect(camera.style.transform).toBe('translate(0px, 0px)')
    expect(label()).toBe('100%')

    // 工具条放大（离散操作）：立即矢量重栅格——SVG 尺寸随缩放档位对齐，
    // 任意档位下文字线条按显示分辨率渲染（高清），CSS 保持纯平移
    await act(async () => {
      ;(document.querySelector('[aria-label="放大"]') as HTMLElement).click()
    })
    expect(label()).toBe('115%')
    expect(svgW()).toBeCloseTo(w0 * 1.15, 1)
    expect(camera.style.transform).toBe('translate(0px, 0px)')

    // Ctrl+滚轮（连击手势）：先 GPU 拉伸（CSS scale 相对已栅格尺寸），SVG
    // 尺寸不动；静默 160ms 后才落定重栅格。happy-dom 的 WheelEvent 不读修
    // 饰键 init，用 MouseEvent + defineProperty deltaY 模拟
    const canvas = document.querySelector('.run-canvas') as HTMLElement
    await act(async () => {
      const ev = new MouseEvent('wheel', { ctrlKey: true, cancelable: true })
      Object.defineProperty(ev, 'deltaY', { value: -100 })
      canvas.dispatchEvent(ev)
    })
    expect(label()).toBe('129%')
    expect(camera.style.transform).toContain('scale(1.12)')
    expect(svgW()).toBeCloseTo(w0 * 1.15, 1)

    // 拖拽平移：手势中 viewport 挂 run-gesture（CSS 暂停流动画 + 抓取光标），
    // translate 随指针增量更新（缩放分量保持）
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }))
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 160, clientY: 130 }))
    })
    expect(viewport.classList.contains('run-gesture')).toBe(true)
    expect(camera.style.transform).toContain('translate(60px, 30px)')
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerup'))
    })
    expect(viewport.classList.contains('run-gesture')).toBe(false)

    // 重置：回归单位相机（SVG 尺寸与 CSS 平移双双复位）
    await act(async () => {
      ;(document.querySelector('[aria-label="重置缩放"]') as HTMLElement).click()
    })
    expect(label()).toBe('100%')
    expect(camera.style.transform).toBe('translate(0px, 0px)')
    expect(svgW()).toBe(w0)
  })

  it('点击节点：侧栏从概览切换为运行历史（逐次尝试）', async () => {
    await renderPage('?tab=graph')
    expect(document.body.textContent).toContain('Run 概览')

    await act(async () => {
      clickNode('build')
    })

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('Run 概览')
    expect(text).toContain('build')
    expect(text).toContain('第 1 次')
    expect(text).toContain('执行：')
  })

  it('再次点击同一节点：侧栏收起回到概览', async () => {
    await renderPage('?tab=graph')
    await act(async () => {
      clickNode('build')
    })
    expect(document.body.textContent).not.toContain('Run 概览')

    await act(async () => {
      clickNode('build')
    })
    expect(document.body.textContent).toContain('Run 概览')
  })

  it('加载态外壳：页头以真身作骨架（返回 + 品牌 + 禁用的真 tab 条 + 动作占位），内容区三区骨架，旧站头退役', async () => {
    // run 详情端点挂起（未决 Promise）——页面停留加载态
    const pending = new Promise<Response>(() => {})
    vi.stubGlobal('fetch', vi.fn(() => pending))
    try {
      await renderPage()
      const header = document.querySelector('[data-run-header]') as HTMLElement
      expect(header).toBeTruthy()
      // chrome 即时成型：返回钮（页头左段）+ 品牌区（链接回首页）+ 版本，均在页头内
      const back = document.querySelector('button[title="返回上一步"]')
      expect(back?.closest('[data-run-header]')).toBe(header)
      const brand = document.querySelector('a[href="/"]')
      expect(brand?.closest('[data-run-header-zone="leading"]')).toBeTruthy()
      const body = document.body.textContent ?? ''
      expect(body).toContain('Context')
      expect(body).toContain('v1.0')
      // tab 条 = 就绪态同一渲染表（9 个默认 tab 的真标签），pending：全禁用、
      // 点击不导航；数据到达只解除禁用，位置不动
      const bar = header.querySelector('[data-run-tabbar]') as HTMLElement
      expect(bar.getAttribute('data-pending')).toBe('true')
      const tabBtns = [...bar.querySelectorAll('button')].map(b => b.textContent)
      expect(tabBtns).toEqual(['Overview', 'Graph', 'Turns', 'Context', 'Audit', 'Perf', 'Skills', 'Files', 'Score'])
      expect([...bar.querySelectorAll('button')].every(b => (b as HTMLButtonElement).disabled)).toBe(true)
      const seqBefore = (window.history.state as { runNavSeq?: number })?.runNavSeq ?? 0
      ;(bar.querySelectorAll('button')[5] as HTMLButtonElement).click()
      expect((window.history.state as { runNavSeq?: number })?.runNavSeq ?? 0).toBe(seqBefore)
      // 右区：动作要等 run 详情，先占位（无真实动作钮）
      expect(header.querySelector('[data-run-header-zone="actions"]')?.getAttribute('aria-hidden')).toBe('true')
      expect(document.querySelector('[data-run-header-actions]')).toBeNull()
      // 无障碍：sr-only 加载提示（role=status）
      expect(document.querySelector('[role="status"]')?.textContent).toContain('加载 Run')
      // 骨架贴近落位：首卡三区（身份/元信息/瓦片）+ 双列列表
      const pulses = document.querySelectorAll('.animate-pulse')
      expect(pulses.length).toBeGreaterThan(20)
      const grids = document.querySelectorAll('.divide-y')
      expect(grids.length).toBeGreaterThanOrEqual(1)
      // 旧站头退役：连字品牌名（AppHeader 形态）不再出现在正文
      expect(body).not.toContain('Context-Insight')
    } finally {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => responseBody })))
    }
  })

  it('错误态外壳：页头仅品牌 + 居中错误卡（返回/重试），旧站头退役', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Run not found: minidemo01' }),
    })))
    try {
      await renderPage()
      // 页头只有品牌区（错误卡自带返回/重试——页头不再放返回钮，也没有可
      // 导航的 tab 与可用的动作）
      const header = document.querySelector('[data-run-header]') as HTMLElement
      expect(header.querySelector('a[href="/"]')).toBeTruthy()
      expect(header.querySelector('button')).toBeNull()
      expect(header.querySelector('[data-run-tabbar]')).toBeNull()
      expect(header.querySelector('[data-run-header-actions]')).toBeNull()
      // 错误卡：错误文案 + 返回/重试
      const body = document.body.textContent ?? ''
      expect(body).toContain('Run not found: minidemo01')
      expect(body).toContain('重试')
      // 旧站头退役：连字品牌名（AppHeader 形态）不再出现在正文
      expect(body).not.toContain('Context-Insight')
    } finally {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => responseBody })))
    }
  })

  it('页头单行应用栏：返回 · 品牌 → tab 导航（居中）→ 动作簇，三段同属一个页头，tab 导航不再是独立一行', async () => {
    await renderPage()
    const headers = document.querySelectorAll('[data-run-header]')
    expect(headers.length).toBe(1)
    const header = headers[0] as HTMLElement
    // 三段按 DOM 顺序排列：leading（返回 + 品牌）/ nav（tab 条，居页头正中）/
    // actions（右翼，与左翼等权配平）
    const zones = [...header.children].filter(el => el.hasAttribute('data-run-header-zone')).map(z => z.getAttribute('data-run-header-zone'))
    expect(zones).toEqual(['leading', 'nav', 'actions'])
    const back = document.querySelector('button[title="返回上一步"]') as HTMLButtonElement
    const brand = document.querySelector('a[href="/"]') as HTMLAnchorElement
    const bar = document.querySelector('[data-run-tabbar]') as HTMLElement
    const upload = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('上传到')) as HTMLButtonElement
    expect(back.closest('[data-run-header-zone="leading"]')).toBeTruthy()
    expect(brand.closest('[data-run-header-zone="leading"]')).toBeTruthy()
    expect(bar.closest('[data-run-header-zone="nav"]')).toBeTruthy()
    expect(upload.closest('[data-run-header-zone="actions"]')).toBeTruthy()
    // 四者同一个页头——页头之外没有第二个导航行
    for (const el of [back, brand, bar, upload]) expect(el.closest('[data-run-header]')).toBe(header)
    expect(document.querySelectorAll('[data-run-tabbar]').length).toBe(1)
    expect(document.querySelectorAll('button[title="返回上一步"]').length).toBe(1)
    // 就绪态：tab 条不是 pending（可点、可导航）
    expect(bar.hasAttribute('data-pending')).toBe(false)
    await act(async () => { (bar.querySelectorAll('button')[5] as HTMLButtonElement).click() })
    expect(document.querySelector('[data-run-tab="perf"]')?.className).toContain('flex')
  })

  it('页头动作区 + Overview 首卡身份：品牌区 + 动作簇在页头，run 身份在首卡', async () => {
    await renderPage()
    const body = document.body.textContent ?? ''
    // 页头左段：品牌区（渐变标 + 双色字标）+ 版本；无 run 名/runId（身份在首卡）
    expect(body).toContain('Context')
    expect(body).toContain('Insight')
    expect(body).toContain('v1.0')
    // 品牌区是回工作台首页的链接
    expect(document.querySelector('a[href="/"]')).toBeTruthy()
    // Overview 首卡：run 名为标题（h1 + 悬停全名/runId），kind 徽标 +
    // runId mono 一处呈现
    const h1 = document.querySelector('h1') as HTMLElement | null
    expect(h1).toBeTruthy()
    expect(h1!.getAttribute('title')).toContain('minidemo01')
    expect(body).toContain('工作流')
    expect(body).toContain('minidemo01')
    // 动作簇：刷新图标钮（title=立即刷新）+ 上传实心药丸；bundle 形态 SQLite
    // 与 HTML 导出全 run 可用（SQLite = run 全员成员的独立导出件，HTML = 工作
    // 台即离线查看器），MD 导出仍 solo 专属
    expect(document.querySelector('button[title="立即刷新"]')).toBeTruthy()
    const upload = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('上传到'))
    expect(upload).toBeTruthy()
    // 导出收成一个菜单（一个图标钮）：条目打开后才渲染——SQLite / 原始文件
    // zip / 离线 HTML 全 run 可用，Markdown solo 专属不在场；次序即上面的次序
    const cluster = [...document.querySelectorAll('[data-run-header-actions] button')].map(b => b.getAttribute('title'))
    expect(cluster.filter(t => t?.startsWith('导出'))).toEqual(['导出'])
    const exportTrigger = document.querySelector('button[title="导出"]') as HTMLButtonElement
    expect(exportTrigger.disabled).toBe(false)
    await openExportMenu()
    expect(exportItems().map(el => el.getAttribute('data-run-export'))).toEqual(['sqlite', 'archive', 'html'])
  })

  it('页头「导出」菜单：条目只有标题一行（不挂副标题），打开菜单不额外发请求', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return { ok: true, json: async () => responseBody } as unknown as Response;
    }));
    try {
      await renderPage();
      calls.length = 0;
      await openExportMenu();
      // 菜单是静态入口：开合不触发任何取数（归档计划由服务端在导出时现算）
      expect(calls).toEqual([]);
      expect(exportItems().map(el => el.textContent)).toEqual(['SQLite 数据库', '原始文件 (zip)', '离线 HTML']);
    } finally {
      vi.unstubAllGlobals();
    }
  })

  it('页头「导出」→「SQLite 数据库」：点击 → GET run 级 export-db → 按响应头文件名落盘，进行中禁用', async () => {
    const toastSuccess = vi.spyOn(toast, 'success')
    const notifyErrorSpy = vi.spyOn(NoticeHud, 'notifyError')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const exportFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).endsWith('/export-db')) {
        return { ok: true, json: async () => responseBody } as unknown as Response
      }
      await gate
      return {
        ok: true,
        headers: { get: () => 'attachment; filename="context_session_run_mini-bundle.db"' },
        arrayBuffer: async () => new ArrayBuffer(32),
      } as unknown as Response
    })
    vi.stubGlobal('fetch', exportFetch)
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    URL.createObjectURL = vi.fn(() => 'blob:sqlite-export') as never
    URL.revokeObjectURL = vi.fn() as never
    try {
      await renderPage()
      await openExportMenu()
      const button = document.querySelector('button[title="导出"]') as HTMLButtonElement
      await act(async () => { exportItem('sqlite').click() })
      // 取流期间：导出钮禁用（防重复触发），尚未落盘、尚未提示
      expect(button.disabled).toBe(true)
      expect(anchorClick).not.toHaveBeenCalled()
      expect(toastSuccess).not.toHaveBeenCalled()

      await act(async () => { release() })
      // run 级端点（runId 随 run 身份，不带成员 / taskId——全员由服务端 scope 决定）
      // run 级端点（runId 随 run 身份，不带成员 / taskId——全员由服务端 scope 决定）
      expect(exportFetch.mock.calls.map(c => String(c[0]))).toEqual([
        expect.stringContaining('/api/observe/run/minidemo01'),
        '/api/observe/run/minidemo01/export-db',
      ])
      expect(anchorClick).toHaveBeenCalledTimes(1)
      const anchor = anchorClick.mock.instances[0] as unknown as HTMLAnchorElement
      expect(anchor.download).toBe('context_session_run_mini-bundle.db')
      expect(button.disabled).toBe(false)
      expect(toastSuccess).toHaveBeenCalledTimes(1)
      expect(toastSuccess.mock.calls[0][0]).toBe('SQLite exported')
      expect(notifyErrorSpy).not.toHaveBeenCalled()
    } finally {
      anchorClick.mockRestore()
      toastSuccess.mockRestore()
      notifyErrorSpy.mockRestore()
    }
  })

  it('页头「导出」→「SQLite 数据库」：服务端报错 → 报错确认卡带原因，不落盘、不提示成功', async () => {
    const toastSuccess = vi.spyOn(toast, 'success')
    const notifyErrorSpy = vi.spyOn(NoticeHud, 'notifyError')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).endsWith('/export-db')) {
        return { ok: true, json: async () => responseBody } as unknown as Response
      }
      return { ok: false, status: 500, json: async () => ({ error: 'Session not found: 1 of 3 rows' }) } as unknown as Response
    }))
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      await renderPage()
      await openExportMenu()
      const button = document.querySelector('button[title="导出"]') as HTMLButtonElement
      await act(async () => { exportItem('sqlite').click() })
      await act(async () => { await new Promise(r => setTimeout(r, 0)) })
      expect(anchorClick).not.toHaveBeenCalled()
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(notifyErrorSpy).toHaveBeenCalledTimes(1)
      expect(notifyErrorSpy.mock.calls[0]).toEqual(['Export SQLite failed', 'Session not found: 1 of 3 rows'])
      expect(button.disabled).toBe(false)
    } finally {
      anchorClick.mockRestore()
      toastSuccess.mockRestore()
      notifyErrorSpy.mockRestore()
    }
  })

  it('离线宿主（导出 HTML 形态）：服务端协作动作全隐藏，工作台经内核档案照常渲染', async () => {
    await renderOfflinePage()
  })
})

describe('子图弹窗（gen-sub 三代，回滚 fixture）', () => {
  const rollbackFixture = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, './data/run/graph-demo-rollback-manifest.json'), 'utf-8'),
  ) as unknown;
  const rollbackVm = buildViewModel(parseAndIndex(rollbackFixture));
  // 模拟 API 层组装（session-link.ts）：成员-会话 join 后成员引用才带 session
  // 详情，子图弹窗的会话下钻链接依赖该注入——sub-agent-a g1 执行成员为已导入会话
  attachSessionRefs(rollbackVm, new Map([
    ['S5082A31602EE15ED', {
      taskId: 'S5082A31602EE15ED',
      framework: 'opencode',
      rowId: 'row-a1',
      turns: 3,
      totalTokens: 1234,
      durationMs: 5000,
      label: 'gen-sub:sub-agent-a',
      startTime: '2026-10-10T02:01:30Z',
      endTime: '2026-10-10T02:01:35Z',
      cacheReadTokens: 400,
    }],
  ]));
  // 会话时间兜底：manifest 成员时间戳缺失（session 成员常见）→ 用会话行起止组合范围
  const agentAG1 = rollbackVm.nodes.find(n => n.key === 'n-gen-sub:sub-agent-a-g1')!;
  agentAG1.attempts[0].startedAt = null;
  agentAG1.attempts[0].finishedAt = null;
  // 长验收报告（Agent 逐项证据，源自真实 bundle 形态）→ 侧栏折叠展示
  const subFlakyG1 = rollbackVm.nodes.find(n => n.key === 'n-gen-sub:sub-flaky-g1')!;
  subFlakyG1.attempts[0].status = 'failed';
  subFlakyG1.attempts[0].verification = {
    type: 'agent',
    status: 'failed',
    reason: [
      '我已完成全部验收项的核查。以下为逐项证据与结论。',
      '## 验收报告',
      '**1. 包骨架（op_host/op_kernel/op_graph/tests + build.sh/CMakeLists.txt/README.md）— met** `test -d ... && test -f ...` 全部命中，退出 0。',
      '**2. 无样例名残留 — met** `grep -rE \'add_custom|AddCustom|ADD_CUSTOM\'` 无任何匹配。',
      '**3. 包标识 == op.type（python3 REG_OP/OP_END_FACTORY_REG==Add, exits 0）— not met** 命令退出 1，AssertionError: (\'OpType\', \'OpType\', \'Add\')。',
    ].join('\n'),
  };
  const rollbackBody = {
    run: {
      runId: 'roller01',
      name: 'graph-demo',
      status: rollbackVm.status,
      exportDataComplete: rollbackVm.exportDataComplete,
      startedAt: rollbackVm.startedAt,
      finishedAt: rollbackVm.finishedAt,
      import: importMeta,
    },
    viewModel: rollbackVm,
  };

  async function renderRollbackPage() {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => rollbackBody,
    })));
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(
          Suspense,
          { fallback: null },
          createElement(RunDetailPage, { params: Promise.resolve({ runId: 'roller01' }) }),
        ),
      );
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });
  }

  function clickSubgraphChip(index: number) {
    // 主图上带「子图 ▸」入口的生成器节点（gen-sub g0/g1/g2 三个实例）
    const hosts = Array.from(document.querySelectorAll('.run-node')).filter(g =>
      g.textContent?.includes('子图 ▸'),
    );
    expect(hosts.length, '主图应有 3 个 gen-sub 生成器节点').toBe(3);
    const chip = hosts[index].querySelector('g');
    expect(chip, '节点内应有子图入口').toBeTruthy();
    chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  it('点击「子图 ▸」打开弹窗：锁定入口代子图，点击子图节点可下钻会话', async () => {
    await renderRollbackPage();
    expect(document.querySelectorAll('[role="tab"]').length).toBe(0);

    // g1 入口（gen-sub 第 1 代 = 回滚 #1）→ 弹窗只展示该代子图
    await act(async () => { clickSubgraphChip(1); });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    // 主图画布仍在，弹窗画布为子图节点
    expect(document.querySelectorAll('.run-canvas').length).toBe(2);
    expect((dialog!.textContent ?? '')).toContain('gen-sub');
    expect((dialog!.textContent ?? '')).toContain('回滚 #1');
    // 无代际 tab——弹窗锁定入口节点所在代，不混入其他代
    expect(dialog!.querySelectorAll('[role="tab"]').length).toBe(0);
    // 宽度覆盖回归锁：DialogContent 默认 sm:max-w-sm（384px 上限）必须被显式替换，
    // 否则桌面端弹窗被压回 384px，340px 侧栏挤掉画布 → 空白弹窗
    // （[role="dialog"] 即 DialogPrimitive.Popup，与 data-slot="dialog-content" 同元素）
    const contentClass = dialog!.getAttribute('class') ?? '';
    expect(contentClass).not.toContain('sm:max-w-sm');
    expect(contentClass).toContain('sm:max-w-[min(1180px,94vw)]');
    // 该代子图 5 节点全部通过：sub-flaky 描边为通过色（g0 为失败红）
    const flaky = Array.from(dialog!.querySelectorAll('.run-node')).find(n =>
      n.textContent?.includes('sub-flaky'),
    );
    expect(flaky?.querySelector('.run-node-box')?.getAttribute('stroke')).toBe('#1a7f37');

    // 点击子图节点 → 弹窗侧栏运行历史 + 成员会话链接（sub-agent-a 执行成员为 session）
    await act(async () => {
      Array.from(dialog!.querySelectorAll('.run-node'))
        .find(n => n.textContent?.includes('sub-agen'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect((dialog!.textContent ?? '')).toContain('第 1 次');
    // 验收类型并入标头（脚本 · 通过），时间行不再为「—」（会话行起止兜底）
    expect((dialog!.textContent ?? '')).toContain('脚本 · 通过');
    expect((dialog!.textContent ?? '')).not.toContain('—');
    // 成员会话定位入口（原 solo 整页链接退役）：定位按钮 + title 带完整 id
    const sessionBtn = Array.from(dialog!.querySelectorAll('button'))
      .find(b => b.getAttribute('title')?.includes('S5082A31602EE15ED')) as HTMLElement | undefined;
    expect(sessionBtn, '子图节点会话定位入口').toBeTruthy();
    // 角色词精简（执行/验收）+ 短 id 展示（完整 id 在 title 保留全量）
    expect(sessionBtn!.textContent).toContain('执行：S5082A31602EE1');
    expect(sessionBtn!.getAttribute('title')).toContain('在 Turns 时间线定位该会话');
    // 成员行美化：定位入口 + 右侧用量胶囊（完整数值悬浮）；尝试卡片带耗时徽标
    const memberRow = sessionBtn!.parentElement!;
    expect(memberRow.textContent).toContain('3 turns · 1.2k');
    expect(memberRow.querySelector('span[title]')?.getAttribute('title')).toBe('3 turns · 1234 tokens');
    expect((dialog!.textContent ?? '')).toContain('5.0s');
    // 时间块零值构成不展示：单次通过 + 脚本验收（无验收会话）→ 只有执行段
    expect((dialog!.textContent ?? '')).toContain('执行 5.0s');
    expect((dialog!.textContent ?? '')).not.toContain('0ms');
    expect((dialog!.textContent ?? '')).not.toContain('重试等待');
    expect(dialog!.querySelectorAll('.usage-compose-bar > span').length).toBe(1);

    // 关闭弹窗回到主图：弹窗卸载，主图画布保留
    await act(async () => {
      dialog!.querySelector('[data-slot="dialog-close"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelectorAll('.run-canvas').length).toBe(1);
    // 主图画布节点仍是主图集合（含 gen-sub 生成器，不含子图成员）
    const mainNodes = document.querySelectorAll('.run-canvas .run-node');
    expect(Array.from(mainNodes).some(n => n.textContent?.includes('sub-init'))).toBe(false);
  });

  it('g0 入口展示「第 1 次运行」代子图：sub-flaky 失败红描边，与回滚代区分', async () => {
    await renderRollbackPage();

    await act(async () => { clickSubgraphChip(0); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect((dialog.textContent ?? '')).toContain('第 1 次运行');
    const flaky = Array.from(dialog.querySelectorAll('.run-node')).find(n =>
      n.textContent?.includes('sub-flaky'),
    );
    expect(flaky?.querySelector('.run-node-box')?.getAttribute('stroke')).toBe('#cf222e');

    // 未选中子图节点时，侧栏为提示文案（无运行历史、无会话链接）
    expect(dialog.querySelectorAll('a[href^="/run/solo:"]').length).toBe(0);
    expect((dialog.textContent ?? '')).toContain('点击子图节点查看运行历史');
  });

  it('长验收报告折叠展示：默认 2 行预览 + 字数徽标，展开为可滚动代码块', async () => {
    await renderRollbackPage();

    await act(async () => { clickSubgraphChip(1); });
    const dialog = document.querySelector('[role="dialog"]')!;
    await act(async () => {
      Array.from(dialog.querySelectorAll('.run-node'))
        .find(n => n.textContent?.includes('sub-flaky'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // 尝试标头：验收类型 + 状态（Agent · 失败，不再在验收行重复），长报告默认收起
    expect((dialog.textContent ?? '')).toContain('Agent · 失败');
    expect((dialog.textContent ?? '')).toContain('验收报告');
    const toggle = dialog.querySelector('button[aria-expanded="false"]');
    expect(toggle).toBeTruthy();
    expect(dialog.querySelector('.line-clamp-2')).toBeTruthy();

    // 展开 → 滚动代码块（无行数截断），可再收起
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(dialog.querySelector('button[aria-expanded="true"]')).toBeTruthy();
    expect(dialog.querySelector('.line-clamp-2')).toBeNull();
    await act(async () => {
      dialog.querySelector('button[aria-expanded="true"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(dialog.querySelector('.line-clamp-2')).toBeTruthy();
  });
});

describe('RunGraph 走线几何（PCB 交叉跳线 + 选中点亮）', () => {
  const mkNode = (key: string, nodeId: string, status: NodeInstance['status']): NodeInstance => ({
    key,
    nodeId,
    generation: 0,
    label: nodeId,
    taskType: 'bash',
    status,
    executionState: 'executed',
    carriedFromGeneration: null,
    attempts: [],
    pendingMembers: [],
    retryPolicy: null,
    runOnFailure: null,
    predecessorKeys: [],
    parentKey: null,
    hasSubgraph: false,
  })

  // 确定性交叉拓扑：a→c 的水平段（行间隙 y=84，x 84→684）先后被回滚边竖段
  // （x=234）与 b→d 竖段（x=384）穿过——水平段做 PCB 半圆跳线，垂直段直行
  const nodesByKey = new Map([
    ['n-a-g0', mkNode('n-a-g0', 'a', 'passed')],
    ['n-b-g0', mkNode('n-b-g0', 'b', 'passed')],
    ['n-c-g0', mkNode('n-c-g0', 'c', 'failed')],
    ['n-d-g0', mkNode('n-d-g0', 'd', 'passed')],
  ])
  const view: RunView = {
    id: 'main',
    title: '几何测试',
    parentKey: null,
    nodeKeys: [...nodesByKey.keys()],
    ranks: { 'n-a-g0': 0, 'n-b-g0': 0, 'n-c-g0': 1, 'n-d-g0': 1 },
    edges: [
      { from: 'n-a-g0', to: 'n-c-g0' },
      { from: 'n-b-g0', to: 'n-d-g0' },
    ],
    edgeChains: [
      { from: 'n-a-g0', to: 'n-c-g0', bends: [] },
      { from: 'n-b-g0', to: 'n-d-g0', bends: [] },
    ],
    rollbackLinks: [{ from: 'n-a-g0', to: 'n-d-g0', label: '回滚 #1', ordinal: 1 }],
    layout: {
      width: 800,
      height: 300,
      bands: [],
      positions: {
        'n-a-g0': { x: 0, y: 0 },
        'n-b-g0': { x: 300, y: 0 },
        'n-c-g0': { x: 600, y: 120 },
        'n-d-g0': { x: 300, y: 240 },
      },
    },
  }

  function renderGraph(selectedKey: string | null) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const r = createRoot(container)
    act(() => {
      r.render(
        createElement(RunGraph, {
          view,
          nodesByKey,
          selectedKey,
          onSelectNode: () => {},
          onOpenSubgraph: () => {},
        }),
      )
    })
    return { container, r }
  }

  it('交叉处 PCB 半圆跳线（水平段跳过垂直段，2 处），无贝塞尔，默认静止', () => {
    const { container, r } = renderGraph(null)
    const ds = [...container.querySelectorAll('path.run-dep')].map(p => p.getAttribute('d') ?? '')
    expect(ds).toHaveLength(2)
    const hopCount = ds.reduce((acc, d) => acc + (d.match(/A 4\.5 4\.5 0 0 1 /g)?.length ?? 0), 0)
    expect(hopCount).toBe(2)
    for (const d of ds) expect(d).not.toContain('C ')
    expect(container.querySelectorAll('.run-edge-flow').length).toBe(0)
    expect(container.querySelectorAll('.run-rb-flow').length).toBe(0)
    act(() => r.unmount())
  })

  it('选中 a：关联边（a→c + 回滚 a→d）点亮流动，b→d 压暗静止', () => {
    const { container, r } = renderGraph('n-a-g0')
    const groups = [...container.querySelectorAll('g.run-edge')]
    expect(groups).toHaveLength(2)
    expect(groups[0].getAttribute('opacity')).toBe('1')
    expect(groups[1].getAttribute('opacity')).toBe('0.35')
    const depPaths = [...container.querySelectorAll('path.run-dep')]
    expect(depPaths[0].getAttribute('stroke')).toBe(statusColor('failed')) // 目标 c=failed
    expect(depPaths[0].getAttribute('stroke-width')).toBe('2')
    expect(depPaths[1].getAttribute('stroke')).toBe(RUN_COLORS.edge)
    const flows = container.querySelectorAll('.run-edge-flow')
    expect(flows).toHaveLength(1)
    expect(flows[0].getAttribute('stroke')).toBe(RUN_COLORS.canvas)
    expect(container.querySelectorAll('.run-rb-flow')).toHaveLength(1)
    act(() => r.unmount())
  })

  it('选中 b：b→d 点亮，a→c 与回滚边压暗静止', () => {
    const { container, r } = renderGraph('n-b-g0')
    const groups = [...container.querySelectorAll('g.run-edge')]
    expect(groups[0].getAttribute('opacity')).toBe('0.35')
    expect(groups[1].getAttribute('opacity')).toBe('1')
    expect(container.querySelectorAll('.run-edge-flow')).toHaveLength(1)
    expect(container.querySelectorAll('.run-rb-flow')).toHaveLength(0)
    expect(container.querySelector('g.run-rb')?.getAttribute('opacity')).toBe('0.35')
    act(() => r.unmount())
  })
})

describe('系统级观测：指标透镜 + Run Trace 时间轴', () => {
  // 独立 viewModel（mini-bundle + 会话 join）：build g0（执行 90k/48s + 验收 30k/1.8min
  // 失败后同代重试一次：+30s 等待 +30s 执行仍失败）与 build g1（执行 1k/30s，回滚后
  // 成功）——透镜分位与时间轴摘要的口径样本
  const obsVm = buildViewModel(parseAndIndex(fixture));
  attachSessionRefs(obsVm, new Map([
    ['ses_mini_a', {
      taskId: 'ses_mini_a', framework: 'opencode', rowId: 'r-a', turns: 4, totalTokens: 90_000,
      durationMs: 48_000, label: null,
      startTime: '2026-10-13T02:00:12Z', endTime: '2026-10-13T02:01:00Z',
      cacheReadTokens: 60_000, contextPeakPct: 86.3,
      ruleScores: {
        d4: 0.86,
        d5: 0.52,
        findings: [
          {
            itemId: 'D5.redispatch', label: 'subagent 重派', score: 0.3, value: 1,
            formula: '重派 1 次 ×50 当量 ÷ 总调用 60 = 0.83 ×10 线性扣 → 0.30',
            note: '重派一次记 50 当量：一次重派背后是十几 turn、M 级 token 的完整子会话',
            evidence: [{ turnIndex: 6, label: 'reviewer ×2：复审模块 Task12 的实现 / 复审模块 Task12 的实现' }],
          },
          {
            itemId: 'D4.compaction', label: '上下文水位', score: 0.8, value: 1,
            formula: '压缩 1 次 ×0.2 线性扣 → 0.8',
            note: '触发压缩 = 上下文水位失控；重算成本已在 D4.tokens 罚过，此处只罚信号',
            evidence: [{ turnIndex: 3, label: '[compact] 主链自动压缩' }],
          },
        ],
      },
    }],
    ['ses_mini_b', {
      taskId: 'ses_mini_b', framework: 'opencode', rowId: 'r-b', turns: 2, totalTokens: 30_000,
      durationMs: 110_000, label: null,
      startTime: '2026-10-13T02:01:10Z', endTime: '2026-10-13T02:03:00Z',
      cacheReadTokens: 0,
    }],
    ['ses_mini_c', {
      taskId: 'ses_mini_c', framework: 'opencode', rowId: 'r-c', turns: 1, totalTokens: 1_000,
      durationMs: 30_000, label: null,
      startTime: '2026-10-13T02:02:00Z', endTime: '2026-10-13T02:02:30Z',
      cacheReadTokens: 0, contextPeakPct: 30,
      ruleScores: { d4: 1, d5: 1, findings: [] },
    }],
  ]));
  // build g0 注入第 2 次失败尝试（同代重试样本）：尝试间等待 30s（02:03:00 →
  // 02:03:30）+ 执行 30s——节点时长 = 168 + 30(等待) + 30 = 228s（节点墙钟）
  const buildG0 = obsVm.nodes.find(n => n.nodeId === 'build' && n.generation === 0)!;
  buildG0.attempts.push({
    ordinal: 2,
    status: 'failed',
    startedAt: null,
    finishedAt: null,
    outputText: null,
    verification: { type: 'script', status: 'failed', reason: 'exit 1' },
    executeMember: {
      memberId: 'm-mini-d', kind: 'session', role: 'execute', name: null, note: null,
      sessionId: 'ses_mini_d', location: null, startedAt: null, finishedAt: null,
      session: {
        taskId: 'ses_mini_d', framework: 'opencode', rowId: 'r-d', turns: 0, totalTokens: 0,
        durationMs: 30_000, label: null,
        startTime: '2026-10-13T02:03:30Z', endTime: '2026-10-13T02:04:00Z',
        cacheReadTokens: 0,
      },
    },
    verifyMember: null,
  });
  const obsBody = {
    run: {
      runId: 'minidemo01',
      name: index.manifest.name ?? null,
      status: obsVm.status,
      exportDataComplete: obsVm.exportDataComplete,
      startedAt: obsVm.startedAt,
      finishedAt: obsVm.finishedAt,
      import: importMeta,
    },
    viewModel: obsVm,
  };

  async function renderObsPage() {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => obsBody,
    })));
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(
          Suspense,
          { fallback: null },
          createElement(RunDetailPage, { params: Promise.resolve({ runId: 'minidemo01' }) }),
        ),
      );
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });
  }

  function clickToolbarButton(groupLabel: string, text: string) {
    const group = document.querySelector(`[aria-label="${groupLabel}"]`)!;
    const btn = Array.from(group.querySelectorAll('button')).find(b => b.textContent === text);
    expect(btn, `工具栏 ${groupLabel} 应有「${text}」按钮`).toBeTruthy();
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  it('指标透镜：节点副标显示用量、描边按分位着色（无数据灰），状态圆点保留', async () => {
    await renderObsPage();
    // 默认状态透镜：副标无用量缩写
    expect(document.body.textContent ?? '').not.toContain('120k');

    // 切 Token 透镜：build g0（120k = 90k + 30k）最深色，build g1（1.0k）最浅
    await act(async () => { clickToolbarButton('指标透镜', 'Token'); });
    const nodeWith = (t: string) =>
      Array.from(document.querySelectorAll('.run-node')).find(n => n.textContent?.includes(t))!;
    expect(nodeWith('120k')).toBeTruthy();
    expect(nodeWith('1.0k')).toBeTruthy();
    expect(nodeWith('120k').querySelector('.run-node-box')?.getAttribute('stroke')).toBe('#155fae');
    expect(nodeWith('1.0k').querySelector('.run-node-box')?.getAttribute('stroke')).toBe('#edf1f6');
    // 无会话节点（init 为 process 成员）灰描边，但状态圆点仍是状态色
    const initNode = nodeWith('init');
    expect(initNode.querySelector('.run-node-box')?.getAttribute('stroke')).toBe(METRIC_EMPTY);
    const initStatus = obsVm.nodes.find(n => n.nodeId === 'init')!.status;
    expect(initNode.querySelector('circle')?.getAttribute('fill')).toBe(statusColor(initStatus));
    // 图例切换为分位色阶
    expect((document.querySelector('[aria-label="图例"]')?.textContent ?? '')).toContain('Token 消耗');
    expect((document.querySelector('[aria-label="图例"]')?.textContent ?? '')).toContain('无会话数据');

    // 缓存透镜：build g0 缓存命中 60k/120k = 50%
    await act(async () => { clickToolbarButton('指标透镜', '缓存'); });
    expect(nodeWith('50%')).toBeTruthy();
    // 0 缓存命中是真实值（0% 命中率），不是「无会话数据」：build g1 有会话成员
    // 但 cacheReadTokens=0，应被染成最低档并显式标出 0%，而非灰描边掉成无数据
    expect(nodeWith('· 0%').querySelector('.run-node-box')?.getAttribute('stroke')).toBe('#edf1f6');
    // init（process 成员，无会话）仍是无数据灰描边——与「有会话但 0 命中」一眼可分
    expect(nodeWith('init').querySelector('.run-node-box')?.getAttribute('stroke')).toBe(METRIC_EMPTY);

    // 时长透镜：节点时长 = Σ尝试跨度 + 尝试间等待（含等待的完整墙钟口径）
    // build g0 = 168 + 30(等待) + 30 = 228s，build g1 = 30s
    await act(async () => { clickToolbarButton('指标透镜', '时长'); });
    expect(nodeWith('3.8min')).toBeTruthy();
    expect(nodeWith('30.0s')).toBeTruthy();

    // 切回状态透镜：副标恢复 taskType + 重试，描边恢复状态色
    await act(async () => { clickToolbarButton('指标透镜', '状态'); });
    expect(document.body.textContent ?? '').not.toContain('120k');
    const buildBoxes = Array.from(document.querySelectorAll('.run-node')).filter(n => n.textContent?.includes('build'));
    expect(buildBoxes.some(n => n.querySelector('.run-node-box')?.getAttribute('stroke') === statusColor('failed'))).toBe(true);
  });

  it('水位透镜：容器注水效果（水深=水位，80% 警戒线）+ 成员胶囊 + 归因水位线索 + 时间轴峰值水位', async () => {
    await renderObsPage();
    await act(async () => { clickToolbarButton('指标透镜', '水位'); });
    const nodeWith = (t: string) =>
      Array.from(document.querySelectorAll('.run-node')).find(n => n.textContent?.includes(t))!;
    const build0 = nodeWith('86%');
    const build1 = nodeWith('30%');
    // 描边仍按档位（86% 最深 / 30% 最浅）；无数据节点灰描边不注水
    expect(build0.querySelector('.run-node-box')?.getAttribute('stroke')).toBe('#155fae');
    expect(build1.querySelector('.run-node-box')?.getAttribute('stroke')).toBe('#edf1f6');
    const initNode = nodeWith('init');
    expect(initNode.querySelector('.run-node-box')?.getAttribute('stroke')).toBe(METRIC_EMPTY);
    // 容器注水：有水位的节点带水体与警戒线，无数据节点两者皆无
    expect(build0.querySelector('.run-node-water')).toBeTruthy();
    expect(build0.querySelector('.run-water-line')).toBeTruthy();
    expect(build1.querySelector('.run-node-water')).toBeTruthy();
    expect(initNode.querySelector('.run-node-water')).toBeNull();
    expect(initNode.querySelector('.run-water-line')).toBeNull();
    // 图例是注水语义（水深 + 警戒线），不是低→高分位
    const legend = document.querySelector('[aria-label="图例"]')?.textContent ?? '';
    expect(legend).toContain('水深 = 峰值水位');
    expect(legend).toContain('80% 警戒线');

    // 侧栏：成员会话胶囊挂水位；失败归因块给水位逼限线索（86% ≥ 80%）
    await act(async () => {
      build0.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const aside = document.querySelector('aside')!;
    expect(aside.textContent).toContain('水位 86%');
    expect(aside.textContent).toContain('上下文水位达 86%');
    expect(aside.textContent).toContain('逼近上限');

    // 时间轴摘要：run 级峰值水位
    await act(async () => { clickToolbarButton('视图模式', '时间轴'); });
    const text = document.body.textContent ?? '';
    expect(text).toContain('峰值水位');
    expect(text).toContain('86%');
  });

  it('冗余透镜：绝对阈值三档着色（<0.60 红）+ 会话行为信号块 + 成员胶囊冗余分', async () => {
    await renderObsPage();
    await act(async () => { clickToolbarButton('指标透镜', '冗余'); });
    const nodeWith = (t: string) =>
      Array.from(document.querySelectorAll('.run-node')).find(n => n.textContent?.includes(t))!;
    // build g0（ses_mini_a 冗余 0.52）→ 红；build g1（ses_mini_c 1.00）→ 绿；
    // init 无会话数据 → 灰（冗余分是绝对阈值，不是分位——满屏干净时也如实全绿）
    const build0 = nodeWith('0.52');
    const build1 = nodeWith('1.00');
    expect(build0.querySelector('.run-node-box')?.getAttribute('stroke')).toBe('#cf222e');
    expect(build1.querySelector('.run-node-box')?.getAttribute('stroke')).toBe('#1a7f37');
    const initNode = nodeWith('init');
    expect(initNode.querySelector('.run-node-box')?.getAttribute('stroke')).toBe(METRIC_EMPTY);
    // 冗余透镜不注水（容器注水是水位透镜专属视觉）
    expect(build0.querySelector('.run-node-water')).toBeNull();
    // 图例：三档语义 + 无会话数据
    const legend = document.querySelector('[aria-label="图例"]')?.textContent ?? '';
    expect(legend).toContain('≥0.80 干净');
    expect(legend).toContain('0.60–0.80 一般');
    expect(legend).toContain('<0.60 糙');

    // 侧栏：冗余信号块浮出异常子项（白话标题 + 白话解释 + 证据 + 复算明细），
    // 位置在会话列表下边（时长 → 会话 → 冗余信号）
    await act(async () => {
      build0.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const aside = document.querySelector('aside')!;
    expect(aside.textContent).toContain('冗余信号');
    expect(aside.textContent).toContain('子任务重派');
    expect(aside.textContent).toContain('同一个子任务派了 2 遍');
    expect(aside.textContent).toContain('上下文撑爆');
    expect(aside.textContent).toContain('触发 1 次压缩');
    expect(aside.textContent).toContain('复算：重派 1 次 ×50 当量');
    expect(aside.textContent).toContain('turn 6');
    expect(aside.textContent).toContain('冗余 0.52');
    expect(aside.textContent).toContain('效率 0.86');
    // 冗余信号块在会话列表下边（首枚成员胶囊「冗余 0.52」在其之前）
    const asideText = aside.textContent ?? '';
    expect(asideText.indexOf('冗余信号')).toBeGreaterThan(asideText.indexOf('冗余 0.52'));

    // 干净节点（build g1，findings 空）：零值不展示，无冗余信号块
    await act(async () => {
      build1.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const aside1 = document.querySelector('aside')!;
    expect(aside1.textContent).not.toContain('冗余信号');
    expect(aside1.textContent).toContain('冗余 1.00');
  });

  it('节点着色面积信号：底色按档染色 + 2px 描边（状态/用量/冗余透镜统一），无数据不染色', async () => {
    await renderObsPage();
    const boxes = () => Array.from(document.querySelectorAll('.run-node .run-node-box'));
    const findByStroke = (c: string) => boxes().find(b => b.getAttribute('stroke') === c)!;

    // 状态透镜（默认）：节点盒染状态色（8%，P3 铺色降饱和），描边加粗 2px
    const failedBox = findByStroke(statusColor('failed'));
    expect(failedBox.getAttribute('fill')).toBe(statusColor('failed'));
    expect(failedBox.getAttribute('fill-opacity')).toBe('0.08');
    expect(failedBox.getAttribute('stroke-width')).toBe('2');
    expect(failedBox.getAttribute('stroke-opacity')).toBe('0.9');
    const passedBox = findByStroke(statusColor('passed'));
    expect(passedBox.getAttribute('fill')).toBe(statusColor('passed'));

    // 用量透镜（Token）：底色 = 分位色，浓度随档递增（0.08–0.26）；无数据节点
    // 不染色（fill 保持中性底）且灰描边，与最低档浅蓝可分
    await act(async () => { clickToolbarButton('指标透镜', 'Token'); });
    const initBox = boxes().find(b => b.getAttribute('stroke') === METRIC_EMPTY)!;
    expect(initBox.getAttribute('fill')).toBe(RUN_COLORS.nodeFill);
    expect(initBox.getAttribute('fill-opacity')).toBeNull();
    const tinted = boxes().filter(b => b.getAttribute('fill-opacity') !== null);
    expect(tinted.length).toBeGreaterThan(0);
    for (const b of tinted) {
      const opacity = Number(b.getAttribute('fill-opacity'));
      expect(opacity).toBeGreaterThanOrEqual(0.08);
      expect(opacity).toBeLessThanOrEqual(0.26);
      expect(b.getAttribute('fill')).toBe(b.getAttribute('stroke')); // 底色与描边同色
      expect(b.getAttribute('stroke-width')).toBe('2');
    }

    // 冗余透镜：三档色 + 越糙染越重（0.19 糙 / 0.06 干净）
    await act(async () => { clickToolbarButton('指标透镜', '冗余'); });
    const rough = boxes().find(b => b.getAttribute('stroke') === '#cf222e')!;
    expect(rough.getAttribute('fill')).toBe('#cf222e');
    expect(rough.getAttribute('fill-opacity')).toBe('0.19');
    const clean = boxes().find(b => b.getAttribute('stroke') === '#1a7f37')!;
    expect(clean.getAttribute('fill-opacity')).toBe('0.06');

    // 水位透镜：盒底保持中性（水体是面积信号，不双重染色）
    await act(async () => { clickToolbarButton('指标透镜', '水位'); });
    const waterBox = boxes().find(b => b.getAttribute('stroke') === '#155fae')!;
    expect(waterBox.getAttribute('fill')).toBe(RUN_COLORS.nodeFill);
    expect(waterBox.getAttribute('fill-opacity')).toBeNull();
  });

  it('Run Trace 时间轴：摘要指标 + 执行/验收条泳道，点条选节点联动侧栏', async () => {
    await renderObsPage();
    await act(async () => { clickToolbarButton('视图模式', '时间轴'); });

    // 结构图让位时间轴，摘要栏给出系统级指标（口径见注释内样本数据）
    expect(document.querySelector('.run-trace')).toBeTruthy();
    expect(document.querySelector('.run-canvas')).toBeNull();
    const text = document.body.textContent ?? '';
    expect(text).toContain('墙钟');
    expect(text).toContain('3.8min');  // 02:00:12 → 02:04:00 = 228s
    expect(text).toContain('Σ时长');
    expect(text).toContain('4.3min');  // build g0 时长 228s + build g1 时长 30s = 258s
    expect(text).toContain('并行度');
    expect(text).toContain('1.1');     // 258 / 228
    expect(text).toContain('重试开销');
    expect(text).toContain('77%');     // 失败尝试跨度 (168 + 30) / Σ时长 258s
    // 构成四元：执行 108s / 验收 110s / 间隙 10s / 重试等待 30s（分母 Σ时长 258s）
    expect(text).toContain('构成');
    expect(text).toContain('执行 42%');
    expect(text).toContain('验收 43%');
    expect(text).toContain('间隙 4%');
    expect(text).toContain('重试等待 12%');

    // 泳道：build 两代各一条（g0 两次尝试共线一行——顺序重试横向续写，g1 一行）；
    // 执行条实心 + 验收条描边（ses_mini_b）
    expect(document.querySelectorAll('.trace-lane').length).toBe(2);
    expect(document.querySelectorAll('.trace-row').length).toBe(2);
    expect(document.querySelectorAll('.trace-bar').length).toBe(4);
    expect(document.querySelectorAll('.trace-bar-verify').length).toBe(1);
    // 派发间隙显影：build g0 执行结束（02:01:00）→ 验收开始（02:01:10）一条点状线
    expect(document.querySelectorAll('.trace-gap').length).toBe(1);
    // 重试等待显影：g0 第 1 次结束 → 第 2 次开始（30s 等待）一条等待虚线；
    // 尝试徽标共线后仍在（第1次/第2次区分横向续写的尝试）
    expect(document.querySelectorAll('.trace-wait').length).toBe(1);
    const svgText = document.querySelector('.run-trace svg')?.textContent ?? '';
    expect(svgText).toContain('第1次');
    expect(svgText).toContain('第2次');
    // 共线契约：g0 两次尝试的执行条同一行——同 y 基线（第1/第2次徽标所在
    // rect 的 y 相等，此前按尝试叠行 y 差一个行高）
    const ordRects = Array.from(document.querySelectorAll<SVGRectElement>('.run-trace svg g.trace-bar rect'))
      .filter(r => r.getAttribute('height') === '8');
    expect(ordRects.length).toBe(3);  // g0×2 + g1×1
    const g0Pair = [0, 1].map(i => ordRects[i].getAttribute('y'));
    expect(g0Pair[0]).toBe(g0Pair[1]);

    // 点击执行条 → 选中节点，侧栏从概览切到运行历史 + 时间四元构成块
    await act(async () => {
      (document.querySelector('.trace-bar') as Element).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const after = document.body.textContent ?? '';
    expect(after).not.toContain('Run 概览');
    expect(after).toContain('第 1 次');
    expect(after).toContain('执行：');
    // 时间块：时长含重试等待（228s = 168 + 30等待 + 30），非零构成才展示
    expect(after).toContain('时长');
    expect(after).toContain('3.8min');
    expect(after).toContain('执行 1.3min');       // 48 + 30
    expect(after).toContain('验收 1.8min');       // 110
    expect(after).toContain('间隙 10.0s');
    expect(after).toContain('重试等待 30.0s');
    expect(document.querySelectorAll('.usage-compose-bar > span').length).toBe(4);
    // 尝试徽标悬浮给出同口径分解（第 1 次尝试：48s 执行 + 110s 验收 + 10s 间隙）
    const badge = Array.from(document.querySelectorAll('aside [title^="耗时"]'))[0];
    expect(badge?.getAttribute('title')).toContain('执行 48.0s');
    expect(badge?.getAttribute('title')).toContain('验收 1.8min');
    expect(badge?.getAttribute('title')).toContain('间隙 10.0s');
  });

  it('重试账本：平行宇宙对比（可对账）+ 浪费明细行点击联动侧栏', async () => {
    await renderObsPage();
    await act(async () => { clickToolbarButton('视图模式', '账本'); });
    expect(document.querySelector('.run-retry-ledger')).toBeTruthy();
    expect(document.querySelector('.run-canvas')).toBeNull();
    expect(document.querySelector('.run-trace')).toBeNull();
    const text = document.body.textContent ?? '';

    // 平行宇宙（意图管线 init → build 关键路径，attempt 级时间口径）：
    // 现实 = build g0 墙钟 228s + g1 30s + init 5s = 263s；
    // 首试即过 = build 两次末次尝试 30+30s + init 5s = 65s
    expect(text).toContain('平行宇宙');
    expect(text).toContain('4.4min');  // A 模拟墙钟 263s
    expect(text).toContain('1.1min');  // B 模拟墙钟 65s
    expect(text).toContain('121k');    // A Token（120k + 1k）
    // 可省 = 263 − 65 = 198s = 账本总额（build g0：228s − 末次尝试 30s，严格对账）
    expect(text).toContain('可省（上界）');
    expect(text).toContain('75%');
    expect(text).toContain('120k');
    // 真实墙钟参照（观测值 228s，与模拟的差 = 回滚代并行/调度效应）
    expect(text).toContain('真实墙钟 3.8min');

    // 修复优先级表：仅 build g0（两次尝试）入账，合计与宇宙之差对账
    expect(text).toContain('修复优先级');
    expect(text).toContain('全局可提前');
    const row = document.querySelector('.ledger-row')!;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('build');
    expect(row.textContent).toContain('第 1 次运行');
    expect(row.textContent).toContain('2 次');
    expect(row.textContent).toContain('120k');
    expect(row.textContent).toContain('失败');
    // 失败归因徽标：两次失败原因不同（缺少边界用例 / exit 1）→ 原因各异
    expect(row.textContent).toContain('原因各异');
    // 节点浪费与全局可提前各 198s（串行关键路径上无并行吸收，两列相等）
    expect((row.textContent?.match(/3\.3min/g) ?? []).length).toBe(2);
    // 尝试解剖阶梯：a1(168s 失败) + 等待(30s) + a2(30s 失败) 三段
    expect(row.querySelectorAll('.ledger-ladder > span').length).toBe(3);
    expect((document.body.textContent ?? '')).toContain('合计浪费 3.3min · 120k tokens');

    // 点击行 → 侧栏切到该节点运行历史（与结构图/时间轴共用选中）
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const after = document.body.textContent ?? '';
    expect(after).not.toContain('Run 概览');
    expect(after).toContain('第 1 次');
    expect(after).toContain('执行：');
  });
});

describe('失败归因 post-mortem：环境指纹 / 同因连败 / 验收项清单', () => {
  // 独立 viewModel：build g0 两次失败都是同一验收项「边界用例齐全」未过
  // （证据文本不同——同因按归一化验收项聚类，不按整篇报告）；init 注入一次
  // 环境失败（curl 超时）作环境指纹样本
  const pmVm = buildViewModel(parseAndIndex(fixture));
  const pmBuildG0 = pmVm.nodes.find(n => n.nodeId === 'build' && n.generation === 0)!;
  pmBuildG0.attempts[0].verification = {
    type: 'agent',
    status: 'failed',
    reason: [
      '我已完成全部验收项核查，逐项结论如下。',
      '**1. 包骨架完整（op/ 目录结构）— met** `test -d op` 全部命中，退出 0。',
      '**2. 边界用例齐全（tests 目录含边界样例）— not met** find op/tests -name "*boundary*" 返回空。',
    ].join('\n'),
  };
  pmBuildG0.attempts.push({
    ordinal: 2,
    status: 'failed',
    startedAt: null,
    finishedAt: null,
    outputText: null,
    verification: {
      type: 'agent',
      status: 'failed',
      reason: [
        '**1. 包骨架完整（op/ 目录结构）— met** 退出 0。',
        '**2. 边界用例齐全（tests 目录含边界样例）— not met** 仍未补充：grep -r boundary op/tests 无匹配，exit 1。',
      ].join('\n'),
    },
    executeMember: {
      memberId: 'm-pm-b2', kind: 'session', role: 'execute', name: null, note: null,
      sessionId: 'ses_pm_b2', location: null, startedAt: null, finishedAt: null,
    },
    verifyMember: null,
  });
  const pmInit = pmVm.nodes.find(n => n.nodeId === 'init' && n.generation === 0)!;
  pmInit.attempts.push({
    ordinal: 2,
    status: 'failed',
    startedAt: null,
    finishedAt: null,
    outputText: 'curl: (28) operation timed out after 30000 milliseconds\nexit 1',
    verification: { type: 'script', status: 'failed', reason: 'exit 1' },
    executeMember: {
      memberId: 'm-pm-i2', kind: 'process', role: 'execute', name: null, note: null,
      sessionId: null, location: null, startedAt: null, finishedAt: null,
    },
    verifyMember: null,
  });
  const pmBody = {
    run: {
      runId: 'minidemo01',
      name: index.manifest.name ?? null,
      status: pmVm.status,
      exportDataComplete: pmVm.exportDataComplete,
      startedAt: pmVm.startedAt,
      finishedAt: pmVm.finishedAt,
      import: importMeta,
    },
    viewModel: pmVm,
  };

  async function renderPmPage() {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => pmBody,
    })));
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(
          Suspense,
          { fallback: null },
          createElement(RunDetailPage, { params: Promise.resolve({ runId: 'minidemo01' }) }),
        ),
      );
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });
  }

  it('同因连败：同一验收项两次未过 → 归因徽标 + 单点修复建议 + 逐项清单', async () => {
    await renderPmPage();
    await act(async () => { clickNode('build'); });

    const aside = document.querySelector('aside')!;
    expect(aside.querySelector('.failure-attribution')).toBeTruthy();
    const text = aside.textContent ?? '';
    expect(text).toContain('失败归因');
    expect(text).toContain('同因连败');
    // 建议：单点修复即可全部消除，点名未过验收项
    expect(text).toContain('连败 2 次（第 1/2 次）');
    expect(text).toContain('单点修复即可全部消除');
    expect(text).toContain('边界用例齐全（tests 目录含边界样例）');
    // 末次失败的逐项清单：未过置顶（✗）+ 通过项（✓）+ 计数
    expect(text).toContain('末次失败验收（第 2 次 · 通过 1/2）');
    expect(text).toContain('包骨架完整（op/ 目录结构）');
  });

  it('环境指纹：curl 超时失败 → 疑似环境 + 修环境/豁免重试建议（改 prompt 无效）', async () => {
    await renderPmPage();
    await act(async () => { clickNode('init'); });

    const aside = document.querySelector('aside')!;
    expect(aside.querySelector('.failure-attribution')).toBeTruthy();
    const text = aside.textContent ?? '';
    expect(text).toContain('疑似环境');
    expect(text).toContain('改 prompt 或收紧验收无效');
    expect(text).toContain('豁免出重试预算');
    // init 第 1 次通过在第 2 次失败之前——不是重试自愈
    expect(text).not.toContain('重试自愈');
  });

  it('账本归因徽标：修复名单直接带「为什么败」（同因连败 / 疑似环境）', async () => {
    await renderPmPage();
    await act(async () => {
      const group = document.querySelector('[aria-label="视图模式"]')!;
      const btn = Array.from(group.querySelectorAll('button')).find(b => b.textContent === '账本');
      expect(btn).toBeTruthy();
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const rows = Array.from(document.querySelectorAll('.ledger-row'));
    expect(rows.length).toBe(2);
    const buildRow = rows.find(r => r.textContent?.includes('build'))!;
    expect(buildRow.textContent).toContain('同因连败');
    const initRow = rows.find(r => r.textContent?.includes('init'))!;
    expect(initRow.textContent).toContain('疑似环境');
  });

  it('部分通过（partially met / partial）不计为通过：末次清单归入 ✗、通过计数不计入', async () => {
    // 独立 viewModel：末次失败三项验收——met / partially met / partial
    const pvVm = buildViewModel(parseAndIndex(fixture));
    const pvBuild = pvVm.nodes.find(n => n.nodeId === 'build' && n.generation === 0)!;
    pvBuild.attempts[0].verification = {
      type: 'agent',
      status: 'failed',
      reason: [
        '逐项结论如下。',
        '**1. 包骨架完整（op/ 目录结构）— met** `test -d op` 退出 0。',
        '**2. 边界用例齐全（tests 目录含边界样例）— partially met** 仅覆盖部分子目录。',
        '**3. 样例无残留（grep 无 AddCustom）— partial** 仍有 1 处残留。',
      ].join('\n'),
    };
    const pvBody = {
      run: {
        runId: 'minidemo01',
        name: index.manifest.name ?? null,
        status: pvVm.status,
        exportDataComplete: pvVm.exportDataComplete,
        startedAt: pvVm.startedAt,
        finishedAt: pvVm.finishedAt,
        import: importMeta,
      },
      viewModel: pvVm,
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => pvBody })));
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(Suspense, { fallback: null },
          createElement(RunDetailPage, { params: Promise.resolve({ runId: 'minidemo01' }) })),
      );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    await act(async () => { clickNode('build'); });
    const aside = document.querySelector('aside')!;
    const text = aside.textContent ?? '';
    // 只有 met 计通过（1/3）：partially met 与 partial 都归入未通过（✗）
    expect(text).toContain('通过 1/3');
    expect(text).toContain('边界用例齐全（tests 目录含边界样例）');
    expect(text).toContain('样例无残留（grep 无 AddCustom）');
  });
});
