// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// RunTabBar IT（凹槽分段导航）：锁——①药丸按钮渲染表（12 tab 含 Wire 轮次
// 中文标签）；②凹槽轨道（浅灰 rounded-full 轨道）+ 活跃态卡舌样式
// （text-foreground）+ 浮起卡舌指示器（bg-card，transform/width 过渡族）
// + 图标彩色常驻（非活跃压暗）；③点击切换回调（点活跃自身不触发）；
// ④无 ARIA tab 角色的工作台契约（普通 button，页面级 IT 亦锁）；
// ⑤高级门：默认可见表不含 wire/replay；⑥轨道按内容收束、居中由页头承担
// （左右两翼等权）；⑦pending：页面
// 加载态以真身作骨架——同一渲染表、按钮全禁用、点击不导航、对辅助技术隐藏；
// ⑧滚动 / 可用宽度变化逐次重定位（rAF 节流逐帧放行、观测外层可用宽度）。
// 注：happy-dom 无布局引擎（offsetLeft/offsetWidth 恒 0），指示器的量测
// 定位数值与横滚裁切不可测——属浏览器视觉行为，由 e2e 与线上人工验证。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RunTabBar, RUN_TABS, RUN_TABS_DEFAULT_VISIBLE } from '@/components/run/RunTabBar';
import type { RunTabKey } from '@/app/run/[runId]/run-view';

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function renderBar(
  active: RunTabKey,
  onSelect: (key: RunTabKey) => void = () => {},
  extra: { pending?: boolean } = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(RunTabBar, { tabs: RUN_TABS, active, onSelect, ...extra }));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function barButtons(container: Element): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

