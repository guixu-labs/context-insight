# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Context-Insight: Session-level observability tool for LLM coding agents (opencode).
Next.js 16 App Router + Prisma 6 + SQLite. Chinese/English mixed UI.
UI version tracked in `src/lib/version.ts` — `package.json` version stays in sync (same value, for npm publish); the display source of truth is `src/lib/version.ts`.

## Commands

| Command | Purpose |
|---------|---------|
| `./start.sh` | **Production mode (default)**: auto port (21025+), kills existing server, `next build` (cached via `.next/BUILD_ID`; auto-rebuilds when sources changed) + `next start` — zero per-request compile |
| `./start.sh -u` | Same but also `npm install` first |
| `./start.sh -d` | Dev mode (`next dev`): hot reload while editing insight source; first request per route compiles on demand |
| `./start.sh -c tui` | Backend + CLI TUI mode (backend stops when CLI exits) |
| `../cpx/install.sh` | Standalone cpx installer (also invoked by `./start.sh`); capture works without insight, `cpx list` browses captures; import is insight's own job (UI / auto-import at capture exit) |
| `npm run test` | 一条命令全覆盖：pretest（tsc + 库预备）→ `vitest run`（tests/ut 组件契约 + tests/pipeline 数据管线）→ `playwright test`（tests/e2e 浏览器全栈，自举 boot-server） |
| `npm run test:pipeline` | `vitest run tests/pipeline` — 数据管线层单独跑 |
| `npm run e2e` | `playwright test` — 浏览器全栈层单独跑（首跑需 `npx playwright install chromium`） |
| `npm run test:watch` | `vitest` — watch mode |
| `npm run test:cli` | `vitest run tests/cli/` — CLI tests only |
| `npx vitest run tests/cli/unit/commands/import.test.ts` | Run a single test file |
| `npm run lint` | eslint (flat config, `eslint.config.mjs`) |
| `npm run typecheck` | `tsc --noEmit` — 全仓类型检查（含 tests/；已挂 `pretest`，`npm run test` 前自动跑，类型错最快失败） |
| `npm run build` | `next build` |

## Architecture

### Data Flow

```
opencode opencode.db (external)
  → better-sqlite3 read
  → opencode-db adapter (src/lib/ingest/adapters/)
  → normalize → turn-split → bridge-builder → execution-split
  → data-service (orchestrator)
  → Prisma write (8 models, SQLite)
```

Adapter registry in `src/lib/ingest/adapters/registry.ts`（agent-source-framework）— `SourceDescriptor` 单点声明身份（sourceType ↔ framework 映射）、解析、可选能力（子代理发现/会话原始文件集/版本提取/文件嗅探）；目前注册 `context-insight` / `opencode-db` / `codex-jsonl` / `claude-jsonl` 四源。新框架接入 = 适配器模块 + registry 一行 + import-ui 一条，data-service/API 路由/normalize 零改动。已落库会话行 → 源描述符的路由单点 `sourceOfSessionRow`（格式是文件的属性：sourcePath 内容探测优先，缺失 / 不认领才回落 framework 反查）。

### Frontend Modes (shared backend)

All three modes are pure API clients of the same `/api/observe/*` endpoints（run-first：`run/[runId]/*` 家族是唯一观测面——session 页面与 `/api/observe/session/*` 端点已退役，会话即 solo run（`solo:<taskId>`），session 处理器平移至 `src/lib/observe/session-handlers/` 由 run 转发端点消费）:

| Mode | Entry | Rendering |
|------|-------|-----------|
| **Web UI** | `src/app/page.tsx` (server component, direct Prisma) | Next.js + shadcn/ui v4 + Tailwind v4 + @base-ui/react |
| **TUI** | `src/cli/tui/App.tsx` | Ink 7 + React 19 (ESM strict) |
| **CLI** | `src/cli/index.ts` (Commander) | chalk + string-width + cli-truncate |

Run 统一工作台（`run/[runId]`）is `"use client"` with 11 tabs（Overview/Graph/Turns/Context/Audit/Perf/Skills/Files/Wire/Replay/Score；`wire`/`replay` 默认隐藏，URL `?a` 或 `NEXT_PUBLIC_SHOW_ADVANCED_TABS` 展开）fetching from `/api/observe/*`——会话以 solo run（`solo:<taskId>`）形态打开同一工作台；离线 HTML 导出 = 工作台自身即查看器：导出入口 `src/export-view/entry.tsx` 挂载本页组件，离线内核 `src/export-view/offline-kernel.ts`（静态档案 + turns/搜索/by-index/轮详情四个动态合成器）应答 fetch，装配层 `src/lib/observe/export-html.ts`（run 页头导出，全员 run 可用）。

