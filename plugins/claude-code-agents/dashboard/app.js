import { createMotionSnapshot, diffDashboardMotion, mergeStreamJobMeta, meaningfulJobMetaEqual, sessionStatusFor, chartFingerprint, resourceRows, resourceFingerprint, resourceDirtyKeys, patchResourceRows, dashboardMeaningfulChange, createReconnectState, agentNodeRecords, agentNodeFingerprint, triggerMotion, removeAfterMotion, applyTopologyLinkGeometry, topologyLinkGeometry, shouldAnimateLinkTransition, statusClassFor, createModalMotionController } from './dashboard-motion.mjs';
import { createDashboardScheduler } from './dashboard-scheduler.mjs';
import { capabilityOptions, effortOptionsForModel, visibleConfigFields } from './dashboard-config.mjs';

const token = document.querySelector('meta[name="dashboard-token"]').content;
const state = {
  agents: [], runners: [], jobs: [], install: null, cwd: '', selectedAgent: null, selectedJob: null,
  events: [], cursor: 0, result: null, tab: 'events', stream: null,
  streamState: 'idle', lastUpdate: null,
  reconnect: createReconnectState(),
  modelCatalogs: new Map(), modelRequestId: 0,
  motionSnapshot: createMotionSnapshot(), chartFingerprint: '', resourceData: null, resourceFingerprint: '', resourceDimensions: {}, resourceRows: new Map(), resizeFrame: null,
};
const FALLBACK_RUNNERS = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex CLI' },
  { id: 'grok', name: 'Grok CLI' },
  { id: 'agy', name: 'Antigravity CLI' },
];

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const customSelects = new Map();
let customSelectSequence = 0;
const configSelectionStorageKey = 'multi-cli-agents:config-selection';
const readConfigSelection = () => {
  try { return JSON.parse(localStorage.getItem(configSelectionStorageKey) || '{}'); } catch { return {}; }
};
const rememberConfigSelection = () => {
  try { localStorage.setItem(configSelectionStorageKey, JSON.stringify({ agent: $('#config-agent')?.value || '', runner: $('#config-runner')?.value || 'default' })); } catch {}
};
const closeCustomSelects = (except = null) => {
  customSelects.forEach((control) => {
    if (control !== except) control.setOpen(false);
  });
};
function syncCustomSelect(native) {
  const control = customSelects.get(native);
  if (!control) return;
  const options = [...native.options];
  control.menu.innerHTML = '';
  options.forEach((option, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'select-option';
    item.role = 'option';
    item.dataset.value = option.value;
    item.disabled = option.disabled;
    item.setAttribute('aria-selected', String(index === native.selectedIndex));
    item.innerHTML = `<span class="select-option-mark" aria-hidden="true">✓</span><span>${esc(option.textContent)}</span>`;
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      native.selectedIndex = index;
      native.dispatchEvent(new Event('change', { bubbles: true }));
      control.setOpen(false);
    });
    control.menu.append(item);
  });
  const selected = native.options[native.selectedIndex];
  control.label.textContent = selected?.textContent || '请选择';
  control.trigger.setAttribute('aria-expanded', String(control.open));
}
function syncCustomSelects() {
  customSelects.forEach((control) => syncCustomSelect(control.native));
}
function createCustomSelect(native) {
  if (customSelects.has(native)) return customSelects.get(native);
  const wrapper = document.createElement('div');
  wrapper.className = 'select-control';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', native.getAttribute('aria-label') || native.id || '选择');
  const label = document.createElement('span');
  const menu = document.createElement('div');
  menu.className = 'select-menu';
  menu.role = 'listbox';
  menu.id = `${native.id || 'select'}-menu-${customSelectSequence += 1}`;
  trigger.setAttribute('aria-controls', menu.id);
  trigger.append(label);
  wrapper.append(trigger, menu);
  native.classList.add('native-select');
  native.parentNode.insertBefore(wrapper, native);
  wrapper.append(native);
  const control = {
    native,
    wrapper,
    trigger,
    label,
    menu,
    open: false,
    setOpen(open) {
      control.open = Boolean(open);
      wrapper.classList.toggle('is-open', control.open);
      trigger.setAttribute('aria-expanded', String(control.open));
      if (control.open) {
        closeCustomSelects(control);
        menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
      }
    },
  };
  customSelects.set(native, control);
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    control.setOpen(!control.open);
  });
  trigger.addEventListener('keydown', (event) => {
    const options = [...native.options].filter((option) => !option.disabled);
    if (!options.length) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      control.setOpen(!control.open);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      control.setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, options.findIndex((option) => option.index === native.selectedIndex));
    const next = event.key === 'ArrowDown' ? Math.min(options.length - 1, current + 1) : Math.max(0, current - 1);
    native.selectedIndex = options[next].index;
    native.dispatchEvent(new Event('change', { bubbles: true }));
    control.setOpen(true);
  });
  native.addEventListener('change', () => syncCustomSelect(native));
  syncCustomSelect(native);
  return control;
}
function enhanceSelects() {
  document.querySelectorAll('select').forEach((native) => createCustomSelect(native));
}
document.addEventListener('click', (event) => {
  closeCustomSelects();
  if (!event.target.closest('.model-combobox')) setModelMenuOpen(false);
});
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
const phaseLabel = (phase, status) => ({ disconnected: '连接中断', completed: '执行完成', failed: '执行失败', cancelled: '已取消', blocked: '已阻断', running: '正在执行', starting: '启动中', queued: '排队中' }[status] || ({ inspecting: '检查仓库', implementing: '正在实施', verifying: '验证中', finalizing: '收尾' }[phase] || '待机'));
const agentBadge = (id) => ({ architect: 'AR', 'backend-engineer': 'BE', 'frontend-engineer': 'FE', 'ui-designer': 'UI', 'fullstack-engineer': 'FS', 'qa-engineer': 'QA', 'security-engineer': 'SE', 'devops-engineer': 'DO' }[id] || 'AG');
const roleClass = (id) => `role-${id}`;
const statusClass = statusClassFor;
const statusLabel = (status) => ({ running: '运行中', starting: '启动中', queued: '排队', completed: '成功', failed: '失败', blocked: '阻断', cancelled: '取消' }[status] || '空闲');
const statusColor = { completed: '#4cd38a', running: '#4cd38a', starting: '#4cd38a', queued: '#e9aa42', failed: '#ef5c5c', blocked: '#ef5c5c', cancelled: '#7f969f' };
const motionDuration = { enter: 160, status: 800, link: 800, kpi: 320, overlay: 180 };
const prefersReducedMotionNow = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const motionAllowed = (source) => source !== 'bootstrap' && source !== 'recovery' && !document.hidden;
const motionElement = (selector) => document.querySelector(selector);
const triggerIfAllowed = (element, className, duration, source) => motionAllowed(source) && !prefersReducedMotionNow() && triggerMotion(element, className, duration);
const topologyLinkFor = (transition) => {
  const constellation = $('#constellation');
  const node = constellation?.querySelector(`[data-agent="${CSS.escape(String(transition.agentId))}"]`);
  const core = constellation?.querySelector('.core-label');
  if (!constellation || !node || !core) return null;
  const bounds = constellation.getBoundingClientRect();
  const coreBounds = core.getBoundingClientRect();
  const nodeBounds = node.getBoundingClientRect();
  const host = document.createElement('span');
  host.className = 'topology-link';
  host.dataset.agent = String(transition.agentId);
  host.dataset.target = String(transition.agentId);
  host.dataset.jobId = String(transition.jobId);
  applyTopologyLinkGeometry(host, topologyLinkGeometry(
    { x: coreBounds.left + coreBounds.width / 2, y: coreBounds.top + coreBounds.height / 2 },
    { x: nodeBounds.left + nodeBounds.width / 2, y: nodeBounds.top + nodeBounds.height / 2 },
    bounds,
  ));
  host.style.setProperty('--motion-link-color', statusColor[transition.to?.status] || 'var(--cyan)');
  constellation.append(host);
  return host;
};
const positions = {
  architect: [50, 12], 'backend-engineer': [80, 26], 'frontend-engineer': [87, 52], 'ui-designer': [72, 78],
  'fullstack-engineer': [50, 87], 'qa-engineer': [28, 78], 'security-engineer': [13, 52], 'devops-engineer': [20, 26],
};
const showToast = (message, kind = '') => {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = message;
  $('#toast-region').append(element);
  triggerMotion(element, 'motion-toast-enter', motionDuration.overlay);
  window.setTimeout(() => removeAfterMotion(element, 'motion-toast-exit', motionDuration.overlay), 3600);
};
const activeJob = () => state.jobs.find((job) => job.jobId === state.selectedJob) || null;
const jobsFor = (agent) => state.jobs.filter((job) => job.agent === agent);
const stateSnapshotData = () => ({ agents: state.agents, jobs: state.jobs, events: state.events, alerts: state.alerts || [] });
const deriveAlerts = () => {
  const alerts = [];
  state.jobs.filter((job) => ['failed', 'blocked'].includes(job.status)).slice(0, 3).forEach((job) => alerts.push({ id: `job:${job.jobId}`, critical: true, text: `${state.agents.find((agent) => agent.id === job.agent)?.name || job.agent} · ${job.task || '任务失败'}`, time: timeText(job.finishedAt || job.createdAt) }));
  const queued = state.jobs.filter((job) => job.status === 'queued').length;
  if (queued) alerts.push({ id: 'queued', text: `${queued} 项任务等待执行资源`, time: '实时' });
  if (state.install && !state.install.installed) alerts.push({ id: 'install', text: 'Multi-CLI Agents 插件尚未安装', time: '设置' });
  return alerts;
};

