// tests/http/settings-routes-display.test.mjs —— 模型展示标签单元测试。
//
// 回归背景（2026-08-11）：providerDisplayName 曾凭 model_name 前缀把第三方中转
// （opencode.ai）上挂的 deepseek-v4-flash 标成「DeepSeek 官方」，用户在「已配置」
// 列表里认不出自己的自定义条目，误以为保存未生效。修复后官方判定只看真实 base_url，
// 自定义兼容端点显示「OpenAI 兼容 · 主机名」。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  modelDisplayName,
  providerDisplayName
} from "../../src/core/http/settings-routes.mjs";

test("providerDisplayName 官方 DeepSeek 端点判定为 DeepSeek 官方（含 /v1、尾斜杠、大小写变体）", () => {
  assert.equal(providerDisplayName({ provider: "openai-compatible", base_url: "https://api.deepseek.com", model_name: "deepseek-chat" }), "DeepSeek 官方");
  assert.equal(providerDisplayName({ provider: "openai-compatible", base_url: "https://api.deepseek.com/v1", model_name: "deepseek-v4-flash" }), "DeepSeek 官方");
  assert.equal(providerDisplayName({ provider: "openai-compatible", base_url: "HTTPS://API.DEEPSEEK.COM/", model_name: "deepseek-chat" }), "DeepSeek 官方");
  // 地址为准：官方端点挂任意模型名仍是官方。
  assert.equal(providerDisplayName({ provider: "openai-compatible", base_url: "https://api.deepseek.com", model_name: "gpt-4o" }), "DeepSeek 官方");
});

test("providerDisplayName 第三方中转挂 deepseek- 名号不标官方（opencode.ai 回归）", () => {
  const label = providerDisplayName({
    provider: "openai-compatible",
    base_url: "https://opencode.ai/zen/go/v1",
    model_name: "deepseek-v4-flash",
    api_key_env: "WWRITING_PROVIDER_API_KEY"
  });
  assert.equal(label, "OpenAI 兼容 · opencode.ai");
  assert.notEqual(label, "DeepSeek 官方");
});

test("providerDisplayName MiMo 官方端点判定为 小米 MiMo 官方", () => {
  assert.equal(providerDisplayName({ provider: "openai-compatible", base_url: "https://api.xiaomimimo.com/v1", model_name: "mimo-v2.5" }), "小米 MiMo 官方");
  // 地址为准：MiMo 官方端点挂非 mimo- 名仍是官方。
  assert.equal(providerDisplayName({ provider: "openai-compatible", base_url: "https://api.xiaomimimo.com/v1", model_name: "deepseek-chat" }), "小米 MiMo 官方");
  // Token Plan 订阅端点同属 MiMo。
  assert.equal(providerDisplayName({ provider: "openai-compatible", base_url: "https://token-plan-cn.xiaomimimo.com/v1", model_name: "mimo-v2.5-pro" }), "小米 MiMo 官方");
});

test("providerDisplayName 自定义兼容端点显示厂商名 + 主机", () => {
  assert.equal(
    providerDisplayName({ provider: "openai-compatible", base_url: "https://api.example.com/v1", model_name: "my-model" }),
    "OpenAI 兼容 · api.example.com"
  );
  assert.equal(providerDisplayName({ provider: "openai-compatible" }), "openai-compatible");
  assert.equal(providerDisplayName({ provider: "openai-compatible", base_url: "not-a-url" }), "openai-compatible");
  assert.equal(providerDisplayName({ provider: "mock" }), "Mock");
});

test("providerDisplayName 用户声明的 provider_label 优先于任何推断（2026-08-11 新增字段）", () => {
  // 自定义网关 + 用户自起厂商名：显示用户声明的名字，不再按 host 推断。
  assert.equal(
    providerDisplayName({ provider: "openai-compatible", base_url: "https://opencode.ai/zen/go/v1", model_name: "deepseek-v4-flash", provider_label: "我的中转" }),
    "我的中转"
  );
  // 官方地址 + 用户声明：以用户声明为准。
  assert.equal(
    providerDisplayName({ provider: "openai-compatible", base_url: "https://api.deepseek.com", model_name: "deepseek-chat", provider_label: "DeepSeek 官方" }),
    "DeepSeek 官方"
  );
  // 空白 provider_label 视为未声明，回落推断。
  assert.equal(
    providerDisplayName({ provider: "openai-compatible", base_url: "https://opencode.ai/zen/go/v1", model_name: "deepseek-v4-flash", provider_label: "   " }),
    "OpenAI 兼容 · opencode.ai"
  );
});

test("modelDisplayName 拼接标签与模型名（自定义条目与官方条目可区分）", () => {
  assert.equal(
    modelDisplayName({ provider: "openai-compatible", base_url: "https://opencode.ai/zen/go/v1", model_name: "deepseek-v4-flash" }),
    "OpenAI 兼容 · opencode.ai / deepseek-v4-flash"
  );
  assert.equal(
    modelDisplayName({ provider: "openai-compatible", base_url: "https://api.deepseek.com", model_name: "deepseek-v4-flash" }),
    "DeepSeek 官方 / deepseek-v4-flash"
  );
});
