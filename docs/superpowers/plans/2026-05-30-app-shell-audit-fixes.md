# app-shell 审计修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复对抗式审计在重写后的 Codex 风格 app-shell 中确认的 21 条真实缺陷（6 high / 10 medium / 5 low），覆盖轮询自愈、功能回归、无障碍与样式。

**Architecture:** 纯前端三文件（`index.html` 静态结构 / `styles.css` 设计样式 / `app.js` 表现层）。后端不改。app.js 每 1800ms 轮询 `/api/dashboard`，把 `events[]+chapters[]+summary` 增量聚合成对话气泡。

**Tech Stack:** 原生 ES Module JS、无框架、Node 内置 test runner、`scripts/verify-app-shell.mjs` 文本断言 + 起服务做后端行为校验。

**两条硬约束（每个任务都不得破坏）：**
1. `app.js` 中 `SIDE_QUESTION_PREFIXES` / `REVIEW_PREFIXES` / `WRITE_PREFIXES` / `MAIN_TASK_IMPACT_PATTERN` 四个常量必须与 `src/core/side-question.mjs` 逐字一致。**本计划不触碰这四个常量。**
2. 每个 `document.querySelector("#id")` 都必须在 `index.html` 有对应元素（verify 脚本强制校验）。新增动态控件一律用 `createElement` + 内联监听器，不新增按 id 查询；确需 id 查询时，必须同步在 `index.html` 加该元素。

**环境注意：当前目录不是 git 仓库。** 跳过所有 `git commit`。每个任务以**验证命令**作为完成检查点：
- `node --check src/app-shell/app.js`（语法）
- `npm run verify:app-shell`（HTML/CSS/JS 文本断言 + 后端行为，期望末尾 `"ok": true`）
- `npm test`（82 个单元测试，期望 `pass 82 / fail 0`）

---

## 文件结构（File Structure）

本计划只改三个文件，各自职责不变：

- **修改** `src/app-shell/index.html` — 静态 DOM 结构 + ARIA 语义（dialog 名称、tablist、combobox、live region、表单可访问名称）。
- **修改** `src/app-shell/styles.css` — 设计样式 + 补缺规则（`.reader-empty`、`.small-button` 变量、`.toast.leaving`、`prefers-reduced-motion`、`:focus-within`、`.sr-only`、`.research-form`）。
- **修改** `src/app-shell/app.js` — 表现层逻辑（轮询自愈、liveBlock 生命周期、滚动粘底、焦点管理/陷阱、inert、动态控件可访问名称、斜杠菜单键盘导航、资料检索表单接线、设置 research_config、live region 播报）。
- **修改（作为测试）** `scripts/verify-app-shell.mjs` — 本仓库没有前端单测框架，verify 脚本的文本断言就是回归测试。每个任务先在此加一条会失败的断言，再实现，遵循 TDD。
- **不改但作为参考** `src/core/app-server.mjs`、`src/core/side-question.mjs`。

任务排序：先修最高风险的轮询自愈（Task 1），再功能回归（Task 2-3），再无障碍（Task 4-8），最后样式与体验（Task 9-11）。任务之间相互独立，可单独验证。

---

<!-- TASKS_ANCHOR -->

### Task 1: 轮询自愈 + 完成竞态 + liveBlock 生命周期（High×1 + Medium×2）

修复三个相互纠缠的轮询缺陷：(a) 任何瞬时 dashboard 错误会 `ensureRefreshLoop(false)` 永久停表；(b) 完成事件 `project_run_finished` 落后于 `project_status=completed`，轮询提前停掉导致气泡卡在「工作中」；(c) 切项目/切空时未重置 `liveBlock`，向已 detach 节点脏写。

**Files:**
- Modify: `src/app-shell/app.js`（`renderError`、`renderDashboard` 的 firstLoad 分支与 `ensureRefreshLoop` 调用点、`renderEmptyThread`、`updateLiveAgentBlock`）
- Test: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: 加失败断言**。在 verify 脚本的 JS 断言区（`assert.ok(js.includes("ensureRefreshLoop"));` 附近）追加：

```js
// Task1: 轮询遇错自愈，不在瞬时错误时永久停表
assert.ok(js.includes("ensureRefreshLoop(true)"));
// Task1: 完成竞态——liveBlock 未定稿时维持轮询
assert.ok(js.includes("Boolean(liveBlock && !liveBlock.done)"));
// Task1: 切项目/切空重置 liveBlock
assert.ok((js.match(/liveBlock = null/g) || []).length >= 3);
```

