"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.
// Run Overview tab（统一，run-first）：run 是基本单元——一律 run 级端点取数
// （executions / turns / skills 全部不带 member，跨成员混切），solo run =
// 单成员退化，bundle run = N 成员常态，零 kind 分支的数据路径。
// 面板复用 OverviewPanels（单元总览单一源：总览头[身份+Σ大瓦片]/Skills/
// Tool Calls/Error Turns，与离线导出 viewer 同源）；时间维度（Agent 泳道）
// 归 Perf 页执行时间线，Overview 不再承载；bundle 专属的结构卡（代际/回滚/
// 子图）+ 导入信息按 run-graph 存在性附加（solo run 无图结构，视图与
// session 页对齐）。
// Σ指标：memberStats（服务端聚合）+ executions Σ（llm/tool/skill/subagent）
// + totalErrors（页级）；llmActiveMs 客户端按 assistant 轮在途窗口并集
// （computeLlmActiveMs，与 session 详情同口径）。
import { useEffect, useMemo, useState } from "react";
import {
  OverviewPanels,
  type OverviewIdentity,
  type OverviewMetrics,
  type OverviewOpenTurnsTarget,
} from "@/components/observe/OverviewPanels";
import { prefetchRunOverview, type RunOverviewPanelData } from "@/lib/run/overview-data";
import { runMemberRowsOf } from "@/lib/run/member-rows";
import type { RunViewModel } from "@/lib/run/view-model";
import type { RunMemberIdentity, RunMemberStats } from "@/lib/collection/types";
import { bandLabel } from "@/components/run/run-theme";
import { computeLlmActiveMs } from "@/lib/session-duration";
import { useRunDataEpoch } from "@/lib/run/data-epoch";
import { summarizeToolCallErrors } from "@/lib/tool-call-errors";
import type { RunTimeSummary } from "@/lib/observe/run-time-summary";

/** run 展示短标题：prompt 自动命名的长文按句读截短（先句子边界、再逗号
 *  分句、超长硬截 32 字），全文与 runId 进悬停 */
function shortRunTitle(name: string | null, runId: string): string {
  if (!name) return runId;
  const sentence = name.split(/[。\n；;\r]/)[0].trim();
  const clause = sentence.split(/[，,]/)[0].trim();
  const best = [sentence, clause].find(c => c.length > 0 && c.length <= 32);
  if (best) return best;
  return sentence.slice(0, 32).trimEnd() + "…";
}

export interface RunOverviewTabProps {
  runId: string;
  run: {
    runId: string;
    kind?: "run" | "solo";
    name: string | null;
    status: string;
    exportDataComplete?: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    import: {
      importedAt: string;
      sourceDir: string;
      sessions: { total: number; imported: number; existing: number; missingFile: number; failed: number };
      warnings: string[];
    } | null;
  };
  viewModel: RunViewModel;
  memberStats: RunMemberStats | null;
  /** Run 级统一时间摘要（与 Perf 共用） */
  timeSummary?: RunTimeSummary | null;
  totalErrors: number | null;
  /** 成员身份名册（run 详情端点）：Tool/proxy 徽标逐成员判定（混布可见） */
  members: RunMemberIdentity[];
  /** Σ成员代码统计（run 详情端点；无成员会话时 null） */
  codeStats: { additions: number; deletions: number; files: number } | null;
  onOpenTurns: (target: OverviewOpenTurnsTarget) => void;
  /** 仅分派子代理排除提示 → Skills 页（页面侧 navigate） */
  onOpenSkills?: () => void;
}

