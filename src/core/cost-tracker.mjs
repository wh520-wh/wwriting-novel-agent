import { safeJoin, writeJsonAtomic } from "./fs-utils.mjs";
import { resolvePricing } from "./model-pricing.mjs";

// 未配置 cache_hit_per_million 时，按输入价的 2% 假设缓存命中价，用于估算「缓存节省」。
// DeepSeek v4-flash 官方命中价 $0.0028/M 正好是输入价 $0.14/M 的 2%（E10），
// 其他模型缺省时沿用同一比例，避免「命中率有、节省恒 0」。
export const DEFAULT_CACHE_HIT_PRICE_RATIO = 0.02;

// chat 调用前缀每轮必变，命中率天然低；其调用仍计费，但不计入命中率统计口径。
export const CHAT_STAGE = "chat";

export function estimateCost(usageReport, pricing = null) {
  if (!pricing) return null;
  const input = usageReport.inputTokens ?? 0;
  const output = usageReport.outputTokens ?? 0;
  const cacheHit = Math.min(usageReport.cacheHitTokens ?? usageReport.cachedTokens ?? 0, input);
  const inputPerMillion = pricing.input_per_million ?? 0;
  const outputPerMillion = pricing.output_per_million ?? 0;
  const cacheHitPerMillion = pricing.cache_hit_per_million ?? inputPerMillion;
  const cost =
    ((input - cacheHit) / 1_000_000) * inputPerMillion +
    (cacheHit / 1_000_000) * cacheHitPerMillion +
    (output / 1_000_000) * outputPerMillion;
  return Number(cost.toFixed(8));
}

const SUMMARY_DEFAULTS = {
  calls: 0,
  failedCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  // 累计命中 token 与命中率分母（均不含 chat 调用）：token 加权累计命中率 = cacheHitTokens / hitRateInputTokens
  cacheHitTokens: 0,
  hitRateInputTokens: 0,
  estimatedCost: 0,
  pricedCalls: 0,
  unpricedCalls: 0,
  costAvailable: false,
  retries: 0,
  byProvider: {},
  byModel: {},
  byStage: {},
  byChapter: {},
  recentHitRates: [],
  cacheSavedCost: 0
};

export class CostTracker {
  constructor({ pricing = {}, summary = null } = {}) {
    this.pricing = pricing;
    this.summary = { ...structuredClone(SUMMARY_DEFAULTS), ...(summary ?? {}) };
    this.summary.byModel ??= {};
    this.summary.byChapter ??= {};
    this.summary.recentHitRates ??= [];
    this.summary.cacheSavedCost ??= 0;
    this.summary.cacheHitTokens ??= 0;
    this.summary.hitRateInputTokens ??= 0;
  }

  record({ stage = "unknown", chapter = null, usageReport }) {
    const provider = usageReport.provider ?? "unknown";
    const model = usageReport.model ?? "unknown";
    const pricing = resolvePricing(model, this.pricing) ?? this.pricing[provider] ?? null;
    const cost = usageReport.estimatedCost ?? estimateCost(usageReport, pricing);
    const priced = cost != null;
    const failed = usageReport.failed === true;
    // chat 前缀每轮必变，命中率天然低；仍计费，但不写入命中率统计口径
    // （recentHitRates / cacheHitTokens / hitRateInputTokens）。
    const hitRateEligible = stage !== CHAT_STAGE;
    this.summary.calls += 1;
    if (failed) {
      // §3.5: Track failed calls separately for cost consistency
      this.summary.failedCalls += 1;
    }
    // Skip token accumulation for failed calls without usage data
    // If the provider returned partial usage in the error, still record it
    this.summary.inputTokens += usageReport.inputTokens ?? 0;
    this.summary.outputTokens += usageReport.outputTokens ?? 0;
    this.summary.totalTokens += usageReport.totalTokens ?? 0;
    this.summary.cachedTokens += usageReport.cachedTokens ?? 0;
    if (hitRateEligible) {
      // usage-report 已把 OpenAI 风格 cached_tokens 回退为 cacheHitTokens，
      // 这里再兜一次 ?? cachedTokens，兼容直接构造 usageReport 的调用方。
      this.summary.cacheHitTokens += usageReport.cacheHitTokens ?? usageReport.cachedTokens ?? 0;
      this.summary.hitRateInputTokens += usageReport.inputTokens ?? 0;
    }
    if (priced) {
      this.summary.pricedCalls += 1;
      this.summary.estimatedCost = Number((this.summary.estimatedCost + cost).toFixed(8));
    } else {
      this.summary.unpricedCalls += 1;
    }
    this.summary.costAvailable = this.summary.unpricedCalls === 0 && this.summary.calls > 0;
    if (hitRateEligible && Number.isFinite(usageReport.cacheHitRate)) {
      this.summary.recentHitRates.push(Number(usageReport.cacheHitRate.toFixed(4)));
      while (this.summary.recentHitRates.length > 20) this.summary.recentHitRates.shift();
    }
    if (priced && pricing != null) {
      // 未配置 cache_hit_per_million 时按输入价 × DEFAULT_CACHE_HIT_PRICE_RATIO 折算缓存命中价，
      // 避免「命中率有、节省恒 0」。计费（estimateCost）仍按保守的全价口径，两者差异见任务报告。
      const inputPrice = pricing.input_per_million ?? 0;
      const cacheHitPerMillion = pricing.cache_hit_per_million ?? inputPrice * DEFAULT_CACHE_HIT_PRICE_RATIO;
      if (inputPrice > 0 && cacheHitPerMillion < inputPrice) {
        const hitTokens = Math.min(usageReport.cacheHitTokens ?? usageReport.cachedTokens ?? 0, usageReport.inputTokens ?? 0);
        const saved = (hitTokens / 1_000_000) * Math.max(0, inputPrice - cacheHitPerMillion);
        this.summary.cacheSavedCost = Number((this.summary.cacheSavedCost + saved).toFixed(8));
      }
    }
    const bucketCost = priced ? cost : 0;
    addToBucket(this.summary.byProvider, provider, usageReport, bucketCost);
    addToBucket(this.summary.byModel, model, usageReport, bucketCost);
    addToBucket(this.summary.byStage, stage, usageReport, bucketCost);
    if (chapter != null) {
      addToBucket(this.summary.byChapter, String(chapter), usageReport, bucketCost);
    }
    return this.getSummary();
  }

  recordRetry() {
    this.summary.retries += 1;
    return this.summary.retries;
  }

  getSummary() {
    return structuredClone(this.summary);
  }

  async writeProjectReport(projectRoot) {
    return writeJsonAtomic(safeJoin(projectRoot, "cost.json"), this.getSummary());
  }
}

function addToBucket(buckets, key, usageReport, cost) {
  buckets[key] ??= {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    estimatedCost: 0
  };
  buckets[key].calls += 1;
  // 与 summary 路径（record 里 inputTokens ?? 0 等）保持一致：缺字段按 0 累计，
  // 避免 undefined 把桶内字段污染成 NaN（JSON 序列化后变 null）。
  buckets[key].inputTokens += usageReport.inputTokens ?? 0;
  buckets[key].outputTokens += usageReport.outputTokens ?? 0;
  buckets[key].totalTokens += usageReport.totalTokens ?? 0;
  buckets[key].cachedTokens += usageReport.cachedTokens ?? 0;
  buckets[key].estimatedCost = Number((buckets[key].estimatedCost + cost).toFixed(8));
}
