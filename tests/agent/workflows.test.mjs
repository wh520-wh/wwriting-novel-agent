// src/core/agent/workflows.mjs 的测试（统一 Agent 内核计划 Task 6）。
//
// tests/agent/ 是允许测试内部 seam 的目录：本文件直接导入 workflows.mjs 与
// prompt.mjs 的 WORKFLOW_POLICIES，覆盖：
//   - 三个政策记录（general/chapter/init；Task 10 已删除 review）的固定形状
//   - promptId 与 prompt.mjs WORKFLOW_POLICIES 键一一对应
//   - allowedDeepTools：chapter 允许 append_chapter_segment/commit_chapter，
//     init 只允许 update_plan/enter_workflow（Task 7：不再暴露 commit_blueprint），
//     general 无领域深工具
//   - 嵌套拒绝（canEnterWorkflow）：general 可进任意工作流；深→深一律拒绝
//     （review 已删除，无修复路径特例）；同工作流空切换拒绝
//   - 章节号解析（中英文数字）
//   - chapter 政策上下文选择器注入 inspectChapterContext 动态上下文
//   - workflow 只能通过 enter_workflow 工具改变（经公共 seam 集成验证）
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { WORKFLOW_POLICIES } from "../../src/core/agent/prompt.mjs";
import {
  WORKFLOW_NAMES,
  WORKFLOW_POLICY_RECORDS,
  canEnterWorkflow,
  parseChapterNoFromText,
  workflowPolicy
} from "../../src/core/agent/workflows.mjs";
import { createProjectAgentHarness, eventsOfType, waitForIdle } from "../helpers/project-agent-harness.mjs";

const DEEP_NAMES = ["update_plan", "enter_workflow", "append_chapter_segment", "commit_chapter", "commit_blueprint"];

// ---------------------------------------------------------------------------
// 政策记录形状
// ---------------------------------------------------------------------------

test("三个政策记录存在且 promptId 与 prompt.mjs 的 WORKFLOW_POLICIES 键一致", () => {
  assert.deepEqual([...Object.keys(WORKFLOW_POLICY_RECORDS)].sort(), [...WORKFLOW_NAMES].sort());
  assert.deepEqual([...WORKFLOW_NAMES].sort(), ["chapter", "general", "init"], "Task 10：review workflow 必须删除");
  for (const name of WORKFLOW_NAMES) {
    const record = WORKFLOW_POLICY_RECORDS[name];
    assert.ok(record, `缺少 ${name} 政策记录`);
    assert.equal(record.promptId, name, `${name}.promptId 必须对应 prompt.mjs 的键`);
    assert.ok(Object.hasOwn(WORKFLOW_POLICIES, record.promptId), `prompt.mjs 缺少 ${name} 政策文本`);
    assert.ok(Array.isArray(record.allowedDeepTools), `${name}.allowedDeepTools 必须是数组`);
    assert.equal(typeof record.contextSelector, "function", `${name}.contextSelector 必须是函数`);
    assert.equal(typeof record.completionEvaluator, "function", `${name}.completionEvaluator 必须是函数`);
    for (const toolName of record.allowedDeepTools) {
      assert.ok(DEEP_NAMES.includes(toolName), `${name} 引用未知深工具 ${toolName}`);
    }
  }
  // workflowPolicy 未知名兜底 general
  assert.equal(workflowPolicy("no_such_workflow").promptId, "general");
  // Task 10 删除契约：WORKFLOW_POLICIES 不得再包含 review
  assert.ok(!Object.hasOwn(WORKFLOW_POLICIES, "review"), "prompt.mjs 不得再定义 review 政策文本");
  assert.ok(!Object.hasOwn(WORKFLOW_POLICY_RECORDS, "review"), "workflows.mjs 不得再定义 review 政策记录");
});

