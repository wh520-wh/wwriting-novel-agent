# 作者创作工作台（第一阶段）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 WWriting 的主界面从以运行记录为中心的 AI 工具页，升级为以“正在创作的作品、当前章节和下一步行动”为中心的作者创作工作台，同时保留现有本地项目、真实运行进度、阅读器和写作流程。

**Architecture:** 不新增云端服务、账号、项目迁移或小说状态机。新增两个纯前端派生模块：`project-identity.mjs` 从既有 `title / story_seed / projectRoot` 稳定生成项目封面主题和字标；`workbench-presentation.mjs` 从既有 dashboard 聚合作品进度、可行动作、最近章节和简短创作轨迹。`app.js` 仍是唯一 dashboard 渲染入口，负责把纯视图模型写入静态 DOM；`thread-renderer.js` 继续只负责事件、对话和详细运行过程，不重复承担主页仪表盘责任。

**Tech Stack:** Node.js ESM、原生 DOM/CSS、Electron、`node:test` + `node:assert/strict`、现有真实 Electron clickability 探针。

## 对抗审查结论与执行护栏

以下问题已在编写计划时对照当前 `app.js`、`write-readiness.mjs`、`chapter-presentation.mjs`、`app-dashboard.mjs` 与两份验证脚本复核，并已反映到后续任务：

- 空项目身份的示例测试要求 `seed: 0` 和首个主题，但原先示例实现仍会对“未命名小说”哈希，首个红灯测试会在实现后持续失败。Task 1 现在把“没有任何身份输入”定义为明确的零值回退。
- 工作台封面原本同时带有 `aria-hidden="true"` 和运行时 `aria-label`；隐藏元素的标签不会被读屏软件读取。Task 3 改为真正可访问的图片语义，并补上进度文本。
- 新模块被 `fetchText()` 读取只能证明返回 2xx，不能证明 `.mjs` 以 JavaScript MIME 提供。Task 7 改为同时断言响应正文和 `Content-Type`。
- 当前真实 Electron 首章 fixture 的目标章节数为 1；这样无法验证“继续写第 2 章”。Task 8 明确将该 fixture 调整为 2 章，并以“运行中或第 2 章已完成”作为竞争条件安全的断言。
- 当前完成卡已有阅读和续写事件绑定；本方案只替换它的数据来源，不能误删该命中链路。Task 5 明确保留现有绑定。

执行前先运行 `git status --short`，并运行 Task 1/2 所依赖的既有聚焦测试，记录任何与本方案无关的基线失败。每个“提交”步骤仅在工作区没有无关改动且用户授权创建提交时执行；否则保留为可审阅的未提交变更，不用提交掩盖基线问题。

**设计决策与范围：**

- **视觉方向：现代编辑部 × 私人书房。** 保留现有暖白、石墨灰的长时间阅读基础；以现有应用图标的青绿、深蓝、金色作为极少量品牌记忆，不把页面改成高饱和渐变产品。
- **项目身份不新增持久化字段。** 主题和封面字标只从已有本地项目资料确定性派生。相同项目在重开、项目列表和主工作台中得到相同的视觉身份；不写入 `project.yaml`，也不需要迁移任何旧项目。
- **作品信息优先于技术日志。** 主区先回答“这是什么书、写到哪里、现在该做什么”；详细工具调用、阶段步骤、成本、审查、资料继续留在既有对话流、活动条和右侧面板。
- **不伪造故事内容。** 只显示已有标题、故事种子、当前章节、实际字数、目标、dashboard 真值和审查真值；不凭空生成“本章目标”“人物状态”或质量结论。
- **不修改图标资产。** 不运行 `npm run assets:icon`，不覆盖 `src/assets/app-icon.ico`；本轮仅在 CSS 中以克制的品牌色呼应已确认的桌面图标。
- **不改变现有按钮的命中链路。** 所有新 CTA 复用 `handleReadinessAction()`、`composer.startCurrentChapter()`、`openReader()` 和 `openDrawerTab()`；新增 UI 后必须以真实 Electron 的 trusted pointer click 验证。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/app-shell/project-identity.mjs` | 无 DOM / 无 I/O 的稳定项目视觉身份：主题、封面字标、可访问名称 | 新建（Task 1） |
| `tests/app-shell/project-identity.test.mjs` | 项目身份的确定性、中文标题、缺失字段和主题白名单回归 | 新建（Task 1） |
| `src/app-shell/workbench-presentation.mjs` | 无 DOM 的作者工作台视图模型：进度、行动、最新已提交章节、活动轨迹、完成卡 | 新建（Task 2） |
| `tests/app-shell/workbench-presentation.test.mjs` | dashboard → 工作台视图模型、章节真值和完成动作回归 | 新建（Task 2） |
| `src/app-shell/index.html` | 新增有稳定 ID / `data-testid` 的项目工作台容器；保留既有 readiness / success 容器 | 修改（Task 3） |
| `src/app-shell/app.js` | 收集工作台 DOM refs；唯一 dashboard 渲染中更新工作台、项目列表缩略封面、完成卡动作 | 修改（Task 4、Task 5） |
| `src/app-shell/thread-renderer.js` | 将重复的会话大封面/指标收为“创作记录”小标题，保留事件、对话和运行细节职责 | 修改（Task 5） |
| `src/app-shell/styles.css` | 建立作品主题变量、工作台、项目缩略封面、统一创作节奏卡和响应式样式 | 修改（Task 6） |
| `tests/app-shell/app-shell-static.test.mjs` | 锁定稳定 DOM 契约、模块接线、项目列表主题和 CTA 复用 | 修改（Task 7） |
| `scripts/verify-app-shell.mjs` | 静态服务器 + dashboard 烟测中验证工作台语义、CSS 和模块均可被服务 | 修改（Task 7） |
| `scripts/verify-app-clickability.cjs` | 真实 Electron 中验证工作台启动、阅读、继续下一章和点击命中 | 修改（Task 8） |
| `docs/USER_GUIDE.zh-CN.md` | 将“认识界面”改为作者可理解的工作台说明与首章/续章路径 | 修改（Task 9） |

不修改：`src/core/project-store.mjs`、`src/core/app-dashboard.mjs`、`src/core/agent-engine.mjs`、`project.yaml`、`agent_state.json`、`chapter_index.json` 及桌面图标文件。

---

### Task 1: 建立确定性的项目视觉身份

**Files:**
- Create: `src/app-shell/project-identity.mjs`
- Create: `tests/app-shell/project-identity.test.mjs`

`project-identity.mjs` 必须只接受普通对象，不访问 `document`、`window`、`localStorage`、网络或文件系统。它不能把项目标题直接拼进 CSS；只返回白名单主题键与安全的文本值。

- [ ] **Step 1: 写失败测试**

Create `tests/app-shell/project-identity.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_THEME_KEYS,
  deriveProjectIdentity,
} from "../../src/app-shell/project-identity.mjs";

const clockShop = {
  projectRoot: "D:\\novels\\clock-shop",
  project: {
    title: "星尘的低语",
    story_seed: "一个钟表匠在午夜发现时间可以倒流。",
  },
};

test("deriveProjectIdentity 对同一项目稳定返回同一主题与字标", () => {
  const first = deriveProjectIdentity(clockShop);
  const second = deriveProjectIdentity({ ...clockShop, project: { ...clockShop.project } });

  assert.deepEqual(first, second);
  assert.equal(first.monogram, "星");
  assert.equal(first.title, "星尘的低语");
  assert.ok(PROJECT_THEME_KEYS.includes(first.theme));
  assert.match(first.ariaLabel, /星尘的低语/u);
});

test("deriveProjectIdentity 将标题、种子和路径共同作为稳定输入", () => {
  const first = deriveProjectIdentity(clockShop);
  const byRoot = deriveProjectIdentity({ ...clockShop, projectRoot: "D:\\novels\\another-clock-shop" });
  const bySeed = deriveProjectIdentity({
    ...clockShop,
    project: { ...clockShop.project, story_seed: "另一部完全不同的故事。" },
  });

  assert.notEqual(first.seed, byRoot.seed);
  assert.notEqual(first.seed, bySeed.seed);
});

