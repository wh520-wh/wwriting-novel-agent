import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProject } from "../src/core/agent-engine.mjs";
import { createProject, loadState } from "../src/core/project-store.mjs";

test("阶段切换写入 stage_entered_at，心跳仍然更新", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-stagemeta-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 300,
    target_words_per_chapter: 360
  });
  const stamps = [];
  await runProject(projectRoot, {
    onHeartbeat: async () => {
      const state = await loadState(projectRoot);
      if (state.stage_entered_at) stamps.push(`${state.current_stage}@${state.stage_entered_at}`);
    }
  });
  const state = await loadState(projectRoot);
  assert.ok(state.stage_entered_at, "最终状态必须有 stage_entered_at");
  assert.ok(!Number.isNaN(Date.parse(state.stage_entered_at)));
  assert.ok(state.last_heartbeat, "心跳仍需写入");
  assert.ok(new Set(stamps.map((s) => s.split("@")[0])).size >= 2, "至少经历两个不同阶段的时间戳");
});
