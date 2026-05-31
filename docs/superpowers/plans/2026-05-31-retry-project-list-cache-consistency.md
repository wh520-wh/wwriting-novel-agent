# Retry, Project List, and Cache Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make retry, the "My Novels" list, and cache reporting internally consistent so every visible action maps to a backend operation that can actually succeed.

**Architecture:** Keep the existing Electron app shell, HTTP server, `TaskQueue`, and dashboard polling model. Add one retry-candidate resolver shared by dashboard and retry, upgrade task queue recovery metadata in place, expose a project-forget endpoint that edits only app state, and add cache summary data without changing existing cache report compatibility fields.

**Tech Stack:** Node.js ESM, vanilla browser JS/CSS, Electron app shell, `node:test`, existing WWriting core modules.

---

## Scope And Defaults

- Current directory `D:\WWriting` is not a git repository. Checkpoint steps below record verification output instead of running `git commit`.
- No external dependencies are introduced.
- P0 does not implement physical project deletion. It only defines and wires "remove from list".
- Force restart for alive-but-stale jobs is out of P0. P0 hides retry while a live job still exists and keeps stop as the only destructive action.
- Existing `cache_report.last_call.promptBlockHashes` must remain a string map for compatibility.
- P0 cache change reasons are `first_call`, `stable_hash_changed`, and `null`. `template_version_changed` remains specified as a future enhancement because the current cache key is scoped by `${projectId}:${templateVersion}`.

## File Structure

- Create: `src/core/retry-candidates.mjs`
  - Owns retry availability and candidate selection for dashboard and `/api/run/retry`.
- Modify: `src/core/task-queue.mjs`
  - Upgrades queue schema to v2, preserves `source/recovery`, and adds `createRecoveryTask()`.
- Modify: `src/core/app-server.mjs`
  - Imports resolver and `forgetRecentProject`, adds `/api/projects/forget`, removes implicit selected-project scanning from app-shell writes, injects retry fields into dashboard, and rewires retry endpoint.
- Modify: `src/core/app-dashboard.mjs`
  - Adds optional dashboard no-fallback mode and `cacheSummary`.
- Modify: `src/core/cache-key-manager.mjs`
  - Adds stable-change metadata and structured `promptBlocks` while preserving `promptBlockHashes`.
- Modify: `src/app-shell/agent-truth.mjs`
  - Uses dashboard retry fields instead of independent retry inference.
- Modify: `src/app-shell/app.js`
  - Uses retry candidate metadata, adds "remove from list" UI, and calls `/api/projects/forget`.
- Modify: `src/app-shell/styles.css`
  - Adds minimal accessible project-row action styles.
- Modify: `scripts/verify-app-shell.mjs`
  - Adds static assertions for retry fields, project remove UI, and cache summary usage.
- Modify: `tests/task-queue.test.mjs`
  - Adds queue schema/recovery tests.
- Modify: `tests/app-server-probe.test.mjs`
  - Adds retry resolver, project forget, no implicit fallback, and dashboard retry field tests.
- Modify: `tests/app-dashboard.test.mjs`
  - Adds cache summary and no-fallback dashboard tests.
- Modify: `tests/model-gateway.test.mjs`
  - Adds cache stable-change and `promptBlocks` compatibility tests.

---

### Task 1: TaskQueue Recovery Schema

**Files:**
- Modify: `tests/task-queue.test.mjs`
- Modify: `src/core/task-queue.mjs`

- [ ] **Step 1: Add failing queue recovery tests**

In `tests/task-queue.test.mjs`, update the existing schema assertion in `"enqueue stores queued tasks with stable shape and persists them"`:

```js
  assert.equal(raw.schema_version, 2);
```

Then append these tests to `tests/task-queue.test.mjs`:

```js
test("schema v2 preserves recovery metadata across reload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-queue-recovery-"));
  const queue = new TaskQueue(root);
  await queue.load();
  const task = await queue.createRecoveryTask({
    instruction: "继续当前写作任务",
    mode: "write",
    currentStage: "drafting",
    recovery: {
      source: "project_state",
      projectStatus: "interrupted",
      chapterNo: 2,
      stage: "drafting",
      reason: "API timeout",
      createdAt: "2026-05-31T06:34:00.000Z"
    }
  });

  assert.equal(task.status, "running");
  assert.equal(task.source, "project_state_recovery");
  assert.equal(task.recovery.projectStatus, "interrupted");

  const reloaded = new TaskQueue(root);
  await reloaded.load();
  const state = reloaded.getState();
  assert.equal(state.schema_version, 2);
  assert.equal(state.tasks[0].source, "project_state_recovery");
  assert.equal(state.tasks[0].recovery.chapterNo, 2);
});

test("createRecoveryTask refuses to create a second running task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-queue-recovery-running-"));
  const queue = new TaskQueue(root);
  await queue.load();
  await queue.enqueue("already running", { mode: "write" });
  await queue.promoteNext();

  const task = await queue.createRecoveryTask({
    instruction: "继续当前写作任务",
    mode: "write",
    currentStage: "drafting",
    recovery: {
      source: "project_state",
      projectStatus: "interrupted",
      chapterNo: 1,
      stage: "drafting",
      reason: "API timeout"
    }
  });

  assert.equal(task, null);
  const state = queue.getState();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].status, "running");
});
```

- [ ] **Step 2: Run the focused queue tests and confirm failure**

Run:

```powershell
node --test tests/task-queue.test.mjs --test-name-pattern "recovery|schema"
```

Expected: FAIL with `queue.createRecoveryTask is not a function` and/or schema still equal to `1`.

- [ ] **Step 3: Upgrade TaskQueue schema and preserve recovery fields**

In `src/core/task-queue.mjs`, change:

```js
export const TASK_QUEUE_SCHEMA_VERSION = 1;
```

to:

```js
export const TASK_QUEUE_SCHEMA_VERSION = 2;
```

In `normalizeTask(task)`, preserve `source` and `recovery`:

