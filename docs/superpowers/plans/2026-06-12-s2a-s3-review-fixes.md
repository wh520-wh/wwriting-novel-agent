# S2a+S3 审核问题修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 S2a+S3 交付审核发现的全部问题：clickability 探针端口炸弹、fact-check 链路两处缺陷与零集成测试、hard 模式缺失、chat 端点无项目锁、测试缺口、验收工具放水，并补齐真实 API 验收与交付报告更正。

**Architecture:** 全部是对既有模块的小幅修正，无新子系统。fact-check 协议扩展 `replace_with` 字段（模型给出可直接替换的目标值），`runFactCheck` 改为返回 conflicts 供 reviewChapter 做 hard 判定；chat 两个写端点包 `withProjectLock`（与 serveCommandSubmit 同模式）；探针端口改为 `listen(0)` OS 分配。

**Tech Stack:** Node 24 ESM（.mjs）+ CJS 探针脚本、node:test + assert/strict，无新依赖。

**审核来源:** 本计划逐条对应 2026-06-12 审核报告（对照 `../specs/2026-06-12-chat-agent-paradigm-design.md` §12/§13 与 `../specs/2026-06-12-s2-memory-and-quality-gates-design.md` 验收节）。

**纪律：** 每任务 `npm test` 全绿才 commit；涉及 UI/服务端的任务收尾跑 `npm run verify:app-shell` 与 `npm run verify:app-clickability`（Task 1 修复后该防线才可靠，故 Task 1 最先做）；最终 `npm run verify:local`。

---

## 现状速查（全部已核实）

| 事实 | 位置 |
|------|------|
| 探针随机端口 `5300 + random(300)` | `scripts/verify-app-clickability.cjs:9`；Windows TCP 排除区含 5366-5465（约 1/3 命中率 → listen EACCES 崩溃） |
| 动态端口参考实现 | `scripts/verify-app-shell.mjs:591-604`（net.createServer().listen(0)）；`tests/app-shell/chat-endpoints.test.mjs:24-34`（server.listen(0) 后取 address().port） |
| fact-check 正文截断 | `src/core/quality-gates.mjs:222`：`String(draft).slice(0, FACT_CHECK_SUMMARY_MAX)`（2000 字符，3300 字章节漏查约 40%） |
| fact-check 预填 bug | `src/core/agent-engine.mjs` `runFactCheck` 末段：`replace: first.suggestion`（说明文字当替换值） |
| runFactCheck 未导出、无测试 | `src/core/agent-engine.mjs`（`extractChapterMemory` 已导出且有 3 个 fake-client 测试可仿照，见 `tests/agent-engine.test.mjs:693-760`） |
| hard 模式未实现 | `runFactCheck` 尾注释"后续 Task 处理"；titleGate 失败块（agent-engine.mjs reviewChapter 内）是 needs_revision 同形态范本 |
| withProjectLock | `src/core/app-server.mjs:551-556`，**不可重入**（promise 链排队锁）；`startProjectRun`（:1064）自身不取锁，故锁内调用安全；serveChatSend/serveChatConfirm（:754-797）当前未包锁 |
| 锁的覆盖范围说明 | 流水线 job 在后台跑、不持锁；锁只防 HTTP 写请求间并发。"chat 编辑 vs 运行中流水线"仍靠 edit_chapter 的 chapter_busy 守卫（tools-write.mjs:72-84），两者是 spec §13 规定的组合控制 |
| chat-store 展开顺序 | `src/core/chat/chat-store.mjs:8-16`：`{ id: …, ts: …, ...message }`，显式 `id: undefined` 会覆盖默认值 |
| thread-renderer 指纹 | `src/app-shell/thread-renderer.js` `syncChatThread`：`chat:${role}:${ts}:${tool}`（同毫秒撞键）；`renderChatMessage` 的 `role === "confirm"` 分支是死代码；`ctx.renderedKeys` 在 app.js:89 初始化 |
| verify-chat-online 放水 | `scripts/verify-chat-online.mjs:204`：`passRate >= 0.6`（计划要求 2/2 拦截 + 0 误杀）；JSON 报告未按计划落盘 docs/superpowers/reports/；头部注释 env 名误导（实际是 `WWRITING_API_KEY_ENV` 间接寻址） |
| 语料缺口 | `tests/fixtures/s2-corpus/` 好样本仅 1 条（good-flashback），S2 spec 要求 ≥4 条 |
| rebuild-memory 守卫永假 | `scripts/rebuild-memory.mjs:12-17`：`path.resolve("")` 返回 cwd，`!projectRoot` 不可能为真 |
| 测试缺口 | `/api/chat/confirm` 无 HTTP 级测试（tests/app-shell/chat-endpoints.test.mjs 文件头声称覆盖）；`rewrite_chapter` 无任何测试 |
| 交付报告 | `docs/superpowers/reports/2026-06-12-s2a-s3-delivery-report.md` 第 3 节的"10 条"不是 spec §12 真实验收条目；真实 API 证据缺失 |

**实施顺序硬约束：** Task 1 最先（防线自身要可靠）。Task 2 → 3 → 4 → 5 顺序执行（同链路递进）。其余任务相互独立。每任务独立提交。

---

## Task 1: clickability 探针动态端口（修防线）

**Files:**
- Modify: `scripts/verify-app-clickability.cjs:9`（删随机端口）+ main() 内 listen 处

- [ ] **Step 1: 删除顶层随机端口行**

删除第 9 行：

```js
const port = 5300 + Math.floor(Math.random() * 300);
```

- [ ] **Step 2: listen(0) 由 OS 分配端口**

找到 main() 内（约 75-78 行）：

