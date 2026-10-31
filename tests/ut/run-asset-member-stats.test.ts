// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 成员指标透传回归锁（PR #4 审查意见）：SessionRef 的
// totalCost/model/totalLatencyMs/version 必须由 joinSessionRefs 的 select
// 透传——run 行 Cost 汇总、模型分布（displayModel 归一）、endTime 缺端墙钟
// 回落、proxy 行活跃窗口展开（isProxyVersion）的唯一值源。端到端走
// listRunItems（真实 run 盘上目录 + 真实 Prisma 行 + getActiveSplitMap 同库
// 单例），select 透传断链即红：聚合恒 0/空、proxy 行 active 口径错。
// 独立 sid（ses_stats_*）避免与并行测试文件共享 test.db 的删除竞态。

import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveRun } from '@/lib/run/run-store';
import { listRunItems } from '@/lib/collection/run-asset';
import type { RunManifest } from '@/lib/run/model';

const prisma = new PrismaClient();

// 三成员：A 原生（Cost/模型/墙钟），B 原生（endTime 缺端 → latency 回落），
// P proxy 记录（version 判定 → assistant latency 展开活跃窗口）
const manifest: RunManifest = {
  schema: 'workflow-bundle',
  version: 1,
  id: 'statsdemo01',
  kind: 'workflow',
  name: 'stats-pass-test',
  startedAt: null,
  finishedAt: null,
  data: {
    exportDataComplete: true,
    members: [
      {
        id: 'M_A', kind: 'session', name: 'build：第 0 代第 1 次执行',
        sessionId: 'ses_stats_a',
        nodeId: 'build', generation: 0, attempt: 1, attemptResult: 'succeeded',
        annotation: { note: '执行', role: 'execute' },
      },
      {
        id: 'M_B', kind: 'session', name: 'build：第 0 代第 1 次验收',
        sessionId: 'ses_stats_b',
        nodeId: 'build', generation: 0, attempt: 1,
        verification: { type: 'script', status: 'passed', reason: 'exit 0' },
        annotation: { note: '验收', role: 'verify' },
      },
      {
        id: 'M_P', kind: 'session', name: 'build：第 1 代第 1 次执行',
        sessionId: 'ses_stats_p',
        nodeId: 'build', generation: 1, attempt: 1, attemptResult: 'succeeded',
        annotation: { note: '执行', role: 'execute' },
      },
    ],
    relations: [],
  },
};

describe('Run 成员指标透传：totalCost/model/totalLatencyMs/version（PR #4 审查意见）', () => {
  it('listRunItems 聚合 run 行：Cost 汇总非 0、模型分布归一计数、endTime 缺端回落 latency、proxy 行活跃窗口展开', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxi-run-stats-'));
    saveRun(manifest, null, root);
    const a = await prisma.session.create({
      data: {
        taskId: 'ses_stats_a', framework: 'opencode',
        model: 'volc-gateway/deepseek-v4-pro', totalCost: 1.5,
        startTime: new Date('2026-10-20T02:00:00Z'), endTime: new Date('2026-10-20T02:01:00Z'),
      },
    });
    const b = await prisma.session.create({
      data: {
        taskId: 'ses_stats_b', framework: 'opencode',
        model: 'gpt-5', totalCost: 0.25, totalLatencyMs: 8_000,
        startTime: new Date('2026-10-20T03:00:00Z'),  // endTime 缺端 → 墙钟回落 Σ latency
      },
    });
    const p = await prisma.session.create({
      data: {
        taskId: 'ses_stats_p', framework: 'opencode-proxy',
        model: 'claude-sonnet-4', totalCost: 0.5, version: 'opencode-proxy',
        startTime: new Date('2026-10-20T04:00:00Z'), endTime: new Date('2026-10-20T04:11:00Z'),
      },
    });
    try {
      await prisma.turn.createMany({
        data: [
          // A 原生行：assistant latency 不展开（isProxyVersion(null)=false），
          // 全部 turn 同刻 = 单零跨度段 → activeMs null
          { sessionId: a.id, turnIndex: 0, role: 'user', createdAt: new Date('2026-10-20T02:00:00Z') },
          { sessionId: a.id, turnIndex: 1, role: 'assistant', latencyMs: 4_000, createdAt: new Date('2026-10-20T02:00:00Z') },
          // P proxy 行：assistant latency 展开 [ts-lat, ts]；两窗间隔 > 5min
          // 断开成两段（4s + 3s），同刻会并段算不出独立窗口（不放 user 点：
          // 点与首窗间隔 < 5min 会桥接进段，污染窗口和的算术）
          { sessionId: p.id, turnIndex: 0, role: 'assistant', latencyMs: 4_000, createdAt: new Date('2026-10-20T04:00:20Z') },
          { sessionId: p.id, turnIndex: 1, role: 'assistant', latencyMs: 3_000, createdAt: new Date('2026-10-20T04:10:00Z') },
        ],
      });
      const { items } = await listRunItems({ root, prisma });
      const stats = items.find(i => i.runId === 'statsdemo01')?.memberStats;
      expect(stats).not.toBeNull();
      expect(stats!.joinedCount).toBe(3);
      // Cost 汇总：select 未透传 totalCost 时恒 0（审查意见 ①）
      expect(stats!.totalCost).toBeCloseTo(2.25);
      // 模型分布：displayModel 归一（去 provider 前缀）后按会话计数，同数按名序
      expect(stats!.models).toEqual([
        { model: 'claude-sonnet-4', count: 1 },
        { model: 'deepseek-v4-pro', count: 1 },
        { model: 'gpt-5', count: 1 },
      ]);
      // 时长口径：A 墙钟 60s + B 缺端回落 8s + P 墙钟 11min（04:00→04:11）
      expect(stats!.totalDurationMs).toBe(60_000 + 8_000 + 660_000);
      // proxy 活跃窗口：version 未透传时 isProxyVersion 恒 false → 活跃恒 null（审查意见 ②）
      expect(stats!.totalActiveMs).toBe(7_000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      for (const s of [a, b, p]) {
        await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
      }
    }
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