test("allowedDeepTools：各工作流只暴露自己的领域深工具", () => {
  const allowed = (name) => new Set(WORKFLOW_POLICY_RECORDS[name].allowedDeepTools);
  // chapter：允许追加段落与正式提交，但不得允许蓝图提交
  assert.ok(allowed("chapter").has("append_chapter_segment"));
  assert.ok(allowed("chapter").has("commit_chapter"));
  assert.ok(!allowed("chapter").has("commit_blueprint"));
  // init（Task 7）：/init 维护 WWRITING.md，只暴露 update_plan/enter_workflow；
  // 不得暴露 commit_blueprint，也不得直接写/提交章节正文
  assert.ok(!allowed("init").has("commit_blueprint"), "init 不得再暴露 commit_blueprint");
  assert.ok(!allowed("init").has("append_chapter_segment"));
  assert.ok(!allowed("init").has("commit_chapter"));
  assert.deepEqual(
    [...allowed("init")].sort(),
    ["enter_workflow", "update_plan"],
    "init 只允许计划与工作流切换"
  );
  // general：无领域深工具（只有 update_plan 与进入工作流的 enter_workflow）
  for (const toolName of ["append_chapter_segment", "commit_chapter", "commit_blueprint"]) {
    assert.ok(!allowed("general").has(toolName), `general 不得允许 ${toolName}`);
  }
  for (const name of WORKFLOW_NAMES) {
    assert.ok(allowed(name).has("update_plan"), `${name} 应允许 update_plan`);
    assert.ok(allowed(name).has("enter_workflow"), `${name} 应允许 enter_workflow（离开工作流的唯一途径）`);
  }
});

test("canEnterWorkflow 拒绝嵌套工作流", () => {
  // general → 任意工作流
  for (const target of ["chapter", "init"]) {
    assert.equal(canEnterWorkflow("general", target), true, `general → ${target} 应允许`);
  }
  // 任意工作流 → general
  for (const current of ["chapter", "init"]) {
    assert.equal(canEnterWorkflow(current, "general"), true, `${current} → general 应允许`);
  }
  // 深→深一律拒绝（Task 10：review 已删除，不再有 review → chapter 修复路径）
  assert.equal(canEnterWorkflow("chapter", "init"), false, "chapter → init 是嵌套，拒绝");
  assert.equal(canEnterWorkflow("init", "chapter"), false, "init → chapter 是嵌套，拒绝");
  // review 不是合法工作流：未知名目标一律拒绝（回退 general 兜底也不放开嵌套）
  assert.equal(canEnterWorkflow("general", "review"), false, "review 已删除，不允许进入");
  assert.equal(canEnterWorkflow("review", "chapter"), false, "review 已删除，不允许作为来源");
  // 同工作流空切换拒绝
  for (const name of WORKFLOW_NAMES) {
    assert.equal(canEnterWorkflow(name, name), false, `${name} → ${name} 是空切换，拒绝`);
  }
});

test("parseChapterNoFromText 解析中英文数字章节号", () => {
  assert.equal(parseChapterNoFromText("正式写第一章"), 1);
  assert.equal(parseChapterNoFromText("先改第 3 章"), 3);
  assert.equal(parseChapterNoFromText("写第12章"), 12);
  assert.equal(parseChapterNoFromText("修订第十章"), 10);
  assert.equal(parseChapterNoFromText("从第二十三章开始"), 23);
  assert.equal(parseChapterNoFromText("看下第五章的设定"), 5);
  assert.equal(parseChapterNoFromText("聊聊剧情"), null);
  assert.equal(parseChapterNoFromText(""), null);
  assert.equal(parseChapterNoFromText(null), null);
});

test("chapter 上下文选择器注入章节位置动态上下文", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());
  const selector = WORKFLOW_POLICY_RECORDS.chapter.contextSelector;

  const items = await selector({ projectRoot: h.projectRoot, inputText: "正式写第一章", session: null, project: null });
  assert.ok(Array.isArray(items) && items.length === 1, "识别到章节号时应注入章节上下文");
  assert.equal(items[0].source, "chapter-context");
  const parsed = JSON.parse(items[0].content);
  assert.equal(parsed.requested_chapter_no, 1);
  assert.equal(parsed.status, "not_started");
  assert.equal(parsed.is_committed, false);

  // 未识别章节号：不注入，也不抛错（模型自主读取）
  const none = await selector({ projectRoot: h.projectRoot, inputText: "帮我看下项目", session: null, project: null });
  assert.deepEqual(none, []);
  // project.yaml 缺失时容错为空
  const broken = await selector({ projectRoot: path.join(h.workspaceRoot, "missing-project"), inputText: "写第一章", session: null, project: null });
  assert.deepEqual(broken, []);
});

