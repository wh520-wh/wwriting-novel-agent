import { appendEvent, readEvents } from "./event-log.mjs";
import { CacheKeyManager, writeCacheReport } from "./cache-key-manager.mjs";
import { loadConfigLayers } from "./config-runtime.mjs";
import { CostTracker } from "./cost-tracker.mjs";
import { readJson, safeJoin, sha256, writeFileAtomic } from "./fs-utils.mjs";
import { ModelClient } from "./model-client.mjs";
import { loadProject, loadState, saveState, upsertChapter, writeCheckpoint } from "./project-store.mjs";
import { MockModel } from "./mock-model.mjs";
import { MockProviderAdapter, OpenAICompatibleAdapter } from "./provider-adapters.mjs";
import { PromptCompiler } from "./prompt-compiler.mjs";
import { assertToolCallForChapter, runWordCountGate } from "./quality-gates.mjs";
import { collectSkillPromptHooks, runPostProcessHooks, runSkillChecks } from "./skill-runtime.mjs";
import { appendChapterSegment, chapterFileName, finalizeChapterFile, readDraft, ToolValidationError } from "./tool-runtime.mjs";
import { buildContinuityPromptContext, recordChapterMemory } from "./chapter-memory.mjs";
import { loadOutputStyles } from "./output-style-loader.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import { appendFailure } from "./failures-store.mjs";
import { deriveFailureCard } from "./derive-failure-card.mjs";
import { emit, CORE_EVENTS } from "./event-bus.mjs";

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

