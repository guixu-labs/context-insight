// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import fs from 'node:fs';
import { truncateUtf16Safe, stripSystemReminders } from '@/lib/shared/text-strip';
import path from 'node:path';
import { readCaptureBuffer, readCaptureHead, readCaptureText as readArchivedText } from '@/lib/compression';
import { createLogger } from '@/lib/logger';
import { readEnvelope, readEnvelopeWithLegacy } from '@/lib/shared/envelope';
import { classifyUserInjection, staticInjectionBlockPredicateFor, stripTokenBudgetReminders } from './injections/index';
import { isSkillInjectionText } from './injections/claude-code';
import { isRolloutFileName } from './codex-naming';
import { isDshSessionLogName } from '../dsh-bridge/native';
import type { SessionFileRef, SessionFileRole, SubagentRef } from './contract';
import type { SessionListItem, RawInteraction, ToolCallInfo, TokenUsage, SubagentLinkageMaps } from '../../shared/types';
import { normalizeToolResultPayload } from '../../tool-conventions';

// Shared scan helpers (claude-format concepts, also reused by the proxy
// extension layer claude-jsonl-full-context.ts).
export function extractSystemText(system: string | ContentBlock[] | undefined): string | null {
  if (!system) return null;
  if (typeof system === 'string') return system || null;
  const parts: string[] = [];
  for (const block of system) {
    if (block.type === 'text' && block.text) parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

export interface ClaudeJsonlLine {
  type: string;
  timestamp?: string;
  version?: string;
  message?: {
    id?: string;
    role: string;
    content?: string | ContentBlock[];
    model?: string;
    usage?: ClaudeUsage;
  };
  /** 子代理链标记（native claude-code 行级字段；true=sidechain 内的行） */
  isSidechain?: boolean;
  subtype?: string;
  result?: string;
  cost_usd?: number;
  duration_ms?: number;
  // Proxy extension fields (claude-emitter writes on assistant lines). The
  // adapter reads only the standard-semantics subset (source/stopReason/
  // duration_ms); system/tools/ttftMs/dedup markers are pure extension data
  // consumed by the extension layer (proxy-classify / claude-jsonl-full-context
  // / wire-rounds route). Undefined for native claude-code lines.
  // `duration_ms` is a native claude field the adapter already reads
  // (→ interaction.latency); the emitter repurposes it to carry wire latency
  // so it flows through the standard pipeline.
  source?: string;
  system?: unknown;
  tools?: unknown;
  stopReason?: string;
  ttftMs?: number;
  deduped?: boolean;
  originalChars?: number;
  // Ctrl+X Ctrl+C 插队消息（≥2.1.3xx queue 机制）的 delivery 行：用户原文在
  // attachment.prompt（不在 message.content），rendered 是发给模型的
  // system-reminder 包装。其余 attachment 子类型仍是纯元数据
  attachment?: AttachmentLike;
  // x_lake 信封字段：读方一律经 shared/envelope readEnvelope 解析
  // 解析（键名与优先级单一真身），此处不再逐字段声明
}

export interface XLake {
  schema: string;
  version: number;
  data: {
    roundIndex?: number;
    protocol?: string;
    system?: unknown;
    tools?: unknown;
    requestParams?: { temperature?: number; maxTokens?: number; model?: string | null };
    latencyMs?: number;
    ttftMs?: number | null;
    stopReason?: string | null;
    status?: number;
    ccVersion?: string | null;
    kind?: string;
    dedup?: { originalChars: number; fingerprint: string };
    reasoningTokens?: number;
    toolCalls?: Array<{ toolUseId: string; state?: string; errorType?: string; errorMessage?: string; durationMs?: number; startedAt?: string; completedAt?: string }>;
    turnKind?: string;
    producer?: string;
    framework?: string;
    sid?: string;
    toolUseId?: string | null;
    name?: string | null;
    agentType?: string | null;
    subagentSessionId?: string;
    agentId?: string | null;
    /** claude 捕获关联扩展（cpx claude-linkage 契约）：逻辑成员身份 / 任务
     *  文本安全键 / 规范 id 语义声明。codex meta 不写这些字段。 */
    claudeAgentId?: string | null;
    task?: string | null;
    idSource?: string | null;
  };
}

// cc-wire-round（cpx 捕获）与 cc-db-turn（insight 导出）都声明
// latencyMs/stopReason 承载真实值 —— 等价于 legacy 的 *-proxy / insight-export 标记。
// version 门禁（spec §6）：只接受已知 schema + 已知 version；未知版本整块跳过
// （行本体照常按信封处理），防 v2 数据被旧读方按 v1 语义误读。首个 v2 落地
// 时在此注册表加版本分支即可。
const TURN_PAYLOAD_VERSIONS: Record<string, number[]> = {
  'cc-wire-round': [1],
  'cc-db-turn': [1],
};
export function isTurnPayload(xb: XLake | undefined): boolean {
  if (!xb) return false;
  const vs = TURN_PAYLOAD_VERSIONS[xb.schema];
  return !!vs && typeof xb.version === 'number' && vs.includes(xb.version);
}

// meta 声明式通道的 version 门禁（spec §6）：同款"已知 schema + 已知 version"判定，
// 未知版本 meta 整块跳过 → 落回顶层 legacy 字段。首个 v2 落地时在此注册表加版本。
const META_PAYLOAD_VERSIONS: Record<string, number[]> = {
  'cc-subagent-meta': [1],
  'cc-session-meta': [1],
};
export function isMetaPayload(xb: XLake | undefined, schema: string): boolean {
  if (!xb || xb.schema !== schema) return false;
  const vs = META_PAYLOAD_VERSIONS[schema];
  return !!vs && typeof xb.version === 'number' && vs.includes(xb.version);
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Record<string, unknown> | unknown[];
}

interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // cpx 捕获扩展（openai/responses 重组器归一写入；claude native wire 无此
  // 字段）。旧版 cpx 未把它写进 cc-wire-round 信封 → mergedReasoning 恒 0，
  // 读侧在此兜底恢复（真机实测 codex 捕获 197 reasoning → 落库 0）。
  reasoning_tokens?: number;
}

// user/assistant 内容的文本段抽取（块级剥除与全文拼接的共用原语）：
// 字符串内容即一段；块数组取 text 段 + thinking 伪段。join('\n') 即
// extractTextContent 的全文口径。
function extractTextParts(content: string | ContentBlock[] | undefined): string[] | null {
  if (!content) return null;
  if (typeof content === 'string') return [content];
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'thinking' && block.thinking) {
      parts.push(`<thinking>${block.thinking}</thinking>`);
    }
  }
  return parts.length > 0 ? parts : null;
}

function extractTextContent(content: string | ContentBlock[] | undefined): string | null {
  return extractTextParts(content)?.join('\n') ?? null;
}

// 字符串内容拆段（块数组的对偶——native claude 会话的 user 消息常用纯字符串
// 内容夹 reminder 段）：按 <system-reminder> 壳段切开，段间原文保留。剥除
// 谓词作用于每个壳段（整段恰为一个壳才可能命中），普通文本段永不命中。
function splitReminderSpans(text: string): string[] {
  const parts: string[] = [];
  const re = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(m[0]);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : [text];
}

// claude-code 系注入指纹（task-notification 解析 / ≥2.1 协议注入 / skill
// 注入谓词）已抽到 injections/claude-code.ts——框架自持，与 codex/
// opencode 家族分类器同层，由 injections/index.ts 按行级 source 分发。

// Remove <system-reminder>...</system-reminder> blocks from a user message,
// returning the real user prompt. Claude Code injects CLAUDE.md / gitStatus /
// currentDate / available-skills as these tags inside user messages — they're
// context, not real user input. Used for the session label / firstQuery
// extraction (the prompt preview should not be reminder noise).
// 预览口径（全部 reminder 视为噪声）；时间线口径的按指纹剥除见 readSession
// 的静态注入分支。实现在 shared/text-strip（与 data-service previewText 共用）。

function extractToolCalls(content: ContentBlock[]): ToolCallInfo[] | null {
  const toolUseBlocks = content.filter(b => b.type === 'tool_use');
  if (toolUseBlocks.length === 0) return null;

  const toolResultBlocks = content.filter(b => b.type === 'tool_result');
  const resultMap = new Map<string, string>();
  for (const r of toolResultBlocks) {
    if (r.tool_use_id && r.content) {
      resultMap.set(r.tool_use_id, normalizeToolResultPayload(r.content) ?? '');
    }
  }

  return toolUseBlocks.map(b => ({
    toolCallId: b.id ?? '',
    toolName: b.name ?? '',
    argsJson: b.input ? JSON.stringify(b.input) : null,
    resultJson: (() => { const v = resultMap.get(b.id ?? '') ?? null; return v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)); })(),
    state: 'completed',
  }));
}

function mapUsage(usage: ClaudeUsage | undefined, costUsd?: number): TokenUsage | null {
  if (!usage) return null;
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    total: input + (usage.output_tokens ?? 0) + cacheRead + cacheWrite,
    input,
    output: usage.output_tokens ?? 0,
    reasoning: 0,
    cacheRead,
    cacheWrite,
    cost: costUsd ?? 0,
    inputMessagesTokens: input + cacheRead + cacheWrite,
  };
}

/** OpenAI/Responses usage 的 input 含 cache read / write，output 含 reasoning；
 * cache write 是 input 中非 cached 部分的子集。这里拆成与其他 adapter
 * 一致的互不重叠桶，消费层可继续直接求和。 */
