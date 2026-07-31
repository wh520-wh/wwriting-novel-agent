// 官方定价（人民币，每百万 token；2026-07-31 用户提供官方价格表）。
// 未收录的模型不补填，交给 cost-tracker 的输入价 × 2% 默认折算兜底。
export const OFFICIAL_PRICING = {
  "deepseek-v4-flash": { input_per_million: 1.0, output_per_million: 2.0, cache_hit_per_million: 0.02 },
  "deepseek-v4-pro": { input_per_million: 3.0, output_per_million: 6.0, cache_hit_per_million: 0.025 },
  "mimo-v2.5": { input_per_million: 1.0, output_per_million: 2.0, cache_hit_per_million: 0.02 },
  "mimo-v2.5-pro": { input_per_million: 3.0, output_per_million: 6.0, cache_hit_per_million: 0.025 }
};

export function isDeepSeekModel(modelName, baseUrl) {
  return String(modelName ?? "").startsWith("deepseek-") || String(baseUrl ?? "").includes("api.deepseek.com");
}

// 检测到官方收录的模型（DeepSeek / MiMo）且字段未填时按官方人民币价补缺
// （输入/输出/命中价各自独立判断）；用户已填的值绝不覆盖。返回浅拷贝，不改入参。
export function fillOfficialPricing(modelName, baseUrl, pricing = {}) {
  if (!pricing) return pricing;
  const official = OFFICIAL_PRICING[modelName];
  if (!official) return pricing;
  const filled = { ...pricing };
  for (const key of ["input_per_million", "output_per_million", "cache_hit_per_million"]) {
    if (filled[key] == null) filled[key] = official[key];
  }
  return filled;
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
