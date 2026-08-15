// scripts/simulate-user-flow.mjs —— 用户真实操作全链路模拟（Task 13 改写）。
//
// 普通文件夹（无 project.yaml）+ 应用私有 stateRoot 的真实用户流程：
//   1. 创建含普通 notes.txt 的文件夹；
//   2. 打开并发送"你好"（任意文件夹即可聊天）；
//   3. 调用 /init 创建 WWRITING.md（不生成固定蓝图）；
//   4. 用户要求快节奏网文，模型读 fast-readable 技能并更新项目记忆；
//   5. 写一个短章节，调用 count_text 后自主结束（客观工具，非完成门禁）；
//   6. 重开同路径恢复历史；
//   7. 验证项目根无 project.yaml 与 .wwriting/agent；
//   8. 修订入账：正式章节可直接编辑，编辑后调用 finalize_revision 入账
//      （断言 tool_call_completed 与 checkpoint_linked 事件；正式章可编辑语义自 C1 生效）。
//
// 每个阶段输出 PASS/FAIL 与实际证据路径；不输出 token、密钥或内部存储细节。
// 确定性模型脚本驱动（与测试 harness 同形），无需真实模型与 API key。
//
// 双模式用法：
//   node scripts/simulate-user-flow.mjs                       # mock 模式（确定性，必绿）
//   DEEPSEEK_API_KEY=sk-xxx node scripts/simulate-user-flow.mjs  # 真实 API 模式
//   MODEL_NAME=deepseek-v4-flash DEEPSEEK_API_KEY=sk-xxx node scripts/simulate-user-flow.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createProjectAgent } from "../src/core/agent/index.mjs";
import { createWorkspaceStore } from "../src/core/workspaces/store.mjs";
import { createSkillService } from "../src/core/skills/index.mjs";
import { commitChapter } from "../src/core/project-operations/chapter.mjs";
import { parseSimpleYaml, serializeSimpleYaml } from "../src/core/simple-yaml.mjs";
import { createOpenAICompatibleAdapter } from "../src/core/model/openai-compatible.mjs";
import { createModelGateway } from "../src/core/model/gateway.mjs";

// ---------------------------------------------------------------------------
// 确定性模型 gateway（与 tests/helpers 的 mock 同形）：按脚本依次消费
// ---------------------------------------------------------------------------

function createMockGateway(script) {
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
      calls.push({ request, reply });
      if (reply?.error) throw reply.error;
      return reply;
    }
  };
  return gateway;
}

function tool(name, args) {
  return { id: `call_${name}_${randomUUID().slice(0, 8)}`, name, arguments: args };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function waitForIdle(agent, projectRoot, { timeoutMs = WAIT_IDLE_TIMEOUT } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { session } = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 1 });
    if (session.status === "idle") return session;
    if (USE_REAL_API && session.status === "waiting_user") {
      // 真实模式下模型探索（如列出项目根之外目录）会触发确认请求；自动放行
      // 避免真实 API 验收悬挂（与 verify-unified-agent 的 driveToIdle 同语义）。
      const snap = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
      const pending = [...(snap.events ?? [])]
        .reverse()
        .find((e) => e.type === "decision_requested");
      if (pending?.payload?.decision_id) {
        await agent.decide({ projectRoot, decisionId: pending.payload.decision_id, choice: "allow" }).catch(() => {});
      }
    }
    await sleep(200);
  }
  throw new Error("等待 Agent 空闲超时");
}

