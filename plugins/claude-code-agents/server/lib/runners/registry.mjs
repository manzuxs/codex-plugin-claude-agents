import { RUNNER_CAPABILITIES } from './capabilities.mjs';
import { claudeRunner } from './claude.mjs';
import { codexRunner } from './codex.mjs';
import { grokRunner } from './grok.mjs';
import { agyRunner } from './agy.mjs';
import { spawnSync } from 'node:child_process';

const RUNNERS = Object.freeze({ claude: claudeRunner, codex: codexRunner, grok: grokRunner, agy: agyRunner });

export function normalizeRunnerName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function resolveRunner(registry, requested) {
  const id = normalizeRunnerName(requested || '');
  if (!id || !registry.has(id)) {
    const available = [...registry.keys()].join(', ');
    throw new Error(`Unknown runner "${requested}". Available: ${available}`);
  }
  return registry.get(id);
}

export function createRunnerRegistry() {
  return new Map(Object.entries(RUNNERS));
}

export function publicRunnerView(runner, { defaultRunner = false } = {}) {
  return {
    id: runner.id,
    name: runner.name,
    command: runner.command,
    default: defaultRunner,
    capabilities: runner.supports,
  };
}

export function detectRunner(runner, { env = process.env } = {}) {
  const envKey = `${runner.id.toUpperCase()}_BIN`;
  const command = String(env[envKey] || runner.command);
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      command,
      version: null,
      error: String(result.error?.message || result.stderr || `exit ${result.status ?? 'unknown'}`).trim().slice(0, 256),
    };
  }
  return { available: true, command, version: String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0].slice(0, 256) };
}

export function listRunners(registry, defaultRunner = 'claude', { detect = true, env = process.env } = {}) {
  return [...registry.values()].map((runner) => ({
    ...publicRunnerView(runner, { defaultRunner: runner.id === defaultRunner }),
    ...(detect ? detectRunner(runner, { env }) : {}),
  }));
}

export { RUNNERS, RUNNER_CAPABILITIES };
