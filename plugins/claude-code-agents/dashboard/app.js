const token = document.querySelector('meta[name="dashboard-token"]').content;
const state = {
  agents: [], jobs: [], selectedAgent: null, selectedJob: null, expandedAgents: new Set(), events: [], cursor: 0,
  tab: 'events', cwd: '', install: null, result: null, stream: null, streamState: 'idle', lastUpdate: null,
};
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const api = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', 'x-claude-agents-token': token, ...(options.headers || {}) } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `请求失败 (${response.status})`);
  return value;
};
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
const showToast = (message, kind = '') => {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = message;
  $('#toast-region').append(element);
  setTimeout(() => element.remove(), 3600);
};
const activeJob = () => state.jobs.find((job) => job.jobId === state.selectedJob && job.agent === state.selectedAgent) || null;
const agentJobs = () => state.jobs.filter((job) => job.agent === state.selectedAgent);
const phaseLabel = (phase, status) => ({ completed: '执行完成', failed: '执行失败', cancelled: '已取消', blocked: '已阻断', running: '正在执行', starting: '启动中', queued: '排队中' }[status] || ({ inspecting: '检查仓库', implementing: '正在实施', verifying: '验证中', finalizing: '收尾' }[phase] || '待机'));
const dateTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const formatNumber = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '—';
const formatDuration = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
};
const elapsedFor = (job) => {
  if (!job) return NaN;
  if (Number.isFinite(Number(job.durationMs)) && job.durationMs >= 0) return Number(job.durationMs);
  if (job.startedAt && job.finishedAt) return new Date(job.finishedAt) - new Date(job.startedAt);
  if (job.startedAt) return Date.now() - new Date(job.startedAt);
  return Number(job.elapsedMs);
};
const truncateMiddle = (value, max = 28) => {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
};
const truncateText = (value, max = 700) => {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
};
const agentBadge = (agentId) => ({
  'backend-engineer': 'BE', architect: 'AR', 'ui-designer': 'UI', 'frontend-engineer': 'FE',
  'fullstack-engineer': 'FS', 'qa-engineer': 'QA', 'devops-engineer': 'DO', 'security-engineer': 'SE',
}[agentId] || 'AG');
const effortLabel = (value) => ({ low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' }[value] || value || '—');
const permissionLabel = (value) => ({ auto: '自动确认', plan: '仅规划', acceptEdits: '自动接受编辑', bypassPermissions: '跳过权限确认' }[value] || value || '—');
const browserLabel = (value) => ({ none: '无', repository: '仓库浏览器', chrome: 'Chrome', mcp: 'MCP' }[value] || value || '—');

function toolUse(event) {
  const content = event?.message?.content;
  return Array.isArray(content) ? content.find((item) => item?.type === 'tool_use') : null;
}

function classifyEvent(event) {
  const tool = toolUse(event);
  const name = String(tool?.name || '').toLowerCase();
  const input = tool?.input || {};
  const command = String(input.command || '').toLowerCase();
  const isFile = Boolean(tool && (/write|edit|patch|notebookedit/.test(name) || input.file_path || input.path));
  const isCheck = event?.type === 'result' || Boolean(tool && (/test|lint|check|audit|scan/.test(name) || /(^|\s)(test|lint|check|typecheck|pytest|vitest|jest)(\s|$)/.test(command)));
  return { tool, isFile, isCheck };
}

function eventPresentation(event) {
  const { tool, isFile, isCheck } = classifyEvent(event);
  if (event?.type === 'result') return ['任务结果', '✓', event.result || event.subtype || '执行结束'];
  if (tool) {
    const input = tool.input || {};
    const detail = input.command || input.file_path || input.path || JSON.stringify(input);
    return [isCheck ? '检查执行' : isFile ? '文件变更' : '工具调用', '↗', `${tool.name || 'tool'} ${detail || ''}`.trim()];
  }
  if (event?.type === 'system') return ['系统事件', '◌', event.subtype || event.result || '任务初始化'];
  const content = event?.message?.content;
  const detail = Array.isArray(content) ? content.map((item) => item?.text || '').filter(Boolean).join(' ') : content;
  return ['会话消息', '·', detail || event?.subtype || event?.result || ''];
}

function filteredEvents() {
  if (state.tab === 'events') return state.events;
  return state.events.filter((event) => {
    const classification = classifyEvent(event);
    if (state.tab === 'tools') return Boolean(classification.tool);
    if (state.tab === 'files') return classification.isFile;
    return classification.isCheck;
  });
}

function renderAgents() {
  $('#online-count').textContent = `${state.agents.length} 个智能体`;
  $('#agent-list').innerHTML = state.agents.map((agent) => {
    const jobs = state.jobs.filter((job) => job.agent === agent.id);
    const running = jobs.find((job) => ['running', 'starting'].includes(job.status));
    const queued = jobs.find((job) => job.status === 'queued');
    const latest = jobs[0];
    const expanded = state.expandedAgents.has(agent.id);
    const hasRecords = jobs.length > 0;
    const active = running || queued;
    const taskPreview = active ? active.task : latest?.task || '';
    const stateMeta = running
      ? `<i class="agent-status running pulse"></i><span class="agent-phase">${esc(phaseLabel(running.phase, running.status))}</span>`
      : queued
        ? `<i class="agent-status queued"></i><span class="agent-phase">排队中</span>`
        : hasRecords
          ? `<span class="record-count">${jobs.length} 条历史记录</span>`
          : '<span class="agent-phase">未激活</span>';
    const history = jobs.length ? jobs.map((job) => `<div class="history-item ${job.jobId === state.selectedJob ? 'selected' : ''}"><button class="history-select" data-job="${esc(job.jobId)}"><span class="history-status ${['running', 'starting'].includes(job.status) ? 'running' : job.status === 'queued' ? 'queued' : ''}"></span><span class="history-copy"><strong>${esc(job.task || '未命名任务')}</strong><small>${esc(dateTime(job.createdAt))} · ${esc(phaseLabel(job.phase, job.status))}</small></span></button><button class="history-delete" data-delete-job="${esc(job.jobId)}" aria-label="删除会话" title="删除会话">⌫</button></div>`).join('') : '<div class="history-empty">—</div>';
    return `<div class="agent-card ${expanded ? 'expanded' : ''} ${agent.id === state.selectedAgent ? 'selected-agent' : ''} ${hasRecords ? 'has-records' : 'inactive'}"><div class="agent-row-wrap"><button class="agent-row ${agent.id === state.selectedAgent ? 'selected' : ''}" data-agent="${esc(agent.id)}" aria-expanded="${expanded}"><span class="agent-avatar" aria-hidden="true">${esc(agentBadge(agent.id))}</span><span class="agent-info"><strong class="agent-name">${esc(agent.name)}</strong><span class="agent-task" title="${esc(taskPreview)}">${esc(taskPreview || '—')}</span><span class="agent-meta">${stateMeta}</span></span><span class="agent-spark">${expanded ? '⌃' : '⌄'}</span></button><button class="agent-edit" data-config-agent="${esc(agent.id)}" aria-label="编辑 ${esc(agent.name)}" title="编辑智能体">✎</button></div><div class="agent-history" ${expanded ? '' : 'hidden'}><div class="history-heading"><span>任务历史</span><b>${jobs.length}</b></div>${history}</div></div>`;
  }).join('');
  const options = state.agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name)}</option>`).join('');
  for (const selector of ['#run-agent', '#config-agent']) {
    const select = $(selector);
    const previous = select.value;
    select.innerHTML = options;
    select.value = previous || state.selectedAgent || '';
  }
}

function renderSession() {
  const agent = state.agents.find((item) => item.id === state.selectedAgent);
  if (!agent) return;
  const job = activeJob();
  const phase = job ? phaseLabel(job.phase, job.status) : '待机';
  $('#hero-agent').textContent = agent.name;
  $('#hero-task').textContent = job?.task || '该智能体暂无任务记录';
  const sessionId = job?.sessionId || '—';
  const cwd = job?.cwd || '—';
  const browser = browserLabel(job?.browserMode);
  $('#meta-session-value').textContent = sessionId === '—' ? '—' : truncateMiddle(sessionId, 32);
  $('#meta-session-value').dataset.full = sessionId;
  $('#meta-cwd-value').textContent = cwd === '—' ? '—' : truncateMiddle(cwd, 36);
  $('#meta-cwd-value').dataset.full = cwd;
  $('#meta-browser-value').textContent = browser;
  $('#meta-session-value').nextElementSibling.classList.toggle('hidden', sessionId === '—');
  $('#meta-cwd-value').nextElementSibling.classList.toggle('hidden', cwd === '—');
  $('#hero-state').innerHTML = `<i></i> ${esc(phase)}`;
  $('#hero-state').dataset.status = job?.status || 'idle';
  $('#hero-emblem').textContent = agentBadge(agent.id);
  const result = state.result || {};
  const verification = job?.verificationState;
  const verificationLabel = verification === 'passed' ? '验证通过' : verification === 'failed' ? '验证失败' : verification === 'running' ? '验证中' : job ? '尚未验证' : '等待执行';
  const resultTitles = { completed: '任务已完成', failed: '任务执行失败', cancelled: '任务已取消', blocked: '任务已阻断', running: '任务正在执行', starting: '正在启动任务', queued: '任务正在排队' };
  $('#overview-title').textContent = resultTitles[job?.status] || '等待任务';
  $('#overview-summary').textContent = truncateText(result.summary) || (job ? (['running', 'starting', 'queued'].includes(job.status) ? '执行结果将在任务结束后显示。' : '该任务没有保存结果摘要。') : '选择一条任务记录后查看执行结果。');
  $('#overview-verification').textContent = truncateText(result.verificationSummary, 240);
  $('#overview-status').textContent = phase;
  $('#overview-duration').textContent = formatDuration(elapsedFor(job));
  $('#overview-check').textContent = verificationLabel;
  $('#task-overview').dataset.status = job?.status || 'idle';
  $('#task-overview').dataset.verification = verification || 'idle';
  const cancellable = Boolean(job && ['running', 'starting', 'queued'].includes(job.status));
  $('#cancel-job').classList.toggle('hidden', !cancellable);
  $('#monitor-state').innerHTML = `<i></i> ${esc(phase)}`;
  $('#monitor-state').dataset.status = job?.status || 'idle';
  const tools = state.events.filter((event) => classifyEvent(event).tool).length;
  const files = state.events.filter((event) => classifyEvent(event).isFile).length;
  const checks = state.events.filter((event) => classifyEvent(event).isCheck).length;
  const total = state.events.length;
  updateTabBadge('#event-count', total);
  updateTabBadge('#tool-count', tools);
  updateTabBadge('#file-count', files);
  updateTabBadge('#check-count', checks);
  const visible = filteredEvents();
  $('#event-viewport').innerHTML = visible.length ? visible.map((event) => {
    const [kind, icon, detail] = eventPresentation(event);
    return `<div class="event-row"><span class="event-time">${esc(new Date(event.at || Date.now()).toLocaleTimeString('zh-CN', { hour12: false }))}</span><span class="event-dot">${icon}</span><span class="event-kind">${esc(kind)}</span><span class="event-main"><strong>${esc(event.subtype || toolUse(event)?.name || kind)}</strong><small>${esc(detail)}</small></span><span class="event-result">${event.type === 'result' ? esc(event.subtype === 'success' ? '完成' : event.subtype || '结束') : ''}</span></div>`;
  }).join('') : buildEmptyState(job);
  if ($('#autoscroll').checked) $('#event-viewport').scrollTop = $('#event-viewport').scrollHeight;
  $('#stream-status').textContent = ({ open: 'SSE 已连接', connecting: 'SSE 连接中', error: 'SSE 已中断', snapshot: '历史快照', idle: '未连接' })[state.streamState];
  $('#last-update').textContent = state.lastUpdate ? `最后更新 ${dateTime(state.lastUpdate)}` : '—';
  $('.command-row').classList.toggle('hidden', !job);
}

function updateTabBadge(selector, count) {
  const el = $(selector);
  el.textContent = count;
  el.classList.toggle('zero', count === 0);
}

function buildEmptyState(job) {
  if (!job) {
    return `<div class="empty-events"><strong>等待任务会话</strong><small>发起任务后，Claude 的工作过程会在这里实时显示。</small><div class="empty-actions"><button class="primary-button empty-cta" id="empty-run"><span class="play">▶</span> 发起任务</button><button class="ghost-button" id="empty-refresh">刷新</button></div></div>`;
  }
  const hints = {
    events: '当前会话没有记录到任何事件。',
    tools: '当前会话没有工具调用。',
    files: '当前会话没有文件变更。',
    checks: '当前会话没有检查执行。',
  };
  return `<div class="empty-events"><span class="pulse-ring static"></span><strong>此分类暂无记录</strong><small>${hints[state.tab] || '切换上方标签可查看其他事件。历史数据可能没有完整事件记录。'}</small></div>`;
}

function renderTelemetry() {
  const agent = state.agents.find((item) => item.id === state.selectedAgent);
  if (!agent) return;
  const config = agent.configured || {};
  const job = activeJob();
  $('#metric-model').textContent = config.model || agent.runtime?.model || '—';
  $('#metric-effort').textContent = effortLabel(config.effort || agent.runtime?.effort);
  $('#metric-permission').textContent = permissionLabel(config.permissionMode || agent.runtime?.permissionMode);
  $('#metric-duration').textContent = job ? formatDuration(elapsedFor(job)) : '—';
  $('#metric-start').textContent = job?.startedAt ? `${new Date(job.startedAt).toLocaleTimeString('zh-CN', { hour12: false })} 开始` : '—';
  $('#metric-cost').textContent = Number.isFinite(Number(job?.costUsd)) ? `$${Number(job.costUsd).toFixed(4)}` : '—';
  const tokenIn = formatNumber(job?.inputTokens);
  const tokenOut = formatNumber(job?.outputTokens);
  const turns = formatNumber(job?.turns ?? job?.turnsObserved);
  $('#token-in').textContent = tokenIn;
  $('#token-out').textContent = tokenOut;
  $('#metric-turns').textContent = turns;
  const hasTokenData = tokenIn !== '—' || tokenOut !== '—' || turns !== '—';
  $('#token-block').classList.toggle('no-data', !hasTokenData);
  $('#token-status').textContent = hasTokenData ? '已记录' : '—';
}

function renderFooter() {
  const connected = state.streamState === 'open' || (!activeJob() && state.lastUpdate);
  $('#connection-state').innerHTML = `<i></i><span>${connected ? '数据已连接' : state.streamState === 'error' ? '连接中断' : '本地服务在线'}</span>`;
  $('#connection-state').classList.toggle('connection-error', state.streamState === 'error');
  $('#data-freshness').textContent = state.lastUpdate ? dateTime(state.lastUpdate) : '等待数据';
  $('#system-state').textContent = state.streamState === 'error' ? '异常' : '正常';
  $('#system-state').className = state.streamState === 'error' ? 'red-text' : 'green-text';
}

function renderKPI() {
  $('#kpi-agents').textContent = state.agents.length;
  $('#kpi-running').textContent = state.jobs.filter((job) => ['running', 'starting'].includes(job.status)).length;
  $('#kpi-queued').textContent = state.jobs.filter((job) => job.status === 'queued').length;
  $('#kpi-completed').textContent = state.jobs.filter((job) => job.status === 'completed').length;
  const completedJobs = state.jobs.filter((job) => job.status === 'completed');
  const terminalJobs = state.jobs.filter((job) => ['completed', 'failed', 'cancelled', 'blocked'].includes(job.status));
  const totalTokens = state.jobs.reduce((sum, job) => sum + (Number(job.inputTokens) || 0) + (Number(job.outputTokens) || 0), 0);
  $('#kpi-tokens').textContent = totalTokens > 0 ? formatNumber(totalTokens) : '—';
  const successRate = terminalJobs.length ? Math.round((completedJobs.length / terminalJobs.length) * 100) : null;
  const success = $('#kpi-success');
  success.textContent = successRate !== null ? `${successRate}%` : '—';
  success.classList.toggle('is-alert', successRate === 0);
}

function renderInstall() {
  const installed = Boolean(state.install?.installed);
  const version = state.install?.installedVersion ? ` ${state.install.installedVersion}` : '';
  $('#step-codex').textContent = state.install?.codexAvailable ? '可用' : '未检测到';
  $('#step-codex').className = state.install?.codexAvailable ? 'done' : 'fail';
  $('#step-marketplace').textContent = state.install?.marketplaceAvailable ? '已注册' : '待注册';
  $('#step-marketplace').className = state.install?.marketplaceAvailable ? 'done' : '';
  $('#step-plugin').textContent = installed ? '已安装并启用' : '待安装';
  $('#step-plugin').className = installed ? 'done' : '';
  $('#install-run').textContent = installed ? '检查更新' : '开始安装';
  $('#install-run').disabled = !state.install?.codexAvailable;
  $('#install-output').textContent = installed ? `当前版本${version}，可检查并应用 marketplace 更新。` : '尚未安装，可从此界面完成安装。';
}

function renderAll() {
  renderAgents();
  renderSession();
  renderTelemetry();
  renderFooter();
  renderKPI();
}

function closeStream() {
  if (state.stream) state.stream.close();
  state.stream = null;
  state.streamState = 'idle';
}

function connectStream(jobId) {
  closeStream();
  if (!jobId) return renderAll();
  state.streamState = 'connecting';
  state.stream = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream?token=${encodeURIComponent(token)}&after=${state.cursor}`);
  state.stream.onopen = () => { state.streamState = 'open'; renderFooter(); renderSession(); };
  state.stream.onmessage = (message) => {
    try {
      const data = JSON.parse(message.data);
      if (jobId !== state.selectedJob) return;
      const known = new Set(state.events.map((event) => event.seq));
      state.events.push(...(data.events || []).filter((event) => !known.has(event.seq)));
      state.cursor = data.cursor;
      state.jobs = state.jobs.map((item) => item.jobId === jobId ? data.meta : item);
      state.lastUpdate = new Date().toISOString();
      if (!['running', 'starting', 'queued'].includes(data.meta?.status)) {
        state.stream.close();
        state.stream = null;
        state.streamState = 'snapshot';
      }
      renderAll();
    } catch (error) { showToast(error.message, 'error'); }
  };
  state.stream.onerror = () => { if (state.streamState !== 'snapshot') state.streamState = 'error'; renderFooter(); renderSession(); };
}

