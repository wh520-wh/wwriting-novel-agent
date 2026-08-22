// src/core/agent/workflows.mjs 已删除（统一 Agent 内核计划 Task 7）。
//
// 本文件保留文件名作为删除契约的负向断言，覆盖：
//   - enter_workflow 工具不再注册（未知工具，不再产生 workflow_changed）
//   - prompt 只含统一 Agent 任务政策：章节专用工具纪律、WWRITING.md 职责、
//     安全点优先说明，不含任何 workflow 政策（[Workflow: …] 块）
//   - 每轮工具目录相同：深工具恒为 update_plan / append_chapter_segment /
//     commit_chapter / finalize_revision / rollback_chapter（统一目录由 runtime
//     固定提供，不随请求变化）
import assert from "node:assert/strict";
import test from "node:test";

import { UNIFIED_TASK_POLICY, assemblePrompt } from "../../src/core/agent/prompt.mjs";
import { createToolRuntime } from "../../src/core/agent/tools/index.mjs";
import { createProjectAgentHarness, eventsOfType, waitForIdle } from "../helpers/project-agent-harness.mjs";

// 统一深工具目录（固定六件套，Task 7 契约 + Task C3 finalize_revision + C5 rollback_chapter）
const UNIFIED_DEEP_NAMES = ["append_chapter_segment", "commit_chapter", "update_plan", "finalize_revision", "rollback_chapter", "update_memory"];

// ---------------------------------------------------------------------------
// 删除契约：workflows.mjs 的概念不在任何模块导出
// ---------------------------------------------------------------------------

test("enter_workflow 已删除：不在注册表、不产生 workflow_changed", async (t) => {
  const tools = createToolRuntime({ journal: { append: async () => {} }, skills: {} });
  const names = tools.definitions().map((def) => def.function.name);
  assert.ok(!names.includes("enter_workflow"), "enter_workflow 工具必须从注册表删除");
  for (const deep of UNIFIED_DEEP_NAMES) {
    assert.ok(names.includes(deep), `统一目录必须包含 ${deep}`);
  }

  // 集成：真实 Run 中调用 enter_workflow 只能得到 unknown_tool，且无 workflow_changed
  const h = await createProjectAgentHarness({
    gatewayScript: [
      {
        reply: {
          toolCalls: [{ id: "call_ew_1", name: "enter_workflow", arguments: { workflow: "chapter", reason: "x" } }]
        }
      },
      { reply: { text: "已继续处理。" } }
    ]
  });
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "正式写第一章", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const snap = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
  const failed = eventsOfType(snap.events, "tool_call_failed").filter((event) => event.payload.name === "enter_workflow");
  assert.equal(failed.length, 1, "enter_workflow 调用必须失败");
  assert.equal(failed[0].payload.error, "unknown_tool");
  assert.equal(eventsOfType(snap.events, "workflow_changed").length, 0, "不得再产生 workflow_changed 事件");
  assert.equal(eventsOfType(snap.events, "run_completed").length, 1, "Run 正常完成");
});

// ---------------------------------------------------------------------------
// 统一任务政策：章节纪律 / WWRITING.md 职责 / 安全点优先，无 workflow 政策
// ---------------------------------------------------------------------------

