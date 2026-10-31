// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// runId 命名空间单点（design: docs/design/run-first-architecture/design.md §3.1）。
// runId ∈ { bundle runId（workflow 导入） | solo:<taskId>（无主 session 合成） }。
// `solo:` 前缀是保留命名空间——判定一律经此单点，禁止散落 startsWith；
// bundle 清单 id 不得使用该前缀（solo 分支优先级高于 run-store 读取）。

export const SOLO_RUN_PREFIX = 'solo:';

export function isSoloRunId(runId: string): boolean {
  return runId.startsWith(SOLO_RUN_PREFIX) && runId.length > SOLO_RUN_PREFIX.length;
}

export function soloTaskIdOf(runId: string): string | null {
  return isSoloRunId(runId) ? runId.slice(SOLO_RUN_PREFIX.length) : null;
}

export function soloRunIdOf(taskId: string): string {
  return SOLO_RUN_PREFIX + taskId;
}

/**
 * 动态段归一化：Next 客户端导航时 use(params) 可能拿到保持 URL 编码形态的
 * 段值（solo%3A…；SSR/直刷为解码形态）。decodeURIComponent 对已解码且不含 %
 * 的常规 id 幂等，统一在此归一；畸形态（孤立 %）原样返回不抛。
 */
export function normalizeRunIdParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
