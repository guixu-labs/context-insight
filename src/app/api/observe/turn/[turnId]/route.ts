// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 顶级 turn 详情（design: docs/design/run-first-architecture/design.md §3.4，刀J）：
// turnId 全局唯一（不依赖 run/taskId 语境）——session/turns/[turnId] 迁移为
// 顶级 /api/observe/turn/[turnId]，处理器原样复用（内部已包 withRouteLog +
// 富投影 includeContent/includeDetail/includeToolDetail 语义不变）。

import { withRouteLog } from '@/lib/api-route';
import { GET as sessionTurnDetailGET } from '@/lib/observe/session-handlers/turn-detail';

type TurnRouteCtx = { params: Promise<{ turnId: string }> };

export const GET = withRouteLog(
  'observe/turn/[turnId]',
  (request, ctx: TurnRouteCtx) => sessionTurnDetailGET(request, ctx),
);
