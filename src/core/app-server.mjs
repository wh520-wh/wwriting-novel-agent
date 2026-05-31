import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { canInitializeProjectRoot, loadDashboardData, readChapterContent, validateProjectRoot } from "./app-dashboard.mjs";
import { forgetRecentProject, loadAppStateSync, loadAppState, recordRecentProject, samePath } from "./app-state.mjs";
import { loadConfigLayers } from "./config-runtime.mjs";
import { appendEvent } from "./event-log.mjs";
import { isPathInside } from "./fs-utils.mjs";
import { applyLocalSecretsToEnv, defaultSecretsRoot, loadLocalSecretsSync, saveLocalSecret } from "./local-secrets.mjs";
import { createProjectAt, loadProject, loadState, saveProject, saveState } from "./project-store.mjs";
import { createResearchAdapter } from "./research-adapters.mjs";
import { fetchWebPage, searchWeb } from "./research-tools.mjs";
import { updateProjectSettings } from "./settings-runtime.mjs";
import { ensureBuiltinSkill, importProjectSkill, listProjectSkills } from "./skill-runtime.mjs";
import { ProjectCancelledError, runProject } from "./agent-engine.mjs";
import { handleSideQuestion } from "./side-question.mjs";
import { expandInstruction, TaskQueue } from "./task-queue.mjs";
import { resolveRetryCandidate, retryDashboardFields } from "./retry-candidates.mjs";

export function createAppShellServer({
  workspaceRoot = path.resolve("."),
  selectedProjectRoot = null,
  staticRoot = path.resolve("src", "app-shell"),
  secretsRoot = process.env.WWRITING_SECRETS_ROOT ?? defaultSecretsRoot(),
  stateRoot = null,
  port = 4173,
  testModel = null,
  testRunProject = null
} = {}) {
  const workspace = path.resolve(workspaceRoot);
  const localSecretsRoot = path.resolve(secretsRoot);
  const appStateRoot = path.resolve(stateRoot ?? secretsRoot);
  applyLocalSecretsToEnv(loadLocalSecretsSync(localSecretsRoot));
  const runJobs = new Map();
  const taskQueues = new Map();
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
      const data = await serveDashboard(response, { workspace, selected, secretsRoot: localSecretsRoot, runJobs, getTaskQueue });
      if (data?.hasProject && data.projectRoot) {
        selected = data.projectRoot;
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
      const initialized = await serveProjectInit(request, response);
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
    if (url.pathname === "/api/research/search" && request.method === "POST") {
      await serveResearch(request, response, { workspace, selected, action: "search" });
      return;
    }
    if (url.pathname === "/api/research/fetch" && request.method === "POST") {
      await serveResearch(request, response, { workspace, selected, action: "fetch" });
      return;
    }
    if (url.pathname === "/api/settings/update" && request.method === "POST") {
      await serveSettingsUpdate(request, response, { workspace, selected, secretsRoot: localSecretsRoot });
      return;
    }
    if (url.pathname === "/api/commands/submit" && request.method === "POST") {
      await serveCommandSubmit(request, response, { workspace, selected, runJobs, getTaskQueue, testModel, testRunProject });
      return;
    }
    if (url.pathname === "/api/run/retry" && request.method === "POST") {
      await serveRunRetry(request, response, { workspace, selected, runJobs, getTaskQueue, testModel, testRunProject });
      return;
    }
    if (url.pathname === "/api/run/stop" && request.method === "POST") {
      await serveRunStop(response, { workspace, selected, runJobs, getTaskQueue });
      return;
    }
    if (url.pathname === "/api/queue/state" && request.method === "GET") {
      await serveQueueState(response, { workspace, selected, getTaskQueue, runJobs });
      return;
    }
    if (url.pathname === "/api/queue/cancel" && request.method === "POST") {
      await serveQueueCancel(request, response, { workspace, selected, getTaskQueue });
      return;
    }
    if (url.pathname === "/api/commands/ask" && request.method === "POST") {
      await serveSideQuestion(request, response, { workspace, selected });
      return;
    }
    if (url.pathname === "/api/chapters/read") {
      await serveChapterRead(url, response, { workspace, selected });
      return;
    }
    await serveStatic(url.pathname, response, staticRoot);
  });
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    abortActiveJobs(runJobs, "Application shutdown");
    return originalClose(callback);
  };
  return server;
}