```js
function normalizeTask(task) {
  const now = timestamp();
  return {
    id: task.id ?? `task-${randomUUID()}`,
    index: task.index ?? 0,
    instruction: task.instruction ?? "",
    mode: task.mode ?? "auto",
    status: task.status ?? "queued",
    createdAt: task.createdAt ?? now,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? (TERMINAL_STATUSES.has(task.status) ? now : null),
    updatedAt: task.updatedAt ?? now,
    error: task.error ?? null,
    stages: Array.isArray(task.stages) ? task.stages : [],
    currentStage: task.currentStage ?? null,
    heartbeatAt: task.heartbeatAt ?? null,
    ...(typeof task.source === "string" ? { source: task.source } : {}),
    ...(task.recovery && typeof task.recovery === "object" ? { recovery: clone(task.recovery) } : {}),
    ...(Object.hasOwn(task, "result") ? { result: task.result } : {})
  };
}
```

Add this method inside `TaskQueue`, near `enqueue()`:

```js
  async createRecoveryTask({ instruction, mode = "write", currentStage = "queued", recovery = {} } = {}) {
    return this.withLock(async () => {
      await this.load();
      if (this.state.tasks.some((candidate) => candidate.status === "running")) {
        return null;
      }
      const now = timestamp();
      const task = {
        id: `task-${randomUUID()}`,
        index: nextIndex(this.state.tasks),
        instruction: String(instruction ?? "").trim() || "继续当前写作任务",
        mode,
        status: "running",
        source: "project_state_recovery",
        recovery: {
          source: "project_state",
          createdAt: now,
          ...recovery
        },
        createdAt: now,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        error: recovery?.reason ?? null,
        stages: [],
        currentStage,
        heartbeatAt: now
      };
      this.state.tasks.push(task);
      await this.save();
      return clone(task);
    });
  }
```

- [ ] **Step 4: Run the focused queue tests and confirm pass**

Run:

```powershell
node --test tests/task-queue.test.mjs --test-name-pattern "recovery|schema"
```

Expected: PASS for both new recovery tests.

- [ ] **Step 5: Run the full queue test file**

Run:

```powershell
node --test tests/task-queue.test.mjs
```

Expected: PASS. Existing retry and queue tests remain green after schema v2.

- [ ] **Step 6: Checkpoint**

Record:

```text
Task 1 checkpoint: TaskQueue schema v2 preserves recovery metadata and createRecoveryTask prevents duplicate running tasks.
```

---

### Task 2: Retry Candidate Resolver

**Files:**
- Create: `src/core/retry-candidates.mjs`
- Modify: `tests/app-server-probe.test.mjs`
- Modify: `src/core/app-server.mjs`

- [ ] **Step 1: Add failing server tests for retry candidate behavior**

Append these tests to `tests/app-server-probe.test.mjs`:

```js
test("dashboard disables retry while a live job is still running", async () => {
  const run = deferredRun();
  const { server, port } = await setupServer({ testRunProject: run.testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "live task" });

    const { data } = await getJson(port, "/api/dashboard");

    assert.equal(data.agent_alive, true);
    assert.equal(data.retry_available, false);
    assert.equal(data.retry_code, "retry_still_running");
    assert.match(data.retry_unavailable_reason, /运行|停止/u);

    const retry = await postJson(port, "/api/run/retry", {});
    assert.equal(retry.res.status, 409);
    assert.equal(retry.data.ok, false);
    assert.equal(retry.data.code, "retry_still_running");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/run/retry creates a recovery task for interrupted project state with empty queue", async () => {
  const run = deferredRun();
  const { server, port, projectRoot } = await setupServer({ testRunProject: run.testRunProject });
  try {
    const state = await loadState(projectRoot);
    await saveState(projectRoot, {
      ...state,
      project_status: "interrupted",
      current_stage: "drafting",
      current_chapter_no: 2,
      interrupted_reason: "API timeout"
    });

    const { res, data } = await postJson(port, "/api/run/retry", {});

    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.task.source, "project_state_recovery");
    assert.equal(data.task.recovery.projectStatus, "interrupted");
    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0].options.taskId, data.task.id);

    const { data: queue } = await getJson(port, "/api/queue/state");
    assert.equal(queue.tasks[0].recovery.reason, "API timeout");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/run/retry creates a recovery task for cancelled project state with empty queue", async () => {
  const run = deferredRun();
  const { server, port, projectRoot } = await setupServer({ testRunProject: run.testRunProject });
  try {
    const state = await loadState(projectRoot);
    await saveState(projectRoot, {
      ...state,
      project_status: "cancelled",
      current_stage: "drafting",
      current_chapter_no: 1,
      cancelled_reason: "用户停止"
    });

    const { res, data } = await postJson(port, "/api/run/retry", {});

    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.task.recovery.projectStatus, "cancelled");
    assert.equal(run.calls.length, 1);
  } finally {
    await closeServer(server);
  }
});

test("dashboard exposes ambiguous retry candidates without enabling topbar retry", async () => {
  const { server, port, projectRoot } = await setupServer();
  try {
    const queue = new TaskQueue(projectRoot);
    await queue.load();
    const one = await queue.enqueue("first interrupted", { mode: "write" });
    await queue.promoteNext();
    await queue.interrupt(one.id, "first error");
    const two = await queue.enqueue("second interrupted", { mode: "write" });
    await queue.promoteNext();
    await queue.interrupt(two.id, "second error");
    const state = await loadState(projectRoot);
    await saveState(projectRoot, { ...state, project_status: "interrupted", interrupted_reason: "multiple" });

    const { data } = await getJson(port, "/api/dashboard");

    assert.equal(data.retry_available, false);
    assert.equal(data.retry_code, "retry_ambiguous_task");
    assert.deepEqual(data.retry_ambiguous_task_ids.sort(), [one.id, two.id].sort());
  } finally {
    await closeServer(server);
  }
});
```

- [ ] **Step 2: Run the focused server tests and confirm failure**

Run:

```powershell
node --test tests/app-server-probe.test.mjs --test-name-pattern "retry|dashboard disables retry|recovery task|ambiguous"
```

Expected: FAIL because retry fields are missing, cancelled/project-state recovery is missing, and live-job retry still uses old messages/codes.

- [ ] **Step 3: Create the resolver module**

Create `src/core/retry-candidates.mjs`:

