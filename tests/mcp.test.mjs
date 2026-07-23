import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDashboard } from '../plugins/claude-code-agents/server/dashboard.mjs';
import { JobStore } from '../plugins/claude-code-agents/server/lib/job-store.mjs';
import { PLUGIN_VERSION } from '../plugins/claude-code-agents/server/lib/version.mjs';

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

test('dashboard enforces token, body, static path, task API, and SSE boundaries', async () => {
  const agent = { id: 'backend-engineer', name: '后端工程师', prefix: 'BACKEND_ENGINEER' };
  let capturedRun;
  const service = {
    registry: { byId: new Map([[agent.id, agent]]), byAlias: new Map() },
    config: {
      filePath: '/tmp/claude-agents.sqlite',
      effectiveFor: () => ({ model: 'sonnet' }),
    },
    jobs: {
      readEvents: () => ({ events: [{ seq: 1, type: 'system', subtype: 'init' }], cursor: 1 }),
    },
    listAgents: () => [agent],
    runtimeFor: () => ({}),
    status: (jobId) => jobId ? { jobId, status: 'completed' } : [],
    writeAgentConfig: () => ({ database: '/tmp/claude-agents.sqlite' }),
    run: async (input) => { capturedRun = input; return { ok: true, jobId: 'job-1', status: 'starting' }; },
    cancel: (jobId) => ({ ok: true, jobId, status: 'cancelled' }),
    deleteJob: (jobId) => ({ ok: true, jobId }),
    result: (jobId) => ({ meta: { jobId, status: 'completed' }, result: { summary: 'done' } }),
  };
  const running = await startDashboard({ pluginRoot, service });
  try {
    const page = await fetch(running.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    const token = (await page.text()).match(/dashboard-token" content="([^"]+)"/)?.[1];
    assert.ok(token);

    const unauthorized = await fetch(`${running.url}/api/bootstrap`);
    assert.equal(unauthorized.status, 403);
    assert.equal((await unauthorized.json()).error, 'Invalid dashboard token.');

    const missing = await fetch(`${running.url}/missing.js`);
    assert.equal(missing.status, 404);
    const traversal = await fetch(`${running.url}/%2e%2e/server/index.mjs`);
    assert.equal(traversal.status, 404);

    const invalidJson = await fetch(`${running.url}/api/config`, {
      method: 'POST',
      headers: { 'x-claude-agents-token': token, 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(invalidJson.status, 400);
    assert.match((await invalidJson.json()).error, /valid JSON/);

    const oversized = await fetch(`${running.url}/api/config`, {
      method: 'POST',
      headers: { 'x-claude-agents-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: agent.id, values: { model: 'x'.repeat(256 * 1024) } }),
    });
    assert.equal(oversized.status, 400);
    assert.match((await oversized.json()).error, /too large/);

    const config = await fetch(`${running.url}/api/config`, {
      method: 'POST',
      headers: { 'x-claude-agents-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: agent.id, values: { model: 'sonnet' } }),
    });
    assert.equal(config.status, 200);

    const run = await fetch(`${running.url}/api/run`, {
      method: 'POST',
      headers: { 'x-claude-agents-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: agent.id, task: 'run', plan: 'inspect', cwd: root }),
    });
    assert.equal(run.status, 200);
    assert.equal((await run.json()).jobId, 'job-1');
    assert.equal(capturedRun.background, true);
    assert.equal(capturedRun.outputFormat, 'stream-json');

    const events = await fetch(`${running.url}/api/jobs/job-1/events`, { headers: { 'x-claude-agents-token': token } });
    assert.equal(events.status, 200);
    assert.equal((await events.json()).events.length, 1);
    const result = await fetch(`${running.url}/api/jobs/job-1/result`, { headers: { 'x-claude-agents-token': token } });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).result.summary, 'done');
    const cancel = await fetch(`${running.url}/api/jobs/job-1/cancel`, { method: 'POST', headers: { 'x-claude-agents-token': token } });
    assert.equal(cancel.status, 200);
    const deleted = await fetch(`${running.url}/api/jobs/job-1`, { method: 'DELETE', headers: { 'x-claude-agents-token': token } });
    assert.equal(deleted.status, 200);

    const deniedStream = await fetch(`${running.url}/api/jobs/job-1/stream?token=wrong`);
    assert.equal(deniedStream.status, 403);
    const stream = await fetch(`${running.url}/api/jobs/job-1/stream?token=${encodeURIComponent(token)}`);
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event|data:/);
    await reader.cancel();
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
  assert.equal(messages.find((m) => m.id === 1)?.result?.serverInfo?.version, PLUGIN_VERSION);
  const tools = messages.find((m) => m.id === 2)?.result?.tools || [];
  const runAgent = tools.find((tool) => tool.name === 'run_agent');
  assert.ok(runAgent);
  assert.equal(runAgent.inputSchema.properties.persistOnDisconnect.default, false);
  assert.equal(runAgent.inputSchema.properties.leaseTimeoutMs.default, 300000);
  assert.equal(runAgent.inputSchema.properties.leaseTimeoutMs.description.includes('Worker activity'), true);
  const jobStatus = tools.find((tool) => tool.name === 'job_status');
  assert.equal(jobStatus.description.includes('read-only'), true);
  const jobWait = tools.find((tool) => tool.name === 'job_wait');
  assert.ok(jobWait);
  assert.equal(jobWait.inputSchema.properties.timeout_ms.default, 2100000);
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

test('background MCP flow exposes progress and adaptive polling hints', async (t) => {
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
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000)),
    ]);
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

  let terminal;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const requestId = 320 + attempt;
    send({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: 'job_status', arguments: {
      job_id: initial.jobId, since_progress_revision: progress.progressRevision, poll_attempt: progress.pollAttempt,
    } } });
    const terminalResponse = await waitFor(() => messages.find((message) => message.id === requestId), 3000);
    terminal = JSON.parse(terminalResponse.result.content[0].text);
    if (terminal.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.phase, 'completed');
  assert.equal(terminal.nextPollSeconds, null);

  send({ jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'job_result', arguments: { job_id: initial.jobId } } });
  const resultResponse = await waitFor(() => messages.find((message) => message.id === 33), 3000);
  const result = JSON.parse(resultResponse.result.content[0].text);
  assert.equal(result.result.summary, 'background mcp complete');
});

test('job_wait returns one terminal result without Codex polling', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-mcp-wait-'));
  const dataRoot = path.join(temp, 'data');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, [
    '#!/usr/bin/env node',
    "setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'server waited', session_id: '77777777-7777-4777-8777-777777777777', num_turns: 1 }) + '\\n'), 150);",
  ].join('\n'));
  fs.chmodSync(mock, 0o755);
  const child = spawn(process.execPath, [server], {
    cwd: root,
    env: { ...process.env, ...isolatedEnv('wait', { CLAUDE_BIN: mock, CLAUDE_AGENTS_DATA_ROOT: dataRoot }) },
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
  send({ jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'run_agent', arguments: {
    agent: '后端工程师', task: 'Run and wait in the server', plan: '1. Run the mock.', cwd: temp, background: true,
  } } });
  const started = await waitFor(() => messages.find((message) => message.id === 50), 3000);
  const initial = JSON.parse(started.result.content[0].text);
  send({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'job_wait', arguments: {
    job_id: initial.jobId, timeout_ms: 3000,
  } } });
  const waited = await waitFor(() => messages.find((message) => message.id === 51), 5000);
  child.kill('SIGTERM');
  const result = JSON.parse(waited.result.content[0].text);
  assert.equal(result.meta.status, 'completed');
  assert.equal(result.result.summary, 'server waited');
  assert.equal(result.result.structured, undefined);
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

test('closing the MCP session cancels an active foreground runner process', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-mcp-foreground-disconnect-'));
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
    env: { ...isolatedEnv('foreground-disconnect'), CLAUDE_BIN: mock, CLAUDE_AGENTS_DATA_ROOT: dataRoot, MOCK_STARTED_PATH: startedFile, MOCK_STOPPED_PATH: stoppedFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'run_agent', arguments: {
      agent: '后端工程师', task: 'Stop foreground work with the MCP session', plan: '1. Wait for disconnect.', cwd: temp, background: false,
    } } }) + '\n');
    await waitFor(() => fs.existsSync(startedFile), 3000);
    child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MCP server did not exit after stdin closed')), 5000)),
    ]);

    const store = new JobStore(dataRoot);
    try {
      const stopped = await waitFor(() => {
        const [latest] = store.list(1);
        return latest?.status === 'cancelled' ? latest : null;
      }, 3000);
      assert.equal(stopped.cancellationReason, 'mcp_stdin_closed');
      await waitFor(() => fs.existsSync(stoppedFile), 3000);
    } finally {
      store.close();
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
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
