# Settings Popover Rail Overlap Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix model ID editing, lingering Quick Rail info popovers, and the overlapping/confusing new-novel versus open-folder entry flow in the WWriting desktop shell.

**Architecture:** Keep the current vanilla app-shell structure and make narrowly scoped UI/runtime changes. The settings panel becomes a text input with preset suggestions, Quick Rail popovers become a module-level singleton with explicit cleanup, and the create modal receives a source mode so the two folder-related entry paths are distinct and verifiable.

**Tech Stack:** Electron, vanilla browser ESM, Node.js `node:test`, existing app-shell verification scripts.

---

## File Structure

- Modify: `src/app-shell/app.js`  
  Add editable model ID field support, create-modal source mode, and explicit calls for new/open folder flows.
- Modify: `src/app-shell/components/quick-rail.js`  
  Replace per-button tooltip state with a singleton popover cleanup API.
- Modify: `src/app-shell/styles.css`  
  Add stable rail entry spacing and optional create-mode/status styling without changing the visual system.
- Modify: `scripts/verify-app-shell.mjs`  
  Add static assertions for editable model field, Quick Rail cleanup, and create modal mode strings.
- Modify: `scripts/verify-app-clickability.cjs`  
  Add Electron interaction checks for custom model ID persistence, popover cleanup, create modal mode text, and rail button non-overlap.

## Execution Preconditions

- Run `git status --short` before editing.
- Treat existing dirty files as user work. Do not revert or rewrite unrelated hunks.
- If this plan is executed in the current workspace, inspect each target file before patching and stage only the intended hunks.
- Keep all changes dependency-free.

## Task 1: Make Model ID Editable While Keeping Preset Suggestions

**Files:**
- Modify: `src/app-shell/app.js`
- Modify: `scripts/verify-app-shell.mjs`
- Modify: `scripts/verify-app-clickability.cjs`

- [x] **Step 1: Add failing static assertions**

Add these assertions in `scripts/verify-app-shell.mjs` near the existing settings assertions:

```js
assert.ok(js.includes('settingField("模型", "model-id"'));
assert.ok(js.includes("settings-model-suggestions"));
assert.ok(js.includes("document.createElement(\"datalist\")"));
assert.ok(!js.includes('settingField("模型", "select"'));
```

- [x] **Step 2: Add failing Electron persistence check**

In `scripts/verify-app-clickability.cjs`, after the existing `settings-add` click and before `settings-api-key-reveal`, add:

