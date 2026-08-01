import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fss from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRetryCandidate, retryDashboardFields } from "../src/core/retry-candidates.mjs";
import { ensureDir, writeJsonAtomic } from "../src/core/fs-utils.mjs";

// --- helpers ---

async function makeTmpProject(stateOverrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-retry-"));
  await ensureDir(path.join(dir, "memory"));
  const state = {
    project_status: "running",
    current_chapter_no: 1,
    current_stage: "drafting",
    ...stateOverrides
  };
  await writeJsonAtomic(path.join(dir, "agent_state.json"), state);
  return dir;
}

function makeQueue(tasks = []) {
  let loaded = false;
  return {
    async load() { loaded = true; },
    getState() {
      return { tasks };
    },
    get loaded() { return loaded; }
  };
}

function makeJob(status = "idle") {
  return { status };
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

// --- resolveRetryCandidate ---

test("resolveRetryCandidate returns unavailable when projectRoot is missing", async () => {
  const result = await resolveRetryCandidate({});
  assert.equal(result.available, false);
  assert.equal(result.code, "retry_project_unavailable");
  assert.equal(result.status, 404);
});

test("resolveRetryCandidate returns unavailable when job is still running", async () => {
  const dir = await makeTmpProject();
  try {
    const result = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue(), job: makeJob("running") });
    assert.equal(result.available, false);
    assert.equal(result.code, "retry_still_running");
    assert.equal(result.status, 409);
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate reports cancelling when job is stopping", async () => {
  const dir = await makeTmpProject({ project_status: "cancelling" });
  try {
    const result = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue(), job: makeJob("cancelling") });
    assert.equal(result.available, false);
    assert.equal(result.code, "retry_cancelling");
    assert.equal(result.reason, "正在停止，请等待状态收敛");
    assert.equal(result.status, 409);
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate reports cancelling when a queue task is cancelling", async () => {
  const dir = await makeTmpProject({ project_status: "running" });
  try {
    const result = await resolveRetryCandidate({
      projectRoot: dir,
      queue: makeQueue([{ id: "task-1", status: "cancelling" }]),
      job: makeJob()
    });
    assert.equal(result.available, false);
    assert.equal(result.code, "retry_cancelling");
    assert.equal(result.reason, "正在停止，请等待状态收敛");
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate returns unavailable when project status is completed", async () => {
  const dir = await makeTmpProject({ project_status: "completed" });
  try {
    const result = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue(), job: makeJob() });
    assert.equal(result.available, false);
    assert.equal(result.code, "retry_not_allowed_status");
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate returns unavailable when project status is blocked", async () => {
  const dir = await makeTmpProject({ project_status: "blocked" });
  try {
    const result = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue(), job: makeJob() });
    assert.equal(result.available, false);
    assert.equal(result.code, "retry_not_allowed_status");
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate selects stale running task as candidate", async () => {
  const dir = await makeTmpProject({ project_status: "interrupted" });
  try {
    const tasks = [{ id: "task-1", status: "running" }];
    const result = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue(tasks), job: makeJob() });
    assert.equal(result.available, true);
    assert.equal(result.taskId, "task-1");
    assert.equal(result.candidateSource, "stale_queue_task");
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate accepts stale running task by taskId (dashboard→retry 闭环)", async () => {
  // 回归：仪表盘（无 taskId）广播 stale running 任务为可重试后，前端把 retry_task_id 回传，
  // taskId 分支必须同样放行（走 stale_queue_task 路径），不能 400 retry_invalid_task_id。
  const dir = await makeTmpProject({ project_status: "running" });
  try {
    const tasks = [{ id: "task-1", status: "running" }];
    const dash = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue(tasks), job: makeJob() });
    assert.equal(dash.available, true);
    assert.equal(dash.taskId, "task-1");
    const retry = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue(tasks), job: makeJob(), taskId: dash.taskId });
    assert.equal(retry.available, true);
    assert.equal(retry.taskId, "task-1");
    assert.equal(retry.candidateSource, "stale_queue_task");
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate still rejects running task by taskId when project state is idle", async () => {
  // 状态不一致（项目 idle 但队列残留 running）不广播也不放行，保持原拒绝行为。
  const dir = await makeTmpProject({ project_status: "idle" });
  try {
    const tasks = [{ id: "task-1", status: "running" }];
    const result = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue(tasks), job: makeJob(), taskId: "task-1" });
    assert.equal(result.available, false);
    assert.equal(result.code, "retry_invalid_task_id");
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate selects interrupted task when only one exists", async () => {
  const dir = await makeTmpProject({ project_status: "running" });
  try {
    const tasks = [{ id: "task-10", status: "interrupted" }];
    const result = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue(tasks), job: makeJob() });
    assert.equal(result.available, true);
    assert.equal(result.taskId, "task-10");
    assert.equal(result.candidateSource, "queue_task");
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate returns ambiguous when multiple terminal tasks exist", async () => {
  const dir = await makeTmpProject({ project_status: "running" });
  try {
    const tasks = [
      { id: "t1", status: "interrupted" },
      { id: "t2", status: "cancelled" }
    ];
    const result = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue(tasks), job: makeJob() });
    assert.equal(result.available, false);
    assert.equal(result.code, "retry_ambiguous_task");
    assert.deepEqual(result.ambiguousTaskIds, ["t1", "t2"]);
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate selects specific task by taskId", async () => {
  const dir = await makeTmpProject({ project_status: "running" });
  try {
    const tasks = [
      { id: "t1", status: "interrupted" },
      { id: "t2", status: "cancelled" }
    ];
    const result = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue(tasks), job: makeJob(), taskId: "t2" });
    assert.equal(result.available, true);
    assert.equal(result.taskId, "t2");
    assert.equal(result.candidateSource, "queue_task");
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate rejects invalid taskId", async () => {
  const dir = await makeTmpProject({ project_status: "running" });
  try {
    const tasks = [{ id: "t1", status: "completed" }];
    const result = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue(tasks), job: makeJob(), taskId: "t1" });
    assert.equal(result.available, false);
    assert.equal(result.code, "retry_invalid_task_id");
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate falls back to project_state when no terminal tasks", async () => {
  const dir = await makeTmpProject({ project_status: "interrupted", current_chapter_no: 3, current_stage: "review", interrupted_reason: "timeout" });
  try {
    const result = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue([]), job: makeJob() });
    assert.equal(result.available, true);
    assert.equal(result.candidateSource, "project_state");
    assert.equal(result.taskId, null);
    assert.equal(result.recovery.chapterNo, 3);
    assert.equal(result.recovery.stage, "review");
    assert.equal(result.recovery.reason, "timeout");
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate returns unavailable when no candidate at all", async () => {
  const dir = await makeTmpProject({ project_status: "idle" });
  try {
    const result = await resolveRetryCandidate({ projectRoot: dir, queue: makeQueue([]), job: makeJob() });
    assert.equal(result.available, false);
    assert.equal(result.code, "retry_no_candidate");
  } finally {
    await cleanup(dir);
  }
});

