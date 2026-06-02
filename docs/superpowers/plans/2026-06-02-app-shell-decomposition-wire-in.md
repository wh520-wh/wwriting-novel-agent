# app.js Decomposition Wire-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire all six extracted app-shell modules into `src/app-shell/app.js`, delete the inline duplicates, reconcile the one drifted module (settings-modal), and turn `verify:app-shell` green — with zero behavioral/visual regression.

**Architecture:** `app.js` (2666 lines) is mid-decomposition into six modules that exist but are imported by nothing. Wire them in **dependency order, leaves → factories, composer last**, each an independently-verified commit. Leaves (`api-client`/`utils`/`icons`) are pure-function imports. Factories (`thread-renderer`/`drawer-panels`/`settings-modal`/`composer`) are `create*(ctx)` instances built from app.js's existing state (mutable state passed as getters) and created near the top of `app.js` **before** the DOM event-binding block. `composer.js` must first be made browser-safe (it currently imports a Node-only core module).

**Tech Stack:** Vanilla ES modules in the Electron renderer, Node built-in test runner, custom `verify:*` scripts (one spawns a real Electron window and clicks UI paths).

**Source Spec:** `docs/superpowers/specs/2026-06-02-composer-consolidation-design.md`

**Commit Strategy:** Do NOT use `git add -A`. Stage only the files named in each task. One commit per module (or per logical sub-step). The repo working tree already contains many unrelated staged/modified files — never sweep them in.

---

## Critical execution notes (read before starting)

1. **Line numbers drift.** The inline copies are interleaved (e.g. `icon` at app.js:461 and `cssEscape` at 742 sit *inside* the thread-renderer block 400-1097; the utils cluster is at 2521-2607). After each deletion the line numbers below shift. **Locate every deletion target by `Grep` for its name immediately before editing**, and prefer name-anchored `Edit` (exact function text) over line-range deletion. The line numbers in this plan are accurate against the *original* file and are guidance, not absolutes.
2. **Verify after every module.** Run the unit suite + `verify:app-clickability` + `verify:app-shell` after each task. `verify:app-clickability` is the gate that catches the "visible-but-unclickable" regression class. Never proceed to the next module on a red gate.
3. **Baseline is red.** `verify:app-shell` currently fails at its first import assertion (`app.js must import from utils.js`). Each module wired turns one more of assertions 191-196 green; it is fully green only after Task 7.
4. **Browser-safety invariant:** no module wired into app.js may import a `../core/*` module or a `node:`/CommonJS package. Only `composer.js` violates this today (Task 7 fixes it).

---

## File Structure Overview

### Modules wired in (already exist; only `settings-modal.js` and `composer.js` are edited)

| File | Role | Edited? |
|---|---|---|
| `src/app-shell/api-client.js` | `getJson`, `postJson`, `readResponseJson` | no |
| `src/app-shell/utils.js` | formatters/translators/path helpers | no |
| `src/app-shell/icons.js` | `ICON_PATHS`, `icon()` | no |
| `src/app-shell/thread-renderer.js` | `createThreadRenderer(ctx)` | no (faithful copy) |
| `src/app-shell/drawer-panels.js` | `createDrawerPanels(ctx)` | no (faithful copy) |
| `src/app-shell/settings-modal.js` | `createSettingsModal(ctx)` | **yes — reconcile drift** |
| `src/app-shell/composer.js` | `createComposer(ctx)` | **yes — strip core import** |

### Modified

| File | Change |
|---|---|
| `src/app-shell/app.js` | add 7 imports; add a module-init block; delete ~1900 lines of inline duplicates; rewire call sites |

### Confirmed existing app.js symbols (used to build ctx — do NOT recreate)

