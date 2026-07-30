# UAT Execution Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个写作任务具有严格章节边界，并让停止信号在 500ms 内进入 cancelling、在所有模型阶段可靠终止且可从检查点恢复。

**Architecture:** 新建纯函数模块 `task-contract.mjs` 负责把自然语言转换为单章契约并校验章节顺序；`task-queue.mjs` 只持久化契约和状态；`app-server.mjs` 负责创建任务、启动任务和收敛 cancelling/cancelled；`agent-engine.mjs` 只按传入契约运行。取消判断集中到 `cancellation.mjs`，运行时信号默认贯穿全部模型调用。

**Tech Stack:** Node.js 24 ESM、`node:test`、本地 JSON/YAML 文件、AbortController、Electron 后端 HTTP 服务。

---

## File Map

- Create: `src/core/task-contract.mjs`
  解析写作指令、生成单章任务契约、校验任务与当前章节的一致性。
- Create: `src/core/cancellation.mjs`
  定义 `ProjectCancelledError`、统一识别 AbortError，并提供 `throwIfAborted`。
- Modify: `src/core/task-queue.mjs`
  升级 schema v3，持久化 `contract`，支持 `cancelling` 和恢复契约。
- Modify: `src/core/app-server.mjs`
  入队前编译契约，启动时传入契约，停止时立即写入 cancelling 并 abort。
- Modify: `src/core/agent-engine.mjs`
  使用任务边界结束单章运行，传播信号，正确处理取消和检查点。
- Modify: `src/core/project-store.mjs`
  在检查点中记录真实 `task_id`、任务契约和已提交模型调用。
- Modify: `src/core/tool-runtime.mjs`
  在最终产物提交前检查取消，并保持最终文件写入幂等。
- Modify: `src/core/retry-candidates.mjs`
  将 cancelling 视为仍在运行，恢复任务携带 `resume_chapter` 契约。
- Test: `tests/task-contract.test.mjs`
- Test: `tests/task-queue.test.mjs`
- Test: `tests/schema-migration.test.mjs`
- Test: `tests/agent-engine.test.mjs`
- Test: `tests/model-client-retry.test.mjs`
- Test: `tests/tool-runtime.test.mjs`
- Test: `tests/app-server-probe.test.mjs`

## Execution Contract

### Current Baseline

Before changing code, confirm these existing entry points. Their names are the anchors used throughout this plan:

| Responsibility | Current entry point | Current defect |
|---|---|---|
| Command parsing | `expandInstruction` in `src/core/task-queue.mjs` | Returns strings, not executable contracts |
| Queue persistence | `TaskQueue.enqueue/load/save` | Schema v2 discards chapter boundaries |
| Run creation | `serveCommandSubmit` and `startProjectRun` in `src/core/app-server.mjs` | Runner receives `taskId` and signal, but no contract |
| Stop API | `serveRunStop` | Aborts inside the project lock and exposes no durable `cancelling` state |
| Main loop | `runProject` in `src/core/agent-engine.mjs` | Continues until `target_chapters` instead of task boundary |
| Fact-check | `runFactCheck` | Treats cancellation as a degradable provider failure |
| Memory extraction | `extractChapterMemory` | Can swallow cancellation and advance the watermark |
| Final file commit | `finalizeChapterFile` in `src/core/tool-runtime.mjs` | Has no signal or committed-file recovery rule |
| Checkpoints | `writeCheckpoint` and `checkpointPayload` | Do not consistently record real task identity and commit state |

Run this baseline inspection before Task 1:

```powershell
rg -n "expandInstruction|class TaskQueue|serveCommandSubmit|startProjectRun|serveRunStop|runProject|runFactCheck|extractChapterMemory|finalizeChapterFile|checkpointPayload" src tests
git status --short
```

Expected: all listed symbols exist; the status output is recorded so pre-existing user changes are never reverted.

### Canonical Task Contract

All implementation tasks must use this exact shape. Do not introduce alternate names such as
`start_chapter`, `chapterNo`, or `range` in persisted queue data.

```ts
type TaskContract = {
  version: 1;
  kind: "write_chapter" | "rewrite_chapter" | "resume_chapter";
  chapter_start: number;
  chapter_end: number;
  stop_policy: "immediate";
  resume_policy: "checkpoint";
  skip_policy: "reject";
};
```

For this remediation, the executor accepts only a single-chapter contract:

```text
chapter_start === chapter_end
```

`rewrite_chapter` is reserved for a future explicit rewrite entry point. Ordinary command parsing in this
plan must never infer it.

### Queue State Machine

The queue and project state are separate records and must converge according to this table:

| Trigger | Queue before | Queue after | Project after | Terminal |
|---|---|---|---|---|
| Promote next task | `queued` | `running` | `running` | No |
| Stop accepted | `running` | `cancelling` | `cancelling` | No |
| Executor observes stop | `cancelling` | `cancelled` | `cancelled` | Yes |
| Task chapter committed | `running` | `completed` | `idle` or `completed` | Yes |
| Missing configuration | `queued` or `running` | `blocked` | `blocked` | Yes |
| Non-cancel failure | `running` | `interrupted` | `interrupted` | Yes |

The following transitions are forbidden:

```text
cancelling -> running
cancelling -> completed unless the final file was already atomically committed
cancelled -> completed without an explicit resume task
completed -> running
```

`TERMINAL_STATUSES` remains:

```js
new Set(["completed", "interrupted", "cancelled", "blocked"])
```

`cancelling` belongs to `ACTIVE_STATUSES`, not terminal statuses.

### Project State Invariants

After every state mutation, these conditions must hold:

1. `project_status === "running"` implies exactly one queue task is `running`.
2. `project_status === "cancelling"` implies the matching queue task is `cancelling`.
3. A non-final chapter task completion sets `project_status: "idle"`,
   `current_stage: "queued"`, and advances `current_chapter_no` exactly once.
