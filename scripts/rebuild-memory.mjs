// scripts/rebuild-memory.mjs —— 重建指定章节记忆（统一 Agent 内核计划 Task 9）。
//
// 改为创建 ProjectAgent（src/core/agent/index.mjs 公共 seam），以
// source: "maintenance" 提交「重建指定章节记忆」的结构化输入并等待该 Run 终结；
// 不得直调 ModelGateway、memory extractor 或 Agent internal。模型在统一运行时里
// 读取章节正文并调用 commitChapterMemory 深工具完成确定性记忆落盘。
import path from "node:path";
import { loadProject, loadChapterIndex } from "../src/core/project-store.mjs";
import { createProjectAgent } from "../src/core/agent/index.mjs";
import { createModelGateway } from "../src/core/model/gateway.mjs";
import { OpenAICompatibleAdapter } from "../src/core/model/openai-compatible.mjs";
import { createMockAdapter } from "../src/core/model/mock.mjs";
import { runShellCommand } from "../src/core/shell/runtime.mjs";
import { CostTracker } from "../src/core/cost-tracker.mjs";
import { readJson, safeJoin } from "../src/core/fs-utils.mjs";

const args = process.argv.slice(2);
const rootArg = args.find((a) => !a.startsWith("--"));
if (!rootArg) throw new Error("usage: node scripts/rebuild-memory.mjs <projectRoot> [--from N] [--chapter N] [--dry-run]");
const projectRoot = path.resolve(rootArg);
const dryRun = args.includes("--dry-run");
const fromArg = args.indexOf("--from");
const fromChapter = fromArg >= 0 ? Number(args[fromArg + 1]) : 1;
const chapterArg = args.indexOf("--chapter");
const onlyChapter = chapterArg >= 0 ? Number(args[chapterArg + 1]) : null;

const project = await loadProject(projectRoot);
if ((project.active_model?.provider ?? "mock") === "mock") {
  throw new Error("项目未配置真实模型（active_model.provider=mock），补建记忆需要真实 API。");
}
const index = await loadChapterIndex(projectRoot);
const targets = index.chapters
  .filter((c) => c.status === "completed")
  .filter((c) => (onlyChapter == null || Number.isNaN(onlyChapter)) ? c.chapter_no >= fromChapter : c.chapter_no === onlyChapter)
  .sort((a, b) => a.chapter_no - b.chapter_no);

console.log(JSON.stringify({ projectRoot, chapters: targets.map((c) => c.chapter_no), estimatedCalls: targets.length, dryRun }));
if (dryRun || targets.length === 0) process.exit(0);

// 组合根：真实 provider 的 ModelGateway + 真实 Shell 运行时。
const existingCost = await readJson(safeJoin(projectRoot, "cost.json"), null);
const adapters = {
  "openai-compatible": new OpenAICompatibleAdapter(),
  mock: createMockAdapter()
};
// provider 取自 request.modelConfig（agent runtime 每轮注入 fresh modelConfig，
// 见 runtime.mjs modelConfigOf）——一次性 CLI 不需要长驻服务器的「切换模型立即
// 生效」语义（对比 app-server.mjs 的 dispatchAdapter：那里每次重读 project.yaml）。
const dispatchAdapter = {
  async complete(request, { signal } = {}) {
    const provider = request?.modelConfig?.provider ?? "mock";
    const adapter = adapters[provider] ?? adapters.mock;
    return adapter.complete(request, { signal });
  }
};
const modelGateway = createModelGateway({
  adapter: dispatchAdapter,
  retryMax: 2,
  timeoutMs: 120000,
  totalDeadlineMs: 300000,
  costTracker: new CostTracker({ summary: existingCost })
});
const agent = createProjectAgent({ modelGateway, shell: runShellCommand });

await agent.open({ projectRoot });
for (const chapter of targets) {
  console.log(`rebuilding memory for chapter ${chapter.chapter_no}...`);
  await agent.submit({
    projectRoot,
    text: `重建第 ${chapter.chapter_no} 章的记忆：读取该章正文（read_file），按章节内容更新章节记忆、连续性与全书摘要（commitChapterMemory 已就绪时使用它；如该工具不可用请直接说明已读取的内容）。`,
    source: "maintenance"
  });
}
// 等待维护 Run 终结（session 回到 idle）。
const deadline = Date.now() + 600000;
let session = null;
while (Date.now() < deadline) {
  const snapshot = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 1 });
  session = snapshot.session;
  if (session.status === "idle") break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!session || session.status !== "idle") {
  throw new Error("重建记忆的维护 Run 未在 10 分钟内终结（超时）。");
}
// 只等 idle 不足以保证重建成功：模型错误也会回到 idle（failed）。最终快照必须
// 断言维护 Run 以 completed 终结，否则视为失败。
const lastRun = session.active_run ?? null;
if (!lastRun || lastRun.status !== "completed") {
  throw new Error(
    `重建记忆的维护 Run 未成功完成（status=${lastRun?.status ?? "none"}）。请检查模型配置与日志。`
  );
}
console.log(JSON.stringify({ ok: true, processed: targets.length, session_status: session.status, last_run_status: lastRun.status }));
