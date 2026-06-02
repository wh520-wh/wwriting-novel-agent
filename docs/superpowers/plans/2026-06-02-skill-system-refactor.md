# Skill System Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 WWriting 的 slash 命令、技能、副作用与输出风格从硬编码升级为声明式注册表 + frontmatter 协议 + 全局事件总线 + 多源发现 + 路径条件激活。

**Architecture:**
- B1: 新建 `src/app-shell/command-registry.mjs` + `src/app-shell/commands/*.mjs`，把 composer.js 的 5 个 slash 命令抽成数据驱动的注册表
- B2: 在 `src/core/skill-runtime.mjs` 加 `paths` 字段与 `parseSkillPaths` / `activateConditionalSkillsForPaths` 两个 export
- B3: 在 `src/core/skill-runtime.mjs` 加 `resolveSkillSources`，5 来源优先级 + realpath dedup
- B4: 新建 `src/core/event-bus.mjs`，5 个 CORE_EVENTS 枚举 + on/off/emit；把 cost-tracker / event-log / failures-store 的直接调用迁移为订阅
- B5: 新建 `src/app-shell/output-style-loader.mjs`，3 来源加载 frontmatter 风格文件，settings-modal 加下拉，prompt-compiler 拼装

**Tech Stack:** Node.js 24+ ES modules, Electron 42, vanilla app-shell, Node built-in test runner, `ignore` npm package (gitignore matching), `fs.promises.realpath` for symlink dedup.

**Source Spec:** `docs/superpowers/specs/2026-06-02-skill-system-refactor-design.md`

**Commit Strategy:** Do not use `git add -A`. Stage files by task group only after review.

---

## File Structure Overview

### New Files (15)

| File | Responsibility | Task |
|---|---|---|
| `src/app-shell/command-registry.mjs` | Map + signal, 5 methods, 2 error classes | T2 |
| `src/app-shell/commands/_schema.mjs` | schema 校验 helpers | T3 |
| `src/app-shell/commands/write.mjs` | /write 命令对象 | T4 |
| `src/app-shell/commands/review.mjs` | /review 命令对象 | T4 |
| `src/app-shell/commands/ask.mjs` | /ask 命令对象 | T4 |
| `src/app-shell/commands/chapters.mjs` | /chapters UI-only 命令 | T4 |
| `src/app-shell/commands/settings.mjs` | /settings UI-only 命令 | T4 |
| `src/app-shell/commands/index.mjs` | 一次性 registerCommand × 5 | T5 |
| `src/core/event-bus.mjs` | 5 事件 + on/off/emit | T16 |
| `src/app-shell/output-style-loader.mjs` | 3 来源 + frontmatter | T22 |
| `tests/command-registry.test.mjs` | B1 测试 | T2 |
| `tests/skill-runtime-paths.test.mjs` | B2 测试 | T12 |
| `tests/skill-runtime-sources.test.mjs` | B3 测试 | T9 |
| `tests/event-bus.test.mjs` | B4 测试 | T16 |
| `tests/output-style-loader.test.mjs` | B5 测试 | T22 |

### Modified Files (11)

| File | Change | Task |
|---|---|---|
| `src/app-shell/composer.js` | SLASH_COMMANDS 改用 listCommands;pickSlash 改用 getCommand | T6 |
| `src/app-shell/quick-rail.js` | 快捷按钮从注册表取 | T7 |
| `src/core/skill-runtime.mjs` | + parseSkillPaths / activateConditionalSkillsForPaths / resolveSkillSources | T9, T12, T13 |
| `src/core/agent-engine.mjs` | 3 处 emit (model-call:start / model-call:complete / chapter:written) | T20 |
| `src/core/cost-tracker.mjs` | 订阅 model-call:complete 替代直接调用 | T17 |
| `src/core/event-log.mjs` | 订阅 task:failed / chapter:written | T18 |
| `src/core/failures-store.mjs` | 订阅 task:failed | T19 |
| `src/app-shell/settings-modal.js` | 加"输出风格"下拉 | T23 |
| `src/core/prompt-compiler.mjs` | system prompt 拼装追加 outputStyle | T24 |
| `src/core/app-state.mjs` | settings.outputStyle 字段 | T24 |
| `package.json` | 加 `ignore` 依赖 | T9 |

### Confirmed Existing APIs (do not recreate)

- `src/app-shell/api-client.js` exports `postJson` (used by all backend commands)
- `src/core/skill-runtime.mjs` has `BUILTIN_SKILLS`, `normalizeSkillManifest`, `normalizeHook`, `readSkillManifest`, `parseSkillManifest`, `parseSkillYaml`, `loadEnabledSkills`, `listProjectSkills`, `ensureBuiltinSkill`, `importProjectSkill` — KEEP ALL
- `src/core/event-log.mjs` has `appendEvent(projectRoot, event)` — KEEP signature
- `src/core/failures-store.mjs` has `appendFailure(projectRoot, card)` and `readFailures(projectRoot)` — KEEP signatures
- `src/core/cost-tracker.mjs` has `recordUsage(usage, model, options?)` — KEEP signature
- `src/app-shell/composer.js` exports `createComposer(ctx)` — KEEP signature

---

## Task 1: Pre-work Verification

**Files:** none modified.

- [ ] **Step 1: Verify clean baseline**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -10
```

Expected: `tests 60+` / `pass 60+` / `fail 0`. (Current M1 baseline: 60+ tests passing.)

- [ ] **Step 2: Verify clickability baseline**

```bash
cd D:/WWriting
npm run verify:app-clickability 2>&1 | tail -5
```

Expected: `ok: true`.

- [ ] **Step 3: Read composer.js current state**

Read `src/app-shell/composer.js` lines 1-220 to confirm 5 slash commands (`/write`, `/review`, `/ask`, `/chapters`, `/settings`) and their handler logic.

- [ ] **Step 4: Read skill-runtime.mjs current state**

Read `src/core/skill-runtime.mjs` lines 1-100 to confirm `BUILTIN_SKILLS` dict, `normalizeSkillManifest`, and existing `loadEnabledSkills` signature.

- [ ] **Step 5: Confirm `ignore` package not yet installed**

```bash
cd D:/WWriting
grep -q '"ignore"' package.json && echo "ALREADY INSTALLED" || echo "NEEDS INSTALL"
```

Expected: `NEEDS INSTALL`. If `ALREADY INSTALLED` skip Task 9 Step 1's `npm install`.

---

## Task 2: Create command-registry.mjs (TDD)

**Files:**
- Create: `tests/command-registry.test.mjs`
- Create: `src/app-shell/command-registry.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/command-registry.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerCommand,
  unregisterCommand,
  getCommand,
  listCommands,
  onCommandsChanged,
  CommandValidationError,
  CommandNotAllowed,
  __resetRegistry
} from "../src/app-shell/command-registry.mjs";

function noop() {}

test.beforeEach(() => {
  __resetRegistry();
});

const sampleCmd = {
  name: "sample",
  category: "writing",
  description: "test",
  userInvocable: true,
  isConcurrencySafe: true,
  isReadOnly: false,
  run: async () => ({ ok: true }),
};

test("registerCommand stores and broadcasts on first add", () => {
  let count = 0;
  onCommandsChanged(() => count++);
  registerCommand({ ...sampleCmd });
  assert.equal(count, 1);
});

test("registerCommand overwriting same name does not re-broadcast", () => {
  let count = 0;
  onCommandsChanged(() => count++);
  registerCommand({ ...sampleCmd });
  registerCommand({ ...sampleCmd, description: "v2" });
  assert.equal(count, 1);
  assert.equal(getCommand("sample").description, "v2");
});

test("unregisterCommand removes and broadcasts", () => {
  let count = 0;
  onCommandsChanged(() => count++);
  registerCommand({ ...sampleCmd });
  unregisterCommand("sample");
  assert.equal(count, 2);
  assert.equal(getCommand("sample"), undefined);
});

test("unregisterCommand on missing name is a no-op (no broadcast)", () => {
  let count = 0;
  onCommandsChanged(() => count++);
  unregisterCommand("nope");
  assert.equal(count, 0);
});

test("getCommand returns undefined for unknown", () => {
  assert.equal(getCommand("nope"), undefined);
});

test("listCommands filters by category", () => {
  registerCommand({ ...sampleCmd, name: "a", category: "writing" });
  registerCommand({ ...sampleCmd, name: "b", category: "review" });
  const writing = listCommands({ category: "writing" });
  assert.equal(writing.length, 1);
  assert.equal(writing[0].name, "a");
});

test("listCommands filters by userInvocable", () => {
  registerCommand({ ...sampleCmd, name: "a", userInvocable: true });
  registerCommand({ ...sampleCmd, name: "b", userInvocable: false });
  const visible = listCommands({ userInvocable: true });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].name, "a");
});