4. `project_status === "completed"` is allowed only when
   `current_chapter_no > target_chapters`.
5. A `cancelled` project does not auto-promote another queued task.
6. A task contract rejection does not modify `agent_state.json`, chapter index, or unrelated queue tasks.

### Command Parsing Decision Table

Implement and test this exact behavior:

| Input | Current chapter | Result |
|---|---:|---|
| `写第2章` | 2 | One `write_chapter` contract for chapter 2 |
| `继续写作` | 2 | One `write_chapter` contract for chapter 2 |
| `写三章` | 2 | Three tasks for chapters 2, 3, and 4 |
| `写到第4章` | 2 | Three tasks for chapters 2, 3, and 4 |
| `写第4章` | 2 | Reject with `chapter_gap`, details `{ missing_start: 2, missing_end: 3 }` |
| `写第1章` | 2 | Reject with `chapter_already_passed` |
| Ambiguous text, empty queue | 2 | Bind one task to chapter 2 |
| Ambiguous text, active/queued write exists | 2 | Reject with `ambiguous_task_scope` |

The parser may accept both Arabic and common Chinese count words for one through ten, but the first
implementation must not add a general natural-language parser.

### HTTP Contracts

`POST /api/commands/submit` request:

```json
{
  "projectRoot": "D:\\Novels\\demo",
  "message": "写第2章",
  "mode": "auto"
}
```

Successful response:

```json
{
  "ok": true,
  "projectRoot": "D:\\Novels\\demo",
  "tasks": [
    {
      "id": "task-...",
      "status": "queued",
      "contract": {
        "version": 1,
        "kind": "write_chapter",
        "chapter_start": 2,
        "chapter_end": 2,
        "stop_policy": "immediate",
        "resume_policy": "checkpoint",
        "skip_policy": "reject"
      }
    }
  ]
}
```

Contract rejection:

```json
{
  "ok": false,
  "code": "chapter_gap",
  "message": "请先完成第 2 至 3 章。",
  "details": {
    "currentChapter": 2,
    "requestedChapter": 4,
    "missing_start": 2,
    "missing_end": 3
  }
}
```

`POST /api/run/stop` synchronous response:

```json
{
  "ok": true,
  "projectRoot": "D:\\Novels\\demo",
  "taskId": "task-...",
  "status": "cancelling",
  "stop_requested_at": "2026-06-13T12:00:00.000Z"
}
```

The response means only that cancellation was accepted and persisted. It must not claim that the executor
has already stopped.

### Event Schemas

Add or normalize these events. Event `data` must never contain chapter body text, complete prompts, or API keys.

```js
{
  type: "task_contract_created",
  chapter_no: 2,
  stage: "queued",
  data: { task_id, contract }
}

{
  type: "task_contract_rejected",
  chapter_no: currentChapter,
  stage: currentStage,
  severity: "warn",
  data: { code, requested_chapter, current_chapter }
}

{
  type: "project_cancelling",
  chapter_no: currentChapter,
  stage: currentStage,
  data: { task_id, stop_requested_at }
}

{
  type: "project_cancelled",
  chapter_no: currentChapter,
  stage: currentStage,
  data: {
    task_id,
    stop_requested_at,
    cancel_observed_at,
    cancelled_at,
    stop_latency_ms
  }
}

{
  type: "chapter_artifact_committed",
  chapter_no: chapterNo,
  stage: "finalizing",
  data: { task_id, final_path, checksum, bytes_written }
}
```

Repeated stop requests must reuse the first `stop_requested_at` and must not append another
`project_cancelling` event.

### Checkpoint Schema

Every newly written checkpoint must include:

```json
{
  "task_id": "task-...",
  "task_contract": {
    "version": 1,
    "kind": "write_chapter",
    "chapter_start": 2,
    "chapter_end": 2,
    "stop_policy": "immediate",
    "resume_policy": "checkpoint",
    "skip_policy": "reject"
  },
  "chapter_no": 2,
  "stage": "reviewing",
  "segment_no": 1,
  "draft": {
    "path": "drafts/002.draft.md",
    "checksum": "sha256..."
  },
  "committed_model_calls": [
    {
      "id": "task-...:2:drafting:1:v1",
      "stage": "drafting",
      "segment_no": 1,
      "template_version": "v1"
    }
  ],
  "completed_gates": ["word-count-gate"],
  "artifact_commit": {
    "state": "none",
    "final_path": null,
    "checksum": null
  },
  "created_at": "2026-06-13T12:00:00.000Z"
}
```

Do not mark a model call committed until its response has been validated and its resulting draft or state
change has been durably written.

### Finalization Critical Section

The final file commit order is mandatory:

1. `throwIfAborted(signal)`.
2. Read and validate the draft.
3. Write the temporary final file.
4. Compute checksum from temporary-file bytes.
5. `throwIfAborted(signal)` a second time.
6. Atomically rename temporary file to final path.
7. Without another cancellation check, update chapter index to `completed`.
8. Without another cancellation check, write `chapter_artifact_committed`.
9. Write the checkpoint with `artifact_commit.state: "committed"`.
10. At the next normal stage boundary, observe any cancellation that arrived during steps 6 through 9.

This short no-abort interval prevents a final file from existing without its index and event.

### Existing Test Fixtures

Reuse these helpers instead of creating a second test harness:

| Test file | Existing helper | Use |
|---|---|---|
| `tests/task-queue.test.mjs` | `makeQueue()` | Isolated queue files |
| `tests/app-server-probe.test.mjs` | `setupServer()` | Real HTTP server on a fetch-safe port |
| `tests/app-server-probe.test.mjs` | `postJson()` / `getJson()` | API assertions |
| `tests/app-server-probe.test.mjs` | `deferredRun()` | Hold a runner in flight for stop races |
| `tests/agent-engine.test.mjs` | `CapturingModelClient` | Assert chapter and stage model calls |
| `tests/agent-engine.test.mjs` | `makeFactCheckProject()` | Fact-check cancellation |

