// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// Turns 顶部时间线（RunTurnsTimeline）交互契约 IT：
//   ① 单击即跳——点哪一刻就选中那一刻的轮次（root 道整道可点、槽道只在条上可点、
//      点空槽不动作），无行轮不作目标；
//   ② 播放头跟随选中轮，且换选不重渲染道行子树（性能契约：走查时只有播放头动）；
//   ③ 图例过滤 / 测距模式 / 缩放 / 折叠 / 悬停浮窗 / 加载与空态。
// happy-dom 没有布局：轨道宽度统一打桩成 1000px，点击落点 = clientX / 1000。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { RunTurnsTimeline } from '@/components/run/turns-timeline/RunTurnsTimeline';
import { tintOf } from '@/components/run/turns-timeline/selection-geometry';
import type { SwimAgent, SwimBridge } from '@/lib/swimlane-model';

const lanesRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/run/turns-timeline/TimelineLanes', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/components/run/turns-timeline/TimelineLanes')>();
  const { memo, createElement } = await import('react');
  const CountingLane = memo(function CountingTimelineLane(props: ComponentProps<typeof mod.TimelineLane>) {
    lanesRenders.count += 1;
    return createElement(mod.TimelineLane, props);
  });
  // 外层只是把道逐个交给（被计数的）TimelineLane——与被测实现同一映射
  return {
    ...mod,
    TimelineLane: CountingLane,
    TimelineLanes: memo(function CountingTimelineLanes({ lanes, selectionByLane, onHover }: ComponentProps<typeof mod.TimelineLanes>) {
      return createElement(
        'div',
        { 'data-timeline-lanes': '' },
        lanes.map(lane => createElement(CountingLane, { key: lane.key, lane, selection: selectionByLane.get(lane.key) ?? null, onHover })),
      );
    }),
  };
});

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

const T0 = Date.parse('2026-10-15T10:00:00Z');
const at = (s: number) => T0 + s * 1000;

/** 夹具：显式给出的字段原样生效，其余取子代理缺省值 */
function agent(over: Partial<SwimAgent>): SwimAgent {
  const span = over.span ?? { start: at(0), end: at(60) };
  const base: SwimAgent = {
    executionId: 'exec', agentName: 'general', agentSessionId: null, isSubagent: true, parentExecutionId: null,
    tokens: 1000, maxSingleCallTokens: 500, toolCallCount: 3, model: 'glm-5.3',
    createdAt: new Date(span.start).toISOString(), latencyMs: span.end - span.start,
    firstPrompt: null, span, activeIntervals: [], member: null,
  };
  return { ...base, ...over };
}

const ROOT = agent({
  executionId: 'root', isSubagent: false, agentName: 'build', span: { start: at(0), end: at(120) },
  member: { taskId: 'ses-a', label: '成员A', isProxy: false },
  activeIntervals: [
    { start: at(0), end: at(30), turnId: 't1' },
    { start: at(30), end: at(31), turnId: 'caveat', hidden: true },
    { start: at(60), end: at(90), turnId: 't2' },
  ],
});
const EXPLORER = agent({
  executionId: 'sub-a', agentSessionId: 'ses-sub-a', agentName: '探索',
  span: { start: at(20), end: at(50) },
  activeIntervals: [{ start: at(20), end: at(35), turnId: 'sa1' }, { start: at(40), end: at(50), turnId: 'sa2' }],
});
const WRITER = agent({
  executionId: 'sub-b', agentSessionId: 'ses-sub-b',
  span: { start: at(95), end: at(110) },
  activeIntervals: [{ start: at(95), end: at(110), turnId: 'sb1' }],
});
const BRIDGES: SwimBridge[] = [
  { bridgeId: 'b1', dispatchContent: 'P1 需求分析', dispatchTimestamp: new Date(at(20)).toISOString(), responseTimestamp: null,
    subagentSessionId: 'ses-sub-a', subagentType: 'explorer', status: 'completed' },
  { bridgeId: 'b2', dispatchContent: 'P1 写报告', dispatchTimestamp: new Date(at(95)).toISOString(), responseTimestamp: null,
    subagentSessionId: 'ses-sub-b', subagentType: 'writer', status: 'completed' },
];
const AGENTS = [ROOT, EXPLORER, WRITER];

