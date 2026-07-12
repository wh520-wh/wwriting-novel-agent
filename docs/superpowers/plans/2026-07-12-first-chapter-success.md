# 首章成功路径 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 使用并行处理方式 (recommended) 或 superpowers:executing-plans 来实现此计划中的任务。步骤使用复选框（\`- [ ]\`）语法进行任务跟踪。

**Goal:** 让用户从创建/打开小说开始，在一个可理解的准备状态页面中完成模型确认、启动第 1 章、看到真实运行状态并阅读完成章节，同时不改变 Agent 核心状态机、项目文件 schema 或模型调用协议。

**Architecture:** 使用一个无副作用的 deriveWriteReadiness(data) 纯函数统一解释 /api/dashboard 的项目状态、模型配置、连接测试事件和章节 artifact。app.js 只负责把派生结果渲染为准备卡/运行卡/完成卡，composer.js 通过已有 submitWritingCommand() 发起写作；不新增后端 API 或持久化字段。

**Tech Stack:** 原生 JavaScript ES modules、Node.js node:test、Electron、现有 app-shell/dashboard API、PowerShell 验收脚本。

---

## 范围与文件地图

本计划只执行 docs/superpowers/specs/2026-07-12-first-chapter-success-design.md，不同时实施模型库、完整 Story Bible、导航大重构或成书导出重做。

| 文件 | 责任 |
|---|---|
| src/app-shell/write-readiness.mjs | 纯函数：把 dashboard 数据派生为统一的写作准备状态 |
| tests/app-shell/write-readiness.test.mjs | 准备状态的表驱动单元测试 |
| src/app-shell/index.html | 稳定的准备卡/完成卡容器 |
| src/app-shell/app.js | 读取派生状态、渲染卡片、接线按钮、在 dashboard 刷新时更新卡片 |
| src/app-shell/composer.js | 暴露受控的 startCurrentChapter，内部复用现有写作提交路径 |
| src/app-shell/styles.css | 准备卡、运行态、阻塞态、完成态和响应式样式 |
| tests/app-shell/app-shell-static.test.mjs | 静态检查新模块、容器、按钮和现有 API 接线 |
| tests/app-shell/composer-intent.test.mjs | 确认受控启动仍走写作意图路径 |
| tests/app-server-probe.test.mjs | 创建项目、配置失败和启动第 1 章的服务端回归覆盖 |
| scripts/verify-app-clickability.cjs | 真实 Electron 点击链路探针 |
| scripts/verify-app-shell.mjs | app-shell API、DOM 和 dashboard 数据断言 |
| docs/USER_GUIDE.zh-CN.md | 用户可读的首次写作流程说明 |

不修改：src/core/agent-engine.mjs、src/core/task-queue.mjs、项目 JSON/YAML schema 和现有写作工具协议。

## Task 1: 锁定自定义模型保存回归

**Files:**
- Modify: tests/app-server-probe.test.mjs
- Modify: scripts/verify-app-clickability.cjs
- Modify: src/app-shell/settings-modal.js（仅当回归验证确认需要修改）

- [ ] **Step 1: 记录基线并运行现有发布阻塞验证**

~~~powershell
git status --short
npm run verify:app-clickability
~~~

预期：记录是否仍出现自定义模型保存失败；不要修改用户已有的 src/core/agent-engine.mjs、.vs/ 或临时验收文件。若当前验证已经通过，保留现有实现，只补充防回归断言。

- [ ] **Step 2: 写自定义模型保存回归测试**

在 tests/app-server-probe.test.mjs 的模型设置测试区域新增测试，使用该文件已有的 fixture、port、postJson 和 getJson：

