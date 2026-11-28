// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of CANN Open Software License Agreement Version 2.0.
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 7za 唯一出处的行为锁 + 源码级锁。
//
// 现场：7zip-bin 发布包里的 7za 是 0644，全新安装后测试直接 spawn
// sevenzipBin.path7za → EACCES（status = null、stderr 空），本机因 node_modules
// 已被应用 chmod 成 755 而一直绿，Release Dry Run 的 E2E 必红。
//
// 行为锁用临时目录里的副本制造「无执行位」的状态——vitest 多文件并行，把
// node_modules 里的真二进制改成 0644 会让同一瞬间拉 7za 的别的测试文件被误伤。
// 真二进制只会被加上执行位（取源走 sevenZipBin()，与应用运行时同一动作），不会被去掉。
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureExecutable, sevenZipBin } from '@/lib/seven-zip-bin';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-seven-zip-bin-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** 复刻「全新安装」：副本权限与发布包一致（0644，无执行位） */
function freshInstallCopy(): string {
  const bin = path.join(tmpRoot, `7za-${Math.random().toString(36).slice(2, 8)}`);
  fs.copyFileSync(sevenZipBin(), bin);
  fs.chmodSync(bin, 0o644);
  return bin;
}

const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

describe.runIf(process.platform !== 'win32')('seven-zip-bin — 7za 的唯一出处', () => {
  it('全新安装态（0644）直接 spawn：status = null、stderr 空、error = EACCES——正是 CI 上的现场', () => {
    const bin = freshInstallCopy();
    const r = spawnSync(bin, ['i'], { stdio: ['ignore', 'pipe', 'pipe'] });
    // status 与 stderr 都是空的（stderr 在不同 Node 版本下是 null 或 undefined）
    expect(r.status).toBeFalsy();
    expect(r.stderr).toBeFalsy();
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('EACCES');
  });

  it('ensureExecutable：补上执行位后同一个文件即可执行；重复调用幂等', () => {
    const bin = freshInstallCopy();
    expect(modeOf(bin)).toBe(0o644);
    expect(ensureExecutable(bin)).toBe(bin);
    expect(modeOf(bin)).toBe(0o755);
    expect(spawnSync(bin, ['i'], { stdio: ['ignore', 'pipe', 'pipe'] }).status).toBe(0);
    expect(ensureExecutable(bin)).toBe(bin);
    expect(modeOf(bin)).toBe(0o755);
  });

  it('sevenZipBin：返回 7zip-bin 自带的那份 7za，且该路径可执行', () => {
    const bin = sevenZipBin();
    expect(path.basename(bin)).toBe('7za');
    expect(modeOf(bin) & 0o111).not.toBe(0);
    expect(spawnSync(bin, ['i'], { stdio: ['ignore', 'pipe', 'pipe'] }).status).toBe(0);
  });

  it('源码级锁：除 7za 模块自身外，src / tests / scripts 里没有任何地方直接读 7zip-bin 的路径', () => {
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const self = fileURLToPath(import.meta.url);
    const offenders: string[] = [];
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
          visit(full);
        } else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
          // 本文件为了扫描必然含有这个词，不计
          if (full !== self && fs.readFileSync(full, 'utf8').includes('path7za')) offenders.push(path.relative(repoRoot, full));
        }
      }
    };
    for (const dir of ['src', 'tests', 'scripts']) visit(path.join(repoRoot, dir));
    expect(offenders).toEqual(['src/lib/seven-zip-bin.ts']);
  });
});
