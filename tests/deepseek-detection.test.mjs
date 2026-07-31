import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepSeekMode } from '../src/shared/deepseek-detection.mjs';

// D1：DeepSeek 模式检测 —— base_url 含 api.deepseek.com（大小写不敏感，包含匹配）+ model_name 前缀 deepseek-。

test("isDeepSeekMode 官方端点 + deepseek- 前缀判定为 DeepSeek", () => {
  assert.equal(isDeepSeekMode({ base_url: "https://api.deepseek.com", model_name: "deepseek-chat" }), true);
  assert.equal(isDeepSeekMode({ base_url: "https://api.deepseek.com/v1", model_name: "deepseek-reasoner" }), true);
  assert.equal(isDeepSeekMode({ base_url: "https://api.deepseek.com/", model_name: "deepseek-v4-flash" }), true);
});

test("isDeepSeekMode 大小写不敏感", () => {
  assert.equal(isDeepSeekMode({ base_url: "HTTPS://API.DEEPSEEK.COM", model_name: "deepseek-chat" }), true);
  assert.equal(isDeepSeekMode({ base_url: "https://Api.DeepSeek.Com", model_name: "DeepSeek-Chat" }), true);
  assert.equal(isDeepSeekMode({ base_url: "https://api.deepseek.com", model_name: "DEEPSEEK-REASONER" }), true);
});

test("isDeepSeekMode base_url 缺省匹配但模型非 deepseek- 前缀 → 否", () => {
  // provider 字段恒为 openai-compatible 不可用作信号；模型名前缀是必要补强信号
  assert.equal(isDeepSeekMode({ base_url: "https://api.deepseek.com", model_name: "gpt-4o" }), false);
  assert.equal(isDeepSeekMode({ base_url: "https://api.deepseek.com", model_name: "qwen-max" }), false);
  assert.equal(isDeepSeekMode({ base_url: "https://api.deepseek.com", model_name: "" }), false);
});

test("isDeepSeekMode 模型为 deepseek- 前缀但端点非官方 → 否", () => {
  // 第三方中转（含官方域名外的代理端点）不算 DeepSeek 模式
  assert.equal(isDeepSeekMode({ base_url: "https://api.openai.com/v1", model_name: "deepseek-chat" }), false);
  assert.equal(isDeepSeekMode({ base_url: "https://proxy.example.com/v1", model_name: "deepseek-chat" }), false);
});

test("isDeepSeekMode 非 DeepSeek 模型 → 否", () => {
  assert.equal(isDeepSeekMode({ base_url: "https://api.openai.com/v1", model_name: "gpt-4o" }), false);
  assert.equal(isDeepSeekMode({ base_url: "https://api.moonshot.cn/v1", model_name: "kimi-k2" }), false);
});

test("isDeepSeekMode 缺失配置 → 否（不抛异常）", () => {
  assert.equal(isDeepSeekMode(null), false);
  assert.equal(isDeepSeekMode({}), false);
  assert.equal(isDeepSeekMode({ model_name: "deepseek-chat" }), false);
  assert.equal(isDeepSeekMode({ base_url: "https://api.deepseek.com" }), false);
});

test("isDeepSeekMode 深度等同：与 settings-modal detectProviderPreset 官方预设一致（包含匹配兼容带路径端点）", () => {
  // settings-modal 是等号匹配；core 层按计划口径用包含匹配，官方端点是真子集
  assert.equal(isDeepSeekMode({ base_url: "https://api.deepseek.com", model_name: "deepseek-chat" }), true);
});
