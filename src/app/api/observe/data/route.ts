// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一资产列表（design: docs/design/unified-workbench/design.md §3.2/§7）。
// 会话 + run 单表混排（kind=all 默认）/单类过滤（kind=session|run）；
// 混排分页与 run 会话隔离闸统一在 list-service 单点（修复此前翻页/搜索
// 路由未隔离的缺口）。无 kind 参数 = all（向后兼容）。

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { withRouteLog } from '@/lib/api-route';
import { queryAssetList } from '@/lib/collection/list-service';
import type { AssetKindFilter } from '@/lib/collection/types';

export const GET = withRouteLog('observe/data', async (request: NextRequest) => {
  const { searchParams } = request.nextUrl;
  const page = Math.max(1, Number(searchParams.get('page') ?? 1));
  const pageSize = Math.max(1, Math.min(100, Number(searchParams.get('pageSize') ?? 20)));
  const kindParam = searchParams.get('kind');
  const kind: AssetKindFilter = kindParam === 'session' || kindParam === 'run' ? kindParam : 'all';

  const result = await queryAssetList(prisma, {
    q: searchParams.get('q')?.trim() ?? '',
    kind,
    user: searchParams.get('user') ?? undefined,
    isSubagent: searchParams.get('isSubagent') ?? undefined,
    page,
    pageSize,
  });

  return NextResponse.json({
    items: result.items,
    total: result.total,
    page,
    ...(result.totalCount != null ? { totalCount: result.totalCount } : {}),
  });
});