function normalizeOpenAICompatibleUsage(usage: TokenUsage): TokenUsage {
  const inputMessagesTokens = usage.inputMessagesTokens;
  const cacheRead = Math.min(usage.cacheRead, inputMessagesTokens);
  const cacheWrite = Math.min(usage.cacheWrite, inputMessagesTokens - cacheRead);
  const input = Math.max(0, inputMessagesTokens - cacheRead - cacheWrite);
  const reasoning = Math.min(usage.reasoning, usage.output);
  const output = Math.max(0, usage.output - reasoning);
  return {
    ...usage,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    inputMessagesTokens,
    total: inputMessagesTokens + output + reasoning,
  };
}

// 文件名 → 会话 id（SourceDescriptor.deriveSessionId 能力的命名层）：.jsonl.7z /
// .jsonl.gz（压缩态）与 .jsonl（明文）三形态取 stem；proxy 捕获文件的
// cpx- 前缀剥掉——目录扫描、单文件直导与服务端缺省推导必须落同一 taskId，
// 否则同一会话以 cpx-<sid>/<sid> 双身份重复入库
export function deriveSessionIdFromName(fileName: string): string {
  return fileName.replace(/\.jsonl(\.7z|\.gz)?$/, '').replace(/^cpx-/, '');
}

// 路径 → 会话 id（SourceDescriptor.deriveSessionId 能力）：deriveSessionId
// 契约收完整路径（DSH 的 id 取日志父目录名，只有 basename 推不出来），
// claude 规则只看文件名，先剥目录
export function deriveSessionIdFromPath(filePath: string): string {
  return deriveSessionIdFromName(path.basename(filePath));
}

// 内容级识别（SourceDescriptor.detectContent 能力）：首 N 条有效 JSON 行中
// 任一命中 claude wire 信封（type + message 对象）即认领——不要求首行命中
// （summary/result 等无 message 的元数据行可能在前）。三形态透明解压；
// 读不出/无有效行 → null（无法判定，解析层信任声明值）。
const DETECT_SCAN_LINES = 10;

export function detectContent(filePath: string): boolean | null {
  let buf: Buffer;
  try {
    buf = readCaptureHead(resolveCaptureForm(filePath));
  } catch {
    return null;
  }
  let valid = 0;
  let matched = false;
  let start = 0;
  const consider = (end: number): void => {
    const t = buf.toString('utf-8', start, end).trim();
    start = end + 1;
    if (!t || t.startsWith('//')) return;
    try {
      const obj = JSON.parse(t) as { type?: unknown; message?: unknown };
      valid += 1;
      if (typeof obj.type === 'string' && obj.message != null && typeof obj.message === 'object') matched = true;
    } catch {
      // 坏行/半写行（活文件尾行）跳过
    }
  };
  for (let i = 0; i < buf.length && !matched && valid < DETECT_SCAN_LINES; i++) {
    if (buf[i] === 0x0a) consider(i);
  }
  if (!matched && valid < DETECT_SCAN_LINES) consider(buf.length);
  if (matched) return true;
  return valid > 0 ? false : null;
}

// 捕获文件行流（7z at rest，docs 见 proxy/COMPRESSION-DESIGN.md）：
// .jsonl.7z / .jsonl.gz → 透明解压；.jsonl 直读；sourcePath 指向明文但盘上已
// 压缩（cpx 退出压缩后 sourcePath 未更新形态）或反之（resume scratch 态）时
// 双向互找。压缩是传输编码，行流内容与明文形态逐字节一致。
function resolveCaptureForm(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    if (filePath.endsWith('.jsonl')) {
      if (fs.existsSync(`${filePath}.7z`)) return `${filePath}.7z`;
      if (fs.existsSync(`${filePath}.gz`)) return `${filePath}.gz`;
    } else if (/\.jsonl\.(7z|gz)$/.test(filePath) && fs.existsSync(filePath.replace(/\.(7z|gz)$/, ''))) {
      return filePath.replace(/\.(7z|gz)$/, '');
    }
  }
  return filePath;
}

function readCaptureText(filePath: string): string {
  return readArchivedText(resolveCaptureForm(filePath));
}

// V8 单字符串上限（0x1FFFFFE8 ≈ 512MiB）：解压后整体 toString 必炸——
// 现场 631MB wire 捕获（3.5 天会话）导入即 RangeError，且旧实现的
// catch { return [] } 把崩溃吞成「空文件」→ 占位行假成功。现在 Buffer 上
// 按字节扫描 \n 逐行解码（0x0a 不出现在 UTF-8 多字节序列内，切片安全），
// 读/解压/单行超限错误一律上抛；仅单行 JSON 解析失败跳过（内容级容错）。
export function parseJsonlLines(filePath: string): ClaudeJsonlLine[] {
  const buf = readCaptureBuffer(resolveCaptureForm(filePath));
  const result: ClaudeJsonlLine[] = [];
  let start = 0;
  let lineNo = 0;
  const flush = (end: number): void => {
    if (end <= start) return;
    lineNo++;
    const t = buf.toString('utf-8', start, end).trim();
    if (t && !t.startsWith('//')) {
      try {
        result.push(JSON.parse(t) as ClaudeJsonlLine);
      } catch {
        skipLog.warn('skipping malformed JSON line', { filePath, line: lineNo });
      }
    }
    start = end + 1;
  };
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) flush(i);
  }
  flush(buf.length);
  return result;
}

/** 工具结果登记：内容 + 结果行时间戳（tool_result 完成时刻，工具真实时长的右边界） */
// wire 捕获的历史重放会逐请求重复携带同一 tool_result（真机实测：1007 个
// 唯一结果被 2310 条载体行携带，73% 重放 2–5 次）：首条载体行紧跟真实完成
// 时刻，后续重放晚数小时/数天。首现胜出——仅当首现缺有效时间戳时才允许
// 后续载体回填（时间戳缺失兜底，不引入 last-wins）。若允许覆盖，completedAt
// 会滑到最后一次重放的请求时刻（现场：42ms 的 Bash 被记成 50653.9s，连带
// nativeBoundary 的 toolEnd 推算与后续轮 latency 一并被撑爆）。
function collectAllToolResults(lines: ClaudeJsonlLine[]): Map<string, { content: string; tsMs: number | null }> {
  const resultMap = new Map<string, { content: string; tsMs: number | null }>();
  for (const line of lines) {
    if (line.type === 'user' && line.message?.content && Array.isArray(line.message.content)) {
      for (const block of line.message.content as ContentBlock[]) {
        if (block.type === 'tool_result' && block.tool_use_id && block.content) {
          const existing = resultMap.get(block.tool_use_id);
          if (existing != null && existing.tsMs != null) continue; // 首现胜出，重放不覆盖
          const ts = line.timestamp != null && isValidISO(line.timestamp)
            ? new Date(line.timestamp).getTime()
            : null;
          resultMap.set(block.tool_use_id, { content: normalizeToolResultPayload(block.content) ?? '', tsMs: ts });
        }
      }
    }
  }
  return resultMap;
}

function collectJsonlFiles(dirPath: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'subagents') continue;
        results.push(...collectJsonlFiles(full));
      } else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.gz') || entry.name.endsWith('.jsonl.7z')) {
        // rollout-*.jsonl / session.v4.jsonl 是 codex / dsh 源的文件名指纹
        // （registry sniff 序：前缀与固定名精确嗅探先于本兜底）——claude 扫描
        // 不得把它们当捕获件列进会话表，否则族扫描产出假条目、导入即失败
        if (isRolloutFileName(entry.name)) continue;
        if (isDshSessionLogName(entry.name)) continue;
        results.push(full);
      }
    }
  } catch {}
  return results;
}

