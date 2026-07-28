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

test("deriveRecentStoryActivity 抑制已达终态章节的 project_run_started", () => {
  const view = deriveWorkbenchView({
    ...dashboard,
    events: [
      { type: "project_run_started", chapter_no: 1, timestamp: "2026-07-17T09:00:00.000Z" },
      { type: "chapter_completed", chapter_no: 1, timestamp: "2026-07-17T09:02:00.000Z" },
      { type: "project_run_finished", chapter_no: 1, timestamp: "2026-07-17T09:03:00.000Z" },
    ],
  });

  assert.deepEqual(
    view.activity.map((entry) => entry.label),
    ["第 1 章写作完成", "第 1 章已定稿"],
  );
});

test("deriveChapterCompletion 运行中不抢占创作工作台，且不伪造审查结果", () => {
  assert.equal(
    deriveChapterCompletion({ ...dashboard, summary: { ...dashboard.summary, projectStatus: "running" } }),
    null
  );

  const noReview = deriveChapterCompletion({ ...dashboard, review: null });
  assert.equal(noReview.reviewLabel, "");
});
