import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDashboard } from '../plugins/claude-code-agents/server/dashboard.mjs';
import { JobStore } from '../plugins/claude-code-agents/server/lib/job-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = process.env.CLAUDE_AGENTS_TEST_PLUGIN_ROOT || path.join(root, 'plugins', 'claude-code-agents');
const server = path.join(pluginRoot, 'server', 'index.mjs');

function isolatedEnv(name, extra = {}) {
  return { ...process.env, CLAUDE_AGENTS_DATA_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), `claude-agent-${name}-`)), ...extra };
}

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
    env: isolatedEnv('manifest'),
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

test('MCP open_dashboard starts the local command center without opening a browser', async () => {
  const child = spawn(process.execPath, [server], { cwd: root, env: isolatedEnv('dashboard'), stdio: ['pipe', 'pipe', 'pipe'] });
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
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'open_dashboard', arguments: { open: false, port: 0 } },
  }) + '\n');
  const response = await waitFor(() => messages.find((message) => message.id === 4), 3000);
  child.kill('SIGTERM');
  assert.equal(stderr, '');
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.ok, true);
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('dashboard serves browser modules with JavaScript MIME types', async () => {
  const running = await startDashboard({ pluginRoot, service: {} });
  try {
    const [app, helper] = await Promise.all([
      fetch(`${running.url}/app.js`),
      fetch(`${running.url}/dashboard-motion.mjs`),
    ]);
    assert.equal(app.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(helper.headers.get('content-type'), 'text/javascript; charset=utf-8');
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
  }
});

test('MCP server initializes, lists tools, and performs a dry-run delegation', async () => {
  const child = spawn(process.execPath, [server], { cwd: root, env: isolatedEnv('dry-run'), stdio: ['pipe', 'pipe', 'pipe'] });
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
  assert.equal(runAgent.inputSchema.properties.leaseTimeoutMs.default, 300000);
  assert.equal(runAgent.inputSchema.properties.leaseTimeoutMs.description.includes('job_status'), true);
  assert.deepEqual(runAgent.inputSchema.properties.browserMode.enum, ['none', 'repository', 'chrome', 'mcp']);
  assert.equal(runAgent.inputSchema.properties.browserMode.default, 'none');
  assert.match(runAgent.inputSchema.properties.browserMode.description, /user-configured permission mode/);
  assert.match(runAgent.inputSchema.properties.browserMode.description, /ui-designer, frontend-engineer, and qa-engineer/);
  assert.match(runAgent.inputSchema.properties.browserMcpProfile.description, /arbitrary config paths are not accepted/);
  assert.ok(tools.some((tool) => tool.name === 'list_agents'));
  const toolText = messages.find((m) => m.id === 3)?.result?.content?.[0]?.text;
  const dryRun = JSON.parse(toolText);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.agent, 'backend-engineer');
});

