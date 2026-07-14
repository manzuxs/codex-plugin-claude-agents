#!/usr/bin/env node
import { resolvePluginRoot, resolveDataRoot } from './lib/paths.mjs';
import { ClaudeAgentService } from './lib/service.mjs';
import { McpServer } from './lib/mcp.mjs';

const pluginRoot = resolvePluginRoot(import.meta.url);
const dataRoot = resolveDataRoot(pluginRoot);
const service = new ClaudeAgentService({ pluginRoot, dataRoot });
new McpServer(service).start();
