// src/core/model-reference.mjs
// 引用解析：项目 active_model 引用 → 完整配置；失败降级默认模型并附 note。
// 解析结果形状必须满足运行时消费：provider 恒为 "openai-compatible"（适配器分发依据）。

export function toRequestConfig(provider, model) {
  return {
    provider: "openai-compatible",
    provider_id: provider.id,
    model_id: model.id,
    // 保留原始尾标：窗口推导与发送剥离由 runtime 的 parseModelIdentity 统一处理
    //（model-identity.mjs 是唯一权威），此处重复剥离会丢失 [1m] 窗口信号。
    model_name: model.model_name,
    base_url: provider.base_url,
    api_format: provider.api_format,
    api_key_env: provider.api_key_env,
    ...(model.context_window ? { context_window: model.context_window } : {}),
    ...(model.max_output_tokens ? { max_output_tokens: model.max_output_tokens } : {}),
    ...(model.timeout_ms ? { timeout_ms: model.timeout_ms } : {}),
    ...(model.total_deadline_ms ? { total_deadline_ms: model.total_deadline_ms } : {}),
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
    ...(model.stream !== undefined ? { stream: model.stream } : {}),
    ...(model.cache_mode ? { cache_mode: model.cache_mode } : {}),
    ...(model.pricing ? { pricing: model.pricing } : {})
  };
}

// 显示用剥离：剥掉全部连续尾部中括号标记（与 model-identity.mjs 的
// parseModelIdentity 语义一致——只剥尾部连续 [..]，中间的中括号保留）。
export function stripWindowMarkers(modelName) {
  return String(modelName ?? "").replace(/(?:\[[^\[\]]*\])+$/u, "").trim();
}

function usable(provider, model) {
  return provider.status !== "disabled" && model.enabled !== false;
}

export function resolveDefaultModel(store) {
  const dm = store?.default_model;
  const provider = store?.providers?.find((p) => p.id === dm?.provider_id);
  const model = provider?.models?.find((m) => m.id === dm?.model_id);
  if (provider && model && usable(provider, model)) return { provider, model };
  return null;
}

// activeModel 可为引用 {provider_id, model_id} 或字面配置。
export function resolveActiveModel(activeModel, store) {
  if (activeModel === null || activeModel === undefined) {
    // 项目未配置模型 → 落到全局默认（新建项目/未选择场景）；无默认才是未配置。
    // 第十一轮（审计 M2）：兜底也必须附 note--静默用默认而 UI 无提示，与
    // 悬空/停用降级同为「UI 显示与后端实际不一致」的形状。
    const fallback = resolveDefaultModel(store);
    if (fallback) {
      return {
        model: toRequestConfig(fallback.provider, fallback.model),
        note: `工作区未选择模型，正在使用全局默认 ${stripWindowMarkers(fallback.model.model_name)}`
      };
    }
    return { model: null, note: "未配置模型" };
  }
  if (typeof activeModel !== "object") return { model: null, note: "未配置模型" };
  if (activeModel.provider === "mock") return { model: null, note: "未配置模型" };
  if (typeof activeModel.provider_id === "string" && typeof activeModel.model_id === "string") {
    const provider = store?.providers?.find((p) => p.id === activeModel.provider_id);
    const model = provider?.models?.find((m) => m.id === activeModel.model_id);
    if (provider && model && usable(provider, model)) {
      return { model: toRequestConfig(provider, model), note: null };
    }
    // 悬空 / 停用 → 降级默认
    const fallback = resolveDefaultModel(store);
    if (fallback) {
      return {
        model: toRequestConfig(fallback.provider, fallback.model),
        note: `原模型已不存在，已换成默认模型 ${stripWindowMarkers(fallback.model.model_name)}`
      };
    }
    return { model: null, note: "未配置模型" };
  }
  // 半成形引用（只有一半指针字段）按未配置处理，不落入字面透传。
  if ((activeModel.provider_id === undefined) !== (activeModel.model_id === undefined)) {
    return { model: null, note: "未配置模型" };
  }
  // 字面配置：非 mock 原样通过（未迁移的旧配置兼容）
  return { model: { ...activeModel }, note: null };
}
