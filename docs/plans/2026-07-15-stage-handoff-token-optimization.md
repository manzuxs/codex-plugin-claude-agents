# 阶段交接与 Token 优化实施计划

> 日期：2026-07-15  
> 状态：待下一任务实施  
> 仓库：`/Users/macxm/service/Claude/codex-plugin-claude-agents`  
> 目标版本：沿用 `0.2.0`，通过 Codex cachebuster 生成新的安装版本

## 新任务启动提示

在新任务中直接发送：

```text
请按 docs/plans/2026-07-15-stage-handoff-token-optimization.md 实施插件优化。
先检查当前 main、未提交改动和已安装插件版本，再按计划顺序执行。
不要重新设计范围；完成代码、测试、cachebuster、重装、实际 MCP 验证、提交并推送。
```

## 1. 背景与基线

当前长任务的实测数据：

- Codex 主模型累计约 3457 万输入 token，其中大部分为缓存输入。
- 41 次用户消息触发约 371 次主模型调用。
- 16 次纯等待累计约 207 万输入 token，只产生约 796 个输出 token。
- Codex 收到约 397 次工具结果，合计约 173 万字符。
- Agent 侧累计约 7812 万输入 token，主要由工具结果在 40 至 148 个回合中反复进入上下文造成。
- 当前 `run_agent(background=false)` 会把完整 `structured` 执行记录返回给 Codex。
- 当前后台租约依赖 `job_status` 续约，诱导 Codex 主动轮询。
- 当前插件 MCP 没有声明足以覆盖 30 分钟 Agent 任务的 `tool_timeout_sec`。
- Codex Hook 只能响应已有生命周期事件，异步 Hook 尚不受支持，不能作为外部 Job 完成后主动唤醒 Codex 的主通道。

## 2. 目标

1. `run_agent` 默认使用前台阻塞调用，Agent 完成后仅恢复一次 Codex 模型回合。
2. 前台结果只返回紧凑执行摘要，不把完整事件流带入 Codex 上下文。
3. 每个阶段完成后生成可持久化的交接包，包含下一阶段执行计划和新任务启动提示。
4. 新任务能按当前工作目录读取最近交接包，无需依赖旧任务上下文。
5. 后台模式只在用户明确要求时使用，运行期间不要求 Codex 自动轮询。
6. 完整日志、事件流和诊断数据保留在本地文件，默认 MCP 返回严格限制在 8 KB 左右。
7. 保持用户停止任务时的取消传播和完整进程组回收能力。

## 3. 非目标

- 不让插件自动创建或切换 Codex 任务。
- 不让 Claude 执行智能体替代 Codex 做最终验收。
- 不把完整 diff、测试日志或原始事件流写入交接包。
- 不自动修改用户全局 `~/.codex/config.toml` 的模型或压缩配置。
- 不使用 Hook 轮询后台 Job，也不依赖异步 Hook。
- 不删除现有 Job 数据或改变已有 `.env` 模型选择。

## 4. 目标工作流

```text
用户确认阶段计划
  -> Codex 调用 run_agent(background=false)
  -> MCP 请求保持挂起，期间不产生轮询回合
  -> Claude 完成，插件保存完整原始结果
  -> 插件只向 Codex 返回紧凑摘要
  -> Codex 独立检查 diff、测试和未完成项
  -> Codex 调用 save_handoff 保存阶段交接包
  -> 最终回复展示 handoff id 和“新任务启动提示”
  -> 用户新建任务并说“继续上一阶段”
  -> Codex 调用 load_handoff(cwd)
  -> 复用 nextStage.plan，不重新规划已确认范围
```

前台 MCP 请求本身就是完成通知。Agent 结束后工具结果返回，Codex 会自然恢复，无需 Hook 唤醒。

## 5. 交接包契约

### 5.1 结构化数据

```json
{
  "handoffId": "handoff-20260715-103000-ab12cd34",
  "cwd": "/absolute/project/path",
  "createdAt": "2026-07-15T02:30:00.000Z",
  "stage": {
    "id": "stage-1",
    "title": "阶段名称",
    "status": "completed"
  },
  "source": {
    "jobId": "claude-...",
    "agent": "fullstack-engineer",
    "sessionId": "...",
    "planSha256": "..."
  },
  "completed": [
    {
      "summary": "已完成的可观察结果",
      "files": ["relative/path"]
    }
  ],
  "verification": [
    {
      "command": "npm test",
      "status": "passed",
      "summary": "21 tests passed"
    }
  ],
  "decisions": ["已经确认且下一阶段不得重复讨论的决定"],
  "remaining": ["尚未完成或需要用户确认的事项"],
  "risks": ["残余风险或环境限制"],
  "git": {
    "head": "commit sha or null",
    "dirty": false,
    "changedFiles": []
  },
  "nextStage": {
    "title": "下一阶段名称",
    "objective": "下一阶段唯一目标",
    "scope": ["必须完成的范围"],
    "nonGoals": ["不得扩展的范围"],
    "steps": ["有顺序的实施步骤"],
    "acceptanceCriteria": ["可验证的验收标准"],
    "recommendedAgent": "fullstack-engineer"
  },
  "newTaskPrompt": "可直接发送到新任务的精简提示"
}
```

