// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Run 工作台（`/run/:runId`，solo 会话同壳）页面对象：页头单行应用栏的
// 几何断言（返回 / 品牌 / tab 导航 / 上传同排、tab 不裁切）、tab 导航
// （RUN_TABS 表：Overview / Graph / Turns / Context / Audit / Perf / Skills /
// Files / Wire 轮次 / Replay / Score——wire/replay 默认隐藏，URL ?a 展开）、
// tab 面板可见性、跨成员搜索胶囊与命中浮层、返回钮（工作台历史栈）。锚点 =
// 页头（data-run-header）、RunTabBar（data-run-tabbar）与面板
// （data-run-tab=<key>）的既有契约。

import { expect, type Locator, type Page } from "../../fixtures";
import type { Download } from "@playwright/test";

export const RUN_TAB_LABELS = {
  overview: "Overview",
  graph: "Graph",
  turns: "Turns",
  context: "Context",
  audit: "Audit",
  perf: "Perf",
  skills: "Skills",
  files: "Files",
  wire: "Wire 轮次",
  replay: "Replay",
  score: "Score",
} as const;

export type RunTabKey = keyof typeof RUN_TAB_LABELS;

export class RunWorkbenchPO {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(runId: string, params = ""): Promise<void> {
    await this.page.goto(`/run/${runId}${params ? `?${params}` : ""}`);
  }

  tabBar(): Locator {
    return this.page.locator("[data-run-tabbar]");
  }

  tabButton(tab: RunTabKey): Locator {
    return this.tabBar().getByRole("button", { name: RUN_TAB_LABELS[tab], exact: true });
  }

  /** 活跃面板定位器（data-run-tab=<key>）。 */
  panel(tab: RunTabKey): Locator {
    return this.page.locator(`[data-run-tab="${tab}"]`);
  }

  /** 活跃面板断言。注意只看可见性：非活跃面板挂 tailwind `hidden` 类
   *  （display:none → 不可见），但合法类名里含 `overflow-hidden` 这类
   *  子串——不能用 /hidden/ 正则判类（会把活跃面板误判成隐藏）。另注意
   *  非活跃面板要「访问过才挂载」（visitedTabs 惰性挂载契约）。 */
  async expectTabActive(tab: RunTabKey): Promise<void> {
    await expect(this.panel(tab)).toBeVisible();
  }

  async switchTab(tab: RunTabKey): Promise<void> {
    await this.tabButton(tab).click();
    await this.expectTabActive(tab);
    await expect(this.page).toHaveURL(new RegExp(`tab=${tab}`));
  }

  /** 返回钮（页头左段，title 即语义锚点）。 */
  backButton(): Locator {
    return this.page.getByTitle("返回上一步");
  }

  /** 页头（单行应用栏：返回 · 品牌 → tab 导航（居页头正中）→ 动作簇同排）。 */
  header(): Locator {
    return this.page.locator("[data-run-header]");
  }

  /** 品牌区（页头左段，回工作台首页的链接）。 */
  brandLockup(): Locator {
    return this.header().locator('a[href="/"]');
  }

  /** 页头「导出」菜单触发钮（在线宿主独有；离线档案无导出动作）。 */
  exportTrigger(): Locator {
    return this.page.getByRole("button", { name: "导出", exact: true });
  }

  /** 导出菜单的一个条目（data-run-export 锚点：sqlite / archive / markdown / html）。 */
  exportMenuItem(id: "sqlite" | "archive" | "markdown" | "html"): Locator {
    return this.page.locator(`[data-run-export="${id}"]`);
  }

  /** 打开导出菜单，等条目渲染出来。 */
  async openExportMenu(): Promise<void> {
    await this.exportTrigger().click();
    await this.exportMenuItem("sqlite").waitFor({ state: "visible" });
  }

  /** 点一个导出条目并捕获下载（须先 stripFilePicker 走锚点下载）。 */
  async exportAndWaitDownload(id: "sqlite" | "archive" | "markdown" | "html"): Promise<Download> {
    await this.openExportMenu();
    const [download] = await Promise.all([
      this.page.waitForEvent("download"),
      this.exportMenuItem(id).click(),
    ]);
    return download;
  }

  /** 上传数据仓主操作（页头动作区；窄页头收成纯图标，title 恒为全称）。 */
  uploadButton(): Locator {
    return this.page.locator('[data-run-header-actions] button[title^="上传"]');
  }

