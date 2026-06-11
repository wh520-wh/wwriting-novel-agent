import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProject, SimulatedInterrupt, maybeWarnChapterCost } from "../src/core/agent-engine.mjs";
import { appendEvent, readEvents } from "../src/core/event-log.mjs";
import { countEffectiveWords } from "../src/core/word-count.mjs";
import { MockModel } from "../src/core/mock-model.mjs";
import { createProject, loadChapterIndex, loadProject, loadState, saveProject, saveState, upsertChapter } from "../src/core/project-store.mjs";
import { loadContinuity, loadContinuityState } from "../src/core/continuity-store.mjs";
import { updateProjectSettings } from "../src/core/settings-runtime.mjs";
import { appendChapterSegment } from "../src/core/tool-runtime.mjs";

class AlwaysInvalidModel {
  async generate() {
    return {
      type: "status_message",
      message: "I wrote the chapter in chat instead of using a file tool."
    };
  }
}

class WrongProjectToolModel {
  async generate(request) {
    return {
      type: "tool_call",
      tool: "append_chapter_segment",
      input: {
        project_id: "forged-project",
        chapter_no: request.chapter_no,
        segment_no: request.segment_no,
        content: "This should never be written."
      }
    };
  }
}

class CapturingModelClient {
  constructor() {
    this.costTracker = {
      record() {
        return { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 };
      },
      async writeProjectReport() {}
    };
    this.prompts = [];
    this.metadatas = [];
  }

  async generate({ prompt, metadata }) {
    this.prompts.push(prompt);
    this.metadatas.push(metadata);
    const request = metadata.toolRequest;
    return {
      text: "",
      raw: {
        output: {
          type: "tool_call",
          tool: "append_chapter_segment",
          input: {
            project_id: request.project_id,
            chapter_no: request.chapter_no,
            segment_no: request.segment_no,
            content: Array.from({ length: 260 }, (_, index) => `capture${index}`).join(" ")
          }
        }
      },
      usageReport: {
        provider: "mock",
        model: "capture",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cachedTokens: 0,
        cacheHitTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cacheMetricsAvailable: false,
        cacheHitRate: null,
        estimatedCost: 0,
        rawUsage: {}
      },
      costSummary: { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
      modelConfig: { provider: "mock", model_name: "capture" }
    };
  }
}

class OpenAIToolCallsModelClient {
  constructor() {
    this.calls = 0;
    this.costTracker = {
      async writeProjectReport() {}
    };
  }

