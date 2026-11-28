// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { Page } from "@playwright/test";

/** headless Chromium 带 showSaveFilePicker，但无用户手势时以 AbortError 拒
 *  绝——落盘单点（saveBlob）对 AbortError 静默收场（真实用户取消保存对话框
 *  的同款路径），测试就永远等不到 download 事件。测试环境剥掉该 API，让导出
 *  走应用自带的 fallbackDownload（Blob 锚点下载——Firefox/Safari 同款生产
 *  路径，Playwright 可捕获）。 */
export async function stripFilePicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).showSaveFilePicker = undefined;
  });
}
