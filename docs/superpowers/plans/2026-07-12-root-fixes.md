# WWriting Root Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 使用并行处理方式 (recommended) 或 superpowers:executing-plans 来实现此计划中的任务。步骤使用复选框（`- [ ]`）语法进行任务跟踪。

**Goal:** 修复设置保存、跨项目异步回写、Electron 端口冲突和模型扩展字段丢失四类已确认缺陷。

**Architecture:** 保持现有 HTTP 服务、项目作用域和 Electron 启动结构，只修复边界契约：非模型设置更新复用当前项目模型，异步 UI 回调携带并校验项目代次，桌面监听端口失败时选择可用端口，模型校验保留受支持扩展字段。每项修复都先添加能稳定复现原问题的测试，再写最小实现。

**Tech Stack:** Node.js ESM tests, Electron main process, local file persistence.

---

### Task 1: 允许非模型设置独立保存

**Files:**
- Modify: `src/core/app-server.mjs:512-555`
- Test: `tests/app-server-probe.test.mjs`

- [x] **Step 1: Write the failing test**
  Add a request test that posts only `tool_permissions` and `budget_config` to `/api/settings/update`, then asserts HTTP 200 and persisted values.
- [x] **Step 2: Run the focused test and verify it fails**
  Run `node --test tests/app-server-probe.test.mjs`; expected failure is HTTP 400 `invalid_active_model`.
- [x] **Step 3: Implement the minimal route split**
  Normalize the non-model patch first; when `active_model` is absent, call `updateProjectSettings` directly and return the same project/effective config shape without invoking model validation or secret persistence.
- [x] **Step 4: Run the focused test and verify it passes**
  Run `node --test tests/app-server-probe.test.mjs` and confirm the new test and existing settings tests pass.

### Task 2: 保证模型扩展字段持久化

**Files:**
- Modify: `src/core/model-config-validation.mjs:11-41`
- Test: `tests/model-config-validation.test.mjs`, `tests/app-server-probe.test.mjs`

- [x] **Step 1: Write the failing test**
  Assert that `validateModelConfig` and the HTTP settings transaction preserve `pricing`, `stream`, `cache_mode`, `max_context_tokens`, and `max_output_tokens`.
- [x] **Step 2: Run the focused test and verify it fails**
  Run `node --test tests/model-config-validation.test.mjs tests/app-server-probe.test.mjs`; expected failure is missing extension fields after validation/persistence.
- [x] **Step 3: Implement the minimal field-preserving validation**
  Copy only the already supported optional fields, preserving existing type/positive-number validation helpers and rejecting unknown or malformed values as before.
- [x] **Step 4: Run the focused test and verify it passes**
  Re-run the two focused test files and confirm persisted `project.yaml` retains the extension fields.

### Task 3: 阻断跨项目晚到异步回写

**Files:**
- Modify: `src/app-shell/composer.js:728-866`, `src/app-shell/app.js:528-563`
- Test: `tests/app-shell/app-shell-project-switch.test.mjs`

- [x] **Step 1: Write the failing test**
  Simulate an A side-question response that resolves after switching to B; assert no A bubble is appended and no promotion can submit to B.
- [x] **Step 2: Run the focused test and verify it fails**
  Run `node --test tests/app-shell/app-shell-project-switch.test.mjs`; expected failure is the late A entry appearing in the current thread.
- [x] **Step 3: Implement the minimal generation guard**
  Capture the current project-scope token before each async composer request and return without DOM/state mutation when `projectScope.isCurrent(token)` is false; pass the original token through promotion checks.
- [x] **Step 4: Run the focused test and verify it passes**
  Re-run the project-switch test and the composer/chat tests.

### Task 4: 让 Electron 端口冲突可恢复

**Files:**
- Modify: `src/desktop/electron-main.cjs:8,54-64`
- Test: `tests/desktop-main.test.mjs` or a focused smoke script

- [x] **Step 1: Write the failing test**
  Occupy the default port, launch the Electron smoke entry without `PORT`, and assert it still reports a loaded local URL on another port.
- [x] **Step 2: Run the focused test and verify it fails**
  Run the focused smoke test; expected failure is process exit from `EADDRINUSE`.
- [x] **Step 3: Implement minimal fallback**
  Centralize server startup in a helper that tries the requested port and, on `EADDRINUSE`, retries with port `0`; use the resolved address for readiness and `BrowserWindow.loadURL`.
- [x] **Step 4: Run the focused test and verify it passes**
  Run the smoke test with and without an occupied port, then run the existing Electron runtime verification.

### Final Verification

- [x] Run `npm run test` and confirm zero failures.
- [x] Run `npm run verify:app-shell`, `npm run verify:desktop-shell`, and `npm run verify:app-clickability`.
- [x] Run `npm run verify:mvp`, `npm run verify:faults`, and `npm run verify:packaged-dir`.
- [x] Review `git diff` and confirm only the four root fixes plus their regression tests changed.
