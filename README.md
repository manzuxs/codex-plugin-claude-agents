# Codex → Claude Code Agents v0.2.0

一个本地 Codex 插件：**Codex 负责探索、规划和最终验收；本机 Claude Code CLI 通过指定专业智能体执行已经批准的计划。**

## 工作方式一览

![Codex 与 Claude Code Agents 协作流程](./diagram/claude-code-agents-workflow.svg)

Codex 保留规划、范围控制和最终验收责任；插件只把已批准计划交给一个专业智能体执行，并默认以精简结果、测试证据和 `planSha256` 回传供 Codex 审查。

## 现在支持的主流程

1. 你先让 Codex 阅读仓库并输出实施计划，但不修改代码。
2. 你确认后说：`按上面的计划，启用后端工程师智能体落地。`
3. Codex 复用当前对话中已经批准的计划，不重复规划。
4. Codex 调用插件 MCP `run_agent`，传入完整 `task`、`plan`、验收标准和项目目录。
5. 插件通过 Claude Code 原生 `--agents` 与 `--agent` 参数加载对应专家提示词，并在当前仓库执行。
6. Claude 返回实现报告和会话 ID；Codex继续检查实际 diff、测试证据和残余风险。

参见 [QUICKSTART.md](./QUICKSTART.md)。

## v0.2 兼容性修正

本版本已根据真实 `claude --help` 调整：

- 使用 `--agents <json>` 定义原生自定义智能体。
- 使用 `--agent <id>` 激活架构师、后端、前端、UI 等角色。
- 使用真实支持的 effort：`low | medium | high | xhigh | max`。
- 使用真实支持的权限：`default | acceptEdits | auto | bypassPermissions | dontAsk | plan`。
- 移除不存在的 `--append-system-prompt-file`、`--max-turns`、`ultracode` 和 `manual`。
- 实施型智能体默认 `auto`；架构师与安全工程师默认 `plan`。
- 每次委派返回 `planSha256`，标识实际传入的计划版本。

## 已包含

- Codex Skill：识别“按上面的计划，启用某某智能体”。
- 本地 stdio MCP Server：`list_agents`、`run_agent`、`job_status`、`job_result`、`job_cancel`。
- 8 个内置智能体：架构师、后端、前端、UI、全栈、测试、安全、DevOps/SRE。
- 每个智能体独立 XML 专业提示词：知识域、方法论、质量门禁、执行协议和报告契约。
- 每个智能体独立模型、effort、权限、API 网关、密钥、预算和进程超时配置。
- 同步执行、后台任务、结果持久化、会话恢复、dry-run 和诊断。
- 零运行时 npm 依赖。

正常委派使用前台模式：MCP 请求保持挂起，Claude 完成后只恢复一次 Codex 回合。前台结果默认只返回状态、Job/Session 标识、计划哈希、耗时、回合数、成本、摘要、验证摘要和截断标记；完整事件流写入本地 Job 文件，不进入默认上下文。

## 目录

```text
.
├── .agents/plugins/marketplace.json
├── plugins/claude-code-agents/
│   ├── .codex-plugin/plugin.json
│   ├── .mcp.json
│   ├── .env.example
│   ├── agents/
│   │   ├── agents.json
│   │   └── *.xml
│   ├── skills/
│   ├── server/
│   └── scripts/doctor.mjs
├── QUICKSTART.md
├── VALIDATION.md
├── diagram/
│   ├── claude-code-agents-workflow.svg
│   └── claude-code-agents-workflow@2x.png
└── tests/
```

## 前置条件

- Node.js 18.18+
- 本机 `claude --version` 可执行
- Claude Code 已登录，或已配置所需 API 网关和凭据
- 支持本地插件与 stdio MCP 的 Codex 客户端

## 配置

推荐把真实配置保存在用户目录，避免插件升级覆盖：

```bash
mkdir -p ~/.config/claude-code-agents
cp plugins/claude-code-agents/.env.example ~/.config/claude-code-agents/.env
chmod 600 ~/.config/claude-code-agents/.env
```

示例：

```dotenv
CLAUDE_DEFAULT_MODEL=sonnet
CLAUDE_DEFAULT_EFFORT=high
CLAUDE_DEFAULT_PERMISSION_MODE=auto
CLAUDE_DEFAULT_TIMEOUT_MS=1800000
CLAUDE_DEFAULT_OUTPUT_FORMAT=json

# 每个角色都可以按用户偏好覆盖模型和运行参数：
# BACKEND_ENGINEER_MODEL=<your-model>
# BACKEND_ENGINEER_EFFORT=high
# BACKEND_ENGINEER_PERMISSION_MODE=auto
# BACKEND_ENGINEER_GATEWAY_URL=https://your-api-gateway.example.com/v1
# BACKEND_ENGINEER_API_KEY=replace-me
# BACKEND_ENGINEER_API_KEY_KIND=auth_token
```

`auth_token` 会注入 `ANTHROPIC_AUTH_TOKEN`；`api_key` 会注入 `ANTHROPIC_API_KEY`。网关地址注入 `ANTHROPIC_BASE_URL`。密钥不会进入 CLI 参数、XML 委派文本、MCP 返回值或后台任务请求文件。

从远程 Marketplace 安装且没有本地仓库副本时，可以直接创建 `~/.config/claude-code-agents/.env`，并参考仓库中的 `plugins/claude-code-agents/.env.example` 填写。

