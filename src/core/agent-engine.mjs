import { appendEvent, readEvents } from "./event-log.mjs";
import { CacheKeyManager, writeCacheReport } from "./cache-key-manager.mjs";
import { loadConfigLayers } from "./config-runtime.mjs";
import { CostTracker } from "./cost-tracker.mjs";
import { buildPricingTable } from "./model-pricing.mjs";
import { readJson, safeJoin, sha256, writeFileAtomic, writeJsonAtomic } from "./fs-utils.mjs";
import { ModelClient } from "./model-client.mjs";
import { loadProject, loadState, loadChapterIndex, saveState, upsertChapter, writeCheckpoint } from "./project-store.mjs";
import { MockModel } from "./mock-model.mjs";
import { MockProviderAdapter, OpenAICompatibleAdapter } from "./provider-adapters.mjs";
import { PromptCompiler, computeChapterWordGap } from "./prompt-compiler.mjs";
import { assertToolCallForChapter, runWordCountGate, runTitleGate, runWordCapGate, buildFactCheckMessages, parseFactCheck } from "./quality-gates.mjs";
import { checkTimeline, summarizeTimelineViolations, describeStoryClock } from "./timeline-check.mjs";
import { collectSkillPromptHooks, loadEnabledSkills, runPostProcessHooks, runSkillChecks } from "./skill-runtime.mjs";
import { ensureDefaultToolHooks, runAfterToolUse, runBeforeToolUse } from "./tool-hooks.mjs";
import { appendChapterSegment, chapterFileName, finalizeChapterFile, readDraft, ToolValidationError } from "./tool-runtime.mjs";
import { buildContinuityPromptContext, buildRelevantFacts, recordChapterMemory } from "./chapter-memory.mjs";
import { loadOutputStyles } from "./output-style-loader.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import { appendFailure } from "./failures-store.mjs";
import { deriveFailureCard } from "./derive-failure-card.mjs";
import { emit, CORE_EVENTS } from "./event-bus.mjs";
import { buildMemoryExtractionMessages, parseMemoryExtraction } from "./memory-extractor.mjs";
import { loadContinuity, mergeExtraction, saveContinuity, loadContinuityState, saveContinuityState, formatChapterRef } from "./continuity-store.mjs";
import { appendChatMessage, loadPendingAction, savePendingAction } from "./chat/chat-store.mjs";
import { createToolRegistry, checkToolPermission } from "./chat/tool-registry.mjs";
import { registerReadTools } from "./chat/tools-read.mjs";
import { previewEditChapter, registerWriteTools } from "./chat/tools-write.mjs";
import { validateTaskContract } from "./task-contract.mjs";
import { ProjectCancelledError, rethrowIfCancelled, throwIfAborted } from "./cancellation.mjs";

export { ProjectCancelledError } from "./cancellation.mjs";

export class SimulatedInterrupt extends Error {
  constructor(message) {
    super(message);
    this.name = "SimulatedInterrupt";
  }
}

export class ProjectBlockedError extends Error {
  constructor(reason) {
    super(`Project blocked: ${reason}`);
    this.name = "ProjectBlockedError";
    this.reason = reason;
  }
}

export async function runProject(projectRoot, options = {}) {
  const loadedProject = await loadProject(projectRoot);
  const configLayers = await loadConfigLayers(projectRoot, loadedProject, options.configLayers ?? {});
  const project = applyEffectiveProjectConfig(loadedProject, configLayers);
  const model = options.model ?? new MockModel();
  const runtime = await createModelRuntime(projectRoot, project, options, model);
  let state = await loadState(projectRoot);
  if (state.project_status === "completed") {
    return { completed: true, projectRoot };
  }
  if (state.project_status === "blocked") {
    return { completed: false, blocked: true, projectRoot, reason: state.blocked_reason };
  }

  const taskId = options.taskId ?? null;
  const contract = options.contract
    ? validateTaskContract(options.contract, {
        currentChapter: state.current_chapter_no,
        targetChapters: project.target_chapters
      })
    : null;
  const execution = { taskId, contract };

  state.project_status = "running";
  if (!state.current_stage || state.current_stage === "idle") {
    setStage(state, "queued");
  }
  await saveState(projectRoot, state);
  await appendEvent(projectRoot, {
    type: "project_started",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: state.current_stage,
    message: "project run started or resumed"
  });

  const runStartedAtMs = Date.now();

  try {
    for (let step = 0; step < (options.maxSteps ?? 500); step += 1) {
      throwIfAborted(options.signal);
      state = await loadState(projectRoot);
      const pauseRequest = await findFreshPauseRequest(projectRoot, runStartedAtMs);
      if (pauseRequest) {
        const paused = { ...state, project_status: "paused", paused_at: new Date().toISOString() };
        await saveState(projectRoot, paused);
        await appendEvent(projectRoot, {
          type: "project_paused",
          severity: "info",
          chapter_no: state.current_chapter_no,
          stage: state.current_stage,
          message: "用户在故障卡选择停在这里",
          data: { source: "failure_resolved", failureId: pauseRequest.data?.failureId }
        });
        return { completed: false, paused: true, projectRoot };
      }
      const nowIso = new Date().toISOString();
      const lastBeatMs = Date.parse(state.last_heartbeat ?? "");
      if (Number.isNaN(lastBeatMs) || Date.now() - lastBeatMs > 1500) {
        state.last_heartbeat = nowIso;
        await saveState(projectRoot, state);
      }
      if (typeof options.onHeartbeat === "function") {
        await options.onHeartbeat({ step, stage: state.current_stage, chapter: state.current_chapter_no });
      }
      if (state.project_status === "blocked") {
        return { completed: false, blocked: true, projectRoot, reason: state.blocked_reason };
      }
      runtime.stepSkills = await loadEnabledSkills(projectRoot, project);

      if (state.current_chapter_no > project.target_chapters) {
        state.project_status = "completed";
        setStage(state, "completed");
        await saveState(projectRoot, state);
        await appendEvent(projectRoot, {
          type: "project_completed",
          project_id: project.project_id,
          message: "project MVP loop completed"
        });
        return { completed: true, projectRoot };
      }

      switch (state.current_stage) {
        case "queued":
          await enterPlanning(projectRoot, project, state, runtime);
          break;
        case "planning":
        case "planned":
          await enterDrafting(projectRoot, project, state);
          break;
        case "drafting":
          await draftNextSegment(projectRoot, project, state, runtime, options);
          break;
        case "reviewing":
          await reviewChapter(projectRoot, project, state, runtime);
          break;
        case "needs_revision":
        case "revising":
          await reviseChapter(projectRoot, project, state, runtime, options);
          break;
        case "finalizing":
          await finalizeChapter(projectRoot, project, state, runtime);
          break;
        case "summarizing": {
          await extractChapterMemory(projectRoot, project, state, runtime);
          const completion = await completeChapter(projectRoot, project, state, execution);
          if (completion.taskCompleted) {
            return {
              outcome: "completed",
              completed: completion.projectCompleted,
              task_completed: true,
              project_completed: completion.projectCompleted,
              completed_chapters: [completion.chapterNo],
              projectRoot
            };
          }
          break;
        }
        default:
          throw new Error(`Unknown stage: ${state.current_stage}`);
      }
    }
    throw new Error("Max steps reached before completion");
  } catch (error) {
    if (error instanceof SimulatedInterrupt) {
      throw error;
    }
    if (error instanceof ProjectBlockedError) {
      const blockedState = await loadState(projectRoot);
      return { completed: false, blocked: true, projectRoot, reason: blockedState.blocked_reason };
    }
    state = await loadState(projectRoot);
    if (error instanceof ProjectCancelledError) {
      state.project_status = "cancelled";
      state.cancelled_reason = error.reason;
      state.cancelled_at = new Date().toISOString();
      await saveState(projectRoot, state);
      await appendEvent(projectRoot, {
        type: "project_cancelled",
        project_id: state.project_id ?? project.project_id,
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        severity: "warn",
        message: error.reason
      });
      throw error;
    }
    if (error.message?.startsWith("No provider adapter configured for ")) {
      state.project_status = "blocked";
      setStage(state, "blocked");
      state.blocked_reason = error.message;
      state.blocked_at = new Date().toISOString();
      await saveState(projectRoot, state);
      await appendEvent(projectRoot, {
        type: "project_blocked",
        project_id: state.project_id ?? project.project_id,
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        severity: "error",
        message: error.message,
        data: { reason: "model_provider_unavailable" }
      });
      await emit(CORE_EVENTS.TaskFailed, {
        projectRoot,
        taskId: state.current_stage,
        error,
        card: {
          type: "model-error",
          chapter_no: state.current_chapter_no,
          message: error.message,
          ts: new Date().toISOString(),
          data: { reason: "model_provider_unavailable" }
        },
        options: { stage: state.current_stage }
      }).catch(() => {});
      throw error;
    }
    state.project_status = "interrupted";
    state.interrupted_reason = error.message;
    state.interrupted_at = new Date().toISOString();
    await saveState(projectRoot, state);
    await appendEvent(projectRoot, {
      type: "project_interrupted",
      project_id: state.project_id ?? project.project_id,
      chapter_no: state.current_chapter_no,
      stage: state.current_stage,
      severity: "error",
      message: error.message
    });
    await emit(CORE_EVENTS.TaskFailed, {
      projectRoot,
      taskId: state.current_stage,
      error,
      card: {
        type: "model-error",
        chapter_no: state.current_chapter_no,
        message: error.message,
        ts: new Date().toISOString(),
        data: { reason: "interrupted" }
      },
      options: { stage: state.current_stage }
    }).catch(() => {});
    throw error;
  }
}

