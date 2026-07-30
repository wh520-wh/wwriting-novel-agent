import http from "node:http";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canInitializeProjectRoot, loadDashboardData, readChapterContent, validateProjectRoot } from "./app-dashboard.mjs";
import { forgetRecentProject, loadAppStateSync, loadAppState, recordRecentProject, samePath } from "./app-state.mjs";
import { loadConfigLayers } from "./config-runtime.mjs";
import { appendEvent } from "./event-log.mjs";
import { isPathInside } from "./fs-utils.mjs";
import { parseSimpleYaml } from "./simple-yaml.mjs";
import { applyLocalSecretsToEnv, defaultSecretsRoot, loadLocalSecrets, loadLocalSecretsSync } from "./local-secrets.mjs";
import { findLocalModelProfile, getDefaultLocalModelProfile, loadLocalModelProfiles, upsertLocalModelProfile } from "./local-model-profiles.mjs";
import { createProjectAt, loadProject, loadState, saveProject, saveState } from "./project-store.mjs";
import { createResearchAdapter } from "./research-adapters.mjs";
import { fetchWebPage, searchWeb } from "./research-tools.mjs";
import { ModelConfigValidationError, validateModelConfig } from "./model-config-validation.mjs";
import { testModelConnection as runModelConnectionTest } from "./model-connection-test.mjs";
import { SettingsValidationError, normalizeSettingsPatch, saveModelSettingsTransaction, updateProjectSettings } from "./settings-runtime.mjs";
import { ensureBuiltinSkill, importProjectSkill, listProjectSkills } from "./skill-runtime.mjs";
import { loadOutputStyles } from "./output-style-loader.mjs";
import { ProjectCancelledError, runProject } from "./agent-engine.mjs";
import { handleSideQuestion } from "./side-question.mjs";
import { TaskQueue } from "./task-queue.mjs";
import {
  TaskContractError,
  compileWritingTasks,
  makeResumeContract,
  validateTaskContract
} from "./task-contract.mjs";
import { resolveRetryCandidate, retryDashboardFields } from "./retry-candidates.mjs";
import { validateFailureCommand } from "../shared/failure-commands.mjs";
import { applyFailureResolution } from "./failure-actions.mjs";
import { readFailures, markResolved } from "./failures-store.mjs";
import { HttpError, sendError } from "./http-error.mjs";
import { createProjectLockRegistry } from "./project-lock.mjs";
import { loadProjectDiagnostics } from "./project-diagnostics.mjs";
import { readJson, safeJoin } from "./fs-utils.mjs";
import { runChatTurn, resumeChatTurn } from "./chat/chat-agent.mjs";
import { createToolRegistry } from "./chat/tool-registry.mjs";
import { registerReadTools } from "./chat/tools-read.mjs";
import { registerWriteTools } from "./chat/tools-write.mjs";
import { registerControlTools } from "./chat/tools-control.mjs";
import { readChatHistory, loadPendingAction } from "./chat/chat-store.mjs";
import { buildPricingTable } from "./model-pricing.mjs";
import { CostTracker } from "./cost-tracker.mjs";
import { ModelClient } from "./model-client.mjs";
import { MockProviderAdapter, OpenAICompatibleAdapter } from "./provider-adapters.mjs";

export function createAppShellServer({
  workspaceRoot = path.resolve("."),
  selectedProjectRoot = null,
  staticRoot = path.resolve("src", "app-shell"),
  secretsRoot = process.env.WWRITING_SECRETS_ROOT ?? defaultSecretsRoot(),
  stateRoot = null,
  port = 4173,
  testModel = null,
  testRunProject = null,
  testLoadDashboardData = null,
  testModelConnection = null
} = {}) {
  const workspace = path.resolve(workspaceRoot);
  const localSecretsRoot = path.resolve(secretsRoot);
  const appStateRoot = path.resolve(stateRoot ?? secretsRoot);
  const dashboardLoader = testLoadDashboardData ?? loadDashboardData;
  const connectionTester = testModelConnection ?? runModelConnectionTest ?? null;
  applyLocalSecretsToEnv(loadLocalSecretsSync(localSecretsRoot));
  const runJobs = new Map();
  const taskQueues = new Map();
  // chat 循环忙态注册表：resolvedProjectRoot -> { controller, startedAt }。
  // send/confirm 进锁前注册；/api/chat/stop 从这里取 controller —— stop 绝不进项目锁（send 正持锁，入锁即死锁）。
  const chatJobs = new Map();
  const projectLocks = createProjectLockRegistry();
  // §4.1: 启动时检测崩溃残留 — 项目 state 中 project_status==="running" 但无存活 runner。
  // 用同步 API 确保在 server.listen 前完成扫描。
  const { recoveryCandidates, autoResumeCandidates } = recoverInterruptedProjects(appStateRoot, runJobs);
  async function getTaskQueue(projectRoot) {
    const key = path.resolve(projectRoot);
    let queue = taskQueues.get(key);
    if (!queue) {
      queue = new TaskQueue(key);
      taskQueues.set(key, queue);
      await queue.load();
    }
    return queue;
  }
  let selected = selectedProjectRoot ? path.resolve(selectedProjectRoot) : null;
  if (!selected) {
    // 持久会话：未显式指定项目时，恢复上次打开且仍有效的小说（参考 Codex）。
    const lastProjectRoot = loadAppStateSync(appStateRoot).lastProjectRoot;
    if (lastProjectRoot && existsSync(path.join(lastProjectRoot, "project.yaml"))) {
      selected = lastProjectRoot;
    }
  }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/api/dashboard") {
      try {
        const requestedRoot = url.searchParams.get("projectRoot");
        const scopedRoot = (requestedRoot || selected)
          ? await resolveReadProjectRoot({ requestedRoot: requestedRoot ?? undefined, selected, workspace, stateRoot: appStateRoot })
          : null;
        await serveDashboard(response, { workspace, projectRoot: scopedRoot, secretsRoot: localSecretsRoot, runJobs, getTaskQueue, dashboardLoader, recoveryCandidates });
      } catch (error) {
        sendError(response, error);
      }
      return;
    }
    if (url.pathname === "/api/diagnostics") {
      try {
        const projectRoot = await resolveReadProjectRoot({ requestedRoot: url.searchParams.get("projectRoot") ?? undefined, selected, workspace, stateRoot: appStateRoot });
        await serveDiagnostics(response, { workspace, projectRoot });
      } catch (error) {
        sendError(response, error instanceof HttpError ? error : new HttpError(404, "no_project", error.message));
      }
      return;
    }
    if (url.pathname === "/api/projects/list") {
      await serveProjectList(response, { workspace, selected, stateRoot: appStateRoot });
      return;
    }
    if (url.pathname === "/api/projects/open" && request.method === "POST") {
      const opened = await serveProjectOpen(request, response);
      if (opened) {
        selected = opened;
        await rememberProject(appStateRoot, opened);
      }
      return;
    }
    if (url.pathname === "/api/projects/forget" && request.method === "POST") {
      const nextSelected = await serveProjectForget(request, response, {
        workspace,
        selected,
        stateRoot: appStateRoot
      });
      if (nextSelected !== undefined) {
        selected = nextSelected;
      }
      return;
    }
    if (url.pathname === "/api/projects/init" && request.method === "POST") {
      const initialized = await serveProjectInit(request, response, { secretsRoot: localSecretsRoot });
      if (initialized) {
        selected = initialized;
        await rememberProject(appStateRoot, initialized);
      }
      return;
    }
    if (url.pathname === "/api/skills/enable" && request.method === "POST") {
      await serveSkillMutation(request, response, { workspace, selected, action: "enable" });
      return;
    }
    if (url.pathname === "/api/skills/disable" && request.method === "POST") {
      await serveSkillMutation(request, response, { workspace, selected, action: "disable" });
      return;
    }
    if (url.pathname === "/api/skills/import" && request.method === "POST") {
      await serveSkillMutation(request, response, { workspace, selected, action: "import" });
      return;
    }
    if (url.pathname === "/api/output-styles" && request.method === "GET") {
      await serveOutputStyles(request, response, { workspace, selected });
      return;
    }
    if (url.pathname === "/api/research/search" && request.method === "POST") {
      await serveResearch(request, response, { workspace, selected, action: "search" });
      return;
    }
    if (url.pathname === "/api/research/fetch" && request.method === "POST") {
      await serveResearch(request, response, { workspace, selected, action: "fetch" });
      return;
    }
    if (url.pathname === "/api/settings/update" && request.method === "POST") {
      await serveSettingsUpdate(request, response, { workspace, selected, stateRoot: appStateRoot, secretsRoot: localSecretsRoot });
      return;
    }
    if (url.pathname === "/api/settings/test-connection" && request.method === "POST") {
      try {
        const projectRoot = await resolveReadProjectRoot({
          requestedRoot: undefined,
          selected,
          workspace,
          stateRoot: appStateRoot
        });
        await serveTestConnection(request, response, {
          workspace,
          projectRoot,
          secretsRoot: localSecretsRoot,
          connectionTester
        });
      } catch (error) {
        sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
      }
      return;
    }
    if (url.pathname === "/api/settings/model-secret" && request.method === "GET") {
      await serveModelSecret(response, { workspace, selected, secretsRoot: localSecretsRoot });
      return;
    }
    if (url.pathname === "/api/settings/models" && request.method === "GET") {
      await serveSettingsModels(response, { workspace, selected, secretsRoot: localSecretsRoot });
      return;
    }
    if (url.pathname === "/api/settings/model-switch" && request.method === "POST") {
      await serveModelSwitch(request, response, { workspace, selected, stateRoot: appStateRoot, secretsRoot: localSecretsRoot });
      return;
    }
    if (url.pathname === "/api/commands/submit" && request.method === "POST") {
      await serveCommandSubmit(request, response, { workspace, selected, stateRoot: appStateRoot, runJobs, getTaskQueue, testModel, testRunProject, projectLocks });
      return;
    }
    if (url.pathname === "/api/chat/send" && request.method === "POST") {
      await serveChatSend(request, response, { workspace, selected, stateRoot: appStateRoot, runJobs, getTaskQueue, testModel, testRunProject, projectLocks, startProjectRunFn: startProjectRun, chatJobs });
      return;
    }
    if (url.pathname === "/api/chat/confirm" && request.method === "POST") {
      await serveChatConfirm(request, response, { workspace, selected, stateRoot: appStateRoot, runJobs, getTaskQueue, testModel, testRunProject, projectLocks, startProjectRunFn: startProjectRun, chatJobs });
      return;
    }
    if (url.pathname === "/api/chat/history" && request.method === "GET") {
      try {
        const projectRoot = await resolveReadProjectRoot({ requestedRoot: url.searchParams.get("projectRoot") ?? undefined, selected, workspace, stateRoot: appStateRoot });
        await serveChatHistory(url, response, { workspace, projectRoot, chatJobs });
      } catch (error) {
        sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
      }
      return;
    }
    if (url.pathname === "/api/chat/stop" && request.method === "POST") {
      // 红线：不要给这个端点包 withProjectLock。
      await serveChatStop(response, { workspace, selected, stateRoot: appStateRoot, chatJobs });
      return;
    }
    if (url.pathname === "/api/run/retry" && request.method === "POST") {
      await serveRunRetry(request, response, { workspace, selected, stateRoot: appStateRoot, runJobs, getTaskQueue, testModel, testRunProject, projectLocks });
      return;
    }
    if (url.pathname === "/api/failures/resolve" && request.method === "POST") {
      await serveFailuresResolve(request, response, { workspace, selected, stateRoot: appStateRoot, runJobs, getTaskQueue, testModel, testRunProject, projectLocks });
      return;
    }
    if (url.pathname === "/api/run/stop" && request.method === "POST") {
      await serveRunStop(response, { workspace, selected, stateRoot: appStateRoot, runJobs, getTaskQueue, projectLocks });
      return;
    }
    if (url.pathname === "/api/shutdown" && request.method === "POST") {
      abortActiveJobs(runJobs, "Server shutdown");
      await serveJson(response, { ok: true, message: "shutting down" });
      return;
    }
    if (url.pathname === "/api/queue/state" && request.method === "GET") {
      try {
        const projectRoot = await resolveReadProjectRoot({ requestedRoot: url.searchParams.get("projectRoot") ?? undefined, selected, workspace, stateRoot: appStateRoot });
        await serveQueueState(response, { workspace, projectRoot, getTaskQueue, runJobs });
      } catch (error) {
        sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
      }
      return;
    }
    if (url.pathname === "/api/queue/cancel" && request.method === "POST") {
      await serveQueueCancel(request, response, { workspace, selected, stateRoot: appStateRoot, getTaskQueue, projectLocks });
      return;
    }
    if (url.pathname === "/api/commands/ask" && request.method === "POST") {
      await serveSideQuestion(request, response, { workspace, selected });
      return;
    }
    if (url.pathname === "/api/chapters/read") {
      try {
        const projectRoot = await resolveReadProjectRoot({ requestedRoot: url.searchParams.get("projectRoot") ?? undefined, selected, workspace, stateRoot: appStateRoot });
        await serveChapterRead(url, response, { workspace, projectRoot });
      } catch (error) {
        sendError(response, error instanceof HttpError ? error : new HttpError(400, "chapter_read_failed", error.message));
      }
      return;
    }
    await serveStatic(url.pathname, response, { staticRoot });
  });
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    abortActiveJobs(runJobs, "Application shutdown");
    return originalClose(callback);
  };

  // §4.1.3: 对配置了 auto_resume_on_start===true 的崩溃残留项目自动续跑。
  // 放在 server.listen 之后执行；在 server 返回前 fire-and-forget 启动，
  // 这样 server 仍然可以立即接受请求（续跑在后台异步推进）。
  if (autoResumeCandidates.length > 0) {
    (async () => {
      for (const root of autoResumeCandidates) {
        try {
          const project = await loadProject(root);
          const state = await loadState(root);
          const queue = await getTaskQueue(root);
          const task = await queue.createRecoveryTask({
            instruction: state.last_user_instruction ?? "继续当前写作任务",
            mode: "write",
            currentStage: state.current_stage ?? "queued",
            recovery: { reason: "auto_resume_on_start" }
          });
          if (task) {
            const miniCtx = { runJobs, getTaskQueue, testModel, testRunProject, projectLocks };
            await startProjectRun(root, project, miniCtx, task, { source: "auto_resume_on_start" });
            console.log(`[app-server] auto_resume_on_start: continued ${path.basename(root)}`);
          }
        } catch (err) {
          // 单项目失败不影响其他项目的自动续跑
          console.warn(`[app-server] auto_resume_on_start failed for ${path.basename(root)}:`, err.message);
        }
      }
    })().catch((err) => {
      console.warn("[app-server] auto_resume_on_start processing error:", err.message);
    });
  }

  return server;
}

