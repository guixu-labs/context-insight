// 工作台「导出 SQLite」端点 IT（真实 prisma + 真实 run-store + 真实作用域解析，
// 端点全链：runId → scope → 成员行 → export-service 写管线 → SQLite 响应）。
// 锁：①bundle run = 全员成员行写进同一导出件（文件名用 run 身份）；
// ②solo run = 单行（文件名用会话口径）；③同 sid 双行取工作台展示的那一行
// （原生优先，不串到 proxy 行）；④run 不存在 / 遍历形态 id → 404，不产出文件。
// 零件级闸（mock scope / 写管线失败）在 security-guards.test.ts。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun, type RunImportMeta } from '@/lib/run/run-store';
import { prisma } from '@/lib/db';
import { GET as runExportDbGET } from '@/app/api/observe/run/[runId]/export-db/route';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-export-db-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;
const TMP_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-export-db-out-'));

const RUN_ID = 'minidemo01';
const RUN_NAME = 'mini-bundle';
const MEMBER_A = 'rxdb-ses-mini-a';
const MEMBER_B = 'rxdb-ses-mini-b';
const MEMBER_C = 'rxdb-ses-mini-c';
const SOLO_SID = 'rxdb-solo-ses';
const SOLO_DUAL = 'rxdb-solo-dual';
const ALL_SIDS = [MEMBER_A, MEMBER_B, MEMBER_C, SOLO_SID, SOLO_DUAL];
const MODEL = 'volc-gateway/glm-4.7';

const call = (runId: string) =>
  runExportDbGET(new NextRequest(`http://localhost/api/observe/run/${encodeURIComponent(runId)}/export-db`), {
    params: Promise.resolve({ runId }),
  });

