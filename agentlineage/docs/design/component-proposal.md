# AgentLineage 组件化方案

日期：2026-10-08。状态：供新仓库立项与设计评审使用，尚未实施。工作名：AgentLineage。本文的“现有”指所列远程代码快照具备相应实现；不代表本轮已运行系统验收、核实线上部署或证明归因准确率。

## 1. 建议与目标

建议把 MigLoop、HMigBot Insight1 和服务端返修分析中可复用的能力，整理成 **AgentLineage：智能体运行溯源与经验组件集**。它回答四个连续的问题：这次任务发生了什么，产物经过谁的哪些操作，返修判断有什么证据，以及哪些经验可以用于后续任务。

推荐新仓库名 agent-lineage。对外使用 AgentLineage，中文可称“智能体溯源”；Python 包、容器与 npm 包使用组织命名空间。名称是设计工作名，尚未核验商标和各包仓库的可注册性，不以名称可用为已完成事项。备选名 RunLineage 更强调任务运行，EvidenceFlow 更强调证据处理；本方案采用 AgentLineage，因为它能同时覆盖单 Agent、多 Agent、工具、文件和任务之间的关系。

**一个新仓库，两个业务组件，另有独立发布的宿主适配包：**

| 交付物 | 单一职责 | 主要使用者 |
|---|---|---|
| AgentLineage Core | 将运行材料变成可查询、可回放、可引用的证据，并校验归因报告与证据的连接 | 人、Agent、任意 harness、观察平台 |
| AgentLineage Learning | 将固定证据快照上的调查，转成可审阅、可修订、可检索的案例和经验 | 团队知识库、任务复盘、后续执行上下文 |
| DSH 适配包 | 把 DSH 的会话事实映射进标准协议，并把查询、调查和经验能力注册给 DSH | DSH |
| HMigBot 适配包 | 把 HMigBot 的迁移、Worker/Reviewer、ECAT、工程和授权信息映射进标准协议 | hmigbot-plus、migbot-server |

Core 与 Learning 分别独立版本、构建、测试、部署和升级。它们的合集属于“组件集”，不能因为在一个仓库里就宣称具有单一职责。CLI、HTTP、MCP、Viewer 是能力入口或表现形式，不应各自复制一份分析引擎。

第一个正式通用交付形态推荐 **独立 HTTP 服务与 Viewer，支持容器/本地进程部署**；DSH 插件调用这个服务。另提供 Python SDK、离线 CLI 和 MCP 入口，使不使用 DSH 的团队也能接入。嵌入式 SDK 是方便的部署选项，但其重启会受宿主限制，不能用于证明独立重启这一项。

本次不建议一起抽走 HMigBot Loop Engine、Reviewer、ECAT、DT/Visual/HiTest 执行器、迁移资源包或遥测上传运行时。它们是执行与验证能力，可成为 AgentLineage 的证据生产者。把这些都装进本组件会丢失单一职责。

## 2. 本轮核对的代码与证据边界

| 来源 | 固定快照 | 用途 |
|---|---|---|
| hmigbot-plus/main | f86742295c5b287d00e9cd8423164611eecccc72 | Insight1、本地轨迹、链路、实时查看、比较与宿主集成 |
| migbot-server/main | 207b9eb8934b82309b5dd2709c2eede868fc8bdc | 服务端材料组装、三来源分析、调查内核、制卡、经验、任务与发布 |
| hxy450/migloop/main | a2dd2cc431a0a13a8f0c3ab29686fb5b042b8655 | 上游独立工具、打包与原始归属 |
| dsh-dog 参考实现 | 80d0543c95d171e1ec953e978272a2595e4fc974 | 已有 DSH/Cordis 插件接入模式；不是对最新 DSH API 的承诺 |

本地 hmigbot-plus 的 main 已从 c01f7fc3 快进至 f8674229，与本轮获取的 origin/main 一致。未改产品代码、未提交、未推送，原有未跟踪文件保留。

这里有一个重要现状：代码并非只有两份。服务端 REPORT_UPSTREAM.json 记录报告适配模块来自上游 af419383880cc6a8bfacdb10c1090ff2f72409e9；经验包 UPSTREAM.json 记录版本 0.10.0、运行时代码 4d7501827db00aa667808642af801ef57805ee09、指令版本 0b1f7b1339173ee5345bea609b7835222166a03d。上游 main 的 pyproject.toml 仍标包版本 0.3.0。因此不能用“上游 main 最新”推断其包含服务端全部调查与经验能力，更不能整目录覆盖。

本轮进行了远程源码、版本清单与接口阅读；未启动模型、设备、FunctionGraph 或线上发布。仓库文档里的历史测试数、真实模型制卡及云端验证记录，只是历史证据，不算本轮复测结果。

## 3. 现在完整的 MigLoop 能力是什么

### 3.1 从运行记录到可以调查的证据

| 能力 | 已有实现及价值 | 抽取时的边界 |
|---|---|---|
| 多来源材料读取 | Claude 转录、Codex rollout；服务端还支持 DevEco 的来源材料及导出 | 三个解析器不是三端自动采集器；新版本使用能力清单明确每种来源支持什么 |
| 会话与子 Agent 关系 | 展开 root/child、委派、工具调用与返回，关联多个会话 | 用显式 run/session/actor/parent ID 替换工程路径和迁移命名猜测 |
| 运行轨迹 | 消息、工具、模型、时间、token、上下文和阶段展示 | token/费用/耗时的定义和缺失状态必须保留；并行活动时间不能简单相加 |
| 轨迹报告与对比 | 自包含 HTML、会话查看、多个会话比较、journey/chain/fixchain | 报表是通用分析的消费者；鸿蒙阶段作为扩展标签 |
| 实时观察 | 上游有 Claude live；HMigBot 还存在 Codex live 适配 | 不把所有来源一概标成实时可用；必须做逐来源恢复与最终一致性验证 |
| 行级写入重放 | write/edit/delete/hunk 重放，行段最后写入者、跨作者接手和变化 | 缺基线、opaque write、edit/hunk 不匹配等返回不可重建；不能凭空补历史 |
| 文件与 Agent 的关系 | 文件读写、委派上下文、结果交付、跨会话链路 | 同名路径不等于同一实体，同一实体在不同时点也不等于同一内容版本 |
| 历史时点调查 | catalog、file、agent、search、open、blame、diff、neighbors 等 | at 是查询截止时点，不是“文件一定处于某完整版本”的证明 |
| 证据树与原文回看 | 从结论回到工具请求/回执、来源文件/行、原始内容与上下游关系 | 引用要能在固定快照重现；有搜索命中不代表 Agent 当时读取或采纳 |
| 审计与覆盖检查 | 重试恢复、显式中止、缺材料、未解释写入、证据关系检查 | 工具成功不等于功能验收；日志缺失不等于行为未发生 |

### 3.2 从返修调查到案例和经验

服务端已经存在较完整的处理流程：准备并校验材料清单，模型筛选返修任务，多个 worker 调查制卡，机械检查并反馈修改，串行归并经验，校验后发布 Git 版本及对象存储镜像。实现还包括任务租约、心跳、断点、已完成卡片复用、已有发布提交识别以及失败后的显式重试。

