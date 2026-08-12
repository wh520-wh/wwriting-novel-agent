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
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentJournal } from "../../src/core/agent/journal.mjs";
import { deriveSessionTitle } from "../../src/core/agent/runtime.mjs";
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

test("自动命名：newSession（无 title）→ submit 显式 sessionId → title 为首条消息摘要", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());
  // "+" 按钮流程：createSession()（无 title → 默认 "新对话"）→ submit(text, sessionId)
  const meta = await h.agent.newSession({ projectRoot: h.projectRoot });
  assert.equal(meta.title, "新对话", "无 title 时默认标题");
  const text = "  自动   命名   的消息内容   ";
  await h.agent.submit({ projectRoot: h.projectRoot, text, source: "chat", sessionId: meta.session_id });
  const { sessions } = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(sessions.length, 1);
  assert.equal(
    sessions[0].title,
    deriveSessionTitle(text),
    "显式创建会话在首条消息后按消息摘要自动命名（与惰性创建路径一致）"
  );
  await waitForIdle(h.agent, h.projectRoot);
});

test("自动命名：用户已改名的会话不受 submit 影响（标题保持）", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());
  const meta = await h.agent.newSession({ projectRoot: h.projectRoot });
  await h.agent.renameSession({ projectRoot: h.projectRoot, sessionId: meta.session_id, title: "我的大纲" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第一条消息", source: "chat", sessionId: meta.session_id });
  const { sessions } = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(sessions[0].title, "我的大纲", "用户已改名（title ≠ 新对话）的会话绝不被自动命名覆盖");
  await waitForIdle(h.agent, h.projectRoot);
});

// ---------------------------------------------------------------------------
// Task 9：sessions() 的 run_status 投影（侧边栏状态点 + busy 复位数据源）
// ---------------------------------------------------------------------------

test("sessions() 投影 run_status：运行中 → running；未物化 → idle；终态 → idle；失败 → failed", async (t) => {
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
      { error: new Error("模型调用失败") }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());

  // 会话 A 运行中（阻塞在模型调用）→ run_status "running"
  const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A 任务", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (_session, snap) =>
    eventsOfType(snap.events, "model_turn_started").length >= 1
  );
  let running = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(
    running.sessions.find((s) => s.session_id === a.session_id).run_status,
    "running",
    "运行中的会话 → run_status running"
  );

  // 未物化会话（newSession 只写注册表条目）→ "idle"
  const b = await h.agent.newSession({ projectRoot: h.projectRoot, title: "对话 B" });
  const withB = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(
    withB.sessions.find((s) => s.session_id === b.session_id).run_status,
    "idle",
    "未物化会话 → run_status idle"
  );
  // 其他会话的条目不互相污染：B 的投影不得影响 A 的 running
  assert.equal(withB.sessions.find((s) => s.session_id === a.session_id).run_status, "running");

  // A 终态（completed）→ "idle"
  release();
  const aDeadline = Date.now() + 20000;
  while (Date.now() < aDeadline) {
    const snap = await h.agent.snapshot({ projectRoot: h.projectRoot, sessionId: a.session_id, afterSeq: 0, limit: 100000 });
    if (snap.session?.status === "idle") break;
    await sleep(25);
  }
  const afterA = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(
    afterA.sessions.find((s) => s.session_id === a.session_id).run_status,
    "idle",
    "终态（completed）→ run_status idle"
  );

  // B 提交 → 模型失败 → run_failed → "failed"
  await h.agent.submit({ projectRoot: h.projectRoot, text: "B 任务", source: "chat", sessionId: b.session_id });
  const bDeadline = Date.now() + 20000;
  while (Date.now() < bDeadline) {
    const snap = await h.agent.snapshot({ projectRoot: h.projectRoot, sessionId: b.session_id, afterSeq: 0, limit: 100000 });
    if (snap.session?.status === "idle" && eventsOfType(snap.events, "run_failed").length >= 1) break;
    await sleep(25);
  }
  const afterB = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(
    afterB.sessions.find((s) => s.session_id === b.session_id).run_status,
    "failed",
    "失败终态 → run_status failed"
  );
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