### Key Code Paths

- **Ingest write**: `src/lib/ingest/data-service.ts` → `importSession()` — batched `createMany` (500 rows/batch) inside `$transaction` via `batchCreateMany()`
- **Ingest read**: `src/lib/ingest/adapters/opencode-db.ts` — N+1 query pattern (per-session/per-message sub-queries to `part` table)
- **Context windows**: `src/lib/context-window-config.ts` — configurable via `context-windows.json`, hardcoded defaults as fallback. Web `ContextTracker.tsx` has its own model mapping — keep in sync.
- **AI analysis**: `src/lib/ai/analyzer.ts` — only OpenAI-compatible `/chat/completions`, config in localStorage only
- **声明行级证据**: `src/lib/skill-evidence.ts` — 纯函数单点：行号读取合并（同号行矛盾即弃用并上报）、覆盖面/缺口计算、用户可读说明；`skill-content.ts`（Skills 面板原文恢复）与 `llm-workflow-extract.ts`（root 对账候选）共用，缺口只走证据提示、不写进声明正文（sift 把正文整体交 LLM 抽指令）。展示面单一出口 `SkillSourceView.tsx`（Skills 全景明细卡、离线查看器的 `SkillDetail` / `SkillCharts` 共用）：结论条写覆盖面与缺失行段（`describeMissingLines`——未读到 / 多次读取不一致弃用 / 工具输出被截断），正文行带文件行号栏，缺失的行段是独立的标记行（`layOutSource`，不可选中）落在对应行号位置——标记只在界面上：复制按钮给纯 `content`；正文区的 copy 事件由 `selectedSourceText` 接管，按「选区经过哪些正文行」现算（浏览器原生选区会丢空白行），只擦到行尾 / 行首的行不算选中。处置建议不在本面自绘——所在卡片已有 `TruncationAdviceView` 折叠条时调用方不传 `advice`，没有时（离线查看器）才传 `skillSourceAdvice(source)` 在结论条内用同一视觉源渲染。版面：结论条多占的高度由正文区让出（Skills 明细卡 `max-h-[9.5rem]` vs 全文 `max-h-60`），打开全文前后卡片总高不变；结论条的缺失段标签封顶 `MAX_GAP_TAGS` 段，其余给合计（正文里的标记行一段不少）。判得出多少说多少：恢复出全文零提示；行号不可定（兜底通道 / 注入快照）只明说「无法指出缺在哪一行」，不给行号、不编标记；没读到文件末尾时尾部标「是否还有内容未知」；首个读到的行之前的行是确定缺失，照常列出
- **工具输出截断语义**: `src/lib/tool-output-truncation.ts` — 纯函数单点：只认 harness 写入截断的固定位置（codex 结果头横幅、proxy 形态在元数据壳之后；opencode 结果尾落盘行），正文引用不算；查询超集 `TOOL_OUTPUT_TRUNCATION_QUERY_OR`（与错误超集分列——截断不是错误，不进轮级错误摘要 `errorDigest`；`tool-call-errors.ts` 的 `buildTurnErrorDigest` 是 collector / 离线内核 / 客户端回退三路共用的错误摘要组装单点），展示层 `ReadNotice.tsx`（读取事实提示的单一视觉源：`FactChip`/`FactNote` 基元按色调承载事实，另有截断痕迹衬色 `OutputSeam`）；总览不展示。Skills 侧：`collectors/skills.ts` 把技能读取候选面（`SKILL_READ_CANDIDATE_OR`，与原文恢复同宽）∪ 命中截断超集的工具调用经摄取侧同一检测（`detectSkillInvocations`）归到事件，事件带两个正交事实 `outputTruncation` 与 `readCoverage`。文案一律写「工具输出截断」（不写「已截断」），与模型输出截断（`modelOutputTruncated`）、界面展示省略严格三分。处置建议与事实分列：`toolOutputTruncationAdvice`（同文件，建议文案的唯一来源；codex 0.169.0 实测口径——实际保留 = min(`tool_output_token_limit`, 调用请求的 `max_output_tokens` 默认 10000) × 4 字节，未配置时无内置元数据的模型回落到 10,000 字节；键写在基础 `config.toml` 或启用的 profile 文件 `~/.codex/<name>.config.toml` 的顶层）只给确有可调开关的形态，opencode 落盘形态返回 null、不编建议。呈现走 `ReadNotice.tsx` 的 `TruncationTip` / `TruncationAdviceView`（悬停内嵌四段全给、可移入可复制；Skills 明细卡是每卡一条的折叠条，默认一行，不逐行重复）；声明证据的覆盖面说明经 `describeLineEvidence` 的 `advice` 参数附同一句（`CODEX_LIMIT_ADVICE`；`skill-evidence.ts` 保持零依赖，只收文本）
- **技能读取的逐次调用完整性**: `src/lib/skill-content.ts` 末段（`attributeSkillReads` 归因 → `skillReadCoveragesOf` 事件级 / `skillReadMarksOfCalls` 调用级 → `skillReadMarkOf` 合成）— 一次技能调用 agent 拿到了多少 SKILL.md，只在可证时下结论；Skills 逐次调用行（一个技能事件）与 turn 详情 Tool Calls 的工具行（`ToolCallList`，从原始参数 / 结果现算、不经 API 字段，collector / 离线内核 / 客户端三条数据路径同口径）共用一套结论。覆盖面三态（`skill-evidence.ts` 的 `coverageOfLines`）：`full` / `partial` / `unproven`；文件总行数在同一份文件的各次读取间共享（有界读自身判不出文件多长；共享范围 = 交给归因的那组调用：事件级是整个 run，调用级是当前这一轮），自己这组读取判出了总行数则优先用。行范围标记必须由引擎给出（`ShellRestoreEntry.rangeLimited` ← `sed`/`head`/带行号的转储自带范围；Read 通道 = offset/limit），不得按命令文本里出现 head/sed 猜。合成规则：拿到全文 → 不标（被截断的调用缺的部分由同轮另一次读取补齐也不标）；输出被截断 → 琥珀「工具输出截断」，能定行号时写 agent 实际读到的行，否则写输出规模；命令自带行范围而没读全 → 中性灰「部分读取」；证明不了 / 无从判定 → 不标。结论落点：事件级是标记 + 说明行（悬停给互补的输出规模），工具行只有标记（悬停即结论）。行号证据的可信前提：Read 通道被运行环境截断且输出不带行号时行号是按 offset 推算的，不给行级证据；shell 引擎对无编号转储被截断、后随别的输出段且锚点落在丢弃段的尾段不归因（`tailTrusted`，否则后随输出会冒充文件行）
- **CLI client**: `src/cli/client.ts` — InsightClient with 17 methods across `/api/observe/*`, `/api/ingest/*`, `/api/ai/*`
- **CLI types**: `src/cli/types.ts` — `Api`-prefixed interfaces to distinguish from `src/lib/shared/types.ts`
- **导出 SQLite（会话独立导出件）**: `src/lib/ingest/export-service.ts` — insight 容器格式（`ExportMeta` 格式头 + N 行 `Session` 及各自派生行）的唯一写管线，按行导出、一杆多行：`exportSessionRows(rowIds)`（run 作用域 = solo 1 行 / bundle 全员成员行；任一行缺失整体失败、临时件原子改名）与 `exportSession(taskId, framework)`（回收站按行归档的单行入口，委托前者）。读回 = `adapters/context-insight`（导入向导 / `ctxi import` / 回收站恢复同一入口；导入侧既有口径：零轮次会话不落行）。端点 `GET /api/observe/run/[runId]/export-db`（run 级聚合，非成员视图转发，scope 解析复用 run 域单点）——工作台页头「导出」菜单的「SQLite 数据库」条目与 CLI `ctxi export` 同一端点（`api/ingest/export-session` 已退役）。文件名单一源 `src/lib/observe/export-name.ts`（前缀 `context_session_` 是导入侧前缀嗅探信号；solo 用 taskId、bundle 用 `run_<name>`；响应头给 ASCII 折叠 + RFC 5987 `filename*`）；浏览器落盘单点 `src/lib/observe/export-download.ts`（`saveBlob`：File System Access API 可用走另存为对话框，否则回落 Blob 锚点，用户取消静默；`fetchExportFile` 是 GET 型文件端点的取流收尾，文件名以响应头为准）——页头导出菜单四个条目（SQLite / 原始文件 zip / Markdown / 离线 HTML）共用
- **导出原始文件归档（zip）**: `src/lib/observe/session-archive.ts` — 把一个 run 在源端的原件按原格式打成一个 zip，规则一句话「有原件出原件（字节保真，已压缩形态原样 STORE），没有原件出导出 db（该会话一行经 export-service 导出后压 7z）」。两步：`planSessionArchive`（只看盘不动盘，算出布局与清单）→ `buildSessionArchive`（落盘临时件，调用方读完删除）。判定单点 `src/lib/ingest/session-files.ts`（`resolveSessionFiles`：会话行 → 原件在不在、是哪些；「没有」的原因三分 `no-source-path` / `no-per-session-files`（opencode 共享库，拆不出单会话原件）/ `source-missing`，消费方照实转述不猜不补）。发现规则不在消费方——各源在 `SourceDescriptor.listSessionFiles(dbPath, sessionId)` 自持（产出带角色的 `SessionFileRef`：`role` = main / meta / subagent / subagent-meta，`filePath` = 盘上真实路径与真实形态，`relPath` = 会话目录内相对路径——子代理在 `subagents/` 下，DSH 的子日志与主日志同名靠 `subagents/<id>/` 一层区分；返回 null = 该源没有会话级原件，空数组 = 有原件但主文件已不在盘上）。与 `readSubagents` 同一发现：claude = `listSubagentSessions`（主文件双形态解析单点 `resolveCaptureFile`）、codex = `listSubagentRolloutFiles`、DSH = `discoverSubagentSessions`、context-insight = 导出件整件；opencode-db 不实现。会话行 → 源描述符的路由单点 `registry.sourceOfSessionRow`（deltaRefresh 与本链路同用）。归档布局 = bundle 布局的会话段（`sessions/<sid>/<sid>.jsonl.7z` + `subagents/…`）+ 包根 `export-manifest.json`（`format: session-archive`、`version: 1`，逐会话记 `kind: originals | db`、缺失原因与每个文件的原路径；不得叫 `manifest.json` / `workflow.json`——那是 bundle 锚文件名）。端点 `GET /api/observe/run/[runId]/export-archive`（文件流式回包，可过 4GB）与 `…/export-archive/plan`（预检：只看盘，回答谁有原件、谁会用导出 db 代替；对外形态在零依赖的 `src/lib/observe/archive-plan.ts`——它不依赖装配模块，任何一侧引它的类型都不会把 better-sqlite3 链拖进浏览器包）；文件名 `archiveExportFileName`（`context_session_<…>.zip`）。CLI `ctxi export --archive`。写入器 `src/lib/zip-store.ts`（`writeZip` 流式：bytes 条目大小 / CRC 事先已知 → 写本地头、无描述符；stream 条目 → 数据描述符 + zip64，压缩形态扩展名 STORE 其余 DEFLATE；`buildZip` 内存条目，async）。数据仓装配 `lake.stageInsightSession` 的直传分支复用同一文件集（直传只认 claude / codex 两族 jsonl 源，归一成仓内 claude 布局；DSH / opencode / .db 源走 DB 导出兜底）。不从库里的归一化数据反推 jsonl，不带 run 的 workflow.json 进包；导入侧不接受 zip（有意不闭环）
- **Run 工作台页头（单行应用栏）**: `src/components/run/header/` — `RunWorkbenchHeader` 三段同排、tab 导航居页头正中（左右两翼 `flex: 1 1 0` 等权平分「页头宽 − 中段宽」，中段按内容宽度——右翼 chip / 动作增减不牵动 tab 条位置；某一翼内容超出自己那半份时中段才向另一侧让位；居中不靠中段 `margin: auto`），页面加载 / 错误 / 就绪三态共用同一外壳 `RunWorkbenchShell`；加载态 tab 条以真身作骨架（`RunTabBar` 的 `pending`：禁用 + 呼吸，数据到达只解除禁用）。`RunHeaderActions`（同步 chip / 刷新 / 导出菜单 / 上传）不读宿主能力，动作在不在场由入参决定（null = 不渲染，离线档案即无动作区）；导出是一个菜单一个图标钮（`ui/dropdown-menu.tsx`，@base-ui/react Menu，iOS 风格：条目只有标题一行、不挂副标题，高亮是条目自身的圆角衬底，面板半透明 + 背景模糊、不加整页遮罩；开合只动 transform / opacity，从触发角缩放 95%→100% + 淡入 150ms，用过渡而非关键帧以便快速反复开合时平滑折返），条目由入参 `exports` 列表给出（`data-run-export` 锚点），进行中的一条标题转灰、右端挂转圈（`trailing`）；菜单是静态入口，开合不触发取数。密度按页头自身宽度（`@container`）让位、导航最后让：上传钮 / chip 文字（页头 < 1420px 收成图标）→ 像素间距（< 1100px，与品牌字标收起同档：图标钮 28→24、组内边距与两翼留白各收一档——1024 宽的 9 个 tab 才放得下）→ tab 条横滚。阈值是 Tailwind 类名字面量，单点在 `RunWorkbenchHeader`（`HEADER_*`）与 `BrandLockup`；页面 chrome 不要再写回 `page.tsx`
- **Run Turns 顶部时间线**: `src/components/run/turns-timeline/` — `RunTurnsTimeline` 外壳（工具条：折叠 / 摘要 / 测距 / 休眠阈值 / 缩放；版面 = 一个纵向滚动容器装「吸顶轴行 + 名列与道 + 吸底横向滚动条」——道多的 run 包纵向翻看时轴与滚动条常驻、名列与道天然同步，横向位置只有一个来源（道区 `scrollLeft`），轴区镜像它；选中效果 = iOS 风格的选中层（只用条子本色的填充、不用描边）：轴上居中于起点滑一枚实色时刻胶囊，道上横贯一束同色柔光（以光效为主：选中条是柔光的实心核、两侧各渐隐 8px，两者必然重合；选中条与柔光都是恒定宽度的细条（4px / 20px），落在所选轮起点，不随轮次时长伸缩），所属条子上那一段浮起成同色胶囊；道内不画竖向网格线，时间只看横坐标；按条子自己的可见轮判归属、零宽轮也保底可见；只动 transform / width / opacity（`.turns-sel-slide`），缩放 / 首帧由 `data-sel-instant` 关掉过渡直接落位；几何与配色在纯模块 `selection-geometry.ts`；普通模式不立游标线，测距模式的瞄准线直写 DOM 不进渲染）、`TimelineLanes` / `TimelineLane`（逐道 memo——换选只重渲染「上一选 / 当前选」两道，横向滚动、悬停开关不重渲染条子）、`TimelineHScroll`（自绘横向滚动条：经 `source.read/write` 读写口操作道区，不持有别人的 ref）、`use-run-timeline.ts`（executions / bridges / lanes 三路 run 合并端点，URL 与离线档案的存档键逐字一致）。推导全在纯函数层：`src/lib/swimlane-model.ts`（`buildSwimlaneModel`——身份与配色 / 按派发拆条 / 槽位 / 活跃段 / 逐条与逐道的可见轮时间窗；`pickTurnAt`——时刻 → 轮次的二分解析）与 `src/lib/swimlane-axis.ts`（`buildAxis` 只为可视窗口生成刻度：放大后整段上有数千个刻度点，全画会卡）。交互口径：单击即跳（root 道整道可点、槽道只在条上可点；列表里没有行的轮——命令 caveat / stdout 附注——不作跳转目标，`AgentInterval.hidden`），走既有选中管线；测距是工具条上的显式模式，不抢导航单击；Perf 页不再放执行时间线、不取 `/lanes`。数据面：`/executions` 的 `activeIntervals[]` 逐轮带 `turnId`（`src/lib/observe/agent-spans.ts`），跳转不再拉全量轮次在客户端扫描

