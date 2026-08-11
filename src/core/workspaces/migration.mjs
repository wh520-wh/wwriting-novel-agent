// src/core/workspaces/migration.mjs —— 旧项目内 Agent 数据只读迁移（计划 Task 3；
// Task 4 起同时支持新分段格式源）。
//
// 把旧 <projectRoot>/.wwriting/agent/ 的 journal 数据复制到应用私有 workspace
// 目录（targetAgentRoot），供新会话作为唯一真相源使用。契约（SPEC §9.2）：
//
//   - 旧（legacy）格式源只复制白名单：events.jsonl / session.json / transcript.jsonl /
//     checkpoints/；绝不复制旧 migration.json（应用私有迁移状态由 journal 自行维护）；
//   - 新分段格式源（存在 journal-manifest.json 或 segments/）事务复制 segments/、
//     journal-manifest.json、session.json、active-context.json、checkpoints/；
//     events.jsonl/transcript.jsonl 只属于旧格式源（供 Journal 一次性迁移）；
//   - 目标已有任何 journal 数据（非空 manifest、任一 segment、旧 events.jsonl /
//     transcript.jsonl 或 session.json）时拒绝复制（target_not_empty），目标数据
//     绝不覆盖——新格式目标没有单体 events.jsonl 时第二次 open 同样返回
//     target_not_empty，不会重复复制旧源；
//   - 旧格式源复制前校验旧 events.jsonl 的 seq 连续性（从 1 起、无中间缺口）；尾部
//     半行截断（崩溃痕迹）容忍（与 journal.load() 的截断修复语义一致），中间的非法
//     行视为损坏（invalid_source），不产生任何半份复制产物；
//   - 原目录只读：不删除、不重命名、不覆盖，字节完全不变；
//   - 幂等：目标已有数据时第二次调用返回 target_not_empty，不重复、不覆盖。
//
// 本模块不写任何迁移标记（目标 journal 数据的存在性即幂等依据）；更老的
// legacy flat-file 导入标记由 journal.readMigration()/writeMigration() 维护。
// 迁移失败绝不抛给调用方（返回 { imported: false, reason }，技术详情经
// diagnostic 写入日志），保证 open() 在旧数据损坏时仍能开始新会话。
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, safeJoin } from "../fs-utils.mjs";
import { loadProject } from "../project-store.mjs";
import { mergeProjectMemory } from "../project-memory.mjs";

// 旧格式白名单（新格式源不再复制这两个单体文件——Journal 在目标端直接读 segments）。
const LEGACY_COPY_FILES = Object.freeze(["events.jsonl", "session.json", "transcript.jsonl"]);
// 新分段格式白名单。
const NEW_FORMAT_FILES = Object.freeze(["journal-manifest.json", "session.json", "active-context.json"]);
const SEGMENT_RE = /^\d{8}\.jsonl$/u;

async function hasNonEmptyFile(target) {
  try {
    return (await fs.stat(target)).size > 0;
  } catch {
    return false;
  }
}

// 目标端是否有任何 journal 数据：非空 manifest、任一 segment、旧单体文件或
// session.json —— 任一存在即 target_not_empty（不因缺少单体 events.jsonl 而漏判）。
async function hasJournalData(targetAgentRoot) {
  if (await hasNonEmptyFile(path.join(targetAgentRoot, "journal-manifest.json"))) return true;
  for (const stream of ["events", "transcript"]) {
    const dir = path.join(targetAgentRoot, "segments", stream);
    try {
      for (const name of await fs.readdir(dir)) {
        if (SEGMENT_RE.test(name)) return true;
      }
    } catch {
      // 目录缺失 → 继续检查其他来源
    }
  }
  if (await hasNonEmptyFile(path.join(targetAgentRoot, "events.jsonl"))) return true;
  if (await hasNonEmptyFile(path.join(targetAgentRoot, "transcript.jsonl"))) return true;
  if (await hasNonEmptyFile(path.join(targetAgentRoot, "session.json"))) return true;
  return false;
}

async function copyIfPresent(source, target) {
  try {
    await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EEXIST") throw error;
  }
}

async function copyDirectoryIfPresent(source, target) {
  try {
    await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EEXIST") throw error;
  }
}

