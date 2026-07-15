import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentRegistry, resolveAgent, resolveAgentRuntime } from '../plugins/claude-code-agents/server/lib/agents.mjs';
import { buildClaudeInvocation, classifyProgressEvent, parseClaudeOutput } from '../plugins/claude-code-agents/server/lib/claude.mjs';
import { ClaudeAgentService } from '../plugins/claude-code-agents/server/lib/service.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'claude-code-agents');

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

test('invocation uses Claude native custom-agent flags and only supported options', () => {
  const registry = loadAgentRegistry(pluginRoot);
  const agent = resolveAgent(registry, 'backend-engineer');
  const runtime = resolveAgentRuntime({ agent, env: {
    CLAUDE_BIN: 'claude',
    BACKEND_ENGINEER_MODEL: 'sonnet',
    BACKEND_ENGINEER_EFFORT: 'high',
    BACKEND_ENGINEER_PERMISSION_MODE: 'auto',
  }});
  const invocation = buildClaudeInvocation({
    pluginRoot,
    agent,
    runtime,
    request: { task: 'Implement endpoint; rm -rf / must stay text', plan: '1. Inspect\n2. Implement\n3. Test' },
  });
  assert.equal(invocation.command, 'claude');
  assert.ok(invocation.args.includes('--bare'));
  assert.equal(valueAfter(invocation.args, '--setting-sources'), '');
  assert.ok(invocation.args.includes('--agents'));
  assert.equal(valueAfter(invocation.args, '--agent'), 'backend-engineer');
  assert.equal(valueAfter(invocation.args, '--permission-mode'), 'auto');
  assert.equal(invocation.args.includes('--append-system-prompt-file'), false);
  assert.equal(invocation.args.includes('--max-turns'), false);
  assert.match(invocation.args.at(-1), /rm -rf \/ must stay text/);

  const nativeAgents = JSON.parse(valueAfter(invocation.args, '--agents'));
  assert.equal(nativeAgents['backend-engineer'].description, agent.summary);
  assert.equal(nativeAgents['backend-engineer'].prompt, fs.readFileSync(path.join(pluginRoot, 'agents', agent.prompt), 'utf8'));
});

test('tool lists are comma joined and terminated before the positional prompt', () => {
  const registry = loadAgentRegistry(pluginRoot);
  const agent = resolveAgent(registry, 'backend-engineer');
  const runtime = resolveAgentRuntime({ agent, env: {} });
  const invocation = buildClaudeInvocation({
    pluginRoot, agent, runtime,
    request: { task: 'x', plan: 'y', allowedTools: ['Bash(git *)', 'Edit'], disallowedTools: ['WebFetch'] },
  });
  assert.equal(valueAfter(invocation.args, '--allowed-tools'), 'Bash(git *),Edit');
  assert.equal(valueAfter(invocation.args, '--disallowed-tools'), 'WebFetch');
  assert.ok(invocation.args.indexOf('--name') > invocation.args.indexOf('--disallowed-tools'));
  assert.match(invocation.args.at(-1), /<codex_plan>y<\/codex_plan>/);
});

