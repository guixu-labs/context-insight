"use client";
// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 时间线取数（Turns 顶部）：executions（逐轮区间带 turnId）+ bridges + lanes 三路
// run 合并端点，各路独立落地、互不阻塞。URL 与离线导出静态档案的存档键逐字
// 一致（export-html gather 同一构造器）——离线查看器的时间线不是缺口。
// 数据纪元变化（刷新）原地重取；任一路失败只让对应能力缺席，不拖累其余两路。

import { useEffect, useState } from "react";
import type { SwimAgent } from "@/lib/swimlane-model";
import type { MergedBridgeItem } from "@/lib/observe/collectors/bridges";

export interface RunTimelineData {
  /** null = 首次取数在途 */
  agents: SwimAgent[] | null;
  /** 完整桥条目（节点内派发归组用全集；时间线只取其结构子集） */
  bridges: MergedBridgeItem[];
  /** 声明车道表（工作流业务概念，insight 不硬编码任何词） */
  lanes: string[];
  /** 车道表由派发内容推断而非湖目录声明 */
  lanesInferred: boolean;
}

export function useRunTimeline(runId: string, dataEpoch: number): RunTimelineData {
  const [agents, setAgents] = useState<SwimAgent[] | null>(null);
  const [bridges, setBridges] = useState<MergedBridgeItem[]>([]);
  const [lanes, setLanes] = useState<string[]>([]);
  const [lanesInferred, setLanesInferred] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const base = `/api/observe/run/${encodeURIComponent(runId)}`;
    const getJson = (path: string) =>
      fetch(`${base}/${path}`)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null);

    void getJson("executions").then(d => {
      if (!cancelled) setAgents(Array.isArray(d?.items) ? d.items : []);
    });
    void Promise.all([getJson("bridges"), getJson("lanes")]).then(([b, l]) => {
      if (cancelled) return;
      setBridges(Array.isArray(b?.items) ? b.items : []);
      setLanes(Array.isArray(l?.lanes) ? l.lanes : []);
      setLanesInferred(l?.source === "inferred");
    });
    return () => { cancelled = true; };
  }, [runId, dataEpoch]);

  return { agents, bridges, lanes, lanesInferred };
}
