# 阶段续接与 Token 优化实施计划

> 日期：2026-07-15  
> 状态：待下一任务实施  
> 仓库：`/Users/macxm/service/Claude/codex-plugin-claude-agents`  
> 设计原则：交接内容直接展示给用户，由用户审阅、修改并粘贴到新任务；插件不持久化交接状态。

## 新任务启动提示

```text
请按 docs/plans/2026-07-15-stage-handoff-token-optimization.md 实施插件优化。
先检查当前 main、未提交改动和已安装插件版本，再按计划顺序执行。
不要增加交接包存储、save_handoff/load_handoff 工具或自动恢复机制。
完成代码、测试、cachebuster、重装、实际 MCP 验证、提交并推送。
```

## 1. 背景与基线

当前长任务实测：

- Codex 主模型累计约 3457 万输入 token。
- 41 次用户消息触发约 371 次主模型调用。
- 16 次纯等待累计约 207 万输入 token，只产生约 796 个输出 token。
- Codex 收到约 397 次工具结果，合计约 173 万字符。
- Agent 侧累计约 7812 万输入 token，主要由工具结果在 40 至 148 个回合中反复进入上下文造成。
- 当前 `run_agent(background=false)` 会把完整 `structured` 执行记录返回给 Codex。
- 当前后台租约依赖 `job_status` 续约，容易诱导 Codex 主动轮询。
- 当前插件 MCP 没有声明足以覆盖 30 分钟 Agent 任务的 `tool_timeout_sec`。

## 2. 目标

1. `run_agent` 默认使用前台阻塞调用，Agent 完成后只恢复一次 Codex 模型回合。
2. 前台结果只返回紧凑执行摘要，不把完整事件流带入 Codex 上下文。
3. 阶段结束时，Codex 在最终回复中直接输出下一阶段执行计划。
4. 下一阶段计划必须清晰、可编辑、可直接粘贴到新任务。
5. 后台模式只在用户明确要求时使用，不自动轮询状态。
6. 完整日志和事件流只保留在本地 Job 文件，默认工具结果限制在 4 至 8 KB。
7. 保持用户停止任务时的取消传播和完整进程组回收能力。

## 3. 非目标

- 不新增交接包数据库、索引或 Markdown 存储目录。
- 不新增 `save_handoff`、`load_handoff`、`list_handoffs` MCP 工具。
- 不自动创建、切换或唤醒 Codex 任务。
- 不使用 Hook 生成、保存或恢复下一阶段计划。
- 不让 Claude 执行智能体替代 Codex 做最终验收。
- 不自动修改用户全局 `~/.codex/config.toml`。
- 不删除现有 Job 数据或改变已有 `.env` 模型选择。

## 4. 目标工作流

```text
用户确认当前阶段计划
  -> Codex 调用 run_agent(background=false)
  -> MCP 请求保持挂起，期间不产生轮询回合
  -> Claude 完成，插件保存完整原始结果
  -> 插件只向 Codex 返回紧凑摘要
  -> Codex 独立检查实际 diff、测试和未完成项
  -> Codex 在最终回复中输出“下一阶段执行计划”
  -> 用户阅读并按需要修改
  -> 用户新建任务并粘贴该计划
```

前台 MCP 请求本身就是完成通知。Agent 结束后工具结果返回，Codex 自然恢复，不需要 Hook 或后台通知。

## 5. 控制台续接格式

阶段完成后，Codex 最终回复必须包含以下可见区块：

```markdown
## 本阶段结果

- 项目目录：`/absolute/project/path`
- 当前提交：`<git sha 或未提交>`
- 执行智能体：`fullstack-engineer`
- Agent Session：`<session id>`

### 已完成

- 可观察的完成项
- 涉及的关键文件

### 验证证据

- `npm test`：通过，21 tests passed
- `git diff --check`：通过

### 未完成与风险

- 明确列出尚未完成、失败或需要用户决定的事项

## 下一阶段执行计划

### 目标

下一阶段唯一目标。

### 范围

- 必须完成的范围

### 非目标

- 不得顺手扩展的范围

### 实施步骤

1. 有顺序的步骤
2. 每一步引用真实模块或文件
3. 包含必要验证

### 验收标准

- 可观察、可执行的验收条件

### 建议智能体

`fullstack-engineer`

### 新任务提示

请在 `/absolute/project/path` 按以下已确认计划继续实施：……
先检查当前 git HEAD 和未提交改动，不覆盖既有工作。
已完成：……
下一阶段目标：……
实施步骤：……
验收标准：……
```

约束：

- 整个续接区块目标不超过 8 KB。
- 不粘贴完整 diff、测试日志、Agent transcript 或工具调用记录。
- 只包含下一任务做决策所需的事实。
- 用户可以直接编辑“新任务提示”，插件不把它当成隐藏状态。
- 下一任务只以用户最终粘贴的内容为准。

## 6. 责任边界