```js
const customModelId = `writer-custom-${Date.now()}`;
await win.webContents.executeJavaScript(`
  (() => {
    const input = document.querySelector('[aria-label="模型"]');
    if (!input) throw new Error("settings model input missing");
    input.value = ${JSON.stringify(customModelId)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })();
`);
const modelInputTag = await read(win, `document.querySelector('[aria-label="模型"]')?.tagName`);
assert.equal(modelInputTag, "INPUT", "model field must be an editable input");
```

After the existing `settings-save` click, add:

```js
const savedModelName = await read(win, `
  fetch("/api/dashboard")
    .then((response) => response.json())
    .then((data) => data.project.active_model.model_name)
`);
assert.equal(savedModelName, customModelId, "custom model ID must persist through settings save");
```

- [x] **Step 3: Run the focused verification and confirm failure**

Run:

```powershell
npm run verify:app-shell
```

Expected: FAIL because `settingField("模型", "model-id"` and `settings-model-suggestions` do not exist yet.

- [x] **Step 4: Implement the model-id field**

In `src/app-shell/app.js`, change the model field creation in `renderSettingsDetail()` to:

```js
settingsFields.model = settingField("模型", "model-id", {
  options: preset.models,
  value: usingThisPreset && active.model_name ? active.model_name : (active.model_name || preset.models[0]),
  placeholder: "输入模型 ID，例如 deepseek-chat"
});
```

Then update `settingField()` with this branch before the existing `type === "select"` branch:

```js
  if (type === "model-id") {
    input = document.createElement("input");
    input.className = "spd-input";
    input.type = "text";
    input.value = value ?? "";
    input.placeholder = placeholder;
    input.setAttribute("list", "settings-model-suggestions");
    const datalist = document.createElement("datalist");
    datalist.id = "settings-model-suggestions";
    datalist.replaceChildren(...(options ?? []).map((opt) => {
      const option = document.createElement("option");
      option.value = opt;
      return option;
    }));
    field.append(input, datalist);
  } else if (type === "select") {
```

Keep the existing `input.setAttribute("aria-label", labelText);` after the branch so the input remains accessible.

- [x] **Step 5: Run focused verification**

Run:

```powershell
npm run verify:app-shell
npm run verify:app-clickability
```

Expected: PASS. The clickability run should save a generated custom model ID and read it back from `/api/dashboard`.

- [ ] **Step 6: Commit**

```powershell
git add src/app-shell/app.js scripts/verify-app-shell.mjs scripts/verify-app-clickability.cjs
git commit -m "fix: allow editable model ids in settings"
```

## Task 2: Remove Lingering Quick Rail Info Popovers

**Files:**
- Modify: `src/app-shell/components/quick-rail.js`
- Modify: `scripts/verify-app-shell.mjs`
- Modify: `scripts/verify-app-clickability.cjs`

- [x] **Step 1: Add failing static assertions**

Add these assertions in `scripts/verify-app-shell.mjs` near the Quick Rail or app-shell JS checks:

```js
assert.ok(quickRailJs.includes("let activePopover"));
assert.ok(quickRailJs.includes("function clearQuickRailPopover"));
assert.ok(quickRailJs.includes("window.addEventListener('blur'"));
assert.ok(quickRailJs.includes("window.addEventListener('resize'"));
assert.ok(!quickRailJs.includes("btn.title = slot.label"));
```

If `quickRailJs` is not already loaded in the script, load it near the other static asset reads:

```js
const quickRailJs = await fetchText(`http://127.0.0.1:${port}/components/quick-rail.js`);
```

- [x] **Step 2: Add failing Electron cleanup checks**

In `scripts/verify-app-clickability.cjs`, after the first Quick Rail click flow and before closing the drawer, add:

```js
await win.webContents.executeJavaScript(`
  (() => {
    const slot = document.querySelector('.quick-rail .qr-slot[data-key="chapters"]');
    slot.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    return true;
  })();
`);
await delay(260);
let popoverCount = await read(win, `document.querySelectorAll(".qr-popover").length`);
assert.equal(popoverCount, 1, "hovering a quick rail slot should create one popover");
await win.webContents.executeJavaScript(`
  (() => {
    const slot = document.querySelector('.quick-rail .qr-slot[data-key="chapters"]');
    slot.click();
    return true;
  })();
`);
await delay(120);
popoverCount = await read(win, `document.querySelectorAll(".qr-popover").length`);
assert.equal(popoverCount, 0, "clicking a quick rail slot must clear its popover");
```

Add a second cleanup check after `#drawer-close`:

```js
await win.webContents.executeJavaScript(`
  (() => {
    const slot = document.querySelector('.quick-rail .qr-slot[data-key="research"]');
    slot.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    return true;
  })();
`);
await delay(260);
await win.webContents.executeJavaScript(`window.dispatchEvent(new Event("blur")); true;`);
await delay(80);
assert.equal(await read(win, `document.querySelectorAll(".qr-popover").length`), 0, "window blur must clear quick rail popovers");
```

- [x] **Step 3: Run the focused verification and confirm failure**

Run:

```powershell
npm run verify:app-shell
```

Expected: FAIL because `quick-rail.js` still has local `pop` state and `btn.title = slot.label`.

- [x] **Step 4: Implement singleton cleanup in Quick Rail**

Replace `attachHoverPreview()` state in `src/app-shell/components/quick-rail.js` with module-level state:

```js
let activePopover = null;
let activeTimer = null;
let activeOwner = null;

export function clearQuickRailPopover() {
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }
  activeOwner = null;
}
```

At the start of `renderQuickRail()` add:

```js
  clearQuickRailPopover();
```

Remove the native title assignment:

```js
    btn.setAttribute('aria-label', slot.label);
```

Replace `attachHoverPreview()` with:

```js
function attachHoverPreview(btn, key, badges) {
  const show = () => {
    clearQuickRailPopover();
    const text = previewText(key, badges);
    if (!text) return;
    activeOwner = btn;
    activeTimer = setTimeout(() => {
      activeTimer = null;
      activePopover = document.createElement('div');
      activePopover.className = 'qr-popover';
      activePopover.textContent = text;
      document.body.appendChild(activePopover);
      const r = btn.getBoundingClientRect();
      activePopover.style.right = `${window.innerWidth - r.left + 8}px`;
      activePopover.style.top = `${r.top}px`;
    }, 200);
  };
  btn.addEventListener('mouseenter', show);
  btn.addEventListener('focus', show);
  btn.addEventListener('mouseleave', clearQuickRailPopover);
  btn.addEventListener('blur', clearQuickRailPopover);
  btn.addEventListener('click', clearQuickRailPopover);
  btn.addEventListener('pointerdown', clearQuickRailPopover);
}
```

Add global cleanup listeners once in the module:

```js
window.addEventListener('blur', clearQuickRailPopover);
window.addEventListener('resize', clearQuickRailPopover);
window.addEventListener('scroll', clearQuickRailPopover, true);
document.addEventListener('pointerdown', (event) => {
  if (activeOwner?.contains(event.target)) return;
  clearQuickRailPopover();
}, true);
```

- [x] **Step 5: Run focused verification**

Run:

```powershell
npm run verify:app-shell
npm run verify:app-clickability
```

Expected: PASS. Hovering a Quick Rail slot creates exactly one `.qr-popover`; clicking a slot or blurring the window clears it.

- [ ] **Step 6: Commit**

```powershell
git add src/app-shell/components/quick-rail.js scripts/verify-app-shell.mjs scripts/verify-app-clickability.cjs
git commit -m "fix: clean up quick rail popovers"
```

## Task 3: Separate New Novel And Open Folder Modal Modes

**Files:**
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`
- Modify: `scripts/verify-app-shell.mjs`
- Modify: `scripts/verify-app-clickability.cjs`

- [x] **Step 1: Add failing static assertions**

Add these assertions in `scripts/verify-app-shell.mjs` near the create modal checks:

```js
assert.ok(js.includes("let createModalMode = \"new\""));
assert.ok(js.includes("function renderCreateModalCopy"));
assert.ok(js.includes("mode: \"preview\""));
assert.ok(js.includes("mode: \"init-folder\""));
assert.ok(css.includes(".rail-new"));
assert.ok(css.includes(".rail-foot"));
```

- [x] **Step 2: Add failing Electron mode and overlap checks**

In `scripts/verify-app-clickability.cjs`, replace the simple `#open-folder` fallback expectation with:

```js
clicks.push(await clickAndRead(win, "#open-folder", {
  label: "open-folder-fallback",
  expect: () => read(win, `
    document.getElementById("create-scrim").classList.contains("show") === true &&
    document.getElementById("create-heading").textContent.includes("手动填写本地文件夹")
  `)
}));
```

After closing that modal and before clicking `#new-novel`, add:

```js
const railEntryGeometry = await read(win, `
  (() => {
    const newBtn = document.getElementById("new-novel");
    const openBtn = document.getElementById("open-folder");
    const a = newBtn.getBoundingClientRect();
    const b = openBtn.getBoundingClientRect();
    const separated = a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left;
    const newCenter = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
    const openCenter = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      separated,
      newHit: newBtn === newCenter || newBtn.contains(newCenter),
      openHit: openBtn === openCenter || openBtn.contains(openCenter)
    };
  })()
