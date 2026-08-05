// tests/project-operations/review.test.mjs —— 只读项目审查测试（统一 Agent 内核计划 Task 5）。
//
// 迁移来源（只读参考）：tests/reviewer-agent.test.mjs（已完成项目通过/篡改检测）、
// tests/deviation-check.test.mjs 的确定性部分。只断言文件证据与 findings，不运行
// 第二模型循环，不断言旧 agent_state 状态文件字段。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectRoot } from "../helpers/project-agent-harness.mjs";
import { saveContinuity } from "../../src/core/continuity-store.mjs";
import { sha256 } from "../../src/core/fs-utils.mjs";
import { countEffectiveWords } from "../../src/core/word-count.mjs";
import { parseSimpleYaml, serializeSimpleYaml } from "../../src/core/simple-yaml.mjs";
import { appendChapterSegment, commitChapter, commitChapterMemory } from "../../src/core/project-operations/chapter.mjs";
import { ReviewOperationError, reviewProject } from "../../src/core/project-operations/review.mjs";

const LONG_PROSE = `# 第一章 雨夜来信

雨下了一整夜。林深读完那封没有署名的信，手指微微发凉。信里只写了一句：老宅的钟，会在午夜敲十三下。他把信折好放进抽屉，又忍不住取出来再看一遍。窗外一声闷雷，街灯忽明忽暗。天亮之前，他决定回老宅看看。`;

async function makeProject(options = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-ops-review-"));
  const { projectRoot, project } = await createProjectRoot(workspace, options);
  return { workspace, projectRoot, project };
}

async function commitCleanChapter(projectRoot, project, chapterNo = 1) {
  await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo, segmentNo: 1, content: LONG_PROSE });
  const committed = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo });
  await commitChapterMemory({
    projectRoot,
    chapterNo,
    expectedChapterChecksum: committed.checksum,
    extraction: {
      summary: `第${chapterNo}章：主角收到警告。`,
      facts: [{ entity: "主角", attribute: "身份", value: "退伍军人", chapter_no: chapterNo, quote: "雨夜" }],
      timeline: [
        {
          chapter_no: chapterNo,
          events: ["收到警告"],
          story_time_raw: "雨夜",
          time: { kind: "scene", elapsed: null, anchor: null, confidence: "low" }
        }
      ],
      characters: [{ name: "主角", traits: ["谨慎"], status: "存活", chapter_no: chapterNo }]
    }
  });
  return committed;
}

function findingsWithCode(report, code) {
  return report.findings.filter((finding) => finding.code === code);
}

// ---------------------------------------------------------------------------
// 通过路径
// ---------------------------------------------------------------------------

