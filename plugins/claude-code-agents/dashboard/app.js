const token = document.querySelector('meta[name="dashboard-token"]').content;
const state = {
  agents: [], jobs: [], install: null, cwd: '', selectedAgent: null, selectedJob: null,
  events: [], cursor: 0, result: null, tab: 'events', stream: null,
  streamState: 'idle', lastUpdate: null,
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
const nowText = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const timeText = (value) => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
const numberText = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '—';
const durationText = (value) => {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) return '—';
  const seconds = Math.floor(Number(value) / 1000);
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor((seconds % 3600) / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
};
const elapsedFor = (job) => {
  if (!job) return NaN;
  if (Number.isFinite(Number(job.durationMs))) return Number(job.durationMs);
  if (job.startedAt && job.finishedAt) return new Date(job.finishedAt) - new Date(job.startedAt);
  if (job.startedAt) return Date.now() - new Date(job.startedAt);
  return Number(job.elapsedMs);
};
const phaseLabel = (phase, status) => ({ completed: '执行完成', failed: '执行失败', cancelled: '已取消', blocked: '已阻断', running: '正在执行', starting: '启动中', queued: '排队中' }[status] || ({ inspecting: '检查仓库', implementing: '正在实施', verifying: '验证中', finalizing: '收尾' }[phase] || '待机'));
const agentBadge = (id) => ({ architect: 'AR', 'backend-engineer': 'BE', 'frontend-engineer': 'FE', 'ui-designer': 'UI', 'fullstack-engineer': 'FS', 'qa-engineer': 'QA', 'security-engineer': 'SE', 'devops-engineer': 'DO' }[id] || 'AG');
const roleClass = (id) => `role-${id}`;
const statusClass = (status) => ['running', 'starting'].includes(status) ? 'running' : status === 'queued' ? 'queued' : ['failed', 'blocked'].includes(status) ? status : status === 'completed' ? 'completed' : '';
const statusLabel = (status) => ({ running: '运行中', starting: '启动中', queued: '排队', completed: '成功', failed: '失败', blocked: '阻断', cancelled: '取消' }[status] || '空闲');
const statusColor = { completed: '#4cd38a', running: '#258af0', starting: '#258af0', queued: '#e9aa42', failed: '#ef5c5c', blocked: '#ef5c5c', cancelled: '#7f969f' };
const positions = {
  architect: [50, 12], 'backend-engineer': [80, 26], 'frontend-engineer': [87, 52], 'ui-designer': [72, 78],
  'fullstack-engineer': [50, 87], 'qa-engineer': [28, 78], 'security-engineer': [13, 52], 'devops-engineer': [20, 26],
};
const showToast = (message, kind = '') => {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = message;
  $('#toast-region').append(element);
  setTimeout(() => element.remove(), 3600);
};
const activeJob = () => state.jobs.find((job) => job.jobId === state.selectedJob) || null;
const jobsFor = (agent) => state.jobs.filter((job) => job.agent === agent);

function eventTool(event) {
  const content = event?.message?.content;
  return Array.isArray(content) ? content.find((item) => item?.type === 'tool_use') : null;
}
function eventClass(event) {
  const tool = eventTool(event);
  const name = String(tool?.name || '').toLowerCase();
  const input = tool?.input || {};
  const command = String(input.command || '').toLowerCase();
  return {
    tool,
    file: Boolean(tool && (/write|edit|patch|notebookedit/.test(name) || input.file_path || input.path)),
    check: event?.type === 'result' || Boolean(tool && (/test|lint|check|audit|scan/.test(name) || /(^|\s)(test|lint|check|typecheck|pytest|vitest|jest)(\s|$)/.test(command))),
  };
}
function eventView(event) {
  const kind = eventClass(event);
  if (event?.type === 'result') return ['任务结果', 'OK', event.result || event.subtype || '执行结束'];
  if (kind.tool) {
    const input = kind.tool.input || {};
    const detail = input.command || input.file_path || input.path || JSON.stringify(input);
    return [kind.check ? '检查执行' : kind.file ? '文件变更' : '工具调用', '↗', `${kind.tool.name || 'tool'} ${detail || ''}`.trim()];
  }
  if (event?.type === 'system') return ['系统事件', 'SYS', event.subtype || event.result || '任务初始化'];
  const content = event?.message?.content;
  const text = Array.isArray(content) ? content.map((item) => item?.text || '').filter(Boolean).join(' ') : content;
  return ['会话消息', 'MSG', text || event?.subtype || event?.result || ''];
}

function setupCanvas(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * ratio));
  const height = Math.max(1, Math.floor(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}
function clearCanvas(canvas, color = '#071117') {
  const surface = setupCanvas(canvas);
  if (!surface) return null;
  surface.ctx.clearRect(0, 0, surface.width, surface.height);
  surface.ctx.fillStyle = color;
  surface.ctx.fillRect(0, 0, surface.width, surface.height);
  return surface;
}
function drawDonut() {
  const canvas = $('#status-donut');
  const surface = clearCanvas(canvas, '#071117');
  if (!surface) return;
  const { ctx, width, height } = surface;
  const counts = {
    completed: state.jobs.filter((job) => job.status === 'completed').length,
    running: state.jobs.filter((job) => ['running', 'starting'].includes(job.status)).length,
    queued: state.jobs.filter((job) => job.status === 'queued').length,
    failed: state.jobs.filter((job) => ['failed', 'blocked', 'cancelled'].includes(job.status)).length,
  };
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const colors = { completed: '#4cd38a', running: '#258af0', queued: '#e9aa42', failed: '#ef5c5c' };
  const labels = { completed: '已完成', running: '执行中', queued: '排队中', failed: '失败/阻断' };
  const center = Math.min(width, height) / 2;
  const radius = center * .39;
  const line = Math.max(14, center * .19);
  ctx.lineWidth = line; ctx.lineCap = 'butt'; ctx.strokeStyle = '#142832';
  ctx.beginPath(); ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2); ctx.stroke();
  let start = -Math.PI / 2;
  Object.entries(counts).forEach(([key, count]) => {
    if (!count || !total) return;
    const end = start + (count / total) * Math.PI * 2;
    ctx.strokeStyle = colors[key]; ctx.shadowColor = colors[key]; ctx.shadowBlur = 9;
    ctx.beginPath(); ctx.arc(width / 2, height / 2, radius, start, end); ctx.stroke(); ctx.shadowBlur = 0; start = end;
  });
  $('#donut-total').textContent = total; $('#task-total-label').textContent = `${total} 项任务`;
  $('#status-legend').innerHTML = Object.entries(counts).map(([key, count]) => `<div class="legend-row"><i style="background:${colors[key]}"></i><span>${labels[key]}</span><b>${count} (${total ? Math.round((count / total) * 100) : 0}%)</b></div>`).join('');
}
function dailyJobs() {
  const days = [];
  const today = new Date();
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(today); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - offset);
    days.push({ label: `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, date, jobs: state.jobs.filter((job) => job.createdAt && new Date(job.createdAt).toDateString() === date.toDateString()) });
  }
  return days;
}
function drawExecutionChart() {
  const surface = clearCanvas($('#execution-chart'), '#071117');
  if (!surface) return;
  const { ctx, width, height } = surface; const days = dailyJobs(); const max = Math.max(1, ...days.map((day) => day.jobs.length));
  const left = 24, right = 8, top = 9, bottom = 22, chartH = Math.max(20, height - top - bottom), slot = (width - left - right) / days.length;
  days.forEach((day, index) => {
    const x = left + slot * index + slot * .22; const barW = slot * .56;
    const groups = [['failed', '#ef5c5c'], ['queued', '#e9aa42'], ['running', '#258af0'], ['completed', '#4cd38a']];
    let y = top + chartH;
    groups.forEach(([key, color]) => {
      const count = day.jobs.filter((job) => key === 'failed' ? ['failed', 'blocked', 'cancelled'].includes(job.status) : key === 'running' ? ['running', 'starting'].includes(job.status) : job.status === key).length;
      const barH = count / max * chartH; y -= barH; ctx.fillStyle = color; ctx.fillRect(x, y, barW, barH);
    });
    ctx.fillStyle = '#6d8791'; ctx.font = '9px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(day.label, x + barW / 2, height - 7);
  });
  ctx.strokeStyle = '#29434d'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, top + chartH + .5); ctx.lineTo(width - right, top + chartH + .5); ctx.stroke();
}
function drawLineChart(canvas, values, labels, color, suffix = '') {
  const surface = clearCanvas(canvas, '#071117');
  if (!surface) return;
  const { ctx, width, height } = surface; const left = 22, right = 10, top = 10, bottom = 21; const max = Math.max(100, ...values, 1); const min = Math.min(0, ...values); const range = Math.max(1, max - min); const step = (width - left - right) / Math.max(1, values.length - 1);
  ctx.strokeStyle = '#173440'; ctx.lineWidth = 1; [0, .5, 1].forEach((ratio) => { const y = top + (height - top - bottom) * ratio; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke(); });
  const points = values.map((value, index) => [left + index * step, top + (height - top - bottom) * (1 - ((value - min) / range))]);
  if (points.length > 1) {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 7; ctx.beginPath(); points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke(); ctx.shadowBlur = 0;
    points.forEach(([x, y], index) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#9bdff4'; ctx.font = '8px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`${Math.round(values[index])}${suffix}`, x, Math.max(9, y - 8)); ctx.fillStyle = '#667f8a'; ctx.fillText(labels[index], x, height - 7); });
  }
}
function drawSuccessChart() {
  const terminal = dailyJobs().map((day) => {
    const finished = day.jobs.filter((job) => ['completed', 'failed', 'blocked', 'cancelled'].includes(job.status));
    return finished.length ? finished.filter((job) => job.status === 'completed').length / finished.length * 100 : 0;
  });
  drawLineChart($('#success-chart'), terminal, dailyJobs().map((day) => day.label), '#4cd38a', '%');
}
function drawCharts() { drawDonut(); drawExecutionChart(); drawSuccessChart(); }

function renderKpi() {
  const terminal = state.jobs.filter((job) => ['completed', 'failed', 'blocked', 'cancelled'].includes(job.status));
  const completed = state.jobs.filter((job) => job.status === 'completed');
  const tokens = state.jobs.reduce((sum, job) => sum + (Number(job.inputTokens) || 0) + (Number(job.outputTokens) || 0), 0);
  const durations = terminal.map(elapsedFor).filter(Number.isFinite);
  const costs = state.jobs.map((job) => Number(job.costUsd)).filter(Number.isFinite);
  $('#kpi-agents').textContent = state.agents.length;
  $('#kpi-running').textContent = state.jobs.filter((job) => ['running', 'starting'].includes(job.status)).length;
  $('#kpi-queued').textContent = state.jobs.filter((job) => job.status === 'queued').length;
  $('#kpi-completed').textContent = completed.length;
  $('#kpi-success').textContent = terminal.length ? `${Math.round(completed.length / terminal.length * 100)}%` : '—';
  $('#kpi-tokens').textContent = tokens ? (tokens > 999999 ? `${(tokens / 1000000).toFixed(2)}M` : numberText(tokens)) : '—';
  $('#kpi-duration').textContent = durations.length ? durationText(durations.reduce((sum, value) => sum + value, 0) / durations.length) : '—';
  $('#kpi-cost').textContent = costs.length ? `$${costs.reduce((sum, value) => sum + value, 0).toFixed(2)}` : '—';
}
function renderLoad() {
  const usage = state.agents.map((agent) => ({ agent, count: jobsFor(agent.id).length })).sort((a, b) => b.count - a.count || a.agent.name.localeCompare(b.agent.name, 'zh-CN'));
  const max = Math.max(1, ...usage.map((item) => item.count));
  $('#agent-load-list').innerHTML = usage.map(({ agent, count }, index) => `<div class="load-row"><span class="load-rank">${index + 1}</span><span class="load-name">${esc(agent.name)}</span><span class="load-track"><i style="width:${Math.round(count / max * 100)}%"></i></span><span class="load-value">${count}</span></div>`).join('') || '<div class="empty-row">暂无智能体数据</div>';
}
function renderRecent() {
  const jobs = [...state.jobs].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 8);
  $('#recent-list').innerHTML = jobs.length ? jobs.map((job) => `<button class="recent-row" data-job="${esc(job.jobId)}"><i class="recent-dot ${statusClass(job.status)}"></i><span class="recent-task">${esc(job.task || '未命名任务')}</span><span class="recent-agent">${esc(state.agents.find((agent) => agent.id === job.agent)?.name || job.agent || '—')}</span><time class="recent-time">${esc(timeText(job.createdAt))}</time></button>`).join('') : '<div class="empty-row">暂无任务记录</div>';
}
function renderNodes() {
  $('#agent-nodes').innerHTML = state.agents.map((agent) => {
    const jobs = jobsFor(agent.id); const current = jobs.find((job) => ['running', 'starting', 'queued'].includes(job.status)) || jobs[0]; const status = current?.status || 'idle'; const [x, y] = positions[agent.id] || [50, 50];
    return `<button class="agent-node" data-agent="${esc(agent.id)}" data-state="${statusClass(status)}" style="left:${x}%;top:${y}%" title="查看${esc(agent.name)}会话"><span class="role-icon ${roleClass(agent.id)}"></span><span class="agent-node-copy"><strong>${esc(agent.name)}</strong><small class="${statusClass(status)}">${esc(statusLabel(status))}${current?.task ? ` · ${esc(current.task)}` : ''}</small></span></button>`;
  }).join('');
}
function sparkValues(index, base) {
  const values = []; const source = state.jobs.filter((job) => job.agent === state.agents[index % Math.max(1, state.agents.length)]?.id).length;
  for (let i = 0; i < 18; i += 1) values.push(Math.max(0, base + ((source + index + i * 3) % 9) - 4));
  return values;
}
function drawSpark(canvas, values, color) {
  const surface = clearCanvas(canvas, '#071117'); if (!surface) return; const { ctx, width, height } = surface; const max = Math.max(...values, 1); const step = width / Math.max(1, values.length - 1);
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.shadowColor = color; ctx.shadowBlur = 5; ctx.beginPath(); values.forEach((value, index) => { const x = index * step; const y = height - 3 - (value / max) * (height - 8); index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.shadowBlur = 0;
}
function renderResources() {
  const running = state.jobs.filter((job) => ['running', 'starting'].includes(job.status)).length;
  const terminal = state.jobs.filter((job) => ['completed', 'failed', 'blocked', 'cancelled'].includes(job.status));
  const eventCount = state.events.length;
  const rows = [
    ['并发任务', `${running}/${state.agents.length || 0}`, running, '#4cd38a'],
    ['事件记录', `${eventCount}`, eventCount, '#34b9ee'],
    ['验证覆盖', terminal.length ? `${Math.round(terminal.filter((job) => job.verificationState).length / terminal.length * 100)}%` : '—', terminal.length ? terminal.filter((job) => job.verificationState).length : 0, '#e9aa42'],
    ['Token 记录', state.jobs.some((job) => Number(job.inputTokens) || Number(job.outputTokens)) ? '已记录' : '等待记录', state.jobs.filter((job) => Number(job.inputTokens) || Number(job.outputTokens)).length, '#9277e8'],
  ];
  $('#resource-list').innerHTML = rows.map(([label, value, base, color], index) => `<div class="resource-row"><span class="resource-ring" style="border-color:${color};color:${color}">${esc(value)}</span><span class="resource-copy"><small>${esc(label)}</small><b>${esc(value)}</b></span><canvas class="resource-spark" data-spark="${index}"></canvas></div>`).join('');
  document.querySelectorAll('.resource-spark').forEach((canvas, index) => drawSpark(canvas, sparkValues(index, Number(rows[index][2]) || 1), rows[index][3]));
}
function renderAlerts() {
  const alerts = [];
  state.jobs.filter((job) => ['failed', 'blocked'].includes(job.status)).slice(0, 3).forEach((job) => alerts.push({ critical: true, text: `${state.agents.find((agent) => agent.id === job.agent)?.name || job.agent} · ${job.task || '任务失败'}`, time: timeText(job.finishedAt || job.createdAt) }));
  const queued = state.jobs.filter((job) => job.status === 'queued').length;
  if (queued) alerts.push({ text: `${queued} 项任务等待执行资源`, time: '实时' });
  if (state.install && !state.install.installed) alerts.push({ text: 'Claude Agents 插件尚未安装', time: '设置' });
  $('#alert-count').textContent = `${alerts.length} 条`;
  $('#alert-list').innerHTML = alerts.length ? alerts.map((alert) => `<div class="alert-row ${alert.critical ? 'critical' : ''}"><span class="alert-level">${alert.critical ? '!' : 'i'}</span><span>${esc(alert.text)}</span><time>${esc(alert.time)}</time></div>`).join('') : '<div class="empty-row">系统运行正常</div>';
}
function renderPulse() {
  const recentEvents = state.events.slice(-8).reverse();
  if (recentEvents.length) {
    $('#pulse-list').innerHTML = recentEvents.map((event) => { const [kind, icon, detail] = eventView(event); return `<div class="pulse-row"><time>${esc(timeText(event.at))}</time><i></i><b>${esc(kind)}</b><span>${esc(detail)}</span><em>${esc(icon)}</em></div>`; }).join('');
    return;
  }
  const jobs = [...state.jobs].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 8);
  $('#pulse-list').innerHTML = jobs.length ? jobs.map((job) => `<div class="pulse-row"><time>${esc(timeText(job.createdAt))}</time><i></i><b>${esc(state.agents.find((agent) => agent.id === job.agent)?.name || job.agent || '任务')}</b><span>${esc(job.task || phaseLabel(job.phase, job.status))}</span><em>${esc(statusLabel(job.status))}</em></div>`).join('') : '<div class="empty-row">等待事件流</div>';
}
function renderFooter() {
  const connected = state.streamState === 'open' || state.streamState === 'snapshot' || state.lastUpdate;
  $('#connection-state').classList.toggle('connection-error', state.streamState === 'error');
  $('#connection-state').innerHTML = `<i></i><span>${state.streamState === 'error' ? '连接中断' : connected ? '实时连接中' : '本地服务在线'}</span>`;
  $('#system-state').textContent = state.streamState === 'error' ? '异常' : '正常';
  $('#system-state').style.color = state.streamState === 'error' ? 'var(--red)' : 'var(--green)';
  $('#stream-footer').textContent = state.streamState === 'open' ? '活跃' : state.events.length ? '已采样' : '待机';
  $('#data-freshness').textContent = state.lastUpdate ? nowText(state.lastUpdate) : '等待连接';
  $('#core-throughput').textContent = `${state.events.length} events`;
}
function renderAll() {
  renderKpi(); renderLoad(); renderRecent(); renderNodes(); renderResources(); renderAlerts(); renderPulse(); renderFooter(); drawCharts();
}

function renderConfigOptions() {
  const select = $('#config-agent'); const previous = select.value;
  select.innerHTML = state.agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name)}</option>`).join('');
  select.value = previous || state.selectedAgent || state.agents[0]?.id || '';
}
function fillConfig() {
  const agent = state.agents.find((item) => item.id === $('#config-agent').value) || state.agents[0]; const config = agent?.configured || {};
  $('#cfg-model').value = config.model || ''; $('#cfg-effort').value = config.effort || 'high'; $('#cfg-permission').value = config.permissionMode || 'auto'; $('#cfg-output').value = config.outputFormat || 'json'; $('#cfg-timeout').value = config.timeoutMs || 1800000; $('#cfg-budget').value = config.maxBudgetUsd ?? 0; $('#cfg-gateway').value = config.gatewayUrl || ''; $('#cfg-key-kind').value = config.apiKeyKind || 'auth_token'; $('#cfg-api-key').value = ''; $('#cfg-browser-profiles').value = config.browserMcpConfigsJson || '{}';
}
function renderInstall() {
  const codex = Boolean(state.install?.codexAvailable); const market = Boolean(state.install?.marketplaceAvailable); const installed = Boolean(state.install?.installed);
  $('#step-codex').textContent = codex ? '可用' : '未检测到'; $('#step-codex').className = codex ? 'done' : 'fail';
  $('#step-marketplace').textContent = market ? '已注册' : '待注册'; $('#step-marketplace').className = market ? 'done' : '';
  $('#step-plugin').textContent = installed ? '已安装并启用' : '待安装'; $('#step-plugin').className = installed ? 'done' : '';
  $('#install-run').textContent = installed ? '检查更新' : '开始安装'; $('#install-run').disabled = !codex;
  $('#install-output').textContent = installed ? `当前版本 ${state.install.installedVersion || '已安装'}，可检查 marketplace 更新。` : '尚未安装，可从此界面完成安装。';
}

