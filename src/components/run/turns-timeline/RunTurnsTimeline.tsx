"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// Run Turns 时间线（压顶导航轨；自 Perf 页执行时间线迁入并重建）。
//
// 一条时间轴把整个 run 的真实时间摊开：root 道（多成员 = 成员各一道）在上、
// 子代理按真实并发落槽在下，深色是活跃、浅色是休眠。它是 Turns 的「地图」：
//   ① 单击即跳——点到哪一刻，就选中那一刻的轮次（root 道整道可点；槽道点
//      条子内任一时刻落到该子代理当时的轮），走既有选中管线（详情归属 →
//      成员懒加载 → 节点自动展开 → 行居中揭示）；
//   ② 选中区间（iOS 风格：只用条子本色的填充，不用描边）——选中轮（列表点击 /
//      ←→ 走查 / 深链 / 搜索命中）的时间窗在所有道上铺一束同色柔光（这一轮期间
//      别的成员在做什么一目了然），它自己的那段活跃条浮起成同色胶囊，轴上居中于
//      起点滑一枚实色时刻胶囊；放大后走出视野自动跟随滚动；
//   ③ 缩放以选中区间为锚——放大/缩小（按钮 / Ctrl+滚轮）后锚点停在原屏幕位置，
//      放大后滚轮横走时间轴；
//   ④ 测距是显式模式（工具条尺子）：开着才量时距，不与导航抢单击。
//
// 版面：一个纵向滚动容器装下「轴行（吸顶）+ 名列与道 + 横向滚动条（吸底，
// 放大后才出现）」——道多的 run 包纵向翻看时轴与滚动条始终在位，名列与道
// 永远同步；轴与道的横向滚动位置只有一个来源（道区容器），轴区镜像它。
//
// 性能契约：道行子树逐道 memo——换选只有「上一选 / 当前选」两道重渲染，其余
// 动的只是覆盖层里的选中层，且只动 transform / width / opacity（见 globals.css
// .turns-sel-slide）；悬停游标线与时刻牌直写 DOM，不触发渲染；刻度
// 只为可视窗口生成（放大 1024× 时整段上有数千个刻度点，全画会卡），横向滚动只
// 重画轴这一层，条子不重渲染；道内不画竖向网格线，时间只看横坐标；时刻 → 轮次是模型里的二分查找，不拉任何数据。

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { ChevronDownIcon, MinusIcon, PlusIcon, RulerIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildAxis, fmtClock, fmtDuration, fmtTokens, type AxisView } from "@/lib/swimlane-axis";
import {
  buildSwimlaneModel,
  pickTurnAt,
  swimBarTop,
  swimLaneHeight,
  type SwimAgent,
  type SwimBar,
  type SwimBridge,
} from "@/lib/swimlane-model";
import { TimelineHScroll, type TimelineHScrollHandle, type TimelineHScrollSource } from "./TimelineHScroll";
import {
  PILL_W,
  SELECTION_BAR_PX,
  beamOf,
  glowOf,
  type SelectionGeometry,
  type SelectionSegment,
} from "./selection-geometry";
import { TimelineLanes, type LaneSelection } from "./TimelineLanes";

const THRESHOLDS = [
  { ms: 60_000, label: "1m" },
  { ms: 300_000, label: "5m" },
  { ms: 900_000, label: "15m" },
  { ms: 1_800_000, label: "30m" },
] as const;
const DEFAULT_THRESHOLD_INDEX = 1;

const MIN_ZOOM = 1;
/** 87h 会话放到 1024×：一屏 ≈ 5min，一像素 ≈ 0.3s——足以逐轮落点 */
const MAX_ZOOM = 1024;
const ZOOM_FACTOR = 2;

const AXIS_H = 20;
const LABEL_W = 96;
/** 整个图区（轴 + 道 + 滚动条）的最大高度：约 12 道一屏，再多纵向翻 */
const MAX_PLOT_H = 288;
/** 选中区间的离视口边缘不足这么多像素即视为「走出视野」 */
const FOLLOW_MARGIN_PX = 48;
/** 测距瞄准时刻牌过了这个百分比改挂光标左侧，免得出右界 */
const CURSOR_FLIP_PCT = 90;

interface MeasurePoint {
  /** 相对整段时长（0–100）——缩放不改变它 */
  pct: number;
  ms: number;
}

