// 第十六轮 T2：政策文本硬规矩（写章节前必查前情 + 三件套含伏笔）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { UNIFIED_TASK_POLICY } from "../../src/core/agent/prompt.mjs";

test("政策文本：写章节前必查 read_continuity，三件套含伏笔职责", () => {
  assert.match(UNIFIED_TASK_POLICY, /动笔写任何章节之前，必须先调用 read_continuity/u);
  assert.match(UNIFIED_TASK_POLICY, /含新埋（open）与回收（paid）的伏笔/u);
});
