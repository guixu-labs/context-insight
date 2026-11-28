import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAndIndex } from '@/lib/run/reader';
import { saveRun } from '@/lib/run/run-store';
import { prisma } from '@/lib/db';
import { compressCaptureFile } from '@/lib/compression';
import { planSessionArchive, buildSessionArchive } from '@/lib/observe/session-archive';
import { sevenZipBin } from '@/lib/seven-zip-bin';
import { GET as exportArchiveGET } from '@/app/api/observe/run/[runId]/export-archive/route';
import { GET as exportArchivePlanGET } from '@/app/api/observe/run/[runId]/export-archive/plan/route';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-export-archive-home-'));
const ORIG_HOME = process.env.CONTEXT_INSIGHT_HOME;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-run-export-archive-'));
const claudeDir = path.join(work, 'claude-project');
const RUN_ID = 'arcdemo01';
const RUN_NAME = 'arc-bundle';
const SID_CLAUDE = 'arc-ses-claude';
const SID_SUB = 'arc-sub-agent';
const SID_PROXY = 'arc-ses-proxy';
const SID_OPENCODE = 'arc-ses-opencode';
const SID_MISSING = 'arc-ses-missing';
const SID_INSIGHT_DB = 'arc-ses-insight-db';
const ALL_SIDS = [SID_CLAUDE, SID_PROXY, SID_OPENCODE, SID_MISSING, SID_INSIGHT_DB];
const MODEL = 'volc-gateway/glm-4.7';

const claudeLine = (type: string, text: string) => JSON.stringify({
  type, message: { role: type, content: text }, timestamp: '2026-10-13T02:00:00.000Z', uuid: `${type}-${text}`,
  sessionId: SID_CLAUDE, cwd: '/proj', version: '2.1.278', gitBranch: 'main',
});

const call = (handler: typeof exportArchiveGET | typeof exportArchivePlanGET, runId: string, suffix: string) =>
  handler(new NextRequest(`http://localhost/api/observe/run/${encodeURIComponent(runId)}${suffix}`), {
    params: Promise.resolve({ runId }),
  });

/** 解包归档到临时目录（7za 独立解，不信任写入器自己的任何读回逻辑） */
function extract(bytes: Buffer): string {
  const zip = path.join(work, `out-${Math.random().toString(36).slice(2, 8)}.zip`);
  const dir = `${zip}.d`;
  fs.mkdirSync(dir);
  fs.writeFileSync(zip, bytes);
  const r = spawnSync(sevenZipBin(), ['x', '-y', `-o${dir}`, zip], { stdio: ['ignore', 'pipe', 'pipe'] });
  // 拉不起来时 status / stderr 都是空，原因只在 error 里——一并写进断言消息
  expect(r.status, `7za extract failed: ${r.error ?? r.stderr?.toString()}`).toBe(0);
  return dir;
}

const walk = (dir: string, rel = ''): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const child = path.posix.join(rel, entry.name);
    return entry.isDirectory() ? walk(path.join(dir, entry.name), child) : [child];
  }).sort();

