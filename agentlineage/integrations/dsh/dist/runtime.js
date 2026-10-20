// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { setTimeout as delay } from "node:timers/promises";
import { LineageClient } from "./client.js";
export function stateDirectory(ctx, config) {
    const root = ctx.root;
    const identity = root.baseUrl ?? ctx.baseUrl ?? process.cwd();
    return resolve(config.dataDir ?? join(resolveDshHome(), "agentlineage", createHash("sha256").update(identity).digest("hex").slice(0, 20)));
}
export async function connectCore(ctx, config, directory) {
    const tokenEnv = config.tokenEnv ?? "AGENTLINEAGE_TOKEN";
    if ((config.mode ?? (config.coreUrl ? "external" : "managed")) === "external") {
        const token = process.env[tokenEnv];
        if (!token)
            throw new Error("Required service token environment variable is missing: " + tokenEnv);
        const client = new LineageClient(config.coreUrl ?? "http://127.0.0.1:8110", token);
        await verify(client);
        return client;
    }
    if (!ctx.subprocess)
        throw new Error("Managed AgentLineage requires the DSH subprocess provider");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tokenFile = join(directory, "core-token");
    let token = process.env[tokenEnv];
    if (!token) {
        try {
            token = (await readFile(tokenFile, "utf8")).trim();
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            try {
                await writeFile(tokenFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
            }
            catch (failure) {
                if (failure.code !== "EEXIST")
                    throw failure;
            }
            token = (await readFile(tokenFile, "utf8")).trim();
        }
    }
    if (!token)
        throw new Error("Empty AgentLineage credential file");
    const abort = new AbortController();
    let handle;
    let stopped = false;
    const stop = async () => {
        if (stopped)
            return;
        stopped = true;
        abort.abort();
        handle?.terminate();
        if (handle && !await handle.waitForExit(AbortSignal.timeout(8000)))
            throw new Error("AgentLineage Core did not stop within the shutdown deadline");
    };
    ctx.effect(() => stop);
    try {
        const executable = await ctx.subprocess.resolveExecutable(config.pythonPath ?? process.env.AGENTLINEAGE_PYTHON ?? "python", undefined, abort.signal);
        handle = ctx.subprocess.spawn({
            argv: [executable, "-m", "agentlineage_core.cli", "--data-dir", directory,
                "serve", "--host", "127.0.0.1", "--port", "0", "--exclusive"],
            cwd: directory, graceMs: 3000, signal: abort.signal,
            env: { AGENTLINEAGE_TOKEN: token, PYTHONUNBUFFERED: "1" },
            stdio: { stdin: "ignore", stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
        });
        let exited = false;
        void handle.done.then(() => { exited = true; }, () => { exited = true; });
        const deadline = Date.now() + (config.startupTimeoutMs ?? 30000);
        while (Date.now() < deadline) {
            abort.signal.throwIfAborted();
            if (exited)
                throw new Error("AgentLineage Core exited during startup. Install the matching Core wheel in pythonPath; check whether dataDir is already owned.");
            const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
            const first = stdout.split("\n")[0];
            if (stdout.includes("\n") && first?.trim()) {
                const address = JSON.parse(first);
                if (!address || typeof address !== "object" || !("url" in address) || typeof address.url !== "string")
                    throw new Error("Invalid AgentLineage startup address");
                const url = new URL(address.url);
                if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)
                    throw new Error("Managed Core must bind a loopback port");
                const client = new LineageClient(url.origin, token);
                await verify(client, abort.signal, Math.max(1, deadline - Date.now()));
                return client;
            }
            await delay(40, undefined, { signal: abort.signal });
        }
        throw new Error("AgentLineage Core startup timed out");
    }
    catch (error) {
        await stop();
        throw error;
    }
}
async function verify(client, signal, timeoutMs = 30000) {
    const result = await client.request("/v1/capabilities", undefined, signal, timeoutMs);
    if (result.component !== "agentlineage-core" || !result.features?.includes("dsh-native-v4"))
        throw new Error("AgentLineage Core is incompatible; install the Core version shipped with this plugin");
}
