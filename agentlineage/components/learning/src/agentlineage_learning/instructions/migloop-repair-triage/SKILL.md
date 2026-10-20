---
name: migloop-repair-triage
description: 从完整迁移转录识别生成后的实际修复，按具体问题整理改动、目标文件和参与者，生成后续归因调查的任务清单。
---

# 拆分修复问题

输入完整迁移转录目录、单份转录或指定根会话的 DevEco 数据库。输出 `repair-tasks.yaml`，交给后续制卡调查员。

发布包自带元数据、派工及 YAML 解析脚本，Python 3.12+ 即可运行；依赖已安装的 agentlineage-learning 及其 Core 包，不依赖相邻 skill 目录。制卡是独立下一步，本 skill 不运行归因核验或模型派发。

1. **确定范围。** 找到工程、主会话与子转录，按历史记录确定生成结束和观察截止，记录依据及缺失材料。
2. **盘点修改。** 对照修复报告与实际调用，检查 Write/Edit、patch 和 shell/脚本的请求及回执，追到最终保留的修改。采用最终保留状态为本次正确参照。
3. **按问题分组。** 每项写清原表现、改成什么、涉及文件及参与 agent。同类问题可跨文件，不同验收要求分别成任务。截图、日志、测试支撑等另列；脚本对应用的实际修改仍纳入，效应待核的调用列 pending。
4. **保存并对账。** 按下方模板写 YAML，核对已审查改动都有去向。根因与证据树由制卡阶段完成。

历史材料只读，调用用于取证。交付清单路径、调查范围及缺口。生成结束/观察截止使用有依据的带时区时间，未知填null并说明。脚本核当时正文和各目标回执，失败调用也检查部分写入；辅助产物与应用修改混在同次调用时分别记录。

## 准备派工

宿主需要 job 时，在本 skill 目录执行：

```text
python scripts/triage.py metadata --pool MATERIALS --out METADATA.json
python scripts/triage.py dispatch --tasks repair-tasks.yaml --metadata METADATA.json --out NEW_JOBS
```

已有服务端元数据用 `--server-metadata FILE.json`；DevEco用 `--session-id ID` 指定根及后代。dispatch生成任务文件，模型调度由宿主负责。

metadata 同次扫描会从 CC/Codex 已记录的配置调用与成功回执提取 SDK/API、关键依赖和工具链版本线索，供所有制卡任务共用；模型不手填、不为补齐版本额外运行工具。配置声明、实际工具输出、讨论中的 API 可用性分开处理；没有历史记录的字段保持未知，不读取当前工程冒充历史。DevEco 原库目前仍只采集会话头信息，版本环境需有可识别的历史 JSONL 回执。

每个调查员使用独立新会话，只拿 `migloop-build-cards`、一个job和完整转录入口。任务提供修改线索，归因由调查员依据原文得出。

## 任务清单

set_aside按实际用途选择artifact（截图/日志等）、test_support、pipeline_tooling或unrepaired（有报告但未实施修改）；效应待核的调用单独列pending。

```yaml
schema: migloop-repair-triage/1
scope:
  project_roots: []
  source_roots: []
  materials: []
  generation_end: null
  observation_end: null
  boundary_evidence: []
issues:
  - title: "具体偏差"
    observation: "原表现与目标表现，标明报告来源"
    changes:
      - files: ["真实目标路径"]
        change: "改了哪些属性/操作，最终保留什么"
        evidence: ["原始修改请求与回执位置"]
    participants:
      - agent: "转录路径或数据库session标识"
        role: "发现/协调/修复/复核等实际角色"
        action: "此人具体做了什么"
        evidence: ["对应原文位置"]
    questions:
      - "留给制卡调查的输入、偏差来源或交接问题"
set_aside:
  - category: artifact
    item: "已检查产物组"
    reason: "用途"
    evidence: []
pending:
  - item: "效应待核调用"
    evidence: []
    next_check: "可核查的历史材料"
coverage:
  reviewed: "实际审查过的会话、调用和时间范围"
  gaps: []
```

占位值换成真实材料，无条目用[]。JSONL引用用相对转录名、物理行号和必要的调用ID；数据库用session及message/part主键。声明引用所属材料池。批量修改可共享脚本引用，同时列出已有依据的具体目标。

交付前确认已审查的应用修改都有issue/搁置/未决去向，包含主会话直改、批量脚本和修复后再修。报告缺失转录及未扫描范围。清单无需持久ID或图节点，后续dispatch自动补身份。
