import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { forgetRecentProject, loadAppState, loadAppStateSync, recordRecentProject } from "../src/core/app-state.mjs";
import { workspaceIdForPath } from "../src/core/workspaces/store.mjs";

test("recordRecentProject dedupes by path, preserves position, and updates metadata in place", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-appstate-"));
  await recordRecentProject(root, { projectRoot: "/novels/a", title: "A", story_seed: "seed-a" });
  await recordRecentProject(root, { projectRoot: "/novels/b", title: "B" });
  let state = await recordRecentProject(root, { projectRoot: "/novels/a", title: "A2", story_seed: "seed-a2" });

  // lastProjectRoot 仍然反映最近一次打开的项目（用于"启动时自动重开"）。
  assert.equal(state.lastProjectRoot, path.resolve("/novels/a"));
  assert.equal(state.recentProjects.length, 2);
  // 顺序稳定：b 是后加入的新项目占第一位；重新打开 a 不会改变它在第二位的位置。
  assert.equal(state.recentProjects[0].projectRoot, path.resolve("/novels/b"));
  assert.equal(state.recentProjects[1].projectRoot, path.resolve("/novels/a"));
  // 但 a 的元数据已经被原地更新。
  assert.equal(state.recentProjects[1].title, "A2");
  assert.equal(state.recentProjects[1].story_seed, "seed-a2");

  const sync = loadAppStateSync(root);
  assert.equal(sync.lastProjectRoot, path.resolve("/novels/a"));
});

test("recordRecentProject caps the recent list at 12 entries (newest project prepended)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-appstate-cap-"));
  for (let i = 0; i < 20; i += 1) {
    await recordRecentProject(root, { projectRoot: `/novels/p${i}`, title: `P${i}` });
  }
  const state = await loadAppState(root);
  assert.equal(state.recentProjects.length, 12);
  // 新项目都是"未见过"，全部走 prepend 路径；最后一个加入的 p19 在最前。
  assert.equal(state.recentProjects[0].projectRoot, path.resolve("/novels/p19"));
  assert.equal(state.recentProjects[11].projectRoot, path.resolve("/novels/p8"));
  assert.equal(state.lastProjectRoot, path.resolve("/novels/p19"));
});

test("forgetRecentProject removes an entry and updates last project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-appstate-forget-"));
  await recordRecentProject(root, { projectRoot: "/novels/x", title: "X" });
  await recordRecentProject(root, { projectRoot: "/novels/y", title: "Y" });
  const state = await forgetRecentProject(root, "/novels/y");
  assert.equal(state.recentProjects.length, 1);
  assert.equal(state.recentProjects[0].projectRoot, path.resolve("/novels/x"));
  assert.equal(state.lastProjectRoot, path.resolve("/novels/x"));
});

test("loadAppState returns an empty baseline when no state file exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-appstate-empty-"));
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const state = await loadAppState(root);
    assert.equal(state.lastProjectRoot, null);
    assert.deepEqual(state.recentProjects, []);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
});

test("loadAppState warns when an existing state file is invalid", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-appstate-invalid-"));
  await fs.writeFile(path.join(root, "app-state.json"), "{bad json", "utf8");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const state = await loadAppState(root);
    assert.equal(state.lastProjectRoot, null);
    assert.deepEqual(state.recentProjects, []);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /\[app-state\]/u);
});

test("loadAppStateSync returns an empty baseline quietly when no state file exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-appstate-sync-empty-"));
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const state = loadAppStateSync(root);
    assert.equal(state.lastProjectRoot, null);
    assert.deepEqual(state.recentProjects, []);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
});

test("loadAppStateSync warns when an existing state file is invalid", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-appstate-sync-invalid-"));
  await fs.writeFile(path.join(root, "app-state.json"), "{bad json", "utf8");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const state = loadAppStateSync(root);
    assert.equal(state.lastProjectRoot, null);
    assert.deepEqual(state.recentProjects, []);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /\[app-state\]/u);
});

test("旧 app-state.json 无 workspace_id 时加载补齐且不丢 recent 顺序", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-appstate-upgrade-"));
  const legacy = {
    lastProjectRoot: "/novels/b",
    recentProjects: [
      { projectRoot: "/novels/b", title: "B", story_seed: "", openedAt: "2026-08-01T00:00:00.000Z" },
      { projectRoot: "/novels/a", title: "A", story_seed: "s", openedAt: "2026-08-02T00:00:00.000Z" }
    ]
  };
  await fs.writeFile(path.join(root, "app-state.json"), JSON.stringify(legacy), "utf8");
  const state = await loadAppState(root);
  assert.equal(state.recentProjects.length, 2);
  assert.equal(state.recentProjects[0].projectRoot, path.resolve("/novels/b"));
  assert.equal(state.recentProjects[1].projectRoot, path.resolve("/novels/a"));
  assert.equal(state.recentProjects[0].workspace_id, workspaceIdForPath("/novels/b"));
  assert.equal(state.recentProjects[1].workspace_id, workspaceIdForPath("/novels/a"));
});

test("recordRecentProject 条目包含稳定 workspace_id，重开不挪动 recent 位置", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-appstate-wsid-"));
  await recordRecentProject(root, { projectRoot: "/novels/a", title: "A" });
  await recordRecentProject(root, { projectRoot: "/novels/b", title: "B" });
  const state = await recordRecentProject(root, { projectRoot: "/novels/a", title: "A2" });
  assert.equal(state.recentProjects.length, 2);
  // 重新打开 a 不挪动位置：b 仍在前。
  assert.equal(state.recentProjects[0].projectRoot, path.resolve("/novels/b"));
  assert.equal(state.recentProjects[1].projectRoot, path.resolve("/novels/a"));
  // 每个条目都带稳定 workspace_id，且与 store 的 id 函数一致。
  assert.match(state.recentProjects[0].workspace_id, /^ws_[a-f0-9]{32}$/u);
  assert.equal(state.recentProjects[0].workspace_id, workspaceIdForPath("/novels/b"));
  assert.equal(state.recentProjects[1].workspace_id, workspaceIdForPath("/novels/a"));
  // 再次加载后 id 保持不变（同路径重开恢复同一 id）。
  const reloaded = await loadAppState(root);
  assert.equal(reloaded.recentProjects[1].workspace_id, state.recentProjects[1].workspace_id);
});
