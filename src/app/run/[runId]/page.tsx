// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

"use client";

// Run 详情页：/api/observe/run/[runId] 拉取 view-model（已含成员会话 join），
// 布局 = 页面 chrome（单行应用栏：返回 · 品牌 · tab 导航 · 动作簇，见
// RunWorkbenchHeader）+ 工作台（toolbar 视图标题/图例 + 点阵画布 + 侧栏）。
// 画布支持缩放平移（Ctrl/⌘+滚轮以光标为锚缩放、左键拖拽平移、浮动工具条
// 缩放/适配）；跑马灯按需点亮——选中节点点亮其关联边，点击空白熄灭。侧栏
// 两态：未选中 → Run 概览；选中 → 节点运行历史。子图不占顶层视图——生成器
// 节点「子图 ▸」入口以弹窗展开，弹窗内按代际切换。

import { useCallback, useEffect, useMemo, useRef, useState, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RunCanvas } from "@/components/run/RunCanvas";
import { RunNodeDetail } from "@/components/run/RunNodeDetail";
import { RunOverviewTab } from "@/components/run/RunOverviewTab";
import { RUN_TABS, RUN_TABS_DEFAULT_VISIBLE } from "@/components/run/RunTabBar";
import { RunRetryLedger } from "@/components/run/RunRetryLedger";
import { RunSubgraphDialog } from "@/components/run/RunSubgraphDialog";
import { RunTrace } from "@/components/run/RunTrace";
import { RunTurnsTab } from "@/components/run/RunTurnsTab";
import { RunContextTab } from "@/components/run/RunContextTab";
import { RunPerfTab } from "@/components/run/RunPerfTab";
import { RunSkillsTab } from "@/components/run/RunSkillsTab";
import { RunFilesTab } from "@/components/run/RunFilesTab";
import { RunAuditTab } from "@/components/run/audit/RunAuditTab";
import { RunWireTab } from "@/components/run/RunWireTab";
import { RunScoreTab } from "@/components/run/RunScoreTab";
import { RunReplayTab } from "@/components/run/RunReplayTab";
import { runMemberRowsOf, type RunMemberRow } from "@/lib/run/member-rows";
import { normalizeRunIdParam } from "@/lib/run/identity";
import { prefetchRunOverview } from "@/lib/run/overview-data";
import { RunDataEpochContext } from "@/lib/run/data-epoch";
import { METRIC_EMPTY, METRIC_SCALE, REDUNDANCY_BANDS, RUN_COLORS, RUN_STATUS_META, WATER_CRITICAL_PCT, bandLabel } from "@/components/run/run-theme";
import { LENS_META, type LensKey } from "@/lib/run/run-metrics";
import { Button } from "@/components/ui/button";
import { RunWorkbenchHeader, RunWorkbenchShell } from "@/components/run/header/RunWorkbenchHeader";
import { RunWorkbenchSkeleton } from "@/components/run/header/RunWorkbenchSkeleton";
import { RunHeaderActions, type RunSyncState } from "@/components/run/header/RunHeaderActions";
import { UploadDialog } from "@/components/collection/UploadDialog";
import { BAY_NAME, BRAND_NAME } from "@/lib/branding";
import { assembleEmbeddedHtml, captureStylesheets, downloadHtml, gatherRunExportData } from "@/lib/observe/export-html";
import { MARKDOWN_FILE, SQLITE_FILE, ZIP_FILE, fetchExportFile } from "@/lib/observe/export-download";
import { archiveExportFileName, dbExportFileName } from "@/lib/observe/export-name";
import { useRunHostCaps } from "@/lib/run/host-caps";
import { toast } from "sonner";
import { notifyError } from "@/components/NoticeHud";
import { cn } from "@/lib/utils";
import type { RunMemberIdentity, RunMemberStats } from "@/lib/collection/types";
import type { RunTimeSummary } from "@/lib/observe/run-time-summary";
import type { RunViewModel } from "@/lib/run/view-model";
import { useRunView, type RunTabKey } from "@/app/run/[runId]/run-view";
import { ArrowLeftIcon, AlertTriangleIcon } from "lucide-react";
import { ScrollFade } from "@/components/ui/scroll-fade";

