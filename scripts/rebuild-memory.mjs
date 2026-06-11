import path from "node:path";
import { loadProject, loadChapterIndex } from "../src/core/project-store.mjs";
import { loadContinuityState } from "../src/core/continuity-store.mjs";
import { extractChapterMemory } from "../src/core/agent-engine.mjs";
import { ModelClient } from "../src/core/model-client.mjs";
import { CostTracker } from "../src/core/cost-tracker.mjs";
import { OpenAICompatibleAdapter } from "../src/core/provider-adapters.mjs";
import { buildPricingTable } from "../src/core/model-pricing.mjs";
import { readJson, safeJoin } from "../src/core/fs-utils.mjs";

const args = process.argv.slice(2);
const projectRoot = path.resolve(args.find((a) => !a.startsWith("--")) ?? "");
const dryRun = args.includes("--dry-run");
const fromArg = args.indexOf("--from");
const fromChapter = fromArg >= 0 ? Number(args[fromArg + 1]) : 1;

if (!projectRoot) throw new Error("usage: node scripts/rebuild-memory.mjs <projectRoot> [--from N] [--dry-run]");

const project = await loadProject(projectRoot);
if ((project.active_model?.provider ?? "mock") === "mock") {
  throw new Error("项目未配置真实模型（active_model.provider=mock），补建记忆需要真实 API。");
}
const index = await loadChapterIndex(projectRoot);
const watermark = await loadContinuityState(projectRoot);
const targets = index.chapters
  .filter((c) => c.status === "completed" && c.chapter_no >= fromChapter && c.chapter_no > watermark.last_extracted_chapter)
  .sort((a, b) => a.chapter_no - b.chapter_no);

console.log(JSON.stringify({ projectRoot, chapters: targets.map((c) => c.chapter_no), estimatedCalls: targets.length, dryRun }));
if (dryRun || targets.length === 0) process.exit(0);

const existingCost = await readJson(safeJoin(projectRoot, "cost.json"), null);
const runtime = {
  modelClient: new ModelClient({
    costTracker: new CostTracker({ pricing: buildPricingTable(project), summary: existingCost }),
    adapters: { "openai-compatible": new OpenAICompatibleAdapter() }
  })
};
for (const chapter of targets) {
  console.log(`extracting chapter ${chapter.chapter_no}...`);
  await extractChapterMemory(projectRoot, project, { current_chapter_no: chapter.chapter_no }, runtime);
}
await runtime.modelClient.costTracker.writeProjectReport(projectRoot);
console.log(JSON.stringify({ ok: true, processed: targets.length }));
