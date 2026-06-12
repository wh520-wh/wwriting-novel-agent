# S4.5「聊得爽」对话体验与界面打磨 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec `docs/superpowers/specs/2026-06-12-s45-conversation-polish-design.md`——过程流与可中断、文稿块、段落 diff、工具卡人话化、溯源 chips、消息操作、阅读器升级、空态/快捷键/Toast/字数打磨。

**Architecture:** 后端零迁移、纯增量（chatJobs 注册表 + busy 字段 + /api/chat/stop + signal 贯穿 + tool 消息带 args）；前端复用 1.8s 轮询通道做过程流（事实依据：tool 消息已实时落盘 `chat_history.jsonl`，`/api/chat/history` 不取项目锁）。所有可单测逻辑放独立 `.mjs` 纯函数模块，DOM 层靠 clickability 探针验证。

**Tech Stack:** 原生 JS（ESM）+ node:test + Electron 探针。**零新第三方依赖。**

**执行环境约定：**

- 仓库根：`D:\WWriting`，包管理 npm，`package.json type: module`（`.js` 在 node 测试里也按 ESM 导入）。
- 按 `superpowers:using-git-worktrees` 建隔离工作区，分支名 `s45-conversation-polish`，基于 `master`。
- 每个任务内：先跑该任务的测试文件，任务收尾跑 `npm test` 全量。Electron 防线（`verify:app-clickability` / `verify:desktop-shell`）只在 Task 17/18 跑（重量级）。
- **禁止事项（全局）**：不重构本计划未列出的代码；不改动既有探针断言；不动 `_backup-pre-codex-*` 目录；不引第三方库；不改 `agent-say` 旧事件流渲染路径；CSS 一律追加到 `styles.css` 末尾的带注释分区，不就地改既有规则（本计划明确列出的除外）；**不得给 `/api/dashboard`、`/api/chat/history`、`/api/queue/state` 等 GET 端点加 `withProjectLock`**——busy 期间的轮询过程流依赖它们无锁（已 grep 取证：当前 withProjectLock 仅覆盖 command submit / chat send / chat confirm / queue cancel / run stop / run retry 六个写端点）。

**顺手改进清单（已纳入任务，执行者不得自行增删）：**

| 编号 | 内容 | 所在任务 |
|------|------|----------|
| I1 | `thread-renderer.js` 本地 `escape()` 删除，统一 import `markdown-lite.mjs` 的 `escapeHtml`（DRY） | Task 9 |
| I2 | 问候语与快捷 chips 还停在 S3 前的 `/write` `/ask` 话术，改为 chat-first 文案 | Task 15 |
| I3 | composer 乐观用户气泡手工拼 DOM 与 thread-renderer 重复，改为复用 `renderChatMessage` | Task 11 |
| I4 | `syncChatThread` 没有"贴底跟随"和无障碍播报，补 stick-to-bottom + `announce` | Task 9 |
| I5 | 隐私模式完整性：文稿块、段落 diff 正文必须带 `peek` class（否则隐私模糊漏掉对话里的正文） | Task 1/8 |
| I6 | assistant 气泡可读性：13.5px/1.55 → 14px/1.7、max-width 86%（密集阅读面） | Task 9 |
| I7 | 所有新增按钮必须带 `aria-label` 或可见文本 + `data-testid` | 全部 |
| I8 | composer 提示文案追加 `? 快捷键` | Task 16 |
| I9 | 空态建议卡与问候 chips 在 chat busy 时点击直接忽略（防 409 噪音） | Task 15 |
| I10 | USER_GUIDE 追加 §15「S4.5 对话体验速览」，文档与交互同步 | Task 18 |

**Spec 验收条 → 任务映射（自审用）：**

| 验收 | 任务 |
|------|------|
| 1 过程流 | T5+T11+T17b |
| 2 停止 | T4+T5+T11+T17b |
| 3 markdown | T1+T9 |
| 4 稿块+混排不丢调用 | T1+T2+T9 |
| 5 段落 diff | T8+T10 |
| 6 工具卡人话 | T3+T6+T9 |
| 7 溯源 chips | T6+T7+T9 |
| 8 消息操作 | T12 |
| 9 阅读器引用 | T13 |
| 10 字数 pill | T15 |
| 11 空态情境化 | T7+T15 |
| 12 快捷键速查 | T16 |
| 13 Toast 降噪 | T15 |
| 14 阅读器字号/翻章/沉浸 | T14 |
| 15 防线 | T17+T18 |

---

## 文件结构总览

```
新建：
  src/app-shell/markdown-lite.mjs      纯函数 markdown + 稿块渲染（T1）
  src/app-shell/tool-labels.mjs        17 工具人话映射 + args 摘要解析（T6）
  src/app-shell/chat-derive.mjs        deriveSources + deriveSuggestions（T7）
  tests/markdown-lite.test.mjs
  tests/chat-tool-args.test.mjs
  tests/chat-agent-cancel.test.mjs
  tests/tool-labels.test.mjs
  tests/chat-derive.test.mjs
  tests/app-shell/chat-busy-stop.test.mjs
修改：
  src/core/chat/agent-protocol.mjs     稿块约定 + 多围栏扫描（T2）
  src/core/chat/tool-registry.mjs      导出 summarizeArgs（T3）
  src/core/chat/chat-agent.mjs         tool 消息带 args（T3）+ signal 中断（T4）
  src/core/app-server.mjs              chatJobs + busy + /api/chat/stop（T5）
  src/app-shell/api-client.js          stopChat()（T5）
  src/app-shell/diff-view.js           diffParagraphs/summarizeDiff/renderParagraphDiff（T8）
  src/app-shell/thread-renderer.js     渲染大集成（T9/T10/T12/T15）
  src/app-shell/composer.js            活动占位/busy/字数 pill/降噪（T11/T15）
  src/app-shell/app.js                 轮询条件/阅读器/快捷键/降噪（T11/T13/T14/T15/T16）
  src/app-shell/index.html             阅读器工具排 + 快捷键浮层 + ⌨ 按钮（T14/T16）
  src/app-shell/styles.css             各任务追加分区（T9–T16）
  tests/chat-protocol.test.mjs         多围栏用例（T2）
  tests/diff-view.test.mjs             段落 diff 用例（T8）
  scripts/verify-app-clickability.cjs  新探针（T17）
  scripts/verify-chat-online.mjs       场景 F：增量落盘 + 中途停止（T17b）
  docs/USER_GUIDE.zh-CN.md             §15 S4.5 速览（T18）
```

---

### Task 0: 工作区准备

- [ ] **Step 0.1**：用 `superpowers:using-git-worktrees` 创建 worktree，分支 `s45-conversation-polish`，基于 `master`。
- [ ] **Step 0.2**：worktree 内执行 `npm install`（Electron 依赖在 worktree 缺失会让 desktop 防线不可跑——S4 已知问题，Electron 类验证允许回主 checkout 跑）。
- [ ] **Step 0.3**：`npm test` 确认基线全绿（预期 550+ pass, 0 fail）。

---

### Task 1: `markdown-lite.mjs` —— markdown + 稿块渲染（A3+B1 渲染层）

**Files:**
- Create: `src/app-shell/markdown-lite.mjs`
- Test: `tests/markdown-lite.test.mjs`

- [ ] **Step 1.1: 写失败测试**（完整文件）：

````js
// tests/markdown-lite.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown, escapeHtml, countProseWords } from "../src/app-shell/markdown-lite.mjs";

test("escapeHtml 转义五种字符", () => {
  assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});

test("countProseWords 去空白计数", () => {
  assert.equal(countProseWords("他走了。\n\n  她哭了。"), 8);
});

test("段落 + 粗体 + 行内代码（回归既有行为）", () => {
  assert.equal(
    renderMarkdown("第一段 **重点** 和 `代码`。\n\n第二段。"),
    "<p>第一段 <strong>重点</strong> 和 <code>代码</code>。</p><p>第二段。</p>"
  );
});

test("段内单换行渲染为 <br>", () => {
  assert.equal(renderMarkdown("行一\n行二"), "<p>行一<br>行二</p>");
});

test("## 与 ### 标题降级为 h4/h5", () => {
  assert.equal(renderMarkdown("## 大纲\n\n### 第一幕"), "<h4>大纲</h4><h5>第一幕</h5>");
});

test("无序列表", () => {
  assert.equal(renderMarkdown("- 甲\n- 乙"), "<ul><li>甲</li><li>乙</li></ul>");
});

test("有序列表（1. 与 1、 两种写法）", () => {
  assert.equal(renderMarkdown("1. 甲\n2. 乙"), "<ol><li>甲</li><li>乙</li></ol>");
  assert.equal(renderMarkdown("1、甲\n2、乙"), "<ol><li>甲</li><li>乙</li></ol>");
});

test("引用块", () => {
  assert.equal(renderMarkdown("> 引文一\n> 引文二"), "<blockquote>引文一<br>引文二</blockquote>");
});

test("分隔线", () => {
  assert.equal(renderMarkdown("上\n\n---\n\n下"), "<p>上</p><hr><p>下</p>");
});

test("普通围栏渲染为 pre/code 且内容已转义", () => {
  assert.equal(
    renderMarkdown("```\n<b>原样</b>\n```"),
    `<pre class="md-fence"><code>&lt;b&gt;原样&lt;/b&gt;</code></pre>`
  );
});

test("稿块：衬线容器 + peek + 字数标（稿 与 prose 别名等价）", () => {
  const expected = `<div class="manuscript-block peek"><p>夜雨敲窗。</p><p>他点了灯。</p><span class="manuscript-words">10 字</span></div>`;
  assert.equal(renderMarkdown("```稿\n夜雨敲窗。\n\n他点了灯。\n```"), expected);
  assert.equal(renderMarkdown("```prose\n夜雨敲窗。\n\n他点了灯。\n```"), expected);
});

test("未闭合围栏按纯文本段落回退，不抛错", () => {
  const html = renderMarkdown("```稿\n只有开头");
  assert.ok(html.startsWith("<p>"), html);
  assert.ok(html.includes("只有开头"));
  assert.ok(!html.includes("manuscript-block"));
});

test("注入文本始终被转义（含稿块内）", () => {
  const html = renderMarkdown("```稿\n<script>alert(1)</script>\n```");
  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("混合文档整体顺序正确", () => {
  const html = renderMarkdown("说明文字。\n\n```稿\n正文段。\n```\n\n- 要点");
  const iText = html.indexOf("<p>说明文字。</p>");
  const iMs = html.indexOf("manuscript-block");
  const iUl = html.indexOf("<ul>");
  assert.ok(iText >= 0 && iMs > iText && iUl > iMs, html);
});
````

- [ ] **Step 1.2: 跑测试确认失败**

Run: `node --test tests/markdown-lite.test.mjs`
Expected: FAIL（`Cannot find module ... markdown-lite.mjs`）

- [ ] **Step 1.3: 实现**（完整文件）：

````js
// src/app-shell/markdown-lite.mjs
// 极简 markdown 渲染（零依赖纯函数）。安全顺序：先整体 escape，再做结构转换。
// 支持：段落、**粗体**、`行内代码`、##/### 标题（降级 h4/h5）、-/1. 列表、> 引用、
// --- 分隔线、``` 普通围栏、```稿（别名 prose）文稿块。不识别的结构按纯文本段落回退。
// 稿块带 peek class：隐私模式（[data-privacy="on"] .peek）必须能模糊对话里的正文。

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 仅用于 UI 字数标（与 core/word-count 的口径无需一致；这里是展示性计数）。
export function countProseWords(text) {
  return String(text ?? "").replace(/\s+/gu, "").length;
}

function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

const ORDERED_RE = /^\d+(\.\s+|、\s*)/;
const BLOCK_BOUNDARY_RE = /^(```|---+\s*$|#{2,3}\s|[-*]\s|\d+(\.\s+|、\s*)|&gt;)/;

export function renderMarkdown(text) {
  const lines = escapeHtml(text).split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const buf = [];
      let closed = false;
      i += 1;
      while (i < lines.length) {
        if (/^```\s*$/.test(lines[i])) { closed = true; i += 1; break; }
        buf.push(lines[i]);
        i += 1;
      }
      const body = buf.join("\n");
      if (!closed) {
        // 未闭合：连同围栏行按纯文本段落回退。
        const fallback = [line, ...buf].filter((l) => l.trim());
        out.push(`<p>${fallback.map(inline).join("<br>")}</p>`);
        continue;
      }
      if (lang === "稿" || lang === "prose") {
        const paras = body.split(/\n{2,}/u)
          .map((p) => p.trim()).filter(Boolean)
          .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
          .join("");
        out.push(`<div class="manuscript-block peek">${paras}<span class="manuscript-words">${countProseWords(body)} 字</span></div>`);
      } else {
        out.push(`<pre class="md-fence"><code>${body}</code></pre>`);
      }
      continue;
    }
    if (/^---+\s*$/.test(line)) { out.push("<hr>"); i += 1; continue; }
    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      const tag = heading[1].length === 2 ? "h4" : "h5";
      out.push(`<${tag}>${inline(heading[2])}</${tag}>`);
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (ORDERED_RE.test(line)) {
      const items = [];
      while (i < lines.length && ORDERED_RE.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(ORDERED_RE, ""))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        buf.push(inline(lines[i].replace(/^&gt;\s?/, "")));
        i += 1;
      }
      out.push(`<blockquote>${buf.join("<br>")}</blockquote>`);
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !BLOCK_BOUNDARY_RE.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}
````

- [ ] **Step 1.4: 跑测试确认通过**

Run: `node --test tests/markdown-lite.test.mjs`
Expected: 全部 pass（14 tests）

- [ ] **Step 1.5: Commit**

```bash
git add src/app-shell/markdown-lite.mjs tests/markdown-lite.test.mjs
git commit -m "feat(s4.5): markdown-lite renderer - lists/headings/quotes/fences/manuscript blocks"
```

---

### Task 2: 稿块协议 + `parseAgentReply` 多围栏加固（B1 协议层）

**Files:**
- Modify: `src/core/chat/agent-protocol.mjs`
- Test: `tests/chat-protocol.test.mjs`（追加用例）

- [ ] **Step 2.1: 追加失败测试**——在 `tests/chat-protocol.test.mjs` 文件末尾追加：

````js
// ===== S4.5: 多围栏扫描 + 稿块约定 =====
test("稿块围栏在前、tool call 围栏在后：调用不丢失，稿块留在 leadText", () => {
  const reply = [
    "开场我先给你看一段：",
    "```稿",
    "夜雨敲窗，他点了灯。",
    "```",
    '```json',
    '{"tool_calls":[{"tool":"read_chapter","args":{"chapter_no":2}}]}',
    "```"
  ].join("\n");
  const parsed = parseAgentReply(reply);
  assert.equal(parsed.type, "tool_call");
  assert.equal(parsed.call.tool, "read_chapter");
  assert.deepEqual(parsed.call.args, { chapter_no: 2 });
  assert.ok(parsed.leadText.includes("```稿"), "稿块应保留在 leadText 中");
  assert.ok(parsed.leadText.includes("夜雨敲窗"));
});

test("只有稿块围栏（无 tool call）：整体按文本返回", () => {
  const reply = "```稿\n正文片段。\n```\n\n这是说明。";
  const parsed = parseAgentReply(reply);
  assert.equal(parsed.type, "text");
  assert.equal(parsed.text, reply);
});

test("多个非 JSON 围栏 + 裸 JSON tool call：裸 JSON 仍可解析", () => {
  const parsed = parseAgentReply('{"tool_calls":[{"tool":"get_status","args":{}}]}');
  assert.equal(parsed.type, "tool_call");
  assert.equal(parsed.call.tool, "get_status");
});

