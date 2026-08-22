// src/core/agent/journal.mjs
//
// 项目级 Agent journal（统一 Agent 内核计划 Task 2；Task 4 起物理层分段化）。
//
// journal 是 Agent 状态的唯一真相源（计划 Rule 9）：事件日志记录 Session/Run/
// queue/plan/decision/grant/activity 的全部事件；session.json 是可重建的 Session/Run
// projection；transcript 只保存合法模型消息链与历史摘要，不承担产品状态；
// migration.json 为 journal 级迁移状态文件（Task 13 起聊天迁移已删除，
// legacy_imported 恒为 false，仅作布局兼容保留）；checkpoints/ 为预留目录。
//
// 存储布局（agentDir = storageRoot，默认 <projectRoot>/.wwriting/agent/ 仅供低层
// 兼容测试；生产组合根必须显式传应用私有 storageRoot）：
//   segments/events/*.jsonl        —— canonical source（分段 JSONL，可轮转）
//   segments/transcript/*.jsonl    —— 模型消息链/历史摘要（同分段格式）
//   journal-manifest.json          —— 派生数据（generation/roots/last seqs/gaps）
//   session.json                   —— 可重建 projection（每次追加后原子重写）
//   migration.json                 —— { schema_version: 1, legacy_imported: false }
//   checkpoints/                   —— 预留目录
//
// 物理 I/O（追加/读取/轮转/索引）全部委托给 journal-segments.mjs 的
// segment store；本模块只保留 reducer、事件盖章、投影与恢复编排。事件 JSONL 是
// 真相；manifest 与 .index.json 都是可删除重建的派生数据。Task 13：旧单体
// events.jsonl/transcript.jsonl 到 segments 的自动聊天迁移已整体删除，新
// generation 只读取新格式（segments/）。
//
// 崩溃模型：appendBatch 先分配连续 seq、对克隆状态严格校验（dry-run，违规在落盘前
// 拒绝），再追加完整 JSON 行到 segment store，最后原子重写 session.json（临时文件 +
// rename，复用 fs-utils.writeJsonAtomic，Windows 兼容）。两步之间崩溃时 session.json
// 落后于事件日志，由下一次 load() 在同一把锁内重放 journal 并修复 projection。
// load() 还负责恢复：segment 中间损坏被隔离为 .corrupt（manifest 记录 gap，绝不
// 猜测跳过）；缺失尾部（不完整的最后一行 = 崩溃痕迹）截断修复；"dangling assistant
// 活动"（未闭合的 model turn / tool call）的 Run 不能恢复执行，恢复逻辑把其不可恢复
// grant 全部清除并把 Run 标记为 interrupted（对应事件 run_interrupted），绝不让这种
// 状态被交给 provider。存在中间 gap 时以有效的 session.json 为只读恢复锚点，清除
// active Run/queued inputs 并追加 journal_recovery_boundary（resume_allowed:false）。
//
// 投影写入语义：session.json 是可重建的尽力而为缓存，事件日志才是真相源。
// append/appendBatch 的 resolve 只与事件实际落盘绑定；session.json 原子重写失败
//（磁盘满/权限）不阻断追加也不抛错，失败信息通过 journal.projection_write_error
// 暴露，下一次 load() 会重放修复。append/appendBatch/load/getSession 返回的都是
// projection 的独立副本，调用方篡改返回值不会污染内部状态。
//
// 单实例硬契约：同一 projectRoot 在同一进程内只允许一个 journal 实例。每实例持有
// 一个进程内异步互斥锁，不同项目（不同实例）互不共享锁、可以并行（计划 Rule 3）；
// 但同项目多实例/跨进程并发写不受保护（无文件锁）。reducer 兜底校验事件
// session_id 与当前 Session 一致，跨 Session 事件混入同一日志流会被拒绝。
//
// 深模块内部实现：生产调用方只能经 src/core/agent/index.mjs 使用；tests/agent/ 可以
// 直接测试本模块内部 seam。
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, pathExists, readJson, writeJsonAtomic } from "../fs-utils.mjs";
import { createMutex } from "../async-utils.mjs";
import { createJournalSegmentStore } from "./journal-segments.mjs";
import { fail, defaultClock, defaultIdFactory, normalizeAt } from "./agent-utils.mjs";
// 截断辅助来自 tools/runtime-helpers.mjs（Task 6 拆出）：journal 不再读取
// tools/index.mjs 导出，两侧顶层互不读取对方导出的循环纪律保持。
import { MAX_TOOL_OUTPUT_CHARS, truncateOutput } from "./tools/runtime-helpers.mjs";
import {
  TERMINAL_RUN_STATUSES,
  COMPACTION_NON_TERMINAL_STATES,
  EVENT_SCHEMA_VERSION,
  createEmptySession,
  createSideState,
  reduceEvent
} from "./journal-handlers.mjs";
// 外部既有 import 路径保持（第十五轮 Task 4：tests/tools/index.mjs 与
// runtime.mjs 直连 ./journal.mjs 的具名导出，拆表后统一 re-export，调用方零改动）。
export {
  FIXED_EVENT_TYPES,
  SESSION_STATUSES,
  RUN_STATUSES,
  PLAN_STATUSES,
  buildProcessRestartedConvergence
} from "./journal-handlers.mjs";


// 压缩恢复尚未完成（Run 处于压缩收敛安全点，无 dangling assistant 活动）：
//   - 非终态压缩（started/running/cancelling）：压缩调用在途；
//   - 终态 failed/cancelled 但仍有 pending_input_id：崩溃窗口——failed/cancelled
//     事件已落盘而 Run/input 收敛（waiting_user / input_cancelled + run_cancelled）
//     尚未追加。这两种情况下 Run 都只可能在发送前预检安全点，不存在未闭合
//     model turn/tool call，保守中断不适用；收敛交给 runtime 的 open()。
function hasPendingCompactionRecovery(session) {
  const compaction = session?.compaction;
  if (compaction == null) return false;
  if (COMPACTION_NON_TERMINAL_STATES.has(compaction.state)) return true;
  if ((compaction.state === "failed" || compaction.state === "cancelled") && compaction.pending_input_id != null) {
    // 第十二轮 F3（审核修订 P1-2）：崩溃窗口 = failed/cancelled 已落盘而 Run/input
    // 收敛未落盘，窗口未收敛的判据是 run 仍 running。open() 把 run 收敛为
    // waiting_user / interrupted 后，恢复链必须重新可用——否则每个 load 重放都跳过
    // 锚定保守中断与 priority 恢复（永真锚定：前端项永久 running，detectDangling 永真）。
    if (session.active_run?.status === "running") return true;
  }
  return false;
}

// 进程内异步互斥锁：同一 journal 实例的所有操作（load/append/appendBatch/read/
// transcript）串行执行；不同实例各自持有独立锁，互不共享。
//（createMutex 实现在 src/core/async-utils.mjs，与 runtime/session-registry 共享）

