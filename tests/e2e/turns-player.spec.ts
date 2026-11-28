// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. Please do not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Turns 面板交互面：角色筛选条（chip 计数 = 行为真值——筛选后的可见行数
// 必须与 chip 计数一致）、轮次行点击 → TurnDetail 播放器（胶片轨 + 走查
// 钮）。语料 = e2e-tools01（工具语料：首展开节点的三会话带 user/assistant
// 双角色轮次）。

import { expect, test, type Locator } from "./fixtures";
import { E2E_TOOL_RUN_ID } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";

/** chip 文本里的计数（「全部 12」/「user 5」——tabular-nums 尾数）。 */
async function chipCount(chip: Locator): Promise<number> {
  const text = await chip.innerText();
  const m = text.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : -1;
}

test.describe("Turns 面板交互", () => {
  test("角色筛选条：chip 计数 = 筛后可见行数（真值断言）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    await run.expectTabActive("turns");

    // 筛选条在列表头上常驻（首份成员数据落地即出现）
    const filter = page.locator("[data-role-filter]");
    await expect(filter).toBeVisible();
    const allChip = filter.locator('[data-role-chip="all"]');
    await expect(allChip).toBeVisible();

    const rows = page.locator("[data-turn-list] [data-turn-row]");
    const total = await chipCount(allChip);
    expect(total).toBeGreaterThan(0);
    // 无筛选：可见行数 = 「全部」chip 计数（首个内容节点默认展开，其会话
    // 轮次全量渲染；未展开节点不渲染行——两数同源同值）
    await expect(rows).toHaveCount(total);

    // 选一个角色 chip：aria-pressed 置位 + 可见行数收缩到该 chip 计数
    const roleChip = filter.locator("[data-role-chip]:not([data-role-chip='all'])").first();
    const roleTotal = await chipCount(roleChip);
    expect(roleTotal).toBeGreaterThan(0);
    await roleChip.click();
    await expect(roleChip).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(roleTotal);

    // 「全部」复位：行数复原
    await allChip.click();
    await expect(rows).toHaveCount(total);
  });

  test("轮次行点击 → TurnDetail 播放器：详情 + 胶片轨 + 走查钮", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    await run.expectTabActive("turns");

    const rows = page.locator("[data-turn-list] [data-turn-row]");
    await expect(rows.first()).toBeVisible();
    await rows.first().click();

    // 轮详情（叙事舞台 + 传输条 + 三联指标）
    const detail = page.locator("[data-turn-detail]");
    await expect(detail).toBeVisible({ timeout: 20_000 });
    // 胶片轨 = 当前成员会话全量轮（>1 轮即渲染，桶可点）
    await expect(detail.locator("[data-testid^='filmstrip-turn-']").first()).toBeVisible();
    // 走查钮（键盘 ←/→ 同款出口）
    await expect(page.getByTitle("上一轮（←）")).toBeVisible();
    await expect(page.getByTitle("下一轮（→）")).toBeVisible();
  });

  test("走查：下一轮 → 详情换轮（turnId 变化 + 胶片选中桶推进）", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    await run.expectTabActive("turns");

    const rows = page.locator("[data-turn-list] [data-turn-row]");
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    const detail = page.locator("[data-turn-detail]");
    await expect(detail).toBeVisible({ timeout: 20_000 });
    const before = await detail.getAttribute("data-turn-detail");

    await page.getByTitle("下一轮（→）").click();
    // 详情锚点即 turnId（data-turn-detail={turnId}）——换轮必然变值
    await expect
      .poll(async () => detail.getAttribute("data-turn-detail"))
      .not.toBe(before);
  });

  // 顶部时间线（执行时间线自 Perf 迁入）：真布局下的三条契约——刻度只为可视
  // 窗口生成（放大后不随跨度爆炸）、放大以播放头为锚（屏幕位置不漂）、
  // 单击即选中该刻的轮次（播放头 = 所选轮起点，落在落点左侧不远处）
  test("顶部时间线：刻度只随可视窗口、放大锚定播放头、单击落到该刻的轮次", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    await run.expectTabActive("turns");

    const timeline = page.locator("[data-turns-timeline]");
    const track = timeline.locator("[data-timeline-track]");
    await expect(track).toBeVisible();
    const band = timeline.locator("[data-selection-band]");
    const detail = page.locator("[data-turn-detail]");
    const ticks = timeline.locator("[data-axis-tick]");
    // 一屏最多 6 格 + 窗口外扩一格（不足 3 格时降一档步长，最多约 8 格）：与 run 的时间跨度无关
    expect(await ticks.count()).toBeLessThanOrEqual(11);
    // 道内不画竖向网格线：时间只看横坐标
    await expect(timeline.locator("[data-timeline-grid]")).toHaveCount(0);

    // 选列表中段的一轮 → 播放头立在它的起点（视野中部）
    const rows = page.locator("[data-turn-list] [data-turn-row]");
    await expect(rows.first()).toBeVisible();
    await rows.nth(Math.floor((await rows.count()) / 2)).click();
    await expect(detail).toBeVisible({ timeout: 20_000 });
    await expect(band).toBeAttached();
    // 首帧布局落定后轨道宽度会变一次（列表 / 详情面板就位）——选中层随之直接落位；
    // 先等它停稳再取锚点
    await expect
      .poll(async () => {
        const a = (await band.boundingBox())!.x;
        await page.waitForTimeout(120);
        return Math.abs((await band.boundingBox())!.x - a) < 0.01;
      })
      .toBe(true);
    // 可视宽度 = 滚动容器宽度（轨道在 1× 时与之等宽）
    const viewport = (await timeline.locator("[data-timeline-scroll]").boundingBox())!;
    const viewLeft = viewport.x;
    const viewWidth = viewport.width;
    const anchorBefore = (await band.boundingBox())!.x;
    expect(anchorBefore).toBeGreaterThan(viewLeft);
    expect(anchorBefore).toBeLessThan(viewLeft + viewWidth);

    // 放大 10 档到 1024×：每一步都以视野内的播放头为锚 → 屏幕位置不漂
    const zoomIn = timeline.getByRole("button", { name: "放大" });
    for (let i = 0; i < 10; i++) await zoomIn.click();
    await expect(timeline.locator("[data-zoom-value]")).toHaveText("1024×");
    const anchorAfter = (await band.boundingBox())!.x;
    expect(Math.abs(anchorAfter - anchorBefore)).toBeLessThan(8);
    // 刻度仍只为可视窗口生成（整段上有数千个刻度点，一个都不多画）
    expect(await ticks.count()).toBeLessThanOrEqual(11);
    expect(await ticks.count()).toBeGreaterThan(0);

    // 单击即跳的期望值不靠猜：从 /executions 取回逐轮区间，按「像素 → 时刻 →
    // 轮次」独立算一遍（落在区间内取该轮；空档取最近一轮，等距取前一轮），
    // 再与界面选中轮对比——点哪一刻就选中那一刻的轮次
    const execRes = await page.request.get(`/api/observe/run/${E2E_TOOL_RUN_ID}/executions`);
    expect(execRes.ok()).toBe(true);
    const items = ((await execRes.json()) as { items: Array<{ isSubagent: boolean; activeIntervals: Array<{ start: number; end: number; turnId?: string; hidden?: boolean }> }> }).items;
    const all = items.flatMap(a => a.activeIntervals);
    const startMs = Math.min(...all.map(iv => iv.start));
    const totalMs = Math.max(...all.map(iv => iv.end)) - startMs;
    const windows = (items.find(a => !a.isSubagent)!.activeIntervals ?? [])
      .filter(iv => iv.turnId && !iv.hidden)
      .sort((a, b) => a.start - b.start);
    expect(windows.length).toBeGreaterThan(1);

    const trackBox = (await track.boundingBox())!;
    const laneBox = (await timeline.locator("[data-timeline-track] [data-lane]").first().boundingBox())!;
    const clickX = viewLeft + viewWidth * 0.75;
    const clickMs = startMs + ((clickX - trackBox.x) / trackBox.width) * totalMs;
    const inside = windows.find(w => w.start <= clickMs && clickMs <= w.end);
    let expected: string | undefined = inside?.turnId;
    if (!expected) {
      const before = [...windows].reverse().find(w => w.end <= clickMs);
      const after = windows.find(w => w.start >= clickMs);
      const pick = !before ? after : !after ? before : clickMs - before.end <= after.start - clickMs ? before : after;
      expected = pick?.turnId;
    }
    expect(expected).toBeTruthy();

    await page.mouse.click(clickX, laneBox.y + laneBox.height / 2);
    // 选中轮 = 独立算出的那一轮；选中条起点 = 所选轮起点（落点在空档时取最近一轮，
    // 所以它可以在落点任一侧）——屏幕位置按轨道比例换算逐像素对上，且不出视野
    // （出视野即跟随滚动）。量的是选中条而非柔光：柔光在段两侧还各多 8px 渐隐
    const segment = timeline.locator("[data-selected-turn]");
    await expect(detail).toHaveAttribute("data-turn-detail", expected!, { timeout: 10_000 });
    const expectedStart = windows.find(w => w.turnId === expected)!.start;
    await expect
      .poll(async () => {
        const t = (await track.boundingBox())!;
        const x = (await segment.boundingBox())!.x;
        return Math.abs(x - (t.x + ((expectedStart - startMs) / totalMs) * t.width));
      }, { timeout: 5_000 })
      .toBeLessThan(2);
    const landed = (await segment.boundingBox())!.x;
    expect(landed).toBeGreaterThanOrEqual(viewLeft - 1);
    expect(landed).toBeLessThanOrEqual(viewLeft + viewWidth + 1);
  });

  // 选中效果 = 三层一体的「选中区间」：横贯所有道的淡色竖带（道区）+ 轴上的
  // 时刻牌（吸顶轴行）+ 只在所选轮所属的那根条子上套一圈选中环——不再是一根线。
  // 普通模式下鼠标停多久都不立游标线（只有测距模式才有瞄准线）
  test("顶部时间线：选中区间 = 竖带 + 时刻牌 + 所属条子的选中环；普通模式无游标线", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    await run.expectTabActive("turns");

    const timeline = page.locator("[data-turns-timeline]");
    const band = timeline.locator("[data-selection-band]");
    const chip = timeline.locator("[data-selection-pill]");
    const rows = page.locator("[data-turn-list] [data-turn-row]");
    await expect(rows.first()).toBeVisible();
    await rows.nth(Math.floor((await rows.count()) / 2)).click();
    await expect(page.locator("[data-turn-detail]")).toBeVisible({ timeout: 20_000 });

    // 竖带在道区、时刻牌在轴区，两者左缘对齐在所选轮起点；选中环恰好一个，
    // 落在 root 道里（列表选的是 root 轮；多成员 run 的 root 道 = 成员 taskId）
    await expect(band).toBeAttached();
    await expect(chip).toBeAttached();
    expect(await band.evaluate(el => el.closest("[data-timeline-track]") !== null)).toBe(true);
    expect(await chip.evaluate(el => el.closest("[data-timeline-axis]") !== null)).toBe(true);
    const ring = timeline.locator("[data-selected-turn]");
    await expect(ring).toHaveCount(1);
    const ringLane = await ring.evaluate(el => {
      const lane = el.closest("[data-lane]")!;
      return { key: lane.getAttribute("data-lane") ?? "", root: lane.className.includes("cursor-pointer") };
    });
    // root 道 = 'root'（单成员）或成员 taskId（多成员 run）
    expect(ringLane.root || ringLane.key === "root").toBe(true);
    // 等出现时的弹出动画走完再量几何（scale 进行中的包围盒不等于布局盒）
    const settled = () =>
      Promise.all([band, ring, chip].map(l => l.evaluate(el => el.getAnimations().every(a => a.playState !== "running"))))
        .then(flags => flags.every(Boolean));
    await expect.poll(settled).toBe(true);
    // 恒定宽度的细条：选中条 4px、柔光 20px；以柔光为主，选中条是柔光的实心核——
    // 两者左缘差 8px（半段渐隐）、条宽 = 光宽 − 16px
    expect((await ring.boundingBox())!.width).toBeCloseTo(4, 0);
    expect((await band.boundingBox())!.width).toBeCloseTo(20, 0);
    {
      const b = (await band.boundingBox())!;
      const r = (await ring.boundingBox())!;
      expect(Math.abs(r.x - (b.x + 8))).toBeLessThan(1.5);
      expect(Math.abs(r.width - (b.width - 16))).toBeLessThan(1.5);
    }
    // 时刻胶囊居中于区间起点（贴边时钳在轴内）——始终罩住起点
    await expect
      .poll(async () => {
        const b = (await band.boundingBox())!;
        const c = (await chip.boundingBox())!;
        return c.x - 1.5 <= b.x && b.x <= c.x + c.width + 1.5;
      })
      .toBe(true);
    // iOS 风格：只用填充不用描边；位移走 transform，过渡只动 transform / width / opacity
    expect(await chip.evaluate(el => getComputedStyle(el).boxShadow)).toBe("none");
    expect(await chip.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe("0px");
    expect(await chip.evaluate(el => getComputedStyle(el).transform)).toMatch(/^matrix\(1, 0, 0, 1, /);
    expect(await chip.evaluate(el => getComputedStyle(el).transitionProperty)).toContain("transform");
    expect(await chip.evaluate(el => getComputedStyle(el).transitionProperty)).not.toContain("left");
    expect(await band.evaluate(el => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");
    expect(await ring.evaluate(el => getComputedStyle(el).boxShadow)).not.toContain("0px 0px");
    // 竖带有可见宽度（所选轮的时长），不是一根线

    if (process.env.SHOT) {
      const tl = (await timeline.boundingBox())!;
      await page.screenshot({ path: "/tmp/opencode/v5-real.png", clip: { x: 0, y: tl.y - 4, width: 1440, height: Math.min(tl.height + 8, 420) } });
    }

    // 普通模式：鼠标在道上移动并停留 → 没有瞄准线/悬停时刻牌
    const laneBox = (await timeline.locator("[data-timeline-track] [data-lane]").first().boundingBox())!;
    await page.mouse.move(laneBox.x + laneBox.width * 0.8, laneBox.y + laneBox.height / 2, { steps: 6 });
    await page.mouse.down();
    await page.mouse.up();
    await expect(ring).toHaveCount(1);
    expect(await timeline.locator("[data-measure-cursor]").evaluate(el => getComputedStyle(el).opacity)).toBe("0");
    expect(await timeline.locator("[data-measure-cursor-time]").evaluate(el => getComputedStyle(el).opacity)).toBe("0");
    if (process.env.SHOT) {
      const tl = (await timeline.boundingBox())!;
      await page.screenshot({ path: "/tmp/opencode/v5-real-after-click.png", clip: { x: 0, y: tl.y - 4, width: 1440, height: Math.min(tl.height + 8, 420) } });
    }
  });

  // 版面：1× 没有横向滚动条；放大后吸底的自绘滚动条出现（始终在图区底部，
  // 不随纵向翻道滚走），拖滑块 / 滚轮都写道区 scrollLeft 这一个来源，轴区镜像
  test("顶部时间线：放大后吸底滚动条常驻，轴与道同步横滚", async ({ page }) => {
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_TOOL_RUN_ID, "tab=turns");
    await run.expectTabActive("turns");

    const timeline = page.locator("[data-turns-timeline]");
    const track = timeline.locator("[data-timeline-track]");
    await expect(track).toBeVisible();
    const box = timeline.locator("[data-timeline-vscroll]");
    const lanes = timeline.locator("[data-timeline-scroll]");
    const hscroll = timeline.locator("[data-timeline-hscroll]");
    const thumb = timeline.locator("[data-timeline-hscroll-thumb]");
    await expect(hscroll).toHaveCount(0);
    await expect(timeline.locator("[data-timeline-hscroll-thumb]")).toHaveCount(0);

    const zoomIn = timeline.getByRole("button", { name: "放大" });
    for (let i = 0; i < 4; i++) await zoomIn.click();
    await expect(timeline.locator("[data-zoom-value]")).toHaveText("16×");
    await expect(hscroll).toBeVisible();
    // 滚动条在纵向滚动容器里，底缘贴着图区底缘（吸底）
    expect(await hscroll.evaluate(el => el.closest("[data-timeline-vscroll]") !== null)).toBe(true);
    const boxRect = (await box.boundingBox())!;
    const hsRect = (await hscroll.boundingBox())!;
    expect(Math.abs(hsRect.y + hsRect.height + 6 - (boxRect.y + boxRect.height))).toBeLessThan(2);
    // 滚动条与道区同一横向范围（都在名列右侧）
    const lanesRect = (await lanes.boundingBox())!;
    expect(Math.abs(hsRect.x - lanesRect.x)).toBeLessThan(1.5);
    expect(Math.abs(hsRect.width - lanesRect.width)).toBeLessThan(1.5);
    // 道区不露出原生横向条（由这一条代替）
    expect(await lanes.evaluate(el => getComputedStyle(el).scrollbarWidth)).toBe("none");

    const readScroll = () => page.evaluate(() => ({
      lanes: document.querySelector<HTMLElement>("[data-timeline-scroll]")!.scrollLeft,
      axis: document.querySelector<HTMLElement>("[data-timeline-axis]")!.scrollLeft,
      thumb: document.querySelector<HTMLElement>("[data-timeline-hscroll-thumb]")!.style.transform,
    }));
    // 拖滑块：写道区 scrollLeft → 轴区镜像、滑块随动
    const before = await readScroll();
    const tb = (await thumb.boundingBox())!;
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2 + 120, tb.y + tb.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await readScroll()).lanes).toBeGreaterThan(before.lanes + 100);
    const dragged = await readScroll();
    expect(Math.abs(dragged.axis - dragged.lanes)).toBeLessThan(1.5);
    expect(dragged.thumb).not.toBe(before.thumb);
    if (process.env.SHOT) {
      const tl = (await timeline.boundingBox())!;
      await page.screenshot({ path: "/tmp/opencode/v5-zoom.png", clip: { x: 0, y: tl.y - 4, width: 1440, height: Math.min(tl.height + 8, 420) } });
    }
    // 滚轮在道区上横走时间轴（道不溢出纵向时不抢纵滚）
    const lr = (await lanes.boundingBox())!;
    await page.mouse.move(lr.x + lr.width / 2, lr.y + lr.height / 2);
    await page.mouse.wheel(0, 200);
    await expect.poll(async () => (await readScroll()).lanes).toBeGreaterThan(dragged.lanes);
    const wheeled = await readScroll();
    expect(Math.abs(wheeled.axis - wheeled.lanes)).toBeLessThan(1.5);
    // 缩回 1×：横向溢出消失，滚动条收起
    for (let i = 0; i < 4; i++) await timeline.getByRole("button", { name: "缩小" }).click();
    await expect(timeline.locator("[data-zoom-value]")).toHaveText("1×");
    await expect(hscroll).toHaveCount(0);
  });
});
