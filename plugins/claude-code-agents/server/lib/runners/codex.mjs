import fs from 'node:fs';
import path from 'node:path';
import { buildDelegationPrompt } from '../xml.mjs';
import { superviseProcess } from '../execution/supervisor.mjs';
import { RUNNER_CAPABILITIES } from './capabilities.mjs';

function unsupported(label, value, supported) {
  throw new Error(`Codex runner does not support ${label}=${value}. Supported values: ${supported.length ? supported.join(', ') : 'none'}.`);
}

function validateRuntime(runtime, request) {
  if (runtime.effort && !RUNNER_CAPABILITIES.codex.supports.effort.includes(runtime.effort)) {
    unsupported('effort', runtime.effort, RUNNER_CAPABILITIES.codex.supports.effort);
  }
  if (request.resume || request.sessionId) unsupported(request.resume ? 'resume' : 'sessionId', 'provided', []);
  if ((request.browserMode || 'none') !== 'none') unsupported('browserMode', request.browserMode, ['none']);
  if (runtime.permissionMode === 'dontAsk' || runtime.permissionMode === 'acceptEdits') {
    unsupported('permissionMode', runtime.permissionMode, RUNNER_CAPABILITIES.codex.supports.permissionMode);
  }
  if (!['json', 'stream-json'].includes(runtime.outputFormat)) unsupported('outputFormat', runtime.outputFormat, ['json', 'stream-json']);
}

export function buildCodexInvocation({ pluginRoot, agent, runtime, request, cwd }) {
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
  const args = ['exec', '--json', '--cd', cwd || request.cwd || process.cwd()];
  if (runtime.model) args.push('--model', runtime.model);
  if (runtime.effort && runtime.effort !== 'default') args.push('--config', `model_reasoning_effort="${runtime.effort}"`);
  if (runtime.permissionMode === 'bypassPermissions') args.push('--dangerously-bypass-approvals-and-sandbox');
  else if (runtime.permissionMode === 'plan') args.push('--sandbox', 'read-only');
  else if (runtime.permissionMode === 'auto' || runtime.permissionMode === 'default') args.push('--sandbox', 'workspace-write');
  args.push('--', prompt);
  return { command: runtime.codexBin, args, env: { ...process.env, ...runtime.extraEnv }, prompt, promptFile };
}

function parseJsonLines(stdout) {
  const events = [];
  const textLines = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try { events.push(JSON.parse(line)); }
    catch { textLines.push(line); }
  }
  return { events, text: textLines.join('\n') || stdout.trim() };
}

function terminalResult(events, fallbackText) {
  const threadStarted = events.find((event) => event?.type === 'thread.started');
  const messages = events
    .filter((event) => event?.type === 'item.completed' && event?.item?.type === 'agent_message')
    .map((event) => {
      if (typeof event.item?.text === 'string') return event.item.text;
      if (typeof event.item?.content === 'string') return event.item.content;
      if (!Array.isArray(event.item?.content)) return '';
      return event.item.content.map((part) => part?.text || part?.output_text || '').filter(Boolean).join('');
    })
    .filter((text) => text !== '')
    .map(String);
  const terminal = [...events].reverse().find((event) => event?.type === 'turn.completed' || event?.type === 'result' || event?.type === 'response.completed');
  const response = terminal?.result || terminal?.response || terminal?.message || terminal;
  const usage = terminal?.usage || response?.usage || [...events].reverse().find((event) => event?.usage)?.usage;
  const legacyText = typeof response === 'string' ? response : response?.text || response?.output_text || response?.last_message;
  return {
    text: messages.at(-1) || legacyText || fallbackText,
    sessionId: threadStarted?.thread_id || terminal?.thread_id || terminal?.session_id || terminal?.sessionId || response?.thread_id || null,
    turns: terminal?.num_turns || null,
    inputTokens: usage?.input_tokens ?? usage?.input ?? null,
    outputTokens: usage?.output_tokens ?? usage?.output ?? null,
    structured: events,
  };
}

export function parseCodexOutput(stdout) {
  const parsed = parseJsonLines(stdout);
  return terminalResult(parsed.events, parsed.text);
}

function redactArgs(args) {
  const safe = [...args];
  const promptIndex = safe.indexOf('--');
  if (promptIndex >= 0) safe[promptIndex + 1] = '[DELEGATION_XML_REDACTED_FROM_PREVIEW]';
  return safe;
}

function classifyCodexEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type || '').toLowerCase();
  if (type.includes('completed') || type === 'result') return { phase: 'finalizing', verificationState: 'passed' };
  if (type.includes('command') || type.includes('tool')) return { phase: 'implementing', lastTool: String(event.command || event.name || 'tool').slice(0, 64) };
  if (type.includes('reason') || type.includes('message')) return { phase: 'implementing' };
  return { phase: 'running' };
}

export const codexRunner = Object.freeze({
  ...RUNNER_CAPABILITIES.codex,
  buildInvocation: buildCodexInvocation,
  parseOutput: parseCodexOutput,
  async run({ pluginRoot, agent, runtime, request, cwd, signal, onProgress, onSpawn }) {
    const invocation = buildCodexInvocation({ pluginRoot, agent, runtime, request, cwd });
    const startedAt = new Date().toISOString();
    if (request.dryRun) {
      return {
        ok: true,
        dryRun: true,
        startedAt,
        role: agent.id,
        agent: agent.id,
        runner: 'codex',
        model: runtime.model,
        capabilitiesUsed: ['rolePrompt', 'jsonEvents'],
        planSha256: request.planSha256 || null,
        cwd,
        command: invocation.command,
        args: redactArgs(invocation.args),
        runtime: { model: runtime.model, effort: runtime.effort, permissionMode: runtime.permissionMode, outputFormat: runtime.outputFormat },
        promptPreview: invocation.prompt.slice(0, 2000),
      };
    }
    let streamBuffer = '';
    const events = [];
    const result = await superviseProcess({
      command: invocation.command,
      args: invocation.args,
      cwd,
      env: invocation.env,
      signal,
      timeoutMs: runtime.timeoutMs,
      onSpawn,
      onStdoutChunk: (chunk) => {
        streamBuffer += chunk;
        let index;
        while ((index = streamBuffer.indexOf('\n')) >= 0) {
          const line = streamBuffer.slice(0, index);
          streamBuffer = streamBuffer.slice(index + 1);
          try {
            const event = JSON.parse(line);
            events.push(event);
            const progress = classifyCodexEvent(event);
            if (progress) onProgress?.({ ...progress, event, lastActivityAt: new Date().toISOString() });
          } catch {}
        }
      },
    });
    if (streamBuffer.trim()) {
      try { events.push(JSON.parse(streamBuffer)); } catch {}
    }
    const parsed = terminalResult(events, result.stdout.trim());
    const cancelled = result.cancelled;
    const timedOut = result.timedOut;
    return {
      ok: result.code === 0 && !cancelled && !timedOut,
      cancelled,
      timedOut,
      cancellationReason: cancelled ? String(signal?.reason || 'cancelled') : undefined,
      role: agent.id,
      agent: agent.id,
      runner: 'codex',
      model: runtime.model,
      capabilitiesUsed: ['rolePrompt', 'jsonEvents'],
      planSha256: request.planSha256 || null,
      cwd,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.code,
      signal: result.signal,
      stderr: result.stderr.trim() || undefined,
      ...parsed,
      error: result.code === 0 ? undefined : (result.stderr.trim() || `Codex runner exited with code ${result.code}`),
    };
  },
});
