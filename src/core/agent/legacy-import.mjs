// src/core/agent/legacy-import.mjs —— 一次性只读旧数据导入（统一 Agent 内核计划 Task 7 Step 4）。
//
// 唯一允许读取旧项目数据文件的生产模块（依赖规则测试 H 的白名单之一；Task 9 的
// 全库 rg 证明只允许本文件与 tests/agent/legacy-import.test.mjs 出现这些文件名）。
// 只在首次 open() 时执行（journal 初始化后、migration.json.legacy_imported 为 false）：
//
//   1. 只读旧文件（绝不双写、重命名或删除）：
//        agent_state.json / chat_history.jsonl / chat_transcript.jsonl /
//        chat_pending_action.json / task_queue.json / failures.jsonl
//   2. 导入可见历史（chat_history 优先、chat_transcript 兜底，按内容去重）
//      → transcript user/assistant 记录；每条带确定性的 legacy_id 幂等去重。
//   3. 导入有用未解决错误事实（无 resolution 的 failures 卡片 + 未清除的 pending
//      action）→ transcript note 记录（持久保留与审计；非合法模型消息链，不注入
//      模型上下文）。
//   4. 至多导入一个未完成 Run（旧状态 running/blocked/interrupted/paused 或任务
//      队列存在 active 任务时）：input_queued + run_started（run_started 带
//      payload.legacy: true 标记幂等）→ journal Run 状态；open() 按既有恢复语义
//      接续执行。
//   5. 把 durable blueprint_status 写入 project.yaml，顺序固定：旧状态显式
//      complete/none/partial → 用之；否则章节产物存在 → "legacy"；否则 "none"。
//      幂等：值相同不重写。
//   6. 原子性：journal 写入与 project.yaml 更新全部成功后才把
//      migration.json.legacy_imported 置 true；中途失败保持 false，下次 open()
//      重试——legacy_id / legacy 标记幂等保证重试不产生重复事件或消息。
//
// 本模块不依赖 agent 内部其他模块（无循环依赖）；由 runtime.mjs 的 open() 调用。
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadProject, saveProject, hasChapterArtifacts } from "../project-store.mjs";
import { pathExists, readJson, writeJsonAtomic } from "../fs-utils.mjs";

// 旧数据文件名（本文件是依赖规则白名单，允许出现字面量）。
const LEGACY_STATE_FILE = "agent_state.json";
const LEGACY_CHAT_HISTORY_FILE = "chat_history.jsonl";
const LEGACY_CHAT_TRANSCRIPT_FILE = "chat_transcript.jsonl";
const LEGACY_PENDING_ACTION_FILE = "chat_pending_action.json";
const LEGACY_TASK_QUEUE_FILE = "task_queue.json";
const LEGACY_FAILURES_FILE = "failures.jsonl";

const MIGRATION_DIR_REL = path.join(".wwriting", "agent");
const MIGRATION_FILE = "migration.json";

// blueprint_status 的显式合法值（旧世界持久字段）；其余值视为缺失。
const EXPLICIT_BLUEPRINT_STATUSES = new Set(["complete", "none", "partial"]);

// 旧项目状态中表示"未完成工作"的 project_status；任务队列 active 状态同样触发。
const UNFINISHED_STATE_STATUSES = new Set(["running", "blocked", "interrupted", "paused"]);
const ACTIVE_TASK_STATUSES = new Set(["running", "queued", "cancelling", "interrupted"]);

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

// 单个 transcript 记录的最大导入条数（防御异常巨大的旧文件）。
const MAX_IMPORT_RECORDS = 2000;

function defaultClock() {
  return new Date().toISOString();
}

// 逐行解析 JSONL（容忍损坏行，与旧 chat-store/failures-store 语义一致）。
async function readJsonl(target) {
  if (!(await pathExists(target))) return [];
  const raw = await fs.readFile(target, "utf8");
  const records = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // 损坏行跳过，不阻塞导入
    }
  }
  return records;
}

// 旧数据文件容错读取：缺失、0 字节或损坏 JSON 一律按 null 处理（与 readJsonl
// 容忍损坏行一致）——旧文件解析失败绝不阻塞一次性导入（migration.json 除外：
// 它由 journal 管理，损坏属于存储问题，应保留错误可见）。
async function readJsonTolerant(target) {
  try {
    return await readJson(target, null);
  } catch {
    return null;
  }
}