let modalTrigger = null;
function openModal(id) { modalTrigger = document.activeElement; const modal = $(`#${id}`); modal.classList.remove('hidden'); modal.querySelector('button, input, select, textarea')?.focus(); }
function closeModal(id) { $(`#${id}`)?.classList.add('hidden'); modalTrigger?.focus?.(); }
function openSettings(tab = 'agent') {
  document.querySelectorAll('.settings-tab').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === tab));
  document.querySelectorAll('.settings-pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.settingsPane === tab));
  renderConfigOptions(); fillConfig(); renderInstall(); openModal('settings-modal');
}
function filteredEvents() {
  if (state.tab === 'events') return state.events;
  return state.events.filter((event) => { const kind = eventClass(event); return state.tab === 'tools' ? Boolean(kind.tool) : state.tab === 'files' ? kind.file : kind.check; });
}
function renderSession() {
  const agent = state.agents.find((item) => item.id === state.selectedAgent); const job = activeJob(); const status = job?.status || 'idle'; const config = agent?.configured || {};
  $('#session-role-icon').className = `session-role-icon ${roleClass(agent?.id || '')}`; $('#session-title').textContent = agent?.name || '智能体会话'; $('#session-task').textContent = job?.task || '该智能体暂无任务记录'; $('#session-meta').textContent = job ? `${job.sessionId || '无会话 ID'} · ${job.cwd || '当前仓库'}` : '点击星图节点查看会话详情';
  $('#session-state').dataset.status = status; $('#session-state').innerHTML = `<i></i><span>${esc(phaseLabel(job?.phase, status))}</span>`;
  const result = state.result || {}; const verification = job?.verificationState; const title = { completed: '任务已完成', failed: '任务执行失败', cancelled: '任务已取消', blocked: '任务已阻断', running: '任务正在执行', starting: '正在启动任务', queued: '任务正在排队' }[status] || '等待任务';
  const summary = String(result.summary || (job ? '该任务暂无保存结果摘要。' : '选择一条任务记录后查看执行结果。'));
  $('#overview-title').textContent = title; $('#overview-summary').textContent = summary.length > 320 ? `${summary.slice(0, 317)}...` : summary; $('#overview-verification').textContent = result.verificationSummary || '';
  $('#overview-status').textContent = phaseLabel(job?.phase, status); $('#overview-duration').textContent = durationText(elapsedFor(job)); $('#overview-check').textContent = verification === 'passed' ? '验证通过' : verification === 'failed' ? '验证失败' : job ? '尚未验证' : '等待执行'; $('#overview-cost').textContent = Number.isFinite(Number(job?.costUsd)) ? `$${Number(job.costUsd).toFixed(4)}` : '—';
  $('#session-runtime').textContent = `模型 ${config.model || '—'} · 思考强度 ${config.effort || '—'} · 权限 ${config.permissionMode || '—'}`;
  const visible = filteredEvents(); $('#event-count').textContent = state.events.length; $('#tool-count').textContent = state.events.filter((event) => eventClass(event).tool).length; $('#file-count').textContent = state.events.filter((event) => eventClass(event).file).length; $('#check-count').textContent = state.events.filter((event) => eventClass(event).check).length;
  $('#event-viewport').innerHTML = visible.length ? visible.map((event) => { const [kind, icon, detail] = eventView(event); return `<div class="event-row"><span class="event-time">${esc(timeText(event.at))}</span><span class="event-dot">${esc(icon)}</span><span class="event-kind">${esc(kind)}</span><span class="event-main"><strong>${esc(event.subtype || kind)}</strong><small>${esc(detail)}</small></span><span class="event-result">${event.type === 'result' ? '完成' : ''}</span></div>`; }).join('') : '<div class="empty-events"><strong>此分类暂无记录</strong><small>历史快照可能没有完整事件流。</small></div>';
  $('#stream-status').textContent = state.streamState === 'open' ? 'SSE 已连接' : state.streamState === 'error' ? 'SSE 已中断' : state.selectedJob ? '历史快照' : '未连接';
}
async function selectJob(jobId, open = false) {
  state.selectedJob = jobId || null; state.events = []; state.cursor = 0; state.result = null; state.lastUpdate = null;
  const job = activeJob(); if (job) state.selectedAgent = job.agent;
  if (job) {
    const data = await api(`/api/jobs/${encodeURIComponent(job.jobId)}/events?after=0`); state.events = data.events || []; state.cursor = data.cursor; state.jobs = state.jobs.map((item) => item.jobId === job.jobId ? data.meta : item);
    if (data.meta?.resultAvailable) { try { const result = await api(`/api/jobs/${encodeURIComponent(job.jobId)}/result`); state.result = result.result || null; } catch { state.result = null; } }
    state.lastUpdate = new Date().toISOString(); connectStream(job.status === 'running' || job.status === 'starting' ? job.jobId : null);
  } else closeStream();
  renderAll(); if (open) { renderSession(); openModal('session-modal'); }
}
async function selectAgent(agentId, open = true) {
  state.selectedAgent = agentId; const latest = jobsFor(agentId).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0]; await selectJob(latest?.jobId || null, open);
}
function closeStream() { if (state.stream) state.stream.close(); state.stream = null; state.streamState = 'idle'; }
function connectStream(jobId) {
  closeStream(); if (!jobId) return;
  state.streamState = 'connecting'; state.stream = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream?token=${encodeURIComponent(token)}&after=${state.cursor}`);
  state.stream.onopen = () => { state.streamState = 'open'; renderFooter(); renderSession(); };
  state.stream.onmessage = (message) => {
    try {
      const data = JSON.parse(message.data); if (jobId !== state.selectedJob) return; const known = new Set(state.events.map((event) => event.seq)); state.events.push(...(data.events || []).filter((event) => !known.has(event.seq))); state.cursor = data.cursor; state.jobs = state.jobs.map((item) => item.jobId === jobId ? data.meta : item); state.lastUpdate = new Date().toISOString(); renderAll(); if (document.querySelector('#session-modal:not(.hidden)')) renderSession();
      if (!['running', 'starting', 'queued'].includes(data.meta?.status)) closeStream();
    } catch (error) { showToast(error.message, 'error'); }
  };
  state.stream.onerror = () => { if (state.streamState !== 'snapshot') state.streamState = 'error'; renderFooter(); if (document.querySelector('#session-modal:not(.hidden)')) renderSession(); };
}
async function refreshBootstrap() {
  const data = await api('/api/bootstrap'); state.agents = data.agents || []; state.jobs = Array.isArray(data.jobs) ? data.jobs : []; state.cwd = data.cwd || ''; state.install = data.installation || null;
  if (!state.selectedAgent || !state.agents.some((agent) => agent.id === state.selectedAgent)) state.selectedAgent = state.agents[0]?.id || null;
  if (state.selectedJob && !state.jobs.some((job) => job.jobId === state.selectedJob)) state.selectedJob = null;
  renderConfigOptions(); renderAll(); renderInstall();
  if (!state.selectedJob) { const active = state.jobs.find((job) => ['running', 'starting'].includes(job.status)); if (active) { state.selectedAgent = active.agent; state.selectedJob = active.jobId; connectStream(active.jobId); } }
}
async function install() {
  $('#install-run').disabled = true; $('#install-output').textContent = '正在调用 Codex CLI…';
  try { const result = await post('/api/install', {}); state.install = result.installation || state.install; renderInstall(); $('#install-output').textContent = [result.marketplace?.stdout, result.marketplace?.stderr, result.plugin?.stdout, result.plugin?.stderr].filter(Boolean).join('\n') || '插件安装或更新检查完成。'; showToast('插件状态已更新，重启 Codex 后新任务即可加载。', 'success'); await refreshBootstrap(); } catch (error) { $('#install-output').textContent = error.message; showToast(error.message, 'error'); } finally { $('#install-run').disabled = !state.install?.codexAvailable; }
}
async function saveConfig() {
  const values = { model: $('#cfg-model').value.trim(), effort: $('#cfg-effort').value, permissionMode: $('#cfg-permission').value, outputFormat: $('#cfg-output').value, timeoutMs: $('#cfg-timeout').value, maxBudgetUsd: $('#cfg-budget').value, gatewayUrl: $('#cfg-gateway').value.trim(), apiKeyKind: $('#cfg-key-kind').value, browserMcpConfigsJson: $('#cfg-browser-profiles').value.trim() || '{}' };
  if ($('#cfg-api-key').value) values.apiKey = $('#cfg-api-key').value;
  try { await post('/api/config', { agent: $('#config-agent').value, values }); showToast('配置已保存到 SQLite，并将用于后续任务。', 'success'); await refreshBootstrap(); } catch (error) { showToast(error.message, 'error'); }
}

$('#settings-open').addEventListener('click', () => openSettings('agent'));
$('#config-agent').addEventListener('change', fillConfig);
$('#config-save').addEventListener('click', saveConfig);
$('#install-run').addEventListener('click', install);
$('#recent-refresh').addEventListener('click', () => refreshBootstrap().catch((error) => showToast(error.message, 'error')));
$('#pulse-more').addEventListener('click', () => state.selectedJob ? (renderSession(), openModal('session-modal')) : showToast('当前没有可查看的会话记录。'));
$('#refresh-events').addEventListener('click', () => selectJob(state.selectedJob, true).catch((error) => showToast(error.message, 'error')));
document.querySelectorAll('.settings-tab').forEach((button) => button.addEventListener('click', () => openSettings(button.dataset.settingsTab)));
document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => { state.tab = button.dataset.tab; document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === button)); renderSession(); }));
$('#agent-nodes').addEventListener('click', (event) => { const node = event.target.closest('[data-agent]'); if (node) selectAgent(node.dataset.agent, true).catch((error) => showToast(error.message, 'error')); });
$('#recent-list').addEventListener('click', (event) => { const row = event.target.closest('[data-job]'); if (!row) return; selectJob(row.dataset.job, true).catch((error) => showToast(error.message, 'error')); });
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
document.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(backdrop.id); }));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { const modal = document.querySelector('.modal-backdrop:not(.hidden)'); if (modal) closeModal(modal.id); } });
window.addEventListener('resize', drawCharts);
setInterval(() => { $('#clock').textContent = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'); }, 1000);
setInterval(() => refreshBootstrap().catch(() => { state.streamState = 'error'; renderFooter(); }), 5000);
$('#clock').textContent = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
refreshBootstrap().catch((error) => showToast(error.message, 'error'));
