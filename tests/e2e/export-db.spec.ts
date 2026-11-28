// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 工作台「导出 → SQLite 数据库」旅程（真实服务 + 真实库）：页头导出菜单 →
// run 级 export-db 端点 → 下载 context_session_*.db → 件内 = run 全员成员会话
// （格式头 ExportMeta + Session 行 + Turn 派生行，与在线工作台同一份数据）→
// 经真实导入端点原样导回（导入预览列全成员 + 导入幂等合并不产生重复行）。
// 语料：solo = claude-sample（claude-code，无合成续轮 → 轮次数与在线接口全等）；
// bundle = minidemo01（三成员）。

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test, type Page } from "./fixtures";
import { BASE_URL, CLAUDE_SAMPLE_SESSION_ID, E2E_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";
import { stripFilePicker } from "./support/file-picker";

type SessionRow = { taskId: string; framework: string; version: string | null };

/** 打开工作台（先剥保存对话框 API——addInitScript 只对此后的导航生效） */
async function openRun(page: Page, target: string): Promise<RunWorkbenchPO> {
  await stripFilePicker(page);
  const run = new RunWorkbenchPO(page);
  await run.goto(target);
  await run.expectTabActive("overview");
  return run;
}

/** 页头导出 → 下载落到用例输出目录（文件名保留建议名——即用户看到的落盘名） */
async function exportViaHeader(run: RunWorkbenchPO, target: string): Promise<{ file: string; suggested: string }> {
  const download = await run.exportAndWaitDownload("sqlite");
  const suggested = download.suggestedFilename();
  const file = path.join(target, suggested);
  await download.saveAs(file);
  return { file, suggested };
}

function openExport(file: string): Database.Database {
  return new Database(file, { readonly: true });
}

async function postJson(urlPath: string, body: unknown): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
}

test.describe("工作台导出 SQLite 数据库", () => {
  test("solo：下载 context_session_<taskId>.db，件内会话行与轮次与在线工作台同一份数据", async ({ page }) => {
    const run = await openRun(page, `solo:${CLAUDE_SAMPLE_SESSION_ID}`);
    await expect(run.exportTrigger()).toBeVisible();

    const { file, suggested } = await exportViaHeader(run, test.info().outputDir);
    expect(suggested).toBe(`context_session_${CLAUDE_SAMPLE_SESSION_ID}.db`);
    expect(fs.readFileSync(file).subarray(0, 15).toString()).toBe("SQLite format 3");

    const db = openExport(file);
    try {
      expect((db.prepare("SELECT value FROM ExportMeta WHERE key = 'producer'").get() as { value: string }).value).toBe("insight-export");
      // 单会话 run = 一行，身份（记录类）原样——不被导出容器冒充
      const rows = db.prepare("SELECT taskId, framework, version FROM Session").all() as SessionRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0].taskId).toBe(CLAUDE_SAMPLE_SESSION_ID);
      expect(rows[0].framework).toBe("claude-code");

      // 轮次数与在线工作台的轮次接口全等（claude-code 无合成续轮）
      const turnsRes = await fetch(`${BASE_URL}/api/observe/run/solo%3A${CLAUDE_SAMPLE_SESSION_ID}/member-turns`);
      const turns = (await turnsRes.json()) as { items: Array<{ turnId: string }>; total: number };
      const fileTurnIds = (db.prepare("SELECT id FROM Turn").all() as Array<{ id: string }>).map(r => r.id).sort();
      expect(turns.items.length).toBeGreaterThan(0);
      expect(fileTurnIds).toEqual(turns.items.map(i => i.turnId).sort());
    } finally {
      db.close();
    }
  });

  test("solo 往返：导出件经真实导入端点原样导回（预览列会话 + 导入幂等，不产生重复行）", async ({ page }) => {
    const run = await openRun(page, `solo:${CLAUDE_SAMPLE_SESSION_ID}`);
    const { file } = await exportViaHeader(run, test.info().outputDir);

    // 导入预览：件被内容级识别为本品牌导出件，列出会话与记录类
    const preview = await postJson("/api/ingest/import-file/sessions", { source: "context-insight", filePath: file });
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    const listed = (preview.json as { sessions: Array<{ id: string; framework: string | null }> }).sessions;
    expect(listed.map(s => s.id)).toEqual([CLAUDE_SAMPLE_SESSION_ID]);
    expect(listed[0].framework).toBe("claude-code");

    // 同实例导回 = 幂等合并：仍是一行会话、轮次数不变
    const imported = await postJson("/api/ingest/import-file", {
      sessionId: CLAUDE_SAMPLE_SESSION_ID,
      filePath: file,
      source: "context-insight",
    });
    expect(imported.status, JSON.stringify(imported.json)).toBe(200);

    const detail = await (await fetch(`${BASE_URL}/api/observe/run/solo%3A${CLAUDE_SAMPLE_SESSION_ID}`)).json();
    expect(detail.members.map((m: { taskId: string }) => m.taskId)).toEqual([CLAUDE_SAMPLE_SESSION_ID]);
    const before = openExport(file);
    const beforeTurns = (before.prepare("SELECT COUNT(*) AS n FROM Turn").get() as { n: number }).n;
    before.close();
    const turns = (await (await fetch(`${BASE_URL}/api/observe/run/solo%3A${CLAUDE_SAMPLE_SESSION_ID}/member-turns`)).json()) as { total: number };
    expect(turns.total).toBe(beforeTurns);
  });

  test("bundle：下载 context_session_run_<name>.db，件内 = run 全员成员会话", async ({ page }) => {
    const run = await openRun(page, E2E_RUN_ID);

    const { file, suggested } = await exportViaHeader(run, test.info().outputDir);
    expect(suggested).toBe("context_session_run_mini-bundle.db");

    // 在线工作台看到的全员（run 详情 view-model）= 导出件里的会话行
    const detail = await (await fetch(`${BASE_URL}/api/observe/run/${encodeURIComponent(E2E_RUN_ID)}`)).json();
    const memberTaskIds: string[] = detail.members.map((m: { taskId: string }) => m.taskId).sort();
    expect(memberTaskIds.length).toBeGreaterThan(1);

    const db = openExport(file);
    try {
      const rows = (db.prepare("SELECT taskId, framework FROM Session").all() as Array<{ taskId: string; framework: string }>).sort((a, b) =>
        a.taskId.localeCompare(b.taskId),
      );
      // 成员身份逐行对齐（taskId × 记录类）：与在线工作台看到的全员同一份
      expect(rows).toEqual(
        (detail.members as Array<{ taskId: string; framework: string }>)
          .map(m => ({ taskId: m.taskId, framework: m.framework }))
          .sort((a, b) => a.taskId.localeCompare(b.taskId)),
      );
      expect(memberTaskIds).toEqual(rows.map(r => r.taskId));
      // 派生行只属于成员会话（无孤儿轮次）
      const orphans = (db.prepare("SELECT COUNT(*) AS n FROM Turn WHERE sessionId NOT IN (SELECT id FROM Session)").get() as { n: number }).n;
      expect(orphans).toBe(0);
    } finally {
      db.close();
    }
  });
});
