# Dashboard Information-Driven Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add restrained, data-driven motion to the existing vanilla dashboard so real job, agent, event, KPI, alert, overlay, and visibility changes are legible without adding continuous visual noise or excessive redraw work.

**Architecture:** Keep the current HTML/CSS/vanilla-JavaScript dashboard. Add a small pure state-diff layer in `app.js`, a frame-coalesced render scheduler, and targeted motion classes in `styles.css`. Preserve the monitoring/configuration/session-inspection scope; task creation, cancellation, and deletion remain absent from the UI. Do not activate `layout-overrides.css` or introduce a framework/animation library.

**Tech Stack:** Native browser JavaScript, CSS animations/transitions, Canvas 2D charts, EventSource/SSE, Node built-in test runner, agent-browser for browser acceptance.

---

## File Map

- Modify `plugins/claude-code-agents/dashboard/app.js`: update-source classification, previous-state snapshots, meaningful-change detection, frame-coalesced rendering, targeted DOM updates, event/agent/KPI/alert motion triggers, visibility and resize scheduling.
- Modify `plugins/claude-code-agents/dashboard/styles.css`: motion tokens, semantic one-shot keyframes, event/KPI/modal/toast transitions, compositor-friendly active-node treatment, visibility and reduced-motion rules.
- Modify `plugins/claude-code-agents/dashboard/index.html`: add the stable `data-agent-id` attributes and topology link/overlay hooks required by Task 4; preserve current controls and omit task controls.
- Modify `tests/mcp.test.mjs` or create `tests/dashboard-motion.test.mjs`: test pure state-diff/scheduling helpers without requiring a browser or live server.
- Create `docs/superpowers/acceptance/2026-07-17-dashboard-information-driven-motion-acceptance.md`: record final browser matrix, console result, reduced-motion result, and screenshots after implementation.

## Implementation Constraints

- First render establishes a baseline and emits no business-state animation.
- Repeated identical poll/SSE snapshots emit no DOM patch and no motion trigger.
- New event entry motion is allowed only for genuinely new event sequence numbers received from live SSE, never for historical hydration or recovery.
- State transitions are keyed by stable agent/job identity plus previous status/phase.
- Motion class cleanup must use `animationend` plus a bounded timeout fallback; effects cannot accumulate.
- Prefer `transform` and `opacity`; do not animate layout dimensions or continuous `box-shadow`.
- At most one scheduled dashboard render runs per animation frame.
- `prefers-reduced-motion: reduce` disables rotation, travel, ring expansion, and positional transitions while preserving semantic colors/text.
- `document.hidden` pauses ambient/nonessential animation and resynchronizes directly on return without replaying history.
- Do not expose task run/cancel/delete buttons or links.

### Task 1: Add Pure Motion-Diff Helpers And Regression Tests

**Files:**
- Create: `tests/dashboard-motion.test.mjs`
- Modify: `plugins/claude-code-agents/dashboard/app.js`

- [ ] **Step 1: Add failing tests for first-render suppression and repeated snapshots**

Export testable pure helpers from `app.js` without changing browser behavior, or place equivalent helpers in a browser-neutral module imported by `app.js`. Test the following contract:

```js
const baseline = createMotionSnapshot();
assert.deepEqual(diffDashboardMotion(baseline, snapshot), {
  initialized: false,
  kpiChanges: [],
  agentTransitions: [],
  newEvents: [],
  alertChanges: [],
  linkTransitions: []
});

const next = createMotionSnapshot(snapshot);
assert.deepEqual(diffDashboardMotion(next, snapshot), {
  initialized: true,
  kpiChanges: [],
  agentTransitions: [],
  newEvents: [],
  alertChanges: [],
  linkTransitions: []
});
```

Include cases for:

- a KPI value changing once;
- an agent changing from `idle` to `running` once;
- the same running snapshot repeating with no transition;
- a new SSE event sequence being detected once;
- historical events being excluded when `source` is `bootstrap` or `recovery`;
- a terminal job transition generating one link transition;
- an alert identity being added once and not replayed on later polls.

- [ ] **Step 2: Run only the new test file and verify it fails**

Run:

```bash
node --test tests/dashboard-motion.test.mjs
```

Expected: FAIL because the pure helper contract is not implemented.

- [ ] **Step 3: Implement the minimal browser-neutral snapshot and diff API**

Define stable normalized records using existing dashboard data shapes. The public helper contract must be:

