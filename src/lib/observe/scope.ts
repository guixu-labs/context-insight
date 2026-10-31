// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 观测作用域契约（design: docs/design/run-observe-parity/design.md §3.1）。
// 观测能力的作用域抽象：session = 单成员作用域（第二步接入），run = 多成员
// 作用域。collector 只认 rowIds 与归因元数据、不感知 run 结构——身份字段
// 产地是各域解析器（run 侧 = session-link 唯一触 DB 点），rowId（Prisma
// Session.id，cuid 全局唯一）是 collectors 批量 IN 查询的键。

/** run 结构归因（Graph 导航 / 成员表展示用；session 作用域为 null）。
 *  nodeKey 与 view-model NodeInstance.key 同构（`n-<nodeId>-g<generation>`）。 */
export interface ObserveStructureRef {
  nodeKey: string;
  nodeId: string;
  generation: number;
  attempt: number;
  role: string;
  memberName: string | null;
}

/** 作用域内的一个成员会话（身份 + 归因，无指标——指标由 collector 现算）。 */
export interface ObserveMemberRef {
  rowId: string;
  taskId: string;
  framework: string;
  label: string | null;
  structure: ObserveStructureRef | null;
}

export interface ObserveScope {
  kind: 'session' | 'run';
  /** run 作用域的 run 标识（session 作用域缺省） */
  runId?: string;
  members: ObserveMemberRef[];
}

/** rowId → 成员（collector 查询结果归因用） */
export function memberByRowId(scope: ObserveScope): Map<string, ObserveMemberRef> {
  return new Map(scope.members.map(m => [m.rowId, m]));
}

/** taskId → 成员（member 过滤参数校验 / 成员表定位用） */
export function memberByTaskId(scope: ObserveScope): Map<string, ObserveMemberRef> {
  return new Map(scope.members.map(m => [m.taskId, m]));
}

/** 作用域查询行集合：member 缺省 = 全成员；member 不在作用域返回空（调用方先经
 *  validateScopeMember 闸） */
export function scopeRowIds(scope: ObserveScope, member?: string | null): string[] {
  if (member == null) return scope.members.map(m => m.rowId);
  const rowId = memberByTaskId(scope).get(member)?.rowId;
  return rowId != null ? [rowId] : [];
}