/** 选中轮的时间窗（百分比相对整段时长；缩放不改变它） */
interface Selection {
  startPct: number;
  endPct: number;
  startMs: number;
}

export interface RunTurnsTimelineProps {
  /** null = 首次取数在途 */
  agents: SwimAgent[] | null;
  bridges: SwimBridge[];
  /** 声明车道表 */
  lanes: string[];
  lanesInferred: boolean;
  /** 当前选中轮：只驱动选中区间，不进道行子树 */
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  /** 工具条右端插槽（搜索胶囊） */
  children?: ReactNode;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function RunTurnsTimeline({
  agents,
  bridges,
  lanes,
  lanesInferred,
  selectedTurnId,
  onSelectTurn,
  children,
}: RunTurnsTimelineProps) {
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [thresholdIndex, setThresholdIndex] = useState<number>(DEFAULT_THRESHOLD_INDEX);
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(() => new Set());
  const [measuring, setMeasuring] = useState(false);
  const [measure, setMeasure] = useState<{ a: MeasurePoint; b: MeasurePoint | null } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  /** 可视窗口（整段时长的百分比范围）——刻度只为它生成；{0,0} = 尚未测量 */
  const [view, setView] = useState<AxisView>({ fromPct: 0, toPct: 0 });
  const [hover, setHover] = useState<{ bar: SwimBar; x: number; y: number } | null>(null);
  /** 轨道像素宽：选中层的几何全用它换算成 px，位移才能走 transform */
  const [trackW, setTrackW] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesScrollId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const vScrollRef = useRef<HTMLDivElement>(null);
  const axisScrollRef = useRef<HTMLDivElement>(null);
  const hScrollRef = useRef<TimelineHScrollHandle>(null);
  const hoverLineRef = useRef<HTMLDivElement>(null);
  const hoverTimeRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useRef<{ pct: number; offset: number } | null>(null);

  // 回调与状态的只读镜像：事件回调读镜像而非闭包捕获，身份恒定
  const latestOnSelect = useRef(onSelectTurn);
  useEffect(() => { latestOnSelect.current = onSelectTurn; }, [onSelectTurn]);
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  const measuringRef = useRef(measuring);
  useEffect(() => { measuringRef.current = measuring; }, [measuring]);

  const thresholdMs = (THRESHOLDS[thresholdIndex] ?? THRESHOLDS[DEFAULT_THRESHOLD_INDEX]).ms;
  const model = useMemo(
    () => (agents ? buildSwimlaneModel({ agents, bridges, lanes, thresholdMs, hiddenTypes }) : null),
    [agents, bridges, lanes, thresholdMs, hiddenTypes],
  );
  const modelRef = useRef(model);
  useEffect(() => { modelRef.current = model; }, [model]);

  const showPlot = model !== null && model.lanes.length > 0;

  // ── 可视窗口测量：滚动（rAF 节流）与缩放/折叠（提交内同步）两条路 ──
  const measureView = useCallback(() => {
    const el = scrollRef.current;
    const track = trackRef.current;
    if (!el || !track || track.offsetWidth <= 0) return;
    const width = track.offsetWidth;
    const next = { fromPct: (el.scrollLeft / width) * 100, toPct: ((el.scrollLeft + el.clientWidth) / width) * 100 };
    setView(prev => (Math.abs(prev.fromPct - next.fromPct) < 0.01 && Math.abs(prev.toPct - next.toPct) < 0.01 ? prev : next));
  }, []);
  const viewFrame = useRef<number | null>(null);
  const scheduleMeasureView = useCallback(() => {
    if (typeof requestAnimationFrame !== "function") {
      measureView();
      return;
    }
    if (viewFrame.current !== null) return;
    viewFrame.current = requestAnimationFrame(() => {
      viewFrame.current = null;
      measureView();
    });
  }, [measureView]);
  useEffect(() => () => {
    if (viewFrame.current !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(viewFrame.current);
  }, []);
  useLayoutEffect(() => { measureView(); }, [measureView, showPlot, collapsed, zoom]);

  const measureTrack = useCallback(() => {
    const w = trackRef.current?.getBoundingClientRect().width ?? 0;
    setTrackW(prev => (prev === w ? prev : w));
  }, []);
  useLayoutEffect(measureTrack, [measureTrack, showPlot, collapsed, zoom]);
  // 视口变宽窄（窗口缩放 / 侧栏开合）：轨道随之变宽，重测
  useEffect(() => {
    const el = scrollRef.current;
    if (!showPlot || collapsed || !el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      measureTrack();
      scheduleMeasureView();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [showPlot, collapsed, measureTrack, scheduleMeasureView]);
  // 选中层只在「换选」时滑动；缩放 / 轨道变宽窄（首帧布局落定、窗口缩放）是
  // 几何换算变了而不是选了别的轮——直接落位（data-sel-instant 关掉过渡）。标记要
  // 等到「再下一帧」才移除：提交若发生在某帧 rAF 阶段之前，单层 rAF 会在样式计算
  // 前就把标记拿掉，新位置就带着过渡飘过去；嵌套两帧保证至少有一帧以无过渡绘制
  useLayoutEffect(() => {
    const host = vScrollRef.current;
    if (!host) return;
    host.setAttribute("data-sel-instant", "");
    if (typeof requestAnimationFrame !== "function") return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => host.removeAttribute("data-sel-instant"));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      // 标记由本效果独占：换缩放档时先撤，重跑时再加（中间不绘制）
      host.removeAttribute("data-sel-instant");
    };
  }, [showPlot, collapsed, zoom, trackW]);

  // ── 横向滚动位置只有一个来源（道区容器）：轴区与滚动条镜像它 ──
  const syncScroll = useCallback(() => {
    const el = scrollRef.current;
    const axis = axisScrollRef.current;
    if (el && axis && axis.scrollLeft !== el.scrollLeft) axis.scrollLeft = el.scrollLeft;
    hScrollRef.current?.sync();
  }, []);
  const onLanesScroll = useCallback(() => {
    syncScroll();
    scheduleMeasureView();
  }, [syncScroll, scheduleMeasureView]);
  useLayoutEffect(() => { syncScroll(); }, [syncScroll, zoom, showPlot, collapsed]);
  // 自绘滚动条对道区容器的读写口（滚动条自己不持有别人的 ref）
  const hScrollSource: TimelineHScrollSource = {
    id: lanesScrollId,
    read: () => {
      const el = scrollRef.current;
      return el ? { left: el.scrollLeft, view: el.clientWidth, content: el.scrollWidth } : { left: 0, view: 0, content: 0 };
    },
    write: left => {
      const el = scrollRef.current;
      if (el) el.scrollLeft = left;
    },
  };

  const axis = useMemo(
    () => (model && showPlot ? buildAxis(model.startMs, model.totalMs, zoom, view) : null),
    [model, showPlot, zoom, view],
  );

  // ② 选中区间：选中轮的时间窗（被图例滤掉的类型也照常定位，钳在轴内）
  const selection = useMemo<Selection | null>(() => {
    if (!model || selectedTurnId == null) return null;
    const window = model.windowOfTurn.get(selectedTurnId);
    if (!window) return null;
    return {
      startPct: clamp(((window.start - model.startMs) / model.totalMs) * 100, 0, 100),
      endPct: clamp(((window.end - model.startMs) / model.totalMs) * 100, 0, 100),
      startMs: window.start,
    };
  }, [model, selectedTurnId]);
  // 选中轮点亮在哪根条子上：按归属（条子自己的可见轮），不按时间交叠——root
  // 条横贯整段，任何轮都和它「交叠」，但只有它自己的轮才点亮
  const lit = useMemo(() => {
    const byLane = new Map<string, LaneSelection>();
    if (!model || !selection) return { byLane, segment: null as SelectionSegment | null };
    let segment: SelectionSegment | null = null;
    for (const lane of model.lanes) {
      for (const bar of lane.bars) {
        if (!bar.windows.some(w => w.turnId === selectedTurnId)) continue;
        // 恒定宽度的细条，落在所选轮的起点（钳在条盒内）——不随轮次时长伸缩
        byLane.set(lane.key, {
          color: bar.color,
          glow: glowOf(bar.color),
          x: (Math.max(selection.startPct, bar.startPct) / 100) * trackW,
          w: SELECTION_BAR_PX,
          top: swimBarTop(lane.rows, bar.row),
        });
        segment = byLane.get(lane.key) ?? null;
        break;
      }
    }
    return { byLane, segment };
  }, [model, selection, selectedTurnId, trackW]);
  const selectionByLane = lit.byLane;
  // ② 选中层的像素几何（以柔光为主）：恒定宽度的细条——选中条是柔光的实心核，
  // 柔光只向两侧渐隐，两者必然重合；轴上的时刻胶囊居中于所选轮起点、钳在轴内；
  // 色取所属条子的本色，整个选中态只有一个色系
  const sel = useMemo<SelectionGeometry | null>(() => {
    const segment = lit.segment;
    if (!segment || trackW <= 0) return null;
    const beam = beamOf(segment);
    return {
      color: segment.color,
      pillX: clamp(segment.x - PILL_W / 2, 0, Math.max(0, trackW - PILL_W)),
      ...beam,
    };
  }, [lit.segment, trackW]);
  const selectionStartPctRef = useRef<number | null>(null);
  useEffect(() => { selectionStartPctRef.current = selection?.startPct ?? null; }, [selection]);

  // ── 缩放 ──
  const zoomTo = useCallback((next: number, anchorPct: number, anchorOffset: number) => {
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (z === zoomRef.current) return;
    anchorRef.current = { pct: anchorPct, offset: anchorOffset };
    zoomRef.current = z;
    setZoom(z);
  }, []);
  // 渲染后把锚点放回原屏幕位置（同一提交内完成，不闪）
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;
    const el = scrollRef.current;
    const track = trackRef.current;
    if (!el || !track || track.offsetWidth <= 0) return;
    el.scrollLeft = Math.max(0, (anchor.pct / 100) * track.offsetWidth - anchor.offset);
  }, [zoom]);

