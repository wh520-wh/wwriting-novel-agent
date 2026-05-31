import { CostTracker } from "./cost-tracker.mjs";
import { resolveRuntimeConfig } from "./config-runtime.mjs";
import { normalizeUsageReport } from "./usage-report.mjs";

export class ModelClient {
  constructor({ adapters = {}, activeModel = null, stageOverrides = {}, costTracker = new CostTracker() } = {}) {
    this.adapters = adapters;
    this.activeModel = activeModel;
    this.stageOverrides = stageOverrides;
    this.costTracker = costTracker;
  }

  resolveModelConfig(project = {}, stage = "drafting") {
    const effectiveConfig = resolveRuntimeConfig(project, {
      globalConfig: {
        active_model: this.activeModel ?? {
          provider: "mock",
          model_name: "mock-writer"
        },
        stage_overrides: this.stageOverrides ?? {}
      }
    });
    const activeModel = effectiveConfig.active_model;
    const stageOverrides = effectiveConfig.stage_overrides ?? {};
    const stageOverride = stageOverrides[stage];
    if (stageOverride && stageOverride.enabled === true) {
      return {
        ...activeModel,
        ...stageOverride,
        stage_override_enabled: true
      };
    }
    return {
      ...activeModel,
      stage_override_enabled: false
    };
  }

  async generate({ project = {}, stage = "drafting", prompt = "", messages = [], metadata = {}, signal = undefined } = {}) {
    const modelConfig = this.resolveModelConfig(project, stage);
    const adapter = this.adapters[modelConfig.provider];
    if (!adapter) {
      throw new Error(`No provider adapter configured for ${modelConfig.provider}`);
    }
    const response = await adapter.generate({
      model: modelConfig.model_name,
      modelConfig,
      prompt,
      messages,
      stage,
      metadata,
      signal
    });
    const usageReport = normalizeUsageReport({
      provider: modelConfig.provider,
      model: modelConfig.model_name,
      usage: response.usage ?? {},
      rawUsage: response.usage ?? {},
      cost: response.cost ?? null
    });
    const costSummary = this.costTracker.record({ stage, usageReport });
    return {
      text: response.text ?? "",
      raw: response.raw ?? response,
      usageReport,
      costSummary,
      modelConfig
    };
  }
}
