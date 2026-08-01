// verify-chat-online.mjs — S3 real-API chat verification
// Requires: WWRITING_PROVIDER_BASE_URL, WWRITING_PROVIDER_MODEL, and the API key in the env var named by WWRITING_API_KEY_ENV (default OPENAI_API_KEY)
// Scenarios: A1) in-context comprehension (injected memory counts as grounding, no tool required)
//            A2) out-of-context comprehension (answer only exists in chapter body — MUST use a read tool)
//            B) edit flow with confirmation, C) fact-check corpus
//            F) incremental tool persistence + mid-turn cancel (S4.5)
// 验收口径（Claude Code/Codex 模式）：预注入记忆可直接引用；记忆未覆盖的细节必须工具查证。
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createProject, loadProject, saveProject, upsertChapter } from "../src/core/project-store.mjs";
import { saveContinuity } from "../src/core/continuity-store.mjs";
import { runChatTurn, resumeChatTurn } from "../src/core/chat/chat-agent.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { registerWriteTools } from "../src/core/chat/tools-write.mjs";
import { registerControlTools } from "../src/core/chat/tools-control.mjs";
import { updateProjectSettings } from "../src/core/settings-runtime.mjs";
import { buildFactCheckMessages, parseFactCheck } from "../src/core/quality-gates.mjs";
import { ModelClient } from "../src/core/model-client.mjs";
import { CostTracker } from "../src/core/cost-tracker.mjs";
import { OpenAICompatibleAdapter } from "../src/core/provider-adapters.mjs";
import { buildPricingTable } from "../src/core/model-pricing.mjs";

const baseUrl = process.env.WWRITING_PROVIDER_BASE_URL;
const model = process.env.WWRITING_PROVIDER_MODEL;
const apiKeyEnv = process.env.WWRITING_API_KEY_ENV ?? "OPENAI_API_KEY";
const apiKey = process.env[apiKeyEnv];

if (!baseUrl || !model || !apiKey) {
  console.error(JSON.stringify({
    error: "missing_env",
    required: ["WWRITING_PROVIDER_BASE_URL", "WWRITING_PROVIDER_MODEL", `${apiKeyEnv}(API key)`]
  }));
  process.exit(1);
}

