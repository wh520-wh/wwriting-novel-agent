// src/core/project-model-migration.mjs —— 任务 6：项目快照 → 引用迁移。
//
// 重构后项目只存引用 {provider_id, model_id}，运行时由 model-reference.mjs 的
// resolveActiveModel 解析。本模块把已存在的完整快照迁移为引用：
//
//   - mock 快照归零为 null（未配置）；
//   - 能匹配全局供应商→模型清单（provider + base_url + model_name）的转引用；
//   - 匹配不到（自定义端点/清单外模型）保持字面配置，兼容未迁移配置；
//   - 已是引用形态 / null / 缺 store 一律不动。
//
// migrateProjectActiveModel 是纯函数（快照 + store → 结果），
// migrateProjectFile 落地：project.yaml 快照与私有 workspace settings 快照都转
// 引用。两者都幂等：第二次调用不再写入。
//
// 清单读取只读：model-profiles.json 由 v2 provider store（model-provider-store.mjs）
// 独占读写（v1 存储模块已在 Task 17 cutover 删除）。
// loadProviderStore 读到 v1 会自动转换并写回；迁移是读路径，只消费已持久化的 v2
// 清单（v1/未知格式按空清单处理——mock 归零不依赖清单，引用转换等 v2 落盘后由
// 幂等重跑自然完成）。内存转换 v1 得出的 provider id 未持久化，据此产出引用会
// 悬空，故 v1 下绝不转引用。
import path from "node:path";
import { loadProject, saveProject } from "./project-store.mjs";
import { readJson } from "./fs-utils.mjs";
import { normalizeProviderStore } from "./model-provider-store.mjs";

const PROVIDER_STORE_FILE = "model-profiles.json";

// 只读加载全局供应商→模型清单（不触发 loadProviderStore 的 v1→v2 写回）。
// 仅接受已持久化的 v2 schema；v1/未知/缺失按空清单处理（见文件头注释）。
export async function loadProviderStoreReadOnly(secretsRoot) {
  try {
    const raw = await readJson(path.join(path.resolve(secretsRoot), PROVIDER_STORE_FILE), null);
    if (!raw || typeof raw !== "object" || raw.schema_version !== 2) return { providers: [] };
    return normalizeProviderStore(raw) ?? { providers: [] };
  } catch (error) {
    // 真实 IO 失败（权限拒绝等）要与"尚无 v2 清单"可区分：缺失由 readJson 兜底，
    // JSON 语法错误按空清单静默；其余错误告警后仍按空清单返回。
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      console.warn(`[project-model-migration] 读取 ${PROVIDER_STORE_FILE} 失败，按空清单处理:`, error?.message ?? error);
    }
    return { providers: [] };
  }
}

// 快照 → 引用：mock 归零；匹配（provider+base_url+model_name）转引用；其余保持字面。
export function migrateProjectActiveModel(activeModel, store) {
  if (!activeModel || typeof activeModel !== "object") return { active_model: activeModel ?? null, changed: false };
  if (activeModel.provider === "mock") return { active_model: null, changed: true };
  if (typeof activeModel.provider_id === "string" && typeof activeModel.model_id === "string") {
    return { active_model: activeModel, changed: false };
  }
  if (activeModel.provider === "openai-compatible" && activeModel.base_url && activeModel.model_name) {
    for (const provider of store?.providers ?? []) {
      if (provider.status === "disabled") continue;
      if (String(provider.base_url).replace(/\/+$/u, "").toLowerCase() !== String(activeModel.base_url).replace(/\/+$/u, "").toLowerCase()) continue;
      const model = provider.models?.find((m) => m.model_name === activeModel.model_name && m.enabled !== false);
      if (model) return { active_model: { provider_id: provider.id, model_id: model.id }, changed: true };
    }
  }
  return { active_model: activeModel, changed: false };
}

// 迁移项目文件：project.yaml 快照 与 私有 settings 快照 都转引用。
export async function migrateProjectFile(projectRoot, { workspaceStore, secretsRoot, readProject = loadProject, writeProject = saveProject, storeLoader = null } = {}) {
  if (!workspaceStore || !secretsRoot) return { changed: false };
  // 缺省只读加载（见文件头注释）；storeLoader 供测试注入自定义清单。
  const loadStore = storeLoader ?? (() => loadProviderStoreReadOnly(secretsRoot));
  const store = await loadStore();
  let changed = false;
  let legacy = null;
  try { legacy = await readProject(projectRoot); } catch { legacy = null; }
  if (legacy && typeof legacy === "object") {
    const active = await migrateProjectActiveModel(legacy.active_model ?? null, store);
    if (active.changed) {
      const next = { ...legacy, active_model: active.active_model };
      await writeProject(projectRoot, next);
      changed = true;
    }
  }
  const settings = await workspaceStore.loadSettings(projectRoot).catch(() => ({}));
  if (settings?.active_model) {
    const active = await migrateProjectActiveModel(settings.active_model, store);
    if (active.changed) {
      await workspaceStore.saveSettings(projectRoot, { active_model: active.active_model });
      changed = true;
    }
  }
  return { changed };
}