```js
import { loadState } from "./project-store.mjs";

export async function resolveRetryCandidate({ projectRoot, queue, job, taskId = null } = {}) {
  if (!projectRoot) {
    return unavailable("retry_project_unavailable", "当前没有可恢复的小说项目。", 404);
  }
  await queue.load();
  const state = await loadState(projectRoot);
  if (isJobRunningForRetry(job)) {
    return unavailable("retry_still_running", "智能体仍在运行，请先停止当前任务。", 409);
  }
  if (["completed", "blocked"].includes(state.project_status)) {
    return unavailable("retry_not_allowed_status", "当前项目状态不可重试。", 400);
  }
  const queueState = queue.getState();
  if (taskId) {
    const selected = queueState.tasks.find((task) => task.id === String(taskId));
    if (!selected || !["interrupted", "cancelled"].includes(selected.status)) {
      return unavailable("retry_invalid_task_id", "只能重试已中断或已停止的任务。", 400);
    }
    return available({ taskId: selected.id, candidateSource: "queue_task", projectStatus: state.project_status });
  }
  const staleRunning = queueState.tasks.find((task) => task.status === "running");
  if (staleRunning && ["running", "interrupted", "cancelled"].includes(state.project_status)) {
    return available({ taskId: staleRunning.id, candidateSource: "stale_queue_task", projectStatus: state.project_status });
  }
  const terminal = queueState.tasks.filter((task) => ["interrupted", "cancelled"].includes(task.status));
  if (terminal.length > 1) {
    return unavailable("retry_ambiguous_task", "存在多个可重试任务，请指定 taskId。", 400, {
      ambiguousTaskIds: terminal.map((task) => task.id)
    });
  }
  if (terminal.length === 1) {
    return available({ taskId: terminal[0].id, candidateSource: "queue_task", projectStatus: state.project_status });
  }
  if (["interrupted", "running", "cancelled"].includes(state.project_status)) {
    return available({
      taskId: null,
      candidateSource: "project_state",
      projectStatus: state.project_status,
      recovery: {
        source: "project_state",
        projectStatus: state.project_status,
        chapterNo: state.current_chapter_no ?? null,
        stage: state.current_stage ?? null,
        reason: state.interrupted_reason ?? state.cancelled_reason ?? null
      }
    });
  }
  return unavailable("retry_no_candidate", "当前没有可重试的任务。", 400);
}

export function retryDashboardFields(candidate) {
  return {
    retry_available: candidate.available === true,
    retry_code: candidate.code,
    retry_unavailable_reason: candidate.available ? "" : candidate.reason,
    retry_task_id: candidate.taskId ?? null,
    retry_ambiguous_task_ids: candidate.ambiguousTaskIds ?? []
  };
}

function isJobRunningForRetry(job) {
  return job?.status === "running";
}

function available(extra) {
  return {
    available: true,
    code: "retry_available",
    reason: "可从中断处继续。",
    status: 200,
    ambiguousTaskIds: [],
    ...extra
  };
}

function unavailable(code, reason, status, extra = {}) {
  return {
    available: false,
    code,
    reason,
    status,
    taskId: null,
    ambiguousTaskIds: [],
    ...extra
  };
}
```

- [ ] **Step 4: Wire dashboard retry fields**

In `src/core/app-server.mjs`, import the resolver:

```js
import { resolveRetryCandidate, retryDashboardFields } from "./retry-candidates.mjs";
```

In `serveDashboard()`, after `data.agent_task_id = ...`, add:

```js
      const queue = await context.getTaskQueue(data.projectRoot);
      const candidate = await resolveRetryCandidate({
        projectRoot: data.projectRoot,
        queue,
        job
      });
      Object.assign(data, retryDashboardFields(candidate));
```

Update the call site for dashboard so `context` includes `getTaskQueue`:

```js
const data = await serveDashboard(response, { workspace, selected, secretsRoot: localSecretsRoot, runJobs, getTaskQueue });
```

- [ ] **Step 5: Rewire `/api/run/retry` to use resolver**

Replace the whole candidate-decision section in `serveRunRetry()`, starting after `readJsonBody()`/`projectRoot`/`key` setup and ending before state cleanup. Remove the old `isJobRunning(...)`, completed/blocked status preflight, and local task-selection branches so `resolveRetryCandidate()` is the single source of retry truth:

```js
    const queue = await context.getTaskQueue(projectRoot);
    const candidate = await resolveRetryCandidate({
      projectRoot,
      queue,
      job: context.runJobs.get(key),
      taskId: body.taskId ? String(body.taskId) : null
    });
    if (!candidate.available) {
      await serveJson(response, { ok: false, code: candidate.code, message: candidate.reason }, candidate.status ?? 400);
      return;
    }
    let task = null;
    if (candidate.candidateSource === "project_state") {
      const stateForRecovery = await loadState(projectRoot);
      task = await queue.createRecoveryTask({
        instruction: stateForRecovery.last_user_instruction ?? "继续当前写作任务",
        mode: "write",
        currentStage: stateForRecovery.current_stage ?? "queued",
        recovery: candidate.recovery
      });
    } else if (candidate.candidateSource === "stale_queue_task") {
      task = queue.getState().tasks.find((item) => item.id === candidate.taskId) ?? null;
    } else {
      task = await queue.retry(candidate.taskId);
    }
    if (!task) {
      await serveJson(response, { ok: false, code: "retry_no_candidate", message: "当前没有可重试的任务。" }, 400);
      return;
    }
```

Keep the existing state cleanup after this block. Wrap the `startProjectRun()` call so start failures return `retry_start_failed`, and inspect the return value because an already-running job returns `{ started: false, alreadyRunning: true }` instead of throwing:

```js
    try {
      const started = await startProjectRun(projectRoot, project, context, task, { source: "task_queue_retry" });
      if (started?.alreadyRunning) {
        await serveJson(response, { ok: false, code: "retry_already_running", message: "智能体仍在运行，请先停止当前任务。" }, 409);
        return;
      }
    } catch (error) {
      await serveJson(response, { ok: false, code: "retry_start_failed", message: error.message }, 500);
      return;
    }
```

- [ ] **Step 6: Run focused server retry tests**

Run:

```powershell
node --test tests/app-server-probe.test.mjs --test-name-pattern "retry|dashboard disables retry|recovery task|ambiguous"
```

Expected: PASS for new and existing retry tests. If old tests still assert stale running preferred while no live job, keep that behavior through `candidateSource: "stale_queue_task"`.

- [ ] **Step 7: Checkpoint**

Record:

```text
Task 2 checkpoint: dashboard and /api/run/retry now use Retry Candidate Resolver; live jobs disable retry, empty interrupted/cancelled project state creates recovery task.
```

---

### Task 3: Project Forget and No Implicit App-Shell Fallback

