// src/core/agent/run-lifecycle.mjs —— Run 收敛状态机：停止/优先切换/失败收束/
// 循环推进与等待（第十五轮 F5b 内核分区第二步，Task 8）。
//
// 从 runtime.mjs 机械迁出（不改逻辑）。本模块操作项目级 state 与会话级
// sessionState 双闭包态，迁出后经 ctx 显式传入：
//   - state/sessionState 经 getter（getState()/getSessionState()）注入——循环/
//     等待函数运行期间 state 字段会变（controller 被 resetController 替换、
//     loopPromise/runId/firstTurn 流转），必须每次读取当前值；
//   - 对 runtime.mjs 内部函数的调用（appendSafeTranscript /
//     isCompactRunIdleInitiated / resetController / findInputMeta / processCompact
//     / processInput）经 ctx 注入函数引用；
//   - 模块级常量（TERMINAL_RUN_STATUSES / IDLE_WAIT_TIMEOUT_MS）与
//     agent-utils 工具（sleep / codedError as fail）本模块直接持有。
//
// 承重不变量：本模块无磁盘写入；状态要么在 journal 投影、要么是 Run 生命周期
// 内的内存瞬态（state.controller / loopPromise / firstTurn / catalogCache）。
//
// 为什么是 per-session 工厂闭包而非模块级单例：每个会话的实例绑定自己的
// state/sessionState 引用对（runtime.mjs 在 ensureSessionState 内逐会话构造），
// 并行项目的循环在 await 交叉时只读自己绑定的状态——模块级可变绑定会被其他
// 项目覆盖而读错状态。
import { TERMINAL_RUN_STATUSES } from "./journal.mjs";
import { codedError as fail, sleep } from "./agent-utils.mjs";

const IDLE_WAIT_TIMEOUT_MS = 60000;