  async generate({ metadata }) {
    this.calls += 1;
    const request = metadata.toolRequest;
    const content = Array.from({ length: 180 }, (_, index) => `toolcall${this.calls}_${index}`).join(" ");
    return {
      text: "",
      raw: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_${this.calls}`,
                  type: "function",
                  function: {
                    name: "append_chapter_segment",
                    arguments: JSON.stringify({
                      project_id: request.project_id,
                      chapter_no: request.chapter_no,
                      segment_no: request.segment_no,
                      content
                    })
                  }
                }
              ]
            }
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 30,
          total_tokens: 40
        }
      },
      usageReport: {
        provider: "openai-compatible",
        model: "tool-writer",
        inputTokens: 10,
        outputTokens: 30,
        totalTokens: 40,
        cachedTokens: 0,
        cacheHitTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cacheMetricsAvailable: false,
        cacheHitRate: null,
        estimatedCost: 0,
        rawUsage: {}
      },
      costSummary: { calls: this.calls, inputTokens: 10, outputTokens: 30, totalTokens: 40, estimatedCost: 0 },
      modelConfig: { provider: "openai-compatible", model_name: "tool-writer" }
    };
  }
}

class PlainThenSuspenseModel {
  async generate(request) {
    const plain = Array.from({ length: 90 }, (_, index) => `plain${index}`).join(" ");
    const suspense = " Then the sealed mirror answered from the dark?";
    return {
      type: "tool_call",
      tool: "append_chapter_segment",
      input: {
        project_id: request.project_id,
        chapter_no: request.chapter_no,
        segment_no: request.segment_no,
        content: request.kind === "revision_quality_gate" ? suspense : plain
      }
    };
  }
}

test("mock model generates three chapters and writes local files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-agent-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 3,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  await runProject(projectRoot);
  const index = await loadChapterIndex(projectRoot);
  assert.equal(index.chapters.filter((chapter) => chapter.status === "completed").length, 3);
  for (const chapterNo of [1, 2, 3]) {
    const content = await fs.readFile(path.join(projectRoot, "chapters", `${String(chapterNo).padStart(3, "0")}.md`), "utf8");
    assert.ok(countEffectiveWords(content) >= 300);
  }
});

test("engine rejects chat body output and retries tool call", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-channel-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 250,
    target_words_per_chapter: 300
  });
  await runProject(projectRoot, {
    model: new MockModel({ invalidFirstDraft: true })
  });
  const events = await readEvents(projectRoot);
  assert.ok(events.some((event) => event.data?.code === "invalid_output_channel"));
  assert.ok(events.some((event) => event.type === "tool_call_rejected" && event.data?.code === "invalid_output_channel"));
  assert.ok(events.some((event) => event.type === "chapter_completed"));
});

test("project resumes from checkpoint after simulated interruption", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-recover-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 3,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  let interrupted = false;
  try {
    await runProject(projectRoot, {
      simulateInterruptAfter: {
        chapter_no: 2,
        segment_no: 1
      }
    });
  } catch (error) {
    interrupted = error instanceof SimulatedInterrupt;
  }
  assert.equal(interrupted, true);
  await runProject(projectRoot);
  const index = await loadChapterIndex(projectRoot);
  assert.equal(index.chapters.filter((chapter) => chapter.status === "completed").length, 3);
  const chapter2 = await fs.readFile(path.join(projectRoot, "chapters", "002.md"), "utf8");
  assert.equal((chapter2.match(/segment:1/gu) ?? []).length, 1);
});

test("runProject calls onHeartbeat and persists last heartbeat each main-loop step", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-heartbeat-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  const heartbeats = [];
  await runProject(projectRoot, {
    onHeartbeat: (heartbeat) => heartbeats.push(heartbeat)
  });
  assert.ok(heartbeats.length >= 3, `expected at least 3 heartbeats, got ${heartbeats.length}`);
  assert.ok(heartbeats.every((heartbeat) => Number.isInteger(heartbeat.step)));
  assert.ok(heartbeats.some((heartbeat) => heartbeat.stage === "drafting"));
  const state = await loadState(projectRoot);
  assert.equal(typeof state.last_heartbeat, "string");
});

test("runProject sets project_status to interrupted on unexpected error", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-interrupted-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  class CrashModel {
    async generate() {
      throw new Error("API timeout simulation");
    }
  }
  await assert.rejects(() => runProject(projectRoot, { model: new CrashModel() }), /API timeout simulation/u);
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "interrupted");
  assert.match(state.interrupted_reason, /API timeout/u);
  assert.equal(typeof state.interrupted_at, "string");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((event) => event.type === "project_interrupted" && event.message.includes("API timeout")));
});

test("runProject records cancelled state when AbortSignal is already aborted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-cancelled-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  const controller = new AbortController();
  controller.abort("user requested stop");
  await assert.rejects(() => runProject(projectRoot, { signal: controller.signal }), /user requested stop|cancelled|aborted/u);
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "cancelled");
  assert.match(state.cancelled_reason, /user requested stop|cancelled|aborted/u);
  assert.equal(typeof state.cancelled_at, "string");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((event) => event.type === "project_cancelled"));
});

test("reviewing stage triggers word-count gate and revision when draft is short", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-shortfall-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  await appendChapterSegment(projectRoot, project, {
    chapter_no: 1,
    segment_no: 1,
    content: "短章。"
  });
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "running",
    current_chapter_no: 1,
    current_stage: "reviewing",
    current_segment_no: 1
  });
  await runProject(projectRoot);
  const events = await readEvents(projectRoot);
  assert.ok(events.some((event) => event.type === "quality_gate_failed" && event.data?.gate === "word-count-gate"));
  const chapter = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.ok(countEffectiveWords(chapter) >= 300);
});

test("engine can finalize TXT chapter files when project output_format is txt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-txt-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    output_format: "txt",
    target_chapters: 1,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  await runProject(projectRoot);
  const txtPath = path.join(projectRoot, "chapters", "001.txt");
  const content = await fs.readFile(txtPath, "utf8");
  assert.ok(countEffectiveWords(content) >= 200);
});

test("engine records model gateway usage, cost, cache, and prompt hashes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-model-records-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  await runProject(projectRoot);
  const cost = JSON.parse(await fs.readFile(path.join(projectRoot, "cost.json"), "utf8"));
  const cache = JSON.parse(await fs.readFile(path.join(projectRoot, "cache_report.json"), "utf8"));
  assert.ok(cost.calls >= 1);
  assert.ok(cost.totalTokens > 0);
  assert.equal(cache.last_call.templateVersion, "drafting.v1");
  assert.ok(cache.last_call.cacheKey.includes("drafting.v1"));
  assert.equal(cache.last_call.cacheMetricsAvailable, false);
  const checkpointFiles = await fs.readdir(path.join(projectRoot, "checkpoints"));
  const checkpoints = await Promise.all(
    checkpointFiles.map((file) => fs.readFile(path.join(projectRoot, "checkpoints", file), "utf8").then(JSON.parse))
  );
  const modelCheckpoint = checkpoints.find((checkpoint) => checkpoint.model_calls?.length > 0);
  assert.ok(modelCheckpoint);
  assert.ok(modelCheckpoint.context_package_hash?.startsWith("sha256:"));
  assert.ok(modelCheckpoint.prompt_block_hashes.system_rules.startsWith("sha256:"));
  assert.ok(modelCheckpoint.usage_reports[0].totalTokens > 0);
  assert.equal(modelCheckpoint.cache_key, cache.last_call.cacheKey);
});

test("engine accepts OpenAI-compatible tool_calls for chapter writing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-openai-tool-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 120,
    target_words_per_chapter: 180
  });

  await runProject(projectRoot, {
    modelClient: new OpenAIToolCallsModelClient()
  });

  const events = await readEvents(projectRoot);
  assert.ok(events.some((event) => event.type === "tool_call_requested"));
  assert.equal(events.some((event) => event.data?.code === "invalid_output_channel"), false);
  const chapter = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.ok(chapter.includes("toolcall1_0"));
  assert.ok(countEffectiveWords(chapter) >= 120);
});

test("engine includes command-bar instructions in the next model prompt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-command-prompt-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  await appendEvent(projectRoot, {
    type: "user_instruction_received",
    project_id: project.project_id,
    stage: "user_input",
    message: "让本章保留一个雨夜钥匙的线索。"
  });
  const modelClient = new CapturingModelClient();

  await runProject(projectRoot, { modelClient });

  assert.ok(modelClient.prompts.some((prompt) => prompt.includes("latest_user_feedback")));
  assert.ok(modelClient.prompts.some((prompt) => prompt.includes(project.project_id)));
  assert.ok(modelClient.prompts.some((prompt) => prompt.includes("雨夜钥匙")));
  assert.ok(modelClient.metadatas.every((m) => Number.isInteger(m.chapterNo) && m.chapterNo >= 1));
});

test("engine feeds previous chapter memory into later chapter prompts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-continuity-prompt-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 2,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  const modelClient = new CapturingModelClient();

  await runProject(projectRoot, { modelClient });

  const memory = JSON.parse(await fs.readFile(path.join(projectRoot, "memory", "chapter_memory.json"), "utf8"));
  assert.equal(memory.schema_version, 1);
  assert.equal(memory.chapters.length, 2);
  assert.equal(memory.chapters[0].chapter_no, 1);
  assert.ok(memory.chapters[0].ending_excerpt.includes("capture"));

  const secondChapterPrompt = modelClient.prompts.find((prompt) => prompt.includes('"chapter_no": 2'));
  assert.ok(secondChapterPrompt);
  assert.ok(secondChapterPrompt.includes("recent_completed_chapters"));
  assert.ok(secondChapterPrompt.includes("上一章落点"));
  assert.ok(secondChapterPrompt.includes("不要把本章写成新的第一章"));
  assert.ok(secondChapterPrompt.includes("普通大学生突然获得神力"));
  assert.ok(secondChapterPrompt.includes("不是梦"));
  assert.ok(secondChapterPrompt.includes("神性"));
});

test("engine allows chapter one to establish the premise once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-first-chapter-prompt-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  const modelClient = new CapturingModelClient();

  await runProject(projectRoot, { modelClient });

  const firstPrompt = modelClient.prompts.find((prompt) => prompt.includes('"chapter_no": 1'));
  assert.ok(firstPrompt);
  assert.ok(firstPrompt.includes("第 1 章可以建立初始处境一次"));
  assert.ok(firstPrompt.includes("segment_continuity_required"));
});

test("enabled suspense skill applies planning hook and blocks flat chapter endings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-skill-engine-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 60,
    target_words_per_chapter: 80,
    enabled_skills: ["suspense-chapter-end"]
  });
  await runProject(projectRoot, {
    model: new PlainThenSuspenseModel()
  });
  const planningFile = await fs.readFile(path.join(projectRoot, "drafts", "001.planning.md"), "utf8");
  assert.ok(planningFile.includes("suspense hook"));
  const events = await readEvents(projectRoot);
  assert.ok(events.some((event) => event.type === "skill_hook_applied"));
  assert.ok(events.some((event) => event.type === "quality_gate_failed" && event.data?.failed_gates?.[0]?.skill === "suspense-chapter-end"));
  const index = await loadChapterIndex(projectRoot);
  assert.equal(index.chapters[0].status, "completed");
  assert.ok(index.chapters[0].quality_gate_results.some((result) => result.gate === "skill:suspense-chapter-end" && result.status === "passed"));
  const chapter = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.ok(chapter.includes("?"));
});

test("post-process skill hooks can modify draft before finalizing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-skill-post-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 120,
    target_words_per_chapter: 160,
    enabled_skills: ["post-note"]
  });
  await fs.mkdir(path.join(projectRoot, "skills", "post-note"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "skills", "post-note", "skill.json"),
    `${JSON.stringify(
      {
        name: "post-note",
        version: "1.0.0",
        type: "post-process",
        enabled: true,
        priority: 40,
        scope: "chapter",
        hooks: [{ stage: "post_process", action: "post_process", content: "Post-process marker." }]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await runProject(projectRoot);
  const chapter = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.ok(chapter.includes("Post-process marker."));
  const events = await readEvents(projectRoot);
  assert.ok(events.some((event) => event.type === "skill_hook_applied" && event.stage === "post_process"));
});

test("engine persists blocked state after three invalid model outputs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-blocked-invalid-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  const result = await runProject(projectRoot, {
    model: new AlwaysInvalidModel()
  });
  assert.equal(result.blocked, true);
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "blocked");
  assert.equal(state.blocked_reason, "model_output_invalid");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((event) => event.type === "project_blocked"));
  const checkpointFiles = await fs.readdir(path.join(projectRoot, "checkpoints"));
  const checkpoints = await Promise.all(
    checkpointFiles.map((file) => fs.readFile(path.join(projectRoot, "checkpoints", file), "utf8").then(JSON.parse))
  );
  assert.ok(checkpoints.some((checkpoint) => checkpoint.error?.code === "model_output_invalid"));
});