test("resolveRetryCandidate loads queue before checking", async () => {
  const dir = await makeTmpProject();
  try {
    const q = makeQueue();
    await resolveRetryCandidate({ projectRoot: dir, queue: q, job: makeJob("running") });
    assert.equal(q.loaded, true);
  } finally {
    await cleanup(dir);
  }
});

// --- retryDashboardFields ---

test("retryDashboardFields maps available candidate correctly", () => {
  const fields = retryDashboardFields({ available: true, code: "retry_available", taskId: "t1", ambiguousTaskIds: [] });
  assert.equal(fields.retry_available, true);
  assert.equal(fields.retry_code, "retry_available");
  assert.equal(fields.retry_unavailable_reason, "");
  assert.equal(fields.retry_task_id, "t1");
  assert.deepEqual(fields.retry_ambiguous_task_ids, []);
});

test("retryDashboardFields maps unavailable candidate correctly", () => {
  const fields = retryDashboardFields({ available: false, code: "retry_no_candidate", reason: "nothing to retry" });
  assert.equal(fields.retry_available, false);
  assert.equal(fields.retry_code, "retry_no_candidate");
  assert.equal(fields.retry_unavailable_reason, "nothing to retry");
  assert.equal(fields.retry_task_id, null);
});

test("retryDashboardFields handles missing taskId and ambiguousTaskIds", () => {
  const fields = retryDashboardFields({ available: false, code: "x", reason: "y" });
  assert.equal(fields.retry_task_id, null);
  assert.deepEqual(fields.retry_ambiguous_task_ids, []);
});