export function listSessions(dirPath: string): SessionListItem[] {
  if (!dirPath || !fs.existsSync(dirPath)) return [];

  const stat = fs.statSync(dirPath);
  let files: string[];

  if (stat.isFile() && (dirPath.endsWith('.jsonl') || dirPath.endsWith('.jsonl.gz') || dirPath.endsWith('.jsonl.7z'))) {
    files = [dirPath];
  } else if (stat.isDirectory()) {
    files = collectJsonlFiles(dirPath);
  } else {
    return [];
  }

  const result: SessionListItem[] = [];
  for (const file of files) {
    const sessionId = deriveSessionIdFromPath(file);
    // 目录扫描会撞上外来/半写坏的捕获件：逐件降级跳过，不炸整个列表
    // （parseJsonlLines 已不吞读取错误，降级责任在消费点）
    let lines: ClaudeJsonlLine[];
    try {
      lines = parseJsonlLines(file);
    } catch (e) {
      skipLog.warn('skipping unreadable capture in listSessions', { file, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (lines.length === 0) continue;

    let firstQuery: string | null = null;
    let modelName: string | null = null;
    // 最频次模型——以 groupAssistantLines 组（= 导入后的 turn）为单位计数，
    // 与 computeSessionAggregates 同口径：原生会话一个 turn 有多条流式分段
    // 行（同 message.id 各带 model），行级计数会把多行 turn 加权放大；
    // 并列取先出现
    const modelCounts = new Map<string, number>();
    for (const g of groupAssistantLines(lines)) {
      const m = g.lines.find(l => l.message?.model)?.message?.model;
      if (m) modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1);
    }
    let createdAt: string;
    let endedAt: string | null = null;
    let totalTokens = 0;
    // 原生日志重放去重（见 replaySignature）：resume/compact 重写的历史副本不
    // 是新计费——签名已见的 assistant 行不重复累计，预览口径与导入后一致
    const seenUsageSigs = new Set<string>();

    try {
      createdAt = fs.statSync(file).mtime.toISOString();
    } catch {
      createdAt = new Date(0).toISOString();
    }

    for (const line of lines) {
      if (line.timestamp) {
        endedAt = line.timestamp;
      }
      if (line.type === 'user' && line.message) {
        const text = extractTextContent(line.message.content);
        if (text && !firstQuery) {
          const stripped = stripSystemReminders(text);
          if (stripped) firstQuery = truncateUtf16Safe(stripped, 200);
        }
      }
      if (line.type === 'assistant' && line.message?.usage) {
        const sig = replaySignature(line);
        const replayed = sig != null && seenUsageSigs.has(sig);
        if (sig != null) seenUsageSigs.add(sig);
        if (!replayed) {
          const u = line.message.usage;
          const xb = readEnvelope(line) as XLake | undefined;
          const openAICompatible = line.source === 'codex-proxy' || xb?.data?.protocol === 'responses';
          totalTokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
            + (openAICompatible ? 0 : (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
        }
      }
    }

    let modelMaxCount = 0;
    for (const [m, c] of modelCounts) {
      if (c > modelMaxCount) { modelMaxCount = c; modelName = m; }
    }

    result.push({
      id: sessionId,
      createdAt,
      endedAt,
      firstQuery,
      turnCount: lines.length,
      modelName,
      totalTokens,
    });
  }

  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// 三形态候选（.jsonl.7z > .jsonl.gz > .jsonl）+ 子目录递归（跳过 subagents/）。
// 原生会话对位发现（native-counterpart）与 readSession 共用同一查找
export function findSessionFile(dirPath: string, sessionId: string): string | null {
  // 三形态候选：.jsonl.7z（7z at rest）> .jsonl.gz（存量）> .jsonl（明文）
  for (const candidate of [`${sessionId}.jsonl.7z`, `${sessionId}.jsonl.gz`, `${sessionId}.jsonl`]) {
    const directPath = path.join(dirPath, candidate);
    if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) return directPath;
  }

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'subagents') {
        const found = findSessionFile(path.join(dirPath, entry.name), sessionId);
        if (found) return found;
      }
    }
  } catch {}

  return null;
}

// 发现产出的子代理引用：contract.SubagentRef（id = 规范连接键）+ claude
// meta 契约的 toolUseId 锚定键 + 关联别名（claudeAgentId/task，cpx 捕获
// 新契约；老捕获无这些字段全 null）。meta.json 由发现层单次读取
// （readSubagentMeta），打标/技能归因等下游不再各自开文件。
interface ClaudeSubagentRef extends SubagentRef {
  /** Task tool_use 锚定键（claude meta.json 契约，技能归因用） */
  toolUseId: string | null;
  /** x-claude-code-agent-id 头（claude 逻辑成员身份；关联别名，非规范 id） */
  claudeAgentId: string | null;
  /** 派发任务文本（cpx meta 契约；老捕获无 → 由 collectSubagentLinkageMaps 从捕获文件回读） */
  task: string | null;
}

// 子代理 meta.json 单读（双名信封优先，顶层旧字段 fallback；兼容压缩形态
// x.jsonl.7z/.gz → x.meta.json）。发现层是子代理 meta 的唯一读者。
function readSubagentMeta(filePath: string): {
  agentId: string | null;
  toolUseId: string | null;
  name: string | null;
  agentType: string | null;
  claudeAgentId: string | null;
  task: string | null;
  /** 规范 id 语义声明：'fileStem'（claude 捕获，文件名 id 恒为规范 id）|
   *  'agentId'（codex 捕获，文件名是占位）。legacy meta 无声明 → null。 */
  idSource: string | null;
} | null {
  try {
    const metaPath = metaPathOf(filePath);
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    const xb = readEnvelopeWithLegacy(meta) as XLake | undefined;
    const data = xb && isMetaPayload(xb, 'cc-subagent-meta') ? xb.data : null;
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
    return {
      agentId: str(data?.agentId ?? meta.agentId),
      toolUseId: str(data?.toolUseId ?? meta.toolUseId),
      name: str(data?.name ?? meta.name) ?? str(data?.agentType ?? meta.agentType) ?? str(meta.description),
      agentType: str(data?.agentType ?? meta.agentType),
      claudeAgentId: str(data?.claudeAgentId ?? meta.claudeAgentId),
      task: str(data?.task ?? meta.task),
      idSource: str(data?.idSource ?? meta.idSource),
    };
  } catch {
    return null;
  }
}

/** 捕获文件的伴随 meta 路径（x.jsonl / x.jsonl.7z / x.jsonl.gz → x.meta.json）。 */
function metaPathOf(filePath: string): string {
  return filePath.replace(/\.jsonl(\.7z|\.gz)?$/, '.meta.json');
}

/** 会话主文件的双形态解析：sourcePath 指向明文但盘上仅 .7z（或反之）时解析
 *  到盘上真实存在的那一份；三种形态都不存在 → null。 */
export function resolveCaptureFile(filePath: string): string | null {
  if (fs.existsSync(filePath)) return filePath;
  if (filePath.endsWith('.jsonl')) {
    if (fs.existsSync(`${filePath}.7z`)) return `${filePath}.7z`;
    if (fs.existsSync(`${filePath}.gz`)) return `${filePath}.gz`;
    return null;
  }
  if (/\.jsonl\.(7z|gz)$/.test(filePath)) {
    const plain = filePath.replace(/\.(7z|gz)$/, '');
    if (fs.existsSync(plain)) return plain;
  }
  return null;
}

export function listSubagentSessions(dirPath: string, sessionId: string): ClaudeSubagentRef[] {
  // dirPath can be a file (e.g., /path/to/session.jsonl) or a directory.
  // Subagents live at <parentDir>/sessionId/subagents/
  // proxy 捕获文件带 cpx- 文件名前缀（cpx-<sid>.jsonl），但其子代理目录用
  // 无前缀 sid（<sid>/subagents/）——导入 taskId 继承了文件名前缀时，剥掉
  // 前缀重试一次，否则 subagent 全部漏并（0 turns）。
  // 双形态解析后再 stat：sourcePath 指向明文但盘上仅 .gz（或反之）时
  // statSync ENOENT 抛出会把导入整链炸成 500
  const resolved = resolveCaptureFile(dirPath) ?? dirPath;
  const isFile = fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  const parentDir = isFile ? path.dirname(resolved) : resolved;
  let subagentsDir = path.join(parentDir, sessionId, 'subagents');
  if (!fs.existsSync(subagentsDir) && sessionId.startsWith('cpx-')) {
    subagentsDir = path.join(parentDir, sessionId.slice(4), 'subagents');
  }
  if (!fs.existsSync(subagentsDir)) {
    // taskId ≠ 文件名 stem 的导入（评审日志、改名导入）：捕获布局按 stem 命名
    // 子代理目录，回退按 stem 再找一次——否则子代理全部漏并（0 turns）。
    // stem/判断一律用 resolved（双形态解析后的真实路径）——stat 原始 dirPath 在
    // .jsonl-on-disk-as-.jsonl.gz 场景自己抛 ENOENT，把导入整链炸成 500
    const stem = path.basename(isFile ? resolved : parentDir).replace(/\.jsonl(\.7z|\.gz)?$/, '');
    if (stem && stem !== sessionId) {
      subagentsDir = path.join(parentDir, stem, 'subagents');
    }
  }
  if (!fs.existsSync(subagentsDir)) {
    // 会话目录布局（bundle 导出件 / lake 仓内 sessions/<sid>/<sid>.jsonl +
    // sessions/<sid>/subagents/）：subagents/ 与主 jsonl 同目录并列，stem 与
    // sessionId 相同（无 .native 装饰可借）——按同目录回退，否则 bundle 导入
    // 子代理全部漏并（0 turns）。
    const sibling = path.join(parentDir, 'subagents');
    if (fs.existsSync(sibling) && fs.statSync(sibling).isDirectory()) {
      subagentsDir = sibling;
    }
  }
  if (!fs.existsSync(subagentsDir) || !fs.statSync(subagentsDir).isDirectory()) return [];

  const results: ClaudeSubagentRef[] = [];
  try {
    const entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
    for (const entry of entries) {
      // .jsonl.7z/.jsonl.gz（压缩态）与 .jsonl（legacy 明文）三形态；filePath
      // 保持真实盘上路径（readCaptureText/parseJsonlLines 透明解压）
      const m = entry.name.match(/^(.+)\.jsonl(\.7z|\.gz)?$/);
      if (entry.isFile() && m) {
        const filePath = path.join(subagentsDir, entry.name);
        const meta = readSubagentMeta(filePath);
        // 规范 id 语义由 meta.idSource 声明（cpx 两框架显式落盘）：
        //   fileStem（claude 捕获）——文件名 id（sub-<md5(task)>）即规范 id，
        //     claudeAgentId 只是关联别名，绝不顶替（否则桥/泳道/Execution
        //     全线换键）；agentId（codex 捕获）——文件名是 spawn 输出到达前
        //     铸的占位，真身 id 在 meta，必须回填。legacy meta 无声明：沿旧
        //     口径 agentId 字段存在即 codex 回填语义（claude 老 meta 从不写
        //     agentId，行为不变）。
        const canonicalId = meta?.idSource === 'fileStem' ? m[1]
          : meta?.idSource === 'agentId' ? (meta.agentId ?? m[1])
          : (meta?.agentId ?? m[1]);
        results.push({
          id: canonicalId,
          filePath,
          name: meta?.name ?? null,
          type: meta?.agentType ?? null,
          toolUseId: meta?.toolUseId ?? null,
          claudeAgentId: meta?.claudeAgentId ?? null,
          task: meta?.task ?? null,
        });
      }
    }
  } catch {}

  return results;
}

// 子代理关联三映射（contract.collectSubagentLinkage 能力实现，data-service
// 单次调用穿线给 bridge-builder）。三条精确连接键独立成立、互不依赖：
//   toolUseId      —— meta 直锚（cpx/原生 harness 持有派发 id 时最硬）
//   claudeAgentId  —— claude 逻辑成员身份（cpx 新契约落盘；后台派发回执
//                     的 agentId 由此解析为规范子会话 id）
//   task           —— 派发 prompt ↔ 子文件首条用户任务（trim 归一）。meta
//                     没写 task（老版本捕获，孤儿现场 solo:8ae4a944）时回
//                     捕获文件回读——与 cpx 的 subagentTaskTextOf 语义手工
//                     对齐（首条非 reminder/stepped-away 文本块 trim）。
export function collectSubagentLinkageMaps(dirPath: string, sessionId: string): SubagentLinkageMaps {
  const toolUseIdToSessionId = new Map<string, string>();
  const claudeAgentIdToSessionId = new Map<string, string>();
  const taskToSessionId = new Map<string, string>();
  for (const sub of listSubagentSessions(dirPath, sessionId)) {
    if (sub.toolUseId) toolUseIdToSessionId.set(sub.toolUseId, sub.id);
    if (sub.claudeAgentId) claudeAgentIdToSessionId.set(sub.claudeAgentId, sub.id);
    const task = (sub.task ?? subagentTaskOfCapture(sub.filePath))?.trim();
    if (task && !taskToSessionId.has(task)) taskToSessionId.set(task, sub.id);
  }
  return { toolUseIdToSessionId, claudeAgentIdToSessionId, taskToSessionId };
}

// 子捕获文件的首条任务文本（cpx claude-linkage.taskOfSubagentFile 同语义：
// 首条 user 行的真实任务文本，system-reminder / stepped-away 块跳过）。
// 只对 meta 未带 task 的老捕获兜底——新捕获 meta.task 直取，不开文件。
function subagentTaskOfCapture(filePath: string): string | null {
  let task: string | null = null;
  try {
    for (const line of parseJsonlLines(filePath)) {
      if (task) break;
      if (line.type !== 'user' || !line.message) continue;
      task = subagentTaskTextOf(line.message.content);
    }
  } catch {
    return null;
  }
  return task;
}

// 首条用户消息里的任务文本提取（与 cpx claude-linkage.subagentTaskTextOf
// 手工对齐——两包不互相 import，双端语义同源）。
function subagentTaskTextOf(content: string | ContentBlock[] | undefined): string | null {
  if (typeof content === 'string') {
    // native claude 常用纯字符串内容夹 reminder 段（readSession 同款形态）：
    // 按壳段拆开逐段跳过，取首个非 reminder / 非 stepped-away 段——
    // 整串以 reminder 开头就判死会把段尾的真实任务文本一起丢掉。
    for (const span of splitReminderSpans(content)) {
      const t = span.trim();
      if (!t || t.startsWith('<system-reminder>') || t.startsWith('The user stepped away')) continue;
      return t;
    }
    return null;
  }
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (b.type !== 'text' || !b.text) continue;
    const t = b.text.trim();
    if (!t || t.startsWith('<system-reminder>') || t.startsWith('The user stepped away')) continue;
    return t;
  }
  return null;
}

