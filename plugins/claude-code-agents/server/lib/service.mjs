import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadAgentRegistry, publicAgentView, resolveAgent, resolveAgentRuntime } from './agents.mjs';
import { loadLayeredEnv } from './env.mjs';
import { assertWorkingDirectory } from './paths.mjs';
import { createRunnerRegistry, listRunners, resolveRunner } from './runners/registry.mjs';
import { discoverRunnerModels } from './runners/model-discovery.mjs';
import { runAgent } from './execution/run-agent.mjs';
import { buildEvidenceView } from './evidence.mjs';
import { JobStore } from './job-store.mjs';
import { ConfigStore } from './config-store.mjs';
import { browserInstallationHint, inspectRepositoryBrowser, readBrowserMcpConfig } from './browser.mjs';

const DEFAULT_RESULT_TEXT_CHARS = 8000;
const MAX_COMPACT_RESULT_BYTES = 8192;
const MAX_COMPACT_STATUS_BYTES = 2048;
const MAX_COMPACT_STATUS_LIST_BYTES = 8192;
const DEFAULT_BACKGROUND_LEASE_MS = 300_000;
const DEFAULT_WAIT_TIMEOUT_MS = 2_100_000;
const MAX_WAIT_TIMEOUT_MS = 2_100_000;
const ACTIVE_JOB_STATUSES = new Set(['starting', 'running', 'queued']);
const POLL_SCHEDULE_SECONDS = [30, 60, 120, 180];
const TRUNCATION_MARKER = '\n[输出已截断]';
const BROWSER_MODES = new Set(['none', 'repository', 'chrome', 'mcp']);
const BROWSER_AGENT_POLICIES = Object.freeze({
  'ui-designer': {
    purpose: 'visual-validation',
    completionGate: 'Do not report visual validation completed unless a real browser opened the implemented page at the required viewports, relevant interaction states were reviewed, and screenshot or equivalent reproducible evidence was recorded. Automated assertions are required only when the acceptance criteria request them.',
  },
  'frontend-engineer': {
    purpose: 'implementation-validation',
    completionGate: 'Do not report browser validation completed unless a real browser exercised the affected user path, checked observable behavior and browser console failures, and recorded reproducible evidence.',
  },
  'qa-engineer': {
    purpose: 'independent-e2e',
    completionGate: 'Do not report completed unless a real browser exercised the specified user paths, required assertions passed, and reproducible commands, tool actions, and evidence locations were recorded.',
  },
});

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fitStringField(value, key, maxBytes) {
  if (typeof value[key] !== 'string') return;
  const original = value[key];
  delete value[key];
  let low = 0;
  let high = original.length;
  let best;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = middle < original.length
      ? `${original.slice(0, middle)}${TRUNCATION_MARKER}`
      : original;
    value[key] = candidate;
    if (jsonBytes(value) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
    delete value[key];
  }
  if (best !== undefined) value[key] = best;
}

function capObject(value, maxBytes, { shrinkKeys, dropKeys, fallback }) {
  if (jsonBytes(value) <= maxBytes) return value;
  value.truncated = true;
  for (const key of shrinkKeys) {
    if (jsonBytes(value) <= maxBytes) break;
    fitStringField(value, key, maxBytes);
  }
  for (const key of dropKeys) {
    if (jsonBytes(value) <= maxBytes) break;
    delete value[key];
  }
  return jsonBytes(value) <= maxBytes ? value : fallback(value);
}

