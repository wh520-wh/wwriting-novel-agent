// 辅助调用占比门控测量（统一 Agent 内核计划 Task 9 改写）。
//
// 方法：通过 ProjectAgent 公共接口 + mock ModelGateway 运行一次章节写作 Run。
// 辅助调用 = 模型轮次中不产生章节深工具（append_chapter_segment/commit_chapter）
// 的调用（计划/读取/搜索等准备性工作）；主调用 = 产生章节深工具的轮次。
// 用 mock gateway 的调用记录按此分类计数（ground truth），并记录总 usage token。
// 测量记录写入 gitignored 的 debug/measure-auxiliary-share.json。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProjectRoot, tool, waitForIdle } from "../tests/helpers/project-agent-harness.mjs";
import { createMockAdapter } from "../tests/helpers/mock-adapter.mjs";

const RECORD_PATH = path.resolve(import.meta.dirname, "../debug/measure-auxiliary-share.json");

// DeepSeek 风格 usage，确保 usage 归一化走真实链路
const USAGE = {
  prompt_tokens: 500,
  completion_tokens: 300,
  total_tokens: 800
};

const CHAPTER_DEEP_TOOLS = new Set(["append_chapter_segment", "commit_chapter"]);

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-aux-share-"));
  try {
    const { projectRoot, project } = await createProjectRoot(root, {
      slug: "project",
      target_chapters: 2,
      min_words_per_chapter: 10,
      target_words_per_chapter: 20
    });

    // mock ModelGateway：脚本化一次章节 Run。准备性轮次（计划/读取）为辅助调用，
    // 章节深工具轮次为主调用；usage 注入统一 500/300/800。
    const script = [
      // 辅助 1：读取章节上下文
      { reply: { toolCalls: [tool("read_file", { path: "OUTLINE.md" })] }, usage: USAGE },
      // 辅助 2：任务计划
      { reply: { toolCalls: [tool("update_plan", { explanation: "先读设定再写第一章", items: [{ step: "读取设定", status: "in_progress" }] })] }, usage: USAGE },
      // 主 1：写入草稿（章节深工具直接可用，无需切换工作流）
      { reply: { toolCalls: [tool("append_chapter_segment", { project_id: project.project_id, chapter_no: 1, segment_no: 1, content: "雨夜，一封没有署名的信落在门缝里，主角决定追查寄信人。" })] }, usage: USAGE },
      // 主 2：正式提交
      { reply: { toolCalls: [tool("commit_chapter", { project_id: project.project_id, chapter_no: 1 })] }, usage: USAGE },
      { reply: { text: "第一章已完成。" }, usage: USAGE }
    ];

    const { createProjectAgent } = await import("../src/core/agent/index.mjs");
    const adapter = createMockAdapter({ script, defaultUsage: USAGE });
    const { createModelGateway } = await import("../src/core/model/gateway.mjs");
    const { CostTracker } = await import("../src/core/cost-tracker.mjs");
    const gateway = createModelGateway({ adapter, retryMax: 0, costTracker: new CostTracker() });
    const agent = createProjectAgent({ modelGateway: gateway });

    await agent.open({ projectRoot });
    await agent.submit({ projectRoot, text: "写第一章" });
    await waitForIdle(agent, projectRoot);

    // —— 真值：按调用是否携带章节深工具分类 ——
    const callsByKind = { auxiliary: 0, chapter: 0 };
    for (const call of adapter.calls) {
      const reply = call.reply ?? {};
      const toolCalls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
      const isChapter = toolCalls.some((tc) => CHAPTER_DEEP_TOOLS.has(tc?.name));
      callsByKind[isChapter ? "chapter" : "auxiliary"] += 1;
    }
    const total = callsByKind.auxiliary + callsByKind.chapter;
    const auxShare = total > 0 ? callsByKind.auxiliary / total : 0;

    // —— 交叉核对：journal 事件里的章节深工具调用数与主调用数一致 ——
    const { events } = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100000 });
    const toolEvents = events.filter((e) => e.type === "tool_call_completed");
    const chapterToolEvents = toolEvents.filter((e) => CHAPTER_DEEP_TOOLS.has(e.payload?.name));

    const record = {
      schema_version: 1,
      recorded_at: new Date().toISOString(),
      method: "ProjectAgent public interface + mock ModelGateway，按章节深工具分类计数",
      project_config: {
        target_chapters: 2,
        min_words_per_chapter: 10,
        target_words_per_chapter: 20
      },
      calls_by_kind: callsByKind,
      totals: { total, auxiliary: callsByKind.auxiliary, auxiliary_share: Number(auxShare.toFixed(4)) },
      cross_checks: {
        chapter_tool_events_in_journal: chapterToolEvents.length,
        note: "journal 中章节深工具调用数与主调用分类一致"
      },
      gate_threshold: 0.1,
      gate_verdict: auxShare >= 0.1 ? "implement" : "defer"
    };

    await fs.mkdir(path.dirname(RECORD_PATH), { recursive: true });
    await fs.writeFile(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(record, null, 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("measure failed:", error);
  process.exit(1);
});
