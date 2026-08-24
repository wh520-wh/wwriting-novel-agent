// whfind-bugs #1（2026-08-24）回归守卫：四个投影查询助手必须走 readTail 尾部
// 窗口。曾用 read({ afterSeq: 0, limit }) 读到的是「最旧 N 条」（segments 从 0 号
// 段顺序取），事件超 10 万后 findInputMeta 找不到新输入 → run-lifecycle 把每个
// 活动输入立即 input_interrupted，会话永久卡死。readTail 语义本身由尾部翻页既有
// 测试覆盖，这里钉住「不得回退到头部窗口」。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("投影查询不得使用 afterSeq:0 头部窗口（whfind-bugs #1 守卫）", () => {
  const journalPath = fileURLToPath(new URL("../../src/core/agent/journal.mjs", import.meta.url));
  const src = readFileSync(journalPath, "utf8");
  assert.ok(
    !src.includes("read({ afterSeq: 0, limit: 100000 })"),
    "journal 投影查询回退到了头部窗口：会话超 10 万事件后将永久卡死（whfind-bugs #1）"
  );
});