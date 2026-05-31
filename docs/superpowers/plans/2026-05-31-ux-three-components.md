# UX 三组件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 WWriting 桌面端引入三个互相独立的前端组件（故障卡 / 活动条 / Quick Rail），分别解决"出错不知下一步""不知道在干什么""高级功能藏太深"三个痛点。

**Architecture:** 三个组件全部前端纯渲染层，数据源于 `agent_state.json` / `run_log.jsonl` / `chapter_index.json` / `cost.json` / `failures.jsonl`（新增）。后端仅扩展 `/api/dashboard` 返回字段 + 新增 `/api/failures/resolve` 路由；不升级 schema_version；不引入新依赖。三个组件分三个独立 PR 落地（Phase 1/2/3），每个 PR 独立可上线。

**Tech Stack:** vanilla JS（ESM）+ CSS + Node test + 自定义 verify 脚本。**不**引入 React/Vue/Web Components/浏览器无头测试。

**前置依赖:** 假设 `ux-agent-status-truthfulness` 的 P0 已上线（`agent_alive` / `interrupted` / `/api/run/retry`）。

**Spec:** [docs/superpowers/specs/2026-05-31-ux-three-components-design.md](../specs/2026-05-31-ux-three-components-design.md)

## 已知降级（本期不实现，明确移出范围）

- **互斥规则永走 fallback**（spec §2.1.1）：故障卡始终作为 thread 内独立卡渲染，**不嵌入任务卡**。任务卡内嵌路径推迟到 `ux-agent-status-truthfulness` 的 TaskQueue 落地后的跟进 PR。
- **`failure_resolved` 事件的消费侧最小实现**：本 plan 内的 Task 1.10 仅实现 `pause-here` 一种动作的真实响应（agent 退出循环）；其它动作（fill-words / raise-budget / switch-model / 等）只标 resolution + 写 audit 事件，**真正生效**由后续 PR 在 agent-engine retry 路径里消费。
- **活动条 segment 维度数据来源缺失**：现有 `chapter_index.json` 没有 segment 字段，本期活动条只显示"第 N 章"，不显示"seg M/总段数"。后续在 agent-engine segment 推进时写 segment 维度后再补完整呈现。

## 通用测试约定

所有新增 `tests/` 文件遵循已有模式（参考 `tests/app-server-probe.test.mjs`）：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppShellServer } from '../src/core/app-server.mjs';
import { createProject } from '../src/core/project-store.mjs';

async function setupServer(opts = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wwriting-ux-'));
  const { projectRoot } = await createProject(root, {
    slug: 'project', target_chapters: 3,
    min_words_per_chapter: 300, target_words_per_chapter: 360
  });
  const server = createAppShellServer({
    workspaceRoot: root, selectedProjectRoot: projectRoot,
    stateRoot: path.join(root, '.state'),
    secretsRoot: path.join(root, '.secrets'),
    port: 0, ...opts
  });
  await new Promise(r => server.listen(0, r));
  return { root, projectRoot, server, port: server.address().port };
}

function closeServer(s) { return new Promise(r => s.close(r)); }

async function postJson(port, route, body = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { res, data: await res.json() };
}
```

> **关键**：plan 全文若出现 `makeProjectFixture()` / `startServer()` / `buildDashboard()` 等是早期占位，**实际使用上面真实 helper**。

## 源码事实校准（按需查阅）

| Plan 早期文本中的字段 | 真实 API / 字段 |
|---|---|
| `buildDashboard(dir)` | `loadDashboardData(workspaceRoot, { projectRoot, allowExternalProjectRoot: true })` |
| `dashboard.chapter_index[N].segments_planned` | **不存在**——本期不显示 segment |
| `dashboard.cost.byChapter[N]` | **不存在**——用 `dashboard.summary.estimatedCost`（累计） |
| `dashboard.chapters_summary.total` | `dashboard.summary.targetChapters` |
| `dashboard.chapters_summary.completed` | `dashboard.summary.completedChapters` |
| `dashboard.effective_config.budget.max_cost` | `dashboard.project.budget_config.max_cost` |
| `dashboard.project.skills_enabled` | `dashboard.skills.items.filter(s => s.enabled_in_project)` |
| `dashboard.sources_summary` | **不新增**：复用 `dashboard.sources.count` / `dashboard.sources.latest[0]?.captured_at` |
| `dashboard.reviewer_summary` | **不新增**：复用 `dashboard.review?.generated_at` |
| `dashboard.recent_tool_events` | **新增**：在 `loadDashboardData` Promise.all（line 26）追加 |
| `dashboard.failures` | **新增**：同上 |
| `openDrawerTab(tab)` | 包装为：`if (!isDrawerOpen()) toggleDrawer(); setDrawerTab(tab);` |
| `tool_call` / `file_write` 事件类型 | 实际：`tool_call` / `tool_call_requested` / `tool_call_rejected`；**无** `file_write` |

---

## 文件结构

### Phase 1：故障卡（PR #1）

| 文件 | 创建/修改 | 责任 |
|---|---|---|
| `src/shared/failure-commands.mjs` | 创建 | 命令白名单 + 参数 schema 单一来源，前后端 import |
| `src/core/failures-store.mjs` | 创建 | `appendFailure(projectRoot, card)` / `readFailures(projectRoot)` 原子写入 |
| `src/core/derive-failure-card.mjs` | 创建 | 从事件派生 FailureCard（kind 映射 + 字符串清洗） |
| `src/core/agent-engine.mjs` | 修改（5 处事件写入处） | 写事件时同时调用 `appendFailure` |
| `src/core/app-dashboard.mjs` | 修改 | 新增 `failures` 字段（最近 N=10 未处理 + 5 已处理） |
| `src/core/app-server.mjs` | 修改 | `/api/commands/submit` 接受 `command` + `args` + `failureId`，按 schema 校验 |
| `src/app-shell/components/failure-card.js` | 创建 | 故障卡组件渲染 + action click handler |
| `src/app-shell/agent-truth.mjs` | 修改（additive） | 新增 `deriveFailures(dashboard)` named export |
| `src/app-shell/app.js` | 修改 | thread 渲染时合流插入故障卡 |
| `src/app-shell/styles.css` | 修改 | 故障卡样式 |
| `tests/failures-store.test.mjs` | 创建 | 原子写入 + 读取 + 损坏行跳过 |
| `tests/derive-failure-card.test.mjs` | 创建 | 6 种 kind 映射 + 字符串截断 + 控制字符清洗 |
| `tests/failure-commands.test.mjs` | 创建 | 命令白名单 + 参数 schema 校验 |
| `tests/app-shell/agent-truth-failures.test.mjs` | 创建 | `deriveFailures` 派生 |
| `scripts/verify-app-shell.mjs` | 修改 | 白名单字面值漂移守卫 + 故障卡 DOM 挂载断言 |

### Phase 2：活动条（PR #2）

| 文件 | 创建/修改 | 责任 |
|---|---|---|
| `src/core/recent-tool-events.mjs` | 创建 | 读 `run_log.jsonl` 最后 20 条 `tool_call*` / `file_write*`，mtime 短路缓存 |
| `src/core/app-dashboard.mjs` | 修改 | 新增 `recent_tool_events` 字段 |
| `src/app-shell/agent-truth.mjs` | 修改（additive） | 新增 `deriveActivity(dashboard)` |
| `src/app-shell/components/activity-strip.js` | 创建 | 活动条组件渲染 |
| `src/app-shell/app.js` | 修改 | topbar 下方挂载活动条 |
| `src/app-shell/styles.css` | 修改 | 活动条样式 |
| `tests/recent-tool-events.test.mjs` | 创建 | 读取 + 倒序 + mtime 短路 |
| `tests/app-shell/derive-activity.test.mjs` | 创建 | `deriveActivity` 各 stage + 缺数据降级 + 隐私打码 |
| `scripts/verify-app-shell.mjs` | 修改 | 活动条 DOM 挂载断言 |

### Phase 3：Quick Rail（PR #3）

| 文件 | 创建/修改 | 责任 |
|---|---|---|
| `src/core/dashboard-summaries.mjs` | 创建 | `sources_summary` + `reviewer_summary` 派生 + mtime 短路 |
| `src/core/app-dashboard.mjs` | 修改 | 新增 `sources_summary` / `reviewer_summary` 字段 |
| `src/app-shell/agent-truth.mjs` | 修改（additive） | 新增 `deriveBadges(dashboard, projectRoot, lastSeen)` |
| `src/app-shell/components/quick-rail.js` | 创建 | Quick Rail 组件 + 悬停浮窗 + 键盘绑定 |
| `src/app-shell/components/drawer-tabs.js` | 创建 | 4 个新 drawer tab 视图渲染 |
| `src/app-shell/app.js` | 修改 | 挂载 Quick Rail；移除顶栏"章节/面板"按钮；窄屏折叠 |
| `src/app-shell/index.html` | 修改 | 顶栏按钮移除；窄屏菜单容器 |
| `src/app-shell/styles.css` | 修改 | Quick Rail + 浮窗 + 新 tab 样式 |
| `tests/dashboard-summaries.test.mjs` | 创建 | 摘要派生 + mtime 短路 |
| `tests/app-shell/derive-badges.test.mjs` | 创建 | 徽章阈值 + 多项目 localStorage key 分桶 |
| `scripts/verify-app-shell.mjs` | 修改 | Quick Rail DOM + 键盘断言 |

---

# Phase 1：故障卡（PR #1）

### Task 1.1：创建命令白名单常量文件

**Files:**
- Create: `src/shared/failure-commands.mjs`
- Test: `tests/failure-commands.test.mjs`

- [ ] **Step 1: 先写失败测试**

```js
// tests/failure-commands.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE_COMMANDS, validateFailureCommand } from '../src/shared/failure-commands.mjs';

test('FAILURE_COMMANDS 包含所有 11 个命令', () => {
  const expected = [
    'retry-segment', 'retry-with-prompt', 'pause-here',
    'accept-current-words', 'skip-segment', 'fill-words',
    'raise-budget', 'switch-model', 'apply-review-suggestions',
    'accept-review-current', 'manual-review-handoff'
  ].sort();
  assert.deepEqual(Object.keys(FAILURE_COMMANDS).sort(), expected);
});

test('validateFailureCommand 拒绝未知命令', () => {
  const res = validateFailureCommand('unknown-cmd', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /未知命令/);
});

test('validateFailureCommand 拒绝缺失必填参数', () => {
  const res = validateFailureCommand('fill-words', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /targetWords/);
});

test('validateFailureCommand 校验数值上界', () => {
  const res = validateFailureCommand('fill-words', { targetWords: 999999 });
  assert.equal(res.ok, false);
  assert.match(res.error, /50000/);
});

test('validateFailureCommand 通过合法调用', () => {
  const res = validateFailureCommand('fill-words', { targetWords: 500 });
  assert.equal(res.ok, true);
});

test('validateFailureCommand 拒绝过长 prompt', () => {
  const res = validateFailureCommand('retry-with-prompt', { prompt: 'x'.repeat(2001) });
  assert.equal(res.ok, false);
  assert.match(res.error, /2000/);
});
```

- [ ] **Step 2: 运行验证失败**

```powershell
node --test tests/failure-commands.test.mjs
```

预期：失败 `Cannot find module './src/shared/failure-commands.mjs'`

- [ ] **Step 3: 创建实现**

```js
// src/shared/failure-commands.mjs
export const FAILURE_COMMANDS = Object.freeze({
  'retry-segment':           { args: {} },
  'retry-with-prompt':       { args: { prompt: { type: 'string', maxLength: 2000, required: true } } },
  'pause-here':              { args: {} },
  'accept-current-words':    { args: {} },
  'skip-segment':            { args: {} },
  'fill-words':              { args: { targetWords: { type: 'integer', min: 1, max: 50000, required: true } } },
  'raise-budget':            { args: { newMaxModelCalls: { type: 'integer', min: 1, max: 10000, required: true } } },
  'switch-model':            { args: { modelId: { type: 'string', source: 'allowed-models-only', required: true } } },
  'apply-review-suggestions':{ args: {} },
  'accept-review-current':   { args: {} },
  'manual-review-handoff':   { args: {} }
});

