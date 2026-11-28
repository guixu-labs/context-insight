// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See the LICENSE in the root of the software repository for the full text of the License.

"use client";

// 品牌区（导航栏左段）：渐变图标 + 双色字标 + 版本，点击回工作台首页。
// responsive：所在的 @container 窄于 1100px 时只留图标，字标与版本让位给
// 同行导航（阈值与字标 / 版本的容器查询类同写在此处，改一处）。

import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { BRAND_NAME } from "@/lib/branding";
import { VERSION_DISPLAY } from "@/lib/version";

export function BrandLockup({ responsive = false }: { responsive?: boolean }) {
  return (
    <Link
      href="/"
      className="flex min-w-0 shrink-0 items-center gap-2 rounded-full py-0.5 pl-0.5 pr-3 transition-colors hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.08]"
      title={`${BRAND_NAME} · 回到工作台`}
    >
      <BrandMark />
      <span
        data-brand-wordmark
        className={`${responsive ? "hidden @min-[1100px]:flex" : "flex"} items-baseline gap-1 tracking-tight`}
      >
        <span className="text-sm font-bold">Context</span>
        <span className="text-sm font-semibold text-muted-foreground">Insight</span>
      </span>
      <span
        data-brand-version
        className={`${responsive ? "hidden @min-[1100px]:inline" : "inline"} rounded-full bg-foreground/[0.05] px-1.5 py-px font-mono text-[9.5px] font-medium text-muted-foreground`}
      >
        {VERSION_DISPLAY}
      </span>
    </Link>
  );
}
