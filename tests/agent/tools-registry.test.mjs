// tests/agent/tools-registry.test.mjs —— Task 5（第十五轮 F4）：tools 四域注册拆分对账。
// 钉住「四域注册并集 = 14 个生产工具」：拆分后任何域的注册脱落/误注册都会使本测试红。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createToolRuntime } from "../../src/core/agent/tools/index.mjs";
import { createAgentJournal } from "../../src/core/agent/journal.mjs";

const EXPECTED = new Set([
  "list_files", "search_files", "read_file", "write_file", "edit_file",
  "shell", "read_skill", "count_text",
  "update_plan", "append_chapter_segment", "commit_chapter",
  "finalize_revision", "rollback_chapter", "update_memory"
]);

test("四域注册并集 = 14 个生产工具", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-tools-registry-"));
  t.after(async () => await fs.rm(projectRoot, { recursive: true, force: true }));
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const runtime = createToolRuntime({ projectOperations: {}, journal });
  const names = runtime.definitions().map((d) => d.function.name);
  // 此处只钉「并集 = 14」；暴露顺序由 tests/agent/tools.test.mjs 的
  // definitions() deepEqual 契约（GENERAL 8 前 DEEP 6 后）钉住，不在此重复。
  assert.deepEqual(new Set(names), EXPECTED);
});
