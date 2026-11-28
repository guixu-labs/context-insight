// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// DB 导出→再导入的会话身份保持 IT（身份归会话、格式归文件）。
// 客户路径：会话列表「导出」→ context_session_<taskId>.db → 别处导入。
// 修复前：导入链只认容器格式（srcType=cannbot-insight），源级 framework
// 兜底把容器身份冒充 agent 身份落库（framework='context-insight'、version
// null），且记录类不命中既有行 → 同实例重导入产生重复行；导出件无格式头。
// 修复后：身份从导出件 Session 行的会话级声明读取（readSessionMeta 能力）
// 原样透传（含 -proxy 记录类后缀），重导入幂等 merge；导出件带 ExportMeta
// 格式头；deltaRefresh 按 sourcePath 文件事实路由适配器。

import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exportSession, exportSessionRows } from '../../src/lib/ingest/export-service.ts';
import { importSession, deltaRefreshSession } from '../../src/lib/ingest/data-service.ts';
import { listSessions, detectContent } from '../../src/lib/ingest/adapters/context-insight.ts';

const prisma = new PrismaClient();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-identity-'));

const SEED_TURNS = [
  { turnIndex: 0, role: 'user', content: 'how to fuse matmul on npu' },
  { turnIndex: 1, role: 'assistant', content: 'use torch_npu.matmul then check the fuse pass report' },
];

async function seedSession(taskId: string, framework: string, version: string | null) {
  const session = await prisma.session.create({
    data: {
      taskId,
      label: `label of ${taskId}`,
      query: `query of ${taskId}`,
      framework,
      version,
      startTime: new Date('2026-10-01T10:00:00.000Z'),
      endTime: new Date('2026-10-01T10:30:00.000Z'),
      sourcePath: '/tmp/seed-source',
    },
  });
  await prisma.turn.createMany({
    data: SEED_TURNS.map(t => ({ ...t, sessionId: session.id })),
  });
}

function artifactPath(taskId: string): string {
  return path.join(tmpDir, `context_session_${taskId}.db`);
}

const TASK_IDS = [
  'it-expid-proxy', 'it-expid-native', 'it-expid-merge', 'it-expid-refresh',
  // run 作用域一杆多行（工作台「导出 SQLite」）的三个成员
  'it-expid-member-a', 'it-expid-member-b', 'it-expid-member-c',
];

