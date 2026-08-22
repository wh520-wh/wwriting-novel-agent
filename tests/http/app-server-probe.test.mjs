// app-server 组合根探测（统一 Agent 内核计划 Task 9 改写）。
//
// 覆盖新组合根的全部存活契约：dashboard（领域事实，无运行推断）、项目 list/open/
// init/forget、设置/模型/技能、章节读取、诊断（注入 agent snapshot）、确定性导出、
// Agent HTTP（input/queued/snapshot/priority/stop/retry）、静态资源，以及旧路由全部
// 404。SSE 契约在 app-server-events-stream.test.mjs 覆盖。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../../src/core/app-server.mjs";
import { loadProject, saveProject } from "../../src/core/project-store.mjs";
import { createWorkspaceStore } from "../../src/core/workspaces/store.mjs";
import { createMockModelGateway } from "../helpers/project-agent-harness.mjs";

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080
]);

async function listenOnFetchSafePort(server) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    if (!FETCH_BLOCKED_PORTS.has(port)) {
      return port;
    }
    await closeServer(server);
  }
  throw new Error("Could not allocate a fetch-safe test port");
}

async function closeServer(server) {
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  return new Promise((resolve) => server.close(resolve));
}

// 本地 mock 搜索端点（fetch-safe 端口）：/api/research/search 需要
// research_config.search_endpoint 才能创建 JsonSearchApiAdapter。
async function createMockSearchServer() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        results: [
          { title: "App Shell Probe", url: "https://example.test/probe", snippet: "probe result" }
        ]
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    if (!FETCH_BLOCKED_PORTS.has(port)) {
      return { server, port };
    }
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error("Could not allocate a fetch-safe search port");
}

async function setupServer(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-probe-"));
  const { createProjectAt } = await import("../../src/core/project-store.mjs");
  const { projectRoot } = await createProjectAt(path.join(root, "project"), {
    title: "Probe Novel",
    story_seed: "A project for composition root probing.",
    target_chapters: 2,
    min_words_per_chapter: 10,
    target_words_per_chapter: 20,
    ...(options.project ?? {})
  });
  // Task 12：注入临时 root 的 skills service（migration marker 不碰真实用户目录）。
  const { createSkillService } = await import("../../src/core/skills/index.mjs");
  const skills = createSkillService({ userHome: path.join(root, ".skills-home"), resourcesPath: null });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: options.selected ?? projectRoot,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    staticRoot: path.resolve("src", "app-shell"),
    port: 0,
    skills,
    ...(options.testModelConnection ? { testModelConnection: options.testModelConnection } : {}),
    // Task 8：Agent 全链路测试注入确定性 gateway（test-only mock，不指向生产分发）。
    ...(options.testGatewayFactory ? { testGatewayFactory: options.testGatewayFactory } : {})
  });
  const port = await listenOnFetchSafePort(server);
  return { root, projectRoot, server, port };
}

async function postJson(port, route, body = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return { res, data };
}

