import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadAgentRegistry, publicAgentView, resolveAgent, resolveAgentRuntime } from './agents.mjs';
import { loadLayeredEnv } from './env.mjs';
import { assertWorkingDirectory } from './paths.mjs';
import { runClaude } from './claude.mjs';
import { JobStore } from './job-store.mjs';

const DEFAULT_RESULT_TEXT_CHARS = 12000;
const DEFAULT_BACKGROUND_LEASE_MS = 90_000;
const ACTIVE_JOB_STATUSES = new Set(['starting', 'running', 'queued']);

function compactMeta(meta) {
  if (!meta) return null;
  const keys = ['jobId', 'status', 'agent', 'planSha256', 'createdAt', 'startedAt', 'finishedAt', 'updatedAt', 'exitCode', 'sessionId', 'error', 'cancellationReason', 'persistOnDisconnect', 'leaseExpiresAt', 'resultAvailable'];
  return Object.fromEntries(keys.filter((key) => meta[key] !== undefined).map((key) => [key, meta[key]]));
}

function truncateText(value, maxChars) {
  if (typeof value !== 'string' || value.length <= maxChars) return { value, truncated: false };
  return { value: `${value.slice(0, maxChars)}\n[输出已截断；使用 full=true 查看完整结果]`, truncated: true };
}

function compactResult(result, maxTextChars) {
  if (!result) return null;
  const terminal = Array.isArray(result.structured)
    ? [...result.structured].reverse().find((event) => event?.type === 'result')
    : null;
  const source = terminal ? {
    ...result,
    text: terminal.result ?? result.text,
    sessionId: result.sessionId ?? terminal.session_id ?? null,
    costUsd: result.costUsd ?? terminal.total_cost_usd ?? terminal.cost_usd ?? null,
    durationMs: result.durationMs ?? terminal.duration_ms ?? null,
    turns: result.turns ?? terminal.num_turns ?? null,
  } : result;
  const compact = {};
  const keys = ['ok', 'cancelled', 'timedOut', 'cancellationReason', 'agent', 'sessionId', 'planSha256', 'startedAt', 'finishedAt', 'exitCode', 'signal', 'costUsd', 'durationMs', 'turns', 'error', 'parseWarning'];
  for (const key of keys) if (source[key] !== undefined) compact[key] = source[key];
  const text = truncateText(source.text, maxTextChars);
  const stderr = truncateText(source.stderr, maxTextChars);
  if (text.value !== undefined) compact.text = text.value;
  if (stderr.value !== undefined) compact.stderr = stderr.value;
  if (text.truncated || stderr.truncated) compact.truncated = true;
  return compact;
}

export class ClaudeAgentService {
  constructor({ pluginRoot, dataRoot }) {
    this.pluginRoot = pluginRoot;
    this.dataRoot = dataRoot;
    this.registry = loadAgentRegistry(pluginRoot);
    this.jobs = new JobStore(dataRoot);
    this.ownedJobs = new Set();
  }

  runtimeFor(agent, cwd, overrides = {}) {
    const env = loadLayeredEnv({ pluginRoot: this.pluginRoot, cwd });
    return resolveAgentRuntime({ agent, env, overrides });
  }

  listAgents({ cwd = process.cwd() } = {}) {
    const resolvedCwd = assertWorkingDirectory(cwd);
    return this.registry.agents.map((agent) => publicAgentView(agent, this.runtimeFor(agent, resolvedCwd)));
  }

