// src/core/shell/redaction.mjs 的迁移测试（统一 Agent 内核计划 Task 4）。
// 前置计划 tests/command-risk.test.mjs 中的脱敏用例全部迁入本文件，并新增有界状态
// 流式脱敏器用例：跨 chunk 拆分的密钥仍被脱敏、终态 flush、有界 carry 与溢出记录。
import assert from "node:assert/strict";
import test from "node:test";
import {
  STREAMING_CARRY_LIMIT,
  createRedactor,
  createStreamingRedactor,
  redactChatData
} from "../../src/core/shell/redaction.mjs";

// ---------------------------------------------------------------------------
// redactChatData：一次性脱敏（前置计划行为原样保留）
// ---------------------------------------------------------------------------

test("命令中的密钥片段被脱敏", () => {
  const inputs = [
    "api_key=abc123secret",
    "Authorization: Bearer abc123secret",
    "tvly-abcdefghijklmnop",
    "sk-abcdefghijklmnop123456",
    'secret="abc123secret"',
    "token = 'abc123secret'",
    'Authorization: Bearer "abc123secret"',
    '--password="abc123secret"'
  ];
  for (const input of inputs) {
    const redacted = redactChatData(input);
    assert.ok(!redacted.includes("abc123secret"), `应脱敏原密钥: ${input}`);
    assert.ok(!/tvly-[A-Za-z0-9_-]{12,}/u.test(redacted), `应脱敏 tvly 令牌: ${input}`);
    assert.ok(!/sk-[A-Za-z0-9_-]{12,}/u.test(redacted), `应脱敏 sk 令牌: ${input}`);
    assert.match(redacted, /\[REDACTED\]/u);
  }
});

test("引号包裹的密钥脱敏后保留引号", () => {
  assert.equal(redactChatData('secret="abc123secret"'), 'secret="[REDACTED]"');
  assert.equal(redactChatData("token = 'abc123secret'"), "token = '[REDACTED]'");
  assert.equal(redactChatData('Authorization: Bearer "abc123secret"'), 'Authorization: Bearer "[REDACTED]"');
  assert.equal(redactChatData('--password="abc123secret"'), '--password="[REDACTED]"');
});

test("引号值含空白或异侧引号时整体脱敏并保留引号", () => {
  assert.equal(redactChatData('secret="a b"'), 'secret="[REDACTED]"');
  assert.equal(redactChatData("secret=\"it's\""), 'secret="[REDACTED]"');
  assert.equal(redactChatData('Bearer "x y"'), 'Bearer "[REDACTED]"');
  assert.equal(redactChatData("api_key=abc123secret"), "api_key=[REDACTED]");
  // 未闭合引号保持现状，不误伤也不崩溃
  assert.equal(redactChatData('secret="unclosed'), 'secret="unclosed');
});

test("不含密钥的文本原样保留", () => {
  const plain = "今天修改了大纲，git status 显示无变更。";
  assert.equal(redactChatData(plain), plain);
});

// ---------------------------------------------------------------------------
// createRedactor：模式 + 显式 secrets 字面量
// ---------------------------------------------------------------------------

test("createRedactor 同时处理模式密钥与显式 secrets", () => {
  const redactor = createRedactor({ secrets: ["super-secret-token-77"] });
  assert.equal(
    redactor.redact("echo super-secret-token-77 and sk-abcdefghijklmnop"),
    "echo [REDACTED] and [REDACTED]"
  );
  assert.equal(redactor.redact("普通文本"), "普通文本");
  assert.equal(createRedactor({}).redact("api_key=x"), "api_key=[REDACTED]");
});

// ---------------------------------------------------------------------------
// createStreamingRedactor：有界状态流式脱敏
// ---------------------------------------------------------------------------