const PAUSE_COMMANDS = new Set(["pause-here", "manual-review-handoff"]);

async function findFreshPauseRequest(projectRoot, sinceMs) {
  // 一个 drafting/revise 步骤会产生 6-7 条事件，limit 太小会把 pause 事件挤出窗口而漏掉。
  const recentEvents = await readEvents(projectRoot, { limit: 30 });
  return (
    recentEvents.find(
      (event) =>
        event.type === "failure_resolved" &&
        PAUSE_COMMANDS.has(event.message) &&
        Date.parse(event.timestamp ?? "") >= sinceMs
    ) ?? null
  );
}

function applyEffectiveProjectConfig(project, configLayers) {
  const effective = configLayers.effective;
  return {
    ...project,
    effective_config: effective,
    config_layers: configLayers.layers,
    active_model: effective.active_model,
    stage_overrides: effective.stage_overrides,
    tool_permissions: effective.tool_permissions,
    enabled_skills: effective.enabled_skills ?? project.enabled_skills ?? []
  };
}

async function enterPlanning(projectRoot, project, state, runtime) {
  const stateBefore = { ...state };
  setStage(state, "planning");
  await saveState(projectRoot, state);
  const skillPrompts = await collectSkillPromptHooks(projectRoot, project, "planning", {
    chapter_no: state.current_chapter_no,
    stage: "planning",
    skills: runtime.stepSkills
  });
  if (skillPrompts.content) {
    await writeFileAtomic(
      safeJoin(projectRoot, "drafts", `${String(state.current_chapter_no).padStart(3, "0")}.planning.md`),
      `# Chapter ${String(state.current_chapter_no).padStart(3, "0")} Planning Hooks\n\n${skillPrompts.content}\n`
    );
    await appendEvent(projectRoot, {
      type: "skill_hook_applied",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: "planning",
      message: "planning skill prompt hooks applied",
      data: { hooks: skillPrompts.hooks }
    });
  }
  await upsertChapter(projectRoot, {
    chapter_no: state.current_chapter_no,
    status: "planning"
  });
  await appendEvent(projectRoot, {
    type: "stage_started",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: "planning",
    message: "chapter planning started"
  });
  setStage(state, "planned");
  await saveState(projectRoot, state);
  await writeCheckpoint(projectRoot, checkpointPayload(project, stateBefore, state, [], [], null, { skill_hooks: skillPrompts.hooks }));
}

async function enterDrafting(projectRoot, project, state) {
  const stateBefore = { ...state };
  setStage(state, "drafting");
  await saveState(projectRoot, state);
  await upsertChapter(projectRoot, {
    chapter_no: state.current_chapter_no,
    status: "drafting"
  });
  await writeCheckpoint(projectRoot, checkpointPayload(project, stateBefore, state));
}

async function draftNextSegment(projectRoot, project, state, runtime, options) {
  const draft = await readDraft(projectRoot, project, state.current_chapter_no);
  const gate = runWordCountGate(draft, project.min_words_per_chapter);
  if (gate.status === "passed") {
    const next = setStage({ ...state }, "reviewing");
    await saveState(projectRoot, next);
    await writeCheckpoint(projectRoot, checkpointPayload(project, state, next));
    return;
  }

  const segmentNo = state.current_segment_no + 1;
  const response = await runWritingAgentLoop(projectRoot, project, state, runtime, {
    kind: "draft_segment",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    segment_no: segmentNo,
    segment_target_words: Math.max(900, Math.ceil(project.target_words_per_chapter / 3)),
    signal: options.signal,
    allowed_tools: DRAFTING_ALLOWED_TOOLS
  });
  const latestState = await loadState(projectRoot);
  const next = setStage({ ...latestState, current_segment_no: segmentNo }, "drafting");
  await saveState(projectRoot, next);
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next, [response.toolCall], [response.result], null, checkpointModelExtras(response.modelCall)));

  if (
    options.simulateInterruptAfter &&
    options.simulateInterruptAfter.chapter_no === state.current_chapter_no &&
    options.simulateInterruptAfter.segment_no === segmentNo
  ) {
    await appendEvent(projectRoot, {
      type: "project_paused",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: "drafting",
      severity: "warn",
      message: "simulated interruption triggered"
    });
    throw new SimulatedInterrupt("Simulated interruption after checkpoint");
  }
}

async function reviewChapter(projectRoot, project, state, runtime) {
  const draft = await readDraft(projectRoot, project, state.current_chapter_no);
  const gate = runWordCountGate(draft, project.min_words_per_chapter);
  if (gate.status === "failed") {
    const next = setStage({ ...state, last_quality_gate_results: [gate] }, "needs_revision");
    await saveState(projectRoot, next);
    await upsertChapter(projectRoot, {
      chapter_no: state.current_chapter_no,
      status: "needs_revision",
      actual_words: gate.actual_words,
      quality_gate_results: [gate]
    });
    await appendEvent(projectRoot, {
      type: "quality_gate_failed",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: "reviewing",
      severity: "warn",
      message: "word-count gate failed",
      data: gate
    });
    await writeCheckpoint(projectRoot, checkpointPayload(project, state, next));
    await appendFailureCard(projectRoot, state, { type: 'quality_gate_failed', message: 'word-count gate failed', data: gate });
    return;
  }
  // S3 本地门禁：标题一致性（hard；错位串章直接打回修订）
  const titleGate = runTitleGate(draft, state.current_chapter_no);
  // S3 本地门禁：字数上限（soft；只记 warning + 写成本估算）
  const wordCapGate = runWordCapGate(gate.actual_words, {
    targetWords: project.target_words_per_chapter,
    maxWords: project.max_words_per_chapter,
    outputPricePerMillion: project.active_model?.pricing?.output_per_million ?? null
  });
  if (titleGate.status === "failed") {
    const qualityResults = [gate, titleGate, wordCapGate];
    const next = setStage({ ...state, last_quality_gate_results: qualityResults }, "needs_revision");
    await saveState(projectRoot, next);
    await upsertChapter(projectRoot, {
      chapter_no: state.current_chapter_no,
      status: "needs_revision",
      actual_words: gate.actual_words,
      quality_gate_results: qualityResults
    });
    await appendEvent(projectRoot, {
      type: "quality_gate_failed",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: "reviewing",
      severity: "warn",
      message: "chapter-title gate failed",
      data: titleGate
    });
    await writeCheckpoint(projectRoot, checkpointPayload(project, state, next));
    await appendFailureCard(projectRoot, state, { type: 'quality_gate_failed', message: 'chapter-title gate failed', data: titleGate });
    return;
  }
  if (wordCapGate.status === "warning") {
    await appendEvent(projectRoot, {
      type: "quality_gate_warning",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: "reviewing",
      severity: "warn",
      message: `第 ${state.current_chapter_no} 章超出字数上限（${wordCapGate.actual_words}/${wordCapGate.max_words}）`,
      data: wordCapGate
    });
  }
  const skillGateResults = await runSkillChecks(projectRoot, project, "reviewing", {
    chapter_no: state.current_chapter_no,
    stage: "reviewing",
    content: draft,
    skills: runtime.stepSkills
  });
  const failedSkillGates = skillGateResults.filter((result) => result.status === "failed");
  if (failedSkillGates.length > 0) {
    const qualityResults = [gate, titleGate, wordCapGate, ...skillGateResults];
    const next = setStage({ ...state, last_quality_gate_results: qualityResults }, "needs_revision");
    await saveState(projectRoot, next);
    await upsertChapter(projectRoot, {
      chapter_no: state.current_chapter_no,
      status: "needs_revision",
      actual_words: gate.actual_words,
      quality_gate_results: qualityResults
    });
    await appendEvent(projectRoot, {
      type: "quality_gate_failed",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: "reviewing",
      severity: "warn",
      message: "skill quality gate failed",
      data: { failed_gates: failedSkillGates }
    });
    await writeCheckpoint(projectRoot, checkpointPayload(project, state, next, [], [], null, { skill_gate_results: skillGateResults }));
    await appendFailureCard(projectRoot, state, { type: 'quality_gate_failed', message: 'skill quality gate failed', data: { failed_gates: failedSkillGates } });
    return;
  }
  // S3 fact-check 门禁：skill checks 之后、成功路径之前；不阻塞主流程
  let factCheck = null;
  try {
    factCheck = await runFactCheck(projectRoot, project, state, runtime, draft);
  } catch (error) {
    rethrowIfCancelled(error, runtime.signal);
    await appendEvent(projectRoot, {
      type: "fact_check_failed", project_id: project.project_id,
      chapter_no: state.current_chapter_no, stage: "reviewing", severity: "warn",
      message: `fact-check 失败：${error.message}`
    });
  }
  if (factCheck?.conflicts?.length && project.fact_check?.hard === true) {
    await applyFactCheckHardFail(projectRoot, project, state, factCheck.conflicts);
    return;
  }
  const next = setStage({ ...state }, "finalizing");
  await saveState(projectRoot, next);
  await upsertChapter(projectRoot, {
    chapter_no: state.current_chapter_no,
    status: "finalizing",
    actual_words: gate.actual_words,
    quality_gate_results: [gate, titleGate, wordCapGate, ...skillGateResults]
  });
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next, [], [], null, { skill_gate_results: skillGateResults }));
}