```js
    port
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  await waitForServer(port);
```

改为（`port: 0` 占位选项无实际作用，保留键避免 createAppShellServer 解构 undefined；实际端口从 address() 读，零 TOCTOU）：

```js
    port: 0
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await waitForServer(port);
```

注意：`const port` 移入 main() 后，确认 main() 内对 `port` 的其余引用（loadURL 约 108 行）都在该声明之后——核实当前文件即是如此。OS 分配的临时端口（Windows 49152-65535）不会落入排除区，也不在 Chromium unsafe port 列表（最高 10080）。

- [ ] **Step 3: 连跑 3 次验证稳定**

Run: `npm run verify:app-clickability`（×3）
Expected: 3 次均 ok:true，无 EACCES（修复前约 1/3 概率崩溃）

- [ ] **Step 4: 提交**

```bash
git add scripts/verify-app-clickability.cjs
git commit -m "fix(probes): clickability uses OS-assigned port, avoiding Windows excluded port ranges"
```

## Task 2: fact-check 全文核查（去掉 2000 字符截断）

**Files:**
- Modify: `src/core/quality-gates.mjs`（buildFactCheckMessages + 常量）
- Test: `tests/quality-gates.test.mjs`（追加）

- [ ] **Step 1: 写失败测试**（追加到 tests/quality-gates.test.mjs 末尾）

```js
test("buildFactCheckMessages 不截断正文（冲突可能在章节尾部）", () => {
  const longDraft = "开头无冲突内容。".repeat(300) + "刘康从十二楼坠落。";
  assert.ok(longDraft.length > 2000, "前置条件：正文超 2000 字符");
  const messages = buildFactCheckMessages({
    chapterNo: 2,
    draft: longDraft,
    facts: [{ entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1 }],
    timeline: []
  });
  assert.match(messages[1].content, /十二楼/u, "章节尾部内容必须进入核查输入");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/quality-gates.test.mjs`
Expected: 新用例 FAIL（尾部"十二楼"被截掉）

- [ ] **Step 3: 实现**

`src/core/quality-gates.mjs`：删除常量 `const FACT_CHECK_SUMMARY_MAX = 2000;`，并把 buildFactCheckMessages 中的

```js
    String(draft ?? "").slice(0, FACT_CHECK_SUMMARY_MAX),
```

改为

```js
    String(draft ?? ""),
```

（fact-check 输入 = 全章正文 + 紧凑 facts/timeline，单章 3300 字量级，单次调用成本可控，无需截断。）

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `node --test tests/quality-gates.test.mjs` → PASS；`npm test` → 全绿

- [ ] **Step 5: 提交**

```bash
git add src/core/quality-gates.mjs tests/quality-gates.test.mjs
git commit -m "fix(fact-check): send full chapter draft to fact-check, drop 2000-char truncation"
```

## Task 3: fact-check 结构化 replace_with，预填不再误用 suggestion 全文

**Files:**
- Modify: `src/core/quality-gates.mjs`（FACT_CHECK_SYSTEM_PROMPT + parseFactCheck）
- Modify: `src/core/agent-engine.mjs`（runFactCheck 预填段）
- Test: `tests/quality-gates.test.mjs`（追加）

- [ ] **Step 1: 写失败测试**

```js
test("parseFactCheck 解析 replace_with 字段，缺省为空串", () => {
  const raw = JSON.stringify({ conflicts: [{
    draft_quote: "从十二楼坠落",
    conflicts_with: "坠楼楼层: 六楼",
    prior_chapter: 1,
    severity: "high",
    suggestion: "建议把十二楼改成六楼以保持一致",
    replace_with: "从六楼坠落"
  }, {
    draft_quote: "时间线混乱",
    conflicts_with: "ch1 午间",
    prior_chapter: 1,
    severity: "low",
    suggestion: "复杂改动，无法机械替换"
  }] });
  const parsed = parseFactCheck(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.conflicts[0].replace_with, "从六楼坠落");
  assert.equal(parsed.conflicts[1].replace_with, "");
});

test("buildFactCheckMessages 系统提示要求 replace_with 为可直接替换文字", () => {
  const messages = buildFactCheckMessages({ chapterNo: 2, draft: "x", facts: [], timeline: [] });
  assert.match(messages[0].content, /replace_with/u);
});
```

- [ ] **Step 2: 跑测试确认失败** → `node --test tests/quality-gates.test.mjs` FAIL

- [ ] **Step 3: 实现协议扩展**

`FACT_CHECK_SYSTEM_PROMPT` 中 conflicts 的 JSON 结构行改为：

```js
  '{"conflicts":[{"draft_quote":"本章内一句触发冲突的原文","conflicts_with":"既有设定/时间线中的对应记录","prior_chapter":既有章节号,"severity":"high|low","suggestion":"修复建议（说明改哪边、为什么）","replace_with":"用于直接替换 draft_quote 的修正后原文（保持句式，只改冲突值；若无法给出精确替换则留空字符串）"}]}',
```

`parseFactCheck` 的 normalize map 中追加一行：

```js
      replace_with: String(c.replace_with ?? "").slice(0, 200),
```

- [ ] **Step 4: 修 runFactCheck 预填段**

`src/core/agent-engine.mjs` runFactCheck 末段，把