// ---------------------------------------------------------------------------
// 回归（2026-08-11）：跨 agent 实例（进程重启）重建同一会话的 journal 后，
// 首个常规 append 不得把外部会话 id 重盖为 event_id。旧实现的「首次调用返回
// sessionId」idFactory 闭包让每个实例重复盖章，event_id 撞已有事件 → 该会话
// journal 无法重放，open/submit 抛 INTERNAL_ERROR（用户侧表现为「发送失败：
// 操作未完成，请重试…」且消息从未落盘）。修复后 event_id 恒为随机值。
// ---------------------------------------------------------------------------
test("回归·跨 agent 实例重建会话后仍可 open/send（event_id 不得重复盖章）", async (t) => {
  const { createProjectAgent } = await import("../../src/core/agent/index.mjs");
  const { createWorkspaceStore } = await import("../../src/core/workspaces/store.mjs");
  const { createProjectRoot, createMockModelGateway, waitForIdle, readEvents } = await import("../helpers/project-agent-harness.mjs");
  const workspaceRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? os.tmpdir(), "wwriting-multi-session-regression-"));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const { projectRoot } = await createProjectRoot(workspaceRoot);
  const store = createWorkspaceStore({ stateRoot: path.join(workspaceRoot, "user-data") });
  const storageRoot = store.agentRootFor(projectRoot);

  const makeAgent = (text) =>
    createProjectAgent({
      modelGateway: createMockModelGateway({ script: [{ reply: { text: "好。" } }] }),
      agentStorageRootFor: (root) => store.agentRootFor(root)
    });

  // 连续三个「进程生命周期」：每次重建 agent（等价应用重启），各完成一轮发送。
  for (let i = 0; i < 3; i += 1) {
    const agent = makeAgent();
    await agent.open({ projectRoot });
    await agent.submit({ projectRoot, text: `第 ${i + 1} 条消息`, source: "chat" });
    await waitForIdle(agent, projectRoot);
  }

  // 第四个实例：open + snapshot 不得因 event_id 重复而失败（修复前的崩溃点）。
  const finalAgent = makeAgent();
  await assert.doesNotReject(() => finalAgent.open({ projectRoot }), "跨实例重建后 open 不得抛 event_id 重复");
  const events = await readEvents(finalAgent, projectRoot, { afterSeq: 0, limit: 100000 });
  const sessionId = finalAgent.snapshot ? (await finalAgent.snapshot({ projectRoot, afterSeq: 0, limit: 1 })).session.session_id : null;
  const eventIds = new Set();
  for (const event of events) {
    assert.ok(!eventIds.has(event.event_id), `event_id 全局唯一（seq ${event.seq} ${event.type}）`);
    eventIds.add(event.event_id);
    if (sessionId) assert.notEqual(event.event_id, sessionId, "event_id 不得等于会话 id");
  }
  assert.equal(eventIds.size, events.length);
  assert.ok(events.length >= 6, `跨实例共追加了事件（实际 ${events.length}）`);
  assert.ok(sessionId, "快照能读到会话");
});

// ---------------------------------------------------------------------------
// Task 9：session mutex 下的 submit/withdraw/stop/priority（新输入生命周期）
// ---------------------------------------------------------------------------
//
// 每个操作（submit/requestPriority/withdrawInput/stop）都在同一 session 项目互斥
// 锁内执行 getSession -> validate -> appendBatch；后到者必须看到先到者的持久
// 终态。竞态断言以持久事件顺序为真相（不依赖内存时序）：每条输入恰好一个终态
// 事件（input_completed/input_interrupted/input_withdrawn/input_cancelled），
// 撤回只接受 queued，stop(runId) 精确匹配活动 Run。

