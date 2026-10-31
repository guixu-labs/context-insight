// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 域成员视图转发单点（design: docs/design/run-first-architecture/design.md
// §3.4，刀I1）。session 独有能力（Wire 轮次 / Score 卡 / workflow 分析 / 技能
// 正文 / 导出…）的 run 对偶端点 = scope 解析 + member 闸 + 委托既有 session
// 处理器（内部函数调用，无 HTTP 跳）——逻辑零复制；刀J 退役 session HTTP
// 路由时处理器模块平移到 lib，本层导入单点更新。
//
// member 闸语义（对齐 Audit sift 先例，是执行目标选择而非观看过滤）：
// - solo run / 单成员 run：member 缺省自动取唯一成员
// - 多成员 run：member 必填（400 member-required）
// - member ∉ scope：400 member-not-in-scope
// 转发时 query 重写：剥 member，注入 taskId + framework（scope 成员消歧行）。

import { NextRequest, NextResponse } from 'next/server';
import { withRouteLog } from '@/lib/api-route';
import { prisma } from '@/lib/db';
import { resolveRunScope } from '@/lib/run/observe/scope';
import { memberByTaskId } from '@/lib/observe/scope';

type SessionHandler = (request: NextRequest) => Promise<Response>;

export async function forwardMemberRequest(
  runId: string,
  handler: SessionHandler,
  request: NextRequest,
): Promise<Response> {
  const scope = await resolveRunScope(runId, prisma);
  if (!scope) {
    return NextResponse.json({ error: `Run not found: ${runId}`, reason: 'run-not-found' }, { status: 404 });
  }
  const memberTaskId =
    request.nextUrl.searchParams.get('member') ??
    (scope.members.length === 1 ? scope.members[0].taskId : null);
  if (!memberTaskId) {
    return NextResponse.json(
      { error: 'Missing required parameter: member（多成员 run 须指定成员会话）', reason: 'member-required' },
      { status: 400 },
    );
  }
  const member = memberByTaskId(scope).get(memberTaskId);
  if (!member) {
    return NextResponse.json(
      { error: `Member not in run scope: ${memberTaskId}`, reason: 'member-not-in-scope' },
      { status: 400 },
    );
  }
  const url = new URL('http://localhost/api/observe/session/forward');
  for (const [k, v] of request.nextUrl.searchParams.entries()) {
    if (k !== 'member' && k !== 'taskId' && k !== 'framework') url.searchParams.set(k, v);
  }
  url.searchParams.set('taskId', member.taskId);
  url.searchParams.set('framework', member.framework);
  const init: { method: string; body?: string } = { method: request.method };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.text();
  }
  return handler(new NextRequest(url, init));
}

/** run 成员视图 GET 路由工厂（withRouteLog 包装 + params.runId 解析）。 */
export function memberForwardGET(name: string, handler: SessionHandler) {
  return withRouteLog(
    `observe/run/[runId]/${name}`,
    async (request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
      const { runId } = await params;
      return forwardMemberRequest(runId, handler, request);
    },
  );
}

/** run 成员视图 POST 路由工厂（body 透传）。 */
export function memberForwardPOST(name: string, handler: SessionHandler) {
  return withRouteLog(
    `observe/run/[runId]/${name}`,
    async (request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
      const { runId } = await params;
      return forwardMemberRequest(runId, handler, request);
    },
  );
}
