// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { coreRequest, lineageError, LineageError, readBounded } from '@/lib/lineage/client';
import { withRouteLog } from '@/lib/api-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const id = '[a-z]+_[a-f0-9]{32,64}';
const readRoutes = new RegExp(`^(health|v1/(capabilities|runs|runs/${id}(/(trace|repairs|live/state))?|snapshots/${id}|sources/${id}/content|jobs/${id}|repairs/${id}|reports/${id}))$`);
const writeRoutes = new RegExp(`^v1/(runs|sources|query|lineage|reports(/check)?|repairs|runs/${id}/(snapshots|imports|live/(append|upsert|query|freeze))|snapshots/${id}/(observations|resolve)|jobs/${id}/cancel)$`);
type RouteContext = { params: Promise<{ path: string[] }> };

async function forward(request: Request, context: RouteContext) {
  try {
    const { path } = await context.params;
    const route = path.join('/');
    const writing = request.method === 'POST';
    if (!(writing ? writeRoutes : readRoutes).test(route)) {
      throw new LineageError('NOT_FOUND', 'Unsupported Core API route', 404);
    }
    const headers = new Headers();
    for (const name of ['Content-Type', 'Idempotency-Key']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const limit = route === 'v1/sources' || route.endsWith('/live/upsert') ? 64 * 1024 * 1024 : 1024 * 1024;
    const body = writing ? Buffer.from(await readBounded(request.body, limit)) : undefined;
    return await coreRequest('/' + route + new URL(request.url).search, {
      method: request.method, headers, body, signal: request.signal,
    });
  } catch (error) { return lineageError(error); }
}

export const GET = withRouteLog('lineage/core', forward);
export const POST = GET;
