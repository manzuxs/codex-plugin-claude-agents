import { runClaude } from '../claude.mjs';
import { RUNNER_CAPABILITIES } from './capabilities.mjs';

export const claudeRunner = Object.freeze({
  ...RUNNER_CAPABILITIES.claude,
  async run(input) { return runClaude(input); },
});
