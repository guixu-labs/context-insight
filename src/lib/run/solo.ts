// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// solo run 合成层（design: docs/design/run-first-architecture/design.md §3.2/3.3，
// 刀H）。无 run 归属的 session 读取时合成为 `solo:<taskId>` 虚拟 run：不落盘
// （run-store 只持有真 bundle），由最小 manifest → parseAndIndex →
// buildViewModel 复用既有解析/布局/视图链——退化图（单节点/单 attempt/
// 第 1 次运行带）零手写几何，结构工作台零改动消费。

import type { PrismaClient } from '@prisma/client';
import { BUNDLE_SCHEMA, BUNDLE_VERSION } from '@/lib/run/model';
import { parseAndIndex, type RunIndex } from '@/lib/run/reader';
import { sessionRefsByTaskIds } from '@/lib/run/session-link';
import type { SessionRef } from '@/lib/run/model';
import { memberShortNames } from '@/lib/run/member-rows';
import { soloRunIdOf } from '@/lib/run/identity';

export interface SoloRunDetail {
  ref: SessionRef;
  index: RunIndex;
}

/** solo:<taskId> 解析（会话不存在返回 null）。framework 显式传入时精确消歧
 *  （同 sid 双行：proxy + native），缺省走 sessionRefsByTaskIds 原生优先规则。 */
export async function resolveSoloRun(
  prisma: PrismaClient,
  taskId: string,
  framework?: string,
): Promise<SoloRunDetail | null> {
  const lookup = await sessionRefsByTaskIds([taskId], prisma, framework);
  const ref = lookup.get(taskId);
  if (!ref) return null;
  return { ref, index: soloRunIndex(ref) };
}

/** 最小合法 manifest → RunIndex：单 session 成员 + execute 图注解。
 *  nodeId = 成员短名（memberShortNames 无图结构回落 = 短 taskId，与观测归因
 *  同一口径）；attemptResult 恒 succeeded（会话存在即已尝试，节点状态 passed）。
 *  导出供纯函数复用/测试（不触 DB）。 */
export function soloRunIndex(ref: SessionRef): RunIndex {
  const [shortName] = memberShortNames([{
    taskId: ref.taskId, nodeId: null, generation: null, attempt: null,
    role: null, memberName: null,
  }]);
  return parseAndIndex({
    schema: BUNDLE_SCHEMA,
    version: BUNDLE_VERSION,
    id: soloRunIdOf(ref.taskId),
    kind: 'workflow',
    name: ref.label,
    startedAt: ref.startTime,
    finishedAt: ref.endTime,
    data: {
      exportDataComplete: true,
      members: [{
        id: 'solo-session',
        kind: 'session',
        name: ref.label,
        sessionId: ref.taskId,
        location: 'solo',
        startedAt: ref.startTime,
        finishedAt: ref.endTime,
        annotation: {
          graph: {
            role: 'execute',
            nodeId: shortName ?? ref.taskId,
            generation: 0,
            attempt: 1,
            attemptResult: 'succeeded',
          },
        },
      }],
      relations: [],
    },
  });
}
