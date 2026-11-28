"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Turns 节点列表（design: run 级 Turns 变革——节点实例 = 节点）。
// 会话视图「主线 + subagent 下钻」的语法升一层：run 工作流骨架（代 →
// 节点实例 → 尝试）为脊，成员会话节点挂在工作流顺序位置上，节点内是
// 该成员的轮次行 + 嵌套 subagent 泳道（桥机制照旧，含子代理嵌套与并行组）。
// 节点默认折叠、按成员懒加载（turns?member= 既有过滤），节点头摘要直接
// 来自 SessionRef（未加载即有 turns/tokens/时长）。

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, Loader2Icon, WrenchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BreathCards } from "@/components/ui/loading";
import { cn } from "@/lib/utils";
import { ExpandableText } from "@/components/observe/ExpandableText";
import { isCommandTurn, isCommandTail, parseCommandTurns, formatCommandDisplay, isContinuationTurn, parseContinuationTurn } from "@/lib/shared/command-parser";
import { buildSubagentNumbers } from "@/lib/subagent-numbering";

import type { SessionRef } from "@/lib/run/model";
import type { NodeInstance, NodeStatus } from "@/lib/run/view-model";

// ── 节点模型（RunTurnsTab 由 viewModel 构建） ──────────────────────

export interface TurnsNodeSession {
  /** 成员 taskId（turns?member= 挂载键 + SessionRef 身份） */
  taskId: string;
  label: string | null;
  role: "execute" | "verify";
  attemptOrdinal: number;
  ref: SessionRef;
}

export interface TurnsNodeAttempt {
  ordinal: number;
  status: string;
  verification: { type: string; status: string; reason: string | null };
  outputText: string | null;
  execute: TurnsNodeSession | null;
  verify: TurnsNodeSession | null;
}

export interface TurnsNode {
  /** 节点实例 key（n-<nodeId>-g<generation>） */
  key: string;
  nodeId: string;
  generation: number;
  label: string;
  taskType: NodeInstance["taskType"];
  status: NodeStatus;
  executionState: NodeInstance["executionState"];
  carriedFromGeneration: number | null;
  hasSubgraph: boolean;
  /** 0 = 主图；1+ = 子图嵌套层级 */
  depth: number;
  attempts: TurnsNodeAttempt[];
  /** 尝试内顺序拍平（execute → verify） */
  sessions: TurnsNodeSession[];
}

export interface MemberTurnsState {
  turns: TurnsBlockTurn[];
  total: number;
  loading: boolean;
}

/** 会话块消费的轮次最小结构（run 轮次投影与离线查看器轮次同构子集） */
export interface TurnsBlockTurn {
  turnId: string;
  turnIndex: number;
  role: string;
  contentSummary: string | null;
  agentName: string | null;
  isSubagent: boolean;
  subagentName: string | null;
  subagentSessionId: string | null;
  subagentType?: string | null;
  totalTokens: number;
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputMessagesCount: number;
  createdAt: string | null;
  contextWindowPct: number | null;
  latencyMs: number;
  /** 单轮耗时（生成 + 工具执行墙钟口径，服务端算好）：缺省回落 latencyMs
   *  （旧投影/测试夹具兼容）。分解 tooltip 由两者差值推出。 */
  turnMs?: number;
  toolCalls: Array<{ toolName: string; state: string; durationMs?: number }>;
  finishReason?: string | null;
}

/** 泳道消费的桥最小结构（MergedBridgeItem 与查看器 BridgeItem 的公共子集） */
export interface TurnsBridge {
  bridgeId: string;
  dispatchTurnId: string | null;
  dispatchContent: string | null;
  dispatchTimestamp?: string | null;
  subagentSessionId: string | null;
  subagentType: string | null;
  subagentName: string | null;
  agentName: string | null;
  status: string;
  subagentTokens: number;
  subagentLatencyMs: number;
  /** 后台异步派发（collectors 侧 isBackgroundDispatch）：黄徽章提示
   *  「派发立即返回，完成后再通知」——响应时刻 ≠ 完成时刻 */
  dispatchBackground?: boolean;
}

// ── 状态色（单一映射：节点状态 → 圆点 class，Run 轨状态段同源复用） ──

export const STATUS_DOT: Record<NodeStatus, string> = {
  passed: "bg-emerald-500",
  failed: "bg-red-500",
  running: "bg-amber-500 animate-pulse",
  pending: "bg-foreground/25",
  carried: "bg-sky-400",
  unknown: "bg-foreground/25",
};

export const ROLE_DOT: Record<string, string> = {
  user: "bg-blue-500",
  assistant: "bg-emerald-500",
  system: "bg-slate-400",
  tool_result: "bg-teal-500",
  command: "bg-slate-400",
  continuation: "bg-purple-400",
  compaction: "bg-amber-400",
};

