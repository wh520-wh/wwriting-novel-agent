import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  registerToolHook,
  runBeforeToolUse,
  runAfterToolUse,
  ensureDefaultToolHooks,
  _resetToolHooks
} from "../src/core/tool-hooks.mjs";
import { runProject } from "../src/core/agent-engine.mjs";
import { createWritingProject } from "./helpers.mjs";
import { readEvents } from "../src/core/event-log.mjs";

test("BeforeToolUse 否决会短路后续 hook", async () => {
  _resetToolHooks();
  const order = [];
  registerToolHook("BeforeToolUse", async () => { order.push("first"); return { allow: false, reason: "nope" }; });
  registerToolHook("BeforeToolUse", async () => { order.push("second"); });
  const result = await runBeforeToolUse({});
  assert.equal(result.allow, false);
  assert.equal(result.reason, "nope");
  assert.deepEqual(order, ["first"]);
});

test("AfterToolUse 单个 hook 抛错不影响其余", async () => {
  _resetToolHooks();
  let ran = false;
  registerToolHook("AfterToolUse", async () => { throw new Error("boom"); });
  registerToolHook("AfterToolUse", async () => { ran = true; });
  await runAfterToolUse({});
  assert.equal(ran, true);
});

test("默认审计 hook 写 tool_executed 事件", async () => {
  _resetToolHooks();
  ensureDefaultToolHooks();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-toolhook-"));
  const { projectRoot } = await createWritingProject(root, { slug: "project" });
  await runAfterToolUse({
    projectRoot,
    project: { project_id: "p" },
    state: { current_stage: "drafting" },
    toolCall: { tool: "append_chapter_segment", input: { chapter_no: 1 } },
    result: { bytes_written: 10, actual_words: 5, checksum: "sha256:x" },
    ok: true,
    durationMs: 12
  });
  const events = await readEvents(projectRoot);
  const audit = events.find((e) => e.type === "tool_executed");
  assert.ok(audit);
  assert.equal(audit.data.duration_ms, 12);
});

test("引擎集成：跑完一章后 run_log 含 tool_executed", async () => {
  _resetToolHooks();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-toolhook-run-"));
  const { projectRoot } = await createWritingProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  await runProject(projectRoot);
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "tool_executed" && e.data?.ok === true));
});