async function selectJob(jobId) {
  state.selectedJob = jobId || null;
  state.events = [];
  state.result = null;
  state.cursor = 0;
  state.lastUpdate = null;
  const selected = activeJob();
  if (selected && ['running', 'starting', 'queued'].includes(selected.status)) connectStream(state.selectedJob);
  else { closeStream(); state.streamState = state.selectedJob ? 'snapshot' : 'idle'; }
  if (state.selectedJob) await refreshEvents(true);
  else renderAll();
}

async function selectAgent(agentId) {
  state.selectedAgent = agentId;
  state.expandedAgents.add(agentId);
  const current = activeJob();
  const latest = current || state.jobs.find((job) => job.agent === agentId);
  await selectJob(latest?.jobId || null);
}

async function refreshBootstrap() {
  const data = await api('/api/bootstrap');
  state.agents = data.agents || [];
  state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
  state.cwd = data.cwd || '';
  state.install = data.installation || null;
  if (!state.selectedAgent || !state.agents.some((agent) => agent.id === state.selectedAgent)) {
    const priorityJob = state.jobs.find((job) => ['running', 'starting', 'queued'].includes(job.status)) || state.jobs[0];
    state.selectedAgent = priorityJob?.agent || state.agents[0]?.id || null;
  }
  const activeAgents = state.jobs.filter((job) => ['running', 'starting', 'queued'].includes(job.status)).map((job) => job.agent);
  if (state.expandedAgents.size === 0 && activeAgents.length > 0) state.expandedAgents.add(activeAgents[0]);
  if (!activeJob()) state.selectedJob = state.jobs.find((job) => job.agent === state.selectedAgent)?.jobId || null;
  renderAll();
  renderInstall();
  const selected = activeJob();
  if (selected && ['running', 'starting', 'queued'].includes(selected.status) && !state.stream) connectStream(state.selectedJob);
  if (!state.install?.installed) openModal('install-modal');
}