  /** 步进缩放：锚点 = 视野内的选中区间起点，否则视口中心 */
  const zoomBy = useCallback((factor: number) => {
    const el = scrollRef.current;
    const track = trackRef.current;
    const next = zoomRef.current * factor;
    if (!el || !track || track.offsetWidth <= 0) {
      zoomTo(next, 50, 0);
      return;
    }
    const pct = selectionStartPctRef.current;
    const x = pct == null ? NaN : (pct / 100) * track.offsetWidth;
    if (pct != null && x >= el.scrollLeft && x <= el.scrollLeft + el.clientWidth) {
      zoomTo(next, pct, x - el.scrollLeft);
    } else {
      zoomTo(next, ((el.scrollLeft + el.clientWidth / 2) / track.offsetWidth) * 100, el.clientWidth / 2);
    }
  }, [zoomTo]);

  // 滚轮：Ctrl/⌘ = 以光标为锚缩放；放大后纵轮横走时间轴——但道多到需要纵向
  // 翻时让位原生纵滚（横向走滚动条或 Shift+滚轮）。React 的 onWheel 是 passive
  // 的，preventDefault 须走原生监听
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const track = trackRef.current;
      if (!track || track.offsetWidth <= 0) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = track.getBoundingClientRect();
        const pct = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
        const offset = e.clientX - el.getBoundingClientRect().left;
        zoomTo(zoomRef.current * (e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR), pct, offset);
        return;
      }
      const v = vScrollRef.current;
      const scrollsVertically = v !== null && v.scrollHeight > v.clientHeight + 1;
      if (zoomRef.current > MIN_ZOOM && el.scrollWidth > el.clientWidth && !scrollsVertically) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [showPlot, collapsed, zoomTo]);

  // ② 跟随：选中区间起点走出视野（放大后才会发生）→ 平滑滚到视野中央
  useEffect(() => {
    if (!selection) return;
    const el = scrollRef.current;
    const track = trackRef.current;
    if (!el || !track || track.offsetWidth <= 0 || el.scrollWidth <= el.clientWidth) return;
    const x = (selection.startPct / 100) * track.offsetWidth;
    if (x >= el.scrollLeft + FOLLOW_MARGIN_PX && x <= el.scrollLeft + el.clientWidth - FOLLOW_MARGIN_PX) return;
    const left = Math.max(0, x - el.clientWidth / 2);
    if (typeof el.scrollTo === "function") el.scrollTo({ left, behavior: "smooth" });
    else el.scrollLeft = left;
  }, [selection, showPlot]);

  // ── 交互 ──
  const pctAt = useCallback((clientX: number): number | null => {
    const track = trackRef.current;
    if (!track || !modelRef.current) return null;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
  }, []);

  const addMeasurePoint = useCallback((pct: number) => {
    const m = modelRef.current;
    if (!m) return;
    const point = { pct, ms: m.startMs + (pct / 100) * m.totalMs };
    // 两点已齐，第三点重新起测
    setMeasure(prev => (prev && !prev.b ? { a: prev.a, b: point } : { a: point, b: null }));
  }, []);

  /** ① 单击即跳：落点所在道 → 该道在点击时刻的可见轮 */
  const onTrackClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const m = modelRef.current;
    const pct = pctAt(e.clientX);
    if (!m || pct == null) return;
    if (measuringRef.current) {
      addMeasurePoint(pct);
      return;
    }
    const laneEl = (e.target as HTMLElement).closest<HTMLElement>("[data-lane]");
    const lane = laneEl ? m.lanes.find(l => l.key === laneEl.dataset.lane) : undefined;
    if (!lane) return;
    const t = m.startMs + (pct / 100) * m.totalMs;
    const target = lane.kind === "root"
      ? pickTurnAt(lane.windows, t)
      : (() => {
          const bar = lane.bars.find(b => t >= b.tip.startMs && t <= b.tip.endMs);
          return bar ? pickTurnAt(bar.windows, t) : null;
        })();
    if (target) latestOnSelect.current(target.turnId);
  }, [pctAt, addMeasurePoint]);

  // 测距模式的瞄准线（道区）+ 时刻牌（轴区）：只在测距时出现——普通模式下悬停
  // 只提亮条子弹浮窗，不立线（点击后鼠标停在原地，一根深色线常驻会被当成
  // 「选中」误读）。直写 DOM（mousemove 频率高，不进 React 渲染）
  const onTrackMove = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const m = modelRef.current;
    const pct = pctAt(e.clientX);
    const line = hoverLineRef.current;
    const time = hoverTimeRef.current;
    if (!measuringRef.current) return;
    if (!m || pct == null || !line || !time) return;
    line.style.left = `${pct}%`;
    line.style.opacity = "1";
    time.textContent = fmtClock(m.startMs + (pct / 100) * m.totalMs);
    time.style.left = `${pct}%`;
    time.style.opacity = "1";
    time.style.transform = pct > CURSOR_FLIP_PCT ? "translateX(calc(-100% - 6px))" : "translateX(6px)";
  }, [pctAt]);
  const onTrackLeave = useCallback(() => {
    const line = hoverLineRef.current;
    const time = hoverTimeRef.current;
    if (line) line.style.opacity = "0";
    if (time) time.style.opacity = "0";
  }, []);
  // 关掉测距的瞬间鼠标可能正停在道上：瞄准线随之收起
  useEffect(() => {
    if (measuring) return;
    const line = hoverLineRef.current;
    const time = hoverTimeRef.current;
    if (line) line.style.opacity = "0";
    if (time) time.style.opacity = "0";
  }, [measuring]);

  const onHover = useCallback((bar: SwimBar | null, anchor: DOMRect | null) => {
    setHover(bar && anchor ? { bar, x: anchor.left + anchor.width / 2, y: anchor.bottom } : null);
  }, []);

  const toggleMeasuring = useCallback(() => {
    setMeasuring(prev => !prev);
    setMeasure(null);
  }, []);

  const toggleType = useCallback((key: string) => {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const anyHidden = model ? model.legend.some(item => hiddenTypes.has(item.key)) : false;
  const toggleAllTypes = useCallback(() => {
    setHiddenTypes(prev => (prev.size > 0 ? new Set<string>() : new Set(modelRef.current?.legend.map(item => item.key) ?? [])));
  }, []);

  const tip = hover?.bar.tip;
  // 图分支的前置条件：模型、有道、有轴三者同时成立（上面 showPlot 已含前两条）
  const plot = model && showPlot && axis ? { model, axis } : null;
  const summary = model
    ? `${model.agentCount} 执行 · 子代理 ${model.subagentCount} · 最大并发 ${model.maxConcurrency}${lanesInferred ? " · 车道按内容推断" : ""}`
    : null;

  return (
    <div data-turns-timeline className="@container shrink-0 border-b border-foreground/[0.07]">
      {/* 工具条：折叠钮 · 标题与摘要 · 测距读数 ·（弹性）· 测距/阈值/缩放 · 搜索胶囊 */}
      <div className="flex items-center gap-3 px-4 py-2">
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={collapsed ? "展开时间线" : "收起时间线"}
          aria-expanded={!collapsed}
          data-timeline-toggle
          disabled={!showPlot}
          onClick={() => setCollapsed(prev => !prev)}
        >
          <ChevronDownIcon className={cn("transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]", collapsed && "-rotate-90")} />
        </Button>
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-xs font-medium text-foreground/85">时间线</span>
          {summary && (
            <span data-timeline-summary className="truncate text-[11px] text-muted-foreground tabular-nums">{summary}</span>
          )}
        </div>
        {measure && (
          <div
            data-measure-readout
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-lg bg-muted/70 px-2 text-[11px] tabular-nums text-foreground/80"
          >
            <span>{fmtClock(measure.a.ms)}</span>
            {measure.b ? (
              <>
                <span className="text-muted-foreground">→</span>
                <span>{fmtClock(measure.b.ms)}</span>
                <span className="font-medium text-foreground">{fmtDuration(Math.abs(measure.b.ms - measure.a.ms))}</span>
              </>
            ) : (
              <span className="text-muted-foreground">再点一处</span>
            )}
            <button
              type="button"
              aria-label="清除测距"
              className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => setMeasure(null)}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        )}
        <div className="flex-1" />
        {showPlot && (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant={measuring ? "secondary" : "ghost"}
              size="icon-xs"
              className={cn(!measuring && "text-muted-foreground")}
              aria-label="测距"
              aria-pressed={measuring}
              title={measuring ? "测距中：点两处量时距，再点重测" : "测距：点两处量时距"}
              data-timeline-measure
              onClick={toggleMeasuring}
            >
              <RulerIcon />
            </Button>
            <div className="hidden items-center gap-1.5 @[46rem]:flex" title="休眠阈值：相邻轮间隔超过它即断开成新的活跃段">
              <span className="text-[11px] text-muted-foreground">阈值</span>
              <div role="group" aria-label="休眠阈值" className="flex rounded-lg bg-muted/60 p-0.5">
                {THRESHOLDS.map((item, i) => (
                  <button
                    key={item.ms}
                    type="button"
                    data-threshold={item.label}
                    aria-pressed={i === thresholdIndex}
                    className={cn(
                      "h-5 cursor-pointer rounded-md px-1.5 text-[11px] tabular-nums transition-colors",
                      i === thresholdIndex
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setThresholdIndex(i)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-0.5" role="group" aria-label="缩放">
              <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="缩小" disabled={zoom <= MIN_ZOOM} onClick={() => zoomBy(1 / ZOOM_FACTOR)}>
                <MinusIcon />
              </Button>
              <button
                type="button"
                data-zoom-value
                title={zoom > MIN_ZOOM ? "复位缩放" : "缩放（Ctrl + 滚轮）"}
                className={cn(
                  "h-6 min-w-10 cursor-pointer rounded-md px-1 text-[11px] font-medium tabular-nums transition-colors",
                  zoom > MIN_ZOOM ? "text-primary hover:bg-primary/10" : "text-foreground/75 hover:bg-muted/60",
                )}
                onClick={() => setZoom(MIN_ZOOM)}
              >
                {zoom}×
              </button>
              <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="放大" disabled={zoom >= MAX_ZOOM} onClick={() => zoomBy(ZOOM_FACTOR)}>
                <PlusIcon />
              </Button>
            </div>
          </div>
        )}
        {children}
      </div>
      {collapsed ? null : !plot ? (
        model === null ? (
          <div className="px-4 pb-3">
            <div className="h-5 animate-pulse rounded-md bg-foreground/[0.06]" data-timeline-loading />
          </div>
        ) : (
          <p data-timeline-empty className="px-4 pb-2.5 text-xs text-muted-foreground">暂无执行数据</p>
        )
      ) : (
        <div className="flex flex-col">
          <div
            ref={vScrollRef}
            data-timeline-vscroll
            className="relative overflow-y-auto overscroll-y-contain"
            style={{ maxHeight: MAX_PLOT_H }}
          >
            {/* 轴行：吸顶——道多纵向翻看时刻度始终在顶部；横向位置镜像道区 */}
            <div className="sticky top-0 z-[8] flex border-b border-foreground/[0.07] bg-background" style={{ height: AXIS_H }}>
              <div className="shrink-0 border-r border-foreground/[0.07]" style={{ width: LABEL_W }} />
              <div ref={axisScrollRef} data-timeline-axis className="relative min-w-0 flex-1 overflow-hidden">
                <div className="relative h-full" style={{ width: `${zoom * 100}%`, minWidth: "100%" }}>
                  {plot.axis.ticks.map(t => (
                    <span
                      key={t.pct}
                      data-axis-tick
                      className={cn(
                        "absolute top-0.5 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground",
                        t.align === "center" && "-translate-x-1/2",
                        t.align === "end" && "-translate-x-full",
                      )}
                      style={{ left: `${t.pct}%` }}
                    >
                      {t.label}
                    </span>
                  ))}
                  {plot.axis.edgeStart && (
                    <span className="absolute left-0 top-0.5 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">{axis!.edgeStart}</span>
                  )}
                  {plot.axis.edgeEnd && (
                    <span className="absolute right-0 top-0.5 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">{axis!.edgeEnd}</span>
                  )}
                  {/* 选中区间的时刻胶囊：实色（条子本色）白字，居中于区间起点、钳在轴内 */}
                  {sel && (
                    <span
                      data-selection-pill
                      className="turns-sel-slide turns-sel-pop pointer-events-none absolute top-0.5 flex h-[18px] items-center justify-center rounded-full text-[11px] font-semibold tabular-nums text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.25)]"
                      style={{ left: 0, width: PILL_W, transform: `translateX(${sel.pillX}px)`, backgroundColor: sel.color }}
                    >
                      {fmtClock(selection!.startMs)}
                    </span>
                  )}
                  {/* 测距瞄准时刻牌：直写 DOM */}
                  <span
                    ref={hoverTimeRef}
                    data-measure-cursor-time
                    aria-hidden
                    className="pointer-events-none absolute top-px whitespace-nowrap rounded-full bg-foreground px-1.5 text-[10px] font-medium leading-4 text-background tabular-nums opacity-0"
                    style={{ left: 0 }}
                  />
                </div>
              </div>
            </div>

            {/* 名列 + 道：并排在同一个纵向滚动容器里，同步不靠计算 */}
            <div className="flex">
              {/* 道名列：不随时间轴横滚 */}
              <div className="shrink-0 border-r border-foreground/[0.07]" style={{ width: LABEL_W }}>
                {plot.model.lanes.map(lane => (
                  <div
                    key={lane.key}
                    data-lane-label={lane.key}
                    className="flex items-center gap-1.5 border-b border-foreground/[0.06] px-2 last:border-b-0"
                    style={{ height: swimLaneHeight(lane.rows) }}
                    title={lane.label}
                  >
                    <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: lane.color }} aria-hidden />
                    <span className={cn("truncate text-[11px]", lane.kind === "root" ? "font-medium text-foreground/80" : "text-muted-foreground")}>
                      {lane.label}
                    </span>
                  </div>
                ))}
              </div>
              <div
                ref={scrollRef}
                id={lanesScrollId}
                data-timeline-scroll
                className={cn(
                  "relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                  measuring && "cursor-crosshair",
                )}
                onScroll={onLanesScroll}
              >
                <div
                  ref={trackRef}
                  data-timeline-track
                  className="relative select-none overflow-x-clip"
                  style={{ width: `${zoom * 100}%`, minWidth: "100%" }}
                  onClick={onTrackClick}
                  onMouseMove={onTrackMove}
                  onMouseLeave={onTrackLeave}
                >
                  {/* 道（逐道 memo 子树；选中轮自己的那段在这里点亮） */}
                  <TimelineLanes lanes={plot.model.lanes} selectionByLane={selectionByLane} onHover={onHover} />

                  {/* 覆盖层：均不接事件 */}
                  {/* 选中柔光（为主）：横贯所有道的恒定细条，实心核 = 选中条、两侧渐隐、
                      无描边——所指的那一刻别的成员在做什么一目了然 */}
                  {sel && (
                    <div
                      data-selection-band
                      aria-hidden
                      className="turns-sel-slide turns-sel-pop pointer-events-none absolute bottom-0 z-[3] rounded-full"
                      style={{ top: 0, left: 0, width: sel.w, transform: `translateX(${sel.x}px)`, background: sel.background }}
                    />
                  )}
                  {measure && (
                    <div data-measure className="pointer-events-none absolute bottom-0 z-[4]" style={{ top: 0, left: 0, right: 0 }}>
                      <span className="absolute inset-y-0 w-px bg-foreground" style={{ left: `${measure.a.pct}%` }} />
                      {measure.b && (
                        <>
                          <span
                            className="absolute inset-y-0 bg-foreground/[0.12]"
                            style={{ left: `${Math.min(measure.a.pct, measure.b.pct)}%`, width: `${Math.abs(measure.b.pct - measure.a.pct)}%` }}
                          />
                          <span className="absolute inset-y-0 w-px bg-foreground" style={{ left: `${measure.b.pct}%` }} />
                        </>
                      )}
                    </div>
                  )}
                  <div
                    ref={hoverLineRef}
                    aria-hidden
                    data-measure-cursor
                    className="pointer-events-none absolute bottom-0 z-[6] w-px bg-foreground/50 opacity-0"
                    style={{ top: 0, left: 0 }}
                  />
                </div>
              </div>
            </div>

            {/* 横向滚动条：吸底，放大后才出现——纵向翻到哪一屏它都在 */}
            {zoom > MIN_ZOOM && (
              <div className="sticky bottom-0 z-[8] flex bg-background py-1.5">
                <div className="shrink-0" style={{ width: LABEL_W }} />
                <TimelineHScroll ref={hScrollRef} source={hScrollSource} />
              </div>
            )}
          </div>

          {/* 图例 = 子代理类型过滤（无子代理时整行不出现） */}
          {plot.model.legend.length > 0 && (
            <div data-legend className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-foreground/[0.06] px-4 py-1.5">
              {plot.model.legend.map(item => {
                const on = !hiddenTypes.has(item.key);
                return (
                  <button
                    key={item.key}
                    type="button"
                    data-legend-item={item.key}
                    aria-pressed={on}
                    title={on ? "点击隐藏该类型" : "点击显示该类型"}
                    className={cn(
                      "flex h-5 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors hover:bg-muted/60",
                      on ? "text-foreground/85" : "text-muted-foreground/70",
                    )}
                    onClick={() => toggleType(item.key)}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full ring-1 ring-foreground/15 transition-colors"
                      style={{ backgroundColor: on ? item.color : "transparent" }}
                      aria-hidden
                    />
                    <span className="max-w-[160px] truncate">{item.key}</span>
                    <span className="tabular-nums text-muted-foreground">{item.count}次</span>
                  </button>
                );
              })}
              <span className="mx-1 h-3 w-px bg-foreground/[0.1]" aria-hidden />
              <button
                type="button"
                data-legend-all
                className="h-5 cursor-pointer rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                onClick={toggleAllTypes}
              >
                {anyHidden ? "显示全部" : "隐藏全部"}
              </button>
            </div>
          )}
        </div>
      )}


      {/* 悬停浮窗：挂在条子下方（时间线压顶，上方是应用头，朝上会被裁） */}
      {hover && tip && (
        <div
          data-tooltip
          className="pointer-events-none fixed z-[9999] max-w-[340px] rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
          style={{ left: hover.x, top: hover.y + 8, transform: "translateX(-50%)" }}
        >
          <div className="mb-1 font-medium">
            {tip.label}
            {tip.failed && <span className="ml-1.5 text-destructive">失败</span>}
          </div>
          {tip.step && <div className="mb-1 line-clamp-2 text-muted-foreground">{tip.step}</div>}
          {tip.dispatchCount > 1 && <div className="mb-1 text-muted-foreground">{tip.dispatchCount} 次派发（首发 + 返工重入）</div>}
          {tip.firstPrompt && <div className="mb-1 line-clamp-2 text-muted-foreground">{tip.firstPrompt}</div>}
          <div className="tabular-nums">{fmtDuration(tip.endMs - tip.startMs)} · {fmtClock(tip.startMs)} → {fmtClock(tip.endMs)}</div>
          <div className="tabular-nums text-muted-foreground">
            {fmtTokens(tip.maxSingleCallTokens)} token max · {fmtTokens(tip.tokens)} total · {tip.toolCallCount} tools{tip.model ? ` · ${tip.model}` : ""}
          </div>
        </div>
      )}
    </div>
  );
}
