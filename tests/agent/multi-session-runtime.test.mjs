// 多会话 runtime 验收测试（统一 Agent 内核计划 Task 4）。
//
// 覆盖 createProjectAgent 公共 seam 的多会话能力：
//   - 惰性创建：未发消息不产生会话条目；submit 无 sessionId 时首条消息创建会话，
//     title = 首条消息摘要（deriveSessionTitle）
//   - 串行门：其他会话存在非终态 run 时 submit → project_busy；同会话 submit
//     仍走 FIFO 队列（行为不变）
//   - 缺省 = 最近活跃会话：旧调用方不加 sessionId 时行为与现状一致（回归铁律）
//   - 显式会话：会话事件流各自独立（seq 各自从 1 单调递增）
//   - newSession/renameSession/archiveSession/restoreSession/deleteSession 委托注册表
//   - 迁移集成：旧单流 agentRoot → open 后 sessions() 含"对话 1"、事件可快照
//
// 本文件复用 project-agent-harness（createProjectAgentHarness 已注入临时
// storageRoot 隔离，绝不触碰真实用户目录）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { createAgentJournal } from "../../src/core/agent/journal.mjs";
import {
  createProjectAgentHarness,
  eventsOfType,
  sleep,
  waitFor,
  waitForIdle
} from "../helpers/project-agent-harness.mjs";

// 事件 seq 会话内单调递增（从 1 开始）。
function assertSeqMonotonic(events) {
  let prev = 0;
  for (const event of events) {
    assert.ok(Number.isInteger(event.seq) && event.seq > prev, `seq 会话内单调递增: ${event.seq}`);
    prev = event.seq;
  }
  if (events.length > 0) assert.equal(events[0].seq, 1, "每个会话的事件流都从 seq 1 开始");
}

// ---------------------------------------------------------------------------
// 惰性创建
// ---------------------------------------------------------------------------

test("惰性创建：submit 无 sessionId 创建会话，title 为首条消息摘要", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());
  // 未发消息：sessions() 为空（迁移源不存在也不产生条目）
  const before = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(before.sessions.length, 0);
  assert.equal(before.active_session_id, null);

  const result = await h.agent.submit({ projectRoot: h.projectRoot, text: "你好世界", source: "chat" });
  assert.ok(result.session_id, "submit 返回 session_id");

  const after = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(after.sessions.length, 1, "首条消息后恰好一个会话");
  assert.equal(after.sessions[0].session_id, result.session_id);
  assert.equal(after.sessions[0].title, "你好世界", "title = 首条消息摘要");
  assert.equal(after.active_session_id, result.session_id, "新建会话成为最近活跃");
  await waitForIdle(h.agent, h.projectRoot);
});

test("惰性创建：title 折叠连续空白并截断到 20 字符", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());
  // 输入含真实空白：trim 去首尾 + 连续空白折叠为单空格 + 截断 20 字符
  const raw = "  写   第一章   的   大纲内容很长很长很长很长很长很长  ";
  const result = await h.agent.submit({ projectRoot: h.projectRoot, text: raw, source: "chat" });
  const { sessions } = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(sessions[0].session_id, result.session_id);
  assert.equal(
    sessions[0].title,
    "写 第一章 的 大纲内容很长很长很长很长",
    "连续空白折叠为单空格并截断到 20 字符"
  );
  assert.equal(sessions[0].title.length, 20, "title 恰好 20 字符");
  assert.ok(!sessions[0].title.includes("  "), "title 不得含连续空白");
  await waitForIdle(h.agent, h.projectRoot);
});

// ---------------------------------------------------------------------------
// 串行门
// ---------------------------------------------------------------------------