async function serveDashboard(response, context) {
  try {
    const loadDashboard = context.dashboardLoader ?? loadDashboardData;
    const data = await loadDashboard(context.workspace, {
      projectRoot: context.projectRoot,
      allowExternalProjectRoot: Boolean(context.projectRoot),
      disableProjectFallback: !context.projectRoot
    });
    if (data?.hasProject) {
      data.model_profile = buildModelProfile(data.project?.active_model, context.secretsRoot);
      data.available_models = await buildAvailableModelProfiles(context.secretsRoot, data.project?.active_model);
      const key = data.projectRoot ? path.resolve(data.projectRoot) : null;
      const job = key ? context.runJobs?.get(key) : null;
      data.agent_alive = isJobRunning(job);
      data.agent_started_at = job?.startedAt ?? null;
      data.agent_last_heartbeat = job?.lastHeartbeat ?? null;
      data.agent_error = job?.error ?? null;
      data.agent_task_id = job?.taskId ?? null;
      const queue = await context.getTaskQueue(data.projectRoot);
      const candidate = await resolveRetryCandidate({
        projectRoot: data.projectRoot,
        queue,
        job
      });
      Object.assign(data, retryDashboardFields(candidate));
      // §4.1: 启动时检测到的残留标记
      data.recovery_pending = context.recoveryCandidates?.has(key) ?? false;
      // §4.3: 从最近事件推导重试可见性
      if (Array.isArray(data.events)) {
        const retryEvents = data.events.filter(e => e.type === 'model_retry');
        const lastRetry = retryEvents[retryEvents.length - 1];
        if (lastRetry?.data) {
          const retryAge = Date.now() - Date.parse(lastRetry.timestamp || lastRetry.ts || 0);
          if (retryAge < 60000) {
            data.retry_info = {
              active: true,
              attempt: lastRetry.data.attempt ?? 1,
              maxAttempts: lastRetry.data.maxAttempts ?? 4,
              delay: lastRetry.data.delay ?? 0,
              reason: lastRetry.data.reason ?? ''
            };
          }
        }
      }
    }
    await serveJson(response, data);
    return data;
  } catch (error) {
    sendError(response, error);
    return null;
  }
}

async function serveDiagnostics(response, context) {
  try {
    const projectRoot = context.projectRoot ?? await resolveActiveProjectRoot(context);
    const diagnostics = await loadProjectDiagnostics(projectRoot);
    await serveJson(response, diagnostics);
  } catch (error) {
    sendError(response, new HttpError(404, "no_project", error.message));
  }
}

async function buildProjectList(context) {
  const selected = context.selected ? path.resolve(context.selected) : null;
  const state = await loadAppState(context.stateRoot);
  const candidates = [...state.recentProjects];
  if (selected && !candidates.some((item) => samePath(item.projectRoot, selected))) {
    candidates.push({ projectRoot: selected });
  }
  const projects = [];
  for (const item of candidates) {
    const root = path.resolve(item.projectRoot);
    if (projects.some((project) => samePath(project.projectRoot, root))) {
      continue;
    }
    if (!existsSync(path.join(root, "project.yaml"))) {
      continue;
    }
    let title = item.title ?? path.basename(root);
    let storySeed = item.story_seed ?? "";
    let activeModel = null;
    let archivedAt = null;
    try {
      const project = await loadProject(root);
      title = project.title ?? title;
      storySeed = project.story_seed ?? storySeed;
      const config = await loadConfigLayers(root, project).catch(() => null);
      activeModel = config?.effective?.active_model ?? project.active_model ?? null;
      archivedAt = project.archived_at ?? null;
    } catch (error) {
      console.warn("[app-server] Failed to load project metadata:", error.message);
    }
    projects.push({
      projectRoot: root,
      title,
      story_seed: storySeed,
      active_model: activeModel,
      model_label: modelDisplayName(activeModel),
      archived_at: archivedAt,
      external: !isPathInside(context.workspace, root)
    });
  }
  const selectedInList = selected && projects.some((project) => samePath(project.projectRoot, selected))
    ? selected
    : null;
  return {
    ok: true,
    workspaceRoot: context.workspace,
    selectedProjectRoot: selectedInList,
    projects
  };
}

