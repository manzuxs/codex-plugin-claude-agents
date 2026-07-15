import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
const FRAMEWORKS = [
  { id: 'playwright', packages: ['@playwright/test', 'playwright'], config: /^playwright\.config\.[cm]?[jt]s$/ },
  { id: 'cypress', packages: ['cypress'], config: /^cypress\.config\.[cm]?[jt]s$/ },
];

function packageManager(cwd) {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(cwd, 'bun.lockb')) || fs.existsSync(path.join(cwd, 'bun.lock'))) return 'bun';
  return 'npm';
}

function installCommands(cwd, framework = 'playwright') {
  const manager = packageManager(cwd);
  if (framework === 'cypress') {
    if (manager === 'pnpm') return 'pnpm add -D cypress && pnpm exec cypress install';
    if (manager === 'yarn') return 'yarn add -D cypress && yarn cypress install';
    if (manager === 'bun') return 'bun add -d cypress && bunx cypress install';
    return 'npm install -D cypress && npx cypress install';
  }
  if (manager === 'pnpm') return 'pnpm add -D @playwright/test && pnpm exec playwright install chromium';
  if (manager === 'yarn') return 'yarn add -D @playwright/test && yarn playwright install chromium';
  if (manager === 'bun') return 'bun add -d @playwright/test && bunx playwright install chromium';
  return 'npm install -D @playwright/test && npx playwright install chromium';
}

function scanRepository(cwd, maxDepth = 4, maxEntries = 3000) {
  const packageFiles = [];
  const configs = [];
  let visited = 0;
  const visit = (directory, depth) => {
    if (depth > maxDepth || visited >= maxEntries) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited++ >= maxEntries) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(path.join(directory, entry.name), depth + 1);
        continue;
      }
      if (entry.name === 'package.json') packageFiles.push(path.join(directory, entry.name));
      if (FRAMEWORKS.some((framework) => framework.config.test(entry.name))) configs.push(path.join(directory, entry.name));
    }
  };
  visit(cwd, 0);
  return { packageFiles, configs };
}

function installedPackage(cwd, packageName) {
  try {
    const require = createRequire(path.join(cwd, 'package.json'));
    require.resolve(packageName);
    return true;
  } catch { return false; }
}

export function inspectRepositoryBrowser(cwd) {
  const { packageFiles, configs } = scanRepository(cwd);
  const declared = new Set();
  for (const file of packageFiles) {
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
      const scripts = Object.values(manifest.scripts || {}).join(' ');
      for (const framework of FRAMEWORKS) {
        if (framework.packages.some((name) => dependencies[name]) || new RegExp(framework.id, 'i').test(scripts)) declared.add(framework.id);
      }
    } catch {}
  }
  for (const config of configs) {
    const framework = FRAMEWORKS.find((candidate) => candidate.config.test(path.basename(config)));
    if (framework) declared.add(framework.id);
  }
  const packageRoots = [cwd, ...packageFiles.map((file) => path.dirname(file))];
  const installed = FRAMEWORKS
    .filter((framework) => framework.packages.some((name) => packageRoots.some((root) => installedPackage(root, name))))
    .map((framework) => framework.id);
  const available = installed.find((framework) => declared.has(framework)) || installed[0];
  if (available) return { ok: true, framework: available };
  const declaredNames = [...declared];
  const installationHint = installCommands(cwd, declaredNames[0]);
  const prefix = declaredNames.length
    ? `检测到 ${declaredNames.join('/')} 配置，但依赖未安装。`
    : '未检测到可运行的 Playwright/Cypress 浏览器测试工具。';
  return {
    ok: false,
    framework: declaredNames[0] || null,
    error: `${prefix} 请先安装仓库浏览器测试工具：${installationHint}`,
    installationHint,
  };
}

export function readBrowserMcpConfig(configPath) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { throw new Error(`Browser MCP config is invalid: ${error.message}`); }
  const servers = Object.keys(parsed?.mcpServers || {});
  if (servers.length === 0) throw new Error('Browser MCP config must define at least one mcpServers entry');
  return servers;
}

export function browserInstallationHint(mode, profile = '', configEnv = '<PREFIX>_BROWSER_MCP_CONFIGS_JSON') {
  if (mode === 'chrome') {
    return '安装并启用 Claude in Chrome 扩展（版本 1.0.36+），使用直接 Anthropic 账号连接；使用 API 网关时请改配 Playwright MCP。';
  }
  if (mode === 'mcp') {
    const suffix = profile ? `（profile: ${profile}）` : '';
    return `安装 Playwright MCP，并创建专用 mcpServers 配置文件${suffix}，再通过 ${configEnv} 注册该文件。`;
  }
  return '安装并配置仓库原生 Playwright/Cypress 浏览器测试工具。';
}

function namesFrom(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === 'string' ? item : item?.name || item?.server_name || item?.tool_name).filter(Boolean).map(String);
}

function normalize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function serverObserved(server, names) {
  const expected = normalize(server);
  return names.some((name) => {
    const observed = normalize(name);
    return observed === expected || observed.includes(expected) || expected.includes(observed);
  });
}

export function inspectBrowserInit(event, request) {
  if (event?.type !== 'system' || event?.subtype !== 'init') return null;
  const mode = request.browserMode || 'none';
  if (!['chrome', 'mcp'].includes(mode)) return { ok: true, mode };
  const serverNames = namesFrom(event.mcp_servers);
  const toolNames = namesFrom(event.tools);
  const observedNames = [...serverNames, ...toolNames];
  const expectedServers = mode === 'chrome' ? ['claude-in-chrome'] : request.browserExpectedMcpServers || [];
  const missingServers = expectedServers.filter((server) => !serverObserved(server, observedNames));
  if (missingServers.length === 0 && expectedServers.length > 0) {
    return { ok: true, mode, observedServers: serverNames, expectedServers };
  }
  return {
    ok: false,
    mode,
    observedServers: serverNames,
    expectedServers,
    error: `浏览器能力预检失败：未加载 ${missingServers.join(', ') || '任何浏览器 MCP/Chrome 工具'}。`,
    installationHint: request.browserInstallationHint || browserInstallationHint(mode, request.browserMcpProfile),
  };
}

export function browserUseObserved(event, request) {
  const tool = event?.tool_name || event?.name || event?.message?.content?.find?.((block) => block?.type === 'tool_use')?.name;
  if (!tool) return false;
  const name = normalize(tool);
  if (request.browserMode === 'chrome') return name.includes('chrome');
  if (request.browserMode === 'mcp') return (request.browserExpectedMcpServers || []).some((server) => name.includes(normalize(server)));
  if (request.browserMode === 'repository' && (name === 'bash' || name.includes('shell'))) {
    const input = event?.input || event?.tool_input || event?.message?.content?.find?.((block) => block?.type === 'tool_use')?.input;
    return /playwright|cypress|(?:^|[^a-z0-9])(?:e2e|browser|smoke)(?:[^a-z0-9]|$)/i.test(String(input?.command || input?.cmd || ''));
  }
  return false;
}