- Claude 智能体提供实施摘要、变更范围、测试证据和未完成项建议。
- Codex 必须检查实际 diff 和测试后，才编写本阶段结果和下一阶段计划。
- 插件负责提供紧凑、可审查的 Agent 结果，并通过编排技能约束最终输出格式。
- 用户负责决定是否新建任务、是否修改计划以及何时继续。
- 新任务不得假设存在隐藏交接数据，也不得读取旧 transcript 才能开始。

## 7. `run_agent` 调整

- `background` 默认继续为 `false`。
- 前台执行也创建 Job 记录，完整结果只落盘。
- 前台 MCP 返回统一调用 `compactResult()`。
- 默认文本上限从 12,000 字符降至 8,000 字符。
- 返回字段限定为：状态、agent、jobId、sessionId、planSha256、耗时、回合数、成本、摘要、验证摘要、截断标记。
- 禁止默认返回 `structured`、raw stdout、完整 stderr、完整 diff 或事件数组。
- `full=true` 只允许通过显式诊断路径读取，不作为编排技能正常流程。

## 8. 后台模式调整

- 保留 `job_status`、`job_result`、`job_cancel`。
- `claude-orchestrator` 不得默认设置 `background=true`。
- 只有用户明确说“后台执行”时才使用后台模式。
- MCP 服务内部为自己拥有的 Job 续约，不要求 Codex 调用 `job_status` 续约。
- MCP 连接关闭后，非持久 Job 仍由 `dispose()` 取消。
- Worker 保留租约兜底，租约由 MCP 服务心跳维持，不由模型轮询驱动。
- 用户未主动查询时，Codex 不得自动“继续等”“再看一次状态”。

## 9. MCP 超时与取消

修改 `.mcp.json`：

```json
{
  "mcpServers": {
    "claude_code_agents": {
      "command": "node",
      "args": ["./server/index.mjs"],
      "cwd": ".",
      "tool_timeout_sec": 2100
    }
  }
}
```

- 2100 秒覆盖当前默认 1800 秒 Agent 超时和清理余量。
- 用户停止 Codex 时，继续通过 `notifications/cancelled` 触发 AbortSignal。
- AbortSignal 必须终止 Claude 进程组及其 Vitest 等后代进程。
- 超时、取消和 MCP 断开都必须写入 Job 终态。

## 10. 编排技能调整

修改 `plugins/claude-code-agents/skills/claude-orchestrator/SKILL.md`：

1. 正常委派强制使用 `background=false`，不得主动轮询。
2. 只有用户明确说“后台执行”才使用后台模式。
3. Agent 返回后，Codex 必须独立检查 diff 和测试。
4. 阶段完成时必须按第 5 节格式输出本阶段结果和下一阶段计划。
5. 用户要求“本阶段结束后新开任务”时，必须提供可直接粘贴的新任务提示。
6. 下一阶段计划由 Codex 根据实际验证结果生成，不直接照抄 Agent 自报结论。
7. 默认精简读取结果，只有失败诊断才允许查看完整 Job 结果。
8. 最终回复不包含完整工具日志或旧会话历史。

## 11. Agent 输出治理

修改所有 `agents/*.xml` 的执行规范：

- 可能产生大量输出的命令必须截断到 4 至 8 KB。
- 优先返回命令、退出码、失败摘要和关键行，不粘贴完整日志。
- 不重复读取已经确认且未变化的同一文件或图片。
- 大文件先使用 `rg`、符号检索或局部行范围定位。
- 测试成功时只报告汇总，失败时只保留首个关键错误和日志路径。
- 最终报告固定包含：实施摘要、文件清单、验证证据、未完成项、建议下一阶段。
- 最终报告不包含私有思维过程和完整工具记录。

公共规则优先抽成共享构建片段或验证规则，避免八份 XML 漂移；若新增生成器会显著增加复杂度，则保持小范围重复并增加一致性测试。

## 12. Hook 策略

本方案不增加 Hook：

- 前台 MCP 返回就是任务完成通知。
- Hook 不能由外部 Job 主动触发来唤醒空闲任务。
- 异步 Hook 当前不受支持。
- 控制台续接计划必须由用户看见并主动带入新任务，避免黑盒自动恢复。

## 13. Codex 压缩配置建议

插件不得自动修改全局配置。Doctor 只做非阻断提示：

- 若 `model_auto_compact_token_limit` 明显高于实际模型上下文，建议手动设置为 100,000 至 120,000。
- 不输出完整 `config.toml`。
- README 说明较低阈值会更早压缩细节，因此阶段结束时应输出续接计划。

## 14. 预计修改文件

- `plugins/claude-code-agents/.mcp.json`
- `plugins/claude-code-agents/server/lib/service.mjs`
- `plugins/claude-code-agents/server/lib/mcp.mjs`
- `plugins/claude-code-agents/server/lib/job-store.mjs`
- `plugins/claude-code-agents/server/worker.mjs`
- `plugins/claude-code-agents/skills/claude-orchestrator/SKILL.md`
- `plugins/claude-code-agents/skills/claude-agent-admin/SKILL.md`
- `plugins/claude-code-agents/agents/*.xml`
- `plugins/claude-code-agents/scripts/doctor.mjs`
- `tests/mcp.test.mjs`
- `tests/execution.test.mjs`
- `tests/background.test.mjs`
- `README.md`
- `QUICKSTART.md`
- `VALIDATION.md`