export function createRunLifecycle(ctx) {
  const { getState, getSessionState } = ctx;

  function isAbort(error) {
    if (getState().controller?.signal.aborted) return true;
    if (error?.name === "AbortError") return true;
    if (error?.code === "model_aborted") return true;
    return false;
  }

  // 中断/停止丢弃的模型工具调用以 cancelled 记录闭合 transcript：assistant
  // tool_calls 消息之后必须有对应的 tool 结果，否则历史含畸形消息链（provider
  // 会拒绝、retry 复用历史时同样受影响）。
  async function closeDroppedToolCalls(droppedCalls) {
    if (!Array.isArray(droppedCalls) || droppedCalls.length === 0) return;
    for (const toolCall of droppedCalls) {
      const id = toolCall?.id ?? toolCall?.tool_call_id ?? null;
      await ctx.appendSafeTranscript(getSessionState().journal, {
        role: "tool",
        tool_call_id: id,
        name: toolCall?.name ?? null,
        content: JSON.stringify({
          ok: false,
          tool_call_id: id,
          name: toolCall?.name ?? null,
          error: { code: "tool_cancelled", message: "操作已停止。" },
          message: "操作已停止。"
        })
      });
    }
  }

  // Task 10：优先切换时跳过的工具调用以 tool_skipped_for_priority_input 闭合
  // transcript（与 closeDroppedToolCalls 同构：只补 transcript，不产生 journal
  // 活动、不启动工具）。assistant tool_calls 记录已先持久化，每个未开始的调用
  // 追加同 id 的 result，保证 provider history 结构完整（SPEC 3.3 rule 4）。
  async function closePrioritySkippedToolCalls(skippedCalls) {
    if (!Array.isArray(skippedCalls) || skippedCalls.length === 0) return;
    for (const toolCall of skippedCalls) {
      const id = toolCall?.id ?? toolCall?.tool_call_id ?? null;
      await ctx.appendSafeTranscript(getSessionState().journal, {
        role: "tool",
        tool_call_id: id,
        name: toolCall?.name ?? null,
        content: JSON.stringify({
          ok: false,
          tool_call_id: id,
          name: toolCall?.name ?? null,
          error: { code: "tool_skipped_for_priority_input", message: "Interrupted by the user" },
          message: "Interrupted by the user"
        })
      });
    }
  }

  // Task 3：同一响应中前一个工具失败后，未启动的后续调用以
  // tool_skipped_after_failure 闭合 transcript——每个持久化 assistant tool call
  // 恰好一个 tool result（不执行、不产生 journal 活动，只补 transcript 结果）。
  // 返回追加的记录副本，调用方放入 volatileToolRecords，保证下一轮历史装配的
  // 瞬态去重一致（assistant 记录的 tool_calls 与对应 tool 记录同源同集）。
  async function closeSkippedToolCalls(skippedCalls) {
    const records = [];
    if (!Array.isArray(skippedCalls) || skippedCalls.length === 0) return records;
    for (const toolCall of skippedCalls) {
      const id = toolCall?.id ?? toolCall?.tool_call_id ?? null;
      const name = toolCall?.name ?? null;
      const skippedResult = {
        ok: false,
        tool_call_id: id,
        name,
        error: {
          code: "tool_skipped_after_failure",
          message: "由于同一响应中的前一个工具调用失败，本次调用未执行。",
          retryable: true
        },
        message: "由于同一响应中的前一个工具调用失败，本次调用未执行。"
      };
      const record = { role: "tool", tool_call_id: id, name, content: JSON.stringify(skippedResult) };
      records.push(record);
      await ctx.appendSafeTranscript(getSessionState().journal, record);
    }
    return records;
  }

  // -------------------------------------------------------------------------
  // 停止 / 优先切换 / 失败收束（读-判-写都在项目互斥锁内：switchTo /
  // cancelRunForStop / convergeCompactionCancelled 走 mutex.run，failRun 幂等）
  // -------------------------------------------------------------------------

  // Task 10：优先安全点切换（SPEC 3.3）。在 session 项目互斥锁内重读 Journal 投影
  // 做读-判-写（与 submit/requestPriority/withdraw/stop 同一把锁，并发胜者由持久
  // 事件顺序决定）：
  //   - 无 priority_input_id / 优先输入已不在队列 / Run 已终结 → 不切换（false）；
  //   - stopping/interrupting 优先收敛（停止是硬逃生口，其收敛先于优先切换；
  //     interrupting 中间态旧日志重放可到达，新 generation 不产生
  //     interrupt_requested——Task 26 起旧 promote 已退役）；
  //   - 旧输入未自然完成 → 原子追加 input_interrupted(A) + input_started(D)，同时
  //     清除 A 的 grant（grant 绑定 active_input_id，不清理会泄漏给后续输入）；
  //   - 旧输入已自然完成（如文本回复路径已写 input_completed，active_input_id 为
  //     null）→ 只追加 input_started(D)，不伪造中断；
  // 同一 appendBatch 内 input_interrupted 先清空 active_input_id，input_started
  // 通过 reducer 的「活动输入必须已收敛」校验并清空 priority_input_id。不调用
  // abortController()——当前模型请求使用原 signal 完成（SPEC 3.3 rule 2）。
  // 返回 true 表示已切换到优先输入，调用方应停止当前输入的处理（回到 runLoop
  // 重新读取状态与优先输入）。
  async function switchToPriorityAtSafePoint(runId, inputId) {
    return getState().mutex.run(async () => {
      const session = await getSessionState().journal.getSession();
      const priorityId = session.priority_input_id;
      if (priorityId == null) return false;
      if (!session.queued_inputs.some((item) => item.id === priorityId)) return false;
      const run = session.active_run;
      if (!run || run.id !== runId || TERMINAL_RUN_STATUSES.has(run.status)) return false;
      if (run.status === "stopping" || run.status === "interrupting") return false;
      const batch = [];
      // 旧输入 grant 清除（与完成路径同构：grant 绑定 active_input_id，输入被
      // 优先打断后必须清除，否则后续输入沿用旧 grant 绕过确认）。
      const grantsOfActive = run.active_grants.filter((grant) => grant.input_id === run.active_input_id);
      for (const grant of grantsOfActive) {
        batch.push({
          type: "permission_grant_cleared",
          run_id: runId,
          payload: {
            grant_id: grant.id,
            input_id: grant.input_id,
            grant_key: grant.grant_key,
            reason: "input_interrupted"
          }
        });
      }
      if (run.active_input_id != null) {
        batch.push({ type: "input_interrupted", run_id: runId, payload: { input_id: run.active_input_id } });
      }
      batch.push({ type: "input_started", run_id: runId, payload: { input_id: priorityId } });
      await getSessionState().journal.appendBatch(batch);
      return true;
    });
  }

  // 停止收敛：为每个未消费输入（活动 + 排队）追加 input_cancelled，清除全部
  // grant，再 run_cancelled。幂等：Run 已终结时直接返回。在项目互斥锁内执行
  // 读-判-写：并发 submit 要么先落盘（本批次把它一并取消），要么后落盘（属于
  // 下一个 Run），杜绝输入滞留。
  // 为什么保留 input_cancelled（Task 26 语义收窄）：新生命周期三种终态均不覆盖
  //「输入因硬停止被丢弃」——input_interrupted 要求安全边界（模型/工具在途硬停止
  // 不满足，且 reducer 只接受活动输入、排队输入无法用它终结）、input_withdrawn
  // 仅限用户主动撤回；规格 3.3.9 保留停止为硬逃生口，verify 场景 5 钉住此契约。
  async function cancelRunForStop(reason) {
    return getState().mutex.run(async () => {
      const session = await getSessionState().journal.getSession();
      const run = session.active_run;
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;
      const batch = [];
      const inputIds = [];
      if (run.active_input_id !== null) inputIds.push(run.active_input_id);
      for (const item of session.queued_inputs) inputIds.push(item.id);
      for (const inputId of inputIds) {
        batch.push({ type: "input_cancelled", run_id: run.id, payload: { input_id: inputId } });
      }
      for (const grant of run.active_grants) {
        batch.push({
          type: "permission_grant_cleared",
          run_id: run.id,
          payload: { grant_id: grant.id, input_id: grant.input_id, grant_key: grant.grant_key, reason: "run_cancelled" }
        });
      }
      batch.push({
        type: "run_cancelled",
        run_id: run.id,
        payload: { reason: reason ?? "user_stop" }
      });
      await getSessionState().journal.appendBatch(batch);
    });
  }

  // 模型调用失败 → run_failed（可恢复）。保留该输入的 grant（输入未终结，
  // retry 同一输入继续使用）；失败路径已闭合 model turn。
  async function failRun(runId, { error, inputId }) {
    const session = await getSessionState().journal.getSession();
    const run = session.active_run;
    if (!run || run.id !== runId || TERMINAL_RUN_STATUSES.has(run.status)) return;
    await getSessionState().journal.append({
      type: "run_failed",
      run_id: runId,
      payload: {
        error: typeof error?.message === "string" ? error.message : String(error),
        code: error?.code ?? "model_error",
        input_id: inputId ?? null
      }
    });
  }

  // 压缩取消收敛（幂等，项目互斥锁内读-判-写）：
  //   - 自动：input_cancelled(reason:"compaction_cancelled") + 排队输入一并取消 +
  //     grant 清除 + run_cancelled（矩阵：Run cancelled、文本回 draft）；
  //   - 手动 in-run：input_cancelled(compaction_cancelled) + 恢复 running；
  //   - 手动空闲：input_cancelled(compaction_cancelled) + run_cancelled → idle。
  // 返回 "converged" | "already_terminal" | "input_settled"。
  // 为什么保留 input_cancelled（Task 26 语义收窄，同 stop 路径）：压缩取消的
  // 终结范围是——手动 in-run 只终结 compact item（排队输入存活，队列继续消费，
  // whfind-bugs #3）；自动/空闲为运行级丢弃（活动 compact item + 排队输入一并
  // 终结）。input_interrupted 需安全边界且只接受活动输入、input_withdrawn 仅限
  // 主动撤回；UI 契约按 input_cancelled(compaction_cancelled) 渲染「已取消」。
  async function convergeCompactionCancelled(compaction) {
    return getState().mutex.run(async () => {
      const session = await getSessionState().journal.getSession();
      const run = session.active_run;
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return "already_terminal";
      const inputId = compaction?.pending_input_id ?? null;
      const inputLive =
        inputId != null &&
        (run.active_input_id === inputId || session.queued_inputs.some((item) => item.id === inputId));
      if (!inputLive) return "input_settled";
      const isManual = compaction?.trigger === "manual";
      const idleInitiated = isManual ? await ctx.isCompactRunIdleInitiated(getState(), getSessionState(), run.id, inputId) : false;
      const batch = [];
      const inputIds = [];
      if (run.active_input_id != null) inputIds.push(run.active_input_id);
      const manualInRun = isManual && !idleInitiated;
      // whfind-bugs #3：手动 in-run 取消只终结 compact item 本身（即活动输入），
      // 排队输入存活——收敛矩阵写明「手动 → 恢复 running（队列继续消费）」。
      // 自动/空闲路径维持运行级丢弃（run_cancelled → idle，队列随 Run 终结）。
      if (!manualInRun) {
        for (const item of session.queued_inputs) inputIds.push(item.id);
      }
      for (const id of inputIds) {
        batch.push({
          type: "input_cancelled",
          run_id: run.id,
          payload: { input_id: id, reason: id === inputId ? "compaction_cancelled" : "compaction_run_cancelled" }
        });
      }
      if (manualInRun) {
        // 手动 in-run 取消：恢复 resume_run_status（running），队列继续消费
        batch.push({
          type: "run_status_changed",
          run_id: run.id,
          payload: { status: "running", reason: "compaction_cancelled", resume_run_status: "running" }
        });
      } else {
        for (const grant of run.active_grants ?? []) {
          batch.push({
            type: "permission_grant_cleared",
            run_id: run.id,
            payload: { grant_id: grant.id, input_id: grant.input_id, grant_key: grant.grant_key, reason: "compaction_cancelled" }
          });
        }
        batch.push({ type: "run_cancelled", run_id: run.id, payload: { reason: "compaction_cancelled" } });
      }
      if (batch.length > 0) await getSessionState().journal.appendBatch(batch);
      return "converged";
    });
  }

  // -------------------------------------------------------------------------
  // 循环推进与终结：安全点切换后回到 runLoop 重读状态；队列清空且满足完成
  // 条件后 advanceOrComplete 追加 run_completed。
  // -------------------------------------------------------------------------

  // 输入完成后的队列推进 / Run 终结：在项目互斥锁内完成读-判-写，杜绝与 submit
  // 的竞态（submit 恰落在「队列判空」与「run_completed 落盘」之间时，新输入会
  // 滞留跨 Run 边界）。返回 "advance" | "compact" | "completed" | "interrupting"
  // | "stopping" | "terminal" | "gone"。
  async function advanceOrComplete(runId) {
    return getState().mutex.run(async () => {
      const session = await getSessionState().journal.getSession();
      const run = session.active_run;
      if (!run || run.id !== runId) return "gone";
      if (TERMINAL_RUN_STATUSES.has(run.status)) return "terminal";
      if (run.status === "stopping") return "stopping";
      if (run.status === "interrupting" || getState().controller?.signal.aborted) return "interrupting";
      // Task 10：优先输入在途时优先激活（A 已以普通文本自然完成 → input_completed
      // 已落盘、active_input_id 为 null，这里只追加 input_started(D)；D 从队列移除
      // 后 B 补位，B/C 相对顺序不变；不伪造中断）。
      if (
        session.priority_input_id != null &&
        session.queued_inputs.some((item) => item.id === session.priority_input_id)
      ) {
        await getSessionState().journal.append({
          type: "input_started",
          run_id: runId,
          payload: { input_id: session.priority_input_id }
        });
        return "advance";
      }
      if (session.queued_inputs.length > 0) {
        const head = session.queued_inputs[0];
        if (head.kind === "compact") {
          // Task 8：/compact 在安全点被"消费"——激活但不给终态事件（失败时
          // compact item 必须保持无终态可重试/可取消），由 processCompact 收尾。
          // Task 26：/compact 队列项服从同一输入生命周期（规格 3.2），激活用
          // input_started（到达此处时活动输入已收敛，active_input_id 为 null）；
          // reason 作为附加信息保留（reducer 不校验额外 payload 字段）。此激活
          // 路径与 isCompactRunIdleInitiated 的「Run 首个 input_started 判定」互为
          // 依据：空闲发起的 /compact 其首条 input_started 就是 compact item。
          await getSessionState().journal.append({
            type: "input_started",
            run_id: runId,
            payload: { input_id: head.id, reason: "compact_safe_point" }
          });
          return "compact";
        }
        // Task 9 新生命周期：激活下一个排队输入（input_started 只激活不终结；
        // 该输入的终态由 processInput 完成路径追加 input_completed）。
        await getSessionState().journal.append({
          type: "input_started",
          run_id: runId,
          payload: { input_id: session.queued_inputs[0].id }
        });
        return "advance";
      }
      await getSessionState().journal.append({ type: "run_completed", run_id: runId, payload: {} });
      return "completed";
    });
  }

  // 外层循环：逐个消费输入；队列清空且满足完成条件后 Run 终结。
  // compaction_blocked（自动压缩失败/取消、手动压缩失败/空闲取消）必须显式
  // 处理：复位 controller 并停止循环——绝不继续循环、绝不调用 run_completed。
  async function runLoop(runId) {
    while (true) {
      const session = await getSessionState().journal.getSession();
      const run = session.active_run;
      if (!run || run.id !== runId) return;
      if (TERMINAL_RUN_STATUSES.has(run.status)) return;
      if (run.status === "stopping") {
        await cancelRunForStop(getState().stopReason);
        return;
      }
      if (run.status === "interrupting" || getState().controller?.signal.aborted) {
        await getSessionState().journal.append({ type: "interrupt_safe_point_reached", run_id: runId, payload: {} });
        ctx.resetController(getState());
        continue;
      }

      const inputId = run.active_input_id;
      if (inputId === null) {
        // 无活动输入：互斥锁内激活队首或自然终结（兜底路径）
        const fallback = await advanceOrComplete(runId);
        if (fallback === "advance" || fallback === "compact" || fallback === "interrupting" || fallback === "stopping") continue;
        return;
      }

      const inputMeta = await ctx.findInputMeta(getSessionState().journal, inputId);
      if (inputMeta.text === null) {
        // 恢复的日志中找不到该输入（陈旧记录）：消费跳过，避免卡死。Task 26：
        // 用 input_interrupted 闭合（活动输入未完成即丢弃；它是新生命周期唯一
        // 可终结活动输入的非完成事件，reducer 校验 active_input_id === inputId
        // 恰好在当前分支成立），旧 input_consumed 退役。
        await getSessionState().journal.append({ type: "input_interrupted", run_id: runId, payload: { input_id: inputId } });
        continue;
      }

      if (inputMeta.kind === "compact") {
        const compactOutcome = await ctx.processCompact(getState(), getSessionState(), runId, inputId, inputMeta.text);
        if (compactOutcome === "compacted" || compactOutcome === "compaction_resumed") {
          const after = await advanceOrComplete(runId);
          if (after === "advance" || after === "compact" || after === "interrupting" || after === "stopping") continue;
          return; // completed / terminal / gone
        }
        if (compactOutcome === "interrupted") continue;
        // compaction_blocked（失败 → waiting_user；空闲取消 → run_cancelled）
        ctx.resetController(getState());
        return;
      }

      const outcome = await ctx.processInput(getState(), getSessionState(), runId, inputId, inputMeta.text);
      if (outcome === "stopped" || outcome === "failed" || outcome === "terminated" || outcome === "compaction_blocked") {
        if (outcome === "compaction_blocked") ctx.resetController(getState());
        return;
      }
      if (outcome === "interrupted") continue; // 立即：重新读取状态与被提升的输入

      // 输入完成：互斥锁内复查队列并推进/终结（阻断 submit 竞态滞留）；
      // "compact" = 队首是 /compact 已被安全点激活，继续循环处理
      const after = await advanceOrComplete(runId);
      if (after === "advance" || after === "compact" || after === "interrupting" || after === "stopping") continue;
      return; // completed / terminal / gone
    }
  }

  // 启动（或接续）当前 Run 的循环。同项目一次只有一个循环：已绑定的循环返回
  // 原 Promise；旧循环收尾期间的新 Run 先等待旧循环结束再开始（避免双循环）。
  // firstTurn 信号：本轮循环第一次模型轮次开始（model_turn_started 已落盘）时
  // resolve；submit 创建 Run 后等待它，保证调用方拿到控制权时模型轮次已在飞行
  // （「立即」在飞行期间到达，被打断的输入才有可打断的活动），循环结束也 resolve
  // 以免停止先于首轮时悬挂等待者。
  function startLoop(runId) {
    if (getState().loopPromise && getState().runId === runId) return getState().loopPromise;
    const previous = getState().loopPromise;
    let resolveFirstTurn;
    const firstTurn = new Promise((resolve) => {
      resolveFirstTurn = resolve;
    });
    getState().runId = runId;
    // Task 4：记录当前飞行循环属于哪个会话（clearHistory 按此判断是否可复位
    // 项目级循环状态——清空其他会话历史不得破坏运行中会话的可中断性）。
    getState().loopSessionId = getSessionState().sessionId;
    getState().controller = new AbortController();
    getState().stopReason = "user_stop";
    getState().firstTurn = { promise: firstTurn, resolve: resolveFirstTurn, resolved: false };
    const promise = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          // 旧循环异常已在其自身兜底；只等待收尾
        }
      }
      try {
        await runLoop(runId);
      } catch (error) {
        // 兜底：循环异常时把 Run 收敛为 failed，绝不悬挂项目
        try {
          const session = await getSessionState().journal.getSession();
          const run = session.active_run;
          if (run && run.id === runId && !TERMINAL_RUN_STATUSES.has(run.status)) {
            await failRun(runId, {
              error: { message: String(error?.message ?? error), code: "runtime_error" },
              inputId: run.active_input_id
            });
          }
        } catch {
          // journal 已不可用：放弃
        }
      } finally {
        getState().firstTurn?.resolve();
        if (getState().loopPromise === promise) {
          getState().loopPromise = null;
          getState().runId = null;
          getState().loopSessionId = null;
          getState().controller = null;
          getState().firstTurn = null;
          // Run 结束：清掉 skill catalog 记忆，下次 Run 重新发现（技能可能已变更）。
          getState().catalogCache = null;
        }
      }
    })();
    getState().loopPromise = promise;
    return promise;
  }

  // -------------------------------------------------------------------------
  // 等待（submit 等首个模型轮次、stop 等 Run 回 idle——循环内部与外部调用的
  // 安全点衔接）
  // -------------------------------------------------------------------------

  // 等待循环开始第一次模型轮次（或循环结束），带超时兜底。
  // 超时兜底必须显式 clearTimeout：Promise.race 不会取消落选方，遗留的 10s
  // 定时器会让进程空转（Task 7 观测到的残留 handle，focused tests 无法退出）。
  async function waitForFirstTurn() {
    const signal = getState().firstTurn;
    if (!signal) return;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        if (!signal.resolved) {
          signal.resolved = true;
          signal.resolve();
        }
        resolve();
      }, 10000);
    });
    await Promise.race([signal.promise, timeout]);
    clearTimeout(timer);
  }

  async function waitForIdle({ timeoutMs = IDLE_WAIT_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = await getSessionState().journal.getSession();
      if (session.status === "idle") return;
      await sleep(10);
    }
    throw fail("stop_timeout", "等待 Run 停止超时。");
  }

  return {
    isAbort,
    closeDroppedToolCalls,
    closePrioritySkippedToolCalls,
    closeSkippedToolCalls,
    switchToPriorityAtSafePoint,
    cancelRunForStop,
    failRun,
    convergeCompactionCancelled,
    advanceOrComplete,
    runLoop,
    startLoop,
    waitForFirstTurn,
    waitForIdle
  };
}