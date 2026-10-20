# 接入与迁移

## 已抽取的来源

Core 的 inquiry 来自 migbot-server 的固定快照；行级重放来自 hmigbot-plus Insight。
Learning 的 case/memory 算法和指令资源来自 migbot-server 的 memorylib bundle。
逐文件原始 SHA、源 commit 与当前变换摘要在 provenance.json。原仓库源码未修改。

可接入顺序：

1. 宿主继续保存原生会话。显式选择已获授权的材料，调用 Core sources/imports。
2. 保存 run_id、snapshot_id 和 Viewer URL。业务阶段放宿主映射，不写入通用算法。
3. 查询和机械校验走相同的 Core 包/HTTP/MCP。先双读对比旧报告，不替换旧数据。
4. 需要经验时将同一材料包交给 Learning；保存它返回的冻结 snapshot 与调查 ID。
5. 按业务测试集核验归因与制卡，再经发布者入库和经验归并。已发布 revision 可回溯。

当前 Learning 使用本地 Core 公共 SDK 建立自己的证据快照，不读取远程 Core 私有数据库。
共享外部 Core snapshot、对象存储与大型材料流式传输尚未实现；同一批材料可以显式分别上传。
这是本版和完整方案的差异，不能把两个服务的 snapshot_id 混用。

## 原会话与内部投影

Claude JSONL、Codex rollout/execution records 原字节保留；DevEco JSON 导出保留原件，
另生成内部 JSONL 投影用于查询，并分别记录 original/index SHA。没有对外强制新的会话格式。
自动遥测上传、原有 consent、DevEco 禁用遥测政策仍由宿主管理；本组件不注册上传 hook。

## 本版未迁走的能力

HMigBot Orchestrator/EventStore 会话发现、Insight 实时流/比较/分析聊天、server 鉴权与云存储、
ECAT/HiTest/verify 执行器、鸿蒙阶段映射均保留在宿主。旧环境解析器隔离在 Learning
extensions/hmigbot_environment.py，默认仅接受明确记录的通用环境事实。
引入该扩展仍需适配入口，不能宣称已自动启用。

完整方案中的事件增量/SSE、多租户 ACL、分布式 worker、模型供应商正式适配、
自动模型 triage/经验归并、人工复核 UI、跨版本迁移、第二产品真实复用是后续验收项。
当前支持调用者提供 triage、模型 case draft、机械反馈闭环和显式 proposal 发布。
这些限制不阻碍其他团队现在通过 wheel/HTTP/MCP 试接入已有原生会话。
