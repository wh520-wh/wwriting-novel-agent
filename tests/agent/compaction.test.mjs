// 结构化压缩契约测试（统一 Journal/上下文窗口/自动压缩计划 Task 7）。
//
// 覆盖（brief Step 3）：COMPACTION_PROMPT 为规格草案 §6 逐字文本；parseCompactionResponse
// 只接受 schema_version===1、13 字段齐全、数组字段为数组的对象；validateCompactionSummary
// 保护五字段；selectProtectedRecentTurns 的 12 轮 / 大型工具输出 / 未闭合链 / 最新 2 轮边界。
import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACTION_PROMPT,
  PROTECTED_SUMMARY_FIELDS,
  SUMMARY_ARRAY_FIELDS,
  SUMMARY_FIELDS,
  parseCompactionResponse,
  selectProtectedRecentTurns,
  validateCompactionSummary
} from "../../src/core/agent/compaction-prompt.mjs";

// ---------------------------------------------------------------------------
// COMPACTION_PROMPT：规格草案 §6 逐字（LF 行尾、JSON 块两空格缩进）
// ---------------------------------------------------------------------------

const VERBATIM_PROMPT = `你正在为 WWriting 生成一个可恢复的上下文压缩检查点。

只依据输入材料中的可验证事实，不补造事实，不把模型猜测写成决定。
不要输出或重建私有 reasoning、思维链或隐藏分析；不要复制大段工具原文。
保留当前任务继续执行所必需的信息，并标明哪些内容已被省略、哪些信息需要重新读取文件确认。

请严格输出 JSON，不要输出 Markdown、解释文字或代码围栏：
{
  "schema_version": 1,
  "current_task": "当前仍要完成的用户目标",
  "user_confirmed_decisions": [],
  "verified_facts": [],
  "files_and_artifacts": [],
  "completed_steps": [],
  "pending_steps": [],
  "pending_decisions": [],
  "failures_and_recovery": [],
  "open_tool_calls": [],
  "recent_user_intent": "最近一条仍有效的用户意图",
  "omitted_information": [],
  "reload_from_workspace": []
}

字段要求：
- 数组元素短、可验证、可逐项恢复；没有内容时使用空数组。
- \`open_tool_calls\` 只记录未闭合调用的名称、id、参数摘要和下一步，不复制完整输出。
- \`reload_from_workspace\` 列出压缩后必须重新读取的 WWRITING.md、总纲、设定或其他权威文件。
- 不要把“可能”“大概”“应该”变成用户已确认决定。
`;

test("COMPACTION_PROMPT 是规格草案 §6 的逐字 JSON 指令", () => {
  assert.equal(COMPACTION_PROMPT, VERBATIM_PROMPT);
  // 关键哨兵行：禁止 reasoning/工具/Markdown/事实补造；不输出代码围栏
  assert.match(COMPACTION_PROMPT, /不要输出或重建私有 reasoning/u);
  assert.match(COMPACTION_PROMPT, /请严格输出 JSON，不要输出 Markdown、解释文字或代码围栏/u);
  assert.match(COMPACTION_PROMPT, /不补造事实，不把模型猜测写成决定/u);
  assert.match(COMPACTION_PROMPT, /不要把“可能”“大概”“应该”变成用户已确认决定/u);
  // 13 个字段全部出现在提示词 JSON 骨架中
  for (const field of SUMMARY_FIELDS) {
    assert.match(COMPACTION_PROMPT, new RegExp(`"${field}"`, "u"), `提示词必须包含字段 ${field}`);
  }
});

// ---------------------------------------------------------------------------
// parseCompactionResponse
// ---------------------------------------------------------------------------

function validSummary(overrides = {}) {
  return {
    schema_version: 1,
    current_task: "完成第三章初稿",
    user_confirmed_decisions: ["主角改名为林默"],
    verified_facts: ["林默 17 岁"],
    files_and_artifacts: ["chapters/003.md"],
    completed_steps: ["拟定第三章大纲"],
    pending_steps: ["写完第三章结尾"],
    pending_decisions: ["第三章是否保留梦境场景"],
    failures_and_recovery: ["第二章模型中断后已恢复"],
    open_tool_calls: [],
    recent_user_intent: "继续写第三章",
    omitted_information: ["第三章早期删改记录"],
    reload_from_workspace: ["WWRITING.md"],
    ...overrides
  };
}

test("parseCompactionResponse：接受合法 13 字段对象并原样返回", () => {
  const summary = validSummary();
  const text = JSON.stringify(summary);
  const parsed = parseCompactionResponse(text);
  assert.deepEqual(parsed, summary);
});

test("parseCompactionResponse：拒绝非 JSON、非字符串、数组与 null", () => {
  assert.throws(() => parseCompactionResponse("{ 不是 JSON"), (e) => e.code === "compaction_json");
  assert.throws(() => parseCompactionResponse("[1,2,3]"), (e) => e.code === "compaction_schema");
  assert.throws(() => parseCompactionResponse("null"), (e) => e.code === "compaction_schema");
  assert.throws(() => parseCompactionResponse("42"), (e) => e.code === "compaction_schema");
  assert.throws(() => parseCompactionResponse(null), (e) => e.code === "compaction_response_type");
  assert.throws(() => parseCompactionResponse(undefined), (e) => e.code === "compaction_response_type");
});

