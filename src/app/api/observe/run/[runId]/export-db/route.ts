// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 工作台「导出 SQLite」端点：把 run 全员成员会话（solo = 1 行；bundle = 全部
// 成员位引用的会话行）序列化成一份独立 SQLite 导出件——insight 自己的容器格式
// （ExportMeta 格式头 + 每成员一行 Session 及其派生行），经导入向导 / ctxi
// import 原样导回，与回收站归档同一条写管线（export-service）。run 级聚合端点
// （非成员视图转发），scope 解析复用 run 域单点；工作台导出钮与 CLI `ctxi
// export` 同一端点——一份数据两个入口。

import fs from 'node:fs';
import stream from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { readRun } from '@/lib/run/run-store';
import { isSoloRunId } from '@/lib/run/identity';
import { exportSessionRows } from '@/lib/ingest/export-service';
import { dbExportContentDisposition } from '@/lib/observe/export-name';
import { logInfo } from '@/lib/logger';

export const GET = withRouteLog<{ params: Promise<{ runId: string }> }>('observe/run/export-db', async (
  _request: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
) => {
  const { runId } = await ctx.params;
  const scope = await resolveRunScope(runId, prisma);
  if (!scope) {
    return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
  }

  // run 身份：solo 合成作用域无 run-store 记录（名取成员 taskId）
  const solo = isSoloRunId(runId);
  const stored = solo ? null : readRun(runId);
  const summary = await exportSessionRows(scope.members.map(m => m.rowId), undefined, prisma);
  const bytes = fs.statSync(summary.path).size;
  logInfo('route:observe/run/export-db', '会话已导出（db）', {
    runId, sessions: summary.sessions, turns: summary.turns, bytes,
  });

  const file = fs.createReadStream(summary.path);
  // 流关闭（读完 / 客户端中断）即删临时件；error 也走 close，不留残骸
  file.on('close', () => {
    try { fs.unlinkSync(summary.path); } catch { /* best-effort */ }
  });
  try {
    return new NextResponse(stream.Readable.toWeb(file) as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-sqlite3',
        'Content-Disposition': dbExportContentDisposition({
          solo,
          runId,
          taskId: solo ? scope.members[0]?.taskId ?? null : null,
          runName: solo ? null : stored?.manifest.name ?? null,
        }),
        'Content-Length': String(bytes),
      },
    });
  } catch (error) {
    file.destroy();
    throw error;
  }
});
