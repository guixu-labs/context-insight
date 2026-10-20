// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ToolDefinition, type ToolExecution } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { LineageClient, type JsonValue } from "./client.js";
import { Sessions } from "./sessions.js";
import { connectCore, stateDirectory, type RuntimeConfig } from "./runtime.js";

export const name = "dsh-agentlineage";
export const inject = ["tools", "sessionQuery", "subprocess", "fs", "workingDirectory"];
export interface Config extends RuntimeConfig {
  learningUrl?: string;
  learningTokenEnv?: string;
  enableInvestigations?: boolean;
}
export const Config = Schema.object({
  mode: Schema.union(["managed", "external"]),
  coreUrl: Schema.string(),
  tokenEnv: Schema.string().default("AGENTLINEAGE_TOKEN"),
  pythonPath: Schema.string(),
  dataDir: Schema.string(),
  startupTimeoutMs: Schema.number().min(1000).max(120000).default(30000),
  learningUrl: Schema.string(),
  learningTokenEnv: Schema.string().default("AGENTLINEAGE_LEARNING_TOKEN"),
  enableInvestigations: Schema.boolean().default(false),
});
const output = {
  schema: { type: "json" as const },
  render: (_args: unknown, value: JsonValue) => [{ type: "text" as const, text: JSON.stringify(value) }],
};
const snapshotParameter = { type: "string" as const,
  description: "Optional explicit snapshot. Omit to use this conversation's bound snapshot, automatically importing the current DSH session on first use." };

