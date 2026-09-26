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
  // v4 全系（含 flash）与 reasoner 系均为思考模型（官方文档 2026-08：思考模式
  // 默认打开、v4-flash 与 v4-pro 一致、档位 low/high/max）。旧判据「flash 默认
  // non-thinking」出自 2026-07 文档，8 月起已过时；且实测服务端默认值按时间窗
  // 漂移（思考内容时有时无），请求层因此显式钉死（见 openai-compatible 请求构造）。
  const supportsThinking = (
    modelName.includes("deepseek-v4") ||
    modelName.includes("deepseek-reasoner") ||
    modelName.includes("reasoner")
  );
  return {
    supportsThinking,
    // thinking 模型不支持强制 tool_choice（400 "Thinking mode does not support
    // this tool_choice"），一律 auto（模型仍会返回 tool_calls）。
    requiresAutoToolChoice: supportsThinking,
    supportsTemperature: !supportsThinking,
    supportsTopP: !supportsThinking,
    supportsJsonOutput: true,
    supportsTools: true,
    supportsStreaming: true,
    // 官方思考模型请求层钉死后必然返回 reasoning（三态之一，供 UI 可见性判断）。
    ...(supportsThinking ? { reasoningContent: "supported" } : {}),
    // 官方思考强度档位（2026-08-13 更新日志）：low / high / max。
    ...(supportsThinking ? { reasoningEffortLevels: ["low", "high", "max"] } : {})
  };
}

// D6（round22）：DeepSeek resolver 只服务 OpenAI Chat Completions 形状——thinking
// 钉死、reasoning_effort 等 thinking 注入都是 chat-completions 请求体字段，不得
// 泄到其他协议端点（Anthropic/Responses 端点注入 DeepSeek thinking 会被拒）。
registerProviderCapabilityResolver(
  (modelConfig) =>
    String(modelConfig.api_format ?? "openai-chat-completions") === "openai-chat-completions" &&
    String(modelConfig.base_url ?? "").toLowerCase().includes("api.deepseek.com"),
  resolveDeepSeekCapabilities
);

// D6：Anthropic Messages 协议口径。工具/流式原生支持；thinking 块存在但本应用
// 未经验证不开启（不注入 thinking budget），reasoning 三态记 unknown；JSON mode
// 无 chat-completions 的 response_format 等价物（json_object 不注入）。
registerProviderCapabilityResolver(
  (modelConfig) => modelConfig.api_format === "anthropic-messages",
  () => ({
    supportsThinking: false,
    reasoningContent: "unknown",
    requiresAutoToolChoice: false,
    supportsTemperature: true,
    supportsTopP: true,
    supportsJsonOutput: false,
    supportsTools: true,
    supportsStreaming: true
  })
);

// D6：OpenAI Responses 协议口径。工具/流式原生支持；reasoning 输出经
// reasoning summary/text 增量透出，是否返回取决于模型与请求参数（未验证 → unknown）。
registerProviderCapabilityResolver(
  (modelConfig) => modelConfig.api_format === "openai-responses",
  () => ({
    supportsThinking: false,
    reasoningContent: "unknown",
    requiresAutoToolChoice: false,
    supportsTemperature: true,
    supportsTopP: true,
    supportsJsonOutput: false,
    supportsTools: true,
    supportsStreaming: true
  })
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