`);
assert.deepEqual(railEntryGeometry, { separated: true, newHit: true, openHit: true });
```

Update the `#new-novel` expectation to check the new-mode copy:

```js
expect: () => read(win, `
  document.getElementById("create-scrim").classList.contains("show") === true &&
  document.getElementById("create-heading").textContent.includes("开始一部新小说")
`)
```

- [x] **Step 3: Run focused verification and confirm failure**

Run:

```powershell
npm run verify:app-shell
```

Expected: FAIL because create modal mode state and render function do not exist yet.

- [x] **Step 4: Add create modal mode refs and state**

In `src/app-shell/app.js`, extend `refs`:

```js
  createHeading: document.querySelector("#create-heading"),
  createLead: document.querySelector("#create-card .lead"),
```

Near the existing modal state variables add:

```js
let createModalMode = "new";
```

- [x] **Step 5: Route entry points through explicit modes**

Change the new novel listener:

```js
refs.newNovel.addEventListener("click", () => openCreateModal(null, { mode: "new" }));
```

In `handleNav(key)`, change the new entry:

```js
if (key === "new") return openCreateModal(null, { mode: "new" });
```

In `openProject(projectRoot)`, change the invalid-folder fallback:

```js
openCreateModal(projectRoot, { mode: "init-folder" });
showToast("该文件夹不是项目，可初始化为新小说。", "info");
```

In `openFromFolder()`, change the no-desktop fallback:

