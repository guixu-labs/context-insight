// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一资产层类型（design: docs/design/unified-workbench/design.md §2）。
// AssetItem 是判别联合：表格/列表按 kind 分支渲染。会话行字段与原
// SessionListItem 逐字段一致（零迁移成本）；run 行是 run-store 列表投影
// + 成员会话聚合（Σtokens，session-link join）。

export type AssetKind = 'session' | 'run';
export type AssetKindFilter = 'all' | AssetKind;

export interface SessionAssetItem {
  kind: 'session';
  key: string;
  sessionId: string;
  taskId: string;
  query: string | null;
  framework: string | null;
  version?: string | null;
  startTime: string;
  importedAt: string;
  endTime: string | null;
  totalTokens: number;
  totalCost: number;
  totalLatencyMs: number;
  llmActiveMs?: number | null;
  activeMs?: number | null;
  wallMs?: number | null;
  totalToolCallCount: number;
  totalSkillLoadCount: number;
  totalSubagentCount: number;
  model: string | null;
  user: string | null;
  sourcePath: string | null;
}

/** run 成员身份名册（run 详情端点产出，Overview 单元身份卡消费）：framework/
 *  version 按成员落库行——run 级成员可能混布框架与 proxy/native，身份徽标逐
 *  成员判定而非 run 级一刀切。 */
export interface RunMemberIdentity {
  taskId: string;
  framework: string;
  version: string | null;
  label: string | null;
}

/** run 行的成员会话聚合指标（run-asset 生产，aggregateMemberStats 纯函数单点）。
 *  扩展 run 行指标（avgLatency / cacheRead 占比…）只加字段 + 聚合函数，
 *  RunAssetItem 形状不动。 */
export interface RunMemberStats {
  /** join 到库的成员会话数（≠ sessionMemberCount 清单口径——反映实际可统计量） */
  joinedCount: number;
  totalTokens: number;
  totalCost: number;
  /** Σ成员会话活跃时间（turn 时间轴活跃窗口，与会话行 Active 列同实现同口径）；
   *  全部成员无 turn 数据 = null（显示 —） */
  totalActiveMs: number | null;
  /** Σ成员会话时长（墙钟，endTime 缺端点回落 latency——同 sessionAggregates 口径，
   *  供首页 Total Duration 汇总） */
  totalDurationMs: number;
  /** 成员会话行 id（页级 Errors 卡取数用；join 结果行的 cuid） */
  memberRowIds: string[];
  /** 模型分布（会话数降序，展示口径：去 provider 前缀、同名合并计数）：单模型直出，多模型显示主模型 + 计数 */
  models: Array<{ model: string; count: number }>;
  /** Σ成员会话轮次（join 时 turns 计数累加；run Overview 卡用） */
  totalTurns: number;
  /** 成员会话最早开始 / 最晚结束：Start → End 列对缺失 manifest 端点的兜底 */
  earliestStart: string | null;
  latestEnd: string | null;
}

export interface RunAssetItem {
  kind: 'run';
  key: string;
  runId: string;
  name: string | null;
  status: string;
  exportDataComplete: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  importedAt: string | null;
  generations: number[];
  nodeCount: number;
  memberCount: number;
  sessionMemberCount: number;
  rollbackCount: number;
  subgraphCount: number;
  warnings: string[];
  /** Σ成员会话指标（session-link join + 聚合）；无 prisma 或 join 失败 = null（各列显示 —） */
  memberStats: RunMemberStats | null;
}

export type AssetItem = SessionAssetItem | RunAssetItem;

export interface AssetQuery {
  q?: string;
  kind?: AssetKindFilter;
  user?: string;
  isSubagent?: string;
  page?: number;
  pageSize?: number;
}

export interface AssetSummary {
  /** 独立会话数（run 私有会话不重复计入，隔离口径与列表一致） */
  sessionCount: number;
  runCount: number;
  /** join 到库的 run 成员会话数（Σ各 run memberStats.joinedCount）——
   *  Tokens/Cost/Duration 是系统总口径（独立会话 + run 成员），此数
   *  供首卡副行说明成员规模 */
  runMemberCount: number;
  totalTokens: number;
  totalCost: number;
  /** Σ全量时长（独立会话 + run 成员；墙钟口径，缺端点回落 latency） */
  totalDurationMs: number;
}
