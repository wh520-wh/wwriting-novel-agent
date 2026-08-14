// tests/project-operations/chapter.test.mjs —— 章节项目事务测试（统一 Agent 内核计划 Task 5）。
//
// 迁移来源（只读参考，不复制实现断言）：tests/tool-runtime.test.mjs（segment 幂等、
// 非正文拒绝、abort）、tests/agent-engine.test.mjs（字数门禁、post-process 技能钩子、
// 已提交文件恢复只修索引、timeline 过滤、记忆提取/水位、pending-extraction 恢复）。
// 全部通过 project operations 公共接口断言可观察行为；不断言旧 agent_state 状态
// 文件或内部 stage 函数。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectRoot, LEGACY_STATE_FILE } from "../helpers/project-agent-harness.mjs";
import { loadChapterIndex, loadProject, upsertChapter } from "../../src/core/project-store.mjs";
import { loadChapterMemory } from "../../src/core/chapter-memory.mjs";
import { loadContinuity, loadContinuityState, saveContinuity } from "../../src/core/continuity-store.mjs";
import { parseSimpleYaml, serializeSimpleYaml } from "../../src/core/simple-yaml.mjs";
import { sha256 } from "../../src/core/fs-utils.mjs";
import { countEffectiveWords } from "../../src/core/word-count.mjs";
import {
  appendChapterSegment,
  chapterFinalPath,
  commitChapter as rawCommitChapter,
  commitChapterMemory,
  finalizeChapter,
  inspectChapterContext,
  rollbackChapter,
  ProjectOperationError
} from "../../src/core/project-operations/chapter.mjs";
import { listChapterVersions, migrateBaselineVersions, readChapterVersion } from "../../src/core/project-operations/versions.mjs";

// Task 10：commitChapter 不再消费技能注入（确定性技能钩子已删除），直接使用原函数。
// 写探针 options（hooks.beforeWrite）仍由调用点显式传入。
const commitChapter = rawCommitChapter;

// LONG_PROSE 是普通合格章节正文（Task 10 起无任何技能 checker，提交即成功）。
const LONG_PROSE = `# 第一章 雨夜来信

雨夜，雨声突然变大。林深猛地推开门，冲进老宅的客厅。他浑身湿透，抹了一把脸，低声道：“信上说，老宅的钟会在午夜敲十三下。”烛光下，墙上的照片里竟是多年不见的父亲。他正要细看，门外却传来一阵急促的敲门声。`;

async function makeProject(options = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-ops-chapter-"));
  const { projectRoot, project } = await createProjectRoot(workspace, options);
  return { workspace, projectRoot, project };
}

async function readRunLog(projectRoot) {
  return fs.readFile(path.join(projectRoot, "run_log.jsonl"), "utf8");
}

// 注入写探针：第 n 次事务写入失败（在写入前抛错，触发回滚 catch 分支）
function failOnWrite(n) {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === n) {
      const error = new Error(`注入写入失败（第 ${n} 次）`);
      error.code = "EIO";
      throw error;
    }
  };
}

async function writeProjectYamlWith(projectRoot, patch) {
  const source = await fs.readFile(path.join(projectRoot, "project.yaml"), "utf8");
  await fs.writeFile(
    path.join(projectRoot, "project.yaml"),
    serializeSimpleYaml({ ...parseSimpleYaml(source), ...patch }),
    "utf8"
  );
}

async function checkpointFiles(projectRoot) {
  return (await fs.readdir(path.join(projectRoot, "checkpoints"))).filter((name) => name.endsWith(".json"));
}

// ---------------------------------------------------------------------------
// appendChapterSegment：幂等、非正文拒绝、输入校验、abort
// ---------------------------------------------------------------------------

