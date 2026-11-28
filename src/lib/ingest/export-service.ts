// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { PrismaClient, type Session } from '@prisma/client';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isSafeTaskId } from '@/lib/task-id';
import { VERSION } from '@/lib/version';

// 会话独立 SQLite 导出件（context-insight 容器格式）的唯一写管线。件 = 文件级
// 格式头 ExportMeta + N 行 Session 及各自的派生行（Turn / ToolCall / SkillEvent /
// Execution / ExecutionSkill / SessionSkill / InteractionBridge）。读回侧是
// adapters/context-insight（导入向导 / ctxi import / 回收站恢复同一入口）。
// 两个入口、一条写管线：
//   exportSessionRows(rowIds)  按行导出、一杆多行——run 作用域（solo = 1 行 /
//                              bundle = 全部成员行）导出用的就是它；
//   exportSession(taskId, …)   单会话、按 taskId × 记录类定位到行再委托——回收站
//                              「按行归档」的入口。
// ExportMeta = 导出格式的 magic header（与 lake JSONL 导出的 meta.json
// producer 声明对称）：producer 让件自报产源（内容级识别的强信号，不再
// 只靠 Session 表名启发式），schemaVersion 为导出 schema 演进留版本门。
// 它只描述文件格式（格式轴），不携带会话身份——身份在 Session 行（身份轴）。
const EXPORT_SCHEMA_VERSION = '1';

