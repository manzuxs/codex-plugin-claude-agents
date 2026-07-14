---
name: claude-orchestrator
description: 当用户说“启用某某智能体”、要求 Codex 先规划再调用 Claude Code CLI 实现、把任务交给后端工程师/架构师/前端工程师/UI设计师/全栈/测试/安全/DevOps 智能体时使用。Codex 必须先识别当前对话中已存在的具体计划；若尚无计划才先规划，然后调用 claude_code_agents MCP 工具执行。
---

# Codex → Claude Code 多智能体编排

## 核心职责

Codex 是规划者、范围控制者和最终审查者。Claude Code 智能体是受委派的专业执行者。

不要把模糊需求直接转发给 Claude Code。若当前对话已经展示并获用户确认了实施计划，直接复用该计划，不要重复规划；否则先完成必要探索并形成可执行计划。

## 触发语义

以下表达均视为启用智能体：

- “启用后端工程师智能体实现……”
- “调用架构师分析……”
- “让 UI 设计师落地这个页面……”
- “先由 Codex 规划，再交给 Claude Code……”
- “用前端/全栈/测试/安全/DevOps 智能体执行……”

智能体映射：

| 用户称呼 | agent id |
|---|---|
| 架构师 / 系统架构师 | `architect` |
| 后端工程师 / 后端 | `backend-engineer` |
| 前端工程师 / 前端 | `frontend-engineer` |
| UI设计师 / 界面设计师 / 设计工程师 | `ui-designer` |
| 全栈工程师 / 全栈 | `fullstack-engineer` |
| 测试工程师 / QA | `qa-engineer` |
| 安全工程师 / 安全 | `security-engineer` |
| DevOps / SRE / 运维工程师 | `devops-engineer` |

## 强制工作流

1. **读取约束**：检查 `AGENTS.md`、`CLAUDE.md`、README、项目配置、相关代码与测试。
2. **澄清目标但不拖延**：能从仓库和上下文推断的，不重复询问。标记关键假设。
3. **确定已批准计划**：
   - 当前对话已经有 Codex 输出且用户要求“按这个计划落地”时，原样复用该计划，不重新规划。
   - 当前对话没有可执行计划时，才输出一个有顺序的计划，至少包含目标与非目标、真实模块/文件、契约、实施步骤、风险、验证命令和验收标准。
4. **选择一个主智能体**：按任务的主要风险选择，而不是按文件后缀选择。跨层功能优先 `fullstack-engineer`。
5. **调用 `run_agent`**：传入 `agent`、具体 `task`、当前已批准的完整 `plan`、`acceptanceCriteria`、`cwd`。模型和 effort 默认由插件 `.env` 解析，不要无故覆盖。MCP 会通过 Claude Code 原生 `--agents` 与 `--agent` 参数加载该专业智能体。
6. **审查结果**：检查 Claude Code 的实际改动、测试证据和未完成事项。默认使用精简结果，不要把原始完整日志带回上下文，也不要直接转述成功声明。
7. **必要时修正**：若实现偏离计划，使用同一智能体并通过 `resume` 继续，给出明确差异和修复要求。
8. **最终汇报**：分别说明 Codex 的计划、Claude 的实施结果、验证证据和残余风险。

## MCP 工具使用规则

- `list_agents`：配置检查或用户询问可用智能体时使用。
- `run_agent`：只有在 `plan` 已经具体且非空时使用。
- `background=true`：预计长时间执行时使用；按 `recommendedPollSeconds` 查询状态，任务达到终态后只调用一次 `job_result`。
- `job_status`：同一任务两次查询至少间隔 30 秒；无状态变化时不要重复叙述或执行额外诊断。
- `job_result`：默认精简读取；只有结果被截断且审查确实需要，或认证/执行排障时才使用 `full=true`。
- `dryRun=true`：仅在配置变更、首次安装或实际执行失败时调试；正常派遣不要先跑 dry-run。
- `job_cancel`：用户要求停止，或明显错误的任务仍在运行时使用。

## 权限规则

- 默认使用智能体配置的权限模式。
- `architect` 和 `security-engineer` 默认只规划/分析；需要它们修改代码时，必须明确传入适当权限并说明原因。
- 不要自动选择 `bypassPermissions`。只有用户明确配置并理解风险时才允许。
- 不要把 API key、网关 token 或完整环境变量放进工具参数、计划、提示词或最终回复。

## 委派质量标准

传给 Claude 的计划必须足够具体，使执行者无需重新设计项目方向。计划中应使用仓库真实路径和真实命令；不确定时标注为“先验证”，不能伪造。

调用后，Codex仍对最终结果负责。Claude 的报告不是验收本身；应检查 diff、测试和关键边界。