function render(props: Partial<ComponentProps<typeof RunTurnsTimeline>> = {}) {
  const onSelectTurn = vi.fn();
  const full: ComponentProps<typeof RunTurnsTimeline> = {
    agents: AGENTS, bridges: BRIDGES, lanes: [], lanesInferred: false,
    selectedTurnId: null, onSelectTurn, ...props,
  };
  const el = createElement(RunTurnsTimeline, full);
  act(() => { root!.render(el); });
  return { onSelectTurn, rerender: (next: Partial<ComponentProps<typeof RunTurnsTimeline>>) => act(() => { root!.render(createElement(RunTurnsTimeline, { ...full, ...next })); }) };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  lanesRenders.count = 0;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    ({ left: 0, top: 0, right: 1000, bottom: 20, width: 1000, height: 20, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (root) act(() => { root!.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

const q = <T extends Element = HTMLElement>(sel: string) => container!.querySelector<T>(sel);
const qa = (sel: string) => [...container!.querySelectorAll<HTMLElement>(sel)];
const laneEl = (key: string) => q(`[data-lane="${key}"]`)!;

/** 在元素上按住 clientX 点下去（轨道 1000px 宽 → x 即千分比 × 1000） */
function clickAt(el: Element, x: number) {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clientX', { value: x });
  Object.defineProperty(ev, 'clientY', { value: 10 });
  act(() => { el.dispatchEvent(ev); });
}
const sec = (s: number) => Math.round((s / 120) * 1000);
/** 本机时区 HH:MM:SS */
const hms = (ms: number) => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'); };
/** `translateX(Npx)` 里的 N */
function tx(el: HTMLElement): number {
  const m = /^translateX\(([-\d.e]+)px\)$/.exec(el.style.transform);
  if (!m) throw new Error(`not a translateX: ${el.style.transform}`);
  return Number(m[1]);
}
/** 行内宽度的 px 数 */
function wd(el: HTMLElement): number {
  const m = /^([\d.e]+)px$/.exec(el.style.width);
  if (!m) throw new Error(`not a px width: ${el.style.width}`);
  return Number(m[1]);
}
function pointerAt(el: Element, type: string, x: number) {
  act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x })); });
}