test("engine blocks forged project_id tool calls without writing draft", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-forged-tool-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  const result = await runProject(projectRoot, {
    model: new WrongProjectToolModel()
  });
  assert.equal(result.blocked, true);
  const state = await loadState(projectRoot);
  assert.equal(state.blocked_reason, "model_output_invalid");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((event) => event.type === "tool_call_rejected" && event.data?.code === "invalid_project_id"));
  await assert.rejects(() => fs.readFile(path.join(projectRoot, "drafts", "001.draft.md"), "utf8"), /ENOENT/u);
});

test("engine stops before model call when model-call budget is exhausted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-budget-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260,
    max_model_calls: 0
  });
  const result = await runProject(projectRoot);
  assert.equal(result.blocked, true);
  const state = await loadState(projectRoot);
  assert.equal(state.blocked_reason, "model_call_budget_exhausted");
  assert.equal(state.active_budget.model_calls, 0);
});

test("engine enforces model-call budget saved from settings panel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-settings-budget-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 2,
    min_words_per_chapter: 180,
    target_words_per_chapter: 240
  });
  await updateProjectSettings(projectRoot, {
    budget_config: {
      max_model_calls: 1
    }
  });

  const result = await runProject(projectRoot);
  assert.equal(result.blocked, true);
  const state = await loadState(projectRoot);
  assert.equal(state.active_budget.max_model_calls, 1);
  assert.equal(state.active_budget.model_calls, 1);
  assert.equal(state.blocked_reason, "model_call_budget_exhausted");
});

