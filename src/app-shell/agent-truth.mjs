export function computeAgentTruth(data, now = Date.now()) {
  if (!data?.hasProject) {
    return { display: "待命", className: "idle", showRetry: false, showStop: false, refresh: false, reason: "" };
  }
  const retryAvailable = data.retry_available === true;
  const retryReason = data.retry_unavailable_reason ?? "";
  const alive = data.agent_alive === true;
  const status = data.summary?.projectStatus ?? data.state?.project_status ?? "idle";
  const heartbeat = data.agent_last_heartbeat ?? data.state?.last_heartbeat;
  const heartbeatMs = heartbeat ? Date.parse(heartbeat) : NaN;
  const heartbeatAge = Number.isNaN(heartbeatMs) ? Infinity : (now - heartbeatMs) / 1000;
  if (alive && heartbeatAge > 60) {
    return { display: "疑似卡住", className: "stale", showRetry: false, showStop: true, refresh: true, reason: retryReason || `心跳超时 ${Math.round(heartbeatAge)} 秒` };
  }
  if (alive && heartbeatAge > 30) {
    return { display: "响应慢", className: "slow", showRetry: false, showStop: true, refresh: true, reason: "" };
  }
  if (alive) {
    return { display: agentPhaseLabel("running", data.summary?.currentStage), className: "running", showRetry: false, showStop: true, refresh: true, reason: "" };
  }
  if (status === "running") {
    return { display: "已中断", className: "interrupted", showRetry: retryAvailable, showStop: false, refresh: false, reason: retryReason || "进程已退出但状态仍为运行中" };
  }
  if (status === "interrupted") {
    return { display: "已中断", className: "interrupted", showRetry: retryAvailable, showStop: false, refresh: false, reason: data.agent_error ?? data.state?.interrupted_reason ?? retryReason ?? "" };
  }
  if (status === "cancelled") {
    return { display: "已停止", className: "cancelled", showRetry: retryAvailable, showStop: false, refresh: false, reason: data.state?.cancelled_reason ?? retryReason ?? "用户停止" };
  }
  if (status === "blocked") {
    return { display: "需处理", className: "blocked", showRetry: false, showStop: false, refresh: false, reason: data.state?.blocked_reason ?? "" };
  }
  if (status === "completed") {
    return { display: "已完成", className: "completed", showRetry: false, showStop: false, refresh: false, reason: "" };
  }
  return { display: "待命", className: "idle", showRetry: false, showStop: false, refresh: false, reason: "" };
}

function agentPhaseLabel(status, stage) {
  if (status === "completed") return "已完成";
  if (status === "blocked") return "需处理";
  if (status !== "running") return "待命";
  switch (stage) {
    case "queued":
    case "planning":
    case "planned":
      return "规划中";
    case "drafting":
      return "写作中";
    case "reviewing":
    case "needs_revision":
    case "revising":
      return "审稿中";
    case "finalizing":
    case "summarizing":
      return "保存中";
    default:
      return "运行中";
  }
}