### 5.2 责任边界

- Claude 智能体提供实施摘要、变更范围和测试证据。
- Codex 必须检查实际 diff 和测试后，才生成 `completed`、`verification`、`remaining` 与 `nextStage`。
- 插件只负责校验、持久化、渲染和读取，不自行推理下一阶段计划。
- `newTaskPrompt` 必须引用 `handoffId` 和 `cwd`，不得复制完整历史。

### 5.3 存储位置

默认保存到插件数据目录，不污染目标仓库：

```text
~/.codex/claude-code-agents/handoffs/<cwd-sha256>/
  index.json
  <handoff-id>.json
  <handoff-id>.md
```

规则：

- `<cwd-sha256>` 使用规范化绝对路径计算。
- `index.json` 只保存最近记录的紧凑索引和 `latestHandoffId`。
- JSON 是机器读取的事实来源，Markdown 用于用户审阅。
- 写入使用临时文件加原子 rename。
- 不保存密钥、完整环境变量、完整 stdout/stderr 或原始 Agent 事件流。

## 6. MCP 接口调整

### 6.1 `run_agent`

- `background` 默认继续为 `false`。
- 前台执行也创建 Job 记录，以便完整原始结果只落盘、不进入 Codex 上下文。
- 前台返回统一调用 `compactResult()`。
- 默认文本上限从 12,000 字符降至 8,000 字符。
- 返回字段限定为：状态、agent、jobId、sessionId、planSha256、耗时、回合数、成本、摘要、验证摘要、截断标记。
- 禁止默认返回 `structured`、raw stdout、完整 stderr、完整 diff 或事件数组。

### 6.2 `save_handoff`

新增写工具，参数为第 5 节交接包字段：

- 必填：`cwd`、`stage`、`completed`、`verification`、`nextStage`。
- 可选：`source`、`decisions`、`remaining`、`risks`、`git`。
- 插件生成 `handoffId`、`createdAt`、Markdown 和默认 `newTaskPrompt`。
- 返回不超过 4 KB：`handoffId`、文件路径、下一阶段标题和新任务提示。

### 6.3 `load_handoff`

新增只读工具：

- 参数：`cwd`，可选 `handoff_id`，可选 `full=false`。
- 默认读取当前目录最近交接包。
- 默认返回不超过 8 KB 的紧凑结构。
- `full=true` 仍不得返回原始 Agent 事件流或秘密配置。

### 6.4 `list_handoffs`

新增只读工具：

- 参数：`cwd`、`limit`，默认 5，最大 20。
- 只返回阶段标题、状态、时间、handoffId 和 nextStage 标题。

### 6.5 后台工具

- 保留 `job_status`、`job_result`、`job_cancel` 作为显式后台模式能力。
- `claude-orchestrator` 不得默认设置 `background=true`。
- 用户明确要求后台执行时，MCP 服务内部续约所属 Job，不要求 Codex 调用 `job_status` 续约。
- MCP 连接关闭后，非持久 Job 仍由 `dispose()` 取消。
- Worker 保留租约兜底，但租约由 MCP 服务定时心跳，不由模型轮询驱动。

## 7. MCP 超时与取消

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

## 8. 编排技能调整

修改 `plugins/claude-code-agents/skills/claude-orchestrator/SKILL.md`：

1. 正常委派强制使用 `background=false`，不得主动轮询。
2. 只有用户明确说“后台执行”才使用后台模式。
3. 新任务中用户说“继续上一阶段”“按交接继续”时，先调用 `load_handoff(cwd)`。
4. 若交接包存在，直接复用 `nextStage`，不重新规划已经确认的决定。
5. Agent 返回后，Codex必须独立检查 diff 和测试。
6. 阶段完成时必须调用一次 `save_handoff`。
7. 最终回复必须展示：阶段结果、handoffId、下一阶段标题、新任务启动提示。
8. 不读取完整 Job 结果，除非紧凑结果明确不足以诊断失败。

## 9. Agent 输出治理

修改所有 `agents/*.xml` 的通用执行规范：

- 可能产生大量输出的命令必须截断到 4 至 8 KB。
- 优先返回命令、退出码、失败摘要和关键行，不粘贴完整日志。
- 不重复读取已经确认且未变化的同一文件或图片。
- 大文件先使用 `rg`、符号检索或局部行范围定位。
- 测试输出成功时只报告汇总，失败时只保留首个关键错误和日志路径。
- 最终报告固定包含：实施摘要、文件清单、验证证据、未完成项、建议下一阶段。
- 最终报告不包含私有思维过程和完整工具记录。

公共规则应抽成构建时共享片段或生成器，避免八份 XML 手工漂移；若仓库现有模式不适合生成，则先保持小范围重复，并为一致性增加测试。

## 10. Hook 策略

第一版不依赖 Hook 完成通知：

- 前台 MCP 工具结果返回后，Codex 自然恢复。
- Hook 不能由外部 Job 主动触发来唤醒空闲任务。
- 异步 Hook 当前不受支持。

