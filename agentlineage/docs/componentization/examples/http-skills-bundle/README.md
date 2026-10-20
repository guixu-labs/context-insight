# 同包多插件接入示例

用独立测试 profile 安装本包；不要同时安装 HTTP 或 Skills 单独示例，它们会注册相同的工具/provider。完整操作见主指南第 7.2、7.9 节。

http.js 与 HTTP 示例 index.js 相同；skills.js 与 Skills 示例 index.js 相同，资源仍相对安装模块解析。两个入口共享 npm 版本，patch 使用独立实例 ID。默认仅启用 health。

启用资源时，在 profile patch 中添加 `id: team.component.combo.skills`，设置 `disabled: false`、`config: {}`。重启后新建标准会话，加载 component-check 并读取检查码；关闭该实例后 component_health 仍应可用。

此示例包使用默认图标；静态与打包检查不代表真实 DSH 激活和模型调用已经通过。

## 安装与首次调用

运行前准备匹配的 DSH `0.2.1-alpha.2`、Node 与 pnpm；本包只完成静态和打包检查，真实 DSH 激活与模型调用仍需验收。先启动 GET /health 示例服务；不要在同一 Profile 安装 HTTP 和 Skills 的单独示例。

1. 从包目录执行 `npm.cmd pack --ignore-scripts`，记录输出的 `.tgz` 完整路径。已有 tarball 时直接使用它，不要复制开发目录路径给其他使用者。
2. 用未使用过的 Profile 名称执行 `dsh --profile component-combo-check --from-default-profile web --dump-config`。已有同名 Profile 时跳过创建，避免新版 DSH 重置该目录。
3. 执行 `dsh plugin --profile component-combo-check add '<实际 tarball 完整路径>'`，用真实路径替换占位项。检查 Profile 的 `package.json` 中依赖与 Bundle 列表包含 `@team/component-http-skills-demo`。
4. 在该 Profile 目录的 `cordis.patch.yml` 配置实例 `team.component.combo.health / team.component.combo.skills`。HTTP 地址修改 health 行的完整 config；启用资源时在 skills 行写 disabled: false、config: {}。
5. 执行 `dsh --profile component-combo-check --dump-config`；配置无误后用 `dsh --profile component-combo-check` 启动，打开完整启动 URL，配置模型并新建会话。
6. 要求 Agent 执行：component_health；随后加载 component-check。完成标准：两个入口分别成功；关闭 skills 后 health 仍可用；重新启用无重复 provider。

Profile 位于当前 `DSH_HOME/profiles/component-combo-check`；未显式设置 DSH_HOME 时按当前 DSH 安装的 home 设置定位。配置写在 Profile，不改已安装包中的默认 patch。重装或更新后重启同一 Profile；退出 DSH 不会自动关闭另一个终端运行的 HTTP/MCP 服务。
