import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadAgentRegistry, publicAgentView, resolveAgent, resolveAgentRuntime } from './agents.mjs';
import { loadLayeredEnv } from './env.mjs';
import { assertWorkingDirectory } from './paths.mjs';
import { runClaude } from './claude.mjs';
import { JobStore } from './job-store.mjs';

const DEFAULT_RESULT_TEXT_CHARS = 8000;
const MAX_COMPACT_RESULT_BYTES = 8192;
const DEFAULT_BACKGROUND_LEASE_MS = 90_000;
const ACTIVE_JOB_STATUSES = new Set(['starting', 'running', 'queued']);

function compactMeta(meta) {
  if (!meta) return null;
  const keys = ['jobId', 'status', 'agent', 'planSha256', 'createdAt', 'startedAt', 'finishedAt', 'updatedAt', 'exitCode', 'sessionId', 'error', 'cancellationReason', 'persistOnDisconnect', 'leaseExpiresAt', 'resultAvailable'];
  return Object.fromEntries(keys.filter((key) => meta[key] !== undefined).map((key) => [key, meta[key]]));
}

function truncateText(value, maxChars) {
  if (value === undefined || value === null) return { value, truncated: false };
  const text = typeof value === 'string' ? value : String(value);
  if (text.length <= maxChars) return { value: text, truncated: false };
  return { value: `${text.slice(0, maxChars)}\n[输出已截断；使用 full=true 查看完整结果]`, truncated: true };
}

function statusForResult(result) {
  if (result.cancelled) return 'cancelled';
  if (result.timedOut) return 'failed';
  return result.ok ? 'completed' : 'failed';
}

function capCompactResult(compact) {
  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') <= MAX_COMPACT_RESULT_BYTES) return compact;
  compact.truncated = true;
  for (const key of ['verificationSummary', 'summary']) {
    if (typeof compact[key] !== 'string') continue;
    let value = compact[key];
    while (Buffer.byteLength(JSON.stringify(compact), 'utf8') > MAX_COMPACT_RESULT_BYTES && value.length > 0) {
      const excess = Buffer.byteLength(JSON.stringify(compact), 'utf8') - MAX_COMPACT_RESULT_BYTES;
      value = `${value.slice(0, Math.max(0, value.length - Math.max(64, excess)))}\n[输出已截断]`;
      compact[key] = value;
    }
  }
  return compact;
}

export function compactResult(result, maxTextChars = DEFAULT_RESULT_TEXT_CHARS) {
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
    verificationSummary: result.verificationSummary ?? terminal.verificationSummary ?? terminal.verification_summary,
  } : result;
  const compact = {};
  const keys = ['status', 'agent', 'jobId', 'sessionId', 'planSha256', 'durationMs', 'turns', 'costUsd', 'verificationSummary'];
  compact.status = source.status || statusForResult(source);
  for (const key of keys) if (source[key] !== undefined) compact[key] = key === 'verificationSummary' ? String(source[key]) : source[key];
  const summary = truncateText(source.summary ?? source.text ?? source.error ?? source.stderr, maxTextChars);
  if (summary.value !== undefined) compact.summary = summary.value;
  if (summary.truncated) compact.truncated = true;
  return capCompactResult(compact);
}

function runtimeOverrides(input) {
  return {
    model: input.model,
    effort: input.effort,
    permissionMode: input.permissionMode,
    timeoutMs: input.timeoutMs,
    maxBudgetUsd: input.maxBudgetUsd,
    outputFormat: input.outputFormat,
  };
}

export class ClaudeAgentService {
  constructor({ pluginRoot, dataRoot }) {
    this.pluginRoot = pluginRoot;
    this.dataRoot = dataRoot;
    this.registry = loadAgentRegistry(pluginRoot);
    this.jobs = new JobStore(dataRoot);
    this.ownedJobs = new Set();
    this.leaseTimers = new Map();
  }

  startLeaseHeartbeat(jobId, leaseTimeoutMs) {
    const intervalMs = Math.min(5000, Math.max(250, Math.floor(leaseTimeoutMs / 3)));
    const timer = setInterval(() => {
      try {
        const meta = this.jobs.renewLease(jobId);
        if (!ACTIVE_JOB_STATUSES.has(meta.status)) {
          this.stopLeaseHeartbeat(jobId);
          this.ownedJobs.delete(jobId);
        }
      }
      catch { this.stopLeaseHeartbeat(jobId); }
    }, intervalMs);
    timer.unref?.();
    this.leaseTimers.set(jobId, timer);
  }

  stopLeaseHeartbeat(jobId) {
    const timer = this.leaseTimers.get(jobId);
    if (timer) clearInterval(timer);
    this.leaseTimers.delete(jobId);
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
      const meta = this.jobs.create({ ...request, cwd, runtimeOverrides: runtimeOverrides(input), persistOnDisconnect, leaseTimeoutMs });
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
      if (!persistOnDisconnect) this.startLeaseHeartbeat(meta.jobId, leaseTimeoutMs);
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
      };
    }
    if (input.dryRun) return await runClaude({ pluginRoot: this.pluginRoot, agent, runtime, request, cwd, signal: input.signal });

    const meta = this.jobs.create({ ...request, cwd, runtimeOverrides: runtimeOverrides(input), persistOnDisconnect: false, mode: 'foreground' });
    this.jobs.writeMeta(meta.jobId, { status: 'starting', mode: 'foreground', persistOnDisconnect: false });
    this.ownedJobs.add(meta.jobId);
    let result;
    try {
      this.jobs.writeMeta(meta.jobId, { status: 'running', startedAt: new Date().toISOString() });
      result = await runClaude({ pluginRoot: this.pluginRoot, agent, runtime, request, cwd, signal: input.signal });
    } catch (error) {
      result = { ok: false, agent: agent.id, planSha256: request.planSha256, cwd, error: error.message };
    }
    const status = statusForResult(result);
    const stored = { ...result, jobId: meta.jobId, status };
    this.jobs.writeResult(meta.jobId, stored);
    this.jobs.writeMeta(meta.jobId, {
      status,
      finishedAt: result.finishedAt || new Date().toISOString(),
      exitCode: result.exitCode,
      sessionId: result.sessionId || null,
      error: result.error,
      cancellationReason: result.cancellationReason,
    });
    this.ownedJobs.delete(meta.jobId);
    return stored;
  }

  status(jobId, { full = false, limit = 5 } = {}) {
    const value = jobId ? this.jobs.get(jobId) : this.jobs.list(limit);
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
    return { meta: compactMeta(stored.meta), result: compactResult({ ...stored.result, jobId: stored.meta.jobId, status: stored.meta.status }, maxTextChars) };
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
        this.stopLeaseHeartbeat(jobId);
        if (!meta.persistOnDisconnect && ACTIVE_JOB_STATUSES.has(meta.status)) {
          if (meta.pid) this.cancel(jobId, reason);
          else this.jobs.writeMeta(jobId, { status: 'cancelled', finishedAt: new Date().toISOString(), cancellationReason: reason });
        }
      } catch {}
    }
  }
}