function compactMeta(meta) {
  if (!meta) return null;
  const keys = ['jobId', 'status', 'role', 'agent', 'runner', 'model', 'capabilitiesUsed', 'task', 'cwd', 'browserMode', 'planSha256', 'configuredTimeoutMs', 'requestedTimeoutMs', 'effectiveTimeoutMs', 'timeoutSource', 'createdAt', 'startedAt', 'finishedAt', 'updatedAt', 'exitCode', 'sessionId', 'error', 'cancellationReason', 'persistOnDisconnect', 'leaseExpiresAt', 'resultAvailable', 'progressRevision', 'phase', 'elapsedMs', 'durationMs', 'turns', 'turnsObserved', 'costUsd', 'inputTokens', 'outputTokens', 'lastActivityAt', 'lastTool', 'lastToolSummary', 'verificationState', 'browserCapability', 'browserBackend', 'installationHint', 'changedSinceLastPoll', 'pollAttempt', 'nextPollSeconds'];
  const compact = Object.fromEntries(keys.filter((key) => meta[key] !== undefined).map((key) => [key, meta[key]]));
  if (ACTIVE_JOB_STATUSES.has(meta.status)) compact.elapsedMs = Math.max(Number(meta.elapsedMs || 0), Date.now() - Date.parse(meta.startedAt || meta.createdAt));
  else if (meta.elapsedMs !== undefined) compact.elapsedMs = meta.elapsedMs;
  return capObject(compact, MAX_COMPACT_STATUS_BYTES, {
    shrinkKeys: ['error', 'installationHint', 'cancellationReason', 'lastToolSummary', 'sessionId', 'planSha256', 'task', 'agent', 'jobId', 'status'],
    dropKeys: ['leaseExpiresAt', 'updatedAt', 'createdAt', 'startedAt', 'finishedAt', 'lastActivityAt'],
    fallback: (current) => ({
      jobId: String(current.jobId || '').slice(0, 128),
      status: String(current.status || 'unknown').slice(0, 32),
      agent: String(current.agent || '').slice(0, 64),
      phase: String(current.phase || '').slice(0, 32),
      progressRevision: Number(current.progressRevision || 0),
      elapsedMs: Number(current.elapsedMs || 0),
      changedSinceLastPoll: Boolean(current.changedSinceLastPoll),
      pollAttempt: Number(current.pollAttempt || 0),
      nextPollSeconds: current.nextPollSeconds === null ? null : Number(current.nextPollSeconds || 0),
      truncated: true,
    }),
  });
}

function capStatusList(values) {
  const compact = [];
  for (const value of values) {
    if (jsonBytes([...compact, value]) > MAX_COMPACT_STATUS_LIST_BYTES) break;
    compact.push(value);
  }
  return compact;
}

function pollStatus(meta, { sinceRevision, pollAttempt = 0 } = {}) {
  const currentRevision = Number(meta.progressRevision || 0);
  const changedSinceLastPoll = sinceRevision === undefined || currentRevision !== Number(sinceRevision);
  const attempt = Number.isInteger(pollAttempt) && pollAttempt >= 0 ? pollAttempt : 0;
  if (!ACTIVE_JOB_STATUSES.has(meta.status)) return { changedSinceLastPoll, pollAttempt: attempt, nextPollSeconds: null };
  const nextAttempt = changedSinceLastPoll ? 1 : Math.min(attempt + 1, POLL_SCHEDULE_SECONDS.length - 1);
  return {
    changedSinceLastPoll,
    pollAttempt: nextAttempt,
    nextPollSeconds: POLL_SCHEDULE_SECONDS[nextAttempt],
  };
}

export function pollSchedule() {
  return [...POLL_SCHEDULE_SECONDS];
}

function truncateText(value, maxChars) {
  if (value === undefined || value === null) return { value, truncated: false };
  const text = typeof value === 'string' ? value : String(value);
  if (text.length <= maxChars) return { value: text, truncated: false };
  return { value: `${text.slice(0, maxChars)}\n[输出已截断；使用 full=true 查看完整结果]`, truncated: true };
}

function statusForResult(result) {
  if (result.cancelled) return 'cancelled';
  if (result.blocked) return 'blocked';
  if (result.timedOut) return 'failed';
  return result.ok ? 'completed' : 'failed';
}

function isProcessAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function signalProcessGroup(pid, signal = 'SIGTERM') {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    if (process.platform !== 'win32') process.kill(-value, signal);
    else process.kill(value, signal);
    return true;
  } catch {
    try { process.kill(value, signal); return true; } catch { return false; }
  }
}