  /** 上传钮的文字（页头够宽才显示）。 */
  uploadLabel(): Locator {
    return this.uploadButton().locator("span");
  }

  /** 品牌字标（页头不够宽时收起，只留品牌图标）。 */
  brandWordmark(): Locator {
    return this.header().locator("[data-brand-wordmark]");
  }

  /** 轨道边缘渐隐的当前值：none 或渐变（滚动 / 可用宽度变化后现算）。 */
  trackMask(): Promise<string> {
    return this.tabBar().evaluate((bar) => (bar.firstElementChild as HTMLElement).style.maskImage || "none");
  }

  /** 页面无横向溢出（页头再窄也不撑破视口）。 */
  async expectNoHorizontalOverflow(): Promise<void> {
    const overflow = await this.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }

  /** 页头单行几何：返回 / 品牌 / tab 条 / 上传的垂直中心对齐（同一水平
   *  线），页头只有一行高。 */
  async expectSingleRow(): Promise<void> {
    const targets = [this.backButton(), this.brandLockup(), this.tabBar(), this.uploadButton()];
    const centers: number[] = [];
    for (const target of targets) {
      await expect(target).toBeVisible();
      const box = (await target.boundingBox())!;
      centers.push(box.y + box.height / 2);
    }
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1.5);
    const header = (await this.header().boundingBox())!;
    expect(header.height).toBeLessThanOrEqual(48);
  }

  /** tab 条居页头正中（左右两翼等权平分剩余空间）。tolerance：某一翼内容超出
   *  自己那半份时中段向另一侧让位，容差按各视口的实际让位量给。 */
  async expectTabsCentered(tolerance = 1.5): Promise<void> {
    const bar = (await this.tabBar().boundingBox())!;
    const header = (await this.header().boundingBox())!;
    expect(Math.abs(bar.x + bar.width / 2 - (header.x + header.width / 2))).toBeLessThanOrEqual(tolerance);
  }

  /** tab 条无裁切：每个 tab 按钮完整落在轨道可视范围内（没被横滚藏起）。 */
  async expectTabsUnclipped(): Promise<void> {
    const clipped = await this.tabBar().evaluate((bar) => {
      const track = bar.firstElementChild as HTMLElement;
      const visible = track.getBoundingClientRect();
      return Array.from(track.querySelectorAll("button"))
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.left < visible.left - 0.5 || r.right > visible.right + 0.5;
        })
        .map((b) => b.textContent ?? "");
    });
    expect(clipped).toEqual([]);
  }

  /** 活跃 tab 完整可见（窄页头 tab 条横滚时，活跃项平滑滚入视野——轮询等到位）。 */
  async expectActiveTabVisible(tab: RunTabKey): Promise<void> {
    await expect.poll(async () => {
      const insets = await this.tabBar().evaluate((bar, label) => {
        const track = bar.firstElementChild as HTMLElement;
        const btn = Array.from(track.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLElement;
        const visible = track.getBoundingClientRect();
        const r = btn.getBoundingClientRect();
        return { left: r.left - visible.left, right: visible.right - r.right };
      }, RUN_TAB_LABELS[tab]);
      return insets.left >= -0.5 && insets.right >= -0.5;
    }).toBe(true);
  }

  /** 内容区从页头下方开始——页头之下没有第二行导航。 */
  async expectContentBelowHeader(): Promise<void> {
    const header = (await this.header().boundingBox())!;
    const panel = (await this.panel("overview").boundingBox())!;
    expect(panel.y).toBeGreaterThanOrEqual(header.y + header.height);
  }

  /** 跨成员搜索胶囊输入框（Run 轨右端常驻）。 */
  turnsSearchInput(): Locator {
    return this.page.locator("[data-turns-search-input]");
  }

  /** 搜索命中浮层（毛玻璃命中索引）。 */
  hitsOverlay(): Locator {
    return this.page.locator("[data-turns-hits]");
  }

  /** 错误态（加载失败在面板区居中）：重试/返回钮同时在场即错误卡形态。 */
  async expectErrorState(): Promise<void> {
    await expect(this.page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
    await expect(this.page.getByRole("button", { name: "返回", exact: true })).toBeVisible();
  }
}