test("buildSystemPrompt 包含稿块约定", () => {
  const registry = { list: () => [] };
  const prompt = buildSystemPrompt(registry, {});
  assert.match(prompt, /```稿/u);
});
````

注意：该测试文件顶部已有的 import 必须包含 `parseAgentReply` 与 `buildSystemPrompt`；若 `buildSystemPrompt` 未导入，把顶部 import 改为：

```js
import { parseAgentReply, buildSystemPrompt } from "../src/core/chat/agent-protocol.mjs";
```

- [ ] **Step 2.2: 跑测试确认失败**

Run: `node --test tests/chat-protocol.test.mjs`
Expected: 新增 4 例中至少"稿块在前"一例 FAIL（现实现把第一个非 JSON 围栏当文本，丢调用）

- [ ] **Step 2.3: 实现**——`agent-protocol.mjs` 整体替换 `parseAgentReply`（原 5–26 行）为：

```js
export function parseAgentReply(rawText) {
  const text = String(rawText ?? "").trim();
  // 扫描全部围栏，取第一个能解析出 tool_calls 的；其余围栏（如 ```稿）留在文本/leadText 里。
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gu;
  let match;
  while ((match = fenceRe.exec(text)) !== null) {
    const parsed = tryParseToolCall(match[1].trim());
    if (parsed) {
      return {
        type: "tool_call",
        call: parsed.call,
        dropped: parsed.dropped,
        leadText: text.slice(0, match.index).trim()
      };
    }
  }
  if (text.startsWith("{")) {
    const parsed = tryParseToolCall(text);
    if (parsed) {
      return { type: "tool_call", call: parsed.call, dropped: parsed.dropped, leadText: "" };
    }
  }
  return { type: "text", text };
}

function tryParseToolCall(candidate) {
  try {
    const data = JSON.parse(candidate);
    if (Array.isArray(data?.tool_calls) && data.tool_calls.length > 0) {
      const [first, ...rest] = data.tool_calls;
      if (first?.tool) {
        return { call: { tool: String(first.tool), args: first.args ?? {} }, dropped: rest.length };
      }
    }
  } catch { /* 不是 tool call，继续扫描 */ }
  return null;
}
```

- [ ] **Step 2.4: 系统提示加约定**——`buildSystemPrompt` 中，在 `"写类与控制类工具会先征求用户确认，被拒绝时请尊重用户决定。",` 一行之后插入：

```js
    "输出小说正文、草稿或改写片段时，把正文放进一个 ```稿 围栏块（说明文字放围栏外）；不要把工具调用 JSON 和正文混进同一个围栏。",
```

- [ ] **Step 2.5: 跑测试确认通过（含全部既有回归）**

Run: `node --test tests/chat-protocol.test.mjs && node --test tests/chat-agent.test.mjs`
Expected: 全 pass（既有单围栏/纯文本/裸 JSON 用例不许变红）

- [ ] **Step 2.6: Commit**

```bash
git add src/core/chat/agent-protocol.mjs tests/chat-protocol.test.mjs
git commit -m "feat(s4.5): manuscript fence convention + multi-fence tool call scan"
```

---

### Task 3: tool 消息携带 args 摘要（D2 数据层）

**Files:**
- Modify: `src/core/chat/tool-registry.mjs`（导出 `summarizeArgs`）
- Modify: `src/core/chat/chat-agent.mjs`（5 处 append 补 `args`）
- Test: `tests/chat-tool-args.test.mjs`（新建）

- [ ] **Step 3.1: 写失败测试**（完整文件）：

````js
// tests/chat-tool-args.test.mjs
// tool 消息必须带 args 摘要（JSON 字符串，截断 200），供前端人话标签/溯源 chips 使用。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runChatTurn } from "../src/core/chat/chat-agent.mjs";
import { readChatHistory } from "../src/core/chat/chat-store.mjs";
import { createToolRegistry, summarizeArgs } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { createProject, loadProject, upsertChapter } from "../src/core/project-store.mjs";

function scriptedClient(script) {
  let i = 0;
  return { generate: async () => ({ text: script[Math.min(i++, script.length - 1)], usageReport: {}, costSummary: { estimatedCost: 0 } }) };
}

async function makeChatProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-args-"));
  const { projectRoot } = await createProject(root, {
    slug: "a", title: "args 测试", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const chapterPath = path.join(projectRoot, "chapters", "001.md");
  await fs.mkdir(path.dirname(chapterPath), { recursive: true });
  await fs.writeFile(chapterPath, "# Chapter 001\n\n刘康从六楼坠落。", "utf8");
  await upsertChapter(projectRoot, { chapter_no: 1, status: "completed", final_path: chapterPath, actual_words: 8 });
  return projectRoot;
}

test("summarizeArgs 已导出且截断 200 字符", () => {
  assert.equal(summarizeArgs({ chapter_no: 1 }), '{"chapter_no":1}');
  const long = summarizeArgs({ find: "甲".repeat(300) });
  assert.ok(long.length <= 201, String(long.length)); // 200 + 截断省略号
  assert.ok(long.endsWith("…"));
});

test("读工具执行后历史里的 tool 消息带 args", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"read_chapter","args":{"chapter_no":1}}]}\n```',
      "第 1 章讲坠楼。"
    ]),
    userMessage: "第一章讲什么？"
  });
  const history = await readChatHistory(projectRoot);
  const toolMsg = history.find((m) => m.role === "tool");
  assert.ok(toolMsg, "应有 tool 消息");
  assert.equal(toolMsg.args, '{"chapter_no":1}');
});

