// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software you can redistribute it and/or modify it under the terms and
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 源 bundle 目录解析：sift `--run` 原生对账的输入面。导入元数据
// （import.json 的 sourceDir）指向用户导入时的 workflow-bundle 目录；sift 侧
// 要求该目录仍在盘且带 workflow.schema.json（与 insight 同一钉死哈希的契约文件）
// + workflow.json + sessions/。任一不满足返回 null，调用方回落 DB transcript
// 路径（solo run 无源 bundle，天然回落）。

import fs from 'node:fs';
import path from 'node:path';
import { readRun } from './run-store';
import { WORKFLOW_SCHEMA_FILE } from './model';

export function resolveRunBundleDir(runId: string): string | null {
  const stored = readRun(runId);
  const raw = stored?.meta?.data.sourceDir;
  if (!raw || typeof raw !== 'string') return null;
  const dir = path.resolve(raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  const has = (p: string): boolean => {
    try {
      return fs.statSync(path.join(dir, p)).isFile();
    } catch {
      return false;
    }
  };
  if (!has(WORKFLOW_SCHEMA_FILE) || !has('workflow.json')) return null;
  try {
    return fs.statSync(path.join(dir, 'sessions')).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}