test("Task 9 requestPriority：排队输入写 priority_input_requested；重复/非排队请求被拒；撤回优先输入清空标记", async (t) => {
  const h = await createProjectAgentHarness({
    gatewayScript: [
      async () => {
        await sleep(600);
        return { text: "A 完成。" };
      },
      { reply: { text: "B 完成。" } },
      { reply: { text: "C 完成。" } }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());
  const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A 任务", source: "chat" });
  const b = await h.agent.submit({ projectRoot: h.projectRoot, text: "B 任务", source: "chat" });
  assert.equal(b.queued, true);
  const c = await h.agent.submit({ projectRoot: h.projectRoot, text: "C 任务", source: "chat" });

  const pri = await h.agent.requestPriority({ projectRoot: h.projectRoot, inputId: b.input_id });
  assert.equal(pri.priority_pending, true);
  assert.equal(pri.input_id, b.input_id);
  assert.equal(pri.run_id, a.run_id, "priority 返回活动 Run id");
  assert.equal(pri.session_id, a.session_id);

  const session = (await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 })).session;
  assert.equal(session.priority_input_id, b.input_id, "投影 priority_input_id 指向被优先输入");

  // 已有优先在途 → 第二个请求被拒（priority_pending）
  await assert.rejects(
    () => h.agent.requestPriority({ projectRoot: h.projectRoot, inputId: c.input_id }),
    (error) => error?.code === "priority_pending"
  );
  // 非排队输入（活动输入 A）→ input_not_queued
  await assert.rejects(
    () => h.agent.requestPriority({ projectRoot: h.projectRoot, inputId: a.input_id }),
    (error) => error?.code === "input_not_queued"
  );
  // 撤回优先输入 → 标记清空（否则该会话再也无法请求优先，SPEC 3.3 rule 10）
  const wd = await h.agent.withdrawInput({ projectRoot: h.projectRoot, inputId: b.input_id });
  assert.equal(wd.withdrawn, true);
  assert.equal(wd.draft_text, "B 任务");
  const after = (await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 })).session;
  assert.equal(after.priority_input_id, null, "撤回优先输入后 priority_input_id 清空");
  // 随后可再次请求优先（C）
  const pri2 = await h.agent.requestPriority({ projectRoot: h.projectRoot, inputId: c.input_id });
  assert.equal(pri2.priority_pending, true);
  await waitForIdle(h.agent, h.projectRoot);
});

test("Task 9 withdrawInput：只接受 queued 并返回 draft_text；撤回后 priority/withdraw 一律拒绝（后到者看到持久终态）", async (t) => {
  const h = await createProjectAgentHarness({
    gatewayScript: [
      async () => {
        await sleep(600);
        return { text: "A 完成。" };
      },
      { reply: { text: "B 完成。" } }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());
  const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A 任务", source: "chat" });
  const b = await h.agent.submit({ projectRoot: h.projectRoot, text: "B 任务", source: "chat" });

  const wd = await h.agent.withdrawInput({ projectRoot: h.projectRoot, inputId: b.input_id });
  assert.equal(wd.withdrawn, true);
  assert.equal(wd.draft_text, "B 任务");
  assert.equal(wd.session_id, a.session_id);
  assert.equal(wd.run_id, a.run_id);

  // 后到操作必须看到先到者的持久终态：撤回后再 withdraw/priority 一律拒绝
  await assert.rejects(
    () => h.agent.withdrawInput({ projectRoot: h.projectRoot, inputId: b.input_id }),
    (error) => error?.code === "input_not_queued"
  );
  await assert.rejects(
    () => h.agent.requestPriority({ projectRoot: h.projectRoot, inputId: b.input_id }),
    (error) => error?.code === "input_not_queued"
  );
  // 活动输入不可撤回（只接受 queued）
  await assert.rejects(
    () => h.agent.withdrawInput({ projectRoot: h.projectRoot, inputId: a.input_id }),
    (error) => error?.code === "input_not_queued"
  );
  // 投影移除排队项
  const session = (await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 })).session;
  assert.ok(!session.queued_inputs.some((item) => item.id === b.input_id), "撤回后输入不在队列");

  await waitForIdle(h.agent, h.projectRoot);
  const events = (await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 })).events;
  // B 恰好一个终态（input_withdrawn），A 正常完成
  const bTerminals = events.filter(
    (event) =>
      event.payload?.input_id === b.input_id &&
      ["input_completed", "input_interrupted", "input_withdrawn", "input_cancelled"].includes(event.type)
  );
  assert.equal(bTerminals.length, 1, "B 恰好一个终态");
  assert.equal(bTerminals[0].type, "input_withdrawn");
  assert.equal(
    eventsOfType(events, "input_completed").filter((event) => event.payload?.input_id === a.input_id).length,
    1,
    "A 正常完成"
  );
});

