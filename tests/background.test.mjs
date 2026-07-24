import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ClaudeAgentService, compactResult } from '../plugins/claude-code-agents/server/lib/service.mjs';
import { JobStore } from '../plugins/claude-code-agents/server/lib/job-store.mjs';

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
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'background complete', session_id: '22222222-2222-4222-8222-222222222222' }) + '\\n');
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
      timeoutMs: 120_000,
    });
    assert.equal(created.ok, true);
    assert.equal(created.nextPollSeconds, 30);
    assert.equal(created.pollAttempt, 0);
    assert.equal(created.progressRevision, 0);
    const persistedRequest = service.jobs.readJson(created.jobId, 'request.json');
    assert.equal(persistedRequest.requestedTimeoutMs, 120_000);
    assert.equal(persistedRequest.effectiveTimeoutMs, 1_800_000);
    assert.equal(persistedRequest.timeoutSource, 'configured-protected');
    assert.equal(persistedRequest.runtimeOverrides.timeoutMs, 1_800_000);
    const finished = await waitFor(() => {
      const status = service.status(created.jobId);
      return ['completed', 'failed'].includes(status.status) ? status : null;
    });
    assert.equal(finished.status, 'completed');
    const stored = service.result(created.jobId);
    assert.equal(stored.result.status, 'completed');
    assert.equal(stored.result.summary, 'background complete');
    assert.equal(stored.result.sessionId, '22222222-2222-4222-8222-222222222222');
    assert.equal(stored.result.effectiveTimeoutMs, 1_800_000);
    assert.equal(stored.meta.planSha256, stored.result.planSha256);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }
});

test('stream-json progress is persisted as compact, versioned job state', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-progress-'));
  const dataRoot = path.join(temp, 'data');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, [
    '#!/usr/bin/env node',
    "const events = [{ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] } }, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }, { type: 'result', subtype: 'success', result: 'progress complete', session_id: '55555555-5555-4555-8555-555555555555', num_turns: 2 }];",
    "let index = 0; const timer = setInterval(() => { if (index >= events.length) { clearInterval(timer); return; } process.stdout.write(JSON.stringify(events[index++]) + '\\n'); }, 150);",
  ].join('\n'));
  fs.chmodSync(mock, 0o755);
  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mock;
  try {
    const service = new ClaudeAgentService({ pluginRoot, dataRoot });
    const created = await service.run({ agent: '后端工程师', task: 'Collect progress', plan: '1. Inspect. 2. Verify.', cwd: temp, background: true });
    const observed = await waitFor(() => {
      const status = service.status(created.jobId, { sinceRevision: created.progressRevision, pollAttempt: 0 });
      return status.progressRevision > 0 && ['inspecting', 'verifying', 'completed'].includes(status.phase) ? status : null;
    });
    assert.equal(observed.changedSinceLastPoll, true);
    assert.equal(observed.nextPollSeconds, 60);
    assert.ok(['inspecting', 'verifying', 'completed'].includes(observed.phase));
    assert.ok(observed.lastTool === 'Read' || observed.lastTool === 'Bash');
    assert.equal(typeof observed.lastToolSummary, 'string');
    assert.ok(observed.lastToolSummary.length <= 256);
    const finished = await waitFor(() => {
      const status = service.status(created.jobId, { sinceRevision: observed.progressRevision, pollAttempt: 1 });
      return status.status === 'completed' ? status : null;
    });
    assert.equal(finished.phase, 'completed');
    assert.equal(finished.verificationState, 'passed');
    assert.equal(finished.nextPollSeconds, null);
    assert.equal(service.result(created.jobId).result.summary, 'progress complete');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }
});

test('JobStore increments progressRevision only for visible progress changes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-progress-store-'));
  const store = new JobStore(temp);
  const meta = store.create({ agent: 'backend-engineer', cwd: temp, planSha256: 'abc' });
  const first = store.writeProgress(meta.jobId, { phase: 'inspecting', lastTool: 'Read', turnsObserved: 1, verificationState: 'pending' });
  const same = store.writeProgress(meta.jobId, { phase: 'inspecting', lastTool: 'Read', turnsObserved: 1, verificationState: 'pending', elapsedMs: 100 });
  const next = store.writeProgress(meta.jobId, { phase: 'implementing', lastTool: 'Write', turnsObserved: 1, verificationState: 'pending' });
  assert.equal(first.progressRevision, 1);
  assert.equal(same.progressRevision, 1);
  assert.equal(next.progressRevision, 2);
});

