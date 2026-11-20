# UT CI 逻辑测试逐文件审计

> 快照：2026-11-20，源码提交 `1798d88`。
> 候选范围：`tests/ut` 中按依赖特征属于“纯逻辑”或“文件系统类”的 108 个文件；不包含组件、API、DB、CLI、contract 等已明确分层的文件。
> 完整数据：[`UT_CI_AUDIT.csv`](./UT_CI_AUDIT.csv)。建议首批集合：[`UT_CI_MANIFEST.json`](./UT_CI_MANIFEST.json)。

## 结论

- 首批 UT CI 建议纳入 **51 个文件**：41 个 `ut-pure` + 10 个 `ut-fixture`。
- 实测 **665 个测试全部通过**，总计约 **7.7 秒**。
- `ut-pure` 单独运行：41 个文件、428 个测试、约 6.4 秒。
- `ut-fixture` 单独运行：10 个文件、237 个测试、约 2.7 秒。
- 另有 11 个文件需要先拆分纯逻辑与 I/O/契约用例，拆分后再补充纳入。

## 纳入规则

1. 断言对象必须是函数返回值、纯数据变换、事件/规则输出或内存态投影。
2. 可以使用仓库内固定夹具，但不得写共享状态、连接 SQLite、访问网络、启动子进程或渲染浏览器/Ink。
3. 性能阈值、压力矩阵和耗时对照不进入快速 UT。
4. 源码树/文本扫描属于 contract，不冒充行为单测。
5. 同一文件混层时先拆分，不把整个文件硬塞进 UT。

## 审计分布

| 结论 | 文件数 | 静态用例声明 | 说明 |
|---|---:|---:|---|
| `ut-pure` | 41 | 428 | 纯逻辑，可直接进入快速 UT |
| `ut-fixture` | 10 | 232 | 只读固定夹具/隔离配置，可进入 fixture UT |
| `split-before-ut` | 11 | 260 | 需拆分文件后再纳入 UT |
| `perf` | 4 | 22 | 性能/压力测试，独立运行 |
| `pipeline` | 17 | 136 | 导入/解析管线集成 |
| `service` | 8 | 42 | 服务编排或 mock 依赖 |
| `infra` | 12 | 96 | 真实文件系统/进程/socket/构建环境 |
| `lake` | 3 | 10 | lake/Git/LFS/凭据环境 |
| `contract` | 2 | 4 | 源码结构契约 |
| **合计** | **108** | **1230** | |

## 首批纳入 UT CI

### ut-pure：41 个纯逻辑文件

| 文件 | 静态用例 | 说明 |
|---|---:|---|
| `tests/ut/active-time-cap.test.ts` | 2 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/bigint-json.test.ts` | 2 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/bridge-builder-opencode2-subagent.test.ts` | 7 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/bridge-builder-reuse-dispatch.test.ts` | 3 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/bridge-builder-spawn-forms.test.ts` | 5 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/bridge-builder-subagent-handback.test.ts` | 2 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/bridge-reuse-dispatch-window.test.ts` | 4 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/chart-geometry.test.ts` | 6 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/cost-calculator.test.ts` | 12 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/data-service.test.ts` | 7 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/dispatch-skill-events.test.ts` | 7 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/dispatch-tools.test.ts` | 23 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/export-kernel.test.tsx` | 12 | 离线内核 fetch 合成与投影逻辑；无浏览器真实渲染。 |
| `tests/ut/file-restore.test.ts` | 26 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/framework-display.test.ts` | 5 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/input-reconstruct.test.ts` | 14 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/lake-files-root.test.ts` | 3 | 只验证环境变量到路径的决议顺序，不读写真实文件。 |
| `tests/ut/lake-lfs-resolution.test.ts` | 4 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/lake-token-prompt.test.ts` | 7 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/merge.test.ts` | 21 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/offline-kernel.test.ts` | 2 | 离线内核请求合成逻辑；无 DB/网络，使用内存数据。 |
| `tests/ut/phase-split.test.ts` | 6 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/run-edge-geometry.test.ts` | 8 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/run-time-summary.test.ts` | 3 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/score-export-name.test.ts` | 3 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/scoring-rule-scores.test.ts` | 7 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/scoring-workflow-scope.test.ts` | 3 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/skill-content.test.ts` | 35 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/skill-invocations.test.ts` | 17 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/subagent-timing.test.ts` | 6 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/swimlane-lanes.test.ts` | 10 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/swimlane-slots.test.ts` | 6 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/tool-call-errors.test.ts` | 41 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/tool-conventions.test.ts` | 38 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/turn-align-manual.test.ts` | 12 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/turn-align.test.ts` | 15 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/turn-block-order.test.ts` | 4 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/turn-search-grammar.test.ts` | 12 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/turn-search-toolname.test.ts` | 5 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/turns-query.test.ts` | 12 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |
| `tests/ut/zip-store.test.ts` | 11 | 直接验证纯函数/纯数据转换，无 DB、浏览器、网络、进程或可变文件状态。 |