- [ ] **Step 2: 跑断言确认失败**。Run: `npm run verify:app-shell`。Expected: FAIL（`ensureRefreshLoop(true)` 等字符串当前不存在）。

- [ ] **Step 3a: 改 `renderError` 让轮询自愈**。把 `renderError` 里的 `ensureRefreshLoop(false);` 改为 `ensureRefreshLoop(true);`（仅 `loadDashboard` 的 catch 调用 `renderError`，下一次成功 `loadDashboard→renderDashboard` 会按真实状态收敛）。

- [ ] **Step 3b: 改 `renderDashboard` 完成竞态**。把 `ensureRefreshLoop(summary.projectStatus === "running");` 改为：

```js
  ensureRefreshLoop(summary.projectStatus === "running" || Boolean(liveBlock && !liveBlock.done));
```

- [ ] **Step 3c: firstLoad 与空线程重置 liveBlock**。在 `renderDashboard` 的 `if (firstLoad) {` 块内（`threadGreeted = false;` 之后）加 `liveBlock = null;`；在 `renderEmptyThread()` 内（`threadGreeted = false;` 之后）加 `liveBlock = null;`。

- [ ] **Step 3d: updateLiveAgentBlock 加 isConnected 兜底**。把 `if (!liveBlock || liveBlock.done) {` 改为 `if (!liveBlock || liveBlock.done || !liveBlock.root.isConnected) {`。

- [ ] **Step 4: 语法 + 验证**。Run: `node --check src/app-shell/app.js && npm run verify:app-shell`。Expected: 语法 OK；verify 末尾 `"ok": true`，三条新断言通过。

- [ ] **Step 5: 完成检查点（非 git）**。Run: `npm test`。Expected: `pass 82 / fail 0`（后端未改，应全绿）。

<!-- TASK2_ANCHOR -->

### Task 2: 恢复联网搜索/抓取入口（High）

后端 `/api/research/search` 与 `/api/research/fetch` 仍可用，但新 UI 无任何触发入口。在「运行」抽屉的「资料来源」面板顶部加最小检索表单，复用现有端点。用 `createElement`（不新增 `querySelector("#id")`，满足硬约束 2）。

**Files:**
- Modify: `src/app-shell/app.js`（`renderRunPanel` 内 research 面板；新增模块级 `runResearch`）
- Modify: `src/app-shell/styles.css`（`.research-form`）
- Test: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: 加失败断言**。在 verify 脚本 JS 断言区追加：

```js
// Task2: 资料联网搜索/抓取入口已恢复
assert.ok(js.includes("/api/research/search"));
assert.ok(js.includes("/api/research/fetch"));
assert.ok(js.includes("function runResearch"));
assert.ok(css.includes(".research-form"));
```

- [ ] **Step 2: 跑断言确认失败**。Run: `npm run verify:app-shell`。Expected: FAIL（`/api/research` 当前零命中）。

- [ ] **Step 3a: 在 `renderRunPanel` 的 research 面板插入表单**。定位 `const research = dpanel("资料来源", ...)` 之后、`if (sources.length === 0)` 之前，插入：

```js
  const form = document.createElement("div");
  form.className = "research-form";
  const q = document.createElement("input");
  q.type = "text"; q.placeholder = "搜索关键词"; q.className = "research-input";
  const sBtn = document.createElement("button");
  sBtn.type = "button"; sBtn.className = "small-button"; sBtn.textContent = "搜索";
  sBtn.addEventListener("click", () => runResearch("search", { query: q.value.trim(), limit: 5 }, sBtn));
  const u = document.createElement("input");
  u.type = "url"; u.placeholder = "https://example.com"; u.className = "research-input";
  const fBtn = document.createElement("button");
  fBtn.type = "button"; fBtn.className = "small-button"; fBtn.textContent = "抓取";
  fBtn.addEventListener("click", () => runResearch("fetch", { url: u.value.trim() }, fBtn));
  form.append(q, sBtn, u, fBtn);
  research.body.append(form);
```

- [ ] **Step 3b: 新增模块级 `runResearch`**（放在 `renderRunPanel` 之后）：