test("listCommands skips commands whose isEnabled returns false", () => {
  registerCommand({ ...sampleCmd, isEnabled: () => false });
  assert.equal(listCommands().length, 0);
});

test("listCommands returns enabled by default", () => {
  registerCommand({ ...sampleCmd, isEnabled: () => true });
  assert.equal(listCommands().length, 1);
});

test("registerCommand throws CommandValidationError when name missing", () => {
  assert.throws(() => registerCommand({ run: noop }), CommandValidationError);
});

test("registerCommand throws CommandValidationError when run missing", () => {
  assert.throws(() => registerCommand({ name: "x" }), CommandValidationError);
});

test("registerCommand throws when cmd is null", () => {
  assert.throws(() => registerCommand(null), CommandValidationError);
});

test("canUse returning false throws CommandNotAllowed at run-time", async () => {
  registerCommand({
    ...sampleCmd,
    canUse: () => false,
  });
  const cmd = getCommand("sample");
  await assert.rejects(cmd.run({}, {}), CommandNotAllowed);
});
```

- [ ] **Step 2: Run the test to verify it fails (import will fail)**

```bash
cd D:/WWriting
node --test tests/command-registry.test.mjs 2>&1 | tail -10
```

Expected: tests fail with `Cannot find module '../src/app-shell/command-registry.mjs'`.

- [ ] **Step 3: Create the implementation**

Create `src/app-shell/command-registry.mjs`:

```js
// 声明式 slash 命令注册表
// 单一职责:存储命令 + 广播变更,无业务逻辑
const commands = new Map();
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error("onCommandsChanged listener threw:", e);
    }
  }
}

function validateCommand(cmd) {
  if (!cmd || typeof cmd !== "object") {
    throw new CommandValidationError("command must be an object");
  }
  if (!cmd.name || typeof cmd.name !== "string") {
    throw new CommandValidationError("command.name must be a non-empty string");
  }
  if (typeof cmd.run !== "function") {
    throw new CommandValidationError(`command.run must be a function (name=${cmd.name})`);
  }
}

export function registerCommand(cmd) {
  validateCommand(cmd);
  const existed = commands.has(cmd.name);
  commands.set(cmd.name, cmd);
  if (!existed) notify();
}

export function unregisterCommand(name) {
  if (commands.delete(name)) notify();
}

export function getCommand(name) {
  return commands.get(name);
}

export function listCommands(filter = {}) {
  return [...commands.values()].filter((cmd) => {
    if (filter.category && cmd.category !== filter.category) return false;
    if (filter.userInvocable !== undefined && cmd.userInvocable !== filter.userInvocable) return false;
    if (typeof cmd.isEnabled === "function" && !cmd.isEnabled()) return false;
    return true;
  });
}

export function onCommandsChanged(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Wrap a command's run with canUse enforcement
function withPermissionCheck(cmd) {
  if (typeof cmd.canUse !== "function") return cmd;
  const originalRun = cmd.run;
  return {
    ...cmd,
    run: async (input, ctx) => {
      if (!cmd.canUse(ctx)) {
        throw new CommandNotAllowed(`command "${cmd.name}" not allowed in current context`);
      }
      return originalRun(input, ctx);
    },
  };
}

export class CommandValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandValidationError";
  }
}

export class CommandNotAllowed extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandNotAllowed";
  }
}

