// src/core/agent/runtime.mjs —— 唯一模型/工具循环、队列、中断、停止、重试（Task 6）。
//
// 深模块内部实现：生产调用方只能经 src/core/agent/index.mjs 使用；tests/agent/ 可以
// 测试本模块内部 seam。本文件是 ProjectAgent 的编排核心：
//
//   - 每个项目一个长期 AgentSession；项目空闲时 submit 创建新 AgentRun，运行中
//     submit 进入同一 Session 的 FIFO 队列（Rule 1-2）。
//   - 同一项目一次只执行一个 AgentRun（一个模型/工具循环）；不同项目互不共享锁，
//     可以并行运行。
//   - 模型循环：消费活动输入 → assemblePrompt（runtime policy / AGENTS.md /
//     workflow policy / dynamic context / history / currentInput）→ gateway.complete →
//     工具调用逐个 tools.execute（权限/确认/decision 流程）→ 结果入 transcript →
//     循环直到模型无工具调用且队列清空，Run 终结。
//   - 立即（promote）：同一 journal 批次原子写入 interrupt_requested + input_promoted
//     （+ 旧活动输入的 grant 清除），abort 活动模型请求或可中断工具，等待原子操作
//     到达安全点，然后同一 Run 继续消费被提升的输入；剩余输入保持顺序。
//   - 停止（stop）：写入 stopping 状态、abort 信号、等待当前原子操作，之后为每个
//     未消费输入追加 input_cancelled、清除全部 grant 并 run_cancelled。
//   - retry：继续同一 failed/interrupted Run（transcript 作历史、checkpoint 由
//     project operations 守护），journal 以同 id 的 run_started 恢复。
//   - 模型调用失败路径必须闭合 model turn（补 model_turn_completed），绝不留下
//     dangling assistant 活动（journal 恢复会把它们标记为 interrupted）。
//
// 状态机：run_status_changed 流转 idle→running→(waiting_user↔running)→
// completed/failed/cancelled/interrupted；interrupting/stopping 是中间态
//（interrupt_requested/stopping 写入后、安全点到达前）。
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createAgentJournal } from "./journal.mjs";
import { createToolRuntime } from "./tools.mjs";
import { assemblePrompt } from "./prompt.mjs";
import { canEnterWorkflow, workflowPolicy } from "./workflows.mjs";
import { runLegacyImport } from "./legacy-import.mjs";
import { loadProject } from "../project-store.mjs";
import { pathExists } from "../fs-utils.mjs";

import {
  appendChapterSegment,
  commitChapter,
  commitChapterMemory,
  inspectChapterContext
} from "../project-operations/chapter.mjs";
import { commitBlueprint, inspectBlueprintContext } from "../project-operations/blueprint.mjs";
import { reviewProject } from "../project-operations/review.mjs";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

const GENERAL_TOOL_NAMES = new Set(["list_files", "search_files", "read_file", "write_file", "edit_file", "shell"]);

const SOURCES = new Set(["chat", "maintenance"]);