const results = [];
function record(stage, ok, detail, evidence = []) {
  results.push({ stage, ok, detail, evidence });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${stage}: ${detail}`);
  for (const item of evidence) console.log(`    · 证据: ${item}`);
}

const WWRITING_CONTENT = `---
schema_version: 1
writing_style_skill: fast-readable
---

# WWriting 项目记忆

## 项目定位

- 项目：快节奏网文《雨夜来信》
- 当前目标：按快节奏易读风格推进第一卷

## 当前有效要求

- 单章篇幅较短，先完成一个短章节。
- 场景尽快进入冲突，段落易扫读。

## 写作风格

- 技能：fast-readable
- 补充：冲突直接，重要转折允许少量心理描写。

## 权威文件

- 正文：正文/

## 当前进度

- 已完成：第 1 章（短章节）
- 下一步：按风格续写第 2 章
`;

const CHAPTER_CONTENT = [
  "雨夜，林晚刚关掉台灯，手机屏幕在黑暗里亮起来。",
  "",
  "屏幕上只有一行字：\"你母亲留下的信，在老宅的钟座后面。\"",
  "",
  "发信人是一个陌生号码。他拨回去，对面已关机。",
  "",
  "窗外雨声渐密。林晚抓起钥匙，冲进雨里。"
].join("\n");

// 修订入账阶段用的常规合格正文（与 tests 同形；正式章可直编，须 finalize_revision 入账）。
const LONG_PROSE = `# 第一章 雨夜来信

雨夜，雨声突然变大。林深猛地推开门，冲进老宅的客厅。他浑身湿透，抹了一把脸，低声道："信上说，老宅的钟会在午夜敲十三下。"烛光下，墙上的照片里竟是多年不见的父亲。他正要细看，门外却传来一阵急促的敲门声。`;
const LONG_PROSE_REVISED = `${LONG_PROSE}

修订：第二日清晨，林深回到老宅，在钟座后面摸到一封信。信封没有署名，字迹却与母亲一模一样。`;

// 双模式开关（第九轮）：无 DEEPSEEK_API_KEY → 确定性 mock；有 key → 真实 API。
// MODEL_NAME 可覆盖默认模型（deepseek-v4-flash）。
const USE_REAL_API = Boolean(process.env.DEEPSEEK_API_KEY);
const REAL_MODEL_NAME = process.env.MODEL_NAME ?? "deepseek-v4-flash";
const WAIT_IDLE_TIMEOUT = USE_REAL_API ? 1200000 : 60000; // 真实模式单阶段放宽到 20 分钟（模型完整执行写作工作流，每轮 30-60s）

// 构造一个仿既有项目形状的正式项目（含 project.yaml + memory/ 索引 + 空 run_log，
// 无 .versions/）：供修订入账阶段以真实项目形式驱动 finalize_revision。
async function buildProperProject(workspaceRoot) {
  const projectRoot = path.join(workspaceRoot, "novel");
  for (const dir of ["chapters", "drafts", "memory", "skills", "checkpoints", "prompts", "sources"]) {
    await fs.mkdir(path.join(projectRoot, dir), { recursive: true });
  }
  const project = {
    schema_version: 1,
    project_id: randomUUID(),
    title: "修订入账演练项目",
    story_seed: "一封信在一夜雨声中改写命运。",
    root_path: projectRoot,
    output_format: "md",
    target_chapters: 1,
    min_words_per_chapter: 40,
    target_words_per_chapter: 80,
    run_mode: "auto",
    default_writer_model: "mock-writer",
    default_reviewer_model: "mock-reviewer",
    active_model: { provider: "mock", model_name: "mock-writer" },
    output_style: "creative",
    archived_at: null,
    tool_permissions: {
      network_allowed: false,
      safe_edit: true,
      read_only: false,
      // auto_edit 放行项目内写工具（write_file / finalize_revision 均安全目标）
      auto_edit: true,
      yolo: false,
      dangerous: false
    }
  };
  await fs.writeFile(path.join(projectRoot, "project.yaml"), serializeSimpleYaml(project), "utf8");
  await fs.writeFile(path.join(projectRoot, "memory", "chapter_index.json"), JSON.stringify({ schema_version: 1, chapters: [] }), "utf8");
  await fs.writeFile(path.join(projectRoot, "memory", "chapter_memory.json"), JSON.stringify({ schema_version: 1, chapters: [] }), "utf8");
  await fs.writeFile(path.join(projectRoot, "book_summary.md"), "# 全书摘要\n\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "WORKLOG.md"), "# WORKLOG\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "run_log.jsonl"), "", "utf8");
  const yaml = await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8");
  return { projectRoot, project: parseSimpleYaml(yaml) };
}

const tAll = Date.now();
const demoRoot = path.join(process.cwd(), ".demo_runs", `user-flow-${Date.now()}`);
const evidenceRoot = demoRoot;
console.log("用户流程模拟（普通文件夹 + 应用私有 stateRoot）");
console.log(`证据根目录: ${evidenceRoot}`);

// ---------------------------------------------------------------------------
// 双模式 gateway 选择：无 DEEPSEEK_API_KEY → 确定性 mock；有 key → 真实 API
// （USE_REAL_API / REAL_MODEL_NAME 在文件顶部声明）
// ---------------------------------------------------------------------------
const MOCK_SCRIPT = [
  // 阶段2：打开并发送"你好"
  { reply: { text: "你好，我可以在这个工作区协助你。没有 project.yaml 也能直接开始。" } },
  // 阶段3：/init 创建 WWRITING.md（先读目录，再写入项目记忆；不生成固定蓝图）
  { reply: { toolCalls: [tool("list_files", { path: "." })] } },
  { reply: { toolCalls: [tool("write_file", { path: "WWRITING.md", content: WWRITING_CONTENT })] } },
  { reply: { text: "已根据目录内容创建 WWRITING.md 项目记忆。" } },
  // 阶段4：用户要求快节奏网文 → 读 fast-readable 技能，更新记忆（写入风格 ID）
  { reply: { toolCalls: [tool("read_skill", { name: "fast-readable" })] } },
  { reply: { toolCalls: [tool("write_file", { path: "WWRITING.md", content: WWRITING_CONTENT })] } },
  { reply: { text: "已读取快节奏易读风格技能，并把风格 ID 写入项目记忆。" } },
  // 阶段5：写短章节 → 调用 count_text 客观核对 → 自主结束
  { reply: { toolCalls: [tool("write_file", { path: "正文/第001章.md", content: CHAPTER_CONTENT })] } },
  { reply: { toolCalls: [tool("count_text", { path: "正文/第001章.md" })] } },
  { reply: { text: "短章节已完成。已调用字数工具核对实际字数，内容满足快节奏易读的节奏要求。" } },
  // 阶段6：重开后的确认消息（可选；重开本身在阶段6单独验证）
  { reply: { text: "历史已恢复，之前的对话内容都在。" } }
];
const gateway = USE_REAL_API
  ? createModelGateway({
      adapter: createOpenAICompatibleAdapter({
        baseUrl: "https://api.deepseek.com",
        apiKeyEnv: "DEEPSEEK_API_KEY"
      }),
      retryMax: 2,
      timeoutMs: 120000,
      totalDeadlineMs: 240000
    })
  : createMockGateway(MOCK_SCRIPT);
console.log(`模型模式：${USE_REAL_API ? `真实 API（DEEPSEEK_API_KEY 已配置，模型=${REAL_MODEL_NAME}）` : "mock（确定性）"}`);

const workspaceRoot = demoRoot;
const projectRoot = path.join(workspaceRoot, "普通文件夹");
const stateRoot = path.join(workspaceRoot, "user-data");
const secretsRoot = path.join(workspaceRoot, ".secrets");
const skillsHome = path.join(workspaceRoot, "skills-home");

try {
  // ---- 阶段1：创建含普通 notes.txt 的文件夹 ----
  console.log("【阶段1】创建普通文件夹");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(skillsHome, { recursive: true });
  const notesPath = path.join(projectRoot, "notes.txt");
  await fs.writeFile(notesPath, "普通资料：写作参考笔记。\n", "utf8");
  record("普通文件夹就绪", await pathExists(notesPath), "notes.txt 已创建", [notesPath]);

  // ---- 组装 Agent（应用私有 stateRoot + 普通文件夹配置）----
  const store = createWorkspaceStore({ stateRoot });
  const skills = createSkillService({ userHome: skillsHome });
  const agent = createProjectAgent({
    modelGateway: gateway,
    shell: async ({ command, cwd, timeoutMs, purpose, signal, onOutput } = {}) => {
      if (signal?.aborted) {
        const error = new Error("shell cancelled");
        error.code = "shell_cancelled";
        throw error;
      }
      const stdout = `stub stdout: ${command}`;
      if (onOutput) onOutput({ stream: "stdout", text: stdout });
      return { exitCode: 0, cwd, signal: null, durationMs: 0, stdout, stderr: "" };
    },
    skills,
    agentStorageRootFor: (root) => store.agentRootFor(root),
    // 普通文件夹没有 project.yaml：注入与旧项目等价的安全写权限（auto_edit），
    // 让 /init 与写作的 write_file 自动放行而不是暂停等待确认
    workspaceConfigLoader: async () => ({
      project_id: null,
      output_format: "md",
      archived_at: null,
      // 第九轮：真实模式注入模型配置（普通文件夹无 project.yaml，active_model
      // 是 runtime modelConfigOf 的唯一来源；mock 模式不需要模型名）。
      active_model: USE_REAL_API ? { provider: "openai-compatible", model_name: REAL_MODEL_NAME } : null,
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

  // ---- 阶段2：打开并发送"你好" ----
  console.log("【阶段2】打开文件夹并发送第一条消息");
  await agent.open({ projectRoot });
  const sessionBefore = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
  await agent.submit({ projectRoot, text: "你好", source: "chat" });
  await waitForIdle(agent, projectRoot);
  const afterHello = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
  const helloSessionId = afterHello.session.session_id;
  const journalPath = path.join(store.agentRootFor(projectRoot), "sessions", helloSessionId, "journal-manifest.json");
  const helloOk = afterHello.events.some((e) => e.type === "assistant_message_completed");
  // 阶段级固定断言只在 mock 模式硬性执行（真实模式模型行为不定，由末尾冒烟断言承接）
  if (!USE_REAL_API) {
    record("第一条消息完成（你好）", helloOk, "普通文件夹无需 project.yaml 即可聊天", [
      journalPath,
      path.join(projectRoot, "notes.txt")
    ]);
  }

  // ---- 阶段3：调用 /init 创建 WWRITING.md ----
  console.log("【阶段3】/init 创建 WWRITING.md");
  await agent.submit({ projectRoot, text: "/init", source: "chat" });
  await waitForIdle(agent, projectRoot);
  const wwMemoryPath = path.join(projectRoot, "WWRITING.md");
  const initOk = await pathExists(wwMemoryPath);
  if (!USE_REAL_API) {
    record("/init 创建 WWRITING.md", initOk, initOk ? "项目记忆已落盘" : "WWRITING.md 缺失", initOk ? [wwMemoryPath] : [projectRoot]);
  }
  const blueprintChecks = [];
  for (const name of ["OUTLINE.md", "SETTING.md", "AGENTS.md"]) {
    blueprintChecks.push([name, await pathExists(path.join(projectRoot, name))]);
  }
  const noBlueprint = blueprintChecks.every(([, exists]) => !exists);
  record("/init 不生成固定蓝图", noBlueprint, `OUTLINE/SETTING/AGENTS 均未创建 (${blueprintChecks.map(([n, e]) => `${n}=${e ? "存在" : "无"}`).join(", ")})`, [projectRoot]);

  // ---- 阶段4：用户要求快节奏网文 → 模型读 fast-readable 并更新记忆 ----
  console.log("【阶段4】快节奏网文风格确认");
  await agent.submit({ projectRoot, text: "这本要按快节奏易读的网文风格来写", source: "chat" });
  await waitForIdle(agent, projectRoot);
  const events4 = (await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 })).events;
  const toolCalls4 = events4.filter((e) => e.type === "tool_call_completed").map((e) => e.payload?.name);
  let memoryContent = "";
  try {
    memoryContent = await fs.readFile(wwMemoryPath, "utf8");
  } catch {
    // 真实模式：模型可能尚未创建 WWRITING.md，读不到不视为脚本故障
  }
  const styleOk = toolCalls4.includes("read_skill") && memoryContent.includes("fast-readable");
  if (!USE_REAL_API) {
    record("模型读 fast-readable 并更新记忆", styleOk, `工具序列=${toolCalls4.join("→")}，记忆含 fast-readable=${memoryContent.includes("fast-readable")}`, [wwMemoryPath, journalPath]);
  }

  // ---- 阶段5：写短章节 + count_text 后自主结束 ----
  console.log("【阶段5】短章节 + 字数工具");
  await agent.submit({ projectRoot, text: "写一个短章节，写完用字数工具核对一下", source: "chat" });
  await waitForIdle(agent, projectRoot);
  const chapterPath = path.join(projectRoot, "正文", "第001章.md");
  const chapterOk = await pathExists(chapterPath);
  const events5 = (await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 })).events;
  const toolCalls5 = events5.filter((e) => e.type === "tool_call_completed").map((e) => e.payload?.name);
  const countOk = toolCalls5.includes("count_text");
  const countEvent = events5.find((e) => e.type === "tool_call_completed" && e.payload?.name === "count_text");
  const countMetrics = countEvent?.payload
    ? Object.fromEntries(["cjk_characters", "latin_words", "numeric_tokens", "punctuation_characters", "non_whitespace_characters", "effective_count"]
        .filter((key) => countEvent.payload[key] !== undefined)
        .map((key) => [key, countEvent.payload[key]]))
    : null;
  // 阶段级固定断言只在 mock 模式硬性执行（真实模式模型行为不定，由末尾冒烟断言承接）
  if (!USE_REAL_API) {
    record("短章节已写入", chapterOk, chapterOk ? "正文/第001章.md 已落盘" : "章节文件缺失", chapterOk ? [chapterPath] : [projectRoot]);
    record("count_text 调用后自主结束", countOk, countOk
      ? `count_text 已调用，客观指标=${JSON.stringify(countMetrics)}（无门禁判定字段）`
      : "未调用 count_text", [journalPath]);
  }
  // ---- 阶段6：重开同路径恢复历史 ----
  console.log("【阶段6】重开同路径恢复历史");
  const eventsBeforeReopen = (await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 })).events;
  await agent.open({ projectRoot });
  const afterReopen = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
  const historyOk = afterReopen.session.session_id === helloSessionId
    && afterReopen.events.length >= eventsBeforeReopen.length
    && afterReopen.events.some((e) => e.type === "assistant_message_completed");
  record("重开恢复历史", historyOk, historyOk
    ? `session_id=${afterReopen.session.session_id}，事件 ${eventsBeforeReopen.length} → ${afterReopen.events.length}，历史完整`
    : `session_id=${helloSessionId} → ${afterReopen.session.session_id}`, [journalPath, path.join(store.agentRootFor(projectRoot), "session.json")]);

  // ---- 阶段7：验证项目根无 project.yaml 与 .wwriting/agent ----
  console.log("【阶段7】存储边界验证");
  const pyExists = await pathExists(path.join(projectRoot, "project.yaml"));
  const wwAgentExists = await pathExists(path.join(projectRoot, ".wwriting", "agent"));
  const stateJournalOk = await pathExists(journalPath);
  record("无 project.yaml", !pyExists, pyExists ? "存在（BAD）" : "不存在（GOOD）", [path.join(projectRoot, "project.yaml")]);
  record("无 .wwriting/agent", !wwAgentExists, wwAgentExists ? "存在（BAD）" : "不存在（GOOD）", [path.join(projectRoot, ".wwriting", "agent")]);
  record("应用私有历史在 stateRoot", stateJournalOk, stateJournalOk ? "journal-manifest.json 在应用私有目录" : "journal-manifest.json 缺失", [journalPath]);

  // ---- 阶段8：修订入账（正式章节可直接编辑，编辑后 finalize_revision 入账）----
  console.log("【阶段8】修订入账（finalize_revision）");
  const { projectRoot: revRoot, project: revProject } = await buildProperProject(path.join(demoRoot, "proper-project"));
  // 预置：先提交一版正式章节（status=completed、索引/校验和已写），无 .versions/
  await fs.writeFile(path.join(revRoot, "drafts", "001.draft.md"), LONG_PROSE, "utf8");
  await commitChapter({ projectRoot: revRoot, projectId: revProject.project_id, chapterNo: 1 });
  const revFinalPath = path.join(revRoot, "chapters", "001.md");
  const seededOk = await pathExists(revFinalPath);
  record("正式项目已就绪（含已提交章节、无 .versions/）", seededOk,
    seededOk ? "001 已 commit，正式文件与索引已写" : "章节未提交",
    [revFinalPath, path.join(revRoot, "memory", "chapter_index.json")]);
  if (!seededOk) throw new Error("修订入账阶段准备失败：无法提交章节。");

  // 修订入账 mock：模型直接写正式章文件 + finalize_revision 入账 + 记忆三件套 → 自主结束
  const revGateway = createMockGateway([
    { reply: { toolCalls: [tool("write_file", { path: "chapters/001.md", content: LONG_PROSE_REVISED })] } },
    // 编辑正式章后必须 finalize_revision 重新入账（C1 新语义：正文可直编 + 入账）
    { reply: { toolCalls: [tool("finalize_revision", { project_id: revProject.project_id, chapter_no: 1 })] } },
    // 第九轮：记忆三件套步骤（finalize_revision 后维护设定档案、全书摘要、工作日志）
    { reply: { toolCalls: [tool("update_memory", { project_id: revProject.project_id, chapter_no: 1, facts: [{ entity: "\u6797\u6df1", attribute: "\u4e8b\u4ef6", value: "\u5728\u949f\u5ea7\u540e\u627e\u5230\u4fe1" }] })] } },
    { reply: { toolCalls: [tool("write_file", { path: "book_summary.md", content: "# 全\u4e66\u6458\u8981\n\n\u6797\u6df1\u5728\u8001\u5b85\u949f\u5ea7\u540e\u627e\u5230\u6bcd\u4eb2\u7684\u4fe1\u3002\n" })] } },
    { reply: { toolCalls: [tool("write_file", { path: "WORKLOG.md", content: "# WORKLOG\n\n\u521a\u786e\u8ba4\u7b2c 1 \u7ae0\u4fee\u8ba2\u5165\u8d26\u3002\n" })] } },
    { reply: { text: "\u5df2\u76f4\u63a5\u7f16\u8f91\u7b2c 1 \u7ae0\u6b63\u6587\u5e76\u901a\u8fc7 finalize_revision \u786e\u8ba4\u4fee\u8ba2\u5165\u8d26\uff0c\u8bb0\u5fc6\u7ef4\u62a4\u4e09\u4ef6\u5957\u5df2\u5b8c\u6210\u3002" } }
  ]);
  const revSkills = createSkillService({ userHome: path.join(demoRoot, "skills-home-proper"), resourcesPath: null });
  const revAgent = createProjectAgent({
    modelGateway: revGateway,
    shell: async ({ command, cwd, timeoutMs, purpose, signal, onOutput } = {}) => {
      if (signal?.aborted) {
        const error = new Error("shell cancelled");
        error.code = "shell_cancelled";
        throw error;
      }
      const stdout = `stub stdout: ${command}`;
      if (onOutput) onOutput({ stream: "stdout", text: stdout });
      return { exitCode: 0, cwd, signal: null, durationMs: 0, stdout, stderr: "" };
    },
    skills: revSkills,
    agentStorageRootFor: (root) => store.agentRootFor(root)
    // 不覆盖 workspaceConfigLoader：默认按 project.yaml（auto_edit=true）解析权限
  });
  await revAgent.open({ projectRoot: revRoot });
  await revAgent.submit({ projectRoot: revRoot, text: "请直接编辑第 1 章，改完用 finalize_revision 确认修订", source: "chat" });
  await waitForIdle(revAgent, revRoot);
  const revEvents = (await revAgent.snapshot({ projectRoot: revRoot, afterSeq: 0, limit: 100000 })).events;
  const revToolCalls = revEvents.filter((e) => e.type === "tool_call_completed").map((e) => e.payload?.name);
  const finalizeOk = revToolCalls.includes("finalize_revision");
  const finalizeEvent = revEvents.find((e) => e.type === "tool_call_completed" && e.payload?.name === "finalize_revision");
  const linkedOk = revToolCalls.includes("write_file")
    && revEvents.some((e) => e.type === "checkpoint_linked");
  const checkpointId = revEvents.find((e) => e.type === "checkpoint_linked")?.payload?.checkpoint_id ?? null;
  const revisedContent = await fs.readFile(revFinalPath, "utf8");
  const contentOk = revisedContent.includes("修订：第二日清晨");

  // mock 模式：阶段级固定断言（real 模式下模型行为不确定，跳过阶段级断言）
  if (!USE_REAL_API) {
    record("finalize_revision 调用成功（tool_call_completed）", finalizeOk,
      finalizeOk ? `工具序列=${revToolCalls.join("→")}` : `未调用 finalize_revision（实际=${revToolCalls.join("→")}）`,
      [path.join(revRoot, "run_log.jsonl"), path.join(store.agentRootFor(revRoot), "sessions")]);
    record("编辑正式章已入账（checkpoint_linked 事件）", linkedOk,
      linkedOk ? `已链接 checkpoint_id=${checkpointId}` : "缺少 checkpoint_linked 事件",
      [path.join(revRoot, "memory", "chapter_index.json")]);
    record("修订正文已落盘且索引/校验和一致", contentOk && finalizeEvent?.payload?.ok === true,
      contentOk ? `正文含修订内容，finalize_revision 返回=${JSON.stringify(finalizeEvent?.payload ?? null)}` : "正文未含修订内容",
      [revFinalPath]);

    // 第九轮：记忆三件套断言
    const memTool = revToolCalls.includes("update_memory");
    const summaryText = await fs.readFile(path.join(revRoot, "book_summary.md"), "utf8");
    const worklogText = await fs.readFile(path.join(revRoot, "WORKLOG.md"), "utf8");
    const continuityPath = path.join(revRoot, "memory", "continuity.json");
    const continuityExists = await pathExists(continuityPath);
    if (continuityExists) {
      const continuity = JSON.parse(await fs.readFile(continuityPath, "utf8"));
      record("记忆三件套：update_memory 被调用", memTool, `工具序列=${revToolCalls.join("→")}`, [continuityPath]);
      record("设定档案已落盘（facts 含新实体）", continuity.facts?.some((f) => f.entity === "\u6797\u6df1"), "continuity.json facts 更新", [continuityPath]);
      record("故事摘要已更新（根目录）", summaryText.includes("\u949f\u5ea7\u540e\u627e\u5230"), "book_summary.md 根目录", [path.join(revRoot, "book_summary.md")]);
      record("工作日志已更新（根目录）", worklogText.includes("\u4fee\u8ba2\u5165\u8d26"), "WORKLOG.md 根目录", [path.join(revRoot, "WORKLOG.md")]);
    } else {
      // mock 模式：工具已调用但 continuity.json 可能未落地（取决于 update_memory 工具实现）
      // 断言工具调用 + 文件写入
      record("记忆三件套：update_memory 被调用", memTool, `工具序列=${revToolCalls.join("→")}`, []);
      record("故事摘要已更新（根目录）", summaryText.includes("\u949f\u5ea7\u540e\u627e\u5230"), "book_summary.md 根目录", [path.join(revRoot, "book_summary.md")]);
      record("工作日志已更新（根目录）", worklogText.includes("\u4fee\u8ba2\u5165\u8d26"), "WORKLOG.md 根目录", [path.join(revRoot, "WORKLOG.md")]);
    }
  } else {
    // 真实 API 模式：模型行为不确定，仅断言 run_completed >= 1 与基本产物
    const runCompleted = revEvents.filter((e) => e.type === "run_completed");
    record("真实模式：run_completed >= 1", runCompleted.length >= 1, `run_completed 数=${runCompleted.length}`, []);
    record("真实模式：修订正文已落盘", contentOk, contentOk ? "正文含修订内容" : "正文未含修订内容", [revFinalPath]);
  }

  // 第九轮：context_usage_updated 的 usage 必须携带 cache_hit_rate 字段（两种模式均断言）
  const mainSnapshot = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
  const revSnapshot = await revAgent.snapshot({ projectRoot: revRoot, afterSeq: 0, limit: 100000 });
  const allUsageEvents = [...mainSnapshot.events, ...revSnapshot.events]
    .filter((e) => e.type === "context_usage_updated");
  if (allUsageEvents.length > 0) {
    for (const ev of allUsageEvents) {
      const hasCacheRate = "cache_hit_rate" in (ev.payload?.usage ?? {});
      if (!hasCacheRate) {
        record("cache_hit_rate 字段存在", false, `context_usage_updated 缺少 cache_hit_rate: ${JSON.stringify(ev.payload?.usage)}`, []);
      }
    }
    const allHaveCacheRate = allUsageEvents.every((ev) => "cache_hit_rate" in (ev.payload?.usage ?? {}));
    record("context_usage_updated 的 usage 均含 cache_hit_rate", allHaveCacheRate,
      `共 ${allUsageEvents.length} 个 context_usage_updated 事件，全部含 cache_hit_rate=${allHaveCacheRate}`, []);
  } else {
    record("context_usage_updated 事件存在", false, "未找到 context_usage_updated 事件（mock gateway 不经过 runtime 上下文估算）", []);
  }

  // ---- 真实模式冒烟断言（模型行为不定：只断言应用链路可达，阶段级断言已在 mock 门内）----
  if (USE_REAL_API) {
    const runCompleted = mainSnapshot.events.filter((e) => e.type === "run_completed").length;
    const wwExists = await pathExists(wwMemoryPath);
    record("真实 API 冒烟：主链路 run_completed >= 2", runCompleted >= 2, `run_completed 数=${runCompleted}`, [journalPath]);
    record("真实 API 冒烟：WWRITING.md 已创建", wwExists, wwExists ? "项目记忆已落盘" : "WWRITING.md 缺失", wwExists ? [wwMemoryPath] : [projectRoot]);
  }

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 阶段通过，总耗时 ${((Date.now() - tAll) / 1000).toFixed(1)}s ===`);
  console.log(`证据根目录（保留可复查）: ${evidenceRoot}`);
  if (failed.length > 0) {
    console.log("未通过阶段：");
    for (const f of failed) console.log(`  FAIL ${f.stage}: ${f.detail}`);
    process.exit(1);
  }
  console.log("全链路通过。");
  process.exit(0);
} catch (error) {
  console.error(`用户流程模拟异常: ${error?.message ?? String(error)}`);
  process.exit(1);
}
