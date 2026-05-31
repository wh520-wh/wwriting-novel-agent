import fs from "node:fs/promises";
import path from "node:path";
import { readEvents } from "./event-log.mjs";
import { isPathInside, pathExists, readJson, safeJoin, sha256, writeJsonAtomic } from "./fs-utils.mjs";
import { loadProject } from "./project-store.mjs";
import { countEffectiveWords } from "./word-count.mjs";

export async function runReviewerAgent(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const [project, state, chapterIndex, events, checkpoints] = await Promise.all([
    loadProject(root),
    readJson(safeJoin(root, "agent_state.json"), {}),
    readJson(safeJoin(root, "memory", "chapter_index.json"), { chapters: [] }),
    readEvents(root).catch(() => []),
    readCheckpoints(root)
  ]);

  const findings = [];
  reviewProjectState({ root, project, state, chapterIndex, events, checkpoints, findings });
  await reviewChapterFiles({ root, project, chapterIndex, events, checkpoints, findings });
  reviewToolEventPaths({ root, events, findings });
  reviewBlockedState({ state, events, checkpoints, findings });

  const report = {
    schema_version: 1,
    reviewed_at: new Date().toISOString(),
    project_id: project.project_id ?? null,
    project_title: project.title ?? null,
    status: reportStatus(findings),
    summary: {
      findings: findings.length,
      p1: findings.filter((finding) => finding.severity === "P1").length,
      p2: findings.filter((finding) => finding.severity === "P2").length,
      p3: findings.filter((finding) => finding.severity === "P3").length,
      completed_chapters: (chapterIndex.chapters ?? []).filter((chapter) => chapter.status === "completed").length,
      target_chapters: Number(project.target_chapters ?? 0)
    },
    findings
  };

  if (options.writeReport) {
    const written = await writeJsonAtomic(safeJoin(root, "review", "reviewer_report.json"), report);
    report.report_path = written.path;
    report.report_checksum = written.checksum;
  }

  return report;
}

function reviewProjectState({ project, state, chapterIndex, findings }) {
  const targetChapters = Number(project.target_chapters ?? 0);
  const completedChapters = (chapterIndex.chapters ?? []).filter((chapter) => chapter.status === "completed").length;
  if (state.project_status === "completed" && targetChapters > 0 && completedChapters < targetChapters) {
    addFinding(findings, "P1", "state_completed_but_missing_chapters", "Project state is completed but chapter index is incomplete.", {
      completedChapters,
      targetChapters
    });
  }
  if (state.project_status === "completed" && state.current_stage !== "completed") {
    addFinding(findings, "P2", "completed_state_stage_mismatch", "Project status is completed but current_stage is not completed.", {
      current_stage: state.current_stage
    });
  }
}

