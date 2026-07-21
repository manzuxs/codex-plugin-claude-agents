const EMPTY_DIFF = {
  initialized: false,
  kpiChanges: [],
  agentTransitions: [],
  newEvents: [],
  alertChanges: [],
  linkTransitions: [],
};

const MAX_MOTION_DELAY = 10_000;
const activeMotions = new WeakMap();

export function prefersReducedMotion(matchMediaFn = globalThis.matchMedia?.bind(globalThis)) {
  return typeof matchMediaFn === 'function' && Boolean(matchMediaFn('(prefers-reduced-motion: reduce)')?.matches);
}

export function triggerMotion(element, className, duration = 0, {
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
  onCleanup = null,
  prefersReducedMotionFn = prefersReducedMotion,
} = {}) {
  if (!element?.classList || !className || typeof element.addEventListener !== 'function') return () => {};
  const reduced = prefersReducedMotionFn?.() === true;
  const active = activeMotions.get(element);
  active?.get(className)?.();
  if (reduced) {
    element.classList.remove(className);
    onCleanup?.();
    return () => {};
  }
  const delay = Math.min(MAX_MOTION_DELAY, Math.max(0, Number(duration) || 0));
  const classes = active || new Map();
  activeMotions.set(element, classes);
  let finished = false;
  let timer = null;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (timer !== null && typeof clearTimeoutFn === 'function') clearTimeoutFn(timer);
    element.removeEventListener('animationend', onAnimationEnd);
    element.classList.remove(className);
    if (classes.get(className) === cleanup) classes.delete(className);
    if (!classes.size) activeMotions.delete(element);
    onCleanup?.();
  };
  const onAnimationEnd = (event) => {
    if (!event || event.target === element) cleanup();
  };
  element.classList.remove(className);
  void element.offsetWidth;
  element.addEventListener('animationend', onAnimationEnd);
  element.classList.add(className);
  classes.set(className, cleanup);
  if (typeof setTimeoutFn === 'function') timer = setTimeoutFn(cleanup, delay);
  return cleanup;
}

export function removeAfterMotion(element, className, duration = 0, options = {}) {
  return triggerMotion(element, className, duration, { ...options, onCleanup: () => element?.remove?.() });
}

export function topologyLinkGeometry(core, target, bounds = {}) {
  const left = Number(bounds.left) || 0;
  const top = Number(bounds.top) || 0;
  const sourceX = (Number(core?.x) || 0) - left;
  const sourceY = (Number(core?.y) || 0) - top;
  const targetX = (Number(target?.x) || 0) - left;
  const targetY = (Number(target?.y) || 0) - top;
  const deltaX = targetX - sourceX;
  const deltaY = targetY - sourceY;
  const distance = Math.max(1, Math.hypot(deltaX, deltaY));
  return {
    left: sourceX,
    top: sourceY,
    width: distance,
    height: 1,
    distance,
    transform: `rotate(${Math.atan2(deltaY, deltaX) * 180 / Math.PI}deg)`,
  };
}

export function applyTopologyLinkGeometry(element, geometry) {
  if (!element?.style || !geometry) return;
  const set = (property, value) => element.style.setProperty(property, String(value));
  set('left', `${geometry.left}px`);
  set('top', `${geometry.top}px`);
  set('width', `${Math.max(1, geometry.width)}px`);
  set('height', `${Math.max(1, geometry.height)}px`);
  set('--motion-link-distance', `${Math.max(1, geometry.distance)}px`);
  set('transform', geometry.transform);
}

export function statusClassFor(status) {
  if (['running', 'starting'].includes(status)) return 'running';
  if (status === 'queued') return 'queued';
  if (['failed', 'blocked', 'cancelled'].includes(status)) return status;
  if (status === 'completed') return 'completed';
  return '';
}

