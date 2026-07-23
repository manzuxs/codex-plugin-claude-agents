#!/usr/bin/env node
import { resolvePluginRoot, resolveDataRoot } from './lib/paths.mjs';
import { ClaudeAgentService } from './lib/service.mjs';
import { resolveAgent } from './lib/agents.mjs';
import { runAgent } from './lib/execution/run-agent.mjs';

const jobId = process.argv[2];
if (!jobId) process.exit(2);
const pluginRoot = resolvePluginRoot(import.meta.url);
const dataRoot = resolveDataRoot(pluginRoot);
const service = new ClaudeAgentService({ pluginRoot, dataRoot });
const controller = new AbortController();
let stopReason = '';
let leaseTimer;
let reportProgress = () => {};

function requestStop(reason) {
  if (controller.signal.aborted) return;
  stopReason = reason;
  controller.abort(reason);
}

process.once('SIGTERM', () => requestStop('job_cancelled'));
process.once('SIGINT', () => requestStop('job_cancelled'));

try {
  const stored = service.jobs.readJson(jobId, 'request.json');
  if (!stored) throw new Error(`Missing request for ${jobId}`);
  const agent = resolveAgent(service.registry, stored.agent);
  const requestedRunner = stored.runner || stored.runtimeOverrides?.runner || 'claude';
  const runtime = service.runtimeFor(agent, stored.cwd, { ...(stored.runtimeOverrides || {}), runner: requestedRunner, outputFormat: 'stream-json' });
  const startedMs = Date.now();
  let lastWriteMs = startedMs;
  let lastPhase = 'starting';
  let turnsObserved = 0;
  let lastTool = null;
  let lastToolSummary = null;
  let browserCapability = null;
  let browserBackend = null;
  let installationHint = null;
  let lastLeaseRenewalMs = startedMs;
  reportProgress = (progress = {}, force = false) => {
    if (progress.event) service.jobs.appendEvent(jobId, {
      at: progress.lastActivityAt || new Date().toISOString(),
      ...progress.event,
    });
    if (progress.turnObserved) turnsObserved += 1;
    if (Number.isFinite(progress.turnsObserved)) turnsObserved = Math.max(turnsObserved, progress.turnsObserved);
    if (progress.lastTool) lastTool = progress.lastTool;
    if (progress.lastToolSummary) lastToolSummary = String(progress.lastToolSummary).slice(0, 256);
    if (progress.browserCapability) browserCapability = String(progress.browserCapability).slice(0, 32);
    if (progress.browserBackend) browserBackend = String(progress.browserBackend).slice(0, 128);
    if (progress.installationHint) installationHint = String(progress.installationHint).slice(0, 512);
    const phase = progress.phase || lastPhase;
    const now = Date.now();
    if (!stored.persistOnDisconnect && stored.leaseTimeoutMs && now - lastLeaseRenewalMs >= Math.max(100, Math.floor(stored.leaseTimeoutMs / 3))) {
      service.jobs.renewLease(jobId);
      lastLeaseRenewalMs = now;
    }
    if (!force && phase === lastPhase && now - lastWriteMs < 5000) return;
    const patch = {
      phase,
      elapsedMs: now - startedMs,
      turnsObserved,
      lastActivityAt: progress.lastActivityAt || new Date(now).toISOString(),
      lastTool,
      lastToolSummary,
      browserCapability,
      browserBackend,
      installationHint,
    };
    if (progress.verificationState !== undefined) patch.verificationState = progress.verificationState;
    service.jobs.writeProgress(jobId, patch);
    lastWriteMs = now;
    lastPhase = phase;
  };
  service.jobs.writeMeta(jobId, {
    status: 'running',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    phase: 'starting',
    verificationState: 'pending',
  });
  if (!stored.persistOnDisconnect && stored.leaseTimeoutMs) {
    service.jobs.renewLease(jobId);
    lastLeaseRenewalMs = Date.now();
  }
  if (!stored.persistOnDisconnect && stored.leaseTimeoutMs) {
    const intervalMs = Math.min(5000, Math.max(250, Math.floor(stored.leaseTimeoutMs / 4)));
    leaseTimer = setInterval(() => {
      const meta = service.jobs.get(jobId);
      if (meta.leaseExpiresAt && Date.now() >= Date.parse(meta.leaseExpiresAt)) requestStop('lease_expired');
    }, intervalMs);
  }
  const result = await runAgent({
    runnerRegistry: service.runners,
    runner: requestedRunner,
    pluginRoot,
    agent,
    runtime,
    cwd: stored.cwd,
    request: stored,
    signal: controller.signal,
    onSpawn: ({ pid, processGroupId }) => service.jobs.writeMeta(jobId, { runnerPid: pid, runnerProcessGroupId: processGroupId, runnerOwnerPid: process.pid }),
    onProgress: (progress) => reportProgress(progress),
  });
  clearInterval(leaseTimer);
  const current = service.jobs.get(jobId);
  const cancelled = result.cancelled || current.status === 'cancelled' || Boolean(stopReason);
  const cancellationReason = current.cancellationReason || stopReason || result.cancellationReason;
  const status = cancelled ? 'cancelled' : (result.blocked ? 'blocked' : (result.ok ? 'completed' : 'failed'));
  reportProgress({
    phase: status,
    turnsObserved: result.turns,
    verificationState: cancelled ? 'cancelled' : (result.ok ? 'passed' : 'failed'),
    browserCapability: result.browserCapability,
    browserBackend: result.browserBackend,
    installationHint: result.installationHint,
  }, true);
  service.jobs.writeResult(jobId, { ...result, role: result.role || stored.role || stored.agent, agent: result.agent || stored.agent, runner: result.runner || requestedRunner, model: result.model || runtime.model, capabilitiesUsed: result.capabilitiesUsed || [], cancelled, cancellationReason });
  service.jobs.writeMeta(jobId, {
    status,
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    sessionId: result.sessionId || null,
    durationMs: result.durationMs,
    turns: result.turns,
    costUsd: result.costUsd,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    error: result.error,
    cancellationReason,
    role: result.role || stored.role || stored.agent,
    runner: result.runner || requestedRunner,
    model: result.model || runtime.model,
    capabilitiesUsed: result.capabilitiesUsed || [],
  });
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  clearInterval(leaseTimer);
  try { reportProgress({ phase: 'failed', verificationState: 'failed' }, true); } catch {}
  service.jobs.writeResult(jobId, { ok: false, error: error.message, stack: error.stack });
  service.jobs.writeMeta(jobId, { status: 'failed', finishedAt: new Date().toISOString(), error: error.message });
  process.exit(1);
}
