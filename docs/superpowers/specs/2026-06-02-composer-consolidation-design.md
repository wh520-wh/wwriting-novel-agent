# app.js Decomposition Wire-In — Design Spec

**Date:** 2026-06-02
**Status:** Approved for planning
**Topic:** Complete the in-flight `app.js` decomposition by wiring in all six extracted
app-shell modules and deleting the duplicated inline logic. Starts from the original
"composer.js is dead code" finding, expanded to the full set after discovery (see §1).

---

## 1. Problem

`src/app-shell/app.js` (2666 lines) is mid-refactor into focused modules. Six extracted modules
exist but **none are imported by `app.js`** — they are dead, duplicated copies of logic that still
runs inline in `app.js`:

| Module | Lines | Public surface | Depends on |
|---|---|---|---|
| `api-client.js` | 34 | `getJson`, `postJson` | — |
| `utils.js` | 118 | `compactObject`, `translateStage`, `cssEscape`, … | — |
| `icons.js` | 38 | `icon(name, size)` | — |
| `thread-renderer.js` | 696 | `createThreadRenderer(ctx)` → incl. `buildSideBubble`, `scrollThreadToBottom` | api-client, utils, icons |
| `drawer-panels.js` | 364 | `createDrawerPanels(ctx)` | api-client, utils, icons |
| `settings-modal.js` | 338 | `createSettingsModal(ctx)` | api-client, utils |
| `composer.js` | 310 | `createComposer(ctx)` | api-client, icons, command-registry, commands/index |

`scripts/verify-app-shell.mjs` already encodes the **target** state: assertions 191–196 require
`app.js` to import from all six. The gate is currently **red** — it fails at the first assertion
(`app.js must import from utils.js`) and never reaches the rest. So this is not new feature work;
it is completing a refactor whose acceptance test was written ahead of the wiring.

Verified specifics that shaped this spec:

- `createComposer` (and the other `create*` factories) have no runtime importer (grep: only docs +
  verify script).
- `app.js:4` → `quick-rail.js:4` → `commands/index.mjs`, so the command-registry + 5 command
  objects **already load in the browser today** — that subsystem is proven browser-safe.
- **Browser-safety landmine:** `composer.js:4` imports `../core/skill-runtime.mjs`, a Node-only
  module (`node:fs/promises`, `node:os`, `node:path`, `ignore` npm pkg). Importing `composer.js`
  as-is into the renderer would crash the ESM load chain — the "buttons visible but unclickable"
  regression class documented in `CLAUDE.md`. This is almost certainly why composer was never
  wired in. The path-activation feature it powers is also dead end-to-end (`registerProjectSkill`,
  the only populator of the conditional-skills Map, is called **only in tests**).

## 2. Goal

Wire all six modules into `app.js`, delete the corresponding inline duplicates, and turn
`verify:app-shell` green — without regressing clickability. Behavior must remain identical (same
API endpoints, same DOM, same UX).

## 3. Architecture & sequencing

Wire in **leaves first, factories next, composer last**, each module an independently-verified
commit (or small commit group). Dependency-ordered:

1. `api-client.js` — replace app.js's inline `getJson`/`postJson`.
2. `utils.js` — replace app.js's inline `compactObject`/`translateStage`/`cssEscape`/etc.
3. `icons.js` — replace app.js's inline `icon()`.
4. `thread-renderer.js` — `createThreadRenderer(ctx)`; provides `buildSideBubble`,
   `scrollThreadToBottom`, and the thread/dashboard rendering app.js does inline.
5. `drawer-panels.js` — `createDrawerPanels(ctx)`; provides `openDrawer` + drawer tab rendering.
6. `settings-modal.js` — `createSettingsModal(ctx)`; provides `openSettingsModal` + provider UI.
7. `composer.js` — `createComposer(ctx)`; LAST, because its `ctx` consumes `openDrawer`
   (drawer-panels), `openSettingsModal` (settings-modal), and `threadRenderer` (thread-renderer).

### Wiring pattern (applied per module)

For **leaf** modules (api-client, utils, icons): add the `import` to `app.js`, delete the inline
copies, point any internal references at the imported functions, verify.

