import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexInvocation, codexRunner, parseCodexOutput } from '../plugins/claude-code-agents/server/lib/runners/codex.mjs';
import { buildGrokInvocation, createGrokProgressReporter, parseGrokOutput } from '../plugins/claude-code-agents/server/lib/runners/grok.mjs';
import { buildAgyInvocation } from '../plugins/claude-code-agents/server/lib/runners/agy.mjs';
import { loadAgentRegistry, resolveAgent, resolveAgentRuntime } from '../plugins/claude-code-agents/server/lib/agents.mjs';
import { ClaudeAgentService, resolveRunnerTimeout } from '../plugins/claude-code-agents/server/lib/service.mjs';
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
  const targetCwd = path.join(pluginRoot, 'server');
  const plan = buildCodexInvocation({ pluginRoot, agent, runtime: codexRuntime({ permissionMode: 'plan' }), request: request(), cwd: targetCwd });
  assert.deepEqual(plan.args.slice(0, 8), ['exec', '--json', '--cd', targetCwd, '--model', 'gpt-test', '--sandbox', 'read-only']);
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

  const deepReasoning = buildCodexInvocation({ pluginRoot, agent, runtime: codexRuntime({ effort: 'xhigh' }), request: request() });
  const configIndex = deepReasoning.args.indexOf('--config');
  assert.equal(deepReasoning.args[configIndex + 1], 'model_reasoning_effort="xhigh"');

  const gateway = buildCodexInvocation({
    pluginRoot,
    agent,
    runtime: codexRuntime({ gatewayUrl: 'http://localhost:8080/v1', apiKey: 'secret-key' }),
    request: request(),
  });
  assert.ok(gateway.args.includes('openai_base_url="http://localhost:8080/v1"'));
  assert.equal(gateway.args.includes('secret-key'), false);
  assert.equal(gateway.env.CODEX_API_KEY, 'secret-key');
});