~~~js
test("custom model settings persist the submitted base URL and model id", async () => {
  const customModelId = "writer-custom-" + Date.now();
  const customApiKey = "sk-custom-" + Date.now();
  const { res, data } = await postJson(port, "/api/settings/update", {
    active_model: {
      provider: "openai-compatible",
      model_name: customModelId,
      base_url: "https://api.example.test/v1",
      api_key_env: "WWRITING_PROVIDER_API_KEY",
      api_key: customApiKey,
      max_output_tokens: 4096
    }
  });
  assert.equal(res.status, 200);
  assert.equal(data.project.active_model.model_name, customModelId);
  assert.equal(data.project.active_model.base_url, "https://api.example.test/v1");
  const dashboard = await getJson(port, "/api/dashboard");
  assert.equal(dashboard.project.active_model.model_name, customModelId);
  assert.equal(dashboard.model_profile.model_name, customModelId);
});
~~~

- [ ] **Step 3: 运行回归测试确认基线**

~~~powershell
node --test tests/app-server-probe.test.mjs
~~~

预期：若失败，失败信息必须落在 base_url、模型 ID 或保存后的 dashboard 数据；若通过，不再改设置保存逻辑。

- [ ] **Step 4: 只在失败时修复自定义预设错误呈现**

如果失败原因是 settings-modal.js 中自定义预设的 baseUrl 为空导致用户点击保存后才发现配置不完整，保持后端严格校验，在 saveModelSection() 保存前显示字段错误并返回 false：

~~~js
if (provider === "openai-compatible" && !baseUrl) {
  settingsFields.baseUrlError.hidden = false;
  settingsFields.baseUrlError.textContent = "OpenAI 兼容模型必须填写基础 URL。";
  settingsFields.baseUrl.input.focus();
  return false;
}
~~~

调用方必须检查 false，不得发送保存请求或显示“已保存”。如果当前已有字段级错误，只补测试断言。

- [ ] **Step 5: 运行设置和点击验证**

~~~powershell
node --test tests/app-server-probe.test.mjs tests/app-shell/settings-modal.test.mjs
npm run verify:app-clickability
~~~

预期：自定义模型保存后 dashboard 显示提交的模型 ID；空基础 URL 显示错误且不产生假成功；Electron 点击脚本 exit 0。

- [ ] **Step 6: 提交独立基线修复**

仅在本 Task 有实际修改时执行：

~~~powershell
git add tests/app-server-probe.test.mjs scripts/verify-app-clickability.cjs src/app-shell/settings-modal.js
git commit -m "test: lock custom model setup behavior"
~~~

## Task 2: 以 TDD 实现 deriveWriteReadiness

**Files:**
- Create: src/app-shell/write-readiness.mjs
- Create: tests/app-shell/write-readiness.test.mjs

- [ ] **Step 1: 写表驱动失败测试**

创建 tests/app-shell/write-readiness.test.mjs，覆盖无项目、缺模型、演示模型、连接成功、旧模型连接事件、运行中、阻塞、完成和只读优先级：

~~~js
import assert from "node:assert/strict";
import test from "node:test";
import { deriveWriteReadiness } from "../../src/app-shell/write-readiness.mjs";

const base = {
  hasProject: true,
  project: {
    title: "夜航钟表铺",
    target_chapters: 10,
    active_model: {
      provider: "openai-compatible",
      model_name: "deepseek-chat",
      base_url: "https://api.deepseek.com",
      api_key_env: "DEEPSEEK_API_KEY"
    },
    tool_permissions: {}
  },
  model_profile: {
    display: "DeepSeek · deepseek-chat",
    model_name: "deepseek-chat",
    is_mock: false
  },
  summary: {
    completedChapters: 0,
    targetChapters: 10,
    currentChapterNo: 1,
    projectStatus: "idle"
  },
  state: { project_status: "idle", current_chapter_no: 1 },
  chatHistory: { busy: false },
  events: [],
  failures: []
};

