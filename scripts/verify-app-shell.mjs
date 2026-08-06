// scripts/verify-app-shell.mjs —— App Shell 验证（统一 Agent 内核计划 Task 9 改写）。
//
// 用 HTTP 公共行为准备数据（/api/projects/init + 确定性领域模块补充分章节事实），
// 启动真实 server，验证：
//   - 页面结构：单一对话挂载点（AgentSurface）、导航、抽屉、设置、阅读器、确定性工具；
//   - 静态契约：app.js 只 import agent/index.js（AgentSurface seam）、api-client 无旧
//     chat helper、quick-rail 纯导航、drawer-panels 直接调用导出 route；
//   - HTTP 公共行为：/api/agent/input 跑通、snapshot 可见、dashboard 领域事实、
//     诊断注入 snapshot、export-book 返回真实路径、新项目无旧运行态文件。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { createProject } from "../src/core/project-store.mjs";

const port = await getFreePort();
const root = path.resolve(".demo_runs", `app-shell-${Date.now()}`);
const secretsRoot = path.join(root, ".local-secrets");

// ---- 准备项目：HTTP 公共行为（/api/projects/init）+ 章节事实落盘 ----
const { projectRoot } = await createProject(root, {
  slug: "dashboard-novel",
  title: "Dashboard Novel",
  story_seed: "A project created for app shell smoke verification.",
  target_chapters: 2,
  min_words_per_chapter: 10,
  target_words_per_chapter: 20,
  network_allowed: true
});
const project = await (async () => {
  const { parseSimpleYaml } = await import("../src/core/simple-yaml.mjs");
  return parseSimpleYaml(await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8"));
})();

// 章节事实：用项目领域模块提交两章（shell 验证不依赖 Agent 写章，只验证渲染与 API 流）
const { commitChapter, appendChapterSegment } = await import("../src/core/project-operations/chapter.mjs");
for (const chapterNo of [1, 2]) {
  await appendChapterSegment({
    projectRoot,
    projectId: project.project_id,
    chapterNo,
    segmentNo: 1,
    content: `第 ${chapterNo} 章的正文内容，用于验证 app shell 渲染与章节阅读。`
  });
  await commitChapter({ projectRoot, projectId: project.project_id, chapterNo });
}

const child = spawn(process.execPath, ["scripts/serve-app-shell.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    PROJECT_ROOT: projectRoot,
    WWRITING_SECRETS_ROOT: secretsRoot
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderrText = "";
child.stderr.on("data", (chunk) => {
  stderrText += chunk.toString("utf8");
});

try {
  await waitForServer(port);
  const [html, js, apiClientJs, quickRailJs, drawerPanelsJs, agentIndexJs, agentCss, dashboard] = await Promise.all([
    fetchText(`http://127.0.0.1:${port}/`),
    fetchText(`http://127.0.0.1:${port}/app.js`),
    fetchText(`http://127.0.0.1:${port}/api-client.js`),
    fetchText(`http://127.0.0.1:${port}/components/quick-rail.js`),
    fetchText(`http://127.0.0.1:${port}/drawer-panels.js`),
    fetchText(`http://127.0.0.1:${port}/agent/index.js`),
    fetchText(`http://127.0.0.1:${port}/agent/agent.css`),
    fetchJson(`http://127.0.0.1:${port}/api/dashboard`)
  ]);

  // ---- 页面结构：单一对话挂载点 + 导航/设置/阅读器/确定性工具 ----
  assert.ok(html.includes("小说智能体"));
  assert.ok(html.includes("新建小说"));
  assert.ok(html.includes("我的小说"));
  assert.ok(html.includes("打开本地文件夹"));
  assert.ok(html.includes('id="agent-surface"'), "index.html 应有唯一对话挂载点 #agent-surface");
  assert.ok(html.includes('./agent/agent.css'), "index.html 应加载 AgentSurface 样式");
  assert.ok(!html.includes('id="thread"'), "旧线程容器不得残留");
  assert.ok(!html.includes('id="composer-input"'), "旧 composer 不得残留");
  assert.ok(!html.includes('id="topbar-stop"'), "旧顶栏停止按钮不得残留");
  assert.ok(!html.includes("data-dtab=\"run\""), "运行抽屉分区不得残留");
  assert.ok(!html.includes("data-dtab=\"reviewer\""), "审查抽屉分区不得残留");
  for (const selector of ["id=\"drawer\"", "drawer-body", "data-dtab=\"chapters\"", "data-dtab=\"model\"", "data-dtab=\"skills\"", "data-dtab=\"research\"", "data-dtab=\"cost\""]) {
    assert.ok(html.includes(selector), `缺少抽屉结构: ${selector}`);
  }
  assert.ok(html.includes("settings-modal"));
  assert.ok(html.includes("reader-scrim"));
  assert.ok(html.includes("id=\"quick-rail\""));
  assert.ok(html.includes("toast-stack"));

  // ---- 静态契约：AgentSurface 是唯一对话 seam ----
  assert.match(js, /import\s*\{[^}]*createAgentSurface[^}]*\}\s*from\s*["']\.\/agent\/index\.js["']/, "app.js 应 import AgentSurface seam");
  assert.match(js, /createAgentSurface\s*\(/, "app.js 应创建 AgentSurface");
  assert.doesNotMatch(js, /thread-renderer|composer\.js|agent-truth|run-presentation|write-readiness|command-registry/u, "app.js 不得引用已删除的旧对话模块");
  assert.ok(agentIndexJs.includes("export function createAgentSurface"), "agent/index.js 应导出 createAgentSurface");
  // api-client：通用 helper 保留，旧 chat helper 删除
  assert.match(apiClientJs, /export async function getJson/);
  assert.match(apiClientJs, /export async function postJson/);
  assert.match(apiClientJs, /export function withProjectScope/);
  assert.doesNotMatch(apiClientJs, /sendChatMessage|confirmChatAction|stopChat|fetchChatHistory/u, "api-client 不得保留旧 chat helper");
  // quick-rail：纯导航四槽位，无命令注册副作用
  assert.doesNotMatch(quickRailJs, /commands\/index|command-registry/u, "quick-rail 不得有命令注册副作用");
  assert.ok(quickRailJs.includes("function renderQuickRail"));
  assert.ok(quickRailJs.includes("function bindQuickRailKeys"));
  // drawer-panels：直接调用导出 route
  assert.match(drawerPanelsJs, /\/api\/projects\/export-book/u, "drawer-panels 应直接调用导出 route");
  assert.doesNotMatch(drawerPanelsJs, /sendChatMessageWithUX|renderRunPanel|renderReviewerPanel/u, "drawer-panels 不得引用旧聊天导出与运行/审查面板");
  // agent.css 布局基线
  assert.match(agentCss, /--content-column:\s*900px/u, "agent.css 应保留 900px 内容列");
  assert.match(
    agentCss,
    /\.agent-composer-menu--model \.agent-composer-popover\s*\{[^}]*width:\s*min\(320px,\s*calc\(100vw - 32px\)\)/u,
    "agent.css 应保留统一模型菜单视口钳制"
  );
  assert.match(agentCss, /\.agent-composer-popover\s*\{[^}]*bottom:\s*calc\(100% \+ 7px\)/u, "Composer 菜单应向上展开");

  // ---- HTTP 公共行为 ----
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.hasProject, true);
  assert.equal(dashboard.model_profile.display, "Mock / mock-writer");
  assert.equal(dashboard.summary.completedChapters, 2);
  assert.equal(dashboard.summary.targetChapters, 2);
  assert.equal(dashboard.summary.progressPercent, 100);
  assert.equal(dashboard.project.title, "Dashboard Novel");
  assert.ok(dashboard.chapters.some((chapter) => chapter.artifact?.state === "committed"));
  assert.ok(dashboard.skills.items.length >= 5, "built-in skill pack should list 5+ skills");
  assert.ok(dashboard.skills.items.some((skill) => skill.name === "avoid-ai-voice"), "built-in skill should be listed");
  // dashboard 不再返回运行推断字段
  assert.equal(dashboard.summary.projectStatus, undefined, "dashboard 不得再返回旧运行状态推断");
  assert.equal(dashboard.review, undefined, "dashboard 不得再返回旧审查报告");
  assert.equal(dashboard.failures, undefined, "dashboard 不得再返回故障卡");
  assert.equal(dashboard.recent_tool_events, undefined, "dashboard 不得再返回 recent tool events");

  // 章节阅读
  const chapterRead = await fetchJson(`http://127.0.0.1:${port}/api/chapters/read?chapter=1`);
  assert.equal(chapterRead.ok, true);
  assert.equal(chapterRead.chapter_no, 1);
  assert.ok(chapterRead.content.length > 0);
  const chapterReadMissing = await fetch(`http://127.0.0.1:${port}/api/chapters/read?chapter=999`);
  assert.equal(chapterReadMissing.ok, false);

  // 诊断：注入 agent.snapshot 的稳定 loader
  const diagnostics = await fetchJson(`http://127.0.0.1:${port}/api/diagnostics?projectRoot=${encodeURIComponent(projectRoot)}`);
  assert.equal(diagnostics.ok, true);
  assert.equal(typeof diagnostics.queue, "object");
  assert.equal(typeof diagnostics.costHealth, "object");
  assert.equal(typeof diagnostics.recoveryHint, "object");
  assert.ok(Array.isArray(diagnostics.recentEvents));

  // 项目列表与打开
  const projectList = await fetchJson(`http://127.0.0.1:${port}/api/projects/list`);
  assert.equal(projectList.ok, true);
  assert.ok(projectList.projects.some((p) => p.projectRoot === projectRoot));
  await postJson(`http://127.0.0.1:${port}/api/projects/open`, { projectRoot });
  const reopenedDashboard = await fetchJson(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(reopenedDashboard.projectRoot, projectRoot);

  // Agent HTTP：mock provider 简单对话跑通（快照可见、Run 终结）
  const agentInput = await postJson(`http://127.0.0.1:${port}/api/agent/input`, { projectRoot, text: "你好" });
  assert.equal(agentInput.ok, true);
  assert.equal(agentInput.status, "running");
  const snapshot = await waitForSnapshotIdle(port, projectRoot);
  assert.equal(snapshot.session.status, "idle");
  assert.equal(snapshot.session.active_run.status, "completed");

  // 确定性导出：直接 route，返回真实路径且不创建 Run
  const callsBefore = snapshot.events.filter((e) => e.type === "run_started").length;
  const exported = await postJson(`http://127.0.0.1:${port}/api/projects/export-book`, { projectRoot, format: "txt" });
  assert.equal(exported.ok, true);
  assert.ok(exported.path.length > 0);
  assert.ok(exported.chapters >= 1);
  const exportContent = await fs.readFile(exported.path, "utf8");
  assert.ok(exportContent.includes("第 1 章的正文内容"), "导出应包含章节正文");
  const after = await fetchJson(`http://127.0.0.1:${port}/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}`);
  assert.equal(after.events.filter((e) => e.type === "run_started").length, callsBefore, "导出不得创建 Agent Run");

  // 新项目无旧状态文件
  const LEGACY_NAMES = ["agent_state", "task_queue"].map((n) => n + ".json").concat(["failures", "chat_history"].map((n) => n + ".jsonl"));
  for (const name of LEGACY_NAMES) {
    assert.equal(await pathExists(path.join(projectRoot, name)), false, `不得创建 ${name}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: `http://127.0.0.1:${port}`,
        projectRoot,
        completedChapters: dashboard.summary.completedChapters
      },
      null,
      2
    )
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => child.once("close", resolve));
  }
  await fs.rm(root, { recursive: true, force: true });
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function waitForServer(targetPort) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      await fetchText(`http://127.0.0.1:${targetPort}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`app shell server did not start. ${stderrText}`);
}

async function waitForSnapshotIdle(targetPort, projectRoot) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const snapshot = await fetchJson(`http://127.0.0.1:${targetPort}/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}`);
    if (snapshot.session.status === "idle") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("agent snapshot did not become idle");
}

async function fetchText(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} must return 2xx`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} must return 2xx`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.ok, true, `${url} must return 2xx`);
  const data = await response.json();
  assert.equal(data.ok, true);
  return data;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (!port) {
          reject(new Error("failed to allocate a free port"));
          return;
        }
        resolve(port);
      });
    });
  });
}
