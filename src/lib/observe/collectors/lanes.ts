// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 泳道车道表 collector（master 947f4b2 平移，run-first 化）。车道是 run 级
// 概念：bundle 在湖上占一个范式目录，全体成员共享范式；solo run 即单成员。
// 三级解析：① 湖范式（listing 反查，60s TTL 缓存）× swimlane-lanes.json
// （范式 → 车道表，仓库根可配置）命中即用（声明即信任）② 范式缺失/未配置
// （本地会话未上湖、根级/sessions/ 通用目录）→ 全成员桥派发描述池化内容
// 签名推断（inferLanes，阈值与口径见该函数）③ 都不满足返回空表——泳道
// 回落贪心，非车道工作流零行为变化。source 标记来源，推断车道在泳道图上
// 带标记，避免读图时把猜测当成声明。

import type { PrismaClient } from '@prisma/client';
import type { ObserveScope } from '@/lib/observe/scope';
import { getLakeListing } from '@/lib/collection/lake-view/runs';
import { inferLanes } from '@/lib/swimlane-lanes';
import fs from 'node:fs';
import path from 'node:path';

export interface CollectLanesResult {
  paradigm: string | null;
  lanes: string[];
  source: 'paradigm' | 'inferred' | null;
}

export async function collectScopeLanes(
  prisma: PrismaClient,
  scope: ObserveScope,
): Promise<CollectLanesResult> {
  if (scope.members.length === 0) return { paradigm: null, lanes: [], source: null };

  // 湖范式反查：bundle 成员同目录 → 任一命中即为该 run 的范式
  let paradigm: string | null = null;
  try {
    const listing = await getLakeListing();
    const memberTaskIds = new Set(scope.members.map(m => m.taskId));
    paradigm = listing.sessions.find(s => memberTaskIds.has(s.sid) && s.paradigm)?.paradigm ?? null;
  } catch {
    // 湖不可达：范式缺失走 ② 推断，本地会话不受湖故障影响
  }

  const config = loadLanesConfig();
  const declared = paradigm ? config[paradigm] : undefined;
  if (declared) {
    return { paradigm, lanes: declared, source: 'paradigm' };
  }

  const bridges = await prisma.interactionBridge.findMany({
    where: { sessionId: { in: scope.members.map(m => m.rowId) } },
    select: { dispatchContent: true },
  });
  const inferred = inferLanes(bridges.map(b => b.dispatchContent), config);
  return {
    paradigm: inferred?.paradigm ?? paradigm,
    lanes: inferred?.lanes ?? [],
    source: inferred ? 'inferred' : null,
  };
}

let lanesCache: Record<string, string[]> | null = null;

function loadLanesConfig(): Record<string, string[]> {
  if (lanesCache !== null) return lanesCache;
  try {
    const p = path.join(process.cwd(), 'swimlane-lanes.json');
    if (fs.existsSync(p)) {
      lanesCache = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, string[]>;
      return lanesCache;
    }
  } catch (e) {
    console.warn('Failed to load swimlane-lanes.json:', e);
  }
  lanesCache = {};
  return lanesCache;
}
