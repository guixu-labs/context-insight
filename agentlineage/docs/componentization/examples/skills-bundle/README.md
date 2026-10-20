# Skills 资源 Bundle 接入示例

按主指南第 7.2、7.9 节准备同版本 DSH、测试 profile 与模型环境，使用 `npm pack --ignore-scripts` 打包后安装 tarball。源码只完成静态核对，真实宿主验收须自行记录。

资源根由 `import.meta.url` 从已安装模块位置解析，不使用开发机 cwd。插件复用 DSH 的 filesystem provider，关闭默认根，只挂载自己的 assets/skills，使用唯一 providerName；随包资源不启用监听。

在标准 preset 的新会话中请求：“加载 component-check skill，读取其 references/checklist.md，说明验收条件并返回检查码。”应先有 skill 加载与资料读取，再看到 DSH-SKILL-REF-01。不存在该 skill 时检查插件激活、资源文件、providerName、当前 preset 的 skill/read 工具。

本包只有资源及薄加载器，不提供 component_health，也不发起 HTTP 请求。与 HTTP 示例组合时再按需调用该工具。默认图标仅用于示例；正式交付按团队要求补齐。

## 安装与首次调用

运行前准备匹配的 DSH `0.2.1-alpha.2`、Node 与 pnpm；本包只完成静态和打包检查，真实 DSH 激活与模型调用仍需验收。本包不需要 HTTP 服务。保留 assets/skills/component-check 下的正文和 references。

1. 从包目录执行 `npm.cmd pack --ignore-scripts`，记录输出的 `.tgz` 完整路径。已有 tarball 时直接使用它，不要复制开发目录路径给其他使用者。
2. 用未使用过的 Profile 名称执行 `dsh --profile component-skills-check --from-default-profile web --dump-config`。已有同名 Profile 时跳过创建，避免新版 DSH 重置该目录。
3. 执行 `dsh plugin --profile component-skills-check add '<实际 tarball 完整路径>'`，用真实路径替换占位项。检查 Profile 的 `package.json` 中依赖与 Bundle 列表包含 `@team/component-skills-demo`。
4. 在该 Profile 目录的 `cordis.patch.yml` 配置实例 `team.component.skills`。默认无需配置。不要再安装同包组合示例，以免重复注册同一个 provider。
5. 执行 `dsh --profile component-skills-check --dump-config`；配置无误后用 `dsh --profile component-skills-check` 启动，打开完整启动 URL，配置模型并新建会话。
6. 要求 Agent 执行：加载 component-check 并读取 references/checklist.md。完成标准：新标准会话实际加载正文和引用，返回 DSH-SKILL-REF-01；读取说明不代表服务已通过检查。

Profile 位于当前 `DSH_HOME/profiles/component-skills-check`；未显式设置 DSH_HOME 时按当前 DSH 安装的 home 设置定位。配置写在 Profile，不改已安装包中的默认 patch。重装或更新后重启同一 Profile；退出 DSH 不会自动关闭另一个终端运行的 HTTP/MCP 服务。
