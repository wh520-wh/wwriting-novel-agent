# UX Agent Status Truthfulness + Task Queue Plan

> Required execution skill: `subagent-driven-development`.

## Goal

Eliminate false "agent running" UI states and add a Codex-style task queue for WWriting. The app must truthfully show whether an agent process is alive, allow retry from interrupted work, allow stopping the current task, queue multiple instructions without leaking future instructions into the active run, and restore task/history context after refresh or restart.

## Current Code Constraints

- The workspace is not a Git repository. Do not include commit steps as task requirements.
- Runtime is Node.js 24+, ESM, vanilla browser JS, `node --test`.
- `createAppShellServer` currently does not accept `testModel`; plan tasks that need deterministic server tests must add explicit test hooks.
- `runJobs` currently stores a bare Promise and deletes it in `finally`; this must become a structured job object.
- The app has no `src/main.mjs`; local app verification uses the existing package scripts.
- The front end is event/dashboard driven. New UI logic must fit `src/app-shell/app.js`, `styles.css`, and `index.html` without introducing WebSocket/SSE.

## Non-Negotiable Semantics

1. **Queue isolation:** submitting a command only writes it to `task_queue.json`. The app must append `user_instruction_received` only when a queued task is promoted to `running`. Future queued tasks must not appear in the active run's event context.
2. **Truthful liveness:** dashboard truth uses both persisted state and in-memory `runJobs`. `agent_alive=false` plus persisted `project_status=running` is treated as interrupted/stale, not running.
3. **Retry:** retry starts from the persisted current chapter/stage/task state and must not clear already written drafts or completed chapters.
4. **Stop:** stopping an active task uses `AbortController`, records `cancelled`, preserves drafts, ends the running job, and leaves queued tasks intact.
5. **Persistence:** task cards and conversation history are reconstructed from `task_queue.json` plus existing events/run log after refresh/restart.

## Omission Repair Checklist

The following review omissions are in scope for this plan and must have code plus test or verifier evidence:

1. **Per-project queue serialization:** one project root maps to one `TaskQueue` instance during concurrent requests; queue mutations serialize through the queue lock; concurrent submits must produce exactly one running task and leave later tasks queued.
2. **Shutdown lifecycle:** `server.close()` and Electron quit paths must abort active jobs through their `AbortController`; the active queue task becomes `cancelled` and later queued tasks remain queued.
3. **Error classification:** classify `cancelled`, `interrupted`, and `blocked` distinctly in project state, queue tasks, and UI. Provider configuration/blocking failures must not be retried as ordinary interruptions.
4. **Retry selection rule:** when no `taskId` is provided, retry a stale running task before terminal queue candidates; otherwise retry exactly one unambiguous interrupted/cancelled candidate or return 400 asking for `taskId`.
5. **AbortSignal passthrough:** pass the same `AbortSignal` from app server to `runProject`, from engine to `ModelClient`, and from OpenAI-compatible adapters into `fetch`.
6. **Completed/blocked command audit:** commands submitted to completed or blocked projects must not enter the queue, and must append skipped `user_instruction_received` plus `project_run_skipped` audit events.
7. **Frontend response parsing:** browser helpers must handle empty 2xx bodies and non-JSON error bodies deterministically instead of surfacing raw JSON parse failures.
8. **Static DOM selector verification:** topbar `#topbar-stop`, `#topbar-retry`, and `#topbar-progress` must exist in static HTML; JS must bind to existing nodes rather than silently creating missing required controls.
9. **Desktop titlebar clearance:** the Electron/native window control area in the top-right corner must be reserved in topbar layout so privacy/status/retry/stop buttons never sit under minimize/maximize/close controls.

## Task 1: Agent Heartbeat, Interrupt, and Abort

**Files:** `src/core/agent-engine.mjs`, `tests/agent-engine.test.mjs`

- Add failing tests first:
  - `runProject` calls `onHeartbeat` on each main-loop step and persists `state.last_heartbeat`.
  - unexpected model/runtime errors set `project_status="interrupted"`, `interrupted_reason`, `interrupted_at`, and append `project_interrupted`.
  - an `AbortSignal` abort sets `project_status="cancelled"`, `cancelled_reason`, `cancelled_at`, preserves draft files, and throws/returns a distinguishable cancellation result.
