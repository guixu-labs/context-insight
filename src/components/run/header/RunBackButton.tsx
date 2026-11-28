// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See the LICENSE in the root of the software repository for the full text of the License.

"use client";

// 返回钮（页头最左，与品牌、tab 导航同行）：圆头 chevron，工作台内有可回退
// 历史时亮出残影双 chevron（可达性反馈），悬停轻推、按压回缩——纯 CSS
// transform/opacity，动效零 JS

export function RunBackButton({ canBack, onBack }: { canBack: boolean; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      title="返回上一步"
      className="group flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition hover:bg-foreground/[0.06] hover:text-foreground active:scale-90 dark:hover:bg-foreground/[0.12]"
    >
      <svg
        viewBox="0 0 20 16"
        className="h-4 w-5 shrink-0 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:-translate-x-0.5"
        aria-hidden
      >
        <path d="M8 2.5 3 8l5 5.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <path
          d="M15 2.5 10 8l5 5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={canBack ? 0.32 : 0}
          className="transition-opacity duration-300"
        />
      </svg>
    </button>
  );
}
