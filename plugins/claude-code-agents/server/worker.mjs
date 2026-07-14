#!/usr/bin/env node
import { resolvePluginRoot, resolveDataRoot } from './lib/paths.mjs';
import { ClaudeAgentService } from './lib/service.mjs';
import { resolveAgent } from './lib/agents.mjs';
import { runClaude } from './lib/claude.mjs';

const jobId = process.argv[2];
if (!jobId) process.exit(2);
const pluginRoot = resolvePluginRoot(import.meta.url);
const dataRoot = resolveDataRoot(pluginRoot);
const service = new ClaudeAgentService({ pluginRoot, dataRoot });
const controller = new AbortController();
let stopReason = '';
let leaseTimer;

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
  const runtime = service.runtimeFor(agent, stored.cwd, stored.runtimeOverrides || {});
  service.jobs.writeMeta(jobId, { status: 'running', pid: process.pid, startedAt: new Date().toISOString() });
  if (!stored.persistOnDisconnect && stored.leaseTimeoutMs) {
    const intervalMs = Math.min(5000, Math.max(250, Math.floor(stored.leaseTimeoutMs / 4)));
    leaseTimer = setInterval(() => {
      const meta = service.jobs.get(jobId);
      if (meta.leaseExpiresAt && Date.now() >= Date.parse(meta.leaseExpiresAt)) requestStop('lease_expired');
    }, intervalMs);
  }
  const result = await runClaude({
    pluginRoot,
    agent,
    runtime,
    cwd: stored.cwd,
    request: stored,
    signal: controller.signal,
  });
  clearInterval(leaseTimer);
  const current = service.jobs.get(jobId);
  const cancelled = result.cancelled || current.status === 'cancelled' || Boolean(stopReason);
  const cancellationReason = current.cancellationReason || stopReason || result.cancellationReason;
  service.jobs.writeResult(jobId, { ...result, cancelled, cancellationReason });
  service.jobs.writeMeta(jobId, {
    status: cancelled ? 'cancelled' : (result.ok ? 'completed' : 'failed'),
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    sessionId: result.sessionId || null,
    cancellationReason,
  });
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  clearInterval(leaseTimer);
  service.jobs.writeResult(jobId, { ok: false, error: error.message, stack: error.stack });
  service.jobs.writeMeta(jobId, { status: 'failed', finishedAt: new Date().toISOString(), error: error.message });
  process.exit(1);
}