When a new helper is necessary, keep it local to the test file unless at least two files need it.

### Per-Task Definition Of Done

Each task in this plan is complete only when:

1. The new test fails for the intended behavioral reason before implementation.
2. The focused test passes after implementation.
3. Neighboring tests listed in the task pass.
4. `git diff --check` has no output.
5. The commit contains only files listed by that task.
6. No pre-existing user changes are staged or reverted.

### Task 1: Define The Task Contract

**Files:**
- Create: `src/core/task-contract.mjs`
- Create: `tests/task-contract.test.mjs`

- [ ] **Step 1: Write failing parser and validation tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  TaskContractError,
  compileWritingTasks,
  validateTaskContract
} from "../src/core/task-contract.mjs";

test("精确章节指令生成严格单章契约", () => {
  assert.deepEqual(compileWritingTasks("写第2章", { currentChapter: 2, targetChapters: 10 }), [{
    instruction: "写第2章",
    contract: {
      version: 1,
      kind: "write_chapter",
      chapter_start: 2,
      chapter_end: 2,
      stop_policy: "immediate",
      resume_policy: "checkpoint",
      skip_policy: "reject"
    }
  }]);
});

test("范围指令拆成多个单章任务", () => {
  for (const instruction of ["写3章", "写三章", "写到第6章"]) {
    const tasks = compileWritingTasks(instruction, {
      currentChapter: 4,
      targetChapters: 10
    });
    assert.deepEqual(
      tasks.map((item) => item.contract.chapter_start),
      [4, 5, 6],
      instruction
    );
    assert.ok(
      tasks.every(
        (item) => item.contract.chapter_start === item.contract.chapter_end
      )
    );
  }
});

test("跳章和隐式重写均被拒绝", () => {
  assert.throws(
    () => compileWritingTasks("写第5章", { currentChapter: 2, targetChapters: 10 }),
    (error) => {
      assert.equal(error instanceof TaskContractError, true);
      assert.equal(error.code, "chapter_gap");
      assert.deepEqual(error.details, {
        currentChapter: 2,
        requestedChapter: 5,
        missing_start: 2,
        missing_end: 4
      });
      return true;
    }
  );
  assert.throws(
    () => compileWritingTasks("写第1章", { currentChapter: 2, targetChapters: 10 }),
    (error) => error instanceof TaskContractError && error.code === "chapter_already_passed"
  );
});

test("普通继续指令只绑定当前章", () => {
  const [task] = compileWritingTasks("继续写作，加强雨夜氛围", {
    currentChapter: 3,
    targetChapters: 10
  });
  assert.equal(task.contract.chapter_start, 3);
  assert.equal(task.contract.chapter_end, 3);
});

test("运行前契约校验拒绝过期任务", () => {
  assert.throws(
    () => validateTaskContract({
      version: 1,
      kind: "write_chapter",
      chapter_start: 2,
      chapter_end: 2,
      stop_policy: "immediate",
      resume_policy: "checkpoint",
      skip_policy: "reject"
    }, { currentChapter: 3, targetChapters: 10 }),
    (error) => error.code === "task_contract_stale"
  );
});
```

- [ ] **Step 2: Run the focused test and confirm module absence**

Run:

```powershell
node --test tests/task-contract.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/core/task-contract.mjs`.

- [ ] **Step 3: Implement the contract compiler**

Create `src/core/task-contract.mjs` with these public exports:

```js
export class TaskContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TaskContractError";
    this.code = code;
    this.details = details;
  }
}

export function makeChapterContract(chapterNo, kind = "write_chapter") {
  return {
    version: 1,
    kind,
    chapter_start: chapterNo,
    chapter_end: chapterNo,
    stop_policy: "immediate",
    resume_policy: "checkpoint",
    skip_policy: "reject"
  };
}

export function compileWritingTasks(instruction, { currentChapter, targetChapters }) {
  const text = String(instruction ?? "").trim();
  const current = positiveInteger(currentChapter, "currentChapter");
  const target = positiveInteger(targetChapters, "targetChapters");
  if (!text) throw new TaskContractError("empty_instruction", "请输入写作指令。");

  const precise = /^(写|续写)第(\d+)章(?:[，,\s].*)?$/u.exec(text);
  if (precise) {
    const chapter = Number(precise[2]);
    assertRequestedChapter(chapter, current, target);
    return [{ instruction: text, contract: makeChapterContract(chapter) }];
  }

  const toChapter = /^(?:写|续写|写完|一直写)到第(\d+)章$/u.exec(text);
  if (toChapter) {
    const end = Number(toChapter[1]);
    assertRangeEnd(end, current, target);
    return chapterTasks(current, end, preciseVerb(text));
  }

  const count = /^(写|续写)(\d+|[一二三四五六七八九十])章$/u.exec(text);
  if (count) {
    const amount = parseChapterCount(count[2]);
    const end = current + amount - 1;
    assertRangeEnd(end, current, target);
    return chapterTasks(current, end, count[1]);
  }

  return [{ instruction: text, contract: makeChapterContract(current) }];
}

export function makeResumeContract(chapterNo) {
  return makeChapterContract(positiveInteger(chapterNo, "chapterNo"), "resume_chapter");
}

export function validateTaskContract(contract, { currentChapter, targetChapters }) {
  if (!contract || contract.version !== 1) {
    throw new TaskContractError("invalid_task_contract", "任务缺少可执行契约。");
  }
  const current = positiveInteger(currentChapter, "currentChapter");
  const target = positiveInteger(targetChapters, "targetChapters");
  const start = positiveInteger(contract.chapter_start, "chapter_start");
  const end = positiveInteger(contract.chapter_end, "chapter_end");
  if (start !== end) {
    throw new TaskContractError("multi_chapter_contract_rejected", "执行器只接受单章任务。");
  }
  if (start > target) {
    throw new TaskContractError("chapter_out_of_project", `第 ${start} 章超过项目目标 ${target} 章。`);
  }
  if (start !== current) {
    throw new TaskContractError("task_contract_stale", `当前待写第 ${current} 章，任务目标为第 ${start} 章。`, {
      currentChapter: current,
      requestedChapter: start
    });
  }
  return contract;
}

