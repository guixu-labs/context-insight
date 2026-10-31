// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 成员表 IT：manifest → parseAndIndex → buildViewModel → joinSessionRefs
// → attachSessionRefs → runMemberRowsOf 全链路回归锁——manifest 成员名
// （SessionMemberRef.name）须落盘 RunMemberRow.memberName 并传入
// memberShortNames：无图结构回落显示 manifest 基名而非短 taskId，与
// resolveRunScope 泳道名同一单点算法口径（此前映射硬编码 null，回落链路
// 对本表是死代码）。独立 sid（ses_mrows_*）避免并行测试文件共享 test.db
// 的唯一约束/删除竞态。

import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { parseAndIndex } from '@/lib/run/reader';
import { buildViewModel } from '@/lib/run/view-model';
import { joinSessionRefs, attachSessionRefs } from '@/lib/run/session-link';
import { runMemberRowsOf, memberShortNames } from '@/lib/run/member-rows';

const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });

const manifest = {
  schema: 'workflow-bundle',
  version: 1,
  id: 'mrowsdemo01',
  kind: 'workflow',
  name: 'member-rows-test',
  startedAt: null,
  finishedAt: null,
  data: {
    exportDataComplete: true,
    members: [
      {
        id: 'M_BUILD_EXEC',
        kind: 'session',
        name: 'build：第 0 代第 1 次执行',
        sessionId: 'ses_mrows_a',
        nodeId: 'build', generation: 0, attempt: 1, attemptResult: 'succeeded',
        annotation: { note: '执行', role: 'execute' },
      },
      {
        id: 'M_BUILD_VERIFY',
        kind: 'session',
        name: 'build：第 0 代第 1 次验收',
        sessionId: 'ses_mrows_b',
        nodeId: 'build', generation: 0, attempt: 1,
        verification: { type: 'script', status: 'passed', reason: 'exit 0' },
        annotation: { note: '验收', role: 'verify' },
      },
      {
        id: 'M_DEPLOY_EXEC',
        kind: 'session',
        name: 'deploy：第 1 代第 1 次执行',
        sessionId: 'ses_mrows_c',
        nodeId: 'deploy', generation: 1, attempt: 1, attemptResult: 'succeeded',
        annotation: { note: '执行', role: 'execute' },
      },
    ],
    relations: [],
  },
};

describe('runMemberRowsOf：manifest 成员名透传（审查意见修复回归锁）', () => {
  it('成员行携带 manifest 成员名（SessionMemberRef.name 落盘 RunMemberRow.memberName）', async () => {
    const vm = buildViewModel(parseAndIndex(manifest));
    const seeds: Array<{ id: string; sid: string }> = [];
    try {
      for (const sid of ['ses_mrows_a', 'ses_mrows_b', 'ses_mrows_c']) {
        seeds.push({ id: (await prisma.session.create({ data: { taskId: sid, framework: 'opencode' } })).id, sid });
      }
      attachSessionRefs(vm, await joinSessionRefs(parseAndIndex(manifest), prisma));
      const bySid = new Map(runMemberRowsOf(vm).map(r => [r.taskId, r]));
      expect(bySid.get('ses_mrows_a')?.memberName).toBe('build：第 0 代第 1 次执行');
      expect(bySid.get('ses_mrows_b')?.memberName).toBe('build：第 0 代第 1 次验收');
      expect(bySid.get('ses_mrows_c')?.memberName).toBe('deploy：第 1 代第 1 次执行');
    } finally {
      for (const s of seeds) await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
    }
  });

  it('有图成员 displayName 仍为 nodeId 消歧名（修复不回归）', async () => {
    const vm = buildViewModel(parseAndIndex(manifest));
    const seeds: Array<{ id: string }> = [];
    try {
      for (const sid of ['ses_mrows_a', 'ses_mrows_b', 'ses_mrows_c']) {
        seeds.push(await prisma.session.create({ data: { taskId: sid, framework: 'opencode' } }));
      }
      attachSessionRefs(vm, await joinSessionRefs(parseAndIndex(manifest), prisma));
      const bySid = new Map(runMemberRowsOf(vm).map(r => [r.taskId, r]));
      expect(bySid.get('ses_mrows_a')?.displayName).toBe('build');
      expect(bySid.get('ses_mrows_b')?.displayName).toBe('build·验收');
      expect(bySid.get('ses_mrows_c')?.displayName).toBe('deploy');
    } finally {
      for (const s of seeds) await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
    }
  });

  it('无图结构回落：memberName 命中时显示剥装饰 manifest 基名，而非短 taskId', async () => {
    const vm = buildViewModel(parseAndIndex(manifest));
    const seeds: Array<{ id: string }> = [];
    try {
      for (const sid of ['ses_mrows_a', 'ses_mrows_b', 'ses_mrows_c']) {
        seeds.push(await prisma.session.create({ data: { taskId: sid, framework: 'opencode' } }));
      }
      attachSessionRefs(vm, await joinSessionRefs(parseAndIndex(manifest), prisma));
      const rows = runMemberRowsOf(vm);
      // 与 runMemberRowsOf 内部同构的映射入参，模拟成员失去图定位的回落视图：
      // 基名 = 剥「：第 N 代…」装饰后的 manifest 名；execute/verify 同基名时
      // 逐级消歧（·g → ·attempt → ·序号，此处全 null 落到序号档）
      const names = memberShortNames(rows.map(r => ({
        taskId: r.taskId, nodeId: null, generation: null, attempt: null,
        role: null, memberName: r.memberName,
      })));
      const bySid = new Map(rows.map((r, i) => [r.taskId, names[i]]));
      expect(bySid.get('ses_mrows_a')).toBe('build·1');
      expect(bySid.get('ses_mrows_b')).toBe('build·2');
      expect(bySid.get('ses_mrows_c')).toBe('deploy');
    } finally {
      for (const s of seeds) await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
    }
  });
});
