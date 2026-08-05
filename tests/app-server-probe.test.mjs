import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../src/core/app-server.mjs";
import { recordRecentProject, samePath } from "../src/core/app-state.mjs";
import { loadDashboardData } from "../src/core/app-dashboard.mjs";
import { readEvents } from "../src/core/event-log.mjs";
import { loadLocalSecrets, loadLocalSecretsSync } from "../src/core/local-secrets.mjs";
import { loadProject, loadState, saveProject, saveState } from "../src/core/project-store.mjs";
import { createWritingProject } from "./helpers.mjs";
import { TaskQueue } from "../src/core/task-queue.mjs";
import { appendFailure } from "../src/core/failures-store.mjs";

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080
]);

async function listenOnFetchSafePort(server) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    if (!FETCH_BLOCKED_PORTS.has(port)) {
      return port;
    }
    await closeServer(server);
  }
  throw new Error("Could not allocate a fetch-safe test port");
}

async function setupServer(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-probe-"));
  const { projectRoot } = await createWritingProject(root, {
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
  const port = await listenOnFetchSafePort(server);
  return { root, projectRoot, stateRoot, secretsRoot, server, port };
}

function closeServer(server) {
  // Forcefully drop lingering keep-alive connections so the server closes
  // deterministically. Relying on server.close(cb) alone waits for idle
  // keep-alive sockets, which under load can push a test past node:test's
  // default timeout and produce intermittent "server close" flakes.
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
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
  const { projectRoot } = await createWritingProject(root, { slug: "project" });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    staticRoot,
    port: 0
  });
  const port = await listenOnFetchSafePort(server);
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

test("GET /api/diagnostics returns plain recovery data for the selected project", async () => {
  const { server, projectRoot, port } = await setupServer();
  try {
    await saveState(projectRoot, {
      project_status: "interrupted",
      current_stage: "drafting",
      current_chapter_no: 1,
      interrupted_reason: "provider timeout"
    });

    const { res, data } = await getJson(port, "/api/diagnostics");
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.project.status, "interrupted");
    assert.equal(data.recoveryHint.action, "retry");
  } finally {
    await closeServer(server);
  }
});

test("command submit queues future tasks without appending future instructions to events", async () => {
  const run = deferredRun();
  const { server, port, projectRoot } = await setupServer({ testRunProject: run.testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "写3章" });

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
    // 并发的「写第1章」请求，每个都编译成第 1 章契约；项目锁串行化入队，第一个升级为 running，其余留在 queued。
    await Promise.all([
      postJson(port, "/api/commands/submit", { message: "写第1章" }),
      postJson(port, "/api/commands/submit", { message: "写第1章" }),
      postJson(port, "/api/commands/submit", { message: "写第1章" })
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
    // 走 API 编译两个单章任务（第 1 章、第 2 章）；「写2章」在 currentChapter=1 时把两个
    // 任务都入队，第一个立刻升级为 running，第二个留在 queued。契约在 run-start 才校验，
    // 所以两个任务都能进队列；第二个任务开始前要先把项目状态推进到第 2 章才能通过校验。
    await postJson(port, "/api/commands/submit", { message: "写2章" });

    await waitFor(() => run.calls.length === 1);
    const state = await loadState(projectRoot);
    await saveState(projectRoot, { ...state, current_chapter_no: 2 });

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
  await postJson(port, "/api/commands/submit", { message: "写2章" });
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
    await postJson(port, "/api/commands/submit", { message: "写2章" });

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

test("POST /api/run/stop immediately exposes cancelling", async () => {
  const run = deferredRun();
  const { server, port, projectRoot } = await setupServer({ testRunProject: run.testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "写第1章" });
    const before = Date.now();
    const stopped = await postJson(port, "/api/run/stop", {});
    assert.equal(stopped.res.status, 200);
    assert.equal(stopped.data.status, "cancelling");
    assert.ok(Date.now() - before < 500);
    const state = await loadState(projectRoot);
    assert.equal(state.project_status, "cancelling");
    const queue = await getJson(port, "/api/queue/state");
    assert.equal(queue.data.tasks[0].status, "cancelling");
  } finally {
    await closeServer(server);
  }
});

test("重复 stop 对 cancelling 幂等", async () => {
  const heldRun = Promise.withResolvers();
  async function testRunProject() {
    return heldRun.promise;
  }
  const { server, port, projectRoot } = await setupServer({ testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "写第1章" });
    const first = await postJson(port, "/api/run/stop", {});
    const second = await postJson(port, "/api/run/stop", {});

    assert.equal(first.res.status, 200);
    assert.equal(second.res.status, 200);
    assert.equal(first.data.status, "cancelling");
    assert.equal(second.data.status, "cancelling");

    const events = await readEvents(projectRoot);
    assert.equal(
      events.filter((event) => event.type === "project_cancelling").length,
      1
    );
  } finally {
    heldRun.resolve({ completed: true });
    await closeServer(server);
  }
});

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

    // Schema v3 migration marks the ambiguous running legacy task as blocked,
    // because it has no project_state_recovery source, no terminal status,
    // no precise chapter instruction, and no recovery.chapterNo to bind.
    // Retry should then pick the remaining terminal candidate instead.
    const { res, data } = await postJson(port, "/api/run/retry", {});

    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0].options.taskId, "task-interrupted-old");
    const { data: queue } = await getJson(port, "/api/queue/state");
    const stale = queue.tasks.find((task) => task.id === "task-stale-running");
    assert.equal(stale.status, "blocked");
    assert.equal(stale.error, "legacy_task_contract_unresolved");
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

