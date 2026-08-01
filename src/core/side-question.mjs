// 旁路询问（Side Question）运行时。
//
// 设计目标：当主写作智能体正在规划/写作/审稿/保存时，用户可以临时提问，
// 用于分析、解释、确认状态。旁路询问遵循三条铁律：
//   1. 不是主任务修改指令，默认不打断当前写作流程。
//   2. 默认不修改小说正文、章节文件、task_plan.md、progress.md、agent_state.json。
//   3. 只读取当前上下文并回答；记录写入独立的 side_questions.md，与正式创作日志分开。
//
// 当用户提出会影响主线设定的修改（把女主改成反派、改世界观核心设定等），
// 本模块不直接执行，而是标记 mainTaskAffecting，由 UI 询问是否转为正式任务，
// 只有用户确认后才走正式写作指令通道（/api/commands/submit）。

import fs from "node:fs/promises";
import { CostTracker } from "./cost-tracker.mjs";
import { loadConfigLayers } from "./config-runtime.mjs";
import { readEvents } from "./event-log.mjs";
import { pathExists, safeJoin } from "./fs-utils.mjs";
import { ModelClient } from "./model-client.mjs";
import { MockProviderAdapter, OpenAICompatibleAdapter } from "./provider-adapters.mjs";
import { loadChapterIndex, loadProject, loadState } from "./project-store.mjs";
import { readChapterContent } from "./app-dashboard.mjs";

export const SIDE_QUESTION_PREFIXES = ["/ask", "/side", "/q"];
export const REVIEW_PREFIXES = ["/review", "/审稿"];
export const WRITE_PREFIXES = ["/write", "/写作"];

// 旁路分析助手的系统提示词：只回答，不修改任何文件或中断主任务。
export const SIDE_QUESTION_SYSTEM_PROMPT =
  "你是 WWriting 小说智能体的旁路分析助手。用户正在让主智能体创作小说。" +
  "你现在只负责回答用户的临时问题。不要修改正文，不要改写章节文件，不要改变 task_plan.md，" +
  "不要改变 progress.md，也不要中断主写作任务。除非用户明确确认将该问题转为正式变更，" +
  "否则你只能给出分析、解释、建议或状态说明。请基于当前小说设定、任务计划、写作进度和" +
  "最近章节摘要，给出简洁、准确、有帮助的回答。回答请使用中文。";

/**
 * 解析用户在命令栏输入的内容，结合当前模式判断它属于哪个流程。
 * @param {string} input 原始输入。
 * @param {"main"|"side_question"|"review"} currentMode 命令栏当前模式。
 * @returns {{type:"main"|"side_question"|"review"|"empty", content:string, raw:string, shouldAffectMainTask:boolean}}
 */
export function parseUserCommand(input, currentMode = "main") {
  const raw = String(input ?? "");
  const trimmed = raw.trim();
  if (!trimmed) {
    return { type: "empty", content: "", raw, shouldAffectMainTask: false };
  }

  const askContent = matchCommandPrefix(trimmed, SIDE_QUESTION_PREFIXES);
  if (askContent !== null) {
    return { type: "side_question", content: askContent, raw, shouldAffectMainTask: detectMainTaskImpact(askContent) };
  }
  const reviewContent = matchCommandPrefix(trimmed, REVIEW_PREFIXES);
  if (reviewContent !== null) {
    return { type: "review", content: reviewContent, raw, shouldAffectMainTask: true };
  }
  const writeContent = matchCommandPrefix(trimmed, WRITE_PREFIXES);
  if (writeContent !== null) {
    return { type: "main", content: writeContent, raw, shouldAffectMainTask: true };
  }

  if (currentMode === "side_question") {
    return { type: "side_question", content: trimmed, raw, shouldAffectMainTask: detectMainTaskImpact(trimmed) };
  }
  if (currentMode === "review") {
    return { type: "review", content: trimmed, raw, shouldAffectMainTask: true };
  }
  return { type: "main", content: trimmed, raw, shouldAffectMainTask: true };
}

