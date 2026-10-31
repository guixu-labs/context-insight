// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/observe/run/[runId]/turns —— run 合并轮次（light 投影 + offset
// 分页 + member 过滤，契约镜像 session turns 端点；design:
// docs/design/run-observe-parity/design.md §4）。单 turn 深钻走顶级
// /api/observe/turn/[turnId]（turnId 全局唯一，零新路由）。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { collectScopeTurns, validateScopeMember } from '@/lib/observe/collectors/turns';

function parsePositiveInt(v: string | null): number | null {
  if (v == null || v === '') return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const GET = withRouteLog(
  'observe/run/turns',
  async (request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    const { searchParams } = request.nextUrl;

    const scope = await resolveRunScope(runId, prisma);
    if (!scope) {
      return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
    }

    const member = searchParams.get('member');
    const memberError = validateScopeMember(scope, member);
    if (memberError) {
      return NextResponse.json({ error: `Member not in run: ${member}`, reason: memberError }, { status: 400 });
    }

    const page = parsePositiveInt(searchParams.get('page')) ?? 1;
    const pageSize = parsePositiveInt(searchParams.get('pageSize')) ?? undefined;
    const includeToolResult = searchParams.get('includeToolDetail') === 'true';
    // 轮级错误摘要（Overview）：服务端预算错误计数与消息提取，消费方不再
    // 需要 includeToolDetail 的 18MB 级原文
    const includeErrorDigest = searchParams.get('includeErrorDigest') === 'true';

    const result = await collectScopeTurns(prisma, scope, { member, page, pageSize, includeToolResult, includeErrorDigest });
    return NextResponse.json(result);
  },
);