export class ProjectCancelledError extends Error {
  constructor(reason = "cancelled") {
    super(String(reason || "cancelled"));
    this.name = "ProjectCancelledError";
    this.reason = String(reason || "cancelled");
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

  state.project_status = "running";
  if (!state.current_stage || state.current_stage === "idle") {
    state.current_stage = "queued";
  }
  await saveState(projectRoot, state);
  await appendEvent(projectRoot, {
    type: "project_started",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: state.current_stage,
    message: "project run started or resumed"
  });

  try {
    for (let step = 0; step < (options.maxSteps ?? 500); step += 1) {
      throwIfAborted(options.signal);
      {
        const recentEvents = await readEvents(projectRoot, { limit: 5 });
        const recentResolve = recentEvents.find(e => e.type === "failure_resolved");
        if (recentResolve && recentResolve.message === "pause-here") {
          await appendEvent(projectRoot, {
            type: "project_paused",
            severity: "info",
            message: "用户在故障卡选择停在这里",
            data: { source: "failure_resolved", failureId: recentResolve.data?.failureId }
          });
          return;  // exit runProject
        }
      }
      state = await loadState(projectRoot);
      state.last_heartbeat = new Date().toISOString();
      await saveState(projectRoot, state);
      if (typeof options.onHeartbeat === "function") {
        await options.onHeartbeat({ step, stage: state.current_stage, chapter: state.current_chapter_no });
      }
      if (state.project_status === "blocked") {
        return { completed: false, blocked: true, projectRoot, reason: state.blocked_reason };
      }
      if (state.current_chapter_no > project.target_chapters) {
        state.project_status = "completed";
        state.current_stage = "completed";
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
          await enterPlanning(projectRoot, project, state);
          break;
        case "planning":
        case "planned":
          await enterDrafting(projectRoot, project, state);
          break;
        case "drafting":
          await draftNextSegment(projectRoot, project, state, runtime, options);
          break;
        case "reviewing":
          await reviewChapter(projectRoot, project, state);
          break;
        case "needs_revision":
        case "revising":
          await reviseChapter(projectRoot, project, state, runtime, options);
          break;
        case "finalizing":
          await finalizeChapter(projectRoot, project, state);
          break;
        case "summarizing":
          await completeChapter(projectRoot, project, state);
          break;
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
      state.current_stage = "blocked";
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

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw new ProjectCancelledError(signal.reason ?? "cancelled");
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

async function enterPlanning(projectRoot, project, state) {
  const stateBefore = { ...state };
  state.current_stage = "planning";
  await saveState(projectRoot, state);
  const skillPrompts = await collectSkillPromptHooks(projectRoot, project, "planning", {
    chapter_no: state.current_chapter_no,
    stage: "planning"
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
  state.current_stage = "planned";
  await saveState(projectRoot, state);
  await writeCheckpoint(projectRoot, checkpointPayload(project, stateBefore, state, [], [], null, { skill_hooks: skillPrompts.hooks }));
}

async function enterDrafting(projectRoot, project, state) {
  const stateBefore = { ...state };
  state.current_stage = "drafting";
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
    const next = { ...state, current_stage: "reviewing" };
    await saveState(projectRoot, next);
    await writeCheckpoint(projectRoot, checkpointPayload(project, state, next));
    return;
  }

  const segmentNo = state.current_segment_no + 1;
  const response = await requestChapterToolCall(projectRoot, project, state, runtime, {
    kind: "draft_segment",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    segment_no: segmentNo,
    segment_target_words: Math.max(900, Math.ceil(project.target_words_per_chapter / 3)),
    signal: options.signal
  });
  const result = await executeToolCall(projectRoot, project, state, response.toolCall, {
    expectedChapterNo: state.current_chapter_no,
    expectedSegmentNo: segmentNo
  });
  const latestState = await loadState(projectRoot);
  const next = { ...latestState, current_stage: "drafting", current_segment_no: segmentNo };
  await saveState(projectRoot, next);
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next, [response.toolCall], [result], null, checkpointModelExtras(response.modelCall)));

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

async function reviewChapter(projectRoot, project, state) {
  const draft = await readDraft(projectRoot, project, state.current_chapter_no);
  const gate = runWordCountGate(draft, project.min_words_per_chapter);
  if (gate.status === "failed") {
    const next = { ...state, current_stage: "needs_revision", last_quality_gate_results: [gate] };
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
    try {
      const fresh = await loadState(projectRoot).catch(() => state);
      const card = deriveFailureCard({
        id: `flr_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        type: 'quality_gate_failed',
        chapter_no: state.current_chapter_no,
        message: 'word-count gate failed',
        ts: new Date().toISOString(),
        data: gate
      }, fresh);
      appendFailure(projectRoot, card);
    } catch (err) { console.warn('appendFailure failed:', err.message); }
    return;
  }
  const skillGateResults = await runSkillChecks(projectRoot, project, "reviewing", {
    chapter_no: state.current_chapter_no,
    stage: "reviewing",
    content: draft
  });
  const failedSkillGates = skillGateResults.filter((result) => result.status === "failed");
  if (failedSkillGates.length > 0) {
    const qualityResults = [gate, ...skillGateResults];
    const next = { ...state, current_stage: "needs_revision", last_quality_gate_results: qualityResults };
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
    try {
      const fresh = await loadState(projectRoot).catch(() => state);
      const card = deriveFailureCard({
        id: `flr_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        type: 'quality_gate_failed',
        chapter_no: state.current_chapter_no,
        message: 'skill quality gate failed',
        ts: new Date().toISOString(),
        data: { failed_gates: failedSkillGates }
      }, fresh);
      appendFailure(projectRoot, card);
    } catch (err) { console.warn('appendFailure failed:', err.message); }
    return;
  }
  const next = { ...state, current_stage: "finalizing" };
  await saveState(projectRoot, next);
  await upsertChapter(projectRoot, {
    chapter_no: state.current_chapter_no,
    status: "finalizing",
    actual_words: gate.actual_words,
    quality_gate_results: [gate, ...skillGateResults]
  });
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next, [], [], null, { skill_gate_results: skillGateResults }));
}

async function reviseChapter(projectRoot, project, state, runtime, options = {}) {
  const budgetedState = await consumeRevisionBudget(projectRoot, project, state);
  const draft = await readDraft(projectRoot, project, budgetedState.current_chapter_no);
  const gate = runWordCountGate(draft, project.min_words_per_chapter);
  const segmentNo = budgetedState.current_segment_no + 1;
  const qualityGateFailures = budgetedState.last_quality_gate_results?.filter((result) => result.status === "failed") ?? [];
  const response = await requestChapterToolCall(projectRoot, project, budgetedState, runtime, {
    kind: gate.status === "failed" ? "revision_shortfall" : "revision_quality_gate",
    project_id: project.project_id,
    chapter_no: budgetedState.current_chapter_no,
    segment_no: segmentNo,
    shortfall: Math.max(gate.shortfall ?? 0, 300),
    quality_gate_failures: qualityGateFailures,
    signal: options.signal
  });
  const result = await executeToolCall(projectRoot, project, budgetedState, response.toolCall, {
    expectedChapterNo: budgetedState.current_chapter_no,
    expectedSegmentNo: segmentNo
  });
  const latestState = await loadState(projectRoot);
  const next = { ...latestState, current_stage: "reviewing", current_segment_no: segmentNo };
  await saveState(projectRoot, next);
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next, [response.toolCall], [result], null, checkpointModelExtras(response.modelCall)));
}

async function finalizeChapter(projectRoot, project, state) {
  const draft = await readDraft(projectRoot, project, state.current_chapter_no);
  const postProcess = await runPostProcessHooks(projectRoot, project, {
    chapter_no: state.current_chapter_no,
    stage: "post_process",
    content: draft
  });
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
  const result = await finalizeChapterFile(projectRoot, project, state.current_chapter_no);
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
  const next = { ...state, current_stage: "summarizing" };
  await saveState(projectRoot, next);
  await upsertChapter(projectRoot, {
    chapter_no: state.current_chapter_no,
    status: "summarizing",
    draft_path: result.draft_path,
    final_path: result.path,
    actual_words: result.actual_words,
    checksum: result.checksum
  });
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next, [], [result], null, { skill_hooks: postProcess.hooks, skill_gate_results: postProcess.results }));
}

