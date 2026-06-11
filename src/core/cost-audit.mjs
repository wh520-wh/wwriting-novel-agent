export function analyzeCost({ events = [], costSummary = null, cacheReport = null } = {}) {
  const calls = { started: 0, completed: 0, abandoned: 0 };
  const retries = { count: 0, byReason: {} };
  const byChapter = {};
  const refills = { gateFailures: 0, byChapter: {} };
  const samples = [];

  for (const event of events) {
    if (event.type === "model_call_started") calls.started += 1;
    if (event.type === "model_retry") {
      retries.count += 1;
      const reason = event.data?.reason ?? "unknown";
      retries.byReason[reason] = (retries.byReason[reason] ?? 0) + 1;
    }
    if (event.type === "quality_gate_failed" && event.message === "word-count gate failed") {
      refills.gateFailures += 1;
      const key = String(event.chapter_no ?? "unknown");
      refills.byChapter[key] = (refills.byChapter[key] ?? 0) + 1;
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

  const versions = Object.values(cacheReport?.entries ?? {})
    .map((entry) => entry.cacheVersion)
    .filter((v) => Number.isFinite(v));
  return {
    calls,
    retries,
    byChapter,
    refills,
    cache: {
      samples,
      averageHitRate: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null,
      maxCacheVersion: versions.length ? Math.max(...versions) : null,
      lastStableChanged: cacheReport?.last_call?.stableChanged ?? null
    },
    costSummary
  };
}
