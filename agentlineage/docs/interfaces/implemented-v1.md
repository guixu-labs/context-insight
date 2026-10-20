# 已实现接口：0.1.0 alpha

本文件对应源码和测试。openapi-*-draft.json 对应完整方案，尚未实现的路径不能按草案调用。
HTTP 为单 workspace；Bearer token 在服务启动时配置。错误含 error.code/message。
POST 支持 Idempotency-Key：同路径、同 key、同 body 重放结果；不同 body 返回 409。
本版的幂等响应缓存与状态写入尚不是一个数据库事务，进程在两次提交之间崩溃时可能需要按任务 ID 对账；
它不是分布式 exactly-once 保证。

## Core

Core 0.1.0a10 新增原生 DSH v4 JSONL 格式（capabilities.features 含 dsh-native-v4）。通过现有 sources/snapshots/query API 接入，无新增平行 API。DSH 插件从宿主 sessionQuery 读取当前或历史会话，经官方 codec 导出，自动创建并绑定快照；query/open/check 可省略 snapshot_id。Core 命令行支持 serve --port 0 --exclusive，供 Profile 管理本机进程。安装、七个工具与手动验证见 [DSH 插件](../../integrations/dsh/README.md)。

| 方法/路径 | 输入/输出 |
|---|---|
| GET /health、/v1/capabilities | 组件版本、支持的原生格式与能力 |
| GET /v1/runs | 最近 100 个任务 |
| POST /v1/runs | external_key、project_id、objective；返回 run |
| GET /v1/runs/{id} | task 状态与最新快照 |
| POST /v1/sources?name=worker.jsonl&format=auto | 原始 UTF-8 字节；返回 src ID、原件与投影 SHA；上限 64 MiB |
| POST /v1/runs/{id}/snapshots | source_ids、可选 gaps/context；同步返回冻结快照 |
| POST /v1/runs/{id}/imports | sources:[{source_id:…}]；202 job；后台索引 |
| GET /v1/jobs/{id}、POST /v1/jobs/{id}/cancel | 状态/取消；已完成索引不会因取消回滚 |
| GET /v1/runs/{id}/trace | snapshot_id、offset、limit；按时间增量分页的记录，非 SSE |
| GET /v1/snapshots/{id} | 材料清单、摘要、格式、completeness |
| POST /v1/snapshots/{id}/resolve | source_id、sha256、pointer、可选 record_id；精确定位公开记录，返回 resolved/unresolved/ambiguous；摘要不符 409，来源不属于快照 404 |
| GET /v1/snapshots/{id}/viewer | 交互查询页面；登录 cookie，不将 token 放 URL |
| POST /v1/query | snapshot_id、requests；1–24 项，每项独立返回 status/result |
| POST /v1/lineage | snapshot_id、path、at；行级归属与接手、断链说明 |
| POST /v1/reports/check | snapshot_id、document；机械检查 |
| POST /v1/reports | 同上；保存报告 |
| GET /v1/reports/{id}?snapshot_id=… | 读取已保存报告 |

Viewer 下 /inquiry/api/query、view、report、trace、frame、info 及 tree.js/viewer.js
挂载同一个 query/check 内核。它们是 Viewer 兼容接口；新集成优先使用上表入口。
GET / 返回任务列表，POST /login 接受 token 并创建 HttpOnly/SameSite=Strict 会话。
localhost 可无 token 运行；非 loopback 绑定必须配置 token，TLS 由部署方代理提供。
服务重启使浏览器 cookie 失效；活跃索引 job 标为失败/INTERRUPTED，不偷偷重试。

查询示例：

```json
{"snapshot_id":"snap_…","requests":[
  {"op":"catalog","kind":"file","limit":20},
  {"op":"file","key":"/project/view.py","at":"2026-01-01T00:00:09Z","view":"relations"}
]}
```