// ===== §4.1: recoverInterruptedProjects =====

import { recoverInterruptedProjects } from "../src/core/app-server.mjs";

test("recoverInterruptedProjects detects stale running project", () => {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "wwriting-recovery-"));
  try {
    const stateRoot = path.join(dir, "state");
    fss.mkdirSync(stateRoot, { recursive: true });
    const projectDir = path.join(dir, "project");
    fss.mkdirSync(projectDir, { recursive: true });
    fss.writeFileSync(path.join(projectDir, "project.yaml"), "title: test\n", "utf8");
    fss.writeFileSync(path.join(projectDir, "agent_state.json"), JSON.stringify({
      project_status: "running",
      current_chapter_no: 3,
      current_stage: "drafting"
    }));
    fss.writeFileSync(path.join(stateRoot, "app-state.json"), JSON.stringify({
      lastProjectRoot: projectDir,
      recentProjects: [{ projectRoot: projectDir, title: "test" }]
    }));
    const runJobs = new Map();
    const result = recoverInterruptedProjects(stateRoot, runJobs);
    assert.equal(result.recoveryCandidates.size, 1);
    assert.ok(result.recoveryCandidates.has(path.resolve(projectDir)));
  } finally {
    fss.rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverInterruptedProjects skips project with running job", () => {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "wwriting-recovery-"));
  try {
    const stateRoot = path.join(dir, "state");
    fss.mkdirSync(stateRoot, { recursive: true });
    const projectDir = path.join(dir, "project");
    fss.mkdirSync(projectDir, { recursive: true });
    fss.writeFileSync(path.join(projectDir, "project.yaml"), "title: test\n", "utf8");
    fss.writeFileSync(path.join(projectDir, "agent_state.json"), JSON.stringify({
      project_status: "running",
      current_chapter_no: 1
    }));
    fss.writeFileSync(path.join(stateRoot, "app-state.json"), JSON.stringify({
      lastProjectRoot: projectDir,
      recentProjects: [{ projectRoot: projectDir }]
    }));
    const runJobs = new Map([[path.resolve(projectDir), { status: "running" }]]);
    const result = recoverInterruptedProjects(stateRoot, runJobs);
    assert.equal(result.recoveryCandidates.size, 0, "有存活 job 时不应标记为残留");
  } finally {
    fss.rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverInterruptedProjects skips non-running project", () => {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "wwriting-recovery-"));
  try {
    const stateRoot = path.join(dir, "state");
    fss.mkdirSync(stateRoot, { recursive: true });
    const projectDir = path.join(dir, "project");
    fss.mkdirSync(projectDir, { recursive: true });
    fss.writeFileSync(path.join(projectDir, "project.yaml"), "title: test\n", "utf8");
    fss.writeFileSync(path.join(projectDir, "agent_state.json"), JSON.stringify({
      project_status: "completed",
      current_chapter_no: 5
    }));
    fss.writeFileSync(path.join(stateRoot, "app-state.json"), JSON.stringify({
      lastProjectRoot: projectDir,
      recentProjects: [{ projectRoot: projectDir }]
    }));
    const result = recoverInterruptedProjects(stateRoot, new Map());
    assert.equal(result.recoveryCandidates.size, 0, "已完成的项目不应标记残留");
  } finally {
    fss.rmSync(dir, { recursive: true, force: true });
  }
});
