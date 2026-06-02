# Composer Consolidation — Design Spec

**Date:** 2026-06-02
**Status:** Approved for planning
**Topic:** Wire the orphaned `createComposer` into `app.js` and delete the duplicated inline slash-command logic.

---

## 1. Problem

The B1+B2 skill-system work built a declarative command registry plus a `createComposer(ctx)`
module (`src/app-shell/composer.js`, 310 lines), but the running UI never adopted it. Two
parallel implementations of the same composer logic exist:

- **Live:** `src/app-shell/app.js` carries its own inline copy — `SLASH_COMMANDS` array
  (app.js:94-97), `parseUserCommand`, `matchCommandPrefix`, `updateSlashMenu`, `buildSlashItem`,
  `buildSlashLabel`, `setSlashActive`, `pickSlash`, `hideSlashMenu`, `submitComposer`,
  `submitWritingCommand`, `submitSideQuestion`, `promoteAskEntry`, `resultMessageForCommand` —
  including a **hardcoded short-circuit at app.js:1261-1262** that branches `/chapters` →
  `openDrawer` and `/settings` → `openSettingsModal`.
- **Dead:** `composer.js` exports `createComposer`, which is imported by **nothing** at runtime.
  Only a plan doc and `scripts/verify-app-shell.mjs:200` (a string-presence assertion) reference it.

Verified facts:

- `createComposer` has no runtime importer (grep: only docs + verify script).
- `app.js:4` imports `quick-rail.js`, which imports `commands/index.mjs`, so the
  **command-registry and all 5 command objects already load in the browser today** — that
  subsystem is proven browser-safe.
- `composer.js:4` imports `../core/skill-runtime.mjs`, a **Node-only module**
  (`import fs from "node:fs/promises"`, `node:os`, `node:path`, `ignore` npm pkg). Importing
  `composer.js` into the renderer as-is would crash the browser's ESM load chain — exactly the
  "buttons visible but unclickable" regression class documented in `CLAUDE.md`. This is almost
  certainly why `composer.js` was never wired in.
- The path-activation feature `composer.js` invokes (`activateConditionalSkillsForPaths`) is dead
  end-to-end: `registerProjectSkill` (the only populator of the `conditionalSkills` Map) is called
  **only in tests**. Even if it loaded in the browser, it would iterate an empty Map.

## 2. Goal

Make `composer.js` the single, browser-safe source of truth for composer/slash logic, wired into
`app.js`; delete the duplicated inline logic and the hardcoded `/chapters` / `/settings` branch.
Behavior must remain identical (same `/api/commands/submit` and `/api/commands/ask` calls).

## 3. Non-goals

- **No change to `skill-runtime.mjs` path-activation exports.** `parseSkillPaths`,
  `activateConditionalSkillsForPaths`, `registerProjectSkill`, `resolveSkillSources`, and their
  tests stay as-is (Node-safe, tested). Turning path-activation into a real server-side feature is
  a separate, future decision.
- No change to backend command endpoints.
- No change to `quick-rail.js` (it already imports the registry; its SLOTS are a separate UI surface).

## 4. Design

### 4.1 Strip browser-poison / dead code from `composer.js`

1. Delete `composer.js:4` — `import { activateConditionalSkillsForPaths } from "../core/skill-runtime.mjs"`.
2. Delete `extractFilePathsFromMessage` (composer.js:81-89).
3. Delete the `involvedPaths` / `activateConditionalSkillsForPaths(...)` block inside
   `submitComposer` (composer.js:226-232).

Result: `composer.js` imports only browser-safe modules — `./icons.js`, `./api-client.js`,
`./command-registry.mjs`, `./commands/index.mjs`. `export function createComposer` is retained,
so `verify-app-shell.mjs:200` still passes.

### 4.2 `ctx` contract (built in `app.js`, passed to `createComposer`)

