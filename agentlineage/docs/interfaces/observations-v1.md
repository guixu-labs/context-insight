# 原生观测与返修 API（Core 0.1.0a2）

组件保持独立 HTTP 边界，认证、原件上传和冻结快照使用 implemented-v1.md。
新增 capabilities: observations-v1、repair-chain-v1。
快照可附 context 对象保存宿主版本等上下文；它不是会话格式，不代替原件。

| API | 合同 |
|---|---|
| POST /v1/snapshots/{id}/observations | offset=0、limit=50（1–100）、kind、search、session_id；先过滤全部可见记录再分页 |
| 同上，record_id | text_offset、text_limit（最多32768）；分段读取完整公开记录 |
| GET /v1/sources/{id}/content | 原件 base64、sha256；读取时重新校验摘要 |
| POST /v1/repairs | baseline_snapshot_id、repair_snapshot_id、path、issue；同 workspace 的不同快照 |
| GET /v1/repairs/{id} | 重读不可变返修证据并核对原件 |
| GET /v1/runs/{id}/repairs | 最近100个关联本次返修运行的证据链 |

观测响应 contract=agentlineage.observations/v1。每个 record 有原生 adapter、
session_id、kind(message/tool-call/tool-result)、时间及原件 evidence。
工具结果的成功状态只来自原生回执。不可用时间保持空值，不补造时间。
evidence.ref 是索引引用，pointer 是原件行或 DevEco JSON pointer；必须同时保留 source_id 和 SHA-256。
结果隐藏私有推理，对凭据脱敏；单条列表最多8192字符，excerpted 标记后可用 record_id 分段打开。

返修对象包含前后文件写入、行归属/断链、快照来源和宿主 context。
semantic_verified 始终为 false；evidence_ready 仅表示两侧都有文件操作证据，
不代表原因正确或修复通过。issue 是调用者的问题陈述，不作为真实结论。

## 调查服务

Learning 0.1.0a2 新增 POST /v1/investigations/query（run_key）重新查找已保存调查。
GET /v1/investigations/{id}/cases 返回机械检查后的案例卡正文。
沿用已有 /v1/investigations、cancel、resume 和预算合同。配置 executor 后才执行分析，
没有 executor 时进入 executor_unavailable；模型返回仍为草稿，不自动发布经验。

HarnessCore 用 Core 保存证据，通过 Learning HTTP 上传相同原件并启动调查；
Core 不反向依赖 Learning 或 HarnessCore。部署方负责同一 workspace 的认证和数据保留。


## Agent Run capability (Core 0.1.0a3)

GET /v1/capabilities advertises agent-run-v1. POST /v1/sources?format=host-activity accepts a UTF-8 JSON document with schema=agentlineage.host-activity/v1, name/status/started_at/duration_ms/cost_usd/session_id and arrays events/trace/resources. This is supplemental host evidence, never a replacement native transcript. One host-activity source per snapshot is allowed.

Observation queries return overview (native calls, paired results, timing, usage, host trace/resources/workflow/warnings), and activity_filters.types/sources. kind=host-event selects host logs; level/span_id/event_type/source and search filter the complete saved history before paging. Unknown usage remains null. Native conversation records remain the default; absent native records produce explicitly labelled host-history. Host event IDs are stable across snapshots; evidence still identifies the immutable source and /events/N pointer. Host event detail is available through record_id and chunked evidence reading.

Source upload partial=true allows a torn final JSONL row while preserving exact bytes. The index omits only that incomplete row, retains original line coordinates, and adds invalid-json to gaps. Strict upload remains the default.

Caller must distinguish recorded tool failure from host stage failure and absence from zero. Parent relationships come from native metadata. Timings and ownership facts do not prove semantic cause or repair success. Core does not control task pause/resume, approve actions, or invoke models.

Core 0.1.0a4 新增按消息分页、content_only 与跨页工具配对；见 [实时及分页合同](live-streams-v1.md)。不指定 page_unit 时保留原记录分页行为。
