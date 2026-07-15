import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAgentService } from '../plugins/claude-code-agents/server/lib/service.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'claude-code-agents');

async function waitFor(fn, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Timed out');
}

test('background worker completes and stores the result', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-bg-'));
  const dataRoot = path.join(temp, 'data');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ result: 'background complete', session_id: '22222222-2222-4222-8222-222222222222' }));
`);
  fs.chmodSync(mock, 0o755);

  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mock;
  try {
    const service = new ClaudeAgentService({ pluginRoot, dataRoot });
    const created = await service.run({
      agent: '后端工程师',
      task: 'Apply approved plan',
      plan: '1. Inspect. 2. Implement. 3. Test.',
      cwd: temp,
      background: true,
    });
    assert.equal(created.ok, true);
    assert.equal(created.recommendedPollSeconds, undefined);
    const finished = await waitFor(() => {
      const status = service.status(created.jobId);
      return ['completed', 'failed'].includes(status.status) ? status : null;
    });
    assert.equal(finished.status, 'completed');
    const stored = service.result(created.jobId);
    assert.equal(stored.result.status, 'completed');
    assert.equal(stored.result.summary, 'background complete');
    assert.equal(stored.result.sessionId, '22222222-2222-4222-8222-222222222222');
    assert.equal(stored.meta.planSha256, stored.result.planSha256);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }
});

test('MCP service heartbeat renews a background lease without status polling', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-heartbeat-'));
  const dataRoot = path.join(temp, 'data');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, ['#!/usr/bin/env node', 'setInterval(() => {}, 1000);'].join('\n'));
  fs.chmodSync(mock, 0o755);

  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mock;
  try {
    const service = new ClaudeAgentService({ pluginRoot, dataRoot });
    const created = await service.run({
      agent: '后端工程师',
      task: 'Keep running while MCP is connected',
      plan: '1. Wait for the service heartbeat.',
      cwd: temp,
      background: true,
      leaseTimeoutMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.ok(['starting', 'running'].includes(service.jobs.get(created.jobId).status));
    service.dispose('mcp_disconnected');
    const stopped = await waitFor(() => {
      const status = service.jobs.get(created.jobId);
      return status.status === 'cancelled' ? status : null;
    });
    assert.equal(stopped.cancellationReason, 'mcp_disconnected');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }
});

test('background status and result are compact by default with full diagnostics available', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-compact-'));
  const service = new ClaudeAgentService({ pluginRoot, dataRoot: path.join(temp, 'data') });
  const meta = service.jobs.create({ agent: 'backend-engineer', cwd: temp, planSha256: 'abc' });
  service.jobs.writeMeta(meta.jobId, { status: 'completed', pid: 1234, finishedAt: new Date().toISOString() });
  service.jobs.writeResult(meta.jobId, { ok: true, text: 'x'.repeat(1500), raw: 'raw output', structured: { usage: 'large' } });

  const status = service.status(meta.jobId);
  assert.equal(status.pid, undefined);
  assert.equal(status.status, 'completed');

  const compact = service.result(meta.jobId, { maxTextChars: 1000 });
  assert.equal(compact.result.raw, undefined);
  assert.equal(compact.result.structured, undefined);
  assert.equal(compact.result.truncated, true);
  assert.match(compact.result.summary, /输出已截断/);
  assert.ok(Buffer.byteLength(JSON.stringify(compact.result), 'utf8') <= 8192);

  const full = service.result(meta.jobId, { full: true });
  assert.equal(full.result.raw, 'raw output');
  assert.deepEqual(full.result.structured, { usage: 'large' });

  service.jobs.writeResult(meta.jobId, {
    ok: true,
    text: 'legacy event stream',
    structured: [{ type: 'result', result: 'legacy summary', session_id: 'legacy-session', num_turns: 7 }],
  });
  const legacy = service.result(meta.jobId);
  assert.equal(legacy.result.summary, 'legacy summary');
  assert.equal(legacy.result.sessionId, 'legacy-session');
  assert.equal(legacy.result.turns, 7);
});

test('background worker cancels when its session lease expires', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-lease-'));
  const dataRoot = path.join(temp, 'data');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, `#!/usr/bin/env node
