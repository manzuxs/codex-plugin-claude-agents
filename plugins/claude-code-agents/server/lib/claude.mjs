import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildDelegationPrompt } from './xml.mjs';
import { collectSensitiveValues, redactText } from './redact.mjs';

const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;

function appendWithLimit(current, chunk, label) {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
    throw new Error(`${label} exceeded ${MAX_CAPTURE_BYTES} bytes`);
  }
  return next;
}

export function buildClaudeInvocation({ pluginRoot, agent, runtime, request }) {
  const promptFile = path.join(pluginRoot, 'agents', agent.prompt);
  if (!fs.existsSync(promptFile)) throw new Error(`Agent prompt not found: ${promptFile}`);
  const specialistPrompt = fs.readFileSync(promptFile, 'utf8');
  const nativeAgents = JSON.stringify({
    [agent.id]: {
      description: agent.summary,
      prompt: specialistPrompt,
    },
  });
  const prompt = buildDelegationPrompt({
    agent,
    task: request.task,
    plan: request.plan,
    acceptanceCriteria: request.acceptanceCriteria,
    context: request.context,
    codexReviewRequired: request.codexReviewRequired !== false,
  });
  const args = [
    '--bare',
    '--setting-sources', '',
    '-p',
    '--output-format', runtime.outputFormat,
    '--verbose',
    '--model', runtime.model,
    '--effort', runtime.effort,
    '--permission-mode', runtime.permissionMode,
    '--agents', nativeAgents,
    '--agent', agent.id,
  ];
  if (runtime.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  if (request.resume && request.sessionId) throw new Error('resume and sessionId are mutually exclusive');
  if (runtime.maxBudgetUsd > 0) args.push('--max-budget-usd', String(runtime.maxBudgetUsd));
  if (request.resume) args.push('--resume', String(request.resume));
  if (request.sessionId) args.push('--session-id', String(request.sessionId));
  if (request.allowedTools?.length) args.push('--allowed-tools', request.allowedTools.map(String).join(','));
  if (request.disallowedTools?.length) args.push('--disallowed-tools', request.disallowedTools.map(String).join(','));
  args.push('--name', `codex-${agent.id}`);
  args.push(prompt);

  const childEnv = { ...process.env, ...runtime.extraEnv };
  if (runtime.gatewayUrl) childEnv.ANTHROPIC_BASE_URL = runtime.gatewayUrl;
  if (runtime.apiKey) {
    const keyName = runtime.apiKeyKind === 'api_key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
    childEnv[keyName] = runtime.apiKey;
  }
  return { command: runtime.claudeBin, args, env: childEnv, prompt, promptFile, nativeAgents };
}

function redactInvocationArgs(args) {
  const safe = [...args];
  const agentsIndex = safe.indexOf('--agents');
  if (agentsIndex >= 0 && agentsIndex + 1 < safe.length) safe[agentsIndex + 1] = '[NATIVE_AGENT_JSON_REDACTED]';
  if (safe.length > 0) safe[safe.length - 1] = '[DELEGATION_XML_REDACTED_FROM_PREVIEW]';
  return safe;
}

function parseEventOutput(events, fallbackText) {
  const terminal = [...events].reverse().find((event) => event?.type === 'result');
  if (!terminal) return { text: fallbackText, structured: events };
  return {
    text: terminal.result ?? terminal.message ?? fallbackText,
    sessionId: terminal.session_id ?? terminal.sessionId ?? null,
    costUsd: terminal.total_cost_usd ?? terminal.cost_usd ?? null,
    durationMs: terminal.duration_ms ?? null,
    turns: terminal.num_turns ?? null,
    structured: events,
  };
}

export function parseClaudeOutput(stdout, outputFormat) {
  if (outputFormat === 'stream-json') {
    try {
      const events = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      return parseEventOutput(events, stdout.trim());
    } catch {
      return { text: stdout.trim(), raw: stdout, parseWarning: 'Claude stream output was not valid JSON.' };
    }
  }
  if (outputFormat !== 'json') return { text: stdout.trim(), raw: stdout };
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parseEventOutput(parsed, stdout.trim());
    return {
      text: parsed.result ?? parsed.message ?? stdout.trim(),
      sessionId: parsed.session_id ?? parsed.sessionId ?? null,
      costUsd: parsed.total_cost_usd ?? parsed.cost_usd ?? null,
      durationMs: parsed.duration_ms ?? null,
      turns: parsed.num_turns ?? null,
      structured: parsed,
    };
  } catch {
    return { text: stdout.trim(), raw: stdout, parseWarning: 'Claude output was not valid JSON.' };
  }
}

export async function runClaude({ pluginRoot, agent, runtime, request, cwd }) {
  const invocation = buildClaudeInvocation({ pluginRoot, agent, runtime, request });
  const startedAt = new Date().toISOString();
  if (request.dryRun) {
    return {
      ok: true,
      dryRun: true,
      startedAt,
      agent: agent.id,
      planSha256: request.planSha256 || null,
      cwd,
      command: invocation.command,
      args: redactInvocationArgs(invocation.args),
      runtime: {
        model: runtime.model,
        effort: runtime.effort,
        permissionMode: runtime.permissionMode,
        timeoutMs: runtime.timeoutMs,
        outputFormat: runtime.outputFormat,
        gatewayConfigured: Boolean(runtime.gatewayUrl),
        credentialConfigured: Boolean(runtime.apiKey),
      },
      promptPreview: invocation.prompt.slice(0, 2000),
    };
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: invocation.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, runtime.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      try { stdout = appendWithLimit(stdout, chunk, 'stdout'); }
      catch (error) { child.kill('SIGTERM'); reject(error); }
    });
    child.stderr.on('data', (chunk) => {
      try { stderr = appendWithLimit(stderr, chunk, 'stderr'); }
      catch (error) { child.kill('SIGTERM'); reject(error); }
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      settled = true;
      reject(new Error(`Failed to start Claude Code CLI (${invocation.command}): ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const secrets = collectSensitiveValues(invocation.env);
      const safeStdout = redactText(stdout, secrets);
      const safeStderr = redactText(stderr, secrets);
      const parsed = parseClaudeOutput(safeStdout, runtime.outputFormat);
      const finishedAt = new Date().toISOString();
      resolve({
        ok: code === 0,
        agent: agent.id,
        planSha256: request.planSha256 || null,
        cwd,
        startedAt,
        finishedAt,
        exitCode: code,
        signal,
        stderr: safeStderr.trim() || undefined,
        ...parsed,
      });
    });
  });
}
