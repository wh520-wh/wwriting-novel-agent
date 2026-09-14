function numeric(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function firstNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

export function normalizeUsageReport({ provider, model, usage = {}, rawUsage = usage, cost = null } = {}) {
  const inputTokens = firstNumber(usage.inputTokens, usage.input_tokens, usage.prompt_tokens);
  const outputTokens = firstNumber(usage.outputTokens, usage.output_tokens, usage.completion_tokens);
  const totalTokens = firstNumber(usage.totalTokens, usage.total_tokens, inputTokens + outputTokens);
  const cachedTokens = firstNumber(usage.cachedTokens, usage.cached_tokens);
  // provider 显式命中字段优先；OpenAI 风格只给 cached_tokens（如 MiMo）时回退，
  // 否则下游 `cacheHitTokens ?? cachedTokens` 会被这里规约出的 0 短路，缓存折扣永远算不上。
  const cacheHitTokens = firstNumber(usage.cacheHitTokens, usage.cache_hit_tokens, usage.prompt_cache_hit_tokens, cachedTokens);
  const cacheReadTokens = firstNumber(usage.cacheReadTokens, usage.cache_read_tokens);
  const cacheWriteTokens = firstNumber(usage.cacheWriteTokens, usage.cache_write_tokens);
  const reasoningTokens = firstNumber(usage.reasoningTokens, usage.reasoning_tokens);
  const cacheMetricKeys = [
    "cachedTokens",
    "cached_tokens",
    "cacheHitTokens",
    "cache_hit_tokens",
    "prompt_cache_hit_tokens",
    "cacheReadTokens",
    "cache_read_tokens",
    "cacheWriteTokens",
    "cache_write_tokens"
  ];
  const cacheMetricsAvailable =
    usage.cacheMetricsAvailable === true ||
    cacheMetricKeys.some((key) => Object.hasOwn(usage, key));
  const cacheHitRate =
    cacheMetricsAvailable && inputTokens > 0 ? numeric(cacheHitTokens || cachedTokens, 0) / inputTokens : null;

  return {
    provider,
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens,
    cacheHitTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    cacheMetricsAvailable,
    cacheHitRate,
    estimatedCost: cost,
    rawUsage
  };
}
