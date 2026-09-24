// tests/http/versions-routes.test.mjs —— 第九轮：版本时间线与恢复端点。
//
// 覆盖：章节版本列表（404 no_versions / 200）、章节版本内容（200 / 400）；
// 章节回滚（409 agent_running / 200 + 事件注入）；
// 记忆文件版本列表/内容（200 / 400 bad_args）；记忆文件白名单读取（400）；
// 记忆版本恢复（200 + 事件注入 / 404 no_versions）。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createRouter } from "../../src/core/http/router.mjs";
import { startHttpServer } from "../helpers/http-test.mjs";
import { createProjectAgentHarness, waitFor, waitForIdle } from "../helpers/project-agent-harness.mjs";
import { createProjectRoutes } from "../../src/core/http/project-routes.mjs";
import { createAgentRoutes } from "../../src/core/http/agent-routes.mjs";
import { snapshotChapter } from "../../src/core/project-operations/versions.mjs";
import { snapshotMemoryFile } from "../../src/core/project-operations/memory-versions.mjs";

// 组装 router + project-routes + agent-routes，返回真实 HTTP server。
async function setupServer(t, options = {}) {
  const h = await createProjectAgentHarness(options);
  const router = createRouter();
  const selection = { current: h.projectRoot };
  const routeModules = [
    createProjectRoutes({
      workspace: h.workspaceRoot,
      stateRoot: h.stateRoot,
      agent: h.agent,
      selection
    }),
    createAgentRoutes({ agent: h.agent })
  ];
  const server = await startHttpServer(t, {
    router,
    routeModules,
    afterClose: () => h.cleanup()
  });
  return { h, ...server };
}

// 辅助：提交两个版本的章节
async function seedTwoVersions(h, chapterNo) {
  await snapshotChapter({ projectRoot: h.projectRoot, chapterNo, content: "第一章 v1 内容", source: "test" });
  await snapshotChapter({ projectRoot: h.projectRoot, chapterNo, content: "第一章 v2 内容", source: "test" });
}

// ---------------------------------------------------------------------------
// 章节版本
// ---------------------------------------------------------------------------

test("GET /api/chapters/versions：无版本 → 404 no_versions；提交后列出版本", async (t) => {
  const s = await setupServer(t);
  const { h } = s;

  // 无版本 → 404 no_versions
  const emptyRes = await fetch(`${s.base}/api/chapters/versions?projectRoot=${encodeURIComponent(h.projectRoot)}&chapter_no=1`);
  assert.equal(emptyRes.status, 404);
  assert.equal((await emptyRes.json()).code, "no_versions");

  // 提交一个版本后 → 200 列出
  await snapshotChapter({ projectRoot: h.projectRoot, chapterNo: 1, content: "第一章 v1", source: "test" });
  const listRes = await fetch(`${s.base}/api/chapters/versions?projectRoot=${encodeURIComponent(h.projectRoot)}&chapter_no=1`);
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.equal(list.ok, true);
  assert.ok(Array.isArray(list.versions) && list.versions.length >= 1);
  assert.equal(list.chapter_no, 1);
});

test("GET /api/chapters/versions：缺少 chapter_no → 400 bad_args", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  const res = await fetch(`${s.base}/api/chapters/versions?projectRoot=${encodeURIComponent(h.projectRoot)}`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "bad_args");
});

test("GET /api/chapters/versions/content：有效版本 → 200；不存在版本 → 404", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  await snapshotChapter({ projectRoot: h.projectRoot, chapterNo: 2, content: "第二章 v1 内容", source: "test" });

  // 有效版本 → 200
  const okRes = await fetch(`${s.base}/api/chapters/versions/content?projectRoot=${encodeURIComponent(h.projectRoot)}&chapter_no=2&version=1`);
  assert.equal(okRes.status, 200);
  const okData = await okRes.json();
  assert.equal(okData.ok, true);
  assert.equal(okData.content, "第二章 v1 内容");
  assert.equal(okData.version, 1);

  // 不存在版本 → 404 version_not_found
  const missingRes = await fetch(`${s.base}/api/chapters/versions/content?projectRoot=${encodeURIComponent(h.projectRoot)}&chapter_no=2&version=99`);
  assert.equal(missingRes.status, 404);
  assert.equal((await missingRes.json()).code, "version_not_found");
});