test("appendChapterSegment 每段只写入一次（重复段号幂等）", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const first = await appendChapterSegment({
      projectRoot,
      projectId: project.project_id,
      chapterNo: 1,
      segmentNo: 1,
      content: "雨夜里他收到信，线索在掌心发烫。"
    });
    const second = await appendChapterSegment({
      projectRoot,
      projectId: project.project_id,
      chapterNo: 1,
      segmentNo: 1,
      content: "这段不应该重复写入。"
    });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    const file = await fs.readFile(first.path, "utf8");
    assert.equal((file.match(/segment:1/gu) ?? []).length, 1);
    // 草稿路径已进章节索引（只读工具可解析）
    const index = await loadChapterIndex(projectRoot);
    assert.equal(index.chapters[0].draft_path, first.path);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("appendChapterSegment 拒绝疑似模型推理/工具报错的非正文内容且不落盘", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const pollutedContent = `The read_chapter tool is not allowed right now. It seems the only allowed tool for this step is append_chapter_segment.`;
    await assert.rejects(
      () =>
        appendChapterSegment({
          projectRoot,
          projectId: project.project_id,
          chapterNo: 1,
          segmentNo: 1,
          content: pollutedContent
        }),
      (error) => error instanceof ProjectOperationError && error.code === "non_prose_content"
    );
    await assert.rejects(
      () => fs.stat(path.join(projectRoot, "drafts", "001.draft.md")),
      (error) => error.code === "ENOENT"
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("appendChapterSegment 非正文模式检测（不含工具名的英文自述）", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    // 不命中工具名列表，命中 NON_PROSE_PATTERNS（工具拒绝自述模式）
    const patternOnly = `The tool is not allowed right now. I should wait for the next step.`;
    await assert.rejects(
      () =>
        appendChapterSegment({
          projectRoot,
          projectId: project.project_id,
          chapterNo: 1,
          segmentNo: 1,
          content: patternOnly
        }),
      (error) => error instanceof ProjectOperationError && error.code === "non_prose_content"
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("appendChapterSegment 单词边界：含 shell 的正当英文正文不被误拒", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    // "shell" 是纯英文单词，已从工具名清单剔除（词边界下裸 includes 会误伤正文）
    const proseWithShell = `The soldier ducked as the shell whistled overhead. 他侧身躲过，尘土落进衣领。`;
    const result = await appendChapterSegment({
      projectRoot,
      projectId: project.project_id,
      chapterNo: 1,
      segmentNo: 1,
      content: proseWithShell
    });
    assert.equal(result.duplicate, false);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("appendChapterSegment 拒绝非法输入", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const base = {
      projectRoot,
      projectId: project.project_id,
      chapterNo: 1,
      segmentNo: 1,
      content: "正文内容。"
    };
    await assert.rejects(
      () => appendChapterSegment({ ...base, projectId: "wrong-project" }),
      (error) => error instanceof ProjectOperationError && error.code === "invalid_project_id"
    );
    await assert.rejects(
      () => appendChapterSegment({ ...base, content: "   " }),
      (error) => error instanceof ProjectOperationError && error.code === "empty_content"
    );
    await assert.rejects(
      () => appendChapterSegment({ ...base, segmentNo: 0 }),
      (error) => error instanceof ProjectOperationError && error.code === "invalid_segment_no"
    );
    await assert.rejects(
      () => appendChapterSegment({ ...base, chapterNo: 1.5 }),
      (error) => error instanceof ProjectOperationError && error.code === "invalid_chapter_no"
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("appendChapterSegment 尊重预中止的 AbortSignal，不落盘", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const controller = new AbortController();
    controller.abort("用户停止");
    await assert.rejects(
      () =>
        appendChapterSegment({
          projectRoot,
          projectId: project.project_id,
          chapterNo: 1,
          segmentNo: 1,
          content: "正文内容。",
          signal: controller.signal
        }),
      (error) => error.name === "ProjectCancelledError"
    );
    await assert.rejects(
      () => fs.stat(path.join(projectRoot, "drafts", "001.draft.md")),
      (error) => error.code === "ENOENT"
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("appendChapterSegment 草稿写失败时索引不残留 draft_path", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await assert.rejects(
      () =>
        appendChapterSegment(
          { projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: "正文内容。" },
          { hooks: { beforeWrite: failOnWrite(1) } }
        ),
      /注入写入失败/u
    );
    // 草稿未落盘，索引不得出现指向不存在草稿的条目
    await assert.rejects(() => fs.stat(path.join(projectRoot, "drafts", "001.draft.md")), (error) => error.code === "ENOENT");
    assert.equal((await loadChapterIndex(projectRoot)).chapters.length, 0, "索引不得残留 draft_path");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("appendChapterSegment 索引更新失败时还原草稿（新章节删除新建文件）", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    // 第 1 次写（草稿）成功、第 2 次写（索引）失败 → 新建草稿被删除
    await assert.rejects(
      () =>
        appendChapterSegment(
          { projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: "第一段正文。" },
          { hooks: { beforeWrite: failOnWrite(2) } }
        ),
      /注入写入失败/u
    );
    await assert.rejects(() => fs.stat(path.join(projectRoot, "drafts", "001.draft.md")), (error) => error.code === "ENOENT");
    assert.equal((await loadChapterIndex(projectRoot)).chapters.length, 0, "索引不得残留条目");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("appendChapterSegment 索引更新失败时还原草稿（已有草稿还原先前字节）", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: "第一段正文。" });
    const draftPath = path.join(projectRoot, "drafts", "001.draft.md");
    const draftBefore = await fs.readFile(draftPath, "utf8");

    // 追加第 2 段：草稿写入成功、索引更新失败 → 草稿还原到第 1 段内容
    await assert.rejects(
      () =>
        appendChapterSegment(
          { projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 2, content: "第二段正文。" },
          { hooks: { beforeWrite: failOnWrite(2) } }
        ),
      /注入写入失败/u
    );
    assert.equal(await fs.readFile(draftPath, "utf8"), draftBefore, "草稿必须还原先前字节");
    assert.ok(!draftBefore.includes("第二段正文"), "还原后不得残留第 2 段");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// commitChapter：正式提交四件套（正式文件/索引/记忆/checkpoint）+ run_log
// ---------------------------------------------------------------------------

test("commitChapter 不以字数、标题或技能 checker 拒绝提交", async () => {
  const { workspace, projectRoot, project } = await makeProject({ min_words_per_chapter: 3000 });
  try {
    await appendChapterSegment({
      projectRoot,
      projectId: project.project_id,
      chapterNo: 1,
      segmentNo: 1,
      content: "他推开门。"
    });
    const result = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    assert.equal(result.ok, true);
    // actual_words 是 countEffectiveWords(commitContent) 的客观记录：正文 4 字 +
    // 草稿头 "# Chapter 001" 的有效 token，由真实落盘内容计算，不决定能否提交。
    const finalContent = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
    assert.equal(result.actual_words, countEffectiveWords(finalContent));
    assert.ok(result.actual_words >= 4, "短章节也客观记录真实字数");
    assert.deepEqual(result.quality_gate_results, []);
    // 索引同样只记录空门禁结果，正式文件与记忆正常落盘
    const entry = (await loadChapterIndex(projectRoot)).chapters.find((c) => c.chapter_no === 1);
    assert.deepEqual(entry.quality_gate_results, []);
    assert.ok((await loadChapterMemory(projectRoot)).chapters.some((c) => c.chapter_no === 1));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 一致更新正式文件、索引、章节记忆、checkpoint 与 run_log", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    const result = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });

    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.ok(result.actual_words >= 50, "应记录真实字数");
    assert.ok(result.checksum.startsWith("sha256:"));

    // 正式文件
    const finalPath = path.join(projectRoot, "chapters", "001.md");
    const finalContent = await fs.readFile(finalPath, "utf8");
    assert.ok(finalContent.includes("雨夜来信"));

    // 章节索引：final_path / actual_words / checksum / chapter_no
    const entry = (await loadChapterIndex(projectRoot)).chapters.find((c) => c.chapter_no === 1);
    assert.ok(entry);
    assert.equal(entry.status, "completed");
    assert.ok(String(entry.final_path).replaceAll("\\", "/").endsWith("chapters/001.md"));
    assert.ok(Number(entry.actual_words) >= 50);
    assert.equal(entry.checksum, result.checksum);
    assert.equal(entry.checksum, sha256(finalContent));

    // 章节记忆
    const memory = await loadChapterMemory(projectRoot);
    assert.ok(memory.chapters.some((c) => c.chapter_no === 1));

    // checkpoint（checkpoints/ 下出现正式 checkpoint 文件）
    const checkpoints = await checkpointFiles(projectRoot);
    assert.equal(checkpoints.length, 1);
    const checkpoint = JSON.parse(await fs.readFile(path.join(projectRoot, "checkpoints", checkpoints[0]), "utf8"));
    assert.equal(checkpoint.artifact_commit.chapter_no, 1);
    assert.equal(checkpoint.artifact_commit.checksum, result.checksum);
    assert.equal(result.checkpoint_id, checkpoints[0].replace(".json", ""));

    // run_log 领域事实
    assert.match(await readRunLog(projectRoot), /chapter_completed/u);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 支持 txt 输出格式的章节文件", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await writeProjectYamlWith(projectRoot, { output_format: "txt" });
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    const result = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    assert.ok(result.path.endsWith("001.txt"));
    await fs.readFile(path.join(projectRoot, "chapters", "001.txt"), "utf8");
    assert.ok(!(await fs.access(path.join(projectRoot, "chapters", "001.md")).then(() => true).catch(() => false)));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 短章节直接提交：字数不足不拒绝，无半写状态残留", async () => {
  const { workspace, projectRoot, project } = await makeProject({ min_words_per_chapter: 3000 });
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: "短。" });
    const result = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.quality_gate_results, []);
    // 正式文件落盘、索引 completed、记忆与 checkpoint 齐备、run_log 记录领域事实
    assert.ok((await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8")).includes("短。"));
    assert.equal((await loadChapterIndex(projectRoot)).chapters[0].status, "completed");
    assert.ok((await loadChapterMemory(projectRoot)).chapters.length >= 1);
    assert.equal((await checkpointFiles(projectRoot)).length, 1);
    assert.match(await readRunLog(projectRoot), /chapter_completed/u);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 标题格式不同不拒绝：串章标题同样提交", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const wrongTitle = `# 第二章 别人的章节\n\n${LONG_PROSE.replace(/^# 第一章 雨夜来信\n\n/u, "")}`;
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: wrongTitle });
    const result = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.actual_words >= 50, true);
    const entry = (await loadChapterIndex(projectRoot)).chapters.find((c) => c.chapter_no === 1);
    assert.equal(entry.status, "completed");
    assert.deepEqual(entry.quality_gate_results, []);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 技能 checker 不再生效：平缓结尾正文直接提交", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    // 旧模型下会触发 suspense-ending 技能门禁的正文；Task 10 起不再检查。
    const flatProse = `# 第一章 平静的早晨

林深猛然从床上坐起来，压低声音：“门外有人，脚步声很急，不太对劲。”他披上外套走到窗边，看着雨中的街道。天亮时，他数了数门口留下的脚印，不多不少，正好两行。什么都没有发生。`;
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: flatProse });
    const result = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    assert.equal(result.ok, true);
    const entry = (await loadChapterIndex(projectRoot)).chapters.find((c) => c.chapter_no === 1);
    assert.equal(entry.status, "completed");
    assert.deepEqual(entry.quality_gate_results, []);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 校验 expectedDraftChecksum，漂移草稿拒绝提交", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    await assert.rejects(
      () => commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1, expectedDraftChecksum: "sha256:wrong" }),
      (error) => error instanceof ProjectOperationError && error.code === "draft_checksum_mismatch"
    );
    await assert.rejects(() => fs.stat(path.join(projectRoot, "chapters", "001.md")), (error) => error.code === "ENOENT");
    // 正确校验和提交成功
    const draft = await fs.readFile(path.join(projectRoot, "drafts", "001.draft.md"), "utf8");
    const result = await commitChapter({
      projectRoot,
      projectId: project.project_id,
      chapterNo: 1,
      expectedDraftChecksum: sha256(draft)
    });
    assert.equal(result.ok, true);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 纯重复提交零写入（幂等）", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    const first = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    const finalPath = path.join(projectRoot, "chapters", "001.md");
    const contentBefore = await fs.readFile(finalPath, "utf8");
    const indexBefore = JSON.stringify(await loadChapterIndex(projectRoot));

    const second = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    assert.equal(second.duplicate, true);
    assert.equal(second.checkpoint_id, null);
    assert.equal(await fs.readFile(finalPath, "utf8"), contentBefore, "重复提交不得改写正式文件内容");
    assert.equal(JSON.stringify(await loadChapterIndex(projectRoot)), indexBefore, "重复提交不得改写索引");
    assert.equal((await checkpointFiles(projectRoot)).length, 1, "重复提交不得新增 checkpoint");
    assert.equal((await readRunLog(projectRoot)).split("\n").filter(Boolean).length, 1, "重复提交不得新增 run_log 事件");
    assert.equal(first.checksum, second.checksum);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 中断恢复：final 已落盘但索引未完成时只修索引不重写文件", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    const draftPath = path.join(projectRoot, "drafts", "001.draft.md");
    const finalPath = path.join(projectRoot, "chapters", "001.md");
    await fs.copyFile(draftPath, finalPath);
    const index = await loadChapterIndex(projectRoot);
    index.chapters[0].status = "finalizing";
    index.chapters[0].final_path = finalPath;
    index.chapters[0].checksum = null;
    await fs.writeFile(path.join(projectRoot, "memory", "chapter_index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");

    const finalBefore = await fs.readFile(finalPath, "utf8");
    const result = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    assert.equal(result.repairing, true);
    assert.equal(await fs.readFile(finalPath, "utf8"), finalBefore, "恢复路径不得重写正式文件内容");
    const entry = (await loadChapterIndex(projectRoot)).chapters[0];
    assert.equal(entry.status, "completed");
    assert.ok(entry.checksum);
    // 记忆与 checkpoint 补齐
    assert.ok((await loadChapterMemory(projectRoot)).chapters.some((c) => c.chapter_no === 1));
    assert.equal((await checkpointFiles(projectRoot)).length, 1);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 不再执行 post-process 技能钩子：hooks 元数据保持惰性", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const skillDir = path.join(projectRoot, "skills", "post-note");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "skill.json"),
      `${JSON.stringify(
        {
          name: "post-note",
          version: "1.0.0",
          type: "post-process",
          enabled: true,
          priority: 40,
          scope: "chapter",
          hooks: [{ stage: "post_process", action: "post_process", content: "Post-process marker." }]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    const result = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    assert.equal(result.ok, true);
    const chapter = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
    assert.ok(!chapter.includes("Post-process marker."), "post-process 钩子不得改写正式文件");
    assert.equal(result.skill_hooks, undefined, "提交结果不再报告技能钩子");
    const checkpoints = await checkpointFiles(projectRoot);
    const checkpoint = JSON.parse(await fs.readFile(path.join(projectRoot, "checkpoints", checkpoints[0]), "utf8"));
    assert.equal(checkpoint.skill_hooks, undefined, "checkpoint 不再记录技能钩子");
    assert.deepEqual(checkpoint.quality_gate_results, []);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 校验 project_id", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    await assert.rejects(
      () => commitChapter({ projectRoot, projectId: "wrong-project", chapterNo: 1 }),
      (error) => error instanceof ProjectOperationError && error.code === "invalid_project_id"
    );
    await assert.rejects(() => fs.stat(path.join(projectRoot, "chapters", "001.md")), (error) => error.code === "ENOENT");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 写入期失败回滚：无半写状态（章节记忆写失败）", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    const memoryBefore = await fs.readFile(path.join(projectRoot, "memory", "chapter_memory.json"), "utf8");
    const indexBefore = await fs.readFile(path.join(projectRoot, "memory", "chapter_index.json"), "utf8");
    const draftBefore = await fs.readFile(path.join(projectRoot, "drafts", "001.draft.md"), "utf8");
    const runLogBefore = await fs.readFile(path.join(projectRoot, "run_log.jsonl"), "utf8");

    // 事务写入顺序：final(1) → chapter_memory(2) → chapter_index(3) → checkpoint(4) → run_log(5)
    await assert.rejects(
      () =>
        commitChapter(
          { projectRoot, projectId: project.project_id, chapterNo: 1 },
          { hooks: { beforeWrite: failOnWrite(2) } }
        ),
      /注入写入失败/u
    );

    // 正式文件被删除（提交前不存在）、记忆/索引/草稿/run_log 恢复先前字节、无 checkpoint
    await assert.rejects(() => fs.stat(path.join(projectRoot, "chapters", "001.md")), (error) => error.code === "ENOENT");
    assert.equal(await fs.readFile(path.join(projectRoot, "memory", "chapter_memory.json"), "utf8"), memoryBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "memory", "chapter_index.json"), "utf8"), indexBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "drafts", "001.draft.md"), "utf8"), draftBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "run_log.jsonl"), "utf8"), runLogBefore);
    assert.equal((await checkpointFiles(projectRoot)).length, 0, "回滚后不得残留 checkpoint");
    assert.equal((await loadChapterIndex(projectRoot)).chapters[0].status, "queued", "索引保持提交前状态");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 第 1 次写失败：回滚干净且无误导性 ENOENT 警告", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    const memoryBefore = await fs.readFile(path.join(projectRoot, "memory", "chapter_memory.json"), "utf8");
    const indexBefore = await fs.readFile(path.join(projectRoot, "memory", "chapter_index.json"), "utf8");
    const runLogBefore = await fs.readFile(path.join(projectRoot, "run_log.jsonl"), "utf8");

    let caught = null;
    try {
      await commitChapter(
        { projectRoot, projectId: project.project_id, chapterNo: 1 },
        { hooks: { beforeWrite: failOnWrite(1) } }
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught && /注入写入失败/u.test(caught.message));
    // 正式文件从未创建：回滚 unlink 得到 ENOENT 不得被当作回滚失败上报
    assert.equal(caught.rollbackWarnings, undefined, "未创建文件的回滚不得产生 ENOENT 噪音");

    // 零写入：final 未创建、记忆/索引/run_log 未动、无 checkpoint
    await assert.rejects(() => fs.stat(path.join(projectRoot, "chapters", "001.md")), (error) => error.code === "ENOENT");
    assert.equal(await fs.readFile(path.join(projectRoot, "memory", "chapter_memory.json"), "utf8"), memoryBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "memory", "chapter_index.json"), "utf8"), indexBefore);
    assert.equal(await fs.readFile(path.join(projectRoot, "run_log.jsonl"), "utf8"), runLogBefore);
    assert.equal((await checkpointFiles(projectRoot)).length, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// finalizeChapter：编辑后重新入账，账本与文件一致；未提交章节拒绝（Task C3）
// ---------------------------------------------------------------------------

test("finalizeChapter：编辑后重新入账，账本与文件一致；未提交章节拒绝", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    const commit = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    assert.equal(commit.ok, true);

    const finalPath = chapterFinalPath(projectRoot, 1, project.output_format);
    await fs.writeFile(finalPath, "修订后的正文：主角在雨夜出发。", "utf8");
    const result = await finalizeChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.actual_words, countEffectiveWords("修订后的正文：主角在雨夜出发。"));
    assert.ok(result.checksum.startsWith("sha256:"));
    assert.ok(typeof result.checkpoint_id === "string" && result.checkpoint_id.length > 0);
    const index = await loadChapterIndex(projectRoot);
    const entry = index.chapters.find((c) => Number(c.chapter_no) === 1);
    assert.equal(entry.checksum, result.checksum, "索引校验和必须与文件一致");
    assert.equal(entry.actual_words, result.actual_words);
    // run_log 记录 chapter_revised 领域事件
    assert.match(await readRunLog(projectRoot), /chapter_revised/u);

    // 未提交章节拒绝
    await assert.rejects(
      () => finalizeChapter({ projectRoot, projectId: project.project_id, chapterNo: 2 }),
      (error) => error instanceof ProjectOperationError && error.code === "chapter_not_committed"
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("finalizeChapter：expected_checksum 过期拒绝；非散文内容拒绝", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    const finalPath = chapterFinalPath(projectRoot, 1, project.output_format);
    const before = await fs.readFile(finalPath, "utf8");
    await fs.writeFile(finalPath, "v2 正文", "utf8");
    await assert.rejects(
      () =>
        finalizeChapter({
          projectRoot,
          projectId: project.project_id,
          chapterNo: 1,
          expectedChecksum: sha256(before)
        }),
      (error) => error instanceof ProjectOperationError && error.code === "stale_checksum"
    );
    await fs.writeFile(finalPath, "正文里混入了 read_file 工具名", "utf8");
    await assert.rejects(
      () =>
        finalizeChapter({
          projectRoot,
          projectId: project.project_id,
          chapterNo: 1
        }),
      (error) => error instanceof ProjectOperationError && error.code === "non_prose_content"
    );
    // 拒绝入账不落盘 checkpoint
    assert.equal((await checkpointFiles(projectRoot)).length, 1, "拒绝入账不得新增 checkpoint");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("finalizeChapter：写入中途失败按事务回滚（探针），不留下半写状态", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    const finalPath = chapterFinalPath(projectRoot, 1, project.output_format);
    const indexBefore = await fs.readFile(path.join(projectRoot, "memory", "chapter_index.json"), "utf8");
    const memoryBefore = await fs.readFile(path.join(projectRoot, "memory", "chapter_memory.json"), "utf8");
    const runLogBefore = await readRunLog(projectRoot);
    await fs.writeFile(finalPath, "修订正文 v2", "utf8");
    // 探针：在 checkpoint 写入前抛错，模拟该次写入失败 → 全部已写文件回滚
    let fired = false;
    await assert.rejects(
      () =>
        finalizeChapter(
          { projectRoot, projectId: project.project_id, chapterNo: 1 },
          {
            hooks: {
              beforeWrite: ({ kind }) => {
                if (kind === "checkpoint" && !fired) {
                  fired = true;
                  throw new Error("injected write failure");
                }
              }
            }
          }
        ),
      (error) => error.message === "injected write failure"
    );
    assert.equal(await fs.readFile(path.join(projectRoot, "memory", "chapter_index.json"), "utf8"), indexBefore, "索引必须回滚到原状");
    assert.equal(await fs.readFile(path.join(projectRoot, "memory", "chapter_memory.json"), "utf8"), memoryBefore, "章节记忆必须回滚到原状");
    assert.equal(await readRunLog(projectRoot), runLogBefore, "run_log 必须回滚到原状");
    assert.equal((await checkpointFiles(projectRoot)).length, 1, "失败入账不得新增 checkpoint");
    const index = await loadChapterIndex(projectRoot);
    const entry = index.chapters.find((c) => Number(c.chapter_no) === 1);
    assert.notEqual(entry.checksum, sha256("修订正文 v2"), "索引不得记录未完成入账的校验和");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 14：commitChapter 与派生记忆（book_summary/continuity）的事务边界。
// 正式章节与索引是权威提交事实；全书摘要、continuity 与 WWRITING.md 均不是
// commit 的写入目标，派生提取独立可失败/重试。
// ---------------------------------------------------------------------------

test("commitChapter 确定性事务不触碰全书摘要、连续性与 WWRITING.md", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const wwritingPath = path.join(projectRoot, "WWRITING.md");
    const wwritingBefore = "# WWriting 项目记忆\n\n- 项目：验收测试小说\n- 阶段：第一章\n";
    await fs.writeFile(wwritingPath, wwritingBefore, "utf8");
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    const summaryBefore = await fs.readFile(path.join(projectRoot, "memory", "book_summary.md"), "utf8");

    const result = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    assert.equal(result.ok, true);
    assert.equal("memory_update" in result, false, "memory_update 标记是 runtime 触发层的职责，commitChapter 不得内联派生提取");

    // 派生数据不被 commit 改写
    assert.equal(await fs.readFile(path.join(projectRoot, "memory", "book_summary.md"), "utf8"), summaryBefore, "commit 不得改写全书摘要");
    assert.equal((await loadContinuity(projectRoot)).facts.length, 0, "commit 不得写入 continuity 事实");
    assert.equal((await loadContinuityState(projectRoot)).extracted_chapters.length, 0, "commit 不得推进记忆水位");
    // WWRITING.md 不被章节摘要自动污染
    assert.equal(await fs.readFile(wwritingPath, "utf8"), wwritingBefore, "WWRITING.md 不得被 commit 改写");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 成功后派生记忆失败不影响已提交正文与索引：独立重试可重建", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    const committed = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    const finalPath = path.join(projectRoot, "chapters", "001.md");
    const finalBefore = await fs.readFile(finalPath, "utf8");
    const indexBefore = await fs.readFile(path.join(projectRoot, "memory", "chapter_index.json"), "utf8");

    // 独立记忆合并失败（校验和漂移）只拒绝派生落盘，正文与索引保持提交状态
    await assert.rejects(
      () => commitChapterMemory({ projectRoot, chapterNo: 1, expectedChapterChecksum: "sha256:wrong", extraction: extractionFixture() }),
      (error) => error instanceof ProjectOperationError && error.code === "chapter_checksum_mismatch"
    );
    assert.equal(await fs.readFile(finalPath, "utf8"), finalBefore, "正文不得因记忆失败回滚");
    assert.equal(await fs.readFile(path.join(projectRoot, "memory", "chapter_index.json"), "utf8"), indexBefore, "索引不得因记忆失败回滚");

    // 维护重试（正确校验和 + 提取数据）可重建派生记忆
    const retried = await commitChapterMemory({
      projectRoot,
      chapterNo: 1,
      expectedChapterChecksum: committed.checksum,
      extraction: extractionFixture()
    });
    assert.equal(retried.ok, true);
    assert.equal(retried.facts_added, 1);
    assert.match(await fs.readFile(path.join(projectRoot, "memory", "book_summary.md"), "utf8"), /雨夜收到警告/u);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// commitChapterMemory：合并提取、水位、pending 恢复、校验和、timeline 门禁
// ---------------------------------------------------------------------------

function extractionFixture() {
  return {
    summary: "第一章：主角在雨夜收到警告。",
    facts: [{ entity: "主角", attribute: "身份", value: "退伍军人", chapter_no: 1, quote: "雨夜" }],
    timeline: [{ chapter_no: 1, story_time: "雨夜", events: ["收到警告"], time: { kind: "scene", elapsed: null, anchor: null, confidence: "low" } }],
    characters: [{ name: "主角", traits: ["谨慎"], status: "存活", chapter_no: 1 }]
  };
}

test("commitChapterMemory 原子更新 continuity、全书摘要与水位，不改写章节正文", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    const committed = await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    const finalPath = path.join(projectRoot, "chapters", "001.md");
    const finalBefore = await fs.readFile(finalPath, "utf8");

    const result = await commitChapterMemory({
      projectRoot,
      chapterNo: 1,
      expectedChapterChecksum: committed.checksum,
      extraction: extractionFixture()
    });
    assert.equal(result.ok, true);
    assert.equal(result.facts_added, 1);
    assert.equal(result.summary_updated, true);

    const continuity = await loadContinuity(projectRoot);
    assert.equal(continuity.facts[0].value, "退伍军人");
    const summary = await fs.readFile(path.join(projectRoot, "memory", "book_summary.md"), "utf8");
    assert.match(summary, /雨夜收到警告/u);
    const state = await loadContinuityState(projectRoot);
    assert.equal(state.last_extracted_chapter, 1);
    assert.deepEqual(state.extracted_chapters, [1]);
    // 章节正文原样
    assert.equal(await fs.readFile(finalPath, "utf8"), finalBefore);

    // 幂等：重复合并不新增重复事实
    const second = await commitChapterMemory({ projectRoot, chapterNo: 1, expectedChapterChecksum: committed.checksum, extraction: extractionFixture() });
    assert.equal(second.facts_added, 0);
    assert.equal((await loadContinuity(projectRoot)).facts.length, 1);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapterMemory 校验和漂移拒绝合并且不落盘", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    await assert.rejects(
      () => commitChapterMemory({ projectRoot, chapterNo: 1, expectedChapterChecksum: "sha256:wrong", extraction: extractionFixture() }),
      (error) => error instanceof ProjectOperationError && error.code === "chapter_checksum_mismatch"
    );
    assert.equal((await loadContinuity(projectRoot)).facts.length, 0);
    assert.equal((await loadContinuityState(projectRoot)).last_extracted_chapter, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapter 无草稿且无正式文件时报 draft_not_found", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await assert.rejects(
      () => commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 }),
      (error) => error instanceof ProjectOperationError && error.code === "draft_not_found"
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapterMemory 无提取数据且无 pending 文件时报 extraction_missing", async () => {
  const { workspace, projectRoot } = await makeProject();
  try {
    await assert.rejects(
      () => commitChapterMemory({ projectRoot, chapterNo: 1 }),
      (error) => error instanceof ProjectOperationError && error.code === "extraction_missing"
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapterMemory 源章节文件缺失时报 chapter_not_found 且不落盘", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    // 无章节文件（索引为空）时核对校验和必须报 chapter_not_found
    await assert.rejects(
      () => commitChapterMemory({ projectRoot, chapterNo: 1, expectedChapterChecksum: "sha256:whatever", extraction: extractionFixture() }),
      (error) => error instanceof ProjectOperationError && error.code === "chapter_not_found"
    );
    assert.equal((await loadContinuity(projectRoot)).facts.length, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapterMemory 无 extraction 时使用 pending 文件并清理（中断恢复）", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });
    const pendingPath = path.join(projectRoot, "memory", ".pending-extraction-1.json");
    await fs.writeFile(pendingPath, JSON.stringify({ ok: true, ...extractionFixture() }), "utf8");

    const result = await commitChapterMemory({ projectRoot, chapterNo: 1 });
    assert.equal(result.facts_added, 1);
    assert.equal((await loadContinuity(projectRoot)).facts[0].value, "退伍军人");
    const summary = await fs.readFile(path.join(projectRoot, "memory", "book_summary.md"), "utf8");
    assert.match(summary, /雨夜收到警告/u);
    assert.equal(await fs.access(pendingPath).then(() => true).catch(() => false), false, "pending 文件应在成功后删除");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapterMemory 写入期失败回滚：continuity 与摘要全部还原，pending 保留", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    // 预置 pending 提取文件（模拟模型调用已完成、落盘被中断）
    const pendingPath = path.join(projectRoot, "memory", ".pending-extraction-1.json");
    await fs.writeFile(pendingPath, JSON.stringify({ ok: true, ...extractionFixture() }), "utf8");
    const summaryBefore = await fs.readFile(path.join(projectRoot, "memory", "book_summary.md"), "utf8");

    // 事务写入顺序：continuity.json(1) → continuity.md(2) → book_summary(3) → continuity_state(4)
    await assert.rejects(
      () =>
        commitChapterMemory(
          { projectRoot, chapterNo: 1 },
          { hooks: { beforeWrite: failOnWrite(2) } }
        ),
      /注入写入失败/u
    );

    // continuity.json 已写后被还原删除、其余文件保持先前状态、pending 保留供恢复
    await assert.rejects(() => fs.stat(path.join(projectRoot, "memory", "continuity.json")), (error) => error.code === "ENOENT");
    await assert.rejects(() => fs.stat(path.join(projectRoot, "memory", "continuity.md")), (error) => error.code === "ENOENT");
    await assert.rejects(() => fs.stat(path.join(projectRoot, "memory", "continuity_state.json")), (error) => error.code === "ENOENT");
    assert.equal(await fs.readFile(path.join(projectRoot, "memory", "book_summary.md"), "utf8"), summaryBefore);
    assert.equal(await fs.access(pendingPath).then(() => true).catch(() => false), true, "pending 文件必须保留供下次恢复");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("commitChapterMemory 确定性连续性门禁只报较晚一方=本章的 timeline 矛盾", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    // 预置第 3 章 scene（2021年3月10日）
    await saveContinuity(projectRoot, {
      schema_version: 2,
      facts: [],
      timeline: [
        {
          chapter_no: 3,
          events: ["先行事件"],
          story_time_raw: "",
          time: { kind: "scene", elapsed: null, anchor: { type: "date", raw: "2021年3月10日", subject: null }, confidence: "high" }
        }
      ],
      characters: []
    });
    // 第 5 章 scene 早于第 3 章
    const extraction = {
      summary: "第五章",
      facts: [],
      timeline: [
        {
          chapter_no: 5,
          events: ["后写但更早"],
          story_time_raw: "",
          time: { kind: "scene", elapsed: null, anchor: { type: "date", raw: "2021年3月5日", subject: null }, confidence: "high" }
        }
      ],
      characters: []
    };
    const result = await commitChapterMemory({ projectRoot, chapterNo: 5, extraction });
    assert.equal(result.timeline_violations.length, 1);
    assert.equal(result.timeline_violations[0].chapter_no, 5);
    assert.equal(result.timeline_violations[0].type, "time_reversal");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// inspectChapterContext：章节位置只来自请求章 + 章节索引（绝不读 agent_state）
// ---------------------------------------------------------------------------

test("inspectChapterContext 从章节索引推导位置且不受 agent_state 影响", async () => {
  const { workspace, projectRoot, project } = await makeProject();
  try {
    const before = await inspectChapterContext({ projectRoot, chapterNo: 1 });
    assert.equal(before.status, "not_started");
    assert.equal(before.is_committed, false);
    assert.equal(before.next_chapter_no, 1);
    assert.deepEqual(before.completed_chapter_nos, []);

    await appendChapterSegment({ projectRoot, projectId: project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
    await commitChapter({ projectRoot, projectId: project.project_id, chapterNo: 1 });

    // 伪造一个内容完全不同的旧状态文件（旧世界残留）：位置推导不得受其影响
    await fs.writeFile(
      path.join(projectRoot, LEGACY_STATE_FILE),
      JSON.stringify({ current_chapter_no: 99, project_status: "completed", current_stage: "completed" }),
      "utf8"
    );

    const after = await inspectChapterContext({ projectRoot, chapterNo: 1 });
    assert.equal(after.is_committed, true);
    assert.equal(after.status, "completed");
    assert.equal(after.last_completed_chapter_no, 1);
    assert.equal(after.next_chapter_no, 2);
    assert.deepEqual(after.completed_chapter_nos, [1]);
    assert.equal(after.actual_words >= 50, true);
    assert.ok(after.checksum);

    // 未完成章
    const unstarted = await inspectChapterContext({ projectRoot, chapterNo: 3 });
    assert.equal(unstarted.is_committed, false);
    assert.equal(unstarted.next_chapter_no, 3);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 模块 C：commit/finalize 自动存档版本快照（.versions/），幂等重复提交不新增
// ---------------------------------------------------------------------------

// 独立 setup（自动清理）：老项目形状测试需要手动预置正式文件后再 upsert 索引。
async function setupWithAutoCleanup(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-ops-chapter-versions-"));
  const { projectRoot, project } = await createProjectRoot(workspace);
  t.after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });
  return { workspace, projectRoot, project };
}

test("commit/finalize 后自动存档版本快照；幂等重复提交不新增版本", async (t) => {
  const h = await setupWithAutoCleanup(t);
  await appendChapterSegment({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
  await commitChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1 });
  const manifestPath = path.join(h.projectRoot, ".versions", "chapters", "001", "manifest.json");
  const afterCommit = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(afterCommit.versions.length, 1);
  assert.equal(afterCommit.versions[0].source, "commit");
  // 幂等重复提交：duplicate 分支不新增版本
  await commitChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1 });
  const afterDup = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(afterDup.versions.length, 1);
  // 修订入账新增版本
  const finalPath = chapterFinalPath(h.projectRoot, 1, h.project.output_format);
  await fs.writeFile(finalPath, "修订正文", "utf8");
  await finalizeChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1 });
  const afterFinalize = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(afterFinalize.versions.length, 2);
  assert.equal(afterFinalize.versions[1].source, "revision");
});

test("老项目形状（既有 completed 章节、无任何版本）：finalize 自动种 baseline 再存修订版", async (t) => {
  // 模拟升级前的既有项目：索引已有 completed 条目 + 正式文件，.versions/ 尚不存在。
  // 基线由设计 D3 的迁移先种（runtime 每轮全量迁移，见 runtime.mjs），随后模型的
  // 直编只触发修订快照；finalize 内的 ensureBaselineVersion 对已种基线幂等跳过。
  const h = await setupWithAutoCleanup(t);
  const finalPath = chapterFinalPath(h.projectRoot, 1, h.project.output_format);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, "升级前就已存在的原稿正文", "utf8");
  await upsertChapter(h.projectRoot, {
    chapter_no: 1, status: "completed", final_path: finalPath,
    actual_words: countEffectiveWords("升级前就已存在的原稿正文"),
    checksum: sha256("升级前就已存在的原稿正文"), quality_gate_results: []
  });
  // D3 迁移：对 completed 章节种 baseline（此时文件还是升级前的原稿）
  await migrateBaselineVersions({ projectRoot: h.projectRoot, chapters: (await loadChapterIndex(h.projectRoot)).chapters });
  await fs.writeFile(finalPath, "模型直编后的修订正文", "utf8");
  await finalizeChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1 });
  const manifest = JSON.parse(await fs.readFile(path.join(h.projectRoot, ".versions", "chapters", "001", "manifest.json"), "utf8"));
  assert.equal(manifest.versions.length, 2);
  assert.equal(manifest.versions[0].source, "baseline", "首次修订前状态必须是 baseline");
  assert.equal(manifest.versions[1].source, "revision");
  assert.equal(manifest.versions[0].checksum, sha256("升级前就已存在的原稿正文"));
});

// ---------------------------------------------------------------------------
// C5：rollbackChapter —— 模型侧回滚：把 .versions/ 指定版本快照写回正式文件，
// 重新入账（复用 finalizeChapter）+ 存档为新版本（append-only）。
// 语义：version 缺省 = 恢复上一版；等于当前最新版拒绝；无历史版本拒绝；
// 覆盖前若文件含未入账手动改动则先存 pre_rollback 档（不丢内容）。
// ---------------------------------------------------------------------------

test("rollbackChapter：恢复指定版本、重新入账、存档为新版本；缺省回上一版", async (t) => {
  const h = await setupWithAutoCleanup(t);
  const finalPath = chapterFinalPath(h.projectRoot, 1, h.project.output_format);
  await appendChapterSegment({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
  await commitChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1 });
  const manifestPath = path.join(h.projectRoot, ".versions", "chapters", "001", "manifest.json");
  // 红测一律从 .versions/ 实际快照读取内容断言，不硬编码与 commit fixture 可能不一致的占位字符串。
  const v1Content = JSON.parse(await fs.readFile(manifestPath, "utf8")).versions[0].checksum
    ? await fs.readFile(path.join(h.projectRoot, ".versions", "chapters", "001", "v1.md"), "utf8")
    : null;
  await fs.writeFile(finalPath, "v2 修订正文", "utf8");
  await finalizeChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1 });
  // 现在 v1=原始提交、v2=修订；回滚到 v1（以 v1 快照实际内容为准，不硬编码占位符）
  const result = await rollbackChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1, version: 1 });
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(finalPath, "utf8"), v1Content, "文件应恢复为 v1 内容");
  assert.equal(result.checksum, sha256(v1Content));
  const index = await loadChapterIndex(h.projectRoot);
  const entry = index.chapters.find((c) => Number(c.chapter_no) === 1);
  assert.equal(entry.checksum, result.checksum, "回滚后索引校验和必须一致");
  // 回滚本身存档为新版本 v3
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.versions.length, 3);
  assert.equal(manifest.versions[2].source, "rollback");
  // 缺省 version = 上一版（v3 的最新版是 v3，上一版是 v2）
  const back = await rollbackChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1 });
  assert.equal(await fs.readFile(finalPath, "utf8"), "v2 修订正文");
});

test("rollbackChapter：当前文件有未入账/手动改动时，先存 pre_rollback 档再写回（不丢内容）", async (t) => {
  const h = await setupWithAutoCleanup(t);
  const finalPath = chapterFinalPath(h.projectRoot, 1, h.project.output_format);
  await appendChapterSegment({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
  await commitChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1 });
  const v1Content = await fs.readFile(path.join(h.projectRoot, ".versions", "chapters", "001", "v1.md"), "utf8");
  await fs.writeFile(finalPath, "v2 修订正文", "utf8");
  await finalizeChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1 });
  // 用户/外部在编辑器里手动改了当前文件（未入账）
  await fs.writeFile(finalPath, "用户手动改的最新内容", "utf8");
  const result = await rollbackChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1, version: 1 });
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(finalPath, "utf8"), v1Content, "文件恢复为 v1");
  const manifest = JSON.parse(await fs.readFile(path.join(h.projectRoot, ".versions", "chapters", "001", "manifest.json"), "utf8"));
  // pre_rollback 档必须存在（覆盖前存档），手动内容可恢复
  const preRollback = manifest.versions.find((v) => v.source === "pre_rollback");
  assert.ok(preRollback, "覆盖前必须存档 pre_rollback");
  assert.equal(preRollback.checksum, sha256("用户手动改的最新内容"));
  assert.equal(manifest.versions.at(-1).source, "rollback", "回滚本身仍存档为新版本");
});

test("rollbackChapter：无历史版本/版本不存在/回滚到当前版 拒绝", async (t) => {
  const h = await setupWithAutoCleanup(t);
  await appendChapterSegment({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1, segmentNo: 1, content: LONG_PROSE });
  await commitChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1 });
  // 只有 v1，回滚到 v1 等于当前版
  await assert.rejects(
    rollbackChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1 }),
    (error) => error.code === "already_current"
  );
  await assert.rejects(
    rollbackChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 1, version: 99 }),
    (error) => error.code === "version_not_found"
  );
  await assert.rejects(
    rollbackChapter({ projectRoot: h.projectRoot, projectId: h.project.project_id, chapterNo: 2 }),
    (error) => error.code === "no_versions"
  );
});