test("Task 9 撤回输入不进入 transcript；普通导出过滤、audit 导出标注 audit_only", async (t) => {
  const h = await createProjectAgentHarness({
    gatewayScript: [
      async () => {
        await sleep(600);
        return { text: "A 完成。" };
      },
      { reply: { text: "B 完成。" } }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());
  await h.agent.submit({ projectRoot: h.projectRoot, text: "A 任务", source: "chat" });
  const b = await h.agent.submit({ projectRoot: h.projectRoot, text: "WITHDRAWN_MARKER_x7q", source: "chat" });
  const wd = await h.agent.withdrawInput({ projectRoot: h.projectRoot, inputId: b.input_id });
  assert.equal(wd.withdrawn, true);
  await waitForIdle(h.agent, h.projectRoot);

  // 普通导出：完全不含被撤回输入的文本，也没有其事件
  const normal = [];
  for await (const line of h.agent.exportHistory({ projectRoot: h.projectRoot })) normal.push(line);
  assert.ok(normal.length > 0, "导出非空");
  assert.ok(
    normal.every((line) => !JSON.stringify(line).includes("WITHDRAWN_MARKER_x7q")),
    "普通导出不得包含被撤回输入的文本"
  );
  assert.equal(
    normal.filter((line) => line.stream === "event" && line.record.type === "input_withdrawn").length,
    0,
    "普通导出过滤 input_withdrawn 事件"
  );
  assert.equal(
    normal.filter(
      (line) => line.stream === "event" && line.record.type === "input_queued" && line.record.payload?.input_id === b.input_id
    ).length,
    0,
    "普通导出过滤被撤回输入的 input_queued 事件"
  );
  assert.equal(
    normal.filter((line) => line.stream === "transcript" && line.record?.input_id === b.input_id).length,
    0,
    "transcript 不含被撤回输入（撤回输入永不写 transcript）"
  );

  // audit 原始诊断导出：保留事件并显式标注 audit_only:true
  const auditLines = [];
  for await (const line of h.agent.exportHistory({ projectRoot: h.projectRoot, audit: true })) auditLines.push(line);
  const markedWithdrawn = auditLines.filter(
    (line) => line.stream === "event" && line.record.type === "input_withdrawn" && line.record.payload?.input_id === b.input_id
  );
  assert.equal(markedWithdrawn.length, 1, "audit 导出保留 input_withdrawn 事件");
  assert.equal(markedWithdrawn[0].record.audit_only, true, "audit 导出显式标注 audit_only");
  const markedQueued = auditLines.filter(
    (line) => line.stream === "event" && line.record.type === "input_queued" && line.record.payload?.input_id === b.input_id
  );
  assert.equal(markedQueued.length, 1, "audit 导出保留被撤回输入的 input_queued 事件");
  assert.equal(markedQueued[0].record.audit_only, true, "audit 导出标注 audit_only");
});

test("Task 9 stop(runId)：错误 runId 拒绝且不影响活动 Run；正确 runId 取消 Run；终态 Run 再 stop 拒绝", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await createProjectAgentHarness({
    gatewayScript: [
      async () => {
        await gate;
        return { text: "A 完成。" };
      }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());
  const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A 任务", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (_session, snap) => eventsOfType(snap.events, "model_turn_started").length >= 1);

  // 错误 runId → run_not_found，活动 Run 不受影响
  await assert.rejects(
    () => h.agent.stop({ projectRoot: h.projectRoot, runId: "ghost-run", reason: "user_stop" }),
    (error) => error?.code === "run_not_found"
  );
  const mid = (await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 1 })).session;
  assert.equal(mid.active_run.id, a.run_id);
  assert.equal(mid.active_run.status, "running", "错误 runId 的 stop 不得影响活动 Run");

  // 正确 runId → 取消。循环阻塞在被 gate 挡住的模型调用上，必须等 stopping 落盘
  // 后再放行（否则 stop 的 waitForIdle 会一直等循环收敛而超时）。
  const stopPromise = h.agent.stop({ projectRoot: h.projectRoot, runId: a.run_id, reason: "user_stop" });
  await waitFor(
    h.agent,
    h.projectRoot,
    (session) => session.status === "stopping" || session.status === "idle",
    { describe: "Run 进入 stopping" }
  );
  release();
  const stopped = await stopPromise;
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.run_id, a.run_id);
  assert.equal(stopped.session_id, a.session_id);
  await waitForIdle(h.agent, h.projectRoot);
  const events = (await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 })).events;
  assert.equal(eventsOfType(events, "run_cancelled").length, 1);

  // 已终结 Run 再 stop(runId) → run_not_found
  await assert.rejects(
    () => h.agent.stop({ projectRoot: h.projectRoot, runId: a.run_id, reason: "user_stop" }),
    (error) => error?.code === "run_not_found"
  );
});

