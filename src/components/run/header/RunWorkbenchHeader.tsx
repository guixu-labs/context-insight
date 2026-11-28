// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See the LICENSE in the root of the software repository for the full text of the License.

"use client";

// Run 工作台页头 = 单行应用栏，三段同排，tab 导航居页头正中：
//   [返回 · 品牌]（左翼） [tab 导航]（中段，按内容宽度） [同步 chip · 动作簇]（右翼）
// 居中不靠中段 margin auto（那只会在两翼之间的空隙里居中——右翼 chip 一出
// 现 tab 条就横移），而是两翼等权（flex: 1 1 0）平分「页头宽 − 中段宽」，中段
// 即落在页头正中，右翼内容增减不牵动 tab 条位置；某一翼内容超出自己那半份
// 时（下限 = 自身内容宽），中段才向另一侧让位。
// 页面三个状态共用本组件，chrome 即时成型：加载态 = 返回 + 品牌 + tab 条
// （pending：真身作骨架）+ 动作占位；错误态 = 仅品牌（错误卡自带返回 / 重试）；
// 就绪态 = 全量。本组件是 @container：同排各件按页头自身宽度（而非视口）
// 决定密度，让位顺序 = 动作文字 → 品牌字标 + 紧凑间距（< 1100px：图标钮
// 与两翼留白各收一档，1024 宽的 9 个 tab 才放得下）→ tab 条横滚。导航是
// 页头主职能，让位顺序不可倒。

import type { ReactNode } from "react";
import { BrandLockup } from "@/components/BrandLockup";
import { RunTabBar, type RunTabBarProps } from "@/components/run/RunTabBar";
import { RunBackButton } from "@/components/run/header/RunBackButton";

/** 右区密度的单点：页头（@container）宽于 1420px 时同步 chip 与上传钮显示
 *  文字，窄于此只留图标——空间让给同行 tab 导航（动作文字是次职能）。阈值
 *  按「右翼全文字（含同步 chip ≈ 334px）不超出自己那半份」定：tab 条 752px
 *  时半份 = (页头 − 752) / 2 ≥ 334 → 页头 ≥ 1420。Tailwind 类名须是完整
 *  字面量，三处同写一个阈值，改一并改 */
export const HEADER_TEXT_SHOW = "hidden @min-[1420px]:inline";
export const HEADER_UPLOAD_PADDING = "px-2 @min-[1420px]:px-3.5";
/** 仅加载态占位用：上传钮紧凑态 / 全文字态的宽度 */
export const HEADER_UPLOAD_WIDTH = "w-[30px] @min-[1420px]:w-36";

export interface RunWorkbenchHeaderProps {
  /** 返回钮（回退上一个工作台动作，栈空离页）；null = 不放 */
  back: { canBack: boolean; onBack: () => void } | null
  /** tab 导航；null = 不放 */
  nav: RunTabBarProps | null
  /** 右区动作（就绪态） */
  actions?: ReactNode
  /** 加载态右区：动作要等 run 详情才知道（solo / bundle 决定上传文案与
   *  可用动作），先按真实形状给占位 */
  actionsPending?: boolean
}

export function RunWorkbenchHeader({ back, nav, actions, actionsPending = false }: RunWorkbenchHeaderProps) {
  return (
    <header
      data-run-header
      className="@container flex shrink-0 animate-in fade-in slide-in-from-top-2 items-center duration-300"
    >
      {/* 两翼 flex: 1 1 0（平分剩余空间）、下限 = 自身内容宽（min-w-max）；中段
          按内容宽度、放不下才收缩（min-w-0）→ 轨道横滚 */}
      <div data-run-header-zone="leading" className="flex min-w-max flex-1 items-center gap-1 pr-3 @max-[1100px]:pr-2">
        {back ? <RunBackButton canBack={back.canBack} onBack={back.onBack} /> : null}
        <BrandLockup responsive />
      </div>
      {nav ? (
        <div data-run-header-zone="nav" className="min-w-0">
          <RunTabBar {...nav} />
        </div>
      ) : null}
      <div
        data-run-header-zone="actions"
        className="flex min-w-max flex-1 items-center justify-end gap-1.5 pl-3 @max-[1100px]:pl-2"
        aria-hidden={actionsPending || undefined}
      >
        {actionsPending ? (
          // 占位按右区同一密度规则取宽（紧凑态纯图标 / 宽态带文字）：tab 条
          // 在加载态与就绪态同在页头正中，数据到达 tab 条不动
          <>
            <div className="h-9 w-24 animate-pulse rounded-full bg-foreground/[0.04] dark:bg-foreground/[0.08]" />
            <div
              className={`h-9 animate-pulse rounded-full bg-foreground/[0.05] dark:bg-foreground/[0.09] ${HEADER_UPLOAD_WIDTH}`}
              style={{ animationDelay: "120ms" }}
            />
          </>
        ) : (
          // 右翼恒在（离线档案没有动作 = 空翼）：它是与左翼配平的另一半
          actions
        )}
      </div>
    </header>
  )
}

/** 工作台外壳：页头 + 内容区（视口即应用——整窗不滚，面板各自滚动）。页面
 *  三态（加载 / 错误 / 就绪）同一外壳，差异只在传进来的页头与内容 */
export function RunWorkbenchShell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <main className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        {header}
        {children}
      </main>
    </div>
  )
}
