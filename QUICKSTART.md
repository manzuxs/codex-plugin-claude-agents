# 从 Codex 计划到 Claude Code 落地

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

正常委派使用前台模式。MCP 请求会保持挂起，Agent 完成后返回一次紧凑结果；Codex 随后自行检查实际 diff、测试和未完成项，不轮询 `job_status`。

前台任务收到 `notifications/cancelled` 时会终止 Claude 进程组，完整结果保存在本地 Job 文件中，默认不会返回 `structured`、raw stdout 或完整 stderr。

只有用户明确要求后台执行时才使用：

长任务可让 Codex调用：

```text
按上面的计划启用后端工程师智能体后台执行。
```

插件返回 job ID 后，用户可按需使用 `job_status`、`job_result` 和 `job_cancel`。后台租约由 MCP 服务心跳维护，`job_status` 仅用于主动查看；MCP 断开时非持久任务会被取消，Worker 保留租约过期兜底。

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
