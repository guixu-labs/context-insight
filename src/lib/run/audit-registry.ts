// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/**
 * run 级审计目标注册表（纯函数）：run 合并技能事件 → 域目标列表（skill 域 =
 * invoke/use 事件的目标；agent 域 = dispatch 事件的目标）。每个目标带涉事成员
 * 归因（taskId + 事件数），对账时把涉事成员的 transcript 一起喂 sift（跨成员
 * 聚合语义）。同名目标双面（既 invoke 又 dispatch）在两个域各列一行，与 sift
 * 的 kind 分路一致（skill 声明 ≠ agent 声明）。
 */

export interface RunAuditTargetMember {
  taskId: string
  label: string | null
  count: number
}

export interface RunAuditTarget {
  name: string
  members: RunAuditTargetMember[]
  eventCount: number
}

export interface RunAuditEvent {
  skillName: string
  eventType: string
  member: { taskId: string; label: string | null } | null
}

/** skill 域的成员事件口径：invoke / use。 */
const SKILL_EVENT_TYPES = new Set(["invoke", "use"])

export function deriveDomainTargets(events: RunAuditEvent[], kind: "skill" | "agent"): RunAuditTarget[] {
  const wanted = kind === "skill" ? SKILL_EVENT_TYPES : new Set(["dispatch"])
  const byName = new Map<string, { members: Map<string, RunAuditTargetMember>; eventCount: number }>()
  for (const e of events) {
    if (!e.skillName || !wanted.has(e.eventType)) continue
    const entry = byName.get(e.skillName) ?? { members: new Map<string, RunAuditTargetMember>(), eventCount: 0 }
    entry.eventCount += 1
    const mem = e.member
    if (mem?.taskId) {
      const m = entry.members.get(mem.taskId) ?? { taskId: mem.taskId, label: mem.label ?? null, count: 0 }
      m.count += 1
      m.label = mem.label ?? m.label
      entry.members.set(mem.taskId, m)
    }
    byName.set(e.skillName, entry)
  }
  const targets: RunAuditTarget[] = []
  for (const [name, e] of byName) {
    targets.push({ name, members: [...e.members.values()], eventCount: e.eventCount })
  }
  targets.sort((a, b) => a.name.localeCompare(b.name))
  return targets
}

/** 目标行摘要文案：涉事成员标签列表（收窄展示用）。 */
export function targetMemberLabels(t: RunAuditTarget, max = 3): { shown: string[]; rest: number } {
  const labels = t.members.map(m => m.label ?? m.taskId)
  return { shown: labels.slice(0, max), rest: Math.max(labels.length - max, 0) }
}