const pricing = {
  input_per_million: Number(process.env.WWRITING_PRICING_INPUT) || 3,
  output_per_million: Number(process.env.WWRITING_PRICING_OUTPUT) || 6,
  cache_hit_per_million: Number(process.env.WWRITING_PRICING_CACHE_HIT) || 0.025
};

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-chat-verify-"));
  const results = [];
  let modelClient = null;

  try {
    // 1. 建临时项目（target 3 章、min 50 字）
    const { projectRoot } = await createProject(tmpRoot, {
      slug: "chat-verify",
      title: "对话验证",
      story_seed: "测试种子",
      target_chapters: 3,
      min_words_per_chapter: 50,
      target_words_per_chapter: 80
    });

    const project = await loadProject(projectRoot);
    project.active_model = {
      provider: "openai-compatible",
      model_name: model,
      base_url: baseUrl,
      api_key_env: apiKeyEnv
    };
    project.active_model.pricing = pricing;
    await saveProject(projectRoot, project);

    // 2. 预置第 1 章正文（固化语料：含"刘康从六楼坠落"）
    const chapterPath = path.join(projectRoot, "chapters", "001.md");
    await fs.mkdir(path.dirname(chapterPath), { recursive: true });
    await fs.writeFile(chapterPath, "# 第一章\n\n刘康从六楼坠落。沈泽在食堂吃饭时听到了这个消息。", "utf8");
    await upsertChapter(projectRoot, {
      chapter_no: 1,
      status: "completed",
      final_path: chapterPath,
      actual_words: 25
    });

    // 预置 continuity.json（六楼@ch1 事实）
    await saveContinuity(projectRoot, {
      schema_version: 1,
      facts: [{
        entity: "刘康",
        attribute: "坠楼楼层",
        value: "六楼",
        chapter_no: 1,
        quote: "六楼。",
        conflict_with: null
      }],
      timeline: [{
        chapter_no: 1,
        story_time: "十月",
        events: ["刘康坠楼"]
      }],
      characters: [{
        name: "刘康",
        traits: ["叼着不点的烟"],
        status: "已死亡",
        chapter_no: 1
      }]
    });

    // 构造 runtime
    const adapter = new OpenAICompatibleAdapter({ baseUrl, apiKey });
    modelClient = new ModelClient({
      costTracker: new CostTracker({ pricing: buildPricingTable(project) }),
      adapters: { "openai-compatible": adapter }
    });
    const registry = createToolRegistry();
    registerReadTools(registry);
    registerWriteTools(registry);

    // ========== 场景 A1：记忆内事实（预注入记忆即溯源，不要求工具调用）==========
    console.error("[A1] in-context comprehension...");
    const a1 = await runChatTurn({
      projectRoot,
      project,
      registry,
      modelClient,
      userMessage: "刘康是从几楼坠落的？"
    });
    const a1Pass = a1.reply.includes("六楼");
    results.push({
      scenario: "A1_memory_comprehension",
      pass: a1Pass,
      reply: a1.reply.slice(0, 200),
      toolEvents: a1.toolEvents.length,
      cost: a1.usage.cost
    });
    console.error(`[A1] pass=${a1Pass} reply="${a1.reply.slice(0, 80)}..." tools=${a1.toolEvents.length}`);

    // ========== 场景 A2：记忆外事实（"食堂"只在正文里，必须读工具查证）==========
    console.error("[A2] out-of-context comprehension...");
    const a2 = await runChatTurn({
      projectRoot,
      project,
      registry,
      modelClient,
      userMessage: "第 1 章正文里，沈泽是在什么地方听到刘康坠楼消息的？"
    });
    const a2Pass = a2.reply.includes("食堂") && a2.toolEvents.some((e) => e.ok);
    results.push({
      scenario: "A2_tool_grounded_comprehension",
      pass: a2Pass,
      reply: a2.reply.slice(0, 200),
      toolEvents: a2.toolEvents.map((e) => `${e.tool}:${e.ok ? "ok" : e.error}`),
      cost: a2.usage.cost
    });
    console.error(`[A2] pass=${a2Pass} reply="${a2.reply.slice(0, 80)}..." tools=${a2.toolEvents.length}`);

    // ========== 场景 B：编辑 ==========
    console.error("[B] edit flow...");
    const b = await runChatTurn({
      projectRoot,
      project,
      registry,
      modelClient,
      userMessage: "把第1章的六楼改成十二楼"
    });
    const bPending = b.pendingAction?.tool === "edit_chapter";
    let bEdit = false;
    if (bPending) {
      console.error(`[B] pending action confirmed: ${JSON.stringify(b.pendingAction.args)}`);
      const resumed = await resumeChatTurn({
        projectRoot,
        project,
        registry,
        modelClient,
        approve: true
      });
      const content = await fs.readFile(chapterPath, "utf8");
      bEdit = content.includes("十二楼");
      console.error(`[B] resumed, file contains 十二楼=${bEdit}`);
    } else {
      console.error(`[B] no pending edit action; reply="${b.reply.slice(0, 80)}..."`);
    }
    const checkpoints = await fs.readdir(path.join(projectRoot, "checkpoints")).catch(() => []);
    results.push({
      scenario: "B_edit",
      pass: bPending && bEdit,
      pendingAction: bPending,
      editApplied: bEdit,
      checkpoints: checkpoints.length,
      reply: b.reply.slice(0, 200),
      toolEvents: b.toolEvents.map((e) => `${e.tool}:${e.ok ? "ok" : e.error}`),
      cost: b.usage.cost
    });
    console.error(`[B] pass=${bPending && bEdit} pending=${bPending} edit=${bEdit} checkpoints=${checkpoints.length}`);

    // ========== 场景 C：fact-check 拦截率 ==========
    console.error("[C] fact-check corpus...");
    const corpus = await loadCorpus();
    const cResults = [];
    for (const fixture of corpus) {
      const messages = buildFactCheckMessages({
        chapterNo: 2,
        draft: fixture.draft,
        facts: fixture.continuity_facts,
        timeline: fixture.timeline || []
      });
      try {
        const result = await modelClient.generate({
          project,
          stage: "fact_check",
          messages
        });
        const parsed = parseFactCheck(result.text);
        const pass = fixture.expect === "conflict"
          ? parsed.conflicts.length > 0
          : parsed.conflicts.length === 0;
        cResults.push({ name: fixture.name, pass, conflicts: parsed.conflicts.length, expect: fixture.expect });
        console.error(`[C] ${fixture.name}: pass=${pass} conflicts=${parsed.conflicts.length} expect=${fixture.expect}`);
      } catch (error) {
        cResults.push({ name: fixture.name, pass: false, error: error.message });
        console.error(`[C] ${fixture.name}: ERROR ${error.message}`);
      }
    }
    const conflictCases = cResults.filter((r) => corpus.find((f) => f.name === r.name)?.expect === "conflict");
    const passCases = cResults.filter((r) => corpus.find((f) => f.name === r.name)?.expect === "pass");
    const interceptRate = conflictCases.length ? conflictCases.filter((r) => r.pass).length / conflictCases.length : 1;
    const falseKillCount = passCases.filter((r) => !r.pass).length;
    const cPass = corpus.length > 0 && interceptRate === 1 && falseKillCount === 0;
    results.push({
      scenario: "C_fact_check",
      pass: cPass,
      interceptRate,
      falseKillCount,
      goodSamples: passCases.length,
      details: cResults
    });

    // ========== 场景 D：指挥落地（outline + queue + start_run 闭环）==========
    console.error("[D] command pipeline...");
    try {
      // 注册控制工具
      const dRegistry = createToolRegistry();
      registerReadTools(dRegistry);
      registerWriteTools(dRegistry);
      registerControlTools(dRegistry);

      // 设置 YOLO 模式（免确认）
      await updateProjectSettings(projectRoot, { tool_permissions: { yolo: true, auto_edit: true, safe_edit: true, read_only: false } });
      const dProject = await loadProject(projectRoot);

      // 构造 fake server（startProjectRun 记录调用不真跑）
      let startRunCalled = false;
      const fakeServer = {
        runJobs: new Map(),
        getTaskQueue: async () => ({
          promoteNext: async () => null,
          enqueue: async () => ({})
        }),
        startProjectRun: async () => { startRunCalled = true; return { started: true }; }
      };

      const d = await runChatTurn({
        projectRoot,
        project: dProject,
        registry: dRegistry,
        modelClient,
        server: fakeServer,
        userMessage: "把大纲改成「第 2 章沈泽去工地」，然后写到第 2 章"
      });

      const dToolNames = d.toolEvents.map((e) => e.tool);
      const dOutlineOk = d.toolEvents.some((e) => e.tool === "update_outline" && e.ok);
      const dQueueOk = d.toolEvents.some((e) => e.tool === "queue_chapters" && e.ok);
      // start_run 调用与否记录入报告不计 fail（部分模型保守）
      const dStartRun = d.toolEvents.some((e) => e.tool === "start_run");
      const dPass = dOutlineOk && dQueueOk;

      results.push({
        scenario: "D_command_pipeline",
        pass: dPass,
        outlineOk: dOutlineOk,
        queueOk: dQueueOk,
        startRunCalled: dStartRun || startRunCalled,
        toolEvents: d.toolEvents.map((e) => `${e.tool}:${e.ok ? "ok" : e.error}`),
        reply: d.reply.slice(0, 200),
        cost: d.usage.cost
      });
      console.error(`[D] pass=${dPass} outline=${dOutlineOk} queue=${dQueueOk} startRun=${dStartRun || startRunCalled}`);
    } catch (error) {
      results.push({ scenario: "D_command_pipeline", pass: false, error: error.message });
      console.error(`[D] ERROR ${error.message}`);
    }

    // ========== 场景 E：归档语义 ==========
    console.error("[E] archive semantics...");
    try {
      // 恢复正常权限
      await updateProjectSettings(projectRoot, { tool_permissions: { yolo: false, auto_edit: false, safe_edit: true, read_only: false } });

      // E1: 归档项目后尝试编辑 → 应被拒绝
      await updateProjectSettings(projectRoot, { archived_at: new Date().toISOString() });
      const eProjectArchived = await loadProject(projectRoot);

      const eRegistry = createToolRegistry();
      registerReadTools(eRegistry);
      registerWriteTools(eRegistry);

      const e1 = await runChatTurn({
        projectRoot,
        project: eProjectArchived,
        registry: eRegistry,
        modelClient,
        userMessage: "把第1章六楼改成十二楼"
      });
      const e1Rejected = e1.toolEvents.some((e) => e.tool === "edit_chapter" && !e.ok)
        || (e1.reply && e1.reply.includes("归档"));
      results.push({
        scenario: "E1_archive_reject_edit",
        pass: e1Rejected,
        toolEvents: e1.toolEvents.map((e) => `${e.tool}:${e.ok ? "ok" : e.error}`),
        reply: e1.reply?.slice(0, 200) ?? "",
        cost: e1.usage.cost
      });
      console.error(`[E1] pass=${e1Rejected} tools=${e1.toolEvents.map((e) => e.tool).join(",")}`);

      // E2: 归档项目导出 → 豁免名单放行
      const e2 = await runChatTurn({
        projectRoot,
        project: eProjectArchived,
        registry: eRegistry,
        modelClient,
        userMessage: "导出全书"
      });
      const e2ExportOk = e2.toolEvents.some((e) => e.tool === "export_book" && e.ok);
      results.push({
        scenario: "E2_archive_export_exempt",
        pass: e2ExportOk,
        toolEvents: e2.toolEvents.map((e) => `${e.tool}:${e.ok ? "ok" : e.error}`),
        reply: e2.reply?.slice(0, 200) ?? "",
        cost: e2.usage.cost
      });
      console.error(`[E2] pass=${e2ExportOk} tools=${e2.toolEvents.map((e) => e.tool).join(",")}`);
    } catch (error) {
      results.push({ scenario: "E_archive_semantics", pass: false, error: error.message });
      console.error(`[E] ERROR ${error.message}`);
    }

    // ========== 场景 F：过程流增量落盘 + 中途停止（S4.5）==========
    console.error("[F] incremental persistence + cancel...");
    try {
      // F1: 回合进行中，tool 消息应已增量写入 chat_history.jsonl。
      // 判定窗口 = "已见 tool 消息且尚未见本轮 assistant 消息"，否则只能证明事后写入。
      const historyFile = path.join(projectRoot, "chat_history.jsonl");
      const baselineLines = (await fs.readFile(historyFile, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
      let sawIncrementalTool = false;
      const f1Turn = runChatTurn({
        projectRoot, project, registry, modelClient,
        userMessage: "第 1 章正文里，沈泽是在什么地方听到消息的？必须读原文查证后回答。"
      });
      const f1Poll = (async () => {
        for (let i = 0; i < 120; i += 1) {
          await new Promise((r) => setTimeout(r, 500));
          const lines = (await fs.readFile(historyFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
          const fresh = lines.slice(baselineLines).map((l) => { try { return JSON.parse(l); } catch { return null; } });
          const hasTool = fresh.some((m) => m?.role === "tool");
          const hasAssistant = fresh.some((m) => m?.role === "assistant");
          if (hasTool && !hasAssistant) { sawIncrementalTool = true; return; }
          if (hasAssistant) return; // 回合已结束，未捕获增量窗口
        }
      })();
      const f1 = await f1Turn;
      await f1Poll;
      const f1Pass = sawIncrementalTool && f1.toolEvents.length > 0;
      results.push({
        scenario: "F1_incremental_tool_persistence",
        pass: f1Pass,
        sawIncrementalTool,
        toolEvents: f1.toolEvents.map((e) => `${e.tool}:${e.ok ? "ok" : e.error}`),
        cost: f1.usage.cost
      });
      console.error(`[F1] pass=${f1Pass} incremental=${sawIncrementalTool}`);

      // F2: 中途 abort → cancelled:true + 「（已停止。）」落盘。
      // 500ms 时模型首轮调用几乎必然仍在途（真实 API 延迟 >1s）；若模型异常快导致 cancelled=false，重跑一次再判。
      const controller = new AbortController();
      const f2Turn = runChatTurn({
        projectRoot, project, registry, modelClient, signal: controller.signal,
        userMessage: "把第 1 章每一段都总结一遍，再查一遍设定记忆和大纲。"
      });
      setTimeout(() => controller.abort("用户停止"), 500);
      const f2 = await f2Turn;
      const f2History = (await fs.readFile(historyFile, "utf8")).split("\n").filter(Boolean);
      const f2Last = JSON.parse(f2History.at(-1));
      const f2Pass = f2.cancelled === true && f2Last.content === "（已停止。）";
      results.push({
        scenario: "F2_cancel_mid_turn",
        pass: f2Pass,
        cancelled: f2.cancelled === true,
        lastMessage: String(f2Last.content ?? "").slice(0, 50),
        cost: f2.usage.cost
      });
      console.error(`[F2] pass=${f2Pass} cancelled=${f2.cancelled}`);
    } catch (error) {
      results.push({ scenario: "F_process_stream", pass: false, error: error.message });
      console.error(`[F] ERROR ${error.message}`);
    }

    // 写成本报告
    await modelClient.costTracker.writeProjectReport(projectRoot);
  } catch (error) {
    results.push({ scenario: "error", error: error.message });
    console.error(`[FATAL] ${error.message}\n${error.stack}`);
  }

  const allPass = results.every((r) => r.pass === true);
  // totalCost 从 costTracker 总账取（覆盖全部场景的模型调用，含 C 的裸 generate）
  const totalCost = modelClient ? Number(modelClient.costTracker.getSummary().estimatedCost ?? 0) : 0;
  const report = {
    ok: allPass,
    provider: { baseUrlHost: baseUrl.replace(/^https?:\/\//u, "").split("/")[0], model },
    results,
    totalCost: Number(totalCost.toFixed(6)),
    timestamp: new Date().toISOString()
  };
  const reportDir = path.resolve(path.dirname(process.argv[1]), "..", "docs", "superpowers", "reports");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${new Date().toISOString().slice(0, 10)}-s3-chat-online-verification.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.error(`report written: ${reportPath}`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(allPass ? 0 : 1);
}

async function loadCorpus() {
  const scriptDir = path.dirname(path.resolve(process.cwd(), process.argv[1]));
  const projectRoot = path.resolve(scriptDir, "..");
  const corpusDir = path.join(projectRoot, "tests", "fixtures", "s2-corpus");
  try {
    const files = (await fs.readdir(corpusDir)).filter((f) => f.endsWith(".json"));
    return Promise.all(
      files.map((f) => fs.readFile(path.join(corpusDir, f), "utf8").then(JSON.parse))
    );
  } catch {
    console.error("[C] warning: s2-corpus not found, skipping fact-check scenario");
    return [];
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
});