```js
async function runResearch(action, body, btn) {
  if ((action === "search" && !body.query) || (action === "fetch" && !body.url)) {
    return showToast(action === "search" ? "请输入搜索关键词。" : "请输入要抓取的网址。", "info");
  }
  btn.disabled = true;
  try {
    await postJson(`/api/research/${action}`, body);
    showToast(action === "search" ? "搜索完成，结果已保存为来源快照。" : "抓取完成，正文已保存为来源快照。", "success");
    await loadDashboard();
  } catch (error) {
    showToast(error?.message ?? "资料检索失败。", "error");
  } finally {
    btn.disabled = false;
  }
}
```

- [ ] **Step 3c: 加 `.research-form` 样式**。在 styles.css 的 `CSS_APPEND_ANCHOR` 之后追加：

```css
.research-form { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; }
.research-form .research-input { flex: 1 1 120px; min-width: 0; font: inherit; font-size: 12.5px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); color: var(--ink); }
.research-form .small-button { flex: 0 0 auto; }
```

- [ ] **Step 4: 语法 + 验证**。Run: `node --check src/app-shell/app.js && npm run verify:app-shell`。Expected: 语法 OK；`"ok": true`，四条新断言通过。

- [ ] **Step 5: 完成检查点**。Run: `npm test`。Expected: `pass 82 / fail 0`。

<!-- TASK3_ANCHOR -->

### Task 3: 设置弹窗恢复 research_config 配置（Medium）

`saveSettings` 砍掉了 `research_config`，用户无处填写 `search_endpoint`/`search_api_key_env`，导致即便开了联网权限也配不出可用搜索后端（与 Task 2 互补）。用现有 `settingField` 助手补字段，`createElement` 不新增 id 查询。

**Files:**
- Modify: `src/app-shell/app.js`（`renderSettingsDetail` 加字段、`saveSettings` 加 `research_config`）
- Test: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: 加失败断言**：

```js
// Task3: 设置可配置联网搜索端点
assert.ok(js.includes("research_config"));
assert.ok(js.includes("settingsFields.searchEndpoint"));
```

- [ ] **Step 2: 跑断言确认失败**。Run: `npm run verify:app-shell`。Expected: FAIL。

- [ ] **Step 3a: `renderSettingsDetail` 加字段**。定位 `settingsFields.maxCalls = settingField(...)` 之后，加：

```js
  const research = lastDashboard?.config?.effective?.research_config ?? lastDashboard?.project?.research_config ?? {};
  settingsFields.searchEndpoint = settingField("联网搜索接口地址", "text", { value: research.search_endpoint ?? "", placeholder: "https://api.example.com/search" });
  settingsFields.searchKeyEnv = settingField("搜索密钥环境变量名", "text", { value: research.search_api_key_env ?? "", placeholder: "SEARCH_API_KEY" });
```

并把这两个 `.field` 追加进 `refs.settingsDetail.append(...)` 列表（在 `settingsFields.network.field` 之后）。

- [ ] **Step 3b: `saveSettings` 提交 research_config**。在 `postJson("/api/settings/update", {...})` 的 body 里，`budget_config` 之后加：

```js
      research_config: compactObject({
        search_endpoint: settingsFields.searchEndpoint.input.value.trim(),
        search_api_key_env: settingsFields.searchKeyEnv.input.value.trim()
      }),
```

- [ ] **Step 4: 语法 + 验证**。Run: `node --check src/app-shell/app.js && npm run verify:app-shell`。Expected: `"ok": true`，两条新断言通过。

- [ ] **Step 5: 完成检查点**。Run: `npm test`。Expected: `pass 82 / fail 0`。

<!-- TASK4_ANCHOR -->

### Task 4: 静态 ARIA 语义 —— dialog 名称、tablist、表单标签（Medium×2）

`#settings-modal`/`#create-card` 是 dialog 但无可访问名称；`#drawer` 缺 dialog 语义；`.dtab` 无 tablist/aria-selected；`#composer-input`/`#settings-search` 仅有 placeholder。全部为 `index.html` 静态属性（不新增元素，不动 id）。

**Files:**
- Modify: `src/app-shell/index.html`
- Modify: `src/app-shell/app.js`（`setDrawerTabActive` 同步 `aria-selected`）
- Test: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: 加失败断言**：

```js
// Task4: dialog 名称与 tablist 语义
assert.ok(html.includes("aria-labelledby=\"create-heading\""));
assert.ok(html.includes("aria-label=\"设置\""));
assert.ok(html.includes("role=\"tablist\""));
assert.ok(html.includes("aria-labelledby=\"drawer-title\""));
assert.ok(js.includes("aria-selected"));
```

- [ ] **Step 2: 跑断言确认失败**。Run: `npm run verify:app-shell`。Expected: FAIL。

