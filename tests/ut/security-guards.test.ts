// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 安全修复 IT（0000026/0000050/0000088/0000143/0000147 等）：
// taskId 白名单（export-db 端点 / exportSession）、
// lake filenames 遍历拒绝。按信任边界判定：外部威胁在文件内容侧
// （taskId/filenames 已在落地 sink 封堵）；导入/浏览路径为本地自用功能，
// 刻意不设白名单。API 层走完整 POST 数据流，mock prisma 与
// child_process（lake 镜像 fetch），不触网、不落真实 git 仓。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LAKE_CACHE = path.join(os.tmpdir(), `lake-import-guard-${process.pid}`);
fs.rmSync(LAKE_CACHE, { recursive: true, force: true });
fs.mkdirSync(path.join(LAKE_CACHE, '.git'), { recursive: true });
process.env.LAKE_CACHE_DIR = LAKE_CACHE;

const execMock = vi.fn((_args: string[]) => Buffer.alloc(0));
vi.mock('node:child_process', () => ({ execFileSync: execMock }));

vi.mock('@/lib/db', () => ({ prisma: {} }));

const { exportRowsMock } = vi.hoisted(() => ({ exportRowsMock: vi.fn() }));
vi.mock('@/lib/ingest/export-service', () => ({ exportSessionRows: exportRowsMock }));
// run 作用域解析与 run-store：端点只经它们拿成员行 id 与 run 名——这里按
// 信任边界 mock（作用域解析自身的 IT 在 run-*.test.ts），只锁端点的闸与委托
const { scopeMock } = vi.hoisted(() => ({ scopeMock: vi.fn() }));
vi.mock('@/lib/run/observe/scope', () => ({ resolveRunScope: scopeMock }));
const { readRunMock } = vi.hoisted(() => ({ readRunMock: vi.fn() }));
vi.mock('@/lib/run/run-store', () => ({ readRun: readRunMock }));

const { GET: exportDbGET } = await import('@/app/api/observe/run/[runId]/export-db/route');
const { isPathInside } = await import('@/lib/ingest/import-paths');
const { exportSession } = await vi.importActual<typeof import('@/lib/ingest/export-service')>('@/lib/ingest/export-service');

function callExportDb(runId: string): Promise<Response> {
  return exportDbGET(new NextRequest(`http://localhost/api/observe/run/${encodeURIComponent(runId)}/export-db`), {
    params: Promise.resolve({ runId }),
  });
}

const SQLITE_HEADER = Buffer.concat([Buffer.from('SQLite format 3'), Buffer.from([0]), Buffer.alloc(16)]);

function req(url: string, body: unknown, method = 'POST'): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  execMock.mockReset().mockImplementation(() => Buffer.alloc(0));
  exportRowsMock.mockReset();
  scopeMock.mockReset();
  readRunMock.mockReset();
});

describe('import 路径守卫（仅 lake filenames 收敛 —— 导入/浏览路径为本地自用功能，不设白名单）', () => {
  it('isPathInside 单元口径', () => {
    expect(isPathInside('/data/clone', 'sub/x.db')).toBe(true);
    expect(isPathInside('/data/clone', '../../etc/passwd')).toBe(false);
    expect(isPathInside('/data/clone', '/etc/passwd')).toBe(false);
  });
});

