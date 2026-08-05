// src/core/model/capabilities.mjs
//
// Provider/model 能力矩阵（统一 Agent 内核计划 Task 3）。
//
// 本模块只描述 provider/model 能力（thinking、采样参数、工具调用、流式、JSON
// 输出），不含任何业务规则、工具表或身份文本。行为从旧 provider-adapters.mjs
// 迁移（resolveModelCapabilities / registerProviderCapabilityResolver /
// writingRequiredCapabilitiesOk），供 openai-compatible.mjs 在请求构造层消费。
//
// 旧生产路径（provider-adapters.mjs、global-model-settings.mjs）在 Task 9
// cutover 前保持原样，本模块不修改它们也不被它们 import；旧路径与新路径各自
// 持有独立注册表，互不干扰。

const PROVIDER_CAPABILITY_RESOLVERS = [];

// 未匹配任何供应商 resolver 时的默认能力：全能力开放。
export const DEFAULT_CAPABILITIES = Object.freeze({
  supportsThinking: false,
  requiresAutoToolChoice: false,
  supportsTemperature: true,
  supportsTopP: true,
  supportsJsonOutput: true,
  supportsTools: true,
  supportsStreaming: true
});

// 供应商能力判断注册表：新供应商有推理模型/参数限制时注册一条 resolver 即可，
// 不需要改本文件内部的 if 分支。matcher(modelConfig) 命中时用 resolver(modelConfig)
// 的返回值覆盖 DEFAULT_CAPABILITIES；按注册顺序先匹配先生效。
export function registerProviderCapabilityResolver(matcher, resolver) {
  if (typeof matcher !== "function" || typeof resolver !== "function") {
    throw new TypeError("registerProviderCapabilityResolver 需要 matcher 与 resolver 函数");
  }
  PROVIDER_CAPABILITY_RESOLVERS.push({ matcher, resolver });
}

function resolveDeepSeekCapabilities(modelConfig) {
  const modelName = String(modelConfig.model_name ?? "").toLowerCase();
  // 原 isReasonerModel 判据 1:1 搬移：v4-pro / deepseek-reasoner / reasoner 系为
  // thinking 模型；v4-flash 默认 non-thinking（官方文档 2026-07），不判为 reasoner。
  const supportsThinking = (
    (modelName.includes("deepseek-v4") && !modelName.includes("-flash")) ||
    modelName.includes("deepseek-reasoner") ||
    modelName.includes("reasoner")
  );
  // 实测：官方 API 当前把 deepseek-v4-flash 当 thinking 模型处理，强制 tool_choice
  // 会返回 400 "Thinking mode does not support this tool_choice"，故对官方 v4-flash
  // 也走 auto（模型仍会返回 tool_calls）。
  const isDeepSeekV4Flash = modelName.includes("deepseek-v4-flash");
  return {
    supportsThinking,
    requiresAutoToolChoice: supportsThinking || isDeepSeekV4Flash,
    // v4-flash 官方按 thinking 处理，采样参数同样不支持，一并排除（防 temperature 400）
    supportsTemperature: !supportsThinking && !isDeepSeekV4Flash,
    supportsTopP: !supportsThinking && !isDeepSeekV4Flash,
    supportsJsonOutput: true,
    supportsTools: true,
    supportsStreaming: true
  };
}

// DeepSeek 的 resolver 在模块加载时自动注册一次（matcher 对 base_url 做 lowercase
// 归一化，与泛化前 isDeepSeek 门控语义等价），调用方无需手动注册。
registerProviderCapabilityResolver(
  (modelConfig) => String(modelConfig.base_url ?? "").toLowerCase().includes("api.deepseek.com"),
  resolveDeepSeekCapabilities
);

// 模型能力判定：遍历已注册 resolver，未匹配任何供应商时回落默认全能力开放。
export function resolveModelCapabilities(modelConfig = {}) {
  for (const { matcher, resolver } of PROVIDER_CAPABILITY_RESOLVERS) {
    if (matcher(modelConfig)) {
      return { ...DEFAULT_CAPABILITIES, ...resolver(modelConfig) };
    }
  }
  return DEFAULT_CAPABILITIES;
}

// 工具任务硬要求：native function calling 与流式都可用才算合格（能力门槛，
// 不是业务规则）。缺失时保存/选用/切换应被拒绝，请求构造层返回
// MODEL_TOOLS_UNSUPPORTED。
export function writingRequiredCapabilitiesOk(modelConfig = {}) {
  const caps = resolveModelCapabilities(modelConfig);
  return caps.supportsTools !== false && caps.supportsStreaming !== false;
}