function data(overrides = {}) {
  return {
    ...base,
    ...overrides,
    project: { ...base.project, ...(overrides.project || {}) },
    model_profile: { ...base.model_profile, ...(overrides.model_profile || {}) },
    summary: { ...base.summary, ...(overrides.summary || {}) },
    state: { ...base.state, ...(overrides.state || {}) }
  };
}

test("key readiness states", () => {
  assert.equal(deriveWriteReadiness({ hasProject: false }).key, "no_project");
  assert.equal(
    deriveWriteReadiness(data({ project: { active_model: null }, model_profile: null })).key,
    "missing_model"
  );
  assert.equal(
    deriveWriteReadiness(data({
      model_profile: { is_mock: true, display: "演示模型", model_name: "mock-writer" }
    })).key,
    "demo"
  );
  assert.equal(
    deriveWriteReadiness(data({
      events: [{ type: "model_connection_tested", data: { model_name: "deepseek-chat", ok: true } }]
    })).key,
    "ready"
  );
  assert.equal(
    deriveWriteReadiness(data({
      events: [{ type: "model_connection_tested", data: { model_name: "old-model", ok: true } }]
    })).key,
    "connection_unknown"
  );
});

test("project states take precedence", () => {
  assert.equal(deriveWriteReadiness(data({ summary: { projectStatus: "running" } })).key, "running");
  assert.equal(deriveWriteReadiness(data({ summary: { projectStatus: "blocked" } })).key, "blocked");
  assert.equal(deriveWriteReadiness(data({ summary: { completedChapters: 10 } })).key, "completed");
  assert.equal(
    deriveWriteReadiness(data({ project: { archived_at: "2026-07-12T00:00:00Z" } })).key,
    "project_read_only"
  );
  assert.equal(
    deriveWriteReadiness(data({ project: { tool_permissions: { read_only: true } } })).key,
    "project_read_only"
  );
});
~~~

- [ ] **Step 2: 运行失败测试**

~~~powershell
node --test tests/app-shell/write-readiness.test.mjs
~~~

预期：FAIL，原因是 write-readiness.mjs 尚不存在或没有导出 deriveWriteReadiness。

- [ ] **Step 3: 实现纯函数模块**

创建 src/app-shell/write-readiness.mjs。固定优先级为：无项目；归档/只读；运行中/chat busy；阻塞/未解决 failure；目标完成；缺模型；模型字段不完整；mock/demo；匹配当前模型的成功连接事件；连接未知。

返回对象固定包含：

~~~js
{
  key,
  label,
  detail,
  primaryAction,
  primaryLabel,
  chapterNo,
  modelLabel,
  blocking,
  reasonCode
}
~~~

实现只读取输入对象，不调用网络、文件、DOM、localStorage，不启动任务。真实模型只有在最新的 model_connection_tested 事件中，data.model_name 与当前 active_model.model_name 匹配且 data.ok === true 时才返回 ready。失败探测返回 invalid_model，未找到匹配探测返回 connection_unknown。mock-writer 返回 demo，但允许 start_chapter。

- [ ] **Step 4: 运行纯函数测试**

~~~powershell
node --test tests/app-shell/write-readiness.test.mjs
~~~

预期：所有状态测试 PASS，且无未捕获异常。

- [ ] **Step 5: 提交纯函数边界**

~~~powershell
git add src/app-shell/write-readiness.mjs tests/app-shell/write-readiness.test.mjs
git commit -m "feat: derive first-chapter writing readiness"
~~~

## Task 3: 接入准备卡与章节完成卡

**Files:**
- Modify: src/app-shell/index.html
- Modify: src/app-shell/app.js
- Modify: src/app-shell/styles.css
- Modify: tests/app-shell/app-shell-static.test.mjs

- [ ] **Step 1: 写静态结构失败测试**

在 app-shell-static.test.mjs 读取 index.html，并断言 write-readiness、write-readiness-primary、write-readiness-secondary、chapter-success、chapter-success-read、chapter-success-continue 六个稳定 ID；同时断言 app.js 从 ./write-readiness.mjs 导入 deriveWriteReadiness。

