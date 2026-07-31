// 缓存折扣平台模式检测（D1，DeepSeek 专属层 + MiMo 适配——自动检测启用，用户无感知、不加界面标识）。
//
// 判据与 isDeepSeekMode 同风格：base_url 包含匹配（大小写不敏感）+ model_name 前缀。
// 与 settings-modal 的 detectProviderPreset 等号匹配不同：这里用包含匹配，
// 兼容官方端点的路径/端口/大小写变体；provider 字段恒为 openai-compatible，不可用作信号。
//
// isDeepSeekMode：base_url 含 api.deepseek.com + 模型前缀 deepseek-。
// isMiMoMode：base_url 含 xiaomimimo.com（覆盖 api.xiaomimimo.com 按量付费与
//   token-plan-*.xiaomimimo.com 订阅端点）+ 模型前缀 mimo-。
// isCacheDiscountedMode：两者之并集——供成本面板低命中率提示（D2）使用。
//
// 注意：provider-adapters 的 isReasonerModel 是另一判据（thinking 模型名单），两者语义不同，勿合并。

export function isDeepSeekMode(modelConfig = {}) {
  const baseUrl = String(modelConfig?.base_url ?? "").toLowerCase();
  const modelName = String(modelConfig?.model_name ?? "").toLowerCase();
  return baseUrl.includes("api.deepseek.com") && modelName.startsWith("deepseek-");
}

export function isMiMoMode(modelConfig = {}) {
  const baseUrl = String(modelConfig?.base_url ?? "").toLowerCase();
  const modelName = String(modelConfig?.model_name ?? "").toLowerCase();
  return baseUrl.includes("xiaomimimo.com") && modelName.startsWith("mimo-");
}

// D2 低命中率提示的统一判据：DeepSeek 与 MiMo 均为隐式前缀缓存 + 命中折扣定价的平台。
export function isCacheDiscountedMode(modelConfig = {}) {
  return isDeepSeekMode(modelConfig) || isMiMoMode(modelConfig);
}
