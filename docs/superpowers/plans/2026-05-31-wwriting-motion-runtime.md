# WWriting Motion Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local GSAP-backed Motion Runtime that makes WWriting status changes easier to understand without breaking clickability, focus, or reduced-motion behavior.

**Architecture:** Add a small browser-side `motion-runtime.js` facade and a local `src/app-shell/vendor/gsap.js` entry generated from the npm `gsap` package. Existing app-shell rendering remains authoritative for DOM, aria, `inert`, and business state; the runtime only applies short transform/opacity animations after DOM state is correct.

**Tech Stack:** Electron, vanilla browser ESM, Node.js `node:test`, local `gsap`, existing app-shell static server.

---

## File Structure

- Create: `src/app-shell/motion-runtime.js`  
  Owns GSAP import, motion tokens, reduced-motion detection, safe animation wrappers, and semantic animation APIs.
- Create: `src/app-shell/vendor/gsap.js`  
  Local browser-loadable GSAP vendor entry derived from `node_modules/gsap/dist/gsap.js`.
- Modify: `package.json` and `package-lock.json`  
  Add the `gsap` runtime dependency.
- Modify: `src/app-shell/app.js`  
  Import `motion`, preserve previous activity/badge summaries, and call runtime after existing render operations.
- Modify: `src/app-shell/styles.css`  
  Add minimal motion-safe CSS hooks only where needed, without replacing the visual system.
- Modify: `tests/app-server-probe.test.mjs`  
  Verify vendor module serving and confirm `node_modules` is not exposed.
- Create: `tests/motion-runtime.test.mjs`  
  Unit-test reduced-motion setup, diff helpers, and no-op safety paths.
- Modify: `scripts/verify-app-shell.mjs`  
  Assert `motion-runtime.js` and vendor loading hooks exist in static assets.
- Modify: `scripts/verify-app-clickability.cjs`  
  Assert the Electron page imports motion runtime without console module errors and failure-card interactions remain clickable.

## Execution Preconditions

- Before executing any task, run `git status --short`.
- Preferred execution environment: a fresh worktree or branch from commit `64ef722` so current local dirty files are not mixed into Motion Runtime commits.
- If executing in the current dirty workspace, first inspect `git diff -- README.md scripts/verify-app-clickability.cjs src/core/app-server.mjs tests/app-server-probe.test.mjs CLAUDE.md`. Treat those changes as pre-existing user work.
- Do not revert, overwrite, or commit pre-existing user changes.
- For any task that touches a pre-dirty file, use `git diff -- <file>` before and after editing, then stage only Motion Runtime hunks with `git add -p`. If hunk-level staging is ambiguous, skip the task commit and report the conflict instead of committing unrelated changes.
- Commit commands below assume the implementation workspace is clean except for the current task's intended files. In a dirty workspace, replace broad `git add <file>` commands with `git add -p`.

## Task 1: Install GSAP And Lock Local Vendor Loading

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/app-shell/vendor/gsap.js`
- Modify: `tests/app-server-probe.test.mjs`
- Modify: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: Write the failing static vendor tests**

Add this test near the existing static shell tests in `tests/app-server-probe.test.mjs`:

```js
test("static shell serves local GSAP vendor entry but not node_modules", async () => {
  const { server, port } = await setupServer();
  try {
    const vendor = await fetch(`http://127.0.0.1:${port}/vendor/gsap.js`);
    const vendorBody = await vendor.text();
    const nodeModules = await fetch(`http://127.0.0.1:${port}/node_modules/gsap/dist/gsap.js`);

    assert.equal(vendor.status, 200);
    assert.match(vendor.headers.get("content-type") ?? "", /^text\/javascript\b/u);
    assert.match(vendorBody, /export const gsap/u);
    assert.equal(nodeModules.status, 404);
  } finally {
    await closeServer(server);
  }
});
```

Add these assertions after the existing JS/CSS fetch checks in `scripts/verify-app-shell.mjs`:

```js
const [motionRuntime, gsapVendor] = await Promise.all([
  fetchText(`http://127.0.0.1:${port}/motion-runtime.js`),
  fetchText(`http://127.0.0.1:${port}/vendor/gsap.js`)
]);
assert.ok(motionRuntime.includes("export const motion"));
assert.ok(motionRuntime.includes("./vendor/gsap.js"));
assert.ok(gsapVendor.includes("export const gsap"));
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm test
```

Expected: FAIL because the new app-server probe for `/vendor/gsap.js` returns 404.

- [ ] **Step 3: Install GSAP**

Run:

```powershell
npm install gsap
```

Expected: `package.json` and `package-lock.json` include `gsap`.

- [ ] **Step 4: Create the local vendor entry**

Create `src/app-shell/vendor/`, copy `node_modules/gsap/dist/gsap.js` to `src/app-shell/vendor/gsap.js`, then append these lines to the end of `src/app-shell/vendor/gsap.js`:

```js

