# DSH AgentLineage 插件

插件默认托管本地 Core：Profile 启动时分配空闲 loopback 端口，健康检查通过后注册工具；退出或卸载插件时终止所属进程。数据、凭据和会话绑定保留在磁盘，下次启动可继续查询。也支持连接已有外部 Core。

支持 DSH **0.2.1-rc.2**、Cordis **4.0.5**、Node 24+、Python 3.12+；插件版本 **0.1.0-alpha.3** 配合 Core **0.1.0a10**。Python 和 Core wheel 需一次性安装，插件启动不联网下载运行时。日常使用无需另开服务终端、手填端口、调用 HTTP API 或填写 snapshot_id。

## 安装和升级

先在 context-insight 仓库的 `agentlineage/` 目录准备 Python/Core，再从 DSH 的 Fuxi DSH 插件市场安装。Git 发布目录包含 `dist/`，安装时不需要 TypeScript 编译。已有同名插件时，先通过 DSH 卸载旧版本再安装新版。

```powershell
# 从 context-insight 仓库根目录开始
Set-Location agentlineage
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install ./components/core
$env:AGENTLINEAGE_PYTHON = (Resolve-Path .\.venv\Scripts\python.exe).Path
```

从这个终端启动 DSH，在「插件」→「实验性插件 / 更多」启用「自定义插件市场」，再到「发现」→「添加索引源」添加 `https://fuxi-ailabs.github.io/dsh-plugin-market/index.json`，选择 AgentLineage `0.1.0-alpha.3` 安装。也可以从同一发布标签下载 Core wheel 安装到选定 Python；启动进程必须能从该 Python 导入 `agentlineage_core`。

需要离线打包时，在 `agentlineage/` 目录继续执行：

```powershell
Set-Location integrations/dsh
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run build
npm.cmd pack --ignore-scripts
$profile = 'lineage-managed'
$package = (Resolve-Path .\fuxi-ailabs-dsh-agentlineage-0.1.0-alpha.3.tgz).Path
dsh.cmd plugin --profile $profile add $package
```

编辑 `$env:USERPROFILE\.dsh\profiles\<profile>\cordis.patch.yml`（设置了 DSH_HOME 时使用该目录），在现有配置中添加或更新 agentlineage 行。pythonPath 使用上面解析出的绝对路径；不要覆盖其他插件配置：

```yaml
- id: agentlineage
  config:
    mode: managed
    pythonPath: 'D:/your/context-insight/agentlineage/.venv/Scripts/python.exe'
```

随后执行 `dsh.cmd --profile $profile`。已有 Web Profile 继续使用原 Web 端口，例如 3081；Core 自己使用另一个自动分配的端口。新建 Profile 的界面由所选 DSH bundle 决定，本包插入七个原生工具。Core 版本不兼容、Python 不存在、启动超时或数据目录已被另一个托管进程占用时，插件会报告启动失败并清理自身进程。

## 手动验证自己的任务

1. 在 DSH 中打开要工作的项目，创建或继续自己的会话。
2. 发送：**“请调用 lineage_status，确认 Core 能力包含 dsh-native-v4。不要显示任何 token。”** 首次查询前 binding 为 null 是正常状态。
3. 发送：**“用 DSH 的 write 工具创建 lineage-check.txt，内容为 hello；再用 edit 工具把 hello 改成 hello lineage。不要使用 shell 写文件。”**
4. 发送：**“分析我当前 DSH 任务：刷新当前会话的 Lineage 快照，列出修改过的文件，查询 lineage-check.txt 的修改来源，给出调用、回执和原文证据引用。不要让我提供 snapshot_id。”**
5. 应看到当前会话及其子会话、快照截止时间、该文件的两次确认写入。按日志重放不代表业务正确性；没有观测到的外部改动保留为未知。
6. 继续修改后发送：**“刷新当前会话的分析材料，再检查这次新增的修改。”** 快照是冻结视图，旧绑定不会在后台偷偷更新。
7. 发送：**“列出这个项目最近的 DSH 历史任务，按时间让我选一个；导入我选的任务，再分析它改了哪些文件。”** Agent 用 lineage_sessions 找到真实 ID，用户无需找日志路径。默认包含后代会话；继承自父任务的历史不重复记为子任务的写入。
8. 发送：**“打开当前分析快照的 Viewer。”** lineage_open 返回浏览器地址；凭据不出现在工具结果或 URL 中。
9. 正常退出 DSH，确认 Core 地址已无法访问；重启同一 Profile、恢复同一会话，再调用 lineage_status。绑定应保留，Core 地址可变化。

Viewer 首次访问需要在浏览器登录。默认凭据位于 `$DSH_HOME/agentlineage/<profile-hash>/core-token`（DSH_HOME 默认 `~/.dsh`）；自定义 dataDir 时位于其 `core-token` 文件。仅在本机终端读取并粘贴到登录框，不交给 Agent。配置了 tokenEnv 环境变量时用该值。Core 重启后需要重新登录。

## 自然语言与工具

