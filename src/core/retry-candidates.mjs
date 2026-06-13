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
  if (job?.status === "cancelling" || state.project_status === "cancelling") {
    return unavailable("retry_cancelling", "正在停止，请等待状态收敛", 409);
  }
  const queueState = queue.getState();
  if (queueState.tasks.some((task) => task.status === "cancelling")) {
    return unavailable("retry_cancelling", "正在停止，请等待状态收敛", 409);
  }
  if (["completed", "blocked"].includes(state.project_status)) {
    return unavailable("retry_not_allowed_status", "当前项目状态不可重试。", 400);
  }
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