test("general/init 上下文选择器不注入项目文件内容", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());
  for (const name of ["general", "init"]) {
    const items = await WORKFLOW_POLICY_RECORDS[name].contextSelector({
      projectRoot: h.projectRoot,
      inputText: "处理这个项目",
      session: null,
      project: null
    });
    assert.deepEqual(items, [], `${name} 不应预先注入项目内容`);
  }
});

// ---------------------------------------------------------------------------
// 集成：workflow 只能通过 enter_workflow 工具改变
// ---------------------------------------------------------------------------

test("enter_workflow 切换 Run 的工作流且不启动第二个 Agent", async (t) => {
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [{ id: "call_ew_1", name: "enter_workflow", arguments: { workflow: "chapter", reason: "用户要求正式写作" } }] } },
      { reply: { text: "开始写作。" } }
    ]
  });
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "正式写第一章", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
  const changed = eventsOfType(events.events, "workflow_changed");
  assert.equal(changed.length, 1);
  assert.equal(changed[0].payload.workflow, "chapter");
  assert.equal(eventsOfType(events.events, "run_started").length, 1, "切换工作流不得创建第二个 Run/Agent");
  assert.equal(events.events.some((event) => event.type === "model_turn_completed"), true);
});

test("嵌套工作流被拒绝：chapter 中直接进入 init 的工具调用失败且不改变工作流", async (t) => {
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [{ id: "call_ew_1", name: "enter_workflow", arguments: { workflow: "chapter", reason: "写作" } }] } },
      { reply: { toolCalls: [{ id: "call_ew_2", name: "enter_workflow", arguments: { workflow: "init", reason: "嵌套" } }] } },
      { reply: { text: "好的，保持现状。" } }
    ]
  });
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "写章节", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const snap = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
  const events = snap.events;
  assert.equal(eventsOfType(events, "workflow_changed").length, 1, "嵌套切换不得写入 workflow_changed");
  assert.equal(eventsOfType(events, "workflow_changed")[0].payload.workflow, "chapter");
  const denied = eventsOfType(events, "tool_call_failed").filter((event) => event.payload.name === "enter_workflow");
  assert.equal(denied.length, 1, "嵌套 enter_workflow 必须失败");
  assert.equal(denied[0].payload.error, "before_tool_use_denied");
  assert.equal(eventsOfType(events, "run_completed").length, 1);
});

test("运行时再次强制工作流工具授权：general 不能直接调用 commit_blueprint", async (t) => {
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [{ id: "call_denied_blueprint", name: "commit_blueprint", arguments: {
        project_id: "placeholder",
        outline: "# 不应提交",
        setting: "不应写入"
      } }] } },
      { reply: { text: "已继续处理。" } }
    ]
  });
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "普通请求", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const snap = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
  const completed = eventsOfType(snap.events, "tool_call_completed")
    .filter((event) => event.payload.name === "commit_blueprint");
  const failed = eventsOfType(snap.events, "tool_call_failed")
    .filter((event) => event.payload.name === "commit_blueprint");
  assert.equal(completed.length, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.error, "tool_not_allowed");
});

test("init 工作流也不再暴露 commit_blueprint：运行层拒绝且不写蓝图文件", async (t) => {
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { toolCalls: [{ id: "call_ew_init", name: "enter_workflow", arguments: { workflow: "init", reason: "/init" } }] } },
      { reply: { toolCalls: [{ id: "call_init_blueprint", name: "commit_blueprint", arguments: {
        project_id: "placeholder",
        outline: "# 不应提交",
        setting: "不应写入",
        evidence_paths: []
      } }] } },
      { reply: { text: "已继续处理。" } }
    ]
  });
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "/init", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const snap = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
  const completed = eventsOfType(snap.events, "tool_call_completed")
    .filter((event) => event.payload.name === "commit_blueprint");
  const failed = eventsOfType(snap.events, "tool_call_failed")
    .filter((event) => event.payload.name === "commit_blueprint");
  assert.equal(completed.length, 0, "init 工作流中 commit_blueprint 不得完成");
  assert.equal(failed.length, 1, "init 工作流中 commit_blueprint 必须被拒绝");
  assert.equal(failed[0].payload.error, "tool_not_allowed");
  assert.equal(eventsOfType(snap.events, "workflow_changed").length, 1, "应进入 init 工作流");
  assert.equal(eventsOfType(snap.events, "run_completed").length, 1, "拒绝后 Run 正常完成");
});
