// Task 7: 授权矩阵 —— 普通确认 / 任务级授权 / YOLO / 极端确认。
// 内存 store 生命周期由 agentLoop 与 serveChatSend/Confirm 接线负责（见 chat-agent.test.mjs）。
import assert from "node:assert/strict";
import test from "node:test";
import { createTaskGrantStore, decideToolAuthorization } from "../src/core/chat/task-grants.mjs";

const read = { category: "read", scope: "project", risk: "normal", grant_key: "read:project:project-root" };
const write = { category: "write", scope: "project", risk: "normal", grant_key: "write:project:project-root" };
const outside = { category: "read", scope: "outside", risk: "normal", grant_key: "read:outside:d:\\" };
const extreme = { category: "delete", scope: "outside", risk: "extreme", grant_key: "delete:outside:c:\\" };

test("普通模式只读自动，其余确认", () => {
  const grants = createTaskGrantStore();
  assert.equal(decideToolAuthorization({ action: read, permissions: {}, taskId: "t1", grants }).decision, "allow");
  assert.equal(decideToolAuthorization({ action: write, permissions: {}, taskId: "t1", grants }).decision, "confirm");
  assert.equal(decideToolAuthorization({ action: outside, permissions: {}, taskId: "t1", grants }).decision, "confirm");
});

test("任务授权只匹配同一 taskId 和 grant_key", () => {
  const grants = createTaskGrantStore();
  grants.allow("p1", "t1", write.grant_key);
  assert.equal(decideToolAuthorization({ projectRoot: "p1", action: write, permissions: {}, taskId: "t1", grants }).decision, "allow");
  assert.equal(decideToolAuthorization({ projectRoot: "p1", action: write, permissions: {}, taskId: "t2", grants }).decision, "confirm");
  assert.equal(decideToolAuthorization({ projectRoot: "p2", action: write, permissions: {}, taskId: "t1", grants }).decision, "confirm");
  assert.equal(decideToolAuthorization({ projectRoot: "p1", action: outside, permissions: {}, taskId: "t1", grants }).decision, "confirm");
});

test("YOLO 放行普通越界但不能放行 extreme", () => {
  const grants = createTaskGrantStore();
  const permissions = { yolo: true };
  assert.equal(decideToolAuthorization({ action: outside, permissions, taskId: "t1", grants }).decision, "allow");
  assert.equal(decideToolAuthorization({ action: extreme, permissions, taskId: "t1", grants }).decision, "extreme_confirm");
});

test("extreme 优先于 read_only 与 yolo", () => {
  const grants = createTaskGrantStore();
  assert.equal(decideToolAuthorization({ action: extreme, permissions: { read_only: true }, taskId: "t1", grants }).decision, "extreme_confirm");
  assert.equal(decideToolAuthorization({ action: extreme, permissions: { yolo: true }, taskId: "t1", grants }).decision, "extreme_confirm");
});

test("read_only 拒绝非 read；read 仍放行", () => {
  const grants = createTaskGrantStore();
  const denied = decideToolAuthorization({ action: write, permissions: { read_only: true }, taskId: "t1", grants });
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /只读/u);
  assert.equal(decideToolAuthorization({ action: read, permissions: { read_only: true }, taskId: "t1", grants }).decision, "allow");
});

test("auto_edit 只放行项目内 write", () => {
  const grants = createTaskGrantStore();
  const permissions = { auto_edit: true };
  const writeOutside = { category: "write", scope: "outside", risk: "normal", grant_key: "write:outside:c:\\" };
  assert.equal(decideToolAuthorization({ action: write, permissions, taskId: "t1", grants }).decision, "allow");
  assert.equal(decideToolAuthorization({ action: writeOutside, permissions, taskId: "t1", grants }).decision, "confirm");
  assert.equal(decideToolAuthorization({ action: read, permissions, taskId: "t1", grants }).decision, "allow");
});

test("clear 与 clearProject 按范围清除", () => {
  const grants = createTaskGrantStore();
  grants.allow("p1", "t1", write.grant_key);
  grants.allow("p1", "t2", write.grant_key);
  grants.allow("p1", "t1", outside.grant_key);
  grants.allow("p2", "t1", write.grant_key);
  grants.clear("p1", "t1");
  assert.equal(grants.has("p1", "t1", write.grant_key), false);
  assert.equal(grants.has("p1", "t1", outside.grant_key), false);
  assert.equal(grants.has("p1", "t2", write.grant_key), true);
  assert.equal(grants.has("p2", "t1", write.grant_key), true);
  grants.clearProject("p1");
  assert.equal(grants.has("p1", "t2", write.grant_key), false);
  assert.equal(grants.has("p2", "t1", write.grant_key), true);
});
