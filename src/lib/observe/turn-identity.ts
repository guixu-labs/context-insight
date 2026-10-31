// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 子代理身份双字段（subagentType + dispatchStep）回填（纯函数，读侧同源）：
// API 时按 subagentSessionId join Bridge 回填，不落库。proxy 形态步骤优先
// Turn.subagentName（=cpx meta.name = Task description，自证身份不依赖桥锚
// 定），原生形态 subagentName 泛化、取桥 dispatchContent。类型唯一运行时源
// 是 Bridge.subagentType。run 是基本单元——session turns 处理器（单会话）与
// run turns 收集器（跨成员）经同一 join 产出，两视图口径不可能分裂。isProxy
// 按 turn 所属会话行判定（run 级成员可能混布 proxy/native）。

import { resolveSubagentIdentity } from '@/lib/subagent-identity';

export interface IdentityTurnRow {
  sessionId: string
  subagentSessionId: string | null
  subagentName: string | null
}

export interface IdentityBridgeRow {
  sessionId: string
  subagentSessionId: string | null
  subagentType: string | null
  dispatchContent: string | null
}

export interface TurnIdentity {
  subagentType: string | null
  step: string | null
}

export function joinSubagentIdentities(
  turns: IdentityTurnRow[],
  bridges: IdentityBridgeRow[],
  isProxyOfSession: (sessionRowId: string) => boolean,
): Map<string, TurnIdentity> {
  // 复用会话（首发+返工同 sid）身份取首发派发——与详情 route 同口径；
  // 不排序+末条覆盖时，列表会显示返工步骤而详情显示首发步骤。首发语义由
  // 调用方查询按 dispatchTimestamp 升序保证（首见即首发）。
  // subagentSessionId 全局唯一（transcript 文件名 stem），跨会话池化无歧义。
  const bridgeBySession = new Map<string, IdentityBridgeRow>()
  for (const b of bridges) {
    if (!b.subagentSessionId) continue
    if (!bridgeBySession.has(b.subagentSessionId)) bridgeBySession.set(b.subagentSessionId, b)
  }
  const identityBySession = new Map<string, TurnIdentity>()
  for (const t of turns) {
    const sid = t.subagentSessionId
    if (!sid || identityBySession.has(sid)) continue
    identityBySession.set(sid, resolveSubagentIdentity({
      subagentName: t.subagentName,
      bridge: bridgeBySession.get(sid) ?? null,
      isProxy: isProxyOfSession(t.sessionId),
    }))
  }
  return identityBySession
}
