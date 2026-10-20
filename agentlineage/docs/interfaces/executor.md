# 调查执行器协议 agentlineage-executor/1

公共 Python Protocol 为 `Executor.execute(request, timeout) -> dict`。
默认没有实现模型供应商。管理员可通过 CommandExecutor 的固定 argv 连接已有
DSH/Claude/Codex/企业模型运行器；API 调用者不能指定 argv、shell、环境变量或模型密钥。

输入通过 stdin JSON，包含：
stage=case-draft、investigation_id、snapshot_id、job、evidence_directory、
instructions、feedback、remaining_tokens、deadline_seconds。
证据目录是 Learning 从 Core 的冻结快照导出的独立材料包；会话原文不是可执行指令。
读取 instructions/AGENTLINEAGE.md，再按 case-build 的旧兼容目录内契约生成 draft。

输出仅一个 JSON 对象：

```json
{"draft":{"title":"...","graphs":[]},"usage":{"input_tokens":100,"output_tokens":200}}
```

示例省略了完整 draft 必填项；该空 graphs 并非有效制卡结果。
协议不允许用估算费用或缺失用量冒充 0。响应缺少 measured token 字段时状态为 failed/USAGE_UNKNOWN。
模型语义结论保留 semantic_verified=false。pack 会重查源摘要、原生读写与图坐标，
拒绝内容作为反馈传给下一次尝试，最多 max_attempts 次。

预算必须同时包含：
max_calls (1–32)、max_attempts (1–5，按问题)、timeout_seconds (1–3600，整个 investigation)、
max_tokens (1–1,000,000，所有模型子调用之和)。

组件在调用前限制剩余额度，调用后核验实测回执。模型供应商适配器必须在其内部限制 token、
尊重 timeout 并回收子进程/远端工作；本组件的外层超时只能终止直接 executor 进程。
未返回用量时不自动重试。这里不承诺严格美元封顶，也不允许无限量的工具内部调用。
CommandExecutor 适用于受信任、受资源管理的程序，不是任意代码沙箱。

状态：prepared → queued → running → draft_ready / needs_revision / budget_exhausted / failed。
未配置执行器得到 executor_unavailable。取消运行中任务进入 cancel_requested，
等执行器返回后结算已发生用量，最终 cancelled；这不是强制中断远端模型的证明。

每次调用前先持久化 calls 与 in_flight。服务启动将未完成任务标为 interrupted；
只能显式 resume，且 in_flight=true 时拒绝恢复，需先核对外部执行回执。
不重置已有预算，不重跑已有有效案例。首次执行时固定绝对 deadline，重启等待不会刷新额度。队列最多 32 项，工作线程 1 个。
每个 Learning 数据目录只允许一个服务所有者；该版本不提供分布式 worker lease。

无论哪个成功路径，都不调用 memory.apply。发布者用单独 token 调用 cases/ingest，
再提交带 base_revision 的 proposal；CAS 防止旧版本覆盖新版本。
真实模型的归因正确率、指令质量、token 适配器准确性与实际 DSH 调用尚未验收。