- [ ] **Step 3a: index.html 改属性**：
  - `#composer-input`：加 `aria-label="给智能体下达指令"`（若 Task 已加 combobox 属性则一并保留）。
  - `#settings-search`：加 `aria-label="搜索模型平台"`。
  - `#settings-modal`：`<div class="settings-modal" id="settings-modal" role="dialog" aria-modal="true" aria-label="设置">`。
  - `#create-card`：加 `aria-labelledby="create-heading"`（`#create-heading` 已存在）。
  - `#drawer`：`<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" aria-hidden="true">`，并把 `<h3>项目面板</h3>` 改为 `<h3 id="drawer-title">项目面板</h3>`。
  - `#drawer-tabs`：加 `role="tablist"`；三个 `.dtab` 各加 `role="tab"`，章节项 `aria-selected="true"`，其余 `aria-selected="false"`。

- [ ] **Step 3b: app.js `setDrawerTabActive` 同步状态**：

```js
function setDrawerTabActive() {
  for (const button of refs.drawerTabs.querySelectorAll(".dtab")) {
    const on = button.dataset.dtab === drawerTab;
    button.classList.toggle("on", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
  }
}
```

- [ ] **Step 4: 验证**。Run: `node --check src/app-shell/app.js && npm run verify:app-shell`。Expected: `"ok": true`，五条新断言通过。

- [ ] **Step 5: 完成检查点**。Run: `npm test`。Expected: `pass 82 / fail 0`。

<!-- TASK5_ANCHOR -->

### Task 5: 弹窗焦点管理 + inert（High×2）

关闭的弹窗（阅读器/设置/新建）仍留在无障碍树且键盘可达；四个浮层均无焦点陷阱、打开不移入焦点、关闭不回退焦点。用 `inert` 移出关闭态浮层，并加共享焦点助手。

**Files:**
- Modify: `src/app-shell/index.html`（三个 scrim 默认加 `inert`）
- Modify: `src/app-shell/app.js`（焦点助手 + 各 open/close 接线）
- Test: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: 加失败断言**：

```js
// Task5: inert 移出关闭态浮层 + 焦点陷阱/回退
assert.ok(html.includes("id=\"reader-scrim\" inert") || html.includes("inert id=\"reader-scrim\""));
assert.ok(js.includes("function trapTab"));
assert.ok(js.includes("lastFocused"));
assert.ok(js.includes("setAttribute(\"inert\""));
```

- [ ] **Step 2: 跑断言确认失败**。Run: `npm run verify:app-shell`。Expected: FAIL。

- [ ] **Step 3a: index.html 给三个 scrim 加默认 inert**：`<div class="reader-scrim" id="reader-scrim" inert>`、`<div class="settings-scrim" id="settings-scrim" inert>`、`<div class="settings-scrim" id="create-scrim" inert>`。（抽屉用 aria-hidden 路径不变，但 Step 3d 会补 inert。）

- [ ] **Step 3b: 新增模块级焦点助手**（放在文件靠近其它工具函数处）：

```js
let lastFocused = null;
function getFocusable(container) {
  return [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
}
function trapTab(container, event) {
  if (event.key !== "Tab") return;
  const f = getFocusable(container);
  if (!f.length) { event.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
// scrim 同时作为 show 目标与焦点陷阱容器（焦点元素都在 scrim 内的 dialog 里）。
function openOverlay(scrim, firstEl) {
  lastFocused = document.activeElement;
  scrim.removeAttribute("inert");
  scrim.classList.add("show");
  firstEl?.focus?.();
}
function closeOverlay(scrim) {
  scrim.classList.remove("show");
  scrim.setAttribute("inert", "");
  if (lastFocused && lastFocused.isConnected) lastFocused.focus();
  lastFocused = null;
}
```

- [ ] **Step 3c: open/close 接线**。`openReader`/`openSettingsModal`/`openCreateModal` 改用 `openOverlay(refs.readerScrim, refs.readerClose)` / `openOverlay(refs.settingsScrim, refs.settingsSearch)` / `openOverlay(refs.createScrim, refs.createTitle)`；`closeReader`/`closeSettingsModal`/`closeCreateModal` 改用 `closeOverlay(refs.readerScrim)` 等。（注意：无 `refs.reader` 这种引用，统一用 scrim。）