test("cancellation converges to cancelled without emitting project_run_failed", async () => {
  let deferred = null;
  async function testRunProject(projectRoot, options) {
    deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
    options.signal?.addEventListener(
      "abort",
      () => deferred.reject(new Error(String(options.signal.reason ?? "cancelled"))),
      { once: true }
    );
    return deferred.promise;
  }
  const { server, port, projectRoot } = await setupServer({ testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "slow task" });
    await postJson(port, "/api/run/stop", {});

    await waitFor(async () => {
      const { data: queue } = await getJson(port, "/api/queue/state");
      return queue.tasks[0]?.status === "cancelled" && queue;
    });
    await waitFor(async () => {
      const state = await loadState(projectRoot);
      return state.project_status === "cancelled" && state;
    });

    const events = await readEvents(projectRoot);
    const cancelledCount = events.filter((event) => event.type === "project_cancelled").length;
    const failedCount = events.filter((event) => event.type === "project_run_failed").length;
    const state = await loadState(projectRoot);

    assert.equal(cancelledCount, 1);
    assert.equal(failedCount, 0);
    assert.equal(state.project_status, "cancelled");
  } finally {
    await closeServer(server);
  }
});

test("迟到的第二次 stop 不复活已收敛的 cancelled 状态", async () => {
  // 竞态回归：双击/重复停止。第一次 stop 持久化 cancelling 并 abort，runner 收敛到 cancelled；
  // 第二次 stop 在项目已是终态后到达，绝不能把 project_status 拨回 cancelling、不能再发
  // project_cancelling 事件，否则重试会被永久 409 阻塞。
  let deferred = null;
  async function testRunProject(projectRoot, options) {
    deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
    options.signal?.addEventListener(
      "abort",
      () => deferred.reject(new Error(String(options.signal.reason ?? "cancelled"))),
      { once: true }
    );
    return deferred.promise;
  }
  const { server, port, projectRoot } = await setupServer({ testRunProject });
  try {
    await postJson(port, "/api/commands/submit", { message: "slow task" });

    // 第一次 stop：持久化 cancelling 并触发 abort。
    const first = await postJson(port, "/api/run/stop", {});
    assert.equal(first.res.status, 200);
    assert.equal(first.data.status, "cancelling");

    // 让 runner 收敛到终态 cancelled。
    await waitFor(async () => {
      const state = await loadState(projectRoot);
      return state.project_status === "cancelled" && state;
    });

    // 第二次 stop：项目已是终态，job 已收敛为 cancelled，应当 409 且不复活。
    const second = await postJson(port, "/api/run/stop", {});
    assert.equal(second.res.status, 409);

    const state = await loadState(projectRoot);
    assert.equal(state.project_status, "cancelled");

    const events = await readEvents(projectRoot);
    assert.equal(
      events.filter((event) => event.type === "project_cancelling").length,
      1
    );
    assert.equal(
      events.filter((event) => event.type === "project_cancelled").length,
      1
    );
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
    const second = await createWritingProject(root, { slug: "second-project", title: "Second Project" });
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
  const port = await listenOnFetchSafePort(server);
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
  const current = await createWritingProject(root, { slug: "current-project", title: "Current Project" });
  const valid = await createWritingProject(root, { slug: "valid-project", title: "Valid Project" });
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
  const port = await listenOnFetchSafePort(server);
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
  const current = await createWritingProject(root, { slug: "current-project", title: "Current Project" });
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
  const port = await listenOnFetchSafePort(server);
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
  await createWritingProject(root, { slug: "unopened-project", title: "Unopened Project" });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: null,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    port: 0
  });
  const port = await listenOnFetchSafePort(server);
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
    assert.match(data.message, /未知命令/);
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

test("精确单章命令把契约传给 runner", async () => {
  const run = deferredRun();
  const { server, port } = await setupServer({ testRunProject: run.testRunProject });
  try {
    const { res } = await postJson(port, "/api/commands/submit", { message: "写第1章" });
    assert.equal(res.status, 200);
    assert.equal(run.calls.length, 1);
    assert.deepEqual(run.calls[0].options.contract, {
      version: 1, kind: "write_chapter", chapter_start: 1, chapter_end: 1,
      stop_policy: "immediate", resume_policy: "checkpoint", skip_policy: "reject"
    });
  } finally {
    await closeServer(server);
  }
});

test("跳章命令返回 chapter_gap 且不入队", async () => {
  const { server, port } = await setupServer();
  try {
    const { res, data } = await postJson(port, "/api/commands/submit", { message: "写第3章" });
    assert.equal(res.status, 400);
    assert.equal(data.code, "chapter_gap");
    const queue = await getJson(port, "/api/queue/state");
    assert.equal(queue.data.tasks.length, 0);
  } finally {
    await closeServer(server);
  }
});

test("写3章创建三个严格单章任务", async () => {
  const run = deferredRun();
  const { server, port } = await setupServer({ testRunProject: run.testRunProject });
  try {
    const result = await postJson(port, "/api/commands/submit", { message: "写3章" });
    assert.equal(result.data.tasks.length, 3);
    assert.deepEqual(result.data.tasks.map((task) => task.contract.chapter_start), [1, 2, 3]);
  } finally {
    await closeServer(server);
  }
});

test("已有写作任务时拒绝含糊指令", async () => {
  const run = deferredRun();
  const { server, port } = await setupServer({
    testRunProject: run.testRunProject
  });
  try {
    await postJson(port, "/api/commands/submit", { message: "写第1章" });
    const { res, data } = await postJson(port, "/api/commands/submit", {
      message: "继续完善雨夜氛围"
    });

    assert.equal(res.status, 400);
    assert.equal(data.code, "ambiguous_task_scope");
    const queue = await getJson(port, "/api/queue/state");
    assert.equal(queue.data.tasks.length, 1);
  } finally {
    await closeServer(server);
  }
});

test("dashboard request remains scoped to its requested project during a switch", async () => {
  const delayed = Promise.withResolvers();
  const started = Promise.withResolvers();
  let projectA = null;
  const fixture = await setupServer({
    testLoadDashboardData: async (workspace, options) => {
      if (samePath(options.projectRoot, projectA)) {
        started.resolve();
        await delayed.promise;
      }
      return loadDashboardData(workspace, options);
    },
  });
  projectA = fixture.projectRoot;
  const { projectRoot: projectB } = await createWritingProject(fixture.root, {
    slug: "project-b",
    title: "Project B",
  });
  await recordRecentProject(fixture.stateRoot, {
    projectRoot: projectA,
    title: "Project A",
  });
  await recordRecentProject(fixture.stateRoot, {
    projectRoot: projectB,
    title: "Project B",
  });

  const pendingA = getJson(
    fixture.port,
    `/api/dashboard?projectRoot=${encodeURIComponent(projectA)}`,
  );
  await started.promise;

  await postJson(fixture.port, "/api/projects/open", {
    projectRoot: projectB,
  });
  const dashboardB = await getJson(
    fixture.port,
    `/api/dashboard?projectRoot=${encodeURIComponent(projectB)}`,
  );
  delayed.resolve();
  const dashboardA = await pendingA;

  assert.equal(dashboardA.data.projectRoot, projectA);
  assert.equal(dashboardB.data.projectRoot, projectB);
  await closeServer(fixture.server);
});

test("project-scoped endpoint rejects a root outside the registered project list", async () => {
  const { server, port } = await setupServer();
  const response = await fetch(
    `http://127.0.0.1:${port}/api/dashboard?projectRoot=${encodeURIComponent("C:\\unregistered")}`,
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_PROJECT_SCOPE");
  await closeServer(server);
});

test("write request is rejected after selected project changes", async () => {
  const fixture = await setupServer();
  const projectA = fixture.projectRoot;
  const { projectRoot: projectB } = await createWritingProject(fixture.root, {
    slug: "project-b",
  });
  await recordRecentProject(fixture.stateRoot, { projectRoot: projectB });
  await postJson(fixture.port, "/api/projects/open", {
    projectRoot: projectB,
  });

  const { res, data } = await postJson(
    fixture.port,
    "/api/commands/submit",
    {
      projectRoot: projectA,
      expectedProjectRoot: projectA,
      message: "写第1章",
    },
  );

  assert.equal(res.status, 409);
  assert.equal(data.code, "PROJECT_SCOPE_CHANGED");
  const queueA = await getJson(
    fixture.port,
    `/api/queue/state?projectRoot=${encodeURIComponent(projectA)}`,
  );
  assert.equal(queueA.data.tasks.length, 0);
  await closeServer(fixture.server);
});

test("invalid candidate leaves project settings and secrets unchanged", async () => {
  const ctx = await setupServer();
  try {
    const project = await loadProject(ctx.projectRoot);
    await saveProject(ctx.projectRoot, {
      ...project,
      active_model: {
        provider: "openai-compatible",
        model_name: "old-model",
        base_url: "https://old.example/v1",
        api_key_env: "OLD_KEY",
      },
    });
    await fs.mkdir(ctx.secretsRoot, { recursive: true });
    await fs.writeFile(path.join(ctx.secretsRoot, "secrets.json"), JSON.stringify({ OLD_KEY: "old-secret-value" }));
    const beforeProject = await loadProject(ctx.projectRoot);
    const beforeSecrets = loadLocalSecretsSync(ctx.secretsRoot);

    const { res, data } = await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      active_model: {
        provider: "openai-compatible",
        model_name: "mimo-v2.5-pro",
        base_url: "",
        api_key_env: "XIAOMI_MIMO_API_KEY",
        api_key: "new-secret",
      },
    });

    assert.equal(res.status, 400);
    assert.equal(data.code, "configuration_missing");
    assert.deepEqual(await loadProject(ctx.projectRoot), beforeProject);
    assert.deepEqual(loadLocalSecretsSync(ctx.secretsRoot), beforeSecrets);
  } finally {
    await closeServer(ctx.server);
  }
});