**Files:**
- Modify: `tests/app-server-probe.test.mjs`
- Modify: `tests/app-dashboard.test.mjs`
- Modify: `src/core/app-dashboard.mjs`
- Modify: `src/core/app-server.mjs`

- [ ] **Step 1: Add failing tests for project forget and empty selection**

At the top of `tests/app-server-probe.test.mjs`, update the app-state import by adding:

```js
import { recordRecentProject } from "../src/core/app-state.mjs";
```

Update the local `setupServer()` helper so tests can use the same app-state root that the server uses:

```js
  const stateRoot = options.stateRoot ?? path.join(root, ".state");
  const secretsRoot = options.secretsRoot ?? path.join(root, ".secrets");
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: projectRoot,
    stateRoot,
    secretsRoot,
    port: 0,
    ...options
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return { root, projectRoot, stateRoot, secretsRoot, server, port };
```

Then append to `tests/app-server-probe.test.mjs`:

```js
test("POST /api/projects/forget removes a recent project without deleting files", async () => {
  const { server, port, root, projectRoot, stateRoot } = await setupServer();
  try {
    const second = await createProject(root, { slug: "second-project", title: "Second Project" });
    await recordRecentProject(stateRoot, { projectRoot, title: "Project" });
    await recordRecentProject(stateRoot, { projectRoot: second.projectRoot, title: "Second Project" });
    const list = await getJson(port, "/api/projects/list");
    assert.ok(list.data.projects.some((project) => project.projectRoot === projectRoot));
    assert.ok(list.data.projects.some((project) => project.projectRoot === second.projectRoot));

    const { res, data } = await postJson(port, "/api/projects/forget", { projectRoot: second.projectRoot });

    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.ok(await fs.stat(path.join(second.projectRoot, "project.yaml")));
    assert.ok(!data.projects.some((project) => project.projectRoot === second.projectRoot));
  } finally {
    await closeServer(server);
  }
});

test("POST /api/projects/forget removes stale recent paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-forget-stale-"));
  const stateRoot = path.join(root, ".state");
  const staleRoot = path.join(root, "missing-project");
  await recordRecentProject(stateRoot, { projectRoot: staleRoot, title: "Missing Project" });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: null,
    stateRoot,
    secretsRoot: path.join(root, ".secrets"),
    port: 0
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const { res, data } = await postJson(port, "/api/projects/forget", { projectRoot: staleRoot });

    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.ok(!data.projects.some((project) => project.projectRoot === staleRoot));
  } finally {
    await closeServer(server);
  }
});

test("forgetting the last selected project leaves dashboard empty", async () => {
  const { server, port, projectRoot } = await setupServer();
  try {
    const { res, data } = await postJson(port, "/api/projects/forget", { projectRoot });
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.selectedProjectRoot, null);

    const dashboard = await getJson(port, "/api/dashboard");
    assert.equal(dashboard.data.ok, true);
    assert.equal(dashboard.data.hasProject, false);
  } finally {
    await closeServer(server);
  }
});

test("forgetting selected project chooses the next valid recent project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-forget-next-valid-"));
  const stateRoot = path.join(root, ".state");
  const secretsRoot = path.join(root, ".secrets");
  const current = await createProject(root, { slug: "current-project", title: "Current Project" });
  const valid = await createProject(root, { slug: "valid-project", title: "Valid Project" });
  const staleRoot = path.join(root, "missing-project");
  await recordRecentProject(stateRoot, { projectRoot: valid.projectRoot, title: "Valid Project" });
  await recordRecentProject(stateRoot, { projectRoot: staleRoot, title: "Missing Project" });
  await recordRecentProject(stateRoot, { projectRoot: current.projectRoot, title: "Current Project" });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: current.projectRoot,
    stateRoot,
    secretsRoot,
    port: 0
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const { data } = await postJson(port, "/api/projects/forget", { projectRoot: current.projectRoot });
    assert.equal(data.selectedProjectRoot, valid.projectRoot);
    assert.ok(data.projects.some((project) => project.projectRoot === valid.projectRoot));
    assert.ok(!data.projects.some((project) => project.projectRoot === staleRoot));
  } finally {
    await closeServer(server);
  }
});

test("forgetting selected project returns null when remaining recents are invalid", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-forget-no-valid-"));
  const stateRoot = path.join(root, ".state");
  const secretsRoot = path.join(root, ".secrets");
  const current = await createProject(root, { slug: "current-project", title: "Current Project" });
  const staleRoot = path.join(root, "missing-project");
  await recordRecentProject(stateRoot, { projectRoot: staleRoot, title: "Missing Project" });
  await recordRecentProject(stateRoot, { projectRoot: current.projectRoot, title: "Current Project" });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: current.projectRoot,
    stateRoot,
    secretsRoot,
    port: 0
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const { data } = await postJson(port, "/api/projects/forget", { projectRoot: current.projectRoot });
    assert.equal(data.selectedProjectRoot, null);
    assert.deepEqual(data.projects, []);
    const dashboard = await getJson(port, "/api/dashboard");
    assert.equal(dashboard.data.hasProject, false);
  } finally {
    await closeServer(server);
  }
});

test("server with no selected project does not scan workspace as implicit dashboard fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-no-fallback-"));
  await createProject(root, { slug: "unopened-project", title: "Unopened Project" });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: null,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    port: 0
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const { data } = await getJson(port, "/api/dashboard");
    assert.equal(data.ok, true);
    assert.equal(data.hasProject, false);
  } finally {
    await closeServer(server);
  }
});
```

Append to `tests/app-dashboard.test.mjs`:

```js
test("loadDashboardData can disable latest-project fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-no-fallback-"));
  await createProject(root, { slug: "project", title: "Fallback Candidate" });

  const data = await loadDashboardData(root, { disableProjectFallback: true });

  assert.equal(data.ok, true);
  assert.equal(data.hasProject, false);
});
```

- [ ] **Step 2: Run focused project tests and confirm failure**

Run:

```powershell
node --test tests/app-server-probe.test.mjs --test-name-pattern "forget|no selected"
node --test tests/app-dashboard.test.mjs --test-name-pattern "disable latest-project fallback"
```

Expected: FAIL because `/api/projects/forget` is missing and dashboard still scans workspace.

- [ ] **Step 3: Add dashboard no-fallback option**