- State: `refs` (10-67), `currentProjectRoot` (70, let), `drawerTab` (73, let), `lastDashboard` (74, let), `renderedKeys` (77, const Set), `askEntries` (79, const Map), `liveBlock` (81, let).
- Hoisted `function` decls (safe to reference from the init block even though defined later): `loadDashboard` (249), `openReader` (2369), `announce` (2514), `handleQuick` (1106), `handleRetry` (1506), `handleStop` (1523), `ensureRefreshLoop` (2481), `showActionError` (2492), `showToast` (2498), `openCreateModal` (2407), `openDrawer` (1618), `openDrawerTab` (1639), `setDrawerTab` (1662), `setDrawerTabActive` (1668).

---

## Task 0: Baseline

**Files:** none.

- [ ] **Step 1: Record unit-test baseline**

```powershell
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | Select-Object -Last 5
```

Expected: a pass count with `fail 0` (record the number).

- [ ] **Step 2: Confirm the clickability baseline is green**

```powershell
npm run verify:app-clickability 2>&1 | Select-Object -Last 5
```

Expected: `ok: true`. If already red, STOP — fix the environment first; this plan assumes a green clickability baseline.

- [ ] **Step 3: Confirm app-shell baseline is red at utils.js**

```powershell
node scripts/verify-app-shell.mjs 2>&1 | Select-String -Pattern "must import"
```

Expected: `AssertionError ... app.js must import from utils.js`. This is the known starting state.

---

## Task 1: Wire in `api-client.js` (leaf)

**Files:**
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: Add the import** at the top of `app.js` (after line 6):

```js
import { getJson, postJson } from "./api-client.js";
```

(`readResponseJson` is internal to the module; app.js does not call it directly — confirm with `Grep "readResponseJson" src/app-shell/app.js`; if the only hits are the inline definition, it is safe to drop.)

- [ ] **Step 2: Locate and delete the inline copies.** Grep first: `Grep "^async function (getJson|postJson|readResponseJson)" src/app-shell/app.js`. Delete the three inline functions (`getJson` ~1568-1590, `postJson` ~1591-1606, `readResponseJson` ~1607-…). Delete by exact function text via `Edit`.

- [ ] **Step 3: Sanity-check no other definition remains**

```powershell
Select-String -Path src/app-shell/app.js -Pattern "function (getJson|postJson|readResponseJson)"
```

Expected: no matches (only the import remains).

- [ ] **Step 4: Verify**

```powershell
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | Select-Object -Last 5
npm run verify:app-clickability 2>&1 | Select-Object -Last 5
```

Expected: unit `fail 0`; clickability `ok: true`.

- [ ] **Step 5: Commit**

```powershell
git add src/app-shell/app.js
git commit -m "refactor(app-shell): wire app.js to api-client.js, delete inline getJson/postJson"
```

---

## Task 2: Wire in `utils.js` (leaf)

**Files:**
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: Add the import** (after the api-client import). Import exactly the names app.js uses — confirm usage first with `Grep "\b(compactObject|formatNumber|formatCompact|formatMoney|formatTime|statusClass|pathEquals|pathBaseName|resolveModelEndpoint|ensureTrailingSlash|isEnvironmentVariableName|cssEscape|translateStage|translateReviewStatus|translateSkillType|translateSourceKind|translateEventType)\b" src/app-shell/app.js`, then:

```js
import {
  compactObject, formatNumber, formatCompact, formatMoney, formatTime,
  statusClass, pathEquals, pathBaseName, resolveModelEndpoint, ensureTrailingSlash,
  isEnvironmentVariableName, cssEscape, translateStage, translateReviewStatus,
  translateSkillType, translateSourceKind, translateEventType
} from "./utils.js";
```

(Drop any name from the import that grep shows app.js never calls outside its own inline definition.)

- [ ] **Step 2: Delete the inline copies.** Grep `^function (compactObject|formatNumber|...)` to get current line numbers. The cluster is ~2521-2607 (`compactObject`…`translateEventType`), plus `cssEscape` ~742 (interleaved in the thread block — delete it here, before Task 4). Delete each by exact function text.