- [ ] **Step 3d: 抽屉用 inert 而非仅 aria-hidden**。`openDrawer` 加 `refs.drawer.removeAttribute("inert")` 与首焦点 `refs.drawerClose.focus()`、记 `lastFocused`；`closeDrawer` 加 `refs.drawer.setAttribute("inert","")` 与焦点回退。index.html 给 `#drawer` 加默认 `inert`。

- [ ] **Step 3e: 全局 keydown 加 Tab 陷阱**。在已有 Esc 处理的 document keydown 监听里，按浮层打开优先级（reader→settings→create→drawer）对当前打开者调用 `trapTab(<container>, event)`。

- [ ] **Step 4: 验证**。Run: `node --check src/app-shell/app.js && npm run verify:app-shell`。Expected: `"ok": true`，四条新断言通过。

- [ ] **Step 5: 完成检查点**。Run: `npm test`。Expected: `pass 82 / fail 0`。

<!-- TASK6_ANCHOR -->

### Task 6: 设置面板动态控件的可访问名称（High×2）

`settingField` 生成的 input/select 与可见标签无可编程关联（password 类型尤甚）；`settingToggle` 的联网权限开关按钮（仅含空 `.sw-dot`）无任何名称。用已传入的 `labelText` 补 `aria-label`。

**Files:**
- Modify: `src/app-shell/app.js`（`settingField`、`settingToggle`）
- Test: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: 加失败断言**：

```js
// Task6: 动态生成的设置控件有可访问名称
assert.ok(js.includes("input.setAttribute(\"aria-label\", labelText)"));
assert.ok(js.includes("button.setAttribute(\"aria-label\", labelText)"));
```

- [ ] **Step 2: 跑断言确认失败**。Run: `npm run verify:app-shell`。Expected: FAIL。

- [ ] **Step 3a: `settingField` 加名称**。在 `field.append(input);` 之前加：

```js
  input.setAttribute("aria-label", labelText);
```

- [ ] **Step 3b: `settingToggle` 加名称**。在 `button.setAttribute("aria-pressed", ...)` 之后加：

```js
  button.setAttribute("aria-label", labelText);
```

- [ ] **Step 4: 验证**。Run: `node --check src/app-shell/app.js && npm run verify:app-shell`。Expected: `"ok": true`，两条新断言通过。

- [ ] **Step 5: 完成检查点**。Run: `npm test`。Expected: `pass 82 / fail 0`。

<!-- TASK7_ANCHOR -->

### Task 7: 斜杠命令菜单的 combobox/listbox 语义与方向键导航（Medium）

斜杠菜单是普通 `<div>` + `<button>`，无 listbox/option 角色、无方向键移动、无 `aria-activedescendant`，SR 在输入 `/` 后不知道出现了候选。补 ARIA 组合框模式 + ArrowUp/Down。

> 注：`#composer-input` 的 combobox 属性与 `#slash-menu` 的 `role="listbox" aria-label="斜杠命令"` 可能已在前序编辑加入；本任务断言会校验，若已存在则该步为 no-op。

**Files:**
- Modify: `src/app-shell/index.html`（combobox/listbox 属性，若未加）
- Modify: `src/app-shell/app.js`（`buildSlashItem` 加 option 角色、`updateSlashMenu`/`hideSlashMenu` 维护 expanded、`onComposerKeydown` 加方向键、模块级 `slashActiveIndex` + `setSlashActive`）
- Test: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: 加失败断言**：

```js
// Task7: 斜杠菜单 ARIA + 键盘导航
assert.ok(html.includes("role=\"combobox\""));
assert.ok(html.includes("aria-controls=\"slash-menu\""));
assert.ok(js.includes("aria-activedescendant"));
assert.ok(js.includes("setSlashActive"));
assert.ok(js.includes("ArrowDown"));
```

- [ ] **Step 2: 跑断言确认失败**。Run: `npm run verify:app-shell`。Expected: FAIL。

- [ ] **Step 3a: index.html（若未加）**：`#composer-input` 加 `role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="slash-menu" aria-haspopup="listbox"`；`#slash-menu` 加 `role="listbox" aria-label="斜杠命令"`。

- [ ] **Step 3b: 模块级状态 + `setSlashActive`**：

```js
let slashActiveIndex = 0;
function setSlashActive(i) {
  const items = [...refs.slashMenu.querySelectorAll(".slash-item")];
  if (!items.length) return;
  slashActiveIndex = (i + items.length) % items.length;
  items.forEach((el, idx) => {
    const on = idx === slashActiveIndex;
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
    if (on) refs.composerInput.setAttribute("aria-activedescendant", el.id);
  });
}
```

