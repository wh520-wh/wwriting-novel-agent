# S4「用得顺」实施计划 — 导出 · 归档 · 设置分区 · 四档授权 · Codex 交互收口

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 S4 spec 全部内容：成书导出（md/txt）、项目归档（只读化）、设置 6 分区、授权四档（含 YOLO）、diff 确认卡、运行任务卡、环境状态条、空状态引导，单次交付。

**Architecture:** 新模块 `book-export.mjs`（纯函数+IO 分离）与 `diff-view.js`（前端零依赖 LCS）；授权与归档语义集中在 `checkToolPermission` 一处扩展；UI 改动全部挂在既有渲染函数的明确插入点上；每个新能力先有 chat 工具，GUI 按钮只是预填对话。

**Tech Stack:** Node 24 ESM（.mjs）、node:test、原生 DOM（无框架）、Electron preload 桥，零新外部依赖。

**Spec:** `../specs/2026-06-12-s4-usability-codex-design.md`（权威，含四档授权矩阵与硬底线）

**纪律：** 每任务 `npm test` 全绿才 commit；UI/服务端任务收尾跑 `npm run verify:app-shell` + `npm run verify:app-clickability`；最终 `npm run verify:local` + 真实 API 场景 D/E。

---

## 现状接口速查（全部已核实）

| 接口 | 位置 | 形态 |
|------|------|------|
| tool_permissions 默认块 | `src/core/project-store.mjs:51-57` | `{ network_allowed, safe_edit: true, read_only: false, dangerous: false, ...options }`；project 对象顶层在 `output_style`（:50）之后可加新字段 |
| **dangerous 字段已封死** | `src/core/settings-runtime.mjs:253-254` | `permissions.dangerous === true` 直接抛 `dangerous_permission_rejected`——**yolo 必须用独立字段，且必须加入 normalize 白名单**（:262 附近逐字段复制） |
| normalizeToolPermissions | `src/core/settings-runtime.mjs:251-` | patch 路径 `updateProjectSettings(projectRoot, { tool_permissions: {...} })`（:110-134 合并逻辑已存在） |
| 设置保存端点 | `src/core/app-server.mjs:143-145` | `POST /api/settings/update` → `serveSettingsUpdate`（:432）→ updateProjectSettings |
| checkToolPermission | `src/core/chat/tool-registry.mjs:21-30` | `(tool, toolPermissions)` 纯函数；read 永放行 → read_only 拒 → safe_edit 拒 SAFE_EDIT_TOOLS |
| chat loop 写分支 | `src/core/chat/chat-agent.mjs:66-93` | `if (tool && !isRead)`：权限预检（:68）→ edit 预览（:77）→ savePendingAction（:87）。**auto/yolo 判定插在权限预检通过之后、preview 之前** |
| resumeChatTurn 执行 | `src/core/chat/chat-agent.mjs:33` | `executeTool(registry, pending.tool, ...)` ctx 含 server/getTaskQueue |
| 写工具注册 | `src/core/chat/tools-write.mjs:59` | `registerWriteTools(registry)`，错误对象 `e.code` 模式 |
| 归档拦截点（server） | `src/core/app-server.mjs` | 写端点：`/api/run/*`（:156 附近 retry/stop/start）、`/api/commands/submit`（:140）、`/api/queue/*`；统一在各 handler 的 `resolveActiveProjectRoot` 后插卡 |
| 项目列表条目 | `src/core/app-server.mjs:276-282` | `{ projectRoot, title, story_seed, active_model, model_label, external }` ← 加 `archived_at` |
| dashboard project 块 | `src/core/app-dashboard.mjs:66-` | `project: { project_id, ... }` ← 加 `tool_permissions`、`archived_at`（pill 数据源） |
| 项目列表渲染 | `src/app-shell/app.js:322` | `renderProjectListFiltered()`：filter → `refs.projectList` 渲染 |
| composer-bar DOM | `src/app-shell/index.html:83-88` | `cbar-btn#cbar-slash` → `cbar-spacer` → hint → send。**pill 组插在 #cbar-slash 之后、spacer 之前** |
| 设置弹窗骨架 | `src/app-shell/index.html:131-150` | `.sp-side`（搜索+`#settings-provider-list`+添加）+ `.sp-detail>#settings-detail` |
| 设置渲染 | `src/app-shell/settings-modal.js:76,100` | `renderSettingsProviders()`（sp-item 列表）/ `renderSettingsDetail()`；字段工厂 `settingField`（:215）、`settingToggle`（:318） |
| 章节面板 | `src/app-shell/drawer-panels.js:53` | `renderChapterPanel(data)` ← 导出按钮插开头 |
| live block | `src/app-shell/thread-renderer.js:368,413,634` | `buildAgentBlock` / `renderSteps(block,data)`（step 行 className=`step ${status}`）/ `updateLiveAgentBlock(data)` |
| 确认卡 | `src/app-shell/thread-renderer.js` `renderConfirmCard` | `.chat-confirm-diff > .chat-confirm-before/.chat-confirm-after`（diff 视图替换此块） |
| Electron 桥 | `src/desktop/electron-preload.cjs`（7 行全文已知）/ `electron-main.cjs:27-36` | `ipcMain.handle("wwriting:select-project-folder")` 模式照抄加 reveal |
| 标题剥离正则 | `src/core/quality-gates.mjs:151` | `/^\s{0,3}#{1,3}\s*第\s*([^\s章节章]+?)\s*章/u` |
| chat 工具 ctx | tools 的 `run(args, ctx)` | `ctx = { projectRoot, project, server?, getTaskQueue? }` |
| 测试风格 | `tests/*.test.mjs` | node:test + assert/strict + mkdtemp 临时目录 |

## 文件结构