const __wwritingGsap = globalThis.gsap ?? globalThis.window?.gsap;
if (!__wwritingGsap) {
  throw new Error("GSAP vendor loaded but did not expose globalThis.gsap");
}
export const gsap = __wwritingGsap;
export default __wwritingGsap;
```

Do not expose `node_modules` through `src/core/app-server.mjs`.

- [ ] **Step 5: Add a temporary minimal runtime so loading tests can pass**

Create `src/app-shell/motion-runtime.js` with:

```js
import { gsap } from "./vendor/gsap.js";

export function setupMotion() {
  return { gsapLoaded: Boolean(gsap) };
}

export const motion = {
  setupMotion
};
```

- [ ] **Step 6: Run tests to verify vendor loading**

Run:

```powershell
npm test
```

Expected: PASS for the new static vendor test. Existing unrelated tests should continue to pass.

- [ ] **Step 7: Commit**

```powershell
git add package.json package-lock.json src/app-shell/vendor/gsap.js src/app-shell/motion-runtime.js tests/app-server-probe.test.mjs scripts/verify-app-shell.mjs
git commit -m "feat(app-shell): add local gsap vendor entry"
```

## Task 2: Implement Motion Runtime Core And Diff Helpers

**Files:**
- Modify: `src/app-shell/motion-runtime.js`
- Create: `tests/motion-runtime.test.mjs`
- Modify: `src/app-shell/styles.css`

- [ ] **Step 1: Write failing runtime unit tests**

Create `tests/motion-runtime.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";

function installBrowserGlobals({ reduced = false } = {}) {
  globalThis.window = globalThis.window ?? {};
  globalThis.self = globalThis;
  globalThis.window.matchMedia = () => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {}
  });
}

test("motion runtime exposes stable semantic API", async () => {
  installBrowserGlobals();
  const mod = await import(`../src/app-shell/motion-runtime.js?api=${Date.now()}`);
  assert.equal(typeof mod.motion.openDrawer, "function");
  assert.equal(typeof mod.motion.closeDrawer, "function");
  assert.equal(typeof mod.motion.insertFailureCard, "function");
  assert.equal(typeof mod.motion.resolveFailureCard, "function");
  assert.equal(typeof mod.diffActivitySlots, "function");
  assert.equal(typeof mod.diffBadgeKeys, "function");
});

test("diffActivitySlots reports only changed slots", async () => {
  installBrowserGlobals();
  const { diffActivitySlots } = await import(`../src/app-shell/motion-runtime.js?activity=${Date.now()}`);
  const before = { stage: "planning", chapterNo: 1, lastTool: { name: "plan", status: "ok" }, spentCost: 0.1, mode: "running" };
  const after = { stage: "drafting", chapterNo: 1, lastTool: { name: "write", status: "pending" }, spentCost: 0.1, mode: "running" };

  assert.deepEqual(diffActivitySlots(before, after).sort(), ["stage", "tool"]);
});

test("diffBadgeKeys handles rebuilt quick rail summaries", async () => {
  installBrowserGlobals();
  const { diffBadgeKeys } = await import(`../src/app-shell/motion-runtime.js?badges=${Date.now()}`);
  const before = { chapters: "1/10", cost: "normal", reviewer: "read" };
  const after = { chapters: "2/10", cost: "warning", reviewer: "unread" };

  assert.deepEqual(diffBadgeKeys(before, after).sort(), ["chapters", "cost", "reviewer"]);
});

