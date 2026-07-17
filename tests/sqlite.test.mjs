import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../plugins/claude-code-agents/server/lib/config-store.mjs';
import { JobStore } from '../plugins/claude-code-agents/server/lib/job-store.mjs';

test('SQLite config store writes agent settings without returning secret values', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-sqlite-config-'));
  const store = new ConfigStore(dataRoot);
  const result = store.writeAgentConfig({ agent: { prefix: 'BACKEND_ENGINEER' }, values: { model: 'sqlite-sonnet', effort: 'high', apiKey: 'secret-value' } });
  assert.equal(result.ok, true);
  assert.equal(store.toEnv().BACKEND_ENGINEER_MODEL, 'sqlite-sonnet');
  assert.equal(store.toEnv().BACKEND_ENGINEER_API_KEY, 'secret-value');
  assert.match(store.filePath, /claude-agents\.sqlite$/);
  const mode = fs.statSync(store.filePath).mode & 0o777;
  assert.equal(mode, 0o600);
  const effective = store.effectiveFor({ prefix: 'BACKEND_ENGINEER' }, { model: 'sqlite-sonnet', effort: 'high', permissionMode: 'auto', timeoutMs: 10, maxBudgetUsd: 0, gatewayUrl: '', apiKeyKind: 'auth_token', outputFormat: 'json', apiKey: 'secret-value' });
  assert.equal(effective.apiKeyConfigured, true);
  assert.equal(JSON.stringify(effective).includes('secret-value'), false);
});

test('SQLite config store rejects invalid dashboard values and round-trips browser profiles', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-sqlite-validation-'));
  const store = new ConfigStore(dataRoot);
  const agent = { prefix: 'FRONTEND_ENGINEER' };
  assert.throws(() => store.writeAgentConfig({ agent, values: { timeoutMs: -1 } }), /timeoutMs/);
  assert.throws(() => store.writeAgentConfig({ agent, values: { gatewayUrl: 'file:///tmp/gateway' } }), /http\(s\)/);
  assert.throws(() => store.writeAgentConfig({ agent, values: { browserMcpConfigsJson: '[]' } }), /JSON object/);
  store.writeAgentConfig({ agent, values: { outputFormat: 'stream-json', browserMcpConfigsJson: '{"playwright":"/tmp/mcp.json"}' } });
  assert.equal(store.toEnv().FRONTEND_ENGINEER_OUTPUT_FORMAT, 'stream-json');
  assert.equal(store.toEnv().FRONTEND_ENGINEER_BROWSER_MCP_CONFIGS_JSON, '{"playwright":"/tmp/mcp.json"}');
});

test('SQLite job store keeps ordered stream events and result metadata in one database', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-sqlite-jobs-'));
  const store = new JobStore(dataRoot);
  const job = store.create({ agent: 'backend-engineer', cwd: dataRoot, task: 'stream', planSha256: 'sha' });
  store.appendEvent(job.jobId, { type: 'system', subtype: 'init' });
  store.appendEvent(job.jobId, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } });
  store.writeResult(job.jobId, { ok: true, summary: 'done' });
  const page = store.readEvents(job.jobId, { after: 0 });
  assert.equal(page.events.length, 2);
  assert.ok(page.events[0].seq < page.events[1].seq);
  assert.equal(store.result(job.jobId).result.summary, 'done');
  assert.equal(fs.existsSync(path.join(dataRoot, 'jobs')), false);
  assert.match(store.filePath, /claude-agents\.sqlite$/);
});

test('SQLite job store deletes inactive sessions together with their events', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-sqlite-delete-'));
  const store = new JobStore(dataRoot);
  const job = store.create({ agent: 'backend-engineer', cwd: dataRoot, task: 'delete me', planSha256: 'sha' });
  store.appendEvent(job.jobId, { type: 'system', subtype: 'init' });
  store.writeMeta(job.jobId, { status: 'completed' });
  assert.deepEqual(store.delete(job.jobId), { ok: true, jobId: job.jobId });
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.get(job.jobId), /Job not found/);
});