test("reviewProject 对完整提交的项目返回 passed（三个 scope）", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await commitCleanChapter(projectRoot, project);
    for (const scope of ["chapter", "setting", "book"]) {
      const report = await reviewProject({ projectRoot, scope });
      assert.equal(report.status, "passed", `scope=${scope} 应通过`);
      assert.equal(report.summary.findings, 0, `scope=${scope} 不应有 findings`);
      assert.equal(report.summary.completed_chapters, 1);
      assert.equal(report.scope, scope);
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("reviewProject 拒绝非法 scope", async () => {
  const { workspace, projectRoot } = await makeProject();
  try {
    await assert.rejects(
      () => reviewProject({ projectRoot, scope: "nonsense" }),
      (error) => error instanceof ReviewOperationError && error.code === "invalid_scope"
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 章节证据（移植 reviewer-agent 确定性规则）
// ---------------------------------------------------------------------------

test("reviewProject 检测被篡改的已完成章节（字数不足 + 校验和不一致）", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await commitCleanChapter(projectRoot, project);
    await fs.writeFile(path.join(projectRoot, "chapters", "001.md"), "# Chapter 001\n\n短。", "utf8");

    const report = await reviewProject({ projectRoot, scope: "book" });
    assert.equal(report.status, "failed");
    assert.ok(findingsWithCode(report, "completed_chapter_below_min_words").length > 0);
    assert.ok(findingsWithCode(report, "chapter_checksum_mismatch").length > 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("reviewProject 检测索引字数与本地文件不一致", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await commitCleanChapter(projectRoot, project);
    const indexPath = path.join(projectRoot, "memory", "chapter_index.json");
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    index.chapters[0].actual_words += 1000;
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

    const report = await reviewProject({ projectRoot, scope: "chapter" });
    assert.equal(report.status, "warning");
    assert.ok(findingsWithCode(report, "chapter_index_word_count_mismatch").length > 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("reviewProject 检测已完成索引的正式文件缺失", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await commitCleanChapter(projectRoot, project);
    await fs.rm(path.join(projectRoot, "chapters", "001.md"));

    const report = await reviewProject({ projectRoot, scope: "book" });
    assert.equal(report.status, "failed");
    assert.ok(findingsWithCode(report, "completed_chapter_file_missing").length > 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("reviewProject 检测已完成章节缺字数门禁记录（旧数据路径）", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await commitCleanChapter(projectRoot, project);
    // 模拟旧数据：索引条目没有 quality_gate_results
    const indexPath = path.join(projectRoot, "memory", "chapter_index.json");
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    delete index.chapters[0].quality_gate_results;
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

    const report = await reviewProject({ projectRoot, scope: "chapter" });
    assert.ok(findingsWithCode(report, "completed_chapter_missing_word_gate").length > 0);

    // 用户例外（excepted）提交不算缺失
    const index2 = JSON.parse(await fs.readFile(indexPath, "utf8"));
    index2.chapters[0].quality_gate_results = [{ gate: "word-count-gate", status: "excepted" }];
    await fs.writeFile(indexPath, `${JSON.stringify(index2, null, 2)}\n`, "utf8");
    const after = await reviewProject({ projectRoot, scope: "chapter" });
    assert.equal(findingsWithCode(after, "completed_chapter_missing_word_gate").length, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("reviewProject 检测已完成章节缺章节记忆记录", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await commitCleanChapter(projectRoot, project);
    await fs.rm(path.join(projectRoot, "memory", "chapter_memory.json"));

    const report = await reviewProject({ projectRoot, scope: "chapter" });
    assert.ok(findingsWithCode(report, "completed_chapter_missing_memory").length > 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("reviewProject 检测已完成章节缺 summarizing/completed checkpoint", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await commitCleanChapter(projectRoot, project);
    await fs.rm(path.join(projectRoot, "checkpoints"), { recursive: true });

    const report = await reviewProject({ projectRoot, scope: "book" });
    assert.equal(report.status, "warning");
    assert.ok(findingsWithCode(report, "completed_chapter_missing_late_checkpoint").length > 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 设定/连续性证据（确定性）
// ---------------------------------------------------------------------------

test("reviewProject 检测 continuity 未裁决事实冲突", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await commitCleanChapter(projectRoot, project);
    const continuity = {
      schema_version: 2,
      facts: [
        {
          entity: "老宅",
          attribute: "位置",
          value: "临江市东郊",
          chapter_no: 1,
          quote: "",
          conflict_with: "第2章: 临江市西郊"
        }
      ],
      timeline: [],
      characters: []
    };
    await saveContinuity(projectRoot, continuity);

    const report = await reviewProject({ projectRoot, scope: "setting" });
    assert.equal(report.status, "warning");
    assert.ok(findingsWithCode(report, "continuity_fact_conflict").length > 0);
    assert.equal(findingsWithCode(report, "continuity_fact_conflict")[0].data.entity, "老宅");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("reviewProject 检测故事时间线矛盾", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await commitCleanChapter(projectRoot, project);
    await saveContinuity(projectRoot, {
      schema_version: 2,
      facts: [],
      timeline: [
        {
          chapter_no: 3,
          events: ["先行"],
          story_time_raw: "",
          time: { kind: "scene", elapsed: null, anchor: { type: "date", raw: "2021年3月10日", subject: null }, confidence: "high" }
        },
        {
          chapter_no: 5,
          events: ["倒退"],
          story_time_raw: "",
          time: { kind: "scene", elapsed: null, anchor: { type: "date", raw: "2021年3月5日", subject: null }, confidence: "high" }
        }
      ],
      characters: []
    });

    const report = await reviewProject({ projectRoot, scope: "setting" });
    assert.ok(findingsWithCode(report, "timeline_violation").length > 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("reviewProject 检测 blueprint_status complete 但 OUTLINE 仍是占位", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    // 直接把 project.yaml 标记 complete，OUTLINE 保持占位（模拟不一致状态）
    const yamlPath = path.join(projectRoot, "project.yaml");
    const parsed = parseSimpleYaml(await fs.readFile(yamlPath, "utf8"));
    await fs.writeFile(yamlPath, serializeSimpleYaml({ ...parsed, blueprint_status: "complete" }), "utf8");

    const report = await reviewProject({ projectRoot, scope: "book" });
    assert.ok(findingsWithCode(report, "outline_missing_for_complete_blueprint").length > 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scope 过滤与只读保证
// ---------------------------------------------------------------------------

test("reviewProject scope 过滤：chapter 不含设定检查，setting 不含章节检查", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await commitCleanChapter(projectRoot, project);
    await saveContinuity(projectRoot, {
      schema_version: 2,
      facts: [{ entity: "A", attribute: "B", value: "C", chapter_no: 1, quote: "", conflict_with: "第2章: D" }],
      timeline: [],
      characters: []
    });
    // 制造章节问题：正式文件缺失
    await fs.rm(path.join(projectRoot, "chapters", "001.md"));

    const chapterScope = await reviewProject({ projectRoot, scope: "chapter" });
    assert.ok(findingsWithCode(chapterScope, "completed_chapter_file_missing").length > 0);
    assert.equal(findingsWithCode(chapterScope, "continuity_fact_conflict").length, 0, "chapter scope 不得报设定冲突");

    const settingScope = await reviewProject({ projectRoot, scope: "setting" });
    assert.ok(findingsWithCode(settingScope, "continuity_fact_conflict").length > 0);
    assert.equal(findingsWithCode(settingScope, "completed_chapter_file_missing").length, 0, "setting scope 不得报章节问题");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("reviewProject 是只读的：不创建、不修改任何项目文件", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await commitCleanChapter(projectRoot, project);
    const runLogBefore = await fs.readFile(path.join(projectRoot, "run_log.jsonl"), "utf8");
    const dirsBefore = ["chapters", "drafts", "memory", "checkpoints", "skills"].map((dir) =>
      fs.readdir(path.join(projectRoot, dir))
    );
    const outlineBefore = await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8");

    const report = await reviewProject({ projectRoot, scope: "book" });
    assert.equal(report.status, "passed");

    assert.equal(await fs.readFile(path.join(projectRoot, "run_log.jsonl"), "utf8"), runLogBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "OUTLINE.md"), "utf8"), outlineBefore);
    const dirsAfter = await Promise.all(["chapters", "drafts", "memory", "checkpoints", "skills"].map((dir) =>
      fs.readdir(path.join(projectRoot, dir))
    ));
    for (let i = 0; i < dirsBefore.length; i += 1) {
      assert.deepEqual(dirsAfter[i], await dirsBefore[i], "审查不得增删任何文件");
    }
    assert.equal(await fs.access(path.join(projectRoot, "review")).then(() => true).catch(() => false), false, "不得写 review 报告目录");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("reviewProject 校验和比较是文件内容与索引 checksum 的比对", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await commitCleanChapter(projectRoot, project);
    // 正文被替换成另一段合规正文后，索引 checksum 也同步更新 → 不再报校验和不一致
    const newContent = `# 第一章 雨夜来信\n\n${LONG_PROSE.replace(/^# 第一章 雨夜来信\n\n/u, "")}他合上信，决定天亮前动身。`;
    await fs.writeFile(path.join(projectRoot, "chapters", "001.md"), newContent, "utf8");
    const indexPath = path.join(projectRoot, "memory", "chapter_index.json");
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    index.chapters[0].checksum = sha256(newContent);
    index.chapters[0].actual_words = countEffectiveWords(newContent);
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

    const report = await reviewProject({ projectRoot, scope: "chapter" });
    assert.equal(findingsWithCode(report, "chapter_checksum_mismatch").length, 0);
    assert.equal(findingsWithCode(report, "chapter_index_word_count_mismatch").length, 0);

    // 反过来：索引 checksum 与文件不一致时必报
    index.chapters[0].checksum = "sha256:stale";
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    const stale = await reviewProject({ projectRoot, scope: "chapter" });
    assert.ok(findingsWithCode(stale, "chapter_checksum_mismatch").length > 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