test("跨 chunk 拆分的 sk- token 拼接后仍被脱敏", () => {
  const redactor = createStreamingRedactor();
  const part1 = redactor.push("echo 输出前缀 sk-abcdefgh");
  const part2 = redactor.push("ijklmnop 输出后缀");
  const rest = redactor.flush();
  const joined = part1 + part2 + rest;
  assert.ok(!joined.includes("sk-abcdefghijklmnop"), "拼接后不得出现完整 token");
  assert.ok(!/sk-[A-Za-z0-9_-]{12,}/u.test(joined), "拼接后不得残留可识别 token");
  assert.ok(joined.includes("echo 输出前缀") && joined.includes("[REDACTED]") && joined.includes("输出后缀"));
  assert.equal(redactor.state.pending_chars, 0, "flush 后 carry 应清空");
});

test("跨 chunk 拆分的引号密钥拼接后仍被脱敏", () => {
  const redactor = createStreamingRedactor();
  const part1 = redactor.push('secret="abc');
  const part2 = redactor.push('def" 后续');
  const joined = part1 + part2 + redactor.flush();
  assert.equal(joined, 'secret="[REDACTED]" 后续');
});

test("跨 chunk 拆分的单引号密钥拼接后仍被脱敏", () => {
  const redactor = createStreamingRedactor();
  const part1 = redactor.push("token = 'abc");
  const part2 = redactor.push("def' done");
  assert.equal(part1 + part2 + redactor.flush(), "token = '[REDACTED]' done");
});

test("跨 chunk 拆分的显式 secret 拼接后仍被脱敏", () => {
  const SECRET = "super-secret-token-77";
  const redactor = createStreamingRedactor({ secrets: [SECRET] });
  const part1 = redactor.push(`echo super-secret-to`);
  const part2 = redactor.push(`ken-77 world`);
  const joined = part1 + part2 + redactor.flush();
  assert.ok(!joined.includes(SECRET));
  assert.ok(joined.includes("[REDACTED]") && joined.includes("world"));
});

test("终态 flush 对剩余 carry 做一次性脱敏", () => {
  const redactor = createStreamingRedactor();
  // token 尾部停在 chunk 边界：push 不输出，flush 补出（已脱敏）
  assert.equal(redactor.push("echo sk-abcdefghijklmnop"), "echo ");
  assert.equal(redactor.state.pending_chars, 19);
  assert.equal(redactor.flush(), "[REDACTED]");
  // 未闭合引号在终态保持原样（与 redactChatData 一次性语义一致）
  const redactor2 = createStreamingRedactor();
  assert.equal(redactor2.push("echo 前缀 secret=\"unclosed"), "echo 前缀 ");
  assert.equal(redactor2.flush(), 'secret="unclosed');
});

test("一次完整 chunk 内不延迟输出", () => {
  const redactor = createStreamingRedactor();
  const out = redactor.push("api_key=abc123secret; echo done");
  assert.equal(out, "api_key=[REDACTED]; echo done");
  assert.equal(redactor.state.pending_chars, 0);
  assert.equal(redactor.flush(), "");
});

test("carry 有界：超窗口部分按普通文本处理并记录 overflow", () => {
  const redactor = createStreamingRedactor({ carryLimit: 64 });
  // 打开引号后持续灌入超窗文本：carry 不得超过上限
  assert.equal(redactor.push('secret="'), "");
  assert.ok(redactor.state.pending_chars <= 64);
  const emitted = redactor.push("X".repeat(2000));
  assert.ok(redactor.state.pending_chars <= 64, "carry 必须保持有界");
  assert.ok(redactor.state.overflow_chars > 0, "超出窗口应被记录");
  // 超窗部分（含此前保留的引号前缀 7 字符）按普通文本输出；窗口内尾部保留进 carry
  assert.equal(emitted, 'secret="' + "X".repeat(1936));
  assert.equal(redactor.state.pending_chars, 64, "窗口尾部保留进 carry");
  // 终态 flush 后无残留
  redactor.flush();
  assert.equal(redactor.state.pending_chars, 0);
});

test("默认 carry 上限为 STREAMING_CARRY_LIMIT", () => {
  assert.equal(STREAMING_CARRY_LIMIT, 8192);
});
