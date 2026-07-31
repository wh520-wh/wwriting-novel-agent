// DeepSeek 模式检测（D1，DeepSeek 专属层——自动检测启用，用户无感知、不加界面标识）。
//
// 判据：base_url 含 api.deepseek.com（大小写不敏感，包含匹配）+ model_name 前缀 deepseek-。
// 与 settings-modal 的 detectProviderPreset 等号匹配不同：这里用包含匹配，
// 兼容官方端点的路径/端口/大小写变体；provider 字段恒为 openai-compatible，不可用作信号。
//
// 供成本面板低命中率提示（D2）与未来 DeepSeek 专属项（如缓存策略差异化）使用。
// 注意：provider-adapters 的 isReasonerModel 是另一判据（thinking 模型名单），两者语义不同，勿合并。

export function isDeepSeekMode(modelConfig = {}) {
  const baseUrl = String(modelConfig?.base_url ?? "").toLowerCase();
  const modelName = String(modelConfig?.model_name ?? "").toLowerCase();
  return baseUrl.includes("api.deepseek.com") && modelName.startsWith("deepseek-");
}
