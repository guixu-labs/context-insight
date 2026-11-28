// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 工作台（`/run/:id`，11 tab 观测面）：tab 矩阵渲染、?tab= 深链、
// ?a 高级门、浏览器历史栈（返回钮 = 逐步回退工作台动作）、页头单行应用栏
// （返回 · 品牌 · tab 导航 · 动作簇同排的多视口几何与密度让位）。
// 语料分工：minidemo01 = 结构面（图/代际/验收/子图）；e2e-tools01 的
// Perf 工具耗时数据断言在 turns-deep-link.spec（工具语料的事实地）。

import { expect, test } from "./fixtures";
import { E2E_RUN_ID } from "./constants";
import { RunWorkbenchPO, RUN_TAB_LABELS, type RunTabKey } from "./support/pom/RunWorkbenchPO";

test.describe("Run 工作台", () => {
  test("默认落在 Overview：9 个可见 tab（wire/replay 高级门内）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);

    await run.expectTabActive("overview");
    // 默认可见的 9 tab（wire/replay 经 ?a / NEXT_PUBLIC 开关）
    for (const tab of ["overview", "graph", "turns", "context", "audit", "perf", "skills", "files", "score"] as RunTabKey[]) {
      await expect(run.tabButton(tab)).toBeVisible();
    }
    // 高级 tab 默认不在导航上
    await expect(run.tabBar().getByRole("button", { name: RUN_TAB_LABELS.wire })).toHaveCount(0);
    await expect(run.tabBar().getByRole("button", { name: RUN_TAB_LABELS.replay })).toHaveCount(0);
  });

  test("tab 矩阵：逐 tab 切换，面板真实挂载渲染（惰性挂载 + hidden 切换契约）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);
    await run.expectTabActive("overview");

    // Turns：跨成员搜索胶囊常驻（顶部时间线工具条右端）+ 时间线本体
    await run.switchTab("turns");
    await expect(run.turnsSearchInput()).toBeVisible();

    // 其余 tab：切到位即面板渲染（内容深度由 vitest IT 各自锁定；E2E 锁
    // 「切换后真有东西渲染」——含 Graph 的全宽特殊布局与 Score 末位）
    await expect(page.locator("[data-turns-timeline] [data-timeline-track]")).toBeVisible();

    for (const tab of ["graph", "context", "audit", "perf", "skills", "files", "score"] as RunTabKey[]) {
      await run.switchTab(tab);
    }
    // 执行时间线只在 Turns 顶部：Perf 页不再有时间线卡（已迁出）
    await run.switchTab("perf");
    await expect(page.locator('[data-run-tab="perf"] [data-bar]')).toHaveCount(0);
    // 回到 Overview 收尾（全矩阵往返无残留）
    await run.switchTab("overview");
  });

  test("?tab= 深链：URL 直达 Turns（q 镜像由 turns-deep-link.spec 锁定）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID, "tab=turns");
    await run.expectTabActive("turns");
    await expect(run.turnsSearchInput()).toBeVisible();
  });

  test("?a 高级门：wire/replay tab 展开", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID, "a");
    await expect(run.tabButton("wire")).toBeVisible();
    await expect(run.tabButton("replay")).toBeVisible();
  });

  test("工作台历史栈：返回钮逐步回退 tab 切换", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);
    await run.expectTabActive("overview");

    // overview → turns → graph：每次切换是真实浏览器历史条目
    await run.switchTab("turns");
    await run.switchTab("graph");
    await expect(run.backButton()).toBeVisible();

    // 返回一步 = 回 turns（工作台内回退，不出页）
    await run.backButton().click();
    await run.expectTabActive("turns");
    await expect(page).toHaveURL(/\/run\//);
  });
});

