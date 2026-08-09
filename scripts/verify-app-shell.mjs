// scripts/verify-app-shell.mjs —— App Shell 验证（Task 13 改写）。
//
// 普通文件夹（无 project.yaml）+ 应用私有 stateRoot。不再创建旧项目、不再通过
// reviewing 门禁提交章节；文件夹本身即可打开并聊天，应用私有历史只写 stateRoot。
// 验证：
//   - 页面结构：单一对话挂载点（AgentSurface）、顶部 drawer 四分区、设置页 Agent 技能
//     分区与内置风格详情、composer/停止/重试入口、确定性工具；
//   - 静态契约：app.js 只 import agent/index.js（AgentSurface seam）、api-client 无旧
//     chat helper、drawer-panels 直接调用导出 route、agent.css 1040px 主内容轴；
//   - HTTP 公共行为：普通文件夹打开 + 第一条消息、dashboard hasProject:false 且保留
//     projectRoot、journal 只写 stateRoot/workspaces/<id>/agent、文件夹根不产生
//     project.yaml/.wwriting/agent 与旧运行态文件、快照可见、Run 终结；
//   - 安全 GFM 与工作组投影（真实 journal 事件经公共 seam 渲染）保持既有契约。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppShellServer } from "../src/core/app-server.mjs";

// 确定性 gateway：脚本耗尽后返回安全默认答复（普通聊天不必依赖真实模型）。
function createScriptedGatewayFactory(script) {
  const queue = script ? [...script] : [];
  const gateway = {
    async complete(request, { signal } = {}) {
      if (signal?.aborted) {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        throw error;
      }
      const entry = queue.shift();
      if (entry?.error) throw entry.error;
      return entry ?? { text: "（verify 默认答复）" };
    }
  };
  return () => gateway;
}

// ---- 准备：普通文件夹 + 应用私有 stateRoot ----
const demoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-shell-"));
const projectRoot = path.join(demoRoot, "普通文件夹");
const stateRoot = path.join(demoRoot, "user-data");
const secretsRoot = path.join(demoRoot, ".secrets");
await fs.mkdir(projectRoot, { recursive: true });
await fs.writeFile(path.join(projectRoot, "notes.txt"), "普通资料：写作参考笔记。\n", "utf8");

