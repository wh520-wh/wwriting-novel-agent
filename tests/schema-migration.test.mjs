import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskQueue, TASK_QUEUE_SCHEMA_VERSION } from "../src/core/task-queue.mjs";

async function makeTmpDir(prefix = "wwriting-schema-migration-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("loading a v1-shaped file (no schema_version) auto-migrates to v2", async () => {
  const projectRoot = await makeTmpDir();
  try {
    const v1State = {
      tasks: [
        {
          id: "task-aaa",
          index: 1,
          instruction: "写第1章",
          mode: "auto",
          status: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:05:00.000Z",
          updatedAt: "2026-01-01T00:05:00.000Z",
          error: null
        }
      ],
      updatedAt: "2026-01-01T00:05:00.000Z"
    };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v1State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();

    assert.equal(state.schema_version, 3);
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].id, "task-aaa");
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("loading a v1-shaped file with schema_version 1 upgrades to v2", async () => {
  const projectRoot = await makeTmpDir();
  try {
    const v1State = {
      schema_version: 1,
      tasks: [
        {
          id: "task-bbb",
          index: 1,
          instruction: "续写第2章",
          mode: "manual",
          status: "running",
          createdAt: "2026-02-01T00:00:00.000Z",
          startedAt: "2026-02-01T00:00:01.000Z",
          completedAt: null,
          updatedAt: "2026-02-01T00:00:01.000Z",
          error: null
        }
      ],
      updatedAt: "2026-02-01T00:00:01.000Z"
    };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v1State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();

    assert.equal(state.schema_version, 3);
    assert.equal(state.tasks[0].id, "task-bbb");
    assert.equal(state.tasks[0].instruction, "续写第2章");
    assert.equal(state.tasks[0].mode, "manual");
    assert.equal(state.tasks[0].status, "running");
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("migrated data preserves all original task fields", async () => {
  const projectRoot = await makeTmpDir();
  try {
    const v1Task = {
      id: "task-ccc",
      index: 3,
      instruction: "写第5章，加入新角色林夕",
      mode: "write",
      status: "completed",
      createdAt: "2026-03-10T08:00:00.000Z",
      startedAt: "2026-03-10T08:00:05.000Z",
      completedAt: "2026-03-10T08:30:00.000Z",
      updatedAt: "2026-03-10T08:30:00.000Z",
      error: null
    };
    const v1State = { tasks: [v1Task], updatedAt: "2026-03-10T08:30:00.000Z" };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v1State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();
    const task = state.tasks[0];

    assert.equal(task.id, "task-ccc");
    assert.equal(task.index, 3);
    assert.equal(task.instruction, "写第5章，加入新角色林夕");
    assert.equal(task.mode, "write");
    assert.equal(task.status, "completed");
    assert.equal(task.createdAt, "2026-03-10T08:00:00.000Z");
    assert.equal(task.startedAt, "2026-03-10T08:00:05.000Z");
    assert.equal(task.completedAt, "2026-03-10T08:30:00.000Z");
    assert.equal(task.updatedAt, "2026-03-10T08:30:00.000Z");
    assert.equal(task.error, null);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("new v2 task fields have sensible defaults after migration", async () => {
  const projectRoot = await makeTmpDir();
  try {
    const v1Task = {
      id: "task-ddd",
      index: 1,
      instruction: "写第1章",
      mode: "auto",
      status: "queued",
      createdAt: "2026-04-01T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-04-01T00:00:00.000Z",
      error: null
    };
    const v1State = { tasks: [v1Task], updatedAt: "2026-04-01T00:00:00.000Z" };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v1State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();
    const task = state.tasks[0];

    assert.deepEqual(task.stages, [], "stages defaults to empty array");
    assert.equal(task.currentStage, null, "currentStage defaults to null");
    assert.equal(task.heartbeatAt, null, "heartbeatAt defaults to null");
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("v1 task missing id and index gets auto-generated defaults", async () => {
  const projectRoot = await makeTmpDir();
  try {
    const v1State = {
      tasks: [
        {
          instruction: "写第1章",
          status: "queued",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z"
        }
      ],
      updatedAt: "2026-05-01T00:00:00.000Z"
    };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v1State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();
    const task = state.tasks[0];

    assert.match(task.id, /^task-/u, "missing id gets auto-generated");
    assert.equal(task.index, 0, "missing index defaults to 0");
    assert.equal(task.mode, "auto", "missing mode defaults to auto");
    assert.equal(task.error, null, "missing error defaults to null");
    assert.deepEqual(task.stages, [], "missing stages defaults to empty array");
    assert.equal(task.currentStage, null, "missing currentStage defaults to null");
    assert.equal(task.heartbeatAt, null, "missing heartbeatAt defaults to null");
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("v1 task with terminal status but no completedAt gets completedAt filled", async () => {
  const projectRoot = await makeTmpDir();
  try {
    const v1State = {
      tasks: [
        {
          id: "task-terminal",
          index: 1,
          instruction: "写第1章",
          mode: "auto",
          status: "completed",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:10:00.000Z",
          error: null
        },
        {
          id: "task-interrupted",
          index: 2,
          instruction: "写第2章",
          mode: "auto",
          status: "interrupted",
          createdAt: "2026-06-01T00:10:00.000Z",
          updatedAt: "2026-06-01T00:15:00.000Z",
          error: "timeout"
        },
        {
          id: "task-cancelled",
          index: 3,
          instruction: "写第3章",
          mode: "auto",
          status: "cancelled",
          createdAt: "2026-06-01T00:15:00.000Z",
          updatedAt: "2026-06-01T00:20:00.000Z",
          error: "user cancelled"
        },
        {
          id: "task-blocked",
          index: 4,
          instruction: "写第4章",
          mode: "auto",
          status: "blocked",
          createdAt: "2026-06-01T00:20:00.000Z",
          updatedAt: "2026-06-01T00:25:00.000Z",
          error: "missing provider"
        }
      ],
      updatedAt: "2026-06-01T00:25:00.000Z"
    };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v1State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();

    for (const task of state.tasks) {
      assert.ok(task.completedAt, `task ${task.id} with terminal status "${task.status}" should have completedAt`);
      assert.ok(Date.parse(task.completedAt), `task ${task.id} completedAt should be a valid timestamp`);
    }
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("v1 empty tasks array migrates cleanly to v2", async () => {
  const projectRoot = await makeTmpDir();
  try {
    const v1State = { tasks: [], updatedAt: "2026-07-01T00:00:00.000Z" };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v1State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();

    assert.equal(state.schema_version, 3);
    assert.deepEqual(state.tasks, []);
    assert.ok(state.updatedAt);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("v1 file with non-array tasks defaults to empty tasks", async () => {
  const projectRoot = await makeTmpDir();
  try {
    const malformed = { tasks: "not an array", updatedAt: "2026-08-01T00:00:00.000Z" };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(malformed, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();

    assert.equal(state.schema_version, 3);
    assert.deepEqual(state.tasks, []);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("persisted file after migration contains schema_version 2", async () => {
  const projectRoot = await makeTmpDir();
  try {
    const v1State = {
      tasks: [
        {
          id: "task-persist",
          index: 1,
          instruction: "写第1章",
          mode: "auto",
          status: "queued",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
          error: null
        }
      ],
      updatedAt: "2026-09-01T00:00:00.000Z"
    };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v1State, null, 2));

    const queue = new TaskQueue(projectRoot);
    await queue.load();
    await queue.save();

    const raw = JSON.parse(await fs.readFile(path.join(projectRoot, "task_queue.json"), "utf8"));
    assert.equal(raw.schema_version, 3, "persisted file should have schema_version 3");
    assert.equal(raw.tasks.length, 1);
    assert.equal(raw.tasks[0].id, "task-persist");
    assert.deepEqual(raw.tasks[0].stages, [], "persisted file should have stages as empty array");
    assert.equal(raw.tasks[0].currentStage, null, "persisted file should have currentStage as null");
    assert.equal(raw.tasks[0].heartbeatAt, null, "persisted file should have heartbeatAt as null");
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("TASK_QUEUE_SCHEMA_VERSION constant equals 3", () => {
  assert.equal(TASK_QUEUE_SCHEMA_VERSION, 3);
});

test("multiple v1 tasks are sorted by index after migration", async () => {
  const projectRoot = await makeTmpDir();
  try {
    const v1State = {
      tasks: [
        {
          id: "task-third",
          index: 3,
          instruction: "写第3章",
          status: "queued",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z"
        },
        {
          id: "task-first",
          index: 1,
          instruction: "写第1章",
          status: "completed",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z"
        },
        {
          id: "task-second",
          index: 2,
          instruction: "写第2章",
          status: "running",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z"
        }
      ],
      updatedAt: "2026-10-01T00:00:00.000Z"
    };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v1State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();

    assert.deepEqual(
      state.tasks.map((t) => t.id),
      ["task-first", "task-second", "task-third"],
      "tasks should be sorted by index after migration"
    );
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("v1 task with recovery metadata preserves it through migration", async () => {
  const projectRoot = await makeTmpDir();
  try {
    const v1State = {
      tasks: [
        {
          id: "task-recovery",
          index: 1,
          instruction: "继续当前写作任务",
          mode: "write",
          status: "running",
          source: "project_state_recovery",
          recovery: {
            source: "project_state",
            projectStatus: "interrupted",
            chapterNo: 2,
            stage: "drafting",
            reason: "API timeout"
          },
          createdAt: "2026-11-01T00:00:00.000Z",
          startedAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          error: null
        }
      ],
      updatedAt: "2026-11-01T00:00:00.000Z"
    };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v1State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();
    const task = state.tasks[0];

    assert.equal(task.source, "project_state_recovery");
    assert.deepEqual(task.recovery, {
      source: "project_state",
      projectStatus: "interrupted",
      chapterNo: 2,
      stage: "drafting",
      reason: "API timeout"
    });
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("loading a missing file creates empty v2 state", async () => {
  const projectRoot = await makeTmpDir();
  try {
    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();

    assert.equal(state.schema_version, 3);
    assert.deepEqual(state.tasks, []);
    assert.ok(state.updatedAt);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("loading a v2-shaped file (no task contracts) auto-migrates to v3 with a synthesized contract", async () => {
  const projectRoot = await makeTmpDir("wwriting-schema-migration-v2-precise-");
  try {
    const v2State = {
      schema_version: 2,
      tasks: [
        {
          id: "task-v2-precise",
          index: 1,
          instruction: "写第2章",
          mode: "auto",
          status: "queued",
          createdAt: "2026-05-15T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          updatedAt: "2026-05-15T00:00:00.000Z",
          error: null,
          stages: [],
          currentStage: null,
          heartbeatAt: null
        }
      ],
      updatedAt: "2026-05-15T00:00:00.000Z"
    };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v2State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();

    assert.equal(state.schema_version, 3);
    assert.equal(state.tasks[0].contract.kind, "write_chapter");
    assert.equal(state.tasks[0].contract.chapter_start, 2);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("loading a v2 ambiguous queued task marks it blocked with legacy_task_contract_unresolved", async () => {
  const projectRoot = await makeTmpDir("wwriting-schema-migration-v2-ambiguous-");
  try {
    const v2State = {
      schema_version: 2,
      tasks: [
        {
          id: "task-v2-ambiguous",
          index: 1,
          instruction: "继续写作",
          mode: "auto",
          status: "queued",
          createdAt: "2026-05-15T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          updatedAt: "2026-05-15T00:00:00.000Z",
          error: null,
          stages: [],
          currentStage: null,
          heartbeatAt: null
        }
      ],
      updatedAt: "2026-05-15T00:00:00.000Z"
    };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v2State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();

    assert.equal(state.schema_version, 3);
    assert.equal(state.tasks[0].status, "blocked");
    assert.equal(state.tasks[0].error, "legacy_task_contract_unresolved");
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("loading a v2 ambiguous running legacy task marks it blocked with legacy_task_contract_unresolved", async () => {
  const projectRoot = await makeTmpDir("wwriting-schema-migration-v2-ambiguous-running-");
  try {
    const v2State = {
      schema_version: 2,
      tasks: [
        {
          id: "task-v2-ambiguous-running",
          index: 1,
          instruction: "resume stale run",
          mode: "write",
          status: "running",
          createdAt: "2026-05-20T00:00:00.000Z",
          startedAt: "2026-05-20T00:00:01.000Z",
          completedAt: null,
          updatedAt: "2026-05-20T00:00:01.000Z",
          error: null,
          stages: [],
          currentStage: "drafting",
          heartbeatAt: "2026-05-20T00:00:01.000Z"
        }
      ],
      updatedAt: "2026-05-20T00:00:01.000Z"
    };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v2State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();
    const task = state.tasks[0];

    assert.equal(state.schema_version, 3);
    assert.equal(task.status, "blocked");
    assert.equal(task.error, "legacy_task_contract_unresolved");
    assert.equal(task.contract, undefined);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test("loading a v2 ambiguous running legacy task with recovery.chapterNo binds a resume contract", async () => {
  const projectRoot = await makeTmpDir("wwriting-schema-migration-v2-running-recovery-");
  try {
    const v2State = {
      schema_version: 2,
      tasks: [
        {
          id: "task-v2-running-with-recovery",
          index: 1,
          instruction: "resume stale run",
          mode: "write",
          status: "running",
          source: "project_state_recovery",
          recovery: {
            source: "project_state",
            projectStatus: "interrupted",
            chapterNo: 3,
            stage: "drafting",
            reason: "API timeout"
          },
          createdAt: "2026-05-21T00:00:00.000Z",
          startedAt: "2026-05-21T00:00:01.000Z",
          completedAt: null,
          updatedAt: "2026-05-21T00:00:01.000Z",
          error: null,
          stages: [],
          currentStage: "drafting",
          heartbeatAt: "2026-05-21T00:00:01.000Z"
        }
      ],
      updatedAt: "2026-05-21T00:00:01.000Z"
    };
    await fs.writeFile(path.join(projectRoot, "task_queue.json"), JSON.stringify(v2State, null, 2));

    const queue = new TaskQueue(projectRoot);
    const state = await queue.load();
    const task = state.tasks[0];

    assert.equal(state.schema_version, 3);
    assert.equal(task.status, "running");
    assert.equal(task.contract.kind, "resume_chapter");
    assert.equal(task.contract.chapter_start, 3);
    assert.equal(task.contract.chapter_end, 3);
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