In `src/core/app-dashboard.mjs`, change project root selection to:

```js
  const projectRoot = options.projectRoot
    ? normalizeProjectRoot(workspace, options.projectRoot, { allowExternal: options.allowExternalProjectRoot === true })
    : options.disableProjectFallback === true
      ? null
      : await findLatestProjectRoot(workspace);
```

- [ ] **Step 4: Add project forget endpoint**

In `src/core/app-server.mjs`, update the app-state import:

```js
import { forgetRecentProject, loadAppStateSync, loadAppState, recordRecentProject, samePath } from "./app-state.mjs";
```

Add a route after `/api/projects/open`:

```js
    if (url.pathname === "/api/projects/forget" && request.method === "POST") {
      const nextSelected = await serveProjectForget(request, response, {
        workspace,
        selected,
        stateRoot: appStateRoot
      });
      if (nextSelected !== undefined) {
        selected = nextSelected;
      }
      return;
    }
```

Add this handler near `serveProjectOpen()`:

```js
async function serveProjectForget(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const rawRoot = String(body.projectRoot ?? body.path ?? "").trim();
    if (!rawRoot) {
      await serveJson(response, { ok: false, code: "project_forget_failed", message: "项目路径不能为空。" }, 400);
      return undefined;
    }
    const target = path.resolve(rawRoot);
    await forgetRecentProject(context.stateRoot, target);
    const selectedProjectRoot = await resolveSelectedAfterForget({
      stateRoot: context.stateRoot,
      currentSelected: context.selected,
      forgottenRoot: target
    });
    const list = await buildProjectList({
      workspace: context.workspace,
      selected: selectedProjectRoot,
      stateRoot: context.stateRoot
    });
    await serveJson(response, {
      ok: true,
      workspaceRoot: context.workspace,
      selectedProjectRoot,
      projects: list.projects
    });
    return selectedProjectRoot ?? null;
  } catch (error) {
    await serveJson(response, { ok: false, code: "project_forget_failed", message: error.message }, 400);
    return undefined;
  }
}
```

Add the selection helper near the handler. It must choose a real project folder, not merely the first recent entry:

```js
async function resolveSelectedAfterForget({ stateRoot, currentSelected, forgottenRoot }) {
  if (currentSelected && !samePath(currentSelected, forgottenRoot) && existsSync(path.join(currentSelected, "project.yaml"))) {
    return path.resolve(currentSelected);
  }
  const state = await loadAppState(stateRoot);
  for (const item of state.recentProjects) {
    const candidate = path.resolve(item.projectRoot);
    if (existsSync(path.join(candidate, "project.yaml"))) {
      return candidate;
    }
  }
  return null;
}
```

Extract the body of `serveProjectList()` into a helper so both endpoints return the same shape:

```js
async function buildProjectList(context) {
  const selected = context.selected ? path.resolve(context.selected) : null;
  const state = await loadAppState(context.stateRoot);
  const candidates = [...state.recentProjects];
  if (selected && !candidates.some((item) => samePath(item.projectRoot, selected))) {
    candidates.push({ projectRoot: selected });
  }
  const projects = [];
  for (const item of candidates) {
    const root = path.resolve(item.projectRoot);
    if (projects.some((project) => samePath(project.projectRoot, root))) {
      continue;
    }
    if (!existsSync(path.join(root, "project.yaml"))) {
      continue;
    }
    let title = item.title ?? path.basename(root);
    let storySeed = item.story_seed ?? "";
    let activeModel = null;
    try {
      const project = await loadProject(root);
      title = project.title ?? title;
      storySeed = project.story_seed ?? storySeed;
      const config = await loadConfigLayers(root, project).catch(() => null);
      activeModel = config?.effective?.active_model ?? project.active_model ?? null;
    } catch {}
    projects.push({
      projectRoot: root,
      title,
      story_seed: storySeed,
      active_model: activeModel,
      model_label: modelDisplayName(activeModel),
      external: !isPathInside(context.workspace, root)
    });
  }
  const selectedInList = selected && projects.some((project) => samePath(project.projectRoot, selected))
    ? selected
    : null;
  return {
    ok: true,
    workspaceRoot: context.workspace,
    selectedProjectRoot: selectedInList,
    projects
  };
}
```

Then simplify `serveProjectList()`:

```js
async function serveProjectList(response, context) {
  try {
    await serveJson(response, await buildProjectList(context));
  } catch (error) {
    await serveJson(response, { ok: false, message: error.message }, error instanceof SyntaxError ? 400 : 500);
  }
}
```

- [ ] **Step 5: Disable implicit fallback in app-shell server paths**

In `serveDashboard()`, call `loadDashboardData()` with `disableProjectFallback: !context.selected`:

```js
    const data = await loadDashboardData(context.workspace, {
      projectRoot: context.selected,
      allowExternalProjectRoot: Boolean(context.selected),
      disableProjectFallback: !context.selected
    });
```

In `resolveActiveProjectRoot()`, remove `findLatestProjectRoot(workspace)` fallback:

```js
async function resolveActiveProjectRoot({ selected }) {
  if (!selected) {
    throw new Error("当前没有可用项目。");
  }
  const target = path.resolve(selected);
  await validateProjectRoot(target);
  return target;
}
```

- [ ] **Step 6: Run focused project tests**

Run:

```powershell
node --test tests/app-server-probe.test.mjs --test-name-pattern "forget|no selected"
node --test tests/app-dashboard.test.mjs --test-name-pattern "disable latest-project fallback"
```

Expected: PASS.

- [ ] **Step 7: Checkpoint**

Record:

```text
Task 3 checkpoint: /api/projects/forget removes recents without deleting files; app-shell no longer scans workspace when selected is null.
```

---

### Task 4: Cache Summary and Structured Prompt Blocks

**Files:**
- Modify: `tests/model-gateway.test.mjs`
- Modify: `tests/app-dashboard.test.mjs`
- Modify: `src/core/cache-key-manager.mjs`
- Modify: `src/core/app-dashboard.mjs`

- [ ] **Step 1: Add failing cache compatibility tests**

At the top of `tests/model-gateway.test.mjs`, add the missing standard-library imports:

```js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
```

Also change the cache-key-manager import to include `writeCacheReport`:

```js
import { CacheKeyManager, writeCacheReport } from "../src/core/cache-key-manager.mjs";
```

