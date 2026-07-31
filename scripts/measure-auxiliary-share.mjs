// Task 21 (L3) 门控测量：2 章真实项目里辅助调用（memory_extract / fact_check）占比。
// 方法：createProject + runProject 真实流水线，provider 设为 openai-compatible（否则
// memory_extract/fact_check 会被「mock provider 跳过」短路），用 adapter spy 计数每次
// 真实 adapter.generate 调用的 stage（ground truth），并与 run_log.jsonl 的
// model_usage_recorded 事件 stage 分布、cost.json byStage 交叉核对。
// 测量记录写入 gitignored 的 debug/measure-auxiliary-share.json。
//
// 注意：model_usage_recorded 事件只在写作 gateway 路径写（agent-engine.mjs:1024），
// 辅助调用不写该事件——run_log 单看会低估辅助调用，spy 计数才是真值。

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProject } from "../src/core/agent-engine.mjs";
import { createProject, loadProject, saveProject } from "../src/core/project-store.mjs";
import { saveContinuity } from "../src/core/continuity-store.mjs";
import { readEvents } from "../src/core/event-log.mjs";
import { MockProviderAdapter } from "../src/core/provider-adapters.mjs";
import { MockModel } from "../src/core/mock-model.mjs";

const RECORD_PATH = path.resolve(import.meta.dirname, "../debug/measure-auxiliary-share.json");

// DeepSeek 风格 usage（与 M0 端到端测试同款字段），确保 normalizeUsageReport 走真实链路
const USAGE = {
  prompt_tokens: 500,
  completion_tokens: 300,
  total_tokens: 800
};

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-aux-share-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 2,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });

  // provider 设为 openai-compatible，让 memory_extract / fact_check 不跳过
  const project = await loadProject(projectRoot);
  project.active_model = {
    provider: "openai-compatible",
    model_name: "measure-model",
    base_url: "http://localhost:0",
    api_key_env: "FAKE_KEY"
  };
  await saveProject(projectRoot, project);

  // 预置 1 条既有事实：fact_check 在 continuity.facts 为空时会跳过，
  // 预置后第 1 章 reviewing 阶段就能真实触发 fact_check
  await saveContinuity(projectRoot, {
    schema_version: 1,
    facts: [{ entity: "林晚", attribute: "身份", value: "档案管理员", chapter_no: 1, quote: "她每天整理卷宗。" }],
    timeline: [],
    characters: []
  });

  const callsByStage = {};
  const metadataFlags = { memoryExtract: 0, factCheck: 0, toolRequest: 0, attempts: [] };
  const model = new MockModel();
  const adapter = new MockProviderAdapter({
    response: async (gatewayRequest) => {
      const stage = gatewayRequest.stage ?? "unknown";
      callsByStage[stage] = (callsByStage[stage] ?? 0) + 1;
      const meta = gatewayRequest.metadata ?? {};
      if (meta.memoryExtract) metadataFlags.memoryExtract += 1;
      if (meta.factCheck) metadataFlags.factCheck += 1;
      if (meta.toolRequest) metadataFlags.toolRequest += 1;
      if (Number.isInteger(meta.attempt)) metadataFlags.attempts.push(meta.attempt);
      if (meta.memoryExtract) {
        const chapterNo = meta.chapterNo;
        return {
          text: JSON.stringify({
            summary: `第 ${chapterNo} 章摘要：事件推进。`,
            facts: [{ entity: "林晚", attribute: "去向", value: `第 ${chapterNo} 章所在位置`, chapter_no: chapterNo, quote: "本章事件。" }],
            timeline: [{ chapter_no: chapterNo, story_time_raw: "夜晚", events: ["林晚继续查案。"] }],
            characters: [{ name: "林晚", traits: ["冷静"], status: "正常", chapter_no: chapterNo }]
          }),
          raw: {},
          usage: USAGE
        };
      }
      if (meta.factCheck) {
        return { text: JSON.stringify({ conflicts: [] }), raw: {}, usage: USAGE };
      }
      // 写作路径：委托真实 MockModel，保证 2 章能正常完成
      const toolRequest = meta.toolRequest ?? {};
      const output = await model.generate(toolRequest);
      return { text: JSON.stringify(output), raw: { output }, usage: USAGE };
    }
  });

  await runProject(projectRoot, { adapters: { "openai-compatible": adapter } });

  // —— 真值：adapter spy 按 stage 计数（覆盖所有 generate 调用，含辅助）——
  const total = Object.values(callsByStage).reduce((sum, n) => sum + n, 0);
  const auxStages = ["memory_extract", "fact_check"];
  const auxCalls = auxStages.reduce((sum, s) => sum + (callsByStage[s] ?? 0), 0);
  const auxShare = total > 0 ? auxCalls / total : 0;

  // —— 交叉核对 1：run_log.jsonl 的 model_usage_recorded 事件 stage 分布（只含 gateway 路径）——
  const events = await readEvents(projectRoot);
  const usageEventStages = {};
  for (const e of events) {
    if (e.type === "model_usage_recorded") {
      usageEventStages[e.stage] = (usageEventStages[e.stage] ?? 0) + 1;
    }
  }

  // —— 交叉核对 2：cost.json byStage（每次 gateway 调用后落盘，辅助调用不落盘，
  //    最后一章的 memory_extract 会漏计——这正是 run_log/cost 文件不能当唯一真值的原因）——
  const cost = JSON.parse(await fs.readFile(path.join(projectRoot, "cost.json"), "utf8"));
  const costByStage = Object.fromEntries(
    Object.entries(cost.byStage ?? {}).map(([k, v]) => [k, v.calls])
  );

  const record = {
    schema_version: 1,
    recorded_at: new Date().toISOString(),
    method: "createProject(target_chapters=2) + runProject 真实流水线 + adapter spy 计数",
    project_config: {
      provider: "openai-compatible",
      model_name: "measure-model",
      target_chapters: 2,
      min_words_per_chapter: 200,
      target_words_per_chapter: 260
    },
    calls_by_stage: callsByStage,
    metadata_flags: metadataFlags,
    totals: { total: total, auxiliary: auxCalls, auxiliary_share: Number(auxShare.toFixed(4)) },
    cross_checks: {
      model_usage_recorded_events_by_stage: usageEventStages,
      cost_json_by_stage: costByStage,
      note: "model_usage_recorded 与 cost.json 只覆盖 gateway（写作）路径，辅助调用不写这两个文件"
    },
    gate_threshold: 0.1,
    gate_verdict: auxShare >= 0.1 ? "implement" : "defer"
  };

  await fs.mkdir(path.dirname(RECORD_PATH), { recursive: true });
  await fs.writeFile(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(record, null, 2));
}

main().catch((error) => {
  console.error("measure failed:", error);
  process.exit(1);
});
