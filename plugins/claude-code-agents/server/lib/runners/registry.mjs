import { RUNNER_CAPABILITIES } from './capabilities.mjs';
import { claudeRunner } from './claude.mjs';
import { codexRunner } from './codex.mjs';

const RUNNERS = Object.freeze({ claude: claudeRunner, codex: codexRunner });

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

export function listRunners(registry, defaultRunner = 'claude') {
  return [...registry.values()].map((runner) => publicRunnerView(runner, { defaultRunner: runner.id === defaultRunner }));
}

export { RUNNERS, RUNNER_CAPABILITIES };
