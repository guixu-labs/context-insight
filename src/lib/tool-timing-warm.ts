// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on how to use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// wire 工具时长预热（服务端启动期，性能层）：deriveToolTiming 从捕获文件
// （7z at rest）同步解压+解析推导工具执行区间——MB 级捕获冷读秒级且全程
// 阻塞事件循环（期间全站请求冻结）。工具时长是 turns/评分/Perf 的请求路径
// 增补，首个命中者曾要为整段冷读买单（服务器重启后第一个进详情页的请求
// 恰好踩中，表现为「进详情页要加载半天」）。
//
// 预热在启动期后台跑：按会话活跃度降序（近者先用得上），文件间让出事件
// 循环，预热期到达的请求可插队；deriveToolTiming 的 statKey 缓存让预热
// 结果直接服务后续请求（mtime 未变零重读）。

import type { PrismaClient } from '@prisma/client';
import { deriveToolTiming } from '@/lib/tool-timing';
import { isClaudeFormatSession } from '@/lib/shared/session-format';

export interface WireWarmSummary {
  /** 扫描的会话总数（有 sourcePath 的行） */
  candidates: number;
  /** claude-format 会话数（真正触发捕获推导） */
  warmed: number;
  /** 非 claude-format 跳过数 */
  skipped: number;
}

export async function warmWireTimings(prisma: PrismaClient): Promise<WireWarmSummary> {
  const sessions = await prisma.session.findMany({
    where: { sourcePath: { not: null } },
    select: { taskId: true, sourcePath: true, framework: true, version: true, startTime: true },
    orderBy: [{ startTime: 'desc' }],
  });
  let warmed = 0;
  let skipped = 0;
  for (const s of sessions) {
    if (!s.sourcePath || !isClaudeFormatSession(s.framework, s.version)) {
      skipped++;
      continue;
    }
    // 捕获缺失/损坏由 deriveToolTiming 内部吞掉（返回 null，请求路径同款兜底）
    deriveToolTiming(s.sourcePath, s.taskId);
    warmed++;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { candidates: sessions.length, warmed, skipped };
}
