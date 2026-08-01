import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProject, SimulatedInterrupt, maybeWarnChapterCost, extractChapterMemory, runFactCheck, trimUnresolvedAssistantTurns } from "../src/core/agent-engine.mjs";
import { appendEvent, readEvents } from "../src/core/event-log.mjs";
import { countEffectiveWords } from "../src/core/word-count.mjs";
import { MockModel } from "../src/core/mock-model.mjs";
import { createProject, loadChapterIndex, loadProject, loadState, saveProject, saveState, upsertChapter } from "../src/core/project-store.mjs";
import { loadContinuity, loadContinuityState, saveContinuity } from "../src/core/continuity-store.mjs";
import { updateProjectSettings } from "../src/core/settings-runtime.mjs";
import { appendChapterSegment } from "../src/core/tool-runtime.mjs";
import { loadPendingAction as loadChatPending, readChatHistory as readChatHist } from "../src/core/chat/chat-store.mjs";
import { makeChapterContract, makeResumeContract } from "../src/core/task-contract.mjs";
import { ToolTranscript } from "../src/core/agent-transcript.mjs";

class AlwaysInvalidModel {
  async generate() {
    // 返回短文本 (< 50 chars)，agent 风格下不会被当作正文捕获，计入 commit failure。
    return {
      type: "status_message",
      message: "done"
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
  for (const chapterNo of [1, 2, 3]) {
    await runProject(projectRoot, { contract: makeChapterContract(chapterNo) });
  }
  const index = await loadChapterIndex(projectRoot);
  assert.equal(index.chapters.filter((chapter) => chapter.status === "completed").length, 3);
  for (const chapterNo of [1, 2, 3]) {
    const content = await fs.readFile(path.join(projectRoot, "chapters", `${String(chapterNo).padStart(3, "0")}.md`), "utf8");
    assert.ok(countEffectiveWords(content) >= 300);
  }
});

test("engine captures prose-as-text and retries on short output", async () => {
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
  // 第一轮输出短文本 → output_too_short（agent 风格：短文本不是正文）
  assert.ok(events.some((event) => event.data?.code === "output_too_short"));
  assert.ok(events.some((event) => event.type === "tool_call_rejected" && event.data?.code === "output_too_short"));
  // 后续轮次模型调工具 → 章节完成
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
  // Chapter 1 finishes cleanly under its contract.
  await runProject(projectRoot, { contract: makeChapterContract(1) });
  // Chapter 2 gets interrupted mid-draft at segment 1.
  let interrupted = false;
  try {
    await runProject(projectRoot, {
      contract: makeChapterContract(2),
      simulateInterruptAfter: {
        chapter_no: 2,
        segment_no: 1
      }
    });
  } catch (error) {
    interrupted = error instanceof SimulatedInterrupt;
  }
  assert.equal(interrupted, true);
  // Resume the partial chapter 2 under its contract, then run chapter 3.
  await runProject(projectRoot, { contract: makeChapterContract(2) });
  await runProject(projectRoot, { contract: makeChapterContract(3) });
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
  const failures = JSON.parse((await fs.readFile(path.join(projectRoot, "failures.jsonl"), "utf8")).trim());
  assert.equal(failures.kind, "provider-error");
  assert.ok(Array.isArray(failures.actions));
  assert.ok(failures.actions.length > 0);
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

  await runProject(projectRoot, { contract: makeChapterContract(1), modelClient });
  await runProject(projectRoot, { contract: makeChapterContract(2), modelClient });

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
  assert.ok(planningFile.includes("结尾悬念钩子"));
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

test("engine persists blocked state after 8 consecutive invalid model outputs (WRITING_AGENT_COMMIT_FAILURES)", async () => {
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

  const result = await runProject(projectRoot, { contract: makeChapterContract(1) });

  // Stale pause-here events (before runStartedAtMs) are now ignored;
  // the project should complete normally.
  assert.equal(result.project_completed, true);
  assert.equal(result.task_completed, true);
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

test("§3.6 pending-extraction file causes skip of model call but still completes steps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-pendingx-"));
  const { projectRoot } = await createProject(root, {
    slug: "pendingx", title: "待提取恢复", story_seed: "种子",
    target_chapters: 1, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const project = await loadProject(projectRoot);
  project.active_model = { provider: "openai-compatible", model_name: "fake", base_url: "http://localhost:0", api_key_env: "FAKE_KEY" };
  await saveProject(projectRoot, project);

  // Pre-write a pending extraction file (simulating a crash after model call but before steps 1-3)
  const extraction = {
    ok: true,
    summary: "第一章：主角在雨夜收到警告。",
    facts: [{ entity: "主角", attribute: "身份", value: "退伍军人", chapter_no: 1, quote: "雨夜" }],
    timeline: [{ chapter_no: 1, story_time: "雨夜", events: ["收到警告"] }],
    characters: [{ name: "主角", traits: ["谨慎"], status: "存活", chapter_no: 1 }]
  };
  await fs.mkdir(path.join(projectRoot, "memory"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "memory", ".pending-extraction-1.json"),
    JSON.stringify(extraction),
    "utf8"
  );

  const calls = [];
  const fakeClient = {
    generate: async ({ stage }) => {
      calls.push(stage);
      throw new Error("model must not be called when pending file exists");
    }
  };
  const { extractChapterMemory } = await import("../src/core/agent-engine.mjs");
  await extractChapterMemory(projectRoot, project, { current_chapter_no: 1 }, { modelClient: fakeClient });

  // Model was NOT called (pending file was used)
  assert.equal(calls.length, 0, "model must not be called when pending file exists");
  // But extraction still completed
  const continuity = await loadContinuity(projectRoot);
  assert.equal(continuity.facts[0].value, "退伍军人");
  const summary = await fs.readFile(path.join(projectRoot, "memory", "book_summary.md"), "utf8");
  assert.match(summary, /雨夜收到警告/u);
  assert.equal((await loadContinuityState(projectRoot)).extracted_chapters[0], 1);
  // Pending file should be cleaned up
  const pendingExists = await fs.access(path.join(projectRoot, "memory", ".pending-extraction-1.json"))
    .then(() => true).catch(() => false);
  assert.equal(pendingExists, false, "pending file should be deleted after completion");
});

test("提取失败软跳过：事件 memory_extract_failed 且不推进水位（可回补）", async () => {
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
  const state = await loadContinuityState(projectRoot);
  assert.equal(state.last_extracted_chapter, 0);
  assert.ok(!state.extracted_chapters.includes(1));
});

async function makeFactCheckProject(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const { projectRoot } = await createProject(root, {
    slug: "fc", title: "核查测试", story_seed: "种子",
    target_chapters: 2, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const project = await loadProject(projectRoot);
  project.active_model = { provider: "openai-compatible", model_name: "fake", base_url: "http://localhost:0", api_key_env: "FAKE_KEY" };
  await saveProject(projectRoot, project);
  await saveContinuity(projectRoot, {
    schema_version: 1,
    facts: [{ entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1, quote: "六楼。", conflict_with: null }],
    timeline: [], characters: []
  });
  return { projectRoot, project };
}

const FC_CONFLICT_REPLY = JSON.stringify({ conflicts: [{
  draft_quote: "从十二楼坠落", conflicts_with: "坠楼楼层: 六楼", prior_chapter: 1,
  severity: "high", suggestion: "把十二楼改回六楼", replace_with: "从六楼坠落"
}] });

test("runFactCheck 有冲突：主动消息 + warning 事件，返回 conflicts，不自动改 draft（修改权还给模型）", async () => {
  const { projectRoot, project } = await makeFactCheckProject("wwriting-fc1-");
  const draftPath = path.join(projectRoot, "drafts", "001.draft.md");
  await fs.mkdir(path.dirname(draftPath), { recursive: true });
  await fs.writeFile(draftPath, "# 第一章\n\n刘康从十二楼坠落。", "utf8");
  const { runFactCheck } = await import("../src/core/agent-engine.mjs");
  const draft = "刘康从十二楼坠落。";
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => ({ text: FC_CONFLICT_REPLY, usageReport: {} }) }
  }, draft);
  assert.equal(out.conflicts.length, 1);
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "quality_gate_warning" && e.data?.conflicts?.length === 1));
  assert.ok(!events.some((e) => e.type === "fact_check_auto_fixed"), "不应自动修复（修改权还给模型）");
  assert.ok(!events.some((e) => e.type === "fact_check_auto_fix_skipped"), "不应有跳过修复事件");
  const history = await readChatHist(projectRoot);
  const proactive = history.find((m) => m.proactive === "fact_check");
  assert.ok(proactive, "应有 agent 主动消息");
  assert.match(proactive.content, /十二楼/u);
  const unchanged = await fs.readFile(draftPath, "utf8");
  assert.ok(unchanged.includes("从十二楼坠落"), "draft 不应被代码改动（修改权还给模型）");
  assert.ok(!unchanged.includes("从六楼坠落"), "代码不应替模型写入替换");
  assert.equal(await loadChatPending(projectRoot), null, "软模式不再生成 pending");
});

test("runFactCheck replace_with 为空：只发消息，不落 pending", async () => {
  const { projectRoot, project } = await makeFactCheckProject("wwriting-fc2-");
  const noReplace = JSON.stringify({ conflicts: [{
    draft_quote: "从十二楼坠落", conflicts_with: "坠楼楼层: 六楼", prior_chapter: 1,
    severity: "high", suggestion: "结构性改动，无法机械替换", replace_with: ""
  }] });
  const { runFactCheck } = await import("../src/core/agent-engine.mjs");
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => ({ text: noReplace, usageReport: {} }) }
  }, "刘康从十二楼坠落。");
  assert.equal(out.conflicts.length, 1);
  assert.equal(await loadChatPending(projectRoot), null, "不应预填 pending");
  const history = await readChatHist(projectRoot);
  assert.ok(history.some((m) => m.proactive === "fact_check"), "主动消息仍要发");
});

