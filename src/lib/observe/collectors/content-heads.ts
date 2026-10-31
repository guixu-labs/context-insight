// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how to use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Turn 正文头投影（性能层，单一源）：contentSummary 缺失时消费方只需要正文
// 前 N 字符（turns/context 200、executions 80），但 Prisma findMany 无法表达
// substr——按列全取会把整库 35MB 级 content 物化进 JS 后丢弃。本模块把投影
// 下推到 SQLite（substr 原生字符语义），只取命中行的头 N 字符。
//
// 回退口径与各 collector 原表达式逐字符对齐：`contentSummary ?? content?
// .substring(0, N) ?? null`——仅 contentSummary IS NULL 触发（空串不算，?? 不
// 捕获 falsy），content 为空/NULL 时无回退值。

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

/** 作用域内 contentSummary 缺失轮的正文头（id → 前 headLen 字符）。
 *  按成员会话行过滤（成员数个位数级参数），一次查询覆盖整页/整段回退。 */
export async function fetchContentHeads(
  prisma: PrismaClient,
  sessionIds: string[],
  headLen: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (sessionIds.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{ id: string; head: string }>>(
    Prisma.sql`SELECT id, substr(content, 1, ${headLen}) AS head FROM Turn
      WHERE sessionId IN (${Prisma.join(sessionIds)})
        AND contentSummary IS NULL AND content IS NOT NULL`,
  );
  for (const r of rows) out.set(r.id, r.head);
  return out;
}
