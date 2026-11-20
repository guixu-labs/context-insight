# Context-Insight 测试分类清单

> 快照：2026-11-20，源码提交 `1798d88`。
> 范围：`tests/ut`、`tests/pipeline`、`tests/e2e` 以及 3 个 benchmark，共 **406** 个本地测试/基准文件。
> 完整逐文件清单：[`TEST_CLASSIFICATION.csv`](./TEST_CLASSIFICATION.csv)。

## 1. 分类口径

`kind` 按测试的**主要运行边界**做互斥分类，优先级为：placeholder/contract → CLI → component → API Handler → 真实 DB → 文件系统/进程 → 纯逻辑。

测试可以跨层。例如完整页面测试可能同时使用 happy-dom 和真实 SQLite；此时 `kind` 取其主要验证边界，`dependencies` 与 `notes` 保留附加依赖。

`area` 表示主要业务域；`recommended_lane` 是建议的 CI 分组，不代表当前已经存在对应 Vitest project。

## 2. 测试层级

| kind | 文件数 | 定义 |
|---|---|---|
| unit | 58 | 纯逻辑/领域规则，无 DB、FS、子进程或浏览器 |
| contract | 3 | 源码树/文本静态契约，锁架构或样式规则 |
| component | 73 | React 组件/页面，happy-dom 或 server render |
| api-integration | 86 | Route/Handler/API 边界集成，可能使用真实或 mock DB |
| db-integration | 34 | 真实 Prisma/test.db 数据集成 |
| filesystem-integration | 50 | 真实临时目录、文件、git 或子进程 |
| cli | 45 | Commander 命令与 Ink TUI |
| pipeline-integration | 35 | tests/pipeline 下的跨层数据/基础设施集成 |
| e2e | 18 | 真实构建、Next 服务、SQLite 与浏览器 |
| benchmark | 3 | 性能基准，不属于普通测试门禁 |
| placeholder | 1 | 无产品行为的占位测试 |

## 3. 业务域分布

| area | 文件数 |
|---|---|
| observe-ui | 125 |
| ingest | 80 |
| lake | 49 |
| cli | 45 |
| scoring-audit | 32 |
| import | 27 |
| infra | 15 |
| ai | 10 |
| performance | 7 |
| export | 6 |
| launcher | 3 |
| shared | 3 |
| release | 2 |
| build | 1 |
| test-infra | 1 |

## 4. 当前 CI 覆盖

| current_ci | 文件数 | 含义 |
|---|---|---|
| ut-ci | 51 | 新增 UT CI 在 PR/push 到 `main` 时运行 |
| explicit | 2 | release workflow 显式运行 |
| release-workflow-only | 18 | 仅 release workflow 触发时运行；普通 PR 基本不触发 |
| none | 335 | workflow 未运行 |

`npm-publish.test.ts` 和 `cannbot-pack.test.ts` 由 release workflow 显式执行；18 个 E2E spec 仍只在 release workflow 条件触发时运行。新增的 UT CI 只覆盖审计后的 51 个纯逻辑/固定夹具文件。

## 5. 建议 CI Lane

| recommended_lane | 文件数 | 建议 |
|---|---|---|
| fast-unit | 58 | 无外部状态，优先 PR 快速门禁 |
| component | 73 | 浏览器环境组件/页面测试，可与 fast-unit 并行 |
| data-api | 124 | API Handler、Prisma 与数据管线；需独立测试库并限制并发 |
| infra | 51 | 文件系统、git、进程、启动器、构建与静态契约 |
| lake | 31 | lake/mirror/LFS/upload/remote，环境依赖最重 |
| cli | 45 | Commander 与 Ink TUI |
| e2e | 18 | Playwright 全栈 |
| release | 2 | npm/cannbot 打包发布校验 |
| bench-manual | 3 | 性能基准，手动/定时运行 |
| remove | 1 | 建议删除或替换 |

推荐拆分顺序：`fast-unit + component` → `data-api` → `infra + cli + lake` → `release` → `e2e`。`data-api` 应独占测试库或控制并发；`infra` / `lake` 优先在 Linux 运行。

## 6. 关键发现

- `tests/ut` 的 350 个文件中，只有 58 个是纯逻辑测试；其余主要是 API/DB/FS/组件/CLI 测试，目录名“ut”已不能代表真实层级。
- API、DB、文件系统测试大量共享 `prisma/test.db` 或宿主机状态，是 CI 并行度和 flaky 风险的主要来源。
- `/Users/haotianchen/Desktop/huawei/2012/context-insight/tests/ut/dummy.test.ts` 是无产品行为的占位测试，建议删除。
- `/Users/haotianchen/Desktop/huawei/2012/context-insight/tests/ut/observe-api.test.ts` 实际只查询 Prisma，没有调用 API Handler，名称与验证边界不一致。
- `font-offline`、`scrollbar-gutter`、`session-retirement` 属于源码静态契约，不应和普通业务单测混在同一快速分组。
- 部分 lake/LFS 测试含 `skipIf` 或依赖 git-lfs、Linux、远端凭据；CSV 的 `notes` 已标出有条件跳过的文件。

## 7. CSV 字段

| 字段 | 说明 |
|---|---|
| path | 仓库相对路径 |
| suite | ut / pipeline / e2e / benchmark |
| kind | 主要测试层级 |
| area | 主要业务域 |
| subsystems | 测试触达的源码子系统（分号分隔，可重叠） |
| dependencies | 检测到的运行依赖（SQLite、FS、进程、浏览器等） |
| current_ci | 当前 workflow 覆盖状态 |
| recommended_lane | 建议 CI lane |
| notes | 错位、条件跳过、真实 DB、静态契约等备注 |
