// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// GET /api/observe/run/[runId]/file-reads —— run 合并文件读取分析（跨成员
// Read/shell 隐式读归并，session file-reads 端点同构；design:
// docs/design/run-observe-parity/design.md §4）。Files tab 数据源。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { memberByRowId, scopeRowIds } from '@/lib/observe/scope';
import { analyzeFileReadsForRows } from '@/lib/observe/collectors/files';
import { validateScopeMember } from '@/lib/observe/collectors/turns';

export const GET = withRouteLog(
  'observe/run/file-reads',
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

    const rowIds = scopeRowIds(scope, member);
    if (rowIds.length === 0) return NextResponse.json({ files: [], summary: { totalFiles: 0, totalReads: 0, filesWithOverlap: 0, redundancyRate: 0 } });

    const byRowId = memberByRowId(scope);
    const { files, summary } = await analyzeFileReadsForRows(prisma, rowIds, rowId => {
      const m = byRowId.get(rowId);
      return m ? { taskId: m.taskId, label: m.label } : null;
    });
    return NextResponse.json({ files, summary });
  },
);
