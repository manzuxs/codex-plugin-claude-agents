import fs from 'node:fs';
import path from 'node:path';
import { envInteger, envJsonObject, envNumber } from './env.mjs';

const ALLOWED_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const ALLOWED_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan']);
const ALLOWED_OUTPUT_FORMATS = new Set(['text', 'json', 'stream-json']);

export function loadAgentRegistry(pluginRoot) {
  const filePath = path.join(pluginRoot, 'agents', 'agents.json');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed.agents) || parsed.agents.length === 0) {
    throw new Error(`No agents found in ${filePath}`);
  }
  const byId = new Map();
  const byAlias = new Map();
  for (const agent of parsed.agents) {
    if (!/^[a-z][a-z0-9-]*$/.test(agent.id)) throw new Error(`Invalid agent id: ${agent.id}`);
    if (byId.has(agent.id)) throw new Error(`Duplicate agent id: ${agent.id}`);
    byId.set(agent.id, Object.freeze({ ...agent }));
    for (const alias of [agent.id, agent.name, ...(agent.aliases || [])]) {
      const key = normalizeAgentName(alias);
      if (key) byAlias.set(key, agent.id);
    }
  }
  return Object.freeze({ version: parsed.version, agents: [...byId.values()], byId, byAlias });
}

export function normalizeAgentName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

export function resolveAgent(registry, requested) {
  const normalized = normalizeAgentName(requested);
  const id = registry.byId.has(normalized) ? normalized : registry.byAlias.get(normalized);
  if (!id) {
    const options = registry.agents.map((a) => `${a.id}（${a.name}）`).join(', ');
    throw new Error(`Unknown agent "${requested}". Available: ${options}`);
  }
  return registry.byId.get(id);
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value) !== '');
}

function validateChoice(label, value, allowed) {
  if (!allowed.has(value)) throw new Error(`${label} must be one of: ${[...allowed].join(', ')}; received ${value}`);
  return value;
}

export function resolveAgentRuntime({ agent, env, overrides = {} }) {
  const p = agent.prefix;
  const model = String(firstNonEmpty(overrides.model, env[`${p}_MODEL`], env.CLAUDE_DEFAULT_MODEL, 'sonnet'));
  const effort = validateChoice('effort', String(firstNonEmpty(overrides.effort, env[`${p}_EFFORT`], env.CLAUDE_DEFAULT_EFFORT, 'high')), ALLOWED_EFFORT);
  const permissionMode = validateChoice(
    'permission mode',
    String(firstNonEmpty(overrides.permissionMode, env[`${p}_PERMISSION_MODE`], agent.defaultPermissionMode, env.CLAUDE_DEFAULT_PERMISSION_MODE, 'auto')),
    ALLOWED_PERMISSION_MODES,
  );
  const outputFormat = validateChoice(
    'output format',
    String(firstNonEmpty(overrides.outputFormat, env[`${p}_OUTPUT_FORMAT`], env.CLAUDE_DEFAULT_OUTPUT_FORMAT, 'json')),
    ALLOWED_OUTPUT_FORMATS,
  );
  const timeoutMs = overrides.timeoutMs ?? envInteger(env, `${p}_TIMEOUT_MS`, envInteger(env, 'CLAUDE_DEFAULT_TIMEOUT_MS', 1_800_000));
  const maxBudgetUsd = overrides.maxBudgetUsd ?? envNumber(env, `${p}_MAX_BUDGET_USD`, envNumber(env, 'CLAUDE_DEFAULT_MAX_BUDGET_USD', 0));
  const gatewayUrl = String(firstNonEmpty(overrides.gatewayUrl, env[`${p}_GATEWAY_URL`], env.CLAUDE_DEFAULT_GATEWAY_URL, ''));
  const apiKey = String(firstNonEmpty(overrides.apiKey, env[`${p}_API_KEY`], env.CLAUDE_DEFAULT_API_KEY, ''));
  const apiKeyKind = String(firstNonEmpty(overrides.apiKeyKind, env[`${p}_API_KEY_KIND`], env.CLAUDE_DEFAULT_API_KEY_KIND, 'auth_token'));
  if (!['auth_token', 'api_key'].includes(apiKeyKind)) throw new Error('apiKeyKind must be auth_token or api_key');
  const extraEnv = {
    ...envJsonObject(env, 'CLAUDE_DEFAULT_EXTRA_ENV_JSON', {}),
    ...envJsonObject(env, `${p}_EXTRA_ENV_JSON`, {}),
    ...(overrides.extraEnv || {}),
  };
  return {
    model,
    effort,
    permissionMode,
    outputFormat,
    timeoutMs,
    maxBudgetUsd,
    gatewayUrl,
    apiKey,
    apiKeyKind,
    extraEnv,
    claudeBin: String(firstNonEmpty(overrides.claudeBin, env.CLAUDE_BIN, 'claude')),
  };
}

export function publicAgentView(agent, runtime) {
  return {
    id: agent.id,
    name: agent.name,
    aliases: agent.aliases,
    summary: agent.summary,
    runtime: {
      model: runtime.model,
      effort: runtime.effort,
      permissionMode: runtime.permissionMode,
      timeoutMs: runtime.timeoutMs,
      outputFormat: runtime.outputFormat,
      gatewayConfigured: Boolean(runtime.gatewayUrl),
      credentialConfigured: Boolean(runtime.apiKey),
    },
  };
}
