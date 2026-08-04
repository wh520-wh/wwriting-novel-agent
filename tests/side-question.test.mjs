import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentPhaseLabel,
  appendSideQuestionLog,
  collectSideQuestionContext,
  detectMainTaskImpact,
  handleSideQuestion,
  parseUserCommand
} from "../src/core/side-question.mjs";
import { loadProject, loadState, saveProject, saveState } from "../src/core/project-store.mjs";
import { createWritingProject } from "./helpers.mjs";
import { runProject } from "../src/core/agent-engine.mjs";

test("parseUserCommand routes by mode and command prefixes", () => {
  assert.equal(parseUserCommand("", "main").type, "empty");
  assert.equal(parseUserCommand("继续写下一章", "main").type, "main");
  assert.equal(parseUserCommand("现在写到第几章了？", "side_question").type, "side_question");

  const ask = parseUserCommand("/ask 当前主角动机是不是太弱？", "main");
  assert.equal(ask.type, "side_question");
  assert.equal(ask.content, "当前主角动机是不是太弱？");

  assert.equal(parseUserCommand("/side 节奏为什么慢", "main").type, "side_question");
  assert.equal(parseUserCommand("/q 写到第几章", "main").type, "side_question");
  assert.equal(parseUserCommand("/review 对话太多", "main").type, "review");

  // 禁止使用 /btw —— 它不应被识别为旁路询问命令。
  assert.equal(parseUserCommand("/btw 测试", "main").type, "main");
});

test("detectMainTaskImpact flags rewrite/setting changes but not analysis questions", () => {
  assert.equal(detectMainTaskImpact("把女主改成反派"), true);
  assert.equal(detectMainTaskImpact("后面不要写校园，改成废土"), true);
  assert.equal(detectMainTaskImpact("删除男二"), true);
  assert.equal(detectMainTaskImpact("改掉世界观核心设定"), true);

  assert.equal(detectMainTaskImpact("当前主角动机是不是太弱？"), false);
  assert.equal(detectMainTaskImpact("这一章是不是需要更多冲突？"), false);
  assert.equal(detectMainTaskImpact("你接下来准备怎么安排反派出场？"), false);
});

test("agentPhaseLabel maps status + stage to enterprise phases", () => {
  assert.equal(agentPhaseLabel("idle", null), "待命");
  assert.equal(agentPhaseLabel("running", "planning"), "规划中");
  assert.equal(agentPhaseLabel("running", "drafting"), "写作中");
  assert.equal(agentPhaseLabel("running", "reviewing"), "审稿中");
  assert.equal(agentPhaseLabel("running", "finalizing"), "保存中");
  assert.equal(agentPhaseLabel("completed", null), "已完成");
  assert.equal(agentPhaseLabel("blocked", "drafting"), "需处理");
});

test("handleSideQuestion answers offline without modifying novel state or files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-sideq-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "novel",
    title: "测试小说",
    story_seed: "一个钟表匠发现时间可以倒流。",
    target_chapters: 1,
    min_words_per_chapter: 80
  });
  await runProject(projectRoot);

  const stateBefore = await loadState(projectRoot);
  const chapterBefore = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  const stateMtimeBefore = (await fs.stat(path.join(projectRoot, "agent_state.json"))).mtimeMs;

  const result = await handleSideQuestion(projectRoot, "当前主角动机是不是太弱？");
  assert.equal(result.ok, true);
  assert.equal(result.mainTaskAffecting, false);
  assert.equal(result.answerMode, "offline");
  assert.ok(result.answer.length > 0);
  assert.equal(result.loggedTo, "side_questions.md");

  // 旁路询问不得修改正文、章节文件或写作状态。
  const stateAfter = await loadState(projectRoot);
  const chapterAfter = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.deepEqual(stateAfter, stateBefore);
  assert.equal(chapterAfter, chapterBefore);
  assert.equal((await fs.stat(path.join(projectRoot, "agent_state.json"))).mtimeMs, stateMtimeBefore);

  // 记录写入独立的 side_questions.md。
  const log = await fs.readFile(path.join(projectRoot, "side_questions.md"), "utf8");
  assert.ok(log.includes("# 旁路询问记录"));
  assert.ok(log.includes("当前主角动机是不是太弱？"));
  assert.ok(log.includes("是否转为正式任务："));

  await fs.rm(root, { recursive: true, force: true });
});

