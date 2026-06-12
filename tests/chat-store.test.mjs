import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendChatMessage, readChatHistory, loadPendingAction, savePendingAction, clearPendingAction
} from "../src/core/chat/chat-store.mjs";

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), "wwriting-chatstore-")); }

test("append + read 往返，自动补 id/ts", async () => {
  const root = await tmp();
  await appendChatMessage(root, { role: "user", content: "你好" });
  await appendChatMessage(root, { role: "assistant", content: "你好，项目进度 8/10。", cost: 0.001 });
  const history = await readChatHistory(root);
  assert.equal(history.length, 2);
  assert.equal(history[0].role, "user");
  assert.ok(history[0].id);
  assert.ok(history[0].ts);
});

test("readChatHistory 支持 after 与 limit", async () => {
  const root = await tmp();
  for (let i = 0; i < 5; i += 1) await appendChatMessage(root, { role: "user", content: `m${i}` });
  const all = await readChatHistory(root);
  const after = await readChatHistory(root, { after: all[2].id });
  assert.equal(after.length, 2);
  const limited = await readChatHistory(root, { limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited[1].content, "m4");
});

test("坏行跳过不抛", async () => {
  const root = await tmp();
  await appendChatMessage(root, { role: "user", content: "好行" });
  await fs.appendFile(path.join(root, "chat_history.jsonl"), "不是json\n", "utf8");
  await appendChatMessage(root, { role: "user", content: "好行2" });
  const history = await readChatHistory(root);
  assert.equal(history.length, 2);
});

test("appendChatMessage 显式 undefined id/ts 不覆盖默认值", async () => {
  const root = await tmp();
  await appendChatMessage(root, { role: "user", content: "x", id: undefined, ts: undefined });
  const history = await readChatHistory(root);
  assert.ok(history[0].id, "id 必须有值");
  assert.ok(history[0].ts, "ts 必须有值");
});

test("pending action 存取清", async () => {
  const root = await tmp();
  assert.equal(await loadPendingAction(root), null);
  const action = await savePendingAction(root, { tool: "edit_chapter", args: { chapter_no: 2 }, preview: { before: "a", after: "b" } });
  assert.ok(action.id);
  assert.equal(action.status, "pending");
  const loaded = await loadPendingAction(root);
  assert.equal(loaded.tool, "edit_chapter");
  await clearPendingAction(root);
  assert.equal(await loadPendingAction(root), null);
});
