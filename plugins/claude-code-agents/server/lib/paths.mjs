import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function inferPluginRoot(importMetaUrl) {
  let current = path.dirname(fileURLToPath(importMetaUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = path.join(current, '.codex-plugin', 'plugin.json');
    if (fs.existsSync(manifest)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Unable to infer plugin root from ${importMetaUrl}`);
}

export function resolvePluginRoot(importMetaUrl) {
  const candidate = process.env.MULTI_CLI_AGENTS_PLUGIN_ROOT || process.env.CLAUDE_AGENTS_PLUGIN_ROOT || process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
  return path.resolve(candidate || inferPluginRoot(importMetaUrl));
}

export function resolveDataRoot(pluginRoot) {
  const candidate = process.env.MULTI_CLI_AGENTS_DATA_ROOT || process.env.CLAUDE_AGENTS_DATA_ROOT || process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA;
  const canonical = path.join(os.homedir(), '.codex', 'multi-cli-agents');
  const legacy = path.join(os.homedir(), '.codex', 'claude-code-agents');
  const dataRoot = path.resolve(candidate || (fs.existsSync(legacy) && !fs.existsSync(canonical) ? legacy : canonical));
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  return dataRoot;
}

export function assertWorkingDirectory(value) {
  const cwd = path.resolve(value || process.cwd());
  const stat = fs.statSync(cwd);
  if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  return cwd;
}
