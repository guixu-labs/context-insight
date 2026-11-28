// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// npm 发布就绪 IT：发布到公共 registry 前，用 `npm pack --dry-run`（零网络、零落盘）
// 从 npm 的真实视角验证将要发布的包内容与元数据——
//   ① 产物清单：bin 启动器 / postinstall / 源码 / prisma schema / export-view bundle / CLI bundle 在包内
//   ② 裁剪生效：tests / docs / 运行时数据 / home 泄漏树 / lockfile 不进包（.npmignore 兜住）
//   ③ package.json 发布就绪：无 private、版本与展示版本单一源 version.ts 单轨一致、
//      bin（context-insight/ctxi）与 postinstall 钩子齐备
//   ④ 产物文件数哨兵（300-550）；CLI bundle 实跑 --version 与展示版本一致
//
// 注：不校验 package-lock.json——它被 .gitignore 忽略不入库（各机器本地生成），
// 版本升级后重装前必"漂移"，属环境过期而非代码错误（issue #5）；且 pack/publish
// 均不读 lockfile，对发布物零影响。

import { describe, it, expect } from "vitest"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { VERSION } from "../../src/lib/version"
import { BRAND_NAME } from "../../src/lib/branding"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_DIR = path.resolve(__dirname, "../..")

const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"))

interface PackFile { path: string; size: number }

// npm ≤11 输出数组 [{files, entryCount}]；npm ≥12 改为按包名索引的对象且去掉
// entryCount（文件数改由 files.length 得出）。两种格式归一成同一形状。
function parsePackJson(stdout: string): Array<{ files: PackFile[]; entryCount: number }> {
  const parsed: unknown = JSON.parse(stdout)
  const list = Array.isArray(parsed)
    ? (parsed as Array<{ files?: PackFile[]; entryCount?: number }>)
    : Object.values(parsed as Record<string, { files?: PackFile[]; entryCount?: number }>)
  return list.map((e) => ({ files: e.files ?? [], entryCount: e.entryCount ?? e.files?.length ?? 0 }))
}

function packDryRun(): PackFile[] {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: PKG_DIR,
    encoding: "utf8",
    timeout: 120_000,
  })
  if (r.status !== 0) {
    throw new Error(`npm pack --dry-run 失败:\n${r.stderr}\n${r.stdout}`)
  }
  const parsed = parsePackJson(r.stdout)
  expect(parsed.length).toBe(1)
  return parsed[0].files
}