// Test-only: reset internal state
export function __resetRegistry() {
  commands.clear();
  listeners.clear();
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd D:/WWriting
node --test tests/command-registry.test.mjs 2>&1 | tail -10
```

Expected: all tests pass, `# pass 12`.

- [ ] **Step 5: Commit**

```bash
cd D:/WWriting
git add tests/command-registry.test.mjs src/app-shell/command-registry.mjs
git commit -m "feat(skill-system): add command-registry with TDD (B1 foundation)"
```

---

## Task 3: Create _schema.mjs (Schema Helpers)

**Files:**
- Create: `src/app-shell/commands/_schema.mjs`

> Note: This is not pure TDD because the helpers are pure functions without complex branching. Tested via integration in T6/T7. Code is small and obvious.

- [ ] **Step 1: Create the file**

Create `src/app-shell/commands/_schema.mjs`:

```js
// 共享 helpers for command definitions
// 不引 zod,手写最小校验

export const ALLOWED_CATEGORIES = new Set([
  "writing",
  "editing",
  "review",
  "research",
  "project",
]);

export function assertValidCategory(category) {
  if (!ALLOWED_CATEGORIES.has(category)) {
    throw new Error(
      `Invalid command category: ${category}. Must be one of: ${[...ALLOWED_CATEGORIES].join(", ")}`
    );
  }
}

export function hasActiveProject(ctx) {
  if (!ctx) return false;
  if (typeof ctx.getCurrentProjectRoot === "function") {
    return ctx.getCurrentProjectRoot() != null;
  }
  return false;
}
```

- [ ] **Step 2: Commit**

```bash
cd D:/WWriting
git add src/app-shell/commands/_schema.mjs
git commit -m "feat(skill-system): add _schema helpers for command definitions"
```

---

## Task 4: Create 5 Command Definition Files

**Files:**
- Create: `src/app-shell/commands/write.mjs`
- Create: `src/app-shell/commands/review.mjs`
- Create: `src/app-shell/commands/ask.mjs`
- Create: `src/app-shell/commands/chapters.mjs`
- Create: `src/app-shell/commands/settings.mjs`

- [ ] **Step 1: Create write.mjs**

Create `src/app-shell/commands/write.mjs`:

```js
import { postJson } from "../api-client.js";
import { assertValidCategory, hasActiveProject } from "./_schema.mjs";

assertValidCategory("writing");

export const writeCommand = {
  name: "write",
  category: "writing",
  description: "把指令作为正式写作任务交给智能体",
  userFacingName: () => "开始/续写",
  userInvocable: true,
  icon: "compose",
  slashKey: "/write",
  altKeys: ["/写作"],
  isConcurrencySafe: false,
  isReadOnly: false,
  isEnabled: () => true,
  canUse: (ctx) => hasActiveProject(ctx),
  run: async (input, ctx) => {
    const message = String(input?.message ?? "").trim();
    if (!message) {
      throw new Error("write: message is required");
    }
    return await postJson("/api/commands/submit", {
      message,
      mode: "write",
      fromSideQuestion: false,
    });
  },
  renderResult: (output, _ctx) => ({
    kind: "write-submitted",
    message: output?.message ?? "",
  }),
};
```

- [ ] **Step 2: Create review.mjs**

Create `src/app-shell/commands/review.mjs`:

```js
import { postJson } from "../api-client.js";
import { assertValidCategory, hasActiveProject } from "./_schema.mjs";

assertValidCategory("review");

export const reviewCommand = {
  name: "review",
  category: "review",
  description: "检查节奏、连贯性、设定一致性",
  userFacingName: () => "审稿修订",
  userInvocable: true,
  icon: "check",
  slashKey: "/review",
  altKeys: ["/审稿"],
  isConcurrencySafe: false,
  isReadOnly: false,
  isEnabled: () => true,
  canUse: (ctx) => hasActiveProject(ctx),
  run: async (input, ctx) => {
    const message = String(input?.message ?? "").trim();
    if (!message) {
      throw new Error("review: message is required");
    }
    return await postJson("/api/commands/submit", {
      message,
      mode: "review",
      fromSideQuestion: false,
    });
  },
  renderResult: (output, _ctx) => ({
    kind: "review-submitted",
    message: output?.message ?? "",
  }),
};
```

- [ ] **Step 3: Create ask.mjs**

Create `src/app-shell/commands/ask.mjs`:

```js
import { postJson } from "../api-client.js";
import { assertValidCategory, hasActiveProject } from "./_schema.mjs";

assertValidCategory("writing");

export const askCommand = {
  name: "ask",
  category: "writing",
  description: "临时提问，不修改正文、不打断写作",
  userFacingName: () => "旁路询问",
  userInvocable: true,
  icon: "help",
  slashKey: "/ask",
  altKeys: ["/side", "/q"],
  isConcurrencySafe: true,
  isReadOnly: true,
  isEnabled: () => true,
  canUse: (ctx) => hasActiveProject(ctx),
  run: async (input, _ctx) => {
    const question = String(input?.message ?? "").trim();
    if (!question) {
      throw new Error("ask: question is required");
    }
    return await postJson("/api/commands/ask", { question });
  },
  renderResult: (output, _ctx) => ({
    kind: "ask-submitted",
    question: output?.question ?? "",
  }),
};
```

- [ ] **Step 4: Create chapters.mjs**

Create `src/app-shell/commands/chapters.mjs`:

```js
import { assertValidCategory } from "./_schema.mjs";

assertValidCategory("project");

export const chaptersCommand = {
  name: "chapters",
  category: "project",
  description: "在右侧面板查看本地章节文件",
  userFacingName: () => "打开章节",
  userInvocable: true,
  icon: "book",
  slashKey: "/chapters",
  isConcurrencySafe: true,
  isReadOnly: true,
  isEnabled: () => true,
  run: async (_input, ctx) => {
    if (typeof ctx?.openDrawer !== "function") {
      throw new Error("chapters: ctx.openDrawer is required");
    }
    ctx.openDrawer("chapters");
    return { kind: "drawer-opened", panel: "chapters" };
  },
  renderResult: (_output, _ctx) => null,
};
```

- [ ] **Step 5: Create settings.mjs**

Create `src/app-shell/commands/settings.mjs`:

```js
import { assertValidCategory } from "./_schema.mjs";

assertValidCategory("project");

export const settingsCommand = {
  name: "settings",
  category: "project",
  description: "配置供应商、API Key、预算与联网",
  userFacingName: () => "模型设置",
  userInvocable: true,
  icon: "settings",
  slashKey: "/settings",
  isConcurrencySafe: true,
  isReadOnly: true,
  isEnabled: () => true,
  run: async (_input, ctx) => {
    if (typeof ctx?.openSettingsModal !== "function") {
      throw new Error("settings: ctx.openSettingsModal is required");
    }
    ctx.openSettingsModal();
    return { kind: "modal-opened", modal: "settings" };
  },
  renderResult: (_output, _ctx) => null,
};
```

- [ ] **Step 6: Commit**

```bash
cd D:/WWriting
git add src/app-shell/commands/write.mjs src/app-shell/commands/review.mjs src/app-shell/commands/ask.mjs src/app-shell/commands/chapters.mjs src/app-shell/commands/settings.mjs
git commit -m "feat(skill-system): add 5 command definitions (write/review/ask/chapters/settings)"
```

---

## Task 5: Create commands/index.mjs (Bulk Register)

**Files:**
- Create: `src/app-shell/commands/index.mjs`

- [ ] **Step 1: Create the file**

Create `src/app-shell/commands/index.mjs`:

```js
import { registerCommand } from "../command-registry.mjs";
import { writeCommand } from "./write.mjs";
import { reviewCommand } from "./review.mjs";
import { askCommand } from "./ask.mjs";
import { chaptersCommand } from "./chapters.mjs";
import { settingsCommand } from "./settings.mjs";

// 模块加载副作用:一次性注册 5 个内置 slash 命令
registerCommand(writeCommand);
registerCommand(reviewCommand);
registerCommand(askCommand);
registerCommand(chaptersCommand);
registerCommand(settingsCommand);

export {
  writeCommand,
  reviewCommand,
  askCommand,
  chaptersCommand,
  settingsCommand,
};
```

- [ ] **Step 2: Commit**

```bash
cd D:/WWriting
git add src/app-shell/commands/index.mjs
git commit -m "feat(skill-system): bulk register 5 built-in slash commands"
```

---

## Task 6: Wire composer.js to Use Registry

**Files:**
- Modify: `src/app-shell/composer.js`

- [ ] **Step 1: Add import at top of composer.js**

Edit `src/app-shell/composer.js`, replace line 1-2:

```js
import { icon } from "./icons.js";
import { postJson } from "./api-client.js";
```

with:

```js
import { icon } from "./icons.js";
import { postJson } from "./api-client.js";
import { getCommand, listCommands } from "./command-registry.mjs";
import "./commands/index.mjs";  // side-effect: register 5 built-in commands
```

- [ ] **Step 2: Add helper `commandsForSlashMenu` after `SIDE_QUESTION_PREFIXES` declaration**

After line 9 (end of `MAIN_TASK_IMPACT_PATTERN`), insert:

```js
// 动态从注册表取 slash 菜单项,避免硬编码
function commandsForSlashMenu(query) {
  const all = listCommands({ userInvocable: true });
  const q = (query || "").toLowerCase();
  return all
    .filter((cmd) => cmd.slashKey && cmd.slashKey.toLowerCase().startsWith(q))
    .map((cmd) => ({
      key: cmd.slashKey,
      title: cmd.userFacingName(),
      desc: cmd.description,
      icon: cmd.icon ?? "default",
    }));
}
```

- [ ] **Step 3: Replace SLASH_COMMANDS usage in `updateSlashMenu`**

In composer.js, find line 106 (the `SLASH_COMMANDS.filter((cmd) => cmd.key.startsWith(q))` line) and replace it. Replace the entire `updateSlashMenu` function body (lines 99-115) with:

```js
function updateSlashMenu() {
  const value = ctx.refs.composerInput.value;
  if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) {
    hideSlashMenu();
    return;
  }
  const matches = commandsForSlashMenu(value);
  if (matches.length === 0) {
    hideSlashMenu();
    return;
  }
  ctx.refs.slashMenu.replaceChildren(buildSlashLabel(), ...matches.map(buildSlashItem));
  ctx.refs.slashMenu.hidden = false;
  ctx.refs.composerInput.setAttribute("aria-expanded", "true");
  setSlashActive(0);
}
```

- [ ] **Step 4: Replace `pickSlash` to look up from registry**

Find `pickSlash` function (lines 161-169) and replace with:

```js
function pickSlash(item) {
  hideSlashMenu();
  const cmd = getCommand(item.name);
  if (!cmd) {
    ctx.showToast(`未知命令: ${item.key}`, "error");
    return;
  }
  // UI-only 命令:直接 run,input 留空
  if (cmd.isReadOnly && cmd.icon && (cmd.icon === "book" || cmd.icon === "settings")) {
    cmd.run({}, ctx).catch((err) => ctx.showActionError(err));
    ctx.refs.composerInput.value = "";
    updateSubmitState();
    return;
  }
  ctx.refs.composerInput.value = `${item.key} `;
  ctx.refs.composerInput.focus();
  autoGrowComposer();
  updateSubmitState();
}
```

- [ ] **Step 5: Update `buildSlashItem` to set `data-name` for look-up**

Find `buildSlashItem` function (line 136-159), and inside the `button.addEventListener("click", () => pickSlash(cmd))` line, replace with:

```js
  button.dataset.name = item.name;  // for pickSlash registry lookup
  button.addEventListener("click", () => pickSlash(item));
```

(Where `cmd` becomes `item` — the whole function is being kept; only the click handler needs `dataset.name`.)

- [ ] **Step 6: Run unit test for command-registry (regression check)**

```bash
cd D:/WWriting
node --test tests/command-registry.test.mjs 2>&1 | tail -5
```

Expected: 12 tests pass.

- [ ] **Step 7: Run clickability verification**

```bash
cd D:/WWriting
npm run verify:app-clickability 2>&1 | tail -5
```

Expected: `ok: true`. If the 5 slash commands are not in the clickability probe, the test must pass anyway because the composer module loads and registers commands without breaking existing UI.

- [ ] **Step 8: Commit**

```bash
cd D:/WWriting
git add src/app-shell/composer.js
git commit -m "refactor(skill-system): wire composer.js to use command-registry (B1)"
```

---

## Task 7: Wire quick-rail.js to Use Registry

**Files:**
- Modify: `src/app-shell/quick-rail.js`

- [ ] **Step 1: Read current quick-rail.js to understand the existing structure**

Read `src/app-shell/quick-rail.js` and identify the section that builds shortcut buttons. Look for any hard-coded command names.

- [ ] **Step 2: Add registry import and use it for shortcut list**

If quick-rail.js has a hardcoded list of shortcuts, replace with:

```js
import { listCommands } from "./command-registry.mjs";
import "./commands/index.mjs";

// 替换任何 hard-coded 列表:
const shortcuts = listCommands({ userInvocable: true })
  .filter((cmd) => cmd.shortcut)  // only commands with a shortcut
  .map((cmd) => ({
    name: cmd.name,
    title: cmd.userFacingName(),
    icon: cmd.icon,
    shortcut: cmd.shortcut,
  }));
```

(Adjust the variable name to match the existing code's pattern. If quick-rail.js doesn't actually have hardcoded commands, just add the import for future use and skip the replacement.)

- [ ] **Step 3: Run clickability verification**

```bash
cd D:/WWriting
npm run verify:app-clickability 2>&1 | tail -5
```

Expected: `ok: true`.

- [ ] **Step 4: Commit**

```bash
cd D:/WWriting
git add src/app-shell/quick-rail.js
git commit -m "refactor(skill-system): wire quick-rail.js to command-registry (B1)"
```

---

## Task 8: B1 Final Verification

**Files:** none modified.

- [ ] **Step 1: Run all unit tests**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -10
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 2: Run clickability**

```bash
cd D:/WWriting
npm run verify:app-clickability 2>&1 | tail -5
```

Expected: `ok: true`.

- [ ] **Step 3: Run app-shell**

```bash
cd D:/WWriting
npm run verify:app-shell 2>&1 | tail -5
```

Expected: `ok: true`.

- [ ] **Step 4: If any fails, REVERT B1**

```bash
cd D:/WWriting
git revert HEAD~6..HEAD --no-edit
```

Then fix and re-attempt. Otherwise, continue to B3.

---

## Task 9: B3 - Add `resolveSkillSources` (TDD)

**Files:**
- Create: `tests/skill-runtime-sources.test.mjs`
- Modify: `package.json` (add `ignore` dep)
- Modify: `src/core/skill-runtime.mjs` (add `resolveSkillSources`)

- [ ] **Step 1: Install `ignore` package**

```bash
cd D:/WWriting
npm install --save ignore@^5.3.0 2>&1 | tail -3
```

Expected: `+ ignore@5.x.x` added to dependencies in `package.json`.

- [ ] **Step 2: Write the failing test**

Create `tests/skill-runtime-sources.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { resolveSkillSources } from "../src/core/skill-runtime.mjs";

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), "wwr-sources-"));
}

function makeSkillDir(base, name, manifest = { name, version: "1.0.0", type: "style", hooks: [] }) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.json"), JSON.stringify(manifest));
  return dir;
}

test("resolveSkillSources scans 3 sources in priority order", async () => {
  const projectRoot = makeTempProject();
  const userHome = makeTempProject();
  const resourcesPath = makeTempProject();

  makeSkillDir(resourcesPath, "alpha");
  makeSkillDir(userHome, "beta", { name: "beta", version: "1.0.0", type: "style", hooks: [] });
  // Create a `skills` subdir under userHome
  const userSkills = join(userHome, "skills");
  rmSync(userSkills, { recursive: true, force: true });
  mkdirSync(userSkills, { recursive: true });
  makeSkillDir(userSkills, "beta", { name: "beta", version: "1.0.0", type: "style", hooks: [] });
  makeSkillDir(projectRoot, "gamma");

  try {
    const sources = await resolveSkillSources({ projectRoot, userHome, resourcesPath });
    const byName = sources.map((s) => s.name);
    assert.ok(byName.includes("alpha"));
    assert.ok(byName.includes("beta"));
    assert.ok(byName.includes("gamma"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(resourcesPath, { recursive: true, force: true });
  }
});

test("resolveSkillSources dedups by realpath (symlink)", async () => {
  const projectRoot = makeTempProject();
  const userHome = makeTempProject();
  const resourcesPath = makeTempProject();

  const real = makeSkillDir(resourcesPath, "shared");
  const userSkills = join(userHome, "skills");
  mkdirSync(userSkills, { recursive: true });
  // symlink from user dir to real dir
  symlinkSync(real, join(userSkills, "shared"), "dir");

  try {
    const sources = await resolveSkillSources({ projectRoot, userHome, resourcesPath });
    const sharedEntries = sources.filter((s) => s.name === "shared");
    assert.equal(sharedEntries.length, 1, "expected exactly one 'shared' entry after dedup");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(resourcesPath, { recursive: true, force: true });
  }
});

test("resolveSkillSources skips missing sources without throwing", async () => {
  const sources = await resolveSkillSources({
    projectRoot: "/nope/does/not/exist",
    userHome: "/nope/either",
    resourcesPath: undefined,
  });
  assert.equal(Array.isArray(sources), true);
  assert.equal(sources.length, 0);
});
```

- [ ] **Step 3: Run test to verify it fails (import will fail)**

```bash
cd D:/WWriting
node --test tests/skill-runtime-sources.test.mjs 2>&1 | tail -10
```

Expected: tests fail with `resolveSkillSources is not exported`.

- [ ] **Step 4: Add `resolveSkillSources` to skill-runtime.mjs**

Edit `src/core/skill-runtime.mjs`. After the imports at top (line 1-4), add:

```js
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

Then, **before the existing `BUILTIN_SKILLS` declaration (line 10)**, add:

```js
export async function resolveSkillSources({
  projectRoot,
  userHome,
  resourcesPath,
} = {}) {
  const sources = [
    resourcesPath ? { base: resourcesPath, subdir: "skills", source: "bundled-dist", priority: 1 } : null,
    userHome ? { base: userHome, subdir: path.join(".wwriting", "skills"), source: "user", priority: 2 } : null,
    projectRoot ? { base: projectRoot, subdir: "skills", source: "project", priority: 3 } : null,
  ].filter(Boolean);

  const seen = new Map(); // realpath → first source
  const result = [];

  for (const src of sources) {
    const baseDir = path.join(src.base, src.subdir);
    let entries;
    try {
      entries = await fs.readdir(baseDir, { withFileTypes: true });
    } catch {
      continue; // missing or unreadable; skip
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = path.join(baseDir, entry.name);
      let realId;
      try {
        realId = await realpath(skillDir);
      } catch {
        continue;
      }
      if (seen.has(realId)) continue;
      seen.set(realId, src.source);
      result.push({
        name: entry.name,
        path: skillDir,
        realId,
        source: src.source,
        priority: src.priority,
      });
    }
  }

  return result;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd D:/WWriting
node --test tests/skill-runtime-sources.test.mjs 2>&1 | tail -10
```

Expected: 3 tests pass.

- [ ] **Step 6: Run all unit tests (no regression)**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
cd D:/WWriting
git add package.json package-lock.json src/core/skill-runtime.mjs tests/skill-runtime-sources.test.mjs
git commit -m "feat(skill-system): add resolveSkillSources with 3 sources + realpath dedup (B3)"
```

---

## Task 10: B3 - Update `loadEnabledSkills` to Use `resolveSkillSources`

**Files:**
- Modify: `src/core/skill-runtime.mjs` (`loadEnabledSkills` function, lines 49-87)

- [ ] **Step 1: Read existing `loadEnabledSkills` (lines 49-87)**

Confirm the function signature is `loadEnabledSkills(projectRoot, project = {})`.

- [ ] **Step 2: Update `loadEnabledSkills` to scan all 3 sources**

Replace the body of `loadEnabledSkills` (lines 49-87) with:

```js
export async function loadEnabledSkills(projectRoot, project = {}) {
  const enabledNames = new Set(project.enabled_skills ?? []);
  const skills = [];

  // Scan BUILTIN_SKILLS first (always available)
  for (const name of enabledNames) {
    if (BUILTIN_SKILLS[name]) {
      skills.push(normalizeSkillManifest(BUILTIN_SKILLS[name], `builtin:${name}`));
    }
  }

  // Resolve additional sources via resolveSkillSources
  const userHome = os.homedir();
  const resourcesPath = process.resourcesPath;
  const discovered = await resolveSkillSources({ projectRoot, userHome, resourcesPath });

  for (const source of discovered) {
    if (source.source === "project") {
      // existing project behavior: only load enabled
      const filePath = await findManifestFile(source.path);
      if (!filePath) continue;
      const manifest = await readSkillManifest(filePath);
      const normalized = normalizeSkillManifest(manifest, filePath);
      if (normalized.enabled === false) continue;
      if (enabledNames.size === 0 || enabledNames.has(normalized.name)) {
        skills.push(normalized);
      }
    } else {
      // new sources (bundled-dist, user): load manifest if present
      const filePath = await findManifestFile(source.path);
      if (!filePath) continue;
      const manifest = await readSkillManifest(filePath);
      const normalized = normalizeSkillManifest(manifest, filePath);
      if (normalized.enabled === false) continue;
      if (enabledNames.size === 0 || enabledNames.has(normalized.name)) {
        skills.push(normalized);
      }
    }
  }

  return sortSkills(dedupeSkills(skills));
}
```

- [ ] **Step 3: Run all unit tests (no regression)**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 4: Run clickability**

```bash
cd D:/WWriting
npm run verify:app-clickability 2>&1 | tail -5
```

Expected: `ok: true`.

- [ ] **Step 5: Commit**

```bash
cd D:/WWriting
git add src/core/skill-runtime.mjs
git commit -m "refactor(skill-system): update loadEnabledSkills to use resolveSkillSources (B3)"
```

---

## Task 11: B3 Final Verification

- [ ] **Step 1: Run full test suite**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 2: Run app-shell verification**

```bash
cd D:/WWriting
npm run verify:app-shell 2>&1 | tail -5
```

Expected: `ok: true`.

---

## Task 12: B2 - Add `parseSkillPaths` (TDD)

**Files:**
- Create: `tests/skill-runtime-paths.test.mjs`
- Modify: `src/core/skill-runtime.mjs` (add `parseSkillPaths` export)

- [ ] **Step 1: Write the failing test**

Create `tests/skill-runtime-paths.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillPaths, activateConditionalSkillsForPaths } from "../src/core/skill-runtime.mjs";

test("parseSkillPaths returns undefined when paths missing", () => {
  assert.equal(parseSkillPaths({}), undefined);
});

test("parseSkillPaths accepts single string", () => {
  assert.deepEqual(parseSkillPaths({ paths: "chapters/poetry/**" }), ["chapters/poetry"]);
});

test("parseSkillPaths accepts array", () => {
  assert.deepEqual(
    parseSkillPaths({ paths: ["chapters/poetry/**", "drafts/**"] }),
    ["chapters/poetry", "drafts"]
  );
});

test("parseSkillPaths strips /** suffix", () => {
  assert.deepEqual(parseSkillPaths({ paths: "**/*.md" }), ["**/*.md".replace("/**", "")]);
});

test("parseSkillPaths returns undefined when all patterns are **", () => {
  assert.equal(parseSkillPaths({ paths: ["**"] }), undefined);
});

test("parseSkillPaths filters out empty patterns", () => {
  assert.deepEqual(parseSkillPaths({ paths: ["", "  ", "chapters/**"] }), ["chapters"]);
});
```

- [ ] **Step 2: Run test to verify it fails (import will fail)**

```bash
cd D:/WWriting
node --test tests/skill-runtime-paths.test.mjs 2>&1 | tail -10
```

Expected: tests fail with `parseSkillPaths is not exported`.

- [ ] **Step 3: Add `parseSkillPaths` to skill-runtime.mjs**

Edit `src/core/skill-runtime.mjs`. After the `resolveSkillSources` function (added in T9), add:

```js
import ignoreLib from "ignore";

export function parseSkillPaths(frontmatter) {
  if (!frontmatter || !frontmatter.paths) return undefined;
  const raw = Array.isArray(frontmatter.paths)
    ? frontmatter.paths
    : [frontmatter.paths];
  const patterns = raw
    .map((p) => String(p).trim())
    .filter((p) => p.length > 0)
    .map((p) => (p.endsWith("/**") ? p.slice(0, -3) : p))
    .filter((p) => p.length > 0 && p !== "**");
  if (patterns.length === 0) return undefined;
  return patterns;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd D:/WWriting
node --test tests/skill-runtime-paths.test.mjs 2>&1 | tail -5
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/WWriting
git add tests/skill-runtime-paths.test.mjs src/core/skill-runtime.mjs
git commit -m "feat(skill-system): add parseSkillPaths with /** stripping (B2)"
```

---

## Task 13: B2 - Add `activateConditionalSkillsForPaths`

**Files:**
- Modify: `src/core/skill-runtime.mjs`
- Modify: `tests/skill-runtime-paths.test.mjs` (add more tests)

- [ ] **Step 1: Append to the test file**

Append to `tests/skill-runtime-paths.test.mjs`:

```js
import { registerProjectSkill, _resetConditionalSkills } from "../src/core/skill-runtime.mjs";

test.beforeEach(() => {
  _resetConditionalSkills();
});

test("activateConditionalSkillsForPaths matches gitignore patterns", () => {
  registerProjectSkill({
    projectRoot: "/fake",
    name: "tone-checker",
    version: "1.0.0",
    type: "style",
    paths: ["chapters/poetry/**"],
    hooks: [],
  });
  const activated = activateConditionalSkillsForPaths(["chapters/poetry/c1.md"], "/fake");
  assert.ok(activated.includes("tone-checker"));
});

test("activateConditionalSkillsForPaths skips absolute paths", () => {
  registerProjectSkill({
    projectRoot: "/fake",
    name: "tone-checker",
    version: "1.0.0",
    type: "style",
    paths: ["chapters/**"],
    hooks: [],
  });
  const activated = activateConditionalSkillsForPaths(["/etc/passwd"], "/fake");
  assert.equal(activated.length, 0);
});

test("activateConditionalSkillsForPaths is idempotent", () => {
  registerProjectSkill({
    projectRoot: "/fake",
    name: "tone-checker",
    version: "1.0.0",
    type: "style",
    paths: ["chapters/**"],
    hooks: [],
  });
  const a1 = activateConditionalSkillsForPaths(["chapters/c1.md"], "/fake");
  const a2 = activateConditionalSkillsForPaths(["chapters/c2.md"], "/fake");
  assert.equal(a1.length, 1);
  assert.equal(a2.length, 0, "already activated, no new entries");
});
```

- [ ] **Step 2: Add `registerProjectSkill`, `_resetConditionalSkills`, and `activateConditionalSkillsForPaths` to skill-runtime.mjs**

After the `parseSkillPaths` function (added in T12), add:

```js
const conditionalSkills = new Map(); // name → { manifest, patterns }
const activatedNames = new Set();

export function registerProjectSkill({ projectRoot, name, version, type, paths, hooks }) {
  if (!name) throw new Error("registerProjectSkill: name required");
  const patterns = parseSkillPaths({ paths });
  if (!patterns) return null; // unconditional skills don't need activation
  conditionalSkills.set(name, {
    name,
    version,
    type,
    patterns,
    projectRoot: projectRoot ?? null,
    hooks: Array.isArray(hooks) ? hooks : [],
  });
  return { name, patterns };
}

export function _resetConditionalSkills() {
  conditionalSkills.clear();
  activatedNames.clear();
}

export function activateConditionalSkillsForPaths(filePaths, projectRoot) {
  const activated = [];
  if (!Array.isArray(filePaths) || filePaths.length === 0) return activated;
  for (const [name, entry] of conditionalSkills) {
    if (activatedNames.has(name)) continue;
    if (entry.projectRoot && projectRoot && entry.projectRoot !== projectRoot) continue;
    const matcher = ignoreLib().add(entry.patterns);
    for (const fp of filePaths) {
      if (!fp || typeof fp !== "string") continue;
      // absolute paths: skip (caller should pass relative)
      if (fp.startsWith("/") || /^[a-zA-Z]:[\\\/]/.test(fp)) continue;
      if (matcher.ignores(fp)) {
        activatedNames.add(name);
        activated.push(name);
        break;
      }
    }
  }
  return activated;
}

export function listActivatedSkills() {
  return [...activatedNames];
}
```

- [ ] **Step 3: Run test to verify it passes**

```bash
cd D:/WWriting
node --test tests/skill-runtime-paths.test.mjs 2>&1 | tail -5
```

Expected: 9 tests pass (6 + 3).

- [ ] **Step 4: Run full test suite (no regression)**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd D:/WWriting
git add tests/skill-runtime-paths.test.mjs src/core/skill-runtime.mjs
git commit -m "feat(skill-system): add activateConditionalSkillsForPaths (B2)"
```

---

## Task 14: B2 - Wire to composer.js

**Files:**
- Modify: `src/app-shell/composer.js`

- [ ] **Step 1: Read current composer.js to find a good insertion point**

Look for `submitComposer` (line 179). The hook should fire just before `submitWritingCommand` is called.

- [ ] **Step 2: Add import**

At the top of `composer.js`, after the existing imports, add:

```js
import { activateConditionalSkillsForPaths, listActivatedSkills } from "../core/skill-runtime.mjs";
```

- [ ] **Step 3: Add helper to find file paths in the message**

After `detectMainTaskImpact` (line 68-70), add:

```js
function extractFilePathsFromMessage(text) {
  // 简易提取:markdown 链接 [text](path) 或裸的 .md / .txt 引用
  if (!text) return [];
  const paths = [];
  const mdLink = /\[[^\]]+\]\(([^)]+)\)/g;
  let m;
  while ((m = mdLink.exec(text)) !== null) paths.push(m[1]);
  // 也可以扫 projectRoot 下的相关文件;此处保持最小,不实现复杂解析
  return paths;
}
```

- [ ] **Step 4: Call `activateConditionalSkillsForPaths` in `submitComposer`**

In `submitComposer` function, find the call to `submitWritingCommand` (around line 197) and **insert before it**:

```js
    // 路径条件激活:把本次提交涉及的文件路径喂给 skill-runtime
    const involvedPaths = extractFilePathsFromMessage(parsed.content);
    if (involvedPaths.length > 0) {
      const projectRoot = ctx.getCurrentProjectRoot();
      if (projectRoot) {
        activateConditionalSkillsForPaths(involvedPaths, projectRoot);
      }
    }