const motionScheduler = createDashboardScheduler({
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
  isHidden: () => document.hidden,
  isMeaningfulChange: dashboardMeaningfulChange,
  render: (snapshot, source, options) => {
    const renderSource = options.baseline ? 'recovery' : source;
    const diff = diffDashboardMotion(state.motionSnapshot, snapshot, renderSource);
    state.motionSnapshot = snapshot;
    renderDashboard(snapshot, renderSource, diff, options);
  },
});

const scheduleRender = (source = 'poll', options = {}) => {
  const data = stateSnapshotData();
  data.alerts = deriveAlerts();
  return motionScheduler.schedule(createMotionSnapshot(data), source, options);
};

function scheduleResize() {
  if (state.resizeFrame !== null) return;
  state.resizeFrame = window.requestAnimationFrame(() => {
    state.resizeFrame = null;
    renderResources();
    drawCharts();
  });
}

function patchKeyedList(container, records, keyOf, htmlFor, emptyHtml, fingerprintOf = JSON.stringify, { updateElement = null, onCreate = null } = {}) {
  if (!container) return;
  if (!records.length) { container.innerHTML = emptyHtml; return; }
  const existing = new Map([...container.children].map((child) => [child.dataset.motionKey, child]));
  const used = new Set();
  records.forEach((record) => {
    const key = String(keyOf(record));
    const fingerprint = fingerprintOf(record);
    let element = existing.get(key);
    if (element && element.dataset.renderFingerprint !== fingerprint) {
      if (typeof updateElement === 'function') {
        updateElement(element, record);
        element.dataset.renderFingerprint = fingerprint;
      } else {
        const template = document.createElement('template');
        template.innerHTML = htmlFor(record).trim();
        const replacement = template.content.firstElementChild;
        replacement.dataset.motionKey = key;
        replacement.dataset.renderFingerprint = fingerprint;
        element.replaceWith(replacement);
        element = replacement;
      }
    } else if (!element) {
      const template = document.createElement('template');
      template.innerHTML = htmlFor(record).trim();
      element = template.content.firstElementChild;
      element.dataset.motionKey = key;
      element.dataset.renderFingerprint = fingerprint;
      container.append(element);
      onCreate?.(element, record);
    }
    used.add(key);
    container.append(element);
  });
  [...container.children].forEach((child) => { if (!used.has(child.dataset.motionKey)) child.remove(); });
}