```js
  const existingPending = await loadPendingAction(projectRoot).catch(() => null);
  if (!existingPending) {
    const firstIdx = draft.indexOf(first.draft_quote);
    const onlyHit = firstIdx >= 0 && draft.indexOf(first.draft_quote, firstIdx + 1) < 0;
    if (onlyHit) {
      try {
        const preview = await previewEditChapter(projectRoot, {
          chapter_no: state.current_chapter_no,
          find: first.draft_quote,
          replace: first.suggestion
        });
        await savePendingAction(projectRoot, {
          tool: "edit_chapter",
          args: { chapter_no: state.current_chapter_no, find: first.draft_quote, replace: first.suggestion, reason: "fact-check 矛盾修复" },
          preview
        });
      } catch { /* preview 失败不阻塞 */ }
    }
  }
```

改为（仅当模型给出精确替换值时才预填；说明性 suggestion 只进主动消息）：

```js
  const existingPending = await loadPendingAction(projectRoot).catch(() => null);
  if (!existingPending && first.replace_with) {
    const firstIdx = draft.indexOf(first.draft_quote);
    const onlyHit = firstIdx >= 0 && draft.indexOf(first.draft_quote, firstIdx + 1) < 0;
    if (onlyHit) {
      try {
        const preview = await previewEditChapter(projectRoot, {
          chapter_no: state.current_chapter_no,
          find: first.draft_quote,
          replace: first.replace_with
        });
        await savePendingAction(projectRoot, {
          tool: "edit_chapter",
          args: { chapter_no: state.current_chapter_no, find: first.draft_quote, replace: first.replace_with, reason: "fact-check 矛盾修复" },
          preview
        });
      } catch { /* preview 失败不阻塞 */ }
    }
  }
```

- [ ] **Step 5: 跑测试 + 全量** → `node --test tests/quality-gates.test.mjs` PASS；`npm test` 全绿

- [ ] **Step 6: 提交**

```bash
git add src/core/quality-gates.mjs src/core/agent-engine.mjs tests/quality-gates.test.mjs
git commit -m "fix(fact-check): structured replace_with for prefill, stop using prose suggestion as replacement text"
```

## Task 4: runFactCheck 引擎集成测试（fake client）

**Files:**
- Modify: `src/core/agent-engine.mjs`（导出 runFactCheck；返回值 `{ conflicts }`，为 Task 5 铺路）
- Test: `tests/agent-engine.test.mjs`（追加，仿照 extractChapterMemory 的 3 个用例模式）

- [ ] **Step 1: 改 runFactCheck 签名（先于测试，导出 + 返回值）**

`async function runFactCheck(` → `export async function runFactCheck(`。

每个提前返回路径补返回值：跳过路径（enabled=false、mock、continuity 加载失败、无 facts、解析失败）`return null;`；无冲突路径 `return { conflicts: [] };`；函数末尾（有冲突，发完消息/预填后）`return { conflicts };`。

reviewChapter 内调用处同步改（保持行为不变，hard 判定 Task 5 才加）：

```js
  try {
    await runFactCheck(projectRoot, project, state, runtime, draft);
  } catch (error) {
```

改为

```js
  let factCheck = null;
  try {
    factCheck = await runFactCheck(projectRoot, project, state, runtime, draft);
  } catch (error) {
```

（`factCheck` 变量本任务暂不消费，Task 5 使用；ESLint 若报 unused 用 `void factCheck;` 占位则删之——本仓库无此规则，直接保留。）

- [ ] **Step 2: 写失败测试**（追加到 tests/agent-engine.test.mjs 末尾；文件顶部已有 createProject/loadProject/saveProject/readEvents/fs/os/path import，新增 import 只补缺的）

```js
// 顶部追加（已有的不重复加）：
import { loadPendingAction as loadChatPending } from "../src/core/chat/chat-store.mjs";
import { readChatHistory as readChatHist } from "../src/core/chat/chat-store.mjs";

async function makeFactCheckProject(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const { projectRoot } = await createProject(root, {
    slug: "fc", title: "核查测试", story_seed: "种子",
    target_chapters: 2, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const project = await loadProject(projectRoot);
  project.active_model = { provider: "openai-compatible", model_name: "fake", base_url: "http://localhost:0", api_key_env: "FAKE_KEY" };
  await saveProject(projectRoot, project);
  const { saveContinuity } = await import("../src/core/continuity-store.mjs");
  await saveContinuity(projectRoot, {
    schema_version: 1,
    facts: [{ entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1, quote: "六楼。", conflict_with: null }],
    timeline: [], characters: []
  });
  return { projectRoot, project };
}

const FC_CONFLICT_REPLY = JSON.stringify({ conflicts: [{
  draft_quote: "从十二楼坠落", conflicts_with: "坠楼楼层: 六楼", prior_chapter: 1,
  severity: "high", suggestion: "把十二楼改回六楼", replace_with: "从六楼坠落"
}] });

test("runFactCheck 有冲突：主动消息 + pending 预填 replace_with + warning 事件，返回 conflicts", async () => {
  const { projectRoot, project } = await makeFactCheckProject("wwriting-fc1-");
  // 预置第 1 章正文，draft_quote 唯一命中
  const chapterPath = path.join(projectRoot, "chapters", "001.md");
  await fs.mkdir(path.dirname(chapterPath), { recursive: true });
  await fs.writeFile(chapterPath, "# 第一章\n\n刘康从十二楼坠落。", "utf8");
  await upsertChapter(projectRoot, { chapter_no: 1, status: "completed", final_path: chapterPath, actual_words: 10 });
  const { runFactCheck } = await import("../src/core/agent-engine.mjs");
  const draft = "刘康从十二楼坠落。";
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => ({ text: FC_CONFLICT_REPLY, usageReport: {} }) }
  }, draft);
  assert.equal(out.conflicts.length, 1);
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "quality_gate_warning" && e.data?.conflicts?.length === 1));
  const history = await readChatHist(projectRoot);
  const proactive = history.find((m) => m.proactive === "fact_check");
  assert.ok(proactive, "应有 agent 主动消息");
  assert.match(proactive.content, /十二楼/u);
  const pending = await loadChatPending(projectRoot);
  assert.ok(pending, "应预填 pending_action");
  assert.equal(pending.tool, "edit_chapter");
  assert.equal(pending.args.replace, "从六楼坠落"); // replace_with，而非 suggestion 说明文字
});

test("runFactCheck replace_with 为空：只发消息，不落 pending", async () => {
  const { projectRoot, project } = await makeFactCheckProject("wwriting-fc2-");
  const noReplace = JSON.stringify({ conflicts: [{
    draft_quote: "从十二楼坠落", conflicts_with: "坠楼楼层: 六楼", prior_chapter: 1,
    severity: "high", suggestion: "结构性改动，无法机械替换", replace_with: ""
  }] });
  const { runFactCheck } = await import("../src/core/agent-engine.mjs");
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => ({ text: noReplace, usageReport: {} }) }
  }, "刘康从十二楼坠落。");
  assert.equal(out.conflicts.length, 1);
  assert.equal(await loadChatPending(projectRoot), null, "不应预填 pending");
  const history = await readChatHist(projectRoot);
  assert.ok(history.some((m) => m.proactive === "fact_check"), "主动消息仍要发");
});

test("runFactCheck mock provider 跳过并记事件，返回 null", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-fc3-"));
  const { projectRoot } = await createProject(root, {
    slug: "fcm", title: "跳过", story_seed: "种子",
    target_chapters: 1, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const project = await loadProject(projectRoot); // 默认 mock provider
  const { runFactCheck } = await import("../src/core/agent-engine.mjs");
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => { throw new Error("must not call"); } }
  }, "正文");
  assert.equal(out, null);
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "fact_check_skipped"));
});

test("runFactCheck 解析两次失败：fact_check_skipped 且返回 null", async () => {
  const { projectRoot, project } = await makeFactCheckProject("wwriting-fc4-");
  const { runFactCheck } = await import("../src/core/agent-engine.mjs");
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => ({ text: "不是 JSON", usageReport: {} }) }
  }, "正文");
  assert.equal(out, null);
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "fact_check_skipped"));
});
```