```

- [ ] **Step 5: Run clickability verification**

```bash
cd D:/WWriting
npm run verify:app-clickability 2>&1 | tail -5
```

Expected: `ok: true`.

- [ ] **Step 6: Run full test suite**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
cd D:/WWriting
git add src/app-shell/composer.js
git commit -m "feat(skill-system): wire composer to activate conditional skills by file path (B2)"
```

---

## Task 15: B2 Final Verification

- [ ] **Step 1: Run all unit tests**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 2: Run app-shell**

```bash
cd D:/WWriting
npm run verify:app-shell 2>&1 | tail -5
```

Expected: `ok: true`.

- [ ] **Step 3: Run clickability**

```bash
cd D:/WWriting
npm run verify:app-clickability 2>&1 | tail -5
```

Expected: `ok: true`.

---

## Task 16: B4 - Create event-bus.mjs (TDD)

**Files:**
- Create: `tests/event-bus.test.mjs`
- Create: `src/core/event-bus.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/event-bus.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { on, off, emit, CORE_EVENTS, _resetEventBus } from "../src/core/event-bus.mjs";

test.beforeEach(() => {
  _resetEventBus();
});

test("emit with no listeners returns ok:true and no errors", async () => {
  const result = await emit("test:event", { foo: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("emit invokes all listeners", async () => {
  let count = 0;
  on("test:event", () => count++);
  on("test:event", () => count++);
  await emit("test:event", {});
  assert.equal(count, 2);
});

test("emit awaits async listeners", async () => {
  let resolved = false;
  on("test:event", async () => {
    await new Promise((r) => setTimeout(r, 10));
    resolved = true;
  });
  await emit("test:event", {});
  assert.equal(resolved, true);
});

test("emit collects errors from throwing listeners", async () => {
  on("test:event", () => {
    throw new Error("boom");
  });
  const result = await emit("test:event", {});
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].error.message, "boom");
});

test("emit continues after one listener throws", async () => {
  let second = false;
  on("test:event", () => {
    throw new Error("boom");
  });
  on("test:event", () => {
    second = true;
  });
  const result = await emit("test:event", {});
  assert.equal(second, true);
  assert.equal(result.errors.length, 1);
});

test("off removes listener", async () => {
  let count = 0;
  const fn = () => count++;
  on("test:event", fn);
  off("test:event", fn);
  await emit("test:event", {});
  assert.equal(count, 0);
});

test("on returns an unsubscribe function", async () => {
  let count = 0;
  const unsubscribe = on("test:event", () => count++);
  await emit("test:event", {});
  unsubscribe();
  await emit("test:event", {});
  assert.equal(count, 1);
});

test("CORE_EVENTS is frozen with 5 events", () => {
  assert.equal(Object.isFrozen(CORE_EVENTS), true);
  assert.equal(Object.keys(CORE_EVENTS).length, 5);
});
```