// 命令前缀匹配：前缀必须独立成词（其后是空白或结束），返回去掉前缀后的内容；不匹配返回 null。
function matchCommandPrefix(trimmed, prefixes) {
  const lower = trimmed.toLowerCase();
  for (const prefix of prefixes) {
    if (lower === prefix.toLowerCase()) {
      return "";
    }
    const withSpace = `${prefix.toLowerCase()} `;
    if (lower.startsWith(withSpace) || trimmed.startsWith(`${prefix}\n`)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return null;
}

// 判断旁路询问里是否其实包含「修改主线设定/正文」的诉求。命中则不直接执行，转为待确认变更。
export const MAIN_TASK_IMPACT_PATTERN =
  /(改成|改为|改掉|改写|写成|换成|替换|删除|删掉|去掉|移除|重写|改编|不要写|不再写|别写|不写|推翻|重新设定|改设定|改人设|改世界观|改大纲|改结局|改剧情|黑化|洗白|复活|写死|赐死|领便当|降智|崩坏|让.{0,6}死|让.{0,6}活|让.{0,8}(在一起|分手|退场|出局|登场|加入|离开|背叛|反水))/u;

export function detectMainTaskImpact(text) {
  const value = String(text ?? "");
  if (!value.trim()) {
    return false;
  }
  return MAIN_TASK_IMPACT_PATTERN.test(value);
}

/**
 * 收集旁路询问所需的当前小说上下文（全部只读）。
 */
export async function collectSideQuestionContext(projectRoot) {
  const project = await loadProject(projectRoot);
  const config = await loadConfigLayers(projectRoot, project);
  const effectiveProject = {
    ...project,
    effective_config: config.effective,
    active_model: config.effective.active_model
  };
  const [state, chapterIndex, events, bookSummary, taskPlan, progress] = await Promise.all([
    loadState(projectRoot)
      .then((value) => value ?? {})
      .catch(() => ({})),
    loadChapterIndex(projectRoot).catch(() => ({ chapters: [] })),
    readEvents(projectRoot, { limit: 60 }).catch(() => []),
    readOptionalText(projectRoot, "memory", "book_summary.md"),
    readOptionalText(projectRoot, "task_plan.md"),
    readOptionalText(projectRoot, "progress.md")
  ]);

  const chapters = chapterIndex.chapters ?? [];
  const completedChapters = chapters.filter((chapter) => chapter.status === "completed").length;
  const totalWords = chapters.reduce((sum, chapter) => sum + Number(chapter.actual_words ?? 0), 0);
  const targetChapters = Number(project.target_chapters ?? chapters.length ?? 0);

  // 最近一章可读正文摘要（取最后一个有正文的章节）。
  let latestChapterExcerpt = "";
  let latestChapterNo = null;
  const readable = [...chapters].reverse().find((chapter) => chapter.final_path || chapter.draft_path);
  if (readable) {
    try {
      const content = await readChapterContent(projectRoot, readable.chapter_no);
      latestChapterExcerpt = excerpt(content.content, 600);
      latestChapterNo = readable.chapter_no;
    } catch {
      latestChapterExcerpt = "";
    }
  }

  const recentInstructions = events
    .filter((event) => event.type === "user_instruction_received" && event.message)
    .slice(-3)
    .map((event) => event.message);

  return {
    projectRoot,
    projectConfig: effectiveProject,
    activeModel: config.effective.active_model ?? { provider: "mock" },
    title: project.title ?? "未命名小说",
    storySeed: project.story_seed ?? "",
    targetChapters,
    completedChapters,
    totalWords,
    currentChapterNo: state.current_chapter_no ?? null,
    currentStage: state.current_stage ?? null,
    projectStatus: state.project_status ?? "idle",
    agentPhase: agentPhaseLabel(state.project_status, state.current_stage),
    bookSummary: excerpt(bookSummary, 800),
    taskPlanExcerpt: excerpt(taskPlan, 1200),
    progressExcerpt: excerpt(progress, 1200),
    latestChapterNo,
    latestChapterExcerpt,
    recentInstructions
  };
}

/**
 * 处理一次旁路询问：收集上下文 -> 调用模型（mock 离线则本地合成）-> 记录到 side_questions.md。
 * 不修改正文、章节、状态、计划文件。
 */
export async function handleSideQuestion(projectRoot, rawQuestion, options = {}) {
  const question = String(rawQuestion ?? "").trim();
  if (!question) {
    const error = new Error("请输入要向智能体提出的问题。");
    error.code = "side_question_empty";
    throw error;
  }
  if (question.length > 4000) {
    const error = new Error("旁路询问内容过长。");
    error.code = "side_question_too_long";
    throw error;
  }

  const context = await collectSideQuestionContext(projectRoot);
  const mainTaskAffecting = detectMainTaskImpact(question);
  const provider = context.activeModel?.provider ?? "mock";

  let answer = "";
  let answerMode = "offline";
  let modelError = null;
  if (options.modelClient || (provider && provider !== "mock")) {
    try {
      const client = options.modelClient ?? buildSideQuestionClient();
      const messages = buildSideQuestionMessages(context, question, mainTaskAffecting);
      const result = await client.generate({
        project: context.projectConfig,
        stage: "side_question",
        messages,
        metadata: { sideQuestion: true, mainTaskAffecting }
      });
      answer = String(result.text ?? "").trim();
      answerMode = "model";
    } catch (error) {
      answer = "";
      answerMode = "offline_fallback";
      modelError = error.message;
    }
  }
  if (!answer) {
    answer = synthesizeOfflineAnswer(context, question, mainTaskAffecting);
    if (answerMode === "model") {
      answerMode = "offline";
    }
  }

  const askedAt = options.now ?? new Date();
  const record = {
    askedAt: askedAt.toISOString(),
    question,
    answer,
    mainTaskAffecting,
    promotedToTask: false,
    answerMode,
    modelError
  };
  let loggedTo = null;
  if (options.log !== false) {
    await appendSideQuestionLog(projectRoot, record);
    loggedTo = "side_questions.md";
  }

  return {
    ok: true,
    question,
    answer,
    answerMode,
    modelError,
    mainTaskAffecting,
    suggestion: mainTaskAffecting ? buildPromotionSuggestion(question) : null,
    context: {
      title: context.title,
      agentPhase: context.agentPhase,
      currentChapterNo: context.currentChapterNo,
      currentStage: context.currentStage,
      completedChapters: context.completedChapters,
      targetChapters: context.targetChapters
    },
    loggedTo,
    askedAt: record.askedAt
  };
}

// 把一次旁路询问追加写入项目根目录的 side_questions.md（与正式创作日志分开）。
export async function appendSideQuestionLog(projectRoot, record) {
  const logPath = safeJoin(projectRoot, "side_questions.md");
  const exists = await pathExists(logPath);
  const blocks = [];
  if (!exists) {
    blocks.push("# 旁路询问记录\n\n本文件只记录旁路询问（临时提问）历史，与正式创作日志（run_log.jsonl）分开。\n");
  }
  blocks.push(formatLogEntry(record));
  await fs.appendFile(logPath, `${blocks.join("\n")}\n`, "utf8");
  return logPath;
}

function formatLogEntry(record) {
  const stamp = formatStamp(record.askedAt);
  const promoted = record.promotedToTask ? "是" : "否";
  const lines = [
    `## ${stamp}`,
    "",
    "用户问题：",
    record.question,
    "",
    "智能体回答：",
    record.answer,
    "",
    "是否转为正式任务：",
    promoted
  ];
  if (record.mainTaskAffecting) {
    lines.push("", "备注：", "该问题包含可能影响主线设定的修改建议，需用户确认后才会转为正式任务。");
  }
  if (record.modelError) {
    lines.push("", "模型调用降级：", `在线模型调用失败（${record.modelError}），已降级为离线分析回答。`);
  }
  lines.push("", "---");
  return lines.join("\n");
}

// 构造发给模型的消息：系统提示 + 上下文块 + 用户问题。
export function buildSideQuestionMessages(context, question, mainTaskAffecting) {
  const contextBlock = buildContextBlock(context);
  const guard = mainTaskAffecting
    ? "\n\n注意：用户的问题可能涉及修改主线设定或正文。请不要建议或执行直接改写，" +
      "只说明这样改的影响与权衡，并提醒用户这属于正式任务变更，需要确认后才执行。"
    : "";
  return [
    { role: "system", content: SIDE_QUESTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: `当前小说上下文（只读，供你分析，不要据此改写任何文件）：\n${contextBlock}${guard}\n\n用户的临时问题：\n${question}`
    }
  ];
}

function buildContextBlock(context) {
  const parts = [
    `小说名：${context.title}`,
    `故事设定：${context.storySeed || "（未填写）"}`,
    `Agent 当前状态：${context.agentPhase}`,
    `章节进度：第 ${context.currentChapterNo ?? "-"} 章（已完成 ${context.completedChapters}/${context.targetChapters} 章，累计约 ${context.totalWords} 字）`,
    `当前阶段：${context.currentStage ?? "-"}`
  ];
  if (context.bookSummary) {
    parts.push(`全书摘要：\n${context.bookSummary}`);
  }
  if (context.taskPlanExcerpt) {
    parts.push(`task_plan.md（摘录）：\n${context.taskPlanExcerpt}`);
  }
  if (context.progressExcerpt) {
    parts.push(`progress.md（摘录）：\n${context.progressExcerpt}`);
  }
  if (context.latestChapterExcerpt) {
    parts.push(`最近章节（第 ${context.latestChapterNo} 章）摘要：\n${context.latestChapterExcerpt}`);
  }
  if (context.recentInstructions?.length) {
    parts.push(`最近的写作指令：\n${context.recentInstructions.map((item) => `- ${item}`).join("\n")}`);
  }
  return parts.join("\n");
}

// 离线/mock 模式下，本地合成一个明确标注为「旁路分析」的回答，保证应用在没有真实模型时也可用。
function synthesizeOfflineAnswer(context, question, mainTaskAffecting) {
  const lines = [];
  lines.push("（旁路分析 · 离线模式回复，未配置在线模型，仅基于本地上下文给出状态说明）");
  lines.push("");
  lines.push(
    `当前《${context.title}》进度：第 ${context.currentChapterNo ?? "-"} 章，` +
      `阶段「${context.agentPhase}」，已完成 ${context.completedChapters}/${context.targetChapters} 章，累计约 ${context.totalWords} 字。`
  );
  if (context.storySeed) {
    lines.push(`故事设定：${truncate(context.storySeed, 120)}`);
  }
  if (mainTaskAffecting) {
    lines.push("");
    lines.push(
      "你的问题里包含可能改变主线设定或正文的诉求。旁路询问不会直接执行这类修改——" +
        "如果确实要改，请在回复里确认「转为正式任务」，应用才会把它作为正式写作指令处理。"
    );
  } else {
    lines.push("");
    lines.push(
      "若要得到针对该问题的深入分析（如人物动机、节奏、冲突、逻辑漏洞等），" +
        "请在设置中配置在线模型（DeepSeek / 小米 MiMo 等）后再次提问，旁路询问会调用模型只做分析、不改正文。"
    );
  }
  lines.push("");
  lines.push(`已记录你的问题：${truncate(question, 160)}`);
  return lines.join("\n");
}

function buildPromotionSuggestion(question) {
  return `这是会影响主线设定的修改建议：${truncate(question, 200)}。是否要将它加入正式写作任务？`;
}

function buildSideQuestionClient() {
  // 使用一次性的 CostTracker，避免把旁路询问的开销写入项目 cost.json。
  return new ModelClient({
    costTracker: new CostTracker(),
    adapters: {
      "openai-compatible": new OpenAICompatibleAdapter(),
      mock: new MockProviderAdapter({
        response: () => ({ text: "" })
      })
    }
  });
}

export function agentPhaseLabel(projectStatus, stage) {
  if (projectStatus === "completed") {
    return "已完成";
  }
  if (projectStatus === "blocked") {
    return "需处理";
  }
  if (projectStatus !== "running") {
    return "待命";
  }
  switch (stage) {
    case "queued":
    case "planning":
    case "planned":
      return "规划中";
    case "drafting":
    case "needs_revision":
    case "revising":
      return "写作中";
    case "reviewing":
      return "审稿中";
    case "finalizing":
    case "summarizing":
      return "保存中";
    default:
      return "运行中";
  }
}

async function readOptionalText(projectRoot, ...parts) {
  try {
    return await fs.readFile(safeJoin(projectRoot, ...parts), "utf8");
  } catch {
    // 旁路询问是只读分析，缺失或暂不可读的可选文件一律视为空内容，绝不因此报错或写入。
    return "";
  }
}

function excerpt(text, max) {
  const value = String(text ?? "").replace(/\r\n/gu, "\n").trim();
  if (!value) {
    return "";
  }
  return truncate(value, max);
}

function truncate(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function formatStamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