```js
export function createMotionSnapshot(data = null) { /* returns immutable baseline shape */ }
export function diffDashboardMotion(previous, current, source = "poll") { /* returns diff */ }
```

Use stable keys (`agent.id`, `job.id`, `event.seq`, `alert.id` or the existing equivalent). Return arrays of changed records, not booleans that force the renderer to rediscover context. Treat `bootstrap` and `recovery` as baseline-only sources for event-entry effects. Do not mutate either input snapshot.

- [ ] **Step 4: Run the focused tests and then the existing suite**

Run:

```bash
node --test tests/dashboard-motion.test.mjs
npm test
```

Expected: the focused tests pass and the existing suite remains green.

- [ ] **Step 5: Commit the pure diff layer**

```bash
git add tests/dashboard-motion.test.mjs plugins/claude-code-agents/dashboard/app.js
git commit -m "feat: add dashboard motion diff state"
```

### Task 2: Add Motion Tokens And Semantic CSS Effects

**Files:**
- Modify: `plugins/claude-code-agents/dashboard/styles.css`
- Modify: `plugins/claude-code-agents/dashboard/index.html` only if a stable link-layer hook is required

- [ ] **Step 1: Add CSS selectors/tests fixtures for each motion state**

Before implementation, add DOM-oriented assertions to `tests/dashboard-motion.test.mjs` or a static CSS contract test that verifies the stylesheet contains selectors/keyframes for:

- `.motion-event-enter`;
- `.motion-kpi-change`;
- `.motion-status-ring`;
- `.motion-link-travel`;
- `.motion-alert-enter`;
- `.motion-modal-enter` and `.motion-modal-exit`;
- `.motion-toast-enter` and `.motion-toast-exit`;
- `[data-status="failed"]` and `[data-status="disconnected"]` semantic session states;
- a reduced-motion override for all travel/positional effects.

- [ ] **Step 2: Run the focused CSS contract test and verify it fails**

Run:

```bash
node --test tests/dashboard-motion.test.mjs
```

Expected: FAIL for missing motion selectors/keyframes.

- [ ] **Step 3: Implement the CSS motion system**

Add scoped motion variables and keyframes with these bounds:

```css
:root {
  --motion-fast: 120ms;
  --motion-enter: 160ms;
  --motion-overlay: 180ms;
  --motion-status: 800ms;
  --motion-data: 240ms;
}

.motion-event-enter,
.motion-alert-enter { animation: motion-enter-up var(--motion-enter) ease-out both; }
.motion-kpi-change { animation: motion-kpi-flash 320ms ease-out both; }
.motion-status-ring::after { animation: motion-status-ring var(--motion-status) ease-out both; }
.motion-link-travel::after { animation: motion-link-travel 800ms ease-out both; }
```

Use pseudo-elements with `transform`/`opacity` for active-node pulse and one-shot rings. Add modal/toast opacity plus 4-8px transform transitions. Add state selectors so disconnected/failed session indicators are not green by default. Keep orbit rotation at 34s/42s, reduce intensity, and pause it under a document-level hidden class. Add `@media (prefers-reduced-motion: reduce)` that sets animation durations to `1ms`, removes transform travel and orbit animation, and preserves color/status changes. Do not add decorative scan lines, particles, floating cards, or continuous link flow.

- [ ] **Step 4: Run CSS contract tests and syntax/hygiene checks**

Run:

```bash
node --test tests/dashboard-motion.test.mjs
git diff --check
```

Expected: pass with no whitespace errors.

- [ ] **Step 5: Commit the CSS motion primitives**

```bash
git add plugins/claude-code-agents/dashboard/styles.css plugins/claude-code-agents/dashboard/index.html tests/dashboard-motion.test.mjs
git commit -m "feat: add semantic dashboard motion styles"
```

### Task 3: Coalesce Refreshes And Patch Meaningful Changes

**Files:**
- Modify: `plugins/claude-code-agents/dashboard/app.js`
- Modify: `tests/dashboard-motion.test.mjs`

- [ ] **Step 1: Add failing scheduler tests**

Test a fake `requestAnimationFrame` implementation and assert:

- five `scheduleRender()` calls before the frame produce one render;
- empty SSE payloads do not schedule a render;
- a changed snapshot schedules exactly one frame;
- a hidden document suppresses ambient redraw and stores the latest snapshot;
- visible restoration renders current state once without event-entry effects.

Use dependency injection for `requestAnimationFrame`, `cancelAnimationFrame`, and `document.hidden` so tests remain Node-only.

