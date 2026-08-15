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
  formatDuration,
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
  assert.equal(reasonItem.label, "思考 1 秒");
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

test("Step 4: 工作组展开默认值与终态耗时文案（每组自带时钟，不再读当前 run）", () => {
  const T0 = "2026-08-06T00:00:00.000Z";
  const atSec = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();

  // running → expanded=true，文案"工作中"
  let work = reduceAll([ev("run_started", { workflow: "general", input_id: "in-1" }, 1, { at: atSec(0) })]);
  let group = groupOf(work);
  assert.equal(group.status, "running");
  assert.equal(group.expanded, true);
  assert.equal(group.activeMs, 0);
  assert.equal(group.activeSince, atSec(0), "运行开始即进入活动区间");
  assert.equal(group.elapsedMs, null);
  assert.equal(groupStatusText(group), "工作中");

  // completed → 自动折叠，工作了 42 秒（组自身时钟 0→42s）
  work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1, { at: atSec(0) }),
    ev("run_completed", {}, 2, { at: atSec(42) })
  ]);
  group = groupOf(work);
  assert.equal(group.status, "completed");
  assert.equal(group.expanded, false);
  assert.equal(group.elapsedMs, 42000, "终态冻结自身累计耗时");
  assert.equal(group.activeSince, null, "终态离开活动区间");
  assert.equal(groupStatusText(group), "工作了 42 秒");

  // failed → 保持展开，工作了 42 秒 · 失败
  work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1, { at: atSec(0) }),
    ev("run_failed", { error: "模型超时", code: "model_timeout" }, 2, { at: atSec(42) })
  ]);
  group = groupOf(work);
  assert.equal(group.expanded, true);
  assert.equal(groupStatusText(group), "工作了 42 秒 · 失败");

  // cancelled → 工作了 18 秒 · 已停止
  work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1, { at: atSec(0) }),
    ev("run_cancelled", { reason: "user_stop" }, 2, { at: atSec(18) })
  ]);
  group = groupOf(work);
  assert.equal(group.expanded, true);
  assert.equal(groupStatusText(group), "工作了 18 秒 · 已停止");

  // interrupted → 保持展开，终态文案为英文固定文案（Task 11：实际被截断的
  // 执行组显示 Interrupted by the user，不伪装耗时叙事）
  work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1, { at: atSec(0) }),
    ev("run_interrupted", { reason: "recovery_dangling" }, 2, { at: atSec(18) })
  ]);
  group = groupOf(work);
  assert.equal(group.status, "interrupted");
  assert.equal(group.expanded, true);
  assert.equal(groupStatusText(group), "Interrupted by the user");

  // waiting_user → 保持展开；等待不计时，文案"待命"（与 session-sidebar RUN_STATUS_LABELS 口径统一）
  work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1, { at: atSec(0) }),
    ev("run_status_changed", { status: "waiting_user" }, 2, { at: atSec(10) })
  ]);
  group = groupOf(work);
  assert.equal(group.status, "waiting_user");
  assert.equal(group.expanded, true);
  assert.equal(group.activeMs, 10000, "进入等待前已累计 10s");
  assert.equal(group.activeSince, null, "等待期间不在活动区间");
  assert.equal(groupStatusText(group), "待命");
});

test("工作时钟镜像 journal transitionWorkClock：waiting_user 不计时，终态冻结自身值", () => {
  const T0 = "2026-08-06T00:00:00.000Z";
  const atSec = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();
  const work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1, { at: atSec(0) }), // 运行开始
    ev("run_status_changed", { status: "waiting_user" }, 2, { at: atSec(10) }),        // 运行 10s → 等待
    ev("run_status_changed", { status: "running" }, 3, { at: atSec(40) }),             // 等待 30s → 恢复
    ev("run_completed", {}, 4, { at: atSec(45) })                                      // 再运行 5s → 完成
  ]);
  const group = groupOf(work);
  assert.equal(group.activeMs, 15000, "10s + 5s，等待 30s 不计入");
  assert.equal(group.elapsedMs, 15000, "终态冻结累计有效耗时");
  assert.equal(groupStatusText(group), "工作了 15 秒");
});

