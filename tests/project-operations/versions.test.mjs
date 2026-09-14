// tests/project-operations/versions.test.mjs —— 章节版本快照库（第八轮模块 C）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../../src/core/fs-utils.mjs";
import { ensureBaselineVersion, listChapterVersions, migrateBaselineVersions, readChapterVersion, snapshotChapter } from "../../src/core/project-operations/versions.mjs";

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-versions-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { projectRoot: dir };
}

test("快照 append-only：版本递增、manifest 记录 source/checksum，完整保留不裁剪", async (t) => {
  const { projectRoot } = await setup(t);
  const a = await snapshotChapter({ projectRoot, chapterNo: 1, content: "v1 正文", source: "baseline" });
  assert.equal(a.version, 1);
  const b = await snapshotChapter({ projectRoot, chapterNo: 1, content: "v2 正文", source: "revision" });
  assert.equal(b.version, 2);
  const c = await snapshotChapter({ projectRoot, chapterNo: 1, content: "v1 正文", source: "rollback" });
  assert.equal(c.version, 3, "回滚也存档为新版本（append-only）");
  const versions = await listChapterVersions({ projectRoot, chapterNo: 1 });
  assert.equal(versions.length, 3);
  assert.deepEqual(versions.map((v) => v.version), [1, 2, 3]);
  assert.equal(versions[1].source, "revision");
  assert.equal(versions[2].source, "rollback");
  assert.ok(versions.every((v) => typeof v.checksum === "string" && v.checksum.startsWith("sha256:")), "manifest 记录校验和");
  // 章节之间隔离
  const d = await snapshotChapter({ projectRoot, chapterNo: 2, content: "x", source: "baseline" });
  assert.equal(d.version, 1);
  // 磁盘落点
  assert.equal(await pathExists(path.join(projectRoot, ".versions", "chapters", "001", "v1.md")), true);
  assert.equal(await pathExists(path.join(projectRoot, ".versions", "chapters", "001", "v3.md")), true);
  // 读取
  const restored = await readChapterVersion({ projectRoot, chapterNo: 1, version: 1 });
  assert.equal(restored.content, "v1 正文");
  await assert.rejects(
    readChapterVersion({ projectRoot, chapterNo: 1, version: 99 }),
    (error) => error.code === "version_not_found"
  );
});

test("ensureBaselineVersion：无版本时种 v1 baseline；已有版本时幂等跳过", async (t) => {
  const { projectRoot } = await setup(t);
  const first = await ensureBaselineVersion({ projectRoot, chapterNo: 1, content: "老章节原稿" });
  assert.equal(first.existed, false);
  assert.equal(first.version, 1);
  const versions = await listChapterVersions({ projectRoot, chapterNo: 1 });
  assert.equal(versions.length, 1);
  assert.equal(versions[0].source, "baseline");
  const second = await ensureBaselineVersion({ projectRoot, chapterNo: 1, content: "老章节原稿" });
  assert.equal(second.existed, true, "已存在版本必须幂等跳过");
  assert.equal((await listChapterVersions({ projectRoot, chapterNo: 1 })).length, 1, "不得重复种基线");
});

test("migrateBaselineVersions：completed 章节全部种 v1，drafting 跳过，正文/索引零改动，幂等", async (t) => {
  const { projectRoot } = await setup(t);
  await fs.mkdir(path.join(projectRoot, "chapters"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "memory"), { recursive: true });
  const chapterBody = "既有第 1 章正文：主角在雨夜出发。";
  await fs.writeFile(path.join(projectRoot, "chapters", "001.md"), chapterBody, "utf8");
  await fs.writeFile(path.join(projectRoot, "chapters", "002.md"), "既有第 2 章正文", "utf8");
  await fs.writeFile(path.join(projectRoot, "chapters", "003.md"), "未完成草稿正文", "utf8");
  const chapters = [
    { chapter_no: 1, status: "completed", final_path: "chapters/001.md", checksum: "sha256:old-index-1" },
    { chapter_no: 2, status: "completed", final_path: "chapters/002.md", checksum: "sha256:old-index-2" },
    { chapter_no: 3, status: "drafting", final_path: null, checksum: null }
  ];
  const results = await migrateBaselineVersions({ projectRoot, chapters });
  assert.deepEqual(results.map((r) => r.chapter_no), [1, 2], "只迁移 completed 章节");
  assert.deepEqual(results.map((r) => r.baseline), ["created", "created"]);
  // 负向断言：正文与索引零改动
  assert.equal(await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8"), chapterBody);
  assert.equal(await fs.readFile(path.join(projectRoot, "chapters", "003.md"), "utf8"), "未完成草稿正文");
  assert.equal(await pathExists(path.join(projectRoot, "memory", "chapter_index.json")), false, "迁移不得创建/改写章节索引");
  // 幂等：第二次调用全部 existing
  const again = await migrateBaselineVersions({ projectRoot, chapters });
  assert.ok(again.every((r) => r.baseline === "existing"), "再次迁移必须全部跳过");
  assert.equal((await listChapterVersions({ projectRoot, chapterNo: 1 })).length, 1);
  assert.equal((await listChapterVersions({ projectRoot, chapterNo: 1 }))[0].source, "baseline");
});
