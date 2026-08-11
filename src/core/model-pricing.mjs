// 官方价格表与补缺函数本体在 src/shared/official-pricing.mjs（前端设置面板
// 「选模型自动带出官方价」也要用同一份规则），这里 re-export 保持既有 import 不变。
import { fillOfficialPricing } from "../shared/official-pricing.mjs";

export { fillOfficialPricing };

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
  // Task 9：各阶段模型覆盖已删除（运行时从未接线），价格表只取 active_model。
  const candidates = [project.active_model];
  for (const model of candidates) {
    const pricing = normalizePricing(model?.pricing);
    if (model?.model_name && pricing) table[model.model_name] = pricing;
  }
  return table;
}