- Implement:
  - `options.onHeartbeat({ step, stage, chapter })`.
  - `options.signal` checks before each step and before/after model calls where practical.
  - a top-level `try/catch` around the main loop. `ProjectBlockedError` keeps blocked semantics; `SimulatedInterrupt` keeps existing test behavior; non-blocking unexpected errors become interrupted; abort becomes cancelled.
- Verify:
  - `node --test tests/agent-engine.test.mjs --test-name-pattern "heartbeat|interrupted|abort|cancel"`
  - `node --test tests/agent-engine.test.mjs`

## Task 2: Structured Run Jobs and Dashboard Probe

**Files:** `src/core/app-server.mjs`, `src/core/app-dashboard.mjs`, `tests/app-server-probe.test.mjs`

- Add test hooks to `createAppShellServer`:
  - `testModel` passed into `runProject`.
  - optional `testRunProject` for endpoint tests that should not run the full engine.
- Convert `runJobs` values to:
  ```js
  {
    promise,
    controller,
    startedAt,
    lastHeartbeat,
    status: "running" | "done" | "error" | "cancelled",
    error,
    taskId
  }
  ```
- `runJobs` may retain the last non-running job for dashboard diagnostics until another job supersedes it. A job is active only when `job.status === "running"`. All already-running, retry, stop, and auto-advance checks must use that predicate, not mere key existence.
- Inject dashboard probe fields when a project is selected:
  - `agent_alive`
  - `agent_started_at`
  - `agent_last_heartbeat`
  - `agent_error`
  - `agent_task_id`
- Tests:
  - no job returns `agent_alive=false`, timestamps null, error null.
  - active job returns `agent_alive=true` and heartbeat timestamps.
  - errored/cancelled job returns `agent_alive=false` and error/status details until superseded.
- Verify:
  - `node --test tests/app-server-probe.test.mjs --test-name-pattern "dashboard|agent_alive"`

## Task 3: TaskQueue Persistence and Correct Async API

**Files:** `src/core/task-queue.mjs`, `tests/task-queue.test.mjs`

- Implement `TaskQueue` with an async API. Every method that reads/writes disk is awaited:
  - `await queue.load()`
  - `await queue.enqueue(instruction, { mode })`
  - `await queue.promoteNext()`
  - `await queue.complete(taskId, result)`
  - `await queue.interrupt(taskId, error)`
  - `await queue.cancel(taskId, reason)`
  - `await queue.abortRunning(reason)`
  - `queue.getState()`
- Persist to `task_queue.json` under the project root.
- Task shape:
  ```js
  {
    id,
    index,
    instruction,
    mode,
    status: "queued" | "running" | "completed" | "interrupted" | "cancelled" | "blocked",
    createdAt,
    startedAt,
    completedAt,
    updatedAt,
    error,
    stages,
    currentStage,
    heartbeatAt
  }
  ```
- Tests:
  - enqueue persists stable order/index.
  - `promoteNext` promotes exactly one queued task and never skips.
  - `promoteNext` returns null when another task is already running.
  - cancel only cancels queued tasks.
  - interrupt/complete update running tasks.
  - blocked tasks are terminal and not retryable.
  - reload restores state.
- Verify:
  - `node --test tests/task-queue.test.mjs`

## Task 4: Queue-Safe Command Submit and Auto Advance

**Files:** `src/core/app-server.mjs`, `tests/app-server-probe.test.mjs`

- Change `/api/commands/submit`:
  - validate message/mode.
  - expand command if needed after Task 8 is available; until then enqueue one instruction.
  - enqueue task(s) only.
  - if no job is running, promote the next queued task and start it.
  - do not append `user_instruction_received` for tasks that remain queued.
- Change `startProjectRun`:
  - accept the promoted task.
  - append `user_instruction_received` only for that task.
  - pass `taskId`, `signal`, `testModel`, and `onHeartbeat` into `runProject`.
  - on completion, mark task completed and promote/start the next queued task.
  - on unexpected error, mark task interrupted and leave later queued tasks untouched.
  - on cancellation, mark task cancelled and leave later queued tasks untouched.