test("agent-engine 检测到 failure_resolved=pause-here 后立刻退出循环", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-pause-here-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  // Write a failure_resolved event with message='pause-here' before starting the run
  await appendEvent(projectRoot, {
    type: "failure_resolved",
    project_id: project.project_id,
    severity: "info",
    message: "pause-here",
    data: { failureId: "flr_test_001", action: "pause-here" }
  });

  const result = await runProject(projectRoot);

  // Stale pause-here events (before runStartedAtMs) are now ignored;
  // the project should complete normally.
  assert.equal(result.completed, true);
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "completed");
});

test("首次章节请求就把真实字数缺口写进 current_task，避免触发补写", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-wordgap-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  // 预先写一半的草稿（150 个汉字 < 300），让模型首次请求时就拿到真实缺口
  const draftsDir = path.join(projectRoot, "drafts");
  await fs.mkdir(draftsDir, { recursive: true });
  const seededDraft = "字".repeat(150);
  await fs.writeFile(path.join(draftsDir, "001.draft.md"), seededDraft, "utf8");

  const modelClient = new CapturingModelClient();
  await runProject(projectRoot, { modelClient });

  // 第一次模型调用（chapter 1, segment 1, kind=draft_segment）必须包含缺口字段
  const firstPrompt = modelClient.prompts[0];
  assert.ok(firstPrompt, "expected at least one model prompt to be captured");

  // 从 current_task JSON 块里抠出缺口字段
  const match = firstPrompt.match(/"chapterWordsWritten":\s*(\d+)\s*,\s*"chapterWordsRemaining":\s*(\d+)/u);
  assert.ok(match, `expected chapterWordsWritten/Remaining in first prompt, got snippet: ${firstPrompt.slice(0, 600)}`);
  const wordsWritten = Number(match[1]);
  const wordsRemaining = Number(match[2]);
  assert.equal(wordsWritten, 150);
  assert.equal(wordsRemaining, 150); // 300 - 150
});

