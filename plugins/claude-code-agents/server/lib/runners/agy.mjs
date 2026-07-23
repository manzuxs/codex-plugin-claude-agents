import fs from 'node:fs';
import path from 'node:path';
import { buildDelegationPrompt } from '../xml.mjs';
import { superviseProcess } from '../execution/supervisor.mjs';
import { RUNNER_CAPABILITIES } from './capabilities.mjs';

function unsupported(label, value, supported) {
  throw new Error(`Antigravity runner does not support ${label}=${value}. Supported values: ${supported.length ? supported.join(', ') : 'none'}.`);
}

function validateRuntime(runtime, request) {
  const supports = RUNNER_CAPABILITIES.agy.supports;
  if (runtime.effort && !supports.effort.includes(runtime.effort)) unsupported('effort', runtime.effort, supports.effort);
  if (!supports.permissionMode.includes(runtime.permissionMode)) unsupported('permissionMode', runtime.permissionMode, supports.permissionMode);
  if ((request.browserMode || 'none') !== 'none') unsupported('browserMode', request.browserMode, ['none']);
  if (runtime.outputFormat !== 'text') unsupported('outputFormat', runtime.outputFormat, ['text']);
  if (request.sessionId) unsupported('sessionId', 'provided', []);
}

export function buildAgyInvocation({ pluginRoot, agent, runtime, request }) {
  validateRuntime(runtime, request);
  const promptFile = path.join(pluginRoot, 'agents', agent.prompt);
  if (!fs.existsSync(promptFile)) throw new Error(`Agent prompt not found: ${promptFile}`);
  const specialistPrompt = fs.readFileSync(promptFile, 'utf8');
  const prompt = `${buildDelegationPrompt({
    agent,
    task: request.task,
    plan: request.plan,
    acceptanceCriteria: request.acceptanceCriteria,
    context: request.context,
    browserMode: 'none',
    codexReviewRequired: request.codexReviewRequired !== false,
  })}\n\n<role_protocol>\n${specialistPrompt}\n</role_protocol>`;
  const args = ['--print'];
  if (runtime.model) args.push('--model', runtime.model);
  if (runtime.effort && runtime.effort !== 'default') args.push('--effort', runtime.effort);
  if (runtime.permissionMode === 'plan') args.push('--mode', 'plan');
  else if (runtime.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else args.push('--mode', 'accept-edits');
  if (request.resume) {
    if (request.resume === 'latest') args.push('--continue');
    else args.push('--conversation', String(request.resume));
  }
  args.push(prompt);
  const env = { ...process.env, ...runtime.extraEnv };
  if (runtime.gatewayUrl) env.AGY_BASE_URL = runtime.gatewayUrl;
  if (runtime.apiKey) env.AGY_API_KEY = runtime.apiKey;
  return { command: runtime.agyBin, args, env, prompt, promptFile };
}

export const agyRunner = Object.freeze({
  ...RUNNER_CAPABILITIES.agy,
  buildInvocation: buildAgyInvocation,
  parseOutput(stdout) { return { text: stdout.trim(), raw: stdout }; },
  async run({ pluginRoot, agent, runtime, request, cwd, signal, onProgress, onSpawn }) {
    const invocation = buildAgyInvocation({ pluginRoot, agent, runtime, request });
    const startedAt = new Date().toISOString();
    if (request.dryRun) {
      return {
        ok: true,
        dryRun: true,
        startedAt,
        role: agent.id,
        agent: agent.id,
        runner: 'agy',
        model: runtime.model,
        capabilitiesUsed: ['rolePrompt', 'textOutput'],
        planSha256: request.planSha256 || null,
        cwd,
        command: invocation.command,
        args: invocation.args.map((value, index) => index === invocation.args.length - 1 ? '[DELEGATION_XML_REDACTED_FROM_PREVIEW]' : value),
        runtime: { model: runtime.model, effort: runtime.effort, permissionMode: runtime.permissionMode, outputFormat: runtime.outputFormat },
        promptPreview: invocation.prompt.slice(0, 2000),
      };
    }
    const result = await superviseProcess({
      command: invocation.command,
      args: invocation.args,
      cwd,
      env: invocation.env,
      signal,
      timeoutMs: runtime.timeoutMs,
      onSpawn,
    });
    onProgress?.({ phase: 'finalizing', verificationState: result.code === 0 ? 'passed' : 'failed', lastActivityAt: new Date().toISOString() });
    const parsed = { text: result.stdout.trim(), raw: result.stdout };
    return {
      ok: result.code === 0 && !result.cancelled && !result.timedOut,
      cancelled: result.cancelled,
      timedOut: result.timedOut,
      cancellationReason: result.cancelled ? String(signal?.reason || 'cancelled') : undefined,
      role: agent.id,
      agent: agent.id,
      runner: 'agy',
      model: runtime.model,
      capabilitiesUsed: ['rolePrompt', 'textOutput'],
      planSha256: request.planSha256 || null,
      cwd,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.code,
      signal: result.signal,
      stderr: result.stderr.trim() || undefined,
      ...parsed,
      error: result.code === 0 ? undefined : (result.stderr.trim() || `Antigravity runner exited with code ${result.code}`),
    };
  },
});
