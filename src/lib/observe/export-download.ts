// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工作台导出件的浏览器落盘单点（页头的 SQLite / Markdown / 离线 HTML 三个导出
// 钮共用）：File System Access API 可用（Chromium）走系统「另存为」对话框
// （showSaveFilePicker，带格式类型过滤）；不可用（Firefox / Safari）或对话框
// 以外的失败回落 Blob 锚点下载；用户取消（AbortError）静默收场。
// GET 型文件端点的取流收尾也在本模块（fetchExportFile）：文件名以服务端
// content-disposition 为单一源，取不到才用调用方的回落名。

export interface SaveFileKind {
  description: string;
  accept: Record<string, string[]>;
}

export const SQLITE_FILE: SaveFileKind = { description: "SQLite Database", accept: { "application/x-sqlite3": [".db"] } };
export const MARKDOWN_FILE: SaveFileKind = { description: "Markdown", accept: { "text/markdown": [".md"] } };
export const HTML_FILE: SaveFileKind = { description: "HTML", accept: { "text/html": [".html"] } };
export const ZIP_FILE: SaveFileKind = { description: "Zip Archive", accept: { "application/zip": [".zip"] } };

/** FileSystemWritableFileStream 的最小形态：本身是 WritableStream（可被
 *  res.body.pipeTo 直灌、大文件不过内存），又带 write(Blob) 便捷写。 */
type SaveWritable = WritableStream<Uint8Array> & { write: (data: Blob) => Promise<void> };
type SaveHandle = { createWritable: () => Promise<SaveWritable> };

export function fallbackDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

export function saveBlob(blob: Blob, filename: string, kind: SaveFileKind): void {
  const w = window as unknown as { showSaveFilePicker?: (o: { suggestedName: string; types: SaveFileKind[] }) => Promise<SaveHandle> };
  if (typeof w.showSaveFilePicker === "function") {
    w.showSaveFilePicker({ suggestedName: filename, types: [kind] })
      .then(async (handle) => {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        fallbackDownload(blob, filename);
      });
    return;
  }
  fallbackDownload(blob, filename);
}

/** 从 content-disposition 取文件名：filename*（UTF-8 原名）优先，其次 filename=。 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      /* 畸形编码：落到 filename= / 回落名 */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(header) ?? /filename\s*=\s*([^;\s]+)/i.exec(header);
  return plain?.[1] || fallback;
}

/** GET 一个文件导出端点并落盘。失败抛 Error（服务端 error 文案 / 网络错误），
 *  提示交给调用方。 */
export async function fetchExportFile(
  url: string,
  opts: { mime: string; kind: SaveFileKind; fallbackName: string },
): Promise<{ filename: string; bytes: number }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("Network error");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error ?? `HTTP ${res.status}`);
  }
  const filename = filenameFromDisposition(res.headers.get("Content-Disposition"), opts.fallbackName);

  // 流式落盘：归档件可过 4GB，整包 arrayBuffer 进内存浏览器会 OOM——FS Access
  // API 可用且响应带体时 res.body 直灌 writable；不可用 / 无 body / 对话框失败
  // 才整包读回落 Blob 锚点
  const picker = (window as unknown as {
    showSaveFilePicker?: (o: { suggestedName: string; types: SaveFileKind[] }) => Promise<SaveHandle>;
  }).showSaveFilePicker;
  if (typeof picker === "function" && res.body) {
    const total = Number(res.headers.get("Content-Length") ?? 0) || 0;
    try {
      const handle = await picker({ suggestedName: filename, types: [opts.kind] });
      const writable = await handle.createWritable();
      await res.body.pipeTo(writable);
      return { filename, bytes: total };
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return { filename, bytes: 0 };
      // 对话框外失败（安全限制等）→ 整包读回落锚点，不再重试 picker
      const blob = new Blob([await res.arrayBuffer()], { type: opts.mime });
      fallbackDownload(blob, filename);
      return { filename, bytes: blob.size };
    }
  }
  const blob = new Blob([await res.arrayBuffer()], { type: opts.mime });
  saveBlob(blob, filename, opts.kind);
  return { filename, bytes: blob.size };
}
