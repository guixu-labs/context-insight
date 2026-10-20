# AgentLineage

本目录是 context-insight 仓库内的 AgentLineage 模块。合并职责、Insight API 和部署配置见[上层架构说明](../docs/architecture.md#agentlineage-integration)。Core/Learning 保留独立安装边界；DSH 插件当前验证版本为 0.2.1-rc.2。迁入来源与初始摘要记录在 `import-manifest.json`，本次验收记录在 `acceptance.context-insight.json`。

AgentLineage 将 Agent 的原生会话变成可查询的证据、返修链和可维护的经验。
它接收已有 Claude、Codex、DevEco、DSH v4 原生材料，不要求宿主改用新的会话格式。

当前 Core/Learning 交付为 **0.1.0a10 alpha**：可独立安装的 Core、Learning，以及消费它们的 DSH 插件。
这是可运行的首版，完整目标与后续范围保存在 [组件方案](docs/design/component-proposal.md)。
[实际接口](docs/interfaces/implemented-v1.md) 是本版调用依据，带 `-draft` 的 OpenAPI 文件仍是设计草案。

## 能力与边界

| 交付物 | 已实现 | 边界 |
|---|---|---|
| agentlineage-core | 原生材料导入、SHA-256 冻结、历史截止点查询、读写/交接证据、报告机械校验、Viewer、行级重放、离线 HTML/JSON | 不执行 Agent，不判断业务验证通过；不透明写入会让行归属断链 |
| agentlineage-learning | 问题分流、证据制卡、校验反馈重试、调用/时间/token 预算、取消与重启保护、版本化经验、词法检索、离线知识库导出 | 真实模型由显式 executor 接入；自动产物保持 draft，发布使用单独权限 |
| @fuxi-ailabs/dsh-agentlineage | Profile 托管本地 Core、原生当前/历史会话导入、按会话绑定快照、query/open/check；可选 Learning 工具 | 一次性安装 Python/Core；首次查询自动导入，后续显式刷新冻结视图；不持续采集 |

行级接手表示“记录中的哪位 Agent 修改了哪几行”。它不等于缺陷责任或语义因果。
`semantic_verified: false` 明确保留。没有收到材料的时段不算完整，快照默认 completeness=unknown。

可直接运行的 [API 示例](examples/README.md)：SDK 完整闭环与标准库 HTTP 客户端，附合成原生会话。

## 安装与运行

要求 Python 3.12+；DSH 插件开发使用 Node 24+。
在本仓库运行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e "./components/core[mcp]" -e ./components/learning
```

Linux/macOS 将解释器路径换成 `.venv/bin/python`。不需要 HMigBot、鸿蒙工程、Mongo、OBS 或 DSH。

离线导入和查看（保存命令返回的 snapshot_id）：

```powershell
agentlineage --data-dir .lineage import --name task-001 --source session.jsonl
agentlineage --data-dir .lineage query --snapshot SNAPSHOT_ID --request '{"op":"catalog","kind":"file","limit":20}'
agentlineage --data-dir .lineage lineage --snapshot SNAPSHOT_ID --path /project/view.py --at 2026-01-01T00:00:09Z
agentlineage --data-dir .lineage export --snapshot SNAPSHOT_ID --format html --output report.html
```

如未激活虚拟环境，可将命令替换成 `.\.venv\Scripts\agentlineage.exe`。
PowerShell 的原生命令引号行为依版本不同；复杂 JSON 推荐使用 Python SDK 或 HTTP JSON body。

服务、浏览器与 MCP：

```powershell
$env:AGENTLINEAGE_TOKEN = 'replace-with-your-workspace-token'
agentlineage --data-dir .lineage serve --port 8110
# 打开 http://127.0.0.1:8110，在页面输入 token
agentlineage --data-dir .lineage mcp --snapshot SNAPSHOT_ID
```

MCP 使用 stdio，提供 investigate/page/submit。investigate/page 返回可续读的 RESULT 文本帧，
submit 保存机械校验报告。HTTP、Viewer、MCP、SDK 共用同一个证据内核。

Learning 单独启动：

```powershell
$env:AGENTLINEAGE_LEARNING_TOKEN = 'replace-with-learning-token'
$env:AGENTLINEAGE_PUBLISH_TOKEN = 'replace-with-a-different-publication-token'
agentlineage-learning --data-dir .learning serve --port 8111
```

没有 executor 时可使用制卡/记忆 SDK 与 CLI；HTTP 调查返回 executor_unavailable，不会偷偷调用模型。
管理员可以通过 `--executor-config executor.json` 注入受信任程序：
`{"argv":["/absolute/path/to/executor","--profile","review"]}`。
API 不接受命令或模型密钥。预算协议与恢复规则见 [执行器契约](docs/interfaces/executor.md)。

## DSH 插件

```powershell
cd integrations/dsh
npm ci --ignore-scripts
npm run check
npm pack --ignore-scripts
```

产物包含 `cordis.patch.yml`；安装后默认随 Profile 托管本地 Core，自动分配端口与凭据。
配置 Python 路径后，可直接说“刷新当前会话的 Lineage 快照，分析这个文件的修改来源”，无需手填 snapshot_id。
历史任务通过 DSH 原生会话服务读取，包含压缩保存的 v4 日志和子会话。外部 Core 与可选 Learning 模式保留。
插件 `0.1.0-alpha.3` 可从 [Fuxi DSH 插件市场](https://fuxi-ailabs.github.io/dsh-plugin-market/index.json) 安装，市场描述为“Fuxi 团队插件目录”。安装、自然语言步骤与配置见 [插件文档](integrations/dsh/README.md)。SDK 锁定 0.2.1-rc.2；宿主升级前重跑契约测试。

## 组件化接入指引

团队项目可按 [DSH 组件化接入指南](docs/componentization/README.zh-CN.md)选择入口、拆分 Plugin/Bundle，并完成安装与验证。
默认采用五项轻量要求，优先复用已有 SDK、CLI、MCP 或资源；服务化、长任务和增量数据按需补充，不强制新增 HTTP 服务。

- 填写：[接入卡](docs/componentization/component-card.template.zh-CN.md)、[轻量验收表与 AI 指令](docs/componentization/acceptance-record.template.zh-CN.md)。
- 阅读：[说明书 PDF（含目录）](output/pdf/DSH-组件化101与接入SOP.pdf)、[验收表 PDF（2 页）](output/pdf/DSH-组件化交付验收表.pdf)。
- 下载：[完整配套文件](output/pdf/DSH-组件化101-配套文件.zip)，包含 Markdown、PDF 和四类接入示例。

## 开发、构建和交付

```powershell
python -m pip install -r requirements-dev.txt
python -m ruff check components tests scripts
python -m mypy
python -m pytest tests -q
python -m build --no-isolation components/core
python -m build --no-isolation components/learning
python scripts/verify_install.py
```

两个 wheel/sdist 分别位于 `components/core/dist` 和 `components/learning/dist`。
隔离安装脚本先只安装 Core，再安装 Learning；从新环境验证原生导入、查询、报告与持久化。
DSH 另有 TypeScript 构建、SDK 工具契约和实际 Python HTTP 跨进程测试。
[验证记录](docs/validation.md) 区分本地已运行项和未运行项；CI 配置包含 Windows/Linux，远端结果以 GitHub Actions 实际运行记录为准。

容器模板位于 [deploy](deploy/compose.yaml)。先构建 wheel，再执行 `docker compose -f deploy/compose.yaml build`。
Core 与 Learning 使用独立卷、端口和凭据，可分开启动和更换版本。当前仅支持每个数据目录一个服务实例；
没有多租户隔离、集群共享锁或 HA。公开网络入口需部署方提供 HTTPS 代理。

## 组件化判定

[七项判定](docs/component-assessment.md) 中分别记录版本、构建、独立测试、安装/替换、
第二宿主复用、职责与依赖方向的证据。HarnessCore 已接入独立组件 HTTP API 和会话/返修 UI，已用合成原生材料完成跨进程和浏览器验证；第二团队生产验收仍待完成，不能宣称七项均已达到生产标准。

Core → Python 基础库/PyYAML；Learning → Core 公共 SDK；DSH/HarnessCore → Core/Learning HTTP。
观测、冻结证据与返修关联接口见 [observations-v1](docs/interfaces/observations-v1.md)。
鸿蒙路径与阶段逻辑不进入默认内核。历史指令和 schema 的 migloop 名称保留为兼容标记；
产品与分发包名称是 AgentLineage。

来源、固定 commit、原始摘要和改造说明见 [provenance.json](provenance.json) 与 [NOTICE](NOTICE.md)。
旧项目源码在本次任务中保持不变；后续宿主适配按 [接入与迁移](docs/migration.md) 逐步替换。