- [ ] **Step 3c: `buildSlashItem` 给每项加 id + option 角色**。在创建 `button` 后加：

```js
  button.id = "slash-opt-" + cmd.key.slice(1);
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", "false");
```

- [ ] **Step 3d: `updateSlashMenu` 末尾**（`refs.slashMenu.hidden = false;` 之后）：

```js
  refs.composerInput.setAttribute("aria-expanded", "true");
  setSlashActive(0);
```

- [ ] **Step 3e: `hideSlashMenu` 内**加：

```js
  refs.composerInput.setAttribute("aria-expanded", "false");
  refs.composerInput.removeAttribute("aria-activedescendant");
  slashActiveIndex = 0;
```

- [ ] **Step 3f: `onComposerKeydown` 在 `if (!refs.slashMenu.hidden)` 块内、Tab 分支之前加方向键**，并把 Enter/Tab 改为选中当前项：

```js
    const items = [...refs.slashMenu.querySelectorAll(".slash-item")];
    if (event.key === "ArrowDown") { event.preventDefault(); setSlashActive(slashActiveIndex + 1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setSlashActive(slashActiveIndex - 1); return; }
    if ((event.key === "Enter" || event.key === "Tab") && items[slashActiveIndex]) { event.preventDefault(); items[slashActiveIndex].click(); return; }
```

- [ ] **Step 4: 验证**。Run: `node --check src/app-shell/app.js && npm run verify:app-shell`。Expected: `"ok": true`，五条新断言通过。

- [ ] **Step 5: 完成检查点**。Run: `npm test`。Expected: `pass 82 / fail 0`。

<!-- TASK8_ANCHOR -->

### Task 8: reduced-motion + 焦点轮廓 + 对话流 live region（Medium×1 + Low×2）

三个独立的无障碍补丁，集中处理：(a) 全站无 `prefers-reduced-motion`，`.spin`/`pulse` 无限动画不可暂停；(b) `.composer textarea` 设了 `outline:none` 却无替代焦点指示（`.composer.focus` 是死代码）；(c) 对话流增量更新不在 live region，SR 无法感知写作进度。

**Files:**
- Modify: `src/app-shell/styles.css`（reduced-motion 块、`:focus-within`、`.sr-only`）
- Modify: `src/app-shell/index.html`（`#thread-status` live region）
- Modify: `src/app-shell/app.js`（`refs.threadStatus` + `announce` + 调用点）
- Test: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: 加失败断言**：

```js
// Task8: reduced-motion / 焦点指示 / live region
assert.ok(css.includes("prefers-reduced-motion"));
assert.ok(css.includes(".composer:focus-within"));
assert.ok(css.includes(".sr-only"));
assert.ok(html.includes("id=\"thread-status\""));
assert.ok(js.includes("function announce"));
```

- [ ] **Step 2: 跑断言确认失败**。Run: `npm run verify:app-shell`。Expected: FAIL。

- [ ] **Step 3a: styles.css reduced-motion 块**（追加到 `CSS_APPEND_ANCHOR` 之后）：

```css
@media (prefers-reduced-motion: reduce) {
  .spin { animation: none; }
  .proj-dot.running, .pill.running .pdot { animation: none; }
  .rise, .toast { animation: none; opacity: 1; transform: none; }
  .thread-wrap { scroll-behavior: auto; }
}
```

- [ ] **Step 3b: 焦点指示**。把 styles.css 第 516 行 `.composer.focus { ... }` 改为 `.composer.focus, .composer:focus-within { border-color: #d2cdc3; box-shadow: var(--shadow-pop); }`。

- [ ] **Step 3c: `.sr-only` 助手**（追加到 styles.css）：

```css
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
```

- [ ] **Step 3d: index.html 加 live region**。在 `#toast-stack` 附近加：`<div id="thread-status" class="sr-only" role="status" aria-live="polite"></div>`。

- [ ] **Step 3e: app.js refs + announce**。`refs` 加 `threadStatus: document.querySelector("#thread-status")`；新增模块级 `let lastAnnounce = "";` 与：

```js
function announce(msg) {
  if (refs.threadStatus && msg && msg !== lastAnnounce) {
    lastAnnounce = msg;
    refs.threadStatus.textContent = msg;
  }
}
```