### ut-fixture：10 个固定夹具/隔离配置文件

| 文件 | 静态用例 | 说明 |
|---|---:|---|
| `tests/ut/adapters/claude-jsonl-skill-merge.test.ts` | 3 | 只读取仓库内固定夹具，断言确定性解析/算法结果，无共享可变状态。 |
| `tests/ut/bridge-builder.test.ts` | 31 | 读取固定 synthetic JSON，核心是纯 bridge 构建逻辑。 |
| `tests/ut/dsh-decode.test.ts` | 15 | 读取固定 zstd 夹具验证解码逻辑，可作为 fixture UT。 |
| `tests/ut/execution-split.test.ts` | 22 | 读取固定 synthetic JSON 验证纯 execution 聚合。 |
| `tests/ut/file-reads.test.ts` | 36 | 主要验证读区间归并/覆盖算法，夹具只读。 |
| `tests/ut/normalize.test.ts` | 14 | 读取固定 synthetic JSON 验证 normalize 字段规则。 |
| `tests/ut/run-reader.test.ts` | 15 | 读取固定 manifest 验证 reader/index 纯解析。 |
| `tests/ut/run-view-model.test.ts` | 30 | 读取固定 run fixture 验证 view-model 纯投影与布局。 |
| `tests/ut/scoring-profile.test.ts` | 17 | 主要验证 profile sanitize/apply 与模板，仅用隔离目录承接模块配置。 |
| `tests/ut/turn-split.test.ts` | 49 | 读取固定 synthetic JSON 验证纯 turn/tool/skill 切分。 |

## 需要先拆分再纳入

- `tests/ut/adapters/claude-agent-injection.test.ts`：指纹分类是纯逻辑；readSession 读取 JSONL 夹具属于 adapter 集成，需拆文件。
- `tests/ut/adapters/claude-jsonl.test.ts`：同时覆盖解析规则与临时文件目录发现，建议拆成 parser UT 和 adapter IT。
- `tests/ut/adapters/index.test.ts`：registry 查找是纯逻辑；listSessions/readSession 依赖真实目录，需拆分。
- `tests/ut/bench-report-overlay.test.ts`：评分重算逻辑有价值，但测试通过临时文件驱动，建议拆纯重算与文件 overlay。
- `tests/ut/context-window-config.test.ts`：内置表是纯逻辑；外部 config 通过临时文件覆盖，建议拆分。
- `tests/ut/envelope.test.ts`：信封读写是纯逻辑；同时扫描源码字面量属于 architecture contract，需拆分。
- `tests/ut/lake-credential-plan.test.ts`：决策函数是纯逻辑；另含设置页源码接线扫描，需拆分。
- `tests/ut/scoring-v2-core.test.ts`：绝大多数为纯评分算法；含一个文件存储用例，建议拆分。
- `tests/ut/scoring-v2-dims.test.ts`：绝大多数为评分维度纯逻辑；少量 baseline/profile 临时目录用例，建议拆分。
- `tests/ut/skill-dispatch-display.test.ts`：grouping 提取是纯逻辑；同时通过 JSONL adapter 建 turn，建议拆分。
- `tests/ut/system-structure-dispatch.test.ts`：提取器是纯逻辑；多数用例通过真实 JSONL 文件驱动，建议拆分。

## 不纳入 UT 的逻辑候选

### perf

- `tests/ut/compare-perf/banded-dp-correctness.test.ts`（10 个声明）：含 500~4000 规模与耗时阈值，应进性能/回归 lane，不占快速 UT。
- `tests/ut/compare-perf/estimate-time.test.ts`（10 个声明）：主体是估算公式，但包含真实 align 耗时对照，建议拆出纯公式 UT。
- `tests/ut/turn-align-hard.test.ts`（1 个声明）：硬对齐压力矩阵，应归 perf。
- `tests/ut/turn-align-stress.test.ts`（1 个声明）：复杂对齐压力矩阵，应归 perf。

### pipeline

- `tests/ut/adapters/context-insight.test.ts`（5 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/claude-jsonl-capture-read.test.ts`（10 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/claude-jsonl-queued-message.test.ts`（4 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/claude-jsonl-skip-logging.test.ts`（6 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/claude-jsonl-truncated-turn.test.ts`（3 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/codex-chain.test.ts`（10 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/codex-exec-error-channel.test.ts`（10 个声明）：adapter 读取 JSONL 后串 turn-split，属于导入管线集成。
- `tests/ut/compression.test.ts`（4 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/dsh-native.test.ts`（13 个声明）：覆盖磁盘布局发现、读取和建桥整链，属于 pipeline。
- `tests/ut/opencode-subagent-title.test.ts`（4 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/proxy-classify.test.ts`（15 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/run-schema-validate.test.ts`（14 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/skill-dispatch-integration.test.ts`（16 个声明）：从 JSONL adapter 到 turn-split/aggregate 的集成链。
- `tests/ut/skill-md-scan.test.ts`（7 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/tool-call-timing.test.ts`（6 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/tool-timing.test.ts`（4 个声明）：依赖 adapter/导入/文件解析整链，应归 pipeline IT。
- `tests/ut/user-injection-dispatch.test.ts`（5 个声明）：通过真实 JSONL 夹具验证 adapter 框架分流，属于 pipeline。