- [ ] **Step 3: Sanity-check**

```powershell
Select-String -Path src/app-shell/app.js -Pattern "^function (compactObject|formatNumber|formatCompact|formatMoney|formatTime|statusClass|pathEquals|pathBaseName|resolveModelEndpoint|ensureTrailingSlash|isEnvironmentVariableName|cssEscape|translateStage|translateReviewStatus|translateSkillType|translateSourceKind|translateEventType)\b"
```

Expected: no matches.

- [ ] **Step 4: Verify** (same two commands as Task 1 Step 4). Expected: unit `fail 0`; clickability `ok: true`.

- [ ] **Step 5: Commit**

```powershell
git add src/app-shell/app.js
git commit -m "refactor(app-shell): wire app.js to utils.js, delete inline formatters/translators"
```

---

## Task 3: Wire in `icons.js` (leaf)

**Files:**
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: Add the import** (after the utils import):

```js
import { icon } from "./icons.js";
```

(Confirm app.js does not use `ICON_PATHS` directly elsewhere: `Grep "ICON_PATHS" src/app-shell/app.js` — expect only the inline definition. If something else references it, also export/import it.)

- [ ] **Step 2: Delete the inline copies.** Grep `Grep "^const ICON_PATHS|^function icon\b" src/app-shell/app.js`. Delete `ICON_PATHS` (~110) and `icon` (~461, interleaved in the thread block) by exact text.

- [ ] **Step 3: Sanity-check**: `Select-String -Path src/app-shell/app.js -Pattern "^function icon\b|^const ICON_PATHS"` → no matches.

- [ ] **Step 4: Verify** (unit + clickability). Expected: `fail 0`, `ok: true`.

- [ ] **Step 5: Commit**

```powershell
git add src/app-shell/app.js
git commit -m "refactor(app-shell): wire app.js to icons.js, delete inline icon/ICON_PATHS"
```

---

## Task 4: Wire in `thread-renderer.js` (faithful copy, large ctx)

`thread-renderer.js` is a verified faithful copy (no drift). It has a 15-property ctx and a cross-module cycle with composer (`promoteAskEntry`), resolved by a forward-declared `let composer`.

**Files:**
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: Add the import** (after icons import):

```js
import { createThreadRenderer } from "./thread-renderer.js";
```

- [ ] **Step 2: Add a forward declaration + the module-init block.** Immediately after the state declarations (after `let liveBlock = null;` ~line 81) and **before** the DOM event-binding block (~line 130), insert:

```js
// --- extracted module instances (created before event bindings that reference their methods) ---
let composer; // forward ref: thread-renderer's promote button calls composer.promoteAskEntry (assigned in Task 7)

const threadRenderer = createThreadRenderer({
  refs,
  renderedKeys,
  askEntries,
  getLiveBlock: () => liveBlock,
  setLiveBlock: (block) => { liveBlock = block; },
  getCurrentProjectRoot: () => currentProjectRoot,
  loadDashboard,
  handleRetry,
  handleStop,
  handleQuick,
  openReader,
  showToast,
  showActionError,
  announce,
  promoteAskEntry: (entry) => composer.promoteAskEntry(entry),
});
```

(All referenced names are hoisted `function` decls or const/let already in scope. `composer` is only dereferenced inside the arrow, which fires on user click — long after Task 7 assigns it.)

- [ ] **Step 3: Rewire the external call sites** to the instance. Grep `Grep "\b(renderEmptyThread|syncThread|syncFailureCards|updateLiveAgentBlock|buildSideBubble|scrollThreadToBottom)\b" src/app-shell/app.js`. For every call **outside** the 400-1097 block, prefix with `threadRenderer.`:
  - ~320 `renderEmptyThread()` → `threadRenderer.renderEmptyThread()`
  - ~349 `syncThread(data, firstLoad)` → `threadRenderer.syncThread(data, firstLoad)`
  - ~350 `syncFailureCards(data)` → `threadRenderer.syncFailureCards(data)`
  - any `updateLiveAgentBlock(...)` caller in the refresh loop → `threadRenderer.updateLiveAgentBlock(...)`
  - (The `buildSideBubble`/`scrollThreadToBottom` calls at ~1337-1338 live inside the composer block and are handled in Task 7 via `ctx.threadRenderer`.)