| 能力 | 当前代码具备什么 | 不应扩大为哪种结论 |
|---|---|---|
| 返修任务分流 | 从完整材料池产生调查任务，允许无返修结果 | 无返修不等于工程没有缺陷 |
| 模型调查 | 使用查询工具逐步建立问题、修改、上下游和验证证据 | 模型解释不自动成为事实或责任认定 |
| 情景卡/案例 | 问题、适用条件、建议、未知项、证据图及版本化内容 | 一张卡交付成功不等于所有因果解释正确 |
| 机械校验与反馈 | 引用是否存在、时点是否合规、关系能否绑定、覆盖是否不足 | 不等于语义审查；当前 report 明确输出 semantic_verified=false |
| 有保留的补充关系 | 未确认关系先反馈，再允许带理由/原文的报告内 model_review 关系 | 不能把模型补充边写回原始事实图，或改标成 native confirmed |
| 经验归并 | 案例进入版本库，整理、合并、修订已有经验，导出阅读包 | 不等于自动优化业务代码或自动发布 Skill |
| 经验检索 | topic 浏览、关键词搜索、按 ID 读取、逐层展开 | 当前实现是词法检索，不是已验证的语义召回或必然命中 |
| 作业运行与发布恢复 | 租约、断点、并发制卡、串行发布、提交去重与镜像 | 不等于全链路 exactly-once，也不证明线上已经部署全部能力 |

**“返修链”应作为一等能力，而不是只保留一张轨迹图。** 其完整表达至少包括：问题或期望 → 当时可见上下文 → 相关操作与产物 → 后续修改 → 验证回执 → 对原因的解释 → 未知项 → 可复用经验。某些环节无材料时，链路应显示缺口。

### 3.3 Insight 是否一起抽取

需要一起梳理和迁移的是 HMigBot 的 Insight1。它既有 Viewer，也有会话发现、缓存、实时流、比较、链路组装和分析问答，不能简单归为“前端”。通用轨迹、查询、图形和导出进入 Core；会调用模型的调查体验接 Learning；读取 Orchestrator、EventStore、Harmony 路径、ECAT 状态的部分留在 HMigBot 适配层。

现有 /api/insight1 是本地 MigLoop 集成；/api/insight 是另外的 cannbot-insight-py 集成。本方案不默认合并后者。

## 4. 对其他产品的价值与使用场景

| 使用者 | 接入材料 | 获得的能力 | 自己仍负责什么 |
|---|---|---|---|
| DSH 任务执行 | 标准事件、会话事实、工具回执、产物引用 | 实时/离线轨迹、历史证据查询、返修调查、经验召回 | Agent 执行、工具权限、是否采用建议 |
| 其他编码 Agent | Claude/Codex/DevEco 导出或自定义适配器 | 文件演化、上下游 Agent、跨运行比较、问题复盘 | 采集授权、工作区与版本身份 |
| CI/质量平台 | 验证结果、diff、运行材料包 | 验证证据关联、变更与失败调查 | 真正执行编译、测试和发布门禁 |
| 文档/数据任务团队 | Agent 记录、文档版本、检查回执 | 谁产出和交付、返工条件、证据与案例 | 定义非代码产物的实体及质量标准 |
| HMigBot | 既有迁移记录及业务标签 | 保持原体验并使用同版通用引擎 | 鸿蒙阶段、资源包、runtime 和设备流程 |

一个完整的第二宿主验收场景应是：DSH 执行一个非鸿蒙任务，子 Agent 修改文件，后续验证失败后修复；AgentLineage 展示轨迹和修改链，调查卡能回到实际请求/回执；随后另一任务按条件读取经验。该场景应来自真实 DSH 会话，不能用直接调用 HTTP 的 mock 替代。

## 5. 组件与模块怎么划分

### 5.1 AgentLineage Core

职责是“运行证据的确定性处理与查询”。它包含 source adapters、材料索引、轨迹归一化、文件演化、证据关系、历史查询、报告机械校验、Viewer/导出，以及对应 API。它可以接收外部模型提交的归因报告，但本身不要求调用模型。

这些模块共享来源身份、证据定位和时点规则，具有较高内聚性。首期不将 parser、blame、query、renderer 各自拆成独立服务，避免跨服务一致性与多版本组合成本。

### 5.2 AgentLineage Learning

职责是“把证据调查转为可持续维护的经验”。它包含任务分流、受预算约束的模型调查、制卡、修订、经验归并、检索、版本发布及作业恢复。它通过 Core 的稳定接口获得固定快照证据，不读取 Core 私有数据库。

Learning 内部的调查 worker 与发布进程可以隔离运行，初期仍作为一个组件版本交付，以保证案例、指令、归并与经验格式兼容。只有后续出现不同团队独立交付、性能或权限边界的真实需要，再进一步拆分。

### 5.3 宿主适配与领域扩展

DSH 插件、HMigBot 本地适配和服务器适配不包含归因算法。它们负责会话事件映射、鉴权、入口注册、生命周期和链接展示。鸿蒙迁移阶段、ECAT 的 generator/discriminator、Reviewer 轮次等进入命名空间扩展，例如 extensions.hmigbot；通用模型仅保留 actor role、task、stage、artifact、verification 等基本概念。

依赖方向如下，箭头表示调用或依赖：

    DSH → DSH Adapter ───────────────→ Core 公共 API
                     └──────────────→ Learning 公共 API
    HMigBot → HMigBot Adapter ───────→ Core / Learning 公共 API
    其他宿主 → HTTP / SDK / CLI / MCP → Core / Learning 公共 API
    Learning → Core 公共 API
    Core → 公共协议与通用存储接口
    Learning → 通用存储/模型执行接口

Core 不 import migbot、migbot-server、DSH 或 Learning。Learning 不 import 宿主业务代码。所有上层回调通过协议或适配器注入，禁止基础组件反向发现宿主全局对象。领域扩展只增加已注册字段与标签，不改变默认归因规则。

### 5.4 相邻能力的关系

ECAT、verify 和 Worker/Reviewer 是证据生产者，报告执行状态、判定、证据、预算与变更范围；AgentLineage 负责连接和调查这些结果。它不替代执行引擎，不用“会话完成”推断验证通过。

Skills 在本方案有两个位置：一是被观察对象，记录具体版本、加载/调用与产物；二是 Learning 使用的调查/归并指令资产，随组件受控发布。通用 Skill DAG、Skill 自动改写、离线评测择优和自动部署属于后续优化组件；本次经验积累不能被命名为“完整的 Skills 自优化”。

## 6. 对外能力模型与归因语义

### 6.1 需要稳定的对象

| 对象 | 必需信息 | 设计理由 |
|---|---|---|
| Run | tenant/project、外部任务 ID、目标、开始/结束状态 | 替代 migration session；同一任务可包含多个执行会话 |
| Session / Actor | 来源 runtime、原生会话 ID、父会话/委派关系、角色 | 分清运行载体与参与者；允许一个 Agent 多次续跑 |
| Source | 来源类型/版本、对象摘要、大小、授权与完整性信息 | 原始材料保持不可变、可追溯；解析器升级可重建索引 |
| Event / Operation | 稳定 ID、序号、请求/完成时间、调用及回执引用 | 区分发起和完成；重传可去重，缺回执保持不确定 |
| Artifact / Revision | 工作区或仓库身份、规范化路径/URI、内容摘要及存在状态 | 防止不同工程、同名路径和不同时点内容被混为一体 |
| Snapshot | 纳入的 Source 清单、解析/索引版本、截止点、缺口 | 一次调查和一张卡引用固定材料，而不是变化中的工作区 |
| EvidenceRef | snapshot、source、物理位置、JSON pointer、内容摘要 | 引用可重新打开，不能只保存容易变的 UI 行号 |
| Relation | 两端、类型、有效时点、原文依据、来源等级 | 委派、读取、写入、交付和因果解释分开表达 |
| Finding / Case | 现象、解释、建议、边界、未知、证据、检查状态、修订关系 | 允许解释迭代，不篡改原始事实 |
| Lesson / MemoryRevision | 适用条件、建议、反例/失效条件、支持案例、版本与状态 | 检索时能说明何时可用，而不是无条件复述旧经验 |

