// Task 5: 有序工作项投影测试（纯投影，无 DOM）。
//
// 覆盖：
//   - Step 1: turn-1 started -> plan 1/3 -> tool A -> plan 2/3 -> turn-2，
//     最终 order 为 reasoning-1、tool-A、plan；plan 只有一个、sortSeq 等于
//     第二次更新时间、内容仍包含全部任务。
//   - Step 3: 工具标签四态；折叠摘要用项目相对路径，无法确定时不伪造。
//   - Step 4: 工作组展开默认值与终态耗时文案。
//   - Step 5: 动效唯一性八条断言（brief 逐条 verbatim）。
//   - reasoning/tool 立即终结；waiting_user 压制后恢复；v1 legacy turn 兼容。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWorkState,
  groupStatusText,
  openWorkItemIds,
  orderedWorkItems,
  reduceWorkEvent,
  toolLabel,
  visibleLiveTargets
} from "../../src/app-shell/agent/work-items.mjs";

function ev(type, payload, seq, extra = {}) {
  return {
    seq,
    event_id: `evt-${seq}`,
    session_id: "sess-test",
    run_id: "run-1",
    project_root: "D:\\novel",
    type,
    payload,
    at: "2026-08-06T00:00:00.000Z",
    ...extra
  };
}

function reduceAll(events) {
  const work = createWorkState();
  for (const event of events) reduceWorkEvent(work, event);
  return work;
}

function groupOf(work) {
  return work.groups.get("run-1");
}

test("Step 1: 有序投影 —— 最终 order 为 reasoning-1、tool-A、plan；plan 单一项、sortSeq=第二次更新时间、内容仍包含全部任务", () => {
  const work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }, 2),
    ev("plan_updated", {
      explanation: "先核对已有章节",
      items: [
        { id: "t1", step: "检查已有章节", status: "completed" },
        { id: "t2", step: "修正冲突", status: "in_progress" },
        { id: "t3", step: "验证修改", status: "pending" }
      ]
    }, 3),
    ev("tool_call_started", { tool_call_id: "tc-a", activity_id: "a", name: "read_file", args: { path: "chapter.md" } }, 4),
    ev("plan_updated", {
      explanation: "继续修正冲突",
      items: [
        { id: "t2", step: "修正冲突", status: "completed" },
        { id: "t3", step: "验证修改", status: "in_progress" },
        { id: "t4", step: "提交结果", status: "pending" }
      ]
    }, 5),
    ev("model_turn_started", { turn_id: "turn-2", input_id: "in-2", reasoning_capability: "supported" }, 6)
  ]);

  const group = groupOf(work);
  assert.ok(group, "工作组按 run 建立");
  const items = orderedWorkItems(group);
  assert.deepEqual(
    items.map((item) => item.id),
    ["reasoning:turn-1", "tool:a", "plan:run-1", "reasoning:turn-2"],
    "最终顺序：reasoning-1、tool-A、plan（随后是新一轮 reasoning-2，证明计划移动到最新位置）"
  );

  const planItems = items.filter((item) => item.kind === "plan");
  assert.equal(planItems.length, 1, "plan 只有一个");
  const planItem = planItems[0];
  assert.equal(planItem.firstSeq, 3, "plan firstSeq 保持首次出现位置");
  assert.equal(planItem.sortSeq, 5, "plan sortSeq 等于第二次更新时间");
  // 内容仍包含全部任务：跨两次 plan_updated 按 task id 合并、绝不重复添加
  assert.deepEqual(
    planItem.plan.items.map((task) => task.id),
    ["t1", "t2", "t3", "t4"]
  );
  assert.deepEqual(
    planItem.plan.items.map((task) => [task.id, task.status]),
    [["t1", "completed"], ["t2", "completed"], ["t3", "in_progress"], ["t4", "pending"]]
  );
  assert.equal(planItem.plan.explanation, "继续修正冲突", "explanation 保持最新");

  // reasoning/tool 位置固定在开始事件（完成不移动）
  const reasoning = items.find((item) => item.id === "reasoning:turn-1");
  assert.equal(reasoning.firstSeq, 2);
  assert.equal(reasoning.sortSeq, 2);
  const tool = items.find((item) => item.id === "tool:a");
  assert.equal(tool.firstSeq, 4);
  assert.equal(tool.sortSeq, 4);
});

