import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexInvocation, parseCodexOutput } from '../plugins/claude-code-agents/server/lib/runners/codex.mjs';
import { loadAgentRegistry, resolveAgent, resolveAgentRuntime } from '../plugins/claude-code-agents/server/lib/agents.mjs';
import { ClaudeAgentService } from '../plugins/claude-code-agents/server/lib/service.mjs';
import { McpServer } from '../plugins/claude-code-agents/server/lib/mcp.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'claude-code-agents');
const registry = loadAgentRegistry(pluginRoot);
const agent = resolveAgent(registry, 'backend-engineer');

function codexRuntime(overrides = {}) {
  return {
    runner: 'codex',
    model: 'gpt-test',
    effort: 'default',
    permissionMode: 'auto',
    outputFormat: 'stream-json',
    timeoutMs: 30_000,
    maxBudgetUsd: 0,
    extraEnv: {},
    codexBin: 'codex',
    ...overrides,
  };
}

function request(overrides = {}) {
  return { task: 'Implement the approved change', plan: '1. Inspect. 2. Implement. 3. Test.', cwd: '/tmp', ...overrides };
}

test('Codex invocation uses only supported safe argv for each permission intent', () => {
  const plan = buildCodexInvocation({ pluginRoot, agent, runtime: codexRuntime({ permissionMode: 'plan' }), request: request() });
  assert.deepEqual(plan.args.slice(0, 8), ['exec', '--json', '--cd', '/tmp', '--model', 'gpt-test', '--sandbox', 'read-only']);
  assert.equal(plan.args.includes('--ask-for-approval'), false);
  assert.equal(plan.args.includes('--agents'), false);

  const automatic = buildCodexInvocation({ pluginRoot, agent, runtime: codexRuntime({ permissionMode: 'default' }), request: request() });
  assert.equal(automatic.args.includes('--sandbox'), true);
  assert.equal(automatic.args[automatic.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(automatic.args.includes('--ask-for-approval'), false);
  assert.equal(automatic.args.includes('--agents'), false);

  const bypass = buildCodexInvocation({ pluginRoot, agent, runtime: codexRuntime({ permissionMode: 'bypassPermissions' }), request: request() });
  assert.equal(bypass.args.includes('--dangerously-bypass-approvals-and-sandbox'), true);
  assert.equal(bypass.args.includes('--ask-for-approval'), false);
  assert.equal(bypass.args.includes('--agents'), false);
  assert.equal(bypass.args.filter((value) => value === request().plan).length, 0);
  assert.match(bypass.args.at(-1), /<codex_plan>/);
});

test('Codex JSONL parser aggregates thread.started, agent message, and usage', () => {
  const parsed = parseCodexOutput([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final implementation report' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 34 } }),
  ].join('\n'));
  assert.equal(parsed.text, 'final implementation report');
  assert.equal(parsed.sessionId, 'thread-123');
  assert.equal(parsed.inputTokens, 12);
  assert.equal(parsed.outputTokens, 34);
  assert.equal(parsed.structured.length, 3);
});

test('Codex parser preserves legacy result-shaped output', () => {
  const parsed = parseCodexOutput(JSON.stringify({ type: 'result', result: 'legacy result', session_id: 'legacy-thread', usage: { input: 2, output: 3 } }));
  assert.equal(parsed.text, 'legacy result');
  assert.equal(parsed.sessionId, 'legacy-thread');
  assert.equal(parsed.inputTokens, 2);
  assert.equal(parsed.outputTokens, 3);
});

test('foreground Codex runner uses one shell-safe prompt and normalizes result fields', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runner-'));
  const capture = path.join(temp, 'capture.json');
  const mock = path.join(temp, 'codex-mock.mjs');
  fs.writeFileSync(mock, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--ask-for-approval') || args.includes('--agents')) process.exit(64);
const separator = args.indexOf('--');
if (separator < 0 || args.length - separator !== 2) process.exit(65);
fs.writeFileSync(process.env.MOCK_CAPTURE_PATH, JSON.stringify({ args, prompt: args[separator + 1] }));
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'mock-thread' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'mock codex completed' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 8 } }) + '\\n');
`);
  fs.chmodSync(mock, 0o755);
  const previousCapture = process.env.MOCK_CAPTURE_PATH;
  process.env.MOCK_CAPTURE_PATH = capture;
  try {
    const service = new ClaudeAgentService({ pluginRoot, dataRoot: path.join(temp, 'data') });
    const result = await service.run({
      agent: 'backend-engineer',
      runner: 'codex',
      codexBin: mock,
      model: 'gpt-test',
      task: 'Run the mock Codex adapter',
      plan: '1. Run mock. 2. Verify result.',
      cwd: temp,
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.runner, 'codex');
    assert.equal(result.role, 'backend-engineer');
    assert.equal(result.agent, 'backend-engineer');
    assert.equal(result.model, 'gpt-test');
    assert.deepEqual(result.capabilitiesUsed, ['rolePrompt', 'jsonEvents']);
    assert.equal(result.sessionId, 'mock-thread');
    assert.equal(result.text, 'mock codex completed');
    const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
    const separator = seen.args.indexOf('--');
    assert.ok(separator >= 0);
    assert.equal(seen.args.at(-1), seen.prompt);
    assert.equal(seen.args.slice(separator + 1).length, 1);
    assert.match(seen.prompt, /<codex_plan>/);
    assert.match(seen.prompt, /<role_protocol>/);
  } finally {
    if (previousCapture === undefined) delete process.env.MOCK_CAPTURE_PATH;
    else process.env.MOCK_CAPTURE_PATH = previousCapture;
  }
});

test('Codex rejects unsupported effort, browser, resume, and session capabilities', () => {
  assert.throws(() => buildCodexInvocation({ pluginRoot, agent, runtime: codexRuntime({ effort: 'high' }), request: request() }), /does not support effort/);
  assert.throws(() => buildCodexInvocation({ pluginRoot, agent, runtime: codexRuntime(), request: request({ browserMode: 'repository' }) }), /does not support browserMode/);
  assert.throws(() => buildCodexInvocation({ pluginRoot, agent, runtime: codexRuntime(), request: request({ resume: 'old-thread' }) }), /does not support resume/);
  assert.throws(() => buildCodexInvocation({ pluginRoot, agent, runtime: codexRuntime(), request: request({ sessionId: 'new-thread' }) }), /does not support sessionId/);
});

test('runner defaults resolve from canonical and legacy configuration layers', async () => {
  const canonical = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-default-'));
  fs.writeFileSync(path.join(canonical, '.claude-agents.env'), 'DEFAULT_RUNNER=codex\nCODEX_DEFAULT_MODEL=gpt-canonical\n');
  const canonicalService = new ClaudeAgentService({ pluginRoot, dataRoot: path.join(canonical, 'data') });
  const canonicalResult = await canonicalService.run({ agent: 'backend-engineer', task: 'x', plan: '1. x', cwd: canonical, dryRun: true });
  assert.equal(canonicalResult.runner, 'codex');
  assert.equal(canonicalResult.model, 'gpt-canonical');

  const roleDefault = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-role-default-'));
  fs.writeFileSync(path.join(roleDefault, '.claude-agents.env'), 'BACKEND_ENGINEER_DEFAULT_RUNNER=codex\nBACKEND_ENGINEER_CODEX_MODEL=gpt-role\n');
  const roleService = new ClaudeAgentService({ pluginRoot, dataRoot: path.join(roleDefault, 'data') });
  const roleResult = await roleService.run({ agent: 'backend-engineer', task: 'x', plan: '1. x', cwd: roleDefault, dryRun: true });
  assert.equal(roleResult.runner, 'codex');
  assert.equal(roleResult.model, 'gpt-role');

  const explicit = await roleService.run({ agent: 'backend-engineer', runner: 'claude', task: 'x', plan: '1. x', cwd: roleDefault, dryRun: true });
  assert.equal(explicit.runner, 'claude');

  const legacy = resolveAgentRuntime({ agent, env: { BACKEND_ENGINEER_RUNNER: 'codex', CODEX_DEFAULT_MODEL: 'gpt-legacy' } });
  assert.equal(legacy.runner, 'codex');
  assert.equal(legacy.model, 'gpt-legacy');
});

test('MCP exposes list_runners, runner preview, and declared capabilities', async () => {
  const server = new McpServer({
    listRunners: () => [{ id: 'claude', capabilities: { model: true } }, { id: 'codex', capabilities: { model: true, browser: ['none'] } }],
  });
  const responses = [];
  server.send = (payload) => responses.push(payload);
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const tools = responses[0].result.tools;
  const runTool = tools.find((tool) => tool.name === 'run_agent');
  const listAgentTool = tools.find((tool) => tool.name === 'list_agents');
  assert.ok(tools.some((tool) => tool.name === 'list_runners'));
  assert.deepEqual(runTool.inputSchema.properties.runner.enum, ['claude', 'codex']);
  assert.deepEqual(listAgentTool.inputSchema.properties.runner.enum, ['claude', 'codex']);
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_runners', arguments: {} } });
  const runners = JSON.parse(responses[1].result.content[0].text);
  assert.equal(runners[1].id, 'codex');
  assert.deepEqual(runners[1].capabilities.browser, ['none']);
});
