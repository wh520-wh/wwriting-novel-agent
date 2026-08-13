// src/core/model-presets.mjs
import { OFFICIAL_PRICING } from "../shared/official-pricing.mjs";
import { loadProviderStore, saveProviderStore, withStoreLock } from "./model-provider-store.mjs";

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
//
// Task 19（spec 4.3 #12）：缺省读-判-种-写整体放进 store 级 mutex（withStoreLock）
// ——ensurePresetProviders 在每个 GET /api/settings/providers 与 providerOf 之前
// 都会调用，若不带锁，首次播种期间并发的 upsertProvider 落盘会被陈旧快照覆盖
// （先读空清单→种子写回会丢掉并发新增的供应商）。锁内重新读取最新清单再判定，
// 与 upsertProvider/removeProvider 等写入口互斥。load/save 注入 seam 仅测试用：
// 注入后走注入函数（调用方自担串行），行为与旧版一致。
export async function ensurePresetProviders(root, { load = loadProviderStore, save = saveProviderStore } = {}) {
  // 读-判-种-写核心：fn(store) → { store, seeded, changed }。无缺种时
  // changed:false——配合 withStoreLock 的落盘契约（changed !== false 才写盘），
  // 每次 GET /api/settings/providers / providerOf 的只读清单路径不产生写盘。
  const seed = async (store) => {
    const seededIds = new Set(store.seeded_preset_ids ?? []);
    const missing = MODEL_PRESETS.filter(
      (preset) => !store.providers.some((p) => p.id === preset.id) && !seededIds.has(preset.id)
    );
    if (missing.length === 0) return { store, seeded: 0, changed: false };
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
          ...(m.pricing ? { pricing: { ...m.pricing } } : {})
        }))
      })),
      ...store.providers
    ];
    const next = {
      ...store,
      seeded_preset_ids: [...new Set([...seededIds, ...missing.map((preset) => preset.id)])],
      providers
    };
    return { store: next, seeded: missing.length, changed: true };
  };
  if (load === loadProviderStore && save === saveProviderStore) {
    return withStoreLock(root, seed);
  }
  // 注入 seam（测试）：读-种-写均走注入函数，不加锁；changed 契约与锁内一致
  const result = await seed(await load(root));
  if (result.store && result.changed !== false) await save(root, result.store);
  return result;
}
