// src/core/project-operations/blueprint.mjs —— 蓝图项目事务（统一 Agent 内核计划 Task 5）。
//
// 职责（Rule 6 深模块）：OUTLINE.md、SETTING.md 与 project.yaml 的 blueprint_status
// 一致提交。Agent runtime 只编排（init workflow 的模型生成职责属于 ProjectAgent，
// 本模块只做三文件确定性提交）。
//
// 边界：
//   - 不接收 ModelGateway、不调用模型。
//   - 不读写旧 agent_state 状态文件；blueprint_status 的真相源是 project.yaml
//     （计划 Task 9 才改 project-store；本任务通过 stable 的 simple-yaml 读取 +
//     手术式行编辑写入，不 import project-store 的 loadState/saveState）。
//   - commitBlueprint 是"一个可恢复事务"：OUTLINE、SETTING、project.yaml 与
//     run_log 追加全部在事务边界内；任一次写入失败必须恢复四者先前状态
//     （文件还原/删除、run_log 截断/删除）。失败时可能附加 error.rollbackWarnings。
//   - 蓝图状态只写"complete"：不写 none/partial/legacy（旧状态迁移归
//     legacy-import（Task 7），此处只接受模型生成的正式蓝图提交）。
//   - yaml 保真度边界：不整文件 parse/serialize 往返（会丢注释、非 JSON 内联值
//     类型漂移）；commitBlueprint 只手术式替换 blueprint_status 行的值（或缺失时
//     追加一行），其余字节原样保留。
//   - 错误契约：领域错误（参数、project_id、evidence 越根、先前文件读取失败）
//     统一抛 BlueprintOperationError；写入期系统 I/O 错误原样抛出（保证已回滚）。
//   - 测试 seam：commitBlueprint 接受可选第二参数 options = { hooks: { beforeWrite } }，
//     与 chapter.mjs 同一语义（每次事务正向写入前调用；抛错即模拟写入失败并回滚；
//     回滚写入不经过探针）。生产调用（Task 6）不传 options。
//   - 移植来源（只读参考）：tools-write.mjs 的蓝图写入不变量；blueprint-init.mjs
//     已由前置计划删除（already_removed），三文件提交职责按本计划落在本模块。

import fs from "node:fs/promises";
import path from "node:path";

import { appendEvent } from "../event-log.mjs";
import { isPathInside, pathExists, safeJoin, writeFileAtomic } from "../fs-utils.mjs";
import { parseSimpleYaml } from "../simple-yaml.mjs";

export class BlueprintOperationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "BlueprintOperationError";
    this.code = code;
    this.details = details;
  }
}

// createProject 默认写入的占位蓝图（等价于无蓝图；与旧实现同一正则）。
// 由 review.mjs 复用（同属 project-operations 层）。
export const BLUEPRINT_PLACEHOLDER = /^# (OUTLINE|SETTING)\.md\s*\n>\s*蓝图未生成，请运行 \/init\s*$/;

// 章节正式文件命名约定（与 tool-runtime / 受保护路径规则一致）。
const CHAPTER_FILE_RE = /^\d{3,}\.[A-Za-z0-9]{1,8}$/u;

function assertProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new BlueprintOperationError("invalid_project_root", "projectRoot 必须是非空路径。");
  }
}

async function readProjectYaml(projectRoot) {
  const yamlPath = safeJoin(projectRoot, "project.yaml");
  let source;
  try {
    source = await fs.readFile(yamlPath, "utf8");
  } catch (error) {
    throw new BlueprintOperationError("project_not_found", `无法读取 project.yaml：${error.message}`);
  }
  return { yamlPath, source, parsed: parseSimpleYaml(source) };
}

// 测试写探针：与 chapter.mjs 同一语义（见模块头注释）。
function createWriteProbe(options) {
  const hook = options?.hooks?.beforeWrite ?? null;
  if (typeof hook !== "function") {
    return async () => {};
  }
  let attempt = 0;
  return async ({ path: targetPath, kind }) => {
    attempt += 1;
    await hook({ path: targetPath, kind, attempt });
  };
}

