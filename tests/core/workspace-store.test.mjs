// workspace store 契约测试（计划 Task 2）。
//
// 冻结的数据契约（SPEC §2.1/§2.2；Task 2 实现）：
//   - 同一路径映射到同一稳定 workspace id（ws_<32-hex>），应用私有数据只写
//     stateRoot/workspaces/<id>，绝不落入项目目录；
//   - Windows 上路径大小写归一化后仍映射同一 id；
//   - settings.json 只保存白名单字段（schema_version/active_model/
//     tool_permissions/legacy_project_imported），损坏文件按默认值容错。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWorkspaceStore,
  workspaceIdForPath
} from "../../src/core/workspaces/store.mjs";

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test("同一路径映射到同一 workspace id，应用数据不落项目目录", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-store-"));
  const projectRoot = path.join(stateRoot, "..", "novel");
  const store = createWorkspaceStore({ stateRoot, clock: () => "2026-08-07T00:00:00.000Z" });
  const first = await store.ensure(projectRoot);
  const second = await store.ensure(path.resolve(projectRoot));
  assert.equal(first.workspace_id, second.workspace_id);
  assert.match(first.workspace_id, /^ws_[a-f0-9]{32}$/u);
  assert.equal(first.agentRoot, path.join(stateRoot, "workspaces", first.workspace_id, "agent"));
});

test("不同路径映射到不同 workspace id", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-store-distinct-"));
  const store = createWorkspaceStore({ stateRoot });
  const alpha = await store.ensure("/novels/alpha");
  const beta = await store.ensure("/novels/beta");
  assert.notEqual(alpha.workspace_id, beta.workspace_id);
  assert.notEqual(alpha.directory, beta.directory);
});

test("Windows 上路径大小写不同仍映射到同一 workspace id", async (t) => {
  if (process.platform !== "win32") {
    t.skip("仅 Windows 需要路径大小写归一化");
    return;
  }
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-store-case-"));
  const store = createWorkspaceStore({ stateRoot });
  const upper = await store.ensure("C:\\Novels\\Example");
  const lower = await store.ensure("c:\\novels\\example");
  assert.equal(upper.workspace_id, lower.workspace_id);
  assert.equal(workspaceIdForPath("C:\\Novels\\Example"), workspaceIdForPath("c:\\novels\\example"));
});

test("ensure 自动创建应用私有目录并保留首次 created_at", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-store-ensure-"));
  const firstStore = createWorkspaceStore({ stateRoot, clock: () => "2026-08-07T00:00:00.000Z" });
  const secondStore = createWorkspaceStore({ stateRoot, clock: () => "2026-08-08T00:00:00.000Z" });
  const first = await firstStore.ensure("/novels/a");
  assert.equal(await pathExists(path.join(stateRoot, "workspaces", first.workspace_id, "workspace.json")), true);
  const second = await secondStore.ensure("/novels/a");
  assert.equal(second.created_at, "2026-08-07T00:00:00.000Z");
  assert.equal(second.last_opened_at, "2026-08-08T00:00:00.000Z");
  const persisted = JSON.parse(
    await fs.readFile(path.join(stateRoot, "workspaces", first.workspace_id, "workspace.json"), "utf8")
  );
  assert.equal(persisted.workspace_id, first.workspace_id);
  assert.equal(persisted.project_root, path.resolve("/novels/a"));
});

test("ensure 只写应用私有目录，项目目录不出现 .wwriting 或 project.yaml", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-store-clean-"));
  const stateRoot = path.join(root, "user-data");
  const projectRoot = path.join(root, "novel");
  await fs.mkdir(projectRoot, { recursive: true });
  const store = createWorkspaceStore({ stateRoot });
  await store.ensure(projectRoot);
  await store.saveSettings(projectRoot, { active_model: { model_name: "x" } });
  assert.equal(await pathExists(path.join(projectRoot, ".wwriting")), false);
  assert.equal(await pathExists(path.join(projectRoot, "project.yaml")), false);
  assert.equal(await pathExists(path.join(stateRoot, "workspaces")), true);
});

test("损坏的 settings.json 容错为默认值，不抛异常", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-store-corrupt-"));
  const projectRoot = "/novels/a";
  const store = createWorkspaceStore({ stateRoot });
  await store.ensure(projectRoot);
  const settingsFile = path.join(stateRoot, "workspaces", workspaceIdForPath(projectRoot), "settings.json");
  await fs.writeFile(settingsFile, "{bad json", "utf8");
  const settings = await store.loadSettings(projectRoot);
  assert.deepEqual(settings, {
    schema_version: 1,
    active_model: null,
    tool_permissions: { read_only: false, auto_edit: false, network_allowed: false, yolo: false },
    legacy_project_imported: false
  });
});