// 子代理会话读取（SourceDescriptor.readSubagents 能力实现）：目录布局发现
// （<parentDir>/<sid>/subagents/）→ readSession → 打标（subagent_session_id/
// name/type）。data-service 的通用并入循环消费本产出，不再持有 claude 特有
// 逻辑。
export function readSubagentInteractions(dirPath: string, sessionId: string): RawInteraction[] {
  const subagentFiles = listSubagentSessions(dirPath, sessionId);
  const result: RawInteraction[] = [];
  for (const sub of subagentFiles) {
    const subInteractions = readSession(sub.filePath, sub.id);
    // 打标：sub.id 即规范连接键（codex-proxy 的 meta agentId / claude 的
    // 文件名 id），Bridge/Execution 锚定与 Turns 泳道 join 都用它
    for (const interaction of subInteractions) {
      interaction.subagent_session_id = sub.id;
      if (sub.name) interaction.subagent_name = sub.name;
      if (sub.type) interaction.subagent_type = sub.type;
    }
    result.push(...subInteractions);
  }
  return result;
}

// 会话原始文件集（SourceDescriptor.listSessionFiles 能力实现）：主文件双形态
// 解析 + 伴随 meta + listSubagentSessions 发现的子代理文件及其 meta。发现规则
// 与 readSubagents 同源（同一个 listSubagentSessions），文件保持盘上真实形态。
export function listSessionFiles(dirPath: string, sessionId: string): SessionFileRef[] | null {
  const main = resolveCaptureFile(dirPath);
  // dirPath 是 sessions 根目录（列表导入）时没有「这一个会话的主文件」可指
  if (!main || !fs.statSync(main).isFile()) return [];
  const refs: SessionFileRef[] = [{ role: 'main', filePath: main, relPath: path.basename(main) }];
  pushIfFile(refs, 'meta', metaPathOf(main), '');
  for (const sub of listSubagentSessions(dirPath, sessionId)) {
    refs.push({ role: 'subagent', filePath: sub.filePath, relPath: path.posix.join('subagents', path.basename(sub.filePath)) });
    pushIfFile(refs, 'subagent-meta', metaPathOf(sub.filePath), 'subagents');
  }
  return refs;
}

function pushIfFile(refs: SessionFileRef[], role: SessionFileRole, filePath: string, dir: string): void {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    refs.push({ role, filePath, relPath: path.posix.join(dir, path.basename(filePath)) });
  }
}

function isValidISO(timestamp: string): boolean {
  // 前缀正则快速短路 + 解析校验双保险：正则无尾部锚定，'2026-08-18T10:00:105Z'
  // （秒位三位）等「格式命中但 new Date() 解析为 NaN」的脏值会穿透；NaN 经下游
  // falsy 判定会被替换成 epoch 0（PR #112 review 实证），故解析失败一律判非法
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(timestamp)) return false;
  return Number.isFinite(new Date(timestamp).getTime());
}

function extractVersionFromLines(lines: ClaudeJsonlLine[]): string | null {
  for (const line of lines) {
    const xv = (readEnvelope(line) as XLake | undefined)?.data?.ccVersion;
    if (xv) return xv;
    if (line.version) return line.version;
  }
  return null;
}

export function extractVersion(filePath: string): string | null {
  const lines = parseJsonlLines(filePath);
  return extractVersionFromLines(lines);
}

export interface AssistantGroup {
  lines: ClaudeJsonlLine[];
  startLineIndex: number;
}

// Non-substantive line types that shouldn't break assistant grouping
// These are Claude Code metadata lines injected during streaming
const NON_BREAKING_TYPES = new Set([
  'ai-title', 'attachment', 'mode', 'permission-mode',
  'file-history-snapshot', 'last-prompt', 'system',
]);

// 插队消息（attachment/queued_command）升格判据：必须是人类输入——
// humanTurn 显式 false / origin.kind 非 human（hook/MCP/系统注入的队列
// delivery）不冒充用户轮（时间线归属、turn 计数、AI 分析输入都会被污染）。
// 导出给 auto-refresh 探针同口径判定（尾行插队消息 = 有输入待响应）
export interface AttachmentLike {
  type?: string;
  prompt?: string;
  humanTurn?: boolean;
  origin?: { kind?: string };
}
export function isQueuedUserAttachment(line: { type?: string; attachment?: AttachmentLike }): boolean {
  if (line.type !== 'attachment' || line.attachment?.type !== 'queued_command') return false;
  if (line.attachment.humanTurn === false) return false;
  const kind = line.attachment.origin?.kind;
  if (kind !== undefined && kind !== 'human') return false;
  return true;
}
function queuedUserPrompt(line: ClaudeJsonlLine): string | null {
  if (!isQueuedUserAttachment(line)) return null;
  const prompt = typeof line.attachment?.prompt === 'string' ? line.attachment.prompt.trim() : '';
  return prompt || null;
}

