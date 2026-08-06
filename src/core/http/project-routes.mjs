// src/core/http/project-routes.mjs —— 项目/章节/导出/资料/诊断路由
//（统一 Agent 内核计划 Task 7 Step 3）。
//
// 从旧 src/core/app-server.mjs 按职责提取（只读参考，不改旧文件）：项目列表/打开/
// 忘记/初始化、章节读取、资料搜索/抓取、诊断与 dashboard 的 handler 逻辑迁入本模块，
// 保持既有非 Agent HTTP 契约。新增确定性导出路由 POST /api/projects/export-book：
// 直接调用 book-export.mjs（在项目锁下），不调用 ProjectAgent、不创建 Run、不追加
// 模型 transcript，也不注册 export_book 为 Agent 工具。
//
// 本模块不创建 ModelClient、锁或 store；projectLocks 由 composition root 注入。
//
// 模块间职责（Task 7 评审记录）：模型档案展示 helper（buildModelProfile 等）与
// 全局模型同步（syncProjectModelFromGlobal）归属 settings-routes（设置/模型职责），
// project-routes 跨模块 import 它们——这是有意的单向依赖（settings-routes 不回
// 引 project-routes，无环）。selectedRef/ctx/assertNotArchived 在 project-routes
// 与 settings-routes 各自持有同一注入的 selection 引用、重复少量样板：抽公共
// helper 需要同时改两个模块的工厂签名，收益有限，Task 9 组合根落定时若出现
// 第三处重复再统一抽取。
//
// Task 9 衔接点：
//   - diagnostics handler 已按计划形状把 agent.snapshot() 结果传给稳定 diagnostics
//     loader（loadProjectDiagnostics(projectRoot, { agentSnapshot })）。当前 loader
//     签名仍为单参数、忽略 snapshot（Task 9 才改为消费它并停止读 TaskQueue/旧状态）；
//     本 handler 的传参形状与 Task 9 的 loader 签名一致，无需再改。
//   - /api/dashboard 只返回领域事实 + 模型档案：旧 handler 的 runJobs/queue/retry/
//     recovery 字段随 Task 9 的 app-dashboard 重写删除，不再进入新路由。
import path from "node:path";
import { existsSync } from "node:fs";
import { HttpError } from "../http-error.mjs";
import { exportBook } from "../book-export.mjs";
import { loadDashboardData, readChapterContent, validateProjectRoot, canInitializeProjectRoot } from "../app-dashboard.mjs";
import { forgetRecentProject, loadAppState, recordRecentProject, samePath } from "../app-state.mjs";
import { loadConfigLayers } from "../config-runtime.mjs";
import { createResearchAdapter } from "../research-adapters.mjs";
import { fetchWebPage, searchWeb } from "../research-tools.mjs";
import { loadProject, createProjectAt } from "../project-store.mjs";
import { loadProjectDiagnostics } from "../project-diagnostics.mjs";
import { isPathInside } from "../fs-utils.mjs";
import {
  resolveActiveProjectRoot,
  resolveActiveWriteProjectRoot,
  resolveReadProjectRoot
} from "./router.mjs";
import { getDefaultLocalModelProfile } from "../local-model-profiles.mjs";
import {
  buildAvailableModelProfiles,
  buildModelProfile,
  modelConfigFromLocalProfile,
  modelDisplayName,
  syncProjectModelFromGlobal
} from "./settings-routes.mjs";

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    return fallback;
  }
  return number;
}