// ---------------------------------------------------------------------------
// 持久 transcript 的工具结果形态（原 runtime.mjs persistentToolResult 逐字迁入，
// 第十五轮 Task 4；journal 是 transcript 记录 owner，剥离口径随工具结果收敛）：
// 大输出从持久记录剥离——read_file/read_skill 正文只留 content_length；
// shell stdout/stderr 只留长度与截断标记（与 tool_output_delta 同一
// truncateOutput 口径）；search_files matches 去掉 excerpt。二进制 asset
// 结果没有 content，原样保留元数据 + 绝对路径。
// ---------------------------------------------------------------------------
export function persistentToolResult(name, toolResult) {
  const persisted = structuredClone(toolResult);
  if (persisted?.ok && persisted.result && name === "read_file") {
    const content = String(persisted.result.content ?? "");
    delete persisted.result.content;
    persisted.result.content_length = content.length;
  }
  if (persisted?.ok && persisted.result && name === "read_skill" && typeof persisted.result.content === "string") {
    // read_skill 正文不进持久 transcript（与 read_file 同口径：只留长度）；
    // 二进制 asset 结果没有 content，原样保留元数据 + 绝对路径。
    persisted.result.content_length = persisted.result.content.length;
    delete persisted.result.content;
  }
  if (persisted?.ok && persisted.result && name === "shell") {
    // R5-15：终态与 tool_output_delta 共用同一截断口径（工具侧已带元数据，
    // 这里按同一 helper 重算，保证持久 transcript 与 audit 事件一致）。
    // content_length 与 truncated 都基于同一拼接串，避免边界 off-by-one。
    const stdout = String(persisted.result.stdout ?? "");
    const stderr = String(persisted.result.stderr ?? "");
    const combined = `${stdout}${stderr}`;
    const { truncated } = truncateOutput(combined, MAX_TOOL_OUTPUT_CHARS);
    persisted.result.content_length = combined.length;
    persisted.result.truncated = truncated;
  }
  if (persisted?.ok && persisted.result && name === "search_files" && Array.isArray(persisted.result.matches)) {
    persisted.result.matches = persisted.result.matches.map(({ excerpt: _excerpt, ...match }) => match);
  }
  return persisted;
}

