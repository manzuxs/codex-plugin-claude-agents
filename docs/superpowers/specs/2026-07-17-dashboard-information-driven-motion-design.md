# Dashboard Information-Driven Motion Design

Date: 2026-07-17
Status: Approved design
Scope: `plugins/claude-code-agents/dashboard`

## Objective

Improve the command-center dashboard with restrained motion that explains real state changes. Ambient motion should provide low-level continuity, while visible emphasis should be reserved for new events, job transitions, agent transitions, KPI deltas, alerts, and user-triggered overlays.

The dashboard remains a monitoring, configuration, and session-inspection surface. Task creation, cancellation, and deletion controls remain intentionally absent. Existing server APIs may remain internal and are outside this work.

## Design Principles

1. Motion must communicate a real change or preserve spatial context.
2. Initial rendering, historical hydration, and repeated polling data must not appear as new activity.
3. Persistent ambient motion must be quieter than transient status feedback.
4. High-frequency updates must be coalesced rather than queued.
5. Reduced-motion users receive immediate semantic color and text changes without movement.
6. The implementation remains framework-free and uses the existing dashboard structure.

## Motion Hierarchy

### Ambient Layer

- Keep the two orchestration orbits rotating in opposite directions at their existing 34-second and 42-second periods.
- Reduce their visual intensity so they do not compete with live status feedback.
- Pause ambient animation while the document is hidden.
- Keep the orchestration core visually alive with a low-intensity treatment, but do not use a strong continuous pulse.

### Task-Link Layer

Play one directional light pass from the orchestration core to the affected agent when:

- a job enters `starting` or `running`;
- the selected job changes execution phase and that phase can be derived from a new event;
- a job enters a terminal state.

Each pass lasts 700-900ms. Repeated polling of the same job and state does not replay it. Multiple changed agents may animate concurrently, up to the number of visible agent nodes. The link is not animated continuously while a job runs.

### Agent-State Layer

On a genuine state transition, play one ring expansion around the affected node:

- starting/running: cyan-green;
- completed: green;
- queued: amber;
- failed/blocked: red.

Running nodes retain a low-intensity active indicator after the one-shot transition. Replace continuously animated `box-shadow` with a pseudo-element using `transform` and `opacity` so the compositor can handle the effect more efficiently. Terminal states settle into a stable static appearance after confirmation.

### Data Layer

- KPI changes receive a 250-400ms semantic text or background emphasis. Do not animate digits individually.
- Load bars move to their new width over 220-260ms while labels and values remain geometrically stable.
- Charts interpolate only newly appended points. Initial load, full data replacement, visibility restoration, and resize draw directly to the latest state.
- Ranking order does not animate in this iteration; only bar lengths transition.
- A newly introduced alert receives one emphasis cycle. Existing alerts never blink continuously.

### Content And Overlay Layer

- Genuine new SSE event rows enter over 120-160ms with opacity and 3-5px upward movement.
- Historical event hydration, polling recovery, and full list reconstruction do not use entry motion.
- Settings and session dialogs use 140-180ms backdrop opacity and 4-8px panel movement for entry and exit.
- Dialog opening continues to focus the first relevant control, and closing restores focus to the opener.
- Toasts have explicit entry, dwell, and exit phases. Remove a toast only after its exit transition completes.
- Interactive buttons, rows, and nodes use a consistent 100-140ms transition without changing layout dimensions.

## Update Architecture

Add a small state-difference and motion-scheduling layer to the existing vanilla JavaScript implementation. Do not introduce a framework or animation dependency.

Track the previous values needed to distinguish real changes:

- KPI values;
- agent states and associated job identities;
- job status and execution phase;
- latest event sequence;
- alert identities;
- chart data and dimensions.

Classify update sources as:

- `bootstrap`: first load and complete state hydration;
- `poll`: periodic snapshot refresh;
- `sse`: live event and job progression;
- `interaction`: user selection, filtering, and overlay actions.

The first render establishes a baseline and plays no business-state animation. Later renders calculate differences before updating the DOM. Temporary motion classes are applied only to affected elements and removed on `animationend`, with a bounded timeout fallback. A newer change may cancel and restart the same element's one-shot effect; effects must not form a queue.

## Rendering Boundaries

This iteration performs targeted rendering improvements rather than a full component rewrite:

