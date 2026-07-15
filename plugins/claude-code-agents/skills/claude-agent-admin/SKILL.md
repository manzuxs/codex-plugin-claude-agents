---
name: claude-agent-admin
description: 配置、检查、排障或扩展 Claude Code Agents 插件；处理 .env、模型、思考强度、API 网关、密钥注入、智能体 XML 提示词、MCP 状态和 dry-run。
---

# Claude Code Agents 管理

## 安全配置原则

1. 真实密钥只写入插件根目录 `.env`、项目 `.claude-agents.env`、操作系统密钥管理器或 CI secret。
2. 不把 `.env` 提交到 Git；仓库只保留 `.env.example`。
3. MCP 返回的配置视图只显示 `gatewayConfigured` 和 `credentialConfigured`，不返回值。
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

未设置时回退到 `CLAUDE_DEFAULT_*`。

## 排障顺序

1. 运行 `npm run doctor`。
2. 运行 `npm run list-agents`，确认模型、effort 和权限的非秘密视图。
3. 使用 `run_agent(..., dryRun=true)`，检查最终 CLI 参数、`--agents`/`--agent` 原生智能体加载和 XML 委派提示词预览。
4. 确认 `claude --version` 与本地登录状态。
5. 检查 Codex 中插件 MCP server 是否启用，以及 `run_agent` 的工具审批策略。
6. 实际调用失败时，读取 `stderr`；不要输出或复制完整环境。

正常 `run_agent` 使用前台模式并只接收紧凑摘要；不要通过 `job_status` 轮询续约。只有用户明确要求后台执行时才启用 `background=true`，后台租约由 MCP 服务心跳维护。

排障输出只保留命令、退出码、首个关键错误和日志路径；完整事件流仅在明确诊断时通过 `job_result(full=true)` 读取。

## 新增智能体

1. 在 `agents/agents.json` 新增唯一 id、别名、环境变量前缀、XML 文件和默认权限。
2. 在 `agents/<id>.xml` 定义身份、知识、方法论、质量门禁、执行协议和报告结构。
3. 在 `.env.example` 增加该前缀的非秘密模板。
4. 更新 `claude-orchestrator/SKILL.md` 的称呼映射。
5. 运行测试和 dry-run。

XML 提示词应描述可观察的工作方法与质量门禁，不应要求模型输出私有思维过程。
