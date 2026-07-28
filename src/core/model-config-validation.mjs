import { normalizePricing } from "./model-pricing.mjs";

export class ModelConfigValidationError extends Error {
  constructor(fields) {
    const detail = Object.values(fields || {}).join("; ");
    super(detail ? `模型配置不完整: ${detail}` : "模型配置不完整");
    this.name = "ModelConfigValidationError";
    this.code = "configuration_missing";
    this.fields = fields;
  }
}

export function validateModelConfig(input) {
  const config = {
    provider: String(input?.provider ?? "").trim(),
    model_name: String(input?.model_name ?? "").trim(),
    base_url: String(input?.base_url ?? "").trim().replace(/\/+$/, ""),
    api_key_env: String(input?.api_key_env ?? "").trim(),
  };
  if (input?.pricing !== undefined && input.pricing !== null) {
    const pricing = normalizePricing(input.pricing);
    if (pricing) config.pricing = pricing;
  }
  if (input?.stream !== undefined) config.stream = input.stream === true;
  if (input?.cache_mode !== undefined) config.cache_mode = String(input.cache_mode).trim();
  for (const field of ["max_context_tokens", "max_output_tokens"]) {
    if (input?.[field] !== undefined) {
      const value = Number(input[field]);
      if (Number.isInteger(value) && value > 0) config[field] = value;
    }
  }
  const fields = {};
  if (!config.provider) fields.provider = "请选择模型提供商";
  if (!config.model_name) fields.model_name = "请输入模型名称";
  if (config.provider === "openai-compatible") {
    if (!config.base_url) fields.base_url = "请输入兼容接口地址";
    if (!config.api_key_env) fields.api_key_env = "请输入 API Key 环境变量名";
  }
  if (config.base_url) {
    try {
      const url = new URL(config.base_url);
      if (!["http:", "https:"].includes(url.protocol)) {
        fields.base_url = "接口地址必须使用 HTTP 或 HTTPS";
      }
    } catch {
      fields.base_url = "接口地址格式无效";
    }
  }
  if (config.api_key_env && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.api_key_env)) {
    fields.api_key_env = "API Key 环境变量名格式无效";
  }
  if (input?.pricing !== undefined && input.pricing !== null && !config.pricing) {
    fields.pricing = "价格必须是正数：每百万 token 的输入价和输出价必填，缓存命中价可选。";
  }
  for (const field of ["max_context_tokens", "max_output_tokens"]) {
    if (input?.[field] !== undefined && config[field] === undefined) {
      fields[field] = "必须是正整数";
    }
  }
  if (Object.keys(fields).length > 0) {
    throw new ModelConfigValidationError(fields);
  }
  return config;
}