// 校验旧 events.jsonl：逐行 JSON.parse + seq 从 1 连续递增；最后一行不完整
// （崩溃痕迹）容忍，中间损坏行抛错拒绝导入。
async function validateLegacyEvents(target) {
  let raw;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const lines = raw.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  let expected = 1;
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const event = JSON.parse(lines[index]);
      if (event.seq !== expected) throw new Error(`事件 seq 应为 ${expected}`);
      expected += 1;
    } catch (error) {
      if (index === lines.length - 1) break;
      throw error;
    }
  }
}

export async function migrateProjectAgentStorage({ projectRoot, targetAgentRoot, diagnostic = console.warn }) {
  const source = path.join(path.resolve(projectRoot), ".wwriting", "agent");
  if (!(await pathExists(source))) return { imported: false, reason: "missing" };
  await fs.mkdir(targetAgentRoot, { recursive: true });
  if (await hasJournalData(targetAgentRoot)) {
    return { imported: false, reason: "target_not_empty" };
  }
  // 新格式判定：manifest 或 segments/ 存在即按新格式复制（COPY_FILES 不再决定白名单）
  const isNewFormat =
    (await pathExists(path.join(source, "journal-manifest.json"))) ||
    (await pathExists(path.join(source, "segments")));
  // 复制事务化：先复制到 targetAgentRoot 下同父级的 staging 目录，再逐项原子 rename
  // 进目标；失败时回滚已移入目标的内容并删除 staging，保证目标回到空状态——下次
  // open 仍可重试，journal.load() 永远读不到半份复制（ENOSPC/EACCES/Windows 杀软锁
  // 等中途失败不再留下孤儿数据）。
  const staging = path.join(targetAgentRoot, `.staging-${process.pid}-${Date.now()}`);
  const moved = [];
  try {
    if (!isNewFormat) {
      await validateLegacyEvents(path.join(source, "events.jsonl"));
    }
    await fs.mkdir(staging, { recursive: true });
    if (isNewFormat) {
      // 新格式：segments/ + journal-manifest.json + session.json + active-context.json + checkpoints/
      for (const name of NEW_FORMAT_FILES) await copyIfPresent(path.join(source, name), path.join(staging, name));
      await copyDirectoryIfPresent(path.join(source, "segments"), path.join(staging, "segments"));
      await copyDirectoryIfPresent(path.join(source, "checkpoints"), path.join(staging, "checkpoints"));
    } else {
      for (const name of LEGACY_COPY_FILES) await copyIfPresent(path.join(source, name), path.join(staging, name));
      await copyDirectoryIfPresent(path.join(source, "checkpoints"), path.join(staging, "checkpoints"));
    }
    // 逐项原子 rename：staging 中缺席的项 = 源中本就不存在，跳过（防御 ENOENT）。
    for (const name of await fs.readdir(staging)) {
      try {
        await fs.rename(path.join(staging, name), path.join(targetAgentRoot, name));
        moved.push(name);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await fs.rm(staging, { recursive: true, force: true });
    return { imported: true };
  } catch (error) {
    // 回滚：删除已移入目标的内容（尽力而为）与残留 staging，目标回到空状态
    for (const name of moved) {
      await fs.rm(path.join(targetAgentRoot, name), { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    diagnostic("[workspace-migration] legacy agent import failed", error);
    return { imported: false, reason: "invalid_source" };
  }
}

// ---------------------------------------------------------------------------
// 旧 project.yaml 元数据的一次性只读迁移（计划 Task 11）
// ---------------------------------------------------------------------------
//
// 契约（SPEC §9.1 / brief Step 1-4；冻结合并契约见 config-runtime §2.3）：
//   - 首次打开旧项目时，把标题/题材/章节字数目标/输出格式整理进 WWRITING.md，
//     把模型选择与 4-bool 权限默认值写入应用私有 settings.json；
//   - 原 project.yaml 不删除、不覆盖、不改写（字节不变，保留回滚依据）；
//   - 新工作区（无 project.yaml）不创建 project.yaml，迁移返回 missing；
//   - blueprint_status、临时授权、运行阶段、失败状态、派生索引不写入长期记忆；
//     字数字段只写成“参考/目标”散文，绝不变成门禁；
//   - 迁移标记 legacy_project_imported **最后**写入：读取旧配置 → 写/合并
//     WWRITING.md → 写私有 settings → 验证可重读 → 标记 true。任一步失败保持
//     false，下次打开重试；聊天资格从不依赖迁移成功（migrateLegacyProject
//     绝不向调用方抛错）。

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
// 字段发明模型配置（provider 缺失时分发回退 mock，与旧行为一致）。
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