function fmtTokens(n: number): string {
  if (n === 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function fmtLatency(ms: number): string {
  if (ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ── 轮次行（新排版语法：角色点 + 单行摘要 + 右对齐数值） ───────────

export interface DisplayTurn extends TurnsBlockTurn {
  displayRole: string;
  displayContent: string;
  /** 输出构成（决定摘要行的着色语义）：text 正文｜thinking 思考｜tools 工具名 */
  displayKind: "text" | "thinking" | "tools";
}

// 轮次行的输出构成摘要：正文 > 思考片段 > 工具名——无正文的轮也要一眼
// 读出「这轮产出了什么」。思考块两种形态都要剥干净：闭标签完好（整块剥除）
// 与 summary 200 字符预算砍掉闭标签的截断残留（开标签起整体按思考内容读）。
// 思考/工具解析只对 assistant 生效——用户轮正文里的字面量 <thinking> 是数据
// 不是标记，须原样呈现。
export function summarizeOutput(
  role: string,
  text: string | null,
  toolCalls: Array<{ toolName: string }>,
): { kind: "text" | "thinking" | "tools"; content: string } {
  const raw = (text ?? "").trim();
  if (role === "assistant") {
    if (raw) {
      const body = raw.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, " ").trim();
      const openIdx = body.indexOf("<thinking>");
      if (openIdx === 0) {
        const thought = body.substring("<thinking>".length).replace(/<\/?thinking>/g, "").trim();
        if (thought) return { kind: "thinking", content: thought };
      } else if (openIdx > 0) {
        const before = body.substring(0, openIdx).trim();
        if (before) return { kind: "text", content: before };
      } else if (body) {
        return { kind: "text", content: body };
      } else {
        const m = raw.match(/<thinking>([\s\S]*?)<\/thinking>/);
        if (m && m[1].trim()) return { kind: "thinking", content: m[1].trim() };
      }
    } else if (toolCalls.length > 0) {
      return { kind: "tools", content: [...new Set(toolCalls.map(tc => tc.toolName))].join(" · ") };
    }
  }
  return { kind: "text", content: raw };
}

/** 轮次行角色归一（行渲染与角色筛选同源单一事实）：命令 / 续接摘要 / 压缩
 *  边界由文本与 agentName 推导，其余透传 role；命令的 caveat/stdout 附注行
 *  不独立成行（null = 不进入列表，也不参与筛选计数） */
export function classifyDisplayRole(t: TurnsBlockTurn): string | null {
  const text = t.contentSummary ?? "";
  if (isCommandTail(text)) return null;
  if (t.agentName === "compaction-boundary") return "compaction";
  if (isCommandTurn(text)) return "command";
  if (isContinuationTurn(text)) return "continuation";
  if (t.agentName === "continuation") return "continuation";
  return t.role;
}

// 行 memo 的前提是 turn 对象身份稳定：根行来自 processed 的 displayRootTurns、
// 泳道行来自 processed 预构的显示对象（toLaneDisplayTurn）——都不在渲染期新建
const TurnRow = memo(function TurnRow({ turn, selected, onSelect }: { turn: DisplayTurn; selected: boolean; onSelect: (turnId: string) => void }) {
  const isMono = turn.displayRole === "command" || turn.displayRole === "compaction";
  return (
    <button
      type="button"
      data-turn-row={turn.turnId}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-[6px] text-left transition-colors",
        selected ? "bg-primary/[0.08] ring-1 ring-primary/30" : "hover:bg-foreground/[0.04]",
      )}
      onClick={() => onSelect(turn.turnId)}
      title={turn.displayContent || undefined}
    >
      <span className="w-9 shrink-0 text-right font-mono text-[10px] leading-4 text-muted-foreground/70 tabular-nums">#{turn.turnIndex}</span>
      <span className={cn("size-1.5 shrink-0 rounded-full", ROLE_DOT[turn.displayRole] ?? "bg-slate-300")} aria-hidden />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs leading-4",
          turn.displayKind === "thinking"
            ? "text-purple-700/90 dark:text-purple-300/80"
            : turn.displayKind === "tools"
              ? "text-orange-700/90 dark:text-orange-300/80"
              : "text-foreground/85",
          isMono && "font-mono",
          turn.displayRole === "continuation" && "italic text-muted-foreground",
        )}
      >
        {turn.displayContent || "—"}
      </span>
      {turn.toolCalls.length > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 text-[10px] leading-4 text-muted-foreground/80"
          title={`${turn.toolCalls.length} 个工具调用`}
        >
          <WrenchIcon className="size-2.5" aria-hidden />
          <span className="tabular-nums">{turn.toolCalls.length}</span>
        </span>
      )}
      {turn.totalTokens > 0 && (
        <span className="w-11 shrink-0 text-right text-[10px] leading-4 text-muted-foreground tabular-nums">{fmtTokens(turn.totalTokens)}</span>
      )}
      {(() => {
        // 单轮耗时 > 0 才出列：工具有贡献时 tooltip 给「模型 + 工具」分解
        const wall = turn.turnMs ?? turn.latencyMs;
        if (wall <= 0) return null;
        const toolPart = Math.max(0, wall - turn.latencyMs);
        return (
          <span
            className="w-11 shrink-0 text-right text-[10px] leading-4 text-muted-foreground tabular-nums"
            title={toolPart > 0 ? `单轮 ${fmtLatency(wall)}：模型 ${fmtLatency(turn.latencyMs)} + 工具 ${fmtLatency(toolPart)}` : undefined}
          >
            {fmtLatency(wall)}
          </span>
        );
      })()}
    </button>
  );
});

// ── subagent 泳道（桥机制照旧：嵌套 + 并行组，重皮肤） ─────────────

export interface SubagentLane {
  bridgeId: string;
  sessionId: string | null;
  name: string;
  type: string | null;
  summary: string | null;
  turns: DisplayTurn[];
  status: string;
  totalTokens: number;
  latencyMs: number;
  turnCount: number;
  /** 无桥兜底 lane：派发未被建桥（上游 meta 登记空 / 异步派发无子会话 id），
   *  按时间就近挂到主链轮下——可见性优先，区别于桥驱动的精确 lane */
  unlinked?: boolean;
  /** 后台异步派发（派发立即返回、完成后再通知父会话）——黄徽章提示
   *  响应时刻 ≠ 完成时刻；无桥兜底 lane 无从判定（undefined） */
  background?: boolean;
}

interface LaneCtx {
  subagentBlocksByTurnId: Map<string, SubagentLane[]>;
  expandedSubagents: Set<string>;
  onToggleBridge: (bridgeId: string) => void;
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  /** 角色多选筛选（空集/缺省 = 不过滤）：lane 行与主链行同口径收敛 */
  roleFilter?: ReadonlySet<string>;
}

/** 筛选态下的 lane 可见性：自身有任一匹配轮即保留；无匹配整块让位（不留
 *  空壳头）——聚焦视图语义 */
function laneMatchesFilter(filter: ReadonlySet<string>, lane: SubagentLane): boolean {
  return filter.size === 0 || lane.turns.some(t => filter.has(t.displayRole));
}

/** 分帧填充片宽：单帧挂载的行数预算 */
const ROW_FILL_CHUNK = 400;

/** 分帧填充计数：巨型单次 commit（DOM 批插入不可中断，转场只保 render 可
 *  中断）是「装载完毕→完全展示」窗口整页冻结的主源——分帧摊平。消费方配
 *  「隐藏填充 + 就绪交换」：填充期容器 display:none（零布局零绘制），呼吸
 *  卡在场表示加载；填满后一次性交换亮相（此时全量已挂载，交换只做 class
 *  翻转 + content-visibility 只布局可视区）。total 增长（纪元增量/筛选放
 *  宽）自动续填。active 门控：未展开/未挂载的窗口不空跑填充 */
function useProgressiveCount(total: number, active: boolean): number {
  const [count, setCount] = useState(ROW_FILL_CHUNK);
  useEffect(() => {
    if (!active || count >= total) return;
    let alive = true;
    const id = requestAnimationFrame(() => {
      if (alive) setCount(c => Math.min(c + ROW_FILL_CHUNK, total));
    });
    return () => { alive = false; cancelAnimationFrame(id); };
  }, [active, count, total]);
  return Math.min(count, total);
}

/** 就绪闩：填充完成前保持「加载展示」（卡片在场、内容隐藏），完成时一次
 *  性交换；此后（纪元增量/筛选放宽）不再回隐藏——已读内容永不消失 */
function useRevealLatch(ready: boolean): boolean {
  const [shownOnce, setShownOnce] = useState(ready);
  if (ready && !shownOnce) setShownOnce(true);
  return shownOnce;
}

/** 填充期尾部呼吸占位：行还在分帧落位，占位与已落位行同视觉语言 */
function FillTail({ className }: { className?: string }) {
  return <div aria-hidden className={cn("load-breathe rounded-xl border border-border/40 bg-card/60", className)} />;
}