async function serveProjectList(response, context) {
  try {
    await serveJson(response, await buildProjectList(context));
  } catch (error) {
    sendError(response, error instanceof SyntaxError ? new HttpError(400, "BAD_REQUEST", error.message) : error);
  }
}

async function rememberProject(stateRoot, projectRoot) {
  try {
    const project = await loadProject(projectRoot);
    await recordRecentProject(stateRoot, { projectRoot, title: project.title, story_seed: project.story_seed });
  } catch {
    // 项目元数据读取失败（文件缺失或格式错误），仅记录路径
    await recordRecentProject(stateRoot, { projectRoot });
  }
}

async function serveProjectOpen(request, response) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await validateProjectRoot(body.projectRoot ?? body.path ?? "");
    await serveJson(response, {
      ok: true,
      projectRoot
    });
    return projectRoot;
  } catch (error) {
    sendError(response, new HttpError(400, "project_open_failed", error.message));
    return null;
  }
}

async function serveProjectForget(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const rawRoot = String(body.projectRoot ?? body.path ?? "").trim();
    if (!rawRoot) {
      sendError(response, new HttpError(400, "project_forget_failed", "项目路径不能为空。"));
      return undefined;
    }
    const target = path.resolve(rawRoot);
    await forgetRecentProject(context.stateRoot, target);
    const selectedProjectRoot = await resolveSelectedAfterForget({
      stateRoot: context.stateRoot,
      currentSelected: context.selected,
      forgottenRoot: target
    });
    const list = await buildProjectList({
      workspace: context.workspace,
      selected: selectedProjectRoot,
      stateRoot: context.stateRoot
    });
    await serveJson(response, {
      ok: true,
      workspaceRoot: context.workspace,
      selectedProjectRoot,
      projects: list.projects
    });
    return selectedProjectRoot ?? null;
  } catch (error) {
    sendError(response, new HttpError(400, "project_forget_failed", error.message));
    return undefined;
  }
}

async function resolveSelectedAfterForget({ stateRoot, currentSelected, forgottenRoot }) {
  if (currentSelected && !samePath(currentSelected, forgottenRoot) && existsSync(path.join(currentSelected, "project.yaml"))) {
    return path.resolve(currentSelected);
  }
  const state = await loadAppState(stateRoot);
  for (const item of state.recentProjects) {
    const candidate = path.resolve(item.projectRoot);
    if (existsSync(path.join(candidate, "project.yaml"))) {
      return candidate;
    }
  }
  return null;
}

async function serveProjectInit(request, response, context = {}) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await canInitializeProjectRoot(body.projectRoot ?? body.path ?? "");
    const title = String(body.title ?? "").trim() || path.basename(projectRoot) || "未命名小说";
    const storySeed = String(body.story_seed ?? "").trim() || "一个人在雨夜收到一封没有署名的信。";
    const targetChapters = normalizePositiveInteger(body.target_chapters, 100);
    const minWordsPerChapter = normalizePositiveInteger(body.min_words_per_chapter, 3000);
    const targetWordsPerChapter = normalizePositiveInteger(body.target_words_per_chapter, Math.max(minWordsPerChapter, 3300));
    const outputFormat = ["md", "txt"].includes(body.output_format) ? body.output_format : "md";
    const defaultModel = context.secretsRoot ? await getDefaultLocalModelProfile(context.secretsRoot) : null;
    const { project } = await createProjectAt(projectRoot, {
      title,
      story_seed: storySeed,
      target_chapters: targetChapters,
      min_words_per_chapter: minWordsPerChapter,
      target_words_per_chapter: targetWordsPerChapter,
      output_format: outputFormat,
      active_model: defaultModel ? modelConfigFromLocalProfile(defaultModel) : undefined
    });
    await serveJson(response, {
      ok: true,
      projectRoot,
      project: {
        project_id: project.project_id,
        title: project.title,
        story_seed: project.story_seed,
        target_chapters: project.target_chapters
      }
    });
    return projectRoot;
  } catch (error) {
    sendError(response, new HttpError(400, "project_init_failed", error.message));
    return null;
  }
}

async function serveResearch(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveProjectRoot(context);
    const project = await loadProject(projectRoot);
    const config = await loadConfigLayers(projectRoot, project);
    const adapter = createResearchAdapter(config.effective.research_config ?? {});
    const effectiveProject = {
      ...project,
      effective_config: config.effective,
      tool_permissions: config.effective.tool_permissions
    };
    const result =
      context.action === "search"
        ? await searchWeb(projectRoot, effectiveProject, { query: body.query, limit: body.limit ?? 5, stage: "research" }, { adapter })
        : await fetchWebPage(projectRoot, effectiveProject, { url: body.url, stage: "research" }, { adapter });
    await serveJson(response, result);
  } catch (error) {
    sendError(response, new HttpError(error.code === "network_not_allowed" ? 403 : 400, error.code ?? "research_failed", error.message));
  }
}

async function serveSettingsUpdate(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveWriteProjectRoot(context, body);
    await assertNotArchived(projectRoot);
    const activeModel = body?.active_model && typeof body.active_model === "object"
      ? { ...body.active_model }
      : null;
    // Validate non-model fields (tool_permissions / budget_config / research_config / ...) BEFORE
    // touching durable state. If the caller sent garbage in any of these sections, we reject the
    // whole request without writing the model — the request is meant to be atomic.
    const nonModelPatch = { ...body };
    delete nonModelPatch.active_model;
    delete nonModelPatch.projectRoot;
    let normalizedNonModelPatch = null;
    if (Object.keys(nonModelPatch).length > 0) {
      try {
        normalizedNonModelPatch = normalizeSettingsPatch(nonModelPatch);
      } catch (settingsError) {
        if (settingsError instanceof SettingsValidationError) {
          throw new HttpError(400, settingsError.code, settingsError.message);
        }
        throw settingsError;
      }
    }

    if (!activeModel && !normalizedNonModelPatch) {
      throw new HttpError(400, "invalid_settings_patch", "settings update requires a patch.");
    }

    let result = null;
    let mergedProject;
    if (activeModel) {
      result = await saveModelSettingsTransaction({
        projectRoot,
        secretsRoot: context.secretsRoot,
        activeModel
      });
      mergedProject = result.project;
      // Model save succeeded; now persist the non-model fields. If this fails the durable state is
      // still consistent (active_model already saved); we surface the error and let the caller retry.
      if (normalizedNonModelPatch && Object.keys(normalizedNonModelPatch).length > 0) {
        mergedProject = await updateProjectSettings(projectRoot, normalizedNonModelPatch);
      }
      await upsertLocalModelProfile(context.secretsRoot, mergedProject.active_model);
    } else {
      mergedProject = await updateProjectSettings(projectRoot, normalizedNonModelPatch);
    }

    const config = await loadConfigLayers(projectRoot, mergedProject);
    await serveJson(response, {
      ok: true,
      projectRoot,
      project: {
        project_id: mergedProject.project_id,
        active_model: mergedProject.active_model,
        stage_overrides: mergedProject.stage_overrides,
        tool_permissions: mergedProject.tool_permissions ?? {},
        budget_config: mergedProject.budget_config ?? {},
        research_config: mergedProject.research_config ?? {}
      },
      effective_config: config.effective,
      model_profile: buildModelProfile(config.effective.active_model, context.secretsRoot),
      available_models: await buildAvailableModelProfiles(context.secretsRoot, config.effective.active_model),
      secret_saved: result?.secret_saved ?? false,
      secret_env: result?.secret_env ?? null
    });
  } catch (error) {
    if (error instanceof ModelConfigValidationError) {
      sendError(response, new HttpError(400, error.code, error.message, { fields: error.fields }));
      return;
    }
    if (error instanceof SettingsValidationError) {
      sendError(response, new HttpError(400, error.code, error.message));
      return;
    }
    if (error instanceof HttpError) {
      sendError(response, error);
      return;
    }
    const code = error?.code ?? "settings_update_failed";
    const status = code === "settings_rollback_failed" ? 500 : 400;
    sendError(response, new HttpError(status, code, error.message));
  }
}

async function serveModelSecret(response, context) {
  try {
    const projectRoot = await resolveActiveProjectRoot(context);
    const project = await loadProject(projectRoot);
    const config = await loadConfigLayers(projectRoot, project);
    const envName = config.effective?.active_model?.api_key_env ?? null;
    const value = envName ? loadLocalSecretsSync(context.secretsRoot)[envName] ?? process.env[envName] ?? "" : "";
    await serveJson(response, { ok: true, env: envName, value });
  } catch (error) {
    sendError(response, new HttpError(400, "model_secret_failed", error.message));
  }
}

async function serveSettingsModels(response, context) {
  try {
    let activeModel = null;
    if (context.selected) {
      const projectRoot = await resolveActiveProjectRoot(context).catch(() => null);
      if (projectRoot) {
        const project = await loadProject(projectRoot).catch(() => null);
        const config = project ? await loadConfigLayers(projectRoot, project).catch(() => null) : null;
        activeModel = config?.effective?.active_model ?? project?.active_model ?? null;
      }
    }
    const store = await loadLocalModelProfiles(context.secretsRoot);
    const defaultModel = store.models.find((model) => model.id === store.default_model_id) ?? store.models[0] ?? null;
    await serveJson(response, {
      ok: true,
      default_model: defaultModel ? buildModelProfile(defaultModel, context.secretsRoot, { id: defaultModel.id, saved_to: "model-profiles.json" }) : null,
      models: await buildAvailableModelProfiles(context.secretsRoot, activeModel)
    });
  } catch (error) {
    sendError(response, new HttpError(400, "settings_models_failed", error.message));
  }
}