```js
const composer = createComposer({
  refs,                                            // existing app.js refs object
  getCurrentProjectRoot: () => currentProjectRoot, // lazy getter — value mutates over session
  loadDashboard,
  openCreateModal,
  openSettingsModal,
  openDrawer,
  showToast,
  showActionError,
  ensureRefreshLoop,
  threadRenderer: { buildSideBubble, scrollThreadToBottom },
  getAskEntries: () => askEntries,
});
```

`getCurrentProjectRoot` and `getAskEntries` MUST be getters, not captured values — both back
mutable module-level state.

### 4.3 `app.js` delete + rewire

**Delete** (now provided by the composer instance): the `SLASH_COMMANDS` array, the
`SIDE_QUESTION_PREFIXES`/`REVIEW_PREFIXES`/`WRITE_PREFIXES` constants, and the functions
`parseUserCommand`, `matchCommandPrefix`, `onComposerKeydown`, `autoGrowComposer`,
`updateSubmitState`, `updateSlashMenu`, `buildSlashLabel`, `setSlashActive`, `buildSlashItem`,
`pickSlash` (incl. the 1261-1262 hardcode), `hideSlashMenu`, `submitComposer`,
`submitWritingCommand`, `submitSideQuestion`, `promoteAskEntry`, `resultMessageForCommand`.

**Rewire** every caller of the deleted functions to the composer instance:

- app.js:142 — `refs.composerSubmit.addEventListener("click", () => composer.submitComposer())`
- app.js:149 — `refs.composerInput.addEventListener("keydown", composer.onComposerKeydown)`
- app.js:150-153 — input handler → `composer.autoGrowComposer()` + `composer.updateSlashMenu()`
- Scattered internal callers (app.js:1117, 1265, 1305, 1324, 2639) and the thread-renderer
  promote-button handler → route to `composer.autoGrowComposer()` / `composer.updateSubmitState()`
  / `composer.promoteAskEntry(...)` as appropriate.

`createComposer(ctx)` must be invoked **after** `refs` and the referenced functions/state exist,
and **before** the event bindings that reference `composer`.

## 5. Pre-flight checks (resolve during implementation)

These are unverified assumptions to confirm before/while editing — not design blockers:

1. `app.js` actually defines `showActionError` and an `askEntries` Map (composer's ctx needs both).
2. `thread-renderer.js` exports `buildSideBubble` and `scrollThreadToBottom` with the shapes
   `composer.js` expects (`ctx.threadRenderer.buildSideBubble(entry)`, `scrollThreadToBottom()`).
3. `scripts/verify-app-shell.mjs` and `scripts/verify-app-clickability.cjs` contain no assertion
   that greps `app.js` for a deleted function name (e.g. `function submitComposer`). Update any
   stale assertion to target the composer instance/module instead.

## 6. Risks & mitigation

- **Primary risk:** breaking the renderer ESM load chain → unclickable UI. Mitigated by stripping
  the `skill-runtime` import (§4.1) and by the mandatory verification gates below.
- **Secondary risk:** a missed caller of a deleted function (runtime `ReferenceError`). Mitigated
  by a grep sweep for each deleted name after editing, plus clickability verification.

## 7. Verification (mandatory — per `CLAUDE.md`)

```powershell
npm run verify:app-clickability
npm run verify:app-shell
npm run verify:desktop-shell
```

Plus the unit suite:

```powershell
node --test tests/*.test.mjs tests/app-shell/*.test.mjs
```

All must pass before the change is considered done. `verify:app-clickability` is the key gate: it
drives a real Electron window and clicks the composer/slash paths.

## 8. Acceptance criteria

- `composer.js` imports no `../core/*` module; `createComposer` export retained.
- `app.js` no longer defines the duplicated composer functions or the 1261-1262 hardcode; all
  composer behavior flows through `createComposer(ctx)`.
- `/chapters` and `/settings` open via the registry's `uiOnly` command path, not a hardcoded branch.
- All verification gates and the unit suite pass.
- No behavioral change to writing/review/ask submission.