test("reduced-motion close helpers still run completion callbacks", async () => {
  installBrowserGlobals({ reduced: true });
  const { setupMotion, closeDrawer, closeModal } = await import(`../src/app-shell/motion-runtime.js?reduced=${Date.now()}`);
  setupMotion();
  let drawerDone = false;
  let modalDone = false;

  closeDrawer(null, null, { onComplete: () => { drawerDone = true; } });
  closeModal(null, null, { onComplete: () => { modalDone = true; } });

  assert.equal(drawerDone, true);
  assert.equal(modalDone, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm test
```

Expected: FAIL because the full runtime API and diff helpers are missing.

- [ ] **Step 3: Implement runtime core**

Replace `src/app-shell/motion-runtime.js` with:

```js
import { gsap } from "./vendor/gsap.js";

const MOTION = Object.freeze({
  instant: 0,
  fast: 0.14,
  base: 0.22,
  slow: 0.32,
  easeOut: "power2.out",
  easeIn: "power2.in",
  easeInOut: "power2.inOut",
  emphasis: "back.out(1.35)"
});

let reduceQuery = null;
let reducedMotion = false;

export function setupMotion({ matchMedia = globalThis.window?.matchMedia } = {}) {
  if (typeof matchMedia === "function") {
    reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion = Boolean(reduceQuery.matches);
    reduceQuery.addEventListener?.("change", (event) => {
      reducedMotion = Boolean(event.matches);
    });
  }
  return { gsapLoaded: Boolean(gsap), reducedMotion };
}

export function isReducedMotion() {
  if (reduceQuery) reducedMotion = Boolean(reduceQuery.matches);
  return reducedMotion;
}

export function diffActivitySlots(previous, next) {
  if (!previous || !next) return [];
  const changed = [];
  if (previous.stage !== next.stage || previous.mode !== next.mode) changed.push("stage");
  if (previous.chapterNo !== next.chapterNo) changed.push("loc");
  if ((previous.lastTool?.name ?? "") !== (next.lastTool?.name ?? "") ||
      (previous.lastTool?.status ?? "") !== (next.lastTool?.status ?? "")) changed.push("tool");
  if (previous.spentCost !== next.spentCost) changed.push("cost");
  return changed;
}

export function summarizeBadgesForMotion(badges = {}) {
  return {
    chapters: badges.chapters ? `${badges.chapters.done}/${badges.chapters.total}` : "",
    skills: badges.skills ? String(badges.skills.enabledCount ?? 0) : "",
    research: badges.research?.newSinceLastVisit ? "unread" : "read",
    cost: badges.cost?.level ?? "normal",
    reviewer: badges.reviewer?.hasUnread ? "unread" : "read"
  };
}

export function diffBadgeKeys(previous, next) {
  if (!previous || !next) return [];
  return Object.keys(next).filter((key) => previous[key] !== next[key]);
}

function safeAnimate(fn) {
  try {
    return fn();
  } catch (error) {
    console.warn("[motion]", error);
    return null;
  }
}

function clearTemporaryProps(targets) {
  gsap.set(targets, { clearProps: "transform,opacity" });
}

function animateOrSet(targets, vars) {
  if (isReducedMotion()) {
    gsap.set(targets, { ...vars, duration: 0, clearProps: "transform,opacity" });
    return null;
  }
  return gsap.to(targets, vars);
}

export function openDrawer(drawer, scrim, { body, tabs } = {}) {
  return safeAnimate(() => {
    if (isReducedMotion()) return null;
    const tl = gsap.timeline({ defaults: { ease: MOTION.easeOut } });
    tl.fromTo(scrim, { opacity: 0 }, { opacity: 1, duration: MOTION.fast, clearProps: "transform,opacity" }, 0)
      .fromTo(drawer, { xPercent: 100 }, { xPercent: 0, duration: MOTION.slow, clearProps: "transform,opacity" }, 0)
      .fromTo([tabs, body].filter(Boolean), { y: 4, opacity: 0.85 }, { y: 0, opacity: 1, duration: MOTION.base, stagger: 0.035, clearProps: "transform,opacity" }, 0.08);
    return tl;
  });
}

export function closeDrawer(drawer, scrim, { onComplete } = {}) {
  return safeAnimate(() => {
    if (isReducedMotion()) {
      clearTemporaryProps([drawer, scrim].filter(Boolean));
      onComplete?.();
      return null;
    }
    return gsap.timeline({ onComplete, defaults: { ease: MOTION.easeIn } })
      .fromTo(drawer, { xPercent: 0 }, { xPercent: 100, duration: MOTION.base, clearProps: "transform,opacity" }, 0)
      .fromTo(scrim, { opacity: 1 }, { opacity: 0, duration: MOTION.fast, clearProps: "transform,opacity" }, 0);
  });
}

export function openModal(scrim, panel) {
  return safeAnimate(() => animateOrSet([scrim, panel].filter(Boolean), {
    y: 0,
    scale: 1,
    opacity: 1,
    duration: MOTION.base,
    ease: MOTION.easeOut,
    clearProps: "transform,opacity"
  }));
}

export function closeModal(scrim, panel, { onComplete } = {}) {
  return safeAnimate(() => {
    if (isReducedMotion()) {
      onComplete?.();
      return null;
    }
    return gsap.timeline({ onComplete })
      .to(panel, { y: 8, scale: 0.985, opacity: 0, duration: MOTION.base, ease: MOTION.easeIn, clearProps: "transform,opacity" }, 0)
      .to(scrim, { opacity: 0, duration: MOTION.fast, clearProps: "transform,opacity" }, 0);
  });
}

export function insertFailureCard(node) {
  return safeAnimate(() => {
    if (isReducedMotion()) return null;
    node.classList.add("motion-active");
    return gsap.timeline({ defaults: { ease: MOTION.easeOut } })
      .fromTo(node, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: MOTION.base, clearProps: "transform,opacity" })
      .fromTo(node.querySelectorAll(".failure-actions button"), { y: 3, opacity: 0 }, { y: 0, opacity: 1, duration: MOTION.fast, stagger: 0.035, clearProps: "transform,opacity" }, 0.06)
      .eventCallback("onComplete", () => node.classList.remove("motion-active"));
  });
}

export function resolveFailureCard(oldNode, nextNode, { commit } = {}) {
  return safeAnimate(() => {
    const finish = () => {
      oldNode.classList.remove("motion-active");
      commit?.();
      if (!isReducedMotion()) {
        gsap.fromTo(nextNode.querySelector(".failure-resolved"), { y: 3, opacity: 0 }, { y: 0, opacity: 1, duration: MOTION.fast, clearProps: "transform,opacity" });
      }
    };
    if (isReducedMotion()) {
      finish();
      return null;
    }
    oldNode.classList.add("motion-active");
    return gsap.to(oldNode.querySelectorAll(".failure-actions button"), {
      y: -2,
      opacity: 0,
      duration: MOTION.fast,
      stagger: 0.025,
      onComplete: finish,
      clearProps: "transform,opacity"
    });
  });
}

export function updateActivityStrip(root, previous, next) {
  return safeAnimate(() => {
    if (isReducedMotion()) return null;
    const changed = diffActivitySlots(previous, next);
    for (const key of changed) {
      const slot = root?.querySelector(`.as-${key}`);
      if (slot) gsap.fromTo(slot, { y: -2, opacity: 0.75 }, { y: 0, opacity: 1, duration: MOTION.fast, ease: MOTION.easeOut, clearProps: "transform,opacity" });
    }
    return changed;
  });
}

export function bumpQuickRailBadge(button) {
  return safeAnimate(() => {
    const badge = button?.querySelector(".qr-badge");
    if (!badge || isReducedMotion()) return null;
    badge.classList.add("motion-active");
    return gsap.fromTo(badge, { scale: 0.92 }, {
      scale: 1,
      duration: MOTION.fast,
      ease: MOTION.emphasis,
      clearProps: "transform,opacity",
      onComplete: () => badge.classList.remove("motion-active")
    });
  });
}

export const motion = {
  setupMotion,
  openDrawer,
  closeDrawer,
  openModal,
  closeModal,
  insertFailureCard,
  resolveFailureCard,
  updateActivityStrip,
  bumpQuickRailBadge,
  isReducedMotion
};
```

- [ ] **Step 4: Add CSS motion hooks**

Add near the Quick Rail and Failure Card CSS:

```css
.drawer,
.settings-modal,
.create-card,
.motion-active,
.qr-badge {
  will-change: transform;
}

@media (prefers-reduced-motion: reduce) {
  .drawer,
  .settings-modal,
  .create-card,
  .motion-active,
  .qr-badge {
    will-change: auto;
  }
}
```

- [ ] **Step 5: Run tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/app-shell/motion-runtime.js src/app-shell/styles.css tests/motion-runtime.test.mjs
git commit -m "feat(app-shell): add motion runtime core"
```

## Task 3: Wire Activity Strip And Quick Rail Diff Feedback

**Files:**
- Modify: `src/app-shell/app.js`
- Modify: `tests/motion-runtime.test.mjs`

- [ ] **Step 1: Add tests for badge summary helper**

Append to `tests/motion-runtime.test.mjs`:

```js
test("summarizeBadgesForMotion creates stable quick rail keys", async () => {
  installBrowserGlobals();
  const { summarizeBadgesForMotion } = await import(`../src/app-shell/motion-runtime.js?summary=${Date.now()}`);
  const summary = summarizeBadgesForMotion({
    chapters: { done: 2, total: 10 },
    skills: { enabledCount: 3 },
    research: { newSinceLastVisit: true },
    cost: { level: "warning", pct: 0.82 },
    reviewer: { hasUnread: false }
  });

  assert.deepEqual(summary, {
    chapters: "2/10",
    skills: "3",
    research: "unread",
    cost: "warning",
    reviewer: "read"
  });
});
```

- [ ] **Step 2: Run tests to verify they fail if helper is missing**

Run:

```powershell
npm test
```

Expected: PASS. If this fails, the Task 2 implementation omitted `summarizeBadgesForMotion`; add that helper exactly as shown in Task 2 before continuing.

- [ ] **Step 3: Import motion and preserve previous summaries in `app.js`**

At the top of `src/app-shell/app.js`, add:

```js
import { motion, summarizeBadgesForMotion, diffBadgeKeys } from "./motion-runtime.js";
```

Near existing top-level state, add:

```js
let previousActivity = null;
let previousBadgeSummary = null;
```

After refs are initialized and before initial load, call:

```js
motion.setupMotion();
```

- [ ] **Step 4: Wire Activity Strip after render**

Replace the existing Activity Strip block in `loadDashboard()` with this shape:

```js
const stripEl = document.getElementById('activity-strip');
if (stripEl) {
  const activity = deriveActivity(data);
  renderActivityStrip(stripEl, activity, {
    privacy: refs.app.dataset.privacy === 'on',
    onClickCost: () => openDrawerTab('cost'),
    onClickChapter: () => openDrawerTab('chapters')
  });
  motion.updateActivityStrip(stripEl, previousActivity, activity);
  previousActivity = activity;
}
```

- [ ] **Step 5: Wire Quick Rail after render**

Replace the existing Quick Rail block in `loadDashboard()` with:

```js
if (refs.quickRail) {
  const badges = deriveBadges(data, currentProjectRoot, {
    research: getLastSeen(currentProjectRoot, 'research'),
    reviewer: getLastSeen(currentProjectRoot, 'reviewer')
  });
  const nextBadgeSummary = summarizeBadgesForMotion(badges);
  const changedBadgeKeys = diffBadgeKeys(previousBadgeSummary, nextBadgeSummary);
  renderQuickRail(refs.quickRail, badges, { onOpenTab: openDrawerTab, projectRoot: currentProjectRoot });
  for (const key of changedBadgeKeys) {
    motion.bumpQuickRailBadge(refs.quickRail.querySelector(`[data-key="${cssEscape(key)}"]`));
  }
  previousBadgeSummary = nextBadgeSummary;
}
```

- [ ] **Step 6: Reset summaries when project changes**

In `openProject()` and any branch that clears `currentProjectRoot`, add:

```js
previousActivity = null;
previousBadgeSummary = null;
```

- [ ] **Step 7: Run tests**

Run:

```powershell
npm test
npm run verify:app-shell
```

Expected: both PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/app-shell/app.js tests/motion-runtime.test.mjs
git commit -m "feat(app-shell): animate status and rail changes"
```

## Task 4: Wire Failure Card Insert And Resolve Motion

**Files:**
- Modify: `src/app-shell/app.js`
- Modify: `scripts/verify-app-clickability.cjs`

- [ ] **Step 1: Seed one failure card in clickability verification**

In `scripts/verify-app-clickability.cjs`, import `appendFailure` near the other dynamic imports:

```js
const { appendFailure } = await import(pathToFileURL(path.join(rootDir, "src", "core", "failures-store.mjs")).href);
```

After `await runProject(projectRoot);`, add:

```js
appendFailure(projectRoot, {
  id: "click-failure-1",
  seq: 1,
  chapterNo: 1,
  kind: "unknown",
  title: "Clickability probe failure",
  body: "This card verifies failure actions remain clickable after motion.",
  ts: new Date().toISOString(),
  actions: [{ label: "停在这里", command: "pause-here", args: {} }],
  diagnostics: { eventId: "click-failure-1", tool: null, promptHash: null, logPath: "run_log.jsonl", rawError: null },
  resolution: null
});
```

- [ ] **Step 2: Add clickability assertions for failure action and resolved details**

After the drawer close checks in `scripts/verify-app-clickability.cjs`, add:

```js
await win.webContents.executeJavaScript(`
  document.querySelector('.failure-card[data-failure-id="click-failure-1"]')?.scrollIntoView({ block: "center" });
  true;
`);
clicks.push(await clickAndRead(win, '.failure-card[data-failure-id="click-failure-1"] .failure-actions button', {
  label: "failure-action",
  settleMs: 850,
  expect: () => read(win, "document.querySelector('[data-failure-id=\"click-failure-1\"] .failure-resolved') !== null")
}));
clicks.push(await clickAndRead(win, '.failure-card[data-failure-id="click-failure-1"] summary', {
  label: "failure-diagnostics-summary",
  expect: () => read(win, "document.querySelector('[data-failure-id=\"click-failure-1\"] details')?.open === true")
}));
```

Add a second assertion to force a refresh during/after resolution and confirm the card is not duplicated:

```js
clicks.push(await clickAndRead(win, "#refresh", {
  label: "failure-refresh-after-resolve",
  settleMs: 450,
  expect: () => read(win, "document.querySelectorAll('[data-failure-id=\"click-failure-1\"]').length === 1")
}));
```

- [ ] **Step 3: Run clickability to verify it fails before wiring motion**

Run:

```powershell
npm run verify:app-clickability
```

Expected: the seeded card may appear, but motion-specific replacement is not wired yet. If the test already passes, continue; the next step still adds runtime behavior.

- [ ] **Step 4: Wire insert and resolve in `syncFailureCards()`**

Change the existing failure sync branch to this shape:

```js
function syncFailureCards(data) {
  const failures = deriveFailures(data);
  for (const card of failures) {
    const existing = document.querySelector(`[data-failure-id="${cssEscape(card.id)}"]`);
    if (existing) {
      const next = renderFailureCard(card, { onAction: submitFailureAction });
      if (card.resolution && !existing.querySelector(".failure-resolved")) {
        if (existing.dataset.motionResolving === "true") continue;
        existing.dataset.motionResolving = "true";
        motion.resolveFailureCard(existing, next, {
          commit: () => {
            delete existing.dataset.motionResolving;
            existing.replaceWith(next);
          }
        });
      } else {
        existing.replaceWith(next);
      }
      continue;
    }
    const node = renderFailureCard(card, { onAction: submitFailureAction });
    insertByTs(refs.thread, node, card.ts);
    motion.insertFailureCard(node);
  }
}
```

Also add this drift guard to `scripts/verify-app-shell.mjs` near the other `app.js` string assertions:

```js
assert.ok(js.includes("dataset.motionResolving"));
```

- [ ] **Step 5: Run verification**

Run:

```powershell
npm test
npm run verify:app-shell
npm run verify:app-clickability
```

Expected: all PASS; failure action and diagnostics summary receive trusted clicks.

- [ ] **Step 6: Commit**

```powershell
git add src/app-shell/app.js scripts/verify-app-clickability.cjs
git commit -m "feat(app-shell): animate failure card lifecycle"
```

## Task 5: Wire Drawer Motion Without Breaking Interaction State

**Files:**
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`
- Modify: `scripts/verify-app-clickability.cjs`

- [ ] **Step 1: Add clickability assertion for motion runtime import**

In `scripts/verify-app-clickability.cjs`, after the initial probe setup, add:

```js
await win.webContents.executeJavaScript(`
  window.__wwMotionProbe = {
    loaded: Boolean(window.__wwritingMotionReady),
    errors: []
  };
  true;
`);
```

Before building the final result, add:

```js
const motionReady = await read(win, "Boolean(window.__wwritingMotionReady)");
assert.equal(motionReady, true, "motion runtime must initialize in Electron");
for (const message of consoleMessages) {
  assert.ok(!String(message.message).includes("Failed to resolve module specifier"), `module resolution error: ${message.message}`);
  assert.ok(!String(message.message).includes("MIME"), `module MIME error: ${message.message}`);
}
```

- [ ] **Step 2: Expose runtime readiness in `app.js`**

After `motion.setupMotion();`, add:

```js
window.__wwritingMotionReady = true;
```

- [ ] **Step 3: Wire drawer open**

At the end of `openDrawer(tab)`, after `renderDrawerBody();`, add:

```js
motion.openDrawer(refs.drawer, refs.drawerScrim, {
  body: refs.drawerBody,
  tabs: refs.drawerTabs
});
```

- [ ] **Step 4: Wire drawer close with immediate interaction shutdown**

Replace `closeDrawer()` with:

```js
function closeDrawer() {
  refs.drawer.dataset.closing = "true";
  refs.drawerScrim.dataset.closing = "true";
  motion.closeDrawer(refs.drawer, refs.drawerScrim, {
    onComplete: () => {
      delete refs.drawer.dataset.closing;
      delete refs.drawerScrim.dataset.closing;
      if (lastFocused && lastFocused.isConnected) lastFocused.focus();
      lastFocused = null;
    }
  });
  refs.drawer.classList.remove("show");
  refs.drawer.setAttribute("aria-hidden", "true");
  refs.drawer.setAttribute("inert", "");
  refs.drawerScrim.classList.remove("show");
}
```

- [ ] **Step 5: Add CSS for drawer closing state**

Add:

```css
.drawer[data-closing="true"],
.scrim[data-closing="true"] {
  pointer-events: none;
}
```

- [ ] **Step 6: Add drawer focus and repeated-close verification**

In `scripts/verify-app-clickability.cjs`, after an existing drawer close click, add:

```js
const drawerClosedState = await read(win, `
  (() => {
    const drawer = document.getElementById("drawer");
    return drawer.getAttribute("aria-hidden") === "true" && drawer.hasAttribute("inert");
  })()
`);
assert.equal(drawerClosedState, true, "drawer must be inert and aria-hidden after close");
await win.webContents.executeJavaScript(`
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  true;
`);
```

- [ ] **Step 7: Run full drawer interaction verification**

Run:

```powershell
npm test
npm run verify:app-shell
npm run verify:app-clickability
npm run verify:desktop-shell
npm run verify:electron-runtime
```

Expected: all PASS; drawer buttons remain clickable, repeated Escape does not throw, and no module loading errors appear in Electron console messages.

- [ ] **Step 8: Commit**

```powershell
git add src/app-shell/app.js src/app-shell/styles.css scripts/verify-app-clickability.cjs
git commit -m "feat(app-shell): animate drawer safely"
```

## Task 6: Wire Settings And Create Modal Motion Safely

**Files:**
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`
- Modify: `scripts/verify-app-clickability.cjs`

- [ ] **Step 1: Wire modal open and close**

In `openSettingsModal()` and `openCreateModal()`, after the existing class/aria/inert state is set, call:

```js
motion.openModal(refs.settingsScrim, document.querySelector("#settings-modal"));
```

and:

```js
motion.openModal(refs.createScrim, document.querySelector("#create-card"));
```

In `closeSettingsModal()` and `closeCreateModal()`, keep the current immediate `inert`/hidden state changes, then call `closeModal()` with a completion callback that removes the temporary closing flag:

```js
refs.settingsScrim.dataset.closing = "true";
motion.closeModal(refs.settingsScrim, document.querySelector("#settings-modal"), {
  onComplete: () => { delete refs.settingsScrim.dataset.closing; }
});
```

and:

```js
refs.createScrim.dataset.closing = "true";
motion.closeModal(refs.createScrim, document.querySelector("#create-card"), {
  onComplete: () => { delete refs.createScrim.dataset.closing; }
});
```

- [ ] **Step 2: Add CSS for modal closing state**

Add:

```css
.settings-scrim[data-closing="true"],
#create-scrim[data-closing="true"] {
  pointer-events: none;
}
```

- [ ] **Step 3: Add modal inert verification**

In `scripts/verify-app-clickability.cjs`, after closing settings and create overlays, assert:

```js
const modalClosedState = await read(win, `
  (() => {
    const settings = document.getElementById("settings-scrim");
    const create = document.getElementById("create-scrim");
    return settings.hasAttribute("inert") && create.hasAttribute("inert");
  })()
`);
assert.equal(modalClosedState, true, "settings/create overlays must be inert after close");
```

- [ ] **Step 4: Run full modal interaction verification**

Run:

```powershell
npm test
npm run verify:app-shell
npm run verify:app-clickability
npm run verify:desktop-shell
npm run verify:electron-runtime
```

Expected: all PASS; modal buttons remain clickable, overlays return to inert after close, and no module loading errors appear in Electron console messages.

- [ ] **Step 5: Commit**

```powershell
git add src/app-shell/app.js src/app-shell/styles.css scripts/verify-app-clickability.cjs
git commit -m "feat(app-shell): animate modals safely"
```

## Task 7: Final Review And Cleanup

**Files:**
- Modify only files already touched if verification exposes issues.

- [ ] **Step 1: Search for forbidden or stale patterns**

Run:

```powershell
rg -n "from \"gsap\"|appendThreadNode|transitionAgentState|ScrollTrigger" src scripts tests
rg -n "node_modules/gsap" src scripts
rg -n "autoAlpha|visibility" src/app-shell/motion-runtime.js
```

Expected: no `from "gsap"`, no unused Motion Runtime API names, no `ScrollTrigger`, no runtime/script exposure of `node_modules/gsap`, and no `autoAlpha` or direct `visibility` writes in `motion-runtime.js`. The test suite may still contain a negative probe for `/node_modules/gsap/dist/gsap.js`.

- [ ] **Step 2: Run final verification**

Run:

```powershell
npm test
npm run verify:app-shell
npm run verify:app-clickability
npm run verify:desktop-shell
npm run verify:electron-runtime
```

Expected: all PASS.

- [ ] **Step 3: Commit any verification cleanup**

If Step 1 or Step 2 required edits:

```powershell
git add src scripts tests package.json package-lock.json
git commit -m "fix(app-shell): stabilize motion runtime verification"
```

If no edits were needed, do not create an empty commit.

- [ ] **Step 4: Handoff for review**

Request a final code review with this context:

```text
Built WWriting Motion Runtime from docs/superpowers/specs/2026-05-31-wwriting-motion-runtime-design.md.
Review focus:
- local GSAP vendor loading cannot break app.js startup
- drawer/modal closing immediately shuts down interaction state
- failure-card resolved replacement remains clickable
- activity/quick-rail animation only triggers on real diff
- reduced-motion path remains usable
Verification commands passed:
- npm test
- npm run verify:app-shell
- npm run verify:app-clickability
- npm run verify:desktop-shell
- npm run verify:electron-runtime
```
