// scripts/rebuild-memory.mjs —— 重建已完成章节的派生记忆（统一 Agent 内核计划
// Task 9，Task 14 校准职责）。
//
// 以 source: "maintenance" 提交「重建指定章节记忆」的结构化输入并等待该 Run 终结；
// 不得直调 ModelGateway、memory extractor 或 Agent internal。模型在统一运行时里
// 读取章节正文，按章节内容更新全书摘要与连续性档案（派生数据；正文、章节索引
// 与 WWRITING.md 不属于本脚本的写入目标）。
import path from "node:path";
import { loadProject, loadChapterIndex } from "../src/core/project-store.mjs";
import { createProjectAgent } from "../src/core/agent/index.mjs";
import { createModelGateway } from "../src/core/model/gateway.mjs";
import { OpenAICompatibleAdapter } from "../src/core/model/openai-compatible.mjs";
import { createMockAdapter } from "../src/core/model/mock.mjs";
import { runShellCommand } from "../src/core/shell/runtime.mjs";
import { CostTracker } from "../src/core/cost-tracker.mjs";
import { readJson, safeJoin } from "../src/core/fs-utils.mjs";

const USAGE = `usage: node scripts/rebuild-memory.mjs <projectRoot> [--from N] [--chapter N] [--dry-run]

重建已完成章节的派生记忆（全书摘要与连续性档案，不修改正式章节、章节索引与 WWRITING.md）。
  <projectRoot>  项目根目录（必须配置真实模型，mock provider 会拒绝执行）
  --from N       只处理 chapter_no >= N 的已完成章节（默认 1）
  --chapter N    只处理指定章节（优先级高于 --from）
  --dry-run      只列出目标章节与估算模型调用数，不启动维护 Run
  --help, -h     显示本帮助

派生数据（book_summary.md、memory/continuity.json、memory/continuity.md）
可随时重建；正式章节文件、章节索引与 WWRITING.md 是权威事实，本脚本不触碰。`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const rootArg = args.find((a) => !a.startsWith("--"));
if (!rootArg) throw new Error(`usage: node scripts/rebuild-memory.mjs <projectRoot> [--from N] [--chapter N] [--dry-run]（--help 查看完整说明）`);
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
    text: `重建第 ${chapter.chapter_no} 章的记忆：读取该章正文（read_file），按章节内容更新全书摘要与连续性档案（book_summary.md、memory/continuity.json、memory/continuity.md）。摘要是派生数据，可覆盖为覆盖到本章的最新版本；不要改动正式章节文件、章节索引或 WWRITING.md。`,
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
