import fs from 'node:fs';
import path from 'node:path';
import { buildDelegationPrompt } from '../xml.mjs';
import { redactObject, redactText, collectSensitiveValues } from '../redact.mjs';
import { superviseProcess } from '../execution/supervisor.mjs';
import { RUNNER_CAPABILITIES } from './capabilities.mjs';

function unsupported(label, value, supported) {
  throw new Error(`Grok runner does not support ${label}=${value}. Supported values: ${supported.length ? supported.join(', ') : 'none'}.`);
}

function validateRuntime(runtime, request) {
  const supports = RUNNER_CAPABILITIES.grok.supports;
  if (runtime.effort && !supports.effort.includes(runtime.effort)) unsupported('effort', runtime.effort, supports.effort);
  if (!supports.permissionMode.includes(runtime.permissionMode)) unsupported('permissionMode', runtime.permissionMode, supports.permissionMode);
  if ((request.browserMode || 'none') !== 'none') unsupported('browserMode', request.browserMode, ['none']);
  if (!supports.outputFormat.includes(runtime.outputFormat)) unsupported('outputFormat', runtime.outputFormat, supports.outputFormat);
  if (request.resume && request.sessionId) throw new Error('resume and sessionId are mutually exclusive');
}

function mapOutputFormat(format) {
  if (format === 'stream-json') return 'streaming-json';
  if (format === 'json') return 'json';
  return 'plain';
}

export function buildGrokInvocation({ pluginRoot, agent, runtime, request }) {
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
  const args = ['--no-alt-screen', '--cwd', request.cwd || process.cwd(), '--output-format', mapOutputFormat(runtime.outputFormat)];
  if (runtime.model) args.push('--model', runtime.model);
  if (runtime.effort && runtime.effort !== 'default') args.push('--reasoning-effort', runtime.effort);
  if (runtime.permissionMode) args.push('--permission-mode', runtime.permissionMode);
  if (runtime.permissionMode === 'bypassPermissions') args.push('--always-approve');
  if (request.resume) {
    if (request.resume === 'latest') args.push('--continue');
    else args.push('--resume', String(request.resume));
  }
  if (request.sessionId) args.push('--session-id', String(request.sessionId));
  args.push('--single', prompt);
  const env = { ...process.env, ...runtime.extraEnv };
  if (runtime.gatewayUrl) env.XAI_API_BASE_URL = runtime.gatewayUrl;
  if (runtime.apiKey) env.XAI_API_KEY = runtime.apiKey;
  return { command: runtime.grokBin, args, env, prompt, promptFile };
}

function parseJsonLines(stdout) {
  const events = [];
  const textLines = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try { events.push(JSON.parse(line)); } catch { textLines.push(line); }
  }
  return { events, text: textLines.join('\n') || stdout.trim() };
}

function eventText(event) {
  if (typeof event?.text === 'string') return event.text;
  if (typeof event?.output_text === 'string') return event.output_text;
  if (typeof event?.message === 'string') return event.message;
  if (typeof event?.message?.content === 'string') return event.message.content;
  if (Array.isArray(event?.message?.content)) return event.message.content.map((part) => part?.text || '').filter(Boolean).join('');
  return '';
}

export function parseGrokOutput(stdout, outputFormat) {
  if (outputFormat === 'text') return { text: stdout.trim(), structured: stdout.trim() ? undefined : [] };
  const parsed = parseJsonLines(stdout);
  const messages = parsed.events.map(eventText).filter(Boolean);
  const terminal = [...parsed.events].reverse().find((event) => /completed|result|final/i.test(String(event?.type || event?.status || '')));
  const responseText = eventText(terminal) || terminal?.result || terminal?.output || parsed.text;
  const usage = terminal?.usage || [...parsed.events].reverse().find((event) => event?.usage)?.usage;
  return {
    text: messages.at(-1) || responseText || parsed.text,
    sessionId: terminal?.session_id || terminal?.sessionId || terminal?.conversation_id || null,
    inputTokens: usage?.input_tokens ?? usage?.input ?? null,
    outputTokens: usage?.output_tokens ?? usage?.output ?? null,
    structured: parsed.events,
  };
}

function classifyGrokEvent(event) {
  const type = String(event?.type || event?.status || '').toLowerCase();
  if (/completed|result|final/.test(type)) return { phase: 'finalizing', verificationState: 'passed' };
  if (/tool|command|shell|edit/.test(type)) return { phase: 'implementing', lastTool: type.slice(0, 64) };
  if (/message|reason|turn/.test(type)) return { phase: 'implementing' };
  return { phase: 'running' };
}

function redactEvent(event, secrets) {
  try { return redactObject(JSON.parse(redactText(JSON.stringify(event), secrets))); } catch { return undefined; }
}

export const grokRunner = Object.freeze({
  ...RUNNER_CAPABILITIES.grok,
  buildInvocation: buildGrokInvocation,
  parseOutput: parseGrokOutput,
  async run({ pluginRoot, agent, runtime, request, cwd, signal, onProgress, onSpawn }) {
    const invocation = buildGrokInvocation({ pluginRoot, agent, runtime, request });
    const startedAt = new Date().toISOString();
    if (request.dryRun) {
      return {
        ok: true,
        dryRun: true,
        startedAt,
        role: agent.id,
        agent: agent.id,
        runner: 'grok',
        model: runtime.model,
        capabilitiesUsed: ['rolePrompt', ...(runtime.outputFormat !== 'text' ? ['jsonEvents'] : [])],
        planSha256: request.planSha256 || null,
        cwd,
        command: invocation.command,
        args: invocation.args.map((value, index) => index === invocation.args.length - 1 ? '[DELEGATION_XML_REDACTED_FROM_PREVIEW]' : value),
        runtime: { model: runtime.model, effort: runtime.effort, permissionMode: runtime.permissionMode, outputFormat: runtime.outputFormat },
        promptPreview: invocation.prompt.slice(0, 2000),
      };
    }
    const secrets = collectSensitiveValues(invocation.env);
    let streamBuffer = '';
    const result = await superviseProcess({
      command: invocation.command,
      args: invocation.args,
      cwd,
      env: invocation.env,
      signal,
      timeoutMs: runtime.timeoutMs,
      onSpawn,
      onStdoutChunk: (chunk) => {
        if (runtime.outputFormat !== 'stream-json') return;
        streamBuffer += chunk;
        let index;
        while ((index = streamBuffer.indexOf('\n')) >= 0) {
          const line = streamBuffer.slice(0, index); streamBuffer = streamBuffer.slice(index + 1);
          try {
            const event = JSON.parse(line);
            const progress = classifyGrokEvent(event);
            onProgress?.({ ...progress, event: redactEvent(event, secrets), lastActivityAt: new Date().toISOString() });
          } catch {}
        }
      },
    });
    const parsed = parseGrokOutput(result.stdout, runtime.outputFormat);
    return {
      ok: result.code === 0 && !result.cancelled && !result.timedOut,
      cancelled: result.cancelled,
      timedOut: result.timedOut,
      cancellationReason: result.cancelled ? String(signal?.reason || 'cancelled') : undefined,
      role: agent.id,
      agent: agent.id,
      runner: 'grok',
      model: runtime.model,
      capabilitiesUsed: ['rolePrompt', ...(runtime.outputFormat !== 'text' ? ['jsonEvents'] : [])],
      planSha256: request.planSha256 || null,
      cwd,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.code,
      signal: result.signal,
      stderr: result.stderr.trim() || undefined,
      ...parsed,
      error: result.code === 0 ? undefined : (result.stderr.trim() || `Grok runner exited with code ${result.code}`),
    };
  },
});
