import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('runtime accepts only named browser MCP profiles with absolute config paths', () => {
  const registry = loadAgentRegistry(root);
  const agent = resolveAgent(registry, 'qa-engineer');
  const runtime = resolveAgentRuntime({
    agent,
    env: {
      CLAUDE_BROWSER_MCP_CONFIGS_JSON: '{"shared":"/tmp/shared-mcp.json"}',
      QA_ENGINEER_BROWSER_MCP_CONFIGS_JSON: '{"playwright":"/tmp/playwright-mcp.json"}',
    },
  });
  assert.deepEqual(runtime.browserMcpConfigs, {
    shared: '/tmp/shared-mcp.json',
    playwright: '/tmp/playwright-mcp.json',
  });
  assert.throws(() => resolveAgentRuntime({
    agent,
    env: { QA_ENGINEER_BROWSER_MCP_CONFIGS_JSON: '{"playwright":"relative.json"}' },
  }), /absolute config file path/);
});

test('agent prompts govern output size and fixed evidence reporting', () => {
  const agentDir = path.join(root, 'agents');
  const files = fs.readdirSync(agentDir).filter((file) => file.endsWith('.xml'));
  assert.equal(files.length, 8);
  for (const file of files) {
    const xml = fs.readFileSync(path.join(agentDir, file), 'utf8');
    assert.match(xml, /head -c 4000/);
    assert.match(xml, /Implementation summary/);
    assert.match(xml, /Use these exact Markdown headings in order/);
    assert.match(xml, /Verification evidence/);
    assert.match(xml, /Unfinished items and risks/);
  }
});

test('QA prompt treats required real-browser execution as a strict completion gate', () => {
  const xml = fs.readFileSync(path.join(root, 'agents', 'qa-engineer.xml'), 'utf8');
  assert.match(xml, /real browser ran the required paths/);
  assert.match(xml, /Code inspection, API tests, unit tests/);
  assert.match(xml, /partially completed or blocked/);
  assert.match(xml, /do not install browser dependencies without user approval/);
});

test('orchestrator requires adaptive background polling and editable stage continuation', () => {
  const skill = fs.readFileSync(path.join(root, 'skills', 'claude-orchestrator', 'SKILL.md'), 'utf8');
  assert.match(skill, /background=true/);
  assert.match(skill, /nextPollSeconds/);
  assert.match(skill, /30.*60.*120.*180/);
  assert.match(skill, /background=false/);
  assert.match(skill, /静默等待/);
  assert.match(skill, /下一阶段执行计划/);
  assert.match(skill, /新任务提示/);
  assert.match(skill, /无变化时.*不输出/);
});
