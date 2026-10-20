// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SqliteSessionQuery from "@deepseek-ai/dsh-session-query-sqlite";
import * as Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import LocalSubprocess from "@deepseek-ai/dsh-subprocess-local";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";
import * as ToolFs from "@deepseek-ai/dsh-tool-fs";
import { createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import * as Lineage from "../dist/plugin.js";
import { LineageClient } from "../dist/client.js";

const python = process.env.AGENTLINEAGE_TEST_PYTHON ?? "python";
process.env.PYTHONPATH = resolve("../../components/core/src");

async function host(directory) {
  const ctx = new Context();
  const fibers = [];
  async function mount(plugin, config) {
    const fiber = await ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2, 'inactive plugin: ' + fiber.name);
    return fiber;
  }
  try {
    await mount(SystemPrompt, {});
    await mount(ToolRuntime, {});
    await mount(SessionProjectionRegistry, {});
    await mount(SessionStore, {});
    await mount(Persistence, { root: join(directory, "sessions"), compression: "zstd" });
    await mount(SqliteSessionQuery, { path: join(directory, "query.db") });
    await mount(LocalSubprocess, {});
    await mount(LocalFileSystem, { cwd: directory });
    await mount(WorkingDirectory, { defaultDirectory: directory });
    await mount(ToolFs, { readImage: false });
  } catch (error) {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    throw error;
  }
  return { ctx, mount, close: async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }};
}

let callIndex = 0;
const turns = new WeakMap();
async function execute(ctx, session, name, args = {}, { logged = false } = {}) {
  const callId = "lineage-it-" + ++callIndex;
  const turn = (turns.get(session) ?? 0) + 1;
  if (logged) {
    turns.set(session, turn);
    session.append("turn/start", { turn });
    session.append("step/start", { turn, step: 1 });
    session.append("assistant/message", { turn, step: 1, stream: [], message: createAssistantMessage({
      content: [{ type: "tool-call", id: callId, name, arguments: JSON.stringify(args) }],
      source: { kind: "model", provider: "test-fixture", model: "keyless" },
    }) }, { surfaceOp: "append" });
    session.append("tool/call", { turn, step: 1, callId, name, arguments: JSON.stringify(args) });
  }
  const result = await ctx.tools.execute({ callId, name, arguments: args, agent: { session, ctx },
    signal: AbortSignal.timeout(30000) });
  if (logged) {
    session.append("tool/result", { turn, step: 1, message: createToolResultMessage({
      callId, content: result.content, isError: result.isError,
    }), ...(result.meta === undefined ? {} : { meta: result.meta }) }, { surfaceOp: "append" });
    session.append("step/end", { turn, step: 1 });
    session.append("turn/end", { turn, reason: { kind: "completed" } });
  }
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.value;
}

async function closed(url) {
  await assert.rejects(fetch(url + "/health", { signal: AbortSignal.timeout(1000) }));
}

