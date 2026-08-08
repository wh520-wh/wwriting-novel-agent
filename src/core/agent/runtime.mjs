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
//     Available Skills 目录摘要 / workflow policy / dynamic context / history /
//     currentInput）→ gateway.complete →
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
import { estimateRequestUsage, observeProviderUsage } from "./context-window.mjs";
import { canEnterWorkflow, workflowPolicy } from "./workflows.mjs";
import { runLegacyImport } from "./legacy-import.mjs";
import { migrateProjectAgentStorage } from "../workspaces/migration.mjs";
import { loadProject } from "../project-store.mjs";
import { pathExists } from "../fs-utils.mjs";
import { readProjectMemory } from "../project-memory.mjs";
import { createRedactor } from "../shell/redaction.mjs";
import { resolveModelCapabilities } from "../model/capabilities.mjs";
import { parseModelIdentity } from "../model/model-identity.mjs";
import { createJournalDeltaWriter, reasoningAvailability } from "./stream-writer.mjs";
import { skillService } from "../skills/index.mjs";

import {
  appendChapterSegment,
  commitChapter,
  commitChapterMemory,
  inspectChapterContext
} from "../project-operations/chapter.mjs";
import { commitBlueprint, inspectBlueprintContext } from "../project-operations/blueprint.mjs";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

// 通用工具恒可用于所有 workflow（Task 12：read_skill 让所有工作流都能按需读技能；
// Task 9：count_text 是只读客观字数工具，同样对所有工作流可见）。
const GENERAL_TOOL_NAMES = new Set([
  "list_files",
  "search_files",
  "read_file",
  "write_file",
  "edit_file",
  "shell",
  "read_skill",
  "count_text"
]);

const SOURCES = new Set(["chat", "maintenance"]);