test("handleSideQuestion marks main-line modification requests for confirmation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-sideq-impact-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "novel",
    title: "废土小说",
    story_seed: "校园里的少年。",
    target_chapters: 1,
    min_words_per_chapter: 80
  });
  await runProject(projectRoot);

  const result = await handleSideQuestion(projectRoot, "后面不要写校园，改成废土");
  assert.equal(result.mainTaskAffecting, true);
  assert.ok(result.suggestion && result.suggestion.includes("是否要将它加入正式写作任务"));

  await fs.rm(root, { recursive: true, force: true });
});

test("handleSideQuestion uses an injected model client instead of touching the network", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-sideq-model-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "novel",
    title: "在线小说",
    story_seed: "侦探故事。",
    target_chapters: 1,
    min_words_per_chapter: 80
  });

  const calls = [];
  const fakeClient = {
    async generate(request) {
      calls.push(request);
      return { text: "这是模型给出的旁路分析回答。" };
    }
  };
  const result = await handleSideQuestion(projectRoot, "节奏怎么样？", { modelClient: fakeClient });
  assert.equal(result.answerMode, "model");
  assert.equal(result.answer, "这是模型给出的旁路分析回答。");
  assert.equal(result.modelError, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stage, "side_question");
  assert.ok(calls[0].messages.some((message) => message.role === "system"));

  await fs.rm(root, { recursive: true, force: true });
});

test("handleSideQuestion degrades to offline and surfaces modelError when the model client throws", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-sideq-fail-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "novel",
    title: "降级小说",
    story_seed: "测试模型失败降级。",
    target_chapters: 1,
    min_words_per_chapter: 80
  });

  const throwingClient = {
    async generate() {
      throw new Error("upstream 503");
    }
  };
  const result = await handleSideQuestion(projectRoot, "这一章如何？", { modelClient: throwingClient });
  // 模型失败必须降级为离线回答，并把错误显式暴露出来（不再静默丢弃）。
  assert.equal(result.answerMode, "offline_fallback");
  assert.equal(result.modelError, "upstream 503");
  assert.ok(result.answer.includes("旁路分析"));

  const log = await fs.readFile(path.join(projectRoot, "side_questions.md"), "utf8");
  assert.ok(log.includes("模型调用降级"));
  assert.ok(log.includes("upstream 503"));

  // 即便模型失败，也只允许写 side_questions.md：没跑过写作，chapters 目录不应被旁路询问创建。
  const sideLogExists = await fs
    .stat(path.join(projectRoot, "side_questions.md"))
    .then(() => true)
    .catch(() => false);
  assert.equal(sideLogExists, true);
  const chapterDirEntries = await fs.readdir(path.join(projectRoot, "chapters")).catch(() => []);
  assert.deepEqual(chapterDirEntries, []);

  await fs.rm(root, { recursive: true, force: true });
});

test("collectSideQuestionContext tolerates a missing agent_state.json instead of crashing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-sideq-nostate-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "novel",
    title: "无状态小说",
    story_seed: "测试缺失状态文件。",
    target_chapters: 1,
    min_words_per_chapter: 80
  });

  // 删除 agent_state.json，模拟被手动删除/损坏为缺失的异常情况。
  await fs.rm(path.join(projectRoot, "agent_state.json"), { force: true });

  const context = await collectSideQuestionContext(projectRoot);
  assert.equal(context.title, "无状态小说");
  assert.equal(context.currentChapterNo, null);
  assert.equal(context.agentPhase, "待命");

  // handleSideQuestion 也应能在缺失状态下回答而不抛错。
  const result = await handleSideQuestion(projectRoot, "现在到哪了？");
  assert.equal(result.ok, true);
  assert.ok(result.answer.length > 0);

  await fs.rm(root, { recursive: true, force: true });
});

test("collectSideQuestionContext gathers read-only project context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-sideq-context-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "novel",
    title: "上下文小说",
    story_seed: "一句话设定。",
    target_chapters: 2,
    min_words_per_chapter: 80
  });
  await runProject(projectRoot);

  const context = await collectSideQuestionContext(projectRoot);
  assert.equal(context.title, "上下文小说");
  assert.equal(context.targetChapters, 2);
  assert.ok(context.completedChapters >= 1);
  assert.ok(context.latestChapterExcerpt.length > 0);

  await fs.rm(root, { recursive: true, force: true });
});

