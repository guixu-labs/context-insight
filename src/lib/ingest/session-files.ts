// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 会话原始文件集解析：已落库会话行 → 「这个会话在源端的原件还在不在、是哪些
// 文件」。规则一句话——有原件出原件，没有出导出 db；「没有」的原因分三种，
// 消费方（归档清单 / 界面提示）照实转述，不猜不补。
// 发现规则不在本模块：各源在 SourceDescriptor.listSessionFiles 自持，这里只做
// 路由（sourceOfSessionRow 格式轴单点）与判定。

import { sourceOfSessionRow } from './adapters/registry';
import type { SessionFileRef } from './adapters/contract';

/** 「没有原件」的原因 */
export type SessionFilesAbsentReason =
  /** 会话行没有 sourcePath（落库时就没有源文件可指） */
  | 'no-source-path'
  /** 源是共享容器（opencode 原生的 opencode.db：全体会话一个库，拆不出单会话原件） */
  | 'no-per-session-files'
  /** 有会话级原件，但主文件已不在盘上（被删 / 被移 / 换了机器） */
  | 'source-missing';

export type SessionFilesResolution =
  | { kind: 'originals'; refs: SessionFileRef[] }
  | { kind: 'none'; reason: SessionFilesAbsentReason };

export interface SessionFilesSubject {
  taskId: string;
  sourcePath: string | null;
  framework: string | null;
  version: string | null;
}

export function resolveSessionFiles(session: SessionFilesSubject): SessionFilesResolution {
  if (!session.sourcePath) return { kind: 'none', reason: 'no-source-path' };
  const source = sourceOfSessionRow(session);
  // 路由不出源（framework 无适配器）与共享容器同义：都没有会话级原件可列
  if (!source?.listSessionFiles) return { kind: 'none', reason: 'no-per-session-files' };
  const refs = source.listSessionFiles(session.sourcePath, session.taskId) ?? [];
  // 主文件在才算「原件还在」：只剩伴随件（meta / 子代理）的残局拼不回会话
  if (!refs.some(ref => ref.role === 'main')) return { kind: 'none', reason: 'source-missing' };
  return { kind: 'originals', refs };
}
