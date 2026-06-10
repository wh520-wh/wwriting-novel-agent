# WWriting 综合修复与 Codex 风格优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复全面审查发现的功能性断裂（故障卡按钮全部静默失效、pause-here 误标中断、成本双重记账、完成后死路），把 Tool Hook 生命周期和 agent 运行循环做成可扩展且省 IO 的流程，并按 Codex 风格收敛 UX 细节（导航死路、状态闪烁、章节卡刷屏、密钥明文下发）。

**Architecture:** 三层推进 — ① 故障恢复闭环：`derive-failure-card` 数据修复 → 新模块 `failure-actions.mjs` 真实执行用户决定 → `/api/failures/resolve` 接线并自动续跑 → 前端反馈；② 引擎流程：pause 语义修正、stage_entered_at、skill hook 每步缓存、BeforeToolUse/AfterToolUse 管道；③ UX：完成后可改写作目标、导航收敛 + 项目过滤、静默轮询、章节卡折叠。

**Tech Stack:** Node.js 24+（内置 test runner）、Electron 42、原生 ES Modules 前端（无框架）、现有 verify 脚本防线。

**审查结论（本计划的事实依据）：**

| # | 级别 | 问题 | 位置 |
|---|------|------|------|
| 1 | P1 | 故障卡 action 形状漂移：`derive-failure-card` 产出嵌套 `{command:{command,args}}`，前端 `submitFailureAction`、组件测试、clickability 防线全按扁平 `{command,args}` 处理 → 真实故障卡每个按钮点击都发出 `command: <object>` → 后端 400「未知命令」→ 前端只 `console.error`，用户看到点了没反应 | `src/core/derive-failure-card.mjs:21-67`、`src/app-shell/thread-renderer.js:568-579`、`scripts/verify-app-clickability.cjs:50`（播种的是扁平卡，防线没测到真实形状） |
| 2 | P1 | 故障卡 11 个命令只有 `markResolved` + 记事件，无任何副作用：提高预算不改预算、切换模型不改模型、接受当前稿不推进状态机，blocked 项目无法从卡片恢复 | `src/core/app-server.mjs:846-899`（serveFailuresResolve） |
| 3 | P1 | pause-here 双 bug：(a) 引擎每步扫 last-5 事件且无时间过滤，残留 `failure_resolved/pause-here` 会让下一轮 run 立即退出；(b) pause 路径 `return;` → `startProjectRun.then` 里 `result.completed` 抛 TypeError → 误标 interrupted + `project_run_failed` | `src/core/agent-engine.mjs:75-87`、`src/core/app-server.mjs:1018-1025` |
| 4 | P1 | 成本双重记账：`ModelClient.generate` 直接 `costTracker.record`，agent-engine 再 emit `ModelCallComplete`，cost-tracker 订阅者又 record 一次 → cost.json 的 calls/tokens/cost 全部 ×2，且订阅者把 model 名当 provider 写进 byProvider | `src/core/model-client.mjs:105`、`src/core/agent-engine.mjs:591-597`、`src/core/cost-tracker.mjs:67-82` |
| 5 | P1 | 完成后死路：提示「请先增加目标章节数」，但 settings-runtime 与设置弹窗都不支持改 `target_chapters` | `src/core/settings-runtime.mjs:57-84`、`src/app-shell/settings-modal.js` |
| 6 | P2 | 故障卡字段映射错：读 `expected_words`（实际是 `min_words`）、`data.max/used`（实际是 `max_model_calls/model_calls`）→ 卡片显示「低于 ? 字门槛」「(? / ?)」，提预算永远按 200×2 | `src/core/derive-failure-card.mjs:25-27,43-45,85,89`、`src/core/quality-gates.mjs:9-19` |
| 7 | P2 | switch-model 服务端校验把 model 配置对象数组当字符串数组 `includes(modelId)` → 永远 400 | `src/core/app-server.mjs:838-844` |
| 8 | P2 | `api_key_value` 明文随 `/api/dashboard` 每 1.8s 轮询下发 | `src/core/app-server.mjs:446-464` |
| 9 | P2 | 静态 404 文案是 GBK 乱码「鏈壘鍒?」 | `src/core/app-server.mjs:1142` |
| 10 | P2 | `agentPhaseLabel` 在 app.js 与 agent-truth.mjs 各有一份且映射漂移（needs_revision 一边算写作中一边算审稿中） | `src/app-shell/app.js:664-686`、`src/app-shell/agent-truth.mjs:39-60` |
| 11 | P2 | `stage_entered_at` 前端在用但引擎从未写入 → 活动条耗时永远空 | `src/app-shell/agent-truth.mjs:90`、`src/core/agent-engine.mjs` |
| 12 | P3 | 引擎每步 `loadState`×2 + `saveState`×2（心跳）+ `readEvents`；每次模型调用 `loadEnabledSkills`×3（目录扫描+manifest 解析） | `src/core/agent-engine.mjs:73-95,665-679` |
| 13 | P3 | 设计文档定义的 BeforeToolUse/AfterToolUse 工程 Hook 生命周期未实现，工具执行无统一审计事件 | `src/core/agent-engine.mjs:937-979` |
| 14 | UX | 轮询每 1.8s `setStatus("loading")` → 状态 pill 闪「读取中」 | `src/app-shell/app.js:330` |
| 15 | UX | 导航死路：搜索/自动化点了只弹「即将上线」toast，插件永久 disabled | `src/app-shell/app.js:280-307,476-481` |
| 16 | UX | 长跑时一个运行气泡内章节文件卡无限堆叠（截图实证 6+ 张） | `src/app-shell/thread-renderer.js:490-534` |
| 17 | 清理 | `PLACEHOLDER_*` 注释残留 13 处、根目录调试脚本 probe-direct.mjs / probe-dom.mjs、`model_retry` 事件 severity 用了非标的 "warning" | app.js、thread-renderer.js、仓库根目录、`src/core/agent-engine.mjs:547` |

**Commit 策略:** 每个 Task 一个 commit，`git add` 只加该 Task 明确列出的文件，绝不 `git add -A`。**前置条件：工作树里还有上一轮 M1/B 系列的未提交改动（约 40 个文件），开始本计划前必须先让用户把它们按组提交或 stash，否则同文件的 staging 会混入旧改动。**

---

## 文件结构总览

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/core/failure-actions.mjs` | 把故障卡命令落成真实副作用（改预算/换模型/推进状态机/解除阻塞），返回是否需要续跑 |
| `src/core/tool-hooks.mjs` | BeforeToolUse/AfterToolUse 注册表 + 默认审计 hook（写 `tool_executed` 事件） |
| `tests/derive-failure-card.test.mjs` | 卡片字段映射 + 扁平 action 形状回归 |
| `tests/failure-actions.test.mjs` | 各命令副作用单测 |
| `tests/failure-resolve-flow.test.mjs` | 端到端：resolve → 解除阻塞 → 自动续跑；paused 结果不再误标 interrupted |
| `tests/pause-here.test.mjs` | 残留事件不挡新 run；运行中 pause 干净退出 |
| `tests/cost-double-count.test.mjs` | ModelCallComplete 事件不再二次记账 |
| `tests/tool-hooks.test.mjs` | hook 顺序/否决/审计事件 |
| `tests/project-profile-settings.test.mjs` | 写作目标设置 + 完成项目重新打开 |
| `tests/agent-stage-metadata.test.mjs` | stage_entered_at 落盘 |
| `tests/skill-hook-cache.test.mjs` | collectHooks 接受预载 skills |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/core/derive-failure-card.mjs` | action 扁平化；min_words/max_model_calls 字段映射；switch-model 文案改「去设置切换模型」 |
| `src/core/app-server.mjs` | resolve 接线 applier + 自动续跑；paused 分支；listAllowedModels 返回字符串；404 中文+content-type；api_key 脱敏；`GET /api/settings/model-secret`；完成态文案 |
| `src/core/agent-engine.mjs` | pause 时间窗 + paused 返回值 + paused 状态落盘；setStage 写 stage_entered_at；心跳节流；skill 每步缓存；tool-hooks 接线；emit 不再传 costTracker；model_retry severity |
| `src/core/cost-tracker.mjs` | 删除 ModelCallComplete 订阅者 |
| `src/core/skill-runtime.mjs` | collectHooks 接受 `context.skills` 预载 |
| `src/core/settings-runtime.mjs` | `project_profile`（title/target_chapters/min_words/target_words）+ 完成项目 reopen |
| `src/shared/failure-commands.mjs` | required string 拒绝纯空白 |
| `src/app-shell/agent-truth.mjs` | 导出 agentPhaseLabel；新增 paused 显示分支 |
| `src/app-shell/app.js` | 删本地 agentPhaseLabel；导航收敛为 2 项；项目过滤；静默轮询；threadRenderer ctx 增 openDrawer/openSettingsModal/prefillComposer；删 PLACEHOLDER 注释 |
| `src/app-shell/thread-renderer.js` | submitFailureAction 反馈/兼容/特例；章节卡折叠 rollup；删 PLACEHOLDER 注释 |
| `src/app-shell/settings-modal.js` | 「写作目标」区；API Key 改按需取 |
| `src/app-shell/index.html` | rail 过滤输入框 |
| `src/app-shell/styles.css` | `.rail-filter`、`.filecard-rollup`、`.spd-section` |
| `scripts/verify-app-clickability.cjs` | 导航索引更新；新增过滤框点击 |
| `scripts/verify-app-shell.mjs` | `project-filter` 断言 |
| `README.md` | 「故障卡处理」一节 |

### 执行顺序

```
Task 0（基线）
→ Task 1-4（故障恢复闭环，必须按序）
→ Task 5（pause-here，依赖 Task 3 的 flow 测试文件）
→ Task 6-7（独立小修，可并行）
→ Task 8（api key 脱敏）
→ Task 9-11（引擎流程，按序）
→ Task 12（完成后续写）
→ Task 13-14（UX/Codex 收敛）
→ Task 15（收口验证 + 文档）
```

---

## Task 0: 基线验证与在途改动隔离

**Files:** 无代码改动。

- [ ] **Step 1: 确认在途改动已被用户处理**

```powershell
git status --short
```

预期：输出为空（用户已提交/暂存上一轮 M1/B 系列工作）。若不为空，**停下来问用户**：「工作树有上一轮未提交改动，请先按组提交或 stash（参考 docs/superpowers/reports/2026-06-01-m1-delivery-report.md 的指示），否则本计划的逐任务提交会混入旧改动。」得到确认前不要继续。

- [ ] **Step 2: 跑全量测试确认基线**

```powershell
npm test 2>&1 | Select-Object -Last 8
```

预期：`pass 329`（或更多）、`fail 0`。若有失败，先按 systematic-debugging 处理失败项，不要带病开工。

- [ ] **Step 3: 跑 GUI 冒烟确认基线**

```powershell
npm run verify:app-shell
```

预期：输出含 `"ok": true`。

---

## Task 1: 故障卡数据修复（action 扁平化 + 字段映射）

**Files:**
- Modify: `src/core/derive-failure-card.mjs`
- Test: `tests/derive-failure-card.test.mjs`（新建）