test("deriveProjectIdentity 在缺失标题或项目资料时给出安全回退", () => {
  assert.deepEqual(deriveProjectIdentity({}), {
    theme: PROJECT_THEME_KEYS[0],
    monogram: "W",
    title: "未命名小说",
    ariaLabel: "未命名小说的作品封面",
    seed: 0,
  });

  const whitespace = deriveProjectIdentity({ project: { title: "   " }, projectRoot: "D:\\novels\\draft" });
  assert.equal(whitespace.monogram, "W");
  assert.equal(whitespace.title, "未命名小说");
  assert.ok(PROJECT_THEME_KEYS.includes(whitespace.theme));
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
node --test tests/app-shell/project-identity.test.mjs
```

Expected: FAIL，提示无法导入 `src/app-shell/project-identity.mjs`。

- [ ] **Step 3: 实现最小、完整的身份派生模块**

Create `src/app-shell/project-identity.mjs`:

```js
export const PROJECT_THEME_KEYS = Object.freeze([
  "tide",
  "ink",
  "verdant",
  "ember",
  "violet",
]);

function normalizedText(value) {
  return String(value ?? "").trim().replace(/\s+/gu, " ");
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (const char of Array.from(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function deriveProjectIdentity(input = {}) {
  const project = input.project ?? {};
  const storySeed = normalizedText(project.story_seed);
  const projectRoot = normalizedText(input.projectRoot);
  const rawTitle = normalizedText(project.title);
  if (!rawTitle && !storySeed && !projectRoot) {
    return {
      theme: PROJECT_THEME_KEYS[0],
      monogram: "W",
      title: "未命名小说",
      ariaLabel: "未命名小说的作品封面",
      seed: 0,
    };
  }
  const title = rawTitle || "未命名小说";
  const seed = stableHash(`${title}\u0000${storySeed}\u0000${projectRoot}`);

  return {
    theme: PROJECT_THEME_KEYS[seed % PROJECT_THEME_KEYS.length],
    monogram: Array.from(title)[0] ?? "W",
    title,
    ariaLabel: `${title}的作品封面`,
    seed,
  };
}
```

Implementation notes:

- Keep the returned object limited to `theme`, `monogram`, `title`, `ariaLabel`, and `seed` exactly. `seed` is only a test/debuggable deterministic value; no renderer may expose it to the user.
- Theme CSS must be keyed by `data-project-theme`; do not set a style string from title, seed, or project path.
- Do not use `project_id` because the current app-shell dashboard projection does not guarantee that field. The triple `title / story_seed / projectRoot` exists in the current UI flow.

- [ ] **Step 4: 运行测试并确认通过**

Run:

```powershell
node --test tests/app-shell/project-identity.test.mjs
```

Expected: PASS，3 个 test。

- [ ] **Step 5: 提交**

```bash
git add src/app-shell/project-identity.mjs tests/app-shell/project-identity.test.mjs
git commit -m "feat(shell): derive stable project visual identity"
```

---

### Task 2: 从 dashboard 派生作者工作台与章节完成视图

**Files:**
- Create: `src/app-shell/workbench-presentation.mjs`
- Create: `tests/app-shell/workbench-presentation.test.mjs`

此任务把“作品工作台显示什么”固定为可测试的纯数据契约。它只能消费已有 dashboard 数据：`project`、`summary`、`chapters`、`events`、`review`、`projectRoot` 和 `model_profile`。进度必须直接使用 `summary.progressPercent`，不可在前端重新根据章节数猜算。

- [ ] **Step 1: 写失败测试**

Create `tests/app-shell/workbench-presentation.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveChapterCompletion,
  deriveWorkbenchView,
} from "../../src/app-shell/workbench-presentation.mjs";

const dashboard = {
  hasProject: true,
  projectRoot: "D:\\novels\\clock-shop",
  project: {
    title: "星尘的低语",
    story_seed: "一个钟表匠在午夜发现时间可以倒流。",
    active_model: {
      provider: "mock",
      model_name: "mock-writer",
      base_url: "https://mock.example.test/v1",
      api_key_env: "MOCK_API_KEY",
    },
  },
  model_profile: { display: "Mock / mock-writer", is_mock: true },
  summary: {
    completedChapters: 1,
    targetChapters: 8,
    currentChapterNo: 2,
    totalWords: 5461,
    progressPercent: 12,
    projectStatus: "idle",
  },
  state: { current_chapter_no: 2 },
  chatHistory: { busy: false },
  failures: [],
  events: [
    { type: "project_run_started", chapter_no: 1, timestamp: "2026-07-17T09:00:00.000Z" },
    { type: "chapter_completed", chapter_no: 1, timestamp: "2026-07-17T09:02:00.000Z" },
  ],
  review: { status: "passed", reviewed_at: "2026-07-17T09:03:00.000Z" },
  chapters: [
    {
      chapter_no: 1,
      title: "午夜的摆锤",
      actual_words: 5461,
      format: "md",
      artifact: { state: "committed", relativePath: "chapters/001.md" },
    },
  ],
};

test("deriveWorkbenchView 显示已有项目、真实进度和下一章行动", () => {
  const view = deriveWorkbenchView(dashboard);

  assert.equal(view.visible, true);
  assert.equal(view.identity.monogram, "星");
  assert.deepEqual(view.progress, {
    completed: 1,
    target: 8,
    percent: 12,
    totalWords: 5461,
  });
  assert.equal(view.readiness.chapterNo, 2);
  assert.equal(view.primaryAction, "start_chapter");
  assert.equal(view.latestChapter.chapterNo, 1);
  assert.equal(view.latestChapter.canOpen, true);
  assert.equal(view.activity[0].label, "第 1 章已定稿");
  assert.equal(view.activity[0].tone, "success");
});

test("deriveWorkbenchView 只返回已知事件，按最新时间倒序且最多三条", () => {
  const view = deriveWorkbenchView({
    ...dashboard,
    events: [
      ...dashboard.events,
      { type: "unknown_event", timestamp: "2026-07-17T09:04:00.000Z" },
      { type: "project_run_failed", chapter_no: 2, timestamp: "2026-07-17T09:05:00.000Z" },
      { type: "project_created", timestamp: "2026-07-17T08:00:00.000Z" },
    ],
  });

  assert.equal(view.activity.length, 3);
  assert.deepEqual(view.activity.map((entry) => entry.label), [
    "第 2 章需要处理",
    "第 1 章已定稿",
    "开始创作这部小说",
  ]);
});

test("deriveChapterCompletion 只接受已提交的本地 artifact，并在目标完成时收起续写", () => {
  const completion = deriveChapterCompletion(dashboard);
  assert.equal(completion.chapterNo, 1);
  assert.equal(completion.words, 5461);
  assert.equal(completion.format, "MD");
  assert.equal(completion.reviewLabel, "整体审查：已通过");
  assert.equal(completion.continueVisible, true);

  const atTarget = deriveChapterCompletion({
    ...dashboard,
    summary: { ...dashboard.summary, completedChapters: 8, targetChapters: 8, currentChapterNo: 9 },
  });
  assert.equal(atTarget.continueVisible, false);

  const draftOnly = deriveChapterCompletion({
    ...dashboard,
    chapters: [{ chapter_no: 2, artifact: { state: "draft_only" } }],
  });
  assert.equal(draftOnly, null);
});

test("deriveWorkbenchView 在无项目时不产生项目工作台", () => {
  assert.deepEqual(deriveWorkbenchView({ hasProject: false }), {
    visible: false,
    activity: [],
    latestChapter: null,
    completion: null,
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
node --test tests/app-shell/workbench-presentation.test.mjs
```

Expected: FAIL，提示无法导入 `workbench-presentation.mjs`。

- [ ] **Step 3: 实现纯视图模型**

Create `src/app-shell/workbench-presentation.mjs`:

```js
import { presentChapterArtifact } from "./chapter-presentation.mjs";
import { deriveProjectIdentity } from "./project-identity.mjs";
import { deriveWriteReadiness } from "./write-readiness.mjs";

const ACTIVITY_COPY = {
  project_created: ({ chapterNo }) => ({ label: "开始创作这部小说", tone: "neutral", chapterNo }),
  project_run_started: ({ chapterNo }) => ({ label: `开始写第 ${chapterNo} 章`, tone: "active", chapterNo }),
  chapter_completed: ({ chapterNo }) => ({ label: `第 ${chapterNo} 章已定稿`, tone: "success", chapterNo }),
  project_run_finished: ({ chapterNo }) => ({ label: `第 ${chapterNo} 章写作完成`, tone: "success", chapterNo }),
  project_run_failed: ({ chapterNo }) => ({ label: `第 ${chapterNo} 章需要处理`, tone: "warning", chapterNo }),
};

function asFiniteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, asFiniteInteger(value)));
}

function reviewLabel(review) {
  if (!review?.status) return "";
  return {
    passed: "整体审查：已通过",
    warning: "整体审查：有提醒",
    failed: "整体审查：需要处理",
  }[review.status] ?? "";
}

function latestCommittedChapter(data) {
  const projectStatus = data?.summary?.projectStatus;
  const committed = (data?.chapters ?? [])
    .map((chapter) => ({
      chapter,
      artifactView: presentChapterArtifact({
        chapter: chapter.chapter_no,
        artifact: chapter.artifact,
        projectStatus,
      }),
    }))
    .filter(({ artifactView }) => artifactView.canOpen)
    .sort((left, right) => asFiniteInteger(right.chapter.chapter_no) - asFiniteInteger(left.chapter.chapter_no));

  const latest = committed[0];
  if (!latest) return null;
  return {
    chapterNo: asFiniteInteger(latest.chapter.chapter_no),
    title: String(latest.chapter.title ?? "").trim() || `第 ${latest.chapter.chapter_no} 章`,
    words: asFiniteInteger(latest.chapter.actual_words),
    format: String(latest.chapter.format ?? "md").toUpperCase(),
    canOpen: latest.artifactView.canOpen,
  };
}

export function deriveRecentStoryActivity(events) {
  return (Array.isArray(events) ? events : [])
    .map((event, index) => ({ event, index, time: Date.parse(event?.timestamp ?? "") }))
    .filter(({ event }) => Object.hasOwn(ACTIVITY_COPY, event?.type))
    .sort((left, right) => {
      const leftTime = Number.isNaN(left.time) ? -Infinity : left.time;
      const rightTime = Number.isNaN(right.time) ? -Infinity : right.time;
      return rightTime - leftTime || right.index - left.index;
    })
    .slice(0, 3)
    .map(({ event }) => {
      const chapterNo = asFiniteInteger(event.chapter_no);
      const copy = ACTIVITY_COPY[event.type]({ chapterNo: chapterNo || 1 });
      return {
        key: `${event.type}:${event.timestamp ?? ""}:${chapterNo}`,
        ...copy,
        timestamp: event.timestamp ?? "",
      };
    });
}

export function deriveChapterCompletion(data) {
  if (!data?.hasProject || data.summary?.projectStatus === "running") return null;
  const latestChapter = latestCommittedChapter(data);
  if (!latestChapter) return null;

  const completed = asFiniteInteger(data.summary?.completedChapters);
  const target = asFiniteInteger(data.summary?.targetChapters);
  return {
    ...latestChapter,
    reviewLabel: reviewLabel(data.review),
    continueVisible: target === 0 || completed < target,
    nextChapterNo: latestChapter.chapterNo + 1,
  };
}

export function deriveWorkbenchView(data) {
  if (!data?.hasProject) {
    return { visible: false, activity: [], latestChapter: null, completion: null };
  }

  const summary = data.summary ?? {};
  const readiness = deriveWriteReadiness(data);
  const latestChapter = latestCommittedChapter(data);
  const completion = deriveChapterCompletion(data);
  return {
    visible: true,
    identity: deriveProjectIdentity(data),
    title: String(data.project?.title ?? "").trim() || "未命名小说",
    storySeed: String(data.project?.story_seed ?? "").trim(),
    readiness,
    primaryAction: readiness.primaryAction,
    progress: {
      completed: asFiniteInteger(summary.completedChapters),
      target: asFiniteInteger(summary.targetChapters),
      percent: clampPercent(summary.progressPercent),
      totalWords: asFiniteInteger(summary.totalWords),
    },
    latestChapter,
    completion,
    activity: deriveRecentStoryActivity(data.events),
  };
}
```

Implementation notes:

- Use `presentChapterArtifact(...).canOpen`, not `chapter.status`, as the criterion for a readable completed chapter. This preserves the existing file/checksum truth boundary.
- Deliberately use dashboard-level `review.status` and its true persisted timestamp name `reviewed_at`; do not continue reading nonexistent `chapter.review_status` fields.
- `project_run_finished` can coexist with `chapter_completed`; displaying only the latest three timeline entries is intentional. The workbench is an orientation surface, not a complete activity log.
- Unknown events are ignored instead of leaking internal event names into author-facing UI.

- [ ] **Step 4: 运行测试并确认通过**

Run:

```powershell
node --test tests/app-shell/project-identity.test.mjs tests/app-shell/workbench-presentation.test.mjs
```

Expected: PASS，7 个 test。

- [ ] **Step 5: 提交**

```bash
git add src/app-shell/workbench-presentation.mjs tests/app-shell/workbench-presentation.test.mjs
git commit -m "feat(shell): derive author workbench presentation"
```

---

### Task 3: 添加稳定、可访问的作者工作台 DOM 骨架

**Files:**
- Modify: `src/app-shell/index.html:72-104`
- Modify: `tests/app-shell/app-shell-static.test.mjs`

把工作台放在 `#activity-strip` 后、现有 `#write-readiness` 前。它是有项目时的固定方向区；无项目时仍由既有“开始创作”准备卡承担首屏。不要删除 readiness 或 chapter-success 的既有 ID，因为现有验证脚本与项目首章路径已经依赖它们。

- [ ] **Step 1: 写失败静态契约测试**

Append to `tests/app-shell/app-shell-static.test.mjs`:

```js
test("index.html contains an accessible author workbench with stable test hooks", () => {
  for (const selector of [
    "id=\"project-workbench\"",
    "data-testid=\"project-workbench\"",
    "id=\"workbench-cover\"",
    "id=\"workbench-title\"",
    "id=\"workbench-seed\"",
    "id=\"workbench-progress\"",
    "id=\"workbench-primary\"",
    "id=\"workbench-read-latest\"",
    "id=\"workbench-open-chapters\"",
    "id=\"workbench-activity\"",
  ]) {
    assert.ok(indexSource.includes(selector), `missing author workbench contract: ${selector}`);
  }
  assert.match(indexSource, /id="workbench-cover"[^>]*role="img"|role="img"[^>]*id="workbench-cover"/u);
  assert.ok(indexSource.includes('id="workbench-progress-label"'));
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
node --test tests/app-shell/app-shell-static.test.mjs
```

Expected: FAIL，缺失 `project-workbench` 契约。

- [ ] **Step 3: 在静态主列中加入工作台结构**

In `src/app-shell/index.html`, insert the following immediately after:

```html
<div class="activity-strip" id="activity-strip" hidden></div>
```

Insert:

```html
<section class="project-workbench" id="project-workbench" data-testid="project-workbench" aria-labelledby="workbench-title" hidden>
  <div class="workbench-identity">
    <div class="workbench-cover" id="workbench-cover" role="img" aria-label="未命名小说的作品封面"><span id="workbench-monogram" aria-hidden="true">W</span></div>
    <div class="workbench-copy">
      <p class="eyebrow">正在创作</p>
      <h2 id="workbench-title">未命名小说</h2>
      <p class="workbench-seed peek" id="workbench-seed"></p>
      <div class="workbench-progress" id="workbench-progress" role="progressbar" aria-label="作品章节进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="0 / 0 章">
        <div class="workbench-progress-head">
          <span id="workbench-progress-label">0 / 0 章</span>
          <span id="workbench-word-count">0 字</span>
        </div>
        <div class="workbench-progress-track"><span id="workbench-progress-fill"></span></div>
      </div>
    </div>
  </div>
  <div class="workbench-actions" aria-label="当前创作操作">
    <p class="workbench-status" id="workbench-status"></p>
    <button id="workbench-primary" type="button"></button>
    <button id="workbench-read-latest" type="button" hidden>阅读最近一章</button>
    <button id="workbench-open-chapters" type="button">查看章节</button>
  </div>
  <div class="workbench-activity" id="workbench-activity" aria-label="最近创作动态"></div>
</section>
```

Keep the following existing section immediately after it unchanged for now:

```html
<section class="write-readiness" id="write-readiness" ...>
```

- [ ] **Step 4: 运行静态测试并确认通过**

Run:

```powershell
node --test tests/app-shell/app-shell-static.test.mjs
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app-shell/index.html tests/app-shell/app-shell-static.test.mjs
git commit -m "feat(shell): add author workbench markup"
```

---

### Task 4: 在唯一 dashboard 渲染路径接入工作台与项目缩略封面

**Files:**
- Modify: `src/app-shell/app.js:1-14, 18-104, 384-404, 567-600, 638-808`
- Modify: `tests/app-shell/app-shell-static.test.mjs`

工作台不能独立请求数据。只在 `renderDashboard(data)` 中调用 `deriveWorkbenchView(data)`，以保留现有 `projectScope` 代际门禁、刷新轮询和项目切换清理。项目列表缩略封面也使用同一个 `deriveProjectIdentity()`，保证左栏与主区不会出现不同主题。

- [ ] **Step 1: 写失败静态接线测试**

Append to `tests/app-shell/app-shell-static.test.mjs`:

```js
test("app.js renders the workbench from pure presentation modules", () => {
  assert.match(
    appSource,
    /import\s*\{[^}]*deriveProjectIdentity[^}]*\}\s*from\s*["']\.\/project-identity\.mjs["']/,
    "app.js should import deriveProjectIdentity"
  );
  assert.match(
    appSource,
    /import\s*\{[^}]*deriveWorkbenchView[^}]*deriveChapterCompletion[^}]*\}\s*from\s*["']\.\/workbench-presentation\.mjs["']/,
    "app.js should import workbench presentation helpers"
  );
  assert.match(appSource, /function\s+renderProjectWorkbench\s*\(/, "app.js should render the workbench in one function");
  assert.match(appSource, /renderProjectWorkbench\s*\(\s*data\s*\)/, "renderDashboard should update the workbench");
  assert.match(appSource, /deriveProjectIdentity\s*\(\s*\{\s*project\s*,\s*projectRoot:/, "project rows should reuse project identity");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
node --test tests/app-shell/app-shell-static.test.mjs
```

Expected: FAIL，缺少工作台模块导入与渲染函数。

- [ ] **Step 3: 导入模块、扩展 refs 与存储当前工作台视图**

In `src/app-shell/app.js`, add these imports after the existing `deriveWriteReadiness` import:

```js
import { deriveProjectIdentity } from "./project-identity.mjs";
import { deriveChapterCompletion, deriveWorkbenchView } from "./workbench-presentation.mjs";
```

Add these DOM refs immediately after `activityStrip` in `refs`:

```js
  projectWorkbench: document.querySelector("#project-workbench"),
  workbenchCover: document.querySelector("#workbench-cover"),
  workbenchMonogram: document.querySelector("#workbench-monogram"),
  workbenchTitle: document.querySelector("#workbench-title"),
  workbenchSeed: document.querySelector("#workbench-seed"),
  workbenchProgress: document.querySelector("#workbench-progress"),
  workbenchProgressLabel: document.querySelector("#workbench-progress-label"),
  workbenchWordCount: document.querySelector("#workbench-word-count"),
  workbenchProgressFill: document.querySelector("#workbench-progress-fill"),
  workbenchStatus: document.querySelector("#workbench-status"),
  workbenchPrimary: document.querySelector("#workbench-primary"),
  workbenchReadLatest: document.querySelector("#workbench-read-latest"),
  workbenchOpenChapters: document.querySelector("#workbench-open-chapters"),
  workbenchActivity: document.querySelector("#workbench-activity"),
```

Add one state variable beside `lastWriteReadinessView`:

```js
let lastWorkbenchView = null;
```

- [ ] **Step 4: 实现工作台渲染与活动行构建**

Insert the following helpers directly before the existing `renderWriteReadiness(data)` function:

```js
function workbenchStatusText(view) {
  const key = view.readiness.key;
  if (key === "running") return "故事正在落笔";
  if (key === "blocked") return "故事线需要你的判断";
  if (key === "completed") return "本轮章节目标已完成";
  if (key === "project_read_only") return "这部作品当前以只读方式打开";
  if (key === "missing_model" || key === "invalid_model" || key === "connection_unknown") return "完成模型准备后即可继续";
  return `下一步：第 ${view.readiness.chapterNo} 章`;
}

function renderWorkbenchActivity(entries) {
  if (!refs.workbenchActivity) return;
  const rows = entries.map((entry) => {
    const row = document.createElement("div");
    row.className = `workbench-activity-row tone-${entry.tone}`;
    row.dataset.activityKey = entry.key;
    const dot = document.createElement("span");
    dot.className = "workbench-activity-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "workbench-activity-label";
    label.textContent = entry.label;
    row.append(dot, label);
    return row;
  });
  refs.workbenchActivity.replaceChildren(...rows);
  refs.workbenchActivity.hidden = rows.length === 0;
}

function renderProjectWorkbench(data) {
  const view = deriveWorkbenchView(data);
  lastWorkbenchView = view.visible ? view : null;
  if (!refs.projectWorkbench) return;
  refs.projectWorkbench.hidden = !view.visible;
  if (!view.visible) return;

  const identity = view.identity;
  refs.projectWorkbench.dataset.projectTheme = identity.theme;
  refs.workbenchCover.dataset.projectTheme = identity.theme;
  refs.workbenchCover.setAttribute("aria-label", identity.ariaLabel);
  refs.workbenchMonogram.textContent = identity.monogram;
  refs.workbenchTitle.textContent = view.title;
  refs.workbenchSeed.textContent = view.storySeed || "这部小说还没有故事种子。";
  refs.workbenchProgress.setAttribute("aria-valuenow", String(view.progress.percent));
  refs.workbenchProgress.setAttribute("aria-valuetext", `${view.progress.completed} / ${view.progress.target} 章`);
  refs.workbenchProgressLabel.textContent = `${view.progress.completed} / ${view.progress.target} 章`;
  refs.workbenchWordCount.textContent = `${formatNumber(view.progress.totalWords)} 字`;
  refs.workbenchProgressFill.style.width = `${view.progress.percent}%`;
  refs.workbenchStatus.textContent = workbenchStatusText(view);
  refs.workbenchPrimary.textContent = view.readiness.primaryLabel;
  refs.workbenchPrimary.disabled = view.readiness.key === "running";

  refs.workbenchReadLatest.hidden = !view.latestChapter?.canOpen;
  if (view.latestChapter?.canOpen) {
    refs.workbenchReadLatest.textContent = `阅读第 ${view.latestChapter.chapterNo} 章`;
  }
  renderWorkbenchActivity(view.activity);
}
```

- [ ] **Step 5: 将工作台接入项目和无项目 renderDashboard 分支**

In the no-project branch of `renderDashboard(data)`, immediately before `renderWriteReadiness(data);`, insert:

```js
    renderProjectWorkbench(data);
```

In the project branch of `renderDashboard(data)`, immediately before `threadRenderer.syncThread(data, firstLoad);`, insert:

```js
  renderProjectWorkbench(data);
```

Do not move or duplicate `loadDashboard()`, `ensureRefreshLoop()`, `computeAgentTruth()` or `threadRenderer.syncThread()`.

- [ ] **Step 6: 将三个工作台按钮接到既有受控动作**

Immediately after the existing readiness button event bindings around `app.js:384-393`, add:

```js
if (refs.workbenchPrimary) {
  refs.workbenchPrimary.addEventListener("click", () => {
    if (lastWorkbenchView) handleReadinessAction(lastWorkbenchView.readiness);
  });
}
if (refs.workbenchReadLatest) {
  refs.workbenchReadLatest.addEventListener("click", () => {
    if (lastWorkbenchView?.latestChapter?.canOpen) {
      openReader(lastWorkbenchView.latestChapter.chapterNo);
    }
  });
}
if (refs.workbenchOpenChapters) {
  refs.workbenchOpenChapters.addEventListener("click", () => openDrawerTab("chapters"));
}
```

- [ ] **Step 7: 为左栏项目项加入同主题缩略封面**

In `renderProjectNav(project, selectedProjectRoot)`, insert immediately after `button.className = ...`:

```js
  const identity = deriveProjectIdentity({ project, projectRoot: project.projectRoot });
  const cover = document.createElement("span");
  cover.className = "proj-cover";
  cover.dataset.projectTheme = identity.theme;
  cover.setAttribute("aria-hidden", "true");
  cover.textContent = identity.monogram;
```

Replace this existing line:

```js
  button.append(dot, main);
```

with:

```js
  button.append(cover, dot, main);
```

Leave the status dot present: it remains the compact, non-textual signal for running/completed/blocked state and must not be replaced by color-only cover semantics.

- [ ] **Step 8: 运行模块与静态测试并确认通过**

Run:

```powershell
node --check src/app-shell/app.js
node --test tests/app-shell/app-shell-static.test.mjs tests/app-shell/project-identity.test.mjs tests/app-shell/workbench-presentation.test.mjs
```

Expected: PASS。若 `assertDomSelectorsExist` 报错，先检查每一个新增 `document.querySelector("#...")` 是否都有对应 HTML `id`，不得删掉检查器。

- [ ] **Step 9: 提交**

```bash
git add src/app-shell/app.js tests/app-shell/app-shell-static.test.mjs
git commit -m "feat(shell): render author workbench from dashboard"
```

---

### Task 5: 让章节完成卡使用同一真值与自然续写动作

**Files:**
- Modify: `src/app-shell/app.js:394-404, 672-702`
- Modify: `src/app-shell/thread-renderer.js:127-215`
- Modify: `tests/app-shell/workbench-presentation.test.mjs`

主工作台负责“现在要做什么”；对话流仍负责“已经发生了什么”。本任务移除对话流头部重复的封面+五项仪表盘，保留更轻的“创作记录”标题。章节成功卡改用 Task 2 的 `deriveChapterCompletion()`，确保“阅读”和“续写”都建立在 committed artifact 真值上。

- [ ] **Step 1: 扩展失败测试，锁定到达目标时不显示续写**

Append to `tests/app-shell/workbench-presentation.test.mjs`:

```js
test("deriveChapterCompletion 运行中不抢占创作工作台，且不伪造审查结果", () => {
  assert.equal(
    deriveChapterCompletion({ ...dashboard, summary: { ...dashboard.summary, projectStatus: "running" } }),
    null
  );

  const noReview = deriveChapterCompletion({ ...dashboard, review: null });
  assert.equal(noReview.reviewLabel, "");
});
```

- [ ] **Step 2: 运行测试并确认失败（如实现已满足，可将此视为确认现有纯函数行为）**

Run:

```powershell
node --test tests/app-shell/workbench-presentation.test.mjs
```

Expected: PASS after Task 2 implementation. If it fails, correct only `deriveChapterCompletion()`; do not make `app.js` repeat completion business rules.

- [ ] **Step 3: 替换 app.js 的完成卡渲染函数**

Replace the body of `renderChapterSuccess(data)` in `src/app-shell/app.js` with:

```js
function renderChapterSuccess(data) {
  const section = refs.chapterSuccess;
  if (!section) return;
  const completion = deriveChapterCompletion(data);
  if (!completion) {
    section.hidden = true;
    lastCommittedChapter = null;
    return;
  }

  lastCommittedChapter = { chapter_no: completion.chapterNo };
  section.hidden = false;
  refs.chapterSuccessTitle.textContent = `第 ${completion.chapterNo} 章已完成 · ${completion.title}`;
  refs.chapterSuccessMeta.textContent = `${formatNumber(completion.words)} 字 · ${completion.format} · 已保存到本地`;
  refs.chapterSuccessReview.textContent = completion.reviewLabel;
  refs.chapterSuccessContinue.hidden = !completion.continueVisible;
  if (completion.continueVisible) {
    refs.chapterSuccessContinue.textContent = `继续写第 ${completion.nextChapterNo} 章`;
  }
}
```

Do not read `latest.review_status` or `latest.artifact?.review_status`; those fields are not emitted by the current chapter model.

保留现有 `#chapter-success-read` 与 `#chapter-success-continue` 的事件绑定：前者继续经 `lastCommittedChapter.chapter_no` 调用 `openReader()`，后者继续调用 `composer.startCurrentChapter()`。本任务只收敛 `lastCommittedChapter` 的来源，不新增第二套点击逻辑。

- [ ] **Step 4: 将对话流会话头缩为创作记录，不删除详细运行/对话能力**

In `src/app-shell/thread-renderer.js`, import the identity helper after existing imports:

```js
import { deriveProjectIdentity } from "./project-identity.mjs";
```

删除这次替换后不再使用的 `formatCompact`、`translateReviewStatus` 导入；保留仍被线程卡片使用的工具函数。不要为了消除未使用导入而改动运行卡或消息渲染。

In `buildSessionHeadInner(data)`, replace the current cover/title/seed/stat creation block from `const summary = data.summary;` through `frag.append(stats);` with:

```js
    const summary = data.summary;
    const project = data.project;
    const identity = deriveProjectIdentity({ project, projectRoot: data.projectRoot });
    const titleRow = document.createElement("div");
    titleRow.className = "session-title session-title--trail";
    const cover = document.createElement("div");
    cover.className = "session-cover session-cover--trail";
    cover.dataset.projectTheme = identity.theme;
    cover.setAttribute("aria-hidden", "true");
    cover.textContent = identity.monogram;
    const meta = document.createElement("div");
    meta.className = "session-meta";
    const h2 = document.createElement("h2");
    h2.textContent = "创作记录";
    const seed = document.createElement("p");
    seed.className = "session-seed";
    seed.textContent = `${project.title ?? "未命名小说"} · 第 ${summary.currentChapterNo ?? 1} 章`;
    meta.append(h2, seed);
    titleRow.append(cover, meta);
    frag.append(titleRow);
```

Keep the existing recovery card block that follows. It is not duplicate decoration: it is actionable resume/retry information for interrupted and running work.

- [ ] **Step 5: 运行聚焦测试与语法检查**

Run:

```powershell
node --check src/app-shell/app.js
node --check src/app-shell/thread-renderer.js
node --test tests/app-shell/workbench-presentation.test.mjs tests/app-shell/chapter-presentation.test.mjs tests/app-shell/app-shell-static.test.mjs
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/app-shell/app.js src/app-shell/thread-renderer.js tests/app-shell/workbench-presentation.test.mjs
git commit -m "feat(shell): unify chapter completion with author workbench"
```

---

### Task 6: 实现现代编辑部 × 私人书房的视觉系统

**Files:**
- Modify: `src/app-shell/styles.css:153-305, 445-480, 2060-2234`
- Modify: `tests/app-shell/app-shell-static.test.mjs`

本任务只处理新增组件和与它们直接冲突的旧会话头样式。不要全局替换既有 `--accent`、`--green` 或所有按钮样式；这会扩大回归面并破坏正在使用的设置、抽屉和对话组件。新视觉采用局部 `data-project-theme` token。

- [ ] **Step 1: 写失败样式契约测试**

Append to `tests/app-shell/app-shell-static.test.mjs`:

```js
test("styles.css defines themed workbench, project covers, creation cards and reduced-motion fallback", async () => {
  const cssPath = path.join(here, "..", "..", "src", "app-shell", "styles.css");
  const cssSource = await fs.readFile(cssPath, "utf8");

  for (const selector of [
    ".project-workbench",
    ".workbench-cover",
    ".proj-cover",
    ".workbench-activity-row",
    ".creation-card",
    ".session-title--trail",
    "[data-project-theme=\"tide\"]",
    "[data-project-theme=\"ember\"]",
  ]) {
    assert.ok(cssSource.includes(selector), `missing visual system selector: ${selector}`);
  }
  assert.match(cssSource, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.project-workbench/u);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
node --test tests/app-shell/app-shell-static.test.mjs
```

Expected: FAIL，缺失新的工作台样式选择器。

- [ ] **Step 3: 添加局部作品主题 token 与工作台样式**

Insert this block immediately before the existing `/* Task 3: Writing readiness card */` comment in `src/app-shell/styles.css`:

```css
/* ============================================================
   作者创作工作台 · 项目身份与创作节奏
   ============================================================ */
[data-project-theme="tide"] { --project-ink: #12355b; --project-accent: #187a8d; --project-wash: #e8f4f2; --project-line: #b9ddda; }
[data-project-theme="ink"] { --project-ink: #29243d; --project-accent: #6650a4; --project-wash: #f0edf8; --project-line: #d6ccef; }
[data-project-theme="verdant"] { --project-ink: #1d4639; --project-accent: #317b58; --project-wash: #edf6ef; --project-line: #cce5d3; }
[data-project-theme="ember"] { --project-ink: #63351b; --project-accent: #b46628; --project-wash: #fbf0e6; --project-line: #edd1b7; }
[data-project-theme="violet"] { --project-ink: #492b5f; --project-accent: #8753a5; --project-wash: #f5edf8; --project-line: #e2cde9; }

.project-workbench {
  --project-ink: var(--ink-2);
  --project-accent: var(--accent);
  --project-wash: var(--accent-soft);
  --project-line: var(--accent-line);
  margin: 18px 24px 0;
  padding: 20px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 18px 28px;
  border: 1px solid var(--project-line);
  border-radius: var(--r-xl);
  background:
    radial-gradient(circle at 92% 8%, color-mix(in srgb, var(--project-wash) 84%, transparent), transparent 34%),
    linear-gradient(145deg, var(--surface), var(--surface-2));
  box-shadow: var(--shadow-xs);
}
.project-workbench[hidden] { display: none !important; }
.workbench-identity { display: flex; min-width: 0; align-items: flex-start; gap: 16px; }
.workbench-cover,
.proj-cover {
  display: grid;
  place-items: center;
  color: #fff;
  background: linear-gradient(145deg, var(--project-accent), var(--project-ink));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.22), var(--shadow-xs);
  font-family: Georgia, "Songti SC", serif;
  font-weight: 700;
}
.workbench-cover { width: 74px; height: 96px; flex: 0 0 auto; border-radius: 10px 14px 14px 10px; font-size: 30px; }
.workbench-copy { min-width: 0; display: grid; gap: 6px; }
.workbench-copy .eyebrow { font-size: 10.5px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; color: var(--project-accent); }
.workbench-copy h2 { font-size: 23px; line-height: 1.18; letter-spacing: -.025em; }
.workbench-seed { max-width: 660px; color: var(--muted); font-size: 13px; line-height: 1.55; text-wrap: pretty; }
.workbench-progress { display: grid; gap: 6px; margin-top: 5px; max-width: 520px; }
.workbench-progress-head { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-family: var(--mono); font-size: 11px; }
.workbench-progress-track { height: 5px; overflow: hidden; border-radius: 99px; background: var(--line); }
.workbench-progress-track span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--project-accent), var(--project-ink)); transition: width .28s ease; }
.workbench-actions { align-self: center; display: grid; justify-items: stretch; gap: 7px; min-width: 152px; }
.workbench-status { margin-bottom: 2px; color: var(--project-ink); font-size: 11.5px; font-weight: 650; text-align: center; }
.workbench-actions button,
.creation-card button { min-height: 35px; padding: 0 14px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); color: var(--ink-2); font-size: 12.5px; font-weight: 650; white-space: nowrap; transition: background .12s, border-color .12s, filter .12s; }
.workbench-actions button:hover,
.creation-card button:hover { background: var(--hover); border-color: #d2cdc3; }
#workbench-primary,
.creation-card .creation-primary { background: var(--btn-gradient); border-color: #000; color: #fff; box-shadow: inset 0 1px 0 rgba(255,255,255,.13); }
#workbench-primary:hover,
.creation-card .creation-primary:hover { filter: brightness(1.12); }
#workbench-primary:disabled { opacity: .55; cursor: progress; filter: none; }
.workbench-activity { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 7px 16px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, var(--project-line) 62%, var(--line)); }
.workbench-activity-row { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 11.5px; }
.workbench-activity-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ghost); }
.workbench-activity-row.tone-active { color: var(--project-accent); }
.workbench-activity-row.tone-active .workbench-activity-dot { background: var(--project-accent); box-shadow: 0 0 0 3px var(--project-wash); }
.workbench-activity-row.tone-success { color: var(--green); }
.workbench-activity-row.tone-success .workbench-activity-dot { background: var(--green); }
.workbench-activity-row.tone-warning { color: var(--amber); }
.workbench-activity-row.tone-warning .workbench-activity-dot { background: var(--amber); }

.proj { grid-template-columns: auto auto minmax(0, 1fr); }
.proj-cover { width: 24px; height: 30px; border-radius: 5px 7px 7px 5px; font-size: 12px; }
.proj-dot { margin-left: 0; }
.session-title--trail { align-items: center; }
.session-cover--trail { width: 32px; height: 40px; display: grid; place-items: center; border: none; color: #fff; background: linear-gradient(145deg, var(--project-accent), var(--project-ink)); font-family: Georgia, "Songti SC", serif; font-size: 15px; font-weight: 700; }

.creation-card { margin: 12px 24px 0; min-height: 0; padding: 16px 20px; display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--shadow-xs); }
.creation-card > div:first-child { min-width: 0; flex: 1; display: grid; gap: 6px; }
.creation-card .eyebrow { font-size: 10.5px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.creation-card h2 { font-size: 17px; font-weight: 680; letter-spacing: -.01em; }
.creation-card-actions { display: flex; flex-direction: column; flex-shrink: 0; gap: 8px; }
.creation-card[data-creation-tone="ready"] .eyebrow { color: var(--accent); }
.creation-card[data-creation-tone="success"] .eyebrow { color: var(--green); }

@media (max-width: 720px) {
  .project-workbench { grid-template-columns: 1fr; margin: 10px 14px 0; padding: 16px; gap: 14px; }
  .workbench-cover { width: 58px; height: 74px; font-size: 24px; }
  .workbench-copy h2 { font-size: 20px; }
  .workbench-actions { grid-template-columns: repeat(3, minmax(0, 1fr)); min-width: 0; }
  .workbench-status { grid-column: 1 / -1; }
  .workbench-actions button { min-width: 0; padding: 0 8px; overflow: hidden; text-overflow: ellipsis; }
  .workbench-activity { display: grid; gap: 7px; }
  .creation-card { flex-direction: column; align-items: stretch; gap: 14px; margin: 10px 14px 0; }
  .creation-card-actions { flex-direction: row; flex-wrap: wrap; }
  .creation-card-actions button { flex: 1 1 auto; min-width: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .project-workbench,
  .workbench-progress-track span { transition: none; }
}
```

- [ ] **Step 4: 将已有 readiness 与 success 容器接到统一创作节奏卡**

In `src/app-shell/index.html`:

1. Change the readiness section class from:

```html
<section class="write-readiness" id="write-readiness" ...>
```

to:

```html
<section class="write-readiness creation-card" id="write-readiness" data-creation-tone="ready" ...>
```

2. Change:

```html
<div class="write-readiness-actions">
```

to:

```html
<div class="write-readiness-actions creation-card-actions">
```

3. Add `creation-primary` to the existing primary readiness button:

```html
<button id="write-readiness-primary" class="creation-primary" type="button"></button>
```

4. Change the success section class from:

```html
<section class="chapter-success" id="chapter-success" ...>
```

to:

```html
<section class="chapter-success creation-card" id="chapter-success" data-creation-tone="success" ...>
```

5. Change:

```html
<div class="chapter-success-actions">
```

to:

```html
<div class="chapter-success-actions creation-card-actions">
```

6. Add the primary class to the reader button:

```html
<button id="chapter-success-read" class="creation-primary" type="button">阅读本章</button>
```

Then delete the old duplicated style blocks from `/* Task 3: Writing readiness card */` through the closing 720px media rule at the end of the file. Keep only the new `.creation-card` styles. Do not delete the component-specific `hidden` rules; preserve them by adding:

```css
.write-readiness[hidden],
.chapter-success[hidden] { display: none !important; }
```

immediately after the `.creation-card` rule.

- [ ] **Step 5: 保持当前 UI 可点击性防线**

Confirm the new rules do not apply `app-region: drag` to `.project-workbench`, `.workbench-actions`, `.creation-card`, or their buttons. The global no-drag selector at `styles.css:106-109` must continue to cover buttons; do not add a broad `pointer-events` overlay, fixed scrim, or pseudo-element with active pointer events over the workbench.

- [ ] **Step 6: 运行样式、语法和静态回归**

Run:

```powershell
node --check src/app-shell/app.js
node --check src/app-shell/thread-renderer.js
node --test tests/app-shell/app-shell-static.test.mjs
npm run verify:app-shell
```

Expected: PASS。若验证发现旧 `.write-readiness-actions` / `.chapter-success-actions` 仍被依赖，保留这些类作为布局钩子，但只让 `.creation-card-actions` 承担共享视觉样式。

- [ ] **Step 7: 提交**

```bash
git add src/app-shell/index.html src/app-shell/styles.css tests/app-shell/app-shell-static.test.mjs
git commit -m "style(shell): introduce author workbench visual system"
```

---

### Task 7: 扩展 app-shell 服务器验证，锁定可服务模块、MIME 与 dashboard 真值

**Files:**
- Modify: `scripts/verify-app-shell.mjs:69-88, 90-340, 342-464`

这个验证不渲染浏览器 DOM，但会创建真实项目、运行 mock 章节并通过静态服务器读取 app shell。它应证明新 `.mjs` 模块能从静态服务器以 JavaScript MIME 被读取，工作台的静态语义存在，且 dashboard 的已提交章节真值足以驱动工作台。

- [ ] **Step 1: 在 fetch 列表增加新模块**

在文件末尾、既有 `fetchText()` 旁新增以下 helper；不要只复用 `fetchText()`，因为它丢失了响应头：

```js
async function fetchJavaScriptModule(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} must return 2xx`);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/javascript(?:;|$)/iu,
    `${url} must be served as JavaScript`
  );
  return response.text();
}
```

In the `Promise.all` that currently obtains `html`, `js`, `truthJs`, `css`, etc., add these two fetches after `composerJs`:

```js
    fetchJavaScriptModule(`http://127.0.0.1:${port}/project-identity.mjs`),
    fetchJavaScriptModule(`http://127.0.0.1:${port}/workbench-presentation.mjs`),
```

Name the corresponding destructured variables `projectIdentityJs` and `workbenchPresentationJs`.

- [ ] **Step 2: 添加失败断言**

Immediately after the existing module export assertions near the top of the `try` block, add:

```js
  assert.ok(projectIdentityJs.includes("export function deriveProjectIdentity"));
  assert.ok(workbenchPresentationJs.includes("export function deriveWorkbenchView"));
  assert.ok(workbenchPresentationJs.includes("export function deriveChapterCompletion"));
```

Then, after existing main HTML assertions, add:

```js
  assert.ok(html.includes('data-testid="project-workbench"'));
  assert.ok(html.includes('id="workbench-primary"'));
  assert.ok(html.includes('id="workbench-read-latest"'));
  assert.ok(html.includes('id="workbench-activity"'));
  assert.ok(css.includes(".project-workbench"));
  assert.ok(css.includes(".proj-cover"));
  assert.ok(css.includes(".creation-card"));
```

- [ ] **Step 3: 验证 dashboard 已有真值，不新增后端字段**

After current dashboard assertions for completed chapters and reviewer status, add:

```js
  assert.equal(dashboard.project.title, "Dashboard Novel");
  assert.ok(dashboard.project.story_seed.length > 0);
  assert.equal(dashboard.summary.progressPercent, 100);
  assert.ok(dashboard.chapters.some((chapter) => chapter.artifact?.state === "committed"));
  assert.equal(dashboard.review.status, "passed");
  assert.ok(dashboard.review.reviewed_at);
```

If `dashboard.review.reviewed_at` is absent, do **not** paper over it in the frontend. First inspect `reviewer-agent.mjs` and dashboard serialization; normalize that existing timestamp to `reviewed_at` in the dashboard response with a focused server regression test, then resume this task. The workbench must not report a review date it cannot prove.

- [ ] **Step 4: 运行验证并确认通过**

Run:

```powershell
npm run verify:app-shell
```

Expected: prints its JSON `{ ok: true, ... }` output and exits 0.

- [ ] **Step 5: 提交**

```bash
git add scripts/verify-app-shell.mjs
git commit -m "test(shell): verify author workbench assets and truth"
```

---

### Task 8: 在真实 Electron 中验证作者工作台的点击路径

**Files:**
- Modify: `scripts/verify-app-clickability.cjs:72-195`

这一步是本项目的关键防线。不能只验证“代码绑定了 click”；必须使用现有 Electron 物理指针 helper 点击可见工作台按钮并观察后续 UI 状态。所有新探针使用稳定 ID 或 `data-testid`，不增加 `nth-of-type` 选择器。

- [ ] **Step 1: 先把首章 fixture 变成可验证续写的两章项目**

在 `scripts/verify-app-clickability.cjs` 的 `fcProjectRoot` fixture 中，把 `title` 改为 `"点击验收小说"`，并把 `target_chapters` 从 `1` 改为 `2`。保留完整 mock 模型字段与小字数目标；不要在首章启动前调用 `runProject()`。这样第 1 章完成后会出现真实的“继续写第 2 章”入口，且下一步的可见文本与 fixture 一致。

- [ ] **Step 2: 在首章 fixture 打开后断言工作台可见且内容真实**

在脚本现有的首章 dashboard-ready 等待之后、替换启动点击之前，加入以下实际调用；它只会在页面同时满足这些条件时通过：

```js
await waitUntil(win, `(() => {
  const workbench = document.querySelector('[data-testid="project-workbench"]');
  const title = document.querySelector('#workbench-title');
  const cover = document.querySelector('#workbench-cover');
  const primary = document.querySelector('#workbench-primary');
  return Boolean(
    workbench && !workbench.hidden &&
    title?.textContent.includes("点击验收小说") &&
    cover?.dataset.projectTheme &&
    primary?.textContent.includes("第 1 章")
  );
})()`, "首章工作台应显示真实作品与第 1 章动作", 8000);
```

`waitUntil(win, expression, ...)` 当前接收会传给 `executeJavaScript` 的**字符串表达式**，不是 JavaScript 函数；下面和后续探针都将谓词写成反引号字符串。使用它已有的超时和报错格式，不新增轮询实现。

- [ ] **Step 3: 用工作台主按钮取代该路径中对 readiness 主按钮的启动点击**

Replace only the first-chapter start click in this verification path with:

```js
await clickAndRead(win, "#workbench-primary", {
  label: "工作台开始第 1 章",
  settleMs: 300,
});
```

Keep the existing assertions that the run begins, topbar/stop state changes, and completed card eventually appears. This verifies the workbench reuses the same controlled writing path instead of creating a bypass endpoint.

- [ ] **Step 4: 验证完成后最近章节阅读入口**

After the existing `#chapter-success-read` reader check completes and closes the reader, add:

```js
await clickAndRead(win, "#workbench-read-latest", { label: "工作台阅读最近一章" });
await waitUntil(win, `document.querySelector("#reader-scrim")?.classList.contains("show")`, "工作台阅读入口应打开阅读器");
await clickAndRead(win, "#reader-close", { label: "关闭工作台打开的阅读器" });
```

- [ ] **Step 5: 验证继续下一章的真实命中和状态变化**

Before the mock fixture reaches its final target chapter, click:

```js
await clickAndRead(win, "#chapter-success-continue", { label: "继续写第 2 章", settleMs: 300 });
```

随后使用既有 `waitUntil` 等待“运行已出现”或“第 2 章已完成”之一。二者都证明点击经过了真实写作链路；不能只检查模糊的状态文案，因为 mock 运行可能快到跳过可见的运行态：

```js
await waitUntil(win, `(() => {
  const runVisible = document.querySelector('.run-stop-btn:not([hidden])') !== null;
  const completionTitle = document.querySelector("#chapter-success-title")?.textContent ?? "";
  return runVisible || completionTitle.includes("第 2 章");
})()`, "续写点击必须启动第 2 章或完成第 2 章", 8000);

await waitUntil(
  win,
  `document.querySelector("#chapter-success-title")?.textContent.includes("第 2 章") === true`,
  "第 2 章完成后必须更新完成卡",
  35000,
);
assert.equal(
  await read(win, `document.querySelector("#chapter-success-continue").hidden === true`),
  true,
  "达到两章目标后必须隐藏续写按钮",
);
```

这证明达到目标后不会再诱导用户继续生成。不得通过直接修改 DOM 或在 `executeJavaScript` 中调用内部函数伪造成功。

- [ ] **Step 6: 运行 Electron 点击验证**

Run:

```powershell
npm run verify:app-clickability
```

Expected: exits 0 with no browser console errors, no unhandled renderer exceptions, and all physical-click probes passing.

- [ ] **Step 7: 运行 required shell/desktop regression gates**

Run:

```powershell
npm run verify:app-shell
npm run verify:desktop-shell
```

Expected: all exit 0.

- [ ] **Step 8: 提交**

```bash
git add scripts/verify-app-clickability.cjs
git commit -m "test(electron): cover author workbench click paths"
```

---

### Task 9: 将使用教程改为作者能感知的工作台语言，并完成交付验证

**Files:**
- Modify: `docs/USER_GUIDE.zh-CN.md:52-146`

文档必须描述用户看得见、点得动、能验收的体验，不把“dashboard”“artifact”作为主叙述。保留必要的本地文件真实性说明。

- [ ] **Step 1: 更新“认识界面”表格**

Replace the current four-region table under `## 3. 认识界面` with:

```markdown
| 区域 | 你能做什么 |
|---|---|
| 左侧作品栏 | 新建、搜索、打开或切换自己的小说；每部小说有稳定的专属缩略封面，方便长期识别。 |
| 中央创作工作台 | 回到一本书时先看到书名、故事种子、章节进度、累计字数和当前最适合做的动作。 |
| 创作记录与指令区 | 查看智能体实际执行过的写作过程、提出要求、调整方向或继续下一章。 |
| 右侧项目面板 | 在需要时查看章节、模型、运行、资料、成本和审查；它们不会打断日常写作。 |
```

Immediately after it, add:

```markdown
作品封面是应用根据小说名、故事种子和本地项目位置生成的稳定视觉标记。它不会上传素材、不会改变小说文件，也不需要额外配置。
```

- [ ] **Step 2: 更新首次写作与完成后阅读说明**

At the start of `### 4.2 阅读准备卡`, insert this paragraph:

```markdown
创建或重新打开小说后，最上方首先是“正在创作”工作台：它显示作品身份、已完成章节 / 目标章节、累计字数和下一步主按钮。模型尚未准备好时，主按钮会带你去设置；模型可用时，它会直接显示“开始写第 N 章”。
```

At the end of `### 4.7 完成后阅读`, add:

```markdown
完成后，创作工作台会出现“阅读第 N 章”入口；它与完成卡中的“阅读本章”打开同一个应用内阅读器。两处入口都只会在最终章节文件已确认保存后出现。
```

At the end of `### 4.8 继续下一章`, add:

```markdown
如果还没达到目标章节数，完成卡会显示“继续写第 N 章”。达到目标后，该按钮会消失，避免误以为应用会在原目标之外继续生成。
```

- [ ] **Step 3: 运行完整测试**

Run:

```powershell
npm test
```

Expected: all Node tests pass.

- [ ] **Step 4: 运行交付前本地验证**

Run:

```powershell
npm run verify:local
```

Expected: exits 0. This command rebuilds the directory package and installer; after it succeeds, the desktop shortcut target at `D:\WWriting\dist-desktop\win-unpacked\WWriting Novel Agent.exe` contains the new UI.

- [ ] **Step 5: 提交**

```bash
git add docs/USER_GUIDE.zh-CN.md
git commit -m "docs: explain the author workbench flow"
```

---

## Final acceptance checklist

- [ ] 打开已有小说时，用户首先可识别作品名、稳定封面字标、故事种子、章节进度和累计字数。
- [ ] 同一项目在左侧列表、中央工作台和创作记录中使用同一 `data-project-theme`，不依赖新增后端字段。
- [ ] 无项目时，中央工作台隐藏，既有“开始创作 / 新建小说”路径仍然可用。
- [ ] 模型未配置、连接未知、运行中、阻塞、归档、目标完成等状态仍完全由 `deriveWriteReadiness()` 决定；新工作台不复制或改变其优先级。
- [ ] “开始写第 N 章”只经 `composer.startCurrentChapter()` → 既有 `/api/commands/submit` 链路启动。
- [ ] “阅读最近一章”和完成卡“阅读本章”只在 `presentChapterArtifact(...).canOpen === true` 时出现并打开现有阅读器。
- [ ] 章节成功卡显示 dashboard 的真实整体审查状态，不读取不存在的章节审查字段；达到目标章节时不再显示继续写作。
- [ ] 未知后台事件不暴露为技术术语；工作台最多展示三条已知、按时间倒序的创作动态。
- [ ] 新增按钮在真实 Electron 窗口内收到 trusted pointer click；不被 drag region、scrim 或装饰层拦截。
- [ ] `npm test`、`npm run verify:app-clickability`、`npm run verify:app-shell`、`npm run verify:desktop-shell` 和 `npm run verify:local` 全部通过。

## 自审

- **需求覆盖：** 项目视觉身份（Task 1、4、6）、回到作品后的方向感（Task 2、3、4、6）、对话与作品层级分离（Task 5）、章节完成与自然续写（Task 2、5、8）、真实点击可用性（Task 8）、用户可理解的说明（Task 9）均有明确任务。
- **边界控制：** 没有新增账户、云服务、封面上传、数据库、项目 schema、小说状态机或模型 API；主题仅由已有数据派生。
- **真值一致：** 章节可阅读性复用 `presentChapterArtifact()`；进度复用 dashboard `summary`；写作可行动作复用 `deriveWriteReadiness()`；不再次推导互相冲突的状态。
- **测试可执行：** 每个纯模块有 Node 单测，DOM 有静态契约，静态服务有 app-shell 验证，交互有真实 Electron 点击验证，交付有 `verify:local`。
- **命名一致：** `deriveProjectIdentity`、`deriveWorkbenchView`、`deriveChapterCompletion`、`renderProjectWorkbench`、`data-project-theme`、`project-workbench` 在所有任务中保持同名。
