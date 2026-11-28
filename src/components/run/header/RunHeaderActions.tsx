// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

"use client";

// Run 工作台页头右翼的内容（单行应用栏的右段）：同步态 chip + 图标动作组（刷新 /
// 导出菜单）+ 上传主操作。导出是一个菜单、若干条目（SQLite 数据库 / 原始文件
// zip / Markdown / 离线 HTML）——同一件事的四种产物收在一个入口里，页头只占
// 一个图标钮的位置。条目只有标题一行，不挂副标题（小字多了显得乱）；进行中
// 的那一条标题转灰、右端挂转圈。动作在不在场由入参决定（null / 空数组 = 不渲染）：离线
// 档案没有服务端协作动作，MD 导出 solo 专属——本组件不读宿主能力，只按入参摆。
// 全空即整个右区不渲染，空间归 tab 导航。
// 密度：本区挂在页头的 @container 里，页头宽度不足时逐级让位——先是文字：
// chip 与上传钮收成纯图标（全称进 title / aria-label）；再是间距：页头窄于
// 1100px（与品牌字标收起同档）图标钮 28→24、组内边距与钮距收一档。两级
// 都是给同行 tab 导航让路——导航是页头主职能，动作文字与间距是次职能。
// 阈值是 Tailwind 类名字面量：文字档单点在 RunWorkbenchHeader（HEADER_*），
// 间距档在本文件 ICON_BUTTON / 组容器与页头两翼内边距同写 1100，改一并改。

import { DownloadIcon, Loader2Icon, RefreshCwIcon, UploadIcon, WifiIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { HEADER_TEXT_SHOW, HEADER_UPLOAD_PADDING } from "@/components/run/header/RunWorkbenchHeader";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** 同步态（页头刷新钮与 chip 的共同驱动）：idle = 手动刷新；auto = 自动同步
 *  已开启（源有新数据时增量导入）；syncing = 正在同步 */
export type RunSyncState = "idle" | "auto" | "syncing";

/** 导出菜单的一个条目 */
export interface RunExportItem {
  /** 稳定锚点（data-run-export），测试与埋点用 */
  id: "sqlite" | "archive" | "markdown" | "html";
  label: string;
  pending: boolean;
  onExport: () => void;
}

export interface RunHeaderActionsProps {
  /** 刷新能力；null = 不提供（离线档案） */
  refresh: { sync: RunSyncState; enabled: boolean; onRefresh: () => void } | null;
  /** 导出菜单条目（按传入顺序排列）；null / 空 = 不提供导出 */
  exports: RunExportItem[] | null;
  /** 上传数据仓主操作；null = 不提供 */
  upload: { label: string; disabled: boolean; onOpen: () => void } | null;
}

const ICON_BUTTON =
  "flex size-7 @max-[1100px]:size-6 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-foreground/[0.06] disabled:cursor-default disabled:opacity-45 dark:hover:bg-foreground/[0.12]";

export function RunHeaderActions({ refresh, exports, upload }: RunHeaderActionsProps) {
  if (!refresh && !(exports && exports.length > 0) && !upload) return null;
  const sync = refresh?.sync ?? "idle";
  const exporting = exports?.some(item => item.pending) ?? false;
  return (
    <div data-run-header-actions className="flex shrink-0 items-center gap-1.5 @max-[1100px]:gap-1">
      {sync !== "idle" ? (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium",
            sync === "syncing"
              ? "bg-blue-500/[0.08] text-blue-600 dark:bg-blue-500/[0.14] dark:text-blue-400"
              : "bg-emerald-500/[0.08] text-emerald-600 dark:bg-emerald-500/[0.14] dark:text-emerald-400",
          )}
          title={sync === "syncing" ? "同步中…" : "自动同步已开启：源有新数据时自动增量导入"}
        >
          {sync === "syncing" ? <Loader2Icon className="size-3 animate-spin" /> : <WifiIcon className="size-3" />}
          <span className={HEADER_TEXT_SHOW}>{sync === "syncing" ? "同步中…" : "自动同步"}</span>
        </span>
      ) : null}
      {refresh || (exports && exports.length > 0) ? (
        <div className="flex items-center gap-0.5 rounded-full bg-foreground/[0.04] p-1 @max-[1100px]:p-0.5 dark:bg-foreground/[0.08]">
          {refresh ? (
            <button
              type="button"
              className={ICON_BUTTON}
              onClick={refresh.onRefresh}
              disabled={sync === "syncing" || !refresh.enabled}
              title={sync === "syncing" ? "同步中…" : sync === "auto" ? "自动同步已开启 · 点击立即刷新" : "立即刷新"}
            >
              {sync === "syncing" ? (
                <Loader2Icon className="size-3.5 animate-spin text-blue-500" />
              ) : sync === "auto" ? (
                <span className="relative flex size-3.5 items-center justify-center text-emerald-500 dark:text-emerald-400">
                  <WifiIcon className="size-3.5" />
                  <span className="absolute -right-0.5 -top-0.5 size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
                </span>
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
            </button>
          ) : null}
          {exports && exports.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                data-run-export-trigger
                className={ICON_BUTTON}
                disabled={exporting}
                title="导出"
                aria-label="导出"
              >
                {exporting ? <Loader2Icon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5" />}
              </DropdownMenuTrigger>
              <DropdownMenuContent aria-label="导出">
                {exports.map(item => (
                  <DropdownMenuItem
                    key={item.id}
                    data-run-export={item.id}
                    onClick={item.onExport}
                    disabled={item.pending}
                    className={item.pending ? "data-[disabled]:opacity-100 [&>span:first-child]:text-muted-foreground" : undefined}
                    trailing={item.pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
      {upload ? (
        <button
          type="button"
          className={cn(
            "flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-foreground text-xs font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-45",
            HEADER_UPLOAD_PADDING,
          )}
          onClick={upload.onOpen}
          disabled={upload.disabled}
          title={upload.label}
          aria-label={upload.label}
        >
          <UploadIcon className="size-3.5" />
          <span className={cn("whitespace-nowrap", HEADER_TEXT_SHOW)}>{upload.label}</span>
        </button>
      ) : null}
    </div>
  );
}
