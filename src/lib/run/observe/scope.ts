// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 作用域解析器（design: docs/design/run-observe-parity/design.md §3.1）：
// runId → ObserveScope。成员身份经 session-link（run 域唯一触 DB 模块）join，
// 结构归因取 manifest graph 注解。LRU 短 TTL——run 本体不可变，但成员会话
// 重导入会换行（rowId 变），60s 内容忍陈旧身份；缓存只存身份不存指标，
// 指标恒由 collector 现算，无失效正确性问题。

import type { PrismaClient } from '@prisma/client';
import { LruCache } from '@/lib/lru-cache';
import type { ObserveMemberRef, ObserveScope } from '@/lib/observe/scope';
import { joinSessionRefs, sessionRefsByTaskIds } from '@/lib/run/session-link';
import { readRun } from '@/lib/run/run-store';
import { memberShortNames } from '@/lib/run/member-rows';
import { isSoloRunId, soloTaskIdOf } from '@/lib/run/identity';

const scopeCache = new LruCache<string, ObserveScope>(16, 60_000);

/** runId → 观测作用域；run 不存在返回 null。成员资格 = 成员位引用了会话
 *  （reader.sessionMembers，图注解可选）；按 rowId 去重——同一会话被多个
 *  成员位引用（如 execute 兼 verify，罕见）时优先图位结构归因，保证
 *  collectors 的 IN 查询不双计。
 *  solo:<taskId>（刀H）：不读 run-store，直接从 Prisma 合成单成员作用域
 *  （成员无图结构 → memberShortNames 回落短 taskId）。 */
export async function resolveRunScope(runId: string, prisma: PrismaClient): Promise<ObserveScope | null> {
  const cached = scopeCache.get(runId);
  if (cached) return cached;
  if (isSoloRunId(runId)) {
    const taskId = soloTaskIdOf(runId)!;
    const lookup = await sessionRefsByTaskIds([taskId], prisma);
    const ref = lookup.get(taskId);
    if (!ref) return null;
    const [label] = memberShortNames([{
      taskId, nodeId: null, generation: null, attempt: null, role: null, memberName: null,
    }]);
    const scope: ObserveScope = {
      kind: 'run',
      runId,
      members: [{
        rowId: ref.rowId,
        taskId,
        framework: ref.framework,
        label: label ?? taskId,
        structure: null,
      }],
    };
    scopeCache.set(runId, scope);
    return scope;
  }
  const stored = readRun(runId);
  if (!stored) return null;
  const lookup = await joinSessionRefs(stored.index, prisma);
  const members = new Map<string, ObserveMemberRef>();
  const memberNameByRowId = new Map<string, string | null>();
  // 成员资格 = 引用了会话（reader.sessionMembers），图注解只是归因元数据；
  // 同 sid 被图位与无图位双引用时优先图位结构（稳定排序：图位保序在前，
  // 无图位垫后），保证结构归因不因引用顺序漂移
  const referenced = [...stored.index.sessionMembers]
    .sort((a, b) => (b.graph != null ? 1 : 0) - (a.graph != null ? 1 : 0));
  for (const gm of referenced) {
    const sid = gm.member.sessionId;
    if (typeof sid !== 'string' || sid.length === 0) continue;
    const ref = lookup.get(sid);
    if (!ref || members.has(ref.rowId)) continue;
    const g = gm.graph;
    memberNameByRowId.set(ref.rowId, gm.member.name ?? null);
    members.set(ref.rowId, {
      rowId: ref.rowId,
      taskId: sid,
      framework: ref.framework,
      label: null,
      structure: g ? {
        nodeKey: `n-${g.nodeId}-g${g.generation}`,
        nodeId: g.nodeId,
        generation: g.generation,
        attempt: g.attempt,
        role: g.role,
        memberName: gm.member.name ?? null,
      } : null,
    });
  }
  // 成员短名（刀G）：归因徽标/泳道道名统一用图结构逻辑名（nodeId + 角色消
  // 歧），不用 session.label（首条 prompt 开头，不可读）；无图成员回落
  // manifest 成员名（剥「：第 N 代」装饰）——与 runMemberRowsOf 同一单点算法
  const memberList = [...members.values()];
  const names = memberShortNames(memberList.map(m => ({
    taskId: m.taskId,
    nodeId: m.structure?.nodeId ?? null,
    generation: m.structure?.generation ?? null,
    attempt: m.structure?.attempt ?? null,
    role: m.structure?.role ?? null,
    memberName: memberNameByRowId.get(m.rowId) ?? null,
  })));
  memberList.forEach((m, i) => { m.label = names[i] ?? m.taskId; });
  const scope: ObserveScope = { kind: 'run', runId, members: memberList };
  scopeCache.set(runId, scope);
  return scope;
}
