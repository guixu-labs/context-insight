// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 观测取数源抽象（design: docs/design/run-observe-parity/design.md §5.2）。
// 自取数观测组件（Perf / Skills / Files 等）经此切换 session / run 数据源
// 而不 fork：session 端点以 taskId(+framework) 寻址，run 端点以路径段
// runId 寻址——形状差异在此单点吸收，调用方只声明域（turns / turns/search /
// ...）与查询参数。缺省（不传 source）即 session 语义，既有调用零改动。

export type ObserveSource =
  | { kind: 'session'; taskId: string; framework?: string | null }
  | { kind: 'run'; runId: string };

/** 观测端点 URL 构造：domain 形如 'turns' | 'turns/search' | 'bridges'。 */
export function observeUrl(
  source: ObserveSource,
  domain: string,
  params: Record<string, string | number | null | undefined> = {},
): string {
  const p = new URLSearchParams();
  if (source.kind === 'session') {
    p.set('taskId', source.taskId);
    if (source.framework) p.set('framework', source.framework);
  }
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') p.set(k, String(v));
  }
  if (source.kind === 'session') {
    return `/api/observe/session/${domain}?${p.toString()}`;
  }
  return `/api/observe/run/${encodeURIComponent(source.runId)}/${domain}?${p.toString()}`;
}