// 页头单行应用栏：返回 · 品牌 → tab 导航 → 动作簇同排（原两行 chrome 合并），
// tab 导航居页头正中（左右两翼等权）。密度按页头自身宽度（容器查询）分三档
// 让位，导航最后才让：①够宽——上传钮带文字；②较窄——上传钮 / 同步 chip 只留
// 图标；③窄——品牌字标也收起、间距收一档（图标钮与两翼留白）；再窄 tab 条才
// 横滚（活跃项自动滚入视野）。
// 几何断言只能在真实浏览器量（happy-dom 无布局）。
test.describe("页头单行应用栏", () => {
  const DEFAULT_TABS: RunTabKey[] = ["overview", "graph", "turns", "context", "audit", "perf", "skills", "files", "score"];

  test("1280 宽：返回 · 品牌 · 9 个 tab · 上传同排，tab 居中且不裁切，内容区从页头下方起", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);
    await run.expectTabActive("overview");

    await run.expectSingleRow();
    // 左翼（返回 + 品牌 253px）略超自己那半份（235px）：tab 条向右让 18px
    await run.expectTabsCentered(24);
    await run.expectTabsUnclipped();
    await run.expectContentBelowHeader();
    await run.expectNoHorizontalOverflow();
    await expect(run.header()).toHaveCount(1);
    await expect(run.brandWordmark()).toBeVisible();
    // 该宽度下动作区是紧凑档：上传钮只留图标，全称在 title
    await expect(run.uploadButton()).toBeVisible();
    await expect(run.uploadLabel()).toBeHidden();
    await expect(run.uploadButton()).toHaveAttribute("title", /^上传/);
    for (const tab of DEFAULT_TABS) await expect(run.tabButton(tab)).toBeVisible();
  });

  // centerTolerance：某一翼内容超出自己那半份时中段向另一侧让位的量（实测；0 = 不量）
  for (const { width, height, wordmark, uploadText, tabsUnclipped, centerTolerance } of [
    { width: 1920, height: 1080, wordmark: true, uploadText: true, tabsUnclipped: true, centerTolerance: 1.5 },
    { width: 1536, height: 864, wordmark: true, uploadText: true, tabsUnclipped: true, centerTolerance: 1.5 },
    { width: 1440, height: 900, wordmark: true, uploadText: false, tabsUnclipped: true, centerTolerance: 1.5 },
    { width: 1024, height: 768, wordmark: false, uploadText: false, tabsUnclipped: true, centerTolerance: 24 },
    { width: 800, height: 600, wordmark: false, uploadText: false, tabsUnclipped: false, centerTolerance: 0 },
  ]) {
    test(`${width}×${height}：仍是单行，品牌字标${wordmark ? "在" : "收起"}，上传钮${uploadText ? "带文字" : "纯图标"}，tab ${tabsUnclipped ? "不裁切" : "横滚但活跃项可见"}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const run = new RunWorkbenchPO(page);
      await run.goto(E2E_RUN_ID);
      await run.expectTabActive("overview");

      await run.expectSingleRow();
      if (centerTolerance > 0) await run.expectTabsCentered(centerTolerance);
      await run.expectNoHorizontalOverflow();
      if (wordmark) await expect(run.brandWordmark()).toBeVisible();
      else await expect(run.brandWordmark()).toBeHidden();
      if (uploadText) await expect(run.uploadLabel()).toBeVisible();
      else await expect(run.uploadLabel()).toBeHidden();
      if (tabsUnclipped) {
        await run.expectTabsUnclipped();
      } else {
        // 放不下：末尾 tab 被横滚藏起；切过去自动滚入视野，再切回 Overview 亦然
        await expect(run.tabButton("score")).not.toBeInViewport();
        await run.switchTab("score");
        await run.expectActiveTabVisible("score");
        await run.switchTab("overview");
        await run.expectActiveTabVisible("overview");
      }
    });
  }

  test("加载态 → 就绪态（1280）：tab 条位置不动", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.route("**/api/observe/run/minidemo01*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    const run = new RunWorkbenchPO(page);
    const loaded = run.goto(E2E_RUN_ID);

    await expect(run.tabBar()).toHaveAttribute("data-pending", "true");
    const loadingBox = (await run.tabButton("overview").boundingBox())!;
    await loaded;
    await run.expectTabActive("overview");
    await expect(run.tabBar()).not.toHaveAttribute("data-pending", "true");
    const readyBox = (await run.tabButton("overview").boundingBox())!;
    expect(readyBox.x).toBeCloseTo(loadingBox.x, 0);
    expect(readyBox.y).toBeCloseTo(loadingBox.y, 0);
  });

  test("加载态 → 就绪态（1024）：加载期被占位挤出的右缘渐隐不残留；之后尺寸变化逐次重算", async ({ page }) => {
    // 1024 宽：加载态右翼占位比真动作区宽，tab 条被挤到溢出；数据到达后放得下
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.route("**/api/observe/run/minidemo01*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    const run = new RunWorkbenchPO(page);
    const loaded = run.goto(E2E_RUN_ID);

    await expect(run.tabBar()).toHaveAttribute("data-pending", "true");
    await expect(run.brandWordmark()).toBeHidden();
    expect(await run.trackMask()).not.toBe("none");

    await loaded;
    await run.expectTabActive("overview");
    await expect(run.tabBar()).not.toHaveAttribute("data-pending", "true");
    await expect(run.uploadButton()).toBeVisible();
    // 渐隐撤掉（节流旗标不复位的回归锁：首算之后的重算曾被全部吞掉）
    await expect.poll(() => run.trackMask()).toBe("none");
    await run.expectTabsCentered(24);

    // 收窄 → 溢出出渐隐；放宽 → 渐隐撤掉：连续两次尺寸变化都要重算
    await page.setViewportSize({ width: 900, height: 768 });
    await expect.poll(() => run.trackMask()).not.toBe("none");
    await page.setViewportSize({ width: 1280, height: 768 });
    await expect.poll(() => run.trackMask()).toBe("none");
    await run.expectTabsUnclipped();
  });
});