describe('RunTabBar（凹槽分段导航）', () => {
  it('渲染表完整：11 药丸按钮（含 Wire 轮次标签，Trace 已退役并入 Turns），无 ARIA tab 角色（工作台契约）', async () => {
    const container = await renderBar('overview');
    const btns = barButtons(container);
    expect(btns.length).toBe(11);
    expect(btns.map(b => b.textContent)).toContain('Wire 轮次');
    expect(btns.map(b => b.textContent)).not.toContain('Trace');
    expect(container.querySelectorAll('[role="tab"]').length).toBe(0);
    expect(container.querySelector('[data-run-tabbar]')).toBeTruthy();
  });

  it('活跃态卡舌样式 + 浮起卡舌指示器 + 凹槽轨道 + 图标彩色常驻（非活跃压暗）', async () => {
    const container = await renderBar('context');
    const btns = barButtons(container);
    const activeBtn = btns.find(b => b.textContent === 'Context')!;
    const inactiveBtn = btns.find(b => b.textContent === 'Graph')!;
    expect(activeBtn.className).toContain('text-foreground');
    expect(activeBtn.className).not.toContain('text-muted-foreground');
    expect(inactiveBtn.className).toContain('text-muted-foreground');
    // 凹槽轨道：浅灰 rounded-full 轨道 + p-1 内衬 + 居中收束（w-fit）
    const groove = container.querySelector('[data-run-tabbar] > div') as HTMLElement;
    expect(groove.className).toContain('bg-foreground/[0.04]');
    expect(groove.className).toContain('rounded-full');
    expect(groove.className).toContain('w-fit');
    // 指示器：浮起卡舌（bg-card），aria-hidden 装饰层，过渡族覆盖 transform 与 width
    const indicator = container.querySelector('[data-run-tabbar] > div > div[aria-hidden]') as HTMLElement | null;
    expect(indicator).toBeTruthy();
    expect(indicator!.className).toContain('bg-card');
    expect(indicator!.className).toContain('transition-[transform,width]');
    expect(indicator!.className).toContain('rounded-full');
    // 图标彩色常驻：活跃点亮全彩、非活跃压暗
    const activeIcon = activeBtn.querySelector('svg');
    const inactiveIcon = inactiveBtn.querySelector('svg');
    expect(activeIcon!.getAttribute('class')).toContain('opacity-100');
    expect(inactiveIcon!.getAttribute('class')).toContain('opacity-55');
  });

  it('点击切换：回调携带目标键；点活跃自身不触发', async () => {
    const onSelect = vi.fn();
    const container = await renderBar('overview', onSelect);
    const btns = barButtons(container);
    await act(async () => { btns.find(b => b.textContent === 'Perf')!.click() });
    expect(onSelect).toHaveBeenCalledWith('perf');
    await act(async () => { btns.find(b => b.textContent === 'Overview')!.click() });
    expect(onSelect).toHaveBeenCalledWith('perf'); // 仍是首次调用——点活跃自身无效
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('高级门：默认可见表不含 wire/replay，全量表含 11 项（trace 退役出表）', () => {
    const defaultKeys = RUN_TABS_DEFAULT_VISIBLE.map(t => t.key);
    expect(defaultKeys).not.toContain('wire');
    expect(defaultKeys).not.toContain('replay');
    expect(defaultKeys).not.toContain('trace');
    expect(defaultKeys.length).toBe(9);
    expect(RUN_TABS.length).toBe(11);
  });

  it('轨道按内容收束、自身不负责居中（无 mx-auto）：居中由页头的左右等权两翼承担——右翼 chip / 动作增减不牵动 tab 条位置', async () => {
    const container = await renderBar('overview');
    const groove = container.querySelector('[data-run-tabbar] > div') as HTMLElement;
    expect(groove.className).toContain('w-fit');
    expect(groove.className).not.toContain('mx-auto');
  });

  it('pending：同一渲染表全禁用、点击不导航、对辅助技术隐藏；非 pending 无残留', async () => {
    const onSelect = vi.fn();
    const pending = await renderBar('turns', onSelect, { pending: true });
    const bar = pending.querySelector('[data-run-tabbar]') as HTMLElement;
    expect(bar.getAttribute('data-pending')).toBe('true');
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    const btns = barButtons(pending);
    expect(btns.length).toBe(11);
    expect(btns.every(b => b.disabled)).toBe(true);
    await act(async () => { btns.find(b => b.textContent === 'Perf')!.click() });
    expect(onSelect).not.toHaveBeenCalled();

    const ready = await renderBar('turns', onSelect);
    const readyBar = ready.querySelector('[data-run-tabbar]') as HTMLElement;
    expect(readyBar.hasAttribute('data-pending')).toBe(false);
    expect(readyBar.hasAttribute('aria-hidden')).toBe(false);
    expect(barButtons(ready).every(b => !b.disabled)).toBe(true);
    await act(async () => { barButtons(ready).find(b => b.textContent === 'Perf')!.click() });
    expect(onSelect).toHaveBeenCalledWith('perf');
  });

  it('滚动 / 可用宽度变化 → 每次都重定位（rAF 节流逐帧放行；观测外层可用宽度）', async () => {
    // 回归锁：节流旗标请求下一帧后不复位 = 首帧之后的重算全被吞掉（页面
    // 加载态 tab 条被占位挤窄挂上右缘渐隐，数据到达变宽后渐隐残留）
    const roCallbacks: Array<() => void> = [];
    const observed: Element[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { roCallbacks.push(cb); }
      observe(el: Element) { observed.push(el); }
      disconnect() {}
      unobserve() {}
    });
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    try {
      const container = await renderBar('overview');
      const root = container.querySelector('[data-run-tabbar]') as HTMLElement;
      const track = root.firstElementChild as HTMLElement;
      // 观测对象：外层（可用宽度）+ 轨道——轨道按内容收束，「从放不下到放得下」
      // 时变宽的是轨道，可用空间变化时变宽的是外层
      expect(observed).toContain(root);
      expect(observed).toContain(track);
      // happy-dom 无布局：几何量由测试给（活跃 tab 在最左，scrollLeft > 0 即不在
      // 视野）；写入忽略——挂载首算触发的 happy-dom 平滑滚动会延迟回写 scrollLeft
      const metrics: Record<string, number> = { scrollLeft: 120, clientWidth: 600, scrollWidth: 752 };
      for (const key of Object.keys(metrics)) {
        Object.defineProperty(track, key, { configurable: true, get: () => metrics[key], set: () => {} });
      }
      const scrollTo = vi.fn();
      track.scrollTo = scrollTo;
      const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 5)); }); };
      const repositions = async (fire: () => void) => {
        const before = scrollTo.mock.calls.length;
        await act(async () => { fire(); });
        await settle();
        return scrollTo.mock.calls.length - before;
      };
      expect(await repositions(() => {})).toBe(0);
      // ① 滚动事件 → 重定位（活跃 tab 滚回视野）
      expect(await repositions(() => { track.dispatchEvent(new Event('scroll')); })).toBe(1);
      // ② 第二次事件仍然生效（旗标已复位）
      expect(await repositions(() => { track.dispatchEvent(new Event('scroll')); })).toBe(1);
      // ③ 同帧多次事件只重定位一次（节流）
      expect(await repositions(() => {
        track.dispatchEvent(new Event('scroll'));
        track.dispatchEvent(new Event('scroll'));
        track.dispatchEvent(new Event('scroll'));
      })).toBe(1);
      // ④ 外层可用宽度变化（ResizeObserver 回调）同样触发
      expect(await repositions(() => { roCallbacks.forEach(cb => cb()); })).toBeGreaterThanOrEqual(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