- [ ] **Step 3: 跑测试确认失败 → 实现（Step 1 的导出与返回值）→ 通过**

Run: `node --test tests/agent-engine.test.mjs`
Expected: 先 FAIL（runFactCheck not exported），按 Step 1 改完后 PASS（含 4 个新用例）

- [ ] **Step 4: 全量 + 提交**

Run: `npm test` → 全绿

```bash
git add src/core/agent-engine.mjs tests/agent-engine.test.mjs
git commit -m "test(fact-check): export runFactCheck with conflicts return, four fake-client integration cases"
```

## Task 5: fact-check hard 模式（needs_revision）

**Files:**
- Modify: `src/core/agent-engine.mjs`（reviewChapter 的 fact-check 调用处）
- Test: `tests/agent-engine.test.mjs`（追加 1 用例）

**行为规格（原计划 Task 16 规格 5 的兑现）：** `project.fact_check?.hard === true` 且 conflicts 非空 → 走 needs_revision（与 titleGate 失败块完全同形态：saveState + upsertChapter + quality_gate_failed 事件 + failure card + return）。软模式（默认）行为不变。hard 模式下 runFactCheck 内部的主动消息照发（无害），预填 pending 照旧条件执行（修订流水线与确认卡并存时用户任选其一）。

- [ ] **Step 1: 写失败测试**

hard 判定在 reviewChapter 内、不易全流程驱动（mock provider 会跳过 fact-check），所以测试锁"判定逻辑所依赖的输入输出契约"：runFactCheck 返回 conflicts（Task 4 已锁）+ reviewChapter hard 分支的状态落盘。通过最小代理函数测——把 hard 失败处理提取为模块内可导出函数 `applyFactCheckHardFail(projectRoot, project, state, conflicts)`：

```js
test("applyFactCheckHardFail 写 needs_revision 状态与 quality_gate_failed 事件", async () => {
  const { projectRoot, project } = await makeFactCheckProject("wwriting-fc5-");
  const { applyFactCheckHardFail } = await import("../src/core/agent-engine.mjs");
  const conflicts = [{ draft_quote: "从十二楼坠落", conflicts_with: "坠楼楼层: 六楼", prior_chapter: 1, severity: "high", suggestion: "改回六楼", replace_with: "从六楼坠落" }];
  await applyFactCheckHardFail(projectRoot, project, { current_chapter_no: 1, project_status: "running" }, conflicts);
  const state = await loadState(projectRoot);
  assert.equal(state.current_stage, "needs_revision");
  assert.ok(state.last_quality_gate_results.some((g) => g.gate === "fact-check-gate" && g.status === "failed"));
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "quality_gate_failed" && e.message.includes("fact-check")));
});
```

（`loadState` 在该测试文件已 import；若无则从 `../src/core/project-store.mjs` 补。）

- [ ] **Step 2: 跑测试确认失败** → FAIL（applyFactCheckHardFail not exported）

- [ ] **Step 3: 实现**

`agent-engine.mjs` 新增导出函数（放在 runFactCheck 之后，体例完全照抄 titleGate 失败块）：

