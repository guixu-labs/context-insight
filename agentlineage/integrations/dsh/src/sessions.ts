// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import type {} from "@deepseek-ai/dsh-session-query";
import type {} from "@deepseek-ai/dsh-fs";
import type {} from "@deepseek-ai/dsh-working-directory";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { LineageClient, type JsonValue } from "./client.js";

export interface Binding {
  snapshot_id: string;
  run_id: string;
  at: string | null;
  session_ids: string[];
  records: number;
}
type Exec = Pick<ToolExecution, "agent" | "signal">;
type Snapshot = { id: string; run_id: string; at: string | null; records: number };

export class Sessions {
  private bindings = new Map<string, Binding>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private ctx: Context, private core: LineageClient, private directory: string) {}

  async load(): Promise<void> {
    try {
      const entries: unknown = JSON.parse(await readFile(join(this.directory, "bindings.json"), "utf8"));
      if (!Array.isArray(entries)) throw new Error("Invalid Lineage bindings file");
      for (const entry of entries) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" ||
            !entry[1] || typeof entry[1].snapshot_id !== "string")
          throw new Error("Invalid Lineage binding");
        this.bindings.set(entry[0], entry[1] as Binding);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private owner(exec: Exec): string {
    if (!exec.agent) throw new Error("This operation requires a DSH conversation; supply snapshot_id for direct calls");
    return exec.agent.session.id;
  }

  current(exec: Exec): Binding | null {
    return exec.agent ? this.bindings.get(exec.agent.session.id) ?? null : null;
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(action, action);
    this.tail = pending.catch(() => {});
    return pending;
  }

  private async remember(owner: string, binding: Binding): Promise<Binding> {
    const next = new Map(this.bindings);
    next.set(owner, binding);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, "bindings-" + randomUUID() + ".tmp");
    await writeFile(temporary, JSON.stringify([...next]), { mode: 0o600, flag: "wx" });
    await rename(temporary, join(this.directory, "bindings.json"));
    this.bindings = next;
    return binding;
  }

  async list(args: { query?: string; offset?: number; limit?: number }, exec: Exec): Promise<JsonValue> {
    const offset = args.offset ?? 0, limit = args.limit ?? 30;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Use offset >= 0 and limit between 1 and 100");
    const query = args.query?.toLocaleLowerCase() ?? "";
    const sessions = (await this.ctx.sessionQuery.listSessions(exec.signal)).filter(item =>
      !query || (item.header.id + " " + (item.header.cwd ?? "")).toLocaleLowerCase().includes(query));
    return { total: sessions.length, next: offset + limit < sessions.length ? offset + limit : null,
      sessions: sessions.slice(offset, offset + limit).map(item => ({
      id: item.header.id, cwd: item.header.cwd ?? null,
      created_at: new Date(item.header.createdAt).toISOString(),
      current: item.header.id === exec.agent?.session.id,
      parent_session: item.header.parentSession ?? null,
      live: item.live, persisted: item.persisted, format: item.formatStatus ?? "current",
    })), binding: this.current(exec) as unknown as JsonValue };
  }

  async bind(snapshotId: string, exec: Exec): Promise<Binding> {
    const owner = this.owner(exec);
    return this.exclusive(async () => {
      const snap = await this.core.request("/v1/snapshots/" + encodeURIComponent(snapshotId),
        undefined, exec.signal) as unknown as Snapshot;
      return this.remember(owner, { snapshot_id: snap.id, run_id: snap.run_id, at: snap.at,
        records: snap.records, session_ids: [] });
    });
  }

  async resolve(snapshotId: string | undefined, exec: Exec): Promise<Binding> {
    if (snapshotId) {
      const snap = await this.core.request("/v1/snapshots/" + encodeURIComponent(snapshotId),
        undefined, exec.signal) as unknown as Snapshot;
      return { snapshot_id: snap.id, run_id: snap.run_id, at: snap.at, records: snap.records, session_ids: [] };
    }
    const existing = this.current(exec);
    if (existing) return existing;
    return this.import({}, exec, true);
  }

  async import(args: { session_id?: string; paths?: string[]; include_children?: boolean },
               exec: Exec, onlyIfMissing = false): Promise<Binding> {
    const owner = this.owner(exec);
    return this.exclusive(async () => {
      exec.signal.throwIfAborted();
      const existing = this.current(exec);
      if (onlyIfMissing && existing) return existing;
      if (args.paths?.length && args.session_id)
        throw new Error("Choose DSH session_id or native paths, not both");
      const sources: string[] = [];
      const sessionIds: string[] = [];
      let totalBytes = 0;
      const upload = async (name: string, content: string | Uint8Array) => {
        const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
        totalBytes += bytes.length;
        if (bytes.length > 64 * 1024 * 1024 || totalBytes > 128 * 1024 * 1024)
          throw new Error("Material exceeds the 64 MiB source / 128 MiB import limit");
        const result = await this.core.upload(name, bytes, exec.signal) as { id: string };
        sources.push(result.id);
      };
      if (args.paths?.length) {
        if (!this.ctx.fs) throw new Error("Native file import requires the DSH filesystem provider");
        if (args.paths.length > 32) throw new Error("Import at most 32 native files at once");
        for (const path of args.paths) {
          if (!/\.(jsonl|json)$/i.test(path)) throw new Error("Choose an uncompressed native JSONL or JSON file");
          const target = await this.ctx.fs.resolve(path, {
            ...(exec.agent ? { cwd: await this.ctx.workingDirectory.ensure(exec.agent, exec.signal) } : {}),
            signal: exec.signal,
          });
          const info = await this.ctx.fs.stat(target, exec.signal);
          if (!info || info.type !== "file" || info.size === undefined || info.size > 64 * 1024 * 1024)
            throw new Error("Native material must be a regular file with a known size up to 64 MiB");
          const bytes = await this.ctx.fs.readBytes(target, exec.signal, 64 * 1024 * 1024);
          await upload(basename(path.replaceAll("\\", "/")), bytes);
        }
      } else {
        const target = !args.session_id || args.session_id === "current" ? owner : args.session_id;
        const ids = new Set([target]);
        if (args.include_children !== false) {
          const corpus = await this.ctx.sessionQuery.listSessions(exec.signal);
          let changed = true;
          while (changed) {
            changed = false;
            for (const entry of corpus) {
              if (entry.header.parentSession && ids.has(entry.header.parentSession) && !ids.has(entry.header.id)) {
                ids.add(entry.header.id); changed = true;
              }
            }
            if (ids.size > 64) throw new Error("Session tree exceeds 64 sessions; import a narrower subtree");
          }
        }
        for (const id of ids) {
          exec.signal.throwIfAborted();
          const log = await this.ctx.sessionQuery.readSession(SessionId(id));
          if (log.session.version !== 4) throw new Error("This plugin supports DSH native session format v4");
          const header = sessionFormatCatalog.encodeCurrentHeader({ ...log.session,
            delegationDepth: log.session.delegationDepth ?? 0 }, log.inheritedEventCount);
          const rows = [JSON.stringify(header), ...log.events.map(event =>
            JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(JSON.parse(JSON.stringify(event)))))];
          await upload("dsh-" + encodeURIComponent(id) + ".jsonl", rows.join("\n") + "\n");
          sessionIds.push(id);
        }
      }
      const run = await this.core.request("/v1/runs", { external_key: "dsh:" + owner,
        project_id: "dsh", objective: "Native session evidence" }, exec.signal) as { id: string };
      const snap = await this.core.request("/v1/runs/" + run.id + "/snapshots", {
        source_ids: [...new Set(sources)],
        context: { host: "dsh", session_ids: sessionIds, capture: "explicit-frozen-log" },
      }, exec.signal, 300000) as unknown as Snapshot;
      exec.signal.throwIfAborted();
      return this.remember(owner, { snapshot_id: snap.id, run_id: run.id, at: snap.at,
        records: snap.records, session_ids: sessionIds });
    });
  }
}
