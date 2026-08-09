// 会话注册表（session-registry.mjs）测试（多对话改造 Task 2）。
//
// 覆盖：
//   - create：显式/缺省 sessionId 与 title（缺省 = randomUUID + "新对话"），空白 title 兜底
//   - create 同 id 幂等：返回既有 meta，last_seq/created_at/title/updated_at 不被重置
//   - list：返回全部会话，archived_at 为 null（未归档）的在前，组内按 updated_at 倒序
//   - get / rename / archive / restore；rename 空标题抛错且不改原值
//   - setLastActive / getLastActive：指针指向未归档直接用；指向已归档/不存在 → 回退
//     未归档中 updated_at 最新一条；全无则 null
//   - touch：只更新 updated_at（不动 title/last_seq）
//   - removePermanently：从注册表移除并清空 last_active 指向
//   - 持久化：重建 registry 实例后数据仍在
//   - 损坏的 index.json（非法 JSON）→ list/get 回退空 store 不抛错
//   - 并发：所有写 index.json 的操作经互斥锁串行化，并发 create 不丢数据
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionRegistry } from "../../src/core/agent/session-registry.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-registry-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("会话注册表：create/list 缺省参数与排序", async (t) => {
  const root = await makeRoot(t);
  const reg = createSessionRegistry({ root });

  // 缺省 title = "新对话"，sessionId = randomUUID；显式 sessionId 也可
  const a = await reg.create({ title: "对话 A" });
  assert.ok(a.session_id);
  const explicitId = randomUUID();
  const c = await reg.create({ sessionId: explicitId });
  assert.equal(c.session_id, explicitId);
  assert.equal(c.title, "新对话");
  await delay(5);
  // 显式空白/非字符串 title → 兜底为 "新对话"
  const blank = await reg.create({ title: "   " });
  assert.equal(blank.title, "新对话", "空白 title 兜底为 新对话");
  await delay(5);
  const b = await reg.create({ title: "对话 B" });

  const all = await reg.list();
  assert.equal(all.length, 4);
  // 全部未归档，按 updated_at 倒序（b 最后创建在最前）
  assert.ok(all.every((s) => s.archived_at == null));
  assert.deepEqual(all.map((s) => s.session_id), [b.session_id, blank.session_id, c.session_id, a.session_id]);
  assert.equal(all[0].last_seq, 0, "last_seq 由 runtime 后续写入，初始为 0");
});

test("会话注册表：get/rename/archive/restore/lastActive/touch", async (t) => {
  const root = await makeRoot(t);
  const reg = createSessionRegistry({ root });
  const a = await reg.create({ title: "对话 A" });
  await delay(5);
  const b = await reg.create({ title: "对话 B" });

  // 指针指向最近创建的 b（未归档）→ 直接返回 b
  assert.equal(await reg.getLastActive(), b.session_id);

  await reg.setLastActive(a.session_id);
  assert.equal(await reg.getLastActive(), a.session_id);

  // rename：trim 后写入；空标题抛错且不改原值
  await reg.rename(a.session_id, "对话 A·改名");
  assert.equal((await reg.get(a.session_id)).title, "对话 A·改名");
  await assert.rejects(() => reg.rename(a.session_id, ""), /标题不能为空/);
  await assert.rejects(() => reg.rename(a.session_id, "   "), /标题不能为空/);
  await assert.rejects(() => reg.rename(a.session_id, null), /标题不能为空/);
  assert.equal((await reg.get(a.session_id)).title, "对话 A·改名", "空标题 rename 不改原值");

  // archive：list 仍含归档会话，但排在未归档之后
  await delay(5);
  await reg.archive(b.session_id);
  const afterArchive = await reg.list();
  assert.equal(afterArchive.length, 2, "list 包含归档会话");
  assert.equal(afterArchive[0].session_id, a.session_id, "未归档在前");
  assert.ok(afterArchive[0].archived_at == null);
  assert.equal(afterArchive[1].session_id, b.session_id, "归档在后");
  assert.ok(afterArchive[1].archived_at != null);

  // 指针指向已归档会话 → 回退未归档中 updated_at 最新的一条（a）
  await reg.setLastActive(b.session_id);
  assert.equal(await reg.getLastActive(), a.session_id, "指针指向已归档会话则回退最近未归档");
  await reg.setLastActive(a.session_id); // 恢复指针，避免影响后续断言

  // restore：archived_at 清空
  await reg.restore(b.session_id);
  assert.equal((await reg.get(b.session_id)).archived_at, null);

  // touch：只更新 updated_at，不动 title/last_seq
  const before = await reg.get(a.session_id);
  await delay(5);
  await reg.touch(a.session_id);
  const after = await reg.get(a.session_id);
  assert.ok(after.updated_at > before.updated_at);
  assert.equal(after.title, before.title);
  assert.equal(after.last_seq, before.last_seq);

  // 不存在会话：rename/archive/restore 抛错，touch 返回 null
  const missing = randomUUID();
  await assert.rejects(() => reg.rename(missing, "x"), /会话不存在/);
  await assert.rejects(() => reg.archive(missing), /会话不存在/);
  await assert.rejects(() => reg.restore(missing), /会话不存在/);
  assert.equal(await reg.touch(missing), null);
});