- Tests:
  - submitting three commands creates three queue items.
  - concurrent submits create one running task and leave the rest queued.
  - only the first running task has a `user_instruction_received` event.
  - after first task completion, the second task is promoted and its event is appended then.
  - no future queued instruction appears in events before promotion.
- Verify:
  - `node --test tests/app-server-probe.test.mjs --test-name-pattern "queue|submit|auto"`

## Task 5: Retry and Stop Endpoints

**Files:** `src/core/app-server.mjs`, `tests/app-server-probe.test.mjs`

- Add `POST /api/run/retry`:
  - Request body: `{ taskId?: string }`.
  - With `taskId`, retry that interrupted/cancelled queue task only if no job is currently running.
  - Without `taskId`, retry the active project-level interrupted/stale run, or the most recent interrupted running task when there is exactly one unambiguous candidate.
  - If multiple interrupted/cancelled tasks exist and no `taskId` is provided, return 400 with a message asking the caller to provide `taskId`.
  - returns 409 if a job is currently running.
  - accepts only `interrupted`, stale `running` with no live job, or interrupted queue task.
  - clears interrupted fields only after the retry job is accepted.
  - promotes/re-runs the interrupted task without duplicating completed queue items.
- Add `POST /api/run/stop`:
  - returns 409/400 when no job is running.
  - aborts the active job via its controller.
  - persists cancelled task and cancelled project state.
- Tests:
  - retry while running returns 409.
  - retry from interrupted state starts a new job and preserves current chapter/stage/drafts.
  - retry with `taskId` retries the selected interrupted/cancelled task.
  - retry without `taskId` returns 400 when multiple interrupted/cancelled task candidates exist.
  - stale persisted `running` with no live job is retryable and shown as interrupted to dashboard/UI.
  - stop aborts the active job, sets cancelled, and leaves queued tasks queued.
  - server close aborts the active job and cancels only its running queue task.
- Verify:
  - `node --test tests/app-server-probe.test.mjs --test-name-pattern "retry|stop|cancel"`

## Task 6: Queue State API

**Files:** `src/core/app-server.mjs`, `tests/app-server-probe.test.mjs`

- Add `GET /api/queue/state`.
- Add `POST /api/queue/cancel`.
- Response must include queue snapshot plus running task id and counts:
  ```js
  { ok: true, tasks, runningTaskId, queuedCount, completedCount }
  ```
- Tests:
  - state returns persisted tasks after reload.
  - cancel queued task succeeds.
  - cancel running task fails and tells caller to use stop.
- Verify:
  - `node --test tests/app-server-probe.test.mjs --test-name-pattern "queue/state|queue/cancel"`

## Task 7: Stage Progress Persistence

**Files:** `src/core/agent-engine.mjs`, `src/core/app-server.mjs`, `src/core/task-queue.mjs`, tests as needed

- Update the active queue task on heartbeat/stage changes:
  - `currentStage`
  - `heartbeatAt`
  - `stages[]` entries for stage status and timestamps
  - optional `progressText` for chapter/draft progress when available
- Ensure completed/interrupted/cancelled tasks keep their last stage state for restart recovery.
- Tests:
  - running task receives stage updates.
  - completed task retains stage history after reload.
  - interrupted task shows the stage where it stopped.

## Task 8: Instruction Expansion

**Files:** `src/core/task-queue.mjs`, `src/core/app-server.mjs`, `tests/task-queue.test.mjs`, `tests/app-server-probe.test.mjs`

- Export `expandInstruction(instruction, { currentChapter })`.
- Support at least:
  - exact UTF-8 input `写到第8章`
  - exact UTF-8 input `续写到第8章`
  - exact UTF-8 input `写完到第8章`
  - exact UTF-8 input `一直写到第8章`
  - exact UTF-8 inputs `写3章` and `续写3章`
- Precise instructions such as `写第4章，加入新角色林夕` stay as a single task.
- `/api/commands/submit` enqueues all expanded tasks.
- Tests cover Chinese digits only if implemented; otherwise document Arabic numeral support and add no misleading examples.
- Verify:
  - `node --test tests/task-queue.test.mjs --test-name-pattern "expandInstruction"`
  - `node --test tests/app-server-probe.test.mjs --test-name-pattern "expand"`

## Task 9: Frontend Truth Matrix, Retry, and Stop Controls

