// tests/agent/run-lifecycle.test.mjs —— Run 收敛状态机薄单测（第十五轮 Task 8）。
//
// run-lifecycle 与 runtime 双闭包态深度绑定，完整行为面由 project-agent /
// multi-session-runtime / journal-recovery 既有测试覆盖（停止/优先切换/失败收束
// 全在内）；此处只钉两个上下文无关的确定性 seam：
//   - isAbort：controller 中止 / AbortError / model_aborted 三口径判定；
//   - closeDroppedToolCalls：中断丢弃的工具调用以 tool_cancelled 闭合 transcript。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunLifecycle } from "../../src/core/agent/run-lifecycle.mjs";

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
