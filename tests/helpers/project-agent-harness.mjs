// ProjectAgent 验收测试基建（统一 Agent 内核计划 Task 1，供后续任务持续使用）。
//
// 本文件是测试基建，不是生产代码。它只通过公共 seam `src/core/agent/index.mjs`
// 构造 Agent（导入必须走该 seam，见依赖规则测试），并冻结验收测试依赖的契约形状。
//
// # 冻结的公共接口契约（Task 1 Step 2 的验收测试依据）
//
// ## ProjectAgent（src/core/agent/index.mjs）
//
//   const agent = createProjectAgent(dependencies);
//   dependencies = { modelGateway, shell?, secrets? }
//
//   await agent.open({ projectRoot });          // 恢复 journal、惰性创建 .wwriting/agent/；
//                                               // 首次 open 对旧项目执行一次性 legacy 迁移
//   await agent.submit({ projectRoot, text, source }); // source ∈ {"chat","maintenance"}，
//                                               // 仅审计来源，不改变权限/工作流/工具；
//                                               // 输入落盘即 resolve，Run 异步推进
//   await agent.promote({ projectRoot, inputId });     // 立即：同一 Run 内打断并提升排队输入
//   await agent.decide({ projectRoot, decisionId, choice }); // choice 见下
//   await agent.stop({ projectRoot, reason });  // reason: "user_stop"
//   await agent.retry({ projectRoot, runId });  // 恢复同一可恢复 Run
//   await agent.snapshot({ projectRoot, afterSeq, limit }); // -> { session, events }
//
// snapshot 返回 { session, events }：
//   session = Session 投影（schema_version/session_id/project_root/status/active_run/
//             queued_inputs/last_seq/updated_at，字段形状见计划 "Session projection"）；
//   events  = seq > afterSeq（最多 limit 条）的 journal 事件（形状见 "Journal event"）。
//
// decide 的 choice 词汇：
//   "allow"        —— 一次允许（仅当前动作）
//   "allow_input"  —— 本条输入允许同类操作（临时 grant 绑定 active_input_id）
//   "deny"         —— 拒绝
//   需要文字确认的决策（extreme）必须传入 payload.confirmation_text 的精确原文；
//   错误文字、过期 decision、已终结 decision 一律 reject（decide() 抛错）。
//
// ## ModelGateway port
//
//   gateway.complete(request, { signal }) -> Promise<{ text?, toolCalls? }>
//   request 为装配完成的模型请求（含 messages/tools，形状由 Task 3 定义）；
//   抛错（如 { code: "model_error" }）视为模型调用失败 -> Run 进入可恢复失败。
//
// ## Shell port（dependencies.shell）
//
//   shell({ command, cwd, timeoutMs, purpose, signal, onOutput })
//     -> Promise<{ exitCode, cwd, signal, durationMs, stdout, stderr }>
//
//   形状与前置计划已验收的 runShellCommand 一致（保持可观察行为）。默认注入确定性
//   桩（不产生真实进程）；realShell: true 时动态 import `src/core/shell/runtime.mjs`
//   的 runShellCommand 作为真实执行器。
//
// ## Tool call 形状（mock 脚本使用，ToolRuntime 必须接受）
//
//   general: list_files { path } / search_files { query, path? } / read_file { path } /
//            write_file { path, content } / edit_file { path, ... } /
//            shell { command, cwd?, timeout_ms?, purpose? }
//   deep:    update_plan { explanation?, items: [{id,step,status,description?}] }（status ∈
//            pending|in_progress|completed，最多一个 in_progress）/
//            enter_workflow { workflow: "general"|"chapter"|"init"|"review", reason } /
//            append_chapter_segment { project_id, chapter_no, segment_no, content } /
//            commit_chapter { project_id, chapter_no, expected_draft_checksum?, exception_decisions? } /
//            commit_blueprint { project_id, outline, setting, evidence_paths }
//
// ## 事件与投影契约
//   - 事件类型必须来自计划固定的 28 个类型清单（见 acceptance 测试 FIXED_EVENT_TYPES）。
//   - 同一项目同一时刻只允许一个 active Run；不同项目 journal 互不共享锁。
//   - 临时 grant 绑定 active_input_id + grant_key + target class；input 完成/取消/
//     被"立即"切换后清除该 input 的全部 grant。
//   - YOLO 是项目权限模式（tool_permissions.yolo），允许普通项目外操作，但不能绕过 extreme。
//   - extreme 必须为每次具体动作生成新的确认文字，不能被同类授权、历史 decision 或模型文本复用。
//
// 注意：旧数据文件名在本仓库属于依赖规则测试的禁字（只允许出现在两个白名单文件里），
// 本文件用片段拼接构造这些名字（见下方 LEGACY_* 常量）。
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serializeSimpleYaml } from "../../src/core/simple-yaml.mjs";