- [ ] **Step 2: Run the scheduler tests and verify failure**

```bash
node --test tests/dashboard-motion.test.mjs
```

Expected: FAIL because the scheduler is not present.

- [ ] **Step 3: Implement the frame-coalesced scheduler**

Add a scheduler around the existing render path:

```js
function scheduleDashboardRender(data, source) {
  pendingRender = { data, source };
  if (frameId !== null) return;
  frameId = requestAnimationFrame(() => {
    frameId = null;
    const render = pendingRender;
    pendingRender = null;
    if (!render || (document.hidden && render.source !== "interaction")) return;
    renderDashboard(render.data, render.source);
  });
}
```

Merge successive updates into the newest snapshot while preserving the strongest source (`interaction` > `sse` > `poll` > `recovery` > `bootstrap`). In SSE handlers, compare event sequence and job metadata first; return without scheduling when no meaningful change exists. Add `visibilitychange` handling: add/remove a root hidden state, pause nonessential animation, and schedule a baseline resync on visibility restoration.

- [ ] **Step 4: Convert full redraws to stable-key patching**

Update agent nodes, event rows, KPI values, load bars, alert rows, and status labels by stable identity. Reuse unchanged elements. Do not rebuild containing lists when identities/order are unchanged. Keep the existing read-only control set unchanged. Ensure session status classes reflect `connected`, `disconnected`, `failed`, `queued`, and terminal states.

- [ ] **Step 5: Throttle resize and chart redraws**

Route resize through one frame-coalesced callback. Cache canvas dimensions and chart data fingerprints; skip drawing when neither changed. Replace any direct redraw from every SSE message with a dirty-chart flag consumed by the scheduled frame. Interpolation targets must be replaced by newer data rather than queued.

- [ ] **Step 6: Run focused and full tests**

```bash
node --test tests/dashboard-motion.test.mjs
npm test
node --check plugins/claude-code-agents/dashboard/app.js
```

Expected: all focused tests and all existing tests pass; syntax check exits 0.

- [ ] **Step 7: Commit render scheduling and patching**

```bash
git add plugins/claude-code-agents/dashboard/app.js tests/dashboard-motion.test.mjs
git commit -m "perf: coalesce dashboard live updates"
```

### Task 4: Wire Event-Driven Motion To Dashboard Regions

**Files:**
- Modify: `plugins/claude-code-agents/dashboard/app.js`
- Modify: `plugins/claude-code-agents/dashboard/styles.css`
- Modify: `plugins/claude-code-agents/dashboard/index.html` to add the topology link hooks required by Task 4.
- Modify: `tests/dashboard-motion.test.mjs`

- [ ] **Step 1: Add failing trigger-count tests**

Use a fake DOM/class-list recorder and assert:

- first render applies zero business motion classes;
- one agent transition applies one status-ring class and one link-travel class;
- repeated same state applies neither class;
- one new event applies one event-enter class;
- one changed KPI applies one KPI class;
- one new alert applies one alert-enter class;
- a newer transition replaces an in-flight effect rather than creating a second queued effect.

- [ ] **Step 2: Run the trigger tests and verify failure**

```bash
node --test tests/dashboard-motion.test.mjs
```

Expected: FAIL because render triggers are not wired.

- [ ] **Step 3: Wire state transitions to stable DOM targets**

After `diffDashboardMotion()` returns a diff, apply classes only to affected elements:

- `data-agent-id` node for status ring and active state;
- topology link/overlay hook for core-to-agent travel;
- event row keyed by event sequence;
- KPI element keyed by metric name;
- alert row keyed by alert identity.

Implement `triggerMotion(element, className, duration)` that removes any existing effect class, forces only the minimum necessary restart, adds the class, and cleans it on `animationend` or bounded timeout. Store cleanup handles per element to prevent timer accumulation. Use `aria-live` and text/status updates independently of motion.

- [ ] **Step 4: Wire modal and Toast lifecycle transitions**

Replace immediate modal/toast removal with enter/exit classes and a bounded exit callback. Preserve current Escape, backdrop dismissal, focus restoration, and add a focus trap for open dialogs. Do not add any task-action controls.

- [ ] **Step 5: Implement hidden-page and reduced-motion behavior**

Pause orbit and nonessential effects with a root hidden class. On reduced motion, skip `triggerMotion()` for transform/travel effects but still apply semantic status classes and content updates. Confirm a state change received while hidden is reflected after restoration without entry animation.

