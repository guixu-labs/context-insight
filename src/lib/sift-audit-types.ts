// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/**
 * AuditReport 的 TS 类型固化，对应 sift 的
 * `sift/models/audit_models.py`（AuditReport / AuditFinding /
 * InstructionAggregate）。后端 spawn sift 跑出的 audit-report.json
 * 即此 shape，经 NDJSON result 事件原样回传前端（见 sift-runner.ts）。
 *
 * 判定模型两个正交维度：
 * - verdict（结果）五态：PASS / FAIL / N/A / UNRESOLVED（未判定，可重跑）/
 *   INDETERMINATE（存疑，重跑无益）。
 * - method（方法）两态：PROGRAMMATIC（程序对账，不调 LLM）/ LLM。
 */

export type AuditVerdict = "PASS" | "FAIL" | "N/A" | "UNRESOLVED" | "INDETERMINATE"

export type AuditMethod = "PROGRAMMATIC" | "LLM"

export type AuditCategory = "conditional" | "prohibition" | "step" | "output"

/** 单条指令的对账结果（对应 pydantic AuditFinding）。 */
export interface AuditFinding {
  instruction_text: string
  /** 声明原文里所属 bullet 的完整文本（含被切的主语上下文）；显示用、判定不读。可缺省。 */
  source_excerpt?: string
  /** 原文 bullet 的人话标题（去噪+补主语+压一句）；显示优先用它，判定不读。可缺省。 */
  headline?: string
  /** 指令的规则类型，如 "CONSTRAINT" / "STEP"（InstructionSource 的值，非 method）。 */
  source: string
  verdict: AuditVerdict
  method: AuditMethod
  category: AuditCategory
  /** 中文，为何这个 verdict（INDETERMINATE 时即 indeterminate_reason）。 */
  evidence: string
  /** 该 finding 对应的 transcript 文件名。 */
  transcript: string
  derived_from_transcript?: boolean
  /** 去重后编排的序号 #1..#N（related 引用 + 报告定位用）。 */
  seq?: number
  /** 同文去重后合并的所有来源；单条 = [source]。 */
  sources?: string[]
  /** 同行为跨类（Case B）关联的其它 finding 序号，如 ["#9"]。 */
  related?: string[]
  /** FAIL 噪声判别标签（仅 FAIL 有）；非 FAIL 为 null。 */
  noise_label?: string | null
  noise_reasons?: string[]
  /** 该 finding 证据涉及的对话 turn 序号（1-based turnIndex），点击可跳转到 Turns tab 对应 turn。 */
  turn_refs?: number[]
}

/** 单条指令跨 transcript 的对账聚合（对应 InstructionAggregate）。 */
export interface InstructionAggregate {
  instruction_text: string
  /** 所属 bullet 完整原文（含主语）；显示用、判定不读。可缺省。 */
  source_excerpt?: string
  /** 人话标题；显示优先用它，判定不读。可缺省。 */
  headline?: string
  source: string
  category: AuditCategory
  pass_count: number
  fail_count: number
  na_count: number
  unresolved_count?: number
  indeterminate_count?: number
  total: number
  fail_rate: number
  fail_in_transcripts: string[]
  na_in_transcripts?: string[]
  fail_seqs?: number[]
  na_seqs?: number[]
  noise_label?: string | null
  noise_reasons?: string[]
}

/** audit 各阶段（extract/refine/headline/rebuild/judge/postprocess）的耗时 + token（对应 pydantic stage_breakdown）。 */
export interface StageBreakdownRow {
  stage: string
  seconds: number
  input_tokens: number
  output_tokens: number
  /** cache 命中读取的 token（仅 LLM 阶段 refine/headline/judge 才有；对齐 sift stage_breakdown 透传）。 */
  cache_read_input_tokens?: number
  calls: number
  /** refine/headline 在 calls=0 时："缓存命中"（开关开、跑了秒回）/ "未启用"（开关关）；其余阶段空。 */
  note?: string
}

/** 一个 skill 一次 audit 的完整报告（对应 pydantic AuditReport）。 */
export interface AuditReport {
  skill_name: string
  transcripts: string[]
  transcript_sources?: string[]
  /** {total, pass, fail, na, unresolved, indeterminate}。 */
  summary: {
    total: number
    pass: number
    fail: number
    na: number
    unresolved?: number
    indeterminate?: number
  }
  findings: AuditFinding[]
  by_instruction?: InstructionAggregate[]
  warnings?: string[]
  /** refine（LLM 精筛伪指令）砍掉的条数。 */
  refine_dropped_count?: number
  /** 本次 audit 所有 LLM 判定调用的 token 用量合计（input/output/cache/cost/calls）。 */
  token_usage?: Record<string, number>
  /** audit 墙钟（秒）；stage_breakdown 各阶段秒数之和 ≈ 此值。 */
  duration_seconds?: number
  /** 各阶段耗时 + token，诊断慢在哪；refine/headline calls=0 时 note 标缓存命中/未启用。 */
  stage_breakdown?: StageBreakdownRow[]
  /** 声明指令覆盖总聚合（coverage 表数据；对应 pydantic CoverageSummary）。 */
  coverage?: CoverageSummary
  /** 声明文本覆盖视图（sift text_coverage 模块产）：对账结果回指上卷到声明原文单元（bullet/段落/代码块），三态着色。旧报告缺省（不显）。 */
  text_coverage?: TextCoverageSummary
  /** 对账时刻的声明原文快照；文本覆盖视图以此为渲染基准（声明事后被编辑不张冠李戴）。旧报告缺省。 */
  skill_body?: string
  /** sift `--run` 原生对账回填的 run 溯源（命中会话/调用数 + 审计单元映射）。 */
  run?: AuditRunMeta
}

