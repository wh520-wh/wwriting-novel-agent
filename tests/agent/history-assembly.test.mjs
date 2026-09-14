// 历史装配层（Task 7 / F5a：runtime 拆分第一步）纯转换函数测试。
//
// tests/agent/ 是允许测试内部 seam 的目录：本文件直接导入
// src/core/agent/history-assembly.mjs（深模块内部实现）。覆盖：
//   - transcriptToMessages：user/assistant/tool 三类记录 -> 干净 OpenAI 消息形状
//     （tool_calls 还原线上格式 { id, type, function: { name, arguments } }）
//   - buildTurnsFromTranscript：轮次重建（一轮 = user input + assistant 正文 +
//     tool_activities 归属；后续 assistant 覆盖正文，闭合 tool 记录挂回 activity）
import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnsFromTranscript, checkpointToMessages, transcriptToMessages } from "../../src/core/agent/history-assembly.mjs";

// ---------------------------------------------------------------------------
// transcriptToMessages
// ---------------------------------------------------------------------------

test("transcriptToMessages: 三类记录转为干净的 OpenAI 消息形状", () => {
  const records = [
    { role: "user", content: "请阅读 a.md", input_id: "in-1", transcript_seq: 1 },
    {
      role: "assistant",
      content: "正在读取",
      input_id: "in-1",
      transcript_seq: 2,
      tool_calls: [{ id: "call-1", name: "read_file", arguments: { path: "a.md" } }]
    },
    { role: "tool", tool_call_id: "call-1", name: "read_file", content: "文件内容 abc", transcript_seq: 3 },
    { role: "assistant", content: "完毕", tool_calls: [], transcript_seq: 4 }
  ];
  const messages = transcriptToMessages(records);
  assert.deepEqual(messages, [
    { role: "user", content: "请阅读 a.md" },
    {
      role: "assistant",
      content: "正在读取",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.md"}' } }
      ]
    },
    { role: "tool", tool_call_id: "call-1", content: "文件内容 abc" },
    // 空 tool_calls 不产出 tool_calls 字段
    { role: "assistant", content: "完毕" }
  ]);
});

test("transcriptToMessages: 思考回传契约——assistant 记录 reasoning 映射 reasoning_content，无 reasoning 不带该字段", () => {
  const messages = transcriptToMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: null, reasoning: "先查文件再回答", tool_calls: [{ id: "c1", name: "t", arguments: {} }] },
    { role: "assistant", content: "最终回复" }
  ]);
  assert.equal(messages[1].reasoning_content, "先查文件再回答", "带思考的轮次必须原样回传（官方 thinking_mode 契约）");
  assert.equal("reasoning_content" in messages[2], false, "无思考轮次不携带该字段");
});

// ---------------------------------------------------------------------------
// buildTurnsFromTranscript
// ---------------------------------------------------------------------------

test("buildTurnsFromTranscript: 一轮 = user input + assistant 正文 + tool_activities 归属", () => {
  const records = [
    { role: "user", content: "查一下资料", transcript_seq: 1 },
    { role: "assistant", content: "好的", transcript_seq: 2, tool_calls: [{ id: "c1", name: "search_web", arguments: { q: "history" } }] },
    { role: "tool", tool_call_id: "c1", name: "search_web", content: "结果一", transcript_seq: 3 },
    { role: "assistant", content: "结论如下", transcript_seq: 4 },
    { role: "user", content: "继续", transcript_seq: 5 },
    { role: "assistant", content: "更多结论", transcript_seq: 6 }
  ];
  const turns = buildTurnsFromTranscript(records);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0], {
    id: "turn-1",
    user_text: "查一下资料",
    // 同一轮内的后续 assistant 正文覆盖前者
    assistant_text: "结论如下",
    transcript_seq_start: 1,
    transcript_seq_end: 4,
    token_estimate: null,
    tool_activities: [
      {
        tool_call_id: "c1",
        name: "search_web",
        status: "closed",
        arguments: { q: "history" },
        output: "结果一",
        result_summary: null,
        journal_ref: "transcript 2"
      }
    ]
  });
  assert.deepEqual(turns[1], {
    id: "turn-5",
    user_text: "继续",
    assistant_text: "更多结论",
    transcript_seq_start: 5,
    transcript_seq_end: 6,
    token_estimate: null,
    tool_activities: []
  });
});

// ---------------------------------------------------------------------------
// checkpointToMessages
// ---------------------------------------------------------------------------

test("checkpointToMessages: 摘要转独立 user 块 + recent_messages 展开", () => {
  const checkpoint = {
    summary: { chapter: "第一章", progress: 0.3 },
    recent_messages: [
      { role: "user", content: "旧提问" },
      { role: "assistant", content: "旧回答" }
    ]
  };
  const messages = checkpointToMessages(checkpoint);
  assert.deepEqual(messages, [
    { role: "user", content: "[上下文压缩摘要]\n{\n  \"chapter\": \"第一章\",\n  \"progress\": 0.3\n}" },
    { role: "user", content: "旧提问" },
    { role: "assistant", content: "旧回答" }
  ]);
});
