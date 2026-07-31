// DeepSeek 官方缓存命中价（每百万 token，官方定价页 2026-07-31 抓取 E10）。
// 未列出的 deepseek-* 模型不补填，交给 cost-tracker 的输入价 × 2% 默认折算兜底。
export const DEEPSEEK_CACHE_HIT_PRICES = {
  "deepseek-v4-flash": 0.0028,
  "deepseek-v4-pro": 0.003625
};

export function isDeepSeekModel(modelName, baseUrl) {
  return String(modelName ?? "").startsWith("deepseek-") || String(baseUrl ?? "").includes("api.deepseek.com");
}

// 检测到 DeepSeek 且用户未填 cache_hit_per_million 时按官方价补填；用户已填的值绝不覆盖。
export function fillDeepSeekCacheHitPricing(modelName, baseUrl, pricing) {
  if (!pricing || pricing.cache_hit_per_million != null) return pricing;
  if (!isDeepSeekModel(modelName, baseUrl)) return pricing;
  const official = DEEPSEEK_CACHE_HIT_PRICES[modelName];
  if (official == null) return pricing;
  return { ...pricing, cache_hit_per_million: official };
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizePricing(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = positiveNumber(raw.input_per_million);
  const output = positiveNumber(raw.output_per_million);
  if (input === null || output === null) return null;
  const normalized = { input_per_million: input, output_per_million: output, currency: raw.currency ?? "CNY" };
  const cacheHit = positiveNumber(raw.cache_hit_per_million);
  if (cacheHit !== null) normalized.cache_hit_per_million = cacheHit;
  return normalized;
}

export function resolvePricing(modelName, table = {}) {
  if (!modelName) return null;
  if (table[modelName]) return table[modelName];
  let best = null;
  for (const key of Object.keys(table)) {
    if (modelName.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : null;
}

export function buildPricingTable(project = {}) {
  const table = {};
  const candidates = [project.active_model, ...Object.values(project.stage_overrides ?? {}).filter((o) => o?.enabled === true)];
  for (const model of candidates) {
    const pricing = normalizePricing(model?.pricing);
    if (model?.model_name && pricing) table[model.model_name] = pricing;
  }
  return table;
}
