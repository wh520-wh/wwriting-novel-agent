// 统一上下文窗口、usage 校准与压缩门禁测试（统一 Journal/上下文窗口/自动压缩
// 计划 Task 6）。
//
// 覆盖：固定估算公式与阈值（brief Step 1 逐字）、256k/1M 两档窗口、provider
// usage 缺失、EMA 校准比例夹在 0.5..2.0、硬窗口检查。
import assert from "node:assert/strict";
import test from "node:test";
import {
  OUTPUT_SAFETY_RESERVE,
  estimateRequestUsage,
  exceedsHardWindow,
  observeProviderUsage,
  shouldCompact
} from "../../src/core/agent/context-window.mjs";

// ---------------------------------------------------------------------------
// Step 1（brief 逐字）：估算公式与阈值
// ---------------------------------------------------------------------------

test("estimateRequestUsage：固定估算公式与阈值（brief Step 1 逐字）", () => {
  const usage = estimateRequestUsage({
    messages: [{ role: "system", content: "系统" }, { role: "user", content: "你好" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
    effectiveContextWindow: 256_000
  });
  assert.equal(usage.effective_context_window, 256_000);
  assert.equal(usage.compaction_threshold, 204_800);
  assert.ok(usage.used_tokens >= usage.raw_tokens);
  assert.equal(shouldCompact({ estimatedInput: 204_800, outputReserve: 32_000, window: 256_000 }), true);
  assert.equal(shouldCompact({ estimatedInput: 200_000, outputReserve: 32_000, window: 256_000 }), false);
  assert.equal(shouldCompact({ estimatedInput: 224_001, outputReserve: 32_000, window: 256_000 }), true);
});

// ---------------------------------------------------------------------------
// 256k 与 1M 两档窗口
// ---------------------------------------------------------------------------

test("estimateRequestUsage：256k 档窗口源与阈值", () => {
  const usage = estimateRequestUsage({
    messages: [{ role: "user", content: "你好" }],
    tools: [],
    effectiveContextWindow: 256_000
  });
  assert.equal(usage.compaction_threshold, 204_800);
  assert.equal(usage.window_source, "default_256k");
  assert.equal(usage.status, "ready");
  assert.equal(usage.estimator, "local");
  assert.equal(usage.approximate, true);
  assert.ok(Number.isFinite(usage.ratio) && usage.ratio > 0, "ratio 必须为正");
  assert.ok(!Number.isNaN(Date.parse(usage.updated_at)), "updated_at 应为 ISO-8601");
});

test("estimateRequestUsage：1M 档窗口源与阈值", () => {
  const usage = estimateRequestUsage({
    messages: [{ role: "user", content: "长篇小说正文……" }],
    tools: [],
    effectiveContextWindow: 1_000_000
  });
  assert.equal(usage.compaction_threshold, 800_000);
  assert.equal(usage.window_source, "configured"); // 非缺省窗口自动归为 configured
  assert.ok(usage.used_tokens >= usage.raw_tokens);
});

test("estimateRequestUsage：无消息/无工具也产生确定结果", () => {
  const usage = estimateRequestUsage({ messages: [], tools: [], effectiveContextWindow: 256_000 });
  assert.ok(usage.raw_tokens >= 2, "空载荷 raw 只含 JSON 序列化开销");
  assert.ok(usage.used_tokens >= 256, "used 至少含 256 固定余量");
  assert.equal(usage.compaction_threshold, 204_800);
});

// ---------------------------------------------------------------------------
// 校准倍率（单输入规则的唯一额外输入）
// ---------------------------------------------------------------------------

test("estimateRequestUsage：calibration 倍率缩放 used_tokens，缺省为 1", () => {
  const base = estimateRequestUsage({
    messages: [{ role: "user", content: "字".repeat(500) }],
    tools: [],
    effectiveContextWindow: 256_000
  });
  const half = estimateRequestUsage({
    messages: [{ role: "user", content: "字".repeat(500) }],
    tools: [],
    effectiveContextWindow: 256_000,
    calibration: 0.5
  });
  assert.ok(half.used_tokens < base.used_tokens, "0.5 倍率必须低于基准估算");
  assert.ok(half.used_tokens >= Math.ceil(base.raw_tokens * 1.08 * 0.5), "缩放后仍含 1.08 安全系数");
  // 非法倍率回落 1（不放大不缩小）
  const invalid = estimateRequestUsage({
    messages: [{ role: "user", content: "字".repeat(500) }],
    tools: [],
    effectiveContextWindow: 256_000,
    calibration: -1
  });
  assert.deepEqual(
    { used: invalid.used_tokens, raw: invalid.raw_tokens },
    { used: base.used_tokens, raw: base.raw_tokens },
    "非法 calibration 回落默认 1"
  );
});

// ---------------------------------------------------------------------------
// 压缩门禁
// ---------------------------------------------------------------------------

test("shouldCompact：阈值或输出安全余量任一命中即压缩", () => {
  assert.equal(OUTPUT_SAFETY_RESERVE, 32_000);
  // 达到产品压缩点（256k 档 204_800）
  assert.equal(shouldCompact({ estimatedInput: 204_800, window: 256_000 }), true);
  // 未达阈值且输出余量不撞硬窗口（190_000 + 32_000 < 256_000）
  assert.equal(shouldCompact({ estimatedInput: 190_000, window: 256_000 }), false);
  // 超过产品压缩点即压缩（220_000 >= 204_800）
  assert.equal(shouldCompact({ estimatedInput: 220_000, window: 256_000 }), true);
  // 输出余量撞硬窗口（223_999 + 32_000 >= 256_000）
  assert.equal(shouldCompact({ estimatedInput: 223_999, window: 256_000 }), true);
  // 八成口径：阈值按窗口推导（1M 档 800_000），显式 threshold 覆盖不再需要
  assert.equal(shouldCompact({ estimatedInput: 799_999, window: 1_000_000 }), false);
  assert.equal(shouldCompact({ estimatedInput: 800_000, window: 1_000_000 }), true);
});

test("exceedsHardWindow：estimatedInput + 输出安全余量 >= 窗口", () => {
  assert.equal(exceedsHardWindow({ estimatedInput: 223_999, window: 256_000 }), false);
  assert.equal(exceedsHardWindow({ estimatedInput: 224_000, window: 256_000 }), true);
  assert.equal(exceedsHardWindow({ estimatedInput: 960_000, window: 1_000_000 }), false);
  assert.equal(exceedsHardWindow({ estimatedInput: 968_000, window: 1_000_000 }), true);
});

// ---------------------------------------------------------------------------
// observeProviderUsage：provider usage 校准当前会话
// ---------------------------------------------------------------------------

test("observeProviderUsage：provider 无 input usage 时维持 approximate，不产生校准", () => {
  const estimated = { used_tokens: 1000 };
  assert.deepEqual(observeProviderUsage({ estimated, usageReport: {} }), { calibration: null, approximate: true });
  assert.deepEqual(observeProviderUsage({ estimated, usageReport: { inputTokens: 0 } }), { calibration: null, approximate: true });
  assert.deepEqual(observeProviderUsage({ estimated, usageReport: undefined }), { calibration: null, approximate: true });
  assert.deepEqual(observeProviderUsage({ estimated: { used_tokens: 0 }, usageReport: { inputTokens: 500 } }), { calibration: null, approximate: true });
});

test("observeProviderUsage：有 input usage 时校准比例夹在 0.5..2.0", () => {
  const estimated = { used_tokens: 1000 };
  // 比例 1.5 直接采用
  const normal = observeProviderUsage({ estimated, usageReport: { inputTokens: 1500 } });
  assert.deepEqual(normal, { calibration: 1.5, approximate: false });
  // 比例 3.0 夹到 2.0
  const high = observeProviderUsage({ estimated, usageReport: { inputTokens: 3000 } });
  assert.equal(high.calibration, 2.0);
  assert.equal(high.approximate, false);
  // 比例 0.1 夹到 0.5
  const low = observeProviderUsage({ estimated, usageReport: { inputTokens: 100 } });
  assert.equal(low.calibration, 0.5);
  assert.equal(low.approximate, false);
});

test("observeProviderUsage：EMA 只在校准比例上平滑，结果仍落在 0.5..2.0", () => {
  const first = observeProviderUsage({ estimated: { used_tokens: 1000 }, usageReport: { inputTokens: 2000 } });
  assert.equal(first.calibration, 2.0, "首次观测直接采用夹紧后的比例");
  const second = observeProviderUsage({
    estimated: { used_tokens: 1000 },
    usageReport: { inputTokens: 2000 },
    previousCalibration: first.calibration
  });
  // EMA(α=0.3)：2.0 + 0.3 * (2.0 - 2.0) = 2.0
  assert.equal(second.calibration, 2.0);
  const third = observeProviderUsage({
    estimated: { used_tokens: 1000 },
    usageReport: { inputTokens: 500 },
    previousCalibration: 2.0
  });
  // 观测 0.5 → EMA = 2.0 + 0.3 * (0.5 - 2.0) = 1.55
  assert.equal(third.calibration, 1.55);
  assert.ok(third.calibration >= 0.5 && third.calibration <= 2.0);
});

// ---------------------------------------------------------------------------
// 第十三轮（ADR 0004）：window_source 双值口径 + 小窗口余量优先
// ---------------------------------------------------------------------------

test("estimateRequestUsage 的 windowSource 参数优先于按窗口值推导", () => {
  const usage = estimateRequestUsage({ messages: [], tools: [], effectiveContextWindow: 1_000_000, windowSource: "configured" });
  assert.equal(usage.window_source, "configured");
  const fallback = estimateRequestUsage({ messages: [], tools: [], effectiveContextWindow: 256_000 });
  assert.equal(fallback.window_source, "default_256k");
});

test("shouldCompact：小窗口（≤160k）时 32k 输出余量先于八成阈值触发", () => {
  // 128k 窗口：八成阈值 102,400；但 96,000 + 32,000 已撞窗口 → 余量规则先命中
  assert.equal(shouldCompact({ estimatedInput: 95_999, window: 128_000 }), false);
  assert.equal(shouldCompact({ estimatedInput: 96_000, window: 128_000 }), true);
});
