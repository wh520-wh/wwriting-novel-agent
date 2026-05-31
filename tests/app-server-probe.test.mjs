import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../src/core/app-server.mjs";
import { recordRecentProject } from "../src/core/app-state.mjs";
import { readEvents } from "../src/core/event-log.mjs";
import { createProject, loadState, saveState } from "../src/core/project-store.mjs";
import { TaskQueue } from "../src/core/task-queue.mjs";
import { appendFailure } from "../src/core/failures-store.mjs";

async function setupServer(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-probe-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 3,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
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
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function getJson(port, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`);
  const data = await res.json();
  return { res, data };
}

async function postJson(port, route, body = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return { res, data };
}

test("static shell serves shared ESM dependencies", async () => {
  const { server, port } = await setupServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/shared/failure-commands.mjs`);
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/javascript\b/u);
    assert.match(body, /FAILURE_COMMANDS/u);
  } finally {
    await closeServer(server);
  }
});

test("static shell serves local GSAP vendor entry but not node_modules", async () => {
  const { server, port } = await setupServer();
  try {
    const vendor = await fetch(`http://127.0.0.1:${port}/vendor/gsap.js`);
    const vendorBody = await vendor.text();
    const nodeModules = await fetch(`http://127.0.0.1:${port}/node_modules/gsap/dist/gsap.js`);

    assert.equal(vendor.status, 200);
    assert.match(vendor.headers.get("content-type") ?? "", /^text\/javascript\b/u);
    assert.match(vendorBody, /export const gsap/u);
    assert.equal(nodeModules.status, 404);
  } finally {
    await closeServer(server);
  }
});

