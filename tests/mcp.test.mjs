import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'plugins', 'claude-code-agents', 'server', 'index.mjs');

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
  assert.ok(tools.some((tool) => tool.name === 'run_agent'));
  assert.ok(tools.some((tool) => tool.name === 'list_agents'));
  const toolText = messages.find((m) => m.id === 3)?.result?.content?.[0]?.text;
  const dryRun = JSON.parse(toolText);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.agent, 'backend-engineer');
});