```
新建：
  src/core/book-export.mjs            composeBook 纯函数 + exportBook IO
  src/app-shell/diff-view.js          行级 LCS diff（纯函数 + DOM 渲染）
  tests/book-export.test.mjs
  tests/diff-view.test.mjs            （node:test 可测纯函数部分）
修改：
  src/core/project-store.mjs          默认字段 auto_edit/yolo/archived_at
  src/core/settings-runtime.mjs       normalize 白名单 + archived_at patch
  src/core/chat/tool-registry.mjs     checkToolPermission 归档/优先级链
  src/core/chat/chat-agent.mjs        auto/yolo 免确认分支
  src/core/chat/tools-write.mjs       export_book + archive_project
  src/core/app-server.mjs             归档拦截 + 列表/dashboard 字段透出
  src/core/app-dashboard.mjs          project 块透出 tool_permissions/archived_at
  src/app-shell/index.html            composer pill 组容器
  src/app-shell/settings-modal.js     6 分区导航重构
  src/app-shell/composer.js           模式 pill + 四档浮层 + 状态 pill
  src/app-shell/thread-renderer.js    diff 确认卡 + 任务卡 + 空状态
  src/app-shell/drawer-panels.js      章节面板导出按钮
  src/app-shell/app.js                归档分组渲染 + 归档态 topbar
  src/app-shell/styles.css            pill/diff/任务卡/分区样式（用既有 token）
  src/desktop/electron-preload.cjs    revealPath 桥
  src/desktop/electron-main.cjs       wwriting:reveal-path handler
  scripts/verify-app-clickability.cjs 新控件探针
  scripts/verify-chat-online.mjs      场景 D/E
  tests/chat-tools.test.mjs           新工具用例（追加）
  tests/chat-agent.test.mjs           auto/yolo 用例（追加）
  tests/settings-runtime.test.mjs     白名单用例（追加，若无此文件则建）
```

**实施顺序硬约束：** Task 1 → 2 是权限地基，先行；3 → 4 → 5 导出归档链；6 → 7 → 8 设置 UI 链；9-12 时间线（相互独立，可乱序）；13 → 14 → 15 收尾。每任务独立提交。

---

# Phase 0 — 权限地基

## Task 1: 字段层——auto_edit / yolo / archived_at 进默认值与白名单

**Files:**
- Modify: `src/core/project-store.mjs:50-57`
- Modify: `src/core/settings-runtime.mjs`（normalizeToolPermissions 白名单 + archived_at patch）
- Test: `tests/settings-runtime.test.mjs`（追加；若不存在则按测试风格新建）

- [ ] **Step 1: 写失败测试**

```js
// tests/settings-runtime.test.mjs 追加（import updateProjectSettings、createProject、loadProject 按现有测试文件模式）
test("tool_permissions 接受 auto_edit/yolo，拒绝 dangerous，保留未知字段丢弃", async () => {
  const projectRoot = await makeProject(); // 该文件已有的工厂；无则用 createProject 临时目录模式
  await updateProjectSettings(projectRoot, { tool_permissions: { auto_edit: true, yolo: true } });
  const project = await loadProject(projectRoot);
  assert.equal(project.tool_permissions.auto_edit, true);
  assert.equal(project.tool_permissions.yolo, true);
  await assert.rejects(
    () => updateProjectSettings(projectRoot, { tool_permissions: { dangerous: true } }),
    /dangerous/iu
  );
});

test("archived_at 接受 null 与合法 ISO，拒绝垃圾", async () => {
  const projectRoot = await makeProject();
  const iso = new Date().toISOString();
  await updateProjectSettings(projectRoot, { archived_at: iso });
  assert.equal((await loadProject(projectRoot)).archived_at, iso);
  await updateProjectSettings(projectRoot, { archived_at: null });
  assert.equal((await loadProject(projectRoot)).archived_at, null);
  await assert.rejects(() => updateProjectSettings(projectRoot, { archived_at: "昨天" }), /archived_at/u);
});

test("createProject 默认 auto_edit=false yolo=false archived_at=null", async () => {
  const projectRoot = await makeProject();
  const project = await loadProject(projectRoot);
  assert.equal(project.tool_permissions.auto_edit, false);
  assert.equal(project.tool_permissions.yolo, false);
  assert.equal(project.archived_at, null);
});
```

- [ ] **Step 2: 跑 `node --test tests/settings-runtime.test.mjs` 确认失败**

- [ ] **Step 3: 实现**

`project-store.mjs:50` 后（output_style 行后）加顶层字段，`:53-55` 块内加两默认：

```js
    output_style: options.output_style ?? "creative",
    archived_at: options.archived_at ?? null,
    tool_permissions: {
      network_allowed: options.network_allowed ?? false,
      safe_edit: true,
      read_only: false,
      auto_edit: false,
      yolo: false,
      dangerous: false,
      ...(options.tool_permissions ?? {})
    },
```

`settings-runtime.mjs` normalizeToolPermissions（:251 起）在 dangerous 拒绝之后、字段复制区（:262 附近）按既有逐字段模式追加：

```js
  if (permissions.auto_edit !== undefined) normalized.auto_edit = permissions.auto_edit === true;
  if (permissions.yolo !== undefined) normalized.yolo = permissions.yolo === true;
```

archived_at patch：在 `updateProjectSettings` 的 patch 解析区（:110 附近，对照 tool_permissions 的写法）加：

```js
  if (patch.archived_at !== undefined) {
    if (patch.archived_at !== null) {
      const ts = Date.parse(patch.archived_at);
      if (!Number.isFinite(ts)) {
        throw new SettingsValidationError("invalid_archived_at", "archived_at must be null or an ISO timestamp.");
      }
      normalized.archived_at = new Date(ts).toISOString();
    } else {
      normalized.archived_at = null;
    }
  }
```

并在最终合并对象（:132 附近 tool_permissions 合并处同级）透传 `...(normalized.archived_at !== undefined ? { archived_at: normalized.archived_at } : {})`（对照该函数现有合并写法，保持风格一致）。

- [ ] **Step 4: 测试过 + `npm test` 全绿 + 提交**

```bash
git add src/core/project-store.mjs src/core/settings-runtime.mjs tests/settings-runtime.test.mjs
git commit -m "feat(s4): auto_edit/yolo/archived_at fields with validation, dangerous stays sealed"
```

## Task 2: 权限链——checkToolPermission 归档与优先级 + loop 免确认分支

**Files:**
- Modify: `src/core/chat/tool-registry.mjs:21-30`
- Modify: `src/core/chat/chat-agent.mjs:66-93`
- Test: `tests/chat-tools.test.mjs`、`tests/chat-agent.test.mjs`（追加）

**契约（spec §4.3 优先级链）：** `read_only` > `safe_edit:false` > 归档只读 > yolo/auto_edit。checkToolPermission 签名扩展为 `(tool, toolPermissions, { archived = false } = {})`——第三参可选，旧调用不破坏。归档豁免名单 `ARCHIVE_EXEMPT_TOOLS = new Set(["archive_project", "export_book"])`。

- [ ] **Step 1: 写失败测试**