async function reviseChapter(projectRoot, project, state, runtime, options = {}) {
  const budgetedState = await consumeRevisionBudget(projectRoot, project, state);
  const draft = await readDraft(projectRoot, project, budgetedState.current_chapter_no);
  const gate = runWordCountGate(draft, project.min_words_per_chapter);
  const segmentNo = budgetedState.current_segment_no + 1;
  const qualityGateFailures = budgetedState.last_quality_gate_results?.filter((result) => result.status === "failed") ?? [];
  const response = await runWritingAgentLoop(projectRoot, project, budgetedState, runtime, {
    kind: gate.status === "failed" ? "revision_shortfall" : "revision_quality_gate",
    project_id: project.project_id,
    chapter_no: budgetedState.current_chapter_no,
    segment_no: segmentNo,
    shortfall: Math.max(gate.shortfall ?? 0, 300),
    quality_gate_failures: qualityGateFailures,
    signal: options.signal,
    allowed_tools: REVISING_ALLOWED_TOOLS
  });
  const latestState = await loadState(projectRoot);
  const next = setStage({ ...latestState, current_segment_no: segmentNo }, "reviewing");
  await saveState(projectRoot, next);
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next, [response.toolCall], [response.result], null, checkpointModelExtras(response.modelCall)));
}

async function finalizeChapter(projectRoot, project, state, runtime) {
  const draft = await readDraft(projectRoot, project, state.current_chapter_no);
  throwIfAborted(runtime.signal);
  const postProcess = await runPostProcessHooks(projectRoot, project, {
    chapter_no: state.current_chapter_no,
    stage: "post_process",
    content: draft,
    skills: runtime.stepSkills
  });
  throwIfAborted(runtime.signal);
  if (postProcess.results.some((result) => result.status === "applied")) {
    await writeFileAtomic(
      safeJoin(projectRoot, "drafts", chapterFileName(state.current_chapter_no, `draft.${project.output_format}`)),
      postProcess.content
    );
    await appendEvent(projectRoot, {
      type: "skill_hook_applied",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: "post_process",
      message: "post-process skill hooks applied to draft",
      data: { hooks: postProcess.hooks, results: postProcess.results }
    });
  }
  throwIfAborted(runtime.signal);
  const result = await finalizeChapterFile(projectRoot, project, state.current_chapter_no, { signal: runtime.signal });
  // Finalization critical section: 最终文件提交后到索引/检查点持久化之间不得插入取消检查，
  // 否则会出现最终文件存在但索引缺失的状态。duplicate=true 表示恢复时文件已提交，只修复索引。
  await emit(CORE_EVENTS.ChapterWritten, {
    projectRoot,
    path: result?.path ?? result?.draft_path ?? null,
    chapterId: state.current_chapter_no,
    actualWords: result?.actual_words ?? null,
    checksum: result?.checksum ?? null
  });
  // 记忆写入早于 saveState：崩溃后 finalize 重跑时 recordChapterMemory 按 chapter_no 去重。
  await recordChapterMemory(projectRoot, {
    chapterNo: state.current_chapter_no,
    title: `第${String(state.current_chapter_no).padStart(3, "0")}章`,
    actualWords: result.actual_words,
    checksum: result.checksum,
    content: postProcess.content
  });
  const next = setStage({ ...state }, "summarizing");
  await saveState(projectRoot, next);
  await upsertChapter(projectRoot, {
    chapter_no: state.current_chapter_no,
    status: "summarizing",
    draft_path: result.draft_path,
    final_path: result.path,
    actual_words: result.actual_words,
    checksum: result.checksum
  });
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next, [], [result], null, {
    skill_hooks: postProcess.hooks,
    skill_gate_results: postProcess.results,
    artifact_commit: {
      chapter_no: state.current_chapter_no,
      final_path: result.path,
      checksum: result.checksum,
      duplicate: result.duplicate === true
    }
  }));
}

export async function extractChapterMemory(projectRoot, project, state, runtime) {
  const chapterNo = state.current_chapter_no;
  if (project.memory_extraction?.enabled === false) return;
  const watermark = await loadContinuityState(projectRoot);
  if ((watermark.extracted_chapters ?? []).includes(chapterNo)) return; // 幂等：仅看是否已成功提取过本章
  const provider = project.active_model?.provider ?? "mock";
  if (provider === "mock") {
    await saveContinuityState(projectRoot, {
      last_extracted_chapter: chapterNo,
      extracted_chapters: [...(watermark.extracted_chapters ?? []), chapterNo]
    });
    await appendEvent(projectRoot, {
      type: "memory_extract_skipped", project_id: project.project_id, chapter_no: chapterNo,
      stage: "summarizing", message: "mock provider，跳过记忆提取"
    });
    return;
  }
  try {
    // §3.6: Check for pending extraction from a previous crash.
    // If the file exists, the model call is already done; skip it and use cached data.
    const pendingFile = safeJoin(projectRoot, "memory", `.pending-extraction-${chapterNo}.json`);
    const pendingExtraction = await readJson(pendingFile, null);

    const index = await loadChapterIndex(projectRoot);
    const entry = index.chapters.find((c) => c.chapter_no === chapterNo);
    const chapterPath = entry?.final_path ?? entry?.draft_path;
    const chapterContent = chapterPath ? await fs.readFile(chapterPath, "utf8") : "";
    const [bookSummary, continuity] = await Promise.all([
      readOptionalProjectText(projectRoot, "memory", "book_summary.md"),
      loadContinuity(projectRoot)
    ]);

    let parsed = null;
    if (pendingExtraction && pendingExtraction.ok) {
      // Recovery path: use cached extraction data, skip model call
      parsed = pendingExtraction;
    } else {
      // Normal path: call model to extract memory
      const messages = buildMemoryExtractionMessages({
        chapterNo, chapterContent,
        bookSummary, continuityMarkdown: renderForPrompt(continuity)
      });
      for (let attempt = 0; attempt < 2 && !parsed?.ok; attempt += 1) {
        throwIfAborted(runtime.signal);
        const result = await runtime.modelClient.generate({
          project, stage: "memory_extract", messages,
          signal: runtime.signal,
          metadata: { memoryExtract: true, chapterNo, attempt }
        });
        parsed = parseMemoryExtraction(result.text);
      }
      if (!parsed.ok) throw new Error(`memory extraction parse failed: ${parsed.error}`);
      // §3.6: Save pending extraction atomically (crash recovery: next run skips model call)
      await writeJsonAtomic(pendingFile, parsed);
    }

    // §3.6: Steps 1-3 are idempotent (mergeExtraction skips dupes, writes overwrite)
    const merged = mergeExtraction(continuity, parsed);
    await saveContinuity(projectRoot, merged);                           // Step 1
    await writeFileAtomic(safeJoin(projectRoot, "memory", "book_summary.md"), `# 全书摘要\n\n${parsed.summary}\n`);  // Step 2
    await saveContinuityState(projectRoot, {                             // Step 3
      last_extracted_chapter: chapterNo,
      extracted_chapters: [...(watermark.extracted_chapters ?? []), chapterNo]
    });

    // §3.6: All steps complete — remove pending file
    await fs.unlink(pendingFile).catch(() => {});

    // 故事时钟确定性检查：只报"较晚一方=本章"的冲突（去重 + 标题章号正确）
    const { violations } = checkTimeline(merged.timeline);
    const newViolations = violations.filter((v) => v.chapter_no === chapterNo);
    if (newViolations.length > 0) {
      await appendEvent(projectRoot, {
        type: "quality_gate_warning", project_id: project.project_id, chapter_no: chapterNo,
        stage: "summarizing", severity: "warn",
        message: `时间线检查发现 ${newViolations.length} 处疑似矛盾`,
        data: { violations: newViolations }
      });
      await appendChatMessage(projectRoot, {
        role: "assistant", content: summarizeTimelineViolations(newViolations, chapterNo),
        proactive: "timeline_check", chapter_no: chapterNo
      });
    }
    await appendEvent(projectRoot, {
      type: "memory_extract_completed", project_id: project.project_id, chapter_no: chapterNo,
      stage: "summarizing", message: `记忆已更新（新增事实 ${parsed.facts.length} 条）`,
      data: { facts_added: parsed.facts.length, timeline_added: parsed.timeline.length }
    });
  } catch (error) {
    rethrowIfCancelled(error, runtime.signal);
    // 失败时不推进水位、不入 extracted_chapters：让 audit:rebuild-memory 能识别本章缺失并回补。
    // 如果 pending-extraction 文件已存在（模型调用已完成但写入中断），留它让下次恢复用。
    await appendEvent(projectRoot, {
      type: "memory_extract_failed", project_id: project.project_id, chapter_no: chapterNo,
      stage: "summarizing", severity: "warn",
      message: `记忆提取失败（不影响写作，运行 npm run audit:rebuild-memory 可补建本章）：${error.message}`,
      data: { lost_chapter: chapterNo }
    });
  }
}

