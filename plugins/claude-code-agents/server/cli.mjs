#!/usr/bin/env node
import fs from 'node:fs';
import { resolvePluginRoot, resolveDataRoot } from './lib/paths.mjs';
import { ClaudeAgentService } from './lib/service.mjs';

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const values = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) { values._.push(token); continue; }
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i += 1; }
  }
  return { command, values };
}

function readMaybeFile(value) {
  if (!value) return '';
  if (value.startsWith('@')) return fs.readFileSync(value.slice(1), 'utf8');
  return value;
}

const { command, values } = parseArgs(process.argv.slice(2));
const pluginRoot = resolvePluginRoot(import.meta.url);
const dataRoot = resolveDataRoot(pluginRoot);
const service = new ClaudeAgentService({ pluginRoot, dataRoot });

try {
  let result;
  if (command === 'list') result = service.listAgents({ cwd: values.cwd });
  else if (command === 'run') result = await service.run({
    agent: values.agent,
    runner: values.runner,
    task: readMaybeFile(values.task),
    plan: readMaybeFile(values.plan),
    acceptanceCriteria: readMaybeFile(values.acceptanceCriteria),
    context: readMaybeFile(values.context),
    cwd: values.cwd || process.cwd(),
    background: Boolean(values.background),
    persistOnDisconnect: Boolean(values.persistOnDisconnect),
    leaseTimeoutMs: values.leaseTimeoutMs ? Number(values.leaseTimeoutMs) : undefined,
    dryRun: Boolean(values.dryRun),
    model: values.model,
    effort: values.effort,
    permissionMode: values.permissionMode,
    outputFormat: values.outputFormat,
    codexBin: values.codexBin,
    grokBin: values.grokBin,
    agyBin: values.agyBin,
    timeoutMs: values.timeoutMs ? Number(values.timeoutMs) : undefined,
    maxBudgetUsd: values.maxBudgetUsd ? Number(values.maxBudgetUsd) : undefined,
    browserMode: values.browserMode,
    browserMcpProfile: values.browserMcpProfile,
    resume: values.resume,
    sessionId: values.sessionId,
  });
  else if (command === 'status') result = service.status(values.jobId || values._[0], { full: Boolean(values.full), limit: values.limit ? Number(values.limit) : undefined });
  else if (command === 'result') result = service.result(values.jobId || values._[0], { full: Boolean(values.full), maxTextChars: values.maxTextChars ? Number(values.maxTextChars) : undefined });
  else if (command === 'cancel') result = service.cancel(values.jobId || values._[0]);
  else if (command === 'cleanup') result = service.cleanupJobs({ before: values.before, limit: values.limit ? Number(values.limit) : undefined });
  else if (command === 'dashboard') {
    const { startDashboard } = await import('./dashboard.mjs');
    const running = await startDashboard({ pluginRoot, service, port: values.port ? Number(values.port) : 0, open: Boolean(values.open) });
    console.log(running.url);
    await new Promise(() => {});
  }
  else {
    console.log(`Usage:
  cli.mjs list [--cwd PATH]
  cli.mjs run --agent ID --runner claude|codex --task TEXT|@FILE --plan TEXT|@FILE [--cwd PATH] [--background] [--browser-mode MODE] [--browser-mcp-profile NAME] [--dry-run]
  cli.mjs status [JOB_ID] [--full] [--limit 5]
  cli.mjs result [JOB_ID] [--full] [--max-text-chars 12000]
  cli.mjs cancel JOB_ID
  cli.mjs cleanup --before ISO_DATE [--limit 100]
  cli.mjs dashboard [--port PORT] [--open]`);
    process.exit(0);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result?.ok === false) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