test("串行门：其他会话运行中 submit → project_busy；同会话再 submit 仍排队", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await createProjectAgentHarness({
    gatewayScript: [
      async () => {
        await gate;
        return { text: "A 完成。" };
      },
      { reply: { text: "A2 完成。" } }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());

  const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A 任务", source: "chat" });
  // 等待 A 的模型轮次在途（run 非终态）
  await waitFor(h.agent, h.projectRoot, (session, snap) =>
    eventsOfType(snap.events, "model_turn_started").length >= 1
  );

  // 显式建 B（注册表条目；journal 尚未物化）
  const b = await h.agent.newSession({ projectRoot: h.projectRoot, title: "对话 B" });
  assert.notEqual(b.session_id, a.session_id);

  // B submit → 其他会话（A）非终态 → project_busy；且必须零副作用（串行门在
  // 会话物化/事件写入之前拒绝）
  const sessionsBefore = await h.agent.sessions({ projectRoot: h.projectRoot });
  const aSnapBefore = await h.agent.snapshot({ projectRoot: h.projectRoot, sessionId: a.session_id, afterSeq: 0, limit: 100000 });
  await assert.rejects(
    () => h.agent.submit({ projectRoot: h.projectRoot, text: "B 任务", source: "chat", sessionId: b.session_id }),
    (error) => error?.code === "project_busy"
  );
  // 零副作用断言：被拒提交不新建会话（仍只有 A 与 newSession 的 B）、不改 A 事件流
  const sessionsAfter = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(sessionsAfter.sessions.length, sessionsBefore.sessions.length, "被拒提交不得新建会话");
  assert.equal(sessionsAfter.sessions.length, 2, "仍只有 A 与 newSession 的 B");
  assert.equal(sessionsAfter.active_session_id, b.session_id, "被拒提交不改最近活跃指针");
  const aSnapAfter = await h.agent.snapshot({ projectRoot: h.projectRoot, sessionId: a.session_id, afterSeq: 0, limit: 100000 });
  assert.equal(aSnapAfter.events.length, aSnapBefore.events.length, "被拒提交不得向 A 追加事件");

  // 同会话（显式 A）再 submit 仍排队（FIFO 行为不变）
  const queued = await h.agent.submit({ projectRoot: h.projectRoot, text: "A2", source: "chat", sessionId: a.session_id });
  assert.equal(queued.queued, true);
  assert.equal(queued.run_id, a.run_id, "排队不得创建新 Run");
  assert.equal(queued.session_id, a.session_id);

  release();
  // A 的两个输入在同一个 Run 完成（显式快照 A；缺省已切到 B）
  const deadline = Date.now() + 20000;
  let snapA = null;
  while (Date.now() < deadline) {
    snapA = await h.agent.snapshot({ projectRoot: h.projectRoot, sessionId: a.session_id, afterSeq: 0, limit: 100000 });
    if (snapA.session?.status === "idle") break;
    await sleep(25);
  }
  assert.equal(snapA.session?.status, "idle", "A 应回到 idle");
  assert.equal(eventsOfType(snapA.events, "run_completed").length, 1, "A 的两个输入在同一个 Run 完成");
});

test("串行门：A 完成（终态）后 B 可提交", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "A。" } }, { reply: { text: "B。" } }] });
  t.after(() => h.cleanup());
  const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const b = await h.agent.newSession({ projectRoot: h.projectRoot, title: "B" });
  const bSub = await h.agent.submit({ projectRoot: h.projectRoot, text: "B", source: "chat", sessionId: b.session_id });
  assert.notEqual(bSub.run_id, a.run_id, "B 空闲后创建自己的 Run");
  await waitForIdle(h.agent, h.projectRoot);
});

test("clearHistory 其他会话不清运行中会话的循环状态（无双重模型调用）", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { text: "A 完成。" } },
      async () => {
        await gate;
        return { text: "B1 完成。" };
      },
      { reply: { text: "B2 完成。" } }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());
  // 会话 A：空闲（作为被清空对象）
  const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A 消息", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  // 会话 B：运行中（阻塞在第一个模型调用）
  const b = await h.agent.newSession({ projectRoot: h.projectRoot, title: "B" });
  const b1 = await h.agent.submit({ projectRoot: h.projectRoot, text: "B1", source: "chat", sessionId: b.session_id });
  await waitFor(h.agent, h.projectRoot, (session, snap) =>
    eventsOfType(snap.events, "model_turn_started").length >= 1
  );
  // 清空 A 的历史（A idle 放行）：不得复位 B 的飞行循环控制（runId/controller/
  // loopPromise/firstTurn）——否则 B 失去可中断性，且 submit 恢复路径会为同一
  // runId 启动第二个并发循环（双重模型调用）。
  const cleared = await h.agent.clearHistory({ projectRoot: h.projectRoot, sessionId: a.session_id, confirmIrreversible: true });
  assert.equal(cleared.status, "idle");
  // 期间再向 B submit：排队到既有 Run（submit 恢复路径 startLoop 复用原循环）
  const b2 = await h.agent.submit({ projectRoot: h.projectRoot, text: "B2", source: "chat", sessionId: b.session_id });
  assert.equal(b2.queued, true);
  assert.equal(b2.run_id, b1.run_id, "排队不得创建新 Run");
  release();
  const deadline = Date.now() + 20000;
  let snapB = null;
  while (Date.now() < deadline) {
    snapB = await h.agent.snapshot({ projectRoot: h.projectRoot, sessionId: b.session_id, afterSeq: 0, limit: 100000 });
    if (snapB.session?.status === "idle") break;
    await sleep(25);
  }
  assert.equal(snapB.session?.status, "idle", "B 应回到 idle");
  // 双重循环的精确可观测信号：B1 输入只应有一个模型轮次、只应被模型调用一次
  //（bug 下 loopPromise 被清 → submit 恢复路径为同一 runId 起第二个循环 →
  // B1 被二次处理）。B2 也应拿到自己的模型轮次。
  const b1Turns = eventsOfType(snapB.events, "model_turn_started").filter((e) => e.payload?.input_id === b1.input_id);
  const b2Turns = eventsOfType(snapB.events, "model_turn_started").filter((e) => e.payload?.input_id === b2.input_id);
  assert.equal(b1Turns.length, 1, "B1 输入只应有一个模型轮次（无双重循环）");
  assert.equal(b2Turns.length, 1, "B2 输入应拿到自己的模型轮次");
  assert.equal(h.gateway.calls.length, 3, "恰好 A + B1 + B2 三次模型调用");
  assert.equal(eventsOfType(snapB.events, "run_started").length, 1);
  assert.equal(eventsOfType(snapB.events, "run_completed").length, 1);
});

