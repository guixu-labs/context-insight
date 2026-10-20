import assert from "node:assert/strict";
import test from "node:test";
import { createTools } from "../dist/plugin.js";
import { LineageClient } from "../dist/client.js";

test("actual DSH defineTool validates tools; writes require explicit configuration", async () => {
  const calls = [];
  const client = { baseUrl: "http://127.0.0.1:8110",
    request: async (...args) => { calls.push(args); return { ok: true }; } };
  const tools = createTools(client, client);
  assert.deepEqual(tools.map(t => t.name), ["lineage_query", "lineage_open", "lineage_check",
    "lineage_memory_search", "lineage_cases"]);
  const query = tools[0];
  await query.execute({ snapshot_id: "snapshot", requests: [{ op: "file" }] },
    { signal: new AbortController().signal });
  assert.equal(calls[0][0], "/v1/query");
  assert.equal(createTools(client, client, true).at(-1).name, "lineage_investigate");
});

test("credential-bearing clients reject unsafe endpoints", () => {
  for (const url of ["http://remote.example", "https://u:p@remote.example", "https://host/path"])
    assert.throws(() => new LineageClient(url, "secret"));
});