function waitForDelay(delayMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      const error = new Error('等待任务结果的请求已取消。');
      error.name = 'AbortError';
      reject(error);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function capCompactResult(compact, maxBytes = MAX_COMPACT_RESULT_BYTES) {
  return capObject(compact, maxBytes, {
    shrinkKeys: ['recommendedNextStage', 'summary', 'filesChanged', 'unfinishedItemsAndRisks', 'verificationSummary', 'installationHint', 'outcome', 'sessionId', 'planSha256', 'jobId', 'agent', 'role', 'runner', 'model', 'status'],
    dropKeys: ['costUsd', 'turns', 'durationMs', 'evidenceOmissions', 'evidenceStructured'],
    fallback: (current) => ({
      status: String(current.status || 'unknown').slice(0, 32),
      role: String(current.role || current.agent || '').slice(0, 64),
      agent: String(current.agent || '').slice(0, 64),
      runner: String(current.runner || 'claude').slice(0, 32),
      model: String(current.model || '').slice(0, 128),
      capabilitiesUsed: Array.isArray(current.capabilitiesUsed) ? current.capabilitiesUsed.slice(0, 16) : [],
      jobId: String(current.jobId || '').slice(0, 128),
      truncated: true,
      summary: '[结果字段超过输出限制；使用 full=true 进行诊断]',
    }),
  });
}

export function compactResult(result, maxTextChars = DEFAULT_RESULT_TEXT_CHARS, maxBytes = MAX_COMPACT_RESULT_BYTES) {
  if (!result) return null;
  const terminal = Array.isArray(result.structured)
    ? [...result.structured].reverse().find((event) => event?.type === 'result')
    : null;
  const source = terminal ? {
    ...result,
    text: terminal.result ?? result.text,
    sessionId: result.sessionId ?? terminal.session_id ?? terminal.sessionId ?? terminal.session?.id ?? null,
    costUsd: result.costUsd ?? terminal.total_cost_usd ?? terminal.cost_usd ?? null,
    durationMs: result.durationMs ?? terminal.duration_ms ?? null,
    turns: result.turns ?? terminal.num_turns ?? null,
    verificationSummary: result.verificationSummary ?? terminal.verificationSummary ?? terminal.verification_summary,
  } : result;
  const compact = {};
  const keys = ['status', 'role', 'agent', 'runner', 'model', 'capabilitiesUsed', 'jobId', 'sessionId', 'planSha256', 'configuredTimeoutMs', 'requestedTimeoutMs', 'effectiveTimeoutMs', 'timeoutSource', 'durationMs', 'turns', 'costUsd', 'verificationSummary', 'blocked', 'browserCapability', 'browserBackend', 'browserPurpose', 'browserToolUseObserved', 'installationHint'];
  compact.status = source.status || statusForResult(source);
  for (const key of keys) if (source[key] !== undefined) compact[key] = key === 'verificationSummary' ? String(source[key]) : source[key];
  const summarySource = source.ok === false
    ? source.error ?? source.summary ?? source.text ?? source.stderr
    : source.summary ?? source.text ?? source.error ?? source.stderr;
  const summary = truncateText(summarySource, maxTextChars);
  if (summary.value !== undefined) compact.summary = summary.value;
  if (summary.truncated) compact.truncated = true;
  if (jsonBytes(compact) > maxBytes) {
    const evidence = buildEvidenceView(summarySource, source.verificationSummary);
    if (evidence) {
      delete compact.summary;
      delete compact.verificationSummary;
      Object.assign(compact, evidence, { truncated: true });
    }
  }
  return capCompactResult(compact, maxBytes);
}

function runtimeOverrides(input, runtime) {
  return {
    runner: input.runner,
    model: input.model,
    effort: input.effort,
    permissionMode: input.permissionMode,
    timeoutMs: runtime?.timeoutMs ?? input.timeoutMs,
    maxBudgetUsd: input.maxBudgetUsd,
    outputFormat: input.outputFormat,
    codexBin: input.codexBin,
    grokBin: input.grokBin,
    agyBin: input.agyBin,
  };
}

export function resolveRunnerTimeout({ configuredTimeoutMs, requestedTimeoutMs, allowShorterTimeout = false }) {
  const configured = Number(configuredTimeoutMs);
  const requested = requestedTimeoutMs === undefined || requestedTimeoutMs === null || requestedTimeoutMs === ''
    ? null
    : Number(requestedTimeoutMs);
  if (!Number.isInteger(configured) || configured < 1000) throw new Error('Configured Runner timeout must be an integer >= 1000.');
  if (requested === null) {
    return { configuredTimeoutMs: configured, requestedTimeoutMs: null, effectiveTimeoutMs: configured, timeoutSource: 'configured' };
  }
  if (!Number.isInteger(requested) || requested < 1000) throw new Error('timeoutMs must be an integer >= 1000.');
  if (requested < configured && !allowShorterTimeout) {
    return { configuredTimeoutMs: configured, requestedTimeoutMs: requested, effectiveTimeoutMs: configured, timeoutSource: 'configured-protected' };
  }
  return { configuredTimeoutMs: configured, requestedTimeoutMs: requested, effectiveTimeoutMs: requested, timeoutSource: 'request-override' };
}

function resolveBrowserRequest(input, agent, runtime, cwd) {
  const browserMode = String(input.browserMode || 'none');
  let browserMcpProfile = String(input.browserMcpProfile || '');
  const policy = BROWSER_AGENT_POLICIES[agent.id];
  const configEnv = `${agent.prefix}_BROWSER_MCP_CONFIGS_JSON`;
  if (!BROWSER_MODES.has(browserMode)) {
    throw new Error(`browserMode must be one of: ${[...BROWSER_MODES].join(', ')}; received ${browserMode}`);
  }
  if (browserMode !== 'none' && !policy) {
    throw new Error('Browser modes are only available to ui-designer, frontend-engineer, and qa-engineer');
  }
  if (browserMode === 'repository') {
    const repository = inspectRepositoryBrowser(cwd);
    if (!repository.ok) throw new Error(repository.error);
    return {
      browserMode,
      browserMcpProfile: '',
      browserBackend: repository.framework,
      browserPurpose: policy.purpose,
      browserCompletionGate: policy.completionGate,
      browserInstallationHint: browserInstallationHint(browserMode),
    };
  }
  if (browserMode === 'chrome' && runtime.gatewayUrl) {
    throw new Error(`Chrome browser mode is unavailable with an API gateway. ${browserInstallationHint('chrome', '', configEnv)}`);
  }
  if (browserMode === 'mcp') {
    const profiles = Object.keys(runtime.browserMcpConfigs);
    if (!browserMcpProfile && profiles.length === 1) [browserMcpProfile] = profiles;
    if (!browserMcpProfile && profiles.length === 0) {
      throw new Error(`No browser MCP profile is configured. ${browserInstallationHint('mcp', '', configEnv)}`);
    }
    if (!browserMcpProfile) throw new Error('browserMcpProfile is required when multiple browser MCP profiles are configured');
    if (!runtime.browserMcpConfigs[browserMcpProfile]) {
      throw new Error(`Unknown browser MCP profile: ${browserMcpProfile}. ${browserInstallationHint('mcp', browserMcpProfile, configEnv)}`);
    }
    let expectedServers;
    try { expectedServers = readBrowserMcpConfig(runtime.browserMcpConfigs[browserMcpProfile]); }
    catch (error) { throw new Error(`${error.message}. ${browserInstallationHint('mcp', browserMcpProfile, configEnv)}`); }
    return {
      browserMode,
      browserMcpProfile,
      browserBackend: `mcp:${browserMcpProfile}`,
      browserPurpose: policy.purpose,
      browserCompletionGate: policy.completionGate,
      browserExpectedMcpServers: expectedServers,
      browserInstallationHint: browserInstallationHint(browserMode, browserMcpProfile, configEnv),
    };
  } else if (browserMcpProfile) {
    throw new Error('browserMcpProfile is only valid when browserMode=mcp');
  }
  return {
    browserMode,
    browserMcpProfile,
    browserBackend: browserMode,
    browserPurpose: browserMode === 'none' ? '' : policy?.purpose || '',
    browserCompletionGate: browserMode === 'none' ? '' : policy?.completionGate || '',
    browserInstallationHint: browserMode === 'none' ? '' : browserInstallationHint(browserMode, '', configEnv),
  };
}

export class ClaudeAgentService {
  constructor({ pluginRoot, dataRoot }) {
    this.pluginRoot = pluginRoot;
    this.dataRoot = dataRoot;
    this.registry = loadAgentRegistry(pluginRoot);
    this.jobs = new JobStore(dataRoot);
    this.config = new ConfigStore(dataRoot);
    this.runners = createRunnerRegistry();
    this.modelCache = new Map();
    this.ownedJobs = new Set();
    this.reconcileOrphans();
  }

  runtimeFor(agent, cwd, overrides = {}) {
    const layeredFiles = loadLayeredEnv({ pluginRoot: this.pluginRoot, cwd, processEnv: {} });
    const env = { ...layeredFiles, ...this.config.toEnv(), ...process.env };
    return resolveAgentRuntime({ agent, env, overrides, runner: overrides.runner });
  }

  writeAgentConfig({ agent, values, runner }) {
    if (runner && runner !== 'default') resolveRunner(this.runners, runner);
    const result = this.config.writeAgentConfig({ agent, values, runner });
    this.modelCache.clear();
    return result;
  }

  listAgents({ cwd = process.cwd(), runner } = {}) {
    const resolvedCwd = assertWorkingDirectory(cwd);
    return this.registry.agents.map((agent) => publicAgentView(agent, this.runtimeFor(agent, resolvedCwd, { runner })));
  }

  listRunners({ cwd = process.cwd() } = {}) {
    const resolvedCwd = assertWorkingDirectory(cwd);
    const defaultRunner = this.runtimeFor(this.registry.agents[0], resolvedCwd).runner;
    return listRunners(this.runners, defaultRunner);
  }

  async listModels({ runner, agent, cwd = process.cwd() } = {}) {
    const resolvedCwd = assertWorkingDirectory(cwd);
    const resolvedAgent = resolveAgent(this.registry, agent || this.registry.agents[0].id);
    const runtime = this.runtimeFor(resolvedAgent, resolvedCwd, { runner });
    const runnerId = runner || runtime.runner;
    resolveRunner(this.runners, runnerId);
    const command = runtime[`${runnerId}Bin`] || runnerId;
    const cacheKey = [runnerId, command, runtime.gatewayUrl, Boolean(runtime.apiKey)].join(':');
    const cached = this.modelCache.get(cacheKey);
    if (cached && Date.now() - cached.checkedAt < 60_000) return cached.value;
    try {
      const discovered = await discoverRunnerModels(runnerId, runtime, { cwd: resolvedCwd });
      const value = { runner: runnerId, ...discovered };
      this.modelCache.set(cacheKey, { checkedAt: Date.now(), value });
      return value;
    } catch (error) {
      return {
        runner: runnerId,
        models: [],
        source: 'unavailable',
        authoritative: false,
        warning: String(error?.message || error).slice(0, 512),
      };
    }
  }

  async run(input) {
    const agent = resolveAgent(this.registry, input.agent);
    const cwd = assertWorkingDirectory(input.cwd);
    const requestedRunner = input.runner || undefined;
    const configuredRuntime = this.runtimeFor(agent, cwd, { runner: requestedRunner });
    const actualRunner = requestedRunner || configuredRuntime.runner || 'claude';
    resolveRunner(this.runners, actualRunner);
    const timeout = resolveRunnerTimeout({
      configuredTimeoutMs: this.runtimeFor(agent, cwd, { runner: actualRunner }).timeoutMs,
      requestedTimeoutMs: input.timeoutMs,
      allowShorterTimeout: input.allowShorterTimeout === true,
    });
    let runtime = this.runtimeFor(agent, cwd, {
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      timeoutMs: timeout.effectiveTimeoutMs,
      maxBudgetUsd: input.maxBudgetUsd,
      outputFormat: input.outputFormat,
      runner: actualRunner,
      codexBin: input.codexBin,
      grokBin: input.grokBin,
      agyBin: input.agyBin,
    }, requestedRunner);
    runtime = { ...runtime, runner: actualRunner };
    const browser = resolveBrowserRequest(input, agent, runtime, cwd);
    if (!input.dryRun && browser.browserMode !== 'none') runtime = { ...runtime, outputFormat: 'stream-json' };
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
      runner: actualRunner,
      ...timeout,
      ...browser,
      dryRun: Boolean(input.dryRun),
    };
    if (input.background && !input.dryRun) {
      const persistOnDisconnect = Boolean(input.persistOnDisconnect);
      const leaseTimeoutMs = input.leaseTimeoutMs === undefined ? DEFAULT_BACKGROUND_LEASE_MS : Number(input.leaseTimeoutMs);
      if (!Number.isInteger(leaseTimeoutMs) || leaseTimeoutMs < 1000) throw new Error('leaseTimeoutMs must be an integer >= 1000');
      const meta = this.jobs.create({ ...request, cwd, runtimeOverrides: { ...runtimeOverrides(input, runtime), outputFormat: 'stream-json' }, persistOnDisconnect, leaseTimeoutMs });
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
      child.once('exit', () => this.ownedJobs.delete(meta.jobId));
      child.once('error', () => this.ownedJobs.delete(meta.jobId));
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
        progressRevision: meta.progressRevision || 0,
        phase: meta.phase || 'starting',
        nextPollSeconds: POLL_SCHEDULE_SECONDS[0],
        pollAttempt: 0,
      };
    }
    if (input.dryRun) return await runAgent({ runnerRegistry: this.runners, runner: actualRunner, pluginRoot: this.pluginRoot, agent, runtime, request, cwd, signal: input.signal });

    const meta = this.jobs.create({ ...request, cwd, runtimeOverrides: runtimeOverrides(input, runtime), persistOnDisconnect: false, mode: 'foreground' });
    this.jobs.writeMeta(meta.jobId, { status: 'starting', mode: 'foreground', persistOnDisconnect: false });
    this.ownedJobs.add(meta.jobId);
    let result;
    try {
      this.jobs.writeMeta(meta.jobId, { status: 'running', startedAt: new Date().toISOString() });
      result = await runAgent({
        runnerRegistry: this.runners,
        runner: actualRunner,
        pluginRoot: this.pluginRoot,
        onSpawn: ({ pid, processGroupId }) => {
          const current = this.jobs.get(meta.jobId);
          this.jobs.writeMeta(meta.jobId, { runnerPid: pid, runnerProcessGroupId: processGroupId, runnerOwnerPid: process.pid });
          if (current.status === 'cancelled') signalProcessGroup(processGroupId || pid, 'SIGTERM');
        },
        agent,
        runtime,
        request,
        cwd,
        signal: input.signal,
        onProgress: (progress) => {
          const { event, ...compactProgress } = progress;
          if (event) this.jobs.appendEvent(meta.jobId, {
            at: progress.lastActivityAt || new Date().toISOString(),
            ...event,
          });
          this.jobs.writeProgress(meta.jobId, compactProgress);
        },
      });
    } catch (error) {
      result = { ok: false, role: agent.id, agent: agent.id, runner: actualRunner, model: runtime.model, capabilitiesUsed: [], planSha256: request.planSha256, cwd, error: error.message };
    }
    const current = this.jobs.get(meta.jobId);
    const externallyCancelled = current.status === 'cancelled';
    if (externallyCancelled) {
      result = {
        ...result,
        ok: false,
        cancelled: true,
        cancellationReason: current.cancellationReason || result.cancellationReason || 'user_requested',
      };
    }
    const status = externallyCancelled ? 'cancelled' : statusForResult(result);
    const stored = { ...result, jobId: meta.jobId, status };
    this.jobs.writeProgress(meta.jobId, {
      phase: status,
      verificationState: result.ok ? 'passed' : (result.cancelled ? 'cancelled' : 'failed'),
    });
    this.jobs.writeResult(meta.jobId, stored);
    this.jobs.writeMeta(meta.jobId, {
      status,
      finishedAt: result.finishedAt || new Date().toISOString(),
      exitCode: result.exitCode,
      sessionId: result.sessionId || null,
      durationMs: result.durationMs,
      turns: result.turns,
      costUsd: result.costUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      error: result.error,
      cancellationReason: result.cancellationReason,
    });
    this.ownedJobs.delete(meta.jobId);
    return stored;
  }

  status(jobId, { full = false, limit = 5, sinceRevision, pollAttempt = 0 } = {}) {
    let value;
    if (jobId) value = this.jobs.get(jobId);
    else value = this.jobs.list(limit);
    if (full) return value;
    if (Array.isArray(value)) return capStatusList(value.map((meta) => compactMeta({ ...meta, ...pollStatus(meta, { sinceRevision, pollAttempt }) })));
    return compactMeta({ ...value, ...pollStatus(value, { sinceRevision, pollAttempt }) });
  }

  async wait(jobId, { signal, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, maxTextChars = DEFAULT_RESULT_TEXT_CHARS } = {}) {
    const id = String(jobId || '').trim();
    if (!id) throw new Error('job_id is required.');
    const timeout = Number(timeoutMs);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > MAX_WAIT_TIMEOUT_MS) {
      throw new Error(`timeout_ms must be an integer between 1000 and ${MAX_WAIT_TIMEOUT_MS}.`);
    }
    const deadline = Date.now() + timeout;
    while (true) {
      const meta = this.jobs.get(id);
      if (!ACTIVE_JOB_STATUSES.has(meta.status)) {
        const stored = this.jobs.result(id);
        if (stored.result !== null && stored.result !== undefined) return this.result(id, { maxTextChars });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          meta: compactMeta(this.jobs.get(id)),
          result: {
            status: 'waiting',
            jobId: id,
            waitTimedOut: true,
            summary: '等待超时；任务仍在运行，请稍后再次调用 job_wait。',
          },
        };
      }
      await waitForDelay(Math.min(1000, remaining), signal);
    }
  }

  result(jobId, { full = false, maxTextChars = DEFAULT_RESULT_TEXT_CHARS } = {}) {
    if (!jobId) {
      const [latest] = this.jobs.list(1);
      if (!latest) return { meta: null, result: null };
      jobId = latest.jobId;
    }
    const stored = this.jobs.result(jobId);
    if (full) return stored;
    const meta = compactMeta(stored.meta);
    const resultBudget = Math.max(1024, MAX_COMPACT_RESULT_BYTES - jsonBytes({ meta, result: null }) - 32);
    return { meta, result: compactResult({ ...stored.result, jobId: stored.meta.jobId, status: stored.meta.status }, maxTextChars, resultBudget) };
  }

  cancel(jobId, reason = 'user_requested') {
    const meta = this.jobs.get(jobId);
    if (!ACTIVE_JOB_STATUSES.has(meta.status)) return { ok: false, jobId, status: meta.status, message: 'Job is not active.' };
    const pid = meta.runnerPid || (meta.mode === 'foreground' ? null : meta.pid);
    const processGroupId = meta.runnerProcessGroupId || pid;
    const alive = isProcessAlive(pid);
    const signalled = alive && signalProcessGroup(processGroupId, 'SIGTERM');
    const cancellationReason = reason || (alive ? 'user_requested' : 'orphaned_process');
    const next = this.jobs.writeMeta(jobId, {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      cancellationReason,
    });
    this.ownedJobs.delete(jobId);
    return { ok: true, jobId, status: next.status, cancellationReason, signalled, orphaned: !alive };
  }

  reconcileOrphans({ graceMs = 5000 } = {}) {
    const now = Date.now();
    const reconciled = [];
    for (const meta of this.jobs.list(100)) {
      if (!ACTIVE_JOB_STATUSES.has(meta.status) || meta.persistOnDisconnect) continue;
      const age = now - Date.parse(meta.startedAt || meta.createdAt || now);
      const pid = meta.runnerPid || (meta.mode === 'foreground' ? null : meta.pid);
      if (!pid && age < graceMs) continue;
      if (pid && isProcessAlive(pid)) continue;
      const next = this.jobs.writeMeta(meta.jobId, {
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
        cancellationReason: 'orphaned_process',
      });
      reconciled.push(next.jobId);
    }
    return { ok: true, reconciled };
  }

  deleteJob(jobId) {
    const meta = this.jobs.get(jobId);
    if (ACTIVE_JOB_STATUSES.has(meta.status)) throw new Error('运行中的任务不能删除，请先取消任务。');
    return this.jobs.delete(jobId);
  }

  cleanupJobs(options) {
    return this.jobs.cleanupTerminal(options);
  }

  dispose(reason = 'mcp_disconnected') {
    for (const jobId of this.ownedJobs) {
      try {
        const meta = this.jobs.get(jobId);
        if (!meta.persistOnDisconnect && ACTIVE_JOB_STATUSES.has(meta.status)) {
          this.cancel(jobId, reason);
        }
      } catch {}
    }
  }
}