Then append to `tests/model-gateway.test.mjs`:

```js
test("writeCacheReport preserves promptBlockHashes and adds structured promptBlocks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-cache-report-"));
  const compiler = new PromptCompiler({ templateVersion: "drafting.v1" });
  const compiled = compiler.compile({
    stableBlocks: { system_rules: "A", goal: "B" },
    dynamicBlocks: { current_task: "write scene" }
  });
  const manager = new CacheKeyManager();
  const entry = manager.update({ projectId: "p1", templateVersion: "drafting.v1", stableHash: compiled.stableHash });
  const report = await writeCacheReport(root, {
    manager,
    cacheEntry: entry,
    compiledPrompt: compiled,
    usageReport: { cacheMetricsAvailable: false, cacheHitRate: null, cachedTokens: 0, cacheHitTokens: 0 },
    modelConfig: { provider: "mock", model_name: "mock-writer" }
  });

  assert.equal(typeof report.last_call.promptBlockHashes.system_rules, "string");
  assert.ok(report.last_call.promptBlocks.some((block) => block.name === "system_rules" && block.kind === "stable"));
  assert.ok(report.last_call.promptBlocks.some((block) => block.name === "current_task" && block.kind === "dynamic"));
});

test("CacheKeyManager reports stable change reasons", () => {
  const manager = new CacheKeyManager();
  const first = manager.update({ projectId: "p1", templateVersion: "drafting.v1", stableHash: "sha256:first" });
  const second = manager.update({ projectId: "p1", templateVersion: "drafting.v1", stableHash: "sha256:first" });
  const third = manager.update({ projectId: "p1", templateVersion: "drafting.v1", stableHash: "sha256:second" });

  assert.equal(first.stableChanged, false);
  assert.equal(first.stableChangedReason, "first_call");
  assert.equal(second.stableChanged, false);
  assert.equal(second.stableChangedReason, null);
  assert.equal(third.stableChanged, true);
  assert.equal(third.stableChangedReason, "stable_hash_changed");
  assert.equal(third.previousStableHash, "sha256:first");
});
```

Do not add a `template_version_changed` assertion in P0. The current cache state is keyed by `${projectId}:${templateVersion}`, so a template version change correctly appears as a new key and reports `first_call` until a later per-project template-history feature is implemented.

Append to `tests/app-dashboard.test.mjs`:

```js
test("loadDashboardData returns cacheSummary when cache report is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-cache-empty-"));
  const { projectRoot } = await createProject(root, { slug: "project" });

  const data = await loadDashboardData(root, { projectRoot });

  assert.deepEqual(data.cacheSummary, {
    available: false,
    providerMetricsAvailable: false,
    cacheKey: null,
    cacheVersion: null,
    stableChanged: false,
    stableChangedReason: null,
    lastTemplateVersion: null,
    hitRate: null,
    cachedTokens: 0,
    explanation: "缓存待生成"
  });
});

test("loadDashboardData explains stable cache key without provider metrics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-dashboard-cache-summary-"));
  const { projectRoot } = await createProject(root, { slug: "project" });
  await fs.writeFile(
    path.join(projectRoot, "cache_report.json"),
    JSON.stringify(
      {
        schema_version: 1,
        updated_at: "2026-05-31T06:00:00.000Z",
        entries: {},
        last_call: {
          provider: "mock",
          model: "mock-writer",
          templateVersion: "drafting.v1",
          stableHash: "sha256:stable",
          dynamicHash: "sha256:dynamic",
          cacheVersion: 1,
          cacheKey: "p:drafting.v1:v1:stable",
          promptBlockHashes: {},
          promptBlocks: [],
          cacheMetricsAvailable: false,
          cacheHitRate: null,
          cachedTokens: 0,
          cacheHitTokens: 0,
          stableChanged: false,
          stableChangedReason: null
        }
      },
      null,
      2
    )
  );

  const data = await loadDashboardData(root, { projectRoot });

  assert.equal(data.cacheSummary.available, true);
  assert.equal(data.cacheSummary.providerMetricsAvailable, false);
  assert.equal(data.cacheSummary.explanation, "缓存键稳定；供应商未返回命中指标");
});
```

- [ ] **Step 2: Run focused cache tests and confirm failure**

Run:

```powershell
node --test tests/model-gateway.test.mjs --test-name-pattern "promptBlocks|stable change"
node --test tests/app-dashboard.test.mjs --test-name-pattern "cacheSummary|cache key"
```

Expected: FAIL because `promptBlocks`, stable-change metadata, and `cacheSummary` are absent.

- [ ] **Step 3: Extend CacheKeyManager and cache report**

In `src/core/cache-key-manager.mjs`, update `CacheKeyManager.update()`:

```js
  update({ projectId = "default", templateVersion = "prompt.v1", stableHash, stableBlocks = null } = {}) {
    const resolvedStableHash = stableHash ?? sha256(JSON.stringify(stableBlocks ?? []));
    const entryKey = `${projectId}:${templateVersion}`;
    const previous = this.state.entries[entryKey];
    const stableChanged = Boolean(previous && previous.stableHash !== resolvedStableHash);
    const cacheVersion = stableChanged ? previous.cacheVersion + 1 : previous?.cacheVersion ?? 1;
    const entry = {
      projectId,
      templateVersion,
      stableHash: resolvedStableHash,
      previousStableHash: previous?.stableHash ?? null,
      stableChanged,
      stableChangedReason: previous ? (stableChanged ? "stable_hash_changed" : null) : "first_call",
      cacheVersion,
      cacheKey: `${projectId}:${templateVersion}:v${cacheVersion}:${resolvedStableHash.replace(/^sha256:/u, "").slice(0, 16)}`
    };
    this.state.entries[entryKey] = entry;
    return { ...entry };
  }
```

In `writeCacheReport()`, replace the existing `last_call` prompt-hash portion with a single `promptBlockHashes` string map plus the new structured `promptBlocks` array:

```js
          promptBlockHashes: compiledPrompt?.blockHashes ?? {},
          promptBlocks: Array.isArray(compiledPrompt?.blocks)
            ? compiledPrompt.blocks.map((block) => ({
                name: block.name,
                kind: block.kind,
                hash: block.hash
              }))
            : [],
          stableChanged: cacheEntry.stableChanged ?? false,
          stableChangedReason: cacheEntry.stableChangedReason ?? null,
          previousStableHash: cacheEntry.previousStableHash ?? null,
```