明确不新增：

- `handoff-store.mjs`
- `handoff.test.mjs`
- `save_handoff`、`load_handoff`、`list_handoffs`
- 插件 Hook

## 15. 实施顺序

### 阶段 A：前台结果安全化

1. 让前台执行也创建并更新 Job 记录。
2. 将完整 `runClaude()` 结果写入 JobStore。
3. 前台 MCP 只返回 `compactResult()`。
4. 将默认返回文本限制到 8 KB。
5. 增加 `tool_timeout_sec: 2100`。
6. 验证取消传播和进程组回收。

阶段 A 完成前，不得把编排技能切换为默认前台模式。

### 阶段 B：前台默认与无轮询后台

1. 修改编排技能，正常任务使用前台模式。
2. 增加 MCP 服务内部 Job 心跳。
3. 移除“通过 `job_status` 续约”的协议要求。
4. 保留用户主动查询和取消能力。

### 阶段 C：控制台续接计划

1. 在编排技能中加入固定续接模板。
2. 要求 Codex 审查后输出下一阶段计划。
3. 新任务提示必须包含 cwd、当前基线、下一阶段步骤和验收标准。
4. 增加静态测试，防止技能退回自动交接或隐藏状态设计。

### 阶段 D：输出治理与文档

1. 更新所有 Agent XML 的输出上限和报告格式。
2. 增加 Doctor 压缩阈值提示。
3. 更新 README、QUICKSTART、VALIDATION。
4. 记录 Token 优化前后测量方法。

### 阶段 E：安装与发布

1. 运行完整测试和插件验证。
2. 使用 `update_plugin_cachebuster.py` 更新版本后缀。
3. 执行 `codex plugin add claude-code-agents@local-claude-code-agents`。
4. 从安装缓存按真实 `.mcp.json` 启动并检查 `tools/list`。
5. 新建测试任务，验证前台完成后只恢复一次 Codex。
6. 检查停止任务后无 Claude、Node、Vitest 孤儿进程。
7. 提交并推送 `origin/main`。

## 16. 测试要求

### 单元测试

- `compactResult()` 不包含 `structured`、raw stdout 或完整 stderr。
- 前台结果 JSON 默认不超过 8 KB，超出时设置 `truncated=true`。
- 前台执行成功、失败、超时和取消都写入 Job 终态。
- 后台服务心跳能续约 Job，MCP 断开后停止续约并触发清理。
- Agent XML 都包含命令输出限制和固定最终报告字段。
- 编排技能包含“下一阶段执行计划”和“新任务提示”要求。
- 编排技能不要求正常任务调用 `job_status`。

### MCP 协议测试

- 前台 `run_agent` 请求保持挂起，完成后返回一次紧凑结果。
- `notifications/cancelled` 能终止前台 Agent 进程组。
- `.mcp.json` 按安装目录真实启动，`tool_timeout_sec` 为 2100。
- 正常前台流程不依赖 `job_status`。
- `tools/list` 不新增任何 handoff 存储工具。

### 集成验收

1. 在临时项目执行一个 2 至 3 分钟的 Agent 任务。
2. Codex 只产生“调用 Agent”和“Agent 返回后审查”两个关键模型阶段，不进行轮询。
3. 最终回复按固定模板输出本阶段结果和下一阶段执行计划。
4. 用户把“新任务提示”粘贴到新任务后，可以直接继续，无需读取旧 transcript。
5. 用户停止前台任务后，5 秒内无 Claude/Vitest 后代进程残留。

## 17. Token 验收指标

- Codex 等待/状态轮询模型回合：从当前 16 次以上降至 0。
- 单次 Agent 返回给 Codex 的工具结果：默认不超过 8 KB。
- 控制台续接计划：不超过 8 KB。
- 单阶段 Codex P90 输入：目标低于 120,000 token。
- 新任务不读取旧 transcript 或完整 Job result。
- Agent 命令输出默认不超过 8 KB，完整日志只写文件。
- 统计同时报告总输入、未缓存输入、模型回合和工具结果字符数。

## 18. 完成定义

- 所有新增和现有测试通过。
- 插件 Doctor 通过。
- 安装缓存实测暴露现有 MCP 工具，不新增隐藏交接工具。
- 前台委派无需轮询即可完成并恢复 Codex。
- 前台返回不包含完整执行记录。
- 阶段结束直接输出可见、可编辑、可粘贴的下一阶段计划。
- 停止任务不会遗留 Claude、Node 或 Vitest 进程。
- README 和 QUICKSTART 能说明前台、后台与手动续接流程。
- 代码已提交并推送到远程 `main`。