test("会话注册表：持久化与 removePermanently", async (t) => {
  const root = await makeRoot(t);
  const reg = createSessionRegistry({ root });
  const a = await reg.create({ title: "对话 A" });
  await delay(5);
  const b = await reg.create({ title: "对话 B" });
  await reg.setLastActive(a.session_id);

  // 重建实例：数据仍在
  const reg2 = createSessionRegistry({ root });
  assert.equal((await reg2.list()).length, 2);
  assert.equal(await reg2.getLastActive(), a.session_id);

  // removePermanently：移除 a（当前 last_active）→ 指向被清空 → 回退未归档会话
  await reg2.removePermanently(a.session_id);
  assert.equal((await reg2.list()).length, 1);
  assert.equal(await reg2.getLastActive(), b.session_id);

  // 全部删除 → getLastActive 为 null，index.json 形状仍合法
  await reg2.removePermanently(b.session_id);
  assert.equal((await reg2.list()).length, 0);
  assert.equal(await reg2.getLastActive(), null);
  const raw = JSON.parse(await fs.readFile(path.join(root, "sessions", "index.json"), "utf8"));
  assert.equal(raw.schema_version, 1);
  assert.deepEqual(raw.sessions, []);
  assert.equal(raw.last_active_session_id, null);
});

test("会话注册表：create 同 id 幂等，不重置既有 meta", async (t) => {
  const root = await makeRoot(t);
  const reg = createSessionRegistry({ root });
  const first = await reg.create({ sessionId: "sid-x", title: "原标题" });
  await delay(5);
  await reg.rename("sid-x", "改名后");
  const renamedMeta = await reg.get("sid-x");
  // 模拟 runtime 写入 last_seq（registry 不导出该写入，直接操作 index.json）
  const indexPath = path.join(root, "sessions", "index.json");
  const store = JSON.parse(await fs.readFile(indexPath, "utf8"));
  store.sessions[0].last_seq = 42;
  await fs.writeFile(indexPath, JSON.stringify(store, null, 2), "utf8");

  // 再次 create 同 id（带不同 title）→ 返回既有 meta，字段不被重置
  const again = await reg.create({ sessionId: "sid-x", title: "试图覆盖" });
  assert.equal(again.session_id, "sid-x");
  assert.equal(again.title, "改名后", "既有 title 不被 create 覆盖");
  assert.equal(again.last_seq, 42, "last_seq 不被重置");
  assert.equal(again.created_at, first.created_at, "created_at 不被重置");
  assert.equal(again.updated_at, renamedMeta.updated_at, "updated_at 不被重置");
  assert.equal(await reg.getLastActive(), "sid-x", "幂等 create 也刷新最近活跃指针");
  assert.equal((await reg.list()).length, 1, "不产生重复会话");
});

test("会话注册表：index.json 损坏时回退空 store，不抛错", async (t) => {
  const root = await makeRoot(t);
  const reg = createSessionRegistry({ root });
  await reg.create({ title: "对话 A" });

  // 写入非法 JSON → list/get 回退空 store；后续写盘覆盖为合法 store
  await fs.writeFile(path.join(root, "sessions", "index.json"), "{ not valid json", "utf8");
  assert.deepEqual(await reg.list(), []);
  assert.equal(await reg.get("anything"), null);
  await reg.create({ title: "对话 B" });
  const all = await reg.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, "对话 B");
});

test("会话注册表：并发写串行化不丢数据", async (t) => {
  const root = await makeRoot(t);
  const reg = createSessionRegistry({ root });
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => reg.create({ title: `对话 ${i}` }))
  );
  const all = await reg.list();
  assert.equal(all.length, 10, "并发 create 全部落盘");
  assert.equal(new Set(all.map((s) => s.session_id)).size, 10, "sessionId 无重复");
});