test("Step 5: 动效唯一性 —— openWorkItemIds / visibleLiveTargets 八条断言", () => {
  const work = createWorkState();
  const apply = (event) => reduceWorkEvent(work, event);
  const group = () => groupOf(work);

  apply(ev("run_started", { workflow: "general", input_id: "in-1" }, 1));

  apply(ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }, 2));
  const afterReasoningStarted = group();
  assert.deepEqual(openWorkItemIds(afterReasoningStarted), ["reasoning:turn-1"]);

  apply(ev("reasoning_completed", { turn_id: "turn-1", input_id: "in-1", text: "思考", availability: "available" }, 3));
  const afterReasoningCompleted = group();
  assert.deepEqual(openWorkItemIds(afterReasoningCompleted), []);

  apply(ev("tool_call_started", { tool_call_id: "tc-a", activity_id: "activity-a", name: "read_file", args: { path: "chapter.md" } }, 4));
  const afterToolAStarted = group();
  assert.deepEqual(openWorkItemIds(afterToolAStarted), ["tool:activity-a"]);
  assert.deepEqual(visibleLiveTargets(afterToolAStarted, { expanded: true }), ["tool:activity-a"]);
  assert.deepEqual(visibleLiveTargets(afterToolAStarted, { expanded: false }), ["group:run-1"]);

  apply(ev("tool_call_completed", { tool_call_id: "tc-a", activity_id: "activity-a", name: "read_file" }, 5));
  const afterToolACompleted = group();
  assert.deepEqual(openWorkItemIds(afterToolACompleted), []);

  // 未来真实并行事件的投影能力（当前 Runtime 顺序执行，见 Task 4 Step 6 契约）
  apply(ev("tool_call_started", { tool_call_id: "tc-a2", activity_id: "activity-a", name: "read_file", args: { path: "a.md" } }, 6));
  apply(ev("tool_call_started", { tool_call_id: "tc-b", activity_id: "activity-b", name: "shell", args: { command: "npm test" } }, 7));
  const afterTwoToolsStarted = group();
  assert.deepEqual(openWorkItemIds(afterTwoToolsStarted), ["tool:activity-a", "tool:activity-b"]);

  apply(ev("run_status_changed", { status: "waiting_user" }, 8));
  const afterWaitingUser = group();
  assert.deepEqual(openWorkItemIds(afterWaitingUser), []);
});

test("Step 3: 工具标签按状态生成（读取文件四态）", () => {
  assert.equal(toolLabel("read_file", "running"), "正在读取文件");
  assert.equal(toolLabel("read_file", "completed"), "已读取文件");
  assert.equal(toolLabel("read_file", "failed"), "读取文件失败");
  assert.equal(toolLabel("read_file", "cancelled"), "已停止读取文件");
  // 非读取类工具沿用同一状态模板
  assert.equal(toolLabel("shell", "running"), "正在运行命令");
  assert.equal(toolLabel("shell", "completed"), "已运行命令");
  assert.equal(toolLabel("write_file", "running"), "正在写入文件");
});

test("Step 3: 折叠摘要只用项目相对路径；无法确定相对路径时不伪造", () => {
  // 项目内绝对路径 → 折叠为相对路径
  const workIn = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-1", activity_id: "a1", name: "read_file", args: { path: "D:\\novel\\chapter.md" } }, 2)
  ]);
  const inItem = groupOf(workIn).items.get("tool:a1");
  assert.equal(inItem.detail, "chapter.md");
  assert.equal(inItem.target, "D:\\novel\\chapter.md", "详细区保留绝对路径");

  // 项目外路径无法转相对 → 回退安全脱敏后的 target（事件已 journal 侧脱敏）
  const workOut = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-2", activity_id: "a2", name: "read_file", args: { path: "C:\\elsewhere\\x.md" } }, 2)
  ]);
  assert.equal(groupOf(workOut).items.get("tool:a2").detail, "C:\\elsewhere\\x.md");

  // 已是相对路径：原样保留（不伪造拼接）
  const workRel = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-3", activity_id: "a3", name: "read_file", args: { path: "chapter.md" } }, 2)
  ]);
  assert.equal(groupOf(workRel).items.get("tool:a3").detail, "chapter.md");

  // 无项目根（旧测试事件缺 project_root）→ 不伪造，detail 为 null
  const workNoRoot = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1, { project_root: undefined }),
    ev("tool_call_started", { tool_call_id: "tc-4", activity_id: "a4", name: "shell", args: { command: "npm test" } }, 2, { project_root: undefined })
  ]);
  assert.equal(groupOf(workNoRoot).items.get("tool:a4").detail, null, "shell 无单一 target，detail 为 null");
});

