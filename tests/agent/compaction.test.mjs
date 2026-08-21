// 结构化压缩契约测试（统一 Journal/上下文窗口/自动压缩计划 Task 7）。
//
// 覆盖（brief Step 3）：COMPACTION_PROMPT 为规格草案 §6 逐字文本；parseCompactionResponse
// 只接受 schema_version===1、13 字段齐全、数组字段为数组的对象；validateCompactionSummary
// 保护五字段；selectProtectedRecentTurns 的 12 轮 / 大型工具输出 / 未闭合链 / 最新 2 轮边界。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  COMPACTION_PROMPT,
  PROTECTED_SUMMARY_FIELDS,
  SUMMARY_ARRAY_FIELDS,
  SUMMARY_FIELDS,
  parseCompactionResponse,
  selectProtectedRecentTurns,
  validateCompactionSummary
} from "../../src/core/agent/compaction-prompt.mjs";
import { createCompactionCoordinator } from "../../src/core/agent/compaction.mjs";
import { FIXED_EVENT_TYPES, createAgentJournal } from "../../src/core/agent/journal.mjs";

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

test("selectProtectedRecentTurns：无 result_summary 的大型闭合输出也本地截断（不再保留全文）", () => {
  // 回归：transcript 重建的轮次永远没有 result_summary（runtime 注释明确
  // 「transcript 不存 result_summary」）——旧代码因此把大输出原文保留在保护窗，
  // 「12 轮中的每一个步骤都保留了」；修复后本地截断生成摘要 + Journal 引用。
  const turns = [
    makeTurn(1, {
      tool_activities: [
        {
          tool_call_id: "tc-1",
          name: "shell",
          status: "closed",
          arguments: {},
          output: "乙".repeat(50_000),
          result_summary: null,
          journal_ref: "seq 30"
        }
      ]
    })
  ];
  const result = selectProtectedRecentTurns({ turns, targetTokens: 100_000, toolOutputThreshold: 1000 });
  const activity = result.protected_turns[0].tool_activities[0];
  assert.equal(activity.output, null, "大输出必须被替换（不得保留原文）");
  assert.equal(activity.summarized_output, true);
  assert.ok(activity.result_summary.includes("本地截断"), "无 result_summary 时生成本地截断摘要");
  assert.ok(activity.result_summary.includes("seq 30"), "摘要必须带 Journal 引用");
  assert.ok(activity.result_summary.length < 2000, `本地截断摘要必须远小于原文（实际 ${activity.result_summary.length} 字符）`);
  assert.ok(activity.result_summary.includes("乙".repeat(10)), "摘要保留输出头部片段供模型参考");
});