test('browser modes build repository, Chrome, and strict preconfigured MCP invocations', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-mode-'));
  const mcpConfig = path.join(temp, 'playwright-mcp.json');
  fs.writeFileSync(mcpConfig, '{}');
  const registry = loadAgentRegistry(pluginRoot);
  const agent = resolveAgent(registry, 'qa-engineer');
  const runtime = resolveAgentRuntime({
    agent,
    env: { QA_ENGINEER_PERMISSION_MODE: 'auto', QA_ENGINEER_BROWSER_MCP_CONFIGS_JSON: JSON.stringify({ playwright: mcpConfig }) },
  });
  const baseRequest = { task: 'Run browser smoke tests', plan: '1. Run the required browser path.' };

  const repository = buildClaudeInvocation({ pluginRoot, agent, runtime, request: { ...baseRequest, browserMode: 'repository' } });
  assert.equal(repository.args.includes('--chrome'), false);
  assert.equal(repository.args.includes('--mcp-config'), false);
  assert.match(repository.prompt, /browser_testing required="true" mode="repository"/);

  const chrome = buildClaudeInvocation({ pluginRoot, agent, runtime, request: { ...baseRequest, browserMode: 'chrome' } });
  assert.equal(chrome.args.includes('--chrome'), true);

  const mcp = buildClaudeInvocation({
    pluginRoot,
    agent,
    runtime,
    request: { ...baseRequest, browserMode: 'mcp', browserMcpProfile: 'playwright' },
  });
  assert.equal(valueAfter(mcp.args, '--mcp-config'), mcpConfig);
  assert.equal(mcp.args.includes('--strict-mcp-config'), true);
  assert.match(mcp.prompt, /mcp_profile="playwright"/);
});

test('service enables role-specific UI, frontend, and QA browser gates while preserving permission configuration', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-guard-'));
  const service = new ClaudeAgentService({ pluginRoot, dataRoot: path.join(temp, 'data') });
  const base = { task: 'Browser smoke', plan: '1. Run browser smoke.', cwd: temp, dryRun: true };

  await assert.rejects(service.run({ ...base, agent: 'backend-engineer', permissionMode: 'auto', browserMode: 'repository' }), /ui-designer, frontend-engineer, and qa-engineer/);
  await assert.rejects(service.run({ ...base, agent: 'qa-engineer', permissionMode: 'auto', browserMode: 'mcp', browserMcpProfile: 'missing' }), /Unknown browser MCP profile/);
  await assert.rejects(service.run({ ...base, agent: 'qa-engineer', permissionMode: 'auto', browserMode: 'mcp' }), /安装 Playwright MCP/);
  await assert.rejects(service.run({ ...base, agent: 'ui-designer', permissionMode: 'auto', browserMode: 'mcp' }), /UI_DESIGNER_BROWSER_MCP_CONFIGS_JSON/);
  await assert.rejects(service.run({ ...base, agent: 'qa-engineer', permissionMode: 'auto', browserMode: 'repository' }), /npm install -D @playwright\/test/);
  fs.mkdirSync(path.join(temp, 'node_modules', '@playwright', 'test'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'node_modules', '@playwright', 'test', 'package.json'), '{"name":"@playwright/test","main":"index.js"}');
  fs.writeFileSync(path.join(temp, 'node_modules', '@playwright', 'test', 'index.js'), 'export {};');
  fs.writeFileSync(path.join(temp, 'package.json'), '{"devDependencies":{"@playwright/test":"1.0.0"}}');
  const automatic = await service.run({ ...base, agent: 'qa-engineer', permissionMode: 'auto', browserMode: 'repository' });
  assert.equal(automatic.runtime.permissionMode, 'auto');
  assert.equal(automatic.runtime.browserPurpose, 'independent-e2e');
  assert.match(automatic.promptPreview, /purpose="independent-e2e"/);
  assert.equal(automatic.args.includes('--dangerously-skip-permissions'), false);
  const ui = await service.run({ ...base, agent: 'ui-designer', permissionMode: 'auto', browserMode: 'repository' });
  assert.equal(ui.runtime.browserPurpose, 'visual-validation');
  assert.match(ui.promptPreview, /Automated assertions are required only/);
  const frontend = await service.run({ ...base, agent: 'frontend-engineer', permissionMode: 'auto', browserMode: 'repository' });
  assert.equal(frontend.runtime.browserPurpose, 'implementation-validation');
  assert.match(frontend.promptPreview, /browser console failures/);
  const bypass = await service.run({ ...base, agent: 'qa-engineer', permissionMode: 'bypassPermissions', browserMode: 'repository' });
  assert.equal(bypass.runtime.browserMode, 'repository');
  assert.equal(bypass.runtime.permissionMode, 'bypassPermissions');
  assert.equal(bypass.args.includes('--dangerously-skip-permissions'), true);
});

