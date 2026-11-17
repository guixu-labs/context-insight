"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run Perf tab：run 视角观测工作台外壳。PerfPanorama 复用（不 fork）——
// 恒为全成员合并端点，无会话隔离；定位出口（onOpenTurn）由页面外壳接
// Turns 深链管线，与 Graph 成员定位同一收口。画布与 Overview 同款
//（全宽滚动 + bg-muted/30 衬底 + gap-4 卡片栈）。

import { useMemo } from "react";
import { PerfPanorama } from "@/components/observe/PerfPanorama";
import { useRunDataEpoch } from "@/lib/run/data-epoch";
import type { RunTimeSummary } from "@/lib/observe/run-time-summary";

export interface RunPerfTabProps {
  runId: string;
  /** Run 级统一时间摘要（Overview/Perf 共用） */
  timeSummary?: RunTimeSummary | null;
  /** 定位出口：turnId → Turns 深链（工作台外壳收口） */
  onOpenTurn: (turnId: string) => void;
  /** 搜索出口：Turns 搜索语法深链（工具耗时卡下钻——工作台外壳收口） */
  onOpenSearch?: (q: string) => void;
}

export function RunPerfTab({ runId, timeSummary, onOpenTurn, onOpenSearch }: RunPerfTabProps) {
  const dataEpoch = useRunDataEpoch();
  const endpoints = useMemo(() => {
    const base = `/api/observe/run/${encodeURIComponent(runId)}`;
    return {
      executions: `${base}/executions`,
      turns: `${base}/turns?page=1&pageSize=20000`,
      bridges: `${base}/bridges`,
      lanes: `${base}/lanes`,
      toolStats: `${base}/tool-stats`,
    };
  }, [runId, dataEpoch]);

  return (
    <div className="flex flex-col gap-4 overflow-y-auto rounded-2xl bg-muted/30 p-4">
      <PerfPanorama endpoints={endpoints} timeSummary={timeSummary ?? null} onOpenTurn={onOpenTurn} onOpenSearch={onOpenSearch} />
    </div>
  );
}