### Proxy 扩展：开闭原则（OCP）与文件隔离

proxy（cpx 捕获）是 insight 的扩展来源，不是核心管线的一部分。所有 proxy
特有的数据和行为必须**文件隔离**——放在独立的扩展层模块里，在 API/显示层
按需读取，**不注入核心管线**。

**参照模式**：`src/lib/ingest/adapters/claude-jsonl-full-context.ts`
- 它读 proxy 扩展字段（`system`/`tools`/`memory`/`skills`），在 turns API 层
  调用，核心管线（`readSession` → `normalize` → `turn-split` → `data-service`）
  完全不感知。
- proxy 以后加新扩展字段（`metadata`/`cache`/`retry`/`dedup` 标记…）在同一
  扩展层文件内加，核心不动。

**格式契约**：捕获/导出 jsonl 的扩展字段格式（信封冻结 + `x_lake` 命名空间 +
`(schema,version)` 声明式分发；加可选字段不升版本，改语义/类型必升版本并配 IT
锁；legacy 顶层字段 `source`/`duration_ms`/`system`/`tools` 为存量双轨）。

**红线（不得违反）**：

| 管线模块 | 能否为 proxy 改动？ |
|----------|-------------------|
| `src/lib/shared/types.ts` (`RawInteraction` 等) | ❌ 不加 proxy 专用字段 |
| `src/lib/ingest/normalize.ts` | ❌ 不透传 proxy 数据 |
| `src/lib/ingest/turn-split.ts` | ❌ 不读 proxy 扩展字段 |
| `src/lib/ingest/data-service.ts` | ⚠️ 只允许 proxy 专用的 guard（如 reshape 检测），不透传数据 |
| `src/lib/ingest/adapters/claude-jsonl.ts` | ✅ 入口分流（`classifyProxyCapture` 统一分类），行级只读标准语义字段（`source`/`stopReason`/`duration_ms`/`x_lake` core），不内联 proxy 逻辑；注入分类单点调 `injections/` 分发（cpx 把异框架捕获归一成 claude 布局，本适配器是通用格式入口，不持有异框架指纹） |
| `src/lib/ingest/adapters/injections/` | ✅ 框架注入分类层（纯函数，无 fs）：指纹规则框架自持（`claude-code.ts`/`codex.ts`/`opencode.ts` 家族），`index.ts` 按行级 `source` 标记 → `agentFrameworkOf` 分发；新框架 = 新指纹模块 + 分发表一行（设计见 agent-source-framework §2.5b） |
| `src/lib/ingest/adapters/system-structure/` | ✅ 系统提示结构层（读侧对偶 injections/，纯函数无 fs）：memory/skills 结构段与结构化解析框架自持（`claude-code.ts`/`codex.ts`/`opencode.ts` 家族），`index.ts` 按行级 `source` 标记分发；消费侧 `readFullContext`/`readAvailableSkills` 零框架分支，禁止格式试探序嗅探（设计见 agent-source-framework §2.5c） |
| `src/lib/ingest/proxy-classify.ts` | ✅ proxy 统一分类器（meta > 行级 `source` 标记 > wire 指纹），只产出 Session.framework/version 元数据 |
| `src/lib/ingest/adapters/claude-jsonl-full-context.ts` | ✅ proxy 扩展层（system/tools/memory/skills + requestParams + 可用 skills 全集） |
| `src/lib/observe/session-handlers/wire-rounds.ts` | ✅ wire 轮次处理器（平移自 session 端点，由 `run/[runId]/wire-rounds` 转发消费）直接解析捕获 jsonl（roundIndex 以 `x_lake.data.roundIndex` 为权威） |
| `src/app/api/observe/turn/[turnId]/route.ts` | ✅ API 层调扩展层读 proxy 数据（像 `readFullContext`；处理器平移至 `src/lib/observe/session-handlers/turn-detail.ts`，路由委托） |