test("Task 9 submit×stop 竞态：胜者由持久事件顺序决定，输入不滞留、每条一个终态", async (t) => {
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
      { reply: { text: "B 完成。" } }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());
  const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A 任务", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (_session, snap) => eventsOfType(snap.events, "model_turn_started").length >= 1);

  // stop 与 submit(B) 并发：两条链在 session 项目互斥锁上争用，谁先落盘谁赢
  const stopPromise = h.agent
    .stop({ projectRoot: h.projectRoot, runId: a.run_id, reason: "user_stop" })
    .then((value) => value, (error) => ({ stopError: error }));
  const subPromise = h.agent
    .submit({ projectRoot: h.projectRoot, text: "B 任务", source: "chat" })
    .then((value) => value, (error) => ({ subError: error }));
  release(); // 让循环收敛，stop 的 waitForIdle 才能完成
  const [stopResult, subResult] = await Promise.all([stopPromise, subPromise]);
  await waitForIdle(h.agent, h.projectRoot);

  const snap = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
  const events = snap.events;
  const runStarts = eventsOfType(events, "run_started");
  const runCancelled = eventsOfType(events, "run_cancelled");
  const queuedB = eventsOfType(events, "input_queued").find((event) => event.payload?.text === "B 任务");
  assert.ok(queuedB, "B 必须已落盘 input_queued");
  const bId = queuedB.payload.input_id;

  // B 恰好一个终态；终态类型与持久事件顺序一致
  const bTerminals = events.filter(
    (event) =>
      event.payload?.input_id === bId &&
      ["input_completed", "input_interrupted", "input_withdrawn", "input_cancelled"].includes(event.type)
  );
  assert.equal(bTerminals.length, 1, "B 恰好一个终态");
  if (bTerminals[0].type === "input_cancelled") {
    // B 在 stop 收敛前排队 → 被取消；stop 必须生效
    assert.equal(runCancelled.length, 1, "stop 必须生效");
    assert.ok(queuedB.seq < runCancelled[0].seq, "B 的排队必须先于取消收敛");
    assert.equal(runStarts.length, 1, "B 未创建新 Run");
    assert.equal(subResult.queued, true, "B 排队到被停止的 Run");
  } else {
    // B 在 stop 收敛后提交 → 创建新 Run 并正常完成
    assert.equal(bTerminals[0].type, "input_completed");
    assert.equal(runStarts.length, 2, "B 在 stop 收敛后创建了新 Run");
    assert.ok(runCancelled.length === 0 || queuedB.seq > runCancelled[0].seq, "B 在新 Run 中完成");
    assert.equal(subResult.queued, false);
  }
  // 队列不滞留输入
  assert.deepEqual(snap.session.queued_inputs, [], "队列不滞留输入");
  if (stopResult.stopError == null) {
    assert.equal(stopResult.cancelled, true);
  } else {
    assert.equal(stopResult.stopError.code, "run_not_found", "stop 只可能成功或 run_not_found");
  }
});

