// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

export class LineageError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export function lineageError(error: unknown): Response {
  const failure = error instanceof Error && error.name === 'AbortError'
    ? new LineageError('LINEAGE_CANCELLED', 'Request was cancelled', 499)
    : error;
  const known = failure instanceof LineageError;
  return Response.json({ error: {
    code: known ? failure.code : 'LINEAGE_INTERNAL_ERROR',
    message: known ? failure.message : 'AgentLineage request failed',
    retryable: known && [502, 503, 504].includes(failure.status),
  } }, { status: known ? failure.status : 500, headers: { 'Cache-Control': 'no-store' } });
}

export async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new LineageError('BODY_TOO_LARGE', 'Request exceeds the Core size limit', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function coreConfig() {
  const raw = process.env.AGENTLINEAGE_CORE_URL;
  if (!raw) throw new LineageError('LINEAGE_NOT_CONFIGURED', 'Set AGENTLINEAGE_CORE_URL to enable AgentLineage', 503);
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new LineageError('LINEAGE_INVALID_CONFIG', 'AGENTLINEAGE_CORE_URL must be an HTTP(S) origin', 503);
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const token = process.env.AGENTLINEAGE_TOKEN;
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || (!local && (url.protocol !== 'https:' || !token))) {
    throw new LineageError('LINEAGE_INVALID_CONFIG', 'Use an origin without credentials/path; remote Core requires HTTPS and AGENTLINEAGE_TOKEN', 503);
  }
  const timeout = Number(process.env.AGENTLINEAGE_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000) {
    throw new LineageError('LINEAGE_INVALID_CONFIG', 'AGENTLINEAGE_TIMEOUT_MS must be 1..300000', 503);
  }
  return { origin: url.origin, token, timeout };
}

export async function coreRequest(path: string, init: RequestInit = {}): Promise<Response> {
  if (!/^\/(health|v1\/[^?#]*)($|\?)/.test(path) || path.includes('..') || path.startsWith('//')) {
    throw new LineageError('INVALID_CORE_PATH', 'Invalid Core API path');
  }
  const config = coreConfig();
  const timeout = AbortSignal.timeout(config.timeout);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const headers = new Headers(init.headers);
  if (config.token) headers.set('Authorization', `Bearer ${config.token}`);
  else headers.delete('Authorization');
  let response: Response;
  let bytes: ArrayBuffer;
  try {
    response = await fetch(config.origin + path, { ...init, headers, signal, redirect: 'error', cache: 'no-store' });
    bytes = await response.arrayBuffer();
  } catch {
    if (init.signal?.aborted) throw new LineageError('LINEAGE_CANCELLED', 'Request was cancelled', 499);
    if (timeout.aborted) throw new LineageError('LINEAGE_TIMEOUT', 'Core request timed out; inspect state before retrying writes', 504);
    throw new LineageError('LINEAGE_UNAVAILABLE', 'Core service is unavailable', 502);
  }
  return new Response(bytes, { status: response.status, headers: {
    'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}

export async function coreJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await coreRequest(path, init);
  const value = await response.json();
  if (!response.ok) throw new LineageError(value.error?.code ?? 'CORE_ERROR', value.error?.message ?? 'Core rejected request', response.status);
  return value as T;
}
