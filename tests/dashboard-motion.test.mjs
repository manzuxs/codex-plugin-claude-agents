import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMotionSnapshot,
  diffDashboardMotion,
  mergeStreamJobMeta,
  meaningfulJobMetaEqual,
  sessionStatusFor,
  chartFingerprint,
  resourceRows,
  resourceFingerprint,
  resourceDirtyKeys,
  patchResourceRows,
  dashboardMeaningfulChange,
  createReconnectState,
  agentNodeRecords,
  agentNodeFingerprint,
  triggerMotion,
  removeAfterMotion,
  topologyLinkGeometry,
  applyTopologyLinkGeometry,
  shouldAnimateLinkTransition,
  prefersReducedMotion,
  statusClassFor,
  createModalMotionController,
} from '../plugins/claude-code-agents/dashboard/dashboard-motion.mjs';

import { createDashboardScheduler, isDocumentHidden } from '../plugins/claude-code-agents/dashboard/dashboard-scheduler.mjs';

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));
const styles = fs.readFileSync(path.join(dashboardDir, '../plugins/claude-code-agents/dashboard/styles.css'), 'utf8');

const normalizeSelector = (selector) => selector.replace(/\s+/g, ' ').trim();
// Narrow CSS contract parsing: preserve commas inside selector functions, attributes, and strings.
// This is intentionally not a standards-complete CSS parser.
const splitSelectors = (header) => {
  const selectors = [];
  let start = 0;
  let quote = '';
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === ',' && parentheses === 0 && brackets === 0) {
      selectors.push(normalizeSelector(header.slice(start, index)));
      start = index + 1;
    }
  }
  selectors.push(normalizeSelector(header.slice(start)));
  return selectors;
};
const parseCssBlocks = (source) => {
  const sanitized = [];
  let quote = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    if (quote) {
      sanitized.push(character);
      if (character === '\\') {
        if (index + 1 >= source.length) throw new Error('unterminated string');
        sanitized.push(nextCharacter);
        index += 2;
        continue;
      }
      if (character === quote) quote = '';
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      const commentStart = index;
      const commentEnd = source.indexOf('*/', index + 2);
      if (commentEnd < 0) throw new Error(`unterminated comment at ${commentStart}`);
      sanitized.push(...' '.repeat(commentEnd + 2 - commentStart));
      index = commentEnd + 2;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    sanitized.push(character);
    index += 1;
  }
  if (quote) throw new Error('unterminated string');

  const blocks = [];
  const stack = [{ headerStart: 0, openingBrace: -1, block: null, atRule: '' }];
  quote = '';
  for (index = 0; index < sanitized.length; index += 1) {
    const character = sanitized[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') {
      const parent = stack.at(-1);
      const header = sanitized.slice(parent.headerStart, index).join('').trim();
      const atRule = parent.block?.header.startsWith('@')
        ? [parent.atRule, parent.block.header].filter(Boolean).join(' > ')
        : parent.atRule;
      const block = {
        header,
        body: '',
        atRule,
      };
      if (block.header) blocks.push(block);
      stack.push({ headerStart: index + 1, openingBrace: index, block, atRule });
    } else if (character === '}') {
      if (stack.length === 1) throw new Error(`unbalanced braces at ${index}`);
      const frame = stack.pop();
      frame.block.body = sanitized.slice(frame.openingBrace + 1, index).join('');
      stack.at(-1).headerStart = index + 1;
    }
  }
  if (stack.length > 1) throw new Error('unbalanced braces');
  if (sanitized.slice(stack[0].headerStart).join('').trim()) throw new Error('unmatched trailing CSS');
  return blocks;
};
const cssBlocks = (source) => parseCssBlocks(source);
const ruleBlock = (source, selector) => {
  const normalizedSelector = normalizeSelector(selector);
  return cssBlocks(source)
    .filter(({ header }) => !header.startsWith('@') && splitSelectors(header).includes(normalizedSelector))
    .map(({ body }) => body)
    .join(';');
};
const ruleBlockIn = (source, selector, atRule) => {
  const normalizedSelector = normalizeSelector(selector);
  return cssBlocks(source)
    .filter(({ header, atRule: context }) => context === atRule && splitSelectors(header).includes(normalizedSelector))
    .map(({ body }) => body)
    .join(';');
};
const atRuleBody = (source, atRule) => cssBlocks(source).find(({ header }) => header === atRule)?.body ?? '';
const declaration = (block, property) => {
  const declarations = [];
  let cursor = 0;
  let quote = '';
  let parentheses = 0;
  const entries = [];
  for (let index = 0; index < block.length; index += 1) {
    const character = block[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      parentheses += 1;
    } else if (character === ')') {
      parentheses -= 1;
    } else if (character === ';' && parentheses === 0) {
      entries.push(block.slice(cursor, index));
      cursor = index + 1;
    }
  }
  entries.push(block.slice(cursor));
  entries.forEach((entry) => {
    let separator = -1;
    quote = '';
    parentheses = 0;
    for (let index = 0; index < entry.length; index += 1) {
      const character = entry[index];
      if (quote) {
        if (character === '\\') index += 1;
        else if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '(') {
        parentheses += 1;
      } else if (character === ')') {
        parentheses -= 1;
      } else if (character === ':' && parentheses === 0) {
        separator = index;
        break;
      }
    }
    if (separator >= 0) declarations.push([entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()]);
  });
  return declarations.filter(([name]) => name === property).at(-1)?.[1] ?? '';
};
const hasExactSelector = (source, selector) => cssBlocks(source).some(({ header }) => !header.startsWith('@')
  && splitSelectors(header).includes(normalizeSelector(selector)));
const hasExactKeyframe = (source, name) => cssBlocks(source).some(({ header }) => header === `@keyframes ${name}`);

test('restarts a motion class without queueing and cleans it on animation end', () => {
  const classes = new Set(['motion-status-ring']);
  const listeners = new Map();
  const timers = [];
  const element = {
    classList: {
      remove(name) { classes.delete(name); },
      add(name) { classes.add(name); },
    },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
  };

  const cancel = triggerMotion(element, 'motion-status-ring', 800, {
    setTimeoutFn: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutFn: () => {},
  });

  assert.equal(classes.has('motion-status-ring'), true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 800);
  listeners.get('animationend')({ target: element });
  assert.equal(classes.has('motion-status-ring'), false);
  assert.equal(listeners.has('animationend'), false);
  cancel();
  assert.equal(classes.has('motion-status-ring'), false);
});

test('bounds motion cleanup when animationend never arrives', () => {
  const classes = new Set();
  const timers = [];
  const element = {
    classList: { remove(name) { classes.delete(name); }, add(name) { classes.add(name); } },
    addEventListener() {},
    removeEventListener() {},
  };
  triggerMotion(element, 'motion-event-enter', 999999, {
    setTimeoutFn: (callback, delay) => { timers.push({ callback, delay }); return 1; },
    clearTimeoutFn: () => {},
  });
  assert.equal(timers[0].delay, 10000);
  timers[0].callback();
  assert.equal(classes.has('motion-event-enter'), false);
});

