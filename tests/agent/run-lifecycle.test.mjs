// tests/agent/run-lifecycle.test.mjs —— Run 收敛状态机薄单测（第十五轮 Task 8）。
//
// run-lifecycle 与 runtime 双闭包态深度绑定，完整行为面由 project-agent /
// multi-session-runtime / journal-recovery 既有测试覆盖（停止/优先切换/失败收束
// 全在内）；此处只钉两个上下文无关的确定性 seam：
//   - isAbort：controller 中止 / AbortError / model_aborted 三口径判定；
//   - closeDroppedToolCalls：中断丢弃的工具调用以 tool_cancelled 闭合 transcript。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunLifecycle, describeModelCallError } from "../../src/core/agent/run-lifecycle.mjs";

function makeLifecycle({ aborted = false } = {}) {
  const calls = [];
  const lifecycle = createRunLifecycle({
    getState: () => ({ controller: { signal: { aborted } } }),
    getSessionState: () => ({ journal: {} }),
    appendSafeTranscript: async (_journal, record) => { calls.push(record); }
  });
  return { lifecycle, calls };
}

test("isAbort：controller 中止 + AbortError + model_aborted 三口径", () => {
  const aborted = makeLifecycle({ aborted: true }).lifecycle;
  assert.equal(aborted.isAbort(new Error("任意错误")), true, "controller 中止即 abort");

  const idle = makeLifecycle().lifecycle;
  assert.equal(idle.isAbort(Object.assign(new Error("x"), { name: "AbortError" })), true);
  assert.equal(idle.isAbort(Object.assign(new Error("x"), { code: "model_aborted" })), true);
  assert.equal(idle.isAbort(new Error("x")), false);
});

test("closeDroppedToolCalls：以 tool_cancelled 闭合 transcript，空数组无操作", async () => {
  const { lifecycle, calls } = makeLifecycle();
  await lifecycle.closeDroppedToolCalls([
    { id: "t1", name: "read_file" },
    { tool_call_id: "t2", name: null }
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].role, "tool");
  assert.equal(calls[0].tool_call_id, "t1");
  assert.equal(calls[0].name, "read_file");
  const first = JSON.parse(calls[0].content);
  assert.equal(first.ok, false);
  assert.equal(first.tool_call_id, "t1");
  assert.equal(first.error.code, "tool_cancelled");
  assert.equal(calls[1].tool_call_id, "t2");
  await lifecycle.closeDroppedToolCalls([]);
  assert.equal(calls.length, 2, "空数组不追加");
});

// ---------------------------------------------------------------------------
// 2026-09-27：模型调用失败的可读原因——run_failed 的 payload.error 此前直出
// error.message（英文技术串，如 "returned HTTP 401"），用户无从行动。分类口径
// 与 model-connection-test 的 classifyError 对齐（同一上游错误在「测试连接」与
// 正式运行给出一致原因）；非传输层错误返回 null 由 failRun 原样透传。
// ---------------------------------------------------------------------------

function transportError(status, reason = "client-fatal") {
  return Object.assign(new Error(`OpenAI-compatible provider returned HTTP ${status}.`), {
    name: "ProviderTransportError",
    code: "provider_transport_error",
    status,
    reason
  });
}

test("describeModelCallError：上游状态码分类为可读中文（401/402/404/429/5xx/400）", () => {
  assert.match(describeModelCallError(transportError(401)), /API Key 无效或无权限/u);
  assert.match(describeModelCallError(transportError(403)), /API Key 无效或无权限/u);
  assert.match(describeModelCallError(transportError(402)), /额度\/计费/u);
  assert.match(describeModelCallError(transportError(404)), /模型名称不存在/u);
  assert.match(describeModelCallError(transportError(429)), /额度已用尽/u);
  assert.match(describeModelCallError(transportError(503)), /HTTP 503/u);
  assert.match(describeModelCallError(transportError(400)), /HTTP 400/u);
});

test("describeModelCallError：网络与超时按 reason/cause 分类，非传输层错误透传 null", () => {
  assert.match(describeModelCallError(transportError(null, "network")), /无法连接模型服务/u);
  assert.match(describeModelCallError(transportError(null, "timeout")), /响应超时/u);
  const causeNetwork = transportError(null, "server-retryable");
  causeNetwork.cause = Object.assign(new Error("fetch failed"), { code: "ENOTFOUND" });
  assert.match(describeModelCallError(causeNetwork), /无法连接模型服务/u);

  // 非传输层错误（compaction/journal 等领域错误）与用户取消：返回 null，
  // failRun 必须维持原样 error.message，不扩大改写面。
  const plain = Object.assign(new Error("上下文窗口超限"), { code: "context_window_exceeded" });
  assert.equal(describeModelCallError(plain), null);
  assert.equal(describeModelCallError(transportError(401, "user-abort")), null);
});
