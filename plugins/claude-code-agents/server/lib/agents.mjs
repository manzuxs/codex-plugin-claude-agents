import fs from 'node:fs';
import path from 'node:path';
import { envInteger, envJsonObject, envNumber } from './env.mjs';
import { RUNNER_CAPABILITIES } from './runners/capabilities.mjs';

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

export function resolveAgentRuntime({ agent, env, overrides = {}, runner }) {
  const p = agent.prefix;
  const runnerId = String(firstNonEmpty(
    runner,
    overrides.runner,
    env[`${p}_DEFAULT_RUNNER`],
    env[`${p}_RUNNER`],
    env.DEFAULT_RUNNER,
    env.CLAUDE_DEFAULT_RUNNER,
    'claude',
  )).toLowerCase();
  const runnerSpec = RUNNER_CAPABILITIES[runnerId];
  if (!runnerSpec) throw new Error(`Unknown runner "${runnerId}". Available: ${Object.keys(RUNNER_CAPABILITIES).join(', ')}`);
  const supports = runnerSpec.supports;
  const runnerPrefix = runnerId.toUpperCase();
  const roleRunnerPrefix = `${p}_${runnerPrefix}`;
  const model = String(firstNonEmpty(
    overrides.model,
    env[`${roleRunnerPrefix}_MODEL`],
    runnerId === 'claude' ? env[`${p}_MODEL`] : undefined,
    env[`${runnerPrefix}_DEFAULT_MODEL`],
    runnerId === 'claude' ? env.CLAUDE_DEFAULT_MODEL : undefined,
    supports.defaultModel,
    '',
  ) ?? '');
  const effort = validateChoice('effort', String(firstNonEmpty(
    overrides.effort,
    env[`${roleRunnerPrefix}_EFFORT`],
    env[`${runnerPrefix}_DEFAULT_EFFORT`],
    runnerId === 'claude' ? env[`${p}_EFFORT`] : undefined,
    runnerId === 'claude' ? env.CLAUDE_DEFAULT_EFFORT : undefined,
    supports.defaultEffort,
  )), new Set(supports.effort));
  const permissionMode = validateChoice(
    'permission mode',
    String(firstNonEmpty(
      overrides.permissionMode,
      env[`${roleRunnerPrefix}_PERMISSION_MODE`],
      env[`${runnerPrefix}_DEFAULT_PERMISSION_MODE`],
      runnerId === 'claude' ? env[`${p}_PERMISSION_MODE`] : undefined,
      runnerId === 'claude' ? agent.defaultPermissionMode : undefined,
      runnerId === 'claude' ? env.CLAUDE_DEFAULT_PERMISSION_MODE : undefined,
      'auto',
    )),
    new Set(supports.permissionMode),
  );
  const outputFormat = validateChoice(
    'output format',
    String(firstNonEmpty(
      overrides.outputFormat,
      env[`${roleRunnerPrefix}_OUTPUT_FORMAT`],
      env[`${runnerPrefix}_DEFAULT_OUTPUT_FORMAT`],
      runnerId === 'claude' ? env[`${p}_OUTPUT_FORMAT`] : undefined,
      runnerId === 'claude' ? env.CLAUDE_DEFAULT_OUTPUT_FORMAT : undefined,
      supports.defaultOutputFormat,
    )),
    new Set(supports.outputFormat),
  );
  const timeoutMs = overrides.timeoutMs ?? envInteger(env, `${roleRunnerPrefix}_TIMEOUT_MS`, envInteger(env, `${runnerPrefix}_DEFAULT_TIMEOUT_MS`, envInteger(env, `${p}_TIMEOUT_MS`, envInteger(env, 'CLAUDE_DEFAULT_TIMEOUT_MS', 1_800_000))));
  const maxBudgetUsd = overrides.maxBudgetUsd ?? envNumber(env, `${roleRunnerPrefix}_MAX_BUDGET_USD`, envNumber(env, `${runnerPrefix}_DEFAULT_MAX_BUDGET_USD`, envNumber(env, `${p}_MAX_BUDGET_USD`, envNumber(env, 'CLAUDE_DEFAULT_MAX_BUDGET_USD', 0))));
  const gatewayUrl = String(firstNonEmpty(
    overrides.gatewayUrl,
    env[`${roleRunnerPrefix}_GATEWAY_URL`],
    env[`${runnerPrefix}_DEFAULT_GATEWAY_URL`],
    runnerId === 'claude' ? env[`${p}_GATEWAY_URL`] : undefined,
    runnerId === 'claude' ? env.CLAUDE_DEFAULT_GATEWAY_URL : undefined,
    '',
  ) ?? '');
  const apiKey = String(firstNonEmpty(
    overrides.apiKey,
    env[`${roleRunnerPrefix}_API_KEY`],
    env[`${runnerPrefix}_DEFAULT_API_KEY`],
    runnerId === 'claude' ? env[`${p}_API_KEY`] : undefined,
    runnerId === 'claude' ? env.CLAUDE_DEFAULT_API_KEY : undefined,
    '',
  ) ?? '');
  const apiKeyKind = String(firstNonEmpty(
    overrides.apiKeyKind,
    env[`${roleRunnerPrefix}_API_KEY_KIND`],
    env[`${runnerPrefix}_DEFAULT_API_KEY_KIND`],
    runnerId === 'claude' ? env[`${p}_API_KEY_KIND`] : undefined,
    runnerId === 'claude' ? env.CLAUDE_DEFAULT_API_KEY_KIND : undefined,
    'auth_token',
  ));
  if (!['auth_token', 'api_key'].includes(apiKeyKind)) throw new Error('apiKeyKind must be auth_token or api_key');
  const extraEnv = {
    ...envJsonObject(env, 'CLAUDE_DEFAULT_EXTRA_ENV_JSON', {}),
    ...envJsonObject(env, `${runnerPrefix}_DEFAULT_EXTRA_ENV_JSON`, {}),
    ...envJsonObject(env, `${p}_EXTRA_ENV_JSON`, {}),
    ...envJsonObject(env, `${roleRunnerPrefix}_EXTRA_ENV_JSON`, {}),
    ...(overrides.extraEnv || {}),
  };
  const browserMcpConfigs = {
    ...envJsonObject(env, 'CLAUDE_BROWSER_MCP_CONFIGS_JSON', {}),
    ...envJsonObject(env, `${p}_BROWSER_MCP_CONFIGS_JSON`, {}),
    ...envJsonObject(env, `${roleRunnerPrefix}_BROWSER_MCP_CONFIGS_JSON`, {}),
  };
  for (const [profile, configPath] of Object.entries(browserMcpConfigs)) {
    if (!/^[a-z][a-z0-9-]*$/.test(profile)) throw new Error(`Invalid browser MCP profile: ${profile}`);
    if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) {
      throw new Error(`Browser MCP profile ${profile} must reference an absolute config file path`);
    }
  }
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
    browserMcpConfigs,
    runner: runnerId,
    claudeBin: String(firstNonEmpty(overrides.claudeBin, env.CLAUDE_BIN, 'claude')),
    codexBin: String(firstNonEmpty(overrides.codexBin, env[`${roleRunnerPrefix}_BIN`], env[`${runnerPrefix}_BIN`], env.CODEX_BIN, 'codex')),
    grokBin: String(firstNonEmpty(overrides.grokBin, env[`${roleRunnerPrefix}_BIN`], env[`${runnerPrefix}_BIN`], env.GROK_BIN, 'grok')),
    agyBin: String(firstNonEmpty(overrides.agyBin, env[`${roleRunnerPrefix}_BIN`], env[`${runnerPrefix}_BIN`], env.AGY_BIN, 'agy')),
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
      runner: runtime.runner,
      gatewayConfigured: Boolean(runtime.gatewayUrl),
      credentialConfigured: Boolean(runtime.apiKey),
      browserMcpConfigured: Object.keys(runtime.browserMcpConfigs).length > 0,
    },
  };
}
