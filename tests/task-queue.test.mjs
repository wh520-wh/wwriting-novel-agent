import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { expandInstruction, TaskQueue } from "../src/core/task-queue.mjs";

async function makeQueue(prefix = "wwriting-task-queue-") {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const queue = new TaskQueue(projectRoot);
  await queue.load();
  return { projectRoot, queue };
}

test("enqueue stores queued tasks with stable shape and persists them", async () => {
  const { projectRoot, queue } = await makeQueue();

  const task = await queue.enqueue("写第1章", { mode: "auto" });

  assert.equal(task.index, 1);
  assert.equal(task.instruction, "写第1章");
  assert.equal(task.mode, "auto");
  assert.equal(task.status, "queued");
  assert.equal(task.startedAt, null);
  assert.equal(task.completedAt, null);
  assert.equal(task.error, null);
  assert.deepEqual(task.stages, []);
  assert.equal(task.currentStage, null);
  assert.equal(task.heartbeatAt, null);
  assert.match(task.id, /^task-/u);
  assert.ok(Date.parse(task.createdAt));
  assert.ok(Date.parse(task.updatedAt));

  const raw = JSON.parse(await fs.readFile(path.join(projectRoot, "task_queue.json"), "utf8"));
  assert.equal(raw.schema_version, 2);
  assert.equal(raw.tasks.length, 1);
  assert.equal(raw.tasks[0].id, task.id);
});

test("promoteNext runs only the first queued task and reload restores state", async () => {
  const { projectRoot, queue } = await makeQueue();
  const first = await queue.enqueue("写第1章", { mode: "auto" });
  const second = await queue.enqueue("写第2章", { mode: "manual" });

  const promoted = await queue.promoteNext();

  assert.equal(promoted.id, first.id);
  assert.equal(promoted.status, "running");
  assert.ok(Date.parse(promoted.startedAt));
  assert.ok(Date.parse(promoted.heartbeatAt));
  assert.equal(queue.getState().tasks.find((task) => task.id === second.id).status, "queued");

  const reloaded = new TaskQueue(projectRoot);
  await reloaded.load();
  const state = reloaded.getState();
  assert.equal(state.tasks[0].id, first.id);
  assert.equal(state.tasks[0].status, "running");
  assert.equal(state.tasks[1].id, second.id);
  assert.equal(state.tasks[1].status, "queued");
});

test("promoteNext does not promote another task while one is already running", async () => {
  const { queue } = await makeQueue();
  await queue.enqueue("first", { mode: "auto" });
  await queue.enqueue("second", { mode: "auto" });
  const first = await queue.promoteNext();

  const second = await queue.promoteNext();

  assert.equal(first.status, "running");
  assert.equal(second, null);
  assert.deepEqual(queue.getState().tasks.map((task) => task.status), ["running", "queued"]);
});

test("complete, interrupt, cancel, and abortRunning transition only valid tasks", async () => {
  const { queue } = await makeQueue();
  const running = await queue.enqueue("写第1章", { mode: "auto" });
  const queued = await queue.enqueue("写第2章", { mode: "auto" });
  await queue.promoteNext();

  assert.equal(await queue.cancel(running.id, "not now"), null);

  const cancelled = await queue.cancel(queued.id, "not needed");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error, "not needed");
  assert.ok(Date.parse(cancelled.completedAt));

  const completed = await queue.complete(running.id, { chapter: 1 });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result, { chapter: 1 });
  assert.ok(Date.parse(completed.completedAt));

  const failing = await queue.enqueue("写第3章", { mode: "auto" });
  await queue.promoteNext();
  const interrupted = await queue.interrupt(failing.id, new Error("model stopped"));
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.error, "model stopped");

  const stillRunning = await queue.enqueue("写第4章", { mode: "auto" });
  await queue.promoteNext();
  const aborted = await queue.abortRunning("user stopped");
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].id, stillRunning.id);
  assert.equal(aborted[0].status, "cancelled");
  assert.equal(aborted[0].error, "user stopped");

  const retried = await queue.retry(interrupted.id);
  assert.equal(retried.status, "running");
  assert.equal(retried.error, null);
});

test("blocked marks a running task as terminal and not retryable", async () => {
  const { queue } = await makeQueue();
  const task = await queue.enqueue("blocked provider", { mode: "auto" });
  await queue.promoteNext();

  const blocked = await queue.block(task.id, "Missing provider");
  const retried = await queue.retry(task.id);

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.error, "Missing provider");
  assert.equal(retried, null);
});

test("retry does not create a second running task", async () => {
  const { projectRoot, queue } = await makeQueue();
  const running = await queue.enqueue("running task", { mode: "auto" });
  const interrupted = await queue.enqueue("interrupted task", { mode: "auto" });
  await queue.promoteNext();
  const raw = queue.getState();
  raw.tasks.find((task) => task.id === interrupted.id).status = "interrupted";
  await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(raw, null, 2));

  const retried = await queue.retry(interrupted.id);

  assert.equal(retried, null);
  assert.deepEqual(queue.getState().tasks.map((task) => [task.id, task.status]), [
    [running.id, "running"],
    [interrupted.id, "interrupted"]
  ]);
});

test("expandInstruction expands chapter ranges and counts but keeps precise chapter requests intact", () => {
  assert.deepEqual(expandInstruction("写到第8章", { currentChapter: 6 }), ["写第6章", "写第7章", "写第8章"]);
  assert.deepEqual(expandInstruction("续写到第8章", { currentChapter: 7 }), ["续写第7章", "续写第8章"]);
  assert.deepEqual(expandInstruction("写完到第8章", { currentChapter: 8 }), ["写第8章"]);
  assert.deepEqual(expandInstruction("一直写到第8章", { currentChapter: 6 }), ["写第6章", "写第7章", "写第8章"]);
  assert.deepEqual(expandInstruction("写3章", { currentChapter: 4 }), ["写第4章", "写第5章", "写第6章"]);
  assert.deepEqual(expandInstruction("续写3章", { currentChapter: 4 }), ["续写第4章", "续写第5章", "续写第6章"]);
  assert.deepEqual(expandInstruction("写第4章，加入新角色林夕", { currentChapter: 2 }), ["写第4章，加入新角色林夕"]);
});

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