interface RunDetailResponse {
  run: {
    runId: string;
    /** 刀H：run-first 命名空间判别——solo = 无主 session 合成的单例 run */
    kind?: "run" | "solo";
    name: string | null;
    status: string;
    exportDataComplete: boolean;
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
  /** Σ成员会话指标（join/聚合失败时 null，Overview 卡降级 —） */
  memberStats?: RunMemberStats | null;
  /** 成员身份名册（Overview 单元身份卡：Tool/proxy 逐成员判定） */
  members?: RunMemberIdentity[] | null;
  /** Σ成员代码统计（Overview 元信息卡 Code 行；无成员会话时 null） */
  codeStats?: { additions: number; deletions: number; files: number } | null;
  /** 成员工具调用/技能失败计数（同 session 页 Errors 口径；失败 null） */
  totalErrors?: number | null;
  /** Run 级统一时间摘要（Overview/Perf 共用） */
  timeSummary?: RunTimeSummary | null;
}

/** 页面渲染表（刀A：Overview + Graph；刀B：+ Turns + Trace；刀C：+ Context + Perf；
 *  刀D：+ Skills + Files；刀E：+ Audit；刀I3：+ Wire/Replay/Score（session 独有能力
 *  经成员视图端点挂入；wire/replay 默认隐藏——调试视图，?a 展开对齐 session 页）。
 *  导航 = RunTabBar（凹槽分段控件）：渲染表/高级门/组件单一源在此 */
const LEGEND_STATUSES = ["passed", "failed", "running", "carried"] as const;

function RunOverview({ viewModel }: { viewModel: RunViewModel }) {
  const stats: { label: string; value: string }[] = [
    { label: "节点", value: String(viewModel.nodes.length) },
    { label: "代", value: String(viewModel.generations.length) },
    { label: "回滚", value: String(viewModel.rollbacks.length) },
    { label: "子图", value: String(viewModel.views.length - 1) },
  ];
  return (
    <div className="flex flex-col">
      <div className="border-b border-black/[0.08] px-4 py-3.5">
        <h2 className="text-[15px] font-semibold text-[#1f2328]">Run 概览</h2>
      </div>
      <div className="flex flex-col gap-4 px-4 py-4">
        <div className="grid grid-cols-4 gap-2">
          {stats.map(s => (
            <div key={s.label} className="rounded-lg border border-black/[0.08] bg-black/[0.02] px-2 py-2.5 text-center">
              <div className="text-[16px] font-semibold tabular-nums text-[#1f2328]">{s.value}</div>
              <div className="mt-0.5 text-[10px] text-[#8c959f]">{s.label}</div>
            </div>
          ))}
        </div>

        <div>
          <h3 className="mb-2 text-[11px] font-medium tracking-wide text-[#8c959f]">代际</h3>
          <div className="flex flex-wrap gap-1.5">
            {viewModel.generations.map(g => (
              <span
                key={g}
                className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-black/[0.03] px-2 py-0.5 text-[11px] leading-4 text-[#57606a]"
              >
                {g > 0 ? <span className="size-1.5 rounded-full bg-[#cf222e]" aria-hidden /> : null}
                {bandLabel(g)}
              </span>
            ))}
          </div>
        </div>

        {viewModel.rollbacks.length > 0 ? (
          <div>
            <h3 className="mb-2 text-[11px] font-medium tracking-wide text-[#8c959f]">回滚历史</h3>
            <div className="flex flex-col gap-1">
              {viewModel.rollbacks.map(r => (
                <p key={r.ordinal} className="text-[11px] leading-5 text-[#57606a]">
                  <span className="text-[#cf222e]">回滚 #{r.ordinal}</span>
                  ：{r.from.nodeId} 第 {r.from.attempt} 次失败 → {r.to.nodeId} {bandLabel(r.to.generation)} 第 {r.to.attempt} 次
                </p>
              ))}
            </div>
          </div>
        ) : null}

        <p className="mt-1 border-t border-black/[0.08] pt-3.5 text-[11px] leading-5 text-[#8c959f]">
          点击图上节点查看运行历史（逐次尝试、验收结论、成员会话与 turn 下钻）；生成器节点右上角
          <span className="text-[#57606a]">「子图 ▸」</span>以弹窗展开该代子图（可点击子图节点下钻会话）；
          <span className="text-[#57606a]"> 红虚线为回滚边</span>——失败尝试的验收成员指向新代目标。
        </p>
      </div>
    </div>
  );
}

export default function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  // 客户端导航的动态段可能保持 URL 编码形态（solo%3A…；SSR/直刷是解码形态）——
  // 归一化单点，防 encodeURIComponent 双重编码把 solo run 判成不存在
  const { runId: rawRunId } = use(params);
  const runId = normalizeRunIdParam(rawRunId);
  const router = useRouter();
  const searchParams = useSearchParams();
  // 高级 tab 门（wire/replay）：?a 或 NEXT_PUBLIC_SHOW_ADVANCED_TABS（session 页同款）
  const showAdvancedTabs = process.env.NEXT_PUBLIC_SHOW_ADVANCED_TABS === "true" || searchParams.has("a");
  const visibleTabs = showAdvancedTabs ? RUN_TABS : RUN_TABS_DEFAULT_VISIBLE;
  const [data, setData] = useState<RunDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // 子图弹窗：点击生成器节点「子图 ▸」入口打开（entryKey = 该代生成器节点）
  const [subgraphKey, setSubgraphKey] = useState<string | null>(null);
  // 系统级观测：视图模式（结构图 / 时间轴 / 重试账本）与指标透镜（结构图着色维度）
  const [mode, setMode] = useState<"graph" | "trace" | "ledger">("graph");
  const [lens, setLens] = useState<LensKey>("status");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [exportingDb, setExportingDb] = useState(false);
  const [exportingMd, setExportingMd] = useState(false);
  const [exportingHtml, setExportingHtml] = useState(false);
  const [exportingArchive, setExportingArchive] = useState(false);
  // tab/member 视图状态（state 权威 + URL 镜像，契约对齐离线降级路径）；
  // goBack/canBack 为条目栈出口——live 页面条目栈 = 浏览器历史（鼠标侧键/
  // 浏览器返回钮与本钮同一出口，popstate 恢复视图），离线导出降级内存栈
  const { view, navigate, select, goBack, canBack } = useRunView();
  // 宿主能力门控（live 页面 = 全能力；离线导出 bundle = 只读档案）
  const { offline } = useRunHostCaps();
  // 懒挂载护栏（design §6）：Turns/Trace 等自取数 tab 首次访问才挂载拉数，
  // 此后保持挂载 hidden 切换（回切不丢状态）——避免 Overview 落地即全量拉取
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<RunTabKey>>(() => new Set([view.tab]));
  if (!visitedTabs.has(view.tab)) {
    setVisitedTabs(new Set([...visitedTabs, view.tab]));
  }
  // 稳定回调：RunGraph memo 依赖 props 引用稳定（子图入口不随无关重渲染换引用）
  const openSubgraph = useCallback((key: string) => setSubgraphKey(key), []);

  // 返回 = 回退上一个工作台动作（tab 切换 / turn 深链 / 成员钻取，逐步回退）
  // ——与鼠标侧键、浏览器返回钮同一真相（浏览器历史条目，popstate 恢复）；
  // 条目栈空则离页——浏览器有来路回上页，直开深链（无来路）回工作台首页
  const handleBack = useCallback(() => {
    if (goBack()) return;
    if (window.history.length > 1) router.back();
    else router.push("/");
  }, [goBack, router]);

  // —— 定位收口（locate）——
  // 「跳到 Turns 看某位置」的唯一入态是 turnId 深链管线：navigate({ tab:
  //  "turns", turnId }) → RunTurnsTab 选中 → 详情归属 → 节点自动展开 → 行
  // 居中揭示（既有机制）。粗粒度目标（会话等）不另建管线，先解析成轮再进
  // 同一管线——解析器都收口在这一层（唯一同时持有 navigate 与 runId 的
  // 外壳），后续新增定位入口（Overview/Trace/评分卡…）复用同一函数
  const locateSession = useCallback(async (taskId: string) => {
    // 会话 → 该会话首轮（时间线升序第 1 条）；pageSize=1 只取锚点
    let firstTurn: string | null = null;
    try {
      const r = await fetch(`/api/observe/run/${encodeURIComponent(runId)}/turns?member=${encodeURIComponent(taskId)}&page=1&pageSize=1`);
      if (r.ok) {
        const d = (await r.json()) as { items?: Array<{ turnId: string }> };
        firstTurn = d.items?.[0]?.turnId ?? null;
      }
    } catch { /* 取数失败兜底：仅切 tab */ }
    // 无轮会话：切 Turns 清选中（列表兜底呈现「该成员无已入库轮次」）
    navigate({ tab: "turns", turnId: firstTurn });
  }, [runId, navigate]);

  useEffect(() => {
    let cancelled = false;
    // Overview 面板预取与详情 fetch 同刻并行：面板五端点不等 run 详情往返
    // （详情未到也能先拉数据，tab 挂载时命中缓存即刻渲染）
    void prefetchRunOverview(runId);
    (async () => {
      try {
        const res = await fetch(`/api/observe/run/${encodeURIComponent(runId)}`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? `加载失败 (${res.status})`);
          return;
        }
        setData(body);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [runId]);

  const nodesByKey = useMemo(
    () => new Map((data?.viewModel.nodes ?? []).map(n => [n.key, n])),
    [data],
  );
  // 主图即工作台（子图为弹窗，不再是顶层视图）；命名与 run-view 的 view（tab 状态）区分
  const mainView = data?.viewModel.views[0] ?? null;
  // 成员维度单点（Overview 成员表 / Turns/Trace 过滤 chips 同源）
  const memberRows = useMemo(() => (data ? runMemberRowsOf(data.viewModel) : []), [data]);
  const selectedNode = selectedKey ? nodesByKey.get(selectedKey) ?? null : null;

  // ── 刷新（session 页刷新能力在 run 工作台的对偶，刀J2 后补全）────────────
  // solo = 增量刷新成员会话源；bundle = 逐个刷新有源的成员会话。自取数 tab 经
  // 数据纪元原地重取（RunDataEpochContext——tab 保持挂载，tab/member/turnId
  // URL 镜像态与滚动/展开/搜索/详情仓等阅读态全部保持）；仅 fullRebuild（源
  // 回溯变化、轮次可能重排）走身份 key 整树重挂。
  const [refreshing, setRefreshing] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [identityEpoch, setIdentityEpoch] = useState(0);
  const refreshingRef = useRef(false);

  const reloadRun = useCallback(async (hard = false) => {
    try {
      // 自取数 tab 经数据纪元原地重取：先换新 promise，订阅纪元的 Overview 消费
      // 缓存即取到刷新后数据（fresh 覆盖旧 promise，随后 setData + 纪元 bump）
      void prefetchRunOverview(runId, { fresh: true });
      const res = await fetch(`/api/observe/run/${encodeURIComponent(runId)}`);
      if (!res.ok) return;
      setData(await res.json());
      if (hard) setIdentityEpoch(e => e + 1);
      else setRefreshEpoch(e => e + 1);
    } catch {
      /* 重载失败保留旧数据 */
    }
  }, [runId]);

  const refreshMembers = useCallback(async (targets: RunMemberRow[], auto: boolean) => {
    if (refreshingRef.current || targets.length === 0) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      let added = 0, updated = 0, rebuilt = 0, ok = 0, fullRebuild = false;
      const errors: string[] = [];
      for (const m of targets) {
        try {
          const res = await fetch("/api/ingest/refresh-session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId: m.taskId, framework: m.framework }),
          });
          const d = await res.json();
          if (res.ok) {
            ok++;
            added += d.addedTurns ?? 0;
            updated += d.updatedTurns ?? 0;
            if (d.fullRebuild) { fullRebuild = true; rebuilt += d.rebuiltTurns ?? 0; }
          } else {
            errors.push(`${m.taskId}: ${d.error ?? `HTTP ${res.status}`}`);
          }
        } catch {
          errors.push(`${m.taskId}: 网络错误`);
        }
      }
      if (errors.length > 0 && !auto) {
        notifyError("刷新失败", errors[0] + (errors.length > 1 ? `（共 ${errors.length} 个成员失败）` : ""));
      }
      if (ok > 0) {
        const msg = fullRebuild
          ? `源回溯变化，全量重建 ${rebuilt} 轮`
          : added > 0 ? `新增 ${added} 轮，更新 ${updated} 轮` : "已是最新";
        toast.success(`${auto ? "自动同步" : "刷新完成"}: ${msg}`, { duration: 3000 });
        await reloadRun(fullRebuild);
      }
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [reloadRun]);

  // 自动同步（solo + 原生 opencode 源）：5s 探针轮询——run 成员视图端点
  // （刀J2 删除的 session 探针以平移层处理器复活），settled 且源有变化 →
  // 增量导入 + 后台重载。只对原生 opencode 开启：其探针是 sqlite 计数（廉价）；
  // claude 格式源（含 proxy 捕获）探针要整读文件，压缩后的 .7z 每 5s 全量读取
  // 不可接受——那些会话走手动刷新。
  const soloRow = data?.run.kind === "solo" ? memberRows[0] ?? null : null;
  const autoSyncEligible = soloRow != null && soloRow.framework === "opencode" && !!soloRow.sourcePath;
  // 页头同步态（刷新钮与 chip 的共同驱动）：手动 / 自动同步已开启 / 同步中
  const syncState: RunSyncState = refreshing ? "syncing" : autoSyncEligible ? "auto" : "idle";
  // 浏览器标签页标题 = run 名（多 run 并开时以标签页区分上下文）；
  // 卸载恢复原值，不影响其他页面
  useEffect(() => {
    if (!data?.run) return;
    const prev = document.title;
    document.title = `${data.run.name ?? data.run.runId} · ${BRAND_NAME}`;
    return () => { document.title = prev; };
  }, [data?.run]);
  useEffect(() => {
    if (offline || !autoSyncEligible || soloRow == null) return;
    // 基线是 effect 局部量：run 切换/数据重载后重开即重置（防跨 run 残留基线）
    let initialized = false;
    let lastMaxTime = -1;
    let active = true;
    const poll = async () => {
      if (!active || refreshingRef.current) return;
      try {
        const res = await fetch(`/api/observe/run/${encodeURIComponent(runId)}/auto-refresh?member=${encodeURIComponent(soloRow.taskId)}`);
        if (!res.ok || !active) return;
        const d = await res.json();
        if (!initialized) {
          initialized = true;
          lastMaxTime = d.maxTimeUpdated ?? -1;
          return;
        }
        if (!d.settled) return;
        const countChanged = d.countChanged === true;
        const timeChanged = typeof d.maxTimeUpdated === "number" && d.maxTimeUpdated !== lastMaxTime;
        if (countChanged || timeChanged) {
          lastMaxTime = d.maxTimeUpdated ?? -1;
          void refreshMembers([soloRow], true);
        }
      } catch {
        /* 探针失败本次跳过，下轮重试 */
      }
    };
    const t = setInterval(poll, 5000);
    return () => { active = false; clearInterval(t); };
  }, [runId, autoSyncEligible, soloRow, refreshMembers]);

  if (error) {
    return (
      <RunWorkbenchShell header={<RunWorkbenchHeader back={null} nav={null} />}>
        {/* 错误态：页头仅品牌（错误卡自带返回 / 重试），错误卡在面板区居中 */}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 py-10">
          <span className="flex size-10 items-center justify-center rounded-full bg-red-500/[0.08] dark:bg-red-500/[0.14]">
            <AlertTriangleIcon className="size-5 text-red-500 dark:text-red-400" />
          </span>
          <p className="text-sm font-medium text-red-600 dark:text-red-400">{error}</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1" onClick={() => router.back()}>
              <ArrowLeftIcon className="size-4" />
              返回
            </Button>
            <Button size="sm" onClick={() => window.location.reload()}>重试</Button>
          </div>
        </div>
      </RunWorkbenchShell>
    );
  }
  if (!data || !mainView) {
    return (
      <RunWorkbenchShell
        // 加载态 = 与加载后同一页头：返回 / 品牌可用，tab 条以真身作骨架
        // （禁用 + 呼吸，形状即就绪形状），右区动作按真实形状占位
        header={(
          <RunWorkbenchHeader
            back={{ canBack, onBack: handleBack }}
            nav={{ tabs: visibleTabs, active: view.tab, onSelect: () => {}, pending: true }}
            actionsPending
          />
        )}
      >
        <RunWorkbenchSkeleton />
      </RunWorkbenchShell>
    );
  }

  const { run, viewModel } = data;
  const nodeRollbacks = selectedNode
    ? viewModel.rollbacks.filter(r => r.triggerKey === selectedNode.key)
    : [];
  const peers = selectedNode
    ? viewModel.nodes
        .filter(n => n.nodeId === selectedNode.nodeId && n.generation !== selectedNode.generation)
        .sort((a, b) => a.generation - b.generation)
        .map(n => ({ key: n.key, generation: n.generation, status: n.status }))
    : [];

  // 离线导出：solo = 会话维度导出（与 compare 同口径），bundle = run 全员
  // 工作台导出；MD 走 run 成员视图端点（solo-only），HTML 经 export-html
  // 装配（取数 run 端点 + 成员富轮仓，离线查看器即本工作台组件树）
  const soloMember = run.kind === "solo" ? memberRows[0] ?? null : null;
  // 刷新目标：有源的成员会话（solo = 1 个；bundle = 全部有源成员）
  const refreshTargets = memberRows.filter(m => m.sourcePath);
  const refreshable = !offline && refreshTargets.length > 0;

  async function handleExportDb() {
    if (exportingDb) return;
    setExportingDb(true);
    try {
      const file = await fetchExportFile(`/api/observe/run/${encodeURIComponent(run.runId)}/export-db`, {
        mime: "application/x-sqlite3",
        kind: SQLITE_FILE,
        fallbackName: dbExportFileName({
          solo: run.kind === "solo", runId: run.runId, taskId: soloMember?.taskId ?? null, runName: run.name,
        }),
      });
      toast.success("SQLite exported", {
        description: `${file.filename} — ${memberRows.length > 1 ? `含 ${memberRows.length} 个成员会话，` : ""}可经导入向导原样导回`,
      });
    } catch (e) {
      notifyError("Export SQLite failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setExportingDb(false);
    }
  }

  async function handleExportArchive() {
    if (exportingArchive) return;
    setExportingArchive(true);
    try {
      const file = await fetchExportFile(`/api/observe/run/${encodeURIComponent(run.runId)}/export-archive`, {
        mime: "application/zip",
        kind: ZIP_FILE,
        fallbackName: archiveExportFileName({
          solo: run.kind === "solo", runId: run.runId, taskId: soloMember?.taskId ?? null, runName: run.name,
        }),
      });
      toast.success("Archive exported", {
        description: `${file.filename} — 原始文件按原格式打包，包内 export-manifest.json 记录每个会话的文件与来源`,
      });
    } catch (e) {
      notifyError("Export archive failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setExportingArchive(false);
    }
  }

  async function handleExportMd() {
    if (!soloMember || exportingMd) return;
    setExportingMd(true);
    try {
      const file = await fetchExportFile(`/api/observe/run/${encodeURIComponent(run.runId)}/export-md`, {
        mime: "text/markdown",
        kind: MARKDOWN_FILE,
        fallbackName: `session_${soloMember.taskId}.md`,
      });
      toast.success("Markdown exported", { description: file.filename });
    } catch (e) {
      notifyError("Export Markdown failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setExportingMd(false);
    }
  }

  async function handleExportHtml() {
    if (exportingHtml) return;
    setExportingHtml(true);
    try {
      const cssText = captureStylesheets();
      const payload = await gatherRunExportData(run.runId);
      const bundleRes = await fetch("/export-view.js");
      if (!bundleRes.ok) throw new Error("export-view.js 未构建，请先运行 npm run build:export-view");
      const runName = run.name ?? run.runId;
      const html = assembleEmbeddedHtml(
        cssText,
        await bundleRes.text(),
        run.runId,
        runName,
        payload,
      );
      // solo 保持会话文件名口径；bundle 用 run 身份（文件系统安全字符收敛）
      const filename = soloMember
        ? `session_${soloMember.taskId}.html`
        : `run_${runName.replace(/[\\/:*?"<>|\s]+/g, "_")}.html`;
      downloadHtml(html, filename);
      toast.success("HTML exported", { description: `${filename} — 嵌入式工作台（离线可交互）` });
    } catch (e) {
      notifyError("Export HTML failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setExportingHtml(false);
    }
  }

  // 面板容器统一类：淡入切换（display none→flex 翻转即重放 CSS 动画，
  // 每次切 tab 一个 200ms 淡入）
  const tabPanelClass = (key: RunTabKey) => cn(
    "min-h-0 flex-1 flex-col animate-in fade-in duration-200",
    view.tab === key ? "flex" : "hidden",
  );

  return (
    <RunWorkbenchShell
      // 单行应用栏：返回 · 品牌 · tab 导航 · 同步 chip + 动作簇。run 身份
      // （名称 / 状态 / 类型 / runId）由 Overview 首卡承载，页头只留导航与
      // 操作；品牌区点击回工作台首页。动作在不在场由宿主能力与 run 形态
      // 决定（离线档案只读：刷新 / 导出 / 上传全无）
      header={(
        <RunWorkbenchHeader
          back={{ canBack, onBack: handleBack }}
          nav={{ tabs: visibleTabs, active: view.tab, onSelect: key => navigate({ tab: key }) }}
          actions={(
            <RunHeaderActions
              refresh={offline ? null : {
                sync: syncState,
                enabled: refreshable,
                onRefresh: () => { if (!refreshing && refreshable) void refreshMembers(refreshTargets, false) },
              }}
              exports={offline ? null : [
                { id: "sqlite" as const, label: "SQLite 数据库", pending: exportingDb, onExport: () => { void handleExportDb(); } },
                { id: "archive" as const, label: "原始文件 (zip)", pending: exportingArchive, onExport: () => { void handleExportArchive(); } },
                ...(!soloMember ? [] : [{
                  id: "markdown" as const, label: "Markdown", pending: exportingMd, onExport: () => { void handleExportMd(); },
                }]),
                { id: "html" as const, label: "离线 HTML", pending: exportingHtml, onExport: () => { void handleExportHtml(); } },
              ]}
              upload={offline ? null : {
                label: run.kind === "solo" ? `上传会话到${BAY_NAME}` : `上传到${BAY_NAME}`,
                disabled: run.kind === "solo" && !soloMember,
                onOpen: () => setUploadOpen(true),
              }}
            />
          )}
        />
      )}
    >

      {!offline ? (
        <UploadDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          kind={run.kind === "solo" ? "session" : "run"}
          target={run.kind === "solo" && soloMember ? {
            taskId: soloMember.taskId,
            query: run.name,
            framework: soloMember.framework,
            model: soloMember.model,
            startTime: run.startedAt,
            endTime: run.finishedAt,
            sourcePath: soloMember.sourcePath,
          } : { runId: run.runId, runName: run.name }}
        />
      ) : null}

      {/* 数据纪元提供者：刷新走「原地重取」（tab 保持挂载），阅读态不被重挂清场 */}
      <RunDataEpochContext.Provider value={refreshEpoch}>

      {viewModel.warnings.length > 0 ? (
        <div className="shrink-0 animate-in fade-in slide-in-from-bottom-2 duration-300 rounded-xl bg-amber-500/[0.08] px-3.5 py-2.5 text-xs leading-5 text-amber-700 dark:text-amber-400">
          {viewModel.warnings.slice(0, 5).map(w => <p key={w}>⚠ {w}</p>)}
        </div>
      ) : null}

      {/* tab 内容全部保持挂载（hidden 切换，session 页同款）：切走再切回不丢
          状态——Graph 的选中/缩放/透镜、Overview 的滚动位置都留在原处 */}
      <div data-run-tab="overview" className={tabPanelClass("overview")}>
        {data ? (
          <RunOverviewTab
            key={identityEpoch}
            runId={run.runId}
            run={run}
            viewModel={viewModel}
            memberStats={data.memberStats ?? null}
            timeSummary={data.timeSummary ?? null}
            totalErrors={data.totalErrors ?? null}
            members={data.members ?? []}
            codeStats={data.codeStats ?? null}
            onOpenTurns={({ turnId, member }) => navigate({ tab: "turns", turnId: turnId ?? undefined, member: member ?? undefined })}
            onOpenSkills={() => navigate({ tab: "skills" })}
          />
        ) : null}
      </div>

      {visitedTabs.has("turns") ? (
        <div data-run-tab="turns" className={tabPanelClass("turns")}>
          <RunTurnsTab
            key={identityEpoch}
            runId={run.runId}
            viewModel={viewModel}
            turnId={view.turnId}
            onSelectTurn={id => select({ turnId: id })}
            searchQuery={view.q}
          />
        </div>
      ) : null}

      {visitedTabs.has("context") ? (
        <div data-run-tab="context" className={tabPanelClass("context")}>
          <RunContextTab
            key={identityEpoch}
            runId={run.runId}
            onNavigateToTurn={(turnId, member) => navigate({ tab: "turns", turnId, member: member ?? undefined })}
          />
        </div>
      ) : null}

      {visitedTabs.has("audit") ? (
        <div data-run-tab="audit" className={tabPanelClass("audit")}>
          <RunAuditTab
            key={identityEpoch}
            runId={run.runId}
            members={memberRows}
            onOpenTurn={(turnId, member) => navigate({ tab: "turns", turnId, member: member ?? undefined })}
          />
        </div>
      ) : null}

      {visitedTabs.has("perf") ? (
        <div data-run-tab="perf" className={tabPanelClass("perf")}>
          <RunPerfTab
            key={identityEpoch}
            runId={run.runId}
            timeSummary={data.timeSummary ?? null}
            onOpenTurn={turnId => navigate({ tab: "turns", turnId })}
            onOpenSearch={q => navigate({ tab: "turns", q })}
          />
        </div>
      ) : null}

      {visitedTabs.has("skills") ? (
        <div data-run-tab="skills" className={tabPanelClass("skills")}>
          <RunSkillsTab
            key={identityEpoch}
            runId={run.runId}
            members={memberRows}
            onOpenTurn={turnId => navigate({ tab: "turns", turnId })}
          />
        </div>
      ) : null}

      {visitedTabs.has("files") ? (
        <div data-run-tab="files" className={tabPanelClass("files")}>
          <RunFilesTab key={identityEpoch} runId={run.runId} />
        </div>
      ) : null}

      {visitedTabs.has("wire") ? (
        <div data-run-tab="wire" className={tabPanelClass("wire")}>
          <RunWireTab
            key={identityEpoch}
            runId={run.runId}
            members={memberRows}
            member={view.member}
            onMemberChange={m => navigate({ member: m })}
          />
        </div>
      ) : null}

      {visitedTabs.has("score") ? (
        <div data-run-tab="score" className={tabPanelClass("score")}>
          <RunScoreTab
            key={identityEpoch}
            runId={run.runId}
            runName={run.name}
            members={memberRows}
            member={view.member}
            onMemberChange={m => navigate({ member: m })}
            onOpenTurn={turnId => navigate({ tab: "turns", turnId })}
          />
        </div>
      ) : null}

      {visitedTabs.has("replay") ? (
        <div data-run-tab="replay" className={tabPanelClass("replay")}>
          <RunReplayTab
            key={identityEpoch}
            runId={run.runId}
            members={memberRows}
            member={view.member}
            onMemberChange={m => navigate({ member: m })}
            onOpenTurn={turnId => navigate({ tab: "turns", turnId })}
          />
        </div>
      ) : null}

      {/* 工作台 = Graph tab（铺满页宽）：toolbar（视图标题 / 模式与透镜 / 图例）+ 画布（结构
          图或时间轴）+ 侧栏；子图经生成器节点「子图 ▸」入口以弹窗展开 */}
      <div data-run-tab="graph" className={cn("flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-xl border bg-white shadow-sm animate-in fade-in duration-200", view.tab === "graph" ? "" : "hidden")}>
        <div className="flex h-12 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-black/[0.08] bg-black/[0.015] px-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="truncate px-1 text-xs font-medium text-[#57606a]" title={mainView.title}>
              {mainView.title}
            </span>
            {/* 视图模式：结构图（DAG）/ 时间轴（Trace 泳道）/ 账本（重试浪费）——共用选中与侧栏 */}
            <div className="flex items-center rounded-md border border-black/10 bg-white p-0.5" role="group" aria-label="视图模式">
              {([["graph", "结构"], ["trace", "时间轴"], ["ledger", "账本"]] as const).map(([k, t]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={mode === k}
                  onClick={() => setMode(k)}
                  className={`rounded px-2 py-0.5 text-[11px] leading-5 transition-colors ${
                    mode === k ? "bg-black/[0.07] font-medium text-[#1f2328]" : "text-[#57606a] hover:text-[#1f2328]"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            {/* 指标透镜（结构图模式）：切换节点着色维度——状态 / Token / 时长 / 轮次 / 缓存 */}
            {mode === "graph" ? (
              <div className="flex items-center rounded-md border border-black/10 bg-white p-0.5" role="group" aria-label="指标透镜">
                {LENS_META.map(l => (
                  <button
                    key={l.key}
                    type="button"
                    aria-pressed={lens === l.key}
                    onClick={() => setLens(l.key)}
                    className={`rounded px-1.5 py-0.5 text-[11px] leading-5 transition-colors ${
                      lens === l.key ? "bg-black/[0.07] font-medium text-[#1f2328]" : "text-[#57606a] hover:text-[#1f2328]"
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {mode === "graph" && lens === "status" ? (
            <div className="hidden items-center gap-3.5 text-[11px] text-[#8c959f] lg:flex" aria-label="图例">
              {LEGEND_STATUSES.map(s => (
                <span key={s} className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ backgroundColor: RUN_STATUS_META[s].color }} aria-hidden />
                  {RUN_STATUS_META[s].label}
                </span>
              ))}
              <span className="h-3.5 w-px bg-black/10" aria-hidden />
              <span className="inline-flex items-center gap-1.5">
                <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden>
                  <path d="M1 4 H17" stroke={RUN_COLORS.edge} strokeWidth="1.25" />
                </svg>
                依赖
              </span>
              <span className="inline-flex items-center gap-1.5">
                <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden>
                  <path d="M1 4 H17" stroke={RUN_COLORS.rollback} strokeWidth="1.25" strokeDasharray="4 3" />
                </svg>
                回滚
              </span>
            </div>
          ) : mode === "graph" ? (
            <div className="hidden items-center gap-2 text-[11px] text-[#8c959f] lg:flex" aria-label="图例">
              <span>{LENS_META.find(l => l.key === lens)?.legend}</span>
              {lens === "context" ? (
                // 水位透镜：节点是容器、上下文是水——图例直接给容器示意与警戒线
                <>
                  <span className="inline-flex items-center gap-1.5">
                    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                      <rect x="0.5" y="0.5" width="13" height="13" rx="3.5" fill="#ffffff" stroke="#d0d7de" strokeWidth="1" />
                      <rect x="1.5" y={14 - 12 * 0.6} width="11" height={12 * 0.6} fill="#4a93da" fillOpacity="0.32" />
                      <line x1="1.5" x2="12.5" y1={14 - 12 * 0.8} y2={14 - 12 * 0.8} stroke="#cf222e" strokeWidth="1" strokeDasharray="2 1.5" strokeOpacity="0.6" />
                    </svg>
                    水深 = 峰值水位
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden>
                      <line x1="1" y1="4" x2="15" y2="4" stroke="#cf222e" strokeWidth="1.2" strokeDasharray="3 2.5" strokeOpacity="0.6" />
                    </svg>
                    {WATER_CRITICAL_PCT}% 警戒线
                  </span>
                </>
              ) : lens === "redundancy" ? (
                // 冗余透镜：绝对阈值三档（评分卡同款 0.6/0.8），低分才警示
                <>
                  {REDUNDANCY_BANDS.map(b => (
                    <span
                      key={b.label}
                      className="inline-flex items-center gap-1.5"
                      title={b.label}
                    >
                      <span
                        className="size-2.5 rounded-sm border"
                        style={{ borderColor: b.color, backgroundColor: `${b.color}30` }}
                        aria-hidden
                      />
                      {b.label}
                    </span>
                  ))}
                </>
              ) : (
                <>
                  <span>低</span>
                  {METRIC_SCALE.map(c => (
                    <span
                      key={c}
                      className="size-2.5 rounded-sm border"
                      style={{ borderColor: c, backgroundColor: `${c}30` }}
                      aria-hidden
                    />
                  ))}
                  <span>高</span>
                </>
              )}
              <span className="h-3.5 w-px bg-black/10" aria-hidden />
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm border" style={{ borderColor: METRIC_EMPTY }} aria-hidden />
                无会话数据
              </span>
            </div>
          ) : mode === "trace" ? (
            <div className="hidden items-center gap-3.5 text-[11px] text-[#8c959f] lg:flex" aria-label="图例">
              <span className="inline-flex items-center gap-1.5">
                <svg width="20" height="10" viewBox="0 0 20 10" aria-hidden>
                  <rect width="20" height="8" rx="2" fill={RUN_STATUS_META.passed.color} fillOpacity="0.82" />
                </svg>
                执行
              </span>
              <span className="inline-flex items-center gap-1.5">
                <svg width="20" height="10" viewBox="0 0 20 10" aria-hidden>
                  <rect y="0.5" width="20" height="6" rx="2" fill={RUN_STATUS_META.passed.color} fillOpacity="0.22" stroke={RUN_STATUS_META.passed.color} strokeWidth="0.8" />
                </svg>
                验收
              </span>
              <span className="h-3.5 w-px bg-black/10" aria-hidden />
              {(["passed", "failed"] as const).map(s => (
                <span key={s} className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ backgroundColor: RUN_STATUS_META[s].color }} aria-hidden />
                  {RUN_STATUS_META[s].label}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1">
            {mode === "graph" ? (
              <RunCanvas
                view={mainView}
                nodesByKey={nodesByKey}
                selectedKey={selectedKey}
                onSelectNode={setSelectedKey}
                onOpenSubgraph={openSubgraph}
                lens={lens}
              />
            ) : mode === "trace" ? (
              <RunTrace
                view={mainView}
                nodesByKey={nodesByKey}
                selectedKey={selectedKey}
                onSelectNode={setSelectedKey}
              />
            ) : (
              <RunRetryLedger
                vm={viewModel}
                selectedKey={selectedKey}
                onSelectNode={setSelectedKey}
              />
            )}
          </div>
          {/* 概览/历史侧栏：浮层玻璃面板（平移画布时内容从面板下滑过被
              虚化，替代硬边栏），滚动内容经 mask 在上下缘渐隐。右缘让出
              28px——trace/台账模式的画布滚动条不被面板盖住 */}
          <ScrollFade as="aside" className="run-glass absolute inset-y-2 right-7 z-10 w-[360px] shrink-0 overflow-y-auto rounded-2xl">
            {selectedNode ? (
              <RunNodeDetail
                node={selectedNode}
                rollbacks={nodeRollbacks}
                peers={peers}
                onSelectNode={key => { setSelectedKey(key); }}
                onLocateSession={locateSession}
                onClose={() => setSelectedKey(null)}
              />
            ) : (
              <RunOverview viewModel={viewModel} />
            )}
          </ScrollFade>
        </div>
      </div>
      </RunDataEpochContext.Provider>

      <RunSubgraphDialog
        open={subgraphKey !== null}
        onOpenChange={next => { if (!next) setSubgraphKey(null); }}
        views={viewModel.views}
        nodesByKey={nodesByKey}
        rollbacks={viewModel.rollbacks}
        entryKey={subgraphKey}
        lens={lens}
        onLocateSession={taskId => {
          // 定位目标在 Turns（弹窗之外）——先关弹窗再跳，落地即可见
          setSubgraphKey(null);
          void locateSession(taskId);
        }}
      />
    </RunWorkbenchShell>
  );
}
