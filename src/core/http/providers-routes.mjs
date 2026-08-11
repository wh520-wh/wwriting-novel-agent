// src/core/http/providers-routes.mjs
// 供应商/模型两级 CRUD + 拉取模型中转。handler 约定见 router.mjs：
// handler({ request, response, params, query, body }) → 对象即 200 JSON。
import { HttpError } from "../http-error.mjs";
import { loadLocalSecrets, saveLocalSecrets } from "../local-secrets.mjs";
import {
  upsertProvider, removeProvider, upsertModel, removeModel, setDefaultModel
} from "../model-provider-store.mjs";
import { ensurePresetProviders } from "../model-presets.mjs";
import { writingRequiredCapabilitiesOk } from "../model/capabilities.mjs";

// 与 src/core/local-secrets.mjs 的 ENV_NAME 保持一致：saveLocalSecrets 会经
// normalizeSecrets 静默丢弃非法环境变量名，写前先校验，避免密钥静默不落盘。
const API_KEY_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function createProvidersRoutes({ secretsRoot }) {
  const storeList = async () => {
    const { store } = await ensurePresetProviders(secretsRoot);
    return store;
  };
  const providerOf = async (id) => {
    const store = await storeList();
    const provider = store.providers.find((p) => p.id === id);
    if (!provider) throw new HttpError(404, "provider_not_found", "供应商不存在");
    return provider;
  };
  // store（model-provider-store）的领域错误抛「code: message」格式的普通 Error
  //（如 "duplicate_provider_name: 供应商名称已存在"），不带 .code 属性；这里从
  // message 前缀提取 code 映射 400，与既有 store 错误约定（tests/model-provider-
  // store.test.mjs 按前缀匹配）保持一致。HttpError 原样透传（404/499 等语义不丢）。
  // 无 code 前缀的错误（意外失败，如编程错误）不包成 400，原样抛出，交由
  // router 的 errorToHttp 映射为 500。
  const wrap = (fn) => async (ctx) => {
    try {
      return await fn(ctx);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = typeof error?.message === "string" ? error.message : "";
      const match = /^([a-z][a-z0-9_]*):/u.exec(message);
      if (!match) throw error; // 无 code 前缀：非 store 领域错误，原样抛出（→ 500）
      throw new HttpError(400, match[1], message);
    }
  };
  // 行为保留（first-principles：能力门禁不随重构丢失）：保存/设默认的模型
  // 必须支持工具调用，否则写作引擎跑不动，保存时直接拒绝。
  const assertWritingCapable = (provider, modelName) => {
    if (!writingRequiredCapabilitiesOk({ provider: "openai-compatible", model_name: modelName, base_url: provider.base_url })) {
      throw new HttpError(400, "model_unsupported", "该模型不支持工具调用，无法用于小说写作。");
    }
  };

  return {
    // 前端契约：GET 返回扁平 store（providers / default_model 顶层字段），
    // 突变端点（POST/PATCH/remove）返回嵌套 store 字段。
    "GET /api/settings/providers": wrap(async () => ({ ok: true, ...(await storeList()) })),

    // 创建 body 中的 api_key 有意忽略（前端契约：创建不带密钥，创建后 PATCH 设置）。
    "POST /api/settings/providers": wrap(async ({ body }) => {
      const { provider, store } = await upsertProvider(secretsRoot, body ?? {});
      return { ok: true, provider, store };
    }),

    // 写序契约：secrets 先写、upsert 后写。若 upsert 失败（如重名），secrets.json
    // 留有一个惰性孤儿值，无损坏（反向顺序更糟：upsert 先落盘后密钥写入失败，
    // 会留下一个指向缺失密钥的供应商）。
    "PATCH /api/settings/providers/:id": wrap(async ({ params, body }) => {
      const current = await providerOf(params.id);
      const payload = { ...(body ?? {}) };
      const transientKey = typeof payload.api_key === "string" ? payload.api_key.trim() : "";
      delete payload.api_key;
      if (transientKey) {
        const envName = String(payload.api_key_env ?? current.api_key_env ?? "").trim();
        if (!envName) throw new HttpError(400, "invalid_api_key_env", "请先填写 API 密钥环境变量名。");
        if (!API_KEY_ENV_NAME.test(envName)) throw new HttpError(400, "invalid_api_key_env", "API 密钥环境变量名只能包含字母、数字、下划线且不能以数字开头。");
        const secrets = await loadLocalSecrets(secretsRoot);
        await saveLocalSecrets(secretsRoot, { ...secrets, [envName]: transientKey });
      }
      const merged = { ...current, ...payload, id: current.id };
      const { provider, store } = await upsertProvider(secretsRoot, merged);
      return { ok: true, provider, store, secret_saved: Boolean(transientKey) };
    }),

    "POST /api/settings/providers/:id/remove": wrap(async ({ params }) => {
      const { removed, store } = await removeProvider(secretsRoot, params.id);
      if (!removed) throw new HttpError(404, "provider_not_found", "供应商不存在");
      return { ok: true, store };
    }),

    // 能力门禁只约束「保存/设默认」路径（下方与 default 端点）；供应商体携带的
    // 内嵌 models 数组可绕过门禁，属有意为之（前端契约：供应商体不含内嵌 models）。
    "POST /api/settings/providers/:id/models": wrap(async ({ params, body }) => {
      const provider = await providerOf(params.id);
      const modelName = String(body?.model_name ?? "").trim();
      if (!modelName) throw new HttpError(400, "invalid_model", "请填写模型名称。");
      assertWritingCapable(provider, modelName);
      const { model, provider: nextProvider, store } = await upsertModel(secretsRoot, params.id, body ?? {});
      return { ok: true, model, provider: nextProvider, store };
    }),

    "PATCH /api/settings/providers/:id/models/:modelId": wrap(async ({ params, body }) => {
      const provider = await providerOf(params.id);
      const current = provider.models.find((m) => m.id === params.modelId);
      if (!current) throw new HttpError(404, "model_not_found", "模型不存在");
      const mergedName = String(body?.model_name ?? current.model_name).trim();
      assertWritingCapable(provider, mergedName);
      const { model, store } = await upsertModel(secretsRoot, params.id, { ...current, ...(body ?? {}), id: current.id });
      return { ok: true, model, store };
    }),

    "POST /api/settings/providers/:id/models/:modelId/remove": wrap(async ({ params }) => {
      // Task 11（Task 10 遗留修复）：与 PATCH/default 同款预守卫。store 的
      // removeModel 对不存在的供应商抛不带冒号前缀的 bare "provider_not_found"，
      // wrap 的 code 前缀提取（/^[a-z][a-z0-9_]*:/）匹配不到会把错误原样上抛落成
      // 500；先查供应商让「删除不存在供应商下的模型」返回 404 provider_not_found。
      await providerOf(params.id);
      const { removed, store } = await removeModel(secretsRoot, params.id, params.modelId);
      if (!removed) throw new HttpError(404, "model_not_found", "模型不存在");
      return { ok: true, store };
    }),

    "POST /api/settings/providers/:id/models/:modelId/default": wrap(async ({ params }) => {
      const provider = await providerOf(params.id);
      const model = provider.models.find((m) => m.id === params.modelId);
      if (!model) throw new HttpError(404, "model_not_found", "模型不存在");
      assertWritingCapable(provider, model.model_name);
      const { store } = await setDefaultModel(secretsRoot, params.id, params.modelId);
      return { ok: true, store };
    }),

    // 拉取模型中转：外呼厂商 GET /models，返回候选模型名列表（不落盘）。
    "POST /api/settings/providers/:id/pull-models": wrap(async ({ params }) => {
      const provider = await providerOf(params.id);
      const secrets = await loadLocalSecrets(secretsRoot);
      const apiKey = secrets[provider.api_key_env] ?? process.env[provider.api_key_env];
      if (!apiKey) {
        throw new HttpError(400, "missing_api_key", "请先填写 API 密钥，再拉取模型。");
      }
      let payload;
      try {
        // base_url 只要求非空字符串，scheme-less 值会在此抛 TypeError，须放进 try
        // 以映射为 pull_failed（而不是 400 invalid_provider）。
        const url = new URL("models", `${provider.base_url.replace(/\/+$/u, "")}/`);
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }
        });
        if (!res.ok) {
          throw new HttpError(400, "pull_failed", `模型服务返回 ${res.status}：${(await res.text()).slice(0, 200)}`);
        }
        payload = await res.json();
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "pull_failed", `无法连接模型服务：${error?.message ?? String(error)}`);
      }
      const names = Array.isArray(payload?.data)
        ? payload.data.map((item) => String(item?.id ?? "")).filter(Boolean)
        : [];
      return { ok: true, models: names };
    })
  };
}