调用点（仅有意义的状态转移，靠 `lastAnnounce` 去重防 1800ms 重复播报）：新增用户气泡时 `announce("已发送指令")`；运行开始时 `announce("智能体开始写作")`；`updateLiveAgentBlock` 内 `announce(ch ? \`正在写第 ${ch} 章\` : "工作中")`；`finishAgentBlock` 内 `announce(block.say.textContent)`。

- [ ] **Step 4: 验证**。Run: `node --check src/app-shell/app.js && npm run verify:app-shell`。Expected: `"ok": true`，五条新断言通过。

- [ ] **Step 5: 完成检查点**。Run: `npm test`。Expected: `pass 82 / fail 0`。

<!-- TASK9_ANCHOR -->

### Task 9: CSS 完整性 —— reader-empty / small-button 变量 / toast.leaving（Medium×2 + Low×1）

三个「类已挂但样式缺失/失效」缺陷：(a) `.reader-empty` 无规则，命中 `.reader-body p::first-letter` 被渲染成巨型首字下沉；(b) `.small-button` 引用未定义变量 `--paper`，背景丢失变透明；(c) `.toast.leaving` 无规则，220ms 离场动画形同虚设。全部纯 CSS。

**Files:**
- Modify: `src/app-shell/styles.css`
- Test: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: 加失败断言**：

```js
// Task9: 补齐缺失/失效的样式
assert.ok(css.includes(".reader-body p.reader-empty"));
assert.ok(!css.includes("var(--paper)"));
assert.ok(css.includes(".toast.leaving"));
```

- [ ] **Step 2: 跑断言确认失败**。Run: `npm run verify:app-shell`。Expected: FAIL（`.reader-empty` 无规则、`var(--paper)` 仍在、`.toast.leaving` 无规则）。

- [ ] **Step 3a: reader-empty 中和首字下沉**。在 styles.css 的 `.reader-body p:first-child::first-letter { ... }` 之后追加：

```css
.reader-body p.reader-empty { text-indent: 0; color: var(--muted); font-style: italic; }
.reader-body p.reader-empty:first-child::first-letter { font-size: inherit; font-weight: inherit; float: none; padding: 0; color: inherit; }
```

- [ ] **Step 3b: 修 `--paper` 未定义**。把 `.small-button` 规则里的 `background: var(--paper);` 改为 `background: var(--surface-2);`（已定义的暖白纸面令牌）。

- [ ] **Step 3c: toast 离场动画**。给 `.toast` 规则追加 `transition: opacity .22s ease, transform .22s ease;`，并新增 `.toast.leaving { opacity: 0; transform: translateY(7px); }`。

- [ ] **Step 4: 验证**。Run: `npm run verify:app-shell`。Expected: `"ok": true`，三条新断言通过（注意 `!css.includes("var(--paper)")` 反向断言：确保全表再无 `--paper` 引用）。

- [ ] **Step 5: 完成检查点**。Run: `npm test`。Expected: `pass 82 / fail 0`。

<!-- TASK10_ANCHOR -->

### Task 10: 滚动保持 —— 对话流粘底 + 抽屉重建保位（Medium×1 + Low×1）

两个滚动抖动缺陷：(a) `syncThread` 每次轮询无条件滚到底，运行中用户无法向上翻阅；(b) 抽屉打开且运行中时，每 1800ms `replaceChildren` 重建面板，丢失用户在抽屉内的滚动位置。

**Files:**
- Modify: `src/app-shell/app.js`（`syncThread` 粘底判断；`renderDashboard` 抽屉重建前后存取 `scrollTop`）
- Test: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: 加失败断言**：

```js
// Task10: 仅在贴底时自动滚动 + 抽屉重建保留滚动位置
assert.ok(js.includes("clientHeight < 80"));
assert.ok(js.includes("refs.drawerBody.scrollTop = "));
```

- [ ] **Step 2: 跑断言确认失败**。Run: `npm run verify:app-shell`。Expected: FAIL。

- [ ] **Step 3a: `syncThread` 粘底判断**。在 `syncThread` 函数体最顶部（任何 append 之前，因为 append 会增大 scrollHeight）捕获：

```js
  const wrap = refs.threadWrap;
  const stick = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
```

并把函数末尾无条件的 `scrollThreadToBottom();` 改为 `if (stick) scrollThreadToBottom();`（firstLoad 时线程刚清空，scrollHeight≈clientHeight，stick 为 true，新项目仍会滚到底）。

- [ ] **Step 3b: `renderDashboard` 抽屉重建保位**。把抽屉重建调用：

