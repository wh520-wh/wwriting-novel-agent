// 恢复临界区回归（2026-10-03 补强）：
// 恢复的「读当前内容 → pre_restore 安全快照 → 覆盖」与 busy 检查整体在项目写锁内，
// 与 Agent 工具写入（同一把锁）互斥——恢复窗口内的新内容要么被拒绝、要么进安全快照，
// 不再出现「备份与覆盖之间被并发写入覆盖且不存档」的丢失。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectRoutes } from "../../src/core/http/project-routes.mjs";
import { createProjectLockRegistry } from "../../src/core/project-lock.mjs";
import { snapshotMemoryFile, listMemoryVersions, readMemoryVersion } from "../../src/core/project-operations/memory-versions.mjs";
import { createProjectRoot } from "../helpers/project-agent-harness.mjs";

async function makeWorkspace(name) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `ww-restore-${name}-`));
  const stateRoot = path.join(workspace, ".state");
  const { projectRoot } = await createProjectRoot(workspace, { slug: "novel" });
  return { workspace, stateRoot, projectRoot };
}

test("Agent 忙时恢复被拒绝（busy 检查在锁内，行为保持 409）", async () => {
  const { workspace, stateRoot, projectRoot } = await makeWorkspace("busy");
  const routes = createProjectRoutes({
    workspace,
    stateRoot,
    selection: { current: projectRoot },
    projectLocks: createProjectLockRegistry(),
    agent: { projectBusy: async () => true, appendSystemEvent: async () => {} }
  });
  await assert.rejects(
    routes["POST /api/memory/versions/restore"]({ body: { projectRoot, file: "worklog", version: 1 } }),
    (error) => error.code === "agent_running" && error.httpStatus === 409
  );
});

test("恢复锁内读到的最新内容进安全快照，恢复窗口并发写入不丢失", async () => {
  const { workspace, stateRoot, projectRoot } = await makeWorkspace("race");
  const worklog = path.join(projectRoot, "WORKLOG.md");
  await snapshotMemoryFile({ projectRoot, file: "worklog", content: "历史内容", source: "commit" });
  await fs.writeFile(worklog, "恢复之前的内容");

  const locks = createProjectLockRegistry();
  let signalReached, releaseRestore;
  const reached = new Promise((r) => { signalReached = r; });
  const gate = new Promise((r) => { releaseRestore = r; });
  // 只延迟恢复自身的锁入口：signal 后并发写入先持真锁完成，恢复随后进锁。
  const gatedLocks = {
    runExclusive: (root, fn) => { signalReached(); return gate.then(() => locks.runExclusive(root, fn)); }
  };
  const routes = createProjectRoutes({
    workspace,
    stateRoot,
    selection: { current: projectRoot },
    projectLocks: gatedLocks,
    agent: { projectBusy: async () => false, appendSystemEvent: async () => {} }
  });

  const restore = routes["POST /api/memory/versions/restore"]({ body: { projectRoot, file: "worklog", version: 1 } });
  await reached;
  // 模拟 Agent 工具写入（与恢复共用同一把真锁）：在恢复读取当前内容之前完成。
  await locks.runExclusive(projectRoot, async () => {
    await fs.writeFile(worklog, "恢复窗口内Agent刚写的新内容");
  });
  releaseRestore();
  const restored = await restore;
  assert.equal(restored.ok, true);
  assert.equal(await fs.readFile(worklog, "utf8"), "历史内容");
  const { versions } = await listMemoryVersions({ projectRoot, file: "worklog" });
  const contents = await Promise.all(
    versions.map((v) => readMemoryVersion({ projectRoot, file: "worklog", version: v.version }).then((r) => r.content))
  );
  assert.ok(
    contents.includes("恢复窗口内Agent刚写的新内容"),
    "恢复锁内读到的最新内容必须进 pre_restore 快照，不得静默丢失"
  );
});