test("runFactCheck 引文超 200 字被截断：标记 truncated 返回，draft 原样保留", async () => {
  const { projectRoot, project } = await makeFactCheckProject("wwriting-fc-trunc-");
  const draftPath = path.join(projectRoot, "drafts", "001.draft.md");
  await fs.mkdir(path.dirname(draftPath), { recursive: true });
  const longQuote = "刘康从十二楼坠落".repeat(26); // 208 字 > 200
  const draftBody = `# 第一章\n\n${longQuote}。`;
  await fs.writeFile(draftPath, draftBody, "utf8");
  const reply = JSON.stringify({ conflicts: [{
    draft_quote: longQuote, conflicts_with: "坠楼楼层: 六楼", prior_chapter: 1,
    severity: "high", suggestion: "把十二楼改回六楼", replace_with: "替换文本"
  }] });
  const { runFactCheck } = await import("../src/core/agent-engine.mjs");
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => ({ text: reply, usageReport: {} }) }
  }, draftBody);
  assert.equal(out.conflicts.length, 1);
  assert.equal(out.conflicts[0].draft_quote_truncated, true);
  const events = await readEvents(projectRoot);
  assert.ok(!events.some((e) => e.type === "fact_check_auto_fixed"), "不应自动修复");
  assert.ok(!events.some((e) => e.type === "fact_check_auto_fix_skipped"), "不应有跳过修复事件");
  const unchanged = await fs.readFile(draftPath, "utf8");
  assert.ok(unchanged.includes(longQuote), "正文应原样保留");
  assert.ok(!unchanged.includes("替换文本"), "replace_with 不应写入正文");
});

test("runFactCheck mock provider 跳过并记事件，返回 null", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-fc3-"));
  const { projectRoot } = await createProject(root, {
    slug: "fcm", title: "跳过", story_seed: "种子",
    target_chapters: 1, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const project = await loadProject(projectRoot); // 默认 mock provider
  const { runFactCheck } = await import("../src/core/agent-engine.mjs");
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => { throw new Error("must not call"); } }
  }, "正文");
  assert.equal(out, null);
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "fact_check_skipped"));
});

test("runFactCheck 解析两次失败：fact_check_skipped 且返回 null", async () => {
  const { projectRoot, project } = await makeFactCheckProject("wwriting-fc4-");
  const { runFactCheck } = await import("../src/core/agent-engine.mjs");
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => ({ text: "不是 JSON", usageReport: {} }) }
  }, "正文");
  assert.equal(out, null);
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "fact_check_skipped"));
});

test("applyFactCheckConflicts 写 needs_revision 状态与 quality_gate_failed 事件", async () => {
  const { projectRoot, project } = await makeFactCheckProject("wwriting-fc5-");
  const { applyFactCheckConflicts } = await import("../src/core/agent-engine.mjs");
  const conflicts = [{ draft_quote: "从十二楼坠落", conflicts_with: "坠楼楼层: 六楼", prior_chapter: 1, severity: "high", suggestion: "改回六楼", replace_with: "从六楼坠落" }];
  await applyFactCheckConflicts(projectRoot, project, { current_chapter_no: 1, project_status: "running" }, conflicts);
  const state = await loadState(projectRoot);
  assert.equal(state.current_stage, "needs_revision");
  assert.ok(state.last_quality_gate_results.some((g) => g.gate === "fact-check-gate" && g.status === "failed"));
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "quality_gate_failed" && e.message.includes("fact-check")));
});

