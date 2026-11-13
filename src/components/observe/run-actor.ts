// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT ANY KIND OF EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// run 参与者（actor）目录——成员/子代理统一身份建模（单一源）：
// 一个 run 的展示对象只有两类——成员（root 派发的工作流成员会话，session 即
// agent）与子代理（会话内 Task 派生，跨成员按 sid 池化）。身份键（分组）、
// 图例键（配色）、展示名（类型别名归一 + 同名编号 + 派发步骤回落）在此单点
// 组合；ContextTracker 趋势卡/图例胶囊/摘要、ContextReplayDialog 回放等展示
// 侧一律经此取名，禁止各处内联 `subagentType ?? agentName` + `#N` 组合——
// 那是口径分裂之源（图例胶囊曾不套别名、Tracker 与 Replay 各持一份别名表）。
//
// 命名规则（唯一裁定）：
// - 成员/主会话：memberLabel（服务端 memberShortNames 产物，nodeId 逻辑名）
//   → agentName → "Main Agent"；
// - 子代理：类型基名（SUBAGENT_TYPE_ALIASES 归一）+ 同名编号 `#N`
//   （buildSubagentNumbers 单源，0 token 组也参与）；类型缺失（无桥归因：
//   嵌套派发/桥锚定失败）回落派发步骤（agentName，即 cpx meta.name /
//   Task description），nameSource='step' 标记出处，UI 以「派发」徽标区分
//   两种命名群体——派发步骤与类型名不再裸混一列。

import { contextAgentKeyOf, contextLegendKeyOf } from "@/components/observe/context-legend"
import { fallbackAgentDisplayName } from "@/components/observe/agent-display-name"
import { buildSubagentNumbers } from "@/lib/subagent-numbering"

export type RunActorKind = "main" | "member" | "subagent"
export type RunActorNameSource = "member" | "type" | "step"

export interface RunActorTurn {
  turnIndex: number
  agentName: string | null
  isSubagent: boolean
  subagentSessionId: string | null
  createdAt: string | null
  subagentType?: string | null
  member?: { taskId: string; label: string | null } | null
}

export interface RunActor {
  /** 身份键（= contextAgentKeyOf：趋势统计/曲线/回放分组键） */
  key: string
  kind: RunActorKind
  isRoot: boolean
  sessionId: string
  agentName: string
  subagentType: string | null
  memberTaskId: string | null
  memberLabel: string | null
  /** 图例/分组基名（类型别名归一；无类型 = 派发步骤） */
  baseName: string
  /** 同名消歧编号（唯一名不编号） */
  number: number | undefined
  /** 最终展示名：成员短名 / 基名 #N */
  displayName: string
  /** 展示名出处（'step' = 派发步骤回落，UI 加「派发」徽标） */
  nameSource: RunActorNameSource
  /** 图例键（= contextLegendKeyOf：配色/分组） */
  legendKey: string
}

/** 类型别名（过长类型名的展示归一——原表曾在 Tracker/Replay 散落两份拷贝） */
export const SUBAGENT_TYPE_ALIASES: Record<string, string> = {
  "acme-kernel-architect": "acme-arch",
  "acme-kernel-developer": "acme-dev",
}

export function subagentBaseNameOf(a: { subagentType: string | null; agentName: string }): string {
  const raw = a.subagentType ?? a.agentName
  return SUBAGENT_TYPE_ALIASES[raw] ?? raw
}

/** 全量 turns → actor 目录（键 = contextAgentKeyOf）。0 token 组也建卡——
 *  编号契约（Turn 页无图可画也要有身份）；展示侧按需过滤。 */
export function buildRunActors(turns: RunActorTurn[]): Map<string, RunActor> {
  const groups = new Map<string, RunActorTurn>()
  for (const t of turns) {
    const key = contextAgentKeyOf(t)
    if (!groups.has(key)) groups.set(key, t)
  }
  const numbers = buildSubagentNumbers(turns)
  const actors = new Map<string, RunActor>()
  for (const [key, t] of groups) {
    const isRoot = !t.isSubagent
    const agentName = fallbackAgentDisplayName({
      isSubagent: !isRoot,
      memberLabel: t.member?.label,
      agentName: t.agentName,
    })
    const subagentType = isRoot ? null : t.subagentType ?? null
    const kind: RunActorKind = isRoot ? (t.member ? "member" : "main") : "subagent"
    let baseName: string
    let displayName: string
    let nameSource: RunActorNameSource
    if (isRoot) {
      baseName = t.member?.label ?? agentName
      displayName = baseName
      nameSource = "member"
    } else {
      baseName = subagentBaseNameOf({ subagentType, agentName })
      const num = numbers.get(key)
      displayName = num !== undefined ? `${baseName} #${num}` : baseName
      nameSource = subagentType ? "type" : "step"
    }
    actors.set(key, {
      key,
      kind,
      isRoot,
      sessionId: key,
      agentName,
      subagentType,
      memberTaskId: t.member?.taskId ?? null,
      memberLabel: t.member?.label ?? null,
      baseName,
      number: numbers.get(key),
      displayName,
      nameSource,
      legendKey: contextLegendKeyOf({ sessionId: key, agentName, isRoot, subagentType }),
    })
  }
  return actors
}