export function validateFailureCommand(command, args = {}) {
  const def = FAILURE_COMMANDS[command];
  if (!def) return { ok: false, error: `未知命令: ${command}` };
  for (const [key, schema] of Object.entries(def.args)) {
    const v = args[key];
    if (v === undefined || v === null) {
      if (schema.required) return { ok: false, error: `缺少必填参数: ${key}` };
      continue;
    }
    if (schema.type === 'string') {
      if (typeof v !== 'string') return { ok: false, error: `${key} 必须是字符串` };
      if (schema.maxLength && v.length > schema.maxLength) {
        return { ok: false, error: `${key} 超长 (>${schema.maxLength})` };
      }
    }
    if (schema.type === 'integer') {
      if (!Number.isInteger(v)) return { ok: false, error: `${key} 必须是整数` };
      if (schema.min !== undefined && v < schema.min) return { ok: false, error: `${key} 不能小于 ${schema.min}` };
      if (schema.max !== undefined && v > schema.max) return { ok: false, error: `${key} 不能大于 ${schema.max}` };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: 运行测试验证通过**

```powershell
node --test tests/failure-commands.test.mjs
```

预期：6 tests pass

- [ ] **Step 5: 提交**

```powershell
git add src/shared/failure-commands.mjs tests/failure-commands.test.mjs
git commit -m "feat(failure-card): 添加命令白名单和参数 schema 共享常量"
```

---

### Task 1.2：故障卡派生函数

**Files:**
- Create: `src/core/derive-failure-card.mjs`
- Test: `tests/derive-failure-card.test.mjs`

- [ ] **Step 1: 先写失败测试**

```js
// tests/derive-failure-card.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveFailureCard } from '../src/core/derive-failure-card.mjs';

const baseState = { current_chapter_no: 7, current_stage: 'reviewing' };

test('words-short kind 由 word-count gate failed 派生', () => {
  const card = deriveFailureCard({
    id: 'e1', type: 'quality_gate_failed', ts: '2026-05-31T00:00:00Z',
    chapter_no: 7, message: 'word-count gate failed',
    data: { kind: 'word_count', actual_words: 2487, expected_words: 3000 }
  }, baseState);
  assert.equal(card.kind, 'words-short');
  assert.equal(card.chapterNo, 7);
  assert.match(card.title, /字数不足/);
  assert.equal(card.actions.length, 3);
  assert.equal(card.actions[0].command.command, 'fill-words');
  assert.equal(card.actions[0].command.args.targetWords, 513);
});

test('tool-rejected kind 由 tool_call_rejected 派生', () => {
  const card = deriveFailureCard({
    id: 'e2', type: 'tool_call_rejected', ts: '2026-05-31T00:00:01Z',
    chapter_no: 7, message: 'invalid arguments',
    data: { tool: 'write_segment', code: 'invalid_args' }
  }, baseState);
  assert.equal(card.kind, 'tool-rejected');
  assert.equal(card.diagnostics.tool, 'write_segment');
});

test('budget-exhausted kind 由 model_call_budget_exhausted 派生', () => {
  const card = deriveFailureCard({
    id: 'e3', type: 'project_blocked', ts: '2026-05-31T00:00:02Z',
    chapter_no: 7, message: 'model_call_budget_exhausted',
    data: { used: 200, max: 200 }
  }, baseState);
  assert.equal(card.kind, 'budget-exhausted');
  assert.equal(card.actions[0].command.command, 'raise-budget');
});

test('unknown 兜底 - 没匹配上的 project_blocked', () => {
  const card = deriveFailureCard({
    id: 'e4', type: 'project_blocked', ts: '2026-05-31T00:00:03Z',
    chapter_no: 7, message: 'something_weird', data: {}
  }, baseState);
  assert.equal(card.kind, 'provider-error');
});

test('body 截断到 500 字符', () => {
  const long = 'x'.repeat(2000);
  const card = deriveFailureCard({
    id: 'e5', type: 'project_blocked', ts: '2026-05-31T00:00:04Z',
    chapter_no: 7, message: long, data: {}
  }, baseState);
  assert.ok(card.body.length <= 500);
  assert.ok((card.diagnostics.rawError ?? '').length <= 500);
});

test('控制字符被清洗', () => {
  const card = deriveFailureCard({
    id: 'e6', type: 'project_blocked', ts: '2026-05-31T00:00:05Z',
    chapter_no: 7, message: 'a\u0000b\u001fc\u007fd', data: {}
  }, baseState);
  assert.equal(/[\u0000-\u001f\u007f]/.test(card.body), false);
});

test('id 与 event.id 一致 - 幂等去重键', () => {
  const card = deriveFailureCard({
    id: 'evt_123', type: 'quality_gate_failed', ts: '2026-05-31T00:00:06Z',
    chapter_no: 7, message: 'word-count gate failed',
    data: { kind: 'word_count', actual_words: 2900, expected_words: 3000 }
  }, baseState);
  assert.equal(card.id, 'evt_123');
});
```

- [ ] **Step 2: 运行验证失败**

```powershell
node --test tests/derive-failure-card.test.mjs
```

预期：失败 `Cannot find module`

- [ ] **Step 3: 写实现**

```js
// src/core/derive-failure-card.mjs
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function clean(str, max) {
  if (typeof str !== 'string') return null;
  return str.replace(CONTROL_CHARS, ' ').slice(0, max);
}

function classifyKind(event) {
  const { type, message = '', data = {} } = event;
  if (type === 'quality_gate_failed' && message === 'word-count gate failed') return 'words-short';
  if (type === 'quality_gate_failed' && message === 'skill quality gate failed') return 'review-failed';
  if (type === 'tool_call_rejected') return 'tool-rejected';
  if (type === 'project_blocked') {
    if (message === 'model_output_invalid' || message === 'unsupported_tool') return 'tool-rejected';
    if (message === 'model_call_budget_exhausted' || message === 'revision_budget_exhausted') return 'budget-exhausted';
    return 'provider-error';
  }
  return 'unknown';
}

function actionsForKind(kind, event) {
  const data = event.data ?? {};
  switch (kind) {
    case 'words-short': {
      // 缺 expected_words 时不假装算 gap；提供无数字的"补写"动作让用户/agent 决定
      const expected = data.expected_words ?? null;
      const actual = data.actual_words ?? 0;
      const gap = expected ? Math.max(1, expected - actual) : null;
      return [
        gap
          ? { label: `补写 ${gap} 字`, command: { command: 'fill-words', args: { targetWords: gap } } }
          : { label: '继续补写', command: { command: 'fill-words', args: { targetWords: 500 } } },
        { label: '接受当前字数继续', command: { command: 'accept-current-words', args: {} } },
        { label: '跳过本段', command: { command: 'skip-segment', args: {} }, destructive: true }
      ];
    }
    case 'tool-rejected':
      return [
        { label: '让它重试', command: { command: 'retry-segment', args: {} } },
        { label: '改提示词后重试', command: { command: 'retry-with-prompt', args: { prompt: '' } } },
        { label: '停在这里我手动处理', command: { command: 'pause-here', args: {} } }
      ];
    case 'budget-exhausted': {
      const current = data.max ?? 200;
      return [
        { label: `提高预算到 ${current * 2}`, command: { command: 'raise-budget', args: { newMaxModelCalls: current * 2 } } },
        { label: '停在这里', command: { command: 'pause-here', args: {} } }
      ];
    }
    case 'provider-error':
      return [
        { label: '重试当前段', command: { command: 'retry-segment', args: {} } },
        { label: '切换备用模型', command: { command: 'switch-model', args: { modelId: '' } } },
        { label: '停在这里', command: { command: 'pause-here', args: {} } }
      ];
    case 'review-failed':
      return [
        { label: '让它按建议改写', command: { command: 'apply-review-suggestions', args: {} } },
        { label: '接受当前稿', command: { command: 'accept-review-current', args: {} } },
        { label: '我来人工改', command: { command: 'manual-review-handoff', args: {} } }
      ];
    default:
      return [
        { label: '重试', command: { command: 'retry-segment', args: {} } },
        { label: '停在这里', command: { command: 'pause-here', args: {} } }
      ];
  }
}

function titleForKind(kind) {
  return {
    'words-short': '字数不足',
    'tool-rejected': '工具调用被拒',
    'budget-exhausted': '预算已用尽',
    'provider-error': '模型服务出错',
    'review-failed': '审稿未通过',
    'unknown': '出现异常'
  }[kind];
}

function bodyForKind(kind, event, state) {
  const ch = event.chapter_no ?? state.current_chapter_no ?? '?';
  const data = event.data ?? {};
  switch (kind) {
    case 'words-short':
      return `第 ${ch} 章本段写了 ${data.actual_words ?? '?'} 字，低于 ${data.expected_words ?? '?'} 字门槛。智能体没有继续，等你决定怎么处理。`;
    case 'tool-rejected':
      return `第 ${ch} 章的工具调用 ${data.tool ?? ''} 被拒。智能体停在 ${state.current_stage} 阶段。`;
    case 'budget-exhausted':
      return `第 ${ch} 章已经用完模型调用预算 (${data.used ?? '?'} / ${data.max ?? '?'})，等你决定。`;
    case 'provider-error':
      return `第 ${ch} 章遇到模型服务异常: ${event.message ?? '未知'}。`;
    case 'review-failed':
      return `第 ${ch} 章审稿没通过。`;
    default:
      return `第 ${ch} 章遇到异常: ${event.message ?? '未知'}。`;
  }
}

export function deriveFailureCard(event, state = {}) {
  const kind = classifyKind(event);
  return {
    id: event.id,
    seq: event.seq ?? 0,
    chapterNo: event.chapter_no ?? state.current_chapter_no ?? null,
    kind,
    title: clean(titleForKind(kind), 80),
    body: clean(bodyForKind(kind, event, state), 500),
    ts: event.ts,
    actions: actionsForKind(kind, event),
    diagnostics: {
      eventId: event.id,
      tool: event.data?.tool ?? null,
      promptHash: event.data?.prompt_hash ?? null,
      logPath: 'run_log.jsonl',
      rawError: clean(event.message ?? null, 500)
    },
    resolution: null
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

```powershell
node --test tests/derive-failure-card.test.mjs
```

预期：7 tests pass

- [ ] **Step 5: 提交**

```powershell
git add src/core/derive-failure-card.mjs tests/derive-failure-card.test.mjs
git commit -m "feat(failure-card): 派生 FailureCard 与 kind 字符串映射"
```

---

### Task 1.3：故障卡存储

**Files:**
- Create: `src/core/failures-store.mjs`
- Test: `tests/failures-store.test.mjs`

- [ ] **Step 1: 先写失败测试**

```js
// tests/failures-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendFailure, readFailures, markResolved } from '../src/core/failures-store.mjs';

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwriting-failures-'));
  return dir;
}

test('appendFailure 追加并 readFailures 读出', () => {
  const dir = makeProject();
  appendFailure(dir, { id: 'e1', kind: 'words-short', title: '字数不足' });
  appendFailure(dir, { id: 'e2', kind: 'tool-rejected', title: '工具被拒' });
  const all = readFailures(dir);
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'e1');
  assert.equal(all[1].id, 'e2');
});

test('readFailures 跳过损坏行', () => {
  const dir = makeProject();
  appendFailure(dir, { id: 'good1', kind: 'unknown' });
  fs.appendFileSync(path.join(dir, 'failures.jsonl'), '\n{this is not json\n');
  appendFailure(dir, { id: 'good2', kind: 'unknown' });
  const all = readFailures(dir);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(f => f.id), ['good1', 'good2']);
});

