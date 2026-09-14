// createJournalDeltaWriter 单元测试（统一 Agent 内核计划 Task 4 Step 1）。
//
// 覆盖：24ms/2048 字批量合并、跨 token 显式 secret 脱敏、finish({flushTail:false})
// 不泄露 carry、journal 增量写入失败不把成功模型调用误判为失败、reasoningAvailability
// 三态判定、事件 payload 形状（eventType/run_id/basePayload）。
import assert from "node:assert/strict";
import test from "node:test";

import { createJournalDeltaWriter, reasoningAvailability } from "../../src/core/agent/stream-writer.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordingJournal() {
  const events = [];
  return {
    events,
    append: async (event) => events.push(event)
  };
}

test("token 按时间窗批量合并为少量 journal 事件，拼接文本完整，push 返回 rawText", async () => {
  const journal = recordingJournal();
  const writer = createJournalDeltaWriter({
    journal,
    eventType: "reasoning_delta",
    runId: "run-1",
    basePayload: { turn_id: "turn-1", input_id: "input-1" },
    flushMs: 10,
    maxPendingChars: 2048
  });
  const tokens = Array.from({ length: 100 }, (_, index) => `t${index}`);
  let raw = "";
  for (const token of tokens) {
    raw = writer.push(token);
  }
  assert.equal(raw, tokens.join(""), "push() 应返回累积 rawText");
  const result = await writer.finish();
  assert.equal(result.rawText, tokens.join(""));
  assert.equal(result.safeText, tokens.join(""));
  assert.ok(journal.events.length > 0 && journal.events.length < tokens.length, `应批量合并，实际 ${journal.events.length} 条事件`);
  assert.equal(journal.events.map((event) => event.payload.text).join(""), tokens.join(""));
  for (const event of journal.events) {
    assert.equal(event.type, "reasoning_delta");
    assert.equal(event.run_id, "run-1");
    assert.equal(event.payload.turn_id, "turn-1");
    assert.equal(event.payload.input_id, "input-1");
  }
});

test("pending 达到 maxPendingChars 时立即落盘，不受时间窗等待", async () => {
  const journal = recordingJournal();
  const writer = createJournalDeltaWriter({
    journal,
    eventType: "assistant_message_delta",
    runId: "run-1",
    basePayload: { input_id: "input-1" },
    flushMs: 60000, // 大时间窗：只有达到字符上限才会触发落盘
    maxPendingChars: 2048
  });
  const big = "x".repeat(3000);
  writer.push(big);
  await writer.finish();
  assert.equal(journal.events.length, 1, "超过上限应立即写入单条事件");
  assert.equal(journal.events[0].payload.text, big);
});

test("跨 token 的显式 secret 被完整脱敏；rawText 保留原文", async () => {
  const journal = recordingJournal();
  const secret = "super-secret-token-77";
  const writer = createJournalDeltaWriter({
    journal,
    eventType: "assistant_message_delta",
    runId: "run-1",
    basePayload: { input_id: "input-1" },
    secrets: [secret],
    flushMs: 10,
    maxPendingChars: 2048
  });
  writer.push("hello super-secret-to");
  writer.push("ken-77 world");
  const result = await writer.finish();
  assert.equal(result.rawText, `hello ${secret} world`);
  assert.equal(result.safeText, "hello [REDACTED] world");
  assert.equal(journal.events.map((event) => event.payload.text).join(""), "hello [REDACTED] world");
  assert.ok(!JSON.stringify(journal.events).includes(secret), "journal 事件不得包含明文 secret");
});

test("finish({ flushTail: false }) 不泄露 carry 中的半截密钥", async () => {
  const journal = recordingJournal();
  const writer = createJournalDeltaWriter({
    journal,
    eventType: "assistant_message_delta",
    runId: "run-1",
    basePayload: { input_id: "input-1" },
    flushMs: 10,
    maxPendingChars: 2048
  });
  writer.push("password=partial-");
  const result = await writer.finish({ flushTail: false });
  assert.equal(result.rawText, "password=partial-");
  assert.equal(result.safeText, "", "未确认安全的尾部不得进入 safeText");
  await sleep(30);
  assert.equal(journal.events.length, 0, "未确认安全的尾部不得落盘");
});

test("finish() 默认 flush 尾部 carry：半截密钥终态脱敏后落盘", async () => {
  const journal = recordingJournal();
  const writer = createJournalDeltaWriter({
    journal,
    eventType: "assistant_message_delta",
    runId: "run-1",
    basePayload: { input_id: "input-1" },
    flushMs: 10,
    maxPendingChars: 2048
  });
  writer.push("password=partial-");
  const result = await writer.finish();
  assert.equal(result.safeText, "password=[REDACTED]");
  assert.equal(journal.events.map((event) => event.payload.text).join(""), "password=[REDACTED]");
});

test("journal 增量写入失败不把成功模型调用误判为失败", async () => {
  const failingJournal = {
    append: async () => {
      throw new Error("disk full");
    }
  };
  const writer = createJournalDeltaWriter({
    journal: failingJournal,
    eventType: "assistant_message_delta",
    runId: "run-1",
    basePayload: { input_id: "input-1" },
    flushMs: 1,
    maxPendingChars: 2048
  });
  writer.push("你好");
  const result = await writer.finish(); // 不得 reject
  assert.equal(result.rawText, "你好");
  assert.equal(result.safeText, "你好");
});

test("closed 后 push 被忽略（迟到 token 不产生增量）", async () => {
  const journal = recordingJournal();
  const writer = createJournalDeltaWriter({
    journal,
    eventType: "assistant_message_delta",
    runId: "run-1",
    basePayload: { input_id: "input-1" },
    flushMs: 10,
    maxPendingChars: 2048
  });
  writer.push("停止前");
  await writer.finish();
  writer.push("迟到内容");
  await sleep(30);
  assert.equal(journal.events.map((event) => event.payload.text).join(""), "停止前");
});

test("reasoningAvailability 判定只看 capability 与本轮内容", () => {
  assert.equal(reasoningAvailability("supported", "思考中"), "available");
  assert.equal(reasoningAvailability("unknown", "思考中"), "available");
  assert.equal(reasoningAvailability("unsupported", ""), "unsupported");
  assert.equal(reasoningAvailability("unknown", ""), "empty");
  assert.equal(reasoningAvailability("unsupported", "意外有内容"), "available");
});