function assertRequestedChapter(chapter, current, target) {
  if (chapter > target) {
    throw new TaskContractError("chapter_out_of_project", `第 ${chapter} 章超过项目目标 ${target} 章。`);
  }
  if (chapter > current) {
    throw new TaskContractError("chapter_gap", `请先完成第 ${current} 至 ${chapter - 1} 章。`, {
      currentChapter: current,
      requestedChapter: chapter,
      missing_start: current,
      missing_end: chapter - 1
    });
  }
  if (chapter < current) {
    throw new TaskContractError("chapter_already_passed", `第 ${chapter} 章已经越过，请使用明确的重写操作。`);
  }
}

function assertRangeEnd(end, current, target) {
  if (!Number.isInteger(end) || end < current) {
    throw new TaskContractError("invalid_chapter_range", "章节范围不能早于当前待写章节。");
  }
  if (end > target) {
    throw new TaskContractError("chapter_out_of_project", `范围终点第 ${end} 章超过项目目标 ${target} 章。`);
  }
}

function chapterTasks(start, end, verb) {
  return Array.from({ length: end - start + 1 }, (_, offset) => {
    const chapter = start + offset;
    return {
      instruction: `${verb}第${chapter}章`,
      contract: makeChapterContract(chapter)
    };
  });
}

function preciseVerb(text) {
  return text.startsWith("续写") ? "续写" : "写";
}

function parseChapterCount(value) {
  if (/^\d+$/u.test(value)) {
    return positiveInteger(value, "chapterCount");
  }
  const numbers = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10
  };
  const number = numbers[value];
  if (!number) {
    throw new TaskContractError("invalid_chapter_count", "章节数量必须是一到十或正整数。");
  }
  return number;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TaskContractError("invalid_task_contract", `${name} 必须是正整数。`);
  }
  return number;
}
```

- [ ] **Step 4: Run parser tests**

Run:

```powershell
node --test tests/task-contract.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the contract module**

```powershell
git add src/core/task-contract.mjs tests/task-contract.test.mjs
git commit -m "feat(queue): define single-chapter task contracts"
```

### Task 2: Upgrade The Queue To Schema V3

**Files:**
- Modify: `src/core/task-queue.mjs`
- Modify: `tests/task-queue.test.mjs`
- Modify: `tests/schema-migration.test.mjs`

- [ ] **Step 1: Add failing persistence and migration tests**

Add tests asserting:

```js
test("enqueue persists the supplied task contract", async () => {
  const { projectRoot, queue } = await makeQueue();
  const contract = {
    version: 1, kind: "write_chapter", chapter_start: 1, chapter_end: 1,
    stop_policy: "immediate", resume_policy: "checkpoint", skip_policy: "reject"
  };
  const task = await queue.enqueue("写第1章", { mode: "write", contract });
  assert.deepEqual(task.contract, contract);
  const raw = JSON.parse(await fs.readFile(path.join(projectRoot, "task_queue.json"), "utf8"));
  assert.equal(raw.schema_version, 3);
  assert.deepEqual(raw.tasks[0].contract, contract);
});

test("markCancelling is idempotent and keeps the task non-terminal", async () => {
  const { queue } = await makeQueue();
  const task = await queue.enqueue("写第1章", {
    contract: makeChapterContract(1)
  });
  await queue.promoteNext();
  const first = await queue.markCancelling(task.id, "用户停止");
  const second = await queue.markCancelling(task.id, "用户停止");
  assert.equal(first.status, "cancelling");
  assert.equal(second.status, "cancelling");
  assert.equal(second.completedAt, null);
});
```

In `tests/schema-migration.test.mjs`, add a v2 fixture and assert:

```js
assert.equal(state.schema_version, 3);
assert.equal(state.tasks[0].contract.kind, "write_chapter");
assert.equal(state.tasks[0].contract.chapter_start, 2);
```

For an ambiguous queued legacy instruction, assert:

```js
assert.equal(state.tasks[0].status, "blocked");
assert.equal(state.tasks[0].error, "legacy_task_contract_unresolved");
```

- [ ] **Step 2: Run queue tests and observe schema mismatch**

Run:

```powershell
node --test tests/task-queue.test.mjs tests/schema-migration.test.mjs
```

Expected: FAIL because schema is still `2`, `contract` is discarded, and `markCancelling` does not exist.

- [ ] **Step 3: Implement schema v3 and migration**

Make these changes:

```js
import { compileWritingTasks, makeResumeContract } from "./task-contract.mjs";

export const TASK_QUEUE_SCHEMA_VERSION = 3;
const TERMINAL_STATUSES = new Set(["completed", "interrupted", "cancelled", "blocked"]);
const ACTIVE_STATUSES = new Set(["running", "cancelling"]);
```

Change `enqueue` to accept and persist `contract`:

```js
async enqueue(instruction, { mode = "auto", contract } = {}) {
  return this.withLock(async () => {
    await this.load();
    const now = timestamp();
    const task = {
      id: `task-${randomUUID()}`,
      index: nextIndex(this.state.tasks),
      instruction,
      contract: clone(contract),
      mode,
      status: "queued",
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      error: null,
      stages: [],
      currentStage: null,
      heartbeatAt: null
    };
    this.state.tasks.push(task);
    await this.save();
    return clone(task);
  });
}
```

Add:

```js
async markCancelling(taskId, reason = "用户停止") {
  return this.withLock(async () => {
    await this.load();
    const task = this.findTask(taskId);
    if (!task || !ACTIVE_STATUSES.has(task.status)) return null;
    if (task.status !== "cancelling") {
      task.status = "cancelling";
      task.error = reason;
      task.updatedAt = timestamp();
      await this.save();
    }
    return clone(task);
  });
}
```