test('readFailures - 文件不存在返回空数组', () => {
  const dir = makeProject();
  assert.deepEqual(readFailures(dir), []);
});

test('markResolved 更新对应条目', () => {
  const dir = makeProject();
  appendFailure(dir, { id: 'e1', kind: 'words-short', resolution: null });
  markResolved(dir, 'e1', { action: 'fill-words', submittedAt: '2026-05-31T00:00:00Z' });
  const all = readFailures(dir);
  assert.equal(all[0].resolution.action, 'fill-words');
});
```

- [ ] **Step 2: 运行验证失败**

```powershell
node --test tests/failures-store.test.mjs
```

预期：失败 `Cannot find module`

- [ ] **Step 3: 写实现**

```js
// src/core/failures-store.mjs
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'failures.jsonl';

// 原子追加：read → push → write tmp → rename（与 spec §4.4 一致；Windows 上 appendFileSync 在并发下会撕字节）
export function appendFailure(projectRoot, card) {
  const p = path.join(projectRoot, FILE);
  const all = readFailures(projectRoot);
  all.push(card);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, all.map(c => JSON.stringify(c)).join('\n') + '\n');
  fs.renameSync(tmp, p);
}

export function readFailures(projectRoot) {
  const p = path.join(projectRoot, FILE);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 跳过损坏行 */ }
  }
  return out;
}

export function markResolved(projectRoot, id, resolution) {
  const p = path.join(projectRoot, FILE);
  const all = readFailures(projectRoot);
  for (const card of all) {
    if (card.id === id) card.resolution = resolution;
  }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, all.map(c => JSON.stringify(c)).join('\n') + (all.length ? '\n' : ''));
  fs.renameSync(tmp, p);
}