describe('taskId 白名单 — export-db 端点 / exportSession', () => {
  it('export-db 端点：run 不存在（含遍历形态的 solo id）→ 404，不触达写管线', async () => {
    scopeMock.mockResolvedValue(null);
    for (const runId of ['solo:../../evil', 'solo:a/../../evil', 'no-such-run']) {
      const res = await callExportDb(runId);
      expect(res.status).toBe(404);
      expect((await res.json()).reason).toBe('run-not-found');
    }
    // 作用域解析是唯一入口：三次请求各解析一次，id 原样交给它判定（不在端点里另拼路径）
    expect(scopeMock).toHaveBeenCalledTimes(3);
    expect(exportRowsMock).not.toHaveBeenCalled();
  });

  it('export-db 端点：合法 run → 按 scope 成员行 id 委托写管线，响应为 SQLite 附件且临时件即删', async () => {
    const dummy = path.join(os.tmpdir(), `export-db-guard-${process.pid}.db`);
    fs.writeFileSync(dummy, SQLITE_HEADER);
    scopeMock.mockResolvedValue({
      kind: 'run',
      runId: 'run-ok',
      members: [
        { rowId: 'row-a', taskId: 'ses_a', framework: 'claude-code', label: null, structure: null },
        { rowId: 'row-b', taskId: 'ses_b', framework: 'codex', label: null, structure: null },
      ],
    });
    readRunMock.mockReturnValue({ manifest: { name: 'demo run' } });
    exportRowsMock.mockResolvedValue({ path: dummy, sessions: 2, turns: 3, toolCalls: 0, skillEvents: 0, executions: 0, bridges: 0 });

    const res = await callExportDb('run-ok');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-sqlite3');
    expect(res.headers.get('content-disposition')).toContain('context_session_run_demo_run.db');
    expect(Buffer.from(await res.arrayBuffer()).equals(SQLITE_HEADER)).toBe(true);
    // 成员行 id 按作用域顺序整份委托（bundle = 全员，不在端点里挑行）
    expect(exportRowsMock).toHaveBeenCalledWith(['row-a', 'row-b'], undefined, expect.anything());
    // 临时件读完即删：不留在 tmp
    expect(fs.existsSync(dummy)).toBe(false);
  });

  it('export-db 端点：solo run 文件名用会话口径', async () => {
    const dummy = path.join(os.tmpdir(), `export-db-guard-solo-${process.pid}.db`);
    fs.writeFileSync(dummy, SQLITE_HEADER);
    scopeMock.mockResolvedValue({
      kind: 'run',
      runId: 'solo:ses_ok',
      members: [{ rowId: 'row-solo', taskId: 'ses_ok', framework: 'opencode', label: '主Agent', structure: null }],
    });
    exportRowsMock.mockResolvedValue({ path: dummy, sessions: 1, turns: 0, toolCalls: 0, skillEvents: 0, executions: 0, bridges: 0 });

    const res = await callExportDb('solo:ses_ok');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('context_session_ses_ok.db');
    // solo 合成作用域无 run-store 记录：不读 run-store
    expect(readRunMock).not.toHaveBeenCalled();
    // 读完响应体（流关闭）后临时件即删：不留在 tmp
    await res.arrayBuffer();
    expect(fs.existsSync(dummy)).toBe(false);
  });

  it('export-db 端点：写管线失败（成员行缺失）→ 500 带原因，不吐半截文件', async () => {
    scopeMock.mockResolvedValue({
      kind: 'run',
      runId: 'run-stale',
      members: [{ rowId: 'row-gone', taskId: 'ses_gone', framework: 'opencode', label: null, structure: null }],
    });
    readRunMock.mockReturnValue(null);
    exportRowsMock.mockRejectedValue(new Error('Session not found: 1 of 1 rows'));

    const res = await callExportDb('run-stale');
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Session not found: 1 of 1 rows');
  });

  it('exportSession 库函数：非法 taskId 先于 Prisma 查询抛错；合法 taskId 走查询', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const fakePrisma = { session: { findFirst } } as never;
    await expect(exportSession('x/../../evil', undefined, fakePrisma)).rejects.toThrow('Invalid taskId');
    await expect(exportSession('', undefined, fakePrisma)).rejects.toThrow('Invalid taskId');
    await expect(exportSession('a'.repeat(129), undefined, fakePrisma)).rejects.toThrow('Invalid taskId');
    await expect(exportSession('ses_ok', undefined, fakePrisma)).rejects.toThrow('Session not found');
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});