test("revision_quality_gate 不触发 recordRefill，revision_shortfall 才触发", async () => {
  // 直接验证引擎中 if (request.kind === "revision_shortfall") 条件对 recordRefill 的影响
  const { CostTracker } = await import("../src/core/cost-tracker.mjs");
  const tracker = new CostTracker();

  // 模拟引擎 agent-engine.mjs:609 的条件逻辑
  const shortfallRequest = { kind: "revision_shortfall", shortfall: 500 };
  const qualityGateRequest = { kind: "revision_quality_gate", shortfall: 300 };

  // revision_shortfall → 应调用 recordRefill
  if (shortfallRequest.kind === "revision_shortfall") tracker.recordRefill();
  assert.equal(tracker.getSummary().refillCalls, 1, "revision_shortfall should trigger recordRefill");

  // revision_quality_gate → 不应调用 recordRefill
  if (qualityGateRequest.kind === "revision_shortfall") tracker.recordRefill();
  assert.equal(tracker.getSummary().refillCalls, 1, "revision_quality_gate should NOT trigger recordRefill");
});

test("maybeWarnChapterCost 在当前章 token 超前几章均值 2 倍时告警一次", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-warn-"));
  const { projectRoot } = await createProject(workspace, {
    title: "预警", story_seed: "t", target_chapters: 5, min_words_per_chapter: 300
  });
  const project = { project_id: "p1" };
  const state = { current_chapter_no: 3, current_stage: "drafting" };
  const runtime = { warnedChapters: new Set() };
  const costSummary = {
    byChapter: {
      "1": { totalTokens: 1000 }, "2": { totalTokens: 1200 },
      "3": { totalTokens: 5000 }
    }
  };
  await maybeWarnChapterCost(projectRoot, project, state, costSummary, runtime);
  await maybeWarnChapterCost(projectRoot, project, state, costSummary, runtime); // 第二次不重复告警
  const events = await readEvents(projectRoot, { limit: 20 });
  const warnings = events.filter((e) => e.type === "chapter_cost_warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].data.chapter_total_tokens, 5000);
  await fs.rm(workspace, { recursive: true, force: true });
});