// ---------------------------------------------------------------------------
// createAgentJournal：journal 实例工厂
//
// 单实例硬契约：同一 projectRoot 在同一进程内只允许一个 journal 实例（见文件头）。
// 进程重启（跨进程）恢复通过新实例 load() 完成——旧实例已退出，不存在并发写。
// ---------------------------------------------------------------------------
export function createAgentJournal({
  projectRoot,
  storageRoot = path.join(path.resolve(projectRoot), ".wwriting", "agent"),
  clock = defaultClock,
  idFactory = defaultIdFactory,
  // 新会话（空 journal）的首次 session_created 用此 id 作为内部 session_id——
  // 使 journal 内部 session_id 与注册表 id（外部书签）对齐。缺省为 null：
  // 由 createFirstSession 用 idFactory() 自造（旧测试契约 id-1/id-2）。
  // 只对「空 journal 的首次创建」生效；已有事件的 journal 永不消费该值，
  // 其 session_id 来自事件流本身。不要把 idFactory 包装成「首次调用返回
  // 外部 id」的闭包——那会在 journal 实例重建（重启/重新物化）后的第一个
  // 常规 append 上重复盖同一个 event_id=外部 id，造成跨实例 event_id 重复，
  // 使 journal 无法重放（见 runtime.mjs ensureSessionState）。
  initialSessionId = null,
  // 会话目录轮转的"额外文件"钩子（Task 9：clearHistory 把整个旧会话收进
  // cleared-history）。journal 是轮转事务的协调者，但只负责自己的文件
  //（segments/session.json/manifest）；checkpoint store 等其它文件的所有者经
  // 这两个钩子自行退休/恢复——journal 不硬编码它们的文件名。缺省无钩子（底层
  // 直用 journal 的测试/场景没有这些文件）。
  retireExtraFiles = null,
  restoreExtraFiles = null,
  // transcript 落盘前的文本脱敏（原 runtime.mjs redactTranscriptRecord 由
  // createRedactor 注入，第十五轮 Task 4 收编）：appendSafeTranscript 对 record
  // 做 JSON.stringify → redactText → JSON.parse 后落盘，防 API key/模型密钥/
  // provider header 泄漏进持久 transcript。缺省原样落盘（低层直用 journal 的
  // 测试/场景没有 secrets）。exportHistory 的 redact 由调用方按 record 形状
  // 注入，两个入口互不影响。
  redactText = null
} = {}) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    fail("projectRoot 必须是项目根目录");
  }
  const root = path.resolve(projectRoot);
  const agentDir = path.resolve(storageRoot);
  const sessionPath = path.join(agentDir, "session.json");
  const migrationPath = path.join(agentDir, "migration.json");
  const checkpointsDir = path.join(agentDir, "checkpoints");
  // 物理 I/O 全部委托给 segment store（Task 4）；manifest 为两个 stream 共享
  const manifestPath = path.join(agentDir, "journal-manifest.json");
  const eventsStore = createJournalSegmentStore({
    root: path.join(agentDir, "segments", "events"),
    streamName: "events",
    manifestPath
  });
  const transcriptStore = createJournalSegmentStore({
    root: path.join(agentDir, "segments", "transcript"),
    streamName: "transcript",
    manifestPath
  });
  const mutex = createMutex();
  // store 层 load/重建的 AbortSignal（Task 5 clear-history 等会在需要时中止后台任务；
  // 本任务只负责把信号接进 store，保证重建可中断）。clearHistory 会中止并重建该信号。
  let loadSignal = new AbortController();
  // 最近一次 store.load（background 模式）启动的后台索引重建 promise；
  // clearHistory 先中止信号再等待它收尾（当前默认 inline 模式，防御性保留）。
  let backgroundRebuild = null;

  let loaded = false;
  let state = null; // reduceEvents 的结果：{ session, openToolCalls, ... }
  let projectionWriteError = null; // 最近一次 session.json 写入失败（尽力而为语义）

  // load() 必须惰性创建 agentDir（storageRoot）、checkpoints/ 与 migration.json。
  // 新格式 journal 从不创建单体 events.jsonl/transcript.jsonl（Task 13：旧单体
  // 到 segments 的自动聊天迁移已删除，新 generation 只读新格式）。
  async function ensureStorage() {
    await ensureDir(agentDir);
    await ensureDir(checkpointsDir);
    if (!(await pathExists(migrationPath))) {
      await writeJsonAtomic(migrationPath, { schema_version: 1, legacy_imported: false });
    }
  }

  // 读取 session.json 恢复锚点；不可读/形状非法返回 null（走全量重放）。
  async function readSessionAnchor() {
    try {
      if (!(await pathExists(sessionPath))) return null;
      const parsed = JSON.parse(await fs.readFile(sessionPath, "utf8"));
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) return null;
      if (!Number.isInteger(parsed.last_seq) || parsed.last_seq < 0) return null;
      return { projection: parsed, session_id: parsed.session_id, last_seq: parsed.last_seq };
    } catch {
      return null;
    }
  }

  // 锚点有效性：session_id 与日志首事件一致、last_seq 不超过日志末尾、且日志确实
  // 存在 seq == last_seq 的事件（"last_seq 对应事件 id"校验）。
  async function isAnchorValid(anchor) {
    if (!anchor) return false;
    const first = (await eventsStore.readAfter({ afterSeq: 0, limit: 1 })).events[0];
    if (!first || first.session_id !== anchor.session_id) return false;
    if (anchor.last_seq > eventsStore.lastSeq) return false;
    if (anchor.last_seq > 0) {
      const at = (await eventsStore.readAfter({ afterSeq: anchor.last_seq - 1, limit: 1 })).events[0];
      if (!at || at.seq !== anchor.last_seq) return false;
    }
    return true;
  }

  // 空 journal 的第一次锁定 load：在锁内发明 Session id 并追加 session_created。
  // 新建 generation 必须先写 manifest（store.load 已创建）再写第一条 session_created。
  // session_id 优先用 initialSessionId（外部注册表 id 对齐契约）；事件自身的
  // event_id 永远走普通 idFactory——绝不把外部 id 复用为 event_id。
  async function createFirstSession(side) {
    const sessionId = initialSessionId ?? idFactory(); // 契约：Session id 先于 event_id 生成（旧测试断言 id-1）
    const first = {
      schema_version: 1,
      seq: 1,
      event_id: idFactory(),
      session_id: sessionId,
      run_id: null,
      project_root: root,
      type: "session_created",
      at: normalizeAt(clock()),
      payload: {}
    };
    await eventsStore.append([first]);
    return reduceEvent(null, first, side);
  }

  // 旧 session.json 锚点（Task 6 之前生成）缺少 Task 6 新增的投影字段：
  // 归一化默认值，保证任何重放路径产出的 projection 都携带完整契约形状。
  function normalizeSessionDefaults(session) {
    if (session && session.priority_input_id === undefined) session.priority_input_id = null;
    return session;
  }

  // 常规恢复：锚点有效时只重放 last_seq 之后的事件（避免百万事件全量重放）；
  // 否则流式全量重放（单次只保留当前行与 reducer state，不整日志读入内存）。
  async function buildState(anchor) {
    if (anchor && (await isAnchorValid(anchor))) {
      try {
        const { events } = await eventsStore.readAfter({ afterSeq: anchor.last_seq, limit: null });
        const session = normalizeSessionDefaults(structuredClone(anchor.projection));
        const side = createSideState();
        for (const event of events) {
          session = reduceEvent(session, event, side);
        }
        return { state: { session, ...side }, anchored: true };
      } catch (error) {
        if (error?.code === "SEGMENT_GAP") throw error; // 坏段：由上层走缺口恢复
        // 锚点尾重放失败（如跨锚点的 turn/tool 闭合事件引用锚点前的 side 状态）：
        // 回退全量重放——side 状态完整，可正确处理闭合，不误报损坏。
      }
    }
    let session = null;
    const side = createSideState();
    for await (const event of eventsStore.streamAll()) {
      session = reduceEvent(session, event, side);
    }
    if (session === null) {
      session = await createFirstSession(side);
    }
    return { state: { session: normalizeSessionDefaults(session), ...side }, anchored: false };
  }

  // 中间坏段（gap）恢复：不能全量重放（reducer 不能猜测跳过缺口）。
  // session.json 有效且未标记 needs_history_clear → 以它为只读恢复锚点，投影标记
  // history_degraded，健康尾部事件仍重放（重放失败只保留锚点投影本身）；随后由
  // appendGapRecovery 追加收敛事件与边界。锚点也无效/需清空 → 只读打开健康历史
  //（标记 needs_history_clear，等 Task 5 清空；绝不追加恢复事件，不在缺失状态上
  // 猜测 tool/decision 是否打开）。
  async function degradedState(anchor) {
    const side = createSideState();
    const gapRecords = (eventsStore.gaps ?? []).map((gap) => ({
      start_seq: gap?.start_seq ?? null,
      end_seq: gap?.end_seq ?? null,
      reason: gap?.reason ?? null
    }));
    if (anchor && !anchor.projection.needs_history_clear && (await isAnchorValid(anchor))) {
      const session = normalizeSessionDefaults(structuredClone(anchor.projection));
      session.history_degraded = true;
      session.history_gaps = gapRecords;
      try {
        const { events } = await eventsStore.readAfter({ afterSeq: anchor.last_seq, limit: null });
        for (const event of events) {
          session = reduceEvent(session, event, side);
        }
      } catch {
        // 健康尾部事件无法在缺口锚点上重放（如引用了缺口内创建的活动）：
        // 只保留锚点投影本身（健康历史仍可经 API 只读访问）
      }
      return { session, ...side };
    }
    let first = null;
    try {
      first = (await eventsStore.readAfter({ afterSeq: 0, limit: 1 })).events[0];
    } catch {
      first = null;
    }
    const session = createEmptySession({
      sessionId: first?.session_id ?? idFactory(),
      projectRoot: root,
      at: normalizeAt(clock())
    });
    session.history_degraded = true;
    session.history_gaps = gapRecords;
    session.needs_history_clear = true;
    return { session, ...side };
  }

  // 缺口之后是否已存在 journal_recovery_boundary（恢复已完成 → 幂等跳过）。
  async function hasRecoveryBoundaryAfter(afterSeq) {
    const { events } = await eventsStore.readAfter({ afterSeq, limit: null });
    return events.some((event) => event.type === "journal_recovery_boundary");
  }

  // gap 恢复事件：先取消活动输入与排队输入（活动输入必须在 run_interrupted 之前
  // 收敛），再标记旧 Run interrupted，最后追加 journal_recovery_boundary
  //（携带 gap 范围与 resume_allowed:false）。
  // 为什么保留 input_cancelled（Task 26 语义收窄）：历史缺口强制恢复是运行级丢弃
  //（旧 Run 的飞行中输入无法继续），input_interrupted 需安全边界且只接受活动输入
  //（排队输入无法用它终结）、input_withdrawn 仅限用户主动撤回；与 stop/压缩取消
  // 路径同理由（见 runtime.cancelRunForStop / convergeCompactionCancelled）。
  async function appendGapRecovery(gaps) {    const batch = [];
    const run = state.session.active_run;
    if (run?.active_input_id != null) {
      batch.push({ type: "input_cancelled", run_id: run.id, payload: { input_id: run.active_input_id } });
    }
    for (const item of state.session.queued_inputs) {
      batch.push({ type: "input_cancelled", run_id: run?.id ?? null, payload: { input_id: item.id } });
    }
    if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
      batch.push({ type: "run_interrupted", run_id: run.id, payload: { reason: "recovery_history_gap" } });
    }
    const gap = gaps[0];
    batch.push({
      type: "journal_recovery_boundary",
      payload: {
        gap_start: gap?.start_seq ?? null,
        gap_end: gap?.end_seq ?? null,
        reason: gap?.reason ?? "segment_corrupt",
        resume_allowed: false
      }
    });
    if (batch.length > 0) await appendBatchLocked(batch);
  }

  // dangling assistant 恢复批次：清空不可恢复 grant、闭合遗留 decision、标记
  // run_interrupted（全量重放检测到 dangling 与锚定重放保守中断共用）。
  function buildDanglingRecoveryBatch() {
    const run = state.session.active_run;
    if (!run) return [];
    const recoveryBatch = [];
    // 第十二轮 F2：恢复批次必须闭合孤儿活动，否则前端项永久 running、
    // detectDangling 永真（每次 load 重复追补）。与 buildPriorityRecoveryBatch
    // 同形状（state.openToolCalls 值是 { seq, activity_id, name }）。
    for (const [toolCallId, meta] of state.openToolCalls) {
      recoveryBatch.push({
        type: "tool_call_failed",
        run_id: run.id,
        payload: {
          tool_call_id: toolCallId,
          activity_id: meta.activity_id ?? null,           // 规格 F2：前端按此匹配工具行
          name: meta.name ?? "unknown",                    // 规格 F2：前端 label 依据
          message: "进程崩溃恢复：该工具调用未完成（已按失败闭合）", // 规格 F2：可见文案
          error: { code: "recovered_dangling_orphan" }
        }
      });
    }
    for (const [turnId] of state.openModelTurns) {
      // 地雷防御（第十二轮顺手修补，review 遗留）：reducer 对 model_turn_completed
      // 的 input_id 是 requireString（见上），active_input_id 为 null（理论退化——
      // 现代 producer 下开放 turn 必有归属输入，仅 input_interrupted 后崩溃的
      // 遗留日志可构造）时不能填 null/undefined（dry-run 拒绝、整个 load 抛错）；
      // 跳过闭合让 run_interrupted 收敛即可。残余 open turn 的归宿分路径：锚定
      // 路径被清扫（下次 load 以锚点投影 + 空 side 开始，残余不复存在）；全量
      // 重放路径残余会被完整重建，但 run 已遭终结（interrupted），detectDangling
      // 对终态 Run 短路，恢复链不再触发——无害。
      // 与 priority 侧策略互通（review Minor-3，改一侧必须知会另一侧）：那边给
      // input_id 回退（active_input_id ?? priorityId，见 buildPriorityRecoveryBatch）
      // 故补闭合而非跳过——两侧都只为防 requireString 抛错，一侧留残余、一侧给回退。
      if (run.active_input_id == null) continue;
      recoveryBatch.push({
        type: "model_turn_completed",
        run_id: run.id,
        payload: { turn_id: turnId, input_id: run.active_input_id, outcome: "failed" }
      });
    }
    for (const grant of run.active_grants ?? []) {
      recoveryBatch.push({
        type: "permission_grant_cleared",
        run_id: run.id,
        payload: { input_id: grant.input_id, grant_key: grant.grant_key, grant_id: grant.id }
      });
    }
    for (const decisionId of state.openDecisions.keys()) {
      recoveryBatch.push({
        type: "decision_resolved",
        run_id: run.id,
        payload: { decision_id: decisionId, choice: "cancelled", reason: "recovery_dangling_decision" }
      });
    }
    recoveryBatch.push({
      type: "run_interrupted",
      run_id: run.id,
      payload: { reason: "recovery_dangling_assistant_activity" }
    });
    return recoveryBatch;
  }

  // Task 6：优先输入恢复批次（SPEC 3.3 rule 10）。priority_input_id pending 且
  // 全量重放（side 状态完整、无真实飞行操作）时用一个 appendBatch 收敛：
  //   1. 先闭合孤儿 model turn / tool call 为恢复错误（tool_call_failed /
  //      model_turn_completed(failed)），不重放已完成副作用；
  //   2. 清除不可恢复 grant、闭合遗留 decision（与 dangling 恢复一致）；
  //   3. 若旧输入仍活动，追加 input_interrupted(reason:"recovered_priority")；
  //   4. 追加 input_started(priorityId)（匹配 priority 时 reducer 自动清空
  //      priority_input_id）。
  // 队列相对顺序不变：只移除被 started 的优先输入，其余排队项原位保留。
  // 返回空数组表示无需恢复（无 Run/已终结/priority 已落地/优先输入已活动等）。
  function buildPriorityRecoveryBatch() {
    const run = state.session.active_run;
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return [];
    const priorityId = state.session.priority_input_id;
    if (priorityId == null) return [];
    if (run.active_input_id === priorityId) return []; // 已是活动输入，无需收敛
    if (!state.session.queued_inputs.some((item) => item.id === priorityId)) return [];
    const batch = [];
    // 第十二轮 F2：与 buildDanglingRecoveryBatch 同形补 activity_id/name/message
    //（state.openToolCalls 值是 { seq, activity_id, name }）。
    for (const [toolCallId, meta] of state.openToolCalls) {
      batch.push({
        type: "tool_call_failed",
        run_id: run.id,
        payload: {
          tool_call_id: toolCallId,
          activity_id: meta.activity_id ?? null,
          name: meta.name ?? "unknown",
          message: "进程崩溃恢复：该工具调用未完成（已按失败闭合）",
          error: { code: "recovered_priority_orphan" }
        }
      });
    }
    for (const [turnId] of state.openModelTurns) {
      // 与 buildDanglingRecoveryBatch 的「跳过闭合」互通（review Minor-3）：本侧
      // 总有 input_id 回退（active_input_id ?? priorityId）故补闭合而非跳过；两者
      // 都是防 reducer requireString 抛错，改一侧必须知会另一侧。
      batch.push({
        type: "model_turn_completed",
        run_id: run.id,
        payload: { turn_id: turnId, input_id: run.active_input_id ?? priorityId, outcome: "failed" }
      });
    }
    for (const grant of run.active_grants ?? []) {
      batch.push({
        type: "permission_grant_cleared",
        run_id: run.id,
        payload: { input_id: grant.input_id, grant_key: grant.grant_key, grant_id: grant.id }
      });
    }
    for (const decisionId of state.openDecisions.keys()) {
      batch.push({
        type: "decision_resolved",
        run_id: run.id,
        payload: { decision_id: decisionId, choice: "cancelled", reason: "recovery_dangling_decision" }
      });
    }
    if (run.active_input_id != null) {
      batch.push({
        type: "input_interrupted",
        run_id: run.id,
        payload: { input_id: run.active_input_id, reason: "recovered_priority" }
      });
    }
    batch.push({ type: "input_started", run_id: run.id, payload: { input_id: priorityId } });
    return batch;
  }

  // 必须在 mutex 内调用。首次 load：创建存储布局 → 按恢复策略建立 projection →
  // 追加恢复事件 → 写出第一份 session.json。
  async function initialize() {
    if (loaded) return;
    await ensureStorage();
    const eventsInfo = await eventsStore.load({ signal: loadSignal.signal });
    const transcriptInfo = await transcriptStore.load({ signal: loadSignal.signal });
    backgroundRebuild = eventsInfo.rebuilding ?? transcriptInfo.rebuilding ?? null;
    const gaps = eventsStore.gaps;
    const anchor = await readSessionAnchor();
    if (gaps.length > 0) {
      state = await degradedState(anchor);
      // 幂等 + 只读语义：needs-clear（锚点无效）不追加任何恢复事件；缺口之后已存在
      // journal_recovery_boundary（恢复已完成）时不重复追加。
      const lastGapEnd = gaps.reduce((max, gap) => Math.max(max, gap.end_seq ?? 0), 0);
      if (!state.session.needs_history_clear && !(await hasRecoveryBoundaryAfter(lastGapEnd))) {
        await appendGapRecovery(gaps);
      }
    } else {
      let built;
      try {
        built = await buildState(anchor);
      } catch (error) {
        if (error?.code !== "SEGMENT_GAP") throw error;
        // I3：索引有效但内容位腐的 sealed 段在重放读路径被懒隔离——load 扫描
        // 不覆盖它（索引可读），只能在这里转缺口恢复打开。绝不因单个坏段让
        // 工作区打开失败（规格 §2：中间分段损坏不得使整个工作区无法打开）。
        const freshGaps = eventsStore.gaps;
        state = await degradedState(anchor);
        const lastGapEnd = freshGaps.reduce((max, gap) => Math.max(max, gap.end_seq ?? 0), 0);
        if (!state.session.needs_history_clear && !(await hasRecoveryBoundaryAfter(lastGapEnd))) {
          await appendGapRecovery(freshGaps);
        }
        await writeSessionJson();
        loaded = true;
        return;
      }
      state = built.state;
      const anchored = built.anchored;
      const dangling = detectDangling(state);
      // Task 6：优先输入恢复优先于普通 dangling 收敛。仅在全量重放路径（side 状态
      // 完整、可验证无真实飞行操作）收敛；锚定重放无法重建锚点前的开放活动，
      // 保守中断仍由下面分支负责。压缩恢复尚未完成的 Run 不在此收敛（由 runtime
      // 的 open() 按收敛矩阵处理）。
      // 空批次（优先输入已撤回/已活动等）绝不短路恢复链：继续回落 dangling/保守
      // 恢复——否则孤儿 model turn / tool call 的 Run 会被留在 running，违反
      // "dangling assistant 活动的 Run 不能恢复执行"的崩溃模型不变量。
      const priorityBatch =
        state.session.priority_input_id != null &&
        !anchored &&
        !hasPendingCompactionRecovery(state.session)
          ? buildPriorityRecoveryBatch()
          : [];
      if (priorityBatch.length > 0) {
        await appendBatchLocked(priorityBatch);
      } else if (anchored && state.session.active_run && !TERMINAL_RUN_STATUSES.has(state.session.active_run.status)) {
        // 锚定重放无法重建锚点前的 side 状态（open tool/turn/decision 未知）：
        // 保守地把非终结 Run 标记 interrupted——绝不能把无法验证的 dangling
        // assistant 状态交给 provider（干净关闭中途的 Run 同样走此恢复）。
        // Task 8：压缩恢复尚未完成的 Run 处于发送前预检安全点——没有未闭合
        // model turn/tool call，保守中断不适用；由 runtime 的 open() 按收敛矩阵
        // 把 Run 收敛为 waiting_user（绝不自动调用普通模型）。覆盖压缩在途
        //（非终态）与 failed/cancelled 事件已落盘但 Run/input 收敛未落盘的崩溃窗口。
        if (!hasPendingCompactionRecovery(state.session)) {
          await appendBatchLocked(buildDanglingRecoveryBatch());
        }
      } else if (dangling && !hasPendingCompactionRecovery(state.session)) {
        // 第十二轮 F3：与上面锚定分支同口径——压缩恢复尚未完成的 Run 不在此
        // 收敛（全量重放路径同样由 runtime 的 open() 按收敛矩阵处理）。防御口径：
        // 现代 producer 的 failed/cancelled 窗口只可能处于发送前预检安全点，不存在
        // 未闭合 model turn/tool call（断言见 hasPendingCompactionRecovery :142-147）；
        // 本守卫仅为手搓/遗留日志兜底——若窗口内真的残留孤儿，闭合会让 run 先于
        // open() 收敛被中断（F3 重放用例断言「窗口内不闭合孤儿」即此口径）。open()
        // 把 run 收敛为 waiting_user 后恢复链重开，下一次 load 正常闭合。
        await appendBatchLocked(buildDanglingRecoveryBatch());
      }
    }
    await writeSessionJson();
    loaded = true;
  }

  // 由 journal 统一盖章：seq/event_id/at/session_id/project_root/schema_version。
  // 调用方传入的 at 同样归一化为 ISO-8601；event_id 唯一性由 reducer 校验
  //（side.eventIds 全量去重，覆盖调用方传入与 idFactory 生成两种来源）。
  function stampEvent(base, seq) {
    if (base == null || typeof base !== "object") fail("事件必须是对象");
    if (typeof base.type !== "string") fail("事件必须携带 type");
    return {
      schema_version: EVENT_SCHEMA_VERSION,
      seq,
      event_id: base.event_id ?? idFactory(),
      session_id: state.session.session_id,
      run_id: base.run_id ?? null,
      project_root: root,
      type: base.type,
      at: normalizeAt(base.at ?? clock()),
      payload: base.payload ?? {}
    };
  }

  function cloneSide(side) {
    return {
      eventIds: new Set(side.eventIds),
      // 浅拷贝安全性（与下方 openModelTurns 深拷贝对称）：openToolCalls 的值对象
      // { seq, activity_id, name } 当前没有 mutation 路径——reducer 只整体替换
      //（set/delete），dry-run 克隆上不会被原地改写；若未来恢复批次改写 meta
      //（如补 activity_id）必须改为深拷贝，避免被拒批次的 mutation 泄漏。
      openToolCalls: new Map(side.openToolCalls),
      // Task 6 回归：值对象必须深拷贝。dry-run 克隆上 reasoning_completed 会原地
      // 改写 meta.reasoningCompleted；若共享引用，被拒批次的 mutation 会泄漏到真实
      // 状态，导致后续合法 reasoning_completed 被误拒（"journal 不被污染"保证）。
      openModelTurns: new Map([...side.openModelTurns].map(([turnId, meta]) => [turnId, { ...meta }])),
      legacyOpenTurns: [...side.legacyOpenTurns],
      openDecisions: new Map(side.openDecisions),
      terminalInputs: new Set(side.terminalInputs),
      // 同上：inputMeta 的 item 对象独立拷贝，消除同类泄漏（reducer 会改写
      // meta.status 等字段）
      inputMeta: new Map([...side.inputMeta].map(([inputId, item]) => [inputId, { ...item }]))
    };
  }

  function cloneState(current) {
    return { session: structuredClone(current.session), ...cloneSide(current) };
  }

  // dangling assistant 活动：非终结 Run 上存在未闭合 model turn（v2 按 turn_id、
  // v1 按 legacy 栈）或 tool call。
  function detectDangling(current) {
    const run = current.session.active_run;
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return null;
    if (current.openModelTurns.size > 0 || current.legacyOpenTurns.length > 0 || current.openToolCalls.size > 0) {
      return run;
    }
    return null;
  }

  // 尽力而为的投影写入：session.json 可重建（事件日志才是真相源），写入失败
  //（磁盘满/权限）不阻断 append、不抛错——通过 journal.projection_write_error 暴露
  // 给观察者，下一次 load() 会重放修复。append 的 resolve/reject 只与事件日志的
  // 实际落盘绑定，与投影写入成功与否无关。
  async function writeSessionJson() {
    try {
      await writeJsonAtomic(sessionPath, state.session);
      projectionWriteError = null;
    } catch (error) {
      projectionWriteError = {
        at: normalizeAt(clock()),
        message: error?.message ?? String(error),
        code: error?.code ?? null
      };
    }
  }

  // 必须在 mutex 内调用。顺序：分配连续 seq → 对克隆状态严格 dry-run（任何不变量
  // 违规在落盘前拒绝，journal 不被污染）→ 追加完整 JSON 行到 segment store →
  // 提交状态 → 原子重写 session.json。
  async function appendBatchLocked(batch) {
    if (state == null) fail("journal 尚未初始化");
    if (!Array.isArray(batch)) fail("appendBatch 需要事件数组");
    if (batch.length === 0) return state.session;
    const stamped = [];
    // 正常路径 session.last_seq === store 尾部；缺口恢复路径锚点可能落后于 store
    // 尾部（或空投影 last_seq=0）——必须以 store 实际尾部续号，否则 store 的连续
    // 性校验会拒绝恢复批次。
    let seq = Math.max(state.session.last_seq, eventsStore.lastSeq);
    for (const base of batch) {
      seq += 1;
      stamped.push(stampEvent(base, seq));
    }
    const nextState = cloneState(state);
    for (const event of stamped) {
      nextState.session = reduceEvent(nextState.session, event, nextState);
    }
    await eventsStore.append(stamped);
    state = nextState;
    await writeSessionJson();
    return state.session;
  }

  // 恢复 journal：创建目录、重放事件、修复 projection、处理 dangling 恢复。
  // 返回当前 Session projection。
  async function load() {
    return mutex.run(async () => {
      await initialize();
      return structuredClone(state.session);
    });
  }

  // migration 标记：journal 级一次性迁移状态（migration.json 位于应用私有
  // agentDir，绝不落在项目目录）。Task 13 起旧聊天迁移已删除，legacy_imported
  // 恒为 false（标记文件保留：既有的低层测试与旧布局兼容性依赖其存在）。
  async function readMigration() {
    await initialize();
    return readJson(migrationPath, { schema_version: 1, legacy_imported: false });
  }

  async function writeMigration(value) {
    await writeJsonAtomic(migrationPath, value);
  }

  // 追加单条事件（自动初始化，分配下一个连续 seq，重写 session.json）。
  // 返回 projection 的独立副本：调用方篡改返回值不会污染内部状态。
  async function append(event) {
    return mutex.run(async () => {
      await initialize();
      const session = await appendBatchLocked([event]);
      return structuredClone(session);
    });
  }

  // 追加一批事件：分配连续 seq，同一批次原子生效（如优先安全点切换的
  // input_interrupted + input_started 原子批次）。返回 projection 的独立副本。
  async function appendBatch(events) {
    return mutex.run(async () => {
      await initialize();
      const session = await appendBatchLocked(events);
      return structuredClone(session);
    });
  }

  // 返回当前 Session projection（只读副本）。
  async function getSession() {
    return mutex.run(async () => {
      await initialize();
      return structuredClone(state.session);
    });
  }

  // I3：读路径 SEGMENT_GAP 重试。索引有效但内容位腐的 sealed 段在首次读取时被懒
  // 隔离（.corrupt + manifest gap），读取抛 SEGMENT_GAP；隔离完成后重试一次即得到
  // 健康事件 + gaps 元数据——运行期读取"返回缺口"而非把原始损坏错误抛给上层。
  // 重试仍失败（连续多个坏段）则继续传播，由调用方按缺口恢复处理。
  async function withSegmentGapRetry(task) {
    try {
      return await task();
    } catch (error) {
      if (error?.code !== "SEGMENT_GAP") throw error;
      return task();
    }
  }

  // 原始事件读取（seq > afterSeq，最多 limit 条，默认全部）。委托 segment store。
  // 不触发初始化/恢复——那些只由 load() 负责（Task 6 的 open() 会先调用 load()）；
  // 消费者应在首次 read 前调用 load()，否则拿到的可能是未迁移/未修复的原始内容。
  async function read({ afterSeq = 0, limit } = {}) {
    return mutex.run(async () => {
      const { events } = await withSegmentGapRetry(() => eventsStore.readAfter({ afterSeq, limit }));
      return events;
    });
  }

  // 尾部分页/倒序读取（Task 5 分页 API 的物理基础；Task 4 提供委托）。
  async function readTail({ limit } = {}) {
    return mutex.run(async () => {
      await initialize();
      return withSegmentGapRetry(() => eventsStore.readTail({ limit }));
    });
  }

  async function readBefore({ beforeSeq, limit } = {}) {
    return mutex.run(async () => {
      await initialize();
      return withSegmentGapRetry(() => eventsStore.readBefore({ beforeSeq, limit }));
    });
  }

  async function readAfter({ afterSeq = 0, limit } = {}) {
    return mutex.run(async () => {
      await initialize();
      return withSegmentGapRetry(() => eventsStore.readAfter({ afterSeq, limit }));
    });
  }

  // 落盘脱敏（原 runtime.mjs redactTranscriptRecord 逐字迁入，第十五轮 Task 4）：
  // transcript 与 Session projection 无关，但持久记录必须过脱敏（防 API key/
  // 模型密钥/provider header 泄漏）；文本变换/解析失败回退占位记录。
  const safeTranscriptText = redactText ?? ((json) => json);
  function redactTranscriptRecord(record) {
    try {
      return JSON.parse(safeTranscriptText(JSON.stringify(record)));
    } catch {
      return { role: record?.role ?? "note", content: "[REDACTED]" };
    }
  }

  // 追加脱敏 transcript（原 runtime.mjs appendSafeTranscript 逐字迁入，收编为
  // 工厂方法）：redact + 盖章 + 落盘一次完成，调用方不再自行处理脱敏。
  async function appendSafeTranscript(record) {
    await appendTranscript(redactTranscriptRecord(record));
  }

  // transcript 与 Session projection 无关：只追加合法模型消息链与历史摘要。
  // 每条新 record 由 Journal 盖 transcript_seq（store 用它排序/分页）。
  async function appendTranscript(record) {
    return mutex.run(async () => {
      if (record == null || typeof record !== "object" || Array.isArray(record)) {
        fail("transcript record 必须是对象");
      }
      await initialize();
      const stamped = { ...record, transcript_seq: transcriptStore.lastSeq + 1 };
      await transcriptStore.append([stamped]);
    });
  }

  async function readTranscript() {
    return mutex.run(async () => {
      await initialize();
      const { events } = await withSegmentGapRetry(() => transcriptStore.readAfter({ afterSeq: 0 }));
      return events;
    });
  }

  // 分页读取（runtime 后续切换，不再全量读单文件）。
  async function readTranscriptAfter({ afterSeq = 0, limit } = {}) {
    return mutex.run(async () => {
      await initialize();
      const { events } = await withSegmentGapRetry(() => transcriptStore.readAfter({ afterSeq, limit }));
      return events;
    });
  }

  async function readTranscriptTail({ limit } = {}) {
    return mutex.run(async () => {
      await initialize();
      const { events } = await withSegmentGapRetry(() => transcriptStore.readTail({ limit }));
      return events;
    });
  }

  // -------------------------------------------------------------------------
  // Task 5：历史导出（只读）与不可逆清空（generation 轮转）
  // -------------------------------------------------------------------------

  // manifest 的当前 generation_id 以文件为准：events/transcript 两流共享同一
  // manifest，任一流轮转都会改写文件，但各自的内存 manifest 可能滞后（轮转后
  // 另一流的 updateManifest 只刷新自己的副本）。读取失败回落内存值。
  async function readCurrentGenerationId() {
    try {
      const raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      return typeof raw?.generation_id === "string" && raw.generation_id.length > 0
        ? raw.generation_id
        : null;
    } catch {
      return eventsStore.manifest?.generation_id ?? null;
    }
  }

  // 顺序流式导出 events + transcript 两个 store，加上各自的 gap 范围行。
  // 只读动作：不调用 initialize()（那会追加 session_created/恢复事件），只确保
  // store 已加载（store.load 只扫描/建索引，不追加 Journal 事件）。每行形状
  // { stream: "event"|"transcript"|"gap", record }；gap 行只保留损坏范围
  // （start_seq/end_seq/reason），绝不复制被隔离的坏段文件原文。redact 由调用方
  // （runtime 持有 redactor）注入，对每条 record 做脱敏（防 API key/模型密钥/
  // provider header 泄漏）。
  async function* exportHistory({ redact = null } = {}) {
    if (!eventsStore.loaded) await eventsStore.load();
    if (!transcriptStore.loaded) await transcriptStore.load();
    const sanitize = redact ?? ((record) => record);
    try {
      for await (const record of eventsStore.streamAll()) {
        yield { stream: "event", record: sanitize(record) };
      }
    } catch (error) {
      if (error?.code !== "SEGMENT_GAP") throw error;
      // I3：坏段在导出中途被懒隔离——跳过该段继续导出健康段（gap 行单独报告）
    }
    for (const gap of eventsStore.gaps) {
      yield {
        stream: "gap",
        record: { stream: "events", start_seq: gap.start_seq, end_seq: gap.end_seq, reason: gap.reason }
      };
    }
    try {
      for await (const record of transcriptStore.streamAll()) {
        yield { stream: "transcript", record: sanitize(record) };
      }
    } catch (error) {
      if (error?.code !== "SEGMENT_GAP") throw error;
      // I3：同上——坏段在导出中途被懒隔离，跳过继续
    }
    for (const gap of transcriptStore.gaps) {
      yield {
        stream: "gap",
        record: { stream: "transcript", start_seq: gap.start_seq, end_seq: gap.end_seq, reason: gap.reason }
      };
    }
  }

  // 不可逆清空：只允许 session idle 且 confirmIrreversible === true，且必须在
  // 本实例 mutex 内执行（与 append/load 串行）。顺序：中止并等待后台索引重建 →
  // 把两个 store 的旧 segments 轮转到 cleared-history/<timestamp>/（manifest 记录
  // 旧 generation）→ 移走旧 session.json / active-context.json / context
  // checkpoints/ → 写 clear-manifest.json → 清空本实例 loaded/state/
  // projectionWriteError → 用新 generation 重新初始化（追加新 session_created）。
  // 绝不触碰项目根下的章节/总纲/设定/WWRITING.md/正式 checkpoint（那些在项目根，
  // 不在 agentDir 内）。
  // I2：清空中途失败回滚。把已轮转/已移走的目录与文件移回原位，恢复 manifest 的
  // generation 记录（startGeneration 已把 store 内存重置为空 generation，restoreGeneration
  // 负责移回目录 + 重载旧数据），并移除本次写入的 clear-manifest。journal 的会话投影
  // 自始至终未变（旧 session），恢复后 append/read 立即回到原状；loadSignal 未被 abort
  //（abort 已推迟到轮转成功之后），仍可用。回滚自身尽力而为，不掩盖原始失败。
  async function rollbackAfterFailedClear({ moved, clearedDir, oldGenerationId, extraMoved = [] }) {
    for (const streamName of ["events", "transcript"]) {
      const store = streamName === "events" ? eventsStore : transcriptStore;
      await store.restoreGeneration({ fromDir: clearedDir, generationId: oldGenerationId }).catch(() => {});
    }
    // journal 自有文件移回（其余由 restoreExtraFiles 交给文件所有者处理）
    if (moved.includes("session.json")) {
      try {
        await fs.rename(path.join(clearedDir, "session.json"), sessionPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.warn(`[journal] 清空回滚：无法把 session.json 移回：${error?.message ?? String(error)}`);
        }
      }
    }
    if (restoreExtraFiles && extraMoved.length > 0) {
      await restoreExtraFiles(extraMoved, clearedDir).catch((error) => {
        console.warn(`[journal] 清空回滚：额外文件恢复失败: ${error?.message ?? String(error)}`);
      });
    }
    await fs.rm(path.join(clearedDir, "clear-manifest.json"), { force: true }).catch(() => {});
  }

  async function clearHistory({ confirmIrreversible = false } = {}) {
    return mutex.run(async () => {
      await initialize();
      const current = state.session;
      // busy 校验先于确认校验（brief Step 1：活动 Run 未确认也返回 history_busy）。
      const busy = current.active_run && !TERMINAL_RUN_STATUSES.has(current.active_run.status);
      if (busy) {
        const error = new Error("Agent 正在运行，无法清空历史。");
        error.code = "history_busy";
        throw error;
      }
      if (confirmIrreversible !== true) {
        const error = new Error("清空历史不可逆，必须显式确认。");
        error.code = "confirmation_required";
        throw error;
      }
      // 1. 准备 cleared-history/<timestamp>/
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const clearedDir = path.join(agentDir, "cleared-history", timestamp);
      await ensureDir(clearedDir);
      // 2. 在实例 mutex 内轮转两个 store：旧 segments 移入 clearedDir，manifest
      //    记录旧 generation 的位置与可读范围。双流共享 manifest，必须固定同一
      //    oldGenerationId（以 manifest 文件为准），否则第二次轮转的 in-memory
      //    manifest 会拿到第一次轮转刚写入的新 generation id。
      //    I2 修复：两次轮转 + 文件移走 + clear-manifest 写入整体包在 try/catch 里。
      //    任一步失败都回滚（目录/文件移回、manifest 与 store 内存状态恢复），
      //    journal 保持原会话可用——绝不留"events 已轮转成空 generation 而
      //    transcript/会话仍是旧数据"的半清空现场（那会让 append 全部 seq 缺口拒绝）。
      const oldGenerationId = (await readCurrentGenerationId()) ?? eventsStore.manifest?.generation_id ?? null;
      const journalMoved = [];
      let extraMoved = [];
      try {
        await eventsStore.startGeneration({ historyDir: clearedDir, reason: "user_clear", oldGenerationId });
        await transcriptStore.startGeneration({ historyDir: clearedDir, reason: "user_clear", oldGenerationId });
        // 3. 移走旧 session.json（journal 自有）；checkpoint store 等其它文件所有者
        //    经 retireExtraFiles 退休自己的文件（active-context.json/checkpoints/）。
        //    全部移走条目合并进 clear-manifest，供回滚与人工恢复。
        if (await pathExists(sessionPath)) {
          await fs.rename(sessionPath, path.join(clearedDir, "session.json"));
          journalMoved.push("session.json");
        }
        if (retireExtraFiles) {
          extraMoved = await retireExtraFiles(clearedDir);
        }
        const moved = [...journalMoved, ...extraMoved];
        // 4. 写 clear-manifest.json（不可逆操作的落盘记录）
        await writeJsonAtomic(path.join(clearedDir, "clear-manifest.json"), {
          schema_version: 1,
          cleared_at: new Date().toISOString(),
          reason: "user_clear",
          old_session_id: current.session_id,
          old_generation_id: oldGenerationId,
          moved,
          cleared_dir: clearedDir
        });
      } catch (error) {
        await rollbackAfterFailedClear({ moved: journalMoved, clearedDir, oldGenerationId, extraMoved });
        throw error;
      }
      // 5. 停止并等待后台索引重建（I2 修复：轮转完成后再中止——inline 模式无后台
      //    任务；一旦中止发生在轮转失败前，失败路径会留下永久 aborted 的 controller，
      //    后续 store.load 全程短读。轮转成功后再 abort，失败路径的 loadSignal 保持可用）。
      loadSignal.abort();
      await backgroundRebuild?.catch(() => {});
      backgroundRebuild = null;
      // 6. 清空本实例状态并创建新 generation + session_created（复用同一实例的
      //    后续 snapshot/append 立即看到新 session，绝不留旧 runtime state）
      loaded = false;
      state = null;
      projectionWriteError = null;
      loadSignal = new AbortController();
      await initialize();
      return {
        session_id: state.session.session_id,
        status: state.session.status,
        generation_id: (await readCurrentGenerationId()) ?? eventsStore.manifest?.generation_id ?? null,
        old_session_id: current.session_id,
        cleared_dir: clearedDir
      };
    });
  }

  // -------------------------------------------------------------------------
  // Task 3（第十五轮）：投影查询方法（F2）。四条全量扫描查询从 runtime.mjs
  // 逐字迁入——只在停止/重试/压缩边界触发（非每 token 热路径），不做投影索引。
  // -------------------------------------------------------------------------

  // 该输入当前是否尚无终态事件（需要追加 input_completed）。逆序扫描最近
  // 100k 条事件（原 runtime.mjs needsCompletionTerminal 主体逐字迁入）：
  // 命中 input_consumed/cancelled/completed/interrupted/withdrawn 返回 false
  //（该输入已有终态事件）；命中 input_promoted/run_started/input_started 返回
  // true；超出上限视为需要收敛（保守方向）。
  async function hasTerminalEvent(runId, inputId) {
    const events = await read({ afterSeq: 0, limit: 100000 });
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.run_id !== runId || event.payload?.input_id !== inputId) continue;
      if (
        event.type === "input_consumed" ||
        event.type === "input_cancelled" ||
        event.type === "input_completed" ||
        event.type === "input_interrupted" ||
        event.type === "input_withdrawn"
      ) {
        return false; // 该输入已有终态事件（legacy consumed 或任意新终态）
      }
      if (event.type === "input_promoted" || event.type === "run_started" || event.type === "input_started") return true;
    }
    return true;
  }

  // 从 journal 事件找回输入元数据（text + kind）。逆序扫描最近 100k 条事件
  //（原 runtime.mjs findInputMeta 主体逐字迁入）：命中 input_queued 且
  // input_id 匹配即返回；超出上限视为找不到（返回 text: null）。
  async function findInputMeta(inputId) {
    const events = await read({ afterSeq: 0, limit: 100000 });
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type === "input_queued" && event.payload?.input_id === inputId) {
        return {
          text: typeof event.payload.text === "string" ? event.payload.text : null,
          kind: event.payload.kind === "compact" ? "compact" : null
        };
      }
    }
    return { text: null, kind: null };
  }

  // 该 Run 是否为 /compact 输入而创建（空闲发起）还是运行中排队（in-run）。
  // 决定手动压缩失败/取消后的收敛：in-run 恢复 resume_run_status("running")，
  // 空闲发起则 run_cancelled → idle。
  // Task 9：新生命周期下 run_started 不再携带 input_id，改为以该 Run 的第一条
  // input_started 判定（空闲发起 = Run 首个被激活输入就是 compact item）；legacy
  // 日志（retry 的 run_started 仍带 input_id）保留原判定分支。
  async function isIdleInitiatedRun(runId, compactInputId) {
    const events = await read({ afterSeq: 0, limit: 100000 });
    for (const event of events) {
      if (event.type === "input_started" && event.run_id === runId) {
        return event.payload?.input_id === compactInputId;
      }
    }
    for (const event of events) {
      if (event.type !== "run_started" || event.run_id !== runId) continue;
      return event.payload?.input_id === compactInputId;
    }
    return true;
  }

  // 从 journal 事件找回可恢复 Run 的未终结输入（run_failed 记录了 input_id；
  // 崩溃恢复的 run_interrupted 没有，则退回 run_started/input_promoted 的信息）。
  async function findTerminalInputId(runId) {
    const events = await read({ afterSeq: 0, limit: 100000 });
    const runEvents = events.filter((event) => event.run_id === runId);
    for (let i = runEvents.length - 1; i >= 0; i -= 1) {
      const event = runEvents[i];
      if (event.type === "run_failed" || event.type === "run_interrupted") {
        if (typeof event.payload?.input_id === "string" && event.payload.input_id.length > 0) {
          return event.payload.input_id;
        }
        break;
      }
      if (event.type === "input_promoted" && typeof event.payload?.input_id === "string") {
        return event.payload.input_id;
      }
      if (event.type === "input_started" && typeof event.payload?.input_id === "string") {
        return event.payload.input_id;
      }
      if (event.type === "run_started" && typeof event.payload?.input_id === "string") {
        return event.payload.input_id;
      }
    }
    // 兜底：崩溃现场尚未终结的 input（事件里存在 input_queued 且无终态事件）。
    // Task 9：终态集合同时接纳新生命周期事件（input_completed/input_interrupted/
    // input_withdrawn）与 legacy（input_consumed/input_cancelled）。
    const terminal = new Set(
      runEvents
        .filter((event) =>
          [
            "input_consumed",
            "input_cancelled",
            "input_completed",
            "input_interrupted",
            "input_withdrawn"
          ].includes(event.type)
        )
        .map((event) => event.payload?.input_id)
    );
    const openInputs = runEvents
      .filter((event) => event.type === "input_queued" && !terminal.has(event.payload?.input_id))
      .map((event) => event.payload?.input_id);
    return openInputs.length > 0 ? openInputs[openInputs.length - 1] : null;
  }

  const journal = {
    load,
    readMigration,
    writeMigration,
    append,
    appendBatch,
    read,
    readTail,
    readBefore,
    readAfter,
    getSession,
    hasTerminalEvent,
    findInputMeta,
    isIdleInitiatedRun,
    findTerminalInputId,
    appendTranscript,
    appendSafeTranscript,
    readTranscript,
    readTranscriptAfter,
    readTranscriptTail,
    exportHistory,
    clearHistory
  };
  // 可观察字段：最近一次 session.json 写入失败（尽力而为语义），成功写入后为 null。
  Object.defineProperty(journal, "projection_write_error", {
    enumerable: true,
    get: () => projectionWriteError
  });
  // 可观察字段：journal 恢复发现的中间缺口（只读；Task 5 分页/清理使用）。
  Object.defineProperty(journal, "gaps", {
    enumerable: true,
    get: () => eventsStore.gaps
  });
  // 可观察字段：events 流的最后一个已落盘 seq（snapshot 计算 has_more 用）。
  Object.defineProperty(journal, "lastSeq", {
    enumerable: true,
    get: () => eventsStore.lastSeq
  });
  // 可观察字段：transcript 流的最后一个已落盘 seq（Task 8 预检门禁据此判断
  // transcript 是否已超出无 checkpoint 时的 in-context 尾部页，防止高轮次/低 token
  // 会话绕过估算门禁导致最旧记录被静默排除）。
  Object.defineProperty(journal, "transcriptLastSeq", {
    enumerable: true,
    get: () => transcriptStore.lastSeq
  });
  return journal;
}
