// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 统一导入向导的本地路径类型探测（design: docs/design/unified-workbench/design.md §4）。
// 「选择即类型」：用户不预先选会话/Run——手动路径先探测，目录含 bundle
// 清单文件 → run job；否则走会话通路（单文件直导 / 扫描选择）。
// 探测复用 browse-directory 的服务端文件系统事实（同一锚定文件规则，
// 与 route 及 import-service 的 MANIFEST_FILENAMES 同源语义），失败回落
// 会话通路（由后续请求给出真实错误信息）。

import { BUNDLE_MANIFEST_FILE } from '@/lib/lake/bundle-layout';
import type { AssetKind } from './types';

async function detectLocalImportKind(path: string): Promise<AssetKind> {
  try {
    const res = await fetch('/api/ingest/browse-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dirPath: path }),
    });
    if (!res.ok) return 'session';
    const data = await res.json();
    if (!data.isDirectory) return 'session';
    const entries = (data.entries ?? []) as Array<{ name: string; isDir: boolean }>;
    const isManifest = (name: string) => name === BUNDLE_MANIFEST_FILE || name === 'manifest.json';
    return entries.some(e => !e.isDir && isManifest(e.name)) ? 'run' : 'session';
  } catch {
    return 'session';
  }
}

export { detectLocalImportKind };
