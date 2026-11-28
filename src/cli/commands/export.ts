// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { Command } from 'commander';
import { InsightClient } from '../client';
import { formatHeader, formatDivider, formatSuccess, formatWarning, theme } from '../utils/colors';
import path from 'node:path';
import { archiveExportFileName, dbExportFileName } from '@/lib/observe/export-name';
import { soloRunIdOf } from '@/lib/run/identity';

export function exportCommand(): Command {
  const cmd = new Command('export');
  cmd
    .description('Export session: standalone SQLite database (default, re-importable) or original source files as a zip (--archive)')
    .option('--session <taskId>', 'Session taskId to export')
    .option('--archive', 'Export the session\'s original source files (incl. subagents) as a zip instead of the SQLite database')
    .option('--output <path>', 'Output file path (default: ./context_session_<taskId>.db | .zip)')
    .option('--json', 'Output result as JSON')
    .action(async (opts, command) => {
      const globalOpts = command.parent?.opts() ?? {};
      const client = new InsightClient(globalOpts.server, {
        timeout: +globalOpts.timeout,
      });

      if (!opts.session) {
        console.error(formatWarning('Error: --session <taskId> is required'));
        process.exit(1);
      }

      const taskId = opts.session;
      const archive = Boolean(opts.archive);
      // 缺省输出名与工作台导出菜单同源（export-name 单一源）
      const nameInput = { solo: true, runId: soloRunIdOf(taskId), taskId };
      const outputPath = opts.output ?? path.join(process.cwd(), archive ? archiveExportFileName(nameInput) : dbExportFileName(nameInput));

      if (!opts.json) {
        console.log(formatHeader(`Export Session${archive ? ' (original files)' : ''}: ${taskId}`));
        console.log(formatDivider());
      }

      const result = archive
        ? await client.exportSessionArchive(taskId, outputPath)
        : await client.exportSession(taskId, outputPath);

      if (opts.json) {
        console.log(JSON.stringify({ taskId, kind: archive ? 'archive' : 'db', filePath: outputPath, size: result.size }, null, 2));
        return;
      }

      console.log(formatSuccess(`✓ Exported session ${taskId} → ${outputPath}`));
      console.log(theme.muted(`  File size: ${result.size} bytes`));
      if (archive) {
        console.log(theme.muted('  包内 export-manifest.json 记录每个会话用的是原文件还是导出 db'));
      }
    });

  return cmd;
}