test('background MCP flow exposes progress and adaptive polling hints', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-mcp-progress-'));
  const dataRoot = path.join(temp, 'data');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, [
    '#!/usr/bin/env node',
    "const events = [{ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] } }, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }, { type: 'result', subtype: 'success', result: 'background mcp complete', session_id: '66666666-6666-4666-8666-666666666666', num_turns: 2 }];",
    "let index = 0; const timer = setInterval(() => { if (index >= events.length) { clearInterval(timer); return; } process.stdout.write(JSON.stringify(events[index++]) + '\\n'); }, 50);",
  ].join('\n'));
  fs.chmodSync(mock, 0o755);
  const child = spawn(process.execPath, [server], {
    cwd: root,
    env: { ...process.env, CLAUDE_BIN: mock, CLAUDE_AGENTS_DATA_ROOT: dataRoot },
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
  send({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'run_agent', arguments: {
    agent: '后端工程师', task: 'Run a background progress check', plan: '1. Inspect. 2. Verify.', cwd: temp, background: true,
  } } });
  const started = await waitFor(() => messages.find((message) => message.id === 30), 3000);
  const initial = JSON.parse(started.result.content[0].text);
  assert.equal(initial.nextPollSeconds, 30);
  assert.equal(initial.pollAttempt, 0);
  assert.equal(initial.progressRevision, 0);

  await new Promise((resolve) => setTimeout(resolve, 350));
  send({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'job_status', arguments: {
    job_id: initial.jobId, since_progress_revision: initial.progressRevision, poll_attempt: initial.pollAttempt,
  } } });
  const progressResponse = await waitFor(() => messages.find((message) => message.id === 31), 3000);
  const progress = JSON.parse(progressResponse.result.content[0].text);
  assert.equal(progress.nextPollSeconds, 60);
  assert.equal(typeof progress.progressRevision, 'number');
  assert.ok(['starting', 'inspecting', 'verifying', 'completed'].includes(progress.phase));
  assert.equal(typeof progress.changedSinceLastPoll, 'boolean');
  assert.equal(typeof progress.verificationState, 'string');

  await new Promise((resolve) => setTimeout(resolve, 700));
  send({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'job_status', arguments: {
    job_id: initial.jobId, since_progress_revision: progress.progressRevision, poll_attempt: progress.pollAttempt,
  } } });
  const terminalResponse = await waitFor(() => messages.find((message) => message.id === 32), 3000);
  const terminal = JSON.parse(terminalResponse.result.content[0].text);
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.phase, 'completed');
  assert.equal(terminal.nextPollSeconds, null);

  send({ jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'job_result', arguments: { job_id: initial.jobId } } });
  const resultResponse = await waitFor(() => messages.find((message) => message.id === 33), 3000);
  const result = JSON.parse(resultResponse.result.content[0].text);
  assert.equal(result.result.summary, 'background mcp complete');
  child.kill('SIGTERM');
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
    env: isolatedEnv('cancel', { CLAUDE_BIN: mock, MOCK_STARTED_PATH: startedFile }),
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

test('closing the MCP session cancels owned background workers', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-mcp-disconnect-'));
  const dataRoot = path.join(temp, 'data');
  const startedFile = path.join(temp, 'started');
  const stoppedFile = path.join(temp, 'stopped');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(process.env.MOCK_STARTED_PATH, 'started');
process.once('SIGTERM', () => { fs.writeFileSync(process.env.MOCK_STOPPED_PATH, 'stopped'); process.exit(0); });
setInterval(() => {}, 1000);
`);
  fs.chmodSync(mock, 0o755);

  const child = spawn(process.execPath, [server], {
    cwd: root,
    env: { ...process.env, ...isolatedEnv('disconnect'), CLAUDE_BIN: mock, CLAUDE_AGENTS_DATA_ROOT: dataRoot, MOCK_STARTED_PATH: startedFile, MOCK_STOPPED_PATH: stoppedFile },
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
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'run_agent', arguments: {
    agent: '后端工程师', task: 'Stop when the MCP session closes', plan: '1. Wait for the MCP session to close.', cwd: temp, background: true, leaseTimeoutMs: 30_000,
  } } }) + '\n');
  const response = await waitFor(() => messages.find((message) => message.id === 40), 3000);
  const created = JSON.parse(response.result.content[0].text);
  await waitFor(() => fs.existsSync(startedFile));
  child.stdin.end();
  await new Promise((resolve) => child.once('close', resolve));

  const store = new JobStore(dataRoot);
  const stopped = await waitFor(() => {
    const status = store.get(created.jobId);
    return status.status === 'cancelled' ? status : null;
  }, 3000);
  assert.equal(stopped.cancellationReason, 'mcp_stdin_closed');
  await waitFor(() => fs.existsSync(stoppedFile));
  store.close();
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
    env: isolatedEnv('foreground', { CLAUDE_BIN: mock }),
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
    arguments: { agent: '后端工程师', task: 'Complete a foreground task', plan: '1. Run the mock.', cwd: temp, background: false },
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
