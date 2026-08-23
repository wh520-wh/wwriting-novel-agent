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
// 模块间职责：模型档案展示 helper（buildModelProfile 等）Task 21 起统一位于
// settings-runtime.mjs（域模块），本模块直接 import——单向下沉、不回路由层
//（迁移前的路由层归属与 Task 7 评审演进见 git 历史）。
//
// Task 21（F10 第十五轮）：业务逻辑下沉域模块——buildProjectList 与归档门禁
// assertNotArchived 迁入 project-listing.mjs，migrateLegacyProjectOnOpen 迁入
// project-model-migration.mjs，runResearch 网络外呼编排迁入 research-tools.mjs；
// 本模块只留参数解构、错误映射与响应序列化（runResearch 的错误映射保留在本模块
// handleResearch）。
//
// Task 9 衔接点：
//   - diagnostics handler 已按计划形状把 agent.snapshot() 结果传给稳定 diagnostics
//     loader（loadProjectDiagnostics(projectRoot, { agentSnapshot })）。当前 loader
//     签名仍为单参数、忽略 snapshot（Task 9 才改为消费它并停止读旧运行态）；
//     本 handler 的传参形状与 Task 9 的 loader 签名一致，无需再改。
//   - /api/dashboard 只返回领域事实 + 模型档案：旧 handler 的批处理/队列/重试/
//     recovery 字段随 Task 9 的 app-dashboard 重写删除，不再进入新路由。
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../http-error.mjs";
import { exportBook } from "../book-export.mjs";
import {
  loadDashboardData,
  readChapterContent,
  validateWorkspaceRoot,
  canInitializeProjectRoot
} from "../app-dashboard.mjs";
import { forgetRecentProject, loadAppState, recordRecentProject, samePath } from "../app-state.mjs";
import { runResearch } from "../research-tools.mjs";
import { loadProject, createProjectAt } from "../project-store.mjs";
import { migrateLegacyProjectOnOpen, migrateProjectFile } from "../project-model-migration.mjs";
import { loadProjectDiagnostics } from "../project-diagnostics.mjs";
import { safeJoin, writeFileAtomic } from "../fs-utils.mjs";
import {
  resolveActiveProjectRoot,
  resolveActiveWriteProjectRoot,
  resolveReadProjectRoot
} from "./router.mjs";
import { getDefaultModel } from "../model-provider-store.mjs";
import { buildModelProfile, modelDisplayName } from "../settings-runtime.mjs";
import { assertNotArchived, buildProjectList } from "../project-listing.mjs";
import { listChapterVersions, readChapterVersion } from "../project-operations/versions.mjs";
import { rollbackChapter } from "../project-operations/chapter.mjs";
import { listMemoryVersions, readMemoryVersion } from "../project-operations/memory-versions.mjs";

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    return fallback;
  }
  return number;
}

// 第十二轮 F9：恢复类操作（rollback / memory restore）的 409 门禁从 running 扩
// 为非终态集（与串行门 hasNonTerminalRun 同口径——waiting_user/stopping 期间不再
// 放行并发写）。维护义务：新增/删改运行状态时需同步本集合与其余副本（runtime
// hasNonTerminalRun 为终态补集机制自动覆盖，settings-modal.js、
// project-diagnostics.mjs、session-sidebar BUSY_RUN_STATUSES、
// 前端 index.js AGENT_BUSY_STATUSES）。
const RUN_BUSY_STATUSES = new Set(["running", "waiting_user", "interrupting", "stopping"]);

