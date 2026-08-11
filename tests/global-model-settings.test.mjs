import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadLocalModelProfiles,
  removeLocalModelProfile,
  setDefaultLocalModelProfile,
  upsertLocalModelProfile
} from "../src/core/local-model-profiles.mjs";
import { loadLocalSecrets } from "../src/core/local-secrets.mjs";
import {
  GlobalModelSettingsError,
  removeGlobalModelProfile,
  saveGlobalModelProfile,
  selectGlobalModelProfile
} from "../src/core/global-model-settings.mjs";
import { registerProviderCapabilityResolver } from "../src/core/model/capabilities.mjs";

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wwriting-globalmodel-"));
}

async function seedTwoModels(root) {
  await upsertLocalModelProfile(root, {
    provider: "openai-compatible",
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  await upsertLocalModelProfile(root, {
    provider: "openai-compatible",
    model_name: "mimo-v1",
    base_url: "https://api.mimo.example",
    api_key_env: "XIAOMI_MIMO_API_KEY"
  });
}

test("删除模型：删掉默认模型时默认顺延到剩下的第一个", async () => {
  const root = await tempRoot();
  await seedTwoModels(root);
  // upsert 后默认是最后写入的 mimo-v1
  const before = await loadLocalModelProfiles(root);
  assert.equal(before.default_model_id, "mimo-v1@https://api.mimo.example");

  const store = await removeLocalModelProfile(root, "mimo-v1");
  assert.equal(store.models.length, 1);
  assert.equal(store.models[0].model_name, "deepseek-chat");
  assert.equal(store.default_model_id, "deepseek-chat@https://api.deepseek.com");

  const persisted = await loadLocalModelProfiles(root);
  assert.equal(persisted.default_model_id, "deepseek-chat@https://api.deepseek.com");
});

test("删除模型：删非默认模型不动默认指针；删不存在的返回 null", async () => {
  const root = await tempRoot();
  await seedTwoModels(root);
  const store = await removeLocalModelProfile(root, "deepseek-chat");
  assert.equal(store.default_model_id, "mimo-v1@https://api.mimo.example");
  assert.equal(await removeLocalModelProfile(root, "not-there"), null);
});

test("设为默认：只挪指针，不改模型字段", async () => {
  const root = await tempRoot();
  await seedTwoModels(root);
  const store = await setDefaultLocalModelProfile(root, "deepseek-chat");
  assert.equal(store.default_model_id, "deepseek-chat@https://api.deepseek.com");
  assert.equal(store.models.length, 2);
  const target = store.models.find((m) => m.model_name === "deepseek-chat");
  assert.equal(target.base_url, "https://api.deepseek.com");
  assert.equal(target.api_key_env, "DEEPSEEK_API_KEY");
  assert.equal(await setDefaultLocalModelProfile(root, "not-there"), null);
});

test("全局保存模型：没有任何项目也能存密钥和清单", async () => {
  const secretsRoot = await tempRoot();
  const { saved, store } = await saveGlobalModelProfile({
    secretsRoot,
    activeModel: {
      provider: "openai-compatible",
      model_name: "deepseek-chat",
      base_url: "https://api.deepseek.com",
      api_key_env: "DEEPSEEK_API_KEY",
      api_key: "sk-test-1234"
    }
  });
  assert.equal(saved.model_name, "deepseek-chat");
  assert.equal(saved.id, "deepseek-chat@https://api.deepseek.com", "id 派生自 model_name@base_url（同 ID 不同网关可并存）");
  assert.equal(store.default_model_id, saved.id);
  const secrets = await loadLocalSecrets(secretsRoot);
  assert.equal(secrets.DEEPSEEK_API_KEY, "sk-test-1234");
});

test("回归·同名 ID 不同 base_url 的模型保存后并存，互不覆盖（2026-08-11）", async () => {
  const root = await tempRoot();
  // 官方 v4-flash
  await upsertLocalModelProfile(root, {
    provider: "openai-compatible",
    model_name: "deepseek-v4-flash",
    base_url: "https://api.deepseek.com/v1",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  // 自定义 v4-flash（同 ID、不同网关）：必须成为新条目，而不是覆盖官方那条
  const custom = await upsertLocalModelProfile(root, {
    provider: "openai-compatible",
    model_name: "deepseek-v4-flash",
    base_url: "https://opencode.ai/zen/go/v1",
    api_key_env: "WWRITING_PROVIDER_API_KEY"
  });
  const store = await loadLocalModelProfiles(root);
  assert.equal(store.models.length, 2, "同名 ID 不同 base_url 应并存为两条");
  const official = store.models.find((m) => m.base_url === "https://api.deepseek.com/v1");
  const customRow = store.models.find((m) => m.base_url === "https://opencode.ai/zen/go/v1");
  assert.ok(official, "官方条目不得被覆盖");
  assert.ok(customRow, "自定义条目应保存成功");
  assert.notEqual(official.id, customRow.id, "两条目的 id 必须不同");
  assert.equal(custom.id, customRow.id, "upsert 返回的 id 与清单一致");
  // 重存同配置 = 更新（不产生第三条）
  await upsertLocalModelProfile(root, {
    provider: "openai-compatible",
    model_name: "deepseek-v4-flash",
    base_url: "https://api.deepseek.com/v1",
    api_key_env: "DEEPSEEK_API_KEY"
  });
  const after = await loadLocalModelProfiles(root);
  assert.equal(after.models.length, 2, "重存同配置应原地更新，不新增条目");
  // 旧 id=modelName 的遗留条目：同身份的新配置保存时应替换而非新增
  await upsertLocalModelProfile(root, {
    provider: "openai-compatible",
    model_name: "deepseek-v4-flash",
    base_url: "https://opencode.ai/zen/go/v1",
    api_key_env: "WWRITING_PROVIDER_API_KEY",
    id: "deepseek-v4-flash"
  });
  const afterLegacy = await loadLocalModelProfiles(root);
  assert.equal(afterLegacy.models.length, 2, "同身份旧 id 条目应被替换，不新增");
});

test("回归·provider_label 随保存落盘并读回；改名只更新不新增（2026-08-11）", async () => {
  const root = await tempRoot();
  await upsertLocalModelProfile(root, {
    provider: "openai-compatible",
    model_name: "deepseek-v4-flash",
    base_url: "https://opencode.ai/zen/go/v1",
    api_key_env: "WWRITING_PROVIDER_API_KEY",
    provider_label: "我的中转"
  });
  let store = await loadLocalModelProfiles(root);
  assert.equal(store.models[0].provider_label, "我的中转", "provider_label 应落盘保留");
  // 改厂商显示名：同一身份 → 原地更新，不产生新条目
  await upsertLocalModelProfile(root, {
    provider: "openai-compatible",
    model_name: "deepseek-v4-flash",
    base_url: "https://opencode.ai/zen/go/v1",
    api_key_env: "WWRITING_PROVIDER_API_KEY",
    provider_label: "改个名字"
  });
  store = await loadLocalModelProfiles(root);
  assert.equal(store.models.length, 1, "改厂商显示名不产生新条目");
  assert.equal(store.models[0].provider_label, "改个名字");
  // 未填提供商时不得落空字段（旧行为保持）
  await upsertLocalModelProfile(root, {
    provider: "openai-compatible",
    model_name: "mimo-v2.5",
    base_url: "https://api.xiaomimimo.com/v1",
    api_key_env: "XIAOMI_MIMO_API_KEY"
  });
  store = await loadLocalModelProfiles(root);
  assert.equal(store.models.find((m) => m.model_name === "mimo-v2.5").provider_label, undefined, "未填提供商不落空字段");
});

test("saveGlobalModelProfile 透传 provider_label（校验白名单不丢字段）", async () => {
  const secretsRoot = await tempRoot();
  const { activeModel } = await saveGlobalModelProfile({
    secretsRoot,
    activeModel: {
      provider: "openai-compatible",
      model_name: "deepseek-v4-flash",
      base_url: "https://opencode.ai/zen/go/v1",
      api_key_env: "WWRITING_PROVIDER_API_KEY",
      api_key: "sk-x",
      provider_label: "我的中转"
    }
  });
  assert.equal(activeModel.provider_label, "我的中转", "validateModelConfig 白名单应保留 provider_label");
  const store = await loadLocalModelProfiles(secretsRoot);
  assert.equal(store.models[0].provider_label, "我的中转", "保存后清单应含 provider_label");
});

test("全局保存模型：api_key 不落进清单文件", async () => {
  const secretsRoot = await tempRoot();
  const { saved, activeModel } = await saveGlobalModelProfile({
    secretsRoot,
    activeModel: {
      provider: "openai-compatible",
      model_name: "deepseek-chat",
      base_url: "https://api.deepseek.com",
      api_key_env: "DEEPSEEK_API_KEY",
      api_key: "sk-secret"
    }
  });
  assert.equal(saved.api_key, undefined);
  assert.equal(activeModel.api_key, undefined);
  const raw = await fs.readFile(path.join(secretsRoot, "model-profiles.json"), "utf8");
  assert.equal(raw.includes("sk-secret"), false);
});

test("全局保存模型：留空密钥沿用已存的，不清掉旧密钥", async () => {
  const secretsRoot = await tempRoot();
  const base = {
    provider: "openai-compatible",
    model_name: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    api_key_env: "DEEPSEEK_API_KEY"
  };
  await saveGlobalModelProfile({ secretsRoot, activeModel: { ...base, api_key: "sk-first" } });
  await saveGlobalModelProfile({
    secretsRoot,
    activeModel: { ...base, base_url: "https://api.deepseek.com/v2", api_key: "" }
  });
  const secrets = await loadLocalSecrets(secretsRoot);
  assert.equal(secrets.DEEPSEEK_API_KEY, "sk-first");
});

test("全局保存模型：既无已存密钥又没填新密钥时报可读错误", async () => {
  const secretsRoot = await tempRoot();
  await assert.rejects(
    () => saveGlobalModelProfile({
      secretsRoot,
      activeModel: {
        provider: "openai-compatible",
        model_name: "deepseek-chat",
        base_url: "https://api.deepseek.com",
        api_key_env: "DEEPSEEK_API_KEY",
        api_key: ""
      }
    }),
    (error) => {
      assert.equal(typeof error.fields.api_key, "string");
      assert.match(error.fields.api_key, /API Key/);
      return true;
    }
  );
});

test("保存模型带 temperature：持久化到全局清单", async () => {
  const root = await tempRoot();
  const { store } = await saveGlobalModelProfile({
    secretsRoot: root,
    activeModel: {
      provider: "openai-compatible", model_name: "deepseek-chat",
      base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY",
      api_key: "sk-test", temperature: 1.1
    }
  });
  const saved = store.models.find((m) => m.model_name === "deepseek-chat");
  assert.equal(saved.temperature, 1.1);
});

test("模型清单透传 timeout_ms/total_deadline_ms：upsert 后读回，缺失时不含字段", async () => {
  const root = await tempRoot();
  await upsertLocalModelProfile(root, {
    provider: "openai-compatible",
    model_name: "timeout-model",
    base_url: "https://api.example.test/v1",
    api_key_env: "TIMEOUT_KEY",
    timeout_ms: 300000,
    total_deadline_ms: 1800000
  });
  const saved = (await loadLocalModelProfiles(root)).models.find((m) => m.model_name === "timeout-model");
  assert.equal(saved.timeout_ms, 300000);
  assert.equal(saved.total_deadline_ms, 1800000);

  await upsertLocalModelProfile(root, {
    provider: "openai-compatible",
    model_name: "plain-model",
    base_url: "https://api.example.test/v1",
    api_key_env: "PLAIN_KEY"
  });
  const plain = (await loadLocalModelProfiles(root)).models.find((m) => m.model_name === "plain-model");
  assert.equal(plain.timeout_ms, undefined);
  assert.equal(plain.total_deadline_ms, undefined);
});

test("saveGlobalModelProfile 带超时字段持久化到全局清单", async () => {
  const root = await tempRoot();
  const { store } = await saveGlobalModelProfile({
    secretsRoot: root,
    activeModel: {
      provider: "openai-compatible", model_name: "deepseek-chat",
      base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY",
      api_key: "sk-test", timeout_ms: 300000, total_deadline_ms: 900000
    }
  });
  const saved = store.models.find((m) => m.model_name === "deepseek-chat");
  assert.equal(saved.timeout_ms, 300000);
  assert.equal(saved.total_deadline_ms, 900000);
});

test("全局删除/选用：找不到模型时抛 model_profile_not_found", async () => {
  const secretsRoot = await tempRoot();
  await assert.rejects(() => removeGlobalModelProfile(secretsRoot, "nope"),
    (e) => e instanceof GlobalModelSettingsError && e.code === "model_profile_not_found");
  await assert.rejects(() => selectGlobalModelProfile(secretsRoot, "nope"),
    (e) => e instanceof GlobalModelSettingsError && e.code === "model_profile_not_found");
});

test("C 档：不支持工具调用的模型保存被阻止", async () => {
  registerProviderCapabilityResolver(
    (c) => String(c.base_url ?? "").includes("no-tools.example"),
    () => ({ supportsTools: false })
  );
  const root = await tempRoot();
  await assert.rejects(
    saveGlobalModelProfile({
      secretsRoot: root,
      activeModel: {
        provider: "openai-compatible", model_name: "no-tools",
        base_url: "https://no-tools.example", api_key_env: "K", api_key: "sk-x"
      }
    }),
    (e) => e.code === "model_unsupported"
  );
});
