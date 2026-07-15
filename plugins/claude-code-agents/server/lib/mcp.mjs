import { compactResult } from './service.mjs';

const TOOL_DEFINITIONS = [
  {
    name: 'list_agents',
    description: 'List configured Claude Code specialist agents and their non-secret runtime settings.',
    inputSchema: {
      type: 'object',
      properties: { cwd: { type: 'string', description: 'Repository working directory.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'run_agent',
    description: 'Delegate an approved Codex implementation plan to a selected local Claude Code CLI specialist. The orchestration skill normally passes background=true for adaptive progress polling; use background=false for explicit no-poll waiting. A non-empty plan is mandatory.',
    inputSchema: {
      type: 'object',
      required: ['agent', 'task', 'plan'],
      properties: {
        agent: { type: 'string', description: 'Agent id or alias, e.g. backend-engineer or 后端工程师.' },
        task: { type: 'string', minLength: 1, description: 'The concrete implementation objective.' },
        plan: { type: 'string', minLength: 1, description: 'The plan already produced and approved by Codex.' },
        acceptanceCriteria: { type: 'string' },
        context: { type: 'string' },
        cwd: { type: 'string', description: 'Target repository. Defaults to the current directory.' },
        background: { type: 'boolean', default: false },
        persistOnDisconnect: { type: 'boolean', default: false, description: 'Allow a background job to continue after the Codex session stops. Use only when explicitly requested.' },
        leaseTimeoutMs: { type: 'integer', minimum: 30000, maximum: 600000, default: 90000, description: 'Background job lease maintained by the MCP service heartbeat.' },
        dryRun: { type: 'boolean', default: false },
        codexReviewRequired: { type: 'boolean', default: true },
        resume: { type: 'string', description: 'Optional Claude session id or selector to resume.' },
        sessionId: { type: 'string', description: 'Optional explicit UUID for a new Claude session.' },
        model: { type: 'string', description: 'One-run override; normally loaded from .env.' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'] },
        timeoutMs: { type: 'integer', minimum: 1000 },
        maxBudgetUsd: { type: 'number', minimum: 0 },
        outputFormat: { type: 'string', enum: ['text', 'json', 'stream-json'] },
        allowedTools: { type: 'array', items: { type: 'string' } },
        disallowedTools: { type: 'array', items: { type: 'string' } }
      },
      additionalProperties: false,
    },
  },
  {
    name: 'job_status',
    description: 'Show compact Claude Code background job progress. Use since_progress_revision and poll_attempt to follow the adaptive 30/60/120/180 second schedule; the MCP service maintains leases internally.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        since_progress_revision: { type: 'integer', minimum: 0, description: 'The progressRevision returned by the previous status response.' },
        poll_attempt: { type: 'integer', minimum: 0, maximum: 3, default: 0, description: 'The previous poll attempt used to calculate nextPollSeconds.' },
        full: { type: 'boolean', default: false, description: 'Include all stored metadata for diagnostics.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
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
        full: { type: 'boolean', default: false, description: 'Include raw and structured Claude output.' },
        max_text_chars: { type: 'integer', minimum: 1000, maximum: 50000, default: 8000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'job_cancel',
    description: 'Cancel an active Claude Code background job.',
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
      this.activeRequests.get(params.requestId)?.abort('mcp_request_cancelled');
      return;
    }
    if (method === 'initialize') {
      this.success(id, {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'claude-code-agents', version: '0.1.0' },
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
        if (name === 'list_agents') value = this.service.listAgents({ cwd: args.cwd });
        else if (name === 'run_agent') {
          const controller = new AbortController();
          this.activeRequests.set(id, controller);
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
    for (const controller of this.activeRequests.values()) controller.abort(reason);
    this.service.dispose(reason);
    const deadline = Date.now() + 5000;
    const finish = () => {
      if (this.activeRequests.size === 0 || Date.now() >= deadline) process.exit(0);
      else setTimeout(finish, 50);
    };
    finish();
  }
}
