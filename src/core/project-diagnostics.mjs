import { readEvents } from "./event-log.mjs";
import { readFailures } from "./failures-store.mjs";
import { loadState } from "./project-store.mjs";
import { TaskQueue } from "./task-queue.mjs";

export async function loadProjectDiagnostics(projectRoot) {
  const [state, events, failures, queueState] = await Promise.all([
    loadState(projectRoot).catch((error) => ({ project_status: "unknown", load_error: error.message })),
    readEvents(projectRoot, { limit: 20 }),
    Promise.resolve()
      .then(() => readFailures(projectRoot))
      .then((items) => items.slice(-10).reverse())
      .catch(() => []),
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
  const type = String(event.type ?? "");
  const message = String(event.message ?? "");
  return /model|provider|timeout|transport/u.test(type) || /model|provider|timeout|transport/u.test(message);
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