test("Step 3/4: reasoning 与 tool 立即终结，waiting_user 压制不伪造", () => {
  // reasoning_completed → reasoning item 立即 completed
  const workReason = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }, 2),
    ev("reasoning_delta", { turn_id: "turn-1", input_id: "in-1", text: "先检查事实，" }, 3),
    ev("reasoning_delta", { turn_id: "turn-1", input_id: "in-1", text: "再回答。" }, 4),
    ev("reasoning_completed", { turn_id: "turn-1", input_id: "in-1", text: "先检查事实，再回答。", availability: "available" }, 5)
  ]);
  const reasonItem = groupOf(workReason).items.get("reasoning:turn-1");
  assert.equal(reasonItem.state, "completed");
  assert.equal(reasonItem.label, "已完成思考");
  assert.equal(reasonItem.text, "先检查事实，再回答。", "detail 保留权威全文");
  assert.equal(reasonItem.availability, "available");
  assert.deepEqual(openWorkItemIds(groupOf(workReason)), []);

  // tool_call_failed：普通错误 → failed；tool_cancelled → cancelled
  const workFailed = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-1", activity_id: "a1", name: "read_file", args: { path: "x.md" } }, 2),
    ev("tool_call_failed", { tool_call_id: "tc-1", activity_id: "a1", name: "read_file", error: "boom", message: "失败" }, 3)
  ]);
  const failedItem = groupOf(workFailed).items.get("tool:a1");
  assert.equal(failedItem.state, "failed");
  assert.equal(failedItem.label, "读取文件失败");

  const workCancelled = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-2", activity_id: "a2", name: "read_file", args: { path: "x.md" } }, 2),
    ev("tool_call_failed", { tool_call_id: "tc-2", activity_id: "a2", name: "read_file", error: "tool_cancelled", message: "操作已停止。" }, 3)
  ]);
  const cancelledItem = groupOf(workCancelled).items.get("tool:a2");
  assert.equal(cancelledItem.state, "cancelled");
  assert.equal(cancelledItem.label, "已停止读取文件");

  // waiting_user 压制该组所有 live item；恢复 running 后未闭合 item 重新 live
  const workWait = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-3", activity_id: "a3", name: "read_file", args: { path: "x.md" } }, 2),
    ev("run_status_changed", { status: "waiting_user" }, 3)
  ]);
  const waitGroup = groupOf(workWait);
  assert.deepEqual(openWorkItemIds(waitGroup), [], "waiting_user 压制 live item");
  assert.equal(waitGroup.items.get("tool:a3").state, "running", "不伪造 completed");
  reduceWorkEvent(workWait, ev("run_status_changed", { status: "running" }, 4));
  assert.deepEqual(openWorkItemIds(waitGroup), ["tool:a3"], "恢复 running 后未闭合 item 重新成为 live");
});

test("Step 4: 工作组展开默认值与终态耗时文案", () => {
  // running → expanded=true，文案"工作中"
  let work = reduceAll([ev("run_started", { workflow: "general", input_id: "in-1" }, 1)]);
  let group = groupOf(work);
  assert.equal(group.status, "running");
  assert.equal(group.expanded, true);
  assert.equal(groupStatusText(group, { active_elapsed_ms: 42000 }), "工作中");

  // completed → 自动折叠，工作了 42 秒
  work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("run_completed", {}, 2)
  ]);
  group = groupOf(work);
  assert.equal(group.status, "completed");
  assert.equal(group.expanded, false);
  assert.equal(groupStatusText(group, { active_elapsed_ms: 42000 }), "工作了 42 秒");

  // failed → 保持展开，工作了 42 秒 · 失败
  work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("run_failed", { error: "模型超时", code: "model_timeout" }, 2)
  ]);
  group = groupOf(work);
  assert.equal(group.expanded, true);
  assert.equal(groupStatusText(group, { active_elapsed_ms: 42000 }), "工作了 42 秒 · 失败");

  // cancelled → 工作了 18 秒 · 已停止
  work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("run_cancelled", { reason: "user_stop" }, 2)
  ]);
  group = groupOf(work);
  assert.equal(group.expanded, true);
  assert.equal(groupStatusText(group, { active_elapsed_ms: 18000 }), "工作了 18 秒 · 已停止");

  // interrupted → 保持展开
  work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("run_interrupted", { reason: "recovery_dangling" }, 2)
  ]);
  group = groupOf(work);
  assert.equal(group.status, "interrupted");
  assert.equal(group.expanded, true);

  // waiting_user → 保持展开
  work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("run_status_changed", { status: "waiting_user" }, 2)
  ]);
  group = groupOf(work);
  assert.equal(group.status, "waiting_user");
  assert.equal(group.expanded, true);
});

test("v1 兼容：无 turn_id 的 model_turn 事件只计数开放 turn，不产生 reasoning 工作项", () => {
  const work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("model_turn_started", {}, 2),
    ev("model_turn_completed", {}, 3)
  ]);
  const group = groupOf(work);
  assert.equal(group.legacyOpenTurns, 0, "成对开放/关闭后归零");
  assert.equal(orderedWorkItems(group).length, 0, "v1 无 reasoning 内容，不产生工作项");
});

test("openWorkItemIds 只列 running 项；plan 静态子项永不 live", () => {
  const work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("plan_updated", { items: [{ id: "t1", step: "任务一", status: "pending" }] }, 2),
    ev("tool_call_started", { tool_call_id: "tc-1", activity_id: "a1", name: "read_file", args: { path: "x.md" } }, 3)
  ]);
  const group = groupOf(work);
  const planItem = group.items.get("plan:run-1");
  assert.equal(planItem.state, "completed", "plan 项从不作为 live 目标");
  assert.deepEqual(openWorkItemIds(group), ["tool:a1"], "只列 running 的 tool 项");
  assert.deepEqual(visibleLiveTargets(group, { expanded: false }), ["group:run-1"]);
});