test('removes a toast only after exit motion cleanup completes', () => {
  const classes = new Set(['motion-toast-enter']);
  const listeners = new Map();
  let removed = 0;
  const element = {
    classList: { remove(name) { classes.delete(name); }, add(name) { classes.add(name); } },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    remove() { removed += 1; },
  };
  const timers = [];
  removeAfterMotion(element, 'motion-toast-exit', 180, {
    setTimeoutFn: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeoutFn: () => {},
  });
  assert.equal(removed, 0);
  assert.equal(classes.has('motion-toast-exit'), true);
  listeners.get('animationend')({ target: element });
  assert.equal(removed, 1);
  assert.equal(classes.has('motion-toast-exit'), false);
  assert.equal(timers.length, 1);
});

test('computes a positive core-to-agent topology host and applies absolute geometry', () => {
  const geometry = topologyLinkGeometry(
    { x: 500, y: 200 },
    { x: 800, y: 100 },
    { left: 0, top: 0, width: 1000, height: 400 },
  );
  assert.deepEqual(geometry, {
    left: 500,
    top: 200,
    width: Math.hypot(300, 100),
    height: 1,
    distance: Math.hypot(300, 100),
    transform: 'rotate(-18.43494882292201deg)',
  });
  const style = { values: new Map(), setProperty(name, value) { this.values.set(name, value); } };
  applyTopologyLinkGeometry({ style }, geometry);
  assert.equal(style.values.get('--motion-link-distance'), `${geometry.distance}px`);
  assert.equal(style.values.get('width'), `${geometry.width}px`);
  assert.equal(style.values.get('height'), '1px');
  assert.equal(style.values.get('transform'), geometry.transform);
});

test('classifies only meaningful link transitions', () => {
  const allowed = [
    [{ from: { status: 'queued' }, to: { status: 'starting' } }, { source: 'poll' }],
    [{ from: { status: 'idle' }, to: { status: 'running' } }, { source: 'poll' }],
    [{ from: { status: 'running' }, to: { status: 'completed' } }, { source: 'poll' }],
    [{ jobId: 'job-1', from: { status: 'running', phase: 'implementing' }, to: { status: 'running', phase: 'verifying' } }, { source: 'sse', selectedJobId: 'job-1', hasNewEvent: true }],
  ];
  allowed.forEach(([transition, options]) => assert.equal(shouldAnimateLinkTransition(transition, options), true));
  const rejected = [
    [{ from: { status: 'completed' }, to: { status: 'failed' } }, { source: 'poll' }],
    [{ from: { status: 'running' }, to: { status: 'queued' } }, { source: 'poll' }],
    [{ jobId: 'job-2', from: { status: 'running', phase: 'implementing' }, to: { status: 'running', phase: 'verifying' } }, { source: 'sse', selectedJobId: 'job-1', hasNewEvent: true }],
    [{ jobId: 'job-1', from: { status: 'running', phase: 'implementing' }, to: { status: 'running', phase: 'verifying' } }, { source: 'sse', selectedJobId: 'job-1', hasNewEvent: false }],
    [{ jobId: 'job-1', from: { status: 'running', phase: 'implementing' }, to: { status: 'running', phase: 'verifying' } }, { source: 'poll', selectedJobId: 'job-1', hasNewEvent: true }],
    [{ from: { status: 'running' }, to: { status: 'running' } }, { source: 'interaction', selectedJobId: 'job-1', hasNewEvent: true }],
    [{ from: { status: 'running' }, to: { status: 'completed' } }, { source: 'recovery' }],
  ];
  rejected.forEach(([transition, options]) => assert.equal(shouldAnimateLinkTransition(transition, options), false));
});

test('maps cancelled to a stable semantic state and respects reduced-motion trigger guards', () => {
  assert.equal(statusClassFor('cancelled'), 'cancelled');
  assert.equal(sessionStatusFor('cancelled', 'open'), 'cancelled');
  assert.equal(prefersReducedMotion(() => ({ matches: true })), true);
  const classes = new Set();
  const timers = [];
  const element = {
    classList: { remove(name) { classes.delete(name); }, add(name) { classes.add(name); } },
    addEventListener() {},
    removeEventListener() {},
  };
  triggerMotion(element, 'motion-status-ring', 800, {
    prefersReducedMotionFn: () => true,
    setTimeoutFn: (callback) => timers.push(callback),
  });
  assert.deepEqual([...classes], []);
  assert.equal(timers.length, 0);
});

test('reopening a modal cancels a stale exit and preserves the reopened modal', () => {
  const timers = [];
  const classes = new Set(['hidden']);
  const backdrop = {
    classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); } },
  };
  const modalClasses = new Set();
  const modal = {
    classList: { add(name) { modalClasses.add(name); }, remove(name) { modalClasses.delete(name); } },
  };
  let hidden = 0;
  const controller = createModalMotionController({
    setTimeoutFn: (callback) => { timers.push(callback); return timers.length; },
    clearTimeoutFn: () => {},
    reducedMotionFn: () => false,
  });
  controller.open(backdrop, modal);
  controller.close(backdrop, modal, () => { hidden += 1; backdrop.classList.add('hidden'); });
  controller.open(backdrop, modal);
  timers[0]?.();
  assert.equal(hidden, 0);
  assert.equal(classes.has('hidden'), false);
  assert.equal(modalClasses.has('motion-modal-exit'), false);
  assert.equal(modalClasses.has('motion-modal-enter'), true);
});

test('fake DOM trigger seams mount status, link, KPI, event, and alert effects', () => {
  const makeElement = () => {
    const classes = new Set();
    return { classes, classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); } }, addEventListener() {}, removeEventListener() {} };
  };
  const elements = ['status', 'link', 'kpi', 'event', 'alert'].map(() => makeElement());
  elements.forEach((element, index) => triggerMotion(element, ['motion-status-ring', 'motion-link-travel', 'motion-kpi-change', 'motion-event-enter', 'motion-alert-enter'][index], 100, { setTimeoutFn: () => 1, clearTimeoutFn() {} }));
  assert.deepEqual(elements.map((element) => [...element.classes]), [
    ['motion-status-ring'], ['motion-link-travel'], ['motion-kpi-change'], ['motion-event-enter'], ['motion-alert-enter'],
  ]);
});
const snapshotData = (overrides = {}) => ({
  kpis: { agents: 1, running: 0, completed: 0 },
  agents: [{ id: 'backend-engineer', name: 'Backend Engineer', state: 'idle' }],
  jobs: [],
  events: [],
  alerts: [],
  ...overrides,
});

