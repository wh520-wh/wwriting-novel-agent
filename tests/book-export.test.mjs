import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { composeBook, exportBook } from "../src/core/book-export.mjs";
import { createProject, upsertChapter } from "../src/core/project-store.mjs";

test("composeBook md：书名 H1、章 H2、剥正文首标题、按章号排序", () => {
  const { filename, content } = composeBook([
    { chapter_no: 2, title: "second", content: "# 第二章\n\n乙正文。" },
    { chapter_no: 1, title: "first", content: "## 第一章 开端\n\n甲正文。" }
  ], { title: "测试书", slug: "test-book", format: "md", date: new Date("2026-06-12") });
  assert.equal(filename, "test-book-20260612.md");
  assert.match(content, /^# 测试书\n/u);
  const first = content.indexOf("## 第 1 章");
  const second = content.indexOf("## 第 2 章");
  assert.ok(first >= 0 && second > first, "章序正确");
  assert.doesNotMatch(content, /## 第一章 开端/u, "正文内原标题已剥离");
  assert.match(content, /甲正文。/u);
});

test("composeBook txt：剥 markdown 标记", () => {
  const { filename, content } = composeBook([
    { chapter_no: 1, title: "", content: "# 第一章\n\n**强调**与`代码`正文。" }
  ], { title: "书", slug: "b", format: "txt", date: new Date("2026-06-12") });
  assert.equal(filename, "b-20260612.txt");
  assert.doesNotMatch(content, /[#*`]/u);
  assert.match(content, /强调与代码正文。/u);
});

test("exportBook 端到端：completed 章入书、缺文件章进 skipped、写 exports/", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-export-"));
  const { projectRoot } = await createProject(root, {
    slug: "exp", title: "导出书", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const ch1 = path.join(projectRoot, "chapters", "001.md");
  await fs.mkdir(path.dirname(ch1), { recursive: true });
  await fs.writeFile(ch1, "# 第一章\n\n正文一。", "utf8");
  await upsertChapter(projectRoot, { chapter_no: 1, status: "completed", final_path: ch1, actual_words: 4 });
  await upsertChapter(projectRoot, { chapter_no: 2, status: "completed", final_path: path.join(projectRoot, "chapters", "missing.md"), actual_words: 0 });
  await upsertChapter(projectRoot, { chapter_no: 3, status: "drafting", final_path: null, actual_words: 0 });
  const result = await exportBook(projectRoot, { format: "md" });
  assert.equal(result.chapters, 1);          // 仅 completed 且文件在
  assert.deepEqual(result.skipped, [2]);     // completed 但缺文件
  assert.ok(result.words > 0);
  const written = await fs.readFile(result.path, "utf8");
  assert.match(written, /正文一/u);
  assert.match(result.path.replaceAll("\\", "/"), /\/exports\//u);
});

test("exportBook 范围参数 from/to", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-export2-"));
  const { projectRoot } = await createProject(root, {
    slug: "exp2", title: "书", story_seed: "s",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  for (const n of [1, 2, 3]) {
    const p = path.join(projectRoot, "chapters", `00${n}.md`);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, `# 第${n}章\n\n第${n}章正文。`, "utf8");
    await upsertChapter(projectRoot, { chapter_no: n, status: "completed", final_path: p, actual_words: 6 });
  }
  const result = await exportBook(projectRoot, { format: "md", fromChapter: 2, toChapter: 3 });
  assert.equal(result.chapters, 2);
  const written = await fs.readFile(result.path, "utf8");
  assert.doesNotMatch(written, /第1章正文/u);
});
