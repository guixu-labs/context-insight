// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

type UtManifest = {
  groups: {
    "ut-pure": string[];
    "ut-fixture": string[];
  };
};

const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, "tests/UT_CI_MANIFEST.json"), "utf8"),
) as UtManifest;

const groups = Object.entries(manifest.groups);
for (const [name, files] of groups) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`UT CI manifest group ${name} must be a non-empty array`);
  }
  for (const file of files) {
    if (!existsSync(path.resolve(__dirname, file))) {
      throw new Error(`UT CI manifest file not found: ${file}`);
    }
  }
}

const seen = new Set<string>();
for (const [, files] of groups) {
  for (const file of files) {
    if (seen.has(file)) throw new Error(`UT CI manifest file appears in multiple groups: ${file}`);
    seen.add(file);
  }
}

const shared = {
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
};

export default defineConfig({
  test: {
    environment: "node",
    reporters: ["dot"],
    silent: "passed-only",
    projects: [
      {
        ...shared,
        test: {
          name: "ut-pure",
          include: manifest.groups["ut-pure"],
          setupFiles: ["./tests/ut/setup-logic.ts"],
          testTimeout: 10_000,
        },
      },
      {
        ...shared,
        test: {
          name: "ut-fixture",
          include: manifest.groups["ut-fixture"],
          setupFiles: ["./tests/ut/setup-logic.ts"],
          testTimeout: 10_000,
        },
      },
    ],
  },
});