// ---------------------------------------------------------------------------
// 缺省 = 最近活跃
// ---------------------------------------------------------------------------

test("缺省 sessionId = 最近活跃：submit 后快照无 sessionId 返回该会话；建 B 后缺省切到 B", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "第一。" } }, { reply: { text: "第二。" } }] });
  t.after(() => h.cleanup());

  const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A 消息", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  // 缺省快照 = A（唯一且最近活跃）
  const snapA = await h.agent.snapshot({ projectRoot: h.projectRoot });
  assert.equal(snapA.session.session_id, a.session_id);
  assert.equal(eventsOfType(snapA.events, "assistant_message_completed").length, 1);

  // 显式建 B 并发送消息 → B 成为最近活跃
  const b = await h.agent.newSession({ projectRoot: h.projectRoot, title: "对话 B" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "B 消息", source: "chat", sessionId: b.session_id });
  await waitForIdle(h.agent, h.projectRoot);
  const snapDefault = await h.agent.snapshot({ projectRoot: h.projectRoot });
  assert.equal(snapDefault.session.session_id, b.session_id, "缺省快照切到最近活跃 B");

  // 显式快照 A 仍返回 A 的事件流
  const snapA2 = await h.agent.snapshot({ projectRoot: h.projectRoot, sessionId: a.session_id, afterSeq: 0, limit: 100000 });
  assert.equal(snapA2.session.session_id, a.session_id);
  assert.equal(eventsOfType(snapA2.events, "input_queued").map((e) => e.payload.text).includes("B 消息"), false, "A 的事件流不含 B 的输入");
});

// ---------------------------------------------------------------------------
// 显式会话：事件流各自独立
// ---------------------------------------------------------------------------

test("两会话事件流各自独立：seq 各自从 1 单调递增，互不串流", async (t) => {
  const h = await createProjectAgentHarness({
    gatewayScript: [{ reply: { text: "A1" } }, { reply: { text: "B1" } }, { reply: { text: "A2" } }]
  });
  t.after(() => h.cleanup());

  const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A1", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const b = await h.agent.newSession({ projectRoot: h.projectRoot, title: "B" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "B1", source: "chat", sessionId: b.session_id });
  await waitForIdle(h.agent, h.projectRoot);
  await h.agent.submit({ projectRoot: h.projectRoot, text: "A2", source: "chat", sessionId: a.session_id });
  await waitForIdle(h.agent, h.projectRoot);

  const snapA = await h.agent.snapshot({ projectRoot: h.projectRoot, sessionId: a.session_id, afterSeq: 0, limit: 100000 });
  const snapB = await h.agent.snapshot({ projectRoot: h.projectRoot, sessionId: b.session_id, afterSeq: 0, limit: 100000 });
  assertSeqMonotonic(snapA.events);
  assertSeqMonotonic(snapB.events);
  const textsA = eventsOfType(snapA.events, "input_queued").map((e) => e.payload.text);
  const textsB = eventsOfType(snapB.events, "input_queued").map((e) => e.payload.text);
  assert.deepEqual(textsA, ["A1", "A2"]);
  assert.deepEqual(textsB, ["B1"]);
  // 两会话的 session_created 各自恰好一条
  assert.equal(eventsOfType(snapA.events, "session_created").length, 1);
  assert.equal(eventsOfType(snapB.events, "session_created").length, 1);
});

// ---------------------------------------------------------------------------
// newSession / rename / archive / restore / delete
// ---------------------------------------------------------------------------