```js
openCreateModal(null, { mode: "preview" });
showToast("预览环境请在弹窗中手动输入文件夹路径。", "info");
```

- [x] **Step 6: Render mode-specific create modal copy**

Replace `openCreateModal(prefillPath)` with:

```js
function openCreateModal(prefillPath, options = {}) {
  createModalMode = options.mode ?? (prefillPath ? "init-folder" : "new");
  setCreateStatus("", "");
  if (prefillPath) refs.createPath.value = prefillPath;
  renderCreateModalCopy();
  openOverlay(refs.createScrim, refs.createTitle);
  motion.openModal(refs.createScrim, document.querySelector("#create-card"));
}
```

Add this function near `openCreateModal()`:

```js
function renderCreateModalCopy() {
  const copy = {
    new: {
      heading: "开始一部新小说",
      lead: "告诉我故事的种子，应用会规划、起草、审稿、定稿，并把每一章保存为本地文件。",
      button: "开始创作",
      status: ""
    },
    "init-folder": {
      heading: "初始化此文件夹为小说",
      lead: "这个文件夹还不是 WWriting 项目。补充小说信息后，应用会在该文件夹内创建项目文件。",
      button: "初始化并打开",
      status: refs.createPath.value ? `将初始化：${refs.createPath.value}` : ""
    },
    preview: {
      heading: "手动填写本地文件夹",
      lead: "当前预览环境不能打开系统文件选择器，请手动输入一个空文件夹路径来创建小说。",
      button: "创建并打开",
      status: ""
    }
  }[createModalMode] ?? {
    heading: "开始一部新小说",
    lead: "告诉我故事的种子，应用会规划、起草、审稿、定稿，并把每一章保存为本地文件。",
    button: "开始创作",
    status: ""
  };
  refs.createHeading.textContent = copy.heading;
  refs.createLead.textContent = copy.lead;
  refs.createSubmit.textContent = copy.button;
  if (copy.status) setCreateStatus(copy.status, "");
}
```

- [x] **Step 7: Stabilize rail entry spacing**

In `src/app-shell/styles.css`, update the rail entry blocks:

```css
.rail-new {
  padding: 0 12px 10px;
  position: relative;
  z-index: 1;
}
```

```css
.rail-scroll {
  min-height: 0;
  overflow: auto;
  padding: 4px 8px 8px;
  position: relative;
}
```

```css
.rail-foot {
  border-top: 1px solid var(--line);
  padding: 8px;
  display: grid;
  gap: 2px;
  position: relative;
  z-index: 1;
  background: var(--rail);
}
```

- [x] **Step 8: Run focused verification**

Run:

```powershell
npm run verify:app-shell
npm run verify:app-clickability
```

Expected: PASS. The open-folder fallback shows “手动填写本地文件夹”, the new-novel path shows “开始一部新小说”, and the geometry assertion reports no overlap.

- [ ] **Step 9: Commit**

```powershell
git add src/app-shell/app.js src/app-shell/styles.css scripts/verify-app-shell.mjs scripts/verify-app-clickability.cjs
git commit -m "fix: separate create and open folder entry flows"
```

## Task 4: Full Regression Verification

**Files:**
- No source edits expected.

- [x] **Step 1: Run app-shell verification**

Run:

```powershell
npm run verify:app-shell
```

Expected: PASS.

- [x] **Step 2: Run Electron clickability verification**

Run:

```powershell
npm run verify:app-clickability
```

Expected: PASS.

- [x] **Step 3: Run desktop shell verification**

Run:

```powershell
npm run verify:desktop-shell
```

Expected: PASS.

- [x] **Step 4: Run unit tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [x] **Step 5: Run local verification before desktop handoff**

Run:

```powershell
npm run verify:local
```

Expected: PASS. If this command is too slow for an intermediate branch, record the last three commands above as passed and run `verify:local` before packaging or handing off a desktop shortcut.

## Self-Review Checklist

- Spec coverage: Task 1 covers editable model IDs; Task 2 covers lingering information popovers; Task 3 covers new/open folder separation and rail overlap; Task 4 covers regression verification.
- Placeholder scan: This plan contains concrete code, commands, and expected outcomes for every implementation step.
- Type consistency: The plan consistently uses `active_model.model_name`, `settingsFields.model.input`, `createModalMode`, `renderCreateModalCopy`, and `.qr-popover`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-01-settings-popover-rail-overlap-fixes.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.
