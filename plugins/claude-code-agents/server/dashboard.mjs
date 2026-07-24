import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveAgent } from './lib/agents.mjs';
import { RUNNER_CAPABILITIES } from './lib/runners/capabilities.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png' };
const MAX_BODY_BYTES = 256 * 1024;
const MARKETPLACE_NAME = 'local-multi-cli-agents';
const PLUGIN_SELECTOR = `multi-cli-agents@${MARKETPLACE_NAME}`;

export function validateRunnerConfig(runnerId, values = {}) {
  const runner = RUNNER_CAPABILITIES[runnerId];
  if (!runner) throw new Error(`Unknown runner "${runnerId}".`);
  const configurable = new Set(runner.supports.configFields || []);
  for (const [field, value] of Object.entries(values)) {
    if (value !== undefined && value !== '' && !configurable.has(field)) {
      throw new Error(`${runner.name} does not expose ${field} as a configurable field.`);
    }
  }
  for (const field of ['effort', 'permissionMode', 'outputFormat']) {
    const value = values[field];
    const supported = runner.supports[field] || [];
    if (value !== undefined && value !== '' && !supported.includes(String(value))) {
      throw new Error(`${runner.name} ${field} must be one of: ${supported.join(', ')}; received ${value}`);
    }
  }
}

function tomlSection(content, header) {
  const lines = String(content || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return '';
  const endOffset = lines.slice(start + 1).findIndex((line) => line.trim().startsWith('['));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join('\n');
}

export function parseCodexPluginConfig(content) {
  const marketplace = tomlSection(content, `[marketplaces.${MARKETPLACE_NAME}]`);
  const plugin = tomlSection(content, `[plugins."${PLUGIN_SELECTOR}"]`);
  return {
    marketplaceAvailable: Boolean(marketplace),
    marketplaceSourceType: marketplace.match(/^source_type\s*=\s*["']([^"']+)["']/m)?.[1],
    installed: Boolean(plugin) && !/^enabled\s*=\s*false\s*$/m.test(plugin),
  };
}

function configuredInstallationState() {
  try {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    return parseCodexPluginConfig(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
  } catch {
    return { marketplaceAvailable: false, marketplaceSourceType: undefined, installed: false };
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) reject(new Error('Request body is too large.'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Request body must be valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function runCommand(command, args, cwd, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-12_000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
    child.once('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

async function installationState(repoRoot) {
  const [listed, marketplaces] = await Promise.all([
    runCommand('codex', ['plugin', 'list'], repoRoot, 15_000),
    runCommand('codex', ['plugin', 'marketplace', 'list', '--json'], repoRoot, 15_000),
  ]);
  const output = `${listed.stdout || ''}\n${listed.stderr || ''}`;
  let marketplace;
  try {
    marketplace = JSON.parse(marketplaces.stdout).marketplaces?.find((item) => item.name === MARKETPLACE_NAME);
  } catch {}
  const pluginLine = output.split('\n').find((line) => line.trim().startsWith(PLUGIN_SELECTOR));
  const configured = configuredInstallationState();
  return {
    codexAvailable: listed.error === undefined,
    marketplaceAvailable: Boolean(marketplace) || configured.marketplaceAvailable,
    marketplaceSourceType: marketplace?.marketplaceSource?.sourceType || configured.marketplaceSourceType,
    installed: pluginLine?.includes('installed, enabled') || configured.installed,
    installedVersion: pluginLine?.match(/installed, enabled\s+(\S+)/)?.[1],
  };
}

async function installPlugin(repoRoot) {
  const current = await installationState(repoRoot);
  if (current.installed) {
    const marketplace = current.marketplaceSourceType === 'local'
      ? { ok: true, skipped: true, stdout: '本地 marketplace 直接使用当前工作区版本。' }
      : await runCommand('codex', ['plugin', 'marketplace', 'upgrade', MARKETPLACE_NAME], repoRoot);
    if (!marketplace.ok) return { ok: false, step: 'marketplace', ...marketplace, error: marketplace.error || marketplace.stderr || 'Marketplace 更新失败。', installation: current };
    const plugin = await runCommand('codex', ['plugin', 'add', PLUGIN_SELECTOR], repoRoot);
    const pluginOk = plugin.ok || /already installed|installed, enabled/i.test(`${plugin.stdout} ${plugin.stderr}`);
    return { ok: pluginOk, updateChecked: true, marketplace, plugin: { ...plugin, ok: pluginOk }, error: pluginOk ? undefined : plugin.error || plugin.stderr || '插件更新失败。', installation: await installationState(repoRoot) };
  }
  const marketplace = await runCommand('codex', ['plugin', 'marketplace', 'add', repoRoot], repoRoot);
  if (!marketplace.ok && !/already|exists|configured/i.test(`${marketplace.stdout} ${marketplace.stderr}`)) return { ok: false, step: 'marketplace', ...marketplace, error: marketplace.error || marketplace.stderr || 'Marketplace 注册失败。' };
  const plugin = await runCommand('codex', ['plugin', 'add', PLUGIN_SELECTOR], repoRoot);
  const pluginOk = plugin.ok || /already installed|installed, enabled/i.test(`${plugin.stdout} ${plugin.stderr}`);
  return { ok: pluginOk, step: 'plugin', marketplace, plugin: { ...plugin, ok: pluginOk }, error: pluginOk ? undefined : plugin.error || plugin.stderr || '插件安装失败。', installation: await installationState(repoRoot) };
}

export function openDashboardBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'cmd' : 'xdg-open');
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { shell: false, stdio: 'ignore', detached: true });
  child.unref();
}

export async function startDashboard({ service, pluginRoot, port = 0, open = false } = {}) {
  const dashboardRoot = path.join(pluginRoot, 'dashboard');
  const repoRoot = path.resolve(pluginRoot, '..', '..');
  const token = crypto.randomBytes(24).toString('hex');
  let installationCache = { value: null, checkedAt: 0 };
  const readInstallation = async (force = false) => {
    if (!force && installationCache.value && Date.now() - installationCache.checkedAt < 15_000) return installationCache.value;
    installationCache = { value: await installationState(repoRoot), checkedAt: Date.now() };
    return installationCache.value;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      const tokenAccepted = req.headers['x-claude-agents-token'] === token || (url.pathname.endsWith('/stream') && url.searchParams.get('token') === token);
      if (url.pathname.startsWith('/api/') && !tokenAccepted) return json(res, 403, { ok: false, error: 'Invalid dashboard token.' });
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        const cwd = url.searchParams.get('cwd') || repoRoot;
        const runners = service.listRunners ? service.listRunners({ cwd }) : [];
        const agents = service.listAgents({ cwd });
        const configuredByAgent = new Map(agents.map((item) => {
          const resolved = resolveAgent(service.registry, item.id);
          const configuredByRunner = Object.fromEntries(runners.map((runner) => [
            runner.id,
            service.config.effectiveFor(resolved, service.runtimeFor(resolved, cwd, { runner: runner.id })),
          ]));
          const configured = configuredByRunner[item.runtime?.runner] || item.configured || configuredByRunner[runners.find((runner) => runner.default)?.id];
          return [item.id, { configured, configuredByRunner }];
        }));
        return json(res, 200, {
          runners,
          agents: agents.map((agent) => ({ ...agent, ...configuredByAgent.get(agent.id) })),
          jobs: service.status(undefined, { limit: 100 }), cwd, configFile: service.config.filePath,
          installation: await readInstallation(),
        });
      }
      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/models') {
        const receivedBody = req.method === 'POST' ? await readBody(req) : {};
        if (!receivedBody || typeof receivedBody !== 'object' || Array.isArray(receivedBody)) throw new Error('Model discovery body must be a JSON object.');
        const body = receivedBody;
        const cwd = body.cwd || url.searchParams.get('cwd') || repoRoot;
        const runner = body.runner || url.searchParams.get('runner') || undefined;
        const agent = body.agent || url.searchParams.get('agent') || undefined;
        const gatewayUrl = req.method === 'POST' ? (Object.hasOwn(body, 'gatewayUrl') ? body.gatewayUrl : undefined) : (url.searchParams.has('gateway') ? url.searchParams.get('gateway') : undefined);
        const apiKey = req.method === 'POST' ? body.apiKey : undefined;
        const apiKeyKind = req.method === 'POST' ? body.apiKeyKind : undefined;
        if (gatewayUrl) {
          let parsed;
          try { parsed = new URL(gatewayUrl); } catch { throw new Error('gatewayUrl must be a valid http(s) URL.'); }
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('gatewayUrl must be a valid http(s) URL.');
        }
        if (apiKeyKind !== undefined && !['auth_token', 'api_key'].includes(String(apiKeyKind))) throw new Error('apiKeyKind must be auth_token or api_key.');
        const models = service.listModels
          ? await service.listModels({ runner, agent, cwd, gatewayUrl, apiKey, apiKeyKind })
          : { runner, models: [], source: 'unavailable', authoritative: false };
        return json(res, 200, models);
      }
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readBody(req);
        const agent = resolveAgent(service.registry, body.agent);
        const runner = body.runner || 'default';
        const targetRunner = runner === 'default' ? service.runtimeFor(agent, body.cwd || repoRoot).runner || 'claude' : runner;
        validateRunnerConfig(targetRunner, body.values);
        if (runner !== 'default') service.writeAgentConfig({ agent, runner: 'default', values: { runner } });
        const stored = service.writeAgentConfig({ agent, runner, values: body.values });
        return json(res, 200, { ok: true, database: stored.database, agents: service.listAgents({ cwd: body.cwd || repoRoot }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const body = await readBody(req);
        const result = await service.run({ ...body, cwd: body.cwd || repoRoot, background: true, outputFormat: 'stream-json' });
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname.match(/^\/api\/jobs\/[^/]+\/cancel$/)) {
        const jobId = url.pathname.split('/')[3];
        return json(res, 200, service.cancel(jobId));
      }
      if (req.method === 'DELETE' && url.pathname.match(/^\/api\/jobs\/[^/]+$/)) {
        const jobId = url.pathname.split('/')[3];
        return json(res, 200, service.deleteJob(jobId));
      }
      if (req.method === 'GET' && url.pathname.match(/^\/api\/jobs\/[^/]+\/stream$/)) {
        if (url.searchParams.get('token') !== token) return json(res, 403, { ok: false, error: 'Invalid dashboard token.' });
        const jobId = url.pathname.split('/')[3];
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        let cursor = Math.max(0, Number(url.searchParams.get('after')) || 0);
        const send = () => {
          try {
            const payload = { meta: service.status(jobId), ...service.jobs.readEvents(jobId, { after: cursor, limit: 250 }) };
            cursor = payload.cursor;
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          } catch (error) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
          }
        };
        send();
        const timer = setInterval(send, 500);
        req.on('close', () => clearInterval(timer));
        return;
      }
      if (req.method === 'GET' && url.pathname.match(/^\/api\/jobs\/[^/]+\/events$/)) {
        const jobId = url.pathname.split('/')[3];
        return json(res, 200, { meta: service.status(jobId), ...service.jobs.readEvents(jobId, { after: url.searchParams.get('after'), limit: 250 }) });
      }
      if (req.method === 'GET' && url.pathname.match(/^\/api\/jobs\/[^/]+\/result$/)) {
        const jobId = url.pathname.split('/')[3];
        return json(res, 200, service.result(jobId));
      }
      if (req.method === 'POST' && url.pathname === '/api/install') {
        const result = await installPlugin(repoRoot);
        installationCache = { value: result.installation || await installationState(repoRoot), checkedAt: Date.now() };
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method !== 'GET') return json(res, 404, { ok: false, error: 'Not found.' });
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const filePath = path.resolve(dashboardRoot, relative);
      if (!filePath.startsWith(`${dashboardRoot}${path.sep}`) && filePath !== path.join(dashboardRoot, 'index.html')) return json(res, 403, { ok: false, error: 'Forbidden.' });
      let content = fs.readFileSync(filePath);
      if (relative === 'index.html') content = Buffer.from(content.toString('utf8').replace('__DASHBOARD_TOKEN__', token));
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(content);
    } catch (error) {
      json(res, error.code === 'ENOENT' ? 404 : 400, { ok: false, error: error.message });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  if (open) openDashboardBrowser(url);
  return { server, url };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { resolvePluginRoot, resolveDataRoot } = await import('./lib/paths.mjs');
  const { ClaudeAgentService } = await import('./lib/service.mjs');
  const pluginRoot = resolvePluginRoot(import.meta.url);
  const service = new ClaudeAgentService({ pluginRoot, dataRoot: resolveDataRoot(pluginRoot) });
  const requestedPort = Number(process.env.CLAUDE_AGENTS_DASHBOARD_PORT || process.argv[2] || 0);
  const running = await startDashboard({ service, pluginRoot, port: requestedPort, open: process.argv.includes('--open') });
  console.log(`Multi-CLI Agents dashboard: ${running.url}`);
}
