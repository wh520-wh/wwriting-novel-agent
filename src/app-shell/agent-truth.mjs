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

export function deriveFailures(dashboard) {
  const raw = Array.isArray(dashboard?.failures) ? dashboard.failures : [];
  const seqByChapter = new Map();
  return raw.map(f => {
    const ch = f.chapterNo ?? 0;
    const n = (seqByChapter.get(ch) ?? 0) + 1;
    seqByChapter.set(ch, n);
    return { ...f, seq: n };
  });
}

export function deriveActivity(dashboard, now = Date.now()) {
  if (!dashboard?.hasProject) return null;
  const summary = dashboard.summary ?? {};
  const state = dashboard.state ?? {};
  const status = summary.projectStatus ?? state.project_status ?? 'idle';
  const stage = summary.currentStage ?? state.current_stage ?? null;
  const chapterNo = summary.currentChapterNo ?? state.current_chapter_no ?? null;
  const segCurrent = null;
  const segTotal = null;
  const rt = Array.isArray(dashboard.recent_tool_events) && dashboard.recent_tool_events.length
    ? dashboard.recent_tool_events[0] : null;
  const lastTool = rt ? {
    name: rt.data?.tool ?? rt.tool ?? '',
    status: rt.type === 'tool_call_rejected' ? 'failed'
          : (rt.type === 'tool_call_requested' ? 'pending' : 'ok'),
    ts: rt.ts
  } : null;
  const enteredAt = state.stage_entered_at ? Date.parse(state.stage_entered_at) : NaN;
  const elapsedMs = Number.isNaN(enteredAt) ? null : (now - enteredAt);
  const spentCost = summary.estimatedCost ?? null;
  let mode = 'idle';
  if (status === 'running' && dashboard.agent_alive) mode = 'running';
  else if (status === 'blocked') mode = 'blocked';
  else if (status === 'interrupted') mode = 'interrupted';
  else if (status === 'completed') mode = 'completed';
  return { stage, chapterNo, segCurrent, segTotal, lastTool, elapsedMs, etaMs: null, spentCost, mode };
}

export function deriveBadges(dashboard, projectRoot = '', lastSeen = {}) {
  const total = dashboard?.summary?.targetChapters ?? 0;
  const done = dashboard?.summary?.completedChapters ?? 0;
  const skillItems = dashboard?.skills?.items ?? [];
  const enabledCount = skillItems.filter(s => s.enabled_in_project).length;
  const sourcesCount = dashboard?.sources?.count ?? 0;
  const sourcesLatestTs = dashboard?.sources?.latest?.[0]?.captured_at ?? null;
  const reviewerTs = dashboard?.review?.generated_at ?? null;
  const newResearch = sourcesLatestTs && lastSeen.research
    ? sourcesLatestTs > lastSeen.research
    : !!sourcesLatestTs;
  const newReviewer = reviewerTs && lastSeen.reviewer
    ? reviewerTs > lastSeen.reviewer
    : !!reviewerTs;
  const used = dashboard?.summary?.estimatedCost ?? 0;
  const budget = dashboard?.project?.budget_config?.max_cost ?? 0;
  const pct = budget > 0 ? used / budget : 0;
  let level = 'normal';
  if (pct >= 1) level = 'over';
  else if (pct >= 0.8) level = 'warning';
  return {
    chapters: { done, total, ticking: false },
    skills: { enabledCount },
    research: { newSinceLastVisit: !!newResearch, count: sourcesCount },
    cost: { used, budget, pct, level },
    reviewer: { hasUnread: !!newReviewer, lastReportTs: reviewerTs }
  };
}