```js
  if (refs.drawer.classList.contains("show")) renderDrawerBody();
```

改为：

```js
  if (refs.drawer.classList.contains("show")) {
    const top = refs.drawerBody.scrollTop;
    renderDrawerBody();
    refs.drawerBody.scrollTop = top;
  }
```

- [ ] **Step 4: 验证**。Run: `node --check src/app-shell/app.js && npm run verify:app-shell`。Expected: `"ok": true`，两条新断言通过。

- [ ] **Step 5: 完成检查点**。Run: `npm test`。Expected: `pass 82 / fail 0`。

<!-- TASK11_ANCHOR -->

### Task 11: 接通死按钮 #settings-add（Low）

`index.html:125` 的 `<button id="settings-add">添加</button>` 被取入 `refs.settingsAdd` 但从未绑定 click，是死控件。接上「选中并配置自定义供应商」行为（只改 app.js，HTML/verify 不受影响）。

**Files:**
- Modify: `src/app-shell/app.js`（在事件绑定区给 `refs.settingsAdd` 加监听）
- Test: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: 加失败断言**：

```js
// Task11: 添加按钮已接线
assert.ok(js.includes("refs.settingsAdd.addEventListener"));
```

- [ ] **Step 2: 跑断言确认失败**。Run: `npm run verify:app-shell`。Expected: FAIL（`settingsAdd` 当前仅在 refs 定义处出现一次）。

- [ ] **Step 3: 接线**。在 `refs.settingsSearch.addEventListener(...)` 绑定之后追加：

```js
  refs.settingsAdd.addEventListener("click", () => {
    settingsProviderId = "custom";
    refs.settingsSearch.value = "";
    renderSettingsProviders();
    renderSettingsDetail();
  });
```

- [ ] **Step 4: 验证**。Run: `node --check src/app-shell/app.js && npm run verify:app-shell`。Expected: `"ok": true`，新断言通过。

- [ ] **Step 5: 完成检查点**。Run: `npm test`。Expected: `pass 82 / fail 0`。

---

## 最终全量验证（所有任务完成后）

- [ ] Run: `node --check src/app-shell/app.js` → 语法 OK
- [ ] Run: `npm run verify:app-shell` → 末尾 `"ok": true`，全部新增断言通过
- [ ] Run: `npm test` → `pass 82 / fail 0`
- [ ] 可选回归：`npm run verify:local`（若环境允许长跑）
- [ ] 手动冒烟：`npm run app:shell` 起服务，逐项点检——新建/打开小说、发指令看运行气泡定稿、隐私模糊、抽屉三页、设置保存、章节阅读器、资料搜索表单、键盘 Tab 走查（焦点陷阱 + Esc 关闭 + 斜杠菜单方向键）。

## 缺陷→任务 对照（21 条确认项全覆盖）

| # | 严重级 | 缺陷 | 任务 |
|---|---|---|---|
| 1 | High | 轮询遇瞬时错误永久停表 | Task 1 |
| 2 | High | 联网搜索/抓取入口整组回归 | Task 2 |
| 3 | High | 关闭弹窗仍在无障碍树 | Task 5 |
| 4 | High | 无焦点管理/陷阱/回退 | Task 5 |
| 5 | High | 设置输入无可访问名称 | Task 6 |
| 6 | High | 联网开关无可访问名称 | Task 6 |
| 7 | Medium | settings 砍掉 research_config | Task 3 |
| 8 | Medium | 斜杠菜单缺 ARIA/方向键 | Task 7 |
| 9 | Medium | 无 prefers-reduced-motion | Task 8 |
| 10 | Medium | 弹窗/抽屉缺 dialog 名称与 tablist | Task 4 |
| 11 | Medium | liveBlock 切项目未重置 | Task 1 |
| 12 | Medium | 完成竞态气泡卡「工作中」 | Task 1 |
| 13 | Medium | 轮询强制滚底 | Task 10 |
| 14 | Medium | reader-empty 首字下沉污染 | Task 9 |
| 15 | Medium | small-button 引用未定义 --paper | Task 9 |
| 16 | Medium | 主输入框/搜索框/弹窗缺标签 | Task 4 |
| 17 | Low | #settings-add 死按钮 | Task 11 |
| 18 | Low | toast.leaving 无样式 | Task 9 |
| 19 | Low | 对话流不在 live region | Task 8 |
| 20 | Low | 主输入框无焦点指示 | Task 8 |
| 21 | Low | 抽屉重建丢滚动位置 | Task 10 |