  async run(input) {
    const agent = resolveAgent(this.registry, input.agent);
    const cwd = assertWorkingDirectory(input.cwd);
    const runtime = this.runtimeFor(agent, cwd, {
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      timeoutMs: input.timeoutMs,
      maxBudgetUsd: input.maxBudgetUsd,
      outputFormat: input.outputFormat,
    });
    const plan = String(input.plan || '');
    const request = {
      agent: agent.id,
      task: input.task,
      plan,
      planSha256: crypto.createHash('sha256').update(plan, 'utf8').digest('hex'),
      acceptanceCriteria: input.acceptanceCriteria || '',
      context: input.context || '',
      codexReviewRequired: input.codexReviewRequired !== false,
      resume: input.resume || '',
      sessionId: input.sessionId || '',
      allowedTools: input.allowedTools || [],
      disallowedTools: input.disallowedTools || [],
      dryRun: Boolean(input.dryRun),
    };
    if (input.background && !input.dryRun) {
      const persistOnDisconnect = Boolean(input.persistOnDisconnect);
      const leaseTimeoutMs = input.leaseTimeoutMs === undefined ? DEFAULT_BACKGROUND_LEASE_MS : Number(input.leaseTimeoutMs);
      if (!Number.isInteger(leaseTimeoutMs) || leaseTimeoutMs < 1000) throw new Error('leaseTimeoutMs must be an integer >= 1000');
      const meta = this.jobs.create({ ...request, cwd, runtimeOverrides: {
        model: input.model,
        effort: input.effort,
        permissionMode: input.permissionMode,
          timeoutMs: input.timeoutMs,
        maxBudgetUsd: input.maxBudgetUsd,
        outputFormat: input.outputFormat,
      }, persistOnDisconnect, leaseTimeoutMs });
      this.jobs.writeMeta(meta.jobId, {
        status: 'starting',
        persistOnDisconnect,
        leaseTimeoutMs,
        leaseExpiresAt: persistOnDisconnect ? null : new Date(Date.now() + leaseTimeoutMs).toISOString(),
      });
      const worker = path.join(this.pluginRoot, 'server', 'worker.mjs');
      const child = spawn(process.execPath, [worker, meta.jobId], {
        cwd: this.pluginRoot,
        env: {
          ...process.env,
          CLAUDE_AGENTS_PLUGIN_ROOT: this.pluginRoot,
          CLAUDE_AGENTS_DATA_ROOT: this.dataRoot,
        },
        detached: process.platform !== 'win32',
        stdio: 'ignore',
      });
      this.jobs.writeMeta(meta.jobId, { pid: child.pid });
      this.ownedJobs.add(meta.jobId);
      child.unref();
      return {
        ok: true,
        background: true,
        jobId: meta.jobId,
        status: 'starting',
        agent: agent.id,
        cwd,
        persistOnDisconnect,
        leaseTimeoutMs,
        recommendedPollSeconds: Math.min(30, Math.max(1, Math.floor(leaseTimeoutMs / 3000))),
      };
    }
    return await runClaude({ pluginRoot: this.pluginRoot, agent, runtime, request, cwd, signal: input.signal });
  }

  status(jobId, { full = false, limit = 5 } = {}) {
    const value = jobId ? this.jobs.renewLease(jobId) : this.jobs.list(limit);
    if (full) return value;
    return Array.isArray(value) ? value.map(compactMeta) : compactMeta(value);
  }

  result(jobId, { full = false, maxTextChars = DEFAULT_RESULT_TEXT_CHARS } = {}) {
    if (!jobId) {
      const [latest] = this.jobs.list(1);
      if (!latest) return { meta: null, result: null };
      jobId = latest.jobId;
    }
    const stored = this.jobs.result(jobId);
    if (full) return stored;
    return { meta: compactMeta(stored.meta), result: compactResult(stored.result, maxTextChars) };
  }

  cancel(jobId, reason = 'user_requested') {
    const meta = this.jobs.get(jobId);
    if (!meta.pid || !ACTIVE_JOB_STATUSES.has(meta.status)) {
      return { ok: false, jobId, status: meta.status, message: 'Job is not active.' };
    }
    try {
      if (process.platform !== 'win32') process.kill(-meta.pid, 'SIGTERM');
      else process.kill(meta.pid, 'SIGTERM');
      this.jobs.writeMeta(jobId, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancellationReason: reason });
      this.ownedJobs.delete(jobId);
      return { ok: true, jobId, status: 'cancelled', cancellationReason: reason };
    } catch (error) {
      return { ok: false, jobId, status: meta.status, message: error.message };
    }
  }

  dispose(reason = 'mcp_disconnected') {
    for (const jobId of this.ownedJobs) {
      try {
        const meta = this.jobs.get(jobId);
        if (!meta.persistOnDisconnect && ACTIVE_JOB_STATUSES.has(meta.status)) this.cancel(jobId, reason);
      } catch {}
    }
  }
}