Allow `abortRunning` to finish both `running` and `cancelling`. Treat `cancelling` as active in `promoteNext`, `retry`, and `createRecoveryTask`.

During `normalizeTask`, preserve valid contracts. For legacy tasks:

- `source === "project_state_recovery"` or terminal `cancelled/interrupted`: use `makeResumeContract(recovery.chapterNo)`.
- exact `写第N章` or `续写第N章`: compile with `currentChapter: N` and a target not lower than N.
- ambiguous queued legacy task: set `status: "blocked"` and `error: "legacy_task_contract_unresolved"`.
- ambiguous running task: bind to `recovery.chapterNo` when present; otherwise preserve as blocked for explicit recovery.

After `load`, if the input schema is below v3, atomically save the normalized state once.

- [ ] **Step 4: Run queue and migration tests**

Run:

```powershell
node --test tests/task-queue.test.mjs tests/schema-migration.test.mjs
```

Expected: PASS; persisted queue has `schema_version: 3`.

- [ ] **Step 5: Commit the queue migration**

```powershell
git add src/core/task-queue.mjs tests/task-queue.test.mjs tests/schema-migration.test.mjs
git commit -m "feat(queue): persist task contracts in schema v3"
```

### Task 3: Compile And Validate Contracts At The API Boundary

**Files:**
- Modify: `src/core/app-server.mjs`
- Modify: `tests/app-server-probe.test.mjs`

- [ ] **Step 1: Write failing command-boundary tests**

Add integration tests:

```js
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
```

- [ ] **Step 2: Run the API tests**

Run:

```powershell
node --test tests/app-server-probe.test.mjs
```

Expected: new tests FAIL because `expandInstruction` returns strings and runner receives no contract.

- [ ] **Step 3: Replace string expansion with contract compilation**

In `app-server.mjs`:

```js
import {
  TaskContractError,
  compileWritingTasks,
  makeResumeContract,
  validateTaskContract
} from "./task-contract.mjs";
```

Replace command expansion:

```js
const explicitScope = /第\d+章|(?:\d+|[一二三四五六七八九十])章|到第\d+章/u.test(message);
const hasPendingWritingTask = queue.getState().tasks.some((candidate) =>
  ["queued", "running", "cancelling"].includes(candidate.status) &&
  ["write_chapter", "resume_chapter"].includes(candidate.contract?.kind)
);
if (!explicitScope && hasPendingWritingTask) {
  throw new TaskContractError(
    "ambiguous_task_scope",
    "已有写作任务，请明确指定章节。"
  );
}

const plannedTasks = compileWritingTasks(message, {
  currentChapter: state.current_chapter_no ?? 1,
  targetChapters: project.target_chapters
});
const tasks = [];
for (const planned of plannedTasks) {
  tasks.push(await queue.enqueue(planned.instruction, {
    mode,
    contract: planned.contract
  }));
}
```

Before `startProjectRun` writes `runningState`, validate:

```js
validateTaskContract(task.contract, {
  currentChapter: state.current_chapter_no,
  targetChapters: project.target_chapters
});
```

Pass the contract to the runner:

```js
job.promise = runner(projectRoot, {
  model: context.testModel ?? undefined,
  signal: controller.signal,
  taskId: task.id,
  contract: task.contract,
  onHeartbeat: ...
});
```

For project-state recovery:

```js
contract: makeResumeContract(stateForRecovery.current_chapter_no)
```

Map `TaskContractError` through `HttpError(400, error.code, error.message)`. Append `task_contract_created` only after successful enqueue and `task_contract_rejected` on validation rejection.

- [ ] **Step 4: Run command and queue integration tests**

Run:

```powershell
node --test tests/app-server-probe.test.mjs tests/task-queue.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the API contract boundary**

```powershell
git add src/core/app-server.mjs tests/app-server-probe.test.mjs
git commit -m "feat(server): enforce chapter contracts before runs"
```

### Task 4: End The Engine At The Task Boundary

**Files:**
- Modify: `src/core/agent-engine.mjs`
- Modify: `src/core/project-store.mjs`
- Modify: `tests/agent-engine.test.mjs`

- [ ] **Step 1: Write failing engine-boundary tests**

Add:

```js
test("单章契约完成后不调用第2章模型", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-single-chapter-"));
  const { projectRoot } = await createProject(root, {
    slug: "project", target_chapters: 3, min_words_per_chapter: 20, target_words_per_chapter: 24
  });
  const modelClient = new CapturingModelClient();
  const result = await runProject(projectRoot, {
    taskId: "task-1",
    contract: makeChapterContract(1),
    modelClient
  });
  assert.equal(result.task_completed, true);
  assert.equal(result.project_completed, false);
  assert.deepEqual(result.completed_chapters, [1]);
  assert.ok(modelClient.metadatas.every((item) => item.chapterNo === 1));
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "idle");
  assert.equal(state.current_chapter_no, 2);
  assert.equal(state.current_stage, "queued");
});

