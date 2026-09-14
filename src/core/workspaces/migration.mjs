// src/core/workspaces/migration.mjs —— 旧 project.yaml 确定性项目资料迁移
//（计划 Task 11；Task 13 起聊天迁移已整体删除，本模块只保留资料/技能无关迁移）。
//
// 旧项目内 Agent 数据（.wwriting/agent）的聊天迁移路径（workspace 复制 +
// Journal 单体导入）已在 Task 13 整体删除：新 storage generation 只读取新格式
// segments；旧 flat/project agent/chat 数据不再进入会话列表、snapshot、SSE、
// 历史导出或模型上下文。旧 .wwriting/agent 目录原样保留（不删除、不改写）。
//
// 契约（SPEC §9.1 / brief Step 1-4；冻结合并契约见 config-runtime §2.3）：
//   - 首次打开旧项目时，把标题/题材/章节字数目标/输出格式整理进 WWRITING.md，
//     把模型选择与 4-bool 权限默认值写入应用私有 settings.json；
//   - 原 project.yaml 不删除、不覆盖、不改写（字节不变，保留回滚依据）；
//   - 新工作区（无 project.yaml）不创建 project.yaml，迁移返回 missing；
//   - 旧世界持久字段、临时授权、运行阶段、失败状态、派生索引不写入长期记忆；
//     字数字段只写成“参考/目标”散文，绝不变成门禁；
//   - 迁移标记 legacy_project_imported **最后**写入：读取旧配置 → 写/合并
//     WWRITING.md → 写私有 settings → 验证可重读 → 标记 true。任一步失败保持
//     false，下次打开重试；聊天资格从不依赖迁移成功（migrateLegacyProject
//     绝不向调用方抛错）。
import path from "node:path";
import { pathExists, safeJoin } from "../fs-utils.mjs";
import { loadProject } from "../project-store.mjs";
import { mergeProjectMemory } from "../project-memory.mjs";

// stringOrEmpty：只接受非空字符串，否则返回空串。
export function stringOrEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value : "";
}

// positiveFact：只接受正整数，否则返回空串（render(value) 由调用方提供文案）。
export function positiveFact(value, render) {
  return Number.isInteger(value) && value > 0 ? render(value) : "";
}

// discoverLegacyAuthorityFiles：仅用 pathExists 检查固定候选，返回实际存在项，
// 不推测文件名。标签为稳定中文标签（与 renderInitialProjectMemory 的 files 形状
// `{ label: 相对路径 }` 一致）。
export async function discoverLegacyAuthorityFiles(projectRoot) {
  const candidates = [
    ["总纲", "OUTLINE.md"],
    ["设定", "SETTING.md"],
    ["规则", "AGENTS.md"],
    ["章节", "chapters/"],
    ["正文", "正文/"]
  ];
  const found = {};
  const results = await Promise.all(
    candidates.map(async ([label, rel]) => [label, rel, await pathExists(safeJoin(projectRoot, rel))])
  );
  for (const [label, rel, exists] of results) {
    if (exists) found[label] = rel;
  }
  return found;
}

// legacyProjectFacts：只映射确定字段（brief Step 2 的字段名与渲染文案逐字采用）。
// discoverLegacyAuthorityFiles 需要 projectRoot，故与 brief 片段相比补充第二个参数
//（brief 片段内部引用的 projectRoot 未入参，属笔误；字段映射与文案保持不变）。
export async function legacyProjectFacts(project, projectRoot) {
  return {
    title: stringOrEmpty(project?.title),
    projectPositioning: stringOrEmpty(project?.story_seed),
    requirements: [
      positiveFact(project?.target_chapters, (v) => `计划约 ${v} 章。`),
      positiveFact(project?.min_words_per_chapter, (v) => `单章最低参考约 ${v} 字。`),
      positiveFact(project?.target_words_per_chapter, (v) => `单章目标约 ${v} 字。`),
      project?.output_format ? `正文格式：${project.output_format}。` : ""
    ].filter(Boolean),
    files: await discoverLegacyAuthorityFiles(projectRoot)
  };
}

// 4-bool 权限等价映射（Task 5 裁决 / 控制器第 1 条）：旧 project.yaml 的
// tool_permissions 中只有 read_only/auto_edit/network_allowed/yolo 有私有
// settings 的 4-bool 等价字段；safe_edit/test_allowed/dangerous 无等价字段，
// 不得发明映射。只携带 truthy 值——legacy 为 false 或缺失时保持私有默认
//（false），绝不把用户已在私有 settings 开启的权限降级。
const LEGACY_PERMISSION_MAP = Object.freeze([
  ["read_only", "read_only"],
  ["auto_edit", "auto_edit"],
  ["network_allowed", "network_allowed"],
  ["yolo", "yolo"]
]);