test("两个 Run：首个完成组的 elapsedMs 冻结在自身值，不被第二个 Run 的事件覆盖", () => {
  const T0 = "2026-08-06T00:00:00.000Z";
  const atSec = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();
  const work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1, { at: atSec(0) }),
    ev("run_completed", {}, 2, { at: atSec(10) }),
    ev("run_started", { workflow: "general", input_id: "in-2" }, 3, { run_id: "run-2", at: atSec(20) }),
    ev("model_turn_started", { turn_id: "turn-b", input_id: "in-2", reasoning_capability: "supported" }, 4, { run_id: "run-2", at: atSec(25) }),
    ev("run_completed", {}, 5, { run_id: "run-2", at: atSec(30) })
  ]);
  const groupA = work.groups.get("run-1");
  const groupB = work.groups.get("run-2");
  assert.ok(groupA && groupB, "两个工作组");
  assert.equal(groupA.elapsedMs, 10000, "run A 冻结在自身 10s");
  assert.equal(groupA.status, "completed");
  assert.equal(groupB.elapsedMs, 10000, "run B 自身 10s（20→30s）");
  assert.equal(groupStatusText(groupA), "工作了 10 秒");
  assert.equal(groupStatusText(groupB), "工作了 10 秒");
});

test("retry 同一 runId：保留累计有效耗时并重新计时", () => {
  const T0 = "2026-08-06T00:00:00.000Z";
  const atSec = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();
  const work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1, { at: atSec(0) }),
    ev("run_failed", { error: "模型超时", code: "model_timeout" }, 2, { at: atSec(10) }),
    ev("run_started", { workflow: "general", input_id: "in-1" }, 3, { at: atSec(20) }), // retry 同一 runId
    ev("run_completed", {}, 4, { at: atSec(25) })
  ]);
  const group = groupOf(work);
  assert.equal(group.startedAt, atSec(0), "retry 保留原 startedAt");
  assert.equal(group.elapsedMs, 15000, "10s + 5s：保留失败前累计，retry 后重新计时");
  assert.equal(groupStatusText(group), "工作了 15 秒");
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

test("Task 11: input_interrupted 只结束活动输入，不终结 Run 工作组；已完整返回的 reasoning 保持正常完成", () => {
  // 优先切换批次 = input_interrupted(A) + input_started(D)（同一 run id）。
  // 工作组持续运行（D 继续消费），不得显示 interrupted 终态；已 completed 的
  // reasoning 不伪装成被中断。
  const work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }, 2),
    ev("reasoning_completed", { turn_id: "turn-1", input_id: "in-1", text: "完整思考内容", availability: "available" }, 3),
    ev("tool_call_started", { tool_call_id: "tc-a", activity_id: "a1", name: "read_file", args: { path: "x.md" } }, 4),
    ev("input_interrupted", { input_id: "in-1" }, 5),
    ev("input_started", { input_id: "in-2" }, 6)
  ]);
  const group = groupOf(work);
  assert.equal(group.status, "running", "优先切换不终结 Run，工作组保持运行中");
  const reasoning = group.items.get("reasoning:turn-1");
  assert.equal(reasoning.state, "completed", "已完整返回的 reasoning 保持正常完成");
  assert.equal(reasoning.label, "思考 1 秒");
  assert.equal(reasoning.text, "完整思考内容");
  const tool = group.items.get("tool:a1");
  assert.equal(tool.state, "running", "切换发生时未收敛的工具仍如实 running（不伪造 interrupted）");
  assert.equal(groupStatusText(group), "工作中");
});

test("Task 11: input_withdrawn 不影响工作组；撤回的输入不产生任何工作项", () => {
  const work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }, 2),
    ev("input_queued", { input_id: "in-2", text: "将被撤回" }, 3),
    ev("input_withdrawn", { input_id: "in-2" }, 4)
  ]);
  const group = groupOf(work);
  assert.equal(group.status, "running");
  assert.equal(orderedWorkItems(group).length, 1, "撤回的排队输入不产生工作项");
  assert.equal(group.items.get("reasoning:turn-1").state, "running");
});

