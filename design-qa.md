# Design QA: 环形智能体星图

source visual truth path: `/var/folders/3z/7z0zwx0j4z3brkkcwq8cjkg00000gn/T/codex-clipboard-ed3c7f1b-8a86-4659-90fd-a4570cdb2c34.png`
implementation screenshot path: `/Users/macxm/service/Claude/codex-plugin-claude-agents/.qa-screenshots/star-map-desktop-1536x1024.png`
comparison input path: `/Users/macxm/service/Claude/codex-plugin-claude-agents/.qa-screenshots/star-map-comparison.png`
viewport: 1536x1024 CSS pixels
state: live dashboard with historical jobs loaded; no task-dispatch entry shown

## Evidence

- Full-view comparison: `star-map-comparison.png` places the supplied smart-screen reference and the rendered star-map dashboard side by side at the same 1536x1024 viewport.
- Focused desktop evidence: `star-map-desktop-final.png` at 1280x720 verifies the compact command-center layout, fixed status bar, resource telemetry, and complete `DevOps/SRE工程师` label.
- Focused mobile evidence: `star-map-mobile-390-constellation.png` at 390x844 shows the constellation after scrolling to it; all eight nodes stay within the canvas and the long DevOps label wraps to two lines.
- Settings evidence: `star-map-install.png` shows the settings center's plugin-install tab with Codex, marketplace, and plugin states plus the update action.
- Primary interactions tested: opened and closed settings; switched between agent parameters and plugin installation; opened a backend agent session from the constellation; switched execution, tools, files, and checks tabs; closed the session modal; verified historical recent-task rows open the same session view.
- Browser console: no errors or warnings were reported by the Playwright browser.
- Runtime checks: `node --check plugins/claude-code-agents/dashboard/app.js` passed. The repository test suite had already passed in the preceding QA run; the final rerun reached the MCP browser-capability tests and was stopped after prolonged silence rather than leaving a background process running.

## Fidelity Review

- Fonts and typography: the implementation uses the existing system sans stack, compact telemetry labels, tabular KPI values, and readable Chinese hierarchy. Long role names wrap only where needed; `DevOps/SRE工程师` no longer clips at tested desktop and mobile sizes.
- Spacing and layout rhythm: the 3-column desktop grid preserves the reference's dense command-center rhythm. Resource rows are 32px high so four samples stay inside the panel at 1280x720. The desktop footer remains visible, while mobile content scrolls vertically without page-level horizontal overflow.
- Colors and visual tokens: graphite surfaces, cyan active states, green success/health states, amber queue/resource emphasis, red failure states, and restrained glow effects are consistently tokenized in `styles.css`.
- Image quality and asset fidelity: the implementation uses the generated raster assets `command-ambient.png`, `orchestration-core.png`, and `agent-role-atlas.png` for the ambient shell, orchestration core, and role icons. The central globe/orbit treatment is an actual image asset with CSS animation layered above it, not a placeholder drawing.
- Copy and content: the dashboard is self-contained product UI copy. Task initiation is intentionally absent from the screen; agent parameters and plugin installation live behind 设置, while conversation details appear only after selecting a node or recent task.
- Accessibility and behavior: native buttons, selects, inputs, and textareas are used; focus-visible outlines exist; modal close and Escape handling work; live status and modal regions expose semantic labels.

## Comparison History

### Iteration 1: resource panel density

- Finding: [P2] At 1280x720 the fourth resource row extended below the 184px panel and visually met the next panel.
- Fix: reduced resource rows from 40px to 32px, rings from 36px to 32px, and sparkline height from 36px to 28px.
- Post-fix evidence: `star-map-desktop-final.png`; all four rows end at 291.8px inside the panel bottom at 304.3px.

### Iteration 2: long role label

- Finding: [P2] `DevOps/SRE工程师` was ellipsized in narrow desktop and wide desktop states.
- Fix: widened sub-1420px agent cards to 158px and allowed this role label to wrap within a two-line, bounded title.
- Post-fix evidence: desktop DOM measurement reports `scrollWidth === clientWidth`; mobile screenshot shows the two-line label without overlap.

### Iteration 3: oversized historical summary

- Finding: [P2] An old result containing 6,973 unbroken characters produced a 46,087px summary `scrollWidth` in the session modal.
- Fix: cap rendered summaries at 320 characters and apply `overflow-wrap: anywhere` plus hidden overflow to the overview copy.
- Post-fix evidence: the same fixture now renders 320 characters with `scrollWidth === clientWidth === 696px`.

### Iteration 4: mobile constellation bounds

- Finding: [P2] At 390px, the original 13%/87% side-node positions clipped the security and frontend cards outside the 359px constellation canvas.
- Fix: add a max-480px position map for side nodes; preserve the desktop positions at larger widths.
- Post-fix evidence: all mobile node boxes remain between x=19.4px and x=359.6px; page `scrollWidth` remains 379px with no horizontal overflow.

### Iteration 5: session modal horizontal overflow

- Finding: [P2] At 2048x1152, a long historical task/event string expanded the session modal's implicit grid track to 1614px. Header, tabs, event rows, and footer began at x=-1px even though the modal itself was only 1180px wide.
- Fix: constrain `.session-modal` to a `minmax(0, 1fr)` column, set all direct modal regions to `min-width: 0` and `max-width: 100%`, and give `.event-row` an explicit `width: 100%`.
- Post-fix evidence: `.qa-screenshots/session-modal-fixed-2048.png` and `.qa-screenshots/session-modal-fixed-mobile-390.png`; at 2048px all modal regions measure 1178px, and at 390px all regions measure 352px with no horizontal overflow.

## Implementation Checklist

- [x] Reference image and same-viewport implementation screenshot captured.
- [x] Full-view comparison input created and reviewed.
- [x] Desktop layout checked at 1280x720 and 1536x1024.
- [x] Mobile constellation checked at 390x844.
- [x] Settings parameter and plugin-install states checked.
- [x] Session modal open/close and all four event tabs checked.
- [x] Resource overflow, role-label wrapping, summary overflow, and mobile clipping fixed.
- [x] Session modal grid track no longer expands from long historical text.
- [x] Browser console checked with no errors or warnings.
- [x] JavaScript syntax check passed.

final result: passed