- [ ] **Step 4: Delete the inline thread block.** Grep the current boundaries (`renderEmptyThread` start, `buildAskConfirm` end). Delete the contiguous inline implementation (originally 400-1097, now shrunk because `icon`@461 and `cssEscape`@742 were removed in Tasks 2-3). Delete by exact function text, function-by-function, for: `renderEmptyThread, syncThread, timeValue, eventKey, scrollThreadToBottom, buildSessionHead, buildSessionHeadInner, statCell, refreshSessionHead, buildGreeting, buildUserBubble, renderQueueCards, buildTaskCard, buildInlineProgress, taskSummary, cancelQueuedTask, translateTaskStatus, buildQuickRow, buildAgentBlock, appendRunDetail, renderSteps, writingStepLabel, computeSteps, attachChapterCard, finishAgentBlock, insertByTs, submitFailureAction, syncFailureCards, updateLiveAgentBlock, buildSideBubble, buildAskConfirm`.

  **Keep** the callers that live just outside this block: `handleQuick` (1106), `loadDashboard` (249), and everything ≥1100.

- [ ] **Step 5: Sanity-check for orphans**

```powershell
Select-String -Path src/app-shell/app.js -Pattern "function (syncThread|buildSideBubble|buildAgentBlock|renderEmptyThread)\b"
```

Expected: no matches. Also confirm no bare `syncThread(`/`buildSideBubble(` calls remain unprefixed outside the composer block.

- [ ] **Step 6: Verify** (unit + clickability). Expected: `fail 0`, `ok: true`. Manually reason: thread renders on dashboard load; clickability exercises nav/refresh which triggers `renderDashboard` → `threadRenderer.syncThread`.

- [ ] **Step 7: Commit**

```powershell
git add src/app-shell/app.js
git commit -m "refactor(app-shell): wire app.js to thread-renderer.js, delete inline thread rendering"
```

---

## Task 5: Wire in `drawer-panels.js` (faithful copy)

`drawer-panels.js` is a verified faithful copy. app.js **keeps** `openDrawer`/`openDrawerTab`/`setDrawerTab`/`setDrawerTabActive`; the module owns only `renderDrawerBody`.

**Files:**
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: Add the import**:

```js
import { createDrawerPanels } from "./drawer-panels.js";
```

- [ ] **Step 2: Add to the module-init block** (after the `threadRenderer` const):

```js
const { renderDrawerBody } = createDrawerPanels({
  refs,
  getDrawerTab: () => drawerTab,
  getDashboard: () => lastDashboard,
  loadDashboard,
  openReader,
  openSettingsModal,
  showToast,
  showActionError,
});
```

Note: `openSettingsModal` here refers to the settings-modal instance method created in Task 6. Since Task 6 runs before this is *executed* only if ordered correctly — to avoid a forward-reference, **place Task 6's `settingsModal` init block ABOVE this `createDrawerPanels` call** when you implement Task 6, OR forward-declare `let openSettingsModal` and assign in Task 6. Recommended: keep app.js's existing `function openSettingsModal` working until Task 6, then in Task 6 replace it. For Task 5 in isolation, app.js still has the inline `function openSettingsModal` (hoisted) — so this reference resolves. (Task 6 removes the inline one and must keep a binding named `openSettingsModal` in scope — see Task 6 Step 2.)

