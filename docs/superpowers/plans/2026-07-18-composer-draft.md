# 输入框草稿功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 app-shell 输入框增加按项目隔离的草稿持久化（localStorage），切项目/重启可恢复，发送成功后清除。

**Architecture:** 新建 `composer-draft.mjs` 纯模块封装 save/load/clear（按 projectRoot 哈希分桶，复用 last-seen.js 的 hashKey，提取到 utils.js 共享）。composer.js 暴露 persistDraft/flushDraft/restoreDraftIfAny/clearDraftForCurrent 并重构清空逻辑；app.js 在 input 监听、项目切换、首次加载、pagehide 四个时机协调调用。

**Tech Stack:** 原生 ESM（浏览器侧 app-shell），node:test 单测，electron verify 脚本回归。

**Spec:** `docs/superpowers/specs/2026-07-18-composer-draft-design.md`

## Global Constraints

- 测试框架：`node:test` + `node:assert/strict`，测试文件 `.test.mjs`，命令 `npm test`（= `node --test tests/*.test.mjs tests/app-shell/*.test.mjs`）。
- 所有 localStorage 操作必须 try/catch 静默降级，不得抛错给用户。
- localStorage key 命名空间统一 `wwriting:` 前缀；草稿 key 为 `wwriting:composer:draft:${hashKey(projectRoot)}`。
- hashKey 算法必须与现有 `last-seen.js` 完全一致（FNV-1a + 长度），同一 root 产出同一 key。
- 改完 UI 必须跑 `npm run verify:app-clickability`、`npm run verify:app-shell`、`npm run verify:desktop-shell`（CLAUDE.md 硬要求）。
- `verify:app-clickability` 偶发 ok:false 多为既有 quick-rail/failure-card hover 抖动，重跑即绿；仍红再排查。

---

### Task 1: hashKey 提取到 utils.js 共享

**Files:**
- Modify: `src/app-shell/utils.js`（新增 `hashKey` 导出）
- Modify: `src/app-shell/components/last-seen.js`（删本地 hashKey，改 import）
- Test: `tests/app-shell/utils.test.mjs`（新建）

**Interfaces:**
- Produces: `hashKey(projectRoot: string): string` 从 `src/app-shell/utils.js` 导出。输出 12 位十六进制串（8 位 FNV-1a 哈希 + 4 位长度）。last-seen.js 与 composer-draft.mjs 都依赖它。

- [ ] **Step 1: 写 hashKey 失败测试**

创建 `tests/app-shell/utils.test.mjs`：