test('JobStore preserves concurrent metadata patches across processes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-concurrent-store-'));
  const store = new JobStore(temp);
  const meta = store.create({ agent: 'backend-engineer', cwd: temp, planSha256: 'concurrent' });
  const moduleUrl = pathToFileURL(path.join(pluginRoot, 'server', 'lib', 'job-store.mjs')).href;
  const runWriter = (key) => new Promise((resolve, reject) => {
    const script = `
      import { JobStore } from ${JSON.stringify(moduleUrl)};
      const store = new JobStore(${JSON.stringify(temp)});
      for (let index = 0; index < 200; index += 1) store.writeMeta(${JSON.stringify(meta.jobId)}, { [${JSON.stringify(key)}]: index });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `writer exited ${code}`)));
  });
  await Promise.all([runWriter('writerA'), runWriter('writerB')]);
  const stored = store.get(meta.jobId);
  assert.equal(stored.writerA, 199);
  assert.equal(stored.writerB, 199);
});

test('adaptive polling backs off at 60, 120, and 180 seconds', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-polling-'));
  const service = new ClaudeAgentService({ pluginRoot, dataRoot: path.join(temp, 'data') });
  const meta = service.jobs.create({ agent: 'backend-engineer', cwd: temp, planSha256: 'poll-plan' });
  service.jobs.writeMeta(meta.jobId, { status: 'running', startedAt: new Date().toISOString() });
  assert.equal(service.status(meta.jobId, { sinceRevision: 0, pollAttempt: 0 }).nextPollSeconds, 60);
  assert.equal(service.status(meta.jobId, { sinceRevision: 0, pollAttempt: 1 }).nextPollSeconds, 120);
  assert.equal(service.status(meta.jobId, { sinceRevision: 0, pollAttempt: 2 }).nextPollSeconds, 180);
  service.jobs.writeProgress(meta.jobId, { phase: 'verifying', verificationState: 'running' });
  const changed = service.status(meta.jobId, { sinceRevision: 0, pollAttempt: 2 });
  assert.equal(changed.changedSinceLastPoll, true);
  assert.equal(changed.nextPollSeconds, 60);
});

test('worker activity renews a background lease while idle sessions expire', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-heartbeat-'));
  const dataRoot = path.join(temp, 'data');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, [
    '#!/usr/bin/env node',
    "setInterval(() => process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] } }) + '\\n'), 100);",
  ].join('\n'));
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
    await waitFor(() => service.jobs.get(created.jobId).status === 'running');
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.ok(['starting', 'running'].includes(service.jobs.get(created.jobId).status));
    service.cancel(created.jobId, 'test_finished');
    const stopped = await waitFor(() => {
      const status = service.jobs.get(created.jobId);
      return status.status === 'cancelled' ? status : null;
    }, 3000);
    assert.equal(stopped.cancellationReason, 'test_finished');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }
});

test('job wait blocks inside the service and returns one compact terminal result', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-job-wait-'));
  const dataRoot = path.join(temp, 'data');
  const mock = path.join(temp, 'claude-mock.mjs');
  fs.writeFileSync(mock, [
    '#!/usr/bin/env node',
    "setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'wait complete', session_id: 'wait-session', num_turns: 2 }) + '\\n'), 150);",
  ].join('\n'));
  fs.chmodSync(mock, 0o755);
  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mock;
  try {
    const service = new ClaudeAgentService({ pluginRoot, dataRoot });
    const created = await service.run({
      agent: '后端工程师',
      task: 'Wait in the service',
      plan: '1. Run the mock.',
      cwd: temp,
      background: true,
    });
    const waited = await service.wait(created.jobId, { timeoutMs: 3000 });
    assert.equal(waited.meta.status, 'completed');
    assert.equal(waited.result.summary, 'wait complete');
    assert.equal(waited.result.structured, undefined);
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

test('compact status and result enforce their byte limits for oversized metadata', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-hard-cap-'));
  const service = new ClaudeAgentService({ pluginRoot, dataRoot: path.join(temp, 'data') });
  const meta = service.jobs.create({ agent: 'backend-engineer', cwd: temp, planSha256: 'cap' });
  service.jobs.writeMeta(meta.jobId, { status: 'failed', error: 'E'.repeat(12_000) });
  service.jobs.writeResult(meta.jobId, { ok: false, sessionId: 'S'.repeat(9000), error: 'failure' });

  const status = service.status(meta.jobId);
  const result = service.result(meta.jobId);
  assert.ok(Buffer.byteLength(JSON.stringify(status), 'utf8') <= 2048);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 8192);

  for (let index = 0; index < 20; index += 1) {
    const listed = service.jobs.create({ agent: 'backend-engineer', cwd: temp, planSha256: String(index) });
    service.jobs.writeMeta(listed.jobId, { status: 'failed', error: 'L'.repeat(4000) });
  }
  assert.ok(Buffer.byteLength(JSON.stringify(service.status(undefined, { limit: 20 })), 'utf8') <= 8192);
});

test('compact failed results prioritize the actionable error over streamed output', () => {
  const compact = compactResult({
    ok: false,
    timedOut: true,
    error: 'Grok CLI exceeded the effective timeout of 3600000ms.',
    text: '{"type":"thought","data":"partial output"}',
  });
  assert.equal(compact.summary, 'Grok CLI exceeded the effective timeout of 3600000ms.');
});

test('oversized agent reports preserve high-priority evidence instead of slicing one text prefix', () => {
  const implementation = Array.from({ length: 120 }, (_, index) => `- Implementation detail ${index}: ${'context '.repeat(8)}`).join('\n');
  const files = Array.from({ length: 50 }, (_, index) => `- src/module-${index}.js: changed behavior ${index}`).join('\n');
  const verification = [
    ...Array.from({ length: 140 }, (_, index) => `- check-${index}: passed with complete integration evidence`),
    '### Type checks',
    '- npm run typecheck: failed with exit 2 because ContractResult is incompatible',
  ].join('\n');
  const risks = Array.from({ length: 40 }, (_, index) => `- Residual risk ${index}: requires follow-up decision`).join('\n');
  const report = [
    '## Implementation summary', implementation,
    '## Files changed', files,
    '## Verification evidence', verification,
    '## Unfinished items and risks', risks,
    '## Recommended next stage', '- Fix the type contract and rerun validation.',
    '## Outcome', 'partially completed',
  ].join('\n');

  const compact = compactResult({ ok: false, status: 'failed', agent: 'backend-engineer', jobId: 'claude-evidence', text: report });
  assert.ok(Buffer.byteLength(JSON.stringify(compact), 'utf8') <= 8192);
  assert.equal(compact.evidenceStructured, true);
  assert.match(compact.verificationSummary, /typecheck: failed with exit 2/);
  assert.match(compact.unfinishedItemsAndRisks, /Residual risk/);
  assert.match(compact.filesChanged, /src\/module-0\.js/);
  assert.equal(compact.outcome, 'partially completed');
  assert.ok(compact.evidenceOmissions.summary > 0);
  assert.ok(compact.evidenceOmissions.verificationSummary > 0);

  const shortReport = '## Implementation summary\nDone.\n## Verification evidence\n- npm test: passed';
  const short = compactResult({ ok: true, text: shortReport });
  assert.equal(short.evidenceStructured, undefined);
  assert.equal(short.summary, shortReport);
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
setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'persistent complete' }) + '\\n'), 100);
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

test('a second service instance can cancel a persisted foreground runner process', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-cross-cancel-'));
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

  const previous = {
    bin: process.env.CLAUDE_BIN,
    started: process.env.MOCK_STARTED_PATH,
    stopped: process.env.MOCK_STOPPED_PATH,
  };
  process.env.CLAUDE_BIN = mock;
  process.env.MOCK_STARTED_PATH = startedFile;
  process.env.MOCK_STOPPED_PATH = stoppedFile;
  try {
    const owner = new ClaudeAgentService({ pluginRoot, dataRoot });
    const running = owner.run({
      agent: '后端工程师',
      task: 'Wait for cross-instance cancellation',
      plan: '1. Wait. 2. Be cancelled.',
      cwd: temp,
    });
    await waitFor(() => fs.existsSync(startedFile));
    const active = await waitFor(() => owner.jobs.list(1).find((meta) => meta.runnerPid));
    assert.equal(active.status, 'running');

    const observer = new ClaudeAgentService({ pluginRoot, dataRoot });
    const cancelled = observer.cancel(active.jobId, 'user_requested');
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.signalled, true);
    await waitFor(() => fs.existsSync(stoppedFile));

    const result = await running;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.cancelled, true);
    assert.equal(owner.jobs.get(active.jobId).status, 'cancelled');
  } finally {
    for (const [key, value] of Object.entries({ CLAUDE_BIN: previous.bin, MOCK_STARTED_PATH: previous.started, MOCK_STOPPED_PATH: previous.stopped })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('orphan reconciliation closes dead active jobs without touching live or persistent jobs', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-orphans-'));
  const service = new ClaudeAgentService({ pluginRoot, dataRoot: path.join(temp, 'data') });
  const create = (task) => service.jobs.create({ agent: 'backend-engineer', task, cwd: temp, planSha256: task });
  const dead = create('dead');
  service.jobs.writeMeta(dead.jobId, { status: 'running', startedAt: new Date(0).toISOString(), mode: 'foreground', runnerPid: 999_999_999 });
  const live = create('live');
  service.jobs.writeMeta(live.jobId, { status: 'running', startedAt: new Date(0).toISOString(), mode: 'foreground', runnerPid: process.pid });
  const persistent = create('persistent');
  service.jobs.writeMeta(persistent.jobId, { status: 'running', startedAt: new Date(0).toISOString(), mode: 'foreground', runnerPid: 999_999_998, persistOnDisconnect: true });

  const reconciled = service.reconcileOrphans({ graceMs: 0 });
  assert.deepEqual(reconciled.reconciled, [dead.jobId]);
  assert.equal(service.jobs.get(dead.jobId).status, 'cancelled');
  assert.equal(service.jobs.get(dead.jobId).cancellationReason, 'orphaned_process');
  assert.equal(service.jobs.get(live.jobId).status, 'running');
  assert.equal(service.jobs.get(persistent.jobId).status, 'running');
});
