import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { LineageClient } from "../dist/client.js";
import { createTools } from "../dist/plugin.js";
import * as LineagePlugin from "../dist/plugin.js";
import { Context } from "@deepseek-ai/cordis";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import SessionStore from "@deepseek-ai/dsh-session";
import SessionQuery from "@deepseek-ai/dsh-session-query-sqlite";
import LocalSubprocess from "@deepseek-ai/dsh-subprocess-local";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";

test("DSH tools query a separately running Python Core", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlineage-dsh-"));
  const python = process.env.AGENTLINEAGE_TEST_PYTHON ??
    resolve("../../.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const child = spawn(python, ["-m", "agentlineage_core.cli", "--data-dir", directory,
    "serve", "--port", "0"], { env: { ...process.env, AGENTLINEAGE_TOKEN: "fixture-token",
      PYTHONPATH: resolve("../../components/core/src") },
    stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const closed = new Promise(resolve => child.once("exit", resolve));
  try {
    const base = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => reject(new Error("Core exited: " + code + " " + stderr)));
      const lines = createInterface({ input: child.stdout });
      lines.once("line", line => { try { resolve(JSON.parse(line).url); } catch (error) { reject(error); } });
    });
    const core = new LineageClient(base, "fixture-token");
    const run = await core.request("/v1/runs", { external_key: "dsh-consumer" });
    const rows = [
      { sessionId: "native", agentId: "worker", cwd: "/app", type: "assistant",
        timestamp: "2026-01-01T00:00:01Z", message: { content: [
          { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "/app/file.txt", content: "hello" } }] } },
      { sessionId: "native", agentId: "worker", cwd: "/app", type: "user",
        timestamp: "2026-01-01T00:00:02Z", message: { content: [
          { type: "tool_result", tool_use_id: "write-1", content: "ok" }] } },
    ];
    const uploaded = await fetch(base + "/v1/sources?name=native.jsonl", {
      method: "POST", headers: { Authorization: "Bearer fixture-token" },
      body: rows.map(row => JSON.stringify(row)).join("\n") + "\n",
    });
    assert.equal(uploaded.status, 201);
    const source = await uploaded.json();
    const snapshot = await core.request("/v1/runs/" + run.id + "/snapshots", { source_ids: [source.id] });
    const tools = createTools(core);
    const exec = { signal: new AbortController().signal };
    const result = await tools.find(tool => tool.name === "lineage_query").execute({
      snapshot_id: snapshot.id, requests: [{ op: "file", key: "/app/file.txt",
        at: "2026-01-01T00:00:03Z", view: "relations" }],
    }, exec);
    assert.equal(result.results[0].result.total, 1);
    const link = await tools.find(tool => tool.name === "lineage_open").execute({
      snapshot_id: snapshot.id,
    }, exec);
    assert.ok(link.url.endsWith("/viewer") && !link.url.includes("fixture-token"));
    const ctx = new Context();
    const promptFiber = await ctx.plugin(SystemPrompt, {});
    const toolsFiber = await ctx.plugin(ToolRuntime, {});
    const sessionsFiber = await ctx.plugin(SessionStore, {});
    const queryFiber = await ctx.plugin(SessionQuery, { path: join(directory, "query.db") });
    await queryFiber.await();
    const localFiber = await ctx.plugin(LocalSubprocess, {});
    const fsFiber = await ctx.plugin(LocalFileSystem, { cwd: directory });
    const projectionFiber = await ctx.plugin(SessionProjectionRegistry, {});
    const cwdFiber = await ctx.plugin(WorkingDirectory, { defaultDirectory: directory });
    process.env.LINEAGE_HOST_TEST_TOKEN = "fixture-token";
    let pluginFiber;
    try {
      pluginFiber = await ctx.plugin(LineagePlugin, { mode: "external", coreUrl: base,
        dataDir: join(directory, "bindings"), tokenEnv: "LINEAGE_HOST_TEST_TOKEN" });
      await pluginFiber.await();
      for (const name of ["lineage_query", "lineage_open", "lineage_check"])
        assert.ok(ctx.tools.get(name));
      const execute = (snapshot_id) => ctx.tools.execute({ callId: "lineage-host-it", name: "lineage_query",
        arguments: { snapshot_id, requests: [{ op: "catalog", kind: "file" }] },
        signal: new AbortController().signal });
      const success = await execute(snapshot.id);
      assert.equal(success.isError, false);
      assert.equal(success.value.results[0].status, "ok");
      const failure = await ctx.tools.execute({ callId: "lineage-host-missing", name: "lineage_open",
        arguments: { snapshot_id: "snap_" + "0".repeat(64) }, signal: new AbortController().signal });
      assert.equal(failure.isError, true);
      await pluginFiber.dispose();
      assert.equal(ctx.tools.get("lineage_query"), undefined);
      assert.equal((await core.request("/v1/capabilities")).component, "agentlineage-core");
      pluginFiber = await ctx.plugin(LineagePlugin, { coreUrl: base,
        dataDir: join(directory, "bindings"), tokenEnv: "LINEAGE_HOST_TEST_TOKEN" });
      await pluginFiber.await();
      assert.ok(ctx.tools.get("lineage_query"));
    } finally {
      await pluginFiber?.dispose();
      await cwdFiber.dispose();
      await projectionFiber.dispose();
      await fsFiber.dispose();
      await localFiber.dispose();
      await queryFiber.dispose();
      await sessionsFiber.dispose();
      await toolsFiber.dispose();
      await promptFiber.dispose();
      delete process.env.LINEAGE_HOST_TEST_TOKEN;
    }
  } finally {
    child.kill();
    await closed;
    // The generated path is owned by this test and never derived from a model/tool response.
    assert.ok(directory.startsWith(join(tmpdir(), "agentlineage-dsh-")));
    await rm(directory, { recursive: true, force: true });
  }
});
