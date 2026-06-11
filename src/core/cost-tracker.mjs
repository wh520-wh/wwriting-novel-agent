import { safeJoin, writeJsonAtomic } from "./fs-utils.mjs";
import { resolvePricing } from "./model-pricing.mjs";

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
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
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
  refillCalls: 0,
  cacheSavedCost: 0
};

export class CostTracker {
  constructor({ pricing = {}, summary = null } = {}) {
    this.pricing = pricing;
    this.summary = { ...structuredClone(SUMMARY_DEFAULTS), ...(summary ?? {}) };
    this.summary.byModel ??= {};
    this.summary.byChapter ??= {};
    this.summary.recentHitRates ??= [];
    this.summary.refillCalls ??= 0;
    this.summary.cacheSavedCost ??= 0;
  }

  record({ stage = "unknown", chapter = null, usageReport }) {
    const provider = usageReport.provider ?? "unknown";
    const model = usageReport.model ?? "unknown";
    const pricing = resolvePricing(model, this.pricing) ?? this.pricing[provider] ?? null;
    const cost = usageReport.estimatedCost ?? estimateCost(usageReport, pricing);
    const priced = cost != null;
    this.summary.calls += 1;
    this.summary.inputTokens += usageReport.inputTokens;
    this.summary.outputTokens += usageReport.outputTokens;
    this.summary.totalTokens += usageReport.totalTokens;
    this.summary.cachedTokens += usageReport.cachedTokens;
    if (priced) {
      this.summary.pricedCalls += 1;
      this.summary.estimatedCost = Number((this.summary.estimatedCost + cost).toFixed(8));
    } else {
      this.summary.unpricedCalls += 1;
    }
    this.summary.costAvailable = this.summary.unpricedCalls === 0 && this.summary.calls > 0;
    if (Number.isFinite(usageReport.cacheHitRate)) {
      this.summary.recentHitRates.push(Number(usageReport.cacheHitRate.toFixed(4)));
      while (this.summary.recentHitRates.length > 20) this.summary.recentHitRates.shift();
    }
    if (priced && pricing?.cache_hit_per_million != null) {
      const hitTokens = Math.min(usageReport.cacheHitTokens ?? usageReport.cachedTokens ?? 0, usageReport.inputTokens ?? 0);
      const inputPrice = pricing.input_per_million ?? 0;
      const saved = (hitTokens / 1_000_000) * Math.max(0, inputPrice - pricing.cache_hit_per_million);
      this.summary.cacheSavedCost = Number((this.summary.cacheSavedCost + saved).toFixed(8));
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

  recordRefill() {
    this.summary.refillCalls += 1;
    return this.summary.refillCalls;
  }

  getSummary() {
    return JSON.parse(JSON.stringify(this.summary));
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
  buckets[key].inputTokens += usageReport.inputTokens;
  buckets[key].outputTokens += usageReport.outputTokens;
  buckets[key].totalTokens += usageReport.totalTokens;
  buckets[key].cachedTokens += usageReport.cachedTokens;
  buckets[key].estimatedCost = Number((buckets[key].estimatedCost + cost).toFixed(8));
}