export function createProjectRoutes({
  workspace,
  stateRoot,
  secretsRoot,
  projectLocks = null,
  agent = null,
  dashboardLoader = loadDashboardData,
  selection = null
} = {}) {
  // 共享的项目选择状态（composition root 注入同一个可变引用，settings-routes 共用）。
  const selectedRef = selection ?? { current: null };
  const selected = () => selectedRef.current;
  const ctx = {
    get selected() {
      return selectedRef.current;
    },
    workspace,
    stateRoot
  };

  async function rememberProject(projectRoot) {
    try {
      const project = await loadProject(projectRoot);
      await recordRecentProject(stateRoot, { projectRoot, title: project.title, story_seed: project.story_seed });
    } catch {
      // 项目元数据读取失败（文件缺失或格式错误），仅记录路径
      await recordRecentProject(stateRoot, { projectRoot });
    }
  }

  async function assertNotArchived(projectRoot) {
    const project = await loadProject(projectRoot);
    if (project.archived_at) {
      throw new HttpError(400, "PROJECT_ARCHIVED", "项目已归档（只读）。请先解除归档再执行此操作。");
    }
    return project;
  }

  async function withProjectLock(projectRoot, operation) {
    if (!projectLocks) {
      return operation();
    }
    return projectLocks.runExclusive(projectRoot, operation);
  }

  // 资料路由的旧错误契约：network_not_allowed → 403，其余领域错误 → 400（code 保留）。
  async function runResearch(action, body) {
    try {
      const projectRoot = await resolveActiveProjectRoot(ctx);
      const project = await loadProject(projectRoot);
      const config = await loadConfigLayers(projectRoot, project);
      const adapter = createResearchAdapter(config.effective.research_config ?? {});
      const effectiveProject = {
        ...project,
        effective_config: config.effective,
        tool_permissions: config.effective.tool_permissions
      };
      return action === "search"
        ? await searchWeb(projectRoot, effectiveProject, {
            query: body.query,
            limit: body.limit ?? 5,
            stage: "research"
          }, { adapter })
        : await fetchWebPage(projectRoot, effectiveProject, { url: body.url, stage: "research" }, { adapter });
    } catch (error) {
      throw new HttpError(
        error?.code === "network_not_allowed" ? 403 : 400,
        error?.code ?? "research_failed",
        error?.message ?? String(error)
      );
    }
  }

  async function buildProjectList() {
    const currentSelected = selected();
    const state = await loadAppState(stateRoot);
    const candidates = [...state.recentProjects];
    if (currentSelected && !candidates.some((item) => samePath(item.projectRoot, currentSelected))) {
      candidates.push({ projectRoot: currentSelected });
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
        console.warn("[project-routes] Failed to load project metadata:", error.message);
      }
      projects.push({
        projectRoot: root,
        title,
        story_seed: storySeed,
        active_model: activeModel,
        model_label: modelDisplayName(activeModel),
        archived_at: archivedAt,
        external: !isPathInside(workspace, root)
      });
    }
    const selectedInList = currentSelected && projects.some((project) => samePath(project.projectRoot, currentSelected))
      ? currentSelected
      : null;
    return {
      ok: true,
      workspaceRoot: workspace,
      selectedProjectRoot: selectedInList,
      projects
    };
  }

  async function resolveSelectedAfterForget(forgottenRoot) {
    const currentSelected = selected();
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

  return {
    // dashboard：领域事实 + 模型档案（稳定契约字段由 dashboardLoader 提供）。
    "GET /api/dashboard": async ({ query }) => {
      const requestedRoot = query.projectRoot;
      const scopedRoot = (requestedRoot || selected())
        ? await resolveReadProjectRoot({ requestedRoot, selected: selected(), workspace, stateRoot })
        : null;
      await syncProjectModelFromGlobal(scopedRoot, secretsRoot);
      const data = await dashboardLoader(workspace, {
        projectRoot: scopedRoot,
        allowExternalProjectRoot: Boolean(scopedRoot),
        disableProjectFallback: !scopedRoot
      });
      if (data?.hasProject) {
        data.model_profile = buildModelProfile(data.project?.active_model, secretsRoot);
        data.available_models = await buildAvailableModelProfiles(secretsRoot, data.project?.active_model);
      }
      return data;
    },

    // 诊断：稳定 diagnostics loader + 注入的 ProjectAgent snapshot（Task 9 衔接见文件头）。
    "GET /api/diagnostics": async ({ query }) => {
      try {
        const projectRoot = await resolveReadProjectRoot({
          requestedRoot: query.projectRoot,
          selected: selected(),
          workspace,
          stateRoot
        });
        let agentSnapshot = null;
        try {
          agentSnapshot = await agent.snapshot({ projectRoot, afterSeq: 0, limit: 100 });
        } catch {
          // snapshot 失败不阻塞诊断（保持旧契约可用）；Task 9 的 loader 对 null 按
          // "无运行状态"组合领域审计。
          agentSnapshot = null;
        }
        const diagnostics = await loadProjectDiagnostics(projectRoot, { agentSnapshot });
        return diagnostics;
      } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(404, "no_project", error.message);
      }
    },

    "GET /api/projects/list": async () => buildProjectList(),

    "POST /api/projects/open": async ({ body }) => {
      try {
        const projectRoot = await validateProjectRoot(body.projectRoot ?? body.path ?? "");
        selectedRef.current = projectRoot;
        await rememberProject(projectRoot);
        return { ok: true, projectRoot };
      } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, "project_open_failed", error?.message ?? String(error));
      }
    },

    "POST /api/projects/forget": async ({ body }) => {
      try {
        const rawRoot = String(body.projectRoot ?? body.path ?? "").trim();
        if (!rawRoot) {
          throw new HttpError(400, "project_forget_failed", "项目路径不能为空。");
        }
        const target = path.resolve(rawRoot);
        await forgetRecentProject(stateRoot, target);
        const nextSelected = await resolveSelectedAfterForget(target);
        selectedRef.current = nextSelected;
        const list = await buildProjectList();
        return {
          ok: true,
          workspaceRoot: workspace,
          selectedProjectRoot: nextSelected,
          projects: list.projects
        };
      } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, "project_forget_failed", error?.message ?? String(error));
      }
    },

    "POST /api/projects/init": async ({ body }) => {
      try {
        const projectRoot = await canInitializeProjectRoot(body.projectRoot ?? body.path ?? "");
        const title = String(body.title ?? "").trim() || path.basename(projectRoot) || "未命名小说";
        const storySeed = String(body.story_seed ?? "").trim() || "一个人在雨夜收到一封没有署名的信。";
        const targetChapters = normalizePositiveInteger(body.target_chapters, 100);
        const minWordsPerChapter = normalizePositiveInteger(body.min_words_per_chapter, 3000);
        const targetWordsPerChapter = normalizePositiveInteger(body.target_words_per_chapter, Math.max(minWordsPerChapter, 3300));
        const outputFormat = ["md", "txt"].includes(body.output_format) ? body.output_format : "md";
        const defaultModel = secretsRoot ? await getDefaultLocalModelProfile(secretsRoot) : null;
        const { project } = await createProjectAt(projectRoot, {
          title,
          story_seed: storySeed,
          target_chapters: targetChapters,
          min_words_per_chapter: minWordsPerChapter,
          target_words_per_chapter: targetWordsPerChapter,
          output_format: outputFormat,
          active_model: defaultModel ? modelConfigFromLocalProfile(defaultModel) : undefined
        });
        selectedRef.current = projectRoot;
        await rememberProject(projectRoot);
        return {
          ok: true,
          projectRoot,
          project: {
            project_id: project.project_id,
            title: project.title,
            story_seed: project.story_seed,
            target_chapters: project.target_chapters
          }
        };
      } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, "project_init_failed", error?.message ?? String(error));
      }
    },

    "POST /api/research/search": async ({ body }) => runResearch("search", body),

    "POST /api/research/fetch": async ({ body }) => runResearch("fetch", body),

    "GET /api/chapters/read": async ({ query }) => {
      try {
        const projectRoot = query.projectRoot
          ? await resolveReadProjectRoot({ requestedRoot: query.projectRoot, selected: selected(), workspace, stateRoot })
          : await resolveActiveProjectRoot(ctx);
        const chapterNo = query.chapter ?? query.chapter_no;
        const data = await readChapterContent(projectRoot, chapterNo);
        return { ...data, projectRoot };
      } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, "chapter_read_failed", error.message);
      }
    },

    // 确定性导出：直接在项目锁下调用 book-export.mjs。不调用 ProjectAgent、不创建
    // Run、不追加模型 transcript、不注册 export_book 工具（计划 Rule 6/7）。
    "POST /api/projects/export-book": async ({ body }) => {
      const projectRoot = await resolveActiveWriteProjectRoot(ctx, body);
      await assertNotArchived(projectRoot);
      const format = body?.format === "md" ? "md" : "txt";
      const result = await withProjectLock(projectRoot, () => exportBook(projectRoot, { format }));
      // book-export 的 words 是 countEffectiveWords 的有效字数（中文按字符计），
      // 对外契约字段名为 characters。
      return { ok: true, path: result.path, chapters: result.chapters, characters: result.words };
    }
  };
}