describe('RunTurnsTimeline — 道与工具条', () => {
  it('渲染 root 道 + 子代理槽道、图例与摘要（执行数 / 子代理数 / 并发）', () => {
    render();
    expect(q('[data-turns-timeline]')).toBeTruthy();
    expect(q('[data-timeline-track]')).toBeTruthy();
    const lanes = qa('[data-lane]');
    expect(lanes.map(l => l.dataset.lane)).toEqual(['root', 'slot-1']);
    expect(q('[data-lane="root"] [data-bar="root"]')).toBeTruthy();
    expect(q('[data-bar="sub-a"]')).toBeTruthy();
    expect(q('[data-bar="sub-b"]')).toBeTruthy();
    expect(q('[data-lane-label="root"]')!.textContent).toBe('root');
    expect(q('[data-timeline-summary]')!.textContent).toBe('3 执行 · 子代理 2 · 最大并发 1');
    expect(qa('[data-legend-item]').map(b => [b.dataset.legendItem, b.getAttribute('aria-pressed'), b.textContent])).toEqual([
      ['explorer', 'true', 'explorer1次'], ['writer', 'true', 'writer1次'],
    ]);
    // 活跃切片：默认 5min 阈值下秒级空档不断开 → 每根条各一片（深色活跃衬在浅色条上）
    expect(qa('[data-bar-piece]')).toHaveLength(3);
    // 无子代理类型时不出现图例行
    render({ agents: [ROOT], bridges: [] });
    expect(q('[data-legend]')).toBeNull();
  });

  it('多成员：root 按成员分道，道名列显示成员名', () => {
    render({
      agents: [
        agent({ ...ROOT, executionId: 'ra', span: { start: at(0), end: at(60) }, activeIntervals: [{ start: at(0), end: at(60), turnId: 't1' }], member: { taskId: 'ses-a', label: '成员A', isProxy: false } }),
        agent({ ...ROOT, executionId: 'rb', span: { start: at(10), end: at(70) }, activeIntervals: [{ start: at(10), end: at(70), turnId: 't9' }], member: { taskId: 'ses-b', label: '成员B', isProxy: false } }),
      ],
      bridges: [],
    });
    expect(qa('[data-lane-label]').map(l => [l.dataset.laneLabel, l.textContent])).toEqual([['ses-a', '成员A'], ['ses-b', '成员B']]);
    expect(qa('[data-lane]').map(l => l.dataset.lane)).toEqual(['ses-a', 'ses-b']);
  });

  it('加载态 / 空态', () => {
    render({ agents: null });
    expect(q('[data-timeline-loading]')).toBeTruthy();
    expect(q('[data-timeline-track]')).toBeNull();
    render({ agents: [] });
    expect(q('[data-timeline-empty]')!.textContent).toBe('暂无执行数据');
  });

  it('折叠：图收起、工具条常驻；再点展开', () => {
    render();
    clickAt(q('[data-timeline-toggle]')!, 0);
    expect(q('[data-timeline-track]')).toBeNull();
    expect(q('[data-timeline-toggle]')!.getAttribute('aria-expanded')).toBe('false');
    clickAt(q('[data-timeline-toggle]')!, 0);
    expect(q('[data-timeline-track]')).toBeTruthy();
  });

  it('缩放：放大一档轨道宽翻倍、读数 2×；点读数复位', () => {
    render();
    const zoom = () => q('[data-zoom-value]')!.textContent;
    expect(zoom()).toBe('1×');
    expect(q('[data-timeline-track]')!.style.width).toBe('100%');
    clickAt(q('button[aria-label="放大"]')!, 0);
    expect(zoom()).toBe('2×');
    expect(q('[data-timeline-track]')!.style.width).toBe('200%');
    clickAt(q('[data-zoom-value]')!, 0);
    expect(zoom()).toBe('1×');
    expect(q('button[aria-label="缩小"]')!.hasAttribute('disabled')).toBe(true);
  });

  it('休眠阈值分段控件：点选切换选中态', () => {
    render();
    expect(q('[data-threshold="5m"]')!.getAttribute('aria-pressed')).toBe('true');
    clickAt(q('[data-threshold="15m"]')!, 0);
    expect(q('[data-threshold="15m"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-threshold="5m"]')!.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('RunTurnsTimeline — ① 单击即跳', () => {
  it('root 道整道可点：点在哪一刻就选中那一刻的轮次；空档取最近一轮；越过末轮取末轮', () => {
    const { onSelectTurn } = render();
    const rootLane = laneEl('root');
    clickAt(rootLane, sec(15));   // t1 [0,30] 内
    expect(onSelectTurn).toHaveBeenLastCalledWith('t1');
    clickAt(rootLane, sec(72));   // t2 [60,90] 内
    expect(onSelectTurn).toHaveBeenLastCalledWith('t2');
    clickAt(rootLane, sec(45));   // 空档：距 t1 终点 15 / 距 t2 起点 15 → 前一轮
    expect(onSelectTurn).toHaveBeenLastCalledWith('t1');
    clickAt(rootLane, sec(52));   // 空档：距 t2 起点 8 → t2
    expect(onSelectTurn).toHaveBeenLastCalledWith('t2');
    clickAt(rootLane, 999);       // 越过末轮
    expect(onSelectTurn).toHaveBeenLastCalledWith('t2');
    expect(onSelectTurn).toHaveBeenCalledTimes(5);
  });

  it('无行轮（命令附注）不作目标：点在它的时刻落到最近的可见轮', () => {
    const { onSelectTurn } = render();
    clickAt(laneEl('root'), sec(30.5));
    expect(onSelectTurn).toHaveBeenLastCalledWith('t1');
  });

  it('槽道只在条上可点：点子代理条 → 该子代理当时的轮；点空槽不动作', () => {
    const { onSelectTurn } = render();
    const slot = laneEl('slot-1');
    clickAt(q('[data-bar="sub-a"]')!, sec(25));
    expect(onSelectTurn).toHaveBeenLastCalledWith('sa1');
    clickAt(q('[data-bar="sub-a"]')!, sec(45));
    expect(onSelectTurn).toHaveBeenLastCalledWith('sa2');
    clickAt(q('[data-bar="sub-b"]')!, sec(100));
    expect(onSelectTurn).toHaveBeenLastCalledWith('sb1');
    // 空槽（60s 处没有任何条子）
    clickAt(slot, sec(60));
    expect(onSelectTurn).toHaveBeenCalledTimes(3);
    // 轴上点击不动作
    clickAt(q('[data-timeline-axis]')!, sec(15));
    expect(onSelectTurn).toHaveBeenCalledTimes(3);
  });

  it('图例过滤后：被隐藏类型的条子不可点，root 不受影响', () => {
    const { onSelectTurn } = render();
    clickAt(q('[data-legend-item="explorer"]')!, 0);
    expect(q('[data-bar="sub-a"]')).toBeNull();
    expect(q('[data-bar="sub-b"]')).toBeTruthy();
    clickAt(laneEl('slot-1'), sec(25));
    expect(onSelectTurn).not.toHaveBeenCalled();
    clickAt(laneEl('root'), sec(15));
    expect(onSelectTurn).toHaveBeenLastCalledWith('t1');
  });
});

describe('RunTurnsTimeline — ② 选中区间跟随与性能契约', () => {
  it('选中层（iOS 风格）：柔光横贯所有道、所属条子上浮起同色胶囊、轴上居中于起点滑一枚实色时刻胶囊；位移走 transform', () => {
    const { rerender } = render({ selectedTurnId: 't2' });
    // 轨道 1000px（getBoundingClientRect 桩）：t2 起点 60s / 120s → 选中条左缘 500px、恒宽 4px；
    // 柔光以选中条为实心核：两侧各渐隐 8px
    const band = q<HTMLElement>('[data-selection-band]')!;
    expect(tx(band)).toBe(492);
    expect(wd(band)).toBe(20);
    // 柔光：横向渐变（两端渐隐）、无描边——只用填充
    expect(band.style.background).toContain('linear-gradient(90deg');
    expect(band.style.boxShadow).toBe('');
    // 选中条只在 root 道（t2 是 root 的轮），位置与柔光同源
    const lit = qa('[data-selected-turn]') as HTMLElement[];
    expect(lit.map(e => e.closest('[data-lane]')!.getAttribute('data-lane'))).toEqual(['root']);
    expect(tx(lit[0]!)).toBe(500);
    expect(wd(lit[0]!)).toBe(4);
    // 整个选中态一个色系：条子本色（root = 蓝）
    expect(['#3b82f6', 'rgb(59, 130, 246)']).toContain(lit[0]!.style.backgroundColor);
    // 时刻胶囊在轴区（吸顶行）：实色本色、白字、宽 64、居中于起点
    const pill = q<HTMLElement>('[data-selection-pill]')!;
    expect(pill.closest('[data-timeline-axis]')).toBeTruthy();
    expect(pill.textContent).toBe(hms(at(60)));
    expect(wd(pill)).toBe(64);
    expect(tx(pill)).toBe(500 - 32);
    expect(pill.style.backgroundColor).toBe(lit[0]!.style.backgroundColor);
    // 选中的是子代理轮：细条滑到槽道里该子代理的条子上，宽度不变（不随轮次时长伸缩）
    rerender({ selectedTurnId: 'sb1' });
    expect(tx(q<HTMLElement>('[data-selection-band]')!)).toBeCloseTo(((95 / 120) * 100) / 100 * 1000 - 8, 6);
    expect(wd(q<HTMLElement>('[data-selection-band]')!)).toBe(20);
    const litSub = qa('[data-selected-turn]') as HTMLElement[];
    expect(litSub.map(e => e.closest('[data-lane]')!.getAttribute('data-lane'))).toEqual(['slot-1']);
    expect(tx(litSub[0]!)).toBeCloseTo(((95 / 120) * 100) / 100 * 1000, 6);
    // 未知轮 / 无选中 → 整个选中层不在场
    rerender({ selectedTurnId: 'nope' });
    expect(q('[data-selection-band]')).toBeNull();
    expect(q('[data-selection-pill]')).toBeNull();
    expect(q('[data-selected-turn]')).toBeNull();
  });

  it('零宽的轮：细条同样落在起点、宽度不变；时刻胶囊贴右界时钳在轴内', () => {
    render({
      selectedTurnId: 't0',
      agents: [agent({ ...ROOT, activeIntervals: [...(ROOT.activeIntervals ?? []), { start: at(119), end: at(119), turnId: 't0' }] })],
      bridges: [],
    });
    const x = ((119 / 120) * 100) / 100 * 1000;
    const band = q<HTMLElement>('[data-selection-band]')!;
    expect(tx(band)).toBeCloseTo(x - 8, 6);
    expect(wd(band)).toBe(20);
    // 渐隐落在选中条之外：实心核的两缘就是选中条的两缘
    expect(band.style.background).toBe(`linear-gradient(90deg, transparent 0, ${tintOf('#3b82f6')} 8px, ${tintOf('#3b82f6')} calc(100% - 8px), transparent 100%)`);
    const lit = qa('[data-selected-turn]') as HTMLElement[];
    expect(lit).toHaveLength(1);
    expect(tx(lit[0]!)).toBeCloseTo(x, 6);
    expect(wd(lit[0]!)).toBe(4);
    // 居中会出右界 → 钳到 1000 − 64
    expect(tx(q<HTMLElement>('[data-selection-pill]')!)).toBe(1000 - 64);
  });

  it('首帧 / 缩放时选中层直接落位：容器带 data-sel-instant（关掉过渡），下一帧才恢复滑动', () => {
    render({ selectedTurnId: 't2' });
    expect(q('[data-timeline-vscroll]')!.hasAttribute('data-sel-instant')).toBe(true);
  });

  it('换选只重渲染「上一选 / 当前选」两道：逐道 memo，其余道一根条子都不动', () => {
    const { rerender, onSelectTurn } = render({ selectedTurnId: 't2' });
    // 首帧：root + slot-1 各渲染一次；随后轨道宽度测出（0 → 1000px），被点亮的
    // root 道拿到像素几何再渲染一次——一次性落位，之后换选不再触发
    expect(lanesRenders.count).toBe(3);
    const settled = lanesRenders.count;
    // t2（root）→ sa1（槽道）：root 道撤销点亮、slot-1 道点亮 = 恰好两道
    rerender({ selectedTurnId: 'sa1' });
    expect(lanesRenders.count).toBe(settled + 2);
    // sa1 → sb1：都在 slot-1 道 → 只有一道
    rerender({ selectedTurnId: 'sb1' });
    expect(lanesRenders.count).toBe(settled + 3);
    // 时间线上点击换选（onSelectTurn 是桩，选中不变）→ 零重渲染
    clickAt(laneEl('root'), sec(15));
    expect(onSelectTurn).toHaveBeenLastCalledWith('t1');
    expect(lanesRenders.count).toBe(settled + 3);
    // 撤销选中：只有当前被点亮的那一道
    rerender({ selectedTurnId: null });
    expect(lanesRenders.count).toBe(settled + 4);
  });

  it('道行子树只在模型变化时整体重渲染（图例过滤、阈值切换、车道表）', () => {
    const { rerender } = render();
    expect(lanesRenders.count).toBe(2);
    clickAt(q('[data-legend-item="writer"]')!, 0);
    expect(lanesRenders.count).toBe(4);
    clickAt(q('[data-threshold="15m"]')!, 0);
    expect(lanesRenders.count).toBe(6);
    rerender({ lanes: ['base'] });
    expect(lanesRenders.count).toBe(8);
  });
});

describe('RunTurnsTimeline — ④ 版面：道多的 run 包', () => {
  it('名列与道同处一个纵向滚动容器，全部道都渲染不截断；轴行吸顶、横向滚动条吸底且只在放大后出现', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      agent({
        executionId: `m${i}`, isSubagent: false, agentName: 'build',
        span: { start: at(i), end: at(60 + i) },
        member: { taskId: `ses-${i}`, label: `成员${i}`, isProxy: false },
        activeIntervals: [{ start: at(i), end: at(60 + i), turnId: `t-${i}` }],
      }),
    );
    render({ agents: many, bridges: [] });
    const v = q('[data-timeline-vscroll]')!;
    expect(qa('[data-lane]')).toHaveLength(30);
    expect(qa('[data-lane-label]')).toHaveLength(30);
    // 末道的名与道都在同一个滚动容器里——纵向翻到哪一屏都成对出现
    expect(v.contains(q('[data-lane-label="ses-29"]'))).toBe(true);
    expect(v.contains(q('[data-lane="ses-29"]'))).toBe(true);
    expect(v.className).toContain('overflow-y-auto');
    // 轴行是容器里的吸顶行（与道同一内容宽度——纵向滚动条出现也不错位）
    const axis = q('[data-timeline-axis]')!;
    expect(v.contains(axis)).toBe(true);
    expect(axis.parentElement!.className).toContain('sticky');
    expect(axis.parentElement!.className).toContain('top-0');
    // 1× 没有横向溢出 → 不出滚动条
    expect(q('[data-timeline-hscroll]')).toBeNull();
    clickAt(q('button[aria-label="放大"]')!, 0);
    const hs = q('[data-timeline-hscroll]')!;
    expect(v.contains(hs)).toBe(true);
    expect(hs.parentElement!.className).toContain('sticky');
    expect(hs.parentElement!.className).toContain('bottom-0');
    // 道区隐藏原生横向条（它在纵向容器里会被滚出视野），由吸底这一条代替
    expect(q('[data-timeline-scroll]')!.className).toContain('[scrollbar-width:none]');
  });

  it('横向滚动位置只有一个来源：拖滚动条滑块 → 写道区 scrollLeft → 轴区镜像、滑块随动', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(1000);
    render();
    clickAt(q('button[aria-label="放大"]')!, 0);
    const lanes = q<HTMLElement>('[data-timeline-scroll]')!;
    const axis = q<HTMLElement>('[data-timeline-axis]')!;
    const thumb = q<HTMLElement>('[data-timeline-hscroll-thumb]')!;
    // 可视 500 / 内容 1000 → 滑块占一半
    expect(thumb.style.width).toBe('50%');
    pointerAt(thumb, 'pointerdown', 0);
    pointerAt(thumb, 'pointermove', 100);
    pointerAt(thumb, 'pointerup', 100);
    // 拖过轨道的 1/5 → 内容走 1/5
    expect(lanes.scrollLeft).toBe(200);
    act(() => { lanes.dispatchEvent(new Event('scroll')); });
    expect(axis.scrollLeft).toBe(200);
    expect(thumb.style.transform).toBe('translateX(100px)');
    expect(q('[data-timeline-hscroll]')!.getAttribute('aria-valuenow')).toBe('40');
  });
});

describe('RunTurnsTimeline — ③ 测距、悬停与图例', () => {
  it('测距是显式模式：开着才量、不抢导航单击；两点出时距、第三点重测、关闭即清', () => {
    const { onSelectTurn } = render();
    const measureBtn = q('[data-timeline-measure]')!;
    expect(measureBtn.getAttribute('aria-pressed')).toBe('false');
    clickAt(measureBtn, 0);
    expect(measureBtn.getAttribute('aria-pressed')).toBe('true');
    clickAt(laneEl('root'), sec(10));
    expect(onSelectTurn).not.toHaveBeenCalled();
    expect(q('[data-measure-readout]')!.textContent).toContain('再点一处');
    clickAt(laneEl('root'), sec(70));
    expect(onSelectTurn).not.toHaveBeenCalled();
    expect(q('[data-measure-readout]')!.textContent).not.toContain('再点一处');
    expect(q('[data-measure-readout]')!.textContent).toMatch(/1\.0min|60s/);
    expect(q('[data-measure]')).toBeTruthy();
    // 第三点重新起测
    clickAt(laneEl('root'), sec(20));
    expect(q('[data-measure-readout]')!.textContent).toContain('再点一处');
    // 关闭测距 → 读数与标记清空，导航恢复
    clickAt(measureBtn, 0);
    expect(q('[data-measure-readout]')).toBeNull();
    expect(q('[data-measure]')).toBeNull();
    clickAt(laneEl('root'), sec(15));
    expect(onSelectTurn).toHaveBeenLastCalledWith('t1');
  });

  it('悬停条子弹浮窗（类型 / 步骤 / 时长），离开即收', () => {
    render();
    const bar = q('[data-bar="sub-a"]')!;
    act(() => { bar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    const tip = q('[data-tooltip]')!;
    expect(tip.textContent).toContain('explorer');
    expect(tip.textContent).toContain('P1 需求分析');
    act(() => { bar.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    expect(q('[data-tooltip]')).toBeNull();
  });

  it('图例：隐藏某类型只收它的条子；显示全部恢复；无隐藏时「隐藏全部」收掉全部子代理', () => {
    render();
    clickAt(q('[data-legend-item="explorer"]')!, 0);
    expect(q('[data-legend-item="explorer"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(q('[data-bar="sub-a"]')).toBeNull();
    expect(q('[data-legend-item="writer"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-bar="sub-b"]')).toBeTruthy();
    expect(q('[data-legend-all]')!.textContent).toBe('显示全部');
    clickAt(q('[data-legend-all]')!, 0);
    expect(q('[data-bar="sub-a"]')).toBeTruthy();
    expect(q('[data-legend-all]')!.textContent).toBe('隐藏全部');
    clickAt(q('[data-legend-all]')!, 0);
    expect(q('[data-bar="sub-a"]')).toBeNull();
    expect(q('[data-bar="sub-b"]')).toBeNull();
    expect(q('[data-bar="root"]')).toBeTruthy();
    expect(qa('[data-lane]').map(l => l.dataset.lane)).toEqual(['root']);
  });
});