let server = null;
try {
  const gatewayFactory = createScriptedGatewayFactory([
    { text: "你好，我可以在这个工作区协助你。" }
  ]);
  server = createAppShellServer({
    workspaceRoot: demoRoot,
    selectedProjectRoot: null,
    stateRoot,
    secretsRoot,
    staticRoot: path.resolve("src", "app-shell"),
    port: 0,
    testGatewayFactory: gatewayFactory
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

  // ---- 打开普通文件夹（不再要求 project.yaml）----
  const opened = await postJson(`http://127.0.0.1:${port}/api/projects/open`, { projectRoot });
  assert.equal(opened.ok, true);

  const [html, js, apiClientJs, drawerPanelsJs, agentIndexJs, agentCss, settingsModalJs, viewJs, dashboard] = await Promise.all([
    fetchText(`http://127.0.0.1:${port}/`),
    fetchText(`http://127.0.0.1:${port}/app.js`),
    fetchText(`http://127.0.0.1:${port}/api-client.js`),
    fetchText(`http://127.0.0.1:${port}/drawer-panels.js`),
    fetchText(`http://127.0.0.1:${port}/agent/index.js`),
    fetchText(`http://127.0.0.1:${port}/agent/agent.css`),
    fetchText(`http://127.0.0.1:${port}/settings-modal.js`),
    fetchText(`http://127.0.0.1:${port}/agent/view.js`),
    fetchJson(`http://127.0.0.1:${port}/api/dashboard`)
  ]);

  // ---- 页面结构：单一对话挂载点 + 顶部 drawer/设置/阅读器 ----
  assert.ok(html.includes("小说智能体"));
  assert.ok(html.includes("新建小说"));
  assert.ok(html.includes("我的小说"));
  assert.ok(html.includes("打开本地文件夹"));
  assert.ok(html.includes('id="agent-surface"'), "index.html 应有唯一对话挂载点 #agent-surface");
  assert.ok(html.includes('./agent/agent.css'), "index.html 应加载 AgentSurface 样式");
  assert.ok(!html.includes('id="thread"'), "旧线程容器不得残留");
  assert.ok(!html.includes('id="composer-input"'), "旧 composer 不得残留");
  assert.ok(!html.includes('id="topbar-stop"'), "旧顶栏停止按钮不得残留");
  assert.ok(!html.includes('id="quick-rail"'), "右侧 quick rail 不得残留");
  assert.ok(!html.includes("data-dtab=\"run\""), "运行抽屉分区不得残留");
  assert.ok(!html.includes("data-dtab=\"reviewer\""), "审查抽屉分区不得残留");
  assert.ok(!html.includes("data-dtab=\"skills\""), "技能管理已迁入设置页，抽屉不得保留 skills tab");
  // Task 13：顶部 drawer 入口 + 章节/模型/资料/成本四个分区仍存在
  assert.ok(html.includes('id="open-drawer"'), "顶栏应有 drawer 入口按钮");
  for (const tab of ["chapters", "model", "research", "cost"]) {
    assert.ok(html.includes(`data-dtab="${tab}"`), `drawer 应保留 ${tab} 分区`);
  }
  assert.ok(html.includes("settings-modal"));
  assert.ok(html.includes("reader-scrim"));
  assert.ok(html.includes("toast-stack"));

  // 设置页技能分区 + 内置风格只读详情（Task 13：设置内置风格详情契约）
  assert.match(settingsModalJs, /id:\s*"skills"/u, "settings-modal 应声明 Agent 技能 tab");
  assert.ok(settingsModalJs.includes("Agent 技能"), "设置页应渲染 Agent 技能 分区");
  assert.ok(settingsModalJs.includes("内置写作风格"), "设置页应渲染 内置写作风格 分区");
  assert.ok(settingsModalJs.includes("spd-skill-row--readonly"), "内置风格行应使用只读无框行样式");
  assert.ok(settingsModalJs.includes("skills-detail-back"), "内置风格详情应有返回技能列表按钮");

  // AgentSurface composer / 停止 / 重试 入口（Task 13 可点击性契约的静态面）
  assert.ok(viewJs.includes('agent-composer-input"'), "view.js 应渲染 composer 输入框");
  assert.ok(viewJs.includes('agent-send"'), "view.js 应渲染发送按钮");
  assert.ok(viewJs.includes('agent-stop"'), "view.js 应渲染停止按钮");
  assert.ok(viewJs.includes('agent-retry"'), "view.js 应渲染重试按钮");

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
  // drawer-panels：直接调用导出 route，无运行/审查面板
  assert.match(drawerPanelsJs, /\/api\/projects\/export-book/u, "drawer-panels 应直接调用导出 route");
  assert.doesNotMatch(drawerPanelsJs, /sendChatMessageWithUX|renderRunPanel|renderReviewerPanel/u, "drawer-panels 不得引用旧聊天导出与运行/审查面板");
  // agent.css 布局基线（Task 12：1040px 主内容轴）
  assert.match(agentCss, /--content-column:\s*1040px/u, "agent.css 应保留 1040px 主内容轴");
  assert.match(agentCss, /max-width:\s*1040px/u, "agent.css 应保留 1040px 字面量契约");
  assert.match(
    agentCss,
    /\.agent-composer-menu--model \.agent-composer-popover\s*\{[^}]*width:\s*min\(320px,\s*calc\(100vw - 32px\)\)/u,
    "agent.css 应保留统一模型菜单视口钳制"
  );
  assert.match(agentCss, /\.agent-composer-popover\s*\{[^}]*bottom:\s*calc\(100% \+ 7px\)/u, "Composer 菜单应向上展开");

  // ---- HTTP 公共行为 ----
  // 普通文件夹：dashboard 是 hasProject:false 的最小工作区形状，不再 INTERNAL_ERROR
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.hasProject, false);
  assert.equal(dashboard.projectRoot, projectRoot, "dashboard 应保留已打开普通文件夹的 projectRoot");
  assert.equal(dashboard.project, null);

  // 第一条消息（普通文件夹与旧项目同等聊天能力）
  const agentInput = await postJson(`http://127.0.0.1:${port}/api/agent/input`, { projectRoot, text: "你好" });
  assert.equal(agentInput.ok, true);
  assert.equal(agentInput.status, "running");
  const snapshot = await waitForSnapshotIdle(port, projectRoot);
  assert.equal(snapshot.session.status, "idle");
  assert.equal(snapshot.session.active_run.status, "completed");

  // 应用私有历史只写 stateRoot：workspaces/<id>/agent 必须存在 journal 数据
  //（journal-manifest.json / segments/，新分段格式），文件夹根不得出现
  // project.yaml / .wwriting/agent / 旧运行态文件
  const journalFound = await containsWorkspaceJournal(stateRoot);
  assert.equal(journalFound, true, "journal 应写入应用私有 stateRoot/workspaces/<id>/agent");
  assert.equal(await pathExists(path.join(projectRoot, "project.yaml")), false, "普通文件夹不得创建 project.yaml");
  assert.equal(await pathExists(path.join(projectRoot, ".wwriting", "agent")), false, "项目内不得创建 .wwriting/agent");
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
  const workItemsJs = await fetchText(`http://127.0.0.1:${port}/agent/work-items.mjs`);
  assert.ok(viewJs.includes("agent-work-group"), "view.js 应渲染 details.agent-work-group");
  assert.ok(viewJs.includes("当前模型不支持查看"), "view.js 应输出 unsupported 空内容文案");
  assert.ok(viewJs.includes("本次没有可查看的思考内容"), "view.js 应输出 empty 空内容文案");
  assert.ok(workItemsJs.includes("已完成思考"), "work-items.mjs 应输出 已完成思考 终态标签");
  assert.ok(workItemsJs.includes("工作中"), "work-items.mjs 应输出工作组运行状态文案");

  // ---- 技能 catalog API：内置发现 + 普通文件夹项目同名覆盖（项目 > 内置）----
  const catalogBefore = await fetchJson(`http://127.0.0.1:${port}/api/skills/catalog?projectRoot=${encodeURIComponent(projectRoot)}`);
  assert.equal(catalogBefore.ok, true);
  assert.ok(catalogBefore.active.length >= 5, "catalog 应列出 5+ 内置技能");
  assert.ok(
    catalogBefore.active.some((skill) => skill.name === "avoid-ai-voice" && skill.source === "builtin"),
    "内置技能应出现在 active catalog"
  );
  // 三个内置写作风格（只读、保留名）
  for (const style of ["balanced", "fast-readable", "psychological-literary"]) {
    const skill = catalogBefore.active.find((item) => item.name === style);
    assert.ok(skill, `内置写作风格 ${style} 应出现在 catalog`);
    assert.equal(skill.readonly, true, `${style} 应标记为只读`);
    assert.equal(skill.source, "builtin", `${style} 应来自内置`);
  }
  assert.ok(Array.isArray(catalogBefore.shadowed), "shadowed 应为数组");
  // 普通文件夹项目同名技能覆盖：放入 <projectRoot>\skills\<name>\SKILL.md 即被发现
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
        hasProject: dashboard.hasProject,
        checks: { gfm: true, workGroup: true, skillsCatalog: true, plainFolderJournal: journalFound }
      },
      null,
      2
    )
  );
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.rm(demoRoot, { recursive: true, force: true }).catch(() => {});
}

// 递归判定：agent 根或任一 sessions/<id>/（Task 4 多会话布局）下存在 journal
// 数据（journal-manifest.json / segments / 单体 events.jsonl / 注册表 index.json）
// 即视为"有 journal 数据"——判空逻辑必须认识 sessions/ 布局。
async function hasJournalData(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return false;
  }
  if (names.includes("journal-manifest.json") || names.includes("segments") || names.includes("events.jsonl")) {
    return true;
  }
  if (names.includes("sessions")) {
    const sessionsDir = path.join(dir, "sessions");
    const sessionNames = await fs.readdir(sessionsDir).catch(() => []);
    if (sessionNames.includes("index.json")) return true;
    for (const name of sessionNames) {
      if (await hasJournalData(path.join(sessionsDir, name))) return true;
    }
  }
  return false;
}

async function containsWorkspaceJournal(stateRoot) {
  const workspacesDir = path.join(stateRoot, "workspaces");
  let entries;
  try {
    entries = await fs.readdir(workspacesDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await hasJournalData(path.join(workspacesDir, entry.name, "agent"))) return true;
  }
  return false;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
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