export function createProjectRoutes({
  workspace,
  stateRoot,
  secretsRoot,
  projectLocks = null,
  agent = null,
  dashboardLoader = loadDashboardData,
  selection = null,
  // 计划 Task 4 Step 5：组合根注入同一个 workspaceStore（应用私有 settings 真相源）。
  // 模块不得自行拼 stateRoot/workspaces 路径。
  workspaceStore = null
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

  async function withProjectLock(projectRoot, operation) {
    if (!projectLocks) {
      return operation();
    }
    return projectLocks.runExclusive(projectRoot, operation);
  }

  // 资料路由的旧错误契约：network_not_allowed → 403，其余领域错误 → 400（code 保留）。
  // Task 21：网络外呼编排（loadProject/loadConfigLayers/createResearchAdapter/
  // searchWeb/fetchWebPage）下沉 research-tools.mjs 的 runResearch；本壳保留
  // 项目根解析（参数解析）与错误映射，响应由 handler 直接透出。
  async function handleResearch(action, body) {
    try {
      const projectRoot = await resolveActiveProjectRoot(ctx);
      return await runResearch(projectRoot, action, body);
    } catch (error) {
      throw new HttpError(
        error?.code === "network_not_allowed" ? 403 : 400,
        error?.code ?? "research_failed",
        error?.message ?? String(error)
      );
    }
  }

  // 忘记后回落到下一个可用目录：只检查目录可访问，不检查 project.yaml（计划 Task 4 Step 4）。
  async function resolveSelectedAfterForget(forgottenRoot) {
    const currentSelected = selected();
    if (currentSelected && !samePath(currentSelected, forgottenRoot)) {
      try {
        return await validateWorkspaceRoot(currentSelected);
      } catch {
        // 当前选中已不可访问：继续找最近列表
      }
    }
    const state = await loadAppState(stateRoot);
    for (const item of state.recentProjects) {
      const candidate = path.resolve(item.projectRoot);
      try {
        return await validateWorkspaceRoot(candidate);
      } catch {
        // 目录不可访问，继续找下一个
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
      const data = await dashboardLoader(workspace, {
        projectRoot: scopedRoot,
        allowExternalProjectRoot: Boolean(scopedRoot),
        disableProjectFallback: !scopedRoot,
        // Task 1：dashboard 读路径与写路径同源——传入应用私有 workspaceStore，
        // 让 loadDashboardData 用 loadEffectiveWorkspaceConfig 覆盖 effective config
        //（YOLO 等权限档在重开后按 workspace settings 持久显示）。
        workspaceStore
      });
      if (data?.hasProject) {
        // 任务 6：迁移后 active_model 可为 null（mock 归零/未配置模型）。buildModelProfile
        // 的缺省参数只覆盖 undefined；归一化 null → {} 进入未配置分支，展示「未配置」——
        // 用户面不再出现 mock 兜底。
        data.model_profile = buildModelProfile(data.project?.active_model ?? {}, secretsRoot);
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

    "GET /api/projects/list": async () => buildProjectList({ workspace, stateRoot, workspaceStore, currentSelected: selected() }),

    // 打开任意可访问文件夹即成为工作区（计划 Task 4 Step 2）：不再要求 project.yaml。
    "POST /api/projects/open": async ({ body }) => {
      try {
        const projectRoot = await validateWorkspaceRoot(body.projectRoot ?? body.path ?? "");
        selectedRef.current = projectRoot;
        await rememberProject(projectRoot);
        await migrateLegacyProjectOnOpen(projectRoot, { workspaceStore });
        // 任务 6：打开即迁移 project.yaml/私有 settings 快照→引用（mock 归零、匹配
        // 清单转引用；幂等——第二次打开已迁移完 → changed=false）。迁移失败不阻断打开；
        // migration_notice 仅本次响应透出（前端据此弹「旧配置已升级」toast）。
        const migrated = await migrateProjectFile(projectRoot, { workspaceStore, secretsRoot })
          .catch(() => ({ changed: false }));
        // 计划修复（整支审阅）：打开即触发 Agent 侧 open 序列（旧 .wwriting/agent 迁移 →
        // journal.load → legacy 导入 → 崩溃恢复），与 project.yaml 迁移同一时机。幂等
        //（target_not_empty 守卫 / legacy 标记 / startLoop 复用），失败不阻断打开。
        if (agent && typeof agent.open === "function") {
          try {
            await agent.open({ projectRoot });
          } catch (error) {
            console.warn("[project-routes] agent open 失败（不影响聊天）:", error?.message ?? String(error));
          }
        }
        return { ok: true, projectRoot, migration_notice: migrated.changed };
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
        const list = await buildProjectList({ workspace, stateRoot, workspaceStore, currentSelected: selected() });
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
        // 新建项目沿用全局默认模型（v2 store）：写引用形态 { provider_id, model_id }，
        // 运行时按 modelStoreLoader 解析（与 model-switch 的引用契约一致）。
        const defaultModel = secretsRoot ? await getDefaultModel(secretsRoot) : null;
        const { project } = await createProjectAt(projectRoot, {
          title,
          story_seed: storySeed,
          target_chapters: targetChapters,
          min_words_per_chapter: minWordsPerChapter,
          target_words_per_chapter: targetWordsPerChapter,
          output_format: outputFormat,
          active_model: defaultModel ? { provider_id: defaultModel.provider.id, model_id: defaultModel.model.id } : undefined
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

    "POST /api/research/search": async ({ body }) => handleResearch("search", body),

    "POST /api/research/fetch": async ({ body }) => handleResearch("fetch", body),

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
      await assertNotArchived(projectRoot, { workspaceStore });
      const format = body?.format === "md" ? "md" : "txt";
      const result = await withProjectLock(projectRoot, () => exportBook(projectRoot, { format }));
      // book-export 的 words 是 countEffectiveWords 的有效字数（中文按字符计），
      // 对外契约字段名为 characters。
      return { ok: true, path: result.path, chapters: result.chapters, characters: result.words };
    },

    // ---- 第九轮：章节版本时间线与恢复（UI 侧）----
    "GET /api/chapters/versions": async ({ query }) => {
      const projectRoot = await resolveReadProjectRoot({ requestedRoot: query.projectRoot, selected: selected(), workspace, stateRoot });
      const chapterNo = normalizePositiveInteger(query.chapter_no, null);
      if (chapterNo === null) throw new HttpError(400, "bad_args", "chapter_no 必须是正整数。");
      const versions = await listChapterVersions({ projectRoot, chapterNo });
      if (versions.length === 0) throw new HttpError(404, "no_versions", `第 ${chapterNo} 章没有任何历史版本。`);
      return { ok: true, chapter_no: chapterNo, versions };
    },

    "GET /api/chapters/versions/content": async ({ query }) => {
      const projectRoot = await resolveReadProjectRoot({ requestedRoot: query.projectRoot, selected: selected(), workspace, stateRoot });
      const chapterNo = normalizePositiveInteger(query.chapter_no, null);
      const version = normalizePositiveInteger(query.version, null);
      if (chapterNo === null || version === null) throw new HttpError(400, "bad_args", "chapter_no 与 version 必须是正整数。");
      const data = await readChapterVersion({ projectRoot, chapterNo, version });
      return { ok: true, chapter_no: chapterNo, ...data };
    },

    "POST /api/chapters/rollback": async (handlerCtx) => {
      const projectRoot = await resolveActiveWriteProjectRoot(ctx, handlerCtx.body ?? {});
      await assertNotArchived(projectRoot, { workspaceStore });
      const chapterNo = normalizePositiveInteger(handlerCtx.body?.chapter_no, null);
      if (chapterNo === null) throw new HttpError(400, "bad_args", "chapter_no 必须是正整数。");
      const { session } = await agent.snapshot({ projectRoot });
      if (RUN_BUSY_STATUSES.has(session?.active_run?.status ?? "idle")) {
        throw new HttpError(409, "agent_running", "写作进行中，暂停后恢复。");
      }
      const project = await loadProject(projectRoot);
      const version = handlerCtx.body?.version == null ? null : normalizePositiveInteger(handlerCtx.body.version, null);
      if (handlerCtx.body?.version != null && version === null) throw new HttpError(400, "bad_args", "version 必须是正整数。");
      const result = await withProjectLock(projectRoot, () =>
        rollbackChapter({ projectRoot, projectId: project.project_id, chapterNo, version }));
      try {
        await agent.appendSystemEvent({
          projectRoot,
          type: "chapter_rolled_back",
          payload: { chapter_no: chapterNo, from_version: result.version?.from ?? null, to_version: result.version?.to ?? null }
        });
      } catch { /* 事件注入失败不阻塞恢复结果 */ }
      return { ok: true, chapter_no: chapterNo, ...result };
    },

    // ---- 第九轮：记忆文件版本与恢复 ----
    "GET /api/memory/versions": async ({ query }) => {
      const projectRoot = await resolveReadProjectRoot({ requestedRoot: query.projectRoot, selected: selected(), workspace, stateRoot });
      const file = query.file;
      if (file !== "worklog" && file !== "book_summary") throw new HttpError(400, "bad_args", "file 只允许 worklog|book_summary。");
      return { ok: true, ...(await listMemoryVersions({ projectRoot, file })) };
    },

    "GET /api/memory/versions/content": async ({ query }) => {
      const projectRoot = await resolveReadProjectRoot({ requestedRoot: query.projectRoot, selected: selected(), workspace, stateRoot });
      const file = query.file;
      const version = normalizePositiveInteger(query.version, null);
      if (file !== "worklog" && file !== "book_summary") throw new HttpError(400, "bad_args", "file 只允许 worklog|book_summary。");
      if (version === null) throw new HttpError(400, "bad_args", "version 必须是正整数。");
      return { ok: true, ...(await readMemoryVersion({ projectRoot, file, version })) };
    },

    "GET /api/memory/files/content": async ({ query }) => {
      const projectRoot = await resolveReadProjectRoot({ requestedRoot: query.projectRoot, selected: selected(), workspace, stateRoot });
      const file = query.file;
      const allowed = {
        worklog: safeJoin(projectRoot, "WORKLOG.md"),
        book_summary: safeJoin(projectRoot, "book_summary.md"),
        continuity: safeJoin(projectRoot, "memory", "continuity.md")
      };
      if (!allowed[file]) throw new HttpError(400, "bad_args", "file 只允许 worklog|book_summary|continuity。");
      const content = await fs.readFile(allowed[file], "utf8").catch(() => "");
      return { ok: true, file, content };
    },

    "POST /api/memory/versions/restore": async (handlerCtx) => {
      const projectRoot = await resolveActiveWriteProjectRoot(ctx, handlerCtx.body ?? {});
      await assertNotArchived(projectRoot, { workspaceStore });
      const file = handlerCtx.body?.file;
      const version = normalizePositiveInteger(handlerCtx.body?.version, null);
      if (file !== "worklog" && file !== "book_summary") throw new HttpError(400, "bad_args", "file 只允许 worklog|book_summary。");
      if (version === null) throw new HttpError(400, "bad_args", "version 必须是正整数。");
      const { session } = await agent.snapshot({ projectRoot });
      if (RUN_BUSY_STATUSES.has(session?.active_run?.status ?? "idle")) {
        throw new HttpError(409, "agent_running", "写作进行中，暂停后恢复。");
      }
      const { content } = await readMemoryVersion({ projectRoot, file, version });
      const target = file === "worklog" ? safeJoin(projectRoot, "WORKLOG.md") : safeJoin(projectRoot, "book_summary.md");
      await withProjectLock(projectRoot, () => writeFileAtomic(target, content));
      try {
        await agent.appendSystemEvent({
          projectRoot,
          type: "memory_file_restored",
          payload: { file, to_version: version }
        });
      } catch { /* 事件注入失败不阻塞恢复结果 */ }
      return { ok: true, file, version, restored: true };
    }
  };
}
