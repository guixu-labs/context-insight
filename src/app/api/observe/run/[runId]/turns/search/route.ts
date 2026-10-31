// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/observe/run/[runId]/turns/search —— run 跨成员全域关键词搜索
// （content / summary / 工具 args / result / error 五路匹配共用
// observe/collectors/search 单点；结果附 member 归因，契约镜像 session
// turns/search 端点；design: docs/design/run-observe-parity/design.md §4）。
// 搜索不受 member 过滤约束（跨成员定位是本端点的核心价值）。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { memberByRowId } from '@/lib/observe/scope';
import { matchTurnSearch } from '@/lib/observe/collectors/search';

export const GET = withRouteLog(
  'observe/run/turns/search',
  async (request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    const { searchParams } = request.nextUrl;
    const keyword = searchParams.get('keyword');
    // 命中上限（可选，Turns 搜索驻留面板传 50）：total 恒为全量命中数，
    // 截断由面板明示「已显示前 N」——不静默截
    const limitRaw = Number(searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : null;

    if (!keyword || keyword.trim().length === 0) {
      return NextResponse.json({ error: 'Missing required param: keyword' }, { status: 400 });
    }

    const scope = await resolveRunScope(runId, prisma);
    if (!scope) {
      return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
    }
    if (scope.members.length === 0) {
      return NextResponse.json({ items: [], total: 0 });
    }

    const rows = await prisma.turn.findMany({
      where: { sessionId: { in: scope.members.map(m => m.rowId) } },
      orderBy: [{ turnIndex: 'asc' }],
      include: {
        toolCalls: {
          select: { toolCallId: true, toolName: true, dispatchBridgeId: true, argsJson: true, resultJson: true, errorMessage: true },
        },
      },
    });

    const byRowId = memberByRowId(scope);
    let items = matchTurnSearch(rows, keyword, {
      memberOf: sessionId => {
        const member = byRowId.get(sessionId);
        return member ? { taskId: member.taskId, label: member.label } : null;
      },
    });
    const total = items.length;
    if (limit != null) items = items.slice(0, limit);

    return NextResponse.json({ items, total });
  },
);