- [ ] **Step 2: Run test to verify it fails (import will fail)**

```bash
cd D:/WWriting
node --test tests/event-bus.test.mjs 2>&1 | tail -10
```

Expected: tests fail with module not found.

- [ ] **Step 3: Create event-bus.mjs**

Create `src/core/event-bus.mjs`:

```js
// 全局事件总线
// 5 个 CORE_EVENTS 是"跨模块副作用"的统一入口
// 平行于 skill-runtime 内部的 stage/action hook(那些不替换)

const listeners = new Map();

export const CORE_EVENTS = Object.freeze({
  ModelCallStart: "model-call:start",
  ModelCallComplete: "model-call:complete",
  ChapterWritten: "chapter:written",
  TaskFailed: "task:failed",
  BackupNeeded: "backup:needed",
});

export function on(event, fn) {
  if (typeof event !== "string") throw new Error("event must be a string");
  if (typeof fn !== "function") throw new Error("fn must be a function");
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => off(event, fn);
}

export function off(event, fn) {
  const set = listeners.get(event);
  if (set) set.delete(fn);
}

export async function emit(event, payload) {
  const set = listeners.get(event);
  if (!set || set.size === 0) {
    return { ok: true, errors: [] };
  }
  const fns = [...set];
  const results = await Promise.allSettled(fns.map((fn) => Promise.resolve().then(() => fn(payload))));
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      errors.push({ event, error: r.reason, listener: fns[i] });
    }
  });
  return { ok: errors.length === 0, errors };
}

export function _resetEventBus() {
  listeners.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd D:/WWriting
node --test tests/event-bus.test.mjs 2>&1 | tail -5
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/WWriting
git add tests/event-bus.test.mjs src/core/event-bus.mjs
git commit -m "feat(skill-system): add event-bus with 5 CORE_EVENTS (B4)"
```