source/runtime、调查所用模型、操作者身份是三个不同维度。解析 Codex 材料，不意味着调查 Agent 必须是 Codex；也不能用操作者所用模型证明来源 runtime。

### 6.2 四类归因必须区分

1. **操作归属**：原生回执记录谁执行了调用。它支持“观察到 A 在时点 t 修改了文件”。
2. **内容演化**：有足够基线与补丁时确定行段最后写入者、接手与 diff。它支持“这段内容最后由 B 写入”。
3. **上下文与交付关系**：记录哪个输入被读取、哪个结果被提交。它支持“这个内容通过调用进入了可见上下文”；不保证被理解或采纳。
4. **原因解释**：认为某个约束缺失、误读、交付或判断造成了后续返修。这通常是模型或人的解释，必须带依据、反证和未知项，不能自动升级成前三类事实。

举例：A 写入一个函数，B 随后修改了它，只能直接证明写入演化；B 的修改可能是需求变化、格式统一、性能优化或缺陷修复。没有原需求、失败与验证证据，不能把 A 标为“错误责任人”。

建议关系字段使用 evidence_kind：native_receipt、deterministic_replay、model_review、human_assertion；另外保存 assertion、evidence_refs、limitations。把 structural_status 与 semantic_status 分开，后者初始为 not_reviewed，只有额外语义评审才可改变。原有 semantic_verified=false 保留语义，不能因更名默认转为通过。

机械校验有效只说明引用、时点、关系和结构满足规则；已知检查命令及回执只证明对应执行行为。语义评审结果与测试判定也应独立：execution_status、verdict、evidence、environment、scope 分别记录，未知判定不能转为 pass。

### 6.3 时间、缺口与证据完整性

查询 at 为带时区的截止时间；file/agent 的输入窗口、操作完成窗口和后续可见窗口分开。文件效果通常以完成回执时点认定，调用发起不能提前当成写入成功。跨进程时钟不同步或同一时间戳无法排序时，保留 partial_order/clock_uncertainty，优先使用父子关系、原生序号和回执绑定，不强造全局因果顺序。

完整性至少区分 complete、partial、unknown，并返回缺片、截断、未导入子会话等 gaps。允许不完整材料做浏览和受限调查，但报告必须保留缺口。首次版本的自动全量返修制卡默认要求 complete；人工选择局部调查时，案例不能宣称覆盖完整任务。

complete 仅表示相对于已声明的运行范围、来源清单及可检查序号未发现缺口，不表示现实中的所有行为都有日志。上传者的 declared_complete 只是声明，不能单独使服务端判定 complete；还须核对材料摘要、会话关系、水位与已知缺片。来源自身无法证明完整性时保持 unknown。

旧 MCP 的两类 atom、文件版本推断和新 inquiry 的历史时点查询不是同一契约。通用 v1 以固定快照与 inquiry 的证据语义为主；旧 atom/version 接口仅作为兼容门面，并显式标记推断字段。

## 7. 交付形态与 DSH 插件

### 7.1 独立服务是默认复用入口

| 形态 | 如何消费 | 适用场景 | 四独立的实际限制 |
|---|---|---|---|
| Core 服务 + Viewer | HTTP 查询、上传材料、打开页面、SSE 进度 | 团队共享、不同语言与 harness | 独立镜像/进程，可独立重启升级 |
| Learning 服务 + worker | HTTP 创建调查、读卡、检索经验 | 需要模型复盘及团队经验库 | 独立镜像、模型配置、预算和发布权限 |
| Python SDK | 调用相同 domain API、离线分析材料 | Python 产品嵌入、离线工具 | 自有 wheel 与测试；嵌入模式不承诺无宿主重启升级 |
| CLI / 离线报告 | import、query、report、serve、mcp 等命令 | 单机、CI、附件交付 | 安装固定发布包；自包含 HTML 不需要运行服务 |
| MCP | 查询、证据打开、报告检查；可选调查入口 | 任意支持 MCP 的 Agent | MCP 是协议入口，不等同于 DSH 原生插件 |
| DSH 插件 | 原生插件加载、事件映射、工具注册、Viewer 链接 | DSH 用户 | 插件是否支持热卸载取决于目标 DSH；Core 独立重启不依赖它 |

自包含 HTML 导出不内嵌密钥；导出范围与敏感内容策略独立配置。远程 HTTP 上传接受明确的 blob/source 引用，不接受任意服务端路径或任意 URL。离线 SDK/CLI 才允许在已授权根目录内读取本地文件。

### 7.2 DSH 必须同时解决“输入”和“使用”

只注册几个查询工具，DSH 可以看别人的材料，但不能声称 DSH 自己的运行已经有完整溯源。因此插件分为两个可开关能力：

- Capture：读取 DSH 公开的会话、父子任务、消息和工具事件，映射为标准 Run/Actor/Operation；按授权提交。没有公开事件的字段标为 unavailable，禁止依赖未确认的私有 store 结构。
- Consume：注册 lineage_query、lineage_open、lineage_check；启用 Learning 时再注册 lineage_investigate、lineage_cases、lineage_memory_search。查询工具只读，调查和经验写入有独立权限与预算。

DSH 插件配置建议包含 coreUrl、learningUrl、凭据引用、projectMapping、captureMode（off/manual/live）、allowedSources、retention、maxUploadBytes、analysisBudget，以及界面入口开关。默认不因安装插件自动扫描所有项目或启动付费分析。

目标实现沿用经核对的 DSH/Cordis 模式：插件入口声明 name、Config、inject、apply，并把注册与资源释放放在宿主生命周期内。已读的 dsh-dog 示例依赖 tools、sessions、agents；AgentLineage 应按实际访问服务声明自己的 inject，不能照抄。实时事件、hot reload、身份获取与 jobs 能力须在选定 DSH 版本上逐项做契约试验。

插件调用服务前读取 /v1/capabilities，核对 API、事件 schema 和能力。网络中断时缓冲有限批次、返回可识别的 unavailable 状态；不能拖死 DSH 执行循环。插件卸载只释放自己的订阅和工具，不清除组件已有数据。

### 7.3 一个非 DSH 的完整使用路径

其他团队从发布仓库拉取固定 Core 镜像，创建 project/run，上传材料清单并等待索引，得到 Viewer URL 和 snapshot ID。随后使用 HTTP/MCP 查询文件历史与证据；需要制卡时单独部署 Learning 并提交调查；得到案例和经验 revision。整个过程不安装 HMigBot，不启动鸿蒙工程，不需要 DSH。

离线用户安装 Core wheel，通过 CLI 导入同一材料包并导出 HTML/JSON。离线读操作应完全不需要模型密钥和网络。该形态证明可迁移性，但 CLI 本身不是“第二个产品实际采用”的证据。

