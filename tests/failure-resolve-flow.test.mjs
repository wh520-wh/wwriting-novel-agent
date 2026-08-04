import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../src/core/app-server.mjs";
import { loadState, saveState } from "../src/core/project-store.mjs";
import { createWritingProject } from "./helpers.mjs";
import { readEvents } from "../src/core/event-log.mjs";
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-resolve-"));
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

async function waitFor(predicate, { timeout = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

test("resolve raise-budget 解除阻塞并自动续跑", async () => {
  const run = {
    calls: [],
    async testRunProject(projectRoot, options) {
      const deferred = {};
      deferred.promise = new Promise((resolve, reject) => {
        deferred.resolve = resolve;
        deferred.reject = reject;
      });
      options.onHeartbeat?.({ step: 0, stage: "queued", chapter: 1 });
      options.signal?.addEventListener("abort", () => deferred.reject(new Error("cancelled")), { once: true });
      run.calls.push({ projectRoot, options, deferred });
      return deferred.promise;
    }
  };
  const ctx = await setupServer({ testRunProject: run.testRunProject });
  try {
    // Seed blocked state with budget failure
    // 保留 blueprint_status: complete（createWritingProject 的约定）：
    // 手写 state 覆盖时会丢掉该字段，字段缺失且无章节产物会按 none 拒绝（Task 9 收紧后语义）。
    await saveState(ctx.projectRoot, {
      blueprint_status: "complete",
      project_status: "blocked",
      blocked_reason: "model_call_budget_exhausted",
      blocked_at_stage: "drafting",
      current_chapter_no: 1,
      current_stage: "blocked"
    });
    appendFailure(ctx.projectRoot, {
      id: "fb-budget",
      kind: "budget-exhausted",
      resolution: null,
      suggested_commands: ["raise-budget", "switch-model"]
    });

    const { res, data } = await postJson(ctx.port, "/api/failures/resolve", {
      command: "raise-budget",
      args: { newMaxModelCalls: 400 },
      failureId: "fb-budget"
    });

    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.resumed, true);

    // Verify state was unblocked
    const state = await loadState(ctx.projectRoot);
    assert.equal(state.project_status, "running");
    assert.equal(state.blocked_reason, undefined);

    // Verify a run was started
    assert.equal(run.calls.length, 1);
  } finally {
    await closeServer(ctx.server);
  }
});

test("switch-model 用 model_name 字符串列表校验", async () => {
  const ctx = await setupServer();
  try {
    // Seed a provider-error failure
    appendFailure(ctx.projectRoot, {
      id: "fb-provider",
      kind: "provider-error",
      resolution: null,
      suggested_commands: ["switch-model"]
    });

    // The default project has active_model with model_name "mock-writer"
    // listAllowedModels should return ["mock-writer"] as strings
    const { res, data } = await postJson(ctx.port, "/api/failures/resolve", {
      command: "switch-model",
      args: { modelId: "mock-writer" },
      failureId: "fb-provider"
    });

    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
  } finally {
    await closeServer(ctx.server);
  }
});

test("runProject 返回 paused 结果时任务正常完结，不误标 interrupted", async () => {
  const run = {
    calls: [],
    async testRunProject(projectRoot, options) {
      const deferred = {};
      deferred.promise = new Promise((resolve) => {
        deferred.resolve = resolve;
      });
      options.onHeartbeat?.({ step: 0, stage: "queued", chapter: 1 });
      run.calls.push({ projectRoot, options, deferred });
      return deferred.promise;
    }
  };
  const ctx = await setupServer({ testRunProject: run.testRunProject });
  try {
    // Submit a command to start a run
    await postJson(ctx.port, "/api/commands/submit", { message: "写第1章" });
    await waitFor(() => run.calls.length === 1);

    // Resolve with paused result
    run.calls[0].deferred.resolve({ completed: false, paused: true });

    // Wait for the job to finish
    await waitFor(async () => {
      const { data: queue } = await getJson(ctx.port, "/api/queue/state");
      return queue.tasks[0]?.status === "completed" && queue;
    });

    // Verify no project_run_failed event was appended
    const events = await readEvents(ctx.projectRoot);
    const failedEvents = events.filter((e) => e.type === "project_run_failed");
    assert.equal(failedEvents.length, 0, "should not have project_run_failed event for paused result");

    // Verify project_run_finished was emitted with pause message
    const finishedEvents = events.filter((e) => e.type === "project_run_finished");
    assert.ok(finishedEvents.length > 0, "should have project_run_finished event");
    assert.match(finishedEvents[0].message, /停在/u);
  } finally {
    await closeServer(ctx.server);
  }
});

test("dashboard 不下发明文 API Key，model-secret 端点按需返回", async () => {
  const ctx = await setupServer();
  try {
    const save = await postJson(ctx.port, "/api/settings/update", {
      active_model: {
        provider: "openai-compatible",
        model_name: "deepseek-chat",
        base_url: "https://api.deepseek.com",
        api_key: "sk-secret-abcd1234",
        api_key_env: "WW_TEST_KEY"
      }
    });
    assert.equal(save.res.status, 200, JSON.stringify(save.data));

    const dashRes = await fetch(`http://127.0.0.1:${ctx.port}/api/dashboard`);
    const dashText = await dashRes.text();
    assert.ok(!dashText.includes("sk-secret-abcd1234"), "dashboard 响应不得包含明文 key");
    const dash = JSON.parse(dashText);
    assert.equal(dash.model_profile.api_key_saved, true);
    assert.ok(dash.model_profile.api_key_masked.endsWith("1234"));

    const secretRes = await fetch(`http://127.0.0.1:${ctx.port}/api/settings/model-secret`);
    const secret = await secretRes.json();
    assert.equal(secret.ok, true);
    assert.equal(secret.value, "sk-secret-abcd1234");
  } finally {
    await closeServer(ctx.server);
  }
});