// 停止/提升等待上限。语义说明（Task 6 规格审查 Minor）：stop 在 abort 信号发出后
// 等待循环收敛（可中断工具被杀、循环追加终态批次），正常只需毫秒级；60s 上限只
// 防御循环异常悬挂。长原子操作（不可中断提交）不受 abort 影响也会在毫秒级完成，
// 不会接近该上限。
const IDLE_WAIT_TIMEOUT_MS = 60000;
const ASSISTANT_DELTA_FLUSH_MS = 24;
const ASSISTANT_DELTA_MAX_PENDING_CHARS = 2048;

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
  // Task 9 接线：composition root 可注入 gatewayFactory(projectRoot) -> gateway，
  // 让每个项目持有独立的 ModelGateway（per-project CostTracker/cost.json 记账）。
  // 与 modelGateway 二选一；测试 harness 继续只传 modelGateway。
  gatewayFactory = null,
  shell = null,
  projectLocks = null,
  secrets = [],
  // Task 12：skills service seam（src/core/skills/index.mjs）。生产缺省用全局
  // 单例；测试注入临时 root 的 service，避免迁移 marker 写进真实用户目录。
  skills = null,
  idFactory = randomUUID,
  // Task 3：journal 落盘位置（生产组合根必须显式传应用私有 storageRoot；默认
  // 项目内 .wwriting/agent 只保留给低层兼容测试）与旧 journal 只读迁移器。
  agentStorageRootFor = (projectRoot) => path.join(projectRoot, ".wwriting", "agent"),
  workspaceMigrator = migrateProjectAgentStorage,
  // Task 5：每模型轮读取有效工作区配置的加载器（组合根注入 loadEffectiveWorkspaceConfig
  // + 全局默认模型兜底）。缺省读 project.yaml（与旧 loadProjectSafe 语义一致），供低层
  // 测试与无注入调用方使用。每轮调用、不在 Runtime 缓存整份配置——模型/权限切换在下一
  // 模型轮自然生效。
  workspaceConfigLoader = null
} = {}) {
  if (!modelGateway && typeof gatewayFactory !== "function") {
    throw new TypeError("createProjectAgent 需要注入带 complete(request, { signal }) 的 modelGateway");
  }
  const resolveGateway = typeof gatewayFactory === "function" ? gatewayFactory : () => modelGateway;
  const redactor = createRedactor({ secrets });
  // 技能 service：注入优先，缺省全局单例（生产组合根不传，catalog 迁移先行）。
  const projectSkills = skills ?? skillService;

  const projects = new Map(); // projectRoot -> project state

  function ensureProject(projectRoot) {
    const key = path.resolve(projectRoot);
    let state = projects.get(key);
    if (!state) {
      const journal = createAgentJournal({
        projectRoot: key,
        storageRoot: agentStorageRootFor(key),
        idFactory
      });
      const projectOperations = {
        inspectChapterContext,
        appendChapterSegment,
        // Task 10：commitChapter 只保留存储安全约束，不再消费技能注入（确定性
        // 技能钩子已删除）；直接透传原函数，保持写探针 options 兼容。
        commitChapter,
        commitChapterMemory,
        inspectBlueprintContext,
        commitBlueprint
      };
      const tools = createToolRuntime({
        projectOperations,
        journal,
        shellRuntime: shell,
        projectLocks,
        secrets,
        skills: projectSkills,
        idFactory
      });
      state = {
        key,
        journal,
        tools,
        projectOperations,
        modelGateway: resolveGateway(key),
        skills: projectSkills,
        // 当前 Run 的循环控制（一次一个模型/工具循环）
        runId: null,
        controller: null,
        loopPromise: null,
        firstTurn: null,
        stopReason: "user_stop",
        mutex: createMutex(),
        // Task 6：当前 session 的上下文估算校准倍率（provider usage 的 EMA 比例，
        // 夹在 0.5..2.0，只属于当前 session；clearHistory 时一并复位）。null 表示
        // 尚无 provider 观测，估算用默认倍率 1 并保持 approximate。
        contextCalibration: null,
        // Prompt 的 Available Skills 目录摘要：只取 name/description，绝不注入正文
        // （完整指令由 read_skill 按需读取）。catalog 失败不阻塞 agent（沿用兜底语义）。
        // 每 runId 记忆一次发现结果（Important 4）：模型每个轮次都会走到这里，
        // 不记忆则每个轮次都要重读 + YAML 解析全部 SKILL.md 并遍历资源树。
        catalogCache: null,
        readSkillCatalog: async () => {
          if (state.catalogCache && state.catalogCache.runId === state.runId) {
            return state.catalogCache.promise;
          }
          const promise = (async () => {
            try {
              const { active } = await projectSkills.catalog({ projectRoot: key });
              return active.map((skill) => ({ name: skill.name, description: skill.description ?? "" }));
            } catch {
              return [];
            }
          })();
          state.catalogCache = { runId: state.runId, promise };
          return promise;
        }
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
  // operations 自行校验）。兜底对象永不被持久化。Task 12：enabled_skills 已废弃。
  const FALLBACK_PROJECT = Object.freeze({
    project_id: null,
    tool_permissions: {},
    output_format: "md",
    archived_at: null,
    active_model: null,
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

  // 有效配置加载器：注入优先，缺省回退 loadProjectSafe（旧语义）。
  const resolveWorkspaceConfig = typeof workspaceConfigLoader === "function"
    ? workspaceConfigLoader
    : loadProjectSafe;

  function permissionModeOf(project) {
    const tp = project?.tool_permissions ?? {};
    if (tp.yolo === true) return "yolo";
    if (tp.auto_edit === true) return "trusted";
    return "ask";
  }

  function modelConfigOf(project) {
    const active = project?.active_model ?? {};
    // Task 2：有效上下文窗口由模型 ID 尾标解析（[1m]/[1M] → 1M，缺省 256k），
    // 不再读取 project.context_window。持久配置保持原样：只覆盖运行时副本
    // （model_name 为剥离尾标后的 provider 基础 ID），绝不写回 active_model。
    const identity = parseModelIdentity(active.model_name ?? "");
    return {
      ...active,
      provider: typeof active.provider === "string" ? active.provider : "unknown",
      configured_model_id: identity.configured_model_id,
      model_name: identity.provider_model_id,
      effective_context_window: identity.effective_context_window,
      compaction_threshold: identity.compaction_threshold,
      window_source: identity.window_source,
      // 项目级思考强度（project.yaml.reasoning_effort）：仅透传，是否真正发送
      // 由 adapter 按模型 capability（reasoningEffortLevels）决定，auto/缺省不发。
      ...(typeof project?.reasoning_effort === "string" ? { reasoning_effort: project.reasoning_effort } : {})
    };
  }

  // transcript 记录 → 干净的 OpenAI 消息形状（去掉 input_id 等内部字段）。
  // assistant 的 tool_calls 必须还原为 OpenAI 线上格式（{ id, type: "function",
  // function: { name, arguments: JSON 字符串 } }）——transcript 里存的是内部规范
  // 形状 { id, name, arguments(对象) }（Task 11 Step 4 真实模型验证发现 DeepSeek/
  // 小米等 OpenAI-compatible 提供方对扁平 tool_calls 直接 400）。
  //
  // Rule 7 职责边界：wire 转换放在 runtime（而不是 adapter）的取舍——runtime 是
  // 唯一同时拥有 transcript 内部形状与「请求必须适配提供方言」信息的装配点，
  // adapter 保持窄而薄（只做传输与响应归一化）。当前线上形状按 OpenAI 方言
  // 固定；未来若接入要求其它 tool_calls 形状的提供方（如 Anthropic 的
  // { id, name, input }），应由 provider-aware 转换（在 gateway 的
  // dispatchAdapter 或按 provider 分支的 serializer）扩展，不要改 transcript 形状。
  function transcriptToMessages(records) {
    const messages = [];
    for (const record of records) {
      if (record?.role === "user") {
        messages.push({ role: "user", content: String(record.content ?? "") });
      } else if (record?.role === "assistant") {
        const message = { role: "assistant", content: record.content ?? null };
        if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
          message.tool_calls = record.tool_calls.map((tc) => {
            const rawArguments = tc?.arguments;
            // 线上格式要求 arguments 是 JSON 对象字符串。number/boolean 等标量
            // 不是合法 arguments 对象，序列化后同样不是对象——统一回落空对象，
            // 避免把 "5" 这类字符串当参数发给提供方。
            const argumentsText =
              rawArguments != null && typeof rawArguments === "object"
                ? JSON.stringify(rawArguments)
                : typeof rawArguments === "string"
                  ? rawArguments
                  : "{}";
            return {
              id: tc?.id ?? null,
              type: "function",
              function: {
                name: tc?.name ?? null,
                arguments: argumentsText
              }
            };
          });
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
  async function buildHistory(journal, excludeInputId = null, volatileRecords = []) {
    const records = await journal.readTranscript();
    const volatileToolCallIds = new Set();
    for (const record of volatileRecords) {
      if (record?.role === "tool") volatileToolCallIds.add(record.tool_call_id ?? null);
      for (const toolCall of record?.tool_calls ?? []) {
        volatileToolCallIds.add(toolCall?.id ?? null);
      }
    }
    const filteredByInput =
      excludeInputId === null
        ? records
        : records.filter((record) => !(record.input_id != null && record.input_id === excludeInputId));
    const filtered = filteredByInput.filter((record) => {
      if (record?.role === "tool") return !volatileToolCallIds.has(record.tool_call_id);
      if (record?.role === "assistant" && Array.isArray(record.tool_calls)) {
        return !record.tool_calls.some((toolCall) => volatileToolCallIds.has(toolCall?.id));
      }
      return true;
    });
    return transcriptToMessages([...filtered, ...volatileRecords]);
  }

  function redactTranscriptRecord(record) {
    try {
      return JSON.parse(redactor.redact(JSON.stringify(record)));
    } catch {
      return { role: record?.role ?? "note", content: "[REDACTED]" };
    }
  }

  async function appendSafeTranscript(journal, record) {
    await journal.appendTranscript(redactTranscriptRecord(record));
  }

  function persistentToolResult(name, toolResult) {
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
    if (persisted?.ok && persisted.result && name === "search_files" && Array.isArray(persisted.result.matches)) {
      persisted.result.matches = persisted.result.matches.map(({ excerpt: _excerpt, ...match }) => match);
    }
    return persisted;
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
    await appendSafeTranscript(journal, { role: "user", content: inputText, input_id: inputId });
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
      await appendSafeTranscript(state.journal, {
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
    const volatileToolRecords = [];
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
      const project = await resolveWorkspaceConfig(state.key);
      const policy = workflowPolicy(run.workflow);
      const modelConfig = modelConfigOf(project);
      // Task 6：每个模型轮重新读取 WWRITING.md（新对话、上下文压缩后的下一轮、
      // 模型切换、retry 和应用重启都会重新读取）。readProjectMemory 容错：缺失
      // 返回空、不可读返回 unreadable 标记，绝不阻止 prompt、不把全文永久缓存到
      // ensureProject() state。
      const projectMemory = await readProjectMemory(state.key);
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
        projectMemory,
        workflow: run.workflow,
        skillCatalog: await state.readSkillCatalog(),
        dynamicContext: await policy.contextSelector({
          projectRoot: state.key,
          session,
          project,
          inputText
        }).catch(() => []),
        history: await buildHistory(journal, inputId, volatileToolRecords),
        currentInput: inputText,
        tools: allowedDefinitions(tools, policy),
        modelConfig
      });
      // gateway 契约（src/core/model/gateway.mjs）：request 必须是装配完成的模型
      // 请求 { messages, tools, toolChoice, modelConfig, stream, metadata }——
      // 模型与阶段配置由 runtime 解析后放入 modelConfig（base_url/model_name/
      // api_key_env 等），adapter 依赖它选择模型与读取密钥。assemblePrompt 的预算
      // 直接消费 effective_context_window（Task 2 起 modelConfigOf 恒提供该字段），
      // 不负责回填，这里在调用前挂载。
      request.modelConfig = modelConfig;
      request.stream = true;
      // Task 6：统一上下文门禁预检。估算的唯一输入是已装配完成的最终 request——
      // currentInput 已由 assemblePrompt 放入最后一条 user message，这里绝不再把
      // currentInput 单独传入（单输入规则，避免双算）。每次预检追加
      // context_usage_updated，payload 只含数字与模型基础 ID，不含 prompt 原文。
      const contextEstimate = estimateRequestUsage({
        messages: request.messages,
        tools: request.tools ?? [],
        effectiveContextWindow: modelConfig.effective_context_window,
        calibration: state.contextCalibration ?? 1
      });
      await journal.append({
        type: "context_usage_updated",
        run_id: runId,
        payload: {
          usage: { ...contextEstimate, model: modelConfig.model_name }
        }
      });
      // 每个 Provider 轮次拥有稳定 turn id（v2 事件契约 §2.3）与独立 writer 对：
      // onToken 只接收公开正文、onReasoningToken 只接收 reasoning，两者不得互相
      // 兜底（§2.1）；reasoning 只经 reasoning_delta/reasoning_completed 进入
      // journal，绝不写入 provider history。
      const modelCaps = resolveModelCapabilities(modelConfig);
      const turnId = idFactory();
      const assistantWriter = createJournalDeltaWriter({
        journal,
        eventType: "assistant_message_delta",
        runId,
        basePayload: { input_id: inputId },
        secrets,
        flushMs: ASSISTANT_DELTA_FLUSH_MS,
        maxPendingChars: ASSISTANT_DELTA_MAX_PENDING_CHARS
      });
      const reasoningWriter = createJournalDeltaWriter({
        journal,
        eventType: "reasoning_delta",
        runId,
        basePayload: { turn_id: turnId, input_id: inputId },
        secrets,
        flushMs: ASSISTANT_DELTA_FLUSH_MS,
        maxPendingChars: ASSISTANT_DELTA_MAX_PENDING_CHARS
      });
      request.metadata = {
        ...(request.metadata ?? {}),
        onToken: (token) => assistantWriter.push(token),
        onReasoningToken: (token) => reasoningWriter.push(token)
      };

      // ---- 模型轮次（成功/失败/取消都必须完整闭合 model turn）----
      await journal.append({
        type: "model_turn_started",
        run_id: runId,
        payload: {
          turn_id: turnId,
          input_id: inputId,
          reasoning_capability: modelCaps.reasoningContent
        }
      });
      if (state.firstTurn && !state.firstTurn.resolved) {
        state.firstTurn.resolved = true;
        state.firstTurn.resolve();
      }
      // 每条 model turn 恰好一次 reasoning_completed + model_turn_completed
      //（v2 冻结契约 §2.3 顺序：先以 safe text 闭合 reasoning，再闭合 turn）。
      const closeTurn = async ({ outcome, reasoningText }) => {
        await journal.append({
          type: "reasoning_completed",
          run_id: runId,
          payload: {
            turn_id: turnId,
            input_id: inputId,
            text: reasoningText,
            availability: reasoningAvailability(modelCaps.reasoningContent, reasoningText)
          }
        });
        await journal.append({
          type: "model_turn_completed",
          run_id: runId,
          payload: { turn_id: turnId, input_id: inputId, outcome }
        });
      };
      let reply;
      let streamedReply = null;
      let reasoningResult = null;
      try {
        reply = await state.modelGateway.complete(request, { signal: state.controller?.signal });
        const finalRawText = String(reply?.text ?? "");
        // 兼容只漏掉尾帧回调、但最终响应正文完整的 Gateway：仅当前缀严格一致时
        // 补入尾部；完全不触发 onToken 的非流式 Gateway 不制造伪增量。
        if (assistantWriter.rawText.length > 0 && finalRawText.startsWith(assistantWriter.rawText)) {
          assistantWriter.push(finalRawText.slice(assistantWriter.rawText.length));
        }
        streamedReply = await assistantWriter.finish();
        reasoningResult = await reasoningWriter.finish();
        // Task 6 校准（成功路径）：provider 返回 input usage 后更新当前 session 的
        // EMA 倍率（夹在 0.5..2.0）。校准只影响下一次本地估算；无 input usage 时
        // 维持 approximate。同样追加 context_usage_updated，payload 只含数字与
        // 模型基础 ID。
        const calibration = observeProviderUsage({
          estimated: contextEstimate,
          usageReport: reply?.usageReport,
          previousCalibration: state.contextCalibration
        });
        if (calibration.calibration != null) state.contextCalibration = calibration.calibration;
        const calibratedEstimate = estimateRequestUsage({
          messages: request.messages,
          tools: request.tools ?? [],
          effectiveContextWindow: modelConfig.effective_context_window,
          calibration: state.contextCalibration ?? 1
        });
        calibratedEstimate.approximate = calibration.approximate;
        await journal.append({
          type: "context_usage_updated",
          run_id: runId,
          payload: {
            usage: { ...calibratedEstimate, model: modelConfig.model_name }
          }
        });
      } catch (error) {
        // 失败/取消时只排空已经确认安全的正文前缀，不 flush 可能仍是半截密钥的 carry。
        await assistantWriter.finish({ flushTail: false });
        const partialReasoning = await reasoningWriter.finish({ flushTail: false });
        // 必须以 partial safe reasoning 先闭合 reasoning，再用 failed/cancelled
        // 闭合 turn；turn 闭合失败不再加重失败（journal 已不可用时由崩溃恢复兜底）。
        await closeTurn({
          outcome: isAbort(error, state) ? "cancelled" : "failed",
          reasoningText: partialReasoning.safeText
        }).catch(() => {});
        if (isAbort(error, state)) return "interrupted";
        await failRun(state, runId, { error, inputId });
        return "failed";
      }
      // 成功：先 reasoning_completed 闭合 reasoning，最后 model_turn_completed。
      await closeTurn({ outcome: "completed", reasoningText: reasoningResult.safeText });

      // 调用期间可能已到达停止/立即安全点。先落 assistant tool_calls 记录（若本
      // 轮是工具轮），再检查安全点——被打断的回复在中断路径用 cancelled 工具记录
      // 闭合 transcript，绝不留下悬空的 assistant tool_calls（retry/history 复用）。
      const toolCalls = Array.isArray(reply?.toolCalls) && reply.toolCalls.length > 0 ? reply.toolCalls : null;
      if (toolCalls) {
        const assistantToolRecord = {
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc?.id ?? null,
            name: tc?.name ?? null,
            arguments: tc?.arguments ?? null
          }))
        };
        volatileToolRecords.push(assistantToolRecord);
        await appendSafeTranscript(journal, assistantToolRecord);
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
          const activeToolPolicy = workflowPolicy(runBeforeTool.workflow);
          const toolResult = await tools.execute(toolCall, {
            projectRoot: state.key,
            project,
            run_id: runId,
            active_input_id: inputId,
            allowed_tool_names: [...GENERAL_TOOL_NAMES, ...(activeToolPolicy.allowedDeepTools ?? [])],
            signal: state.controller?.signal
          });
          const toolRecord = {
            role: "tool",
            tool_call_id: toolCall?.id ?? toolCall?.tool_call_id ?? null,
            name: toolCall?.name ?? null,
            content: JSON.stringify(toolResult)
          };
          volatileToolRecords.push(toolRecord);
          await appendSafeTranscript(journal, {
            ...toolRecord,
            content: JSON.stringify(persistentToolResult(toolCall?.name ?? null, toolResult))
          });
        }
        continue; // 工具结果已入 transcript，继续下一模型轮次
      }

      // ---- 文本回复：当前输入完成 ----
      const text = String(reply?.text ?? "");
      // completed 仍以最终回复的一次性脱敏为权威；正常 Provider 契约下，流式
      // redactor 的拼接结果与这里严格一致。非流式 Gateway 没有 delta，直接终态。
      const safeText = redactor.redact(text);
      if (streamedReply?.rawText && streamedReply.safeText !== safeText) {
        const error = new Error("Provider token stream 与最终正文不一致。");
        error.code = "provider_stream_mismatch";
        await failRun(state, runId, { error, inputId });
        return "failed";
      }
      await appendSafeTranscript(journal, { role: "assistant", content: text });
      await journal.append({
        type: "assistant_message_completed",
        run_id: runId,
        payload: { input_id: inputId, text: safeText }
      });
      // 完成批次（input_consumed + grant 清除）的读-判-写放进项目互斥锁，杜绝与
      // cancelRunForStop 交错产生「同一 input 双终态」（input_cancelled 与
      // input_consumed 并存，违反 Task 2 冻结语义）：无论谁先拿到锁，后到者看到的
      // 投影都是终态——Run 已取消/停止时跳过完成批次（停止路径负责取消输入与
      // 清除 grant）；返回 "done" 后由 advanceOrComplete 读到终态收敛。
      await state.mutex.run(async () => {
        const sessionNow = await journal.getSession();
        const runNow = sessionNow.active_run;
        if (!runNow || TERMINAL_RUN_STATUSES.has(runNow.status)) return false;
        const grantsOfInput =
          runNow.active_grants?.filter((grant) => grant.input_id === inputId) ?? [];
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
        if (completionBatch.length > 0) await journal.appendBatch(completionBatch);
        return true;
      });
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
          // Run 结束：清掉 skill catalog 记忆，下次 Run 重新发现（技能可能已变更）。
          state.catalogCache = null;
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
    // Task 3 固定顺序：先迁移旧 .wwriting/agent → journal.load() → 更老的 legacy
    // flat-file import → 恢复 Run。迁移必须发生在 load() 之前，迁移进来的事件对
    // 新会话立即可见；迁移失败/无源数据不阻塞 open（migrator 只返回结果不抛错，
    // 这里再兜一层，绝不把原始文件错误带到 HTTP 层）。
    try {
      await workspaceMigrator({
        projectRoot: state.key,
        targetAgentRoot: agentStorageRootFor(state.key)
      });
    } catch (error) {
      console.warn(`[agent] legacy journal 迁移失败（不影响 open）: ${error?.message ?? String(error)}`);
    }
    await state.journal.load();
    // Task 7：首次 open 对旧项目执行一次性只读 legacy 导入（幂等）。导入失败不
    // 阻塞 open：journal 已恢复、应用可继续工作；migration.legacy_imported 保持
    // false，下次 open() 重试（legacy-import 的 legacy_id / legacy 标记保证重试
    // 不产生重复事件或消息）。
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
    // 计划修复（整支审阅）：submit 前确保 open 序列已执行——幂等（已迁移目录
    // target_not_empty 直接返回；已绑定循环 startLoop 复用现有 Promise）。这同时兜住
    // 启动恢复的选中工作区（不经 /open 路由也能在第一条消息前完成旧 journal 迁移与
    // 崩溃恢复：残留非终态 Run 先被接续，消息再 FIFO 排队而不是挂在死 Run 后面）。
    await open({ projectRoot });
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

  // 快照：{ session, events, gaps, has_more } 是 AgentSurface 的唯一实时数据源。
  // Task 5 双向分页：
  //   tail === true      → journal.readTail({ limit })（首次展示：尾部最新一页）
  //   beforeSeq != null  → journal.readBefore({ beforeSeq, limit })（向上滚动旧页）
  //   否则               → journal.readAfter({ afterSeq, limit })（增量拉取）
  // afterSeq=0 只表示从头读取（旧客户端兼容），AgentSurface 首次打开不得用
  // afterSeq=0 补齐所有历史（前端改用 tail/beforeSeq，Task 9/10 接线）。
  async function snapshot({ projectRoot, afterSeq = 0, beforeSeq = null, tail = false, limit = 100 } = {}) {
    const state = ensureProject(projectRoot);
    await state.journal.load();
    const session = await state.journal.getSession();
    let page;
    if (tail === true) {
      page = await state.journal.readTail({ limit });
    } else if (beforeSeq != null) {
      page = await state.journal.readBefore({ beforeSeq, limit });
    } else {
      page = await state.journal.readAfter({ afterSeq, limit });
    }
    const events = page.events;
    const lastSeq = state.journal.lastSeq;
    let has_more;
    if (tail === true) {
      has_more = events.length > 0 ? events[0].seq > 1 : lastSeq > 0;
    } else if (beforeSeq != null) {
      has_more = events.length > 0 ? events[0].seq > 1 : beforeSeq > 1;
    } else {
      has_more = events.length > 0 ? events.at(-1).seq < lastSeq : lastSeq > afterSeq;
    }
    return { session, events, gaps: page.gaps, has_more };
  }

  // 历史导出（NDJSON 异步流）：只读动作，不追加 Journal 事件；由 journal 层顺序
  // 迭代 events/transcript 两个 segment store，每行 { stream, record }；对每条
  // record 应用 runtime 的 redactor（API key/模型密钥/provider header 脱敏）。
  async function* exportHistory({ projectRoot } = {}) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    const state = ensureProject(projectRoot);
    yield* state.journal.exportHistory({
      redact: (record) => {
        try {
          return JSON.parse(redactor.redact(JSON.stringify(record)));
        } catch {
          return { role: record?.role ?? "note", content: "[REDACTED]" };
        }
      }
    });
  }

  // 不可逆清空：只允许 session idle 且 confirmIrreversible === true（守卫在
  // journal 内、与其 mutex 串行）；成功后清空同一 journal 实例并立即创建新
  // generation + session_created。runtime 侧在项目互斥锁内调用，并清掉本项目的
  // per-Run 循环状态（runId/controller/loopPromise/firstTurn/catalogCache），
  // 保证 projects Map 里不留旧 session 的运行时状态——同一实例立即可用。
  async function clearHistory({ projectRoot, confirmIrreversible = false } = {}) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw fail("invalid_project_root", "projectRoot 必须是非空路径。");
    }
    const state = ensureProject(projectRoot);
    await state.journal.load();
    return state.mutex.run(async () => {
      const result = await state.journal.clearHistory({ confirmIrreversible });
      // 清掉旧 session 的运行时残留（清空只在 idle 时放行，正常无飞行循环；
      // 这里防御性复位，绝不把旧 generation 的高位游标/循环/上下文校准带到新会话）。
      state.runId = null;
      state.controller = null;
      state.loopPromise = null;
      state.firstTurn = null;
      state.catalogCache = null;
      state.contextCalibration = null;
      state.stopReason = "user_stop";
      return {
        session_id: result.session_id,
        status: result.status,
        generation_id: result.generation_id,
        old_session_id: result.old_session_id,
        cleared_dir: result.cleared_dir
      };
    });
  }

  return { open, submit, promote, decide, stop, retry, snapshot, exportHistory, clearHistory };
}
