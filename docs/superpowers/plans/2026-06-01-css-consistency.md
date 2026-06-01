# CSS 一致性微调 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize hardcoded CSS values to use existing design tokens, improving maintainability without visual changes.

**Architecture:** Pure CSS value replacement in a single file. No HTML or JS changes. Two independent tasks: border-radius variable adoption and transition timing normalization.

**Tech Stack:** CSS custom properties, existing verification scripts.

---

## File Structure

- Modify: `src/app-shell/styles.css` — replace hardcoded border-radius and transition values
- Verify: `scripts/verify-app-shell.mjs` — static assertions for CSS patterns
- Verify: `scripts/verify-app-clickability.cjs` — Electron interaction checks (should pass without changes)

## Execution Preconditions

- Run `git status --short` before editing.
- Treat existing dirty files as user work. Do not revert or rewrite unrelated hunks.

## Task 1: border-radius Variable Adoption

**Files:**
- Modify: `src/app-shell/styles.css`
- Modify: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: Add failing static assertions**

Add these assertions in `scripts/verify-app-shell.mjs` near existing CSS checks:

```js
const css = await fetchText(`http://127.0.0.1:${port}/styles.css`);
// ... existing css checks ...

// border-radius consistency
assert.ok(!css.includes("border-radius: var(--r, 12px)"), "failure-card must not have fallback in var(--r)");
```

- [ ] **Step 2: Fix failure-card syntax error**

In `src/app-shell/styles.css`, find the `.failure-card` rule and change:

```css
/* Before */
border-radius: var(--r, 12px);

/* After */
border-radius: var(--r);
```

- [ ] **Step 3: Replace hardcoded 8px border-radius values**

Replace all occurrences of `border-radius: 8px` with `border-radius: var(--r-sm)`. Use replace-all. The CSS variable `--r-sm` is defined as `8px` in `:root`.

Affected selectors (verify each after edit):
- `.icon-btn` (line ~200)
- `.step-ic` (line ~524)
- `.file-ic` (line ~572)
- `.chap-cell` (line ~774)
- `.qr-slot` (line ~1229)
- `.qr-badge` (line ~1238)
- `.qr-popover` (line ~1251)
- `.small-button` (line ~1408)
- `.failure-diagnostics pre` (line ~1192)
- `.topbar-progress-bar` (line ~1308)
- `.dpanel` (line ~731)
- `.slash-ic` (line ~697)

- [ ] **Step 4: Run verification**

Run:

```powershell
npm run verify:app-shell
npm run verify:app-clickability
```

Expected: PASS. Visual inspection should show no difference (8px → 8px).

- [ ] **Step 5: Commit**

```powershell
git add src/app-shell/styles.css scripts/verify-app-shell.mjs
git commit -m "fix: adopt border-radius CSS variables"
```

## Task 2: Transition Timing Normalization

**Files:**
- Modify: `src/app-shell/styles.css`
- Modify: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: Add failing static assertions**

Add these assertions in `scripts/verify-app-shell.mjs`:

```js
// transition timing consistency
assert.ok(!css.match(/transition[^;]*\.13s/), "no .13s transitions allowed");
assert.ok(!css.match(/transition[^;]*\.14s/), "no .14s transitions allowed");
assert.ok(!css.match(/transition[^;]*\.15s/), "no .15s transitions allowed");
assert.ok(!css.match(/transition[^;]*\.16s/), "no .16s transitions allowed");
assert.ok(!css.match(/transition[^;]*\.18s/), "no .18s transitions allowed");
```

- [ ] **Step 2: Replace .13s with .12s**

Replace all `.13s` in transition properties with `.12s`. Use replace-all on `styles.css`. These are hover micro-interactions where 1ms difference is imperceptible.

Affected rules:
- `.nav-item` transition
- `.icon-btn` transition
- `.tbtn` transition
- `.proj` transition
- `.new-btn` filter transition
- `.spd-input` transition
- `.cbar-btn` transition

- [ ] **Step 3: Replace .14s/.15s/.16s/.18s with .2s**

Replace these values in transition properties:

**`.14s` → `.2s`** (border-color, box-shadow transitions):
- `.filecard` transition
- `.dfield input/select` transition
- `.spd-input` transition
- `.spd-eye` transition
- `.provider-pick` transition

**`.15s` → `.2s`** (composer focus):
- `.composer` transition

**`.16s` → `.2s`** (toggle switch):
- `.sw` transition
- `.sw-dot` transition

**`.18s` → `.2s`** (chevron rotation, privacy filter):
- `.sc-chev` transition (if present)
- `.peek` transition

- [ ] **Step 4: Run verification**

Run:

```powershell
npm run verify:app-shell
npm run verify:app-clickability
```

Expected: PASS. Timing changes are 20-60ms, imperceptible to users.

- [ ] **Step 5: Commit**

```powershell
git add src/app-shell/styles.css scripts/verify-app-shell.mjs
git commit -m "fix: normalize transition timing to standard tiers"
```

## Task 3: Full Regression Verification

**Files:**
- No source edits expected.

- [ ] **Step 1: Run app-shell verification**

Run:

```powershell
npm run verify:app-shell
```

Expected: PASS.

- [ ] **Step 2: Run Electron clickability verification**

Run:

```powershell
npm run verify:app-clickability
```

Expected: PASS.

- [ ] **Step 3: Visual spot-check**

Open the app in Electron and verify:
- Hover over nav items, buttons, project cards — transitions feel smooth
- Open settings modal — border-radius consistent
- Check failure cards (if any) — border-radius looks correct
- Toggle privacy mode — transition smooth

## Self-Review Checklist

- Spec coverage: Task 1 covers border-radius variable adoption; Task 2 covers transition timing normalization; Task 3 covers regression verification.
- Placeholder scan: This plan contains concrete code, commands, and expected outcomes for every implementation step.
- Type consistency: The plan consistently uses `--r-sm` for 8px values and `.2s` as the standard mid-tier timing.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-01-css-consistency.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.
