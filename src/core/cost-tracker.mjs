import { safeJoin, writeJsonAtomic } from "./fs-utils.mjs";
import { on, CORE_EVENTS } from "./event-bus.mjs";

export function estimateCost(usageReport, pricing = {}) {
  const inputPerMillion = pricing.input_per_million ?? 0;
  const outputPerMillion = pricing.output_per_million ?? 0;
  const inputCost = (usageReport.inputTokens / 1_000_000) * inputPerMillion;
  const outputCost = (usageReport.outputTokens / 1_000_000) * outputPerMillion;
  return Number((inputCost + outputCost).toFixed(8));
}

export class CostTracker {
  constructor({ pricing = {}, summary = null } = {}) {
    this.pricing = pricing;
    this.summary = summary ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      estimatedCost: 0,
      byProvider: {},
      byStage: {}
    };
  }

  record({ stage = "unknown", usageReport }) {
    const provider = usageReport.provider ?? "unknown";
    const cost = usageReport.estimatedCost ?? estimateCost(usageReport, this.pricing[provider] ?? {});
    this.summary.calls += 1;
    this.summary.inputTokens += usageReport.inputTokens;
    this.summary.outputTokens += usageReport.outputTokens;
    this.summary.totalTokens += usageReport.totalTokens;
    this.summary.cachedTokens += usageReport.cachedTokens;
    this.summary.estimatedCost = Number((this.summary.estimatedCost + cost).toFixed(8));
    addToBucket(this.summary.byProvider, provider, usageReport, cost);
    addToBucket(this.summary.byStage, stage, usageReport, cost);
    return this.getSummary();
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

// Subscribe to model-call:complete and call recordUsage
on(CORE_EVENTS.ModelCallComplete, (payload) => {
  try {
    if (!payload || !payload.usage) return;
    const costTracker = payload.costTracker;
    if (!costTracker || typeof costTracker.record !== "function") return;
    const stage = payload.options?.stage ?? "unknown";
    const usageReport = {
      ...payload.usage,
      provider: payload.model
    };
    costTracker.record({ stage, usageReport });
  } catch (e) {
    console.error("cost-tracker: failed to record usage from event:", e);
  }
});