export function createTools(core: LineageClient, learning?: LineageClient,
                            allowInvestigations = false, sessions?: Sessions): ToolDefinition[] {
  const resolve = async (id: string | undefined, exec: ToolExecution) => {
    if (sessions) return sessions.resolve(id, exec);
    if (!id) throw new Error("snapshot_id is required outside a DSH conversation");
    return { snapshot_id: id, at: null };
  };
  const tools: ToolDefinition[] = [
    defineTool({
      name: "lineage_query",
      description: "Investigate recorded file changes in your own DSH session. Omit snapshot_id. Without path lists files; use an exact path from that catalog to get write/read relations, change payloads and calls. Advanced requests: catalog(kind:file|agent|source,q,limit,offset); file/agent(key,at,view); open(ref,at); blame(key,at,terms). Use returned next as offset, real evidence refs, and the bound snapshot cutoff. Shell text alone is not proof of a write. Refresh material with lineage_import after further work.",
      parameters: { snapshot_id: snapshotParameter, path: { type: "string" },
        requests: { type: "array", items: { type: "json" } } },
      output, isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const binding = await resolve(args.snapshot_id, exec);
        const requests = args.requests ?? (args.path ? ["relations", "changes", "calls"].map(view => ({
          op: "file", key: args.path, at: binding.at, view, limit: 20,
        })) : [{ op: "catalog", kind: "file", limit: 50 }]);
        return core.request("/v1/query", { snapshot_id: binding.snapshot_id, requests }, exec.signal);
      },
    }),
    defineTool({
      name: "lineage_open",
      description: "Return the bound snapshot's browser Viewer link. Omit snapshot_id. Authentication stays in the Core browser login, never in the URL.",
      parameters: { snapshot_id: snapshotParameter },
      output, isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const binding = await resolve(args.snapshot_id, exec);
        await core.request("/v1/snapshots/" + encodeURIComponent(binding.snapshot_id), undefined, exec.signal);
        return { snapshot_id: binding.snapshot_id,
          url: core.baseUrl + "/v1/snapshots/" + encodeURIComponent(binding.snapshot_id) + "/viewer" };
      },
    }),
    defineTool({
      name: "lineage_check",
      description: 'Check a report against the bound evidence. Omit snapshot_id. document uses {"schema":"inquiry/1","target":{"file":"exact path","at":"ISO cutoff"},"findings":[{"id":"f1","title":"finding","reason":"analysis","changes":["original e-ref"],"nodes":[],"edges":[]}]} or a Core inquiry card. Checks references, relations and coverage; needs_revision means evidence gaps, not a service failure. Never claim semantic correctness from mechanical checks.',
      parameters: { snapshot_id: snapshotParameter, document: { type: "json", required: true } },
      output, isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const binding = await resolve(args.snapshot_id, exec);
        return core.request("/v1/reports/check",
          { snapshot_id: binding.snapshot_id, document: args.document }, exec.signal);
      },
    }),
  ];
  if (sessions) tools.push(
    defineTool({
      name: "lineage_sessions",
      description: "List real DSH live and saved sessions, including current identity, creation time and workspace. Filter by workspace or id with query; follow next as offset (limit 1-100). Use the returned id to import a historical task; users need not find log files.",
      parameters: { query: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
      output, isConcurrencySafe: () => true,
      execute: (args, exec) => sessions.list(args, exec),
    }),
    defineTool({
      name: "lineage_import",
      description: "Freeze and bind native evidence for this conversation. No arguments imports or refreshes the current DSH session and descendants. session_id selects a historical DSH session. Alternatively paths imports explicit uncompressed Claude/Codex/DevEco/DSH native files through the DSH filesystem provider. Does not execute logged commands. After import, query/open/check need no snapshot_id.",
      parameters: { session_id: { type: "string" }, include_children: { type: "boolean" },
        paths: { type: "array", items: { type: "string" } } },
      output, isConcurrencySafe: () => false,
      execute: async (args, exec) => await sessions.import(args, exec) as unknown as JsonValue,
    }),
    defineTool({
      name: "lineage_bind",
      description: "Select an already known Core snapshot for this DSH conversation. Ordinary users can use lineage_import instead; snapshot bindings persist independently per conversation.",
      parameters: { snapshot_id: { type: "string", required: true } },
      output, isConcurrencySafe: () => false,
      execute: async (args, exec) => await sessions.bind(args.snapshot_id, exec) as unknown as JsonValue,
    }),
    defineTool({
      name: "lineage_status",
      description: "Show Core capabilities and this conversation's snapshot binding, including cutoff, source sessions and record count. No credentials are returned.",
      parameters: {}, output, isConcurrencySafe: () => true,
      execute: async (_args, exec) => ({
        capabilities: await core.request("/v1/capabilities", undefined, exec.signal),
        binding: sessions.current(exec) as unknown as JsonValue, core_url: core.baseUrl,
      }),
    }),
  );
  if (learning) {
    tools.push(defineTool({
      name: "lineage_memory_search", description: "Retrieve versioned lessons using lexical search.",
      parameters: { query: { type: "string", required: true }, topic: { type: "string" } },
      output, isConcurrencySafe: () => true,
      execute: (args, exec) => learning.request("/v1/memory/search", args, exec.signal),
    }), defineTool({
      name: "lineage_cases", description: "Read an investigation and its mechanically checked draft cases.",
      parameters: { investigation_id: { type: "string", required: true } },
      output, isConcurrencySafe: () => true,
      execute: (args, exec) => learning.request("/v1/investigations/" +
        encodeURIComponent(args.investigation_id), undefined, exec.signal),
    }));
    if (allowInvestigations) tools.push(defineTool({
      name: "lineage_investigate",
      description: "Explicitly queue a budgeted investigation from uploaded Learning sources and a triage plan. Returns draft cases; never publishes memory.",
      parameters: { run_key: { type: "string", required: true },
        source_ids: { type: "array", items: { type: "string" }, required: true },
        triage: { type: "json", required: true }, budget: { type: "json", required: true } },
      output, isConcurrencySafe: () => false,
      execute: (args, exec) => learning.request("/v1/investigations", args, exec.signal),
    }));
  }
  return tools;
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const directory = stateDirectory(ctx, config);
  const core = await connectCore(ctx, config, directory);
  const external = (config.mode ?? (config.coreUrl ? "external" : "managed")) === "external";
  const namespace = external ? createHash("sha256").update(core.baseUrl).digest("hex").slice(0, 20) : "managed";
  const sessions = new Sessions(ctx, core, join(directory, "bindings", namespace));
  await sessions.load();
  let learning: LineageClient | undefined;
  if (config.learningUrl) {
    const token = process.env[config.learningTokenEnv ?? "AGENTLINEAGE_LEARNING_TOKEN"];
    if (!token) throw new Error("Required Learning service credential is missing");
    learning = new LineageClient(config.learningUrl, token);
  }
  for (const tool of createTools(core, learning, config.enableInvestigations, sessions))
    ctx.effect(() => ctx.tools.register(tool));
}