async function serveModelSwitch(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveWriteProjectRoot(context, body);
    await assertNotArchived(projectRoot);
    const modelId = String(body.model_id ?? body.modelId ?? body.model_name ?? "").trim();
    if (!modelId) {
      throw new HttpError(400, "invalid_model_id", "model_id is required.");
    }
    const profile = await findLocalModelProfile(context.secretsRoot, modelId);
    if (!profile) {
      throw new HttpError(404, "model_profile_not_found", `未找到已配置模型：${modelId}`);
    }
    const project = await updateProjectSettings(projectRoot, { active_model: modelConfigFromLocalProfile(profile) });
    await upsertLocalModelProfile(context.secretsRoot, project.active_model);
    const config = await loadConfigLayers(projectRoot, project);
    await serveJson(response, {
      ok: true,
      projectRoot,
      project: {
        project_id: project.project_id,
        active_model: project.active_model,
        tool_permissions: project.tool_permissions ?? {}
      },
      effective_config: config.effective,
      model_profile: buildModelProfile(config.effective.active_model, context.secretsRoot),
      available_models: await buildAvailableModelProfiles(context.secretsRoot, config.effective.active_model)
    });
  } catch (error) {
    sendError(response, error instanceof HttpError ? error : new HttpError(400, "model_switch_failed", error.message));
  }
}

// 连接测试：仅复用现有项目读取权限，候选 active_model + 临时 api_key 完全不入项目/secret 文件。
// 1) 用 resolveReadProjectRoot 校验项目已注册且磁盘上存在 project.yaml；
// 2) 用 ModelConfigValidationError 校验字段；缺字段返回 400 configuration_missing；
// 3) 从 secrets 读旧 key，请求里的 api_key（若非空）覆盖在 secrets 上（仅用于本次探测）；
// 4) 调用注入的 connectionTester（默认 runModelConnectionTest）做一次只读探测；
// 5) 追加一条不含 api_key、prompt、response body 的 model_connection_tested 审计事件；
// 6) 200/4xx 分流：探测结果（成功或分类后的失败）一律 200；缺字段/缺密钥映射的 configuration_missing 走 400。
async function serveTestConnection(request, response, context) {
  try {
    if (!context.connectionTester) {
      throw new HttpError(503, "model_probe_unavailable", "模型连接探测尚未配置。");
    }
    const body = await readJsonBody(request);
    const projectRoot = context.projectRoot;
    const candidate = body?.active_model && typeof body.active_model === "object"
      ? { ...body.active_model }
      : null;
    if (!candidate) {
      throw new HttpError(400, "configuration_missing", "active_model is required.");
    }
    const project = await loadProject(projectRoot);
    const projectId = project.project_id ?? null;

    let validated;
    try {
      validated = validateModelConfig(candidate);
    } catch (error) {
      if (error instanceof ModelConfigValidationError) {
        sendError(response, new HttpError(400, error.code, error.message, { fields: error.fields }));
        return;
      }
      throw error;
    }

    const stored = await loadLocalSecrets(context.secretsRoot);
    const transientApiKey = typeof candidate.api_key === "string" && candidate.api_key.length > 0
      ? candidate.api_key
      : null;
    const secrets = { ...stored };
    if (transientApiKey) {
      secrets[validated.api_key_env] = transientApiKey;
    }
    if (!secrets[validated.api_key_env]) {
      sendError(response, new HttpError(400, "configuration_missing", "请先在 Windows 环境变量中配置 API Key"));
      return;
    }

    const persistedConfig = {
      provider: validated.provider,
      model_name: validated.model_name,
      base_url: validated.base_url,
      api_key_env: validated.api_key_env
    };

    let result;
    try {
      result = await context.connectionTester({
        config: persistedConfig,
        secrets
      });
    } catch (error) {
      // 调用方取消（AbortError）原样上抛，不映射为 provider 错误。
      if (error && (error.name === "AbortError" || error.code === DOMException.ABORT_ERR)) {
        throw error;
      }
      throw error;
    }

    let baseUrlOrigin = "";
    try {
      baseUrlOrigin = new URL(validated.base_url).origin;
    } catch {
      baseUrlOrigin = "";
    }

    await appendEvent(projectRoot, {
      type: "model_connection_tested",
      project_id: projectId,
      stage: "settings",
      severity: result?.ok ? "info" : "warn",
      message: result?.ok ? "模型连接成功" : `模型连接失败：${result?.code ?? "unknown"}`,
      data: {
        ok: result?.ok === true,
        provider: persistedConfig.provider,
        model_name: persistedConfig.model_name,
        base_url_origin: baseUrlOrigin,
        code: result?.code ?? null,
        latency_ms: typeof result?.latency_ms === "number" ? result.latency_ms : null
      }
    });

    await serveJson(response, {
      ok: result?.ok === true,
      code: result?.code ?? null,
      message: result?.message ?? null,
      provider: persistedConfig.provider,
      model_name: persistedConfig.model_name,
      latency_ms: typeof result?.latency_ms === "number" ? result.latency_ms : null,
      projectRoot
    });
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(response, error);
      return;
    }
    if (error && (error.name === "AbortError" || error.code === DOMException.ABORT_ERR)) {
      sendError(response, new HttpError(499, "client_closed_request", "连接测试已取消"));
      return;
    }
    sendError(response, new HttpError(400, "test_connection_failed", error.message));
  }
}

async function buildAvailableModelProfiles(secretsRoot, activeModel = null) {
  const store = await loadLocalModelProfiles(secretsRoot);
  const models = [...store.models];
  if (
    activeModel?.provider &&
    activeModel?.provider !== "mock" &&
    activeModel?.model_name &&
    !models.some((model) => sameModelProfile(model, activeModel))
  ) {
    models.unshift(activeModel);
  }
  return models.map((model) => ({
    ...buildModelProfile(model, secretsRoot, { id: model.id ?? model.model_name, saved_to: "model-profiles.json" }),
    active: sameModelProfile(model, activeModel)
  }));
}

function buildModelProfile(activeModel = {}, secretsRoot, options = {}) {
  const provider = activeModel?.provider ?? "mock";
  const modelName = activeModel?.model_name ?? "mock-writer";
  const apiKeyEnv = activeModel?.api_key_env ?? null;
  const secretValue = apiKeyEnv ? loadLocalSecretsSync(secretsRoot)[apiKeyEnv] ?? process.env[apiKeyEnv] ?? "" : "";
  return {
    provider,
    provider_label: providerDisplayName(activeModel),
    model_name: modelName,
    base_url: activeModel?.base_url ?? "",
    endpoint: provider === "openai-compatible" ? modelEndpoint(activeModel?.base_url) : "",
    api_key_env: apiKeyEnv,
    api_key_saved: Boolean(secretValue),
    api_key_masked: secretValue ? `••••${secretValue.slice(-4)}` : "",
    is_mock: provider === "mock",
    display: modelDisplayName(activeModel),
    id: options.id ?? modelName,
    saved_to: options.saved_to ?? "project.yaml"
  };
}

function sameModelProfile(left = {}, right = {}) {
  if (!left || !right) return false;
  return (
    left.provider === right.provider &&
    left.model_name === right.model_name &&
    (left.base_url ?? "") === (right.base_url ?? "") &&
    (left.api_key_env ?? "") === (right.api_key_env ?? "")
  );
}

function modelConfigFromLocalProfile(profile = {}) {
  const { id, saved_at, ...config } = profile;
  return config;
}

function modelDisplayName(activeModel = {}) {
  return `${providerDisplayName(activeModel)} / ${activeModel?.model_name ?? "mock-writer"}`;
}

function providerDisplayName(activeModel = {}) {
  const provider = activeModel?.provider ?? "mock";
  const baseUrl = activeModel?.base_url ?? "";
  const envName = activeModel?.api_key_env ?? "";
  const modelName = activeModel?.model_name ?? "";
  if (provider === "mock") {
    return "Mock";
  }
  if (baseUrl === "https://api.deepseek.com" || envName === "DEEPSEEK_API_KEY" || modelName.startsWith("deepseek-")) {
    return "DeepSeek 官方";
  }
  if (baseUrl === "https://api.xiaomimimo.com/v1" || envName === "XIAOMI_MIMO_API_KEY" || modelName.startsWith("mimo-")) {
    return "小米 MiMo 官方";
  }
  return provider;
}

