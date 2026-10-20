# 本地交付验证

## 2026-10-19：Core 0.1.0a10 / DSH 0.1.0-alpha.2

本轮在 context-insight 的 codex/agentlineage-integration 分支实现托管 Core 与 DSH 原生会话接入；更新现有 PR #1，未合并。当前验收以 [acceptance.context-insight.json](../acceptance.context-insight.json) 和对应 evidence 文件为准，下文各版本为历史记录。

| 验证 | 本轮结果 |
|---|---|
| Windows Python 3.12：ruff / mypy / pytest | 通过；71 个源码文件；93 项测试 |
| Windows Node 26 / Ubuntu Node 24：DSH build + test | 两端各 8 项通过 |
| Ubuntu 完整 Insight UT/E2E 与类型/测试库初始化 | 255 个文件通过、1 个跳过；2231 项通过、8 项跳过 |
| 新 venv 安装 Core/Learning wheel | 通过；使用 site-packages，不依赖仓库源码 |
| 实际 DSH 0.2.1-rc.2 Profile 安装最终 tgz | 七个工具可见；Core 自动端口、默认 Profile 数据目录、自动导入和查询成功；退出后端口关闭 |
| 原生 DSH 当前/历史会话 | 真实 filesystem 工具写入/修改后可追溯；压缩 cold session、分叉子会话、刷新和持久绑定通过 |
| 现有真实 DSH 日志的隔离副本 | 34 条记录导入并查询成功；该材料无文件修改，文件清单为 0；原始内容不纳入验收日志 |
| 生命周期与异常 | 重启恢复、不同实例独立端口、同目录排他、缺失 Python、启动超时进程清理、外部服务不随插件销毁均通过 |

实际 Profile 验证可使用 scripts/verify_dsh_profile.py 重跑；它只在指定的全新目录安装隔离 Profile，可选择复制一份原生 zstd 会话做读取验证，不修改原会话。验收未调用真实模型，不代表模型自动选择工具或归因结论的质量通过。Python/Core 仍需一次性安装；Viewer 登录由浏览器处理。

## 早期交付环境（历史）

日期：2026-10-08。环境：Windows、Python 3.12.10、Node 26.7.0。
实现位于 D:/work/AgentLineage，分支 codex/component-foundation，无提交记录。
远程 fuxi-ailabs/AgentLineage 已创建为 private；未 push、未创建 PR。

## 0.1.0a1 基线记录（历史快照）

| 验证 | 结果 |
|---|---|
| python -m ruff check components tests scripts | 通过 |
| python -m mypy | 64 个源码文件通过 |
| python -m pytest tests -q | **40 passed**，最终实现快照 |
| npm run check（integrations/dsh） | TypeScript 构建通过，**5 tests passed** |
| python -m build --no-isolation components/core | wheel + sdist 成功 |
| python -m build --no-isolation components/learning | wheel + sdist 成功 |
| python scripts/verify_install.py | 新 venv 从实际 wheel 安装；原生查询、离线导出、制卡→入库→经验发布→检索→知识库导出通过 |
| npm pack --ignore-scripts | DSH tarball 成功，含入口、类型、patch 和说明 |
| 来源摘要核验 | 63 个抽取文件的 current_sha256 与工作区一致 |

测试覆盖三种原生输入、历史截止点、源摘要篡改、机械校验、行重放断链、鉴权、
跨源写拒绝、重复请求冲突、浏览器登录、服务重启、任务取消/用量结算、预算、
缺失模型用量、断点保护、制卡反馈重试、版本冲突、撤回传播和存储目录隔离。

MCP 测试使用真实 stdio 初始化、工具发现与查询；DSH 使用真实 SDK 工具定义，
向单独启动的 Python Core 进程发送 HTTP 查询。材料是合成原生记录，调查执行器是可控 fixture。
**这些结果不证明真实模型的归因质量，也不等于完整 DSH 宿主任务验收。**