// 手术式行编辑：只替换 blueprint_status 行的值（缺失时追加一行），其余字节
// （含注释、缩进、空行）原样保留。注意：
//   - split(/\r?\n/) 保留尾部空元素（其本身携带换行），join 后不再补 \n；
//     仅当源文件不以换行结尾时才补一个，保证产物以 \n 结束（parse 友好）。
//   - blueprint_status 行是本模块拥有的行：行内尾随注释随值替换一起被丢弃
//     （该注释描述的是被替换的旧值，保留会误导），其余行的注释/内容不受影响。
function setBlueprintStatusComplete(yamlSource) {
  const source = String(yamlSource ?? "");
  const endsWithNewline = source.endsWith("\n");
  const lines = source.split(/\r?\n/u);
  let found = false;
  const next = lines.map((line) => {
    const match = /^(\s*)blueprint_status:(\s*).*$/u.exec(line);
    if (match) {
      found = true;
      return `${match[1]}blueprint_status:${match[2]}"complete"`;
    }
    return line;
  });
  if (!found) {
    next.push('blueprint_status: "complete"');
  }
  const joined = next.join("\n");
  return endsWithNewline ? joined : `${joined}\n`;
}

// ---------------------------------------------------------------------------
// inspectBlueprintContext —— 读 project.yaml.blueprint_status + 实际
// OUTLINE/SETTING/章节证据（只读，不写任何文件）
// ---------------------------------------------------------------------------

export async function inspectBlueprintContext({ projectRoot }) {
  assertProjectRoot(projectRoot);
  const { parsed } = await readProjectYaml(projectRoot);
  const outline = await inspectBlueprintFile(projectRoot, "OUTLINE.md");
  const setting = await inspectBlueprintFile(projectRoot, "SETTING.md");
  const chapterEvidence = await collectChapterEvidence(projectRoot);

  return {
    blueprint_status: parsed.blueprint_status ?? "none",
    outline,
    setting,
    chapter_evidence: chapterEvidence,
    has_blueprint:
      outline.exists && outline.placeholder === false &&
      setting.exists && setting.placeholder === false
  };
}

async function inspectBlueprintFile(projectRoot, fileName) {
  const filePath = safeJoin(projectRoot, fileName);
  if (!(await pathExists(filePath))) {
    return { file: fileName, exists: false, placeholder: false, bytes: 0 };
  }
  const content = await fs.readFile(filePath, "utf8");
  return {
    file: fileName,
    exists: true,
    placeholder: BLUEPRINT_PLACEHOLDER.test(content.trim()),
    bytes: Buffer.byteLength(content, "utf8")
  };
}

async function collectChapterEvidence(projectRoot) {
  const chaptersDir = safeJoin(projectRoot, "chapters");
  let chapterFiles = [];
  try {
    const entries = await fs.readdir(chaptersDir);
    chapterFiles = entries.filter((name) => CHAPTER_FILE_RE.test(name)).sort();
  } catch {
    // 目录不存在或不可读：无章节证据
  }
  const index = await readJsonSafe(safeJoin(projectRoot, "memory", "chapter_index.json"), { chapters: [] });
  const chapters = Array.isArray(index.chapters) ? index.chapters : [];
  const memory = await readJsonSafe(safeJoin(projectRoot, "memory", "chapter_memory.json"), { chapters: [] });
  return {
    chapter_files: chapterFiles,
    completed_chapters: chapters.filter((c) => c.status === "completed").length,
    indexed_chapters: chapters.length,
    memorized_chapters: Array.isArray(memory.chapters) ? memory.chapters.length : 0
  };
}