### service

- `tests/ut/export-service.test.ts`（10 个声明）：依赖模块 mock、fetch、store 或查询编排，应归 service/data-api。
- `tests/ut/lake-test-account-it.test.ts`（3 个声明）：mock git/fetch 验证远端测试连接编排与文案，不是纯逻辑。
- `tests/ut/lake_viewer/insight-data-recording.test.ts`（3 个声明）：mock Prisma 验证查询条件，应归 service/data-api。
- `tests/ut/run-store.test.ts`（7 个声明）：依赖模块 mock、fetch、store 或查询编排，应归 service/data-api。
- `tests/ut/scoring-mate-retry.test.ts`（3 个声明）：依赖模块 mock、fetch、store 或查询编排，应归 service/data-api。
- `tests/ut/scoring-store-and-llm.test.ts`（2 个声明）：依赖模块 mock、fetch、store 或查询编排，应归 service/data-api。
- `tests/ut/skill-audit-job.test.ts`（11 个声明）：验证 fetch/NDJSON/sessionStorage/模块级 store 编排，应归 service/component。
- `tests/ut/turn-detail-cache.test.ts`（3 个声明）：验证文件 mtime 缓存与 gzip 失效，属于 storage/runtime IT。

### infra

- `tests/ut/agent-md-scan.test.ts`（9 个声明）：依赖真实 socket/filesystem/process/日志/构建环境，应归 infra。
- `tests/ut/agent-md-session-recover.test.ts`（12 个声明）：依赖真实 socket/filesystem/process/日志/构建环境，应归 infra。
- `tests/ut/api-route-log.test.ts`（5 个声明）：依赖真实 socket/filesystem/process/日志/构建环境，应归 infra。
- `tests/ut/browse-roots.test.ts`（3 个声明）：依赖真实 socket/filesystem/process/日志/构建环境，应归 infra。
- `tests/ut/build-identity.test.ts`（3 个声明）：依赖真实 socket/filesystem/process/日志/构建环境，应归 infra。
- `tests/ut/db-env-guard.test.ts`（10 个声明）：依赖真实 socket/filesystem/process/日志/构建环境，应归 infra。
- `tests/ut/ensure-native-smoke.test.ts`（3 个声明）：依赖真实 socket/filesystem/process/日志/构建环境，应归 infra。
- `tests/ut/launcher-multi-user.test.ts`（11 个声明）：依赖真实 socket/filesystem/process/日志/构建环境，应归 infra。
- `tests/ut/launcher-ports.test.ts`（4 个声明）：真实 socket/http/进程探测，应归 infra。
- `tests/ut/logger.test.ts`（19 个声明）：依赖真实 socket/filesystem/process/日志/构建环境，应归 infra。
- `tests/ut/mate-guide-fallback.test.ts`（3 个声明）：验证真实 GUIDE 文件读取与回退路径，应归 infra。
- `tests/ut/sift-runner.test.ts`（14 个声明）：依赖真实 socket/filesystem/process/日志/构建环境，应归 infra。

### lake

- `tests/ut/lake-lfs-read-prep-it.test.ts`（2 个声明）：依赖 lake/Git/LFS/凭据环境，应归 lake IT。
- `tests/ut/lake-mirror-cred.test.ts`（4 个声明）：依赖 lake/Git/LFS/凭据环境，应归 lake IT。
- `tests/ut/lake-url-hijack-it.test.ts`（4 个声明）：依赖 lake/Git/LFS/凭据环境，应归 lake IT。

### contract

- `tests/ut/lake-zero-builtin.test.ts`（3 个声明）：源码/词表扫描哨兵，属于 contract，不是行为单测。
- `tests/ut/log-adoption.test.ts`（1 个声明）：扫描 route.ts 源码覆盖率，属于 contract。

## 已落地的首版 CI

- `vitest.ut.config.ts`：读取本目录 manifest，声明 `ut-pure` 与 `ut-fixture` 两个 project。
- `npm run test:ut`：运行两组合并入口。
- `npm run test:ut:pure` / `npm run test:ut:fixture`：分别运行两个 project。
- `.github/workflows/ut-ci.yml`：PR 到 `main`、push 到 `main` 时执行两组逻辑测试。

## 后续

1. 拆分 11 个混层文件，按纯逻辑/I/O 分家。
2. 为 `perf`、`pipeline`、`service`、`infra`、`lake`、`contract` 分别建立后续 CI lane。