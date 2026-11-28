// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// @vitest-environment happy-dom

// 工作台导出落盘单点 IT：fetchExportFile 在 FS Access API 可用时走 res.body
// 直灌（pipeTo，大文件不过内存），不可用才整包 arrayBuffer 回落 Blob 锚点。
// 锁的是「流式优先」这条契约——归档件可过 4GB，整包 arrayBuffer 进内存浏览器
// 会 OOM。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchExportFile, ZIP_FILE, SQLITE_FILE } from '@/lib/observe/export-download';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
});

function fileResponse(opts: { body: ReadableStream<Uint8Array> | null; arrayBuffer: () => Promise<ArrayBuffer> }): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name === 'Content-Disposition' ? 'attachment; filename="out.zip"' : name === 'Content-Length' ? '12' : null),
    },
    body: opts.body,
    arrayBuffer: opts.arrayBuffer,
    json: async () => ({}),
  } as unknown as Response;
}

describe('fetchExportFile 落盘：流式优先、Blob 锚点回落', () => {
  it('showSaveFilePicker 可用 + 响应带体：res.body.pipeTo 直灌，不整包 arrayBuffer', async () => {
    const pipeTo = vi.fn(async () => {});
    const body = { pipeTo } as unknown as ReadableStream<Uint8Array>;
    const arrayBuffer = vi.fn(async () => new TextEncoder().encode('hello world').buffer);
    vi.stubGlobal('fetch', async () => fileResponse({ body, arrayBuffer }));

    let suggested = '';
    (window as unknown as Record<string, unknown>).showSaveFilePicker = async (o: { suggestedName: string }) => {
      suggested = o.suggestedName;
      return { createWritable: async () => ({}) };
    };

    const result = await fetchExportFile('/api/export', { mime: 'application/zip', kind: ZIP_FILE, fallbackName: 'fb.zip' });

    expect(suggested).toBe('out.zip');
    expect(pipeTo).toHaveBeenCalledTimes(1);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(result).toEqual({ filename: 'out.zip', bytes: 12 });
  });

  it('showSaveFilePicker 不可用：整包 arrayBuffer → Blob 锚点回落', async () => {
    const arrayBuffer = vi.fn(async () => new TextEncoder().encode('hello world').buffer);
    vi.stubGlobal('fetch', async () => fileResponse({ body: null, arrayBuffer }));
    (window as unknown as Record<string, unknown>).showSaveFilePicker = undefined;

    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:fallback') as never;
    URL.revokeObjectURL = vi.fn() as never;

    const result = await fetchExportFile('/api/export', { mime: 'application/x-sqlite3', kind: SQLITE_FILE, fallbackName: 'fb.db' });

    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(result.filename).toBe('out.zip');
  });

  it('showSaveFilePicker 可用但对话框失败（非取消）：整包读回落锚点，不重试 picker', async () => {
    const arrayBuffer = vi.fn(async () => new TextEncoder().encode('hello world').buffer);
    const body = { pipeTo: vi.fn(async () => {}) } as unknown as ReadableStream<Uint8Array>;
    vi.stubGlobal('fetch', async () => fileResponse({ body, arrayBuffer }));

    let calls = 0;
    (window as unknown as Record<string, unknown>).showSaveFilePicker = async () => {
      calls += 1;
      throw new Error('security');
    };
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:fallback') as never;
    URL.revokeObjectURL = vi.fn() as never;

    const result = await fetchExportFile('/api/export', { mime: 'application/zip', kind: ZIP_FILE, fallbackName: 'fb.zip' });

    expect(calls).toBe(1); // 不重试 picker
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(result.filename).toBe('out.zip');
  });
});
