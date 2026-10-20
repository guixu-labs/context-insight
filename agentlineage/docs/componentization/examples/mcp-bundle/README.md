# 配置型 MCP Bundle 接入示例

本包只有装配配置，没有自定义 DSH 运行代码，也不包含 MCP 服务。它参考 DSH `0.2.1-alpha.2` 随附的 MCP bundle 模板，经过 JSON/YAML 与包内容静态检查，尚未安装到真实宿主。

前提：目标 DSH 能解析匹配版本的 `@deepseek-ai/dsh-mcp-client`，组件已经有一个可连接的 MCP 服务。这里的 `http://127.0.0.1:8120/mcp` 是占位配置，必须替换或启动对应测试服务。

在本目录执行 `npm pack --dry-run --ignore-scripts` 核对文件，再执行 `npm pack --ignore-scripts`。按随项目交付的主指南第 7.2、7.9 节创建测试 profile、安装实际 tarball、检查配置并启动。工具来自 MCP 服务的真实发现结果，不由本包凭空生成；名称形如 `mcp__component_demo__ping`，其中 `ping` 只有服务确实提供时才存在。

若服务需要 token，在 profile 的完整 `config` 中增加：

```yaml
headers:
  Authorization: !!js '`Bearer ${process.env.COMPONENT_MCP_TOKEN}`'
```

从安全配置渠道设置变量，不把值写进包或聊天。修改 `config` 时保留 serverName、transport、url 等全部必需字段。若使用 stdio，改用该传输的 command/args/env/cwd 字段，并验证进程启动和退出。

真实验收包括发现并调用工具、服务不可用、凭据错误、取消与重连。初始激活失败不必然阻止整个 Web 启动，应单独检查插件。正式交付补组件名称、文档和图标；此示例包使用默认图标。

## 安装与首次调用

运行前准备匹配的 DSH `0.2.1-alpha.2`、Node 与 pnpm；本包只完成静态和打包检查，真实 DSH 激活与模型调用仍需验收。先准备实际 MCP Server；HTTP health 服务不能代替 MCP。远程服务须已启动，本地 stdio 程序须已安装。

1. 从包目录执行 `npm.cmd pack --ignore-scripts`，记录输出的 `.tgz` 完整路径。已有 tarball 时直接使用它，不要复制开发目录路径给其他使用者。
2. 用未使用过的 Profile 名称执行 `dsh --profile component-mcp-check --from-default-profile web --dump-config`。已有同名 Profile 时跳过创建，避免新版 DSH 重置该目录。
3. 执行 `dsh plugin --profile component-mcp-check add '<实际 tarball 完整路径>'`，用真实路径替换占位项。检查 Profile 的 `package.json` 中依赖与 Bundle 列表包含 `@team/component-mcp-demo`。
4. 在该 Profile 目录的 `cordis.patch.yml` 配置实例 `team.demo.mcp`。在 Profile patch 中填写完整 MCP config：serverName、transport 和该传输的地址或 command/args。按实际服务补鉴权。
5. 执行 `dsh --profile component-mcp-check --dump-config`；配置无误后用 `dsh --profile component-mcp-check` 启动，打开完整启动 URL，配置模型并新建会话。
6. 要求 Agent 执行：真实 tools/list 返回的工具名。完成标准：服务日志和返回值对应本次调用；再验证服务不可用、取消和恢复。

Profile 位于当前 `DSH_HOME/profiles/component-mcp-check`；未显式设置 DSH_HOME 时按当前 DSH 安装的 home 设置定位。配置写在 Profile，不改已安装包中的默认 patch。重装或更新后重启同一 Profile；退出 DSH 不会自动关闭另一个终端运行的 HTTP/MCP 服务。