test("权限拒绝分支的 tool 消息同样带 args", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  project.tool_permissions = { read_only: true };
  const registry = createToolRegistry();
  registerReadTools(registry);
  registry.register({
    name: "fake_write", kind: "write", description: "测试写工具", params: {},
    run: async () => ({ done: true })
  });
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"fake_write","args":{"x":1}}]}\n```',
      "好的。"
    ]),
    userMessage: "改一下"
  });
  const history = await readChatHistory(projectRoot);
  const toolMsg = history.find((m) => m.role === "tool" && m.tool === "fake_write");
  assert.ok(toolMsg);
  assert.equal(toolMsg.ok, false);
  assert.equal(toolMsg.args, '{"x":1}');
});
````

- [ ] **Step 3.2: 跑测试确认失败**

Run: `node --test tests/chat-tool-args.test.mjs`
Expected: FAIL（summarizeArgs 未导出 / toolMsg.args undefined）

- [ ] **Step 3.3: 实现**——两个文件的精确修改：

(a) `tool-registry.mjs` 末尾的 `function summarizeArgs(args) {` 改为 `export function summarizeArgs(args) {`（其余不动）。

(b) `chat-agent.mjs` 顶部 import 改为：

```js
import { executeTool, checkToolPermission, summarizeArgs } from "./tool-registry.mjs";
```

(c) `chat-agent.mjs` 共 5 处 `appendChatMessage(projectRoot, { role: "tool", ...` 调用，每处对象里补一个 `args` 字段：

- `resumeChatTurn` 内（`tool: pending.tool` 那处）→ 补 `args: summarizeArgs(pending.args),`
- 权限拒绝分支（`ok: false, result_summary: outcome.message` 那处）→ 补 `args: summarizeArgs(parsed.call.args),`
- 免确认分支（`auto_approved: true` 那处）→ 补 `args: summarizeArgs(parsed.call.args),`
- preview 失败分支（`catch (error)` 里那处）→ 补 `args: summarizeArgs(parsed.call.args),`
- 读工具执行处（循环末尾那处）→ 补 `args: summarizeArgs(parsed.call.args),`

- [ ] **Step 3.4: 跑测试确认通过 + 回归**

Run: `node --test tests/chat-tool-args.test.mjs && node --test tests/chat-agent.test.mjs && node --test tests/chat-tools.test.mjs`
Expected: 全 pass

- [ ] **Step 3.5: Commit**

```bash
git add src/core/chat/tool-registry.mjs src/core/chat/chat-agent.mjs tests/chat-tool-args.test.mjs
git commit -m "feat(s4.5): persist args summary on tool messages for humanized labels"
```

---

### Task 4: chat 循环 signal 中断（A2 核心）

**Files:**
- Modify: `src/core/chat/chat-agent.mjs`
- Test: `tests/chat-agent-cancel.test.mjs`（新建）

- [ ] **Step 4.1: 写失败测试**（完整文件）：

````js
// tests/chat-agent-cancel.test.mjs
// 中断语义：轮间/模型调用中可停；已开始的工具不打断；落「（已停止。）」并返回 cancelled。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runChatTurn } from "../src/core/chat/chat-agent.mjs";
import { readChatHistory } from "../src/core/chat/chat-store.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { createProject, loadProject } from "../src/core/project-store.mjs";

async function makeProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-cancel-"));
  const { projectRoot } = await createProject(root, {
    slug: "c", title: "取消测试", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  return projectRoot;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

test("发起前已 abort：不调模型，直接落「（已停止。）」", async () => {
  const projectRoot = await makeProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const controller = new AbortController();
  controller.abort("用户停止");
  let generateCalls = 0;
  const out = await runChatTurn({
    projectRoot, project, registry, signal: controller.signal,
    modelClient: { generate: async () => { generateCalls += 1; return { text: "不应到达", costSummary: { estimatedCost: 0 } }; } },
    userMessage: "你好"
  });
  assert.equal(out.cancelled, true);
  assert.equal(generateCalls, 0);
  const history = await readChatHistory(projectRoot);
  assert.equal(history.at(-1).content, "（已停止。）");
  assert.equal(history.at(-1).role, "assistant");
});

test("模型调用进行中 abort：generate 抛 AbortError，循环落「（已停止。）」", async () => {
  const projectRoot = await makeProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const controller = new AbortController();
  const modelClient = {
    generate: ({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })
  };
  const turn = runChatTurn({
    projectRoot, project, registry, signal: controller.signal, modelClient, userMessage: "慢问题"
  });
  await delay(50);
  controller.abort("用户停止");
  const out = await turn;
  assert.equal(out.cancelled, true);
  const history = await readChatHistory(projectRoot);
  assert.equal(history.at(-1).content, "（已停止。）");
});

test("工具执行中 abort：工具跑完不被打断，工具结果落盘后才停", async () => {
  const projectRoot = await makeProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  let toolFinished = false;
  registry.register({
    name: "slow_read", kind: "read", description: "慢读", params: {},
    run: async () => { await delay(150); toolFinished = true; return { done: true }; }
  });
  const controller = new AbortController();
  let round = 0;
  const modelClient = {
    generate: async () => {
      round += 1;
      if (round === 1) return { text: '```json\n{"tool_calls":[{"tool":"slow_read","args":{}}]}\n```', costSummary: { estimatedCost: 0 } };
      return { text: "第二轮文本（不应作为最终回复，因为已 abort）", costSummary: { estimatedCost: 0 } };
    }
  };
  const turn = runChatTurn({ projectRoot, project, registry, signal: controller.signal, modelClient, userMessage: "查一下" });
  await delay(50); // 此刻第一轮 generate 已返回，slow_read 执行中
  controller.abort("用户停止");
  const out = await turn;
  assert.equal(toolFinished, true, "已开始的工具必须执行完");
  assert.equal(out.cancelled, true);
  const history = await readChatHistory(projectRoot);
  const roles = history.map((m) => m.role);
  assert.ok(roles.includes("tool"), "工具结果应已落盘");
  assert.equal(history.at(-1).content, "（已停止。）");
});

test("不传 signal 行为完全不变（回归）", async () => {
  const projectRoot = await makeProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: { generate: async () => ({ text: "正常回复。", costSummary: { estimatedCost: 0 } }) },
    userMessage: "你好"
  });
  assert.equal(out.reply, "正常回复。");
  assert.equal(out.cancelled, undefined);
});
````

- [ ] **Step 4.2: 跑测试确认失败**

Run: `node --test tests/chat-agent-cancel.test.mjs`
Expected: 前三例 FAIL（cancelled undefined / 无「（已停止。）」）

- [ ] **Step 4.3: 实现**——`chat-agent.mjs` 的 `agentLoop` 整体替换为（在 Task 3 版本基础上，仅展示完整新函数；`runChatTurn`/`resumeChatTurn` 不需要改签名——signal 经 `options` 透传）：

```js
async function agentLoop(options, toolEvents) {
  const { projectRoot, project, registry, modelClient, server, getTaskQueue, onEvent, signal } = options;
  let totalCost = 0;
  let calls = 0;
  for (let round = 0; round < MAX_TOOL_ROUNDS + 1; round += 1) {
    if (signal?.aborted) return await finishCancelled(projectRoot, toolEvents, calls, totalCost);
    const { messages } = await buildChatContext({ projectRoot, project, registry, userMessage: latestPrompt(options, round) });
    let result;
    try {
      result = await modelClient.generate({
        project, stage: "chat", messages, metadata: { chat: true, round }, signal
      });
    } catch (error) {
      // 外部停止（signal.aborted）与模型超时（仅 AbortError）要区分：超时照旧抛出走原错误链。
      if (signal?.aborted) return await finishCancelled(projectRoot, toolEvents, calls, totalCost);
      throw error;
    }
    calls += 1;
    totalCost += Number(result.costSummary?.estimatedCost ?? 0) || 0;
    const parsed = parseAgentReply(result.text);
    if (parsed.type === "text") {
      await appendChatMessage(projectRoot, { role: "assistant", content: parsed.text, cost: totalCost || undefined });
      return { reply: parsed.text, toolEvents, pendingAction: null, usage: { calls, cost: totalCost } };
    }
    if (toolEvents.length >= MAX_TOOL_ROUNDS) break;
    if (signal?.aborted) return await finishCancelled(projectRoot, toolEvents, calls, totalCost);
    const tool = registry.get(parsed.call.tool);
    const isRead = tool?.kind === "read";
    if (tool && !isRead) {
      // 权限预检：落 pending 之前先检查，避免 read_only 项目白白占确认位
      const permission = checkToolPermission(tool, project?.tool_permissions ?? {}, { archived: Boolean(project?.archived_at) });
      if (!permission.allowed) {
        const outcome = { ok: false, error: "permission_denied", message: permission.message };
        toolEvents.push({ tool: parsed.call.tool, ok: false, error: outcome.error });
        await appendChatMessage(projectRoot, { role: "tool", tool: parsed.call.tool, ok: false, args: summarizeArgs(parsed.call.args), result_summary: outcome.message });
        onEvent?.({ type: "tool_result", tool: parsed.call.tool, ok: false });
        continue;
      }
      // 免确认分支：yolo 放开 write+control；auto_edit 仅放开 write。免「确认」不免「校验」——直接走 executeTool 原链。
      const perms = project?.tool_permissions ?? {};
      const autoApproved = perms.yolo === true || (perms.auto_edit === true && tool.kind === "write");
      if (autoApproved) {
        // 已开始执行的写工具不接收 abort：文件操作必须原子完成，停止只在边界生效。
        const outcome = await executeTool(registry, parsed.call.tool, parsed.call.args, { projectRoot, project, server, getTaskQueue });
        const event = { tool: parsed.call.tool, ok: outcome.ok, error: outcome.ok ? null : outcome.error };
        toolEvents.push(event);
        await appendChatMessage(projectRoot, {
          role: "tool", tool: parsed.call.tool, ok: outcome.ok, auto_approved: true,
          args: summarizeArgs(parsed.call.args),
          result_summary: summarize(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
        });
        onEvent?.({ type: "tool_result", ...event });
        continue; // 回 loop 让模型看到结果继续
      }
      let preview = null;
      if (parsed.call.tool === "edit_chapter") {
        try { preview = await previewEditChapter(projectRoot, parsed.call.args); }
        catch (error) {
          const outcome = { ok: false, error: error.code ?? "preview_failed", message: error.message };
          toolEvents.push({ tool: parsed.call.tool, ok: false, error: outcome.error });
          await appendChatMessage(projectRoot, { role: "tool", tool: parsed.call.tool, ok: false, args: summarizeArgs(parsed.call.args), result_summary: outcome.message });
          onEvent?.({ type: "tool_result", tool: parsed.call.tool, ok: false });
          continue;
        }
      }
      const pending = await savePendingAction(projectRoot, {
        tool: parsed.call.tool, args: parsed.call.args, preview, lead_text: parsed.leadText ?? ""
      });
      const note = [parsed.leadText, `（待确认操作：${parsed.call.tool}，请在确认卡上批准或取消）`].filter(Boolean).join("\n");
      await appendChatMessage(projectRoot, { role: "assistant", content: note, cost: totalCost || undefined });
      onEvent?.({ type: "pending_action", action: pending });
      return { reply: note, toolEvents, pendingAction: pending, usage: { calls, cost: totalCost } };
    }
    const outcome = await executeTool(registry, parsed.call.tool, parsed.call.args, { projectRoot, project, server, getTaskQueue });
    const event = { tool: parsed.call.tool, ok: outcome.ok, error: outcome.ok ? null : outcome.error };
    toolEvents.push(event);
    await appendChatMessage(projectRoot, {
      role: "tool", tool: parsed.call.tool, ok: outcome.ok,
      args: summarizeArgs(parsed.call.args),
      result_summary: summarize(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
    });
    onEvent?.({ type: "tool_result", ...event });
  }
  const capped = "操作轮数达到上限，我先停在这里。请把任务拆小一点，或直接告诉我下一步。";
  await appendChatMessage(projectRoot, { role: "assistant", content: capped });
  return { reply: capped, toolEvents, pendingAction: null, usage: { calls, cost: totalCost } };
}

async function finishCancelled(projectRoot, toolEvents, calls, totalCost) {
  await appendChatMessage(projectRoot, { role: "assistant", content: "（已停止。）", cost: totalCost || undefined });
  return { reply: "（已停止。）", toolEvents, pendingAction: null, cancelled: true, usage: { calls, cost: totalCost } };
}
```

- [ ] **Step 4.4: 跑测试确认通过 + 回归**

Run: `node --test tests/chat-agent-cancel.test.mjs && node --test tests/chat-agent.test.mjs && node --test tests/chat-tool-args.test.mjs`
Expected: 全 pass

- [ ] **Step 4.5: Commit**

```bash
git add src/core/chat/chat-agent.mjs tests/chat-agent-cancel.test.mjs
git commit -m "feat(s4.5): abort signal through chat loop - boundary checks, model-call abort, atomic tools"
```

---

### Task 5: 服务端 chatJobs + busy 字段 + `/api/chat/stop`（A1/A2 服务端）

**Files:**
- Modify: `src/core/app-server.mjs`
- Modify: `src/app-shell/api-client.js`
- Test: `tests/app-shell/chat-busy-stop.test.mjs`（新建）

- [ ] **Step 5.1: 写失败测试**（完整文件；server 启动/关闭样板抄 `tests/app-shell/chat-endpoints.test.mjs` 的 `setupServer`/`closeServer`/`postJson`/`getJson`，并加 `testModel`）：

````js
// tests/app-shell/chat-busy-stop.test.mjs
// busy 字段 / 并发 send 409 / stop 中断 / 空闲 stop 409。
// 关键约束：/api/chat/stop 绝不进项目锁（send 正持锁，入锁即死锁）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../../src/core/app-server.mjs";
import { createProject } from "../../src/core/project-store.mjs";

function slowChatClient(delayMs = 1200) {
  return {
    generate: ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ text: "慢速回复完成。", usageReport: {}, costSummary: { estimatedCost: 0 } }), delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }),
    costTracker: { writeProjectReport: async () => {} }
  };
}

async function setupServer(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-busy-"));
  const { projectRoot } = await createProject(root, {
    slug: "busy", title: "忙态测试", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    port: 0,
    ...options
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, projectRoot };
}

function closeServer(server) { return new Promise((resolve) => server.close(resolve)); }

async function postJson(port, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {})
  });
  return { res, data: await res.json() };
}

async function getJson(port, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`);
  return { res, data: await res.json() };
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

test("send 进行中 history.busy=true；结束后 false", async () => {
  const ctx = await setupServer({ testModel: { chatClient: () => slowChatClient(900) } });
  try {
    const sending = postJson(ctx.port, "/api/chat/send", { message: "慢问题" });
    await delay(250);
    const during = await getJson(ctx.port, "/api/chat/history");
    assert.equal(during.data.busy, true);
    assert.ok(during.data.busySince, "busySince 应为 ISO 时间串");
    await sending;
    const after = await getJson(ctx.port, "/api/chat/history");
    assert.equal(after.data.busy, false);
    assert.equal(after.data.busySince, null);
  } finally { await closeServer(ctx.server); }
});

test("忙时并发 send 返回 409，不排队", async () => {
  const ctx = await setupServer({ testModel: { chatClient: () => slowChatClient(900) } });
  try {
    const first = postJson(ctx.port, "/api/chat/send", { message: "第一条" });
    await delay(200);
    const second = await postJson(ctx.port, "/api/chat/send", { message: "第二条" });
    assert.equal(second.res.status, 409);
    assert.equal(second.data.ok, false);
    await first;
  } finally { await closeServer(ctx.server); }
});

test("stop 中断进行中的 send：响应 cancelled=true，历史落「（已停止。）」", async () => {
  const ctx = await setupServer({ testModel: { chatClient: () => slowChatClient(5000) } });
  try {
    const sending = postJson(ctx.port, "/api/chat/send", { message: "很慢的问题" });
    await delay(250);
    const stop = await postJson(ctx.port, "/api/chat/stop", {});
    assert.equal(stop.res.status, 200);
    const sent = await sending; // 必须在远小于 5s 内返回（stop 生效）
    assert.equal(sent.res.status, 200);
    assert.equal(sent.data.cancelled, true);
    const hist = await getJson(ctx.port, "/api/chat/history");
    assert.equal(hist.data.messages.at(-1).content, "（已停止。）");
    assert.equal(hist.data.busy, false);
  } finally { await closeServer(ctx.server); }
});

test("空闲时 stop 返回 409", async () => {
  const ctx = await setupServer();
  try {
    const stop = await postJson(ctx.port, "/api/chat/stop", {});
    assert.equal(stop.res.status, 409);
  } finally { await closeServer(ctx.server); }
});
````

- [ ] **Step 5.2: 跑测试确认失败**

Run: `node --test tests/app-shell/chat-busy-stop.test.mjs`
Expected: FAIL（busy undefined / stop 404）

- [ ] **Step 5.3: 实现 `app-server.mjs`**——五处精确修改：

(a) `const runJobs = new Map();`（约 54 行）之后插入：

```js
  // chat 循环忙态注册表：resolvedProjectRoot -> { controller, startedAt }。
  // send/confirm 进锁前注册；/api/chat/stop 从这里取 controller —— stop 绝不进项目锁（send 正持锁，入锁即死锁）。
  const chatJobs = new Map();
```

(b) 路由区三处（约 155–166 行）：`/api/chat/send`、`/api/chat/confirm` 的 context 对象补 `chatJobs,`；`/api/chat/history` 的 context 改为 `{ workspace, selected, chatJobs }`；并在 history 路由之后插入：

```js
    if (url.pathname === "/api/chat/stop" && request.method === "POST") {
      // 红线：不要给这个端点包 withProjectLock。
      await serveChatStop(response, { workspace, selected, chatJobs });
      return;
    }
```

(c) `serveChatSend` 改造：在 `const projectRoot = await resolveActiveProjectRoot(context);` 之后、`return await withProjectLock(...)` 之前插入忙态守卫与注册，并用 try/finally 包住 withProjectLock；`runChatTurn` 参数补 `signal`、模型客户端走测试缝。完整新函数体：

```js
async function serveChatSend(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const message = String(body.message ?? "").trim();
    if (!message) throw new Error("请输入要发送的消息。");
    if (message.length > 4000) throw new Error("消息过长。");
    const projectRoot = await resolveActiveProjectRoot(context);
    const jobKey = path.resolve(projectRoot);
    if (context.chatJobs.has(jobKey)) {
      sendError(response, new HttpError(409, "CHAT_BUSY", "上一轮对话还在进行中，请等它完成或先点停止。"));
      return;
    }
    const controller = new AbortController();
    context.chatJobs.set(jobKey, { controller, startedAt: new Date().toISOString() });
    try {
      return await withProjectLock(context, projectRoot, async () => {
      const project = await loadProject(projectRoot);
      const registry = buildChatRegistry();
      const modelClient = context.testModel?.chatClient?.() ?? await buildChatModelClient(project, projectRoot);
      const result = await runChatTurn({
        projectRoot,
        project,
        registry,
        modelClient,
        userMessage: message,
        signal: controller.signal,
        server: chatServerContext(context),
        getTaskQueue: context.getTaskQueue
      });
      await modelClient.costTracker.writeProjectReport(projectRoot);
      await serveJson(response, { ok: true, ...result });
      });
    } finally {
      context.chatJobs.delete(jobKey);
    }
  } catch (error) {
    sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
  }
}
```

注意 1：原函数若开头校验文案与上面不同，**保留原有校验文案**，只加守卫/注册/signal/finally/测试缝五件事。
注意 2：catch 里必须先判 `error instanceof HttpError`（否则 409 会被吞成 400）——上面已写。

(d) `serveChatConfirm` 完整新函数体（同构改造，confirm 没有 message 校验）：

```js
async function serveChatConfirm(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveProjectRoot(context);
    const jobKey = path.resolve(projectRoot);
    if (context.chatJobs.has(jobKey)) {
      sendError(response, new HttpError(409, "CHAT_BUSY", "上一轮对话还在进行中，请等它完成或先点停止。"));
      return;
    }
    const controller = new AbortController();
    context.chatJobs.set(jobKey, { controller, startedAt: new Date().toISOString() });
    try {
      return await withProjectLock(context, projectRoot, async () => {
      const project = await loadProject(projectRoot);
      const registry = buildChatRegistry();
      const modelClient = context.testModel?.chatClient?.() ?? await buildChatModelClient(project, projectRoot);
      const result = await resumeChatTurn({
        projectRoot,
        project,
        registry,
        modelClient,
        approve: body.approve === true,
        signal: controller.signal,
        server: chatServerContext(context),
        getTaskQueue: context.getTaskQueue
      });
      await modelClient.costTracker.writeProjectReport(projectRoot);
      await serveJson(response, { ok: true, ...result });
      });
    } finally {
      context.chatJobs.delete(jobKey);
    }
  } catch (error) {
    sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
  }
}
```

(e) `serveChatHistory` 的 `serveJson` 调用替换为：

```js
    const jobKey = path.resolve(projectRoot);
    const job = context.chatJobs?.get(jobKey) ?? null;
    await serveJson(response, { ok: true, messages, pendingAction, busy: Boolean(job), busySince: job?.startedAt ?? null });
```

(f) 新增函数（放在 `serveChatHistory` 之后）：

```js
async function serveChatStop(response, context) {
  try {
    const projectRoot = await resolveActiveProjectRoot(context);
    const job = context.chatJobs.get(path.resolve(projectRoot));
    if (!job) {
      sendError(response, new HttpError(409, "CONFLICT", "当前没有进行中的对话轮。"));
      return;
    }
    job.controller.abort("用户停止");
    await serveJson(response, { ok: true, message: "已请求停止本轮对话。" });
  } catch (error) {
    sendError(response, error instanceof HttpError ? error : new HttpError(400, "BAD_REQUEST", error.message));
  }
}
```

- [ ] **Step 5.4: `api-client.js` 末尾追加**：

```js
export async function stopChat() {
  return await postJson("/api/chat/stop", {});
}
```

- [ ] **Step 5.5: 跑测试确认通过 + 回归**

Run: `node --test tests/app-shell/chat-busy-stop.test.mjs && node --test tests/app-shell/chat-endpoints.test.mjs`
Expected: 全 pass（既有 chat-endpoints 不许变红）

- [ ] **Step 5.6: Commit**

```bash
git add src/core/app-server.mjs src/app-shell/api-client.js tests/app-shell/chat-busy-stop.test.mjs
git commit -m "feat(s4.5): chatJobs registry, busy flag on history, lock-free /api/chat/stop"
```

---

### Task 6: `tool-labels.mjs` 人话映射（D2 映射层）

**Files:**
- Create: `src/app-shell/tool-labels.mjs`
- Test: `tests/tool-labels.test.mjs`

- [ ] **Step 6.1: 写失败测试**（完整文件）：

````js
// tests/tool-labels.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { toolLabel, toolSourceChip, parseArgsSummary, READ_TOOLS } from "../src/app-shell/tool-labels.mjs";

test("parseArgsSummary：完整 JSON / 截断 JSON 抢救 / 非法输入", () => {
  assert.deepEqual(parseArgsSummary('{"chapter_no":3}'), { chapter_no: 3 });
  assert.deepEqual(parseArgsSummary({ chapter_no: 3 }), { chapter_no: 3 });
  const truncated = '{"chapter_no":7,"find":"' + "甲".repeat(300);
  assert.equal(parseArgsSummary(truncated).chapter_no, 7);
  const q = '{"query":"灯笼","other":"' + "x".repeat(300);
  assert.equal(parseArgsSummary(q).query, "灯笼");
  assert.equal(parseArgsSummary("not json at all"), null);
  assert.equal(parseArgsSummary(null), null);
});

test("17 个工具全部有非回退人话标签", () => {
  const cases = [
    ["get_status", "{}", /项目状态/],
    ["read_chapter", '{"chapter_no":3}', /第 3 章/],
    ["search_text", '{"query":"灯笼"}', /「灯笼」/],
    ["read_continuity", '{"entity":"刘康"}', /设定记忆.*刘康/],
    ["read_outline", "{}", /大纲/],
    ["get_cost", "{}", /成本/],
    ["edit_chapter", '{"chapter_no":2}', /修改第 2 章/],
    ["rewrite_chapter", '{"chapter_no":4}', /重写第 4 章/],
    ["update_continuity", '{"entity":"刘康"}', /设定记忆.*刘康/],
    ["update_outline", "{}", /写作计划/],
    ["queue_chapters", "{}", /写作指令|写作任务/],
    ["update_settings", "{}", /项目设置/],
    ["export_book", '{"format":"txt"}', /导出成书.*txt/],
    ["archive_project", '{"archived":true}', /归档项目/],
    ["archive_project", '{"archived":"false"}', /解除归档/],
    ["start_run", "{}", /启动写作/],
    ["pause_run", "{}", /暂停写作/],
    ["resolve_failure", '{"command":"pause-here"}', /处理故障/]
  ];
  for (const [tool, args, re] of cases) {
    assert.match(toolLabel(tool, args), re, tool);
  }
});

test("未知工具回退「工具 name」", () => {
  assert.equal(toolLabel("mystery_tool", "{}"), "工具 mystery_tool");
});

test("args 缺失时降级仍可读", () => {
  assert.equal(toolLabel("read_chapter", null), "读取了章节");
  assert.equal(toolLabel("edit_chapter", null), "修改章节");
});

test("toolSourceChip：read 工具映射溯源 chip，read_chapter 带 chapterNo", () => {
  assert.deepEqual(toolSourceChip("read_chapter", '{"chapter_no":3}'), { label: "第 3 章", chapterNo: 3 });
  assert.deepEqual(toolSourceChip("read_chapter", null), { label: "章节", chapterNo: null });
  assert.deepEqual(toolSourceChip("read_continuity", "{}"), { label: "设定记忆", chapterNo: null });
  assert.deepEqual(toolSourceChip("read_outline", "{}"), { label: "大纲", chapterNo: null });
  assert.deepEqual(toolSourceChip("search_text", "{}"), { label: "全文搜索", chapterNo: null });
  assert.deepEqual(toolSourceChip("get_status", "{}"), { label: "项目状态", chapterNo: null });
  assert.deepEqual(toolSourceChip("get_cost", "{}"), { label: "成本台账", chapterNo: null });
  assert.equal(toolSourceChip("edit_chapter", "{}"), null, "write 工具不是溯源来源");
});

test("READ_TOOLS 集合与 6 个读工具一致", () => {
  assert.deepEqual([...READ_TOOLS].sort(), ["get_cost", "get_status", "read_chapter", "read_continuity", "read_outline", "search_text"]);
});
````

- [ ] **Step 6.2: 跑测试确认失败**

Run: `node --test tests/tool-labels.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 6.3: 实现**（完整文件）：

```js
// src/app-shell/tool-labels.mjs
// 17 个 chat 工具 → 写作者语言。技术名/原始 JSON 由 thread-renderer 收进展开区。
// args 摘要可能是被截断 200 字符的 JSON 字符串：parseArgsSummary 先整体 parse，
// 失败再做关键字段抢救（chapter_no/query/entity），都失败返回 null（调用方降级）。

export const READ_TOOLS = new Set(["get_status", "read_chapter", "search_text", "read_continuity", "read_outline", "get_cost"]);

export function parseArgsSummary(argsSummary) {
  if (argsSummary == null) return null;
  if (typeof argsSummary === "object") return argsSummary;
  const text = String(argsSummary);
  try { return JSON.parse(text); } catch { /* 截断 JSON，下面抢救 */ }
  const out = {};
  const chapter = /"chapter_no"\s*:\s*(\d+)/.exec(text);
  if (chapter) out.chapter_no = Number(chapter[1]);
  const query = /"query"\s*:\s*"([^"]*)"/.exec(text);
  if (query) out.query = query[1];
  const entity = /"entity"\s*:\s*"([^"]*)"/.exec(text);
  if (entity) out.entity = entity[1];
  return Object.keys(out).length > 0 ? out : null;
}

const LABELS = {
  get_status: () => "查询了项目状态",
  read_chapter: (a) => (a?.chapter_no ? `读取了第 ${a.chapter_no} 章` : "读取了章节"),
  search_text: (a) => (a?.query ? `搜索「${a.query}」` : "搜索了全文"),
  read_continuity: (a) => (a?.entity ? `查阅了设定记忆 · ${a.entity}` : "查阅了设定记忆"),
  read_outline: () => "查阅了大纲与计划",
  get_cost: () => "查询了成本台账",
  edit_chapter: (a) => (a?.chapter_no ? `修改第 ${a.chapter_no} 章` : "修改章节"),
  rewrite_chapter: (a) => (a?.chapter_no ? `重写第 ${a.chapter_no} 章` : "重写章节"),
  update_continuity: (a) => (a?.entity ? `更新设定记忆 · ${a.entity}` : "更新设定记忆"),
  update_outline: () => "更新写作计划",
  queue_chapters: () => "排队写作指令",
  update_settings: () => "更新项目设置",
  export_book: (a) => `导出成书（${a?.format ?? "md"}）`,
  archive_project: (a) => (a?.archived === false || a?.archived === "false" ? "解除归档" : "归档项目"),
  start_run: () => "启动写作任务",
  pause_run: () => "暂停写作任务",
  resolve_failure: (a) => (a?.command ? `处理故障（${a.command}）` : "处理故障")
};

export function toolLabel(tool, argsSummary) {
  const fn = LABELS[tool];
  if (!fn) return `工具 ${tool}`;
  return fn(parseArgsSummary(argsSummary));
}

const SOURCE_LABELS = {
  read_chapter: (a) => ({ label: a?.chapter_no ? `第 ${a.chapter_no} 章` : "章节", chapterNo: a?.chapter_no ?? null }),
  read_continuity: () => ({ label: "设定记忆", chapterNo: null }),
  read_outline: () => ({ label: "大纲", chapterNo: null }),
  search_text: () => ({ label: "全文搜索", chapterNo: null }),
  get_status: () => ({ label: "项目状态", chapterNo: null }),
  get_cost: () => ({ label: "成本台账", chapterNo: null })
};

export function toolSourceChip(tool, argsSummary) {
  const fn = SOURCE_LABELS[tool];
  if (!fn) return null;
  return fn(parseArgsSummary(argsSummary));
}
```

- [ ] **Step 6.4: 跑测试确认通过**

Run: `node --test tests/tool-labels.test.mjs`
Expected: 全 pass

- [ ] **Step 6.5: Commit**

```bash
git add src/app-shell/tool-labels.mjs tests/tool-labels.test.mjs
git commit -m "feat(s4.5): humanized tool labels with truncated-args salvage"
```

---

### Task 7: `chat-derive.mjs` —— 溯源与情境建议（D1/C2 逻辑层）

**Files:**
- Create: `src/app-shell/chat-derive.mjs`
- Test: `tests/chat-derive.test.mjs`

- [ ] **Step 7.1: 写失败测试**（完整文件）：

```js
// tests/chat-derive.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { deriveSources, deriveSuggestions } from "../src/app-shell/chat-derive.mjs";

const msgs = [
  { id: "u1", role: "user", content: "早些的问题" },
  { id: "t0", role: "tool", tool: "read_outline", ok: true, args: "{}", result_summary: "old" },
  { id: "a1", role: "assistant", content: "早些的回答" },
  { id: "u2", role: "user", content: "主角第3章干了什么？" },
  { id: "t1", role: "tool", tool: "read_chapter", ok: true, args: '{"chapter_no":3}', result_summary: '{"words":1200}' },
  { id: "t2", role: "tool", tool: "read_continuity", ok: true, args: "{}", result_summary: "{}" },
  { id: "t3", role: "tool", tool: "read_chapter", ok: true, args: '{"chapter_no":3}', result_summary: "{}" },
  { id: "t4", role: "tool", tool: "edit_chapter", ok: true, args: '{"chapter_no":3}', result_summary: "{}" },
  { id: "t5", role: "tool", tool: "get_status", ok: false, args: "{}", result_summary: "err" },
  { id: "a2", role: "assistant", content: "他点了灯。" }
];

test("deriveSources：窗口=上一条 user 之后；只取 ok 的 read 工具；按 label 去重", () => {
  const chips = deriveSources(msgs, msgs.at(-1));
  assert.deepEqual(chips.map((c) => c.label), ["第 3 章", "设定记忆"]);
  assert.equal(chips[0].chapterNo, 3);
  assert.equal(chips[0].resultSummary, '{"words":1200}');
});

test("deriveSources：找不到消息时返回 []", () => {
  assert.deepEqual(deriveSources(msgs, { id: "nope" }), []);
  assert.deepEqual(deriveSources(msgs, null), []);
});

test("deriveSources：a1 的窗口只含 u1 之后的 read_outline", () => {
  const chips = deriveSources(msgs, msgs[2]);
  assert.deepEqual(chips.map((c) => c.label), ["大纲"]);
});

test("deriveSuggestions：归档项目", () => {
  const s = deriveSuggestions({ project: { archived_at: "2026-06-01" }, summary: {}, chapters: [] });
  assert.deepEqual(s.map((x) => x.label), ["导出成书", "解除归档"]);
});

test("deriveSuggestions：有待修订章节", () => {
  const s = deriveSuggestions({
    project: {}, summary: { completedChapters: 4, targetChapters: 10 },
    chapters: [{ chapter_no: 3, status: "needs_revision" }]
  });
  assert.equal(s[0].label, "处理第 3 章的待修订");
  assert.equal(s.length, 3);
});

test("deriveSuggestions：全部完成", () => {
  const s = deriveSuggestions({ project: {}, summary: { completedChapters: 10, targetChapters: 10 }, chapters: [] });
  assert.deepEqual(s.map((x) => x.label), ["导出成书", "把目标章节数提高 10 章再续写"]);
});

test("deriveSuggestions：写作中段", () => {
  const s = deriveSuggestions({ project: {}, summary: { completedChapters: 4, targetChapters: 10 }, chapters: [] });
  assert.deepEqual(s.map((x) => x.label), ["续写下一章（第 5 章）", "回顾第 4 章的结尾", "目前花了多少钱？"]);
});

test("deriveSuggestions：新项目", () => {
  const s = deriveSuggestions({ project: {}, summary: { completedChapters: 0, targetChapters: 10 }, chapters: [] });
  assert.deepEqual(s.map((x) => x.label), ["排 5 章试写", "这本书的设定是什么？", "帮我完善大纲"]);
});

test("deriveSuggestions：message 默认等于 label，可直接发送", () => {
  const s = deriveSuggestions({ project: {}, summary: {}, chapters: [] });
  for (const item of s) assert.equal(typeof item.message, "string");
});
```

- [ ] **Step 7.2: 跑测试确认失败**

Run: `node --test tests/chat-derive.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 7.3: 实现**（完整文件）：

```js
// src/app-shell/chat-derive.mjs
// 对话派生逻辑（纯函数、无 DOM）：
// - deriveSources: assistant 回答的依据 chips，从"上一条 user 之后的 ok read 工具消息"推导（证据制，不靠模型自述）。
// - deriveSuggestions: 空态建议按项目状态情境化，5 类互斥分支。
import { READ_TOOLS, toolSourceChip } from "./tool-labels.mjs";

export function deriveSources(messages, assistantMessage) {
  const list = Array.isArray(messages) ? messages : [];
  if (!assistantMessage?.id) return [];
  const idx = list.findIndex((m) => m?.id === assistantMessage.id);
  if (idx < 0) return [];
  let start = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (list[i]?.role === "user") { start = i + 1; break; }
  }
  const chips = [];
  const seen = new Set();
  for (let i = start; i < idx; i += 1) {
    const m = list[i];
    if (m?.role !== "tool" || m.ok === false || !READ_TOOLS.has(m.tool)) continue;
    const chip = toolSourceChip(m.tool, m.args);
    if (!chip || seen.has(chip.label)) continue;
    seen.add(chip.label);
    chips.push({ ...chip, resultSummary: m.result_summary ?? "" });
  }
  return chips;
}

export function deriveSuggestions(data) {
  const project = data?.project ?? {};
  const summary = data?.summary ?? {};
  const chapters = data?.chapters ?? [];
  if (project.archived_at) {
    return [item("导出成书"), item("解除归档")];
  }
  const needsRevision = chapters.find((c) => c?.status === "needs_revision");
  if (needsRevision) {
    return [item(`处理第 ${needsRevision.chapter_no} 章的待修订`), item("这本书的设定是什么？"), item("目前花了多少钱？")];
  }
  const done = Number(summary.completedChapters ?? 0);
  const target = Number(summary.targetChapters ?? 0);
  if (target > 0 && done >= target) {
    return [item("导出成书"), item("把目标章节数提高 10 章再续写")];
  }
  if (done >= 1) {
    return [item(`续写下一章（第 ${done + 1} 章）`), item(`回顾第 ${done} 章的结尾`), item("目前花了多少钱？")];
  }
  return [item("排 5 章试写"), item("这本书的设定是什么？"), item("帮我完善大纲")];
}

function item(label, message = label) {
  return { label, message };
}
```

- [ ] **Step 7.4: 跑测试确认通过**

Run: `node --test tests/chat-derive.test.mjs`
Expected: 全 pass

- [ ] **Step 7.5: Commit**

```bash
git add src/app-shell/chat-derive.mjs tests/chat-derive.test.mjs
git commit -m "feat(s4.5): chat-derive - evidence-based source chips and contextual suggestions"
```

---

### Task 8: 段落 diff（B2 逻辑层）

**Files:**
- Modify: `src/app-shell/diff-view.js`
- Test: `tests/diff-view.test.mjs`（追加）

- [ ] **Step 8.1: 追加失败测试**——`tests/diff-view.test.mjs` 末尾追加（确认顶部 import 含 `diffParagraphs, summarizeDiff`，没有则补）：

```js
// ===== S4.5: 段落级 diff =====
test("diffParagraphs：按空行分段做 LCS", () => {
  const before = "甲段。\n\n乙段。\n\n丙段。";
  const after = "甲段。\n\n乙段改。\n\n丙段。";
  assert.deepEqual(diffParagraphs(before, after), [
    { type: "keep", text: "甲段。" },
    { type: "del", text: "乙段。" },
    { type: "add", text: "乙段改。" },
    { type: "keep", text: "丙段。" }
  ]);
});

test("diffParagraphs：纯新增与纯删除", () => {
  assert.deepEqual(diffParagraphs("", "新段。"), [{ type: "add", text: "新段。" }]);
  assert.deepEqual(diffParagraphs("旧段。", ""), [{ type: "del", text: "旧段。" }]);
});

test("summarizeDiff：改动段数取 del/add 较大者，字数去空白", () => {
  const rows = [
    { type: "keep", text: "甲" },
    { type: "del", text: "乙段。" },
    { type: "add", text: "乙段改了。" },
    { type: "add", text: "丁段 新增。" }
  ];
  assert.deepEqual(summarizeDiff(rows), { changedParagraphs: 2, addedChars: 10, removedChars: 3 });
});
```

- [ ] **Step 8.2: 跑测试确认失败**

Run: `node --test tests/diff-view.test.mjs`
Expected: 新增 3 例 FAIL（函数未导出）

- [ ] **Step 8.3: 实现**——`diff-view.js` 末尾追加：

```js
function splitParagraphs(text) {
  return String(text ?? "").split(/\n{2,}/u).map((p) => p.trim()).filter(Boolean);
}

/**
 * Paragraph-level LCS diff. Same row shape as diffLines.
 */
export function diffParagraphs(before, after) {
  const a = splitParagraphs(before);
  const b = splitParagraphs(after);
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: "keep", text: a[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i] }); i += 1; }
    else { out.push({ type: "add", text: b[j] }); j += 1; }
  }
  while (i < m) { out.push({ type: "del", text: a[i] }); i += 1; }
  while (j < n) { out.push({ type: "add", text: b[j] }); j += 1; }
  return out;
}

export function summarizeDiff(rows) {
  let del = 0, add = 0, addedChars = 0, removedChars = 0;
  for (const row of rows ?? []) {
    if (row.type === "del") { del += 1; removedChars += row.text.replace(/\s+/gu, "").length; }
    if (row.type === "add") { add += 1; addedChars += row.text.replace(/\s+/gu, "").length; }
  }
  return { changedParagraphs: Math.max(del, add), addedChars, removedChars };
}

/**
 * 段落对照视图：摘要行 + 删红/增绿段（衬线、peek）+ 未变段折叠。
 */
export function renderParagraphDiff(before, after) {
  const rows = diffParagraphs(before, after);
  const stats = summarizeDiff(rows);
  const wrap = document.createElement("div");
  wrap.className = "para-diff";
  const summary = document.createElement("div");
  summary.className = "para-diff-summary";
  summary.textContent = `改动 ${stats.changedParagraphs} 段 · −${stats.removedChars} 字 / +${stats.addedChars} 字`;
  wrap.append(summary);
  let keepCount = 0;
  const flushKeep = () => {
    if (keepCount === 0) return;
    const fold = document.createElement("div");
    fold.className = "para-diff-fold";
    fold.textContent = `…未改动的 ${keepCount} 段…`;
    wrap.append(fold);
    keepCount = 0;
  };
  for (const row of rows) {
    if (row.type === "keep") { keepCount += 1; continue; }
    flushKeep();
    const p = document.createElement("div");
    p.className = `para-diff-para para-diff-${row.type} peek`;
    p.textContent = row.text;
    wrap.append(p);
  }
  flushKeep();
  return wrap;
}
```

- [ ] **Step 8.4: 跑测试确认通过**

Run: `node --test tests/diff-view.test.mjs`
Expected: 全 pass（含既有行级用例）

- [ ] **Step 8.5: Commit**

```bash
git add src/app-shell/diff-view.js tests/diff-view.test.mjs
git commit -m "feat(s4.5): paragraph-level diff with change summary and fold"
```

---

### Task 9: thread-renderer 渲染大集成（A3/B1/D1/D2 前端 + I1/I4/I5/I6）

**Files:**
- Modify: `src/app-shell/thread-renderer.js`
- Modify: `src/app-shell/styles.css`（末尾追加分区）

无新单测（DOM 层）；验证靠 Step 9.7 的手动启动 + Task 17 探针。

- [ ] **Step 9.1: import 与 escape 统一（I1）**——文件顶部：

(a) import 区追加：

```js
import { renderMarkdown, escapeHtml } from "./markdown-lite.mjs";
import { toolLabel } from "./tool-labels.mjs";
import { deriveSources } from "./chat-derive.mjs";
```

(b) 删除本地 `function escape(text) { ... }` 整个函数（S3 区块里那个）。它的唯一调用点在 `renderAssistantText` 内，该函数将在 Step 9.2 整体删除，因此不需要改写任何调用。

- [ ] **Step 9.2: assistant 文本渲染换引擎**——删除整个 `renderAssistantText` 函数；`renderAssistantBubble` 中 `body.innerHTML = renderAssistantText(message.content ?? "");` 改为：

```js
    body.innerHTML = renderMarkdown(message.content ?? "");
```

- [ ] **Step 9.3: assistant 气泡加溯源 chips（D1）**——`renderAssistantBubble(message)` 改签名为 `renderAssistantBubble(message, allMessages)`，并在 `bubble.append(body);` 之后、cost 段之前插入：

```js
    const sources = deriveSources(allMessages ?? [], message);
    if (sources.length > 0) {
      const row = document.createElement("div");
      row.className = "chat-sources";
      const tag = document.createElement("span");
      tag.className = "chat-sources-tag";
      tag.textContent = "依据";
      row.append(tag);
      for (const chip of sources) {
        if (chip.chapterNo) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "chat-source-chip chat-source-chip--link";
          btn.dataset.testid = "chat-source-chapter";
          btn.textContent = chip.label;
          btn.title = chip.resultSummary;
          btn.addEventListener("click", () => ctx.openReader(chip.chapterNo));
          row.append(btn);
        } else {
          const span = document.createElement("span");
          span.className = "chat-source-chip";
          span.textContent = chip.label;
          span.title = chip.resultSummary;
          row.append(span);
        }
      }
      bubble.append(row);
    }
```

- [ ] **Step 9.4: 工具卡人话化（D2）**——整体替换 `renderToolCard`：

```js
  function renderToolCard(message) {
    const wrap = document.createElement("div");
    wrap.className = "msg-agent rise chat-bubble-wrap chat-bubble-wrap--tool";
    wrap.dataset.ts = message.ts ?? "";
    const card = document.createElement("details");
    card.className = "chat-tool-card";
    const summary = document.createElement("summary");
    const ok = message.ok !== false;
    const label = document.createElement("span");
    label.className = "chat-tool-label";
    label.textContent = toolLabel(message.tool ?? "", message.args);
    const mark = document.createElement("span");
    mark.className = `chat-tool-mark ${ok ? "ok" : "fail"}`;
    mark.textContent = ok ? "✓" : "✗";
    summary.append(label, mark);
    card.append(summary);
    const tech = document.createElement("div");
    tech.className = "chat-tool-tech mono";
    tech.textContent = `${message.tool ?? ""} ${message.args ?? ""}`.trim();
    card.append(tech);
    const pre = document.createElement("pre");
    pre.textContent = message.result_summary ?? "";
    card.append(pre);
    if (message.error) {
      const err = document.createElement("div");
      err.className = "chat-tool-error";
      err.textContent = message.error;
      card.append(err);
    }
    wrap.append(card);
    return wrap;
  }
```

- [ ] **Step 9.5: 路由签名贯通 + 贴底/播报（I4）**——

(a) `renderChatMessage(message)` 改为：

```js
  function renderChatMessage(message, allMessages) {
    if (!message) return null;
    if (message.role === "user") return renderUserBubble(message);
    if (message.role === "assistant") return renderAssistantBubble(message, allMessages);
    if (message.role === "tool") return renderToolCard(message);
    return null;
  }
```

(b) `syncChatThread(history)` 的消息循环整体替换为（增加贴底、乐观气泡清理、assistant 播报）：

```js
    const wrap = ctx.refs.threadWrap;
    const stick = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    let appended = false;
    for (const message of messages) {
      const key = message.id ? `chat:${message.id}` : `chat:${message.role}:${message.ts}:${message.tool ?? ""}`;
      if (ctx.renderedKeys.has(key)) continue;
      const node = renderChatMessage(message, messages);
      if (!node) continue;
      ctx.renderedKeys.add(key);
      insertByTs(ctx.refs.thread, node, message.ts);
      appended = true;
      if (message.role === "user") {
        // 持久化的 user 消息上屏后，移除 composer 的乐观气泡，防止重影。
        ctx.refs.thread.querySelector('[data-optimistic="user"]')?.remove();
      }
      if (message.role === "assistant") {
        ctx.announce("智能体已回复");
      }
    }
    if (appended && stick) scrollThreadToBottom();
```

- [ ] **Step 9.6: styles.css 末尾追加分区**：

```css
/* ============================================================
   S4.5 Task 9 · markdown / 稿块 / 工具卡 / 溯源 chips / 气泡可读性
   ============================================================ */
/* I6: assistant 气泡是密集阅读面，略升字号行高与宽度 */
.chat-bubble--assistant { max-width: 86%; font-size: 14px; line-height: 1.7; }

.chat-bubble-content h4 { font-size: 14.5px; font-weight: 700; margin: 10px 0 4px; }
.chat-bubble-content h5 { font-size: 13.5px; font-weight: 650; margin: 8px 0 3px; color: var(--ink-2); }
.chat-bubble-content ul, .chat-bubble-content ol { margin: 4px 0 8px; padding-left: 1.4em; }
.chat-bubble-content ul { list-style: disc; }
.chat-bubble-content ol { list-style: decimal; }
.chat-bubble-content li { margin: 2px 0; }
.chat-bubble-content blockquote {
  margin: 6px 0; padding: 4px 12px; border-left: 3px solid var(--line);
  color: var(--muted); background: var(--surface-3); border-radius: 0 var(--r-sm) var(--r-sm) 0;
}
.chat-bubble-content hr { border: none; border-top: 1px solid var(--line-2); margin: 10px 0; }
.md-fence {
  background: var(--surface-3); border: 1px solid var(--line-2); border-radius: var(--r-sm);
  padding: 8px 10px; overflow: auto; font-family: var(--mono); font-size: 12px; line-height: 1.6;
  margin: 6px 0;
}

/* B1 稿块：与 .reader-body 同源的文稿质感 */
.manuscript-block {
  position: relative; margin: 8px 0; padding: 14px 16px 26px;
  background: var(--surface-2); border: 1px solid var(--line-2); border-radius: var(--r);
  font-family: "Georgia", "Songti SC", serif; font-size: 15.5px; line-height: 1.95; color: var(--ink-2);
}
.manuscript-block p { margin: 0 0 1em; text-indent: 2em; text-wrap: pretty; }
.manuscript-block p:last-of-type { margin-bottom: 0; }
.manuscript-words {
  position: absolute; right: 12px; bottom: 6px;
  font-family: var(--mono); font-size: 10.5px; color: var(--faint);
}

/* D1 溯源 chips */
.chat-sources { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.chat-sources-tag { font-size: 10.5px; color: var(--faint); letter-spacing: .04em; }
.chat-source-chip {
  font-size: 11px; padding: 2px 8px; border-radius: 99px;
  background: var(--surface-3); border: 1px solid var(--line-2); color: var(--muted);
}
.chat-source-chip--link { cursor: pointer; color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
.chat-source-chip--link:hover { box-shadow: var(--shadow-xs); }

/* D2 工具卡 */
.chat-tool-card summary { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.chat-tool-label { font-size: 12.5px; color: var(--ink-2); }
.chat-tool-mark.ok { color: var(--green); }
.chat-tool-mark.fail { color: var(--red); }
.chat-tool-tech { font-size: 11px; color: var(--faint); margin: 6px 0 2px; word-break: break-all; }
```

- [ ] **Step 9.7: 手动验证**

Run: `npm run app:shell`（后台），浏览器开 `http://127.0.0.1:4173`，开任一项目确认：旧消息正常渲染、工具卡显示人话、无 console 报错。完成后停掉。
Run: `npm test`
Expected: 全 pass

- [ ] **Step 9.8: Commit**

```bash
git add src/app-shell/thread-renderer.js src/app-shell/styles.css
git commit -m "feat(s4.5): markdown bubbles, manuscript blocks, humanized tool cards, source chips"
```

---

### Task 10: 确认卡段落视图 + 行级切换（B2 前端）

**Files:**
- Modify: `src/app-shell/thread-renderer.js`
- Modify: `src/app-shell/styles.css`

- [ ] **Step 10.1**：thread-renderer 顶部 `import { renderDiff } from "./diff-view.js";` 改为：

```js
import { renderDiff, renderParagraphDiff } from "./diff-view.js";
```

- [ ] **Step 10.2**：`renderConfirmCard` 中 `if (pendingAction?.tool === "edit_chapter") { card.append(renderDiff(...)); }` 分支整体替换为：

```js
      if (pendingAction?.tool === "edit_chapter") {
        const diffWrap = document.createElement("div");
        diffWrap.className = "chat-confirm-diffwrap";
        const paraView = renderParagraphDiff(preview.before ?? "", preview.after ?? "");
        const lineView = renderDiff(preview.before ?? "", preview.after ?? "");
        lineView.hidden = true;
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "chat-diff-toggle";
        toggle.dataset.testid = "chat-diff-toggle";
        toggle.textContent = "行级详细";
        toggle.setAttribute("aria-pressed", "false");
        toggle.addEventListener("click", () => {
          const showLine = lineView.hidden;
          lineView.hidden = !showLine;
          paraView.hidden = showLine;
          toggle.textContent = showLine ? "段落对照" : "行级详细";
          toggle.setAttribute("aria-pressed", showLine ? "true" : "false");
        });
        diffWrap.append(paraView, lineView, toggle);
        card.append(diffWrap);
      } else {
```

（`else` 接原非 edit_chapter 的 before/after 分支，原样保留；给其中 `chat-confirm-before`/`chat-confirm-after` 两个 div 各追加一个 class `manuscript-text peek`。）

- [ ] **Step 10.3: styles.css 追加**：

```css
/* ============================================================
   S4.5 Task 10 · 确认卡段落对照
   ============================================================ */
.para-diff { display: grid; gap: 6px; margin: 8px 0; }
.para-diff-summary { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.para-diff-para {
  font-family: "Georgia", "Songti SC", serif; font-size: 14.5px; line-height: 1.85;
  padding: 8px 12px; border-radius: var(--r-sm); text-indent: 2em; text-wrap: pretty;
}
.para-diff-del { background: var(--red-soft); color: var(--red); text-decoration: line-through; text-decoration-thickness: 1px; }
.para-diff-add { background: var(--green-soft); color: var(--green); }
.para-diff-fold { font-size: 11px; color: var(--faint); text-align: center; padding: 2px 0; }
.chat-diff-toggle {
  justify-self: start; font-size: 11px; padding: 3px 10px; margin-top: 2px;
  border: 1px solid var(--line); border-radius: 99px; background: var(--surface); color: var(--muted);
}
.chat-diff-toggle:hover { background: var(--hover); }
.manuscript-text { font-family: "Georgia", "Songti SC", serif; line-height: 1.85; }
```

- [ ] **Step 10.4**：`npm test` 全 pass；commit：

```bash
git add src/app-shell/thread-renderer.js src/app-shell/styles.css
git commit -m "feat(s4.5): confirm card paragraph view with line-level toggle"
```

---

### Task 11: 活动占位 + busy 轮询 + 停止按钮（A1/A2 前端 + I3）

**Files:**
- Modify: `src/app-shell/composer.js`
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`

**载荷事实（执行前确认，不要破坏）**：busy 期间轮询能拿到增量数据，是因为 `/api/dashboard`、`/api/chat/history`、`/api/queue/state` 都不取项目锁，而 `/api/chat/send` 在锁内同步跑完循环、tool 消息逐条落盘 `chat_history.jsonl`。若任何改动让这些 GET 端点进锁，过程流会整体卡死到回合结束——见全局禁止事项。

- [ ] **Step 11.1: composer.js import 更新**——顶部：

```js
import { postJson, sendChatMessage, stopChat } from "./api-client.js";
import { toolLabel } from "./tool-labels.mjs";
```

- [ ] **Step 11.2: 活动占位管理器**——在 `createComposer` 函数体内（`let slashActiveIndex = 0;` 之后）插入：

```js
  // --- S4.5 活动占位：chat busy 期间的过程反馈 + 停止 ---
  let activePlaceholder = null;   // { wrap, say, stop, dispose, setActivity }
  let localSendInFlight = false;  // 本地 send 未返回时不让轮询提前撤占位
  let latestActivity = "";

  function isChatBusy() {
    return localSendInFlight || Boolean(activePlaceholder);
  }

  function showActivityPlaceholder() {
    if (activePlaceholder) return activePlaceholder;
    const wrap = document.createElement("div");
    wrap.className = "msg-agent rise chat-bubble-wrap chat-thinking";
    wrap.dataset.testid = "chat-activity-placeholder";
    const avatar = document.createElement("div");
    avatar.className = "agent-avatar";
    avatar.textContent = "W";
    const body = document.createElement("div");
    body.className = "agent-body";
    const row = document.createElement("div");
    row.className = "chat-activity-row";
    const say = document.createElement("p");
    say.className = "agent-say chat-activity-text";
    say.textContent = "思考中…";
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "chat-stop-btn";
    stop.dataset.testid = "chat-stop";
    stop.setAttribute("aria-label", "停止本轮对话");
    stop.textContent = "停止";
    stop.addEventListener("click", async () => {
      stop.disabled = true;
      try {
        await stopChat();
      } catch (error) {
        stop.disabled = false;
        ctx.showToast(error.message ?? "停止失败。", "error");
      }
    });
    row.append(say, stop);
    body.append(row);
    wrap.append(avatar, body);
    ctx.refs.thread.append(wrap);
    ctx.threadRenderer.scrollThreadToBottom();
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      say.textContent = `${latestActivity || "思考中"} · 已 ${secs} 秒`;
    }, 1000);
    activePlaceholder = {
      wrap, say, stop,
      setActivity: (text) => { latestActivity = text; },
      dispose: () => { window.clearInterval(timer); wrap.remove(); }
    };
    return activePlaceholder;
  }

  function removeActivityPlaceholder() {
    activePlaceholder?.dispose();
    activePlaceholder = null;
    latestActivity = "";
  }

  // renderDashboard 每拍调用：busy 驱动占位生命周期 + 回显最新工具活动。
  function syncChatBusy(data) {
    const busy = data?.chatHistory?.busy === true;
    if (busy && !activePlaceholder) showActivityPlaceholder(); // 确认卡续轮 / 他窗口在跑
    if (!busy && activePlaceholder && !localSendInFlight) removeActivityPlaceholder();
    if (activePlaceholder) {
      const msgs = data?.chatHistory?.messages ?? [];
      const lastTool = [...msgs].reverse().find((m) => m.role === "tool");
      if (lastTool) activePlaceholder.setActivity(`${toolLabel(lastTool.tool, lastTool.args)}，继续思考`);
    }
  }