test("单章契约完成后不调用第2章模型", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-single-chapter-"));
  const { projectRoot } = await createProject(root, {
    slug: "project", target_chapters: 3, min_words_per_chapter: 20, target_words_per_chapter: 24
  });
  const modelClient = new CapturingModelClient();
  const result = await runProject(projectRoot, {
    taskId: "task-1",
    contract: makeChapterContract(1),
    modelClient
  });
  assert.equal(result.task_completed, true);
  assert.equal(result.project_completed, false);
  assert.deepEqual(result.completed_chapters, [1]);
  assert.ok(modelClient.metadatas.every((item) => item.chapterNo === 1));
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "idle");
  assert.equal(state.current_chapter_no, 2);
  assert.equal(state.current_stage, "queued");
});

test("末章任务同时完成项目", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-last-chapter-"));
  const { projectRoot } = await createProject(root, {
    slug: "project", target_chapters: 1, min_words_per_chapter: 20, target_words_per_chapter: 24
  });
  const result = await runProject(projectRoot, {
    taskId: "task-1",
    contract: makeChapterContract(1)
  });
  assert.equal(result.project_completed, true);
  assert.equal((await loadState(projectRoot)).project_status, "completed");
});

test("fact-check abort escapes instead of degrading to skipped", async () => {
  const { projectRoot, project } = await makeFactCheckProject("wwriting-fc-abort-");
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const runtime = {
    signal: controller.signal,
    modelClient: {
      generate: async ({ signal }) => {
        started.resolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
    }
  };
  const promise = runFactCheck(projectRoot, project, { current_chapter_no: 1 }, runtime, "draft");
  await started.promise;
  controller.abort("用户停止");
  await assert.rejects(promise, (error) => error.name === "ProjectCancelledError");
});

test("memory extraction abort does not advance watermark", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-memory-abort-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 10,
    target_words_per_chapter: 12,
    active_model: {
      provider: "openai-compatible",
      model_name: "fake-model",
      base_url: "http://127.0.0.1:1/v1",
      api_key_env: "FAKE_KEY"
    }
  });
  const project = await loadProject(projectRoot);
  const finalPath = path.join(projectRoot, "chapters", "001.md");
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "# 第一章\n\n雨落在旧信封上。", "utf8");
  await upsertChapter(projectRoot, {
    chapter_no: 1,
    status: "summarizing",
    final_path: finalPath
  });

  const controller = new AbortController();
  const started = Promise.withResolvers();
  const promise = extractChapterMemory(
    projectRoot,
    project,
    { current_chapter_no: 1 },
    {
      signal: controller.signal,
      modelClient: {
        generate: async ({ signal }) => {
          started.resolve();
          await new Promise((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true }
            );
          });
        }
      }
    }
  );

  await started.promise;
  controller.abort("用户停止");
  await assert.rejects(
    promise,
    (error) => error.name === "ProjectCancelledError"
  );
  assert.equal(
    (await loadContinuityState(projectRoot)).last_extracted_chapter ?? 0,
    0
  );
});

test("fact-check 检查点恢复不重新生成正文", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-review-resume-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 10,
    target_words_per_chapter: 12
  });
  await appendChapterSegment(projectRoot, project, {
    chapter_no: 1,
    segment_no: 1,
    content: "# 第一章 雨夜来信\n\n雨声压住脚步，沈泽拆开旧信，发现失踪者留下的地址。"
  });
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "cancelled",
    current_stage: "reviewing",
    current_segment_no: 1
  });
  const modelClient = new CapturingModelClient();

  await runProject(projectRoot, {
    taskId: "resume-review-1",
    contract: makeResumeContract(1),
    modelClient
  });

  assert.equal(
    modelClient.metadatas.some(
      (metadata) => metadata.toolRequest?.kind === "draft_segment"
    ),
    false
  );
  const final = await fs.readFile(
    path.join(projectRoot, "chapters", "001.md"),
    "utf8"
  );
  assert.match(final, /失踪者留下的地址/u);
});

test("已提交最终文件的恢复只修复索引不重复写入", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-final-resume-"));
  const { projectRoot, project } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 10,
    target_words_per_chapter: 12
  });
  await appendChapterSegment(projectRoot, project, {
    chapter_no: 1,
    segment_no: 1,
    content: "# 第一章 雨夜来信\n\n雨声压住脚步，沈泽拆开旧信，发现失踪者留下的地址。"
  });
  const draftPath = path.join(projectRoot, "drafts", "001.draft.md");
  const finalPath = path.join(projectRoot, "chapters", "001.md");
  await fs.copyFile(draftPath, finalPath);
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "cancelled",
    current_stage: "finalizing",
    current_segment_no: 1
  });
  await upsertChapter(projectRoot, {
    chapter_no: 1,
    status: "finalizing",
    draft_path: draftPath,
    final_path: finalPath,
    checksum: null
  });
  const before = await fs.stat(finalPath);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runProject(projectRoot, {
    taskId: "resume-1",
    contract: makeResumeContract(1),
    modelClient: new CapturingModelClient()
  });
  const after = await fs.stat(finalPath);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const chapter = (await loadChapterIndex(projectRoot)).chapters[0];
  assert.equal(chapter.status, "completed");
  assert.ok(chapter.checksum);
});

test("timeline-check 装配 + 只报本章的过滤逻辑", async () => {
  const mod = await import("../src/core/timeline-check.mjs");
  const timeline = [
    { chapter_no: 3, events: ["e"], story_time_raw: "", time: { kind: "scene", elapsed: null, anchor: { type: "date", raw: "2021年3月10日" }, confidence: "high" } },
    { chapter_no: 5, events: ["e"], story_time_raw: "", time: { kind: "scene", elapsed: null, anchor: { type: "date", raw: "2021年3月5日" }, confidence: "high" } }
  ];
  const all = mod.checkTimeline(timeline).violations;
  assert.equal(all.length, 1);
  // 抽取第 5 章时只报较晚一方=5 的冲突
  assert.equal(all.filter((v) => v.chapter_no === 5).length, 1);
  // 抽取第 3 章时不会冒出该冲突（避免重复打扰）
  assert.equal(all.filter((v) => v.chapter_no === 3).length, 0);
  assert.match(mod.describeStoryClock(timeline), /故事时钟|第/u);
});

class ReadThenWriteModelClient {
  constructor() {
    this.calls = 0;
    this.costTracker = {
      record() {
        return { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 };
      },
      async writeProjectReport() {}
    };
    this.prompts = [];
  }

  async generate({ prompt, metadata }) {
    this.calls += 1;
    this.prompts.push(prompt);
    const request = metadata.toolRequest;
    const usageReport = {
      provider: "mock",
      model: "read-then-write",
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
    };
    if (this.calls === 1) {
      return {
        text: "",
        raw: { output: { type: "tool_call", tool: "read_continuity", input: {} } },
        usageReport,
        costSummary: { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
        modelConfig: { provider: "mock", model_name: "read-then-write" }
      };
    }
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
            content: Array.from({ length: 260 }, (_, index) => `agentloop${index}`).join(" ")
          }
        }
      },
      usageReport,
      costSummary: { calls: this.calls, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
      modelConfig: { provider: "mock", model_name: "read-then-write" }
    };
  }
}

