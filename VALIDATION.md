# Validation Report — v0.2.0

Validation date: 2026-07-14

## Result

- Node test suites: **20 passed, 0 failed**
- JavaScript syntax checks: passed
- JSON manifests and agent registry: parsed successfully
- MCP initialize / tools/list / dry-run: passed
- Chinese and English agent alias resolution: passed
- Exact approved-plan preservation through a spawned mock Claude process: passed
- `planSha256` audit identifier: passed
- Secret isolation: API credential remained in child environment and did not enter CLI arguments
- Background job implementation remains available through worker/job store
- Compact job status and result views preserve review evidence without returning raw event streams by default
- JSON objects, JSON event arrays, and line-delimited `stream-json` results are parsed successfully
- Full stored output remains available through the explicit diagnostic result mode
- MCP request cancellation terminates the active Claude process group
- Background jobs cancel when their 90-second session lease is not renewed
- MCP service disposal cancels owned non-persistent jobs
- Explicit persistent jobs survive MCP service disposal and complete normally

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

The validation environment does not provide the user's authenticated real `claude` binary, gateway, or model account. Therefore no paid/live Claude model call is claimed. Run `npm run doctor` and a small real repository task on the target Mac after installation.
