// scripts/verify-app-shell.mjs —— App Shell 验证（Task 13 改写）。
//
// 普通文件夹（无 project.yaml）+ 应用私有 stateRoot。不再创建旧项目、不再通过
// reviewing 门禁提交章节；文件夹本身即可打开并聊天，应用私有历史只写 stateRoot。
// 验证：
//   - 页面结构：单一对话挂载点（AgentSurface）、顶部 drawer 四分区、设置页 Agent 技能
//     分区（F2：内置技能并入普通列表，无只读分区）、composer/停止/重试入口、确定性工具；
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

  const [html, js, apiClientJs, drawerPanelsJs, agentIndexJs, agentCss, settingsModalJs, viewJs, stylesCss, dashboard] = await Promise.all([
    fetchText(`http://127.0.0.1:${port}/`),
    fetchText(`http://127.0.0.1:${port}/app.js`),
    fetchText(`http://127.0.0.1:${port}/api-client.js`),
    fetchText(`http://127.0.0.1:${port}/drawer-panels.js`),
    fetchText(`http://127.0.0.1:${port}/agent/index.js`),
    fetchText(`http://127.0.0.1:${port}/agent/agent.css`),
    fetchText(`http://127.0.0.1:${port}/settings-modal.js`),
    fetchText(`http://127.0.0.1:${port}/agent/view.js`),
    fetchText(`http://127.0.0.1:${port}/styles.css`),
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

  // 第九轮：版本时间线/记忆分区/任务计划面板入口
  assert.ok(html.includes('id="reader-history"'), "阅读器必须含历史版本按钮");
  assert.ok(html.includes('data-dtab="memory"'), "抽屉必须含记忆标签");
  assert.ok(js.includes("createPlanPanel"), "任务计划面板模块必须被引用");
  assert.ok(stylesCss.includes(".plan-chip"), "任务计划面板样式必须存在");
  assert.ok(agentCss.includes(".system-notice"), "系统通知行样式必须存在");

  // 设置页技能分区（F2：内置写作风格并入普通列表，无只读分区/保留名文案）
  assert.match(settingsModalJs, /id:\s*"skills"/u, "settings-modal 应声明 Agent 技能 tab");
  assert.ok(settingsModalJs.includes("Agent 技能"), "设置页应渲染 Agent 技能 分区");
  assert.ok(settingsModalJs.includes('builtin: "内置"'), "内置来源标签应保留（SKILL_SOURCE_LABELS）");
  assert.ok(settingsModalJs.includes("其他来源"), "内置/随应用分发技能应并入「其他来源」普通列表");
  assert.ok(settingsModalJs.includes("被更高优先级同名技能覆盖，不生效。"), "shadowed 应显示通用优先级覆盖文案");
  assert.doesNotMatch(settingsModalJs, /spd-skill-row--readonly|保留名称/u, "设置页不得残留内置只读分区与保留名文案");

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
  // Task 23（规格 4.3 #6 / §6.5）：会话重命名不再依赖 window.prompt——生产前端
  // session-sidebar.mjs 不得出现 window.prompt 字面量，也不得回退到 globalThis.prompt
  //（旧实现来源，双形式防回归）。
  const sessionSidebarJs = await fetchText(`http://127.0.0.1:${port}/session-sidebar.mjs`);
  assert.doesNotMatch(sessionSidebarJs, /window\.prompt/u, "session-sidebar 不得使用 window.prompt（行内编辑器替换）");
  assert.doesNotMatch(sessionSidebarJs, /globalThis\.prompt/u, "session-sidebar 不得回退 globalThis.prompt（旧 seam 已删除）");
  assert.ok(sessionSidebarJs.includes('aria-label", "重命名对话"'), "行内改名 input 应带屏幕阅读器名称（规格 6.5）");
  // api-client：通用 helper 保留，旧 chat helper 删除
  assert.match(apiClientJs, /export async function getJson/);
  assert.match(apiClientJs, /export async function postJson/);
  assert.match(apiClientJs, /export function withProjectScope/);
  assert.doesNotMatch(apiClientJs, /sendChatMessage|confirmChatAction|stopChat|fetchChatHistory/u, "api-client 不得保留旧 chat helper");
  // drawer-panels：直接调用导出 route，无运行/审查面板
  assert.match(drawerPanelsJs, /\/api\/projects\/export-book/u, "drawer-panels 应直接调用导出 route");
  assert.doesNotMatch(drawerPanelsJs, /sendChatMessageWithUX|renderRunPanel|renderReviewerPanel/u, "drawer-panels 不得引用旧聊天导出与运行/审查面板");
  // agent.css 布局基线（Round10：1040px 主内容轴 token 所有权在 styles.css，agent.css 只引用）
  assert.match(stylesCss, /--content-column:\s*1040px/u, "styles.css 应定义 1040px 主内容轴变量");
  assert.match(agentCss, /var\(--content-column\)/u, "agent.css 应引用全局内容列 token");
  assert.doesNotMatch(agentCss, /--content-column:\s*1040px/u, "agent.css 不得重声明内容列变量");
  assert.doesNotMatch(agentCss, /max-width:\s*1040px/u, "agent.css 不得保留 1040px 字面量（token 所有权在 styles.css）");
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
  // details.agent-work-group，完成态自动折叠、思考项为 思考 N 秒 ----
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
    addEventListener(type, handler) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(handler);
    }
    // Task 25：模型设置页场景需要选择器匹配 + 事件派发（matchesSelector 支持
    // [attr] / [attr="value"] / .class，与 tests/app-shell/model-settings-page.test.mjs
    // 的 mock 同款近似；click 用于驱动按钮处理器）。
    matchesSelector(selector) {
      if (selector.startsWith("[")) {
        const match = /^\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]$/u.exec(selector);
        if (!match) return false;
        const attr = match[1];
        const expected = match[2];
        return expected === undefined ? this.getAttribute(attr) !== null : this.getAttribute(attr) === expected;
      }
      if (selector.startsWith(".")) return this.className.split(/\s+/u).includes(selector.slice(1));
      return false;
    }
    querySelector(selector) {
      const stack = [...this.children];
      while (stack.length > 0) {
        const node = stack.shift();
        if (node.matchesSelector?.(selector)) return node;
        stack.push(...node.children);
      }
      return null;
    }
    querySelectorAll(selector) {
      const results = [];
      const stack = [...this.children];
      while (stack.length > 0) {
        const node = stack.shift();
        if (node.matchesSelector?.(selector)) results.push(node);
        stack.push(...node.children);
      }
      return results;
    }
    _fire(type, ...args) {
      for (const fn of this._listeners.get(type) ?? []) fn(...args);
    }
    click() { this._fire("click"); }
    get value() { return this._value; }
    set value(v) { this._value = String(v ?? ""); }
  }
  {
    const doc = {
      createElement: (tag) => new MockElement(tag),
      createElementNS: (_namespace, tag) => new MockElement(tag),
      createTextNode: (text) => ({ nodeType: 3, textContent: String(text), children: [] })
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
    assert.ok(reasoningRows.every((row) => /思考 \d+ 秒/u.test(row.textContent)), "思考项完成态标签应为 思考 N 秒");
  }
  // 工作组静态契约：served view.js 渲染 details.agent-work-group 与两种空内容文案；
  // served work-items.mjs 投影 思考 N 秒 终态标签（回退 已完成思考）与 工作中 组状态文案
  const workItemsJs = await fetchText(`http://127.0.0.1:${port}/agent/work-items.mjs`);
  assert.ok(viewJs.includes("agent-work-group"), "view.js 应渲染 details.agent-work-group");
  assert.ok(viewJs.includes("当前模型不支持查看"), "view.js 应输出 unsupported 空内容文案");
  assert.ok(viewJs.includes("没有可查看的思考内容（本次无输出或该模型不支持）"), "view.js 应输出 empty 空内容文案");
  assert.ok(/思考 \$\{[^}]+\} 秒/u.test(workItemsJs) || workItemsJs.includes("思考 1 秒"), "work-items.mjs 应输出 思考 N 秒 终态标签模板");
  assert.ok(workItemsJs.includes("已完成思考"), "work-items.mjs 应保留 已完成思考 回退文案");
  assert.ok(workItemsJs.includes("工作中"), "work-items.mjs 应输出工作组运行状态文案");

  // ---- 技能 catalog API：内置发现 + 普通文件夹项目同名覆盖（项目 > 内置）----
  const catalogBefore = await fetchJson(`http://127.0.0.1:${port}/api/skills/catalog?projectRoot=${encodeURIComponent(projectRoot)}`);
  assert.equal(catalogBefore.ok, true);
  assert.ok(catalogBefore.active.length >= 5, "catalog 应列出 5+ 内置技能");
  assert.ok(
    catalogBefore.active.some((skill) => skill.name === "avoid-ai-voice" && skill.source === "builtin"),
    "内置技能应出现在 active catalog"
  );
  // 三个内置写作风格（F2：无只读/保留名保护，纯四层优先级同名覆盖）
  for (const style of ["balanced", "fast-readable", "psychological-literary"]) {
    const skill = catalogBefore.active.find((item) => item.name === style);
    assert.ok(skill, `内置写作风格 ${style} 应出现在 catalog`);
    assert.equal(skill.source, "builtin", `${style} 应来自内置`);
    assert.ok(!("readonly" in skill) && !("protected" in skill), `${style} 不得携带 readonly/protected（保护名单已删除）`);
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

  // =========================================================================
  // Task 25 Step 1：可重复视觉场景（规格 §6.5 / 4.3）
  //   长 provider/model 名 · 密钥已配置（无明文）· 连接错误状态 ·
  //   queue B/C/D + priority pending · context popover · rename editor 契约 ·
  //   成本统一人民币元（drawer-panels 三处 + cost-panel，无 $ / ¥）
  // =========================================================================
  const task25 = {
    modelSettings: false,
    queuePriority: false,
    errorState: false,
    contextPopover: false,
    renameEditor: false,
    costFormat: false
  };

  // ---- 场景 A：模型设置页——长名完整渲染 + 密钥已配置 + 连接错误（无明文） ----
  {
    const { createModelSettingsPage } = await import("../src/app-shell/model-settings-page.js");
    // 测试数据：长名称 + 假密钥（sk-round7- 前缀即测试哨兵，不得出现在 DOM）。
    const FAKE_KEY_MARK = "sk-round7-visual-fake-key-0001-not-real";
    const LONG_PROVIDER_NAME = "深度智能云算力平台-华东二区-超长供应商名称-abcdefghijklmnopqrstuvwxyz0123456789";
    const LONG_MODEL_NAME = "deepseek-chat-v4-ultra-flash-preview-20260813-long-extra-descriptor-name-abcdefghijklmnopqrstuvwxyz";
    const mspElements = [];
    const mspDoc = {
      createElement(tag) { const node = new MockElement(tag); mspElements.push(node); return node; },
      createElementNS(_ns, tag) { return new MockElement(tag); },
      createTextNode(text) { return { nodeType: 3, textContent: String(text), children: [] }; },
      querySelector(selector) {
        // 返回最后匹配（≈ 当前挂载；与 model-settings-page.test.mjs 同款近似）
        let hit = null;
        for (const node of mspElements) {
          if (node.matchesSelector?.(selector)) hit = node;
        }
        return hit;
      }
    };
    const mspList = mspDoc.createElement("div");
    mspList.setAttribute("data-provider-list", "");
    const mspDetail = mspDoc.createElement("div");
    mspDetail.setAttribute("data-provider-detail", "");
    const mspProviders = [
      {
        id: "longcloud",
        name: LONG_PROVIDER_NAME,
        type: "custom",
        status: "enabled",
        base_url: "http://127.0.0.1:1/v1",
        api_format: "openai-chat-completions",
        api_key_env: "WWRITING_ROUND7_FAKE_KEY",
        api_key_saved: true,
        models: [{ id: "m1", model_name: LONG_MODEL_NAME, enabled: true }]
      }
    ];
    const mspPage = createModelSettingsPage({
      fetchImpl: async (url, options = {}) => {
        if (String(url).endsWith("/test-connection")) {
          return { ok: false, status: 400, json: async () => ({ ok: false, message: "连接超时，请检查网络或 API Key" }) };
        }
        return { ok: true, json: async () => ({ providers: mspProviders, default_model: null }) };
      },
      documentRef: mspDoc,
      showToast: () => {}
    });
    // v4 任务 A3：渲染目标注入——attach({ list, detail }) 后 render/refresh 写入注入目标
    //（弃用 documentRef.querySelector 的全局 registry 双路径）。
    mspPage.attach({ list: mspList, detail: mspDetail });
    await mspPage.open();
    const mspAll = [];
    (function walk(node) {
      mspAll.push(node);
      for (const child of node.children) walk(child);
    })(mspList);
    (function walk(node) {
      mspAll.push(node);
      for (const child of node.children) walk(child);
    })(mspDetail);
    // 长 provider 名完整渲染在列表（不得截断/省略）
    assert.ok(
      mspList.textContent.includes(LONG_PROVIDER_NAME),
      "供应商列表应完整渲染超长供应商名（长名视觉场景）"
    );
    // 长 model 名完整保留在名称输入框 value（行内编辑不丢字）
    const modelNameInput = mspAll.find((el) => el.getAttribute?.("data-field") === "model_name");
    assert.ok(modelNameInput, "模型行应渲染模型名称输入框");
    assert.equal(modelNameInput.value, LONG_MODEL_NAME, "模型名称输入框应完整保留超长模型名");
    // 密钥已配置状态：只显示「已配置（env 名）」，绝不回显密钥明文（规格 4.3 #4）
    const keyStatus = mspAll.find((el) => el.getAttribute?.("data-api-key-status") === "true");
    assert.equal(
      keyStatus?.textContent,
      "已配置（WWRITING_ROUND7_FAKE_KEY）",
      "密钥状态应只显示 已配置 + 环境变量名，不得回显密钥"
    );
    assert.ok(
      !mspAll.some((el) => (el.textContent ?? "").includes("sk-round7")),
      "明文密钥不得出现在模型设置页 DOM"
    );
    // 连接错误状态：test-connection 失败渲染 ✗ 错误行（connection-result error）
    const connResult = await mspPage.testConnection(mspProviders[0], mspProviders[0].models[0], null);
    assert.equal(connResult.ok, false, "测试连接应失败并返回 ok:false");
    const errSlot = mspAll.find((el) => el.getAttribute?.("data-model-connection-result") === "m1");
    assert.ok(errSlot, "连接结果 slot 应存在");
    assert.ok(errSlot.textContent.includes("✗"), "连接失败应渲染 ✗ 错误文案");
    assert.ok(errSlot.textContent.includes("连接超时"), "连接错误文案应保留后端中文消息");
    task25.modelSettings = true;
  }

  // ---- 场景 B：agent surface——queue B/C/D + priority pending + 错误卡 + context popover ----
  {
    const root2 = new MockElement("div");
    const doc2 = {
      createElement: (tag) => new MockElement(tag),
      createElementNS: (_namespace, tag) => new MockElement(tag)
    };
    const { createAgentSurface } = await import("../src/app-shell/agent/index.js");
    const surface2 = createAgentSurface({ root: root2, api: null, document: doc2 });
    const sessionProjection = {
      session_id: "s1",
      status: "idle",
      queued_inputs: [],
      priority_input_id: null,
      active_run: null
    };
    surface2.applySnapshot({
      session: sessionProjection,
      events: [{ type: "session_created", session_id: "s1", seq: 1, at: "2026-08-13T00:00:00.000Z" }]
    });
    const QUEUE_INPUTS = [
      { id: "in-b", text: "队列任务 B：续写第三章雨夜冲突" },
      { id: "in-c", text: "队列任务 C：整理人物小传" },
      { id: "in-d", text: "队列任务 D：核对伏笔设定" }
    ];
    let seq = 10;
    for (const item of QUEUE_INPUTS) {
      surface2.applyEvent({ type: "input_queued", session_id: "s1", input_id: item.id, seq: seq++, at: "2026-08-13T00:01:00.000Z", payload: { input_id: item.id, text: item.text } });
    }
    // 「立即」（priority_input_requested）→ B 标为下一条，其余「立即」禁用（pending）
    surface2.applyEvent({ type: "priority_input_requested", session_id: "s1", input_id: "in-b", seq: seq++, at: "2026-08-13T00:01:01.000Z", payload: { input_id: "in-b" } });
    // context popover：usage 装配完成即渲染内容
    surface2.applyEvent({
      type: "context_usage_updated",
      session_id: "s1",
      seq: seq++,
      at: "2026-08-13T00:01:02.000Z",
      payload: {
        usage: { status: "ready", used_tokens: 12345, effective_context_window: 200000, approximate: true, window_source: "default_256k" }
      }
    });
    // 错误状态：run_failed → 错误卡（操作失败 + 消息）
    surface2.applyEvent({
      type: "run_failed",
      run_id: "r1",
      session_id: "s1",
      seq: seq++,
      at: "2026-08-13T00:01:03.000Z",
      payload: { error: "模型调用失败（可恢复）", code: "model_error" }
    });
    const nodes2 = [];
    (function walk(node) {
      nodes2.push(node);
      for (const child of node.children) walk(child);
    })(root2);
    const byClass = (cls) => nodes2.filter((node) => node.className.split(/\s+/u).includes(cls));
    // queue B/C/D：三行排队输入，文本完整
    const queueRows = byClass("agent-queue-item");
    assert.equal(queueRows.length, 3, "应渲染 3 行排队输入（B/C/D）");
    assert.deepEqual(
      queueRows.map((row) => row.textContent),
      [
        "队列任务 B：续写第三章雨夜冲突下一条立即取消",
        "队列任务 C：整理人物小传排队立即取消",
        "队列任务 D：核对伏笔设定排队立即取消"
      ],
      "队列行应包含原文 + 状态徽标 + 立即/取消按钮"
    );
    // priority pending：B 行带 --next 且徽标为「下一条」；其余为「排队」
    assert.ok(queueRows[0].classList.contains("agent-queue-item--next"), "优先输入行应标记为下一条");
    assert.equal(byClass("agent-queue-state")[0].textContent, "下一条", "B 徽标应为 下一条");
    assert.equal(byClass("agent-queue-state")[1].textContent, "排队", "C 徽标应为 排队");
    assert.equal(byClass("agent-queue-state")[2].textContent, "排队", "D 徽标应为 排队");
    // 已有优先在途 → 全部「立即」禁用（不产生乐观第二请求）
    const promoteButtons = byClass("agent-promote");
    assert.equal(promoteButtons.length, 3, "每行应有 立即 按钮");
    assert.ok(promoteButtons.every((btn) => btn.disabled === true), "优先在途时全部 立即 按钮应禁用");
    // 错误卡：标题 操作失败 + 消息
    const errorCards = byClass("agent-error");
    assert.equal(errorCards.length, 1, "run_failed 应渲染一张错误卡");
    assert.ok(errorCards[0].textContent.includes("操作失败"), "错误卡标题应为 操作失败");
    assert.ok(errorCards[0].textContent.includes("模型调用失败（可恢复）"), "错误卡应显示失败消息");
    // context popover：role=region + aria-label；内容行 = 用量/窗口/来源
    const popover = byClass("agent-context-popover")[0];
    assert.ok(popover, "context popover 应存在");
    assert.equal(popover.getAttribute("role"), "region");
    assert.equal(popover.getAttribute("aria-label"), "上下文用量");
    assert.ok(popover.textContent.includes("上下文用量"), "popover 应含标题");
    assert.ok(popover.textContent.includes("约 12,345 / 200,000 tokens"), "popover 应显示约量用量");
    assert.ok(popover.textContent.includes("6% · 256k 默认窗口"), "popover 应显示百分比与窗口来源");
    const ringButton = byClass("agent-context-ring")[0];
    assert.equal(
      ringButton.getAttribute("aria-label"),
      "上下文用量：6%（约 12,345 / 200,000 tokens）",
      "context ring 按钮 aria-label 应携带百分比与约量（规格 §6.5 屏幕阅读器名称）"
    );
    task25.queuePriority = true;
    task25.errorState = true;
    task25.contextPopover = true;
  }

  // ---- 场景 C：rename editor（行内改名编辑器契约，规格 4.3 #6 / §6.5）----
  {
    assert.ok(sessionSidebarJs.includes('className = "session-rename-editor"'), "行内改名编辑器应使用 session-rename-editor 类");
    assert.match(sessionSidebarJs, /event\.key === "Enter"/u, "改名编辑器应支持 Enter 提交");
    assert.match(sessionSidebarJs, /event\.key === "Escape"/u, "改名编辑器应支持 Escape 取消");
    assert.match(sessionSidebarJs, /addEventListener\("blur"/u, "改名编辑器失焦应按明确规则取消");
    assert.ok(sessionSidebarJs.includes('input.setAttribute("aria-label", "重命名对话")'), "改名输入框应带屏幕阅读器名称");
    assert.match(stylesCss, /\.session-rename-editor\s*\{/u, "styles.css 应定义 .session-rename-editor 样式（含焦点态）");
    task25.renameEditor = true;
  }

  // ---- 场景 D：成本统一人民币元——drawer-panels 三处 + cost-panel 渲染无 $ / ¥ ----
  {
    const servedDrawer = await fetchText(`http://127.0.0.1:${port}/drawer-panels.js`);
    const servedUtils = await fetchText(`http://127.0.0.1:${port}/utils.js`);
    const servedCostPanel = await fetchText(`http://127.0.0.1:${port}/components/cost-panel.js`);
    assert.doesNotMatch(servedDrawer, /formatMoney/u, "drawer-panels 不得引用 formatMoney（$ 格式已删除）");
    assert.match(servedDrawer, /formatYuan/u, "drawer-panels 应使用 formatYuan");
    assert.equal((servedDrawer.match(/formatYuan\(/gu) ?? []).length, 2, "drawer-panels 两处成本展示（章节 meta / 估算成本）应全走 formatYuan；主金额 pill 已归 cost-panel 总览");
    assert.match(servedCostPanel, /formatYuan\(/u, "cost-panel 应负责主金额（总览/缓存节省）的 formatYuan 渲染");
    assert.match(servedUtils, /export function formatYuan\(/u, "utils.js 应导出 formatYuan 单一出口");
    assert.doesNotMatch(servedUtils, /formatMoney/u, "utils.js 不得保留 formatMoney");
    assert.doesNotMatch(servedCostPanel, /formatMoney/u, "cost-panel 不得引用 formatMoney");
    // DOM 渲染级断言：drawer-panels 渲染成本分区 → 成本文本为 N.NN 元，无 $ / ¥
    const realDocument = globalThis.document;
    const realWindow = globalThis.window;
    globalThis.document = {
      createElement: (tag) => new MockElement(tag),
      createElementNS: (_namespace, tag) => new MockElement(tag),
      createTextNode: (text) => ({ nodeType: 3, textContent: String(text), children: [] })
    };
    globalThis.window = globalThis.window ?? { wwritingDesktop: undefined };
    try {
      const { createDrawerPanels } = await import("../src/app-shell/drawer-panels.js");
      const dashboard = {
        hasProject: true,
        project: { tool_permissions: {} },
        model_profile: { model_name: "deepseek-v4-pro", display: "deepseek-v4-pro", api_key_saved: true, endpoint: "https://api.deepseek.com" },
        config: { effective: { tool_permissions: {} } },
        summary: {
          costAvailable: true,
          estimatedCost: 1.2,
          modelCalls: 3,
          maxModelCalls: 10,
          completedChapters: 1,
          targetChapters: 3
        },
        chapters: [{ chapter_no: 1, title: "第一章 雨夜来信", status: "completed", actual_words: 1200 }],
        cost: { costAvailable: true, estimatedCost: 1.2, byChapter: { "1": { estimatedCost: 0.8, calls: 4 } } },
        sources: { latest: [] }
      };
      const bodyEl = new MockElement("div");
      const panels = createDrawerPanels({
        refs: { drawerBody: bodyEl },
        getDrawerTab: () => "cost",
        setDrawerTab: () => {},
        getDashboard: () => dashboard,
        loadDashboard: async () => {},
        openReader: () => {},
        openSettingsModal: () => {},
        showToast: () => {},
        showActionError: () => {},
        closeDrawer: () => {}
      });
      panels.renderDrawerBody();
      const costText = bodyEl.textContent;
      assert.ok(costText.includes("1.20 元"), "成本抽屉应显示两位小数 + 元（1.20 元）");
      assert.ok(costText.includes("0.80 元"), "章节成本应显示 0.80 元");
      assert.ok(!costText.includes("$") && !costText.includes("¥"), "成本抽屉不得出现 $ / ¥");
      assert.ok(!/\.\d{6}\b/u.test(costText), "成本不得残留六位小数格式");
      // 章节分区 meta「…字 · N.NN 元」与模型分区「估算成本 N.NN 元」同款断言
      const chapterMeta = [];
      for (const tab of ["chapters", "model"]) {
        const tabPanels = createDrawerPanels({
          refs: { drawerBody: bodyEl },
          getDrawerTab: () => tab,
          setDrawerTab: () => {},
          getDashboard: () => dashboard,
          loadDashboard: async () => {},
          openReader: () => {},
          openSettingsModal: () => {},
          showToast: () => {},
          showActionError: () => {},
          closeDrawer: () => {}
        });
        tabPanels.renderDrawerBody();
        const tabText = bodyEl.textContent;
        assert.ok(!tabText.includes("$") && !tabText.includes("¥"), `${tab} 分区不得出现 $ / ¥`);
        assert.ok(tabText.includes("元"), `${tab} 分区成本应带 元 单位`);
        if (tab === "chapters") chapterMeta.push(tabText);
      }
      assert.ok(
        chapterMeta[0].includes("1,200 字 · 0.80 元"),
        "章节列表 meta 应为 字数 · 0.80 元（formatYuan 两位小数 + 元）"
      );
    } finally {
      globalThis.document = realDocument;
      globalThis.window = realWindow;
    }
    task25.costFormat = true;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: `http://127.0.0.1:${port}`,
        projectRoot,
        hasProject: dashboard.hasProject,
        checks: { gfm: true, workGroup: true, skillsCatalog: true, plainFolderJournal: journalFound },
        task25
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