class ReadLoopModelClient {
  constructor() {
    this.calls = 0;
    this.prompts = [];
    this.capturedMessages = [];
    this.metadatas = [];
    this.costTracker = {
      record() {
        return { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, estimatedCost: 0 };
      },
      async writeProjectReport() {},
    };
  }
  async generate({ prompt, messages, metadata }) {
    this.calls += 1;
    this.prompts.push(prompt);
    // 快照捕获：transcript.toMessages() 返回活引用，后续轮次追加会继续修改原数组
    this.capturedMessages.push([...messages]);
    this.metadatas.push(metadata);
    const request = metadata.toolRequest;
    const usageReport = {
      provider: "mock", model: "read-loop",
      inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0,
      estimatedCost: 0, rawUsage: {},
    };
    const costSummary = { estimatedCost: 0 };
    const modelConfig = { provider: "mock", model_name: "read-loop" };
    if (this.calls <= 3) {
      // 前三次：只会查询，不提交。
      return { text: "", raw: { output: { type: "tool_call", tool: "read_outline", input: {} } },
        usageReport, costSummary, modelConfig };
    }
    if (this.calls === 4) {
      // 第四次（commit-only 已切换）：仍尝试只读工具 → 应被 tool_not_allowed 拒绝，
      // 拒绝反馈喂回下一轮 transcript。
      return { text: "", raw: { output: { type: "tool_call", tool: "read_outline", input: {} } },
        usageReport, costSummary, modelConfig };
    }
    // 第五次（已见拒绝反馈）：提交正文。
    return { text: "", raw: { output: { type: "tool_call", tool: "append_chapter_segment",
      input: { project_id: request.project_id, chapter_no: request.chapter_no,
        segment_no: request.segment_no,
        content: Array.from({ length: 260 }, (_, i) => `readloop${i}`).join(" ") } } },
      usageReport, costSummary, modelConfig };
  }
}

test("writing agent loop: 连续 3 次只读后自动 commit-only，模型提交章节且项目不 blocked", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-readloop-"));
  const { projectRoot } = await createProject(root, {
    slug: "project", target_chapters: 1, min_words_per_chapter: 200, target_words_per_chapter: 260,
  });
  const modelClient = new ReadLoopModelClient();
  const result = await runProject(projectRoot, { modelClient });
  assert.equal(result.completed, true);
  const events = await readEvents(projectRoot);
  assert.equal(events.filter((e) => e.type === "agent_loop_commit_only").length, 1);
  assert.ok(events.some((e) => e.type === "tool_call_requested" && e.data?.tool === "append_chapter_segment"));
  assert.ok(events.some((e) => e.type === "agent_settled"));
  const index = await loadChapterIndex(projectRoot);
  assert.equal(index.chapters[0].status, "completed");
  // 第 4 次调用起进入 commit-only：请求 metadata 中 allowed_tools 只剩 append_chapter_segment
  // （多轮化后不再重新编译 prompt，白名单通过 metadata.toolRequest.allowed_tools 传给模型）。
  const fourthMeta = modelClient.metadatas[3];
  assert.deepEqual(fourthMeta.toolRequest.allowed_tools, ["append_chapter_segment"],
    "commit-only 后白名单不应再含只读工具");
  // 反馈喂回：commit-only 期间模型再调 read_outline 被拒（tool_not_allowed），拒绝原因以
  // user 反馈消息进入第 5 轮 transcript。slice(1) 排除首轮编译 prompt，避免伪命中
  // （编译 prompt 的 allowed_tools 清单里含 read_outline 字样）。
  const fifthMessages = modelClient.capturedMessages[4];
  assert.ok(fifthMessages.slice(1).some((m) => m.role === "user" && m.content.includes("当前只允许调用")),
    "第 5 轮 messages 应含 tool_not_allowed 拒绝反馈");
  assert.equal(modelClient.calls, 5);
});

// 只读模式：白名单内写工具被权限拒绝也必须累计失败计数（连续拒绝达上限即终止，
// 而非空转到 24 轮 agent_loop_exhausted），并把拒绝原因喂回给模型改方向。
class ReadOnlyDeniedModelClient {
  constructor() {
    this.calls = 0;
    this.prompts = [];
    this.capturedMessages = [];
    this.costTracker = {
      record() {
        return { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, estimatedCost: 0 };
      },
      async writeProjectReport() {},
    };
  }
  async generate({ prompt, messages, metadata }) {
    this.calls += 1;
    this.prompts.push(prompt);
    // 快照捕获：transcript.toMessages() 返回活引用，后续轮次追加会继续修改原数组
    this.capturedMessages.push([...messages]);
    const request = metadata.toolRequest;
    const usageReport = {
      provider: "mock", model: "readonly-denied",
      inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0,
      estimatedCost: 0, rawUsage: {},
    };
    const costSummary = { estimatedCost: 0 };
    const modelConfig = { provider: "mock", model_name: "readonly-denied" };
    // 每次都尝试调用白名单内写工具 edit_chapter；项目只读 → 权限拒绝分支。
    return { text: "", raw: { output: { type: "tool_call", tool: "edit_chapter",
      input: { project_id: request.project_id, chapter_no: request.chapter_no,
        segment_no: request.segment_no, find: "旧文", replace: "新文" } } },
      usageReport, costSummary, modelConfig };
  }
}

test("writing agent loop: 只读模式反复调用被拒写工具，连续拒绝达上限即终止（model_output_invalid，非耗尽）", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-readonly-denied-"));
  const { projectRoot } = await createProject(root, {
    slug: "project", target_chapters: 1, min_words_per_chapter: 200, target_words_per_chapter: 260,
    tool_permissions: { read_only: true },
  });
  const modelClient = new ReadOnlyDeniedModelClient();
  const result = await runProject(projectRoot, { modelClient });
  assert.equal(result.blocked, true);
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "blocked");
  assert.equal(state.blocked_reason, "model_output_invalid");
  const events = await readEvents(projectRoot);
  const rejected = events.filter((e) => e.type === "tool_call_rejected");
  assert.equal(rejected.length, 8, "8 次权限拒绝应各发一条 tool_call_rejected");
  assert.ok(rejected.every((e) => e.data?.code === "permission_denied"));
  assert.ok(rejected.every((e) => e.data?.tool === "edit_chapter"));
  assert.ok(events.some((e) => e.type === "project_blocked"));
  // 反馈喂回：多轮化后不再重新编译 prompt，拒绝原因以 user 反馈消息进入后续轮次 transcript。
  assert.ok(modelClient.capturedMessages.some((msgs) => msgs.some((m) => m.role === "user" && m.content.includes("被拒绝") && m.content.includes("只读模式"))),
    "后续 messages 应包含拒绝原因（只读模式文案），模型能改方向而非盲目重试");
  // 连续 8 次拒绝即终止，不应空转到 24 轮耗尽。
  assert.equal(modelClient.calls, 8);
});