- [ ] **Step 2: 运行静态测试确认新结构不存在**

~~~powershell
node --test tests/app-shell/app-shell-static.test.mjs
~~~

预期：新增断言 FAIL，既有测试不得产生无关失败。

- [ ] **Step 3: 加入稳定卡片容器**

在 index.html 的 activity-strip 之后加入：

~~~html
<section class="write-readiness" id="write-readiness" aria-labelledby="write-readiness-title" hidden>
  <div>
    <p class="eyebrow">准备写作</p>
    <h2 id="write-readiness-title"></h2>
    <p id="write-readiness-detail"></p>
    <div id="write-readiness-meta"></div>
  </div>
  <div class="write-readiness-actions">
    <button id="write-readiness-primary" type="button"></button>
    <button id="write-readiness-secondary" type="button" hidden></button>
    <button id="write-readiness-tertiary" type="button" hidden></button>
  </div>
</section>

<section class="chapter-success" id="chapter-success" aria-labelledby="chapter-success-title" hidden>
  <div>
    <p class="eyebrow">章节完成</p>
    <h2 id="chapter-success-title"></h2>
    <p id="chapter-success-meta"></p>
    <p id="chapter-success-review"></p>
  </div>
  <div class="chapter-success-actions">
    <button id="chapter-success-read" type="button">阅读本章</button>
    <button id="chapter-success-continue" type="button">继续下一章</button>
  </div>
</section>
~~~

- [ ] **Step 4: 在 app.js 统一渲染准备状态**

导入 deriveWriteReadiness，在 refs 中登记新元素。增加 handleReadinessAction(view)，映射必须是：create_project → openCreateModal；open_project → openFromFolder；open_settings/test_connection/increase_target → openSettingsModal；start_chapter → composer.startCurrentChapter；view_progress/view_project_status → run 抽屉；view_issue → reviewer 抽屉。

renderWriteReadiness(data) 只消费 deriveWriteReadiness 的结果，展示小说标题、模型标签和当前章节。在 renderDashboard() 的无项目分支与有项目分支都调用它。无项目时准备卡仍可见，主按钮为“新建小说”，次按钮为“打开本地文件夹”；有项目时次按钮按数据改为“查看章节”或“打开故事资料”。卡片只在运行态和章节完成卡占据主区时隐藏，不创建自己的轮询器。

- [ ] **Step 5: 接入章节完成卡**

从 data.chapters 中筛选 chapter.artifact.state === "committed" 的最新章节；当存在 committed 章节且当前没有运行中的任务时显示完成卡，不要求整本项目达到 completed。展示实际字数、格式和审查结果。阅读按钮调用 openReader(chapter.chapter_no)，继续按钮调用 composer.startCurrentChapter。不得用 chat 文本判断完成。

- [ ] **Step 6: 增加响应式样式**

准备卡和完成卡使用 8px 圆角、最小高度 148px、按钮最小高度 36px；窄屏改为纵向布局，操作区允许换行。卡片不得覆盖 thread、composer 或浮层，不增加装饰性渐变。

- [ ] **Step 7: 运行静态测试**

~~~powershell
node --test tests/app-shell/app-shell-static.test.mjs
~~~

预期：新结构和接线断言 PASS，既有测试全部 PASS。

- [ ] **Step 8: 提交首屏卡片**

~~~powershell
git add src/app-shell/index.html src/app-shell/app.js src/app-shell/styles.css tests/app-shell/app-shell-static.test.mjs
git commit -m "feat: add writing readiness and chapter success cards"
~~~

## Task 4: 暴露受控的开始当前章节入口

**Files:**
- Modify: src/app-shell/composer.js
- Modify: src/app-shell/app.js
- Modify: tests/app-shell/composer-intent.test.mjs

- [ ] **Step 1: 写入口失败测试**

