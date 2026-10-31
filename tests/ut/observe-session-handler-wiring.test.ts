// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// session-handlers 接线回归锁：route 文件只 re-export lib handler（防两份
// 副本静默分叉）+ turn 详情经接线 route 的行为锁（taskId 回传 / overhead
// 公式）。join 语义（首发派发等）由 subagent-identity.test.ts 经同两条
// route 覆盖，此处不重复。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '../setup';
import { GET as turnDetailGet, __clearTurnDetailCaches } from '@/app/api/observe/session/turns/[turnId]/route';

import * as scorecardRoute from '@/app/api/observe/session/scorecard/route';
import * as scorecardAdjudicateRoute from '@/app/api/observe/session/scorecard/adjudicate/route';
import * as scorecardBaselineRoute from '@/app/api/observe/session/scorecard/baseline/route';
import * as scorecardBenchReportRoute from '@/app/api/observe/session/scorecard/bench-report/route';
import * as scorecardSemanticRoute from '@/app/api/observe/session/scorecard/semantic/route';
import * as skillContentRoute from '@/app/api/observe/session/skill-content/route';
import * as skillContentAuditRoute from '@/app/api/observe/session/skill-content-audit/route';
import * as skillCoverageRoute from '@/app/api/observe/session/skill-coverage/route';
import * as turnsRoute from '@/app/api/observe/session/turns/route';
import * as turnDetailRoute from '@/app/api/observe/session/turns/[turnId]/route';
import * as wireRoundsRoute from '@/app/api/observe/session/wire-rounds/route';
import * as workflowRoute from '@/app/api/observe/session/workflow/route';

import * as scorecardHandler from '@/lib/observe/session-handlers/scorecard';
import * as scorecardAdjudicateHandler from '@/lib/observe/session-handlers/scorecard-adjudicate';
import * as scorecardBaselineHandler from '@/lib/observe/session-handlers/scorecard-baseline';
import * as scorecardBenchReportHandler from '@/lib/observe/session-handlers/scorecard-bench-report';
import * as scorecardSemanticHandler from '@/lib/observe/session-handlers/scorecard-semantic';
import * as skillContentHandler from '@/lib/observe/session-handlers/skill-content';
import * as skillContentAuditHandler from '@/lib/observe/session-handlers/skill-content-audit';
import * as skillCoverageHandler from '@/lib/observe/session-handlers/skill-coverage';
import * as turnsHandler from '@/lib/observe/session-handlers/turns';
import * as turnDetailHandler from '@/lib/observe/session-handlers/turn-detail';
import * as wireRoundsHandler from '@/lib/observe/session-handlers/wire-rounds';
import * as workflowHandler from '@/lib/observe/session-handlers/workflow';

const TASK = 'wiring-it-task';
let detailTurnId: string;
let sessionId: string;

beforeAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK } });
  __clearTurnDetailCaches();
  const session = await prisma.session.create({ data: { taskId: TASK, framework: 'opencode' } });
  sessionId = session.id;
  await prisma.turn.create({
    data: { sessionId, turnIndex: 0, role: 'user', content: 'x'.repeat(70) },
  });
  await prisma.turn.create({
    data: { sessionId, turnIndex: 1, role: 'assistant', inputMessagesTokens: 350, model: 'glm-4.6' },
  });
  const det = await prisma.turn.create({
    data: { sessionId, turnIndex: 2, role: 'assistant', inputMessagesTokens: 500, inputMessagesJson: '[]', model: 'glm-4.6' },
  });
  detailTurnId = det.id;
}, 60_000);

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: TASK } }).catch(() => {});
});

describe('session-handlers 接线：route 只 re-export，防内联副本静默分叉', () => {
  type Mod = Record<string, unknown>;
  const wiring: Array<{ name: string; route: Mod; handler: Mod; verbs: string[] }> = [
    { name: 'scorecard', route: scorecardRoute, handler: scorecardHandler, verbs: ['GET', 'POST'] },
    { name: 'scorecard/adjudicate', route: scorecardAdjudicateRoute, handler: scorecardAdjudicateHandler, verbs: ['POST'] },
    { name: 'scorecard/baseline', route: scorecardBaselineRoute, handler: scorecardBaselineHandler, verbs: ['POST'] },
    { name: 'scorecard/bench-report', route: scorecardBenchReportRoute, handler: scorecardBenchReportHandler, verbs: ['GET', 'POST'] },
    { name: 'scorecard/semantic', route: scorecardSemanticRoute, handler: scorecardSemanticHandler, verbs: ['POST'] },
    { name: 'skill-content', route: skillContentRoute, handler: skillContentHandler, verbs: ['GET'] },
    { name: 'skill-content-audit', route: skillContentAuditRoute, handler: skillContentAuditHandler, verbs: ['GET'] },
    { name: 'skill-coverage', route: skillCoverageRoute, handler: skillCoverageHandler, verbs: ['GET'] },
    { name: 'turns', route: turnsRoute, handler: turnsHandler, verbs: ['GET'] },
    { name: 'turns/[turnId]', route: turnDetailRoute, handler: turnDetailHandler, verbs: ['GET'] },
    { name: 'wire-rounds', route: wireRoundsRoute, handler: wireRoundsHandler, verbs: ['GET'] },
    { name: 'workflow', route: workflowRoute, handler: workflowHandler, verbs: ['GET'] },
  ];

  it('route 导出的每个 verb 与 lib handler 同一函数（route 内联即红）', () => {
    for (const w of wiring) {
      for (const verb of w.verbs) {
        expect(w.route[verb], `${w.name} ${verb} 必须来自 session-handlers 同一实现`).toBe(w.handler[verb]);
      }
    }
  });

  it('Next 段配置字面量不因接线丢失（maxDuration）', () => {
    expect((scorecardBaselineRoute as { maxDuration?: number }).maxDuration).toBe(60);
    expect((scorecardBenchReportRoute as { maxDuration?: number }).maxDuration).toBe(60);
  });

  it('测试钩子经 route re-export 可达（__clearTurnDetailCaches）', () => {
    expect(turnDetailRoute.__clearTurnDetailCaches).toBe(turnDetailHandler.__clearTurnDetailCaches);
  });
});

describe('turn 详情接线 route 行为锁', () => {
  it('返回成员 taskId（run 节点 deep-link 解析：turnId → 所属成员 → 节点）', async () => {
    const res = await turnDetailGet(
      new NextRequest(`http://localhost/api/observe/session/turns/${detailTurnId}`),
      { params: Promise.resolve({ turnId: detailTurnId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { taskId: string | null; sessionId: string };
    expect(body.taskId).toBe(TASK);
    expect(body.sessionId).toBe(sessionId);
  });

  it('systemOverhead = 首 assistant 输入 − 前序可见估算（prior-assistant toolArgs 死分支已删）', async () => {
    __clearTurnDetailCaches();
    const res = await turnDetailGet(
      new NextRequest(`http://localhost/api/observe/session/turns/${detailTurnId}`),
      { params: Promise.resolve({ turnId: detailTurnId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { systemOverheadTokens: number };
    // 350（首 assistant inputMessagesTokens）− round(70/3.5)=20（前序 user 70 字符）
    expect(body.systemOverheadTokens).toBe(330);
  });
});