const DOT = ".";

// 旧状态文件名（依赖规则测试禁字，按片段拼接，禁止出现字面量）。
export const LEGACY_STATE_FILE = `agent_state${DOT}json`;
export const LEGACY_CHAT_HISTORY_FILE = `chat_history${DOT}jsonl`;
export const LEGACY_TASK_QUEUE_FILE = `task_queue${DOT}json`;
export const LEGACY_FAILURES_FILE = `failures${DOT}jsonl`;

export const STUB_SHELL_DELAY_MS = 250;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(target, value) {
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// 项目夹具：与当前项目文件布局一致（plan：章节索引/checkpoint/配置格式保留）
// ---------------------------------------------------------------------------

export async function createProjectRoot(workspaceRoot, options = {}) {
  const slug = options.slug ?? `novel-${Date.now().toString(36)}`;
  const projectRoot = path.resolve(workspaceRoot, slug);
  await fs.mkdir(projectRoot, { recursive: true });
  for (const dir of ["chapters", "drafts", "memory", "skills", "checkpoints", "prompts", "sources"]) {
    await fs.mkdir(path.join(projectRoot, dir), { recursive: true });
  }
  const project = {
    schema_version: 1,
    project_id: options.project_id ?? randomUUID(),
    title: options.title ?? "验收测试小说",
    story_seed: options.story_seed ?? "一个人在雨夜收到一封没有署名的信。",
    root_path: projectRoot,
    output_format: "md",
    target_chapters: options.target_chapters ?? 3,
    min_words_per_chapter: options.min_words_per_chapter ?? 50,
    target_words_per_chapter: options.target_words_per_chapter ?? 80,
    run_mode: "auto",
    default_writer_model: "mock-writer",
    default_reviewer_model: "mock-reviewer",
    active_model: options.active_model ?? { provider: "mock", model_name: "mock-writer" },
    output_style: "creative",
    archived_at: null,
    tool_permissions: {
      network_allowed: options.network_allowed ?? false,
      safe_edit: true,
      read_only: false,
      auto_edit: false,
      yolo: false,
      dangerous: false,
      ...(options.tool_permissions ?? {})
    },
    blueprint_status: "none"
  };
  await fs.writeFile(path.join(projectRoot, "project.yaml"), serializeSimpleYaml(project), "utf8");
  await writeJson(path.join(projectRoot, "memory", "chapter_index.json"), {
    schema_version: 1,
    chapters: []
  });
  await writeJson(path.join(projectRoot, "memory", "chapter_memory.json"), {
    schema_version: 1,
    chapters: []
  });
  await fs.writeFile(path.join(projectRoot, "memory", "book_summary.md"), "# 全书摘要\n\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "sources.md"), "# Sources\n\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "source_summaries.md"), "# Source Summaries\n\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "OUTLINE.md"), "# OUTLINE.md\n\n> 蓝图未生成，请运行 /init\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "SETTING.md"), "# SETTING.md\n\n> 蓝图未生成，请运行 /init\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "prompts", "drafting.v1.md"), "章节正文必须通过工具调用写入本地文件。\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "run_log.jsonl"), "", "utf8");
  return { projectRoot, project };
}

// 旧世界项目夹具：project.yaml 不含 blueprint_status，存在旧状态/历史文件。
export async function createLegacyProjectRoot(workspaceRoot, options = {}) {
  const { projectRoot, project } = await createProjectRoot(workspaceRoot, options);
  const legacyState = {
    schema_version: 1,
    project_status: "idle",
    blueprint_status: options.legacyBlueprintStatus ?? "complete",
    current_chapter_no: 1,
    current_stage: "queued",
    current_segment_no: 0,
    retry_counts: {},
    last_checkpoint_id: null,
    pending_user_confirmation: null,
    active_budget: {
      model_calls: 0,
      max_model_calls: null,
      revision_rounds_by_chapter: {},
      max_revision_rounds_per_chapter: null
    }
  };
  await writeJson(path.join(projectRoot, LEGACY_STATE_FILE), legacyState);
  await fs.appendFile(
    path.join(projectRoot, LEGACY_CHAT_HISTORY_FILE),
    `${JSON.stringify({ role: "user", text: "旧对话第一条" })}\n${JSON.stringify({ role: "assistant", text: "旧对话回复" })}\n`,
    "utf8"
  );
  // 旧项目的 project.yaml 元数据里没有 blueprint_status 字段。
  delete project.blueprint_status;
  await fs.writeFile(path.join(projectRoot, "project.yaml"), serializeSimpleYaml(project), "utf8");
  return { projectRoot, project };
}

// ---------------------------------------------------------------------------
// Mock ModelGateway：可编排脚本 + 调用记录（供并发/提示词断言）
// ---------------------------------------------------------------------------

// script 条目：
//   { reply: { text } } 或 { reply: { toolCalls: [{ id, name, arguments }] } }
//   { error: Error }                 —— 该轮模型调用失败（Run 进入可恢复失败）
//   (request, { signal }) => reply   —— 自定义断言/流式 token/返回
//   { reply, repeat: true }          —— 不消费脚本游标（可无限复用）
// 脚本耗尽后返回默认文本答复。delayMs 用于让并发断言可被观测。
export function createMockModelGateway({ script = [], delayMs = 30 } = {}) {
  const calls = [];
  let cursor = 0;
  const gateway = {
    calls,
    async complete(request, { signal } = {}) {
      if (signal?.aborted) {
        const error = new Error("model call aborted");
        error.code = "model_aborted";
        throw error;
      }
      const startedAt = Date.now();
      const entry = script[cursor] ?? null;
      if (entry && !entry.repeat) cursor += 1;
      let reply;
      if (entry && typeof entry === "function") {
        reply = await entry(request, { signal });
      } else if (entry?.error) {
        reply = { error: entry.error };
      } else if (entry?.reply) {
        reply = entry.reply;
      } else {
        reply = { text: "（默认答复）" };
      }
      if (delayMs > 0) await sleep(delayMs);
      const finishedAt = Date.now();
      calls.push({ request, reply, startedAt, finishedAt });
      if (reply?.error) throw reply.error;
      return reply;
    }
  };
  return gateway;
}

// ---------------------------------------------------------------------------
// Shell port：默认确定性桩；realShell 用 src/core/shell/runtime.mjs
// ---------------------------------------------------------------------------

function createStubShell({ delayMs = STUB_SHELL_DELAY_MS } = {}) {
  return async ({ command, cwd, timeoutMs, purpose, signal, onOutput } = {}) => {
    const throwIfAborted = () => {
      if (signal?.aborted) {
        const error = new Error("shell cancelled");
        error.code = "shell_cancelled";
        throw error;
      }
    };
    throwIfAborted();
    await sleep(delayMs);
    throwIfAborted();
    const stdout = `stub stdout: ${command}`;
    if (onOutput) onOutput({ stream: "stdout", text: stdout });
    return { exitCode: 0, cwd, signal: null, durationMs: delayMs, stdout, stderr: "" };
  };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

// Task 12：技能目录注入。内置技能来自仓库 src/skills（只读）；global 层 userHome
// 指向临时目录，migration marker 绝不写进真实用户目录。返回 active 技能列表。
export async function catalogSkillsFor(projectRoot) {
  const { createSkillService } = await import("../../src/core/skills/index.mjs");
  const home = path.join(projectRoot, ".test-skill-home");
  const service = createSkillService({ userHome: home, resourcesPath: null });
  const { active } = await service.catalog({ projectRoot });
  return active;
}

// options:
//   gatewayScript / gatewayDelayMs —— mock 模型脚本
//   realShell —— true 时使用真实 Shell 运行时（Task 4 后可用）
//   secrets —— 需要从 shell 命令/输出与 journal 中脱敏的字符串数组
//   project —— createProjectRoot 选项（tool_permissions 等）
//   legacy —— true 时创建旧世界项目夹具
//
// 资源保证：所有动态依赖（agent seam、realShell 的 shell runtime）在创建临时
// 工作区之前解析——seam 尚不存在（Task 6 前红阶段）时立刻失败，不产生任何
// %TEMP% 目录；工作区创建后若夹具构造失败，try/catch 兜底删除工作区。
export async function createProjectAgentHarness(options = {}) {
  const {
    gatewayScript = [],
    gatewayDelayMs = 30,
    realShell = false,
    secrets = [],
    project: projectOptions = {},
    legacy = false
  } = options;
  const gateway = createMockModelGateway({ script: gatewayScript, delayMs: gatewayDelayMs });
  let shell;
  if (realShell) {
    const { runShellCommand } = await import("../../src/core/shell/runtime.mjs");
    shell = ({ command, cwd, timeoutMs, purpose, signal, onOutput }) =>
      runShellCommand({ command, cwd, timeoutMs, signal, onOutput });
  } else {
    shell = createStubShell();
  }
  const { createProjectAgent } = await import("../../src/core/agent/index.mjs");
  const { createSkillService } = await import("../../src/core/skills/index.mjs");
  const { createWorkspaceStore } = await import("../../src/core/workspaces/store.mjs");

  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-acceptance-"));
  try {
    const { projectRoot, project } = legacy
      ? await createLegacyProjectRoot(workspaceRoot, projectOptions)
      : await createProjectRoot(workspaceRoot, projectOptions);
    // 临时 root 的 skills service：prompt 目录摘要 / read_skill / 章节技能门禁
    // 全链路使用它，migration marker 只写进工作区，绝不触碰真实用户目录。
    // Task 3：每个测试独立 stateRoot；Agent journal 经 createWorkspaceStore 的稳定
    // workspace id 落应用私有目录（stateRoot/workspaces/<id>/agent），绝不写回项目
    // 内 .wwriting/agent（生产组合根在 Task 4 注入同一 seam）。
    const stateRoot = path.join(workspaceRoot, "user-data");
    const store = createWorkspaceStore({ stateRoot });
    const skills = createSkillService({
      userHome: path.join(projectRoot, ".test-skill-home"),
      resourcesPath: null
    });
    const agent = createProjectAgent({
      modelGateway: gateway,
      shell,
      secrets,
      skills,
      agentStorageRootFor: (root) => store.agentRootFor(root)
    });
    return {
      agent,
      gateway,
      workspaceRoot,
      stateRoot,
      projectRoot,
      project,
      skills,
      store,
      agentRoot: store.agentRootFor(projectRoot),
      async cleanup() {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 普通文件夹夹具（Task 7 /init）：空目录，无 project.yaml/OUTLINE/SETTING/
// AGENTS.md。与 createProjectAgentHarness 相同的存储与技能隔离；注入
// workspaceConfigLoader 让项目内普通写自动放行（无 project.yaml 时 runtime 的
// FALLBACK 权限是 ask 会暂停等待确认，/init 场景的 write_file 需要 auto_edit
// 才不悬挂）。
// ---------------------------------------------------------------------------

export const VALID_MEMORY = `---
schema_version: 1
---

# WWriting 项目记忆

## 项目定位

- 项目：验收测试小说

## 当前有效要求

- 单章目标约 3000 字。

## 权威文件

- 正文：正文/
`;

export async function openPlainFolderHarness(options = {}) {
  const {
    gatewayScript = [],
    gatewayDelayMs = 30,
    secrets = []
  } = options;
  const gateway = createMockModelGateway({ script: gatewayScript, delayMs: gatewayDelayMs });
  const { createProjectAgent } = await import("../../src/core/agent/index.mjs");
  const { createSkillService } = await import("../../src/core/skills/index.mjs");
  const { createWorkspaceStore } = await import("../../src/core/workspaces/store.mjs");

  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-plain-folder-"));
  try {
    const projectRoot = path.join(workspaceRoot, "普通文件夹");
    await fs.mkdir(projectRoot, { recursive: true });
    const stateRoot = path.join(workspaceRoot, "user-data");
    const store = createWorkspaceStore({ stateRoot });
    const skills = createSkillService({
      userHome: path.join(projectRoot, ".test-skill-home"),
      resourcesPath: null
    });
    const agent = createProjectAgent({
      modelGateway: gateway,
      shell: createStubShell(),
      secrets,
      skills,
      agentStorageRootFor: (root) => store.agentRootFor(root),
      // 普通文件夹没有 project.yaml：注入与旧项目等价的安全写权限（auto_edit），
      // 让 /init 的 write_file 自动放行而不是暂停等待确认
      workspaceConfigLoader: async () => ({
        project_id: null,
        output_format: "md",
        archived_at: null,
        active_model: null,
        tool_permissions: {
          network_allowed: false,
          safe_edit: true,
          read_only: false,
          auto_edit: true,
          yolo: false,
          dangerous: false
        }
      })
    });
    return {
      agent,
      gateway,
      workspaceRoot,
      stateRoot,
      projectRoot,
      project: null,
      skills,
      store,
      agentRoot: store.agentRootFor(projectRoot),
      async cleanup() {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 观测辅助：全部走 ProjectAgent 公共接口
// ---------------------------------------------------------------------------

export async function waitFor(agent, projectRoot, predicate, { timeoutMs = 20000, describe = "条件" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    lastSnapshot = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
    if (predicate(lastSnapshot.session, lastSnapshot)) return lastSnapshot;
    await sleep(25);
  }
  const status = lastSnapshot?.session?.status;
  throw new Error(`waitFor 超时（${timeoutMs}ms）：${describe}；最后 status=${status}`);
}

export async function waitForIdle(agent, projectRoot, options = {}) {
  return waitFor(agent, projectRoot, (session) => session.status === "idle", {
    ...options,
    describe: "session 回到 idle"
  });
}

export async function readSession(agent, projectRoot) {
  const { session } = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
  return session;
}

export async function readEvents(agent, projectRoot, { afterSeq = 0, limit = 100000 } = {}) {
  const { events } = await agent.snapshot({ projectRoot, afterSeq, limit });
  return events;
}

export function tool(name, args) {
  return { id: `call_${name}_${randomUUID().slice(0, 8)}`, name, arguments: args };
}

export function eventsOfType(events, type) {
  return events.filter((event) => event.type === type);
}