**背景:** 扁平形状 `{ label, command: "fill-words", args: {...} }` 是前端组件、组件测试、clickability 防线已经在用的契约；只有 derive-failure-card 在产出嵌套形状。同文件还把字数门禁的 `min_words` 读成 `expected_words`、把预算的 `max_model_calls/model_calls` 读成 `max/used`。

- [ ] **Step 1: 写失败测试**

创建 `tests/derive-failure-card.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { deriveFailureCard } from "../src/core/derive-failure-card.mjs";

test("words-short 卡读取 min_words 并产出扁平 action", () => {
  const card = deriveFailureCard({
    id: "f1",
    ts: "2026-06-10T00:00:00Z",
    type: "quality_gate_failed",
    message: "word-count gate failed",
    chapter_no: 3,
    data: { gate: "word-count", status: "failed", actual_words: 2380, min_words: 3200, shortfall: 820 }
  }, { current_chapter_no: 3 });
  assert.equal(card.kind, "words-short");
  assert.ok(card.body.includes("3200"), `body 应包含门槛字数: ${card.body}`);
  assert.equal(card.actions[0].command, "fill-words");
  assert.equal(card.actions[0].args.targetWords, 820);
  for (const action of card.actions) {
    assert.equal(typeof action.command, "string", "action.command 必须是命令名字符串");
    assert.equal(typeof action.args, "object");
  }
});

test("budget 卡读取 max_model_calls/model_calls 并按真实预算翻倍", () => {
  const card = deriveFailureCard({
    id: "f2",
    ts: "2026-06-10T00:00:00Z",
    type: "project_blocked",
    message: "model_call_budget_exhausted",
    chapter_no: 5,
    data: { model_calls: 120, max_model_calls: 120 }
  }, {});
  assert.equal(card.kind, "budget-exhausted");
  assert.ok(card.body.includes("120 / 120"), `body: ${card.body}`);
  assert.equal(card.actions[0].command, "raise-budget");
  assert.equal(card.actions[0].args.newMaxModelCalls, 240);
});

test("provider-error 卡的 switch-model 文案引导去设置", () => {
  const card = deriveFailureCard({
    id: "f3",
    ts: "2026-06-10T00:00:00Z",
    type: "project_blocked",
    message: "No provider adapter configured for foo",
    data: {}
  }, {});
  assert.equal(card.kind, "provider-error");
  const switchAction = card.actions.find((a) => a.command === "switch-model");
  assert.equal(switchAction.label, "去设置切换模型");
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --test tests/derive-failure-card.test.mjs
```

预期：FAIL（`card.actions[0].command` 是对象不是字符串；body 含 "?"）。

- [ ] **Step 3: 修改 derive-failure-card.mjs**

把 `actionsForKind` 整体替换为（扁平 + 字段修复）：

```js
function actionsForKind(kind, event) {
  const data = event.data ?? {};
  switch (kind) {
    case 'words-short': {
      const expected = data.min_words ?? data.expected_words ?? null;
      const actual = data.actual_words ?? 0;
      const gap = expected != null ? Math.max(1, expected - actual) : null;
      return [
        gap
          ? { label: `补写 ${gap} 字`, command: 'fill-words', args: { targetWords: gap } }
          : { label: '继续补写', command: 'fill-words', args: { targetWords: 500 } },
        { label: '接受当前字数继续', command: 'accept-current-words', args: {} },
        { label: '跳过本段', command: 'skip-segment', args: {}, destructive: true }
      ];
    }
    case 'tool-rejected':
      return [
        { label: '让它重试', command: 'retry-segment', args: {} },
        { label: '改提示词后重试', command: 'retry-with-prompt', args: { prompt: '' } },
        { label: '停在这里我手动处理', command: 'pause-here', args: {} }
      ];
    case 'budget-exhausted': {
      const current = data.max_model_calls ?? data.max ?? 200;
      return [
        { label: `提高预算到 ${current * 2}`, command: 'raise-budget', args: { newMaxModelCalls: current * 2 } },
        { label: '停在这里', command: 'pause-here', args: {} }
      ];
    }
    case 'provider-error':
      return [
        { label: '重试当前段', command: 'retry-segment', args: {} },
        { label: '去设置切换模型', command: 'switch-model', args: { modelId: '' } },
        { label: '停在这里', command: 'pause-here', args: {} }
      ];
    case 'review-failed':
      return [
        { label: '让它按建议改写', command: 'apply-review-suggestions', args: {} },
        { label: '接受当前稿', command: 'accept-review-current', args: {} },
        { label: '我来人工改', command: 'manual-review-handoff', args: {} }
      ];
    default:
      return [
        { label: '重试', command: 'retry-segment', args: {} },
        { label: '停在这里', command: 'pause-here', args: {} }
      ];
  }
}
```

`bodyForKind` 里两处替换：

```js
    case 'words-short':
      return `第 ${ch} 章本段写了 ${data.actual_words ?? '?'} 字，低于 ${data.min_words ?? data.expected_words ?? '?'} 字门槛。智能体没有继续，等你决定怎么处理。`;
```

```js
    case 'budget-exhausted':
      return `第 ${ch} 章已经用完模型调用预算 (${data.model_calls ?? data.used ?? '?'} / ${data.max_model_calls ?? data.max ?? '?'})，等你决定。`;
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
node --test tests/derive-failure-card.test.mjs
```

预期：PASS 3/3。

- [ ] **Step 5: 提交**

```powershell
git add src/core/derive-failure-card.mjs tests/derive-failure-card.test.mjs
git commit -m "fix(failure-card): flatten action shape to match frontend contract, map real gate/budget fields"
```

---

## Task 2: failure-actions.mjs — 让故障卡命令产生真实副作用

**Files:**
- Create: `src/core/failure-actions.mjs`
- Test: `tests/failure-actions.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

创建 `tests/failure-actions.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyFailureResolution } from "../src/core/failure-actions.mjs";
import { createProject, loadProject, loadState, saveState } from "../src/core/project-store.mjs";
import { readEvents } from "../src/core/event-log.mjs";

async function makeProject(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 3,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  return projectRoot;
}

test("raise-budget 解除预算阻塞并同步 active_budget 与 project.yaml", async () => {
  const projectRoot = await makeProject("wwriting-fa-budget-");
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "blocked",
    current_stage: "blocked",
    blocked_at_stage: "drafting",
    blocked_reason: "model_call_budget_exhausted",
    active_budget: { model_calls: 200, max_model_calls: 200, revision_rounds_by_chapter: {} }
  });
  const result = await applyFailureResolution(projectRoot, { command: "raise-budget", args: { newMaxModelCalls: 400 } });
  assert.equal(result.resumeRun, true);
  const next = await loadState(projectRoot);
  assert.equal(next.project_status, "idle");
  assert.equal(next.current_stage, "drafting");
  assert.equal(next.active_budget.max_model_calls, 400);
  assert.equal(next.active_budget.model_calls, 200, "已消耗的调用数必须保留");
  const project = await loadProject(projectRoot);
  assert.equal(project.budget_config.max_model_calls, 400);
});

test("accept-current-words 把 needs_revision 推进到 finalizing", async () => {
  const projectRoot = await makeProject("wwriting-fa-accept-");
  const state = await loadState(projectRoot);
  await saveState(projectRoot, { ...state, project_status: "idle", current_stage: "needs_revision", current_chapter_no: 2 });
  const result = await applyFailureResolution(projectRoot, { command: "accept-current-words", args: {} });
  assert.equal(result.resumeRun, true);
  const next = await loadState(projectRoot);
  assert.equal(next.current_stage, "finalizing");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "quality_gate_overridden"));
});

test("switch-model 写回 active_model.model_name", async () => {
  const projectRoot = await makeProject("wwriting-fa-switch-");
  const result = await applyFailureResolution(projectRoot, { command: "switch-model", args: { modelId: "mock-writer-backup" } });
  assert.equal(result.resumeRun, true);
  const project = await loadProject(projectRoot);
  assert.equal(project.active_model.model_name, "mock-writer-backup");
});

test("retry-segment 清掉 interrupted 标记", async () => {
  const projectRoot = await makeProject("wwriting-fa-retry-");
  const state = await loadState(projectRoot);
  await saveState(projectRoot, { ...state, project_status: "interrupted", interrupted_reason: "boom", interrupted_at: "2026-06-10T00:00:00Z" });
  const result = await applyFailureResolution(projectRoot, { command: "retry-segment", args: {} });
  assert.equal(result.resumeRun, true);
  const next = await loadState(projectRoot);
  assert.equal(next.project_status, "idle");
  assert.equal(next.interrupted_reason, undefined);
});

test("pause-here 不改状态也不要求续跑", async () => {
  const projectRoot = await makeProject("wwriting-fa-pause-");
  const before = await loadState(projectRoot);
  const result = await applyFailureResolution(projectRoot, { command: "pause-here", args: {} });
  assert.equal(result.resumeRun, false);
  const after = await loadState(projectRoot);
  assert.deepEqual(after, before);
});

