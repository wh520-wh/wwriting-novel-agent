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

const TERMINAL_EVENT_TYPES = new Set([
  "chapter_completed",
  "project_run_finished",
  "project_run_failed",
]);

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
  const list = Array.isArray(events) ? events : [];

  // Chapters that have reached a terminal state. A non-terminal
  // `project_run_started` for such a chapter is suppressed: the workbench is an
  // orientation surface, not a complete activity log, so a finished/failed
  // chapter should not also show its earlier "started" entry. Events without a
  // chapter_no (e.g. project_created) are never suppressed.
  const terminalChapters = new Set();
  for (const event of list) {
    if (event?.type && TERMINAL_EVENT_TYPES.has(event.type)) {
      const chapterNo = asFiniteInteger(event.chapter_no);
      if (chapterNo) terminalChapters.add(chapterNo);
    }
  }

  return list
    .map((event, index) => ({ event, index, time: Date.parse(event?.timestamp ?? "") }))
    .filter(({ event }) => Object.hasOwn(ACTIVITY_COPY, event?.type))
    .filter(({ event }) => {
      if (event?.type !== "project_run_started") return true;
      const chapterNo = asFiniteInteger(event.chapter_no);
      return chapterNo === 0 ? true : !terminalChapters.has(chapterNo);
    })
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