test("GET /api/chapters/versions/content：缺少参数 → 400", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  const res = await fetch(`${s.base}/api/chapters/versions/content?projectRoot=${encodeURIComponent(h.projectRoot)}&chapter_no=1`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "bad_args");
});

// ---------------------------------------------------------------------------
// 章节回滚
// ---------------------------------------------------------------------------

test("POST /api/chapters/rollback：运行中 → 409 agent_running", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [async () => { await new Promise((r) => setTimeout(r, 2000)); return { text: "慢答复" }; }],
    gatewayDelayMs: 0
  });
  const { h } = s;
  // 打开 agent 以建立会话
  await h.agent.open({ projectRoot: h.projectRoot });
  // 提交消息使 agent 运行
  await h.agent.submit({ projectRoot: h.projectRoot, text: "慢任务", source: "chat" });
  // 等待 agent 进入 running 状态
  await new Promise((r) => setTimeout(r, 100));

  const busyRes = await fetch(`${s.base}/api/chapters/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: h.projectRoot, chapter_no: 1 })
  });
  assert.equal(busyRes.status, 409);
  assert.equal((await busyRes.json()).code, "agent_running");
});

test("POST /api/chapters/rollback：无版本 → 404 no_versions", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  const res = await fetch(`${s.base}/api/chapters/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: h.projectRoot, chapter_no: 1 })
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "no_versions");
});