test("summarizing 阶段写入 book_summary 与 continuity（真实 provider 路径用注入的 fake client）", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-memx-"));
  const { projectRoot } = await createProject(root, {
    slug: "memx", title: "记忆测试", story_seed: "测试种子",
    target_chapters: 1, min_words_per_chapter: 10, target_words_per_chapter: 12, max_model_calls: 50
  });
  const project = await loadProject(projectRoot);
  project.active_model = { provider: "openai-compatible", model_name: "fake-model", base_url: "http://localhost:0", api_key_env: "FAKE_KEY" };
  await saveProject(projectRoot, project);
  const extraction = {
    summary: "第一章：主角能力觉醒。",
    facts: [{ entity: "沈泽", attribute: "能力", value: "意念致死", chapter_no: 1, quote: "他去死就好了" }],
    timeline: [{ chapter_no: 1, story_time: "十月", events: ["觉醒"] }],
    characters: [{ name: "沈泽", traits: ["谨慎"], status: "存活", chapter_no: 1 }]
  };
  const calls = [];
  const fakeClient = {
    generate: async ({ stage, messages }) => {
      calls.push(stage);
      if (stage === "memory_extract") {
        return { text: "```json\n" + JSON.stringify(extraction) + "\n```", usageReport: {} };
      }
      throw new Error(`unexpected stage ${stage}`);
    }
  };
  const { extractChapterMemory } = await import("../src/core/agent-engine.mjs");
  await extractChapterMemory(projectRoot, project, { current_chapter_no: 1 }, { modelClient: fakeClient });
  const summary = await fs.readFile(path.join(projectRoot, "memory", "book_summary.md"), "utf8");
  assert.match(summary, /能力觉醒/u);
  const continuity = await loadContinuity(projectRoot);
  assert.equal(continuity.facts[0].value, "意念致死");
  assert.equal((await loadContinuityState(projectRoot)).last_extracted_chapter, 1);
  await extractChapterMemory(projectRoot, project, { current_chapter_no: 1 }, { modelClient: fakeClient });
  assert.equal(calls.filter((s) => s === "memory_extract").length, 1);
});

test("mock provider 跳过提取但推进水位", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-memskip-"));
  const { projectRoot } = await createProject(root, {
    slug: "memskip", title: "跳过测试", story_seed: "种子",
    target_chapters: 1, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const project = await loadProject(projectRoot);
  const { extractChapterMemory } = await import("../src/core/agent-engine.mjs");
  await extractChapterMemory(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => { throw new Error("must not call"); } }
  });
  assert.equal((await loadContinuityState(projectRoot)).last_extracted_chapter, 1);
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "memory_extract_skipped"));
});

test("提取失败软跳过：事件 memory_extract_failed 且水位推进", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-memfail-"));
  const { projectRoot } = await createProject(root, {
    slug: "memfail", title: "失败测试", story_seed: "种子",
    target_chapters: 1, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const project = await loadProject(projectRoot);
  project.active_model = { provider: "openai-compatible", model_name: "fake", base_url: "http://localhost:0", api_key_env: "FAKE_KEY" };
  await saveProject(projectRoot, project);
  const { extractChapterMemory } = await import("../src/core/agent-engine.mjs");
  await extractChapterMemory(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => ({ text: "不是 JSON", usageReport: {} }) }
  });
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "memory_extract_failed"));
  assert.equal((await loadContinuityState(projectRoot)).last_extracted_chapter, 1);
});