const DDL = `
CREATE TABLE "ExportMeta" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "label" TEXT,
    "query" TEXT,
    "framework" TEXT NOT NULL DEFAULT 'unknown',
    "model" TEXT,
    "startTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" DATETIME,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "totalInputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalReasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "totalCacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "totalCacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "totalCost" REAL NOT NULL DEFAULT 0,
    "totalLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "totalToolCallCount" INTEGER NOT NULL DEFAULT 0,
    "totalLlmCallCount" INTEGER NOT NULL DEFAULT 0,
    "totalSkillLoadCount" INTEGER NOT NULL DEFAULT 0,
    "totalSubagentCount" INTEGER NOT NULL DEFAULT 0,
    "rootExecutionId" TEXT,
    "sourcePath" TEXT,
    "parentId" TEXT,
    "version" TEXT,
    "directory" TEXT,
    "summaryAdditions" INTEGER NOT NULL DEFAULT 0,
    "summaryDeletions" INTEGER NOT NULL DEFAULT 0,
    "summaryFiles" INTEGER NOT NULL DEFAULT 0,
    "user" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "Turn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "turnIndex" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT,
    "contentJson" TEXT,
    "contentSummary" TEXT,
    "inputMessagesJson" TEXT,
    "inputMessagesCount" INTEGER NOT NULL DEFAULT 0,
    "inputMessagesTokens" INTEGER NOT NULL DEFAULT 0,
    "contextWindowPct" REAL,
    "agentName" TEXT,
    "subagentName" TEXT,
    "subagentSessionId" TEXT,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt_ts" DATETIME,
    "completedAt" DATETIME,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "ttftMs" INTEGER,
    "model" TEXT,
    "modelId" TEXT,
    "providerId" TEXT,
    "temperature" REAL,
    "maxTokens" INTEGER,
    "finishReason" TEXT,
    "isSubagent" BOOLEAN NOT NULL DEFAULT false,
    "parentExecutionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Turn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "turnId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsJson" TEXT,
    "resultJson" TEXT,
    "state" TEXT NOT NULL DEFAULT 'ok',
    "errorType" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "dispatchBridgeId" TEXT,
    "isSkillRelated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ToolCall_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SkillEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "turnId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "skillVersion" INTEGER,
    "eventType" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "argsJson" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillEvent_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Execution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "agentName" TEXT,
    "agentSessionId" TEXT,
    "isSubagent" BOOLEAN NOT NULL DEFAULT false,
    "subagentType" TEXT,
    "subagentName" TEXT,
    "parentExecutionId" TEXT,
    "rootExecutionId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadInputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationInputTokens" INTEGER NOT NULL DEFAULT 0,
    "maxSingleCallTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" REAL NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "toolCallErrorCount" INTEGER NOT NULL DEFAULT 0,
    "llmCallCount" INTEGER NOT NULL DEFAULT 0,
    "skillLoadCount" INTEGER NOT NULL DEFAULT 0,
    "skillInvokeCount" INTEGER NOT NULL DEFAULT 0,
    "finalResult" TEXT,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Execution_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ExecutionSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "skillVersion" INTEGER,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "user" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExecutionSkill_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SessionSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "skillVersion" INTEGER,
    "invocationCount" INTEGER NOT NULL DEFAULT 0,
    "user" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionSkill_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "InteractionBridge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "dispatchExecutionId" TEXT NOT NULL,
    "dispatchTurnId" TEXT,
    "dispatchToolCallId" TEXT,
    "dispatchContent" TEXT,
    "dispatchTimestamp" DATETIME,
    "responseExecutionId" TEXT,
    "responseTurnId" TEXT,
    "responseContent" TEXT,
    "responseTimestamp" DATETIME,
    "subagentSessionId" TEXT,
    "subagentType" TEXT,
    "subagentName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'dispatched',
    "subagentTokens" INTEGER NOT NULL DEFAULT 0,
    "subagentLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InteractionBridge_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Session_taskId_framework_key" ON "Session"("taskId", "framework");
CREATE INDEX "Turn_sessionId_turnIndex_idx" ON "Turn"("sessionId", "turnIndex");
CREATE INDEX "Turn_sessionId_isSubagent_idx" ON "Turn"("sessionId", "isSubagent");
CREATE INDEX "Turn_subagentSessionId_idx" ON "Turn"("subagentSessionId");
CREATE INDEX "Turn_agentName_idx" ON "Turn"("agentName");
CREATE INDEX "ToolCall_turnId_idx" ON "ToolCall"("turnId");
CREATE INDEX "ToolCall_toolName_idx" ON "ToolCall"("toolName");
CREATE INDEX "ToolCall_toolName_state_idx" ON "ToolCall"("toolName", "state");
CREATE INDEX "SkillEvent_turnId_idx" ON "SkillEvent"("turnId");
CREATE INDEX "SkillEvent_skillName_idx" ON "SkillEvent"("skillName");
CREATE INDEX "SkillEvent_skillName_eventType_idx" ON "SkillEvent"("skillName", "eventType");
CREATE INDEX "Execution_sessionId_idx" ON "Execution"("sessionId");
CREATE INDEX "Execution_parentExecutionId_idx" ON "Execution"("parentExecutionId");
CREATE INDEX "Execution_rootExecutionId_idx" ON "Execution"("rootExecutionId");
CREATE INDEX "Execution_isSubagent_idx" ON "Execution"("isSubagent");
CREATE INDEX "Execution_agentSessionId_idx" ON "Execution"("agentSessionId");
CREATE INDEX "ExecutionSkill_skillName_skillVersion_idx" ON "ExecutionSkill"("skillName", "skillVersion");
CREATE INDEX "ExecutionSkill_executionId_idx" ON "ExecutionSkill"("executionId");
CREATE INDEX "SessionSkill_skillName_idx" ON "SessionSkill"("skillName");
CREATE UNIQUE INDEX "SessionSkill_sessionId_skillName_key" ON "SessionSkill"("sessionId", "skillName");
CREATE INDEX "InteractionBridge_sessionId_idx" ON "InteractionBridge"("sessionId");
CREATE INDEX "InteractionBridge_dispatchExecutionId_idx" ON "InteractionBridge"("dispatchExecutionId");
CREATE INDEX "InteractionBridge_responseExecutionId_idx" ON "InteractionBridge"("responseExecutionId");
CREATE INDEX "InteractionBridge_subagentSessionId_idx" ON "InteractionBridge"("subagentSessionId");
CREATE INDEX "InteractionBridge_status_idx" ON "InteractionBridge"("status");
`;