- Reuse agent-node DOM elements by stable agent ID instead of rebuilding all nodes on every refresh.
- Patch changed KPIs, load bars, alerts, and event rows locally; do not rebuild their containing lists when identities and ordering are unchanged.
- Ignore empty SSE payloads that contain no new events or state changes.
- Reduce redundant polling-driven visual updates while SSE is healthy, without removing snapshot recovery.
- Coalesce high-frequency work into one `requestAnimationFrame` render.
- Redraw Canvas charts only when their data or dimensions change.
- Throttle resize handling and perform at most one draw per animation frame.
- When the page returns from the background, synchronize directly to current state without replaying accumulated effects.

## CSS And Markup Strategy

Primary implementation files:

- `dashboard/app.js`: difference calculation, update-source classification, local DOM updates, scheduling, and motion triggers.
- `dashboard/styles.css`: motion variables, transition rules, keyframes, temporary semantic classes, visibility pausing, and reduced-motion behavior.
- `dashboard/index.html`: add only stable link or status mounting elements that cannot be generated safely by the existing structure.

Do not activate `layout-overrides.css`. Its current inactive rules are not a dependency for this design.

Prefer `transform` and `opacity` for movement and transient feedback. Avoid animating layout properties and continuously animated shadows. Do not add `will-change` globally; apply it only where a short-lived effect has demonstrated benefit.

## Accessibility And Lifecycle

- Preserve the existing `prefers-reduced-motion` support.
- Under reduced motion, disable orbit rotation, task-link travel, ring expansion, and positional transitions. Apply status colors and content updates immediately.
- Pause nonessential animation when `document.hidden` is true.
- Preserve visible keyboard focus and do not use motion as the only status indicator.
- Maintain `aria-live="polite"` behavior for toast messages.
- Add a dialog focus trap while preserving Escape, backdrop dismissal, and focus restoration.

## Error And Recovery Behavior

- A malformed or incomplete update must not clear the previous stable visual state.
- Event-source reconnection must hydrate current state without treating recovered history as new events.
- Animation cleanup must use bounded fallbacks so detached nodes or missed events cannot leave stale motion classes.
- Canvas interpolation must be cancellable; a newer dataset replaces the current target rather than waiting for an older animation.
- Session failure, disconnected, queued, and terminal states must update both text and visual status instead of retaining the default green indicator.

## Acceptance Criteria

### Functional Motion

- Initial load does not cause collective KPI, node, alert, or event-entry animation.
- A repeated identical polling snapshot triggers no state-transition motion.
- A new SSE event triggers exactly one event-entry effect.
- A genuine agent or job transition triggers exactly one node ring and one applicable task-link pass.
- KPI, load-bar, chart-point, and alert changes each trigger only their designated feedback.
- Background restoration displays current state without replaying historical changes.

### Performance

- Empty SSE messages cause no dashboard DOM patch or Canvas redraw.
- Multiple updates received within one frame are rendered together.
- Canvas charts redraw only after relevant data or dimension changes.
- Resize work is throttled to an animation frame.
- A 10-minute active-session run shows no growing animation queue, unbounded timers, or increasing transient DOM-node count.
- Ambient and state effects remain smooth at supported desktop and mobile sizes.

### Responsive And Visual

Validate at:

- 1280x720;
- 1536x1024;
- 768x800;
- 390x844.

At each viewport:

- no horizontal overflow;
- no text or control overlap;
- no animation changes the stable dimensions of panels, buttons, nodes, counters, or charts;
- task-link effects remain aligned between the core and target nodes;
- modal and toast transitions remain within the viewport.

### Accessibility

- With `prefers-reduced-motion: reduce`, there is no orbit rotation, task-link movement, ring expansion, or positional transition.
- State remains identifiable through text and color after motion is disabled.
- Keyboard focus remains visible throughout interaction.
- Dialog opening, trapping, Escape dismissal, and focus restoration work without regression.

### Verification

- Existing Node test suite passes.
- Add focused tests for difference detection, first-render suppression, update-source classification, and repeated-state suppression.
- Browser acceptance verifies desktop, tablet, and mobile layouts, console errors and warnings, hidden-page pause behavior, reduced-motion behavior, and event/state trigger counts.
- Retain final screenshots and a concise acceptance record against the final commit or a durable CI artifact.

## Out Of Scope

- Digit-flip counters.
- Full-screen scan lines, particle fields, floating cards, or decorative motion unrelated to data.
- Continuous task-link movement.
- High-frequency ranking reorder animation.
- GSAP or another animation library.
- A frontend-framework migration.
- A complete rewrite of the dashboard renderer.
- Task creation, cancellation, or deletion controls.