test("末章任务同时完成项目", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-last-chapter-"));
  const { projectRoot } = await createProject(root, {
    slug: "project", target_chapters: 1, min_words_per_chapter: 20, target_words_per_chapter: 24
  });
  const result = await runProject(projectRoot, {
    taskId: "task-1",
    contract: makeChapterContract(1)
  });
  assert.equal(result.project_completed, true);
  assert.equal((await loadState(projectRoot)).project_status, "completed");
});
```

- [ ] **Step 2: Run the engine tests**

Run:

```powershell
node --test tests/agent-engine.test.mjs
```

Expected: first test FAIL because the engine continues until `project.target_chapters`.

- [ ] **Step 3: Implement task-level completion**

At `runProject` startup:

```js
const taskId = options.taskId ?? null;
const contract = validateTaskContract(options.contract, {
  currentChapter: state.current_chapter_no,
  targetChapters: project.target_chapters
});
```

In the `summarizing` case:

```js
await extractChapterMemory(projectRoot, project, state, runtime);
const completion = await completeChapter(projectRoot, project, state, {
  taskId,
  contract
});
if (completion.taskCompleted) {
  return {
    outcome: "completed",
    task_completed: true,
    project_completed: completion.projectCompleted,
    completed_chapters: [completion.chapterNo],
    projectRoot
  };
}
break;
```

Change `completeChapter` to set independent project and task outcomes:

```js
async function completeChapter(projectRoot, project, state, execution) {
  const chapterNo = state.current_chapter_no;
  const nextChapter = chapterNo + 1;
  const projectCompleted = nextChapter > project.target_chapters;
  const taskCompleted = chapterNo >= execution.contract.chapter_end;
  const next = setStage({
    ...state,
    project_status: projectCompleted ? "completed" : (taskCompleted ? "idle" : "running"),
    current_chapter_no: nextChapter,
    current_segment_no: 0
  }, projectCompleted ? "completed" : "queued");
  await upsertChapter(projectRoot, { chapter_no: chapterNo, status: "completed" });
  await appendEvent(projectRoot, {
    type: "chapter_completed",
    project_id: project.project_id,
    chapter_no: chapterNo,
    stage: "completed",
    message: "chapter completed",
    data: { task_id: execution.taskId }
  });
  await saveState(projectRoot, next);
  await writeCheckpoint(projectRoot, checkpointPayload(
    project, state, next, [], [], null,
    { task_id: execution.taskId, task_contract: execution.contract }
  ));
  return { chapterNo, taskCompleted, projectCompleted };
}
```

Update every `checkpointPayload` call through runtime defaults so the payload records the real task ID and contract. In `project-store.mjs`, persist:

```js
task_contract: payload.task_contract ?? null,
```

- [ ] **Step 4: Run engine and server tests**

Run:

```powershell
node --test tests/agent-engine.test.mjs tests/app-server-probe.test.mjs
```

Expected: PASS; existing multi-chapter tests must explicitly call `runProject` once per chapter contract or use a test helper that queues contracts.

- [ ] **Step 5: Commit task-boundary execution**

```powershell
git add src/core/agent-engine.mjs src/core/project-store.mjs tests/agent-engine.test.mjs tests/app-server-probe.test.mjs
git commit -m "fix(engine): stop runs at the single-chapter boundary"
```

### Task 5: Centralize Cancellation And Propagate The Signal

**Files:**
- Create: `src/core/cancellation.mjs`
- Modify: `src/core/agent-engine.mjs`
- Modify: `src/core/app-server.mjs`
- Modify: `tests/agent-engine.test.mjs`
- Modify: `tests/model-client-retry.test.mjs`

- [ ] **Step 1: Write failing cancellation propagation tests**

Update the `agent-engine.mjs` test import to include
`extractChapterMemory` and `runFactCheck`, then add:

```js
test("fact-check abort escapes instead of degrading to skipped", async () => {
  const { projectRoot, project } = await makeFactCheckProject("wwriting-fc-abort-");
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const runtime = {
    signal: controller.signal,
    modelClient: {
      generate: async ({ signal }) => {
        started.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
    }
  };
  const promise = runFactCheck(projectRoot, project, { current_chapter_no: 1 }, runtime, "draft");
  await started.promise;
  controller.abort("用户停止");
  await assert.rejects(promise, (error) => error.name === "ProjectCancelledError");
});

test("memory extraction abort does not advance watermark", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-memory-abort-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 10,
    target_words_per_chapter: 12,
    active_model: {
      provider: "openai-compatible",
      model_name: "fake-model",
      base_url: "http://127.0.0.1:1/v1",
      api_key_env: "FAKE_KEY"
    }
  });
  const project = await loadProject(projectRoot);
  const finalPath = path.join(projectRoot, "chapters", "001.md");
  await fs.writeFile(finalPath, "# 第一章\n\n雨落在旧信封上。", "utf8");
  await upsertChapter(projectRoot, {
    chapter_no: 1,
    status: "summarizing",
    final_path: finalPath
  });

  const controller = new AbortController();
  const started = Promise.withResolvers();
  const promise = extractChapterMemory(
    projectRoot,
    project,
    { current_chapter_no: 1 },
    {
      signal: controller.signal,
      modelClient: {
        generate: async ({ signal }) => {
          started.resolve();
          await new Promise((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true }
            );
          });
        }
      }
    }
  );

  await started.promise;
  controller.abort("用户停止");
  await assert.rejects(
    promise,
    (error) => error.name === "ProjectCancelledError"
  );
  assert.equal(
    (await loadContinuityState(projectRoot)).last_extracted_chapter ?? 0,
    0
  );
});
```

In `tests/model-client-retry.test.mjs`, add:

```js
test("adapter AbortError after external abort is never retried", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  let calls = 0;
  const adapter = {
    async generate({ signal }) {
      calls += 1;
      started.resolve();
      await new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    }
  };
  const client = makeClient(adapter, { retryMax: 3 });
  const pending = client.generate({
    prompt: "hi",
    signal: controller.signal
  });

  await started.promise;
  controller.abort("用户停止");

  await assert.rejects(
    pending,
    (error) => error.name === "AbortError"
  );
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run cancellation tests**

Run:

```powershell
node --test tests/agent-engine.test.mjs tests/model-client-retry.test.mjs
```

Expected: FAIL because fact-check and memory extraction swallow cancellation.

- [ ] **Step 3: Implement the shared cancellation module**

Create:

```js
export class ProjectCancelledError extends Error {
  constructor(reason = "cancelled") {
    super(String(reason || "cancelled"));
    this.name = "ProjectCancelledError";
    this.reason = String(reason || "cancelled");
  }
}

export function isCancellationError(error, signal) {
  return Boolean(
    signal?.aborted ||
    error instanceof ProjectCancelledError ||
    error?.name === "AbortError"
  );
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new ProjectCancelledError(signal.reason ?? "cancelled");
  }
}

export function rethrowIfCancelled(error, signal) {
  if (isCancellationError(error, signal)) {
    throw new ProjectCancelledError(signal?.reason ?? error?.message ?? "cancelled");
  }
}
```

Move `ProjectCancelledError` imports in `agent-engine.mjs` and `app-server.mjs` to this module.

Store `signal` in runtime:

```js
return {
  modelClient,
  signal: options.signal,
  taskId: options.taskId,
  contract: options.contract,
  ...
};
```

Pass `signal: runtime.signal` to fact-check and memory extraction model calls. At each catch that currently degrades:

```js
catch (error) {
  rethrowIfCancelled(error, runtime.signal);
  // existing non-fatal handling
}
```

Add `throwIfAborted(runtime.signal)`:

- before and after post-process hooks,
- before final file write,
- before each fact-check attempt,
- before each memory extraction attempt,
- before consuming another model-call budget.

- [ ] **Step 4: Run cancellation tests**

Run:

```powershell
node --test tests/agent-engine.test.mjs tests/model-client-retry.test.mjs tests/model-gateway.test.mjs
```

Expected: PASS; cancellation produces `ProjectCancelledError` and no retry.

- [ ] **Step 5: Commit cancellation propagation**

```powershell
git add src/core/cancellation.mjs src/core/agent-engine.mjs src/core/app-server.mjs tests/agent-engine.test.mjs tests/model-client-retry.test.mjs
git commit -m "fix(engine): propagate immediate cancellation through model stages"
```

### Task 6: Persist Cancelling Before Aborting

**Files:**
- Modify: `src/core/app-server.mjs`
- Modify: `src/core/retry-candidates.mjs`
- Modify: `tests/app-server-probe.test.mjs`

- [ ] **Step 1: Write failing stop-state tests**

Add:

```js
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
```

- [ ] **Step 2: Run stop tests**

Run:

```powershell
node --test tests/app-server-probe.test.mjs
```

Expected: FAIL because stop only aborts and returns a generic message.

- [ ] **Step 3: Implement the two-phase stop**

The stop route must not use `withProjectLock`; otherwise finalization or error convergence can delay acknowledgement.

Implement:

```js
async function serveRunStop(response, context) {
  try {
    const projectRoot = await resolveActiveProjectRoot(context);
    await assertNotArchived(projectRoot);
    const job = context.runJobs.get(path.resolve(projectRoot));
    if (!isJobRunning(job) && job?.status !== "cancelling") {
      sendError(response, new HttpError(409, "CONFLICT", "当前没有正在运行的写作任务。"));
      return;
    }
    const queue = await context.getTaskQueue(projectRoot);
    const state = await loadState(projectRoot);
    const requestedAt = state.stop_requested_at ?? new Date().toISOString();
    if (state.project_status !== "cancelling") {
      await saveState(projectRoot, {
        ...state,
        project_status: "cancelling",
        stop_requested_at: requestedAt
      });
      await queue.markCancelling(job.taskId, "用户停止");
      await appendEvent(projectRoot, {
        type: "project_cancelling",
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        message: "用户请求立即停止",
        data: { task_id: job.taskId, stop_requested_at: requestedAt }
      });
    }
    job.status = "cancelling";
    if (!job.controller.signal.aborted) job.controller.abort("用户停止");
    await serveJson(response, {
      ok: true,
      projectRoot,
      taskId: job.taskId,
      status: "cancelling",
      message: "正在停止当前任务，草稿将保留。"
    });
  } catch (error) {
    sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
  }
}
```

In the run catch, compute and persist:

```js
const cancelledAt = new Date().toISOString();
const stopLatencyMs = Math.max(0, Date.parse(cancelledAt) - Date.parse(latestState.stop_requested_at ?? cancelledAt));
```

Persist `cancel_observed_at`, `cancelled_at`, and `stop_latency_ms`. Finish the queue task with `abortRunning`.

Update retry candidate logic so `cancelling` is unavailable for retry and reports “正在停止，请等待状态收敛”。

- [ ] **Step 4: Run stop and retry tests**

Run:

```powershell
node --test tests/app-server-probe.test.mjs tests/retry-candidates.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the cancelling state**

```powershell
git add src/core/app-server.mjs src/core/retry-candidates.mjs tests/app-server-probe.test.mjs tests/retry-candidates.test.mjs
git commit -m "feat(run): expose immediate cancelling state"
```

### Task 7: Make Checkpoints And Finalization Resume-Safe

**Files:**
- Modify: `src/core/project-store.mjs`
- Modify: `src/core/agent-engine.mjs`
- Modify: `src/core/tool-runtime.mjs`
- Modify: `tests/agent-engine.test.mjs`
- Modify: `tests/tool-runtime.test.mjs`

- [ ] **Step 1: Write failing resume and finalization tests**

Update imports so `tests/agent-engine.test.mjs` imports `makeResumeContract` from
`task-contract.mjs`, and `tests/tool-runtime.test.mjs` imports
`finalizeChapterFile`. Add the first two tests below to
`tests/agent-engine.test.mjs` and the third to `tests/tool-runtime.test.mjs`:

```js
test("fact-check 检查点恢复不重新生成正文", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-review-resume-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 10,
    target_words_per_chapter: 12
  });
  await appendChapterSegment(projectRoot, project, {
    chapter_no: 1,
    segment_no: 1,
    content: "# 第一章 雨夜来信\n\n雨声压住脚步，沈泽拆开旧信，发现失踪者留下的地址。"
  });
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "cancelled",
    current_stage: "reviewing",
    current_segment_no: 1
  });
  const modelClient = new CapturingModelClient();

  await runProject(projectRoot, {
    taskId: "resume-review-1",
    contract: makeResumeContract(1),
    modelClient
  });

  assert.equal(
    modelClient.metadatas.some(
      (metadata) => metadata.toolRequest?.kind === "draft_segment"
    ),
    false
  );
  const final = await fs.readFile(
    path.join(projectRoot, "chapters", "001.md"),
    "utf8"
  );
  assert.match(final, /失踪者留下的地址/u);
});

