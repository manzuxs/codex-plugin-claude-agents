# Claude Code Agents for Codex

[English](./README.md) | [简体中文](./README.zh-CN.md)

A local Codex plugin that delegates an approved implementation plan to role-specialized Claude Code CLI agents. Codex remains responsible for planning, scope control, and final review; Claude Code performs the delegated work in the target repository.

## Features

- Native Claude Code custom agents through `--agents` and `--agent`.
- Eight built-in software delivery roles with dedicated prompts and quality gates.
- Per-agent model, effort, permission, timeout, budget, gateway, and credential settings.
- Foreground execution, background jobs, cancellation, result persistence, and session resume.
- Real-browser validation for UI, frontend, and QA agents.
- Repository-native Playwright/Cypress, Claude in Chrome, and browser MCP backends.
- Browser capability preflight, evidence gates, and actionable installation guidance.
- Compact progress and result payloads that keep raw event streams out of the default Codex context.
- No runtime npm dependencies.

## Built-in agents

| Agent | ID | Primary responsibility | Default permission |
|---|---|---|---|
| Architect | `architect` | System boundaries, quality attributes, ADRs, and technical risk | `plan` |
| Backend engineer | `backend-engineer` | APIs, domain models, consistency, reliability, and observability | `auto` |
| Frontend engineer | `frontend-engineer` | Components, state, accessibility, performance, and browser behavior | `auto` |
| UI designer | `ui-designer` | Information hierarchy, design systems, interaction states, and visual quality | `auto` |
| Full-stack engineer | `fullstack-engineer` | End-to-end vertical slices and cross-layer integration | `auto` |
| QA engineer | `qa-engineer` | Risk-based testing, regression, browser smoke tests, and E2E quality gates | `auto` |
| Security engineer | `security-engineer` | Threat modeling, authorization, data protection, and supply-chain review | `plan` |
| DevOps/SRE engineer | `devops-engineer` | CI/CD, infrastructure, observability, SLOs, releases, and rollback | `auto` |

## Requirements

- Node.js 18.18 or later.
- A working local `claude` command.
- A Claude Code login, or a compatible API gateway and credentials.
- A Codex client that supports local plugins and stdio MCP servers.

## Installation

### From GitHub

```bash
codex plugin marketplace add manzuxs/codex-plugin-claude-agents
codex plugin add claude-code-agents@local-claude-code-agents
```

The full Git URL is also supported:

```bash
codex plugin marketplace add https://github.com/manzuxs/codex-plugin-claude-agents.git
codex plugin add claude-code-agents@local-claude-code-agents
```

### From a local checkout

```bash
git clone https://github.com/manzuxs/codex-plugin-claude-agents.git
cd codex-plugin-claude-agents
codex plugin marketplace add "$(pwd)"
codex plugin add claude-code-agents@local-claude-code-agents
```

Start a new Codex task after installation so the plugin skills and MCP tools are loaded. If Codex still references an older plugin cache path, fully restart the desktop app and open a new task.

### Update

```bash
codex plugin marketplace upgrade local-claude-code-agents
codex plugin add claude-code-agents@local-claude-code-agents
```

## Configuration

Store long-lived user configuration outside the installed plugin cache:

```bash
mkdir -p ~/.config/claude-code-agents
cp plugins/claude-code-agents/.env.example ~/.config/claude-code-agents/.env
chmod 600 ~/.config/claude-code-agents/.env
```

Minimal configuration:

```dotenv
CLAUDE_DEFAULT_MODEL=sonnet
CLAUDE_DEFAULT_EFFORT=high
CLAUDE_DEFAULT_PERMISSION_MODE=auto
CLAUDE_DEFAULT_TIMEOUT_MS=1800000
CLAUDE_DEFAULT_OUTPUT_FORMAT=json
```

Each agent can override the defaults with its prefix:

```dotenv
BACKEND_ENGINEER_MODEL=<your-model>
BACKEND_ENGINEER_EFFORT=high
BACKEND_ENGINEER_PERMISSION_MODE=auto
BACKEND_ENGINEER_GATEWAY_URL=https://your-api-gateway.example.com/v1
BACKEND_ENGINEER_API_KEY=replace-me
BACKEND_ENGINEER_API_KEY_KIND=auth_token
```

Supported effort values:

```text
low | medium | high | xhigh | max
```

Supported permission modes:

```text
default | acceptEdits | auto | bypassPermissions | dontAsk | plan
```

`bypassPermissions` is never forced by the plugin. Set it only for agents and environments where you accept its security implications.

Configuration precedence, from lowest to highest:

1. Plugin `.env`.
2. `~/.config/claude-code-agents/.env`.
3. `<project>/.claude-agents.env`.
4. Environment variables inherited by Codex.
5. Non-secret overrides supplied to a single `run_agent` call.

Set `CLAUDE_AGENTS_CONFIG_FILE` to use a different user configuration file.

### Gateway and credentials

```dotenv
CLAUDE_DEFAULT_GATEWAY_URL=https://your-api-gateway.example.com/v1
CLAUDE_DEFAULT_API_KEY=replace-me
CLAUDE_DEFAULT_API_KEY_KIND=auth_token
```

- `auth_token` maps to `ANTHROPIC_AUTH_TOKEN`.
- `api_key` maps to `ANTHROPIC_API_KEY`.
- The gateway URL maps to `ANTHROPIC_BASE_URL`.

Credentials are injected into the Claude child process environment. They are excluded from CLI arguments, delegation XML, MCP responses, and persisted background job requests.

## Usage

