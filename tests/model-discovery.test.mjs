import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverRunnerModels,
  parseAgyModels,
  parseClaudeModelExamples,
  parseCodexModels,
  parseGrokModels,
} from '../plugins/claude-code-agents/server/lib/runners/model-discovery.mjs';
import {
  capabilityOptions,
  effortOptionsForModel,
  visibleConfigFields,
} from '../plugins/claude-code-agents/dashboard/dashboard-config.mjs';
import { RUNNER_CAPABILITIES } from '../plugins/claude-code-agents/server/lib/runners/capabilities.mjs';

test('Runner model parsers preserve real IDs and default metadata', () => {
  assert.deepEqual(parseGrokModels(`
Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  * grok-code-fast
`).map((model) => [model.id, model.isDefault]), [
    ['grok-4.5', true],
    ['grok-code-fast', false],
  ]);
  assert.deepEqual(parseAgyModels('gemini-3.6-flash-high\nclaude-sonnet-4-6\n').map((model) => model.id), [
    'gemini-3.6-flash-high',
    'claude-sonnet-4-6',
  ]);
  assert.deepEqual(parseClaudeModelExamples(`
  --model <model> Model for the current session. Provide an alias for the latest model
                  (e.g. 'fable', 'opus', or 'sonnet') or a model's full name
                  (e.g. 'claude-fable-5').
  --output-format <format>
`).map((model) => model.id), ['fable', 'opus', 'sonnet', 'claude-fable-5']);
});

test('Codex model parser exposes model-specific reasoning efforts', () => {
  const models = parseCodexModels({
    data: [{
      id: 'gpt-5.6-luna',
      displayName: 'GPT-5.6-Luna',
      description: 'Fast model.',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }],
      defaultReasoningEffort: 'low',
    }],
  });
  assert.deepEqual(models[0], {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6-Luna',
    description: 'Fast model.',
    isDefault: true,
    supportedEfforts: ['low', 'xhigh', 'max'],
    defaultEffort: 'low',
  });
});

test('Codex model discovery injects gateway and temporary API key without using argv for the key', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-model-discovery-'));
  const capture = path.join(temp, 'capture.json');
  const mock = path.join(temp, 'codex-mock.mjs');
  fs.writeFileSync(mock, `#!/usr/bin/env node
import fs from 'node:fs';
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
    if (message.method === 'model/list') {
      fs.writeFileSync(process.env.MOCK_CAPTURE_PATH, JSON.stringify({ args: process.argv.slice(2), key: process.env.CODEX_API_KEY }));
      process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ id: 'gateway-model' }] } }) + '\\n');
    }
  }
});
`);
  fs.chmodSync(mock, 0o755);
  const result = await discoverRunnerModels('codex', {
    codexBin: mock,
    gatewayUrl: 'https://gateway.example/v1',
    apiKey: 'temporary-secret',
    apiKeyKind: 'api_key',
    extraEnv: { MOCK_CAPTURE_PATH: capture },
  }, { cwd: temp });
  const captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.deepEqual(result.models.map((model) => model.id), ['gateway-model']);
  assert.ok(captured.args.includes('openai_base_url="https://gateway.example/v1"'));
  assert.equal(captured.args.includes('temporary-secret'), false);
  assert.equal(captured.key, 'temporary-secret');
});

test('Dashboard exposes only meaningful Runner fields and model efforts', () => {
  const codex = RUNNER_CAPABILITIES.codex.supports;
  assert.equal(codex.defaultModel, '');
  assert.equal(RUNNER_CAPABILITIES.grok.supports.defaultModel, '');
  assert.deepEqual([...visibleConfigFields(codex, 'backend-engineer')], ['model', 'effort', 'permissionMode', 'timeoutMs', 'gatewayUrl', 'apiKey']);
  assert.deepEqual(effortOptionsForModel(codex, { supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }), [
    'default', 'low', 'medium', 'high', 'xhigh', 'max',
  ]);
  assert.deepEqual(capabilityOptions(RUNNER_CAPABILITIES.agy.supports, 'permissionMode'), ['acceptEdits', 'bypassPermissions', 'plan']);
  assert.equal(visibleConfigFields(RUNNER_CAPABILITIES.claude.supports, 'backend-engineer').has('browserMcpConfigsJson'), false);
  assert.equal(visibleConfigFields(RUNNER_CAPABILITIES.claude.supports, 'frontend-engineer').has('browserMcpConfigsJson'), true);
});