test("valid candidate persists project config and secret together", async () => {
  const ctx = await setupServer();
  try {
    const { res } = await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      active_model: {
        provider: "openai-compatible",
        model_name: "mimo-v2.5-pro",
        base_url: "https://api.xiaomimimo.com/v1",
        api_key_env: "XIAOMI_MIMO_API_KEY",
        api_key: "temporary-test-key",
      },
    });

    assert.equal(res.status, 200);
    assert.equal(
      (await loadProject(ctx.projectRoot)).active_model.model_name,
      "mimo-v2.5-pro",
    );
    assert.equal(
      loadLocalSecretsSync(ctx.secretsRoot).XIAOMI_MIMO_API_KEY,
      "temporary-test-key"
    );
  } finally {
    await closeServer(ctx.server);
  }
});

test("settings/update saves reusable local model profiles and model secret survives restart", async () => {
  const ctx = await setupServer();
  try {
    const { res } = await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      active_model: {
        provider: "openai-compatible",
        model_name: "mimo-v2.5-pro",
        base_url: "https://api.xiaomimimo.com/v1",
        api_key_env: "XIAOMI_MIMO_API_KEY",
        api_key: "sk-visible-local-key"
      }
    });
    assert.equal(res.status, 200);
    await closeServer(ctx.server);

    const restarted = createAppShellServer({
      workspaceRoot: ctx.root,
      selectedProjectRoot: ctx.projectRoot,
      stateRoot: ctx.stateRoot,
      secretsRoot: ctx.secretsRoot,
      port: 0
    });
    const port = await listenOnFetchSafePort(restarted);
    try {
      const secret = await getJson(port, "/api/settings/model-secret");
      assert.equal(secret.res.status, 200);
      assert.equal(secret.data.value, "sk-visible-local-key");

      const models = await getJson(port, "/api/settings/models");
      assert.equal(models.res.status, 200);
      assert.ok(models.data.models.some((model) => model.model_name === "mimo-v2.5-pro"));
      assert.equal(models.data.default_model.model_name, "mimo-v2.5-pro");
    } finally {
      await closeServer(restarted);
    }
  } catch (error) {
    if (ctx.server.listening) await closeServer(ctx.server);
    throw error;
  }
});

