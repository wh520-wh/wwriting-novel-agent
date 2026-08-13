// tests/http/settings-routes-display.test.mjs —— 模型展示标签单元测试。
//
// 回归背景（2026-08-11）：providerDisplayName 曾凭 model_name 前缀把第三方中转
// （opencode.ai）上挂的 deepseek-v4-flash 标成「DeepSeek 官方」，用户在「已配置」
// 列表里认不出自己的自定义条目，误以为保存未生效。修复后官方判定只看真实 base_url，
// 自定义兼容端点显示「OpenAI 兼容 · 主机名」。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildModelProfile,
  modelDisplayName,
  providerDisplayName,
  createSettingsRoutes
} from "../../src/core/http/settings-routes.mjs";
import { createRouter } from "../../src/core/http/router.mjs";
import { createWorkspaceStore } from "../../src/core/workspaces/store.mjs";
import { ensurePresetProviders } from "../../src/core/model-presets.mjs";
import { startHttpServer } from "../helpers/http-test.mjs";

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
  // Task 8：mock 不再有「Mock」展示名（用户面不出现 mock 字样；未配置展示由
  // buildModelProfile 的未配置分支承担，provider 字面串仅作兜底透传）。
  assert.equal(providerDisplayName({ provider: "mock" }), "mock");
  assert.equal(providerDisplayName({ provider: "mock", model_name: "mock-writer" }), "mock");
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

test("buildModelProfile 未配置（null/空对象）返回未配置形状，不出现 Mock", () => {
  for (const unconfigured of [null, undefined, {}, { active_model: null }]) {
    const profile = buildModelProfile(unconfigured, "C:\\fake-secrets", {});
    assert.equal(profile.is_mock, false, "未配置不得标记 is_mock");
    assert.equal(profile.provider, null);
    assert.equal(profile.model_name, null);
    assert.equal(profile.display, "未配置");
    assert.equal(profile.model_label, "未配置");
    assert.equal(profile.base_url, "");
    assert.equal(profile.endpoint, "");
    assert.equal(profile.api_key_env, null);
    assert.equal(profile.api_key_saved, false);
    assert.equal(profile.capabilities, null);
  }
  // 显式 openai-compatible 配置保持完整展示，is_mock 恒为 false。
  const configured = buildModelProfile(
    { provider: "openai-compatible", model_name: "deepseek-chat", base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY" },
    "C:\\fake-secrets",
    {}
  );
  assert.equal(configured.is_mock, false);
  assert.equal(configured.model_name, "deepseek-chat");
  assert.equal(configured.display, "DeepSeek 官方 / deepseek-chat");
  // 显式 mock provider（仅测试/内部路径）保留 is_mock 标记，但展示名不带 "Mock"。
  const mockProfile = buildModelProfile({ provider: "mock", model_name: "mock-writer" }, "C:\\fake-secrets", {});
  assert.equal(mockProfile.is_mock, true);
  assert.match(mockProfile.display, /^mock/u);
  assert.doesNotMatch(mockProfile.display, /Mock/u);
});

// ---------------------------------------------------------------------------
// Task 19（spec 4.3 #13）：settings/update 是唯一写入口且不接受旧 active_model 字段。
// 真实 HTTP server：router + settings-routes（注入 workspaceStore 与 seed 预设）。
// 模型切换唯一合法路径是引用 API（model-switch / providers CRUD）。
// ---------------------------------------------------------------------------

async function setupSettingsServer(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "settings-routes-display-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const stateRoot = path.join(workspace, ".state");
  const secretsRoot = path.join(workspace, ".secrets");
  await fs.mkdir(secretsRoot, { recursive: true });
  const selection = { current: null };
  const workspaceStore = createWorkspaceStore({ stateRoot });
  await ensurePresetProviders(secretsRoot);
  const router = createRouter();
  const settingsRoutes = createSettingsRoutes({
    workspace,
    stateRoot,
    secretsRoot,
    selection,
    workspaceStore
  });
  const http = await startHttpServer(t, { router, routeModules: [settingsRoutes] });
  return { http, workspace, secretsRoot, workspaceStore, selection };
}

test("settings/update 含 active_model → 400 active_model_use_reference_api（保存前拒绝）", async (t) => {
  const { http, workspace, workspaceStore, selection } = await setupSettingsServer(t);
  const projectRoot = path.join(workspace, "novel");
  await fs.mkdir(projectRoot, { recursive: true });
  selection.current = projectRoot;

  // 仅 active_model：拒绝，且不产生任何写盘
  const only = await http.post("/api/settings/update", {
    projectRoot,
    active_model: { provider: "openai-compatible", model_name: "deepseek-v4-pro", base_url: "https://api.deepseek.com" }
  });
  assert.equal(only.res.status, 400);
  assert.equal(only.data.ok, false);
  assert.equal(only.data.code, "active_model_use_reference_api");
  // Task 19 审查：code 在 SAFE_PUBLIC_ERROR_CODES 白名单内，message 必须透传
  // 「指向引用 API」指引（前端只展示 data.message，不透传则用户看不到迁移路径）
  assert.match(only.data.message, /模型引用 API/u);
  assert.match(only.data.message, /model-switch/u);
  assert.equal((await workspaceStore.loadSettings(projectRoot)).active_model, null, "拒绝后 settings 不写入模型");

  // active_model: null 同样拒绝（旧字段只要出现即整体拒绝，不接受后 delete）
  const nullModel = await http.post("/api/settings/update", {
    projectRoot,
    active_model: null
  });
  assert.equal(nullModel.res.status, 400);
  assert.equal(nullModel.data.code, "active_model_use_reference_api");
  assert.match(nullModel.data.message, /模型引用 API/u);

  // 混合补丁：active_model + 其他字段同样整体拒绝（不接受后 delete）
  const mixed = await http.post("/api/settings/update", {
    projectRoot,
    active_model: { provider_id: "deepseek", model_id: "deepseek-v4-pro" },
    tool_permissions: { auto_edit: true }
  });
  assert.equal(mixed.res.status, 400);
  assert.equal(mixed.data.code, "active_model_use_reference_api");
  const settings = await workspaceStore.loadSettings(projectRoot);
  assert.deepEqual(
    settings.tool_permissions,
    { read_only: false, auto_edit: false, network_allowed: false, yolo: false },
    "混合补丁中的其余字段也不得落盘"
  );
  assert.equal(settings.active_model, null);
});

test("模型切换只走 model-switch 引用路由（写引用并生效）", async (t) => {
  const { http, workspace, workspaceStore, selection } = await setupSettingsServer(t);
  const projectRoot = path.join(workspace, "novel-2");
  await fs.mkdir(projectRoot, { recursive: true });
  selection.current = projectRoot;

  const { res, data } = await http.post("/api/settings/model-switch", {
    projectRoot,
    provider_id: "deepseek",
    model_id: "m_deepseek_deepseek-v4-pro"
  });
  assert.equal(res.status, 200);
  assert.deepEqual(data.active_model, { provider_id: "deepseek", model_id: "m_deepseek_deepseek-v4-pro" }, "响应为引用契约");
  const settings = await workspaceStore.loadSettings(projectRoot);
  assert.deepEqual(
    settings.active_model,
    { provider_id: "deepseek", model_id: "m_deepseek_deepseek-v4-pro" },
    "settings.json 写入引用"
  );
});