export const FAILURES_FILE = FILE;
```

- [ ] **Step 4: 运行测试验证通过**

```powershell
node --test tests/failures-store.test.mjs
```

预期：4 tests pass

- [ ] **Step 5: 提交**

```powershell
git add src/core/failures-store.mjs tests/failures-store.test.mjs
git commit -m "feat(failure-card): failures.jsonl 追加/读取/标记原子写入"
```

---

### Task 1.4：在 agent-engine 写事件时同时写故障卡

**Files:**
- Modify: `src/core/agent-engine.mjs`（在 `appendEvent` 调用旁加 `appendFailure`，5 处）

- [ ] **Step 1: 阅读现有事件写入位置**

```powershell
node -e "const fs=require('fs');const t=fs.readFileSync('src/core/agent-engine.mjs','utf8');let i=0;t.split('\n').forEach((l,n)=>{if(l.includes('type: \"tool_call_rejected\"')||l.includes('type: \"quality_gate_failed\"')||l.includes('type: \"project_blocked\"'))console.log((n+1)+': '+l.trim())})"
```

预期：列出 5 个事件写入点的行号（约 302, 330, 807, 838, 949）

- [ ] **Step 2: 修改 agent-engine.mjs 顶部 import**

在 import 块末尾追加：

```js
import { appendFailure } from './failures-store.mjs';
import { deriveFailureCard } from './derive-failure-card.mjs';
```

- [ ] **Step 3: 在 5 处事件写入后追加故障卡写入**

具体 5 处位置（按行号近似）+ 完整 patch：

> **重要顺序约束**：所有 `appendFailure` 调用必须放在 `await writeCheckpoint(...)` **之后**，不是 `appendEvent` 之后。否则若进程在 `appendFailure` 与 `writeCheckpoint` 之间崩溃，重启后 failures.jsonl 有故障卡但 checkpoint 没记，状态会不一致。
>
> **`state` 变量校准**：以下每个注入点之前，先 `const fresh = await loadState(projectRoot).catch(() => state);` 取最新状态用作 `deriveFailureCard` 的第二参数（避免 `executeToolCall` / `consumeBudget` 引入的脏 state）。

**位置 1：第 301 行附近 `quality_gate_failed` (word-count)**

`await writeCheckpoint(...)` 之后插入：

```js
try {
  const card = deriveFailureCard({
    id: `flr_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    type: 'quality_gate_failed',
    chapter_no: state.current_chapter_no,
    message: 'word-count gate failed',
    ts: new Date().toISOString(),
    data: gate
  }, state);
  appendFailure(projectRoot, card);
} catch (err) { console.warn('appendFailure failed:', err.message); }
```

**位置 2：第 329 行附近 `quality_gate_failed` (skill)**

类似插入，`data: { failed_gates: failedSkillGates }`，`message: 'skill quality gate failed'`。

**位置 3：第 806 行附近 `tool_call_rejected` (tool validation)**

```js
try {
  const card = deriveFailureCard({
    id: `flr_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    type: 'tool_call_rejected',
    chapter_no: state.current_chapter_no,
    message: validation.message ?? 'invalid arguments',
    ts: new Date().toISOString(),
    data: { tool: output?.name ?? null, code: validation.code }
  }, state);
  appendFailure(projectRoot, card);
} catch (err) { console.warn('appendFailure failed:', err.message); }
```

**位置 4：第 837 行附近 `tool_call_rejected` (ToolValidationError)** —— 类似位置 3，`data: { tool: error.tool, code: error.code }`。

**位置 5：第 948 行附近 `blockProject` 内 `project_blocked`**

`await writeCheckpoint(...)`（行 957–960）之后追加（`current` 已经是 fresh 状态，不需再 reload）：

```js
try {
  const card = deriveFailureCard({
    id: `flr_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    type: 'project_blocked',
    chapter_no: current.current_chapter_no,
    message: reason,
    ts: new Date().toISOString(),
    data
  }, current);
  appendFailure(projectRoot, card);
} catch (err) { console.warn('appendFailure failed:', err.message); }
```

- [ ] **Step 4: 运行 agent-engine 测试**

```powershell
node --test tests/agent-engine.test.mjs
```

预期：原有测试全部通过（无回归）

- [ ] **Step 5: 提交**

```powershell
git add src/core/agent-engine.mjs
git commit -m "feat(failure-card): agent-engine 写事件时同步写 failures.jsonl"
```

---

### Task 1.5：在 loadDashboardData 返回 failures 字段

**Files:**
- Modify: `src/core/app-dashboard.mjs`
- Test: `tests/app-dashboard.test.mjs`（扩展）

- [ ] **Step 1: 先写失败测试**（用真实 `loadDashboardData` 签名，不发明 `buildDashboard`）

```js
// tests/app-dashboard.test.mjs 文件末尾追加：
import { appendFailure } from '../src/core/failures-store.mjs';
import { loadDashboardData } from '../src/core/app-dashboard.mjs';
import { createProject } from '../src/core/project-store.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('loadDashboardData 包含 failures 字段（最近 10 未处理 + 5 已处理）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wwriting-dash-fail-'));
  const { projectRoot } = await createProject(root, {
    slug: 'p', target_chapters: 3, min_words_per_chapter: 300, target_words_per_chapter: 360
  });
  for (let i = 0; i < 20; i++) {
    appendFailure(projectRoot, { id: `e${i}`, kind: 'unknown', resolution: null,
      ts: `2026-05-31T00:00:${String(i).padStart(2,'0')}Z` });
  }
  for (let i = 0; i < 8; i++) {
    appendFailure(projectRoot, { id: `r${i}`, kind: 'unknown',
      resolution: { action: 'pause-here', submittedAt: '...' }, ts: '2026-05-30T00:00:00Z' });
  }
  const snap = await loadDashboardData(root, { projectRoot, allowExternalProjectRoot: true });
  assert.ok(Array.isArray(snap.failures));
  const pending = snap.failures.filter(f => !f.resolution);
  const done = snap.failures.filter(f => f.resolution);
  assert.equal(pending.length, 10);
  assert.equal(done.length, 5);
});

test('loadDashboardData 在 hasProject=false 时不读 failures.jsonl', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wwriting-no-project-'));
  const snap = await loadDashboardData(root, { disableProjectFallback: true });
  assert.equal(snap.hasProject, false);
  assert.equal(snap.failures, undefined);
});
```

- [ ] **Step 2: 运行验证失败**

```powershell
node --test tests/app-dashboard.test.mjs
```

预期：失败 `snap.failures is not iterable`

- [ ] **Step 3: 修改 `loadDashboardData`**

在 `app-dashboard.mjs` 顶部加 import：

```js
import { readFailures } from './failures-store.mjs';
```

在 `loadDashboardData` 函数内 `if (!projectRoot)` 之后的 `Promise.all`（行 26）里追加读取（仅在 `hasProject` 路径执行）：

```js
const failures = readFailures(projectRoot);  // 同步函数，可不入 Promise.all
```

在 return 对象里追加：

```js
failures: [
  ...failures.filter(f => !f.resolution).slice(-10),
  ...failures.filter(f => f.resolution).slice(-5)
],
```

`hasProject=false` 早期 return 路径**不**包含 `failures` 字段（保留 undefined，前端 derive 已处理）。

- [ ] **Step 4: 运行测试通过 + 提交**

```powershell
node --test tests/app-dashboard.test.mjs
git add src/core/app-dashboard.mjs tests/app-dashboard.test.mjs
git commit -m "feat(failure-card): loadDashboardData 返回 failures (10 未处理 + 5 已处理)"
```

---

### Task 1.6：新增 /api/failures/resolve 独立路由（不复用 /api/commands/submit）

> **为什么独立**：`serveCommandSubmit`（`app-server.mjs:574`）是 NLP 指令入口，要求 `body.message` 字符串，且在 `project_status === 'blocked'` 时（行 621–657）直接 short-circuit。**故障卡场景几乎都在 blocked 态**，若复用该路由命令永远到不了新分支。新路由清晰隔离职责，且可以专门绕过 blocked 短路。

**Files:**
- Modify: `src/core/app-server.mjs`（加路由注册 + 新 handler）
- Test: 扩展 `tests/app-server-probe.test.mjs`

- [ ] **Step 1: 在 app-server.mjs 顶部 import**

```js
import { validateFailureCommand } from '../shared/failure-commands.mjs';
import { readFailures, markResolved } from './failures-store.mjs';
```

- [ ] **Step 2: 在路由表（router/handleRequest）里注册新路径**

找到 `serveCommandSubmit` 路由注册位置（grep `commands/submit`），在旁边追加：

```js
if (request.method === 'POST' && url.pathname === '/api/failures/resolve') {
  return serveFailuresResolve(request, response, context);
}
```

- [ ] **Step 3: 新增 handler**

```js
async function serveFailuresResolve(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const { command, args = {}, failureId } = body;
    if (!failureId) {
      await serveJson(response, { ok: false, error: '缺少 failureId' }, 400);
      return;
    }
    const projectRoot = await resolveActiveProjectRoot(context);
    const valid = validateFailureCommand(command, args);
    if (!valid.ok) {
      await appendEvent(projectRoot, { type: 'failure_command_rejected', severity: 'warn',
        message: valid.error, data: { command, failureId } });
      await serveJson(response, { ok: false, error: valid.error }, 400);
      return;
    }
    if (command === 'switch-model') {
      const allowed = await listAllowedModels(projectRoot);  // 已有函数；如不存在则从 config.effective 读取允许列表
      if (!allowed.includes(args.modelId)) {
        await serveJson(response, { ok: false, error: 'modelId 不在允许列表' }, 400);
        return;
      }
    }
    const failures = readFailures(projectRoot);
    const match = failures.find(f => f.id === failureId);
    if (!match) {
      await serveJson(response, { ok: false, error: '故障卡不存在' }, 404);
      return;
    }
    if (match.resolution) {
      await serveJson(response, { ok: false, error: '故障卡已处理' }, 409);
      return;
    }
    markResolved(projectRoot, failureId, {
      action: command,
      submittedAt: new Date().toISOString(),
      args
    });
    await appendEvent(projectRoot, {
      type: 'failure_resolved',
      project_id: (await loadProject(projectRoot)).project_id,
      severity: 'info',
      message: command,
      data: { failureId, args }
    });
    await serveJson(response, { ok: true });
  } catch (err) {
    await serveJson(response, { ok: false, error: err.message }, 500);
  }
}

async function listAllowedModels(projectRoot) {
  // 临时实现：从 config.effective 读 allowed_models 列表；若未配置则默认仅允许当前 active_model
  const project = await loadProject(projectRoot);
  const { loadConfigLayers } = await import('./config-runtime.mjs');
  const config = await loadConfigLayers(projectRoot, project);
  const list = config.effective?.allowed_models;
  if (Array.isArray(list) && list.length > 0) return list;
  return config.effective?.active_model ? [config.effective.active_model] : [];
}
```

- [ ] **Step 4: 测试**

```js
// tests/app-server-probe.test.mjs 末尾追加：
test('POST /api/failures/resolve 拒绝未知命令', async () => {
  const ctx = await setupServer();
  try {
    const { res, data } = await postJson(ctx.port, '/api/failures/resolve',
      { command: 'evil-cmd', args: {}, failureId: 'x' });
    assert.equal(res.status, 400);
    assert.match(data.error, /未知命令/);
  } finally { await closeServer(ctx.server); }
});

test('POST /api/failures/resolve failureId 必须存在且未处理', async () => {
  const ctx = await setupServer();
  appendFailure(ctx.projectRoot, { id: 'f1', kind: 'unknown', resolution: null });
  try {
    const r1 = await postJson(ctx.port, '/api/failures/resolve',
      { command: 'pause-here', args: {}, failureId: 'f1' });
    assert.equal(r1.res.status, 200);
    const r2 = await postJson(ctx.port, '/api/failures/resolve',
      { command: 'pause-here', args: {}, failureId: 'f1' });
    assert.equal(r2.res.status, 409);
    const r3 = await postJson(ctx.port, '/api/failures/resolve',
      { command: 'pause-here', args: {}, failureId: 'nonexistent' });
    assert.equal(r3.res.status, 404);
  } finally { await closeServer(ctx.server); }
});

test('POST /api/failures/resolve blocked 项目也能处理（不被 short-circuit）', async () => {
  const ctx = await setupServer();
  await saveState(ctx.projectRoot, {
    project_status: 'blocked', blocked_reason: 'model_call_budget_exhausted',
    current_chapter_no: 1, current_stage: 'blocked'
  });
  appendFailure(ctx.projectRoot, { id: 'fb', kind: 'budget-exhausted', resolution: null });
  try {
    const { res, data } = await postJson(ctx.port, '/api/failures/resolve',
      { command: 'pause-here', args: {}, failureId: 'fb' });
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
  } finally { await closeServer(ctx.server); }
});
```

需要在测试文件顶部追加 `import { appendFailure } from '../src/core/failures-store.mjs';`

- [ ] **Step 5: 运行 + 提交**

```powershell
node --test tests/app-server-probe.test.mjs
git add src/core/app-server.mjs tests/app-server-probe.test.mjs
git commit -m "feat(failure-card): /api/failures/resolve 独立路由 + 防重放 + 绕过 blocked 短路"
```

---

### Task 1.7：前端 deriveFailures additive 派生

**Files:**
- Modify: `src/app-shell/agent-truth.mjs`
- Create: `tests/app-shell/agent-truth-failures.test.mjs`

- [ ] **Step 1: 先写失败测试**

```js
// tests/app-shell/agent-truth-failures.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveFailures } from '../../src/app-shell/agent-truth.mjs';

test('deriveFailures 返回带 chapter 内序号的卡片列表', () => {
  const dashboard = {
    failures: [
      { id: 'a', chapterNo: 7, kind: 'words-short', ts: '2026-05-31T00:00:00Z' },
      { id: 'b', chapterNo: 7, kind: 'tool-rejected', ts: '2026-05-31T00:00:01Z' },
      { id: 'c', chapterNo: 8, kind: 'words-short', ts: '2026-05-31T00:00:02Z' }
    ]
  };
  const out = deriveFailures(dashboard);
  assert.equal(out.length, 3);
  assert.equal(out[0].seq, 1);
  assert.equal(out[1].seq, 2);
  assert.equal(out[2].seq, 1);  // 新章节重新从 1 开始
});

test('deriveFailures 处理空 / 缺失 failures', () => {
  assert.deepEqual(deriveFailures({}), []);
  assert.deepEqual(deriveFailures({ failures: null }), []);
});
```

- [ ] **Step 2: 运行验证失败**

```powershell
node --test tests/app-shell/agent-truth-failures.test.mjs
```

预期：失败 `deriveFailures is not exported`

- [ ] **Step 3: 在 agent-truth.mjs 末尾追加 named export**

```js
export function deriveFailures(dashboard) {
  const raw = Array.isArray(dashboard?.failures) ? dashboard.failures : [];
  const seqByChapter = new Map();
  return raw.map(f => {
    const ch = f.chapterNo ?? 0;
    const n = (seqByChapter.get(ch) ?? 0) + 1;
    seqByChapter.set(ch, n);
    return { ...f, seq: n };
  });
}
```

> **关键**：不动 `computeAgentTruth`。

- [ ] **Step 4: 运行所有 agent-truth 测试**

```powershell
node --test tests/agent-truth.test.mjs tests/app-shell/agent-truth-failures.test.mjs
```

预期：原有测试无回归 + 新测试通过

- [ ] **Step 5: 提交**

```powershell
git add src/app-shell/agent-truth.mjs tests/app-shell/agent-truth-failures.test.mjs
git commit -m "feat(failure-card): agent-truth.mjs 新增 deriveFailures (additive)"
```

---

### Task 1.8：故障卡组件 + 样式 + thread 挂载

**Files:**
- Create: `src/app-shell/components/failure-card.js`
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`

- [ ] **Step 1: 创建组件**

```js
// src/app-shell/components/failure-card.js
import { FAILURE_COMMANDS } from '../../shared/failure-commands.mjs';

export { FAILURE_COMMANDS };  // 重导出供 verify-app-shell 漂移守卫读取

export function renderFailureCard(card, { onAction }) {
  const el = document.createElement('article');
  el.className = `failure-card kind-${card.kind}`;
  el.dataset.failureId = card.id;

  const head = document.createElement('header');
  head.className = 'failure-head';
  head.textContent = `故障 #${card.seq} · ${card.title} · ${formatTime(card.ts)}`;
  el.appendChild(head);

  const body = document.createElement('p');
  body.className = 'failure-body';
  body.textContent = card.body;
  el.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'failure-actions';
  for (const action of card.actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    if (action.destructive) btn.classList.add('destructive');
    btn.disabled = !!card.resolution;
    btn.addEventListener('click', () => onAction(card, action));
    actions.appendChild(btn);
  }
  el.appendChild(actions);

  if (card.resolution) {
    const done = document.createElement('p');
    done.className = 'failure-resolved';
    done.textContent = `已选: ${card.resolution.action} · ${formatTime(card.resolution.submittedAt)}`;
    el.appendChild(done);
  }

  const details = document.createElement('details');
  details.className = 'failure-diagnostics';
  const summary = document.createElement('summary');
  summary.textContent = '看技术细节';
  details.appendChild(summary);
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(card.diagnostics, null, 2);
  details.appendChild(pre);
  el.appendChild(details);

  return el;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
```

- [ ] **Step 2: 在 app.js 里 import 并挂载**

在 thread 渲染函数（找 `renderThread()` 或类似）旁，引入：

```js
import { renderFailureCard } from './components/failure-card.js';
import { deriveFailures } from './agent-truth.mjs';
```

在 thread 渲染流程中，每次 dashboard 更新后：

```js
const failures = deriveFailures(dashboard);
for (const card of failures) {
  const existing = document.querySelector(`[data-failure-id="${card.id}"]`);
  if (existing) {
    // 已渲染：若 resolution 字段刚出现，原地刷新（变灰 + 显示已选）
    if (!existing.dataset.resolved && card.resolution) {
      existing.replaceWith(renderFailureCard(card, { onAction: submitFailureAction }));
    }
    continue;
  }
  // 首次渲染：按 ts 插入到 thread 中合适位置（与已有事件合流）
  const node = renderFailureCard(card, { onAction: submitFailureAction });
  if (card.resolution) node.dataset.resolved = '1';
  insertByTs(threadEl, node, card.ts);
}
```

> **关于 spec §2.1.1 互斥规则**：互斥规则要求"故障卡嵌入到对应任务卡内部"。但任务卡是 `ux-agent-status-truthfulness` spec 的 Phase 2（TaskQueue）才落地，本 plan 不依赖任务卡。**当前实现策略**：始终走 spec §2.1.1 的 fallback 路径——"独立卡 + 顶部加'无关联任务'标签"。等 TaskQueue 上线后，再加一个跟进 PR 把故障卡转为任务卡内嵌渲染（不在本 plan 范围）。

`insertByTs` 简单实现：

```js
function insertByTs(container, node, ts) {
  const target = ts ? new Date(ts).getTime() : Date.now();
  const children = Array.from(container.children);
  for (const child of children) {
    const childTs = child.dataset.ts ? new Date(child.dataset.ts).getTime() : 0;
    if (childTs > target) {
      container.insertBefore(node, child);
      return;
    }
  }
  container.appendChild(node);
}
```

并在 `renderFailureCard` 顶部加 `el.dataset.ts = card.ts;`

async function submitFailureAction(card, action) {
  const res = await fetch('/api/failures/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      command: action.command.command,
      args: action.command.args,
      failureId: card.id
    })
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    toast(`提交失败: ${json.error ?? res.status}`);
    return;
  }
  // 下次轮询会拉到 resolution；不主动重画
  pullDashboardNow();
}
```

- [ ] **Step 3: 加样式**

在 `styles.css` 末尾追加：

```css
.failure-card {
  margin: 12px 0;
  border: 1px solid var(--amber-soft);
  border-left: 3px solid var(--amber);
  background: var(--amber-soft);
  border-radius: var(--r);
  padding: 14px 16px;
}
.failure-card.kind-budget-exhausted,
.failure-card.kind-provider-error {
  border-left-color: var(--red);
  background: var(--red-soft);
  border-color: var(--red-soft);
}
.failure-head {
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--ink);
}
.failure-body {
  color: var(--ink-2);
  margin-bottom: 10px;
  white-space: pre-wrap;
}
.failure-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.failure-actions button {
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 6px 12px;
  border-radius: var(--r-sm);
  font-size: 13px;
}
.failure-actions button:hover:not(:disabled) {
  background: var(--hover);
}
.failure-actions button.destructive {
  border-color: var(--red);
  color: var(--red);
}
.failure-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.failure-resolved {
  color: var(--muted);
  font-size: 12px;
  margin: 6px 0;
}
.failure-diagnostics {
  margin-top: 8px;
}
.failure-diagnostics summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 12px;
}
.failure-diagnostics pre {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-2);
  background: var(--surface-3);
  padding: 8px;
  border-radius: var(--r-sm);
  overflow-x: auto;
}
```

- [ ] **Step 4: 手动 smoke 测试**

```powershell
npm run app:shell
```

打开浏览器，加载一个含 `failures.jsonl` 的 fixture 项目，确认故障卡显示在 thread 内、点击 action 按钮触发 fetch、收到响应后下次轮询变灰。

- [ ] **Step 5: 提交**

```powershell
git add src/app-shell/components/failure-card.js src/app-shell/app.js src/app-shell/styles.css
git commit -m "feat(failure-card): 前端组件 + 样式 + thread 内合流挂载"
```

---

### Task 1.9：verify:app-shell 加白名单漂移守卫和 DOM 挂载断言

**Files:**
- Modify: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: 在 verify 脚本顶部 import**

```js
import { FAILURE_COMMANDS as BE_COMMANDS } from '../src/shared/failure-commands.mjs';
import { FAILURE_COMMANDS as FE_COMMANDS } from '../src/app-shell/components/failure-card.js';
```

- [ ] **Step 2: 加守卫**

```js
function checkFailureCommandDrift() {
  const a = Object.keys(BE_COMMANDS).sort().join(',');
  const b = Object.keys(FE_COMMANDS).sort().join(',');
  if (a !== b) {
    throw new Error(`故障卡命令白名单已漂移:\n  shared: ${a}\n  frontend: ${b}`);
  }
  console.log('[verify] 故障卡白名单一致:', Object.keys(BE_COMMANDS).length, '个命令');
}
```

并在 main 流程中调用 `checkFailureCommandDrift()`。

- [ ] **Step 3: 加 HTML/JS smoke 断言**

在已有的 DOM 检查处追加：

```js
// 检查 styles.css 包含 .failure-card 规则
const css = await fs.readFile('src/app-shell/styles.css', 'utf8');
if (!css.includes('.failure-card')) throw new Error('styles.css 缺失 .failure-card');
console.log('[verify] styles.css 含故障卡样式');
```

- [ ] **Step 4: 运行 verify**

```powershell
npm run verify:app-shell
```

预期：包含 `[verify] 故障卡白名单一致` 一行 + `[verify] styles.css 含故障卡样式`

- [ ] **Step 5: 提交**

```powershell
git add scripts/verify-app-shell.mjs
git commit -m "test(failure-card): verify:app-shell 加白名单漂移守卫和挂载断言"
```

---

### Task 1.10：agent-engine 最小消费 failure_resolved（仅 pause-here）

> **本期范围**：只实现 `pause-here` 一种动作，让 agent 看到该事件后**主动结束当前循环**（即用户点了"停在这里"按钮，agent 真的停）。其它动作（fill-words / raise-budget 等）保留 audit 记录，**真正生效**由 `ux-agent-status-truthfulness` 的 retry 路径承担——这是 spec §六 "P0 直接消除出错痛点" 的最小闭环保证。

**Files:**
- Modify: `src/core/agent-engine.mjs`
- Test: `tests/agent-engine.test.mjs`（扩展）

- [ ] **Step 1: 在 agent-engine 主循环顶端检查最近 failure_resolved**

```js
import { readEvents } from './event-log.mjs';

// 在 runProject 主循环每步开始时：
const recentEvents = await readEvents(projectRoot, { limit: 5 });
const recentResolve = recentEvents.find(e => e.type === 'failure_resolved');
if (recentResolve && recentResolve.message === 'pause-here') {
  await appendEvent(projectRoot, {
    type: 'project_paused',
    severity: 'info',
    message: '用户在故障卡选择停在这里',
    data: { source: 'failure_resolved', failureId: recentResolve.data?.failureId }
  });
  return;  // 退出 runProject；保留状态为当前 stage，可后续手动 retry
}
```

- [ ] **Step 2: 测试**

```js
test('agent-engine 检测到 failure_resolved=pause-here 后立刻退出循环', async () => {
  // 写一个 failure_resolved 事件到 run_log.jsonl
  // 启动 runProject (用 mock provider 防止真实调用)
  // 断言：runProject return 后状态未推进，并写了 project_paused 事件
});
```

- [ ] **Step 3: 提交**

```powershell
git add src/core/agent-engine.mjs tests/agent-engine.test.mjs
git commit -m "feat(failure-card): agent-engine 检测 failure_resolved=pause-here 退出循环（最小闭环）"
```

---

### Task 1.11：Phase 1 收口 — 跑全套测试 + 准备 PR

- [ ] **Step 1: 运行全部测试**

```powershell
npm test
```

预期：所有测试通过（含原有 54 + 新增 ≥5 个测试）

- [ ] **Step 2: 运行 verify:app-shell**

```powershell
npm run verify:app-shell
```

预期：包含上面新增的守卫输出

- [ ] **Step 3: 整理 commit log**

```powershell
git log --oneline -10
```

确认 Phase 1 共 9 个 commit；每个 commit 信息清晰。

- [ ] **Step 4: 准备 PR 描述（不在此 plan 内创建 PR）**

PR 标题：`feat(ux): 故障卡 — 出错后给出一句话原因 + 可点击下一步`

PR Body 模板：
```
## Summary
- 新增 failures.jsonl 衍生文件 + 6 种 kind 字符串映射
- /api/dashboard 暴露 failures 字段（最近 10 未处理 + 5 已处理）
- /api/commands/submit 接受 failureId + 命令白名单 + 防重放
- 前端 thread 内合流渲染故障卡，点击 action 触发受控提交
- verify:app-shell 加白名单漂移守卫

## Test Plan
- [x] npm test
- [x] npm run verify:app-shell
- [ ] 手动：触发 word-count gate 失败，确认故障卡渲染、按钮可点、提交后变灰
```

---

# Phase 2：活动条（PR #2）

### Task 2.1：后端 recent_tool_events 字段（mtime 短路）

**Files:**
- Create: `src/core/recent-tool-events.mjs`
- Modify: `src/core/app-dashboard.mjs`
- Test: `tests/recent-tool-events.test.mjs`

- [ ] **Step 1: 先写失败测试**

```js
// tests/recent-tool-events.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readRecentToolEvents, makeToolEventsCache } from '../src/core/recent-tool-events.mjs';

function makeProjectWithLog(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwriting-rte-'));
  const p = path.join(dir, 'run_log.jsonl');
  fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

test('只返回 tool_call* / file_write* 类型，倒序，最多 20 条', () => {
  const events = [];
  for (let i = 0; i < 30; i++) {
    events.push({ id: `t${i}`, type: 'tool_call', tool: 'w', ts: `2026-05-31T00:00:${String(i).padStart(2,'0')}Z` });
    events.push({ id: `o${i}`, type: 'other', ts: '2026-05-31T00:00:00Z' });
  }
  const dir = makeProjectWithLog(events);
  const out = readRecentToolEvents(dir);
  assert.equal(out.length, 20);
  assert.equal(out[0].id, 't29');
  assert.equal(out[19].id, 't10');
});

test('mtime 短路: 文件未变化返回缓存', () => {
  const dir = makeProjectWithLog([
    { id: 'a', type: 'tool_call', tool: 'w', ts: '2026-05-31T00:00:00Z' }
  ]);
  const cache = makeToolEventsCache();
  const a = readRecentToolEvents(dir, { cache });
  const b = readRecentToolEvents(dir, { cache });
  assert.equal(a, b);  // 同一对象（缓存命中）
});

test('mtime 变化时返回新数据', async () => {
  const dir = makeProjectWithLog([{ id: 'a', type: 'tool_call', tool: 'w', ts: '...' }]);
  const cache = makeToolEventsCache();
  readRecentToolEvents(dir, { cache });
  await new Promise(r => setTimeout(r, 20));
  fs.appendFileSync(path.join(dir, 'run_log.jsonl'), JSON.stringify({ id: 'b', type: 'tool_call', tool: 'w', ts: '...' }) + '\n');
  const out = readRecentToolEvents(dir, { cache });
  assert.equal(out.length, 2);
});

test('文件不存在返回空数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwriting-rte-empty-'));
  assert.deepEqual(readRecentToolEvents(dir), []);
});
```

- [ ] **Step 2: 运行验证失败**

```powershell
node --test tests/recent-tool-events.test.mjs
```

- [ ] **Step 3: 写实现**

```js
// src/core/recent-tool-events.mjs
import fs from 'node:fs';
import path from 'node:path';

const KEEP = 20;
// 与 agent-engine.mjs 实际写入的事件类型一致（已 grep `type: "..."` 验证）
const TOOL_TYPES = new Set(['tool_call', 'tool_call_requested', 'tool_call_rejected']);

export function makeToolEventsCache() {
  return new Map();  // key: projectRoot, value: { mtimeMs, data }
}

export function readRecentToolEvents(projectRoot, { cache } = {}) {
  const p = path.join(projectRoot, 'run_log.jsonl');
  if (!fs.existsSync(p)) return [];
  const stat = fs.statSync(p);
  if (cache) {
    const hit = cache.get(projectRoot);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data;
  }
  const raw = fs.readFileSync(p, 'utf8');
  const out = [];
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && out.length < KEEP; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s);
      if (TOOL_TYPES.has(ev.type)) out.push(ev);
    } catch { /* 跳过 */ }
  }
  if (cache) cache.set(projectRoot, { mtimeMs: stat.mtimeMs, data: out });
  return out;
}
```

- [ ] **Step 4: 在 `app-dashboard.mjs` 顶部加缓存 + 字段**

```js
import { readRecentToolEvents, makeToolEventsCache } from './recent-tool-events.mjs';
const toolEventsCache = makeToolEventsCache();

// 在返回对象里追加：
recent_tool_events: readRecentToolEvents(projectRoot, { cache: toolEventsCache }),
```

- [ ] **Step 5: 运行测试通过 + 提交**

```powershell
node --test tests/recent-tool-events.test.mjs
git add src/core/recent-tool-events.mjs src/core/app-dashboard.mjs tests/recent-tool-events.test.mjs
git commit -m "feat(activity-strip): recent_tool_events 字段 + mtime 短路缓存"
```

---

### Task 2.2：前端 deriveActivity additive 派生

**Files:**
- Modify: `src/app-shell/agent-truth.mjs`
- Create: `tests/app-shell/derive-activity.test.mjs`

- [ ] **Step 1: 先写失败测试**

```js
// tests/app-shell/derive-activity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveActivity } from '../../src/app-shell/agent-truth.mjs';

// 与真实 loadDashboardData 返回结构对齐
function dash(overrides = {}) {
  return {
    hasProject: true,
    agent_alive: true,
    summary: {
      projectStatus: 'running', currentStage: 'drafting',
      currentChapterNo: 7, completedChapters: 3, targetChapters: 100,
      estimatedCost: 0.18, modelCalls: 12
    },
    state: { current_chapter_no: 7, current_stage: 'drafting', stage_entered_at: '2026-05-31T00:00:00Z' },
    recent_tool_events: [{ id: 'e1', type: 'tool_call', data: { tool: 'write_segment' }, ts: '2026-05-31T00:02:00Z' }],
    chapters: [{ chapter_no: 7, status: 'drafting', actual_words: 1200 }],
    ...overrides
  };
}

test('运行中: 完整字段（segment 暂不可用）', () => {
  const a = deriveActivity(dash(), new Date('2026-05-31T00:02:14Z').getTime());
  assert.equal(a.mode, 'running');
  assert.equal(a.stage, 'drafting');
  assert.equal(a.chapterNo, 7);
  assert.equal(a.segCurrent, null);  // 本期 chapter_index 无 segment 数据
  assert.equal(a.segTotal, null);
  assert.equal(a.lastTool.name, 'write_segment');
  assert.equal(typeof a.elapsedMs, 'number');
  assert.equal(a.spentCost, 0.18);
});

test('blocked 模式', () => {
  const a = deriveActivity(dash({
    agent_alive: false,
    summary: { projectStatus: 'blocked', currentStage: 'blocked' }
  }));
  assert.equal(a.mode, 'blocked');
});

test('缺 recent_tool_events 时 lastTool 为 null', () => {
  const a = deriveActivity(dash({ recent_tool_events: [] }));
  assert.equal(a.lastTool, null);
});

test('缺 chapters 时不报错', () => {
  const a = deriveActivity(dash({ chapters: [] }));
  assert.ok(a);
  assert.equal(a.segCurrent, null);
});

test('idle 模式: 字段简化', () => {
  const a = deriveActivity(dash({
    agent_alive: false,
    summary: { projectStatus: 'idle', currentStage: 'queued' }
  }));
  assert.equal(a.mode, 'idle');
});
```

- [ ] **Step 2: 运行失败 → 实现 → 通过 → 提交**

在 `agent-truth.mjs` 末尾追加：

```js
export function deriveActivity(dashboard, now = Date.now()) {
  if (!dashboard?.hasProject) return null;
  const summary = dashboard.summary ?? {};
  const state = dashboard.state ?? {};
  const status = summary.projectStatus ?? state.project_status ?? 'idle';
  const stage = summary.currentStage ?? state.current_stage ?? null;
  const chapterNo = summary.currentChapterNo ?? state.current_chapter_no ?? null;
  // 本期 chapter_index 无 segment 数据；segCurrent/segTotal 永远 null（spec §1.3 推迟）
  const segCurrent = null;
  const segTotal = null;
  const rt = Array.isArray(dashboard.recent_tool_events) && dashboard.recent_tool_events.length
    ? dashboard.recent_tool_events[0] : null;
  const lastTool = rt ? {
    name: rt.data?.tool ?? rt.tool ?? '',
    status: rt.type === 'tool_call_rejected' ? 'failed'
          : (rt.type === 'tool_call_requested' ? 'pending' : 'ok'),
    ts: rt.ts
  } : null;
  const enteredAt = state.stage_entered_at ? Date.parse(state.stage_entered_at) : NaN;
  const elapsedMs = Number.isNaN(enteredAt) ? null : (now - enteredAt);
  // 本期 cost 用累计（spec §1.3 "当前章节累计" 与 cost.json 实际不符——cost.json 只有项目级累计）
  const spentCost = summary.estimatedCost ?? null;
  let mode = 'idle';
  if (status === 'running' && dashboard.agent_alive) mode = 'running';
  else if (status === 'blocked') mode = 'blocked';
  else if (status === 'interrupted') mode = 'interrupted';
  else if (status === 'completed') mode = 'completed';
  return { stage, chapterNo, segCurrent, segTotal, lastTool, elapsedMs, etaMs: null, spentCost, mode };
}
```

```powershell
node --test tests/app-shell/derive-activity.test.mjs tests/agent-truth.test.mjs
git add src/app-shell/agent-truth.mjs tests/app-shell/derive-activity.test.mjs
git commit -m "feat(activity-strip): agent-truth.mjs 新增 deriveActivity (additive)"
```

---

### Task 2.3：活动条组件 + 样式 + 挂载

**Files:**
- Create: `src/app-shell/components/activity-strip.js`
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`
- Modify: `src/app-shell/index.html`

- [ ] **Step 1: 创建组件**

```js
// src/app-shell/components/activity-strip.js
const STAGE_LABEL = {
  queued: '排队', planning: '规划', planned: '已规划', drafting: '起草',
  reviewing: '审稿', needs_revision: '需修订', revising: '修订',
  finalizing: '定稿', summarizing: '摘要', blocked: '阻塞'
};

export function renderActivityStrip(root, activity, { privacy = false } = {}) {
  if (!activity) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  root.classList.toggle('idle', activity.mode === 'idle' || activity.mode === 'completed');
  root.classList.toggle('blocked', activity.mode === 'blocked' || activity.mode === 'interrupted');

  root.innerHTML = '';
  appendSlot(root, 'stage', `● ${STAGE_LABEL[activity.stage] ?? activity.stage ?? '—'}`);
  if (activity.chapterNo != null) {
    const loc = activity.segCurrent != null
      ? `第 ${activity.chapterNo} 章 · seg ${activity.segCurrent}/${activity.segTotal ?? '?'}`
      : `第 ${activity.chapterNo} 章`;
    appendSlot(root, 'loc', privacy ? '█████' : loc);
  }
  if (activity.lastTool) {
    const sym = activity.lastTool.status === 'pending' ? '→' : activity.lastTool.status === 'failed' ? '✗' : '✓';
    appendSlot(root, 'tool', `${sym} ${privacy ? '████' : activity.lastTool.name}`);
  }
  if (activity.elapsedMs != null) {
    appendSlot(root, 'time', `${formatDuration(activity.elapsedMs)} / ${activity.etaMs != null ? '~' + formatDuration(activity.etaMs) : '—'}`);
  }
  if (activity.spentCost != null) {
    appendSlot(root, 'cost', `¥${activity.spentCost.toFixed(2)}`);
  }
}

function appendSlot(root, name, text) {
  const s = document.createElement('span');
  s.className = `as-slot as-${name}`;
  s.textContent = text;
  root.appendChild(s);
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}
```

- [ ] **Step 2: 在 index.html topbar 之后插入容器**

定位 `<header class="topbar">` 关闭标签后，插入：

```html
<div class="activity-strip" id="activity-strip" hidden></div>
```

- [ ] **Step 3: 在 app.js 里挂载**

```js
import { renderActivityStrip } from './components/activity-strip.js';
import { deriveActivity } from './agent-truth.mjs';

// 在 dashboard 更新流程里：
const stripEl = document.getElementById('activity-strip');
renderActivityStrip(stripEl, deriveActivity(dashboard), { privacy: app.dataset.privacy === 'on' });
```

- [ ] **Step 4: 加样式**

```css
/* styles.css 末尾 */
.activity-strip {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 16px;
  height: 36px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-2);
  font-size: 12px;
  color: var(--ink-2);
}
.activity-strip.idle { height: 28px; }
.activity-strip.blocked .as-stage { color: var(--red); }
.as-slot { white-space: nowrap; }
.as-slot:not(:last-child)::after {
  content: '│'; margin-left: 14px; color: var(--ghost);
}
.as-tool { transition: background 150ms; }
```

- [ ] **Step 5: 运行 verify + 提交**

```powershell
npm run verify:app-shell
git add src/app-shell/components/activity-strip.js src/app-shell/app.js src/app-shell/styles.css src/app-shell/index.html
git commit -m "feat(activity-strip): 组件 + 样式 + topbar 下方挂载"
```

---

### Task 2.4：活动条交互（点击成本/章节 fallback）

**Files:**
- Modify: `src/app-shell/components/activity-strip.js`
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: 在组件加 click 回调参数**

```js
// activity-strip.js renderActivityStrip 签名扩展为：
export function renderActivityStrip(root, activity, { privacy = false, onClickCost, onClickChapter } = {}) {
  // ... 已有渲染 ...
  // 在挂载 cost slot 时：
  if (activity.spentCost != null) {
    const s = appendSlot(root, 'cost', `¥${activity.spentCost.toFixed(2)}`);
    if (onClickCost) { s.style.cursor = 'pointer'; s.addEventListener('click', onClickCost); }
  }
  // 同理 loc slot 加 onClickChapter
}
```

> 修改 `appendSlot` 改为 `return s`。

- [ ] **Step 2: 在 app.js 先定义 `openDrawerTab` 包装函数**

```js
// 现有代码只有 setDrawerTab + toggleDrawer，没有 openDrawerTab；本 task 先建包装函数：
function openDrawerTab(tab) {
  const drawer = document.getElementById('drawer');
  if (drawer?.getAttribute('aria-hidden') !== 'false') toggleDrawer();
  setDrawerTab(tab);
}
```

- [ ] **Step 3: 接入活动条点击**

```js
renderActivityStrip(stripEl, deriveActivity(dashboard), {
  privacy: ...,
  onClickCost: () => openDrawerTab('run'),    // P1 阶段 fallback；Phase 3 PR 内改为 'cost'
  onClickChapter: () => openDrawerTab('chapters')
});
```

- [ ] **Step 3: 手动 smoke + 提交**

```powershell
npm run app:shell
# 触发运行；点击成本和章节槽位确认能打开 drawer
git add src/app-shell/components/activity-strip.js src/app-shell/app.js
git commit -m "feat(activity-strip): 槽位点击 fallback 到现有 drawer"
```

---

### Task 2.5：Phase 2 收口

- [ ] **Step 1: 全套测试 + verify**

```powershell
npm test
npm run verify:app-shell
```

- [ ] **Step 2: PR 描述模板**

```
PR 标题：feat(ux): 活动条 — 运行中实时显示阶段/段/工具/时间/成本
Summary:
- 新增 /api/dashboard.recent_tool_events 字段，mtime 短路缓存
- agent-truth.mjs 新增 deriveActivity (additive)
- topbar 下方常驻 36px 活动条，blocked 时变红
Test Plan:
- [x] npm test, npm run verify:app-shell
- [ ] 手动：跑 3 章项目观察活动条更新节奏
```

---

# Phase 3：Quick Rail（PR #3）

### Task 3.1：~~后端 sources_summary 与 reviewer_summary~~（已删除——复用现有字段）

> **删除原因**：`loadDashboardData` 已经返回 `dashboard.sources`（含 `count` / `latest[]`）和 `dashboard.review`（含 `generated_at`）。本期 Quick Rail 徽章直接用它们，不需要新增字段。mtime 短路若需要，由后续性能 PR 单独做。
>
> **跳到 Task 3.2**。

---

### ~~Task 3.1（已删除）：原内容备查~~

**Files:**
- Create: `src/core/dashboard-summaries.mjs`
- Modify: `src/core/app-dashboard.mjs`
- Test: `tests/dashboard-summaries.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// tests/dashboard-summaries.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readSourcesSummary, readReviewerSummary, makeSummariesCache } from '../src/core/dashboard-summaries.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sum-')); }

test('readSourcesSummary 统计 sources/ 数量和最新时间', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sources'));
  fs.writeFileSync(path.join(dir, 'sources', 'a.json'), '{}');
  fs.writeFileSync(path.join(dir, 'sources', 'b.json'), '{}');
  const s = readSourcesSummary(dir);
  assert.equal(s.count, 2);
  assert.ok(s.latestTs);
});

test('readReviewerSummary - 读 reviewer_report.json', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'reviewer_report.json'),
    JSON.stringify({ generated_at: '2026-05-31T00:00:00Z', summary: 'OK' }));
  const r = readReviewerSummary(dir);
  assert.equal(r.lastReportTs, '2026-05-31T00:00:00Z');
});

