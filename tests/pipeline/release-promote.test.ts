// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// Release Promote 原子性 IT：promote.mjs 通过 `npm dist-tag add/rm` 提升 latest，
// 但 `--provenance`（OIDC）对 dist-tag 无效、且真实 registry 不可在测试中写。
// 本 IT 用注入 PATH 的 fake `npm` 顶替真实 npm（`view` 回固定 dist-tags JSON，
// `dist-tag` 落日志），从脚本真实执行路径验证「先全量只读校验、再统一变更」的
// 原子语义：任一包未发布时，两包均不得发生任何 dist-tag 变更。

import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROMOTE_PATH = path.resolve(__dirname, "../../scripts/release/promote.mjs")

// 注入 PATH 的 fake npm：`view <name> dist-tags --json` 回 FAKE_NPM_STATE 里的
// dist-tags；`dist-tag add/rm` 不触真实 registry，把整条调用追加到 FAKE_NPM_LOG。
const FAKE_NPM = `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
const sub = args[0]
if (sub === "view") {
  const name = args[1]
  const state = JSON.parse(fs.readFileSync(process.env.FAKE_NPM_STATE, "utf8"))
  process.stdout.write(JSON.stringify(state[name] ?? {}))
} else if (sub === "dist-tag") {
  fs.appendFileSync(process.env.FAKE_NPM_LOG, args.join(" ") + "\\n")
} else {
  console.error("unexpected npm subcommand: " + sub)
  process.exit(2)
}
`

function runPromote(distTags: Record<string, Record<string, string>>, version = "1.0.0") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "release-promote-it-"))
  fs.writeFileSync(path.join(tmp, "npm"), FAKE_NPM, { mode: 0o755 })
  const statePath = path.join(tmp, "state.json")
  const logPath = path.join(tmp, "npm.log")
  fs.writeFileSync(statePath, JSON.stringify(distTags))

  const result = spawnSync(
    "node",
    [PROMOTE_PATH, "--version", version, "--confirm", version, "--prune-legacy", "true"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tmp}:${process.env.PATH}`,
        FAKE_NPM_STATE: statePath,
        FAKE_NPM_LOG: logPath,
      },
    },
  )

  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean) : []
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, log }
}

describe("scripts/release/promote.mjs atomicity", () => {
  it("beta 预发布版本不能提升到 latest", () => {
    const { status, log, stderr } = runPromote({}, "1.0.0-beta.20261128.1.1")
    expect(status).not.toBe(0)
    expect(log).toEqual([])
    expect(stderr).toContain("latest promotion requires a stable version")
  })

  it("任一包未发布时：先只读校验，两包均不产生任何 dist-tag 变更", () => {
    // 第二个包 cannbot-insight 无 dist-tag 指向 1.0.0 → 未发布；第一个包已发布。
    // 原子语义要求：即便 context-insight 已就绪，也不得先动它的 latest。
    const { status, log } = runPromote({
      "context-insight": { beta: "1.0.0" },
      "cannbot-insight": { beta: "0.9.0" },
    })
    expect(status).not.toBe(0)
    expect(log, "第二个包校验失败前不得对任一包执行 dist-tag 变更").toEqual([])
  })

  it("两包齐备时：统一执行 latest 提升与旧 next/dev 指针清理", () => {
    const { status, log } = runPromote({
      "context-insight": { beta: "1.0.0", next: "0.9.0", dev: "0.8.0" },
      "cannbot-insight": { beta: "1.0.0", latest: "0.9.0" },
    })
    expect(status).toBe(0)
    expect(log).toHaveLength(4)
    expect(log).toContain("dist-tag add context-insight@1.0.0 latest --registry https://registry.npmjs.org/")
    expect(log).toContain("dist-tag rm context-insight next --registry https://registry.npmjs.org/")
    expect(log).toContain("dist-tag rm context-insight dev --registry https://registry.npmjs.org/")
    expect(log).toContain("dist-tag add cannbot-insight@1.0.0 latest --registry https://registry.npmjs.org/")
  }, 30_000)
})