---

## Task 17: B4 - Migrate cost-tracker to Subscribe to `model-call:complete`

**Files:**
- Modify: `src/core/cost-tracker.mjs`

- [ ] **Step 1: Read cost-tracker.mjs to understand its public API**

Confirm `recordUsage(usage, model, options?)` exists. Look for any place that calls `recordUsage` directly from agent-engine.

- [ ] **Step 2: Add subscription in cost-tracker.mjs**

At the bottom of `cost-tracker.mjs`, append:

```js
import { on, CORE_EVENTS } from "./event-bus.mjs";

// Subscribe to model-call:complete and call recordUsage
on(CORE_EVENTS.ModelCallComplete, (payload) => {
  try {
    if (!payload || !payload.usage) return;
    recordUsage(payload.usage, payload.model, payload.options);
  } catch (e) {
    console.error("cost-tracker: failed to record usage from event:", e);
  }
});
```

(If `recordUsage` is the default export or has a different import path, adjust the call. Use the actual signature discovered in Step 1.)

- [ ] **Step 3: Run full test suite (no regression)**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 4: Commit**

```bash
cd D:/WWriting
git add src/core/cost-tracker.mjs
git commit -m "refactor(skill-system): cost-tracker subscribes to model-call:complete (B4)"
```

---

## Task 18: B4 - Migrate event-log to Subscribe to `task:failed` and `chapter:written`

**Files:**
- Modify: `src/core/event-log.mjs`

- [ ] **Step 1: Read event-log.mjs to confirm `appendEvent(projectRoot, event)` signature**

- [ ] **Step 2: Add subscription**

At the bottom of `event-log.mjs`, append:

```js
import { on, CORE_EVENTS } from "./event-bus.mjs";

on(CORE_EVENTS.TaskFailed, (payload) => {
  try {
    if (!payload || !payload.projectRoot) return;
    appendEvent(payload.projectRoot, {
      type: "task-failed",
      taskId: payload.taskId,
      error: payload.error ? String(payload.error.message || payload.error) : undefined,
    });
  } catch (e) {
    console.error("event-log: failed to record task:failed:", e);
  }
});

on(CORE_EVENTS.ChapterWritten, (payload) => {
  try {
    if (!payload || !payload.projectRoot) return;
    appendEvent(payload.projectRoot, {
      type: "chapter-written",
      path: payload.path,
      chapterId: payload.chapterId,
    });
  } catch (e) {
    console.error("event-log: failed to record chapter:written:", e);
  }
});
```

- [ ] **Step 3: Run full test suite**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 4: Commit**

```bash
cd D:/WWriting
git add src/core/event-log.mjs
git commit -m "refactor(skill-system): event-log subscribes to task:failed and chapter:written (B4)"
```

---

## Task 19: B4 - Migrate failures-store to Subscribe to `task:failed`

**Files:**
- Modify: `src/core/failures-store.mjs`

- [ ] **Step 1: Read failures-store.mjs to confirm `appendFailure(projectRoot, card)` signature**

- [ ] **Step 2: Add subscription**

At the bottom of `failures-store.mjs`, append:

```js
import { on, CORE_EVENTS } from "./event-bus.mjs";

on(CORE_EVENTS.TaskFailed, (payload) => {
  try {
    if (!payload || !payload.projectRoot || !payload.card) return;
    appendFailure(payload.projectRoot, payload.card);
  } catch (e) {
    console.error("failures-store: failed to record task:failed:", e);
  }
});
```

- [ ] **Step 3: Run full test suite**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 4: Commit**

```bash
cd D:/WWriting
git add src/core/failures-store.mjs
git commit -m "refactor(skill-system): failures-store subscribes to task:failed (B4)"
```

---

## Task 20: B4 - Update agent-engine to Emit Events

**Files:**
- Modify: `src/core/agent-engine.mjs`

- [ ] **Step 1: Read agent-engine.mjs to find call sites**

Look for:
- The function that calls the model (likely `callModel` or `runModel`)
- The function that writes chapter files (likely `writeChapter` or `saveDraft`)
- Error handling paths that mark tasks as failed

- [ ] **Step 2: Add import**

At the top of `agent-engine.mjs`, add:

```js
import { emit, CORE_EVENTS } from "./event-bus.mjs";
```

- [ ] **Step 3: Emit `ModelCallStart` before model call**

Find the model call site. **Before** the actual model invocation, add:

```js
    await emit(CORE_EVENTS.ModelCallStart, {
      projectRoot,
      model: runtime.model,
      messages: sanitizedMessages,
    });
```

- [ ] **Step 4: Emit `ModelCallComplete` after model call**

**After** the model returns successfully, add:

```js
    await emit(CORE_EVENTS.ModelCallComplete, {
      projectRoot,
      model: runtime.model,
      usage: result.usage ?? {},
      options: { taskId, stage },
    });
```

- [ ] **Step 5: Emit `ChapterWritten` after writing chapter**

Find where chapters are written. **After** successful write, add:

```js
    await emit(CORE_EVENTS.ChapterWritten, {
      projectRoot,
      path: writtenPath,
      chapterId,
    });
```

- [ ] **Step 6: Emit `TaskFailed` in error paths**

Find `catch` blocks that handle model or chapter errors. **Inside** the catch, add:

```js
      await emit(CORE_EVENTS.TaskFailed, {
        projectRoot,
        taskId,
        error,
        card: deriveFailureCard({ error, taskId, stage }),  // or build minimal card
      });
```