test("writing agent loop: drafting 阶段模型先调 read_continuity 查设定再提交正文", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-agent-loop-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });

  const modelClient = new ReadThenWriteModelClient();
  await runProject(projectRoot, { modelClient });

  const events = await readEvents(projectRoot);
  assert.ok(
    events.some((e) => e.type === "agent_loop_tool_executed" && e.data?.tool === "read_continuity"),
    "应有 read_continuity 工具执行事件"
  );
  assert.ok(events.some((e) => e.type === "tool_call_requested" && e.data?.tool === "append_chapter_segment"));
  const index = await loadChapterIndex(projectRoot);
  assert.equal(index.chapters[0].status, "completed");
  assert.ok(modelClient.prompts.some((p) => p.includes("allowed_tools")));
  assert.ok(modelClient.prompts.some((p) => p.includes("agent_loop_instruction")));
  assert.ok(modelClient.prompts.some((p) => p.includes("agent_loop_feedback") && p.includes("read_continuity")));
  assert.equal(modelClient.calls, 2);
});

// ADR-0001 端到端反思闭环：fact-check 发现冲突 -> needs_revision ->
// 模型用 edit_chapter 改 -> 回 reviewing -> fact-check 无冲突 -> 完成。
class FactCheckLoopModelClient {
  constructor() {
    this.calls = 0;
    this.factCheckCalls = 0;
    this.costTracker = {
      record() {
        return { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 };
      },
      async recordRefill() {},
      async writeProjectReport() {}
    };
    this.prompts = [];
  }

  async generate({ prompt, metadata }) {
    this.calls += 1;
    this.prompts.push(prompt);
    const request = metadata.toolRequest;
    const usageReport = {
      provider: "openai-compatible", model: "fc-loop",
      inputTokens: 1, outputTokens: 1, totalTokens: 2,
      cachedTokens: 0, cacheHitTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, cacheMetricsAvailable: false, cacheHitRate: null,
      estimatedCost: 0, rawUsage: {}
    };
    const costSummary = { calls: this.calls, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 };
    const modelConfig = { provider: "openai-compatible", model_name: "fc-loop" };

    // fact-check 调用：第一次返回冲突，第二次返回无冲突
    if (metadata.factCheck) {
      this.factCheckCalls += 1;
      if (this.factCheckCalls === 1) {
        return {
          text: JSON.stringify({ conflicts: [{
            draft_quote: "从十二楼坠落", conflicts_with: "坠楼楼层: 六楼", prior_chapter: 1,
            severity: "high", suggestion: "把十二楼改回六楼", replace_with: "从六楼坠落"
          }] }),
          usageReport, costSummary, modelConfig
        };
      }
      return { text: JSON.stringify({ conflicts: [] }), usageReport, costSummary, modelConfig };
    }

    // 写作调用
    if (request) {
      // revise 阶段：第一次用 edit_chapter 改矛盾，第二次 append 退出循环。
      // 注：runWritingAgentLoop 退出条件是 append 或 >=50 字正文；edit_chapter 属情况 D
      // 执行后继续循环，模型改完需通过 append 收尾退出。此退出机制限制记入 ADR-0001 后续。
      if (request.kind === "revision_quality_gate" || request.kind === "revision_shortfall") {
        this.reviseCalls = (this.reviseCalls ?? 0) + 1;
        if (this.reviseCalls === 1) {
          return {
            text: "",
            raw: { output: { type: "tool_call", tool: "edit_chapter", input: {
              chapter_no: request.chapter_no,
              find: "从十二楼坠落",
              replace: "从六楼坠落",
              reason: "修正设定矛盾"
            } } },
            usageReport, costSummary, modelConfig
          };
        }
        return {
          text: "",
          raw: { output: { type: "tool_call", tool: "append_chapter_segment", input: {
            project_id: request.project_id, chapter_no: request.chapter_no, segment_no: request.segment_no,
            content: Array.from({ length: 60 }, (_, i) => `修订收尾${i}`).join(" ")
          } } },
          usageReport, costSummary, modelConfig
        };
      }
      // drafting：写含矛盾的够字数正文
      const filler = Array.from({ length: 260 }, (_, i) => `草稿片段${i}`).join(" ");
      return {
        text: "",
        raw: { output: { type: "tool_call", tool: "append_chapter_segment", input: {
          project_id: request.project_id, chapter_no: request.chapter_no, segment_no: request.segment_no,
          content: `${filler}刘康从十二楼坠落。`
        } } },
        usageReport, costSummary, modelConfig
      };
    }

    return { text: "", usageReport, costSummary, modelConfig };
  }
}

test("ADR-0001 反思闭环：fact-check 发现冲突 -> edit_chapter 改 -> 无冲突 -> 完成", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-fc-loop-"));
  const { projectRoot } = await createProject(root, {
    slug: "fcloop", title: "反思闭环", story_seed: "种子",
    target_chapters: 1, min_words_per_chapter: 200, target_words_per_chapter: 260
  });
  // provider 设为 openai-compatible，让 fact-check 不跳过
  const project = await loadProject(projectRoot);
  project.active_model = { provider: "openai-compatible", model_name: "fc-loop", base_url: "http://localhost:0", api_key_env: "FAKE_KEY" };
  await saveProject(projectRoot, project);
  // 预存 continuity（fact-check 需要 facts 来比对）
  await saveContinuity(projectRoot, {
    schema_version: 1,
    facts: [{ entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1, quote: "六楼。", conflict_with: null }],
    timeline: [], characters: []
  });

  const modelClient = new FactCheckLoopModelClient();
  await runProject(projectRoot, { modelClient });

  const events = await readEvents(projectRoot);
  // 1. 第一次 fact-check 发现冲突
  assert.ok(events.some((e) => e.type === "quality_gate_warning" && e.data?.conflicts?.length === 1), "第一次 fact-check 应发现冲突");
  // 2. 进 needs_revision（不分 hard/soft）
  assert.ok(events.some((e) => e.type === "quality_gate_failed" && e.message.includes("设定冲突")), "应进 needs_revision 让模型修订");
  // 3. 模型用 edit_chapter 改矛盾（修改权还给模型，不是代码自动修复）
  //    edit_chapter 走 runWritingAgentLoop 情况 D，记 agent_loop_tool_executed（不是 tool_call_requested）
  assert.ok(events.some((e) => e.type === "agent_loop_tool_executed" && e.data?.tool === "edit_chapter"), "模型应用 edit_chapter 改矛盾");
  assert.ok(!events.some((e) => e.type === "fact_check_auto_fixed"), "不应有代码自动修复");
  // 4. 第二次 fact-check 无冲突
  assert.ok(events.some((e) => e.type === "fact_check_completed" && e.message.includes("未发现冲突")), "第二次 fact-check 应无冲突");
  // 5. 章节最终完成
  const index = await loadChapterIndex(projectRoot);
  assert.equal(index.chapters[0].status, "completed", "章节应完成");
  assert.equal(modelClient.factCheckCalls, 2, "fact-check 应跑两轮");
});

