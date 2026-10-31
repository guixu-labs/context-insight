// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { NextRequest, NextResponse } from 'next/server';
import { logError } from '@/lib/logger';
import { prisma } from '@/lib/db';
import type { TurnDigest, TurnDigestSkillEvent } from '@/lib/shared/turn-digest';

/**
 * 轮次轻摘要处理器（run 转发端点 `run/[runId]/turn-digest` 消费，刀J 平移层）。
 *
 * 服务聚合型消费面（Audit 审计目标发现 / Score 评分卡跳转映射）：两条最小
 * 查询——轮次身份三字段（turnId/turnIndex/isSubagent）+ skill 事件 (name,
 * eventType) 聚合计数。**刻意不做** member-turns 的重计算（systemOverhead
 * N+1 / wire 捕获解压 / 全字段序列化）：2504 轮会话实测摘要 <100ms/160KB，
 * 全量 4.5s(冷)/2.7MB。消费方需要正文/token 再走 member-turns。
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const taskId = searchParams.get('taskId');
    const framework = searchParams.get('framework');

    if (!taskId) {
      return NextResponse.json(
        { error: 'Missing required query param: taskId' },
        { status: 400 },
      );
    }

    const sessionWhere: Record<string, string> = { taskId };
    if (framework) sessionWhere.framework = framework;

    const session = await prisma.session.findFirst({ where: sessionWhere });
    if (!session) {
      return NextResponse.json(
        { error: `Session not found for taskId: "${taskId}"` },
        { status: 404 },
      );
    }

    const [turns, rawEvents] = await Promise.all([
      prisma.turn.findMany({
        where: { sessionId: session.id },
        select: { id: true, turnIndex: true, isSubagent: true },
        orderBy: [{ turnIndex: 'asc' }],
      }),
      prisma.skillEvent.findMany({
        where: { turn: { sessionId: session.id } },
        select: { skillName: true, eventType: true },
        orderBy: [{ id: 'asc' }],
      }),
    ]);

    // (skillName, eventType) → count 聚合（首见序；count 保留事件量语义，
    // 消费方按需展开——deriveAuditableTargets 的 skillEventCount）
    const agg = new Map<string, TurnDigestSkillEvent>();
    for (const e of rawEvents) {
      if (!e.skillName) continue;
      const key = `${e.eventType}\u0000${e.skillName}`;
      const cur = agg.get(key);
      if (cur) cur.count += 1;
      else agg.set(key, { skillName: e.skillName, eventType: e.eventType, count: 1 });
    }

    const digest: TurnDigest = {
      turns: turns.map(t => ({ turnId: t.id, turnIndex: t.turnIndex, isSubagent: t.isSubagent })),
      skillEvents: [...agg.values()],
    };
    return NextResponse.json(digest);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError('route:observe/session/turn-digest', '查询失败', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