function eventTool(event) {
  const content = event?.message?.content;
  const contentTool = Array.isArray(content) ? content.find((item) => item?.type === 'tool_use') : null;
  if (contentTool) return contentTool;
  const type = String(event?.type || '').toLowerCase();
  if (!/tool|command|shell|edit|write|patch/.test(type)) return null;
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  return { name: event?.tool_name || event?.name || data.name || type, input: event?.input || data.input || data };
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
  const streamText = typeof event?.data === 'string' ? event.data : '';
  const type = String(event?.type || event?.status || event?.subtype || '').trim();
  const error = event?.error?.message || event?.error || event?.detail;
  if (error) return ['运行错误', 'ERR', String(error)];
  if (text || streamText) return [event?.type === 'thought' ? '推理摘要' : '模型消息', 'MSG', text || streamText];
  if (type) return ['运行事件', 'EVT', type];
  return ['运行事件', 'EVT', '未命名事件'];
}

function hasEventDetail(event) {
  const [, , detail] = eventView(event);
  return Boolean(detail && detail !== '未命名事件');
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
function chartDimensions() {
  return Object.fromEntries(['status-donut', 'execution-chart', 'success-chart'].map((id) => {
    const rect = $(`#${id}`)?.getBoundingClientRect();
    return [id, rect ? [Math.floor(rect.width), Math.floor(rect.height)] : [0, 0]];
  }));
}
function drawCharts() {
  const fingerprint = chartFingerprint(state.jobs, chartDimensions());
  if (fingerprint === state.chartFingerprint) return;
  state.chartFingerprint = fingerprint;
  drawDonut(); drawExecutionChart(); drawSuccessChart();
}

function renderKpi(diff, source) {
  const terminal = state.jobs.filter((job) => ['completed', 'failed', 'blocked', 'cancelled'].includes(job.status));
  const completed = state.jobs.filter((job) => job.status === 'completed');
  const tokens = state.jobs.reduce((sum, job) => sum + (Number(job.inputTokens) || 0) + (Number(job.outputTokens) || 0), 0);
  const durations = terminal.map(elapsedFor).filter(Number.isFinite);
  const costs = state.jobs.map((job) => Number(job.costUsd)).filter(Number.isFinite);
  const values = {
    agents: state.agents.length,
    running: state.jobs.filter((job) => ['running', 'starting'].includes(job.status)).length,
    queued: state.jobs.filter((job) => job.status === 'queued').length,
    completed: completed.length,
    success: terminal.length ? `${Math.round(completed.length / terminal.length * 100)}%` : '—',
    tokens: tokens ? (tokens > 999999 ? `${(tokens / 1000000).toFixed(2)}M` : numberText(tokens)) : '—',
    duration: durations.length ? durationText(durations.reduce((sum, value) => sum + value, 0) / durations.length) : '—',
    cost: costs.length ? `$${costs.reduce((sum, value) => sum + value, 0).toFixed(2)}` : '—',
  };
  Object.entries(values).forEach(([key, value]) => {
    const element = motionElement(`#kpi-${key}`);
    if (!element) return;
    element.textContent = value;
    if (diff?.kpiChanges?.some((change) => change.key === key)) triggerIfAllowed(element, 'motion-kpi-change', motionDuration.kpi, source);
  });
}
function renderLoad() {
  const usage = state.agents.map((agent) => ({ agent, count: jobsFor(agent.id).length })).sort((a, b) => b.count - a.count || a.agent.name.localeCompare(b.agent.name, 'zh-CN'));
  const max = Math.max(1, ...usage.map((item) => item.count));
  patchKeyedList($('#agent-load-list'), usage, ({ agent }) => agent.id, ({ agent, count }, index) => `<div class="load-row"><span class="load-rank">${index + 1}</span><span class="load-name">${esc(agent.name)}</span><span class="load-track"><i style="width:${Math.round(count / max * 100)}%"></i></span><span class="load-value">${count}</span></div>`, '<div class="empty-row">暂无智能体数据</div>');
}
function renderRecent() {
  const jobs = [...state.jobs].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 8);
  patchKeyedList($('#recent-list'), jobs, (job) => job.jobId, (job) => `<button class="recent-row" data-job="${esc(job.jobId)}"><i class="recent-dot ${statusClass(job.status)}"></i><span class="recent-task">${esc(job.task || '未命名任务')}</span><span class="recent-agent">${esc(state.agents.find((agent) => agent.id === job.agent)?.name || job.agent || '—')}</span><time class="recent-time">${esc(timeText(job.createdAt))}</time></button>`, '<div class="empty-row">暂无任务记录</div>');
}
function renderNodes(diff, source) {
  const records = agentNodeRecords(state.agents, state.jobs);
  const transitions = new Map((diff?.agentTransitions || []).map((transition) => [String(transition.id), transition]));
  patchKeyedList($('#agent-nodes'), records, (record) => record.agent.id, (record) => {
    const { agent, status, task } = record; const [x, y] = positions[agent.id] || [50, 50];
    return `<button class="agent-node" data-agent="${esc(agent.id)}" data-state="${statusClass(status)}" style="left:${x}%;top:${y}%" title="查看${esc(agent.name)}会话"><span class="role-icon ${roleClass(agent.id)}"></span><span class="agent-node-copy"><strong>${esc(agent.name)}</strong><small class="${statusClass(status)}">${esc(statusLabel(status))}${task ? ` · ${esc(task)}` : ''}</small></span></button>`;
  }, '<div class="empty-row">暂无智能体数据</div>', agentNodeFingerprint, {
    updateElement: (element, record) => {
      const { agent, status, task } = record;
      element.dataset.state = statusClass(status);
      const label = element.querySelector('.agent-node-copy small');
      if (label) { label.className = statusClass(status); label.textContent = `${statusLabel(status)}${task ? ` · ${task}` : ''}`; }
    },
  });
  transitions.forEach((transition, id) => {
    triggerIfAllowed(motionElement(`#agent-nodes [data-agent="${CSS.escape(id)}"]`), 'motion-status-ring', motionDuration.status, source);
  });
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
function resourceDimensions() {
  return Object.fromEntries([...document.querySelectorAll('.resource-spark')].map((canvas) => [canvas.dataset.resourceKey, [Math.floor(canvas.getBoundingClientRect().width), Math.floor(canvas.getBoundingClientRect().height)]]));
}

function renderResources() {
  const data = { agents: state.agents, jobs: state.jobs, events: state.events };
  const rows = resourceRows(data);
  const nextRows = new Map(rows.map((row) => [row.key, row]));
  const dimensionsBefore = state.resourceDimensions;
  const list = $('#resource-list');
  const dirtyKeys = state.resourceData === null
    ? new Set(rows.map((row) => row.key))
    : resourceDirtyKeys(state.resourceData, data, dimensionsBefore, resourceDimensions());
  patchResourceRows(list, rows, dirtyKeys, {
    createRow: (row) => {
      const template = document.createElement('template');
      template.innerHTML = `<div class="resource-row" data-resource-key="${esc(row.key)}"><span class="resource-ring"></span><span class="resource-copy"><small></small><b></b></span><canvas class="resource-spark" data-resource-key="${esc(row.key)}"></canvas></div>`;
      return template.content.firstElementChild;
    },
    updateRow: (element, row) => {
      const ring = element.querySelector('.resource-ring');
      const label = element.querySelector('.resource-copy small');
      const value = element.querySelector('.resource-copy b');
      if (ring) { ring.style.borderColor = row.color; ring.style.color = row.color; ring.textContent = row.value; }
      if (label) label.textContent = row.label;
      if (value) value.textContent = row.value;
    },
  });
  const dimensionsAfter = resourceDimensions();
  const resizedKeys = state.resourceData === null ? [] : resourceDirtyKeys(state.resourceData, data, dimensionsBefore, dimensionsAfter);
  const drawKeys = new Set([...dirtyKeys, ...resizedKeys]);
  document.querySelectorAll('.resource-spark').forEach((canvas) => {
    const key = canvas.dataset.resourceKey;
    const row = nextRows.get(key);
    if (row && drawKeys.has(key)) drawSpark(canvas, row.sparkValues, row.color);
  });
  state.resourceData = { agents: [...state.agents], jobs: [...state.jobs], events: [...state.events] };
  state.resourceRows = nextRows;
  state.resourceDimensions = dimensionsAfter;
  state.resourceFingerprint = resourceFingerprint(data, dimensionsAfter);
}
function renderAlerts(diff, source) {
  const alerts = [];
  state.jobs.filter((job) => ['failed', 'blocked'].includes(job.status)).slice(0, 3).forEach((job) => alerts.push({ id: `job:${job.jobId}`, critical: true, text: `${state.agents.find((agent) => agent.id === job.agent)?.name || job.agent} · ${job.task || '任务失败'}`, time: timeText(job.finishedAt || job.createdAt) }));
  const queued = state.jobs.filter((job) => job.status === 'queued').length;
  if (queued) alerts.push({ id: 'queued', text: `${queued} 项任务等待执行资源`, time: '实时' });
  if (state.install && !state.install.installed) alerts.push({ id: 'install', text: 'Multi-CLI Agents 插件尚未安装', time: '设置' });
  state.alerts = alerts;
  $('#alert-count').textContent = `${alerts.length} 条`;
  patchKeyedList($('#alert-list'), alerts, (alert) => alert.id, (alert) => `<div class="alert-row ${alert.critical ? 'critical' : ''}"><span class="alert-level">${alert.critical ? '!' : 'i'}</span><span>${esc(alert.text)}</span><time>${esc(alert.time)}</time></div>`, '<div class="empty-row">系统运行正常</div>');
  if (motionAllowed(source)) (diff?.alertChanges || []).forEach(({ id }) => triggerMotion(motionElement(`#alert-list [data-motion-key="${CSS.escape(String(id))}"]`), 'motion-alert-enter', motionDuration.enter));
}
function renderPulse() {
  const recentEvents = state.events.slice(-8).reverse();
  if (recentEvents.length) {
    patchKeyedList($('#pulse-list'), recentEvents, (event) => event.seq, (event) => { const [kind, icon, detail] = eventView(event); return `<div class="pulse-row"><time>${esc(timeText(event.at))}</time><i></i><b>${esc(kind)}</b><span>${esc(detail)}</span><em>${esc(icon)}</em></div>`; }, '<div class="empty-row">等待事件流</div>');
    return;
  }
  const jobs = [...state.jobs].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 8);
  patchKeyedList($('#pulse-list'), jobs, (job) => `job:${job.jobId}`, (job) => `<div class="pulse-row"><time>${esc(timeText(job.createdAt))}</time><i></i><b>${esc(state.agents.find((agent) => agent.id === job.agent)?.name || job.agent || '任务')}</b><span>${esc(job.task || phaseLabel(job.phase, job.status))}</span><em>${esc(statusLabel(job.status))}</em></div>`, '<div class="empty-row">等待事件流</div>');
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
function renderDashboard(snapshot, source, diff, options = {}) {
  const renderSource = options.baseline ? 'recovery' : source;
  renderKpi(diff, renderSource); renderLoad(); renderRecent(); renderNodes(diff, renderSource); renderResources(); renderAlerts(diff, renderSource); renderPulse(); renderFooter();
  drawCharts();
  if (state.selectedJob && document.querySelector('#session-modal:not(.hidden)')) renderSession(diff, renderSource);
  if (motionAllowed(renderSource)) {
    (diff?.linkTransitions || []).forEach((transition) => {
      if (!shouldAnimateLinkTransition(transition, {
        source: renderSource,
        selectedJobId: state.selectedJob,
        hasNewEvent: Boolean(diff?.newEvents?.length),
      })) return;
      const link = topologyLinkFor(transition);
      if (link) triggerMotion(link, 'motion-link-travel', motionDuration.link, { onCleanup: () => link.remove() });
    });
  }
}

function renderAll() {
  scheduleRender('interaction', { force: true });
}

function renderConfigOptions() {
  const savedSelection = readConfigSelection();
  const select = $('#config-agent'); const previous = select.value;
  select.innerHTML = state.agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name)}</option>`).join('');
  select.value = savedSelection.agent || previous || state.selectedAgent || state.agents[0]?.id || '';
  syncCustomSelect(select);
  const runnerSelect = $('#config-runner'); const runnerPrevious = savedSelection.runner || runnerSelect.value || 'default'; const runners = state.runners.length ? state.runners : FALLBACK_RUNNERS;
  runnerSelect.innerHTML = `<option value="default">默认 Runner</option>${runners.map((runner) => `<option value="${esc(runner.id)}">${esc(runner.name)}${runner.available === false ? '（未安装）' : ''}</option>`).join('')}`;
  runnerSelect.value = [...runnerSelect.options].some((option) => option.value === runnerPrevious) ? runnerPrevious : 'default';
  syncCustomSelect(runnerSelect);
}
const configOptionLabels = {
  default: '默认', none: '无', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: '超高',
  auto: '自动确认', plan: '仅规划', acceptEdits: '自动接受编辑', bypassPermissions: '跳过权限确认', dontAsk: '禁止询问',
  text: '文本', json: 'JSON', 'stream-json': '流式 JSON',
};
function fillCapabilitySelect(selector, values, configuredValue, fallbackValue) {
  const select = $(selector); const supported = Array.isArray(values) && values.length ? values : [configuredValue || fallbackValue];
  select.innerHTML = supported.map((value) => `<option value="${esc(value)}">${esc(configOptionLabels[value] || value)}</option>`).join('');
  select.value = supported.includes(configuredValue) ? configuredValue : supported.includes(fallbackValue) ? fallbackValue : supported[0];
  syncCustomSelect(select);
}
function configContext() {
  const agent = state.agents.find((item) => item.id === $('#config-agent').value) || state.agents[0];
  const runner = $('#config-runner').value || 'default';
  const config = runner === 'default' ? (agent?.configured || {}) : (agent?.configuredByRunner?.[runner] || {});
  const runnerId = runner === 'default' ? (config.runner || agent?.runtime?.runner || 'claude') : runner;
  const capabilities = state.runners.find((item) => item.id === runnerId)?.capabilities || {};
  return { agent, runner, runnerId, config, capabilities, fields: visibleConfigFields(capabilities, agent?.id) };
}
function modelCatalogKey(context) {
  const gatewayUrl = context.fields.has('gatewayUrl') ? $('#cfg-gateway').value.trim() : '';
  const apiKeyKind = context.fields.has('apiKeyKind') ? $('#cfg-key-kind').value : '';
  const apiKey = context.fields.has('apiKey') ? $('#cfg-api-key').value : '';
  let fingerprint = 2166136261;
  for (const char of apiKey) fingerprint = Math.imul(fingerprint ^ char.charCodeAt(0), 16777619);
  return `${context.agent?.id || ''}:${context.runnerId}:${gatewayUrl}:${apiKeyKind}:${fingerprint >>> 0}`;
}
function setConfigFieldVisibility(context) {
  document.querySelectorAll('[data-config-field]').forEach((element) => {
    element.classList.toggle('is-hidden', !context.fields.has(element.dataset.configField));
  });
}
function matchingModel(context, catalog) {
  const value = $('#cfg-model').value.trim();
  return (catalog?.models || []).find((model) => model.id === value);
}
function applyModelEfforts(context, catalog, preferred = $('#cfg-effort').value || context.config.effort) {
  const values = effortOptionsForModel(context.capabilities, matchingModel(context, catalog));
  fillCapabilitySelect('#cfg-effort', values, preferred, context.capabilities.defaultEffort || 'default');
}
function setModelMenuOpen(open) {
  const combo = $('#cfg-model').closest('.model-combobox');
  const menu = $('#cfg-model-menu');
  combo.classList.toggle('is-open', open);
  menu.classList.toggle('hidden', !open);
  $('#cfg-model').setAttribute('aria-expanded', String(open));
}
function renderModelMenu(context, catalog, filter = '') {
  const normalized = filter.trim().toLowerCase();
  const models = (catalog?.models || []).filter((model) => !normalized
    || `${model.id} ${model.displayName} ${model.description}`.toLowerCase().includes(normalized));
  const menu = $('#cfg-model-menu');
  menu.innerHTML = models.map((model) => `<button class="model-option" type="button" role="option" data-model="${esc(model.id)}"><strong>${esc(model.displayName || model.id)}</strong>${model.isDefault ? '<span>默认</span>' : ''}<small>${esc(model.id)}${model.description ? ` · ${esc(model.description)}` : ''}</small></button>`).join('');
  menu.querySelectorAll('[data-model]').forEach((button) => button.addEventListener('click', () => {
    $('#cfg-model').value = button.dataset.model;
    setModelMenuOpen(false);
    applyModelEfforts(context, catalog);
  }));
}
function renderModelCatalog(context, catalog) {
  if (!$('#cfg-model').value.trim()) {
    const defaultModel = (catalog?.models || []).find((model) => model.isDefault);
    if (defaultModel) $('#cfg-model').value = defaultModel.id;
  }
  renderModelMenu(context, catalog);
  applyModelEfforts(context, catalog, context.config.effort);
  const count = catalog?.models?.length || 0;
  const sourceLabels = {
    'codex-app-server': 'Codex CLI',
    'grok-models': 'Grok CLI',
    'agy-models': 'Antigravity CLI',
  };
  if (catalog?.warning) $('#cfg-model-status').textContent = '未能加载模型列表，可继续手工输入';
  else if (catalog?.authoritative && count) $('#cfg-model-status').textContent = `${modelDiscoveryGateway(context) ? '已从 API 网关' : `已从 ${sourceLabels[catalog.source] || 'Runner CLI'}`} 加载 ${count} 个模型`;
  else if (count) $('#cfg-model-status').textContent = 'CLI 未提供完整列表，当前显示其帮助中的模型示例';
  else $('#cfg-model-status').textContent = 'Runner 未提供模型列表，可继续手工输入';
}
function modelDiscoveryGateway(context) {
  return context.fields.has('gatewayUrl') ? $('#cfg-gateway').value.trim() : '';
}
function modelDiscoveryPayload(context) {
  const payload = { runner: context.runnerId, agent: context.agent.id, cwd: state.cwd || '' };
  if (context.fields.has('gatewayUrl')) payload.gatewayUrl = modelDiscoveryGateway(context);
  if (context.fields.has('apiKeyKind')) payload.apiKeyKind = $('#cfg-key-kind').value;
  if (context.fields.has('apiKey') && $('#cfg-api-key').value) payload.apiKey = $('#cfg-api-key').value;
  return payload;
}
async function loadModelCatalog(context) {
  if (!context.fields.has('model')) return;
  const key = modelCatalogKey(context);
  if (state.modelCatalogs.has(key)) return renderModelCatalog(context, state.modelCatalogs.get(key));
  const requestId = state.modelRequestId += 1;
  $('#cfg-model-status').textContent = '正在从 Runner CLI 加载模型…';
  try {
    const catalog = await post('/api/models', modelDiscoveryPayload(context));
    state.modelCatalogs.set(key, catalog);
    if (requestId === state.modelRequestId && modelCatalogKey(configContext()) === key) renderModelCatalog(context, catalog);
  } catch {
    const catalog = { models: [], source: 'unavailable', authoritative: false, warning: 'unavailable' };
    if (requestId === state.modelRequestId && modelCatalogKey(configContext()) === key) renderModelCatalog(context, catalog);
  }
}
function fillConfig() {
  const context = configContext();
  setConfigFieldVisibility(context);
  fillCapabilitySelect('#cfg-effort', capabilityOptions(context.capabilities, 'effort'), context.config.effort, context.capabilities.defaultEffort || 'high');
  fillCapabilitySelect('#cfg-permission', capabilityOptions(context.capabilities, 'permissionMode'), context.config.permissionMode, 'auto');
  fillCapabilitySelect('#cfg-output', capabilityOptions(context.capabilities, 'outputFormat'), context.config.outputFormat, context.capabilities.defaultOutputFormat || 'json');
  $('#cfg-model').value = context.config.model || context.capabilities.defaultModel || ''; $('#cfg-timeout').value = context.config.timeoutMs || 1800000; $('#cfg-budget').value = context.config.maxBudgetUsd ?? 0; $('#cfg-gateway').value = context.config.gatewayUrl || ''; $('#cfg-key-kind').value = context.config.apiKeyKind || context.capabilities.defaultApiKeyKind || 'auth_token'; $('#cfg-api-key').value = ''; $('#cfg-browser-profiles').value = context.config.browserMcpConfigsJson || '{}';
  $('#cfg-model-menu').innerHTML = ''; setModelMenuOpen(false);
  $('#cfg-model-status').textContent = '';
  syncCustomSelects();
  loadModelCatalog(context);
}
function renderInstall() {
  const codex = Boolean(state.install?.codexAvailable); const market = Boolean(state.install?.marketplaceAvailable); const installed = Boolean(state.install?.installed);
  $('#step-codex').textContent = codex ? '可用' : '未检测到'; $('#step-codex').className = codex ? 'done' : 'fail';
  $('#step-marketplace').textContent = market ? '已注册' : '待注册'; $('#step-marketplace').className = market ? 'done' : '';
  $('#step-plugin').textContent = installed ? '已安装并启用' : '待安装'; $('#step-plugin').className = installed ? 'done' : '';
  $('#install-run').textContent = installed ? '检查更新' : '开始安装'; $('#install-run').disabled = !codex;
  $('#install-output').textContent = installed ? `当前版本 ${state.install.installedVersion || '已安装'}，可检查 marketplace 更新。` : '尚未安装，可从此界面完成安装。';
}

const modalMotion = createModalMotionController({
  duration: motionDuration.overlay,
  reducedMotionFn: prefersReducedMotionNow,
});
let modalTrigger = null;
let gatewayModelTimer = null;
const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
function openModal(id) {
  modalTrigger = document.activeElement;
  const backdrop = $(`#${id}`); const modal = backdrop?.querySelector('.modal');
  if (!backdrop || !modal) return;
  backdrop.classList.remove('hidden');
  modalMotion.open(backdrop, modal);
  modal.querySelector(focusableSelector)?.focus();
}
function closeModal(id) {
  const backdrop = $(`#${id}`); const modal = backdrop?.querySelector('.modal');
  if (!backdrop || !modal || backdrop.classList.contains('hidden')) return;
  modalMotion.close(backdrop, modal, () => { backdrop.classList.add('hidden'); modalTrigger?.focus?.(); modalTrigger = null; });
}
function trapModalFocus(event) {
  if (event.key !== 'Tab') return;
  const modal = document.querySelector('.modal-backdrop:not(.hidden) .modal');
  if (!modal) return;
  const items = [...modal.querySelectorAll(focusableSelector)];
  if (!items.length) return;
  const first = items[0]; const last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function openSettings(tab = 'agent') {
  document.querySelectorAll('.settings-tab').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === tab));
  document.querySelectorAll('.settings-pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.settingsPane === tab));
  renderConfigOptions(); fillConfig(); renderInstall(); openModal('settings-modal');
}
function filteredEvents() {
  if (state.tab === 'events') return state.events.filter(hasEventDetail);
  return state.events.filter((event) => { const kind = eventClass(event); return state.tab === 'tools' ? Boolean(kind.tool) : state.tab === 'files' ? kind.file : kind.check; });
}
function renderSession(diff, source) {
  const agent = state.agents.find((item) => item.id === state.selectedAgent); const job = activeJob(); const status = sessionStatusFor(job?.status, state.streamState); const config = agent?.configuredByRunner?.[job?.runner] || agent?.configured || {};
  $('#session-role-icon').className = `session-role-icon ${roleClass(agent?.id || '')}`; $('#session-title').textContent = agent?.name || '智能体会话'; $('#session-task').textContent = job?.task || '该智能体暂无任务记录'; $('#session-meta').textContent = job ? `${job.sessionId || '无会话 ID'} · ${job.cwd || '当前仓库'}` : '点击星图节点查看会话详情';
  $('#session-state').dataset.status = status; $('#session-state').innerHTML = `<i></i><span>${esc(phaseLabel(job?.phase, status))}</span>`;
  const result = state.result || {}; const verification = job?.verificationState; const title = { completed: '任务已完成', failed: '任务执行失败', cancelled: '任务已取消', blocked: '任务已阻断', running: '任务正在执行', starting: '正在启动任务', queued: '任务正在排队' }[status] || '等待任务';
  const summary = String(result.summary || (job ? '该任务暂无保存结果摘要。' : '选择一条任务记录后查看执行结果。'));
  $('#overview-title').textContent = title; $('#overview-summary').textContent = summary.length > 320 ? `${summary.slice(0, 317)}...` : summary; $('#overview-verification').textContent = result.verificationSummary || '';
  $('#overview-status').textContent = phaseLabel(job?.phase, status); $('#overview-duration').textContent = durationText(elapsedFor(job)); $('#overview-check').textContent = verification === 'passed' ? '验证通过' : verification === 'failed' ? '验证失败' : job ? '尚未验证' : '等待执行'; $('#overview-cost').textContent = Number.isFinite(Number(job?.costUsd)) ? `$${Number(job.costUsd).toFixed(4)}` : '—';
  const effectiveTimeout = job?.effectiveTimeoutMs || config.timeoutMs;
  const timeoutDetail = job?.timeoutSource === 'configured-protected'
    ? `超时 ${durationText(effectiveTimeout)}（已忽略短覆盖 ${durationText(job.requestedTimeoutMs)}）`
    : `超时 ${durationText(effectiveTimeout)}${job?.timeoutSource === 'request-override' ? '（单次覆盖）' : '（角色配置）'}`;
  $('#session-runtime').textContent = `Runner ${job?.runner || config.runner || 'claude'} · 模型 ${config.model || '—'} · 思考强度 ${config.effort || '—'} · 权限 ${config.permissionMode || '—'} · ${timeoutDetail}`;
  const visible = filteredEvents(); $('#event-count').textContent = state.events.length; $('#tool-count').textContent = state.events.filter((event) => eventClass(event).tool).length; $('#file-count').textContent = state.events.filter((event) => eventClass(event).file).length; $('#check-count').textContent = state.events.filter((event) => eventClass(event).check).length;
  patchKeyedList($('#event-viewport'), visible, (event) => event.seq, (event) => { const [kind, icon, detail] = eventView(event); return `<div class="event-row"><span class="event-time">${esc(timeText(event.at))}</span><span class="event-dot">${esc(icon)}</span><span class="event-kind">${esc(kind)}</span><span class="event-main"><strong>${esc(event.subtype || kind)}</strong><small>${esc(detail)}</small></span><span class="event-result">${event.type === 'result' ? '完成' : ''}</span></div>`; }, '<div class="empty-events"><strong>此分类暂无记录</strong><small>历史快照可能没有完整事件流。</small></div>');
  if (motionAllowed(source)) (diff?.newEvents || []).forEach((event) => triggerMotion(motionElement(`#event-viewport [data-motion-key="${CSS.escape(String(event.seq))}"]`), 'motion-event-enter', motionDuration.enter));
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
  scheduleRender('interaction', { force: true });
  if (open) { renderSession(); openModal('session-modal'); }
}
async function selectAgent(agentId, open = true) {
  state.selectedAgent = agentId; const latest = jobsFor(agentId).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0]; await selectJob(latest?.jobId || null, open);
}
function closeStream() { if (state.stream) state.stream.close(); state.stream = null; state.streamState = 'idle'; }
function connectStream(jobId) {
  closeStream(); if (!jobId) return;
  state.streamState = 'connecting'; scheduleRender('interaction', { force: true }); state.stream = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream?token=${encodeURIComponent(token)}&after=${state.cursor}`);
  state.stream.onopen = () => { state.reconnect.onOpen(); state.streamState = 'open'; scheduleRender('sse', { force: true }); };
  state.stream.onmessage = (message) => {
    try {
      const data = JSON.parse(message.data); if (jobId !== state.selectedJob) return;
      const incomingEvents = Array.isArray(data.events) ? data.events : [];
      const known = new Set(state.events.map((event) => event.seq));
      const newEvents = incomingEvents.filter((event) => !known.has(event.seq));
      const currentJob = state.jobs.find((item) => item.jobId === jobId);
      const nextJob = mergeStreamJobMeta(currentJob, data.meta);
      const metadataChanged = !meaningfulJobMetaEqual(currentJob, nextJob);
      const renderSource = state.reconnect.peekSource('sse');
      if (!newEvents.length && !metadataChanged) return;
      state.reconnect.commitSource('sse');
      state.events.push(...newEvents); state.cursor = data.cursor; state.jobs = state.jobs.map((item) => item.jobId === jobId ? nextJob : item); state.lastUpdate = new Date().toISOString();
      scheduleRender(renderSource.source, renderSource.baseline ? { baseline: true } : undefined);
      if (!['running', 'starting', 'queued'].includes(nextJob?.status)) closeStream();
    } catch (error) { showToast(error.message, 'error'); }
  };
  state.stream.onerror = () => { state.reconnect.onError(); if (state.streamState !== 'snapshot') state.streamState = 'error'; scheduleRender('sse', { force: true }); };
}
async function refreshBootstrap(source = 'poll') {
  const data = await api('/api/bootstrap'); state.agents = data.agents || []; state.runners = data.runners || []; state.jobs = Array.isArray(data.jobs) ? data.jobs : []; state.cwd = data.cwd || ''; state.install = data.installation || null;
  if (!state.selectedAgent || !state.agents.some((agent) => agent.id === state.selectedAgent)) state.selectedAgent = state.agents[0]?.id || null;
  if (state.selectedJob && !state.jobs.some((job) => job.jobId === state.selectedJob)) state.selectedJob = null;
  renderConfigOptions(); renderInstall(); scheduleRender(source);
  if (!state.selectedJob) { const active = state.jobs.find((job) => ['running', 'starting'].includes(job.status)); if (active) { state.selectedAgent = active.agent; state.selectedJob = active.jobId; connectStream(active.jobId); } }
}
async function install() {
  $('#install-run').disabled = true; $('#install-output').textContent = '正在调用 Codex CLI…';
  try { const result = await post('/api/install', {}); state.install = result.installation || state.install; renderInstall(); $('#install-output').textContent = [result.marketplace?.stdout, result.marketplace?.stderr, result.plugin?.stdout, result.plugin?.stderr].filter(Boolean).join('\n') || '插件安装或更新检查完成。'; showToast('插件状态已更新，重启 Codex 后新任务即可加载。', 'success'); await refreshBootstrap('interaction'); } catch (error) { $('#install-output').textContent = error.message; showToast(error.message, 'error'); } finally { $('#install-run').disabled = !state.install?.codexAvailable; }
}
async function saveConfig() {
  const context = configContext();
  const readers = {
    model: () => $('#cfg-model').value.trim(),
    effort: () => $('#cfg-effort').value,
    permissionMode: () => $('#cfg-permission').value,
    outputFormat: () => $('#cfg-output').value,
    timeoutMs: () => $('#cfg-timeout').value,
    maxBudgetUsd: () => $('#cfg-budget').value,
    gatewayUrl: () => $('#cfg-gateway').value.trim(),
    apiKeyKind: () => $('#cfg-key-kind').value,
    apiKey: () => $('#cfg-api-key').value,
    browserMcpConfigsJson: () => $('#cfg-browser-profiles').value.trim() || '{}',
  };
  const values = Object.fromEntries([...context.fields].map((field) => [field, readers[field]?.()]).filter(([, value]) => value !== undefined && value !== ''));
  try { rememberConfigSelection(); await post('/api/config', { agent: $('#config-agent').value, runner: $('#config-runner').value || 'default', values }); showToast('配置已保存到 SQLite，并将用于后续任务。', 'success'); await refreshBootstrap('interaction'); } catch (error) { showToast(error.message, 'error'); }
}

$('#settings-open').addEventListener('click', () => openSettings('agent'));
$('#config-agent').addEventListener('change', () => { rememberConfigSelection(); fillConfig(); });
$('#config-runner').addEventListener('change', () => { rememberConfigSelection(); fillConfig(); });
$('#cfg-gateway').addEventListener('input', () => {
  clearTimeout(gatewayModelTimer);
  gatewayModelTimer = setTimeout(() => { state.modelRequestId += 1; loadModelCatalog(configContext()); }, 300);
});
$('#cfg-key-kind').addEventListener('change', () => { state.modelRequestId += 1; loadModelCatalog(configContext()); });
$('#cfg-api-key').addEventListener('input', () => {
  clearTimeout(gatewayModelTimer);
  gatewayModelTimer = setTimeout(() => { state.modelRequestId += 1; loadModelCatalog(configContext()); }, 300);
});
$('#cfg-model-toggle').addEventListener('click', () => {
  const context = configContext(); const catalog = state.modelCatalogs.get(modelCatalogKey(context));
  renderModelMenu(context, catalog);
  setModelMenuOpen($('#cfg-model-menu').classList.contains('hidden'));
});
$('#cfg-model').addEventListener('input', () => {
  const context = configContext(); const catalog = state.modelCatalogs.get(modelCatalogKey(context));
  renderModelMenu(context, catalog, $('#cfg-model').value); setModelMenuOpen(true); applyModelEfforts(context, catalog);
});
$('#cfg-model').addEventListener('change', () => {
  const context = configContext(); applyModelEfforts(context, state.modelCatalogs.get(modelCatalogKey(context)));
});
$('#config-save').addEventListener('click', saveConfig);
$('#install-run').addEventListener('click', install);
$('#recent-refresh').addEventListener('click', () => refreshBootstrap('interaction').catch((error) => showToast(error.message, 'error')));
$('#pulse-more').addEventListener('click', () => state.selectedJob ? (renderSession(), openModal('session-modal')) : showToast('当前没有可查看的会话记录。'));
$('#refresh-events').addEventListener('click', () => selectJob(state.selectedJob, true).catch((error) => showToast(error.message, 'error')));
document.querySelectorAll('.settings-tab').forEach((button) => button.addEventListener('click', () => openSettings(button.dataset.settingsTab)));
document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => { state.tab = button.dataset.tab; document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === button)); renderSession(); }));
$('#agent-nodes').addEventListener('click', (event) => { const node = event.target.closest('[data-agent]'); if (node) selectAgent(node.dataset.agent, true).catch((error) => showToast(error.message, 'error')); });
$('#recent-list').addEventListener('click', (event) => { const row = event.target.closest('[data-job]'); if (!row) return; selectJob(row.dataset.job, true).catch((error) => showToast(error.message, 'error')); });
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
document.addEventListener('keydown', (event) => {
  trapModalFocus(event);
});
document.addEventListener('visibilitychange', () => {
  document.documentElement.classList.toggle('document-hidden', document.hidden);
  if (!document.hidden) motionScheduler.restoreVisible();
});
window.addEventListener('resize', scheduleResize);
setInterval(() => { $('#clock').textContent = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'); }, 1000);
setInterval(() => refreshBootstrap('poll').catch(() => { state.streamState = 'error'; scheduleRender('poll', { force: true }); }), 5000);
$('#clock').textContent = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
enhanceSelects();
refreshBootstrap('bootstrap').catch((error) => showToast(error.message, 'error'));
