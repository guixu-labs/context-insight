// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Run 详情 Context/Perf tab IT：URL 感知 fetch mock 驱动页面级验证——
// ①?tab=context 深链（恢复的 ContextTracker run 泛化：成员 root 卡以会话
// 短名命名 + 子代理池化 + 上下文增长趋势图；→ Turns 跳转带 member 归因）；
// ②Perf tab 复用 PerfPanorama（endpoints 覆盖切 run 端点按成员取数，
// session 端点不触达）。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Suspense } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { parseAndIndex } from '@/lib/run/reader';
import { buildViewModel } from '@/lib/run/view-model';
import { attachSessionRefs } from '@/lib/run/session-link';
import type { RunImportMeta } from '@/lib/run/run-store';
import RunDetailPage from '@/app/run/[runId]/page';

const nav = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn() }));
const searchState = vi.hoisted(() => ({ current: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: nav.replace, back: nav.back, refresh: () => {} }),
  usePathname: () => '/run/minidemo01',
  useSearchParams: () => new URLSearchParams(searchState.current),
}));

const fixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'),
) as unknown;
const index = parseAndIndex(fixture);
const viewModel = buildViewModel(index);
attachSessionRefs(viewModel, new Map([
  ['ses_mini_a', {
    taskId: 'ses_mini_a', framework: 'opencode', rowId: 'row_a', turns: 3,
    totalTokens: 100, durationMs: 60000, label: '成员A',
    startTime: '2026-10-13T02:00:12.000Z', endTime: '2026-10-13T02:01:12.000Z',
    cacheReadTokens: 0, contextPeakPct: 72.5, model: 'volc-gateway/glm-4.7',
    totalCost: 0.2, version: null, totalLatencyMs: 60000,
  }],
  ['ses_mini_b', {
    taskId: 'ses_mini_b', framework: 'opencode', rowId: 'row_b', turns: 2,
    totalTokens: 200, durationMs: 30000, label: '成员B',
    startTime: '2026-10-13T02:02:00.000Z', endTime: '2026-10-13T02:02:30.000Z',
    cacheReadTokens: 0, contextPeakPct: 40, model: 'volc-gateway/glm-4.7',
    totalCost: 0.1, version: null, totalLatencyMs: 30000,
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

// /context 新口径：瘦轮次投影（root+subagent 全量、member 归因）+ 每 agent
// 窗口上限（root=会话模型、subagent=首见非空轮模型归一）
const contextTurns = [
  { turnId: 'rop-ctx-a0', turnIndex: 0, role: 'assistant', agentName: 'build', isSubagent: false,
    subagentName: null, subagentSessionId: null, parentExecutionId: null,
    member: { taskId: 'ses_mini_a', label: '成员A' }, contentSummary: '成员A开始',
    createdAt: '2026-10-13T02:00:40.000Z', completedAt: null, model: 'glm-4.7',
    totalTokens: 30000, inputTokens: 20000, outputTokens: 8000, reasoningTokens: 2000,
    cacheReadTokens: 5000, cacheWriteTokens: 1000, inputMessagesTokens: 22000, contextWindowPct: 20, latencyMs: 900 },
  { turnId: 'rop-ctx-a1', turnIndex: 1, role: 'assistant', agentName: 'build', isSubagent: false,
    subagentName: null, subagentSessionId: null, parentExecutionId: null,
    member: { taskId: 'ses_mini_a', label: '成员A' }, contentSummary: '成员A推进',
    createdAt: '2026-10-13T02:00:50.000Z', completedAt: null, model: 'glm-4.7',
    totalTokens: 70000, inputTokens: 50000, outputTokens: 15000, reasoningTokens: 5000,
    cacheReadTokens: 12000, cacheWriteTokens: 2000, inputMessagesTokens: 60000, contextWindowPct: 50, latencyMs: 1100 },
  { turnId: 'rop-ctx-a2', turnIndex: 2, role: 'assistant', agentName: 'build', isSubagent: false,
    subagentName: null, subagentSessionId: null, parentExecutionId: null,
    member: { taskId: 'ses_mini_a', label: '成员A' }, contentSummary: '成员A峰值',
    createdAt: '2026-10-13T02:01:00.000Z', completedAt: null, model: 'glm-4.7',
    totalTokens: 100000, inputTokens: 72000, outputTokens: 20000, reasoningTokens: 8000,
    cacheReadTokens: 20000, cacheWriteTokens: 3000, inputMessagesTokens: 90000, contextWindowPct: 72.5, latencyMs: 1300 },
  { turnId: 'rop-ctx-sub0', turnIndex: 3, role: 'assistant', agentName: 'rop-研究员', isSubagent: true,
    subagentName: 'rop-研究员', subagentSessionId: 'rop-sub-1', subagentType: 'research', parentExecutionId: 'rop-exec-root',
    member: { taskId: 'ses_mini_a', label: '成员A' }, contentSummary: '子代理调研',
    createdAt: '2026-10-13T02:00:45.000Z', completedAt: null, model: 'glm-4.7-sub',
    totalTokens: 8000, inputTokens: 5000, outputTokens: 3000, reasoningTokens: 0,
    cacheReadTokens: 1000, cacheWriteTokens: 0, inputMessagesTokens: 6000, contextWindowPct: 9.4, latencyMs: 500 },
  { turnId: 'rop-ctx-b0', turnIndex: 0, role: 'assistant', agentName: 'build', isSubagent: false,
    subagentName: null, subagentSessionId: null, parentExecutionId: null,
    member: { taskId: 'ses_mini_b', label: '成员B' }, contentSummary: '成员B开始',
    createdAt: '2026-10-13T02:02:00.000Z', completedAt: null, model: 'glm-4.7',
    totalTokens: 15000, inputTokens: 9000, outputTokens: 5000, reasoningTokens: 1000,
    cacheReadTokens: 2000, cacheWriteTokens: 500, inputMessagesTokens: 10000, contextWindowPct: 10, latencyMs: 800 },
  { turnId: 'rop-ctx-b1', turnIndex: 1, role: 'assistant', agentName: 'build', isSubagent: false,
    subagentName: null, subagentSessionId: null, parentExecutionId: null,
    member: { taskId: 'ses_mini_b', label: '成员B' }, contentSummary: '成员B完成',
    createdAt: '2026-10-13T02:02:20.000Z', completedAt: null, model: 'glm-4.7',
    totalTokens: 50000, inputTokens: 32000, outputTokens: 12000, reasoningTokens: 6000,
    cacheReadTokens: 8000, cacheWriteTokens: 1000, inputMessagesTokens: 40000, contextWindowPct: 40, latencyMs: 1000 },
];
const contextAgentLimits = [
  { key: 'root:ses_mini_a', kind: 'root', model: 'volc-gateway/glm-4.7', contextLimit: 128000 },
  { key: 'root:ses_mini_b', kind: 'root', model: 'volc-gateway/glm-4.7', contextLimit: 128000 },
  { key: 'rop-sub-1', kind: 'subagent', model: 'glm-4.7-sub', contextLimit: 64000 },
];

const PERF_T0 = Date.parse('2026-10-13T02:00:00.000Z')

const execRoot = {
  executionId: 'rop-exec-root', sessionId: 'row_a', agentName: 'rop-alpha-agent', agentSessionId: null,
  isSubagent: false, member: { taskId: 'ses_mini_a', label: '成员A' },
  subagentType: null, subagentName: null, parentExecutionId: null, rootExecutionId: null,
  depth: 0, tokens: 500, inputTokens: 300, outputTokens: 200, reasoningTokens: 0,
  cacheReadInputTokens: 20, cacheCreationInputTokens: 10, cost: 0.02, latencyMs: 1200,
  toolCallCount: 3, toolCallErrorCount: 0, llmCallCount: 2, skillLoadCount: 0, skillInvokeCount: 1,
  model: 'glm-4.7', createdAt: '2026-10-13T02:00:10.000Z', skills: [],
  span: { start: PERF_T0 + 10_000, end: PERF_T0 + 720_000 },
  activeIntervals: [
    { start: PERF_T0 + 10_000, end: PERF_T0 + 40_000 },
    { start: PERF_T0 + 360_000, end: PERF_T0 + 480_000 },
  ],
};
const execSub = {
  ...execRoot,
  executionId: 'rop-exec-sub', agentName: 'rop-研究员', agentSessionId: 'rop-sub-1',
  isSubagent: true, subagentType: 'research', subagentName: 'rop-研究员',
  parentExecutionId: 'rop-exec-root', rootExecutionId: 'rop-exec-root', depth: 1,
  tokens: 150, inputTokens: 100, outputTokens: 50, latencyMs: 600,
  model: 'glm-4.7-sub', createdAt: '2026-10-13T02:00:45.000Z',
  span: { start: PERF_T0 + 30_000, end: PERF_T0 + 180_000 },
  activeIntervals: [{ start: PERF_T0 + 30_000, end: PERF_T0 + 180_000 }],
};

const perfTurn = {
  turnId: 'rop-t-a0', turnIndex: 0, role: 'assistant', agentName: 'build', isSubagent: false,
  subagentName: null, subagentSessionId: null, member: { taskId: 'ses_mini_a', label: '成员A' },
  contentSummary: '成员A开始', createdAt: '2026-10-13T02:00:40.000Z',
  totalTokens: 120, inputTokens: 60, outputTokens: 50, reasoningTokens: 10,
  cacheReadTokens: 10, cacheWriteTokens: 5, contextWindowPct: 55, latencyMs: 900, turnMs: 120_000,
  model: 'glm-4.7', toolCalls: [], skillEvents: [],
};
// 成员B 轮（工具耗时卡成员轴命名 + 矩阵列）
const perfTurnB = {
  ...perfTurn,
  turnId: 'rop-t-b0', turnIndex: 0,
  member: { taskId: 'ses_mini_b', label: '成员B' },
  contentSummary: '成员B开始', createdAt: '2026-10-13T02:02:00.000Z',
};

// 子代理轮（rop-研究员 挂在成员A 名下）：泳道归属 + 深链入态夹具
const perfSubTurn = {
  turnId: 'rop-t-sub0', turnIndex: 0, role: 'assistant', agentName: 'rop-研究员', isSubagent: true,
  subagentName: 'rop-研究员', subagentSessionId: 'rop-sub-1',
  member: { taskId: 'ses_mini_a', label: '成员A' },
  contentSummary: '子代理调研', createdAt: '2026-10-13T02:00:50.000Z',
  totalTokens: 80, inputTokens: 50, outputTokens: 20, reasoningTokens: 10,
  cacheReadTokens: 5, cacheWriteTokens: 2, contextWindowPct: 30, latencyMs: 600,
  turnMs: 45_000,
  model: 'glm-4.7-sub', toolCalls: [], skillEvents: [],
};

const perfSubTurnB = {
  ...perfSubTurn,
  turnId: 'rop-t-sub1',
  turnIndex: 1,
  contentSummary: '子代理收尾',
  createdAt: '2026-10-13T02:00:55.000Z',
};

const perfParentAckTurn = {
  ...perfTurn,
  turnId: 'rop-t-parent-ack',
  turnIndex: 2,
  contentSummary: '收到子代理交回结果',
  createdAt: '2026-10-13T02:03:10.000Z',
};

const perfBridge = {
  bridgeId: 'rop-bridge-sub',
  dispatchExecutionId: 'rop-exec-root',
  dispatchTurnId: 'rop-t-a0',
  dispatchToolCallId: 'tc-spawn-sub',
  dispatchContent: '子代理调研',
  dispatchTimestamp: '2026-10-13T02:00:30.000Z',
  dispatchBackground: false,
  responseExecutionId: null,
  responseTurnId: 'rop-t-sub1',
  responseContent: '子代理收尾',
  responseTimestamp: '2026-10-13T02:03:00.000Z',
  subagentSessionId: 'rop-sub-1',
  subagentType: 'research',
  subagentName: 'rop-研究员',
  agentName: 'research',
  parentResponseTurnId: 'rop-t-parent-ack',
  status: 'completed',
  subagentTokens: 160,
  subagentLatencyMs: 150_000,
  member: { taskId: 'ses_mini_a', label: '成员A' },
};

const fetchCalls: string[] = [];

// 工具耗时卡夹具（Perf「成员 × 工具」双维度的工具侧）：Read（含错误与
// 最大耗时长尾，4 成员格——分解面板全量清单 + 搜索双匹配覆盖）> Task
// （派发）> skill（技能加载元调用——提示词注入类，wire 回填毫秒级）>
// Grep（无计时）——排行序/诚实标注/徽标/统计列与成员分解清单下钻断言用
const perfToolStats = {
  tools: [
    { toolName: 'Read', calls: 6, errors: 1, totalMs: 9000, timedCalls: 6, untimedCalls: 0, wireDerived: 1, minMs: 500, p50Ms: 3000, p95Ms: 5000, maxMs: 5000, avgMs: 1500, isDispatch: false, isSkillRelated: false, errorTypes: [{ type: 'timeout', count: 1 }] },
    { toolName: 'Task', calls: 1, errors: 0, totalMs: 3500, timedCalls: 1, untimedCalls: 0, wireDerived: 0, minMs: 3500, p50Ms: 3500, p95Ms: 3500, maxMs: 3500, avgMs: 3500, isDispatch: true, isSkillRelated: false, errorTypes: [] },
    { toolName: 'skill', calls: 2, errors: 0, totalMs: 500, timedCalls: 2, untimedCalls: 0, wireDerived: 2, minMs: 1, p50Ms: 4, p95Ms: 13, maxMs: 41, avgMs: 5, isDispatch: false, isSkillRelated: true, errorTypes: [] },
    { toolName: 'Grep', calls: 1, errors: 0, totalMs: 0, timedCalls: 0, untimedCalls: 1, wireDerived: 0, minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, avgMs: 0, isDispatch: false, isSkillRelated: false, errorTypes: [] },
  ],
  matrix: {
    Read: {
      ses_mini_a: {
        calls: 3, totalMs: 6000, errors: 1, firstTurnId: 'rop-t-a0',
        turns: [
          { turnId: 'rop-t-a0', turnIndex: 0, calls: 2, totalMs: 5500, errors: 1, ts: 1 },
          { turnId: 'rop-ctx-a0', turnIndex: 1, calls: 1, totalMs: 500, errors: 0, ts: 2 },
        ],
      },
      ses_mini_b: { calls: 1, totalMs: 2000, errors: 0, firstTurnId: 'rop-ctx-b0', turns: [{ turnId: 'rop-ctx-b0', turnIndex: 0, calls: 1, totalMs: 2000, errors: 0, ts: 3 }] },
      'ts-m3': { calls: 1, totalMs: 500, errors: 0, firstTurnId: 'rop-t-a0', turns: [{ turnId: 'rop-t-a0', turnIndex: 0, calls: 1, totalMs: 500, errors: 0, ts: 4 }] },
      'ts-m4': { calls: 1, totalMs: 500, errors: 0, firstTurnId: 'rop-ctx-a0', turns: [{ turnId: 'rop-ctx-a0', turnIndex: 1, calls: 1, totalMs: 500, errors: 0, ts: 5 }] },
    },
    Task: { ses_mini_b: { calls: 1, totalMs: 3500, errors: 0, firstTurnId: 'rop-ctx-b0', turns: [{ turnId: 'rop-ctx-b0', turnIndex: 0, calls: 1, totalMs: 3500, errors: 0, ts: 6 }] } },
    skill: { ses_mini_a: { calls: 2, totalMs: 500, errors: 0, firstTurnId: 'rop-ctx-a0', turns: [{ turnId: 'rop-ctx-a0', turnIndex: 1, calls: 2, totalMs: 500, errors: 0, ts: 7 }] } },
    Grep: { ses_mini_b: { calls: 1, totalMs: 0, errors: 0, firstTurnId: 'rop-ctx-b0', turns: [{ turnId: 'rop-ctx-b0', turnIndex: 0, calls: 1, totalMs: 0, errors: 0, ts: 8 }] } },
  },
  members: [
    'ses_mini_a', 'ses_mini_b',
    'ts-m3', 'ts-m4', 'ts-m5', 'ts-m6', 'ts-m7', 'ts-m8',
    'ts-m9', 'ts-m10', 'ts-m11', 'ts-m12', 'ts-m13', 'ts-m14',
  ],
  meta: { totalCalls: 10, totalToolMs: 13000, dispatchMs: 3500, timedCalls: 9, untimedCalls: 1, wireDerivedCalls: 3 },
};

vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  fetchCalls.push(url);
  const u = new URL(url, 'http://localhost');
  const json = (body: unknown) => ({ ok: true, json: async () => body });
  if (u.pathname === '/api/observe/run/minidemo01') {
    return json({
      run: {
        runId: 'minidemo01', name: index.manifest.name ?? null, status: viewModel.status,
        exportDataComplete: true, startedAt: null, finishedAt: null, import: importMeta,
      },
      viewModel,
    });
  }
  if (u.pathname === '/api/observe/run/minidemo01/context') {
    return json({ turns: contextTurns, agentLimits: contextAgentLimits, total: contextTurns.length });
  }
  if (u.pathname === '/api/observe/run/minidemo01/executions') {
    return json({ items: [execRoot, execSub], root: [execRoot], subagents: [execSub], totalExecutions: 2, subagentCount: 1 });
  }
  if (u.pathname === '/api/observe/run/minidemo01/turns') {
    return json({ items: [perfTurn, perfTurnB, perfSubTurn, perfSubTurnB, perfParentAckTurn], total: 5, page: 1, pageSize: Number(u.searchParams.get('pageSize') ?? 200) });
  }
  if (u.pathname === '/api/observe/run/minidemo01/bridges') {
    return json({ items: [perfBridge], total: 1 });
  }
  if (u.pathname === '/api/observe/run/minidemo01/tool-stats') {
    return json(perfToolStats);
  }
  return json({ items: [], total: 0 });
}));

let root: Root | null = null;

// history.pushState 间谍（条目栈 URL 镜像断言锚）：懒建 + renderPage 复位。
// 调用形态 (state, unused, url)——url 断言取第三参
let pushSpy: ReturnType<typeof vi.spyOn> | null = null;
function ensurePushSpy() {
  if (!pushSpy) pushSpy = vi.spyOn(window.history, 'pushState');
  return pushSpy;
}

async function renderPage(initialSearch = '') {
  searchState.current = initialSearch;
  // history 条目栈测试基建：重置当前条目 state（同文件跨用例防 runNavSeq/
  // runView 标残留）+ pushState 间谍复位（happy-dom 的 pushState 不更新
  // location，URL 断言走调用记录）
  window.history.replaceState(null, '', `/run/minidemo01${initialSearch}`);
  ensurePushSpy().mockClear();
  nav.replace.mockClear();
  fetchCalls.length = 0;
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
  await act(async () => { await new Promise(r => setTimeout(r, 20)) });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Run 详情 Context/Perf tab（ContextTracker run 泛化）', () => {
  it('?tab=context 深链：恢复的 ContextTracker（增长曲线 + 胶囊命名，卡片收编弹窗），跳 Turns 带成员归因', async () => {
    await renderPage('?tab=context');

    const tab = document.querySelector('[data-run-tab="context"]');
    expect(tab).toBeTruthy();
    expect(fetchCalls).toContain('/api/observe/run/minidemo01/context');
    const text = tab!.textContent ?? '';
    // 泳道同款视角：root 胶囊以成员会话短名命名（session 即 agent），子代理池化
    expect(text).toContain('上下文增长趋势');
    expect(text).toContain('回放');
    expect(text).toContain('成员A');
    expect(text).toContain('成员B');
    // 子代理胶囊：类型优先命名（`subagentType ?? agentName`，与泳道图例同键）
    expect(text).toContain('research');
    expect(text).not.toContain('rop-研究员');
    // 增长曲线：成员A/B root 时间线（平滑 path；子代理单点不画线，胶囊已证在场）
    expect(tab!.querySelectorAll('path[fill="none"]')).toHaveLength(2);
    // 概览面板退役：页面无卡片网格（数字全归弹窗，页面只留曲线形状）
    expect(tab!.querySelectorAll('[data-agent-row]')).toHaveLength(0);
    // 单卡契约：tab 外壳退卡（工作台 tint 约定，无边框/阴影——与 Perf/
    // Overview 同款），图表 Card 是唯一卡片层（此前外壳 border + Card
    // border 叠两层卡）
    const shell = tab!.firstElementChild as HTMLElement;
    expect(shell.className).toContain('bg-muted/30');
    expect(shell.className).not.toContain('shadow-sm');
    expect(shell.className).not.toContain('border');
    expect(tab!.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
    // 刀G：表头无成员选择模块（观测恒为全成员融合）；显隐快捷在画布内分段控件
    expect(tab!.querySelector('[data-quick-filter]')).toBeTruthy();

    // 组详情渐进披露：成员A 胶囊 → 右侧档案弹窗（弹窗经 Portal 挂 body；
    // 关键四数含窗口水位 72.5%——root 峰值 toFixed(1)）→ → Turns 跳转带
    // member 归因（root 组 = 成员会话；turnId 首轮）
    const detailBtn = (tab!.querySelector('[data-legend="成员A"]') as HTMLElement)
      .parentElement!.querySelector('button') as HTMLElement;
    await act(async () => { detailBtn.click() });
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    const detail = document.querySelector('[data-agent-detail]');
    expect(detail).toBeTruthy();
    expect(detail!.textContent).toContain('成员A');
    expect(detail!.querySelector('[data-agent-stats]')!.textContent).toContain('72.5%');
    const turnBtn = [...detail!.querySelectorAll('button')].find(b => b.textContent === '→ Turns');
    expect(turnBtn).toBeTruthy();
    await act(async () => { turnBtn!.click() });
    expect(ensurePushSpy().mock.calls.some(([, , url]) =>
      String(url).includes('tab=turns') && String(url).includes('member=ses_mini_a') && String(url).includes('turn=rop-ctx-a0'),
    )).toBe(true);
  });

  it('?tab=perf：run 视角卡片栈全景（画像/热点/效率），无会话隔离；跳转收敛 turn 深链', async () => {
    await renderPage('?tab=perf');

    const tab = document.querySelector('[data-run-tab="perf"]');
    expect(tab).toBeTruthy();
    // 无成员选择模块，默认即合并全景
    expect([...tab!.querySelectorAll('button')].find(b => b.textContent?.startsWith('全部'))).toBeUndefined();

    // 取数全部走 run 端点（不带 member），session 端点零触达；执行时间线
    // 已迁 Turns 顶部——Perf 不再取车道表（lanes 归 Turns 时间线取数）
    expect(fetchCalls.some(u => u === '/api/observe/run/minidemo01/executions')).toBe(true);
    expect(fetchCalls.some(u => u.startsWith('/api/observe/run/minidemo01/turns?') && u.includes('pageSize=20000'))).toBe(true);
    expect(fetchCalls.some(u => u === '/api/observe/run/minidemo01/bridges')).toBe(true);
    expect(fetchCalls.some(u => u === '/api/observe/run/minidemo01/lanes')).toBe(false);
    expect(fetchCalls.some(u => u.startsWith('/api/observe/session/'))).toBe(false);
    expect(fetchCalls.some(u => u.includes('member='))).toBe(false);

    // 卡片栈：运行画像（两区头卡：墙钟构成 + Token 构成，总量瓦片已归
    // Overview）+ 热点排行（成员A
    // 单元 + rop-研究员 子代理单元带父成员归属）；执行序列柱状图已退役
    // （与时间线/热点排行单元重复），类型构成亦退役（多成员 run 按 agent
    // 名混聚成孤条零信息，合计行与 Overview 总量复读）
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    const perf = document.querySelector('[data-run-tab="perf"]');
    const perfText = perf?.textContent ?? '';
    const profileCard = perf!.querySelector('[data-testid="perf-profile-card"]');
    expect(profileCard).toBeTruthy();
    expect(profileCard!.textContent).toContain('Token 构成');
    // 执行时间线不在 Perf（已迁 Turns 顶部）
    expect(perfText).not.toContain('Agent Swimlane');
    expect(perf!.querySelector('[data-bar]')).toBeNull();
    expect(perfText).toContain('热点排行');
    expect(perfText).toContain('总耗时');
    expect(perfText).toContain('成员A');
    expect(perfText).toContain('rop-研究员');
    const subLane = perf!.querySelector('[data-lane-row="rop-sub-1"]');
    expect(subLane?.textContent).toContain('子代理 · 成员A');
    const memberLaneSummary = perf!.querySelector('[data-lane-row="ses_mini_a"]');
    expect(memberLaneSummary?.textContent).toContain('4.0min');
    expect(memberLaneSummary?.textContent).toContain('66.7');
    expect(memberLaneSummary?.querySelector('[title*="opencode 原生可能包含工具执行"]')).toBeTruthy();
    expect(subLane?.textContent).toContain('1.5min');
    expect(subLane?.textContent).toContain('50.0');
    expect(perfText).not.toContain('类型构成');

    // 入场只做卡片级阶梯（与 Overview 同款）；图表元素不挂数据级动画
    //——大 run 数百上千根柱同时做 SVG transform 动画会打满主线程
    expect(profileCard!.className).toContain('animate-in');
    expect(perf!.querySelector('.perf-bar-rise')).toBeNull();
    expect(perf!.querySelector('.perf-grow-x')).toBeNull();

    // 跳转①：热点行内定位角标 → Turns 深链（该单元首轮）
    const locateBtn = subLane!.querySelector('[title="在 Turns 时间线定位该单元"]');
    expect(locateBtn).toBeTruthy();
    ensurePushSpy().mockClear();
    await act(async () => {
      locateBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(ensurePushSpy().mock.calls.length).toBeGreaterThan(0);
    expect(String(ensurePushSpy().mock.calls[0]?.[2])).toContain('tab=turns');
    expect(String(ensurePushSpy().mock.calls[0]?.[2])).toContain('turn=rop-t-sub0');

    // 同一出口再点一次：视图已在目标态，同值 navigate 是 no-op——不产生冗余
    // 历史条目（条目栈零增长）
    ensurePushSpy().mockClear();
    await act(async () => {
      locateBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(ensurePushSpy().mock.calls.length).toBe(0);

    // 跳转②：热点行展开 → 轮次行点击 → 该轮深链（成员A 首轮）
    const memberLane = perf!.querySelector('[data-lane-row="ses_mini_a"]')!;
    await act(async () => {
      memberLane.querySelector('[role="button"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const turnRow = memberLane.querySelector('[data-turn="rop-t-a0"]');
    expect(turnRow).toBeTruthy();
    expect(turnRow!.textContent).toContain('2.0min');
    expect(turnRow!.textContent).toContain('50%');
    ensurePushSpy().mockClear();
    await act(async () => {
      turnRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(String(ensurePushSpy().mock.calls[0]?.[2])).toContain('turn=rop-t-a0');
  });

  it('?tab=perf 工具耗时卡：inset 排行/诚实标注/派发技能标 + 成员段与分解行下钻 Turns 搜索深链（q 预填自动执行）', async () => {
    await renderPage('?tab=perf');

    // 取数并入五路合并（tool-stats = Perf 双维度的工具侧端点）
    expect(fetchCalls.some(u => u === '/api/observe/run/minidemo01/tool-stats')).toBe(true);

    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    const perf = document.querySelector('[data-run-tab="perf"]')!;
    const card = perf.querySelector('[data-testid="perf-tool-time"]');
    expect(card).toBeTruthy();

    // 排行序 = totalMs 降序（Read 9000 > Task 3500 > skill 500 > Grep 0）
    const rows = [...card!.querySelectorAll('[data-tool-row]')].map(g => g.getAttribute('data-tool-row'));
    expect(rows).toEqual(['Read', 'Task', 'skill', 'Grep']);

    // 诚实标注：无计时不进分位 + wire 回填计数 + 派发徽标 + Σ 与派发另计
    const cardText = card!.textContent ?? '';
    expect(cardText).toContain('无计时 1（不进分位）');
    expect(cardText).toContain('wire 回填 3');
    expect(cardText).toContain('派发');
    expect(cardText).toContain('派发 3.5s 另计');

    // 居中统计列（标签上/值下）：总耗时 + 最大耗时（均值会撒谎，最大 =
    // 长尾直觉读法；p50/p95 分位仍在行悬停 title）
    const readRowEl = card!.querySelector('[data-tool-row="Read"]')!;
    expect(readRowEl.textContent).toContain('总耗时');
    expect(readRowEl.textContent).toContain('最大耗时');
    expect(readRowEl.textContent).toContain('9.0s');
    expect(readRowEl.textContent).toContain('5.0s');

    // skill 族元调用徽标：胶囊「技能」+ 名字悬停（title）解释耗时语义（提示
    // 词注入非可执行工具）；普通工具（Read）无徽标——与派发标同门反馈语法
    const skillRow = card!.querySelector('[data-tool-row="skill"]')!;
    expect(skillRow.textContent).toContain('技能');
    expect(skillRow.querySelector('span[title]')?.getAttribute('title')).toContain('技能加载/调用——提示词注入类元调用，耗时不代表工具执行');
    const readRow = card!.querySelector('[data-tool-row="Read"]')!;
    expect(readRow.textContent).not.toContain('技能');

    // 右侧下钻面板（master-detail）：默认选中 Σ 最高工具（Read）常驻——
    // 全量成员按 Σ 降序（含无显示名成员回落原始 taskId），成员轴命名与泳
    // 道同源（member.label）；成员行点击 = 同款深链
    const panel = card!.querySelector('[data-tool-breakdown="Read"]');
    expect(panel).toBeTruthy();
    expect(panel!.textContent).toContain('成员 · 4');
    expect(panel!.textContent).toContain('成员A');
    expect(panel!.textContent).toContain('成员B');
    const memberRows = [...panel!.querySelectorAll('[data-member-row]')].map(b => b.getAttribute('data-member-row'));
    expect(memberRows).toEqual(['Read·ses_mini_a', 'Read·ses_mini_b', 'Read·ts-m3', 'Read·ts-m4']);

    // 三级下钻第三级：成员行点击 → 面板内展开逐轮调用清单（Σ 降序找慢
    // 轮；同轮多调用聚合 ×N；展开是纯面板动作，不导航——pushState 零调用）
    ensurePushSpy().mockClear();
    await act(async () => {
      panel!.querySelector('[data-member-row="Read·ses_mini_a"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const turnsBox = panel!.querySelector('[data-member-turns="Read·ses_mini_a"]');
    expect(turnsBox).toBeTruthy();
    const turnRowIds = [...turnsBox!.querySelectorAll('[data-member-turn]')].map(b => b.getAttribute('data-member-turn'));
    expect(turnRowIds).toEqual(['rop-t-a0', 'rop-ctx-a0']);   // 5500 > 500 的 Σ 降序
    expect(turnsBox!.textContent).toContain('5.5s');
    expect(turnsBox!.textContent).toContain('500ms');        // 亚秒级用 ms 整数（单位阶梯）
    expect(turnsBox!.textContent).toContain('×2');             // 同轮两次调用聚合一行
    expect(turnsBox!.textContent).toContain('#0');             // 轮次序号（#N 直达同口径）
    expect(ensurePushSpy().mock.calls.length).toBe(0);

    // 轮次行点击 → 跳转该轮（?turn= 深链 + Turns 轮详情深钻）
    await act(async () => {
      turnsBox!.querySelector('[data-member-turn="rop-t-a0"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const turnUrl = String(ensurePushSpy().mock.calls[0]?.[2]);
    expect(turnUrl).toContain('tab=turns');
    expect(turnUrl).toContain('turn=rop-t-a0');

    // 再点成员行收起（清单退场——手风琴开合的另一半）
    await act(async () => {
      panel!.querySelector('[data-member-row="Read·ses_mini_a"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(panel!.querySelector('[data-member-turns="Read·ses_mini_a"]')).toBeNull();

    // 搜索框双匹配：显示名（成员B）与原始 ID（ts-m3）皆命中——大 run 定位
    // 特定成员的正路；切换选中 Grep → 面板换内容且搜索态清空，再点收起 →
    // 占位空态（面板退场）
    const search = panel!.querySelector<HTMLInputElement>('input[data-tool-member-search]');
    const setNative = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setNative.call(search!, '成员B');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect([...panel!.querySelectorAll('[data-member-row]')].map(b => b.getAttribute('data-member-row')))
      .toEqual(['Read·ses_mini_b']);
    await act(async () => {
      setNative.call(search!, 'ts-m3');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect([...panel!.querySelectorAll('[data-member-row]')].map(b => b.getAttribute('data-member-row')))
      .toEqual(['Read·ts-m3']);
    await act(async () => {
      card!.querySelector('[data-tool-toggle="Grep"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const panel2 = card!.querySelector('[data-tool-breakdown="Grep"]');
    expect(panel2).toBeTruthy();
    expect(panel2!.textContent).toContain('成员 · 1');
    expect([...panel2!.querySelectorAll('[data-member-row]')].map(b => b.getAttribute('data-member-row')))
      .toEqual(['Grep·ses_mini_b']);
    // 无计时工具的逐轮行如实标「无计时」（源缺时间——轴不撒谎的第三级同款）
    await act(async () => {
      panel2!.querySelector('[data-member-row="Grep·ses_mini_b"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const grepTurns = panel2!.querySelector('[data-member-turns="Grep·ses_mini_b"]');
    expect(grepTurns).toBeTruthy();
    expect(grepTurns!.textContent).toContain('无计时');
    await act(async () => {
      card!.querySelector('[data-tool-toggle="Grep"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(card!.querySelector('[data-tool-breakdown]')).toBeNull();
    expect(card!.querySelector('[data-tool-breakdown-empty]')).toBeTruthy();

    // 工具行下钻（无 member 归因）：幽灵搜索角标点击 → tool:Grep 全成员搜
    // 索——q 换值重放的连续下钻路径（perf tab 常驻挂载仅隐藏，行仍在 DOM）
    const grepDrill = document.querySelector('[data-tool-drill="Grep"]');
    expect(grepDrill).toBeTruthy();
    ensurePushSpy().mockClear();
    await act(async () => {
      grepDrill!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(String(ensurePushSpy().mock.calls[0]?.[2])).toContain('q=tool%3AGrep');
    await act(async () => { await new Promise(r => setTimeout(r, 20)) });
    const input2 = document.querySelector<HTMLInputElement>('input[data-turns-search-input]');
    expect(input2?.value).toBe('tool:Grep');
    // Turns tab 挂载即消费 q：搜索真实执行（走 /turns/search——空转 = 回归）
    expect(fetchCalls.some(u => u.startsWith('/api/observe/run/minidemo01/turns/search?keyword='))).toBe(true);
  });
});
