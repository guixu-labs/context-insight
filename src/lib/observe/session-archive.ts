// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with
// the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 会话原始文件归档（zip）：把一个 run（solo 一行 / bundle 全员成员）在源端的
// 原件按原格式打成一个 zip。两步——
//   planSessionArchive  只看盘、不动盘：逐成员判「有原件出原件，没有出导出
//                       db」（判定单点 resolveSessionFiles），算出归档布局与
//                       清单。界面在用户点之前就能照实说「N 个会话按原文件、
//                       M 个以导出 db 代替」。
//   buildSessionArchive 落盘：原件逐文件流式入包（字节保真，已压缩形态原样
//                       STORE）；没有原件的成员现场导出该会话的 db 并压成 7z。
// 归档布局 = bundle 布局的会话段（sessions/<sid>/<sid>.jsonl + subagents/…）
// 加一份根级 export-manifest.json（记每个会话用的哪种载荷、每个文件的归档内路径）。
// 不做的事：不从库里的归一化数据反推 jsonl（有损）；不把 run 的 workflow.json
// 带进包（成员目录已重新安家，原清单的 location 对不上——带了会让人误以为
// 解压即可重导入）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportSessionRows } from '@/lib/ingest/export-service';
import { resolveSessionFiles, type SessionFilesAbsentReason } from '@/lib/ingest/session-files';
import { compressCaptureFile } from '@/lib/compression';
import { isSoloRunId } from '@/lib/run/identity';
import { readRun } from '@/lib/run/run-store';
import type { ObserveScope } from '@/lib/observe/scope';
import { exportStem, sanitizeExportSegment, type DbExportNameInput } from '@/lib/observe/export-name';
import { writeZip, zipMethodFor, type ZipSource } from '@/lib/zip-store';
import type { SessionFileRole } from '@/lib/ingest/adapters/contract';
import type { SessionArchiveKind } from '@/lib/observe/archive-plan';
import type { PrismaClient } from '@prisma/client';

/** 归档清单文件名（归档根）。不能叫 manifest.json / workflow.json——那是
 *  bundle 的锚文件名，出现在包根会让 bundle 导入与数据湖把它当 bundle。 */
export const SESSION_ARCHIVE_MANIFEST = 'export-manifest.json';
export const SESSION_ARCHIVE_FORMAT = 'session-archive';
export const SESSION_ARCHIVE_VERSION = 1;


export interface SessionArchiveFile {
  /** 归档内相对路径（posix） */
  path: string;
  role: SessionFileRole;
  bytes: number;
  /** 盘上原路径（db 载荷是现场生成，无原路径） */
  source: string | null;
}

export interface SessionArchiveMember {
  rowId: string;
  taskId: string;
  framework: string | null;
  version: string | null;
  /** 归档内会话目录（posix 相对）：sessions/<dirName> */
  dir: string;
  kind: SessionArchiveKind;
  /** kind=db 时：没有原件的原因 */
  absentReason: SessionFilesAbsentReason | null;
  files: SessionArchiveFile[];
}

export interface SessionArchivePlan {
  runId: string;
  solo: boolean;
  /** run 显示名（solo 取成员 taskId） */
  name: string;
  exportedAt: string;
  members: SessionArchiveMember[];
  /** 原件载荷的成员数 */
  originals: number;
  /** 导出 db 载荷的成员数 */
  dbs: number;
  /** 归档内文件总数（不含清单） */
  fileCount: number;
  /** 原件载荷的总字节（db 载荷现场生成，事前未知） */
  bytes: number;
}

/** 清单的落盘形态（随包分发；不含 rowId 这类库内主键）。 */
interface SessionArchiveManifest {
  format: typeof SESSION_ARCHIVE_FORMAT;
  version: typeof SESSION_ARCHIVE_VERSION;
  exportedAt: string;
  run: { id: string; kind: 'solo' | 'bundle'; name: string };
  sessions: Array<{
    taskId: string;
    framework: string | null;
    version: string | null;
    dir: string;
    kind: SessionArchiveKind;
    absentReason: SessionFilesAbsentReason | null;
    files: Array<{ path: string; role: SessionFileRole; bytes: number }>;
  }>;
}

/** 归档件文件名入参（export-name 单一源）：solo 用 taskId、bundle 用 run 名。 */
export function archiveNameInput(plan: SessionArchivePlan): DbExportNameInput {
  return plan.solo
    ? { solo: true, runId: plan.runId, taskId: plan.name }
    : { solo: false, runId: plan.runId, runName: plan.name };
}

export { summarizeSessionArchive, type SessionArchivePlanSummary } from '@/lib/observe/archive-plan';

export interface SessionArchiveBuild {
  path: string;
  bytes: number;
  entries: number;
}

