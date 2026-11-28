import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InsightClient } from '@/cli/client';
import { exportCommand } from '@/cli/commands/export';
import { dbExportFileName } from '@/lib/observe/export-name';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// CLI `ctxi export`（会话 → 独立 SQLite 导出件）：与工作台页头「导出 SQLite
// 数据库」同一端点（run 成员作用域 export-db），件逐字节等于端点应答。

const mockFetch = vi.fn();
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
const mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

const SQLITE_BYTES = Buffer.concat([Buffer.from('SQLite format 3'), Buffer.from([0]), Buffer.alloc(24, 1)]);
/** 端点应答体（ArrayBuffer 视图——与 Buffer 的底层池解耦，偏移归零） */
const sqliteBody = () => SQLITE_BYTES.buffer.slice(SQLITE_BYTES.byteOffset, SQLITE_BYTES.byteOffset + SQLITE_BYTES.byteLength);

describe('exportCommand', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockProcessExit.mockClear();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers as a Commander sub-command', () => {
    const cmd = exportCommand();
    expect(cmd.name()).toBe('export');
    expect(cmd.description()).toContain('SQLite');
  });

  it('has --session, --output, --json options', () => {
    const cmd = exportCommand();
    const options = cmd.options.map(o => o.long);
    expect(options).toContain('--session');
    expect(options).toContain('--output');
    expect(options).toContain('--json');
    expect(options).toContain('--archive');
  });

  it('exportSessionArchive GETs the run export-archive endpoint and streams the zip to disk', async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    let fetchedUrl = '';
    mockFetch.mockImplementationOnce((url: string) => {
      fetchedUrl = url;
      return Promise.resolve(new Response(zipBytes, { headers: { 'Content-Type': 'application/zip' } }));
    });

    const tmp = path.join(os.tmpdir(), `ctxi-export-${Date.now()}.zip`);
    const result = await new InsightClient('http://localhost:21025', { retries: 0 }).exportSessionArchive('ses_arch_01', tmp);

    expect(fetchedUrl).toBe('http://localhost:21025/api/observe/run/solo%3Ases_arch_01/export-archive');
    expect(fs.readFileSync(tmp).equals(Buffer.from(zipBytes))).toBe(true);
    expect(result.size).toBe(zipBytes.length);
    fs.unlinkSync(tmp);
  });

  it('exportSession GETs the run member-scope export-db endpoint and writes the file byte-identical', async () => {
    let fetchedUrl = '';
    let fetchedInit: RequestInit | undefined;
    mockFetch.mockImplementationOnce((url: string, init: RequestInit) => {
      fetchedUrl = url;
      fetchedInit = init;
      return Promise.resolve(new Response(sqliteBody()));
    });

    const tmp = path.join(os.tmpdir(), `ctxi-export-${Date.now()}.db`);
    const client = new InsightClient('http://localhost:21025', { retries: 0, authToken: 't0ken' });
    const result = await client.exportSession('f3bb027a-xyz', tmp);

    // solo run 的成员作用域端点（solo:<taskId> 整体编码进动态段），GET、带鉴权
    expect(fetchedUrl).toBe('http://localhost:21025/api/observe/run/solo%3Af3bb027a-xyz/export-db');
    expect(fetchedInit?.method).toBe('GET');
    expect((fetchedInit?.headers as Record<string, string>).Authorization).toBe('Bearer t0ken');

    expect(fs.existsSync(tmp)).toBe(true);
    expect(fs.readFileSync(tmp).equals(SQLITE_BYTES)).toBe(true);
    expect(result.size).toBe(SQLITE_BYTES.length);

    fs.unlinkSync(tmp);
  });

  it('throws ApiError with the server error text on non-OK response', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(JSON.stringify({ error: 'Run not found: solo:gone' })) }),
    );

    const client = new InsightClient('http://localhost:21025', { retries: 0 });
    await expect(client.exportSession('gone', path.join(os.tmpdir(), 'ctxi-export-unused.db'))).rejects.toThrow('Run not found: solo:gone');
    expect(fs.existsSync(path.join(os.tmpdir(), 'ctxi-export-unused.db'))).toBe(false);
  });

  it('缺省输出名与工作台导出钮同源：./context_session_<taskId>.db', async () => {
    const cwd = process.cwd();
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxi-export-cwd-'));
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(new Response(sqliteBody())),
    );
    process.chdir(tmpCwd);
    try {
      // 经 Commander 真实解析（不带 --output）：落缺省名
      await exportCommand().parseAsync(['node', 'ctxi', 'export', '--session', 'ses_cli_01', '--json'], { from: 'user' });
    } finally {
      process.chdir(cwd);
    }

    const expected = dbExportFileName({ solo: true, runId: 'solo:ses_cli_01', taskId: 'ses_cli_01' });
    expect(expected).toBe('context_session_ses_cli_01.db');
    expect(fs.existsSync(path.join(tmpCwd, expected))).toBe(true);
    expect(mockConsoleLog.mock.calls.flat().join('\n')).toContain(`"filePath": "${path.join(tmpCwd, expected)}"`);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });
});