// 已知的「无交互产出」行类型（元数据/记账/wire 调试/语义已由他处消费）：
// 跳过属正常，info 级。user = 只含 tool_result 的载体行（内容并入前一条
// assistant 的 tool_calls）；assistant = 无 message 的客户端记账行。未知
// 类型跳过 = 上游格式演进的最早信号（2.1.3xx 的 queued_command 就是这么
// 溜进来的），warn 级——现场排查「丢了条消息」时日志里有线索可查。
// attachment 按子类型普查（queued_command 事故的复发形态正是「已知类型
// 携带新子类型」）：子类型目录来自真机 2.1.303 全量普查。
// 导出供 auto-refresh 探针派生镜像集（单源，消除双清单手工同步漂移）
export const KNOWN_SKIP_TYPES = new Set([
  ...NON_BREAKING_TYPES,
  'user', 'assistant',
  'queue-operation', 'atis-latch', 'progress', 'summary',
  'api-request', 'api-request-blob', 'api-request-shape',
]);
const KNOWN_ATTACHMENT_SUBTYPES = new Set([
  'queued_command', 'environment', 'model', 'agent_listing_delta', 'skill_listing',
  'total_tokens_reminder', 'session_context', 'date', 'remote_session_change',
  'prompt_snapshot', 'nested_memory',
]);
// 门控丢弃的 queued_command（humanTurn=false / origin 非 human / 空 prompt）
// 单独计键且不入白名单：真实用户插队被误标时必须 warn 可查，不能与普通
// 元数据跳过混在 info 里无声
const GATED_QUEUED_KEY = 'attachment/queued_command!gated';
// system 行（proxy/导出惯例的 system 轮载体）语义跳过子类型：wire 簿记与
// 重复注入——与 attachment/* 子类型同款的白名单机制，info 级不告警
const KNOWN_SYSTEM_SKIP_SUBTYPES = new Set(['total_tokens_reminder', 'duplicate']);
const SYSTEM_SKIP_TOKEN_BUDGET = 'system/total_tokens_reminder';
const SYSTEM_SKIP_DUPLICATE = 'system/duplicate';
// user 行语义跳过子类型：块级静态注入（契约原则 1 drop）与 wire 重放副件
// 去重——同白名单机制，info 级不告警
const KNOWN_USER_SKIP_SUBTYPES = new Set(['static-injection', 'replayed-injection']);
const USER_SKIP_STATIC_INJECTION = 'user/static-injection';
const USER_SKIP_REPLAYED_INJECTION = 'user/replayed-injection';
const isKnownSkipKey = (key: string): boolean => {
  if (KNOWN_SKIP_TYPES.has(key)) return true;
  if (key.startsWith('attachment/')) return KNOWN_ATTACHMENT_SUBTYPES.has(key.slice('attachment/'.length));
  if (key.startsWith('system/')) return KNOWN_SYSTEM_SKIP_SUBTYPES.has(key.slice('system/'.length));
  if (key.startsWith('user/')) return KNOWN_USER_SKIP_SUBTYPES.has(key.slice('user/'.length));
  return false;
};

const skipLog = createLogger('claude-jsonl');

/**
 * 原生日志重放签名：message.id + usage 快照。
 *
 * claude-code 的 session jsonl 是日志不是台账——resume/compact 后会 verbatim
 * 重写全历史（同 message.id 同 usage 的响应整行再写一遍，实测长会话 80% 行是重放副本）。
 * 每个重放副本都是同一计费响应的重复记录，不是新计费；签名（id+usage 逐字一致）= 重放判别。真新响应必有新 id 或新 usage 快照。
 */
function replaySignature(line: ClaudeJsonlLine): string | null {
  const id = line.message?.id;
  const usage = line.message?.usage;
  if (!id || !usage) return null;
  return `${id}\u0000${JSON.stringify(usage)}`;
}

export function groupAssistantLines(lines: ClaudeJsonlLine[]): AssistantGroup[] {
  const groups: AssistantGroup[] = [];
  let current: AssistantGroup | null = null;
  let currentMsgIds: Set<string> | null = null;
  let pendingToolResults: ClaudeJsonlLine[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'assistant' && line.message) {
      const msgId = line.message?.id;

      if (current && pendingToolResults && msgId && currentMsgIds?.has(msgId)) {
        // This assistant line shares the same message.id as the current group,
        // meaning the interleaved tool_result lines belong to the same API response.
        // Absorb them without breaking the group.
        pendingToolResults = null;
      } else if (pendingToolResults) {
        // The next assistant line has a different message.id (or no id),
        // so the pending tool_results are from a different turn. End the group.
        groups.push(current!);
        current = null;
        currentMsgIds = null;
        pendingToolResults = null;
      }

      if (!current) {
        current = { lines: [], startLineIndex: i };
        currentMsgIds = new Set();
      }
      current.lines.push(line);
      if (msgId && currentMsgIds) currentMsgIds.add(msgId);
    } else if (NON_BREAKING_TYPES.has(line.type)
      && !(line.type === 'system' && line.message?.content != null)
      && queuedUserPrompt(line) === null) {
      // Don't break the current assistant group for non-substantive lines.
      // EXCEPTION: a system line carrying message.content is substantive (our
      // proxy/export convention for system turns & injections) — it must break
      // the group, otherwise the next assistant (different response) merges
      // into this one and both the system turn and that assistant line are
      // silently dropped (lineToGroup's contiguous-index assumption breaks).
      // Native claude metadata system lines carry no message.content → unchanged.
      continue;
    } else if (
      current &&
      line.type === 'user' &&
      line.message?.content &&
      Array.isArray(line.message.content) &&
      extractTextContent(line.message.content) === null
    ) {
      // User line contains only tool_result blocks (no real text prompt).
      // Buffer it — we'll decide when we see the next assistant line:
      // if it shares the same message.id, these results are interleaved
      // within the same API response; otherwise they end the group.
      if (!pendingToolResults) pendingToolResults = [];
      pendingToolResults.push(line);
      continue;
    } else {
      if (current) {
        groups.push(current);
        current = null;
        currentMsgIds = null;
        pendingToolResults = null;
      }
    }
  }
  if (current) groups.push(current);
  return groups;
}