- [ ] **Step 3: Delete the inline body renderers.** Grep boundaries. Delete `renderDrawerBody` (~1676) and `drawerEmpty, dpanel, renderChapterPanel, buildChapterRow, renderModelPanel, cacheSummaryText, appendKv, renderRunPanel, renderSkillsPanel, renderResearchPanel, renderCostPanel, renderReviewerPanel, runResearch, buildEventRow, buildSkillRow` (through ~2031). **Keep** `setDrawerTab` (1662), `setDrawerTabActive` (1668), `openDrawer` (1618), `openDrawerTab` (1639), `toggleDrawer` (1634).

- [ ] **Step 4: Confirm the kept callers resolve.** `openDrawer` calls `setDrawerTabActive()` and `renderDrawerBody()`; `renderDrawerBody` is now the destructured const from Step 2. Verify with `Select-String -Path src/app-shell/app.js -Pattern "function renderDrawerBody\b"` → no matches (only the const binding).

- [ ] **Step 5: Verify** (unit + clickability). Expected: `fail 0`, `ok: true`. Clickability clicks the chapter drawer + other tabs — exercises `renderDrawerBody`.

- [ ] **Step 6: Commit**

```powershell
git add src/app-shell/app.js
git commit -m "refactor(app-shell): wire app.js to drawer-panels.js, delete inline panel renderers"
```

---

## Task 6: Reconcile + wire in `settings-modal.js`

`settings-modal.js` is **drifted**: it lacks the shipped B5 output-style dropdown and the custom-active-model preservation. Reconcile the module to match live app.js, THEN wire it in.

**Files:**
- Modify: `src/app-shell/settings-modal.js` (reconcile)
- Modify: `src/app-shell/app.js` (wire + delete inline)

### 6a — Reconcile the module

- [ ] **Step 1: Add `getJson` to the module's api-client import.** Edit `settings-modal.js:3`:

```js
import { getJson, postJson } from "./api-client.js";
```

- [ ] **Step 2: Add a `fetchOutputStyles` helper** inside `createSettingsModal` (e.g. just after `const settingsFields = {};` at line 23):

```js
  async function fetchOutputStyles() {
    try {
      const data = await getJson("/api/output-styles");
      return Array.isArray(data.styles) ? data.styles : [];
    } catch (error) {
      console.warn("fetchOutputStyles failed:", error);
      return [
        { name: "creative", description: "创作模式", source: "bundled" },
        { name: "review", description: "审稿模式", source: "bundled" }
      ];
    }
  }
```

- [ ] **Step 3: Make `renderSettingsDetail` async and add the output-style field.** In `settings-modal.js`, change line 78 `function renderSettingsDetail() {` to `async function renderSettingsDetail() {`. Then, between the `searchKeyEnv` field (line 123) and the `ctx.refs.settingsDetail.append(` call (line 125), insert:

```js
    // 输出风格下拉(bundled + user + project)
    const currentOutputStyle = dashboard?.project?.output_style ?? "creative";
    const outputStyles = await fetchOutputStyles();
    const outputStyleField = document.createElement("div");
    outputStyleField.className = "spd-field";
    const outputStyleLabel = document.createElement("div");
    outputStyleLabel.className = "spd-label";
    const outputStyleSpan = document.createElement("span");
    outputStyleSpan.textContent = "输出风格";
    outputStyleLabel.append(outputStyleSpan);
    const outputStyleSelect = document.createElement("select");
    outputStyleSelect.className = "spd-input";
    outputStyleSelect.id = "settings-output-style";
    outputStyleSelect.setAttribute("aria-label", "输出风格");
    for (const style of outputStyles) {
      const opt = document.createElement("option");
      opt.value = style.name;
      opt.textContent = `${style.name} — ${style.description}`;
      outputStyleSelect.append(opt);
    }
    outputStyleSelect.value = currentOutputStyle;
    outputStyleField.append(outputStyleLabel, outputStyleSelect);
    settingsFields.outputStyle = { field: outputStyleField, input: outputStyleSelect };
```