**判定标准**：如果改动让 native（非 proxy）的 `RawInteraction` /
`NormalizedInteraction` / `TurnRow` 的字段值发生变化（哪怕是 `?? null`），
就违反了 OCP。native 路径必须**逐字节不变**——靠架构隔离保证，不靠约定+测试。

## Constraints & Gotchas

- **lake 仓布局（同 sid 双记录）**：不变量是「sid × 记录类 全仓唯一」——wire 捕获占裸 `<sid>/`，原生 claude 会话占 `<sid>.native/`（目录内文件用真实 sid 命名）。目录名推导/还原一律走 `sessionFolderOf` / `parseSessionFolder`（mirror.ts），不要手拼 `.native` 后缀；按 sid 定位仓内会话的代码必须带记录类维度（`locateSessionLocations` / `materializeSession` / `uploadFolder` 的 recording 参数，缺省 capture 兼容存量）

- **framework 值域（方案一：同 sid 双会话）**：proxy 捕获行 = agent 框架 + `-proxy` 后缀（`claude-code-proxy` / `opencode-proxy` / `codex-proxy` / `cannbot-proxy`），与同 sid 原生会话共存两行。**判断一律走谓词，禁止对 framework 裸等值**：格式判断用 `isClaudeFormatSession`（放行 `-proxy` 变体）、agent 归属用 `agentFrameworkOf`（剥后缀）、proxy 与否用 `isProxyVersion(version)`；按 taskId 解析会话的 API 必须接受 `framework` 消歧参数（同 sid 可能两行）

