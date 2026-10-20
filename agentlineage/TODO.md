# Implementation worklist

- [completed] API examples: SDK walkthrough and HTTP client added; both executed successfully with synthetic generation/repair sessions; examples lint passed.

- [completed] M0: private remote fuxi-ailabs/AgentLineage created and verified; local origin configured; proposal and fixed source commits preserved.
- [completed] M1: native material import, immutable snapshots, historical query, conservative line replay, report checking, CLI/MCP/Viewer/offline export; independent Core wheel installation verified.
- [completed] M2: standalone Core/Learning services and thin DSH tools; actual SDK contracts and cross-process HTTP tested.
- [completed] M3: case packaging, feedback-driven draft retries, bounded investigations, cancellation/restart protection, memory CAS/withdrawal/impact/lexical retrieval; no automatic publication.
- [completed] M4: final wheels/tarball built; 40 Python + 5 DSH tests passed; lint/types, provenance and clean-installed full case/memory roundtrip verified; evidence documented.
- [completed] M5: Core/Learning 0.1.0a2 observation, source and repair APIs; HarnessCore independent HTTP integration and Agent Run UI. 49 Python tests, 5 DSH tests, clean wheel install and Core a1→a2 snapshot compatibility passed. HarnessCore verification is tracked in its observability work item.
- [pending_external_acceptance] Real model-provider executor quality, full DSH task/capture, second-team production adoption, Docker/Linux execution and Learning cross-version upgrade.
- [pending_later_scope] SSE, multi-tenant ACL, shared remote Core snapshots, distributed workers, automated triage/lesson merge and human review UI; see docs/migration.md.

No commits, pushes, PRs, production deployment or paid model runs are authorized by the implementation request alone.

- [completed] M6: 0.1.0a4 原生增量摄入、持久化游标、DevEco part 更新、冻结证据、按用户/Agent 消息分页及固定版本传输续页。
- [completed] M6: ruff、mypy（67 文件）、66 项 Python 测试通过；a4 wheel 安装到独立环境。HarnessCore 隔离生产浏览器 8 passed，真实 localhost 页面与 2560/1440/390px 验证完成；本机 Core/Learning 已升级。

- [completed] M7: a5 原生 DevEco 会话名称随实时/冻结查询提供；脱敏、冻结历史稳定性、67 项测试及独立 wheel 安装通过。HarnessCore 会话选择已消费并实际验证。

- [completed] M8: 组件原生会话耗时与资源使用 API，修正仅完成事件伪造 0ms，HarnessCore DAG/泳道时间线消费。

- [completed] M8 验证：a6 ruff、mypy（68 文件）、71 项 Python 测试和独立 wheel 安装通过；HarnessCore 实际 HTTP/UI 消费确认 13/13 会话时间、16 项原生资源使用。工具依原生会话身份归属 Agent/Subagent；桌面/窄屏浏览器验证完成，本机 Core/Learning a6 已生效。证据见 HarnessCore docs/work-items/2026-10-10-task-access-and-outcome.md；其他外部验收范围仍保留原状态。

- [completed] M9: a7 固定快照记录定位 API、a8 可选概览跳过、跨页调用/结果查询与宿主时间线跳转消费；原生格式与旧查询兼容。ruff、mypy、80 项测试、独立 wheel 安装通过。本机真实工具定位高亮与整页完成已核验；大页上下文补齐延迟仍见 HarnessCore 对应工作项。

- [completed] M10：a9 历史投影缓存、逐次原件校验、字节预算分页；83测试/ruff/mypy及独立wheel验证通过。真实458记录页4批，首次组件1259ms/重复112ms，宿主浏览器整页392ms。完整证据见 HarnessCore 2026-10-10-history-performance-and-diagnosis 工作项。
