import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function parseDotEnv(text) {
  const result = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    result[key] = value;
  }
  return result;
}

function readEnvFile(filePath) {
  try {
    if (!fs.statSync(filePath).isFile()) return {};
    return parseDotEnv(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

export function loadLayeredEnv({ pluginRoot, cwd = process.cwd(), processEnv = process.env } = {}) {
  const pluginEnv = pluginRoot ? readEnvFile(path.join(pluginRoot, '.env')) : {};
  const userConfigFile = processEnv.CLAUDE_AGENTS_CONFIG_FILE || path.join(os.homedir(), '.config', 'claude-code-agents', '.env');
  const userEnv = readEnvFile(userConfigFile);
  const projectEnv = cwd ? readEnvFile(path.join(cwd, '.claude-agents.env')) : {};
  // Existing process variables intentionally win over files so CI, secret managers,
  // and one-off invocations can override local configuration safely.
  return { ...pluginEnv, ...userEnv, ...projectEnv, ...processEnv };
}

export function envString(env, key, fallback = '') {
  const value = env[key];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

export function envInteger(env, key, fallback) {
  const raw = envString(env, key, '');
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid integer for ${key}: ${raw}`);
  return value;
}

export function envNumber(env, key, fallback) {
  const raw = envString(env, key, '');
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid number for ${key}: ${raw}`);
  return value;
}

export function envJsonObject(env, key, fallback = {}) {
  const raw = envString(env, key, '');
  if (!raw) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON for ${key}: ${error.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${key} must be a JSON object`);
  }
  return parsed;
}
