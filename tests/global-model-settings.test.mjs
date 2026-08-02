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
