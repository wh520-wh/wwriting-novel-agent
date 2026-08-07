// tests/http/project-routes.test.mjs —— 项目/导出/诊断/资料路由测试（Task 7 Step 3/5）。
//
// 用 harness 构造真实 HTTP server：router + project-routes（注入 ProjectAgent、
// 项目锁、dashboard loader）+ settings-routes（dashboard 依赖的全局模型同步 helper）。
// 覆盖：
//   - POST /api/projects/export-book：有序合并已提交章节 Markdown 到 TXT、返回真实
//     路径、chapters/characters 字段；不产生模型调用、不创建 Agent Run；
//   - export-book 归档项目拒绝（400 PROJECT_ARCHIVED）；
//   - GET /api/diagnostics：注入 agent.snapshot() 传给稳定 diagnostics loader，
//     保持旧响应契约；
//   - 既有非 Agent 契约抽查：projects/list、projects/open、projects/init、
//     research/search（网络未开 → 403 network_not_allowed）、settings/update、
//     settings/model-secret、skills/catalog、output-styles。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRouter } from "../../src/core/http/router.mjs";
import { createProjectRoutes } from "../../src/core/http/project-routes.mjs";
import { createSettingsRoutes } from "../../src/core/http/settings-routes.mjs";
import { createProjectLockRegistry } from "../../src/core/project-lock.mjs";
import { createSkillService } from "../../src/core/skills/index.mjs";
import { recordRecentProject } from "../../src/core/app-state.mjs";
import { loadProject, saveProject, upsertChapter } from "../../src/core/project-store.mjs";
import { startHttpServer } from "../helpers/http-test.mjs";
import { createProjectAgentHarness, readEvents, eventsOfType } from "../helpers/project-agent-harness.mjs";

async function setupServer(t, harnessOptions = {}) {
  const h = await createProjectAgentHarness(harnessOptions);
  const workspace = h.workspaceRoot;
  const stateRoot = path.join(workspace, ".state");
  const secretsRoot = path.join(workspace, ".secrets");
  await fs.mkdir(secretsRoot, { recursive: true });
  const selection = { current: null };
  const projectLocks = createProjectLockRegistry();
  const router = createRouter();
  const projectRoutes = createProjectRoutes({
    workspace,
    stateRoot,
    secretsRoot,
    projectLocks,
    agent: h.agent,
    selection
  });
  const settingsRoutes = createSettingsRoutes({
    workspace,
    stateRoot,
    secretsRoot,
    selection,
    // Task 12：注入临时 root 的 skills service（migration marker 不碰真实用户目录）
    skills: createSkillService({ userHome: path.join(workspace, ".skills-home"), resourcesPath: null }),
    // 注入桩 connectionTester：让 test-connection 走到密钥校验与统一 finally 清理
    // 路径（不注入时 503 model_probe_unavailable）
    connectionTester: async () => ({ ok: true, code: null, message: "ok", latency_ms: 5 })
  });
  const server = await startHttpServer(t, {
    router,
    routeModules: [projectRoutes, settingsRoutes],
    afterClose: () => h.cleanup()
  });
  return {
    h,
    workspace,
    stateRoot,
    secretsRoot,
    selection,
    ...server
  };
}

// 构造已提交章节（final 文件 + 章节索引），供 export-book 使用。
async function createCommittedChapter(projectRoot, chapterNo, title, body) {
  const filePath = path.join(projectRoot, "chapters", `${String(chapterNo).padStart(3, "0")}.md`);
  await fs.writeFile(filePath, `# Chapter ${String(chapterNo).padStart(3, "0")}\n\n${body}`, "utf8");
  await upsertChapter(projectRoot, {
    chapter_no: chapterNo,
    title,
    status: "completed",
    final_path: filePath,
    actual_words: body.length
  });
  return filePath;
}