## 8. API 设计草案

以下都是新组件的建议接口，不是当前 HMigBot 已公开的 API。Core 和 Learning 各有 base URL，各自使用 /v1 前缀；可由网关统一暴露，但不增加相互启动依赖。配套 openapi-core.json 与 openapi-learning.json 是 v0.1 设计草案，用于评审输入输出与资源边界，不代表已实现。

### 8.1 Core API

| 接口 | 作用与结果 | 首次交付 |
|---|---|---|
| GET /v1/capabilities | 组件版本、API/schema 版本、适配器及支持能力 | 必需 |
| POST /v1/runs | 建立通用任务与外部身份映射 | 必需 |
| GET /v1/runs/{run_id} | 状态、来源、缺口、快照与报告链接 | 必需 |
| POST /v1/sources | 上传单个原始对象，返回不可变 source ID 与摘要 | 必需 |
| POST /v1/runs/{run_id}/imports | 提交来源清单；202 返回索引 job | 必需 |
| POST /v1/runs/{run_id}/events | 原生通用事件批次；用于无现成转录适配器的宿主 | DSH 原生采集所需 |
| POST /v1/runs/{run_id}/snapshots | 固定已摄入的水位与材料范围，返回 snapshot | 必需 |
| GET /v1/snapshots/{snapshot_id} | 固定材料、解析器版本、完整性和缺口 | 必需 |
| GET /v1/runs/{run_id}/trace | 轨迹摘要/分页；完整证据通过 query 展开 | 必需 |
| POST /v1/query | 批量 catalog/file/agent/search/open/blame/diff/neighbors/review | 必需 |
| POST /v1/reports/check | 校验报告引用、关系、时点、覆盖；不等于因果认证 | 必需 |
| POST /v1/reports | 保存不可变报告修订及检查回执 | 必需 |
| GET /v1/reports/{report_id} | 读报告、证据树、未知项与语义审查状态 | 必需 |
| POST /v1/exports | 异步生成受权限约束的 HTML/JSON 导出 | 必需 |
| GET /v1/exports/{export_id} | 导出状态和受控下载地址 | 必需 |
| GET /v1/jobs/{job_id} | 索引/导出作业状态和错误 | 必需 |
| POST /v1/jobs/{job_id}/cancel | 请求取消、返回当前状态 | 必需 |
| GET /v1/streams?run_id=…&cursor=… | SSE 增量进度、状态和新证据通知 | 第二阶段 |

query 保留现有批量调查能力，但入口只读；查询浏览不应偷偷增加“调查者已经审阅”的覆盖证据。模型调查的审阅回执通过单独的调查上下文记录。原始数据的“观察到”和调查者的“已经读过”是不同状态。

### 8.2 Learning API

| 接口 | 作用与结果 |
|---|---|
| GET /v1/capabilities | 组件、模型执行适配器、经验 schema 和兼容范围 |
| POST /v1/investigations | 指定 snapshot、目标、模型配置引用、预算与发布策略，202 返回调查 ID |
| GET /v1/investigations/{investigation_id} | 阶段、进度、预算使用、断点、案例与错误 |
| POST /v1/investigations/{investigation_id}/cancel | 发出取消请求；说明已发生的模型调用和发布状态 |
| POST /v1/investigations/{investigation_id}/retry | 显式重试；相同快照和配置复用已验证断点 |
| GET /v1/cases | 按 run、investigation、status 分页查看案例 |
| GET /v1/cases/{case_id} | 案例正文、证据与修订版本 |
| POST /v1/cases/{case_id}/reviews | 人或独立评审者提交语义结论及依据，不覆盖机械状态 |
| POST /v1/memory/proposals | 从指定案例产生待审经验变更；可含新增、合并、停用 |
| GET /v1/memory/proposals/{proposal_id} | 读取差异、来源案例、检查与审批状态 |
| POST /v1/memory/proposals/{proposal_id}/publish | 按 expected_revision 原子发布；需要独立权限 |
| GET /v1/memory/revisions/{revision_id} | 发布清单、来源、内容摘要与回滚关系 |
| POST /v1/memory/search | 条件检索、相关案例、匹配说明与经验版本 |
| GET /v1/memory/lessons/{lesson_id} | 逐层读取完整经验及适用/失效条件 |

调查默认产出案例草稿，不自动发布团队经验。团队可在配置中授权“机械检查后自动发布为未做语义审查的经验”，但状态必须跟着检索结果返回；高风险经验可要求独立审核。这是建议的新策略开关，不是对现有服务端流程的描述。

### 8.3 关键请求示例

创建一个与鸿蒙无关的任务：

    POST /v1/runs
    Idempotency-Key: dsh-task-73
    {
      "project_id": "project-docs",
      "external_key": "dsh:task:73",
      "objective": "修订文档生成器并验证输出",
      "labels": {"host": "dsh"}
    }

对固定快照调查文件历史：

    POST /v1/query
    {
      "snapshot_id": "snap_01",
      "requests": [
        {"op": "file", "key": "repo:docs/src/render.py",
         "at": "2026-10-08T03:10:00Z", "view": "changes", "limit": 50},
        {"op": "search", "scope": "pool", "terms": ["assertion failed"], "limit": 20}
      ]
    }

请求明确区分“不完整材料”和“没有命中”。例如一项查询可返回：

    {
      "request_index": 0,
      "status": "partial",
      "items": [],
      "gaps": [{"code": "MISSING_BASELINE", "source_id": "src_01"}],
      "next_cursor": null
    }

调查与模型费用有显式边界：

    POST /v1/investigations
    Idempotency-Key: investigation-task-73-attempt-1
    {
      "snapshot_id": "snap_01",
      "objective": "解释返修过程并生成有证据的案例",
      "model_profile": "team-investigator",
      "budget": {"max_model_calls": 30, "max_input_tokens": 400000,
                 "max_output_tokens": 30000, "timeout_seconds": 900},
      "publication": "draft_only"
    }

数字是请求示例，不是建议默认值或已验证性能承诺。预算依据可观测的调用、token 与时间执行；无法获得实际 token 时应停止/保守估算并说明，不能声称严格美元封顶。密钥不进入请求正文，model_profile 仅引用服务端已有配置。

### 8.4 所有入口共用的契约

- 写请求带 Idempotency-Key；同一租户/主体/路由作用域中同 key 同 body 返回原结果，同 key 不同 body 返回 409。初版去重记录保留至少 7 天，长作业保留到终态后 7 天；过期后不承诺复用。
- 原生事件按 (tenant, source, event_id) 去重，摘要不符返回冲突；乱序允许入库，水位和缺口可查询。不得用本地到达顺序伪造原始顺序。
- 通用事件接口的 producer_id 标识事件来源；对应上述 source 去重维度，并由服务端校验其租户与项目归属。Run 状态由 run.completed/failed/cancelled 等明确事件更新，没有结束事件时不推断成功。
- Snapshot 只包含已持久化且被指定清单/水位纳入的材料。追加导入产生新快照，不重写旧快照。解析器更新产生新派生 revision，旧报告仍绑定旧解释版本。
- Query 每批 1–24 项；分页项默认 50、最大 500。响应逐项记录错误，不用一个成功项掩盖另一个失败项。重计算、导入、模型调查都返回 202 与 job/investigation ID。
- SSE event ID 单调且可续读；游标过期返回 410 和重取快照的指引。通知只能代表进度，不作为唯一事实存储。
- HTTP 错误使用统一 Error：code、message、retryable、details、request_id。区分 400 参数错误、401/403、404、409 版本冲突、413 超限、422 不满足证据要求、429 限流、503 未启用/暂不可用。
- 权限分为 trace:read、trace:write、analysis:run、case:review、memory:read、memory:publish、export:read。浏览权限不隐含执行付费分析或发布经验权限。
- 版本分别管理 package_version、api_version、event_schema_version、index_schema_version、case_schema_version、instructions_version。输入运行材料的 runtime 版本也保留，避免将解析器差异误判为行为差异。
- 能力清单明确 live、native-write、read-evidence、child-lineage、token-usage、offline-export 等是否支持。客户端不能因“适配器存在”就假设能力齐全。

