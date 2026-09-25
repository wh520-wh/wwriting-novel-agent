// src/core/agent/tools/runtime-helpers.mjs —— ToolRuntime 无闭包依赖的模块级纯函数
//（第十五轮 Task 6 追加项：index.mjs 行数红线收编）。
//
// 只承载「参数/模块级 import/模块级常量」的函数——不引用 createToolRuntime 工厂
// 闭包变量（redactor/TOOLS/decisions/toolIdleTimeoutMs 等）。index.mjs 与
// journal.mjs（truncateOutput/MAX_TOOL_OUTPUT_CHARS）经 import 使用；
// definitions-*.mjs 仍经工厂 h 依赖包取用（h 键不变，注册体零改动）。
//
// 职责分区：统一输出截断（R5-15）与工具错误/脱敏、失败结果形状（Task 3）、
// 权限策略（Step 6）、受保护路径（Step 7，含 win32 大小写不敏感）、参数校验、
// count_text 执行体（Task 9 Step 4）。函数体与注释自 index.mjs 机械平移。
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside, resolveFilesystemPath } from "../../fs-utils.mjs";
import { analyzeTextCount } from "../../word-count.mjs";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const MAX_TOOL_OUTPUT_CHARS = 1024 * 1024; // 单次工具 tool_output_delta 累计上限

// ---------------------------------------------------------------------------
// 统一输出截断（R5-15）：tool_output_delta 与终态工具结果共用同一口径。
// 预算内原样返回；超出取预算内前缀并标记截断。delta 侧取 slice 落事件，
// 终态侧用 truncated 标记（结果本身保留完整捕获文本）。
// ---------------------------------------------------------------------------

export function truncateOutput(text, budget, emitted = 0) {
  const remaining = Math.max(0, budget - emitted);
  const slice = text.length > remaining ? text.slice(0, remaining) : text;
  return {
    slice,
    content_length: slice.length,
    truncated: text.length > remaining
  };
}
// 工具结果进入下一轮模型请求的上下文安全上限（字符）。按最小窗口 256k token 的
// 最坏口径（CJK 约 1 字符 = 1 token）取 100k：单次工具结果 + 32k 输出安全余量 +
// 常规会话历史仍低于 204_800 压缩阈值，一次工具调用不可能独自撞爆硬窗口。
// ponytail: 定值不随 provider 窗口推导；若未来接入 <256k 窗口的 provider，应改在
// 历史装配层（transcriptToMessages）按窗口统一截断工具结果。
export const MAX_TOOL_RESULT_CHARS = 100_000;

const AGENT_DIR_REL = path.join(".wwriting", "agent");
const CHECKPOINTS_DIR_REL = path.join("checkpoints");
const DRAFTS_DIR_REL = path.join("drafts");
const CHAPTER_INDEX_REL = path.join("memory", "chapter_index.json");
const VERSIONS_DIR_REL = path.join(".versions"); // 版本快照库（commit/finalize/rollback 维护）

// safe_edit=false 拒绝的「正文/设定」内容路径（沿用前置计划 SAFE_EDIT_TOOLS 语义：
// 正文、设定、连续性记忆；shell 未知写目标不在此列）
const SAFE_EDIT_CONTENT_REL = [path.join("chapters"), path.join("drafts"), "OUTLINE.md", "SETTING.md", path.join("memory")];

// 受保护路径规则（Step 7）：通用 edit 与 shell 拒绝直接写
const PROTECTED_RULES = Object.freeze({
  agent_journal: "agent_journal", // <projectRoot>/.wwriting/agent/ 全部（segments/、journal-manifest.json、session.json、migration.json、checkpoints/）
  project_checkpoints: "project_checkpoints", // <projectRoot>/checkpoints/
  chapter_index: "chapter_index", // memory/chapter_index.json
  draft_files: "draft_files", // 草稿目录 drafts/（正文只能经 append_chapter_segment 写入）
  version_files: "version_files", // .versions/ 版本快照库（commit/finalize/rollback 维护）
  memory_files: "memory_files", // memory/ 记忆档案（章节记忆/索引/摘要/连续性，系统维护）
  project_config: "project_config", // project.yaml 项目配置（设置面板维护）
  run_log: "run_log" // run_log.jsonl 审计账本（章节提交/入账/回滚维护，只读）
});
// 受保护路径拒绝的合法通道指引（第八轮模块 C）：message 一句话、rule 进 technical
export const PROTECTED_DENIAL_MESSAGES = Object.freeze({
  agent_journal: "Agent 日志为系统文件，只读。",
  project_checkpoints: "checkpoint 为系统文件，只读。",
  chapter_index: "章节索引为系统文件，只读。",
  draft_files: "草稿只能经 append_chapter_segment 写入。",
  version_files: "版本档案为系统文件，只读。",
  memory_files: "记忆档案为系统文件，只读；设定档案请用 update_memory 工具更新。",
  project_config: "项目配置文件为系统文件，只读。",
  run_log: "审计账本为系统文件，只读。"
});
// 大小写不敏感路径相等（win32 文件系统大小写不敏感；POSIX 保持敏感）
function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// ---------------------------------------------------------------------------
// 工具错误：message 是给用户/模型看的简短文案，technical 只放字段名与规则 id
// ---------------------------------------------------------------------------