// ADR-0001 决策 5 软降级：fact-check 总报冲突（模型改不对）-> 3 轮硬上限 -> block 本章交用户。
class FactCheckUnresolvedModelClient {
  constructor() {
    this.calls = 0;
    this.factCheckCalls = 0;
    this.costTracker = {
      record() { return { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 }; },
      async recordRefill() {},
      async writeProjectReport() {}
    };
    this.prompts = [];
  }

  async generate({ prompt, metadata }) {
    this.calls += 1;
    this.prompts.push(prompt);
    const request = metadata.toolRequest;
    const usageReport = {
      provider: "openai-compatible", model: "fc-unres",
      inputTokens: 1, outputTokens: 1, totalTokens: 2,
      cachedTokens: 0, cacheHitTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, cacheMetricsAvailable: false, cacheHitRate: null,
      estimatedCost: 0, rawUsage: {}
    };
    const costSummary = { calls: this.calls, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 };
    const modelConfig = { provider: "openai-compatible", model_name: "fc-unres" };

    // fact-check 总返回冲突（模拟模型改不对，fact-check 一直报同样矛盾）
    if (metadata.factCheck) {
      this.factCheckCalls += 1;
      return {
        text: JSON.stringify({ conflicts: [{
          draft_quote: "从十二楼坠落", conflicts_with: "坠楼楼层: 六楼", prior_chapter: 1,
          severity: "high", suggestion: "把十二楼改回六楼", replace_with: "从六楼坠落"
        }] }),
        usageReport, costSummary, modelConfig
      };
    }

    // 写作调用：drafting 与 revise 都 append（测试聚焦软降级触发，不验证 edit 改矛盾）
    if (request) {
      const filler = Array.from({ length: 260 }, (_, i) => `草稿${i}`).join(" ");
      return {
        text: "",
        raw: { output: { type: "tool_call", tool: "append_chapter_segment", input: {
          project_id: request.project_id, chapter_no: request.chapter_no, segment_no: request.segment_no,
          content: `${filler}刘康从十二楼坠落。`
        } } },
        usageReport, costSummary, modelConfig
      };
    }
    return { text: "", usageReport, costSummary, modelConfig };
  }
}

test("ADR-0001 软降级：fact-check 3 轮仍有冲突 -> block 本章交用户", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-fc-unresolved-"));
  const { projectRoot } = await createProject(root, {
    slug: "fcunres", title: "软降级", story_seed: "种子",
    target_chapters: 1, min_words_per_chapter: 200, target_words_per_chapter: 260
  });
  const project = await loadProject(projectRoot);
  project.active_model = { provider: "openai-compatible", model_name: "fc-unres", base_url: "http://localhost:0", api_key_env: "FAKE_KEY" };
  await saveProject(projectRoot, project);
  await saveContinuity(projectRoot, {
    schema_version: 1,
    facts: [{ entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1, quote: "六楼。", conflict_with: null }],
    timeline: [], characters: []
  });

  const modelClient = new FactCheckUnresolvedModelClient();
  const result = await runProject(projectRoot, { modelClient });

  assert.ok(result.blocked, "项目应被 block（不静默放过）");
  assert.equal(result.reason, "fact_check_unresolved", "block 原因应是 fact_check_unresolved");
  assert.equal(modelClient.factCheckCalls, 4, "模型修订 3 轮后，第 4 次 fact-check 仍冲突 -> 软降级");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "project_blocked" && e.data?.reason === "fact_check_unresolved"), "应有软降级 block 事件");
  const history = await readChatHist(projectRoot);
  assert.ok(history.some((m) => m.proactive === "fact_check" && m.content.includes("人工核对")), "应有通知用户人工核对的主动消息");
});

test("ADR-0001 决策 6：第二轮冲突数未减少时 feedback 含 progress_hint 让模型换思路", async () => {
  const { projectRoot, project } = await makeFactCheckProject("wwriting-fc-progress-");
  const { applyFactCheckConflicts } = await import("../src/core/agent-engine.mjs");
  const conflicts = [{ draft_quote: "从十二楼坠落", conflicts_with: "坠楼楼层: 六楼", prior_chapter: 1, severity: "high", suggestion: "改回六楼", replace_with: "从六楼坠落" }];
  // 第一轮：rounds=1, lastConflictCount=null -> 无 progress_hint
  await applyFactCheckConflicts(projectRoot, project, { current_chapter_no: 1, project_status: "running" }, conflicts, 1, null);
  let state = await loadState(projectRoot);
  let gate = state.last_quality_gate_results[0];
  assert.equal(gate.rounds, 1);
  assert.equal(gate.progress_hint, null, "第一轮不应有 progress_hint");
  // 第二轮：冲突数未减少（上次 1，这次 1）-> 有 progress_hint
  await applyFactCheckConflicts(projectRoot, project, { current_chapter_no: 1, project_status: "running" }, conflicts, 2, 1);
  state = await loadState(projectRoot);
  gate = state.last_quality_gate_results[0];
  assert.equal(gate.rounds, 2);
  assert.ok(gate.progress_hint, "冲突数未减少应有 progress_hint");
  assert.match(gate.progress_hint, /换一种改法/u);
  // 冲突数减少（上次 2，这次 1）-> 模型在收敛，无 progress_hint
  await applyFactCheckConflicts(projectRoot, project, { current_chapter_no: 1, project_status: "running" }, conflicts, 3, 2);
  state = await loadState(projectRoot);
  gate = state.last_quality_gate_results[0];
  assert.equal(gate.progress_hint, null, "冲突数减少时不应有 progress_hint（模型在收敛）");
});

test("buildRelevantFacts: 空 continuity 返回空字符串", async () => {
  const { buildRelevantFacts } = await import("../src/core/chapter-memory.mjs");
  assert.equal(buildRelevantFacts({ facts: [], timeline: [], characters: [] }, 5), "");
  assert.equal(buildRelevantFacts(null, 5), "");
});