test('文件不存在: 空摘要', () => {
  const dir = tmp();
  assert.deepEqual(readSourcesSummary(dir), { count: 0, latestTs: null });
  assert.deepEqual(readReviewerSummary(dir), { lastReportTs: null });
});

test('mtime 短路', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'reviewer_report.json'),
    JSON.stringify({ generated_at: '2026-05-31T00:00:00Z' }));
  const cache = makeSummariesCache();
  const a = readReviewerSummary(dir, { cache });
  const b = readReviewerSummary(dir, { cache });
  assert.equal(a, b);
});
```

- [ ] **Step 2: 实现**

```js
// src/core/dashboard-summaries.mjs
import fs from 'node:fs';
import path from 'node:path';

export function makeSummariesCache() {
  return { sources: new Map(), reviewer: new Map() };
}

export function readSourcesSummary(projectRoot, { cache } = {}) {
  const dir = path.join(projectRoot, 'sources');
  if (!fs.existsSync(dir)) return { count: 0, latestTs: null };
  const stat = fs.statSync(dir);
  if (cache?.sources) {
    const hit = cache.sources.get(projectRoot);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data;
  }
  const entries = fs.readdirSync(dir);
  let latest = 0;
  for (const name of entries) {
    const s = fs.statSync(path.join(dir, name));
    if (s.mtimeMs > latest) latest = s.mtimeMs;
  }
  const data = { count: entries.length, latestTs: latest ? new Date(latest).toISOString() : null };
  if (cache?.sources) cache.sources.set(projectRoot, { mtimeMs: stat.mtimeMs, data });
  return data;
}