test("parseCompactionResponse：schema_version 必须严格等于 1", () => {
  assert.throws(() => parseCompactionResponse(JSON.stringify(validSummary({ schema_version: 2 }))), /schema/u);
  assert.throws(() => parseCompactionResponse(JSON.stringify(validSummary({ schema_version: "1" }))), /schema/u);
  const missing = validSummary();
  delete missing.schema_version;
  assert.throws(() => parseCompactionResponse(JSON.stringify(missing)), /schema/u);
});

test("parseCompactionResponse：13 个字段缺一不可", () => {
  for (const field of SUMMARY_FIELDS) {
    if (field === "schema_version") continue;
    const broken = validSummary();
    delete broken[field];
    assert.throws(
      () => parseCompactionResponse(JSON.stringify(broken)),
      (e) => e.code === "compaction_schema" && /schema/u.test(e.message) && e.message.includes(field),
      `缺少 ${field} 必须被拒绝`
    );
  }
});

test("parseCompactionResponse：10 个数组字段必须是数组，字符串字段必须是字符串", () => {
  for (const field of SUMMARY_ARRAY_FIELDS) {
    assert.throws(
      () => parseCompactionResponse(JSON.stringify(validSummary({ [field]: "不是数组" }))),
      (e) => e.code === "compaction_schema" && e.message.includes(field),
      `${field} 必须是数组`
    );
  }
  assert.throws(() => parseCompactionResponse(JSON.stringify(validSummary({ current_task: [] }))), /schema/u);
  assert.throws(() => parseCompactionResponse(JSON.stringify(validSummary({ recent_user_intent: 3 }))), /schema/u);
});

// ---------------------------------------------------------------------------
// validateCompactionSummary：五个保护字段
// ---------------------------------------------------------------------------

test("validateCompactionSummary：源状态非空时五字段不得被删除", () => {
  for (const field of PROTECTED_SUMMARY_FIELDS) {
    const sourceValue =
      field === "current_task" ? "当前任务不可丢" : [field === "open_tool_calls" ? { tool_call_id: "tc-1", name: "read_file" } : "源状态条目"];
    const summary = validSummary({ [field]: field === "current_task" ? "" : [] });
    assert.throws(
      () => validateCompactionSummary(summary, { [field]: sourceValue }),
      (e) => e.code === "compaction_protected_state" && e.message.includes(field),
      `源 ${field} 非空时摘要不得删除`
    );
  }
});

test("validateCompactionSummary：源状态为空时允许摘要为空数组", () => {
  const empty = validSummary({
    current_task: "",
    user_confirmed_decisions: [],
    pending_steps: [],
    open_tool_calls: [],
    reload_from_workspace: []
  });
  assert.deepEqual(validateCompactionSummary(empty, {}), { protected_state_ok: true });
});

test("validateCompactionSummary：保留源状态内容时通过", () => {
  const summary = validSummary();
  const source = {
    current_task: "完成第三章初稿",
    user_confirmed_decisions: ["主角改名为林默"],
    pending_steps: ["写完第三章结尾"],
    open_tool_calls: [],
    reload_from_workspace: ["WWRITING.md"]
  };
  assert.deepEqual(validateCompactionSummary(summary, source), { protected_state_ok: true });
});

// ---------------------------------------------------------------------------
// selectProtectedRecentTurns：12 轮 / 大型工具输出 / 未闭合链 / 最新 2 轮
// ---------------------------------------------------------------------------

function makeTurn(index, overrides = {}) {
  return {
    id: `turn-${index}`,
    user_text: `第 ${index} 轮用户输入`,
    assistant_text: `第 ${index} 轮助手回复`,
    token_estimate: 10,
    transcript_seq_start: index * 2 - 1,
    transcript_seq_end: index * 2,
    tool_activities: [],
    ...overrides
  };
}

test("selectProtectedRecentTurns：15 轮保留最近 12 轮原文，最早 3 轮进入摘要", () => {
  const turns = Array.from({ length: 15 }, (_, i) => makeTurn(i + 1));
  const result = selectProtectedRecentTurns({ turns, targetTokens: 100_000 });
  assert.equal(result.stats.total_turns, 15);
  assert.equal(result.protected_turns.length, 12);
  assert.equal(result.summarized_turns.length, 3);
  assert.deepEqual(result.protected_turns.map((t) => t.id), ["turn-4", "turn-5", "turn-6", "turn-7", "turn-8", "turn-9", "turn-10", "turn-11", "turn-12", "turn-13", "turn-14", "turn-15"]);
  assert.deepEqual(result.summarized_turns.map((t) => t.id), ["turn-1", "turn-2", "turn-3"]);
  assert.equal(result.stats.overshoot, false);
});

