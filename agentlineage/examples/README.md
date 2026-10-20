# 可以直接运行的 API 示例

这些例子使用合成 Claude 原生会话，不调用模型、不使用生产数据。输入格式仍是原生 JSONL：
generation.jsonl 中 worker 读取 spacing=4、写出 spacing=8；
repair.jsonl 中 fixer 把它改成 spacing=4。
case-draft.json 是预置的案例草稿，triage.json 是调用者提供的问题清单。

## 1. 不启动服务，完整体验 SDK

在仓库根目录，Python 3.12+：

```powershell
Set-Location D:\work\AgentLineage
# 首次安装；已有本仓库 .venv 可以直接运行下一条 quickstart
.\.venv\Scripts\python.exe -m pip install -e ./components/core -e ./components/learning
.\.venv\Scripts\python.exe examples/quickstart.py
```

没有 .venv 时，先执行 `python -m venv .venv`。
每次运行在 .work/examples/sdk-随机编号 新建独立目录，保留以前的运行结果。
也可以用 --output 指定一个不存在的目录。

实际调用链：

```python
core = Core(output / "core")
snapshot = core.import_files("spacing-demo", sources)["snapshot_id"]
history = core.query(snapshot, {
    "op": "file", "key": "/demo/view.py",
    "at": "2026-01-01T00:00:09Z", "view": "relations",
})
lineage = core.file_lineage(snapshot, "/demo/view.py", "2026-01-01T00:00:09Z")

learning = Learning(output / "learning")
initial = learning.initialize()
investigation = learning.prepare("spacing-demo", sources, triage)
case = learning.pack_case(investigation["id"], investigation["jobs"][0]["id"], draft)
state = learning.ingest([case["path"]], initial["revision"])
published = learning.apply_proposal(proposal_with_base_revision)
found = learning.search("spacing")
```

完整变量、proposal 与可执行代码在 quickstart.py。ingest/apply 是样例显式展示的发布者动作；
产品中的审阅应发生在调用之前。机械校验不会替你批准发布。

成功输出应包含：
- confirmed_writes: 2
- takeovers: fixer 接手 worker 的 1 行
- case_status: valid
- retrieved_lessons: 1
- semantic_verified: false

report 指向可直接打开的 HTML；knowledge 指向导出的经验目录 index.md。
core_data / learning_data 可用于启动服务查看刚生成的数据。

## 2. 通过 HTTP 给任意产品接入

终端 A 启动 Core（测试 token 请自行设置，勿使用生产密钥作为样例）：

```powershell
Set-Location D:\work\AgentLineage
$env:AGENTLINEAGE_TOKEN = 'local-example-token'
.\.venv\Scripts\agentlineage.exe --data-dir .work/http-demo serve --port 8110
```

终端 B 调用，环境变量需要在这个终端也设置：

```powershell
Set-Location D:\work\AgentLineage
$env:AGENTLINEAGE_TOKEN = 'local-example-token'
.\.venv\Scripts\python.exe examples/core_http.py
```

脚本只用 Python 标准库，按顺序调用：
POST /v1/runs → POST /v1/sources（两份原始字节） →
POST /v1/runs/{run_id}/snapshots → POST /v1/query。
输出实际查询结果与 Viewer URL；打开页面后用同一个 token 登录。

换成自己的会话：

```powershell
.\.venv\Scripts\python.exe examples/core_http.py --source C:/sessions/run.jsonl --file /path/as/recorded/in/session.py --at 2026-10-08T12:00:00Z
```

--source 可以重复；--file 必须是会话里实际记录的完整路径；--at 带时区，表示观察截止点。
DevEco 导出文件也通过同一个 sources 入口识别。此示例只上传你显式传入的文件。
SDK 不需要网络服务；HTTP 适合 Java/Go/Node 等其他语言或远端宿主。

## 3. Learning HTTP 和 Agent 工具

Learning 默认端口 8111，独立服务和数据目录。完整实际接口见 ../docs/interfaces/implemented-v1.md。

- POST /v1/investigations：传 source_ids、run_key、triage、budget；获得调查 ID。
- GET /v1/investigations/{id}：看进度、用量与案例。
- POST /v1/memory/search：传 {"query":"spacing"}，查已发布经验。
- POST /v1/cases/ingest、/v1/memory/proposals：发布者显式入库/归并，使用独立发布 token。

source_ids 必须来自该 Learning 实例的 /v1/sources，不能直接拿另一个 Core 服务的 ID。
自动调查需要先配置 executor；没有 executor 会返回 executor_unavailable。
quickstart 的预置草稿演示的是制卡与经验链路，不是实际模型调查质量。

Core MCP 提供 investigate/page/submit。DSH 插件提供 lineage_query/open/check；
配置 Learning 后增加 lineage_cases/memory_search，显式启用调查后增加 lineage_investigate。

## 本轮运行验证

2026-10-08，Windows / Python 3.12.10：
- quickstart.py 实际通过：2 次写入、1 行接手、有效机械制卡、1 条经验检索、报告/知识库导出。
- core_http.py 对临时 loopback Core 服务实际通过：上传、快照、查询；查询得到 2 次写入。
- ruff check examples 通过。
- 服务测试结束后已关闭；没有真实模型调用、commit 或 push。