```

- [ ] **Step 11.3: `sendChatMessageWithUX` 整体替换**（I3：乐观气泡复用 threadRenderer）：

```js
  async function sendChatMessageWithUX(message) {
    // 入口忙态守卫：双击建议卡/快捷 chip/重试按钮不应打出 409 噪音（服务端守卫仍是兜底）。
    if (isChatBusy()) {
      ctx.showToast("智能体正在处理上一条消息，请稍候或点停止。", "info");
      return;
    }
    const savedContent = message;
    ctx.refs.composerSubmit.disabled = true;
    ctx.refs.composerSubmit.setAttribute("aria-busy", "true");

    // 1. 立即清空输入框
    ctx.refs.composerInput.value = "";
    autoGrowComposer();
    updateSubmitState();

    // 2. 乐观用户气泡（复用 thread-renderer 的渲染器；轮询渲出持久化消息后会被自动清理）
    const userBubble = ctx.threadRenderer.renderChatMessage({
      role: "user", content: message, ts: new Date().toISOString()
    });
    userBubble.dataset.optimistic = "user";
    ctx.refs.thread.append(userBubble);

    // 3. 活动占位 + 立刻开启忙时轮询（过程流靠它）
    localSendInFlight = true;
    showActivityPlaceholder();
    ctx.ensureRefreshLoop(true);

    try {
      const result = await sendChatMessage(message);
      localSendInFlight = false;
      removeActivityPlaceholder();
      if (userBubble.isConnected) userBubble.remove();
      if (result?.cancelled) ctx.showToast("本轮已停止。", "info");
      if (typeof ctx.loadDashboard === "function") {
        await ctx.loadDashboard();
      }
    } catch (error) {
      localSendInFlight = false;
      removeActivityPlaceholder();
      if (userBubble.isConnected) userBubble.remove();

      const errorBubble = document.createElement("div");
      errorBubble.className = "msg-agent rise chat-bubble-wrap";
      const errorAvatar = document.createElement("div");
      errorAvatar.className = "agent-avatar";
      errorAvatar.textContent = "W";
      const errorBody = document.createElement("div");
      errorBody.className = "agent-body";
      const errorSay = document.createElement("p");
      errorSay.className = "agent-say";
      errorSay.textContent = `发送失败：${error.message}`;
      errorBody.append(errorSay);
      errorBubble.append(errorAvatar, errorBody);
      ctx.refs.thread.append(errorBubble);
      ctx.threadRenderer.scrollThreadToBottom();

      ctx.refs.composerInput.value = savedContent;
      autoGrowComposer();
      ctx.showActionError?.(error);
    } finally {
      ctx.refs.composerSubmit.removeAttribute("aria-busy");
      updateSubmitState();
    }
  }
