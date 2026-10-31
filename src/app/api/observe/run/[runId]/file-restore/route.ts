// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/observe/run/[runId]/file-restore —— run 合并单文件恢复（跨成员
// read/write 操作按时间序重编；design: docs/design/run-observe-parity/design.md §4）。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { scopeRowIds } from '@/lib/observe/scope';
import { restoreFileForRows } from '@/lib/observe/collectors/files';
import { validateScopeMember } from '@/lib/observe/collectors/turns';

export const GET = withRouteLog(
  'observe/run/file-restore',
  async (request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    const { searchParams } = request.nextUrl;
    const filePath = searchParams.get('filePath');
    if (!filePath) {
      return NextResponse.json({ error: 'Missing required query param: filePath', reason: 'missing-file-path' }, { status: 400 });
    }

    const scope = await resolveRunScope(runId, prisma);
    if (!scope) {
      return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
    }

    const member = searchParams.get('member');
    const memberError = validateScopeMember(scope, member);
    if (memberError) {
      return NextResponse.json({ error: `Member not in run: ${member}`, reason: memberError }, { status: 400 });
    }

    const rowIds = scopeRowIds(scope, member);
    if (rowIds.length === 0) {
      return NextResponse.json({ path: filePath, lines: [], maxLine: 0, opsUsed: 0 });
    }

    const result = await restoreFileForRows(prisma, rowIds, filePath);
    return NextResponse.json(result);
  },
);