- **双名发布（cannbot 品牌变体）**：`node scripts/pack-cannbot.mjs` 产出 `cannbot-insight` 同内容变体 tgz（staging 精确字面量替换 + 每规则 minHits 哨兵，源码仓零改动）。新增/改动品牌字面量（显示名 `Context-Insight`、CLI 别名 `ctxi`、bin 文件名、数据目录 `~/.context-insight`、env 前缀 `CONTEXT_*`、`context-smart-agent` 服务标识、导出前缀 `context_session_`、lake 机器提交身份）时必须同步 `scripts/pack-cannbot.mjs` 规则表与 `tests/e2e/cannbot-pack.test.ts` 泄漏哨兵；格式契约（`BRAND_SOURCE_TYPE` / `x_lake` 信封键 / `LAKE_*` env 名 / framework 值）**不得品牌化**——两品牌数据互通靠它们
- **ESM strict** (`"type": "module"` in package.json) — no `require()`, use `import`
- **Ink v7 has no lastFrame/frames/output** on native `render()` — use `ink-testing-library` for tests only
- **No third-party Ink components** — ink-table/ink-select/ink-spinner incompatible with Ink v7; self-implement all components
- **CJK width**: Chinese chars = 2 columns; use `string-width` for all text measurement in CLI
- **Zero Prisma schema changes** for feature work — computed data built at API/render time, not persisted
- **Turn model has no `cost` field** — set `cost: 0` in API mapping, strip from `TurnRow` before Prisma write
- **`createdAt_ts` is nullable DateTime** — fallback to `createdAt` with `.toISOString()`
- **Hydration error**: inner expand buttons must be `<span role="button">` not `<button>` to avoid nesting
- **`response_format: { type: "json_object" }`** required for AI analysis — no fallback
- **LLM 端点 URL 归一（成对权威源）**: TS 一律 `import { buildChatUrl } from '@/lib/ai/analyzer'`，Python 一律走 `smart-agent/trajectory_analyzer.build_chat_url`（经 `_llm_request`）——**禁止在任何调用方内联拼 chat/completions URL**。两侧同口径，改动必须双侧同步并跑两侧 parity 用例（`tests/scoring-semantic.test.ts` ↔ `smart-agent/tests/test_trajectory.py`）
- **AI input optimization**: Only root assistant/user/system turns, 30K chars budget, summaries 80 chars max
- **Git hosted on gitcode.com** — never use `gh` CLI
- **7za 的路径只有一个出处**: `src/lib/seven-zip-bin.ts`（`sevenZipBin()`）——应用（`compression.ts`）与测试一律经它取，禁止直接读 7zip-bin 的路径去 spawn（源码级锁 `tests/ut/seven-zip-bin.test.ts`）。原因：7zip-bin 发布包里的 7za 是 0644（上游打包就没带执行位，与镜像无关），全新 `npm install` 后直接 spawn 必 EACCES——`status = null`、`stderr` 为空，原因只在 `error` 里；本机 node_modules 早已被应用顺手 chmod 成 755，绕过出处的测试在本机绿、在全新安装的 CI 上必红。Release Dry Run 直接 `npm run e2e`（不经 pretest），任何靠环境残留才通过的测试在那里都会现形
- **Path alias**: Always `@/lib/...` / `@/components/...`, never relative `../../`

