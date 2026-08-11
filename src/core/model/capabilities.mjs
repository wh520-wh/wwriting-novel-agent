// src/core/model/capabilities.mjs
//
// Provider/model 能力矩阵（统一 Agent 内核计划 Task 3）。
//
// 本模块只描述 provider/model 能力（thinking、采样参数、工具调用、流式、JSON
// 输出），不含任何业务规则、工具表或身份文本。行为从旧 provider-adapters.mjs
// 迁移（resolveModelCapabilities / registerProviderCapabilityResolver /
// writingRequiredCapabilitiesOk），供 openai-compatible.mjs 在请求构造层消费。
//
// 旧生产路径（provider-adapters.mjs、v1 全局模型设置模块）已在 Task 9 /
// Task 17 删除，本模块是唯一能力判定源。

const PROVIDER_CAPABILITY_RESOLVERS = [];

// 未匹配任何供应商 resolver 时的默认能力：全能力开放。
export const DEFAULT_CAPABILITIES = Object.freeze({
  supportsThinking: false,
  // reasoning 能力三态（契约 §2.2）：supported（已验证返回 reasoning_content）/
  // unsupported（明确不返回的已知模型）/ unknown（默认，未验证）。只承担 UI
  // 可见性判断，不参与采样——采样参数与 reasoning effort 仍由 supportsThinking 决定。
  reasoningContent: "unknown",
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
    supportsStreaming: true,
    // 已验证会返回 reasoning 的 DeepSeek thinking 模型设为 supported（三态之一，
    // 供 UI 可见性判断）；v4-flash 等未验证模型保持默认 unknown——不能因单次
    // 空响应永久判定不支持。supportsThinking 仍只负责采样参数与 reasoning effort。
    ...(supportsThinking ? { reasoningContent: "supported" } : {}),
    // 已验证的 DeepSeek thinking 模型支持低/中/高三档思考强度（reasoning_effort）；
    // 其余模型（含 v4-flash、MiMo 与未验证模型）缺省此字段，请求体绝不携带该参数。
    ...(supportsThinking ? { reasoningEffortLevels: ["low", "medium", "high"] } : {})
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