```

- [ ] **Step 11.4: 导出**——`createComposer` 的 `return { ... }` 追加 `syncChatBusy, isChatBusy,`。

- [ ] **Step 11.5: app.js 接线**——

(a) `renderDashboard` 内 `ensureRefreshLoop(truth.refresh || summary.projectStatus === "running" || Boolean(liveBlock && !liveBlock.done));` 替换为：

```js
  ensureRefreshLoop(
    truth.refresh
    || summary.projectStatus === "running"
    || Boolean(liveBlock && !liveBlock.done)
    || data.chatHistory?.busy === true
  );
```

(b) 两个分支里 `composer.updateStatusPills(data);` 之后各加一行 `composer.syncChatBusy(data);`（hasProject 分支与 no-project 分支共 2 处）。

(c) threadRenderer ctx（`createThreadRenderer({...})` 调用处）追加一行：

```js
  isChatBusy: () => composer?.isChatBusy?.() === true,
```

- [ ] **Step 11.6: styles.css 追加**：

```css
/* ============================================================
   S4.5 Task 11 · 活动占位与停止
   ============================================================ */
.chat-activity-row { display: flex; align-items: center; gap: 10px; }
.chat-activity-text { min-width: 0; }
.chat-stop-btn {
  flex: none; font-size: 11px; padding: 3px 10px; border-radius: 99px;
  border: 1px solid var(--red); color: var(--red); background: var(--red-soft);
}
.chat-stop-btn:hover { filter: brightness(0.97); }
.chat-stop-btn:disabled { opacity: .5; cursor: default; }
```

- [ ] **Step 11.7: 手动验证**：`npm run app:shell` 后浏览器发一条消息（mock 模型即时回），确认乐观气泡→历史替换无重影、占位出现又消失、无 console 报错。`npm test` 全 pass。

- [ ] **Step 11.8: Commit**

```bash
git add src/app-shell/composer.js src/app-shell/app.js src/app-shell/styles.css
git commit -m "feat(s4.5): activity placeholder with elapsed timer, busy polling, inline stop"
```

---

### Task 12: 消息操作排——复制/重发/重试（A4 前半）

**Files:**
- Modify: `src/app-shell/thread-renderer.js`
- Modify: `src/app-shell/styles.css`

- [ ] **Step 12.1: 操作排构造器**——thread-renderer 的 S3 区块内（`renderUserBubble` 之前）插入：

```js
  // 气泡操作排：复制 / 重新发送（user）/ 重试本轮（assistant，仅最后一条显示，见 syncChatThread 收尾）。
  function buildMsgActions(message, allMessages) {
    const bar = document.createElement("div");
    bar.className = "msg-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "msg-action";
    copy.dataset.testid = "msg-copy";
    copy.textContent = "复制";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(message.content ?? "");
        ctx.showToast("已复制。", "info");
      } catch {
        ctx.showToast("复制失败：剪贴板不可用。", "error");
      }
    });
    bar.append(copy);
    if (message.role === "user") {
      const resend = document.createElement("button");
      resend.type = "button";
      resend.className = "msg-action";
      resend.dataset.testid = "msg-resend";
      resend.textContent = "重新发送";
      resend.addEventListener("click", () => {
        if (ctx.isChatBusy?.()) return;
        ctx.sendChatMessageWithUX?.(message.content ?? "");
      });
      bar.append(resend);
    }
    if (message.role === "assistant") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "msg-action";
      retry.dataset.testid = "msg-retry";
      retry.hidden = true; // syncChatThread 收尾只放开最后一条 assistant 的
      retry.textContent = "重试本轮";
      retry.addEventListener("click", () => {
        if (ctx.isChatBusy?.()) return;
        const msgs = allMessages ?? [];
        const idx = msgs.findIndex((m) => m?.id === message.id);
        for (let i = (idx < 0 ? msgs.length : idx) - 1; i >= 0; i -= 1) {
          if (msgs[i]?.role === "user") {
            ctx.sendChatMessageWithUX?.(msgs[i].content ?? "");
            return;
          }
        }
        ctx.showToast("没有可重试的消息。", "info");
      });
      bar.append(retry);
    }
    return bar;
  }