describe("npm publish readiness (npm pack --dry-run)", () => {
  it("产物含运行必需文件：bin 启动器 / postinstall / 源码 / prisma / export-view / LICENSE / CLI bundle", () => {
    const files = packDryRun().map((f) => f.path)
    for (const must of [
      "bin/context-insight.mjs",
      "bin/ports.mjs",
      "scripts/postinstall.mjs",
      "src/lib/version.ts",
      "src/lib/ingest/adapters/claude-jsonl.ts",
      "prisma/schema.prisma",
      "public/export-view.js",
      "dist/cli.mjs",
      "LICENSE",
      "README.md",
    ]) {
      expect(files, `缺少发布必需文件: ${must}`).toContain(must)
    }
  }, 120_000)

  it("裁剪生效：tests/docs/运行时数据/lockfile/home 泄漏树 不进包", () => {
    const files = packDryRun().map((f) => f.path)
    const forbidden = (p: string) =>
      p === "tests" || p.startsWith("tests/") ||
      p === "docs" || p.startsWith("docs/") ||
      p === ".github" || p.startsWith(".github/") ||
      p === ".env" || p.startsWith(".env.") ||
      /\.db(?:-(?:journal|wal|shm))?$/.test(p) ||
      p === "package-lock.json" ||
      p === ".next" || p.startsWith(".next/") ||
      p === ".next-e2e" || p.startsWith(".next-e2e/") ||
      p === "playwright-report" || p.startsWith("playwright-report/") ||
      p === "test-results" || p.startsWith("test-results/") ||
      p === "release-artifacts" || p.startsWith("release-artifacts/") ||
      p === ".cannbot-pack" || p.startsWith(".cannbot-pack/") ||
      p === "scripts/release" || p.startsWith("scripts/release/") ||
      p === "home" || p.startsWith("home/")
    const leaked = files.filter(forbidden)
    expect(leaked, `以下文件不应进包: ${leaked.join(", ")}`).toEqual([])
  }, 120_000)

  it("产物文件数哨兵：≤ 650（2026-10 develop 线源码自然增长至 ~552：run-first 统一工作台 12 tab + collectors/session-handlers 平移 + 性能层；2026-11 v1.0.7 线到 600，Skills 恢复正文单一展示面 SkillSourceView +1 → 601，上限放到 650——核过包内 601 = 已跟踪源码 + 该一个文件，无夹带；暴涨说明构建垃圾混入——曾混入 E2E 泄漏的 home/ 构建树 29MB）", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: PKG_DIR, encoding: "utf8", timeout: 120_000,
    })
    expect(r.status).toBe(0)
    const parsed = parsePackJson(r.stdout as string)
    expect(parsed.length).toBe(1)
    expect(parsed[0].entryCount).toBeGreaterThan(300)
    expect(parsed[0].entryCount).toBeLessThanOrEqual(650)
  }, 120_000)

  it("package.json 发布就绪：无 private、版本单轨、bin 与 postinstall 齐备", () => {
    expect(pkgJson.private, "private:true 会阻断 npm publish").toBeUndefined()
    expect(pkgJson.version, "package.json 版本须与展示版本单一源 version.ts 同值（单轨）").toBe(VERSION)
    expect(pkgJson.bin).toMatchObject({
      "context-insight": "./bin/context-insight.mjs",
      "ctxi": "./bin/context-insight.mjs",
    })
    expect(pkgJson.scripts?.postinstall).toBe("node scripts/postinstall.mjs")
    expect(pkgJson.license).toBeTruthy()
    expect(pkgJson.engines?.node).toMatch(/>=22\.14/)
    expect(pkgJson.repository).toMatchObject({
      type: "git",
      url: "git+https://github.com/guixu-labs/context-insight.git",
    })
    expect(pkgJson.homepage).toBe("https://github.com/guixu-labs/context-insight#readme")
    expect(pkgJson.bugs).toEqual({ url: "https://github.com/guixu-labs/context-insight/issues" })
    expect(pkgJson.publishConfig?.access).toBe("public")
  }, 120_000)

  it("CLI bundle 可运行：dist/cli.mjs --version 输出与展示版本一致（node_modules 内别名免疫）", () => {
    const build = spawnSync(process.execPath, ["scripts/build-cli.mjs"], { cwd: PKG_DIR, encoding: "utf8", timeout: 120_000 })
    expect(build.status, `build-cli.mjs 失败:\n${build.stderr}`).toBe(0)
    const r = spawnSync(process.execPath, ["dist/cli.mjs", "--version"], { cwd: PKG_DIR, encoding: "utf8", timeout: 60_000 })
    expect(r.status, `dist/cli.mjs --version 失败:\n${r.stderr}`).toBe(0)
    // 品牌前缀格式（`Context-Insight v0.2.x`，与 cpx 风格对齐），版本号单源在 VERSION
    expect(r.stdout.trim()).toBe(`${BRAND_NAME} v${VERSION}`)
  }, 120_000)
})