使用现有 createComposer fixture，断言 composer.startCurrentChapter() 最终请求 /api/commands/submit，请求体为：

~~~js
{
  message: "开始写第 1 章",
  mode: "write",
  fromSideQuestion: false
}
~~~

同时断言未调用 /api/chat/send。

- [ ] **Step 2: 运行测试确认入口不存在**

~~~powershell
node --test tests/app-shell/composer-intent.test.mjs
~~~

预期：新增测试 FAIL，原因是 startCurrentChapter 尚未导出。

- [ ] **Step 3: 增加最小包装函数**

在 composer.js 的 submitWritingCommand() 后加入：

~~~js
async function startCurrentChapter() {
  const dashboard = ctx.getDashboard?.() || {};
  const chapterNo = Number(
    dashboard.summary?.currentChapterNo ||
    dashboard.state?.current_chapter_no ||
    1
  );
  await submitWritingCommand("开始写第 " + chapterNo + " 章", "write");
}
~~~

在 createComposer() 返回对象中导出 startCurrentChapter。不得新增 quick-start API，不得直接调用 runProject()。

- [ ] **Step 4: 让卡片只调用受控入口**

app.js 的准备卡和完成卡按钮都使用 void composer.startCurrentChapter()，不复制 postJson 调用。

- [ ] **Step 5: 运行 composer 和静态测试**

~~~powershell
node --test tests/app-shell/composer-intent.test.mjs tests/app-shell/app-shell-static.test.mjs
~~~

预期：新增入口测试 PASS，原有自然语言开始/继续写作测试 PASS。

- [ ] **Step 6: 提交受控入口**

~~~powershell
git add src/app-shell/composer.js src/app-shell/app.js tests/app-shell/composer-intent.test.mjs
git commit -m "feat: expose controlled chapter start action"
~~~

## Task 5: 补齐 dashboard 与连接测试语义

**Files:**
- Modify: tests/app-server-probe.test.mjs
- Modify: tests/app-dashboard.test.mjs
- Modify: src/app-shell/write-readiness.mjs（仅当测试暴露字段口径问题时）

- [ ] **Step 1: 增加初始化后 dashboard 断言**

在现有 /api/projects/init 测试后读取 /api/dashboard，确认 hasProject、project.story_seed、summary.currentChapterNo、summary.targetChapters、summary.projectStatus 与刚创建的项目一致。

- [ ] **Step 2: 增加连接事件匹配测试**

成功事件的 model_name 与 active model 一致时 readiness 为 ready；旧模型事件存在时 readiness 仍为 connection_unknown；失败事件返回 invalid_model 并保留 reasonCode。

- [ ] **Step 3: 运行服务端和 readiness 测试**

~~~powershell
node --test tests/app-server-probe.test.mjs tests/app-dashboard.test.mjs tests/app-shell/write-readiness.test.mjs
~~~

预期：项目初始化、dashboard 字段、连接事件匹配和 readiness 状态全部 PASS。

- [ ] **Step 4: 确认没有新增 quick-start API**

~~~powershell
rg -n "/api/(quick-start|write-readiness|preflight)" src tests scripts
~~~

预期：无匹配；首章按钮只调用已有 /api/commands/submit。

- [ ] **Step 5: 提交数据语义测试**

~~~powershell
git add tests/app-server-probe.test.mjs tests/app-dashboard.test.mjs src/app-shell/write-readiness.mjs
git commit -m "test: verify readiness dashboard semantics"
~~~

## Task 6: 增加真实 Electron 首章点击链路

**Files:**
- Modify: scripts/verify-app-clickability.cjs
- Modify: scripts/verify-app-shell.mjs
- Modify: tests/app-shell/app-shell-static.test.mjs

- [ ] **Step 1: 准备空对话 fixture**

复用现有脚本 projectRoot 和 mock server，不依赖真实 API key。清理 chat_history.jsonl 和 chat_pending_action.json，刷新页面并等待 write-readiness 可见。