```js
// tests/chat-tools.test.mjs 追加
test("checkToolPermission 归档只读：写/控制拒绝，豁免名单放行，read 永放行", () => {
  const perms = { read_only: false, safe_edit: true };
  const archived = { archived: true };
  assert.equal(checkToolPermission({ kind: "read" }, perms, archived).allowed, true);
  assert.equal(checkToolPermission({ kind: "write", name: "edit_chapter" }, perms, archived).allowed, false);
  assert.equal(checkToolPermission({ kind: "control", name: "start_run" }, perms, archived).allowed, false);
  assert.equal(checkToolPermission({ kind: "write", name: "archive_project" }, perms, archived).allowed, true);
  assert.equal(checkToolPermission({ kind: "write", name: "export_book" }, perms, archived).allowed, true);
});

test("优先级：read_only 压过 yolo；safe_edit:false 压过 yolo", () => {
  assert.equal(checkToolPermission({ kind: "write", name: "edit_chapter" }, { read_only: true, yolo: true }).allowed, false);
  assert.equal(checkToolPermission({ kind: "write", name: "edit_chapter" }, { safe_edit: false, yolo: true }).allowed, false);
});
```

```js
// tests/chat-agent.test.mjs 追加（scriptedClient/makeChatProject 已有）
test("auto_edit=true：edit_chapter 不落 pending 直接执行", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  project.tool_permissions = { ...project.tool_permissions, auto_edit: true };
  const registry = createToolRegistry();
  registerReadTools(registry); registerWriteTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"十二楼","reason":"auto"}}]}\n```',
      "已自动改完。"
    ]),
    userMessage: "改楼层"
  });
  assert.equal(out.pendingAction, null);
  assert.equal(out.toolEvents[0].tool, "edit_chapter");
  assert.equal(out.toolEvents[0].ok, true);
  assert.match(await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8"), /十二楼/u);
});

test("auto_edit=true 不放开 control；yolo=true 放开 control", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry); registerWriteTools(registry); registerControlTools(registry);
  const callScript = ['```json\n{"tool_calls":[{"tool":"pause_run","args":{}}]}\n```', "好。"];
  project.tool_permissions = { ...project.tool_permissions, auto_edit: true, yolo: false };
  const a = await runChatTurn({ projectRoot, project, registry, modelClient: scriptedClient(callScript), userMessage: "暂停" });
  assert.ok(a.pendingAction, "auto 档 control 仍须确认");
  await clearPendingAction(projectRoot); // 从 chat-store 导入
  project.tool_permissions = { ...project.tool_permissions, yolo: true };
  const fakeServer = { runJobs: new Map([[path.resolve(projectRoot), { status: "running", controller: new AbortController() }]]) };
  const b = await runChatTurn({ projectRoot, project, registry, modelClient: scriptedClient(callScript), userMessage: "暂停", server: fakeServer });
  assert.equal(b.pendingAction, null);
  assert.equal(b.toolEvents[0].tool, "pause_run");
  assert.equal(b.toolEvents[0].ok, true);
});
```

- [ ] **Step 2: 跑两个测试文件确认失败**

- [ ] **Step 3: 实现**

`tool-registry.mjs`：

```js
const ARCHIVE_EXEMPT_TOOLS = new Set(["archive_project", "export_book"]);

