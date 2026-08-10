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
  const models = store.models.filter((item) => item.id !== profile.id);
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
  const profile = {
    id: modelName,
    provider,
    model_name: modelName
  };
  copyOptional(profile, value, "base_url");
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

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function copyOptional(target, source, key) {
  if (source[key] === undefined || source[key] === null || source[key] === "") return;
  target[key] = source[key];
}
