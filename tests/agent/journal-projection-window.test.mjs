// whfind-bugs #1（2026-08-24）回归守卫：投影查询助手与 compaction loadEntry 必须
// 走 readTail 尾部窗口。曾用 read({ afterSeq: 0, limit }) 读到的是「最旧 N 条」
// （segments 从 0 号段顺序取），事件超 10 万后 findInputMeta 找不到新输入 →
// run-lifecycle 把每个活动输入立即 input_interrupted，会话永久卡死；loadEntry
// 同样找不到最新 attempt 的 started 事件（compaction_not_found）。readTail 语义
// 本身由尾部翻页既有测试覆盖，这里钉住「不得回退到头部窗口」。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectionFiles = ["journal.mjs", "compaction.mjs"];

test("投影查询不得使用 afterSeq:0 头部窗口（whfind-bugs #1 守卫）", () => {
  for (const file of projectionFiles) {
    const src = readFileSync(
      fileURLToPath(new URL(`../../src/core/agent/${file}`, import.meta.url)),
      "utf8"
    );
    assert.ok(
      !src.includes("read({ afterSeq: 0, limit: 100000 })"),
      `${file} 回退到了头部窗口：会话超 10 万事件后将永久卡死（whfind-bugs #1）`
    );
  }
});