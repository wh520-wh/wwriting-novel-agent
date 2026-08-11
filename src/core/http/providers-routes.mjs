// src/core/http/providers-routes.mjs
// 供应商/模型两级 CRUD + 拉取模型中转。handler 约定见 router.mjs：
// handler({ request, response, params, query, body }) → 对象即 200 JSON。
import { HttpError } from "../http-error.mjs";
import { loadLocalSecrets, saveLocalSecrets } from "../local-secrets.mjs";
import {
  loadProviderStore, upsertProvider, removeProvider, upsertModel, removeModel,
  setDefaultModel
} from "../model-provider-store.mjs";
import { ensurePresetProviders } from "../model-presets.mjs";
import { writingRequiredCapabilitiesOk } from "../model/capabilities.mjs";

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
  const wrap = (fn) => async (ctx) => {
    try {
      return await fn(ctx);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const code = typeof error?.code === "string" && error.code.length > 0
        ? error.code
        : (() => {
            const message = typeof error?.message === "string" ? error.message : "";
            const match = /^([a-z][a-z0-9_]*):/u.exec(message);
            return match ? match[1] : null;
          })();
      throw new HttpError(400, code ?? "invalid_provider", error?.message ?? String(error));
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
    "GET /api/settings/providers": wrap(async () => ({ ok: true, ...(await storeList()) })),

    "POST /api/settings/providers": wrap(async ({ body }) => {
      const { provider, store } = await upsertProvider(secretsRoot, body ?? {});
      return { ok: true, provider, store };
    }),

    "PATCH /api/settings/providers/:id": wrap(async ({ params, body }) => {
      const current = await providerOf(params.id);
      const payload = { ...(body ?? {}) };
      const transientKey = typeof payload.api_key === "string" ? payload.api_key.trim() : "";
      delete payload.api_key;
      if (transientKey) {
        const envName = String(payload.api_key_env ?? current.api_key_env ?? "").trim();
        if (!envName) throw new HttpError(400, "invalid_api_key_env", "请先填写 API 密钥环境变量名。");
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
      const url = new URL("models", `${provider.base_url.replace(/\/+$/u, "")}/`);
      let payload;
      try {
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
