// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/observe/run/[runId]/skills —— run 合并技能观测（成员会话的
// SessionSkill 聚合 + SkillEvent 平铺带 member 归因；design:
// docs/design/run-observe-parity/design.md §4）。Skills tab 唯一数据源。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { collectScopeSkills } from '@/lib/observe/collectors/skills';
import { validateScopeMember } from '@/lib/observe/collectors/turns';

export const GET = withRouteLog(
  'observe/run/skills',
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

    const result = await collectScopeSkills(prisma, scope, { member });
    return NextResponse.json(result);
  },
);
