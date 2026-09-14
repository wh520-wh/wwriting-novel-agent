export function analyzeCost({ events = [], costSummary = null } = {}) {
  const calls = { started: 0, completed: 0, abandoned: 0 };
  const retries = { count: 0, byReason: {} };
  const byChapter = {};
  const samples = [];

  for (const event of events) {
    if (event.type === "model_call_started") calls.started += 1;
    if (event.type === "model_retry") {
      retries.count += 1;
      const reason = event.data?.reason ?? "unknown";
      retries.byReason[reason] = (retries.byReason[reason] ?? 0) + 1;
    }
    if (event.type === "model_usage_recorded") {
      calls.completed += 1;
      const usage = event.data?.usage_report ?? {};
      const key = String(event.chapter_no ?? "unknown");
      byChapter[key] ??= { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
      byChapter[key].calls += 1;
      byChapter[key].inputTokens += usage.inputTokens ?? 0;
      byChapter[key].outputTokens += usage.outputTokens ?? 0;
      byChapter[key].cachedTokens += usage.cachedTokens ?? 0;
      byChapter[key].reasoningTokens += usage.reasoningTokens ?? 0;
      if (typeof usage.cacheHitRate === "number") samples.push(usage.cacheHitRate);
    }
  }
  calls.abandoned = Math.max(0, calls.started - calls.completed);

  return {
    calls,
    retries,
    byChapter,
    cache: {
      samples,
      averageHitRate: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null
    },
    costSummary
  };
}