async function reviewChapterFiles({ root, project, chapterIndex, events, checkpoints, findings }) {
  const minWords = Number(project.min_words_per_chapter ?? 0);
  for (const chapter of chapterIndex.chapters ?? []) {
    if (chapter.status !== "completed") {
      continue;
    }
    const chapterNo = chapter.chapter_no;
    if (!chapter.final_path) {
      addFinding(findings, "P1", "completed_chapter_missing_final_path", "Completed chapter has no final_path.", { chapter_no: chapterNo });
      continue;
    }
    if (!isPathInside(root, chapter.final_path)) {
      addFinding(findings, "P1", "chapter_path_escapes_project", "Completed chapter final_path escapes the project root.", {
        chapter_no: chapterNo,
        final_path: chapter.final_path
      });
      continue;
    }
    if (!(await pathExists(chapter.final_path))) {
      addFinding(findings, "P1", "completed_chapter_file_missing", "Completed chapter final file is missing.", {
        chapter_no: chapterNo,
        final_path: chapter.final_path
      });
      continue;
    }

    const content = await fs.readFile(chapter.final_path, "utf8");
    const actualWords = countEffectiveWords(content);
    if (actualWords < minWords) {
      addFinding(findings, "P1", "completed_chapter_below_min_words", "Completed chapter is below the project minimum word count.", {
        chapter_no: chapterNo,
        actual_words: actualWords,
        min_words: minWords
      });
    }
    if (Number(chapter.actual_words ?? 0) !== actualWords) {
      addFinding(findings, "P2", "chapter_index_word_count_mismatch", "Chapter index word count differs from local file count.", {
        chapter_no: chapterNo,
        indexed_words: chapter.actual_words,
        actual_words: actualWords
      });
    }
    if (chapter.checksum && chapter.checksum !== sha256(content)) {
      addFinding(findings, "P1", "chapter_checksum_mismatch", "Chapter checksum differs from the local final file.", {
        chapter_no: chapterNo,
        indexed_checksum: chapter.checksum,
        actual_checksum: sha256(content)
      });
    }
    if (!hasPassedWordGate(chapter)) {
      addFinding(findings, "P2", "completed_chapter_missing_word_gate", "Completed chapter has no passed word-count gate result.", {
        chapter_no: chapterNo
      });
    }
    if (!events.some((event) => event.type === "chapter_completed" && event.chapter_no === chapterNo)) {
      addFinding(findings, "P2", "completed_chapter_missing_event", "Completed chapter has no chapter_completed event.", {
        chapter_no: chapterNo
      });
    }
    if (!events.some((event) => event.type === "tool_call_completed" && event.chapter_no === chapterNo && event.data?.tool === "finalize_chapter_file")) {
      addFinding(findings, "P2", "completed_chapter_missing_finalize_tool_event", "Completed chapter has no finalize tool event.", {
        chapter_no: chapterNo
      });
    }
    if (!checkpoints.some((checkpoint) => checkpoint.chapter_no === chapterNo && ["summarizing", "completed"].includes(checkpoint.stage))) {
      addFinding(findings, "P3", "completed_chapter_missing_late_checkpoint", "Completed chapter has no summarizing/completed checkpoint.", {
        chapter_no: chapterNo
      });
    }
  }
}

function reviewToolEventPaths({ root, events, findings }) {
  for (const event of events) {
    const eventPath = event.data?.path;
    if (!eventPath) {
      continue;
    }
    if (!isPathInside(root, eventPath)) {
      addFinding(findings, "P1", "tool_event_path_escapes_project", "Tool event path escapes project root.", {
        event_id: event.event_id,
        type: event.type,
        path: eventPath
      });
    }
  }
}

function reviewBlockedState({ state, events, checkpoints, findings }) {
  if (state.project_status !== "blocked") {
    return;
  }
  if (!events.some((event) => event.type === "project_blocked")) {
    addFinding(findings, "P1", "blocked_state_missing_event", "Blocked project has no project_blocked event.", {
      blocked_reason: state.blocked_reason
    });
  }
  if (!checkpoints.some((checkpoint) => checkpoint.error?.code)) {
    addFinding(findings, "P1", "blocked_state_missing_error_checkpoint", "Blocked project has no error checkpoint.", {
      blocked_reason: state.blocked_reason
    });
  }
}

async function readCheckpoints(projectRoot) {
  const checkpointDir = safeJoin(projectRoot, "checkpoints");
  if (!(await pathExists(checkpointDir))) {
    return [];
  }
  const files = await fs.readdir(checkpointDir);
  const checkpoints = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    checkpoints.push(await readJson(safeJoin(checkpointDir, file), {}));
  }
  return checkpoints;
}

function hasPassedWordGate(chapter) {
  return (chapter.quality_gate_results ?? []).some((result) => result.gate === "word-count-gate" && result.status === "passed");
}

function addFinding(findings, severity, code, message, data = {}) {
  findings.push({ severity, code, message, data });
}

function reportStatus(findings) {
  if (findings.some((finding) => finding.severity === "P1")) {
    return "failed";
  }
  if (findings.length > 0) {
    return "warning";
  }
  return "passed";
}