Ask Codex to inspect the repository and prepare a concrete plan:

```text
Inspect this repository and produce an executable implementation plan for the requested change.
Do not edit files yet. Include the real file scope, contracts, implementation steps,
risks, verification commands, and acceptance criteria.
```

After approving the plan, delegate it to a specialist:

```text
Implement the approved plan without replanning. Use the backend engineer agent.
After execution, review the actual diff, verification evidence, and unfinished work.
```

Other examples:

```text
Implement the approved vertical slice with the full-stack engineer agent.
```

```text
Implement and visually validate the approved interface with the UI designer agent.
```

```text
Review the approved design with the architect agent. Report architecture risks and ADRs only; do not edit files.
```

## Browser validation

Browser modes are available to `ui-designer`, `frontend-engineer`, and `qa-engineer`. Each role uses a different completion contract:

| Agent | Validation purpose | Recommended backend | Required evidence |
|---|---|---|---|
| `ui-designer` | Visual validation | Browser MCP or Chrome | Rendered page, target viewports, interaction states, and screenshots |
| `frontend-engineer` | Implementation validation | Repository Playwright/Cypress | Affected user path, responsive and interaction behavior, console status, and reproducible evidence |
| `qa-engineer` | Independent smoke, regression, or E2E | Repository Playwright/Cypress or MCP | User-path assertions, commands or tool actions, and evidence locations |

Supported browser modes:

| Mode | Behavior |
|---|---|
| `none` | No browser capability is loaded. |
| `repository` | Uses an existing Playwright or Cypress installation in the target repository. |
| `chrome` | Enables Claude in Chrome for an existing browser session. Direct Anthropic authentication is required. |
| `mcp` | Loads a trusted browser MCP configuration with `--mcp-config` and `--strict-mcp-config`. |

Example MCP profile configuration:

```dotenv
UI_DESIGNER_BROWSER_MCP_CONFIGS_JSON={"playwright":"/absolute/path/to/playwright-mcp.json"}
FRONTEND_ENGINEER_BROWSER_MCP_CONFIGS_JSON={"playwright":"/absolute/path/to/playwright-mcp.json"}
QA_ENGINEER_BROWSER_MCP_CONFIGS_JSON={"playwright":"/absolute/path/to/playwright-mcp.json"}
```

Example delegation:

```json
{
  "agent": "qa-engineer",
  "task": "Run a real-browser smoke test for the critical user path",
  "plan": "<approved Codex plan>",
  "acceptanceCriteria": "Complete the path in a real browser, assert the result, and retain evidence",
  "browserMode": "repository",
  "cwd": "/absolute/path/to/project"
}
```

The plugin checks repository dependencies, validates MCP configuration, inspects the Claude `system/init` capability list, and requires observed browser execution. A failed gate returns `blocked` with an `installationHint`. The plugin does not install dependencies or silently substitute Codex browser automation.

## MCP tools

| Tool | Purpose |
|---|---|
| `list_agents` | Lists available agents and non-secret runtime settings. |
| `run_agent` | Delegates an approved plan to one specialist. |
| `job_status` | Returns compact progress for a background job. |
| `job_result` | Returns the stored terminal result. |
| `job_cancel` | Cancels an active background job. |

`run_agent` requires `agent`, `task`, and `plan`. Common optional fields include:

```text
acceptanceCriteria, context, cwd, background, persistOnDisconnect,
leaseTimeoutMs, dryRun, resume, sessionId, model, effort,
permissionMode, timeoutMs, maxBudgetUsd, allowedTools, disallowedTools,
browserMode, browserMcpProfile
```

`resume` and `sessionId` are mutually exclusive.

### Background jobs

Normal orchestration uses `background=true`. The call returns a job ID and an adaptive `nextPollSeconds` hint. Codex reads compact progress with `job_status` and retrieves the terminal result once with `job_result`.

Use `background=false` when the user explicitly requests a single blocking wait with no progress polling. Use `persistOnDisconnect=true` only when the user explicitly wants the job to survive the Codex session.

Job data is stored under the Codex-provided `PLUGIN_DATA` directory. Direct execution falls back to `~/.codex/claude-code-agents`.

## Diagnostics

```bash
npm test
npm run doctor
npm run list-agents
npm run dry-run
```

Direct CLI dry run:

```bash
node plugins/claude-code-agents/server/cli.mjs run \
  --agent backend-engineer \
  --task "Implement the user query endpoint" \
  --plan @/tmp/codex-plan.md \
  --cwd /path/to/project \
  --dry-run
```

Remove `--dry-run` only when you intend to start the local Claude Code process.

## Security model

- Codex owns planning, scope control, and final review.
- Claude specialists receive the approved plan and repository context for execution.
- Child processes use argument arrays with `shell: false`.
- Secrets remain in the child process environment and are redacted from stored or returned data.
- Browser MCP callers select trusted profile names; they cannot supply arbitrary configuration paths.
- Browser validation cannot pass without observed real-browser execution.
- Background jobs are session-bound by default and are cancelled when their owner disconnects.
- `planSha256` identifies the delegated plan; it does not certify that the implementation passed review.

## Repository layout

```text
.
├── .agents/plugins/marketplace.json
├── plugins/claude-code-agents/
│   ├── .codex-plugin/plugin.json
│   ├── .mcp.json
│   ├── .env.example
│   ├── agents/
│   ├── server/
│   ├── skills/
│   └── scripts/
├── diagram/
├── tests/
├── QUICKSTART.md
└── VALIDATION.md
```

## License

MIT
