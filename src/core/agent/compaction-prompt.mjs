// src/core/agent/compaction-prompt.mjs
//
// Task 7：结构化压缩契约（纯模块——不读文件、不调用模型、不写状态）。
//
// 固定契约（计划 §2，各字段名必须逐字使用）：
//
// // CompactionSummaryV1（与规格草案 §6 JSON 骨架的 13 个字段一一对应）
// // {
// //   schema_version: 1,
// //   current_task: string,
// //   user_confirmed_decisions: string[],
// //   verified_facts: string[],
// //   files_and_artifacts: string[],
// //   completed_steps: string[],
// //   pending_steps: string[],
// //   pending_decisions: string[],
// //   failures_and_recovery: string[],
// //   open_tool_calls: Array<object>,
// //   recent_user_intent: string,
// //   omitted_information: string[],
// //   reload_from_workspace: string[]
// // }
//
// 保护字段（brief Step 3）：current_task / user_confirmed_decisions / pending_steps /
// open_tool_calls / reload_from_workspace 在源状态非空时，摘要不得删除。
//
// 一轮（规格 §4.1）定义为一条 user input 与其对应的 assistant_message_completed 正文：
// selectProtectedRecentTurns 优先保留最近 12 轮原文；已闭合大型 tool output 只保留
// 名称、结果摘要和 Journal 引用；未闭合 tool-call 链完整保留且不可被驱逐；12 轮自身
// 超过目标时从较早轮开始进入摘要，但最新 2 轮原文绝不删除。
import { estimateTokens } from "./prompt.mjs";

export const SUMMARY_FIELDS = Object.freeze([
  "schema_version",
  "current_task",
  "user_confirmed_decisions",
  "verified_facts",
  "files_and_artifacts",
  "completed_steps",
  "pending_steps",
  "pending_decisions",
  "failures_and_recovery",
  "open_tool_calls",
  "recent_user_intent",
  "omitted_information",
  "reload_from_workspace"
]);

export const SUMMARY_ARRAY_FIELDS = Object.freeze([
  "user_confirmed_decisions",
  "verified_facts",
  "files_and_artifacts",
  "completed_steps",
  "pending_steps",
  "pending_decisions",
  "failures_and_recovery",
  "open_tool_calls",
  "omitted_information",
  "reload_from_workspace"
]);

// 源状态非空时摘要不得删除的五个字段（brief Step 3 逐字）。
export const PROTECTED_SUMMARY_FIELDS = Object.freeze([
  "current_task",
  "user_confirmed_decisions",
  "pending_steps",
  "open_tool_calls",
  "reload_from_workspace"
]);

// 规格草案 §6 逐字 JSON 指令。禁止附加 reasoning、工具说明、Markdown 或补造事实；
// 稳定 Prompt 层 / Runtime Policy / WWRITING.md / 总纲 / 设定由 runtime 重新装配，
// 模型只生成早期 History 的结构化替代物。
export const COMPACTION_PROMPT = `你正在为 WWriting 生成一个可恢复的上下文压缩检查点。

只依据输入材料中的可验证事实，不补造事实，不把模型猜测写成决定。
不要输出或重建私有 reasoning、思维链或隐藏分析；不要复制大段工具原文。
保留当前任务继续执行所必需的信息，并标明哪些内容已被省略、哪些信息需要重新读取文件确认。

请严格输出 JSON，不要输出 Markdown、解释文字或代码围栏：
{
  "schema_version": 1,
  "current_task": "当前仍要完成的用户目标",
  "user_confirmed_decisions": [],
  "verified_facts": [],
  "files_and_artifacts": [],
  "completed_steps": [],
  "pending_steps": [],
  "pending_decisions": [],
  "failures_and_recovery": [],
  "open_tool_calls": [],
  "recent_user_intent": "最近一条仍有效的用户意图",
  "omitted_information": [],
  "reload_from_workspace": []
}

字段要求：
- 数组元素短、可验证、可逐项恢复；没有内容时使用空数组。
- \`open_tool_calls\` 只记录未闭合调用的名称、id、参数摘要和下一步，不复制完整输出。
- \`reload_from_workspace\` 列出压缩后必须重新读取的 WWRITING.md、总纲、设定或其他权威文件。
- 不要把“可能”“大概”“应该”变成用户已确认决定。
`;

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 对象级摘要形状校验：必须是对象、schema_version===1、13 个字段全部存在、
// 10 个数组字段必须是数组、两个字符串字段必须是字符串。返回原对象。
export function validateSummaryShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw contractError("compaction_schema", "压缩响应 schema 校验失败：必须是 JSON 对象");
  }
  if (value.schema_version !== 1) {
    throw contractError(
      "compaction_schema",
      `压缩响应 schema 校验失败：schema_version 必须是 1，实际为 ${JSON.stringify(value.schema_version)}`
    );
  }
  for (const field of SUMMARY_FIELDS) {
    if (!(field in value)) {
      throw contractError("compaction_schema", `压缩响应 schema 校验失败：缺少字段 ${field}`);
    }
  }
  for (const field of SUMMARY_ARRAY_FIELDS) {
    if (!Array.isArray(value[field])) {
      throw contractError("compaction_schema", `压缩响应 schema 校验失败：字段 ${field} 必须是数组`);
    }
  }
  if (typeof value.current_task !== "string") {
    throw contractError("compaction_schema", "压缩响应 schema 校验失败：current_task 必须是字符串");
  }
  if (typeof value.recent_user_intent !== "string") {
    throw contractError("compaction_schema", "压缩响应 schema 校验失败：recent_user_intent 必须是字符串");
  }
  return value;
}