function renderForPrompt(continuity) {
  const facts = continuity.facts.map((f) => `- ${f.entity}/${f.attribute}: ${f.value} (${formatChapterRef(f.chapter_no)})`).join("\n");
  const chars = continuity.characters.map((c) => `- ${c.name}(${c.status}): ${c.traits.join("、")}`).join("\n");
  return [facts, chars].filter(Boolean).join("\n");
}

// S3 fact-check 门禁：在 reviewChapter 内、skill checks 之后调用。
// 不阻塞主流程：外层调用需用 try/catch 包裹，本函数内部也会吞下非致命错误。
export async function runFactCheck(projectRoot, project, state, runtime, draft) {
  if (project.fact_check?.enabled === false) {
    return null;
  }
  const provider = project.active_model?.provider ?? "mock";
  if (provider === "mock") {
    await appendEvent(projectRoot, {
      type: "fact_check_skipped", project_id: project.project_id,
      chapter_no: state.current_chapter_no, stage: "reviewing",
      message: "mock provider，跳过 fact-check"
    });
    return null;
  }
  let continuity;
  try {
    continuity = await loadContinuity(projectRoot);
  } catch (error) {
    await appendEvent(projectRoot, {
      type: "fact_check_skipped", project_id: project.project_id,
      chapter_no: state.current_chapter_no, stage: "reviewing", severity: "warn",
      message: `加载 continuity 失败，跳过 fact-check：${error.message}`
    });
    return null;
  }
  if (!continuity.facts.length) {
    await appendEvent(projectRoot, {
      type: "fact_check_skipped", project_id: project.project_id,
      chapter_no: state.current_chapter_no, stage: "reviewing",
      message: "无既有 facts，跳过 fact-check"
    });
    return null;
  }

  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed?.ok; attempt += 1) {
    throwIfAborted(runtime.signal);
    try {
      const result = await runtime.modelClient.generate({
        project, stage: "fact_check",
        messages: buildFactCheckMessages({
          chapterNo: state.current_chapter_no, draft,
          facts: continuity.facts, timeline: continuity.timeline,
          storyClock: describeStoryClock(continuity.timeline)
        }),
        signal: runtime.signal,
        metadata: { factCheck: true, chapterNo: state.current_chapter_no, attempt }
      });
      parsed = parseFactCheck(result.text);
    } catch (error) {
      rethrowIfCancelled(error, runtime.signal);
      parsed = { ok: false, error: error.message };
    }
  }
  if (!parsed?.ok) {
    await appendEvent(projectRoot, {
      type: "fact_check_skipped", project_id: project.project_id,
      chapter_no: state.current_chapter_no, stage: "reviewing", severity: "warn",
      message: `fact-check 解析失败：${parsed?.error ?? "unknown"}`
    });
    return null;
  }
  if (parsed.conflicts.length === 0) {
    await appendEvent(projectRoot, {
      type: "fact_check_completed", project_id: project.project_id,
      chapter_no: state.current_chapter_no, stage: "reviewing",
      message: "fact-check 未发现冲突"
    });
    return { conflicts: [] };
  }

  // 有冲突：记事件 + 主动消息 + 可选 pending
  const conflicts = parsed.conflicts;
  await appendEvent(projectRoot, {
    type: "quality_gate_warning", project_id: project.project_id,
    chapter_no: state.current_chapter_no, stage: "reviewing", severity: "warn",
    message: `fact-check 发现 ${conflicts.length} 个潜在冲突`,
    data: { conflicts }
  });

  const first = conflicts[0];
  const note = `第 ${state.current_chapter_no} 章可能与既有设定矛盾：「${first.draft_quote}」 ↔ ${first.conflicts_with}（第 ${first.prior_chapter} 章）。建议：${first.suggestion}`;
  await appendChatMessage(projectRoot, {
    role: "assistant", content: note, proactive: "fact_check",
    chapter_no: state.current_chapter_no
  });

  // 软模式：自动修复矛盾（draft_quote 唯一命中且有 replace_with），不等用户确认。
  // draft_quote 被截断（>200 字）时跳过自动修复：用截断后的引文做 indexOf+replace 会留下后半段造成乱码。
  if (first.replace_with && !first.draft_quote_truncated) {
    const firstIdx = draft.indexOf(first.draft_quote);
    const onlyHit = firstIdx >= 0 && draft.indexOf(first.draft_quote, firstIdx + 1) < 0;
    if (onlyHit) {
      try {
        const draftPath = safeJoin(projectRoot, "drafts", chapterFileName(state.current_chapter_no, `draft.${project.output_format}`));
        const draftContent = (await fs.readFile(draftPath, "utf8").catch(() => draft)).replace(first.draft_quote, first.replace_with);
        await writeFileAtomic(draftPath, draftContent);
        await appendEvent(projectRoot, {
          type: "fact_check_auto_fixed",
          project_id: project.project_id,
          chapter_no: state.current_chapter_no,
          stage: "reviewing",
          severity: "info",
          message: "fact-check 矛盾已自动修复",
          data: { draft_quote: first.draft_quote, replace_with: first.replace_with, conflicts_with: first.conflicts_with }
        });
      } catch (error) {
        await appendEvent(projectRoot, {
          type: "fact_check_auto_fix_failed",
          project_id: project.project_id,
          chapter_no: state.current_chapter_no,
          stage: "reviewing",
          severity: "warn",
          message: `fact-check 自动修复失败：${error.message}`,
          data: { conflict: first, error: error.message }
        });
      }
    }
  } else if (first.draft_quote_truncated) {
    await appendEvent(projectRoot, {
      type: "fact_check_auto_fix_skipped",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: "reviewing",
      severity: "info",
      message: "fact-check 引文过长被截断，跳过自动修复（避免正文乱码），请人工核对",
      data: { conflicts_with: first.conflicts_with, suggestion: first.suggestion }
    });
  }
  return { conflicts };
}

export async function applyFactCheckHardFail(projectRoot, project, state, conflicts) {
  const gate = { gate: "fact-check-gate", status: "failed", conflicts };
  const next = setStage({ ...state, last_quality_gate_results: [gate] }, "needs_revision");
  await saveState(projectRoot, next);
  await upsertChapter(projectRoot, {
    chapter_no: state.current_chapter_no,
    status: "needs_revision",
    quality_gate_results: [gate]
  });
  await appendEvent(projectRoot, {
    type: "quality_gate_failed",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: "reviewing",
    severity: "warn",
    message: `fact-check gate failed（${conflicts.length} 个设定冲突，hard 模式打回修订）`,
    data: gate
  });
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next));
  await appendFailureCard(projectRoot, state, { type: "quality_gate_failed", message: "fact-check gate failed", data: gate });
}

async function completeChapter(projectRoot, project, state, execution) {
  const chapterNo = state.current_chapter_no;
  const nextChapter = chapterNo + 1;
  const projectCompleted = nextChapter > project.target_chapters;
  const taskCompleted = execution?.contract
    ? chapterNo >= execution.contract.chapter_end
    : nextChapter > project.target_chapters;
  const next = setStage({
    ...state,
    project_status: projectCompleted ? "completed" : (taskCompleted ? "idle" : "running"),
    current_chapter_no: nextChapter,
    current_segment_no: 0
  }, projectCompleted ? "completed" : "queued");
  await upsertChapter(projectRoot, {
    chapter_no: chapterNo,
    status: "completed"
  });
  await appendEvent(projectRoot, {
    type: "chapter_completed",
    project_id: project.project_id,
    chapter_no: chapterNo,
    stage: "completed",
    message: "chapter completed",
    data: { task_id: execution?.taskId ?? null }
  });
  await saveState(projectRoot, next);
  await writeCheckpoint(projectRoot, checkpointPayload(
    project, state, next, [], [], null,
    { task_id: execution?.taskId ?? null, task_contract: execution?.contract ?? null }
  ));
  return { chapterNo, taskCompleted, projectCompleted };
}

