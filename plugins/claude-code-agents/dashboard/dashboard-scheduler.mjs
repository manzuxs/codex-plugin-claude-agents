const SOURCE_PRIORITY = Object.freeze({ bootstrap: 1, recovery: 2, poll: 3, sse: 4, interaction: 5 });

export function isDocumentHidden(documentLike = globalThis.document) {
  return Boolean(documentLike?.hidden);
}

const defaultRequestAnimationFrame = typeof globalThis.requestAnimationFrame === 'function'
  ? globalThis.requestAnimationFrame.bind(globalThis)
  : (callback) => setTimeout(() => callback(Date.now()), 16);
const defaultCancelAnimationFrame = typeof globalThis.cancelAnimationFrame === 'function'
  ? globalThis.cancelAnimationFrame.bind(globalThis)
  : (id) => clearTimeout(id);

export function createDashboardScheduler({
  requestAnimationFrame = defaultRequestAnimationFrame,
  cancelAnimationFrame = defaultCancelAnimationFrame,
  isHidden = () => isDocumentHidden(),
  isMeaningfulChange = (previous, current) => !Object.is(previous, current),
  render = () => {},
} = {}) {
  let frameId = null;
  let pending = null;
  let latest = undefined;
  let hasLatest = false;

  const sourceRank = (source) => SOURCE_PRIORITY[source] || 0;
  const merge = (data, source, options = {}) => {
    if (!pending || sourceRank(source) >= sourceRank(pending.source)) {
      pending = { data, source, options };
      return;
    }
    pending = { ...pending, data, options: { ...pending.options, ...options } };
  };
  const flush = () => {
    frameId = null;
    if (!pending) return;
    if (isHidden() && pending.source !== 'interaction') return;
    const current = pending;
    pending = null;
    latest = current.data;
    hasLatest = true;
    render(current.data, current.source, current.options);
  };
  const ensureFrame = () => {
    if (frameId !== null) return;
    frameId = requestAnimationFrame(flush);
  };

  return {
    schedule(data, source = 'poll', options = {}) {
      const force = Boolean(options.force);
      if (!force && hasLatest && !isMeaningfulChange(latest, data)) return false;
      if (!force && pending && !isMeaningfulChange(pending.data, data)) return false;
      merge(data, source, options);
      ensureFrame();
      return true;
    },
    restoreVisible() {
      if (isHidden() || !pending) return false;
      pending = { ...pending, source: 'recovery', options: { ...pending.options, baseline: true } };
      ensureFrame();
      return true;
    },
    cancel() {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      pending = null;
    },
    get pending() { return pending; },
    get framePending() { return frameId !== null; },
  };
}

export { SOURCE_PRIORITY };
