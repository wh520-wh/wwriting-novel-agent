import test from "node:test";
import assert from "node:assert/strict";
import {
  rememberTestedModel,
  isModelTestedOk,
  listTestedModels,
  forgetTestedModel,
  _setStorageForTest
} from "../../src/app-shell/connection-memory.mjs";

function makeMockStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

test("rememberTestedModel ok=true 记住，ok=false 移除", () => {
  _setStorageForTest(makeMockStorage());
  assert.equal(isModelTestedOk("deepseek-chat"), false);
  rememberTestedModel("deepseek-chat", true);
  assert.equal(isModelTestedOk("deepseek-chat"), true);
  rememberTestedModel("deepseek-chat", false);
  assert.equal(isModelTestedOk("deepseek-chat"), false);
});

test("listTestedModels 返回所有已记住模型", () => {
  _setStorageForTest(makeMockStorage());
  rememberTestedModel("model-a", true);
  rememberTestedModel("model-b", true);
  const list = listTestedModels();
  assert.equal(list.length, 2);
  assert.ok(list.includes("model-a"));
  assert.ok(list.includes("model-b"));
});

test("forgetTestedModel 移除指定模型", () => {
  _setStorageForTest(makeMockStorage());
  rememberTestedModel("model-a", true);
  rememberTestedModel("model-b", true);
  forgetTestedModel("model-a");
  assert.equal(isModelTestedOk("model-a"), false);
  assert.equal(isModelTestedOk("model-b"), true);
});

test("脏数据 JSON 不崩溃，返回空列表", () => {
  const storage = makeMockStorage();
  storage.setItem("wwriting:tested-models-ok", "{not valid json");
  _setStorageForTest(storage);
  assert.deepEqual(listTestedModels(), []);
  assert.equal(isModelTestedOk("anything"), false);
});
