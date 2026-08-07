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
import { createWorkspaceStore } from "../../src/core/workspaces/store.mjs";
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

// 任务 5：普通目录的模型配置从 project.yaml 解耦。切换模型写入应用私有 settings，
// 下一模型轮的 request.modelConfig 必须是所选模型；project.yaml 绝不创建。
test("普通目录模型切换后，模型请求 modelConfig 是所选模型且不创建 project.yaml", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-plain-model-"));
  const projectRoot = path.join(root, "普通文件夹");
  const stateRoot = path.join(root, "user-data");
  await fs.mkdir(projectRoot, { recursive: true });

  const captured = [];
  const app = await startArbitraryWorkspaceServer(t, {
    projectRoot,
    stateRoot,
    gatewayScript: [
      (request) => {
        captured.push(request.modelConfig);
        return { text: "收到，用所选模型回复。" };
      }
    ]
  });
  const opened = await app.post("/api/projects/open", { projectRoot });
  assert.equal(opened.res.status, 200);
  // 先保存一个全局模型，再把它切给普通工作区
  const saved = await app.post("/api/settings/model-profile", {
    active_model: {
      provider: "openai-compatible",
      model_name: "deepseek-chat",
      base_url: "https://api.deepseek.com",
      api_key_env: "DEEPSEEK_API_KEY",
      api_key: "sk-test-abc"
    }
  });
  assert.equal(saved.res.status, 200);
  const switched = await app.post("/api/settings/model-switch", {
    projectRoot,
    model_id: "deepseek-chat"
  });
  assert.equal(switched.res.status, 200);
  const sent = await app.post("/api/agent/input", { projectRoot, text: "你好" });
  assert.equal(sent.res.status, 200);
  await app.waitForIdle(projectRoot);

  assert.equal(captured.length, 1, "普通目录模型请求应恰好发生一次");
  assert.equal(captured[0].model_name, "deepseek-chat");
  assert.equal(await pathExists(path.join(projectRoot, "project.yaml")), false);
});

// ---------------------------------------------------------------------------
// 旧项目只读迁移（计划 Task 11）：迁移失败 fixture 仍可完成第一条消息
// ---------------------------------------------------------------------------

// 对旧项目只读源（.wwriting/agent 递归 + project.yaml）做字节快照。
async function snapshotLegacySources(projectRoot) {
  const entries = {};
  async function walk(rel) {
    const target = path.join(projectRoot, rel);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(target)) await walk(path.join(rel, name));
    } else {
      entries[rel] = await fs.readFile(target);
    }
  }
  for (const rel of ["project.yaml", path.join(".wwriting", "agent")]) {
    if (await pathExists(path.join(projectRoot, rel))) await walk(rel);
  }
  return entries;
}

test("旧项目 project.yaml 损坏：迁移失败仍可完成第一条消息，原数据字节不变", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-legacy-corrupt-"));
  const projectRoot = path.join(root, "旧项目");
  const stateRoot = path.join(root, "user-data");
  await fs.mkdir(path.join(projectRoot, ".wwriting", "agent"), { recursive: true });
  const events = [
    JSON.stringify({
      schema_version: 1,
      seq: 1,
      event_id: "evt-1",
      session_id: "legacy-sess",
      run_id: null,
      project_root: projectRoot,
      type: "session_created",
      at: "2026-08-01T00:00:00.000Z",
      payload: {}
    })
  ].join("\n") + "\n";
  await fs.writeFile(path.join(projectRoot, ".wwriting", "agent", "events.jsonl"), events, "utf8");
  // project.yaml 损坏：同名目录（readFile 抛 EISDIR，open 不得失败）
  await fs.mkdir(path.join(projectRoot, "project.yaml"));
  const before = await snapshotLegacySources(projectRoot);

  const app = await startArbitraryWorkspaceServer(t, {
    projectRoot,
    stateRoot,
    gatewayScript: [{ reply: { text: "你好，旧项目也可以继续工作。" } }]
  });
  const opened = await app.post("/api/projects/open", { projectRoot });
  assert.equal(opened.res.status, 200, "迁移失败不得阻塞打开");
  assert.doesNotMatch(JSON.stringify(opened.data), /ENOENT|node:fs|at\s+\w+/iu, "失败正文不得泄露原始错误");
  const sent = await app.post("/api/agent/input", { projectRoot, text: "你好" });
  assert.equal(sent.res.status, 200);
  await app.waitForIdle(projectRoot);

  // 聊天资格不依赖迁移成功；迁移失败不产生 WWRITING.md；标记保持 false（下次重试）
  assert.deepEqual(await snapshotLegacySources(projectRoot), before, "原 project.yaml 与 .wwriting/agent 字节必须完全不变");
  assert.equal(await pathExists(path.join(projectRoot, "WWRITING.md")), false, "损坏时不写 WWRITING.md");
  const store = createWorkspaceStore({ stateRoot });
  assert.equal((await store.loadSettings(projectRoot)).legacy_project_imported, false, "迁移失败标记保持 false");
});
