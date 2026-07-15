# Validation Report — v0.2.0

Validation date: 2026-07-15

## Result

- Node test suites: **30 passed, 0 failed**
- JavaScript syntax checks: passed
- JSON manifests and agent registry: parsed successfully
- MCP initialize / tools/list / dry-run: passed
- Chinese and English agent alias resolution: passed
- Exact approved-plan preservation through a spawned mock Claude process: passed
- `planSha256` audit identifier: passed
- Secret isolation: API credential remained in child environment and did not enter CLI arguments
- Foreground execution creates and finalizes a Job record before returning
- Compact foreground and background results preserve review evidence without returning raw event streams by default
- Background workers consume internal `stream-json` events and persist versioned compact progress (`starting` → `inspecting` → `implementing` → `verifying` → `finalizing` → terminal)
- Default orchestrated polling exposes `progressRevision` and adaptively backs off at 30, 60, 120, and 180 seconds; unchanged polls are marked without duplicate user-facing progress text
- Explicit `background=false` foreground execution remains a single-result silent-wait path
- Default compact MCP payload is capped at 8 KB and marks truncation
- MCP service heartbeat renews background leases; `job_status` is inspection-only and does not renew leases
- JSON objects, JSON event arrays, and line-delimited `stream-json` results are parsed successfully
- Full stored output remains available through the explicit diagnostic result mode
- MCP request cancellation terminates the active Claude process group
- MCP manifest declares `tool_timeout_sec: 2100`
- Worker fallback cancels background jobs when their session lease expires without an MCP service heartbeat
- MCP service disposal cancels owned non-persistent jobs
- Explicit persistent jobs survive MCP service disposal and complete normally
- All eight Agent XML prompts enforce bounded command output and fixed evidence-report sections
- Orchestrator skill requires explicit background delegation with adaptive polling, supports explicit silent foreground waiting, and requires an editable next-stage plan
- Doctor passes and emits a non-blocking compaction recommendation without changing global config

## Claude CLI compatibility checked against supplied `claude --help`

Generated invocation uses:

- `-p`
- `--output-format`
- `--verbose`
- `--model`
- `--effort`
- `--permission-mode`
- `--agents`
- `--agent`
- `--name`
- optional `--max-budget-usd`
- optional `--resume` or `--session-id`
- optional `--allowed-tools` / `--disallowed-tools`

No generated flag was missing from the supplied help output.

Removed from v0.1 because they were unsupported by the supplied CLI version:

- `--append-system-prompt-file`
- `--max-turns`
- effort value `ultracode`
- permission mode `manual`

## Execution test

A strict mock executable was spawned as a real child process. It rejected unsupported options, parsed the native custom-agent JSON, and captured the positional delegation prompt. The test confirmed that:

1. `--agents` contained the selected role's XML expert prompt.
2. `--agent` selected the expected role.
3. The complete approved Codex plan appeared in the single delegation prompt.
4. JSON result and Claude session ID were parsed successfully.

## Environment limitation

The local environment provides `claude 2.1.145`, and `npm run doctor` passes. A paid/live Claude model call is only claimed after the installed-cache MCP smoke test completes; mock-based tests do not substitute for that check.