describe("release registry verification workflow", () => {
  const publishWorkflow = fs.readFileSync(path.join(PKG_DIR, ".github/workflows/release-publish.yml"), "utf8")
  const promoteWorkflow = fs.readFileSync(path.join(PKG_DIR, ".github/workflows/release-promote.yml"), "utf8")

  it("publish 在发布后验证所选 tag，且不直接移动 latest", () => {
    const publishStep = publishWorkflow.indexOf("name: Publish packages to selected dist-tag")
    const verifyStep = publishWorkflow.indexOf("name: Verify selected dist-tag")
    expect(publishStep).toBeGreaterThan(-1)
    expect(verifyStep).toBeGreaterThan(publishStep)
    expect(publishWorkflow).toContain("--wait-seconds 300 --poll-seconds 30")
    expect(publishWorkflow).not.toContain("dist-tag add")

    const publishJob = publishWorkflow.slice(publishWorkflow.indexOf("\n  publish:"))
    expect(publishJob).toContain("if: inputs.mode == 'publish'")
    expect(publishJob).toContain("name: Verify selected dist-tag")
    expect(publishWorkflow).toContain("prepare-beta-version.mjs --print")
    expect(publishWorkflow).toContain("source_sha")
    expect(publishWorkflow).toContain("name: Create beta release tag")
    expect(publishWorkflow).toContain("VERSION: ${{ steps.version.outputs.version }}")
    const validateStart = publishWorkflow.indexOf("name: Validate release identity")
    const validateEnd = publishWorkflow.indexOf("\n  build:", validateStart)
    const validateStep = publishWorkflow.slice(validateStart, validateEnd)
    expect(validateStep).toContain('--version "$VERSION"')
    expect(validateStep).not.toContain('--version "${{ needs.preflight.outputs.version }}"')
    expect(fs.readFileSync(path.join(PKG_DIR, ".github/workflows/release-dry-run.yml"), "utf8"))
      .toContain("name: Apply automatic beta version")
  })

  it("promote 在移动 latest 后做有界轮询验证", () => {
    const promoteStep = promoteWorkflow.indexOf("name: Promote packages to latest")
    const verifyStep = promoteWorkflow.indexOf("name: Verify registry state")
    expect(promoteStep).toBeGreaterThan(-1)
    expect(verifyStep).toBeGreaterThan(promoteStep)
    expect(promoteWorkflow).toContain(
      '--tag latest --version "$VERSION" --wait-seconds 300 --poll-seconds 30',
    )
  })

  it("registry 验证脚本支持有界轮询而不是固定等待", () => {
    const result = spawnSync(process.execPath, ["scripts/release/verify-registry.mjs", "--help"], {
      cwd: PKG_DIR,
      encoding: "utf8",
      timeout: 30_000,
    })
    expect(result.status).toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain("--wait-seconds")
    expect(`${result.stdout}${result.stderr}`).toContain("--poll-seconds")
  })

  it("registry 慢响应时总等待严格受 deadline 约束", async () => {
    const server = createServer((_request, response) => {
      const timer = setTimeout(() => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ beta: "old-version" }))
      }, 1_200)
      response.on("close", () => clearTimeout(timer))
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing test registry port")

    const started = Date.now()
    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string; elapsed: number }>((resolve, reject) => {
        const child = spawn(process.execPath, [
          "scripts/release/verify-registry.mjs",
          "--tag", "beta",
          "--version", "9.9.9",
          "--wait-seconds", "1",
          "--poll-seconds", "30",
          "--registry", `http://127.0.0.1:${address.port}/`,
        ], { cwd: PKG_DIR })
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", (chunk) => { stdout += chunk })
        child.stderr.on("data", (chunk) => { stderr += chunk })
        child.once("error", reject)
        child.once("close", (code) => resolve({ code, stdout, stderr, elapsed: Date.now() - started }))
      })

      expect(result.code).not.toBe(0)
      expect(result.elapsed, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBeLessThan(2_000)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 10_000)

})

describe("automatic beta version", () => {
  const fakeNpm = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] !== "view") process.exit(2)
