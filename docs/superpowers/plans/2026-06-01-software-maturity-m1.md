# WWriting Software Maturity M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current large optimization into a stable, reviewable baseline with clear verification, safer state transitions, bounded recent-log reads, and a minimal diagnostic data outlet.

**Architecture:** M1 is a stabilization layer, not a product rewrite. It adds small, testable units around existing state, queue, event-log, and app-server code, then records the delivery evidence in plain-language reports. UI work is limited to exposing existing data through a light diagnostic entry point; large new diagnostic screens are deferred to M2.

**Tech Stack:** Node.js 24+ ES modules, Electron 42, vanilla app-shell, Node built-in test runner, existing `npm` verification scripts.

**Source Spec:** `docs/superpowers/specs/2026-06-01-software-maturity-roadmap-design.md`

**Commit Strategy:** Do not use `git add -A`. Stage files by task group only after review. If the workspace contains unrelated changes, leave them untouched.

---

## File Structure Overview

### New Files

| File | Responsibility |
| --- | --- |
| `docs/superpowers/reports/2026-06-01-m1-change-audit.md` | Plain-language grouping of current changes: backend reliability, frontend split, tests, docs, unrelated/uncertain changes. |
| `docs/superpowers/reports/2026-06-01-m1-verification-matrix.md` | Verification matrix that explains which command proves which layer of maturity. |
| `docs/superpowers/reports/2026-06-01-m1-delivery-report.md` | Final M1 report: completed items, verification evidence, accepted exceptions, remaining risks, next step. |
| `src/core/project-lock.mjs` | Small per-project async lock to serialize state/queue mutations inside the app-server process. |
| `tests/project-lock.test.mjs` | Lock tests for sequential execution, release on throw, and per-project isolation. |
| `src/core/project-diagnostics.mjs` | Minimal diagnostic data builder for project status, queue summary, recent events, model errors, failures, and recovery hints. |
| `tests/project-diagnostics.test.mjs` | Diagnostic data tests using local temp projects. |

### Modified Files

| File | Change |
| --- | --- |
| `src/core/app-server.mjs` | Wrap stop/retry/queue mutation paths with the project lock; add `/api/diagnostics` JSON endpoint. |
| `src/core/event-log.mjs` | Keep the current tail-reading behavior and expose enough structure for a large-log regression test if needed. |
| `tests/event-log.test.mjs` | Add a large-log sample test proving recent-event reads do not require full-log scanning behavior. |
| `tests/task-queue.test.mjs` | Add state-transition tests that document allowed transitions and blocked transitions. |
| `tests/app-server-probe.test.mjs` | Add race-oriented tests for stop/retry/auto-advance consistency and diagnostics endpoint behavior. |
| `package.json` | Add optional verification helper script only if the plan implementation creates one; otherwise leave unchanged. |

### Confirmed Existing APIs

Use these existing APIs exactly:

- `src/core/failures-store.mjs` exports `appendFailure(projectRoot, card)` and `readFailures(projectRoot)`.
- `readFailures(projectRoot)` does not accept a `limit` option; callers that need recent failures must slice the returned array themselves.
- `src/core/project-store.mjs` exports `loadState(projectRoot)` and `saveState(projectRoot, state)`.
- `TaskQueue` is constructed with a project root: `new TaskQueue(projectRoot)`. It resolves `task_queue.json` internally.
- `tests/app-server-probe.test.mjs` already provides helpers named `setupServer`, `closeServer`, `getJson`, `postJson`, `deferredRun`, and `waitFor`.

---

## Phase 1: Delivery Evidence Before More Code

### Task 1: Change Audit Report

**Files:**
- Create: `docs/superpowers/reports/2026-06-01-m1-change-audit.md`
- Read: `git status --short`
- Read: `git diff --stat`

- [ ] **Step 1: Create the reports directory if missing**

Run:
```powershell
New-Item -ItemType Directory -Force -Path 'D:\WWriting\docs\superpowers\reports'
```

Expected: directory exists. No source code changes.

- [ ] **Step 2: Capture current changed-file list**