Keep exactly one `promptBlockHashes` property as a string map; do not duplicate that key and do not replace it with the new array.

- [ ] **Step 4: Add cacheSummary in dashboard**

In `src/core/app-dashboard.mjs`, add this helper near `computeActivityProgressPercent()`:

```js
function buildCacheSummary(cache) {
  const last = cache?.last_call ?? null;
  if (!last) {
    return {
      available: false,
      providerMetricsAvailable: false,
      cacheKey: null,
      cacheVersion: null,
      stableChanged: false,
      stableChangedReason: null,
      lastTemplateVersion: null,
      hitRate: null,
      cachedTokens: 0,
      explanation: "缓存待生成"
    };
  }
  const providerMetricsAvailable = last.cacheMetricsAvailable === true;
  const stableChanged = last.stableChanged === true;
  let explanation = "缓存键稳定；供应商未返回命中指标";
  if (providerMetricsAvailable && Number.isFinite(last.cacheHitRate)) {
    explanation = `缓存命中 ${Math.round(last.cacheHitRate * 100)}%`;
  } else if (stableChanged) {
    explanation = `缓存已刷新 v${last.cacheVersion}`;
  }
  return {
    available: true,
    providerMetricsAvailable,
    cacheKey: last.cacheKey ?? null,
    cacheVersion: last.cacheVersion ?? null,
    stableChanged,
    stableChangedReason: last.stableChangedReason ?? null,
    lastTemplateVersion: last.templateVersion ?? null,
    hitRate: Number.isFinite(last.cacheHitRate) ? last.cacheHitRate : null,
    cachedTokens: Number(last.cachedTokens ?? 0),
    explanation
  };
}
```

In the returned dashboard object, add:

```js
    cacheSummary: buildCacheSummary(cache),
```

Place it next to `cache` so UI consumers can use it without digging into `cache.last_call`.

- [ ] **Step 5: Run focused cache tests**

Run:

```powershell
node --test tests/model-gateway.test.mjs --test-name-pattern "promptBlocks|stable change"
node --test tests/app-dashboard.test.mjs --test-name-pattern "cacheSummary|cache key"
```

Expected: PASS.

- [ ] **Step 6: Checkpoint**

Record:

```text
Task 4 checkpoint: cache reports preserve promptBlockHashes, expose promptBlocks, and dashboard returns cacheSummary without fake hit rates.
```

---

### Task 5: App Shell Retry, Project Remove, and Cache UI

**Files:**
- Modify: `scripts/verify-app-shell.mjs`
- Modify: `src/app-shell/agent-truth.mjs`
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`

- [ ] **Step 1: Add failing static app-shell assertions**

In `scripts/verify-app-shell.mjs`, near the existing app-shell string assertions, add:

```js
  // Retry candidate, project list remove, and cache summary consistency.
  assert.ok(js.includes("retry_available"));
  assert.ok(js.includes("retry_task_id"));
  assert.ok(js.includes("/api/projects/forget"));
  assert.ok(js.includes('postJson("/api/projects/forget"'));
  assert.ok(js.includes("forgetProject"));
  assert.ok(js.includes('remove.addEventListener("click"'));
  assert.ok(js.includes("event.stopPropagation()"));
  assert.ok(js.includes("aria-label"));
  assert.ok(js.includes("cacheSummary"));
  assert.ok(js.includes("缓存键稳定") || js.includes("cacheSummary.explanation"));
  assert.ok(css.includes(".proj-menu"));
  assert.ok(css.includes(".proj-remove"));
```

- [ ] **Step 2: Run app-shell verification and confirm failure**

Run:

```powershell
npm run verify:app-shell
```

Expected: FAIL because the app shell does not yet reference `retry_available`, `/api/projects/forget`, or `cacheSummary`.

- [ ] **Step 3: Update retry truth logic**

In `src/app-shell/agent-truth.mjs`, compute retry availability once:

```js
  const retryAvailable = data.retry_available === true;
  const retryReason = data.retry_unavailable_reason ?? "";
```

Change the alive/stale branch:

```js
  if (alive && heartbeatAge > 60) {
    return { display: "疑似卡住", className: "stale", showRetry: false, showStop: true, refresh: true, reason: retryReason || `心跳超时 ${Math.round(heartbeatAge)} 秒` };
  }
```

Change non-alive retry branches:

```js
  if (status === "running") {
    return { display: "已中断", className: "interrupted", showRetry: retryAvailable, showStop: false, refresh: false, reason: retryReason || "进程已退出但状态仍为运行中" };
  }
  if (status === "interrupted") {
    return { display: "已中断", className: "interrupted", showRetry: retryAvailable, showStop: false, refresh: false, reason: data.agent_error ?? data.state?.interrupted_reason ?? retryReason ?? "" };
  }
  if (status === "cancelled") {
    return { display: "已停止", className: "cancelled", showRetry: retryAvailable, showStop: false, refresh: false, reason: data.state?.cancelled_reason ?? retryReason ?? "用户停止" };
  }
