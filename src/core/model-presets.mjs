// src/core/model-presets.mjs
import { OFFICIAL_PRICING } from "../shared/official-pricing.mjs";
import { loadProviderStore, saveProviderStore } from "./model-provider-store.mjs";

function presetModel(modelName) {
  const pricing = OFFICIAL_PRICING[modelName];
  return pricing
    ? { model_name: modelName, enabled: true, pricing: { ...pricing, currency: pricing.currency ?? "CNY" } }
    : { model_name: modelName, enabled: true };
}

export const MODEL_PRESETS = [
  {
    id: "deepseek",
    name: "DeepSeek 官方",
    base_url: "https://api.deepseek.com",
    api_format: "openai-chat-completions",
    api_key_env: "DEEPSEEK_API_KEY",
    models: [presetModel("deepseek-v4-pro"), presetModel("deepseek-v4-flash")]
  },
  {
    id: "mimo",
    name: "小米 MiMo 官方",
    base_url: "https://api.xiaomimimo.com/v1",
    api_format: "openai-chat-completions",
    api_key_env: "XIAOMI_MIMO_API_KEY",
    models: [presetModel("mimo-v2.5-pro"), presetModel("mimo-v2.5")]
  }
];

// 种子规则：清单中无该预设 id 且「从未种过」才写入（删除不复活）——
// seeded_preset_ids 记录已种过的预设 id，用户删除后不重新种。
// 返回 { store, seeded }。
export async function ensurePresetProviders(root, { load = loadProviderStore, save = saveProviderStore } = {}) {
  const store = await load(root);
  const seededIds = new Set(store.seeded_preset_ids ?? []);
  const missing = MODEL_PRESETS.filter(
    (preset) => !store.providers.some((p) => p.id === preset.id) && !seededIds.has(preset.id)
  );
  if (missing.length === 0) return { store, seeded: 0 };
  const providers = [
    ...missing.map((preset) => ({
      id: preset.id,
      name: preset.name,
      type: "custom",
      status: "enabled",
      base_url: preset.base_url,
      api_format: preset.api_format,
      api_key_env: preset.api_key_env,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      models: preset.models.map((m) => ({
        id: `m_${preset.id}_${m.model_name}`,
        model_name: m.model_name,
        enabled: true,
        context_window: /\[1m\]$/iu.test(m.model_name) ? 1000000 : 256000,
        ...(m.pricing ? { pricing: m.pricing } : {})
      }))
    })),
    ...store.providers
  ];
  const next = {
    ...store,
    seeded_preset_ids: [...new Set([...seededIds, ...missing.map((preset) => preset.id)])],
    providers
  };
  await save(root, next);
  return { store: next, seeded: missing.length };
}
