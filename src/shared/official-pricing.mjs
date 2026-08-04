// 官方定价（人民币，每百万 token；2026-07-31 用户提供官方价格表）。
// 未收录的模型不补填，交给 cost-tracker 的输入价 × 2% 默认折算兜底。
// 放 shared：后端 core（保存时补缺）与前端设置面板（选模型自动带出官方价）共用同一张表。

export const OFFICIAL_PRICING = {
  "deepseek-v4-flash": { input_per_million: 1.0, output_per_million: 2.0, cache_hit_per_million: 0.02 },
  "deepseek-v4-pro": { input_per_million: 3.0, output_per_million: 6.0, cache_hit_per_million: 0.025 },
  "mimo-v2.5": { input_per_million: 1.0, output_per_million: 2.0, cache_hit_per_million: 0.02 },
  "mimo-v2.5-pro": { input_per_million: 3.0, output_per_million: 6.0, cache_hit_per_million: 0.025 },
  "mimo-v2.5-pro-ultraspeed": { input_per_million: 9.0, output_per_million: 18.0, cache_hit_per_million: 0.075 }
};

// 「模型名 → 官方价」查表与补缺的唯一实现：检测到官方收录的模型且字段未填时
// 按官方人民币价补缺（输入/输出/命中价各自独立判断）；已填值绝不覆盖。
// 返回浅拷贝，不改入参。后端保存（fillOfficialPricing 补缺）与前端设置面板
// （选模型自动带出官方价）共用这一份规则，保证表单预览与保存结果一致。
// 未收录模型原样返回 pricing：面板对其以空对象调用即得「清空价格」语义。
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