export function checkToolPermission(tool, toolPermissions = {}, { archived = false } = {}) {
  if (tool.kind === "read") return { allowed: true };
  if (toolPermissions.read_only === true) {
    return { allowed: false, message: "项目处于只读模式（tool_permissions.read_only），不能执行修改或控制操作。" };
  }
  if (tool.kind === "write" && toolPermissions.safe_edit === false && SAFE_EDIT_TOOLS.has(tool.name)) {
    return { allowed: false, message: "项目关闭了安全编辑（tool_permissions.safe_edit=false），不能直接修改正文或设定。" };
  }
  if (archived && !ARCHIVE_EXEMPT_TOOLS.has(tool.name)) {
    return { allowed: false, message: "项目已归档（只读）。先解除归档（说「解除归档」即可），再进行修改或控制操作。" };
  }
  return { allowed: true };
}
```

`executeTool`（:38 权限检查处）改传 `{ archived: Boolean(ctx.project?.archived_at) }`。

`chat-agent.mjs` 写/控制分支（:66 `if (tool && !isRead)` 内、权限预检通过后）：

```js
      const permission = checkToolPermission(tool, project?.tool_permissions ?? {}, { archived: Boolean(project?.archived_at) });
      if (!permission.allowed) { /* ……既有拒绝回填不动…… */ }
      // 免确认分支：yolo 放开 write+control；auto_edit 仅放开 write。免「确认」不免「校验」——直接走 executeTool 原链。
      const perms = project?.tool_permissions ?? {};
      const autoApproved = perms.yolo === true || (perms.auto_edit === true && tool.kind === "write");
      if (autoApproved) {
        const outcome = await executeTool(registry, parsed.call.tool, parsed.call.args, { projectRoot, project, server, getTaskQueue });
        const event = { tool: parsed.call.tool, ok: outcome.ok, error: outcome.ok ? null : outcome.error };
        toolEvents.push(event);
        await appendChatMessage(projectRoot, {
          role: "tool", tool: parsed.call.tool, ok: outcome.ok, auto_approved: true,
          result_summary: summarize(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
        });
        onEvent?.({ type: "tool_result", ...event });
        continue; // 回 loop 让模型看到结果继续
      }
      /* ……既有 preview + savePendingAction 流程不动…… */
```

注意 `continue` 前同样受 `toolEvents.length >= MAX_TOOL_ROUNDS`（:63）约束——该检查在循环头已有，免确认连环执行天然被 round cap 限制。

- [ ] **Step 4: `npm test` 全绿 + 提交**

```bash
git add src/core/chat/tool-registry.mjs src/core/chat/chat-agent.mjs tests/chat-tools.test.mjs tests/chat-agent.test.mjs
git commit -m "feat(s4): four-tier approval - auto_edit/yolo bypass confirmation, archive read-only with exempt list"
```

---

# Phase 1 — 导出与归档

## Task 3: book-export 模块（纯函数 + IO）

**Files:**
- Create: `src/core/book-export.mjs`
- Test: `tests/book-export.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// tests/book-export.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { composeBook, exportBook } from "../src/core/book-export.mjs";
import { createProject, upsertChapter } from "../src/core/project-store.mjs";

test("composeBook md：书名 H1、章 H2、剥正文首标题、按章号排序", () => {
  const { filename, content } = composeBook([
    { chapter_no: 2, title: "second", content: "# 第二章\n\n乙正文。" },
    { chapter_no: 1, title: "first", content: "## 第一章 开端\n\n甲正文。" }
  ], { title: "测试书", slug: "test-book", format: "md", date: new Date("2026-06-12") });
  assert.equal(filename, "test-book-20260612.md");
  assert.match(content, /^# 测试书\n/u);
  const first = content.indexOf("## 第 1 章");
  const second = content.indexOf("## 第 2 章");
  assert.ok(first >= 0 && second > first, "章序正确");
  assert.doesNotMatch(content, /## 第一章 开端/u, "正文内原标题已剥离");
  assert.match(content, /甲正文。/u);
});

test("composeBook txt：剥 markdown 标记", () => {
  const { filename, content } = composeBook([
    { chapter_no: 1, title: "", content: "# 第一章\n\n**强调**与`代码`正文。" }
  ], { title: "书", slug: "b", format: "txt", date: new Date("2026-06-12") });
  assert.equal(filename, "b-20260612.txt");
  assert.doesNotMatch(content, /[#*`]/u);
  assert.match(content, /强调与代码正文。/u);
});

test("exportBook 端到端：completed 章入书、缺文件章进 skipped、写 exports/", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-export-"));
  const { projectRoot } = await createProject(root, {
    slug: "exp", title: "导出书", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const ch1 = path.join(projectRoot, "chapters", "001.md");
  await fs.mkdir(path.dirname(ch1), { recursive: true });
  await fs.writeFile(ch1, "# 第一章\n\n正文一。", "utf8");
  await upsertChapter(projectRoot, { chapter_no: 1, status: "completed", final_path: ch1, actual_words: 4 });
  await upsertChapter(projectRoot, { chapter_no: 2, status: "completed", final_path: path.join(projectRoot, "chapters", "missing.md"), actual_words: 0 });
  await upsertChapter(projectRoot, { chapter_no: 3, status: "drafting", final_path: null, actual_words: 0 });
  const result = await exportBook(projectRoot, { format: "md" });
  assert.equal(result.chapters, 1);          // 仅 completed 且文件在
  assert.deepEqual(result.skipped, [2]);     // completed 但缺文件
  assert.ok(result.words > 0);
  const written = await fs.readFile(result.path, "utf8");
  assert.match(written, /正文一/u);
  assert.match(result.path.replaceAll("\\", "/"), /\/exports\//u);
});

test("exportBook 范围参数 from/to", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-export2-"));
  const { projectRoot } = await createProject(root, {
    slug: "exp2", title: "书", story_seed: "s",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  for (const n of [1, 2, 3]) {
    const p = path.join(projectRoot, "chapters", `00${n}.md`);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, `# 第${n}章\n\n第${n}章正文。`, "utf8");
    await upsertChapter(projectRoot, { chapter_no: n, status: "completed", final_path: p, actual_words: 6 });
  }
  const result = await exportBook(projectRoot, { format: "md", fromChapter: 2, toChapter: 3 });
  assert.equal(result.chapters, 2);
  const written = await fs.readFile(result.path, "utf8");
  assert.doesNotMatch(written, /第1章正文/u);
});
```

- [ ] **Step 2: 跑测试确认失败（Cannot find module）**

- [ ] **Step 3: 实现**

```js
// src/core/book-export.mjs
// 成书导出：composeBook 纯函数（可单测），exportBook 做 IO。零依赖。
import fs from "node:fs/promises";
import { loadChapterIndex, loadProject } from "./project-store.mjs";
import { countEffectiveWords } from "./word-count.mjs";
import { pathExists, safeJoin, writeFileAtomic } from "./fs-utils.mjs";

const HEAD_TITLE_RE = /^\s{0,3}#{1,3}\s*第\s*[^\s章]+\s*章[^\n]*\n+/u; // 同 quality-gates 标题判定的剥离版

export function composeBook(chapters, { title, slug, format = "md", date = new Date() } = {}) {
  const sorted = [...chapters].sort((a, b) => a.chapter_no - b.chapter_no);
  const ymd = date.toISOString().slice(0, 10).replaceAll("-", "");
  const ext = format === "txt" ? "txt" : "md";
  const filename = `${slug}-${ymd}.${ext}`;
  const parts = [];
  if (ext === "md") {
    parts.push(`# ${title}`);
    for (const ch of sorted) {
      const body = String(ch.content ?? "").replace(HEAD_TITLE_RE, "").trim();
      const heading = ch.title ? `## 第 ${ch.chapter_no} 章 ${ch.title}` : `## 第 ${ch.chapter_no} 章`;
      parts.push(`${heading}\n\n${body}`);
    }
    return { filename, content: `${parts.join("\n\n")}\n` };
  }
  parts.push(title);
  for (const ch of sorted) {
    const body = stripMarkdown(String(ch.content ?? "").replace(HEAD_TITLE_RE, "").trim());
    const heading = ch.title ? `第 ${ch.chapter_no} 章 ${ch.title}` : `第 ${ch.chapter_no} 章`;
    parts.push(`${heading}\n\n${body}`);
  }
  return { filename, content: `${parts.join("\n\n\n")}\n` };
}

function stripMarkdown(text) {
  return text
    .replace(/^\s{0,3}#{1,6}\s*/gmu, "")
    .replace(/\*\*([^*]*)\*\*/gu, "$1")
    .replace(/\*([^*]*)\*/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1");
}

export async function exportBook(projectRoot, { format = "md", fromChapter = 1, toChapter = Infinity } = {}) {
  const [project, index] = await Promise.all([loadProject(projectRoot), loadChapterIndex(projectRoot)]);
  const slug = project.root_path ? String(project.root_path).split(/[\\/]/u).filter(Boolean).pop() : "book";
  const chapters = [];
  const skipped = [];
  for (const entry of (index.chapters ?? [])) {
    if (entry.status !== "completed") continue;
    if (entry.chapter_no < fromChapter || entry.chapter_no > toChapter) continue;
    const filePath = entry.final_path ?? entry.draft_path;
    if (!filePath || !(await pathExists(filePath))) { skipped.push(entry.chapter_no); continue; }
    chapters.push({ chapter_no: entry.chapter_no, title: entry.title ?? "", content: await fs.readFile(filePath, "utf8") });
  }
  const { filename, content } = composeBook(chapters, { title: project.title, slug, format });
  const outPath = safeJoin(projectRoot, "exports", filename);
  await fs.mkdir(safeJoin(projectRoot, "exports"), { recursive: true });
  await writeFileAtomic(outPath, content);
  return { path: outPath, chapters: chapters.length, words: countEffectiveWords(content), skipped };
}
```

（实施时核对 chapter_index 条目是否有 `title` 字段——若无则 heading 走无标题分支，测试相应不断言子标题文字。）

- [ ] **Step 4: 测试过 + `npm test` 全绿 + 提交**

```bash
git add src/core/book-export.mjs tests/book-export.test.mjs
git commit -m "feat(s4): book export - pure compose with title dedup and md/txt, exports/ writer"
```

## Task 4: export_book + archive_project 工具

**Files:**
- Modify: `src/core/chat/tools-write.mjs`（registerWriteTools 内追加两工具）
- Test: `tests/chat-tools.test.mjs`（追加）

- [ ] **Step 1: 写失败测试**

```js
test("export_book 工具：导出并返回路径/字数/skipped", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProjectWithChapter();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "export_book", { format: "md" }, { projectRoot, project });
  assert.equal(out.ok, true);
  assert.ok(out.result.path.includes("exports"));
  assert.equal(out.result.chapters, 1);
});

test("archive_project 工具：归档/解除归档写 archived_at；运行中拒绝", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const on = await executeTool(registry, "archive_project", { archived: true }, { projectRoot, project });
  assert.equal(on.ok, true);
  assert.ok((await (await import("../src/core/project-store.mjs")).loadProject(projectRoot)).archived_at);
  // 解除归档：注意 ctx.project 需带 archived_at 才能过豁免链（豁免名单放行）
  const archivedProject = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const off = await executeTool(registry, "archive_project", { archived: false }, { projectRoot, project: archivedProject });
  assert.equal(off.ok, true);
  assert.equal((await (await import("../src/core/project-store.mjs")).loadProject(projectRoot)).archived_at, null);
  // 运行中拒绝
  const busyServer = { runJobs: new Map([[path.resolve(projectRoot), { status: "running", controller: new AbortController() }]]) };
  const busy = await executeTool(registry, "archive_project", { archived: true }, { projectRoot, project, server: busyServer });
  assert.equal(busy.ok, false);
  assert.equal(busy.error, "project_busy");
});
```

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**（tools-write.mjs 顶部补 `import { exportBook } from "../book-export.mjs";`，registerWriteTools 末尾追加）

```js
  registry.register({
    name: "export_book", kind: "write",
    description: "把已完成章节合成一本书，导出到项目 exports/ 文件夹（md 或 txt）。",
    params: { format: "md 或 txt（默认 md）", from_chapter: "起始章（可空）", to_chapter: "结束章（可空）" },
    run: async (args, ctx) => {
      return await exportBook(ctx.projectRoot, {
        format: args.format === "txt" ? "txt" : "md",
        fromChapter: Number(args.from_chapter) > 0 ? Number(args.from_chapter) : 1,
        toChapter: Number(args.to_chapter) > 0 ? Number(args.to_chapter) : Infinity
      });
    }
  });

  registry.register({
    name: "archive_project", kind: "write",
    description: "归档或解除归档本项目。归档后项目只读（仍可查询与导出）。",
    params: { archived: "true 归档 / false 解除归档" },
    run: async (args, ctx) => {
      if (args.archived === true || args.archived === "true") {
        const job = ctx.server?.runJobs?.get(path.resolve(ctx.projectRoot));
        if (job?.status === "running") {
          const e = new Error("写作任务正在运行，请先暂停或等它完成，再归档。");
          e.code = "project_busy";
          throw e;
        }
      }
      const archivedAt = (args.archived === true || args.archived === "true") ? new Date().toISOString() : null;
      await updateProjectSettings(ctx.projectRoot, { archived_at: archivedAt });
      await appendEvent(ctx.projectRoot, {
        type: archivedAt ? "project_archived" : "project_unarchived",
        project_id: ctx.project?.project_id ?? null, stage: "chat",
        message: archivedAt ? "项目已归档（只读）" : "项目已解除归档"
      });
      return { archived: Boolean(archivedAt), archived_at: archivedAt };
    }
  });
```

（`path`、`updateProjectSettings`、`appendEvent` 该文件已 import。）

- [ ] **Step 4: `npm test` 全绿 + 提交**

```bash
git add src/core/chat/tools-write.mjs tests/chat-tools.test.mjs
git commit -m "feat(s4): export_book and archive_project chat tools with busy guard"
```

## Task 5: server 写端点归档拦截 + 字段透出

**Files:**
- Modify: `src/core/app-server.mjs`（写端点卡 + 列表/dashboard 字段）
- Modify: `src/core/app-dashboard.mjs`（project 块字段）
- Test: `tests/app-shell/chat-endpoints.test.mjs`（追加 1 用例验证 dashboard 透出；归档拦截以单测+探针为主）

- [ ] **Step 1: 实现 server 守卫**（新 helper 放 withProjectLock 附近）

```js
async function assertNotArchived(projectRoot) {
  const project = await loadProject(projectRoot);
  if (project.archived_at) {
    throw new HttpError(400, "PROJECT_ARCHIVED", "项目已归档（只读）。请先解除归档再执行此操作。");
  }
  return project;
}
```

插入点（各 handler 在 `resolveActiveProjectRoot` 后第一行调用）：`serveCommandSubmit`、`serveRunRetry`、run start 类 handler、queue 写 handler（实施时以路由表 :134-172 为准逐个核对写端点；`/api/chat/send|confirm` **不拦**——chat 层 checkToolPermission 管，读查询要可用）。`sendError` 处 HttpError 直接透传（对照该文件 HttpError 既有用法，不要包成 400 BAD_REQUEST 丢失 code）。

- [ ] **Step 2: 字段透出**

项目列表（:276-282）条目加 `archived_at: project.archived_at ?? null`（该处 project 来自 loadProject 映射，实施时对照变量名）。
`app-dashboard.mjs` project 块（:66 起）加：

```js
      tool_permissions: project.tool_permissions ?? {},
      archived_at: project.archived_at ?? null,
```

- [ ] **Step 3: 测试**（chat-endpoints.test.mjs 追加）

```js
test("dashboard 透出 tool_permissions 与 archived_at", async () => {
  const ctx = await setupServer();
  try {
    const { data } = await getJson(ctx.port, "/api/dashboard");
    assert.equal(data.project.archived_at, null);
    assert.equal(typeof data.project.tool_permissions, "object");
    assert.equal(data.project.tool_permissions.read_only, false);
  } finally { await closeServer(ctx.server); }
});
```

- [ ] **Step 4: `npm test` + `verify:app-shell` + 提交**

```bash
git add src/core/app-server.mjs src/core/app-dashboard.mjs tests/app-shell/chat-endpoints.test.mjs
git commit -m "feat(s4): archived write-endpoint guard and permissions/archive exposure to UI"
```

---

# Phase 2 — 设置分区与四档授权 UI

## Task 6: 设置弹窗 6 分区导航重构

**Files:**
- Modify: `src/app-shell/settings-modal.js`、`src/app-shell/index.html:131-150`、`src/app-shell/styles.css`

**行为规格：** `.sp-side` 顶部渲染分区导航（6 项：模型与密钥/写作参数/质量门禁/权限与确认/联网搜索/危险区，`data-section` 标识，class `sp-section-item`，当前项 `.on`）。选中「模型与密钥」时显示既有 provider 列表+detail（整体平移，**renderSettingsProviders/renderSettingsDetail 内部逻辑零改动**）；其余分区隐藏 provider 列表、detail 区渲染对应分区内容。模块内加 `let settingsSection = "model"` 状态与 `renderSectionNav()` / `renderSectionBody()` 调度函数；保存按钮逻辑按分区收集 patch（沿用现有 settingsFields 收集模式）。

- [ ] **Step 1: 实现导航与调度**（骨架：nav 渲染 → click 切 section → body 调度到 renderModelSection（包既有两函数）/ 占位的四个新 section 函数（本任务先渲染「该分区在后续任务实现」空态，Task 7/8 填充））
- [ ] **Step 2: 手动冒烟**：`npm run app:shell` 起服务，设置弹窗 6 项可切换、模型区与改版前等效、保存不报错
- [ ] **Step 3: `verify:app-shell` + `verify:app-clickability`**（旧设置探针必须仍过——provider 列表/API Key 控件路径不变）
- [ ] **Step 4: 提交**

```bash
git add src/app-shell/settings-modal.js src/app-shell/index.html src/app-shell/styles.css
git commit -m "feat(s4): settings modal six-section navigation, provider panel relocated intact"
```

## Task 7: 写作参数 / 质量门禁 / 联网搜索 / 危险区四个分区

**Files:**
- Modify: `src/app-shell/settings-modal.js`

**行为规格（全部复用 settingField/settingToggle 工厂 + `/api/settings/update` 保存）：**
- 写作参数：target_chapters（number）、min/target/max_words_per_chapter（number，max 留空=不限）、输出风格（现有 outputStyle 下拉平移进来）。
- 质量门禁：`memory_extraction.enabled`（toggle，patch `{ memory_extraction: { enabled } }`）、`fact_check.enabled`（toggle）、`fact_check.hard`（toggle，说明文案「硬模式：发现设定矛盾直接打回修订」）、title gate 只读行「章节标题校验 · 内建始终开启」。
- 联网搜索：现有 searchEndpoint/searchKeyEnv 两字段平移。
- 危险区：「归档此项目」按钮（点击=关闭弹窗+`sendChatMessage("归档这个项目")`——走对话确认链）、「打开项目文件夹」按钮（`window.wwritingDesktop?.revealPath?.(projectRoot)`，无桥时 toast 提示）；项目已归档时按钮变「解除归档」（sendChatMessage("解除归档")）。
- patch 校验注意：settings-runtime 对 memory_extraction/fact_check 的嵌套 patch 支持需核实——若 updateProjectSettings 白名单没有这两键，**本任务顺带加白名单**（模式照 Task 1 的 archived_at，布尔字段 normalize）。

- [ ] **Step 1: 核实并补 settings-runtime 白名单（memory_extraction/fact_check 嵌套布尔）+ 追加单测（patch 往返断言，照 Task 1 模式）**
- [ ] **Step 2: 实现四分区渲染与保存**
- [ ] **Step 3: 手动冒烟：fact_check.hard 开关保存后 project.json 真实变更**
- [ ] **Step 4: `npm test` + `verify:app-shell` + 提交**

```bash
git add src/app-shell/settings-modal.js src/core/settings-runtime.mjs tests/settings-runtime.test.mjs
git commit -m "feat(s4): writing/gates/research/danger settings sections with validated patches"
```

## Task 8: 权限四档 UI + composer 模式 pill

**Files:**
- Modify: `src/app-shell/settings-modal.js`（权限与确认分区）
- Modify: `src/app-shell/index.html:84`（composer-bar pill 容器）、`src/app-shell/composer.js`、`src/app-shell/styles.css`

**行为规格：**
- 设置分区：四档单选（radio 组），写入组合值（spec §4.3 矩阵）；YOLO 选项 amber 边框+警示文案。
- composer pill：`#cbar-slash` 后插 `<button class="cbar-pill" id="mode-pill" type="button">`；文案映射——只读「🔒 只读」/确认「✓ 确认后修改」/自动「⚡ 自动修改」/YOLO「⚡ YOLO」（class `cbar-pill--yolo` amber）；archived 时「📦 已归档」disabled。数据源 dashboard 的 `project.tool_permissions`/`archived_at`（Task 5 已透出；composer ctx 经 `ctx.getDashboard()` 取）。点击弹四档浮层（复用 slash 菜单的浮层样式模式），选择即 `postJson("/api/settings/update", { tool_permissions: 组合值 })` + `loadDashboard()`。
- Esc 关浮层；浮层外点击关闭。

- [ ] **Step 1: 实现设置分区四档单选**
- [ ] **Step 2: 实现 composer pill + 浮层**
- [ ] **Step 3: 手动冒烟：四档切换 → project.json 变更 → pill 文案同步；YOLO 态 amber**
- [ ] **Step 4: `verify:app-shell` + `verify:app-clickability`（旧探针不破）+ 提交**

```bash
git add src/app-shell/settings-modal.js src/app-shell/composer.js src/app-shell/index.html src/app-shell/styles.css
git commit -m "feat(s4): four-tier approval radio section and composer mode pill with yolo warning"
```

---

# Phase 3 — 时间线 Codex 化

## Task 9: diff-view 行级 LCS + 确认卡接入

**Files:**
- Create: `src/app-shell/diff-view.js`
- Test: `tests/diff-view.test.mjs`
- Modify: `src/app-shell/thread-renderer.js`（renderConfirmCard 的 preview 块）、`src/app-shell/styles.css`

- [ ] **Step 1: 写失败测试（纯函数部分）**

```js
// tests/diff-view.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { diffLines } from "../src/app-shell/diff-view.js";

test("diffLines：改一行 → del+add，上下文 keep", () => {
  const out = diffLines("a\nb\nc", "a\nB\nc");
  assert.deepEqual(out, [
    { type: "keep", text: "a" },
    { type: "del", text: "b" },
    { type: "add", text: "B" },
    { type: "keep", text: "c" }
  ]);
});

test("diffLines：纯增/纯删/无变化/全替换", () => {
  assert.deepEqual(diffLines("a", "a\nb"), [{ type: "keep", text: "a" }, { type: "add", text: "b" }]);
  assert.deepEqual(diffLines("a\nb", "a"), [{ type: "keep", text: "a" }, { type: "del", text: "b" }]);
  assert.deepEqual(diffLines("a", "a"), [{ type: "keep", text: "a" }]);
  assert.deepEqual(diffLines("x", "y"), [{ type: "del", text: "x" }, { type: "add", text: "y" }]);
});
```

- [ ] **Step 2: 确认失败 → 实现**

```js
// src/app-shell/diff-view.js
// 行级 LCS diff（零依赖）。确认卡 preview 的呈现层——批准执行仍走 edit_chapter 原校验链。
export function diffLines(before, after) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
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

export function renderDiff(before, after) {
  const wrap = document.createElement("div");
  wrap.className = "chat-diff";
  for (const row of diffLines(before, after)) {
    const line = document.createElement("div");
    line.className = `chat-diff-line chat-diff-${row.type}`;
    line.textContent = `${row.type === "del" ? "− " : row.type === "add" ? "+ " : "  "}${row.text}`;
    wrap.append(line);
  }
  return wrap;
}
```

`thread-renderer.js` renderConfirmCard：preview 存在且 `pendingAction.tool === "edit_chapter"` 时用 `renderDiff(preview.before, preview.after)` 替换原 `.chat-confirm-diff` 双栏；其他工具维持现有文字卡。顶部 import `renderDiff`。styles.css：`.chat-diff-line` 等宽字体（沿用现有 code 字体栈）、`.chat-diff-del` 背景 `var(--red-soft)`、`.chat-diff-add` 背景 `var(--green-soft)`。

- [ ] **Step 3: `npm test` + 手动冒烟（构造 pending 夹具看渲染）+ 提交**

```bash
git add src/app-shell/diff-view.js tests/diff-view.test.mjs src/app-shell/thread-renderer.js src/app-shell/styles.css
git commit -m "feat(s4): line-level lcs diff view for edit confirmation cards"
```

## Task 10: 运行任务卡升级

**Files:**
- Modify: `src/app-shell/thread-renderer.js`（buildAgentBlock :368 / renderSteps :413 / updateLiveAgentBlock :634）、`src/app-shell/styles.css`

**行为规格：** live block 升级为任务卡——头行加阶段 chips（规划→起草→审稿→定稿，数据源 `data.summary.currentStage` 映射，当前高亮 `--accent`，已过 `--green`）；副行实时「第 N 章 · X 字 · ¥Y」（字数 `data.summary` 现有字段、成本 estimatedCost+costAvailable 守则）；右上停止按钮（`postJson("/api/run/stop", {})`，与 topbar-stop 同逻辑、运行中才显示）；展开区沿用现有 steps/事件渲染。**数据全部来自现有 dashboard 轮询，零新端点。**

- [ ] **Step 1: 实现卡片结构与 chips**
- [ ] **Step 2: mock 项目跑一轮写作冒烟（`npm run app:shell` + 排 1 章），卡片阶段流转/停止按钮可用**
- [ ] **Step 3: `verify:app-shell` + `verify:app-clickability` + 提交**

```bash
git add src/app-shell/thread-renderer.js src/app-shell/styles.css
git commit -m "feat(s4): run task card - stage chips, live words/cost, inline stop"
```

## Task 11: 环境状态条 + 空状态建议卡

**Files:**
- Modify: `src/app-shell/composer.js`（状态 pill 组，与 Task 8 的 mode pill 同容器）、`src/app-shell/thread-renderer.js`（renderEmptyThread）、`src/app-shell/styles.css`

**行为规格：**
- 状态条：mode pill 旁两枚只读 pill——模型名（`dashboard.project.active_model.model_name`，mock 显示「未配置模型」，点击 `openSettingsModal()` 到模型区）、本会话成本（chat 消息 cost 字段累计，循环 dashboard.chatHistory 的 assistant.cost 求和；costAvailable=false 时隐藏）。dashboard 刷新时同步更新（composer 暴露 `updateStatusPills(data)` 供 app.js renderDashboard 调用）。
- 空状态：`renderEmptyThread` 中（现有空态文案后）当 `data.chatHistory?.messages?.length === 0` 时渲染 3 张建议卡：「排 5 章试写」「这本书的设定是什么？」「目前花了多少钱？」，click=`sendChatMessageWithUX(文案)`（composer 已导出该函数；若未导出则导出）。
- [ ] **Step 1: 实现两 pill + updateStatusPills 接线**
- [ ] **Step 2: 实现建议卡**
- [ ] **Step 3: 冒烟 + `verify:app-shell` + 提交**

```bash
git add src/app-shell/composer.js src/app-shell/thread-renderer.js src/app-shell/app.js src/app-shell/styles.css
git commit -m "feat(s4): environment status pills and empty-state suggested prompts"
```

## Task 12: 归档分组 + 归档态 UI + 导出按钮 + reveal 桥

**Files:**
- Modify: `src/app-shell/app.js`（renderProjectListFiltered :322 / topbar 归档态）、`src/app-shell/drawer-panels.js`（renderChapterPanel :53）、`src/desktop/electron-preload.cjs`、`src/desktop/electron-main.cjs`、`src/app-shell/styles.css`

**行为规格：**
- 列表分组：filtered 按 `archived_at` 拆两组；活跃组渲染现状不变；归档组折叠头「已归档 N」（class `rail-group-label rail-archived-toggle`，click 切 `archivedExpanded` 状态重渲），条目加 class `proj-archived`（灰化 `--faint` + 「📦 」前缀）。
- 归档态：renderDashboard 中 `data.project.archived_at` 非空 → status pill 文案「已归档」class 用 ghost 色；composer 占位换「项目已归档（只读）。对话查询可用；解除归档后才能修改。」（恢复逻辑：非归档时还原原占位）。
- 导出按钮：renderChapterPanel 开头插一行工具条：「导出成书」按钮（click=关抽屉+`sendChatMessageWithUX("导出全书为 md")`）+ Electron 下「打开导出文件夹」（`window.wwritingDesktop?.revealPath?.(<projectRoot>/exports)`；目录可能不存在——revealPath 主进程侧先 mkdir）。
- 桥：preload 加 `revealPath: (p) => ipcRenderer.invoke("wwriting:reveal-path", p)`；main 加：

```js
  ipcMain.handle("wwriting:reveal-path", async (_event, targetPath) => {
    const resolved = path.resolve(String(targetPath ?? ""));
    fs.mkdirSync(resolved, { recursive: true });
    await shell.openPath(resolved);
    return true;
  });
```

（main 顶部 require 解构补 `shell`。）

- [ ] **Step 1: 实现四处** → **Step 2: 冒烟（mock 项目归档/解除归档全链路、导出按钮发对话）** → **Step 3: `verify:app-shell` + `verify:desktop-shell` + 提交**

```bash
git add src/app-shell/app.js src/app-shell/drawer-panels.js src/desktop/ src/app-shell/styles.css
git commit -m "feat(s4): archived rail group, archived read-only chrome, export button, reveal bridge"
```

---

# Phase 4 — 防线与验收

## Task 13: clickability 探针扩展

**Files:**
- Modify: `scripts/verify-app-clickability.cjs`

**探针清单（沿用现有 probe 结构与 mock fetch 模式）：** ①设置 6 分区导航逐个点击（断言 detail 区切换）；②权限分区四档 radio 点击（mock /api/settings/update）；③composer mode pill 点击 → 浮层出现 → 选项可点；④抽屉章节 tab「导出成书」按钮可点（mock chat send）；⑤归档组折叠头点击展开（夹具：项目列表 mock 注入一个 archived 条目，或直接写 archived_at 到探针项目后刷新）；⑥diff 确认卡（pending 夹具已有——断言 `.chat-diff-line` 渲染且 approve/reject 可点）；⑦空状态建议卡（新建空 chat_history 项目态）可点；⑧任务卡停止按钮存在性（运行态构造成本高——仅断言非运行态不渲染停止按钮，运行态行为由 verify:mvp 间接覆盖）。

- [ ] **Step 1: 实现探针** → **Step 2: `npm run verify:app-clickability` 连跑 2 次 ok:true** → **Step 3: 提交**

```bash
git add scripts/verify-app-clickability.cjs
git commit -m "test(s4): clickability probes - sections, mode pill, export, archive, diff card, suggestions"
```

## Task 14: verify:chat-online 场景 D（指挥落地）+ E（导出与归档拒绝）

**Files:**
- Modify: `scripts/verify-chat-online.mjs`

**行为规格：**
- 场景 D（闭环 S3 spec §12 条 3）：注册 control 工具 + fake server（runJobs Map + getTaskQueue 返回真实 task-queue、startProjectRun 记录调用不真跑）→ `runChatTurn("把大纲改成「第 2 章沈泽去工地」，然后写到第 2 章")`，auto 路径：项目 tool_permissions 设 yolo:true（同时验 YOLO 真实模型行为）→ 断言：task_plan.md 含新计划文字、队列任务 ≥1、startProjectRun 被调用（或 toolEvents 含 update_outline+queue_chapters+start_run 三者 ok）。pass 判定允许模型少调 start_run（部分模型保守）：核心断言 outline+queue 两步 ok，start_run 调用与否记录入报告不计 fail（行为差异记录，不假断言）。
- 场景 E：①归档项目（直接 updateProjectSettings 写 archived_at）后 `runChatTurn("把第1章六楼改成十二楼")` → 断言 toolEvents 含 `edit_chapter` 且 error=`permission_denied`（或 reply 含「已归档」）；②同项目 `runChatTurn("导出全书")` → export_book 豁免可用（yolo 下自动执行）→ 断言 exports 文件存在。
- 报告 results 加 `D_command_pipeline`、`E_archive_semantics` 两条目。

- [ ] **Step 1: 实现** → **Step 2: `node --check`** → **Step 3: 提交**

```bash
git add scripts/verify-chat-online.mjs
git commit -m "test(s4): online scenarios D command pipeline and E archive semantics"
```

## Task 15: 全量防线 + 真实 API + 交付报告

- [ ] **Step 1: 全量**

```powershell
npm test; npm run verify:mvp; npm run verify:longrun; npm run verify:app-shell; npm run verify:app-clickability; npm run verify:local
```

全部 ok:true。

- [ ] **Step 2: 真实 API**（需用户 key）：`npm run verify:chat-online` → A1/A2/B/C/D/E 全过，报告 JSON 落盘。无 key 则如实标注待跑，不得写已验证。

- [ ] **Step 3: 交付报告** `docs/superpowers/reports/2026-06-12-s4-delivery-report.md`：任务-commit 对照、spec §7 验收 7 条逐条证据（含场景 D 对 S3 spec §12 条 3 的欠账闭环声明）、防线输出、已知问题。**对照 S2a+S3 的教训：验收表必须引用真实跑出的证据文件，禁止「写了等于验了」。**

- [ ] **Step 4: 重新打包**（CLAUDE.md 交付要求）：`npm run verify:local` 过后 `npm run package:dir`，确认 exe 时间戳更新。

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/reports/
git commit -m "docs(s4): delivery report with acceptance evidence and packaging"
```

---

## 计划自审记录（writing-plans Self-Review）

1. **Spec 覆盖核对**：§4.1 导出 → Task 3/4/12（按钮）；§4.2 归档 → Task 1（字段）/2（权限链）/4（工具）/5（server 卡）/12（UI）；§4.3 设置分区+四档 → Task 6/7/8，YOLO 硬底线由 Task 2 的「免确认不免校验」实现（executeTool 原链不变）；§4.4 diff/任务卡/状态条/空状态 → Task 9/10/11；§4.5 探针 → Task 13；§7 验收 7 条 → 1-2 由 Task 3/4/12+15 真实跑，3 由 Task 6/7，4 由 Task 2/8，5 由 Task 9，6 由 Task 13/15，7 由 Task 14。无遗漏。
2. **占位符扫描**：Task 6/7/8/10/11 的 UI 构造给行为规格+插入点+数据源而非整段 DOM 代码——与 S2a+S3 计划对 UI 任务的同等纪律（契约写死、机械展开留实施者）；核心逻辑（权限链、loop 分支、book-export、diff LCS、工具、桥）均有完整代码。Task 3 注记 chapter_index 的 title 字段需实施时核对——已写明两分支处理，非未决占位。
3. **类型一致性**：`checkToolPermission(tool, perms, { archived })` 第三参可选旧调用兼容（Task 2 定义、executeTool/loop 两处消费一致）；`exportBook` 返回 `{ path, chapters, words, skipped }` 在 Task 3 定义、Task 4 工具透传、Task 14 场景 E 消费一致；`archived_at` ISO|null 在 Task 1 校验、Task 4 写入、Task 5 透出、Task 12 消费一致；`auto_approved: true` 仅 Task 2 写入 chat 历史（thread-renderer 现有 tool 卡渲染不需识别它，向后兼容）。
4. **已知实施期核对点**（均已标注于任务内）：settings-runtime 嵌套 patch 白名单现状（Task 7 Step 1）、chapter_index title 字段（Task 3）、app-server 写端点完整清单（Task 5）、HttpError 透传模式（Task 5）。