```js
import assert from "node:assert/strict";
import test from "node:test";
import { hashKey } from "../../src/app-shell/utils.js";

test("hashKey 对同一 projectRoot 稳定返回同一短 key", () => {
  assert.equal(
    hashKey("D:\\novels\\clock-shop"),
    hashKey("D:\\novels\\clock-shop"),
  );
});

test("hashKey 对不同 projectRoot 返回不同 key", () => {
  assert.notEqual(hashKey("D:\\novels\\a"), hashKey("D:\\novels\\b"));
});

test("hashKey 输出 12 位十六进制串", () => {
  assert.match(hashKey("D:\\novels\\clock-shop"), /^[0-9a-f]{12}$/u);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: `tests/app-shell/utils.test.mjs` 报错 `hashKey is not a function`（或 import 失败）。

- [ ] **Step 3: 在 utils.js 加 hashKey**

在 `src/app-shell/utils.js` 末尾追加（算法从 `last-seen.js` 原样复制，保证行为一致）：

```js
export function hashKey(projectRoot) {
  let h = 0x811c9dc5;
  for (let i = 0; i < projectRoot.length; i++) {
    h ^= projectRoot.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + projectRoot.length.toString(16).padStart(4, "0");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: `tests/app-shell/utils.test.mjs` 三个用例全 PASS。

- [ ] **Step 5: last-seen.js 改用共享 hashKey**

把 `src/app-shell/components/last-seen.js` 改为（删本地 hashKey 函数，改 import，其余行为不变）：

```js
import { hashKey } from "../utils.js";

export function getLastSeen(projectRoot, tab) {
  if (!projectRoot) return null;
  return localStorage.getItem(`wwriting:lastSeen:${hashKey(projectRoot)}:${tab}`);
}

export function setLastSeen(projectRoot, tab, ts = new Date().toISOString()) {
  if (!projectRoot) return;
  localStorage.setItem(`wwriting:lastSeen:${hashKey(projectRoot)}:${tab}`, ts);
}

export function watchLastSeen(callback) {
  window.addEventListener('storage', (e) => {
    if (e.key?.startsWith('wwriting:lastSeen:')) callback();
  });
}
```

- [ ] **Step 6: 跑 npm test 确认 last-seen 改动不回归**

Run: `npm test`
Expected: 全部测试 PASS（last-seen.js 无专属单测，靠整体绿确认未破坏 import）。

- [ ] **Step 7: 提交**

```bash
git add src/app-shell/utils.js src/app-shell/components/last-seen.js tests/app-shell/utils.test.mjs
git commit -m "refactor: extract hashKey to shared utils"
```

---

### Task 2: composer-draft.mjs 纯模块

**Files:**
- Create: `src/app-shell/composer-draft.mjs`
- Test: `tests/app-shell/composer-draft.test.mjs`（新建）

**Interfaces:**
- Consumes: `hashKey(projectRoot)` from `./utils.js`（Task 1 产出）
- Produces:
  - `saveDraft(projectRoot: string, text: string): void` — 空串等同清除；projectRoot 为空 no-op
  - `loadDraft(projectRoot: string): string` — 无草稿返回 `""`
  - `clearDraft(projectRoot: string): void`
  - `_setStorageForTest(storageOrFn): void` — 仅供测试注入 storage

- [ ] **Step 1: 写失败测试**

创建 `tests/app-shell/composer-draft.test.mjs`：

```js
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { saveDraft, loadDraft, clearDraft, _setStorageForTest } from "../../src/app-shell/composer-draft.mjs";
import { hashKey } from "../../src/app-shell/utils.js";

const ROOT_A = "D:\\novels\\clock-shop";
const ROOT_B = "D:\\novels\\star-dust";

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

beforeEach(() => {
  _setStorageForTest(createMemoryStorage());
});

test("saveDraft -> loadDraft 往返一致", () => {
  saveDraft(ROOT_A, "继续写第三章");
  assert.equal(loadDraft(ROOT_A), "继续写第三章");
});

test("saveDraft 空串等同清除", () => {
  saveDraft(ROOT_A, "半段话");
  saveDraft(ROOT_A, "");
  assert.equal(loadDraft(ROOT_A), "");
});

test("不同 projectRoot 互不干扰", () => {
  saveDraft(ROOT_A, "A 的话");
  saveDraft(ROOT_B, "B 的话");
  assert.equal(loadDraft(ROOT_A), "A 的话");
  assert.equal(loadDraft(ROOT_B), "B 的话");
});

test("clearDraft 后 loadDraft 返回空串", () => {
  saveDraft(ROOT_A, "待清");
  clearDraft(ROOT_A);
  assert.equal(loadDraft(ROOT_A), "");
});

test("projectRoot 为空时 no-op", () => {
  saveDraft("", "不应写入");
  assert.equal(loadDraft(""), "");
  clearDraft(""); // 不抛
});

test("草稿 key 命名为 wwriting:composer:draft:<hashKey>", () => {
  const captured = createMemoryStorage();
  _setStorageForTest(captured);
  saveDraft(ROOT_A, "校验 key");
  const expectedKey = "wwriting:composer:draft:" + hashKey(ROOT_A);
  assert.equal(captured.getItem(expectedKey), "校验 key");
});

test("storage 抛错时不崩（降级返回空串）", () => {
  const throwing = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
    removeItem() { throw new Error("denied"); },
    clear() {},
    key() { return null; },
    get length() { return 0; },
  };
  _setStorageForTest(throwing);
  saveDraft(ROOT_A, "不会崩");
  assert.equal(loadDraft(ROOT_A), "");
  clearDraft(ROOT_A); // 不抛
});

test("storage 为 null 时 no-op", () => {
  _setStorageForTest(() => null);
  saveDraft(ROOT_A, "无存储");
  assert.equal(loadDraft(ROOT_A), "");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: `tests/app-shell/composer-draft.test.mjs` 报错 `Cannot find module ... composer-draft.mjs`。

- [ ] **Step 3: 创建 composer-draft.mjs**

创建 `src/app-shell/composer-draft.mjs`：

```js
import { hashKey } from "./utils.js";

const DRAFT_PREFIX = "wwriting:composer:draft:";

// 默认走浏览器全局 localStorage；测试可通过 _setStorageForTest 注入。
let getStorage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
};

function draftKey(projectRoot) {
  return DRAFT_PREFIX + hashKey(projectRoot);
}

export function saveDraft(projectRoot, text) {
  if (!projectRoot) return;
  const s = getStorage();
  if (!s) return;
  const t = String(text ?? "");
  try {
    if (t === "") s.removeItem(draftKey(projectRoot));
    else s.setItem(draftKey(projectRoot), t);
  } catch {
    // 不可用则降级，不抛给调用方
  }
}

export function loadDraft(projectRoot) {
  if (!projectRoot) return "";
  const s = getStorage();
  if (!s) return "";
  try {
    return s.getItem(draftKey(projectRoot)) ?? "";
  } catch {
    return "";
  }
}

export function clearDraft(projectRoot) {
  if (!projectRoot) return;
  const s = getStorage();
  if (!s) return;
  try {
    s.removeItem(draftKey(projectRoot));
  } catch {
    // 不可用则降级
  }
}

// 仅供单元测试注入 storage；生产代码不调用。
export function _setStorageForTest(storageOrFn) {
  getStorage = typeof storageOrFn === "function" ? storageOrFn : () => storageOrFn;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: `tests/app-shell/composer-draft.test.mjs` 八个用例全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app-shell/composer-draft.mjs tests/app-shell/composer-draft.test.mjs
git commit -m "feat: add composer-draft persistence module"
```

---

### Task 3: composer.js + app.js 集成草稿

**Files:**
- Modify: `src/app-shell/composer.js`
- Modify: `src/app-shell/app.js`

**Interfaces:**
- Consumes: `saveDraft / loadDraft / clearDraft` from `./composer-draft.mjs`（Task 2 产出）
- Produces: composer 实例新增方法 `persistDraft()` / `flushDraft()` / `restoreDraftIfAny(projectRoot)` / `clearDraftForCurrent()`，供 app.js 调用。

**注意：** composer.js 与 app.js 依赖 DOM，无新增单测；靠现有 `npm test` 不回归 + `verify:app-clickability` 运行时验证。

- [ ] **Step 1: composer.js 顶部加 import**

在 `src/app-shell/composer.js` 第 6 行（`permission-tiers.mjs` import 之后）加：

```js
import { saveDraft, loadDraft, clearDraft } from "./composer-draft.mjs";
```

- [ ] **Step 2: composer.js 闭包内加草稿调度**

在 `createComposer` 内 `let slashActiveIndex = 0;`（第 52 行）之后加：

```js
  // --- 输入框草稿：按项目持久化，切走/重启可恢复 ---
  let draftTimer = null;
  const DRAFT_DEBOUNCE_MS = 200;

  function currentRoot() {
    return ctx.getCurrentProjectRoot();
  }

  function persistDraft() {
    if (!currentRoot()) return;
    if (draftTimer) window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => {
      draftTimer = null;
      saveDraft(currentRoot(), ctx.refs.composerInput.value);
    }, DRAFT_DEBOUNCE_MS);
  }

  function flushDraft() {
    if (draftTimer) { window.clearTimeout(draftTimer); draftTimer = null; }
    const root = currentRoot();
    if (root) saveDraft(root, ctx.refs.composerInput.value);
  }

  function clearDraftForCurrent() {
    if (draftTimer) { window.clearTimeout(draftTimer); draftTimer = null; }
    const root = currentRoot();
    if (root) clearDraft(root);
  }

  function restoreDraftIfAny(projectRoot) {
    const text = projectRoot ? loadDraft(projectRoot) : "";
    if (!text) return false;
    ctx.refs.composerInput.value = text;
    autoGrowComposer();
    updateSubmitState();
    try { ctx.refs.composerInput.focus(); } catch { /* 失焦不可用则忽略 */ }
    return true;
  }
```

- [ ] **Step 3: composer.js 抽 clearComposerInput 并替换 5 处清空**

在 `updateSubmitState` 函数（第 572 行）之后加私有 `clearComposerInput`：

```js
  // 统一清空输入框：清当前项目草稿 + value + 自适应高度 + 提交态 + 取消防抖。
  function clearComposerInput() {
    clearDraftForCurrent();
    ctx.refs.composerInput.value = "";
    autoGrowComposer();
    updateSubmitState();
  }
```

把以下 5 处 `ctx.refs.composerInput.value = ""` 三行块替换为 `clearComposerInput();`：

1. 第 648-650 行（uiOnly 命令分支，原为 `value = ""` + `updateSubmitState()` 两行）
2. 第 710-712 行（submitWritingCommand 成功）
3. 第 743-745 行（submitSideQuestion 成功）
4. 第 785-787 行（submitModelCommand 成功）
5. 第 823-825 行（sendChatMessageWithUX 清空）

每处替换前形如：
```js
      ctx.refs.composerInput.value = "";
      autoGrowComposer();
      updateSubmitState();
```
替换后：
```js
      clearComposerInput();
```

第 1 处（648-650）原无 `autoGrowComposer()`，也一并替换为 `clearComposerInput();`——其内部已含 autoGrowComposer，行为更完整，可接受。

- [ ] **Step 4: composer.js 发送失败还原后即时存草稿**

第 880-881 行：
```js
      ctx.refs.composerInput.value = savedContent;
      autoGrowComposer();
```
在其后加即时存草稿（不等防抖，断电也不丢）：

```js
      ctx.refs.composerInput.value = savedContent;
      autoGrowComposer();
      const failRoot = currentRoot();
      if (failRoot) saveDraft(failRoot, savedContent);
```

- [ ] **Step 5: composer.js 暴露新方法**

把 `return { ... }`（第 971 行）补上四个方法：

```js
  return {
    parseUserCommand, onComposerKeydown, autoGrowComposer, updateSubmitState,
    updateSlashMenu, hideSlashMenu, submitComposer, submitText, submitWritingCommand,
    startCurrentChapter,
    submitSideQuestion, promoteAskEntry, resultMessageForCommand,
    initModePill, updateModePill, openModePopover, closeModePopover,
    openModelPopover, closeModelPopover, updateStatusPills, sendChatMessageWithUX,
    syncChatBusy, isChatBusy,
    persistDraft, flushDraft, restoreDraftIfAny, clearDraftForCurrent
  };
```

- [ ] **Step 6: app.js 解构新方法**

`src/app-shell/app.js` 第 220 行现有解构改为：

```js
const { submitComposer, autoGrowComposer, updateSlashMenu, onComposerKeydown, updateSubmitState, promoteAskEntry, persistDraft, flushDraft, restoreDraftIfAny } = composer;
```

- [ ] **Step 7: app.js input listener 调 persistDraft**

第 300-302 行现有 input listener：

```js
refs.composerInput.addEventListener("input", () => {
  autoGrowComposer();
  updateSubmitState();
});
```

改为：

```js
refs.composerInput.addEventListener("input", () => {
  autoGrowComposer();
  updateSubmitState();
  persistDraft();
});
```

- [ ] **Step 8: app.js commitProjectSwitch 存旧恢复新**

第 594-598 行 `commitProjectSwitch`：

```js
function commitProjectSwitch(projectRoot) {
  projectScope.activate(projectRoot);
  currentProjectRoot = projectRoot;
  clearTransientState();
}
```

改为（flushDraft 在 currentProjectRoot 仍指向旧值时调用，存到旧项目；restoreDraftIfAny 在切到新值后调用，从新项目恢复）：

```js
function commitProjectSwitch(projectRoot) {
  // 切走前：把当前输入框内容存到旧项目草稿（currentProjectRoot 仍指向旧值）。
  flushDraft();
  projectScope.activate(projectRoot);
  currentProjectRoot = projectRoot;
  clearTransientState();
  // 切到新项目后：从新项目草稿恢复输入框。
  restoreDraftIfAny(currentProjectRoot);
}
```

- [ ] **Step 9: app.js renderDashboard firstLoad 恢复草稿**

第 811-819 行 firstLoad 分支：

```js
  const firstLoad = currentProjectRoot !== data.projectRoot;
  if (firstLoad) {
    // 切换/首次打开项目：重置对话流，按事件重建历史。
    renderedKeys.clear();
    liveBlock = null;
    refs.thread.replaceChildren();
  }
  currentProjectRoot = data.projectRoot;
```

在 `currentProjectRoot = data.projectRoot;` 之后加恢复（应用启动自动加载上次项目时不走 commitProjectSwitch，靠这里恢复）：

```js
  const firstLoad = currentProjectRoot !== data.projectRoot;
  if (firstLoad) {
    renderedKeys.clear();
    liveBlock = null;
    refs.thread.replaceChildren();
  }
  currentProjectRoot = data.projectRoot;
  if (firstLoad) {
    restoreDraftIfAny(currentProjectRoot);
  }
```

- [ ] **Step 10: app.js 注册 pagehide/visibilitychange 兜底存草稿**

在 app.js 现有 event listener 注册区（第 299 行 input listener 附近）加：

```js
window.addEventListener("pagehide", flushDraft);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushDraft();
});
```

- [ ] **Step 11: 跑 npm test 确认不回归**

Run: `npm test`
Expected: 全部测试 PASS（无新增 DOM 单测，靠现有测试绿确认未破坏纯逻辑与 import）。

- [ ] **Step 12: 跑 verify:app-shell**

Run: `npm run verify:app-shell`
Expected: 绿。

- [ ] **Step 13: 跑 verify:app-clickability（关键防线）**

Run: `npm run verify:app-clickability`
Expected: 绿。它启动真实 Electron 窗口逐个点击输入框/发送/导航等路径，确认草稿逻辑没搞坏点击链路。若 ok:false，先重跑一次排除 hover 抖动；仍红再排查。

- [ ] **Step 14: 提交**

```bash
git add src/app-shell/composer.js src/app-shell/app.js
git commit -m "feat: persist composer draft per project"
```

---

### Task 4: 桌面壳回归 + 验收对照

**Files:**
- 无新改动；本任务只跑验证脚本并对照验收标准。

- [ ] **Step 1: 跑 verify:desktop-shell**

Run: `npm run verify:desktop-shell`
Expected: 绿。

- [ ] **Step 2: 跑全量 npm test**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 3: 逐条对照验收标准（spec 第 11 节）**

1. A 项目输入框打字 -> 切 B -> 切回 A，字还在。（verify:app-clickability 覆盖部分；可手动补验）
2. A 项目打字 -> 重启应用打开 A，字还在。
3. 输入框打字 -> 发送成功 -> 输入框空、localStorage draft key 被删。
4. 输入框打字 -> 发送失败 -> 字还原、草稿已存。
5. 无项目时打字 -> 不写 draft key。
6. localStorage 不可用 -> 不崩。
7. verify:app-clickability / verify:app-shell / verify:desktop-shell 全绿。

- [ ] **Step 4: 若验证中发现问题则修复并 commit；否则跳过**

```bash
git add -A
git commit -m "test: verify composer draft regression"
```
（仅在 Step 1-3 有修复时执行。）

---

## Self-Review

**1. Spec coverage:**
- D1-D10 决策：Task 2（模块）+ Task 3（集成）覆盖。
- 第 6 节模块设计：Task 2 完整实现（hashKey 提取到 utils.js 而非新建 utils/ 目录，是对 spec 6 节/7.3 节的微调，理由：utils.js 已是单文件纯函数集合，更贴合现有结构）。
- 第 7 节集成点：Task 3 覆盖 composer.js（7.1）+ app.js（7.2）+ hashKey 提取（7.3，Task 1）。
- 第 10 节测试策略：Task 1/2 单测 + Task 3/4 verify 回归。
- 第 11 节验收标准：Task 4 Step 3 逐条对照。
- 第 12 节非目标：均未实现（无历史、无 UI 提示、无服务端、无同步）。

**2. Placeholder scan:** 无 TBD/TODO；每步含具体代码或命令。

**3. Type consistency:**
- `hashKey(projectRoot): string` — Task 1 定义，Task 2 composer-draft.mjs 消费。
- `saveDraft/loadDraft/clearDraft` — Task 2 定义，Task 3 composer.js 消费。
- `persistDraft/flushDraft/restoreDraftIfAny/clearDraftForCurrent` — Task 3 composer.js 暴露，app.js 消费。
- `clearComposerInput` — Task 3 定义并替换 5 处。