```js
export async function applyFactCheckHardFail(projectRoot, project, state, conflicts) {
  const gate = { gate: "fact-check-gate", status: "failed", conflicts };
  const next = setStage({ ...state, last_quality_gate_results: [gate] }, "needs_revision");
  await saveState(projectRoot, next);
  await upsertChapter(projectRoot, {
    chapter_no: state.current_chapter_no,
    status: "needs_revision",
    quality_gate_results: [gate]
  });
  await appendEvent(projectRoot, {
    type: "quality_gate_failed",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: "reviewing",
    severity: "warn",
    message: `fact-check gate failed（${conflicts.length} 个设定冲突，hard 模式打回修订）`,
    data: gate
  });
  await writeCheckpoint(projectRoot, checkpointPayload(project, state, next));
  try {
    const fresh = await loadState(projectRoot).catch(() => state);
    const card = deriveFailureCard({
      id: `flr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: "quality_gate_failed",
      chapter_no: state.current_chapter_no,
      message: "fact-check gate failed",
      ts: new Date().toISOString(),
      data: gate
    }, fresh);
    appendFailure(projectRoot, card);
  } catch (err) { console.warn("appendFailure failed:", err.message); }
}
```

reviewChapter 内 fact-check 调用块（Task 4 已改为 `factCheck =`）之后追加：

```js
  if (factCheck?.conflicts?.length && project.fact_check?.hard === true) {
    await applyFactCheckHardFail(projectRoot, project, state, factCheck.conflicts);
    return;
  }
```

runFactCheck 末尾删除注释 `// hard 模式：当前任务仅记录 warning 与主动消息，不强制 needs_revision（后续 Task 处理）`。

- [ ] **Step 4: 跑测试 + 全量** → 新用例 PASS；`npm test` 全绿；`npm run verify:mvp` ok:true（mock 路径 fact-check 跳过，不受影响）

- [ ] **Step 5: 提交**

```bash
git add src/core/agent-engine.mjs tests/agent-engine.test.mjs
git commit -m "feat(fact-check): hard mode sends chapter to needs_revision via fact-check-gate"
```

## Task 6: chat 端点包 withProjectLock

**Files:**
- Modify: `src/core/app-server.mjs`（serveChatSend、serveChatConfirm）
- Test: `tests/app-shell/chat-endpoints.test.mjs`（追加并发串行用例）

**行为规格（spec §13 控制措施兑现）：** 两个写端点的"加载项目 → 跑 turn → 写 cost"整段进入 `withProjectLock`，与 serveCommandSubmit（app-server.mjs:645）同模式。锁不可重入，但 turn 内经 `chatServerContext` 调到的 `startProjectRun` 自身不取锁（已核实 :1064），无死锁。serveChatHistory 只读，不加锁。

- [ ] **Step 1: 写失败测试**（追加到 chat-endpoints.test.mjs；mock provider 回复固定文本，并发两条消息若不串行会出现历史交错）

```js
test("并发两条 chat send 串行执行，历史不交错", async () => {
  const ctx = await setupServer();
  try {
    const [r1, r2] = await Promise.all([
      postJson(ctx.port, "/api/chat/send", { message: "并发一" }),
      postJson(ctx.port, "/api/chat/send", { message: "并发二" })
    ]);
    assert.equal(r1.res.status, 200);
    assert.equal(r2.res.status, 200);
    const hist = await getJson(ctx.port, "/api/chat/history");
    const roles = hist.data.messages.map((m) => m.role);
    // 串行证据：必须是 user,assistant,user,assistant（交错则为 user,user,assistant,assistant 等）
    assert.deepEqual(roles, ["user", "assistant", "user", "assistant"]);
  } finally {
    await closeServer(ctx.server);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/app-shell/chat-endpoints.test.mjs`
Expected: 新用例 FAIL（无锁时两请求交错，roles 顺序破坏）。注：此竞态存在调度偶然性，若偶发 PASS，重跑确认会 FAIL（mock 路径有文件 IO await 点，交错概率高）。

- [ ] **Step 3: 实现**

serveChatSend 中：

```js
    const projectRoot = await resolveActiveProjectRoot(context);
    const project = await loadProject(projectRoot);
    const registry = buildChatRegistry();
    const modelClient = await buildChatModelClient(project, projectRoot);
    const result = await runChatTurn({
```

改为：

```js
    const projectRoot = await resolveActiveProjectRoot(context);
    return await withProjectLock(context, projectRoot, async () => {
    const project = await loadProject(projectRoot);
    const registry = buildChatRegistry();
    const modelClient = await buildChatModelClient(project, projectRoot);
    const result = await runChatTurn({
```

并在 `await serveJson(response, { ok: true, ...result });` 之后补 `});` 闭合（缩进风格与 serveCommandSubmit:645 的既有锁块一致——锁体不重新缩进）。serveChatConfirm 同样处理（包住 loadProject 到 serveJson 整段）。

- [ ] **Step 4: 跑测试 + 全量 + 防线**

Run: `node --test tests/app-shell/chat-endpoints.test.mjs` → PASS；`npm test` 全绿；`npm run verify:app-shell` ok:true

- [ ] **Step 5: 提交**

```bash
git add src/core/app-server.mjs tests/app-shell/chat-endpoints.test.mjs
git commit -m "fix(chat): serialize chat send/confirm under withProjectLock per spec concurrency control"
```

## Task 7: 测试补全——confirm 端点 HTTP 级 + rewrite_chapter

**Files:**
- Test: `tests/app-shell/chat-endpoints.test.mjs`（追加 confirm 用例）
- Test: `tests/chat-tools.test.mjs`（追加 rewrite_chapter 用例）

- [ ] **Step 1: confirm 端点测试（先红后绿——若直接绿说明既有实现已正确，亦达目的）**

追加到 chat-endpoints.test.mjs（pending 直接写文件注入，approve=false 走拒绝回填）：

