# 从 Codex 计划到 Multi-CLI Agents 落地

## 1. 先让 Codex 输出计划

在目标项目目录中启动 Codex，然后输入：

```text
阅读当前仓库并为“用户管理 API 改造”输出可执行计划。先不要修改代码。
计划必须包含目标、文件范围、接口契约、实施步骤、风险、测试命令和验收标准。
```

## 2. 确认后调用智能体

Codex 输出计划后，输入：

```text
按上面的计划直接落地，不要重新规划。启用后端工程师智能体执行。
完成后由 Codex 检查实际 diff、测试结果和未完成事项。
```

也可以换成：

```text
按上面的计划，启用前端工程师智能体落地。
```

```text
按上面的计划，启用 UI 设计师智能体落地，不允许删除现有业务内容。
```

```text
按上面的计划，启用全栈工程师智能体完成纵向切片。
```

## 3. 实际发生的调用

Codex 会从当前会话取出已批准计划，并调用 MCP：

```json
{
  "agent": "backend-engineer",
  "task": "实现用户管理 API 改造",
  "plan": "<Codex 刚才输出并获批准的完整计划>",
  "acceptanceCriteria": "<计划中的验收标准>",
  "cwd": "<当前项目根目录>"
}
```

插件再启动本机 Claude Code：

```text
claude -p
  --model <智能体配置的模型>
  --effort <智能体配置的强度>
  --permission-mode <智能体配置的权限>
  --agents <原生自定义智能体 JSON>
  --agent backend-engineer
  <包含 Codex 计划的 XML 委派提示词>
```

每次结果都会包含 `planSha256`。它用于标识本次实际传给插件的计划版本。

## 4. 默认前台与后台任务

顺序委派默认使用前台模式：`run_agent(background=false)` 由 MCP 服务端等待 Agent 完成，Codex 只恢复一次并接收紧凑结果。需要并行或先返回 Job ID 时使用 `run_agent(background=true)`，随后只调用一次 `job_wait`；状态接口只返回紧凑进度，不返回原始日志或工具输入。

需要用户实时查看进度时，才使用 `job_status`；它是只读查询，不负责续租。

前台任务收到 `notifications/cancelled` 时会终止 Claude 进程组，完整结果保存在本地 Job 文件中，默认不会返回 `structured`、raw stdout 或完整 stderr。

需要默认进度跟踪时使用：

长任务可让 Codex调用：

```text
按上面的计划启用后端工程师智能体后台执行。
```

插件返回 job ID 后，Codex 调用一次 `job_wait`，由 MCP 服务端在模型回合之外等待终态并返回结果；后台 Worker 根据活动自行续租，用户仍可使用 `job_cancel`。MCP 断开时服务会立即取消其拥有的非持久任务。

只有明确需要任务脱离 Codex 继续运行时，才要求使用 `persistOnDisconnect=true`。普通任务不要启用持久模式。

## 5. 阶段续接

阶段结束时，Codex 会在最终回复输出“本阶段结果”和“下一阶段执行计划”。用户可以直接编辑其中的“新任务提示”，然后新建任务粘贴执行；插件不会保存交接包或自动恢复旧任务。

## 6. 第一次实测建议

先用一个小任务验证：

```text
输出一个只修改 README 的两步计划。
```

计划确认后：

```text
按上面的计划，启用后端工程师智能体落地。只允许修改 README，并运行 git diff --check。
```

这样可以快速验证插件安装、MCP审批、Claude登录、模型配置、权限模式和当前工作目录是否正确。

## 7. 真实浏览器测试

当验收标准要求浏览器冒烟或 E2E 时，启用测试工程师并选择模式：

```json
{
  "agent": "qa-engineer",
  "task": "运行关键用户路径的真实浏览器冒烟测试",
  "plan": "<已批准计划>",
  "acceptanceCriteria": "真实浏览器完成登录、核心操作与结果断言，并保存证据",
  "browserMode": "repository",
  "cwd": "<项目根目录>"
}
```

UI 视觉验收可把 `agent` 改为 `ui-designer`，优先使用 `mcp`/`chrome` 获取真实页面与截图；前端实现自测可使用 `frontend-engineer`，优先运行仓库 `repository` Playwright/Cypress。三者分别执行视觉验收、实现自测和独立 E2E 门禁。

`chrome` 复用 Claude in Chrome（API 网关环境请改用 MCP）；`mcp` 使用对应角色 `.env` 中预配置的 profile，只有一个时可省略 `browserMcpProfile`。浏览器模式沿用用户配置的权限；如需避免非交互审批阻塞，可把对应角色的 `<PREFIX>_PERMISSION_MODE` 配置为 `bypassPermissions`。缺少依赖或工具注入失败时任务返回 `blocked` 和对应安装提示，不会自动安装，也不会静默切换成 Codex 自身浏览器。

## 8. 显式选择 Runner

旧调用无需修改，默认 Runner 是 Claude：

```json
{"agent":"backend-engineer","task":"...","plan":"<approved plan>"}
```

需要使用其他 CLI 时显式传入：

```json
{"agent":"backend-engineer","runner":"codex","task":"...","plan":"<approved plan>"}
```

可选 Runner 为 `claude`、`codex`、`grok` 和 `agy`。角色职责在 Claude 中使用原生 `--agents`，在其他 CLI 中以受控 role prompt 注入。Codex 使用 `codex exec --json`，Grok 使用 headless single-turn JSON/JSONL 输出，Antigravity 使用 `agy --print` 文本输出；浏览器、effort、resume 和权限能力不一致时，adapter 会明确拒绝不支持的请求。