**Files:** `src/app-shell/app.js`, `src/app-shell/styles.css`, `src/app-shell/index.html`

- Implement `computeAgentTruth(data, now = Date.now())` as a pure exported/testable browser helper or attach it for tests.
- Cover matrix:
  - alive/running heartbeat <30s: running
  - alive/running heartbeat 30-60s: slow
  - alive/running heartbeat >60s: stale with retry/stop affordance
  - not alive + persisted running: interrupted with retry
  - not alive + interrupted: interrupted with retry and reason
  - not alive + cancelled: cancelled with retry
  - blocked: blocked
  - completed: completed
  - idle/no project: idle
- Render topbar retry/stop buttons from the truth result.
- Keep retry/stop buttons present in static HTML and bind them in place.
- Retry calls `/api/run/retry`; stop calls `/api/run/stop`.
- Add status styles for `interrupted`, `stale`, `slow`, `cancelled`, `blocked`, `completed`.
- Tests or scripted verification should exercise the pure truth matrix; manual visual QA is additional.

## Task 10: Task Cards and Conversation Reconstruction

**Files:** `src/app-shell/app.js`, `src/app-shell/styles.css`

- Fetch `/api/queue/state` during dashboard refresh.
- Reconstruct the conversation stream from:
  - existing `data.events`
  - queue tasks from `/api/queue/state`
- Render task cards for `queued`, `running`, `completed`, `interrupted`, `cancelled`.
- Running task cards include a stop button and stage progress.
- Queued task cards include a cancel button.
- Interrupted/cancelled task cards include retry when retryable.
- Ensure refresh/restart does not duplicate cards and does not lose historical cards.
- Add styles with stable dimensions and no nested cards.

## Task 11: Topbar and Inline Progress

**Files:** `src/app-shell/index.html`, `src/app-shell/app.js`, `src/app-shell/styles.css`

- Add topbar progress container.
- Reserve desktop titlebar/window-control space at the top-right so topbar controls do not overlap native minimize/maximize/close buttons.
- Render progress from `summary.activityProgressPercent` or persisted task stage progress.
- Render inline stage progress inside running task cards from `task.stages`, not only global `summary.currentStage`.
- Hide progress when idle/no project.

## Task 12: Context Recovery, Empty State, and Completion Summary

**Files:** `src/app-shell/app.js`, `src/app-shell/styles.css`

- Session head shows:
  - last chapter/stage/word progress.
  - interrupted recovery card when applicable.
  - retry/continue action when applicable.
- Empty project conversation shows concise `/write`, `/review`, `/ask` guidance.
- Completed task card shows summary fields available from current data: words, elapsed time, model calls, estimated cost/cache info when available, and quick actions.
- Visual rhythm:
  - user bubbles right aligned.
  - task cards full width.
  - system events small and centered.
  - detailed logs collapsed by default when implemented.

## Verification and Packaging

Run these before claiming completion:

1. `node --test tests/agent-engine.test.mjs`
2. `node --test tests/task-queue.test.mjs`
3. `node --test tests/app-server-probe.test.mjs`
4. `npm test`
5. `npm run verify:local`
6. `npm run package:dir`

If a verifier is too slow or cannot run in the environment, record the exact command, output, and reason. Do not mark the goal complete without either passing evidence or a user-approved scope change.

## Acceptance Criteria

1. A stale persisted `project_status="running"` with no live `runJobs` entry displays as interrupted/stale, not as running.
2. Active jobs expose `agent_alive=true`, start time, heartbeat, and running task id through `/api/dashboard`.
3. Unexpected engine errors persist `interrupted` and can be retried without deleting drafts or completed chapters.
4. Stop cancels the current running task, preserves drafts, and leaves queued tasks untouched.
5. Submitting three commands results in one running task and two queued tasks; future queued instructions are not appended to the event stream until promoted.
6. Queue state survives reload/restart through `task_queue.json`.
7. `写到第8章`-style commands expand into ordered queued tasks.
8. Task cards show queued/running/completed/interrupted/cancelled states and remain visible after refresh.
9. Topbar status, retry, stop, and progress are driven by the truth matrix.
10. Context recovery/empty-state/completion-summary UI exists for the design's third core problem.
11. The verification and packaging commands above pass, and a packaged directory exists under `dist-desktop`.
