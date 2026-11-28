// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of CANN Open Software License Agreement Version 2.0.
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License in the root of the software repository for the full text of the License.

// 7za 可执行文件的唯一出处。
//
// 7zip-bin 的发布包里，各平台的 7za 一律是 0644——上游打包就没带执行位（不是某个
// 镜像剥的：registry.npmjs.org 与 npmmirror 的 tarball 字节级相同）。于是全新
// `npm install` 之后直接 spawn 即 EACCES，表现为 status = null、stderr 为空，真正
// 的原因只在 error 里——Release Dry Run 的 E2E 就是这样挂的（2026-11-28）。
//
// 纪律：应用与测试一律从这里取路径，不要直接用 sevenzipBin.path7za。本机的
// node_modules 往往已被应用顺手 chmod 成 755，直接 spawn 的测试在本机是绿的、
// 在全新安装的 CI 上必红——这是靠环境残留才通过的测试。

import fs from 'node:fs';
import sevenzipBin from '7zip-bin';

/**
 * 给二进制补上执行位；补不上（只读挂载等）不在此报，交给 spawn 报各自的原因为准。
 * 独立成函数是为了可测：回归锁用临时目录里的副本验证，不碰 node_modules 里的真文件。
 */
export function ensureExecutable(bin: string): string {
  try { fs.chmodSync(bin, 0o755); } catch { /* best-effort */ }
  return bin;
}

/** 7za 的路径（已保证可执行） */
export function sevenZipBin(): string {
  return ensureExecutable(sevenzipBin.path7za);
}