隔离安装时移除 PYTHONPATH/PYTHONHOME，确认包来自新环境 site-packages、
没有 migbot 导入；先只安装 Core，再安装 Learning。安装日志摘要保存在
artifacts/installation-check.json；构建日志在 artifacts/*-build.log。

## 产物

| 产物 | SHA-256 |
|---|---|
| components/core/dist/agentlineage_core-0.1.0a1-py3-none-any.whl | 551d2902132eb4c45c1e244876e1fb6d29e570bb09db8ee78a99d13c901ea822 |
| components/learning/dist/agentlineage_learning-0.1.0a1-py3-none-any.whl | 140f8d0471334731706e551a5b703e32f252e7ba7021c03eb697ed748bc4622c |
| integrations/dsh/fuxi-ailabs-dsh-agentlineage-0.1.0-alpha.1.tgz | 见 artifacts/release-manifest.json |

artifact 目录和分发包被 Git 忽略，代码、契约、测试和 CI 配置可提交。
验证摘要使用源码内容 manifest 标识，未伪造不存在的 Git commit/tree。

## 本轮修复的验证发现

- Windows 深目录下 SQLite journal/长路径失败：统一路径规范化并增加 CLI 回归。
- 原生上传绕过 JSON 路由的幂等检查：将缓存检查放在原始上传分支之前。
- MCP 可选依赖启用后动态选项类型不匹配：补准确容器类型；报告提交标记为写工具。
- Windows 普通路径与扩展路径比较绕过经验库导出重叠限制：统一存储和导出路径并增加拒绝测试。
- 独立导出用例缺主题说明：按原接口补 topic_descriptions，未降低产品校验。

## 未执行及范围限制

- Docker 本机不可用；已提供 Dockerfile/Compose，未构建或启动容器。
- Linux/macOS 尚未本地执行；Windows/Linux CI 配置已写好，远程未 push，因此没有 CI 结果。
- 未调用真实付费模型、未配置生产 executor、未安装到完整 DSH 会话。
- 未自动采集 DSH 会话，也未修改 HMigBot/server 的原有调用方。下文 a2 已验证 HarnessCore 接入，但第二团队生产验收仍未完成。
- Viewer HTML/JS 与 HTTP 接口已验证，浏览器视觉交互未单独验收。
- 多租户、分布式 worker、exactly-once、任意跨版本数据迁移、真实模型质量评测仍非本版承诺；a2 的有限兼容验证见下文。


## 0.1.0a2：独立观测和 HarnessCore 接入

同日新增独立的 observations-v1、repair-chain-v1、原件读取与调查重读接口。
原件未转换成宿主会话格式；Core 解析和冻结证据，Learning 生成受预算约束的归因草稿。
HarnessCore 仅通过 HTTP 调用，不导入本仓源码。

| 验证 | 结果 |
|---|---|
| python -m pytest tests -q | **49 passed** |
| python -m ruff check components tests scripts | 通过 |
| python -m mypy | **65** 个源码文件通过 |
| DSH npm run check | TypeScript 构建与 **5 tests** 通过 |
| Core/Learning build | 0.1.0a2 独立 wheel/sdist 成功 |
| scripts/verify_install.py | 仅安装真实 wheel 的新 venv 完整轮转通过，未从源码或宿主 import |
| scripts/verify_upgrade.py | Core a1→a2 安装升级后既有快照 ID、原件 SHA 和可见文本保持一致 |
| 来源摘要核验 | **63** 个抽取文件无摘要差异 |
| HarnessCore 接入 | 已安装 wheel 的独立 Core/Learning 进程，经生产网关和 Agent Run UI 查询；集成验证记录归宿主工作项维护 |

最终组件 wheel 摘要：

- Core：a4362bcee3f0797fd4d3b2016154555094450108bcdb426aa2fd4601c584182a
- Learning：8ad47be0b5ec8f59488016a230e60f55f5bfa3fd1cc96bf9c3ab7651a7c0cad4

安装证据为 artifacts/installation-check.json；升级证据为 artifacts/upgrade-a1-a2.json。
本轮额外验证隐藏推理排除、长证据分段读取、全量过滤后分页、冻结页稳定性、
元数据空消息、凭据脱敏、跨快照返修保存、组件重开和原件篡改拒绝。
Core 升级用例只覆盖上述有限兼容面，不能外推任意迁移或回滚。

调查服务的实际 HTTP 制卡链路由可控 executor 验证。HarnessCore 正向调查 UI 使用可控响应；
真实跨进程测试覆盖未配置分析器时的明确拒绝。没有真实模型质量或生产部署验收。
HarnessCore 旧实时日志、子会话和优化取证仍保留，未以已完成的主会话浏览测试替代整体迁移验收。

## Core/Learning 0.1.0a4 — native live ingestion

- Independent checks: ruff passed, mypy passed (67 files), pytest passed (66 tests).
- Native append tests cover split UTF-8/lines, retries, restart cursors, source identity, atomic errors and immutable freeze. DevEco tests cover changing/deleted parts, old-revision evidence and a real HTTP payload over 1 MiB.
- Message-page contract tests cover 103 user/assistant messages with 309 tool records and pinned transport continuation while the live head advances.
- Core/Learning wheels were installed into isolated test and local service environments; HarnessCore consumes only HTTP APIs. Final production browser verification: 8 passed in HarnessCore .tmp/grouped-lineage-browser-verified.log.
- Actual localhost read-only verification confirmed a4, native live/query HTTP 200, expandable consecutive tool groups and responsive 2560/1440/390px layout. Receipt and screenshots: HarnessCore .tmp/grouped-lineage-live. This verifies local DevEco observation, not a new live Claude/Codex task or model attribution quality.
- Learning has no configured model executor in this deployment. No real semantic investigation, DSH production task or second-team production adoption is claimed.

## Core/Learning 0.1.0a5 — session names

ruff, mypy (67 source files) and 67 Python tests passed. A native DevEco title survives live/frozen queries, is redacted, and remains unchanged in an older snapshot after a live rename. Both wheels were built and independently installed into the HarnessCore test environment and local services. Actual HarnessCore session selection shows original titles with no new snapshot requests; full host verification and the development hot-reload compatibility repair are documented in its 2026-10-10-lineage-session-switch work item.

## Core/Learning 0.1.0a9：首次 remote 推送前的本地验证

日期：2026-10-12。环境：Windows、Python 3.12.10。

| 验证 | 结果 |
|---|---|
| python -m ruff check components tests scripts | 通过；安装验证脚本修改后也单独复查通过 |
| python -m mypy | 68 个源码文件通过 |
| python -m pytest tests -q | 83 passed |
| integrations/dsh：npm run check | TypeScript 构建通过，5 tests passed，包括独立 Python Core HTTP 跨进程调用 |
| Core/Learning：python -m build --no-isolation | 两个 0.1.0a9 wheel/sdist 构建成功 |
| python scripts/verify_install.py | 新 venv 从 a9 wheel 安装；Core 原生查询与离线导出、Learning 制卡/入库/经验发布/检索/导出通过，无宿主或源码导入 |

安装验证脚本现从各组件 pyproject.toml 读取版本，避免新版本 CI 仍查找 a3 wheel。
临时 PPT、测试运行目录和构建产物不纳入源代码提交。

以上验证使用合成原生材料和可控执行器，不调用真实模型，不证明归因正确率或返修业务收益。
本轮没有运行 Docker、真实 DSH 宿主任务、跨版本数据迁移或真实模型评测。
Windows/Linux 远端 CI 是否通过，应另查 GitHub Actions 实际结果。
