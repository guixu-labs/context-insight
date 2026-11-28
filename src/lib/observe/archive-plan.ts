// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 归档计划的对外形态（纯函数、零 Node 依赖）：装配在 observe/session-archive
// （服务端，带 sqlite / prisma）。保持零 Node 依赖：本形态是 plan 端点的响应体，
// 任何一侧（含客户端组件）都能引它的类型而不把装配链拖进浏览器包。

import type { SessionFilesAbsentReason } from '@/lib/ingest/session-files';
import type { SessionArchivePlan } from '@/lib/observe/session-archive';

/** 一个会话在归档里的载荷：originals = 源端原件原样；db = 导出 db（7z）代替 */
export type SessionArchiveKind = 'originals' | 'db';

/** 归档计划的对外形态（plan 端点 / 界面提示用）：不含库内主键与原路径。 */
export interface SessionArchivePlanSummary {
  runId: string;
  solo: boolean;
  name: string;
  originals: number;
  dbs: number;
  fileCount: number;
  bytes: number;
  members: Array<{
    taskId: string;
    framework: string | null;
    kind: SessionArchiveKind;
    absentReason: SessionFilesAbsentReason | null;
    fileCount: number;
  }>;
}

export function summarizeSessionArchive(plan: SessionArchivePlan): SessionArchivePlanSummary {
  return {
    runId: plan.runId,
    solo: plan.solo,
    name: plan.name,
    originals: plan.originals,
    dbs: plan.dbs,
    fileCount: plan.fileCount,
    bytes: plan.bytes,
    members: plan.members.map(member => ({
      taskId: member.taskId,
      framework: member.framework,
      kind: member.kind,
      absentReason: member.absentReason,
      fileCount: member.files.length,
    })),
  };
}
