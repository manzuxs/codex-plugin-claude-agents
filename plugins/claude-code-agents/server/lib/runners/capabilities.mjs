export const RUNNER_CAPABILITIES = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    supports: Object.freeze({
      model: true,
      effort: ['low', 'medium', 'high', 'xhigh', 'max'],
      permissionMode: ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'],
      resume: true,
      sessionId: true,
      browser: ['none', 'repository', 'chrome', 'mcp'],
      outputFormat: ['text', 'json', 'stream-json'],
    }),
  }),
  codex: Object.freeze({
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    supports: Object.freeze({
      model: true,
      effort: [],
      permissionMode: ['default', 'auto', 'bypassPermissions', 'plan'],
      resume: false,
      sessionId: false,
      browser: ['none'],
      outputFormat: ['json', 'stream-json'],
    }),
  }),
});