function modelEndpoint(baseUrl) {
  if (!baseUrl) {
    return "";
  }
  try {
    return new URL("chat/completions", String(baseUrl).endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  } catch {
    return "";
  }
}

function isJobRunning(job) {
  return job?.status === "running";
}

// §4.1: 启动时扫描 recentProjects，检测 project_status==="running" 但无存活 runner 的残留项目。
// 用同步 API 确保扫描在 server.listen 前完成。
// 返回 { recoveryCandidates, autoResumeCandidates }：
//   - recoveryCandidates：设 recovery_pending 标记让用户手动处理
//   - autoResumeCandidates：auto_resume_on_start===true，直接自动续跑
export function recoverInterruptedProjects(stateRoot, runJobs) {
  const state = loadAppStateSync(stateRoot);
  const recoveryCandidates = new Set();
  const autoResumeCandidates = [];
  for (const item of state.recentProjects) {
    const projectRoot = item.projectRoot;
    if (!existsSync(path.join(projectRoot, "project.yaml"))) continue;
    try {
      const stateFile = path.join(projectRoot, "agent_state.json");
      if (!existsSync(stateFile)) continue;
      const raw = readFileSync(stateFile, "utf8");
      const projectState = JSON.parse(raw);
      const key = path.resolve(projectRoot);
      const job = runJobs.get(key);
      if (projectState.project_status === "running" && !isJobRunning(job)) {
        // 检查 auto_resume_on_start 配置
        let autoResume = false;
        try {
          const projectYaml = readFileSync(path.join(projectRoot, "project.yaml"), "utf8");
          const projectData = parseSimpleYaml(projectYaml);
          autoResume = projectData.auto_resume_on_start === true;
          if (!autoResume) {
            // 也在 config JSON 文件中检查
            for (const cfgFile of ["config/global_config.json", "config/local_config.json", "config/policy_config.json"]) {
              const cfgPath = path.join(projectRoot, cfgFile);
              if (existsSync(cfgPath)) {
                const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
                if (cfg.auto_resume_on_start === true) { autoResume = true; break; }
              }
            }
          }
        } catch { /* skip unreadable config */ }

        if (autoResume) {
          autoResumeCandidates.push(key);
        } else {
          recoveryCandidates.add(key);
        }
      }
    } catch { /* skip unreadable projects */ }
  }
  return { recoveryCandidates, autoResumeCandidates };
}

function abortActiveJobs(runJobs, reason) {
  for (const job of runJobs.values()) {
    if (isJobRunning(job) && !job.controller.signal.aborted) {
      job.controller.abort(reason);
    }
  }
}

async function withProjectLock(context, projectRoot, operation) {
  if (!context.projectLocks) {
    return operation();
  }
  return context.projectLocks.runExclusive(projectRoot, operation);
}

// 归档守卫：归档项目对所有写端点拒绝。/api/chat/send|confirm 不走这里——chat 层由 checkToolPermission
// 按工具类型决定（如 read 类工具仍可用）。这是 server 侧 defense-in-depth，与 chat 侧运行时校验叠加。
async function assertNotArchived(projectRoot) {
  const project = await loadProject(projectRoot);
  if (project.archived_at) {
    throw new HttpError(400, "PROJECT_ARCHIVED", "项目已归档（只读）。请先解除归档再执行此操作。");
  }
  return project;
}

function queueSnapshot(queue, job) {
  const state = queue.getState();
  const tasks = state.tasks ?? [];
  return {
    ok: true,
    tasks,
    runningTaskId: isJobRunning(job) ? job.taskId : tasks.find((task) => task.status === "running")?.id ?? null,
    queuedCount: tasks.filter((task) => task.status === "queued").length,
    completedCount: tasks.filter((task) => task.status === "completed").length
  };
}

async function serveOutputStyles(request, response, context) {
  try {
    const projectRoot = context.selected ?? null;
    const userHome = os.homedir();
    const styles = await loadOutputStyles({ projectRoot, userHome });
    // Strip filePath / large body for browser; just expose name + description
    const lite = styles.map((s) => ({
      name: s.name,
      description: s.description ?? "",
      source: s.source
    }));
    await serveJson(response, { ok: true, styles: lite });
  } catch (error) {
    await serveJson(response, { ok: false, message: error.message }, 500);
  }
}

async function serveSkillMutation(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveProjectRoot(context);
    await assertNotArchived(projectRoot);
    const project = await loadProject(projectRoot);
    let skillName = body.name;
    if (context.action === "import") {
      const manifest = await importProjectSkill(projectRoot, body.manifest ?? body);
      skillName = manifest.name;
    }
    if (!isSafeSkillName(skillName)) {
      throw new Error("技能名称无效。");
    }

    if (context.action === "enable" || context.action === "import") {
      await ensureBuiltinSkill(projectRoot, skillName);
      const available = await listProjectSkills(projectRoot, {
        ...project,
        enabled_skills: project.enabled_skills ?? []
      });
      if (!available.some((skill) => skill.name === skillName)) {
        throw new Error(`技能未安装：${skillName}`);
      }
      project.enabled_skills = [...new Set([...(project.enabled_skills ?? []), skillName])].sort();
    } else {
      project.enabled_skills = (project.enabled_skills ?? []).filter((name) => name !== skillName);
    }

    await saveProject(projectRoot, project);
    await appendEvent(projectRoot, {
      type: "skill_configuration_changed",
      project_id: project.project_id,
      message: `skill ${context.action}: ${skillName}`,
      data: { skill: skillName, action: context.action }
    });
    await serveJson(response, {
      ok: true,
      projectRoot,
      skill: skillName,
      enabled_skills: project.enabled_skills
    });
  } catch (error) {
    sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
  }
}

async function validateRunnableModelConfig(project, secretsRoot) {
  if (!project || !project.active_model) {
    throw new ModelConfigValidationError({
      provider: "请先在设置中配置模型"
    });
  }
  validateModelConfig(project.active_model);
  if (project.active_model.provider === "openai-compatible") {
    const secrets = await loadLocalSecrets(secretsRoot);
    const envName = project.active_model.api_key_env;
    if (!secrets[envName]) {
      throw new ModelConfigValidationError({
        api_key: "请填写 API Key 或保留已配置密钥"
      });
    }
  }
  return project.active_model;
}

async function serveCommandSubmit(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const message = String(body.message ?? "").trim();
    if (!message) {
      throw new Error("请输入要提交的指令。");
    }
    if (message.length > 4000) {
      throw new Error("指令内容过长。");
    }
    const mode = body.mode === "review" ? "review" : "write";
    const projectRoot = await resolveActiveWriteProjectRoot(context, body);
    await assertNotArchived(projectRoot);
    return await withProjectLock(context, projectRoot, async () => {
    const project = await loadProject(projectRoot);
    const state = await loadState(projectRoot);
    if (state.project_status === "completed") {
      await appendEvent(projectRoot, {
        type: "user_instruction_received",
        project_id: project.project_id,
        stage: "user_input",
        message,
        data: {
          source: "app_shell_composer",
          mode,
          skipped: true,
          note: "项目已完成，指令未入队。"
        }
      });
      await appendEvent(projectRoot, {
        type: "project_run_skipped",
        project_id: project.project_id,
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        message: "项目已完成，未启动新的写作任务。"
      });
      await serveJson(response, {
        ok: true,
        projectRoot,
        queued: 0,
        tasks: [],
        started: false,
        alreadyRunning: false,
        completed: true,
        blocked: false,
        message: "项目已完成；在「设置 → 写作目标」里提高目标章节数即可继续。"
      });
      return;
    }
    if (state.project_status === "blocked") {
      await appendEvent(projectRoot, {
        type: "user_instruction_received",
        project_id: project.project_id,
        stage: "user_input",
        message,
        data: {
          source: "app_shell_composer",
          mode,
          skipped: true,
          note: "项目已阻塞，指令未入队。"
        }
      });
      await appendEvent(projectRoot, {
        type: "project_run_skipped",
        project_id: project.project_id,
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        severity: "warn",
        message: state.blocked_reason ?? "blocked",
        data: {
          status: "blocked",
          reason: state.blocked_reason ?? null
        }
      });
      await serveJson(response, {
        ok: true,
        projectRoot,
        queued: 0,
        tasks: [],
        started: false,
        alreadyRunning: false,
        completed: false,
        blocked: true,
        message: "项目已阻塞；请先处理错误后再继续。"
      });
      return;
    }
    const queue = await context.getTaskQueue(projectRoot);
    const explicitScope = /第\d+章|(?:\d+|[一二三四五六七八九十])章|到第\d+章/u.test(message);
    const hasPendingWritingTask = queue.getState().tasks.some((candidate) =>
      ["queued", "running", "cancelling"].includes(candidate.status) &&
      ["write_chapter", "resume_chapter"].includes(candidate.contract?.kind)
    );
    if (!explicitScope && hasPendingWritingTask) {
      await appendEvent(projectRoot, {
        type: "task_contract_rejected",
        project_id: project.project_id,
        stage: "user_input",
        severity: "warn",
        message,
        data: {
          code: "ambiguous_task_scope",
          currentChapter: state.current_chapter_no ?? 1
        }
      });
      throw new TaskContractError(
        "ambiguous_task_scope",
        "已有写作任务，请明确指定章节。"
      );
    }
    const plannedTasks = compileWritingTasks(message, {
      currentChapter: state.current_chapter_no ?? 1,
      targetChapters: project.target_chapters
    });
    const tasks = [];
    for (const planned of plannedTasks) {
      const task = await queue.enqueue(planned.instruction, {
        mode,
        contract: planned.contract
      });
      tasks.push(task);
      await appendEvent(projectRoot, {
        type: "task_contract_created",
        project_id: project.project_id,
        stage: "user_input",
        message: planned.instruction,
        data: {
          task_id: task.id,
          contract_kind: planned.contract?.kind ?? null,
          chapter_start: planned.contract?.chapter_start ?? null,
          chapter_end: planned.contract?.chapter_end ?? null
        }
      });
    }
    // 运行前模型资格预检：仅做本地静态检查（字段形状 + secret 存在），不发网络请求、不消耗模型预算。
    // 失败时把已入队任务与项目置为 blocked，不启动 runner。
    try {
      await validateRunnableModelConfig(project, context.secretsRoot);
    } catch (modelError) {
      if (modelError instanceof ModelConfigValidationError) {
        const latestState = await loadState(projectRoot).catch(() => state);
        await saveState(projectRoot, {
          ...latestState,
          project_status: "blocked",
          current_stage: "idle",
          blocked_reason: "模型配置不完整"
        });
        for (const task of tasks) {
          await queue.markBlocked(task.id, "configuration_missing").catch(() => {});
        }
        sendError(response, new HttpError(400, "configuration_missing", "模型配置不完整", {
          fields: modelError.fields,
          action: "open_settings"
        }));
        return;
      }
      throw modelError;
    }
    let runStatus = { started: false, alreadyRunning: isJobRunning(context.runJobs.get(path.resolve(projectRoot))) };
    if (!runStatus.alreadyRunning) {
      const task = await queue.promoteNext();
      if (task) {
        runStatus = await startProjectRun(projectRoot, project, context, task, {
          source: "app_shell_composer",
          promoted_from_side_question: body.fromSideQuestion === true
        });
      }
    }
    await serveJson(response, {
      ok: true,
      projectRoot,
      queued: tasks.length,
      tasks,
      started: runStatus.started,
      alreadyRunning: runStatus.alreadyRunning,
      completed: runStatus.completed,
      blocked: runStatus.blocked,
      message:
        runStatus.message ??
        (runStatus.alreadyRunning ? "指令已记录；项目正在运行中。" : "指令已记录，写作任务已开始。")
    });
    });
  } catch (error) {
    if (error instanceof TaskContractError) {
      sendError(response, new HttpError(400, error.code, error.message, error.details ?? null));
      return;
    }
    sendError(response, error instanceof HttpError ? error : new HttpError(400, "command_submit_failed", error.message));
  }
}