async function readJsonSafe(filePath, fallback) {
  try {
    const source = await fs.readFile(filePath, "utf8");
    return JSON.parse(source);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// commitBlueprint —— OUTLINE、SETTING、project.yaml(blueprint_status=complete)
// 与 run_log 作为一个可恢复事务提交。任何一次写入失败恢复全部先前状态。
// ---------------------------------------------------------------------------

export async function commitBlueprint({ projectRoot, projectId, outline, setting, evidencePaths = [] }, options = {}) {
  assertProjectRoot(projectRoot);
  if (typeof outline !== "string" || outline.trim().length === 0) {
    throw new BlueprintOperationError("empty_outline", "outline 必须是非空字符串。");
  }
  if (typeof setting !== "string" || setting.trim().length === 0) {
    throw new BlueprintOperationError("empty_setting", "setting 必须是非空字符串。");
  }
  const evidence = Array.isArray(evidencePaths) ? evidencePaths.map(String) : [];
  const root = path.resolve(projectRoot);
  for (const evidencePath of evidence) {
    const target = path.resolve(root, evidencePath);
    if (!isPathInside(root, target)) {
      throw new BlueprintOperationError(
        "evidence_path_escapes_project",
        `证据路径越出项目根目录：${evidencePath}`
      );
    }
  }

  const { yamlPath, source: priorYaml, parsed } = await readProjectYaml(projectRoot);
  if (projectId !== undefined && projectId !== null && projectId !== "" && parsed.project_id != null && parsed.project_id !== projectId) {
    throw new BlueprintOperationError("invalid_project_id", "project_id 与当前项目不匹配。");
  }

  const outlinePath = safeJoin(projectRoot, "OUTLINE.md");
  const settingPath = safeJoin(projectRoot, "SETTING.md");
  // 只替换 blueprint_status 行，其余字节原样保留（见模块头 yaml 保真度边界）
  const nextYaml = setBlueprintStatusComplete(priorYaml);
  const outlineText = `${String(outline).trim()}\n`;
  const settingText = `${String(setting).trim()}\n`;

  // ---- 事务：记录四者先前状态，任一写入失败恢复 ----
  const probe = createWriteProbe(options);
  const prior = [];
  for (const filePath of [outlinePath, settingPath, yamlPath]) {
    const existed = await pathExists(filePath);
    let bytes = null;
    if (existed) {
      try {
        bytes = await fs.readFile(filePath, "utf8");
      } catch (error) {
        throw new BlueprintOperationError("blueprint_read_failed", `无法读取 ${filePath}：${error.message}`, {
          path: filePath
        });
      }
    }
    prior.push({ path: filePath, bytes });
  }
  const runLogPath = safeJoin(projectRoot, "run_log.jsonl");
  const runLogExisted = await pathExists(runLogPath);
  const runLogSize = runLogExisted ? (await fs.stat(runLogPath)).size : 0;

  try {
    await probe({ path: outlinePath, kind: "outline" });
    await writeFileAtomic(outlinePath, outlineText);
    await probe({ path: settingPath, kind: "setting" });
    await writeFileAtomic(settingPath, settingText);
    await probe({ path: yamlPath, kind: "project_yaml" });
    await writeFileAtomic(yamlPath, nextYaml);
    // run_log 领域事实在事务内：失败时连同三文件一起回滚
    await probe({ path: runLogPath, kind: "run_log" });
    await appendEvent(projectRoot, {
      type: "blueprint_committed",
      project_id: parsed.project_id ?? null,
      stage: "init",
      message: "蓝图已提交",
      data: { outline_path: outlinePath, setting_path: settingPath, evidence_paths: evidence }
    });
  } catch (error) {
    const rollbackWarnings = [];
    for (const entry of prior) {
      try {
        if (entry.bytes === null) {
          await fs.unlink(entry.path);
        } else {
          await writeFileAtomic(entry.path, entry.bytes);
        }
      } catch (rollbackError) {
        // 未创建文件的 unlink ENOENT 不算回滚失败（与 run_log 回滚一致）
        if (!(rollbackError.code === "ENOENT" && entry.bytes === null)) {
          rollbackWarnings.push(`恢复 ${entry.path} 失败：${rollbackError.message}`);
        }
      }
    }
    try {
      if (runLogExisted) {
        await fs.truncate(runLogPath, runLogSize);
      } else {
        await fs.unlink(runLogPath);
      }
    } catch (rollbackError) {
      if (rollbackError.code !== "ENOENT") {
        rollbackWarnings.push(`run_log 回滚失败：${rollbackError.message}`);
      }
    }
    if (rollbackWarnings.length > 0) {
      error.rollbackWarnings = rollbackWarnings;
    }
    throw error;
  }

  return {
    ok: true,
    blueprint_status: "complete",
    outline_path: outlinePath,
    setting_path: settingPath,
    evidence_paths: evidence
  };
}