test("new projects inherit the saved local model without re-entering the key", async () => {
  const ctx = await setupServer();
  try {
    await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      active_model: {
        provider: "openai-compatible",
        model_name: "mimo-v2.5-pro",
        base_url: "https://api.xiaomimimo.com/v1",
        api_key_env: "XIAOMI_MIMO_API_KEY",
        api_key: "sk-new-project-reuses-this"
      }
    });

    const nextRoot = path.join(ctx.root, "fresh-project");
    const created = await postJson(ctx.port, "/api/projects/init", {
      projectRoot: nextRoot,
      title: "Fresh Project",
      story_seed: "seed"
    });
    assert.equal(created.res.status, 200);

    const project = await loadProject(nextRoot);
    assert.equal(project.active_model.provider, "openai-compatible");
    assert.equal(project.active_model.model_name, "mimo-v2.5-pro");
    assert.equal(project.active_model.api_key_env, "XIAOMI_MIMO_API_KEY");
    assert.equal(loadLocalSecretsSync(ctx.secretsRoot).XIAOMI_MIMO_API_KEY, "sk-new-project-reuses-this");
  } finally {
    await closeServer(ctx.server);
  }
});

test("dashboard shows correct project state after POST /api/projects/init", async () => {
  const ctx = await setupServer();
  try {
    const storySeed = "一位钟表匠在修理古董钟时发现了时间裂缝。";
    const targetChapters = 5;
    const initRoot = path.join(ctx.root, "init-dashboard-project");
    const initRes = await postJson(ctx.port, "/api/projects/init", {
      projectRoot: initRoot,
      title: "Dashboard Init Test",
      story_seed: storySeed,
      target_chapters: targetChapters
    });
    assert.equal(initRes.res.status, 200);

    const { data } = await getJson(ctx.port, "/api/dashboard");
    assert.equal(data.hasProject, true);
    assert.equal(data.project.story_seed, storySeed);
    assert.equal(data.summary.currentChapterNo, 1);
    assert.equal(data.summary.targetChapters, targetChapters);
    assert.equal(data.summary.projectStatus, "idle");
  } finally {
    await closeServer(ctx.server);
  }
});

