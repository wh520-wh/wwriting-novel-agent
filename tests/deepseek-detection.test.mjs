import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCacheDiscountedMode, isDeepSeekMode, isMiMoMode } from '../src/shared/deepseek-detection.mjs';

// D1：DeepSeek 模式检测 —— base_url 含 api.deepseek.com（大小写不敏感，包含匹配）+ model_name 前缀 deepseek-。
// MiMo 适配（2026-07-31）：isMiMoMode 判据为 base_url 含 xiaomimimo.com + 模型前缀 mimo-。

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

test("isDeepSeekMode 深度等同：与 providerDisplayName 官方预设口径一致（包含匹配兼容带路径端点）", () => {
  // 模型档案展示（settings-routes providerDisplayName）与缓存判定同口径：官方端点
  // 判定只认真实地址（包含匹配），不凭 model_name 前缀猜
  assert.equal(isDeepSeekMode({ base_url: "https://api.deepseek.com", model_name: "deepseek-chat" }), true);
});

// MiMo 适配（2026-07-31）：官方 API 端点与 Token Plan 端点 + mimo- 前缀判定为 MiMo

test("isMiMoMode 官方 API 端点 + mimo- 前缀判定为 MiMo", () => {
  assert.equal(isMiMoMode({ base_url: "https://api.xiaomimimo.com/v1", model_name: "mimo-v2.5" }), true);
  assert.equal(isMiMoMode({ base_url: "https://api.xiaomimimo.com/v1", model_name: "mimo-v2.5-pro" }), true);
  assert.equal(isMiMoMode({ base_url: "https://api.xiaomimimo.com/v1", model_name: "mimo-v2.5-pro-ultraspeed" }), true);
});

test("isMiMoMode Token Plan 订阅端点判定为 MiMo", () => {
  assert.equal(isMiMoMode({ base_url: "https://token-plan-cn.xiaomimimo.com/v1", model_name: "mimo-v2.5-pro" }), true);
  assert.equal(isMiMoMode({ base_url: "https://token-plan-ams.xiaomimimo.com/v1", model_name: "mimo-v2.5" }), true);
});

test("isMiMoMode 大小写不敏感", () => {
  assert.equal(isMiMoMode({ base_url: "HTTPS://API.XIAOMIMIMO.COM/V1", model_name: "mimo-v2.5" }), true);
  assert.equal(isMiMoMode({ base_url: "https://Api.XiaomiMiMo.Com/v1", model_name: "MiMo-V2.5-Pro" }), true);
});

test("isMiMoMode 端点含 xiaomimimo.com 但模型非 mimo- 前缀 → 否", () => {
  assert.equal(isMiMoMode({ base_url: "https://api.xiaomimimo.com/v1", model_name: "deepseek-chat" }), false);
  assert.equal(isMiMoMode({ base_url: "https://api.xiaomimimo.com/v1", model_name: "" }), false);
});

test("isMiMoMode 模型为 mimo- 前缀但端点非官方 → 否", () => {
  // 第三方中转（Novita / OpenRouter 等）不算 MiMo 模式，与 isDeepSeekMode 的保守口径一致
  assert.equal(isMiMoMode({ base_url: "https://api.novita.ai/openai", model_name: "xiaomimimo/mimo-v2.5" }), false);
  assert.equal(isMiMoMode({ base_url: "https://proxy.example.com/v1", model_name: "mimo-v2.5" }), false);
});

test("isMiMoMode 缺失配置 → 否（不抛异常）", () => {
  assert.equal(isMiMoMode(null), false);
  assert.equal(isMiMoMode({}), false);
  assert.equal(isMiMoMode({ model_name: "mimo-v2.5" }), false);
  assert.equal(isMiMoMode({ base_url: "https://api.xiaomimimo.com/v1" }), false);
});

test("isCacheDiscountedMode 覆盖 DeepSeek 与 MiMo，其余平台为否", () => {
  assert.equal(isCacheDiscountedMode({ base_url: "https://api.deepseek.com", model_name: "deepseek-chat" }), true);
  assert.equal(isCacheDiscountedMode({ base_url: "https://api.xiaomimimo.com/v1", model_name: "mimo-v2.5-pro" }), true);
  assert.equal(isCacheDiscountedMode({ base_url: "https://api.openai.com/v1", model_name: "gpt-4o" }), false);
  assert.equal(isCacheDiscountedMode({ base_url: "https://api.moonshot.cn/v1", model_name: "kimi-k2" }), false);
  assert.equal(isCacheDiscountedMode(null), false);
  assert.equal(isCacheDiscountedMode({}), false);
});
