// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 归档计划（只看盘、不动盘）：用户点「导出」之前，界面就能照实说「N 个会话
// 按原文件、M 个以导出 db 代替」。与装配端点（../route.ts）同一个计划函数，
// 所见即所得。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { planSessionArchive, summarizeSessionArchive } from '@/lib/observe/session-archive';

export const GET = withRouteLog<{ params: Promise<{ runId: string }> }>('observe/run/export-archive/plan', async (
  _request: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
) => {
  const { runId } = await ctx.params;
  const scope = await resolveRunScope(runId, prisma);
  if (!scope) {
    return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
  }
  const plan = await planSessionArchive(runId, scope, prisma);
  return NextResponse.json(summarizeSessionArchive(plan));
});