test("mock models are never saved as reusable local model profiles", async () => {
  const ctx = await setupServer();
  try {
    await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      active_model: {
        provider: "openai-compatible",
        model_name: "writer-real",
        base_url: "https://api.example.test/v1",
        api_key_env: "WRITER_REAL_API_KEY",
        api_key: "sk-real-local"
      }
    });
    await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      active_model: {
        provider: "mock",
        model_name: "mock-writer"
      }
    });

    const models = await getJson(ctx.port, "/api/settings/models");
    assert.equal(models.res.status, 200);
    assert.equal(models.data.default_model.model_name, "writer-real");
    assert.ok(models.data.models.every((model) => model.provider !== "mock"));

    const dashboard = await getJson(ctx.port, "/api/dashboard");
    assert.ok(dashboard.data.available_models.every((model) => model.provider !== "mock"));

    const nextRoot = path.join(ctx.root, "no-mock-project");
    const created = await postJson(ctx.port, "/api/projects/init", {
      projectRoot: nextRoot,
      title: "No Mock Project",
      story_seed: "seed"
    });
    assert.equal(created.res.status, 200);
    const project = await loadProject(nextRoot);
    assert.equal(project.active_model.provider, "openai-compatible");
    assert.equal(project.active_model.model_name, "writer-real");
  } finally {
    await closeServer(ctx.server);
  }
});