test('Codex dry-run redacts the configured gateway address', async () => {
  const result = await codexRunner.run({
    pluginRoot,
    agent,
    runtime: codexRuntime({ gatewayUrl: 'https://private-gateway.example/v1' }),
    request: request({ dryRun: true }),
    cwd: '/tmp',
  });
  assert.ok(result.args.includes('openai_base_url="[CONFIGURED]"'));
  assert.equal(result.args.some((value) => String(value).includes('private-gateway.example')), false);
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

test('Codex rejects unknown effort, browser, resume, and session capabilities', () => {
  assert.throws(() => buildCodexInvocation({ pluginRoot, agent, runtime: codexRuntime({ effort: 'extreme' }), request: request() }), /does not support effort/);
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

test('short one-run timeouts cannot reduce the configured Runner timeout without explicit approval', () => {
  assert.deepEqual(resolveRunnerTimeout({ configuredTimeoutMs: 3_600_000, requestedTimeoutMs: 120_000 }), {
    configuredTimeoutMs: 3_600_000,
    requestedTimeoutMs: 120_000,
    effectiveTimeoutMs: 3_600_000,
    timeoutSource: 'configured-protected',
  });
  assert.deepEqual(resolveRunnerTimeout({ configuredTimeoutMs: 3_600_000, requestedTimeoutMs: 120_000, allowShorterTimeout: true }), {
    configuredTimeoutMs: 3_600_000,
    requestedTimeoutMs: 120_000,
    effectiveTimeoutMs: 120_000,
    timeoutSource: 'request-override',
  });
  assert.equal(resolveRunnerTimeout({ configuredTimeoutMs: 120_000, requestedTimeoutMs: 600_000 }).effectiveTimeoutMs, 600_000);
});

test('non-Claude runners do not inherit Claude-only role models', () => {
  const runtime = resolveAgentRuntime({ agent, runner: 'grok', env: {
    BACKEND_ENGINEER_MODEL: 'claude-role-model',
    CLAUDE_DEFAULT_MODEL: 'claude-default-model',
    GROK_DEFAULT_MODEL: 'grok-default-model',
  } });
  assert.equal(runtime.model, 'grok-default-model');
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
  assert.deepEqual(runTool.inputSchema.properties.runner.enum, ['claude', 'codex', 'grok', 'agy']);
  assert.equal(runTool.inputSchema.properties.allowShorterTimeout.default, false);
  assert.deepEqual(listAgentTool.inputSchema.properties.runner.enum, ['claude', 'codex', 'grok', 'agy']);
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_runners', arguments: {} } });
  const runners = JSON.parse(responses[1].result.content[0].text);
  assert.equal(runners[1].id, 'codex');
  assert.deepEqual(runners[1].capabilities.browser, ['none']);
});

test('Grok and Antigravity invocations preserve role prompts and map native options', () => {
  const targetCwd = path.join(pluginRoot, 'server');
  const grok = buildGrokInvocation({
    pluginRoot,
    agent,
    cwd: targetCwd,
    runtime: {
      runner: 'grok', model: 'grok-test', effort: 'high', permissionMode: 'bypassPermissions', outputFormat: 'stream-json',
      timeoutMs: 30_000, extraEnv: {}, grokBin: 'grok', gatewayUrl: '', apiKey: '',
    },
    request: request({ runner: 'grok', sessionId: 'new-session' }),
  });
  assert.equal(grok.command, 'grok');
  assert.ok(grok.args.includes('--single'));
  assert.equal(grok.args[grok.args.indexOf('--cwd') + 1], targetCwd);
  assert.equal(grok.args[grok.args.indexOf('--output-format') + 1], 'streaming-json');
  assert.ok(grok.args.includes('--always-approve'));
  assert.ok(grok.prompt.includes('<role_protocol>'));

  const agy = buildAgyInvocation({
    pluginRoot,
    agent,
    runtime: {
      runner: 'agy', model: 'agy-test', effort: 'medium', permissionMode: 'plan', outputFormat: 'text',
      timeoutMs: 30_000, extraEnv: {}, agyBin: 'agy', gatewayUrl: '', apiKey: '',
    },
    request: request({ runner: 'agy', resume: 'latest' }),
  });
  assert.equal(agy.command, 'agy');
  assert.ok(agy.args.includes('--print'));
  assert.ok(agy.args.includes('--mode') && agy.args.includes('plan'));
  assert.ok(agy.args.includes('--continue'));
  assert.equal(agy.args[agy.args.indexOf('--print') + 1], agy.prompt);
  assert.ok(agy.prompt.includes('<role_protocol>'));
});

test('Grok parser keeps the final assistant message and usage metadata', () => {
  const parsed = parseGrokOutput([
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'intermediate' } }),
    JSON.stringify({ type: 'turn.completed', text: 'final', usage: { input_tokens: 3, output_tokens: 4 }, session_id: 'grok-session' }),
  ].join('\n'), 'stream-json');
  assert.equal(parsed.text, 'final');
  assert.equal(parsed.sessionId, 'grok-session');
  assert.equal(parsed.inputTokens, 3);
  assert.equal(parsed.outputTokens, 4);
});

test('Grok parser preserves a structured error when no assistant text is returned', () => {
  const parsed = parseGrokOutput(JSON.stringify({ type: 'error', error: { message: 'authentication required' } }), 'stream-json');
  assert.equal(parsed.text, 'authentication required');
  assert.equal(parsed.error, 'authentication required');
});

test('Grok progress reporter coalesces token events and preserves tool events', () => {
  const observed = [];
  const reporter = createGrokProgressReporter({ onProgress: (progress) => observed.push(progress), secrets: ['secret-token'] });
  reporter.push({ type: 'thought', data: 'Inspect' });
  reporter.push({ type: 'thought', data: ' files' });
  reporter.push({ type: 'thought', data: ' secret' });
  reporter.push({ type: 'thought', data: '-token' });
  reporter.push({ type: 'text', data: '开始' });
  reporter.push({ type: 'text', data: '修改' });
  reporter.push({ type: 'tool_call', data: { name: 'edit_file', input: { path: 'src/app.ts' } } });
  reporter.flush();
  assert.deepEqual(observed.map((progress) => progress.event), [
    { type: 'thought', data: 'Inspect files [REDACTED]' },
    { type: 'text', data: '开始修改' },
    { type: 'tool_call', data: { name: 'edit_file', input: { path: 'src/app.ts' } } },
  ]);
  assert.equal(observed.at(-1).lastTool, 'edit_file');
});

test('Grok and Antigravity runners execute through the shared supervisor', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-runner-execution-'));
  const grokMock = path.join(temp, 'grok-mock.mjs');
  const agyMock = path.join(temp, 'agy-mock.mjs');
  fs.writeFileSync(grokMock, [
    '#!/usr/bin/env node',
    "process.stdout.write(JSON.stringify({ type: 'message', text: 'grok result' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'turn.completed', text: 'grok final', session_id: 'grok-mock-session' }) + '\\n');",
  ].join('\n'));
  fs.writeFileSync(agyMock, ['#!/usr/bin/env node', "process.stdout.write('agy result\\n');"].join('\n'));
  fs.chmodSync(grokMock, 0o755);
  fs.chmodSync(agyMock, 0o755);
  const service = new ClaudeAgentService({ pluginRoot, dataRoot: path.join(temp, 'data') });
  const grok = await service.run({ agent: agent.id, runner: 'grok', grokBin: grokMock, task: 'grok mock', plan: '1. Run.', cwd: temp });
  assert.equal(grok.status, 'completed');
  assert.equal(grok.runner, 'grok');
  assert.equal(grok.text, 'grok final');
  const agy = await service.run({ agent: agent.id, runner: 'agy', agyBin: agyMock, task: 'agy mock', plan: '1. Run.', cwd: temp });
  assert.equal(agy.status, 'completed');
  assert.equal(agy.runner, 'agy');
  assert.equal(agy.text, 'agy result');
});
