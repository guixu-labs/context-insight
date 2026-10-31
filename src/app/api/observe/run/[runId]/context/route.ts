// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/observe/run/[runId]/context —— run 上下文追踪数据（旧 session 视图
// ContextTracker 的 run 泛化，泳道同款结构：root agent = 成员会话、subagent
// 按 sid 池化）。Context tab 唯一数据源：全量瘦轮次投影（含 member 归因，
// 无 toolCalls/skillEvents/content 重负载字段）+ 每 agent 模型/窗口上限
// （root 取会话模型、subagent 首见非空轮模型归一）。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { collectScopeContext } from '@/lib/observe/collectors/context';

export const GET = withRouteLog(
  'observe/run/context',
  async (_request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;

    const scope = await resolveRunScope(runId, prisma);
    if (!scope) {
      return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
    }

    const data = await collectScopeContext(prisma, scope);
    return NextResponse.json({ turns: data.turns, agentLimits: data.agentLimits, total: data.turns.length });
  },
);
