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
  assert.equal(before.default_model_id, "mimo-v1");

  const store = await removeLocalModelProfile(root, "mimo-v1");
  assert.equal(store.models.length, 1);
  assert.equal(store.models[0].model_name, "deepseek-chat");
  assert.equal(store.default_model_id, "deepseek-chat");

  const persisted = await loadLocalModelProfiles(root);
  assert.equal(persisted.default_model_id, "deepseek-chat");
});

test("删除模型：删非默认模型不动默认指针；删不存在的返回 null", async () => {
  const root = await tempRoot();
  await seedTwoModels(root);
  const store = await removeLocalModelProfile(root, "deepseek-chat");
  assert.equal(store.default_model_id, "mimo-v1");
  assert.equal(await removeLocalModelProfile(root, "not-there"), null);
});

test("设为默认：只挪指针，不改模型字段", async () => {
  const root = await tempRoot();
  await seedTwoModels(root);
  const store = await setDefaultLocalModelProfile(root, "deepseek-chat");
  assert.equal(store.default_model_id, "deepseek-chat");
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
  assert.equal(store.default_model_id, "deepseek-chat");
  const secrets = await loadLocalSecrets(secretsRoot);
  assert.equal(secrets.DEEPSEEK_API_KEY, "sk-test-1234");
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

test("全局删除/选用：找不到模型时抛 model_profile_not_found", async () => {
  const secretsRoot = await tempRoot();
  await assert.rejects(() => removeGlobalModelProfile(secretsRoot, "nope"),
    (e) => e instanceof GlobalModelSettingsError && e.code === "model_profile_not_found");
  await assert.rejects(() => selectGlobalModelProfile(secretsRoot, "nope"),
    (e) => e instanceof GlobalModelSettingsError && e.code === "model_profile_not_found");
});