test('rejects malformed CSS and preserves string-aware duplicate cascade order', () => {
  assert.throws(() => cssBlocks('.valid { color: red; } trailing'), /unmatched trailing CSS/);
  assert.throws(() => cssBlocks('.valid { color: red; } }'), /unbalanced braces/);
  assert.throws(() => cssBlocks('.valid {'), /unbalanced braces/);
  assert.throws(() => cssBlocks('.valid { content: "unterminated; }'), /unterminated string/);
  assert.throws(() => cssBlocks('/* unterminated comment'), /unterminated comment/);

  const literalCss = '.literal { content: "escaped \\\" }"; /* color: red; */ color: blue; }';
  assert.equal(declaration(ruleBlock(literalCss, '.literal'), 'content'), '"escaped \\" }"');
  assert.equal(declaration(ruleBlock(literalCss, '.literal'), 'color'), 'blue');

  const duplicateCss = '.cascade { color: red; color: blue; } .cascade { color: green; }';
  assert.deepEqual(
    cssBlocks(duplicateCss)
      .filter(({ header }) => header === '.cascade')
      .map(({ body }) => body.trim()),
    ['color: red; color: blue;', 'color: green;'],
  );
  assert.equal(declaration(ruleBlock(duplicateCss, '.cascade'), 'color'), 'green');

  const selectorFixture = '.a:is(.b,.c), [data-label="x,y"] { color: purple; }';
  assert.equal(declaration(ruleBlock(selectorFixture, '.a:is(.b,.c)'), 'color'), 'purple');
  assert.equal(declaration(ruleBlock(selectorFixture, '[data-label="x,y"]'), 'color'), 'purple');

  const mediaFixture = '@media (max-width: 10px) { .duplicate { color: red; } } @media (max-width: 20px) { .duplicate { color: blue; } }';
  assert.equal(declaration(ruleBlockIn(mediaFixture, '.duplicate', '@media (max-width: 10px)'), 'color'), 'red');
  assert.equal(declaration(ruleBlockIn(mediaFixture, '.duplicate', '@media (max-width: 20px)'), 'color'), 'blue');
});