export function toolError(code, message, technical = null) {
  const error = new Error(message);
  error.code = code;
  if (technical !== null) error.technical = technical;
  return error;
}

// Node 文件/系统错误判定（计划 Task 4 Step 6）：带 syscall 的 fs 错误与
// E*/ERR_*/UV_* 系统码都属于 Node 原始错误，message 不得进入用户正文。
function isNodeSystemError(error) {
  if (!error) return false;
  if (typeof error.syscall === "string" && error.syscall.length > 0) return true;
  return /^(?:E[A-Z0-9]+|ERR_[A-Z0-9_]+|UV_[A-Z0-9_]+)$/u.test(String(error.code ?? ""));
}

// Node 文件错误 → 简短工具错误：固定中文 message + 原始错误进 technical（供
// 诊断日志；technical 不得渲染成用户正文）。
export function sanitizeToolFailure(error) {
  if (isNodeSystemError(error)) {
    return {
      message: "无法读取工作区文件，请检查文件夹是否仍可访问后重试。",
      technical: {
        ...(error?.technical && typeof error.technical === "object" ? error.technical : null),
        node_error: { code: error.code ?? null, message: error.message ?? String(error) }
      }
    };
  }
  return { message: error?.message ?? "工具执行失败。", technical: error?.technical ?? null };
}

// 统一失败结果形状（Task 3）：业务异常为 {ok:false, error:{code,message,retryable?}}，
// 顶层保留 tool_call_id/name/message/duration_ms 等既有字段（向后兼容）。
// 注意：journal 事件侧（appendFailed 的 payload.error）保持字符串 code，
// 与事件契约一致；结构化 error 对象只出现在 execute 的返回值/transcript。
export function toolFailureResult({ tool_call_id, name, code, message, retryable = null, kind = null, duration_ms = null, stdout = null, stderr = null }) {
  const error = { code, message };
  if (kind !== null) error.kind = kind;
  if (retryable !== null) error.retryable = retryable;
  const result = { ok: false, tool_call_id, name, error, message };
  if (duration_ms !== null) result.duration_ms = duration_ms;
  if (stdout !== null) result.stdout = stdout;
  if (stderr !== null) result.stderr = stderr;
  return result;
}

// ---------------------------------------------------------------------------
// 脱敏辅助
// ---------------------------------------------------------------------------

export function redactJsonValue(redactor, value) {
  try {
    return JSON.parse(redactor.redact(JSON.stringify(value ?? null)));
  } catch {
    return null;
  }
}

export function auditToolResult(name, result) {
  const audit = structuredClone(result ?? {});
  if (name === "read_file") {
    const content = String(audit.content ?? "");
    delete audit.content;
    audit.content_length = content.length;
  }
  if (name === "read_skill" && typeof audit.content === "string") {
    // read_skill 正文不进审计事件（与 read_file 同口径：只留长度）；
    // 二进制 asset 结果没有 content，原样保留元数据 + 绝对路径。
    const content = audit.content;
    delete audit.content;
    audit.content_length = content.length;
  }
  if (name === "search_files" && Array.isArray(audit.matches)) {
    audit.matches = audit.matches.map(({ excerpt: _excerpt, ...match }) => match);
  }
  return audit;
}

// ---------------------------------------------------------------------------
// 权限策略（Step 6：把旧 checkToolPermission 与 decideToolAuthorization 两层
// 折叠成一个策略，优先级不可能打架）
// ---------------------------------------------------------------------------

function permissionStateOf(context) {
  const project = context?.project ?? {};
  return {
    tool_permissions: project.tool_permissions ?? {},
    archived: Boolean(project.archived_at)
  };
}