test("stopping 状态同样压制 live item（停止始终静态，Task 6 Step 7 rule 5）", () => {
  const work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-s", activity_id: "a-s", name: "shell", args: { command: "npm test" } }, 2),
    ev("run_status_changed", { status: "stopping" }, 3)
  ]);
  const group = groupOf(work);
  assert.deepEqual(openWorkItemIds(group), [], "stopping 压制 live item");
  assert.equal(group.items.get("tool:a-s").state, "running", "不伪造 completed");
  assert.deepEqual(visibleLiveTargets(group, { expanded: true }), [], "展开状态下也无 live 目标");
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

test("Task 24: formatDuration 统一工作计时格式（尾零不省略；负数/NaN 归零；毫秒向下取整）", () => {
  assert.equal(formatDuration(0), "0 秒");
  assert.equal(formatDuration(59_999), "59 秒");
  assert.equal(formatDuration(60_000), "1 分 0 秒");
  assert.equal(formatDuration(3_599_999), "59 分 59 秒");
  assert.equal(formatDuration(3_600_000), "1 小时 0 分 0 秒");
  assert.equal(formatDuration(3_661_000), "1 小时 1 分 1 秒");
  assert.equal(formatDuration(-1), "0 秒");
  assert.equal(formatDuration(Number.NaN), "0 秒");
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), "0 秒");
  // 非整秒向下取整：59.6 秒不得显示成不存在的 60 秒
  assert.equal(formatDuration(59_600), "59 秒");
  assert.equal(formatDuration(60_600), "1 分 0 秒");
});

test("Task 2: tool_output_delta 跨多次增量累计输出；未知 activity_id 忽略", () => {
  const work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-1", activity_id: "a1", name: "shell", args: { command: "npm test" } }, 2),
    ev("tool_output_delta", { activity_id: "a1", text: "PASS " }, 3),
    ev("tool_output_delta", { activity_id: "a1", text: "1/1" }, 4)
  ]);
  const item = groupOf(work).items.get("tool:a1");
  assert.equal(item.output, "PASS 1/1", "增量按到达顺序拼接");
  assert.equal(item.truncated, false);
  assert.equal(item.exit_code, null, "初始 null");
  assert.equal(item.duration_ms, null, "初始 null");
  assert.equal(item.state, "running", "delta 不改变工具状态");

  // 未知 activity_id：忽略、不崩溃、不凭空创建工具项
  const workUnknown = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_output_delta", { activity_id: "ghost", text: "x" }, 2),
    ev("tool_call_started", { tool_call_id: "tc-2", activity_id: "a2", name: "read_file", args: { path: "x.md" } }, 3),
    ev("tool_output_delta", { activity_id: "ghost", text: "y" }, 4)
  ]);
  assert.equal(groupOf(workUnknown).items.size, 1, "未知 activity_id 不创建工具项");
  assert.equal(groupOf(workUnknown).items.get("tool:a2").output, "", "已知项不受陌生 delta 影响");
});

test("Task 2: 输出超过 64 KiB 保留尾部并置 truncated=true", () => {
  const HEAD = "a".repeat(40_000);
  const TAIL = "b".repeat(40_000);
  const work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-1", activity_id: "a1", name: "shell", args: { command: "npm test" } }, 2),
    ev("tool_output_delta", { activity_id: "a1", text: HEAD }, 3),
    ev("tool_output_delta", { activity_id: "a1", text: TAIL }, 4)
  ]);
  const item = groupOf(work).items.get("tool:a1");
  assert.equal(item.output.length, 64 * 1024, "保留最后 64 KiB");
  assert.equal(item.truncated, true, "截断标记置位");
  assert.ok(item.output.endsWith(TAIL), "最新内容保留在尾部");
  assert.ok(item.output.startsWith("a".repeat(25_536)), "更早内容仅裁掉头部溢出部分");
});