项目级覆盖文件：

```text
<project>/.claude-agents.env
```

优先级从低到高：插件 `.env` → 用户 `.env` → 项目 `.claude-agents.env` → 启动 Codex 的进程环境 → 单次非秘密覆盖。

## 从远程仓库安装

仓库发布到 GitHub 后，用户可以直接添加远程 Marketplace：

```bash
codex plugin marketplace add manzuxs/codex-plugin-claude-agents
codex plugin add claude-code-agents@local-claude-code-agents
```

也可以使用完整 Git URL：

```bash
codex plugin marketplace add https://github.com/manzuxs/codex-plugin-claude-agents.git
codex plugin add claude-code-agents@local-claude-code-agents
```

安装后新建 Codex 任务，使技能和 MCP 工具完成加载。首次执行前请确认 `claude --version` 可用，并完成 Claude 登录或网关配置。

更新远程 Marketplace 后重新安装插件：

```bash
codex plugin marketplace upgrade local-claude-code-agents
codex plugin add claude-code-agents@local-claude-code-agents
```

## 从本地仓库安装

解压后，在包根目录执行：

```bash
npm test
npm run doctor
codex plugin marketplace add "$(pwd)"
codex plugin add claude-code-agents@local-claude-code-agents
```

然后在支持插件的 Codex/ChatGPT 桌面客户端中确认 **Claude Code Agents** 已启用，并重新开启任务。

插件目录结构符合：

- `.codex-plugin/plugin.json`
- `skills/`
- `.mcp.json`
- `.agents/plugins/marketplace.json`

## 常用提示词

先规划：

```text
阅读当前仓库，为这个需求输出可执行计划。先不要修改代码。
计划必须包含真实文件范围、接口或数据契约、实施步骤、风险、验证命令和验收标准。
```

计划确认后：

```text
按上面的计划直接落地，不要重新规划。启用后端工程师智能体执行。
完成后由 Codex 检查实际 diff、测试结果和未完成事项。
```

跨前后端：

```text
按上面的计划，启用全栈工程师智能体完成纵向切片。
```

设计与前端实现：

```text
按上面的计划，启用 UI 设计师智能体落地。不得删除现有业务内容，必须覆盖加载、空、错误、禁用和响应式状态。
```

只做架构评审：

```text
启用架构师智能体评审上面的计划，只输出架构风险和 ADR，不修改代码。
```

## MCP `run_agent`

必需字段：

- `agent`
- `task`
- `plan`

常用可选字段：

- `acceptanceCriteria`
- `context`
- `cwd`
- `background`
- `persistOnDisconnect`
- `leaseTimeoutMs`
- `dryRun`
- `resume`
- `sessionId`
- `model`
- `effort`
- `permissionMode`
- `timeoutMs`
- `maxBudgetUsd`
- `allowedTools`
- `disallowedTools`

`resume` 和 `sessionId` 不能同时传入。

## 后台执行

只有用户明确要求“后台执行”时才使用 `run_agent(background=true)`。它返回 job ID，仍可按需使用：

- `job_status`
- `job_result`
- `job_cancel`

后台租约由 MCP 服务内部心跳维护，`job_status` 只用于用户主动查看，不承担续约职责，也不会触发自动轮询。MCP 断开时非持久任务由服务取消；服务异常退出时由 Worker 租约兜底终止。`job_cancel` 可立即终止。只有用户明确要求任务脱离 Codex 继续运行时，才传入 `persistOnDisconnect=true`。

前台任务收到 MCP `notifications/cancelled` 时会立即终止 Claude 进程组。后台任务可通过 `leaseTimeoutMs` 调整租约，公开 MCP 接口允许 `30000` 到 `600000` 毫秒。

阶段完成后，Codex 必须审查实际 diff 和测试，再输出可见、可编辑、可直接粘贴到新任务的“下一阶段执行计划”。插件不保存交接包、不创建隐藏恢复状态，也不自动切换或唤醒 Codex 任务。

任务数据默认写入 Codex 提供的 `PLUGIN_DATA`；直接运行时回退到 `~/.codex/claude-code-agents`。

## 独立 CLI 调试

```bash
node plugins/claude-code-agents/server/cli.mjs list

node plugins/claude-code-agents/server/cli.mjs run \
  --agent backend-engineer \
  --task "实现用户查询接口" \
  --plan @/tmp/codex-plan.md \
  --cwd /path/to/project \
  --dry-run
```

去掉 `--dry-run` 才会实际启动本机 Claude Code。

## 安全与边界

- Codex 保持规划与验收责任。
- Claude 专家必须按计划执行；只有仓库证据要求时才能局部调整，并必须报告差异。
- 子进程使用参数数组和 `shell: false`。
- 不默认启用 `bypassPermissions`。
- 实施型智能体默认 `auto`，仍受 Claude Code 权限系统控制。
- 插件不会自动替用户批准 Codex 的 MCP 写操作。
- 后台任务默认与 Codex 会话绑定；持久执行必须由用户明确启用。
- `planSha256` 用于审计本次委派计划，不代表实现已经通过验收。

## 验证

```bash
npm test
npm run dry-run
npm run doctor
```

当前自动化测试为 20/20。详细范围见 [VALIDATION.md](./VALIDATION.md)。真实模型、账户和网关必须在目标机器上完成小任务实测。