/** coverage 的单指令聚合（对应 pydantic InstructionCoverage）：该指令在全体 transcript 上的触达三态 + 计数。 */
export interface InstructionCoverage {
  instruction_text: string
  source_excerpt?: string
  headline?: string
  source: string
  category: AuditCategory
  section?: string
  status: "covered" | "uncovered" | "unknown"
  pass_count?: number
  fail_count?: number
  na_count?: number
  unresolved_count?: number
  indeterminate_count?: number
  total?: number
  seqs?: number[]
}

/** coverage 的单章节聚合（对应 pydantic SectionCoverage）：该节指令触达三态计数 + 明细。 */
export interface SectionCoverage {
  section: string
  total?: number
  covered: number
  uncovered: number
  unknown: number
  coverage_rate: number
  instructions: InstructionCoverage[]
}

/** 声明指令覆盖总聚合（对应 pydantic CoverageSummary；report.coverage）。 */
export interface CoverageSummary {
  total: number
  covered: number
  uncovered: number
  unknown: number
  coverage_rate: number
  sections?: SectionCoverage[]
}

/** 回指到声明原文单元的一条指令（对应 pydantic TextUnitInstruction；轻量引用：状态 + 人话标题，明细看 coverage.sections）。 */
export interface TextUnitInstruction {
  instruction_text: string
  headline?: string
  status: "covered" | "uncovered" | "unknown"
}

/** 声明原文的一个文本单元（对应 pydantic TextCoverageUnit；声明原文覆盖图的一行）。 */
export interface TextCoverageUnit {
  kind: "heading" | "bullet" | "paragraph" | "codeblock"
  /** 单元在 skill_body 里的字符区间（诊断用；渲染以 text 为准——JS 按区间切片有 UTF-16 代理对偏移风险）。 */
  start?: number
  end?: number
  text: string
  /** 三态：covered=该段指令全部触达 / uncovered=有指令未验证（未触发或判不全，保守最低态）/ unmodeled=没抽出指令；heading 为空串（结构行）。 */
  state?: "" | "covered" | "uncovered" | "unmodeled"
  /** codeblock 专属：fence 开块时所处的标题（OUTPUT_FORMAT 回指键）；旧报告可缺省。 */
  heading?: string
  instructions?: TextUnitInstruction[]
}

/** 声明文本覆盖视图总聚合（对应 pydantic TextCoverageSummary）。双指标不混含义：coverage_rate=covered/modeled（未建模不进分母）；modeled_ratio=modeled/total_units（建模完整度）。 */
export interface TextCoverageSummary {
  total_units: number
  covered: number
  uncovered: number
  unmodeled: number
  coverage_rate: number
  modeled_ratio: number
  unmapped_instructions?: string[]
  units: TextCoverageUnit[]
}

/** root 对账组合声明的层信息：随 NDJSON result 事件回传（report 之外），供 finding 分层徽章匹配。 */
export interface AuditLayerInfo {
  /** regulation=编排规程（怎么干），plan=任务计划（干什么）。 */
  kind: "regulation" | "plan"
  /** 层中文标签（UI 徽章显示）。 */
  label: string
  /** 来源标识（如 "task-prompts.md" / "STATE.md"）。 */
  source: string
  /** 该层正文（已归一为声明态）；finding 按 instruction_text 子串匹配归层。 */
  content: string
}

/** run 级对账的成员归因：transcript 文件名 → 成员（finding.transcript 反查深链用）。 */
export interface AuditMemberRef {
  taskId: string
  label: string | null
  framework?: string | null
}

export type AuditMemberMap = Record<string, AuditMemberRef>

/** sift `--run` 的审计单元：一个被对账的切片/会话 → run 成员与命中的原生调用 id。 */
export interface AuditRunUnit {
  auditUnitId: string
  memberId: string
  sessionId: string
  source: string
  scope: "session" | "agent-segment" | "invocation"
  matchedToolUseIds: string[]
}

/** sift `--run` 随报告回填的 run 溯元数据（run.py build_run_report_metadata）。 */
export interface AuditRunMeta {
  runId: string
  bundlePath: string
  matchedSessionCount: number
  targetCallCount: number
  auditUnitCount: number
  units: AuditRunUnit[]
  warnings?: string[]
}

/** store 侧物化的 result：report + 可选原始 HTML（逃生口用）+ 可选分层声明（root 拼接）
 * + run 级对账的成员映射（transcript 文件名 → 成员）。 */
export type SkillAuditStoredResult = AuditReport & {
  _html?: string
  _layers?: AuditLayerInfo[]
  _members?: AuditMemberMap
}
