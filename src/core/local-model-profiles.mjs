import path from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "./fs-utils.mjs";

const MODEL_PROFILES_FILE_NAME = "model-profiles.json";
const SCHEMA_VERSION = 1;

export async function loadLocalModelProfiles(root) {
  const filePath = modelProfilesPath(root);
  const raw = await readJson(filePath, null);
  return normalizeStore(raw);
}

export async function upsertLocalModelProfile(root, activeModel) {
  const profile = normalizeModelProfile(activeModel);
  if (!profile) return null;
  const store = await loadLocalModelProfiles(root);
  // 去重双条件：同 id（新派生 id 下同配置重存）或同身份（旧 id=modelName 的遗留
  // 条目被同身份的新配置命中时也要替换而不是新增，避免重存产生重复条目）。
  const models = store.models.filter(
    (item) => item.id !== profile.id && !sameIdentity(item, profile)
  );
  const saved = {
    ...profile,
    saved_at: new Date().toISOString()
  };
  const next = {
    schema_version: SCHEMA_VERSION,
    default_model_id: saved.id,
    models: [saved, ...models].slice(0, 24)
  };
  await ensureDir(path.resolve(root));
  await writeJsonAtomic(modelProfilesPath(root), next);
  return saved;
}

// 从全局清单里删掉一个模型。删掉的正好是默认模型时，默认顺延到剩下的第一个。
export async function removeLocalModelProfile(root, modelId) {
  const wanted = String(modelId ?? "").trim();
  if (!wanted) return null;
  const store = await loadLocalModelProfiles(root);
  const models = store.models.filter((item) => item.id !== wanted && item.model_name !== wanted);
  if (models.length === store.models.length) return null;
  const next = {
    schema_version: SCHEMA_VERSION,
    default_model_id: models.some((item) => item.id === store.default_model_id)
      ? store.default_model_id
      : models[0]?.id ?? null,
    models
  };
  await ensureDir(path.resolve(root));
  await writeJsonAtomic(modelProfilesPath(root), next);
  return next;
}

// 只挪默认指针，不动模型字段——清单里「选用某个模型」走这里。
export async function setDefaultLocalModelProfile(root, modelId) {
  const wanted = String(modelId ?? "").trim();
  if (!wanted) return null;
  const store = await loadLocalModelProfiles(root);
  const target = store.models.find((item) => item.id === wanted || item.model_name === wanted);
  if (!target) return null;
  const next = { ...store, default_model_id: target.id };
  await ensureDir(path.resolve(root));
  await writeJsonAtomic(modelProfilesPath(root), next);
  return next;
}

export async function getDefaultLocalModelProfile(root) {
  const store = await loadLocalModelProfiles(root);
  return store.models.find((model) => model.id === store.default_model_id) ?? store.models[0] ?? null;
}

export async function findLocalModelProfile(root, modelId) {
  const wanted = String(modelId ?? "").trim();
  if (!wanted) return null;
  const store = await loadLocalModelProfiles(root);
  return store.models.find((model) => model.id === wanted || model.model_name === wanted) ?? null;
}

function modelProfilesPath(root) {
  return path.join(path.resolve(root), MODEL_PROFILES_FILE_NAME);
}

function normalizeStore(raw) {
  const models = Array.isArray(raw?.models)
    ? raw.models.map(normalizeModelProfile).filter(Boolean)
    : [];
  const seen = new Set();
  const unique = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    unique.push(model);
  }
  const defaultModelId = typeof raw?.default_model_id === "string" && seen.has(raw.default_model_id)
    ? raw.default_model_id
    : unique[0]?.id ?? null;
  return {
    schema_version: SCHEMA_VERSION,
    default_model_id: defaultModelId,
    models: unique
  };
}

function normalizeModelProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const provider = stringValue(value.provider);
  const modelName = stringValue(value.model_name);
  if (!provider || !modelName) return null;
  if (provider === "mock") return null;
  const baseUrl = optionalString(value.base_url);
  const profile = {
    // 模型身份 = provider + model_name + base_url：同一模型 ID 在不同厂商/网关下
    // 是不同配置，必须可并存（修复 2026-08-11：旧实现 id=modelName，同名不同
    // base_url 的第二次保存会把第一条覆盖掉，用户自定义的同 ID 模型存不进去）。
    // id 只作清单内唯一键（默认指针/选用/删除），不含用户可见语义。
    id: profileId(modelName, baseUrl),
    provider,
    model_name: modelName
  };
  if (baseUrl) profile.base_url = baseUrl;
  copyOptional(profile, value, "api_key_env");
  copyOptional(profile, value, "cache_mode");
  copyOptional(profile, value, "max_context_tokens");
  copyOptional(profile, value, "max_output_tokens");
  copyOptional(profile, value, "timeout_ms");
  copyOptional(profile, value, "total_deadline_ms");
  copyOptional(profile, value, "temperature");
  if (value.stream !== undefined) profile.stream = value.stream === true;
  if (value.pricing && typeof value.pricing === "object" && !Array.isArray(value.pricing)) {
    profile.pricing = { ...value.pricing };
  }
  if (typeof value.saved_at === "string") profile.saved_at = value.saved_at;
  return profile;
}

// 清单内唯一键：优先 model_name@规范化 base_url（同 ID 不同网关各自成条）；
// 无 base_url 时退回 model_name（与旧清单条目兼容）。base_url 只做尾斜杠/大小写
// 归一化用于派生 id——真实请求地址仍用 profile.base_url 原文，不受影响。
function profileId(modelName, baseUrl) {
  if (!baseUrl) return modelName;
  return `${modelName}@${baseUrl.replace(/\/+$/u, "").toLowerCase()}`;
}

// 条目是否与待保存配置同一身份（provider+model_name+base_url+api_key_env 全同
// 才算同一模型：重存同配置=更新；改 base_url/密钥变量=新增条目）。
function sameIdentity(left, right) {
  return (
    left.provider === right.provider &&
    left.model_name === right.model_name &&
    (left.base_url ?? "") === (right.base_url ?? "") &&
    (left.api_key_env ?? "") === (right.api_key_env ?? "")
  );
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

// 与 stringValue 相同但允许空串返回 null（normalizeModelProfile 需要区分
//「未填 base_url」与「填了空串」——统一视为未填）。
function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function copyOptional(target, source, key) {
  if (source[key] === undefined || source[key] === null || source[key] === "") return;
  target[key] = source[key];
}
