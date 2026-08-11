// tests/app-shell/model-settings-page.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { pickProvider, visibleModels, buildPageState } from "../../src/app-shell/model-settings-page.js";

const providers = [
  { id: "deepseek", name: "DeepSeek 官方", status: "enabled", models: [
    { id: "m1", model_name: "deepseek-v4-pro", enabled: true },
    { id: "m2", model_name: "deepseek-v4-flash", enabled: false }
  ]},
  { id: "mimo", name: "小米 MiMo 官方", status: "disabled", models: [
    { id: "m3", model_name: "mimo-v2.5", enabled: true }
  ]}
];

test("pickProvider 按 id 选中", () => {
  assert.equal(pickProvider(providers, "mimo")?.id, "mimo");
  assert.equal(pickProvider(providers, "ghost"), null);
});

test("visibleModels 只显启用模型", () => {
  assert.deepEqual(visibleModels(providers[0]).map((m) => m.id), ["m1"]);
});

test("buildPageState 默认选中第一个", () => {
  const state = buildPageState(providers, null);
  assert.equal(state.selected?.id, "deepseek");
  const second = buildPageState(providers, "mimo");
  assert.equal(second.selected?.id, "mimo");
});
