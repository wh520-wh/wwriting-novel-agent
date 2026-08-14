// tests/core/ledger-drift.test.mjs —— 账本一致性检测（第八轮模块 C，设计 D1）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../../src/core/fs-utils.mjs";
import { detectLedgerDrift, buildLedgerDriftNote } from "../../src/core/ledger-drift.mjs";

async function setup(t) {
  const projectRoot = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-ledger-")), "project");
  await fs.mkdir(path.join(projectRoot, "chapters"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "memory"), { recursive: true });
  t.after(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });
  return { projectRoot };
}

async function writeIndex(projectRoot, chapters) {
  await fs.writeFile(path.join(projectRoot, "memory", "chapter_index.json"), JSON.stringify({ schema_version: 1, chapters }), "utf8");
}

test("detectLedgerDrift：文件与索引校验和一致 → 无漂移", async (t) => {
  const { projectRoot } = await setup(t);
  const body = "正文内容";
  await fs.writeFile(path.join(projectRoot, "chapters", "001.md"), body, "utf8");
  await writeIndex(projectRoot, [{ chapter_no: 1, status: "completed", final_path: "chapters/001.md", checksum: sha256(body) }]);
  assert.deepEqual(await detectLedgerDrift({ projectRoot }), []);
});

test("detectLedgerDrift：文件被改未入账 → checksum_mismatch；文件缺失 → file_missing", async (t) => {
  const { projectRoot } = await setup(t);
  await fs.writeFile(path.join(projectRoot, "chapters", "001.md"), "文件已被直接编辑", "utf8");
  await writeIndex(projectRoot, [
    { chapter_no: 1, status: "completed", final_path: "chapters/001.md", checksum: sha256("索引里的旧校验和") },
    { chapter_no: 2, status: "completed", final_path: "chapters/002.md", checksum: sha256("x") }
  ]);
  const drifts = await detectLedgerDrift({ projectRoot });
  assert.equal(drifts.length, 2);
  assert.deepEqual(drifts[0], { chapter_no: 1, issue: "checksum_mismatch", file_checksum: sha256("文件已被直接编辑"), index_checksum: sha256("索引里的旧校验和") });
  assert.equal(drifts[1].issue, "file_missing");
  // drafting 章节不参与检测
  await writeIndex(projectRoot, [{ chapter_no: 3, status: "drafting", final_path: null, checksum: null }]);
  assert.deepEqual(await detectLedgerDrift({ projectRoot }), []);
});

test("buildLedgerDriftNote：无漂移返回空串；有漂移渲染可行动提示", () => {
  assert.equal(buildLedgerDriftNote([]), "");
  const note = buildLedgerDriftNote([{ chapter_no: 3, issue: "checksum_mismatch" }, { chapter_no: 5, issue: "file_missing" }]);
  assert.ok(note.includes("第 3 章") && note.includes("第 5 章"), "提示必须列出章节号");
  assert.ok(note.includes("finalize_revision"), "提示必须给出可行动通道");
});