async function refreshEvents(force = false) {
  const job = activeJob();
  if (!job) return;
  if (!force && state.stream?.readyState === EventSource.OPEN) return;
  const data = await api(`/api/jobs/${encodeURIComponent(job.jobId)}/events?after=${state.cursor}`);
  if (job.jobId !== state.selectedJob) return;
  const known = new Set(state.events.map((event) => event.seq));
  state.events.push(...(data.events || []).filter((event) => !known.has(event.seq)));
  state.cursor = data.cursor;
  state.jobs = state.jobs.map((item) => item.jobId === job.jobId ? data.meta : item);
  if (data.meta?.resultAvailable) {
    try {
      const resultData = await api(`/api/jobs/${encodeURIComponent(job.jobId)}/result`);
      if (job.jobId !== state.selectedJob) return;
      state.result = resultData.result || null;
    } catch {
      // Older dashboard processes do not expose the optional result endpoint.
      state.result = null;
    }
  } else state.result = null;
  state.lastUpdate = new Date().toISOString();
  renderAll();
}

let modalTrigger = null;
function openModal(id) {
  modalTrigger = document.activeElement;
  const modal = $(`#${id}`);
  modal.classList.remove('hidden');
  modal.querySelector('button, input, select, textarea')?.focus();
}
function closeModal(id) {
  $(`#${id}`).classList.add('hidden');
  modalTrigger?.focus?.();
}