export async function planSessionArchive(
  runId: string,
  scope: ObserveScope,
  prisma: PrismaClient,
): Promise<SessionArchivePlan> {
  const solo = isSoloRunId(runId);
  const stored = solo ? null : readRun(runId);
  const rows = await prisma.session.findMany({
    where: { id: { in: scope.members.map(m => m.rowId) } },
    select: { id: true, taskId: true, framework: true, version: true, sourcePath: true },
  });
  const byId = new Map(rows.map(row => [row.id, row] as const));

  const takenDirs = new Set<string>();
  const members: SessionArchiveMember[] = [];
  for (const ref of scope.members) {
    const row = byId.get(ref.rowId);
    // 任一行缺失整体失败：静默少一个成员的归档是数据丢失（与 exportSessionRows 同纪律）
    if (!row) throw new Error(`Session not found: "${ref.taskId}"`);
    // 同 sid 双记录（原生 + proxy 捕获共存）在一个 run 里是两行：目录名撞车时
    // 后到者带 framework 后缀，两份都保留
    const baseDir = sanitizeExportSegment(row.taskId);
    let dirName = baseDir;
    if (takenDirs.has(dirName)) dirName = `${baseDir}@${sanitizeExportSegment(row.framework ?? 'unknown')}`;
    takenDirs.add(dirName);
    const dir = path.posix.join('sessions', dirName);

    const resolved = resolveSessionFiles(row);
    if (resolved.kind === 'originals') {
      members.push({
        rowId: row.id,
        taskId: row.taskId,
        framework: row.framework,
        version: row.version,
        dir,
        kind: 'originals',
        absentReason: null,
        files: resolved.refs.map(ref => ({
          path: path.posix.join(dir, ref.relPath),
          role: ref.role,
          bytes: fs.statSync(ref.filePath).size,
          source: ref.filePath,
        })),
      });
      continue;
    }
    members.push({
      rowId: row.id,
      taskId: row.taskId,
      framework: row.framework,
      version: row.version,
      dir,
      kind: 'db',
      absentReason: resolved.reason,
      files: [{
        // 归档内名与单会话导出 db 件同名（exportStem：主干做文件系统安全收敛）
        path: path.posix.join(dir, `${exportStem({ solo: true, runId, taskId: row.taskId })}.db.7z`),
        role: 'main',
        bytes: 0,
        source: null,
      }],
    });
  }

  const originals = members.filter(m => m.kind === 'originals');
  return {
    runId,
    solo,
    name: solo ? scope.members[0]?.taskId ?? runId : stored?.manifest.name ?? runId,
    exportedAt: new Date().toISOString(),
    members,
    originals: originals.length,
    dbs: members.length - originals.length,
    fileCount: members.reduce((sum, m) => sum + m.files.length, 0),
    bytes: originals.reduce((sum, m) => sum + m.files.reduce((s, f) => s + f.bytes, 0), 0),
  };
}

function manifestOf(plan: SessionArchivePlan): SessionArchiveManifest {
  return {
    format: SESSION_ARCHIVE_FORMAT,
    version: SESSION_ARCHIVE_VERSION,
    exportedAt: plan.exportedAt,
    run: { id: plan.runId, kind: plan.solo ? 'solo' : 'bundle', name: plan.name },
    sessions: plan.members.map(member => ({
      taskId: member.taskId,
      framework: member.framework,
      version: member.version,
      dir: member.dir,
      kind: member.kind,
      absentReason: member.absentReason,
      // 清单随包分发：文件条目只留归档内路径 / 角色 / 字节数，不带盘上原路径
      // （source 会泄露用户 home 与工程目录结构，且对解压 / 重导入无意义）
      files: member.files.map(f => ({ path: f.path, role: f.role, bytes: f.bytes })),
    })),
  };
}

/** 落盘归档。返回临时 zip 路径——消费方读完自行删除。 */
export async function buildSessionArchive(plan: SessionArchivePlan, prisma?: PrismaClient): Promise<SessionArchiveBuild> {
  // db 载荷的现场导出件（导出 db → 7z）都落在这个工作目录，收尾整体清掉
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-archive-'));
  const zipPath = path.join(os.tmpdir(), `context_session_archive_${process.pid}-${Math.random().toString(36).slice(2, 10)}.zip`);
  try {
    const sources: ZipSource[] = [];
    for (const member of plan.members) {
      if (member.kind === 'originals') {
        for (const file of member.files) {
          const source = file.source as string;
          const stat = fs.statSync(source);
          file.bytes = stat.size;
          sources.push({
            kind: 'stream',
            path: file.path,
            size: stat.size,
            method: zipMethodFor(source),
            mtime: stat.mtime,
            open: () => fs.createReadStream(source, { highWaterMark: 1 << 20 }),
          });
        }
        continue;
      }
      // db 载荷：导出该成员一行 → 7z。导出件先按归档内名（去掉 .7z）落到工作
      // 目录再压：7z 内的成员名即 db 文件名，解压即得可直接导入的导出件
      const archiveMember = member.files[0];
      // 暂存名取归档内相对路径（含已消歧的目录段）：同 taskId 双记录都走 db
      // 载荷时，basename 只到导出件主干（不含 @framework 后缀）会撞车、后写覆盖
      // 先写，两个条目装同一份数据。按归档相对段落地让它们各落在自己的 <dirName>/ 下
      const dbRel = archiveMember.path.replace(/\.7z$/, '');
      const dbPath = path.join(workDir, ...dbRel.split('/'));
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      await exportSessionRows([member.rowId], dbPath, prisma);
      const archive = compressCaptureFile(dbPath);
      const stat = fs.statSync(archive);
      archiveMember.bytes = stat.size;
      sources.push({
        kind: 'stream',
        path: archiveMember.path,
        size: stat.size,
        method: 'store',
        mtime: stat.mtime,
        open: () => fs.createReadStream(archive, { highWaterMark: 1 << 20 }),
      });
    }

    // 清单最后定稿：db 载荷的字节数此刻才已知。清单排在包首，解压即见
    sources.unshift({
      kind: 'bytes',
      path: SESSION_ARCHIVE_MANIFEST,
      data: new TextEncoder().encode(JSON.stringify(manifestOf(plan), null, 2) + '\n'),
    });

    const written = await new Promise<{ bytes: number; entries: number }>((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      out.on('error', reject);
      writeZip(sources, out).then(
        result => out.end(() => resolve(result)),
        error => {
          out.destroy();
          reject(error);
        },
      );
    });
    return { path: zipPath, bytes: written.bytes, entries: written.entries };
  } catch (error) {
    try { fs.rmSync(zipPath, { force: true }); } catch { /* best-effort */ }
    throw error;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