test("model switch endpoint applies a saved model profile and refreshes dashboard metadata", async () => {
  const ctx = await setupServer();
  try {
    await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      active_model: {
        provider: "openai-compatible",
        model_name: "mimo-v2.5-pro",
        base_url: "https://api.xiaomimimo.com/v1",
        api_key_env: "XIAOMI_MIMO_API_KEY",
        api_key: "sk-mimo-local"
      }
    });
    await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      active_model: {
        provider: "openai-compatible",
        model_name: "deepseek-chat",
        base_url: "https://api.deepseek.com",
        api_key_env: "DEEPSEEK_API_KEY",
        api_key: "sk-deepseek-local"
      }
    });

    const switched = await postJson(ctx.port, "/api/settings/model-switch", {
      projectRoot: ctx.projectRoot,
      model_id: "mimo-v2.5-pro"
    });
    assert.equal(switched.res.status, 200);
    assert.equal(switched.data.project.active_model.model_name, "mimo-v2.5-pro");
    assert.equal(switched.data.model_profile.api_key_saved, true);

    const dashboard = await getJson(ctx.port, "/api/dashboard");
    assert.equal(dashboard.data.project.active_model.model_name, "mimo-v2.5-pro");
    assert.ok(dashboard.data.available_models.some((model) => model.model_name === "deepseek-chat"));
  } finally {
    await closeServer(ctx.server);
  }
});

