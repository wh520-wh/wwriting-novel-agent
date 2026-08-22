// src/core/agent/tools/index.mjs —— 统一 ToolRuntime（统一 Agent 内核计划 Task 4；
// 第十五轮 Task 5：四域注册拆分，14 个工具注册体按域搬入 tools/definitions-*.mjs）。
//
// 对 Agent 提供唯一工具入口：
//
//   const tools = createToolRuntime({ projectOperations, journal, permissionPolicy, shellRuntime, secrets });
//   tools.definitions(context);            // -> OpenAI 原生 function definitions（14 个工具：8 通用 + 6 深）
//   await tools.execute(toolCall, context); // 单次工具调用的 schema→权限→审计→执行→事件闭环
//
// 内部实现隐藏：schema 注册、权限判定（含硬能力拒绝与输入级临时授权）、journal 审计事件、
// 可中断/原子工具分类、脱敏与受保护路径。
//
// 设计不变量（来自计划 Task 4 Step 3–8）：
//   - 恰好注册八个 general 工具（list_files/search_files/read_file/write_file/edit_file/shell/
//     read_skill/count_text）与六个 deep 工具（update_plan/append_chapter_segment/
//     commit_chapter/finalize_revision/rollback_chapter/update_memory）；不注册旧编排工具（start_ 前缀启停、queue_ 前缀排队、
//     resolve_failure、export_book 等）或逐文件便利工具。read_skill（Task 12）是只读
//     工具：只能按 active catalog name 解析，realpath containment/1MiB 上限/二进制
//     asset 由 skills service（src/core/skills/index.mjs）执行。count_text（Task 9）是
//     只读客观字数工具：工作区内 .md/.txt，minimum/target 只计算差额不判定通过或失败。
//     Task 7：工作流切换工具已删除；Task 8：旧 blueprint 事务工具注册连同
//     blueprint.mjs 一并删除。
//   - 每个工具 schema 必须产生系统构建的归一化 ToolAction 后才进入权限评估；模型只能提供
//     purpose，不能提供或覆盖 risk/scope/extreme/grant_key/confirmation 类型（schema 不暴露
//     这些字段，additionalProperties: false）。
//   - 硬能力拒绝（tool_permissions.dangerous 被封印、归档态、项目 read_only、safe_edit=false）
//     是能力级禁用，extreme 确认也不能覆盖；其后按 extreme → YOLO → 项目内 read 自动 →
//     auto_edit 项目内写 → 匹配的 input grant → 普通确认 的顺序判定。
//   - grant 绑定 active_input_id + grant_key + target class；input 完成/取消/被「立即」切换
//     时由运行时调用 clearGrants 清除并追加 permission_grant_cleared。
//   - extreme 每次具体动作生成全新 confirmation_text，只有用户输入精确匹配才能执行；
//     模型文本、历史 decision、同类 grant 都不能满足。
//   - 每个待决 decision 有唯一 decision_id/activity_id 与归一化动作指纹；被 superseded/
//     resolved/rejected/cancelled 的 decision 是终态，旧 HTTP 响应不能解锁或执行。
//   - 停止通过 context.signal 中止可中断的 Shell 工作、作废待决 decision（decision_resolved
//     choice=cancelled，保证活动闭环）、绝不在事件里泄漏未脱敏输出。
//   - 统一工具期限（Task 2）：默认空闲 5 分钟 / 绝对 60 分钟；工具定义可声明更短
//     期限但不得抬高系统上限；超时返回结构化 tool_timeout 结果（不向 Runtime 抛
//     异常）；shell 输出与受控进程事件刷新空闲期限；原子写进入最终 rename 后完整收尾。
//   - 通用写工具（write_file/edit_file）与 shell 必须拒绝直接写受保护路径（Agent journal、
//     session projection、transcript、项目 checkpoints、章节索引、草稿目录 drafts/）；
//     正式章节文件可直接编辑（模块 C），草稿/索引/checkpoint/日志仍受保护；
//     win32 下路径比较大小写不敏感，大小写变体不能绕过。
//   - 权限错误使用简短文案：当前为只读模式。/当前权限不允许修改文件。/项目已归档，无法修改。/
//     工具不可用。；受保护路径拒绝额外带合法通道指引（一句话，七个规则都有映射）；
//     字段名与规则 id 只放 technical 细节。
//   - journal 事件：tool_call_started / tool_output_delta（脱敏后，按单次工具累计 1 MiB 截断）/
//     tool_call_completed / tool_call_failed / decision_requested / decision_resolved /
//     permission_grant_created / permission_grant_cleared / run_status_changed（确认等待期间）。
//
// deep 工具执行体：projectOperations（Task 5 创建）是注入依赖；本任务中未接线时抛
// 「工具不可用。」（technical.not_wired），schema/权限/审计/安全点逻辑必须完整。
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside, resolveFilesystemPath } from "../../fs-utils.mjs";
import { resolveProjectScope } from "../../shell/risk.mjs";
import { createRedactor, createStreamingRedactor } from "../../shell/redaction.mjs";
import { skillService } from "../../skills/index.mjs";
import { analyzeTextCount } from "../../word-count.mjs";
import { PLAN_STATUSES } from "../journal.mjs";
import { fsToolDefinitions } from "./definitions-fs.mjs";
import { shellToolDefinitions } from "./definitions-shell.mjs";
import { chapterToolDefinitions } from "./definitions-chapter.mjs";
import { knowledgeToolDefinitions } from "./definitions-knowledge.mjs";

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
const MAX_TOOL_RESULT_CHARS = 100_000;

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
  project_config: "project_config" // project.yaml 项目配置（设置面板维护）
});
// 受保护路径拒绝的合法通道指引（第八轮模块 C）：message 一句话、rule 进 technical
const PROTECTED_DENIAL_MESSAGES = Object.freeze({
  agent_journal: "Agent 日志为系统文件，只读。",
  project_checkpoints: "checkpoint 为系统文件，只读。",
  chapter_index: "章节索引为系统文件，只读。",
  draft_files: "草稿只能经 append_chapter_segment 写入。",
  version_files: "版本档案为系统文件，只读。",
  memory_files: "记忆档案为系统文件，只读；设定档案请用 update_memory 工具更新。",
  project_config: "项目配置文件为系统文件，只读。"
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

function toolError(code, message, technical = null) {
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
function sanitizeToolFailure(error) {
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
function toolFailureResult({ tool_call_id, name, code, message, retryable = null, kind = null, duration_ms = null, stdout = null, stderr = null }) {
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

function redactJsonValue(redactor, value) {
  try {
    return JSON.parse(redactor.redact(JSON.stringify(value ?? null)));
  } catch {
    return null;
  }
}

function auditToolResult(name, result) {
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
function defaultPermissionPolicy(action, context) {
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
  return null;
}

// shell 的静态受保护信号只有 cwd：不得在 journal / checkpoints 目录内运行命令。
// 有意不把 drafts/ 纳入 cwd 保护：cwd 是粗粒度信号，`cd drafts && ls` / `cat drafts/…`
// 属于合法读取，阻止 cwd 会误伤；shell 对草稿的写入仍受权限层（write/delete 类别确认、
// extreme 判定）约束，而 write_file/edit_file 走上面的精确路径检查。
function isProtectedShellCwd(projectRoot, cwd) {
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

// 文件类写工具共用的受保护路径预检（write_file / edit_file）
function fileProtectedCheck(args, context) {
  return isProtectedWritePath(context.projectRoot, path.resolve(context.projectRoot, args.path));
}

function isSafeEditContentPath(projectRoot, targetPath) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(targetPath);
  return SAFE_EDIT_CONTENT_REL.some((rel) => isPathInside(path.resolve(root, rel), target));
}

// ---------------------------------------------------------------------------
// ToolAction 构造（系统计算，模型不可覆盖）
// ---------------------------------------------------------------------------

function baseAction({ category, scope, targetClass, grantKey, title, description, targets = [], command = null, cwd = null }) {
  return {
    category,
    scope,
    risk: "normal",
    grant_key: grantKey,
    target_class: targetClass,
    title,
    description,
    command,
    cwd,
    targets,
    auto_allow: false,
    safe_edit_target: false
  };
}

// 文件类工具（read/write）的 action：scope/targetClass 由目标路径决定
function fileAction({ tool, args, context, targetPath, category, title, description }) {
  const { scope, targetClass, resolvedPath } = resolveProjectScope(context.projectRoot, targetPath);
  return baseAction({
    category,
    scope,
    targetClass,
    grantKey: `${category}:${scope}:${targetClass}`,
    title,
    description,
    targets: [resolvedPath]
  });
}

function deepAction({ title, description }) {
  const action = baseAction({
    category: "control",
    scope: "project",
    targetClass: "project-root",
    grantKey: "control:project:project-root",
    title,
    description
  });
  action.auto_allow = true; // 深工具是受项目 operations 守护的原子写路径，硬拒绝后自动放行
  return action;
}

// ---------------------------------------------------------------------------
// 参数校验（错误只报简短文案 + technical 字段名）
// ---------------------------------------------------------------------------

function requireStringArg(args, name, label = name) {
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
function optionalStringArg(args, name, label = name) {
  if (args[name] === undefined || args[name] === null) return "";
  if (typeof args[name] !== "string") {
    throw toolError("bad_args", `参数无效：${label} 必须是字符串。`, { rule: "bad_args", fields: [name] });
  }
  return args[name];
}

function requirePositiveIntArg(args, name, label = name) {
  if (!Number.isInteger(Number(args[name])) || Number(args[name]) <= 0) {
    throw toolError("bad_args", `参数无效：${label} 必须是正整数。`, { rule: "bad_args", fields: [name] });
  }
  return Number(args[name]);
}

function parseToolArguments(raw) {
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
// count_text 执行体（Task 9 Step 4）。只读客观统计：工作区内 .md/.txt，
// minimum/target 只计算差额，不判定通过或失败（冻结契约 §2.2）。
// 路径安全与 read_file 同模式：resolveFilesystemPath 解析真实路径后
// isPathInside 做包含性检查；ENOENT 折叠为 { path, exists: false }。
// ---------------------------------------------------------------------------

async function executeCountText(args, context) {
  const relative = requireStringArg(args, "path", "path");
  const target = await resolveFilesystemPath(path.resolve(context.projectRoot, relative));
  if (!isPathInside(context.projectRoot, target)) {
    throw toolError("path_outside_workspace", "只能统计当前工作区内的文件。", { path: relative });
  }
  if (![".md", ".txt"].includes(path.extname(target).toLowerCase())) {
    throw toolError("unsupported_text_file", "只支持 Markdown 或纯文本文件。", { path: relative });
  }
  const source = await fs.readFile(target, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
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

// ---------------------------------------------------------------------------
// createToolRuntime
// ---------------------------------------------------------------------------

export function createToolRuntime({
  projectOperations = {},
  journal,
  permissionPolicy,
  shellRuntime,
  projectLocks = null,
  secrets = [],
  skills = skillService,
  idFactory = randomUUID,
  // Task 2：统一工具期限（默认空闲 5 分钟 / 绝对 60 分钟）。测试可注入毫秒级
  // 期限与假时钟 seam（clock/setTimer/clearTimer），不依赖真实等待。
  toolIdleTimeoutMs = 300000,
  toolAbsoluteTimeoutMs = 3600000,
  clock = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id)
} = {}) {
  if (!journal || typeof journal.append !== "function") {
    throw new Error("createToolRuntime 需要注入 journal（src/core/agent/journal.mjs）");
  }
  const redactor = createRedactor({ secrets });
  const evaluatePolicy = typeof permissionPolicy === "function" ? permissionPolicy : defaultPermissionPolicy;

  const decisions = new Map(); // decision_id -> 待决决策记录
  let confirmationCounter = 0; // extreme 确认文字递增计数（保证同进程内不重复）

  // -------------------------------------------------------------------------
  // journal 辅助
  // -------------------------------------------------------------------------

  async function currentSession() {
    return journal.getSession();
  }

  async function currentActiveInputId() {
    const session = await currentSession();
    return session.active_run?.active_input_id ?? null;
  }

  async function currentGrants() {
    const session = await currentSession();
    return session.active_run?.active_grants ?? [];
  }

  // -------------------------------------------------------------------------
  // 临时授权（grant 绑定 active_input_id + grant_key + target class）。
  // grant 创建发生在 resolveDecision 的 allow_input 路径（与 decision_resolved
  // 同批原子落盘）；本层只提供清除入口（input 完成/取消/「立即」切换/停止时调用）。
  // -------------------------------------------------------------------------

  // 清除指定范围的全部/单个 grant 并追加 permission_grant_cleared（input 完成、
  // 取消或被「立即」切换时由运行时调用；停止时同样调用）。返回清除数量。
  // 同时清理该 input 的终态决策记录：input 结束后旧响应只可能得到 decision_not_found
  // 而非 decision_terminal（两者都拒绝，语义可接受），保证 decisions 表有界。
  async function clearGrants({ inputId = null, reason = "cleared", grantId = null, grantKey = null } = {}) {
    const session = await currentSession();
    const run = session.active_run;
    const grants = run?.active_grants ?? [];
    const matched = grants.filter((grant) => {
      const byInput = inputId === null || grant.input_id === inputId;
      const byId = grantId === null || grant.id === grantId;
      const byKey = grantKey === null || grant.grant_key === grantKey;
      return byInput && byId && byKey;
    });
    if (matched.length > 0) {
      await journal.appendBatch(
        matched.map((grant) => ({
          type: "permission_grant_cleared",
          run_id: run?.id ?? null,
          payload: {
            grant_id: grant.id,
            input_id: grant.input_id,
            grant_key: grant.grant_key,
            reason
          }
        }))
      );
    }
    if (inputId !== null) {
      for (const [id, record] of decisions) {
        if (record.inputId === inputId && record.terminal) decisions.delete(id);
      }
    }
    return matched.length;
  }

  // -------------------------------------------------------------------------
  // 决策：decision_requested ->（用户 decide）-> decision_resolved + 恢复执行
  // -------------------------------------------------------------------------

  function freshConfirmationText() {
    // 沿用前置计划的 extreme 确认文字格式：每次具体动作全新生成（uuid 尾部 + 递增计数）
    confirmationCounter += 1;
    const id = idFactory();
    let suffix;
    if (typeof id === "string") {
      suffix = (id.replace(/-/gu, "").slice(-6) || "000000").toUpperCase();
    } else {
      suffix = String(Math.abs(Number(id) || Date.now() % 0xffffff))
        .padStart(6, "0")
        .slice(0, 6);
    }
    return `强制继续 ${suffix}${String(confirmationCounter).padStart(2, "0")}`;
  }

  // 创建待决决策记录并注册进 decisions：返回 record（record.outcome 是恢复执行的
  // Promise）。abort（停止/立即）时作废待决决策：追加 decision_resolved(choice=cancelled)
  // 并以 cancelled 恢复执行（活动闭环：每个 decision_requested 都有对应 resolved）。
  function createDecisionRecord(context, record) {
    record.terminal = false;
    let resolveOutcome;
    record.outcome = new Promise((resolve) => {
      resolveOutcome = resolve;
    });
    // decision_requested 落盘后才放行取消收敛：abort 可能在 requestDecision 写入
    // decision_requested 之前到达（如 stop 恰在工具确认窗口内触发；Task 26 起旧
    // promote 已退役，requestPriority 不 abort），若 decision_resolved 先落盘，
    // reducer 以「引用未知 decision」拒绝（静默 catch），决策永久悬空（活动闭环
    // 断裂）。cancel 等待 request 落盘后再追加 resolved。
    let markRequested;
    record.requested = new Promise((resolve) => {
      markRequested = resolve;
    });
    // 唯一收口：置终态、清理 abort 监听并恢复挂起的 execute
    record.finish = (outcome) => {
      if (record.terminal) return;
      record.terminal = true;
      record.cleanupAbort?.();
      resolveOutcome(outcome);
    };
    record.settle = (outcome) => record.finish(outcome);
    record.cancel = async () => {
      if (record.terminal) return;
      record.terminal = true;
      record.cleanupAbort?.();
      try {
        // 必须等 decision_requested 先落盘（见上），否则 reducer 拒绝 resolved
        await record.requested;
        await journal.append({
          type: "decision_resolved",
          run_id: record.runId,
          payload: {
            decision_id: record.decisionId,
            activity_id: record.activityId,
            input_id: record.inputId,
            choice: "cancelled"
          }
        });
      } catch {
        // journal 已无法追加（如 Run 已终结）时仍按 cancelled 恢复执行
      }
      resolveOutcome({ granted: "cancelled" });
    };
    const onAbort = () => void record.cancel().catch(() => {});
    record.cleanupAbort = () => context.signal?.removeEventListener("abort", onAbort);
    context.signal?.addEventListener("abort", onAbort, { once: true });
    decisions.set(record.decisionId, record);
    record.markRequested = markRequested;
    return record;
  }

  // 用户决策入口（Task 6 的 agent.decide() 经此路由）。校验：
  //   - 未知 decision / 已终结 decision 一律拒绝（旧 HTTP 响应不能解锁）；
  //   - decision 绑定的 input 已不是活动输入（被完成/取消/「立即」切换）视为
  //     superseded，写终态 decision_resolved(choice=superseded) 后拒绝；
  //   - ordinary 只接受 allow/allow_input/deny；extreme 只接受当前
  //     confirmation_text 的精确原文（模型文本、历史 decision、同类 grant 均不满足）。
  async function resolveDecision({ decisionId, choice, confirmationText }) {
    const record = decisions.get(decisionId);
    if (!record) throw toolError("decision_not_found", "决策不存在或已过期。", { rule: "decision_not_found", decision_id: decisionId });
    if (record.terminal) throw toolError("decision_terminal", "该决策已终结，不能再次处理。", { rule: "decision_terminal", decision_id: decisionId });
    const session = await currentSession();
    const activeInputId = session.active_run?.active_input_id ?? null;
    if (record.inputId != null && activeInputId !== record.inputId) {
      // 输入已被完成/取消/「立即」切换：决策作废并写终态（记录保留在表中，
      // 后续旧响应得到 decision_terminal，而不是被误认为从未存在）；挂起的
      // execute 按 cancelled 恢复，不执行工具
      try {
        await journal.append({
          type: "decision_resolved",
          run_id: record.runId,
          payload: {
            decision_id: decisionId,
            activity_id: record.activityId,
            input_id: record.inputId,
            choice: "superseded"
          }
        });
      } catch {
        // 同上：journal 已无法追加时仍按终态处理
      }
      record.finish({ granted: "cancelled" });
      throw toolError("decision_superseded", "该决策已被更新的操作取代。", { rule: "decision_superseded", decision_id: decisionId });
    }

    let granted = "allow";
    if (record.kind === "extreme") {
      const text = confirmationText ?? choice;
      if (typeof text !== "string" || text !== record.confirmationText) {
        throw toolError("confirmation_mismatch", "确认文字不匹配，无法执行。", {
          rule: "confirmation_mismatch",
          decision_id: decisionId
        });
      }
    } else if (choice === "deny") {
      granted = "deny";
    } else if (choice !== "allow" && choice !== "allow_input") {
      throw toolError("invalid_choice", `未知决策选择：${String(choice)}`, {
        rule: "invalid_choice",
        fields: ["choice"]
      });
    }

    try {
      if (choice === "allow_input") {
        // grant 创建与 decision_resolved 同批落盘（原子）：superseded 检查之后、落盘
        // 之前输入被消费的竞态会让 permission_grant_created 引用非活 input，整批
        // dry-run 拒绝、什么都不写——下面 catch 兜底恢复挂起的 execute，不悬挂。
        await journal.appendBatch([
          {
            type: "permission_grant_created",
            run_id: record.runId,
            payload: {
              grant_id: idFactory(),
              input_id: record.inputId,
              grant_key: record.action.grant_key,
              target_class: record.action.target_class
            }
          },
          {
            type: "decision_resolved",
            run_id: record.runId,
            payload: {
              decision_id: decisionId,
              activity_id: record.activityId,
              input_id: record.inputId,
              choice
            }
          }
        ]);
      } else {
        await journal.append({
          type: "decision_resolved",
          run_id: record.runId,
          payload: {
            decision_id: decisionId,
            activity_id: record.activityId,
            input_id: record.inputId,
            choice
          }
        });
      }
    } catch (error) {
      // 竞态兜底：挂起 execute 按 cancelled 恢复（工具不执行），decide() 侧继续抛错
      record.finish({ granted: "cancelled" });
      throw error;
    }
    record.settle({ granted }); // settle 内部置 terminal 并恢复挂起的 execute
    return { decision_id: decisionId, granted };
  }

  // -------------------------------------------------------------------------
  // 增量输出：流式脱敏（有界 carry，跨 chunk 密钥仍被脱敏）+ 单次工具 1 MiB 截断
  // -------------------------------------------------------------------------

  function createDeltaEmitter({ toolCallId, activityId, name, runId }) {
    const streaming = createStreamingRedactor({ secrets });
    let emittedChars = 0;
    let truncated = false;
    let chain = Promise.resolve();
    // R5-15：delta 与终态统一携带 content_length + truncated 元数据。
    const appendDelta = (text, stream, contentLength, truncatedFlag) => {
      chain = chain.then(() =>
        journal.append({
          type: "tool_output_delta",
          run_id: runId,
          payload: {
            tool_call_id: toolCallId,
            activity_id: activityId,
            name,
            stream,
            text,
            content_length: contentLength,
            truncated: truncatedFlag
          }
        })
      );
    };
    return {
      redactor: streaming,
      // 终态（工具完成/失败/停止）时 flush 剩余 carry，再补齐尾部增量事件
      async flush() {
        await chain.catch(() => {});
        if (truncated) return;
        const tail = streaming.flush();
        if (tail.length > 0) {
          const { slice, content_length, truncated: clipped } = truncateOutput(tail, MAX_TOOL_OUTPUT_CHARS, emittedChars);
          const capped = clipped || emittedChars + slice.length >= MAX_TOOL_OUTPUT_CHARS;
          appendDelta(slice, "stdout", content_length, capped);
          emittedChars += slice.length;
          if (capped) truncated = true;
        }
        await chain.catch(() => {});
      },
      emit({ stream, text }) {
        if (truncated) return;
        const safe = streaming.push(text);
        if (safe.length === 0) return;
        const { slice, content_length, truncated: clipped } = truncateOutput(safe, MAX_TOOL_OUTPUT_CHARS, emittedChars);
        const capped = clipped || emittedChars + slice.length >= MAX_TOOL_OUTPUT_CHARS;
        appendDelta(slice, stream, content_length, capped);
        emittedChars += slice.length;
        if (capped) truncated = true;
      }
    };
  }

  // -------------------------------------------------------------------------
  // 事件追加辅助（失败不阻断主流程，尽量保证活动闭环）
  // -------------------------------------------------------------------------

  async function appendEvent(base) {
    await journal.append(base);
  }

  // -------------------------------------------------------------------------
  // 工具注册表与八个 general + 六个 deep 工具
  // -------------------------------------------------------------------------

  const TOOLS = new Map();
  function register(name, definition) {
    TOOLS.set(name, { ...definition, name });
  }

  // -------------------------------------------------------------------------
  // 工具注册（第十五轮 Task 5：注册体按域拆入 tools/definitions-*.mjs；
  // 本处保留注册表与 register，各域定义经 h 依赖包注入后 registerAll 注册）。
  // -------------------------------------------------------------------------

  // h：definitions 模块的依赖包。工厂闭包标识符（辅助函数、注入依赖、共享常量）在此
  // 组装，definitions-*.mjs 内通过 h 取用；模块级依赖（node 内置、fs-utils、
  // shell/risk、memory-extractor 等）由各 definitions 模块自行 import。
  const h = {
    toolError,
    fileAction,
    deepAction,
    baseAction,
    redactor,
    requireStringArg,
    optionalStringArg,
    requirePositiveIntArg,
    projectOperations,
    skills,
    shellRuntime,
    isSafeEditContentPath,
    isProtectedShellCwd,
    fileProtectedCheck,
    appendEvent,
    executeCountText,
    truncateOutput,
    MAX_TOOL_OUTPUT_CHARS,
    MAX_TOOL_RESULT_CHARS,
    PLAN_STATUSES
  };
  const registerAll = (defs) => {
    for (const [name, d] of Object.entries(defs)) register(name, d);
  };
  // 注册顺序 = 原 tools.mjs 暴露顺序（GENERAL 8 前 DEEP 6 后，tests/agent/tools.test.mjs
  // 的 definitions() 顺序断言是行为契约）：knowledge 域的 read_skill/count_text 属
  // general（原文件位置在 update_plan 之前），update_memory 属 deep（原位置在
  // rollback_chapter 之后），故该域拆两段注册。
  const knowledgeDefs = knowledgeToolDefinitions(h);
  registerAll(fsToolDefinitions(h));
  registerAll(shellToolDefinitions(h));
  registerAll({ read_skill: knowledgeDefs.read_skill, count_text: knowledgeDefs.count_text });
  registerAll(chapterToolDefinitions(h));
  registerAll({ update_memory: knowledgeDefs.update_memory });

  // -------------------------------------------------------------------------
  // Task 2：统一工具期限。空闲期限（idleMs）被 reportActivity 重置；绝对期限
  // （absoluteMs）不被重置。任一期限触发后 abort 组合 signal 并等待工具 settle，
  // 再以结构化结果返回（不向 Runtime 抛异常）。父 signal（用户停止/立即）只
  // 传导信号：工具自身的收尾结果（shell_cancelled 等）原样透传，不转 timeout。
  // 组合 signal：工具 context.signal 由父 signal 与期限 signal 共同驱动，内部
  // 长操作（shell 进程树、project operations 安全点）按既有约定响应。
  // -------------------------------------------------------------------------

  // 工具定义可声明更短的期限（deadline: { idleMs?, absoluteMs? }）；系统上限
  //（toolIdleTimeoutMs / toolAbsoluteTimeoutMs）不能被抬高——声明值超限一律钳制。
  function resolveToolDeadline(definition) {
    const declared = definition?.deadline ?? null;
    return {
      idleMs: declared?.idleMs != null ? Math.min(declared.idleMs, toolIdleTimeoutMs) : toolIdleTimeoutMs,
      absoluteMs: declared?.absoluteMs != null ? Math.min(declared.absoluteMs, toolAbsoluteTimeoutMs) : toolAbsoluteTimeoutMs
    };
  }

  function executeWithDeadline({ execute, context, idleMs, absoluteMs, parentSignal }) {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const startedAt = clock();
      let supervisorDone = false;
      let idleTimer = null;
      let absoluteTimer = null;
      let runPromise;

      const clearTimers = () => {
        if (idleTimer !== null) {
          clearTimer(idleTimer);
          idleTimer = null;
        }
        if (absoluteTimer !== null) {
          clearTimer(absoluteTimer);
          absoluteTimer = null;
        }
      };

      // reportActivity 只重置空闲期限（绝对期限不重置）
      const resetIdle = () => {
        if (supervisorDone) return;
        if (idleTimer !== null) clearTimer(idleTimer);
        idleTimer = setTimer(onIdle, idleMs);
      };

      const onIdle = () => finishTimeout("idle");
      const onAbsolute = () => finishTimeout("absolute");

      const runContext = {
        ...context,
        signal: controller.signal,
        reportActivity: resetIdle
      };

      const onParentAbort = () => {
        if (!controller.signal.aborted) controller.abort();
      };

      const settle = (outcome) => {
        if (supervisorDone) return;
        supervisorDone = true;
        clearTimers();
        parentSignal?.removeEventListener("abort", onParentAbort);
        if (outcome.kind === "error") reject(outcome.error);
        else resolve(outcome);
      };

      const finishTimeout = (kind) => {
        if (supervisorDone) return;
        supervisorDone = true;
        if (!controller.signal.aborted) controller.abort();
        clearTimers();
        parentSignal?.removeEventListener("abort", onParentAbort);
        const durationMs = Math.max(0, clock() - startedAt);
        // 必须等工具 settle（abort 后的收尾结果/错误原样丢弃）：不能放弃一个仍在
        // 写盘/终止进程树的工具就返回，原子写与进程树回收都要完整收尾
        runPromise.then(
          () => resolve({ kind: "timeout", timeoutKind: kind, durationMs }),
          () => resolve({ kind: "timeout", timeoutKind: kind, durationMs })
        );
      };

      if (parentSignal) parentSignal.addEventListener("abort", onParentAbort, { once: true });
      // 竞态守卫：supervisor 创建前父 signal 已 aborted（execute 预检查之后才发生）
      if (parentSignal?.aborted) controller.abort();

      idleTimer = setTimer(onIdle, idleMs);
      absoluteTimer = setTimer(onAbsolute, absoluteMs);

      runPromise = Promise.resolve()
        .then(() => execute(runContext))
        .then(
          (value) => settle({ kind: "result", value }),
          (error) => settle({ kind: "error", error })
        );
    });
  }

  // -------------------------------------------------------------------------
  // execute：单次工具调用闭环
  // -------------------------------------------------------------------------

  async function execute(toolCall, context = {}) {
    const toolCallId = toolCall?.id ?? toolCall?.tool_call_id ?? null;
    const name = toolCall?.name ?? null;
    const activityId = idFactory();
    const runId = context.run_id ?? null;
    if (!toolCallId || typeof name !== "string" || name.length === 0) {
      return toolFailureResult({ tool_call_id: toolCallId, name, code: "bad_tool_call", message: "工具调用缺少 id 或名称。" });
    }

    let args;
    try {
      args = parseToolArguments(toolCall.arguments);
    } catch (error) {
      return toolFailureResult({ tool_call_id: toolCallId, name, code: error.code ?? "bad_args", message: error.message });
    }

    // 在动作分类、受保护路径检查和实际执行前统一解析真实路径，避免 junction/
    // symlink 把项目外目标伪装成项目内。只覆盖带路径参数的通用工具；shell 的
    // cwd 同样必须用真实路径参与 scope 与实际进程启动。
    if (context.projectRoot) {
      if (["list_files", "search_files", "read_file", "write_file", "edit_file"].includes(name)) {
        args.path = await resolveFilesystemPath(path.resolve(context.projectRoot, args.path ?? "."));
      } else if (name === "shell" && args.cwd) {
        args.cwd = await resolveFilesystemPath(path.resolve(context.projectRoot, args.cwd));
      }
    }

    // 活动 Run 是工具事件的载体；没有 Run 时工具不可用（Task 6 编排保证不会发生）
    const session = await currentSession().catch(() => null);
    if (!session?.active_run) {
      return toolFailureResult({ tool_call_id: toolCallId, name, code: "no_active_run", message: "工具不可用。" });
    }
    const inputId = context.active_input_id ?? session.active_run.active_input_id ?? null;

    const definition = TOOLS.get(name);
    const allowedToolNames = Array.isArray(context.allowed_tool_names)
      ? new Set(context.allowed_tool_names)
      : null;

    // 工具定义暴露只是模型提示层，执行层必须独立强制授权。否则模型或 provider
    // 即使返回了当前工作流未暴露的深工具名，仍会命中全局注册表并执行。
    if (definition && allowedToolNames && !allowedToolNames.has(name)) {
      await appendStarted({ tool_call_id: toolCallId, activity_id: activityId, name, args }, runId);
      await appendFailed({
        tool_call_id: toolCallId,
        activity_id: activityId,
        name,
        error: "tool_not_allowed",
        message: "当前任务不允许使用此工具。",
        technical: { rule: "tool_not_allowed", name }
      }, runId);
      return toolFailureResult({ tool_call_id: toolCallId, name, code: "tool_not_allowed", message: "当前任务不允许使用此工具。" });
    }

    // 系统构建归一化动作（模型不可提供/覆盖 risk/scope/extreme/grant_key/确认类型）
    let action = null;
    if (definition) {
      try {
        action = definition.describeAction(args, context);
      } catch (error) {
        const failedMessage = redactor.redact(error.message);
        await appendStarted({ tool_call_id: toolCallId, activity_id: activityId, name, args }, runId);
        await appendFailed({
          tool_call_id: toolCallId,
          activity_id: activityId,
          name,
          error: error.code ?? "bad_args",
          message: failedMessage,
          technical: error.technical ?? null
        }, runId);
        return toolFailureResult({ tool_call_id: toolCallId, name, code: error.code ?? "bad_args", message: failedMessage });
      }
    }

    // 归一化动作与脱敏参数记入 journal（任何事件离开 ToolRuntime 前必须脱敏）
    await appendStarted({
      tool_call_id: toolCallId,
      activity_id: activityId,
      name,
      args,
      action: action ? normalizeActionFields(action, name) : null
    }, runId);

    if (!definition) {
      await appendFailed({
        tool_call_id: toolCallId,
        activity_id: activityId,
        name,
        error: "unknown_tool",
        message: "工具不可用。",
        technical: { rule: "unknown_tool", name }
      }, runId);
      return toolFailureResult({ tool_call_id: toolCallId, name, code: "unknown_tool", message: "工具不可用。" });
    }

    if (context.signal?.aborted) {
      await appendFailed({
        tool_call_id: toolCallId,
        activity_id: activityId,
        name,
        error: "tool_cancelled",
        message: "操作已停止。"
      }, runId);
      return toolFailureResult({ tool_call_id: toolCallId, name, code: "tool_cancelled", message: "操作已停止。" });
    }

    // 受保护路径（Step 7）：写工具先于权限评估拒绝
    let protectedDenial = null;
    try {
      protectedDenial = definition.protectedCheck?.(args, context) ?? null;
    } catch {
      protectedDenial = { rule: "protected_path", path: args.path ?? null };
    }
    if (protectedDenial) {
      const message = PROTECTED_DENIAL_MESSAGES[protectedDenial.rule] ?? "当前权限不允许修改文件。";
      await appendFailed({
        tool_call_id: toolCallId,
        activity_id: activityId,
        name,
        error: "permission_denied",
        message,
        technical: { rule: protectedDenial.rule ?? "protected_path", path: protectedDenial.path ?? null }
      }, runId);
      return toolFailureResult({ tool_call_id: toolCallId, name, code: "permission_denied", message });
    }

    // 权限：策略（硬拒绝/extreme/YOLO/只读自动/auto_edit）→ grant 匹配 → 普通确认
    let policyResult;
    try {
      policyResult = await evaluatePolicy(action, context);
    } catch (error) {
      await appendFailed({
        tool_call_id: toolCallId,
        activity_id: activityId,
        name,
        error: "permission_error",
        message: "当前权限不允许修改文件。",
        technical: { rule: "policy_error" }
      }, runId);
      return toolFailureResult({ tool_call_id: toolCallId, name, code: "permission_error", message: "当前权限不允许修改文件。" });
    }
    if (policyResult.decision === "deny") {
      await appendFailed({
        tool_call_id: toolCallId,
        activity_id: activityId,
        name,
        error: "permission_denied",
        message: policyResult.message ?? "当前权限不允许修改文件。",
        technical: policyResult.technical ?? null
      }, runId);
      return toolFailureResult({ tool_call_id: toolCallId, name, code: "permission_denied", message: policyResult.message ?? "当前权限不允许修改文件。" });
    }

    if (policyResult.decision === "confirm") {
      const grants = await currentGrants();
      const grant = grants.find(
        (item) =>
          item.input_id === inputId &&
          item.grant_key === action.grant_key &&
          item.target_class === action.target_class
      );
      if (grant) policyResult = { decision: "allow", grant };
    }

    if (policyResult.decision === "confirm" || policyResult.decision === "extreme_confirm") {
      const outcome = await requestDecision({ context, toolCallId, activityId, name, action, inputId, runId });
      if (outcome.granted === "deny") {
        await appendFailed({
          tool_call_id: toolCallId,
          activity_id: activityId,
          name,
          error: "permission_denied",
          message: "操作已拒绝。",
          technical: { rule: "decision_deny" }
        }, runId);
        return toolFailureResult({ tool_call_id: toolCallId, name, code: "permission_denied", message: "操作已拒绝。" });
      }
      if (outcome.granted === "cancelled") {
        await appendFailed({
          tool_call_id: toolCallId,
          activity_id: activityId,
          name,
          error: "tool_cancelled",
          message: "操作已停止。",
          technical: { rule: "decision_cancelled" }
        }, runId);
        return toolFailureResult({ tool_call_id: toolCallId, name, code: "tool_cancelled", message: "操作已停止。" });
      }
    }

    // 执行（含增量输出脱敏）。工具 run 由统一期限监督器
    // executeWithDeadline 包裹：context 获得组合 signal（父 signal + 期限
    // signal）与 reportActivity()（只重置空闲期限）；超时返回结构化
    // tool_timeout 结果，不向 Runtime 抛异常。
    const delta = createDeltaEmitter({ toolCallId, activityId, name, runId });
    let result;
    let error = null;
    let timeoutKind = null;
    let timeoutDurationMs = null;
    try {
      const { idleMs: toolIdleMs, absoluteMs: toolAbsoluteMs } = resolveToolDeadline(definition);
      const runTool = (runContext) => definition.run(args, runContext, { emitDelta: (event) => delta.emit(event) });
      const runWithDeadline = () =>
        executeWithDeadline({
          execute: runTool,
          context,
          idleMs: toolIdleMs,
          absoluteMs: toolAbsoluteMs,
          parentSignal: context.signal
        });
      const outcome = projectLocks && action.category !== "read"
        ? await projectLocks.runExclusive(context.projectRoot, runWithDeadline)
        : await runWithDeadline();
      if (outcome.kind === "timeout") {
        timeoutKind = outcome.timeoutKind;
        timeoutDurationMs = Number.isFinite(outcome.durationMs) ? outcome.durationMs : null;
      } else {
        result = outcome.value;
      }
    } catch (caught) {
      error = caught;
    }
    await delta.flush().catch(() => {});

    if (timeoutKind !== null) {
      // 结构化超时结果（Task 2）：{ok:false, error:{code:"tool_timeout", kind}}，
      // 不抛异常——Task 3 据此闭合工具而不杀死 Run
      const failedPayload = {
        tool_call_id: toolCallId,
        activity_id: activityId,
        name,
        error: "tool_timeout",
        message: "工具执行超时。",
        technical: { kind: timeoutKind },
        duration_ms: timeoutDurationMs
      };
      await appendFailed(failedPayload, runId);
      return toolFailureResult({
        tool_call_id: toolCallId,
        name,
        code: "tool_timeout",
        message: "工具执行超时。",
        kind: timeoutKind,
        retryable: true,
        duration_ms: timeoutDurationMs
      });
    }

    if (error) {
      // Node 文件错误先映射为简短工具错误（计划 Task 4 Step 6）；随后错误 message
      // 可能内嵌参数值（如 args.path 含 token 形片段）：事件与返回值都先过脱敏，
      // 避免密钥形态文本随错误信息离开 ToolRuntime
      const sanitized = sanitizeToolFailure(error);
      const failedMessage = redactor.redact(sanitized.message);
      const failedPayload = {
        tool_call_id: toolCallId,
        activity_id: activityId,
        name,
        error: error.code ?? "tool_failed",
        message: failedMessage,
        technical: sanitized.technical ?? null,
        duration_ms: Number.isFinite(error.durationMs) ? error.durationMs : null
      };
      if (typeof error.stdout === "string") failedPayload.stdout = redactor.redact(error.stdout);
      if (typeof error.stderr === "string") failedPayload.stderr = redactor.redact(error.stderr);
      await appendFailed(failedPayload, runId);
      return toolFailureResult({
        tool_call_id: toolCallId,
        name,
        code: error.code ?? "tool_failed",
        message: failedMessage,
        duration_ms: failedPayload.duration_ms ?? null,
        stdout: failedPayload.stdout ?? null,
        stderr: failedPayload.stderr ?? null
      });
    }

    await appendEvent({
      type: "tool_call_completed",
      run_id: runId,
      payload: {
        // 审计字段展开在前，name/tool_call_id/activity_id 恒为工具权威值——
        // read_skill 结果自身携带技能 name，绝不能覆盖工具名（Task 12 回归）。
        ...redactJsonValue(redactor, auditToolResult(name, result)),
        tool_call_id: toolCallId,
        activity_id: activityId,
        name
      }
    });
    return { ok: true, tool_call_id: toolCallId, name, result };
  }

  async function appendStarted(payload, runId) {
    // 任何事件离开 ToolRuntime 前必须脱敏（参数与归一化动作）
    const redacted = {
      ...payload,
      args: redactJsonValue(redactor, payload.args),
      action: payload.action ? redactJsonValue(redactor, payload.action) : null
    };
    try {
      await appendEvent({ type: "tool_call_started", run_id: runId ?? null, payload: redacted });
    } catch {
      // 活动闭环兜底：journal 失败时不再重试
    }
  }

  async function appendFailed(payload, runId) {
    try {
      await appendEvent({ type: "tool_call_failed", run_id: runId ?? null, payload });
    } catch {
      // 活动闭环兜底：journal 失败时不再重试，直接返回结果
    }
  }

  function normalizeActionFields(action, name) {
    return {
      tool: name,
      category: action.category,
      scope: action.scope,
      risk: action.risk,
      grant_key: action.grant_key,
      target_class: action.target_class,
      title: action.title ?? null,
      description: action.description ?? null,
      command: action.command ?? null,
      cwd: action.cwd ?? null,
      targets: action.targets ?? [],
      auto_allow: action.auto_allow === true,
      safe_edit_target: action.safe_edit_target === true
    };
  }

  function actionFingerprint(name, action) {
    return JSON.stringify({
      tool: name,
      category: action.category,
      scope: action.scope,
      risk: action.risk,
      grant_key: action.grant_key,
      target_class: action.target_class,
      targets: action.targets ?? []
    });
  }

  // 请求确认：先注册待决决策（供 resolveDecision 立即寻址），再写 waiting_user 状态
  // 与 decision_requested，随后挂起等待。取消路径（abort）不写 running（停止/立即
  // 编排负责状态）；正常解析（allow/allow_input/deny）后恢复 running。
  async function requestDecision({ context, toolCallId, activityId, name, action, inputId, runId }) {
    if (context.signal?.aborted) return { granted: "cancelled" }; // 竞态守卫：execute 预检查之后才 abort
    const decisionId = idFactory();
    const kind = action.risk === "extreme" ? "extreme" : "normal";
    const confirmationText = kind === "extreme" ? freshConfirmationText() : null;
    const record = createDecisionRecord(context, {
      decisionId,
      activityId,
      toolCallId,
      name,
      action,
      inputId,
      runId,
      kind,
      confirmationText
    });
    await appendEvent({
      type: "run_status_changed",
      run_id: runId,
      payload: { status: "waiting_user" }
    });
    try {
      await appendEvent({
        type: "decision_requested",
        run_id: runId,
        payload: redactJsonValue(redactor, {
          decision_id: decisionId,
          activity_id: activityId,
          input_id: inputId,
          tool_call_id: toolCallId,
          name,
          kind,
          title: action.title ?? name,
          description: action.description ?? null,
          confirmation_text: confirmationText,
          fingerprint: actionFingerprint(name, action),
          technical: { rule: kind === "extreme" ? "extreme_confirm" : "permission_confirm", fields: ["choice"] }
        })
      });
    } finally {
      // 无论落盘成败都放行 cancel（成功 → resolved 紧随其后；失败 → 请求本身已
      // 抛错、journal 无 open decision，收敛由上层失败路径负责）
      record.markRequested();
    }
    const outcome = await record.outcome;
    if (outcome.granted !== "cancelled") {
      await appendEvent({
        type: "run_status_changed",
        run_id: runId,
        payload: { status: "running" }
      }).catch(() => {});
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // 对外接口
  // -------------------------------------------------------------------------

  function definitions() {
    return [...TOOLS.values()].map((definition) => ({
      type: "function",
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.schema
      }
    }));
  }

  return {
    definitions,
    execute,
    resolveDecision,
    clearGrants,
    isInterruptible(name) {
      return TOOLS.get(name)?.interruptible === true;
    },
    // 内部 seam（tests/agent 可测）：待决（非终态）决策数量
    _pendingDecisionCount: () => [...decisions.values()].filter((record) => !record.terminal).length,
    // 内部 seam（tests/agent 可测）：注册自定义工具（Task 2 期限测试注入 deadline）
    _registerTool(name, definition) {
      register(name, definition);
      return () => TOOLS.delete(name);
    }
  };
}