test("Task 2: tool_call_completed 写入 exit_code（0 合法）与 duration_ms", () => {
  const work = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-1", activity_id: "a1", name: "shell", args: { command: "npm test" } }, 2),
    ev("tool_output_delta", { activity_id: "a1", text: "ok" }, 3),
    ev("tool_call_completed", { tool_call_id: "tc-1", activity_id: "a1", exit_code: 0, duration_ms: 1234 }, 4)
  ]);
  const item = groupOf(work).items.get("tool:a1");
  assert.equal(item.state, "completed");
  assert.equal(item.exit_code, 0, "0 是合法退出码，不得被空值检查吞掉");
  assert.equal(item.duration_ms, 1234);
  assert.equal(item.output, "ok", "completed 不清空已累计输出");

  // 事件未携带 exit_code/duration_ms → 保持初始 null
  const workNoMeta = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-2", activity_id: "a2", name: "read_file", args: { path: "x.md" } }, 2),
    ev("tool_call_completed", { tool_call_id: "tc-2", activity_id: "a2", name: "read_file" }, 3)
  ]);
  const noMeta = groupOf(workNoMeta).items.get("tool:a2");
  assert.equal(noMeta.state, "completed");
  assert.equal(noMeta.exit_code, null);
  assert.equal(noMeta.duration_ms, null);
});

test("Task 2: tool_call_failed 追加 stdout/stderr；终态仍按 CANCELLED_ERROR_CODES", () => {
  const workFailed = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-1", activity_id: "a1", name: "shell", args: { command: "npm test" } }, 2),
    ev("tool_call_failed", { tool_call_id: "tc-1", activity_id: "a1", error: "boom", message: "命令失败", stdout: "1 failed", stderr: "Error: boom", duration_ms: 5000 }, 3)
  ]);
  const failedItem = groupOf(workFailed).items.get("tool:a1");
  assert.equal(failedItem.state, "failed");
  assert.equal(failedItem.output, "1 failedError: boom", "stdout 先于 stderr 追加");
  assert.equal(failedItem.error, "命令失败");
  assert.equal(failedItem.duration_ms, 5000, "失败事件携带的耗时同样投影");

  // tool_cancelled：输出同样保留，终态为 cancelled；空 stderr 不追加
  const workCancelled = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-2", activity_id: "a2", name: "shell", args: { command: "npm test" } }, 2),
    ev("tool_call_failed", { tool_call_id: "tc-2", activity_id: "a2", error: "tool_cancelled", message: "已停止", stdout: "partial", stderr: "" }, 3)
  ]);
  const cancelledItem = groupOf(workCancelled).items.get("tool:a2");
  assert.equal(cancelledItem.state, "cancelled");
  assert.equal(cancelledItem.label, "已停止运行命令");
  assert.equal(cancelledItem.output, "partial", "空 stderr 不追加");

  // 无 stdout/stderr 字段 → 输出保持空
  const workNoOut = reduceAll([
    ev("run_started", { workflow: "general", input_id: "in-1" }, 1),
    ev("tool_call_started", { tool_call_id: "tc-3", activity_id: "a3", name: "read_file", args: { path: "x.md" } }, 2),
    ev("tool_call_failed", { tool_call_id: "tc-3", activity_id: "a3", error: "boom" }, 3)
  ]);
  assert.equal(groupOf(workNoOut).items.get("tool:a3").output, "");
});

// ===========================================================================
// 第九轮：组锚点迁移（run_started → 首个 input_started），根因修复的投影层契约
// ===========================================================================

test("第九轮：真实 journal 顺序下组 firstSeq 迁移到首个 input_started 的 seq", () => {
  const work = reduceAll([
    ev("run_started", { workflow: "general" }, 1),
    ev("input_queued", { input_id: "in-1", text: "帮我写第一章", source: "chat" }, 2),
    ev("input_started", { input_id: "in-1" }, 3),
    ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }, 4),
    ev("tool_call_started", { tool_call_id: "tc-1", activity_id: "a1", name: "read_file", args: { path: "x.md" } }, 5)
  ]);
  const group = groupOf(work);
  assert.equal(group.runStartedSeq, 1, "记录 run_started 锚点");
  assert.equal(group.firstSeq, 3, "firstSeq 迁移到首个 input_started 的 seq——与用户消息同 seq，字典序保证消息在前");
});