// 解析模型输出的压缩响应文本：只接受对象，schema_version===1，13 字段齐全且
// 数组字段为数组（brief Step 3）。成功返回摘要对象；失败抛结构化错误。
export function parseCompactionResponse(text) {
  if (typeof text !== "string") {
    throw contractError("compaction_response_type", "压缩响应必须是字符串");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw contractError("compaction_json", `压缩响应不是合法 JSON：${error?.message ?? String(error)}`);
  }
  return validateSummaryShape(parsed);
}

function isNonEmpty(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// 保护字段校验：sourceState[field] 非空时，摘要对应字段不得为空/缺失。
// sourceState 需由 runtime 提供（旧 checkpoint 摘要 + 当前运行状态），字段名与
// PROTECTED_SUMMARY_FIELDS 相同；未提供（undefined）时跳过该校验。
export function validateCompactionSummary(summary, sourceState = {}) {
  validateSummaryShape(summary);
  const source = sourceState ?? {};
  for (const field of PROTECTED_SUMMARY_FIELDS) {
    if (!isNonEmpty(source[field])) continue;
    if (!isNonEmpty(summary[field])) {
      throw contractError(
        "compaction_protected_state",
        `压缩摘要保护字段校验失败：源状态中 ${field} 非空，摘要不得删除`
      );
    }
  }
  return { protected_state_ok: true };
}

// ---------------------------------------------------------------------------
// selectProtectedRecentTurns
// ---------------------------------------------------------------------------

// 一轮 = 一条 user input 与其对应的 assistant_message_completed 正文。
// // Turn
// // {
// //   id: string,
// //   user_text: string,
// //   assistant_text: string | null,
// //   token_estimate: number,                  // 原文估算 token（缺省按内容计算）
// //   transcript_seq_start: number | null,
// //   transcript_seq_end: number | null,
// //   tool_activities: Array<{
// //     tool_call_id: string,
// //     name: string,
// //     status: "open" | "closed",
// //     arguments: object | null,
// //     output: string | null,
// //     result_summary: string | null,          // closed 大输出替换后的结果摘要
// //     journal_ref: string | null             // Journal 引用（seq 范围/event_id）
// //   }>
// // }
export const DEFAULT_MAX_PROTECTED_TURNS = 12;
export const DEFAULT_MIN_PROTECTED_TURNS = 2;
export const DEFAULT_TOOL_OUTPUT_THRESHOLD = 2000;
// 本地截断摘要的预算：大工具输出不进压缩请求/checkpoint 原文，只留头尾片段 +
// 长度与 Journal 引用。字符预算按 CJK 感知估算反推（1 CJK 字符 ≈ 1 token），
// 摘要整体应远小于 DEFAULT_TOOL_OUTPUT_THRESHOLD。
export const TOOL_SUMMARY_HEAD_CHARS = 500;
export const TOOL_SUMMARY_TAIL_CHARS = 200;

// 为大型闭合工具输出生成本地截断摘要（不调用模型、不猜测语义）：
// 保留头部 500 字符 + 尾部 200 字符，中间用省略行，并注明原文长度与 Journal
// 引用。模型需要细节时按引用重新读取，符合规格「不要复制大段工具原文」。
export function buildToolOutputSummary(output, { journalRef = null, headChars = TOOL_SUMMARY_HEAD_CHARS, tailChars = TOOL_SUMMARY_TAIL_CHARS } = {}) {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  if (text.length <= headChars + tailChars + 24) {
    return text.length > 0 ? text : "(空输出)";
  }
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const ref = journalRef != null ? `（完整内容见 Journal ${journalRef}）` : "（完整内容见 Journal）";
  return `[工具输出已本地截断：原文 ${text.length} 字符${ref}]\n${head}\n…（中间省略 ${Math.max(0, text.length - headChars - tailChars)} 字符）…\n${tail}`;
}

function turnTokens(turn) {
  if (turn == null) return 0;
  if (typeof turn.token_estimate === "number" && Number.isFinite(turn.token_estimate)) {
    return Math.max(0, turn.token_estimate);
  }
  const text = [
    turn.user_text,
    turn.assistant_text,
    ...(turn.tool_activities ?? []).map((a) => a?.output ?? a?.result_summary ?? "")
  ]
    .filter((part) => part != null)
    .join("\n");
  return estimateTokens(text);
}

function hasOpenToolCalls(turn) {
  return (turn?.tool_activities ?? []).some((activity) => activity?.status === "open");
}

// 被保护轮内：大型已闭合工具输出只保留 { name, result_summary, journal_ref }；
// 未闭合链与小型输出完整保留；无 result_summary 时本地截断生成摘要（不再保留
// 原文——transcript 重建的轮次永远没有 result_summary，保留原文会让 12 轮保护
// 窗被大工具输出撑爆，压缩后 active context 依然接近满窗）。
function summarizeClosedToolOutputs(turn, toolOutputThreshold) {
  if (turn == null || !Array.isArray(turn.tool_activities)) return turn;
  let changed = false;
  const tool_activities = turn.tool_activities.map((activity) => {
    if (activity == null || activity.status !== "closed") return activity;
    const outputTokens = estimateTokens(
      typeof activity.output === "string" ? activity.output : JSON.stringify(activity.output ?? "")
    );
    if (outputTokens <= toolOutputThreshold) return activity;
    const summary =
      typeof activity.result_summary === "string" && activity.result_summary.length > 0
        ? activity.result_summary
        : buildToolOutputSummary(activity.output, { journalRef: activity.journal_ref ?? null });
    changed = true;
    return {
      tool_call_id: activity.tool_call_id ?? null,
      name: activity.name ?? null,
      status: "closed",
      arguments: activity.arguments ?? null,
      output: null,
      result_summary: summary,
      journal_ref: activity.journal_ref ?? null,
      summarized_output: true
    };
  });
  return changed ? { ...turn, tool_activities } : turn;
}

// 选择受保护近期轮次。turns 按时间顺序（旧→新）传入；返回：
//   protected_turns   —— 保留原文的轮次（最新 maxProtectedTurns 轮，含驱逐后下限
//                        minProtectedTurns 轮；未闭合工具链轮次不可驱逐；大型已闭合
//                        工具输出一律本地截断摘要，绝不带全文）
//   summarized_turns  —— 进入结构化摘要的轮次（更早历史 + 预算超限时被移出的轮次，
//                        同样只带截断后的工具摘要）
//   stats             —— total/protected/summarized 计数、token 预算与超限标记
export function selectProtectedRecentTurns({
  turns = [],
  targetTokens = Infinity,
  toolOutputThreshold = DEFAULT_TOOL_OUTPUT_THRESHOLD,
  maxProtectedTurns = DEFAULT_MAX_PROTECTED_TURNS,
  minProtectedTurns = DEFAULT_MIN_PROTECTED_TURNS
} = {}) {
  const all = Array.isArray(turns) ? turns : [];
  const summarizedTurns = [];
  const protectedCount = Math.min(maxProtectedTurns, all.length);
  // 预算优先：候选轮先做工具输出摘要化（大输出 → 本地截断摘要），再按摘要化后
  // 的真实占用做预算驱逐。驱逐判定不得使用原文 token——大工具输出若保留原文，
  // 12 轮内仅 2-3 个大输出轮就会触发驱逐，而摘要化后它们实际只占几十 token。
  const candidateTurns = all.slice(-protectedCount).map((turn) => summarizeClosedToolOutputs(turn, toolOutputThreshold));
  if (protectedCount < all.length) {
    summarizedTurns.push(
      ...all.slice(0, all.length - protectedCount).map((turn) => summarizeClosedToolOutputs(turn, toolOutputThreshold))
    );
  }

  // 预算驱逐：摘要化后的保护轮超过 targetTokens 时，从最早的被保护轮开始移入
  // 摘要；未闭合工具链轮次完整保留（不可驱逐）；最新 minProtectedTurns 轮原文
  // 绝不删除。摘要化后仍超预算（例如最新 2 轮正文本身巨大）时允许 overshoot。
  let tokens = candidateTurns.reduce((sum, turn) => sum + turnTokens(turn), 0);
  while (tokens > targetTokens && candidateTurns.length > minProtectedTurns) {
    const evictable = candidateTurns.slice(0, candidateTurns.length - minProtectedTurns);
    const index = evictable.findIndex((turn) => !hasOpenToolCalls(turn));
    if (index === -1) break; // 剩余被保护轮全部含未闭合链 → 完整保留
    const [evicted] = candidateTurns.splice(index, 1);
    summarizedTurns.push(evicted);
    tokens -= turnTokens(evicted);
  }

  return {
    protected_turns: candidateTurns,
    summarized_turns: summarizedTurns,
    stats: {
      total_turns: all.length,
      protected_count: candidateTurns.length,
      summarized_count: summarizedTurns.length,
      protected_tokens: tokens,
      target_tokens: Number.isFinite(targetTokens) ? targetTokens : null,
      overshoot: tokens > targetTokens
    }
  };
}
