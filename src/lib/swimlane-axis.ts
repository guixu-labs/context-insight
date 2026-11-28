// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 泳道时间轴（纯函数）：刻度与时刻文案。轴的规则只在这里——组件只摆位置。
//
// 刻度对齐本地午夜网格：87h 会话若从起点直接累加，间隔（如 15h）会把标签打到
// 08:38/02:38 这类怪时刻；对齐后标签永远落在整点/半天/整天上。
// 日期可见性：首个刻度与跨日后的首个刻度带 MM-DD（小时级刻度只看 HH:MM
// 不知道是哪天），≥12h 大间隔刻度维持整排带日期。
// 刻度只为可视窗口生成（buildAxis 的 view）：放大后整段上有上千个刻度点，窗口外的看不见。

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_TICKS = 6;
/** 下限：窗口里不足 3 格（62min 的窗口配 1h 步长只剩一根刻度）就降一档 */
const MIN_TICKS = 3;

const TICK_CANDIDATES = [1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
  HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];

/** 一个视窗（= 轴宽）里最多 6 格：按可视时长挑「整」间隔 */
export function computeTickInterval(visibleMs: number): number {
  const candidates = TICK_CANDIDATES;
  for (const c of candidates) {
    if (visibleMs / c <= MAX_TICKS) return c;
  }
  return Math.max(1, Math.ceil(visibleMs / MAX_TICKS / DAY)) * DAY;
}

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function fmtHourMinute(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtAxisLabel(ms: number, intervalMs: number, withDate = false): string {
  const hm = fmtHourMinute(ms);
  if (intervalMs >= 12 * HOUR || withDate) {
    const d = new Date(ms);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
  }
  if (intervalMs >= 60_000) return hm;
  const d = new Date(ms);
  return `${hm}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export interface AxisTick {
  /** 刻度在整段时长里的百分比位置（0–100） */
  pct: number;
  label: string;
  /** 标签对齐：贴轨道首端左对齐 / 贴末端右对齐（居中会被裁掉半截），其余居中 */
  align: "start" | "center" | "end";
}

export interface AxisView {
  /** 可视窗口在整段时长里的百分比范围；to ≤ from = 尚未测量，按首屏算 */
  fromPct: number;
  toPct: number;
}

/** 网格刻度（仅可视窗口内）+ 两端会话起止边界。
 *  网格刻度只落整点（首格 18:00 前的 17:3x、末格 20:00 后的尾巴从不显示），
 *  所以两端另给真实起止 HH:MM；与近邻网格刻度太近（<6% 轴宽）时去重防叠字。
 *  只为可视窗口生成刻度：放大后整段时长上可能有上千个刻度点，全画出来就是
 *  上千个节点——窗口外的刻度反正看不见 */
export function buildAxis(startMs: number, totalMs: number, zoom: number, view?: AxisView): {
  ticks: AxisTick[];
  edgeStart: string | null;
  edgeEnd: string | null;
} {
  const visibleMs = totalMs / Math.max(1, zoom);
  let interval = computeTickInterval(visibleMs);
  // 上限之外还有下限：只看上限时 62min 的窗口会选 1h、整屏一根刻度——不足 3 格
  // 就降一档（密到 6–8 格也比一根线强；候选表之外的时长不受影响）
  for (let i = TICK_CANDIDATES.indexOf(interval) - 1; i >= 0 && visibleMs / interval < MIN_TICKS; i--) {
    interval = TICK_CANDIDATES[i]!;
  }
  const d0 = new Date(startMs);
  const midnight = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime();
  const gridAfter = (t: number) => midnight + Math.ceil(Math.max(0, t - midnight) / interval) * interval;
  const gridAtOrBefore = (t: number) => midnight + Math.floor(Math.max(0, t - midnight) / interval) * interval;
  const endMs = startMs + totalMs;
  const firstPct = ((gridAfter(startMs) - startMs) / totalMs) * 100;
  const lastPct = ((gridAtOrBefore(endMs) - startMs) / totalMs) * 100;
  // 窗口：已测量 = 当前可视范围外扩一格（滚到边上时不露白）；未测量 = 首屏
  const measured = view != null && view.toPct > view.fromPct;
  const fromPct = measured ? view.fromPct : 0;
  const toPct = measured ? view.toPct : 100 / Math.max(1, zoom);
  const from = Math.max(startMs, startMs + (fromPct / 100) * totalMs - interval);
  const to = Math.min(endMs, startMs + (toPct / 100) * totalMs + interval);
  const ticks: AxisTick[] = [];
  // 轴首刻度恒带日期（单日会话也要知道是哪天）；窗口内的刻度跨日才带
  let prevDay = fromPct <= 0 ? -1 : new Date(from).getDate();
  // 步数上限护栏：窗口最多一屏 + 两格，正常到不了；防脏数据（totalMs 异常）死循环
  for (let t = gridAfter(from), guard = 0; t <= to && guard < 64; t += interval, guard++) {
    const day = new Date(t).getDate();
    ticks.push({ pct: ((t - startMs) / totalMs) * 100, label: fmtAxisLabel(t, interval, day !== prevDay), align: "center" });
    prevDay = day;
  }
  // 标签防裁切：离轨道两端不足半个标签宽的刻度改贴边对齐（10px 字号数字
  // 约 6px 一字符，时间线轨道 ≈ 1000px → 0.6%/字符，留两成余量取 0.75）。
  // 只看轨道两端、不看可视窗口——放大后窗口可以落在整段的任意位置，那里的
  // 刻度照常居中
  const firstTick = ticks[0];
  const lastTick = ticks[ticks.length - 1];
  if (firstTick && firstTick.pct < firstTick.label.length * 0.75) firstTick.align = "start";
  if (lastTick && lastTick.pct > 100 - lastTick.label.length * 0.75) lastTick.align = "end";
  return {
    ticks,
    edgeStart: firstPct > 6 ? fmtHourMinute(startMs) : null,
    edgeEnd: lastPct < 94 ? fmtHourMinute(endMs) : null,
  };
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < HOUR) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / HOUR).toFixed(2)}h`;
}

export function fmtTokens(n: number): string {
  if (n === 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}