- [ ] **Step 6: Run tests and static checks**

```bash
node --test tests/dashboard-motion.test.mjs
npm test
node --check plugins/claude-code-agents/dashboard/app.js
```

Expected: all tests pass and app syntax is valid.

- [ ] **Step 7: Commit event-driven effects**

```bash
git add plugins/claude-code-agents/dashboard/app.js plugins/claude-code-agents/dashboard/styles.css plugins/claude-code-agents/dashboard/index.html tests/dashboard-motion.test.mjs
git commit -m "feat: animate meaningful dashboard state changes"
```

### Task 5: Browser Acceptance And Evidence

**Files:**
- Create: `docs/superpowers/acceptance/2026-07-17-dashboard-information-driven-motion-acceptance.md`
- Create: `.qa-screenshots/dashboard-motion-desktop.png`
- Create: `.qa-screenshots/dashboard-motion-tablet.png`
- Create: `.qa-screenshots/dashboard-motion-mobile.png`
- Modify: `package.json` only if an existing local browser command needs a named script; do not add a dependency unless the repository already uses it.

- [ ] **Step 1: Start the local dashboard server**

Run:

```bash
node plugins/claude-code-agents/server/cli.mjs dashboard
```

Record the printed local URL. Keep this process running for browser validation.

- [ ] **Step 2: Validate desktop and responsive layouts**

Use named agent-browser session `dashboard-motion-qa` and capture at 1280x720, 1536x1024, 768x800, and 390x844. For each viewport verify:

- title and primary sections render;
- no horizontal overflow (`document.documentElement.scrollWidth <= innerWidth`);
- no text/control overlap;
- only the intended read-only controls are present;
- all committed image assets return 200 and have nonzero natural dimensions;
- no console errors or warnings.

- [ ] **Step 3: Validate motion trigger semantics**

With a deterministic fixture or existing session stream, verify and record:

- initial load has no business motion classes;
- repeated identical poll produces no class changes;
- new SSE event enters once;
- agent/job transition triggers exactly one status ring and one link travel;
- changed KPI gets one highlight;
- new alert gets one emphasis;
- modal and Toast enter/exit cleanly;
- hidden-page restoration does not replay history.

If the existing dashboard data cannot produce a deterministic transition, add a browser-only debug fixture guarded from production UI, or use DOM instrumentation in the acceptance command; do not fabricate a passing result.

- [ ] **Step 4: Validate reduced motion and keyboard behavior**

Set `prefers-reduced-motion: reduce` and confirm no orbit rotation, travel, ring expansion, or positional transition is active while semantic statuses remain visible. Open settings and session dialogs by keyboard, verify focus enters the dialog, cycles within it, Escape closes it, and focus returns to the opener.

- [ ] **Step 5: Run the final verification commands**

```bash
npm test
npm run doctor
node --check plugins/claude-code-agents/dashboard/app.js
git diff --check origin/main...HEAD
git status --short
```

Expected: tests pass, doctor reports `"ok": true`, syntax and diff checks exit 0. Report any browser limitation or console warning exactly instead of claiming a clean run.

- [ ] **Step 6: Write the acceptance record**

Record the URL, commit hash, viewport results, asset responses, console output summary, reduced-motion result, keyboard result, and screenshot paths in the acceptance markdown. Clearly separate passed checks from skipped checks and known limitations.

- [ ] **Step 7: Commit the acceptance evidence**

Before committing, inspect every generated file and remove only verified debris created by this task. Do not delete pre-existing user files or untracked evidence unrelated to this implementation.

```bash
git add docs/superpowers/acceptance/2026-07-17-dashboard-information-driven-motion-acceptance.md .qa-screenshots
git commit -m "test: record dashboard motion browser acceptance"
```

## Final Review Checklist

- [ ] All plan tasks are complete and each task has a focused commit.
- [ ] `npm test` passes after the final task.
- [ ] `npm run doctor` reports `ok: true`.
- [ ] `node --check plugins/claude-code-agents/dashboard/app.js` passes.
- [ ] `git diff --check origin/main...HEAD` passes.
- [ ] Browser evidence covers all four viewports, reduced motion, keyboard focus, assets, and console output.
- [ ] No task run/cancel/delete UI was added.
- [ ] No `layout-overrides.css` dependency or animation library was introduced.
- [ ] Final report distinguishes committed implementation, committed evidence, and any intentionally retained internal server APIs.
