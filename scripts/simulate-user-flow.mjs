// scripts/simulate-user-flow.mjs —— 用户真实操作全链路模拟（Task 13 改写）。
//
// 普通文件夹（无 project.yaml）+ 应用私有 stateRoot 的真实用户流程：
//   1. 创建含普通 notes.txt 的文件夹；
//   2. 打开并发送“你好”（任意文件夹即可聊天）；
//   3. 调用 /init 创建 WWRITING.md（不生成固定蓝图）；
//   4. 用户要求快节奏网文，模型读 fast-readable 技能并更新项目记忆；
//   5. 写一个短章节，调用 count_text 后自主结束（客观工具，非完成门禁）；
//   6. 重开同路径恢复历史；
//   7. 验证项目根无 project.yaml 与 .wwriting/agent。
//
// 每个阶段输出 PASS/FAIL 与实际证据路径；不输出 token、密钥或内部存储细节。
// 确定性模型脚本驱动（与测试 harness 同形），无需真实模型与 API key。
//
// 用法：
//   node scripts/simulate-user-flow.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createProjectAgent } from "../src/core/agent/index.mjs";
import { createWorkspaceStore } from "../src/core/workspaces/store.mjs";
import { createSkillService } from "../src/core/skills/index.mjs";

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

async function waitForIdle(agent, projectRoot, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { session } = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 1 });
    if (session.status === "idle") return session;
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

const tAll = Date.now();
const demoRoot = path.join(process.cwd(), ".demo_runs", `user-flow-${Date.now()}`);
const evidenceRoot = demoRoot;
console.log("用户流程模拟（普通文件夹 + 应用私有 stateRoot）");
console.log(`证据根目录: ${evidenceRoot}`);

// ---------------------------------------------------------------------------
// 组装：普通文件夹 harness（无 project.yaml；应用私有 stateRoot）
// ---------------------------------------------------------------------------

const gateway = createMockGateway([
  // 阶段2：打开并发送“你好”
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
]);

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

  // ---- 阶段2：打开并发送“你好” ----
  console.log("【阶段2】打开文件夹并发送第一条消息");
  await agent.open({ projectRoot });
  const sessionBefore = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
  await agent.submit({ projectRoot, text: "你好", source: "chat" });
  await waitForIdle(agent, projectRoot);
  const afterHello = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
  const journalPath = path.join(store.agentRootFor(projectRoot), "journal-manifest.json");
  const helloOk = afterHello.events.some((e) => e.type === "assistant_message_completed");
  record("第一条消息完成（你好）", helloOk, "普通文件夹无需 project.yaml 即可聊天", [
    journalPath,
    path.join(projectRoot, "notes.txt")
  ]);
  const helloSessionId = afterHello.session.session_id;

  // ---- 阶段3：调用 /init 创建 WWRITING.md ----
  console.log("【阶段3】/init 创建 WWRITING.md");
  await agent.submit({ projectRoot, text: "/init", source: "chat" });
  await waitForIdle(agent, projectRoot);
  const wwMemoryPath = path.join(projectRoot, "WWRITING.md");
  const initOk = await pathExists(wwMemoryPath);
  record("/init 创建 WWRITING.md", initOk, initOk ? "项目记忆已落盘" : "WWRITING.md 缺失", initOk ? [wwMemoryPath] : [projectRoot]);
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
  const memoryContent = await fs.readFile(wwMemoryPath, "utf8");
  const styleOk = toolCalls4.includes("read_skill") && memoryContent.includes("fast-readable");
  record("模型读 fast-readable 并更新记忆", styleOk, `工具序列=${toolCalls4.join("→")}，记忆含 fast-readable=${memoryContent.includes("fast-readable")}`, [wwMemoryPath, journalPath]);

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
  record("短章节已写入", chapterOk, chapterOk ? "正文/第001章.md 已落盘" : "章节文件缺失", chapterOk ? [chapterPath] : [projectRoot]);
  record("count_text 调用后自主结束", countOk, countOk
    ? `count_text 已调用，客观指标=${JSON.stringify(countMetrics)}（无门禁判定字段）`
    : "未调用 count_text", [journalPath]);

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