(`dashboard` is already in scope — `const dashboard = ctx.getDashboard();` at line 81.)

- [ ] **Step 4: Append the field.** Change the append call (lines 125-130) to include `settingsFields.outputStyle.field` as the final argument:

```js
    ctx.refs.settingsDetail.append(
      settingsFields.model.field, settingsFields.baseUrl.field, endpointHint,
      settingsFields.apiKey.field, settingsFields.apiKeyEnv.field, keyHint,
      settingsFields.maxCalls.field, settingsFields.network.field,
      settingsFields.searchEndpoint.field, settingsFields.searchKeyEnv.field,
      settingsFields.outputStyle.field
    );
```

- [ ] **Step 5: Fix the model-dropdown options** to preserve a custom active model. Change `settings-modal.js:101` from `options: preset.models,` to:

```js
      options: preset.models.includes(active.model_name) ? preset.models : (usingThisPreset && active.model_name ? [active.model_name, ...preset.models] : preset.models),
```

And line 102 `value:` to match live app.js exactly:

```js
      value: usingThisPreset ? active.model_name : preset.models[0],
```

- [ ] **Step 6: Persist `output_style` on save.** In `saveSettings`, change the `research_config` block (lines 313-316) to add a trailing field:

```js
        research_config: compactObject({
          search_endpoint: settingsFields.searchEndpoint.input.value.trim(),
          search_api_key_env: settingsFields.searchKeyEnv.input.value.trim()
        }),
        output_style: settingsFields.outputStyle?.input?.value ?? "creative"
```

- [ ] **Step 7: Confirm `renderSettingsDetail` callers await/handle the promise.** `renderSettingsDetail` is now async. Its in-module callers (`openSettingsModal` line 32, `renderSettingsProviders` click line 72, `resetToCustom` line 334) call it fire-and-forget — that is acceptable (the live app.js version is also async and called fire-and-forget). No change needed, but verify no caller depends on it being synchronous.

### 6b — Wire into app.js

- [ ] **Step 8: Add the import** to app.js:

```js
import { createSettingsModal } from "./settings-modal.js";
```

- [ ] **Step 9: Add to the module-init block, ABOVE the `createDrawerPanels` call** (drawer-panels ctx references `openSettingsModal`). Use a binding named `openSettingsModal` so existing references and drawer ctx resolve:

```js
const settingsModal = createSettingsModal({
  refs,
  getDashboard: () => lastDashboard,
  getCurrentProjectRoot: () => currentProjectRoot,
  showToast,
  loadDashboard,
  getLastFocused: () => lastFocused,
  setLastFocused: (el) => { lastFocused = el; },
});
const { openSettingsModal, closeSettingsModal, renderSettingsProviders, renderSettingsDetail, saveSettings } = settingsModal;
```

First confirm app.js has a `lastFocused` mutable var: `Grep "lastFocused" src/app-shell/app.js`. If it is a `let lastFocused`, the getter/setter above work. If absent, add `let lastFocused = null;` near the other state vars.

- [ ] **Step 10: Delete the inline settings code + now-dead `fetchOutputStyles`.** Grep boundaries, then delete from app.js: `SETTINGS_PROVIDERS` const (~2034), `settingsFields` const (~2039), and `openSettingsModal, closeSettingsModal, renderSettingsProviders, renderSettingsDetail, settingField, buildSecretReveal, buildSecretCopy, settingToggle, bindEndpointPreview, updateEndpointPreview, detectProviderPreset, saveSettings` (~2041-2366). Also delete `fetchOutputStyles` (~1577-1589) — it is now owned by the module; confirm no remaining app.js caller with `Grep "fetchOutputStyles" src/app-shell/app.js`. **Keep** `PROVIDER_PRESETS` at app.js:104 only if other app.js code uses it — `Grep "PROVIDER_PRESETS" src/app-shell/app.js`; if the only remaining hits were inside the deleted block, delete it too (the module has its own exported copy).