if (args[1].includes("@")) process.exit(1)
process.stdout.write(JSON.stringify({ latest: "1.0.8", beta: "1.0.6-beta.1" }))
`

  it("从 stable 基线生成下一个 patch 的 beta 版本", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-beta-version-"))
    fs.writeFileSync(path.join(tmp, "npm"), fakeNpm, { mode: 0o755 })
    const result = spawnSync(process.execPath, ["scripts/release/prepare-beta-version.mjs", "--print"], {
      cwd: PKG_DIR,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ""}`,
        GITHUB_RUN_NUMBER: "777",
        GITHUB_RUN_ATTEMPT: "2",
      },
    })
    fs.rmSync(tmp, { recursive: true, force: true })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toMatch(/^1\.0\.9-beta\.\d{8}\.777\.2$/)
  })

  it("beta preflight 不需要 tag，也不检查 package.json 预发布版本", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "beta-preflight-"))
    fs.writeFileSync(path.join(tmp, "npm"), fakeNpm, { mode: 0o755 })
    fs.writeFileSync(path.join(tmp, "git"), `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === "rev-parse") { process.stdout.write("abc123\\n"); process.exit(0) }
process.exit(2)
`, { mode: 0o755 })

    const version = "1.0.9-beta.20261128.777.2"
    const result = spawnSync(process.execPath, [
      "scripts/release/preflight-publish.mjs",
      "--version", version,
      "--mode", "publish",
      "--dist-tag", "beta",
    ], {
      cwd: PKG_DIR,
      encoding: "utf8",
      env: { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ""}` },
    })
    fs.rmSync(tmp, { recursive: true, force: true })

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain(`[release-preflight] publish: (auto) / ${version} / beta OK`)
  })

  it("显式 beta 版本只写入 runner 临时版本源，不要求仓库 check-in", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "beta-version-files-"))
    const versionPath = path.join(tmp, "src/lib/version.ts")
    fs.mkdirSync(path.dirname(versionPath), { recursive: true })
    fs.copyFileSync(path.join(PKG_DIR, "package.json"), path.join(tmp, "package.json"))
    fs.copyFileSync(path.join(PKG_DIR, "src/lib/version.ts"), versionPath)
    const lockSource = path.join(PKG_DIR, "package-lock.json")
    const lockTarget = path.join(tmp, "package-lock.json")
    if (fs.existsSync(lockSource)) fs.copyFileSync(lockSource, lockTarget)

    const version = "1.0.9-beta.20261128.777.2"
    const result = spawnSync(process.execPath, [
      "scripts/release/prepare-beta-version.mjs",
      "--root", tmp,
      "--version", version,
    ], { cwd: PKG_DIR, encoding: "utf8" })
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8"))
    const versionSource = fs.readFileSync(versionPath, "utf8")
    const lock = fs.existsSync(lockTarget)
      ? JSON.parse(fs.readFileSync(lockTarget, "utf8"))
      : null
    fs.rmSync(tmp, { recursive: true, force: true })

    expect(result.status, result.stderr).toBe(0)
    expect(pkg.version).toBe(version)
    expect(versionSource).toContain(`export const VERSION = "${version}"`)
    if (lock) {
      expect(lock.version).toBe(version)
      if (lock.packages?.[""]) expect(lock.packages[""].version).toBe(version)
    }
  })
})

describe("registry install propagation retry", () => {
  it("dist-tag 可见但 npm install 暂时 ETARGET 时会在同一 deadline 内重试", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ beta: "9.9.9" }))
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing test registry port")

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "registry-install-retry-"))
    const counterPath = path.join(tmp, "counts.json")
    fs.writeFileSync(path.join(tmp, "npm"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 'install') process.exit(2);
const prefix = args[args.indexOf('--prefix') + 1];
const spec = args[args.indexOf('--prefix') + 2];
const name = spec.split('@')[0];
const counts = fs.existsSync(${JSON.stringify(counterPath)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(counterPath)}, 'utf8')) : {};
if (name === 'cannbot-insight' && !counts[name]) {
  counts[name] = 1;
  fs.writeFileSync(${JSON.stringify(counterPath)}, JSON.stringify(counts));
  console.error('npm error code ETARGET');
  process.exit(1);
}
counts[name] = (counts[name] || 0) + 1;
fs.writeFileSync(${JSON.stringify(counterPath)}, JSON.stringify(counts));
fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
const commands = name === 'context-insight'
  ? { 'context-insight': 'Context-Insight v9.9.9', ctxi: 'Context-Insight v9.9.9' }
  : { 'cannbot-insight': 'CANNBot-Insight v9.9.9', cbi: 'CANNBot-Insight v9.9.9' };
for (const [command, output] of Object.entries(commands)) {
  const file = path.join(prefix, 'bin', command);
  fs.writeFileSync(file, '#!/bin/sh\\necho "' + output + '"\\n', { mode: 0o755 });
}
`, { mode: 0o755 })

    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [
          "scripts/release/verify-registry.mjs",
          "--tag", "beta",
          "--version", "9.9.9",
          "--wait-seconds", "5",
          "--poll-seconds", "1",
          "--registry", `http://127.0.0.1:${address.port}/`,
        ], {
          cwd: PKG_DIR,
          env: { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ""}` },
        })
        let stdout = ""
        let stderr = ""
        child.stdout.on("data", (chunk) => { stdout += chunk })
        child.stderr.on("data", (chunk) => { stderr += chunk })
        child.once("error", reject)
        child.once("close", (code) => resolve({ code, stdout, stderr }))
      })

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain("[registry-install] attempt 1: cannbot-insight@beta not installable yet")
      expect(result.stdout).toContain("[registry-smoke] context-insight@beta (9.9.9)")
      expect(result.stdout).toContain("[registry-smoke] cannbot-insight@beta (9.9.9)")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 15_000)
})
