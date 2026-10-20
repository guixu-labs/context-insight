# 原生会话增量 API（Core 0.1.0a5）

`live-streams-v1` capability，响应 `agentlineage.live/v1`。独立 HTTP 服务、Bearer 认证和同源限制沿用 implemented-v1.md。路径中的 run 是 Core 创建的运行。原件仍使用 Claude/Codex JSONL、DevEco 原生导出；下面是传输封装，不是替代会话格式。

| 方法与路径 | 内容 |
| --- | --- |
| GET /v1/runs/{run}/live/state | 来源 key、format、session_id、字节 offset、revision、消息摘要、已确认块摘要、全运行 cursor |
| POST …/live/append | key、format(claude/codex)、session_id、offset、content(base64) |
| POST …/live/upsert | key、format(deveco)、session_id、revision、info、messages；messages 为变化的原生消息，含原生 parts |
| POST …/live/query | 首次返回最新页；after 返回游标之后的 upsert/remove 变化，has_more 表示继续追赶 |
| POST …/live/freeze | 可选 context/gaps；重建原件并创建不可变快照，用于返修和历史查询 |

## 原件、重试与证据

JSONL offset 按字节计。每块 1–512 KiB，每来源最多 64 MiB；不完整行及跨块 UTF-8 留到下一块。已确认的相同块重试幂等，错位、改写或身份不同返回 409；非法完整行原子回滚，不静默跳过。未完整行上限 2 MiB。最多 102 来源。

DevEco 采用 revision CAS；相同批次重试幂等，旧 revision 冲突。消息和 part 原生 ID 绑定所属 session，更新同一个 part 不生成重复展示行，删除 part 生成 remove。宿主活动只能以 host-activity 独立来源补充，不能伪装成原生对话。

游标、原始块、原生文档、变更和公开记录均持久化到组件 SQLite。查询传 record_id、revision、text_offset 可读取当时的证据，后续更新不覆盖旧 revision；content_only=true 只返回公开正文。偏移按 Unicode 字符而不是 UTF-16 单元计，默认每段 16384 字符。凭据脱敏且隐藏私有推理。组件不控制宿主任务。

## 100 条消息与传输续页

`page_unit=messages` 时，total/offset/end_offset/next_offset 只统计 kind=message 且 role=user/assistant；工具不消耗名额。每条消息后面的工具直到下一条消息都保留在所属页，开头的工具归第一页。没有消息的工具历史仍可读取，total=0。默认 records 单位保持旧合同，日志照常按记录分页。

消息页可能含很多工具，所以独立服务每次最多传 20 个原始展示记录。响应 next_record_offset 非空时，用相同筛选、offset、record_offset 继续读；直到空才是完整页面。冻结查询携带相同 snapshot_id；实时初始读取携带首次 cursor 作为 at_cursor，保持一致视图。实时固定视图后新产生的内容从 after=cursor 获取。after 的变化批次上限 100，不是消息页大小；追赶完成后按 first_record_id 和 page_record_count 保留当前最新消息页。

实时 query 同样支持 kind/search/session_id/level/span_id/event_type/source。单条列表正文最多 8192 字符，excerpted 可继续取完整正文。工具 call/result 用原生关联配对，pair 也携带可读取的 revision。origin 从 host-history 变 native 时调用方重新加载窗口。

## 消费方式

1. 创建或查询 Core run，读取 live/state。
2. CC/Codex 从已确认 byte offset 读取新字节并 append；断线重发原块。不能拼接已被替换的文件。
3. DevEco 对比原生消息摘要，仅 upsert 变化的文档。
4. query 首次读取最新页，按 next_record_offset 补齐；以后 after 追增量，has_more 时继续追赶。
5. 展示层将连续工具配对合为可折叠步骤组。摘要只描述真实工具动作，不生成未经验证的业务结论。
6. 返修分析使用冻结快照，实时游标不替代证据版本。

HTTP 为有界增量轮询，当前没有 SSE。原始格式解析只针对新增行或变化文档；查询筛选仍扫描当前投影。HarnessCore 会保留自己的原件副本及计算完整摘要。多租户 ACL、分布式采集、模型归因质量不属于本合同的验证结论。

会话元数据包含可选 name：来自 DevEco 原生 info.title，脱敏并限制为 256 字符；没有原生标题时返回 null，展示层使用一致的可读名称，不把内部 ID 当标题。冻结快照保留当时名称，后续原生重命名只更新实时名称。
