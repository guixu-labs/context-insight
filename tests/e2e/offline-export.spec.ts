// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 离线 HTML 导出往返（旗舰旅程）：在线工作台导出自包含 HTML（内联
// export-view.js + 全量数据档案）→ Playwright 拿到下载文件 → file:// 直开
// → 离线内核起播：tab 导航可用（内存栈）、Score 面板照常渲染、评分导出
// 在离线态由档案行精确应答（issue #116 的离线口径）。语料 = solo
// claude-sample（体量小、导出快）。boot-server.sh 已构建 export-view.js。

import { expect, test, type Page } from "./fixtures";
import { CLAUDE_SAMPLE_SESSION_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";
import { stripFilePicker } from "./support/file-picker";

test.describe("离线 HTML 导出", () => {
  test("导出动作：HTML 文件下载", async ({ page }) => {
    await stripFilePicker(page);
    const run = new RunWorkbenchPO(page);
    await run.goto(`solo:${CLAUDE_SAMPLE_SESSION_ID}`);

    await run.openExportMenu();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      run.exportMenuItem("html").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.html$/);
  });

  test("file:// 往返：离线内核起播 + 离线评分导出", async ({ page }) => {
    await stripFilePicker(page);
    const run = new RunWorkbenchPO(page);
    await run.goto(`solo:${CLAUDE_SAMPLE_SESSION_ID}`);

    await run.openExportMenu();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      run.exportMenuItem("html").click(),
    ]);
    // download.path() 是无扩展名的 UUID 临时文件——Chromium 对 file:// 无扩展
    // 名文件不做 HTML 嗅探、整文件按纯文本渲染（#root 不存在）。saveAs 落到
    // 带扩展名的用例输出目录再直开，才是真实的「用户双击导出文件」路径
    const htmlPath = test.info().outputPath("offline-export.html");
    await download.saveAs(htmlPath);

    // file:// 直开自包含档案：离线工作台与在线同壳（同一组件树）
    const viewer = await page.context().newPage();
    await stripFilePicker(viewer);
    await viewer.goto(`file://${htmlPath}`);
    await expect(viewer.locator("[data-run-tabbar]")).toBeVisible({ timeout: 30_000 });

    // 离线 tab 导航（内存栈，不走 URL）：切到 Score，雷达照常渲染
    await viewer
      .locator("[data-run-tabbar]")
      .getByRole("button", { name: "Score", exact: true })
      .click();
    await expect(viewer.locator('[data-run-tab="score"]')).toBeVisible();
    await expect(
      viewer.locator('svg[aria-label="六维能力雷达图"]').first(),
    ).toBeVisible({ timeout: 30_000 });

    // 离线评分导出：离线内核以档案行精确应答 score-export URL——下载照发
    const [scoreDownload] = await Promise.all([
      viewer.waitForEvent("download"),
      viewer
        .getByTitle("导出评分 JSON（全员评分卡 + 维度定义快照——RSI 自循环演进语料）")
        .click(),
    ]);
    expect(scoreDownload.suggestedFilename()).toMatch(/\.json$/);
    await viewer.close();
  });
});
