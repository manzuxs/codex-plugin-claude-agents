import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadAgentRegistry, resolveAgent, resolveAgentRuntime } from '../plugins/claude-code-agents/server/lib/agents.mjs';
import { runClaude } from '../plugins/claude-code-agents/server/lib/claude.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'claude-code-agents');

async function waitForFile(filePath, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test('real child-process delegation preserves the approved Codex plan', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-test-'));
  const capture = path.join(temp, 'capture.json');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const supported = new Set(['--bare','--setting-sources','-p','--output-format','--verbose','--model','--effort','--permission-mode','--agents','--agent','--dangerously-skip-permissions','--name','--max-budget-usd','--resume','--session-id','--allowed-tools','--disallowed-tools','--chrome','--mcp-config','--strict-mcp-config']);
const valueFlags = new Set(['--setting-sources','--output-format','--model','--effort','--permission-mode','--agents','--agent','--name','--max-budget-usd','--resume','--session-id','--allowed-tools','--disallowed-tools','--mcp-config']);
let positional = [];
for (let i = 0; i < args.length; i++) {
  const token = args[i];
  if (token.startsWith('-')) {
    if (!supported.has(token)) { console.error('unsupported flag: ' + token); process.exit(64); }
    if (valueFlags.has(token)) i += 1;
  } else positional.push(token);
}
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const payload = { args, positional, agents: JSON.parse(after('--agents')), agent: after('--agent') };
fs.writeFileSync(process.env.MOCK_CAPTURE_PATH, JSON.stringify(payload));
process.stdout.write(JSON.stringify({ result: 'implemented and tested', session_id: '11111111-1111-4111-8111-111111111111', num_turns: 3 }));
`);
  fs.chmodSync(mock, 0o755);

  const registry = loadAgentRegistry(pluginRoot);
  const agent = resolveAgent(registry, '后端工程师');
  const runtime = resolveAgentRuntime({
    agent,
    env: {},
    overrides: { claudeBin: mock, permissionMode: 'auto', extraEnv: { MOCK_CAPTURE_PATH: capture } },
  });
  const approvedPlan = '1. Inspect src/api.\n2. Implement route.\n3. Run npm test.';
  const planSha256 = crypto.createHash('sha256').update(approvedPlan, 'utf8').digest('hex');
  const result = await runClaude({
    pluginRoot,
    agent,
    runtime,
    cwd: temp,
    request: { task: 'Implement the approved API change', plan: approvedPlan, planSha256, acceptanceCriteria: 'Tests pass' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.planSha256, planSha256);
  const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(seen.agent, 'backend-engineer');
  assert.ok(seen.agents['backend-engineer'].prompt.includes('<methodology>'));
  assert.equal(seen.positional.length, 1);
  assert.ok(seen.positional[0].includes(approvedPlan));
});

test('AbortSignal terminates an active Claude process group', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-cancel-'));
  const startedFile = path.join(temp, 'started');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.env.MOCK_STARTED_PATH, 'started');
setInterval(() => {}, 1000);
`);
  fs.chmodSync(mock, 0o755);

  const registry = loadAgentRegistry(pluginRoot);
  const agent = resolveAgent(registry, '后端工程师');
  const runtime = resolveAgentRuntime({
    agent,
    env: {},
    overrides: { claudeBin: mock, timeoutMs: 10_000, extraEnv: { MOCK_STARTED_PATH: startedFile } },
  });
  const controller = new AbortController();
  const running = runClaude({
    pluginRoot,
    agent,
    runtime,
    cwd: temp,
    signal: controller.signal,
    request: { task: 'Wait until cancelled', plan: '1. Wait.', planSha256: 'cancel-plan' },
  });
  await waitForFile(startedFile);
  controller.abort('mcp_request_cancelled');
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancellationReason, 'mcp_request_cancelled');
});