test("POST /api/chapters/rollback：恢复并注入对话事件", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  // 创建会话（appendSystemEvent 需要 journal 存在）
  await h.agent.newSession({ projectRoot: h.projectRoot, title: "rollback-test" });
  await h.agent.open({ projectRoot: h.projectRoot });
  await seedTwoVersions(h, 1);
  // rollbackChapter 需要正式文件存在且索引标记 completed
  const finalDir = path.join(h.projectRoot, "chapters");
  await fs.mkdir(finalDir, { recursive: true });
  await fs.writeFile(path.join(finalDir, "001.md"), "第二章 v2 内容", "utf8");
  const indexPath = path.join(h.projectRoot, "memory", "chapter_index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  index.chapters = [{ chapter_no: 1, status: "completed", final_path: "chapters/001.md" }];
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");

  const res = await fetch(`${s.base}/api/chapters/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: h.projectRoot, chapter_no: 1, version: 1 })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.chapter_no, 1);
  assert.equal(data.version?.from, 2);
  assert.equal(data.version?.to, 1);

  // 验证对话事件注入
  const { events } = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 1000 });
  assert.ok(
    events.some((e) => e.type === "chapter_rolled_back" && e.payload?.chapter_no === 1),
    "对话流应包含 chapter_rolled_back 事件"
  );
});

// ---------------------------------------------------------------------------
// 记忆文件内容读取（白名单）
// ---------------------------------------------------------------------------

test("GET /api/memory/files/content：白名单外 → 400 bad_args", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  const bad = await fetch(`${s.base}/api/memory/files/content?projectRoot=${encodeURIComponent(h.projectRoot)}&file=chapter_index`);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "bad_args");
});

test("GET /api/memory/files/content：白名单内 → 200", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  const res = await fetch(`${s.base}/api/memory/files/content?projectRoot=${encodeURIComponent(h.projectRoot)}&file=worklog`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.file, "worklog");
  assert.equal(typeof data.content, "string");
});

// ---------------------------------------------------------------------------
// 记忆文件版本
// ---------------------------------------------------------------------------

test("GET /api/memory/versions：无版本 → 404 no_versions", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  const res = await fetch(`${s.base}/api/memory/versions?projectRoot=${encodeURIComponent(h.projectRoot)}&file=worklog`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "no_versions");
});

test("GET /api/memory/versions：白名单外 file → 400", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  const res = await fetch(`${s.base}/api/memory/versions?projectRoot=${encodeURIComponent(h.projectRoot)}&file=continuity`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "bad_args");
});

test("GET /api/memory/versions/content：有效版本 → 200", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  await snapshotMemoryFile({ projectRoot: h.projectRoot, file: "worklog", content: "worklog v1", source: "test" });

  const res = await fetch(`${s.base}/api/memory/versions/content?projectRoot=${encodeURIComponent(h.projectRoot)}&file=worklog&version=1`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.content, "worklog v1");
});

test("GET /api/memory/versions/content：缺少参数 → 400", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  const res = await fetch(`${s.base}/api/memory/versions/content?projectRoot=${encodeURIComponent(h.projectRoot)}&file=worklog`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "bad_args");
});

// ---------------------------------------------------------------------------
// 记忆版本恢复
// ---------------------------------------------------------------------------

test("POST /api/memory/versions/restore：恢复后文件内容与对话事件", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  // 创建会话（appendSystemEvent 需要 journal 存在）
  await h.agent.newSession({ projectRoot: h.projectRoot, title: "restore-test" });
  await h.agent.open({ projectRoot: h.projectRoot });

  // 写两个版本的 book_summary
  await snapshotMemoryFile({ projectRoot: h.projectRoot, file: "book_summary", content: "旧版摘要 v1", source: "test" });
  await snapshotMemoryFile({ projectRoot: h.projectRoot, file: "book_summary", content: "新版摘要 v2", source: "test" });

  // 恢复到 v1
  const res = await fetch(`${s.base}/api/memory/versions/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: h.projectRoot, file: "book_summary", version: 1 })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.file, "book_summary");
  assert.equal(data.version, 1);
  assert.equal(data.restored, true);

  // 验证文件内容已恢复
  const contentRes = await fetch(`${s.base}/api/memory/files/content?projectRoot=${encodeURIComponent(h.projectRoot)}&file=book_summary`);
  const contentData = await contentRes.json();
  assert.equal(contentData.content, "旧版摘要 v1");

  // 验证对话事件注入
  const { events } = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 1000 });
  assert.ok(
    events.some((e) => e.type === "memory_file_restored" && e.payload?.file === "book_summary" && e.payload?.to_version === 1),
    "对话流应包含 memory_file_restored 事件"
  );
});

// C3（2026-09-24 审计）：恢复覆盖前必须把当前未入版本库的内容存为 pre_restore，
// 否则两次快照之间的编辑被恢复不可逆抹掉（对齐章节侧 pre_rollback 语义）。
test("POST /api/memory/versions/restore：覆盖前当前内容存档为 pre_restore", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  await h.agent.newSession({ projectRoot: h.projectRoot, title: "pre-restore-test" });
  await h.agent.open({ projectRoot: h.projectRoot });

  // v1 快照后，用户又手动改了 book_summary（未入版本库的修改）
  await snapshotMemoryFile({ projectRoot: h.projectRoot, file: "book_summary", content: "v1 内容", source: "test" });
  const targetPath = path.join(h.projectRoot, "book_summary.md");
  await fs.writeFile(targetPath, "快照后的手工修改", "utf8");

  // 恢复到 v1
  const res = await fetch(`${s.base}/api/memory/versions/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: h.projectRoot, file: "book_summary", version: 1 })
  });
  assert.equal(res.status, 200);

  // 恢复本身仍然生效：目标文件被覆盖为 v1
  assert.equal(await fs.readFile(targetPath, "utf8"), "v1 内容");

  // 版本列表应出现 pre_restore 版本，内容 = 被覆盖前的手工修改
  const listRes = await fetch(`${s.base}/api/memory/versions?projectRoot=${encodeURIComponent(h.projectRoot)}&file=book_summary`);
  const { versions } = await listRes.json();
  const pre = versions.find((v) => v.source === "pre_restore");
  assert.ok(pre, "恢复前应产生 pre_restore 存档版本");
  const preRes = await fetch(`${s.base}/api/memory/versions/content?projectRoot=${encodeURIComponent(h.projectRoot)}&file=book_summary&version=${pre.version}`);
  const preData = await preRes.json();
  assert.equal(preData.content, "快照后的手工修改");
});

test("POST /api/memory/versions/restore：运行中 → 409 agent_running", async (t) => {
  const s = await setupServer(t, {
    gatewayScript: [async () => { await new Promise((r) => setTimeout(r, 2000)); return { text: "慢答复" }; }],
    gatewayDelayMs: 0
  });
  const { h } = s;
  await h.agent.open({ projectRoot: h.projectRoot });
  await snapshotMemoryFile({ projectRoot: h.projectRoot, file: "worklog", content: "v1", source: "test" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "慢任务", source: "chat" });
  await new Promise((r) => setTimeout(r, 100));

  const res = await fetch(`${s.base}/api/memory/versions/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: h.projectRoot, file: "worklog", version: 1 })
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "agent_running");
});