test("POST /api/projects/export-book：合并有序已提交章节到 TXT，无模型调用无 Agent Run", async (t) => {
  const s = await setupServer(t);
  s.selection.current = s.h.projectRoot;
  // 故意按倒序写入章节文件，验证导出按章节号有序合并
  await createCommittedChapter(s.h.projectRoot, 2, "第二", "乙正文。**加粗**");
  await createCommittedChapter(s.h.projectRoot, 1, "第一", "甲正文。");

  const { res, data } = await s.post("/api/projects/export-book", {
    projectRoot: s.h.projectRoot,
    format: "txt"
  });
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.chapters, 2, "两个已提交章节都导出");
  assert.equal(typeof data.characters, "number");
  assert.ok(data.characters > 0, "characters 返回有效字数");

  // 真实路径且文件存在
  assert.equal(typeof data.path, "string");
  assert.ok(data.path.length > 0);
  await fs.access(data.path);
  assert.match(data.path.replaceAll("\\", "/"), /\/exports\/.+\.txt$/u);

  const content = await fs.readFile(data.path, "utf8");
  const firstIndex = content.indexOf("第 1 章");
  const secondIndex = content.indexOf("第 2 章");
  assert.ok(firstIndex >= 0 && secondIndex > firstIndex, "章节按章号有序合并");
  assert.match(content, /甲正文。/u);
  assert.match(content, /乙正文。/u);
  assert.doesNotMatch(content, /# Chapter/u, "导出剥离流水线产物");

  // 无模型调用、无 Agent Run
  assert.equal(s.h.gateway.calls.length, 0, "导出不得调用模型");
  const events = await readEvents(s.h.agent, s.h.projectRoot);
  assert.equal(eventsOfType(events, "run_started").length, 0, "导出不得创建 Agent Run");
  const session = (await s.h.agent.snapshot({ projectRoot: s.h.projectRoot, afterSeq: 0, limit: 100 })).session;
  assert.equal(session.active_run, null, "导出后仍无活动 Run");
});

test("POST /api/projects/export-book：归档项目拒绝", async (t) => {
  const s = await setupServer(t);
  s.selection.current = s.h.projectRoot;
  await createCommittedChapter(s.h.projectRoot, 1, "第一", "正文。");
  const project = await loadProject(s.h.projectRoot);
  project.archived_at = new Date().toISOString();
  await saveProject(s.h.projectRoot, project);

  const { res, data } = await s.post("/api/projects/export-book", { projectRoot: s.h.projectRoot, format: "txt" });
  assert.equal(res.status, 400);
  assert.equal(data.code, "PROJECT_ARCHIVED");
});

test("GET /api/diagnostics：agent.snapshot 注入稳定 loader，旧契约保留", async (t) => {
  // 当前稳定 diagnostics loader（Task 9 才改为消费 snapshot）仍从旧状态文件读取：
  // 用 legacy 夹具（含旧状态文件）走通 200 契约。
  const s = await setupServer(t, { legacy: true });
  s.selection.current = s.h.projectRoot;
  const { res, data } = await s.get(`/api/diagnostics?projectRoot=${encodeURIComponent(s.h.projectRoot)}`);
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.project.status, "idle", "旧状态 project_status 字段契约保留");
  assert.equal(data.project.chapter, 1);
  assert.equal(typeof data.queue, "object");
  assert.equal(typeof data.costHealth, "object");
  assert.equal(typeof data.recoveryHint, "object");
  assert.ok(Array.isArray(data.recentEvents));
  // 未注册项目 → 400 INVALID_WORKSPACE_SCOPE / 404 no_project
  const missing = await s.get(`/api/diagnostics?projectRoot=${encodeURIComponent(path.join(os.tmpdir(), "no-such-project"))}`);
  assert.ok([400, 404].includes(missing.res.status), `未注册项目应 4xx，实际 ${missing.res.status}`);
});