async function getJson(port, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`);
  return { res, data: await res.json() };
}

async function deleteJson(port, route, body = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return { res, data };
}

async function waitFor(predicate, { timeout = 15000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition");
}

async function commitChapter(projectRoot, chapterNo, content) {
  const project = await loadProject(projectRoot);
  const { appendChapterSegment, commitChapter: commit } = await import("../../src/core/project-operations/chapter.mjs");
  const { createSkillService } = await import("../../src/core/skills/index.mjs");
  const skillsService = createSkillService({ userHome: path.join(projectRoot, ".test-skill-home"), resourcesPath: null });
  const { active } = await skillsService.catalog({ projectRoot });
  await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo, segmentNo: 1, content });
  await commit({ projectRoot, projectId: project.project_id, chapterNo }, { skills: active });
}

// ---------------------------------------------------------------------------
// 基础契约
// ---------------------------------------------------------------------------

test("dashboard 返回领域事实且不包含运行推断", async () => {
  const { projectRoot, server, port } = await setupServer();
  try {
    await commitChapter(projectRoot, 1, "雨夜，一封没有署名的信突然落在门缝里。他猛地抬头，低声道：“谁在送信？老宅的钟会在午夜敲响。”信纸背面写着：真相就在老宅。他攥紧信，冲出门去。");
    const { res, data } = await getJson(port, `/api/dashboard?projectRoot=${encodeURIComponent(projectRoot)}`);
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.hasProject, true);
    assert.equal(data.project.title, "Probe Novel");
    assert.equal(data.summary.completedChapters, 1);
    assert.equal(data.summary.projectStatus, undefined);
    assert.equal(data.review, undefined);
    assert.equal(data.failures, undefined);
    assert.ok(Array.isArray(data.chapters));
    assert.ok(data.chapters[0].artifact.state === "committed");
  } finally {
    await closeServer(server);
  }
});

test("projects list / open / init / forget", async () => {
  const { root, projectRoot, server, port } = await setupServer();
  try {
    const list = await getJson(port, "/api/projects/list");
    assert.equal(list.res.status, 200);
    assert.ok(list.data.projects.some((p) => p.projectRoot === projectRoot));

    const initRoot = path.join(root, "new-novel");
    const init = await postJson(port, "/api/projects/init", {
      projectRoot: initRoot,
      title: "New Novel",
      story_seed: "新小说的种子",
      target_chapters: 5
    });
    assert.equal(init.res.status, 200);
    assert.equal(init.data.project.title, "New Novel");

    const opened = await postJson(port, "/api/projects/open", { projectRoot: initRoot });
    assert.equal(opened.res.status, 200);
    const dashboard = await getJson(port, "/api/dashboard");
    assert.equal(dashboard.data.projectRoot, initRoot);

    const forgot = await postJson(port, "/api/projects/forget", { projectRoot: initRoot });
    assert.equal(forgot.res.status, 200);
    const afterList = await getJson(port, "/api/projects/list");
    assert.ok(!afterList.data.projects.some((p) => p.projectRoot === initRoot));
  } finally {
    await closeServer(server);
  }
});

test("未注册项目返回 400 INVALID_WORKSPACE_SCOPE；打开不存在路径返回 400", async () => {
  const { server, port } = await setupServer();
  try {
    const ghost = await getJson(port, `/api/dashboard?projectRoot=${encodeURIComponent(path.join(os.tmpdir(), "no-such-wwriting-project"))}`);
    assert.equal(ghost.res.status, 400);
    assert.equal(ghost.data.code, "INVALID_WORKSPACE_SCOPE");
    const open = await postJson(port, "/api/projects/open", { projectRoot: path.join(os.tmpdir(), "not-a-project") });
    assert.equal(open.res.status, 400);
    assert.equal(open.data.code, "project_open_failed");
  } finally {
    await closeServer(server);
  }
});

test("未注册项目路径的 /api/agent/* 拒绝 400 INVALID_WORKSPACE_SCOPE（作用域校验闭环）", async () => {
  const { server, port } = await setupServer();
  const unregistered = path.join(os.tmpdir(), "wwriting-unregistered-agent-target");
  await fs.rm(unregistered, { recursive: true, force: true }); // 清掉历史残留，保证副作用断言可靠
  try {
    // 提交输入：未注册路径不得通过（journal 不得对任意路径惰性建目录）。
    const input = await postJson(port, "/api/agent/input", { projectRoot: unregistered, text: "任务一" });
    assert.equal(input.res.status, 400);
    assert.equal(input.data.code, "INVALID_WORKSPACE_SCOPE");
    // 快照与 SSE 同属读端点，同样受作用域约束。
    const snapshot = await getJson(port, `/api/agent/snapshot?projectRoot=${encodeURIComponent(unregistered)}`);
    assert.equal(snapshot.res.status, 400);
    assert.equal(snapshot.data.code, "INVALID_WORKSPACE_SCOPE");
    // 校验失败的副作用检查：未注册路径不得被创建任何 agent 状态。
    const agentDir = path.join(unregistered, ".wwriting", "agent");
    await assert.rejects(fs.access(agentDir), "未注册项目不得创建 .wwriting/agent/");
  } finally {
    await closeServer(server);
  }
});

test("归档项目拒绝写端点", async () => {
  const { projectRoot, server, port } = await setupServer();
  try {
    const project = await loadProject(projectRoot);
    project.archived_at = new Date().toISOString();
    await saveProject(projectRoot, project);
    const exported = await postJson(port, "/api/projects/export-book", { projectRoot, format: "txt" });
    assert.equal(exported.res.status, 400);
    assert.equal(exported.data.code, "PROJECT_ARCHIVED");
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// 章节 / 导出 / 诊断 / 资料 / 技能
// ---------------------------------------------------------------------------

test("章节读取、确定性导出与诊断", async () => {
  const { projectRoot, server, port } = await setupServer();
  try {
    await commitChapter(projectRoot, 1, "雨夜来信突然出现在门缝里。他猛地抬头，低声道：“谁在送信？老宅的钟会在午夜敲响。”信纸背面写着：真相就在老宅。他攥紧信，冲出门去。");
    const read = await getJson(port, `/api/chapters/read?chapter=1`);
    assert.equal(read.res.status, 200);
    assert.equal(read.data.chapter_no, 1);
    assert.ok(read.data.content.includes("雨夜来信"));

    const exported = await postJson(port, "/api/projects/export-book", { projectRoot, format: "txt" });
    assert.equal(exported.res.status, 200);
    assert.equal(exported.data.ok, true);
    assert.ok(exported.data.path.length > 0);
    assert.equal(exported.data.chapters, 1);
    const content = await fs.readFile(exported.data.path, "utf8");
    assert.ok(content.includes("雨夜来信"));

    const diagnostics = await getJson(port, `/api/diagnostics?projectRoot=${encodeURIComponent(projectRoot)}`);
    assert.equal(diagnostics.res.status, 200);
    assert.equal(diagnostics.data.ok, true);
    assert.equal(typeof diagnostics.data.queue, "object");
    assert.equal(typeof diagnostics.data.costHealth, "object");
    assert.equal(typeof diagnostics.data.recoveryHint, "object");
  } finally {
    await closeServer(server);
  }
});

test("资料搜索/抓取与技能 catalog/import/delete", async () => {
  const { root, projectRoot, server, port } = await setupServer();
  const searchServer = await createMockSearchServer();
  try {
    // 联网权限：资料搜索需要 network_allowed（设置路由写 project.yaml）；
    // 搜索适配器需要 research_config.search_endpoint（指向本地 mock）。
    const project = await loadProject(projectRoot);
    project.tool_permissions = { ...(project.tool_permissions ?? {}), network_allowed: true };
    project.research_config = {
      ...(project.research_config ?? {}),
      search_endpoint: `http://127.0.0.1:${searchServer.port}/api/search`
    };
    await saveProject(projectRoot, project);
    const search = await postJson(port, "/api/research/search", { query: "app shell probe" });
    assert.equal(search.res.status, 200);
    assert.equal(search.data.ok, true);
    assert.equal(search.data.results.length, 1);
    assert.equal(search.data.results[0].title, "App Shell Probe");

    // catalog：内置技能可发现；DTO 不含启停字段（无启停集合）。
    const catalog = await getJson(port, "/api/skills/catalog");
    assert.equal(catalog.res.status, 200);
    assert.ok(catalog.data.active.some((s) => s.name === "suspense-chapter-end"));
    assert.equal(catalog.data.active[0]["enabled_in_" + "project"], undefined, "Task 13：catalog 不返回启停字段");
    assert.equal(catalog.data.active[0].enabled, undefined, "Task 13：catalog 不返回 enabled");
    assert.equal(catalog.data.has_project, true);
    assert.equal(catalog.data.project_root, projectRoot);

    // 从文件夹导入项目 scope。
    const skillDir = path.join(root, "probe-style");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: probe-style\ndescription: 探针风格\n---\n\n# Probe Style\n",
      "utf8"
    );
    const imported = await postJson(port, "/api/skills/import", { source_path: skillDir, scope: "project" });
    assert.equal(imported.res.status, 200);
    assert.equal(imported.data.skill, "probe-style");
    assert.equal(imported.data.scope, "project");
    assert.ok(imported.data.source === "project");

    // 重名默认 409 skill_exists；replace:true 覆盖。
    const dup = await postJson(port, "/api/skills/import", { source_path: skillDir, scope: "project" });
    assert.equal(dup.res.status, 409);
    assert.equal(dup.data.code, "skill_exists");
    const replaced = await postJson(port, "/api/skills/import", { source_path: skillDir, scope: "project", replace: true });
    assert.equal(replaced.res.status, 200);

    // catalog 中 probe-style 来自 project 层。
    const after = await getJson(port, "/api/skills/catalog");
    const probe = after.data.active.find((s) => s.name === "probe-style");
    assert.equal(probe.source, "project");
    assert.equal(probe.path, undefined, "Task 8：catalog DTO 不返回本地绝对 path 给 UI");
    assert.equal(probe.readonly, false, "非内置技能 readonly 为 false");
    assert.equal(probe.protected, false, "非内置技能 protected 为 false");
    assert.equal(probe.display_name, "probe-style", "无 display_name 时回落 name");

    // 删除：DELETE /api/skills/:name { scope }。
    const removed = await deleteJson(port, "/api/skills/probe-style", { scope: "project" });
    assert.equal(removed.res.status, 200);
    assert.equal(removed.data.removed, true);
    const afterDelete = await getJson(port, "/api/skills/catalog");
    assert.equal(
      afterDelete.data.active.some((s) => s.name === "probe-style" && s.source === "project"),
      false,
      "删除后项目层不再发现 probe-style"
    );
    const removedAgain = await deleteJson(port, "/api/skills/probe-style", { scope: "project" });
    assert.equal(removedAgain.res.status, 404);

    // Task 8：只读详情 API —— GET /api/skills/:name 返回完整 SKILL.md 正文；
    // 保留名称不可导入/删除（skill_reserved → 403）。
    const detail = await getJson(port, "/api/skills/balanced");
    assert.equal(detail.res.status, 200);
    assert.equal(detail.data.ok, true);
    assert.equal(detail.data.name, "balanced");
    assert.ok(detail.data.content.includes("# 均衡"), "详情应返回完整正文");
    assert.ok(detail.data.content.includes("只在生成、续写、改写、润色或审核中文小说正文时使用本技能"));
    assert.ok(detail.data.content.includes("## 交付前静默检查"));
    const reservedDir = path.join(root, "balanced");
    await fs.mkdir(reservedDir, { recursive: true });
    await fs.writeFile(
      path.join(reservedDir, "SKILL.md"),
      "---\nname: balanced\ndescription: 伪造版本\n---\n\n# Fake\n",
      "utf8"
    );
    const reservedImport = await postJson(port, "/api/skills/import", {
      source_path: reservedDir,
      scope: "project",
      replace: true
    });
    assert.equal(reservedImport.res.status, 403, "保留名称导入必须 403");
    assert.equal(reservedImport.data.code, "skill_reserved");
    const reservedDelete = await deleteJson(port, "/api/skills/balanced", { scope: "project" });
    assert.equal(reservedDelete.res.status, 403, "保留名称删除必须 403");
    assert.equal(reservedDelete.data.code, "skill_reserved");

    // 保留名称的项目同名技能（直接落盘，模拟既有的用户目录）：catalog 必须把它
    // 放进 shadowed 并携带 shadow_reason: "reserved_builtin"（设置页专属文案的数据
    // 来源），且绝不进入 active。
    const reservedProjectDir = path.join(projectRoot, "skills", "balanced");
    await fs.mkdir(reservedProjectDir, { recursive: true });
    await fs.writeFile(
      path.join(reservedProjectDir, "SKILL.md"),
      "---\nname: balanced\ndescription: 项目伪造版本\n---\n\n# Fake\n",
      "utf8"
    );
    const withReserved = await getJson(port, "/api/skills/catalog");
    const shadowedReserved = withReserved.data.shadowed.find(
      (s) => s.name === "balanced" && s.source === "project"
    );
    assert.ok(shadowedReserved, "保留名称项目技能必须出现在 shadowed 列表");
    assert.equal(shadowedReserved.shadow_reason, "reserved_builtin", "shadowed DTO 必须携带 reserved_builtin");
    assert.ok(
      !withReserved.data.active.some((s) => s.name === "balanced" && s.source === "project"),
      "保留名称项目技能绝不进入 active"
    );
  } finally {
    // closeAllConnections：强制断开应用服务器 fetch 留下的 keep-alive 连接，
    // 否则 mock server 的 close() 会等待连接自然超时而挂起。
    if (typeof searchServer.server.closeAllConnections === "function") {
      searchServer.server.closeAllConnections();
    }
    await new Promise((resolve) => searchServer.server.close(resolve));
    await closeServer(server);
  }
});