async function serveDashboard(response, context) {
  try {
    const data = await loadDashboardData(context.workspace, {
      projectRoot: context.selected,
      allowExternalProjectRoot: Boolean(context.selected),
      disableProjectFallback: !context.selected
    });
    if (data?.hasProject) {
      data.model_profile = buildModelProfile(data.project?.active_model, context.secretsRoot);
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
    }
    await serveJson(response, data);
    return data;
  } catch (error) {
    await serveJson(response, { ok: false, message: error.message }, 500);
    return null;
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
    try {
      const project = await loadProject(root);
      title = project.title ?? title;
      storySeed = project.story_seed ?? storySeed;
      const config = await loadConfigLayers(root, project).catch(() => null);
      activeModel = config?.effective?.active_model ?? project.active_model ?? null;
    } catch {}
    projects.push({
      projectRoot: root,
      title,
      story_seed: storySeed,
      active_model: activeModel,
      model_label: modelDisplayName(activeModel),
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
    await serveJson(response, { ok: false, message: error.message }, error instanceof SyntaxError ? 400 : 500);
  }
}

async function rememberProject(stateRoot, projectRoot) {
  try {
    const project = await loadProject(projectRoot);
    await recordRecentProject(stateRoot, { projectRoot, title: project.title, story_seed: project.story_seed });
  } catch {
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
    await serveJson(
      response,
      {
        ok: false,
        code: "project_open_failed",
        message: error.message
      },
      400
    );
    return null;
  }
}

async function serveProjectForget(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const rawRoot = String(body.projectRoot ?? body.path ?? "").trim();
    if (!rawRoot) {
      await serveJson(response, { ok: false, code: "project_forget_failed", message: "项目路径不能为空。" }, 400);
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
    await serveJson(response, { ok: false, code: "project_forget_failed", message: error.message }, 400);
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

async function serveProjectInit(request, response) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await canInitializeProjectRoot(body.projectRoot ?? body.path ?? "");
    const title = String(body.title ?? "").trim() || path.basename(projectRoot) || "未命名小说";
    const storySeed = String(body.story_seed ?? "").trim() || "一个人在雨夜收到一封没有署名的信。";
    const targetChapters = normalizePositiveInteger(body.target_chapters, 100);
    const minWordsPerChapter = normalizePositiveInteger(body.min_words_per_chapter, 3000);
    const targetWordsPerChapter = normalizePositiveInteger(body.target_words_per_chapter, Math.max(minWordsPerChapter, 3300));
    const outputFormat = ["md", "txt"].includes(body.output_format) ? body.output_format : "md";
    const { project } = await createProjectAt(projectRoot, {
      title,
      story_seed: storySeed,
      target_chapters: targetChapters,
      min_words_per_chapter: minWordsPerChapter,
      target_words_per_chapter: targetWordsPerChapter,
      output_format: outputFormat
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
    await serveJson(
      response,
      {
        ok: false,
        code: "project_init_failed",
        message: error.message
      },
      400
    );
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
    await serveJson(
      response,
      {
        ok: false,
        code: error.code ?? "research_failed",
        message: error.message
      },
      error.code === "network_not_allowed" ? 403 : 400
    );
  }
}

async function serveSettingsUpdate(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveProjectRoot(context);
    const secretResult = await persistModelSecretIfPresent(body, context.secretsRoot);
    const project = await updateProjectSettings(projectRoot, body);
    const config = await loadConfigLayers(projectRoot, project);
    await serveJson(response, {
      ok: true,
      projectRoot,
      project: {
        project_id: project.project_id,
        active_model: project.active_model,
        stage_overrides: project.stage_overrides,
        tool_permissions: project.tool_permissions,
        budget_config: project.budget_config,
        research_config: project.research_config
      },
      effective_config: config.effective,
      model_profile: buildModelProfile(config.effective.active_model, context.secretsRoot),
      secret_saved: secretResult.saved,
      secret_env: secretResult.envName
    });
  } catch (error) {
    await serveJson(
      response,
      {
        ok: false,
        code: error.code ?? "settings_update_failed",
        message: error.message
      },
      400
    );
  }
}

async function persistModelSecretIfPresent(body, secretsRoot) {
  const apiKey = body.active_model?.api_key ?? body.api_key;
  if (body.active_model) {
    delete body.active_model.api_key;
  }
  delete body.api_key;
  if (!apiKey) {
    return { saved: false, envName: body.active_model?.api_key_env ?? null };
  }
  const envName = body.active_model?.api_key_env;
  const result = await saveLocalSecret(secretsRoot, envName, apiKey);
  return { saved: true, envName: result.envName };
}

function buildModelProfile(activeModel = {}, secretsRoot) {
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
    api_key_value: secretValue,
    is_mock: provider === "mock",
    display: modelDisplayName(activeModel),
    saved_to: "project.yaml"
  };
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

function abortActiveJobs(runJobs, reason) {
  for (const job of runJobs.values()) {
    if (isJobRunning(job) && !job.controller.signal.aborted) {
      job.controller.abort(reason);
    }
  }
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

async function serveSkillMutation(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveProjectRoot(context);
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
    await serveJson(
      response,
      {
        ok: false,
        message: error.message
      },
      400
    );
  }
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
    const projectRoot = await resolveActiveProjectRoot(context);
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
        message: "项目已完成；如需继续写，请先增加目标章节数。"
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
    const instructions = expandInstruction(message, { currentChapter: state.current_chapter_no ?? 1 });
    const tasks = [];
    for (const instruction of instructions) {
      tasks.push(await queue.enqueue(instruction, { mode }));
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
  } catch (error) {
    await serveJson(
      response,
      {
        ok: false,
        code: "command_submit_failed",
        message: error.message
      },
      400
    );
  }
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
    await serveJson(
      response,
      {
        ok: false,
        code: error.code ?? "side_question_failed",
        message: error.message
      },
      400
    );
  }
}

async function serveQueueState(response, context) {
  try {
    const projectRoot = await resolveActiveProjectRoot(context);
    const queue = await context.getTaskQueue(projectRoot);
    await queue.load();
    await serveJson(response, queueSnapshot(queue, context.runJobs.get(path.resolve(projectRoot))));
  } catch (error) {
    await serveJson(response, { ok: false, message: error.message }, 400);
  }
}

async function serveQueueCancel(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveProjectRoot(context);
    const queue = await context.getTaskQueue(projectRoot);
    const task = await queue.cancel(String(body.taskId ?? ""), body.reason ?? "用户取消");
    if (!task) {
      await serveJson(response, { ok: false, message: "只能取消排队中的任务；运行中的任务请使用停止。" }, 400);
      return;
    }
    await serveJson(response, { ok: true, task, ...queueSnapshot(queue, null) });
  } catch (error) {
    await serveJson(response, { ok: false, message: error.message }, 400);
  }
}

async function serveRunStop(response, context) {
  try {
    const projectRoot = await resolveActiveProjectRoot(context);
    const job = context.runJobs.get(path.resolve(projectRoot));
    if (!isJobRunning(job)) {
      await serveJson(response, { ok: false, message: "当前没有正在运行的写作任务。" }, 409);
      return;
    }
    job.controller.abort("用户停止");
    await serveJson(response, { ok: true, message: "已请求停止当前任务。" });
  } catch (error) {
    await serveJson(response, { ok: false, message: error.message }, 400);
  }
}

async function serveRunRetry(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveProjectRoot(context);
    const queue = await context.getTaskQueue(projectRoot);
    const candidate = await resolveRetryCandidate({
      projectRoot,
      queue,
      job: context.runJobs.get(path.resolve(projectRoot)),
      taskId: body.taskId ? String(body.taskId) : null
    });
    if (!candidate.available) {
      await serveJson(response, { ok: false, code: candidate.code, message: candidate.reason }, candidate.status ?? 400);
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
      await serveJson(response, { ok: false, code: "retry_no_candidate", message: "当前没有可重试的任务。" }, 400);
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
        await serveJson(response, { ok: false, code: "retry_already_running", message: "智能体仍在运行，请先停止当前任务。" }, 409);
        return;
      }
    } catch (error) {
      await serveJson(response, { ok: false, code: "retry_start_failed", message: error.message }, 500);
      return;
    }
    await serveJson(response, { ok: true, message: "已从中断处继续。", task });
  } catch (error) {
    await serveJson(response, { ok: false, message: error.message }, 500);
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
    return { started: false, alreadyRunning: false, completed: true, message: "项目已完成；如需继续写，请先增加目标章节数。" };
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
    onHeartbeat: async ({ stage, chapter, step } = {}) => {
      job.lastHeartbeat = new Date().toISOString();
      const queue = await context.getTaskQueue(projectRoot);
      await queue.updateRunning(task.id, { currentStage: stage, heartbeatAt: job.lastHeartbeat, chapter, step });
    }
  })
    .then(async (result) => {
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
      await queue.complete(task.id, result);
      await appendEvent(projectRoot, {
        type: "project_run_finished",
        project_id: project.project_id,
        stage: "run",
        message: result.completed ? "写作任务已完成。" : "写作任务已停止。",
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
    })
    .catch(async (error) => {
      const queue = await context.getTaskQueue(projectRoot);
      const latestState = await loadState(projectRoot).catch(() => runningState);
      if (controller.signal.aborted || error instanceof ProjectCancelledError || latestState.project_status === "cancelled") {
        job.status = "cancelled";
        job.error = error.message;
        await queue.abortRunning(error.message, task.id);
        await saveState(projectRoot, {
          ...latestState,
          project_status: "cancelled",
          cancelled_reason: error.message,
          cancelled_at: new Date().toISOString()
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
    const projectRoot = await resolveActiveProjectRoot(context);
    const chapterNo = url.searchParams.get("chapter") ?? url.searchParams.get("chapter_no");
    const data = await readChapterContent(projectRoot, chapterNo);
    await serveJson(response, { ...data, projectRoot });
  } catch (error) {
    await serveJson(
      response,
      {
        ok: false,
        code: "chapter_read_failed",
        message: error.message
      },
      400
    );
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

async function readJsonBody(request) {
  let source = "";
  for await (const chunk of request) {
    source += chunk.toString("utf8");
    if (source.length > 200_000) {
      throw new Error("请求内容过大。");
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

async function serveStatic(pathname, response, staticRoot) {
  const root = path.resolve(staticRoot);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const target = path.resolve(root, `.${requested}`);
  if (!isPathInside(root, target)) {
    response.writeHead(403);
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
    response.writeHead(404);
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