请求使用原内核的 op/kind/key/at/view；其他 op 包含 agent/search/open/diff/blame/review。
原文读取使用 ref，不能按草案中的 evidence_ref 或 scope 字段替换。列表结果通常是 rows/total。
at 是观察截止点，确定的读写按原生完成/回执时刻计；不是文件系统完整版本。
blame 是片段演变查询；/lineage 是确认写入的保守行重放，遇到未支持 patch 或不透明写入返回 incomplete。
完整查询指南可通过 Viewer /inquiry/api/info 的 guide 获取；MCP 也提供该指南。

Python：Core(directory) 的 create_run/upload_source/create_snapshot/import_files/
query/file_lineage/check_report/get_report/export_materials 为公共入口。
Core.sdk.inquiry_kernel 是 Learning 使用的兼容内核出口；宿主不应直接读取 SQLite。
CLI export 提供 HTML/JSON；HTTP export job、SSE 和通用事件 ingest 本版未提供。

原生观测分页、公开证据续读、原件读取、返修链保存与重读见 [observations-v1](observations-v1.md)。这些是 Core 0.1.0a3 的正式实现接口。

## Learning

| 方法/路径 | 输入/输出 |
|---|---|
| GET /health、/v1/capabilities | 组件版本、是否配置 executor |
| POST /v1/sources?name=worker.jsonl | 显式上传原生材料；返回该 Learning 实例的 source ID |
| POST /v1/investigations | run_key、source_ids、triage、budget；202 |
| GET /v1/investigations/{id} | 状态、用量、尝试反馈与案例；不返回本地 case path |
| POST /v1/investigations/query | run_key；重读同一返修的最近20个调查 |
| GET /v1/investigations/{id}/cases | 该调查已通过机械检查的案例清单，含 card 正文 |
| POST /v1/investigations/{id}/cancel、resume | 取消或显式恢复；未知 in-flight 用量不允许 resume |
| GET /v1/memory/revision | 当前不可变 revision 与元数据 |
| POST /v1/memory/search | query、topic、offset、limit；词法检索，只返回可用经验 |
| POST /v1/memory/browse、/read | 主题分页 / ids 读取 |
| POST /v1/cases/read | id、可选 revision；读取已入库案例 |
| POST /v1/memory/impact | id、可选 claim；来源失效的影响范围 |
| POST /v1/cases/ingest | investigation_id、expected_revision；**发布凭据** |
| POST /v1/cases/withdraw | id、reason、expected_revision、可选 claim；**发布凭据** |
| POST /v1/memory/proposals | base_revision、upsert 等原 proposal 字段；**发布凭据** |

triage 需要 scope.project_roots/generation_end/observation_end，以及 issues 的 title/changes。
每个 change 声明 files/change/evidence。materials 由服务替换成自身冻结材料目录。
调用者提供的 triage/后修结论不是“正确答案”，executor 必须核对历史依据。

预算样例：

```json
{"max_calls":3,"max_attempts":2,"timeout_seconds":120,"max_tokens":8000}
```

默认只到 draft_ready。经验归并的 proposal 由调用者/受信任审阅者提供，
组件不会自动生成 proposal、自动语义审批或自动启动后续 Agent。
导出知识库前，proposal 需为每层主题提供 topic_descriptions（路径→用途描述），否则 export 明确拒绝。
SDK Learning.prepare/prepare_sources/pack_case/ingest/apply_proposal/search/
browse/read_lessons/get_case/impact/withdraw/export 可独立使用。
CLI 提供 prepare/pack/ingest/apply/search/export/execute；SDK 包含完整撤回与影响 API。

## 版本与格式

Core 包版本与 inquiry/index/6 独立；Learning 包版本与历史 migloop-case/4、migloop-memory/1
等 schema 独立。旧标识保留以免“改名”破坏已有格式。当前同批版本固定兼容。
原件字节不转换；DevEco export 的索引投影会另记 digest。没有从日期先后推定因果。
模型/工具文本中的 PASS 不是宿主验证结果；mechanical valid 也不是语义确认。
