// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { freezeInsightSession } from '@/lib/lineage/session';
import { lineageError } from '@/lib/lineage/client';
import { withRouteLog } from '@/lib/api-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const POST = withRouteLog('lineage/sessions/snapshots', async (request: Request, context: { params: Promise<{ sessionId: string }> }) => {
  try {
    const { sessionId } = await context.params;
    return Response.json(await freezeInsightSession(sessionId, request.signal), {
      status: 201, headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) { return lineageError(error); }
});