async function serveChatSend(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const message = String(body.message ?? "").trim();
    if (!message) throw new Error("请输入要发送的消息。");
    if (message.length > 4000) throw new Error("消息过长。");
    const projectRoot = await resolveActiveWriteProjectRoot(context, body);
    const jobKey = path.resolve(projectRoot);
    if (context.chatJobs.has(jobKey)) {
      sendError(response, new HttpError(409, "CHAT_BUSY", "上一轮对话还在进行中，请等它完成或先点停止。"));
      return;
    }
    const controller = new AbortController();
    context.chatJobs.set(jobKey, { controller, startedAt: new Date().toISOString() });
    try {
      return await withProjectLock(context, projectRoot, async () => {
      const project = await loadProject(projectRoot);
      const registry = buildChatRegistry();
      const modelClient = context.testModel?.chatClient?.() ?? await buildChatModelClient(project, projectRoot);
      const result = await runChatTurn({
        projectRoot,
        project,
        registry,
        modelClient,
        userMessage: message,
        signal: controller.signal,
        server: chatServerContext(context),
        getTaskQueue: context.getTaskQueue
      });
      await modelClient.costTracker.writeProjectReport(projectRoot);
      await serveJson(response, { ok: true, ...result });
      });
    } finally {
      context.chatJobs.delete(jobKey);
    }
  } catch (error) {
    sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
  }
}

async function serveChatConfirm(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveWriteProjectRoot(context, body);
    const jobKey = path.resolve(projectRoot);
    if (context.chatJobs.has(jobKey)) {
      sendError(response, new HttpError(409, "CHAT_BUSY", "上一轮对话还在进行中，请等它完成或先点停止。"));
      return;
    }
    const controller = new AbortController();
    context.chatJobs.set(jobKey, { controller, startedAt: new Date().toISOString() });
    try {
      return await withProjectLock(context, projectRoot, async () => {
      const project = await loadProject(projectRoot);
      const registry = buildChatRegistry();
      const modelClient = context.testModel?.chatClient?.() ?? await buildChatModelClient(project, projectRoot);
      const result = await resumeChatTurn({
        projectRoot,
        project,
        registry,
        modelClient,
        approve: body.approve === true,
        signal: controller.signal,
        server: chatServerContext(context),
        getTaskQueue: context.getTaskQueue
      });
      await modelClient.costTracker.writeProjectReport(projectRoot);
      await serveJson(response, { ok: true, ...result });
      });
    } finally {
      context.chatJobs.delete(jobKey);
    }
  } catch (error) {
    sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
  }
}

async function serveChatHistory(url, response, context) {
  try {
    const projectRoot = context.projectRoot ?? await resolveActiveProjectRoot(context);
    const after = url.searchParams.get("after") ?? null;
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const messages = await readChatHistory(projectRoot, { after, limit });
    const pendingAction = await loadPendingAction(projectRoot);
    const jobKey = path.resolve(projectRoot);
    const job = context.chatJobs?.get(jobKey) ?? null;
    await serveJson(response, { ok: true, messages, pendingAction, busy: Boolean(job), busySince: job?.startedAt ?? null });
  } catch (error) {
    sendError(response, new HttpError(400, "BAD_REQUEST", error.message));
  }
}

async function serveChatStop(response, context) {
  try {
    const projectRoot = await resolveActiveProjectRoot(context);
    const job = context.chatJobs.get(path.resolve(projectRoot));
    if (!job) {
      sendError(response, new HttpError(409, "CONFLICT", "当前没有进行中的对话轮。"));
      return;
    }
    job.controller.abort("用户停止");
    await serveJson(response, { ok: true, message: "已请求停止本轮对话。" });
  } catch (error) {
    sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
  }
}

function chatServerContext(context) {
  return {
    runJobs: context.runJobs,
    getTaskQueue: context.getTaskQueue,
    startProjectRun: (projectRoot, project, _server, task, meta) =>
      context.startProjectRunFn(projectRoot, project, context, task, meta)
  };
}

function buildChatRegistry() {
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  registerControlTools(registry);
  return registry;
}

async function buildChatModelClient(project, projectRoot) {
  const existingCost = await readJson(safeJoin(projectRoot, "cost.json"), null);
  return new ModelClient({
    costTracker: new CostTracker({ pricing: buildPricingTable(project), summary: existingCost }),
    adapters: {
      "openai-compatible": new OpenAICompatibleAdapter(),
      mock: new MockProviderAdapter({
        response: () => ({ text: "（mock 模型不支持对话，请在设置里配置真实模型。）" })
      })
    }
  });
}

async function serveSideQuestion(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const question = String(body.question ?? body.message ?? "").trim();
    if (!question) {
      throw new Error("请输入要向智能体提出的问题。");
    }
    const projectRoot = await resolveActiveProjectRoot(context);
    // 旁路询问只读上下文并回答，不写入正文/章节/状态/计划文件，也不启动或打断写作任务。
    const result = await handleSideQuestion(projectRoot, question);
    await serveJson(response, { ...result, projectRoot });
  } catch (error) {
    sendError(response, new HttpError(400, error.code ?? "side_question_failed", error.message));
  }
}

async function serveQueueState(response, context) {
  try {
    const projectRoot = context.projectRoot ?? await resolveActiveProjectRoot(context);
    const queue = await context.getTaskQueue(projectRoot);
    await queue.load();
    await serveJson(response, queueSnapshot(queue, context.runJobs.get(path.resolve(projectRoot))));
  } catch (error) {
    sendError(response, new HttpError(400, "BAD_REQUEST", error.message));
  }
}

async function serveQueueCancel(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveWriteProjectRoot(context, body);
    await assertNotArchived(projectRoot);
    return await withProjectLock(context, projectRoot, async () => {
    const queue = await context.getTaskQueue(projectRoot);
    const task = await queue.cancel(String(body.taskId ?? ""), body.reason ?? "用户取消");
    if (!task) {
      sendError(response, new HttpError(400, "BAD_REQUEST", "只能取消排队中的任务；运行中的任务请使用停止。"));
      return;
    }
    await serveJson(response, { ok: true, task, ...queueSnapshot(queue, null) });
    });
  } catch (error) {
    sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
  }
}

// 终态项目状态：一旦项目落到这些状态，停止请求就不该再把它拉回 cancelling。
// 用于关闭「双击/重复停止」竞态：当 runner 已收敛到 cancelled 后，迟到的第二次
// 停止读到终态就跳过持久化，避免复活一个已结束的任务、让重试永久 409。
const STOP_IGNORED_STATUSES = new Set(["cancelled", "completed", "blocked", "interrupted", "error"]);

async function serveRunStop(response, context) {
  // 红线：停止路径绝不能包 withProjectLock。定稿或错误收敛会持锁，
  // 让 500ms 内的 cancelling 确认被阻塞。这里只写状态、abort、回包，全程不取项目锁。
  try {
    const projectRoot = await resolveActiveProjectRoot(context);
    await assertNotArchived(projectRoot);
    const job = context.runJobs.get(path.resolve(projectRoot));
    if (!isJobRunning(job) && job?.status !== "cancelling") {
      sendError(response, new HttpError(409, "CONFLICT", "当前没有正在运行的写作任务。"));
      return;
    }
    const queue = await context.getTaskQueue(projectRoot);
    const state = await loadState(projectRoot);
    const requestedAt = state.stop_requested_at ?? new Date().toISOString();
    const alreadyCancelling = state.project_status === "cancelling";
    const alreadyTerminal = STOP_IGNORED_STATUSES.has(state.project_status);
    // 仅在项目仍处于「活动且尚未 cancelling」时才持久化 cancelling。
    // - alreadyCancelling：重复停止保持幂等（只发一个 project_cancelling 事件，仍回 cancelling）。
    // - alreadyTerminal：runner 已经收敛到终态，跳过持久化，避免把终态复活成 cancelling。
    if (!alreadyCancelling && !alreadyTerminal) {
      await saveState(projectRoot, {
        ...state,
        project_status: "cancelling",
        stop_requested_at: requestedAt
      });
      await queue.markCancelling(job.taskId, "用户停止");
      await appendEvent(projectRoot, {
        type: "project_cancelling",
        chapter_no: state.current_chapter_no,
        stage: state.current_stage,
        message: "用户请求立即停止",
        data: { task_id: job.taskId, stop_requested_at: requestedAt }
      });
    }
    // 只在任务仍在运行或正在 cancelling 时翻状态/abort；任务若已收敛到终态，
    // 不要把它的状态拨回 cancelling，也不要对已死的 controller 再 abort。
    if (isJobRunning(job) || job?.status === "cancelling") {
      job.status = "cancelling";
      if (!job.controller.signal.aborted) {
        job.controller.abort("用户停止");
      }
    }
    await serveJson(response, {
      ok: true,
      projectRoot,
      taskId: job.taskId,
      status: "cancelling",
      message: "正在停止当前任务，草稿将保留。"
    });
  } catch (error) {
    sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
  }
}

