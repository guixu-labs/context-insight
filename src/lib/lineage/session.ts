// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { checkImportablePath } from '@/lib/ingest/import-paths';
import { agentFrameworkOf, isProxyVersion } from '@/lib/shared/session-format';
import { VERSION } from '@/lib/version';
import { coreConfig, coreJson, LineageError } from '@/lib/lineage/client';

type Source = { id: string; sha256: string; format: string; size_bytes: number };
type Snapshot = { id: string; run_id: string; completeness: string; context: unknown; sources: Source[] };

export async function freezeInsightSession(sessionId: string, signal: AbortSignal) {
  coreConfig();
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) throw new LineageError('SESSION_NOT_FOUND', 'Insight session not found', 404);
  const framework = agentFrameworkOf(session.framework);
  if (isProxyVersion(session.version) || session.framework !== framework || !['claude-code', 'codex'].includes(framework ?? '')) {
    throw new LineageError('UNSUPPORTED_SOURCE', 'Session binding currently supports native Claude/Codex JSONL only; proxy captures are not native evidence', 422);
  }
  if (!session.sourcePath || !session.sourcePath.endsWith('.jsonl')) {
    throw new LineageError('SOURCE_UNAVAILABLE', 'A registered plaintext JSONL file is required; use explicit Core source uploads for other material layouts', 422);
  }
  if (!checkImportablePath(session.sourcePath).ok) throw new LineageError('SOURCE_FORBIDDEN', 'Source is outside configured import roots', 403);
  const file = await open(session.sourcePath, 'r').catch(() => {
    throw new LineageError('SOURCE_UNAVAILABLE', 'Registered source cannot be opened', 404);
  });
  let raw: Buffer;
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new LineageError('SOURCE_UNAVAILABLE', 'Registered source must be a file', 422);
    if (before.size > 64 * 1024 * 1024) throw new LineageError('BODY_TOO_LARGE', 'Core source limit is 64 MiB', 413);
    raw = Buffer.alloc(before.size);
    let position = 0;
    while (position < raw.length) {
      const { bytesRead } = await file.read(raw, position, raw.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    const after = await file.stat();
    if (position !== raw.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new LineageError('SOURCE_CHANGED', 'Source changed during read; retry after capture settles or use Core live append', 409);
    }
  } finally { await file.close(); }
  signal.throwIfAborted();
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const format = framework === 'codex' ? 'codex' : 'claude';
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const run = await coreJson<{ id: string }>('/v1/runs', json({
    external_key: JSON.stringify(['context-insight', session.framework, session.taskId]),
    project_id: process.env.AGENTLINEAGE_PROJECT_ID ?? 'context-insight',
  }));
  const source = await coreJson<Source>(`/v1/sources?name=${format}.jsonl&format=${format}`, {
    method: 'POST', body: new Uint8Array(raw), signal, headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (source.sha256 !== sha256) throw new LineageError('SOURCE_DIGEST_MISMATCH', 'Core returned a different source digest', 502);
  const binding = {
    contract: 'context-insight.lineage-binding/v1', session_id: session.id, task_id: session.taskId,
    framework: session.framework, source_version: session.version, insight_version: VERSION,
    insight_updated_at: session.updatedAt.toISOString(), source_sha256: sha256,
    projection_alignment: 'unverified', semantic_verified: false,
  };
  const snapshot = await coreJson<Snapshot>(`/v1/runs/${run.id}/snapshots`, json({
    source_ids: [source.id], context: { insight: binding },
    gaps: [{ code: 'primary-source-only', message: 'Only the registered primary source is frozen; child sources and Insight projection alignment are not established' }],
  }));
  return { binding, run_id: run.id, source, snapshot,
    observations_url: `/api/lineage/core/v1/snapshots/${snapshot.id}/observations`,
    snapshot_url: `/api/lineage/core/v1/snapshots/${snapshot.id}`,
  };
}