test("settings/update persists tool_permissions / budget_config / research_config alongside active_model", async () => {
  const ctx = await setupServer();
  try {
    const { res, data } = await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      active_model: {
        provider: "openai-compatible",
        model_name: "writer-smoke",
        base_url: "https://api.example.test/v1",
        api_key_env: "WRITER_API_KEY",
        api_key: "sk-smoke-key-for-local-secret",
      },
      tool_permissions: {
        network_allowed: true
      },
      budget_config: {
        max_model_calls: 77
      },
      research_config: {
        search_endpoint: "https://search.example.test/api",
        search_api_key_env: "SEARCH_API_KEY"
      }
    });

    assert.equal(res.status, 200);
    assert.equal(data.project.budget_config.max_model_calls, 77);
    assert.equal(data.project.tool_permissions.network_allowed, true);
    assert.equal(data.project.research_config.search_endpoint, "https://search.example.test/api");

    const persisted = await loadProject(ctx.projectRoot);
    assert.equal(persisted.budget_config.max_model_calls, 77);
    assert.equal(persisted.tool_permissions.network_allowed, true);
    assert.equal(persisted.research_config.search_endpoint, "https://search.example.test/api");

    const dashboard = await loadDashboardData(ctx.root, { projectRoot: ctx.projectRoot });
    assert.equal(dashboard.project.budget_config.max_model_calls, 77);
    assert.equal(dashboard.project.tool_permissions.network_allowed, true);
    assert.equal(dashboard.project.research_config.search_endpoint, "https://search.example.test/api");
  } finally {
    await closeServer(ctx.server);
  }
});

test("settings/update persists a non-model patch without requiring active_model", async () => {
  const ctx = await setupServer();
  try {
    const { res, data } = await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      tool_permissions: { network_allowed: true },
      budget_config: { max_model_calls: 12 },
    });

    assert.equal(res.status, 200);
    assert.equal(data.project.tool_permissions.network_allowed, true);
    assert.equal(data.project.budget_config.max_model_calls, 12);
    const persisted = await loadProject(ctx.projectRoot);
    assert.equal(persisted.tool_permissions.network_allowed, true);
    assert.equal(persisted.budget_config.max_model_calls, 12);
    assert.equal(persisted.active_model.model_name, "mock-writer");
  } finally {
    await closeServer(ctx.server);
  }
});

test("settings/update persists active model pricing and runtime fields", async () => {
  const ctx = await setupServer();
  try {
    const { res } = await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      active_model: {
        provider: "openai-compatible",
        model_name: "writer-pricing",
        base_url: "https://api.example.test/v1",
        api_key_env: "WRITER_PRICING_KEY",
        api_key: "temporary-pricing-key",
        pricing: { input_per_million: 1, output_per_million: 2 },
        stream: true,
        max_output_tokens: 2048,
      },
    });

    assert.equal(res.status, 200);
    const persisted = await loadProject(ctx.projectRoot);
    assert.deepEqual(persisted.active_model.pricing, { input_per_million: 1, output_per_million: 2, currency: "CNY" });
    assert.equal(persisted.active_model.stream, true);
    assert.equal(persisted.active_model.max_output_tokens, 2048);
  } finally {
    await closeServer(ctx.server);
  }
});

test("settings/update rejects an invalid non-model patch atomically before writing model fields", async () => {
  const ctx = await setupServer();
  try {
    const before = await loadProject(ctx.projectRoot);
    const beforeSecrets = loadLocalSecretsSync(ctx.secretsRoot);

    const { res, data } = await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      active_model: {
        provider: "openai-compatible",
        model_name: "writer-smoke",
        base_url: "https://api.example.test/v1",
        api_key_env: "WRITER_API_KEY",
        api_key: "sk-smoke-key-for-local-secret",
      },
      // Invalid: max_model_calls must be a positive integer
      budget_config: {
        max_model_calls: -1
      }
    });

    assert.equal(res.status, 400);
    assert.equal(data.code, "invalid_max_model_calls");
    assert.deepEqual(await loadProject(ctx.projectRoot), before);
    assert.deepEqual(loadLocalSecretsSync(ctx.secretsRoot), beforeSecrets);
  } finally {
    await closeServer(ctx.server);
  }
});