```

- [ ] **Step 4: Pass retry task id from topbar**

In `src/app-shell/app.js`, update `handleRetry()`:

```js
async function handleRetry(taskId = null) {
  const retry = document.querySelector("#topbar-retry");
  if (retry) retry.disabled = true;
  const resolvedTaskId = taskId ?? lastDashboard?.retry_task_id ?? null;
  try {
    const result = await postJson("/api/run/retry", resolvedTaskId ? { taskId: resolvedTaskId } : {});
    showToast(result.message ?? "已从中断处继续。", "success");
    ensureRefreshLoop(true);
    await loadDashboard();
  } catch (error) {
    showToast(error.message, "error");
    await loadDashboard();
  } finally {
    if (retry) retry.disabled = false;
  }
}
```

Keep task-card retry calls passing their explicit task id.

- [ ] **Step 5: Add project remove UI**

Replace `renderProjectNav(project, selectedProjectRoot)` with a wrapper that keeps the existing open button and adds a remove action:

```js
function renderProjectNav(project, selectedProjectRoot) {
  const row = document.createElement("div");
  row.className = `proj-row${pathEquals(project.projectRoot, selectedProjectRoot) ? " active" : ""}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `proj${pathEquals(project.projectRoot, selectedProjectRoot) ? " active" : ""}`;
  button.addEventListener("click", () => openProject(project.projectRoot));
  const dot = document.createElement("span");
  dot.className = "proj-dot";
  const main = document.createElement("span");
  main.className = "proj-main";
  const title = document.createElement("span");
  title.className = "proj-title";
  title.textContent = project.title ?? "未命名小说";
  const sub = document.createElement("span");
  sub.className = "proj-sub";
  sub.textContent = project.model_label ?? project.story_seed ?? project.projectRoot;
  main.append(title, sub);
  button.append(dot, main);
  const menu = document.createElement("div");
  menu.className = "proj-menu";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "proj-remove";
  remove.textContent = "移除";
  remove.setAttribute("aria-label", `从列表移除 ${project.title ?? "未命名小说"}`);
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    forgetProject(project.projectRoot);
  });
  menu.append(remove);
  row.append(button, menu);
  return row;
}
```

Add `forgetProject()` near `openProject()`:

```js
async function forgetProject(projectRoot) {
  if (!projectRoot) return;
  try {
    const result = await postJson("/api/projects/forget", { projectRoot });
    showToast("已从列表移除。", "success");
    currentProjectRoot = result.selectedProjectRoot ?? null;
    await loadAll();
  } catch (error) {
    showToast(error.message, "error");
    await loadProjectList();
  }
}
```

- [ ] **Step 6: Render cache summary from dashboard**

Wherever cache text is currently derived from `summary.cacheHitRate` or `data.cache.last_call`, route the visible copy through `data.cacheSummary`.

Use this helper in `src/app-shell/app.js`:

```js
function cacheSummaryText(data) {
  const summary = data.cacheSummary;
  if (!summary) return "缓存待生成";
  return summary.explanation ?? "缓存待生成";
}
```

If the drawer/run panel has a cache field, set it with:

```js
cache.textContent = cacheSummaryText(data);
```

Do not display `0%` when `providerMetricsAvailable` is false.

- [ ] **Step 7: Add project row styles**

In `src/app-shell/styles.css`, add:

```css
.proj-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px;
}

.proj-row .proj {
  min-width: 0;
}

.proj-menu {
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}

.proj-row:hover .proj-menu,
.proj-row:focus-within .proj-menu {
  opacity: 1;
  pointer-events: auto;
}

.proj-remove {
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--muted);
  border-radius: 6px;
  min-width: 44px;
  min-height: 30px;
  cursor: pointer;
}

.proj-remove:hover,
.proj-remove:focus-visible {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 35%, var(--line));
}
```

- [ ] **Step 8: Run app-shell verification**

Run:

```powershell
npm run verify:app-shell
```

Expected: PASS. If the verifier takes a long time because it creates demo projects, wait for the JSON success output.

- [ ] **Step 9: Checkpoint**

Record:

```text
Task 5 checkpoint: app shell renders retry from backend retry fields, exposes project removal, and shows cacheSummary text.
```

---

### Task 6: Integration Regression Sweep

**Files:**
- Test-only task; no production files should change unless a previous task missed a fix.

- [ ] **Step 1: Run focused backend suites**

Run:

```powershell
node --test tests/task-queue.test.mjs tests/app-server-probe.test.mjs tests/app-dashboard.test.mjs tests/model-gateway.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```powershell
npm test
```

Expected: PASS for all `tests/*.test.mjs`.

- [ ] **Step 3: Run app-shell verifier**

Run:

```powershell
npm run verify:app-shell
```

Expected: PASS and prints JSON with `"ok": true`.

- [ ] **Step 4: Manual smoke scenario**

Start the app shell:

```powershell
npm run app:shell
```

Manual checks:

```text
1. Open a project with project_status="interrupted" and empty task_queue.json.
2. Confirm topbar shows retry only if dashboard.retry_available is true.
3. Click retry and confirm the toast says "已从中断处继续。"
4. Confirm task_queue.json now contains source="project_state_recovery" and recovery.projectStatus.
5. Use "我的小说" row remove action on a non-current project; confirm local folder still exists.
6. Remove the current last project; confirm the app shows the empty/new state instead of reopening a scanned workspace project.
7. Confirm cache copy says "缓存待生成" or "缓存键稳定" when provider metrics are unavailable, not "0%".
```

Expected: All seven checks match.

- [ ] **Step 5: Final checkpoint**

Record:

```text
Task 6 checkpoint: focused suites, full suite, app-shell verifier, and manual smoke scenario passed.
```

---

## Deferred P1/P2 Backlog

- **P1: Project-menu polish beyond the minimal remove button.** P0 adds an accessible remove action with click isolation and an `aria-label`; keyboard focus styling, menu positioning polish, and destructive-action microcopy can be refined later. Future verification: app-shell screenshot/manual smoke for hover, focus-visible, and long titles.
- **P2: Physical project deletion.** Not implemented in this plan because deleting local writing files is destructive. Future tests: `/api/projects/delete` returns 409 while a live job is running and does not mutate app state; confirmation text must include the project title; successful delete removes the local folder, recent entry, and selected project.
- **P2: Force restart for alive-but-stale jobs.** Not implemented in P0. P0 keeps retry hidden while a live job exists and exposes stop as the explicit action. Future tests: stale-but-alive dashboard exposes a separate force-restart candidate, requires explicit stop/restart semantics, and never reuses `/api/run/retry` as a hidden kill switch.
- **P2: Cache trend/diff view.** P0 returns `cacheSummary`, `promptBlocks`, and stable-change metadata without fake hit rates. Future tests: stage-level cache history, prompt-block diff rendering, and provider-metric trend charts.
- **Future cache reason: `template_version_changed`.** Spec keeps this reason for a later per-project template-history tracker. P0 intentionally does not assert it because the current storage key includes template version and therefore treats a new template as `first_call`.

---

## Self-Review Checklist

- Spec section 1 retry consistency maps to Tasks 1, 2, and 5.
- Spec section 2 "My Novels" add/remove/delete semantics maps to Tasks 3 and 5. Physical delete remains P2 and is intentionally not implemented.
- Spec section 3 cache optimization maps to Tasks 4 and 5.
- No plan step requires git commits because this workspace is not a git repository.
- No plan step introduces external dependencies, WebSocket, or SSE.
- Every new API or schema behavior has a focused `node:test` target.

## Execution Handoff

Plan execution options after review:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using `executing-plans`, batch execution with checkpoints.
