// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 合并文件观测核心（design: docs/design/run-observe-parity/design.md §3.2，刀D）。
// file-reads / file-restore / dir-restore 三路由的取数与归并核心原位抽取，
// 以「会话行 id 集合」参数化——session 路由传单行（行为逐字节不变），run
// 路由传成员会话行集合（跨成员文件读取/恢复全景）。分析/恢复纯函数仍在
// file-reads / file-restore / zip-store 单点，此处只做取数与组装。

import type { PrismaClient } from '@prisma/client';
import { isDirectoryRead, computeRange, analyzeReads, extractShellFileReads, extractExecFileReads, type ReadRange, type ReadEntry } from '@/lib/file-reads';
import { extractFilePath, restoreFile, renderRestoredText, type RestoreOp } from '@/lib/file-restore';
import { buildZip } from '@/lib/zip-store';
import { SHELL_TOOL_NAMES, isShellToolCall, parseReadToolArgs } from '@/lib/tool-conventions';

export interface FileAnalysis {
  path: string;
  displayPath: string;
  reads: ReadEntry[];
  totalReads: number;
  overlappingReads: number;
  totalLinesRead: number;
  uniqueLinesRead: number;
  redundancyRate: number;
}

export interface FileReadsSummary {
  totalFiles: number;
  totalReads: number;
  filesWithOverlap: number;
  redundancyRate: number;
}

const TURN_SELECT = {
  id: true,
  sessionId: true,
  turnIndex: true,
  agentName: true,
  isSubagent: true,
  subagentName: true,
  subagentSessionId: true,
  contentSummary: true,
} as const;

/** 文件读取分析（session file-reads 路由核心原位抽取；rowIds = 会话行集合）。
 *  memberOf 可选：run 合并视图传 rowId → 成员 归因（session 不传 → ReadEntry
 *  不带 member，行为不变） */
export async function analyzeFileReadsForRows(
  prisma: PrismaClient,
  rowIds: string[],
  memberOf?: (rowId: string) => { taskId: string; label: string | null } | null,
): Promise<{ files: FileAnalysis[]; summary: FileReadsSummary }> {
  // 双查询：Read 需要 resultJson（目录判定）；shell 命令族只消费 argsJson——
  // 合并查询会把命令族的 resultJson 一并拉出（实测单会话 16MB 纯浪费）
  const [readCalls, commandCalls] = await Promise.all([
    prisma.toolCall.findMany({
      where: { toolName: { in: ['read', 'Read'] }, turn: { sessionId: { in: rowIds } } },
      select: { toolName: true, argsJson: true, resultJson: true, turn: { select: TURN_SELECT } },
    }),
    // shell 命令工具族（词表）：bash=opencode 1.x / shell=opencode 2.x /
    // exec·exec_command=codex——v2 会话 shell:read≈3:1，隐式读此前整页缺失
    prisma.toolCall.findMany({
      where: { toolName: { in: [...SHELL_TOOL_NAMES] }, turn: { sessionId: { in: rowIds } } },
      select: { toolName: true, argsJson: true, turn: { select: TURN_SELECT } },
    }),
  ]);
  const toolCalls: Array<{
    toolName: string;
    argsJson: string | null;
    resultJson?: string | null;
    turn: (typeof readCalls)[number]['turn'];
  }> = [...readCalls, ...commandCalls];

  const subSessionIds = [...new Set(
    toolCalls
      .filter(tc => tc.turn.isSubagent && tc.turn.subagentSessionId)
      .map(tc => tc.turn.subagentSessionId!),
  )];

  const promptMap = new Map<string, string | null>();
  if (subSessionIds.length > 0) {
    const bridges = await prisma.interactionBridge.findMany({
      where: { sessionId: { in: rowIds }, subagentSessionId: { in: subSessionIds } },
      select: { subagentSessionId: true, dispatchContent: true },
    });
    for (const b of bridges) {
      if (b.subagentSessionId) promptMap.set(b.subagentSessionId, b.dispatchContent);
    }
  }

  const fileMap = new Map<string, { displayPath: string; reads: ReadEntry[] }>();

  for (const tc of toolCalls) {
    // shell 命令族（词表）：一次调用可命中多个文件（内嵌多条命令），逐文件
    // 生成读取条目；双提取器正交叠加——command 形态（bash/shell/exec_command）
    // 与 exec input 形态（codex 代理）互不冲突；Read 走原参数解析
    const perFile: Array<{ filePath: string; displayPath: string; range: ReadRange }> = [];
    if (isShellToolCall(tc.toolName)) {
      for (const r of [...extractShellFileReads(tc.argsJson), ...extractExecFileReads(tc.argsJson)]) {
        perFile.push({ filePath: r.filePath, displayPath: r.filePath, range: r.range });
      }
    } else {
      const args = parseReadToolArgs(tc.argsJson);
      if (!args?.filePath) continue;
      if (isDirectoryRead(args.filePath, tc.resultJson ?? null)) continue;
      perFile.push({ filePath: args.filePath, displayPath: args.summary || args.filePath, range: computeRange(args) });
    }

    const agent = tc.turn.isSubagent
      ? (tc.turn.agentName || tc.turn.subagentName || 'subagent')
      : (tc.turn.agentName || 'root');

    const prompt = tc.turn.isSubagent && tc.turn.subagentSessionId
      ? (promptMap.get(tc.turn.subagentSessionId) ?? null)
      : null;

    for (const pf of perFile) {
      if (!fileMap.has(pf.filePath)) {
        fileMap.set(pf.filePath, { displayPath: pf.displayPath, reads: [] });
      }
      fileMap.get(pf.filePath)!.reads.push({
        turnId: tc.turn.id,
        turnIndex: tc.turn.turnIndex,
        agent,
        prompt,
        subagentSessionId: tc.turn.subagentSessionId ?? null,
        llmOutput: tc.turn.contentSummary ?? null,
        range: pf.range,
        member: memberOf?.(tc.turn.sessionId) ?? null,
      });
    }
  }

  const files: FileAnalysis[] = [];
  let globalTotalLines = 0;
  let globalUniqueLines = 0;

  for (const [path, data] of fileMap) {
    const metrics = analyzeReads(data.reads);
    globalTotalLines += metrics.totalLinesRead;
    globalUniqueLines += metrics.uniqueLinesRead;

    files.push({
      path,
      displayPath: data.displayPath,
      reads: data.reads,
      totalReads: data.reads.length,
      ...metrics,
    });
  }

  files.sort((a, b) => b.totalReads - a.totalReads);

  const summary: FileReadsSummary = {
    totalFiles: files.length,
    totalReads: files.reduce((sum, f) => sum + f.totalReads, 0),
    filesWithOverlap: files.filter(f => f.overlappingReads > 0).length,
    redundancyRate: globalTotalLines > 0 ? 1 - globalUniqueLines / globalTotalLines : 0,
  };

  return { files, summary };
}