export function shouldAnimateLinkTransition(transition, { source = 'poll', selectedJobId = null, hasNewEvent = false } = {}) {
  if (!transition || ['bootstrap', 'recovery'].includes(source)) return false;
  const from = transition.from?.status ?? null;
  const to = transition.to?.status ?? null;
  if (from === to && transition.from?.phase === transition.to?.phase) return false;
  if (['starting', 'running'].includes(to) && !['starting', 'running'].includes(from)) return true;
  if (TERMINAL_STATUSES.has(to) && !TERMINAL_STATUSES.has(from)) return true;
  const selected = transition.jobId !== undefined && selectedJobId !== null && String(selectedJobId) === String(transition.jobId);
  return source === 'sse' && selected && hasNewEvent && transition.from?.phase !== transition.to?.phase;
}

export function createModalMotionController({
  duration = 180,
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
  reducedMotionFn = prefersReducedMotion,
} = {}) {
  const states = new WeakMap();
  const stateFor = (backdrop) => {
    let state = states.get(backdrop);
    if (!state) {
      state = { timer: null, generation: 0 };
      states.set(backdrop, state);
    }
    return state;
  };
  const cancelExit = (backdrop, modal) => {
    const state = stateFor(backdrop);
    state.generation += 1;
    if (state.timer !== null && typeof clearTimeoutFn === 'function') clearTimeoutFn(state.timer);
    state.timer = null;
    backdrop?.classList.remove('motion-modal-exit');
    modal?.classList.remove('motion-modal-exit');
  };
  return {
    open(backdrop, modal) {
      if (!backdrop || !modal) return;
      const state = stateFor(backdrop);
      cancelExit(backdrop, modal);
      backdrop.classList.remove('hidden');
      backdrop.classList.remove('motion-modal-exit');
      modal.classList.remove('motion-modal-exit');
      backdrop.classList.remove('motion-modal-enter');
      modal.classList.remove('motion-modal-enter');
      if (reducedMotionFn?.() === true) return;
      backdrop.classList.add('motion-modal-enter');
      modal.classList.add('motion-modal-enter');
      state.generation += 1;
    },
    close(backdrop, modal, finish = () => {}) {
      if (!backdrop || !modal) return;
      const state = stateFor(backdrop);
      cancelExit(backdrop, modal);
      backdrop.classList.remove('motion-modal-enter');
      modal.classList.remove('motion-modal-enter');
      if (reducedMotionFn?.() === true) {
        finish();
        return;
      }
      const generation = ++state.generation;
      backdrop.classList.add('motion-modal-exit');
      modal.classList.add('motion-modal-exit');
      state.timer = typeof setTimeoutFn === 'function' ? setTimeoutFn(() => {
        if (state.generation !== generation) return;
        state.timer = null;
        backdrop.classList.remove('motion-modal-exit');
        modal.classList.remove('motion-modal-exit');
        finish();
      }, duration) : null;
    },
    cancel(backdrop, modal) { cancelExit(backdrop, modal); },
  };
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const LINK_STATUSES = new Set(['starting', 'running', ...TERMINAL_STATUSES]);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function jobIdOf(job) {
  return firstValue(job?.jobId, job?.id, job?.job_id) ?? null;
}

function agentIdOf(agent) {
  return firstValue(agent?.id, agent?.agent, agent?.agentId) ?? null;
}

function eventSeqOf(event) {
  return firstValue(event?.seq, event?.sequence, event?.eventSeq, event?.id) ?? null;
}

function alertIdOf(alert) {
  return firstValue(alert?.id, alert?.alertId, alert?.key, alert?.jobId, alert?.job_id) ?? null;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedJobs(data) {
  return (Array.isArray(data?.jobs) ? data.jobs : []).map((job) => ({
    ...clone(job),
    jobId: jobIdOf(job),
    agentId: firstValue(job?.agent, job?.agentId, job?.agent_id) ?? null,
    status: job?.status ?? null,
    phase: job?.phase ?? null,
  })).filter((job) => job.jobId !== null);
}

function currentJobForAgent(jobs, agentId) {
  const matching = jobs.filter((job) => job.agentId === agentId);
  return matching.find((job) => ['running', 'starting', 'queued'].includes(job.status)) || matching[0] || null;
}

function normalizedAgents(data, jobs) {
  const records = new Map();
  (Array.isArray(data?.agents) ? data.agents : []).forEach((agent) => {
    const id = agentIdOf(agent);
    if (id === null) return;
    const job = currentJobForAgent(jobs, id);
    records.set(id, {
      id,
      status: job?.status ?? firstValue(agent.state, agent.status) ?? 'idle',
      phase: job?.phase ?? agent.phase ?? null,
      jobId: job?.jobId ?? firstValue(agent.jobId, agent.job_id) ?? null,
    });
  });
  jobs.forEach((job) => {
    if (job.agentId === null || records.has(job.agentId)) return;
    records.set(job.agentId, { id: job.agentId, status: job.status, phase: job.phase, jobId: job.jobId });
  });
  return [...records.values()];
}

function normalizedKpis(data, jobs, agents) {
  if (data?.kpis && typeof data.kpis === 'object' && !Array.isArray(data.kpis)) return clone(data.kpis);
  const terminal = jobs.filter((job) => TERMINAL_STATUSES.has(job.status));
  const completed = jobs.filter((job) => job.status === 'completed');
  const durations = terminal.map((job) => Number(job.durationMs)).filter(Number.isFinite);
  const costs = jobs.map((job) => Number(job.costUsd)).filter(Number.isFinite);
  return {
    agents: agents.length,
    running: jobs.filter((job) => ['running', 'starting'].includes(job.status)).length,
    queued: jobs.filter((job) => job.status === 'queued').length,
    completed: completed.length,
    success: terminal.length ? `${Math.round(completed.length / terminal.length * 100)}%` : '—',
    tokens: jobs.reduce((sum, job) => sum + (Number(job.inputTokens) || 0) + (Number(job.outputTokens) || 0), 0),
    duration: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    cost: costs.length ? costs.reduce((sum, value) => sum + value, 0).toFixed(2) : null,
  };
}

function normalizedEvents(data) {
  return (Array.isArray(data?.events) ? data.events : []).map((event) => ({
    ...clone(event),
    seq: eventSeqOf(event),
  })).filter((event) => event.seq !== null);
}

function normalizedAlerts(data) {
  return (Array.isArray(data?.alerts) ? data.alerts : []).map((alert) => ({
    ...clone(alert),
    id: alertIdOf(alert) ?? `alert:${stableSerialize(alert)}`,
  }));
}

function recordMap(records, key) {
  return new Map(records.map((record) => [record[key], record]));
}

function sameValue(left, right) {
  return Object.is(left, right) || (Number.isNaN(left) && Number.isNaN(right));
}

function stateDiff(record) {
  return {
    status: record?.status ?? null,
    phase: record?.phase ?? null,
    jobId: record?.jobId ?? null,
  };
}

function changedState(previous, current) {
  return previous?.status !== current?.status || previous?.phase !== current?.phase || previous?.jobId !== current?.jobId;
}

function isLinkTransition(previous, current) {
  if (!current || !changedState(previous, current)) return false;
  return LINK_STATUSES.has(current.status) || LINK_STATUSES.has(previous?.status);
}

export function createMotionSnapshot(data = null) {
  if (!data) return freeze({ initialized: false, kpis: {}, agents: [], jobs: [], events: [], alerts: [] });
  const jobs = normalizedJobs(data);
  const agents = normalizedAgents(data, jobs);
  return freeze({
    initialized: true,
    kpis: normalizedKpis(data, jobs, agents),
    agents,
    jobs,
    events: normalizedEvents(data),
    alerts: normalizedAlerts(data),
  });
}

export function mergeStreamJobMeta(current, incoming) {
  if (!current || typeof current !== 'object' || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return current;
  if (typeof current.jobId !== 'string' || typeof incoming.jobId !== 'string' || incoming.jobId !== current.jobId) return current;
  if (incoming.status !== undefined && typeof incoming.status !== 'string') return current;
  const supplied = Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined));
  if (Object.keys(supplied).length <= 1) return current;
  return { ...current, ...supplied };
}

const MEANINGFUL_JOB_META_FIELDS = [
  'jobId', 'agent', 'status', 'phase', 'progressRevision', 'task', 'sessionId', 'cwd',
  'createdAt', 'startedAt', 'finishedAt', 'durationMs', 'inputTokens', 'outputTokens',
  'costUsd', 'verificationState', 'resultAvailable', 'error',
];

export function meaningfulJobMetaEqual(previous, current) {
  return stableSerialize(Object.fromEntries(MEANINGFUL_JOB_META_FIELDS.map((field) => [field, current?.[field] ?? null])))
    === stableSerialize(Object.fromEntries(MEANINGFUL_JOB_META_FIELDS.map((field) => [field, previous?.[field] ?? null])));
}

export function sessionStatusFor(jobStatus, streamState) {
  return streamState === 'error' ? 'disconnected' : jobStatus || 'idle';
}

export function createReconnectState() {
  let recovering = false;
  const sourceFor = (source = 'sse') => recovering && source === 'sse'
    ? { source: 'recovery', baseline: true }
    : { source, baseline: false };
  return {
    onError() { recovering = true; },
    onOpen() {},
    peekSource(source = 'sse') {
      return sourceFor(source);
    },
    commitSource(source = 'sse') {
      if (source === 'sse' && recovering) recovering = false;
    },
    nextSource(source = 'sse') {
      const result = sourceFor(source);
      if (result.baseline) this.commitSource(source);
      return result;
    },
  };
}

function meaningfulRecords(records, fields) {
  return (Array.isArray(records) ? records : []).map((record) => Object.fromEntries(fields.map((field) => [field, record?.[field] ?? null])));
}

export function dashboardMeaningfulChange(previous, current) {
  if (!previous) return true;
  return stableSerialize({
    kpis: current?.kpis || {},
    agents: meaningfulRecords(current?.agents, ['id', 'state', 'status', 'phase', 'jobId', 'job_id']),
    jobs: meaningfulRecords(current?.jobs, ['jobId', 'id', 'agent', 'status', 'phase', 'task', 'sessionId', 'cwd', 'createdAt', 'startedAt', 'finishedAt', 'durationMs', 'inputTokens', 'outputTokens', 'costUsd', 'verificationState', 'resultAvailable', 'error']),
    events: meaningfulRecords(current?.events, ['seq', 'sequence', 'eventSeq', 'id', 'type', 'subtype', 'result']),
    alerts: meaningfulRecords(current?.alerts, ['id', 'alertId', 'key', 'jobId', 'text', 'critical']),
  }) !== stableSerialize({
    kpis: previous?.kpis || {},
    agents: meaningfulRecords(previous?.agents, ['id', 'state', 'status', 'phase', 'jobId', 'job_id']),
    jobs: meaningfulRecords(previous?.jobs, ['jobId', 'id', 'agent', 'status', 'phase', 'task', 'sessionId', 'cwd', 'createdAt', 'startedAt', 'finishedAt', 'durationMs', 'inputTokens', 'outputTokens', 'costUsd', 'verificationState', 'resultAvailable', 'error']),
    events: meaningfulRecords(previous?.events, ['seq', 'sequence', 'eventSeq', 'id', 'type', 'subtype', 'result']),
    alerts: meaningfulRecords(previous?.alerts, ['id', 'alertId', 'key', 'jobId', 'text', 'critical']),
  });
}

export function agentNodeRecords(agents = [], jobs = []) {
  return (Array.isArray(agents) ? agents : []).map((agent) => {
    const agentId = agentIdOf(agent);
    const current = (Array.isArray(jobs) ? jobs : []).filter((job) => firstValue(job?.agent, job?.agentId, job?.agent_id) === agentId)
      .find((job) => ['running', 'starting', 'queued'].includes(job?.status))
      || (Array.isArray(jobs) ? jobs : []).find((job) => firstValue(job?.agent, job?.agentId, job?.agent_id) === agentId);
    return {
      agent,
      status: current?.status || firstValue(agent?.state, agent?.status) || 'idle',
      phase: current?.phase ?? agent?.phase ?? null,
      task: current?.task ?? null,
      jobId: jobIdOf(current),
    };
  });
}

export function agentNodeFingerprint(record) {
  return stableSerialize({ id: agentIdOf(record?.agent), status: record?.status ?? null, phase: record?.phase ?? null, task: record?.task ?? null, jobId: record?.jobId ?? null });
}

function localDayBucket(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function chartStatusCounts(jobs) {
  return {
    completed: jobs.filter((job) => job?.status === 'completed').length,
    running: jobs.filter((job) => ['running', 'starting'].includes(job?.status)).length,
    queued: jobs.filter((job) => job?.status === 'queued').length,
    failed: jobs.filter((job) => ['failed', 'blocked', 'cancelled'].includes(job?.status)).length,
  };
}

function chartDayInputs(jobs) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const day = localDayBucket(date);
    const counts = { total: 0, completed: 0, running: 0, queued: 0, failed: 0, terminal: 0 };
    jobs.forEach((job) => {
      if (localDayBucket(job?.createdAt) !== day) return;
      counts.total += 1;
      const status = job?.status;
      if (status === 'completed') counts.completed += 1;
      else if (['running', 'starting'].includes(status)) counts.running += 1;
      else if (status === 'queued') counts.queued += 1;
      else if (['failed', 'blocked', 'cancelled'].includes(status)) counts.failed += 1;
      if (['completed', 'failed', 'blocked', 'cancelled'].includes(status)) counts.terminal += 1;
    });
    days.push({ day, ...counts });
  }
  return days;
}