API 草案还需冻结两类细节：各 query op 的精确结果 schema，以及案例多次语义评审发生冲突时的汇总规则。当前 draft 已定义资源、输入约束、权限、错误、异步状态及主要输出，不应当作生产契约自动生成后直接上线。项目与租户初版由管理员预置，不允许 create_run 自行创建新的授权边界。

报告请求中的 evidence_kind 只是待校验声明，服务端必须重新绑定来源。model_review/human_assertion 不得由客户端改标为 native_receipt 后直接采信。需要补充关系时，提交上轮反馈的 feedback_id、原文和解释；只在同主体、快照和修订链内接受。经验语义审核身份同样从认证上下文获得。

### 8.5 Python / CLI / MCP 与 HTTP 的一致性

Python SDK 暴露 create_run、import_sources、create_snapshot、query、check_report、export_report 等显式方法。CLI 提供对应子命令，机器输出为版本化 JSON，进程退出码与 verdict 分开。MCP 工具是这些能力的薄包装，限制单次结果大小，返回可继续展开的证据引用。

SDK、CLI、MCP 和 Viewer 必须调用同一 domain service；HTTP 是跨进程契约，SDK 是进程内契约。禁止四个入口各自实现时点过滤、来源选择或归因规则。

### 8.6 现有入口到新接口的迁移

| 当前入口 | 新接口/归属 | 兼容方式 |
|---|---|---|
| Insight1 的 /trace/{sid}、/summary/{sid}、/report/{sid} | Core trace/query/export + Viewer | sid 由宿主解析为 run/session；旧链接仍可跳转 |
| Insight1 的 /fixchain-data/{sid}、/fixchain/{sid}、/journey/{sid}、/chain-data | Core lineage/inquiry 结果 + Viewer | 宿主负责 run 范围和角色映射，算法不再直接读 Orchestrator |
| Insight1 的 /compare、/live/{sid}/stream | 对多个固定快照查询比较；通用 SSE + 来源 live adapter | 保留来源能力差异；实时支持与离线支持分开验收 |
| Insight1 的 /chat/{sid} | Learning investigation 或只读分析 executor | 旧入口的模型配置由宿主映射，不传送密钥到浏览器 |
| server repair blueprint 的 /sessions/{msid}/analyze、/status、/retry | Learning investigations 创建、读取、重试 | 旧 msid 映射由 server adapter 管理；保留原任务幂等与权限 |
| server repair blueprint 的 /sessions/{msid}/inquiry/{revision}/{route} | Core query/report/Viewer | 继续绑定原 revision，不能偷偷用最新材料重释旧卡 |
| inquiry 的 investigate/page/submit MCP 工具 | Core query、证据打开和 report check/save | MCP 工具名称可兼容，返回语义按版本声明 |
| memorylib 的 browse/search/read | Learning memory search/lesson | 保留词法检索和 active 状态语义，逐步扩展 |

表中 Insight1 入口位于 /api/insight1 下；server 行列的是 blueprint 内的相对路由，不把它当作已确认的外部统一 URL。上述映射是改造方案，旧路由当前尚未转发新服务。

## 9. 独立部署、存储与运行保障

### 9.1 最小安装与团队安装

最小 Core 安装使用一个进程、SQLite 索引和本地内容寻址对象目录；离线导入、查询和 HTML 导出不安装 Learning，也不需要模型服务。团队初版可采用单实例服务加持久卷；这并非高可用部署。需要多个服务副本时，再使用具有一致事务能力的共享数据库和对象存储适配器，并单独验证锁与恢复语义，不能把 SQLite 共享文件当作多实例方案。

Learning 使用独立服务/worker 与自己的作业、案例和经验存储。默认本地文件与版本清单即可独立运行；Git 作为经验发布后端、对象存储作为镜像、FunctionGraph 作为 worker 后端都是可选适配器。Core 不要求 Mongo、OBS 或 FunctionGraph；迁移后的 server adapter 可继续使用这些现有基础设施。

Learning 的模型调用走自己的可替换 executor 协议；HMigBot 内部接入若继续在宿主执行模型调用，仍由其既有 Driver 实现该协议，不能绕过 Driver 新建 SDK/CLI 调用路径。

组件默认监听 loopback；团队服务配置真实鉴权、租户隔离与受控网络访问。模型 worker 只获得当次快照的受限访问和所选模型凭据，经验发布凭据仅交给 publisher；不因拥有模型调用能力而获得任意宿主 shell、Git 发布或云账户权限。

### 9.2 作业状态与恢复

索引/导出作业：queued → running → succeeded / failed / cancelled。调查另记录 triage、investigating、checking、draft_ready 等 stage；发布是单独的 proposal/publish 状态，不混成一个“完成”。取消先进入 cancel_requested，直到 worker 回执或租约失效后才报告终态；已经生效的发布不因取消而被隐式撤销。

采用至少一次派发、幂等处理、带 fencing token 的租约和串行版本发布。相同 snapshot、配置、指令版本的重试可以复用已完成且校验有效的卡片；输入或指令变化则创建新 attempt，不能混用旧断点。worker 重启后从持久记录恢复；过期任务不自动无限重跑付费模型。

发布过程以 expected_revision 做并发控制，使用不可变版本清单与 CAS 更新当前指针。Git 后端提交成功但回调丢失时，先按 publication ID 查找已有提交，再恢复状态。保留现有“已发布则复用”的思路，同时从 msid 改为通用 publication ID。不承诺分布式 exactly-once。

### 9.3 升级、回滚和运行可观察性

镜像与 wheel 固定版本及摘要，部署清单可切回前一版本。原始材料不可变，派生索引可重建；索引迁移尽量 side-by-side，验证后切指针。不可逆的数据格式变更必须带导出/恢复工具和兼容窗口，不能仅靠回滚镜像宣称数据可回滚。

组件提供 health/readiness、结构化日志、job ID、request ID、队列等待、处理耗时、失败类型与模型预算统计。观察日志默认不写原始提示词、源码和凭据。控制 API 进程与模型子进程隔离，重启 Learning 不影响 Core 的只读报告；Core 重启时宿主收到明确 unavailable 或按策略短期缓冲。

### 9.4 数据与执行边界

原始转录可能包含代码、密钥、个人信息和工具输出。读取授权、导出授权、模型出域授权分别配置；默认私有，按项目和租户隔离。为脱敏对象保存变换清单和独立摘要，引用指向实际参与分析的版本，不再冒充原始逐字材料。删除/保留策略覆盖原始对象、派生索引、卡片、导出和镜像；需要法律/业务保留的情形由接入方制定政策，本方案不代替该决策。