/** 读写工具调用提取（file-restore / dir-restore 共用取数；带回文件路径） */
async function loadRestoreOps(prisma: PrismaClient, rowIds: string[]) {
  const toolCalls = await prisma.toolCall.findMany({
    where: {
      toolName: { in: ['read', 'Read', 'write', 'Write'] },
      turn: { sessionId: { in: rowIds } },
    },
    select: {
      toolName: true,
      argsJson: true,
      resultJson: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
    },
  });

  const ops: Array<{ filePath: string; op: RestoreOp }> = [];
  for (const tc of toolCalls) {
    const fp = extractFilePath(tc.argsJson);
    if (!fp) continue;

    const kind = tc.toolName === 'write' || tc.toolName === 'Write' ? 'write' : 'read';
    if (kind === 'read' && isDirectoryRead(fp, tc.resultJson)) continue;

    const ts = tc.startedAt ?? tc.completedAt ?? tc.createdAt ?? null;
    ops.push({
      filePath: fp,
      op: {
        kind,
        argsJson: tc.argsJson,
        resultJson: tc.resultJson,
        ts,
      },
    });
  }
  return ops;
}

/** 单文件恢复（session file-restore 路由核心原位抽取） */
export async function restoreFileForRows(
  prisma: PrismaClient,
  rowIds: string[],
  filePath: string,
) {
  const rows = await loadRestoreOps(prisma, rowIds);
  const ops = rows.filter(r => r.filePath === filePath).map(r => r.op);
  const { lines, maxLine, opsUsed } = restoreFile(ops);
  return { path: filePath, lines, maxLine, opsUsed };
}

/** 目录重编汇册（session dir-restore 路由核心原位抽取；产出 zip Buffer + 统计） */
export async function buildDirRestoreForRows(prisma: PrismaClient, rowIds: string[]) {
  const byPath = new Map<string, RestoreOp[]>();
  for (const { filePath, op } of await loadRestoreOps(prisma, rowIds)) {
    const list = byPath.get(filePath);
    if (list) list.push(op);
    else byPath.set(filePath, [op]);
  }

  const encoder = new TextEncoder();
  const entries: Array<{ path: string; data: Uint8Array }> = [];
  let totalLines = 0;
  let gapLines = 0;
  for (const [path, ops] of byPath) {
    const { lines } = restoreFile(ops);
    totalLines += lines.length;
    gapLines += lines.filter(l => l.source === 'gap').length;
    entries.push({ path, data: encoder.encode(renderRestoredText(lines)) });
  }

  const blob = buildZip(entries);
  const buf = Buffer.from(await blob.arrayBuffer());
  return { buf, count: entries.length, totalLines, gapLines };
}