## Testing

- **Test DB isolation**: 测试库按 worker 分片——pretest 重建 `prisma/test.db` 黄金模板，`tests/setup.ts` 为每个测试进程复制出独立 `prisma/test-w<id>.db`（vitest isolate 默认下 ≈ 每测试文件一库；显式 `DATABASE_URL` 可越过）；禁止任何测试直连真实 `prisma/dev.db`（常驻 server 的生产库）；回归锁 `tests/ut/test-db-isolation.test.ts` + `tests/ut/worker-db.test.ts`
- **Integration over unit**: 写测试用例时，不要简单的函数级别用例，需要从页面或 API 层面进行验证
- **Data-driven**: 通过 JSON 或 DB 原始数据驱动测试，数据准备在 `tests/data/` 目录下
- **Pipeline coverage**: 测试应覆盖完整数据流（如 JSONL → adapter → turn-split → SkillEvent → aggregates）
- **功能修复必须写 IT 测试**: 每个 bug 修复或功能改进必须配套集成测试，验证修复后的完整数据流表现

## Commit Workflow

每次提交代码前必须完成以下步骤（顺序执行）：

1. **同步远端**: `git pull` — 远端可能有更新
2. **解决冲突**: 如有冲突，手动解决后继续
3. **运行测试**: `npm run test` — 全部通过才能继续
4. **更新文档**: README.md / README-zh.md（如有功能变更）
5. **版本号（owner 统一管理）**: 版本号由仓库 owner 统一管理——其他协作者（含 AI agent）一律不改动版本号、不在 CHANGELOG 预定版号；提交与 MR 保持当前版本号原样。升版时机与数值由 owner 在合并时自行拍板（改法参考：insight 为 `src/lib/version.ts` 与 `package.json` version 同步改、单轨同值；cpx 为 `src/version.ts` 与 `package.json` 同步改；CHANGELOG 的 Unreleased 段落随升版一并定版号）
6. **提交推送**: `git commit -m "[type] v0.xx: 描述"` → `[feat]` `[fix]` `[test]` `[docs]` `[chore]`

