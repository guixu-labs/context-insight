// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 下拉菜单（@base-ui/react Menu 封装，iOS 风格）：一枚轻悬浮的圆角面板，条目只有
// 标题一行（必要时右侧挂一个尾随元素，如进行中的转圈），高亮是条目自身的圆角
// 衬底。开合动效只动 transform 与 opacity（合成层属性，不触发布局与重绘），
// 从触发角起手缩放 + 淡入，时长 150ms、缓动取 iOS 面板的收尾曲线；用过渡而非
// 关键帧，快速反复开合时能从当前进度平滑折返。面板本体半透明 + 背景模糊
// （面积小，代价可忽略），不加整页遮罩——菜单是轻量操作，不该压暗工作区。

import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"

/** 开合动效：只动 transform 与 opacity；缩放锚点取 Base UI 给的触发角 */
const MOTION =
  "origin-(--transform-origin) transition-[transform,opacity] duration-150 ease-[cubic-bezier(0.32,0.72,0,1)] " +
  "data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 " +
  "motion-reduce:transition-none"

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  className,
  side = "bottom",
  align = "end",
  sideOffset = 6,
  ...props
}: MenuPrimitive.Popup.Props & {
  side?: MenuPrimitive.Positioner.Props["side"]
  align?: MenuPrimitive.Positioner.Props["align"]
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"]
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        data-slot="dropdown-menu-positioner"
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="z-50 outline-none"
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "min-w-44 rounded-xl border border-black/[0.06] bg-popover/80 p-1 text-popover-foreground shadow-[0_1px_1px_rgba(0,0,0,0.04),0_8px_24px_-6px_rgba(0,0,0,0.14),0_24px_48px_-12px_rgba(0,0,0,0.12)] outline-none backdrop-blur-xl supports-backdrop-filter:bg-popover/75 dark:border-white/[0.08] dark:shadow-[0_1px_1px_rgba(0,0,0,0.3),0_12px_32px_-8px_rgba(0,0,0,0.6)]",
            MOTION,
            className
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  trailing,
  children,
  ...props
}: MenuPrimitive.Item.Props & {
  /** 尾随元素（条目右端）：进行中的转圈、勾选标记一类，占位固定、不改行高 */
  trailing?: React.ReactNode
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "flex min-h-8 cursor-default items-center gap-6 rounded-lg px-3 py-1.5 text-[13px] leading-5 outline-none select-none transition-colors duration-100",
        "data-[highlighted]:bg-foreground/[0.06] dark:data-[highlighted]:bg-foreground/[0.1]",
        "data-[disabled]:cursor-default data-[disabled]:opacity-40",
        className
      )}
      {...props}
    >
      <span className="flex-1 whitespace-nowrap">{children}</span>
      {trailing ? <span className="-my-px flex shrink-0 items-center text-muted-foreground">{trailing}</span> : null}
    </MenuPrimitive.Item>
  )
}

function DropdownMenuSeparator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="dropdown-menu-separator"
      role="separator"
      className={cn("-mx-1 my-1 h-px bg-foreground/[0.06] dark:bg-white/[0.08]", className)}
      {...props}
    />
  )
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator }
