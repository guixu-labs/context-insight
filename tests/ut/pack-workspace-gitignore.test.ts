// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 品牌变体打包工作区防误提交哨兵：pack-cannbot.mjs 把 staging/产物目录钉在
// 仓内（OUT_DIR/STAGING），跑完打包后工作区含变体 tgz——该目录必须被
// .gitignore 覆盖，否则 git add -A 会把发布产物提交进仓（PR #3 审查意见
// 回归锁：.gitignore 曾误删仍活跃的条目）。以脚本实钉的目录名为数据源，
// 脚本改目录名而 .gitignore 未跟随时本哨兵先红。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

describe('品牌变体打包工作区防误提交', () => {
  it('pack-cannbot.mjs 的 OUT_DIR 保持被 .gitignore 忽略', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts/pack-cannbot.mjs'), 'utf8');
    const outDir = script.match(/OUT_DIR\s*=\s*path\.join\(PKG_DIR,\s*'([^']+)'\)/)?.[1];
    expect(outDir).toBeTruthy();
    const stagingDir = script.match(/STAGING\s*=\s*path\.join\(PKG_DIR,\s*'([^']+)'/)?.[1];
    expect(stagingDir).toBeTruthy();

    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n');
    for (const dir of new Set([outDir!, stagingDir!])) {
      expect(gitignore.some(l => l === dir || l === `${dir}/`)).toBe(true);
    }
  });
});