test("POST /api/memory/versions/restore：不存在版本 → 404 version_not_found", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  await snapshotMemoryFile({ projectRoot: h.projectRoot, file: "worklog", content: "v1", source: "test" });

  const res = await fetch(`${s.base}/api/memory/versions/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: h.projectRoot, file: "worklog", version: 99 })
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "version_not_found");
});

// ---------------------------------------------------------------------------
// 第九轮 Task 15 review I-1/I-2/M-2：补覆盖
// ---------------------------------------------------------------------------

test("POST /api/chapters/rollback：只有一个版本且回滚到当前版 → 409 already_current", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  await h.agent.newSession({ projectRoot: h.projectRoot, title: "rollback-already" });
  await h.agent.open({ projectRoot: h.projectRoot });
  // 只提交一个版本
  await snapshotChapter({ projectRoot: h.projectRoot, chapterNo: 1, content: "唯一版本", source: "test" });
  // 创建正式文件 + 索引标记（rollbackChapter 需要）
  const finalDir = path.join(h.projectRoot, "chapters");
  await fs.mkdir(finalDir, { recursive: true });
  await fs.writeFile(path.join(finalDir, "001.md"), "唯一版本", "utf8");
  const indexPath = path.join(h.projectRoot, "memory", "chapter_index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  index.chapters = [{ chapter_no: 1, status: "completed", final_path: "chapters/001.md" }];
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");

  // 回滚到 version 1（当前版本）→ 409 already_current
  const res = await fetch(`${s.base}/api/chapters/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: h.projectRoot, chapter_no: 1, version: 1 })
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "already_current");
});

test("POST /api/memory/versions/restore：file=continuity → 400 bad_args", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  const res = await fetch(`${s.base}/api/memory/versions/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: h.projectRoot, file: "continuity", version: 1 })
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "bad_args");
});

test("POST /api/chapters/rollback：version=abc → 400 bad_args", async (t) => {
  const s = await setupServer(t);
  const { h } = s;
  const res = await fetch(`${s.base}/api/chapters/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: h.projectRoot, chapter_no: 1, version: "abc" })
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "bad_args");
});

// ---------------------------------------------------------------------------
// Task 5（第二十轮审计交叉印证）：忙门必须覆盖「非活跃会话」
// ---------------------------------------------------------------------------

