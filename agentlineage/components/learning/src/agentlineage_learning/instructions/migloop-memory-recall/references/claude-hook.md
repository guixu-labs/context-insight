# Claude Code 任务开始与写前双提醒

维护者接入时读取。运行中的迁移代理只需要 SKILL.md 和经验 index.md。

1. 用 maintain 的 export 生成应用阅读包（不加 --link-cards），建议放在项目 `.claude/migloop-memory/v1`。
2. 在包含本脚本的维护版 skill 中运行：

```text
python scripts/claude_hook.py install --project PROJECT --memory READING_DIRECTORY
```

首次安装复制轻量召回 skill 与 hook 到项目，合并 `.claude/settings.local.json`，保留已有设置并备份旧设置文件。不改迁移 skills、源码、权限策略或全局配置。已有安装加 `--update`，先在 `.claude/migloop-hook-backups/` 备份再替换本 hook/召回说明；保留 config、经验包、runtime 和其他 hooks。此更新不更换经验版本；与完整 skill 包的 install_bundle 是两个部署范围。

3. 在项目目录启动新的 Claude Code 会话；正常接受该项目的工作区信任。`--safe-mode`、`--bare`、`disableAllHooks` 或组织策略可能禁止项目 hook。不要用这些模式跑需要召回的迁移。

## 行为

- **开始召回**：子代理 `SubagentStart`、主会话首次 `UserPromptSubmit` 注入轻提示，按刚收到的任务选择经验。各代理只提醒一次，不阻断启动；纯只读代理也收到启动提示，但不会进入写前暂停。
- **写前复核**：`PreToolUse` 在首次明确写入前返回 deny，给模型一次按经验调整待写内容的机会。即使启动时已读入口，这次提示仍保留；只复核、补漏，不要求重复阅读。不是用户拒绝，无需询问用户。
- 模型用 Read 完整读取项目内召回 skill 和根 index；已读可复用。写前提示已发出且两个入口已读时，重试回到原有权限流程，hook 从不返回 allow。只记录提醒和读取，不机械判断是否理解、采用或真的修改了方案。
- 主代理和所有类型子代理按 session_id + agent_id 隔离。启动提示和写前提示分开记账；跨会话不复用，恢复同一个代理不重复提醒。
- 日志位于 `.claude/migloop-runtime/`，记录提醒、索引/经验读取、恢复与首次成功修改的时间和工具调用 ID，不复制源码或工具正文。读取记录不是采用或理解的证明；采用理由留在代理原本的结果里。
- 写入检测以 **precision 优先**：原生 Write/Edit/MultiEdit/NotebookEdit 必拦；Shell 只识别直接文件重定向、tee 到文件、cp/mv、sed 原地修改、apply_patch，以及 PowerShell 的 Set-Content/Add-Content/Out-File/Copy-Item/Move-Item 等明确动作。识别实际命令位置，不把引号、注释、heredoc 正文里的命令文字当执行。
- `2>/dev/null`、`2>&1`、PowerShell `>$null`、目录准备和只读调用放行。单凭 python/node/bash、脚本名或 `--output` 不触发；不递归分析脚本体，不展开动态路径，复杂语法不确定就放行。因此不透明脚本可能先写，首次明确动作也可能只是临时产物；这是提醒的覆盖边界，不是安全沙箱或精确业务阶段判定。
- 不重置已有会话记录，不向已进入写前流程的代理补发启动提示。完整双提醒从新会话/新代理验证，旧会话已读状态继续有效。
- 当前以完整 Read 观察入口阅读。用 Bash cat 或 Skill 工具读取后若仍收到提醒，按提示 Read 两个短入口即可。
- 入口或状态损坏会返回具体错误。要暂时停用本功能，将 `.claude/migloop-memory.json` 的 enabled 设为 false；无需删除配置，也不影响其他 hook。

只有入口读取是机械门槛，经验选择交给模型；没有相关经验可立即继续，不要求写报告、强制加载某条经验或核查历史卡片。

此适配器用于 Claude Code 当前支持 agent_id 的工具 hook，Codex/DevEco 尚未接入。官方协议：[Hooks reference](https://code.claude.com/docs/en/hooks)。
