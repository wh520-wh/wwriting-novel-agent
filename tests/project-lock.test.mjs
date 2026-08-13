import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectLockRegistry } from "../src/core/project-lock.mjs";

test("project lock serializes work for the same project", async () => {
  const locks = createProjectLockRegistry();
  const projectRoot = path.join(os.tmpdir(), "wwriting-lock-same");
  const events = [];

  const first = locks.runExclusive(projectRoot, async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 25));
    events.push("first:end");
    return "first";
  });
  const second = locks.runExclusive(projectRoot, async () => {
    events.push("second:start");
    events.push("second:end");
    return "second";
  });

  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("project lock releases after a failing task", async () => {
  const locks = createProjectLockRegistry();
  const projectRoot = path.join(os.tmpdir(), "wwriting-lock-throw");

  await assert.rejects(
    () => locks.runExclusive(projectRoot, async () => {
      throw new Error("boom");
    }),
    /boom/u
  );

  const result = await locks.runExclusive(projectRoot, async () => "recovered");
  assert.equal(result, "recovered");
});

test("project lock allows different projects to run independently", async () => {
  const locks = createProjectLockRegistry();
  const events = [];

  await Promise.all([
    locks.runExclusive("project-a", async () => {
      events.push("a:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("a:end");
    }),
    locks.runExclusive("project-b", async () => {
      events.push("b:start");
      events.push("b:end");
    })
  ]);

  assert.ok(events.indexOf("b:start") < events.indexOf("a:end"));
});

test("project lock removes tail entries once tasks settle (registry 完成后无尾条目)", async () => {
  // B10：registry 必须按"派生 tail Promise 本身"删除尾条目（比较 current 永远不
  // 相等，旧实现因此泄漏）。通过构造函数注入的观察者 seam 观测删除事件，不向
  // registry 的公开面暴露任何生产诊断 API。
  const removals = [];
  const locks = createProjectLockRegistry({ onTailRemoved: (key) => removals.push(key) });
  const projectRoot = path.join(os.tmpdir(), "wwriting-lock-tails");

  await locks.runExclusive(projectRoot, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await locks.runExclusive(projectRoot, async () => "done");

  assert.equal(removals.length, 2, "每个 settle 的任务都应移除自己的尾条目");
  assert.equal(removals[0], removals[1], "同一项目的 key 归一化一致");
});

