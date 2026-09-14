// 应用私有 workspace store（计划 Task 2）。
//
// 职责：把任意项目路径映射为稳定 workspace id（ws_<32-hex>），并把应用私有
// 数据（workspace.json、settings.json、agent journal 等）落在
// <stateRoot>/workspaces/<id>/ 下，绝不写入项目目录。
//
// 数据契约（SPEC §2.1/§2.2）：
//   - canonicalWorkspacePath：Windows 路径大小写不敏感，统一小写后再哈希；
//   - workspace.json 记录 workspace_id、project_root 与首次/最近打开时间；
//   - settings.json 只保存白名单字段，normalizeWorkspaceSettings() 丢弃未知字段。
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../fs-utils.mjs";

export function canonicalWorkspacePath(projectRoot) {
  const resolved = path.resolve(projectRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function workspaceIdForPath(projectRoot) {
  const digest = createHash("sha256").update(canonicalWorkspacePath(projectRoot)).digest("hex").slice(0, 32);
  return `ws_${digest}`;
}

const DEFAULT_SETTINGS = Object.freeze({
  schema_version: 1,
  active_model: null,
  tool_permissions: Object.freeze({
    read_only: false,
    auto_edit: false,
    network_allowed: false,
    yolo: false
  }),
  legacy_project_imported: false
});

function normalizeWorkspaceSettings(value) {
  const permissions = value?.tool_permissions ?? {};
  return {
    schema_version: 1,
    active_model: value?.active_model && typeof value.active_model === "object"
      ? structuredClone(value.active_model)
      : null,
    tool_permissions: {
      read_only: permissions.read_only === true,
      auto_edit: permissions.auto_edit === true,
      network_allowed: permissions.network_allowed === true,
      yolo: permissions.yolo === true
    },
    legacy_project_imported: value?.legacy_project_imported === true
  };
}

export function createWorkspaceStore({ stateRoot, clock = () => new Date().toISOString() }) {
  const root = path.resolve(stateRoot);
  const directoryFor = (projectRoot) => path.join(root, "workspaces", workspaceIdForPath(projectRoot));
  const agentRootFor = (projectRoot) => path.join(directoryFor(projectRoot), "agent");

  async function ensure(projectRoot) {
    const resolved = path.resolve(projectRoot);
    const workspace_id = workspaceIdForPath(resolved);
    const directory = directoryFor(resolved);
    await fs.mkdir(directory, { recursive: true });
    const previous = await readJson(path.join(directory, "workspace.json"), null).catch(() => null);
    const metadata = {
      schema_version: 1,
      workspace_id,
      project_root: resolved,
      created_at: previous?.created_at ?? clock(),
      last_opened_at: clock()
    };
    await writeJsonAtomic(path.join(directory, "workspace.json"), metadata);
    return { ...metadata, directory, agentRoot: agentRootFor(resolved) };
  }

  async function loadSettings(projectRoot) {
    const target = path.join(directoryFor(projectRoot), "settings.json");
    const value = await readJson(target, null).catch(() => null);
    return normalizeWorkspaceSettings(value);
  }

  async function saveSettings(projectRoot, patch) {
    await ensure(projectRoot);
    const next = normalizeWorkspaceSettings({ ...(await loadSettings(projectRoot)), ...patch });
    await writeJsonAtomic(path.join(directoryFor(projectRoot), "settings.json"), next);
    return next;
  }

  return { ensure, loadSettings, saveSettings, directoryFor, agentRootFor };
}
