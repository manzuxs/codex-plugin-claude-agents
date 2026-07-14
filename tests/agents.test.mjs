import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentRegistry, resolveAgent, resolveAgentRuntime } from '../plugins/claude-code-agents/server/lib/agents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'claude-code-agents');

test('registry resolves Chinese and English aliases', () => {
  const registry = loadAgentRegistry(root);
  assert.equal(resolveAgent(registry, '后端工程师').id, 'backend-engineer');
  assert.equal(resolveAgent(registry, 'UI designer').id, 'ui-designer');
});

test('runtime uses agent-specific settings over defaults', () => {
  const registry = loadAgentRegistry(root);
  const agent = resolveAgent(registry, 'backend-engineer');
  const runtime = resolveAgentRuntime({
    agent,
    env: {
      CLAUDE_DEFAULT_MODEL: 'default-model',
      BACKEND_ENGINEER_MODEL: 'backend-model',
      BACKEND_ENGINEER_EFFORT: 'medium',
      BACKEND_ENGINEER_PERMISSION_MODE: 'auto',
    },
  });
  assert.equal(runtime.model, 'backend-model');
  assert.equal(runtime.effort, 'medium');
  assert.equal(runtime.permissionMode, 'auto');
});


test('runtime rejects flags absent from the supplied Claude CLI help', () => {
  const registry = loadAgentRegistry(root);
  const agent = resolveAgent(registry, 'backend-engineer');
  assert.throws(() => resolveAgentRuntime({ agent, env: { BACKEND_ENGINEER_EFFORT: 'ultracode' } }), /effort must be one of/);
  assert.throws(() => resolveAgentRuntime({ agent, env: { BACKEND_ENGINEER_PERMISSION_MODE: 'manual' } }), /permission mode must be one of/);
});