test('credentials stay in child environment, not CLI arguments', () => {
  const registry = loadAgentRegistry(pluginRoot);
  const agent = resolveAgent(registry, 'backend-engineer');
  const runtime = resolveAgentRuntime({ agent, env: {
    BACKEND_ENGINEER_MODEL: 'sonnet',
    BACKEND_ENGINEER_EFFORT: 'high',
    BACKEND_ENGINEER_PERMISSION_MODE: 'auto',
    BACKEND_ENGINEER_API_KEY: 'top-secret',
    BACKEND_ENGINEER_API_KEY_KIND: 'auth_token',
  }});
  const invocation = buildClaudeInvocation({ pluginRoot, agent, runtime, request: { task: 'x', plan: 'y' } });
  assert.equal(invocation.env.ANTHROPIC_AUTH_TOKEN, 'top-secret');
  assert.equal(invocation.args.join(' ').includes('top-secret'), false);
});

test('bypass permission mode enables Claude dangerous skip flag', () => {
  const registry = loadAgentRegistry(pluginRoot);
  const agent = resolveAgent(registry, 'backend-engineer');
  const runtime = resolveAgentRuntime({ agent, env: {
    BACKEND_ENGINEER_PERMISSION_MODE: 'bypassPermissions',
  }});
  const invocation = buildClaudeInvocation({ pluginRoot, agent, runtime, request: { task: 'x', plan: 'y' } });
  assert.equal(valueAfter(invocation.args, '--permission-mode'), 'bypassPermissions');
  assert.equal(invocation.args.includes('--dangerously-skip-permissions'), true);
});

test('resume and explicit session id cannot be combined', () => {
  const registry = loadAgentRegistry(pluginRoot);
  const agent = resolveAgent(registry, 'backend-engineer');
  const runtime = resolveAgentRuntime({ agent, env: {} });
  assert.throws(() => buildClaudeInvocation({
    pluginRoot, agent, runtime,
    request: { task: 'x', plan: 'y', resume: 'old-session', sessionId: '00000000-0000-4000-8000-000000000000' },
  }), /mutually exclusive/);
});

test('JSON event arrays return only the terminal result summary', () => {
  const output = JSON.stringify([
    { type: 'system', subtype: 'init', session_id: 'session-1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
    { type: 'result', subtype: 'success', result: 'implemented and tested', session_id: 'session-1', total_cost_usd: 1.25, duration_ms: 5000, num_turns: 4 },
  ]);
  const parsed = parseClaudeOutput(output, 'json');
  assert.equal(parsed.text, 'implemented and tested');
  assert.equal(parsed.sessionId, 'session-1');
  assert.equal(parsed.costUsd, 1.25);
  assert.equal(parsed.turns, 4);
  assert.equal(parsed.structured.length, 3);
});

test('stream-json output returns only the terminal result summary', () => {
  const output = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 'session-2' }),
  ].join('\n');
  const parsed = parseClaudeOutput(output, 'stream-json');
  assert.equal(parsed.text, 'done');
  assert.equal(parsed.sessionId, 'session-2');
  assert.equal(parsed.structured.length, 2);
});

test('progress events expose semantic summaries without raw tool input or phase regression', () => {
  const read = classifyProgressEvent({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/secret/project/token.txt' } }] },
  });
  const command = classifyProgressEvent({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer secret-token" https://example.test' } }] },
  });
  const verification = classifyProgressEvent({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
  });
  const textOnly = classifyProgressEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Tests completed.' }] } });

  assert.equal(read.lastToolSummary, '检查文件');
  assert.equal(command.lastToolSummary, '执行命令');
  assert.equal(command.lastToolSummary.includes('secret-token'), false);
  assert.equal(verification.phase, 'verifying');
  assert.equal(verification.lastToolSummary, '运行测试');
  assert.deepEqual(textOnly, { turnObserved: true });
});
