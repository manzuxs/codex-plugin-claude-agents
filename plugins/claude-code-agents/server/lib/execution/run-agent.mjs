import { resolveRunner } from '../runners/registry.mjs';

export function normalizeAgentResult(result, { agent, runner, runtime, request, cwd }) {
  return {
    ...result,
    role: result?.role || agent.id,
    agent: result?.agent || agent.id,
    runner: result?.runner || runner.id,
    model: result?.model ?? runtime.model,
    capabilitiesUsed: result?.capabilitiesUsed || ['rolePrompt'],
    cwd: result?.cwd || cwd,
    planSha256: result?.planSha256 ?? request.planSha256 ?? null,
  };
}

export async function runAgent({ runnerRegistry, agent, runner: requestedRunner, runtime, request, cwd, pluginRoot, signal, onProgress, onSpawn }) {
  const runner = resolveRunner(runnerRegistry, requestedRunner || runtime.runner);
  const result = await runner.run({ pluginRoot, agent, runtime, request, cwd, signal, onProgress, onSpawn });
  return normalizeAgentResult(result, { agent, runner, runtime, request, cwd });
}