Run:
```powershell
git status --short
```

Expected: output includes modified and untracked files. Keep this output for the audit report.

- [ ] **Step 3: Capture current diff summary**

Run:
```powershell
git diff --stat
```

Expected: output summarizes modified tracked files. Untracked files will not appear here; list them separately from `git status --short`.

- [ ] **Step 4: Write the audit report**

Create `docs/superpowers/reports/2026-06-01-m1-change-audit.md` with this structure:

```markdown
# M1 Change Audit

## Purpose

This report groups the current working-tree changes before M1 stabilization continues.

## Backend Reliability

| File | Why It Changed | Review Status |
| --- | --- | --- |
| `src/core/model-client.mjs` | Retry, timeout, abort, retry callback behavior. | Needs focused diff review |
| `src/core/provider-adapters.mjs` | Real streaming, stream usage options, transport error classification. | Needs focused diff review |
| `src/core/event-log.mjs` | Recent-event tail reading. | Needs focused diff review |
| `src/core/app-server.mjs` | Unified errors, queue/run lifecycle changes. | Needs focused diff review |
| `src/core/app-state.mjs` | Missing state file is quiet; invalid state file is reported. | Needs focused diff review |
| `src/core/http-error.mjs` | Shared HTTP error envelope. | Needs focused diff review |

## Frontend Split

| File | Why It Changed | Review Status |
| --- | --- | --- |
| `src/app-shell/app.js` | Reduced entry file and delegated rendering/helpers. | Needs focused diff review |
| `src/app-shell/api-client.js` | API request wrapper. | Needs focused diff review |
| `src/app-shell/composer.js` | Command parsing and submission. | Needs focused diff review |
| `src/app-shell/drawer-panels.js` | Right drawer rendering. | Needs focused diff review |
| `src/app-shell/settings-modal.js` | Settings modal behavior. | Needs focused diff review |
| `src/app-shell/thread-renderer.js` | Thread rendering. | Needs focused diff review |
| `src/app-shell/utils.js` | Shared app-shell helpers. | Needs focused diff review |
| `src/app-shell/styles.css` | CSS cleanup and anchor removal. | Needs focused diff review |

## Tests

| File | Coverage Added | Review Status |
| --- | --- | --- |
| `tests/model-client-retry.test.mjs` | Retry, timeout, abort behavior. | Needs focused diff review |
| `tests/provider-adapters.test.mjs` | Streaming, CRLF SSE, malformed frame reporting. | Needs focused diff review |
| `tests/event-log.test.mjs` | Tail reads and missing log behavior. | Needs focused diff review |
| `tests/app-state.test.mjs` | Missing/invalid app state logging behavior. | Needs focused diff review |
| `tests/app-shell/*.test.mjs` | Component rendering coverage. | Needs focused diff review |

## Documentation And Plans

| File | Purpose | Review Status |
| --- | --- | --- |
| `docs/superpowers/specs/2026-06-01-full-optimization-design.md` | Prior full optimization spec. | Needs final acceptance |
| `docs/superpowers/plans/2026-06-01-full-optimization.md` | Prior full optimization plan. | Needs final acceptance |
| `docs/superpowers/specs/2026-06-01-software-maturity-roadmap-design.md` | M1/M2/M3 maturity roadmap. | Approved by user |
| `docs/superpowers/plans/2026-06-01-software-maturity-m1.md` | This implementation plan. | In progress |

## Unrelated Or Uncertain Changes

List files from `git status --short` that are not clearly part of M1 or the prior full optimization. Do not stage these with M1 changes until they are classified.

## Review Rule

Do not use `git add -A`. Stage backend, frontend, tests, docs, and unrelated changes separately.
```

- [ ] **Step 5: Verify the report is readable**

Run:
```powershell
Get-Content -LiteralPath 'D:\WWriting\docs\superpowers\reports\2026-06-01-m1-change-audit.md' -TotalCount 80
```

Expected: report has the sections above and no unfinished placeholder text.

---

### Task 2: Verification Matrix

**Files:**
- Create: `docs/superpowers/reports/2026-06-01-m1-verification-matrix.md`
- Read: `package.json`
- Read: `scripts/verify-local-all.mjs`
- Read: `scripts/verify-app-clickability.cjs`
- Read: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: Confirm verification commands**

Run:
```powershell
npm run
```

Expected: output includes `test`, `verify:app-shell`, `verify:app-clickability`, and `verify:local`.

- [ ] **Step 2: Write the verification matrix**

Create `docs/superpowers/reports/2026-06-01-m1-verification-matrix.md`:

```markdown
# M1 Verification Matrix

## Purpose

This matrix explains which command proves which part of M1 maturity. It is written for both developers and non-specialist reviewers.

## Verification Levels

| Level | Command | What It Proves | When To Run | M1 Gate |
| --- | --- | --- | --- | --- |
| Fast unit/integration | `npm test` | Core behavior, app-shell component tests, queue, event-log, provider adapter tests. | Every task and before review. | Must pass |
| App shell smoke | `npm run verify:app-shell` | Dashboard shell can render a demo project and failure-card whitelist matches. | Before M1 review. | Must pass |
| Clickability | `npm run verify:app-clickability` | Electron UI has clickable primary controls and no obvious blocked workflow. | Before M1 review. | Must pass unless documented non-blocking environment exception |
| Full local | `npm run verify:local` | Local end-to-end verification bundle. | Before M1 completion. | Must pass unless documented non-blocking environment exception |

## Exception Rule

An M1 gate exception is allowed only when all of these are true:

1. The failure is proven to be an environment issue or explicitly accepted non-blocking issue.
2. The report records the exact command, exit status, and failure summary.
3. The report records user impact.
4. The report records the follow-up task or reason no follow-up is needed.

## Failure Classification

| Category | Examples | Owner |
| --- | --- | --- |
| Model | Provider timeout, malformed provider response, retry exhausted. | Backend reliability |
| State | Conflicting project status, bad state file, failed migration. | State/queue |
| Queue | Multiple running tasks, stale running task, retry conflict. | State/queue |
| Event Log | Slow recent-event reads, malformed log lines. | Event log |
| Frontend | Button not clickable, dashboard stale, unclear error. | App shell |
| Packaging | Electron launch, installer, packaged dir. | Release engineering |

## Required Evidence In Delivery Report

- Command run.
- Date and local environment.
- Pass/fail result.
- If failed, exception decision and follow-up.
```

- [ ] **Step 3: Verify no weak gates remain**

Run:
```powershell
Select-String -Path 'D:\WWriting\docs\superpowers\reports\2026-06-01-m1-verification-matrix.md' -Pattern 'optional|uncertain|if convenient|deferred'
```

Expected: no matches except this command line itself.

---

## Phase 2: State And Queue Stability

### Task 3: Per-Project Mutation Lock

**Files:**
- Create: `src/core/project-lock.mjs`
- Create: `tests/project-lock.test.mjs`

- [ ] **Step 1: Write failing lock tests**

Create `tests/project-lock.test.mjs`:

```javascript
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectLockRegistry } from "../src/core/project-lock.mjs";

test("project lock serializes work for the same project", async () => {
  const locks = createProjectLockRegistry();
  const projectRoot = path.join(os.tmpdir(), "wwriting-lock-same");
  const events = [];

  const first = locks.runExclusive(projectRoot, async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 25));
    events.push("first:end");
    return "first";
  });
  const second = locks.runExclusive(projectRoot, async () => {
    events.push("second:start");
    events.push("second:end");
    return "second";
  });

  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("project lock releases after a failing task", async () => {
  const locks = createProjectLockRegistry();
  const projectRoot = path.join(os.tmpdir(), "wwriting-lock-throw");

  await assert.rejects(
    () => locks.runExclusive(projectRoot, async () => {
      throw new Error("boom");
    }),
    /boom/u
  );

  const result = await locks.runExclusive(projectRoot, async () => "recovered");
  assert.equal(result, "recovered");
});

test("project lock allows different projects to run independently", async () => {
  const locks = createProjectLockRegistry();
  const events = [];

  await Promise.all([
    locks.runExclusive("project-a", async () => {
      events.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("a:end");
    }),
    locks.runExclusive("project-b", async () => {
      events.push("b:start");
      events.push("b:end");
    })
  ]);

  assert.ok(events.indexOf("b:start") < events.indexOf("a:end"));
});
```

- [ ] **Step 2: Run the failing tests**

Run:
```powershell
node --test tests/project-lock.test.mjs
```

Expected: FAIL because `src/core/project-lock.mjs` does not exist.

- [ ] **Step 3: Implement the lock registry**

Create `src/core/project-lock.mjs`:

```javascript
import path from "node:path";

export function createProjectLockRegistry() {
  const tails = new Map();

  async function runExclusive(projectRoot, fn) {
    const key = normalizeProjectKey(projectRoot);
    const previous = tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    tails.set(key, previous.then(() => current, () => current));

    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === current) {
        tails.delete(key);
      }
    }
  }

  return { runExclusive };
}

function normalizeProjectKey(projectRoot) {
  const resolved = path.resolve(String(projectRoot ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
```

- [ ] **Step 4: Verify the lock tests pass**

Run:
```powershell
node --test tests/project-lock.test.mjs
```

Expected: 3 tests pass.

---

### Task 4: Wrap App-Server State Mutations With The Project Lock

**Files:**
- Modify: `src/core/app-server.mjs`
- Modify: `tests/app-server-probe.test.mjs`
- Read: `src/core/task-queue.mjs`

- [ ] **Step 1: Write a race regression test for stop vs retry**

Add a test to `tests/app-server-probe.test.mjs` near the existing stop/retry tests:

```javascript
test("stop and retry do not leave multiple running tasks", async () => {
  let activeRun = null;
  async function testRunProject(projectRoot, options) {
    activeRun = {};
    activeRun.promise = new Promise((resolve, reject) => {
      activeRun.resolve = resolve;
      activeRun.reject = reject;
    });
    options.onHeartbeat?.({ step: 0, stage: "queued", chapter: 1 });
    options.signal?.addEventListener("abort", () => {
      setTimeout(() => activeRun.reject(new Error(String(options.signal.reason ?? "cancelled"))), 50);
    }, { once: true });
    return activeRun.promise;
  }

  const { server, port } = await setupServer({ testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "write chapter" });
    await waitFor(async () => {
      const { data } = await getJson(port, "/api/queue/state");
      return data.tasks.some((task) => task.status === "running") && data;
    });

    await Promise.allSettled([
      postJson(port, "/api/run/stop", {}),
      postJson(port, "/api/run/retry", {})
    ]);

    const { data: queue } = await getJson(port, "/api/queue/state");
    const running = queue.tasks.filter((task) => task.status === "running");
    assert.ok(running.length <= 1, `expected at most one running task, got ${running.length}`);
  } finally {
    await closeServer(server);
  }
});
```

If helper names differ in the file, adapt only the helper calls, not the assertion.

- [ ] **Step 2: Run the regression test**

Run:
```powershell
node --test tests/app-server-probe.test.mjs --test-name-pattern "stop and retry do not leave multiple running tasks"
```

Expected: FAIL or expose the existing race before the app-server-level lock is integrated. If it already passes, keep the test because it documents the invariant with a controlled abort delay.

- [ ] **Step 3: Add a lock registry to app-server context**

In `src/core/app-server.mjs`, import the lock:

```javascript
import { createProjectLockRegistry } from "./project-lock.mjs";
```

Inside `createAppShellServer`, create a registry near the existing `runJobs` and queue state:

```javascript
const projectLocks = createProjectLockRegistry();
```

Add it to the context object passed to route handlers:

```javascript
projectLocks
```

The new project lock protects cross-module compound operations such as `abort active job -> update queue -> update project state -> conditionally start retry`. It does not replace `TaskQueue.withLock()`, which already serializes single-queue mutations.

- [ ] **Step 4: Wrap mutation routes**

Wrap these route handlers so each selected project mutation is serialized:

```javascript
return context.projectLocks.runExclusive(projectRoot, async () => {
  return serveRunStopLocked(response, context, projectRoot);
});
```

Use this pattern for:

- `serveRunStop`
- `serveRunRetry`
- `serveQueueCancel`
- `startProjectRun` call sites that mutate task state

Keep the public route function names, and extract locked inner helpers only where it keeps code readable.

- [ ] **Step 5: Verify app-server probe tests**

Run:
```powershell
node --test tests/app-server-probe.test.mjs
```

Expected: all app-server probe tests pass.

---

### Task 5: Task Queue State Transition Contract

**Files:**
- Modify: `tests/task-queue.test.mjs`
- Modify: `src/core/task-queue.mjs` only if tests expose a real gap

- [ ] **Step 1: Add transition-contract tests**

Add tests to `tests/task-queue.test.mjs`:

```javascript
test("terminal tasks cannot be completed, blocked, interrupted, or cancelled again", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-queue-terminal-"));
  const queue = new TaskQueue(root);
  const task = await queue.enqueue("write", { mode: "write" });

  await queue.complete(task.id, { ok: true });

  assert.equal(await queue.complete(task.id, { ok: false }), null);
  assert.equal(await queue.interrupt(task.id, new Error("late interrupt")), null);
  assert.equal(await queue.cancel(task.id, "late cancel"), null);
  assert.equal(await queue.block(task.id, "late block"), null);

  const state = queue.getState();
  assert.equal(state.tasks[0].status, "completed");
  assert.deepEqual(state.tasks[0].result, { ok: true });
});

test("retry is allowed only for interrupted and cancelled tasks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-queue-retry-contract-"));
  const queue = new TaskQueue(root);

  const completed = await queue.enqueue("done", { mode: "write" });
  await queue.complete(completed.id, { ok: true });
  assert.equal(await queue.retry(completed.id), null);

  const blocked = await queue.enqueue("blocked", { mode: "write" });
  await queue.block(blocked.id, "missing provider");
  assert.equal(await queue.retry(blocked.id), null);

  const interrupted = await queue.enqueue("interrupted", { mode: "write" });
  await queue.interrupt(interrupted.id, new Error("timeout"));
  const retried = await queue.retry(interrupted.id);
  assert.equal(retried.status, "running");
});
```

- [ ] **Step 2: Run transition tests**

Run:
```powershell
node --test tests/task-queue.test.mjs
```

Expected: tests pass if current contract is already correct; otherwise fail on the exact invalid transition.

- [ ] **Step 3: Fix only real transition gaps**

If a test fails, modify only the method with the gap in `src/core/task-queue.mjs`. For example, terminal-only mutation methods must keep this guard:

```javascript
if (!task || task.status !== "running") {
  return null;
}
```

Retry must keep this guard:

```javascript
if (!task || !["interrupted", "cancelled"].includes(task.status)) {
  return null;
}
```

If all transition tests pass without implementation changes, record in the M1 delivery report: `TaskQueue existing guards verified; no code change required for Task 5.`

- [ ] **Step 4: Verify task queue tests**

Run:
```powershell
node --test tests/task-queue.test.mjs
```

Expected: all task queue tests pass.

---

## Phase 3: Event Log And Diagnostics

### Task 6: Large Event Log Regression Test

**Files:**
- Modify: `tests/event-log.test.mjs`
- Modify: `src/core/event-log.mjs` only if the test exposes full-log recent reads

- [ ] **Step 1: Add a large-log recent-read test**

Add this test to `tests/event-log.test.mjs`:

```javascript
test("readEvents with a small limit handles a large log and returns only recent events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-events-large-"));
  for (let i = 0; i < 5000; i += 1) {
    await appendEvent(root, {
      type: "large_sample",
      seq: i,
      message: `event ${i}`
    });
  }

  const started = performance.now();
  const recent = await readEvents(root, { limit: 5 });
  const elapsedMs = performance.now() - started;

  assert.deepEqual(recent.map((event) => event.seq), [4995, 4996, 4997, 4998, 4999]);
  assert.ok(elapsedMs < 100, `expected recent log read under 100ms, got ${elapsedMs}ms`);
});
```

The threshold is intentionally still broad enough for ordinary local machines, but tight enough to catch obvious full-scan regressions on a 5000-line sample. If this proves flaky on a slow machine, replace the time assertion with an implementation-specific byte-window assertion rather than loosening it back to a very high value.

- [ ] **Step 2: Run event-log tests**

Run:
```powershell
node --test tests/event-log.test.mjs
```

Expected: all event-log tests pass. If the new test is flaky on the local machine, replace the strict time assertion with an implementation-specific byte-window assertion in `event-log.mjs`.

- [ ] **Step 3: Keep implementation small**

If `src/core/event-log.mjs` needs changes, preserve this behavior:

```javascript
export async function tailEvents(projectRoot, n) {
  return readEvents(projectRoot, { limit: n });
}
```

Recent reads must not call full `readFile` when `limit` is a small positive number.

- [ ] **Step 4: Verify dashboard still uses limited reads**

Run:
```powershell
Select-String -Path 'D:\WWriting\src\core\app-dashboard.mjs' -Pattern 'readEvents\(projectRoot, \{ limit:'
```

Expected: dashboard event reads use a limit.

---

### Task 7: Minimal Project Diagnostics Data Outlet

**Files:**
- Create: `src/core/project-diagnostics.mjs`
- Create: `tests/project-diagnostics.test.mjs`
- Modify: `src/core/app-server.mjs`
- Modify: `tests/app-server-probe.test.mjs`

- [ ] **Step 1: Write diagnostics unit tests**

Create `tests/project-diagnostics.test.mjs`:

```javascript
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendEvent } from "../src/core/event-log.mjs";
import { appendFailure } from "../src/core/failures-store.mjs";
import { loadProjectDiagnostics } from "../src/core/project-diagnostics.mjs";
import { TaskQueue } from "../src/core/task-queue.mjs";
import { saveState } from "../src/core/project-store.mjs";

test("loadProjectDiagnostics summarizes state, queue, recent events, failures, and recovery hint", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-diagnostics-"));
  await saveState(root, {
    project_status: "interrupted",
    current_stage: "drafting",
    current_chapter_no: 2,
    interrupted_reason: "provider timeout"
  });

  const queue = new TaskQueue(root);
  const task = await queue.enqueue("continue chapter", { mode: "write" });
  await queue.interrupt(task.id, new Error("provider timeout"));

  await appendEvent(root, { type: "model_call_failed", message: "provider timeout", stage: "drafting" });
  await appendFailure(root, {
    id: "failure-1",
    type: "provider-error",
    message: "provider timeout",
    createdAt: new Date().toISOString()
  });

  const diagnostics = await loadProjectDiagnostics(root);

  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.project.status, "interrupted");
  assert.equal(diagnostics.queue.interruptedCount, 1);
  assert.equal(diagnostics.recentEvents[0].type, "model_call_failed");
  assert.equal(diagnostics.failures.length, 1);
  assert.match(diagnostics.recoveryHint.message, /重试|恢复|retry|resume/u);
});
```

- [ ] **Step 2: Run failing diagnostics test**

Run:
```powershell
node --test tests/project-diagnostics.test.mjs
```

Expected: FAIL because `src/core/project-diagnostics.mjs` does not exist.

- [ ] **Step 3: Implement diagnostics builder**

Create `src/core/project-diagnostics.mjs`:

```javascript
import { loadState } from "./project-store.mjs";
import { readEvents } from "./event-log.mjs";
import { readFailures } from "./failures-store.mjs";
import { TaskQueue } from "./task-queue.mjs";

export async function loadProjectDiagnostics(projectRoot) {
  const [state, events, failures, queueState] = await Promise.all([
    loadState(projectRoot).catch((error) => ({ project_status: "unknown", load_error: error.message })),
    readEvents(projectRoot, { limit: 20 }),
    Promise.resolve().then(() => readFailures(projectRoot)).then((items) => items.slice(-10).reverse()).catch(() => []),
    loadQueueState(projectRoot)
  ]);

  return {
    ok: true,
    project: {
      status: state.project_status ?? "unknown",
      stage: state.current_stage ?? null,
      chapter: state.current_chapter_no ?? null,
      reason: state.blocked_reason ?? state.interrupted_reason ?? state.cancelled_reason ?? state.load_error ?? null
    },
    queue: summarizeQueue(queueState),
    recentEvents: events.slice(-20).reverse(),
    modelErrors: events.filter((event) => isModelError(event)).slice(-5).reverse(),
    failures,
    recoveryHint: buildRecoveryHint(state, queueState)
  };
}

async function loadQueueState(projectRoot) {
  const queue = new TaskQueue(projectRoot);
  await queue.load();
  return queue.getState();
}

function summarizeQueue(queueState) {
  const tasks = queueState.tasks ?? [];
  return {
    total: tasks.length,
    runningCount: tasks.filter((task) => task.status === "running").length,
    queuedCount: tasks.filter((task) => task.status === "queued").length,
    interruptedCount: tasks.filter((task) => task.status === "interrupted").length,
    cancelledCount: tasks.filter((task) => task.status === "cancelled").length,
    blockedCount: tasks.filter((task) => task.status === "blocked").length,
    completedCount: tasks.filter((task) => task.status === "completed").length,
    recentTasks: tasks.slice(-10).reverse()
  };
}

function isModelError(event) {
  return /model|provider|timeout|transport/u.test(String(event.type ?? "")) || /model|provider|timeout|transport/u.test(String(event.message ?? ""));
}

function buildRecoveryHint(state, queueState) {
  const status = state.project_status;
  const tasks = queueState.tasks ?? [];
  if (status === "blocked") {
    return { action: "fix-blocker", message: "项目已阻塞。请先处理失败原因，再继续运行。" };
  }
  if (status === "interrupted" || tasks.some((task) => task.status === "interrupted")) {
    return { action: "retry", message: "项目被中断。可以使用重试或恢复继续旧任务。" };
  }
  if (status === "cancelled" || tasks.some((task) => task.status === "cancelled")) {
    return { action: "resume", message: "项目已停止。可以恢复项目，软件会创建恢复任务。" };
  }
  if (status === "running" || tasks.some((task) => task.status === "running")) {
    return { action: "wait-or-stop", message: "项目正在运行。等待完成，或先停止当前任务。" };
  }
  return { action: "none", message: "当前没有需要处理的恢复动作。" };
}
```

- [ ] **Step 4: Verify diagnostics unit tests**

Run:
```powershell
node --test tests/project-diagnostics.test.mjs
```

Expected: diagnostics tests pass.

- [ ] **Step 5: Add `/api/diagnostics` endpoint**

In `src/core/app-server.mjs`, import:

```javascript
import { loadProjectDiagnostics } from "./project-diagnostics.mjs";
```

Add a route near dashboard/project routes:

```javascript
if (request.method === "GET" && url.pathname === "/api/diagnostics") {
  return serveDiagnostics(response, context);
}
```

Add helper:

```javascript
async function serveDiagnostics(response, context) {
  const projectRoot = await resolveActiveProjectRoot({ selected: context.selected });
  if (!projectRoot) {
    return serveJson(response, { ok: false, code: "no_project", message: "没有打开的项目。" }, 404);
  }
  const diagnostics = await loadProjectDiagnostics(projectRoot);
  return serveJson(response, diagnostics);
}
```

Adapt `resolveActiveProjectRoot` call to the existing context shape if needed.

- [ ] **Step 6: Add endpoint probe test**

Add to `tests/app-server-probe.test.mjs`:

```javascript
test("GET /api/diagnostics returns plain recovery data for the selected project", async () => {
  const { server, projectRoot, port } = await setupServer();
  try {
    await saveState(projectRoot, {
      project_status: "interrupted",
      current_stage: "drafting",
      current_chapter_no: 1,
      interrupted_reason: "provider timeout"
    });

    const data = await getJson(port, "/api/diagnostics");
    assert.equal(data.ok, true);
    assert.equal(data.project.status, "interrupted");
    assert.equal(data.recoveryHint.action, "retry");
  } finally {
    await closeServer(server);
  }
});
```

- [ ] **Step 7: Verify app-server diagnostics**

Run:
```powershell
node --test tests/project-diagnostics.test.mjs tests/app-server-probe.test.mjs
```

Expected: all diagnostics and app-server probe tests pass.

---

## Phase 4: M1 Delivery Closeout

### Task 8: Full Verification And Delivery Report

**Files:**
- Create: `docs/superpowers/reports/2026-06-01-m1-delivery-report.md`
- Read: `docs/superpowers/reports/2026-06-01-m1-change-audit.md`
- Read: `docs/superpowers/reports/2026-06-01-m1-verification-matrix.md`

- [ ] **Step 1: Run fast test suite**

Run:
```powershell
npm test
```

Expected: all tests pass. Record test count and failure count.

- [ ] **Step 2: Run app-shell verification**

Run:
```powershell
npm run verify:app-shell
```

Expected: command exits 0 and prints `{ "ok": true, ... }`.

- [ ] **Step 3: Run clickability verification**

Run:
```powershell
npm run verify:app-clickability
```

Expected: command exits 0. If it fails because Electron or display environment is unavailable, record it as a candidate exception with exact error output and user impact.

- [ ] **Step 4: Run full local verification**

Run:
```powershell
npm run verify:local
```

Expected: command exits 0. If it fails, it cannot be ignored unless the exception rule in the verification matrix is satisfied.

- [ ] **Step 5: Write delivery report**

Create `docs/superpowers/reports/2026-06-01-m1-delivery-report.md`:

```markdown
# M1 Delivery Report

## Summary

M1 stabilizes the current optimization into a reviewable baseline.

## Completed

- Change audit report created.
- Verification matrix created.
- Project mutation lock added and covered by tests.
- Stop/retry/queue state invariants covered by tests.
- Event-log recent-read large sample covered by tests.
- Minimal diagnostics data outlet added.

## Verification Evidence

| Command | Result | Notes |
| --- | --- | --- |
| `npm test` | Use result from Step 1 | Include exact pass/fail count from the command output |
| `npm run verify:app-shell` | Use result from Step 2 | Include the `ok` value and demo project path from the command output |
| `npm run verify:app-clickability` | Use result from Step 3 | If an exception is accepted, include reason, impact, and follow-up |
| `npm run verify:local` | Use result from Step 4 | If an exception is accepted, include reason, impact, and follow-up |

## Accepted Exceptions

If there are no exceptions, write:

No accepted exceptions.

If there are exceptions, each exception must include:

- Command:
- Failure:
- Why it is non-blocking:
- User impact:
- Follow-up:

## Remaining Risks

- M2 still needs user-facing project management and history improvements.
- M3 still needs release packaging and upgrade maturity.

## Next Step

Review and stage M1 files by group. Do not use `git add -A`.
```

- [ ] **Step 6: Scan the plan and reports for placeholders**

Run the documented placeholder scan against the M1 plan and reports.

Expected: no placeholder matches. The delivery report may contain explicit exception fields only if they are filled in.

- [ ] **Step 7: Final status check**

Run:
```powershell
git status --short
```

Expected: M1 files are visible and can be staged by group. Do not stage unrelated files automatically.

---

## Self-Review Checklist For The Implementer

Before marking M1 complete, verify:

- [ ] M1 did not add a large new UI.
- [ ] `npm test` passes.
- [ ] `npm run verify:app-shell` passes.
- [ ] `npm run verify:app-clickability` passes or has a documented accepted exception.
- [ ] `npm run verify:local` passes or has a documented accepted exception.
- [ ] Stop/retry/resume state cannot leave more than one running task.
- [ ] Recent event reads use bounded recent-read behavior.
- [ ] Diagnostics data tells a plain-language story: current status, recent events, model errors, failures, recovery hint.
- [ ] Reports explain the work in language a non-specialist can follow.