async function createModelRuntime(projectRoot, project, options, fallbackModel) {
  ensureDefaultToolHooks();
  const existingCost = await readJson(safeJoin(projectRoot, "cost.json"), null);
  const existingCacheReport = await readJson(safeJoin(projectRoot, "cache_report.json"), { entries: {} });
  const costTracker = options.costTracker ?? new CostTracker({ pricing: buildPricingTable(project), summary: existingCost });
  const defaultAdapters = {
    "openai-compatible": new OpenAICompatibleAdapter(),
    mock: new MockProviderAdapter({
      response: async (gatewayRequest) => {
        const toolRequest = gatewayRequest.metadata?.toolRequest ?? {};
        const output = await fallbackModel.generate(toolRequest);
        return {
          text: JSON.stringify(output),
          raw: { output },
          usage: estimateMockUsage(gatewayRequest.prompt, output)
        };
      }
    })
  };
  const adapters = options.adapters
    ? { ...defaultAdapters, ...options.adapters }
    : defaultAdapters;
  const modelClient =
    options.modelClient ??
    new ModelClient({
      costTracker,
      adapters,
      onRetry: (info) => {
        costTracker.recordRetry?.();
        appendEvent(projectRoot, {
          type: "model_retry",
          severity: "warn",
          message: `模型调用重试 ${info.attempt}/${info.maxAttempts}（${info.reason}），等待 ${Math.round(info.delay)}ms`,
          data: { attempt: info.attempt, reason: info.reason, model: info.model }
        }).catch(() => {});
      },
      onActivity: options.onActivity
    });
  return {
    modelClient,
    signal: options.signal,
    taskId: options.taskId ?? null,
    contract: options.contract ?? null,
    cacheKeyManager: options.cacheKeyManager ?? new CacheKeyManager({ entries: existingCacheReport.entries ?? {} }),
    stepSkills: null,
    warnedChapters: new Set()
  };
}

async function runModelGatewayCall(projectRoot, project, state, runtime, request) {
  throwIfAborted(request.signal);
  const compiledPrompt = await compileChapterPrompt(projectRoot, project, state, request, runtime);
  const cacheEntry = runtime.cacheKeyManager.update({
    projectId: project.project_id,
    templateVersion: compiledPrompt.templateVersion,
    stableHash: compiledPrompt.stableHash
  });
  await appendEvent(projectRoot, {
    type: "model_call_started",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: state.current_stage,
    message: "model gateway call started",
    data: {
      request_kind: request.kind,
      attempt: request.attempt,
      cache_key: cacheEntry.cacheKey
    }
  });
  if (request.kind === "revision_shortfall") {
    runtime.modelClient.costTracker?.recordRefill?.();
  }
  const gatewayResult = await runtime.modelClient.generate({
    project,
    stage: state.current_stage,
    prompt: compiledPrompt.prompt,
    signal: request.signal,
    metadata: {
      toolRequest: request,
      cacheKey: cacheEntry.cacheKey,
      cacheVersion: cacheEntry.cacheVersion,
      chapterNo: state.current_chapter_no
    }
  });
  throwIfAborted(request.signal);
  await emit(CORE_EVENTS.ModelCallComplete, {
    projectRoot,
    model: gatewayResult?.modelConfig?.model_name ?? "unknown",
    usage: gatewayResult?.usageReport ?? {},
    options: { stage: state.current_stage, requestKind: request.kind, attempt: request.attempt }
  });
  if (runtime.modelClient.costTracker?.writeProjectReport) {
    await runtime.modelClient.costTracker.writeProjectReport(projectRoot);
  }
  await maybeWarnChapterCost(projectRoot, project, state, gatewayResult.costSummary, runtime);
  const cacheReport = await writeCacheReport(projectRoot, {
    manager: runtime.cacheKeyManager,
    cacheEntry,
    compiledPrompt,
    usageReport: gatewayResult.usageReport,
    modelConfig: gatewayResult.modelConfig
  });
  const output = parseGatewayToolOutput(gatewayResult);
  const modelCall = {
    request_kind: request.kind,
    attempt: request.attempt,
    stage: state.current_stage,
    prompt_template_version: compiledPrompt.templateVersion,
    context_package_hash: sha256(compiledPrompt.prompt),
    prompt_block_hashes: compiledPrompt.blockHashes,
    stable_hash: compiledPrompt.stableHash,
    dynamic_hash: compiledPrompt.dynamicHash,
    cache_key: cacheEntry.cacheKey,
    cache_version: cacheEntry.cacheVersion,
    model_config: gatewayResult.modelConfig,
    usage_report: gatewayResult.usageReport,
    cost_summary: gatewayResult.costSummary,
    cache_report: cacheReport.last_call,
    skill_hooks: compiledPrompt.skillHooks ?? [],
    output_type: output?.type ?? null
  };
  await appendEvent(projectRoot, {
    type: "model_usage_recorded",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: state.current_stage,
    message: "model usage recorded",
    data: {
      usage_report: gatewayResult.usageReport,
      cost_summary: gatewayResult.costSummary
    }
  });
  await appendEvent(projectRoot, {
    type: "cache_report_updated",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: state.current_stage,
    message: "cache report updated",
    data: cacheReport.last_call
  });
  await appendEvent(projectRoot, {
    type: "model_call_completed",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: state.current_stage,
    message: "model gateway call completed",
    data: {
      request_kind: request.kind,
      attempt: request.attempt,
      output_type: output?.type ?? null
    }
  });
  return { output, ...modelCall };
}

export async function maybeWarnChapterCost(projectRoot, project, state, costSummary, runtime) {
  const chapterKey = String(state.current_chapter_no);
  if (runtime.warnedChapters?.has(chapterKey)) return;
  const byChapter = costSummary?.byChapter ?? {};
  const current = byChapter[chapterKey];
  const others = Object.entries(byChapter)
    .filter(([key]) => key !== chapterKey)
    .map(([, bucket]) => bucket.totalTokens ?? 0);
  if (!current || others.length < 2) return;
  const average = others.reduce((a, b) => a + b, 0) / others.length;
  if (average > 0 && (current.totalTokens ?? 0) > average * 2) {
    runtime.warnedChapters?.add(chapterKey);
    await appendEvent(projectRoot, {
      type: "chapter_cost_warning",
      severity: "warn",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: state.current_stage,
      message: `第 ${state.current_chapter_no} 章 token 消耗已超过前几章平均值的 2 倍`,
      data: {
        chapter_total_tokens: current.totalTokens ?? 0,
        average_other_chapters: Math.round(average)
      }
    });
  }
}

const DEFAULT_DRAFTING_SYSTEM_RULES = [
  "你是一位功底深厚的中文小说家，擅长用克制而精准的笔触讲故事，让读者通过画面与人物自行体会，而不是被直接告知。",
  "本章正文必须通过 append_chapter_segment 工具写入；写在聊天回复里的正文不算交付，会被判为无效。"
].join("\n");

const DEFAULT_FORBIDDEN_PATTERNS = [
  "普通大学生突然获得神力",
  "不是梦",
  "三天了",
  "你不是唯一一个",
  "代价",
  "神性"
];