beforeAll(async () => {
  process.env.CONTEXT_INSIGHT_HOME = tmpHome;
  fs.mkdirSync(path.join(claudeDir, SID_CLAUDE, 'subagents'), { recursive: true });

  // claude 布局：<工程>/<sid>.jsonl.7z + <sid>.meta.json + <sid>/subagents/<sub>.jsonl.7z(+meta)
  const plainMain = path.join(claudeDir, `${SID_CLAUDE}.jsonl`);
  fs.writeFileSync(plainMain, `${claudeLine('user', 'hello root')}\n${claudeLine('assistant', 'hi from root')}\n`);
  fs.writeFileSync(path.join(claudeDir, `${SID_CLAUDE}.meta.json`), JSON.stringify({ producer: 'cpx', framework: 'claude-code', sid: SID_CLAUDE }));
  const plainSub = path.join(claudeDir, SID_CLAUDE, 'subagents', `${SID_SUB}.jsonl`);
  fs.writeFileSync(plainSub, `${claudeLine('user', 'hello sub')}\n${claudeLine('assistant', 'hi from sub')}\n`);
  fs.writeFileSync(path.join(claudeDir, SID_CLAUDE, 'subagents', `${SID_SUB}.meta.json`), JSON.stringify({ agentType: 'Explore' }));
  const main7z = compressCaptureFile(plainMain);
  compressCaptureFile(plainSub);

  // proxy 捕获布局：cpx-<sid>.jsonl.7z（无 meta、无子代理）
  const plainProxy = path.join(claudeDir, `cpx-${SID_PROXY}.jsonl`);
  fs.writeFileSync(plainProxy, `${claudeLine('user', 'proxy ask').replaceAll(SID_CLAUDE, SID_PROXY)}\n`);
  const proxy7z = compressCaptureFile(plainProxy);

  // insight 导出件当源（sourcePath 是 .db）
  const insightDb = path.join(work, 'context_session_insight.db');
  const src = new Database(insightDb);
  src.exec('CREATE TABLE "ExportMeta" ("key" TEXT, "value" TEXT)');
  src.close();

  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/^ses_mini_/, 'arc-m-').replace('minidemo01', RUN_ID).replace('mini-bundle', RUN_NAME);
    if (Array.isArray(v)) return v.map(rewrite);
    if (v != null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, rewrite(val)]));
    }
    return v;
  };
  // 沿用 mini-bundle 清单（3 个会话成员 ses_mini_a/b/c），成员 sid 改写为本测试的 arc-m-*
  const full = JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/run/mini-bundle/workflow.json'), 'utf-8'));
  saveRun(parseAndIndex(rewrite(full) as Parameters<typeof parseAndIndex>[0]).manifest, null);

  await prisma.session.deleteMany({ where: { taskId: { in: [...ALL_SIDS, 'arc-m-a', 'arc-m-b', 'arc-m-c'] } } });
  await prisma.session.createMany({
    data: [
      ...[
        [SID_CLAUDE, 'claude-code', '2.1.278', main7z],
        [SID_PROXY, 'codex-proxy', '0.162.0-proxy', proxy7z],
        // opencode 原生：共享库，拆不出单会话原件
        [SID_OPENCODE, 'opencode', '1.17.0', path.join(work, 'opencode.db')],
        // 有会话级原件，但主文件已不在盘上
        [SID_MISSING, 'claude-code', '2.1.278', path.join(claudeDir, 'gone.jsonl')],
        // 从 insight 导出件导入的会话：原件 = 那个导出件
        [SID_INSIGHT_DB, 'claude-code', '2.1.278', insightDb],
      ].map(([taskId, framework, version, sourcePath]) => ({
        taskId: taskId as string, framework: framework as string, version: version as string, sourcePath: sourcePath as string,
        label: `archive ${taskId}`, model: MODEL, totalTokens: 100,
        startTime: new Date('2026-10-13T02:00:00Z'), endTime: new Date('2026-10-13T02:10:00Z'),
      })),
      ...['arc-m-a', 'arc-m-b', 'arc-m-c'].map((sid, i) => ({
        taskId: sid, framework: 'claude-code', version: '2.1.278', label: `bundle ${sid}`, model: MODEL,
        sourcePath: i === 0 ? proxy7z : path.join(work, 'nope.jsonl'),
        totalTokens: 100 + i, startTime: new Date('2026-10-13T02:00:00Z'), endTime: new Date('2026-10-13T02:10:00Z'),
      })),
    ],
  });
  const rows = await prisma.session.findMany({ where: { taskId: { in: [...ALL_SIDS, 'arc-m-a', 'arc-m-b', 'arc-m-c'] } }, select: { id: true } });
  await prisma.turn.createMany({
    data: rows.flatMap((row, i) => [0, 1].map(turnIndex => ({
      sessionId: row.id, turnIndex, role: 'assistant', content: `archive-turn-${i}-${turnIndex}`,
      createdAt_ts: new Date('2026-10-13T02:00:10Z'), model: MODEL, totalTokens: 10, latencyMs: 5,
    }))),
  });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { taskId: { in: [...ALL_SIDS, 'arc-m-a', 'arc-m-b', 'arc-m-c'] } } });
  if (ORIG_HOME === undefined) delete process.env.CONTEXT_INSIGHT_HOME;
  else process.env.CONTEXT_INSIGHT_HOME = ORIG_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe('export-archive 端点：会话原始文件 → zip（有原件出原件，没有出导出 db）', () => {
  it('solo / claude 布局：主文件 + meta + 子代理文件及其 meta 逐字节原样入包', async () => {
    const res = await call(exportArchiveGET, `solo:${SID_CLAUDE}`, '/export-archive');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain(`context_session_${SID_CLAUDE}.zip`);

    const dir = extract(Buffer.from(await res.arrayBuffer()));
    expect(walk(dir)).toEqual([
      'export-manifest.json',
      `sessions/${SID_CLAUDE}/${SID_CLAUDE}.jsonl.7z`,
      `sessions/${SID_CLAUDE}/${SID_CLAUDE}.meta.json`,
      `sessions/${SID_CLAUDE}/subagents/${SID_SUB}.jsonl.7z`,
      `sessions/${SID_CLAUDE}/subagents/${SID_SUB}.meta.json`,
    ]);
    const sub = path.join(claudeDir, SID_CLAUDE, 'subagents');
    for (const [archived, original] of [
      [`${SID_CLAUDE}.jsonl.7z`, path.join(claudeDir, `${SID_CLAUDE}.jsonl.7z`)],
      [`${SID_CLAUDE}.meta.json`, path.join(claudeDir, `${SID_CLAUDE}.meta.json`)],
      [`subagents/${SID_SUB}.jsonl.7z`, path.join(sub, `${SID_SUB}.jsonl.7z`)],
      [`subagents/${SID_SUB}.meta.json`, path.join(sub, `${SID_SUB}.meta.json`)],
    ]) {
      expect(fs.readFileSync(path.join(dir, 'sessions', SID_CLAUDE, archived)).equals(fs.readFileSync(original))).toBe(true);
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'export-manifest.json'), 'utf-8'));
    expect(manifest.format).toBe('session-archive');
    expect(manifest.run).toEqual({ id: `solo:${SID_CLAUDE}`, kind: 'solo', name: SID_CLAUDE });
    expect(manifest.sessions).toEqual([expect.objectContaining({
      taskId: SID_CLAUDE, framework: 'claude-code', dir: `sessions/${SID_CLAUDE}`, kind: 'originals', absentReason: null,
      files: [
        expect.objectContaining({ path: `sessions/${SID_CLAUDE}/${SID_CLAUDE}.jsonl.7z`, role: 'main' }),
        expect.objectContaining({ path: `sessions/${SID_CLAUDE}/${SID_CLAUDE}.meta.json`, role: 'meta' }),
        expect.objectContaining({ path: `sessions/${SID_CLAUDE}/subagents/${SID_SUB}.jsonl.7z`, role: 'subagent' }),
        expect.objectContaining({ path: `sessions/${SID_CLAUDE}/subagents/${SID_SUB}.meta.json`, role: 'subagent-meta' }),
      ],
    })]);
    // 清单随包分发：文件条目只留归档内路径 / 角色 / 字节数，不带盘上原路径
    for (const file of manifest.sessions[0].files) {
      expect(Object.keys(file).sort()).toEqual(['bytes', 'path', 'role']);
    }
  });

  it('plan 端点：逐会话说明用的是哪种载荷；与实际归档一致', async () => {
    const res = await call(exportArchivePlanGET, RUN_ID, '/export-archive/plan');
    expect(res.status).toBe(200);
    const plan = await res.json() as {
      originals: number; dbs: number; fileCount: number; name: string;
      members: Array<{ taskId: string; kind: string; absentReason: string | null }>;
    };
    expect(plan.name).toBe(RUN_NAME);
    expect(plan.originals).toBe(1);
    expect(plan.dbs).toBe(2);
    expect(plan.members.map(m => [m.taskId, m.kind, m.absentReason])).toEqual([
      ['arc-m-a', 'originals', null],
      ['arc-m-b', 'db', 'source-missing'],
      ['arc-m-c', 'db', 'source-missing'],
    ]);
  });

  it('bundle run：混合载荷；没有原件的成员以导出 db（7z）代替，解压即得可读导出件', async () => {
    const res = await call(exportArchiveGET, RUN_ID, '/export-archive');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(`context_session_run_${RUN_NAME}.zip`);

    const dir = extract(Buffer.from(await res.arrayBuffer()));
    expect(walk(dir)).toEqual([
      'export-manifest.json',
      'sessions/arc-m-a/cpx-arc-ses-proxy.jsonl.7z',
      'sessions/arc-m-b/context_session_arc-m-b.db.7z',
      'sessions/arc-m-c/context_session_arc-m-c.db.7z',
    ]);
    expect(fs.readFileSync(path.join(dir, 'sessions/arc-m-a/cpx-arc-ses-proxy.jsonl.7z')).equals(fs.readFileSync(path.join(claudeDir, `cpx-${SID_PROXY}.jsonl.7z`)))).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'export-manifest.json'), 'utf-8'));
    expect(manifest.run).toEqual({ id: RUN_ID, kind: 'bundle', name: RUN_NAME });
    expect(manifest.sessions.map((s: { taskId: string; kind: string; absentReason: string | null; files: Array<{ bytes: number }> }) => (
      [s.taskId, s.kind, s.absentReason, s.files.length, s.files[0].bytes > 0]
    ))).toEqual([
      ['arc-m-a', 'originals', null, 1, true],
      ['arc-m-b', 'db', 'source-missing', 1, true],
      ['arc-m-c', 'db', 'source-missing', 1, true],
    ]);

    // db 载荷：7z 里是该成员自己的导出件（只含这一行会话及其轮次）
    const out = path.join(work, 'db-out');
    fs.mkdirSync(out, { recursive: true });
    expect(spawnSync(sevenZipBin(), ['e', '-y', `-o${out}`, path.join(dir, 'sessions/arc-m-b/context_session_arc-m-b.db.7z')]).status).toBe(0);
    const db = new Database(path.join(out, 'context_session_arc-m-b.db'), { readonly: true });
    try {
      const sessions = db.prepare('SELECT taskId FROM "Session"').all();
      expect(sessions).toEqual([{ taskId: 'arc-m-b' }]);
      expect((db.prepare('SELECT COUNT(*) AS n FROM "Turn"').get() as { n: number }).n).toBe(2);
    } finally {
      db.close();
    }
  });

  it('没有原件的三种原因都落到 db 载荷，清单照实记原因', async () => {
    const cases: Array<[string, string]> = [
      [SID_OPENCODE, 'no-per-session-files'],
      [SID_MISSING, 'source-missing'],
    ];
    for (const [sid, reason] of cases) {
      const res = await call(exportArchiveGET, `solo:${sid}`, '/export-archive');
      expect(res.status).toBe(200);
      const dir = extract(Buffer.from(await res.arrayBuffer()));
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'export-manifest.json'), 'utf-8'));
      expect(manifest.sessions[0]).toEqual(expect.objectContaining({ taskId: sid, kind: 'db', absentReason: reason }));
      expect(walk(dir).filter(p => p.endsWith('.db.7z'))).toEqual([`sessions/${sid}/context_session_${sid}.db.7z`]);
    }
  });

  it('从 insight 导出件导入的会话：原件 = 那个导出件本身，原样入包', async () => {
    const res = await call(exportArchiveGET, `solo:${SID_INSIGHT_DB}`, '/export-archive');
    expect(res.status).toBe(200);
    const dir = extract(Buffer.from(await res.arrayBuffer()));
    expect(walk(dir)).toEqual(['export-manifest.json', `sessions/${SID_INSIGHT_DB}/context_session_insight.db`]);
    expect(fs.readFileSync(path.join(dir, `sessions/${SID_INSIGHT_DB}/context_session_insight.db`)).equals(fs.readFileSync(path.join(work, 'context_session_insight.db')))).toBe(true);
  });

  it('遍历形态 taskId：归档目录名收敛为安全段，不逃出 sessions/（zip-slip）', async () => {
    // 直接落库（绕开摄取侧 taskId 白名单）：taskId 含 '/' 或恰为 '..' 时，
    // 目录名必须与导出件文件名同源收敛，否则解压时条目逃出 sessions/ 根
    const evil = ['traversal/../../slip', '..'];
    await prisma.session.createMany({
      data: evil.map((taskId, i) => ({
        taskId, framework: 'claude-code', version: '2.1.278', label: `slip ${i}`,
        model: MODEL, sourcePath: null, totalTokens: 100,
        startTime: new Date('2026-10-13T02:00:00Z'), endTime: new Date('2026-10-13T02:10:00Z'),
      })),
    });
    try {
      for (const taskId of evil) {
        const res = await call(exportArchiveGET, `solo:${taskId}`, '/export-archive');
        expect(res.status, taskId).toBe(200);
        const dir = extract(Buffer.from(await res.arrayBuffer()));
        // 目录名 = taskId 收敛后的安全段（'/' 与 '..' 均不再作为路径分量）
        const expected = taskId === '..'
          ? ['export-manifest.json', 'sessions/_/context_session__.db.7z']
          : ['export-manifest.json', 'sessions/traversal_.._.._slip/context_session_traversal_.._.._slip.db.7z'];
        expect(walk(dir)).toEqual(expected);
      }
    } finally {
      await prisma.session.deleteMany({ where: { taskId: { in: evil } } });
    }
  });

  it('同 taskId 双记录（不同 framework）都走 db 载荷：暂存 db 各落各目录，两个 7z 各装各的行', async () => {
    const TWIN = 'arc-twin-sid';
    await prisma.session.createMany({
      data: [
        { taskId: TWIN, framework: 'claude-code', version: '2.1.278', label: 'twin-native', model: MODEL, sourcePath: null, totalTokens: 100, startTime: new Date('2026-10-13T02:00:00Z'), endTime: new Date('2026-10-13T02:10:00Z') },
        { taskId: TWIN, framework: 'codex-proxy', version: '0.162.0-proxy', label: 'twin-proxy', model: MODEL, sourcePath: null, totalTokens: 200, startTime: new Date('2026-10-13T02:00:00Z'), endTime: new Date('2026-10-13T02:10:00Z') },
      ],
    });
    const rows = await prisma.session.findMany({ where: { taskId: TWIN }, orderBy: { framework: 'asc' } });
    expect(rows).toHaveLength(2);
    // 两行各写一条可区分的轮次：验每个 7z 只装自己那一行的数据（暂存名撞车时
    // 两个条目会装同一份、另一份被覆盖）
    await prisma.turn.createMany({
      data: rows.map((row, i) => ({
        sessionId: row.id, turnIndex: 0, role: 'assistant', content: `twin-turn-${i}`,
        createdAt_ts: new Date('2026-10-13T02:00:10Z'), model: MODEL, totalTokens: 10, latencyMs: 5,
      })),
    });
    try {
      const plan = await planSessionArchive('arc-twin-bundle', {
        kind: 'run',
        runId: 'arc-twin-bundle',
        members: rows.map(r => ({ rowId: r.id, taskId: TWIN, framework: r.framework, label: null, structure: null })),
      }, prisma);
      expect(plan.dbs).toBe(2);
      // 目录消歧：同一 taskId 双记录分落两个 sessions/<dir>（后到者带 @framework）
      expect(new Set(plan.members.map(m => m.dir)).size).toBe(2);

      const built = await buildSessionArchive(plan, prisma);
      const dir = extract(fs.readFileSync(built.path));
      fs.rmSync(built.path, { force: true });
      const db7zs = walk(dir).filter(p => p.endsWith('.db.7z'));
      expect(db7zs).toHaveLength(2);
      expect(new Set(db7zs).size).toBe(2);

      // 每个 7z 只含各自一行的导出件，两条轮次内容齐全且互不覆盖
      const contents: string[] = [];
      for (const rel of db7zs) {
        const out = path.join(work, `twin-out-${contents.length}`);
        fs.mkdirSync(out, { recursive: true });
        expect(spawnSync(sevenZipBin(), ['e', '-y', `-o${out}`, path.join(dir, rel)]).status).toBe(0);
        const db = new Database(path.join(out, `context_session_${TWIN}.db`), { readonly: true });
        try {
          expect(db.prepare('SELECT taskId FROM "Session"').all()).toEqual([{ taskId: TWIN }]);
          contents.push((db.prepare('SELECT content FROM "Turn"').get() as { content: string }).content);
        } finally {
          db.close();
        }
      }
      expect(contents.sort()).toEqual(['twin-turn-0', 'twin-turn-1']);
    } finally {
      await prisma.session.deleteMany({ where: { taskId: TWIN } });
    }
  });

  it('run 不存在 → 404（plan 与归档同一口径）', async () => {
    for (const [handler, suffix] of [[exportArchiveGET, '/export-archive'], [exportArchivePlanGET, '/export-archive/plan']] as const) {
      const res = await call(handler, 'solo:arc-no-such-session', suffix);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { reason: string }).reason).toBe('run-not-found');
    }
  });
});
