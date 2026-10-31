// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// bundle 仓内布局单点（叶子模块，server/client 共用——mirror/编排层同源，
// 禁止散落字面量）。
// 统一布局（目录即目录，按数据加载）：bundle 与会话同为目录资产，物理位置
// <范式>/<runId>/（上传自选目录，缺省根级）——无专区概念；历史专区
// opsbot-bundle/<runId>/ 由锚定规则同构识别，零数据迁移自然兼容。

/** bundle 锚定文件：目录直接含它即 bundle（列表/定位/迁移只认锚定目录）。 */
export const BUNDLE_MANIFEST_FILE = 'workflow.json';

/** opsbot 导出体检报告（可选，随行原样搬运）。 */
export const BUNDLE_REPORT_FILE = 'report.json';

/** lake 侧归属快照（cc-bundle-meta，x_lake 信封；上传时合成）。 */
export const BUNDLE_META_FILE = 'bundle.meta.json';