async function serveRunRetry(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveWriteProjectRoot(context, body);
    await assertNotArchived(projectRoot);
    return await withProjectLock(context, projectRoot, async () => {
    const queue = await context.getTaskQueue(projectRoot);
    const candidate = await resolveRetryCandidate({
      projectRoot,
      queue,
      job: context.runJobs.get(path.resolve(projectRoot)),
      taskId: body.taskId ? String(body.taskId) : null
    });
    if (!candidate.available) {
      sendError(response, new HttpError(candidate.status ?? 400, candidate.code, candidate.reason));
      return;
    }
    let task = null;
    if (candidate.candidateSource === "project_state") {
      const stateForRecovery = await loadState(projectRoot);
      task = await queue.createRecoveryTask({
        instruction: stateForRecovery.last_user_instruction ?? "继续当前写作任务",
        mode: "write",
        currentStage: stateForRecovery.current_stage ?? "queued",
        recovery: candidate.recovery
      });
    } else if (candidate.candidateSource === "stale_queue_task") {
      task = queue.getState().tasks.find((item) => item.id === candidate.taskId) ?? null;
    } else {
      task = await queue.retry(candidate.taskId);
    }
    if (!task) {
      sendError(response, new HttpError(400, "retry_no_candidate", "当前没有可重试的任务。"));
      return;
    }
    const state = await loadState(projectRoot);
    const nextState = {
      ...state,
      project_status: "running",
      current_stage: state.current_stage && !["idle", "completed", "blocked"].includes(state.current_stage) ? state.current_stage : "queued"
    };
    delete nextState.interrupted_reason;
    delete nextState.interrupted_at;
    delete nextState.cancelled_reason;
    delete nextState.cancelled_at;
    await saveState(projectRoot, nextState);
    const project = await loadProject(projectRoot);
    try {
      const started = await startProjectRun(projectRoot, project, context, task, { source: "task_queue_retry" });
      if (started?.alreadyRunning) {
        sendError(response, new HttpError(409, "retry_already_running", "智能体仍在运行，请先停止当前任务。"));
        return;
      }
    } catch (error) {
      sendError(response, new HttpError(500, "retry_start_failed", error.message));
      return;
    }
    await serveJson(response, { ok: true, message: "已从中断处继续。", task });
    });
  } catch (error) {
    sendError(response, error);
  }
}

async function listAllowedModels(projectRoot) {
  const project = await loadProject(projectRoot);
  const config = await loadConfigLayers(projectRoot, project);
  const list = config.effective?.allowed_models;
  const models = Array.isArray(list) && list.length > 0
    ? list
    : config.effective?.active_model
      ? [config.effective.active_model]
      : [];
  return models
    .map((model) => (typeof model === "string" ? model : model?.model_name))
    .filter(Boolean);
}

async function serveFailuresResolve(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const { command, args = {}, failureId } = body;
    if (!failureId) {
      sendError(response, new HttpError(400, "BAD_REQUEST", "缺少 failureId"));
      return;
    }
    const projectRoot = await resolveActiveWriteProjectRoot(context, body);
    await assertNotArchived(projectRoot);
    const valid = validateFailureCommand(command, args);
    if (!valid.ok) {
      await appendEvent(projectRoot, {
        type: "failure_command_rejected",
        severity: "warn",
        message: valid.error,
        data: { command, failureId }
      });
      sendError(response, new HttpError(400, "BAD_REQUEST", valid.error));
      return;
    }
    if (command === "switch-model") {
      const allowed = await listAllowedModels(projectRoot);
      if (!allowed.includes(args.modelId)) {
        sendError(response, new HttpError(400, "BAD_REQUEST", "modelId 不在允许列表"));
        return;
      }
    }
    // 查重与落账必须在同一把项目锁内，否则双击会让两个请求都通过「未处理」检查。
    return await withProjectLock(context, projectRoot, async () => {
    const failures = readFailures(projectRoot);
    const match = failures.find((f) => f.id === failureId);
    if (!match) {
      sendError(response, new HttpError(404, "NOT_FOUND", "故障卡不存在"));
      return;
    }
    if (match.resolution) {
      sendError(response, new HttpError(409, "CONFLICT", "故障卡已处理"));
      return;
    }
    markResolved(projectRoot, failureId, {
      action: command,
      submittedAt: new Date().toISOString(),
      args
    });
    await appendEvent(projectRoot, {
      type: "failure_resolved",
      project_id: (await loadProject(projectRoot)).project_id,
      severity: "info",
      message: command,
      data: { failureId, args }
    });
    const applied = await applyFailureResolution(projectRoot, { command, args });
    let resumed = false;
    if (applied.resumeRun) {
      const job = context.runJobs.get(path.resolve(projectRoot));
      if (!isJobRunning(job)) {
        const queue = await context.getTaskQueue(projectRoot);
        const stateNow = await loadState(projectRoot);
        const task =
          (await queue.createRecoveryTask({
            instruction: stateNow.last_user_instruction ?? "继续当前写作任务",
            mode: "write",
            currentStage: stateNow.current_stage ?? "queued",
            recovery: { reason: `failure:${command}` }
          })) ?? (await queue.promoteNext());
        if (task) {
          const project = await loadProject(projectRoot);
          const started = await startProjectRun(projectRoot, project, context, task, { source: "failure_card" });
          resumed = started.started === true;
        }
      }
    }
    await serveJson(response, { ok: true, resumed, message: applied.message });
    });
  } catch (err) {
    sendError(response, err);
  }
}