test("已提交最终文件的恢复只修复索引不重复写入", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-final-resume-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 10,
    target_words_per_chapter: 12
  });
  await appendChapterSegment(projectRoot, project, {
    chapter_no: 1,
    segment_no: 1,
    content: "# 第一章 雨夜来信\n\n雨声压住脚步，沈泽拆开旧信，发现失踪者留下的地址。"
  });
  const draftPath = path.join(projectRoot, "drafts", "001.draft.md");
  const finalPath = path.join(projectRoot, "chapters", "001.md");
  await fs.copyFile(draftPath, finalPath);
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "cancelled",
    current_stage: "finalizing",
    current_segment_no: 1
  });
  await upsertChapter(projectRoot, {
    chapter_no: 1,
    status: "finalizing",
    draft_path: draftPath,
    final_path: finalPath,
    checksum: null
  });
  const before = await fs.stat(finalPath);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runProject(projectRoot, {
    taskId: "resume-1",
    contract: makeResumeContract(1),
    modelClient: new CapturingModelClient()
  });
  const after = await fs.stat(finalPath);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const chapter = (await loadChapterIndex(projectRoot)).chapters[0];
  assert.equal(chapter.status, "completed");
  assert.ok(chapter.checksum);
});

test("finalizeChapterFile respects a pre-aborted signal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-final-abort-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 10,
    target_words_per_chapter: 12
  });
  await appendChapterSegment(projectRoot, project, {
    chapter_no: 1,
    segment_no: 1,
    content: "# 第一章\n\n雨声压住脚步，沈泽拆开了旧信。"
  });
  const controller = new AbortController();
  controller.abort("用户停止");
  await assert.rejects(
    () => finalizeChapterFile(projectRoot, project, 1, { signal: controller.signal }),
    (error) => error.name === "ProjectCancelledError"
  );
  await assert.rejects(
    () => fs.stat(path.join(projectRoot, "chapters", "001.md")),
    (error) => error.code === "ENOENT"
  );
});
```

- [ ] **Step 2: Run resume tests**

Run:

```powershell
node --test tests/agent-engine.test.mjs tests/tool-runtime.test.mjs
```

Expected: FAIL because finalization has no signal or committed-artifact recovery.

- [ ] **Step 3: Implement safe resume**

Extend checkpoints:

```js
task_contract: payload.task_contract ?? null,
committed_model_calls: payload.committed_model_calls ?? [],
artifact_commit: payload.artifact_commit ?? null,
```

In `tool-runtime.mjs`, accept options:

```js
export async function finalizeChapterFile(projectRoot, project, chapterNo, { signal } = {}) {
  throwIfAborted(signal);
  const draftPath = safeJoin(...);
  const finalPath = safeJoin(...);
  if (await pathExists(finalPath)) {
    const existing = await fs.readFile(finalPath, "utf8");
    return {
      ok: true,
      duplicate: true,
      path: finalPath,
      draft_path: draftPath,
      bytes_written: 0,
      actual_words: countEffectiveWords(existing),
      checksum: sha256(existing)
    };
  }
  const content = await fs.readFile(draftPath, "utf8");
  throwIfAborted(signal);
  const written = await writeFileAtomic(finalPath, content);
  return {
    ok: true,
    duplicate: false,
    path: finalPath,
    draft_path: draftPath,
    bytes_written: written.bytes_written,
    actual_words: countEffectiveWords(content),
    checksum: written.checksum
  };
}
```

In `finalizeChapter`, perform no cancellation check between successful atomic rename and index/checkpoint persistence. If a final file already exists, verify its checksum, repair the index, and continue at `summarizing`.

When resuming:

- use persisted `current_stage`;
- do not reset `current_segment_no`;
- if stage is `reviewing`, skip drafting;
- if final file exists and matches draft checksum, move directly to `summarizing`;
- if memory watermark already covers the chapter, complete it without another model call.

- [ ] **Step 4: Run focused and full core tests**

Run:

```powershell
node --test tests/tool-runtime.test.mjs tests/agent-engine.test.mjs tests/task-queue.test.mjs tests/app-server-probe.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit resume safety**

