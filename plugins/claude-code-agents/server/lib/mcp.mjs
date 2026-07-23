import { compactResult } from './service.mjs';
import { PLUGIN_VERSION } from './version.mjs';

const TOOL_DEFINITIONS = [
  {
    name: 'open_dashboard',
    description: 'Open the local Multi-CLI Agents command center in a browser. The dashboard shows role configuration, Runner history, and streaming execution events.',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'integer', minimum: 0, maximum: 65535, default: 0 }, open: { type: 'boolean', default: true } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_runners',
    description: 'List available execution runners and their declared capabilities.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_agents',
    description: 'List configured specialist roles and their non-secret runtime settings.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Repository working directory.' },
        runner: { type: 'string', enum: ['claude', 'codex', 'grok', 'agy'], description: 'Optional runner preview; omit to show the configured default.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'run_agent',
    description: 'Delegate an approved Codex implementation plan to a selected local CLI Runner and specialist role. Sequential work normally uses background=false for one server-side wait; use background=true for parallel or explicitly monitored work, then call job_wait once. A non-empty plan is mandatory.',
    inputSchema: {
      type: 'object',
      required: ['agent', 'task', 'plan'],
      properties: {
        agent: { type: 'string', description: 'Role id or alias, e.g. backend-engineer or 后端工程师. Kept as the legacy compatibility field.' },
        runner: { type: 'string', enum: ['claude', 'codex', 'grok', 'agy'], description: 'Explicit execution runner. Omit to use the configured default.' },
        task: { type: 'string', minLength: 1, description: 'The concrete implementation objective.' },
        plan: { type: 'string', minLength: 1, description: 'The plan already produced and approved by Codex.' },
        acceptanceCriteria: { type: 'string' },
        context: { type: 'string' },
        cwd: { type: 'string', description: 'Target repository. Defaults to the current directory.' },
        background: { type: 'boolean', default: false, description: 'Use false for normal sequential work so the MCP request waits once; use true only for parallel or explicitly monitored jobs.' },
        persistOnDisconnect: { type: 'boolean', default: false, description: 'Allow a background job to continue after the Codex session stops. Use only when explicitly requested.' },
        leaseTimeoutMs: { type: 'integer', minimum: 30000, maximum: 600000, default: 300000, description: 'Background job lease renewed by Worker activity. It expires when the Worker is idle or the MCP owner disconnects.' },
        dryRun: { type: 'boolean', default: false },
        codexReviewRequired: { type: 'boolean', default: true },
        resume: { type: 'string', description: 'Optional Runner session id or selector to resume when supported.' },
        sessionId: { type: 'string', description: 'Optional explicit UUID for a new Runner session when supported.' },
        model: { type: 'string', description: 'One-run override; normally loaded from .env.' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'] },
        timeoutMs: { type: 'integer', minimum: 1000 },
        maxBudgetUsd: { type: 'number', minimum: 0 },
        outputFormat: { type: 'string', enum: ['text', 'json', 'stream-json'] },
        allowedTools: { type: 'array', items: { type: 'string' } },
        disallowedTools: { type: 'array', items: { type: 'string' } },
        browserMode: {
          type: 'string',
          enum: ['none', 'repository', 'chrome', 'mcp'],
          default: 'none',
          description: 'Real-browser completion gate for ui-designer, frontend-engineer, and qa-engineer using the resolved user-configured permission mode. The server applies role-specific evidence rules, preflights the backend, and returns installation guidance instead of silently falling back.',
        },
        browserMcpProfile: {
          type: 'string',
          pattern: '^[a-z][a-z0-9-]*$',
          description: 'Preconfigured profile name for browserMode=mcp. It may be omitted only when exactly one profile is configured; arbitrary config paths are not accepted.',
        }
      },
      additionalProperties: false,
    },
  },
  {
    name: 'job_status',
    description: 'Show compact local CLI Runner background job progress. This is read-only; use job_wait for one server-side wait instead of repeatedly polling from Codex.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        since_progress_revision: { type: 'integer', minimum: 0, description: 'Optional previous progressRevision for detecting visible changes.' },
        poll_attempt: { type: 'integer', minimum: 0, maximum: 3, default: 0, description: 'Optional diagnostic poll counter used to calculate nextPollSeconds.' },
        full: { type: 'boolean', default: false, description: 'Include all stored metadata for diagnostics.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'job_wait',
    description: 'Wait for a background local CLI job to reach a terminal state inside the MCP server and return one compact result. This avoids repeated Codex polling turns.',
    inputSchema: {
      type: 'object',
      required: ['job_id'],
      properties: {
        job_id: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 2100000, default: 2100000, description: 'Maximum server-side wait time. It does not create additional Codex model turns.' },
        max_text_chars: { type: 'integer', minimum: 1000, maximum: 50000, default: 8000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'job_result',
    description: 'Read a compact stored result after the job reaches a terminal state. Use full only for diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        full: { type: 'boolean', default: false, description: 'Include raw and structured Runner output.' },
        max_text_chars: { type: 'integer', minimum: 1000, maximum: 50000, default: 8000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'job_cancel',
    description: 'Cancel an active local CLI Runner background job.',
    inputSchema: {
      type: 'object',
      required: ['job_id'],
      properties: { job_id: { type: 'string' } },
      additionalProperties: false,
    },
  },
];

function textResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    isError,
  };
}

export class McpServer {
  constructor(service) {
    this.service = service;
    this.buffer = '';
    this.activeRequests = new Map();
    this.dashboard = null;
    this.stopped = false;
  }

  send(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  success(id, result) {
    this.send({ jsonrpc: '2.0', id, result });
  }

  failure(id, code, message, data) {
    this.send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
  }

  async handle(message) {
    if (!message || message.jsonrpc !== '2.0') return;
    const { id, method, params = {} } = message;
    if (method === 'notifications/initialized') return;
    if (method === 'notifications/cancelled') {
      const request = this.activeRequests.get(params.requestId);
      request?.controller.abort('mcp_request_cancelled');
      return;
    }
    if (method === 'initialize') {
      this.success(id, {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'multi-cli-agents', version: PLUGIN_VERSION },
        instructions: 'Codex must plan first. Use run_agent only after producing a concrete plan, selecting a specialist, and preserving user scope. Review the returned implementation and verification evidence.',
      });
      return;
    }
    if (method === 'ping') {
      this.success(id, {});
      return;
    }
    if (method === 'tools/list') {
      this.success(id, { tools: TOOL_DEFINITIONS });
      return;
    }
    if (method === 'tools/call') {
      try {
        const name = params.name;
        const args = params.arguments || {};
        let value;
        if (name === 'open_dashboard') {
          if (!this.dashboard) {
            const { startDashboard } = await import('../dashboard.mjs');
            this.dashboard = await startDashboard({ service: this.service, pluginRoot: this.service.pluginRoot, port: args.port || 0, open: args.open !== false });
          } else if (args.open !== false) {
            const { openDashboardBrowser } = await import('../dashboard.mjs');
            openDashboardBrowser(this.dashboard.url);
          }
          value = { ok: true, url: this.dashboard.url, message: 'Multi-CLI Agents dashboard is ready.' };
        }
        else if (name === 'list_runners') value = this.service.listRunners();
        else if (name === 'list_agents') value = this.service.listAgents({ cwd: args.cwd, runner: args.runner });
        else if (name === 'run_agent') {
          const controller = new AbortController();
          this.activeRequests.set(id, { controller, foreground: !args.background });
          try {
            value = await this.service.run({ ...args, cwd: args.cwd || process.cwd(), signal: controller.signal });
            if (!args.background && !value?.dryRun) value = compactResult(value);
          } finally {
            this.activeRequests.delete(id);
          }
        }
        else if (name === 'job_status') value = this.service.status(args.job_id, {
          full: args.full,
          limit: args.limit,
          sinceRevision: args.since_progress_revision,
          pollAttempt: args.poll_attempt,
        });
        else if (name === 'job_wait') {
          const controller = new AbortController();
          this.activeRequests.set(id, { controller, foreground: !args.background });
          try {
            value = await this.service.wait(args.job_id, {
              signal: controller.signal,
              timeoutMs: args.timeout_ms,
              maxTextChars: args.max_text_chars,
            });
          } finally {
            this.activeRequests.delete(id);
          }
        }
        else if (name === 'job_result') value = this.service.result(args.job_id, { full: args.full, maxTextChars: args.max_text_chars });
        else if (name === 'job_cancel') value = this.service.cancel(args.job_id);
        else throw new Error(`Unknown tool: ${name}`);
        this.success(id, textResult(value, value?.ok === false));
      } catch (error) {
        this.success(id, textResult({ ok: false, error: error.message }, true));
      }
      return;
    }
    if (id !== undefined) this.failure(id, -32601, `Method not found: ${method}`);
  }

  start() {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        try { void this.handle(JSON.parse(line)).catch((error) => process.stderr.write(`MCP dispatch error: ${error.message}\n`)); }
        catch (error) { process.stderr.write(`MCP parse error: ${error.message}\n`); }
      }
    });
    process.stdin.once('end', () => this.shutdown('mcp_stdin_closed'));
    process.once('SIGTERM', () => this.shutdown('mcp_terminated'));
    process.once('SIGINT', () => this.shutdown('mcp_interrupted'));
    process.stdin.resume();
  }

  shutdown(reason) {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.activeRequests.values()) request.controller.abort(reason);
    this.service.dispose(reason);
    this.dashboard?.server?.close();
    const deadline = Date.now() + 5000;
    const finish = () => {
      if (this.activeRequests.size === 0 || Date.now() >= deadline) process.exit(0);
      else setTimeout(finish, 50);
    };
    finish();
  }
}
