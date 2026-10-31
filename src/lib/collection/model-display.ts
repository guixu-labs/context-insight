// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

/** 展示口径模型名：去 provider 前缀（volc-gateway/deepseek-v4-pro → deepseek-v4-pro）。
 *  原始值保留在数据层（Session.model 不动），展示与 run 行模型分布在此归一。 */
export function displayModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const idx = model.indexOf('/');
  return idx >= 0 && idx < model.length - 1 ? model.slice(idx + 1) : model;
}