test('defines the semantic CSS motion contract', () => {
  const requiredTokens = {
    '--motion-fast': '120ms',
    '--motion-enter': '160ms',
    '--motion-overlay': '180ms',
    '--motion-status': '800ms',
    '--motion-data': '240ms',
  };
  const requiredSelectors = [
    '.motion-event-enter',
    '.motion-kpi-change',
    '.motion-status-ring',
    '.agent-node.motion-status-ring',
    '.motion-link-travel',
    '.topology-link',
    '.motion-alert-enter',
    '.motion-modal-enter',
    '.motion-modal-exit',
    '.motion-toast-enter',
    '.motion-toast-exit',
    '.agent-node[data-state="queued"]',
    '.agent-node[data-state="completed"]',
    '.agent-node[data-state="cancelled"]',
    '.agent-node-copy small.queued',
    '.agent-node-copy small.completed',
    '.recent-dot.queued',
    '.recent-dot.completed',
    '.recent-dot.cancelled',
    '[data-status="failed"]',
    '[data-status="disconnected"]',
    '[data-status="queued"]',
    '[data-status="completed"]',
    '[data-status="blocked"]',
    '[data-status="cancelled"]',
  ];
  const requiredKeyframes = [
    'motion-enter-up',
    'motion-kpi-flash',
    'motion-status-ring',
    'motion-link-travel',
    'motion-overlay-enter',
    'motion-overlay-exit',
    'motion-toast-enter',
    'motion-toast-exit',
  ];

  const rootRule = ruleBlock(styles, ':root');
  Object.entries(requiredTokens).forEach(([property, value]) => {
    assert.equal(declaration(rootRule, property), value, `missing CSS token: ${property}: ${value}`);
  });
  requiredSelectors.forEach((selector) => {
    assert.equal(hasExactSelector(styles, selector), true, `missing exact CSS selector: ${selector}`);
  });
  requiredKeyframes.forEach((name) => {
    assert.equal(hasExactKeyframe(styles, name), true, `missing exact CSS keyframe: ${name}`);
  });

  const mobileAgentRule = atRuleBody(styles, '@media (max-width: 900px)');
  assert.match(mobileAgentRule, /\.agent-node\s*\{[^}]*width:\s*min\(126px,\s*40%\)/s);
  const mobileEdgeRule = atRuleBody(styles, '@media (max-width: 480px)');
  assert.match(mobileEdgeRule, /\.agent-node\[data-agent="security-engineer"\]\s*\{[^}]*left:\s*clamp\(22%/s);
  assert.match(mobileEdgeRule, /\.agent-node\[data-agent="frontend-engineer"\]\s*\{[^}]*left:\s*clamp\(76%/s);
  ['security-engineer', 'devops-engineer', 'qa-engineer', 'backend-engineer', 'ui-designer', 'frontend-engineer']
    .forEach((agent) => assert.notEqual(declaration(ruleBlock(mobileEdgeRule, `.agent-node[data-agent="${agent}"]`), 'left'), '', `missing mobile edge position for ${agent}`));

  const commentOnlyCss = `
    /* :root { --motion-fast: 120ms; } */
    /* .motion-event-enter {} */
    /* @keyframes motion-enter-up {} */
  `;
  assert.equal(declaration(ruleBlock(commentOnlyCss, ':root'), '--motion-fast'), '');
  assert.equal(hasExactSelector(commentOnlyCss, '.motion-event-enter'), false);
  assert.equal(hasExactKeyframe(commentOnlyCss, 'motion-enter-up'), false);

  const prefixedSelectorCss = '.document-hidden .motion-event-enter {}';
  assert.equal(hasExactSelector(prefixedSelectorCss, '.motion-event-enter'), false);

  const suffixedSelectorCss = '.motion-event-enter-extra {}';
  assert.equal(hasExactSelector(suffixedSelectorCss, '.motion-event-enter'), false);

  const suffixedKeyframeCss = '@keyframes motion-enter-up-extra {}';
  assert.equal(hasExactKeyframe(suffixedKeyframeCss, 'motion-enter-up'), false);

  assert.match(styles, /\.agent-node-copy small\.completed\s*\{[^}]*color:\s*var\(--green\)/);
  const runningRingRule = ruleBlock(styles, '.agent-node[data-state="running"]');
  assert.equal(declaration(ruleBlock(styles, '.agent-node'), 'position'), 'absolute');
  assert.equal(declaration(ruleBlock(styles, '.agent-node'), 'transform'), 'translate(-50%, -50%)');
  assert.equal(declaration(runningRingRule, 'position'), 'absolute');
  assert.match(runningRingRule, /isolation:\s*isolate/);
  const agentStatusRingHostRule = ruleBlock(styles, '.agent-node.motion-status-ring');
  assert.equal(declaration(agentStatusRingHostRule, 'position'), 'absolute');
  assert.equal(declaration(agentStatusRingHostRule, 'transform'), 'translate(-50%, -50%)');
  const startingRingRule = ruleBlock(styles, '.agent-node[data-state="starting"]');
  const queuedRingRule = ruleBlock(styles, '.agent-node[data-state="queued"]');
  const completedRingRule = ruleBlock(styles, '.agent-node[data-state="completed"]');
  const failedRingRule = ruleBlock(styles, '.agent-node[data-state="failed"]');
  const blockedRingRule = ruleBlock(styles, '.agent-node[data-state="blocked"]');
  assert.match(startingRingRule, /--motion-ring-color:\s*var\(--green\)/);
  assert.match(runningRingRule, /--motion-ring-color:\s*var\(--green\)/);
  assert.match(queuedRingRule, /--motion-ring-color:\s*var\(--amber\)/);
  assert.match(completedRingRule, /--motion-ring-color:\s*var\(--green\)/);
  assert.match(failedRingRule, /--motion-ring-color:\s*var\(--red\)/);
  assert.match(blockedRingRule, /--motion-ring-color:\s*var\(--red\)/);
  assert.match(ruleBlock(styles, '.agent-node[data-state="cancelled"]'), /--motion-ring-color:\s*var\(--muted\)/);
  const statusRingRule = ruleBlock(styles, '.motion-status-ring::after');
  assert.equal(declaration(statusRingRule, 'border'), '1px solid var(--motion-ring-color)');
  assert.doesNotMatch(statusRingRule, /currentColor/);
  assert.match(styles, /\.recent-dot\.queued\s*\{[^}]*background:\s*var\(--amber\)/);
  assert.match(styles, /\.recent-dot\.completed\s*\{[^}]*background:\s*var\(--green\)/);
  assert.match(styles, /\.recent-dot\.cancelled\s*\{[^}]*background:\s*var\(--muted\)/);

  const kpiKeyframes = cssBlocks(styles).filter(({ atRule }) => atRule === '@keyframes motion-kpi-flash');
  assert.equal(kpiKeyframes.length, 2);
  kpiKeyframes.forEach(({ body }) => {
    assert.doesNotMatch(body, /(?:^|;)\s*color\s*:/);
    assert.match(body, /(?:^|;)\s*background-color\s*:/);
    assert.match(body, /(?:^|;)\s*opacity\s*:/);
  });
  assert.match(ruleBlock(styles, '.kpi b.is-alert'), /color:\s*var\(--red\)/);
  assert.match(ruleBlock(styles, '.kpi b'), /color:\s*#75d9ff/);

  assert.equal(declaration(ruleBlock(styles, '.motion-link-travel'), 'position'), '');
  assert.equal(declaration(ruleBlock(styles, '.topology-link'), 'position'), 'absolute');
  assert.equal(declaration(ruleBlockIn(styles, '.topology-link.motion-link-travel::after', ''), 'animation'), 'motion-link-travel 800ms ease-out both');
  assert.equal(hasExactSelector(styles, '.motion-link-travel::after'), false);

  assert.equal(declaration(ruleBlock(styles, '.health-pill'), 'color'), 'var(--green)');
  assert.equal(declaration(ruleBlock(styles, '.health-pill.connection-error'), 'color'), 'var(--red)');
  assert.equal(declaration(ruleBlock(styles, '.health-pill[data-status="completed"]'), 'color'), 'var(--green)');
  assert.equal(declaration(ruleBlock(styles, '.health-pill[data-status="failed"]'), 'color'), 'var(--red)');
  assert.equal(hasExactSelector(styles, '.health-pill[data-status]'), false);
  ['failed', 'disconnected', 'queued', 'completed', 'blocked', 'cancelled'].forEach((status) => {
    assert.equal(hasExactSelector(styles, `.health-pill[data-status="${status}"]`), true);
  });

  const runningRule = styles.match(/\.agent-node\[data-state="running"\][^{]*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(runningRule, /animation\s*:[^;]*node-pulse/);
  assert.match(styles, /\.agent-node\[data-state="running"\]::after\s*\{[^}]*animation\s*:\s*node-pulse/);
  const runningPulseRuleEnd = styles.indexOf('}', styles.indexOf('.agent-node[data-state="running"]::after'));
  const statusRingOverride = styles.match(/\.agent-node\.motion-status-ring::after\s*\{([^}]*)\}/);
  assert.ok(statusRingOverride, 'missing running status-ring override selector');
  assert.ok(styles.indexOf('.agent-node.motion-status-ring::after') > runningPulseRuleEnd, 'status-ring override must follow running pulse rule');
  assert.match(statusRingOverride[1], /animation\s*:\s*motion-status-ring\s+var\(--motion-status\)\s+ease-out\s+both/);
  const nodePulse = styles.match(/@keyframes node-pulse\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(nodePulse, /transform/);
  assert.match(nodePulse, /opacity/);
  assert.doesNotMatch(nodePulse, /box-shadow/);

  assert.match(styles, /\.orbit\s*\{[^}]*border:\s*1px solid rgba\(52, 185, 238, \.22\)[^}]*box-shadow:\s*0 0 12px rgba\(52, 185, 238, \.04\)/s);
  assert.match(styles, /\.orbit-b\s*\{[^}]*border-color:\s*rgba\(76, 211, 138, \.16\)[^}]*animation:\s*orbit-drift-reverse 42s/);
  assert.match(styles, /\.orbit-a\s*\{[^}]*animation:\s*orbit-drift 34s/);

  const hiddenMotionRule = ruleBlock(styles, '.document-hidden .orbit');
  [
    '.orbit',
    '.agent-node[data-state="running"]::after',
    '.motion-link-travel',
    '.motion-status-ring::after',
    '.motion-event-enter',
    '.motion-kpi-change',
    '.motion-alert-enter',
    '.motion-modal-enter',
    '.motion-modal-exit',
    '.motion-toast-enter',
    '.motion-toast-exit',
  ].forEach((selector) => assert.ok(ruleBlock(styles, `.document-hidden ${selector}`), `hidden-page rule missing ${selector}`));
  assert.equal(declaration(hiddenMotionRule, 'animation-play-state'), 'paused');
  [
    '.orbit',
    '.agent-node[data-state="running"]::after',
    '.motion-link-travel',
    '.topology-link.motion-link-travel::after',
    '.motion-status-ring::after',
    '.motion-event-enter',
    '.motion-kpi-change',
    '.motion-alert-enter',
    '.motion-modal-enter',
    '.motion-modal-exit',
    '.motion-toast-enter',
    '.motion-toast-exit',
  ].forEach((selector) => assert.equal(declaration(ruleBlock(styles, `.document-hidden ${selector}`), 'animation-play-state'), 'paused', `hidden-page rule missing paused animation for ${selector}`));

  const reducedMotion = atRuleBody(styles, '@media (prefers-reduced-motion: reduce)');
  [
    '.orbit',
    '.motion-link-travel',
    '.motion-status-ring::after',
    '.motion-event-enter',
    '.motion-alert-enter',
    '.motion-modal-enter',
    '.motion-modal-exit',
    '.motion-toast-enter',
    '.motion-toast-exit',
  ].forEach((selector) => assert.ok(ruleBlock(reducedMotion, selector), `reduced-motion rule missing ${selector}`));
  assert.equal(declaration(ruleBlock(reducedMotion, '.orbit-a'), 'transform'), 'translate(-50%, -50%) rotate(-8deg) !important');
  assert.equal(declaration(ruleBlock(reducedMotion, '.orbit-b'), 'transform'), 'translate(-50%, -50%) rotate(58deg) !important');
  assert.equal(declaration(ruleBlock(reducedMotion, '.motion-link-travel'), 'animation'), 'none !important');
  assert.equal(declaration(ruleBlock(reducedMotion, '.motion-link-travel'), 'transform'), '');
  assert.equal(declaration(ruleBlock(reducedMotion, '.topology-link.motion-link-travel::after'), 'animation'), 'none !important');
  assert.equal(declaration(ruleBlock(reducedMotion, '.topology-link.motion-link-travel::after'), 'transform'), 'none !important');
  assert.equal(declaration(ruleBlock(reducedMotion, '.agent-node'), 'transform'), '');
  assert.equal(declaration(ruleBlock(reducedMotion, '.agent-node[data-state="running"]'), 'transform'), '');
  assert.equal(declaration(ruleBlock(reducedMotion, '.agent-node.motion-status-ring'), 'transform'), '');
  assert.equal(declaration(ruleBlock(reducedMotion, '.agent-node[data-state="running"]::after'), 'animation'), 'none !important');
  assert.equal(declaration(ruleBlock(reducedMotion, '.agent-node[data-state="running"]::after'), 'transform'), 'none !important');
  assert.equal(declaration(ruleBlock(reducedMotion, '.motion-kpi-change'), 'animation'), '');
  assert.match(styles, /\.load-track i\s*\{[^}]*transition:\s*width\s+var\(--motion-data\)\s+ease/);
});

test('suppresses motion on the first render and on an identical snapshot', () => {
  const baseline = createMotionSnapshot();
  const snapshot = createMotionSnapshot(snapshotData());

  assert.deepEqual(diffDashboardMotion(baseline, snapshot), {
    initialized: false,
    kpiChanges: [],
    agentTransitions: [],
    newEvents: [],
    alertChanges: [],
    linkTransitions: [],
  });
  assert.deepEqual(diffDashboardMotion(snapshot, createMotionSnapshot(snapshotData())), {
    initialized: true,
    kpiChanges: [],
    agentTransitions: [],
    newEvents: [],
    alertChanges: [],
    linkTransitions: [],
  });
});

test('does not mutate source data or motion snapshots', () => {
  const source = snapshotData({
    kpis: { agents: 2, running: 1, completed: 1 },
    agents: [{ id: 'backend-engineer', name: 'Backend Engineer', state: 'running' }],
    jobs: [{ jobId: 'job-1', agent: 'backend-engineer', status: 'running', phase: 'implementing' }],
    events: [{ seq: 7, type: 'system', metadata: { source: 'test' } }],
    alerts: [{ id: 'alert-1', text: 'Existing alert' }],
  });
  const sourceBefore = structuredClone(source);
  const previous = createMotionSnapshot(source);
  const previousBefore = structuredClone(previous);
  const current = createMotionSnapshot(snapshotData({
    kpis: { agents: 2, running: 0, completed: 2 },
    agents: [{ id: 'backend-engineer', name: 'Backend Engineer', state: 'completed' }],
    jobs: [{ jobId: 'job-1', agent: 'backend-engineer', status: 'completed', phase: 'completed' }],
    events: [{ seq: 7, type: 'system', metadata: { source: 'test' } }, { seq: 8, type: 'assistant' }],
    alerts: [{ id: 'alert-1', text: 'Existing alert' }, { id: 'alert-2', text: 'New alert' }],
  }));
  const currentBefore = structuredClone(current);

  diffDashboardMotion(previous, current, 'sse');

  assert.deepEqual(source, sourceBefore);
  assert.deepEqual(previous, previousBefore);
  assert.deepEqual(current, currentBefore);
});

test('does not replay the same SSE event on a repeated diff', () => {
  const previous = createMotionSnapshot(snapshotData({ events: [{ seq: 7, type: 'system' }] }));
  const current = createMotionSnapshot(snapshotData({
    events: [{ seq: 7, type: 'system' }, { seq: 8, type: 'assistant' }],
  }));

  const first = diffDashboardMotion(previous, current, 'sse');
  const second = diffDashboardMotion(current, current, 'sse');

  assert.deepEqual(first.newEvents.map((event) => event.seq), [8]);
  assert.deepEqual(second.newEvents, []);
});

test('reports one KPI value change', () => {
  const previous = createMotionSnapshot(snapshotData({ kpis: { running: 1 } }));
  const current = createMotionSnapshot(snapshotData({ kpis: { running: 2 } }));

  assert.deepEqual(diffDashboardMotion(previous, current).kpiChanges, [
    { key: 'running', previous: 1, current: 2 },
  ]);
});

test('reports one agent transition and suppresses its repeated state', () => {
  const previous = createMotionSnapshot(snapshotData());
  const current = createMotionSnapshot(snapshotData({
    jobs: [{ jobId: 'job-1', agent: 'backend-engineer', status: 'running', phase: 'implementing' }],
  }));

  const diff = diffDashboardMotion(previous, current);
  assert.equal(diff.agentTransitions.length, 1);
  assert.deepEqual(diff.agentTransitions[0], {
    id: 'backend-engineer',
    from: { status: 'idle', phase: null, jobId: null },
    to: { status: 'running', phase: 'implementing', jobId: 'job-1' },
  });
  assert.deepEqual(diffDashboardMotion(current, createMotionSnapshot(snapshotData({
    jobs: [{ jobId: 'job-1', agent: 'backend-engineer', status: 'running', phase: 'implementing' }],
  }))).agentTransitions, []);
});

test('reports a new event once for live SSE and excludes historical hydration', () => {
  const previous = createMotionSnapshot(snapshotData({ events: [{ seq: 7, type: 'system' }] }));
  const current = createMotionSnapshot(snapshotData({ events: [
    { seq: 7, type: 'system' },
    { seq: 8, type: 'assistant' },
  ] }));

  assert.deepEqual(diffDashboardMotion(previous, current, 'sse').newEvents.map((event) => event.seq), [8]);
  assert.deepEqual(diffDashboardMotion(previous, current, 'poll').newEvents, []);
  assert.deepEqual(diffDashboardMotion(previous, current, 'bootstrap').newEvents, []);
  assert.deepEqual(diffDashboardMotion(previous, current, 'recovery').newEvents, []);
});

test('reports one terminal job link transition', () => {
  const previous = createMotionSnapshot(snapshotData({
    jobs: [{ jobId: 'job-1', agent: 'backend-engineer', status: 'running', phase: 'verifying' }],
  }));
  const current = createMotionSnapshot(snapshotData({
    jobs: [{ jobId: 'job-1', agent: 'backend-engineer', status: 'completed', phase: 'completed' }],
  }));

  assert.deepEqual(diffDashboardMotion(previous, current).linkTransitions, [{
    jobId: 'job-1',
    agentId: 'backend-engineer',
    from: { status: 'running', phase: 'verifying' },
    to: { status: 'completed', phase: 'completed' },
  }]);
});

test('reports an alert identity once without replaying it on later polls', () => {
  const previous = createMotionSnapshot(snapshotData({ alerts: [{ id: 'alert-1', text: 'Existing alert' }] }));
  const current = createMotionSnapshot(snapshotData({ alerts: [
    { id: 'alert-1', text: 'Existing alert' },
    { id: 'alert-2', text: 'New alert' },
  ] }));

  assert.deepEqual(diffDashboardMotion(previous, current).alertChanges, [{
    id: 'alert-2',
    alert: { id: 'alert-2', text: 'New alert' },
  }]);
  assert.deepEqual(diffDashboardMotion(current, createMotionSnapshot(snapshotData({ alerts: [
    { id: 'alert-1', text: 'Existing alert' },
    { id: 'alert-2', text: 'New alert' },
  ] }))).alertChanges, []);
});

test('does not replay identity-less alerts after insertion and reordering', () => {
  const existing = [
    { critical: true, text: 'Existing failure', time: '10:00' },
    { text: 'Queued work', time: '实时' },
  ];
  const previous = createMotionSnapshot(snapshotData({ alerts: existing }));
  const current = createMotionSnapshot(snapshotData({ alerts: [
    { text: 'New notice', time: '设置' },
    existing[1],
    existing[0],
  ] }));

  assert.deepEqual(diffDashboardMotion(previous, current).alertChanges.map(({ alert }) => alert.text), ['New notice']);
});

test('coalesces dashboard renders and preserves the strongest update source', () => {
  const frames = [];
  const renders = [];
  const scheduler = createDashboardScheduler({
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelAnimationFrame: () => {},
    isHidden: () => false,
    render: (data, source) => renders.push({ data, source }),
  });
  scheduler.schedule({ value: 1 }, 'poll');
  scheduler.schedule({ value: 2 }, 'sse');
  scheduler.schedule({ value: 3 }, 'interaction');
  scheduler.schedule({ value: 4 }, 'bootstrap');
  scheduler.schedule({ value: 5 }, 'recovery');
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(renders, [{ data: { value: 5 }, source: 'interaction' }]);
});

test('suppresses empty SSE payloads and schedules only meaningful changes', () => {
  const frames = [];
  const renders = [];
  const scheduler = createDashboardScheduler({
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelAnimationFrame: () => {},
    isHidden: () => false,
    isMeaningfulChange: (previous, current) => previous?.version !== current?.version,
    render: (data, source) => renders.push({ data, source }),
  });
  assert.equal(scheduler.schedule({ version: 1, events: [] }, 'bootstrap'), true);
  assert.equal(scheduler.schedule({ version: 1, events: [] }, 'sse'), false);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(renders.length, 1);
  assert.equal(scheduler.schedule({ version: 2, events: [{ seq: 1 }] }, 'sse'), true);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(renders, [
    { data: { version: 1, events: [] }, source: 'bootstrap' },
    { data: { version: 2, events: [{ seq: 1 }] }, source: 'sse' },
  ]);
});

test('buffers hidden updates and performs a visible baseline resync without replay', () => {
  const frames = [];
  const renders = [];
  let hidden = true;
  const scheduler = createDashboardScheduler({
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelAnimationFrame: () => {},
    isHidden: () => hidden,
    render: (data, source, options) => renders.push({ data, source, options }),
  });
  scheduler.schedule({ version: 1 }, 'bootstrap');
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(renders, []);
  scheduler.schedule({ version: 2 }, 'sse');
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(renders, []);
  hidden = false;
  assert.equal(scheduler.restoreVisible(), true);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(renders, [{ data: { version: 2 }, source: 'recovery', options: { baseline: true } }]);
  assert.equal(scheduler.restoreVisible(), false);
});

test('suppresses repeated active-job heartbeats but schedules status and phase changes', () => {
  const frames = [];
  const renders = [];
  const scheduler = createDashboardScheduler({
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelAnimationFrame: () => {},
    isHidden: () => false,
    isMeaningfulChange: (previous, current) => !meaningfulJobMetaEqual(previous, current),
    render: (data) => renders.push(data),
  });
  const active = { jobId: 'job-1', status: 'running', phase: 'implementing', progressRevision: 4, elapsedMs: 1000, updatedAt: '10:00:00' };
  assert.equal(scheduler.schedule(active, 'bootstrap'), true);
  frames.shift()();
  assert.equal(scheduler.schedule({ ...active, elapsedMs: 2000, updatedAt: '10:00:01', heartbeat: 1 }, 'sse'), false);
  assert.equal(scheduler.schedule({ ...active, elapsedMs: 3000, updatedAt: '10:00:02', heartbeat: 2 }, 'sse'), false);
  assert.equal(frames.length, 0);
  assert.equal(scheduler.schedule({ ...active, phase: 'verifying', elapsedMs: 4000, updatedAt: '10:00:03' }, 'sse'), true);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(renders.length, 2);
  assert.equal(scheduler.schedule({ ...active, status: 'completed', phase: 'completed', progressRevision: 5, elapsedMs: 5000, updatedAt: '10:00:04' }, 'sse'), true);
  assert.equal(frames.length, 1);
});

test('patches changed resource text in place and draws only affected keys', () => {
  const canvasA = { dataset: { resourceKey: 'concurrency' } };
  const canvasB = { dataset: { resourceKey: 'events' } };
  const rowA = { dataset: { resourceKey: 'concurrency' }, querySelector: (selector) => selector === '.resource-spark' ? canvasA : null };
  const rowB = { dataset: { resourceKey: 'events' }, querySelector: (selector) => selector === '.resource-spark' ? canvasB : null };
  const container = {
    children: [rowA, rowB],
    querySelector: (selector) => selector === '[data-resource-key="concurrency"]' ? rowA : selector === '[data-resource-key="events"]' ? rowB : null,
    append: () => {},
  };
  const draws = [];
  const initial = resourceRows({ agents: [{ id: 'a' }], jobs: [{ agent: 'a', status: 'running' }], events: [{ seq: 1 }] });
  const updated = resourceRows({ agents: [{ id: 'a' }], jobs: [{ agent: 'a', status: 'running' }], events: [{ seq: 1 }, { seq: 2 }] });
  patchResourceRows(container, updated, new Set(['events']), {
    createRow: (row) => ({ dataset: { resourceKey: row.key }, querySelector: () => ({ dataset: { resourceKey: row.key } }) }),
    updateRow: (element, row) => { element.dataset.value = row.value; },
    drawRow: (canvas, row) => draws.push([canvas.dataset.resourceKey, row.key]),
  });
  assert.equal(container.querySelector('[data-resource-key="concurrency"]').querySelector('.resource-spark'), canvasA);
  assert.equal(container.querySelector('[data-resource-key="events"]').querySelector('.resource-spark'), canvasB);
  assert.deepEqual(draws, [['events', 'events']]);
  assert.equal(initial[0].key, 'concurrency');
});

test('merges supplied stream metadata without mutating or losing stable job fields', () => {
  const previous = { jobId: 'job-1', status: 'running', phase: 'implementing', task: 'keep me', sessionId: 'session', cwd: '/repo' };
  assert.deepEqual(mergeStreamJobMeta(previous, { jobId: 'job-1', phase: 'verifying' }), { ...previous, phase: 'verifying' });
  assert.deepEqual(mergeStreamJobMeta(previous, { jobId: 'job-2', status: 'completed' }), previous);
  assert.deepEqual(mergeStreamJobMeta(previous, { jobId: 'job-1', status: 'completed', phase: 'completed', task: 'updated' }), {
    ...previous, status: 'completed', phase: 'completed', task: 'updated',
  });
});

test('exposes a disconnected session status during SSE failure and recovers on reconnect', () => {
  assert.equal(sessionStatusFor('running', 'error'), 'disconnected');
  assert.equal(sessionStatusFor('running', 'open'), 'running');
  assert.equal(sessionStatusFor('completed', 'error'), 'disconnected');
  assert.equal(sessionStatusFor('completed', 'idle'), 'completed');
});

test('charts fingerprint only includes chart data and canvas dimensions', () => {
  const jobs = [{ jobId: 'job-1', status: 'running', phase: 'implementing', verificationState: 'pending', createdAt: '2026-07-17T10:00:00.000Z' }];
  const baseline = chartFingerprint(jobs, { donut: [200, 100], execution: [400, 120], success: [400, 120] });

  assert.equal(chartFingerprint([{ ...jobs[0], phase: 'verifying', verificationState: 'passed', task: 'unrelated' }], { donut: [200, 100], execution: [400, 120], success: [400, 120] }), baseline);
  assert.notEqual(chartFingerprint(jobs, { donut: [201, 100], execution: [400, 120], success: [400, 120] }), baseline);
  assert.notEqual(chartFingerprint([{ ...jobs[0], status: 'completed' }], { donut: [200, 100], execution: [400, 120], success: [400, 120] }), baseline);
});

test('charts fingerprint normalized chart buckets independent of identity, timestamp precision, and order', () => {
  const dimensions = { donut: [200, 100], execution: [400, 120], success: [400, 120] };
  const jobs = [
    { jobId: 'job-1', status: 'running', createdAt: '2026-07-17T10:00:00+08:00' },
    { jobId: 'job-2', status: 'completed', createdAt: '2026-07-16T11:00:00+08:00' },
  ];
  const baseline = chartFingerprint(jobs, dimensions);

  assert.equal(chartFingerprint([
    { ...jobs[0], jobId: 'new-id', createdAt: '2026-07-17T23:59:59.999+08:00', phase: 'verifying', task: 'ignored' },
    { ...jobs[1], jobId: 'other-id', createdAt: '2026-07-16T00:00:01.000Z', verificationState: 'passed', tokens: 99 },
  ], dimensions), baseline);
  assert.equal(chartFingerprint([...jobs].reverse(), dimensions), baseline);
  assert.notEqual(chartFingerprint([...jobs, { jobId: 'job-3', status: 'queued', createdAt: '2026-07-17T12:00:00.000Z' }], dimensions), baseline);
  assert.notEqual(chartFingerprint([jobs[0]], dimensions), baseline);
  assert.notEqual(chartFingerprint([{ ...jobs[0], status: 'completed' }, jobs[1]], dimensions), baseline);
  assert.notEqual(chartFingerprint([{ ...jobs[0], createdAt: '2026-07-18T10:00:00.000Z' }, jobs[1]], dimensions), baseline);
  assert.notEqual(chartFingerprint(jobs, { ...dimensions, execution: [401, 120] }), baseline);
});

test('resource rows expose four keyed metric inputs and ignore unrelated metadata', () => {
  const base = {
    agents: [{ id: 'backend-engineer' }],
    jobs: [
      { jobId: 'job-1', agent: 'backend-engineer', status: 'running', verificationState: null, inputTokens: 0, outputTokens: 0 },
      { jobId: 'job-2', agent: 'backend-engineer', status: 'completed', verificationState: 'passed', inputTokens: 12, outputTokens: 8 },
    ],
    events: [{ seq: 1 }],
  };
  const rows = resourceRows(base);
  assert.deepEqual(rows.map(({ key }) => key), ['concurrency', 'events', 'verification', 'tokens']);
  assert.deepEqual(rows.map(({ value, base: count }) => [value, count]), [['1/1', 1], ['1', 1], ['100%', 1], ['已记录', 1]]);
  assert.equal(resourceFingerprint(base, { concurrency: [100, 28], events: [100, 28], verification: [100, 28], tokens: [100, 28] }), resourceFingerprint({ ...base, install: { changed: true }, lastUpdate: 'now' }, { concurrency: [100, 28], events: [100, 28], verification: [100, 28], tokens: [100, 28] }));
});

test('resource dirty keys isolate one changed metric and its dimensions', () => {
  const previous = {
    agents: [{ id: 'backend-engineer' }],
    jobs: [{ jobId: 'job-1', agent: 'backend-engineer', status: 'running' }],
    events: [{ seq: 1 }],
  };
  const dimensions = { concurrency: [100, 28], events: [100, 28], verification: [100, 28], tokens: [100, 28] };
  assert.deepEqual([...resourceDirtyKeys(previous, previous, dimensions, dimensions)], []);
  assert.deepEqual([...resourceDirtyKeys(previous, { ...previous, install: { changed: true } }, dimensions, dimensions)], []);
  assert.deepEqual([...resourceDirtyKeys(previous, { ...previous, events: [{ seq: 1 }, { seq: 2 }] }, dimensions, dimensions)], ['events']);
  assert.deepEqual([...resourceDirtyKeys(previous, previous, dimensions, { ...dimensions, tokens: [101, 28] })], ['tokens']);
});
test('uses a Set for the initial resource render helper contract', () => {
  const data = { agents: [{ id: 'a' }], jobs: [{ agent: 'a', status: 'running' }], events: [{ seq: 1 }] };
  const dirtyKeys = resourceDirtyKeys({}, data, {}, {});
  assert.equal(dirtyKeys instanceof Set, true);
  const row = { dataset: { resourceKey: 'concurrency' }, querySelector: () => ({}) };
  assert.doesNotThrow(() => patchResourceRows({ children: [], append() {} }, resourceRows(data), dirtyKeys, {
    createRow: () => row,
    updateRow: () => {},
    drawRow: () => {},
  }));
  assert.equal(dirtyKeys.has('concurrency'), true);
});

test('merges supplied stream metadata without mutating or losing stable job fields', () => {
  const previous = { jobId: 'job-1', status: 'running', phase: 'implementing', task: 'stable', sessionId: 'session', cwd: '/repo', heartbeat: 7 };
  const partial = { jobId: 'job-1', status: 'completed', phase: 'verifying', task: 'updated' };
  const result = mergeStreamJobMeta(previous, partial);
  assert.deepEqual(result, { ...previous, ...partial });
  assert.notEqual(result, previous);
  assert.deepEqual(previous, { jobId: 'job-1', status: 'running', phase: 'implementing', task: 'stable', sessionId: 'session', cwd: '/repo', heartbeat: 7 });
  assert.deepEqual(mergeStreamJobMeta(previous, { jobId: 'job-2', status: 'completed' }), previous);
  assert.deepEqual(mergeStreamJobMeta(previous, { jobId: 'job-1', status: null }), previous);
  assert.deepEqual(mergeStreamJobMeta(previous, null), previous);
});

test('reconnect state marks the first recovered meaningful snapshot as a baseline', () => {
  const reconnect = createReconnectState();
  assert.deepEqual(reconnect.nextSource('sse'), { source: 'sse', baseline: false });
  reconnect.onOpen();
  assert.deepEqual(reconnect.nextSource('sse'), { source: 'sse', baseline: false });
  reconnect.onError();
  reconnect.onOpen();
  assert.deepEqual(reconnect.peekSource('sse'), { source: 'recovery', baseline: true });
  assert.deepEqual(reconnect.peekSource('sse'), { source: 'recovery', baseline: true });
  reconnect.commitSource('sse');
  assert.deepEqual(reconnect.nextSource('sse'), { source: 'sse', baseline: false });
});

test('agent node records include derived job state in their fingerprint', () => {
  const agents = [{ id: 'backend-engineer', name: 'Backend Engineer', state: 'idle' }];
  const before = agentNodeRecords(agents, []);
  const after = agentNodeRecords(agents, [{ jobId: 'job-1', agent: 'backend-engineer', status: 'running', phase: 'implementing', task: 'Implement fix' }]);
  assert.deepEqual(before[0], { agent: agents[0], status: 'idle', phase: null, task: null, jobId: null });
  assert.deepEqual(after[0], { agent: agents[0], status: 'running', phase: 'implementing', task: 'Implement fix', jobId: 'job-1' });
  assert.notEqual(agentNodeFingerprint(before[0]), agentNodeFingerprint(after[0]));
});

test('meaningful dashboard changes ignore telemetry but detect KPI and entity changes', () => {
  const base = { kpis: { running: 1 }, agents: [{ id: 'a', state: 'running' }], jobs: [{ jobId: 'j', status: 'running' }], events: [{ seq: 1 }], alerts: [] };
  assert.equal(dashboardMeaningfulChange(base, { ...base, lastUpdate: 'later', heartbeat: 2, elapsedMs: 4000 }), false);
  assert.equal(dashboardMeaningfulChange(base, { ...base, kpis: { running: 2 } }), true);
  assert.equal(dashboardMeaningfulChange(base, { ...base, jobs: [{ jobId: 'j', status: 'completed' }] }), true);
  assert.equal(dashboardMeaningfulChange(base, { ...base, events: [{ seq: 1 }, { seq: 2 }] }), true);
});
test('scheduler uses the app meaningful-change predicate for every rendered KPI input', () => {
  const frames = [];
  const renders = [];
  const scheduler = createDashboardScheduler({
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelAnimationFrame: () => {},
    isHidden: () => false,
    isMeaningfulChange: dashboardMeaningfulChange,
    render: (data) => renders.push(data),
  });
  const base = {
    agents: [{ id: 'a', state: 'idle' }],
    jobs: [{ jobId: 'j', agent: 'a', status: 'completed', durationMs: 100, inputTokens: 10, outputTokens: 20, costUsd: 0.10 }],
    events: [],
    alerts: [],
  };
  let current = base;
  assert.equal(scheduler.schedule(createMotionSnapshot(current), 'bootstrap'), true);
  frames.shift()();
  for (const [field, value] of [['durationMs', 200], ['inputTokens', 11], ['outputTokens', 21], ['costUsd', 0.20]]) {
    current = { ...current, jobs: [{ ...current.jobs[0], [field]: value }] };
    assert.equal(scheduler.schedule(createMotionSnapshot(current), 'sse'), true, `${field} should schedule a render`);
    frames.shift()();
  }
  const telemetry = { ...current, jobs: [{ ...current.jobs[0], elapsedMs: 5000, updatedAt: 'later', heartbeat: 3 }] };
  assert.equal(scheduler.schedule(createMotionSnapshot(telemetry), 'sse'), false);
  for (const field of ['elapsedMs', 'updatedAt', 'heartbeat']) {
    const changedTelemetry = { ...current, jobs: [{ ...current.jobs[0], [field]: field === 'elapsedMs' ? 6000 : field === 'updatedAt' ? 'later-again' : 4 }] };
    assert.equal(scheduler.schedule(createMotionSnapshot(changedTelemetry), 'sse'), false, `${field} should not schedule a render`);
  }
  assert.equal(renders.length, 5);
});
test('uses injected document visibility and cancels a pending frame', () => {
  const hiddenDocument = { hidden: true };
  assert.equal(isDocumentHidden(hiddenDocument), true);
  assert.equal(isDocumentHidden({ hidden: false }), false);
  const frames = [];
  const cancelled = [];
  const scheduler = createDashboardScheduler({
    requestAnimationFrame: (callback) => { frames.push(callback); return 42; },
    cancelAnimationFrame: (id) => cancelled.push(id),
    isHidden: () => false,
    render: () => {},
  });
  scheduler.schedule({ version: 1 }, 'poll');
  scheduler.cancel();
  assert.deepEqual(cancelled, [42]);
  assert.equal(frames.length, 1);
});
