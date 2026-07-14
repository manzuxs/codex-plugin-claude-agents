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

try {
  const stored = service.jobs.readJson(jobId, 'request.json');
  if (!stored) throw new Error(`Missing request for ${jobId}`);
  const agent = resolveAgent(service.registry, stored.agent);
  const runtime = service.runtimeFor(agent, stored.cwd, stored.runtimeOverrides || {});
  service.jobs.writeMeta(jobId, { status: 'running', pid: process.pid, startedAt: new Date().toISOString() });
  const result = await runClaude({
    pluginRoot,
    agent,
    runtime,
    cwd: stored.cwd,
    request: stored,
  });
  service.jobs.writeResult(jobId, result);
  service.jobs.writeMeta(jobId, {
    status: result.ok ? 'completed' : 'failed',
    finishedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    sessionId: result.sessionId || null,
  });
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  service.jobs.writeResult(jobId, { ok: false, error: error.message, stack: error.stack });
  service.jobs.writeMeta(jobId, { status: 'failed', finishedAt: new Date().toISOString(), error: error.message });
  process.exit(1);
}