// Merge one assistant group (consecutive assistant lines sharing a response)
// into a single RawInteraction: joined text, tool_use→tool_calls with results
// attached (via allToolResults), merged usage (max raw input, final-line cache
// fields), model, timestamps and latency. Used by the native split path
// (readSession); proxy captures enter it as normalized native-shape lines.
// Returns null when the group carries neither text nor tool calls.
export function buildAssistantInteraction(
  group: AssistantGroup,
  allToolResults: Map<string, { content: string; tsMs: number | null }>,
  fileMtime: number,
  prevBoundaryMs: number | null = null,
): RawInteraction | null {
  const textParts: string[] = [];
  const allToolCalls: ToolCallInfo[] = [];
  let mergedUsage: TokenUsage | null = null;
  let mergedModel: string | null = null;
  let firstTimestamp: string | null = null;
  let firstTimeCreated: number | null = null;
  let lastTimeCreated: number | null = null;
  let mergedFinishReason: string | null = null;
  let explicitDurationMs: number | null = null;
  // proxy 行带 source:"-proxy"。proxy 单行 assistant 的 timeInfo.completed ==
  // created（都=completedAt）→ turn-split 会算 latency=completed-created=0，
  // 覆盖掉 interaction.latency（=duration_ms=wire latency）。proxy 且有显式
  // duration_ms 时把 completed 置 undefined，让 turn-split fallback 到
  // interaction.latency。native 行不受影响（native byte-identical）。
  let isProxy = false;
  let openAICompatibleUsage = false;

  // x_lake cc-db-turn 声明的 reasoning tokens（legacy 通道无此信息，
  // anthropic usage 也没有 reasoning 字段 —— opencode 来源经导出往返的恢复通道）
  let mergedReasoning = 0;

  // Find the line with the most complete usage (has cache fields = final line)
  // Also track the maximum raw input_tokens across all lines (thinking lines report
  // full cumulative input, while final lines report incremental input only)
  let finalUsageLine: ClaudeJsonlLine | null = null;
  let maxRawInputTokens = 0;

  for (let lineIdx = 0; lineIdx < group.lines.length; lineIdx++) {
    const al = group.lines[lineIdx];
    const alLineIndex = group.startLineIndex + lineIdx;
    const contentBlocks = Array.isArray(al.message?.content)
      ? al.message.content as ContentBlock[]
      : [];
    const text = extractTextContent(al.message?.content);
    if (text) textParts.push(text);

    // 声明式信封通道（本行一次读）：cc-db-turn（insight 导出）的 toolCalls
    // 声明携带 per-tool 真实时长——标准管线通道是 ToolCallInfo.startedAt/
    // completedAt（与 opencode part 表同源），声明优先于行级时间戳推导。
    // 导出件工具结果载体行与发起行同戳，时间戳推导恒为 0 —— 不读声明的
    // 导入路径（直接文件导入 / refresh 增量刷新）会把真实工具时长打回 0。
    const xbRaw = readEnvelope(al) as XLake | undefined;
    const xbTurn = isTurnPayload(xbRaw) ? xbRaw!.data : null;
    if (al.source === 'codex-proxy' || xbTurn?.protocol === 'responses') {
      openAICompatibleUsage = true;
    }
    const declaredToolCalls = Array.isArray(xbTurn?.toolCalls)
      ? new Map(xbTurn!.toolCalls!.map(d => [d.toolUseId, d]))
      : null;

    const realTimestamp = al.timestamp || null;
    // 非法时间戳与缺失同路兜底（fileMtime 估计）：回退 epoch 0 会把 turn 时间打成
    // 1970，经 subagentTiming 的 min 聚合放大成毫秒级伪时延（CI 实证 1.78e12 溢出 Int 列）
    const tsValid = realTimestamp != null && isValidISO(realTimestamp);
    const timeCreated = tsValid ? new Date(realTimestamp).getTime() : fileMtime + alLineIndex * 1000;
    const timestamp = tsValid ? realTimestamp : new Date(timeCreated).toISOString();

    const toolCalls = extractToolCalls(contentBlocks);
    if (toolCalls) {
      for (const tc of toolCalls) {
        // 默认：startedAt=tool_use 所在行时刻（发起），completedAt=tool_result
        // 行时刻（完成）——工具真实时长的左右边界；结果行缺失/无时间戳 → null
        //（消费方降级）。声明（cc-db-turn toolCalls）优先：startedAt/completedAt
        // 显式值直接采信；无 completedAt 但有 durationMs 时 completed =
        // startedAt + durationMs（导出端双字段对称缺失时兜底）
        const entry = allToolResults.get(tc.toolCallId);
        const v = entry?.content ?? tc.resultJson ?? null;
        const dec = declaredToolCalls?.get(tc.toolCallId);
        let startedAt = timeCreated;
        let completedAt = entry?.tsMs ?? null;
        if (dec) {
          const decStart = typeof dec.startedAt === 'string' && isValidISO(dec.startedAt)
            ? Date.parse(dec.startedAt) : null;
          if (decStart != null) startedAt = decStart;
          const decEnd = typeof dec.completedAt === 'string' && isValidISO(dec.completedAt)
            ? Date.parse(dec.completedAt) : null;
          if (decEnd != null) completedAt = decEnd;
          else if (typeof dec.durationMs === 'number' && dec.durationMs > 0) {
            completedAt = startedAt + dec.durationMs;
          }
        }
        allToolCalls.push({
          ...tc,
          resultJson: v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)),
          // 声明信封的错误语义透传（导出件往返保真）：cc-db-turn toolCalls
          // 声明携带洞见侧已解析的 state/errorType/errorMessage，此前被丢弃
          // 只取时间戳——codex 会话重导入会把 exec_failed/sandbox_rejected
          // 降解回 unknown。声明优先（与时间戳同原则），缺失时保持原生提取
          // 的 state、语义交由核心管线兜底分类。
          state: typeof dec?.state === 'string' && dec.state !== '' ? dec.state : tc.state,
          errorType: dec?.errorType ?? null,
          errorMessage: dec?.errorMessage ?? null,
          startedAt,
          completedAt,
        });
      }
    }

    const usage = al.message?.usage;
    if (usage) {
      // Track the maximum raw input_tokens (thinking lines report full cumulative)
      if ((usage.input_tokens ?? 0) > maxRawInputTokens) {
        maxRawInputTokens = usage.input_tokens ?? 0;
      }
      // The final line of a streaming response includes cache_read/cache_write fields
      // and has actual output_tokens; earlier lines report cumulative input only
      if (usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null || (usage.output_tokens > 0 && usage.input_tokens < (finalUsageLine?.message?.usage?.input_tokens ?? Infinity))) {
        finalUsageLine = al;
      }
    }

    if (firstTimeCreated == null || timeCreated < firstTimeCreated) {
      firstTimeCreated = timeCreated;
      firstTimestamp = timestamp;
    }
    if (lastTimeCreated == null || timeCreated > lastTimeCreated) {
      lastTimeCreated = timeCreated;
    }

    if (!mergedModel && al.message?.model) mergedModel = al.message.model;
    if (al.subtype) mergedFinishReason = al.subtype;
    // proxy 扩展字段：emitter 把 wire stop_reason 写进 stopReason（subtype 是
    // native 字段，语义不同）。adapter 读它进 interaction.finish_reason →
    // turn-split 写 Turn.finishReason，走标准管线进 DB（非扩展层覆盖）。
    if (al.stopReason) mergedFinishReason = al.stopReason;
    if (al.duration_ms != null) explicitDurationMs = al.duration_ms;
    // 生成文件标记：cpx 捕获（*-proxy）与 lake DB 导出（insight-export）。
    // 两者都声明 duration_ms 承载真实 latency（completed 置 undefined 让
    // turn-split fallback 到 interaction.latency）；仅 *-proxy 计入
    // Session.version（proxySourceOf 只认 -proxy 后缀，导出件不误标代理徽标）。
    if (!isProxy && typeof al.source === 'string'
      && (al.source.endsWith('-proxy') || al.source === 'insight-export')) isProxy = true;
    // 声明式信封通道（优先，行级已在循环头读过）：同一信息的权威源 +
    // legacy 没有的 reasoningTokens
    if (xbTurn) {
      isProxy = true;
      if (xbTurn.stopReason != null) mergedFinishReason = xbTurn.stopReason;
      if (xbTurn.latencyMs != null) explicitDurationMs = xbTurn.latencyMs;
      if (xbTurn.reasoningTokens != null) mergedReasoning = xbTurn.reasoningTokens;
    }
  }

  // Build merged usage: use final line's cache data, but for total input use the
  // maximum raw input_tokens across all lines (thinking lines report full cumulative
  // input while final lines report incremental only)
  if (finalUsageLine?.message?.usage) {
    const fu = finalUsageLine.message.usage;
    const incrementalInput = fu.input_tokens ?? 0;
    const cacheRead = fu.cache_read_input_tokens ?? 0;
    const cacheWrite = fu.cache_creation_input_tokens ?? 0;
    // OpenAI/Responses 的 input_tokens 已含缓存；Anthropic 则分列，不能统一相加。
    const inputMessagesTokens = openAICompatibleUsage
      ? Math.max(maxRawInputTokens, incrementalInput)
      : Math.max(maxRawInputTokens, incrementalInput + cacheRead + cacheWrite);
    // usage 块 reasoning 兜底：信封（cc-wire-round.reasoningTokens，权威）缺
    // 席时读 cpx 写入 usage 块的 reasoning_tokens——覆盖旧版捕获件
    const reasoningTokens = mergedReasoning > 0 ? mergedReasoning : (fu.reasoning_tokens ?? 0);
    mergedUsage = {
      total: inputMessagesTokens + (fu.output_tokens ?? 0),
      input: incrementalInput,
      output: fu.output_tokens ?? 0,
      reasoning: reasoningTokens,
      cacheRead,
      cacheWrite,
      cost: 0,
      inputMessagesTokens,
    };
  } else if (group.lines[0]?.message?.usage) {
    // No final line with cache fields — use first line's cumulative input
    const u0 = group.lines[0].message.usage;
    const reasoningTokens0 = mergedReasoning > 0 ? mergedReasoning : (u0.reasoning_tokens ?? 0);
    mergedUsage = {
      total: (u0.input_tokens ?? 0) + (u0.output_tokens ?? 0),
      input: u0.input_tokens ?? 0,
      output: u0.output_tokens ?? 0,
      reasoning: reasoningTokens0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      inputMessagesTokens: u0.input_tokens ?? 0,
    };
  }

  if (mergedUsage && openAICompatibleUsage) {
    mergedUsage = normalizeOpenAICompatibleUsage(mergedUsage);
  }

  const mergedContent = textParts.length > 0 ? textParts.join('\n') : null;
  const mergedToolCalls = allToolCalls.length > 0 ? allToolCalls : null;

  // B 形技能加载检测（Read 读 / shell 读类命令 cat SKILL.md）在 turn-split
  // 单点进行——adapter 不再合成 skill/<name> 调用（历史缺陷：假工具行混进
  // 工具统计、resultJson 恒空断原文恢复链）

  // Skip if no content and no tool calls——但携带 usage/finishReason 的空组保留：
  // 现场回归（vbYQjB #1975 后）：subagent 最后一轮 stopReason=length、content=[]、
  // 32000t output——整组丢弃会把截断事实连同 usage 一起从 insight 消失，时间线
  // 上一轮 read 后"突然结束"、token 统计少算。空 turn 落库（content null），
  // 显示层按 finishReason=length 给出截断解释；真正的空行仍丢
  if (!mergedContent && !mergedToolCalls) {
    const carriesSignal = mergedFinishReason != null
      || (mergedUsage != null && ((mergedUsage.output ?? 0) > 0 || (mergedUsage.input ?? 0) > 0));
    if (!carriesSignal) return null;
  }

  // 单行 native assistant 的跨度是 0——填 0 会短路掉下面的 gap 回填（latency==null
  // 才触发），completed 就永远等于 created（工具区间塌成零长）。跨度为 0 时给 null，
  // 让回填用"到下一轮的间隔"补（下一轮=tool_result 到达时间，正是工具执行区间）。
  const span = lastTimeCreated && firstTimeCreated && lastTimeCreated > firstTimeCreated
    ? lastTimeCreated - firstTimeCreated
    : null;
  // native/无显式 duration：请求时长按上一边界（上一轮末行或其工具结果完成
  // 时刻）到本组末行推导——行跨度只覆盖首行落盘之后的生成尾段，短回复把 tps
  // 虚高数倍（实测 966tok/0.96s→1012tps，边界推导 25.4s→38tps）。有显式
  // duration_ms 的 proxy 行为不变。timeInfo 保持行时间语义（时间线/活跃时长
  // 不受影响），边界时长经 latency 通道传递（turn-split 显式 latency 优先）。
  const explicit = explicitDurationMs != null;
  const endMs = lastTimeCreated ?? null;
  const boundaryLatency = (!explicit && prevBoundaryMs != null && endMs != null && endMs > prevBoundaryMs)
    ? endMs - prevBoundaryMs
    : null;
  const latency = explicitDurationMs ?? boundaryLatency ?? span;

  return {
    role: 'assistant',
    content: mergedContent,
    timestamp: firstTimestamp ?? new Date(fileMtime).toISOString(),
    timeInfo: {
      created: firstTimeCreated ?? fileMtime,
      completed: (isProxy && explicitDurationMs != null) ? undefined : (endMs ?? undefined),
    },
    agent: null,
    subagent_name: null,
    subagent_session_id: null,
    subagent_type: null,
    tool_calls: mergedToolCalls,
    usage: mergedUsage,
    model: mergedModel,
    modelID: null,
    providerID: null,
    latency,
    finish_reason: mergedFinishReason,
  };
}