(If `deriveFailureCard` is the actual function name, use it; otherwise build a minimal card inline.)

- [ ] **Step 7: Run full test suite**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 8: Run clickability**

```bash
cd D:/WWriting
npm run verify:app-clickability 2>&1 | tail -5
```

Expected: `ok: true`.

- [ ] **Step 9: Commit**

```bash
cd D:/WWriting
git add src/core/agent-engine.mjs
git commit -m "refactor(skill-system): agent-engine emits 4 events (B4)"
```

---

## Task 21: B4 Final Verification

- [ ] **Step 1: Run all unit tests**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 2: Run clickability**

```bash
cd D:/WWriting
npm run verify:app-clickability 2>&1 | tail -5
```

Expected: `ok: true`.

- [ ] **Step 3: Run app-shell**

```bash
cd D:/WWriting
npm run verify:app-shell 2>&1 | tail -5
```

Expected: `ok: true`.

- [ ] **Step 4: Write a smoke test for event-bus integration**

Create `tests/event-bus-integration.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { on, emit, CORE_EVENTS, _resetEventBus } from "../src/core/event-bus.mjs";

test.beforeEach(() => {
  _resetEventBus();
});

test("multiple subscribers receive event payload", async () => {
  const received = [];
  on(CORE_EVENTS.ModelCallComplete, (p) => received.push(p));
  on(CORE_EVENTS.ModelCallComplete, (p) => received.push({ ...p, doubled: true }));

  await emit(CORE_EVENTS.ModelCallComplete, { model: "deepseek", usage: { total: 100 } });
  assert.equal(received.length, 2);
  assert.equal(received[0].model, "deepseek");
  assert.equal(received[1].doubled, true);
});

test("throwing subscriber does not prevent other subscribers", async () => {
  let secondCalled = false;
  on(CORE_EVENTS.TaskFailed, () => {
    throw new Error("intentional");
  });
  on(CORE_EVENTS.TaskFailed, () => {
    secondCalled = true;
  });

  const result = await emit(CORE_EVENTS.TaskFailed, { error: new Error("test") });
  assert.equal(secondCalled, true);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
});
```

- [ ] **Step 5: Run the integration test**

```bash
cd D:/WWriting
node --test tests/event-bus-integration.test.mjs 2>&1 | tail -5
```

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
cd D:/WWriting
git add tests/event-bus-integration.test.mjs
git commit -m "test(skill-system): add event-bus integration smoke test (B4)"
```

---

## Task 22: B5 - Create output-style-loader (TDD)

**Files:**
- Create: `tests/output-style-loader.test.mjs`
- Create: `src/app-shell/output-style-loader.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/output-style-loader.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOutputStyles, _resetOutputStyleCache } from "../src/app-shell/output-style-loader.mjs";

test.beforeEach(() => {
  _resetOutputStyleCache();
});

test("loadOutputStyles returns at least 2 bundled styles", async () => {
  const styles = await loadOutputStyles({});
  assert.ok(styles.length >= 2);
  const names = styles.map((s) => s.name);
  assert.ok(names.includes("creative"));
  assert.ok(names.includes("review"));
});