- [ ] **Step 11: Sanity-check**: `Select-String -Path src/app-shell/app.js -Pattern "function (saveSettings|renderSettingsDetail|openSettingsModal)\b|fetchOutputStyles"` → no matches.

- [ ] **Step 12: Verify** (unit + clickability). Expected: `fail 0`, `ok: true`. Clickability clicks the settings button + API-Key controls + network toggle. **Manually open settings and confirm the 输出风格 dropdown renders and saving persists it** (the reconciled feature).

- [ ] **Step 13: Commit**

```powershell
git add src/app-shell/settings-modal.js src/app-shell/app.js
git commit -m "refactor(app-shell): reconcile settings-modal output-style/model drift, wire into app.js"
```

---

## Task 7: Strip + wire in `composer.js` (LAST)

Make `composer.js` browser-safe, then wire it in and delete the inline composer logic + the 1261-1262 hardcode.

**Files:**
- Modify: `src/app-shell/composer.js` (strip core import)
- Modify: `src/app-shell/app.js` (wire + delete inline)

### 7a — Make composer.js browser-safe

- [ ] **Step 1: Delete the Node-only import.** Remove `composer.js:4`:

```js
import { activateConditionalSkillsForPaths } from "../core/skill-runtime.mjs";
```

- [ ] **Step 2: Delete `extractFilePathsFromMessage`** (composer.js:81-89).

- [ ] **Step 3: Delete the path-activation block** inside `submitComposer` (composer.js:226-232 — the `const involvedPaths = …` through the closing of the `if (involvedPaths.length > 0)` block). After this, `submitComposer` goes straight from `hideSlashMenu()`/side-question handling to `await submitWritingCommand(...)`.

- [ ] **Step 4: Confirm browser-safety**: `Grep "core/|node:" src/app-shell/composer.js` → no matches. `Grep "export function createComposer" src/app-shell/composer.js` → still present (keeps `verify-app-shell.mjs:200` green).

### 7b — Wire into app.js

- [ ] **Step 5: Add the import** to app.js:

```js
import { createComposer } from "./composer.js";
```

- [ ] **Step 6: Assign the forward-declared `composer`** at the END of the module-init block (after `settingsModal`, `threadRenderer`, `drawerPanels` exist), and destructure the methods app.js calls:

```js
composer = createComposer({
  refs,
  getCurrentProjectRoot: () => currentProjectRoot,
  loadDashboard,
  openCreateModal,
  openSettingsModal,
  openDrawer,
  showToast,
  showActionError,
  ensureRefreshLoop,
  threadRenderer,
  getAskEntries: () => askEntries,
});
const { submitComposer, autoGrowComposer, updateSlashMenu, onComposerKeydown, updateSubmitState, promoteAskEntry } = composer;
```

This must execute **before** the event-binding block (the `keydown` listener at ~149 passes `onComposerKeydown` by value). `threadRenderer` is passed as `ctx.threadRenderer` (it exposes `buildSideBubble` + `scrollThreadToBottom`, which composer's `submitSideQuestion` uses). `promoteAskEntry` destructured here satisfies the thread-renderer side-bubble button (Task 4's forward ref).

- [ ] **Step 7: Delete the inline composer block + dead constants.** Delete app.js constants `SIDE_QUESTION_PREFIXES`, `REVIEW_PREFIXES`, `WRITE_PREFIXES`, `MAIN_TASK_IMPACT_PATTERN`, `SLASH_COMMANDS` (~87-99). Delete the inline composer functions (~1121-1366): `parseUserCommand, matchCommandPrefix, detectMainTaskImpact, onComposerKeydown, autoGrowComposer, updateSubmitState, updateSlashMenu, buildSlashLabel, setSlashActive (+ its `let slashActiveIndex`), buildSlashItem, pickSlash, hideSlashMenu, submitComposer, submitWritingCommand, submitSideQuestion, promoteAskEntry, resultMessageForCommand`. Grep boundaries first; delete by exact text. The 1261-1262 `/chapters` / `/settings` hardcode lives inside `pickSlash` and is removed with it.