export function chartFingerprint(jobs = [], dimensions = {}) {
  const chartJobs = Array.isArray(jobs) ? jobs : [];
  return stableSerialize({
    donut: chartStatusCounts(chartJobs),
    days: chartDayInputs(chartJobs),
    dimensions,
  });
}

const RESOURCE_DEFINITIONS = [
  ['concurrency', '并发任务', '#4cd38a'],
  ['events', '事件记录', '#34b9ee'],
  ['verification', '验证覆盖', '#e9aa42'],
  ['tokens', 'Token 记录', '#9277e8'],
];

function resourceSparkValues(data, index, base) {
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const agentId = agents[index % Math.max(1, agents.length)]?.id;
  const source = jobs.filter((job) => job?.agent === agentId).length;
  return Array.from({ length: 18 }, (_, point) => Math.max(0, base + ((source + index + point * 3) % 9) - 4));
}

export function resourceRows(data = {}) {
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const events = Array.isArray(data?.events) ? data.events : [];
  const running = jobs.filter((job) => ['running', 'starting'].includes(job?.status)).length;
  const terminal = jobs.filter((job) => ['completed', 'failed', 'blocked', 'cancelled'].includes(job?.status));
  const verified = terminal.filter((job) => job?.verificationState).length;
  const tokenJobs = jobs.filter((job) => Number(job?.inputTokens) || Number(job?.outputTokens)).length;
  const values = [
    [`${running}/${agents.length || 0}`, running],
    [`${events.length}`, events.length],
    [terminal.length ? `${Math.round(verified / terminal.length * 100)}%` : '—', terminal.length ? verified : 0],
    [tokenJobs ? '已记录' : '等待记录', tokenJobs],
  ];
  return RESOURCE_DEFINITIONS.map(([key, label, color], index) => {
    const [value, base] = values[index];
    return { key, label, value, base, color, sparkValues: resourceSparkValues(data, index, Number(base) || 1) };
  });
}