// 返回 { decision: "allow"|"deny"|"extreme_confirm"|"confirm", message?, technical? }。
// 顺序固定：硬能力拒绝（dangerous 封印 → 归档 → read_only → safe_edit=false）
// 之后是 extreme → YOLO → 项目内 read 自动 → auto_edit 项目内写；「grant 匹配」
// 由 execute 在 policy 返回 confirm 后补查（input 级授权在确认层，不参与策略自身）。
export function defaultPermissionPolicy(action, context) {
  const { tool_permissions, archived } = permissionStateOf(context);
  const isRead = action.category === "read";
  if (tool_permissions.dangerous === true && !isRead) {
    // 封印字段：运行时再校一次，挡住直接改 YAML / 未来旁路；extreme 确认不能覆盖能力禁用
    return {
      decision: "deny",
      message: "当前权限不允许修改文件。",
      technical: { rule: "dangerous_sealed", field: "tool_permissions.dangerous" }
    };
  }
  if (archived && !isRead) {
    return {
      decision: "deny",
      message: "项目已归档，无法修改。",
      technical: { rule: "archived", field: "archived_at" }
    };
  }
  if (tool_permissions.read_only === true && !isRead) {
    return {
      decision: "deny",
      message: "当前为只读模式。",
      technical: { rule: "read_only", field: "tool_permissions.read_only" }
    };
  }
  if (tool_permissions.safe_edit === false && action.safe_edit_target === true) {
    return {
      decision: "deny",
      message: "当前权限不允许修改文件。",
      technical: { rule: "safe_edit_disabled", field: "tool_permissions.safe_edit" }
    };
  }
  if (action.auto_allow === true) return { decision: "allow" }; // 深工具（原子写路径）在硬拒绝后放行
  if (action.risk === "extreme") return { decision: "extreme_confirm" };
  if (tool_permissions.yolo === true) return { decision: "allow" }; // YOLO 允许剩余普通动作（含项目外），不绕过 extreme
  if (action.category === "read" && action.scope === "project") return { decision: "allow" };
  if (tool_permissions.auto_edit === true && action.category === "write" && action.scope === "project") {
    return { decision: "allow" };
  }
  return { decision: "confirm" };
}

// ---------------------------------------------------------------------------
// 受保护路径（Step 7）
// ---------------------------------------------------------------------------

function isProtectedWritePath(projectRoot, targetPath) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(targetPath);
  // 路径包含性比较经 fs-utils.isPathInside（win32 大小写不敏感）判定，大小写变体
  //（.wwriting/AGENT/…、Chapters/001.md、memory/Chapter_Index.json）不能绕过。
  if (isPathInside(path.join(root, AGENT_DIR_REL), target)) {
    return { rule: PROTECTED_RULES.agent_journal, path: target };
  }
  if (isPathInside(path.join(root, CHECKPOINTS_DIR_REL), target)) {
    return { rule: PROTECTED_RULES.project_checkpoints, path: target };
  }
  if (samePath(target, path.join(root, CHAPTER_INDEX_REL))) {
    return { rule: PROTECTED_RULES.chapter_index, path: target };
  }
  // 草稿目录 drafts/：正文草稿只能经 append_chapter_segment（project operations 原子写）
  // 按 segment 顺序与安全点写入；write_file/edit_file 直写会绕过段落顺序与草稿校验。
  if (isPathInside(path.join(root, DRAFTS_DIR_REL), target)) {
    return { rule: PROTECTED_RULES.draft_files, path: target };
  }
  // 版本快照库 .versions/：系统归档，只读（由版本工具维护）
  if (isPathInside(path.join(root, VERSIONS_DIR_REL), target)) {
    return { rule: PROTECTED_RULES.version_files, path: target };
  }
  // memory/ 记忆档案与 project.yaml：设计 D5 矩阵声明只读，工具层强制执行
  if (isPathInside(path.join(root, "memory"), target)) {
    return { rule: PROTECTED_RULES.memory_files, path: target };
  }
  if (samePath(target, path.join(root, "project.yaml"))) {
    return { rule: PROTECTED_RULES.project_config, path: target };
  }
  // run_log.jsonl（项目根）审计账本：只由 chapter 提交/入账/回滚事务追加，
  // write_file/edit_file 直写会篡改历史账本。精确路径比较，不误伤子目录同名文件。
  if (samePath(target, path.join(root, "run_log.jsonl"))) {
    return { rule: PROTECTED_RULES.run_log, path: target };
  }
  return null;
}

// shell 的静态受保护信号只有 cwd：不得在 journal / checkpoints 目录内运行命令。
// 有意不把 drafts/ 纳入 cwd 保护：cwd 是粗粒度信号，`cd drafts && ls` / `cat drafts/…`
// 属于合法读取，阻止 cwd 会误伤；shell 对草稿的写入仍受权限层（write/delete 类别确认、
// extreme 判定）约束，而 write_file/edit_file 走上面的精确路径检查。
export function isProtectedShellCwd(projectRoot, cwd) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(cwd);
  if (isPathInside(path.join(root, AGENT_DIR_REL), target)) {
    return { rule: PROTECTED_RULES.agent_journal, path: target };
  }
  if (isPathInside(path.join(root, CHECKPOINTS_DIR_REL), target)) {
    return { rule: PROTECTED_RULES.project_checkpoints, path: target };
  }
  return null;
}