test("selectProtectedRecentTurns：预算优先——摘要化后占用达标时不驱逐（轮数少但大输出多）", () => {
  // 用户场景：8 轮（<12 轮保护窗），每轮含 20k 字符大输出。旧代码按原文 token
  // 驱逐 → 即便大输出截断后只占几十 token，也会把早期轮次驱逐进摘要（或 summarized
  // 为空直接 noop）；修复后驱逐判定基于摘要化后的真实占用 → 全部保留原文轮次。
  const turns = Array.from({ length: 8 }, (_, i) =>
    makeTurn(i + 1, {
      token_estimate: null, // 走内容估算（默认 10 会掩盖驱逐判定）
      tool_activities: [
        {
          tool_call_id: `tc-${i + 1}`,
          name: "shell",
          status: "closed",
          arguments: {},
          output: "丙".repeat(20_000),
          result_summary: null,
          journal_ref: `seq ${(i + 1) * 4}`
        }
      ]
    })
  );
  const result = selectProtectedRecentTurns({ turns, targetTokens: 64_000, toolOutputThreshold: 2000 });
  assert.equal(result.summarized_turns.length, 0, "摘要化后占用低于预算 → 不驱逐（8 轮全部保留）");
  assert.equal(result.protected_turns.length, 8);
  assert.equal(result.stats.overshoot, false);
  assert.ok(
    result.protected_turns.every((turn) => turn.tool_activities[0].summarized_output === true),
    "大输出全部被本地截断"
  );
  assert.ok(
    result.stats.protected_tokens < 10_000,
    `摘要化后被保护占用必须远小于预算（实际 ${result.stats.protected_tokens}；原文 ≈160k+）`
  );
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

// ---------------------------------------------------------------------------
// Task 8：压缩状态机（coordinator 单测，fake gateway/clock/checkpoint store；
// 与 real journal 的集成在 project-agent.test.mjs / journal-recovery.test.mjs）
// ---------------------------------------------------------------------------

const BASE_TIME = Date.parse("2026-08-08T00:00:00.000Z");

function fakeClock() {
  let n = 0;
  return () => BASE_TIME + n++ * 1000;
}

function fakeId() {
  let n = 0;
  return () => `id-${(n += 1)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// journal fake：只记录事件（coordinator 追加的压缩事件不做 reducer 校验）。
function createFakeJournal() {
  const recorded = [];
  return {
    _events: recorded,
    async append(event) {
      const stamped = {
        schema_version: 2,
        seq: recorded.length + 1,
        event_id: event.event_id ?? `evt-${recorded.length + 1}`,
        session_id: "session-1",
        run_id: event.run_id ?? null,
        project_root: "project",
        type: event.type,
        at: new Date(BASE_TIME + recorded.length * 1000).toISOString(),
        payload: event.payload ?? {}
      };
      recorded.push(stamped);
      return stamped;
    },
    async read({ afterSeq = 0, limit } = {}) {
      let out = recorded.filter((event) => event.seq > afterSeq);
      if (limit != null) out = out.slice(0, limit);
      return out;
    }
  };
}

// checkpoint store fake：commit 时向 journal 追加 completed 并切换指针。
function createFakeCheckpointStore({ oldCheckpointId = null } = {}) {
  let pointer = {
    schema_version: 1,
    checkpoint_id: oldCheckpointId,
    commit_id: null,
    committed_at: null,
    source_seq_end: null,
    sha256: null
  };
  let failCommit = false;
  return {
    _setFailCommit(value) {
      failCommit = value;
    },
    async readActive() {
      return { ...pointer };
    },
    async writeCandidate(candidate) {
      return `candidate-${candidate.checkpoint_id}`;
    },
    async validateCandidate() {
      return { schema_ok: true, protected_state_ok: true, target_ok: true, hash_ok: false };
    },
    async commitCandidate(candidate, { journal, commitEvent } = {}) {
      if (failCommit) {
        const error = new Error("故障注入：提交失败");
        error.code = "checkpoint_write_failed";
        throw error;
      }
      const payload = {
        compaction_id: commitEvent?.payload?.compaction_id ?? null,
        trigger: candidate.trigger ?? null,
        attempt: commitEvent?.payload?.attempt ?? 1,
        source_checkpoint_id: candidate.source_checkpoint_id ?? null,
        checkpoint_id: candidate.checkpoint_id,
        source_seq: candidate.source_seq ?? null,
        source_transcript_seq: candidate.source_transcript_seq ?? null,
        provider_model_id: candidate.provider_model_id ?? null,
        estimated_tokens_before: commitEvent?.payload?.estimated_tokens_before ?? null,
        estimated_tokens_after: commitEvent?.payload?.estimated_tokens_after ?? null,
        released_tokens: commitEvent?.payload?.released_tokens ?? null,
        summary_schema_version: 1,
        duration_ms: commitEvent?.payload?.duration_ms ?? null,
        validation: { schema_ok: true, protected_state_ok: true, target_ok: true, hash_ok: true },
        error_code: null,
        cancel_reason: null
      };
      if (journal) {
        await journal.append({ event_id: commitEvent?.event_id, type: "context_compaction_completed", payload });
      }
      pointer = {
        schema_version: 1,
        checkpoint_id: candidate.checkpoint_id,
        commit_id: commitEvent?.payload?.compaction_id ?? null,
        committed_at: new Date().toISOString(),
        source_seq_end: candidate.source_seq?.end ?? null,
        sha256: "hash"
      };
      return { checkpoint_id: candidate.checkpoint_id, event_id: commitEvent?.event_id, sha256: "hash", pointer: { ...pointer }, validation: payload.validation };
    },
    async discardCandidate() {},
    async reconcileAfterCrash() {
      return { status: "noop", cleaned: [], appended: [] };
    }
  };
}

function makeModelConfig(overrides = {}) {
  return {
    provider: "mock",
    model_name: "mock-model",
    configured_model_id: "mock-model",
    effective_context_window: 256_000,
    compaction_threshold: 204_800,
    window_source: "default_256k",
    ...overrides
  };
}

function fakeBuildInput(overrides = {}) {
  const sourceState = {
    source_checkpoint_id: null,
    source_seq: { start: 1, end: 40 },
    source_transcript_seq: { start: 1, end: 20 },
    configured_model_id: "mock-model",
    provider_model_id: "mock-model",
    trigger: "automatic",
    effective_context_window: 256_000,
    target_tokens: 64_000,
    current_task: "完成第三章初稿",
    user_confirmed_decisions: ["主角改名为林默"],
    pending_steps: ["写完第三章结尾"],
    open_tool_calls: [],
    reload_from_workspace: ["WWRITING.md"]
  };
  return async () => ({
    sourceMaterial: "压缩源材料：早期历史",
    sourceState,
    recent_messages: [{ role: "user", content: "最近原文" }],
    open_tool_calls: [],
    reload_from_workspace: ["WWRITING.md"],
    estimated_tokens_before: 90_000,
    noop: false,
    ...overrides
  });
}

// fake gateway：脚本 + 调用记录（含 signal，供取消断言）。
function createFakeGateway({ script = [], delayMs = 0 } = {}) {
  const calls = [];
  let cursor = 0;
  return {
    calls,
    async complete(request, { signal } = {}) {
      const entry = script[cursor] ?? null;
      if (entry && !entry.repeat) cursor += 1;
      if (delayMs > 0) await sleep(delayMs);
      if (entry && typeof entry === "function") {
        const started = { request, signal };
        calls.push(started);
        const reply = await entry(request, { signal });
        started.reply = reply;
        if (reply?.error) throw reply.error;
        return reply;
      }
      if (entry?.error) {
        calls.push({ request, signal, reply: { error: entry.error } });
        throw entry.error;
      }
      const reply = entry?.reply ?? { text: "（默认答复）" };
      calls.push({ request, signal, reply });
      return reply;
    }
  };
}

function transientError(code = "provider_transport_error", reason = "network") {
  const error = new Error(`传输错误：${reason}`);
  error.code = code;
  error.reason = reason;
  return error;
}

function createCoordinator({ journal, gateway, store, buildInput } = {}) {
  return createCompactionCoordinator({
    journal: journal ?? createFakeJournal(),
    gateway,
    checkpointStore: store ?? createFakeCheckpointStore(),
    buildInput: buildInput ?? fakeBuildInput(),
    clock: fakeClock(),
    idFactory: fakeId()
  });
}

async function waitForEvent(journal, type, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (journal._events.some((event) => event.type === type)) return;
    await sleep(5);
  }
  throw new Error(`等待事件 ${type} 超时`);
}

test("coordinator：源材料超出窗口（too_large）→ 快速失败不调用模型，错误码固定，retry 同源同失败", async () => {
  const journal = createFakeJournal();
  const gateway = createFakeGateway();
  const tooLargeBuildInput = async () => ({
    noop: false,
    too_large: true,
    reason: "source_exceeds_window",
    sourceMaterial: "x".repeat(400_000),
    sourceState: {
      source_checkpoint_id: null,
      source_seq: { start: 1, end: 40 },
      source_transcript_seq: { start: 1, end: 20 },
      configured_model_id: "mock-model",
      provider_model_id: "mock-model",
      trigger: "automatic",
      effective_context_window: 256_000,
      target_tokens: 64_000,
      current_task: "",
      user_confirmed_decisions: [],
      pending_steps: [],
      open_tool_calls: [],
      reload_from_workspace: []
    },
    estimated_tokens_before: 260_000,
    modelConfig: makeModelConfig()
  });
  const coordinator = createCoordinator({
    journal,
    gateway,
    buildInput: tooLargeBuildInput
  });
  const result = await coordinator.start({ projectRoot: "/p", trigger: "automatic", modelConfig: makeModelConfig() });
  assert.equal(result.status, "failed");
  assert.equal(result.error_code, "compaction_source_exceeds_window");
  assert.equal(gateway.calls.length, 0, "超窗源材料不得调用模型（provider 拒绝会让 Run 永久卡死）");
  const events = journal._events;
  assert.equal(events.some((e) => e.type === "context_compaction_started"), false, "不得追加 started（无模型调用）");
  const failed = events.find((e) => e.type === "context_compaction_failed");
  assert.ok(failed, "必须追加 context_compaction_failed");
  assert.equal(failed.payload.error_code, "compaction_source_exceeds_window");
  assert.equal(failed.payload.compaction_id, result.compaction_id);
  assert.equal(failed.payload.estimated_tokens_before, 260_000);
  // retry：重建源后仍超窗 → 同样快速失败，不调用模型
  const retried = await coordinator.retry({ compactionId: result.compaction_id });
  assert.equal(retried.status, "failed");
  assert.equal(retried.error_code, "compaction_source_exceeds_window");
  assert.equal(gateway.calls.length, 0, "retry 同样不得调用模型");
  const failedEvents = events.filter((e) => e.type === "context_compaction_failed");
  assert.equal(failedEvents.length, 2, "start 与 retry 各追加一次 failed");
});

test("coordinator：取消与提交竞态（cancel 落在提交期间）→ 提交胜出，不追加 cancelled，cancel 报告 completed", async () => {
  const journal = createFakeJournal();
  const gateway = createFakeGateway({ script: [{ reply: { text: JSON.stringify(validSummary()) } }] });
  // 挡住 writeCandidate：让 cancel 精确落在"reply 已到、提交进行中"的窗口
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const baseStore = createFakeCheckpointStore();
  const store = {
    ...baseStore,
    async writeCandidate(input) {
      await writeGate;
      return baseStore.writeCandidate(input);
    }
  };
  const coordinator = createCoordinator({ journal, gateway, store });
  const startPromise = coordinator.start({ projectRoot: "/p", trigger: "automatic", modelConfig: makeModelConfig() });
  await waitForEvent(journal, "context_compaction_running");
  await sleep(20); // 微任务链推进到 writeCandidate（被 writeGate 挡住）
  const compactionId = journal._events.find((e) => e.type === "context_compaction_started").payload.compaction_id;
  const cancelPromise = coordinator.cancel({ compactionId });
  await sleep(10);
  releaseWrite();
  const startResult = await startPromise;
  const cancelResult = await cancelPromise;
  assert.equal(startResult.status, "completed", "提交胜出：start 收敛 completed");
  assert.equal(cancelResult.status, "completed", "cancel 必须按实际终态（completed）报告，不得误报取消");
  assert.equal(cancelResult.checkpoint_id, startResult.checkpoint_id);
  assert.equal(
    journal._events.some((e) => e.type === "context_compaction_cancelled"),
    false,
    "指针已切换后绝不追加 cancelled（否则 UI 显示已取消而上下文已切换）"
  );
  const completed = journal._events.filter((e) => e.type === "context_compaction_completed");
  assert.equal(completed.length, 1, "completed 恰好一次");
  assert.equal(journal._events.filter((e) => e.type === "context_compaction_failed").length, 0, "无 failed");
});

test("coordinator.start：成功事件顺序严格为 started → running → completed，request 形状固定", async () => {
  const journal = createFakeJournal();
  const gateway = createFakeGateway({ script: [{ reply: { text: JSON.stringify(validSummary()) } }] });
  const store = createFakeCheckpointStore({ oldCheckpointId: "ck-old" });
  const coordinator = createCoordinator({ journal, gateway, store });
  const modelConfig = makeModelConfig();
  const outcome = await coordinator.start({
    projectRoot: "project",
    trigger: "automatic",
    pendingInputId: "in-1",
    modelConfig,
    signal: new AbortController().signal
  });
  assert.equal(outcome.status, "completed");
  assert.ok(outcome.compaction_id && outcome.checkpoint_id);
  assert.deepEqual(
    journal._events.map((event) => event.type),
    ["context_compaction_started", "context_compaction_running", "context_compaction_completed"]
  );
  // request 形状（brief Step 2 逐字）
  assert.equal(gateway.calls.length, 1);
  const request = gateway.calls[0].request;
  assert.deepEqual(request.messages[0], { role: "system", content: COMPACTION_PROMPT });
  assert.equal(request.messages[1].role, "user");
  assert.equal(request.messages[1].content, "压缩源材料：早期历史");
  assert.equal(request.tools, undefined);
  assert.equal(request.toolChoice, undefined);
  assert.equal(request.stream, false);
  assert.equal(request.modelConfig, modelConfig, "压缩调用携带当前 modelConfig");
  assert.equal(request.metadata.stage, "context_compaction");
  assert.equal(request.metadata.cacheable, false);
  assert.equal(request.metadata.compaction_id, outcome.compaction_id);
  // completed payload 固定字段（不可用值写 null）
  const completed = journal._events.find((event) => event.type === "context_compaction_completed");
  assert.equal(completed.payload.compaction_id, outcome.compaction_id);
  assert.equal(completed.payload.trigger, "automatic");
  assert.equal(completed.payload.attempt, 1);
  assert.equal(completed.payload.source_checkpoint_id, "ck-old");
  assert.equal(completed.payload.checkpoint_id, outcome.checkpoint_id);
  assert.deepEqual(completed.payload.source_seq, { start: 1, end: 40 });
  assert.deepEqual(completed.payload.source_transcript_seq, { start: 1, end: 20 });
  assert.equal(completed.payload.provider_model_id, "mock-model");
  assert.equal(completed.payload.estimated_tokens_before, 90_000);
  assert.equal(completed.payload.summary_schema_version, 1);
  assert.equal(typeof completed.payload.duration_ms, "number");
  assert.deepEqual(completed.payload.validation, { schema_ok: true, protected_state_ok: true, target_ok: true, hash_ok: true });
  assert.equal(completed.payload.error_code, null);
  assert.equal(completed.payload.cancel_reason, null);
  // 指针切换到新 checkpoint
  assert.equal((await store.readActive()).checkpoint_id, outcome.checkpoint_id);
});

test("coordinator.start：第一次瞬时传输错误后自动再请求一次，第二次成功（adapter 请求数为 2）", async () => {
  const journal = createFakeJournal();
  const gateway = createFakeGateway({
    script: [
      { error: transientError("provider_transport_error", "network") },
      { reply: { text: JSON.stringify(validSummary()) } }
    ]
  });
  const coordinator = createCoordinator({ journal, gateway });
  const outcome = await coordinator.start({
    projectRoot: "project",
    trigger: "automatic",
    pendingInputId: "in-1",
    modelConfig: makeModelConfig(),
    signal: new AbortController().signal
  });
  assert.equal(outcome.status, "completed");
  assert.equal(gateway.calls.length, 2);
  // 自动重试属于同一压缩 attempt（spec §6）：attempt 保持 1
  assert.deepEqual(
    journal._events.map((event) => event.type),
    ["context_compaction_started", "context_compaction_running", "context_compaction_completed"]
  );
  assert.equal(journal._events.at(-1).payload.attempt, 1);
});

test("coordinator.start：schema 失败不自动第二次请求", async () => {
  const journal = createFakeJournal();
  const gateway = createFakeGateway({ script: [{ reply: { text: "{ 不是 JSON" } }] });
  const coordinator = createCoordinator({ journal, gateway });
  const outcome = await coordinator.start({
    projectRoot: "project",
    trigger: "automatic",
    modelConfig: makeModelConfig(),
    signal: new AbortController().signal
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error_code, "compaction_json");
  assert.equal(gateway.calls.length, 1, "结构失败不得重复请求");
  assert.deepEqual(
    journal._events.map((event) => event.type),
    ["context_compaction_started", "context_compaction_running", "context_compaction_failed"]
  );
  const failed = journal._events.at(-1);
  assert.equal(failed.payload.error_code, "compaction_json");
  assert.equal(failed.payload.compaction_id, outcome.compaction_id);
});

test("coordinator.start：持久化失败不自动第二次请求", async () => {
  const journal = createFakeJournal();
  const gateway = createFakeGateway({ script: [{ reply: { text: JSON.stringify(validSummary()) } }] });
  const store = createFakeCheckpointStore();
  store._setFailCommit(true);
  const coordinator = createCoordinator({ journal, gateway, store });
  const outcome = await coordinator.start({
    projectRoot: "project",
    trigger: "automatic",
    modelConfig: makeModelConfig(),
    signal: new AbortController().signal
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error_code, "checkpoint_write_failed");
  assert.equal(gateway.calls.length, 1, "持久化失败不得重复请求");
  assert.equal(journal._events.at(-1).type, "context_compaction_failed");
});

test("coordinator：第二次失败后 failed，retry 产生新 attempt（attempt=2），cancel 对终态幂等", async () => {
  const journal = createFakeJournal();
  const gateway = createFakeGateway({
    script: [
      { error: transientError("provider_transport_error", "server-retryable") },
      { error: transientError("provider_transport_error", "timeout") },
      { reply: { text: JSON.stringify(validSummary()) } }
    ]
  });
  const coordinator = createCoordinator({ journal, gateway });
  const first = await coordinator.start({
    projectRoot: "project",
    trigger: "manual",
    modelConfig: makeModelConfig(),
    signal: new AbortController().signal
  });
  assert.equal(first.status, "failed");
  assert.equal(gateway.calls.length, 2, "第二次仍失败即熔断，不再请求");
  assert.equal(journal._events.at(-1).type, "context_compaction_failed");
  // 用户手动重试：新 attempt（attempt=2），成功
  const retried = await coordinator.retry({ compactionId: first.compaction_id, signal: new AbortController().signal });
  assert.equal(retried.status, "completed");
  assert.equal(retried.attempt, 2);
  const startedEvents = journal._events.filter((event) => event.type === "context_compaction_started");
  assert.equal(startedEvents.length, 2);
  assert.equal(startedEvents[1].payload.attempt, 2);
  // 终态上 cancel：无操作
  const cancelled = await coordinator.cancel({ compactionId: first.compaction_id });
  assert.equal(cancelled.status, "already_terminal");
});

test("coordinator：running 中 cancel 先追加 cancel_requested，底层结束后才追加 cancelled，旧 checkpoint 不变", async () => {
  const journal = createFakeJournal();
  const gateway = createFakeGateway({
    script: [
      (request, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          }, { once: true });
        })
    ]
  });
  const store = createFakeCheckpointStore({ oldCheckpointId: "ck-old" });
  const coordinator = createCoordinator({ journal, gateway, store });
  const startPromise = coordinator.start({
    projectRoot: "project",
    trigger: "automatic",
    pendingInputId: "in-1",
    modelConfig: makeModelConfig(),
    signal: new AbortController().signal
  });
  await waitForEvent(journal, "context_compaction_running");
  const started = journal._events.find((event) => event.type === "context_compaction_started");
  const cancelPromise = coordinator.cancel({ compactionId: started.payload.compaction_id });
  const cancelled = await cancelPromise;
  assert.equal(cancelled.status, "cancelled");
  const outcome = await startPromise;
  assert.equal(outcome.status, "cancelled");
  // 顺序：cancel_requested 必须先于 cancelled；cancelled 只在底层结束后追加
  assert.deepEqual(
    journal._events.map((event) => event.type),
    ["context_compaction_started", "context_compaction_running", "context_compaction_cancel_requested", "context_compaction_cancelled"]
  );
  assert.equal(journal._events.at(-1).payload.cancel_reason, "user_cancel");
  assert.ok(!journal._events.some((event) => event.type === "context_compaction_completed"));
  // 旧 active checkpoint 不变（取消不覆盖指针）
  assert.equal((await store.readActive()).checkpoint_id, "ck-old");
  // 底层请求确实被 abort（ESC 复用同一 signal 链）
  assert.equal(gateway.calls[0].signal.aborted, true);
});

test("coordinator.retry：进程重启后可凭 journal 事件重建 entry（无内存态时从 started 事件恢复）", async () => {
  // 场景：压缩在 attempt 1 失败后进程重启 → coordinator 无内存 entry；
  // retry 从 journal 的 started 事件重建 entry 并继续（不重新 start）。
  const journal = createFakeJournal();
  const gateway = createFakeGateway({ script: [{ reply: { text: JSON.stringify(validSummary()) } }] });
  const coordinator = createCoordinator({ journal, gateway });
  // 手工写入一次失败的压缩事件（模拟重启现场：started + running + failed）
  await journal.append({
    type: "context_compaction_started",
    payload: { compaction_id: "comp-restart", trigger: "automatic", attempt: 1, source_checkpoint_id: null, checkpoint_id: "ck-restart", pending_input_id: "in-9", started_at: new Date(BASE_TIME).toISOString() }
  });
  await journal.append({ type: "context_compaction_running", payload: { compaction_id: "comp-restart", trigger: "automatic", attempt: 1 } });
  await journal.append({
    type: "context_compaction_failed",
    payload: { compaction_id: "comp-restart", trigger: "automatic", attempt: 1, error_code: "provider_transport_error" }
  });
  const retried = await coordinator.retry({ compactionId: "comp-restart", signal: new AbortController().signal });
  assert.equal(retried.status, "completed");
  assert.equal(retried.attempt, 2);
  const startedEvents = journal._events.filter((event) => event.type === "context_compaction_started");
  assert.equal(startedEvents.length, 2);
  assert.equal(startedEvents[1].payload.attempt, 2);
  assert.equal(startedEvents[1].payload.compaction_id, "comp-restart");
  assert.equal(startedEvents[1].payload.checkpoint_id, "ck-restart");
  assert.equal(startedEvents[1].payload.pending_input_id, "in-9");
  assert.equal(journal._events.at(-1).type, "context_compaction_completed");
});

// ---------------------------------------------------------------------------
// Task 8：journal reducer 压缩投影（真实 journal）
// ---------------------------------------------------------------------------

async function makeTmpDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ww-compaction-journal-"));
  t.after(() => rmTree(root));
  return root;
}

function createRealJournal(t, root) {
  return createAgentJournal({ projectRoot: root, clock: fakeClock(), idFactory: fakeId() });
}

test("FIXED_EVENT_TYPES 包含 7 个压缩事件类型", () => {
  for (const type of [
    "context_compaction_started",
    "context_compaction_running",
    "context_compaction_cancel_requested",
    "context_compaction_completed",
    "context_compaction_failed",
    "context_compaction_cancelled",
    "context_compaction_noop"
  ]) {
    assert.ok(FIXED_EVENT_TYPES.includes(type), `FIXED_EVENT_TYPES 必须包含 ${type}`);
  }
});

test("journal reducer：session 初始含 compaction 相关投影字段", async (t) => {
  const root = await makeTmpDir(t);
  const journal = createRealJournal(t, root);
  const session = await journal.load();
  assert.equal(session.active_context_checkpoint_id, null);
  assert.equal(session.compaction, null);
  assert.equal(session.history_degraded, false);
  assert.deepEqual(session.history_gaps, []);
});

test("journal reducer：压缩事件只更新 compaction projection，不改变 active_input_id；completed 才切换 active 指针", async (t) => {
  const root = await makeTmpDir(t);
  const journal = createRealJournal(t, root);
  await journal.append({ type: "input_queued", payload: { input_id: "in-1", text: "一" } });
  await journal.append({ type: "run_started", run_id: "run-1", payload: { workflow: "general", input_id: "in-1" } });
  let session = await journal.getSession();
  assert.equal(session.active_run.active_input_id, "in-1");

  // started/running/cancel_requested：只更新 compaction 投影
  await journal.append({
    type: "context_compaction_started",
    payload: { compaction_id: "comp-1", trigger: "automatic", attempt: 1, source_checkpoint_id: null, checkpoint_id: "ck-1", pending_input_id: "in-1", started_at: new Date(BASE_TIME).toISOString() }
  });
  session = await journal.getSession();
  assert.equal(session.compaction.state, "started");
  assert.equal(session.compaction.id, "comp-1");
  assert.equal(session.compaction.trigger, "automatic");
  assert.equal(session.compaction.attempt, 1);
  assert.equal(session.compaction.source_checkpoint_id, null);
  assert.equal(session.compaction.checkpoint_id, "ck-1");
  assert.equal(session.compaction.pending_input_id, "in-1");
  assert.equal(session.active_run.active_input_id, "in-1", "started 不得改变普通 Run 的 active_input_id");
  assert.equal(session.active_context_checkpoint_id, null);

  await journal.append({ type: "context_compaction_running", payload: { compaction_id: "comp-1", trigger: "automatic", attempt: 1 } });
  session = await journal.getSession();
  assert.equal(session.compaction.state, "running");
  assert.equal(session.active_run.active_input_id, "in-1", "running 不得改变 active_input_id");

  await journal.append({ type: "context_compaction_cancel_requested", payload: { compaction_id: "comp-1", trigger: "automatic", cancel_reason: "user_esc" } });
  session = await journal.getSession();
  assert.equal(session.compaction.state, "cancelling");

  // 取消：不切换 active 指针
  await journal.append({
    type: "context_compaction_cancelled",
    payload: { compaction_id: "comp-1", trigger: "automatic", attempt: 1, cancel_reason: "user_esc" }
  });
  session = await journal.getSession();
  assert.equal(session.compaction.state, "cancelled");
  assert.equal(session.compaction.error_code, null);
  assert.equal(session.active_context_checkpoint_id, null, "cancelled 必须保持旧 active 指针");
  assert.equal(session.active_run.active_input_id, "in-1", "cancelled 事件本身不终结输入（收敛由 runtime 负责）");
});

test("journal reducer：completed 切换 active_context_checkpoint_id；failed 保持旧值并记录 error_code", async (t) => {
  const root = await makeTmpDir(t);
  const journal = createRealJournal(t, root);
  // 压缩 1 完成 → active 指针切换到 ck-1
  await journal.append({
    type: "context_compaction_started",
    payload: { compaction_id: "comp-1", trigger: "automatic", attempt: 1, source_checkpoint_id: null, checkpoint_id: "ck-1", pending_input_id: "in-1", started_at: new Date(BASE_TIME).toISOString() }
  });
  await journal.append({
    type: "context_compaction_completed",
    payload: { compaction_id: "comp-1", trigger: "automatic", attempt: 1, checkpoint_id: "ck-1", source_checkpoint_id: null }
  });
  let session = await journal.getSession();
  assert.equal(session.compaction.state, "completed");
  assert.equal(session.active_context_checkpoint_id, "ck-1", "completed 才切换 active 指针");
  // 压缩 2 失败 → active 指针保持 ck-1，error_code 记录
  await journal.append({
    type: "context_compaction_started",
    payload: { compaction_id: "comp-2", trigger: "automatic", attempt: 1, source_checkpoint_id: "ck-1", checkpoint_id: "ck-2", pending_input_id: "in-2", started_at: new Date(BASE_TIME).toISOString() }
  });
  await journal.append({
    type: "context_compaction_failed",
    payload: { compaction_id: "comp-2", trigger: "automatic", attempt: 1, error_code: "compaction_json" }
  });
  session = await journal.getSession();
  assert.equal(session.compaction.state, "failed");
  assert.equal(session.compaction.error_code, "compaction_json");
  assert.equal(session.compaction.source_checkpoint_id, "ck-1");
  assert.equal(session.active_context_checkpoint_id, "ck-1", "failed 必须保持旧 active 指针");
});

test("journal reducer：noop 事件把 compaction 投影置为 noop", async (t) => {
  const root = await makeTmpDir(t);
  const journal = createRealJournal(t, root);
  await journal.append({
    type: "context_compaction_noop",
    payload: { compaction_id: "comp-noop", trigger: "manual", reason: "nothing_to_compact" }
  });
  const session = await journal.getSession();
  assert.equal(session.compaction.state, "noop");
  assert.equal(session.compaction.trigger, "manual");
  assert.equal(session.compaction.id, "comp-noop");
  assert.equal(session.active_context_checkpoint_id, null);
});

test("journal reducer：压缩事件与当前 compaction_id 不一致时拒绝", async (t) => {
  const root = await makeTmpDir(t);
  const journal = createRealJournal(t, root);
  await journal.append({
    type: "context_compaction_started",
    payload: { compaction_id: "comp-1", trigger: "automatic", attempt: 1, checkpoint_id: "ck-1", started_at: new Date(BASE_TIME).toISOString() }
  });
  await assert.rejects(
    () => journal.append({ type: "context_compaction_failed", payload: { compaction_id: "comp-other", attempt: 1, error_code: "x" } }),
    /compaction_id/u
  );
});

// ---------------------------------------------------------------------------
// Task 8 fix：重启崩溃窗口（runtime open() 收敛 + retry/cancel 可用）与
// noop→硬窗口路径（brief Step 1 case 8 覆盖 started/cancelling/failed）
// ---------------------------------------------------------------------------

import {
  createMockModelGateway,
  createProjectAgentHarness,
  eventsOfType,
  readEvents,
  readSession,
  rmTree,
  waitFor,
  waitForIdle
} from "../helpers/project-agent-harness.mjs";

// 手工构造"进程在压缩中途崩溃"的 journal（真实 journal 实例，session.json 锚点
// 停在最后一条事件）：compactionState ∈ started/running/cancelling/failed/
// cancelled。failed/cancelled 表示"终态事件已落盘而 Run/input 收敛未落盘"的
// 崩溃窗口。seedTranscript 为 retry 播种 >12 轮历史（保证 retry 非 noop）。
// Task 13：新 generation 只有 sessions/<id>/ 布局——先在注册表建会话，再在会话
// 目录构造崩溃现场 journal（open 重启恢复读取同一位置；根级 journal 不再被收养）。
async function buildCrashWindowJournal(h, { compactionState, inputText = "压缩后继续的输入", seedTranscript = false } = {}) {
  const meta = await h.agent.newSession({ projectRoot: h.projectRoot, title: "崩溃窗口" });
  const journal = createAgentJournal({
    projectRoot: h.projectRoot,
    storageRoot: path.join(h.agentRoot, "sessions", meta.session_id),
    initialSessionId: meta.session_id
  });
  await journal.load();
  if (seedTranscript) {
    for (let i = 0; i < 14; i += 1) {
      await journal.appendTranscript({ role: "user", content: `第 ${i} 轮`, input_id: `seed-${i}` });
      await journal.appendTranscript({ role: "assistant", content: `回复 ${i}` });
    }
  }
  const inputId = `crash-in-${compactionState}`;
  const runId = `crash-run-${compactionState}`;
  const compactionId = `crash-comp-${compactionState}`;
  const batch = [
    { type: "input_queued", payload: { input_id: inputId, text: inputText, source: "chat" } },
    { type: "run_started", run_id: runId, payload: { workflow: "general", input_id: inputId } },
    {
      type: "context_compaction_started",
      payload: {
        compaction_id: compactionId,
        trigger: "automatic",
        attempt: 1,
        source_checkpoint_id: null,
        checkpoint_id: "ck-crash",
        pending_input_id: inputId,
        started_at: new Date().toISOString()
      }
    }
  ];
  if (compactionState !== "started") {
    batch.push({ type: "context_compaction_running", payload: { compaction_id: compactionId, trigger: "automatic", attempt: 1 } });
  }
  if (compactionState === "cancelling" || compactionState === "cancelled") {
    batch.push({ type: "context_compaction_cancel_requested", payload: { compaction_id: compactionId, trigger: "automatic", cancel_reason: "user_esc" } });
  }
  if (compactionState === "failed") {
    batch.push({ type: "context_compaction_failed", payload: { compaction_id: compactionId, trigger: "automatic", attempt: 1, error_code: "compaction_json" } });
  }
  if (compactionState === "cancelled") {
    batch.push({ type: "context_compaction_cancelled", payload: { compaction_id: compactionId, trigger: "automatic", attempt: 1, cancel_reason: "user_esc" } });
  }
  await journal.appendBatch(batch);
  return { journal, inputId, runId, compactionId };
}

function crashWindowGatewayScript() {
  return [
    (request) =>
      request.metadata?.stage === "context_compaction"
        ? { text: JSON.stringify(validSummary()) }
        : { text: "正常回复。" },
    () => ({ text: "后续回复。" })
  ];
}

test("重启恢复：压缩 started 状态崩溃 → cancelled(process_restarted) + waiting_user，不自动调用模型，cancel 收敛 idle", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [], gatewayDelayMs: 0 });
  t.after(() => h.cleanup());
  const { compactionId } = await buildCrashWindowJournal(h, { compactionState: "started" });
  const opened = await h.agent.open({ projectRoot: h.projectRoot });
  assert.equal(opened.status, "waiting_user", "started 崩溃重启后收敛 waiting_user");
  assert.equal(h.gateway.calls.length, 0, "重启绝不自动调用普通模型");
  const events = await readEvents(h.agent, h.projectRoot);
  const restartCancelled = eventsOfType(events, "context_compaction_cancelled").filter(
    (event) => event.payload.cancel_reason === "process_restarted"
  );
  assert.equal(restartCancelled.length, 1, "未完成 attempt 追加 cancelled(process_restarted)");
  assert.equal(restartCancelled[0].payload.compaction_id, compactionId);
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.active_run.status, "waiting_user");
  assert.equal(session.compaction.state, "cancelled");
  assert.ok(session.active_run.active_input_id, "输入保持 pending（等待用户 retry/cancel）");
  // cancel 可用 → idle（composer 立即可发）
  await h.agent.cancelCompaction({ projectRoot: h.projectRoot, compactionId });
  await waitForIdle(h.agent, h.projectRoot);
  assert.equal((await readSession(h.agent, h.projectRoot)).status, "idle");
});

test("重启恢复：压缩 cancelling 状态崩溃 → cancelled(process_restarted) + waiting_user，不自动调用模型，cancel 收敛 idle", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [], gatewayDelayMs: 0 });
  t.after(() => h.cleanup());
  const { compactionId } = await buildCrashWindowJournal(h, { compactionState: "cancelling" });
  const opened = await h.agent.open({ projectRoot: h.projectRoot });
  assert.equal(opened.status, "waiting_user", "cancelling 崩溃重启后收敛 waiting_user");
  assert.equal(h.gateway.calls.length, 0);
  const events = await readEvents(h.agent, h.projectRoot);
  const restartCancelled = eventsOfType(events, "context_compaction_cancelled").filter(
    (event) => event.payload.cancel_reason === "process_restarted"
  );
  assert.equal(restartCancelled.length, 1);
  assert.equal(restartCancelled[0].payload.compaction_id, compactionId);
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.active_run.status, "waiting_user");
  assert.equal(session.compaction.state, "cancelled");
  assert.ok(session.active_run.active_input_id, "输入保持 pending");
  await h.agent.cancelCompaction({ projectRoot: h.projectRoot, compactionId });
  await waitForIdle(h.agent, h.projectRoot);
  assert.equal((await readSession(h.agent, h.projectRoot)).status, "idle");
});

test("重启恢复：failed 崩溃窗口（failed 已落盘、收敛未落盘）→ waiting_user，retry 可用并完成输入", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: crashWindowGatewayScript(), gatewayDelayMs: 0 });
  t.after(() => h.cleanup());
  const { compactionId } = await buildCrashWindowJournal(h, { compactionState: "failed", seedTranscript: true });
  const opened = await h.agent.open({ projectRoot: h.projectRoot });
  assert.equal(opened.status, "waiting_user", "failed 崩溃窗口必须收敛 waiting_user（不得 interrupted）");
  assert.equal(h.gateway.calls.length, 0, "重启绝不自动调用普通模型");
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_interrupted").length, 0, "不得保守中断");
  assert.equal(eventsOfType(events, "context_compaction_cancelled").length, 0, "failed 已是终态，不追加 process_restarted 取消");
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.active_run.status, "waiting_user");
  assert.equal(session.compaction.state, "failed");
  assert.ok(session.active_run.active_input_id, "输入保持 pending");
  // retry 可用：压缩重试成功 → 恢复 running → 输入继续 → Run 完成
  const retried = await h.agent.retryCompaction({ projectRoot: h.projectRoot, compactionId });
  assert.equal(retried.status, "completed", "重试必须可用（不得抛 compaction_no_run）");
  await waitForIdle(h.agent, h.projectRoot);
  const afterRetry = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(afterRetry, "run_completed").length, 1, "重试后输入继续并完成 Run");
  assert.equal(eventsOfType(afterRetry, "context_compaction_completed").length, 1);
  assert.equal((await readSession(h.agent, h.projectRoot)).active_run.status, "completed");
});

test("重启恢复：failed 崩溃窗口 cancel 可用 → input_cancelled(compaction_cancelled) + run_cancelled → idle", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [], gatewayDelayMs: 0 });
  t.after(() => h.cleanup());
  const { compactionId } = await buildCrashWindowJournal(h, { compactionState: "failed" });
  const opened = await h.agent.open({ projectRoot: h.projectRoot });
  assert.equal(opened.status, "waiting_user");
  assert.equal(eventsOfType((await readEvents(h.agent, h.projectRoot)), "run_interrupted").length, 0);
  await h.agent.cancelCompaction({ projectRoot: h.projectRoot, compactionId });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(
    eventsOfType(events, "input_cancelled").filter((event) => event.payload.reason === "compaction_cancelled").length,
    1,
    "取消必须可用并终结输入"
  );
  assert.equal(eventsOfType(events, "run_cancelled").length, 1);
  assert.equal((await readSession(h.agent, h.projectRoot)).status, "idle");
});

test("重启恢复：首屏只读 snapshot 也完成压缩对账，cancelled 后提交会继续执行", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: crashWindowGatewayScript(), gatewayDelayMs: 0 });
  t.after(() => h.cleanup());
  const { compactionId } = await buildCrashWindowJournal(h, { compactionState: "started" });

  const snapshot = await h.agent.snapshot({ projectRoot: h.projectRoot, tail: true, limit: 200 });
  assert.equal(snapshot.session.compaction.state, "cancelled", "首屏快照必须先完成崩溃对账");
  assert.equal(snapshot.session.active_run.status, "waiting_user");
  assert.equal(
    snapshot.events.filter(
      (event) => event.type === "context_compaction_cancelled" && event.payload.compaction_id === compactionId
    ).length,
    1,
    "首屏快照应包含 process_restarted 取消终态"
  );

  const submitted = await h.agent.submit({ projectRoot: h.projectRoot, text: "继续执行", source: "chat" });
  assert.equal(submitted.queued, true, "恢复中的 Run 继续消费原输入，新输入进入同一 FIFO");
  await waitFor(h.agent, h.projectRoot, () => h.gateway.calls.length > 0, {
    timeoutMs: 1000,
    describe: "cancelled 压缩态后的提交启动 Run 循环"
  });
});

test("自动门禁：大输入 + 极小历史 → noop（不调用模型）→ 仍超硬窗口 → failRun(context_window_exceeded)", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [], gatewayDelayMs: 0 });
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "汉".repeat(240_000), source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const compactions = events.filter((event) => event.type.startsWith("context_compaction"));
  assert.deepEqual(
    compactions.map((event) => event.type),
    ["context_compaction_noop"],
    "无可压缩历史只追加 noop，不调用模型"
  );
  assert.equal(h.gateway.calls.length, 0, "noop 路径零模型调用");
  const failed = eventsOfType(events, "run_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.code, "context_window_exceeded", "仍超硬窗口必须 failRun(context_window_exceeded)");
  assert.equal(eventsOfType(events, "input_cancelled").length, 0, "输入保持可恢复");
});
