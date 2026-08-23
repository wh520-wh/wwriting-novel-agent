// src/core/project-listing.mjs —— 项目清单组装与归档门禁（第十五轮 F10 Task 21）。
//
// 从 http/project-routes.mjs 下沉的业务逻辑：
//   - buildProjectList：项目列表组装（响应形状与旧路由契约一致）；
//   - assertNotArchived：归档校验门禁单源——原 project-routes（loadProject 直读）
//     与 settings-routes（loadEffectiveWorkspaceConfig）两份实现合一，取「有效
//     配置」语义：普通目录（无 project.yaml）宽容——应用私有 settings 不保存归档
//     状态，归档只来自旧 project.yaml；返回值是合并后的有效配置（settings/update
//     与 model-switch 依此合并 tool_permissions）。workspaceStore 缺失时回落旧
//     project.yaml 直读分支，不注入 store 的组合保持 project-routes 旧行为。
//
// 依赖以参数注入：workspace/stateRoot/workspaceStore/currentSelected 由路由壳
//（createProjectRoutes 工厂）传递；网络外呼一概不在此模块。
//
// 依赖注记：本模块 import settings-runtime（modelDisplayName），settings-runtime
// 又因 switchModelByReference 的归档校验 import 本模块（assertNotArchived）。
// 该环两端都只在函数体内使用对方导出、模块顶层零求值，ESM live bindings 下
// 运行时安全；新增顶层求值引用前需重新评估。
import path from "node:path";
import { existsSync } from "node:fs";
import { HttpError } from "./http-error.mjs";
import { loadConfigLayers, loadEffectiveWorkspaceConfig } from "./config-runtime.mjs";
import { loadProject } from "./project-store.mjs";
import { loadAppState, samePath } from "./app-state.mjs";
import { validateWorkspaceRoot } from "./app-dashboard.mjs";
import { isPathInside } from "./fs-utils.mjs";
import { workspaceIdForPath } from "./workspaces/store.mjs";
import { modelDisplayName } from "./settings-runtime.mjs";

export async function assertNotArchived(projectRoot, { workspaceStore } = {}) {
  // store 在位走「有效配置」语义（settings 版：普通目录宽容、返回合并配置）；
  // store 缺失回落 loadProject 直读——project-routes 旧语义的兼容守卫，生产
  // 恒注入 store，此分支无直接触发方。
  const project = workspaceStore
    ? await loadEffectiveWorkspaceConfig(projectRoot, { workspaceStore })
    : await loadProject(projectRoot);
  if (project.archived_at) {
    throw new HttpError(400, "PROJECT_ARCHIVED", "项目已归档（只读）。请先解除归档再执行此操作。");
  }
  return project;
}

// 项目列表（旧 POST/GET /api/projects 契约形状不变）：
//   - 最近列表 + 当前选中并集去重；目录不可访问不入列表；
//   - 旧项目（有 project.yaml）以文件为元数据真相源；普通目录以工作区设置
//     （应用私有）为模型真相源（计划 Task 4 Step 4 形状）。
export async function buildProjectList({ workspace, stateRoot, workspaceStore, currentSelected }) {
  const state = await loadAppState(stateRoot);
  const candidates = [...state.recentProjects];
  if (currentSelected && !candidates.some((item) => samePath(item.projectRoot, currentSelected))) {
    candidates.push({ projectRoot: currentSelected });
  }
  const projects = [];
  for (const item of candidates) {
    const root = path.resolve(item.projectRoot);
    if (projects.some((project) => samePath(project.projectRoot, root))) {
      continue;
    }
    // 目录仍可访问才入列表（计划 Task 4：project.yaml 不再是列表资格条件）；
    // 已删除/无权限目录不出现在列表里。
    try {
      await validateWorkspaceRoot(root);
    } catch {
      continue;
    }
    const workspaceSettings = workspaceStore ? await workspaceStore.loadSettings(root) : null;
    if (existsSync(path.join(root, "project.yaml"))) {
      // 旧项目：project.yaml 是元数据真相源（沿用既有契约）。
      let title = item.title ?? path.basename(root);
      let storySeed = item.story_seed ?? "";
      let activeModel = null;
      let archivedAt = null;
      try {
        const project = await loadProject(root);
        title = project.title ?? title;
        storySeed = project.story_seed ?? storySeed;
        const config = await loadConfigLayers(root, project).catch(() => null);
        activeModel = config?.effective?.active_model ?? project.active_model ?? null;
        archivedAt = project.archived_at ?? null;
      } catch (error) {
        console.warn("[project-listing] Failed to load project metadata:", error.message);
      }
      projects.push({
        projectRoot: root,
        workspace_id: item.workspace_id ?? workspaceIdForPath(root),
        title,
        story_seed: storySeed,
        active_model: activeModel,
        model_label: activeModel ? modelDisplayName(activeModel) : "未配置",
        archived_at: archivedAt,
        external: !isPathInside(workspace, root),
        legacy_project: true
      });
    } else {
      // 普通目录：工作区设置（应用私有）是模型真相源（计划 Task 4 Step 4 形状）。
      const activeModel = workspaceSettings?.active_model ?? null;
      projects.push({
        projectRoot: root,
        workspace_id: item.workspace_id ?? workspaceIdForPath(root),
        title: item.title || path.basename(root),
        story_seed: item.story_seed || "",
        active_model: activeModel,
        model_label: activeModel ? modelDisplayName(activeModel) : "未配置",
        archived_at: null,
        external: !isPathInside(workspace, root),
        legacy_project: false
      });
    }
  }
  const selectedInList = currentSelected && projects.some((project) => samePath(project.projectRoot, currentSelected))
    ? currentSelected
    : null;
  return {
    ok: true,
    workspaceRoot: workspace,
    selectedProjectRoot: selectedInList,
    projects
  };
}