| 用户意图 | 原生工具 |
|---|---|
| “当前分析服务和快照是什么状态？” | lineage_status |
| “分析我这次改了什么 / 谁改了这个文件？” | lineage_query；首次调用自动导入当前会话，先查文件目录再使用返回的准确路径 |
| “刷新当前任务 / 分析刚才选中的历史任务” | lineage_import；无需参数时导入当前任务 |
| “找这个项目昨天的任务” | lineage_sessions；按工作目录或 ID 过滤、按时间选择，支持分页 |
| “打开可视化证据” | lineage_open |
| “检查这份归因报告的证据是否完整” | lineage_check；Agent 根据查询到的原始引用构造 inquiry 文档 |
| “使用已有的某个快照” | lineage_bind；高级入口，日常导入会自动完成绑定 |

lineage_query/open/check 的 snapshot_id 均为可选，仍保留显式 ID 供高级调用。绑定按 **Profile、Core 目标、DSH 会话 ID** 隔离并持久化。导入失败或取消不替换旧绑定；已上传的原件可能保留，不承诺回滚。文件清单默认 50 项，会话清单默认 30 项；使用返回的 next 分页。

lineage_import 的 session_id 可选历史会话，include_children 默认为 true，最多 64 个会话；paths 可导入明确指定的未压缩 Claude/Codex/DevEco/DSH 原生 JSON/JSONL，最多 32 个文件、单文件 64 MiB、每次 128 MiB。会话选择与 paths 互斥。读取路径经 DSH 文件系统和当前工作目录服务；插件不会执行材料中的命令。

## 原生会话和证据边界

DSH 0.2.1-rc.2 使用 v4 事件日志；默认保存为 `sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`。插件通过 DSH sessionQuery 读取 live/cold 会话，经官方 sessionFormatCatalog 导出 v4 JSONL，Core 独立适配该格式。压缩格式和历史格式迁移由 DSH 负责。Core 不直接依赖 DSH SDK。

记录保留会话 ID、父会话、时间、seq 和原始事件。tool/call 与 tool/result 配对；PTC 的嵌套工具通过 subCallId 配对。失败或缺少成功回执的工具不算确认写入；run_code/bash 的不透明脚本不被推测为文件修改。工作目录变化参与相对路径解析。分叉继承边界之前的写入不重复归给子任务。

Core 保存的是 DSH 公共读取接口导出的冻结 JSONL 及摘要；证据坐标指向这份导出，不能声称其字节与磁盘压缩文件相同。只导入用户选择的会话树，未观测材料不标完整；没有持续后台采集和自动内存发布。自然语言分析由当前 DSH Agent 完成，Core 不另调模型。

## 配置

| 配置项 | 默认 / 作用 |
|---|---|
| mode | bundle 默认 managed；external 连接已有服务 |
| pythonPath | AGENTLINEAGE_PYTHON，否则 PATH 中的 python |
| dataDir | DSH_HOME/agentlineage/<Profile 路径摘要>；每个数据目录只允许一个托管 Core |
| startupTimeoutMs | 30000；1000–120000 |
| coreUrl | external 模式默认 http://127.0.0.1:8110 |
| tokenEnv | AGENTLINEAGE_TOKEN；managed 缺省时生成持久凭据，external 必须设置 |
| learningUrl | 未设置；不注册 Learning 工具 |
| learningTokenEnv | AGENTLINEAGE_LEARNING_TOKEN |
| enableInvestigations | false |

保留外部服务模式：

```yaml
- id: agentlineage
  config:
    mode: external
    coreUrl: 'http://127.0.0.1:8110'
    tokenEnv: AGENTLINEAGE_TOKEN
```

外部 Core 由部署方启动和停止，插件退出不会关闭它；仍需支持 dsh-native-v4 能力。远端 URL 必须 HTTPS，拒绝重定向。旧版仅传 coreUrl 的程序化配置仍推断为 external；安装新版 bundle 后请显式设置 mode。

Core 是本机进程，无需云端在线或 24 小时常驻。使用 DSH 查询时需要它运行，Profile 启动和退出会管理这个生命周期；退出后文件仍在，离线 HTML/JSON 导出和 Core CLI 也可独立使用。DSH 模型本身的联网要求取决于用户配置。

Learning 保持可选：配置后注册 lineage_cases/memory_search；显式开启 investigations 才有 lineage_investigate。它使用 Learning source IDs 和预算，不接受执行器命令或发布凭据。

## 验证

`npm ci --ignore-scripts && npm run check && npm pack --ignore-scripts`。AGENTLINEAGE_TEST_PYTHON 指向包含 Core 依赖的 Python；测试用当前仓库源码启动隔离 Core。

集成测试使用真实 Cordis、ToolRuntime、DSH filesystem 工具、SessionStore、SQLite sessionQuery、Zstandard sessionPersistence 和 subprocess provider：文件写入/修改 → 原生会话 → 快照 → 查询，历史会话、子会话、会话间绑定隔离、刷新/切换、重启、端口释放、并发数据目录和外部服务生命周期。不调用真实模型。已打包 Profile 验证记录见仓库 acceptance 文件。

2026-10-19 的 `alpha.3` 市场验收使用全新 Profile 和真实模型，完成从索引发现、固定 Git commit 安装、启用，到原生 write/edit、lineage_import/query/status/open 和 Viewer 展示。快照包含 47 条记录，查询得到 2 次 confirmed 写入、2 条变更载荷和 4 条相关原生记录。Node 插件 `0.1.0-alpha.3` 与 Python Core `0.1.0a10` 是独立版本号。该验收覆盖这一受控任务，不等于通用工具选择或语义归因质量评测。脱敏结果和发布产物摘要见 [市场验收记录](../../acceptance-evidence/dsh-market-alpha3.json)。