async function completeChapter(projectRoot, project, state) {
  const nextChapter = state.current_chapter_no + 1;
  const next = {
    ...state,
    current_chapter_no: nextChapter,
    current_stage: nextChapter > project.target_chapters ? "completed" : "queued",
    current_segment_no: 0
  };
  await upsertChapter(projectRoot, {
    chapter_no: state.current_chapter_no,
    status: "completed"
  });
  await appendEvent(projectRoot, {
    type: "chapter_completed",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: "completed",
    message: "chapter completed"
  });
  await saveState(projectRoot, next);
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next));
}

async function createModelRuntime(projectRoot, project, options, fallbackModel) {
  const existingCost = await readJson(safeJoin(projectRoot, "cost.json"), null);
  const existingCacheReport = await readJson(safeJoin(projectRoot, "cache_report.json"), { entries: {} });
  const costTracker = options.costTracker ?? new CostTracker({ summary: existingCost });
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
        appendEvent(projectRoot, {
          type: "model_retry",
          severity: "warning",
          message: `模型调用重试 ${info.attempt}/${info.maxAttempts}（${info.reason}），等待 ${Math.round(info.delay)}ms`,
          data: { attempt: info.attempt, reason: info.reason, model: info.model }
        }).catch(() => {});
      }
    });
  return {
    modelClient,
    cacheKeyManager: options.cacheKeyManager ?? new CacheKeyManager({ entries: existingCacheReport.entries ?? {} })
  };
}

