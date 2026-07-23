#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolvePluginRoot, resolveDataRoot } from '../server/lib/paths.mjs';
import { ClaudeAgentService } from '../server/lib/service.mjs';

const pluginRoot = resolvePluginRoot(import.meta.url);
const dataRoot = resolveDataRoot(pluginRoot);
const claudeBin = process.env.CLAUDE_BIN || 'claude';
const service = new ClaudeAgentService({ pluginRoot, dataRoot });
const checks = [];
function check(name, fn) {
  try { checks.push({ name, ok: true, detail: fn() }); }
  catch (error) { checks.push({ name, ok: false, detail: error.message }); }
}

check('Node.js >= 18.18', () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 18 || (major === 18 && minor < 18)) throw new Error(process.versions.node);
  return process.versions.node;
});
check('Plugin manifest', () => path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
check('Agent registry', () => `${service.registry.agents.length} agents`);
check('Writable data directory', () => {
  const probe = path.join(dataRoot, `.probe-${process.pid}`);
  fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); return dataRoot;
});
check('Claude Code CLI', () => {
  const result = spawnSync(claudeBin, ['--version'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || `exit ${result.status}`).trim());
  return result.stdout.trim();
});
check('Claude CLI required flags', () => {
  const result = spawnSync(claudeBin, ['--help'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || `exit ${result.status}`).trim());
  const help = `${result.stdout}\n${result.stderr}`;
  const required = ['--agents', '--agent', '--effort', '--permission-mode', '--output-format', '--print', '--chrome', '--mcp-config', '--strict-mcp-config'];
  const missing = required.filter((flag) => !help.includes(flag));
  if (missing.length) throw new Error(`Missing flags: ${missing.join(', ')}`);
  return required.join(', ');
});
check('Runner CLIs', () => service.listRunners().map((runner) => `${runner.id}: ${runner.available ? runner.version : 'unavailable'}`).join('; '));
check('Codex compaction guidance', () => {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(configPath)) return 'No Codex config found; optional target is 100000-120000 tokens.';
  const config = fs.readFileSync(configPath, 'utf8');
  const match = config.match(/^\s*model_auto_compact_token_limit\s*=\s*(\d+)\s*$/m);
  if (!match) return 'model_auto_compact_token_limit is not set; optional target is 100000-120000 tokens.';
  const value = Number(match[1]);
  if (value > 120000) return `Configured at ${value}; consider manually lowering it to 100000-120000 tokens.`;
  return `Configured at ${value}; no compaction warning.`;
});

console.log(JSON.stringify({ ok: checks.every((item) => item.ok), checks }, null, 2));
process.exitCode = checks.every((item) => item.ok) ? 0 : 1;