test("Task 9 withdraw×priority 竞态：撤回与优先争用同一 mutex，优先标记必清空", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await createProjectAgentHarness({
    gatewayScript: [
      async () => {
        await gate;
        return { text: "A 完成。" };
      }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());
  const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A 任务", source: "chat" });
  const b = await h.agent.submit({ projectRoot: h.projectRoot, text: "B 任务", source: "chat" });
  assert.equal(b.queued, true);

  // withdraw 与 requestPriority 并发争用同一把 session mutex（解析会话的异步
  // I/O 让两条链的先后不再由调用顺序唯一决定）
  const wdPromise = h.agent
    .withdrawInput({ projectRoot: h.projectRoot, inputId: b.input_id })
    .then((value) => value, (error) => ({ rejected: error }));
  const priPromise = h.agent
    .requestPriority({ projectRoot: h.projectRoot, inputId: b.input_id })
    .then((value) => value, (error) => ({ rejected: error }));
  const [wd, pri] = await Promise.all([wdPromise, priPromise]);
  release();
  await waitForIdle(h.agent, h.projectRoot);

  const snap = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
  const events = snap.events;
  const priEvents = eventsOfType(events, "priority_input_requested").filter((event) => event.payload?.input_id === b.input_id);
  const wdEvents = eventsOfType(events, "input_withdrawn").filter((event) => event.payload?.input_id === b.input_id);
  assert.equal(wdEvents.length, 1, "撤回恰好一次");
  assert.equal(snap.session.priority_input_id, null, "优先标记必须清空（撤回输入已终态）");
  if (priEvents.length === 1) {
    // 优先先落盘 → 撤回仍成功，标记被 input_withdrawn 清空
    assert.ok(priEvents[0].seq < wdEvents[0].seq, "priority 先于 withdraw");
    assert.ok(!pri.rejected, "requestPriority 成功");
    assert.equal(pri.priority_pending, true);
    assert.ok(!wd.rejected, "withdraw 成功");
  } else {
    // 撤回先落盘 → requestPriority 必须被拒（后到者看到持久终态）
    assert.equal(priEvents.length, 0, "撤回先落盘 → 无 priority_input_requested");
    assert.ok(pri.rejected, "requestPriority 必须被拒");
    assert.equal(pri.rejected.code, "input_not_queued");
    assert.ok(!wd.rejected, "withdraw 成功");
    assert.equal(wd.withdrawn, true);
  }
});

test("Task 9 withdraw×start：input_started 落盘后撤回被拒；撤回先落盘则输入从未开始", async (t) => {
  // 场景 A：start 先落盘（B 已开始、模型轮阻塞）→ 撤回被拒，B 正常完成
  let releaseB;
  const gateB = new Promise((resolve) => {
    releaseB = resolve;
  });
  const h1 = await createProjectAgentHarness({
    gatewayScript: [
      { reply: { text: "A 完成。" } },
      async () => {
        await gateB;
        return { text: "B 完成。" };
      }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h1.cleanup());
  await h1.agent.submit({ projectRoot: h1.projectRoot, text: "A 任务", source: "chat" });
  const b1 = await h1.agent.submit({ projectRoot: h1.projectRoot, text: "B 任务", source: "chat" });
  await waitFor(
    h1.agent,
    h1.projectRoot,
    (session, snap) =>
      session.active_run?.active_input_id === b1.input_id ||
      eventsOfType(snap.events, "input_started").some((event) => event.payload?.input_id === b1.input_id),
    { describe: "B 已开始（input_started 落盘）" }
  );
  await assert.rejects(
    () => h1.agent.withdrawInput({ projectRoot: h1.projectRoot, inputId: b1.input_id }),
    (error) => error?.code === "input_not_queued"
  );
  releaseB();
  await waitForIdle(h1.agent, h1.projectRoot);
  const events1 = (await h1.agent.snapshot({ projectRoot: h1.projectRoot, afterSeq: 0, limit: 100000 })).events;
  assert.equal(
    eventsOfType(events1, "input_completed").filter((event) => event.payload?.input_id === b1.input_id).length,
    1,
    "B 正常完成"
  );

  // 场景 B：撤回先落盘 → B 从未开始（无 input_started）
  const h2 = await createProjectAgentHarness({
    gatewayScript: [
      async () => {
        await sleep(600);
        return { text: "A 完成。" };
      },
      { reply: { text: "B 完成。" } }
    ],
    gatewayDelayMs: 0
  });
  t.after(() => h2.cleanup());
  await h2.agent.submit({ projectRoot: h2.projectRoot, text: "A 任务", source: "chat" });
  const b2 = await h2.agent.submit({ projectRoot: h2.projectRoot, text: "B 任务", source: "chat" });
  const wd = await h2.agent.withdrawInput({ projectRoot: h2.projectRoot, inputId: b2.input_id });
  assert.equal(wd.withdrawn, true);
  await waitForIdle(h2.agent, h2.projectRoot);
  const events2 = (await h2.agent.snapshot({ projectRoot: h2.projectRoot, afterSeq: 0, limit: 100000 })).events;
  assert.equal(
    eventsOfType(events2, "input_started").filter((event) => event.payload?.input_id === b2.input_id).length,
    0,
    "撤回先落盘 → B 从未开始"
  );
  assert.equal(
    eventsOfType(events2, "input_withdrawn").filter((event) => event.payload?.input_id === b2.input_id).length,
    1,
    "B 以 input_withdrawn 终结"
  );
});