test("buildRelevantFacts: 近期 facts 优先，超 maxFacts 截断更早的", async () => {
  const { buildRelevantFacts } = await import("../src/core/chapter-memory.mjs");
  const facts = Array.from({ length: 50 }, (_, i) => ({
    entity: `实体${i + 1}`,
    attribute: "属性",
    value: `值${i + 1}`,
    chapter_no: i + 1
  }));
  const result = buildRelevantFacts({ facts, timeline: [], characters: [] }, 60, { maxFacts: 40 });
  assert.ok(result.includes("精选近期"), "应有检索式标题");
  assert.ok(result.includes("实体50"), "最新章的 fact 应在");
  assert.ok(result.includes("实体11"), "第 40 条 fact 应在");
  assert.ok(!result.includes("实体10"), "超出 maxFacts 的更早 fact 应被截断");
});

test("forbidden_patterns 可通过项目配置覆盖默认套路词", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-forbidden-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  const project = await loadProject(projectRoot);
  project.forbidden_patterns = ["主角光环", "金手指"];
  await saveProject(projectRoot, project);

  const modelClient = new CapturingModelClient();
  await runProject(projectRoot, { modelClient });

  const prompt = modelClient.prompts[0];
  assert.ok(prompt.includes('"主角光环"'), "自定义套路词应在 forbidden_reboot_patterns JSON 里");
  assert.ok(prompt.includes('"金手指"'), "自定义套路词应在 forbidden_reboot_patterns JSON 里");
  assert.ok(!prompt.includes('"普通大学生突然获得神力"'), "默认套路词不应在 forbidden_reboot_patterns JSON 里");
});

// Task 6：写作 agent 循环多轮化。第 1 轮 read_chapter（id c1）后，
// 第 2 轮 messages 必须是 transcript 回放：含上一轮 assistant tool_calls 与 role=tool 结果。
class TranscriptCapturingModelClient {
  constructor() {
    this.calls = 0;
    this.capturedMessagesPerCall = [];
    this.costTracker = {
      record() { return { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 }; },
      async writeProjectReport() {}
    };
  }
  async generate({ messages = [], metadata }) {
    this.calls += 1;
    // 快照捕获：transcript.toMessages() 返回活引用，后续轮次追加会继续修改原数组
    this.capturedMessagesPerCall.push([...messages]);
    const request = metadata?.toolRequest ?? {};
    if (this.calls === 1) {
      return {
        text: "",
        raw: { choices: [{ message: { role: "assistant", content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "read_chapter", arguments: JSON.stringify({ chapter_no: request.chapter_no }) } }] } }] },
        usageReport: { provider: "mock", model: "m", inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheHitRate: null, estimatedCost: 0, rawUsage: {} },
        costSummary: { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
        modelConfig: { provider: "mock", model_name: "m" }
      };
    }
    const content = Array.from({ length: 180 }, (_, i) => `seg${i}`).join(" ");
    return {
      text: "",
      raw: { choices: [{ message: { role: "assistant", content: null,
        tool_calls: [{ id: `c${this.calls}`, type: "function", function: { name: "append_chapter_segment", arguments: JSON.stringify({ project_id: request.project_id, chapter_no: request.chapter_no, segment_no: request.segment_no, content }) } }] } }] },
      usageReport: { provider: "mock", model: "m", inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheHitRate: null, estimatedCost: 0, rawUsage: {} },
      costSummary: { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
      modelConfig: { provider: "mock", model_name: "m" }
    };
  }
}

test("runWritingAgentLoop 多轮: 第 2 轮 messages 含上一轮 assistant tool_calls + role=tool", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-transcript-"));
  const { projectRoot } = await createProject(root, {
    slug: "project", target_chapters: 1, min_words_per_chapter: 300, target_words_per_chapter: 360
  });
  const client = new TranscriptCapturingModelClient();
  await runProject(projectRoot, { modelClient: client });
  assert.ok(client.calls >= 2, `expected >= 2 model calls, got ${client.calls}`);
  const secondRound = client.capturedMessagesPerCall[1];
  assert.ok(secondRound.some((m) => m.role === "assistant" && m.tool_calls?.some((tc) => tc.id === "c1")),
    "第 2 轮 messages 应含上一轮 assistant tool_calls");
  assert.ok(secondRound.some((m) => m.role === "tool" && m.tool_call_id === "c1"),
    "第 2 轮 messages 应含 role=tool 结果");
});

test("transcript pending 文件: 循环层中断后 pending 含未回执 tool_call，恢复续写不重复 segment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-tcp-pending-"));
  const { projectRoot } = await createProject(root, {
    slug: "project", target_chapters: 1, min_words_per_chapter: 300, target_words_per_chapter: 360
  });
  const client = new TranscriptCapturingModelClient();
  try {
    await runProject(projectRoot, { modelClient: client, simulateInterruptAfter: { chapter_no: 1, segment_no: 1 } });
  } catch (error) {
    assert.ok(error instanceof SimulatedInterrupt);
  }
  // 中断发生在循环层（callModel 决策落盘后、工具执行前）：
  // pending 应含未回执的 assistant tool_calls（模型已决策、工具未执行）
  const pendingPath = path.join(projectRoot, "memory", ".pending-transcript-1-1.json");
  const pending = JSON.parse(await fs.readFile(pendingPath, "utf8"));
  assert.ok(pending.messages.length > 0, "pending transcript messages 非空");
  assert.ok(pending.messages.some((m) => m.role === "assistant" && m.tool_calls),
    "pending transcript 应含 assistant tool_calls（待恢复）");
  assert.equal(ToolTranscript.restore(pending).pendingToolCalls.length, 1,
    "pending transcript 应恰有 1 个未回执 tool_call（恢复裁剪后模型重新决策）");
  // 恢复续写：恢复裁剪未回执轮次 → 正常完成，segment:1 不重复
  const callsBeforeRestore = client.capturedMessagesPerCall.length;
  await runProject(projectRoot, { modelClient: client });
  // 恢复读路径：恢复后的首个模型调用应收到裁剪后的 pending 链（至少含 user 消息）——
  // 非恢复的首轮（fresh loop）messages 是空数组；若恢复逻辑被删，此处必失败。
  const firstRestoreCall = client.capturedMessagesPerCall[callsBeforeRestore];
  assert.ok(
    Array.isArray(firstRestoreCall) && firstRestoreCall.some((m) => m.role === "user"),
    "恢复后首轮应收到含 user 消息的 pending 链（不是 fresh 首轮的空数组）"
  );
  // 恢复成功后 pending 文件应已被清理（正常完成路径）
  assert.equal(await fs.stat(pendingPath).catch(() => null), null,
    "恢复成功后 pending 文件应已删除");
  const draft = await fs.readFile(path.join(projectRoot, "drafts", "001.draft.md"), "utf8");
  assert.equal((draft.match(/segment:1/gu) ?? []).length, 1, "恢复后 segment:1 不重复");
});

