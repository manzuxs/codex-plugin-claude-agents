---
name: claude-agent-admin
description: 配置、检查、排障或扩展 Claude Code Agents 插件；处理 .env、模型、思考强度、API 网关、密钥注入、智能体 XML 提示词、MCP 状态和 dry-run。
---

# Claude Code Agents 管理

## 安全配置原则

1. 真实密钥只写入插件根目录 `.env`、项目 `.claude-agents.env`、操作系统密钥管理器或 CI secret。
2. 不把 `.env` 提交到 Git；仓库只保留 `.env.example`。
3. MCP 返回的配置视图只显示 `gatewayConfigured`、`credentialConfigured` 和 `browserMcpConfigured` 等布尔状态，不返回值或配置路径。
4. 子进程使用参数数组且 `shell: false`，避免把用户任务拼成 shell 命令。

## 配置优先级

从低到高：

1. 插件根目录 `.env`
2. 当前项目 `.claude-agents.env`
3. 启动 Codex 的进程环境变量
4. 单次 `run_agent` 的非秘密覆盖字段

不要通过单次工具参数传递真实密钥。

## 每个智能体的变量

前缀由 `agents/agents.json` 定义，例如 `BACKEND_ENGINEER`：

- `<PREFIX>_MODEL`
- `<PREFIX>_EFFORT`
- `<PREFIX>_PERMISSION_MODE`
- `<PREFIX>_TIMEOUT_MS`
- `<PREFIX>_MAX_BUDGET_USD`
- `<PREFIX>_GATEWAY_URL`
- `<PREFIX>_API_KEY`
- `<PREFIX>_API_KEY_KIND`：`auth_token` 或 `api_key`
- `<PREFIX>_EXTRA_ENV_JSON`
- `<PREFIX>_BROWSER_MCP_CONFIGS_JSON`：浏览器 MCP profile 名称到绝对配置文件路径的 JSON 映射，仅由受信任配置提供

未设置时回退到 `CLAUDE_DEFAULT_*`。

浏览器能力默认不加载，只有 `ui-designer`、`frontend-engineer` 和 `qa-engineer` 可启用。UI 设计师用于真实渲染与截图验收，前端工程师用于实现自测，QA 用于独立冒烟与 E2E。`run_agent(browserMode=repository)` 使用仓库已有 Playwright/Cypress；`chrome` 显式添加 Claude in Chrome，且 API 网关环境会在启动前阻止该组合；`mcp` 通过 `browserMcpProfile` 选择预配置 profile，只有一个 profile 时可省略名称。

浏览器模式沿用正常配置优先级解析出的权限，不强制或覆盖 `permissionMode`；需要避免非交互审批阻塞时，为对应角色配置 `<PREFIX>_PERMISSION_MODE=bypassPermissions`。MCP profile 同样使用对应角色的 `<PREFIX>_BROWSER_MCP_CONFIGS_JSON`，不得通过单次工具参数接收任意配置路径。

插件在静态依赖检查后还会读取 Claude `system/init` 事件，确认目标浏览器工具确实注入，并记录实际浏览器工具调用。任一门禁失败都返回 `blocked` 和 `installationHint`，不得由 Codex 自身浏览器静默代跑。

## 排障顺序

1. 运行 `npm run doctor`。
2. 运行 `npm run list-agents`，确认模型、effort 和权限的非秘密视图。
3. 使用 `run_agent(..., dryRun=true)`，检查最终 CLI 参数、`--agents`/`--agent` 原生智能体加载和 XML 委派提示词预览。
4. 确认 `claude --version` 与本地登录状态。
5. 检查 Codex 中插件 MCP server 是否启用，以及 `run_agent` 的工具审批策略。
6. 实际调用失败时，读取 `stderr`；不要输出或复制完整环境。

正常 `run_agent` 显式使用 `background=true` 并按 `nextPollSeconds` 查看紧凑进度；`job_status` 只读状态，不承担租约续约。用户明确要求“不轮询”“静默等待”或“完成后再告诉我”时，使用 `background=false` 前台挂起。

排障输出只保留命令、退出码、首个关键错误和日志路径；完整事件流仅在明确诊断时通过 `job_result(full=true)` 读取。

## 新增智能体

1. 在 `agents/agents.json` 新增唯一 id、别名、环境变量前缀、XML 文件和默认权限。
2. 在 `agents/<id>.xml` 定义身份、知识、方法论、质量门禁、执行协议和报告结构。
3. 在 `.env.example` 增加该前缀的非秘密模板。
4. 更新 `claude-orchestrator/SKILL.md` 的称呼映射。
5. 运行测试和 dry-run。

XML 提示词应描述可观察的工作方法与质量门禁，不应要求模型输出私有思维过程。