转录、历史 commands/skills 和模型产物都是待分析数据，不自动执行其中的指令。用于调查的工具默认只读，模型运行在资源与文件权限受限的 worker 中；仅过滤环境变量不应称为完成了沙箱隔离。

HMigBot 现有 DevEco 禁止自动遥测的规则必须保留。读取明确授权的导出材料，与新增自动采集上传是两回事。DSH 的采集开关也不能绕过来源授权。Go runtime 的 session 上传仍由原宿主负责，Core 不接管这条链路。

## 10. 从现有代码迁移到新仓库

### 10.1 源码分工与归属清单

| 来源 | 建议迁入 | 留在原宿主/重写为适配器 | 注意事项 |
|---|---|---|---|
| plus 的 insight/adapters、blame、crosschain 等 | Core 的输入、演化与关系模块 | Harmony/a2h/Android 识别、宿主会话目录发现 | 与服务端同名模块逐函数比较，不能直接选较新目录覆盖 |
| plus 的 routes、chain、locate、chat/live 相关 | 通用查询、缓存、实时协议、Viewer 和共享分析体验 | FastAPI request 中读取 Orchestrator/EventStore、迁移 run/ECAT 查询、Driver 装配 | 保留兼容旧入口；chat 的模型执行接 Learning executor |
| server 的 vendor/migloop | Core 报告、三来源适配、audit、行级/atom 兼容 | 迁移阶段审计规则和旧宿主默认 backend | REPORT_UPSTREAM 按文件记录来源与改动 |
| server 的 inquiry 内核 | Core 的历史查询、证据图、机械校验与 Viewer | 依赖运行池路径的装配 | 以新时点语义为主，不退回旧推断版本模型 |
| server 的 memorylib、调查/归并指令 | Learning 的 case、memory、retrieval 和受控指令包 | migration_key、环境路径和宿主 publication 元数据 | 旧格式建立迁移器及只读兼容，不原地改历史卡 |
| server 的 repair_worker/jobs/publish | Learning 的作业恢复与发布流程 | Mongo 集合、OBS key、FunctionGraph、宿主鉴权、固定 model profile | 用存储/执行/发布接口注入，移除 A2H 命名硬依赖 |
| server 的 migloop_report、session_trace、repair_materials | 其中无业务的材料校验与索引逻辑 | msid 选源、session-slice 组装、缺片修复、仪表盘权限 | 服务器先交付稳定材料包，Core 再分析，不直连原业务数据库 |

迁移前建立 provenance.csv：目标路径、来源仓库/路径、commit、原作者/许可信息、宿主定制、目标模块、行为差异、回归 fixture。独立包的 MIT 声明不能自动覆盖不同来源和第三方资产；核清发布权、归属与随包声明后再公开新仓库。此处是发布材料核对要求，不对现有代码作法律判断。

### 10.2 新仓库建议目录

    agent-lineage/
      README.md
      component-set.yaml          # 集成发行清单，固定各组件版本与摘要
      contracts/                  # API、事件、来源清单、case schema；独立契约模块
      components/
        core/
          pyproject.toml
          src/agentlineage_core/
            sources/              # 来源解析与通用事实
            trace/                # 会话、Actor、Operation
            lineage/              # 内容演化与关系
            inquiry/              # 历史查询与机械检查
            storage/              # 原始对象、索引与快照
            api/                  # HTTP/SDK domain 入口
            interfaces/           # CLI/MCP 适配
            viewer/               # 页面与离线导出
          tests/
          Dockerfile
        learning/
          pyproject.toml
          src/agentlineage_learning/
            investigation/        # 调查任务与模型执行协议
            cases/                # 案例及审查
            memory/               # 归并、检索和版本
            jobs/                 # 租约、预算、断点
            publication/          # 发布与恢复
            adapters/             # model/Git/object storage 等实现
            api/
          instructions/           # 制卡、归并、召回等随版本发布
          tests/
          Dockerfile
      integrations/
        dsh/                      # npm package，单独版本和契约测试
        hmigbot/                  # 公共适配协议；宿主具体装配可留原仓
      examples/
        generic-task/             # 不依赖 DSH/HMigBot 的完整消费示例
      fixtures/                   # 脱敏输入、来源 manifest、期望证据
      docs/interfaces/
      docs/decisions/
      deployment/
      .github/workflows/

每个目录只对应一个模块，core 和 learning 顶层对应两个组件；禁止为了共享工具而创建依赖所有模块的公共 utils。真正共享的是薄协议/类型，业务逻辑由单一归属模块拥有。contracts 在构建时打包或生成客户端，不在运行时引入宿主依赖。

### 10.3 包、版本与发布

Core 的 Python 包、CLI、Viewer 与服务镜像使用同一组件版本；Learning 的运行时、指令、卡格式兼容表与服务镜像使用另一组件版本。DSH npm 包有自己的版本和 DSH peer dependency 范围，同时声明可使用的 Core/Learning API 范围。组件集清单只固定已验证组合，不强制所有包每次一起升版本。

发布产物包括 wheel/sdist、容器摘要、DSH npm tarball、JSON Schema/OpenAPI、变更说明、校验和与依赖清单。可评估保留上游 pyz 离线交付，但不是首期必须新增的第三种引擎，且不把旧工具“零第三方依赖”的性质直接套给新服务。

消费者通过版本号/摘要安装，不能再复制 src/vendor 整目录。接口兼容的 patch/minor 更新复用组件自身测试结果，宿主只执行契约与关键集成路径验证；不承诺仅因 URL 没变就完全免测，因为归因语义、数据格式、权限、资源占用也属于兼容边界。

### 10.4 HMigBot 迁移方式

先用同一批冻结材料对新旧引擎双读，比较轨迹、身份、token、文件变化、证据引用和 unknown；不双写经验、不重复调用模型。修复旧错误导致的输出变化应作为有证据的差异审批，不能强行追求错误结果一致。

第一阶段维持 /api/insight1 旧 UI/路由，由宿主适配器转发给 Core；服务端 repair API 转发 Learning 并保留既有 msid 映射。第二阶段 UI 使用新 Viewer 和稳定 deep link。发生回归时切回旧适配路径和旧组件版本；新生成的版本化案例仍可只读，不回写成旧格式。

现有 /api/insight、生产遥测上传和业务权限保持各自归属。新仓库上线后再安排宿主移除 vendor，不能在替代能力尚未验收时先删除旧代码。

## 11. 七项组件化判定

评判对象需要明确。上游 MigLoop 报告工具已有自己的 pyproject、版本与可运行交付物，并有测试；因此不能说“当前七项全不满足”。但“报告 + inquiry + 返修作业 + 经验 + HMigBot 页面”目前分散在不同包和宿主中，没有一个统一可安装的通用交付边界。

