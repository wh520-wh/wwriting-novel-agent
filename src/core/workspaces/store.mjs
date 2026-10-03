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
import { physicalPathKey, readJson, renameWithRetry, writeJsonAtomic } from "../fs-utils.mjs";

// 物理路径身份（2026-10-03，ADR 0009）：canonicalWorkspacePath 用真实路径
// （解析 junction/symlink + 磁盘真实大小写）——同一项目经别名打开得到同一
// workspace ID；路径不存在时回退 resolve。旧 ID（大小写变体/别名路径哈希出的）
// 数据经 ensure 的一次性迁移保持可见。
export function canonicalWorkspacePath(projectRoot) {
  return physicalPathKey(projectRoot);
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
    // 旧 ID 迁移（2026-10-03）：身份改用物理路径后，同一项目经旧路径书写打开会
    // 哈希出不同 ID——首次 ensure 时把 project_root 指向同一物理目录的旧 ID 目录
    // 重命名到新 ID，历史会话数据（agent journal 等）保持可见。
    // 触发条件是「目标目录尚不存在」：agent 会话会绕过 ensure 直接创建
    // <workspaces>/<新ID>/agent/（session-registry），此时旧目录无法 rename 进来
    //（Windows EPERM / POSIX ENOTEMPTY），会话注册表的合并也超出本层职责——
    // 旧目录原样保留（数据不丢）并告警，历史在新 ID 下不可见是记录在案的已知限制。
    const directoryExists = await fs.access(directory).then(() => true, () => false);
    if (!directoryExists) {
      await adoptLegacyWorkspaceDirectory({ root, workspace_id, directory, resolved });
    }
    const previous = await readJson(path.join(directory, "workspace.json"), null).catch(() => null);
    await fs.mkdir(directory, { recursive: true });
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

  // 把 project_root 指向同一物理目录的旧 workspace 目录迁移到当前 ID（一次性，
  // rename 到不存在的目标目录）。找不到可迁移的旧目录时不做任何事。
  // ponytail: 多个旧 ID 指向同一物理目录时只迁第一个（readdir 顺序），其余保留
  // 为孤儿目录——目录合并需要合并会话注册表，超出本层职责；升级路径是显式的
  // 合并迁移工具。
  async function adoptLegacyWorkspaceDirectory({ root: stateRoot, workspace_id, directory, resolved }) {
    let entries;
    try {
      entries = await fs.readdir(path.join(stateRoot, "workspaces"));
    } catch {
      return;
    }
    const resolvedReal = await fs.realpath(resolved).catch(() => null);
    if (!resolvedReal) return;
    for (const entry of entries) {
      if (entry === workspace_id) continue;
      const legacyDir = path.join(stateRoot, "workspaces", entry);
      const meta = await readJson(path.join(legacyDir, "workspace.json"), null).catch(() => null);
      if (!meta?.project_root) continue;
      const metaReal = await fs.realpath(meta.project_root).catch(() => null);
      if (!metaReal) continue;
      // 物理键比较（win32 才小写；POSIX 大小写敏感，两个书写是不同项目）
      if (physicalPathKey(metaReal) === physicalPathKey(resolvedReal)) {
        try {
          await renameWithRetry(legacyDir, directory);
        } catch (error) {
          // 目标被并发创建/目录占用等：保留旧目录（数据不丢），显式告警——
          // 不静默吞掉「迁移没发生」这个事实。
          console.warn(`[workspace-store] 旧工作区 ${entry} 迁移失败，历史数据保留在原目录：${error?.code ?? error?.message ?? error}`);
        }
        return;
      }
    }
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