async function runModelGatewayCall(projectRoot, project, state, runtime, request) {
  throwIfAborted(request.signal);
  const compiledPrompt = await compileChapterPrompt(projectRoot, project, state, request);
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
  const gatewayResult = await runtime.modelClient.generate({
    project,
    stage: state.current_stage,
    prompt: compiledPrompt.prompt,
    signal: request.signal,
    metadata: {
      toolRequest: request,
      cacheKey: cacheEntry.cacheKey,
      cacheVersion: cacheEntry.cacheVersion
    }
  });
  throwIfAborted(request.signal);
  await emit(CORE_EVENTS.ModelCallComplete, {
    projectRoot,
    model: gatewayResult?.modelConfig?.model ?? "unknown",
    usage: gatewayResult?.usageReport ?? {},
    costTracker: runtime.modelClient.costTracker,
    options: { stage: state.current_stage, requestKind: request.kind, attempt: request.attempt }
  });
  if (runtime.modelClient.costTracker?.writeProjectReport) {
    await runtime.modelClient.costTracker.writeProjectReport(projectRoot);
  }
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

async function compileChapterPrompt(projectRoot, project, state, request) {
  const configuredVersion = project.prompt_template_versions?.drafting ?? "v1";
  const templateVersion = configuredVersion.startsWith("drafting.") ? configuredVersion : `drafting.${configuredVersion}`;
  const compiler = new PromptCompiler({ templateVersion });
  const [promptTemplate, bookSummary, draft, latestUserFeedback, planningSkillPrompts, stageSkillPrompts, continuityContext] = await Promise.all([
    readOptionalProjectText(projectRoot, "prompts", `${templateVersion}.md`),
    readOptionalProjectText(projectRoot, "memory", "book_summary.md"),
    readDraft(projectRoot, project, state.current_chapter_no),
    readLatestUserInstructions(projectRoot),
    collectSkillPromptHooks(projectRoot, project, "planning", {
      chapter_no: state.current_chapter_no,
      stage: "planning"
    }),
    collectSkillPromptHooks(projectRoot, project, state.current_stage, {
      chapter_no: state.current_chapter_no,
      stage: state.current_stage
    }),
    buildContinuityPromptContext(projectRoot, state.current_chapter_no)
  ]);
  const skillInstructions = [planningSkillPrompts.content, stageSkillPrompts.content].filter(Boolean).join("\n\n");
  const styleRules = [
    `Output format: ${project.output_format}. Minimum effective words per chapter: ${project.min_words_per_chapter}.`,
    "叙事连续性：第 2 章及以后必须承接上一章落点，不要把本章写成新的第一章，不要重复介绍主角和世界观。",
    "段落连续性：segment_no 大于 1 时，直接续写 selected_draft_fragment 的最后动作、对话或悬念，不要另起一个开头。",
    "去 AI 腔：减少抽象宣告，用具体动作、环境细节、人物选择和后果推进剧情。",
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
        "Chapter body must be written through the append_chapter_segment tool. Chat body text is not a valid deliverable.",
      goal: project.story_seed ?? project.title ?? "Untitled writing project",
      style: styleRulesText,
      skill_instructions: skillInstructions,
      project_memory: [bookSummary, continuityContext].filter(Boolean).join("\n\n"),
      chapter_plan: [`Chapter ${state.current_chapter_no} of ${project.target_chapters}.`, chapterContinuityRule].join("\n")
    },
    dynamicBlocks: {
      current_task: JSON.stringify(
        {
          kind: request.kind,
          project_id: request.project_id ?? project.project_id,
          chapter_no: request.chapter_no,
          segment_no: request.segment_no,
          segment_target_words: request.segment_target_words,
          shortfall: request.shortfall,
          quality_gate_failures: request.quality_gate_failures,
          correction_attempt: request.correction_attempt,
          validation_feedback: request.validation_feedback,
          segment_continuity_required: request.segment_no > 1,
          chapter_continuity_required: request.chapter_no > 1,
          forbidden_reboot_patterns: [
            "普通大学生突然获得神力",
            "不是梦",
            "三天了",
            "你不是唯一一个",
            "代价",
            "神性"
          ]
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

async function requestChapterToolCall(projectRoot, project, state, runtime, request) {
  let lastValidation = null;
  let lastModelCall = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await consumeModelCallBudget(projectRoot, project, state, {
      request_kind: request.kind,
      attempt
    });
    const modelCall = await runModelGatewayCall(projectRoot, project, state, runtime, {
      ...request,
      correction_attempt: attempt > 1,
      validation_feedback: lastValidation,
      attempt
    });
    lastModelCall = modelCall;
    const output = modelCall.output;
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
      return { toolCall: output, modelCall };
    }
    lastValidation = validation;
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
  }
  await blockProject(projectRoot, project, state, "model_output_invalid", {
    last_validation: lastValidation,
    last_model_call: lastModelCall
  }, { skipFailureCard: true });
  try {
    const fresh = await loadState(projectRoot).catch(() => state);
    const card = deriveFailureCard({
      id: `flr_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
      type: 'tool_call_rejected',
      chapter_no: state.current_chapter_no,
      message: lastValidation?.message ?? 'invalid arguments',
      ts: new Date().toISOString(),
      data: { tool: lastModelCall?.output?.tool ?? null, code: lastValidation?.code }
    }, fresh);
    appendFailure(projectRoot, card);
  } catch (err) { console.warn('appendFailure failed:', err.message); }
  throw new ProjectBlockedError("model_output_invalid");
}

async function executeToolCall(projectRoot, project, state, toolCall, options) {
  if (toolCall.tool !== "append_chapter_segment") {
    await blockProject(projectRoot, project, state, "unsupported_tool", {
      tool: toolCall.tool
    });
    throw new ProjectBlockedError("unsupported_tool");
  }
  try {
    return await appendChapterSegment(projectRoot, project, toolCall.input, {
      requireProjectId: true,
      ...options
    });
  } catch (error) {
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
      try {
        const fresh = await loadState(projectRoot).catch(() => state);
        const card = deriveFailureCard({
          id: `flr_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
          type: 'tool_call_rejected',
          chapter_no: state.current_chapter_no,
          message: error.message,
          ts: new Date().toISOString(),
          data: { tool: error.tool, code: error.code }
        }, fresh);
        appendFailure(projectRoot, card);
      } catch (err) { console.warn('appendFailure failed:', err.message); }
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
    max_model_calls: 200,
    revision_rounds_by_chapter: {},
    max_revision_rounds_per_chapter: 4,
    ...(state.active_budget ?? {})
  };
}

async function blockProject(projectRoot, project, state, reason, data = {}, opts = {}) {
  const current = await loadState(projectRoot).catch(() => state);
  if (current.project_status === "blocked") {
    return current;
  }
  const next = {
    ...current,
    project_status: "blocked",
    current_stage: "blocked",
    blocked_reason: reason,
    blocked_at_stage: current.current_stage,
    blocked_at: new Date().toISOString(),
    blocked_data: data
  };
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
    try {
      const fresh = await loadState(projectRoot).catch(() => state);
      const card = deriveFailureCard({
        id: `flr_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
        type: 'project_blocked',
        chapter_no: current.current_chapter_no,
        message: reason,
        ts: new Date().toISOString(),
        data
      }, fresh);
      appendFailure(projectRoot, card);
    } catch (err) { console.warn('appendFailure failed:', err.message); }
  }
  return next;
}

function checkpointPayload(project, stateBefore, stateAfter, toolCalls = [], toolResults = [], error = null, extras = {}) {
  return {
    project_id: project.project_id,
    task_id: `${project.project_id}:${stateAfter.current_chapter_no}:${stateAfter.current_stage}`,
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

function hasEnabledStageOverrides(stageOverrides) {
  if (!stageOverrides || typeof stageOverrides !== "object") {
    return false;
  }
  if (stageOverrides.enabled === false) {
    return false;
  }
  return Object.values(stageOverrides).some((value) => value && typeof value === "object" && value.enabled === true);
}