test("统一任务政策包含章节纪律、记忆职责与安全点优先；不含 workflow 政策", () => {
  assert.ok(UNIFIED_TASK_POLICY.startsWith("[Agent Task Policy]"), "统一政策必须以 Agent Task Policy 开头");
  // 章节专用工具纪律：正文只经 append_chapter_segment/commit_chapter，禁止绕过
  assert.ok(UNIFIED_TASK_POLICY.includes("append_chapter_segment"), "必须写明正文只能经 append_chapter_segment 写草稿");
  assert.ok(UNIFIED_TASK_POLICY.includes("commit_chapter"), "必须写明正式完成只能经 commit_chapter 提交");
  assert.ok(UNIFIED_TASK_POLICY.includes("禁止用 write_file、edit_file 或 shell"), "草稿行必须禁止通用写工具绕过章节专用工具");
  assert.ok(UNIFIED_TASK_POLICY.includes("段号按顺序递增"), "必须要求段号按顺序递增");
  assert.ok(UNIFIED_TASK_POLICY.includes("任一条件不满足时不得声称章节完成"), "完成条件必须保留");
  // WWRITING.md 职责
  assert.ok(UNIFIED_TASK_POLICY.includes("WWRITING.md 是长期项目事实入口"), "必须写明 WWRITING.md 职责");
  assert.ok(UNIFIED_TASK_POLICY.includes("用户已确认"), "只有用户确认或文件可证的长期事实才能写入");
  // 安全点优先说明
  assert.ok(UNIFIED_TASK_POLICY.includes("安全边界停止"), "收到优先输入后必须在安全边界停止旧输入");
  // 不包含任何 workflow 政策块
  assert.ok(!UNIFIED_TASK_POLICY.includes("[Workflow:"), "不得包含任何 [Workflow: …] 政策块");
  assert.ok(!UNIFIED_TASK_POLICY.includes("enter_workflow"), "不得再提及 enter_workflow");
  assert.ok(!UNIFIED_TASK_POLICY.includes("workflow_changed"), "不得再提及 workflow_changed 事件");
  // 三件套记忆纪律（§2.3）
  assert.ok(UNIFIED_TASK_POLICY.includes("update_memory"), "任务政策必须包含 update_memory 工具");
  assert.ok(UNIFIED_TASK_POLICY.includes("更新 book_summary.md"), "任务政策必须包含摘要维护");
  assert.ok(UNIFIED_TASK_POLICY.includes("更新 WORKLOG.md"), "任务政策必须包含工作日志维护");
  // 断点恢复纪律（§4.2）
  assert.ok(UNIFIED_TASK_POLICY.includes("先读 WORKLOG"), "任务政策必须包含断点恢复纪律");
  // 旧派生提取措辞必须删除
  assert.ok(!UNIFIED_TASK_POLICY.includes("独立记忆提取"), "旧派生提取措辞必须删除");
  assert.ok(!UNIFIED_TASK_POLICY.includes("维护任务重建"), "旧派生提取措辞必须删除");
});

// 装配后的 system 层同样不含 workflow 政策、含统一政策
test("assemblePrompt 的 system 层只含统一任务政策，无 workflow 政策层", () => {
  const assembled = assemblePrompt({ currentInput: "正式写第一章" });
  const content = assembled.messages[0].content;
  assert.ok(content.includes("[Agent Task Policy]"), "统一任务政策必须进入 system 层");
  assert.ok(!content.includes("[Workflow:"), "system 层不得包含任何 workflow 政策");
  assert.ok(content.includes("append_chapter_segment"), "system 层必须含章节专用工具纪律");
});

// ---------------------------------------------------------------------------
// 统一目录：每轮同一工具集，深工具恒为六件套
// ---------------------------------------------------------------------------

test("每轮工具目录相同：深工具恒为 update_plan/append_chapter_segment/commit_chapter/finalize_revision/rollback_chapter/update_memory", async (t) => {
  const h = await createProjectAgentHarness({
    gatewayScript: [
      async (request) => {
        const names = (request.tools ?? []).map((def) => def?.function?.name).filter(Boolean);
        const deepNames = names.filter((name) => UNIFIED_DEEP_NAMES.includes(name));
        assert.deepEqual(
          deepNames.sort(),
          [...UNIFIED_DEEP_NAMES].sort(),
          "深工具目录必须恒为 update_plan/append_chapter_segment/commit_chapter/finalize_revision/rollback_chapter/update_memory"
        );
        assert.ok(!names.includes("enter_workflow"), "统一目录不得包含 enter_workflow");
        assert.ok(!names.includes("commit_blueprint"), "统一目录不得包含 commit_blueprint");
        return { text: "好。" };
      }
    ]
  });
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "处理这个项目", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const snap = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
  assert.equal(eventsOfType(snap.events, "workflow_changed").length, 0, "普通请求不得切换工作流");
  assert.equal(eventsOfType(snap.events, "run_completed").length, 1);
});