function fillConfig() {
  const agent = state.agents.find((item) => item.id === $('#config-agent').value) || state.agents[0];
  const config = agent?.configured || {};
  $('#cfg-model').value = config.model || '';
  $('#cfg-effort').value = config.effort || 'high';
  $('#cfg-permission').value = config.permissionMode || 'auto';
  $('#cfg-output').value = config.outputFormat || 'json';
  $('#cfg-timeout').value = config.timeoutMs || 1800000;
  $('#cfg-budget').value = config.maxBudgetUsd ?? 0;
  $('#cfg-gateway').value = config.gatewayUrl || '';
  $('#cfg-key-kind').value = config.apiKeyKind || 'auth_token';
  $('#cfg-api-key').value = '';
  $('#cfg-browser-profiles').value = config.browserMcpConfigsJson || '{}';
}

async function install() {
  $('#install-run').disabled = true;
  $('#install-output').textContent = '正在调用 Codex CLI…';
  try {
    const result = await post('/api/install', {});
    state.install = result.installation || state.install;
    renderInstall();
    $('#install-output').textContent = [result.marketplace?.stdout, result.marketplace?.stderr, result.plugin?.stdout, result.plugin?.stderr].filter(Boolean).join('\n') || (result.updateChecked ? '已完成更新检查。' : '插件安装完成。');
    showToast(result.updateChecked ? '更新检查完成，重启 Codex 后新任务即可加载最新版本。' : '插件安装完成，重启 Codex 后新任务即可加载。', 'success');
    await refreshBootstrap();
  } catch (error) {
    $('#install-output').textContent = error.message;
    showToast(error.message, 'error');
  } finally { $('#install-run').disabled = !state.install?.codexAvailable; }
}

