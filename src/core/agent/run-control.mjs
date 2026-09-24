// src/core/agent/run-control.mjs —— Run 命令面（提交/优先/撤回/决策/停止/重试）
//（第二十轮 Task 18 字节红线收口，从 runtime.mjs 机械迁出，不改逻辑）。
//
// 迁出成员（一一对应「对 Run 的命令面」）：SOURCES、assertNoOtherSessionRunning、
// abortController、submit、requestPriority、withdrawInput、decide、stop、retry、
// retryCompaction、cancelCompaction。它们的固有形态一致（入参校验 → ensureProject
// → resolveSessionState → journal.load() → state.mutex.run(读-判-写)
// → syncSessionRegistry），与 runtime 保留的「项目/会话物化 + 数据面
//（open/snapshot/projectBusy/exportHistory/clearHistory）」是两个职责不同的面。
//
// 依赖形态（与 createRunLifecycle/createRunPipeline/createSessionManager 同款
// createXxx(ctx) 模式，经 ctx 解构函数引用）：
//   - ctx 的 6 个键全部是 runtime.mjs 既有闭包引用：ensureProject / resolveSessionId /
//     ensureSessionState / resolveSessionState / sessionManager / idFactory；
//   - 模块级常量/纯依赖（TERMINAL_RUN_STATUSES / COMPACTION_SEND_BLOCKED_STATES /
//     codedError as fail / deriveSessionTitle / hasNonTerminalRun）本模块直接持有
//     或 import。单源纪律：TERMINAL_RUN_STATUSES 从 journal.mjs import，不复制。
//
// 承重不变量：本模块无独立磁盘写入——状态要么在 journal 事件投影（真相源），要么
// 经 state.mutex 临界区内读-判-写；abortController 只作用于项目级 state.controller
//（循环安全点路径取同一把 state.mutex，锁内等待会死锁，故 abort/等待一律在锁外）。
// 对外签名与错误 code 与迁出前逐字一致。
import { TERMINAL_RUN_STATUSES } from "./journal.mjs";
import { COMPACTION_SEND_BLOCKED_STATES } from "./compaction.mjs";
import { codedError as fail } from "./agent-utils.mjs";
import { deriveSessionTitle, hasNonTerminalRun } from "./session-manager.mjs";

// 输入来源白名单（仅用于审计来源标注）：随 submit 迁出（唯一消费方）。
const SOURCES = new Set(["chat", "maintenance"]);