test("managed Core owns its port and native DSH sessions, snapshots, files and restart", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "lineage-managed-"));
  let harness;
  let firstUrl;
  try {
    harness = await host(directory);
    const { ctx, mount } = harness;
    const one = ctx.sessions.create(SessionId("task-one"), { meta: { cwd: directory } });
    const two = ctx.sessions.create(SessionId("task-two"), { meta: { cwd: directory } });
    one.append("user/message", createUserMessage({ content: [{ type: "text", text: "Write a greeting" }],
      source: { kind: "user" } }), { surfaceOp: "append" });
    const target = join(directory, "hello.txt");
    await execute(ctx, one, "write", { file_path: target, content: "hello\n" }, { logged: true });
    assert.equal(await readFile(target, "utf8"), "hello\n");
    const config = { mode: "managed", pythonPath: python, tokenEnv: "LINEAGE_MANAGED_TEST_TOKEN", dataDir: join(directory, "core") };
    let plugin = await mount(Lineage, config);
    assert.ok(ctx.tools.get("lineage_import"), plugin.error?.stack);
    const before = await execute(ctx, one, "lineage_status");
    assert.equal(before.binding, null);
    firstUrl = before.core_url;
    assert.match(firstUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(new URL(firstUrl).port, "8110");
    const queried = await execute(ctx, one, "lineage_query", { path: target });
    assert.equal(queried.results[0].status, "ok");
    assert.ok(JSON.stringify(queried).includes("write"));
    const status = await execute(ctx, one, "lineage_status");
    assert.deepEqual(status.binding.session_ids, ["task-one"]);
    assert.equal((await execute(ctx, two, "lineage_status")).binding, null);
    const token = (await readFile(join(config.dataDir, "core-token"), "utf8")).trim();
    assert.ok(!JSON.stringify(status).includes(token));
    const core = new LineageClient(firstUrl, token);
    const replay = await core.request("/v1/lineage", {
      snapshot_id: status.binding.snapshot_id, path: target, at: status.binding.at,
    });
    assert.equal(replay.write_count, 1, JSON.stringify({ replay, queried, status }));
    assert.equal(replay.status, "replayed");
    await execute(ctx, one, "edit", { file_path: target, old_string: "hello", new_string: "updated" }, { logged: true });
    assert.equal(await readFile(target, "utf8"), "updated\n");
    assert.equal((await execute(ctx, one, "lineage_status")).binding.snapshot_id, status.binding.snapshot_id);
    const fresh = await execute(ctx, one, "lineage_import");
    assert.notEqual(fresh.snapshot_id, status.binding.snapshot_id);
    const changed = await core.request("/v1/lineage", {
      snapshot_id: fresh.snapshot_id, path: target, at: fresh.at,
    });
    assert.equal(changed.write_count, 2);
    const child = ctx.sessions.fork(one, undefined, SessionId("task-child"));
    const withChild = await execute(ctx, one, "lineage_import");
    assert.deepEqual(withChild.session_ids, ["task-one", child.id]);
    const family = await core.request("/v1/lineage", {
      snapshot_id: withChild.snapshot_id, path: target, at: withChild.at,
    });
    assert.equal(family.write_count, 2, "inherited writes must not be counted twice");
    const log = await ctx.sessionQuery.readSession(one.id);
    const writer = await ctx.sessionPersistence.create({ ...log.session, id: SessionId("saved-task") });
    await writer.append(log.events);
    await writer.close();
    const listed = await execute(ctx, two, "lineage_sessions");
    assert.ok(listed.sessions.some(s => s.id === "saved-task" && s.persisted && !s.live));
    const historical = await execute(ctx, two, "lineage_import", { session_id: "saved-task" });
    assert.deepEqual(historical.session_ids, ["saved-task"]);
    assert.equal((await execute(ctx, one, "lineage_status")).binding.snapshot_id, withChild.snapshot_id);
    const exportFile = join(directory, "export.jsonl");
    await writeFile(exportFile, "\uFEFF" + [sessionFormatCatalog.encodeCurrentHeader({
      ...log.session, delegationDepth: 0 }, log.inheritedEventCount),
      ...log.events.map(event => sessionFormatCatalog.encodeCurrentEvent(event))]
      .map(row => JSON.stringify(row)).join("\n") + "\n");
    const material = await execute(ctx, two, "lineage_import", { paths: ["export.jsonl"] });
    assert.ok(material.records > 0);
    const materialSnapshot = await core.request("/v1/snapshots/" + material.snapshot_id);
    const original = await core.request("/v1/sources/" + materialSnapshot.sources[0].id + "/content");
    assert.deepEqual(Buffer.from(original.content, "base64"), await readFile(exportFile));
    await writeFile(join(directory, "invalid.jsonl"), "not a native session");
    const invalid = await ctx.tools.execute({ callId: "invalid-import", name: "lineage_import",
      arguments: { paths: ["invalid.jsonl"] }, agent: { session: two, ctx }, signal: AbortSignal.timeout(30000) });
    assert.equal(invalid.isError, true);
    assert.equal((await execute(ctx, two, "lineage_status")).binding.snapshot_id, material.snapshot_id);
    await execute(ctx, two, "lineage_bind", { snapshot_id: historical.snapshot_id });
    const link = await execute(ctx, two, "lineage_open");
    assert.ok(link.url.includes(historical.snapshot_id) && !link.url.includes(token));
    await plugin.dispose();
    assert.equal(ctx.tools.get("lineage_query"), undefined);
    await closed(firstUrl);
    plugin = await mount(Lineage, config);
    assert.ok(ctx.tools.get("lineage_query"), plugin.error?.stack);
    const restarted = await execute(ctx, two, "lineage_status");
    assert.equal(restarted.binding.snapshot_id, historical.snapshot_id);
    assert.equal((await execute(ctx, two, "lineage_query")).results[0].status, "ok");
    const nextUrl = restarted.core_url;
    await plugin.dispose();
    await closed(nextUrl);
  } finally {
    await harness?.close();
    assert.ok(directory.startsWith(join(tmpdir(), "lineage-managed-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed startup failure does not register tools or leave an owned Core", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "lineage-failed-"));
  let harness;
  try {
    harness = await host(directory);
    await assert.rejects(harness.mount(Lineage, { mode: "managed", pythonPath: join(directory, "missing-python"),
      dataDir: join(directory, "core"), startupTimeoutMs: 1000 }), /executable|missing-python|not found|ENOENT/i);
    assert.equal(harness.ctx.tools.get("lineage_query"), undefined);
  } finally {
    await harness?.close();
    assert.ok(directory.startsWith(join(tmpdir(), "lineage-failed-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed profiles allocate independent ports and reject a second owner of the same store", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "lineage-owners-"));
  const hosts = [];
  try {
    for (let i = 0; i < 3; i++) {
      const path = join(directory, "host-" + i);
      await mkdir(path);
      hosts.push(await host(path));
    }
    const config = { mode: "managed", pythonPath: python, tokenEnv: "LINEAGE_MANAGED_TEST_TOKEN",
      dataDir: join(directory, "core") };
    const first = await hosts[0].mount(Lineage, config);
    const session = hosts[0].ctx.sessions.create(SessionId("owner"));
    const status = await execute(hosts[0].ctx, session, "lineage_status");
    await assert.rejects(hosts[1].mount(Lineage, config), /already owned|exited during startup/);
    assert.equal(hosts[1].ctx.tools.get("lineage_query"), undefined);
    assert.equal((await execute(hosts[0].ctx, session, "lineage_status")).core_url, status.core_url);
    const other = await hosts[2].mount(Lineage, { ...config, dataDir: join(directory, "other-core") });
    const secondSession = hosts[2].ctx.sessions.create(SessionId("other"));
    const second = await execute(hosts[2].ctx, secondSession, "lineage_status");
    assert.notEqual(status.core_url, second.core_url);
    await first.dispose();
    await closed(status.core_url);
    assert.equal((await execute(hosts[2].ctx, secondSession, "lineage_status")).core_url, second.core_url);
    await other.dispose();
    await closed(second.core_url);
  } finally {
    for (const item of hosts.reverse()) await item.close();
    assert.ok(directory.startsWith(join(tmpdir(), "lineage-owners-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed startup timeout terminates the actual spawned process", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "lineage-timeout-"));
  const previous = process.env.PYTHONPATH;
  let harness;
  try {
    const module = join(directory, "agentlineage_core");
    await mkdir(module);
    await writeFile(join(module, "__init__.py"), "");
    await writeFile(join(module, "cli.py"),
      "import os, time\nfrom pathlib import Path\nPath('timeout-pid').write_text(str(os.getpid()))\ntime.sleep(30)\n");
    process.env.PYTHONPATH = directory;
    harness = await host(directory);
    const dataDir = join(directory, "core");
    await assert.rejects(harness.mount(Lineage, { mode: "managed", pythonPath: python,
      dataDir, startupTimeoutMs: 1000 }), /startup timed out/);
    const pid = Number(await readFile(join(dataDir, "timeout-pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
    assert.equal(harness.ctx.tools.get("lineage_query"), undefined);
  } finally {
    if (previous === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = previous;
    await harness?.close();
    assert.ok(directory.startsWith(join(tmpdir(), "lineage-timeout-")));
    await rm(directory, { recursive: true, force: true });
  }
});