test("fill-words 注入补写指令事件", async () => {
  const projectRoot = await makeProject("wwriting-fa-fill-");
  const result = await applyFailureResolution(projectRoot, { command: "fill-words", args: { targetWords: 820 } });
  assert.equal(result.resumeRun, true);
  const events = await readEvents(projectRoot);
  const instruction = events.find((e) => e.type === "user_instruction_received" && e.data?.source === "failure_card");
  assert.ok(instruction, "应写入 user_instruction_received 事件");
  assert.ok(instruction.message.includes("820"));
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --test tests/failure-actions.test.mjs
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 src/core/failure-actions.mjs**

```js
import { appendEvent } from "./event-log.mjs";
import { loadProject, loadState, saveState } from "./project-store.mjs";
import { updateProjectSettings } from "./settings-runtime.mjs";

// 把故障卡上的用户决定落成真实副作用。
// 返回 { resumeRun, message }：resumeRun=true 表示调用方（app-server）应在没有运行中任务时自动续跑。
// 已知限制：若写作任务正在运行，这里的状态修改可能与引擎的下一次 saveState 竞争；
// 引擎每步循环都会重新 loadState，所以最终会收敛，但不保证立即生效。

export async function applyFailureResolution(projectRoot, { command, args = {} } = {}) {
  switch (command) {
    case "pause-here":
    case "manual-review-handoff":
      // 运行中的暂停由引擎对 failure_resolved/pause-here 事件的时间窗检查完成（见 agent-engine）。
      return { resumeRun: false, message: "已停在当前位置，等待你手动处理。" };

    case "retry-segment": {
      await saveResumeableState(projectRoot);
      return { resumeRun: true, message: "已从当前段重试。" };
    }

    case "retry-with-prompt": {
      const prompt = String(args.prompt ?? "").trim();
      if (prompt) {
        await appendUserInstruction(projectRoot, prompt, command, args);
      }
      await saveResumeableState(projectRoot);
      return { resumeRun: true, message: "已按新提示词重试。" };
    }

    case "fill-words": {
      await appendUserInstruction(
        projectRoot,
        `请在不重写全章的前提下补写约 ${args.targetWords} 字，加强当前章节内容；系统会重新统计字数。`,
        command,
        args
      );
      await saveResumeableState(projectRoot);
      return { resumeRun: true, message: `已安排补写约 ${args.targetWords} 字。` };
    }

    case "accept-current-words":
    case "skip-segment":
    case "accept-review-current": {
      const state = await loadState(projectRoot);
      const next = resumeableState(state);
      if (["reviewing", "needs_revision", "revising"].includes(next.current_stage)) {
        next.current_stage = "finalizing";
        next.stage_entered_at = new Date().toISOString();
      }
      await saveState(projectRoot, next);
      await appendEvent(projectRoot, {
        type: "quality_gate_overridden",
        chapter_no: next.current_chapter_no ?? null,
        stage: next.current_stage,
        severity: "warn",
        message: command,
        data: { command }
      });
      return { resumeRun: true, message: "已接受当前稿，继续后续流程。" };
    }

    case "apply-review-suggestions": {
      const state = await loadState(projectRoot);
      const next = resumeableState(state);
      if (next.current_stage === "reviewing") {
        next.current_stage = "needs_revision";
        next.stage_entered_at = new Date().toISOString();
      }
      await saveState(projectRoot, next);
      return { resumeRun: true, message: "已安排按审稿建议修订。" };
    }

    case "raise-budget": {
      await updateProjectSettings(projectRoot, {
        budget_config: { max_model_calls: args.newMaxModelCalls }
      });
      await saveResumeableState(projectRoot);
      return { resumeRun: true, message: `预算已提高到 ${args.newMaxModelCalls}，继续写作。` };
    }

    case "switch-model": {
      const project = await loadProject(projectRoot);
      await updateProjectSettings(projectRoot, {
        active_model: { ...(project.active_model ?? { provider: "mock" }), model_name: args.modelId }
      });
      await saveResumeableState(projectRoot);
      return { resumeRun: true, message: `已切换模型到 ${args.modelId}，继续写作。` };
    }

    default:
      return { resumeRun: false, message: "已记录你的选择。" };
  }
}

async function appendUserInstruction(projectRoot, message, command, args) {
  await appendEvent(projectRoot, {
    type: "user_instruction_received",
    stage: "user_input",
    message,
    data: { source: "failure_card", command, args }
  });
}

async function saveResumeableState(projectRoot) {
  const state = await loadState(projectRoot);
  await saveState(projectRoot, resumeableState(state));
}

// 把 blocked/interrupted/cancelled 状态还原成可续跑状态；其他状态原样返回。
function resumeableState(state) {
  const next = { ...state };
  if (next.current_stage === "blocked") {
    next.current_stage =
      next.blocked_at_stage && next.blocked_at_stage !== "blocked" ? next.blocked_at_stage : "queued";
    next.stage_entered_at = new Date().toISOString();
  }
  if (["blocked", "interrupted", "cancelled", "paused"].includes(next.project_status)) {
    next.project_status = "idle";
  }
  delete next.blocked_reason;
  delete next.blocked_at;
  delete next.blocked_data;
  delete next.blocked_at_stage;
  delete next.interrupted_reason;
  delete next.interrupted_at;
  delete next.cancelled_reason;
  delete next.cancelled_at;
  delete next.paused_at;
  return next;
}
```

注意：`updateProjectSettings({budget_config})` 已有 `syncBudgetConfigToState` 逻辑，会在保留 `model_calls` 消耗的前提下更新 `active_budget.max_model_calls`，所以 raise-budget 不需要自己改 active_budget。

- [ ] **Step 4: 跑测试确认通过**

```powershell
node --test tests/failure-actions.test.mjs
```

预期：PASS 6/6。

- [ ] **Step 5: 提交**

```powershell
git add src/core/failure-actions.mjs tests/failure-actions.test.mjs
git commit -m "feat(failure-actions): apply real side effects for failure card commands"
```

---

## Task 3: /api/failures/resolve 接线 applier + 自动续跑

**Files:**
- Modify: `src/core/app-server.mjs`
- Modify: `src/shared/failure-commands.mjs`
- Test: `tests/failure-resolve-flow.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

创建 `tests/failure-resolve-flow.test.mjs`（server 脚手架抄自 `tests/app-server-probe.test.mjs` 顶部，保持同款端口规避表）：

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../src/core/app-server.mjs";
import { createProject, loadState, saveState } from "../src/core/project-store.mjs";
import { readEvents } from "../src/core/event-log.mjs";
import { appendFailure } from "../src/core/failures-store.mjs";

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080
]);

async function listenOnFetchSafePort(server) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    if (!FETCH_BLOCKED_PORTS.has(port)) {
      return port;
    }
    await closeServer(server);
  }
  throw new Error("Could not allocate a fetch-safe test port");
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function setupServer(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-resolve-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 3,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  const server = createAppShellServer({
    workspaceRoot: root,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(root, ".state"),
    secretsRoot: path.join(root, ".secrets"),
    port: 0,
    ...options
  });
  const port = await listenOnFetchSafePort(server);
  return { root, projectRoot, server, port };
}

async function postJson(port, route, body = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return { res, data };
}

function seedBudgetFailure(projectRoot) {
  appendFailure(projectRoot, {
    id: "fr-budget-1",
    seq: 1,
    chapterNo: 1,
    kind: "budget-exhausted",
    title: "预算已用尽",
    body: "测试卡",
    ts: new Date().toISOString(),
    actions: [{ label: "提高预算到 10", command: "raise-budget", args: { newMaxModelCalls: 10 } }],
    diagnostics: {},
    resolution: null
  });
}

test("resolve raise-budget 解除阻塞并自动续跑", async () => {
  let runnerCalls = 0;
  const ctx = await setupServer({
    testRunProject: async (projectRoot) => {
      runnerCalls += 1;
      return { completed: true, projectRoot };
    }
  });
  try {
    const state = await loadState(ctx.projectRoot);
    await saveState(ctx.projectRoot, {
      ...state,
      project_status: "blocked",
      current_stage: "blocked",
      blocked_at_stage: "drafting",
      blocked_reason: "model_call_budget_exhausted",
      active_budget: { model_calls: 5, max_model_calls: 5, revision_rounds_by_chapter: {} }
    });
    seedBudgetFailure(ctx.projectRoot);

    const { res, data } = await postJson(ctx.port, "/api/failures/resolve", {
      failureId: "fr-budget-1",
      command: "raise-budget",
      args: { newMaxModelCalls: 10 }
    });
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.resumed, true);
    assert.ok(data.message.includes("10"));

    const next = await loadState(ctx.projectRoot);
    assert.equal(next.active_budget.max_model_calls, 10);
    // 等后台 job promise 收尾
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(runnerCalls, 1, "应自动启动一次续跑");
  } finally {
    await closeServer(ctx.server);
  }
});

test("switch-model 用 model_name 字符串列表校验", async () => {
  const ctx = await setupServer({ testRunProject: async (projectRoot) => ({ completed: true, projectRoot }) });
  try {
    appendFailure(ctx.projectRoot, {
      id: "fr-switch-1", seq: 1, chapterNo: 1, kind: "provider-error",
      title: "模型服务出错", body: "测试卡", ts: new Date().toISOString(),
      actions: [{ label: "切换", command: "switch-model", args: { modelId: "mock-writer" } }],
      diagnostics: {}, resolution: null
    });
    const { res, data } = await postJson(ctx.port, "/api/failures/resolve", {
      failureId: "fr-switch-1",
      command: "switch-model",
      args: { modelId: "mock-writer" }
    });
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.ok, true);
  } finally {
    await closeServer(ctx.server);
  }
});

test("runProject 返回 paused 结果时任务正常完结，不误标 interrupted", async () => {
  const ctx = await setupServer({
    testRunProject: async (projectRoot) => ({ completed: false, paused: true, projectRoot })
  });
  try {
    const { res, data } = await postJson(ctx.port, "/api/commands/submit", { message: "开始写作" });
    assert.equal(res.status, 200);
    assert.equal(data.started, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const events = await readEvents(ctx.projectRoot);
    assert.ok(events.some((e) => e.type === "project_run_finished" && e.message.includes("停在")), "应有干净的暂停收尾事件");
    assert.ok(!events.some((e) => e.type === "project_run_failed"), "不应出现 project_run_failed");
    const state = await loadState(ctx.projectRoot);
    assert.notEqual(state.project_status, "interrupted");
  } finally {
    await closeServer(ctx.server);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --test tests/failure-resolve-flow.test.mjs
```

预期：FAIL（resumed 字段不存在；switch-model 400；paused 路径抛 TypeError 产生 project_run_failed）。第三个用例同时是 Task 5 的服务端验收，此时失败属预期。

- [ ] **Step 3: 修改 app-server.mjs — 路由传参**

路由分发处（`/api/failures/resolve`）改为传入运行上下文：

```js
    if (url.pathname === "/api/failures/resolve" && request.method === "POST") {
      await serveFailuresResolve(request, response, { workspace, selected, runJobs, getTaskQueue, testModel, testRunProject, projectLocks });
      return;
    }
```

- [ ] **Step 4: 修改 listAllowedModels 返回字符串**

```js
async function listAllowedModels(projectRoot) {
  const project = await loadProject(projectRoot);
  const config = await loadConfigLayers(projectRoot, project);
  const list = config.effective?.allowed_models;
  const models = Array.isArray(list) && list.length > 0
    ? list
    : config.effective?.active_model
      ? [config.effective.active_model]
      : [];
  return models
    .map((model) => (typeof model === "string" ? model : model?.model_name))
    .filter(Boolean);
}
```

- [ ] **Step 5: 重写 serveFailuresResolve 主体**

在文件顶部 import 区加入：

```js
import { applyFailureResolution } from "./failure-actions.mjs";
```

`serveFailuresResolve` 在 `markResolved` 与 `failure_resolved` 事件之后，追加副作用与续跑（整个函数体用项目锁包裹）：

```js
async function serveFailuresResolve(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const { command, args = {}, failureId } = body;
    if (!failureId) {
      sendError(response, new HttpError(400, "BAD_REQUEST", "缺少 failureId"));
      return;
    }
    const projectRoot = await resolveActiveProjectRoot(context);
    return await withProjectLock(context, projectRoot, async () => {
      const valid = validateFailureCommand(command, args);
      if (!valid.ok) {
        await appendEvent(projectRoot, {
          type: "failure_command_rejected",
          severity: "warn",
          message: valid.error,
          data: { command, failureId }
        });
        sendError(response, new HttpError(400, "BAD_REQUEST", valid.error));
        return;
      }
      if (command === "switch-model") {
        const allowed = await listAllowedModels(projectRoot);
        if (!allowed.includes(args.modelId)) {
          sendError(response, new HttpError(400, "BAD_REQUEST", "modelId 不在允许列表"));
          return;
        }
      }
      const failures = readFailures(projectRoot);
      const match = failures.find((f) => f.id === failureId);
      if (!match) {
        sendError(response, new HttpError(404, "NOT_FOUND", "故障卡不存在"));
        return;
      }
      if (match.resolution) {
        sendError(response, new HttpError(409, "CONFLICT", "故障卡已处理"));
        return;
      }
      markResolved(projectRoot, failureId, {
        action: command,
        submittedAt: new Date().toISOString(),
        args
      });
      await appendEvent(projectRoot, {
        type: "failure_resolved",
        project_id: (await loadProject(projectRoot)).project_id,
        severity: "info",
        message: command,
        data: { failureId, args }
      });
      const applied = await applyFailureResolution(projectRoot, { command, args });
      let resumed = false;
      if (applied.resumeRun) {
        const job = context.runJobs.get(path.resolve(projectRoot));
        if (!isJobRunning(job)) {
          const queue = await context.getTaskQueue(projectRoot);
          const stateNow = await loadState(projectRoot);
          const task =
            (await queue.createRecoveryTask({
              instruction: stateNow.last_user_instruction ?? "继续当前写作任务",
              mode: "write",
              currentStage: stateNow.current_stage ?? "queued",
              recovery: { reason: `failure:${command}` }
            })) ?? (await queue.promoteNext());
          if (task) {
            const project = await loadProject(projectRoot);
            const started = await startProjectRun(projectRoot, project, context, task, { source: "failure_card" });
            resumed = started.started === true;
          }
        }
      }
      await serveJson(response, { ok: true, resumed, message: applied.message });
    });
  } catch (err) {
    sendError(response, err);
  }
}
```

- [ ] **Step 6: failure-commands.mjs 拒绝纯空白必填字符串**

`validateFailureCommand` 的 string 分支加一行：

```js
    if (schema.type === 'string') {
      if (typeof v !== 'string') return { ok: false, error: `${key} 必须是字符串` };
      if (schema.required && v.trim() === '') return { ok: false, error: `缺少必填参数: ${key}` };
      if (schema.maxLength && v.length > schema.maxLength) {
        return { ok: false, error: `${key} 超长 (>${schema.maxLength})` };
      }
    }
```

- [ ] **Step 7: 跑测试**

```powershell
node --test tests/failure-resolve-flow.test.mjs tests/app-server-probe.test.mjs
```

预期：前两个用例 PASS；第三个用例（paused）仍 FAIL——它在 Task 5 转绿。app-server-probe 既有的三个 resolve 用例（`evil-cmd`/`pause-here`×3）全部保持 PASS：响应里新增的 `resumed`/`message` 字段不影响其断言，pause-here 经 applier 返回 `resumeRun:false` 不触发续跑。

- [ ] **Step 8: 提交**

```powershell
git add src/core/app-server.mjs src/shared/failure-commands.mjs tests/failure-resolve-flow.test.mjs
git commit -m "feat(app-server): execute failure card commands and auto-resume runs"
```

---

## Task 4: 前端故障卡反馈与特例

**Files:**
- Modify: `src/app-shell/thread-renderer.js`
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: 改 submitFailureAction**

`thread-renderer.js` 中整体替换：

```js
  async function submitFailureAction(card, action) {
    // 兼容历史 failures.jsonl 里的旧嵌套形状 { command: { command, args } }
    const command = typeof action.command === "string" ? action.command : action.command?.command;
    const args = typeof action.command === "string" ? (action.args ?? {}) : (action.command?.args ?? {});
    if (command === "switch-model" && !args.modelId) {
      ctx.openSettingsModal?.();
      return;
    }
    if (command === "retry-with-prompt" && !String(args.prompt ?? "").trim()) {
      ctx.prefillComposer?.(`/write 重试第 ${card.chapterNo ?? ""} 章当前段，注意：`);
      return;
    }
    try {
      const result = await postJson("/api/failures/resolve", { command, args, failureId: card.id });
      ctx.showToast(result.message ?? "已提交处理。", result.resumed ? "success" : "info");
      void ctx.loadDashboard();
    } catch (error) {
      ctx.showActionError(error);
    }
  }
```

- [ ] **Step 2: app.js 给 threadRenderer 补 ctx**

`createThreadRenderer({...})` 的参数对象里追加三行（放在 `promoteAskEntry` 之前）：

```js
  openDrawer,
  openSettingsModal: (...args) => settingsModal.openSettingsModal(...args),
  prefillComposer: (text) => {
    refs.composerInput.value = text;
    refs.composerInput.focus();
    composer.autoGrowComposer();
    composer.updateSubmitState();
  },
```

说明：`openDrawer` 是函数声明会提升，直接引用安全；`settingsModal`/`composer` 是 const，箭头函数把访问推迟到点击时，初始化完成后才会执行（与现有 `promoteAskEntry` 同一模式）。

- [ ] **Step 3: 语法检查**

```powershell
node --check src/app-shell/thread-renderer.js; node --check src/app-shell/app.js
```

预期：无输出（通过）。

- [ ] **Step 4: 跑组件测试 + GUI 冒烟**

```powershell
node --test tests/app-shell/failure-card-render.test.mjs
npm run verify:app-shell
```

预期：全部 PASS / `ok: true`。

- [ ] **Step 5: 提交**

```powershell
git add src/app-shell/thread-renderer.js src/app-shell/app.js
git commit -m "fix(app-shell): failure card actions give feedback, route switch-model/retry-with-prompt to real UX"
```

---

## Task 5: pause-here 修复（时间窗 + paused 语义贯通）

**Files:**
- Modify: `src/core/agent-engine.mjs`
- Modify: `src/core/app-server.mjs`
- Modify: `src/app-shell/agent-truth.mjs`
- Test: `tests/pause-here.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

创建 `tests/pause-here.test.mjs`：

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProject } from "../src/core/agent-engine.mjs";
import { appendEvent, readEvents } from "../src/core/event-log.mjs";
import { createProject, loadChapterIndex, loadState } from "../src/core/project-store.mjs";

test("历史 pause-here 事件不会阻止新一轮运行", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-pause-stale-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  await appendEvent(projectRoot, { type: "failure_resolved", severity: "info", message: "pause-here", data: { failureId: "old" } });
  await new Promise((resolve) => setTimeout(resolve, 10)); // 保证事件时间戳早于 run 开始
  const result = await runProject(projectRoot);
  assert.equal(result.completed, true);
  const index = await loadChapterIndex(projectRoot);
  assert.equal(index.chapters.filter((c) => c.status === "completed").length, 1);
});

test("运行中收到 pause-here 会干净暂停并返回 paused 结果", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-pause-fresh-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 3,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  let injected = false;
  const result = await runProject(projectRoot, {
    onHeartbeat: async () => {
      if (!injected) {
        injected = true;
        await appendEvent(projectRoot, { type: "failure_resolved", severity: "info", message: "pause-here", data: { failureId: "fresh" } });
      }
    }
  });
  assert.equal(result.paused, true);
  assert.equal(result.completed, false);
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "paused");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "project_paused"));
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --test tests/pause-here.test.mjs
```

预期：两个用例都 FAIL（第一个：run 被残留事件停掉，chapters=0；第二个：返回值是 undefined）。

- [ ] **Step 3: 改 agent-engine.mjs 主循环**

(a) `runProject` 里 `try {` 之前加：

```js
  const runStartedAtMs = Date.now();
```

(b) 把循环开头的整段 pause 检查（`{ const recentEvents = ... return; }` 块）和紧随的 `state = await loadState(projectRoot);` 合并重写为：

```js
      state = await loadState(projectRoot);
      const pauseRequest = await findFreshPauseRequest(projectRoot, runStartedAtMs);
      if (pauseRequest) {
        const paused = { ...state, project_status: "paused", paused_at: new Date().toISOString() };
        await saveState(projectRoot, paused);
        await appendEvent(projectRoot, {
          type: "project_paused",
          severity: "info",
          chapter_no: state.current_chapter_no,
          stage: state.current_stage,
          message: "用户在故障卡选择停在这里",
          data: { source: "failure_resolved", failureId: pauseRequest.data?.failureId }
        });
        return { completed: false, paused: true, projectRoot };
      }
```

(c) 文件底部（`throwIfAborted` 旁）新增：

```js
async function findFreshPauseRequest(projectRoot, sinceMs) {
  const recentEvents = await readEvents(projectRoot, { limit: 5 });
  return (
    recentEvents.find(
      (event) =>
        event.type === "failure_resolved" &&
        event.message === "pause-here" &&
        Date.parse(event.timestamp ?? "") >= sinceMs
    ) ?? null
  );
}
```

- [ ] **Step 4: 改 app-server.mjs startProjectRun 的 .then**

在 `if (result?.blocked) { ... }` 块之后、`await queue.complete(task.id, result);` 之前插入：

```js
      if (result?.paused) {
        job.status = "done";
        await queue.complete(task.id, result);
        await appendEvent(projectRoot, {
          type: "project_run_finished",
          project_id: project.project_id,
          stage: "run",
          message: "已按你的要求停在这里。",
          data: result
        });
        return;
      }
```

并把后面一行 `message: result.completed ? "写作任务已完成。" : "写作任务已停止。"` 改成 `message: result?.completed ? "写作任务已完成。" : "写作任务已停止。"`。

- [ ] **Step 5: agent-truth.mjs 增加 paused 显示**

`computeAgentTruth` 的 `if (status === "cancelled")` 分支后插入：

```js
  if (status === "paused") {
    return { display: "已暂停", className: "idle", showRetry: retryAvailable, showStop: false, refresh: false, reason: "你选择了停在这里，发送新指令或点继续即可恢复" };
  }
```

- [ ] **Step 6: 跑测试确认通过**

```powershell
node --test tests/pause-here.test.mjs tests/failure-resolve-flow.test.mjs tests/agent-engine.test.mjs
```

预期：全部 PASS（含 Task 3 留下的 paused flow 用例）。

- [ ] **Step 7: 提交**

```powershell
git add src/core/agent-engine.mjs src/core/app-server.mjs src/app-shell/agent-truth.mjs tests/pause-here.test.mjs
git commit -m "fix(engine): pause-here uses run-start time window and clean paused result"
```

---

## Task 6: 成本双重记账修复

**Files:**
- Modify: `src/core/cost-tracker.mjs`
- Modify: `src/core/agent-engine.mjs`
- Test: `tests/cost-double-count.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

创建 `tests/cost-double-count.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { CostTracker } from "../src/core/cost-tracker.mjs";
import { emit, CORE_EVENTS } from "../src/core/event-bus.mjs";

test("ModelCallComplete 事件不再把同一次调用二次记账", async () => {
  const tracker = new CostTracker();
  const usageReport = {
    provider: "deepseek",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedTokens: 0
  };
  // ModelClient.generate 内部的唯一一次记账
  tracker.record({ stage: "drafting", usageReport });
  // agent-engine 随后的事件广播——订阅者不得再次 record
  await emit(CORE_EVENTS.ModelCallComplete, {
    projectRoot: "unused",
    model: "deepseek-chat",
    usage: usageReport,
    costTracker: tracker,
    options: { stage: "drafting" }
  });
  const summary = tracker.getSummary();
  assert.equal(summary.calls, 1, `期望 1 次记账，实际 ${summary.calls}`);
  assert.equal(summary.totalTokens, 15);
  assert.equal(summary.byProvider["deepseek-chat"], undefined, "model 名不得污染 byProvider 桶");
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --test tests/cost-double-count.test.mjs
```

预期：FAIL（calls=2，byProvider 出现 "deepseek-chat" 桶）。

- [ ] **Step 3: 删除 cost-tracker.mjs 的订阅者**

删除文件末尾整个 `on(CORE_EVENTS.ModelCallComplete, ...)` 块（含注释），并把首行 import 改为：

```js
import { safeJoin, writeJsonAtomic } from "./fs-utils.mjs";
```

（即去掉 `import { on, CORE_EVENTS } from "./event-bus.mjs";`）

- [ ] **Step 4: agent-engine.mjs 的 emit 不再携带 costTracker**

`runModelGatewayCall` 中的 emit 改为：

```js
  await emit(CORE_EVENTS.ModelCallComplete, {
    projectRoot,
    model: gatewayResult?.modelConfig?.model_name ?? "unknown",
    usage: gatewayResult?.usageReport ?? {},
    options: { stage: state.current_stage, requestKind: request.kind, attempt: request.attempt }
  });
```

（顺带修正了原来取不存在的 `modelConfig.model` 字段的问题——正确字段是 `model_name`。）

- [ ] **Step 5: 跑测试确认通过 + 相关回归**

```powershell
node --test tests/cost-double-count.test.mjs tests/cost-tracker.test.mjs tests/event-bus.test.mjs tests/event-bus-integration.test.mjs tests/agent-engine.test.mjs
```

预期：全部 PASS。

- [ ] **Step 6: 提交**

```powershell
git add src/core/cost-tracker.mjs src/core/agent-engine.mjs tests/cost-double-count.test.mjs
git commit -m "fix(cost): single-source usage recording, stop double counting cost.json"
```

---

## Task 7: 小修合集（404 乱码 / severity / agentPhaseLabel 去重）

**Files:**
- Modify: `src/core/app-server.mjs`
- Modify: `src/core/agent-engine.mjs`
- Modify: `src/app-shell/agent-truth.mjs`
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: app-server.mjs 静态响应文案**

`serveStatic` 内三处：

```js
  if (isSharedModule && ![".js", ".mjs"].includes(path.extname(requested))) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("未找到");
    return;
  }
```

```js
  if (!isPathInside(root, target)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("禁止访问");
    return;
  }
```

```js
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("未找到");
  }
```

- [ ] **Step 2: agent-engine.mjs model_retry severity**

`createModelRuntime` 的 onRetry 里 `severity: "warning"` 改为 `severity: "warn"`。

- [ ] **Step 3: agent-truth.mjs 导出 agentPhaseLabel**

`function agentPhaseLabel(...)` 改为 `export function agentPhaseLabel(...)`。

- [ ] **Step 4: app.js 删除本地副本并改用导入**

首行 import 改为：

```js
import { computeAgentTruth, deriveFailures, deriveActivity, deriveBadges, agentPhaseLabel } from "./agent-truth.mjs";
```

删除 app.js 里整个本地 `function agentPhaseLabel(status, stage) { ... }` 函数（含「顶栏 Agent 状态」注释行）。统一后的映射以 agent-truth 版为准（needs_revision/revising 归「审稿中」）。

- [ ] **Step 5: 验证**

```powershell
node --check src/core/app-server.mjs; node --check src/core/agent-engine.mjs; node --check src/app-shell/app.js; node --check src/app-shell/agent-truth.mjs
npm run verify:app-shell
```

预期：语法通过、冒烟 `ok: true`。

- [ ] **Step 6: 提交**

```powershell
git add src/core/app-server.mjs src/core/agent-engine.mjs src/app-shell/agent-truth.mjs src/app-shell/app.js
git commit -m "fix: mojibake 404 body, warn severity, dedupe agentPhaseLabel"
```

---

## Task 8: API Key 不再随轮询明文下发

**Files:**
- Modify: `src/core/app-server.mjs`
- Modify: `src/app-shell/settings-modal.js`
- Test: 在 `tests/failure-resolve-flow.test.mjs` 同款脚手架上新增用例（追加进该文件末尾）

- [ ] **Step 1: 写失败测试（追加到 tests/failure-resolve-flow.test.mjs 末尾）**

```js
test("dashboard 不下发明文 API Key，model-secret 端点按需返回", async () => {
  const ctx = await setupServer();
  try {
    const save = await postJson(ctx.port, "/api/settings/update", {
      active_model: {
        provider: "openai-compatible",
        model_name: "deepseek-chat",
        base_url: "https://api.deepseek.com",
        api_key: "sk-secret-abcd1234",
        api_key_env: "WW_TEST_KEY"
      }
    });
    assert.equal(save.res.status, 200, JSON.stringify(save.data));

    const dashRes = await fetch(`http://127.0.0.1:${ctx.port}/api/dashboard`);
    const dashText = await dashRes.text();
    assert.ok(!dashText.includes("sk-secret-abcd1234"), "dashboard 响应不得包含明文 key");
    const dash = JSON.parse(dashText);
    assert.equal(dash.model_profile.api_key_saved, true);
    assert.ok(dash.model_profile.api_key_masked.endsWith("1234"));

    const secretRes = await fetch(`http://127.0.0.1:${ctx.port}/api/settings/model-secret`);
    const secret = await secretRes.json();
    assert.equal(secret.ok, true);
    assert.equal(secret.value, "sk-secret-abcd1234");
  } finally {
    await closeServer(ctx.server);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --test tests/failure-resolve-flow.test.mjs
```

预期：新用例 FAIL（dashboard 含明文 key；/api/settings/model-secret 404 落到静态分支）。

- [ ] **Step 3: app-server.mjs — 脱敏 + 新端点**

(a) `buildModelProfile` 中替换 `api_key_value` 行：

```js
    api_key_saved: Boolean(secretValue),
    api_key_masked: secretValue ? `••••${secretValue.slice(-4)}` : "",
```

（删除 `api_key_value: secretValue,` 一行。）

(b) 路由表加（放在 `/api/settings/update` 之后）：

```js
    if (url.pathname === "/api/settings/model-secret" && request.method === "GET") {
      await serveModelSecret(response, { workspace, selected, secretsRoot: localSecretsRoot });
      return;
    }
```

(c) 新增 handler（放在 `serveSettingsUpdate` 之后）：

```js
async function serveModelSecret(response, context) {
  try {
    const projectRoot = await resolveActiveProjectRoot(context);
    const project = await loadProject(projectRoot);
    const config = await loadConfigLayers(projectRoot, project);
    const envName = config.effective?.active_model?.api_key_env ?? null;
    const value = envName ? loadLocalSecretsSync(context.secretsRoot)[envName] ?? process.env[envName] ?? "" : "";
    await serveJson(response, { ok: true, env: envName, value });
  } catch (error) {
    sendError(response, new HttpError(400, "model_secret_failed", error.message));
  }
}
```

- [ ] **Step 4: settings-modal.js 改为按需取 key**

(a) `createSettingsModal` 内新增：

```js
  async function fetchModelSecret() {
    try {
      const data = await getJson("/api/settings/model-secret");
      return data.value ?? "";
    } catch {
      return "";
    }
  }
```

(b) `renderSettingsDetail` 中 apiKey 字段改为空值初始化：

```js
    settingsFields.apiKey = settingField("API Key", "password", { placeholder: "粘贴官方 API Key", value: "", secret: true });
```

(c) `renderSettingsDetail` 末尾（`updateEndpointPreview();` 之后）追加：

```js
    if (usingThisPreset && profile.api_key_saved) {
      void fetchModelSecret().then((value) => {
        if (value && settingsFields.apiKey.input.isConnected && !settingsFields.apiKey.input.value) {
          settingsFields.apiKey.input.value = value;
        }
      });
    }
```

- [ ] **Step 5: 全仓确认无 api_key_value 残留引用**

```powershell
Select-String -Path src\**\*.js, src\**\*.mjs, scripts\*.mjs, scripts\*.cjs -Pattern "api_key_value"
```

预期：无输出。若 verify 脚本里有引用，把断言改为 `api_key_masked`。

- [ ] **Step 6: 跑测试确认通过**

```powershell
node --test tests/failure-resolve-flow.test.mjs
npm run verify:app-shell
```

预期：全部 PASS / `ok: true`。

- [ ] **Step 7: 提交**

```powershell
git add src/core/app-server.mjs src/app-shell/settings-modal.js tests/failure-resolve-flow.test.mjs
git commit -m "fix(security): stop shipping raw api key in dashboard polls, fetch on demand"
```

---

## Task 9: stage_entered_at + 心跳节流

**Files:**
- Modify: `src/core/agent-engine.mjs`
- Test: `tests/agent-stage-metadata.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

创建 `tests/agent-stage-metadata.test.mjs`：

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProject } from "../src/core/agent-engine.mjs";
import { createProject, loadState } from "../src/core/project-store.mjs";

test("阶段切换写入 stage_entered_at，心跳仍然更新", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-stagemeta-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  const stamps = [];
  await runProject(projectRoot, {
    onHeartbeat: async () => {
      const state = await loadState(projectRoot);
      if (state.stage_entered_at) stamps.push(`${state.current_stage}@${state.stage_entered_at}`);
    }
  });
  const state = await loadState(projectRoot);
  assert.ok(state.stage_entered_at, "最终状态必须有 stage_entered_at");
  assert.ok(!Number.isNaN(Date.parse(state.stage_entered_at)));
  assert.ok(state.last_heartbeat, "心跳仍需写入");
  assert.ok(new Set(stamps.map((s) => s.split("@")[0])).size >= 2, "至少经历两个不同阶段的时间戳");
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --test tests/agent-stage-metadata.test.mjs
```

预期：FAIL（stage_entered_at 为 undefined）。

- [ ] **Step 3: agent-engine.mjs 加 setStage 助手并替换所有阶段赋值**

(a) 文件底部新增：

```js
// 切换阶段时盖时间戳；同阶段重入不刷新（活动条耗时依赖它）。
function setStage(state, stage) {
  if (state.current_stage !== stage) {
    state.stage_entered_at = new Date().toISOString();
  }
  state.current_stage = stage;
  return state;
}
```

(b) 逐处替换（保持原语义，只把直接赋值换成 setStage）：

| 位置 | 原代码 | 新代码 |
|---|---|---|
| runProject 开头 | `state.current_stage = "queued";` | `setStage(state, "queued");` |
| runProject 完成分支 | `state.project_status = "completed"; state.current_stage = "completed";` | `state.project_status = "completed"; setStage(state, "completed");` |
| enterPlanning | `state.current_stage = "planning";` | `setStage(state, "planning");` |
| enterPlanning 尾部 | `state.current_stage = "planned";` | `setStage(state, "planned");` |
| enterDrafting | `state.current_stage = "drafting";` | `setStage(state, "drafting");` |
| draftNextSegment 门禁通过 | `const next = { ...state, current_stage: "reviewing" };` | `const next = setStage({ ...state }, "reviewing");` |
| draftNextSegment 段落写入后 | `const next = { ...latestState, current_stage: "drafting", current_segment_no: segmentNo };` | `const next = setStage({ ...latestState, current_segment_no: segmentNo }, "drafting");` |
| reviewChapter 字数失败 | `const next = { ...state, current_stage: "needs_revision", last_quality_gate_results: [gate] };` | `const next = setStage({ ...state, last_quality_gate_results: [gate] }, "needs_revision");` |
| reviewChapter 技能失败 | `const next = { ...state, current_stage: "needs_revision", last_quality_gate_results: qualityResults };` | `const next = setStage({ ...state, last_quality_gate_results: qualityResults }, "needs_revision");` |
| reviewChapter 通过 | `const next = { ...state, current_stage: "finalizing" };` | `const next = setStage({ ...state }, "finalizing");` |
| reviseChapter | `const next = { ...latestState, current_stage: "reviewing", current_segment_no: segmentNo };` | `const next = setStage({ ...latestState, current_segment_no: segmentNo }, "reviewing");` |
| finalizeChapter | `const next = { ...state, current_stage: "summarizing" };` | `const next = setStage({ ...state }, "summarizing");` |
| completeChapter | `current_stage: nextChapter > project.target_chapters ? "completed" : "queued",` | 构造后调用：`const next = setStage({ ...state, current_chapter_no: nextChapter, current_segment_no: 0 }, nextChapter > project.target_chapters ? "completed" : "queued");` |
| blockProject | `current_stage: "blocked",` | **从 `const next = {...}` 字面量中删除这一行**，然后在字面量之后、`await saveState(projectRoot, next);` 之前调用 `setStage(next, "blocked");`（若字面量里保留该行，setStage 会因阶段未变化而不盖时间戳） |

- [ ] **Step 4: 心跳节流**

主循环里心跳段替换为：

```js
      const nowIso = new Date().toISOString();
      const lastBeatMs = Date.parse(state.last_heartbeat ?? "");
      if (Number.isNaN(lastBeatMs) || Date.now() - lastBeatMs > 1500) {
        state.last_heartbeat = nowIso;
        await saveState(projectRoot, state);
      }
      if (typeof options.onHeartbeat === "function") {
        await options.onHeartbeat({ step, stage: state.current_stage, chapter: state.current_chapter_no });
      }
```

- [ ] **Step 5: 跑测试**

```powershell
node --test tests/agent-stage-metadata.test.mjs tests/agent-engine.test.mjs tests/pause-here.test.mjs
npm run verify:mvp
```

预期：全部 PASS；verify:mvp 通过（3 章 + 中断恢复）。

- [ ] **Step 6: 提交**

```powershell
git add src/core/agent-engine.mjs tests/agent-stage-metadata.test.mjs
git commit -m "feat(engine): stamp stage_entered_at on transitions, throttle heartbeat writes"
```

---

## Task 10: skill hooks 每步缓存

**Files:**
- Modify: `src/core/skill-runtime.mjs`
- Modify: `src/core/agent-engine.mjs`
- Test: `tests/skill-hook-cache.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

创建 `tests/skill-hook-cache.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { collectSkillPromptHooks, runSkillChecks } from "../src/core/skill-runtime.mjs";

const fakeSkills = [{
  name: "cached-skill",
  version: "1.0.0",
  type: "flow-control",
  enabled: true,
  priority: 10,
  hooks: [
    { stage: "planning", action: "append_prompt", content: "FROM-CACHE" },
    { stage: "reviewing", action: "check", check: "suspense-ending" }
  ]
}];

test("collectSkillPromptHooks 优先使用 context.skills，不碰磁盘", async () => {
  const result = await collectSkillPromptHooks("Z:/definitely-not-a-real-root", {}, "planning", { skills: fakeSkills });
  assert.ok(result.content.includes("FROM-CACHE"));
  assert.equal(result.hooks.length, 1);
});

test("runSkillChecks 同样接受 context.skills", async () => {
  const results = await runSkillChecks("Z:/definitely-not-a-real-root", {}, "reviewing", {
    skills: fakeSkills,
    content: "正文……结尾有一个巨大的悬念钩子！？"
  });
  assert.equal(results.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --test tests/skill-hook-cache.test.mjs
```

预期：FAIL 或者因不存在路径报错（当前实现必扫磁盘）。

- [ ] **Step 3: skill-runtime.mjs collectHooks 接受预载**

`collectHooks` 首行替换：

```js
export async function collectHooks(projectRoot, project, stage, action, context = {}) {
  const skills = Array.isArray(context.skills) ? context.skills : await loadEnabledSkills(projectRoot, project);
```

（其余不变；`collectSkillPromptHooks`/`runSkillChecks`/`runPostProcessHooks` 都经由 collectHooks，自动获益。）

- [ ] **Step 4: agent-engine.mjs 每步预载一次**

(a) `createModelRuntime` 返回对象加一项：

```js
  return {
    modelClient,
    cacheKeyManager: options.cacheKeyManager ?? new CacheKeyManager({ entries: existingCacheReport.entries ?? {} }),
    stepSkills: null
  };
```

(b) 主循环每步开头（pause 检查之后）加：

```js
      runtime.stepSkills = await loadEnabledSkills(projectRoot, project);
```

并在文件顶部 import 里给 skill-runtime 增加 `loadEnabledSkills`：

```js
import { collectSkillPromptHooks, loadEnabledSkills, runPostProcessHooks, runSkillChecks } from "./skill-runtime.mjs";
```

(c) 把 runtime 传进各阶段函数（签名与调用点同步改）：

- `case "queued": await enterPlanning(projectRoot, project, state, runtime);`
- `case "reviewing": await reviewChapter(projectRoot, project, state, runtime);`
- `case "finalizing": await finalizeChapter(projectRoot, project, state, runtime);`
- 函数定义对应加第 4 参 `runtime`。

(d) 各 hook 调用点把 context 加 `skills`：

- enterPlanning：`collectSkillPromptHooks(projectRoot, project, "planning", { chapter_no: state.current_chapter_no, stage: "planning", skills: runtime.stepSkills })`
- reviewChapter：`runSkillChecks(projectRoot, project, "reviewing", { chapter_no: ..., stage: "reviewing", content: draft, skills: runtime.stepSkills })`
- finalizeChapter：`runPostProcessHooks(projectRoot, project, { chapter_no: ..., stage: "post_process", content: draft, skills: runtime.stepSkills })`
- compileChapterPrompt：签名改为 `compileChapterPrompt(projectRoot, project, state, request, runtime)`，内部两处 `collectSkillPromptHooks(...)` 的 context 各加 `skills: runtime?.stepSkills ?? undefined`；`runModelGatewayCall` 调用处改为 `compileChapterPrompt(projectRoot, project, state, request, runtime)`。

- [ ] **Step 5: 跑测试**

```powershell
node --test tests/skill-hook-cache.test.mjs tests/skill-runtime.test.mjs tests/agent-engine.test.mjs
npm run verify:mvp
```

预期：全部 PASS（若 skill-runtime 测试文件名不同，以 `node --test tests/*.test.mjs` 全跑兜底）。

- [ ] **Step 6: 提交**

```powershell
git add src/core/skill-runtime.mjs src/core/agent-engine.mjs tests/skill-hook-cache.test.mjs
git commit -m "perf(skills): preload enabled skills once per engine step"
```

---

## Task 11: BeforeToolUse/AfterToolUse 工具钩子管道

**Files:**
- Create: `src/core/tool-hooks.mjs`
- Modify: `src/core/agent-engine.mjs`
- Test: `tests/tool-hooks.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

创建 `tests/tool-hooks.test.mjs`：

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  registerToolHook,
  runBeforeToolUse,
  runAfterToolUse,
  ensureDefaultToolHooks,
  _resetToolHooks
} from "../src/core/tool-hooks.mjs";
import { runProject } from "../src/core/agent-engine.mjs";
import { createProject } from "../src/core/project-store.mjs";
import { readEvents } from "../src/core/event-log.mjs";

test("BeforeToolUse 否决会短路后续 hook", async () => {
  _resetToolHooks();
  const order = [];
  registerToolHook("BeforeToolUse", async () => { order.push("first"); return { allow: false, reason: "nope" }; });
  registerToolHook("BeforeToolUse", async () => { order.push("second"); });
  const result = await runBeforeToolUse({});
  assert.equal(result.allow, false);
  assert.equal(result.reason, "nope");
  assert.deepEqual(order, ["first"]);
});

test("AfterToolUse 单个 hook 抛错不影响其余", async () => {
  _resetToolHooks();
  let ran = false;
  registerToolHook("AfterToolUse", async () => { throw new Error("boom"); });
  registerToolHook("AfterToolUse", async () => { ran = true; });
  await runAfterToolUse({});
  assert.equal(ran, true);
});

test("默认审计 hook 写 tool_executed 事件", async () => {
  _resetToolHooks();
  ensureDefaultToolHooks();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-toolhook-"));
  const { projectRoot } = await createProject(root, { slug: "project" });
  await runAfterToolUse({
    projectRoot,
    project: { project_id: "p" },
    state: { current_stage: "drafting" },
    toolCall: { tool: "append_chapter_segment", input: { chapter_no: 1 } },
    result: { bytes_written: 10, actual_words: 5, checksum: "sha256:x" },
    ok: true,
    durationMs: 12
  });
  const events = await readEvents(projectRoot);
  const audit = events.find((e) => e.type === "tool_executed");
  assert.ok(audit);
  assert.equal(audit.data.duration_ms, 12);
});

test("引擎集成：跑完一章后 run_log 含 tool_executed", async () => {
  _resetToolHooks();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-toolhook-run-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  await runProject(projectRoot);
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "tool_executed" && e.data?.ok === true));
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --test tests/tool-hooks.test.mjs
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 src/core/tool-hooks.mjs**

```js
// 工程安全层 Tool Hook 生命周期（与写作 skill hook 分开）：
// BeforeToolUse 可一票否决工具执行；AfterToolUse 用于审计，单个 hook 失败不阻断主流程。
import { appendEvent } from "./event-log.mjs";

const registry = { BeforeToolUse: [], AfterToolUse: [] };
let defaultsRegistered = false;

export function registerToolHook(phase, fn) {
  if (!registry[phase]) {
    throw new Error(`Unknown tool hook phase: ${phase}`);
  }
  if (typeof fn !== "function") {
    throw new Error("tool hook must be a function");
  }
  registry[phase].push(fn);
  return () => {
    const index = registry[phase].indexOf(fn);
    if (index >= 0) registry[phase].splice(index, 1);
  };
}

export async function runBeforeToolUse(context) {
  for (const hook of registry.BeforeToolUse) {
    const result = await hook(context);
    if (result && result.allow === false) {
      return { allow: false, reason: result.reason ?? "blocked by BeforeToolUse hook" };
    }
  }
  return { allow: true };
}

export async function runAfterToolUse(context) {
  for (const hook of registry.AfterToolUse) {
    try {
      await hook(context);
    } catch (error) {
      console.warn("AfterToolUse hook failed:", error.message);
    }
  }
}

export function ensureDefaultToolHooks() {
  if (defaultsRegistered) {
    return;
  }
  defaultsRegistered = true;
  registerToolHook("AfterToolUse", async (context) => {
    await appendEvent(context.projectRoot, {
      type: "tool_executed",
      project_id: context.project?.project_id ?? null,
      chapter_no: context.toolCall?.input?.chapter_no ?? null,
      stage: context.state?.current_stage ?? null,
      severity: context.ok ? "info" : "warn",
      message: `${context.toolCall?.tool ?? "unknown-tool"} ${context.ok ? "executed" : "failed"} in ${context.durationMs}ms`,
      data: {
        tool: context.toolCall?.tool ?? null,
        ok: context.ok,
        duration_ms: context.durationMs,
        bytes_written: context.result?.bytes_written ?? null,
        actual_words: context.result?.actual_words ?? null,
        checksum: context.result?.checksum ?? null,
        error: context.error?.message ?? null
      }
    });
  });
}

export function _resetToolHooks() {
  registry.BeforeToolUse.length = 0;
  registry.AfterToolUse.length = 0;
  defaultsRegistered = false;
}
```

- [ ] **Step 4: agent-engine.mjs 接线**

(a) import：

```js
import { ensureDefaultToolHooks, runAfterToolUse, runBeforeToolUse } from "./tool-hooks.mjs";
```

(b) `createModelRuntime` 开头加一行 `ensureDefaultToolHooks();`。

(c) `executeToolCall` 改为：

```js
async function executeToolCall(projectRoot, project, state, toolCall, options) {
  if (toolCall.tool !== "append_chapter_segment") {
    await blockProject(projectRoot, project, state, "unsupported_tool", {
      tool: toolCall.tool
    });
    throw new ProjectBlockedError("unsupported_tool");
  }
  const before = await runBeforeToolUse({ projectRoot, project, state, toolCall });
  if (before.allow === false) {
    await appendEvent(projectRoot, {
      type: "tool_call_rejected",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: state.current_stage,
      severity: "error",
      message: before.reason,
      data: { code: "before_tool_use_rejected", tool: toolCall.tool }
    });
    await blockProject(projectRoot, project, state, "before_tool_use_rejected", { reason: before.reason });
    throw new ProjectBlockedError("before_tool_use_rejected");
  }
  const startedAt = Date.now();
  try {
    const result = await appendChapterSegment(projectRoot, project, toolCall.input, {
      requireProjectId: true,
      ...options
    });
    await runAfterToolUse({ projectRoot, project, state, toolCall, result, ok: true, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    await runAfterToolUse({ projectRoot, project, state, toolCall, error, ok: false, durationMs: Date.now() - startedAt });
    if (error instanceof ToolValidationError) {
      // ……以下保持原有 ToolValidationError 处理块不变……
```

（catch 内原有内容原样保留。）

- [ ] **Step 5: 跑测试**

```powershell
node --test tests/tool-hooks.test.mjs tests/agent-engine.test.mjs
npm run verify:mvp
```

预期：全部 PASS。

- [ ] **Step 6: 提交**

```powershell
git add src/core/tool-hooks.mjs src/core/agent-engine.mjs tests/tool-hooks.test.mjs
git commit -m "feat(tool-hooks): BeforeToolUse/AfterToolUse pipeline with tool_executed audit"
```

---

## Task 12: 完成后续写路径（写作目标可改）

**Files:**
- Modify: `src/core/settings-runtime.mjs`
- Modify: `src/core/app-server.mjs`
- Modify: `src/app-shell/settings-modal.js`
- Modify: `src/app-shell/composer.js`
- Modify: `src/app-shell/styles.css`
- Test: `tests/project-profile-settings.test.mjs`（新建）

- [ ] **Step 1: 写失败测试**

创建 `tests/project-profile-settings.test.mjs`：

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateProjectSettings } from "../src/core/settings-runtime.mjs";
import { createProject, loadProject, loadState, saveState } from "../src/core/project-store.mjs";
import { readEvents } from "../src/core/event-log.mjs";

async function makeProject(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 3,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  return projectRoot;
}

test("project_profile 可以更新标题/目标章节数/最低字数", async () => {
  const projectRoot = await makeProject("wwriting-profile-");
  const next = await updateProjectSettings(projectRoot, {
    project_profile: { title: "新标题", target_chapters: 10, min_words_per_chapter: 500 }
  });
  assert.equal(next.title, "新标题");
  assert.equal(next.target_chapters, 10);
  assert.equal(next.min_words_per_chapter, 500);
  assert.ok(next.target_words_per_chapter >= 500, "target_words 不得低于 min_words");
  const onDisk = await loadProject(projectRoot);
  assert.equal(onDisk.target_chapters, 10);
});

test("提高目标章节数会重新打开已完成项目", async () => {
  const projectRoot = await makeProject("wwriting-reopen-");
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "completed",
    current_stage: "completed",
    current_chapter_no: 4
  });
  await updateProjectSettings(projectRoot, { project_profile: { target_chapters: 6 } });
  const next = await loadState(projectRoot);
  assert.equal(next.project_status, "idle");
  assert.equal(next.current_stage, "queued");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "project_reopened"));
});

test("目标章节数低于已写章节时不重新打开", async () => {
  const projectRoot = await makeProject("wwriting-noreopen-");
  const state = await loadState(projectRoot);
  await saveState(projectRoot, {
    ...state,
    project_status: "completed",
    current_stage: "completed",
    current_chapter_no: 4
  });
  await updateProjectSettings(projectRoot, { project_profile: { target_chapters: 2 } });
  const next = await loadState(projectRoot);
  assert.equal(next.project_status, "completed");
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --test tests/project-profile-settings.test.mjs
```

预期：FAIL（project_profile 被忽略，title 未变）。

- [ ] **Step 3: settings-runtime.mjs 实现 project_profile**

(a) `normalizeSettingsPatch` 在 `output_style` 块后加：

```js
  if (patch.project_profile !== undefined) {
    normalized.project_profile = normalizeProjectProfile(patch.project_profile);
  }
```

(b) 新增（放 `normalizeOutputStyle` 后）：

```js
function normalizeProjectProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new SettingsValidationError("invalid_project_profile", "project_profile must be an object.");
  }
  const normalized = {};
  if (profile.title !== undefined && profile.title !== null && profile.title !== "") {
    normalized.title = safeNonEmptyString(profile.title, "title");
  }
  copyOptionalPositiveInteger(normalized, profile, "target_chapters");
  copyOptionalPositiveInteger(normalized, profile, "min_words_per_chapter");
  copyOptionalPositiveInteger(normalized, profile, "target_words_per_chapter");
  return normalized;
}
```

(c) `mergeProjectSettings` 在 `output_style` 块后加：

```js
  if (patch.project_profile !== undefined) {
    for (const [key, value] of Object.entries(patch.project_profile)) {
      if (value !== null && value !== undefined) {
        next[key] = value;
      }
    }
    if (
      Number.isInteger(next.min_words_per_chapter) &&
      Number.isInteger(next.target_words_per_chapter) &&
      next.target_words_per_chapter < next.min_words_per_chapter
    ) {
      next.target_words_per_chapter = next.min_words_per_chapter;
    }
  }
```

(d) `updateProjectSettings` 在 `syncBudgetConfigToState` 之后加：

```js
  await maybeReopenCompletedProject(projectRoot, next, normalized.project_profile);
```

并新增：

```js
// 提高目标章节数时把已完成项目转回可续写状态。
async function maybeReopenCompletedProject(projectRoot, project, profile) {
  if (!profile?.target_chapters) {
    return;
  }
  const state = await loadState(projectRoot);
  if (state.project_status !== "completed") {
    return;
  }
  if ((state.current_chapter_no ?? 1) > project.target_chapters) {
    return;
  }
  await saveState(projectRoot, {
    ...state,
    project_status: "idle",
    current_stage: "queued",
    stage_entered_at: new Date().toISOString()
  });
  await appendEvent(projectRoot, {
    type: "project_reopened",
    project_id: project.project_id,
    chapter_no: state.current_chapter_no,
    stage: "queued",
    message: `目标章节数提高到 ${project.target_chapters}，项目可以继续写作。`
  });
}
```

- [ ] **Step 4: 设置弹窗加「写作目标」区**

`settings-modal.js` 的 `renderSettingsDetail`：

(a) 在 outputStyle 字段构建完后（`settingsFields.outputStyle = ...` 之后）加：

```js
    const profileHeading = document.createElement("h4");
    profileHeading.className = "spd-section";
    profileHeading.textContent = "写作目标";
    settingsFields.profileTitle = settingField("小说名", "text", { value: dashboard?.project?.title ?? "" });
    settingsFields.targetChapters = settingField("目标章节数（提高它可以继续已完成的小说）", "number", { value: dashboard?.project?.target_chapters ?? "" });
    settingsFields.minWords = settingField("每章最低字数", "number", { value: dashboard?.project?.min_words_per_chapter ?? "" });
```

(b) `ctx.refs.settingsDetail.append(...)` 列表末尾追加：

```js
      profileHeading, settingsFields.profileTitle.field, settingsFields.targetChapters.field, settingsFields.minWords.field
```

(c) `saveSettings` 的 postJson body 加：

```js
        project_profile: compactObject({
          title: settingsFields.profileTitle.input.value.trim(),
          target_chapters: settingsFields.targetChapters.input.value,
          min_words_per_chapter: settingsFields.minWords.input.value
        }),
```

- [ ] **Step 5: 完成态文案统一**

(a) `composer.js` 的 `resultMessageForCommand`：

```js
    if (result.completed) return "项目已完成；在「设置 → 写作目标」里提高目标章节数即可继续。";
```

(b) `app-server.mjs` 两处 `message: "项目已完成；如需继续写，请先增加目标章节数。"` 都改为 `"项目已完成；在「设置 → 写作目标」里提高目标章节数即可继续。"`。

(c) `styles.css` 末尾加：

```css
.spd-section { margin: 18px 0 4px; font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: 0.02em; }
```

- [ ] **Step 6: 跑测试**

```powershell
node --test tests/project-profile-settings.test.mjs tests/settings-runtime.test.mjs
npm run verify:app-shell
```

预期：全部 PASS / `ok: true`（settings-runtime 既有测试若文件名不同以全量跑兜底）。

- [ ] **Step 7: 提交**

```powershell
git add src/core/settings-runtime.mjs src/core/app-server.mjs src/app-shell/settings-modal.js src/app-shell/composer.js src/app-shell/styles.css tests/project-profile-settings.test.mjs
git commit -m "feat(settings): editable writing goals, reopen completed projects when target raised"
```

---

## Task 13: 导航收敛 + 项目过滤（Codex 风格）

**Files:**
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/index.html`
- Modify: `src/app-shell/styles.css`
- Modify: `scripts/verify-app-clickability.cjs`
- Modify: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: index.html 加过滤输入框**

`rail-scroll` 区块改为：

```html
        <div class="rail-scroll">
          <div class="rail-group-label"><span>我的小说</span><span class="count" id="project-count">0</span></div>
          <div class="rail-filter"><input id="project-filter" type="search" placeholder="搜索我的小说…" aria-label="搜索我的小说" spellcheck="false" /></div>
          <div id="project-list"></div>
          <p id="project-open-status" class="rail-group-label" style="display:none"></p>
        </div>
```

- [ ] **Step 2: styles.css 加过滤框样式**

```css
.rail-filter { padding: 0 12px 8px; }
.rail-filter input {
  width: 100%;
  border: 1px solid var(--line);
  background: var(--surface-2);
  border-radius: var(--r-sm);
  padding: 6px 9px;
  font-size: 12px;
  color: var(--ink);
  outline: none;
}
.rail-filter input::placeholder { color: var(--faint); }
.rail-filter input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--focus-ring); }
```

- [ ] **Step 3: app.js 导航收敛 + 过滤逻辑**

(a) refs 增加（refs 对象内）：

```js
  projectFilter: document.querySelector("#project-filter"),
```

(b) `renderRailNav` 整个函数替换为（收敛成两个真实可用项，删掉 disabled/nav-soon 分支）：

```js
function renderRailNav() {
  const items = [
    { key: "new", icon: "compose", label: "新对话" },
    { key: "skill", icon: "skill", label: "技能" }
  ];
  refs.railNav.replaceChildren(...items.map((item) => {
    const button = document.createElement("button");
    button.className = "nav-item";
    button.type = "button";
    button.append(icon(item.icon, 16));
    const span = document.createElement("span");
    span.textContent = item.label;
    button.append(span);
    button.addEventListener("click", () => handleNav(item.key));
    return button;
  }));
}
```

(c) `handleNav` 删除 `search` 与 `auto` 分支：

```js
function handleNav(key) {
  if (key === "new") return openCreateModal();
  if (key === "skill") return openDrawer("run");
}
```

(d) 项目列表改为可过滤（替换 `loadProjectList`）：

```js
let projectListData = null;

async function loadProjectList() {
  try {
    const data = await getJson("/api/projects/list");
    projectListData = data;
    renderProjectListFiltered();
  } catch (error) {
    projectListData = null;
    refs.projectList.replaceChildren(renderProjectEmpty(error.message));
  }
}

function renderProjectListFiltered() {
  if (!projectListData) return;
  const query = (refs.projectFilter?.value ?? "").trim().toLowerCase();
  const filtered = query
    ? projectListData.projects.filter((project) =>
        [project.title, project.story_seed, project.model_label].some((text) =>
          String(text ?? "").toLowerCase().includes(query)
        )
      )
    : projectListData.projects;
  refs.projectCount.textContent = formatNumber(filtered.length);
  refs.projectList.replaceChildren(
    ...(filtered.length > 0
      ? filtered.map((project) => renderProjectNav(project, projectListData.selectedProjectRoot))
      : [renderProjectEmpty(query ? "没有匹配的小说。" : "还没有小说，点上方「新建小说」开始")])
  );
}
```

(e) 事件绑定区加：

```js
refs.projectFilter?.addEventListener("input", () => renderProjectListFiltered());
```

- [ ] **Step 4: 更新 verify-app-clickability.cjs**

把原来的三行导航点击：

```js
  clicks.push(await clickAndRead(win, ".rail-nav .nav-item:nth-of-type(2)", { label: "nav-search", consoleMessages }));
```
和
```js
  clicks.push(await clickAndRead(win, ".rail-nav .nav-item:nth-of-type(5)", { label: "nav-auto" }));
```
删除；`nav-skill` 的选择器从 `:nth-of-type(3)` 改为 `:nth-of-type(2)`；并新增过滤框可点可聚焦检查（放在 nav-skill 点击之前）：

```js
  clicks.push(await clickAndRead(win, "#project-filter", {
    label: "project-filter-focus",
    expect: () => read(win, "document.activeElement?.id === 'project-filter'")
  }));
```

- [ ] **Step 5: verify-app-shell.mjs 加静态断言**

在 `assert.ok(html.includes("id=\"rail-nav\""));` 之后加：

```js
  assert.ok(html.includes("id=\"project-filter\""));
```

- [ ] **Step 6: 验证**

```powershell
node --check src/app-shell/app.js
npm run verify:app-shell
npm run verify:app-clickability
```

预期：全部通过（clickability 会真实点击过滤框、技能导航、新建小说）。

- [ ] **Step 7: 提交**

```powershell
git add src/app-shell/app.js src/app-shell/index.html src/app-shell/styles.css scripts/verify-app-clickability.cjs scripts/verify-app-shell.mjs
git commit -m "feat(app-shell): codex-style rail with working project filter, drop dead nav items"
```

---

## Task 14: 静默轮询 + 章节卡折叠 + 残留清理

**Files:**
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/thread-renderer.js`
- Modify: `src/app-shell/styles.css`
- Delete: `probe-direct.mjs`、`probe-dom.mjs`（仓库根目录调试残留，未跟踪文件）

- [ ] **Step 1: 轮询静默刷新**

app.js `loadDashboard` 签名与首行改为：

```js
async function loadDashboard(options = {}) {
  const requestId = ++dashboardRequestId;
  if (options.silent !== true) {
    setStatus("loading");
  }
```

`ensureRefreshLoop` 的定时器行改为：

```js
    refreshTimer = window.setInterval(() => void loadDashboard({ silent: true }), 1800);
```

- [ ] **Step 2: 章节卡折叠（同一运行气泡内最多 3 张，更早的归并成一行）**

thread-renderer.js：

(a) 模块顶部常量区加：

```js
const MAX_VISIBLE_CHAPTER_CARDS = 3;
```

(b) `attachChapterCard` 末尾（`block.chapter = chapterNo;` 之后）加一行：

```js
    collapseOldChapterCards(block);
```

(c) `attachChapterCard` 函数后新增：

```js
  function collapseOldChapterCards(block) {
    const cards = [...block.body.querySelectorAll(".filecard")];
    if (cards.length <= MAX_VISIBLE_CHAPTER_CARDS) return;
    let rollup = block.body.querySelector(".filecard-rollup");
    if (!rollup) {
      rollup = document.createElement("button");
      rollup.type = "button";
      rollup.className = "filecard-rollup";
      rollup.dataset.count = "0";
      rollup.addEventListener("click", () => ctx.openDrawer?.("chapters"));
      block.body.insertBefore(rollup, cards[0]);
    }
    let count = Number(rollup.dataset.count ?? 0);
    for (const old of cards.slice(0, cards.length - MAX_VISIBLE_CHAPTER_CARDS)) {
      old.remove();
      count += 1;
    }
    rollup.dataset.count = String(count);
    rollup.textContent = `已收起 ${count} 张章节卡 · 点击在「章节」面板查看全部`;
  }
```

(d) styles.css 加：

```css
.filecard-rollup {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px dashed var(--line);
  background: var(--surface-2);
  color: var(--muted);
  border-radius: var(--r-sm);
  padding: 7px 10px;
  font-size: 12px;
  margin: 2px 0;
  cursor: pointer;
}
.filecard-rollup:hover { background: var(--hover); color: var(--ink-2); }
```

- [ ] **Step 3: 删除 PLACEHOLDER 注释与调试脚本**

(a) app.js 删除以下整行注释（11 处）：`// PLACEHOLDER_AFTER_CONST`、`// PLACEHOLDER_BOOTSTRAP`、`// PLACEHOLDER_LOAD`、`// PLACEHOLDER_RENDER_DASHBOARD`、`// PLACEHOLDER_THREAD`、`// PLACEHOLDER_COMPOSER`、`// PLACEHOLDER_PROJECT`、`// PLACEHOLDER_STATUS`、`// PLACEHOLDER_READER`、`// PLACEHOLDER_PRIVACY`、`// PLACEHOLDER_UTILS`。

(b) thread-renderer.js 删除：`// PLACEHOLDER_TR_EMPTY`、`// PLACEHOLDER_TR_SCROLL`、`// PLACEHOLDER_TR_QUEUE`、`// PLACEHOLDER_TR_AGENT`、`// PLACEHOLDER_TR_CHAPTER`、`// PLACEHOLDER_TR_FAILURE`。

(c) 确认调试脚本未被引用后删除：

```powershell
Select-String -Path src\**\*.js, src\**\*.mjs, scripts\* -Pattern "probe-direct|probe-dom"
Remove-Item probe-direct.mjs, probe-dom.mjs -Confirm:$false
```

预期：Select-String 无输出后再删。

- [ ] **Step 4: 验证**

```powershell
node --check src/app-shell/app.js; node --check src/app-shell/thread-renderer.js
npm test 2>&1 | Select-Object -Last 8
npm run verify:app-shell
npm run verify:app-clickability
```

预期：测试全绿、冒烟通过、点击防线通过。

- [ ] **Step 5: 提交**

```powershell
git add src/app-shell/app.js src/app-shell/thread-renderer.js src/app-shell/styles.css
git commit -m "polish(app-shell): silent polling, chapter card rollup, remove placeholder comments and probe scripts"
```

（probe-*.mjs 是未跟踪文件，删除即可，无需 git add。）

---

## Task 15: 收口验证 + 文档

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量验证**

```powershell
npm test 2>&1 | Select-Object -Last 8
npm run verify:app-shell
npm run verify:app-clickability
npm run verify:desktop-shell
```

预期：测试约 360+ 全绿（329 基线 + 本计划新增约 30 个用例）；三个 verify 全部 `ok: true`。

- [ ] **Step 2: 本地总验收（含打包链路）**

```powershell
npm run verify:local
```

预期：全链路通过。注意 CLAUDE.md 的提醒：若用户要从桌面快捷方式使用新功能，还需重新打包（verify:local 已包含 package:dir 与安装器构建）；运行中的旧 exe 会锁 dll，打包前先关掉。

- [ ] **Step 3: README 增加「故障卡处理」一节**

在「按钮点击回归防线」一节之后插入：

```markdown
## 故障卡处理

写作过程中出现字数不足、预算耗尽、模型服务异常等情况时，对话流里会出现故障卡。卡片上的按钮是真实操作：

- 补写 N 字：把缺口作为补写指令注入下一次生成。
- 接受当前字数继续 / 接受当前稿：跳过本次质量门禁，直接进入定稿。
- 提高预算到 N：同步更新运行预算和 `project.yaml`，并自动续跑。
- 去设置切换模型：打开设置弹窗换模型后再继续。
- 停在这里：干净暂停当前运行，状态显示「已暂停」，发送新指令即可恢复。

每次处理都会写入 `run_log.jsonl`（`failure_resolved` 事件）并把决定记录在 `failures.jsonl`。
```

- [ ] **Step 4: 提交**

```powershell
git add README.md
git commit -m "docs: failure card handling section"
```

- [ ] **Step 5: 汇报**

向用户报告：修复清单（按本计划「审查结论」表逐项对应）、测试与 verify 证据、是否需要重新打包桌面 exe。

---

## Self-Review 记录

- **Spec 覆盖**：用户四项诉求 → ①修 Bug：Task 1-8（审查表 #1-#10 全覆盖，#11 在 Task 9）；②流程优化（hook/agent 运行）：Task 9-11（#12 #13）；③用户使用问题：Task 1-5（故障卡闭环）+ Task 12（完成后死路 #5）；④UX/Codex 风格：Task 13-14（#14-#17）+ Task 8（防窥一致性）。
- **占位符扫描**：所有代码步骤均给出完整可粘贴代码；唯一的「保持原有块不变」出现在 Task 11 Step 4(c) 的 catch 体，原代码在仓库中唯一且明确。
- **类型一致性**：`applyFailureResolution` 返回 `{resumeRun, message}` 与 Task 3 的 `applied.resumeRun/applied.message` 一致；`runProject` paused 返回 `{completed:false, paused:true, projectRoot}` 与 Task 3/5 测试断言一致；扁平 action `{label, command, args, destructive?}` 与组件测试、clickability 种子、Task 4 的兼容读取一致；`setStage` 在 Task 9 定义、Task 2/12 中 failure-actions 与 settings-runtime 各自直接写 `stage_entered_at` 字段（不依赖 agent-engine 内部函数，避免跨模块私有依赖）。
- **执行顺序风险**：Task 3 的第三个测试用例依赖 Task 5 的实现才转绿，两个 Task 的「预期失败/通过」说明里已写明；若按序执行无悬挂红灯跨任务边界（Task 5 Step 6 统一收绿）。
- **防线更新合规**：CLAUDE.md 要求改 UI 后必须跑 verify:app-clickability / verify:app-shell / verify:desktop-shell——Task 13/14/15 已包含；clickability 的选择器更新与真实新 IA 同步，且过滤框是真实可点击控件，不是为绕过测试而改。