test("第九轮：firstSeq 只迁移一次（priority/多消息的后续 input_started 不再移动组）", () => {
  const work = reduceAll([
    ev("run_started", { workflow: "general" }, 1),
    ev("input_queued", { input_id: "in-1", text: "第一条", source: "chat" }, 2),
    ev("input_started", { input_id: "in-1" }, 3),
    ev("input_interrupted", { input_id: "in-1" }, 4),
    ev("input_started", { input_id: "in-2" }, 5) // priority 切换：第二个 input_started
  ]);
  assert.equal(groupOf(work).firstSeq, 3, "第二个 input_started 不得再次迁移组锚点");
});

test("第九轮：retry 后 run_started 再现与后续 input_started 不移动已迁移的锚点", () => {
  const work = reduceAll([
    ev("run_started", { workflow: "general" }, 1),
    ev("input_queued", { input_id: "in-1", text: "消息", source: "chat" }, 2),
    ev("input_started", { input_id: "in-1" }, 3),
    ev("run_failed", {}, 4),
    ev("run_started", { workflow: "general" }, 5), // retry：同 runId 恢复
    ev("input_started", { input_id: "in-2" }, 6)
  ]);
  const group = groupOf(work);
  assert.equal(group.firstSeq, 3, "retry 不移动已迁移锚点");
  assert.equal(group.runStartedSeq, 5, "runStartedSeq 跟随最新 run_started（供防御性判定）");
});

test("第九轮：无 input_started（v1 日志/纯 run 标记）时组锚点保持 run_started", () => {
  const work = reduceAll([
    ev("run_started", { workflow: "general" }, 1),
    ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }, 2)
  ]);
  assert.equal(groupOf(work).firstSeq, 1, "无 input_started 不迁移");
});

test("第九轮：重放幂等——同一事件集重建后 firstSeq 稳定", () => {
  const events = [
    ev("run_started", { workflow: "general" }, 1),
    ev("input_queued", { input_id: "in-1", text: "消息", source: "chat" }, 2),
    ev("input_started", { input_id: "in-1" }, 3),
    ev("model_turn_started", { turn_id: "turn-1", input_id: "in-1", reasoning_capability: "supported" }, 4)
  ];
  const first = reduceAll(events);
  const rebuilt = reduceAll(events); // 模拟 rebuildDerivedState 按 seq 升序重放
  assert.equal(rebuilt.groups.get("run-1").firstSeq, first.groups.get("run-1").firstSeq);
  assert.equal(rebuilt.groups.get("run-1").firstSeq, 3, "重放后锚点仍是首个 input_started 的 seq");
});

test("AICSS 思考 N 秒：完成标签取 turn 真实耗时，四舍五入最小 1；无时间戳回退已完成思考", () => {
  const work = reduceAll([
    ev("run_started", {}, 1),
    ev("model_turn_started", { turn_id: "t1" }, 2, { at: "2026-08-06T00:00:00.000Z" }),
    ev("reasoning_completed", { turn_id: "t1", text: "a", availability: "available" }, 3, { at: "2026-08-06T00:00:07.600Z" })
  ]);
  const item = groupOf(work).items.get("reasoning:t1");
  assert.equal(item.label, "思考 8 秒");
  assert.equal(item.thinking_ms, 7600);

  const work2 = reduceAll([
    ev("run_started", {}, 1),
    ev("model_turn_started", { turn_id: "t2" }, 2),
    ev("reasoning_completed", { turn_id: "t2", text: "a", availability: "available" }, 3, { at: "2026-08-06T00:00:00.000Z" })
  ]);
  // 0ms（同 at）→ 最小 1 秒
  assert.equal(work2.groups.get("run-1").items.get("reasoning:t2").label, "思考 1 秒");

  const work3 = reduceAll([
    ev("run_started", {}, 1),
    ev("model_turn_started", { turn_id: "t3" }, 2),
    // reasoning_completed 不带 at → 无法计算 → 回退
    ev("reasoning_completed", { turn_id: "t3", text: "a", availability: "available" }, 3, { at: null })
  ]);
  assert.equal(work3.groups.get("run-1").items.get("reasoning:t3").label, "已完成思考");
});