test("saveSettings 原子落盘并读回规范化结构，未知字段不进入运行时", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-store-settings-"));
  const projectRoot = "/novels/a";
  const store = createWorkspaceStore({ stateRoot });
  const saved = await store.saveSettings(projectRoot, {
    active_model: { provider: "deepseek", model_name: "deepseek-chat", temperature: 1.3 },
    tool_permissions: { read_only: true, yolo: true, unknown_permission: true },
    unknown_field: "should-not-survive"
  });
  assert.deepEqual(saved, {
    schema_version: 1,
    active_model: { provider: "deepseek", model_name: "deepseek-chat", temperature: 1.3 },
    tool_permissions: { read_only: true, auto_edit: false, network_allowed: false, yolo: true },
    legacy_project_imported: false
  });
  const loaded = await store.loadSettings(projectRoot);
  assert.deepEqual(loaded, saved);
  const persisted = JSON.parse(
    await fs.readFile(path.join(stateRoot, "workspaces", workspaceIdForPath(projectRoot), "settings.json"), "utf8")
  );
  assert.ok(!("unknown_field" in persisted));
  assert.ok(!("unknown_permission" in persisted.tool_permissions));
});

test("settings 白名单严格校验：非布尔权限归 false，非对象模型归 null", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-store-strict-"));
  const store = createWorkspaceStore({ stateRoot });
  const next = await store.saveSettings("/novels/a", {
    active_model: "deepseek-chat",
    tool_permissions: { read_only: "yes", auto_edit: 1, network_allowed: [], yolo: true },
    legacy_project_imported: "yes"
  });
  assert.equal(next.schema_version, 1);
  assert.equal(next.active_model, null);
  assert.deepEqual(next.tool_permissions, {
    read_only: false,
    auto_edit: false,
    network_allowed: false,
    yolo: true
  });
  assert.equal(next.legacy_project_imported, false);
});

test("junction 别名与真实路径得到同一 workspace ID；旧 ID 数据一次性迁移保持可见", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-store-alias-"));
  const projectRoot = path.join(stateRoot, "novel");
  await fs.mkdir(projectRoot, { recursive: true });
  const alias = path.join(stateRoot, "novel-alias");
  await fs.symlink(projectRoot, alias, "junction");
  try {
    const store = createWorkspaceStore({ stateRoot });
    // 模拟旧口径遗留：一个旧 ID 目录，workspace.json 指向同一物理项目
    const legacyId = "ws_" + "0".repeat(32);
    const legacyDir = path.join(stateRoot, "workspaces", legacyId);
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, "workspace.json"),
      JSON.stringify({ schema_version: 1, workspace_id: legacyId, project_root: projectRoot, created_at: "2026-01-01", last_opened_at: "2026-01-01" })
    );
    await fs.writeFile(
      path.join(legacyDir, "settings.json"),
      JSON.stringify({ schema_version: 1, active_model: null, tool_permissions: { read_only: true, auto_edit: false, network_allowed: false, yolo: false }, legacy_project_imported: true })
    );

    // 真实路径首次 ensure：新 ID 无数据 → 旧 ID 目录迁移过来，历史设置保持可见
    const real = await store.ensure(projectRoot);
    assert.notEqual(real.workspace_id, legacyId);
    assert.equal(
      await fs.access(legacyDir).then(() => true, () => false),
      false,
      "旧 ID 目录应被一次性迁移（原路径不复存在）"
    );
    const migrated = await store.loadSettings(projectRoot);
    assert.equal(migrated.tool_permissions.read_only, true, "迁移后的旧设置仍可读");

    // 别名路径打开：ID 必须一致（不再分裂）
    const viaAlias = await store.ensure(alias);
    assert.equal(viaAlias.workspace_id, real.workspace_id, "别名路径与真实路径同 ID");
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("新 ID 目录已存在（agent 会话先建）时不尝试迁移：旧目录保留、ensure 正常完成", async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-store-occupied-"));
  const projectRoot = path.join(stateRoot, "novel");
  await fs.mkdir(projectRoot, { recursive: true });
  try {
    const store = createWorkspaceStore({ stateRoot });
    const target = await store.ensure(projectRoot); // 先写 workspace.json，拿到新 ID
    const newDir = path.join(stateRoot, "workspaces", target.workspace_id);
    // 模拟 agent 会话先占用新 ID 目录 + workspace.json 尚未存在（审查 S1 时序）
    await fs.rm(path.join(newDir, "workspace.json"));
    await fs.mkdir(path.join(newDir, "agent", "sessions"), { recursive: true });
    // 旧 ID 目录带历史数据
    const legacyId = "ws_" + "f".repeat(32);
    const legacyDir = path.join(stateRoot, "workspaces", legacyId);
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, "workspace.json"),
      JSON.stringify({ schema_version: 1, workspace_id: legacyId, project_root: projectRoot, created_at: "2026-01-01", last_opened_at: "2026-01-01" })
    );
    // 再次 ensure：目标目录已存在 → 不迁移、旧目录保留、无异常
    const again = await store.ensure(projectRoot);
    assert.equal(again.workspace_id, target.workspace_id);
    assert.equal(
      await fs.access(legacyDir).then(() => true, () => false),
      true,
      "无法 rename 时旧目录必须原样保留（数据不丢）"
    );
    assert.equal(await fs.access(path.join(newDir, "workspace.json")).then(() => true, () => false), true);
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true }).catch(() => {});
  }
});
