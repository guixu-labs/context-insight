// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// the CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话导出件文件名的单一源：SQLite 导出（export-db 端点 content-disposition、
// 工作台导出钮下载落盘名的回落值、CLI `ctxi export` 缺省输出名）与原始文件
// 归档（export-archive 端点 / 工作台 / CLI `ctxi export --archive`）共用。
// 前缀 context_session_ 是导入侧的前缀嗅探信号（adapters/registry 的
// context-insight 源；cannbot 变体打包期整体翻转）——不随 run 形态变，变的只
// 是主干：solo 用会话口径（taskId），bundle 用 run 身份（run_<name>）。主干做
// 文件系统安全字符收敛；响应头另有 ASCII 折叠 + RFC 5987 的 filename*（中文
// run 名进不了 ISO-8859-1 响应头）。
// 归档件沿用同一主干与前缀、只换扩展名：与同一次导出的 db 件并排落地时
// 一眼对得上是同一个 run。

const UNSAFE_FILENAME_RE = /[\\/:*?"<>|\s]+/g;
const NON_ASCII_RE = /[^\x20-\x7e]/g;

export const DB_EXPORT_PREFIX = 'context_session_';

/** 把任意外部字符串收敛成单个文件系统安全段：路径分隔符 / 保留字 / 空白折叠成
 *  '_'，'.' 与 '..' 这类会破坏相对路径的段吞成 '_'。导出件文件名主干与归档内
 *  目录名共用——目录名直接来自 taskId，含 '/' 或 '..' 时拼进 zip 条目会在解压时
 *  逃出根目录（zip-slip）。 */
export function sanitizeExportSegment(value: string): string {
  const folded = String(value).replace(UNSAFE_FILENAME_RE, '_');
  return folded === '.' || folded === '..' ? '_' : folded;
}

export interface DbExportNameInput {
  solo: boolean;
  runId: string;
  /** solo 成员任务 id（bundle 忽略） */
  taskId?: string | null;
  /** bundle run 显示名（solo 忽略） */
  runName?: string | null;
}

/** 导出件主干（不含扩展名）：<前缀><solo: taskId | bundle: run_<name>> */
export function exportStem(opts: DbExportNameInput): string {
  const nameBase = opts.solo ? opts.taskId ?? opts.runId : `run_${opts.runName ?? opts.runId}`;
  return `${DB_EXPORT_PREFIX}${sanitizeExportSegment(nameBase)}`;
}

export function dbExportFileName(opts: DbExportNameInput): string {
  return `${exportStem(opts)}.db`;
}

/** 原始文件归档（zip）文件名 */
export function archiveExportFileName(opts: DbExportNameInput): string {
  return `${exportStem(opts)}.zip`;
}

/** attachment 响应头：filename= ASCII 折叠名（老客户端）+ filename*= UTF-8 原名
 *  （标准客户端优先取它）。 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(NON_ASCII_RE, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function dbExportContentDisposition(opts: DbExportNameInput): string {
  return contentDisposition(dbExportFileName(opts));
}

export function archiveExportContentDisposition(opts: DbExportNameInput): string {
  return contentDisposition(archiveExportFileName(opts));
}
