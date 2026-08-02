// 全局模型配置：保存 / 删除 / 选用，全部不需要项目。
//
// 拆分依据：API Key 与模型清单本来就存在 ~/.wwriting/（secrets.json、
// model-profiles.json），跟项目无关。以前保存模型必须先有项目，是因为唯一的
// 写入口 saveModelSettingsTransaction 要写 project.yaml。这里给出一条只写全局
// 两个文件的路径，设置面板在没有项目时也能配好模型、测好连接。
//
// 与 settings-runtime.mjs 的分工：那边负责「项目内的设置」，这边负责「跨项目的
// 模型库」。api_key 一律只落 secrets.json 和 process.env，绝不写进任何项目文件。

import {
  applyLocalSecretsToEnv,
  loadLocalSecrets,
  saveLocalSecrets
} from "./local-secrets.mjs";
import {
  loadLocalModelProfiles,
  removeLocalModelProfile,
  setDefaultLocalModelProfile,
  upsertLocalModelProfile
} from "./local-model-profiles.mjs";
import { ModelConfigValidationError, validateModelConfig } from "./model-config-validation.mjs";
import { fillOfficialPricing, normalizePricing } from "./model-pricing.mjs";

export class GlobalModelSettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GlobalModelSettingsError";
    this.code = code;
  }
}

// 保存一个模型到全局清单，并把它设为默认（供新建项目直接使用）。
// candidate.api_key 为空时表示「沿用已存的密钥」，与旧的保存语义一致。
export async function saveGlobalModelProfile({
  secretsRoot,
  activeModel,
  readSecrets = loadLocalSecrets,
  writeSecrets = saveLocalSecrets,
  applySecrets = applyLocalSecretsToEnv
} = {}) {
  if (!secretsRoot || typeof secretsRoot !== "string") {
    throw new GlobalModelSettingsError("invalid_secrets_root", "secretsRoot is required.");
  }
  if (!activeModel || typeof activeModel !== "object" || Array.isArray(activeModel)) {
    throw new GlobalModelSettingsError("invalid_active_model", "active_model is required.");
  }

  const candidate = { ...activeModel };
  const transientApiKey = typeof candidate.api_key === "string" ? candidate.api_key.trim() : "";
  delete candidate.api_key;

  const validated = validateModelConfig(candidate);
  // 价格：与项目内保存同一套规则——DeepSeek / MiMo 未填项按官方人民币价补齐，
  // 用户填了就用用户的。价格无效时报错，不静默丢弃。
  let withPricing = { ...validated };
  if (candidate.pricing !== undefined && candidate.pricing !== null) {
    const filled = fillOfficialPricing(validated.model_name, validated.base_url, candidate.pricing);
    const pricing = normalizePricing(filled);
    if (!pricing) {
      throw new GlobalModelSettingsError(
        "invalid_pricing",
        "价格必须是正数：每百万 token 的输入价和输出价必填，缓存命中价可选。"
      );
    }
    withPricing = { ...validated, pricing };
  }
  return persistGlobalModel({
    secretsRoot, withPricing, transientApiKey, readSecrets, writeSecrets, applySecrets
  });
}

// 密钥先落盘再入 env，最后写清单。密钥写失败就整体失败，不会留下
// 「清单里有模型但密钥没存上」的半截状态。
async function persistGlobalModel({
  secretsRoot, withPricing, transientApiKey, readSecrets, writeSecrets, applySecrets
}) {
  const oldSecrets = await readSecrets(secretsRoot);
  if (withPricing.provider === "openai-compatible") {
    const hasExistingSecret = Boolean(oldSecrets[withPricing.api_key_env]);
    if (!hasExistingSecret && !transientApiKey) {
      throw new ModelConfigValidationError({
        api_key: "请输入 API Key，或先在 Windows 环境变量中配置。"
      });
    }
  }
  if (transientApiKey) {
    const nextSecrets = { ...oldSecrets, [withPricing.api_key_env ?? "API_KEY_ENV"]: transientApiKey };
    await writeSecrets(secretsRoot, nextSecrets);
    applySecrets(nextSecrets);
  }
  const saved = await upsertLocalModelProfile(secretsRoot, withPricing);
  const store = await loadLocalModelProfiles(secretsRoot);
  return { saved, store, activeModel: withPricing };
}

// 写回式同步：把全局清单里的最新字段刷回项目的 active_model。
//
// 「改了设置里的模型，已有项目全部跟着变」靠这一步实现。只按 model_name 匹配：
// 项目引用的模型还在全局清单里，就用清单里的地址 / 密钥变量名 / 价格等覆盖项目里
// 的旧快照；匹配不到（例如演示模型 mock-writer）就原样不动。
//
// 放在服务端读项目的入口调用，写回磁盘后，引擎、对话、CLI 再读 project.yaml 时
// 自然拿到新值，不需要逐层透传 secretsRoot。
export async function refreshProjectModelFromGlobal(projectRoot, secretsRoot, {
  readProject,
  writeProject
} = {}) {
  if (!projectRoot || !secretsRoot || !readProject || !writeProject) {
    return { changed: false, project: null };
  }
  const project = await readProject(projectRoot);
  const modelName = project?.active_model?.model_name;
  if (!modelName) return { changed: false, project };
  const store = await loadLocalModelProfiles(secretsRoot);
  const profile = store.models.find((item) => item.model_name === modelName);
  if (!profile) return { changed: false, project };

  const { id, saved_at, ...fields } = profile;
  const current = project.active_model ?? {};
  if (!differsFromCurrent(current, fields)) return { changed: false, project };
  const next = { ...project, active_model: { ...current, ...fields } };
  await writeProject(projectRoot, next);
  return { changed: true, project: next };
}

function differsFromCurrent(current, fields) {
  for (const [key, value] of Object.entries(fields)) {
    const existing = current[key];
    if (value && typeof value === "object") {
      if (JSON.stringify(existing ?? null) !== JSON.stringify(value)) return true;
      continue;
    }
    if (existing !== value) return true;
  }
  return false;
}

export async function removeGlobalModelProfile(secretsRoot, modelId) {
  const store = await removeLocalModelProfile(secretsRoot, modelId);
  if (!store) {
    throw new GlobalModelSettingsError("model_profile_not_found", `未找到已配置模型：${modelId}`);
  }
  return store;
}

export async function selectGlobalModelProfile(secretsRoot, modelId) {
  const store = await setDefaultLocalModelProfile(secretsRoot, modelId);
  if (!store) {
    throw new GlobalModelSettingsError("model_profile_not_found", `未找到已配置模型：${modelId}`);
  }
  return store;
}