test("既有契约抽查：projects/list、open、init、research、settings、skills、output-styles", async (t) => {
  const s = await setupServer(t);
  await recordRecentProject(s.stateRoot, {
    projectRoot: s.h.projectRoot,
    title: s.h.project.title,
    story_seed: s.h.project.story_seed
  });
  s.selection.current = s.h.projectRoot;

  // projects/list
  const list = await s.get("/api/projects/list");
  assert.equal(list.res.status, 200);
  assert.equal(list.data.ok, true);
  assert.ok(list.data.projects.some((p) => path.resolve(p.projectRoot) === path.resolve(s.h.projectRoot)));
  assert.equal(typeof list.data.selectedProjectRoot, "string");

  // projects/open（未注册路径 → 400 project_open_failed）
  const open = await s.post("/api/projects/open", { projectRoot: s.h.projectRoot });
  assert.equal(open.res.status, 200);
  assert.equal(open.data.ok, true);
  const openBad = await s.post("/api/projects/open", { projectRoot: "Z:\\no\\such\\dir" });
  assert.equal(openBad.res.status, 400);
  assert.equal(openBad.data.code, "project_open_failed");

  // projects/init（新建项目）
  const newRoot = path.join(s.workspace, "fresh-novel");
  const init = await s.post("/api/projects/init", { projectRoot: newRoot, title: "新书", target_chapters: 3 });
  assert.equal(init.res.status, 200);
  assert.equal(init.data.ok, true);
  assert.equal(init.data.project.title, "新书");
  assert.equal(init.data.projectRoot, newRoot);

  // research/search：项目网络未开 → 403 network_not_allowed（旧契约）
  //（init 已把选中切到新项目，先切回 harness 项目）
  s.selection.current = s.h.projectRoot;
  const research = await s.post("/api/research/search", { query: "雨夜" });
  assert.equal(research.res.status, 403);
  assert.equal(research.data.code, "network_not_allowed");

  // settings/update：非模型字段补丁
  const settings = await s.post("/api/settings/update", {
    projectRoot: s.h.projectRoot,
    tool_permissions: { safe_edit: true, read_only: false }
  });
  assert.equal(settings.res.status, 200);
  assert.equal(settings.data.ok, true);
  assert.equal(settings.data.project.tool_permissions.safe_edit, true);
  // settings/update 坏补丁 → 400 invalid_settings_patch
  const badPatch = await s.post("/api/settings/update", { projectRoot: s.h.projectRoot });
  assert.equal(badPatch.res.status, 400);
  assert.equal(badPatch.data.code, "invalid_settings_patch");

  // settings/model-secret：无 env 参数回落项目模型（mock 无 key → 空串）
  const secret = await s.get("/api/settings/model-secret");
  assert.equal(secret.res.status, 200);
  assert.equal(secret.data.ok, true);
  assert.equal(typeof secret.data.value, "string");

  // settings/test-connection：候选模型有 api_key_env 但 secrets 无 key
  // → 400 configuration_missing（走重构后的统一 finally 清理路径）
  const probe = await s.post("/api/settings/test-connection", {
    active_model: { provider: "openai-compatible", model_name: "test-model", base_url: "https://example.com/v1", api_key_env: "TEST_API_KEY" }
  });
  assert.equal(probe.res.status, 400);
  assert.equal(probe.data.code, "configuration_missing");

  // skills/catalog：内置技能发现即生效（无 enabled_skills / 启停集合）
  const skillCatalog = await s.get("/api/skills/catalog");
  assert.equal(skillCatalog.res.status, 200);
  assert.equal(skillCatalog.data.ok, true);
  assert.ok(skillCatalog.data.active.some((skill) => skill.name === "suspense-chapter-end"));
  assert.equal(skillCatalog.data.active[0]["enabled_in_" + "project"], undefined, "Task 13：catalog 不返回启停字段");
  assert.ok(Array.isArray(skillCatalog.data.migration_errors), "catalog 携带 migration_errors 数组");

  // output-styles
  const styles = await s.get("/api/output-styles");
  assert.equal(styles.res.status, 200);
  assert.equal(styles.data.ok, true);
  assert.ok(Array.isArray(styles.data.styles));
});
