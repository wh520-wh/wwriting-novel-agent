// src/core/model-provider-store.mjs
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureDir, readJson, writeJsonAtomic } from "./fs-utils.mjs";
import { createMutex } from "./async-utils.mjs";
import { MODEL_PRESETS as PRESET_DEFINITIONS } from "./model-presets.mjs";

const PROVIDERS_FILE = "model-profiles.json";
export const SCHEMA_VERSION = 2;
export const ALLOWED_API_FORMATS = new Set(["openai-chat-completions"]);
const DEFAULT_CONTEXT_WINDOW = 256000;

// Task 19（spec 4.3 #12）：store 级单一 mutex 串行化「读-判-迁移-写」整条路径。
// loadProviderStore 的 v1→v2 迁移也走同一把锁（见 loadProviderStoreUnlocked），
// 两个并发 load/migrate 不会各自迁移出不同 ID 互相覆盖——后到者读到已落盘的
// v2，迁移只发生一次。
const mutex = createMutex();

export function newProviderId() { return `pv_${randomUUID().replace(/-/gu, "").slice(0, 16)}`; }
export function newModelId() { return `m_${randomUUID().replace(/-/gu, "").slice(0, 16)}`; }

// Task 19：迁移专用确定性 ID。v1→v2 迁移产出的 provider/model id 从规范化
// identity 派生（provider: 去尾斜杠 + 小写的 base_url；model: 同一 base_url +
// model_name），相同 v1 输入跨运行/跨进程生成相同 IDs——并发迁移与项目引用
//（project-model-migration.mjs）都不再产生悬空引用。用户运行期新建的
// provider/model（upsert* 路径）仍用随机 ID（newProviderId/newModelId）。
function stableId(prefix, identity) {
  return `${prefix}${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16)}`;
}
function normalizedBaseUrlKey(url) {
  return String(url).replace(/\/+$/u, "").toLowerCase();
}
function providerStableId(baseUrl) {
  return stableId("pv_", normalizedBaseUrlKey(baseUrl));
}
function modelStableId(baseUrl, modelName) {
  // \u0000 分隔防 base_url/model_name 拼接歧义（如 "a"+"b" 与 "ab"+""）
  return stableId("m_", `${normalizedBaseUrlKey(baseUrl)}\u0000${modelName}`);
}

function storePath(root) { return path.join(path.resolve(root), PROVIDERS_FILE); }
function emptyStore() { return { schema_version: SCHEMA_VERSION, default_model: null, providers: [] }; }

export function normalizeProviderStore(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const providers = [];
  const seenIds = new Set();
  for (const item of Array.isArray(raw.providers) ? raw.providers : []) {
    const provider = normalizeProvider(item);
    if (!provider || seenIds.has(provider.id)) continue;
    seenIds.add(provider.id);
    providers.push(provider);
  }
  let defaultModel = null;
  const dm = raw.default_model;
  if (dm && typeof dm === "object" && !Array.isArray(dm)) {
    const provider = providers.find((p) => p.id === dm.provider_id);
    const model = provider?.models.find((m) => m.id === dm.model_id);
    if (provider && model) defaultModel = { provider_id: provider.id, model_id: model.id };
  }
  const result = { schema_version: SCHEMA_VERSION, default_model: defaultModel, providers };
  // 预设种子追踪字段：跨归一化保留（否则 ensurePresetProviders 无法区分
  // 「用户删过」与「从未种过」，删除过的预设会复活）。仅接受合法字符串数组。
  if (Array.isArray(raw.seeded_preset_ids)) {
    result.seeded_preset_ids = [...new Set(raw.seeded_preset_ids.filter((x) => typeof x === "string" && x.length > 0))];
  }
  return result;
}