test("newSession/renameSession/archiveSession/restoreSession/deleteSession 委托注册表", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());

  const meta = await h.agent.newSession({ projectRoot: h.projectRoot, title: "原始标题" });
  assert.ok(meta.session_id);
  assert.equal(meta.title, "原始标题");

  const renamed = await h.agent.renameSession({ projectRoot: h.projectRoot, sessionId: meta.session_id, title: "新标题" });
  assert.equal(renamed.title, "新标题");

  const archived = await h.agent.archiveSession({ projectRoot: h.projectRoot, sessionId: meta.session_id });
  assert.ok(archived.archived_at, "archive 写入 archived_at");
  // 归档后缺省 lastActive 不再指向归档会话（唯一会话被归档 → null）
  const { sessions: archivedList, active_session_id } = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(active_session_id, null, "唯一会话被归档后无最近活跃");
  assert.equal(archivedList.length, 1, "归档会话仍列出（调用方按需过滤）");
  assert.ok(archivedList[0].archived_at, "列表中的归档会话带 archived_at");

  const restored = await h.agent.restoreSession({ projectRoot: h.projectRoot, sessionId: meta.session_id });
  assert.equal(restored.archived_at, null);

  await h.agent.deleteSession({ projectRoot: h.projectRoot, sessionId: meta.session_id });
  const { sessions: afterDelete } = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(afterDelete.length, 0, "永久删除后注册表不再含该会话");
});

test("显式 sessionId 不存在：open/submit 拒绝", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());
  await assert.rejects(
    () => h.agent.open({ projectRoot: h.projectRoot, sessionId: "ghost-session" }),
    (error) => error?.code === "session_not_found"
  );
  await assert.rejects(
    () => h.agent.submit({ projectRoot: h.projectRoot, text: "x", source: "chat", sessionId: "ghost-session" }),
    (error) => error?.code === "session_not_found"
  );
});

// ---------------------------------------------------------------------------
// open()：品牌新项目返回空项目状态（不建会话）；重复 open 幂等
// ---------------------------------------------------------------------------

test("open() 品牌新项目返回空项目状态且不建会话（惰性）", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());
  const opened = await h.agent.open({ projectRoot: h.projectRoot });
  assert.equal(opened.session_id, null);
  assert.equal(opened.status, "idle");
  const { sessions } = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(sessions.length, 0, "open 不产生会话条目");
  // 无会话时 snapshot 返回空快照
  const snap = await h.agent.snapshot({ projectRoot: h.projectRoot });
  assert.equal(snap.session, null);
  assert.deepEqual(snap.events, []);
});

// ---------------------------------------------------------------------------
// 迁移集成：旧单流 agentRoot → 会话 1
// ---------------------------------------------------------------------------

test("迁移集成：旧单流 agentRoot → open 后 sessions() 含'对话 1'、事件可快照", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());
  // 直接在应用私有 agentRoot 顶层构造旧单流 journal（Task 3 迁移源）
  const legacyJournal = createAgentJournal({ projectRoot: h.projectRoot, storageRoot: h.agentRoot });
  await legacyJournal.load();
  await legacyJournal.append({ type: "input_queued", payload: { input_id: "old-1", text: "旧消息", source: "chat" } });

  const opened = await h.agent.open({ projectRoot: h.projectRoot });
  assert.ok(opened.session_id, "open 解析出迁移的会话");
  const { sessions, active_session_id } = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "对话 1");
  assert.equal(active_session_id, sessions[0].session_id);

  // 迁移会话的事件可快照（缺省 = 最近活跃 = 迁移会话）
  const snap = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
  assert.ok(snap.session, "迁移会话可快照");
  assert.equal(eventsOfType(snap.events, "session_created").length, 1, "迁移流只含原有的一条 session_created");
  assert.equal(eventsOfType(snap.events, "input_queued").length, 1);
  assert.equal(eventsOfType(snap.events, "input_queued")[0].payload.text, "旧消息");

  // 迁移后旧数据已搬入 sessions/<id>/（根不再有孤儿 segments）
  const rootHasSegments = await fs
    .stat(`${h.agentRoot}/segments`)
    .then(() => true)
    .catch(() => false);
  assert.equal(rootHasSegments, false, "迁移后 agentRoot 根不得残留孤儿 segments/");
  const sessionDirHasSegments = await fs
    .stat(`${h.agentRoot}/sessions/${sessions[0].session_id}/segments`)
    .then(() => true)
    .catch(() => false);
  assert.equal(sessionDirHasSegments, true, "会话数据落在 sessions/<id>/ 下");
});
