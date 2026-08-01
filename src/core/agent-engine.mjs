import { appendEvent, readEvents, tailEvents } from "./event-log.mjs";
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
import { appendChatMessage } from "./chat/chat-store.mjs";
import { createToolRegistry, checkToolPermission } from "./chat/tool-registry.mjs";
import { registerReadTools } from "./chat/tools-read.mjs";
import { registerWriteTools } from "./chat/tools-write.mjs";
import { validateTaskContract } from "./task-contract.mjs";
import { ProjectCancelledError, rethrowIfCancelled, throwIfAborted } from "./cancellation.mjs";
import { WritingAgentSession } from "./writing-agent-session.mjs";
import { ToolTranscript } from "./agent-transcript.mjs";

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
      await appendFailureCard(projectRoot, state, {
        type: "model-error",
        message: error.message,
        data: { reason: "model_provider_unavailable" }
      });
      await emit(CORE_EVENTS.TaskFailed, {
        projectRoot,
        taskId: state.current_stage,
        error,
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
    await appendFailureCard(projectRoot, state, {
      type: "model-error",
      message: error.message,
      data: {
        // ProviderTransportError 的具体信息(DeepSeek 400 的 status/body/reason)透传给故障卡,
        // derive-failure-card 的 diagnostics.providerStatus/providerReason/providerBody 直接读取。
        reason: error.reason ?? "interrupted",
        status: error.status ?? null,
        body: typeof error.body === "string" ? error.body.slice(0, 2000) : null
      }
    });
    await emit(CORE_EVENTS.TaskFailed, {
      projectRoot,
      taskId: state.current_stage,
      error,
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
  // 恢复检测：上次中断时 pending transcript 已落盘（可能在「模型已决策、工具未执行」的
  // 崩溃窗口），只要存在就传给循环续写——跳过首轮编译与重复写入；未回执轮次由
  // runWritingAgentLoop 恢复裁剪处理（trimUnresolvedAssistantTurns）。
  const pendingData = await readPendingTranscript(projectRoot, state.current_chapter_no, segmentNo);
  const restoredTranscript = pendingData ? ToolTranscript.restore(pendingData) : null;
  const response = await runWritingAgentLoop(projectRoot, project, state, runtime, {
    kind: "draft_segment",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    segment_no: segmentNo,
    segment_target_words: Math.max(900, Math.ceil(project.target_words_per_chapter / 3)),
    signal: options.signal,
    allowed_tools: DRAFTING_ALLOWED_TOOLS,
    ...(options.simulateInterruptAfter ? { simulate_interrupt_after: options.simulateInterruptAfter } : {}),
    ...(restoredTranscript ? { restored_transcript: restoredTranscript } : {})
  });
  const latestState = await loadState(projectRoot);
  const next = setStage({ ...latestState, current_segment_no: segmentNo }, "drafting");
  await saveState(projectRoot, next);
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next, [response.toolCall], [response.result], null, { ...checkpointModelExtras(response.modelCall), transcript: response.transcript }));
  // 删除时机（设计决策 B）：checkpoint 写入后清 pending。中断由循环层（callModel）触发，
  // 抛异常时本行不执行，pending 文件保留未回执轮次供恢复；正常完成时必被清理。
  await clearPendingTranscript(projectRoot, state.current_chapter_no, segmentNo);
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
  if (factCheck?.conflicts?.length) {
    // ADR-0001：任何 fact-check 冲突都进 needs_revision，conflicts 作为 feedback 喂回写作循环。
    // 不再区分 hard/soft——砍掉自动修复后，soft 模式也必须走反思循环，不能静默放过。
    // ADR-0001 决策 4/5：硬上限 3 轮防无限循环，达上限软降级 block 本章交用户。
    const fcBudget = withBudgetDefaults(state);
    const fcKey = String(state.current_chapter_no);
    const fcRounds = fcBudget.fact_check_rounds_by_chapter[fcKey] ?? 0;
    if (fcRounds >= fcBudget.max_fact_check_rounds_per_chapter) {
      await blockFactCheckUnresolved(projectRoot, project, state, factCheck.conflicts, fcRounds);
      return;
    }
    // 决策 6：读取上次冲突数，用于进展提示（冲突数没减少 -> 告诉模型换思路）
    const fcLastCount = fcBudget.last_fact_check_conflict_count_by_chapter?.[fcKey] ?? null;
    const stateWithRound = {
      ...state,
      active_budget: {
        ...fcBudget,
        fact_check_rounds_by_chapter: { ...fcBudget.fact_check_rounds_by_chapter, [fcKey]: fcRounds + 1 },
        last_fact_check_conflict_count_by_chapter: { ...fcBudget.last_fact_check_conflict_count_by_chapter, [fcKey]: factCheck.conflicts.length }
      }
    };
    await applyFactCheckConflicts(projectRoot, project, stateWithRound, factCheck.conflicts, fcRounds + 1, fcLastCount);
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
  // 恢复检测：与 draftNextSegment 一致，pending 存在即续写（未回执轮次由循环层裁剪）
  const pendingData = await readPendingTranscript(projectRoot, budgetedState.current_chapter_no, segmentNo);
  const restoredTranscript = pendingData ? ToolTranscript.restore(pendingData) : null;
  const response = await runWritingAgentLoop(projectRoot, project, budgetedState, runtime, {
    kind: gate.status === "failed" ? "revision_shortfall" : "revision_quality_gate",
    project_id: project.project_id,
    chapter_no: budgetedState.current_chapter_no,
    segment_no: segmentNo,
    shortfall: Math.max(gate.shortfall ?? 0, 300),
    quality_gate_failures: qualityGateFailures,
    signal: options.signal,
    allowed_tools: REVISING_ALLOWED_TOOLS,
    ...(restoredTranscript ? { restored_transcript: restoredTranscript } : {})
  });
  const latestState = await loadState(projectRoot);
  const next = setStage({ ...latestState, current_segment_no: segmentNo }, "reviewing");
  await saveState(projectRoot, next);
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next, [response.toolCall], [response.result], null, { ...checkpointModelExtras(response.modelCall), transcript: response.transcript }));
  // 设计决策 B：checkpoint 写入后清 pending（正常完成不留残留；中断时文件保留供恢复）
  await clearPendingTranscript(projectRoot, budgetedState.current_chapter_no, segmentNo);
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

  // ADR-0001：修改权还给模型。runFactCheck 只负责“发现问题 + 通知”，
  // 不再自动 indexOf+replace 改正文。conflicts 返回给上层（reviewChapter），
  // 由 reviewChapter 进 needs_revision、把 conflicts 作为 feedback 喂回写作循环，
  // 模型用 edit_chapter 自己改。砍掉“只改第一个”“长引文跳过”两个 bug 的根源。
  return { conflicts };
}