```js
import { savePendingAction } from "../../src/core/chat/chat-store.mjs";

test("POST /api/chat/confirm approve=false：清 pending 并回填 user_rejected", async () => {
  const ctx = await setupServer();
  try {
    await savePendingAction(ctx.projectRoot, {
      tool: "edit_chapter",
      args: { chapter_no: 1, find: "六楼", replace: "十二楼", reason: "test" },
      preview: { ok: true, chapter_no: 1, before: "六楼", after: "十二楼" }
    });
    const { res, data } = await postJson(ctx.port, "/api/chat/confirm", { approve: false });
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.pendingAction, null);
    const hist = await getJson(ctx.port, "/api/chat/history");
    const toolMsg = hist.data.messages.find((m) => m.role === "tool" && m.tool === "edit_chapter");
    assert.ok(toolMsg, "应有 tool 回填消息");
    assert.equal(toolMsg.ok, false);
    assert.match(toolMsg.result_summary ?? "", /user_rejected/u);
    assert.equal(hist.data.pendingAction ?? null, null, "pending 应被清除");
  } finally {
    await closeServer(ctx.server);
  }
});

test("POST /api/chat/confirm 无 pending 时友好返回", async () => {
  const ctx = await setupServer();
  try {
    const { res, data } = await postJson(ctx.port, "/api/chat/confirm", { approve: true });
    assert.equal(res.status, 200);
    assert.match(data.reply ?? "", /没有待确认/u);
  } finally {
    await closeServer(ctx.server);
  }
});
```

- [ ] **Step 2: rewrite_chapter 测试**

追加到 chat-tools.test.mjs（fake getTaskQueue 记录 enqueue，兑现原计划"Phase 2 ctx 完善后补"的承诺）：

```js
test("rewrite_chapter 组装重写指令入队", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const enqueued = [];
  const ctx = {
    projectRoot, project,
    getTaskQueue: async () => ({ enqueue: async (instruction, opts) => { enqueued.push({ instruction, opts }); return { id: "t1" }; } })
  };
  const out = await executeTool(registry, "rewrite_chapter", { chapter_no: 2, instructions: "增加沈泽心理描写" }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.result.queued, 1);
  assert.equal(out.result.task_id, "t1");
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0].instruction, /重写第2章/u);
  assert.match(enqueued[0].instruction, /心理描写/u);
  assert.equal(enqueued[0].opts.mode, "write");
});
```

- [ ] **Step 3: 跑测试**

Run: `node --test tests/app-shell/chat-endpoints.test.mjs tests/chat-tools.test.mjs`
Expected: 全 PASS（这些是覆盖既有行为的回归锁，不是改行为；若 confirm 用例 FAIL 则按失败信息修 serveChatConfirm——以测试为准）

- [ ] **Step 4: 全量 + 提交**

Run: `npm test` → 全绿

```bash
git add tests/app-shell/chat-endpoints.test.mjs tests/chat-tools.test.mjs
git commit -m "test(chat): confirm endpoint http-level coverage and rewrite_chapter unit case"
```

## Task 8: 存储与渲染小修——chat-store 展开顺序、消息指纹用 id、删死分支

**Files:**
- Modify: `src/core/chat/chat-store.mjs:8-16`
- Modify: `src/app-shell/thread-renderer.js`（syncChatThread 指纹 + renderChatMessage 死分支）
- Test: `tests/chat-store.test.mjs`（追加）

- [ ] **Step 1: 写失败测试**

```js
test("appendChatMessage 显式 undefined id/ts 不覆盖默认值", async () => {
  const root = await tmp();
  await appendChatMessage(root, { role: "user", content: "x", id: undefined, ts: undefined });
  const history = await readChatHistory(root);
  assert.ok(history[0].id, "id 必须有值");
  assert.ok(history[0].ts, "ts 必须有值");
});
```

- [ ] **Step 2: 跑测试确认失败** → `node --test tests/chat-store.test.mjs` FAIL（id 为 undefined）

- [ ] **Step 3: 实现**

chat-store.mjs 的 entry 构造改为（spread 在前、默认值在后，显式 undefined 不再覆盖）：

```js
  const entry = {
    ...message,
    id: message.id ?? crypto.randomUUID(),
    ts: message.ts ?? new Date().toISOString()
  };
```

thread-renderer.js `syncChatThread` 的消息指纹行：

```js
      const key = `chat:${message.role}:${message.ts}:${message.tool ?? ""}`;
```

改为（id 是 appendChatMessage 必生成的 uuid，天然唯一；旧消息无 id 时退回旧指纹）：

```js
      const key = message.id ? `chat:${message.id}` : `chat:${message.role}:${message.ts}:${message.tool ?? ""}`;
```

`renderChatMessage` 删除死分支行（chat-store 从不产生该 role，确认卡由 pendingAction 渲染）：

```js
    if (message.role === "confirm") return renderConfirmCard(message);
```

- [ ] **Step 4: 跑测试 + 防线**

Run: `node --test tests/chat-store.test.mjs` → PASS；`npm test` 全绿；`npm run verify:app-clickability` ok:true（探针含气泡/确认卡/工具卡渲染路径）

- [ ] **Step 5: 提交**

```bash
git add src/core/chat/chat-store.mjs src/app-shell/thread-renderer.js tests/chat-store.test.mjs
git commit -m "fix(chat-ui): message dedupe keyed by uuid, spread-safe defaults, drop dead confirm branch"
```

## Task 9: 验收工具修正 + 语料补全