```

- [ ] **Step 12.2: 挂到气泡**——

(a) `renderUserBubble(message)` 中 `wrap.append(bubble);` 之前插入 `bubble.append(buildMsgActions(message));`
(b) `renderAssistantBubble(message, allMessages)` 中 `wrap.append(bubble);` 之前插入 `bubble.append(buildMsgActions(message, allMessages));`

- [ ] **Step 12.3: 「仅最后一条 assistant 显示重试」**——Step 9.5(b) 的循环之后（`if (appended && stick) ...` 之前）插入：

```js
    const retryButtons = ctx.refs.thread.querySelectorAll('[data-testid="msg-retry"]');
    retryButtons.forEach((btn, i) => { btn.hidden = i !== retryButtons.length - 1; });
```

- [ ] **Step 12.4: styles.css 追加**（probe 可点性要求：默认低透明而非不可见）：

```css
/* ============================================================
   S4.5 Task 12 · 消息操作排
   ============================================================ */
.msg-actions { display: flex; gap: 6px; margin-top: 6px; opacity: .25; transition: opacity .15s; }
.chat-bubble-wrap:hover .msg-actions,
.chat-bubble-wrap:focus-within .msg-actions { opacity: 1; }
.msg-action {
  font-size: 10.5px; padding: 2px 8px; border-radius: 99px;
  border: 1px solid var(--line); background: var(--surface); color: var(--muted);
}
.msg-action:hover { background: var(--hover); color: var(--ink-2); }
.chat-bubble--user .msg-action { background: rgba(255,255,255,.14); border-color: rgba(255,255,255,.3); color: #fff; }
```

- [ ] **Step 12.5**：`npm test` 全 pass；commit：

```bash
git add src/app-shell/thread-renderer.js src/app-shell/styles.css
git commit -m "feat(s4.5): message actions - copy, resend, retry-last-round"
```

---

### Task 13: 阅读器选段引用（A4 后半）

**Files:**
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`

- [ ] **Step 13.1: app.js**——

(a) 模块级状态区（`let createModalMode = "new";` 附近）加：

```js
let readerChapterNo = null;
let readerQuoteBtn = null;
```

(b) `openReader(chapterNo)` 函数第一行加 `readerChapterNo = chapterNo;`
(c) `closeReader()` 改为：

```js
function closeReader() {
  removeReaderQuoteBtn();
  closeOverlay(refs.readerScrim);
}
```

(d) 事件绑定区（`refs.readerClose.addEventListener` 附近）追加：

```js
function removeReaderQuoteBtn() {
  readerQuoteBtn?.remove();
  readerQuoteBtn = null;
}

refs.readerBody.addEventListener("mouseup", () => {
  removeReaderQuoteBtn();
  const selection = window.getSelection();
  const text = String(selection?.toString() ?? "").trim();
  if (!text || !refs.readerScrim.classList.contains("show")) return;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  readerQuoteBtn = document.createElement("button");
  readerQuoteBtn.type = "button";
  readerQuoteBtn.id = "reader-quote-btn";
  readerQuoteBtn.textContent = "问智能体";
  readerQuoteBtn.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
  readerQuoteBtn.style.top = `${Math.round(rect.bottom + 8)}px`;
  readerQuoteBtn.addEventListener("click", () => {
    const snippet = text.slice(0, 500);
    const chapter = readerChapterNo;
    closeReader();
    refs.composerInput.value = `关于第 ${chapter} 章这段：\n> ${snippet}\n`;
    refs.composerInput.focus();
    composer.autoGrowComposer();
    composer.updateSubmitState();
  });
  document.body.append(readerQuoteBtn);
});
refs.readerBody.addEventListener("scroll", removeReaderQuoteBtn);
```

- [ ] **Step 13.2: styles.css 追加**：

```css
/* ============================================================
   S4.5 Task 13 · 阅读器选段引用
   ============================================================ */
#reader-quote-btn {
  position: fixed; z-index: 220; transform: translateX(-50%);
  font-size: 12px; padding: 5px 12px; border-radius: 99px;
  background: var(--btn-gradient); color: #fff; box-shadow: var(--shadow);
}
#reader-quote-btn:hover { filter: brightness(1.1); }
```

- [ ] **Step 13.3**：手动验证（app:shell 开阅读器选一段→按钮浮现→点击→composer 预填且聚焦）；`npm test` 全 pass；commit：

```bash
git add src/app-shell/app.js src/app-shell/styles.css
git commit -m "feat(s4.5): quote selected reader text into composer"
```

---

### Task 14: 阅读器字号/翻章/沉浸（C5）

**Files:**
- Modify: `src/app-shell/index.html`
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`

- [ ] **Step 14.1: index.html**——reader-head 中 `<button class="icon-btn" id="reader-close" ...>` 之前插入：

```html
            <div class="reader-tools">
              <button class="icon-btn" id="reader-font-minus" aria-label="缩小字号" title="缩小字号">A−</button>
              <button class="icon-btn" id="reader-font-plus" aria-label="放大字号" title="放大字号">A＋</button>
              <button class="icon-btn" id="reader-prev" aria-label="上一章" title="上一章（←）">‹</button>
              <button class="icon-btn" id="reader-next" aria-label="下一章" title="下一章（→）">›</button>
              <button class="icon-btn" id="reader-wide" aria-label="沉浸模式" aria-pressed="false" title="沉浸模式">沉浸</button>
            </div>
```

- [ ] **Step 14.2: app.js refs 表追加**（`readerBody:` 行后）：

```js
  readerFontMinus: document.querySelector("#reader-font-minus"),
  readerFontPlus: document.querySelector("#reader-font-plus"),
  readerPrev: document.querySelector("#reader-prev"),
  readerNext: document.querySelector("#reader-next"),
  readerWide: document.querySelector("#reader-wide"),
```

- [ ] **Step 14.3: app.js 逻辑**——`openReader` 函数之前插入：

```js
// 阅读器字号四档（行高随档位），持久化 localStorage。
const READER_FONT_STEPS = [
  { size: 14, lh: 1.9 },
  { size: 15.5, lh: 1.95 },
  { size: 17, lh: 2.0 },
  { size: 19, lh: 2.0 }
];
let readerFontIndex = 1;
try {
  const stored = Number(window.localStorage.getItem("ww:reader:fontsize"));
  if (Number.isInteger(stored) && stored >= 0 && stored < READER_FONT_STEPS.length) readerFontIndex = stored;
} catch { /* localStorage 不可用则用默认档 */ }

function applyReaderFont() {
  const step = READER_FONT_STEPS[readerFontIndex];
  refs.readerBody.style.fontSize = `${step.size}px`;
  refs.readerBody.style.lineHeight = String(step.lh);
  refs.readerFontMinus.disabled = readerFontIndex === 0;
  refs.readerFontPlus.disabled = readerFontIndex === READER_FONT_STEPS.length - 1;
}

function nudgeReaderFont(delta) {
  readerFontIndex = Math.max(0, Math.min(READER_FONT_STEPS.length - 1, readerFontIndex + delta));
  try { window.localStorage.setItem("ww:reader:fontsize", String(readerFontIndex)); } catch { /* 忽略 */ }
  applyReaderFont();
}

function readableChapters() {
  return [...(lastDashboard?.chapters ?? [])]
    .filter((c) => Number(c.actual_words ?? 0) > 0)
    .sort((a, b) => a.chapter_no - b.chapter_no);
}

function updateReaderNav() {
  const list = readableChapters();
  const idx = list.findIndex((c) => c.chapter_no === readerChapterNo);
  refs.readerPrev.disabled = idx <= 0;
  refs.readerNext.disabled = idx < 0 || idx >= list.length - 1;
}

function openAdjacentChapter(delta) {
  const list = readableChapters();
  const idx = list.findIndex((c) => c.chapter_no === readerChapterNo);
  const next = list[idx + delta];
  if (next) void openReader(next.chapter_no);
}
```

- [ ] **Step 14.4: openReader 收尾接线**——`openReader` 内 `openOverlay(refs.readerScrim, refs.readerClose);` 之后插入：

```js
  applyReaderFont();
  updateReaderNav();
```

- [ ] **Step 14.5: 事件绑定**（绑定区追加）：

```js
refs.readerFontMinus.addEventListener("click", () => nudgeReaderFont(-1));
refs.readerFontPlus.addEventListener("click", () => nudgeReaderFont(1));
refs.readerPrev.addEventListener("click", () => openAdjacentChapter(-1));
refs.readerNext.addEventListener("click", () => openAdjacentChapter(1));
refs.readerWide.addEventListener("click", () => {
  const on = !document.querySelector("#reader").classList.contains("reader--wide");
  document.querySelector("#reader").classList.toggle("reader--wide", on);
  refs.readerWide.setAttribute("aria-pressed", on ? "true" : "false");
});
```

并在全局 `document.addEventListener("keydown", ...)` 处理器里、`if (event.key === "Escape")` 之前插入：

```js
  if (refs.readerScrim.classList.contains("show")) {
    if (event.key === "ArrowLeft") { event.preventDefault(); openAdjacentChapter(-1); return; }
    if (event.key === "ArrowRight") { event.preventDefault(); openAdjacentChapter(1); return; }
  }
```

- [ ] **Step 14.6: styles.css 追加**：

```css
/* ============================================================
   S4.5 Task 14 · 阅读器工具排与沉浸模式
   ============================================================ */
.reader-tools { display: flex; align-items: center; gap: 4px; flex: none; }
.reader-tools .icon-btn { font-size: 12px; min-width: 30px; }
.reader-tools .icon-btn:disabled { opacity: .35; cursor: default; }
.reader.reader--wide { width: min(96vw, 1100px); }
.reader--wide .reader-head .path, .reader--wide .reader-head .sub { display: none; }
```

- [ ] **Step 14.7**：手动验证 + `npm test`；commit：

```bash
git add src/app-shell/index.html src/app-shell/app.js src/app-shell/styles.css
git commit -m "feat(s4.5): reader font steps, chapter nav with arrow keys, immersive width"
```

---

### Task 15: 空态情境化 + 字数 pill + Toast 降噪 + 问候更新（C2/B3/C4 + I2/I9/I11）

**Files:**
- Modify: `src/app-shell/thread-renderer.js`
- Modify: `src/app-shell/composer.js`
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`

- [ ] **Step 15.1: 建议卡消费 deriveSuggestions（C2+I9）**——thread-renderer：

(a) import 区把 Task 9 加过的 `deriveSources` 行扩成：

```js
import { deriveSources, deriveSuggestions } from "./chat-derive.mjs";
```

(b) `buildSuggestionCards()` 与 `appendSuggestionCards()` 整体替换：

```js
  function buildSuggestionCards(data) {
    const suggestions = deriveSuggestions(data ?? ctx.getDashboard?.() ?? {});
    const wrap = document.createElement("div");
    wrap.className = "suggestion-cards";
    for (const item of suggestions) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "suggestion-card";
      card.textContent = item.label;
      card.addEventListener("click", () => {
        if (ctx.isChatBusy?.()) return;
        wrap.querySelectorAll(".suggestion-card").forEach((c) => { c.disabled = true; });
        if (typeof ctx.sendChatMessageWithUX === "function") {
          ctx.sendChatMessageWithUX(item.message);
        }
      });
      wrap.append(card);
    }
    return wrap;
  }

  function appendSuggestionCards(data) {
    const cards = buildSuggestionCards(data);
    ctx.refs.thread.append(cards);
    scrollThreadToBottom();
  }
```

- [ ] **Step 15.2: 问候 chat-first（I2）**——`buildGreeting` 中 `say.textContent = currentProjectRoot ? "..." : "...";` 的有项目分支文案替换为：

```js
      ? "我已就绪。直接告诉我你想做什么：写下一章、改一段正文、问设定或进度都行；输入 / 可以唤起命令。"
```

`buildQuickRow(currentProjectRoot ? [...] : [...])` 的有项目数组替换为：

```js
    const quick = buildQuickRow(currentProjectRoot ? ["续写下一章", "这本书的设定是什么？", "目前花了多少钱？"] : ["新建小说"]);
```

并在 `buildQuickRow` 的 chip click 监听里第一行加 `if (ctx.isChatBusy?.()) return;`（I9）。

- [ ] **Step 15.3: 字数 pill（B3）**——composer.js：

(a) `updateStatusPills(data)` 函数体改为：

```js
  function updateStatusPills(data) {
    updateModelPill(data);
    updateWordsPill(data);
    updateCostPill(data);
  }
```

(b) 其后插入：

```js
  // 会话新增字数：每项目记会话基线（内存，重启/切项目即重置——会话语义）。
  const sessionWordBaselines = new Map();

  function updateWordsPill(data) {
    const container = ensureStatusPillContainer();
    if (!container) return;
    let pill = document.getElementById("status-pill-words");
    if (!pill) {
      pill = document.createElement("span");
      pill.id = "status-pill-words";
      pill.className = "cbar-pill cbar-pill--readonly cbar-pill--words";
      pill.title = "本次会话新增字数";
      container.append(pill);
    }
    const root = data?.projectRoot;
    const total = Number(data?.summary?.totalWords ?? 0);
    if (!root) { pill.hidden = true; return; }
    if (!sessionWordBaselines.has(root)) sessionWordBaselines.set(root, total);
    const delta = total - sessionWordBaselines.get(root);
    pill.hidden = delta <= 0;
    if (delta > 0) pill.textContent = `本次 +${delta.toLocaleString("zh-CN")} 字`;
  }
```

- [ ] **Step 15.4: Toast 降噪（C4+I11）**——四个调用点：

(a) composer.js `applyTier` 成功分支：删除 `ctx.showToast(\`已切换到「${tier.short}」档。\`, "success");`，并在 `await ctx.loadDashboard();` **之后**追加（时序关键：loadDashboard 触发 `renderModePill` 重置 `className`，脉冲 class 必须在重渲染之后再加，否则动画被掐断）：

```js
      getModePill()?.classList.add("cbar-pill--pulse");
      window.setTimeout(() => getModePill()?.classList.remove("cbar-pill--pulse"), 400);
```

(b) app.js `openProject`：删除 `showToast("小说已打开。", "success");`
(c) app.js `setPrivacyMode` 整体替换：

```js
function setPrivacyMode(on) {
  applyPrivacyState(on);
  try {
    window.localStorage.setItem("ww:privacy", on ? "on" : "off");
    // 首次开启才弹说明；按钮态与模糊效果本身即时可见。
    if (on && window.localStorage.getItem("ww:privacy:hinted") !== "1") {
      window.localStorage.setItem("ww:privacy:hinted", "1");
      showToast("隐私模式已开启：正文已模糊，鼠标悬停可临时查看。", "info");
    }
  } catch {
    // localStorage 不可用时忽略持久化。
  }
}
```

(d) thread-renderer `cancelQueuedTask`：删除 `ctx.showToast("任务已取消。", "success");`（保留 catch 里的错误 toast 与 `loadDashboard`）。

- [ ] **Step 15.5: styles.css 追加**：

```css
/* ============================================================
   S4.5 Task 15 · 字数 pill 与 mode pill 脉冲
   ============================================================ */
.cbar-pill--words { color: var(--green); border-color: var(--green-line); background: var(--green-soft); }
.cbar-pill--pulse { animation: pillPulse .35s ease; }
@keyframes pillPulse { 0% { transform: scale(1); } 45% { transform: scale(1.08); } 100% { transform: scale(1); } }
@media (prefers-reduced-motion: reduce) {
  .cbar-pill--pulse { animation: none; }
}
```

- [ ] **Step 15.6**：`npm test` 全 pass；commit：

```bash
git add src/app-shell/thread-renderer.js src/app-shell/composer.js src/app-shell/app.js src/app-shell/styles.css
git commit -m "feat(s4.5): contextual suggestions, session words pill, toast denoise, chat-first greeting"
```

---

### Task 16: 快捷键速查浮层（C3 + I8）

**Files:**
- Modify: `src/app-shell/index.html`
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`

- [ ] **Step 16.1: index.html**——

(a) `<!-- 新建/初始化项目弹窗 -->` 区块结束的 `</div>`（即 `create-scrim` 闭合）之后插入：

```html
      <!-- 快捷键速查 -->
      <div class="settings-scrim" id="shortcuts-scrim" inert>
        <div class="shortcuts-card" id="shortcuts-card" role="dialog" aria-modal="true" aria-label="快捷键速查">
          <h2>快捷键</h2>
          <dl class="shortcuts-list">
            <dt>Enter</dt><dd>发送指令</dd>
            <dt>Shift + Enter</dt><dd>换行</dd>
            <dt>/</dt><dd>唤起斜杠命令菜单</dd>
            <dt>Ctrl + .</dt><dd>隐私模式开关</dd>
            <dt>← / →</dt><dd>阅读器内翻章</dd>
            <dt>Esc</dt><dd>关闭弹窗 / 抽屉</dd>
            <dt>?</dt><dd>打开本速查</dd>
          </dl>
          <button class="settings-x icon-btn" id="shortcuts-x" aria-label="关闭"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
      </div>
```

(b) composer-bar 里 `<button class="cbar-btn" id="cbar-slash" ...>命令</button>` 之后插入：

```html
                <button class="cbar-btn" id="cbar-keys" title="快捷键" aria-label="快捷键速查">⌨</button>
```

(c) composer hint（I8）：`<span class="cbar-hint" id="composer-hint">Enter 发送 · Shift+Enter 换行</span>` 改为 `... 换行 · ? 快捷键</span>`。

- [ ] **Step 16.2: app.js**——

(a) refs 表追加：

```js
  shortcutsScrim: document.querySelector("#shortcuts-scrim"),
  shortcutsX: document.querySelector("#shortcuts-x"),
  cbarKeys: document.querySelector("#cbar-keys"),
```

(b) 函数区追加：

```js
function openShortcuts() { openOverlay(refs.shortcutsScrim, refs.shortcutsX); }
function closeShortcuts() { closeOverlay(refs.shortcutsScrim); }

function isEditableTarget(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true;
}
```

(c) 绑定区追加：

```js
refs.cbarKeys.addEventListener("click", () => openShortcuts());
refs.shortcutsX.addEventListener("click", () => closeShortcuts());
refs.shortcutsScrim.addEventListener("click", (event) => {
  if (event.target === refs.shortcutsScrim) closeShortcuts();
});
```

(d) 全局 keydown 处理器：`if (event.key === "Escape")` 分支第一行插入 `if (refs.shortcutsScrim.classList.contains("show")) return closeShortcuts();`；同一处理器里追加（Escape 分支之后）：

```js
  if (event.key === "?" && !isEditableTarget(event.target)) {
    event.preventDefault();
    openShortcuts();
  }
```

(e) trapTab 链整体替换为以下最终形态（shortcuts 永远最后打开，所以判在最前）：

```js
  if (refs.shortcutsScrim.classList.contains("show")) trapTab(refs.shortcutsScrim, event);
  else if (refs.readerScrim.classList.contains("show")) trapTab(refs.readerScrim, event);
  else if (refs.settingsScrim.classList.contains("show")) trapTab(refs.settingsScrim, event);
  else if (refs.createScrim.classList.contains("show")) trapTab(refs.createScrim, event);
  else if (refs.drawer.classList.contains("show")) trapTab(refs.drawer, event);
```

- [ ] **Step 16.3: styles.css 追加**：

```css
/* ============================================================
   S4.5 Task 16 · 快捷键速查
   ============================================================ */
.shortcuts-card {
  position: relative; width: min(420px, 100%);
  border: 1px solid var(--line); border-radius: var(--r-xl);
  background: linear-gradient(180deg, #fff, var(--surface-2));
  padding: 26px 28px 24px; box-shadow: var(--shadow-pop);
}
.shortcuts-card h2 { font-size: 17px; margin-bottom: 14px; }
.shortcuts-list { display: grid; grid-template-columns: auto 1fr; gap: 8px 18px; margin: 0; }
.shortcuts-list dt {
  font-family: var(--mono); font-size: 12px; color: var(--ink-2);
  background: var(--surface-3); border: 1px solid var(--line-2); border-radius: 6px;
  padding: 2px 8px; justify-self: start;
}
.shortcuts-list dd { margin: 0; font-size: 13px; color: var(--muted); align-self: center; }
```

- [ ] **Step 16.4**：手动验证（? 与 ⌨ 都能开、Esc/X/点 scrim 能关、焦点圈住）；`npm test`；commit：

```bash
git add src/app-shell/index.html src/app-shell/app.js src/app-shell/styles.css
git commit -m "feat(s4.5): keyboard shortcuts overlay with ? trigger and composer entry"
```

---

### Task 17: clickability 探针扩展（防线）

**Files:**
- Modify: `scripts/verify-app-clickability.cjs`

- [ ] **Step 17.1: fixture 升级**——`=== S3 chat probes ===` 区块里的 `chat_history.jsonl` 写入替换为（多一条带 args 的 tool 消息和一条旧格式消息，覆盖降级路径；assistant 带稿块）：

```js
  fs.writeFileSync(path.join(projectRoot, "chat_history.jsonl"), [
    JSON.stringify({ id: "chat-user-001", ts: "2026-06-12T01:00:00.000Z", role: "user", content: "你好" }),
    JSON.stringify({ id: "chat-tool-000", ts: "2026-06-12T01:00:01.000Z", role: "tool", tool: "read_chapter", ok: true, result_summary: '{"chapter_no":1}' }),
    JSON.stringify({ id: "chat-tool-001", ts: "2026-06-12T01:00:02.000Z", role: "tool", tool: "read_chapter", ok: true, args: '{"chapter_no":1}', result_summary: '{"chapter_no":1,"words":1200}' }),
    JSON.stringify({ id: "chat-assistant-001", ts: "2026-06-12T01:00:03.000Z", role: "assistant", content: "看一段：\n\n```稿\n夜雨敲窗，他点了灯。\n```\n\n- 要点一\n- 要点二", cost: 0.001 })
  ].join("\n") + "\n");
```

- [ ] **Step 17.2: chat/send mock 改为延迟 800ms**——既有 fetch mock 中 `/api/chat/send` 分支改为延迟响应（制造占位可见窗口）：

```js
        if (url && url.includes('/api/chat/send')) {
          await new Promise((r) => setTimeout(r, 800));
          return new Response(JSON.stringify({ ok: true, reply: "mock", toolEvents: [], pendingAction: null, usage: { calls: 0, cost: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
        }
```

（若现有 mock 形状不同，保持其返回体不变，只加 800ms 延迟。）

- [ ] **Step 17.3: 新探针**——在既有 S4 探针（⑥⑦⑧）之后追加（沿用 `clickAndRead`/`read`/`delay` 既有工具函数）：

```js
  // === S4.5 probes ===
  // ⑨ 稿块 + markdown 列表渲染
  const msBlock = await read(win, `document.querySelectorAll('.manuscript-block').length`);
  assert.ok(msBlock >= 1, "manuscript block must render from ```稿 fence");
  const mdList = await read(win, `document.querySelectorAll('.chat-bubble-content ul li').length`);
  assert.ok(mdList >= 2, "markdown list must render");

  // ⑩ 工具卡人话标签（带 args 与缺 args 两种）
  const toolLabels = await read(win, `[...document.querySelectorAll('.chat-tool-label')].map((n) => n.textContent)`);
  assert.ok(toolLabels.some((t) => t.includes("第 1 章")), `tool label humanized: ${JSON.stringify(toolLabels)}`);
  assert.ok(toolLabels.some((t) => t === "读取了章节"), "legacy tool message without args must degrade gracefully");

  // ⑪ 溯源 chips：点章节 chip 打开阅读器
  clicks.push(await clickAndRead(win, '[data-testid="chat-source-chapter"]', {
    label: "s45-source-chip-open-reader",
    settleMs: 400,
    expect: () => read(win, `document.getElementById('reader-scrim').classList.contains('show')`)
  }));
  await win.webContents.executeJavaScript(`document.getElementById('reader-close').click(); true;`);
  await delay(200);

  // ⑫ 消息操作：复制（点击后必须出 toast——成功或失败文案都算执行到位）
  clicks.push(await clickAndRead(win, '[data-testid="msg-copy"]', {
    label: "s45-msg-copy",
    settleMs: 300,
    expect: () => read(win, `document.querySelector('.toast-stack').textContent.includes('复制')`)
  }));

  // ⑬ 确认卡段落/行级切换
  clicks.push(await clickAndRead(win, '[data-testid="chat-diff-toggle"]', {
    label: "s45-diff-toggle",
    settleMs: 200,
    expect: () => read(win, `document.querySelector('.chat-diff') && document.querySelector('.chat-diff').hidden === false`)
  }));

  // ⑭ 活动占位 + 停止按钮（chat/send mock 延迟 800ms 制造窗口；stop 打到真服务器 → 空闲 409 → 错误 toast 证明链路通）
  await win.webContents.executeJavaScript(`
    document.getElementById('composer-input').value = '测试过程流';
    document.getElementById('composer-input').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-submit').click();
    true;
  `);
  await delay(300);
  const placeholderVisible = await read(win, `Boolean(document.querySelector('[data-testid="chat-activity-placeholder"]'))`);
  assert.equal(placeholderVisible, true, "activity placeholder must appear during chat send");
  // stop 打到真服务器：send 被前端 mock，服务端无 chatJobs → 409「当前没有进行中的对话轮。」→ 错误 toast。
  // 断言必须认这条具体文案——不能只看 toast 非空（⑫ 的复制 toast 3.2s 内还在栈里，会误判通过）。
  clicks.push(await clickAndRead(win, '[data-testid="chat-stop"]', {
    label: "s45-chat-stop",
    settleMs: 400,
    expect: () => read(win, `document.querySelector('.toast-stack').textContent.includes('对话轮') || document.querySelector('.toast-stack').textContent.includes('停止')`)
  }));
  await delay(900); // 等 mock send 完成、占位撤除

  // ⑮ 阅读器工具排：开阅读器 → 字号 + 沉浸 + 翻章按钮
  await win.webContents.executeJavaScript(`document.querySelector('.filecard')?.click(); true;`);
  await delay(500);
  const readerOpen = await read(win, `document.getElementById('reader-scrim').classList.contains('show')`);
  assert.equal(readerOpen, true, "reader must open from chapter card");
  // 比较表达式放进页内求值，expect 保持同步布尔（与既有探针契约一致）。
  const fontBefore = await read(win, `document.getElementById('reader-body').style.fontSize`);
  clicks.push(await clickAndRead(win, '#reader-font-plus', {
    label: "s45-reader-font-plus",
    settleMs: 150,
    expect: () => read(win, `document.getElementById('reader-body').style.fontSize !== ${JSON.stringify(fontBefore)}`)
  }));
  clicks.push(await clickAndRead(win, '#reader-wide', {
    label: "s45-reader-wide",
    settleMs: 150,
    expect: () => read(win, `document.getElementById('reader').classList.contains('reader--wide')`)
  }));
  // 用 reader-path 断言翻章：它永远是 chapters/00N.md，不依赖章节标题内容。
  clicks.push(await clickAndRead(win, '#reader-next', {
    label: "s45-reader-next",
    settleMs: 500,
    expect: () => read(win, `document.getElementById('reader-path').textContent.includes('002') || document.getElementById('reader-next').disabled === true`)
  }));
  await win.webContents.executeJavaScript(`document.getElementById('reader-close').click(); true;`);
  await delay(200);

  // ⑯ 快捷键浮层：⌨ 开 → X 关
  clicks.push(await clickAndRead(win, '#cbar-keys', {
    label: "s45-shortcuts-open",
    settleMs: 200,
    expect: () => read(win, `document.getElementById('shortcuts-scrim').classList.contains('show')`)
  }));
  clicks.push(await clickAndRead(win, '#shortcuts-x', {
    label: "s45-shortcuts-close",
    settleMs: 200,
    expect: () => read(win, `!document.getElementById('shortcuts-scrim').classList.contains('show')`)
  }));
```

注意：若 `clickAndRead` 的 `expect` 不支持 async 函数（看既有实现），⑮ 的字号断言改为点击后单独 `read` 再 `assert.notEqual`。**以脚本里既有探针的写法为准做最小适配，不改既有探针。**

- [ ] **Step 17.4: 跑探针**

Run: `npm run verify:app-clickability`（在主 checkout 跑，worktree 缺 Electron 时把分支改动同步过去或在 worktree `npm install` 后跑）
Expected: 输出 `ok: true`（含 s45-* 全部探针）。若 failure-card 偶发 flaky（S4 已知问题），重跑一次确认非本次引入。

- [ ] **Step 17.5: Commit**

```bash
git add scripts/verify-app-clickability.cjs
git commit -m "test(s4.5): clickability probes - manuscript, tool labels, source chips, stop, reader tools, shortcuts"
```

---

### Task 17b: verify-chat-online 场景 F——真实 API 过程流与中途停止

**Files:**
- Modify: `scripts/verify-chat-online.mjs`

口径说明（与 spec §6 对齐）：HTTP 层的 `busy` 字段已由 `tests/app-shell/chat-busy-stop.test.mjs` 用假模型覆盖；本场景用**真实模型**验证两件事——F1）tool 消息在回合结束前增量落盘（前端过程流的数据基础）；F2）中途 abort 能掐断真实模型调用并落「（已停止。）」。

- [ ] **Step 17b.1: 文件头场景注释更新**——在 `//            B) edit flow with confirmation, C) fact-check corpus` 一行之后追加：

```js
//            F) incremental tool persistence + mid-turn cancel (S4.5)
```

- [ ] **Step 17b.2: 场景 F 实现**——在 `    // 写成本报告` 一行之前插入：

```js
    // ========== 场景 F：过程流增量落盘 + 中途停止（S4.5）==========
    console.error("[F] incremental persistence + cancel...");
    try {
      // F1: 回合进行中，tool 消息应已增量写入 chat_history.jsonl。
      // 判定窗口 = "已见 tool 消息且尚未见本轮 assistant 消息"，否则只能证明事后写入。
      const historyFile = path.join(projectRoot, "chat_history.jsonl");
      const baselineLines = (await fs.readFile(historyFile, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
      let sawIncrementalTool = false;
      const f1Turn = runChatTurn({
        projectRoot, project, registry, modelClient,
        userMessage: "第 1 章正文里，沈泽是在什么地方听到消息的？必须读原文查证后回答。"
      });
      const f1Poll = (async () => {
        for (let i = 0; i < 120; i += 1) {
          await new Promise((r) => setTimeout(r, 500));
          const lines = (await fs.readFile(historyFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
          const fresh = lines.slice(baselineLines).map((l) => { try { return JSON.parse(l); } catch { return null; } });
          const hasTool = fresh.some((m) => m?.role === "tool");
          const hasAssistant = fresh.some((m) => m?.role === "assistant");
          if (hasTool && !hasAssistant) { sawIncrementalTool = true; return; }
          if (hasAssistant) return; // 回合已结束，未捕获增量窗口
        }
      })();
      const f1 = await f1Turn;
      await f1Poll;
      const f1Pass = sawIncrementalTool && f1.toolEvents.length > 0;
      results.push({
        scenario: "F1_incremental_tool_persistence",
        pass: f1Pass,
        sawIncrementalTool,
        toolEvents: f1.toolEvents.map((e) => `${e.tool}:${e.ok ? "ok" : e.error}`),
        cost: f1.usage.cost
      });
      console.error(`[F1] pass=${f1Pass} incremental=${sawIncrementalTool}`);

      // F2: 中途 abort → cancelled:true + 「（已停止。）」落盘。
      // 500ms 时模型首轮调用几乎必然仍在途（真实 API 延迟 >1s）；若模型异常快导致 cancelled=false，重跑一次再判。
      const controller = new AbortController();
      const f2Turn = runChatTurn({
        projectRoot, project, registry, modelClient, signal: controller.signal,
        userMessage: "把第 1 章每一段都总结一遍，再查一遍设定记忆和大纲。"
      });
      setTimeout(() => controller.abort("用户停止"), 500);
      const f2 = await f2Turn;
      const f2History = (await fs.readFile(historyFile, "utf8")).split("\n").filter(Boolean);
      const f2Last = JSON.parse(f2History.at(-1));
      const f2Pass = f2.cancelled === true && f2Last.content === "（已停止。）";
      results.push({
        scenario: "F2_cancel_mid_turn",
        pass: f2Pass,
        cancelled: f2.cancelled === true,
        lastMessage: String(f2Last.content ?? "").slice(0, 50),
        cost: f2.usage.cost
      });
      console.error(`[F2] pass=${f2Pass} cancelled=${f2.cancelled}`);
    } catch (error) {
      results.push({ scenario: "F_process_stream", pass: false, error: error.message });
      console.error(`[F] ERROR ${error.message}`);
    }
```

注意：场景 F 排在 E（归档语义）之后执行，此时项目可能处于归档态——F 只用读工具，归档不拦读，无需解档。

- [ ] **Step 17b.3: 运行（需用户 API key）**

```powershell
npm run verify:chat-online
```

Expected: 报告 JSON 中 `F1_incremental_tool_persistence` 与 `F2_cancel_mid_turn` 均 `pass: true`。无 key 时跳过执行，在交付报告里如实标注"场景 F 待跑"。

- [ ] **Step 17b.4: Commit**

```bash
git add scripts/verify-chat-online.mjs
git commit -m "test(s4.5): chat-online scenario F - incremental persistence and mid-turn cancel"
```

---

### Task 18: 防线全跑 + 交付报告

**Files:**
- Create: `docs/superpowers/reports/2026-06-13-s45-delivery-report.md`

- [ ] **Step 18.1: 全量防线**

```powershell
npm test
npm run verify:app-shell
npm run verify:app-clickability
npm run verify:desktop-shell
```

Expected: 测试全绿；三个 verify 全部 `ok: true`。任何一个失败：先用 `superpowers:systematic-debugging` 定位，禁止改探针绕过。

- [ ] **Step 18.2: 真实 API 短跑（可选，需用户 key；含 Task 17b 的场景 F）**

```powershell
npm run verify:chat-online
```

无 key 时在报告里如实标注"待跑"。

- [ ] **Step 18.2b: 用户指南增补**——在 `docs/USER_GUIDE.zh-CN.md` 文件末尾追加（逐字）：

```markdown

## 15. S4.5 对话体验速览

- **过程可见**：发送后占位气泡显示已耗时与智能体当前动作；每个工具动作完成即出现在对话流。
- **随时停止**：占位气泡上的「停止」按钮可中断本轮对话（进行中的文件写入会原子完成，不会留半截）。
- **稿块**：智能体输出的正文片段以衬线"文稿块"渲染并标注字数；隐私模式同样会模糊它。
- **修改确认**：编辑确认卡默认显示段落对照与改动摘要，可切换「行级详细」。
- **依据 chips**：回答下方「依据 · 第 N 章」可点击直达阅读器。
- **消息操作**：悬停气泡可复制 / 重新发送 / 重试本轮。
- **阅读器**：A− / A＋ 调字号（档位会记住）、‹ › 或 ← / → 翻章、「沉浸」加宽视图、选中正文可「问智能体」。
- **快捷键**：按 `?` 或点输入栏的 ⌨ 查看全部快捷键。
```

- [ ] **Step 18.3: 写交付报告**——`docs/superpowers/reports/2026-06-13-s45-delivery-report.md`，结构对齐 S4 报告：任务对照表（Task 1–17b → 提交哈希）、spec §8 验收 15 条逐条对照证据、防线输出原文、已知问题、新增/修改文件清单。

- [ ] **Step 18.4: Commit**

```bash
git add docs/superpowers/reports/2026-06-13-s45-delivery-report.md docs/USER_GUIDE.zh-CN.md
git commit -m "docs(s4.5): delivery report with acceptance evidence, user guide S4.5 section"
```

- [ ] **Step 18.5**：用 `superpowers:finishing-a-development-branch` 收尾（merge 回 master / 保留分支由用户决定）。合并回 master 后若要交付桌面快捷方式：`npm run verify:local` + 重新打包（`npm run package:dir`），否则桌面 exe 还是旧的。

---

## 计划自审记录（writing-plans Self-Review）

1. **Spec 覆盖**：§3 全部 13 项 → 见头部映射表；§4 接口变更 → T2/T3/T4/T5；§5 错误处理 → 409 守卫（T5 测试 2/4 例）、abort 时序（T4 测试 2）、旧历史降级（T6 测试 + T17 探针⑩）、未闭合围栏（T1 测试）、clipboard 失败（T12 catch + T17 探针⑫双文案断言）、翻章越界（T14 disabled）；§6 测试矩阵 → T1–T8 单测 + T5 HTTP + T17 探针；§9 风险 → stop 死锁（T5 红线注释+测试 3）、parseAgentReply 回归（T2 Step 2.5 跑全量旧用例）、轮询重影（T9 乐观气泡清理 + T11 指纹路径）、半写文件（T4 测试 3）。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤给出完整代码或精确锚点+逐字插入内容。
3. **类型一致性**：`toolLabel(tool, argsSummary)`/`toolSourceChip` 签名在 T6 定义、T9/T11 使用一致；`deriveSources(messages, assistantMessage)` T7 定义、T9 使用一致；`renderParagraphDiff(before, after)` T8 定义、T10 使用一致；`syncChatBusy(data)`/`isChatBusy()` T11 定义、app.js/T12/T15 使用一致；tool 消息 `args` 字段 T3 写入、T6/T7/T9/T17 消费均为字符串摘要。

**第二轮优化记录（2026-06-13）**：

1. 补漏：spec §6 要求的 verify:chat-online 场景 F 此前无对应任务 → 新增 Task 17b（F1 增量落盘窗口判定 = "见 tool 未见 assistant"，F2 500ms abort），并修订 spec §6 口径（HTTP busy 由 chat-busy-stop 单测覆盖）。
2. 消除挥手指令：Task 5(d) serveChatConfirm 由"逐字同 (c)"改为完整函数体；Task 16(e) trapTab 链给出最终形态（原两处指令互相矛盾）。
3. 修时序 bug：Task 15 mode pill 脉冲移到 `await ctx.loadDashboard()` 之后（renderModePill 重置 className 会掐断动画）。
4. 修弱断言：探针 ⑭ stop 的 toast 断言改为认具体文案（防 ⑫ 复制 toast 串扰误判）；⑮ 翻章改用 reader-path（标题文案不可靠）、字号比较移入页内布尔表达式（保持 expect 同步契约）。
5. 加守卫：sendChatMessageWithUX 入口忙态守卫（防双击 409 噪音）；全局禁止事项增加"GET 端点不得加 withProjectLock"红线（轮询过程流的载荷事实，已 grep 取证六个写端点清单）。
6. 文档同步：Task 18 新增 Step 18.2b USER_GUIDE §15 增补（I10）。