async function startProjectRun(projectRoot, project, context, task, instructionMeta = {}) {
  const runJobs = context.runJobs;
  const key = path.resolve(projectRoot);
  const existing = runJobs.get(key);
  if (isJobRunning(existing)) {
    return { started: false, alreadyRunning: true, message: "指令已记录；项目正在运行中。" };
  }
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  const job = {
    promise: null,
    controller,
    startedAt,
    lastHeartbeat: startedAt,
    status: "running",
    error: null,
    taskId: task.id
  };
  runJobs.set(key, job);
  const state = await loadState(projectRoot);
  if (state.project_status === "completed") {
    job.status = "done";
    const queue = await context.getTaskQueue(projectRoot);
    await queue.complete(task.id, { completed: true, skipped: true });
    await appendEvent(projectRoot, {
      type: "project_run_skipped",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: state.current_stage,
      message: "项目已完成，未启动新的写作任务。"
    });
    return { started: false, alreadyRunning: false, completed: true, message: "项目已完成；在「设置 → 写作目标」里提高目标章节数即可继续。" };
  }
  if (state.project_status === "blocked") {
    job.status = "error";
    job.error = state.blocked_reason ?? "blocked";
    const queue = await context.getTaskQueue(projectRoot);
    await queue.block(task.id, job.error);
    await appendEvent(projectRoot, {
      type: "project_run_skipped",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: state.current_stage,
      severity: "warn",
      message: "项目处于阻塞状态，未启动新的写作任务。"
    });
    return { started: false, alreadyRunning: false, blocked: true, message: "项目已阻塞；请先处理错误后再继续。" };
  }
  const runningState = {
    ...state,
    project_status: "running",
    current_stage: state.current_stage && state.current_stage !== "idle" ? state.current_stage : "queued"
  };
  const contractForRun = task.source === "project_state_recovery" || !task.contract
    ? makeResumeContract(state.current_chapter_no ?? 1)
    : task.contract;
  try {
    validateTaskContract(contractForRun, {
      currentChapter: state.current_chapter_no,
      targetChapters: project.target_chapters
    });
  } catch (error) {
    if (error instanceof TaskContractError) {
      await appendEvent(projectRoot, {
        type: "task_contract_rejected",
        project_id: project.project_id,
        stage: state.current_stage,
        severity: "warn",
        message: error.message,
        data: {
          code: error.code,
          task_id: task.id,
          currentChapter: state.current_chapter_no ?? 1
        }
      });
    }
    job.status = "error";
    job.error = error.message;
    runJobs.delete(key);
    const queue = await context.getTaskQueue(projectRoot);
    await queue.block(task.id, error.message).catch(() => {});
    throw error;
  }
  await saveState(projectRoot, runningState);
  await appendEvent(projectRoot, {
    type: "user_instruction_received",
    project_id: project.project_id,
    stage: "user_input",
    message: task.instruction,
    data: {
      source: instructionMeta.source ?? "task_queue",
      mode: task.mode,
      task_id: task.id,
      promoted_from_side_question: instructionMeta.promoted_from_side_question === true,
      note: "章节正文仍必须由受控文件工具写入本地文件。"
    }
  });
  await appendEvent(projectRoot, {
    type: "project_run_started",
    project_id: project.project_id,
    chapter_no: runningState.current_chapter_no,
    stage: runningState.current_stage,
    message: "写作任务已由命令栏启动。"
  });
  const runner = context.testRunProject ?? runProject;
  job.promise = runner(projectRoot, {
    model: context.testModel ?? undefined,
    signal: controller.signal,
    taskId: task.id,
    contract: contractForRun,
    onHeartbeat: async ({ stage, chapter, step } = {}) => {
      job.lastHeartbeat = new Date().toISOString();
      const queue = await context.getTaskQueue(projectRoot);
      await queue.updateRunning(task.id, { currentStage: stage, heartbeatAt: job.lastHeartbeat, chapter, step });
    },
    onActivity: () => { job.lastHeartbeat = new Date().toISOString(); }
  })
    .then(async (result) => {
      return await withProjectLock(context, projectRoot, async () => {
      const queue = await context.getTaskQueue(projectRoot);
      if (controller.signal.aborted) {
        throw new ProjectCancelledError(controller.signal.reason ?? "cancelled");
      }
      if (result?.blocked) {
        job.status = "error";
        job.error = result.reason ?? "blocked";
        await queue.block(task.id, job.error);
        const latestState = await loadState(projectRoot).catch(() => runningState);
        if (latestState.project_status !== "blocked") {
          await saveState(projectRoot, {
            ...latestState,
            project_status: "blocked",
            current_stage: "blocked",
            blocked_reason: job.error,
            blocked_at: new Date().toISOString()
          });
        }
        await appendEvent(projectRoot, {
          type: "project_blocked",
          project_id: project.project_id,
          stage: "blocked",
          severity: "error",
          message: job.error,
          data: {
            task_id: task.id
          }
        });
        return;
      }
      if (result?.paused) {
        job.status = "done";
        await queue.complete(task.id, result);
        await appendEvent(projectRoot, {
          type: "project_run_finished",
          project_id: project.project_id,
          stage: "run",
          message: "已按你的要求停在这里。",
          data: result
        });
        return;
      }
      await queue.complete(task.id, result);
      await appendEvent(projectRoot, {
        type: "project_run_finished",
        project_id: project.project_id,
        stage: "run",
        message: (result?.completed || result?.task_completed || result?.project_completed) ? "写作任务已完成。" : "写作任务已停止。",
        data: result
      });
      const latestState = await loadState(projectRoot).catch(() => runningState);
      if (!["completed", "blocked"].includes(latestState.project_status)) {
        job.status = "done";
        const nextTask = await queue.promoteNext();
        if (nextTask) {
        await startProjectRun(projectRoot, project, context, nextTask, { source: "task_queue_auto_advance" });
        }
      } else {
        job.status = latestState.project_status === "blocked" ? "error" : "done";
      }
      });
    })
    .catch(async (error) => {
      return await withProjectLock(context, projectRoot, async () => {
      const queue = await context.getTaskQueue(projectRoot);
      const latestState = await loadState(projectRoot).catch(() => runningState);
      if (controller.signal.aborted || error instanceof ProjectCancelledError || latestState.project_status === "cancelled" || latestState.project_status === "cancelling") {
        job.status = "cancelled";
        job.error = error.message;
        await queue.abortRunning(error.message, task.id);
        const cancelledAt = new Date().toISOString();
        const stopRequestedAt = latestState.stop_requested_at ?? cancelledAt;
        const stopLatencyMs = Math.max(0, Date.parse(cancelledAt) - Date.parse(stopRequestedAt));
        await saveState(projectRoot, {
          ...latestState,
          project_status: "cancelled",
          cancelled_reason: error.message,
          stop_requested_at: stopRequestedAt,
          cancel_observed_at: cancelledAt,
          cancelled_at: cancelledAt,
          stop_latency_ms: stopLatencyMs
        });
        await appendEvent(projectRoot, {
          type: "project_cancelled",
          project_id: project.project_id,
          chapter_no: latestState.current_chapter_no,
          stage: latestState.current_stage,
          message: "写作任务已停止，草稿已保留。",
          data: {
            task_id: task.id,
            stop_requested_at: stopRequestedAt,
            cancel_observed_at: cancelledAt,
            cancelled_at: cancelledAt,
            stop_latency_ms: stopLatencyMs
          }
        });
      } else {
        job.status = "error";
        job.error = error.message;
        if (latestState.project_status === "blocked") {
          await queue.block(task.id, error);
        } else {
          await queue.interrupt(task.id, error);
          if (latestState.project_status !== "interrupted") {
          await saveState(projectRoot, {
            ...latestState,
            project_status: "interrupted",
            interrupted_reason: error.message,
            interrupted_at: new Date().toISOString()
          });
          }
        }
        await appendEvent(projectRoot, {
          type: "project_run_failed",
          project_id: project.project_id,
          stage: "run",
          severity: "error",
          message: error.message,
          data: {
            name: error.name,
            stack: error.stack?.slice(0, 2000)
          }
        });
      }
      });
    })
    .catch((error) => {
      job.status = "error";
      job.error = error.message;
    });
  runJobs.set(key, job);
  return { started: true, alreadyRunning: false };
}

async function serveChapterRead(url, response, context) {
  try {
    const projectRoot = context.projectRoot ?? await resolveActiveProjectRoot(context);
    const chapterNo = url.searchParams.get("chapter") ?? url.searchParams.get("chapter_no");
    const data = await readChapterContent(projectRoot, chapterNo);
    await serveJson(response, { ...data, projectRoot });
  } catch (error) {
    sendError(response, new HttpError(400, "chapter_read_failed", error.message));
  }
}

async function resolveActiveProjectRoot({ selected }) {
  if (!selected) {
    throw new Error("当前没有可用项目。");
  }
  const target = path.resolve(selected);
  await validateProjectRoot(target);
  return target;
}

// 显式请求作用域：读请求以请求携带的 projectRoot 为准，缺省回落到当前选中项目。
// 目标项目必须仍是「已注册」的（当前选中、最近列表里、或工作区内部），且磁盘上有 project.yaml，
// 否则返回 400 INVALID_PROJECT_SCOPE。读请求绝不改写 selected。
async function resolveReadProjectRoot({ requestedRoot, selected, workspace, stateRoot }) {
  const target = requestedRoot ?? selected;
  if (!target) {
    throw new HttpError(404, "no_project", "当前没有打开的项目");
  }
  const resolvedTarget = path.resolve(target);
  let registered = samePath(selected, resolvedTarget);
  if (!registered && workspace && isPathInside(path.resolve(workspace), resolvedTarget)) {
    registered = true;
  }
  if (!registered) {
    const state = await loadAppState(stateRoot);
    registered = state.recentProjects.some((project) => samePath(project.projectRoot, resolvedTarget));
  }
  if (!registered || !existsSync(path.join(resolvedTarget, "project.yaml"))) {
    throw new HttpError(400, "INVALID_PROJECT_SCOPE", "请求的项目未注册");
  }
  return resolvedTarget;
}

// 写请求在读作用域校验之外，还要求「请求/期望的项目」与当前选中项目一致，
// 否则在用户切换项目的瞬间写入会落到错误的项目。不一致时返回 409 PROJECT_SCOPE_CHANGED。
// 向后兼容：未携带 expectedProjectRoot 且请求目标即当前选中项目时，等价于旧行为。
async function resolveWriteProjectRoot({ requestedRoot, expectedProjectRoot, selected, workspace, stateRoot }) {
  const target = await resolveReadProjectRoot({ requestedRoot, selected, workspace, stateRoot });
  const expected = expectedProjectRoot ?? target;
  if (!samePath(expected, selected) || !samePath(target, selected)) {
    throw new HttpError(409, "PROJECT_SCOPE_CHANGED", "项目已切换，请确认后重试");
  }
  return target;
}

// 写端点统一入口：从 context 取 selected/workspace/stateRoot，从 body 取请求/期望项目。
// 未携带显式作用域字段时回落到旧的「校验当前选中项目」行为，保持既有测试与调用方兼容。
async function resolveActiveWriteProjectRoot(context, body = {}) {
  const projectRoot = await resolveWriteProjectRoot({
    requestedRoot: body?.projectRoot ?? undefined,
    expectedProjectRoot: body?.expectedProjectRoot ?? undefined,
    selected: context.selected,
    workspace: context.workspace,
    stateRoot: context.stateRoot
  });
  await validateProjectRoot(projectRoot);
  return projectRoot;
}

async function readJsonBody(request) {
  let source = "";
  for await (const chunk of request) {
    source += chunk.toString("utf8");
    if (source.length > 200_000) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "请求体过大");
    }
  }
  return source ? JSON.parse(source) : {};
}

async function serveJson(response, data, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(data));
}

async function serveStatic(pathname, response, { staticRoot }) {
  const sharedPrefix = "/shared/";
  const isSharedModule = pathname.startsWith(sharedPrefix);
  const root = pathname.startsWith(sharedPrefix)
    ? path.resolve(staticRoot, "..", "shared")
    : path.resolve(staticRoot);
  const requested = pathname === "/"
    ? "/index.html"
    : pathname.startsWith(sharedPrefix)
      ? pathname.slice(sharedPrefix.length - 1)
      : pathname;
  if (isSharedModule && ![".js", ".mjs"].includes(path.extname(requested))) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("未找到");
    return;
  }
  const target = path.resolve(root, `.${requested}`);
  if (!isPathInside(root, target)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("禁止访问");
    return;
  }
  try {
    const content = await fs.readFile(target);
    response.writeHead(200, {
      "content-type": contentType(target),
      "cache-control": "no-store"
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("未找到");
  }
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/html; charset=utf-8";
}

function isSafeSkillName(name) {
  return typeof name === "string" && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(name);
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    return fallback;
  }
  return number;
}
