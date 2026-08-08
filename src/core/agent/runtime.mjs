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
import { estimateRequestUsage, observeProviderUsage, shouldCompact, exceedsHardWindow } from "./context-window.mjs";
import { createContextCheckpointStore } from "./context-checkpoints.mjs";
import { createCompactionCoordinator, COMPACTION_BLOCKED_STATES, COMPACTION_NON_TERMINAL_STATES } from "./compaction.mjs";
import { selectProtectedRecentTurns } from "./compaction-prompt.mjs";
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

// Task 8：无 active checkpoint 时 buildHistory 只读取最近 HISTORY_PAGE_LIMIT 条
// transcript 原文（受保护近期原文 + 门禁所需的向前页），绝不为装配 prompt 把
// 全部 transcript 载入内存；达到阈值即先压缩。
const HISTORY_PAGE_LIMIT = 8000;
// 一轮 = 一条 user input 与其 assistant 正文（与 compaction-prompt.mjs 同义）。
// Task 8：transcript 轮次重建的 tool output 阈值沿用 Task 7 默认。
const CHECKPOINT_FILE_PREFIX = "context-";

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
      const storageRoot = agentStorageRootFor(key);
      const journal = createAgentJournal({
        projectRoot: key,
        storageRoot,
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
        storageRoot,
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
      // Task 8：active context checkpoint 存储 + 压缩协调器（每项目一个）。
      // checkpoint store 与 journal 使用同一 storageRoot（active-context.json /
      // compaction-commit-*.json / checkpoints/ 与 segments/ 同根）。
      state.checkpointStore = createContextCheckpointStore({ agentDir: storageRoot, idFactory });
      state.compactionCoordinator = createCompactionCoordinator({
        journal,
        gateway: state.modelGateway,
        checkpointStore: state.checkpointStore,
        buildInput: (params) =>
          buildCompactionSource({
            journal,
            checkpointStore: state.checkpointStore,
            storageRoot,
            ...params,
            // 进程重启后的 retry 走协调器重建路径，entry.projectRoot 为空——
            // 闭包默认注入本项目根，供 buildCompactionSource 解析当前 modelConfig。
            projectRoot: params.projectRoot ?? key
          }),
        idFactory
      });
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

  // 首次"活动"信号：普通模型轮次（model_turn_started）与压缩调用（Task 8）都
  // 算作 Run 的第一个活动——submit 等待它拿到控制权（「立即」/「停止」需要
  // 飞行中的活动可打断）。
  function resolveFirstTurnIfPending(state) {
    if (state.firstTurn && !state.firstTurn.resolved) {
      state.firstTurn.resolved = true;
      state.firstTurn.resolve();
    }
  }

  // -------------------------------------------------------------------------
  // 模型/工具循环
  // -------------------------------------------------------------------------

  // 从 journal 事件里找回输入元数据（text + kind；findInputMeta 见 Task 8）。
  // 上限语义（Task 6 规格审查 Minor）：只扫描最近 100k 条事件；超出上限的输入
  // 视为找不到（返回 null，runLoop 对该输入做消费跳过）——长会话场景应由 UI 分页
  // 与历史压缩避免依赖无限回溯。
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

  // Task 8：历史装配不再无界读取全部 transcript。有 active checkpoint 时展开
  // 结构化摘要 + checkpoint 近期原文，再 readTranscriptAfter({ afterSeq:
  // checkpoint.source_transcript_seq.end }) 补增量；没有 checkpoint 时只读取
  // 受保护近期原文（尾部一页）——达到阈值由预检门禁先压缩，绝不为装配 prompt
  // 把全部 transcript 载入内存。当前正在处理的输入从历史中排除（它以
  // currentInput 单独入 prompt）。
  async function buildHistory({ journal, checkpointStore, storageRoot, excludeInputId = null, volatileRecords = [] }) {
    const volatileToolCallIds = new Set();
    for (const record of volatileRecords) {
      if (record?.role === "tool") volatileToolCallIds.add(record.tool_call_id ?? null);
      for (const toolCall of record?.tool_calls ?? []) {
        volatileToolCallIds.add(toolCall?.id ?? null);
      }
    }
    const filter = (records) =>
      records
        .filter((record) => !(excludeInputId != null && record.input_id != null && record.input_id === excludeInputId))
        .filter((record) => {
          if (record?.role === "tool") return !volatileToolCallIds.has(record.tool_call_id);
          if (record?.role === "assistant" && Array.isArray(record.tool_calls)) {
            return !record.tool_calls.some((toolCall) => volatileToolCallIds.has(toolCall?.id));
          }
          return true;
        });
    const pointer = await checkpointStore.readActive();
    if (pointer.checkpoint_id != null) {
      const checkpoint = await readCheckpointFile(storageRoot, pointer.checkpoint_id).catch(() => null);
      if (checkpoint != null) {
        const delta = await journal.readTranscriptAfter({ afterSeq: checkpoint.source_transcript_seq?.end ?? 0 });
        return [...checkpointToMessages(checkpoint), ...transcriptToMessages([...filter(delta), ...volatileRecords])];
      }
    }
    const tail = await journal.readTranscriptTail({ limit: HISTORY_PAGE_LIMIT });
    return transcriptToMessages([...filter(tail), ...volatileRecords]);
  }

  // 读取 active checkpoint 正式文件（checkpoints/context-<id>.json）。
  async function readCheckpointFile(storageRoot, checkpointId) {
    const target = path.join(storageRoot, "checkpoints", `${CHECKPOINT_FILE_PREFIX}${checkpointId}.json`);
    return JSON.parse(await fs.readFile(target, "utf8"));
  }

  // 展开 active checkpoint：结构化摘要 → 独立 user 块（历史层），随后是 checkpoint
  // 近期原文（已存为合法消息链，直接作为消息）。open_tool_calls 是恢复元数据，
  // 未闭合调用链本身已包含在 recent_messages 内。
  function checkpointToMessages(checkpoint) {
    const messages = [];
    if (checkpoint?.summary != null && typeof checkpoint.summary === "object") {
      messages.push({ role: "user", content: `[上下文压缩摘要]\n${JSON.stringify(checkpoint.summary, null, 2)}` });
    }
    if (Array.isArray(checkpoint?.recent_messages)) {
      messages.push(...checkpoint.recent_messages);
    }
    return messages;
  }

  // 从 transcript 记录重建"轮次"（一轮 = 一条 user input 与其 assistant 正文）。
  // 返回 selectProtectedRecentTurns 可用的 turns（含 transcript_seq 范围与
  // tool_activities）。transcript 不存 result_summary，已闭合大输出保留原文，
  // 由 protected 窗口语义决定是否进入摘要。
  function buildTurnsFromTranscript(records) {
    const turns = [];
    let current = null;
    const push = () => {
      if (current) turns.push(current);
      current = null;
    };
    const fresh = (seq) => ({
      id: seq != null ? `turn-${seq}` : `turn-${turns.length}`,
      user_text: "",
      assistant_text: null,
      transcript_seq_start: seq,
      transcript_seq_end: seq,
      token_estimate: null,
      tool_activities: []
    });
    for (const record of records ?? []) {
      const seq = record?.transcript_seq ?? null;
      if (record?.role === "user") {
        push();
        current = fresh(seq);
        current.user_text = String(record.content ?? "");
      } else if (record?.role === "assistant") {
        if (!current) current = fresh(seq);
        if (typeof record.content === "string" && record.content.length > 0) current.assistant_text = record.content;
        current.transcript_seq_end = seq;
        for (const toolCall of record?.tool_calls ?? []) {
          current.tool_activities.push({
            tool_call_id: toolCall?.id ?? toolCall?.tool_call_id ?? null,
            name: toolCall?.name ?? null,
            status: "open",
            arguments: toolCall?.arguments ?? null,
            output: null,
            result_summary: null,
            journal_ref: seq != null ? `transcript ${seq}` : null
          });
        }
      } else if (record?.role === "tool") {
        if (!current) current = fresh(seq);
        current.transcript_seq_end = seq;
        const id = record?.tool_call_id ?? null;
        const activity = current.tool_activities.find((a) => a.tool_call_id === id);
        if (activity) {
          activity.status = "closed";
          activity.output = String(record.content ?? "");
        } else {
          current.tool_activities.push({
            tool_call_id: id,
            name: record?.name ?? null,
            status: "closed",
            arguments: null,
            output: String(record.content ?? ""),
            result_summary: null,
            journal_ref: seq != null ? `transcript ${seq}` : null
          });
        }
      }
    }
    push();
    return turns;
  }

  function collectOpenToolCalls(protectedTurns, inherited) {
    const open = [];
    for (const turn of protectedTurns) {
      for (const activity of turn?.tool_activities ?? []) {
        if (activity?.status === "open") {
          open.push({
            tool_call_id: activity.tool_call_id ?? null,
            name: activity.name ?? null,
            status: "open",
            arguments: activity.arguments ?? null,
            journal_ref: activity.journal_ref ?? null
          });
        }
      }
    }
    return open.length > 0 ? open : Array.isArray(inherited) ? inherited : [];
  }

  // Task 8：压缩源材料（coordinator 经 buildInput 注入调用）。读取 active
  // checkpoint（若有）→ 重建 delta 轮次 → selectProtectedRecentTurns → 生成
  // sourceMaterial / recent_messages / sourceState。无 checkpoint 且没有早于
  // 受保护窗口的历史时返回 noop（不调用模型）。
  async function buildCompactionSource({
    journal,
    checkpointStore,
    storageRoot,
    sourceCheckpointId = null,
    trigger = "automatic",
    modelConfig = null,
    session = null,
    projectRoot = null
  } = {}) {
    // 进程重启后的压缩 retry：协调器 entry 无内存 modelConfig——按 projectRoot
    // 解析当前有效配置（modelConfigOf(resolveWorkspaceConfig)），保证候选校验的
    // configured_model_id/provider_model_id 与压缩请求的 modelConfig 始终可用。
    let effectiveModelConfig = modelConfig;
    if (effectiveModelConfig == null && typeof projectRoot === "string" && projectRoot.length > 0) {
      try {
        const project = await resolveWorkspaceConfig(projectRoot);
        effectiveModelConfig = modelConfigOf(project);
      } catch {
        effectiveModelConfig = null;
      }
    }
    const pointer = await checkpointStore.readActive();
    let oldCheckpoint = null;
    if (pointer.checkpoint_id != null) {
      oldCheckpoint = await readCheckpointFile(storageRoot, pointer.checkpoint_id).catch(() => null);
    }
    const fromSeq = oldCheckpoint?.source_transcript_seq?.end ?? 0;
    const delta =
      fromSeq > 0 ? await journal.readTranscriptAfter({ afterSeq: fromSeq }) : await journal.readTranscript();
    const lastTailSeq = delta.at(-1)?.transcript_seq ?? fromSeq;
    const turns = buildTurnsFromTranscript(delta);
    const window =
      Number.isFinite(effectiveModelConfig?.effective_context_window) && effectiveModelConfig.effective_context_window > 0
        ? effectiveModelConfig.effective_context_window
        : 256_000;
    const targetTokens = Math.round(window * 0.25);
    const { protected_turns, summarized_turns } = selectProtectedRecentTurns({ turns, targetTokens });
    // 无可压缩历史：无 checkpoint 且没有早于受保护窗口的轮次 → noop
    if (oldCheckpoint == null && summarized_turns.length === 0) {
      return { noop: true, reason: "nothing_to_compact" };
    }
    const sourceMaterial = JSON.stringify(
      {
        old_summary: oldCheckpoint?.summary ?? null,
        old_recent_messages: oldCheckpoint?.recent_messages ?? [],
        summarized_history: summarized_turns.map((turn) => ({
          user: turn.user_text,
          assistant: turn.assistant_text,
          tool_activities: turn.tool_activities ?? []
        })),
        protected_recent_turns: protected_turns.map((turn) => ({
          user: turn.user_text,
          assistant: turn.assistant_text,
          tool_activities: turn.tool_activities ?? []
        }))
      },
      null,
      2
    );
    // checkpoint 近期原文 = 受保护轮次范围内的原始消息链（复用线上消息转换，
    // 保证 assistant tool_calls 以 { id, type, function } 形状进入后续请求）。
    const minProtectedSeq = Math.min(
      ...protected_turns.map((turn) => (Number.isInteger(turn.transcript_seq_start) ? turn.transcript_seq_start : Infinity))
    );
    const recentMessages = transcriptToMessages(
      delta.filter((record) => record.transcript_seq == null || record.transcript_seq >= minProtectedSeq)
    );
    const openToolCalls = collectOpenToolCalls(protected_turns, oldCheckpoint?.open_tool_calls ?? []);
    const sourceState = {
      source_checkpoint_id: pointer.checkpoint_id ?? null,
      source_seq: { start: 1, end: Math.max(journal.lastSeq ?? 0, 1) },
      source_transcript_seq: { start: 1, end: lastTailSeq },
      configured_model_id: effectiveModelConfig?.configured_model_id ?? null,
      provider_model_id: effectiveModelConfig?.model_name ?? null,
      trigger,
      effective_context_window: window,
      target_tokens: targetTokens,
      current_task: oldCheckpoint?.summary?.current_task ?? "",
      user_confirmed_decisions: oldCheckpoint?.summary?.user_confirmed_decisions ?? [],
      pending_steps: oldCheckpoint?.summary?.pending_steps ?? [],
      open_tool_calls: openToolCalls,
      reload_from_workspace: oldCheckpoint?.reload_from_workspace ?? []
    };
    const estimatedTokensBefore = estimateRequestUsage({
      messages: [{ role: "user", content: sourceMaterial }, ...recentMessages],
      tools: [],
      effectiveContextWindow: window
    }).used_tokens;
    return {
      sourceMaterial,
      sourceState,
      recent_messages: recentMessages,
      open_tool_calls: openToolCalls,
      reload_from_workspace: sourceState.reload_from_workspace,
      estimated_tokens_before: estimatedTokensBefore,
      modelConfig: effectiveModelConfig,
      noop: false
    };
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

  // 从 journal 事件找回输入元数据（text + kind）。上限语义同 findInputText：
  // 只扫描最近 100k 条事件；超出上限视为找不到（返回 text: null）。
  async function findInputMeta(journal, inputId) {
    const events = await journal.read({ afterSeq: 0, limit: 100000 });
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
  async function isCompactRunIdleInitiated(state, runId, compactInputId) {
    const events = await state.journal.read({ afterSeq: 0, limit: 100000 });
    for (const event of events) {
      if (event.type !== "run_started" || event.run_id !== runId) continue;
      return event.payload?.input_id === compactInputId;
    }
    return true;
  }

  // 压缩取消收敛（幂等，项目互斥锁内读-判-写）：
  //   - 自动：input_cancelled(reason:"compaction_cancelled") + 排队输入一并取消 +
  //     grant 清除 + run_cancelled（矩阵：Run cancelled、文本回 draft）；
  //   - 手动 in-run：input_cancelled(compaction_cancelled) + 恢复 running；
  //   - 手动空闲：input_cancelled(compaction_cancelled) + run_cancelled → idle。
  // 返回 "converged" | "already_terminal" | "input_settled"。
  async function convergeCompactionCancelled(state, compaction) {
    return state.mutex.run(async () => {
      const session = await state.journal.getSession();
      const run = session.active_run;
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return "already_terminal";
      const inputId = compaction?.pending_input_id ?? null;
      const inputLive =
        inputId != null &&
        (run.active_input_id === inputId || session.queued_inputs.some((item) => item.id === inputId));
      if (!inputLive) return "input_settled";
      const isManual = compaction?.trigger === "manual";
      const idleInitiated = isManual ? await isCompactRunIdleInitiated(state, run.id, inputId) : false;
      const batch = [];
      const inputIds = [];
      if (run.active_input_id != null) inputIds.push(run.active_input_id);
      for (const item of session.queued_inputs) inputIds.push(item.id);
      for (const id of inputIds) {
        batch.push({
          type: "input_cancelled",
          run_id: run.id,
          payload: { input_id: id, reason: id === inputId ? "compaction_cancelled" : "compaction_run_cancelled" }
        });
      }
      if (isManual && !idleInitiated) {
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
      if (batch.length > 0) await state.journal.appendBatch(batch);
      return "converged";
    });
  }

  // 手动 /compact 处理（在安全点由 runLoop 调用，active_input_id 已是 compact
  // item）。返回 "compacted" | "compaction_blocked" | "compaction_resumed" |
  // "interrupted"。
  async function processCompact(state, runId, inputId) {
    const session = await state.journal.getSession();
    const run = session.active_run;
    if (!run || run.id !== runId || TERMINAL_RUN_STATUSES.has(run.status)) return "compaction_blocked";
    const project = await resolveWorkspaceConfig(state.key);
    const modelConfig = modelConfigOf(project);
    const idleInitiated = await isCompactRunIdleInitiated(state, runId, inputId);
    // 相同队列中后续重复 /compact：输入安全点取消（duplicate_compact），避免
    // 连续无意义压缩（spec §5.5）。
    await state.mutex.run(async () => {
      const s = await state.journal.getSession();
      const r = s.active_run;
      if (!r || r.id !== runId || TERMINAL_RUN_STATUSES.has(r.status)) return;
      const laterDuplicates = s.queued_inputs.filter((item) => item.kind === "compact");
      if (laterDuplicates.length > 0) {
        await state.journal.appendBatch(
          laterDuplicates.map((item) => ({
            type: "input_cancelled",
            run_id: runId,
            payload: { input_id: item.id, reason: "duplicate_compact" }
          }))
        );
      }
    });
    // 先构建源材料做 noop 预检（无可压缩历史则不调用模型）
    const built = await buildCompactionSource({
      journal: state.journal,
      checkpointStore: state.checkpointStore,
      storageRoot: state.storageRoot,
      sourceCheckpointId: null,
      trigger: "manual",
      modelConfig,
      session,
      projectRoot: state.key
    });
    if (built.noop) {
      await state.journal.append({
        type: "context_compaction_noop",
        run_id: runId,
        payload: { compaction_id: idFactory(), trigger: "manual", reason: built.reason ?? "nothing_to_compact" }
      });
      await state.mutex.run(async () => {
        const s = await state.journal.getSession();
        const r = s.active_run;
        if (!r || r.id !== runId || TERMINAL_RUN_STATUSES.has(r.status)) return;
        await state.journal.append({
          type: "input_consumed",
          run_id: runId,
          payload: { input_id: inputId }
        });
      });
      return "compacted";
    }
    resolveFirstTurnIfPending(state);
    const outcome = await state.compactionCoordinator.start({
      projectRoot: state.key,
      trigger: "manual",
      pendingInputId: inputId,
      modelConfig,
      signal: state.controller?.signal
    });
    if (outcome.status === "completed") {
      await state.mutex.run(async () => {
        const s = await state.journal.getSession();
        const r = s.active_run;
        if (!r || r.id !== runId || TERMINAL_RUN_STATUSES.has(r.status)) return;
        await state.journal.append({ type: "input_consumed", run_id: runId, payload: { input_id: inputId } });
      });
      return "compacted";
    }
    if (outcome.status === "failed") {
      // 手动 /compact 失败：compact queue item 无终态（可重试），Run → waiting_user
      // 并保存 resume_run_status。互斥锁内读-判-写：cancel 恰在此时收敛则跳过。
      await state.mutex.run(async () => {
        const s = await state.journal.getSession();
        const r = s.active_run;
        if (r && r.id === runId && !TERMINAL_RUN_STATUSES.has(r.status) && r.status !== "waiting_user") {
          await state.journal.append({
            type: "run_status_changed",
            run_id: runId,
            payload: {
              status: "waiting_user",
              reason: "compaction_failed",
              resume_run_status: idleInitiated ? null : "running",
              error_code: outcome.error_code ?? null
            }
          });
        }
      });
      resetController(state);
      return "compaction_blocked";
    }
    // cancelled
    const sessionNow = await state.journal.getSession();
    const runNow = sessionNow.active_run;
    if (!runNow || runNow.id !== runId || TERMINAL_RUN_STATUSES.has(runNow.status)) return "compaction_blocked";
    if (runNow.status === "stopping" || runNow.status === "interrupting") {
      return "interrupted"; // 停止/立即路径负责收敛
    }
    const compactionProjection = (await state.journal.getSession()).compaction;
    await convergeCompactionCancelled(state, compactionProjection);
    if (idleInitiated) return "compaction_blocked";
    // 手动 in-run 取消：input_cancelled + 恢复 resume_run_status，队列继续消费
    return "compaction_resumed";
  }

  // 处理一个输入：模型轮次循环直到文本回复 / 中断 / 停止 / 失败。
  // 返回 "done" | "compaction_blocked" | "interrupted" | "stopped" | "failed"
  // | "terminated"。compaction_blocked 表示自动压缩失败/取消后 Run 已收敛为
  // waiting_user 或 cancelled，runLoop 必须显式处理（不继续循环、不 run_completed）。
  async function processInput(state, runId, inputId, inputText) {
    const { journal, tools } = state;
    const volatileToolRecords = [];
    // Task 8：ensureUserMessageInTranscript 移到首次自动压缩门禁之后——压缩成功才
    // 写入 transcript；cancelled/failed 时输入保持 draft/可重试，不调用普通模型。
    let compactionAttemptedForInput = false;
    let closedToolResult = false;

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
        history: await buildHistory({
          journal,
          checkpointStore: state.checkpointStore,
          storageRoot: state.storageRoot,
          excludeInputId: inputId,
          volatileRecords: volatileToolRecords
        }),
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
      // Task 8：首次自动压缩门禁（brief Step 4/5）。同一待发送输入最多触发一次
      // 自动压缩：成功/取消/失败后 compactionAttemptedForInput 置位；重新估算时
      // 低于硬窗口继续发送、仍高于软阈值不再压缩、仍超硬窗口则 failRun
      //（error_code context_window_exceeded，原始输入回 UI draft）。
      const preflightCompact = shouldCompact({
        estimatedInput: contextEstimate.used_tokens,
        window: modelConfig.effective_context_window
      });
      const alreadyAttempted =
        compactionAttemptedForInput ||
        (session.compaction?.pending_input_id === inputId &&
          ["completed", "failed", "cancelled", "noop"].includes(session.compaction?.state));
      if (preflightCompact && !alreadyAttempted) {
        // 安全点：工具结果刚闭合时先追加 interrupt_safe_point_reached 再压缩，
        // 绝不在工具原子写入中途压缩。
        if (closedToolResult) {
          await journal.append({ type: "interrupt_safe_point_reached", run_id: runId, payload: {} });
        }
        resolveFirstTurnIfPending(state);
        const compaction = await state.compactionCoordinator.start({
          projectRoot: state.key,
          trigger: "automatic",
          pendingInputId: inputId,
          modelConfig,
          signal: state.controller?.signal
        });
        compactionAttemptedForInput = true;
        if (compaction.status === "completed" || compaction.status === "noop") {
          // 压缩成功（或无可压缩历史）：把输入写入 transcript，使用新 active
          // context 继续——重新预检（低于硬窗口直接发送）。
          await ensureUserMessageInTranscript(journal, inputId, inputText);
          continue;
        }
        if (compaction.status === "failed") {
          // 自动压缩失败：Run 进入 waiting_user（不悬挂、不自动重启），输入保持
          // pending 可重试；发送门禁保持禁用直到 retry 成功或 cancel。互斥锁内
          // 读-判-写：若 cancel 恰在此时收敛（run_cancelled 终态），跳过追加。
          await state.mutex.run(async () => {
            const s = await journal.getSession();
            const r = s.active_run;
            if (r && r.id === runId && !TERMINAL_RUN_STATUSES.has(r.status) && r.status !== "waiting_user") {
              await journal.append({
                type: "run_status_changed",
                run_id: runId,
                payload: { status: "waiting_user", reason: "compaction_failed", error_code: compaction.error_code ?? null }
              });
            }
          });
          resetController(state);
          return "compaction_blocked";
        }
        // cancelled：自动压缩取消 → input_cancelled(reason:"compaction_cancelled")
        // + Run cancelled + 文本回 draft（输入从未写入 transcript）。
        const sessionNow = await journal.getSession();
        const runNow = sessionNow.active_run;
        if (!runNow || runNow.id !== runId || TERMINAL_RUN_STATUSES.has(runNow.status)) return "compaction_blocked";
        if (runNow.status === "stopping" || runNow.status === "interrupting") {
          return "interrupted"; // 停止/立即路径负责收敛
        }
        const compactionProjection = (await journal.getSession()).compaction;
        await convergeCompactionCancelled(state, compactionProjection);
        return "compaction_blocked";
      }
      if (preflightCompact && alreadyAttempted) {
        // 已为本输入压缩过：仍高于软阈值不再次压缩；仍超硬窗口 → failRun。
        if (exceedsHardWindow({ estimatedInput: contextEstimate.used_tokens, window: modelConfig.effective_context_window })) {
          await failRun(state, runId, {
            error: Object.assign(new Error("上下文仍超过硬窗口上限，无法发送。"), { code: "context_window_exceeded" }),
            inputId
          });
          return "failed";
        }
        // 低于硬窗口：继续发送（不重复压缩）
      }
      // 未达到阈值（或已压缩且低于硬窗口）：把输入写入 transcript 并调用模型
      await ensureUserMessageInTranscript(journal, inputId, inputText);
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
          // Task 8：工具结果刚闭合——下一次预检若触发压缩，先追加安全点标记
          closedToolResult = true;
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
  // 滞留跨 Run 边界）。返回 "advance" | "compact" | "completed" | "interrupting"
  // | "stopping" | "terminal" | "gone"。
  async function advanceOrComplete(state, runId) {
    return state.mutex.run(async () => {
      const session = await state.journal.getSession();
      const run = session.active_run;
      if (!run || run.id !== runId) return "gone";
      if (TERMINAL_RUN_STATUSES.has(run.status)) return "terminal";
      if (run.status === "stopping") return "stopping";
      if (run.status === "interrupting" || state.controller?.signal.aborted) return "interrupting";
      if (session.queued_inputs.length > 0) {
        const head = session.queued_inputs[0];
        if (head.kind === "compact") {
          // Task 8：/compact 在安全点被"消费"——激活但不给终态事件（失败时
          // compact item 必须保持无终态可重试/可取消），由 processCompact 收尾。
          await state.journal.append({
            type: "input_promoted",
            run_id: runId,
            payload: { input_id: head.id, reason: "compact_safe_point" }
          });
          return "compact";
        }
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
  // compaction_blocked（自动压缩失败/取消、手动压缩失败/空闲取消）必须显式
  // 处理：复位 controller 并停止循环——绝不继续循环、绝不调用 run_completed。
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
        if (fallback === "advance" || fallback === "compact" || fallback === "interrupting" || fallback === "stopping") continue;
        return;
      }

      const inputMeta = await findInputMeta(state.journal, inputId);
      if (inputMeta.text === null) {
        // 恢复的日志中找不到该输入（陈旧记录）：消费跳过，避免卡死
        await state.journal.append({ type: "input_consumed", run_id: runId, payload: { input_id: inputId } });
        continue;
      }

      if (inputMeta.kind === "compact") {
        const compactOutcome = await processCompact(state, runId, inputId, inputMeta.text);
        if (compactOutcome === "compacted" || compactOutcome === "compaction_resumed") {
          const after = await advanceOrComplete(state, runId);
          if (after === "advance" || after === "compact" || after === "interrupting" || after === "stopping") continue;
          return; // completed / terminal / gone
        }
        if (compactOutcome === "interrupted") continue;
        // compaction_blocked（失败 → waiting_user；空闲取消 → run_cancelled）
        resetController(state);
        return;
      }

      const outcome = await processInput(state, runId, inputId, inputMeta.text);
      if (outcome === "stopped" || outcome === "failed" || outcome === "terminated" || outcome === "compaction_blocked") {
        if (outcome === "compaction_blocked") resetController(state);
        return;
      }
      if (outcome === "interrupted") continue; // 立即：重新读取状态与被提升的输入

      // 输入完成：互斥锁内复查队列并推进/终结（阻断 submit 竞态滞留）；
      // "compact" = 队首是 /compact 已被安全点激活，继续循环处理
      const after = await advanceOrComplete(state, runId);
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
    // Task 8：checkpoint 崩溃对账（提交 marker 裁决 + 孤儿清理）必须在检查压缩
    // 投影之前执行——对账可能补写 completed（裁决 2）或 failed（裁决 1），使压缩
    // 变为终态。storage 损坏（checkpoint_corrupt）暴露可诊断错误，不猜测回滚。
    await state.checkpointStore.reconcileAfterCrash({ journal: state.journal });
    // Task 7：首次 open 对旧项目执行一次性只读 legacy 导入（幂等）。导入失败不
    // 阻塞 open：journal 已恢复、应用可继续工作；migration.legacy_imported 保持
    // false，下次 open() 重试（legacy-import 的 legacy_id / legacy 标记保证重试
    // 不产生重复事件或消息）。
    try {
      await runLegacyImport({ projectRoot: state.key, journal: state.journal, idFactory });
    } catch (error) {
      console.warn(`[agent] legacy 导入失败（下次 open 重试）: ${error?.message ?? String(error)}`);
    }
    // Task 8：非终态压缩对账（brief Step 3 结尾）。先通过 commit marker 对账
    //（上面 reconcileAfterCrash），未完成 attempt 统一追加
    // context_compaction_cancelled(reason:"process_restarted")，然后按收敛矩阵
    // 把 Run 收敛为 waiting_user（自动失败/取消、手动失败均保持 waiting_user，
    // 不自动模型调用）。active_context_checkpoint_id 保持旧值（cancelled 不切换）。
    const loadedSession = await state.journal.getSession();
    const loadedCompaction = loadedSession.compaction;
    if (loadedCompaction && COMPACTION_BLOCKED_STATES.includes(loadedCompaction.state)) {
      if (COMPACTION_NON_TERMINAL_STATES.includes(loadedCompaction.state)) {
        await state.journal.append({
          type: "context_compaction_cancelled",
          payload: {
            compaction_id: loadedCompaction.id,
            trigger: loadedCompaction.trigger,
            attempt: loadedCompaction.attempt ?? 1,
            source_checkpoint_id: loadedCompaction.source_checkpoint_id ?? null,
            checkpoint_id: loadedCompaction.checkpoint_id ?? null,
            source_seq: null,
            source_transcript_seq: null,
            provider_model_id: null,
            estimated_tokens_before: null,
            estimated_tokens_after: null,
            released_tokens: null,
            summary_schema_version: 1,
            duration_ms: null,
            validation: null,
            error_code: null,
            cancel_reason: "process_restarted"
          }
        });
      }
      // 收敛 Run/input：残留 running（崩溃窗口）收敛为 waiting_user；
      // 已是 waiting_user 保持原状。输入保持 pending（无终态），等待用户 retry/cancel。
      const recoveryRun = (await state.journal.getSession()).active_run;
      if (recoveryRun && !TERMINAL_RUN_STATUSES.has(recoveryRun.status) && recoveryRun.status === "running") {
        await state.journal.append({
          type: "run_status_changed",
          run_id: recoveryRun.id,
          payload: { status: "waiting_user", reason: "process_restarted", resume_run_status: null }
        });
      }
    }
    // 恢复：只恢复有效非终态 Run（journal.load 已把 dangling assistant 活动标记
    // 为 interrupted；那些 Run 等待 retry，不自动恢复；legacy 导入的未完成 Run
    // 是合法非终态，按同一语义接续执行）。压缩处于阻塞状态（started/running/
    // cancelling/failed/cancelled）时绝不自动启动循环——绝不让旧 processInput
    // 自动再次执行。
    const session = await state.journal.getSession();
    const run = session.active_run;
    const compactionBlocked =
      session.compaction != null && COMPACTION_BLOCKED_STATES.includes(session.compaction.state);
    if (run && !TERMINAL_RUN_STATUSES.has(run.status) && !compactionBlocked) {
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
    // Task 8：只把精确的 text === "/compact" 识别为 kind:"compact"；"/compact now"
    // 等其余文本都是普通输入。
    const kind = text === "/compact" ? "compact" : undefined;
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
            payload: { input_id: inputId, text, source, ...(kind === undefined ? {} : { kind }) }
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
      // 运行中：FIFO 队列（/compact 不打断当前模型/工具，按普通消息排队）
      await state.journal.append({
        type: "input_queued",
        payload: { input_id: inputId, text, source, ...(kind === undefined ? {} : { kind }) }
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

  // 压缩重试（Task 8 Step 7）：继续同一 compaction_id 的新 attempt。只允许
  // failed/cancelled（取消后 pending input 仍在时）状态；成功后原输入只继续一次
  //（输入写回 transcript 前的收敛由 runLoop/processInput 处理，绝不让旧
  // processInput 自动再次执行）。ESC/按钮/HTTP 与 cancelCompaction 复用同一
  // AbortSignal 链。
  async function retryCompaction({ projectRoot, compactionId }) {
    if (typeof compactionId !== "string" || compactionId.length === 0) {
      throw fail("invalid_compaction_id", "compactionId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    await state.journal.load();
    const session = await state.journal.getSession();
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
    const outcome = await state.compactionCoordinator.retry({
      compactionId,
      signal: state.controller?.signal
    });
    if (outcome.status === "completed" || outcome.status === "noop") {
      // 恢复 Run 为 running 并重启循环。手动 /compact 的 retry 成功后 compact
      // item 已达成目的（input_consumed 收敛，绝不重复启动第二次压缩）；自动压缩
      // 的 retry 成功后原 pending input 由 processInput 继续（压缩成功后预检低于
      // 硬窗口直接发送；仍超阈值因已尝试不再重复压缩）。retry 重建源后无可压缩
      // 历史（noop）视为等价成功——输入照常继续，由 processInput 重新预检。
      await state.mutex.run(async () => {
        const s = await state.journal.getSession();
        const r = s.active_run;
        if (r && r.id === run.id && !TERMINAL_RUN_STATUSES.has(r.status) && r.status !== "running") {
          await state.journal.append({
            type: "run_status_changed",
            run_id: run.id,
            payload: { status: "running", reason: "compaction_retried" }
          });
        }
        if (compaction.trigger === "manual") {
          const s2 = await state.journal.getSession();
          const r2 = s2.active_run;
          if (r2 && r2.id === run.id && !TERMINAL_RUN_STATUSES.has(r2.status)) {
            await state.journal.append({
              type: "input_consumed",
              run_id: run.id,
              payload: { input_id: compaction.pending_input_id }
            });
          }
        }
      });
      startLoop(state, run.id);
      return { status: "completed", compaction_id: compactionId, attempt: outcome.attempt };
    }
    if (outcome.status === "failed") {
      // 仍失败：Run 保持 waiting_user，发送门禁保持禁用（熔断后只等用户再次 retry/cancel）
      const s = await state.journal.getSession();
      const r = s.active_run;
      if (r && r.id === run.id && !TERMINAL_RUN_STATUSES.has(r.status) && r.status !== "waiting_user") {
        await state.journal.append({
          type: "run_status_changed",
          run_id: run.id,
          payload: { status: "waiting_user", reason: "compaction_failed", error_code: outcome.error_code ?? null }
        });
      }
      return { status: "failed", compaction_id: compactionId, attempt: outcome.attempt, error_code: outcome.error_code };
    }
    // cancelled（ESC 中断重试）：取消收敛（input_cancelled + run_cancelled / 恢复）
    const compactionNow = (await state.journal.getSession()).compaction;
    await convergeCompactionCancelled(state, compactionNow);
    return { status: "cancelled", compaction_id: compactionId };
  }

  // 压缩取消（Task 8 Step 7）：ESC、按钮与 HTTP 取消都调用本方法，复用当前
  // project state 的 AbortController（不创建第二套进程终止协议）。running 时
  // 先进入 cancelling（cancel_requested），底层确认终止后追加 cancelled，随后
  // 按触发来源收敛 Run/input（自动 → input_cancelled + run_cancelled，文本回
  // draft；手动 → input_cancelled + 恢复 resume_run_status 或 idle）。
  async function cancelCompaction({ projectRoot, compactionId }) {
    if (typeof compactionId !== "string" || compactionId.length === 0) {
      throw fail("invalid_compaction_id", "compactionId 必须是非空字符串。");
    }
    const state = ensureProject(projectRoot);
    await state.journal.load();
    const session = await state.journal.getSession();
    const compaction = session.compaction;
    if (!compaction || compaction.id !== compactionId) {
      throw fail("compaction_not_found", `compaction ${compactionId} 不存在。`);
    }
    await state.compactionCoordinator.cancel({ compactionId });
    const compactionNow = (await state.journal.getSession()).compaction;
    await convergeCompactionCancelled(state, compactionNow);
    return { status: "cancelled", compaction_id: compactionId };
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

  return { open, submit, promote, decide, stop, retry, retryCompaction, cancelCompaction, snapshot, exportHistory, clearHistory };
}