test("selectProtectedRecentTurns：12 轮超目标时从较早轮驱逐，最新 2 轮原文绝不移出", () => {
  // 每轮 10 token，12 轮 = 120；target = 25 → 驱逐到 2~3 轮；最新 2 轮必须保留
  const turns = Array.from({ length: 15 }, (_, i) => makeTurn(i + 1));
  const result = selectProtectedRecentTurns({ turns, targetTokens: 25 });
  assert.ok(result.stats.protected_tokens <= 25, `protected_tokens ${result.stats.protected_tokens} 应不超过 25`);
  assert.ok(result.protected_turns.length >= 2);
  assert.deepEqual(result.protected_turns.at(-1).id, "turn-15");
  assert.deepEqual(result.protected_turns.at(-2).id, "turn-14");
  assert.equal(result.stats.overshoot, false, "驱逐成功后被保护 token 不超目标");
  // 被驱逐的轮次进入摘要，且不含最新 2 轮
  assert.ok(result.summarized_turns.every((t) => t.id !== "turn-14" && t.id !== "turn-15"));
  assert.ok(result.summarized_turns.includes(result.summarized_turns.find((t) => t.id === "turn-4")));
});

test("selectProtectedRecentTurns：最新 2 轮自身也超目标时仍保留原文并标记超限", () => {
  const turns = Array.from({ length: 15 }, (_, i) => makeTurn(i + 1));
  const result = selectProtectedRecentTurns({ turns, targetTokens: 5 });
  assert.equal(result.protected_turns.length, 2);
  assert.deepEqual(result.protected_turns.map((t) => t.id), ["turn-14", "turn-15"]);
  assert.equal(result.stats.overshoot, true);
});

test("selectProtectedRecentTurns：最新 2 轮在任何预算下都保留原文", () => {
  const turns = Array.from({ length: 15 }, (_, i) => makeTurn(i + 1));
  const result = selectProtectedRecentTurns({ turns, targetTokens: 1 });
  assert.equal(result.protected_turns.length, 2);
  assert.deepEqual(result.protected_turns.map((t) => t.id), ["turn-14", "turn-15"]);
});

test("selectProtectedRecentTurns：已闭合大型工具输出只保留名称/结果摘要/Journal 引用", () => {
  const turns = [
    makeTurn(1, {
      tool_activities: [
        {
          tool_call_id: "tc-1",
          name: "read_file",
          status: "closed",
          arguments: { path: "chapter.md" },
          output: "甲".repeat(50_000),
          result_summary: "返回了章节正文（50000 字）",
          journal_ref: "seq 20-22"
        },
        {
          tool_call_id: "tc-2",
          name: "list_files",
          status: "closed",
          arguments: {},
          output: "少量输出",
          result_summary: null,
          journal_ref: "seq 23"
        }
      ]
    })
  ];
  const result = selectProtectedRecentTurns({ turns, targetTokens: 100_000, toolOutputThreshold: 1000 });
  const activities = result.protected_turns[0].tool_activities;
  const big = activities.find((a) => a.tool_call_id === "tc-1");
  assert.equal(big.output, null);
  assert.equal(big.name, "read_file");
  assert.equal(big.result_summary, "返回了章节正文（50000 字）");
  assert.equal(big.journal_ref, "seq 20-22");
  assert.equal(big.summarized_output, true);
  // 非大型/无摘要的已闭合输出保持原文
  const small = activities.find((a) => a.tool_call_id === "tc-2");
  assert.equal(small.output, "少量输出");
  assert.equal(small.summarized_output, undefined);
  // 输入不被修改
  assert.equal(turns[0].tool_activities[0].output.length, 50_000);
});

test("selectProtectedRecentTurns：未闭合 tool-call 链完整保留且不得被驱逐", () => {
  const turns = Array.from({ length: 15 }, (_, i) => makeTurn(i + 1));
  // turn-6 位于最近 12 轮窗口内（turns 4..15），token 巨大逼迫驱逐，但未闭合链轮次不可驱逐
  turns[5] = makeTurn(6, {
    token_estimate: 10_000,
    tool_activities: [
      { tool_call_id: "tc-open-1", name: "edit_file", status: "open", arguments: { path: "chapter.md" }, output: "正在编辑的中间状态", journal_ref: "seq 30" }
    ]
  });
  const result = selectProtectedRecentTurns({ turns, targetTokens: 40, toolOutputThreshold: 1 });
  // 含未闭合链的轮次必须在被保护轮中且输出完整
  const openTurn = result.protected_turns.find((t) => t.id === "turn-6");
  assert.ok(openTurn, "含未闭合链的轮次必须保留在 protected_turns 中");
  const openActivity = openTurn.tool_activities[0];
  assert.equal(openActivity.status, "open");
  assert.equal(openActivity.output, "正在编辑的中间状态");
  assert.equal(openActivity.summarized_output, undefined);
  // 最新 2 轮仍在
  assert.deepEqual(result.protected_turns.at(-1).id, "turn-15");
  assert.deepEqual(result.protected_turns.at(-2).id, "turn-14");
});
