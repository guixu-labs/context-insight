# HTTP 接入示例

本包演示一个 npm 包同时提供 plugin 和 bundle。它使用 DSH `0.2.1-alpha.2` 源码中的工具契约，经过 JS 语法与打包内容静态检查，尚未在真实 DSH 宿主安装运行。目标版本不同，应先调整并验证兼容性。

配置 `baseUrl`；可选 `tokenEnv` 是已有环境变量的名称。示例要求独立服务提供 `GET <baseUrl>/health`，返回一个很小的 JSON，例如 `{"status":"ok"}`。该地址和接口是示例约定，不是 Insight 或 AgentLineage 的现有接口。调用传递取消信号、设置五秒超时并拒绝重定向。

本包不包含 HTTP 服务，不会自行启动服务。没有配置 token 时可连接本机不需要认证的测试服务；真实服务按其鉴权要求配置。示例只校验 health 结果，不是可直接推广到任意响应体的通用 HTTP 客户端。

在本目录执行：

```powershell
node --check index.js
npm pack --dry-run --ignore-scripts
npm pack --ignore-scripts
```

安装和配置按随项目交付的主指南第 7 章执行。工具名为 `component_health`，成功返回服务实际报告的 `status`。`degraded` 等状态需要按原值解释，不能一律视为业务通过。

修改为自己的组件时，替换包名、实例 ID、工具 schema 与调用，明确失败和取消语义，加入接口需要的响应大小限制和结果校验。按团队交付要求补图标；此示例包使用宿主默认图标。不要把本包的 health 验证当成业务集成完成。

## 安装与首次调用

运行前准备匹配的 DSH `0.2.1-alpha.2`、Node 与 pnpm；本包只完成静态和打包检查，真实 DSH 激活与模型调用仍需验收。先启动独立服务，确认 GET /health 返回带字符串 status 的 JSON。包内不包含服务。

1. 从包目录执行 `npm.cmd pack --ignore-scripts`，记录输出的 `.tgz` 完整路径。已有 tarball 时直接使用它，不要复制开发目录路径给其他使用者。
2. 用未使用过的 Profile 名称执行 `dsh --profile component-http-check --from-default-profile web --dump-config`。已有同名 Profile 时跳过创建，避免新版 DSH 重置该目录。
3. 执行 `dsh plugin --profile component-http-check add '<实际 tarball 完整路径>'`，用真实路径替换占位项。检查 Profile 的 `package.json` 中依赖与 Bundle 列表包含 `@team/component-demo`。
4. 在该 Profile 目录的 `cordis.patch.yml` 配置实例 `team.component.demo`。在 Profile patch 中覆盖完整 config，填写 baseUrl；需要鉴权时加 tokenEnv，值是已有环境变量的名称。
5. 执行 `dsh --profile component-http-check --dump-config`；配置无误后用 `dsh --profile component-http-check` 启动，打开完整启动 URL，配置模型并新建会话。
6. 要求 Agent 执行：component_health。完成标准：真实工具调用返回服务的 status，服务日志收到对应请求；再停服验证失败。

Profile 位于当前 `DSH_HOME/profiles/component-http-check`；未显式设置 DSH_HOME 时按当前 DSH 安装的 home 设置定位。配置写在 Profile，不改已安装包中的默认 patch。重装或更新后重启同一 Profile；退出 DSH 不会自动关闭另一个终端运行的 HTTP/MCP 服务。