| 检查项 | 当前完整能力的状态 | 目标与验收证据 |
|---|---|---|
| 1 独立版本号 | 部分满足：上游工具 0.3.0、服务端经验包 0.10.0；plus 随宿主发布 | Core、Learning、DSH 各有版本、tag、构建元数据；API/schema/指令兼容表和组件集 BOM 可查 |
| 2 独立编译/打包 | 部分满足：已有 pyproject/pyz、vendored bundle、repair worker 镜像相关配置 | 空白 CI 从新仓库构建 wheel/镜像/npm 包，不 checkout 两个宿主；安装发布包而非源码目录即可运行 |
| 3 独立测试 | 部分满足：上游和各宿主均有测试，完整链路仍依赖宿主 fixture/环境 | 单独下载组件产物与 fixtures，在无 migbot/DSH 的环境跑 Core/Learning 测试；模型执行用可注入 fake，另有明确付费 E2E |
| 4 独立部署/重启/升级 | 部分满足：离线工具独立，repair worker 有云执行形态；本地页面和服务 API 仍随宿主 | 独立进程/镜像安装；运行中的 DSH/HMigBot 不重启，Core/Learning 可单独换版本并恢复；数据回滚策略实际演练 |
| 5 可复用 | 有 HMigBot 本地/服务端的复制式复用，也有独立工具；缺同一制品在独立第二宿主的接入证据 | HMigBot 与 DSH 安装同一 Core 发布制品，分别完成真实任务；至少一个非鸿蒙场景；记录两个宿主版本、包摘要、运行 ID 和实际使用者 |
| 6 单一职责 | 报告、机械证据处理、模型调查、经验发布和业务遥测混在不同宿主路径 | Core 负责证据；Learning 负责案例到经验；适配器负责宿主接线；清单逐项有明确归属，无“全功能通用 Agent 平台”扩张 |
| 7 依赖方向干净 | 核心算法已有可复用部分，但路由/材料/jobs 与宿主状态、云存储和命名耦合 | 静态 import 检查与动态安装证明 Core 不反向依赖宿主/Learning；Learning 只走 Core 公开 API；依赖图无环 |

正式结论采用“满足 / 部分满足 / 不满足 / 未验证”。计划中的目标只能记为待验证。Core、Learning、DSH 适配包分别判定，组件集也单独说明自己的生命周期；不能用 Core 的成功安装替其他交付物盖章。

按需加载也要有证据：只启 Core 时不安装/启动模型 worker、Git publisher、MCP 依赖或所有可选解析器；大型原文和证据详情按需展开；记录启停差值和资源预算。不能仅因存在配置开关就声称降低了 CPU/内存。

## 12. 测试与验收方案

### 12.1 不依赖模型的组件测试

来源矩阵覆盖 Claude、Codex、DevEco 导出和通用事件；每种来源包括 root/child、工具请求/返回、缺片、截断、重复、乱序、运行恢复和未知字段。DevEco 使用授权样本/导出，不新增自动上传。Core 单测与集成测试只使用本地固定材料。

归因反例必须覆盖：同一人重写不是他人接手；后来的修改不一定修复缺陷；读取不等于采纳；调用成功不等于验证通过；shell 命令文本不等于已观察到文件写入；时间先后不等于因果；缺材料不等于没有发生；丢失基线不能生成可信行级作者。固定哈希、来源 ID、时点范围和原文引用都要有断言。

调查报告测试覆盖 native edge 与 model_review 分离、先反馈再补充关系、未解释写入、未知节点、越过截止点、伪造引用、机械有效但语义未审查。经验测试覆盖 revision 冲突、来源卡丢失、修订/停用后检索、作用域隔离和提示注入材料仅作为数据处理。

### 12.2 发布产物与跨入口测试

空环境只安装 wheel；容器只挂载材料和数据目录；npm 包从打出的 tarball 安装。SDK、HTTP、CLI、MCP、Viewer 对同一快照返回相同的事实身份、来源和 unknown；允许展示不同，不允许因入口不同产生不同归因事实。

契约测试使用公开接口与固定 fixtures，而非复制内部函数实现。重启测试验证游标恢复、已确认事件不丢失、重复输入不增算、旧 lease 不能发布；升级测试验证旧报告可读、兼容版本回滚和索引重建。限流、材料大小与任务取消测试验证边界可解释。

### 12.3 真实接入与语义评测

真实 DSH 验收覆盖安装、配置、capture、工具查询、Viewer、停止重启和卸载；HMigBot 验收覆盖主迁移/Reviewer/ECAT 等实际受影响入口的行为，不扩大到无关全产品矩阵。按原仓要求先更新意图、用例与接口资产，再由用户安排系统验收。

制卡和经验流程需要真实模型验收，但与机械测试分别计数。准备人工标注的返修样本，包含真实缺陷、需求变化、格式变动、证据不足及跨 Agent 交付；衡量证据引用准确率、无根据因果断言率、合理拒答/unknown、案例可操作性及经验检索的适用性。评审者不直接照抄生成者答案。没有这批验证，不对外宣称“自动根因准确率”或“自优化效果”。

性能门槛先在约定硬件与小/中/大材料集上测基线，再冻结导入耗时、查询 P95、峰值内存、并发与恢复时间预算。现有文档里单个 7MB 会话的旧耗时不能作为新服务 SLO。首期保证分页、异步重计算和大小限制；不虚构尚未测得的指标。

## 13. 落地里程碑与完成定义

| 阶段 | 主要工作 | 完成证据 |
|---|---|---|
| M0 基线与契约 | 权属/provenance、四处代码差异、能力矩阵、DSH 目标版本、冻结 fixtures | 模块映射、差异说明、API/schema 草案评审、成本与用例计划 |
| M1 独立 Core | 提取解析/轨迹/演化/inquiry/check；离线 SDK/CLI、wheel | 无宿主环境运行、三来源 golden 和归因反例通过、独立版本产物 |
| M2 服务与双宿主 | HTTP/Viewer、来源导入；HMigBot shim；DSH capture + consume | 同一制品被 HMigBot 与 DSH 使用，非鸿蒙真实案例，重启与兼容验证 |
| M3 独立 Learning | 分流/制卡/经验/检索；预算/租约/断点；可选 Git/云适配 | 无宿主依赖部署、fake 全链路测试、受控真实模型案例和发布恢复证据 |
| M4 迁移与正式发布 | 老入口兼容、差异处理、发布清单、文档与支持政策 | 七项逐条留证，第二团队接入记录，回滚演练，宿主 vendor 替换计划 |

最小可交付切片是 M1 + M2：其他团队已经能获得真实轨迹、证据调查与返修链查询。完整“一套能力”还需要 M3 的自动制卡、经验管理与召回；不能把 M2 叫作完整经验闭环。M0 完成后再按代码冲突、测试资产和 DSH 公开事件能力估算工期；本文不把未经拆工的周数当作承诺。

建议小团队按 Core/契约、Learning/经验、宿主集成/交付三条责任线组织，可由两三人兼任，但每个公共契约有唯一负责人。版本发布权限按组件授予；宿主不能通过私有字段把共享组件锁死。

关键风险与应对：

| 风险 | 处理方式 |
|---|---|
| 多份代码同名但语义不同 | 按来源 manifest 和 fixture 对齐，逐文件迁移，保留差异记录 |
| 提前抽成过大的“平台” | 锁定证据与经验两项职责，执行/verify/Skill 优化通过外部接口接入 |
| DSH 公开事件不足 | M0 做探针；先完成手动导入并明确 capture 缺口，不能把工具消费冒充实时全轨迹 |
| 归因误导或经验扩散 | 原始事实/解释分层、unknown、一等语义审查状态、版本停用与回滚 |
| 模型成本与失败重跑 | 预算、断点、显式重试、租约 fencing、发布幂等 |
| 历史卡与新索引不兼容 | 绑定 snapshot/index/instructions 版本，旧格式只读适配，按需重建派生物 |
| 看似复用实际仍复制代码 | 两个宿主必须安装相同版本/摘要制品，发布升级独立演练 |