async function compileChapterPrompt(projectRoot, project, state, request, runtime) {
  const configuredVersion = project.prompt_template_versions?.drafting ?? "v1";
  const templateVersion = configuredVersion.startsWith("drafting.") ? configuredVersion : `drafting.${configuredVersion}`;
  const compiler = new PromptCompiler({ templateVersion });
  const [promptTemplate, bookSummary, draft, latestUserFeedback, planningSkillPrompts, stageSkillPrompts, continuityContext, continuity] = await Promise.all([
    readOptionalProjectText(projectRoot, "prompts", `${templateVersion}.md`),
    readOptionalProjectText(projectRoot, "memory", "book_summary.md"),
    readDraft(projectRoot, project, state.current_chapter_no),
    readLatestUserInstructions(projectRoot),
    collectSkillPromptHooks(projectRoot, project, "planning", {
      chapter_no: state.current_chapter_no,
      stage: "planning",
      skills: runtime?.stepSkills
    }),
    collectSkillPromptHooks(projectRoot, project, state.current_stage, {
      chapter_no: state.current_chapter_no,
      stage: state.current_stage,
      skills: runtime?.stepSkills
    }),
    buildContinuityPromptContext(projectRoot, state.current_chapter_no),
    loadContinuity(projectRoot)
  ]);
  const skillInstructions = [planningSkillPrompts.content, stageSkillPrompts.content].filter(Boolean).join("\n\n");
  const styleRules = [
    `输出格式：${project.output_format}。每章最低有效字数：${project.min_words_per_chapter}。`,
    "叙事连续性：第 2 章及以后必须承接上一章落点，不要把本章写成新的第一章，不要重复介绍主角和世界观。",
    "段落连续性：segment_no 大于 1 时，直接续写 selected_draft_fragment 的最后动作、对话或悬念，不要另起一个开头。",
    "呈现而非概述：用具体的动作、对白和环境细节推进，不直接宣告人物的情绪、性格或本章主题。",
    "对白带潜台词：人物各有自己的声音，话里留有没说出口的东西；不要用对白生硬交代设定。",
    "节奏有张弛：长短句交替，场景之间留出呼吸；每个场景至少发生一次信息、关系或情绪上的变化。",
    "感官克制：调动五感但不堆砌形容词；情绪靠细节累积，避免“仿佛”“似乎”“一种说不出的”这类模糊词。",
    "视角与时态全程保持一致，不中途滑动视角，不让旁白替人物下结论。",
    "禁用高频套路词和套话，除非用户原始设定强制要求：普通大学生突然获得神力、不是梦、三天了、你不是唯一一个、代价、神性、命运逼近、神秘力量。"
  ];
  // 输出风格(project-level preference, default creative)
  const selectedStyleName = project.output_style ?? "creative";
  const outputStyles = await loadOutputStyles({ projectRoot, userHome: os.homedir() });
  const selectedStyle = outputStyles.find((s) => s.name === selectedStyleName) ?? outputStyles[0];
  if (selectedStyle) {
    styleRules.push(`## 输出风格: ${selectedStyle.name}\n${selectedStyle.body}`);
  }
  const styleRulesText = styleRules.join("\n");
  const chapterContinuityRule = state.current_chapter_no > 1
    ? `第 ${state.current_chapter_no} 章必须从第 ${state.current_chapter_no - 1} 章留下的后果、线索或情绪压力继续推进。`
    : "第 1 章可以建立初始处境一次；不要在同一章后续段落重复开场。";
  const compiled = compiler.compile({
    stableBlocks: {
      system_rules:
        promptTemplate ||
        DEFAULT_DRAFTING_SYSTEM_RULES,
      goal: project.story_seed ?? project.title ?? "Untitled writing project",
      style: styleRulesText,
      skill_instructions: skillInstructions
    },
    dynamicBlocks: {
      project_memory: [bookSummary, buildRelevantFacts(continuity, state.current_chapter_no), continuityContext].filter(Boolean).join("\n\n"),
      chapter_plan: [`第 ${state.current_chapter_no} 章 / 共 ${project.target_chapters} 章。`, chapterContinuityRule].join("\n"),
      current_task: JSON.stringify(
        {
          kind: request.kind,
          project_id: request.project_id ?? project.project_id,
          chapter_no: request.chapter_no,
          segment_no: request.segment_no,
          segment_target_words: request.segment_target_words,
          shortfall: request.shortfall,
          // 章节字数缺口：把当前真实已写字数与剩余缺口直接喂给模型，
          // 让首次写正文时就按目标写够，避免 word-count gate 失败后
          // 再发起补写请求（补写会被 costTracker.recordRefill 计费）。
          ...computeChapterWordGap({
            draftContent: draft,
            minWords: project.min_words_per_chapter
          }),
          quality_gate_failures: request.quality_gate_failures,
          correction_attempt: request.correction_attempt,
          validation_feedback: request.validation_feedback,
          allowed_tools: request.allowed_tools ?? ["append_chapter_segment"],
          agent_loop_feedback: request.agent_loop_feedback ?? null,
          agent_loop_instruction: (request.allowed_tools?.length ?? 0) > 1
            ? "写作时你可以先调用 read 类工具（list_chapters 看全局进度、read_chapter 读具体章节、read_continuity 查设定档案、read_outline 查大纲、get_status 看当前状态）查询前文与设定，也可以用 edit_chapter 修改本章已写部分。当前阶段还允许 update_continuity/update_outline 时，可修订设定或大纲。准备就绪后，必须调用 append_chapter_segment 提交本段新正文。一次只调用一个工具，工具结果会回给你。"
            : null,
          segment_continuity_required: request.segment_no > 1,
          chapter_continuity_required: request.chapter_no > 1,
          forbidden_reboot_patterns: project.forbidden_patterns ?? DEFAULT_FORBIDDEN_PATTERNS
        },
        null,
        2
      ),
      selected_draft_fragment: draft.slice(-1200),
      latest_user_feedback: latestUserFeedback,
      recent_trace_summary: `stage=${state.current_stage}; current_segment_no=${state.current_segment_no}; attempt=${request.attempt}.`
    }
  });
  return {
    ...compiled,
    skillHooks: [...planningSkillPrompts.hooks, ...stageSkillPrompts.hooks]
  };
}