- [ ] **Step 8: Confirm the event bindings + remaining callers resolve.** The bindings at ~142/146/149/150-153 and the calls at ~1117 (`submitComposer`), ~2639/2640 (`autoGrowComposer`/`updateSubmitState`) now resolve to the destructured consts. The kept `buildSideBubble` is gone (moved to thread-renderer in Task 4), so the only `promoteAskEntry` reference is the destructured const. Sanity:

```powershell
Select-String -Path src/app-shell/app.js -Pattern "function (submitComposer|parseUserCommand|pickSlash)\b|SLASH_COMMANDS"
```

Expected: no matches.

- [ ] **Step 9: Verify** (unit + clickability). Expected: `fail 0`, `ok: true`. Clickability exercises the command bar / slash menu. **Manually confirm** `/chapters` opens the drawer and `/settings` opens settings (now via the registry `uiOnly` path, not the deleted hardcode), and that `/write` / `/review` / `/ask` submit correctly.

- [ ] **Step 10: Commit**

```powershell
git add src/app-shell/composer.js src/app-shell/app.js
git commit -m "refactor(app-shell): make composer.js browser-safe, wire into app.js, remove /chapters-/settings hardcode"
```

---

## Task 8: Full verification & green gate

**Files:** none.

- [ ] **Step 1: Unit suite**

```powershell
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | Select-Object -Last 5
```

Expected: `fail 0`.

- [ ] **Step 2: app-shell now GREEN**

```powershell
npm run verify:app-shell 2>&1 | Select-Object -Last 5
```

Expected: `ok: true` (all six import assertions 191-196 satisfied). If it fails, read the assertion message — it names the missing import.

- [ ] **Step 3: Clickability**

```powershell
npm run verify:app-clickability 2>&1 | Select-Object -Last 5
```

Expected: `ok: true`.

- [ ] **Step 4: Desktop shell**

```powershell
npm run verify:desktop-shell 2>&1 | Select-Object -Last 5
```

Expected: `ok: true`.

- [ ] **Step 5: Full local gate (before desktop-shortcut hand-off)**

```powershell
npm run verify:local 2>&1 | Select-Object -Last 10
```

Expected: pass. If the desktop shortcut points at a packaged exe, repackage so it picks up the source changes (see `CLAUDE.md`).

- [ ] **Step 6: Confirm acceptance criteria** (spec §8): app.js imports all six modules; no inline duplicate remains; no `../core/*`/`node:` import in any wired module; `/chapters`+`/settings` via registry; all gates green; no behavioral/visual change. The output-style dropdown still works (Task 6 reconciliation).

---

## Self-review notes (author)

- **Spec coverage:** every spec §3 sequencing item maps to Tasks 1-7; §4 non-goals respected (no `skill-runtime` path-activation change, no backend change); §5 invariants enforced (browser-safety Step 7.4 / 8.6; behavior via per-module verify; orphan grep each task); §7 verification = Task 8.
- **Drift:** only settings-modal required reconciliation (Task 6a); thread-renderer + drawer-panels verified faithful, wire-in only.
- **Cycle:** composer↔thread-renderer `promoteAskEntry`/`buildSideBubble` resolved via forward-declared `let composer` (Task 4 Step 2 / Task 7 Step 6).
- **Line drift:** all deletions name-anchored with a grep-locate instruction, since interleaved leaves + sequential deletes shift absolute line numbers.
- **Ordering caveat:** settings-modal init must sit above drawer-panels init in the block (drawer ctx uses `openSettingsModal`); composer init is last (uses threadRenderer/openDrawer/openSettingsModal). Called out in Tasks 5/6/7.