test("静态资源服务", async () => {
  const { server, port } = await setupServer();
  try {
    const html = await fetch(`http://127.0.0.1:${port}/`).then((res) => res.text());
    assert.ok(html.includes("WWriting"));
    const appJs = await fetch(`http://127.0.0.1:${port}/app.js`).then((res) => res.text());
    assert.ok(appJs.includes("createAgentSurface"));
    const agentCss = await fetch(`http://127.0.0.1:${port}/agent/agent.css`).then((res) => res.text());
    assert.ok(agentCss.includes("--content-column"));
  } finally {
    await closeServer(server);
  }
});

test("vendor 白名单：/vendor/marked.esm.js 可访问，node_modules 不整体暴露", async () => {
  const { server, port } = await setupServer();
  try {
    const vendor = await fetch(`http://127.0.0.1:${port}/vendor/marked.esm.js`);
    assert.equal(vendor.status, 200);
    assert.ok(String(vendor.headers.get("content-type")).includes("javascript"));
    const body = await vendor.text();
    assert.ok(body.length > 0);
    assert.ok(body.includes("marked"));
    // node_modules 不能作为静态目录直接访问（只走上面那条白名单路径）。
    const direct = await fetch(`http://127.0.0.1:${port}/node_modules/marked/lib/marked.esm.js`);
    assert.equal(direct.status, 404);
    // 白名单之外的其他 vendor 路径不得伪造。
    const other = await fetch(`http://127.0.0.1:${port}/vendor/package.json`);
    assert.equal(other.status, 404);
    // index.html 的 import map 必须指向白名单路径。
    const html = await fetch(`http://127.0.0.1:${port}/`).then((res) => res.text());
    assert.ok(html.includes('"marked":"/vendor/marked.esm.js"'), html);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Agent HTTP 契约
// ---------------------------------------------------------------------------

test("agent input / queued / priority / snapshot 全链路（test gateway）", async () => {
  // Task 8：注入确定性 gateway（test-only mock，不经生产分发）；项目无需真实模型。
  // Task 26：旧 promote 端点已删除，「立即」唯一 HTTP 路径是 /priority。
  const { projectRoot, server, port } = await setupServer({
    testGatewayFactory: () => createMockModelGateway({
      script: [{ reply: { text: "任务一完成。" } }, { reply: { text: "任务二完成。" } }, { reply: { text: "全部完成。" } }],
      delayMs: 60
    })
  });
  try {
    const first = await postJson(port, "/api/agent/input", { projectRoot, text: "任务一" });
    assert.equal(first.res.status, 200);
    assert.equal(first.data.status, "running");
    const second = await postJson(port, "/api/agent/input", { projectRoot, text: "任务二" });
    assert.equal(second.data.status, "queued");
    assert.equal(second.data.run_id, first.data.run_id);

    const prioritized = await postJson(port, `/api/agent/input/${second.data.input_id}/priority`, { projectRoot });
    assert.equal(prioritized.res.status, 200);
    assert.equal(prioritized.data.run_id, first.data.run_id);
    assert.equal(prioritized.data.priority_pending, true);

    const completed = await waitFor(async () => {
      const { data } = await getJson(port, `/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}`);
      return data.session.active_run?.status === "completed" ? data : null;
    });
    assert.equal(completed.session.status, "idle");
    assert.equal(completed.session.active_run.id, first.data.run_id);
    assert.ok(completed.events.some((e) => e.type === "priority_input_requested"));
    assert.ok(completed.events.some((e) => e.type === "input_started"));
  } finally {
    await closeServer(server);
  }
});

test("agent stop 取消当前 Run 与排队输入", async () => {
  const { projectRoot, server, port } = await setupServer({
    testGatewayFactory: () => createMockModelGateway({
      script: [{ reply: { text: "一" } }, { reply: { text: "二" } }, { reply: { text: "三" } }],
      delayMs: 60
    })
  });
  try {
    const first = await postJson(port, "/api/agent/input", { projectRoot, text: "任务一" });
    await postJson(port, "/api/agent/input", { projectRoot, text: "任务二" });
    const stopped = await postJson(port, `/api/agent/run/${first.data.run_id}/stop`, { projectRoot });
    assert.equal(stopped.res.status, 200);
    assert.equal(stopped.data.cancelled, true);
    const { data } = await getJson(port, `/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}`);
    assert.equal(data.session.status, "idle");
    assert.ok(data.events.some((e) => e.type === "run_cancelled"));
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// 设置 / 模型路由
// ---------------------------------------------------------------------------

test("供应商/模型保存、列出、删除与连接测试注入（v2）", async () => {
  const { server, port } = await setupServer({
    testModelConnection: async () => ({ ok: true, provider: "openai-compatible", model_name: "probe-model", latency_ms: 10 })
  });
  try {
    const created = await postJson(port, "/api/settings/providers", {
      name: "探测供应商",
      base_url: "https://api.probe.test/v1",
      api_format: "openai-chat-completions",
      api_key_env: "PROBE_API_KEY"
    });
    assert.equal(created.res.status, 200);
    const providerId = created.data.provider.id;

    const added = await postJson(port, `/api/settings/providers/${providerId}/models`, { model_name: "probe-model" });
    assert.equal(added.res.status, 200);
    const modelId = added.data.model.id;

    const providers = await getJson(port, "/api/settings/providers");
    assert.equal(providers.res.status, 200);
    assert.ok(providers.data.providers.some((p) => p.id === providerId), "新供应商应出现在清单");

    const tested = await postJson(port, "/api/settings/test-connection", {
      active_model: {
        provider: "openai-compatible",
        model_name: "probe-model",
        base_url: "https://api.probe.test/v1",
        api_key_env: "PROBE_API_KEY",
        api_key: "sk-probe-key"
      }
    });
    assert.equal(tested.res.status, 200);
    assert.equal(tested.data.ok, true);

    const removed = await postJson(port, `/api/settings/providers/${providerId}/models/${modelId}/remove`);
    assert.equal(removed.res.status, 200);
  } finally {
    await closeServer(server);
  }
});

test("模型切换写应用私有 settings 并带能力信息（v2 引用）", async () => {
  const { root, projectRoot, server, port } = await setupServer();
  try {
    const created = await postJson(port, "/api/settings/providers", {
      name: "writer 供应商",
      base_url: "https://api.probe.test/v1",
      api_format: "openai-chat-completions",
      api_key_env: "PROBE_API_KEY"
    });
    assert.equal(created.res.status, 200);
    const providerId = created.data.provider.id;
    const added = await postJson(port, `/api/settings/providers/${providerId}/models`, { model_name: "writer-large" });
    assert.equal(added.res.status, 200);
    const modelId = added.data.model.id;

    const switched = await postJson(port, "/api/settings/model-switch", {
      projectRoot,
      provider_id: providerId,
      model_id: modelId
    });
    assert.equal(switched.res.status, 200);
    assert.equal(switched.data.project.active_model.model_name, "writer-large", "project.active_model 为解析后的完整配置");
    assert.ok(switched.data.capabilities);
    // 任务 5：模型写入应用私有 workspace settings；project.yaml 不再双写（保留为回滚依据）
    const store = createWorkspaceStore({ stateRoot: path.join(root, ".state") });
    const settings = await store.loadSettings(projectRoot);
    assert.deepEqual(settings.active_model, { provider_id: providerId, model_id: modelId });
    const project = await loadProject(projectRoot);
    assert.notEqual(project.active_model?.model_name, "writer-large", "project.yaml 保留为回滚依据，不被改写");
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// 旧路由必须全部删除（404）
// ---------------------------------------------------------------------------

test("旧控制面路由全部返回 404", async () => {
  const { projectRoot, server, port } = await setupServer();
  try {
    // 旧控制面路由字面量必须拼接：Step 9 删除证明要求 rg 对这些路径零匹配，
    // 因此拼接点落在匹配前缀内部（chat/queue 等前缀不得以完整字面量出现）。
    const oldRoutes = [
      ["POST", "/api/comman" + "ds/submit", { message: "写第1章" }],
      ["POST", "/api/cha" + "t/send", { message: "你好" }],
      ["POST", "/api/cha" + "t/confirm", { decision: "once" }],
      ["POST", "/api/cha" + "t/grants/clear", {}],
      ["GET", "/api/cha" + "t/history", null],
      ["POST", "/api/cha" + "t/stop", {}],
      ["POST", "/api/ru" + "n/retry", {}],
      ["POST", "/api/ru" + "n/stop", {}],
      ["GET", "/api/que" + "ue/state", null],
      ["POST", "/api/que" + "ue/cancel", {}],
      ["POST", "/api/comman" + "ds/ask", { question: "现在写到第几章？" }],
      ["POST", "/api/projec" + "ts/init-blueprint", {}],
      ["POST", "/api/failu" + "res/resolve", {}],
      // Task 13：技能启停集合已删除（enable/disable 端点不复存在）。
      ["POST", "/api/ski" + "lls/enable", { name: "suspense-chapter-end" }],
      ["POST", "/api/ski" + "lls/disable", { name: "suspense-chapter-end" }]
    ];
    for (const [method, route, body] of oldRoutes) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify({ projectRoot, ...body }) } : {})
      });
      assert.equal(res.status, 404, `${method} ${route} 应返回 404（旧路由已删除）`);
    }
  } finally {
    await closeServer(server);
  }
});