async function readOptionalProjectText(projectRoot, ...parts) {
  try {
    return await fs.readFile(safeJoin(projectRoot, ...parts), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readLatestUserInstructions(projectRoot) {
  const events = await readEvents(projectRoot, { limit: 80 });
  const instructions = events
    .filter((event) => event.type === "user_instruction_received" && event.message)
    .slice(-5)
    .map((event) => `- ${event.timestamp}: ${event.message}`);
  if (instructions.length === 0) {
    return "";
  }
  return ["用户通过命令栏提交的最新写作要求，必须在不绕过项目设定和工具写入规则的前提下纳入当前章节：", ...instructions].join("\n");
}

function parseGatewayToolOutput(gatewayResult) {
  const openAIToolCall = parseOpenAIToolCall(gatewayResult.raw);
  if (openAIToolCall) {
    return openAIToolCall;
  }
  if (gatewayResult.raw?.output) {
    return gatewayResult.raw.output;
  }
  const parsedText = parseJsonOutputText(gatewayResult.text);
  if (parsedText) {
    return parsedText;
  }
  return {
    type: "status_message",
    message: gatewayResult.text
  };
}

// 写作 agent 循环（runWritingAgentLoop）每轮只处理一个工具调用（与 chat 的多工具支持不同）。
// 这是有意的设计选择：写作流水线中工具之间有严格依赖（read → edit → append），
// 单工具轮次让模型每次只做一个决策，结果喂回后由下一轮决策是否继续，避免批次决策失误导致全局阻塞。
function parseOpenAIToolCall(raw) {
  const message = raw?.choices?.[0]?.message;
  const toolCall = Array.isArray(message?.tool_calls) ? message.tool_calls[0] : null;
  if (toolCall) {
    return {
      type: "tool_call",
      id: toolCall.id ?? null,
      tool: toolCall.function?.name ?? toolCall.name ?? null,
      input: parseToolCallArguments(toolCall.function?.arguments ?? toolCall.arguments)
    };
  }
  if (message?.function_call) {
    return {
      type: "tool_call",
      id: null,
      tool: message.function_call.name ?? null,
      input: parseToolCallArguments(message.function_call.arguments)
    };
  }
  return null;
}

function parseToolCallArguments(argumentsValue) {
  if (argumentsValue && typeof argumentsValue === "object") {
    return argumentsValue;
  }
  if (typeof argumentsValue !== "string") {
    return null;
  }
  try {
    return JSON.parse(argumentsValue);
  } catch {
    return null;
  }
}

function parseJsonOutputText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function estimateMockUsage(prompt, output) {
  const inputTokens = Math.max(1, Math.ceil(String(prompt ?? "").length / 4));
  const outputText = JSON.stringify(output ?? "");
  const outputTokens = Math.max(1, Math.ceil(outputText.length / 4));
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  };
}

function checkpointModelExtras(modelCall) {
  if (!modelCall) {
    return {};
  }
  return {
    context_package_hash: modelCall.context_package_hash,
    prompt_block_hashes: modelCall.prompt_block_hashes,
    model_calls: [modelCall],
    usage_reports: [modelCall.usage_report],
    cost_summary: modelCall.cost_summary,
    cache_report: modelCall.cache_report,
    cache_key: modelCall.cache_key,
    skill_hooks: modelCall.skill_hooks ?? []
  };
}

// =============== 写作 agent 循环（调整点 1：软化管道） ===============
// drafting/revising 阶段不再只让模型填一段正文，而是允许模型连续调用 read/edit/update 类工具
// 查设定、改前文、修设定，最后以 append_chapter_segment 提交本段正文。
// 保留旧管道兜底：连续 3 次“未成功提交”（纯文本 / 校验失败 / 非白名单工具）-> model_output_invalid；
// 总轮数达上限仍没提交 -> agent_loop_exhausted。
const WRITING_AGENT_MAX_ROUNDS = 8;
const WRITING_AGENT_COMMIT_FAILURES = 8;

const DRAFTING_ALLOWED_TOOLS = [
  "get_status",
  "list_chapters",
  "read_chapter",
  "read_continuity",
  "read_outline",
  "edit_chapter",
  "append_chapter_segment"
];

const REVISING_ALLOWED_TOOLS = [
  "get_status",
  "list_chapters",
  "read_chapter",
  "read_continuity",
  "read_outline",
  "edit_chapter",
  "update_continuity",
  "update_outline",
  "append_chapter_segment"
];

function buildWritingRegistry() {
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  return registry;
}

function summarizeToolResult(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return json.length > 500 ? `${json.slice(0, 500)}…` : json;
}

async function failWritingAgentLoop(projectRoot, project, state, reason, lastValidation, lastModelCall, allowedTools) {
  await blockProject(projectRoot, project, state, reason, {
    last_validation: lastValidation,
    last_model_call: lastModelCall,
    allowed_tools: allowedTools
  }, { skipFailureCard: true });
  await appendFailureCard(projectRoot, state, {
    type: "tool_call_rejected",
    message: lastValidation?.message ?? reason,
    data: { tool: lastModelCall?.output?.tool ?? null, code: reason }
  });
}

// 写作 agent 循环：模型每轮可调一个白名单工具；非 append_chapter_segment 的工具结果作为
// agent_loop_feedback 喂回下一轮 prompt。append_chapter_segment 校验通过即执行并退出循环。
async function runWritingAgentLoop(projectRoot, project, state, runtime, request) {
  const allowedTools = request.allowed_tools ?? ["append_chapter_segment"];
  const registry = buildWritingRegistry();
  let agentLoopFeedback = null;
  let lastValidation = null;
  let lastModelCall = null;
  let commitFailures = 0;

  for (let attempt = 1; attempt <= WRITING_AGENT_MAX_ROUNDS; attempt += 1) {
    throwIfAborted(runtime.signal);
    await consumeModelCallBudget(projectRoot, project, state, {
      request_kind: request.kind,
      attempt,
      agent_loop: true
    });

    const modelCall = await runModelGatewayCall(projectRoot, project, state, runtime, {
      ...request,
      correction_attempt: attempt > 1,
      validation_feedback: lastValidation,
      agent_loop_feedback: agentLoopFeedback,
      allowed_tools: allowedTools,
      attempt
    });
    lastModelCall = modelCall;
    const output = modelCall.output;

    // 情况 A：模型没调工具（纯文本），对应旧 invalid_output_channel
    if (output.type !== "tool_call") {
      const validation = {
        ok: false,
        code: "invalid_output_channel",
        message: "Chapter body must be written through a tool_call, not delivered in chat."
      };
      lastValidation = validation;
      commitFailures += 1;
      agentLoopFeedback = {
        status: "no_tool_call",
        message: "你没有调用工具。写作正文必须通过 append_chapter_segment 提交，请重新调用工具。"
      };
      await appendEvent(projectRoot, {
        type: "tool_call_rejected",
        project_id: project.project_id,
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        severity: "warn",
        message: validation.message,
        data: { code: validation.code, attempt, output_type: output?.type ?? null }
      });
      if (commitFailures >= WRITING_AGENT_COMMIT_FAILURES) {
        await failWritingAgentLoop(projectRoot, project, state, "model_output_invalid", lastValidation, lastModelCall, allowedTools);
        throw new ProjectBlockedError("model_output_invalid");
      }
      continue;
    }

    // 情况 B：工具不在白名单
    if (!allowedTools.includes(output.tool)) {
      const validation = {
        ok: false,
        code: "unsupported_tool",
        message: `Unsupported tool for chapter writing: ${output.tool ?? "missing"}`
      };
      lastValidation = validation;
      commitFailures += 1;
      agentLoopFeedback = {
        status: "tool_not_allowed",
        tool: output.tool,
        message: `工具 ${output.tool} 不在当前阶段允许列表内。允许的工具：${allowedTools.join(", ")}。`
      };
      await appendEvent(projectRoot, {
        type: "tool_call_rejected",
        project_id: project.project_id,
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        severity: "warn",
        message: validation.message,
        data: { code: validation.code, attempt, tool: output.tool }
      });
      if (commitFailures >= WRITING_AGENT_COMMIT_FAILURES) {
        await failWritingAgentLoop(projectRoot, project, state, "model_output_invalid", lastValidation, lastModelCall, allowedTools);
        throw new ProjectBlockedError("model_output_invalid");
      }
      continue;
    }

    // 情况 C：append_chapter_segment —— 提交动作，校验通过即执行并退出
    if (output.tool === "append_chapter_segment") {
      const validation = assertToolCallForChapter(output, {
        project_id: project.project_id,
        chapter_no: state.current_chapter_no,
        segment_no: request.segment_no,
        allowedTools: ["append_chapter_segment"]
      });
      if (validation.ok) {
        await appendEvent(projectRoot, {
          type: "tool_call_requested",
          project_id: project.project_id,
          chapter_no: state.current_chapter_no,
          stage: state.current_stage,
          message: "model requested a file-writing tool",
          data: { tool: output.tool, attempt }
        });
        const result = await executeToolCall(projectRoot, project, state, output, {
          expectedChapterNo: state.current_chapter_no,
          expectedSegmentNo: request.segment_no
        });
        return { toolCall: output, modelCall: lastModelCall, result };
      }
      // 校验失败：记事件 + feedback，连续 3 次则 block
      lastValidation = validation;
      commitFailures += 1;
      agentLoopFeedback = {
        status: "validation_failed",
        tool: output.tool,
        message: validation.message
      };
      await appendEvent(projectRoot, {
        type: "quality_gate_failed",
        project_id: project.project_id,
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        severity: "warn",
        message: validation.message,
        data: { code: validation.code, attempt, output_type: output?.type ?? null }
      });
      await appendEvent(projectRoot, {
        type: "tool_call_rejected",
        project_id: project.project_id,
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        severity: "warn",
        message: validation.message,
        data: { code: validation.code, attempt, output_type: output?.type ?? null }
      });
      if (commitFailures >= WRITING_AGENT_COMMIT_FAILURES) {
        await failWritingAgentLoop(projectRoot, project, state, "model_output_invalid", lastValidation, lastModelCall, allowedTools);
        throw new ProjectBlockedError("model_output_invalid");
      }
      continue;
    }

    // 情况 D：白名单内的 read/edit/update 工具 —— 通过 registry 执行，结果喂回模型
    const tool = registry.get(output.tool);
    if (!tool) {
      agentLoopFeedback = {
        status: "unknown_tool",
        tool: output.tool,
        message: `工具 ${output.tool} 未注册。`
      };
      continue;
    }

    const permission = checkToolPermission(tool, project.tool_permissions ?? {}, {
      archived: Boolean(project.archived_at)
    });
    if (!permission.allowed) {
      agentLoopFeedback = {
        status: "permission_denied",
        tool: output.tool,
        message: permission.message
      };
      await appendEvent(projectRoot, {
        type: "tool_call_rejected",
        project_id: project.project_id,
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        severity: "warn",
        message: permission.message,
        data: { tool: output.tool, reason: permission.message }
      });
      continue;
    }

    const toolStartMs = Date.now();
    try {
      // 写作引擎自己 edit 当前章是预期行为：传空 runJobs 让 edit_chapter 跳过 chapter_busy 检查。
      const toolCtx = {
        projectRoot,
        project,
        server: { runJobs: new Map() }
      };
      const result = await tool.run(output.input ?? {}, toolCtx);
      commitFailures = 0; // 模型在干活，重置提交失败计数
      const summary = summarizeToolResult(result);
      agentLoopFeedback = {
        status: "tool_result",
        tool: output.tool,
        result_summary: summary
      };
      await appendEvent(projectRoot, {
        type: "agent_loop_tool_executed",
        project_id: project.project_id,
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        message: `agent loop tool ${output.tool}: ok`,
        data: { tool: output.tool, attempt, duration_ms: Date.now() - toolStartMs, result_summary: summary }
      });
    } catch (error) {
      agentLoopFeedback = {
        status: "tool_error",
        tool: output.tool,
        error: error.message
      };
      await appendEvent(projectRoot, {
        type: "agent_loop_tool_failed",
        project_id: project.project_id,
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        severity: "warn",
        message: `agent loop tool ${output.tool} failed: ${error.message}`,
        data: { tool: output.tool, attempt, error: error.code ?? error.message, duration_ms: Date.now() - toolStartMs }
      });
    }
  }

  // 总轮数达上限仍没提交 append_chapter_segment
  await failWritingAgentLoop(projectRoot, project, state, "agent_loop_exhausted", lastValidation, lastModelCall, allowedTools);
  throw new ProjectBlockedError("agent_loop_exhausted");
}

// 统一的故障卡落账 helper：消除 reviewChapter / executeToolCall / blockProject 等处的重复 try/catch。
async function appendFailureCard(projectRoot, state, { type, message, data }) {
  try {
    const fresh = await loadState(projectRoot).catch(() => state);
    const card = deriveFailureCard({
      id: `flr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      chapter_no: state.current_chapter_no,
      message,
      ts: new Date().toISOString(),
      data
    }, fresh);
    appendFailure(projectRoot, card);
  } catch (err) {
    console.warn("appendFailure failed:", err.message);
  }
}

async function executeToolCall(projectRoot, project, state, toolCall, options) {
  if (toolCall.tool !== "append_chapter_segment") {
    await blockProject(projectRoot, project, state, "unsupported_tool", {
      tool: toolCall.tool
    });
    throw new ProjectBlockedError("unsupported_tool");
  }

  const hookContext = { projectRoot, project, state, toolCall };

  // BeforeToolUse: 可一票否决
  const beforeResult = await runBeforeToolUse(hookContext);
  if (!beforeResult.allow) {
    await appendEvent(projectRoot, {
      type: "tool_call_rejected",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: state.current_stage,
      severity: "warn",
      message: beforeResult.reason ?? "blocked by BeforeToolUse hook",
      data: { tool: toolCall.tool, reason: beforeResult.reason }
    });
    await blockProject(projectRoot, project, state, "tool_hook_blocked", {
      tool: toolCall.tool,
      reason: beforeResult.reason
    });
    throw new ProjectBlockedError("tool_hook_blocked");
  }

  const startMs = Date.now();
  try {
    const result = await appendChapterSegment(projectRoot, project, toolCall.input, {
      requireProjectId: true,
      ...options
    });
    await runAfterToolUse({
      ...hookContext,
      result,
      ok: true,
      durationMs: Date.now() - startMs
    });
    return result;
  } catch (error) {
    await runAfterToolUse({
      ...hookContext,
      ok: false,
      durationMs: Date.now() - startMs,
      error
    });
    if (error instanceof ToolValidationError) {
      await appendEvent(projectRoot, {
        type: "tool_call_rejected",
        project_id: project.project_id,
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        severity: "error",
        message: error.message,
        data: { code: error.code, tool: toolCall.tool }
      });
      await blockProject(projectRoot, project, state, error.code, {
        message: error.message
      }, { skipFailureCard: true });
      await appendFailureCard(projectRoot, state, { type: 'tool_call_rejected', message: error.message, data: { tool: error.tool, code: error.code } });
      throw new ProjectBlockedError(error.code);
    }
    throw error;
  }
}

async function consumeModelCallBudget(projectRoot, project, state, data = {}) {
  const current = await loadState(projectRoot);
  const budget = withBudgetDefaults(current);
  const maxCalls = budget.max_model_calls;
  if (Number.isFinite(maxCalls) && budget.model_calls >= maxCalls) {
    await blockProject(projectRoot, project, current, "model_call_budget_exhausted", {
      model_calls: budget.model_calls,
      max_model_calls: maxCalls,
      ...data
    });
    throw new ProjectBlockedError("model_call_budget_exhausted");
  }
  const costSummary = await readJson(safeJoin(projectRoot, "cost.json"), null);
  const maxTokens = budget.max_total_tokens;
  if (Number.isFinite(maxTokens) && (costSummary?.totalTokens ?? 0) >= maxTokens) {
    await blockProject(projectRoot, project, current, "token_budget_exhausted", {
      total_tokens: costSummary?.totalTokens ?? 0,
      max_total_tokens: maxTokens,
      ...data
    });
    throw new ProjectBlockedError("token_budget_exhausted");
  }
  const maxCost = budget.max_cost;
  if (Number.isFinite(maxCost) && costSummary?.costAvailable === true && costSummary.estimatedCost >= maxCost) {
    await blockProject(projectRoot, project, current, "cost_budget_exhausted", {
      estimated_cost: costSummary.estimatedCost,
      max_cost: maxCost,
      ...data
    });
    throw new ProjectBlockedError("cost_budget_exhausted");
  }
  budget.model_calls += 1;
  current.active_budget = budget;
  await saveState(projectRoot, current);
  await appendEvent(projectRoot, {
    type: "budget_updated",
    project_id: project.project_id,
    chapter_no: current.current_chapter_no,
    stage: current.current_stage,
    message: "model call budget consumed",
    data: {
      model_calls: budget.model_calls,
      max_model_calls: maxCalls,
      ...data
    }
  });
  return current;
}

async function consumeRevisionBudget(projectRoot, project, state) {
  const current = await loadState(projectRoot);
  const budget = withBudgetDefaults(current);
  budget.revision_rounds_by_chapter ??= {};
  const key = String(state.current_chapter_no);
  const used = budget.revision_rounds_by_chapter[key] ?? 0;
  const maxRounds = budget.max_revision_rounds_per_chapter;
  if (Number.isFinite(maxRounds) && used >= maxRounds) {
    await blockProject(projectRoot, project, current, "revision_budget_exhausted", {
      chapter_no: state.current_chapter_no,
      revision_rounds: used,
      max_revision_rounds_per_chapter: maxRounds
    });
    throw new ProjectBlockedError("revision_budget_exhausted");
  }
  budget.revision_rounds_by_chapter[key] = used + 1;
  current.active_budget = budget;
  await saveState(projectRoot, current);
  await appendEvent(projectRoot, {
    type: "budget_updated",
    project_id: project.project_id,
    chapter_no: current.current_chapter_no,
    stage: current.current_stage,
    message: "revision budget consumed",
    data: {
      revision_rounds: used + 1,
      max_revision_rounds_per_chapter: maxRounds
    }
  });
  return current;
}

function withBudgetDefaults(state) {
  return {
    model_calls: 0,
    max_model_calls: null,
    revision_rounds_by_chapter: {},
    max_revision_rounds_per_chapter: null,
    max_cost: null,
    max_total_tokens: null,
    ...(state.active_budget ?? {})
  };
}

async function blockProject(projectRoot, project, state, reason, data = {}, opts = {}) {
  const current = await loadState(projectRoot).catch(() => state);
  if (current.project_status === "blocked") {
    return current;
  }
  const next = setStage({
    ...current,
    project_status: "blocked",
    blocked_reason: reason,
    blocked_at_stage: current.current_stage,
    blocked_at: new Date().toISOString(),
    blocked_data: data
  }, "blocked");
  await saveState(projectRoot, next);
  if (Number.isInteger(current.current_chapter_no)) {
    await upsertChapter(projectRoot, {
      chapter_no: current.current_chapter_no,
      status: "blocked"
    });
  }
  await appendEvent(projectRoot, {
    type: "project_blocked",
    project_id: project.project_id,
    chapter_no: current.current_chapter_no,
    stage: current.current_stage,
    severity: "error",
    message: reason,
    data
  });
  await writeCheckpoint(projectRoot, checkpointPayload(project, current, next, [], [], {
    code: reason,
    data
  }));
  if (!opts.skipFailureCard) {
    await appendFailureCard(projectRoot, current, { type: 'project_blocked', message: reason, data });
  }
  return next;
}

function checkpointPayload(project, stateBefore, stateAfter, toolCalls = [], toolResults = [], error = null, extras = {}) {
  return {
    project_id: project.project_id,
    task_id: extras.task_id ?? `${project.project_id}:${stateAfter.current_chapter_no}:${stateAfter.current_stage}`,
    task_contract: extras.task_contract ?? null,
    committed_model_calls: extras.committed_model_calls ?? [],
    artifact_commit: extras.artifact_commit ?? null,
    chapter_no: stateAfter.current_chapter_no,
    stage: stateAfter.current_stage,
    segment_no: stateAfter.current_segment_no,
    model_config: {
      active_model: project.active_model ?? {
        provider: "mock",
        model_name: project.default_writer_model ?? "mock-writer"
      },
      stage_overrides_enabled: hasEnabledStageOverrides(project.stage_overrides),
      writer: project.default_writer_model,
      reviewer: project.default_reviewer_model
    },
    prompt_template_versions: project.prompt_template_versions,
    prompt_block_hashes: extras.prompt_block_hashes ?? {},
    model_calls: extras.model_calls ?? [],
    usage_reports: extras.usage_reports ?? [],
    cost_summary: extras.cost_summary ?? null,
    cache_report: extras.cache_report ?? null,
    cache_key: extras.cache_key ?? null,
    skill_hooks: extras.skill_hooks ?? [],
    skill_gate_results: extras.skill_gate_results ?? [],
    context_package_hash: extras.context_package_hash,
    tool_calls: toolCalls,
    tool_results: toolResults,
    state_before: stateBefore,
    state_after: stateAfter,
    error
  };
}

// 切换阶段时盖时间戳；同阶段重入不刷新（活动条耗时依赖它）。
function setStage(state, stage) {
  if (state.current_stage !== stage) {
    state.stage_entered_at = new Date().toISOString();
  }
  state.current_stage = stage;
  return state;
}

function hasEnabledStageOverrides(stageOverrides) {
  if (!stageOverrides || typeof stageOverrides !== "object") {
    return false;
  }
  if (stageOverrides.enabled === false) {
    return false;
  }
  return Object.values(stageOverrides).some((value) => value && typeof value === "object" && value.enabled === true);
}