function toISO(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** 一次导出的产出摘要（各行数按表计；sessions = 写入的会话行数） */
export interface SessionArchiveSummary {
  path: string;
  sessions: number;
  turns: number;
  toolCalls: number;
  skillEvents: number;
  executions: number;
  bridges: number;
}

export async function exportSession(
  taskId: string,
  outputPath?: string,
  prisma?: PrismaClient,
  framework?: string,
): Promise<string> {
  if (!isSafeTaskId(taskId)) {
    throw new Error(`Invalid taskId: ${JSON.stringify(String(taskId).slice(0, 40))}`);
  }
  const client = prisma ?? new PrismaClient();

  try {
    const where: Record<string, string> = { taskId };
    if (framework) where.framework = framework;

    const session = await client.session.findFirst({
      where,
    });
    if (!session) {
      throw new Error(`Session not found: "${taskId}"`);
    }
    return (await exportSessionRows([session.id], outputPath, client)).path;
  } finally {
    if (!prisma) await client.$disconnect();
  }
}

export async function exportSessionRows(
  rowIds: string[],
  outputPath?: string,
  prisma?: PrismaClient,
): Promise<SessionArchiveSummary> {
  if (rowIds.length === 0) {
    throw new Error('No session rows to export');
  }
  const client = prisma ?? new PrismaClient();

  // 未指定输出 = 临时件（按进程 + 随机后缀命名：并发导出不互踩），消费方
  // （HTTP 端点读完即删）不关心名字
  const outPath = outputPath ?? path.join(os.tmpdir(), `context_session_export_${process.pid}-${Date.now()}.db`);
  const tmpPath = `${outPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  let db: InstanceType<typeof Database> | undefined;

  try {
    // 行定位：rowId = Prisma Session.id（cuid 全局唯一），调用序即写入序。
    // 任一行缺失整体失败——少写一个成员的导出件是静默的数据丢失
    const found = await client.session.findMany({ where: { id: { in: rowIds } } });
    const byId = new Map(found.map(row => [row.id, row] as const));
    const sessions: Session[] = [];
    const missing: string[] = [];
    for (const id of rowIds) {
      const row = byId.get(id);
      if (row) sessions.push(row);
      else missing.push(id);
    }
    if (missing.length > 0) {
      throw new Error(`Session not found: ${missing.length} of ${rowIds.length} rows`);
    }
    const sessionIds = sessions.map(s => s.id);

    // 写入临时文件、成功后原子改名：同路径重复导出（回收站覆盖归档）与下方
    // 分块多事务写入都靠这层保证消费方（restore 导入）永远只见到完整快照——
    // 中途任何失败留下的是 .tmp 残骸而非可被误恢复的半截条目
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

    db = new Database(tmpPath);
    db.exec(DDL);

    const insertExportMeta = db.prepare(`
      INSERT INTO "ExportMeta" ("key", "value") VALUES (?, ?)
    `);

    const insertSession = db.prepare(`
      INSERT INTO "Session" (
        "id", "taskId", "label", "query", "framework", "model",
        "startTime", "endTime",
        "totalTokens", "totalInputTokens", "totalOutputTokens", "totalReasoningTokens",
        "totalCacheReadTokens", "totalCacheWriteTokens", "totalCost", "totalLatencyMs",
        "totalToolCallCount", "totalLlmCallCount", "totalSkillLoadCount", "totalSubagentCount",
        "rootExecutionId", "sourcePath", "parentId", "version", "directory",
        "summaryAdditions", "summaryDeletions", "summaryFiles",
        "user", "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTurn = db.prepare(`
      INSERT INTO "Turn" (
        "id", "sessionId", "turnIndex", "role", "content", "contentJson", "contentSummary",
        "inputMessagesJson", "inputMessagesCount", "inputMessagesTokens", "contextWindowPct",
        "agentName", "subagentName", "subagentSessionId",
        "totalTokens", "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens",
        "createdAt_ts", "completedAt", "latencyMs", "ttftMs",
        "model", "modelId", "providerId", "temperature", "maxTokens", "finishReason",
        "isSubagent", "parentExecutionId", "createdAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertToolCall = db.prepare(`
      INSERT INTO "ToolCall" (
        "id", "turnId", "toolCallId", "toolName", "argsJson", "resultJson",
        "state", "errorType", "errorMessage",
        "startedAt", "completedAt", "durationMs", "dispatchBridgeId", "isSkillRelated", "createdAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertSkillEvent = db.prepare(`
      INSERT INTO "SkillEvent" (
        "id", "turnId", "skillName", "skillVersion", "eventType", "success",
        "errorMessage", "argsJson", "startedAt", "completedAt", "durationMs", "createdAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertExecution = db.prepare(`
      INSERT INTO "Execution" (
        "id", "sessionId", "agentName", "agentSessionId", "isSubagent", "subagentType", "subagentName",
        "parentExecutionId", "rootExecutionId", "depth",
        "tokens", "inputTokens", "outputTokens", "reasoningTokens",
        "cacheReadInputTokens", "cacheCreationInputTokens", "maxSingleCallTokens",
        "cost", "latencyMs", "toolCallCount", "toolCallErrorCount",
        "llmCallCount", "skillLoadCount", "skillInvokeCount",
        "finalResult", "model", "createdAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertExecutionSkill = db.prepare(`
      INSERT INTO "ExecutionSkill" (
        "id", "executionId", "skillName", "skillVersion", "isPrimary", "user", "createdAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertSessionSkill = db.prepare(`
      INSERT INTO "SessionSkill" (
        "id", "sessionId", "skillName", "skillVersion", "invocationCount", "user", "createdAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertBridge = db.prepare(`
      INSERT INTO "InteractionBridge" (
        "id", "sessionId", "dispatchExecutionId", "dispatchTurnId", "dispatchToolCallId",
        "dispatchContent", "dispatchTimestamp",
        "responseExecutionId", "responseTurnId", "responseContent", "responseTimestamp",
        "subagentSessionId", "subagentType", "subagentName", "status",
        "subagentTokens", "subagentLatencyMs", "createdAt", "updatedAt"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const turns = await client.turn.findMany({ where: { sessionId: { in: sessionIds } }, orderBy: { turnIndex: 'asc' } });
    const turnIds = turns.map(t => t.id);
    const toolCalls = turnIds.length > 0
      ? await client.toolCall.findMany({ where: { turnId: { in: turnIds } } })
      : [];
    const skillEvents = turnIds.length > 0
      ? await client.skillEvent.findMany({ where: { turnId: { in: turnIds } } })
      : [];
    const executions = await client.execution.findMany({ where: { sessionId: { in: sessionIds } } });
    const executionIds = executions.map(e => e.id);
    const executionSkills = executionIds.length > 0
      ? await client.executionSkill.findMany({ where: { executionId: { in: executionIds } } })
      : [];
    const sessionSkills = await client.sessionSkill.findMany({ where: { sessionId: { in: sessionIds } } });
    const bridges = await client.interactionBridge.findMany({ where: { sessionId: { in: sessionIds } } });

    // 事件循环分块写入：better-sqlite3 全同步，几千轮大会话的导出（回收站
    // 归档/删除级联）会连续占住 Node 事件循环数秒——期间整个服务器对其他
    // 请求无响应（现场：主页删除大会话全站卡顿）。按块提交事务、块间
    // setImmediate 让出：单块 ≤500 行毫秒级完成，导出全程服务器保持响应；
    // 多事务的原子性由上面「临时文件 + 原子改名」兜底
    const YIELD_ROWS = 500;
    const breathe = () => new Promise<void>(resolve => setImmediate(resolve));
    // 闭包捕获收窄：let 声明在闭包体内不保赋值后的收窄，经 const 固化
    const conn = db;
    const insertChunked = async <T>(rows: T[], run: (row: T) => void): Promise<void> => {
      for (let i = 0; i < rows.length; i += YIELD_ROWS) {
        const chunk = rows.slice(i, i + YIELD_ROWS);
        conn.transaction(() => {
          for (const row of chunk) run(row);
        })();
        await breathe();
      }
    };

    db.transaction(() => {
      insertExportMeta.run('producer', 'insight-export');
      insertExportMeta.run('schemaVersion', EXPORT_SCHEMA_VERSION);
      insertExportMeta.run('exportedAt', new Date().toISOString());
      insertExportMeta.run('insightVersion', VERSION);

      for (const session of sessions) {
        insertSession.run(
          session.id, session.taskId, session.label, session.query, session.framework, session.model,
          toISO(session.startTime), toISO(session.endTime),
          session.totalTokens, session.totalInputTokens, session.totalOutputTokens, session.totalReasoningTokens,
          session.totalCacheReadTokens, session.totalCacheWriteTokens, session.totalCost, session.totalLatencyMs,
          session.totalToolCallCount, session.totalLlmCallCount, session.totalSkillLoadCount, session.totalSubagentCount,
          session.rootExecutionId, session.sourcePath,
          session.parentId, session.version, session.directory,
          session.summaryAdditions, session.summaryDeletions, session.summaryFiles,
          session.user,
          toISO(session.createdAt), toISO(session.updatedAt),
        );
      }
    })();

    await insertChunked(turns, t =>
      insertTurn.run(
        t.id, t.sessionId, t.turnIndex, t.role, t.content, t.contentJson, t.contentSummary,
        t.inputMessagesJson, t.inputMessagesCount, t.inputMessagesTokens, t.contextWindowPct,
        t.agentName, t.subagentName, t.subagentSessionId,
        t.totalTokens, t.inputTokens, t.outputTokens, t.reasoningTokens, t.cacheReadTokens, t.cacheWriteTokens,
        toISO(t.createdAt_ts), toISO(t.completedAt), t.latencyMs, t.ttftMs,
        t.model, t.modelId, t.providerId, t.temperature, t.maxTokens, t.finishReason,
        t.isSubagent ? 1 : 0, t.parentExecutionId, toISO(t.createdAt),
      ),
    );

    await insertChunked(toolCalls, tc =>
      insertToolCall.run(
        tc.id, tc.turnId, tc.toolCallId, tc.toolName, tc.argsJson, tc.resultJson,
        tc.state, tc.errorType, tc.errorMessage,
        toISO(tc.startedAt), toISO(tc.completedAt), tc.durationMs, tc.dispatchBridgeId,
        tc.isSkillRelated ? 1 : 0, toISO(tc.createdAt),
      ),
    );

    await insertChunked(skillEvents, se =>
      insertSkillEvent.run(
        se.id, se.turnId, se.skillName, se.skillVersion, se.eventType,
        se.success ? 1 : 0, se.errorMessage, se.argsJson,
        toISO(se.startedAt), toISO(se.completedAt), se.durationMs, toISO(se.createdAt),
      ),
    );

    await insertChunked(executions, e =>
      insertExecution.run(
        e.id, e.sessionId, e.agentName, e.agentSessionId,
        e.isSubagent ? 1 : 0, e.subagentType, e.subagentName,
        e.parentExecutionId, e.rootExecutionId, e.depth,
        e.tokens, e.inputTokens, e.outputTokens, e.reasoningTokens,
        e.cacheReadInputTokens, e.cacheCreationInputTokens, e.maxSingleCallTokens,
        e.cost, e.latencyMs, e.toolCallCount, e.toolCallErrorCount,
        e.llmCallCount, e.skillLoadCount, e.skillInvokeCount,
        e.finalResult, e.model, toISO(e.createdAt),
      ),
    );

    await insertChunked(executionSkills, es =>
      insertExecutionSkill.run(
        es.id, es.executionId, es.skillName, es.skillVersion,
        es.isPrimary ? 1 : 0, es.user, toISO(es.createdAt),
      ),
    );

    await insertChunked(sessionSkills, ss =>
      insertSessionSkill.run(
        ss.id, ss.sessionId, ss.skillName, ss.skillVersion,
        ss.invocationCount, ss.user, toISO(ss.createdAt),
      ),
    );

    await insertChunked(bridges, b =>
      insertBridge.run(
        b.id, b.sessionId, b.dispatchExecutionId, b.dispatchTurnId, b.dispatchToolCallId,
        b.dispatchContent, toISO(b.dispatchTimestamp),
        b.responseExecutionId, b.responseTurnId, b.responseContent, toISO(b.responseTimestamp),
        b.subagentSessionId, b.subagentType, b.subagentName, b.status,
        b.subagentTokens, b.subagentLatencyMs, toISO(b.createdAt), toISO(b.updatedAt),
      ),
    );
    db.close();
    // 目标已存在时先清再改名：rename 覆盖已存在目标在 Windows 下会 EPERM（回收站
    // 「覆盖归档」反复写同一 taskId__framework.db 会命中），清掉后跨平台可覆盖
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    fs.renameSync(tmpPath, outPath);
    return {
      path: outPath,
      sessions: sessions.length,
      turns: turns.length,
      toolCalls: toolCalls.length,
      skillEvents: skillEvents.length,
      executions: executions.length,
      bridges: bridges.length,
    };
  } catch (e) {
    // 中途失败清 tmp 残骸（正式条目从未诞生——原子改名保证）；原样上抛
    try { db?.close(); } catch { /* 已关或未开 */ }
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw e;
  } finally {
    if (!prisma) await client.$disconnect();
  }
}