export function createRunControl(ctx) {
  const {
    ensureProject,
    resolveSessionId,
    ensureSessionState,
    resolveSessionState,
    sessionManager,
    idFactory
  } = ctx;

  // 项目串行门（C4 第二十轮审计收敛）：目标会话之外若有任一会话存在非终态 run
  // → project_busy。submit 原内联 blockers 逻辑提取而来，retry/retryCompaction
  // 复用同一判定——否则另一会话运行中的 retry 会直达 startLoop，后者无条件覆写
  // 项目级 controller（run-lifecycle startLoop），用户 stop A 实际 abort B。
  // excludeSessionId == null 时所有已物化会话都算"其他会话"（惰性创建路径）。
  async function assertNoOtherSessionRunning(state, excludeSessionId) {
    const blockers = await Promise.all(
      [...state.sessions]
        .filter(([sid]) => excludeSessionId == null || sid !== excludeSessionId)
        .map(async ([, other]) => other.journal.getSession())
    );
    if (blockers.some(hasNonTerminalRun)) {
      throw fail("project_busy", "另一个对话正在运行，请稍候。");
    }
  }

  function abortController(state) {
    try {
      state.controller?.abort();
    } catch {
      // 已终止的 controller 忽略
    }
  }

  async function submit({ projectRoot, text, source = "chat", sessionId = null }) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      throw fail("empty_input", "text 必须是非空字符串。");
    }
    if (!SOURCES.has(source)) {
      throw fail("invalid_source", `source 只允许 ${[...SOURCES].join("/")}，仅用于审计来源。`);
    }
    const state = ensureProject(projectRoot);
    // Task 8：只把精确的 text === "/compact" 识别为 kind:"compact"；"/compact now"
    // 等其余文本都是普通输入。
    const kind = text === "/compact" ? "compact" : undefined;
    // 互斥锁内只做会话解析、串行门、读-判-写与循环启动；waitForFirstTurn 必须在
    // 锁外等待（循环的安全点路径 cancelRunForStop/advanceOrComplete 需要取同一把
    // 锁，锁内等待会死锁）。sessionState 提升到函数级：锁外
    // lifecycle.waitForFirstTurn 需要持锁内物化的会话状态。
    let sessionState = null;
    const created = await state.mutex.run(async () => {
      // 1) 会话解析：显式 sessionId → 校验存在；缺省 → 最近活跃；都没有 → 惰性
      //    创建新会话（registry.create + journal 首次 load 写 session_created）。
      let targetId = await resolveSessionId(state, sessionId);
      // 2) 串行门：目标会话之外若有任一会话存在非终态 run → project_busy。
      //    惰性创建路径（targetId == null）下，所有已物化会话都算"其他会话"；
      //    目标会话尚未物化、不可能有 run。门禁在创建/恢复之前执行，被拒的提交
      //    不产生任何会话副作用。同会话运行中走下方 FIFO 队列（行为不变）。
      await assertNoOtherSessionRunning(state, targetId);
      // 3) 惰性创建（缺省且无会话）
      if (targetId == null) {
        const meta = await state.registry.create({ title: deriveSessionTitle(text) });
        targetId = meta.session_id;
      }
      sessionState = await ensureSessionState(state, targetId);
      // 4) 恢复可恢复 Run（等价旧 submit → open() 的启动恢复）：非终态且未被压缩
      //    阻塞 → 接续执行（新输入在下方 FIFO 排队在其后）。串行门已保证没有
      //    其他会话的飞行循环，此处启动是安全的。
      const session = await sessionState.journal.getSession();
      const run = session.active_run;
      const compactionBlocked =
        session.compaction != null && COMPACTION_SEND_BLOCKED_STATES.includes(session.compaction.state);
      // whfind-bugs #5：压缩 failed 态循环不会复活（下方守卫跳过重启），仅当
      // Run 仍非终态（waiting_user）时排队输入没有消费者、返回 queued:true 是
      // 谎言——诚实拒绝。Run 已终态（退出/取消后）时走下方空闲分支新建 Run
      //（startLoop 无条件），有真实消费者，不拦。UI composer 在这些状态本就
      // 禁用发送，只影响直连 API 客户端；running/cancelling 等活跃态不拦
      // （循环存活，压缩完成后继续消费队列）。
      if (run && !TERMINAL_RUN_STATUSES.has(run.status) && session.compaction?.state === "failed") {
        throw fail("compaction_failed_blocked", "上下文压缩失败：请先重试或取消压缩，再发送新消息。");
      }
      if (run && !TERMINAL_RUN_STATUSES.has(run.status) && !compactionBlocked) {
        sessionState.lifecycle.startLoop(run.id);
      }
      // 5) 现有 FIFO / 新 Run 逻辑（作用于目标会话的 journal）
      const inputId = idFactory();
      let result;
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
        // 空闲：创建新 Run。同一批次原子写入 run_started + input_queued +
        // input_started（Task 9 新生命周期：run_started 不再携带 input_id，由
        // input_started 激活；三者同批保证「每条输入一个终态」与队列/活动投影一致）。
        const runId = idFactory();
        await sessionState.journal.appendBatch([
          {
            type: "run_started",
            run_id: runId,
            payload: {}
          },
          {
            type: "input_queued",
            payload: { input_id: inputId, text, source, ...(kind === undefined ? {} : { kind }) }
          },
          {
            type: "input_started",
            run_id: runId,
            payload: { input_id: inputId }
          }
        ]);
        sessionState.lifecycle.startLoop(runId);
        result = { input_id: inputId, run_id: runId, queued: false, session_id: targetId };
      } else {
        // 运行中：FIFO 队列（/compact 不打断当前模型/工具，按普通消息排队）
        await sessionState.journal.append({
          type: "input_queued",
          payload: { input_id: inputId, text, source, ...(kind === undefined ? {} : { kind }) }
        });
        result = { input_id: inputId, run_id: run.id, queued: true, session_id: targetId };
      }
      // 注册表同步（调用方可等待的边界；updated_at 刷新）+ 自动命名：显式创建
      // （"新对话"默认标题）的会话按首条消息摘要命名
      await sessionManager.syncSessionRegistry(state, sessionState);
      await sessionManager.autoNameSessionIfDefault(state, targetId, text);
      return result;
    });
    if (!created.queued) {
      // 等待第一个模型轮次开始（或循环已结束）：保证调用方拿到控制权时
      // 「立即」/「停止」有飞行中的活动可打断（输入落盘仍先于 resolve）
      await sessionState.lifecycle.waitForFirstTurn();
    }
    return created;
  }

  // 请求优先（Task 9，SPEC 3.3 rule 10）：同一 session 项目互斥锁内做
  // getSession -> validate -> appendBatch。只接受排队输入且当前无优先请求：
  //   - 非排队输入 → input_not_queued（reducer 还有第二道守卫）；
  //   - 已有优先输入在途 → priority_pending（在途输入撤回或开始后才可再请求）。
  // 本任务只追加 priority_input_requested（priority_input_id 投影 + 前端按钮态）；
  // 安全点切换逻辑（打断活动输入、优先消费）由 Task 10 实现。
  // Task 26：旧 promote 方法（interrupt_requested + input_promoted 立即打断、被打断
  // 输入回队重跑）已整体退役——前端「立即」= requestPriority，规格 3.3 明确「不取消
  // 当前模型请求、A 不回队不重跑」，一条用户动作一条权威路径。
  async function requestPriority({ projectRoot, inputId, sessionId = null }) {
    if (typeof inputId !== "string" || inputId.length === 0) {
      throw fail("invalid_input_id", "inputId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("input_not_queued", "该输入不在排队队列中。");
    await sessionState.journal.load();
    return state.mutex.run(async () => {
      const session = await sessionState.journal.getSession();
      const run = session.active_run;
      if (!session.queued_inputs.some((item) => item.id === inputId)) {
        throw fail("input_not_queued", "该输入不在排队队列中。");
      }
      if (session.priority_input_id != null) {
        throw fail("priority_pending", "已有优先输入在途，请等待当前优先输入开始或撤回。");
      }
      await sessionState.journal.append({
        type: "priority_input_requested",
        run_id: run?.id ?? null,
        payload: { input_id: inputId }
      });
      await sessionManager.syncSessionRegistry(state, sessionState);
      return {
        session_id: sessionState.sessionId,
        run_id: run?.id ?? null,
        input_id: inputId,
        priority_pending: true
      };
    });
  }

  // 撤回排队输入（Task 9，SPEC 3.2）：同一 session 项目互斥锁内读-判-写。只接受
  // 排队输入——活动输入只能 completed/interrupted（不产生"撤销"语义）；input_started
  // 已落盘的输入同样拒绝（撤回先于开始才生效）。追加 input_withdrawn（invisible
  // journal 事件：投影移除排队项、清空匹配的 priority_input_id），返回事件中的
  // 原始文本（draft_text）供 UI 恢复输入框。
  async function withdrawInput({ projectRoot, inputId, sessionId = null }) {
    if (typeof inputId !== "string" || inputId.length === 0) {
      throw fail("invalid_input_id", "inputId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("input_not_queued", "该输入不在排队队列中。");
    await sessionState.journal.load();
    return state.mutex.run(async () => {
      const session = await sessionState.journal.getSession();
      const run = session.active_run;
      const item = session.queued_inputs.find((queued) => queued.id === inputId);
      if (!item) {
        throw fail("input_not_queued", "该输入不在排队队列中。");
      }
      await sessionState.journal.append({
        type: "input_withdrawn",
        run_id: run?.id ?? null,
        payload: { input_id: inputId }
      });
      await sessionManager.syncSessionRegistry(state, sessionState);
      return {
        session_id: sessionState.sessionId,
        run_id: run?.id ?? null,
        input_id: inputId,
        withdrawn: true,
        draft_text: typeof item.text === "string" ? item.text : ""
      };
    });
  }

  async function decide({ projectRoot, decisionId, choice, sessionId = null }) {
    if (typeof decisionId !== "string" || decisionId.length === 0) {
      throw fail("invalid_decision_id", "decisionId 必须是非空字符串。");
    }
    if (typeof choice !== "string" || choice.length === 0) {
      throw fail("invalid_choice", "choice 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("decision_not_found", "决策不存在或已过期。");
    await sessionState.journal.load();
    return sessionState.tools.resolveDecision({ decisionId, choice, confirmationText: choice });
  }

  // 停止（Task 9）：runId 可选。显式 runId 时在项目互斥锁内重读并精确匹配活动
  // Run（不匹配/无活动 Run → run_not_found，HTTP 层不再用快照预校验——消除 B15
  // TOCTOU：调用顺序由持久事件顺序唯一决定）；缺省 runId 保留旧语义（停止当前
  // 会话的活动 Run，无 Run 时安全无操作）。
  async function stop({ projectRoot, runId = null, reason = "user_stop", sessionId = null }) {
    if (runId != null && (typeof runId !== "string" || runId.length === 0)) {
      throw fail("invalid_run_id", "runId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    // 会话解析 + 读-判-写放进项目互斥锁，与 requestPriority 的临界区串行化：调用
    // 顺序决定胜负——stop 先落盘时其 input_cancelled 把优先输入移出队列，后到的
    // requestPriority 以 input_not_queued 拒绝（新测试「stop 与 requestPriority
    // 并发」钉住同一竞态）；requestPriority 先落盘时 stop 的取消批次清空匹配的
    // priority_input_id（reducer 的 input_cancelled 分支），不留卡死指针。
    const outcome = await state.mutex.run(async () => {
      const sessionState = await resolveSessionState(state, sessionId);
      if (!sessionState) {
        // 没有会话：显式 runId 必须报 not_found；缺省 = 旧语义安全无操作
        if (runId != null) throw fail("run_not_found", `Run ${runId} 不是当前会话的活动 Run。`);
        return { run_id: null, cancelled: false, sessionState: null };
      }
      await sessionState.journal.load();
      const session = await sessionState.journal.getSession();
      const run = session.active_run;
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
        if (runId != null) throw fail("run_not_found", `Run ${runId} 不是当前会话的活动 Run。`);
        return { run_id: null, cancelled: false, sessionState }; // 没有可停止的 Run：无操作
      }
      if (runId != null && run.id !== runId) {
        throw fail("run_not_found", `Run ${runId} 不是当前会话的活动 Run。`);
      }
      if (run.status === "stopping") {
        return { run_id: run.id, cancelled: true, sessionState, alreadyStopping: true };
      }
      try {
        await sessionState.journal.append({
          type: "run_status_changed",
          run_id: run.id,
          payload: { status: "stopping", reason }
        });
      } catch (error) {
        // 竞态：Run 恰在此时终结，停止自然失效（reducer 拒绝终结状态上的
        // run_status_changed）；真实 journal 错误由外层 .catch abort + 上抛。
        const message = error?.message ?? "";
        if (message.includes("需要活动 Run") || message.includes("必须携带 retry") || message.includes("不能再次进入")) {
          if (runId != null) throw fail("run_not_found", `Run ${runId} 不是当前会话的活动 Run。`);
          return { run_id: run.id, cancelled: false, sessionState };
        }
        throw error;
      }
      state.stopReason = reason;
      return { run_id: run.id, cancelled: true, sessionState };
    }).catch((error) => {
      // mutex.run 内已对可识别竞态返回；这里的 reject 是真实 journal 错误
      abortController(state);
      throw error;
    });
    // 锁外：abort + 等待收敛（循环的安全点路径 cancelRunForStop 需要取同一把锁，
    // 锁内等待会死锁）
    if (!outcome.cancelled) {
      return { session_id: outcome.sessionState?.sessionId ?? null, run_id: outcome.run_id ?? null, cancelled: false };
    }
    const { sessionState } = outcome;
    if (outcome.alreadyStopping) {
      await sessionState.lifecycle.waitForIdle();
      return { session_id: sessionState.sessionId, run_id: outcome.run_id, cancelled: true };
    }
    abortController(state);
    await sessionState.lifecycle.waitForIdle();
    await sessionManager.syncSessionRegistry(state, sessionState);
    return { session_id: sessionState.sessionId, run_id: outcome.run_id, cancelled: true };
  }

  async function retry({ projectRoot, runId, sessionId = null }) {
    if (typeof runId !== "string" || runId.length === 0) {
      throw fail("invalid_run_id", "runId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("run_not_found", "没有可恢复的 Run。");
    await sessionState.journal.load();
    return state.mutex.run(async () => {
      const session = await sessionState.journal.getSession();
      const run = session.active_run;
      if (!run) throw fail("run_not_found", "没有可恢复的 Run。");
      if (run.id !== runId) throw fail("run_not_found", `Run ${runId} 不是当前会话的 Run。`);
      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
        throw fail("run_not_recoverable", `Run 处于 ${run.status}，无需重试。`);
      }
      if (run.status !== "failed" && run.status !== "interrupted") {
        throw fail("run_not_recoverable", `只有 failed/interrupted 的 Run 可以重试，当前为 ${run.status}。`);
      }
      // C4（2026-09-24 审计）：retry 复用 submit 串行门——另一会话运行中时不得
      // 启动循环，否则项目级 controller 被本会话抢占（startLoop 无条件覆写）。
      await assertNoOtherSessionRunning(state, sessionState.sessionId);
      // 从 journal 事件找回可恢复 Run 的未终结输入（run_failed 记录了 input_id；
      // 崩溃恢复的 run_interrupted 没有，则退回 run_started/input_promoted 的信息）。
      let inputId = await sessionState.journal.findTerminalInputId(runId);
      if (inputId === null) {
        // 兜底：以 transcript 最近一条用户消息重建输入（崩溃现场无 input 记录）
        const records = await sessionState.journal.readTranscript();
        const lastUser = [...records].reverse().find((record) => record?.role === "user");
        inputId = idFactory();
        await sessionState.journal.append({
          type: "input_queued",
          payload: { input_id: inputId, text: String(lastUser?.content ?? "继续执行") }
        });
      }
      await sessionState.journal.append({
        type: "run_started",
        run_id: runId,
        payload: { input_id: inputId }
      });
      await sessionManager.syncSessionRegistry(state, sessionState);
      sessionState.lifecycle.startLoop(runId);
      return { run_id: runId, input_id: inputId, retried: true };
    });
  }

  // 压缩重试（Task 8 Step 7）：继续同一 compaction_id 的新 attempt。只允许
  // failed/cancelled（取消后 pending input 仍在时）状态；成功后原输入只继续一次
  //（输入写回 transcript 前的收敛由 runLoop/processInput 处理，绝不让旧
  // processInput 自动再次执行）。ESC/按钮/HTTP 与 cancelCompaction 复用同一
  // AbortSignal 链。
  async function retryCompaction({ projectRoot, compactionId, sessionId = null }) {
    if (typeof compactionId !== "string" || compactionId.length === 0) {
      throw fail("invalid_compaction_id", "compactionId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("compaction_not_found", `compaction ${compactionId} 不存在。`);
    // C4（2026-09-24 审计复审）：串行门必须与它守卫的 compaction 状态校验同处一个
    // 临界区（与 retry 对齐）——否则「门通过 → 另一会话 submit 启动循环 → 本处再
    // startLoop」在检查与生效之间复现项目级 controller 覆写。coordinator.retry
    //（含秒级模型调用）刻意留在锁外：临界区只做读-判，不阻塞 stop / 压缩取消的
    // 取锁路径；重试期间本会话 Run 仍非终态，其他会话的 submit 仍被同一道门挡住。
    const { compaction, run } = await state.mutex.run(async () => {
      await assertNoOtherSessionRunning(state, sessionState.sessionId);
      const session = await sessionState.journal.getSession();
      const compaction = session.compaction;
      if (!compaction || compaction.id !== compactionId) {
        throw fail("compaction_not_found", `compaction ${compactionId} 不存在。`);
      }
      if (compaction.state === "completed" || compaction.state === "noop") {
        throw fail("compaction_not_retryable", `压缩已${compaction.state === "completed" ? "完成" : "无需压缩"}，无法重试。`);
      }
      if (compaction.state === "started" || compaction.state === "running" || compaction.state === "cancelling") {
        throw fail("compaction_in_flight", "压缩正在进行中，无法重试。");
      }
      const run = session.active_run;
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
        throw fail("compaction_no_run", "当前没有可继续压缩的 Run。");
      }
      return { compaction, run };
    });
    const outcome = await sessionState.compactionCoordinator.retry({
      compactionId,
      signal: state.controller?.signal
    });
    if (outcome.status === "completed" || outcome.status === "noop") {
      // 恢复 Run 为 running 并重启循环。手动 /compact 的 retry 成功后 compact
      // item 已达成目的（input_completed 收敛，绝不重复启动第二次压缩）；自动压缩
      // 的 retry 成功后原 pending input 由 processInput 继续（压缩成功后预检低于
      // 硬窗口直接发送；仍超阈值因已尝试不再重复压缩）。retry 重建源后无可压缩
      // 历史（noop）视为等价成功——输入照常继续，由 processInput 重新预检。
      await state.mutex.run(async () => {
        const s = await sessionState.journal.getSession();
        const r = s.active_run;
        if (r && r.id === run.id && !TERMINAL_RUN_STATUSES.has(r.status) && r.status !== "running") {
          await sessionState.journal.append({
            type: "run_status_changed",
            run_id: run.id,
            payload: { status: "running", reason: "compaction_retried" }
          });
        }
        if (compaction.trigger === "manual") {
          const s2 = await sessionState.journal.getSession();
          const r2 = s2.active_run;
          if (r2 && r2.id === run.id && !TERMINAL_RUN_STATUSES.has(r2.status)) {
            // compact item 是活动输入（失败后保持 active、无终态）；Task 26 以
            // input_completed 收敛（旧 input_consumed 退役），守卫同 processCompact。
            if (r2.active_input_id !== compaction.pending_input_id) return;
            await sessionState.journal.append({
              type: "input_completed",
              run_id: run.id,
              payload: { input_id: compaction.pending_input_id }
            });
          }
        }
      });
      sessionState.lifecycle.startLoop(run.id);
      await sessionManager.syncSessionRegistry(state, sessionState);
      return { status: "completed", compaction_id: compactionId, attempt: outcome.attempt };
    }
    if (outcome.status === "failed") {
      // 仍失败：Run 保持 waiting_user，发送门禁保持禁用（熔断后只等用户再次 retry/cancel）
      const s = await sessionState.journal.getSession();
      const r = s.active_run;
      if (r && r.id === run.id && !TERMINAL_RUN_STATUSES.has(r.status) && r.status !== "waiting_user") {
        await sessionState.journal.append({
          type: "run_status_changed",
          run_id: run.id,
          payload: { status: "waiting_user", reason: "compaction_failed", error_code: outcome.error_code ?? null }
        });
      }
      await sessionManager.syncSessionRegistry(state, sessionState);
      return { status: "failed", compaction_id: compactionId, attempt: outcome.attempt, error_code: outcome.error_code };
    }
    // cancelled（ESC 中断重试）：取消收敛（input_cancelled + run_cancelled / 恢复）
    const compactionNow = (await sessionState.journal.getSession()).compaction;
    await sessionState.lifecycle.convergeCompactionCancelled(compactionNow);
    await sessionManager.syncSessionRegistry(state, sessionState);
    return { status: "cancelled", compaction_id: compactionId };
  }

  // 压缩取消（Task 8 Step 7）：ESC、按钮与 HTTP 取消都调用本方法，复用当前
  // project state 的 AbortController（不创建第二套进程终止协议）。running 时
  // 先进入 cancelling（cancel_requested），底层确认终止后追加 cancelled，随后
  // 按触发来源收敛 Run/input（自动 → input_cancelled + run_cancelled，文本回
  // draft；手动 → input_cancelled + 恢复 resume_run_status 或 idle）。
  async function cancelCompaction({ projectRoot, compactionId, sessionId = null }) {
    if (typeof compactionId !== "string" || compactionId.length === 0) {
      throw fail("invalid_compaction_id", "compactionId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    const sessionState = await resolveSessionState(state, sessionId);
    if (!sessionState) throw fail("compaction_not_found", `compaction ${compactionId} 不存在。`);
    await sessionState.journal.load();
    const session = await sessionState.journal.getSession();
    const compaction = session.compaction;
    if (!compaction || compaction.id !== compactionId) {
      throw fail("compaction_not_found", `compaction ${compactionId} 不存在。`);
    }
    const outcome = await sessionState.compactionCoordinator.cancel({ compactionId });
    const compactionNow = (await sessionState.journal.getSession()).compaction;
    // I5：取消请求与提交竞态——coordinator 报告实际终态（或会话投影已是 completed）
    // 时，压缩确实成功（指针已切换、completed 已落盘），原输入由 runLoop 继续，
    // 绝不把成功压缩收敛成 input_cancelled + run_cancelled（UI 不得显示"已取消"
    // 覆盖已切换的上下文）。
    if (outcome?.status === "completed" || outcome?.state === "completed") {
      await sessionManager.syncSessionRegistry(state, sessionState);
      return {
        status: "completed",
        compaction_id: compactionId,
        checkpoint_id: outcome?.checkpoint_id ?? compactionNow?.checkpoint_id ?? null
      };
    }
    await sessionState.lifecycle.convergeCompactionCancelled(compactionNow);
    await sessionManager.syncSessionRegistry(state, sessionState);
    return { status: "cancelled", compaction_id: compactionId };
  }

  return {
    submit,
    requestPriority,
    withdrawInput,
    decide,
    stop,
    retry,
    retryCompaction,
    cancelCompaction
  };
}
