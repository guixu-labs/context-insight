"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Turns tab（design: run 级 Turns 变革——Run Player 架构；搜索驻留 =
// Trace 退役后的跨成员搜索归位）。
// 三层：① 时间线（顶部，RunTurnsTimeline）= 真实时间轴上的 root 道 + 子代理
// 槽位——单击任一时刻即选中该刻的轮次（时刻 → 轮次在模型里二分解析，不取
// 数），播放头跟随选中轮；搜索胶囊与工具条同住一行（跨成员搜索 / #数字直达，
// 命中索引驻留左列）；② 节点列表（左列）= 代分组 → 节点实例（成员会话懒加载，subagent
// 泳道嵌套照旧），搜索驻留期间让位为命中索引；③ Turn Player（右列）=
// 传输条 + 本会话胶片轨 + 三联指标 + 叙事舞台（TurnDetail，携带搜索高亮）。
// 选中轮的节点归属由 turn 详情的 taskId 单点解析（深链/跨 tab 同路）；
// ←/→ 沿「节点 × 成员会话 × 轮次」全序列连续走查，越过节点边界自动加载。

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRunDataEpoch } from "@/lib/run/data-epoch";
import { MessageSquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { TurnDetail, type TurnDetailData } from "@/components/observe/TurnDetail";
import { TurnDetailSkeleton } from "@/components/observe/TurnDetailSkeleton";
import type { FilmstripTurn } from "@/components/observe/TurnFilmstrip";
import { RunTurnsNodes, type TurnsNode, type TurnsNodeSession, type MemberTurnsState, type TurnsBlockTurn } from "@/components/run/RunTurnsNodes";
import { RunTurnsRoleFilter, deriveRoleOptions, toggleRoleFilter } from "@/components/run/RunTurnsRoleFilter";
import { TurnSearchField, TurnHitsPanel, useTurnsHitsFilter, type TurnsSearchState, type TurnJumpOutcome, type TurnJumpMatch } from "@/components/run/RunTurnsSearch";
import type { TurnHighlight } from "@/lib/shared/highlight";
import type { TurnSearchItem } from "@/lib/observe/collectors/search";
import { parseTurnsQuery } from "@/lib/observe/collectors/turns-query";
import type { NodeInstance, RunViewModel } from "@/lib/run/view-model";
import { RunTurnsTimeline } from "@/components/run/turns-timeline/RunTurnsTimeline";
import { useRunTimeline } from "@/components/run/turns-timeline/use-run-timeline";
import type { SessionRef } from "@/lib/run/model";

/** 首页页容量：小页快出首屏（快路径），剩余走补拉链 */
const PAGE_SIZE = 200;
/** 补拉单请求上限：分块预算而非服务端硬顶（MAX_PAGE_SIZE=20000）——大
 *  session 单请求巨石拉回（数 MB JSON 一次解析 + 一次挂载）是加载期整页
 *  冻结的主源；小块续拉让解析/渲染成本摊平，装载门期间列表不在场，块间
 *  只有头部计数轻渲。链护栏覆盖单成员上限 */
const REST_PAGE_SIZE = 1_000;
/** 补拉链护栏：200 + 32×1000 轮的跑飞上限（真实单成员到不了） */
const REST_CHAIN_LIMIT = 32;

/** 详情骨架出场延迟：点击选轮的取数快于该值时不出骨架（保留旧内容直到
 *  新内容落地），超过才让位给骨架——快取数不闪、慢取数有信号 */
const DETAIL_SKELETON_DELAY_MS = 180;

/** 揭示滚动（原语）：离屏会话块按 content-visibility 占位（600px）参与
 *  布局，远距跳转若按占位几何滚动，落地后真实布局展开行会偏移出视野——
 *  先给列表挂揭示类把占位块临时展平为真实布局，读一次几何强制同步，再
 *  平滑居中；滚动收尾（scrollend / 兜底计时）后摘除揭示类恢复跳渲染
 *  （contain-intrinsic-size:auto 已记住真实尺寸，恢复不引起跳动） */
function revealIntoView(list: HTMLDivElement | null, el: Element) {
  if (!list) return;
  list.classList.add("turn-list-revealing");
  void list.scrollHeight;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const settle = () => {
    list.classList.remove("turn-list-revealing");
    list.removeEventListener("scrollend", settle);
    if (timer != null) clearTimeout(timer);
  };
  const timer = setTimeout(settle, 800);
  list.addEventListener("scrollend", settle);
}

export interface RunTurnsTabProps {
  runId: string;
  viewModel: RunViewModel;
  turnId: string | null;
  onSelectTurn: (turnId: string | null) => void;
  /** Turns 搜索预填深链（Perf 工具耗时卡等入口的搜索语法直达）：非 null 且
   *  未消费过时执行一次搜索并驻留命中索引（搜索胶囊输入框随驻留关键词自动
   *  回显）；同值不重放，换值重放（连续下钻） */
  searchQuery?: string | null;
}

// viewModel → 节点序列（主图按 代→rank 排序；子图节点递归挂生成器后）
function buildNodes(vm: RunViewModel): TurnsNode[] {
  const main = vm.views[0];
  if (!main) return [];
  const subViewsByParent = new Map<string, typeof vm.views>();
  for (const v of vm.views.slice(1)) {
    if (!v.parentKey) continue;
    const arr = subViewsByParent.get(v.parentKey) ?? [];
    arr.push(v);
    subViewsByParent.set(v.parentKey, arr);
  }
  const toSession = (ref: SessionRef | null, role: "execute" | "verify", ordinal: number): TurnsNodeSession | null =>
    ref ? { taskId: ref.taskId, label: ref.label, role, attemptOrdinal: ordinal, ref } : null;

  const build = (view: RunViewModel["views"][number], depth: number): TurnsNode[] => {
    const nodes = view.nodeKeys
      .map(k => vm.nodes.find(n => n.key === k))
      .filter((n): n is NodeInstance => n != null)
      .sort((a, b) => a.generation - b.generation || (view.ranks[a.key] ?? 0) - (view.ranks[b.key] ?? 0));
    const out: TurnsNode[] = [];
    for (const n of nodes) {
      const attempts = n.attempts.map(a => ({
        ordinal: a.ordinal,
        status: a.status,
        verification: a.verification,
        outputText: a.outputText,
        execute: toSession(a.executeMember.session ?? null, "execute", a.ordinal),
        verify: toSession(a.verifyMember?.session ?? null, "verify", a.ordinal),
      }));
      const sessions = attempts.flatMap(a => [a.execute, a.verify]).filter((s): s is TurnsNodeSession => s != null);
      out.push({
        key: n.key,
        nodeId: n.nodeId,
        generation: n.generation,
        label: n.label,
        taskType: n.taskType,
        status: n.status,
        executionState: n.executionState,
        carriedFromGeneration: n.carriedFromGeneration,
        hasSubgraph: n.hasSubgraph,
        depth,
        attempts,
        sessions,
      });
      if (n.hasSubgraph) {
        for (const sv of subViewsByParent.get(n.key) ?? []) out.push(...build(sv, depth + 1));
      }
    }
    return out;
  };
  return build(main, 0);
}

function firstContentNode(nodes: TurnsNode[]): TurnsNode | undefined {
  return nodes.find(c => c.executionState !== "not_run" && c.sessions.length > 0) ?? nodes[0];
}

/** 搜索未驻留时过滤 hook 的稳定空集（避免每次渲染新数组触发 memo 重算） */
const EMPTY_SEARCH_ITEMS: TurnSearchItem[] = [];

export function RunTurnsTab({ runId, viewModel, turnId, onSelectTurn, searchQuery = null }: RunTurnsTabProps) {
  const dataEpoch = useRunDataEpoch();
  const nodes = useMemo(() => buildNodes(viewModel), [viewModel]);
  const flatSessions = useMemo(() => nodes.flatMap(c => c.sessions), [nodes]);
  const bands = useMemo(
    () => viewModel.views[0]?.layout.bands.map(b => ({ generation: b.generation, label: b.label })) ?? [],
    [viewModel],
  );
  const rollbacks = useMemo(
    () => viewModel.rollbacks.map(r => ({ ordinal: r.ordinal, note: r.note, toGeneration: r.to.generation })),
    [viewModel],
  );

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // 首个节点默认展开（落地即有内容；solo = 唯一会话直接呈现）
    const first = firstContentNode(nodes);
    return first ? new Set([first.key]) : new Set();
  });
  /** 用户点过的节点（点过即完全由 expanded 集合控制；未点过的节点跟随选中轮自动展开） */
  const [toggledNodes, setToggledTurnsNodes] = useState<Set<string>>(new Set());
  const [memberData, setMemberData] = useState<Map<string, MemberTurnsState>>(new Map());
  /** 已加载轮次全集 → 角色筛选选项（计数随成员懒加载增量就位，只列出真实
   *  出现过的角色） */
  const loadedTurnsAll = useMemo(() => [...memberData.values()].flatMap(s => s.turns), [memberData]);
  const roleOptions = useMemo(() => deriveRoleOptions(loadedTurnsAll), [loadedTurnsAll]);
  /** 时间线三路取数（executions / bridges / lanes）：桥同时喂节点内的派发归组 */
  const timeline = useRunTimeline(runId, dataEpoch);
  const bridges = timeline.bridges;
  /** 跨成员搜索驻留态（null = 节点索引；非 null = 命中索引驻留左列） */
  const [search, setSearch] = useState<TurnsSearchState | null>(null);
  /** 角色多选筛选（左列节点列表视角；空集 = 全显）。搜索驻留时筛选条隐藏，
   *  筛选本身保持不动，退出搜索继续生效 */
  const [roleFilter, setRoleFilter] = useState<ReadonlySet<string>>(new Set());
  /** 轮详情仓（turnId → 详情；走查缓存命中不重取） */
  const [details, setDetails] = useState<Map<string, TurnDetailData>>(new Map());
  const inflightDetailRef = useRef<Set<string>>(new Set());
  /** 详情加载节奏态：骨架出场轮（越过延迟窗口仍在取数）/ 刚从取数落地的轮
   *  （内容卡入场动画标记）/ 走查选中标记（走查不入场）/ 骨架延迟计时器 */
  const [skeletonFor, setSkeletonFor] = useState<string | null>(null);
  const [enteredTurnId, setEnteredTurnId] = useState<string | null>(null);
  const walkSelectRef = useRef<string | null>(null);
  const skeletonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 已取/在途的成员首页（`taskId:1`），懒加载去重闸 */
  const fetchedPagesRef = useRef<Set<string>>(new Set());
  /** 补拉链单飞闸（`taskId`）：首页落地后的自动续拉 / 中断手动重试共用 */
  const restInflightRef = useRef<Set<string>>(new Set());
  /** memberData 只读镜像（effect 提交后同步）：补拉链与重试读镜像而非闭包
   *  捕获，回调身份保持稳定——会话块/行 memo 不被每次成员取数打散 */
  const memberDataRef = useRef(memberData);
  useEffect(() => { memberDataRef.current = memberData; }, [memberData]);
  /** 走查越过已加载边界时的待落地选择（目标会话加载完即选首/末轮） */
  const pendingWalk = useRef<{ taskId: string; dir: 1 | -1 } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /** 成员轮次自动拉齐（两段式）：首页 PAGE_SIZE 快出首屏 → 剩余按 offset
   *  分块补拉到全集（块 ≤ REST_PAGE_SIZE，超出循环续拉）。补拉量随已载量
   *  变化，页码算术只表达「同页容第 N 页」，表达不了「从已载边界起取 N 条」
   *  ——offset 是补拉的唯一诚实语义。中断由会话块「加载更多」手动重试兜底，
   *  重试重入链条从已载边界续拉（幂等） */
  const fetchMemberRest = useCallback(async (taskId: string, loadedHint?: number, totalHint?: number) => {
    if (restInflightRef.current.has(taskId)) return;
    const seed = memberDataRef.current.get(taskId);
    let loaded = loadedHint ?? seed?.turns.length ?? 0;
    let total = totalHint ?? seed?.total ?? 0;
    if (loaded >= total) return;
    restInflightRef.current.add(taskId);
    // 转场更新：装载门期间渲染树极小、转场开销近零；完成翻转（门开 → 全量
    // 行一次性挂载）与纪元增量（列表在场的大重渲）经转场让出主线程——滚动
    // 与输入保持可响应
    startTransition(() => {
      setMemberData(prev => {
        const cur = prev.get(taskId);
        if (!cur || cur.loading) return prev;
        const next = new Map(prev);
        next.set(taskId, { ...cur, loading: true });
        return next;
      });
    });
    try {
      for (let i = 0; i < REST_CHAIN_LIMIT; i++) {
        const take = Math.min(total - loaded, REST_PAGE_SIZE);
        let d: { items?: TurnsBlockTurn[]; total?: number } | null = null;
        try {
          const r = await fetch(`/api/observe/run/${encodeURIComponent(runId)}/turns?member=${encodeURIComponent(taskId)}&offset=${loaded}&pageSize=${take}`);
          d = r.ok ? await r.json().catch(() => null) : null;
        } catch { /* 中断退出，手动重试兜底 */ }
        const items = d && Array.isArray(d.items) ? d.items : null;
        if (!items || items.length === 0) break;
        const reported = d?.total;
        if (typeof reported === 'number' && Number.isFinite(reported)) total = reported;
        loaded += items.length;
        startTransition(() => {
          setMemberData(prev => {
            const cur = prev.get(taskId);
            if (!cur) return prev;
            // 服务端确定性排序（createdAt asc / id asc）保证 offset 续拉连续；
            // turnId 去重追加兜底重入重叠（重复条目丢弃，顺序保持）
            const seen = new Set(cur.turns.map(t => t.turnId));
            const merged = cur.turns.concat(items.filter(t => !seen.has(t.turnId)));
            const next = new Map(prev);
            next.set(taskId, { turns: merged, total, loading: merged.length < total });
            return next;
          });
        });
        if (loaded >= total) break;
      }
    } finally {
      restInflightRef.current.delete(taskId);
      startTransition(() => {
        setMemberData(prev => {
          const cur = prev.get(taskId);
          if (!cur?.loading) return prev;
          const next = new Map(prev);
          next.set(taskId, { ...cur, loading: false });
          return next;
        });
      });
    }
  }, [runId]);

  const fetchMemberFirst = useCallback((taskId: string) => {
    fetchedPagesRef.current.add(`${taskId}:1`);
    void fetch(`/api/observe/run/${encodeURIComponent(runId)}/turns?member=${encodeURIComponent(taskId)}&page=1&pageSize=${PAGE_SIZE}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const items = d && Array.isArray(d.items) ? (d.items as TurnsBlockTurn[]) : null;
        if (!items) {
          // 首页失败：成员块以空态呈现（载入收敛，不触发补拉）
          setMemberData(prev => (prev.has(taskId)
            ? prev
            : new Map(prev).set(taskId, { turns: [], total: 0, loading: false })));
          return;
        }
        const total = Number.isFinite(d!.total) ? d!.total : items.length;
        startTransition(() => {
          setMemberData(prev => {
            const next = new Map(prev);
            next.set(taskId, { turns: items, total, loading: items.length < total });
            return next;
          });
        });
        // 自动拉齐：首页未覆盖全集即从已载边界补齐剩余
        if (items.length < total) void fetchMemberRest(taskId, items.length, total);
      })
      .catch(() => {
        setMemberData(prev => (prev.has(taskId)
          ? prev
          : new Map(prev).set(taskId, { turns: [], total: 0, loading: false })));
      });
  }, [runId, fetchMemberRest]);

  /** 首页懒加载（effect/事件两用；在途去重走 ref，首屏以数据缺席呈现载入态） */
  const ensureMemberTurns = useCallback((taskId: string) => {
    if (fetchedPagesRef.current.has(`${taskId}:1`)) return;
    fetchMemberFirst(taskId);
  }, [fetchMemberFirst]);

  const toggleNode = useCallback((key: string) => {
    setToggledTurnsNodes(prev => (prev.has(key) ? prev : new Set(prev).add(key)));
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    const ch = nodes.find(c => c.key === key);
    if (ch && !expanded.has(key)) for (const s of ch.sessions) ensureMemberTurns(s.taskId);
  }, [nodes, ensureMemberTurns, expanded]);

  /** 「加载更多」= 补拉链中断后的手动重试（点击重入链条，offset 从已载
   *  边界续拉，幂等）；自动拉齐路径下平时不可见 */
  const loadMore = useCallback((taskId: string) => {
    const cur = memberDataRef.current.get(taskId);
    if (!cur || cur.loading || cur.turns.length >= cur.total) return;
    void fetchMemberRest(taskId);
  }, [fetchMemberRest]);

  // ── 选中即揭示（原语）──
  // 任何路径换选某轮（列表点击 / 胶片轨 / ←/→ 走查 / 深链 / 跨页跳转）都挂起
  // 揭示意图，行就位后滚动到视野居中——选中行成为视觉焦点，与节点揭示同口
  // 径。目标行可能要等「详情归属 → 成员分页 → 节点展开」逐步就位，意图保留
  // 到行出现为止（换选挂起 effect 随取数/展开变化重试，见 effectiveExpanded
  // 之后）。用户手动收起的节点不强拆——手动展开后挂起的意图仍然生效
  const pendingRevealRef = useRef<string | null>(null);
  const prevTurnIdRef = useRef<string | null>(null);
  const revealPending = useCallback(() => {
    const t = pendingRevealRef.current;
    if (!t) return;
    // 搜索驻留期间左列被玻璃命中索引覆盖——对被盖住的列表揭示不可见也无
    // 意义，意图保留到退出（换选挂起 effect 依赖 search，退出即重试落地）
    if (search) return;
    const row = listRef.current?.querySelector(`[data-turn-row="${t}"]`);
    if (!row) return;
    // 分帧填充隐藏期：行已在 DOM 但不可视——意图保留，就绪交换后（卡片
    // 卸载触发 observer）重试落地
    if (row.closest("[data-fill-hidden]")) return;
    pendingRevealRef.current = null;
    revealIntoView(listRef.current, row);
  }, [search]);
  /** 跳转选中出口（胶片轨 / ←/→ 走查）：每次选中——含重选当前轮——都挂起
   *  揭示，重选已看过的轮也能把列表带回居中位置 */
  const handleSelectTurn = useCallback((id: string) => {
    pendingRevealRef.current = id;
    revealPending();
    onSelectTurn(id);
  }, [onSelectTurn, revealPending]);
  /** 列表内点击选中：不揭示——用户点的行已在视野内，强制居中反而扰动；
   *  记 origin 供换选挂起 effect 识别（prop 换选无此标记 = 外部跳转） */
  const listOriginRef = useRef<string | null>(null);
  const handleListSelectTurn = useCallback((id: string) => {
    listOriginRef.current = id;
    onSelectTurn(id);
  }, [onSelectTurn]);

  // 首节点成员取数（展开态由 useState 惰性初始化给出；本 effect 只负责数据）
  useEffect(() => {
    const first = firstContentNode(nodes);
    if (first) for (const s of first.sessions) ensureMemberTurns(s.taskId);
  }, [nodes, ensureMemberTurns]);

  // 数据纪元增量拉齐：刷新后按「已载边界」offset 续拉各已载成员——不重置任何
  // 阅读态（滚动/展开/搜索/筛选/详情仓全保持；新轮次按 turnId 去重追加，
  // 服务端确定性排序保证 offset 续拉连续）。totalHint=∞ 越过「已载 ≥ 已知
  // 总量」早退闸——新轮次使 total 增长，旧值不再可信，首响应回报真实 total
  // 即收敛。0 轮成员同样走此路（offset=0 = 从头拉首页）。
  useEffect(() => {
    if (dataEpoch === 0) return;
    for (const [taskId, s] of memberDataRef.current) {
      void fetchMemberRest(taskId, s.turns.length, Number.POSITIVE_INFINITY);
    }
  }, [dataEpoch, fetchMemberRest]);

  // 选中轮详情（turnId 全局唯一；详情仓缓存命中不重取，←/→ 走查零请求）
  const activeDetail = turnId != null ? (details.get(turnId) ?? null) : null;

  // 换选渲染期快照（React 认可的 prev 值比较形态，同 run-view）：换选时
  // ①快照上一轮详情——取数窗口内保留旧内容展示（换轮不闪骨架）；
  // ②清入场标记——入场只属于「该轮取数落地」的那次挂载，换选（含缓存
  // 命中）不重放，本次选中若首次取数由下方详情 effect 在落地时重新标记
  const [prevTurnId, setPrevTurnId] = useState<string | null>(turnId);
  const [staleDetail, setStaleDetail] = useState<TurnDetailData | null>(null);
  if (prevTurnId !== turnId) {
    setPrevTurnId(turnId);
    setStaleDetail(prevTurnId != null ? details.get(prevTurnId) ?? null : null);
    setEnteredTurnId(null);
  }
  const shownDetail = activeDetail ?? (turnId != null ? staleDetail : null);

  useEffect(() => {
    if (!turnId || details.has(turnId) || inflightDetailRef.current.has(turnId)) return;
    inflightDetailRef.current.add(turnId);
    if (skeletonTimerRef.current) { clearTimeout(skeletonTimerRef.current); skeletonTimerRef.current = null; }
    // 走查标记消费：走查选中不入场（连续走查求快）；点击选中落地后阶梯入场
    const fromWalk = walkSelectRef.current === turnId;
    walkSelectRef.current = null;
    // 骨架出场时机：有旧内容保留 180ms（快取数全程无感）；无旧内容
    // （首选/深链）由渲染回退立即出骨架——真慢加载才让位给骨架
    if (staleDetail != null) {
      skeletonTimerRef.current = setTimeout(() => {
        skeletonTimerRef.current = null;
        setSkeletonFor(turnId);
      }, DETAIL_SKELETON_DELAY_MS);
    }
    void fetch(`/api/observe/turn/${encodeURIComponent(turnId)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d || d.turnId !== turnId) return;
        setDetails(prev => {
          const next = new Map(prev);
          next.set(turnId, d);
          return next;
        });
        setSkeletonFor(prev => (prev === turnId ? null : prev));
        if (!fromWalk) setEnteredTurnId(turnId);
      })
      .catch(() => { /* 详情不可用时保持占位 */ })
      .finally(() => {
        inflightDetailRef.current.delete(turnId);
        if (skeletonTimerRef.current) { clearTimeout(skeletonTimerRef.current); skeletonTimerRef.current = null; }
      });
  }, [turnId, details, staleDetail]);

  // 数据纪元：选中轮详情原地刷新（streaming 中的轮内容增长直接替换仓条
  // 目；滚动不动——内容只向下延伸，不闪骨架不重放入场动画）。未选中不动
  // 作；缓存里没有的轮由上方详情 effect 负责首取，此处只做已看内容的更新。
  useEffect(() => {
    if (dataEpoch === 0 || turnId == null) return;
    const id = turnId;
    if (inflightDetailRef.current.has(id)) return;
    inflightDetailRef.current.add(id);
    void fetch(`/api/observe/turn/${encodeURIComponent(id)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d || d.turnId !== id) return;
        setDetails(prev => {
          const next = new Map(prev);
          next.set(id, d);
          return next;
        });
      })
      .catch(() => { /* 刷新失败保留旧详情 */ })
      .finally(() => { inflightDetailRef.current.delete(id); });
  }, [dataEpoch, turnId]);

  // 卸载时收尾骨架计时器
  useEffect(() => () => { if (skeletonTimerRef.current) clearTimeout(skeletonTimerRef.current) }, []);

  // 详情的成员归属 → 确保轮次就位（深链/搜索/跨 tab 同路；节点展开是
  // 渲染期派生——选中轮所在节点恒开，无需 effect 改状态）。取数窗口内
  // 跟随展示内容（旧轮的归属已在册，no-op）
  const ownerTaskId = shownDetail?.taskId ?? null;
  useEffect(() => {
    if (ownerTaskId) ensureMemberTurns(ownerTaskId);
  }, [ownerTaskId, ensureMemberTurns]);

  const ownerState = ownerTaskId ? (memberData.get(ownerTaskId) ?? null) : null;
  const ownerTurnsSorted = useMemo(
    () => (ownerState ? [...ownerState.turns].sort((a, b) => a.turnIndex - b.turnIndex) : []),
    [ownerState],
  );

  // 走查序列（当前会话内）：←/→ 沿轮次序；越界跳相邻会话——目标已加载
  // 直接选首/末轮（memberData 无变化也要落地），未加载记待落地并取数
  const resolveWalk = useCallback((taskId: string, dir: 1 | -1) => {
    const st = memberData.get(taskId);
    if (!st || st.loading || st.turns.length === 0) {
      pendingWalk.current = { taskId, dir };
      ensureMemberTurns(taskId);
      return;
    }
    const sorted = [...st.turns].sort((a, b) => a.turnIndex - b.turnIndex);
    const target = (dir === 1 ? sorted[0] : sorted[sorted.length - 1]).turnId;
    walkSelectRef.current = target;
    handleSelectTurn(target);
  }, [memberData, ensureMemberTurns, handleSelectTurn]);

  const walk = useCallback((dir: 1 | -1) => {
    if (!ownerTaskId) {
      if (flatSessions.length === 0) return;
      resolveWalk(flatSessions[dir === 1 ? 0 : flatSessions.length - 1].taskId, dir);
      return;
    }
    const idx = ownerTurnsSorted.findIndex(t => t.turnId === turnId);
    if (idx >= 0) {
      const next = ownerTurnsSorted[idx + dir];
      if (next) { walkSelectRef.current = next.turnId; handleSelectTurn(next.turnId); return }
    }
    const sIdx = flatSessions.findIndex(s => s.taskId === ownerTaskId);
    const target = flatSessions[sIdx + dir];
    if (!target) return;
    resolveWalk(target.taskId, dir);
  }, [ownerTaskId, ownerTurnsSorted, turnId, flatSessions, handleSelectTurn, resolveWalk]);

  // 越界取数完成后的落地（数据到位即选首/末轮，复用 resolveWalk 的目标推导）
  useEffect(() => {
    const pw = pendingWalk.current;
    if (!pw) return;
    const st = memberData.get(pw.taskId);
    if (!st || st.loading || st.turns.length === 0) return;
    pendingWalk.current = null;
    resolveWalk(pw.taskId, pw.dir);
  }, [memberData, resolveWalk]);

  // Player 注入：胶片 = 当前成员会话全量轮（root + subagent 混排，token 柱高）
  const filmstripTurns = useMemo<FilmstripTurn[]>(
    () => ownerTurnsSorted.map(t => ({
      turnId: t.turnId,
      turnIndex: t.turnIndex,
      role: t.role,
      isSubagent: t.isSubagent,
      totalTokens: t.totalTokens,
      latencyMs: t.latencyMs,
      contextWindowPct: t.contextWindowPct,
    })),
    [ownerTurnsSorted],
  );

  // 同 agent 维度的上一轮（Δ 输入卡的边界：root 与 subagent 各自连续）
  const prevSameAgent = useMemo(() => {
    if (!shownDetail) return null;
    const idx = ownerTurnsSorted.findIndex(t => t.turnId === shownDetail.turnId);
    for (let i = idx - 1; i >= 0; i--) {
      const prev = ownerTurnsSorted[i];
      if (prev.role === 'assistant' && prev.subagentSessionId === shownDetail.subagentSessionId) return prev;
    }
    return null;
  }, [shownDetail, ownerTurnsSorted]);

  const prevTotalInputTokens = useMemo(() => {
    if (!prevSameAgent) return null;
    return prevSameAgent.inputTokens
      + (prevSameAgent.cacheReadTokens ?? 0)
      + (prevSameAgent.cacheWriteTokens ?? 0);
  }, [prevSameAgent]);

  const subagentLabel = useMemo(() => {
    if (!shownDetail?.isSubagent) return undefined;
    const t = ownerTurnsSorted.find(x => x.turnId === shownDetail.turnId);
    return t?.subagentType ?? shownDetail.subagentName ?? "subagent";
  }, [shownDetail, ownerTurnsSorted]);

  // 选中轮所属节点：驱动节点跟随选中自动展开
  const ownerNodeKey = useMemo(
    () => (ownerTaskId ? nodes.find(c => c.sessions.some(s => s.taskId === ownerTaskId))?.key ?? null : null),
    [nodes, ownerTaskId],
  );

  /** 生效展开集 = 用户展开 ∪ 选中轮所在节点（未点过的节点跟随选中自动展开——
   * 深链/跨节点走查的展开是渲染期派生，不落 effect 改状态） */
  const effectiveExpanded = useMemo(() => {
    if (!ownerNodeKey || expanded.has(ownerNodeKey) || toggledNodes.has(ownerNodeKey)) return expanded;
    const next = new Set(expanded);
    next.add(ownerNodeKey);
    return next;
  }, [expanded, toggledNodes, ownerNodeKey]);

  // ── 选中即揭示：换选挂起 ──
  // prop 驱动的换选（深链 / 跨 tab / 上一层 select）在这里挂起意图；
  // handleSelectTurn 覆盖跳转选中出口。列表内点击（handleListSelectTurn
  // 记 origin）不揭示——行已在位。行未就位时意图保留，effect 随取数
  // （details/memberData）与展开（effectiveExpanded）变化重试
  useEffect(() => {
    if (prevTurnIdRef.current !== turnId) {
      prevTurnIdRef.current = turnId;
      pendingRevealRef.current = listOriginRef.current === turnId ? null : turnId;
      listOriginRef.current = null;
    }
    revealPending();
    // search 在依赖里：退出搜索（节点列表回位）时挂起的揭示意图落地
  }, [turnId, details, memberData, effectiveExpanded, search, revealPending]);

  // 分帧填充期间行渐次落位（memberData/details 不变，上述 effect 不会重跑）
  // ——监听列表 DOM 子树变化重试挂起的揭示意图：目标行落在哪一帧就滚到
  // 哪一帧（深链 #N / 跨 tab 大 run 直达不因填充窗口漏滚）
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => revealPending());
    mo.observe(list, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [revealPending]);

  // ── 跨成员搜索（Trace 退役，搜索归 Turns——命中索引驻留左列）──
  // 命中集是排查工作集：选中命中打开 player 后列表不消失；退出（✕ / Esc /
  // 点时间线 / 改词重搜）才回节点索引。选中轮的成员分页与节点展开照常由
  // 既有管线就位（详情归属 → ensureMemberTurns → effectiveExpanded）
  const [activeHitIdx, setActiveHitIdx] = useState(0);
  const [visitedHits, setVisitedHits] = useState<ReadonlySet<string>>(new Set());
  const [hitHighlight, setHitHighlight] = useState<TurnHighlight | null>(null);
  // 桥接回应轮集合（来源过滤的「子agent返回」分类事实）
  const bridgeResponseTurnIds = useMemo(
    () => new Set(bridges.flatMap(b => (b.responseTurnId ? [b.responseTurnId] : []))),
    [bridges],
  );
  // 命中过滤：键盘走查（↑↓/Enter）与过滤后列表对齐；改词重搜复位过滤
  const { filter: hitFilter, toggle: toggleHitFilter, reset: resetHitFilter, visible: visibleHits, anyActive: hitFilterActive, sourceOptions, thinkingOption, toolOptions } =
    useTurnsHitsFilter(search?.items ?? EMPTY_SEARCH_ITEMS, bridgeResponseTurnIds);

  // 过滤/改词收窄后活跃命中序号钳在界内（走查位置就近保持，不硬复位）——
  // 渲染期 prop 变化模式（与详情自动展开同门，避免 effect 内同步 setState）
  const [prevHitsLen, setPrevHitsLen] = useState(visibleHits.length);
  if (prevHitsLen !== visibleHits.length) {
    setPrevHitsLen(visibleHits.length);
    setActiveHitIdx(i => Math.min(i, Math.max(visibleHits.length - 1, 0)));
  }

  const runSearch = useCallback(async (kw: string) => {
    setSearch({ keyword: kw, loading: true, items: [], total: 0 });
    setActiveHitIdx(0);
    setVisitedHits(new Set());
    resetHitFilter();
    try {
      const res = await fetch(
        `/api/observe/run/${encodeURIComponent(runId)}/turns/search?keyword=${encodeURIComponent(kw)}`,
      );
      const d = res.ok ? await res.json() : null;
      // 关键词已换（连续改词重搜）则丢弃迟到响应
      setSearch(prev =>
        prev && prev.keyword === kw
          ? { keyword: kw, loading: false, items: d?.items ?? [], total: d?.total ?? (d?.items ?? []).length }
          : prev,
      );
    } catch {
      setSearch(prev => (prev ? { ...prev, loading: false } : prev));
    }
  }, [runId, resetHitFilter]);

  // 搜索预填深链消费（渲染期 prop 变化模式，与换选快照/命中序号钳位同门）：
  // 新 q 值到 → 执行一次搜索（驻留命中索引，输入框随驻留关键词回显）。初始
  // 态为 null——挂载时 q 已就位（深链直开/切 tab 进入）同样算「新值」照常
  // 消费；同值不重放（tab 常驻挂载下往返不重搜），换值重放（连续下钻）
  const [consumedSearchQuery, setConsumedSearchQuery] = useState<string | null>(null);
  if (searchQuery !== consumedSearchQuery) {
    setConsumedSearchQuery(searchQuery);
    if (searchQuery != null) void runSearch(searchQuery);
  }

  const exitSearch = useCallback(() => {
    setSearch(null);
    setHitHighlight(null);
    setActiveHitIdx(0);
    // 回节点列表后居中揭示当前选中轮（若在册）——工作流连续性
    if (turnId != null) pendingRevealRef.current = turnId;
  }, [turnId]);

  const openHit = useCallback(
    (item: TurnSearchItem) => {
      setVisitedHits(prev => {
        const next = new Set(prev);
        next.add(item.turnId);
        return next;
      });
      setHitHighlight({
        keyword: search?.keyword ?? "",
        terms: parseTurnsQuery(search?.keyword ?? "").positiveTerms,
        matchField: item.matchField,
        toolName: item.toolName,
      });
      handleSelectTurn(item.turnId);
    },
    [search, handleSelectTurn],
  );

  /** #N 直达：与胶片轨同基准——当前会话已加载轮内按序号定位 */
  // ── #N 轮次直达（run 级解析）──
  // 真相源在服务端（by-index 端点跨成员定位该轮次号）：客户端已加载分页
  // 是窗口不是全集，未选中会话/加载窗口外的轮次在客户端解析不出（#25 误
  // 报「未找到」的根因）。此处只负责解析（候选集 + 当前会话归因）；呈现与
  // 选择归胶囊（单候选直接跳，多候选下钻），跳转动作走既有选中管线（详情
  // 归属 → ensureMemberTurns → 揭示），目标行在加载窗口外时由补拉拉齐后落地
  const jumpTurnIndex = useCallback(
    async (idx: number): Promise<TurnJumpOutcome> => {
      try {
        const res = await fetch(`/api/observe/run/${encodeURIComponent(runId)}/turns/by-index?index=${idx}`);
        if (!res.ok) return { found: false };
        const d = await res.json();
        const items: TurnJumpMatch[] = Array.isArray(d?.items) ? d.items : [];
        if (items.length === 0) return { found: false };
        return { found: true, matches: items, currentMemberTaskId: ownerTaskId };
      } catch {
        return { found: false };
      }
    },
    [runId, ownerTaskId],
  );

  /** 时间线单击：搜索驻留时先退出（命中索引让位、节点列表回位），再走统一
   *  选中管线——换选挂起的揭示意图随列表回位落地 */
  const onTimelineSelectTurn = useCallback(
    (id: string) => {
      if (search) exitSearch();
      handleSelectTurn(id);
    },
    [search, exitSearch, handleSelectTurn],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-foreground/[0.07] bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      {/* ① 时间线（压顶导航轨）：真实时间轴上 root 道 + 子代理槽位，单击任一
          时刻即选中该刻的轮次，播放头跟随选中轮；搜索胶囊与工具条同住一行 */}
      <RunTurnsTimeline
        agents={timeline.agents}
        bridges={bridges}
        lanes={timeline.lanes}
        lanesInferred={timeline.lanesInferred}
        selectedTurnId={turnId}
        onSelectTurn={onTimelineSelectTurn}
      >
        <TurnSearchField
          state={search}
          hitCount={visibleHits.length}
          onSearch={runSearch}
          onExit={exitSearch}
          onJumpIndex={jumpTurnIndex}
          onJumpTurn={handleSelectTurn}
          onStepHit={dir =>
            setActiveHitIdx(i => {
              const max = Math.max(visibleHits.length - 1, 0);
              return Math.min(Math.max(i + dir, 0), max);
            })
          }
          onOpenHit={() => {
            const it = visibleHits[activeHitIdx];
            if (it) openHit(it);
          }}
        />
      </RunTurnsTimeline>

      {/* ②③ 节点 + Player */}
      <div className="flex min-h-0 flex-1">
        {/* 节点列表常驻挂载——搜索驻留时被玻璃命中索引覆盖（列表在玻璃后
            虚化、滚动位置保留），覆盖期间 inert 防键盘焦点落入被盖住的行；
            角色筛选条在列表头上常驻（首份成员数据落地即出现），搜索驻留时
            让位隐藏、退出即回位 */}
        <div className="relative flex w-[400px] shrink-0 flex-col border-r border-foreground/[0.07]">
          {!search && (
            <RunTurnsRoleFilter
              options={roleOptions}
              total={loadedTurnsAll.length}
              selected={roleFilter}
              onToggle={role => setRoleFilter(prev => toggleRoleFilter(prev, role))}
              onReset={() => setRoleFilter(new Set())}
            />
          )}
          <div ref={listRef} data-turn-list className="min-h-0 flex-1 overflow-y-auto" inert={search != null}>
            <RunTurnsNodes
              nodes={nodes}
              bands={bands}
              rollbacks={rollbacks}
              expanded={effectiveExpanded}
              onToggleNode={toggleNode}
              memberData={memberData}
              bridges={bridges}
              selectedTurnId={turnId}
              onSelectTurn={handleListSelectTurn}
              onLoadMore={loadMore}
              roleFilter={roleFilter}
            />
          </div>
          {search && (
            <TurnHitsPanel
              state={search}
              hits={visibleHits}
              activeIdx={activeHitIdx}
              selectedTurnId={turnId}
              visited={visitedHits}
              onSelect={openHit}
              onExit={exitSearch}
              filter={hitFilter}
              onToggle={toggleHitFilter}
              onReset={resetHitFilter}
              anyActive={hitFilterActive}
              sourceOptions={sourceOptions}
              thinkingOption={thinkingOption}
              toolOptions={toolOptions}
            />
          )}
        </div>
        {/* 详情加载节奏：缓存命中/走查零等待直接换内容；点击选轮的首次取数
            在 180ms 内保留上一轮内容（微微压暗示意加载中，不闪骨架），落地后
            由 TurnDetail 的 entrance 阶梯入场；真慢加载（超时）才让位给骨架 */}
        <div
          className={cn(
            "min-w-0 flex-1 overflow-y-auto bg-muted/40 transition-opacity duration-200",
            turnId != null && !activeDetail && shownDetail != null && skeletonFor !== turnId && "opacity-70",
          )}
        >
          {turnId == null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-foreground/[0.04]">
                <MessageSquareIcon className="size-5 text-muted-foreground/60" />
              </span>
              <p className="text-sm font-medium text-foreground/80">选择一轮开始走查</p>
              <p className="max-w-[280px] text-xs leading-relaxed text-muted-foreground">
                展开左侧节点点击任意轮次；加载后 ←/→ 连续走查整个 run，越过节点边界自动衔接
              </p>
            </div>
          ) : activeDetail ? (
            <TurnDetail
              turn={activeDetail}
              entrance={enteredTurnId === activeDetail.turnId}
              highlight={hitHighlight}
              filmstripTurns={filmstripTurns.length > 0 ? filmstripTurns : undefined}
              onSelectTurn={handleSelectTurn}
              onPrevTurn={() => walk(-1)}
              onNextTurn={() => walk(1)}
              prevTotalInputTokens={prevTotalInputTokens}
              prevInputMessagesCount={prevSameAgent?.inputMessagesCount ?? null}
              subagentLabel={subagentLabel}
            />
          ) : skeletonFor === turnId || !shownDetail ? (
            <TurnDetailSkeleton />
          ) : (
            <TurnDetail
              turn={shownDetail}
              filmstripTurns={filmstripTurns.length > 0 ? filmstripTurns : undefined}
              onSelectTurn={handleSelectTurn}
              onPrevTurn={() => walk(-1)}
              onNextTurn={() => walk(1)}
              prevTotalInputTokens={prevTotalInputTokens}
              prevInputMessagesCount={prevSameAgent?.inputMessagesCount ?? null}
              subagentLabel={subagentLabel}
            />
          )}
        </div>
      </div>
    </div>
  );
}