For **factory** modules (thread-renderer, drawer-panels, settings-modal, composer): add the
`import`, build the `ctx` object from app.js's existing state/functions (using **getters** for
mutable module state such as `currentProjectRoot`), call `create*(ctx)` once during init **before**
the DOM event-binding block that references its methods, **destructure the returned methods into
const bindings** so existing call sites keep working without rewiring, then delete the inline
duplicates. The create call must run before any by-value handler registration that passes a method
reference (e.g. `addEventListener("keydown", onComposerKeydown)`).

### composer.js specifics (the most-analyzed module)

- Strip `composer.js:4` (`import … from "../core/skill-runtime.mjs"`), `extractFilePathsFromMessage`
  (81–89), and the `activateConditionalSkillsForPaths` block in `submitComposer` (226–232). After
  this, composer imports only browser-safe modules.
- Delete the inline composer block in `app.js` (1121–1366) plus the now-dead top-of-file constants
  `SIDE_QUESTION_PREFIXES`/`REVIEW_PREFIXES`/`WRITE_PREFIXES`/`MAIN_TASK_IMPACT_PATTERN`/
  `SLASH_COMMANDS` (app.js:87–99) — composer holds its own copies.
- `ctx` for composer: `refs`, `getCurrentProjectRoot: () => currentProjectRoot`, `loadDashboard`,
  `openCreateModal`, `openSettingsModal`, `openDrawer`, `showToast`, `showActionError`,
  `ensureRefreshLoop`, `threadRenderer: { buildSideBubble, scrollThreadToBottom }`,
  `getAskEntries: () => askEntries`.
- Externally-referenced returned methods to destructure: `submitComposer`, `autoGrowComposer`,
  `updateSlashMenu`, `onComposerKeydown`, `updateSubmitState`, `promoteAskEntry` (the last is
  called from the kept `buildSideBubble` at app.js:1080).
- The 1261-1262 hardcoded `/chapters` / `/settings` branch is removed — composer routes them via the
  registry's `uiOnly` command path.

## 4. Non-goals

- No change to `skill-runtime.mjs` path-activation exports (`parseSkillPaths`,
  `activateConditionalSkillsForPaths`, `registerProjectSkill`, `resolveSkillSources`) or their
  tests — Node-safe, tested; a real server-side path-activation feature is a separate decision.
- No change to backend command endpoints or the command-registry / commands/* files.
- No behavioral/visual change to any surface.

## 5. Invariants (must hold after every module)

1. **Browser-safety:** no app-shell module wired into `app.js` may import a `../core/*` module or a
   `node:`/CommonJS-only package. (composer's `skill-runtime` import is the known violation, removed.)
2. **Identical behavior:** every wired module reproduces the inline behavior it replaces.
3. **No orphan references:** after deleting an inline block, `app.js` has zero references to the
   deleted bare names except those satisfied by the imported/destructured bindings.

## 6. Risks & mitigation

- **Primary:** breaking the renderer ESM load chain → unclickable UI. Mitigated by the §5.1
  browser-safety invariant and by running `verify:app-clickability` after **every** module.
- **Secondary:** a missed inline call site → runtime `ReferenceError`. Mitigated by the
  destructure-into-const pattern and a grep sweep for each deleted name after each module.
- **Sequencing:** if a factory is wired before its leaf dependency, its import chain breaks. Mitigated
  by the strict order in §3.

## 7. Verification (mandatory — per `CLAUDE.md`)

Run after **each** module (not just at the end):

```powershell
node --test tests/*.test.mjs tests/app-shell/*.test.mjs
npm run verify:app-clickability
npm run verify:app-shell
```

Before final hand-off / desktop use:

```powershell
npm run verify:desktop-shell
npm run verify:local
```

`verify:app-shell` goes from red → green incrementally as each `import` assertion (191–196) is
satisfied; it is fully green only after all six modules are wired.

## 8. Acceptance criteria

- `app.js` imports all six modules; no inline duplicate of any extracted module's logic remains.
- No app-shell module wired into `app.js` imports a `../core/*` or `node:` module.
- `/chapters` and `/settings` open via the registry `uiOnly` path; the 1261-1262 hardcode is gone.
- `verify:app-shell`, `verify:app-clickability`, `verify:desktop-shell`, and the unit suite all pass.
- No behavioral or visual change to any surface.