function SubagentLaneViewBase({ lane, ctx, path }: { lane: SubagentLane; ctx: LaneCtx; path?: ReadonlySet<string> }) {
  // hooks 全部在环截断/筛选让位等条件早退之前（不得有条件跳过）；小 lane
  // （< 片宽）即刻全量，零感知。填充只在展开态推进（折叠不空跑）
  const isExpanded = ctx.expandedSubagents.has(lane.bridgeId);
  const laneVisible = useProgressiveCount(lane.turns.length, isExpanded);
  const laneShownOnce = useRevealLatch(laneVisible >= lane.turns.length);
  // 路径集身份稳定（memo）：父级分帧重渲时嵌套 lane 的 memo 比较不被新 Set 打散
  const childPath = useMemo(() => {
    const next = new Set(path ?? []);
    next.add(lane.bridgeId);
    return next;
  }, [path, lane.bridgeId]);
  // 切片身份稳定（memo）：就绪交换翻转时 LaneRowsList 的 props 不变、整块跳过
  const laneTurns = useMemo(() => lane.turns.slice(0, laneVisible), [lane.turns, laneVisible]);
  // 渲染路径防环：建 lane 处已剔自引用桥，但存量库互引等其他形态的畸形桥
  // 仍可能构成 lane 环（A 的派发端在 B、B 的派发端在 A）——按 bridgeId
  // 路径截断，同一条展开链上不重复渲染同一 lane（环处显示截断提示）
  if (path?.has(lane.bridgeId)) {
    return (
      <div className="ml-3 border-l border-dashed border-orange-200 pl-3 px-1 py-0.5 text-[11px] text-muted-foreground dark:border-orange-500/30">
        ⥁ {lane.name} 已在此展开链上（环引用截断）
      </div>
    );
  }
  // 行与子 lane 分别判可见：行被滤掉但子 lane 有匹配轮时子 lane 仍在原位
  // （子代理的匹配轮也是匹配轮，不能随挂点行陪葬）；两者皆无才整块让位
  const filter = ctx.roleFilter ?? EMPTY_ROLE_FILTER;
  if (!laneMatchesFilter(filter, lane)) return null;
  const isError = lane.status === "error";
  return (
    <div className="min-w-0 rounded-lg border-l-2 border-orange-300/70 bg-foreground/[0.025] dark:border-orange-500/40 dark:bg-foreground/[0.05]">
      <div className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left">
        <span
          role="button"
          tabIndex={0}
          className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground/60 transition-colors select-none hover:bg-foreground/[0.06] hover:text-foreground"
          onClick={() => ctx.onToggleBridge(lane.bridgeId)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") ctx.onToggleBridge(lane.bridgeId) }}
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")} />
        </span>
        <Badge variant="orange" className="max-w-[45%] truncate text-[10px]">{lane.name}</Badge>
        {lane.background && <Badge variant="yellow" className="shrink-0 text-[10px]" title="后台异步派发：立即返回，完成后再通知父会话">background</Badge>}
        {lane.unlinked && <Badge variant="slate" className="shrink-0 text-[10px]" title="派发桥缺失（上游 meta 登记为空 / 异步派发无子会话 id），按时间就近挂载；点击可展开其轮次">未关联</Badge>}
        {isError && <Badge variant="red" className="shrink-0 text-[10px]">error</Badge>}
        {lane.summary && <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={lane.summary}>{lane.summary}</span>}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {lane.turnCount}t{lane.totalTokens > 0 ? ` · ${fmtTokens(lane.totalTokens)}` : ""}{lane.latencyMs > 0 ? ` · ${fmtLatency(lane.latencyMs)}` : ""}
        </span>
      </div>
      {isExpanded && lane.turns.length > 0 && (
        <div className="space-y-px px-1.5 pb-1.5">
          {/* 隐藏填充 + 就绪交换：填充期呼吸卡在场、行进隐藏容器分帧落位，
              填满一次性亮相（data-fill-hidden 同时是揭示意图的保留标记） */}
          {!laneShownOnce && <BreathCards count={3} compact className="py-1" />}
          <div
            className={cn(laneShownOnce ? "animate-in fade-in duration-300" : "hidden")}
            data-fill-hidden={laneShownOnce ? undefined : ""}
          >
            <LaneRowsList turns={laneTurns} ctx={ctx} path={childPath} />
            {laneVisible < lane.turns.length && laneShownOnce && <FillTail className="mx-2 mt-1 h-7" />}
          </div>
        </div>
      )}
    </div>
  );
}

export const SubagentLaneView = memo(SubagentLaneViewBase);

export function ParallelSubagentGroup({ lanes, ctx, path }: { lanes: SubagentLane[]; ctx: LaneCtx; path?: ReadonlySet<string> }) {
  const totalTurns = lanes.reduce((s, l) => s + l.turnCount, 0);
  const totalTokens = lanes.reduce((s, l) => s + l.totalTokens, 0);
  return (
    <div className="ml-1 min-w-0 space-y-1.5 rounded-lg border-l-2 border-orange-200/60 bg-foreground/[0.02] p-1.5 dark:border-orange-500/25 dark:bg-foreground/[0.04]">
      <div className="flex items-center gap-2 px-0.5">
        <span className="shrink-0 text-[10px] text-muted-foreground">⇄ {lanes.length} 并行子代理</span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {totalTurns}t{totalTokens > 0 ? ` · ${fmtTokens(totalTokens)}` : ""}
        </span>
      </div>
      <div className="flex flex-wrap items-start gap-1.5">
        {lanes.map(lane => {
          const isExpanded = ctx.expandedSubagents.has(lane.bridgeId);
          const isError = lane.status === "error";
          return (
            <div key={lane.bridgeId} className={cn("flex min-w-0 flex-col gap-1", isExpanded && "basis-full")}>
              <button
                type="button"
                className={cn(
                  "inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 self-start rounded-md border px-2 py-1 text-xs transition-colors",
                  isExpanded
                    ? "border-orange-300 bg-orange-50/60 dark:border-orange-500/50 dark:bg-orange-500/10"
                    : isError
                      ? "border-red-200 bg-red-50/40 hover:bg-red-50/70 dark:border-red-500/30 dark:bg-red-500/10"
                      : "border-foreground/[0.08] bg-background hover:bg-foreground/[0.05]",
                )}
                onClick={() => ctx.onToggleBridge(lane.bridgeId)}
              >
                <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground/60 transition-transform", isExpanded && "rotate-90")} />
                <Badge variant="orange" className="max-w-[160px] truncate text-[10px]">{lane.name}</Badge>
                {lane.background && <Badge variant="yellow" className="shrink-0 text-[10px]" title="后台异步派发：立即返回，完成后再通知父会话">bg</Badge>}
                {isError && <Badge variant="red" className="shrink-0 text-[10px]">error</Badge>}
                <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{lane.turnCount}t</span>
                {lane.latencyMs > 0 && <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{fmtLatency(lane.latencyMs)}</span>}
              </button>
              {isExpanded && <SubagentLaneView lane={lane} ctx={ctx} path={path} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 成员会话块：命令轮归组 / continuation 重排 / 泳道挂载（逻辑承旧） ──
// 导出复用：离线导出查看器的 Turns 面板 = 单会话块 + Player（同一排版语法）

// 泳道行显示对象（窄列截断 48 字符承旧）：在 processed 内预构——渲染期
// 逐行新建对象会打散 TurnRow 的 memo，换选就得全量重渲所有泳道行。
// 按源轮身份弱缓存：补拉链追加触发 processed 重算时，既有行 memo 命中，
// 只有新行真正渲染（派生只依赖单轮自身字段，缓存安全）
const laneDisplayCache = new WeakMap<TurnsBlockTurn, DisplayTurn>();
export function toLaneDisplayTurn(st: TurnsBlockTurn): DisplayTurn {
  let d = laneDisplayCache.get(st);
  if (!d) {
    const s = summarizeOutput(st.role, st.contentSummary, st.toolCalls);
    d = { ...st, displayRole: st.role, displayContent: s.content.substring(0, 48), displayKind: s.kind };
    laneDisplayCache.set(st, d);
  }
  return d;
}

// 普通行显示对象按源轮身份弱缓存（同 toLaneDisplayTurn 动机）：补拉追加
// 重算 processed 时既有行 memo 命中，只有新行真正渲染；派生只依赖单轮
// 自身字段，缓存安全。命令/续篇/压缩行走归组邻接逻辑（尾部分组会随后续
// 追加延伸），不缓存、每趟重建——此类行占比极小
const plainDisplayCache = new WeakMap<TurnsBlockTurn, DisplayTurn>();

function buildDisplayTurns(rootTurns: TurnsBlockTurn[]): DisplayTurn[] {
  const commandInfoMap = new Map<string, { display: string }>();
  let groupTexts: string[] = [];
  let leadId: string | null = null;
  for (const t of rootTurns) {
    const text = t.contentSummary ?? "";
    if (isCommandTurn(text) || isCommandTail(text)) {
      groupTexts.push(text);
      if (isCommandTurn(text)) leadId = t.turnId;
    } else {
      if (groupTexts.length > 0 && leadId) {
        commandInfoMap.set(leadId, { display: formatCommandDisplay(parseCommandTurns(groupTexts)) });
      }
      groupTexts = [];
      leadId = null;
    }
  }
  if (groupTexts.length > 0 && leadId) {
    commandInfoMap.set(leadId, { display: formatCommandDisplay(parseCommandTurns(groupTexts)) });
  }

  const enhanced = rootTurns
    .filter(t => {
      const text = t.contentSummary ?? "";
      return !isCommandTail(text);
    })
    .map((t): DisplayTurn => {
      const text = t.contentSummary ?? "";
      const displayRole = classifyDisplayRole(t) ?? t.role;
      if (displayRole === "compaction") {
        return { ...t, displayRole, displayContent: text || "/compact", displayKind: "text" };
      }
      if (displayRole === "command") {
        return { ...t, displayRole, displayContent: commandInfoMap.get(t.turnId)?.display ?? "/unknown", displayKind: "text" };
      }
      if (displayRole === "continuation") {
        if (isContinuationTurn(text)) {
          return { ...t, displayRole, displayContent: parseContinuationTurn(text).summaryLine ?? "Compact summary", displayKind: "text" };
        }
        const summaryLine = text.split("\n").find(l => l.trim()) ?? "Compact summary";
        return { ...t, displayRole, displayContent: summaryLine.substring(0, 120), displayKind: "text" };
      }
      let plain = plainDisplayCache.get(t);
      if (!plain) {
        const summary = summarizeOutput(t.role, text, t.toolCalls);
        plain = { ...t, displayRole, displayContent: summary.content, displayKind: summary.kind };
        plainDisplayCache.set(t, plain);
      }
      return plain;
    });
  // opencode 的 continuation 摘要 turnIndex 低于产生它的 /compact 命令——
  // 交换相邻对让命令领先其摘要（承旧时间线同款归一）
  const result = [...enhanced];
  for (let i = 0; i < result.length - 1; i++) {
    const cur = result[i];
    const next = result[i + 1];
    if (
      cur.displayRole === "continuation" &&
      next.displayRole === "command" &&
      (next.displayContent.includes("/compact") || next.displayContent === "compact")
    ) {
      [result[i], result[i + 1]] = [result[i + 1], result[i]];
      i++;
    }
  }
  return result;
}

/** 角色筛选缺省空集（未传入 = 不过滤；模块级常量保身份稳定，memo 比较
 *  不被每次渲染的新 Set 打散） */
const EMPTY_ROLE_FILTER: ReadonlySet<string> = new Set();

interface SessionBlockProps {
  session: TurnsNodeSession;
  state: MemberTurnsState;
  bridges: TurnsBridge[];
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  onLoadMore: (taskId: string) => void;
  /** 角色多选筛选（空集/缺省 = 全显）；身份变更是全块重渲的唯一触发 */
  roleFilter?: ReadonlySet<string>;
}

/** 就绪交换的 O(1) 关键：行表抽成 memo 子树——交换翻转（shownOnce）只改
 *  包装层 class 与卸载卡片，rows/laneCtx 等 props 身份不变，万行级协调整
 *  块跳过；填充增帧时只有新增片真正渲染 */
const RowsList = memo(function RowsList({ rows, laneCtx, filter, selectedTurnId, onSelectTurn }: {
  rows: Array<{ turn: DisplayTurn; lanes: SubagentLane[] }>;
  laneCtx: LaneCtx;
  filter: ReadonlySet<string>;
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
}) {
  return (
    <>
      {rows.map(({ turn, lanes }) => (
        <div key={turn.turnId} className="turn-row-cv min-w-0 space-y-1">
          {(filter.size === 0 || filter.has(turn.displayRole)) && (
            <TurnRow turn={turn} selected={selectedTurnId === turn.turnId} onSelect={onSelectTurn} />
          )}
          {lanes.length > 0 && (
            <div className="ml-3 min-w-0">
              {lanes.length === 1
                ? <SubagentLaneView lane={lanes[0]} ctx={laneCtx} />
                : <ParallelSubagentGroup lanes={lanes} ctx={laneCtx} />}
            </div>
          )}
        </div>
      ))}
    </>
  );
});

/** 泳道展开行同构（就绪交换 O(1)，同 RowsList 动机） */
const LaneRowsList = memo(function LaneRowsList({ turns, ctx, path }: {
  turns: DisplayTurn[];
  ctx: LaneCtx;
  path: ReadonlySet<string>;
}) {
  const filter = ctx.roleFilter ?? EMPTY_ROLE_FILTER;
  return (
    <>
      {turns.map(st => {
        const rowVisible = filter.size === 0 || filter.has(st.displayRole);
        const lns = ctx.subagentBlocksByTurnId.get(st.turnId);
        const visible = lns ? lns.filter(l => laneMatchesFilter(filter, l)) : [];
        if (!rowVisible && visible.length === 0) return null;
        return (
          <div key={st.turnId} className="turn-row-cv space-y-px">
            {rowVisible && <TurnRow turn={st} selected={ctx.selectedTurnId === st.turnId} onSelect={ctx.onSelectTurn} />}
            {visible.length > 0 && (
              <div className="ml-3 min-w-0 border-l border-orange-200/70 pl-2 dark:border-orange-500/30">
                {visible.length === 1
                  ? <SubagentLaneView lane={visible[0]} ctx={ctx} path={path} />
                  : <ParallelSubagentGroup lanes={visible} ctx={ctx} path={path} />}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
});

/** 会话块 memo 比较：数据/回调不变时，仅当选中轮「进出本会话」才需要重渲
 *  （行高亮与泳道自动展开都只跟随本会话的轮）——换选高频路径上无关会话
 *  整块跳过。60 节点 run、多会话上千行同时挂载时，一次全量重渲是走查/
 *  换选卡顿的主源 */
export function sessionBlockPropsEqual(a: SessionBlockProps, b: SessionBlockProps): boolean {
  if (
    a.session !== b.session ||
    a.state !== b.state ||
    a.bridges !== b.bridges ||
    a.onSelectTurn !== b.onSelectTurn ||
    a.onLoadMore !== b.onLoadMore ||
    (a.roleFilter ?? EMPTY_ROLE_FILTER) !== (b.roleFilter ?? EMPTY_ROLE_FILTER)
  ) {
    return false;
  }
  if (a.selectedTurnId === b.selectedTurnId) return true;
  const turns = a.state.turns;
  return [a.selectedTurnId, b.selectedTurnId].every(id => id == null || !turns.some(t => t.turnId === id));
}

function SessionBlockBase({ session, state, bridges, selectedTurnId, onSelectTurn, onLoadMore, roleFilter }: SessionBlockProps) {
  const filter = roleFilter ?? EMPTY_ROLE_FILTER;
  // 首次装载闩：两段式拉齐（首页 → 剩余分块续拉）期间不展示半量轮次——
  // 大 run 渐进追加是行突现与重渲抖动主源（命令归组/泳道配对随每批全量重算，
  // 且每次都全量重挂行）；装载完成一次性入场。此后再在途（手动补拉/纪元刷新）
  // 保持已读行，仅头部指示（渲染期 prev 值比较形态，同换选快照门）
  const [everShown, setEverShown] = useState(false);
  const gating = state.loading && !everShown && state.turns.length < state.total;
  if (!gating && !everShown) setEverShown(true);
  const hasMore = state.turns.length < state.total;

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 px-1 pb-1">
        <Badge variant={session.role === "execute" ? "blue" : "purple"} className="shrink-0 text-[10px]">
          {session.role === "execute" ? "执行" : "验收"}
        </Badge>
        <span className="min-w-0 truncate text-xs font-medium text-foreground/80" title={session.taskId}>
          {session.label ?? session.taskId}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {state.loading
            ? `载入中${state.total > 0 ? ` · ${state.turns.length}/${state.total}` : ""}`
            : `${state.turns.length}/${state.total} 轮`}
        </span>
        <span className="flex-1" />
        {state.loading && <Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground/60" />}
        {hasMore && !state.loading && (
          <button
            type="button"
            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors select-none hover:bg-foreground/[0.05] hover:text-foreground"
            onClick={() => onLoadMore(session.taskId)}
          >
            加载更多
          </button>
        )}
      </div>
      {gating ? (
        <BreathCards count={6} compact className="px-1 py-2" />
      ) : (
        <SessionRows
          state={state}
          bridges={bridges}
          selectedTurnId={selectedTurnId}
          onSelectTurn={onSelectTurn}
          filter={filter}
        />
      )}
    </div>
  );
}

function SessionRows({ state, bridges, selectedTurnId, onSelectTurn, filter }: {
  state: MemberTurnsState;
  bridges: TurnsBridge[];
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  filter: ReadonlySet<string>;
}) {
  const [expandedSubagents, setExpandedSubagents] = useState<Set<string>>(new Set());
  /** 用户点过的泳道（点过即完全由手动集控制；未点过的跟随选中轮自动展开） */
  const [toggledLanes, setToggledLanes] = useState<Set<string>>(new Set());

  const processed = useMemo(() => {
    const sorted = [...state.turns].sort((a, b) => a.turnIndex - b.turnIndex);
    const rootTurns = sorted.filter(t => !t.isSubagent);
    const subTurnsBySession = new Map<string, TurnsBlockTurn[]>();
    for (const t of sorted) {
      if (t.isSubagent && t.subagentSessionId) {
        const arr = subTurnsBySession.get(t.subagentSessionId) ?? [];
        arr.push(t);
        subTurnsBySession.set(t.subagentSessionId, arr);
      }
    }
    const turnIds = new Set(sorted.map(t => t.turnId));
    const turnById = new Map(sorted.map(t => [t.turnId, t] as const));
    const bridgesByTurnId = new Map<string, TurnsBridge[]>();
    for (const b of bridges) {
      if (!b.dispatchTurnId || !turnIds.has(b.dispatchTurnId)) continue;
      // 自引用桥（派发端 turn 属于桥指向的子会话自身）永不锚定主链，且其 lane
      // 会嵌进该子会话展开区形成递归——建 lane 前剔除，该子会话由兜底接管
      const dispTurn = turnById.get(b.dispatchTurnId);
      if (dispTurn?.isSubagent && dispTurn.subagentSessionId === b.subagentSessionId) continue;
      const arr = bridgesByTurnId.get(b.dispatchTurnId) ?? [];
      arr.push(b);
      bridgesByTurnId.set(b.dispatchTurnId, arr);
    }
    const subagentNumbers = buildSubagentNumbers(sorted);
    // 复用会话（首发+返工同 sid）的 lane 窗口配对——与 ingest/bridges 读侧同
    // 口径：每次派发的 lane 只展示自己窗口 [dispatch_i, dispatch_{i+1}) 内的
    // 轮次，两窗不再互相包含（不配对则两根 lane 都带全会话轮次）
    const sidDispatchTimes = new Map<string, number[]>();
    for (const b of bridges) {
      if (!b.subagentSessionId || !b.dispatchTimestamp) continue;
      const ms = new Date(b.dispatchTimestamp).getTime();
      if (!Number.isFinite(ms)) continue;
      const arr = sidDispatchTimes.get(b.subagentSessionId) ?? [];
      arr.push(ms);
      sidDispatchTimes.set(b.subagentSessionId, arr);
    }
    for (const arr of sidDispatchTimes.values()) arr.sort((a, b) => a - b);
    const windowedLaneTurns = (sid: string | null, dispatchTimestamp: string | null | undefined, all: TurnsBlockTurn[]): TurnsBlockTurn[] => {
      if (!sid || !dispatchTimestamp || all.length === 0) return all;
      const dMs = new Date(dispatchTimestamp).getTime();
      if (!Number.isFinite(dMs)) return all;
      const sidT = sidDispatchTimes.get(sid) ?? [];
      const next = sidT.find(t => t > dMs) ?? null;
      const tsOf = (t: TurnsBlockTurn) => (t.createdAt ? new Date(t.createdAt).getTime() : NaN);
      const after = all.filter(t => { const ts = tsOf(t); return Number.isFinite(ts) && ts >= dMs; });
      const win = next !== null ? after.filter(t => tsOf(t) < next) : after;
      if (win.length > 0) return win;
      if (next !== null) {
        const bounded = all.filter(t => { const ts = tsOf(t); return Number.isFinite(ts) && ts < next; });
        return bounded; // 空则置空（pending 口径），不回落整会话
      }
      return after.length > 0 ? after : all;
    };
    const subagentBlocksByTurnId = new Map<string, SubagentLane[]>();
    for (const [turnId, bs] of bridgesByTurnId) {
      const lanes: SubagentLane[] = bs.map(b => {
        const sid = b.subagentSessionId;
        const sturns = sid
          ? windowedLaneTurns(sid, b.dispatchTimestamp, subTurnsBySession.get(sid) ?? [])
          : [];
        const laneNum = sid ? subagentNumbers.get(sid) : undefined;
        return {
          bridgeId: b.bridgeId,
          sessionId: sid,
          name: (b.agentName ?? b.subagentName ?? b.subagentType ?? "subagent") + (laneNum !== undefined ? ` #${laneNum}` : ""),
          type: b.subagentType,
          summary: b.dispatchContent,
          turns: sturns.map(toLaneDisplayTurn),
          status: b.status,
          totalTokens: sturns.reduce((s, t) => s + t.totalTokens, 0) + b.subagentTokens,
          latencyMs: b.subagentLatencyMs,
          turnCount: sturns.length,
          background: b.dispatchBackground === true || undefined,
        };
      });
      subagentBlocksByTurnId.set(turnId, lanes);
    }

    // 兜底 lane（无桥子代理可见性）：桥驱动 lane 覆盖不到的子代理 turns（上游
    // meta 登记为空 / 异步派发回执无子会话 id → 建桥三路全断）此前在轮次列表
    // 整组不可见。按启动时刻就近挂到主链轮下，slate「未关联」徽标区分于桥
    // 驱动的精确 lane。「有桥」≠「有泳道」：只有锚到主链 turn 的桥才真正渲染
    // （自锚桥锚不到任何渲染位）；锚定按可传递闭包——根桥锚定的 sid 已安置，
    // 派发 turn 落在已安置 sid 的 turns 里（嵌套派发）的桥同样安置
    const rootTurnIds = new Set(rootTurns.map(t => t.turnId));
    const bridgedSids = new Set<string>();
    let anchorChanged = true;
    while (anchorChanged) {
      anchorChanged = false;
      for (const b of bridges) {
        if (!b.subagentSessionId || !b.dispatchTurnId || bridgedSids.has(b.subagentSessionId)) continue;
        const dispTurn = turnById.get(b.dispatchTurnId);
        const anchored = rootTurnIds.has(b.dispatchTurnId)
          || (!!dispTurn?.subagentSessionId && bridgedSids.has(dispTurn.subagentSessionId));
        if (anchored) {
          bridgedSids.add(b.subagentSessionId);
          anchorChanged = true;
        }
      }
    }
    const orphanBySid = new Map<string, TurnsBlockTurn[]>();
    for (const [sid, sturns] of subTurnsBySession) {
      if (bridgedSids.has(sid)) continue;
      orphanBySid.set(sid, sturns);
    }
    for (const [sid, sturns] of orphanBySid) {
      const sortedSub = [...sturns].sort((a, b) => a.turnIndex - b.turnIndex);
      const first = sortedSub[0];
      // 锚定优先按时间：异步子代理的 turns 在文件序上整体后置，turnIndex 就近
      // 会把所有孤儿挂到主链末轮堆成一坨；按 createdAt 找「启动时刻主链走到
      // 哪」才是它真实的运行位置。无时间退化回 turnIndex 就近
      const t0 = first.createdAt ? new Date(first.createdAt).getTime() : NaN;
      let anchor: TurnsBlockTurn | undefined;
      if (Number.isFinite(t0)) {
        for (const rt of rootTurns) {
          const rtMs = rt.createdAt ? new Date(rt.createdAt).getTime() : NaN;
          if (Number.isFinite(rtMs) && rtMs <= t0) anchor = rt;
        }
      }
      if (!anchor) anchor = [...rootTurns].filter(rt => rt.turnIndex < first.turnIndex).pop() ?? rootTurns[0];
      if (!anchor) continue;
      const laneNum = subagentNumbers.get(sid);
      const hasError = sortedSub.some(t => t.finishReason === "error" || t.finishReason === "failed");
      const times = sortedSub
        .map(t => (t.createdAt ? new Date(t.createdAt).getTime() : NaN))
        .filter(Number.isFinite);
      const lane: SubagentLane = {
        bridgeId: `orphan-${sid}`,
        sessionId: sid,
        name: (first.subagentName ?? "未关联子代理") + (laneNum !== undefined ? ` #${laneNum}` : ""),
        type: null,
        summary: null,
        turns: sortedSub.map(toLaneDisplayTurn),
        status: hasError ? "error" : "completed",
        totalTokens: sortedSub.reduce((s, t) => s + t.totalTokens, 0),
        latencyMs: times.length >= 2 ? Math.max(...times) - Math.min(...times) : 0,
        turnCount: sortedSub.length,
        unlinked: true,
      };
      const arr = subagentBlocksByTurnId.get(anchor.turnId) ?? [];
      arr.push(lane);
      subagentBlocksByTurnId.set(anchor.turnId, arr);
    }
    return { displayRootTurns: buildDisplayTurns(rootTurns), subagentBlocksByTurnId };
  }, [state.turns, bridges]);

  // 深链/跨节点选中的是 subagent 轮时，沿桥链定位全部祖先泳道（承旧语义）——
  // 展开是渲染期派生：未点过的泳道跟随选中自动展开，点过的由手动集控制
  const autoExpandedLanes = useMemo(() => {
    if (!selectedTurnId) return new Set<string>();
    const subTurn = state.turns.find(t => t.turnId === selectedTurnId);
    if (!subTurn?.isSubagent || !subTurn.subagentSessionId) return new Set<string>();
    const toExpand = new Set<string>();
    const seen = new Set<string | null>();
    let curSid: string | null = subTurn.subagentSessionId;
    while (curSid && !seen.has(curSid)) {
      seen.add(curSid);
      const bridge = bridges.find(b => {
        if (b.subagentSessionId !== curSid) return false;
        // 自引用桥的 lane 已在建 lane 处剔除（其 sid 走孤儿兜底），不能作为
        // 展开/上走目标
        const dt = b.dispatchTurnId ? state.turns.find(t => t.turnId === b.dispatchTurnId) : undefined;
        return !(dt?.isSubagent && dt.subagentSessionId === curSid);
      });
      if (!bridge) {
        // 无桥（或仅剩自引用这类无效桥）：目标 turn 由兜底 lane 承载，展开
        // 孤儿 lane 即可见，无需再向上展开祖先链
        if (state.turns.some(t => t.isSubagent && t.subagentSessionId === curSid)) toExpand.add(`orphan-${curSid}`);
        break;
      }
      toExpand.add(bridge.bridgeId);
      if (!bridge.dispatchTurnId) break;
      const dispTurn = state.turns.find(t => t.turnId === bridge.dispatchTurnId);
      curSid = dispTurn?.isSubagent ? (dispTurn.subagentSessionId ?? null) : null;
    }
    return toExpand;
  }, [selectedTurnId, state.turns, bridges]);

  const effectiveExpandedLanes = useMemo(() => {
    if (!autoExpandedLanes.size) return expandedSubagents;
    const next = new Set(expandedSubagents);
    for (const id of autoExpandedLanes) {
      if (!toggledLanes.has(id)) next.add(id);
    }
    return next;
  }, [expandedSubagents, toggledLanes, autoExpandedLanes]);

  const onToggleBridge = useCallback((bridgeId: string) => {
    setToggledLanes(prev => (prev.has(bridgeId) ? prev : new Set(prev).add(bridgeId)));
    setExpandedSubagents(prev => {
      const next = new Set(prev);
      if (next.has(bridgeId)) next.delete(bridgeId);
      else next.add(bridgeId);
      return next;
    });
  }, []);

  // 泳道上下文身份稳定（useMemo）：分帧填充每帧重渲时已挂载泳道整块 memo
  // 跳过，只有新增片真正渲染——帧成本恒定，不随已挂载量增长
  const laneCtx = useMemo<LaneCtx>(() => ({
    subagentBlocksByTurnId: processed.subagentBlocksByTurnId,
    expandedSubagents: effectiveExpandedLanes,
    onToggleBridge,
    selectedTurnId,
    onSelectTurn,
    roleFilter: filter,
  }), [processed, effectiveExpandedLanes, onToggleBridge, selectedTurnId, onSelectTurn, filter]);

  // 渲染期过滤（不进 processed memo）：TurnRow 的 memo 以 turn 对象身份为
  // 前提——过滤只产出新数组、复用既有显示对象，筛选切换不重算命令归组/
  // 泳道窗口配对，未受影响的行整块跳过重渲。行与泳道分别判可见：派发行
  // 被滤掉但其泳道有匹配轮时，泳道仍留在原时间位（子代理的匹配轮也是
  // 匹配轮）；两者皆无才跳过该挂点
  const visibleRoots = useMemo(() => processed.displayRootTurns
    .map(turn => ({
      turn,
      lanes: (processed.subagentBlocksByTurnId.get(turn.turnId) ?? [])
        .filter(l => filter.size === 0 || laneMatchesFilter(filter, l)),
    }))
    .filter(({ turn, lanes }) => filter.size === 0 || filter.has(turn.displayRole) || lanes.length > 0),
    [processed, filter]);
  const visibleCount = useProgressiveCount(visibleRoots.length, true);
  const filling = visibleCount < visibleRoots.length;
  const shownOnce = useRevealLatch(!filling);
  const renderedRoots = useMemo(() => visibleRoots.slice(0, visibleCount), [visibleRoots, visibleCount]);

  const anyRootVisible = filter.size === 0 || processed.displayRootTurns.some(t => filter.has(t.displayRole));
  const anyLaneVisible = filter.size === 0
    || [...processed.subagentBlocksByTurnId.values()].some(ls => ls.some(l => laneMatchesFilter(filter, l)));

  return (
    <div className="min-w-0">
      {/* 隐藏填充 + 就绪交换：填充期呼吸卡在场、行进隐藏容器分帧落位，填
          满一次性 fade-in 亮相——展示时刻全量已挂载，交换只有 class 翻转
          （content-visibility 只布局可视区）；此后增量续填不再回隐藏 */}
      {!shownOnce && <BreathCards count={6} compact className="px-1 py-2" />}
      <div
        className={cn("min-w-0", shownOnce ? "animate-in fade-in duration-300" : "hidden")}
        data-fill-hidden={shownOnce ? undefined : ""}
      >
      {/* 离屏会话块跳过布局与绘制（content-visibility），首次渲染后记住真实
          高度——多节点大 run 长列表的滚动帧预算主要花在这里；揭示滚动时经
          .turn-list-revealing 临时展平为真实布局（见 globals.css） */}
      <div className="turn-rows space-y-px [contain-intrinsic-size:auto_600px] [content-visibility:auto]">
        <RowsList
          rows={renderedRoots}
          laneCtx={laneCtx}
          filter={filter}
          selectedTurnId={selectedTurnId}
          onSelectTurn={onSelectTurn}
        />
        {filling && shownOnce && <FillTail className="mx-1 mt-1.5 h-8" />}
        {!state.loading && state.turns.length === 0 && (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">该成员无已入库轮次</p>
        )}
        {filter.size > 0 && !state.loading && !anyRootVisible && !anyLaneVisible && processed.displayRootTurns.length > 0 && (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">当前角色筛选下无匹配轮次</p>
        )}
      </div>
      </div>
    </div>
  );
}

export const SessionBlock = memo(SessionBlockBase, sessionBlockPropsEqual);

// ── 节点（节点实例）与代分组 ──────────────────────────────────────

function NodeBody({ node, expandedSessions, memberData, bridges, selectedTurnId, onSelectTurn, onLoadMore, roleFilter }: {
  node: TurnsNode;
  memberData: Map<string, MemberTurnsState>;
  bridges: TurnsBridge[];
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  onLoadMore: (taskId: string) => void;
  expandedSessions: Set<string>;
  roleFilter?: ReadonlySet<string>;
}) {
  if (node.executionState === "not_run") {
    return <p className="px-3 py-3 text-xs text-muted-foreground">本代未运行</p>;
  }
  if (node.executionState === "carried" && node.sessions.length === 0) {
    return (
      <p className="px-3 py-3 text-xs text-muted-foreground">
        沿第 {node.carriedFromGeneration} 代结果，内容见对应代节点
      </p>
    );
  }
  if (node.sessions.length === 0) {
    // bash/process 成员或未导入会话：尝试输出 + 验收结论仍可读
    return (
      <div className="space-y-2 px-2 py-1.5">
        {node.attempts.map(a => (
          <div key={a.ordinal} className="rounded-lg bg-foreground/[0.03] px-2.5 py-2">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground/80">尝试 {a.ordinal}</span>
              <span className="tabular-nums">{a.status}</span>
              <span>验收 {a.verification.status}</span>
            </div>
            {a.outputText && (
              <ExpandableText clampPx={200} className="mt-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
                {a.outputText}
              </ExpandableText>
            )}
          </div>
        ))}
      </div>
    );
  }
  const multiAttempt = node.attempts.length > 1 || node.attempts.some(a => a.execute && a.verify);
  return (
    <div className="min-w-0 space-y-3 px-1 pb-2">
      {node.attempts.map(a => {
        const attemptSessions = [a.execute, a.verify].filter((s): s is TurnsNodeSession => s != null);
        if (attemptSessions.length === 0) return null;
        return (
          <div key={a.ordinal} className="space-y-1.5">
            {multiAttempt && (
              <div className="flex items-center gap-2 px-1 text-[10px] text-muted-foreground">
                <span className="font-medium text-foreground/70">尝试 {a.ordinal}</span>
                <span className={cn("size-1.5 rounded-full", a.status === "passed" ? "bg-emerald-500" : a.status === "failed" ? "bg-red-500" : a.status === "running" ? "bg-amber-500 animate-pulse" : "bg-foreground/25")} />
                <span className="tabular-nums">{a.status}</span>
                <span>· 验收 {a.verification.status}</span>
                {a.verification.reason && <span className="min-w-0 truncate" title={a.verification.reason}>· {a.verification.reason}</span>}
              </div>
            )}
            {attemptSessions.map(s => {
              const st = memberData.get(s.taskId);
              return (
                <div key={s.taskId} className={cn(expandedSessions.has(s.taskId) ? "" : "opacity-70", "min-w-0")}>
                  {st ? (
                    <SessionBlock
                      session={s}
                      state={st}
                      bridges={bridges}
                      selectedTurnId={selectedTurnId}
                      onSelectTurn={onSelectTurn}
                      onLoadMore={onLoadMore}
                      roleFilter={roleFilter}
                    />
                  ) : (
                    <BreathCards count={3} compact className="py-1" />
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function RunTurnsNodes({ nodes, bands, rollbacks, expanded, onToggleNode, memberData, bridges, selectedTurnId, onSelectTurn, onLoadMore, roleFilter }: {
  nodes: TurnsNode[];
  bands: Array<{ generation: number; label: string }>;
  rollbacks: Array<{ ordinal: number; note: string | null; toGeneration: number }>;
  expanded: Set<string>;
  onToggleNode: (key: string) => void;
  memberData: Map<string, MemberTurnsState>;
  bridges: TurnsBridge[];
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  onLoadMore: (taskId: string) => void;
  /** 角色多选筛选（空集/缺省 = 全显），由 RunTurnsTab 左列筛选条驱动 */
  roleFilter?: ReadonlySet<string>;
}) {
  const expandedSessions = useMemo(() => {
    const s = new Set<string>();
    for (const ch of nodes) if (expanded.has(ch.key)) for (const sess of ch.sessions) s.add(sess.taskId);
    return s;
  }, [nodes, expanded]);

  // 主图节点按代分组（子图节点跟在生成器节点后，不另起代头）
  const groups: Array<{ generation: number; label: string; nodes: TurnsNode[] }> = [];
  for (const ch of nodes) {
    if (ch.depth > 0) {
      const g = groups[groups.length - 1];
      if (g) g.nodes.push(ch);
      continue;
    }
    const band = bands.find(b => b.generation === ch.generation);
    let g = groups.find(x => x.generation === ch.generation);
    if (!g) {
      g = { generation: ch.generation, label: band?.label ?? `代 ${ch.generation}`, nodes: [] };
      groups.push(g);
    }
    g.nodes.push(ch);
  }

  return (
    <div className="space-y-4 px-3 py-3">
      {groups.map(g => {
        const rollback = rollbacks.find(r => r.toGeneration === g.generation);
        return (
          <section key={g.generation} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">{g.label}</span>
              <span className="h-px flex-1 bg-foreground/[0.07]" />
              {rollback && (
                <span className="truncate text-[10px] text-muted-foreground/80" title={rollback.note ?? undefined}>
                  ↺ 回滚{rollback.note ? ` · ${rollback.note}` : ""}
                </span>
              )}
            </div>
            <div className="space-y-1.5">
              {g.nodes.map(ch => {
                const isOpen = expanded.has(ch.key);
                const totalTurns = ch.sessions.reduce((s, x) => s + x.ref.turns, 0);
                const totalTokens = ch.sessions.reduce((s, x) => s + x.ref.totalTokens, 0);
                return (
                  <div
                    key={ch.key}
                    data-node={ch.key}
                    className={cn(
                      "min-w-0 rounded-xl border bg-card transition-colors",
                      isOpen ? "border-foreground/[0.1]" : "border-transparent hover:border-foreground/[0.07]",
                    )}
                    style={ch.depth > 0 ? { marginLeft: ch.depth * 14 } : undefined}
                  >
                    <button
                      type="button"
                      className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-left"
                      onClick={() => onToggleNode(ch.key)}
                    >
                      <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground/50 transition-transform", isOpen && "rotate-90")} />
                      <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[ch.status])} aria-hidden />
                      <span className="shrink-0 text-[13px] font-semibold text-foreground/90">{ch.label}</span>
                      {ch.taskType === "bash" && <Badge variant="gray" className="shrink-0 text-[9px]">bash</Badge>}
                      {ch.taskType === "generator" && <Badge variant="gray" className="shrink-0 text-[9px]">子图</Badge>}
                      {ch.taskType === "workflow" && <Badge variant="gray" className="shrink-0 text-[9px]">子图节点</Badge>}
                      {ch.executionState === "carried" && (
                        <Badge variant="slate" className="shrink-0 text-[9px]" title={`沿第 ${ch.carriedFromGeneration} 代结果`}>沿上代</Badge>
                      )}
                      {ch.attempts.length > 1 && (
                        <Badge variant="outline" className="shrink-0 text-[9px]">{ch.attempts.length} 次尝试</Badge>
                      )}
                      <span className="flex-1" />
                      {ch.sessions.length > 0 && (
                        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                          {totalTurns}t{totalTokens > 0 ? ` · ${fmtTokens(totalTokens)}` : ""}
                        </span>
                      )}
                    </button>
                    {isOpen && (
                      <div className="animate-in fade-in slide-in-from-top-1 duration-200 border-t border-foreground/[0.06] px-2 pt-2">
                        <NodeBody
                          node={ch}
                          expandedSessions={expandedSessions}
                          memberData={memberData}
                          bridges={bridges}
                          selectedTurnId={selectedTurnId}
                          onSelectTurn={onSelectTurn}
                          onLoadMore={onLoadMore}
                          roleFilter={roleFilter}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