```powershell
git add src/core/project-store.mjs src/core/agent-engine.mjs src/core/tool-runtime.mjs tests/agent-engine.test.mjs tests/tool-runtime.test.mjs
git commit -m "fix(resume): make chapter checkpoints and finalization idempotent"
```

### Task 8: Verify The Execution Core

**Files:**
- No product file changes expected.

- [ ] **Step 1: Run all execution-core tests**

```powershell
node --test tests/task-contract.test.mjs tests/task-queue.test.mjs tests/schema-migration.test.mjs tests/agent-engine.test.mjs tests/model-client-retry.test.mjs tests/model-gateway.test.mjs tests/tool-runtime.test.mjs tests/app-server-probe.test.mjs tests/retry-candidates.test.mjs
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run the complete automated suite**

```powershell
npm test
```

Expected: exit code `0`.

- [ ] **Step 3: Run engine-level verification scripts**

```powershell
npm run verify:mvp
npm run verify:longrun
npm run verify:faults
```

Expected: each command exits `0`. Update verification fixtures only when their previous assumption was “one run writes the whole project”; preserve all quality and durability assertions.

- [ ] **Step 4: Inspect the final diff**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only execution-core files are changed.

- [ ] **Step 5: Commit verification fixture updates if needed**

```powershell
git add scripts/verify-mvp.mjs scripts/verify-longrun.mjs scripts/verify-fault-injection.mjs
git commit -m "test(run): align verification with single-chapter tasks"
```

Skip this commit when the verification scripts required no edits.