// legacySettingsImport：返回应写入私有 settings 的补丁（active_model +
// tool_permissions），无映射内容时返回 {}（调用方跳过写入）。
export function legacySettingsImport(project) {
  const sourcePermissions = project?.tool_permissions && typeof project.tool_permissions === "object"
    ? project.tool_permissions
    : {};
  const toolPermissions = {};
  for (const [legacyKey, privateKey] of LEGACY_PERMISSION_MAP) {
    if (sourcePermissions[legacyKey] === true) toolPermissions[privateKey] = true;
  }
  const patch = {};
  const activeModel = legacyActiveModel(project);
  if (activeModel) patch.active_model = activeModel;
  if (Object.keys(toolPermissions).length > 0) patch.tool_permissions = toolPermissions;
  return patch;
}

// 旧 active_model 只在其为“确定字段”时携带：引用形态（provider_id + model_id，任务 6
// 迁移后）直接通过；字面快照要求含非空 model_name。不为 default_writer_model 等派生
// 字段发明模型配置（provider 缺失即未配置——分发抛 ProviderConfigurationError，不再回落 mock）。
function legacyActiveModel(project) {
  const active = project?.active_model;
  if (!active || typeof active !== "object" || Array.isArray(active)) return null;
  // 引用形态（provider_id + model_id）：直接通过，不做 model_name 断言
  if (typeof active.provider_id === "string" && typeof active.model_id === "string") return { ...active };
  if (typeof active.model_name !== "string" || active.model_name.trim() === "") return null;
  return { ...active };
}

// migrateLegacyProject：旧 project.yaml → WWRITING.md + 私有 settings 的一次性
// 只读迁移。返回 { imported, reason? }，绝不抛错；聊天资格不依赖其成功。
export async function migrateLegacyProject({ projectRoot, workspaceStore, diagnostic = console.warn }) {
  const resolvedRoot = path.resolve(projectRoot);
  try {
    if (!workspaceStore || typeof workspaceStore.saveSettings !== "function") {
      throw new Error("workspaceStore is required");
    }
    // 已导入：幂等跳过（第二次打开不再重写任何文件）。
    if ((await workspaceStore.loadSettings(resolvedRoot)).legacy_project_imported) {
      return { imported: true, reason: "already_imported" };
    }
    // Step 1：读取旧配置。无 project.yaml → 无数据可迁移（新工作区），不写任何文件。
    let project = null;
    try {
      project = await loadProject(resolvedRoot);
    } catch (error) {
      if (error?.code === "ENOENT") return { imported: false, reason: "missing" };
      throw error;
    }
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new Error("project.yaml 内容不可用");
    }
    // Step 2：写/合并 WWRITING.md（缺失→初始模板；已存在→只补缺失且不冲突的索引）。
    const facts = await legacyProjectFacts(project, resolvedRoot);
    await mergeProjectMemory(resolvedRoot, facts);
    // Step 3：写私有 settings（模型 + 权限成对/按需写入；store 归一化保留另一侧）。
    const settingsPatch = legacySettingsImport(project);
    if (Object.keys(settingsPatch).length > 0) {
      await workspaceStore.saveSettings(resolvedRoot, settingsPatch);
    }
    // Step 4：验证可重读（导入的值必须能读回，否则标记不落、下次重试）。
    await verifySettingsReReadable(resolvedRoot, { workspaceStore, settingsPatch });
    // Step 5：迁移标记最后写入。任何失败都保持 false → 下次打开重试。
    await workspaceStore.saveSettings(resolvedRoot, { legacy_project_imported: true });
    return { imported: true };
  } catch (error) {
    diagnostic("[workspace-migration] legacy project import failed", error);
    return { imported: false, reason: "invalid_source" };
  }
}

async function verifySettingsReReadable(projectRoot, { workspaceStore, settingsPatch }) {
  const reread = await workspaceStore.loadSettings(projectRoot);
  if (settingsPatch.active_model) {
    const model = reread.active_model;
    const patchModel = settingsPatch.active_model;
    const same =
      model && typeof model === "object" &&
      (patchModel.provider_id !== undefined
        ? model.provider_id === patchModel.provider_id && model.model_id === patchModel.model_id
        : model.model_name === patchModel.model_name);
    if (!same) throw new Error("settings re-read lost active_model");
  }
  for (const key of Object.keys(settingsPatch.tool_permissions ?? {})) {
    if (reread.tool_permissions?.[key] !== true) {
      throw new Error(`settings re-read lost tool_permissions.${key}`);
    }
  }
}
