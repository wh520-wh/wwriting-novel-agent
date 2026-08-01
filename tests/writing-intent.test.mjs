import assert from "node:assert/strict";
import test from "node:test";
import { compileWritingIntent } from "../src/core/writing-intent.mjs";

test("compileWritingIntent 合法意图", () => {
  const r = compileWritingIntent('```json\n{"action":"start","chapter_start":3,"chapter_end":3,"instruction":"写第三章","confirmation_policy":"auto"}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.data.action, "start");
  assert.equal(r.data.chapter_start, 3);
  assert.equal(r.data.chapter_end, 3);
  assert.equal(r.data.instruction, "写第三章");
  assert.equal(r.data.confirmation_policy, "auto");
});

test("compileWritingIntent 超枚举 action 返回 enum_violation", () => {
  const r = compileWritingIntent('{"action":"delete","instruction":"x"}');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "enum_violation");
  assert.equal(r.error.field, "action");
});

test("compileWritingIntent 空内容返回 empty_content", () => {
  const r = compileWritingIntent("  ");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "empty_content");
});