**Files:**
- Modify: `scripts/verify-chat-online.mjs`（通过线、JSON 落盘、注释）
- Modify: `scripts/rebuild-memory.mjs`（usage 守卫）
- Create: `tests/fixtures/s2-corpus/good-liar.json`、`good-metaphor.json`、`good-normal.json`

- [ ] **Step 1: 收紧通过线 + 报告落盘**

verify-chat-online.mjs 头部注释第 2 行改为：

```js
// Requires: WWRITING_PROVIDER_BASE_URL, WWRITING_PROVIDER_MODEL, and the API key in the env var named by WWRITING_API_KEY_ENV (default OPENAI_API_KEY)
```

场景 C 统计段（`const cPassRate = ...` 到 `results.push({ scenario: "C_fact_check", ... })`）改为（拦截/误杀分开统计，全部达标才过）：

```js
    const conflictCases = cResults.filter((r) => corpus.find((f) => f.name === r.name)?.expect === "conflict");
    const passCases = cResults.filter((r) => corpus.find((f) => f.name === r.name)?.expect === "pass");
    const interceptRate = conflictCases.length ? conflictCases.filter((r) => r.pass).length / conflictCases.length : 1;
    const falseKillCount = passCases.filter((r) => !r.pass).length;
    const cPass = corpus.length > 0 && interceptRate === 1 && falseKillCount === 0;
    results.push({
      scenario: "C_fact_check",
      pass: cPass,
      interceptRate,
      falseKillCount,
      goodSamples: passCases.length,
      details: cResults
    });
```

`const allPass = ...` 行改为（去掉 0.6 放水线，全部场景 pass 才过）：

```js
  const allPass = results.every((r) => r.pass === true);
```

`console.log(JSON.stringify(report, null, 2));` 之前追加报告落盘（原计划 Task 21 要求）：

```js
  const reportDir = path.resolve(path.dirname(process.argv[1]), "..", "docs", "superpowers", "reports");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${new Date().toISOString().slice(0, 10)}-s3-chat-online-verification.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.error(`report written: ${reportPath}`);
```

- [ ] **Step 2: rebuild-memory usage 守卫修正**

```js
const projectRoot = path.resolve(args.find((a) => !a.startsWith("--")) ?? "");
...
if (!projectRoot) throw new Error("usage: ...");
```

改为：

```js
const rootArg = args.find((a) => !a.startsWith("--"));
if (!rootArg) throw new Error("usage: node scripts/rebuild-memory.mjs <projectRoot> [--from N] [--dry-run]");
const projectRoot = path.resolve(rootArg);
```

（`const dryRun`/`fromArg`/`fromChapter` 行保持不动，`projectRoot` 声明移到守卫之后。）

- [ ] **Step 3: 补 3 条好样本语料（对齐 S2 spec"好样本 ≥4 条"）**

`tests/fixtures/s2-corpus/good-liar.json`（角色撒谎豁免）：

```json
{
  "name": "good-liar",
  "draft": "包工头压低声音对警察说：「我亲眼看见的，刘康是从十二楼跳下去的。」沈泽在一旁听着，知道他在撒谎。",
  "continuity_facts": [
    { "entity": "刘康", "attribute": "坠楼楼层", "value": "六楼", "chapter_no": 1, "quote": "六楼。", "conflict_with": null }
  ],
  "timeline": [],
  "expect": "pass"
}
```

`tests/fixtures/s2-corpus/good-metaphor.json`（比喻/旁白豁免）：

```json
{
  "name": "good-metaphor",
  "draft": "听到这个名字，沈泽一阵眩晕，像是自己从十二楼坠落，胃里翻江倒海。",
  "continuity_facts": [
    { "entity": "刘康", "attribute": "坠楼楼层", "value": "六楼", "chapter_no": 1, "quote": "六楼。", "conflict_with": null }
  ],
  "timeline": [],
  "expect": "pass"
}
```

`tests/fixtures/s2-corpus/good-normal.json`（正常续写，无任何相关提及）：

```json
{
  "name": "good-normal",
  "draft": "沈泽把工牌翻过来又翻过去，食堂的电视里在放午间新闻。老马端着餐盘坐到他对面，两个人谁都没先开口。",
  "continuity_facts": [
    { "entity": "刘康", "attribute": "坠楼楼层", "value": "六楼", "chapter_no": 1, "quote": "六楼。", "conflict_with": null }
  ],
  "timeline": [{ "chapter_no": 1, "story_time": "十月", "events": ["刘康坠楼"] }],
  "expect": "pass"
}
```

- [ ] **Step 4: 干跑校验脚本语法**

Run: `node --check scripts/verify-chat-online.mjs; node --check scripts/rebuild-memory.mjs`
Expected: 无输出（语法 OK）

Run: `node scripts/rebuild-memory.mjs`
Expected: 立即抛 usage 错误（守卫生效，不再把 cwd 当项目根）

Run: `npm test`
Expected: 全绿（语料文件不影响单测——单测不遍历语料目录）

- [ ] **Step 5: 提交**

```bash
git add scripts/verify-chat-online.mjs scripts/rebuild-memory.mjs tests/fixtures/s2-corpus
git commit -m "fix(verify): strict 2/2-intercept zero-falsekill gate, report file output, 4 good corpus samples"
```

## Task 10: 全量防线 + 真实 API 验收 + 交付报告更正

**Files:**
- Modify: `docs/superpowers/reports/2026-06-12-s2a-s3-delivery-report.md`
- Create（验收跑通后）: `docs/superpowers/reports/<date>-s3-chat-online-verification.json`（由脚本生成）

- [ ] **Step 1: 全量防线**