- [ ] **Step 2: 增加准备卡点击探针**

断言准备卡可见、主按钮包含“写第 1 章”；点击后等待规划/写作状态或 topbar-stop 可见。探针标签固定为 first-chapter-start。

- [ ] **Step 3: 增加完成卡阅读探针**

等待 committed artifact 后断言 chapter-success 可见、标题包含第 1 章，点击 chapter-success-read 后 reader-scrim 显示。探针标签固定为 chapter-success-read。

- [ ] **Step 4: 补 app-shell 初始化后断言**

在 verify-app-shell.mjs 的 projects/init 流程后读取 dashboard，断言故事种子、目标章节、当前章节和项目状态；请求仍经过既有 project scope。

- [ ] **Step 5: 运行 Electron 和 app-shell 验收**

~~~powershell
npm run verify:app-shell
npm run verify:app-clickability
~~~

预期：两个脚本 exit 0；输出包含 first-chapter-start 和 chapter-success-read。

- [ ] **Step 6: 提交点击探针**

~~~powershell
git add scripts/verify-app-clickability.cjs scripts/verify-app-shell.mjs tests/app-shell/app-shell-static.test.mjs
git commit -m "test: verify first chapter success flow"
~~~

## Task 7: 更新指南并执行完整交付门槛

**Files:**
- Modify: docs/USER_GUIDE.zh-CN.md
- Modify: progress.md
- Modify: task_plan.md

- [ ] **Step 1: 新增首次写作流程说明**

指南必须说明：新建小说；阅读准备卡；缺模型时配置并测试；真实模型或演示模型状态；开始第 1 章；运行中停止；完成后阅读；继续下一章。明确“演示模型不代表已经连接真实供应商”。

- [ ] **Step 2: 运行完整测试**

~~~powershell
npm test
~~~

预期：所有测试 PASS，测试总数不低于实施前基线。

- [ ] **Step 3: 运行 UI/Electron 验收**

~~~powershell
npm run verify:app-clickability
npm run verify:app-shell
npm run verify:desktop-shell
~~~

预期：全部 exit 0；clickability 失败必须定位真实事件命中链路，不能只改选择器绕过。

- [ ] **Step 4: 运行本地总验收**

~~~powershell
npm run verify:local
~~~

预期：exit 0，并确认目录包、Electron smoke、桌面壳和安装器验证通过。环境锁文件或既有无关修改导致失败时，记录命令、日志和发布影响。

- [ ] **Step 5: 逐项复核 Spec 覆盖**

核对：无项目状态只显示新建/打开；创建后出现准备卡；缺模型、非法模型、连接未知、演示模型、真实模型、运行中、阻塞、完成均有状态和主动作；开始按钮复用 /api/commands/submit；完成卡只看 committed artifact；阅读入口真实打开 reader；API key 不进入日志、toast 或 DOM；项目 schema、Agent engine 和章节协议未改。

- [ ] **Step 6: 更新持久计划并提交文档**

将 task_plan.md 阶段 1 改为“实施计划已完成，待执行”，在 progress.md 记录测试结果和未解决风险：

~~~powershell
git add docs/superpowers/plans/2026-07-12-first-chapter-success.md docs/USER_GUIDE.zh-CN.md task_plan.md progress.md
git commit -m "docs: plan first chapter success implementation"
~~~

## 完成定义

真实 Electron 窗口能够完成：

~~~text
点击新建小说 → 创建项目 → 看到准备卡 → 点击开始写第 1 章
→ 看到规划/写作状态和停止入口 → 看到章节完成卡
→ 点击阅读本章打开阅读器
~~~

同时满足：没有新增后端 API；没有新增持久化 schema；模型配置失败不会显示假成功；纯函数、服务端、app-shell 和 Electron clickability 均有测试；npm run verify:local 作为最终门槛。
