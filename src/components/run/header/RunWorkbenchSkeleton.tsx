// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See the LICENSE in the root of the software repository for the full text of the License.

"use client";

// Run 工作台加载态内容区骨架：首卡三区（身份 / 元信息网格 / 瓦片行）+ 双列
// 列表（Skills / Tool Calls），网格类与真实卡片一致——数据到达只有内容区
// 填充，无整页跳变。页头骨架不在此处（页头以真身作骨架，见 RunWorkbenchHeader）

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function RunWorkbenchSkeleton() {
  return (
    <>
      <Card className="animate-in fade-in slide-in-from-bottom-4 fill-mode-backwards overflow-hidden rounded-2xl ring-foreground/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_-24px_rgba(0,0,0,0.28)]">
        <CardContent className="px-5 pt-4 pb-4">
          <div className="divide-y divide-foreground/[0.06]" aria-hidden>
            <div className="pb-3.5">
              <div className="h-7 w-2/5 animate-pulse rounded-md bg-foreground/[0.08]" />
              <div className="mt-2.5 flex items-center gap-2">
                <span className="h-5 w-20 animate-pulse rounded-full bg-foreground/[0.06]" />
                <span className="h-5 w-12 animate-pulse rounded-full bg-foreground/[0.06]" style={{ animationDelay: "80ms" }} />
                <span className="h-4 w-36 animate-pulse rounded bg-foreground/[0.05]" style={{ animationDelay: "160ms" }} />
              </div>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-4 gap-y-3 py-3.5">
              {[0, 1, 2, 3].map(i => (
                <div key={i}>
                  <div className="h-2.5 w-8 animate-pulse rounded bg-foreground/[0.06]" />
                  <div className="mt-1.5 h-3.5 w-24 animate-pulse rounded bg-foreground/[0.08]" style={{ animationDelay: `${i * 80 + 60}ms` }} />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(104px,1fr))] gap-2 pt-3.5">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="rounded-xl bg-foreground/[0.04] px-2.5 py-2 dark:bg-foreground/[0.07]">
                  <div className="h-2.5 w-10 animate-pulse rounded bg-foreground/[0.07]" />
                  <div className="mt-1.5 h-5 w-12 animate-pulse rounded bg-foreground/[0.09]" style={{ animationDelay: `${i * 70}ms` }} />
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2" aria-hidden>
        {[0, 1].map(i => (
          <Card key={i} size="sm" className="rounded-2xl ring-foreground/[0.06]">
            <CardHeader>
              <CardTitle><span className="inline-block h-4 w-24 animate-pulse rounded bg-foreground/[0.08]" /></CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {Array.from({ length: 3 }, (_, j) => (
                <div key={j} className="flex items-center gap-3">
                  <span className="size-2 shrink-0 animate-pulse rounded-full bg-foreground/[0.08]" style={{ animationDelay: `${i * 60 + j * 120}ms` }} />
                  <span className="h-3.5 w-32 animate-pulse rounded-md bg-foreground/[0.08]" style={{ animationDelay: `${i * 60 + j * 120 + 80}ms` }} />
                  <span className="ml-auto h-3.5 w-10 animate-pulse rounded-md bg-foreground/[0.08]" style={{ animationDelay: `${i * 60 + j * 120 + 160}ms` }} />
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
      <span className="sr-only" role="status">加载 Run…</span>
    </>
  )
}