```powershell
npm test                          # 全绿
npm run verify:mvp                # ok:true
npm run verify:longrun            # ok:true, stableChanged=false
npm run verify:app-shell          # ok:true
npm run verify:app-clickability   # ok:true（Task 1 修复后连跑 2 次确认稳定）
npm run verify:local              # ok:true
```

- [ ] **Step 2: 真实 API 验收（需要用户配合提供 key）**

向用户申请环境变量（与 verify-provider-online 同套）：`WWRITING_PROVIDER_BASE_URL`、`WWRITING_PROVIDER_MODEL`、`WWRITING_API_KEY_ENV` 指向的密钥。然后：

```powershell
npm run verify:chat-online
```

Expected: `ok:true`，`interceptRate: 1`，`falseKillCount: 0`（5 条语料：2 conflict + 3 good——good-flashback 已有），JSON 报告自动落盘 `docs/superpowers/reports/`。

**若用户暂不提供 key**：本步骤保持未勾选，Step 3 的报告中"真实 API 验收"一栏如实写"未执行（待 key）"，不得写已验证。

- [ ] **Step 3: 交付报告更正**

`docs/superpowers/reports/2026-06-12-s2a-s3-delivery-report.md` 做三处修改：

1. 第 3 节标题改为"3. Spec §12 验收 10 条逐条核对（2026-06-12 更正：本节原为任务对照表，未对照 spec §12 真实验收条目，现更正）"，表格替换为按 chat-agent spec §12 原文 10 条逐条核对，每条状态如实填（依据 Step 1/2 实际结果）：

```markdown
| # | Spec §12 条目 | 证据 | 状态 |
|---|--------------|------|------|
| 1 | 理解可溯源（真实 API） | verify:chat-online 场景 A（报告 JSON） | <按实际> |
| 2 | 编辑落地（真实 API） | verify:chat-online 场景 B：pending→approve→文件变更+checkpoint | <按实际> |
| 3 | 指挥落地（大纲改→队列→流水线） | 无端到端覆盖（update_outline/queue_chapters/start_run 仅单测） | ⚠ 未端到端验收 |
| 4 | 门禁对话化（语料→主动提案→一键修复） | runFactCheck 集成测试（fake client）+ 场景 C 拦截率 | <按实际> |
| 5 | 拒绝路径 | chat-agent.test.mjs read_only / chapter_busy 用例 | ✅ |
| 6 | 并发安全 | withProjectLock（chat send/confirm）+ chapter_busy + 并发串行测试 | ✅ |
| 7 | 持久性 | pending 跨进程用例 + clickability 确认卡探针 | ✅ |
| 8 | 成本归因 | byStage=chat 端点断言；金额>0 见 chat-online 报告 | <按实际> |
| 9 | 既有防线 | 本次修复后六道防线输出 | ✅ |
| 10 | 协议鲁棒 | 畸形 JSON / unknown_tool 用例 | ✅ |
```

2. 第 4 节"已知范围裁剪"删除"hard 模式 fact-check needs_revision"条目（已实现），并将该节补一句："以上裁剪在原实施计划中有书面决策记录；hard 模式原属计划内要求，此前归入裁剪系定性错误，已于本次修复实现。"

3. 文末追加"7. 审核修复记录（2026-06-12）"小节：列出本计划 Task 1-9 的修复项与 commit 号，并注明"原 commit 标题 'with real-API evidence' 在当时不成立，真实 API 证据以本节链接的 verification JSON 为准"。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/reports/
git commit -m "docs(s3): corrected delivery report - true spec §12 checklist, real-API evidence status"
```

---

## 计划自审记录（writing-plans Self-Review）

1. **审核问题覆盖核对**：探针端口 EACCES → Task 1；fact-check 截断 → Task 2；replace 误用 suggestion → Task 3；runFactCheck 零测试 → Task 4；hard 模式缺失 → Task 5；withProjectLock 缺失 → Task 6；confirm 端点/rewrite_chapter 测试缺口 → Task 7；指纹撞键/死分支/展开顺序 → Task 8；通过线放水/JSON 未落盘/注释误导/语料不足/usage 守卫 → Task 9；真实 API 验收未执行/交付报告验收替换 → Task 10。审核 Minor #7（runChatTurn 被 pending 挡回的提示不落历史）确认**不修**——属 UX 设计选择，原计划未规定，刷新即恢复一致状态，修复反引入历史噪音。spec §12-3"指挥落地"端到端验收**本计划不补**（需新设计组合场景脚本，超出"修复审核问题"范围），在 Task 10 报告中如实标注 ⚠，列入后续 backlog——这是有记录的范围决定而非遗漏。
2. **占位符扫描**：Task 10 Step 3 表格中的 `<按实际>` 是指示实施者按真实验收结果填写的字段，非代码占位；其余任务代码均完整。Task 7 Step 1 confirm 用例标注"先红后绿——若直接绿亦达目的"，因为它是回归锁而非行为变更。
3. **类型一致性核对**：`runFactCheck` 返回 `null | { conflicts }` 在 Task 4 定义、Task 5 消费一致；`replace_with` 字段在 Task 3 协议/解析/预填三处一致；`applyFactCheckHardFail(projectRoot, project, state, conflicts)` 签名与测试调用一致；`withProjectLock(context, projectRoot, fn)` 用法与 app-server.mjs:551 现状一致；语料 JSON 字段（name/draft/continuity_facts/timeline/expect）与 verify-chat-online loadCorpus 消费一致。
4. **顺序依赖**：Task 4 的测试断言 `pending.args.replace === "从六楼坠落"` 依赖 Task 3 的 replace_with 修复；Task 5 依赖 Task 4 的返回值改造——已由"实施顺序硬约束"锁定。
