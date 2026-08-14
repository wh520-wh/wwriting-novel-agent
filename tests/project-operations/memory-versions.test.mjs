// 第九轮：记忆文件（WORKLOG/book_summary）版本快照 + 200 上限。
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  MEMORY_VERSION_CAP,
  snapshotMemoryFile,
  listMemoryVersions,
  readMemoryVersion
} from "../../src/core/project-operations/memory-versions.mjs";

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-memver-"));
  return root;
}

test("snapshot 递增版本并写 manifest，read 读回内容", async () => {
  const root = await makeRoot();
  const v1 = await snapshotMemoryFile({ projectRoot: root, file: "worklog", content: "# WORKLOG\n\n第一次", source: "commit" });
  const v2 = await snapshotMemoryFile({ projectRoot: root, file: "worklog", content: "# WORKLOG\n\n第二次", source: "revision" });
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  const list = await listMemoryVersions({ projectRoot: root, file: "worklog" });
  assert.equal(list.versions.length, 2);
  assert.equal(list.versions[1].source, "revision");
  const read = await readMemoryVersion({ projectRoot: root, file: "worklog", version: 2 });
  assert.equal(read.content, "# WORKLOG\n\n第二次");
  assert.ok(typeof read.checksum === "string" && read.checksum.length === 64);
});

test("无版本 → no_versions；目标版本不存在 → version_not_found", async () => {
  const root = await makeRoot();
  await assert.rejects(listMemoryVersions({ projectRoot: root, file: "book_summary" }), (e) => e.code === "no_versions");
  await snapshotMemoryFile({ projectRoot: root, file: "book_summary", content: "a", source: "commit" });
  await assert.rejects(readMemoryVersion({ projectRoot: root, file: "book_summary", version: 5 }), (e) => e.code === "version_not_found");
});

test("超过 200 版删最老（只保留最近 MEMORY_VERSION_CAP 版）", async () => {
  const root = await makeRoot();
  for (let i = 1; i <= MEMORY_VERSION_CAP + 10; i += 1) {
    await snapshotMemoryFile({ projectRoot: root, file: "worklog", content: `v${i}`, source: "commit" });
  }
  const list = await listMemoryVersions({ projectRoot: root, file: "worklog" });
  assert.equal(list.versions.length, MEMORY_VERSION_CAP);
  assert.equal(list.versions[0].version, 11, "最老的 10 版被裁剪");
  assert.equal(list.versions.at(-1).version, MEMORY_VERSION_CAP + 10, "版本号不复用");
  await assert.rejects(fs.stat(path.join(root, ".versions", "memory", "worklog", "v1.md")), /ENOENT/);
});
