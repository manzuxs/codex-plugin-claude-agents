import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentRegistry, resolveAgent, resolveAgentRuntime } from '../plugins/claude-code-agents/server/lib/agents.mjs';
import { buildClaudeInvocation, parseClaudeOutput } from '../plugins/claude-code-agents/server/lib/claude.mjs';

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