test("appendSideQuestionLog creates the header once and appends entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-sideq-log-"));
  const { projectRoot } = await createWritingProject(root, { slug: "novel", target_chapters: 1, min_words_per_chapter: 80 });

  await appendSideQuestionLog(projectRoot, {
    askedAt: new Date("2026-05-30T10:00:00Z").toISOString(),
    question: "第一个问题",
    answer: "第一个回答",
    mainTaskAffecting: false,
    promotedToTask: false
  });
  await appendSideQuestionLog(projectRoot, {
    askedAt: new Date("2026-05-30T11:00:00Z").toISOString(),
    question: "第二个问题",
    answer: "第二个回答",
    mainTaskAffecting: true,
    promotedToTask: false
  });

  const log = await fs.readFile(path.join(projectRoot, "side_questions.md"), "utf8");
  assert.equal(log.match(/# 旁路询问记录/gu).length, 1);
  assert.ok(log.includes("第一个问题"));
  assert.ok(log.includes("第二个问题"));
  assert.ok(log.includes("该问题包含可能影响主线设定的修改建议"));

  await fs.rm(root, { recursive: true, force: true });
});

// 对整个项目目录做内容哈希快照（默认排除 side_questions.md），用于证明旁路询问只动这一个文件。
async function snapshotProjectFiles(projectRoot, { exclude = ["side_questions.md"] } = {}) {
  const excludeSet = new Set(exclude);
  const out = new Map();
  async function walk(dir, rel) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (excludeSet.has(relPath)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, relPath);
      } else if (entry.isFile()) {
        const buf = await fs.readFile(full);
        out.set(relPath, crypto.createHash("sha256").update(buf).digest("hex"));
      }
    }
  }
  await walk(projectRoot, "");
  return [...out.entries()].sort();
}

test("side-question on the model path leaves every project file except side_questions.md byte-identical", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-sideq-snap-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "novel",
    title: "快照小说",
    story_seed: "测试在线路径不污染项目文件。",
    target_chapters: 1,
    min_words_per_chapter: 80
  });
  await runProject(projectRoot);

  const before = await snapshotProjectFiles(projectRoot);
  const fakeClient = {
    async generate() {
      // 即使模型返回带 usage/cost 的结果，也不得有任何项目文件（尤其 cost.json）被写入。
      return { text: "在线分析回答。", usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }, cost: 0.01 };
    }
  };
  const result = await handleSideQuestion(projectRoot, "这一章节奏如何？", { modelClient: fakeClient });
  assert.equal(result.answerMode, "model");

  const after = await snapshotProjectFiles(projectRoot);
  assert.deepEqual(after, before, "model-path side-question must not modify any protected project file");

  await fs.rm(root, { recursive: true, force: true });
});

test("production buildSideQuestionClient path routes through the configured openai-compatible adapter without touching the network for real", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-sideq-realclient-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "novel",
    title: "真实客户端小说",
    story_seed: "测试生产客户端装配。",
    target_chapters: 1,
    min_words_per_chapter: 80
  });
  await runProject(projectRoot);

  // 把项目配置改成在线 provider，使 handleSideQuestion 走 buildSideQuestionClient（不注入 fake client）。
  const project = await loadProject(projectRoot);
  project.active_model = {
    provider: "openai-compatible",
    model_name: "writer-online",
    base_url: "https://stub.test/v1"
  };
  await saveProject(projectRoot, project);

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content: "生产客户端的旁路分析回答。" } }], usage: {} });
      }
    };
  };
  try {
    const before = await snapshotProjectFiles(projectRoot);
    const result = await handleSideQuestion(projectRoot, "这部小说的主线冲突清晰吗？");
    assert.equal(result.answerMode, "model");
    assert.equal(result.answer, "生产客户端的旁路分析回答。");
    assert.equal(fetchCalls.length, 1, "should call the stubbed openai-compatible endpoint exactly once");
    assert.ok(fetchCalls[0].url.startsWith("https://stub.test/v1/"), "must hit the configured base_url");
    const after = await snapshotProjectFiles(projectRoot);
    assert.deepEqual(after, before, "real-client side-question must not pollute cost.json or any project file");
  } finally {
    globalThis.fetch = originalFetch;
  }

  await fs.rm(root, { recursive: true, force: true });
});