// ADR-0001：fact-check 发现冲突 -> 进 needs_revision，conflicts 作为 feedback 喂回写作循环。
// 模型在 revise 阶段看到 fact-check-gate 的 conflicts，用 edit_chapter 自己改，回 reviewing 再验证。
// 不再区分 hard/soft：任何冲突都走反思循环，由进展检测 + 软降级兜底（见 runWritingAgentLoop）。
export async function applyFactCheckConflicts(projectRoot, project, state, conflicts, rounds, lastConflictCount) {
  // 决策 6：第二轮起，冲突数没减少时加 progress_hint 让模型换思路（而非重复同样改法）
  const progressHint = (rounds && rounds > 1 && lastConflictCount !== null && lastConflictCount <= conflicts.length)
    ? `上次报 ${lastConflictCount} 个冲突，这次仍 ${conflicts.length} 个——之前的修改未减少冲突，请换一种改法（如调整上下文、改前后文衔接，而非只改引文本身）。`
    : null;
  const gate = { gate: "fact-check-gate", status: "failed", conflicts, rounds: rounds ?? 1, progress_hint: progressHint };
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
    message: `fact-check 发现 ${conflicts.length} 个设定冲突，进 needs_revision 让模型修订`,
    data: gate
  });
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next));
  await appendFailureCard(projectRoot, state, { type: "quality_gate_failed", message: "fact-check gate failed", data: gate });
}