/** 把响应字节落成临时文件并打开（端点返回的是导出件本体） */
async function openExport(res: Response): Promise<{ file: string; db: Database.Database }> {
  const file = path.join(TMP_OUT, `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return { file, db: new Database(file, { readonly: true }) };
}

const sessionRows = (db: Database.Database) =>
  (db.prepare('SELECT taskId, framework, version FROM "Session" ORDER BY rowid').all() as Array<{
    taskId: string; framework: string; version: string | null;
  }>);
const turnCount = (db: Database.Database, taskId: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM "Turn" WHERE sessionId = (SELECT id FROM "Session" WHERE taskId = ?)').get(taskId) as { n: number }).n;

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/^ses_mini_/, 'rxdb-ses-mini-');
    if (Array.isArray(v)) return v.map(rewrite);
    if (v != null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, rewrite(val)]));
    }
    return v;
  };
  const manifest = parseAndIndex(
    rewrite(JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'))) as Parameters<typeof parseAndIndex>[0],
  ).manifest;
  const meta: RunImportMeta = {
    schema: 'insight-run-import',
    version: 1,
    data: {
      importedAt: '2026-10-15T10:00:00+08:00',
      sourceDir: '/bundle/mini',
      manifestFile: 'workflow.json',
      exportDataComplete: true,
      sessions: { total: 3, imported: 3, existing: 0, missingFile: 0, failed: 0 },
      failures: [],
      warnings: [],
      ownedSessions: [],
    },
  };
  saveRun(manifest, meta);

  await prisma.session.deleteMany({ where: { taskId: { in: ALL_SIDS } } });
  await prisma.session.createMany({
    data: [
      ...[MEMBER_A, MEMBER_B, MEMBER_C].map((sid, i) => ({
        taskId: sid, framework: 'claude-code', version: '2.1.278', label: `rxdb ${sid}`, model: MODEL,
        totalTokens: 100 + i, startTime: new Date('2026-10-13T02:00:00Z'), endTime: new Date('2026-10-13T02:10:00Z'),
      })),
      {
        taskId: SOLO_SID, framework: 'codex', version: '0.162.0', label: 'rxdb 独立会话', model: MODEL,
        totalTokens: 150, startTime: new Date('2026-10-13T05:00:00Z'), endTime: new Date('2026-10-13T05:10:00Z'),
      },
      {
        taskId: SOLO_DUAL, framework: 'opencode', label: 'rxdb 双行原生', model: MODEL,
        totalTokens: 100, startTime: new Date('2026-10-13T06:00:00Z'), endTime: new Date('2026-10-13T06:05:00Z'),
      },
      {
        taskId: SOLO_DUAL, framework: 'opencode-proxy', label: 'rxdb 双行代理', model: MODEL,
        totalTokens: 999, startTime: new Date('2026-10-13T06:00:00Z'), endTime: new Date('2026-10-13T06:06:00Z'),
      },
    ],
  });
  const mkTurn = (sessionId: string, turnIndex: number, content: string) => ({
    sessionId, turnIndex, role: 'assistant', content,
    createdAt_ts: new Date('2026-10-13T02:00:10Z'), model: MODEL, totalTokens: 100, latencyMs: 800,
  });
  const rowOf = async (taskId: string, framework?: string) =>
    (await prisma.session.findFirstOrThrow({ where: framework ? { taskId, framework } : { taskId }, select: { id: true } })).id;
  const a = await rowOf(MEMBER_A);
  const b = await rowOf(MEMBER_B);
  const solo = await rowOf(SOLO_SID);
  const dualNative = await rowOf(SOLO_DUAL, 'opencode');
  const dualProxy = await rowOf(SOLO_DUAL, 'opencode-proxy');
  await prisma.turn.createMany({
    data: [
      mkTurn(a, 0, 'rxdb-a-0'), mkTurn(a, 1, 'rxdb-a-1'),
      mkTurn(b, 0, 'rxdb-b-0'),
      mkTurn(solo, 0, 'rxdb-solo-0'), mkTurn(solo, 1, 'rxdb-solo-1'),
      mkTurn(dualNative, 0, 'rxdb-dual-native-0'),
      mkTurn(dualProxy, 0, 'rxdb-dual-proxy-0'),
    ],
  });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: ALL_SIDS } } });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
  fs.rmSync(TMP_OUT, { recursive: true, force: true });
});

describe('export-db 端点：run 全员成员会话 → 独立 SQLite 导出件', () => {
  it('bundle run：全员成员行（含零轮次成员）写进同一导出件，文件名用 run 身份', async () => {
    const res = await call(RUN_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-sqlite3');
    expect(res.headers.get('content-disposition')).toContain(`context_session_run_${RUN_NAME}.db`);

    const { file, db } = await openExport(res);
    try {
      expect(fs.readFileSync(file).subarray(0, 15).toString()).toBe('SQLite format 3');
      expect((db.prepare('SELECT value FROM "ExportMeta" WHERE key = ?').get('producer') as { value: string }).value).toBe('insight-export');
      // 三个成员位各引用一个会话行：全员导出（不是只导某个成员 / 根成员）
      const rows = sessionRows(db);
      expect(rows.map(r => r.taskId).sort()).toEqual([MEMBER_A, MEMBER_B, MEMBER_C].sort());
      expect(rows.every(r => r.framework === 'claude-code' && r.version === '2.1.278')).toBe(true);
      expect(turnCount(db, MEMBER_A)).toBe(2);
      expect(turnCount(db, MEMBER_C)).toBe(0);
      // 库内其它会话（solo / 双行）不混进来
      expect((db.prepare('SELECT COUNT(*) AS n FROM "Session"').get() as { n: number }).n).toBe(3);
    } finally {
      db.close();
    }
  });

  it('solo run：单行，文件名用会话口径，身份（记录类 / 版本）原样', async () => {
    const res = await call(`solo:${SOLO_SID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(`context_session_${SOLO_SID}.db`);

    const { db } = await openExport(res);
    try {
      expect(sessionRows(db)).toEqual([{ taskId: SOLO_SID, framework: 'codex', version: '0.162.0' }]);
      expect(turnCount(db, SOLO_SID)).toBe(2);
    } finally {
      db.close();
    }
  });

  it('同 sid 双行：导出的是工作台展示的那一行（原生优先），不串到 proxy 记录行', async () => {
    const res = await call(`solo:${SOLO_DUAL}`);
    expect(res.status).toBe(200);

    const { db } = await openExport(res);
    try {
      expect(sessionRows(db)).toEqual([{ taskId: SOLO_DUAL, framework: 'opencode', version: null }]);
      expect(turnCount(db, SOLO_DUAL)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('run 不存在 / 遍历形态的 id：404，不产出导出件', async () => {
    // 端点的临时件（export-service 缺省落 os.tmpdir()）前后清单一致 = 没有产出
    const leaked = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('context_session_export_'));
    const before = leaked();
    for (const runId of ['no-such-run', 'solo:no-such-session', 'solo:../../evil', '../etc/passwd']) {
      const res = await call(runId);
      expect(res.status, runId).toBe(404);
      expect((await res.json()).reason).toBe('run-not-found');
    }
    expect(leaked()).toEqual(before);
  });

  it('成功导出后端点临时件即删（不随导出次数堆积）', async () => {
    const leaked = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('context_session_export_'));
    const before = leaked();
    const res = await call(`solo:${SOLO_SID}`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(leaked()).toEqual(before);
  });
});