setInterval(() => {}, 1000);
`);
  fs.chmodSync(mock, 0o755);

  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mock;
  try {
    const service = new ClaudeAgentService({ pluginRoot, dataRoot });
    const created = await service.run({
      agent: '后端工程师',
      task: 'Stop after the lease expires',
      plan: '1. Wait for cancellation.',
      cwd: temp,
      background: true,
      leaseTimeoutMs: 1000,
    });
    service.stopLeaseHeartbeat(created.jobId);
    assert.equal(created.persistOnDisconnect, false);
    assert.equal(created.leaseTimeoutMs, 1000);
    const finished = await waitFor(() => {
      const status = service.jobs.get(created.jobId);
      return status.status === 'cancelled' ? status : null;
    });
    assert.equal(finished.cancellationReason, 'lease_expired');
    const stored = service.result(created.jobId, { full: true });
    assert.equal(stored.result.cancelled, true);
    assert.equal(stored.result.cancellationReason, 'lease_expired');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }
});

test('service disposal cancels owned non-persistent background jobs', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-dispose-'));
  const dataRoot = path.join(temp, 'data');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, `#!/usr/bin/env node
setInterval(() => {}, 1000);
`);
  fs.chmodSync(mock, 0o755);

  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mock;
  try {
    const service = new ClaudeAgentService({ pluginRoot, dataRoot });
    const created = await service.run({
      agent: '后端工程师',
      task: 'Stop when MCP disconnects',
      plan: '1. Wait for cancellation.',
      cwd: temp,
      background: true,
      leaseTimeoutMs: 10_000,
    });
    service.dispose('mcp_disconnected');
    const stopped = service.jobs.get(created.jobId);
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.cancellationReason, 'mcp_disconnected');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }
});

test('explicit persistent background jobs survive service disposal', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-persist-'));
  const dataRoot = path.join(temp, 'data');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, `#!/usr/bin/env node
setTimeout(() => process.stdout.write(JSON.stringify({ result: 'persistent complete' })), 100);
`);
  fs.chmodSync(mock, 0o755);

  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mock;
  try {
    const service = new ClaudeAgentService({ pluginRoot, dataRoot });
    const created = await service.run({
      agent: '后端工程师',
      task: 'Complete after MCP disconnects',
      plan: '1. Complete independently.',
      cwd: temp,
      background: true,
      persistOnDisconnect: true,
    });
    service.dispose('mcp_disconnected');
    const finished = await waitFor(() => {
      const status = service.jobs.get(created.jobId);
      return ['completed', 'failed', 'cancelled'].includes(status.status) ? status : null;
    });
    assert.equal(finished.status, 'completed');
    assert.equal(service.result(created.jobId).result.summary, 'persistent complete');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }
});

test('foreground execution stores the full result but exposes a compact view', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-foreground-'));
  const dataRoot = path.join(temp, 'data');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, [
    '#!/usr/bin/env node',
    "process.stdout.write(JSON.stringify({ result: 'foreground complete', verificationSummary: 'npm test: passed', session_id: '33333333-3333-4333-8333-333333333333', num_turns: 2, structured: 'kept locally' }));",
  ].join('\n'));
  fs.chmodSync(mock, 0o755);

  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mock;
  try {
    const service = new ClaudeAgentService({ pluginRoot, dataRoot });
    const value = await service.run({
      agent: '后端工程师',
      task: 'Complete a foreground task',
      plan: '1. Implement. 2. Test.',
      cwd: temp,
    });
    assert.equal(value.status, 'completed');
    assert.ok(value.jobId);
    assert.equal(service.status(value.jobId).status, 'completed');
    const full = service.result(value.jobId, { full: true });
    assert.equal(full.result.structured.structured, 'kept locally');
    const compact = service.result(value.jobId);
    assert.equal(compact.result.summary, 'foreground complete');
    assert.equal(compact.result.verificationSummary, 'npm test: passed');
    assert.equal(compact.result.structured, undefined);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }
});
