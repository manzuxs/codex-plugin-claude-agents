import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from './sqlite.mjs';

const FIELD_SUFFIX = Object.freeze({
  runner: 'DEFAULT_RUNNER',
  model: 'MODEL', effort: 'EFFORT', permissionMode: 'PERMISSION_MODE', timeoutMs: 'TIMEOUT_MS',
  maxBudgetUsd: 'MAX_BUDGET_USD', gatewayUrl: 'GATEWAY_URL', apiKey: 'API_KEY', apiKeyKind: 'API_KEY_KIND', outputFormat: 'OUTPUT_FORMAT',
  browserMcpConfigsJson: 'BROWSER_MCP_CONFIGS_JSON',
});

const ENUMS = Object.freeze({
  effort: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  permissionMode: new Set(['auto', 'plan', 'acceptEdits', 'bypassPermissions']),
  apiKeyKind: new Set(['auth_token', 'api_key']),
  runner: new Set(['claude', 'codex']),
  outputFormat: new Set(['text', 'json', 'stream-json']),
});

function validateValues(values) {
  if (values.timeoutMs !== undefined && values.timeoutMs !== '' && (!Number.isInteger(Number(values.timeoutMs)) || Number(values.timeoutMs) < 1000)) {
    throw new Error('timeoutMs must be an integer >= 1000.');
  }
  if (values.maxBudgetUsd !== undefined && values.maxBudgetUsd !== '' && (!Number.isFinite(Number(values.maxBudgetUsd)) || Number(values.maxBudgetUsd) < 0)) {
    throw new Error('maxBudgetUsd must be a number >= 0.');
  }
  for (const [field, allowed] of Object.entries(ENUMS)) {
    if (values[field] !== undefined && values[field] !== '' && !allowed.has(String(values[field]))) throw new Error(`${field} is invalid.`);
  }
  if (values.gatewayUrl) {
    let parsed;
    try { parsed = new URL(String(values.gatewayUrl)); } catch { throw new Error('gatewayUrl must be a valid http(s) URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('gatewayUrl must be a valid http(s) URL.');
  }
  if (values.browserMcpConfigsJson) {
    let parsed;
    try { parsed = JSON.parse(String(values.browserMcpConfigsJson)); } catch { throw new Error('browserMcpConfigsJson must be valid JSON.'); }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('browserMcpConfigsJson must be a JSON object.');
    for (const [name, configPath] of Object.entries(parsed)) {
      if (!name.trim() || typeof configPath !== 'string' || !configPath.trim()) throw new Error('Each browser MCP profile must map a name to a config path.');
    }
  }
}

export class ConfigStore {
  constructor(dataRoot) {
    fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    this.filePath = path.join(dataRoot, 'claude-agents.sqlite');
    this.db = new DatabaseSync(this.filePath);
    fs.chmodSync(this.filePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS agent_config (
        config_key TEXT PRIMARY KEY,
        config_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.getStatement = this.db.prepare('SELECT config_key,config_value FROM agent_config');
    this.setStatement = this.db.prepare('INSERT INTO agent_config(config_key,config_value,updated_at) VALUES(?,?,?) ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value, updated_at=excluded.updated_at');
    this.deleteStatement = this.db.prepare('DELETE FROM agent_config WHERE config_key = ?');
  }

  values() {
    return Object.fromEntries(this.getStatement.all().map((row) => [row.config_key, row.config_value]));
  }

  writeAgentConfig({ agent, values }) {
    validateValues(values || {});
    const entries = Object.entries(values || {}).filter(([field]) => FIELD_SUFFIX[field]);
    if (!entries.length) throw new Error('No supported configuration fields were provided.');
    const now = new Date().toISOString();
    for (const [field, value] of entries) {
      const key = `${agent.prefix}_${FIELD_SUFFIX[field]}`;
      if (value === '' || value === null || value === undefined) this.deleteStatement.run(key);
      else this.setStatement.run(key, String(value), now);
    }
    return { ok: true, database: this.filePath };
  }

  effectiveFor(agent, runtime) {
    const config = this.values();
    const prefix = agent.prefix;
    return {
      runner: runtime.runner,
      model: runtime.model,
      effort: runtime.effort,
      permissionMode: runtime.permissionMode,
      timeoutMs: runtime.timeoutMs,
      maxBudgetUsd: runtime.maxBudgetUsd,
      gatewayUrl: runtime.gatewayUrl,
      apiKeyKind: runtime.apiKeyKind,
      outputFormat: runtime.outputFormat,
      browserMcpConfigsJson: JSON.stringify(runtime.browserMcpConfigs || {}),
      browserMcpProfiles: Object.keys(runtime.browserMcpConfigs || {}),
      apiKeyConfigured: Boolean(runtime.apiKey),
      storedKeys: Object.keys(config).filter((key) => key.startsWith(`${prefix}_`) || key.startsWith('CLAUDE_DEFAULT_') || key.startsWith('DEFAULT_')),
    };
  }

  toEnv() {
    return this.values();
  }

  close() { this.db.close(); }
}

export function supportedConfigFields() {
  return Object.keys(FIELD_SUFFIX);
}
