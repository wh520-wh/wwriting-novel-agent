# WWriting 全面优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除后端可靠性缺陷（重试/超时/流式/性能）、拆分前端 2652 行单体、补全测试盲区、统一 HTTP 错误格式。

**Architecture:** 3 组并行 — A 后端可靠性（model-client 重试 + SSE 流式 + event-log 优化 + 适配器注入 + 日志 + HTTP 统一）、B 前端拆分（7 个模块从 app.js 提取 + CSS 去重）、C 测试补全（glob 修复 + 组件测试 + 核心模块测试 + schema 迁移测试）。

**Tech Stack:** Node.js 24+, Electron 42, vanilla JS ES modules, Node built-in test runner, GSAP

**Commit 策略:** 本计划不包含 git commit 步骤。每个 Task 完成后记录变更文件列表，由用户决定何时 staged/commit。绝不使用 `git add -A`。

---

## 文件结构总览

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/core/http-error.mjs` | HTTP 错误工具类，统一 `{ ok, code, message, details }` 格式 |
| `src/app-shell/utils.js` | 纯工具函数（formatNumber, translateStage 等） |
| `src/app-shell/api-client.js` | HTTP 请求封装（getJson, postJson, readResponseJson） |
| `src/app-shell/icons.js` | ICON_PATHS + icon() 函数 |
| `src/app-shell/thread-renderer.js` | 对话流渲染引擎 |
| `src/app-shell/drawer-panels.js` | 右侧面板渲染 |
| `src/app-shell/settings-modal.js` | 设置弹窗 |
| `src/app-shell/composer.js` | 命令解析 + 提交 |
| `tests/model-client-retry.test.mjs` | 重试/超时/AbortSignal 测试 |
| `tests/event-log.test.mjs` | 事件日志尾部读取测试 |
| `tests/app-shell/failure-card-render.test.mjs` | failure-card 组件测试 |
| `tests/app-shell/activity-strip-render.test.mjs` | activity-strip 组件测试 |
| `tests/cost-tracker.test.mjs` | 成本跟踪测试 |
| `tests/chapter-memory.test.mjs` | 章节记忆测试 |
| `tests/retry-candidates.test.mjs` | 重试候选算法测试 |
| `tests/simple-yaml.test.mjs` | YAML 解析器测试 |
| `tests/schema-migration.test.mjs` | Schema 迁移测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `package.json` | test script 增加 `tests/app-shell/*.test.mjs` glob |
| `src/core/model-client.mjs` | 增加重试/超时/AbortSignal 组合/onRetry 回调 |
| `src/core/provider-adapters.mjs` | ProviderTransportError 增加 reason；SSE 真流式；stream_options |
| `src/core/event-log.mjs` | readEvents limit 走尾部读取 |
| `src/core/agent-engine.mjs` | createModelRuntime 接受可选 adapters；onRetry 回调 |
| `src/core/app-server.mjs` | HTTP 错误统一；静默 catch 改日志；可选 adapters 注入 |
| `src/core/app-state.mjs` | 静默 catch 改日志 |
| `src/core/skill-runtime.mjs` | 静默 catch 改日志 |
| `src/core/side-question.mjs` | 静默 catch 改日志 |
| `src/core/app-dashboard.mjs` | 静默 catch 改日志 |
| `src/app-shell/app.js` | 逐模块提取；loadDashboard 并行化；submitFailureAction 统一 |
| `src/app-shell/styles.css` | 去重 + 变量化 |
| `src/app-shell/components/activity-strip.js` | innerHTML → replaceChildren |

---

## 执行顺序

```
Phase 1: C1 + C3（立即，无依赖）
  Task 1: C1 - 修复 npm test glob
  Task 2: C3a - failure-card 组件测试
  Task 3: C3b - activity-strip 组件测试

Phase 2: A 组（后端可靠性，串行） + B 组（前端拆分，串行） 并行
  A: Task 4→10
  B: Task 11→18

Phase 3: C2 + C4（依赖 A/B 完成）
  Task 19: C2 - 核心模块补充单测
  Task 20: C4 - Schema 迁移测试

Phase 4: 收口验证
  Task 21: 完整验证管线
```

---

## Phase 1: C1 + C3（立即执行）

### Task 1: C1 — 修复 npm test glob

**Files:**
- Modify: `package.json:14`

- [ ] **Step 1: 修改 test script**

`package.json` 第 14 行，当前：
```json
"test": "node --test tests/*.test.mjs",
```

改为：
```json
"test": "node --test tests/*.test.mjs tests/app-shell/*.test.mjs",
```

- [ ] **Step 2: 验证 app-shell 测试被发现**

Run:
```powershell
npm test 2>&1 | Select-String -Pattern "app-shell"
```

Expected: 输出中包含 `agent-truth-failures`、`derive-activity`、`derive-badges` 测试文件名。

- [ ] **Step 3: 跑全部测试确认无回归**

Run:
```powershell
npm test
```

Expected: 全部通过（已有的 24 个 + 新发现的 3 个 app-shell 测试）。

---

### Task 2: C3a — failure-card 组件渲染测试

**Files:**
- Create: `tests/app-shell/failure-card-render.test.mjs`
- Read: `src/app-shell/components/failure-card.js`
- Read: `src/shared/failure-commands.mjs`

- [ ] **Step 1: 编写带极简 DOM mock 的 failure-card 渲染测试**

创建 `tests/app-shell/failure-card-render.test.mjs`：

```javascript
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// === 极简 DOM mock，足够 renderFailureCard 运行 ===
class MockElement {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.textContent = "";
    this.dataset = {};
    this.children = [];
    this.disabled = false;
    this._listeners = {};
    this._style = {};
    this._hidden = false;
  }
  get hidden() { return this._hidden; }
  set hidden(v) { this._hidden = v; }
  get style() { return this._style; }
  set textContent(v) { this._textContent = v; }
  get textContent() { return this._textContent ?? ""; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  classList = {
    add: (...cls) => { this.className += " " + cls.join(" "); },
    remove: () => {},
    toggle: () => {},
    contains: (c) => this.className.includes(c)
  };
  querySelector(sel) {
    // 简单递归查找
    for (const child of this.children) {
      if (child.className?.includes(sel.replace(".", ""))) return child;
      const found = child.querySelector?.(sel);
      if (found) return found;
    }
    return null;
  }
}

const origDocument = globalThis.document;
before(() => {
  globalThis.document = {
    createElement: (tag) => new MockElement(tag),
    createElementNS: (ns, tag) => new MockElement(tag),
    querySelector: () => null
  };
});
after(() => { globalThis.document = origDocument; });

// === 测试 ===
import { renderFailureCard, FAILURE_COMMANDS } from "../../src/app-shell/components/failure-card.js";

function makeCard(overrides = {}) {
  return {
    id: "f-001",
    seq: 1,
    kind: "words-short",
    title: "字数不足",
    body: "第 3 章只有 1200 字，目标 3000 字",
    ts: "2026-06-01T10:30:00Z",
    actions: [
      { command: "retry-segment", label: "重试" },
      { command: "fill-words", label: "补字", args: { targetWords: 3000 } }
    ],
    resolution: null,
    diagnostics: { actual: 1200, target: 3000 },
    ...overrides
  };
}

describe("renderFailureCard", () => {
  it("should return an article element with failure-card class", () => {
    const el = renderFailureCard(makeCard(), { onAction: () => {} });
    assert.equal(el.tagName, "article");
    assert.ok(el.className.includes("failure-card"));
    assert.ok(el.className.includes("kind-words-short"));
  });

  it("should render header with seq, title, and time", () => {
    const el = renderFailureCard(makeCard(), { onAction: () => {} });
    const head = el.children.find(c => c.className?.includes("failure-head"));
    assert.ok(head, "should have failure-head element");
    assert.ok(head.textContent.includes("故障 #1"));
    assert.ok(head.textContent.includes("字数不足"));
    assert.ok(head.textContent.includes("18:30")); // UTC+8 for 10:30Z
  });

  it("should render body text", () => {
    const el = renderFailureCard(makeCard(), { onAction: () => {} });
    const body = el.children.find(c => c.className?.includes("failure-body"));
    assert.ok(body);
    assert.ok(body.textContent.includes("1200 字"));
  });

  it("should render action buttons", () => {
    const el = renderFailureCard(makeCard(), { onAction: () => {} });
    const actions = el.children.find(c => c.className?.includes("failure-actions"));
    assert.ok(actions);
    assert.equal(actions.children.length, 2);
    assert.equal(actions.children[0].textContent, "重试");
    assert.equal(actions.children[1].textContent, "补字");
  });

  it("should disable buttons when resolved", () => {
    const card = makeCard({ resolution: { action: "retry-segment", submittedAt: "2026-06-01T11:00:00Z" } });
    const el = renderFailureCard(card, { onAction: () => {} });
    const actions = el.children.find(c => c.className?.includes("failure-actions"));
    for (const btn of actions.children) {
      assert.ok(btn.disabled, "resolved card buttons should be disabled");
    }
  });

  it("should call onAction when button clicked", () => {
    let calledWith = null;
    const card = makeCard();
    const el = renderFailureCard(card, { onAction: (c, a) => { calledWith = { card: c, action: a }; } });
    const actions = el.children.find(c => c.className?.includes("failure-actions"));
    // 模拟点击
    actions.children[0]._listeners.click[0]();
    assert.ok(calledWith);
    assert.equal(calledWith.card.id, "f-001");
    assert.equal(calledWith.action.command, "retry-segment");
  });

  it("should render diagnostics collapsible", () => {
    const el = renderFailureCard(makeCard(), { onAction: () => {} });
    const details = el.children.find(c => c.className?.includes("failure-diagnostics"));
    assert.ok(details);
    assert.equal(details.children[0].textContent, "看技术细节");
  });

  it("should render resolved status when resolution exists", () => {
    const card = makeCard({ resolution: { action: "retry-segment", submittedAt: "2026-06-01T11:00:00Z" } });
    const el = renderFailureCard(card, { onAction: () => {} });
    const resolved = el.children.find(c => c.className?.includes("failure-resolved"));
    assert.ok(resolved);
    assert.ok(resolved.textContent.includes("已选: retry-segment"));
  });

  it("FAILURE_COMMANDS should be a frozen object with expected commands", () => {
    assert.equal(typeof FAILURE_COMMANDS, "object");
    assert.ok(Object.isFrozen(FAILURE_COMMANDS));
    assert.ok("retry-segment" in FAILURE_COMMANDS);
    assert.ok("pause-here" in FAILURE_COMMANDS);
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run:
```powershell
node --test tests/app-shell/failure-card-render.test.mjs
```

Expected: PASS（8 个测试）。

---

### Task 3: C3b — activity-strip 组件渲染测试

**Files:**
- Create: `tests/app-shell/activity-strip-render.test.mjs`
- Read: `src/app-shell/components/activity-strip.js`

- [ ] **Step 1: 编写带极简 DOM mock 的 activity-strip 渲染测试**

创建 `tests/app-shell/activity-strip-render.test.mjs`：

```javascript
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// === 极简 DOM mock，足够 renderActivityStrip 运行 ===
class MockElement {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.textContent = "";
    this.children = [];
    this._hidden = false;
    this._style = {};
    this._listeners = {};
  }
  get hidden() { return this._hidden; }
  set hidden(v) { this._hidden = v; }
  get style() { return this._style; }
  set textContent(v) { this._textContent = v; }
  get textContent() { return this._textContent ?? ""; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  replaceChildren(...nodes) { this.children = nodes.filter(Boolean); }
  classList = {
    _classes: new Set(),
    add: (...cls) => cls.forEach(c => this._classes.add(c)),
    remove: (...cls) => cls.forEach(c => this._classes.delete(c)),
    toggle: (c, force) => { if (force === undefined) { this._classes.has(c) ? this._classes.delete(c) : this._classes.add(c); } else { force ? this._classes.add(c) : this._classes.delete(c); } },
    contains: (c) => this._classes.has(c)
  };
}

const origDocument = globalThis.document;
before(() => {
  globalThis.document = {
    createElement: (tag) => new MockElement(tag),
    querySelector: () => null
  };
});
after(() => { globalThis.document = origDocument; });

// === 测试 ===
import { renderActivityStrip } from "../../src/app-shell/components/activity-strip.js";

function makeActivity(overrides = {}) {
  return {
    mode: "running",
    stage: "drafting",
    chapterNo: 3,
    segCurrent: 2,
    segTotal: 5,
    lastTool: { name: "append_chapter_segment", status: "done" },
    elapsedMs: 125000,
    etaMs: 60000,
    spentCost: 1.23,
    ...overrides
  };
}

describe("renderActivityStrip", () => {
  it("should hide root when activity is null", () => {
    const root = new MockElement("div");
    renderActivityStrip(root, null);
    assert.ok(root.hidden);
  });

  it("should show root when activity is provided", () => {
    const root = new MockElement("div");
    renderActivityStrip(root, makeActivity());
    assert.ok(!root.hidden);
  });

  it("should set idle class when mode is idle", () => {
    const root = new MockElement("div");
    renderActivityStrip(root, makeActivity({ mode: "idle" }));
    assert.ok(root.classList.contains("idle"));
  });

  it("should set blocked class when mode is blocked", () => {
    const root = new MockElement("div");
    renderActivityStrip(root, makeActivity({ mode: "blocked" }));
    assert.ok(root.classList.contains("blocked"));
  });

  it("should render stage slot with label", () => {
    const root = new MockElement("div");
    renderActivityStrip(root, makeActivity());
    const stage = root.children.find(c => c.className?.includes("as-stage"));
    assert.ok(stage, "should have stage slot");
    assert.ok(stage.textContent.includes("起草"), `expected "起草" in stage text, got: ${stage.textContent}`);
  });

  it("should render chapter location", () => {
    const root = new MockElement("div");
    renderActivityStrip(root, makeActivity({ chapterNo: 5, segCurrent: 3, segTotal: 10 }));
    const loc = root.children.find(c => c.className?.includes("as-loc"));
    assert.ok(loc, "should have loc slot");
    assert.ok(loc.textContent.includes("第 5 章"));
    assert.ok(loc.textContent.includes("seg 3/10"));
  });

  it("should render tool status", () => {
    const root = new MockElement("div");
    renderActivityStrip(root, makeActivity({ lastTool: { name: "search_web", status: "done" } }));
    const tool = root.children.find(c => c.className?.includes("as-tool"));
    assert.ok(tool);
    assert.ok(tool.textContent.includes("✓"));
    assert.ok(tool.textContent.includes("search_web"));
  });

  it("should render elapsed time", () => {
    const root = new MockElement("div");
    renderActivityStrip(root, makeActivity({ elapsedMs: 90000 })); // 1:30
    const time = root.children.find(c => c.className?.includes("as-time"));
    assert.ok(time);
    assert.ok(time.textContent.includes("01:30"));
  });

  it("should render cost", () => {
    const root = new MockElement("div");
    renderActivityStrip(root, makeActivity({ spentCost: 2.50 }));
    const cost = root.children.find(c => c.className?.includes("as-cost"));
    assert.ok(cost);
    assert.ok(cost.textContent.includes("￥2.50"));
  });

  it("should privacy-mask chapter and tool when privacy=true", () => {
    const root = new MockElement("div");
    renderActivityStrip(root, makeActivity(), { privacy: true });
    const loc = root.children.find(c => c.className?.includes("as-loc"));
    assert.ok(loc.textContent.includes("█████"));
    const tool = root.children.find(c => c.className?.includes("as-tool"));
    assert.ok(tool.textContent.includes("████"));
  });

  it("should call onClickCost when cost clicked", () => {
    let clicked = false;
    const root = new MockElement("div");
    renderActivityStrip(root, makeActivity(), { onClickCost: () => { clicked = true; } });
    const cost = root.children.find(c => c.className?.includes("as-cost"));
    assert.ok(cost._listeners.click, "cost should have click listener");
    cost._listeners.click[0]();
    assert.ok(clicked);
  });

  it("should call onClickChapter when chapter clicked", () => {
    let clicked = false;
    const root = new MockElement("div");
    renderActivityStrip(root, makeActivity(), { onClickChapter: () => { clicked = true; } });
    const loc = root.children.find(c => c.className?.includes("as-loc"));
    assert.ok(loc._listeners.click, "loc should have click listener");
    loc._listeners.click[0]();
    assert.ok(clicked);
  });

  it("should use replaceChildren to clear (not innerHTML)", () => {
    const root = new MockElement("div");
    root.replaceChildren(new MockElement("span")); // 先放一个子元素
    renderActivityStrip(root, makeActivity());
    // replaceChildren 会替换所有子元素，不会保留旧的
    const stage = root.children.find(c => c.className?.includes("as-stage"));
    assert.ok(stage, "should have fresh children after render");
  });
});
```

- [ ] **Step 2: 跑测试确认通过**

Run:
```powershell
node --test tests/app-shell/activity-strip-render.test.mjs
```

Expected: PASS（12 个测试）。

- [ ] **Step 3: 跑全部测试确认无回归**

Run:
```powershell
npm test
```

Expected: 全部通过。

---

## Phase 2A: 后端可靠性（Task 4→10，串行）

### Task 4: A1a — ProviderTransportError 增加 reason 字段

**Files:**
- Modify: `src/core/provider-adapters.mjs:38-45`（ProviderTransportError 类）

- [ ] **Step 1: 修改 ProviderTransportError 构造函数**

当前代码（第 38-45 行）：
```javascript
export class ProviderTransportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProviderTransportError";
    this.code = "provider_transport_error";
    this.status = details.status ?? null;
    this.body = details.body ?? null;
  }
}
```

改为：
```javascript
export class ProviderTransportError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProviderTransportError";
    this.code = "provider_transport_error";
    this.status = details.status ?? null;
    this.body = details.body ?? null;
    // reason: 'user-abort' | 'timeout' | 'network' | 'server-retryable' | 'server-fatal'
    this.reason = details.reason ?? this.#inferReason(details);
  }

  #inferReason(details) {
    // 只有 429/502/503/504 是可重试的服务器错误
    if (details.status === 429 || details.status === 502 || details.status === 503 || details.status === 504) {
      return "server-retryable";
    }
    // 其他 4xx 是客户端错误，不重试
    if (details.status >= 400 && details.status < 500) return "server-fatal";
    // 5xx 是服务器错误，可重试
    if (details.status >= 500) return "server-retryable";
    // 无 status = 网络错误
    return "network";
  }
}
```

- [ ] **Step 2: 确认无需改动 generate() 的 throw 语句**

`OpenAICompatibleAdapter.generate()` 中现有的 throw 语句：
```javascript
throw new ProviderTransportError(`OpenAI-compatible provider returned HTTP ${response.status}.`, {
  status: response.status,
  body: responseText.slice(0, 2000)
});
```

**无需修改。** `#inferReason` 会根据 `details.status` 自动推断 reason（429/502/503/504 → `server-retryable`，4xx → `server-fatal`，5xx → `server-retryable`，无 status → `network`）。

- [ ] **Step 3: 跑现有 provider-adapters 测试确认无回归**

Run:
```powershell
node --test tests/provider-adapters.test.mjs
```

Expected: 全部通过。

---

### Task 5: A1b — model-client 重试/超时/AbortSignal 组合

**Files:**
- Modify: `src/core/model-client.mjs`
- Create: `tests/model-client-retry.test.mjs`

- [ ] **Step 1: 编写重试测试**

创建 `tests/model-client-retry.test.mjs`：

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelClient } from "../src/core/model-client.mjs";
import { ProviderTransportError } from "../src/core/provider-adapters.mjs";

class MockAdapter {
  constructor({ responses = ["ok"], callLog = [] } = {}) {
    this.responses = responses;
    this.callLog = callLog;
    this.callIndex = 0;
  }
  async generate(request) {
    this.callLog.push({ ...request, callIndex: this.callIndex });
    const response = this.responses[this.callIndex] ?? this.responses.at(-1);
    this.callIndex++;
    if (response instanceof Error) throw response;
    if (typeof response === "object" && response.error) throw response.error;
    return { text: String(response), usage: {}, raw: {} };
  }
}

// 模拟挂起的 adapter（用于测试超时）
class HangingAdapter {
  constructor() { this.callIndex = 0; }
  async generate(request) {
    this.callIndex++;
    // 挂起直到 signal abort
    await new Promise((resolve, reject) => {
      request.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
      // 如果没有 signal，永远挂起
    });
  }
}

describe("ModelClient retry", () => {
  it("should succeed on first try without retry", async () => {
    const adapter = new MockAdapter({ responses: ["ok"] });
    const client = new ModelClient({
      adapters: { mock: adapter },
      activeModel: { provider: "mock", model_name: "test" }
    });
    const result = await client.generate({ prompt: "test" });
    assert.equal(result.text, "ok");
    assert.equal(adapter.callIndex, 1);
  });

  it("should retry on 429 server error up to 3 times", async () => {
    const error429 = new ProviderTransportError("rate limited", { status: 429 });
    const adapter = new MockAdapter({ responses: [error429, error429, "ok"] });
    const client = new ModelClient({
      adapters: { mock: adapter },
      activeModel: { provider: "mock", model_name: "test" },
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 10
    });
    const result = await client.generate({ prompt: "test" });
    assert.equal(result.text, "ok");
    assert.equal(adapter.callIndex, 3);
  });

  it("should NOT retry on 400 client error", async () => {
    const error400 = new ProviderTransportError("bad request", { status: 400 });
    const adapter = new MockAdapter({ responses: [error400, "ok"] });
    const client = new ModelClient({
      adapters: { mock: adapter },
      activeModel: { provider: "mock", model_name: "test" },
      retryBaseDelayMs: 10
    });
    await assert.rejects(
      () => client.generate({ prompt: "test" }),
      (err) => err instanceof ProviderTransportError && err.status === 400
    );
    assert.equal(adapter.callIndex, 1); // 只调用一次，不重试
  });

  it("should NOT retry on 401/403 auth error", async () => {
    const error401 = new ProviderTransportError("unauthorized", { status: 401 });
    const adapter = new MockAdapter({ responses: [error401, "ok"] });
    const client = new ModelClient({
      adapters: { mock: adapter },
      activeModel: { provider: "mock", model_name: "test" },
      retryBaseDelayMs: 10
    });
    await assert.rejects(() => client.generate({ prompt: "test" }));
    assert.equal(adapter.callIndex, 1);
  });

  it("should retry on 502/503/504", async () => {
    for (const status of [502, 503, 504]) {
      const error = new ProviderTransportError(`HTTP ${status}`, { status });
      const adapter = new MockAdapter({ responses: [error, "ok"] });
      const client = new ModelClient({
        adapters: { mock: adapter },
        activeModel: { provider: "mock", model_name: "test" },
        retryBaseDelayMs: 10,
        retryMaxDelayMs: 10
      });
      const result = await client.generate({ prompt: "test" });
      assert.equal(result.text, "ok", `should retry ${status}`);
      assert.equal(adapter.callIndex, 2);
    }
  });

  it("should not retry on user abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new MockAdapter({ responses: ["ok"] });
    const client = new ModelClient({
      adapters: { mock: adapter },
      activeModel: { provider: "mock", model_name: "test" }
    });
    await assert.rejects(
      () => client.generate({ prompt: "test", signal: controller.signal }),
      (err) => err.name === "AbortError"
    );
    assert.equal(adapter.callIndex, 0);
  });

  it("should retry on timeout and wrap as ProviderTransportError", async () => {
    const adapter = new HangingAdapter();
    const retryLog = [];
    const client = new ModelClient({
      adapters: { mock: adapter },
      activeModel: { provider: "mock", model_name: "test" },
      timeoutMs: 50, // 50ms 超时
      retryMax: 1,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 10,
      onRetry: (info) => retryLog.push(info)
    });

    await assert.rejects(
      () => client.generate({ prompt: "test" }),
      (err) => {
        assert.ok(err instanceof ProviderTransportError, "timeout should be wrapped as ProviderTransportError");
        assert.equal(err.reason, "timeout");
        return true;
      }
    );
    assert.equal(retryLog.length, 1);
    assert.equal(retryLog[0].reason, "timeout");
    assert.equal(adapter.callIndex, 2); // 初始 + 1 次重试
  });

  it("should call onRetry callback with correct info", async () => {
    const error429 = new ProviderTransportError("rate limited", { status: 429 });
    const adapter = new MockAdapter({ responses: [error429, "ok"] });
    const retryLog = [];
    const client = new ModelClient({
      adapters: { mock: adapter },
      activeModel: { provider: "mock", model_name: "test" },
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 10,
      onRetry: (info) => retryLog.push(info)
    });
    await client.generate({ prompt: "test" });
    assert.equal(retryLog.length, 1);
    assert.equal(retryLog[0].attempt, 1);
    assert.equal(retryLog[0].reason, "server-retryable");
  });

  it("should throw after exhausting retries", async () => {
    const error429 = new ProviderTransportError("rate limited", { status: 429 });
    const adapter = new MockAdapter({ responses: [error429, error429, error429, error429] });
    const client = new ModelClient({
      adapters: { mock: adapter },
      activeModel: { provider: "mock", model_name: "test" },
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 10
    });
    await assert.rejects(
      () => client.generate({ prompt: "test" }),
      (err) => err instanceof ProviderTransportError
    );
  });
});
```

- [ ] **Step 2: 跑测试确认全部失败**

Run:
```powershell
node --test tests/model-client-retry.test.mjs
```

Expected: 失败（ModelClient 没有 retry 逻辑）。

- [ ] **Step 3: 实现重试逻辑**

重写 `src/core/model-client.mjs`：

```javascript
import { CostTracker } from "./cost-tracker.mjs";
import { resolveRuntimeConfig } from "./config-runtime.mjs";
import { normalizeUsageReport } from "./usage-report.mjs";
import { ProviderTransportError } from "./provider-adapters.mjs";

const DEFAULT_RETRY_MAX = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 16000;
const DEFAULT_TIMEOUT_MS = 120_000;

export class ModelClient {
  constructor({
    adapters = {},
    activeModel = null,
    stageOverrides = {},
    costTracker = new CostTracker(),
    retryMax = DEFAULT_RETRY_MAX,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onRetry = null
  } = {}) {
    this.adapters = adapters;
    this.activeModel = activeModel;
    this.stageOverrides = stageOverrides;
    this.costTracker = costTracker;
    this.retryMax = retryMax;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.retryMaxDelayMs = retryMaxDelayMs;
    this.timeoutMs = timeoutMs;
    this.onRetry = onRetry;
  }

  resolveModelConfig(project = {}, stage = "drafting") {
    const effectiveConfig = resolveRuntimeConfig(project, {
      globalConfig: {
        active_model: this.activeModel ?? { provider: "mock", model_name: "mock-writer" },
        stage_overrides: this.stageOverrides ?? {}
      }
    });
    const activeModel = effectiveConfig.active_model;
    const stageOverrides = effectiveConfig.stage_overrides ?? {};
    const stageOverride = stageOverrides[stage];
    if (stageOverride && stageOverride.enabled === true) {
      return { ...activeModel, ...stageOverride, stage_override_enabled: true };
    }
    return { ...activeModel, stage_override_enabled: false };
  }

  async generate({ project = {}, stage = "drafting", prompt = "", messages = [], metadata = {}, signal = undefined } = {}) {
    const modelConfig = this.resolveModelConfig(project, stage);
    const adapter = this.adapters[modelConfig.provider];
    if (!adapter) {
      throw new Error(`No provider adapter configured for ${modelConfig.provider}`);
    }

    // 外部 signal 已 abort → 直接抛出，不重试
    if (signal?.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }

    let lastError = null;
    for (let attempt = 0; attempt <= this.retryMax; attempt++) {
      // 每次尝试创建新的 timeout controller
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), this.timeoutMs);

      // 标记这是 timeout controller 的 abort，不是用户 abort
      let timedOut = false;
      timeoutController.signal.addEventListener("abort", () => { timedOut = true; }, { once: true });

      // 组合 signal
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      try {
        const response = await adapter.generate({
          model: modelConfig.model_name,
          modelConfig, prompt, messages, stage, metadata,
          signal: combinedSignal
        });
        clearTimeout(timeoutId);

        const usageReport = normalizeUsageReport({
          provider: modelConfig.provider,
          model: modelConfig.model_name,
          usage: response.usage ?? {},
          rawUsage: response.usage ?? {},
          cost: response.cost ?? null
        });
        const costSummary = this.costTracker.record({ stage, usageReport });
        return {
          text: response.text ?? "",
          raw: response.raw ?? response,
          usageReport,
          costSummary,
          modelConfig
        };
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error;

        // 判断 abort 原因
        const isUserAbort = signal?.aborted && !timedOut;
        const isTimeout = timedOut;

        // 用户 abort → 不重试，直接抛
        if (isUserAbort) {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          throw err;
        }

        // 超时 → 包装为 ProviderTransportError 以便统一重试逻辑
        if (isTimeout) {
          lastError = new ProviderTransportError(
            `Model call timed out after ${this.timeoutMs}ms`,
            { reason: "timeout" }
          );
        }

        // 判断是否可重试
        const isRetryable = lastError.code === "provider_transport_error" && (
          lastError.reason === "server-retryable" ||
          lastError.reason === "timeout" ||
          lastError.reason === "network"
        );

        if (!isRetryable || attempt >= this.retryMax) {
          throw lastError;
        }

        // 指数退避
        const delay = Math.min(
          this.retryBaseDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
          this.retryMaxDelayMs
        );

        if (this.onRetry) {
          this.onRetry({
            attempt: attempt + 1,
            maxAttempts: this.retryMax,
            delay,
            error: lastError,
            reason: lastError.reason,
            model: modelConfig.model_name
          });
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```powershell
node --test tests/model-client-retry.test.mjs
```

Expected: 全部通过（5 个测试）。

- [ ] **Step 5: 跑全部测试确认无回归**

Run:
```powershell
npm test
```

Expected: 全部通过。

---

### Task 6: A1c — agent-engine 传入 onRetry 回调

**Files:**
- Modify: `src/core/agent-engine.mjs:482-509`（createModelRuntime）

- [ ] **Step 1: 修改 createModelRuntime 传入 onRetry**

当前 `createModelRuntime` 函数（第 482-509 行）中 `ModelClient` 构造不传 `onRetry`。

在 `new ModelClient({ ... })` 的参数中增加：
```javascript
onRetry: (info) => {
  appendEvent(projectRoot, {
    type: "model_retry",
    severity: "warning",
    message: `模型调用重试 ${info.attempt}/${info.maxAttempts}（${info.reason}），等待 ${Math.round(info.delay)}ms`,
    data: { attempt: info.attempt, reason: info.reason, model: info.model }
  }).catch(() => {});
}
```

注意：`appendEvent` 是 async 的，这里用 `.catch(() => {})` 防止日志写入失败影响主流程。

- [ ] **Step 2: 跑 agent-engine 测试确认无回归**

Run:
```powershell
node --test tests/agent-engine.test.mjs
```

Expected: 全部通过。

---

### Task 7: A2 — 真正 SSE 流式读取

**Files:**
- Modify: `src/core/provider-adapters.mjs`（OpenAICompatibleAdapter.generate 流式分支 + parseOpenAIStream）

- [ ] **Step 1: 编写流式测试**

在 `tests/provider-adapters.test.mjs` 末尾新增测试：

```javascript
describe("SSE streaming", () => {
  it("should call onToken incrementally via ReadableStream, not after response.text()", async () => {
    const tokenLog = [];
    const sseChunk1 = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const sseChunk2 = 'data: {"choices":[{"delta":{"content":" World"}}]}\n\n';
    const sseChunk3 = 'data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n';

    // 关键：text() 方法故意抛错。如果代码走 response.text() 路径（假流式），测试会失败。
    // 真流式走 response.body.getReader()，不调用 text()。
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new Error("假流式路径：不应调用 response.text()"); },
      body: {
        getReader() {
          const chunks = [sseChunk1, sseChunk2, sseChunk3].map(c => new TextEncoder().encode(c));
          let index = 0;
          return {
            read() {
              if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
              return Promise.resolve({ done: false, value: chunks[index++] });
            }
          };
        }
      }
    });

    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://test.example.com/v1/",
      apiKey: "test-key",
      fetchImpl: mockFetch
    });

    const result = await adapter.generate({
      model: "test-model",
      modelConfig: { stream: true, base_url: "https://test.example.com/v1/" },
      metadata: { onToken: (token) => tokenLog.push(token) }
    });

    assert.equal(result.text, "Hello World");
    assert.ok(tokenLog.length >= 2, `expected at least 2 onToken calls, got ${tokenLog.length}`);
    assert.equal(tokenLog[0], "Hello");
    assert.equal(tokenLog[1], " World");
  });

  it("should include stream_options in request body", async () => {
    let capturedBody = null;
    const mockFetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        text: async () => { throw new Error("should not call text()"); },
        body: {
          getReader() {
            const chunk = new TextEncoder().encode('data: [DONE]\n\n');
            let sent = false;
            return {
              read() {
                if (!sent) { sent = true; return Promise.resolve({ done: false, value: chunk }); }
                return Promise.resolve({ done: true, value: undefined });
              }
            };
          }
        }
      };
    };

    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://test.example.com/v1/",
      apiKey: "test-key",
      fetchImpl: mockFetch
    });

    await adapter.generate({
      model: "test-model",
      modelConfig: { stream: true, base_url: "https://test.example.com/v1/" },
      metadata: {}
    });

    assert.deepEqual(capturedBody.stream_options, { include_usage: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```powershell
node --test tests/provider-adapters.test.mjs
```

Expected: 新测试失败（当前是假流式）。

- [ ] **Step 3: 实现真流式**

修改 `provider-adapters.mjs` 的 `OpenAICompatibleAdapter.generate()` 方法中 `stream` 分支。

当前流式分支（约第 97-105 行）：
```javascript
const responseText = await response.text();
// ... error check ...
if (stream) {
  const parsed = parseOpenAIStream(responseText, metadata.onToken);
  return { ... };
}
```

改为：
```javascript
if (!response.ok) {
  const responseText = await response.text();
  throw new ProviderTransportError(`OpenAI-compatible provider returned HTTP ${response.status}.`, {
    status: response.status,
    body: responseText.slice(0, 2000)
  });
}

if (stream) {
  // 真流式：使用 ReadableStream 增量读取
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;
  const events = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // 按 SSE 帧分割
    const parts = buffer.split(/\n\n+/);
    buffer = parts.pop(); // 保留不完整的部分

    for (const part of parts) {
      const dataLines = part
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      for (const data of dataLines) {
        if (!data || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data);
          events.push(event);
          if (event.usage) usage = event.usage;
          const delta = event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.text ?? "";
          if (delta) {
            text += delta;
            metadata.onToken?.(delta, event);
          }
        } catch {
          // 忽略解析错误的帧
        }
      }
    }
  }

  // 处理 buffer 中剩余数据
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") continue;
      try {
        const event = JSON.parse(trimmed.slice(5).trim());
        events.push(event);
        if (event.usage) usage = event.usage;
        const delta = event.choices?.[0]?.delta?.content ?? "";
        if (delta) text += delta;
      } catch {}
    }
  }

  return {
    text,
    raw: { stream: true, events },
    usage: normalizeOpenAIUsage(usage ?? {}),
    cost: null
  };
}
```

同时在请求体中加入 `stream_options`（约第 83 行 `body` 构造处）：

当前：
```javascript
...(stream ? { stream: true } : {}),
```

改为：
```javascript
...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```powershell
node --test tests/provider-adapters.test.mjs
```

Expected: 全部通过（含新流式测试）。

- [ ] **Step 5: 跑全部测试确认无回归**

Run:
```powershell
npm test
```

Expected: 全部通过。

---

### Task 8: A3 — 事件日志尾部读取优化

**Files:**
- Modify: `src/core/event-log.mjs`
- Create: `tests/event-log.test.mjs`

- [ ] **Step 1: 编写 event-log 测试**

创建 `tests/event-log.test.mjs`：

```javascript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { appendEvent, readEvents } from "../src/core/event-log.mjs";

describe("event-log", () => {
  let tmpDir;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "event-log-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should append and read events", async () => {
    await appendEvent(tmpDir, { type: "test", message: "hello" });
    await appendEvent(tmpDir, { type: "test", message: "world" });
    const events = await readEvents(tmpDir);
    assert.equal(events.length, 2);
    assert.equal(events[0].message, "hello");
    assert.equal(events[1].message, "world");
  });

  it("should read all events when no limit", async () => {
    for (let i = 0; i < 50; i++) {
      await appendEvent(tmpDir, { type: "test", message: `event-${i}` });
    }
    const events = await readEvents(tmpDir);
    assert.equal(events.length, 50);
  });

  it("should read only last N events with limit", async () => {
    for (let i = 0; i < 100; i++) {
      await appendEvent(tmpDir, { type: "test", message: `event-${i}` });
    }
    const events = await readEvents(tmpDir, { limit: 5 });
    assert.equal(events.length, 5);
    assert.equal(events[0].message, "event-95");
    assert.equal(events[4].message, "event-99");
  });

  it("should return empty array for non-existent log", async () => {
    const events = await readEvents("/nonexistent/path");
    assert.deepEqual(events, []);
  });

  it("should handle limit larger than total events", async () => {
    await appendEvent(tmpDir, { type: "test", message: "one" });
    const events = await readEvents(tmpDir, { limit: 100 });
    assert.equal(events.length, 1);
  });
});
```

- [ ] **Step 2: 跑测试确认 limit 分支失败**

Run:
```powershell
node --test tests/event-log.test.mjs
```

Expected: limit 相关测试可能通过（因为当前实现是先全量读取再 slice），但这是我们要优化的。

- [ ] **Step 3: 实现尾部读取优化**

修改 `src/core/event-log.mjs` 的 `readEvents` 函数：

当前：
```javascript
export async function readEvents(projectRoot, options = {}) {
  const logPath = safeJoin(projectRoot, "run_log.jsonl");
  if (!(await pathExists(logPath))) {
    return [];
  }
  const events = (await fs.readFile(logPath, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return options.limit ? events.slice(-options.limit) : events;
}
```

改为：
```javascript
export async function readEvents(projectRoot, options = {}) {
  const logPath = safeJoin(projectRoot, "run_log.jsonl");
  if (!(await pathExists(logPath))) {
    return [];
  }

  // 无 limit 时保持全量读取（兼容所有现有调用者）
  if (!options.limit) {
    const events = (await fs.readFile(logPath, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return events;
  }

  // 有 limit 时走尾部读取优化
  const stat = await fs.stat(logPath);
  const fileSize = stat.size;
  if (fileSize === 0) return [];

  const CHUNK_SIZE = Math.min(fileSize, 64 * 1024); // 64KB 一块
  const handle = await fs.open(logPath, "r");
  try {
    const lines = [];
    let position = fileSize;
    let remainder = "";

    while (lines.length < options.limit && position > 0) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, position);
      const chunk = buffer.toString("utf8");
      const combined = chunk + remainder;
      const parts = combined.split(/\r?\n/u);
      remainder = parts.shift(); // 第一个可能是不完整的行
      // 从后往前收集完整行
      for (let i = parts.length - 1; i >= 0 && lines.length < options.limit; i--) {
        if (parts[i].trim()) {
          lines.unshift(parts[i]);
        }
      }
    }

    // 处理 remainder（文件最开头的行）
    if (lines.length < options.limit && remainder.trim()) {
      lines.unshift(remainder);
    }

    return lines.map((line) => JSON.parse(line));
  } finally {
    await handle.close();
  }
}

export async function tailEvents(projectRoot, n) {
  return readEvents(projectRoot, { limit: n });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```powershell
node --test tests/event-log.test.mjs
```

Expected: 全部通过。

- [ ] **Step 5: 跑全部测试确认无回归**

Run:
```powershell
npm test
```

Expected: 全部通过。

---

### Task 9: A4 — 适配器注入（保持默认兼容）

**Files:**
- Modify: `src/core/agent-engine.mjs:482-509`（createModelRuntime）

- [ ] **Step 1: 修改 createModelRuntime 接受可选 adapters**

当前函数签名：
```javascript
async function createModelRuntime(projectRoot, project, options, fallbackModel) {
```

修改函数体中 `ModelClient` 构造部分。当前硬编码：
```javascript
adapters: {
  "openai-compatible": new OpenAICompatibleAdapter(),
  mock: new MockProviderAdapter({ ... })
}
```

改为：
```javascript
const defaultAdapters = {
  "openai-compatible": new OpenAICompatibleAdapter(),
  mock: new MockProviderAdapter({
    response: async (gatewayRequest) => {
      const toolRequest = gatewayRequest.metadata?.toolRequest ?? {};
      const output = await fallbackModel.generate(toolRequest);
      return {
        text: JSON.stringify(output),
        raw: { output },
        usage: estimateMockUsage(gatewayRequest.prompt, output)
      };
    }
  })
};

const adapters = options.adapters
  ? { ...defaultAdapters, ...options.adapters }
  : defaultAdapters;

const modelClient =
  options.modelClient ??
  new ModelClient({
    costTracker,
    adapters,
    onRetry: options.onRetry ?? null
  });
```

- [ ] **Step 2: 跑 agent-engine 测试确认无回归**

Run:
```powershell
node --test tests/agent-engine.test.mjs
```

Expected: 全部通过（默认 fallback 仍在）。

- [ ] **Step 3: 跑 verify:mvp 确认直接调用路径不受影响**

Run:
```powershell
npm run verify:mvp
```

Expected: 通过。

---

### Task 10: A5 — 静默 catch 改为结构化日志

**Files:**
- Modify: `src/core/app-server.mjs`
- Modify: `src/core/app-state.mjs`
- Modify: `src/core/skill-runtime.mjs`
- Modify: `src/core/side-question.mjs`
- Modify: `src/core/app-dashboard.mjs`

- [ ] **Step 1: 搜索所有空 catch 块**

Run:
```powershell
Select-String -Path "src\core\app-server.mjs","src\core\app-state.mjs","src\core\skill-runtime.mjs","src\core\side-question.mjs","src\core\app-dashboard.mjs" -Pattern "catch\s*\{\s*\}" -Context 1,1
```

记录所有空 catch 块的位置。

- [ ] **Step 2: 逐个修复**

对每个空 catch 块，根据上下文决定：
- **关键路径**（项目加载、设置保存、状态读取）→ 改为 `catch (error) { console.warn("[module] 描述:", error.message); }`
- **非关键路径**（缓存读取、可选配置）→ 保留空 catch 但加注释 `// 缓存未命中，忽略`

示例修复 `app-server.mjs` 第 220 行：
```javascript
// 当前
} catch {}
// 改为
} catch (error) { console.warn("[app-server] 加载项目配置失败:", error.message); }
```

示例修复 `app-state.mjs` 第 33 行和第 42 行：
```javascript
// 当前
} catch {}
// 改为（如果是状态读取）
} catch (error) { console.warn("[app-state] 读取状态失败:", error.message); }
```

- [ ] **Step 3: 跑全部测试确认无回归**

Run:
```powershell
npm test
```

Expected: 全部通过。

---

### Task 11: A6 — HTTP 状态码 + 响应体统一（仅后端）

**Files:**
- Create: `src/core/http-error.mjs`
- Modify: `src/core/app-server.mjs`

- [ ] **Step 1: 创建 HttpError 工具类**

创建 `src/core/http-error.mjs`：

```javascript
export class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.httpStatus = status;
    this.code = code;
    this.details = details;
  }
}

export function sendError(res, error) {
  if (error instanceof HttpError) {
    res.writeHead(error.httpStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {})
    }));
  } else {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      code: "INTERNAL_ERROR",
      message: error.message ?? "服务器内部错误"
    }));
  }
}
```

- [ ] **Step 2: 逐步替换 app-server.mjs 的 catch 块**

对每个 `catch (error) { await serveJson(response, { ok: false, message: error.message }, XXX); }` 模式：

根据错误类型选择正确的状态码和 code：
- 400 + `BAD_REQUEST` — 客户端输入错误（JSON 解析失败、参数缺失）
- 409 + `CONFLICT` — 状态冲突（未运行时点停止、已完成时重试）
- 500 + `INTERNAL_ERROR` — 服务器内部错误

同时统一响应体格式为 `{ ok: false, code, message }`。

注意：**不改前端**，前端的 `readResponseJson` 适配由 B 组负责。

- [ ] **Step 3: 跑 app-server-probe 测试**

Run:
```powershell
node --test tests/app-server-probe.test.mjs
```

Expected: 全部通过（测试可能需要更新期望的响应体格式）。

- [ ] **Step 4: 跑全部测试**

Run:
```powershell
npm test
```

Expected: 全部通过。

---

## Phase 2B: 前端拆分（Task 12→19，串行）

> 每步提取后必须跑 `npm run verify:app-shell` 和 `npm run verify:app-clickability`。失败则回滚该步。

### Task 12: B1 — 提取 utils.js + api-client.js

**Files:**
- Create: `src/app-shell/utils.js`
- Create: `src/app-shell/api-client.js`
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: 创建 utils.js**

创建 `src/app-shell/utils.js`，从 `app.js` 提取以下函数（精确复制，不改逻辑）：

```javascript
// 从 app.js 提取的纯工具函数

export function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== undefined));
}

export function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value ?? 0));
}

export function formatCompact(value) {
  const number = Number(value ?? 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 10_000) return `${(number / 10_000).toFixed(1)}万`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return formatNumber(number);
}

export function formatMoney(value) {
  return `$${Number(value ?? 0).toFixed(6)}`;
}

export function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

export function statusClass(value) {
  return String(value ?? "idle").replace(/[^a-z0-9_-]/giu, "-");
}

export function pathEquals(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

export function pathBaseName(value) {
  return String(value ?? "").replace(/[\\/]+$/u, "").split(/[\\/]/u).pop();
}

export function resolveModelEndpoint(baseUrl) {
  try {
    return new URL("chat/completions", ensureTrailingSlash(baseUrl)).toString();
  } catch {
    return `${baseUrl.replace(/\/+$/u, "")}/chat/completions`;
  }
}

export function ensureTrailingSlash(value) {
  return String(value).endsWith("/") ? String(value) : `${value}/`;
}

export function isEnvironmentVariableName(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

export function cssEscape(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/gu, (ch) => `\\${ch}`);
}

export function translateStage(stage) {
  return {
    "-": "-", queued: "排队", planned: "已规划", planning: "规划",
    drafting: "起草", reviewing: "审稿", revising: "修订",
    needs_revision: "需修订", finalizing: "定稿", summarizing: "摘要",
    completed: "已定稿", blocked: "阻塞", post_process: "后处理",
    user_input: "用户输入", run: "运行"
  }[stage] ?? stage;
}

export function translateReviewStatus(status) {
  return { passed: "通过", failed: "失败" }[status] ?? status ?? "未运行";
}

export function translateSkillType(type) {
  return { style: "风格", "flow-control": "流程", "quality-gate": "质检", "post-process": "后处理" }[type] ?? type;
}

export function translateSourceKind(kind) {
  return { search: "搜索", fetch: "抓取", page: "网页", source: "资料" }[kind] ?? "资料";
}

export function translateEventType(type) {
  return {
    project_created: "项目创建", project_run_started: "运行开始",
    project_run_finished: "运行结束", project_run_failed: "运行失败",
    project_run_skipped: "运行跳过", project_started: "开始运行",
    project_completed: "项目完成", project_blocked: "项目阻塞",
    checkpoint_written: "检查点", model_call_started: "模型调用开始",
    model_call_completed: "模型调用完成", model_usage_recorded: "用量记录",
    cache_report_updated: "缓存更新", chapter_queued: "章节排队",
    stage_started: "阶段开始", chapter_finalized: "章节定稿",
    chapter_completed: "章节完成", quality_gate_failed: "质检失败",
    tool_call_rejected: "工具调用拒绝", skill_configuration_changed: "技能配置",
    project_settings_updated: "设置更新", web_search_completed: "搜索完成",
    web_fetch_completed: "抓取完成", user_instruction_received: "用户指令"
  }[type] ?? type;
}
```

- [ ] **Step 2: 创建 api-client.js**

创建 `src/app-shell/api-client.js`：

```javascript
export async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await readResponseJson(response);
  if (!response.ok || data.ok === false) {
    throw new Error(data.message ?? "请求失败");
  }
  return data;
}

export async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await readResponseJson(response);
  if (!response.ok || data.ok === false) {
    const error = new Error(data.message ?? "请求失败");
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function readResponseJson(response) {
  const text = await response.text();
  if (!text) return { ok: response.ok };
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, message: text.slice(0, 240) || `HTTP ${response.status}` };
  }
}
```

- [ ] **Step 3: 修改 app.js 导入并删除提取的函数**

在 `app.js` 顶部添加：
```javascript
import { compactObject, formatNumber, formatCompact, formatMoney, formatTime, statusClass, pathEquals, pathBaseName, resolveModelEndpoint, ensureTrailingSlash, isEnvironmentVariableName, cssEscape, translateStage, translateReviewStatus, translateSkillType, translateSourceKind, translateEventType } from "./utils.js";
import { getJson, postJson, readResponseJson } from "./api-client.js";
```

删除 app.js 中对应的函数定义（约第 1571-1604 行的 getJson/postJson/readResponseJson，约第 2507-2620 行的工具函数）。

同时修改 `submitFailureAction`（第 973-993 行）使用 `postJson`：

```javascript
async function submitFailureAction(card, action) {
  try {
    await postJson("/api/failures/resolve", {
      command: action.command,
      args: action.args,
      failureId: card.id
    });
    loadDashboard();
  } catch (err) {
    console.error("提交失败:", err.message);
  }
}
```

- [ ] **Step 4: 验证**

Run:
```powershell
npm run verify:app-shell
```

```powershell
npm run verify:app-clickability
```

Expected: 两个都通过。

---

### Task 13: B2 — 提取 icons.js

**Files:**
- Create: `src/app-shell/icons.js`
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: 创建 icons.js**

```javascript
export const ICON_PATHS = {
  compose: "M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6 M18.4 3.6a1.7 1.7 0 0 1 2.4 2.4L12.5 16.3l-3.4.9.9-3.4z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20.5 20.5 16 16",
  skill: "M12 3l7.5 4.3v8.6L12 20.2 4.5 15.9V7.3z M12 8.2v3.6 M12 11.8 9 13.5 M12 11.8 15 13.5",
  plugin: "M5 5h5v5H5z M14 5h5v5h-5z M5 14h5v5H5z M14 14h5v5h-5z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7.5v5l3.2 1.8",
  check: "M5 12.5l4.2 4.2L19 7",
  help: "M9 9a3 3 0 1 1 4 2.8c-.9.5-1.5 1-1.5 2.2M12 17.5h.01 M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  book: "M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM5 17.5h13",
  settings: "M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h7M15 17.5h5",
  doc: "M7 3h7l4 4v14H7zM14 3v4h4",
  chevR: "M9 6l6 6-6 6",
  bolt: "M13 3 4 14h6l-1 7 9-11h-6z",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
  eyeOff: "M3.5 4l17 16 M2.5 12s3.5-6.5 9.5-6.5c1.9 0 3.6.6 5 1.5 M9 6.2C10 5.8 11 5.5 12 5.5c6 0 9.5 6.5 9.5 6.5s-1.4 2.6-3.9 4.6 M14.5 14.6A2.8 2.8 0 0 1 9.5 9.5",
  copy: "M9 9h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z M6 15H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"
};

export function icon(name, size = 16, cls) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (cls) svg.setAttribute("class", cls);
  for (const seg of (ICON_PATHS[name] ?? "").split(" M")) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", seg.startsWith("M") ? seg : `M${seg}`.replace(/^MM/, "M"));
    svg.append(path);
  }
  return svg;
}
```

- [ ] **Step 2: 修改 app.js**

添加导入：
```javascript
import { icon, ICON_PATHS } from "./icons.js";
```

删除 app.js 中第 113-131 行的 `ICON_PATHS` 和第 464-482 行的 `icon()` 函数。

- [ ] **Step 3: 验证**

Run:
```powershell
npm run verify:app-shell && npm run verify:app-clickability
```

---

### Task 14: B3 — 提取 thread-renderer.js

**Files:**
- Create: `src/app-shell/thread-renderer.js`
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: 创建 thread-renderer.js**

从 `app.js` 第 403-1100 行提取对话流渲染相关的所有函数。

文件结构：
```javascript
// thread-renderer.js — 对话流渲染引擎
import { icon } from "./icons.js";
import { formatTime, formatNumber, formatCompact, formatMoney, cssEscape, translateStage, translateEventType, statusClass } from "./utils.js";
import { motion } from "./motion-runtime.js";
import { renderFailureCard } from "./components/failure-card.js";

// 通过 context 注入依赖，避免模块级可变状态
export function createThreadRenderer(ctx) {
  // ctx = { refs, renderedKeys, askEntries, getLiveBlock, setLiveBlock, lastDashboard, submitFailureAction, loadDashboard }
  // ... 提取的函数作为内部函数 ...
  // 返回公开 API：syncThread, renderEmptyThread, syncFailureCards, updateLiveAgentBlock
}
```

提取的函数列表（按 app.js 行号）：
- `renderEmptyThread()` (403-410)
- `syncThread(data, firstLoad)` (412-461) — 核心同步逻辑
- `eventKey(event)` (456-461)
- `timeValue(event)` (448-454)
- `buildSessionHead(data)` (489-540)
- `buildSessionHeadInner(data)` (542-580)
- `statCell(label, value)` (582-590)
- `refreshSessionHead(data)` (592-601)
- `buildGreeting()` (604-630)
- `buildUserBubble(event)` (634-660)
- `renderQueueCards(data)` (662-700)
- `buildTaskCard(task)` (702-765)
- `buildInlineProgress(task)` (767-790)
- `taskSummary(task)` (792-810)
- `cancelQueuedTask(taskId)` (812-830)
- `translateTaskStatus(status)` (832-845)
- `buildQuickRow(event)` (847-870)
- `buildAgentBlock(event)` (872-920)
- `appendRunDetail(block, event)` (922-950)
- `renderSteps(block, steps)` (952-970)
- `computeSteps(events)` (972-990)
- `attachChapterCard(block, event)` (992-1020)
- `finishAgentBlock(block)` (1022-1040)
- `insertByTs(container, node, ts)` (1042-1055)
- `syncFailureCards(data)` (1057-1080)
- `updateLiveAgentBlock(data)` (1082-1100)
- `buildSideBubble(event)` (1035-1060)
- `buildAskConfirm(entry)` (1062-1100)

- [ ] **Step 2: 修改 app.js**

添加导入：
```javascript
import { createThreadRenderer } from "./thread-renderer.js";
```

在初始化区域创建渲染器实例：
```javascript
const threadRenderer = createThreadRenderer({
  refs,
  renderedKeys,
  askEntries,
  getLiveBlock: () => liveBlock,
  setLiveBlock: (v) => { liveBlock = v; },
  getDashboard: () => lastDashboard,
  submitFailureAction,
  loadDashboard
});
```

将 `renderDashboard` 中对 `syncThread`、`syncFailureCards`、`updateLiveAgentBlock` 的调用改为通过 `threadRenderer` 调用。

删除 app.js 中对应的函数定义。

- [ ] **Step 3: 验证**

Run:
```powershell
npm run verify:app-shell && npm run verify:app-clickability
```

---

### Task 15: B4 — 提取 drawer-panels.js

**Files:**
- Create: `src/app-shell/drawer-panels.js`
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: 创建 drawer-panels.js**

从 `app.js` 第 1607-2020 行提取所有面板渲染函数。

```javascript
// drawer-panels.js — 右侧面板渲染
import { icon } from "./icons.js";
import { formatNumber, formatCompact, formatMoney, formatTime, translateStage, translateReviewStatus, translateSkillType, translateSourceKind, translateEventType, statusClass, pathBaseName } from "./utils.js";
import { getJson, postJson } from "./api-client.js";

export function renderDrawerBody(tab, ctx) {
  // ctx = { refs, lastDashboard, currentProjectRoot, loadDashboard }
  switch (tab) {
    case "chapters": return renderChapterPanel(ctx);
    case "model": return renderModelPanel(ctx);
    case "run": return renderRunPanel(ctx);
    case "skills": return renderSkillsPanel(ctx);
    case "research": return renderResearchPanel(ctx);
    case "cost": return renderCostPanel(ctx);
    case "reviewer": return renderReviewerPanel(ctx);
    default: return null;
  }
}
// ... 所有面板渲染函数 ...
```

- [ ] **Step 2: 修改 app.js + 验证 + Commit**

同 B3 模式。

---

### Task 16: B5 — 提取 settings-modal.js

**Files:**
- Create: `src/app-shell/settings-modal.js`
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: 创建 settings-modal.js**

从 `app.js` 第 2023-2329 行提取设置弹窗相关函数。

```javascript
// settings-modal.js — 设置弹窗
import { icon } from "./icons.js";
import { getJson, postJson } from "./api-client.js";
import { ensureTrailingSlash, isEnvironmentVariableName } from "./utils.js";

export function openSettingsModal(ctx) { ... }
export function closeSettingsModal(ctx) { ... }
export function renderSettingsProviders(ctx) { ... }
export function renderSettingsDetail(ctx) { ... }
// ...
```

- [ ] **Step 2: 修改 app.js + 验证 + Commit**

---

### Task 17: B6 — 提取 composer.js

**Files:**
- Create: `src/app-shell/composer.js`
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: 创建 composer.js**

从 `app.js` 第 1124-1369 行提取命令解析和提交逻辑。

```javascript
// composer.js — 命令解析 + 提交
import { postJson } from "./api-client.js";

export function parseUserCommand(text) { ... }
export function matchCommandPrefix(text) { ... }
export function detectMainTaskImpact(text) { ... }
export function submitComposer(ctx) { ... }
// ...
```

- [ ] **Step 2: 修改 app.js + 验证 + Commit**

---

### Task 18: B7 — CSS 整理 + 组件一致性

**Files:**
- Modify: `src/app-shell/styles.css`
- Modify: `src/app-shell/components/activity-strip.js`

- [ ] **Step 1: 合并重复的 CSS 规则**

搜索 `styles.css` 中的 `.pill.completed` 和 `.pill.blocked`，合并底部追加的版本回原始定义位置。

搜索重复的暗色渐变（`#34332f`/`#2b2a27`/`#2c2b28`），统一为 CSS 变量 `--btn-gradient`。

- [ ] **Step 2: 建立字号体系**

在 `:root` 中添加：
```css
--text-xs: 11px;
--text-sm: 12px;
--text-base: 13px;
--text-md: 14px;
--text-lg: 15px;
--text-xl: 16px;
--text-2xl: 19px;
```

逐步替换硬编码的 font-size 值。

- [ ] **Step 3: 变量化硬编码颜色**

将 scrollbar、focus-ring 等硬编码颜色替换为 CSS 变量。

- [ ] **Step 4: activity-strip replaceChildren**

修改 `src/app-shell/components/activity-strip.js` 第 16 行：
```javascript
// 当前
root.innerHTML = '';
// 改为
root.replaceChildren();
```

- [ ] **Step 5: 验证**

Run:
```powershell
npm run verify:app-shell && npm run verify:app-clickability
```

---

### Task 19: B8 — app.js 最终瘦身

**Files:**
- Modify: `src/app-shell/app.js`

> **注意：** loadDashboard 的两个请求（/api/dashboard + /api/queue/state）是串行的，且必须串行——queue 请求依赖 dashboard 返回的 hasProject 判断。真正的优化是后端把 queue 嵌入 dashboard 响应，但这超出本 spec 范围。此处保持现状，不假装并行。

- [ ] **Step 1: 确认 app.js 只剩入口职责**

检查 app.js 是否只剩：
- refs 缓存
- 可变状态声明
- 事件绑定 bootstrap
- loadAll / loadProjectList / loadDashboard 编排
- renderDashboard 协调
- overlay/privacy/refresh 基础设施
- bootstrap init

- [ ] **Step 3: 验证**

Run:
```powershell
npm run verify:app-shell && npm run verify:app-clickability
```

---

## Phase 3: C2 + C4（依赖 A/B 完成）

### Task 20: C2 — 核心模块补充单测

**Files:**
- Create: `tests/cost-tracker.test.mjs`
- Create: `tests/chapter-memory.test.mjs`
- Create: `tests/retry-candidates.test.mjs`
- Create: `tests/simple-yaml.test.mjs`

- [ ] **Step 1: 读取源模块，了解 API**

读取 `src/core/cost-tracker.mjs`、`src/core/chapter-memory.mjs`、`src/core/retry-candidates.mjs`、`src/core/simple-yaml.mjs`，了解每个模块的导出函数和行为。

- [ ] **Step 2: 编写 cost-tracker 测试**

测试成本累加、预算检查、报告生成。

- [ ] **Step 3: 编写 chapter-memory 测试**

测试文件格式、摘录提取、跨章连续性、损坏/缺失文件路径。

- [ ] **Step 4: 编写 retry-candidates 测试**

测试候选选择算法（stale running / interrupted / ambiguous 分支）。

- [ ] **Step 5: 编写 simple-yaml 测试**

测试 YAML 解析器的基本语法、边界情况。

- [ ] **Step 6: 跑全部测试**

Run:
```powershell
npm test
```

---

### Task 21: C4 — Schema 迁移测试

**Files:**
- Create: `tests/schema-migration.test.mjs`

- [ ] **Step 1: 读取 task-queue.mjs 了解 v1→v2 迁移逻辑**

找到 schema_version 字段和迁移代码。

- [ ] **Step 2: 编写迁移测试**

创建 v1 格式 fixture → 验证加载后自动迁移到 v2 → 验证数据完整性。

- [ ] **Step 3: 跑测试**

```powershell
node --test tests/schema-migration.test.mjs
```

---

## Phase 4: 收口验证

### Task 22: 完整验证管线

- [ ] **Step 1: 跑全部单元测试**

```powershell
npm test
```

Expected: 全部通过。

- [ ] **Step 2: 跑前端集成测试**

```powershell
npm run verify:app-shell
```

Expected: 通过。

- [ ] **Step 3: 跑 Electron 点击测试**

```powershell
npm run verify:app-clickability
```

Expected: 通过。

- [ ] **Step 4: 跑完整验证管线**

```powershell
npm run verify:local
```

Expected: 全部通过（5-10 分钟）。