## Code Conventions

- **License header**: Every newly added source file (`*.ts`/`*.tsx`/`*.js`/`*.mjs`/`*.py`/`*.sh`) must start with the CANN copyright header. Use `//` for TS/JS, `#` for Python/shell. Verbatim text (adapt comment prefix):
  ```
  Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
  This program is free software, you can redistribute it and/or modify it under the terms and conditions of
  CANN Open Software License Agreement Version 2.0 (the "License").
  Please refer to the License for details. You may not use this file except in compliance with the License.
  THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
  INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
  See LICENSE in the root of the software repository for the full text of the License.
  ```
  See `start.sh` or any `src/app/api/**/route.ts` for the canonical copy. This is the one exception to "no comments".
- **Comments**: Don't write them unless asked
- **Doc files**: Don't create `.md` / README unless explicitly requested
- **README sync**: When features change, update both `README.md` and `README-zh.md` feature lists and tab descriptions
- **Version bumps**: owner-managed — version numbers are set exclusively by the repo owner; collaborators (including AI agents) never bump, downgrade, or reserve version numbers, and never pin a target version in CHANGELOG — commits/MRs keep current versions untouched; the owner decides bump timing and values at merge time (reference: insight = `src/lib/version.ts` + `package.json` in sync, single-track; cpx = `src/version.ts` + `package.json` in sync; CHANGELOG Unreleased section gets its version header from the owner's bump)
- **CHANGELOG 简洁**: 条目一两句说清「什么变了、用户可感知什么」——不写实现细节（函数名/内部机制/IT 清单，那些放 PR 描述）；只有功能性变化才写，小加固/杂项不单开条目
- **Badge variants**: default, secondary, destructive, outline, blue, green, orange, purple, gray, red, yellow, slate
- **UI primitives**: All from `@base-ui/react` (not radix-ui) via shadcn v4 + Tailwind v4
- **Charts**: Pure SVG, no chart libraries — match TraceView DAG style
- **Dialogs**: Use `src/components/ui/dialog.tsx` (built on @base-ui/react), never browser `confirm()`
- **Notices**: `src/components/NoticeHud` — 两种形态按「要不要用户确认」二分：瞬态（success / 缺省 warning）= 顶部横幅，自动退场；需确认（error 恒是；带必须读到的明细的警示标 `ack`）= 居中 Alert，只有「知道了」能关。变长的结果内容（报错原文 / 清单）走确认卡的 `detail`（块内滚动、可复制），不进弹窗、面板——表单面版面固定，不靠自身出滚动条收纳结果明细
- **Search history**: sessionStorage only, never persisted