function normalizeProvider(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = stringValue(value.name);
  const baseUrl = stringValue(value.base_url);
  if (!name || !baseUrl) return null;
  if (stringValue(value.provider) === "mock") return null;
  const apiFormat = stringValue(value.api_format) || "openai-chat-completions";
  if (!ALLOWED_API_FORMATS.has(apiFormat)) return null;
  const models = [];
  const seen = new Set();
  for (const item of Array.isArray(value.models) ? value.models : []) {
    const model = normalizeModel(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return {
    id: stringValue(value.id) || newProviderId(),
    name,
    type: value.type === "builtin" ? "builtin" : "custom",
    status: value.status === "disabled" ? "disabled" : "enabled",
    base_url: baseUrl.replace(/\/+$/u, ""),
    api_format: apiFormat,
    api_key_env: stringValue(value.api_key_env),
    models,
    created_at: value.created_at ?? new Date().toISOString(),
    updated_at: value.updated_at ?? new Date().toISOString()
  };
}

function normalizeModel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const modelName = stringValue(value.model_name);
  if (!modelName) return null;
  const hasOneM = /\[1m\]$/iu.test(modelName);
  const model = {
    id: stringValue(value.id) || newModelId(),
    model_name: modelName,
    enabled: value.enabled !== false,
    context_window: positiveInt(value.context_window) ?? (hasOneM ? 1000000 : DEFAULT_CONTEXT_WINDOW)
  };
  for (const key of ["max_output_tokens", "timeout_ms", "total_deadline_ms"]) {
    const n = positiveInt(value[key]);
    if (n) model[key] = n;
  }
  if (value.temperature !== undefined) {
    const t = Number(value.temperature);
    if (Number.isFinite(t) && t >= 0 && t <= 2) model.temperature = t;
  }
  if (value.stream !== undefined) model.stream = value.stream === true;
  const cacheMode = stringValue(value.cache_mode);
  if (cacheMode) model.cache_mode = cacheMode;
  if (value.pricing && typeof value.pricing === "object" && !Array.isArray(value.pricing)) {
    model.pricing = { ...value.pricing };
  }
  return model;
}

function stringValue(v) { return typeof v === "string" && v.trim() ? v.trim() : ""; }
function positiveInt(v) { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }

// 写入口：本函数仅落盘、不含互斥。锁契约见 loadProviderStore 注释。
export async function saveProviderStore(root, store) {
  await ensureDir(path.resolve(root));
  await writeJsonAtomic(storePath(root), store);
  return store;
}

// 单一写入口：串行化读-改-写。fn(store) 必须返回 { store, ...rest }。
// 落盘契约：仅当 result.store 存在 且 result.changed !== false 时写盘——
// fn 返回 changed: false 表示「无变化不落盘」（如 ensurePresetProviders 的无缺种
// 分支，只读路径不能退化为写路径）。既有调用方（upsertProvider 等）不设
// changed → 默认按 changed 落盘，行为不变。
// 内部读用 loadProviderStoreUnlocked（不重复加锁），把「读-判-迁移-写」的
// 迁移路径与普通读-改-写统一收在同一把 mutex 下。导出供外部模块（如
// model-presets.mjs 的 ensurePresetProviders 种子路径）复用同一把锁。
export async function withStoreLock(root, fn) {
  return mutex.run(async () => {
    const store = await loadProviderStoreUnlocked(root);
    const result = await fn(store);
    if (result.store && result.changed !== false) await saveProviderStore(root, result.store);
    return result;
  });
}

async function readRawStore(root) {
  let raw;
  try {
    raw = await readJson(storePath(root), null);
  } catch (error) {
    // readJson 仅对「文件缺失」返回 fallback；JSON 损坏时 JSON.parse 抛
    // SyntaxError，按空清单重建（真实 IO 错误仍继续抛出）。
    if (error instanceof SyntaxError) return emptyStore();
    throw error;
  }
  return raw ?? emptyStore();
}

// 不加锁的读-判-迁移-写（调用方必须已持有 mutex）。v1 命中时迁移并写回：
// 先规范化再落盘，落盘文件与内存返回同形状（字节等价），重读路径返回一致
// ——两个并发 load/migrate 的返回与最终文件三者在字节层面相同（Task 19 并发契约）。
async function loadProviderStoreUnlocked(root) {
  const raw = await readRawStore(root);
  if (raw?.schema_version === 1) {
    const migrated = normalizeProviderStore(migrateV1Store(raw, PRESET_DEFINITIONS)) ?? emptyStore();
    await saveProviderStore(root, migrated);
    return migrated;
  }
  return normalizeProviderStore(raw) ?? emptyStore();
}

// 读-改-写必须走带锁写入口（upsertProvider/removeProvider/upsertModel/removeModel/
// setDefaultModel/loadProviderStore），外部直接 load + save 会绕过互斥，并发写方
// 可能互相覆盖。loadProviderStore 整个「读-判-迁移-写」也在 mutex 内（Task 19）：
// v1→v2 首次迁移只发生一次，迁移 ID 确定性派生，并发 load/migrate 字节等价。
export async function loadProviderStore(root) {
  return mutex.run(() => loadProviderStoreUnlocked(root));
}

export async function upsertProvider(root, input) {
  return withStoreLock(root, (store) => {
    const provider = normalizeProvider({ ...input, provider: input?.provider ?? "openai-compatible" });
    if (!provider) {
      throw new Error("invalid_provider: 供应商配置无效（mock 不允许入清单，api_format 仅支持 openai-chat-completions）");
    }
    const existing = store.providers.find((p) => p.id === provider.id);
    if (existing && input?.models === undefined) {
      // 字段级更新：未显式携带 models 时保留既有模型，避免整包替换把模型清空
      provider.models = existing.models;
    }
    const others = store.providers.filter((p) => p.id !== provider.id);
    if (others.some((p) => p.name === provider.name)) {
      throw new Error("duplicate_provider_name: 供应商名称已存在");
    }
    // 已存在则原位替换（保持列表顺序），仅新供应商才放表头
    const providers = existing
      ? store.providers.map((p) => (p.id === provider.id ? provider : p))
      : [provider, ...others];
    const next = { ...store, providers };
    return { provider, store: next };
  });
}

export async function removeProvider(root, providerId) {
  return withStoreLock(root, (store) => {
    const providers = store.providers.filter((p) => p.id !== providerId);
    const removed = providers.length !== store.providers.length;
    if (!removed) return { removed: false, store: null }; // 无变化不落盘
    const next = { ...store, providers };
    if (next.default_model?.provider_id === providerId) next.default_model = null;
    return { removed, store: next };
  });
}

export async function upsertModel(root, providerId, modelInput) {
  return withStoreLock(root, (store) => {
    const provider = store.providers.find((p) => p.id === providerId);
    if (!provider) throw new Error("provider_not_found");
    const model = normalizeModel(modelInput);
    if (!model) throw new Error("invalid_model");
    const others = provider.models.filter((m) => m.id !== model.id);
    const nextProvider = { ...provider, models: [model, ...others], updated_at: new Date().toISOString() };
    const providers = store.providers.map((p) => (p.id === providerId ? nextProvider : p));
    return { model, provider: nextProvider, store: { ...store, providers } };
  });
}

export async function removeModel(root, providerId, modelId) {
  return withStoreLock(root, (store) => {
    const provider = store.providers.find((p) => p.id === providerId);
    if (!provider) throw new Error("provider_not_found");
    const models = provider.models.filter((m) => m.id !== modelId);
    const removed = models.length !== provider.models.length;
    if (!removed) return { removed: false, store: null }; // 无变化不落盘
    const nextProvider = { ...provider, models, updated_at: new Date().toISOString() };
    const providers = store.providers.map((p) => (p.id === providerId ? nextProvider : p));
    const next = { ...store, providers };
    // model id 是供应商局部的，须同时匹配 provider_id 才清默认指针
    if (next.default_model?.provider_id === providerId && next.default_model.model_id === modelId) {
      next.default_model = null;
    }
    return { removed, store: next };
  });
}

export async function setDefaultModel(root, providerId, modelId) {
  return withStoreLock(root, (store) => {
    const provider = store.providers.find((p) => p.id === providerId);
    const model = provider?.models.find((m) => m.id === modelId);
    if (!model) throw new Error("model_not_found");
    // 停用即不能用：停用模型不得设为默认（前端「设为默认」按钮同步置灰，双端一致）
    if (model.enabled === false) throw new Error("model_disabled: 已停用的模型不能设为默认。");
    return { store: { ...store, default_model: { provider_id: providerId, model_id: modelId } } };
  });
}

export async function getDefaultModel(root) {
  const store = await loadProviderStore(root);
  return findModelById(root, store.default_model?.provider_id, store.default_model?.model_id);
}

export async function findModelById(root, providerId, modelId) {
  const store = await loadProviderStore(root);
  const provider = store.providers.find((p) => p.id === providerId);
  const model = provider?.models.find((m) => m.id === modelId);
  return provider && model ? { provider, model } : null;
}

// 按身份匹配（迁移用）：provider openai-compatible + base_url + model_name。
export async function findModelByConfig(root, config = {}) {
  const store = await loadProviderStore(root);
  const baseUrl = String(config.base_url ?? "").replace(/\/+$/u, "").toLowerCase();
  const modelName = String(config.model_name ?? "");
  for (const provider of store.providers) {
    if (provider.status === "disabled") continue;
    if (String(provider.base_url).replace(/\/+$/u, "").toLowerCase() !== baseUrl) continue;
    const model = provider.models.find((m) => m.model_name === modelName && m.enabled !== false);
    if (model) return { provider, model };
  }
  return null;
}

// 归一化匹配键：base_url 去尾斜杠 + 小写；命中官方地址仅精确匹配官方按量端点
// hostname（api.deepseek.com / api.xiaomimimo.com）。与 deepseek-detection.mjs 的
// 子串口径不同（其覆盖 token-plan-*.xiaomimimo.com 订阅端点）；迁移按精确匹配
// 更安全——避免把订阅端点并入按量预设。
function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } }
function isOfficialBaseUrl(url, preset) {
  const host = hostOf(url);
  if (!host) return false;
  return host === hostOf(preset.base_url);
}