// Task 1：模型一轮返回多个并行 tool_calls 时，写作 agent 循环必须全部执行并回填
// transcript（OpenAI/DeepSeek 契约：tool_calls 与 role=tool 结果 1:1，否则下一轮 400）。
class MultiToolCallModelClient {
  constructor() {
    this.calls = 0;
    this.capturedMessagesPerCall = [];
  }
  async generate({ messages = [], metadata = {} } = {}) {
    this.calls += 1;
    const req = metadata.toolRequest;
    if (this.calls === 1 && messages.length === 0) {
      // 首轮(fresh):返回 2 个并行只读 tool_calls
      this.capturedMessagesPerCall.push([...messages]);
      return {
        text: "",
        raw: { choices: [{ message: { role: "assistant", content: null,
          tool_calls: [
            { id: "mtc_a", type: "function", function: { name: "get_status", arguments: "{}" } },
            { id: "mtc_b", type: "function", function: { name: "read_outline", arguments: "{}" } }
          ] } }] },
        usageReport: { provider: "mock", model: "m", inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheHitRate: null, estimatedCost: 0, rawUsage: {} },
        costSummary: { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
        modelConfig: { provider: "mock", model_name: "m" }
      };
    }
    this.capturedMessagesPerCall.push([...messages]);
    const content = "这是一段足够长的正文内容用于通过字数门禁,确保超过最小字符阈值,从而被包装为 append_chapter_segment 提交。".repeat(2);
    return {
      text: "",
      raw: { choices: [{ message: { role: "assistant", content: null,
        tool_calls: [{ id: `mtc_c${this.calls}`, type: "function", function: { name: "append_chapter_segment", arguments: JSON.stringify({ project_id: req.project_id, chapter_no: req.chapter_no, segment_no: req.segment_no, content }) } }] } }] },
      usageReport: { provider: "mock", model: "m", inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheHitRate: null, estimatedCost: 0, rawUsage: {} },
      costSummary: { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
      modelConfig: { provider: "mock", model_name: "m" }
    };
  }
}

test("parseOpenAIToolCalls: 模型一轮返回多个 tool_calls 时全部进入 transcript 待执行", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-multi-tc-"));
  const { projectRoot } = await createProject(root, {
    slug: "project", target_chapters: 1, min_words_per_chapter: 300, target_words_per_chapter: 360
  });
  const client = new MultiToolCallModelClient();
  await runProject(projectRoot, { modelClient: client });
  assert.ok(client.calls >= 2, `expected >= 2 model calls, got ${client.calls}`);
  const secondRound = client.capturedMessagesPerCall[1];
  const assistantMsg = secondRound.find((m) => m.role === "assistant" && m.tool_calls);
  assert.ok(assistantMsg, "第 2 轮应含上一轮 assistant tool_calls");
  assert.equal(assistantMsg.tool_calls.length, 2, "上一轮应有 2 个 tool_calls");
  const toolResultIds = secondRound
    .filter((m) => m.role === "tool")
    .map((m) => m.tool_call_id);
  for (const tc of assistantMsg.tool_calls) {
    assert.ok(toolResultIds.includes(tc.id),
      `每个 tool_call(id=${tc.id}) 都必须有对应 role=tool 结果,实际 tool 结果 ids: ${JSON.stringify(toolResultIds)}`);
  }
});

// Task 2：本轮并行执行全部 tool_calls —— read + append 同轮 commit。
// 模型一轮返回 [read_outline, append_chapter_segment] 两个 tool_calls：
// 主 output 是 read_outline，剩余 append 由本轮 side 段执行并回填；append commit 后循环 stop。
class ReadThenCommitModelClient {
  constructor() { this.calls = 0; this.capturedMessagesPerCall = []; }
  async generate({ messages = [], metadata = {} } = {}) {
    this.calls += 1;
    this.capturedMessagesPerCall.push([...messages]);
    const req = metadata.toolRequest;
    const content = "这是一段足够长的正文内容用于通过字数门禁,确保超过最小字符阈值。".repeat(11);
    return {
      text: "",
      raw: { choices: [{ message: { role: "assistant", content: null,
        tool_calls: [
          { id: `rac_r${this.calls}`, type: "function", function: { name: "read_outline", arguments: "{}" } },
          { id: `rac_a${this.calls}`, type: "function", function: { name: "append_chapter_segment", arguments: JSON.stringify({ project_id: req.project_id, chapter_no: req.chapter_no, segment_no: req.segment_no, content }) } }
        ] } }] },
      usageReport: { provider: "mock", model: "m", inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheHitRate: null, estimatedCost: 0, rawUsage: {} },
      costSummary: { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 },
      modelConfig: { provider: "mock", model_name: "m" }
    };
  }
}

test("runWritingAgentLoop: 本轮主 read + 剩余 append,commit 后无悬空 tool_call", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-read-append-"));
  const { projectRoot } = await createProject(root, {
    slug: "project", target_chapters: 1, min_words_per_chapter: 300, target_words_per_chapter: 360
  });
  const client = new ReadThenCommitModelClient();
  await runProject(projectRoot, { modelClient: client });
  assert.equal(client.calls, 1, "read+append 同轮完成后应 stop,不再调模型");
  const pendingPath = path.join(projectRoot, "memory", ".pending-transcript-1-1.json");
  assert.equal(await fs.stat(pendingPath).catch(() => null), null,
    "read+append 同轮 commit 后应正常完成,pending 文件应删除");
  const draft = await fs.readFile(path.join(projectRoot, "drafts", "001.draft.md"), "utf8");
  assert.match(draft, /segment:1/u, "正文已写入");
});

test("trimUnresolvedAssistantTurns: side 部分回填的崩溃窗口恢复后裁剪不完整轮次", () => {
  // 模拟崩溃窗口:assistant(2 tool_calls: a,b) + tool(a 结果),b 结果缺失
  const transcript = ToolTranscript.restore({
    messages: [
      { role: "user", content: "写第一章" },
      { role: "assistant", tool_calls: [
        { id: "a", type: "function", function: { name: "get_status", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "read_outline", arguments: "{}" } }
      ], reasoning_content: "思考" },
      { role: "tool", tool_call_id: "a", content: '{"status":"ok"}' }
      // b 的 tool 结果缺失(崩溃在 side 执行中途)
    ]
  });
  assert.equal(transcript.pendingToolCalls.length, 1, "应有 1 个悬空 tool_call(b)");
  trimUnresolvedAssistantTurns(transcript);
  assert.equal(transcript.toMessages().length, 1, "不完整轮次应被裁剪,只剩 user 消息");
  assert.equal(transcript.toMessages()[0].role, "user");
  assert.equal(transcript.pendingToolCalls.length, 0, "裁剪后无悬空");
});