// 缺陷：原忙判走 agent.snapshot({projectRoot}) 的缺省单会话投影（getLastActive），
// 非活跃会话运行中时它解析到的是空闲的最近活跃会话 → rollback / memory restore 放行，
// 与在途 Run 并发写同一项目文件（真有版本时会真的执行破坏性回滚/覆盖）。
// 修复：改走 agent.projectBusy（全部已物化会话 + 项目互斥锁内判定）。
// 本用例是这条**用户可见行为改变**的唯一失败测试：把 project-routes 两处忙判回退
// 成旧写法（snapshot + RUN_BUSY_STATUSES）即变红——旧写法看到空闲的 B，会真的回滚。
test("POST rollback / memory restore：非活跃会话运行中 → 409 agent_running（全会话忙门）", async (t) => {
  // 慢轮闸门：模型调用保持挂起直到显式放行——不依赖任何时长窗口（慢盘/慢 CI 无 flake）
  let releaseModel;
  const heldTurn = new Promise((resolve) => { releaseModel = resolve; });
  const s = await setupServer(t, {
    gatewayScript: [async () => { await heldTurn; return { text: "慢答复" }; }],
    gatewayDelayMs: 0
  });
  const { h } = s;
  await h.agent.open({ projectRoot: h.projectRoot });
  // 会话 A：提交慢任务 → 进入 running（此刻 A 是最近活跃）
  const a = await h.agent.newSession({ projectRoot: h.projectRoot, title: "A" });
  await h.agent.submit({ projectRoot: h.projectRoot, sessionId: a.session_id, text: "慢任务", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (session) => session.active_run?.status === "running", {
    describe: "会话 A 进入 running"
  });
  // 会话 B：新建即成为最近活跃（空闲）——旧忙判缺省解析到 B，正是盲区
  const b = await h.agent.newSession({ projectRoot: h.projectRoot, title: "B" });
  const { session } = await h.agent.snapshot({ projectRoot: h.projectRoot });
  assert.equal(session?.session_id, b.session_id, "前置：snapshot 缺省解析到空闲的 B（旧忙判的盲区）");
  assert.notEqual(session?.active_run?.status, "running", "前置：B 没有在途 Run");
  // 被回滚/恢复的目标：真实存在的章节版本与记忆版本（不 mock agent，走真实路由 + 真实域模块）
  await seedTwoVersions(h, 1);
  const finalDir = path.join(h.projectRoot, "chapters");
  await fs.mkdir(finalDir, { recursive: true });
  await fs.writeFile(path.join(finalDir, "001.md"), "第一章 v2 内容", "utf8");
  const indexPath = path.join(h.projectRoot, "memory", "chapter_index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  index.chapters = [{ chapter_no: 1, status: "completed", final_path: "chapters/001.md" }];
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
  await snapshotMemoryFile({ projectRoot: h.projectRoot, file: "worklog", content: "worklog v1", source: "test" });

  try {
    const rollbackRes = await fetch(`${s.base}/api/chapters/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: h.projectRoot, chapter_no: 1, version: 1 })
    });
    assert.equal(rollbackRes.status, 409, "非活跃会话 A 运行中：回滚必须被忙门拦下");
    const rollbackBody = await rollbackRes.json();
    assert.equal(rollbackBody.code, "agent_running");
    // handler 文案「写作进行中，暂停后恢复。」经 sendError 统一脱敏到达传输层
    //（agent_running 不在 SAFE_PUBLIC_ERROR_CODES 白名单，http-error.mjs:47-90）——
    // 前端按 code 分支展示自己的 toast（app-shell/app.js:511、version-panel.js:110）。
    // 此处钉住传输层实际值：code 是契约，文案不随 code 透传。
    assert.equal(rollbackBody.message, "操作未完成，请重试；若问题持续，请打开诊断信息。");

    const restoreRes = await fetch(`${s.base}/api/memory/versions/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: h.projectRoot, file: "worklog", version: 1 })
    });
    assert.equal(restoreRes.status, 409, "非活跃会话 A 运行中：记忆恢复必须被忙门拦下");
    const restoreBody = await restoreRes.json();
    assert.equal(restoreBody.code, "agent_running");
    assert.equal(restoreBody.message, "操作未完成，请重试；若问题持续，请打开诊断信息。");
  } finally {
    releaseModel();
  }
  // 收尾：放行慢轮后等 A 收敛 idle，避免 server/harness 清理与在途循环竞态
  await waitForIdle(h.agent, h.projectRoot);
});
