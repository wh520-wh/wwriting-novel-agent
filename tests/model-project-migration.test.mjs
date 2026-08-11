// tests/model-project-migration.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateProjectActiveModel, migrateProjectFile } from "../src/core/project-model-migration.mjs";
import { createWorkspaceStore } from "../src/core/workspaces/store.mjs";

const store = {
  schema_version: 2,
  default_model: { provider_id: "deepseek", model_id: "m1" },
  providers: [{
    id: "deepseek", name: "DeepSeek 官方", type: "custom", status: "enabled",
    base_url: "https://api.deepseek.com", api_format: "openai-chat-completions",
    api_key_env: "DEEPSEEK_API_KEY", created_at: "t", updated_at: "t",
    models: [{ id: "m1", model_name: "deepseek-v4-pro", enabled: true, context_window: 256000 }]
  }]
};

test("mock 快照归零为未配置", async () => {
  const { active_model, changed } = await migrateProjectActiveModel({ provider: "mock", model_name: "mock-writer" }, store);
  assert.equal(active_model, null);
  assert.equal(changed, true);
});

test("匹配清单的快照转引用", async () => {
  const { active_model, changed } = await migrateProjectActiveModel({
    provider: "openai-compatible", model_name: "deepseek-v4-pro",
    base_url: "https://api.deepseek.com", api_key_env: "DEEPSEEK_API_KEY"
  }, store);
  assert.deepEqual(active_model, { provider_id: "deepseek", model_id: "m1" });
  assert.equal(changed, true);
});

test("已是引用形态不动", async () => {
  const { active_model, changed } = await migrateProjectActiveModel({ provider_id: "deepseek", model_id: "m1" }, store);
  assert.deepEqual(active_model, { provider_id: "deepseek", model_id: "m1" });
  assert.equal(changed, false);
});

test("匹配不到的保持字面", async () => {
  const literal = { provider: "openai-compatible", model_name: "legacy", base_url: "https://legacy.test", api_key_env: "L" };
  const { active_model, changed } = await migrateProjectActiveModel(literal, store);
  assert.deepEqual(active_model, literal);
  assert.equal(changed, false);
});

test("null 不动", async () => {
  const { active_model, changed } = await migrateProjectActiveModel(null, store);
  assert.equal(active_model, null);
  assert.equal(changed, false);
});

// ---------------------------------------------------------------------------
// 文件级迁移（任务 6）：注入 readProject/writeProject 计数 seam + 真实 workspaceStore
//（createWorkspaceStore，settings 走 loadSettings/saveSettings 落盘），storeLoader 注入
// plain v2 清单避免默认 loader 读磁盘。覆盖 project.yaml 与私有 settings 两条落盘路径。
// ---------------------------------------------------------------------------

// project.yaml mock 快照 → active_model null；settings 里能匹配清单的字面快照 →
// 引用 {provider_id, model_id}。
test("migrateProjectFile：mock 归零 + settings 转引用", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-model-migration-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const projectRoot = path.join(root, "project");
  const workspaceStore = createWorkspaceStore({ stateRoot: path.join(root, ".state") });

  let project = {
    schema_version: 1,
    active_model: { provider: "mock", model_name: "mock-writer" }
  };
  let writes = 0;
  const readProject = async () => project;
  const writeProject = async (_projectRoot, next) => { writes += 1; project = next; };
  await workspaceStore.saveSettings(projectRoot, {
    active_model: {
      provider: "openai-compatible",
      model_name: "deepseek-v4-pro",
      base_url: "https://api.deepseek.com",
      api_key_env: "DEEPSEEK_API_KEY"
    }
  });

  const result = await migrateProjectFile(projectRoot, {
    workspaceStore,
    secretsRoot: path.join(root, ".secrets"),
    readProject,
    writeProject,
    storeLoader: async () => store
  });

  assert.equal(result.changed, true);
  // project.yaml：mock 归零
  assert.equal(project.active_model, null);
  assert.equal(writes, 1);
  // settings：匹配的字面快照转引用
  const settings = await workspaceStore.loadSettings(projectRoot);
  assert.deepEqual(settings.active_model, { provider_id: "deepseek", model_id: "m1" });
});

// 幂等：第二次调用 changed=false，且注入 writeProject 计数不增加（无多余写盘）。
test("migrateProjectFile 幂等：第二次调用不再写", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-model-migration-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const projectRoot = path.join(root, "project");
  const workspaceStore = createWorkspaceStore({ stateRoot: path.join(root, ".state") });

  let project = {
    schema_version: 1,
    active_model: { provider: "mock", model_name: "mock-writer" }
  };
  let writes = 0;
  const readProject = async () => project;
  const writeProject = async (_projectRoot, next) => { writes += 1; project = next; };
  await workspaceStore.saveSettings(projectRoot, { active_model: { provider: "mock", model_name: "mock-writer" } });

  const options = {
    workspaceStore,
    secretsRoot: path.join(root, ".secrets"),
    readProject,
    writeProject,
    storeLoader: async () => store
  };
  const first = await migrateProjectFile(projectRoot, options);
  const second = await migrateProjectFile(projectRoot, options);

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(writes, 1, "第二次调用不得再写 project.yaml");
  const settings = await workspaceStore.loadSettings(projectRoot);
  assert.equal(settings.active_model, null, "settings 已归零，第二次不再改动");
});

// 锁文档化行为：active_model 已是引用 → 不触发写（迁移只处理快照形态）。
test("migrateProjectFile：引用形态不触发写入", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-model-migration-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const projectRoot = path.join(root, "project");
  const workspaceStore = createWorkspaceStore({ stateRoot: path.join(root, ".state") });

  const project = {
    schema_version: 1,
    active_model: { provider_id: "deepseek", model_id: "m1" }
  };
  let writes = 0;
  const result = await migrateProjectFile(projectRoot, {
    workspaceStore,
    secretsRoot: path.join(root, ".secrets"),
    readProject: async () => project,
    writeProject: async () => { writes += 1; },
    storeLoader: async () => store
  });

  assert.equal(result.changed, false);
  assert.equal(writes, 0, "引用形态不触发写入");
  assert.deepEqual(project.active_model, { provider_id: "deepseek", model_id: "m1" });
});