export function readSession(filePath: string, sessionId: string): RawInteraction[] {
  if (!filePath) return [];
  // 双形态解析前置（readCaptureText 同款）：sourcePath 指向明文但盘上已
  // 压缩（或反之）不能在此被 existsSync 守卫拦截
  let resolvedInput = filePath;
  if (!fs.existsSync(resolvedInput)) {
    if (filePath.endsWith('.jsonl')) {
      if (fs.existsSync(`${filePath}.7z`)) resolvedInput = `${filePath}.7z`;
      else if (fs.existsSync(`${filePath}.gz`)) resolvedInput = `${filePath}.gz`;
      else return [];
    } else if (/\.jsonl\.(7z|gz)$/.test(filePath) && fs.existsSync(filePath.replace(/\.(7z|gz)$/, ''))) {
      resolvedInput = filePath.replace(/\.(7z|gz)$/, '');
    } else {
      return [];
    }
  }

  const stat = fs.statSync(resolvedInput);

  let resolvedFilePath: string;
  if (stat.isFile()) {
    resolvedFilePath = resolvedInput;
  } else if (stat.isDirectory()) {
    const found = findSessionFile(resolvedInput, sessionId);
    if (!found) return [];
    resolvedFilePath = found;
  } else {
    return [];
  }

  const lines = parseJsonlLines(resolvedFilePath);
  if (lines.length === 0) return [];

  const allToolResults = collectAllToolResults(lines);
  const fileMtime = fs.statSync(resolvedFilePath).mtime.getTime();

  const result: RawInteraction[] = [];

  // Phase 1: process non-assistant lines and group assistant lines
  const assistantGroups = groupAssistantLines(lines);

  // Build a map of line → assistant group for interleaving. 按对象身份而非
  // startLineIndex+j 下标映射：吸收进分组的 tool_result-only user 行占据
  // 中间下标，连续下标假设会把真实 assistant 行挤出映射（内容已在组内合并
  // 不丢，但会掉进下方 else 分支被误计为跳过行——计数失真误导排查）
  const lineToGroup = new Map<ClaudeJsonlLine, AssistantGroup>();
  for (const g of assistantGroups) {
    for (const ln of g.lines) {
      lineToGroup.set(ln, g);
    }
  }

  // Track which groups we've already emitted
  const emittedGroups = new Set<AssistantGroup>();

  // native 请求边界：上一轮末行与其工具结果完成时刻的较大者（用户输入重置）。
  // 供下一 assistant 组把请求起点回撤到边界——latency 覆盖排队+prefill+生成
  // 全程（TPS/TPOT 物理合理），工具时间天然在界外。子代理文件是独立调用，
  // 边界天然按会话隔离。
  let nativeBoundary: number | null = null;

  // 跳过行计数（按 type）：未知类型 warn（上游格式演进信号），已知元数据 info
  const skippedTypes = new Map<string, number>();
  const noteSkip = (t: string) => { skippedTypes.set(t, (skippedTypes.get(t) ?? 0) + 1); };
  // system 行已见内容（wire 重复注入去重）：system 组件无 message.id，捕获
  // 侧逐请求原样落盘——同内容首现保留，重复跳过（见 system 分支注释）
  const seenSystemTexts = new Set<string>();
  // 注入行已见原文（wire 重放副件去重）：注入行 byte-identical 重现 = 捕获侧
  // 进程重启的 multiset 失守产物（真事件通知各轮内容必变——tokens/结果文本
  // 递进，不可能逐字节相同），首现保留。真实人类输入不在此去重：人类重复
  // 输入是真实事件，契约「真实人类输入保持 user」。
  const seenInjectionLines = new Set<string>();
  // 重放签章已见集 + 重放组计数（见 replaySignature——resume/compact 历史重写去重）
  const seenReplaySigs = new Set<string>();
  let replaySkippedGroups = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // If this line belongs to an assistant group, emit the whole group once
    const group = lineToGroup.get(line);
    if (group) {
      if (emittedGroups.has(group)) continue; // already emitted
      emittedGroups.add(group);

      // 原生日志重放去重（见 replaySignature）：组内全部 assistant 行的
      // (message.id, usage) 签名都已在更早组出现过 = resume/compact 的
      // verbatim 历史重放副本，整组跳过——不产生幻影轮次、不重计 token
      // （真新响应必有新 id 或新 usage 快照；分裂续段签名不全见过 →
      // 照常入册，不丢内容）。proxy wire 每响应只记一行，签名唯一 → 零影响。
      const groupSigs = group.lines.map(replaySignature);
      if (groupSigs.length > 0 && groupSigs.every(s => s != null && seenReplaySigs.has(s))) {
        replaySkippedGroups++;
        continue;
      }
      for (const s of groupSigs) if (s != null) seenReplaySigs.add(s);

      const merged = buildAssistantInteraction(group, allToolResults, fileMtime, nativeBoundary);
      if (merged) {
        // 每组结束推进边界（组末行与其工具结果完成时刻取大者）。子代理文件是
        // 独立的 readSession 调用（各自边界隔离），isSidechain 打标在读取后的
        // 标注 pass——此处无需也不可按 sidechain 跳过：跳过会让边界冻结在早期
        // user 行，子代理后续各组 end−冻结边界 单调累加（实测 turn372-430）。
        const toolEnd = merged.tool_calls?.reduce((m, tc) => Math.max(m, tc.completedAt ?? 0), 0) ?? 0;
        const nb = Math.max(merged.timeInfo?.completed ?? 0, toolEnd);
        if (nb > 0) nativeBoundary = nb;
        result.push(merged);
      }
      continue;
    }

    // Non-assistant lines
    const realTimestamp = line.timestamp || null;
    // 同上：非法时间戳走 fileMtime 兜底，不再产出 epoch 0 / NaN
    const tsValid = realTimestamp != null && isValidISO(realTimestamp);
    const timeCreated = tsValid ? new Date(realTimestamp).getTime() : fileMtime + i * 1000;
    const timestamp = tsValid ? realTimestamp : new Date(timeCreated).toISOString();
    const timeCompleted = line.duration_ms && timeCreated ? timeCreated + line.duration_ms : undefined;

    if (line.type === 'user' && line.message) {
      const raw = extractTextContent(line.message.content);
      // Skip user messages that only contain tool_result (no real text prompt)
      if (!raw) { noteSkip(line.type); continue; }

      // 框架注入分类（contract 原则 1：指纹规则框架自持）：native 会话与
      // insight-export 走 claude-code 指纹（task-notification / ≥2.1 协议
      // 注入 / skill 注入），异框架 proxy 捕获按行级 source 标记分发到原
      // 框架分类器（injections/index.ts）——本适配器是 claude 布局的通用
      // 格式入口，不内联异框架指纹。静态注入 drop 不进时间线（wire 原文
      // 永远在捕获文件，wire-rounds 可查），事件注入重分类 system + 可读
      // 摘要（skill 注入 verbatim，skill-merge 后处理折进前一个 Skill
      // tool_call）。
      const injection = classifyUserInjection(line.source, raw, { isFirstTurn: result.length === 0 });
      if (injection) {
        if (injection.action === 'drop') { noteSkip(line.type); continue; }
        if (seenInjectionLines.has(raw)) { noteSkip(USER_SKIP_REPLAYED_INJECTION); continue; }
        seenInjectionLines.add(raw);
        result.push({
          role: 'system',
          content: injection.content ?? raw,
          timestamp,
          timeInfo: { created: timeCreated },
          agent: null, subagent_name: null, subagent_session_id: null, subagent_type: null,
          tool_calls: null, usage: null, model: null, modelID: null, providerID: null,
          latency: null, finish_reason: null,
        });
        continue;
      }

      // 块级静态注入剥除（契约原则 1「静态注入丢弃不进时间线」的块级实现）：
      // claude-code 给每个代理进程启动时注入的上下文块（CLAUDE.md 回显 /
      // gitStatus 快照 / 署名规则 / 日历）与真实提示同属一条 wire 消息——
      // 按块级指纹剥除，真实提示保留；剥后无实质文本的纯注入消息整条 drop。
      // 指纹经 injections/ 按行级 source 分发（框架自持），未知 reminder 块
      // 保留可见（前向兼容）；native 与 proxy 同口径（框架语义，非 proxy
      // 特有）。wire 原文不动——wire-rounds / full-context 直读捕获文件。
      // 历史决策注：此前这里「原样保留全文 + 渲染层拆分」，实测每个会话
      // （主 + 全部子代理）首条 user 轮都背着一坨静态块、时间线裸奔 XML
      // 噪声——契约本就要求 drop，此为实现到位。
      let content = raw;
      const isStaticBlock = staticInjectionBlockPredicateFor(line.source);
      if (isStaticBlock) {
        // 形态拆段：字符串按 reminder 壳段拆（join('') 还原），块数组按
        // text/thinking 段拆（join('\n')，extractTextContent 口径）
        const isString = typeof line.message.content === 'string';
        const parts = isString
          ? splitReminderSpans(line.message.content as string)
          : (extractTextParts(line.message.content) ?? []);
        const kept = parts.filter(p => !isStaticBlock(p));
        if (kept.length < parts.length) {
          const joined = kept.join(isString ? '' : '\n').trim();
          if (!joined) { noteSkip(USER_SKIP_STATIC_INJECTION); continue; }
          content = joined;
        }
      }
      if (content) {
        // 用户输入是新的请求边界（下一 assistant 请求始于用户消息之后）
        nativeBoundary = timeCreated;
        result.push({
          role: 'user',
          content,
          timestamp,
          timeInfo: { created: timeCreated },
          agent: null,
          subagent_name: null,
          subagent_session_id: null,
          subagent_type: null,
          tool_calls: null,
          usage: null,
          model: null,
          modelID: null,
          providerID: null,
          latency: null,
          finish_reason: null,
        });
      }
    } else if (line.type === 'attachment') {
      // Ctrl+X Ctrl+C 插队消息：delivery 落盘为 attachment/queued_command，
      // 用户原文在 attachment.prompt、renderedRole=system 只是发给模型的包
      // 装——升格为 user interaction，时间线上作为独立用户轮可见（排在断开
      // 的两个 assistant 分组之间，与其真实发生时刻一致）
      const prompt = queuedUserPrompt(line);
      if (prompt) {
        nativeBoundary = timeCreated;
        result.push({
          role: 'user',
          content: prompt,
          timestamp,
          timeInfo: { created: timeCreated },
          agent: null, subagent_name: null, subagent_session_id: null, subagent_type: null,
          tool_calls: null, usage: null, model: null, modelID: null, providerID: null,
          latency: null, finish_reason: null,
        });
      } else {
        noteSkip(line.attachment?.type === 'queued_command'
          ? GATED_QUEUED_KEY
          : `attachment/${line.attachment?.type ?? 'none'}`);
      }
    } else if (line.type === 'system' && line.message) {
      // Proxy (cannbot-proxy) relays request messages with role:"system"
      // verbatim — e.g. the "Available agent types" registry claude-code
      // injects into the messages array. The model READS these, so emit a
      // system turn (visible in LLM Input, persisted in DB). Native
      // claude-code type:"system" lines (client-side status/hook events:
      // top-level `content` string, no `message`) are NOT model input and
      // stay skipped.
      //
      // Wire repetition semantics: the system array carries no message.id,
      // so the capture side cannot dedup it per request the way the messages
      // history is deduped — every request re-records its system components:
      // the token-budget countdown (bookkeeping that rides three carrier
      // shapes: pure string, single block, or a trailing line appended to the
      // static prompt string — strip it; a component that becomes empty is
      // pure bookkeeping, skip it) and static injections (identical text per
      // request after stripping — keep the FIRST occurrence, drop the
      // repeats; the materialized turn carries the stripped text). The
      // conversation timeline converges to "each injection once, at its
      // first appearance". Wire fidelity is unaffected: wire-rounds /
      // skills full-set / full context all read the raw capture, never the
      // Turn table.
      const raw = extractTextContent(line.message.content);
      if (!raw) { noteSkip(line.type); continue; }
      const content = stripTokenBudgetReminders(raw);
      if (!content) { noteSkip(SYSTEM_SKIP_TOKEN_BUDGET); continue; }
      if (seenSystemTexts.has(content)) { noteSkip(SYSTEM_SKIP_DUPLICATE); continue; }
      seenSystemTexts.add(content);
      result.push({
        role: 'system',
        content,
        timestamp,
        timeInfo: { created: timeCreated },
        agent: null, subagent_name: null, subagent_session_id: null, subagent_type: null,
        tool_calls: null, usage: null, model: null, modelID: null, providerID: null,
        latency: null, finish_reason: null,
      });
    } else if (line.type === 'result') {
      const resultUsage = line.cost_usd != null
        ? { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: line.cost_usd, inputMessagesTokens: 0 }
        : null;
      result.push({
        role: 'result',
        content: line.result ?? null,
        timestamp,
        timeInfo: { created: timeCreated },
        agent: null,
        subagent_name: null,
        subagent_session_id: null,
        subagent_type: null,
        tool_calls: null,
        usage: resultUsage,
        model: null,
        modelID: null,
        providerID: null,
        latency: line.duration_ms ?? null,
        finish_reason: line.subtype ?? null,
      });
    } else {
      // 未知类型：不产出交互直接掉出 if 链——计数，日志层分级告警
      noteSkip(line.type);
    }
  }

  if (replaySkippedGroups > 0) {
    skipLog.info('原生日志重放组已去重（resume/compact verbatim 历史重写，非新计费响应）', { sessionId, replaySkippedGroups });
  }

  if (skippedTypes.size > 0) {
    const dist: Record<string, number> = Object.fromEntries([...skippedTypes.entries()].sort((a, b) => b[1] - a[1]));
    const unknown = Object.keys(dist).filter(t => !isKnownSkipKey(t));
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    if (unknown.length > 0) {
      skipLog.warn('跳过行含未知类型（疑似上游格式演进，检查是否丢语义）', { sessionId, total, unknown: unknown.join(','), dist: JSON.stringify(dist) });
    } else {
      skipLog.info('跳过行均为已知元数据类型', { sessionId, total, dist: JSON.stringify(dist) });
    }
  }

  // Post-process: merge skill injection system turns into preceding assistant's tool_call result
  // Claude Code emits skill content as a separate user/system line, but it's really the
  // tool_result of the Skill tool_call in the preceding assistant turn.
  for (let i = result.length - 1; i >= 0; i--) {
    const r = result[i];
    if (r.role !== 'system') continue;
    const content = r.content ?? '';
    if (!isSkillInjectionText(content)) continue;

    // Find the preceding assistant turn
    const prev = i > 0 ? result[i - 1] : null;
    if (prev?.role === 'assistant' && prev.tool_calls) {
      // Find a Skill tool_call whose resultJson is short/incomplete
      const skillTc = prev.tool_calls.find(tc =>
        tc.toolName.toLowerCase() === 'skill' &&
        tc.resultJson != null &&
        tc.resultJson.length < content.length
      );
      if (skillTc) {
        skillTc.resultJson = content;
        // Only remove if successfully merged into tool_call
        result.splice(i, 1);
      }
    }
    // If not merged into a Skill tool_call, keep the system turn
    // — it will be handled by the consecutive-merge step below
  }

  // Post-process: merge consecutive skill-injection system turns into one
  // When multiple skills are loaded at once, Claude Code emits separate lines for each.
  // These appear between a user prompt and the assistant response as separate system turns.
  // Merge them into a single consolidated system turn.
  for (let i = result.length - 1; i >= 0; i--) {
    const r = result[i];
    if (!r || r.role !== 'system') continue;
    const content = r.content ?? '';
    if (!isSkillInjectionText(content)) continue;

    // Look backward for consecutive system/skill-injection turns to merge
    const mergeGroup: number[] = [i];
    let j = i - 1;
    while (j >= 0 && result[j]?.role === 'system') {
      const prevContent = result[j].content ?? '';
      const prevIsSkill = prevContent.includes('Base directory for this skill') ||
        prevContent.includes('<skill-format>') ||
        prevContent.startsWith('Launching skill:') ||
        prevContent.startsWith('Launching skill ');
      if (prevIsSkill) {
        mergeGroup.push(j);
        j--;
      } else {
        break;
      }
    }

    if (mergeGroup.length > 1) {
      // Merge: combine all content, keep earliest timestamp
      const allContent = mergeGroup
        .sort((a, b) => a - b)
        .map(idx => result[idx].content ?? '')
        .join('\n\n---\n\n');
      const earliestIdx = Math.min(...mergeGroup);
      const earliest = result[earliestIdx];

      // Update the earliest turn with merged content
      earliest.content = allContent;

      // Remove the rest (in reverse order to preserve indices)
      for (const idx of mergeGroup.sort((a, b) => b - a)) {
        if (idx !== earliestIdx) {
          result.splice(idx, 1);
        }
      }
      // Splicing shrank the array; clamp i to the merged turn so the for-loop's
      // i-- lands on the element just before the group. Without this, i keeps its
      // pre-splice value, goes out of range, and result[i] is undefined (crash).
      i = earliestIdx;
    }
  }

  // Post-process: infer latency from timestamp gaps and estimate cost
  for (let i = 0; i < result.length; i++) {
    const r = result[i];
    // Infer latency: use gap between this turn and the next
    if (r.latency == null && r.timeInfo?.created) {
      const nextTs = result[i + 1]?.timeInfo?.created ?? null;
      if (nextTs && nextTs > r.timeInfo.created) {
        r.latency = nextTs - r.timeInfo.created;
        r.timeInfo.completed = nextTs;
      }
    }
    // Estimate cost if not provided (Claude pricing approximation)
    if (r.usage && r.usage.cost === 0) {
      const model = r.model ?? '';
      const isOpus = model.includes('opus') || model.includes('4.8');
      const isSonnet = model.includes('sonnet') || model.includes('4.6');
      const isHaiku = model.includes('haiku') || model.includes('4.5');
      let inputPrice = 3 / 1_000_000;   // default ~sonnet
      let outputPrice = 15 / 1_000_000;
      let cacheReadPrice = 0.3 / 1_000_000;
      let cacheWritePrice = 3.75 / 1_000_000;
      if (isOpus) {
        inputPrice = 15 / 1_000_000;
        outputPrice = 75 / 1_000_000;
        cacheReadPrice = 1.5 / 1_000_000;
        cacheWritePrice = 18.75 / 1_000_000;
      } else if (isHaiku) {
        inputPrice = 0.8 / 1_000_000;
        outputPrice = 4 / 1_000_000;
        cacheReadPrice = 0.08 / 1_000_000;
        cacheWritePrice = 1 / 1_000_000;
      }
      r.usage.cost =
        r.usage.input * inputPrice +
        r.usage.output * outputPrice +
        r.usage.cacheRead * cacheReadPrice +
        r.usage.cacheWrite * cacheWritePrice;
    }
  }

  return result;
}
