// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../setup';
import { POST as importFile } from '@/app/api/ingest/import-file/route';
import { POST as freeze } from '@/app/api/lineage/sessions/[sessionId]/snapshots/route';
import { GET, POST } from '@/app/api/lineage/core/[...path]/route';

let child: ChildProcess;
let directory: string;
let sessionId: string;
let base: string;
let sourcePath: string;
const sessionIds: string[] = [];

async function api(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', headers = {}) {
  const request = new Request('http://localhost/api/lineage/core/' + route, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const context = { params: Promise.resolve({ path: route.split('?')[0].split('/') }) };
  return (method === 'GET' ? GET : POST)(request, context);
}

function snapshot(id = sessionId) {
  return freeze(new Request('http://localhost/api/lineage/sessions/' + id + '/snapshots', { method: 'POST' }), {
    params: Promise.resolve({ sessionId: id }),
  });
}

beforeAll(async () => {
  await mkdir(path.resolve('tmp'), { recursive: true });
  directory = await mkdtemp(path.resolve('tmp/lineage-it-'));
  sourcePath = path.join(directory, 'native.jsonl');
  await copyFile('tests/data/lineage/native.jsonl', sourcePath);
  child = spawn(process.env.AGENTLINEAGE_TEST_PYTHON ?? 'python', [
    '-m', 'agentlineage_core.cli', '--data-dir', path.join(directory, 'core'), 'serve', '--port', '0',
  ], { env: { ...process.env, PYTHONPATH: path.resolve('agentlineage/components/core/src'), AGENTLINEAGE_TOKEN: 'lineage-it-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', data => { stderr += data; });
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Core startup timed out: ' + stderr)), 15_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(stderr)); });
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', line => { clearTimeout(timer); lines.close(); resolve(JSON.parse(line).url); });
  });
  vi.stubEnv('AGENTLINEAGE_CORE_URL', base);
  vi.stubEnv('AGENTLINEAGE_TOKEN', 'lineage-it-token');
  vi.stubEnv('AGENTLINEAGE_PROJECT_ID', 'lineage-it-' + path.basename(directory));
  const imported = await importFile(new NextRequest('http://localhost/api/ingest/import-file', {
    method: 'POST', body: JSON.stringify({ source: 'claude-jsonl', sessionId: 'lineage-merge-fixture', filePath: sourcePath }),
  }));
  const value = await imported.json();
  expect(imported.status, JSON.stringify(value)).toBe(200);
  sessionId = value.sessionId;
  sessionIds.push(sessionId);
}, 30_000);

afterAll(async () => {
  await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
  vi.unstubAllEnvs();
  if (child && child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed; }
  if (directory?.startsWith(path.resolve('tmp') + path.sep)) await rm(directory, { recursive: true, force: true });
});

it('imports through Insight, freezes exact bytes, resolves and rereads evidence through Core', async () => {
  const response = await snapshot();
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(201);
  expect(value.binding.session_id).toBe(sessionId);
  expect(value.binding.projection_alignment).toBe('unverified');
  expect(value.snapshot.completeness).toBe('partial');
  const content = await (await api(`v1/sources/${value.source.id}/content`)).json();
  expect(content.sha256).toBe(value.binding.source_sha256);
  const observations = await (await api(`v1/snapshots/${value.snapshot.id}/observations`, { include_overview: false })).json();
  const record = observations.records.find((r: { kind: string }) => r.kind === 'tool-call');
  expect(record.evidence.sha256).toBe(value.source.sha256);
  const anchor = { source_id: value.source.id, sha256: value.source.sha256, pointer: record.evidence.pointer };
  const ambiguous = await (await api(`v1/snapshots/${value.snapshot.id}/resolve`, anchor)).json();
  expect(ambiguous.status).toBe('ambiguous');
  const resolved = await (await api(`v1/snapshots/${value.snapshot.id}/resolve`, { ...anchor, record_id: record.id })).json();
  expect(resolved.status).toBe('resolved');
  expect(resolved.semantic_verified).toBe(false);
  expect(resolved.records[0].record_id).toBe(record.id);
  const opened = await (await api(`v1/snapshots/${value.snapshot.id}/observations`, { record_id: record.id })).json();
  expect(opened.text).toContain('/project/hello.txt');
  await writeFile('tmp/lineage-api-evidence.json', JSON.stringify({
    input_fixture: 'tests/data/lineage/native.jsonl', binding: value.binding,
    source: value.source, snapshot: value.snapshot, anchor, resolved, opened,
  }, null, 2) + '\n');
  const retry = await (await snapshot()).json();
  expect(retry.snapshot.id).toBe(value.snapshot.id);
  expect(await prisma.turn.count({ where: { sessionId } })).toBeGreaterThan(0);
});

it('rejects stale material anchors and reports absent coordinates without guessing', async () => {
  const value = await (await snapshot()).json();
  const route = `v1/snapshots/${value.snapshot.id}/resolve`;
  const anchor = { source_id: value.source.id, sha256: value.source.sha256, pointer: '/lines/999999' };
  expect((await (await api(route, anchor)).json()).status).toBe('unresolved');
  expect((await api(route, { ...anchor, sha256: '0'.repeat(64) })).status).toBe(409);
  expect((await api(route, { ...anchor, source_id: 'src_' + '0'.repeat(64) })).status).toBe(404);
  expect((await api(route, { turnIndex: 1, quote: 'hello' })).status).toBe(400);
});

it('keeps old snapshots readable when the registered source changes', async () => {
  const first = await (await snapshot()).json();
  const original = await readFile(sourcePath);
  try {
    await writeFile(sourcePath, original.toString().replace('hello\\n', 'changed\\n'));
    const second = await (await snapshot()).json();
    expect(second.run_id).toBe(first.run_id);
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    const old = await (await api(`v1/sources/${first.source.id}/content`)).json();
    expect(old.sha256).toBe(first.source.sha256);
  } finally { await writeFile(sourcePath, original); }
});

it('does not bind a proxy sibling with the same taskId as native evidence', async () => {
  const native = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  const proxy = await prisma.session.create({ data: { taskId: native.taskId, framework: 'claude-code-proxy', version: 'fixture-proxy', sourcePath } });
  sessionIds.push(proxy.id);
  expect((await snapshot(proxy.id)).status).toBe(422);
  expect((await snapshot()).status).toBe(201);
  expect((await snapshot('missing-session')).status).toBe(404);
});

it('enforces import roots before reading a registered source', async () => {
  vi.stubEnv('CANNBOT_INSIGHT_IMPORT_ROOTS', path.join(directory, 'not-allowed'));
  try { expect((await snapshot()).status).toBe(403); }
  finally { vi.stubEnv('CANNBOT_INSIGHT_IMPORT_ROOTS', ''); }
});

it('preserves Core errors, raw uploads and idempotency conflicts', async () => {
  const first = await api('v1/runs', { external_key: 'idem' }, 'POST', { 'Idempotency-Key': 'lineage-it-key' });
  expect(first.status).toBe(201);
  const repeat = await api('v1/runs', { external_key: 'idem' }, 'POST', { 'Idempotency-Key': 'lineage-it-key' });
  expect(await repeat.json()).toEqual(await first.json());
  expect((await api('v1/runs', { external_key: 'different' }, 'POST', { 'Idempotency-Key': 'lineage-it-key' })).status).toBe(409);
  expect((await api('v1/sources?name=bad.jsonl', 'invalid-json')).status).toBe(422);
  expect((await api('login', {})).status).toBe(404);
  expect((await api('v1/query', 'x'.repeat(1024 * 1024 + 1))).status).toBe(413);
});

it('preserves live append acknowledgments, conflict handling, cursors and frozen bytes', async () => {
  const run = await (await api('v1/runs', { external_key: 'live-gateway-it' })).json();
  const raw = await readFile(sourcePath);
  const route = `v1/runs/${run.id}/live`;
  const body = { key: 'primary', format: 'claude', session_id: 'lineage-merge-fixture', offset: 0, content: raw.toString('base64') };
  const appended = await api(`${route}/append`, body);
  const ack = await appended.json();
  expect(appended.status, JSON.stringify(ack)).toBe(200);
  expect(ack.offset).toBe(raw.length);
  expect(await (await api(`${route}/append`, body)).json()).toEqual(ack);
  expect((await api(`${route}/append`, { ...body, offset: raw.length + 1 })).status).toBe(409);
  const view = await (await api(`${route}/query`, {})).json();
  expect(view.records.length).toBeGreaterThan(0);
  const caughtUp = await (await api(`${route}/query`, { after: view.cursor })).json();
  expect(caughtUp.changes).toEqual([]);
  const frozen = await (await api(`${route}/freeze`, {})).json();
  const manifest = await (await api(`v1/snapshots/${frozen.id ?? frozen.snapshot_id}`)).json();
  const source = await (await api(`v1/sources/${manifest.sources[0].id}/content`)).json();
  expect(Buffer.from(source.content, 'base64')).toEqual(raw);
});

it('fails clearly when disabled, unauthorized or configured with an unsafe URL', async () => {
  vi.stubEnv('AGENTLINEAGE_CORE_URL', '');
  expect((await api('health')).status).toBe(503);
  vi.stubEnv('AGENTLINEAGE_CORE_URL', 'http://remote.example');
  expect((await api('health')).status).toBe(503);
  vi.stubEnv('AGENTLINEAGE_CORE_URL', base);
  vi.stubEnv('AGENTLINEAGE_TOKEN', 'wrong-token');
  expect((await api('health')).status).toBe(401);
  vi.stubEnv('AGENTLINEAGE_TOKEN', 'lineage-it-token');
});

it('bounds slow requests and refuses upstream redirects', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(302, { Location: base + '/health' }); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  vi.stubEnv('AGENTLINEAGE_CORE_URL', `http://127.0.0.1:${address.port}`);
  try {
    expect((await api('health')).status).toBe(502);
    vi.stubEnv('AGENTLINEAGE_TIMEOUT_MS', '50');
    expect((await api('v1/capabilities')).status).toBe(504);
  } finally {
    vi.stubEnv('AGENTLINEAGE_CORE_URL', base);
    vi.stubEnv('AGENTLINEAGE_TIMEOUT_MS', '30000');
    server.closeAllConnections();
    server.close();
  }
});

it('propagates caller cancellation as a cancelled result', async () => {
  const controller = new AbortController();
  controller.abort();
  const response = await GET(new Request('http://localhost/api/lineage/core/health', { signal: controller.signal }), {
    params: Promise.resolve({ path: ['health'] }),
  });
  expect(response.status).toBe(499);
  expect((await response.json()).error.code).toBe('LINEAGE_CANCELLED');
});