async function saveConfig() {
  const values = {
    model: $('#cfg-model').value.trim(), effort: $('#cfg-effort').value, permissionMode: $('#cfg-permission').value,
    outputFormat: $('#cfg-output').value, timeoutMs: $('#cfg-timeout').value, maxBudgetUsd: $('#cfg-budget').value,
    gatewayUrl: $('#cfg-gateway').value.trim(), apiKeyKind: $('#cfg-key-kind').value,
    browserMcpConfigsJson: $('#cfg-browser-profiles').value.trim() || '{}',
  };
  if ($('#cfg-api-key').value) values.apiKey = $('#cfg-api-key').value;
  try {
    await post('/api/config', { agent: $('#config-agent').value, values });
    showToast('配置已保存到 SQLite，并将用于后续任务。', 'success');
    closeModal('config-modal');
    await refreshBootstrap();
  } catch (error) { showToast(error.message, 'error'); }
}

async function submitRun() {
  const body = {
    agent: $('#run-agent').value, task: $('#run-task').value.trim(), plan: $('#run-plan').value.trim(),
    acceptanceCriteria: $('#run-criteria').value.trim(), cwd: $('#run-cwd').value.trim() || state.cwd,
    browserMode: $('#run-browser').value, browserMcpProfile: $('#run-browser-profile').value.trim(),
  };
  if (!body.task || !body.plan) return showToast('任务目标和已批准计划不能为空。', 'error');
  $('#run-submit').disabled = true;
  try {
    const result = await post('/api/run', body);
    closeModal('run-modal');
    await refreshBootstrap();
    await selectAgent(body.agent);
    await selectJob(result.jobId);
    showToast('任务已发起，正在接收实时事件。', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { $('#run-submit').disabled = false; }
}

$('#agent-list').addEventListener('click', async (event) => {
  const configButton = event.target.closest('[data-config-agent]');
  if (configButton) {
    event.stopPropagation();
    $('#config-agent').value = configButton.dataset.configAgent;
    fillConfig();
    openModal('config-modal');
    return;
  }
  const deleteButton = event.target.closest('[data-delete-job]');
  if (deleteButton) {
    event.stopPropagation();
    const jobId = deleteButton.dataset.deleteJob;
    if (!window.confirm('删除这条会话记录？执行中的任务不能删除。')) return;
    try {
      await api(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
      if (state.selectedJob === jobId) await selectJob(null);
      await refreshBootstrap();
      showToast('会话记录已删除。', 'success');
    } catch (error) { showToast(error.message, 'error'); }
    return;
  }
  const historyButton = event.target.closest('[data-job]');
  if (historyButton) {
    event.stopPropagation();
    try { await selectJob(historyButton.dataset.job); } catch (error) { showToast(error.message, 'error'); }
    return;
  }
  const row = event.target.closest('[data-agent]');
  if (!row) return;
  const agentId = row.dataset.agent;
  if (state.selectedAgent === agentId && state.expandedAgents.has(agentId)) {
    state.expandedAgents.delete(agentId);
    renderAgents();
    return;
  }
  state.expandedAgents.add(agentId);
  try { await selectAgent(agentId); } catch (error) { showToast(error.message, 'error'); }
});
document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => { state.tab = button.dataset.tab; document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === button)); renderSession(); }));
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === button)); if (button.dataset.view === 'config') { $('#config-agent').value = state.selectedAgent || ''; fillConfig(); openModal('config-modal'); } }));
$('#run-open').addEventListener('click', () => { $('#run-agent').value = state.selectedAgent || ''; $('#run-cwd').value = state.cwd; openModal('run-modal'); });
$('#install-open').addEventListener('click', () => { renderInstall(); openModal('install-modal'); });
$('#install-run').addEventListener('click', install);
$('#config-save').addEventListener('click', saveConfig);
$('#run-submit').addEventListener('click', submitRun);
$('#config-agent').addEventListener('change', fillConfig);
$('#refresh-events').addEventListener('click', () => refreshEvents(true).catch((error) => showToast(error.message, 'error')));
$('#kpi-refresh').addEventListener('click', () => refreshBootstrap().catch((error) => showToast(error.message, 'error')));
$('#cancel-job').addEventListener('click', async () => { const job = activeJob(); if (!job) return; try { const result = await post(`/api/jobs/${encodeURIComponent(job.jobId)}/cancel`, {}); if (!result.ok) throw new Error(result.message || '任务无法取消'); showToast('任务已取消。'); await refreshBootstrap(); } catch (error) { showToast(error.message, 'error'); } });

