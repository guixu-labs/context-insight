// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话原始文件归档（run 级聚合端点，非成员视图转发）：把 run 全员成员在源端
// 的原件按原格式打成一个 zip 流式回给客户端——有原件出原件（字节保真，已
// 压缩形态原样），没有原件的成员以该会话的导出 db（7z）代替，包根
// export-manifest.json 逐会话记明用的是哪种。scope 解析复用 run 域单点；
// 计划（谁有原件）在同目录 plan/ 端点，装配在 observe/session-archive。
// 响应体是文件流（归档可过 4GB，不整包进内存）；临时件在流关闭后删除。

import fs from 'node:fs';
import stream from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { planSessionArchive, buildSessionArchive, archiveNameInput } from '@/lib/observe/session-archive';
import { archiveExportContentDisposition } from '@/lib/observe/export-name';
import { logInfo } from '@/lib/logger';

export const GET = withRouteLog<{ params: Promise<{ runId: string }> }>('observe/run/export-archive', async (
  _request: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
) => {
  const { runId } = await ctx.params;
  const scope = await resolveRunScope(runId, prisma);
  if (!scope) {
    return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
  }
  const plan = await planSessionArchive(runId, scope, prisma);
  const built = await buildSessionArchive(plan, prisma);
  logInfo('route:observe/run/export-archive', '会话已导出（原始文件归档）', {
    runId, originals: plan.originals, dbs: plan.dbs, files: built.entries, bytes: built.bytes,
  });

  const file = fs.createReadStream(built.path);
  // 流关闭（读完 / 客户端中断）即删临时件；error 也走 close，不留残骸
  file.on('close', () => {
    try { fs.unlinkSync(built.path); } catch { /* best-effort */ }
  });
  try {
    return new NextResponse(stream.Readable.toWeb(file) as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': archiveExportContentDisposition(archiveNameInput(plan)),
        'Content-Length': String(built.bytes),
      },
    });
  } catch (error) {
    file.destroy();
    throw error;
  }
});