test("loadOutputStyles loads user-level .md files", async () => {
  const userHome = mkdtempSync(join(tmpdir(), "wwr-style-"));
  const stylesDir = join(userHome, ".wwriting", "output-styles");
  mkdirSync(stylesDir, { recursive: true });
  writeFileSync(
    join(stylesDir, "custom.md"),
    `---
name: Custom Style
description: My custom writing style
---
This is the body of the custom style prompt.`
  );

  try {
    const styles = await loadOutputStyles({ userHome });
    const custom = styles.find((s) => s.name === "Custom Style");
    assert.ok(custom);
    assert.equal(custom.source, "user");
    assert.ok(custom.body.includes("custom style prompt"));
  } finally {
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("loadOutputStyles loads project-level .md files", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "wwr-proj-"));
  const stylesDir = join(projectRoot, ".wwriting", "output-styles");
  mkdirSync(stylesDir, { recursive: true });
  writeFileSync(
    join(stylesDir, "project-style.md"),
    `---
name: Project Style
description: Project-specific
---
Project body.`
  );

  try {
    const styles = await loadOutputStyles({ projectRoot });
    const ps = styles.find((s) => s.name === "Project Style");
    assert.ok(ps);
    assert.equal(ps.source, "project");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("loadOutputStyles skips .md files without name frontmatter", async () => {
  const userHome = mkdtempSync(join(tmpdir(), "wwr-style-"));
  const stylesDir = join(userHome, ".wwriting", "output-styles");
  mkdirSync(stylesDir, { recursive: true });
  writeFileSync(
    join(stylesDir, "no-name.md"),
    `---
description: missing name
---
body`
  );

  try {
    const styles = await loadOutputStyles({ userHome });
    const noName = styles.find((s) => s.source === "user");
    assert.equal(noName, undefined);
  } finally {
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("loadOutputStyles is cached (subsequent calls return same array)", async () => {
  const a = await loadOutputStyles({});
  const b = await loadOutputStyles({});
  assert.equal(a, b);
});
```

- [ ] **Step 2: Run test to verify it fails (import will fail)**

```bash
cd D:/WWriting
node --test tests/output-style-loader.test.mjs 2>&1 | tail -10
```

Expected: tests fail with module not found.

- [ ] **Step 3: Create output-style-loader.mjs**

Create `src/app-shell/output-style-loader.mjs`:

```js
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { simpleYaml } from "../core/simple-yaml.mjs"; // 复用现有 yaml 解析

// 内置 2 种风格(优先级最高,会被用户同名覆盖吗? No,内置是 bundled 源,用户同名会替换)
const BUNDLED_STYLES = [
  {
    name: "creative",
    description: "创作模式:长跑章节生成,强调氛围、人物心理、节奏",
    body: "你正在创作长篇小说。当前目标是写出有沉浸感、人物驱动的章节。\n- 优先呈现人物心理和情绪变化\n- 对话要符合角色设定和场景氛围\n- 每章结尾保留悬念或转折钩子",
    source: "bundled",
  },
  {
    name: "review",
    description: "审稿模式:检查节奏、连贯性、设定一致性",
    body: "你正在审稿当前章节。请重点检查:\n- 节奏是否拖沓或仓促\n- 人物言行是否符合已建立的性格\n- 设定是否前后矛盾(地名、时间线、术语)\n- 字数与目标差距\n- 章节结尾是否有钩子",
    source: "bundled",
  },
];

let cache = null;
let cacheKey = null;

function makeCacheKey({ projectRoot, userHome }) {
  return `${projectRoot ?? ""}::${userHome ?? ""}`;
}

export async function loadOutputStyles({ projectRoot, userHome } = {}) {
  const key = makeCacheKey({ projectRoot, userHome });
  if (cache && cacheKey === key) return cache;

  const styles = [...BUNDLED_STYLES];

  // User-level (~/.wwriting/output-styles/*.md)
  if (userHome) {
    const userDir = path.join(userHome, ".wwriting", "output-styles");
    await loadFromDir(userDir, "user", styles);
  }

  // Project-level (<projectRoot>/.wwriting/output-styles/*.md)
  if (projectRoot) {
    const projectDir = path.join(projectRoot, ".wwriting", "output-styles");
    await loadFromDir(projectDir, "project", styles);
  }

  cache = styles;
  cacheKey = key;
  return styles;
}

async function loadFromDir(dir, source, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = parseStyleFrontmatter(content);
      if (!parsed.name) {
        console.warn(`output-style-loader: skipping ${filePath}: missing name in frontmatter`);
        continue;
      }
      // Remove bundled style with same name (user/project override)
      const idx = out.findIndex((s) => s.name === parsed.name && s.source === "bundled");
      if (idx >= 0) out.splice(idx, 1);
      out.push({
        name: parsed.name,
        description: parsed.description ?? "",
        body: parsed.body,
        source,
        filePath,
      });
    } catch (e) {
      console.warn(`output-style-loader: failed to load ${filePath}: ${e.message}`);
    }
  }
}

function parseStyleFrontmatter(content) {
  // 简易 frontmatter 解析:第一段 --- ... --- 之间的 YAML
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { name: null, description: "", body: content };
  const yamlPart = match[1];
  const body = match[2] ?? "";
  const result = { name: null, description: "", body };
  for (const line of yamlPart.split(/\r?\n/)) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, valueRaw] = m;
    const value = valueRaw.replace(/^["']|["']$/g, "").trim();
    if (key === "name") result.name = value;
    else if (key === "description") result.description = value;
  }
  return result;
}

export function _resetOutputStyleCache() {
  cache = null;
  cacheKey = null;
}

export function listBuiltInStyleNames() {
  return BUNDLED_STYLES.map((s) => s.name);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd D:/WWriting
node --test tests/output-style-loader.test.mjs 2>&1 | tail -5
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/WWriting
git add tests/output-style-loader.test.mjs src/app-shell/output-style-loader.mjs
git commit -m "feat(skill-system): add output-style-loader with 3 sources (B5)"
```

---

## Task 23: B5 - Add Settings Modal Dropdown

**Files:**
- Modify: `src/app-shell/settings-modal.js`
- Modify: `src/core/app-state.mjs` (add `settings.outputStyle` field)

- [ ] **Step 1: Read settings-modal.js to find a good place to add the dropdown**

Look for an existing model-related settings section (provider, model name, base URL, API key, etc.).

- [ ] **Step 2: Add import at the top of settings-modal.js**

```js
import { loadOutputStyles, listBuiltInStyleNames } from "./output-style-loader.mjs";
```

- [ ] **Step 3: Add the dropdown UI element**

Inside the settings-modal render function, after the model/permissions section, add a new field group:

```js
  // 输出风格下拉
  const outputStyle = await loadOutputStyles({
    projectRoot: currentProjectRoot,
    userHome: os.homedir(),
  });
  const outputStyleSelect = document.createElement("select");
  outputStyleSelect.id = "settings-output-style";
  for (const style of outputStyle) {
    const opt = document.createElement("option");
    opt.value = style.name;
    opt.textContent = `${style.name} — ${style.description}`;
    outputStyleSelect.append(opt);
  }
  // 设为当前值
  const currentOutputStyle = (currentSettings?.outputStyle) ?? "creative";
  outputStyleSelect.value = currentOutputStyle;
  outputStyleSelect.addEventListener("change", () => {
    currentSettings = { ...currentSettings, outputStyle: outputStyleSelect.value };
  });
```

(Adjust to fit the existing settings-modal.js structure. The key behavior: a `<select>` whose value is read on save and written to `currentSettings.outputStyle`.)

- [ ] **Step 4: Add `settings.outputStyle` default in app-state.mjs**

Read `src/core/app-state.mjs` to find where default settings are defined. Add:

```js
outputStyle: "creative",  // default to bundled "creative" style
```

to the default settings object.

- [ ] **Step 5: Run clickability**

```bash
cd D:/WWriting
npm run verify:app-clickability 2>&1 | tail -5
```

Expected: `ok: true`. The clickability probe may not exercise the dropdown, but no regression.

- [ ] **Step 6: Run full test suite**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
cd D:/WWriting
git add src/app-shell/settings-modal.js src/core/app-state.mjs
git commit -m "feat(skill-system): add output-style dropdown to settings (B5)"
```

---

## Task 24: B5 - Wire prompt-compiler to Inject Output Style

**Files:**
- Modify: `src/core/prompt-compiler.mjs`

- [ ] **Step 1: Read prompt-compiler.mjs to find the system prompt assembly function**

Look for the function that builds the system message (likely `compileSystemPrompt` or similar).

- [ ] **Step 2: Add import at the top of prompt-compiler.mjs**

```js
import { loadOutputStyles } from "../app-shell/output-style-loader.mjs";
import * as os from "node:os";
```

- [ ] **Step 3: In the system prompt assembly function, append output style**

After the existing system prompt sections are assembled, **before** returning, add:

```js
  // Append the selected output style body
  const styles = await loadOutputStyles({
    projectRoot,
    userHome: os.homedir(),
  });
  const selectedName = settings?.outputStyle ?? "creative";
  const selected = styles.find((s) => s.name === selectedName) ?? styles[0];
  if (selected) {
    systemPrompt += `\n\n## 输出风格: ${selected.name}\n${selected.body}`;
  }
```

(Adjust the variable names to match the existing function. The key behavior: read the configured style, append its body to the system prompt.)

- [ ] **Step 4: Run full test suite**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 5: Run app-shell**

```bash
cd D:/WWriting
npm run verify:app-shell 2>&1 | tail -5
```

Expected: `ok: true`.

- [ ] **Step 6: Commit**

```bash
cd D:/WWriting
git add src/core/prompt-compiler.mjs
git commit -m "feat(skill-system): prompt-compiler injects output-style into system prompt (B5)"
```

---

## Task 25: B5 Final Verification

- [ ] **Step 1: Run all unit tests**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -5
```

Expected: 60+ tests, 0 failures.

- [ ] **Step 2: Run clickability**

```bash
cd D:/WWriting
npm run verify:app-clickability 2>&1 | tail -5
```

Expected: `ok: true`.

- [ ] **Step 3: Run app-shell**

```bash
cd D:/WWriting
npm run verify:app-shell 2>&1 | tail -5
```

Expected: `ok: true`.

---

## Task 26: Final Verification

- [ ] **Step 1: Run full test suite**

```bash
cd D:/WWriting
node --test tests/*.test.mjs tests/app-shell/*.test.mjs 2>&1 | tail -10
```

Expected: 70+ tests, 0 failures.

- [ ] **Step 2: Run full local verification**

```bash
cd D:/WWriting
npm run verify:local 2>&1 | tail -20
```

Expected: all checks pass, including packaged-dir and installer build.

- [ ] **Step 3: Update user docs**

Edit `docs/USER_GUIDE.zh-CN.md` and add:

```markdown
## 自定义技能

在 `~/.wwriting/skills/<my-skill>/skill.yaml` 写一个 YAML / JSON manifest:

\```yaml
name: my-style
version: 1.0.0
type: style
paths:
  - chapters/poetry/**
hooks:
  - stage: drafting
    action: append_prompt
    content: "在每章草稿后追加:请加入俳句式的短句。"
\```

重启应用后,这个技能会在 `chapters/poetry/**` 目录下自动激活。

## 自定义输出风格

在 `~/.wwriting/output-styles/my-style.md` 写:

\```markdown
---
name: My Style
description: 我的写作风格
---
正文作为 prompt 片段,追加到 system prompt 末尾。
\```

在设置面板的"输出风格"下拉里选它。
```

- [ ] **Step 4: Update developer docs**

Edit `docs/USER_GUIDE.zh-CN.md` (or a separate dev doc) and add:

```markdown
## 新增内置 slash 命令

1. 创建 `src/app-shell/commands/<name>.mjs`,导出一个命令对象
2. 在 `src/app-shell/commands/index.mjs` 中 import 并 `registerCommand(...)`
3. 测试:`tests/command-registry.test.mjs` 增加用例
```

- [ ] **Step 5: Update README**

Edit `README.md` and add to the 功能亮点 section:

```markdown
- 声明式技能系统:frontmatter 驱动的 `SKILL.md` / `skill.yaml`,支持路径条件激活与多源发现
- 全局事件总线:cost-tracker / event-log / failures-store 通过订阅解耦
- 可扩展输出风格:`~/.wwriting/output-styles/*.md` 用户自定义
```

- [ ] **Step 6: Commit docs**

```bash
cd D:/WWriting
git add docs/USER_GUIDE.zh-CN.md README.md
git commit -m "docs: user/dev docs for skill system refactor"
```

- [ ] **Step 7: Final summary commit (if any uncommitted)**

```bash
cd D:/WWriting
git status
git log --oneline -10
```

Review the commit history to confirm all 5 sub-features are present with their test files.

---

## Self-Review (Run After Writing the Plan)

### 1. Spec coverage

| Spec requirement | Implemented in |
|---|---|
| B1: command-registry + 5 slash commands | T2-T8 |
| B2: paths field + activation | T12-T15 |
| B3: 5 sources + realpath dedup | T9-T11 |
| B4: 5-event bus + 3 subscribers + agent-engine emit | T16-T21 |
| B5: 3-source loader + settings dropdown + prompt-compiler | T22-T25 |
| Final verify:local + docs | T26 |

### 2. Placeholder scan

Search the plan for: "TBD", "TODO", "implement later", "fill in details", "appropriate error handling", "similar to Task N". **None found.** All steps have explicit code or commands.

### 3. Type consistency

- `registerCommand`, `unregisterCommand`, `getCommand`, `listCommands`, `onCommandsChanged` — used consistently across T2, T6, T7
- `parseSkillPaths` — defined in T12, used in T13 (registerProjectSkill)
- `resolveSkillSources({ projectRoot, userHome, resourcesPath })` — defined in T9, used in T10 (loadEnabledSkills)
- `on(event, fn)`, `off(event, fn)`, `emit(event, payload)` — used consistently in T16-T20
- `CORE_EVENTS.ModelCallStart` / `ModelCallComplete` / `ChapterWritten` / `TaskFailed` / `BackupNeeded` — used in T16, T17, T18, T19, T20
- `loadOutputStyles({ projectRoot, userHome })` — used in T23, T24
- Command data shape: `{ name, category, description, userFacingName, userInvocable, icon, slashKey, isConcurrencySafe, isReadOnly, isEnabled, canUse, run, renderResult }` — consistent in T4, T5, T6

No mismatches found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-02-skill-system-refactor.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
