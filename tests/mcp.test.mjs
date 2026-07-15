import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(root, 'plugins', 'claude-code-agents');
const server = path.join(pluginRoot, 'server', 'index.mjs');

function waitFor(predicate, timeoutMs = 1500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('Timed out waiting for MCP response'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('plugin MCP manifest launches from its installed root', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  const config = manifest.mcpServers.claude_code_agents;
  assert.equal(config.cwd, '.');
  assert.deepEqual(config.args, ['./server/index.mjs']);
  assert.equal(config.tool_timeout_sec, 2100);

  const child = spawn(config.command, config.args, {
    cwd: path.resolve(pluginRoot, config.cwd),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
  const response = await waitFor(() => messages.find((message) => message.id === 1));
  child.kill('SIGTERM');
  assert.ok(response.result.tools.some((tool) => tool.name === 'run_agent'));
});

test('MCP server initializes, lists tools, and performs a dry-run delegation', async () => {
  const child = spawn(process.execPath, [server], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  send({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'run_agent',
      arguments: {
        agent: '后端工程师',
        task: 'Validate delegation',
        plan: '1. Inspect repository. 2. Make no changes. 3. Report.',
        cwd: root,
        dryRun: true,
      },
    },
  });
  await waitFor(() => messages.find((m) => m.id === 3));
  child.kill('SIGTERM');
  assert.equal(stderr, '');
  assert.equal(messages.find((m) => m.id === 1)?.result?.serverInfo?.name, 'claude-code-agents');
  const tools = messages.find((m) => m.id === 2)?.result?.tools || [];
  const runAgent = tools.find((tool) => tool.name === 'run_agent');
  assert.ok(runAgent);
  assert.equal(runAgent.inputSchema.properties.persistOnDisconnect.default, false);
  assert.equal(runAgent.inputSchema.properties.leaseTimeoutMs.default, 90000);
  assert.equal(runAgent.inputSchema.properties.leaseTimeoutMs.description.includes('job_status'), false);
  assert.ok(tools.some((tool) => tool.name === 'list_agents'));
  const toolText = messages.find((m) => m.id === 3)?.result?.content?.[0]?.text;
  const dryRun = JSON.parse(toolText);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.agent, 'backend-engineer');
});

test('MCP cancellation notification stops an active run_agent request', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-mcp-cancel-'));
  const startedFile = path.join(temp, 'started');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.env.MOCK_STARTED_PATH, 'started');
setInterval(() => {}, 1000);
`);
  fs.chmodSync(mock, 0o755);

  const child = spawn(process.execPath, [server], {
    cwd: root,
    env: { ...process.env, CLAUDE_BIN: mock, MOCK_STARTED_PATH: startedFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  send({
    jsonrpc: '2.0', id: 10, method: 'tools/call', params: {
      name: 'run_agent',
      arguments: {
        agent: '后端工程师',
        task: 'Wait until Codex cancels',
        plan: '1. Wait for cancellation.',
        cwd: temp,
      },
    },
  });
  await waitFor(() => fs.existsSync(startedFile));
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 10, reason: 'user stopped' } });
  const response = await waitFor(() => messages.find((message) => message.id === 10), 3000);
  child.kill('SIGTERM');
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.status, 'cancelled');
  assert.ok(result.jobId);
  assert.equal(result.structured, undefined);
});

test('foreground MCP run returns one compact result and stores full diagnostics locally', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-mcp-foreground-'));
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, [
    '#!/usr/bin/env node',
    "process.stdout.write(JSON.stringify({ result: 'x'.repeat(12000), session_id: '44444444-4444-4444-8444-444444444444', num_turns: 4, structured: { raw: 'local-only' } }));",
  ].join('\n'));
  fs.chmodSync(mock, 0o755);
  const child = spawn(process.execPath, [server], {
    cwd: root,
    env: { ...process.env, CLAUDE_BIN: mock },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: {
    name: 'run_agent',
    arguments: { agent: '后端工程师', task: 'Complete a foreground task', plan: '1. Run the mock.', cwd: temp },
  } }) + '\n');
  const response = await waitFor(() => messages.find((message) => message.id === 20), 3000);
  const result = JSON.parse(response.result.content[0].text);
  child.kill('SIGTERM');
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, '44444444-4444-4444-8444-444444444444');
  assert.equal(result.structured, undefined);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(response.result.content[0].text, 'utf8') <= 8192);
});
