const TERMINAL = new Set(["completed", "blocked", "interrupted", "cancelled"]);
const LABELS = {
  completed: "已完成",
  blocked: "需处理",
  interrupted: "已中断",
  cancelled: "已停止",
  cancelling: "正在取消",
  running: "创作中"
};

export function deriveRunPresentation(data = {}) {
  const summary = data.summary ?? {};
  const state = data.state ?? {};
  const status = summary.projectStatus ?? state.project_status ?? "idle";
  const savedStage = summary.currentStage ?? state.current_stage ?? "queued";
  const resumeStage = status === "blocked"
    ? state.blocked_at_stage ?? savedStage
    : savedStage;
  return {
    status,
    resumeStage,
    chapterNo: summary.currentChapterNo ?? state.current_chapter_no ?? null,
    label: LABELS[status] ?? "待命",
    reason: state.interrupted_reason ?? state.cancelled_reason ?? state.blocked_reason ?? "",
    isLive: status === "running" || status === "cancelling",
    isTerminal: TERMINAL.has(status),
    recoveryLabel: status === "interrupted" || status === "cancelled" ? "从中断处继续" : ""
  };
}

export function deriveStepState(run, groupStages, stageOrder) {
  const activeIndex = stageOrder.indexOf(run.resumeStage);
  const groupEnd = Math.max(...groupStages.map((stage) => stageOrder.indexOf(stage)));
  if (run.status === "completed") return "done";
  if (run.status === "blocked" && groupStages.includes(run.resumeStage)) return "blocked";
  if ((run.status === "interrupted" || run.status === "cancelled") && groupStages.includes(run.resumeStage)) {
    return run.status;
  }
  if (activeIndex >= 0 && activeIndex > groupEnd) return "done";
  if (run.isLive && groupStages.includes(run.resumeStage)) return "running";
  return "todo";
}