// 以根为基准的比较点统一取值口径（第二十一轮 Task 1）：只认工具上下文里的
// `resolved_project_root`（execute 侧解析一次后写入的调用私有副本）。键缺失即抛错，
// 不退回未解析的根——把「忘了填」变成显式失败，而不是静默按旧基准放行（fail-closed）。
export function projectRootForChecks(context) {
  const resolved = context.resolved_project_root;
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw toolError("path_resolution_failed", "无法确认项目位置，已拒绝本次操作。", { rule: "project_root_unresolved" });
  }
  return resolved;
}

// 文件类写工具共用的受保护路径预检（write_file / edit_file）
export function fileProtectedCheck(args, context) {
  const root = projectRootForChecks(context);
  return isProtectedWritePath(root, path.resolve(root, args.path));
}

export function isSafeEditContentPath(projectRoot, targetPath) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(targetPath);
  return SAFE_EDIT_CONTENT_REL.some((rel) => isPathInside(path.resolve(root, rel), target));
}

// ---------------------------------------------------------------------------
// 参数校验（错误只报简短文案 + technical 字段名）
// ---------------------------------------------------------------------------

export function requireStringArg(args, name, label = name) {
  if (typeof args[name] !== "string") {
    throw toolError("bad_args", `参数无效：${label} 必须是字符串。`, { rule: "bad_args", fields: [name] });
  }
  // 类型与空值分开报错：字符串却为空（含纯空白）不是「必须是字符串」。
  if (args[name].trim() === "") {
    throw toolError("bad_args", `参数无效：${label} 不能为空。`, { rule: "bad_args", fields: [name] });
  }
  return args[name];
}

// 可空字符串参数（R5-10）：缺省视为 ""；显式传入非字符串同样报 bad_args
//（edit_file 的 replace 可为空串，但对象/数组不得静默 toString）。
export function optionalStringArg(args, name, label = name) {
  if (args[name] === undefined || args[name] === null) return "";
  if (typeof args[name] !== "string") {
    throw toolError("bad_args", `参数无效：${label} 必须是字符串。`, { rule: "bad_args", fields: [name] });
  }
  return args[name];
}

export function requirePositiveIntArg(args, name, label = name) {
  if (!Number.isInteger(Number(args[name])) || Number(args[name]) <= 0) {
    throw toolError("bad_args", `参数无效：${label} 必须是正整数。`, { rule: "bad_args", fields: [name] });
  }
  return Number(args[name]);
}

export function parseToolArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      return parsed;
    } catch {
      throw toolError("bad_args", "工具参数不是合法 JSON 对象。", { rule: "bad_args", fields: ["arguments"] });
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  throw toolError("bad_args", "工具参数不是合法对象。", { rule: "bad_args", fields: ["arguments"] });
}

// ---------------------------------------------------------------------------
// 工作区 .md/.txt 只读读取（count_text 与 style_stats 共用，round17 第二部分 T3）。
// 路径安全与 read_file 同模式：resolveFilesystemPath 解析真实路径后 isPathInside
// 做包含性检查；ENOENT 折叠为 source=null，由调用方决定返回形态。本函数不做统计。
// ---------------------------------------------------------------------------

export async function readWorkspaceTextFile(args, context) {
  const relative = requireStringArg(args, "path", "path");
  const target = await resolveFilesystemPath(path.resolve(context.projectRoot, relative));
  if (!isPathInside(context.projectRoot, target)) {
    throw toolError("path_outside_workspace", "只能读取当前工作区内的文件。", { path: relative });
  }
  if (![".md", ".txt"].includes(path.extname(target).toLowerCase())) {
    throw toolError("unsupported_text_file", "只支持 Markdown 或纯文本文件。", { path: relative });
  }
  const source = await fs.readFile(target, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  return { relative, source };
}

// ---------------------------------------------------------------------------
// count_text 执行体（Task 9 Step 4）。只读客观统计：工作区内 .md/.txt，
// minimum/target 只计算差额，不判定通过或失败（冻结契约 §2.2）。
// 路径安全与 ENOENT 折叠委托给上方 readWorkspaceTextFile
//（count_text 与 style_stats 共用，round17 第二部分 T3）。
// ---------------------------------------------------------------------------

export async function executeCountText(args, context) {
  const { relative, source } = await readWorkspaceTextFile(args, context);
  if (source === null) return { path: relative, exists: false };
  const counts = analyzeTextCount(source);
  const minimum = Number.isInteger(args.minimum) ? args.minimum : null;
  const targetCount = Number.isInteger(args.target) ? args.target : null;
  return {
    path: relative,
    exists: true,
    ...counts,
    minimum,
    target: targetCount,
    minimum_gap: minimum === null ? null : counts.effective_count - minimum,
    target_gap: targetCount === null ? null : counts.effective_count - targetCount
  };
}