afterAll(async () => {
  for (const taskId of TASK_IDS) {
    await prisma.session.deleteMany({ where: { taskId } }).catch(() => { /* best-effort */ });
  }
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('E2E: DB 导出→再导入的会话身份保持', () => {
  it('proxy 记录类：framework/version 原样透传（含 -proxy 后缀）', async () => {
    const taskId = 'it-expid-proxy';
    await seedSession(taskId, 'claude-code-proxy', '2.1.278-proxy');
    const artifact = artifactPath(taskId);
    await exportSession(taskId, artifact, prisma);

    // 删原行 = 模拟「导入到另一实例」的新库路径
    await prisma.session.deleteMany({ where: { taskId } });
    const res = await importSession(artifact, taskId, prisma, artifact, 'context-insight');
    expect(res.imported).toBe(true);

    const row = await prisma.session.findFirst({ where: { taskId } });
    expect(row?.framework).toBe('claude-code-proxy');
    expect(row?.version).toBe('2.1.278-proxy');
  });

  it('原生会话：framework/version 透传，label 作为会话级声明进 query', async () => {
    const taskId = 'it-expid-native';
    await seedSession(taskId, 'codex', '0.162.0');
    const artifact = artifactPath(taskId);
    await exportSession(taskId, artifact, prisma);

    await prisma.session.deleteMany({ where: { taskId } });
    await importSession(artifact, taskId, prisma, artifact, 'context-insight');

    const row = await prisma.session.findFirst({ where: { taskId } });
    expect(row?.framework).toBe('codex');
    expect(row?.version).toBe('0.162.0');
    // 会话级声明（label→title）优先于从轮次重推的 query
    expect(row?.query).toBe(`label of ${taskId}`);
  });

  it('同实例重导入：记录类命中既有行，幂等合并不产生重复行', async () => {
    const taskId = 'it-expid-merge';
    await seedSession(taskId, 'codex', '0.162.0');
    const artifact = artifactPath(taskId);
    await exportSession(taskId, artifact, prisma);

    const res = await importSession(artifact, taskId, prisma, artifact, 'context-insight');
    expect(res.imported).toBe(false);

    const rows = await prisma.session.findMany({ where: { taskId } });
    expect(rows.length).toBe(1);
    expect(rows[0].framework).toBe('codex');
    expect(rows[0].version).toBe('0.162.0');
  });

  it('导出件自描述：ExportMeta 格式头（producer/schemaVersion）', async () => {
    const db = new Database(artifactPath('it-expid-merge'), { readonly: true });
    try {
      const rows = db.prepare('SELECT key, value FROM "ExportMeta"').all() as { key: string; value: string }[];
      const byKey = new Map(rows.map(r => [r.key, r.value]));
      expect(byKey.get('producer')).toBe('insight-export');
      expect(byKey.get('schemaVersion')).toBe('1');
    } finally {
      db.close();
    }
  });

  it('存量旧件兼容：无 ExportMeta 的导出件仍按 Session 表识别', async () => {
    const legacy = path.join(tmpDir, 'legacy_no_meta.db');
    fs.copyFileSync(artifactPath('it-expid-merge'), legacy);
    const db = new Database(legacy);
    db.exec('DROP TABLE "ExportMeta"');
    db.close();
    expect(detectContent(legacy)).toBe(true);
  });

  it('导入预览：listSessions 返回会话级 framework', async () => {
    const listed = listSessions(artifactPath('it-expid-merge'));
    const entry = listed.find(s => s.id === 'it-expid-merge');
    expect(entry?.framework).toBe('codex');
  });

  it('deltaRefresh 按 sourcePath 文件事实路由：正确标记的重导入行可增量刷新', async () => {
    const taskId = 'it-expid-refresh';
    await seedSession(taskId, 'claude-code-proxy', '2.1.278-proxy');
    const artifact = artifactPath(taskId);
    await exportSession(taskId, artifact, prisma);
    await prisma.session.deleteMany({ where: { taskId } });
    await importSession(artifact, taskId, prisma, artifact, 'context-insight');

    // 该行 framework='claude-code-proxy' 而 sourcePath 是 insight 导出 db：
    // 按 framework 反查会路由到 claude-jsonl 去解析 sqlite（读到 0 条 →
    // 静默无增量）；只有按文件事实路由才能回到 cannbot 适配器。删掉最后
    // 一轮模拟「导出件是权威、本地库缺一条」的增量场景
    const row = await prisma.session.findFirst({ where: { taskId } });
    const turns = row
      ? await prisma.turn.findMany({ where: { sessionId: row.id }, orderBy: { turnIndex: 'asc' } })
      : [];
    expect(turns.length).toBe(2);
    await prisma.turn.delete({ where: { id: turns[turns.length - 1].id } });

    const r = await deltaRefreshSession(taskId, prisma);
    expect(r.addedTurns).toBe(1);
  });
});

describe('run 作用域一杆多行：工作台「导出 SQLite」→ 再导入', () => {
  const A = 'it-expid-member-a';
  const B = 'it-expid-member-b';
  const C = 'it-expid-member-c';
  const artifact = path.join(tmpDir, 'context_session_run_members.db');

  it('三行成员（记录类各异、其中一行零轮次）写进同一导出件：写入序 = 调用序，派生行各归各', async () => {
    await seedSession(A, 'claude-code-proxy', '2.1.278-proxy');
    await seedSession(B, 'codex', '0.162.0');
    // 零轮次成员：bundle 里被引用但没跑起来的会话行也要原样带出
    await prisma.session.create({
      data: { taskId: C, label: `label of ${C}`, framework: 'opencode', startTime: new Date('2026-10-01T10:00:00.000Z') },
    });
    const rows = await prisma.session.findMany({ where: { taskId: { in: [A, B, C] } }, select: { id: true, taskId: true } });
    const idOf = (taskId: string) => rows.find(r => r.taskId === taskId)!.id;
    const callOrder = [C, A, B].map(idOf);

    const summary = await exportSessionRows(callOrder, artifact, prisma);
    expect(summary).toMatchObject({ path: artifact, sessions: 3, turns: 4, toolCalls: 0, skillEvents: 0, executions: 0, bridges: 0 });

    const db = new Database(artifact, { readonly: true });
    try {
      expect((db.prepare('SELECT value FROM "ExportMeta" WHERE key = ?').get('producer') as { value: string }).value).toBe('insight-export');
      const sessionIds = (db.prepare('SELECT id FROM "Session" ORDER BY rowid').all() as { id: string }[]).map(r => r.id);
      expect(sessionIds).toEqual(callOrder);
      const turnsOf = (sessionId: string) =>
        (db.prepare('SELECT COUNT(*) AS n FROM "Turn" WHERE sessionId = ?').get(sessionId) as { n: number }).n;
      expect(turnsOf(idOf(A))).toBe(2);
      expect(turnsOf(idOf(B))).toBe(2);
      expect(turnsOf(idOf(C))).toBe(0);
      // 外键完整性：没有孤儿派生行（导出只按成员行取派生行，不波及库内其它会话）
      expect((db.prepare('SELECT COUNT(*) AS n FROM "Turn"').get() as { n: number }).n).toBe(4);
    } finally {
      db.close();
    }

    // 再导入 = 「导入到另一实例」：删原行后逐会话导回，有轮次的两行身份
    // （记录类 / 版本）原样；零轮次成员按导入管线既有口径不落行（回收站恢复
    // 同款——importSession 要求至少一轮交互）
    await prisma.session.deleteMany({ where: { taskId: { in: [A, B, C] } } });
    for (const taskId of [A, B]) {
      const res = await importSession(artifact, taskId, prisma, artifact, 'context-insight');
      expect(res.imported).toBe(true);
    }
    expect((await importSession(artifact, C, prisma, artifact, 'context-insight')).imported).toBe(false);
    const restored = await prisma.session.findMany({ where: { taskId: { in: [A, B, C] } } });
    const byTask = new Map(restored.map(r => [r.taskId, r]));
    expect([byTask.get(A)?.framework, byTask.get(A)?.version]).toEqual(['claude-code-proxy', '2.1.278-proxy']);
    expect([byTask.get(B)?.framework, byTask.get(B)?.version]).toEqual(['codex', '0.162.0']);
    expect(restored.map(r => r.taskId).sort()).toEqual([A, B].sort());
  });

  it('导入预览列全三行，记录类逐会话给（不被容器身份冒充）', () => {
    const listed = listSessions(artifact);
    expect(listed.map(s => s.id).sort()).toEqual([A, B, C].sort());
    const frameworkOf = (taskId: string) => listed.find(s => s.id === taskId)?.framework;
    expect([frameworkOf(A), frameworkOf(B), frameworkOf(C)]).toEqual(['claude-code-proxy', 'codex', 'opencode']);
  });

  it('任一行缺失整体失败：不产出导出件、不留临时残骸、不覆盖同路径旧件', async () => {
    const real = await prisma.session.findFirstOrThrow({ where: { taskId: A }, select: { id: true } });
    const target = path.join(tmpDir, 'it-expid-members-missing.db');
    fs.writeFileSync(target, 'previous-snapshot');

    await expect(exportSessionRows([real.id, 'row-does-not-exist'], target, prisma)).rejects.toThrow('Session not found: 1 of 2 rows');
    expect(fs.readFileSync(target, 'utf-8')).toBe('previous-snapshot');
    expect(fs.readdirSync(tmpDir).filter(name => name.startsWith('it-expid-members-missing.db.tmp-'))).toEqual([]);

    await expect(exportSessionRows([], target, prisma)).rejects.toThrow('No session rows to export');
  });
});
