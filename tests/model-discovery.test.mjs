import test from 'node:test';
import assert from 'node:assert/strict';
import {
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

test('Dashboard exposes only meaningful Runner fields and model efforts', () => {
  const codex = RUNNER_CAPABILITIES.codex.supports;
  assert.equal(codex.defaultModel, '');
  assert.equal(RUNNER_CAPABILITIES.grok.supports.defaultModel, '');
  assert.deepEqual([...visibleConfigFields(codex, 'backend-engineer')], ['model', 'effort', 'permissionMode', 'timeoutMs']);
  assert.deepEqual(effortOptionsForModel(codex, { supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }), [
    'default', 'low', 'medium', 'high', 'xhigh', 'max',
  ]);
  assert.deepEqual(capabilityOptions(RUNNER_CAPABILITIES.agy.supports, 'permissionMode'), ['acceptEdits', 'bypassPermissions', 'plan']);
  assert.equal(visibleConfigFields(RUNNER_CAPABILITIES.claude.supports, 'backend-engineer').has('browserMcpConfigsJson'), false);
  assert.equal(visibleConfigFields(RUNNER_CAPABILITIES.claude.supports, 'frontend-engineer').has('browserMcpConfigsJson'), true);
});