document.addEventListener('click', (event) => {
  const copyButton = event.target.closest('[data-copy]');
  if (copyButton) {
    const target = $(`#${copyButton.dataset.copy}`);
    const text = target?.dataset.full || target?.textContent || '';
    if (!text || text === '—' || text === '尚未生成') return;
    navigator.clipboard.writeText(text).then(() => {
      showToast('已复制到剪贴板', 'success');
    }).catch(() => {
      showToast('复制失败', 'error');
    });
  }
  const emptyRun = event.target.closest('#empty-run');
  if (emptyRun) {
    $('#run-agent').value = state.selectedAgent || '';
    $('#run-cwd').value = state.cwd;
    openModal('run-modal');
  }
  if (event.target.closest('#empty-refresh')) {
    refreshBootstrap().catch((error) => showToast(error.message, 'error'));
  }
});
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { const open = document.querySelector('.modal-backdrop:not(.hidden)'); if (open) closeModal(open.id); } });
setInterval(() => { $('#clock').textContent = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'); }, 1000);
setInterval(() => refreshBootstrap().catch((error) => { state.streamState = 'error'; renderFooter(); console.warn(error); }), 5000);
for (const [selector, labels] of Object.entries({
  '#cfg-effort': { low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' },
  '#cfg-permission': { auto: '自动确认', plan: '仅规划', acceptEdits: '自动接受编辑', bypassPermissions: '跳过权限确认' },
  '#cfg-output': { text: '文本', json: 'JSON', 'stream-json': '流式 JSON' },
  '#cfg-key-kind': { auth_token: '认证令牌', api_key: 'API 密钥' },
  '#run-browser': { none: '无', repository: '仓库浏览器', chrome: 'Chrome', mcp: 'MCP' },
})) {
  for (const option of $(selector).options) option.textContent = labels[option.value] || option.textContent;
}
refreshBootstrap().then(() => refreshEvents(true)).catch((error) => showToast(error.message, 'error'));