export function readReviewerSummary(projectRoot, { cache } = {}) {
  const p = path.join(projectRoot, 'reviewer_report.json');
  if (!fs.existsSync(p)) return { lastReportTs: null };
  const stat = fs.statSync(p);
  if (cache?.reviewer) {
    const hit = cache.reviewer.get(projectRoot);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data;
  }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const data = { lastReportTs: j.generated_at ?? null };
    if (cache?.reviewer) cache.reviewer.set(projectRoot, { mtimeMs: stat.mtimeMs, data });
    return data;
  } catch {
    return { lastReportTs: null };
  }
}
```

- [ ] **Step 3: 接入 dashboard + 提交**

```js
// app-dashboard.mjs
import { readSourcesSummary, readReviewerSummary, makeSummariesCache } from './dashboard-summaries.mjs';
const summariesCache = makeSummariesCache();

// 返回对象追加：
sources_summary: readSourcesSummary(projectRoot, { cache: summariesCache }),
reviewer_summary: readReviewerSummary(projectRoot, { cache: summariesCache }),
```

```powershell
node --test tests/dashboard-summaries.test.mjs
git add src/core/dashboard-summaries.mjs src/core/app-dashboard.mjs tests/dashboard-summaries.test.mjs
git commit -m "feat(quick-rail): sources_summary 和 reviewer_summary 字段 + mtime 短路"
```

---

### Task 3.2：前端 deriveBadges + localStorage 分桶

**Files:**
- Modify: `src/app-shell/agent-truth.mjs`
- Create: `src/app-shell/components/last-seen.js`
- Create: `tests/app-shell/derive-badges.test.mjs`

- [ ] **Step 1: 创建 last-seen 工具（key 按 projectRoot 分桶）**

```js
// src/app-shell/components/last-seen.js
function hashKey(projectRoot) {
  // 简单 fnv-1a，输出 16 位 hex（无需密码强度，仅做分桶）
  let h = 0x811c9dc5;
  for (let i = 0; i < projectRoot.length; i++) {
    h ^= projectRoot.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + projectRoot.length.toString(16).padStart(4, '0');
}

export function getLastSeen(projectRoot, tab) {
  if (!projectRoot) return null;
  return localStorage.getItem(`wwriting:lastSeen:${hashKey(projectRoot)}:${tab}`);
}

export function setLastSeen(projectRoot, tab, ts = new Date().toISOString()) {
  if (!projectRoot) return;
  localStorage.setItem(`wwriting:lastSeen:${hashKey(projectRoot)}:${tab}`, ts);
}

export function watchLastSeen(callback) {
  window.addEventListener('storage', (e) => {
    if (e.key?.startsWith('wwriting:lastSeen:')) callback();
  });
}
```

- [ ] **Step 2: 写 deriveBadges 测试**

```js
// tests/app-shell/derive-badges.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBadges } from '../../src/app-shell/agent-truth.mjs';

// 字段路径与 loadDashboardData 真实返回对齐
const base = {
  hasProject: true,
  summary: { completedChapters: 3, targetChapters: 100, estimatedCost: 4.0 },
  project: { budget_config: { max_cost: 5.0 } },
  skills: { items: [{ name: 'cliffhanger', enabled_in_project: true }, { name: 'other', enabled_in_project: false }] },
  sources: { count: 5, latest: [{ captured_at: '2026-05-31T00:00:00Z' }] },
  review: { generated_at: '2026-05-31T00:00:00Z' }
};

test('cost level: 80% warning', () => {
  const b = deriveBadges({ ...base, summary: { ...base.summary, estimatedCost: 4.5 } });
  assert.equal(b.cost.level, 'warning');
});

test('cost level: over budget', () => {
  const b = deriveBadges({ ...base, summary: { ...base.summary, estimatedCost: 5.5 } });
  assert.equal(b.cost.level, 'over');
});

test('research newSinceLastVisit 计算', () => {
  const lastSeen = { research: '2026-05-30T00:00:00Z' };
  const b = deriveBadges(base, '/path/A', lastSeen);
  assert.equal(b.research.newSinceLastVisit, true);
  const b2 = deriveBadges(base, '/path/A', { research: '2026-05-31T01:00:00Z' });
  assert.equal(b2.research.newSinceLastVisit, false);
});

test('chapters done/total + skills enabledCount', () => {
  const b = deriveBadges(base);
  assert.equal(b.chapters.done, 3);
  assert.equal(b.chapters.total, 100);
  assert.equal(b.skills.enabledCount, 1);
});
```

- [ ] **Step 3: 实现**

```js
// agent-truth.mjs 末尾追加（字段路径与 loadDashboardData 真实结构对齐）
export function deriveBadges(dashboard, projectRoot = '', lastSeen = {}) {
  const total = dashboard?.summary?.targetChapters ?? 0;
  const done = dashboard?.summary?.completedChapters ?? 0;
  const skillItems = dashboard?.skills?.items ?? [];
  const enabledCount = skillItems.filter(s => s.enabled_in_project).length;
  const sourcesCount = dashboard?.sources?.count ?? 0;
  const sourcesLatestTs = dashboard?.sources?.latest?.[0]?.captured_at ?? null;
  const reviewerTs = dashboard?.review?.generated_at ?? null;
  const newResearch = sourcesLatestTs && lastSeen.research
    ? sourcesLatestTs > lastSeen.research
    : !!sourcesLatestTs;
  const newReviewer = reviewerTs && lastSeen.reviewer
    ? reviewerTs > lastSeen.reviewer
    : !!reviewerTs;
  const used = dashboard?.summary?.estimatedCost ?? 0;
  const budget = dashboard?.project?.budget_config?.max_cost ?? 0;
  const pct = budget > 0 ? used / budget : 0;
  let level = 'normal';
  if (pct >= 1) level = 'over';
  else if (pct >= 0.8) level = 'warning';
  return {
    chapters: { done, total, ticking: false },
    skills: { enabledCount },
    research: { newSinceLastVisit: !!newResearch, count: sourcesCount },
    cost: { used, budget, pct, level },
    reviewer: { hasUnread: !!newReviewer, lastReportTs: reviewerTs }
  };
}
```

- [ ] **Step 4: 运行测试 + 提交**

```powershell
node --test tests/app-shell/derive-badges.test.mjs
git add src/app-shell/agent-truth.mjs src/app-shell/components/last-seen.js tests/app-shell/derive-badges.test.mjs
git commit -m "feat(quick-rail): deriveBadges 与 localStorage 按 projectRoot 分桶"
```

---

### Task 3.3：Quick Rail 组件 + 悬停浮窗 + 键盘

**Files:**
- Create: `src/app-shell/components/quick-rail.js`
- Modify: `src/app-shell/index.html`
- Modify: `src/app-shell/styles.css`
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: 创建组件骨架**

```js
// src/app-shell/components/quick-rail.js
import { setLastSeen } from './last-seen.js';

const SLOTS = [
  { key: 'chapters', icon: '📖', label: '章节', tab: 'chapters' },
  { key: 'skills',   icon: '🧩', label: '技能', tab: 'skills' },
  { key: 'research', icon: '📎', label: '资料', tab: 'research' },
  { key: 'cost',     icon: '💰', label: '成本', tab: 'cost' },
  { key: 'reviewer', icon: '🔍', label: '审查', tab: 'reviewer' }
];

export function renderQuickRail(root, badges, { onOpenTab, projectRoot }) {
  root.innerHTML = '';
  for (const slot of SLOTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qr-slot';
    btn.dataset.key = slot.key;
    btn.title = slot.label;
    btn.setAttribute('aria-label', slot.label);

    const icon = document.createElement('span');
    icon.className = 'qr-icon';
    icon.textContent = slot.icon;
    btn.appendChild(icon);

    const badge = badgeText(slot.key, badges);
    if (badge) {
      const b = document.createElement('span');
      b.className = `qr-badge level-${badges[slot.key]?.level ?? 'normal'}`;
      if (badges[slot.key]?.newSinceLastVisit || badges[slot.key]?.hasUnread) b.classList.add('dot');
      b.textContent = badge;
      btn.appendChild(b);
    }
    btn.addEventListener('click', () => {
      onOpenTab(slot.tab);
      if (slot.key === 'research' || slot.key === 'reviewer') {
        setLastSeen(projectRoot, slot.key);
      }
    });
    attachHoverPreview(btn, slot.key, badges);
    root.appendChild(btn);
  }
}

function badgeText(key, badges) {
  const b = badges[key];
  if (!b) return '';
  if (key === 'chapters' && b.total > 0) return `${b.done}/${b.total}`;
  if (key === 'skills' && b.enabledCount > 0) return String(b.enabledCount);
  if (key === 'cost' && b.budget > 0) return `${Math.round(b.pct * 100)}%`;
  return '';
}

function attachHoverPreview(btn, key, badges) {
  let pop = null;
  let timer = null;
  btn.addEventListener('mouseenter', () => {
    timer = setTimeout(() => {
      pop = document.createElement('div');
      pop.className = 'qr-popover';
      pop.textContent = previewText(key, badges);
      document.body.appendChild(pop);
      const r = btn.getBoundingClientRect();
      pop.style.right = `${window.innerWidth - r.left + 8}px`;
      pop.style.top = `${r.top}px`;
    }, 200);
  });
  btn.addEventListener('mouseleave', () => {
    clearTimeout(timer);
    if (pop) { pop.remove(); pop = null; }
  });
}

function previewText(key, badges) {
  const b = badges[key];
  if (!b) return '';
  if (key === 'chapters') return `已完成 ${b.done} / ${b.total}`;
  if (key === 'skills') return `已启用 ${b.enabledCount} 个技能`;
  if (key === 'research') return `资料 ${b.count} 条${b.newSinceLastVisit ? ' · 有新增' : ''}`;
  if (key === 'cost') return `已用 ¥${b.used.toFixed(2)} / 预算 ¥${b.budget.toFixed(2)}\n占比 ${Math.round(b.pct * 100)}%`;
  if (key === 'reviewer') return b.lastReportTs ? `最近报告: ${b.lastReportTs}` : '暂无报告';
  return '';
}

export function bindQuickRailKeys(root, onOpenTab) {
  document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    const idx = Number(e.key) - 1;
    if (idx >= 0 && idx < SLOTS.length) {
      e.preventDefault();
      onOpenTab(SLOTS[idx].tab);
    }
  });
}
```

- [ ] **Step 2: 在 index.html 加容器**

在主列尾部加：

```html
<nav class="quick-rail" id="quick-rail" aria-label="快捷面板"></nav>
```

并调整 `<div class="main">` 改为 `<div class="main"><div class="main-inner">...</div></div>`，使 Quick Rail 与原内容并排。

- [ ] **Step 3: 样式**

```css
.main { display: flex; flex-direction: row; flex: 1; min-width: 0; }
.main-inner { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.quick-rail {
  width: 48px; flex: 0 0 48px;
  border-left: 1px solid var(--line);
  background: var(--rail-2);
  display: flex; flex-direction: column;
  align-items: center; padding: 12px 0; gap: 6px;
}
.qr-slot {
  width: 36px; height: 36px;
  border-radius: var(--r-sm);
  position: relative;
  display: flex; align-items: center; justify-content: center;
}
.qr-slot:hover { background: var(--hover); }
.qr-icon { font-size: 16px; }
.qr-badge {
  position: absolute; bottom: 0; right: 0;
  font-size: 9px; padding: 1px 4px;
  border-radius: 6px;
  background: var(--surface); border: 1px solid var(--line);
}
.qr-badge.level-warning { background: var(--amber-soft); color: var(--amber); border-color: transparent; }
.qr-badge.level-over { background: var(--red-soft); color: var(--red); border-color: transparent; }
.qr-badge.dot::after {
  content: ''; position: absolute; top: -2px; right: -2px;
  width: 6px; height: 6px; background: var(--red); border-radius: 50%;
}
.qr-popover {
  position: fixed;
  background: var(--ink); color: var(--surface);
  font-size: 12px; padding: 8px 12px; border-radius: var(--r-sm);
  white-space: pre-line;
  box-shadow: var(--shadow);
  pointer-events: none;
  z-index: 1000;
}
@media (max-width: 1100px) {
  .quick-rail { display: none; }
  .qr-collapsed-btn { display: inline-flex; }  /* 顶栏窄屏入口 */
}
```

- [ ] **Step 4: 在 app.js 接入**

```js
import { renderQuickRail, bindQuickRailKeys } from './components/quick-rail.js';
import { deriveBadges } from './agent-truth.mjs';
import { getLastSeen, watchLastSeen } from './components/last-seen.js';

// 包装：现有 setDrawerTab 只切 tab；这里加 drawer 展开（参考 app.js#130 `toggleDrawer()`）
function openDrawerTab(tab) {
  const drawer = document.getElementById('drawer');
  if (drawer?.getAttribute('aria-hidden') !== 'false') toggleDrawer();
  setDrawerTab(tab);
}

const railEl = document.getElementById('quick-rail');
bindQuickRailKeys(railEl, openDrawerTab);
watchLastSeen(() => paintDashboard(lastDashboard));

function paintDashboard(dashboard) {
  // ... 已有渲染 ...
  const lastSeen = {
    research: getLastSeen(currentProjectRoot, 'research'),
    reviewer: getLastSeen(currentProjectRoot, 'reviewer')
  };
  const badges = deriveBadges(dashboard, currentProjectRoot, lastSeen);
  renderQuickRail(railEl, badges, { onOpenTab: openDrawerTab, projectRoot: currentProjectRoot });
}
```

> **关于 `openDrawerTab`**：plan 多处出现这个函数名，但**现有代码没有**这个函数（只有 `setDrawerTab` + `toggleDrawer`）。Phase 2 的活动条 cost/章节点击在 `openDrawerTab` 定义前会 ReferenceError。**修正策略**：把 `openDrawerTab` 的定义提到 Phase 2 Task 2.4，作为前置；Phase 3 Task 3.3 在该函数已存在的基础上只 import/调用。

- [ ] **Step 5: 提交**

```powershell
npm run verify:app-shell
git add src/app-shell/components/quick-rail.js src/app-shell/index.html src/app-shell/styles.css src/app-shell/app.js
git commit -m "feat(quick-rail): 组件 + 悬停浮窗 + Alt+1..5 键盘"
```

---

### Task 3.4：新增 4 个 drawer tab 视图

**Files:**
- Create: `src/app-shell/components/drawer-tabs.js`
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/index.html`

- [ ] **Step 1: 创建 drawer 新 tab 视图**

```js
// src/app-shell/components/drawer-tabs.js
export function renderSkillsTab(root, dashboard) {
  const enabled = dashboard?.project?.skills_enabled ?? [];
  const available = dashboard?.project?.skills_available ?? [];
  root.innerHTML = `
    <h4>已启用 (${enabled.length})</h4>
    <ul class="skill-list">${enabled.map(s => `<li>${escape(s.name ?? s)} · v${escape(s.version ?? '?')}</li>`).join('')}</ul>
    <h4>可用未启用 (${available.length})</h4>
    <ul class="skill-list">${available.map(s => `<li>${escape(s.name ?? s)} · v${escape(s.version ?? '?')}</li>`).join('')}</ul>
  `;
}

export function renderResearchTab(root, dashboard) {
  const sources = dashboard?.sources ?? [];
  root.innerHTML = sources.length === 0
    ? '<p class="empty">暂无资料</p>'
    : `<ul class="src-list">${sources.map(s => `<li><strong>${escape(s.title ?? '(无标题)')}</strong><br><small>${escape(s.domain ?? '')} · ${escape(s.fetched_at ?? '')}</small></li>`).join('')}</ul>`;
}

export function renderCostTab(root, dashboard) {
  const c = dashboard?.cost ?? {};
  const budget = dashboard?.effective_config?.budget?.max_cost ?? 0;
  root.innerHTML = `
    <div class="cost-grid">
      <div><label>今日</label><strong>¥${(c.today ?? 0).toFixed(2)}</strong></div>
      <div><label>本章</label><strong>¥${(c.currentChapter ?? 0).toFixed(2)}</strong></div>
      <div><label>累计</label><strong>¥${(c.total ?? 0).toFixed(2)}</strong></div>
      <div><label>预算</label><strong>¥${budget.toFixed(2)}</strong></div>
    </div>
  `;
}

export function renderReviewerTab(root, dashboard) {
  const r = dashboard?.reviewer ?? null;
  root.innerHTML = r
    ? `<p class="reviewer-meta">${escape(r.generated_at ?? '')}</p><pre class="reviewer-body">${escape(r.summary ?? '')}</pre>`
    : '<p class="empty">暂无 reviewer 报告</p>';
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
```

- [ ] **Step 2: 在 drawer tab 列表加 4 个新按钮**

修改 `index.html` 的 `<div class="drawer-tabs">`：

```html
<button class="dtab" data-dtab="skills" type="button" role="tab" aria-selected="false">技能</button>
<button class="dtab" data-dtab="research" type="button" role="tab" aria-selected="false">资料</button>
<button class="dtab" data-dtab="cost" type="button" role="tab" aria-selected="false">成本</button>
<button class="dtab" data-dtab="reviewer" type="button" role="tab" aria-selected="false">审查</button>
```

在 `app.js` 的 drawer 切换路由里——**先 grep 现有 chapters/model/run 三个 tab 的渲染函数实际名字**：

```powershell
node -e "const t=require('fs').readFileSync('src/app-shell/app.js','utf8');['chapters','model','run'].forEach(n=>{const m=t.match(new RegExp('function\\\\s+(\\\\w*'+n+'\\\\w*)','i'));console.log(n,'→',m?m[1]:'NOT FOUND')})"
```

按实际名字替换下面的 `renderChaptersTab` 等占位，然后写入：

```js
import { renderSkillsTab, renderResearchTab, renderCostTab, renderReviewerTab } from './components/drawer-tabs.js';

// 把现有三个 tab 的渲染函数也收口到 TAB_RENDERERS（按实际函数名替换）
const TAB_RENDERERS = {
  chapters: /* 实际函数名 */,
  model:    /* 实际函数名 */,
  run:      /* 实际函数名 */,
  skills: renderSkillsTab,
  research: renderResearchTab,
  cost: renderCostTab,
  reviewer: renderReviewerTab
};

function openDrawerTab(tab) {
  // 已有：打开 drawer + 切换 .dtab.on
  const body = document.getElementById('drawer-body');
  TAB_RENDERERS[tab]?.(body, lastDashboard);
}
```

如果现有代码 drawer 内容不是按"函数集合"组织（例如直接 inline `switch`），则在该 switch 加 4 个新分支即可，**不强制重构**——遵循现有代码风格。

- [ ] **Step 3: 提交**

```powershell
npm run verify:app-shell
git add src/app-shell/components/drawer-tabs.js src/app-shell/app.js src/app-shell/index.html
git commit -m "feat(quick-rail): 新增 skills/research/cost/reviewer 4 个 drawer tab"
```

---

### Task 3.5：顶栏按钮收敛 + 窄屏折叠

**Files:**
- Modify: `src/app-shell/index.html`
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`

- [ ] **Step 1: 移除顶栏「章节」和「面板」按钮**

`index.html` 顶栏 `topbar-actions` 内删除 `id="open-chapters"` 和 `id="open-panel"` 两个按钮。

`app.js` 删除对应 click 绑定。

- [ ] **Step 2: 加窄屏折叠按钮**

`index.html` 在顶栏右侧加：

```html
<button class="tbtn qr-collapsed-btn" id="qr-collapsed" type="button" aria-label="快捷面板" hidden>面板</button>
```

`app.js`：

```js
// 检测窄屏，切换按钮显示
function updateQuickRailLayout() {
  const narrow = window.innerWidth < 1100;
  document.getElementById('quick-rail').hidden = narrow;
  document.getElementById('qr-collapsed').hidden = !narrow;
}
window.addEventListener('resize', updateQuickRailLayout);
updateQuickRailLayout();

document.getElementById('qr-collapsed').addEventListener('click', () => {
  // 弹出覆盖式快捷菜单（5 个按钮垂直排列）
  showCollapsedMenu();
});
```

- [ ] **Step 3: 提交**

```powershell
npm run verify:app-shell
git add src/app-shell/index.html src/app-shell/app.js src/app-shell/styles.css
git commit -m "feat(quick-rail): 顶栏按钮收敛 + 窄屏 (<1100px) 折叠为单按钮"
```

---

### Task 3.6：把活动条 cost 点击切回 Quick Rail cost tab

**Files:**
- Modify: `src/app-shell/app.js`

- [ ] **Step 1: 修改 Phase 2 留下的 fallback**

```js
// Phase 2 留下的 onClickCost: () => openDrawerTab('run')
// 现在改为：
renderActivityStrip(stripEl, deriveActivity(dashboard), {
  privacy: ...,
  onClickCost: () => openDrawerTab('cost'),    // 改这里
  onClickChapter: () => openDrawerTab('chapters')
});
```

- [ ] **Step 2: 提交**

```powershell
git add src/app-shell/app.js
git commit -m "feat(quick-rail): 活动条 cost 点击改为 Quick Rail cost tab"
```

---

### Task 3.7：Phase 3 收口

- [ ] **Step 1: 全套测试 + verify**

```powershell
npm test
npm run verify:app-shell
npm run verify:local
```

预期：全部通过

- [ ] **Step 2: 手动 smoke**

```powershell
npm run desktop:electron
```

- 触发不同状态（运行/blocked/idle/完成），观察活动条和 Quick Rail 反应
- 悬停每个 Quick Rail 槽位确认浮窗 ≤ 6 行内容
- 按 Alt+1..5 确认键盘可达
- 调小窗口到 <1100px 确认折叠为单按钮
- 多开 2 个项目，确认 localStorage 未读不互相清空（参见 spec §3.8 关键点）

- [ ] **Step 3: PR 描述模板**

```
PR 标题：feat(ux): Quick Rail — 高级功能常驻入口 + 4 个新 drawer tab
Summary:
- 主列右侧常驻 48px Quick Rail (5 个槽位 + 设置)
- 新增 sources_summary / reviewer_summary dashboard 字段（mtime 短路）
- deriveBadges + localStorage 按 projectRoot 分桶
- 新增 skills/research/cost/reviewer 4 个 drawer tab
- 顶栏「章节/面板」按钮移除；窄屏折叠
- 活动条 cost 点击改连接 Quick Rail
Test Plan:
- [x] npm test, npm run verify:app-shell, npm run verify:local
- [ ] 手动多项目 localStorage 隔离
- [ ] 窄屏折叠
```

---

## 全局收口检查

- [ ] **三个 PR 各自 ship 后：** 跑 `npm run verify:local`、`npm run verify:longrun`、`npm run verify:faults`，确认长跑和故障场景无新回归
- [ ] **memory 更新：** 若发现 spec 未覆盖的实施细节，回写到 `memory/` 对应文件
- [ ] **未决问题落实：** 跟踪 spec §八「未决问题」中"故障卡命令成功后是否显示处理中"——根据真实使用反馈决定是否加 UI