// ADR-0001 决策 5：fact-check 冲突达到硬上限（3 轮）仍有冲突 -> 软降级。
// 不静默放过、不硬改。block 本章（项目 paused），通知用户人工核对。
// 对标 Claude Code：跑不过测试就停下来问用户，绝不硬改糊弄。
async function blockFactCheckUnresolved(projectRoot, project, state, conflicts, rounds) {
  const chapterNo = state.current_chapter_no;
  const note = `第 ${chapterNo} 章经 ${rounds} 轮修订仍有 ${conflicts.length} 个设定矛盾，模型无法自动解决。请人工核对正文与设定档案（continuity），修正后恢复项目。`;
  const next = setStage({
    ...state,
    project_status: "blocked",
    blocked_reason: "fact_check_unresolved",
    blocked_at: new Date().toISOString(),
    blocked_data: { conflicts, rounds }
  }, "blocked");
  await saveState(projectRoot, next);
  await upsertChapter(projectRoot, { chapter_no: chapterNo, status: "blocked" });
  await appendChatMessage(projectRoot, {
    role: "assistant", content: note, proactive: "fact_check", chapter_no: chapterNo
  });
  await appendEvent(projectRoot, {
    type: "project_blocked",
    project_id: project.project_id,
    chapter_no: chapterNo,
    stage: "reviewing",
    severity: "error",
    message: `fact-check 软降级：${conflicts.length} 个设定矛盾 ${rounds} 轮未解决，需人工核对`,
    data: { reason: "fact_check_unresolved", conflicts, rounds }
  });
  await appendFailureCard(projectRoot, state, { type: "fact_check_unresolved", message: note, data: { conflicts, rounds } });
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next, [], [], { code: "fact_check_unresolved", data: { conflicts, rounds } }));
  throw new ProjectBlockedError("fact_check_unresolved");
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
          data: { attempt: info.attempt, maxAttempts: info.maxAttempts, delay: info.delay, reason: info.reason, model: info.model }
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
  let compiledPrompt;
  let cacheEntry;
  if (request.transcript_messages) {
    // 多轮 transcript 轮次（写作 agent 循环第 2+ 轮）：跳过章节 prompt 编译与 cacheKeyManager 更新，
    // messages 直接用上一轮落盘/内存的 transcript，prompt 为空串（编译产物不参与后续轮）。
    compiledPrompt = { prompt: null, templateVersion: "transcript", stableHash: null, blockHashes: {}, skillHooks: [] };
    cacheEntry = { cacheKey: null, cacheVersion: null };
  } else {
    compiledPrompt = await compileChapterPrompt(projectRoot, project, state, request, runtime);
    cacheEntry = runtime.cacheKeyManager.update({
      projectId: project.project_id,
      templateVersion: compiledPrompt.templateVersion,
      stableHash: compiledPrompt.stableHash
    });
  }
  await appendEvent(projectRoot, {
    type: "model_call_started",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: state.current_stage,
    message: "model gateway call started",
    data: {
      request_kind: request.kind,
      attempt: request.attempt,
      cache_key: cacheEntry.cacheKey,
      multi_turn: Boolean(request.transcript_messages)
    }
  });
  if (request.kind === "revision_shortfall") {
    runtime.modelClient.costTracker?.recordRefill?.();
  }
  const gatewayResult = await runtime.modelClient.generate({
    project,
    stage: state.current_stage,
    prompt: compiledPrompt.prompt ?? "",
    messages: request.transcript_messages ?? [],
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
  // transcript 轮次（cacheKey 为 null）不写幻影 last_call（templateVersion:"transcript" 全 null 对象），
  // 传 null 让 writeCacheReport 落 last_call:null，不覆盖真实缓存记录。
  const cacheReport = await writeCacheReport(projectRoot, {
    manager: runtime.cacheKeyManager,
    cacheEntry: cacheEntry.cacheKey ? cacheEntry : null,
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
    context_package_hash: request.transcript_messages ? null : sha256(compiledPrompt.prompt),
    prompt_block_hashes: compiledPrompt.blockHashes,
    stable_hash: compiledPrompt.stableHash,
    dynamic_hash: compiledPrompt.dynamicHash ?? null,
    cache_key: cacheEntry.cacheKey,
    cache_version: cacheEntry.cacheVersion,
    model_config: gatewayResult.modelConfig,
    usage_report: gatewayResult.usageReport,
    cost_summary: gatewayResult.costSummary,
    cache_report: cacheReport.last_call,
    skill_hooks: compiledPrompt.skillHooks ?? [],
    output_type: output?.type ?? null,
    // 首轮编译 prompt 原文：callModel 借此装入 transcript（首条 user 消息），
    // 后续 transcript 轮次为 null。
    compiled_prompt: compiledPrompt.prompt,
    // 原始响应：callModel 借此提取 assistant 消息（tool_calls/reasoning_content）装入 transcript。
    // 不影响既有字段（checkpointModelExtras 只挑固定字段落 checkpoint）。
    raw: gatewayResult.raw
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

export async function compileChapterPrompt(projectRoot, project, state, request, runtime) {
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
            ? "你可以用工具（list_chapters / read_chapter / read_continuity / read_outline / get_status）查前文与设定，"
              + "也可以用 edit_chapter 修改已写部分、update_continuity/update_outline 修订设定或大纲。"
              + "准备好后，直接输出章节正文文字即可提交，不需要特地调用工具。"
              + "一次只调用一个工具，工具结果会回给你继续下一步。"
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

// 解析模型一轮返回的全部 tool_calls(并行 function calling)。
// 写作 agent 循环需要全部执行并回填,保证 transcript 里每个 tool_call 都有对应 role=tool 结果
// (OpenAI/DeepSeek 硬性契约:tool_calls 与 tool 结果必须 1:1,否则下一轮 400)。
function parseOpenAIToolCalls(raw) {
  const message = raw?.choices?.[0]?.message;
  if (!Array.isArray(message?.tool_calls) || message.tool_calls.length === 0) {
    return [];
  }
  return message.tool_calls.map((tc) => {
    if (!tc) return null;
    return {
      type: "tool_call",
      id: tc.id ?? null,
      tool: tc.function?.name ?? tc.name ?? null,
      input: parseToolCallArguments(tc.function?.arguments ?? tc.arguments)
    };
  }).filter(Boolean);
}

// 写作 agent 循环(runWritingAgentLoop)每轮的主 output 取首个 tool_call(向后兼容)。
// 其余 tool_call 由 runWritingAgentLoop 的 executeTool 回调在本轮内顺序执行+回填(Task 2)。
function parseOpenAIToolCall(raw) {
  const calls = parseOpenAIToolCalls(raw);
  if (calls.length > 0) {
    return calls[0];
  }
  const message = raw?.choices?.[0]?.message;
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

// 从模型网关返回结果中提取 assistant 消息（OpenAI-compatible 格式），
// 用于装入 ToolTranscript 供下一轮回放。content 为空串时归一为 null，
// 保证 appendAssistant 不会写入空 content 字段。
function extractAssistantMessage(modelCall) {
  const message = modelCall?.raw?.choices?.[0]?.message ?? {};
  return {
    content: typeof message.content === "string" && message.content ? message.content : null,
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : null,
    reasoning_content: typeof message.reasoning_content === "string" ? message.reasoning_content : null
  };
}

// 恢复裁剪：pending 文件可能落在「模型已决策、工具未执行」的崩溃窗口；检查所有 assistant
// 轮次的 tool_calls 是否全部有对应 role=tool 结果，从首个不完整轮次(含 side 部分回填的
// 崩溃窗口:主+side1 已回填、side2 未回填)起裁剪，让模型从最后一个完整轮次重新决策，
// 避免 tool_calls 无结果的非法消息形状（真实 API 会 400）。原版只看尾部连续 assistant,
// 会漏判"尾部是 tool 但前面 assistant 有悬空"。
export function trimUnresolvedAssistantTurns(transcript) {
  const messages = transcript.messages;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      continue;
    }
    const allResolved = msg.tool_calls.every((tc) => {
      if (!tc.id) return true; // null id 不算悬空(与 pendingToolCalls 一致)
      return messages.slice(i + 1).some((m) => m.role === "tool" && m.tool_call_id === tc.id);
    });
    if (!allResolved) {
      messages.length = i; // 裁剪此 assistant 及之后所有消息
      return;
    }
  }
}

// transcript 持久化：每轮工具执行后写 pending 文件，成功完成时删除。
// 中断（throw/崩溃）时 pending 文件已落盘，恢复时读它续写。
// 文件命名对齐 §3.6 pending-extraction 模式（memory/.pending-*.json）。
const pendingTranscriptPath = (projectRoot, chapterNo, segmentNo) =>
  safeJoin(projectRoot, "memory", `.pending-transcript-${chapterNo}-${segmentNo}.json`);

async function writePendingTranscript(projectRoot, chapterNo, segmentNo, transcript) {
  await writeJsonAtomic(pendingTranscriptPath(projectRoot, chapterNo, segmentNo), transcript.serialize());
}

async function readPendingTranscript(projectRoot, chapterNo, segmentNo) {
  try {
    return await readJson(pendingTranscriptPath(projectRoot, chapterNo, segmentNo), null);
  } catch {
    // 损坏的 pending 文件视为无 pending：恢复走全新编译，不硬失败恢复流程
    return null;
  }
}

async function clearPendingTranscript(projectRoot, chapterNo, segmentNo) {
  await fs.unlink(pendingTranscriptPath(projectRoot, chapterNo, segmentNo)).catch(() => {});
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

// =============== 写作 agent 循环（Pi 风格 session 架构） ===============
// 核心原则：模型输出的文字本身就是正文。工具（read/edit/update）是辅助手段，
// 不是强制出口。模型可以自然地"读 → 想 → 写"，不需要通过特定工具才能提交内容。
//
// 两种提交方式等价：
//   1. 直接输出正文文字 → 系统捕获为章节内容（主要路径）
//   2. 调用 append_chapter_segment 工具 → 通过参数提交（兼容路径）
//
// 控制平面在 WritingAgentSession（writing-agent-session.mjs）：
//   连续 3 次只读工具 → 下一轮自动切换 commit-only（agent_loop_commit_only 事件）；
//   编辑/更新工具成功后计数清零、白名单还原。
// 兜底：连续 COMMIT_FAILURES 次无效输出 → model_output_invalid；
//       24 轮耗尽 → agent_loop_exhausted（仅兜底，正常 1-5 轮内提交退出）。
const WRITING_AGENT_MAX_TURNS = 24;
const WRITING_AGENT_COMMIT_FAILURES = 8;
const WRITING_AGENT_MIN_PROSE_CHARS = 50; // 文本输出少于此值视为无效，不算正文

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
  // 持久化前剥掉 raw（完整网关响应）与 compiled_prompt（完整 prompt）：它们只用于循环内
  // transcript 提取，整包写入 agent_state 会让 blocked_data 膨胀。字段名保持原样。
  const persistableModelCall = lastModelCall
    ? (({ raw, compiled_prompt, ...rest }) => rest)(lastModelCall)
    : null;
  await blockProject(projectRoot, project, state, reason, {
    last_validation: lastValidation,
    last_model_call: persistableModelCall,
    allowed_tools: allowedTools
  }, { skipFailureCard: true });
  // 故障卡类型用 project_blocked + data.code，让 classifyKind 按 reason 归类
  // （agent_loop_exhausted / model_output_invalid -> loop-exhausted，
  // 不再统一标"工具调用被拒"误导用户）。
  await appendFailureCard(projectRoot, state, {
    type: "project_blocked",
    message: lastValidation?.message ?? reason,
    data: { tool: lastModelCall?.output?.tool ?? null, code: reason }
  });
}

// 情况 A/C 公共出口：校验 → tool_call_requested → executeToolCall。
// 校验失败保持旧 C 路径事件语义（quality_gate_failed + tool_call_rejected），
// 并按提交失败计数，达到上限由 stopRun 触发 model_output_invalid 终态。
async function executeCommit(projectRoot, project, state, runtime, request, toolCall, attempt, emitLoopEvent, setValidation, rejectOutput) {
  const validation = assertToolCallForChapter(toolCall, {
    project_id: request.project_id,
    chapter_no: request.chapter_no,
    segment_no: request.segment_no,
    allowedTools: ["append_chapter_segment"]
  });
  setValidation(validation);
  if (!validation.ok) {
    await emitLoopEvent("quality_gate_failed", {
      code: validation.code, attempt, message: validation.message, severity: "warn"
    });
    const stop = await rejectOutput(validation.code, {
      attempt, message: validation.message, severity: "warn"
    });
    return { ok: false, summary: validation.code, ...(stop ?? {}) };
  }
  await emitLoopEvent("tool_call_requested", { tool: "append_chapter_segment", attempt });
  const result = await executeToolCall(projectRoot, project, state, toolCall, {
    expectedChapterNo: state.current_chapter_no,
    expectedSegmentNo: request.segment_no
  });
  return { ok: true, committed: true, result: { toolCall, modelCall: null, result } };
}

// 写作 agent 循环：领域适配层，驱动 WritingAgentSession 完成一个章节段/修订轮。
async function runWritingAgentLoop(projectRoot, project, state, runtime, request) {
  const allowedTools = request.allowed_tools ?? ["append_chapter_segment"];
  const registry = buildWritingRegistry();
  let agentLoopFeedback = null;
  let lastValidation = null;
  let lastModelCall = null;
  let commitFailures = 0;

  const emitLoopEvent = (type, data = {}) =>
    appendEvent(projectRoot, {
      type,
      project_id: project.project_id,
      chapter_no: request.chapter_no,
      stage: state.current_stage,
      severity: data.severity ?? null,
      message: data.message ?? null,
      data,
    });

  const rejectOutput = async (code, extra = {}) => {
    commitFailures += 1;
    await emitLoopEvent("tool_call_rejected", { code, ...extra });
    if (commitFailures >= WRITING_AGENT_COMMIT_FAILURES) {
      return { stopRun: { outcome: "failed", reason: "model_output_invalid" } };
    }
    return null;
  };

  // transcript：首轮编译 prompt 装入后，后续轮次直接回放 transcript 消息链，
  // 不再重新编译章节 prompt（transcript_messages 走 runModelGatewayCall 的跳过分支）。
  // 崩溃恢复时由调用方（draftNextSegment/reviseChapter）读 pending 文件恢复后传入。
  const transcript = request.restored_transcript ?? new ToolTranscript();
  if (request.restored_transcript) {
    // 恢复裁剪：pending 可能落在「模型已决策、工具未执行」的崩溃窗口，
    // 尾部未回执的 assistant tool_calls 轮次裁剪掉，模型恢复后重新决策。
    trimUnresolvedAssistantTurns(transcript);
  }

  // 本轮模型返回的全部 tool_calls(并行 function calling)。callModel 设置,executeTool 消费。
  // 主 output(loop 传入 executeTool 的首个)由 dispatchSingleToolCall 执行;
  // 剩余由 executeTool 回调末尾的 side 段执行+回填。
  let thisTurnToolCalls = [];

  // 原 executeTool 回调内的回执 helper(用 transcript 闭包),上移到 runWritingAgentLoop 体内供 dispatchSingleToolCall + side 段共用。
  const recordToolReceipt = async (toolCallId, result) => {
    transcript.appendToolResult(toolCallId, result);
    await writePendingTranscript(projectRoot, request.chapter_no, request.segment_no, transcript);
  };
  // 拒绝/失败反馈写入 transcript（反馈喂回，替代旧设计里编译 prompt 中的 agent_loop_feedback）：
  // - 带 tool_call id（原生 tool_calls 路径）：记 role=tool 回执，保持消息链形状合法
  //   （assistant tool_calls 必须有对应 tool 结果，否则真实 API 会拒绝请求）；
  // - 无 id（系统/mock 路径）：记 user 反馈消息。
  // 写入后落盘 pending，中断恢复时反馈不丢。
  const recordRejectionFeedback = async (toolCallId, message) => {
    if (toolCallId) {
      await recordToolReceipt(toolCallId, { ok: false, error: message });
    } else {
      transcript.appendUser(message);
      await writePendingTranscript(projectRoot, request.chapter_no, request.segment_no, transcript);
    }
  };

  // 主 output 分派:原 executeTool 回调的 4 情况(A/B/C/D)原样搬入,return 不变。
  // 闭包捕获 rejectOutput/commitFailures/lastValidation/agentLoopFeedback/registry/executeCommit/
  // checkToolPermission/summarizeToolResult/emitLoopEvent 等(均在本作用域)。
  const dispatchSingleToolCall = async (output, ctx) => {
    // === 以下为原 executeTool 回调体的 1:1 搬运,不改逻辑 ===
    // 情况 A：模型直接输出正文文本。
    if (!output || output.type !== "tool_call") {
      const prose = (output?.message ?? output?.text ?? "").trim();
      if (prose.length < WRITING_AGENT_MIN_PROSE_CHARS) {
        agentLoopFeedback = { message: "输出过短。请调用 append_chapter_segment 提交完整正文。" };
        const stop = await rejectOutput("output_too_short", {
          attempt: ctx.turn,
          char_count: prose.length,
          message: `Output too short (${prose.length} chars, min ${WRITING_AGENT_MIN_PROSE_CHARS}).`,
          severity: "warn",
        });
        await recordRejectionFeedback(null, agentLoopFeedback.message);
        return { ok: false, summary: "output_too_short", ...(stop ?? {}) };
      }
      const wrapped = { type: "tool_call", tool: "append_chapter_segment",
        input: { project_id: request.project_id, chapter_no: request.chapter_no,
          segment_no: request.segment_no, content: prose } };
      return executeCommit(projectRoot, project, state, runtime, request, wrapped, ctx.turn, emitLoopEvent, (v) => { lastValidation = v; }, rejectOutput);
    }
    // 情况 B：工具不在当前白名单（commit-only 期间调用只读工具也落此分支）。
    if (!ctx.allowedTools.includes(output.tool)) {
      agentLoopFeedback = { message: `当前只允许调用：${ctx.allowedTools.join(", ")}。请直接提交正文。` };
      const stop = await rejectOutput("tool_not_allowed", {
        attempt: ctx.turn,
        tool: output.tool,
        message: `Unsupported tool for chapter writing: ${output.tool ?? "missing"}`,
        severity: "warn",
      });
      await recordRejectionFeedback(output.id, agentLoopFeedback.message);
      return { ok: false, summary: "tool_not_allowed", ...(stop ?? {}) };
    }
    // 情况 C：提交工具。执行成功后把 tool 回执装入 transcript 并落盘 pending 文件；
    // 恢复场景下 append_chapter_segment 按 segment 号幂等去重，重放不会重复写。
    if (output.tool === "append_chapter_segment") {
      const result = await executeCommit(projectRoot, project, state, runtime, request, output, ctx.turn, emitLoopEvent, (v) => { lastValidation = v; }, rejectOutput);
      if (output.id) {
        if (result?.ok) {
          await recordToolReceipt(output.id, result.result ?? { ok: true });
        } else {
          // 校验失败（如 output 校验不过）也要回执：否则下一轮 transcript 含
          // tool_calls 无结果的非法消息形状（真实 API 400），与「assistant tool_calls
          // 全部有回执」的裁决相悖。error 用 executeCommit 返回的校验错误码。
          await recordToolReceipt(output.id, { ok: false, error: result?.summary ?? "validation_failed" });
        }
      }
      return result;
    }
    // 情况 D：白名单内 read/edit/update，经注册表执行。
    const tool = registry.get(output.tool);
    if (!tool) {
      agentLoopFeedback = { message: `工具 ${output.tool} 未注册。` };
      const stop = await rejectOutput("unknown_tool", {
        attempt: ctx.turn,
        tool: output.tool,
        message: `工具 ${output.tool} 未注册。`,
        severity: "warn",
      });
      await recordRejectionFeedback(output.id, agentLoopFeedback.message);
      return { ok: false, summary: "unknown_tool", ...(stop ?? {}) };
    }
    const startedAt = Date.now();
    try {
      const permission = checkToolPermission(tool, project.tool_permissions ?? {}, {
        archived: Boolean(project.archived_at)
      });
      if (!permission.allowed) {
        // 权限拒绝也计入提交失败：连续 WRITING_AGENT_COMMIT_FAILURES 次拒绝
        // → stopRun（model_output_invalid），不再空转到 24 轮耗尽。
        // 事件形状与现网一致：tool_call_rejected data = { code, tool, attempt, message, severity }。
        agentLoopFeedback = { message: `工具 ${output.tool} 被拒绝：${permission.message}` };
        const stop = await rejectOutput("permission_denied", {
          attempt: ctx.turn,
          tool: output.tool,
          message: permission.message,
          severity: "warn",
        });
        await recordRejectionFeedback(output.id, agentLoopFeedback.message);
        return { ok: false, summary: "permission_denied", ...(stop ?? {}) };
      }
      const toolResult = await tool.run(output.input ?? {}, { projectRoot, project, server: { runJobs: new Map() } });
      commitFailures = 0;
      const summary = summarizeToolResult(toolResult);
      await emitLoopEvent("agent_loop_tool_executed", {
        tool: output.tool, attempt: ctx.turn,
        duration_ms: Date.now() - startedAt, result_summary: summary,
      });
      agentLoopFeedback = { message: `工具 ${output.tool} 结果：${summary}` };
      if (output.id) {
        // 原生 tool_calls 带 id 才记 transcript（情况 A 的系统包装调用无 id，不进 transcript）。
        await recordToolReceipt(output.id, toolResult);
      }
      return { ok: true, readOnly: tool.kind === "read", summary };
    } catch (error) {
      await emitLoopEvent("agent_loop_tool_failed", {
        tool: output.tool, attempt: ctx.turn,
        error: error?.message ?? String(error), duration_ms: Date.now() - startedAt,
        message: `agent loop tool ${output.tool} failed: ${error?.message ?? error}`,
        severity: "warn",
      });
      agentLoopFeedback = { message: `工具 ${output.tool} 执行失败：${error?.message ?? error}` };
      if (output.id) {
        // 失败也把回执（{ok:false,error}）装入 transcript，让下一轮模型知道发生了什么。
        await recordToolReceipt(output.id, { ok: false, error: error?.message ?? String(error) });
      } else {
        await recordRejectionFeedback(null, agentLoopFeedback.message);
      }
      return { ok: false, summary: "tool_error" };
    }
    // === 搬运结束 ===
  };

  const session = new WritingAgentSession({
    allowedTools,
    commitTool: "append_chapter_segment",
    maxConsecutiveReads: 3,
    maxTurns: WRITING_AGENT_MAX_TURNS,
    emitEvent: emitLoopEvent,
    callModel: async (ctx) => {
      await consumeModelCallBudget(projectRoot, project, state, {
        request_kind: request.kind,
        attempt: ctx.turn,
        agent_loop: true
      });
      const isFirstTurn = ctx.turn === 1 && !request.restored_transcript;
      const modelCall = await runModelGatewayCall(
        projectRoot, project, state, runtime,
        {
          ...request,
          correction_attempt: !isFirstTurn,
          validation_feedback: lastValidation,
          agent_loop_feedback: agentLoopFeedback,
          allowed_tools: ctx.allowedTools,
          attempt: ctx.turn,
          ...(isFirstTurn ? {} : { transcript_messages: transcript.toMessages() })
        },
      );
      if (isFirstTurn) {
        // 首轮编译产物装入 transcript 首条 user 消息，后续轮次不再携带编译 prompt。
        transcript.appendUser(modelCall.compiled_prompt);
      }
      // 不变式校验:本轮 modelCall 决策后、落盘前,transcript 不应有上一轮残留的悬空 tool_call
      // (无对应 role=tool 结果的 tool_call)。须在 appendAssistant 之前检查——本轮自己的
      // tool_calls 尚未回填,若计入会把每轮都误判为违例;此处只看上一轮执行后残留。
      // 崩溃恢复首帧由 trimUnresolvedAssistantTurns 兜底,正常路径每轮 side 执行后
      // pendingToolCalls 应为空。违例只记 warn 不阻断。
      const dangling = transcript.pendingToolCalls;
      if (dangling.length > 0) {
        await emitLoopEvent("agent_loop_transcript_invariant_violation", {
          turn: ctx.turn,
          dangling_count: dangling.length,
          dangling_tools: dangling.map((tc) => tc.function?.name ?? tc.name ?? tc.tool),
          severity: "warn",
          message: `transcript 含 ${dangling.length} 个悬空 tool_call(无对应 tool 结果),下一轮请求可能被 API 拒绝`
        });
      }
      transcript.appendAssistant(extractAssistantMessage(modelCall));
      thisTurnToolCalls = parseOpenAIToolCalls(modelCall.raw); // 本轮全部 tool_calls(side 执行用)
      // 每次模型决策后无条件落盘 pending：覆盖「模型已决策、工具未执行」的崩溃窗口，
      // 保证磁盘上的 pending 可能含未回执的 tool_calls，恢复时才能真正续写。
      await writePendingTranscript(projectRoot, request.chapter_no, request.segment_no, transcript);
      // 循环层中断注入：决策已落盘后检查，抛异常时 pending 文件保留未回执轮次供恢复。
      if (
        request.simulate_interrupt_after &&
        request.simulate_interrupt_after.chapter_no === request.chapter_no &&
        request.simulate_interrupt_after.segment_no === request.segment_no
      ) {
        throw new SimulatedInterrupt("Simulated interruption mid agent loop");
      }
      lastModelCall = modelCall;
      return modelCall.output;
    },
    executeTool: async (output, ctx) => {
      // 主 output 分派:现有 4 情况逻辑(A/B/C/D)原样,return 不变
      let primaryResult = await dispatchSingleToolCall(output, ctx);
      // -- 并行 tool_calls 支持:本轮剩余 tool_calls 顺序执行+回填 --
      // 保证 transcript 里每个 tool_call.id 都有对应 role=tool 消息(OpenAI/DeepSeek 硬性契约)。
      // 主 output 是 commit(已 committed)时,剩余一律 skipped_after_commit(循环即将 stop)。
      // 否则顺序执行剩余:read/edit/update 执行+回填;遇到 append 则执行+回填+更新 primaryResult,其后 skipped。
      // 与主 output 分派(情况 B/D)的刻意分歧:side 段失败(tool_not_allowed 对应情况 B、
      // permission_denied/unknown_tool/tool 异常对应情况 D)不计 commitFailures、不更新
      // agentLoopFeedback、不走 rejectOutput——
      // stopRun 升级只对主 output 决策生效,避免一次多工具轮次的 side 失败误触发整体 stopRun;
      // 模型仍可从 transcript 的 role=tool 回执(含 error)推断。
      const sideCalls = thisTurnToolCalls.slice(1); // 主 output(thisTurnToolCalls[0])已执行
      thisTurnToolCalls = [];
      for (const tc of sideCalls) {
        if (primaryResult?.committed) {
          if (tc.id) await recordToolReceipt(tc.id, { ok: false, error: "skipped_after_commit" });
          continue;
        }
        if (!ctx.allowedTools.includes(tc.tool)) {
          if (tc.id) await recordToolReceipt(tc.id, { ok: false, error: "tool_not_allowed" });
          continue;
        }
        if (tc.tool === "append_chapter_segment") {
          const sideResult = await executeCommit(projectRoot, project, state, runtime, request, tc, ctx.turn, emitLoopEvent, (v) => { lastValidation = v; }, rejectOutput);
          if (tc.id) {
            await recordToolReceipt(tc.id, sideResult?.ok ? (sideResult.result ?? { ok: true }) : { ok: false, error: sideResult?.summary ?? "validation_failed" });
          }
          if (sideResult?.committed) { primaryResult = sideResult; }
          continue;
        }
        const sideTool = registry.get(tc.tool);
        if (!sideTool) {
          if (tc.id) await recordToolReceipt(tc.id, { ok: false, error: "unknown_tool" });
          continue;
        }
        try {
          const sidePerm = checkToolPermission(sideTool, project.tool_permissions ?? {}, { archived: Boolean(project.archived_at) });
          if (!sidePerm.allowed) {
            if (tc.id) await recordToolReceipt(tc.id, { ok: false, error: "permission_denied" });
            continue;
          }
          const sideToolResult = await sideTool.run(tc.input ?? {}, { projectRoot, project, server: { runJobs: new Map() } });
          await emitLoopEvent("agent_loop_tool_executed", { tool: tc.tool, attempt: ctx.turn, result_summary: summarizeToolResult(sideToolResult) });
          if (tc.id) await recordToolReceipt(tc.id, sideToolResult);
        } catch (error) {
          await emitLoopEvent("agent_loop_tool_failed", { tool: tc.tool, attempt: ctx.turn, error: error?.message ?? String(error), severity: "warn" });
          if (tc.id) await recordToolReceipt(tc.id, { ok: false, error: error?.message ?? String(error) });
        }
      }
      return primaryResult;
    },
  });

  const run = await session.start({ signal: request.signal });
  if (run.outcome === "completed") {
    // 注意：pending 文件不在本函数删除，由调用方（draftNextSegment/reviseChapter）
    // 在 checkpoint 与中断检查之后删除——保证中断时 pending 文件仍在，可恢复续写。
    return { ...run.result, modelCall: lastModelCall, transcript: transcript.serialize() };
  }
  if (run.outcome === "aborted") {
    // 保持旧行为：循环中抛 ProjectCancelledError → runProject 标记 cancelled 而非 interrupted。
    throw new ProjectCancelledError(request.signal?.reason ?? "cancelled");
  }
  // failed/exhausted：不删 pending 文件（保留供恢复），走现有 failWritingAgentLoop
  const reason = run.reason ?? "agent_loop_exhausted";
  await failWritingAgentLoop(projectRoot, project, state, reason, lastValidation, lastModelCall, allowedTools);
  throw new ProjectBlockedError(reason);
}

// 统一的故障卡落账 helper：消除 reviewChapter / executeToolCall / blockProject 等处的重复 try/catch。
async function appendFailureCard(projectRoot, state, { type, message, data }) {
  try {
    const fresh = await loadState(projectRoot).catch(() => state);
    // §4.5: 从 run_log 计算该 segment 连续 quality_gate_failed 次数
    let consecutiveFailures = 0;
    if (type === 'quality_gate_failed') {
      consecutiveFailures = await countConsecutiveQualityGateFailures(projectRoot, state.current_chapter_no);
    }
    const card = deriveFailureCard({
      id: `flr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      chapter_no: state.current_chapter_no,
      message,
      ts: new Date().toISOString(),
      data
    }, fresh, { consecutiveFailures });
    appendFailure(projectRoot, card);
  } catch (err) {
    console.warn("appendFailure failed:", err.message);
  }
}

// §4.5: 从事件日志尾部读取并统计同一 chapter 的 quality_gate_failed 事件总数
// 不再要求严格连续——interleaved 事件（如 stage_started、model_call_completed）不打断计数。
async function countConsecutiveQualityGateFailures(projectRoot, chapterNo) {
  try {
    const recent = await tailEvents(projectRoot, 100);
    let count = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i];
      if (e.type === 'quality_gate_failed' && e.chapter_no === chapterNo) {
        count++;
      } else if (e.type === 'quality_gate_failed') {
        // 不同章节重置计数
        count = 0;
      }
      // interleaved 事件（stage_started, model_call 等）不打断计数，继续向前扫描
    }
    return count;
  } catch {
    return 0;
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
    // ADR-0001 决策 4：fact-check 反思循环硬上限，防无限循环（默认 revision budget 为 null 时兜底）
    fact_check_rounds_by_chapter: {},
    max_fact_check_rounds_per_chapter: 3,
    // 决策 6：跟踪上次冲突数，用于进展提示（冲突数没减少 -> 告诉模型换思路）
    last_fact_check_conflict_count_by_chapter: {},
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
    // transcript 备份：写作 agent 循环成功完成时的消息链序列化（恢复主路径是 pending 文件）
    transcript: extras.transcript ?? null,
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