// 停止/提升等待上限。语义说明（Task 6 规格审查 Minor）：stop 在 abort 信号发出后
// 等待循环收敛（可中断工具被杀、循环追加终态批次），正常只需毫秒级；60s 上限只
// 防御循环异常悬挂。长原子操作（不可中断提交）不受 abort 影响也会在毫秒级完成，
// 不会接近该上限。
const IDLE_WAIT_TIMEOUT_MS = 60000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createMutex() {
  let tail = Promise.resolve();
  return {
    run(task) {
      const result = tail.then(() => task());
      tail = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 每项目状态：journal + ToolRuntime + 当前 Run 的循环控制
// ---------------------------------------------------------------------------

export function createAgentRuntime({
  modelGateway = null,
  shell = null,
  secrets = [],
  idFactory = randomUUID
} = {}) {
  if (!modelGateway || typeof modelGateway.complete !== "function") {
    throw new TypeError("createProjectAgent 需要注入带 complete(request, { signal }) 的 modelGateway");
  }

  const projects = new Map(); // projectRoot -> project state

  function ensureProject(projectRoot) {
    const key = path.resolve(projectRoot);
    let state = projects.get(key);
    if (!state) {
      const journal = createAgentJournal({ projectRoot: key, idFactory });
      const projectOperations = {
        inspectChapterContext,
        appendChapterSegment,
        commitChapter,
        commitChapterMemory,
        inspectBlueprintContext,
        commitBlueprint,
        reviewProject
      };
      const tools = createToolRuntime({
        projectOperations,
        journal,
        shellRuntime: shell,
        secrets,
        idFactory
      });
      state = {
        key,
        journal,
        tools,
        projectOperations,
        modelGateway,
        // 当前 Run 的循环控制（一次一个模型/工具循环）
        runId: null,
        controller: null,
        loopPromise: null,
        firstTurn: null,
        stopReason: "user_stop",
        mutex: createMutex()
      };
      // 嵌套 workflow 拒绝：enter_workflow 是改变工作流的唯一入口，由 BeforeToolUse
      // hook 在工具执行（写 workflow_changed）之前校验转移是否合法。
      tools.registerHook("BeforeToolUse", async ({ tool, args }) => {
        if (tool !== "enter_workflow") return undefined;
        const session = await journal.getSession();
        const run = session.active_run;
        if (!run) return undefined;
        const target = String(args?.workflow ?? "");
        if (!canEnterWorkflow(run.workflow, target)) {
          return {
            allow: false,
            reason: `不能从 ${run.workflow} 直接进入 ${target}；请先回到 general。`
          };
        }
        return undefined;
      });
      projects.set(key, state);
    }
    return state;
  }

  function abortController(state) {
    try {
      state.controller?.abort();
    } catch {
      // 已终止的 controller 忽略
    }
  }

  function resetController(state) {
    if (state.controller && state.controller.signal.aborted) {
      state.controller = new AbortController();
    }
  }

  // -------------------------------------------------------------------------
  // 模型/工具循环
  // -------------------------------------------------------------------------

  // 从 journal 事件里找回 input 文本（活动输入不在 projection 的 queued_inputs 里）。
  // 上限语义（Task 6 规格审查 Minor）：只扫描最近 100k 条事件；超出上限的输入
  // 视为找不到（返回 null，runLoop 对该输入做消费跳过）——长会话场景应由 UI 分页
  // 与历史压缩避免依赖无限回溯。
  async function findInputText(journal, inputId) {
    const events = await journal.read({ afterSeq: 0, limit: 100000 });
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type === "input_queued" && event.payload?.input_id === inputId) {
        return typeof event.payload.text === "string" ? event.payload.text : null;
      }
    }
    return null;
  }

  async function readProjectInstructions(projectRoot) {
    try {
      const target = path.join(projectRoot, "AGENTS.md");
      if (!(await pathExists(target))) return "";
      const text = await fs.readFile(target, "utf8");
      return typeof text === "string" ? text : "";
    } catch {
      return "";
    }
  }

  // project.yaml 缺失/损坏时的最小兜底（只读工具仍可用；深工具由 project
  // operations 自行校验）。兜底对象永不被持久化。
  const FALLBACK_PROJECT = Object.freeze({
    project_id: null,
    tool_permissions: {},
    output_format: "md",
    archived_at: null,
    active_model: null,
    enabled_skills: [],
    min_words_per_chapter: 0,
    target_words_per_chapter: 0
  });

  async function loadProjectSafe(projectRoot) {
    try {
      const project = await loadProject(projectRoot);
      return project && typeof project === "object" ? project : FALLBACK_PROJECT;
    } catch {
      return FALLBACK_PROJECT;
    }
  }

  function permissionModeOf(project) {
    const tp = project?.tool_permissions ?? {};
    if (tp.yolo === true) return "yolo";
    if (tp.auto_edit === true) return "trusted";
    return "ask";
  }

  function modelConfigOf(project) {
    const active = project?.active_model ?? {};
    return {
      provider: typeof active.provider === "string" ? active.provider : "unknown",
      model_name: active.model_name ?? null,
      context_window: Number.isFinite(Number(project?.context_window))
        ? Number(project.context_window)
        : undefined,
      ...active
    };
  }

  // transcript 记录 → 干净的 OpenAI 消息形状（去掉 input_id 等内部字段）。
  function transcriptToMessages(records) {
    const messages = [];
    for (const record of records) {
      if (record?.role === "user") {
        messages.push({ role: "user", content: String(record.content ?? "") });
      } else if (record?.role === "assistant") {
        const message = { role: "assistant", content: record.content ?? null };
        if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
          message.tool_calls = record.tool_calls.map((tc) => ({
            id: tc?.id ?? null,
            name: tc?.name ?? null,
            arguments: tc?.arguments ?? null
          }));
        }
        messages.push(message);
      } else if (record?.role === "tool") {
        messages.push({
          role: "tool",
          tool_call_id: record.tool_call_id ?? null,
          content: String(record.content ?? "")
        });
      }
    }
    return messages;
  }

  // 历史 = transcript 全量（prompt 模块负责受保护窗口与预算压缩）；
  // 当前正在处理的输入从历史中排除（它以 currentInput 单独入 prompt）。
  async function buildHistory(journal, excludeInputId = null) {
    const records = await journal.readTranscript();
    const filtered =
      excludeInputId === null
        ? records
        : records.filter((record) => !(record.input_id != null && record.input_id === excludeInputId));
    return transcriptToMessages(filtered);
  }

  // 按工作流政策过滤深工具（general 六工具恒可用）。
  function allowedDefinitions(tools, policy) {
    const allowedDeep = new Set(policy.allowedDeepTools ?? []);
    return tools
      .definitions()
      .filter((definition) => {
        const name = definition?.function?.name;
        return GENERAL_TOOL_NAMES.has(name) || allowedDeep.has(name);
      });
  }

  // 追加用户消息到 transcript（retry 去重：同一 input 只出现一次）。
  async function ensureUserMessageInTranscript(journal, inputId, inputText) {
    const records = await journal.readTranscript();
    if (records.some((record) => record.input_id === inputId)) return;
    await journal.appendTranscript({ role: "user", content: inputText, input_id: inputId });
  }

  // Task 2 冻结语义：每条 input 恰好一个 input_consumed/input_cancelled 终态事件。
  //   - 队列输入由 input_consumed「切换激活」，该事件同时就是它的终态事件；
  //   - 活动输入由 run_started/input_promoted 激活，完成时才需要 input_consumed 收敛。
  // 返回当前输入完成时是否需要追加 input_consumed。
  // 上限语义同 findInputText：只扫描最近 100k 条事件，超出视为需要收敛（保守方向）。
  async function needsCompletionConsumed(journal, runId, inputId) {
    const events = await journal.read({ afterSeq: 0, limit: 100000 });
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.run_id !== runId || event.payload?.input_id !== inputId) continue;
      if (event.type === "input_consumed") return false; // 该输入已被「切换激活」消费过
      if (event.type === "input_promoted" || event.type === "run_started") return true;
    }
    return true;
  }

  function isAbort(error, state) {
    if (state.controller?.signal.aborted) return true;
    if (error?.name === "AbortError") return true;
    if (error?.code === "model_aborted") return true;
    return false;
  }

  // 中断/停止丢弃的模型工具调用以 cancelled 记录闭合 transcript：assistant
  // tool_calls 消息之后必须有对应的 tool 结果，否则历史含畸形消息链（provider
  // 会拒绝、retry 复用历史时同样受影响）。
  async function closeDroppedToolCalls(state, droppedCalls) {
    if (!Array.isArray(droppedCalls) || droppedCalls.length === 0) return;
    for (const toolCall of droppedCalls) {
      const id = toolCall?.id ?? toolCall?.tool_call_id ?? null;
      await state.journal.appendTranscript({
        role: "tool",
        tool_call_id: id,
        name: toolCall?.name ?? null,
        content: JSON.stringify({
          ok: false,
          tool_call_id: id,
          name: toolCall?.name ?? null,
          error: "tool_cancelled",
          message: "操作已停止。"
        })
      });
    }
  }

  // 停止收敛：为每个未消费输入（活动 + 排队）追加 input_cancelled，清除全部
  // grant，再 run_cancelled。幂等：Run 已终结时直接返回。在项目互斥锁内执行
  // 读-判-写：并发 submit 要么先落盘（本批次把它一并取消），要么后落盘（属于
  // 下一个 Run），杜绝输入滞留。
  async function cancelRunForStop(state, reason) {
    return state.mutex.run(async () => {
      const session = await state.journal.getSession();
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
      await state.journal.appendBatch(batch);
    });
  }

  // 模型调用失败 → run_failed（可恢复）。保留该输入的 grant（输入未终结，
  // retry 同一输入继续使用）；失败路径已闭合 model turn。
  async function failRun(state, runId, { error, inputId }) {
    const session = await state.journal.getSession();
    const run = session.active_run;
    if (!run || run.id !== runId || TERMINAL_RUN_STATUSES.has(run.status)) return;
    await state.journal.append({
      type: "run_failed",
      run_id: runId,
      payload: {
        error: typeof error?.message === "string" ? error.message : String(error),
        code: error?.code ?? "model_error",
        input_id: inputId ?? null
      }
    });
  }

  // 处理一个输入：模型轮次循环直到文本回复 / 中断 / 停止 / 失败。
  // 返回 "done" | "interrupted" | "stopped" | "failed" | "terminated"。
  async function processInput(state, runId, inputId, inputText) {
    const { journal, tools } = state;
    await ensureUserMessageInTranscript(journal, inputId, inputText);

    while (true) {
      const session = await journal.getSession();
      const run = session.active_run;
      if (!run || run.id !== runId) return "terminated";
      if (TERMINAL_RUN_STATUSES.has(run.status)) return "terminated";
      if (run.status === "stopping") {
        await cancelRunForStop(state, state.stopReason);
        return "stopped";
      }
      if (run.status === "interrupting" || state.controller?.signal.aborted) {
        await journal.append({ type: "interrupt_safe_point_reached", run_id: runId, payload: {} });
        resetController(state);
        return "interrupted";
      }

      // ---- 装配模型请求 ----
      const project = await loadProjectSafe(state.key);
      const policy = workflowPolicy(run.workflow);
      const request = assemblePrompt({
        runtime: {
          absoluteProjectRoot: state.key,
          permissionMode: permissionModeOf(project),
          writableRoots: [state.key],
          network: project?.tool_permissions?.network_allowed === true ? "allowed" : "denied",
          shell: typeof shell === "function" ? "available" : "unavailable",
          nativeTools: "available",
          sessionId: session.session_id,
          runId,
          status: run.status,
          interruptRequested: run.status === "interrupting",
          budget: {}
        },
        projectInstructions: await readProjectInstructions(state.key),
        workflow: run.workflow,
        dynamicContext: await policy.contextSelector({
          projectRoot: state.key,
          session,
          project,
          inputText
        }).catch(() => []),
        history: await buildHistory(journal, inputId),
        currentInput: inputText,
        tools: allowedDefinitions(tools, policy),
        modelConfig: modelConfigOf(project)
      });

      // ---- 模型轮次（失败路径必须闭合 model turn）----
      await journal.append({ type: "model_turn_started", run_id: runId, payload: {} });
      if (state.firstTurn && !state.firstTurn.resolved) {
        state.firstTurn.resolved = true;
        state.firstTurn.resolve();
      }
      let reply;
      try {
        reply = await state.modelGateway.complete(request, { signal: state.controller?.signal });
      } catch (error) {
        await journal.append({ type: "model_turn_completed", run_id: runId, payload: {} }).catch(() => {});
        if (isAbort(error, state)) return "interrupted";
        await failRun(state, runId, { error, inputId });
        return "failed";
      }
      await journal.append({ type: "model_turn_completed", run_id: runId, payload: {} });

      // 调用期间可能已到达停止/立即安全点。先落 assistant tool_calls 记录（若本
      // 轮是工具轮），再检查安全点——被打断的回复在中断路径用 cancelled 工具记录
      // 闭合 transcript，绝不留下悬空的 assistant tool_calls（retry/history 复用）。
      const toolCalls = Array.isArray(reply?.toolCalls) && reply.toolCalls.length > 0 ? reply.toolCalls : null;
      if (toolCalls) {
        await journal.appendTranscript({
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc?.id ?? null,
            name: tc?.name ?? null,
            arguments: tc?.arguments ?? null
          }))
        });
      }

      const afterCall = await journal.getSession();
      const runAfterCall = afterCall.active_run;
      if (!runAfterCall || runAfterCall.id !== runId || TERMINAL_RUN_STATUSES.has(runAfterCall.status)) {
        await closeDroppedToolCalls(state, toolCalls);
        return "terminated";
      }
      if (runAfterCall.status === "stopping") {
        await closeDroppedToolCalls(state, toolCalls);
        await cancelRunForStop(state, state.stopReason);
        return "stopped";
      }
      if (runAfterCall.status === "interrupting" || state.controller?.signal.aborted) {
        // 被打断的模型回复不再处理；安全点后读取最新输入（被提升的输入）
        await closeDroppedToolCalls(state, toolCalls);
        await journal.append({ type: "interrupt_safe_point_reached", run_id: runId, payload: {} });
        resetController(state);
        return "interrupted";
      }

      if (toolCalls) {
        for (let index = 0; index < toolCalls.length; index += 1) {
          const toolCall = toolCalls[index];
          // 停止/立即安全点：阻止新工具启动，等待当前原子操作；尚未执行的
          // 工具调用用 cancelled 记录闭合 transcript
          const beforeTool = await journal.getSession();
          const runBeforeTool = beforeTool.active_run;
          if (!runBeforeTool || runBeforeTool.id !== runId || TERMINAL_RUN_STATUSES.has(runBeforeTool.status)) {
            await closeDroppedToolCalls(state, toolCalls.slice(index));
            return "terminated";
          }
          if (runBeforeTool.status === "stopping") {
            await closeDroppedToolCalls(state, toolCalls.slice(index));
            await cancelRunForStop(state, state.stopReason);
            return "stopped";
          }
          if (runBeforeTool.status === "interrupting" || state.controller?.signal.aborted) {
            await closeDroppedToolCalls(state, toolCalls.slice(index));
            await journal.append({ type: "interrupt_safe_point_reached", run_id: runId, payload: {} });
            resetController(state);
            return "interrupted";
          }
          const toolResult = await tools.execute(toolCall, {
            projectRoot: state.key,
            project,
            run_id: runId,
            active_input_id: inputId,
            signal: state.controller?.signal
          });
          await journal.appendTranscript({
            role: "tool",
            tool_call_id: toolCall?.id ?? toolCall?.tool_call_id ?? null,
            name: toolCall?.name ?? null,
            content: JSON.stringify(toolResult)
          });
        }
        continue; // 工具结果已入 transcript，继续下一模型轮次
      }

      // ---- 文本回复：当前输入完成 ----
      const text = String(reply?.text ?? "");
      await journal.appendTranscript({ role: "assistant", content: text });
      await journal.append({
        type: "assistant_message_completed",
        run_id: runId,
        payload: { input_id: inputId }
      });
      const beforeConsume = await journal.getSession();
      const grantsOfInput =
        beforeConsume.active_run?.active_grants?.filter((grant) => grant.input_id === inputId) ?? [];
      const completionBatch = [];
      if (await needsCompletionConsumed(journal, runId, inputId)) {
        completionBatch.push({ type: "input_consumed", run_id: runId, payload: { input_id: inputId } });
      }
      for (const grant of grantsOfInput) {
        completionBatch.push({
          type: "permission_grant_cleared",
          run_id: runId,
          payload: { grant_id: grant.id, input_id: grant.input_id, grant_key: grant.grant_key, reason: "input_consumed" }
        });
      }
      await journal.appendBatch(completionBatch);
      return "done";
    }
  }

  // 输入完成后的队列推进 / Run 终结：在项目互斥锁内完成读-判-写，杜绝与 submit
  // 的竞态（submit 恰落在「队列判空」与「run_completed 落盘」之间时，新输入会
  // 滞留跨 Run 边界）。返回 "advance" | "completed" | "interrupting" | "stopping"
  // | "terminal" | "gone"。
  async function advanceOrComplete(state, runId) {
    return state.mutex.run(async () => {
      const session = await state.journal.getSession();
      const run = session.active_run;
      if (!run || run.id !== runId) return "gone";
      if (TERMINAL_RUN_STATUSES.has(run.status)) return "terminal";
      if (run.status === "stopping") return "stopping";
      if (run.status === "interrupting" || state.controller?.signal.aborted) return "interrupting";
      if (session.queued_inputs.length > 0) {
        await state.journal.append({
          type: "input_consumed",
          run_id: runId,
          payload: { input_id: session.queued_inputs[0].id }
        });
        return "advance";
      }
      await state.journal.append({ type: "run_completed", run_id: runId, payload: {} });
      return "completed";
    });
  }

  // 外层循环：逐个消费输入；队列清空且满足完成条件后 Run 终结。
  async function runLoop(state, runId) {
    while (true) {
      const session = await state.journal.getSession();
      const run = session.active_run;
      if (!run || run.id !== runId) return;
      if (TERMINAL_RUN_STATUSES.has(run.status)) return;
      if (run.status === "stopping") {
        await cancelRunForStop(state, state.stopReason);
        return;
      }
      if (run.status === "interrupting" || state.controller?.signal.aborted) {
        await state.journal.append({ type: "interrupt_safe_point_reached", run_id: runId, payload: {} });
        resetController(state);
        continue;
      }

      const inputId = run.active_input_id;
      if (inputId === null) {
        // 无活动输入：互斥锁内激活队首或自然终结（兜底路径）
        const fallback = await advanceOrComplete(state, runId);
        if (fallback === "advance" || fallback === "interrupting" || fallback === "stopping") continue;
        return;
      }

      const inputText = await findInputText(state.journal, inputId);
      if (inputText === null) {
        // 恢复的日志中找不到该输入（陈旧记录）：消费跳过，避免卡死
        await state.journal.append({ type: "input_consumed", run_id: runId, payload: { input_id: inputId } });
        continue;
      }

      const outcome = await processInput(state, runId, inputId, inputText);
      if (outcome === "stopped" || outcome === "failed" || outcome === "terminated") return;
      if (outcome === "interrupted") continue; // 立即：重新读取状态与被提升的输入

      // 输入完成：互斥锁内复查队列并推进/终结（阻断 submit 竞态滞留）
      const after = await advanceOrComplete(state, runId);
      if (after === "advance" || after === "interrupting" || after === "stopping") continue;
      return; // completed / terminal / gone
    }
  }

  // 启动（或接续）当前 Run 的循环。同项目一次只有一个循环：已绑定的循环返回
  // 原 Promise；旧循环收尾期间的新 Run 先等待旧循环结束再开始（避免双循环）。
  // firstTurn 信号：本轮循环第一次模型轮次开始（model_turn_started 已落盘）时
  // resolve；submit 创建 Run 后等待它，保证调用方拿到控制权时模型轮次已在飞行
  // （「立即」在飞行期间到达，被打断的输入才有可打断的活动），循环结束也 resolve
  // 以免停止先于首轮时悬挂等待者。
  function startLoop(state, runId) {
    if (state.loopPromise && state.runId === runId) return state.loopPromise;
    const previous = state.loopPromise;
    let resolveFirstTurn;
    const firstTurn = new Promise((resolve) => {
      resolveFirstTurn = resolve;
    });
    state.runId = runId;
    state.controller = new AbortController();
    state.stopReason = "user_stop";
    state.firstTurn = { promise: firstTurn, resolve: resolveFirstTurn, resolved: false };
    const promise = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          // 旧循环异常已在其自身兜底；只等待收尾
        }
      }
      try {
        await runLoop(state, runId);
      } catch (error) {
        // 兜底：循环异常时把 Run 收敛为 failed，绝不悬挂项目
        try {
          const session = await state.journal.getSession();
          const run = session.active_run;
          if (run && run.id === runId && !TERMINAL_RUN_STATUSES.has(run.status)) {
            await failRun(state, runId, {
              error: { message: String(error?.message ?? error), code: "runtime_error" },
              inputId: run.active_input_id
            });
          }
        } catch {
          // journal 已不可用：放弃
        }
      } finally {
        state.firstTurn?.resolve();
        if (state.loopPromise === promise) {
          state.loopPromise = null;
          state.runId = null;
          state.controller = null;
          state.firstTurn = null;
        }
      }
    })();
    state.loopPromise = promise;
    return promise;
  }

  // 等待循环开始第一次模型轮次（或循环结束），带超时兜底。
  // 超时兜底必须显式 clearTimeout：Promise.race 不会取消落选方，遗留的 10s
  // 定时器会让进程空转（Task 7 观测到的残留 handle，focused tests 无法退出）。
  async function waitForFirstTurn(state) {
    const signal = state.firstTurn;
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

  // -------------------------------------------------------------------------
  // 等待辅助（promote/stop 与运行中循环的安全点衔接）
  // -------------------------------------------------------------------------

  // 等待 Run 离开中间态：回到 running（安全点已到）或终结。
  async function waitForRunResolved(state, runId, { timeoutMs = IDLE_WAIT_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = await state.journal.getSession();
      const run = session.active_run;
      if (!run || run.id !== runId) return "gone";
      if (TERMINAL_RUN_STATUSES.has(run.status)) return "terminal";
      if (run.status === "running") return "running";
      await sleep(10);
    }
    return "timeout";
  }

  async function waitForIdle(state, { timeoutMs = IDLE_WAIT_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = await state.journal.getSession();
      if (session.status === "idle") return;
      await sleep(10);
    }
    throw fail("stop_timeout", "等待 Run 停止超时。");
  }

  // -------------------------------------------------------------------------
  // 公共接口
  // -------------------------------------------------------------------------

  async function open({ projectRoot }) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    const state = ensureProject(projectRoot);
    await state.journal.load();
    // Task 7：首次 open 对旧项目执行一次性只读 legacy 导入（幂等）。导入失败不
    // 阻塞 open：journal 已恢复、应用可继续工作；migration.json.legacy_imported
    // 保持 false，下次 open() 重试（legacy-import 的 legacy_id / legacy 标记保证
    // 重试不产生重复事件或消息）。
    try {
      await runLegacyImport({ projectRoot: state.key, journal: state.journal, idFactory });
    } catch (error) {
      console.warn(`[agent] legacy 导入失败（下次 open 重试）: ${error?.message ?? String(error)}`);
    }
    // 恢复：只恢复有效非终态 Run（journal.load 已把 dangling assistant 活动标记
    // 为 interrupted；那些 Run 等待 retry，不自动恢复；legacy 导入的未完成 Run
    // 是合法非终态，按同一语义接续执行）
    const session = await state.journal.getSession();
    const run = session.active_run;
    if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
      startLoop(state, run.id);
    }
    return { session_id: session.session_id, status: session.status };
  }

  async function submit({ projectRoot, text, source = "chat" }) {
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
    await state.journal.load();
    // 互斥锁内只做读-判-写与循环启动；waitForFirstTurn 必须在锁外等待（循环的
    // 安全点路径 cancelRunForStop/advanceOrComplete 需要取同一把锁，锁内等待会死锁）。
    const created = await state.mutex.run(async () => {
      const session = await state.journal.getSession();
      const run = session.active_run;
      const inputId = idFactory();
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
        // 空闲：创建新 Run
        const runId = idFactory();
        await state.journal.appendBatch([
          {
            type: "input_queued",
            payload: { input_id: inputId, text, source }
          },
          {
            type: "run_started",
            run_id: runId,
            payload: { workflow: "general", input_id: inputId }
          }
        ]);
        startLoop(state, runId);
        return { input_id: inputId, run_id: runId, queued: false };
      }
      // 运行中：FIFO 队列
      await state.journal.append({
        type: "input_queued",
        payload: { input_id: inputId, text, source }
      });
      return { input_id: inputId, run_id: run.id, queued: true };
    });
    if (!created.queued) {
      // 等待第一个模型轮次开始（或循环已结束）：保证调用方拿到控制权时
      // 「立即」/「停止」有飞行中的活动可打断（输入落盘仍先于 resolve）
      await waitForFirstTurn(state);
    }
    return created;
  }

  async function promote({ projectRoot, inputId }) {
    if (typeof inputId !== "string" || inputId.length === 0) {
      throw fail("invalid_input_id", "inputId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    await state.journal.load();
    // 预检查 + 批次落盘在项目互斥锁内原子完成：并发双 promote 不会同时通过
    // 预检查；stop/submit 与 promote 的读-判-写互斥。
    const runId = await state.mutex.run(async () => {
      const session = await state.journal.getSession();
      const run = session.active_run;
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
        throw fail("no_active_run", "当前没有可打断的活动 Run。");
      }
      // 停止优先于「立即」（Task 6 规格审查）：stopping 状态上拒绝提升（reducer
      // 侧还有第二道守卫）；已有中断在途时拒绝并发第二个提升。
      if (run.status === "stopping") {
        throw fail("run_stopping", "Run 正在停止，无法提升输入。");
      }
      if (run.status === "interrupting") {
        throw fail("interrupt_pending", "已有中断在途，请等待当前中断完成后再提升。");
      }
      if (!session.queued_inputs.some((item) => item.id === inputId)) {
        throw fail("input_not_queued", "该输入不在排队队列中。");
      }
      // 同一批次原子写入：interrupt_requested + input_promoted + 旧活动输入 grant 清除
      const grantsOfActive = run.active_grants.filter((grant) => grant.input_id === run.active_input_id);
      const batch = [
        { type: "interrupt_requested", run_id: run.id, payload: {} },
        { type: "input_promoted", run_id: run.id, payload: { input_id: inputId } }
      ];
      for (const grant of grantsOfActive) {
        batch.push({
          type: "permission_grant_cleared",
          run_id: run.id,
          payload: { grant_id: grant.id, input_id: grant.input_id, grant_key: grant.grant_key, reason: "input_promoted" }
        });
      }
      try {
        await state.journal.appendBatch(batch);
      } catch (error) {
        if (error?.message?.includes("需要活动 Run") || error?.message?.includes("非排队") || error?.message?.includes("正在停止")) {
          throw fail("promote_failed", "无法提升该输入：Run 已终结、正在停止或输入已被消费。");
        }
        throw error;
      }
      return run.id;
    });
    // abort 活动模型请求或可中断工具，等待原子操作到达安全点
    abortController(state);
    const outcome = await waitForRunResolved(state, runId);
    if (outcome === "timeout") {
      throw fail("promote_timeout", "等待中断安全点超时。");
    }
    if (outcome !== "running") {
      // 提升期间 Run 被 stop/自然终结：不误报成功（输入可能已被取消）
      return { run_id: runId, input_id: inputId, promoted: false, reason: outcome };
    }
    return { run_id: runId, input_id: inputId, promoted: true };
  }

  async function decide({ projectRoot, decisionId, choice }) {
    if (typeof decisionId !== "string" || decisionId.length === 0) {
      throw fail("invalid_decision_id", "decisionId 必须是非空字符串。");
    }
    if (typeof choice !== "string" || choice.length === 0) {
      throw fail("invalid_choice", "choice 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    await state.journal.load();
    return state.tools.resolveDecision({ decisionId, choice, confirmationText: choice });
  }

  async function stop({ projectRoot, reason = "user_stop" }) {
    const state = ensureProject(projectRoot);
    await state.journal.load();
    const session = await state.journal.getSession();
    const run = session.active_run;
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
      return { run_id: null, cancelled: false }; // 没有可停止的 Run：无操作
    }
    if (run.status === "stopping") {
      await waitForIdle(state);
      return { run_id: run.id, cancelled: true };
    }
    try {
      await state.journal.append({
        type: "run_status_changed",
        run_id: run.id,
        payload: { status: "stopping", reason }
      });
    } catch (error) {
      // 竞态：Run 恰在此时终结，停止自然失效（reducer 拒绝终结状态上的
      // run_status_changed）；真实 journal 错误必须 abort + 上抛，不能吞掉。
      const message = error?.message ?? "";
      if (message.includes("需要活动 Run") || message.includes("必须携带 retry") || message.includes("不能再次进入")) {
        return { run_id: run.id, cancelled: false };
      }
      abortController(state);
      throw error;
    }
    state.stopReason = reason;
    abortController(state);
    await waitForIdle(state);
    return { run_id: run.id, cancelled: true };
  }

  // 从 journal 事件找回可恢复 Run 的未终结输入（run_failed 记录了 input_id；
  // 崩溃恢复的 run_interrupted 没有，则退回 run_started/input_promoted 的信息）。
  async function findTerminalInputId(journal, runId) {
    const events = await journal.read({ afterSeq: 0, limit: 100000 });
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
      if (event.type === "run_started" && typeof event.payload?.input_id === "string") {
        return event.payload.input_id;
      }
    }
    // 兜底：崩溃现场尚未终结的 input（事件里存在 input_queued 且无终态事件）
    const terminal = new Set(
      runEvents
        .filter((event) => event.type === "input_consumed" || event.type === "input_cancelled")
        .map((event) => event.payload?.input_id)
    );
    const openInputs = runEvents
      .filter((event) => event.type === "input_queued" && !terminal.has(event.payload?.input_id))
      .map((event) => event.payload?.input_id);
    return openInputs.length > 0 ? openInputs[openInputs.length - 1] : null;
  }

  async function retry({ projectRoot, runId }) {
    if (typeof runId !== "string" || runId.length === 0) {
      throw fail("invalid_run_id", "runId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    await state.journal.load();
    return state.mutex.run(async () => {
      const session = await state.journal.getSession();
      const run = session.active_run;
      if (!run) throw fail("run_not_found", "没有可恢复的 Run。");
      if (run.id !== runId) throw fail("run_not_found", `Run ${runId} 不是当前会话的 Run。`);
      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
        throw fail("run_not_recoverable", `Run 处于 ${run.status}，无需重试。`);
      }
      if (run.status !== "failed" && run.status !== "interrupted") {
        throw fail("run_not_recoverable", `只有 failed/interrupted 的 Run 可以重试，当前为 ${run.status}。`);
      }
      let inputId = await findTerminalInputId(state.journal, runId);
      if (inputId === null) {
        // 兜底：以 transcript 最近一条用户消息重建输入（崩溃现场无 input 记录）
        const records = await state.journal.readTranscript();
        const lastUser = [...records].reverse().find((record) => record?.role === "user");
        inputId = idFactory();
        await state.journal.append({
          type: "input_queued",
          payload: { input_id: inputId, text: String(lastUser?.content ?? "继续执行") }
        });
      }
      await state.journal.append({
        type: "run_started",
        run_id: runId,
        payload: { workflow: run.workflow, input_id: inputId }
      });
      startLoop(state, runId);
      return { run_id: runId, input_id: inputId, retried: true };
    });
  }

  async function snapshot({ projectRoot, afterSeq = 0, limit = 100 } = {}) {
    const state = ensureProject(projectRoot);
    await state.journal.load();
    const session = await state.journal.getSession();
    const events = await state.journal.read({ afterSeq, limit });
    return { session, events };
  }

  return { open, submit, promote, decide, stop, retry, snapshot };
}