test("static shell does not expose non-module shared siblings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-static-shared-"));
  const staticRoot = path.join(root, "src", "app-shell");
  const sharedRoot = path.join(root, "src", "shared");
  await fs.mkdir(staticRoot, { recursive: true });
  await fs.mkdir(sharedRoot, { recursive: true });
  await fs.writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>");
  await fs.writeFile(path.join(sharedRoot, "secret.json"), "{\"secret\":true}");
  const { projectRoot } = await createProject(root, { slug: "project" });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    staticRoot,
    port: 0
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/shared/secret.json`);

    assert.equal(res.status, 404);
  } finally {
    await closeServer(server);
  }
});

function deferredRun() {
  const calls = [];
  const deferreds = [];
  async function testRunProject(projectRoot, options) {
    const deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
    options.onHeartbeat?.({ step: 0, stage: "queued", chapter: 1 });
    options.signal?.addEventListener("abort", () => deferred.reject(new Error(String(options.signal.reason ?? "cancelled"))), { once: true });
    calls.push({ projectRoot, options, deferred });
    deferreds.push(deferred);
    return deferred.promise;
  }
  return { calls, deferreds, testRunProject };
}

async function waitFor(predicate, { timeout = 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

test("dashboard returns false liveness when no job is running", async () => {
  const { server, port } = await setupServer();
  try {
    const { data } = await getJson(port, "/api/dashboard");
    assert.equal(data.agent_alive, false);
    assert.equal(data.agent_started_at, null);
    assert.equal(data.agent_last_heartbeat, null);
    assert.equal(data.agent_error, null);
    assert.equal(data.agent_task_id, null);
  } finally {
    await closeServer(server);
  }
});

test("command submit queues future tasks without appending future instructions to events", async () => {
  const run = deferredRun();
  const { server, port, projectRoot } = await setupServer({ testRunProject: run.testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "写第1章" });
    await postJson(port, "/api/commands/submit", { message: "写第2章" });
    await postJson(port, "/api/commands/submit", { message: "写第3章" });

    const { data: queue } = await getJson(port, "/api/queue/state");
    assert.equal(queue.tasks.length, 3);
    assert.deepEqual(queue.tasks.map((task) => task.status), ["running", "queued", "queued"]);
    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0].options.taskId, queue.tasks[0].id);

    const instructionEvents = (await readEvents(projectRoot)).filter((event) => event.type === "user_instruction_received");
    assert.deepEqual(instructionEvents.map((event) => event.message), ["写第1章"]);

    const { data: dashboard } = await getJson(port, "/api/dashboard");
    assert.equal(dashboard.agent_alive, true);
    assert.equal(dashboard.agent_task_id, queue.tasks[0].id);
    assert.ok(dashboard.agent_started_at);
    assert.ok(dashboard.agent_last_heartbeat);
  } finally {
    await closeServer(server);
  }
});

test("concurrent command submits start one run and leave later tasks queued", async () => {
  const run = deferredRun();
  const { server, port } = await setupServer({ testRunProject: run.testRunProject });
  try {
    await Promise.all([
      postJson(port, "/api/commands/submit", { message: "task one" }),
      postJson(port, "/api/commands/submit", { message: "task two" }),
      postJson(port, "/api/commands/submit", { message: "task three" })
    ]);

    const { data: queue } = await getJson(port, "/api/queue/state");
    const running = queue.tasks.filter((task) => task.status === "running");
    const queued = queue.tasks.filter((task) => task.status === "queued");
    assert.equal(run.calls.length, 1);
    assert.equal(running.length, 1);
    assert.equal(queued.length, 2);
  } finally {
    await closeServer(server);
  }
});

test("completed queued task auto-advances to the next queued instruction", async () => {
  const run = deferredRun();
  const { server, port, projectRoot } = await setupServer({ testRunProject: run.testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "写第1章" });
    await postJson(port, "/api/commands/submit", { message: "写第2章" });

    run.deferreds[0].resolve({ completed: false, projectRoot });

    await waitFor(() => run.calls.length === 2);
    const { data: queue } = await getJson(port, "/api/queue/state");
    assert.deepEqual(queue.tasks.map((task) => task.status), ["completed", "running"]);

    const instructionEvents = (await readEvents(projectRoot)).filter((event) => event.type === "user_instruction_received");
    assert.deepEqual(instructionEvents.map((event) => event.message), ["写第1章", "写第2章"]);
  } finally {
    await closeServer(server);
  }
});

test("server close aborts the active job and cancels only its running task", async () => {
  const run = deferredRun();
  const { server, port, projectRoot } = await setupServer({ testRunProject: run.testRunProject });
  await postJson(port, "/api/commands/submit", { message: "task one" });
  await postJson(port, "/api/commands/submit", { message: "task two" });
  assert.equal(run.calls[0].options.signal.aborted, false);

  await closeServer(server);

  assert.equal(run.calls[0].options.signal.aborted, true);
  await waitFor(async () => {
    const queue = new TaskQueue(projectRoot);
    await queue.load();
    const statuses = queue.getState().tasks.map((task) => task.status);
    return statuses[0] === "cancelled" && statuses[1] === "queued" && statuses;
  });
});

test("POST /api/run/stop cancels the running task and leaves queued tasks untouched", async () => {
  const run = deferredRun();
  const { server, port } = await setupServer({ testRunProject: run.testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "写第1章" });
    await postJson(port, "/api/commands/submit", { message: "写第2章" });

    const { res, data } = await postJson(port, "/api/run/stop", {});
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);

    await waitFor(async () => {
      const { data: queue } = await getJson(port, "/api/queue/state");
      return queue.tasks[0]?.status === "cancelled" && queue;
    });
    const { data: queue } = await getJson(port, "/api/queue/state");
    assert.deepEqual(queue.tasks.map((task) => task.status), ["cancelled", "queued"]);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/run/retry without taskId prefers a stale running task over terminal candidates", async () => {
  const run = deferredRun();
  const { server, port, projectRoot } = await setupServer({ testRunProject: run.testRunProject });
  try {
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(projectRoot, "task_queue.json"),
      JSON.stringify(
        {
          schema_version: 1,
          updatedAt: now,
          tasks: [
            {
              id: "task-stale-running",
              index: 1,
              instruction: "resume stale run",
              mode: "write",
              status: "running",
              createdAt: now,
              startedAt: now,
              updatedAt: now,
              heartbeatAt: now,
              completedAt: null,
              error: null,
              stages: [],
              currentStage: "drafting"
            },
            {
              id: "task-interrupted-old",
              index: 2,
              instruction: "old interrupted task",
              mode: "write",
              status: "interrupted",
              createdAt: now,
              startedAt: now,
              updatedAt: now,
              heartbeatAt: now,
              completedAt: now,
              error: "older error",
              stages: [],
              currentStage: "drafting"
            }
          ]
        },
        null,
        2
      )
    );
    const state = await loadState(projectRoot);
    await saveState(projectRoot, { ...state, project_status: "running", current_stage: "drafting" });

    const { res, data } = await postJson(port, "/api/run/retry", {});

    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0].options.taskId, "task-stale-running");
    const { data: queue } = await getJson(port, "/api/queue/state");
    assert.equal(queue.tasks.find((task) => task.id === "task-interrupted-old").status, "interrupted");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/run/retry with taskId restarts an interrupted task", async () => {
  const run = deferredRun();
  const { server, port, projectRoot } = await setupServer({ testRunProject: run.testRunProject });
  try {
    const queue = new TaskQueue(projectRoot);
    await queue.load();
    const task = await queue.enqueue("写第1章", { mode: "write" });
    await queue.promoteNext();
    await queue.interrupt(task.id, "API timeout");
    const state = await loadState(projectRoot);
    await saveState(projectRoot, { ...state, project_status: "interrupted", interrupted_reason: "API timeout" });

    const { res, data } = await postJson(port, "/api/run/retry", { taskId: task.id });
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(run.calls.length, 1);

    const { data: queueState } = await getJson(port, "/api/queue/state");
    assert.equal(queueState.tasks[0].status, "running");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/run/retry with taskId refuses blocked or completed projects", async () => {
  const run = deferredRun();
  const { server, port, projectRoot } = await setupServer({ testRunProject: run.testRunProject });
  try {
    const queue = new TaskQueue(projectRoot);
    await queue.load();
    const task = await queue.enqueue("old interrupted task", { mode: "write" });
    await queue.promoteNext();
    await queue.interrupt(task.id, "old error");
    const state = await loadState(projectRoot);
    await saveState(projectRoot, { ...state, project_status: "blocked", current_stage: "blocked", blocked_reason: "fix settings first" });

    const { res, data } = await postJson(port, "/api/run/retry", { taskId: task.id });

    assert.equal(res.status, 400);
    assert.equal(data.ok, false);
    assert.equal(run.calls.length, 0);
    const reloaded = new TaskQueue(projectRoot);
    await reloaded.load();
    assert.equal(reloaded.getState().tasks[0].status, "interrupted");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/run/retry resumes a stale persisted running task without taskId", async () => {
  const run = deferredRun();
  const { server, port, projectRoot } = await setupServer({ testRunProject: run.testRunProject });
  try {
    const queue = new TaskQueue(projectRoot);
    await queue.load();
    const task = await queue.enqueue("写第1章", { mode: "write" });
    await queue.promoteNext();
    const state = await loadState(projectRoot);
    await saveState(projectRoot, { ...state, project_status: "running", current_stage: "drafting" });

    const { res, data } = await postJson(port, "/api/run/retry", {});
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0].options.taskId, task.id);
  } finally {
    await closeServer(server);
  }
});

test("queue state reloads task_queue.json after the queue is cached", async () => {
  const { server, port, projectRoot } = await setupServer();
  try {
    const initial = await getJson(port, "/api/queue/state");
    assert.equal(initial.data.tasks.length, 0);
    const queue = new TaskQueue(projectRoot);
    await queue.load();
    await queue.enqueue("externally restored task", { mode: "write" });

    const { data } = await getJson(port, "/api/queue/state");

    assert.equal(data.tasks.length, 1);
    assert.equal(data.tasks[0].instruction, "externally restored task");
  } finally {
    await closeServer(server);
  }
});

test("stop wins if a runner resolves after its AbortSignal is aborted", async () => {
  let deferred = null;
  async function testRunProject(projectRoot, options) {
    deferred = {};
    deferred.promise = new Promise((resolve) => {
      deferred.resolve = resolve;
    });
    options.signal?.addEventListener("abort", () => {}, { once: true });
    return deferred.promise;
  }
  const { server, port } = await setupServer({ testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "slow task" });
    await postJson(port, "/api/run/stop", {});
    deferred.resolve({ completed: true });

    await waitFor(async () => {
      const { data: queue } = await getJson(port, "/api/queue/state");
      return queue.tasks[0]?.status === "cancelled" && queue;
    });
    const { data: queue } = await getJson(port, "/api/queue/state");
    assert.equal(queue.tasks[0].status, "cancelled");
  } finally {
    await closeServer(server);
  }
});

test("commands submitted to completed or blocked projects append skipped audit events", async () => {
  const { server, port, projectRoot } = await setupServer();
  try {
    const state = await loadState(projectRoot);
    await saveState(projectRoot, { ...state, project_status: "completed", current_stage: "completed" });
    await postJson(port, "/api/commands/submit", { message: "after completion" });

    const completedEvents = await readEvents(projectRoot);
    assert.ok(
      completedEvents.some(
        (event) => event.type === "user_instruction_received" && event.message === "after completion" && event.data?.skipped === true
      )
    );
    assert.ok(completedEvents.some((event) => event.type === "project_run_skipped"));

    await saveState(projectRoot, { ...state, project_status: "blocked", current_stage: "blocked", blocked_reason: "missing provider" });
    await postJson(port, "/api/commands/submit", { message: "after blocked" });

    const blockedEvents = await readEvents(projectRoot);
    assert.ok(
      blockedEvents.some(
        (event) => event.type === "user_instruction_received" && event.message === "after blocked" && event.data?.skipped === true
      )
    );
    assert.ok(
      blockedEvents.some(
        (event) => event.type === "project_run_skipped" && event.message.includes("missing provider")
      )
    );
  } finally {
    await closeServer(server);
  }
});

test("a blocked run keeps blocked classification in project state and task queue", async () => {
  const run = {
    calls: [],
    async testRunProject(projectRoot, options) {
      run.calls.push({ projectRoot, options });
      return { completed: false, blocked: true, reason: "Missing provider adapter" };
    }
  };
  const { server, port } = await setupServer({ testRunProject: run.testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "trigger blocked run" });

    const queue = await waitFor(async () => {
      const { data } = await getJson(port, "/api/queue/state");
      return data.tasks[0]?.status === "blocked" && data;
    });
    assert.equal(queue.tasks[0].status, "blocked");
    assert.equal(queue.tasks[0].error, "Missing provider adapter");
    await waitFor(async () => {
      const events = await readEvents(queue.tasks[0] ? run.calls[0].projectRoot : "");
      return events.some((event) => event.type === "project_blocked" && event.message.includes("Missing provider adapter"));
    });
  } finally {
    await closeServer(server);
  }
});

test("engine-classified blocked errors mark the task blocked", async () => {
  async function testRunProject(projectRoot) {
    const state = await loadState(projectRoot);
    await saveState(projectRoot, { ...state, project_status: "blocked", current_stage: "blocked", blocked_reason: "provider missing" });
    throw new Error("provider missing");
  }
  const { server, port } = await setupServer({ testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "trigger engine block" });

    await waitFor(async () => {
      const { data: queue } = await getJson(port, "/api/queue/state");
      return queue.tasks[0]?.status === "blocked" && queue;
    });
  } finally {
    await closeServer(server);
  }
});

test("command submit does not leave a promoted task when project is already completed", async () => {
  const { server, port, projectRoot } = await setupServer();
  try {
    const state = await loadState(projectRoot);
    await saveState(projectRoot, { ...state, project_status: "completed", current_stage: "completed" });

    const { data } = await postJson(port, "/api/commands/submit", { message: "写第4章" });
    assert.equal(data.started, false);
    assert.equal(data.completed, true);
    const { data: queue } = await getJson(port, "/api/queue/state");
    assert.equal(queue.tasks.length, 0);
  } finally {
    await closeServer(server);
  }
});

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

test("POST /api/failures/resolve 拒绝未知命令", async () => {
  const ctx = await setupServer();
  try {
    const { res, data } = await postJson(ctx.port, "/api/failures/resolve",
      { command: "evil-cmd", args: {}, failureId: "x" });
    assert.equal(res.status, 400);
    assert.match(data.error, /未知命令/);
  } finally { await closeServer(ctx.server); }
});

test("POST /api/failures/resolve failureId 必须存在且未处理", async () => {
  const ctx = await setupServer();
  appendFailure(ctx.projectRoot, { id: "f1", kind: "unknown", resolution: null });
  try {
    const r1 = await postJson(ctx.port, "/api/failures/resolve",
      { command: "pause-here", args: {}, failureId: "f1" });
    assert.equal(r1.res.status, 200);
    const r2 = await postJson(ctx.port, "/api/failures/resolve",
      { command: "pause-here", args: {}, failureId: "f1" });
    assert.equal(r2.res.status, 409);
    const r3 = await postJson(ctx.port, "/api/failures/resolve",
      { command: "pause-here", args: {}, failureId: "nonexistent" });
    assert.equal(r3.res.status, 404);
  } finally { await closeServer(ctx.server); }
});

test("POST /api/failures/resolve blocked 项目也能处理（不被 short-circuit）", async () => {
  const ctx = await setupServer();
  await saveState(ctx.projectRoot, {
    project_status: "blocked", blocked_reason: "model_call_budget_exhausted",
    current_chapter_no: 1, current_stage: "blocked"
  });
  appendFailure(ctx.projectRoot, { id: "fb", kind: "budget-exhausted", resolution: null });
  try {
    const { res, data } = await postJson(ctx.port, "/api/failures/resolve",
      { command: "pause-here", args: {}, failureId: "fb" });
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
  } finally { await closeServer(ctx.server); }
});