// v1 → v2 纯函数迁移。Task 19 确定性契约：相同输入必然产出相同输出（独立
// 分支 provider/model ID 从规范化 identity 派生，见 providerStableId/
// modelStableId；不依赖随机源）。配合 loadProviderStore 的 store 级 mutex，
// 并发/多次迁移结果字节等价，项目引用永不悬空。
export function migrateV1Store(raw, presets = []) {
  const store = emptyStore();
  const oldModels = Array.isArray(raw?.models) ? raw.models : [];
  const usedNames = new Set();
  const uniqueName = (base) => {
    let name = base || "未命名供应商";
    let n = 2;
    while (usedNames.has(name)) { name = `${base || "未命名供应商"}（${n}）`; n += 1; }
    usedNames.add(name);
    return name;
  };
  const presetProviders = new Map(); // presetId -> provider
  const standalone = new Map(); // base_url -> provider

  for (const old of oldModels) {
    const baseUrl = stringValue(old.base_url);
    const modelName = stringValue(old.model_name);
    if (!baseUrl || !modelName) continue;
    const preset = presets.find((p) => isOfficialBaseUrl(baseUrl, p));
    if (preset) {
      if (!presetProviders.has(preset.id)) {
        presetProviders.set(preset.id, {
          id: preset.id,
          name: preset.name,
          type: "custom",
          status: "enabled",
          base_url: preset.base_url,
          api_format: "openai-chat-completions",
          api_key_env: preset.api_key_env,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          models: []
        });
      }
      const provider = presetProviders.get(preset.id);
      const presetModelDef = preset.models.find((m) => m.model_name === modelName);
      if (!provider.models.some((m) => m.model_name === modelName)) {
        // v1 旧条目在前、预设未出现模型按种子形态补全在后（顺序为观感，无强契约）
        provider.models.unshift({
          // 旧 v1 约定 id === modelName，保留原 id 让 default_model_id 直接命中；
          // 缺失时才回退到预设种子 id 形态。
          id: stringValue(old.id) || `m_${preset.id}_${modelName}`,
          model_name: modelName,
          enabled: true,
          context_window: positiveInt(old.max_context_tokens) ?? (/\[1m\]$/iu.test(modelName) ? 1000000 : 256000),
          ...(presetModelDef?.pricing ? { pricing: { ...presetModelDef.pricing } } : {})
        });
      }
      const merged = provider.models.find((m) => m.model_name === modelName);
      copyRuntimeFields(merged, old); // 用户参数覆盖
      continue;
    }
    // Minor 3（Task 19 审查）：合并键与 ID 派生键同源（normalizedBaseUrlKey）——
    // 旧实现用 baseUrl.toLowerCase()（保留尾斜杠），仅差尾斜杠的条目派生相同
    // provider ID 却落不同合并桶，随后被 normalizeProviderStore 的 seenIds 去重
    // 静默丢弃（连同其 models）。统一后尾斜杠变体在迁移期即合并，模型完整保留。
    const key = normalizedBaseUrlKey(baseUrl);
    if (!standalone.has(key)) {
      standalone.set(key, {
        // Task 19：ID 从规范化 base_url 派生（确定性，跨运行/跨进程稳定）
        id: providerStableId(baseUrl),
        name: uniqueName(stringValue(old.provider_label) || stringValue(old.provider)),
        type: "custom",
        status: "enabled",
        base_url: baseUrl,
        api_format: "openai-chat-completions",
        api_key_env: stringValue(old.api_key_env),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        models: []
      });
    }
    const provider = standalone.get(key);
    let model = provider.models.find((m) => m.model_name === modelName);
    if (!model) {
      model = {
        // Task 19：ID 从 base_url + model_name 派生（确定性）
        id: modelStableId(baseUrl, modelName),
        model_name: modelName,
        enabled: true,
        context_window: positiveInt(old.max_context_tokens) ?? (/\[1m\]$/iu.test(modelName) ? 1000000 : 256000)
      };
      provider.models.push(model);
    }
    copyRuntimeFields(model, old); // 同 base_url + model_name 重复条目也合并，用户参数以最后一次为准（与官方分支一致）
  }
  // 命中的预设补全其余模型（旧 v1 条目置前，未出现的预设模型追加在后），
  // 与 ensurePresetProviders 的种子形态一致。
  for (const preset of presets) {
    const provider = presetProviders.get(preset.id);
    if (!provider) continue;
    for (const presetModel of preset.models) {
      if (provider.models.some((m) => m.model_name === presetModel.model_name)) continue;
      provider.models.push({
        id: `m_${preset.id}_${presetModel.model_name}`,
        model_name: presetModel.model_name,
        enabled: true,
        context_window: /\[1m\]$/iu.test(presetModel.model_name) ? 1000000 : 256000,
        ...(presetModel.pricing ? { pricing: { ...presetModel.pricing } } : {})
      });
    }
  }
  store.providers = [...presetProviders.values(), ...standalone.values()];
  // 迁移即视为已种过全部预设：记录 seeded_preset_ids，用户删除任一预设后
  // ensurePresetProviders 不再复活（删除不复活契约），也避免迁移后强补
  // 未出现过的预设（与删除不复活同源：迁移结果就是完整的预设生命周期状态）。
  store.seeded_preset_ids = presets.map((p) => p.id);
  // 默认指针映射：v1 default_model_id 匹配 model_name（旧 id=modelName 约定）或条目 id
  const defaultId = stringValue(raw?.default_model_id);
  if (defaultId) {
    for (const provider of store.providers) {
      const hit = provider.models.find((m) => m.id === defaultId || m.model_name === defaultId);
      if (hit) { store.default_model = { provider_id: provider.id, model_id: hit.id }; break; }
    }
  }
  if (!store.default_model && store.providers.length > 0 && store.providers[0].models.length > 0) {
    const first = store.providers[0];
    store.default_model = { provider_id: first.id, model_id: first.models[0].id };
  }
  return store;
}

function copyRuntimeFields(target, old) {
  for (const key of ["max_output_tokens", "timeout_ms", "total_deadline_ms"]) {
    const n = positiveInt(old[key]);
    if (n) target[key] = n;
  }
  if (old.temperature !== undefined) {
    const t = Number(old.temperature);
    if (Number.isFinite(t) && t >= 0 && t <= 2) target.temperature = t;
  }
  if (old.stream !== undefined) target.stream = old.stream === true;
  const cacheMode = stringValue(old.cache_mode);
  if (cacheMode) target.cache_mode = cacheMode;
  if (old.pricing && typeof old.pricing === "object" && !Array.isArray(old.pricing)) {
    target.pricing = { ...old.pricing };
  }
}