test("connection test validates unsaved candidate without persisting it", async () => {
  const seen = [];
  const { server, port, projectRoot, secretsRoot } = await setupServer({
    testModelConnection: async (input) => {
      seen.push(input);
      return {
        ok: true,
        provider: input.config.provider,
        model_name: input.config.model_name,
        latency_ms: 31,
      };
    },
  });
  try {
    const beforeProject = await loadProject(projectRoot);
    const beforeSecrets = await loadLocalSecrets(secretsRoot);

    const { res, data } = await postJson(port, "/api/settings/test-connection", {
      projectRoot,
      active_model: {
        provider: "openai-compatible",
        model_name: "mimo-v2.5-pro",
        base_url: "https://api.xiaomimimo.com/v1",
        api_key_env: "XIAOMI_MIMO_API_KEY",
        api_key: "ephemeral-key",
      },
    });

    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(seen[0].config.model_name, "mimo-v2.5-pro");
    assert.deepEqual(await loadProject(projectRoot), beforeProject);
    assert.deepEqual(await loadLocalSecrets(secretsRoot), beforeSecrets);
    const events = await readEvents(projectRoot);
    assert.ok(
      events.some(
        (event) =>
          event.type === "model_connection_tested" &&
          event.data?.ok === true &&
          JSON.stringify(event).includes("ephemeral-key") === false
      )
    );
  } finally {
    await closeServer(server);
  }
});

test("invalid legacy model config blocks a task without provider access", async () => {
  let runCalls = 0;
  const { server, port, projectRoot } = await setupServer({
    testRunProject: async () => {
      runCalls += 1;
    },
  });
  try {
    const project = await loadProject(projectRoot);
    await saveProject(projectRoot, {
      ...project,
      active_model: {
        provider: "openai-compatible",
        model_name: "mimo-v2.5-pro",
        base_url: "",
        api_key_env: "XIAOMI_MIMO_API_KEY",
      },
    });

    const { res, data } = await postJson(port, "/api/commands/submit", {
      projectRoot,
      message: "写第 1 章",
    });

    assert.equal(res.status, 400);
    assert.equal(data.code, "configuration_missing");
    assert.equal(runCalls, 0);
    const queue = await getJson(port, "/api/queue/state");
    assert.equal(queue.data.tasks.length, 1);
    assert.equal(queue.data.tasks[0].status, "blocked");
    assert.equal(queue.data.tasks[0].error, "configuration_missing");
    const state = await loadState(projectRoot);
    assert.equal(state.project_status, "blocked");
    assert.equal(state.blocked_reason, "模型配置不完整");
  } finally {
    await closeServer(server);
  }
});

test("custom model settings persist the submitted base URL and model id", async () => {
  const ctx = await setupServer();
  try {
    const customModelId = "writer-custom-" + Date.now();
    const customApiKey = "sk-custom-" + Date.now();
    const { res, data } = await postJson(ctx.port, "/api/settings/update", {
      projectRoot: ctx.projectRoot,
      active_model: {
        provider: "openai-compatible",
        model_name: customModelId,
        base_url: "https://api.example.test/v1",
        api_key_env: "WWRITING_PROVIDER_API_KEY",
        api_key: customApiKey,
        max_output_tokens: 4096
      }
    });
    assert.equal(res.status, 200);
    assert.equal(data.project.active_model.model_name, customModelId);
    assert.equal(data.project.active_model.base_url, "https://api.example.test/v1");

    const dashboard = await getJson(ctx.port, "/api/dashboard");
    assert.equal(dashboard.data.project.active_model.model_name, customModelId);
    assert.equal(dashboard.data.model_profile.model_name, customModelId);
  } finally {
    await closeServer(ctx.server);
  }
});

test("POST /api/commands/submit 在 blueprint_status none 时不被蓝图门禁拒绝", async () => {
  const { server, port, projectRoot } = await setupServer();
  try {
    const state = await loadState(projectRoot);
    await saveState(projectRoot, { ...state, blueprint_status: "none" });

    const { res, data } = await postJson(port, "/api/commands/submit", { message: "写第1章" });
    assert.notEqual(res.status, 400);
    assert.notEqual(data.code, "blueprint_not_ready");

    const { data: queue } = await getJson(port, "/api/queue/state");
    assert.equal(queue.tasks.length, 1);
    assert.notEqual(queue.tasks[0].status, "blocked");
  } finally {
    await closeServer(server);
  }
});