export function RunOverviewTab({ runId, run, viewModel, memberStats, timeSummary, totalErrors, members, codeStats, onOpenTurns, onOpenSkills }: RunOverviewTabProps) {
  // 面板数据：页面挂载瞬间已由 page 预取（五端点全并行，见 overview-data），
  // 此处消费缓存 promise——通常 tab 挂载时数据已就绪或已在途；数据纪元变化
  // 消费 reloadRun 换新的 fresh promise（原地重取，tab 不重挂）。pending 驱动
  // 骨架屏（不再渲染空态误导），失败保持总览头（服务端聚合指标照常展示）
  const [panel, setPanel] = useState<RunOverviewPanelData | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const dataEpoch = useRunDataEpoch();
  useEffect(() => {
    let cancelled = false;
    prefetchRunOverview(runId)
      .then(d => { if (!cancelled) { setPanel(d); setPanelError(null) } })
      .catch(() => { if (!cancelled) setPanelError("run 总览加载失败") });
    return () => { cancelled = true };
  }, [runId, dataEpoch]);
  const pending = panel == null && panelError == null;

  const rows = useMemo(() => runMemberRowsOf(viewModel), [viewModel]);
  // Σ指标用 executions 聚合（llm/tool 调用数）：collector member 归因在此无关
  const agents = useMemo(() => panel?.agents ?? [], [panel])
  const turns = useMemo(() => panel?.turns ?? [], [panel])

  const identity = useMemo<OverviewIdentity>(() => {
    const frameworks = new Set(members.map(m => m.framework));
    const single = members.length > 0 && frameworks.size === 1 ? members[0] : null;
    // 单成员（solo）模型用会话行原始全名（与 session 页元信息一致）；多成员用
    // memberStats 展示口径（去 provider 前缀、同名合并计数）
    const model = rows.length === 1 ? rows[0].model : memberStats?.models[0]?.model ?? null;
    return {
      framework: single?.framework ?? null,
      frameworkVersion: single?.version ?? null,
      memberCount: members.length || memberStats?.joinedCount || 0,
      model,
      codeStats: codeStats,
      startTime: timeSummary?.start ?? memberStats?.earliestStart ?? run.startedAt ?? null,
      endTime: timeSummary?.end ?? memberStats?.latestEnd ?? run.finishedAt ?? null,
      // bundle 取导入源目录；solo（无导入清单）取成员会话行源路径
      sourcePath: run.import?.sourceDir ?? (rows.length === 1 ? rows[0].sourcePath : null),
      run: {
        title: shortRunTitle(run.name, run.runId),
        titleHint: `${run.name ?? run.runId}\n${run.runId}`,
        kindLabel: run.kind === "solo" ? "会话" : "工作流",
        kindVariant: run.kind === "solo" ? "blue" as const : "purple" as const,
        incomplete: run.exportDataComplete === false,
        runId: run.runId,
      },
    };
  }, [members, memberStats, timeSummary, rows, codeStats, run]);

  const metrics = useMemo<OverviewMetrics>(() => {
    const llmActiveMs = turns.length > 0
      ? computeLlmActiveMs(turns
          .filter(t => t.role === "assistant")
          .map(t => ({
            createdAt_ts: t.createdAt ? new Date(t.createdAt) : null,
            completedAt: t.completedAt ? new Date(t.completedAt) : null,
            latencyMs: t.latencyMs ?? 0,
          })))
      : 0;
    const clientErrorCount = totalErrors ?? turns.reduce(
      (sum, t) => sum + (t.errorDigest?.total ?? summarizeToolCallErrors(t.toolCalls, t.skillEvents, t.finishReason).total), 0);
    return {
      totalTokens: memberStats?.totalTokens ?? 0,
      totalCost: memberStats?.totalCost ?? 0,
      wallMs: timeSummary?.wallMs ?? memberStats?.totalDurationMs ?? null,
      activeMs: timeSummary?.activeMs ?? memberStats?.totalActiveMs ?? null,
      llmActiveMs: timeSummary?.llmActiveMs ?? llmActiveMs,
      llmCallCount: agents.reduce((sum, a) => sum + (a.llmCallCount ?? 0), 0),
      toolCallCount: agents.reduce((sum, a) => sum + (a.toolCallCount ?? 0), 0),
      subagentCount: panel?.subagentCount ?? 0,
      errorCount: clientErrorCount,
      totalTurns: memberStats?.totalTurns ?? null,
    };
  }, [turns, totalErrors, memberStats, timeSummary, agents, panel]);

  // run-graph 专属区块（结构卡/导入信息）：solo run 是无主会话合成的
  // 单例包装，没有图结构与导入清单——视图与 session 页对齐；bundle 常态全量
  const isBundle = run.kind !== "solo";
  const s = run.import?.sessions;
  const missing = s ? Math.max(0, s.total - (memberStats?.joinedCount ?? 0)) : null;

  return (
    <div className="flex flex-col gap-4 overflow-y-auto rounded-2xl bg-muted/30 p-4">
      {panelError ? (
        <div className="rounded-xl bg-red-500/[0.08] px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {panelError}——指标卡仍按已聚合数据展示，列表/轮次面板可能不完整。
        </div>
      ) : null}
      {missing != null && missing > 0 ? (
        <p className="px-1 text-[11px] text-muted-foreground">
          {missing} 个引用会话未入库（未导入 / 缺文件 / 失败）——其指标不计入汇总。
        </p>
      ) : null}
      <OverviewPanels
        identity={identity}
        metrics={metrics}
        turns={turns}
        skills={panel?.skills ?? []}
        pending={pending}
        onOpenTurns={onOpenTurns}
        onOpenSkills={onOpenSkills}
      />
      {isBundle ? (
        <>
          {/* 结构卡：代际 / 回滚 / 子图（Graph tab 的概览投影）——分组节
              样式：小写间距标题 + 药丸行，逐项延迟入场（fill-mode-backwards
              保住延迟期的初始透明） */}
          <section className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-backwards delay-200">
            <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">执行结构</h2>
            <div className="flex flex-wrap gap-1.5">
              {viewModel.generations.map(g => (
                <span
                  key={g}
                  className="inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.04] px-2.5 py-1 text-[11px] leading-4 text-muted-foreground"
                >
                  {g > 0 ? <span className="size-1.5 rounded-full bg-red-500" aria-hidden /> : null}
                  {bandLabel(g)}
                </span>
              ))}
              {viewModel.views.length - 1 > 0 ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.04] px-2.5 py-1 text-[11px] leading-4 text-muted-foreground">
                  {viewModel.views.length - 1} 个子图
                </span>
              ) : null}
            </div>
            {viewModel.rollbacks.length > 0 ? (
              <div className="mt-2 flex flex-col gap-1">
                {viewModel.rollbacks.map(r => (
                  <p key={r.ordinal} className="px-1 text-[11px] leading-5 text-muted-foreground">
                    <span className="text-red-500 dark:text-red-400">回滚 #{r.ordinal}</span>
                    ：{r.from.nodeId} 第 {r.from.attempt} 次失败 → {r.to.nodeId} {bandLabel(r.to.generation)} 第 {r.to.attempt} 次
                  </p>
                ))}
              </div>
            ) : null}
          </section>
          {/* 导入信息卡 */}
          {run.import ? (
            <section className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-backwards delay-200">
              <h2 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">导入信息</h2>
              <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-xl bg-foreground/[0.03] px-3.5 py-2.5 text-[11px] leading-5 text-muted-foreground dark:bg-foreground/[0.06]">
                <span>导入时间：<span className="tabular-nums">{new Date(run.import.importedAt).toLocaleString()}</span></span>
                {run.import.sourceDir ? <span className="font-mono">源目录 {run.import.sourceDir}</span> : null}
                {s ? (
                  <span>
                    会话：新导入 {s.imported} · 已存在 {s.existing}
                    {s.missingFile > 0 ? ` · 缺文件 ${s.missingFile}` : ""}
                    {s.failed > 0 ? ` · 失败 ${s.failed}` : ""}
                    {` · 引用 ${s.total}`}
                  </span>
                ) : null}
                {run.import.warnings.length > 0 ? <span className="text-amber-600 dark:text-amber-400">{run.import.warnings.length} 条警告</span> : null}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
