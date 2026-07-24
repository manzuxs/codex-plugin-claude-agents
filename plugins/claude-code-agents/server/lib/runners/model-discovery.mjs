import { spawn } from 'node:child_process';

const MAX_OUTPUT_CHARS = 1024 * 1024;

function safeError(error, stderr = '') {
  return String(error?.message || stderr || error || 'Model discovery failed.').trim().slice(0, 512);
}

function runCommand(command, args, { cwd, env, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const append = (current, chunk) => `${current}${chunk}`.slice(0, MAX_OUTPUT_CHARS);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => finish(new Error(safeError(error))));
    child.on('close', (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(new Error(safeError(`Model discovery exited with code ${code}`, stderr)));
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`Model discovery timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
}

function modelRecord(id, values = {}) {
  return {
    id,
    displayName: values.displayName || id,
    description: values.description || '',
    isDefault: values.isDefault === true,
    supportedEfforts: Array.isArray(values.supportedEfforts) ? values.supportedEfforts : [],
    defaultEffort: values.defaultEffort || null,
  };
}

export function parseGrokModels(output) {
  const text = String(output || '');
  const defaultModel = text.match(/^Default model:\s*(\S+)/m)?.[1] || '';
  const section = text.split(/^Available models:\s*$/m)[1] || '';
  const ids = section.split(/\r?\n/)
    .map((line) => line.match(/^\s*\*?\s*([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\s+\(default\))?\s*$/)?.[1])
    .filter(Boolean);
  return [...new Set(ids)].map((id) => modelRecord(id, { isDefault: id === defaultModel }));
}

export function parseAgyModels(output) {
  const ids = String(output || '').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(line));
  return [...new Set(ids)].map((id) => modelRecord(id));
}

export function parseClaudeModelExamples(output) {
  const lines = String(output || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /--model\s+<model>/.test(line));
  if (start < 0) return [];
  const block = lines.slice(start, start + 6).join('\n');
  const ids = [...block.matchAll(/'([a-zA-Z0-9][a-zA-Z0-9._-]*)'/g)].map((match) => match[1]);
  return [...new Set(ids)].map((id) => modelRecord(id, { isDefault: id === 'sonnet' }));
}

export function parseCodexModels(result) {
  return (Array.isArray(result?.data) ? result.data : []).map((item) => modelRecord(
    String(item.id || item.model),
    {
      displayName: item.displayName,
      description: item.description,
      isDefault: item.isDefault,
      supportedEfforts: (item.supportedReasoningEfforts || []).map((entry) => entry.reasoningEffort).filter(Boolean),
      defaultEffort: item.defaultReasoningEffort,
    },
  ));
}

function discoverCodexModels(command, { cwd, env, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, ['app-server', '--stdio'], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(result);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS) return finish(new Error('Codex model discovery output exceeded its limit.'));
      let index;
      while ((index = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, index);
        stdout = stdout.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          send({ method: 'initialized', params: {} });
          send({ method: 'model/list', id: 2, params: { limit: 100 } });
        } else if (message.id === 1 && message.error) {
          finish(new Error(safeError(message.error?.message || message.error, stderr)));
        } else if (message.id === 2 && message.result) {
          finish(null, parseCodexModels(message.result));
        } else if (message.id === 2 && message.error) {
          finish(new Error(safeError(message.error?.message || message.error, stderr)));
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(0, 4096); });
    child.on('error', (error) => finish(new Error(safeError(error))));
    child.on('close', (code) => {
      if (!settled) finish(new Error(safeError(`Codex app-server exited with code ${code}`, stderr)));
    });
    const timer = setTimeout(() => finish(new Error(`Codex model discovery timed out after ${timeoutMs}ms.`)), timeoutMs);
    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'multi_cli_agents', title: 'Multi-CLI Agents', version: '0.2.0' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

function discoveryEnv(runnerId, runtime) {
  const env = { ...process.env, ...runtime.extraEnv };
  if (runnerId === 'claude') {
    if (runtime.gatewayUrl) env.ANTHROPIC_BASE_URL = runtime.gatewayUrl;
    if (runtime.apiKey) env[runtime.apiKeyKind === 'api_key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] = runtime.apiKey;
  } else if (runnerId === 'grok') {
    if (runtime.gatewayUrl) env.XAI_API_BASE_URL = runtime.gatewayUrl;
    if (runtime.apiKey) env.XAI_API_KEY = runtime.apiKey;
  } else if (runnerId === 'agy') {
    if (runtime.gatewayUrl) env.AGY_BASE_URL = runtime.gatewayUrl;
    if (runtime.apiKey) env.AGY_API_KEY = runtime.apiKey;
  }
  return env;
}

export async function discoverRunnerModels(runnerId, runtime, { cwd, timeoutMs = 8000 } = {}) {
  const env = discoveryEnv(runnerId, runtime);
  if (runnerId === 'codex') {
    return { models: await discoverCodexModels(runtime.codexBin, { cwd, env, timeoutMs }), source: 'codex-app-server', authoritative: true };
  }
  if (runnerId === 'grok') {
    const result = await runCommand(runtime.grokBin, ['models'], { cwd, env, timeoutMs });
    return { models: parseGrokModels(`${result.stdout}\n${result.stderr}`), source: 'grok-models', authoritative: true };
  }
  if (runnerId === 'agy') {
    const result = await runCommand(runtime.agyBin, ['models'], { cwd, env, timeoutMs });
    return { models: parseAgyModels(result.stdout), source: 'agy-models', authoritative: true };
  }
  if (runnerId === 'claude') {
    const result = await runCommand(runtime.claudeBin, ['--help'], { cwd, env, timeoutMs });
    return { models: parseClaudeModelExamples(`${result.stdout}\n${result.stderr}`), source: 'claude-help-examples', authoritative: false };
  }
  throw new Error(`Unknown runner "${runnerId}".`);
}
