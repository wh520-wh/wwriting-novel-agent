// 任意工作区契约测试（计划 Task 1 红阶段）。
//
// 冻结的目标契约（SPEC §2.1/§11；Task 2/3/4/6 实现，本任务只写失败测试）：
//   - 空目录/普通文件夹无需 project.yaml 即可打开并发送第一条消息；
//   - 新会话 journal（events.jsonl）只写应用私有 stateRoot/workspaces/<id>/agent，
//     不回写项目内 .wwriting/agent，项目目录内也不新增 project.yaml；
//   - 打开与第一条消息的失败正文不得泄露 ENOENT/堆栈/绝对内部路径
//     （后者在 tests/app-server-failure-body.test.mjs 覆盖）。
//
// 当前实现（基线 7956d99）这些断言按契约原因失败：POST /api/projects/open 仍以
// project.yaml 存在性作为资格（validateProjectRoot），journal 仍写项目内
// .wwriting/agent。失败即契约差距，不是测试基建语法错误。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppShellServer } from "../../src/core/app-server.mjs";
import { validateWorkspaceRoot } from "../../src/core/app-dashboard.mjs";
import { closeServer, listenOnFetchSafePort } from "../helpers/http-test.mjs";
import { createMockModelGateway } from "../helpers/project-agent-harness.mjs";

// ---------------------------------------------------------------------------
// 测试基建：临时根目录 + 确定性 gateway 的 app-shell server
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, { timeout = 20000, describe = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`waitFor 超时（${timeout}ms）：${describe}`);
}

// containsWorkspaceJournal(stateRoot)：stateRoot/workspaces 下任意 <id>/agent/
// 目录存在 events.jsonl 即为 true（应用私有 workspace 布局见 SPEC §2.1）。
export async function containsWorkspaceJournal(stateRoot) {
  const workspacesDir = path.join(stateRoot, "workspaces");
  let entries;
  try {
    entries = await fs.readdir(workspacesDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentDir = path.join(workspacesDir, entry.name, "agent");
    try {
      if ((await fs.readdir(agentDir)).includes("events.jsonl")) return true;
    } catch {
      // 该 workspace 尚无 agent 目录，继续扫描
    }
  }
  return false;
}

// 启动一个针对任意文件夹的 app-shell server（组合根注入，见 Task 1 简报）：
//   - stateRoot：应用私有根（userData），由测试显式传入；
//   - gatewayScript：确定性 mock gateway 脚本（与 project-agent-harness 同形）；
//   - selectedProjectRoot 不预置：文件夹由测试通过 POST /api/projects/open 打开；
//   - 返回 { gateway, post(path, body), waitForIdle(projectRoot) }；
//     t.after 负责关闭服务器。
export async function startArbitraryWorkspaceServer(t, { projectRoot, stateRoot, gatewayScript = [], gatewayDelayMs = 30 } = {}) {
  const base = path.dirname(projectRoot);
  const gateway = createMockModelGateway({ script: gatewayScript, delayMs: gatewayDelayMs });
  const { createSkillService } = await import("../../src/core/skills/index.mjs");
  const skills = createSkillService({ userHome: path.join(base, ".skills-home"), resourcesPath: null });
  const server = createAppShellServer({
    workspaceRoot: base,
    selectedProjectRoot: null,
    stateRoot,
    secretsRoot: path.join(base, ".secrets"),
    staticRoot: path.resolve("src", "app-shell"),
    port: 0,
    skills,
    testGatewayFactory: () => gateway
  });
  const port = await listenOnFetchSafePort(server);
  t.after(async () => {
    await closeServer(server);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    gateway,
    async post(route, body = {}) {
      const res = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => null);
      return { res, data };
    },
    // 轮询 /api/agent/snapshot 直到 session 回到 idle（mirror harness 的 waitForIdle）。
    async waitForIdle(targetRoot) {
      await waitFor(async () => {
        const res = await fetch(`${baseUrl}/api/agent/snapshot?projectRoot=${encodeURIComponent(targetRoot)}`);
        const data = await res.json().catch(() => null);
        return data?.session?.status === "idle" ? true : null;
      }, "session 回到 idle");
    }
  };
}

// ---------------------------------------------------------------------------
// 目录资格（计划 Task 4 Step 1 的目录资格测试）
// ---------------------------------------------------------------------------

test("validateWorkspaceRoot 只要求目录存在且可访问", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-root-"));
  await fs.writeFile(path.join(root, "notes.txt"), "资料", "utf8");
  assert.equal(await validateWorkspaceRoot(root), path.resolve(root));
  await assert.rejects(() => validateWorkspaceRoot(path.join(root, "missing")), /文件夹不存在/u);
  await assert.rejects(() => validateWorkspaceRoot(path.join(root, "notes.txt")), /不是文件夹/u);
  await assert.rejects(() => validateWorkspaceRoot("   "), /请选择一个工作文件夹/u);
});

// ---------------------------------------------------------------------------
// 契约测试（当前实现按契约原因失败 —— 红阶段）
// ---------------------------------------------------------------------------

test("空目录无需 project.yaml 即可发送第一条消息，journal 只写 userData", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-any-folder-"));
  const projectRoot = path.join(root, "普通文件夹");
  const stateRoot = path.join(root, "user-data");
  await fs.mkdir(projectRoot, { recursive: true });

  const app = await startArbitraryWorkspaceServer(t, {
    projectRoot,
    stateRoot,
    gatewayScript: [{ reply: { text: "你好，我可以在这个工作区协助你。" } }]
  });
  const opened = await app.post("/api/projects/open", { projectRoot });
  assert.equal(opened.res.status, 200);
  const sent = await app.post("/api/agent/input", { projectRoot, text: "你好" });
  assert.equal(sent.res.status, 200);
  await app.waitForIdle(projectRoot);

  assert.equal(await pathExists(path.join(projectRoot, "project.yaml")), false);
  assert.equal(await pathExists(path.join(projectRoot, ".wwriting", "agent")), false);
  assert.equal(await containsWorkspaceJournal(stateRoot), true);
});