// 记录内容取值：content 优先，回落 text（旧 chat-agent 两种形状都写过）。
function contentOf(entry) {
  if (typeof entry?.content === "string") return entry.content;
  if (typeof entry?.text === "string") return entry.text;
  return null;
}

// 可见历史：chat_history 的 user/assistant 消息（UI 可见对话）优先；
// chat_transcript 只在 chat_history 缺失/为空时作为兜底来源（避免双份重复）。
// 所有记录带确定性 legacy_id（文件:序号），供幂等去重。
async function buildHistoryRecords(projectRoot) {
  const records = [];
  const history = await readJsonl(path.join(projectRoot, LEGACY_CHAT_HISTORY_FILE));
  const transcript = await readJsonl(path.join(projectRoot, LEGACY_CHAT_TRANSCRIPT_FILE));
  const source = history.some((entry) => entry?.role === "user" || entry?.role === "assistant")
    ? { entries: history, key: "chat_history" }
    : { entries: transcript, key: "chat_transcript" };
  const seen = new Set();
  for (let index = 0; index < source.entries.length && records.length < MAX_IMPORT_RECORDS; index += 1) {
    const entry = source.entries[index];
    const role = entry?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = contentOf(entry);
    if (content === null) continue;
    const dedupKey = `${role}\u0000${content}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    records.push({ role, content, legacy_id: `${source.key}:${index}`, legacy: true });
  }
  return records;
}

// 有用未解决错误事实：failures.jsonl 中无 resolution 的卡片 + 未清除的 pending
// action → transcript note 记录（持久保留，不注入模型上下文）。
async function buildErrorFactRecords(projectRoot) {
  const records = [];
  const cards = await readJsonl(path.join(projectRoot, LEGACY_FAILURES_FILE));
  for (let index = 0; index < cards.length && records.length < MAX_IMPORT_RECORDS; index += 1) {
    const card = cards[index];
    if (card?.resolution) continue; // 已解决的不导入
    const message = typeof card?.message === "string" && card.message.length > 0
      ? card.message
      : typeof card?.body === "string"
        ? card.body
        : null;
    if (!message) continue;
    records.push({
      role: "note",
      content: JSON.stringify({
        legacy_error: true,
        id: card?.id ?? null,
        type: card?.type ?? card?.kind ?? null,
        chapter_no: card?.chapter_no ?? null,
        message
      }),
      legacy_id: `failures:${index}`,
      legacy: true
    });
  }
  const pendingAction = await readJsonTolerant(path.join(projectRoot, LEGACY_PENDING_ACTION_FILE));
  if (pendingAction && typeof pendingAction === "object" && pendingAction.status !== "cleared") {
    records.push({
      role: "note",
      content: JSON.stringify({
        legacy_pending_action: true,
        id: pendingAction.id ?? null,
        tool: pendingAction.tool ?? null,
        status: pendingAction.status ?? "pending"
      }),
      legacy_id: "pending_action:0",
      legacy: true
    });
  }
  return records;
}

// blueprint_status 迁移（幂等：project.yaml 已是目标值时绝不重写）。
async function migrateBlueprintStatus(projectRoot, legacyState) {
  let status = legacyState?.blueprint_status;
  if (typeof status !== "string" || !EXPLICIT_BLUEPRINT_STATUSES.has(status)) {
    let artifacts = false;
    try {
      artifacts = await hasChapterArtifacts(projectRoot);
    } catch {
      // 章节证据读取失败（如损坏的章节索引）按"无产物"处理，不阻塞导入
      artifacts = false;
    }
    status = artifacts ? "legacy" : "none";
  }
  const project = await loadProject(projectRoot);
  if (project?.blueprint_status === status) {
    return { status, changed: false };
  }
  await saveProject(projectRoot, { ...project, blueprint_status: status });
  return { status, changed: true };
}

// 未完成判定：旧状态 project_status 命中未完成集合，或任务队列存在 active 任务。
function detectUnfinishedWork(legacyState, taskQueue) {
  const projectStatus = legacyState?.project_status;
  if (typeof projectStatus === "string" && UNFINISHED_STATE_STATUSES.has(projectStatus)) {
    return true;
  }
  const tasks = Array.isArray(taskQueue?.tasks) ? taskQueue.tasks : [];
  return tasks.some((task) => ACTIVE_TASK_STATUSES.has(task?.status));
}

// 为导入的 Run 挑选输入文本。导入的 Run 代表旧世界未完成的写作任务，优先恢复
// 任务指令（task_queue 中最近的 active 任务），其次最近用户聊天消息，最后兜底文案。
async function pickRunInputText(projectRoot, taskQueue) {
  const tasks = Array.isArray(taskQueue?.tasks) ? taskQueue.tasks : [];
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    const instruction = tasks[index]?.instruction;
    if (typeof instruction === "string" && instruction.trim() !== "") return instruction;
  }
  const history = await readJsonl(path.join(projectRoot, LEGACY_CHAT_HISTORY_FILE));
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.role !== "user") continue;
    const content = contentOf(entry);
    if (content !== null && content.trim() !== "") return content;
  }
  return "继续当前写作任务";
}

// 至多导入一个未完成 Run（幂等：journal 已有 legacy 标记的 run_started，
// 或已有活动 Run 时跳过）。
async function importUnfinishedRun({ projectRoot, journal, legacyState, taskQueue, idFactory }) {
  if (!detectUnfinishedWork(legacyState, taskQueue)) return null;
  // 幂等扫描：只回看最近 100k 条事件找 legacy 标记（与 runtime 的 findInputText
  // 上限语义一致）。上限之外的极端长日志中，legacy 标记必然已在首 100k 条内
  //（导入是首次 open 时最早的写入），因此扫描范围实际总是覆盖标记。
  const events = await journal.read({ afterSeq: 0, limit: 100000 });
  if (events.some((event) => event.type === "run_started" && event.payload?.legacy === true)) {
    return null; // 已导入（上次 open 中途失败后重试）
  }
  const session = await journal.getSession();
  const run = session?.active_run;
  if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
    return null; // 已有活动 Run（例如恢复的日志），不再导入
  }
  const inputId = idFactory();
  const runId = idFactory();
  const text = await pickRunInputText(projectRoot, taskQueue);
  await journal.appendBatch([
    {
      type: "input_queued",
      payload: { input_id: inputId, text, source: "maintenance" }
    },
    {
      type: "run_started",
      run_id: runId,
      payload: { workflow: "general", input_id: inputId, legacy: true }
    }
  ]);
  return { run_id: runId, input_id: inputId, text };
}

// 主入口。journal 必须已 load()（migration.json 等存储已就绪）。
// 返回 { imported, blueprint_status, run, skipped? }。
// 任何失败向上抛出；调用方（runtime.open）吞错后下次 open() 重试——幂等保证
// 重试不产生重复事件/消息。
export async function runLegacyImport({
  projectRoot,
  journal,
  idFactory = randomUUID,
  clock = defaultClock
} = {}) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error("runLegacyImport 需要 projectRoot");
  }
  const migrationPath = path.join(projectRoot, MIGRATION_DIR_REL, MIGRATION_FILE);
  const migration = await readJson(migrationPath, { schema_version: 1, legacy_imported: false });
  if (migration?.legacy_imported === true) {
    return { imported: false, blueprint_status: null, run: null };
  }

  const [legacyState, taskQueue] = await Promise.all([
    readJsonTolerant(path.join(projectRoot, LEGACY_STATE_FILE)),
    readJsonTolerant(path.join(projectRoot, LEGACY_TASK_QUEUE_FILE))
  ]);

  // 1) 项目元数据：blueprint_status 迁移（幂等）。
  const blueprint = await migrateBlueprintStatus(projectRoot, legacyState);

  // 2) transcript：可见历史 + 未解决错误事实（按 legacy_id 幂等去重）。
  const [historyRecords, errorFactRecords] = await Promise.all([
    buildHistoryRecords(projectRoot),
    buildErrorFactRecords(projectRoot)
  ]);
  const existing = await journal.readTranscript();
  const seen = new Set(
    existing.map((record) => record?.legacy_id).filter((id) => typeof id === "string")
  );
  for (const record of [...historyRecords, ...errorFactRecords]) {
    if (seen.has(record.legacy_id)) continue;
    await journal.appendTranscript(record);
  }

  // 3) journal：至多一个未完成 Run（幂等）。
  const run = await importUnfinishedRun({
    projectRoot,
    journal,
    legacyState,
    taskQueue,
    idFactory
  });

  // 4) journal 与 project.yaml 全部成功后，最后原子置位迁移标记。
  await writeJsonAtomic(migrationPath, {
    schema_version: 1,
    legacy_imported: true,
    imported_at: clock()
  });

  return {
    imported: true,
    blueprint_status: blueprint.status,
    blueprint_changed: blueprint.changed,
    run
  };
}
