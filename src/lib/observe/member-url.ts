// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话视图端点覆盖单点（design: docs/design/run-first-architecture/design.md
// §3.4，刀I2）。session 独有能力组件（WireRounds / TrajectoryScoring / SkillDetail
// 族）保持 session 语义的 taskId+framework props；挂入 run 工作台时经 urlFor
// 把 `/api/observe/session/<path>` 换成 run 成员视图
// `/api/observe/run/<runId>/<path>?member=<taskId>`（刀I1 转发端点），session
// 页缺省行为不变。/api/ai/* 与 run 语义无关（body 带真实成员 taskId 直取），
// 不在此层。

export type ViewUrlFor = (path: string) => string

export const sessionViewUrlFor: ViewUrlFor = (path) => `/api/observe/session/${path}`

// 同 (runId, member) 返回同一函数身份——调用方内联传参（I3 各 tab 的
// urlFor={runMemberUrlFor(runId, member)}）不会让依赖它的 effect/useCallback
// 身份漂移（否则每次 render 重建 → 无限重取）。
const runMemberUrlForCache = new Map<string, ViewUrlFor>()

export function runMemberUrlFor(runId: string, member: string): ViewUrlFor {
  const key = `${runId}\u0000${member}`
  let cached = runMemberUrlForCache.get(key)
  if (cached == null) {
    cached = (path) => {
      const base = `/api/observe/run/${encodeURIComponent(runId)}/${path}`
      const joiner = path.includes("?") ? "&" : "?"
      return `${base}${joiner}member=${encodeURIComponent(member)}`
    }
    runMemberUrlForCache.set(key, cached)
  }
  return cached
}
