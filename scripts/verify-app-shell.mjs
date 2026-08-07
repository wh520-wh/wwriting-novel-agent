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

// 章节事实：用项目领域模块提交两章（shell 验证不依赖 Agent 写章，只验证渲染与 API 流）。
// 正文必须通过内置技能 reviewing 门禁（suspense-ending/chapter-opening/dialogue-ratio/ai-voice）。
const { commitChapter, appendChapterSegment } = await import("../src/core/project-operations/chapter.mjs");
const GATE_PASSING_CHAPTER = "雨夜，雨声突然变大。林深猛地推开门，冲进老宅的客厅。他浑身湿透，抹了一把脸，低声道：“信上说，老宅的钟会在午夜敲十三下。”烛光下，墙上的照片里竟是多年不见的父亲。他正要细看，门外却传来一阵急促的敲门声。";
for (const chapterNo of [1, 2]) {
  await appendChapterSegment({
    projectRoot,
    projectId: project.project_id,
    chapterNo,
    segmentNo: 1,
    content: GATE_PASSING_CHAPTER
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
  for (const selector of ["id=\"drawer\"", "drawer-body", "data-dtab=\"chapters\"", "data-dtab=\"model\"", "data-dtab=\"research\"", "data-dtab=\"cost\""]) {
    assert.ok(html.includes(selector), `缺少抽屉结构: ${selector}`);
  }
  // Task 13：技能管理从抽屉移入设置页（Agent 技能 分区），抽屉不再有 skills tab
  assert.ok(!html.includes("data-dtab=\"skills\""), "技能管理已迁入设置页，抽屉不得保留 skills tab");
  assert.ok(html.includes("settings-modal"));
  assert.ok(html.includes("reader-scrim"));
  assert.ok(html.includes("id=\"quick-rail\""));
  assert.ok(html.includes("toast-stack"));

  // 设置页技能分区：Agent 技能 tab 存在（Task 13，skills catalog/import/delete 入口）
  const settingsModalJs = await fetchText(`http://127.0.0.1:${port}/settings-modal.js`);
  assert.match(settingsModalJs, /id:\s*"skills"/u, "settings-modal 应声明 Agent 技能 tab");
  assert.ok(settingsModalJs.includes("Agent 技能"), "设置页应渲染 Agent 技能 分区");

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
  assert.ok(exportContent.includes("老宅的钟会在午夜敲十三下"), "导出应包含章节正文");
  const after = await fetchJson(`http://127.0.0.1:${port}/api/agent/snapshot?projectRoot=${encodeURIComponent(projectRoot)}`);
  assert.equal(after.events.filter((e) => e.type === "run_started").length, callsBefore, "导出不得创建 Agent Run");

  // 新项目无旧状态文件
  const LEGACY_NAMES = ["agent_state", "task_queue"].map((n) => n + ".json").concat(["failures", "chat_history"].map((n) => n + ".jsonl"));
  for (const name of LEGACY_NAMES) {
    assert.equal(await pathExists(path.join(projectRoot, name)), false, `不得创建 ${name}`);
  }

  // ---- 安全 GFM：表格/任务列表/链接/代码块/引用渲染，raw HTML 与危险 URL 不执行 ----
  const { renderMarkdown } = await import("../src/app-shell/markdown-lite.mjs");
  const gfmHtml = renderMarkdown([
    "# 第一章",
    "",
    "| 章节 | 状态 |",
    "|---|---|",
    "| 一 | 完成 |",
    "",
    "- [x] 已完成任务",
    "- [ ] 待办任务",
    "",
    "**加粗** [外部链接](https://example.com) `行内代码`",
    "",
    "> 引用文字",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "~~删除线~~"
  ].join("\n"));
  assert.ok(gfmHtml.includes("<table>"), "GFM 表格应渲染为 <table>");
  assert.ok(gfmHtml.includes('type="checkbox"'), "GFM 任务列表应渲染 checkbox");
  assert.ok(gfmHtml.includes('href="https://example.com"') && gfmHtml.includes("data-external-link"), "http(s) 链接应渲染为带 data-external-link 的锚点");
  assert.ok(gfmHtml.includes('class="md-fence"'), "围栏代码块应渲染为 pre.md-fence");
  assert.ok(gfmHtml.includes("<blockquote>"), "引用应渲染为 blockquote");
  assert.ok(gfmHtml.includes("<del>"), "删除线应渲染为 del");
  const unsafeHtml = renderMarkdown('<script>alert(1)</script> [点击](javascript:alert(1)) [数据](data:text/html;base64,xxx) [文件](file:///etc/passwd)');
  assert.ok(!unsafeHtml.includes("<script>"), "raw <script> 不得渲染为可执行元素");
  assert.ok(!/<a\s/i.test(unsafeHtml), "javascript:/data:/file: 链接不得生成锚点");
  assert.ok(unsafeHtml.includes("alert(1)"), "危险内容应以纯文本保留可读");

  // ---- 工作组：真实 journal 事件经公共 seam（createAgentSurface）渲染为
  // details.agent-work-group，完成态自动折叠、思考项为 已完成思考 ----
  //（不 import agent 内部文件——依赖规则 B 只允许经 agent/index.js 对外暴露；
  // 投影行为本身由 tests/app-shell/work-items.test.mjs 单测覆盖。）
  class MockElement {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this._parent = null;
      this._text = "";
      this._innerHTML = "";
      this.dataset = {};
      this.style = {};
      this._attrs = {};
      this._listeners = new Map();
      this._value = "";
      this.hidden = false;
      this.disabled = false;
      this.open = false;
      this.scrollTop = 0;
      this.scrollHeight = 0;
      this.clientHeight = 0;
      const classes = new Set();
      let className = "";
      Object.defineProperty(this, "className", {
        get() { return className; },
        set(value) {
          className = String(value ?? "");
          classes.clear();
          for (const item of className.split(/\s+/u).filter(Boolean)) classes.add(item);
        },
        enumerable: true,
        configurable: true
      });
      this.classList = {
        add: (...items) => {
          for (const item of items) classes.add(item);
          className = [...classes].join(" ");
        },
        remove: (...items) => {
          for (const item of items) classes.delete(item);
          className = [...classes].join(" ");
        },
        contains: (item) => classes.has(item),
        toggle: (item, force) => {
          const enabled = force === undefined ? !classes.has(item) : Boolean(force);
          if (enabled) classes.add(item);
          else classes.delete(item);
          className = [...classes].join(" ");
          return enabled;
        }
      };
    }
    get textContent() {
      return this._text + this.children.map((child) => child.textContent).join("");
    }
    set textContent(value) {
      this._text = String(value ?? "");
      this._innerHTML = "";
      this.children = [];
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(value) {
      this._innerHTML = String(value ?? "");
      this._text = this._innerHTML.replace(/<[^>]*>/gu, "");
      this.children = [];
    }
    setAttribute(name, value) { this._attrs[name] = String(value); }
    getAttribute(name) { return this._attrs[name] ?? null; }
    append(...nodes) {
      for (const node of nodes) {
        if (node._parent) node._parent.removeChild(node);
        node._parent = this;
        this.children.push(node);
      }
    }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) {
      for (const child of this.children) child._parent = null;
      this.children = [];
      this.append(...nodes);
    }
    removeChild(node) {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
      node._parent = null;
    }
    remove() { if (this._parent) this._parent.removeChild(this); }
    addEventListener() { /* 无交互，仅记录 */ }
    get value() { return this._value; }
    set value(v) { this._value = String(v ?? ""); }
  }
  {
    const doc = {
      createElement: (tag) => new MockElement(tag),
      createElementNS: (_namespace, tag) => new MockElement(tag)
    };
    const root = new MockElement("div");
    const { createAgentSurface } = await import("../src/app-shell/agent/index.js");
    const surface = createAgentSurface({ root, api: null, document: doc });
    for (const event of snapshot.events) surface.applyEvent(event);
    const allNodes = [];
    (function walk(node) {
      allNodes.push(node);
      for (const child of node.children) walk(child);
    })(root);
    const groupEl = allNodes.find((node) => node.className === "agent-work-group");
    assert.ok(groupEl, "真实事件流应渲染 details.agent-work-group");
    assert.equal(groupEl.open, false, "completed 工作组应自动折叠（open=false）");
    assert.ok(groupEl.textContent.includes("工作了"), "工作组 summary 应显示有效工作耗时文案");
    const reasoningRows = allNodes.filter((node) => node.dataset?.kind === "reasoning");
    assert.ok(reasoningRows.length >= 1, "每个模型轮次应产生一个思考项");
    assert.ok(reasoningRows.every((row) => row.textContent.includes("已完成思考")), "思考项完成态标签应为 已完成思考");
  }
  // 工作组静态契约：served view.js 渲染 details.agent-work-group 与两种空内容文案；
  // served work-items.mjs 投影 已完成思考 终态标签与 工作中 组状态文案
  const viewJs = await fetchText(`http://127.0.0.1:${port}/agent/view.js`);
  const workItemsJs = await fetchText(`http://127.0.0.1:${port}/agent/work-items.mjs`);
  assert.ok(viewJs.includes("agent-work-group"), "view.js 应渲染 details.agent-work-group");
  assert.ok(viewJs.includes("当前模型不支持查看"), "view.js 应输出 unsupported 空内容文案");
  assert.ok(viewJs.includes("本次没有可查看的思考内容"), "view.js 应输出 empty 空内容文案");
  assert.ok(workItemsJs.includes("已完成思考"), "work-items.mjs 应输出 已完成思考 终态标签");
  assert.ok(workItemsJs.includes("工作中"), "work-items.mjs 应输出工作组运行状态文案");

  // ---- 技能 catalog API：内置发现 + 项目同名覆盖（project > 内置）----
  const catalogBefore = await fetchJson(`http://127.0.0.1:${port}/api/skills/catalog?projectRoot=${encodeURIComponent(projectRoot)}`);
  assert.equal(catalogBefore.ok, true);
  assert.equal(catalogBefore.has_project, true);
  assert.equal(catalogBefore.project_root, projectRoot);
  assert.ok(catalogBefore.active.length >= 5, "catalog 应列出 5+ 内置技能");
  assert.ok(
    catalogBefore.active.some((skill) => skill.name === "avoid-ai-voice" && skill.source === "builtin"),
    "内置技能应出现在 active catalog"
  );
  assert.ok(Array.isArray(catalogBefore.shadowed), "shadowed 应为数组");
  assert.ok(Array.isArray(catalogBefore.migration_errors), "migration_errors 应为数组");
  // 项目同名覆盖：放入 <projectRoot>\skills\<name>\SKILL.md 即被发现并覆盖内置版本
  await fs.mkdir(path.join(projectRoot, "skills", "avoid-ai-voice"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "skills", "avoid-ai-voice", "SKILL.md"),
    [
      "---",
      "name: avoid-ai-voice",
      "description: 项目级同名技能，覆盖内置版本。",
      "version: 1.0.0",
      "---",
      "",
      "# 项目覆盖版"
    ].join("\n"),
    "utf8"
  );
  const catalogAfter = await fetchJson(`http://127.0.0.1:${port}/api/skills/catalog?projectRoot=${encodeURIComponent(projectRoot)}`);
  const activeSkill = catalogAfter.active.find((skill) => skill.name === "avoid-ai-voice");
  assert.equal(activeSkill.source, "project", "项目同名技能应覆盖内置版本（project > builtin）");
  assert.ok(
    catalogAfter.shadowed.some((skill) => skill.name === "avoid-ai-voice" && skill.source === "builtin"),
    "被覆盖的内置版本应出现在 shadowed"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: `http://127.0.0.1:${port}`,
        projectRoot,
        completedChapters: dashboard.summary.completedChapters,
        checks: { gfm: true, workGroup: true, skillsCatalog: true }
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
