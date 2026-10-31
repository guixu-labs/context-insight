// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// AssetKind 注册表（design: docs/design/unified-workbench/design.md §2）。
// 统一导入/上传的 kind 分发事实单点：新资产类型 = 描述符一行 + 向导/上传
// 分支，列表能力在 list-service（list/remove），导入/上传端点在此。

import type { AssetKind } from './types';

export interface AssetKindDescriptor {
  kind: AssetKind;
  label: string;
  /** 数据仓列表 action（/api/ingest/lake）：会话 = list，run = bundle-list */
  lakeListAction: 'list' | 'bundle-list';
  /** 数据仓上传 action（/api/ingest/lake）：会话 = upload，run = bundle-upload */
  lakeUploadAction: 'upload' | 'bundle-upload';
  /** 本地导入端点：会话走伞形 import-file，run 走 job 化 import-bundle */
  localImportEndpoint: '/api/ingest/import-file' | '/api/ingest/import-bundle';
}

export const ASSET_KINDS: Record<AssetKind, AssetKindDescriptor> = {
  session: {
    kind: 'session',
    label: '会话',
    lakeListAction: 'list',
    lakeUploadAction: 'upload',
    localImportEndpoint: '/api/ingest/import-file',
  },
  run: {
    kind: 'run',
    label: 'Run',
    lakeListAction: 'bundle-list',
    lakeUploadAction: 'bundle-upload',
    localImportEndpoint: '/api/ingest/import-bundle',
  },
};