可选第二阶段：增加插件 `Stop` Hook 作为交接遗漏保护。只有在验证 Codex 当前版本能安全阻止阶段结束且不会形成循环后再启用：

- 检测当前 session 是否有成功委派但没有对应 handoff。
- 只提示 Codex保存交接，不执行后台轮询。
- 必须有 `stop_hook_active` 或等价防递归机制。
- Hook 需要用户在 `/hooks` 中审阅并信任，因此不能作为核心流程唯一保障。

## 11. Codex 压缩配置建议

插件不得自动修改全局配置。Doctor 只做非阻断提示：

- 若 `model_auto_compact_token_limit` 高于实际模型上下文的 50%，提示建议设置为 100,000 至 120,000。
- 不输出完整 `config.toml`。
- README 提供手动配置示例，并说明低阈值会更早丢弃细节，应依赖 handoff 保留阶段事实。

## 12. 预计修改文件

- `plugins/claude-code-agents/.mcp.json`
- `plugins/claude-code-agents/server/lib/service.mjs`
- `plugins/claude-code-agents/server/lib/mcp.mjs`
- `plugins/claude-code-agents/server/lib/job-store.mjs`
- `plugins/claude-code-agents/server/lib/handoff-store.mjs`（新增）
- `plugins/claude-code-agents/server/worker.mjs`
- `plugins/claude-code-agents/skills/claude-orchestrator/SKILL.md`
- `plugins/claude-code-agents/skills/claude-agent-admin/SKILL.md`
- `plugins/claude-code-agents/agents/*.xml`
- `plugins/claude-code-agents/scripts/doctor.mjs`
- `tests/mcp.test.mjs`
- `tests/execution.test.mjs`
- `tests/background.test.mjs`
- `tests/handoff.test.mjs`（新增）
- `README.md`
- `QUICKSTART.md`
- `VALIDATION.md`

## 13. 实施顺序

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

### 阶段 C：阶段交接包

1. 实现 `HandoffStore`。
2. 实现 `save_handoff`、`load_handoff`、`list_handoffs`。
3. 生成 JSON、Markdown 和新任务提示。
4. 修改编排技能的阶段完成与新任务恢复协议。

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

## 14. 测试要求

### 单元测试

- `compactResult()` 不包含 `structured`、raw stdout 或完整 stderr。
- 前台结果 JSON 默认不超过 8 KB，超出时设置 `truncated=true`。
- 前台执行成功、失败、超时和取消都写入 Job 终态。
- HandoffStore 按规范化 cwd 隔离项目。
- HandoffStore 使用原子写入，并能恢复最近交接。
- 交接包拒绝缺失的 `nextStage` 和非法状态。
- Markdown 渲染包含固定章节且不包含秘密字段。
- `load_handoff` 默认返回不超过 8 KB。
- 后台服务心跳能续约 Job，MCP 断开后停止续约并触发清理。

### MCP 协议测试

- `tools/list` 暴露 `save_handoff`、`load_handoff`、`list_handoffs`。
- 前台 `run_agent` 请求保持挂起，完成后返回一次紧凑结果。
- `notifications/cancelled` 能终止前台 Agent 进程组。
- `.mcp.json` 按安装目录真实启动，`tool_timeout_sec` 为 2100。
- 正常前台流程不调用 `job_status`。

### 集成验收

1. 在临时项目执行一个 2 至 3 分钟的 Agent 任务。
2. Codex 只产生“调用 Agent”和“Agent 返回后审查”两个关键模型阶段，不进行轮询。
3. 阶段结束生成交接 JSON 和 Markdown。
4. 新建 Codex 任务后，`load_handoff(cwd)` 能恢复下一阶段计划。
5. 新任务无需读取旧 transcript 或完整 Job result 即可继续。
6. 用户停止前台任务后，5 秒内无 Claude/Vitest 后代进程残留。

## 15. Token 验收指标

使用相似规模任务做前后对照：

- Codex 等待/状态轮询模型回合：从当前 16 次以上降至 0。
- 单次 Agent 返回给 Codex 的工具结果：默认不超过 8 KB。
- 新任务初始交接上下文：不超过 8 KB。
- 单阶段 Codex P90 输入：目标低于 120,000 token。
- 单阶段结束必须有 handoff，下一任务不读取旧 transcript。
- Agent 命令输出默认不超过 8 KB，完整日志只写文件。
- 不以缓存命中率掩盖总输入增长，统计同时报告总输入、未缓存输入、模型回合和工具结果字符数。

## 16. 完成定义

- 所有新增和现有测试通过。
- 插件 Doctor 通过。
- 安装缓存实测暴露全部 MCP 工具。
- 前台委派无需轮询即可完成并恢复 Codex。
- 阶段交接包能跨新任务恢复。
- 前台返回不包含完整执行记录。
- 停止任务不会遗留 Claude、Node 或 Vitest 进程。
- README 和 QUICKSTART 能让其他用户理解前台、后台与交接流程。
- 代码已提交并推送到远程 `main`。