## 14. 立项时建议采纳的决策

本方案建议采纳：AgentLineage 工作名；一个仓库维护 Core 与 Learning 两个组件；独立服务作为默认交付，SDK/CLI/MCP 作为入口，DSH 为真正的宿主插件；Core 不依赖模型；Learning 默认草稿交付；以 inquiry 的时点证据语义作为 v1 主契约；保持现有遥测权限边界；至少 HMigBot 与 DSH 两个真实宿主使用同一制品后才判定复用达成。

立项评审需要冻结的配置包括：组件所有者与发布组织、目标 DSH 版本、初期部署平台、案例/经验的默认审批策略、数据保留和模型出域范围、首批语义评测样本。它们不阻碍先进行源码归属与契约设计，但应在对应实施和发布前确定。

## 15. 可复用的七项判定提示词

> 请对项目 <仓库 URL/本地路径> 的固定版本 <commit/tag> 做组件化审计。目标是小团队独立交付、多产品使用同一发布制品，而不是仅判断目录划分。
>
> 先列出模块、候选组件和组件集，分别说明唯一职责、公共接口、运行时依赖与消费者。模块不能因为有目录就算组件；合集不能因为有独立版本就满足单一职责。
>
> 对每个候选组件检查七项：独立版本、独立构建产物、脱离宿主测试、独立安装/重启/升级、第二产品真实复用、单一职责、依赖方向无环。每项只能给“满足、部分满足、不满足、未验证”，并附文件/命令/制品/运行证据和适用边界。
>
> 请实际核对构建配置、发布清单、测试依赖、部署进程、import/调用方向、消费者安装方式和兼容策略。区分独立 SDK 包与独立服务的重启能力，区分复制 vendor 与使用同一版本制品，区分计划中的第二宿主与已经使用的宿主。
>
> 对本项目另外核查事实、模型解释、机械校验、语义评审是否分离；来源材料是否可追溯；未知/缺片是否保留；跨 runtime 解析与自动采集是否分别声明；模型费用和经验发布是否有明确权限及恢复机制。
>
> 输出组件清单、七项判定表、依赖图、缺口与最小改造步骤、接口兼容/迁移方案、独立验收方法。不要把已有测试文件说成已执行测试，不要把机械检查通过说成因果正确，不要把经验检索说成 Skills 已自动优化。未获授权时不启动付费模型、不发布、不修改宿主代码。

## 16. 远程源码依据

以下均固定在本轮核对的 commit；私有仓库链接需要相应访问权限。

- [HMigBot Insight1 路由、实时流、链路与分析入口](https://github.com/fuxi-ailabs/hmigbot-plus/blob/f86742295c5b287d00e9cd8423164611eecccc72/src/migbot/insight/routes.py)
- [行级内容重放与缺口处理](https://github.com/fuxi-ailabs/hmigbot-plus/blob/f86742295c5b287d00e9cd8423164611eecccc72/src/migbot/insight/blame.py)
- [HMigBot 包配置](https://github.com/fuxi-ailabs/hmigbot-plus/blob/f86742295c5b287d00e9cd8423164611eecccc72/pyproject.toml)
- [服务端三来源报告适配说明](https://github.com/fuxi-ailabs/migbot-server/blob/207b9eb8934b82309b5dd2709c2eede868fc8bdc/docs/migloop-report-adapters.md)
- [服务端材料组装与报告门面](https://github.com/fuxi-ailabs/migbot-server/blob/207b9eb8934b82309b5dd2709c2eede868fc8bdc/src/services/migloop_report.py)
- [返修与经验完整流程及历史验证边界](https://github.com/fuxi-ailabs/migbot-server/blob/207b9eb8934b82309b5dd2709c2eede868fc8bdc/docs/repair-memory.md)
- [调查查询及 MCP 接口](https://github.com/fuxi-ailabs/migbot-server/blob/207b9eb8934b82309b5dd2709c2eede868fc8bdc/src/vendor/migloop_memory/runtime/migloop/inquiry/interfaces.py)
- [报告机械校验，明确 semantic_verified=false](https://github.com/fuxi-ailabs/migbot-server/blob/207b9eb8934b82309b5dd2709c2eede868fc8bdc/src/vendor/migloop_memory/runtime/migloop/inquiry/report.py#L599-L624)
- [证据回执绑定，不认证验证范围](https://github.com/fuxi-ailabs/migbot-server/blob/207b9eb8934b82309b5dd2709c2eede868fc8bdc/src/vendor/migloop_memory/runtime/migloop/inquiry/check_receipts.py)
- [制卡、断点、并发调查与归并 worker](https://github.com/fuxi-ailabs/migbot-server/blob/207b9eb8934b82309b5dd2709c2eede868fc8bdc/src/services/repair_worker.py#L199-L349)
- [租约及任务状态](https://github.com/fuxi-ailabs/migbot-server/blob/207b9eb8934b82309b5dd2709c2eede868fc8bdc/src/services/repair_jobs.py)
- [经验发布与已有提交恢复](https://github.com/fuxi-ailabs/migbot-server/blob/207b9eb8934b82309b5dd2709c2eede868fc8bdc/src/services/repair_publish.py)
- [经验浏览、词法搜索与读取](https://github.com/fuxi-ailabs/migbot-server/blob/207b9eb8934b82309b5dd2709c2eede868fc8bdc/src/vendor/migloop_memory/runtime/memorylib/retrieval.py)
- [报告上游模块版本清单](https://github.com/fuxi-ailabs/migbot-server/blob/207b9eb8934b82309b5dd2709c2eede868fc8bdc/src/vendor/migloop/REPORT_UPSTREAM.json)
- [经验包代码、指令版本和文件哈希](https://github.com/fuxi-ailabs/migbot-server/blob/207b9eb8934b82309b5dd2709c2eede868fc8bdc/src/vendor/migloop_memory/UPSTREAM.json)
- [上游独立工具、来源与离线报告说明](https://github.com/hxy450/migloop/blob/a2dd2cc431a0a13a8f0c3ab29686fb5b042b8655/README.md)
- [上游独立版本与构建配置](https://github.com/hxy450/migloop/blob/a2dd2cc431a0a13a8f0c3ab29686fb5b042b8655/pyproject.toml)
- [DSH/Cordis 插件参考入口](https://github.com/Fun10165/dsh-dog/blob/80d0543c95d171e1ec953e978272a2595e4fc974/src/dsh/plugin.ts#L32-L47)

## 17. 本次交付与验证记录

本次交付为本方案和两个 OpenAPI 设计草案：[Core API](openapi-core.json)、[Learning API](openapi-learning.json)。它们描述新仓库的建议形态，没有实现服务或修改宿主公共接口。

本轮已核对远程版本、源码与上游 manifest；已完成本地 main 快进同步。两个 API 草案共 32 个操作、48 个 JSON Schema；JSON 解析、JSON Schema 结构检查、本地引用与路径参数检查均通过，文档中的 4 个 JSON 示例也通过对应 schema 校验。未安装/运行完整 OpenAPI 规范校验器，不将这些检查等同于接口实现或端到端验收。

产品 tracked 工作区没有本轮修改。未执行产品三件套、真实模型、设备或部署验收，本次也不据此报告组件化已经完成。