function resourceInput(row) {
  return { key: row.key, value: row.value, base: row.base, color: row.color, sparkValues: row.sparkValues };
}

function resourceDimensions(dimensions = {}) {
  return Object.fromEntries(Object.keys(dimensions).sort().map((key) => [key, dimensions[key]]));
}

export function resourceFingerprint(data = {}, dimensions = {}) {
  return stableSerialize({ rows: resourceRows(data).map(resourceInput), dimensions: resourceDimensions(dimensions) });
}

export function resourceDirtyKeys(previous = {}, current = {}, previousDimensions = {}, currentDimensions = {}) {
  const before = new Map(resourceRows(previous).map((row) => [row.key, resourceInput(row)]));
  const after = new Map(resourceRows(current).map((row) => [row.key, resourceInput(row)]));
  const keys = new Set([...before.keys(), ...after.keys(), ...Object.keys(previousDimensions), ...Object.keys(currentDimensions)]);
  return new Set([...keys].filter((key) => stableSerialize(before.get(key)) !== stableSerialize(after.get(key))
    || stableSerialize(previousDimensions[key]) !== stableSerialize(currentDimensions[key])));
}

export function patchResourceRows(container, rows, dirtyKeys, { createRow, updateRow, drawRow = () => {} } = {}) {
  if (!container || !Array.isArray(rows) || typeof createRow !== 'function' || typeof updateRow !== 'function') return;
  const existing = new Map([...container.children].map((child) => [child.dataset.resourceKey, child]));
  const used = new Set();
  rows.forEach((row) => {
    const key = String(row.key);
    const element = existing.get(key) || createRow(row);
    updateRow(element, row);
    if (dirtyKeys?.has(key)) drawRow(element.querySelector('.resource-spark'), row);
    used.add(key);
    container.append(element);
  });
  [...container.children].forEach((child) => {
    if (!used.has(child.dataset.resourceKey)) child.remove();
  });
}
export function diffDashboardMotion(previous, current, source = 'poll') {
  const before = previous || createMotionSnapshot();
  const after = current || createMotionSnapshot();
  if (!before.initialized) return clone(EMPTY_DIFF);

  const kpiChanges = [];
  const kpiKeys = new Set([...Object.keys(before.kpis), ...Object.keys(after.kpis)]);
  kpiKeys.forEach((key) => {
    if (!sameValue(before.kpis[key], after.kpis[key])) kpiChanges.push({ key, previous: before.kpis[key], current: after.kpis[key] });
  });

  const previousAgents = recordMap(before.agents, 'id');
  const agentTransitions = after.agents.filter((agent) => changedState(previousAgents.get(agent.id), agent)).map((agent) => ({
    id: agent.id,
    from: stateDiff(previousAgents.get(agent.id)),
    to: stateDiff(agent),
  }));

  const previousJobs = recordMap(before.jobs, 'jobId');
  const linkTransitions = after.jobs.filter((job) => isLinkTransition(previousJobs.get(job.jobId), job)).map((job) => ({
    jobId: job.jobId,
    agentId: job.agentId,
    from: { status: previousJobs.get(job.jobId)?.status ?? null, phase: previousJobs.get(job.jobId)?.phase ?? null },
    to: { status: job.status, phase: job.phase },
  }));

  const previousEvents = new Set(before.events.map((event) => event.seq));
  const newEvents = source === 'sse' ? after.events.filter((event) => !previousEvents.has(event.seq)) : [];

  const previousAlerts = new Set(before.alerts.map((alert) => alert.id));
  const alertChanges = after.alerts.filter((alert) => !previousAlerts.has(alert.id)).map((alert) => ({ id: alert.id, alert: clone(alert) }));

  return {
    initialized: true,
    kpiChanges,
    agentTransitions,
    newEvents,
    alertChanges,
    linkTransitions,
  };
}
