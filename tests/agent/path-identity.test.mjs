// 路径身份统一（第二十一轮）Task 1：根解析与失败闭环；Task 2：全部比较点切到
// 解析后的真实项目根。
//
// 覆盖契约：
//   1. 取值口径 fail-closed：工具上下文缺 `resolved_project_root` 时，
//      受保护路径判定必须抛错（而不是静默退回未解析的根）；
//   2. 项目根不存在时该次工具调用整体被拒绝（path_resolution_failed），
//      journal 记到固定 rule，且绝不发生任何写入；
//   3. 项目根本身是目录链接（Windows junction）时，受保护路径保护、只读工具读取、
//      项目内写入的 scope 判定都必须以解析后的真实根为基准（Task 2）。
// 只读约束：事件一律经 journal.read({ afterSeq: 0 }) 读取，断言 technical.rule。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentJournal } from "../../src/core/agent/journal.mjs";
import { fileProtectedCheck } from "../../src/core/agent/tools/runtime-helpers.mjs";
import { createToolRuntime } from "../../src/core/agent/tools/index.mjs";
import { createWritingProject } from "../helpers.mjs";
// Windows 并行负载下句柄延迟释放会让 recursive rm 偶发 ENOTEMPTY/EBUSY（含 junction
// 的工作区在整库并行跑时更明显），沿用 harness 的退避清理。
import { rmTree } from "../helpers/project-agent-harness.mjs";

// 标准写作项目骨架 + journal 活动 Run（与 tests/agent/count-text.test.mjs 同款夹具）。
// options.tool_permissions 覆盖项目默认权限（createProjectAt 合并到默认值上）；
// options.shellRuntime 注入确定性 shell 桩（本任务 shell 分类用例用）。
async function setup(t, options = {}) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-path-identity-"));
  t.after(async () => {
    await rmTree(workspaceRoot);
  });
  const { projectRoot, project } = await createWritingProject(workspaceRoot, {
    slug: "novel",
    ...(options.tool_permissions ? { tool_permissions: options.tool_permissions } : {})
  });
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const runId = "run-1";
  const inputId = "input-1";
  await journal.appendBatch([
    { type: "run_started", run_id: runId, payload: { input_id: inputId } }
  ]);
  const tools = createToolRuntime({
    journal,
    projectOperations: {},
    skills: {},
    ...(options.shellRuntime ? { shellRuntime: options.shellRuntime } : {})
  });
  const context = { projectRoot, project, run_id: runId, active_input_id: inputId };
  return { tools, journal, context, projectRoot, workspaceRoot };
}

// 项目根 + 指向它的 junction 链接（target 在前、链接路径在后；Windows junction
// 不需要管理员特权）。requireJunction 用于 junction 组用例的 Windows skip。
async function setupJunction(t, options = {}) {
  const base = await setup(t, options);
  const linkRoot = path.join(base.workspaceRoot, "novel-link");
  await fs.symlink(base.projectRoot, linkRoot, "junction");
  return { ...base, linkRoot };
}

// 确定性 shell 桩：不启动真实进程，回显 cwd（供 shell 分类用例断言）。
async function stubShellRuntime({ cwd }) {
  return { exitCode: 0, cwd, signal: null, durationMs: 0, stdout: "", stderr: "" };
}

// 轮询 journal 直到出现该 tool call 的 decision_requested（旧比较逻辑下项目内
// 写入会被误判项目外而请求确认）；超时返回 null，绝不留悬挂 promise。
async function pollDecision(journal, toolCallId, { maxPolls = 50 } = {}) {
  for (let i = 0; i < maxPolls; i += 1) {
    const events = await journal.read({ afterSeq: 0 });
    const found = events.find(
      (event) => event.type === "decision_requested" && event.payload.tool_call_id === toolCallId
    );
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

test("上下文缺 resolved_project_root：受保护路径判定抛 path_resolution_failed（fail-closed）", async (t) => {
  const { projectRoot } = await setup(t);

  assert.throws(
    () => fileProtectedCheck({ path: "run_log.jsonl" }, { projectRoot }),
    (error) => error.code === "path_resolution_failed" && error.technical?.rule === "project_root_unresolved"
  );

  // 正向对照：键存在时判定不抛错，仍按既有受保护规则生效（是键缺失触发抛错，不是恒抛错）
  assert.equal(
    fileProtectedCheck({ path: "run_log.jsonl" }, { projectRoot, resolved_project_root: projectRoot })?.rule,
    "run_log"
  );
});

test("项目根不存在：write_file 拒绝为 path_resolution_failed、journal 记 rule 且不写入", async (t) => {
  const { tools, journal, context, workspaceRoot } = await setup(t);
  const missingRoot = path.join(workspaceRoot, "missing-project");

  const result = await tools.execute(
    { id: "missing-root", name: "write_file", arguments: { path: "notes.md", content: "x" } },
    { ...context, projectRoot: missingRoot }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "path_resolution_failed");
  const events = await journal.read({ afterSeq: 0 });
  const failure = events.find((event) => event.type === "tool_call_failed" && event.payload.tool_call_id === "missing-root");
  assert.equal(failure?.payload.technical?.rule, "project_root_unresolved");
  // 绝无写入：既不在（不存在的）项目根下，也不在解析回退到的最近存在父目录下
  assert.equal(await fs.stat(path.join(missingRoot, "notes.md")).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(workspaceRoot, "notes.md")).then(() => true, () => false), false);
  // 活动闭环：失败事件必须对应已开始的工具调用
  assert.ok(events.some((event) => event.type === "tool_call_started" && event.payload.tool_call_id === "missing-root"));
});

test("目标路径非字符串：write_file 返回 target_path_unresolved，不抛不悬挂且不写入", async (t) => {
  const { tools, journal, context, projectRoot } = await setup(t);

  // parseToolArguments 只校验参数是 JSON 对象，不校验字段类型：模型给数字 path 是可达输入。
  const result = await tools.execute(
    { id: "bad-target", name: "write_file", arguments: { path: 123, content: "x" } },
    context
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "path_resolution_failed");
  const events = await journal.read({ afterSeq: 0 });
  assert.ok(events.some((event) => event.type === "tool_call_started" && event.payload.tool_call_id === "bad-target"));
  const failure = events.find((event) => event.type === "tool_call_failed" && event.payload.tool_call_id === "bad-target");
  assert.equal(failure?.payload.technical?.rule, "target_path_unresolved");
  // 绝无写入：工具体不得被执行
  assert.equal(await fs.stat(path.join(projectRoot, "123")).then(() => true, () => false), false);
  assert.equal(events.some((event) => event.type === "tool_call_completed" && event.payload.tool_call_id === "bad-target"), false);
});

// ---------------------------------------------------------------------------
// Task 2：项目根本身是目录链接（junction）时的全部比较点
// ---------------------------------------------------------------------------

// yolo:true 让旧比较逻辑即使把 junction 根下的写入误判成项目外也立即返回
//（否则会挂在确认上）；新代码必须在权限评估之前先以受保护规则拒绝。
test("junction 项目根下受保护路径保护整体生效（表驱动）", { skip: process.platform !== "win32" }, async (t) => {
  const { tools, journal, context, projectRoot: realRoot, linkRoot } = await setupJunction(t, {
    tool_permissions: { yolo: true }
  });

  const cases = [
    [".wwriting/agent/protected-test.txt", "agent_journal"],
    ["checkpoints/cp.json", "project_checkpoints"],
    ["memory/chapter_index.json", "chapter_index"],
    ["drafts/001.md", "draft_files"],
    [".versions/chapters/001.md", "version_files"],
    ["memory/continuity.json", "memory_files"],
    ["project.yaml", "project_config"],
    ["run_log.jsonl", "run_log"]
  ];
  for (const [relative, rule] of cases) {
    for (const root of [realRoot, linkRoot]) {
      const where = root === linkRoot ? "link" : "real";
      const call = { id: `protected-${rule}-${where}`, name: "write_file", arguments: { path: relative, content: "x" } };
      const result = await tools.execute(call, { ...context, projectRoot: root });
      const events = await journal.read({ afterSeq: 0 });
      const failure = events.find((event) => event.type === "tool_call_failed" && event.payload.tool_call_id === call.id);
      assert.equal(result.ok, false, `${relative}（${where} 根）必须被拒绝`);
      assert.equal(failure?.payload.technical?.rule, rule, `${relative}（${where} 根）必须以受保护规则拒绝`);
    }
  }
});

// 反向用例：junction 根下的只读工具必须读到真实项目内的文件、动作仍判为项目内；
// count_text / style_stats 必须保留原始 args.path（返回结果的 path 字段是冻结契约）。
test("junction 项目根下只读工具判为项目内且保留原始 path（反向用例）", { skip: process.platform !== "win32" }, async (t) => {
  const { tools, journal, context, projectRoot: realRoot, linkRoot } = await setupJunction(t, {
    tool_permissions: { yolo: true },
    shellRuntime: stubShellRuntime
  });
  await fs.writeFile(path.join(realRoot, "chapters", "001.md"), "第一章", "utf8");

  for (const name of ["count_text", "style_stats"]) {
    const id = `read-${name}`;
    const result = await tools.execute({ id, name, arguments: { path: "chapters/001.md" } }, { ...context, projectRoot: linkRoot });
    assert.equal(result.ok, true, `${name} 必须读取 junction 项目根内的文件`);
    assert.equal(result.result.path, "chapters/001.md", `${name} 的结果 path 必须保持原始参数`);
    const events = await journal.read({ afterSeq: 0 });
    const started = events.find((event) => event.type === "tool_call_started" && event.payload.tool_call_id === id);
    assert.equal(started?.payload.action.scope, "project", `${name} 的动作必须判为项目内`);
  }

  const shell = await tools.execute({ id: "shell-default", name: "shell", arguments: { command: "dir", purpose: "列出文件" } }, { ...context, projectRoot: linkRoot });
  assert.equal(shell.ok, true);
  const events = await journal.read({ afterSeq: 0 });
  const startedShell = events.find((event) => event.type === "tool_call_started" && event.payload.tool_call_id === "shell-default");
  assert.equal(startedShell?.payload.action.scope, "project", "默认 cwd 的 shell 必须判为项目内");
});

// shell 显式 cwd 落在受保护目录：以真实根比较（link 根下否则会 fail-open 放行）。
test("junction 项目根下 shell 显式 cwd 落在受保护目录按保护规则拒绝", { skip: process.platform !== "win32" }, async (t) => {
  const { tools, journal, context, linkRoot } = await setupJunction(t, {
    tool_permissions: { yolo: true },
    shellRuntime: stubShellRuntime
  });

  const cases = [
    ["checkpoints", "project_checkpoints"],
    [path.join(".wwriting", "agent"), "agent_journal"]
  ];
  for (const [relative, rule] of cases) {
    const id = `shell-cwd-${rule}`;
    const result = await tools.execute(
      { id, name: "shell", arguments: { command: "dir", cwd: relative, purpose: "列出文件" } },
      { ...context, projectRoot: linkRoot }
    );
    assert.equal(result.ok, false, `cwd=${relative} 必须被拒绝`);
    const events = await journal.read({ afterSeq: 0 });
    const failure = events.find((event) => event.type === "tool_call_failed" && event.payload.tool_call_id === id);
    assert.equal(failure?.payload.technical?.rule, rule, `cwd=${relative} 必须以 ${rule} 拒绝`);
  }
});

// 反向用例：auto_edit + junction 根的项目内写入必须直接成功，不得请求确认。
// 旧比较逻辑会误判项目外 → 这里轮询到 decision 后拒绝收尾（不留悬挂 promise），
// 再由断言失败暴露回归。
test("junction 项目根下项目内章节写入不被误判为项目外（auto_edit）", { skip: process.platform !== "win32" }, async (t) => {
  const { tools, journal, context, projectRoot: realRoot, linkRoot } = await setupJunction(t, {
    tool_permissions: { auto_edit: true }
  });

  const id = "write-chapter-link";
  const pending = tools.execute(
    { id, name: "write_file", arguments: { path: "chapters/001.md", content: "第一章" } },
    { ...context, projectRoot: linkRoot }
  );
  const decision = await pollDecision(journal, id);
  if (decision) {
    await tools.resolveDecision({ decisionId: decision.payload.decision_id, choice: "deny" });
  }
  const result = await pending;
  const events = await journal.read({ afterSeq: 0 });
  assert.equal(result.ok, true, "junction 根下的项目内章节写入必须直接执行");
  assert.equal(
    events.some((event) => event.type === "decision_requested" && event.payload.tool_call_id === id),
    false,
    "项目内写入不得请求确认"
  );
  assert.equal(await fs.readFile(path.join(realRoot, "chapters", "001.md"), "utf8"), "第一章");
});

// 反向用例：safe_edit=false 的章节写入必须以 safe_edit_disabled 拒绝（能力级禁用
// 优先于 YOLO；yolo:true 只为让旧比较逻辑立即返回而不挂确认）。
test("junction 项目根下 safe_edit=false 的章节写入按 safe_edit_disabled 拒绝", { skip: process.platform !== "win32" }, async (t) => {
  const { tools, journal, context, linkRoot } = await setupJunction(t, {
    tool_permissions: { safe_edit: false, yolo: true }
  });

  const id = "safe-edit-chapter";
  const result = await tools.execute(
    { id, name: "write_file", arguments: { path: "chapters/002.md", content: "x" } },
    { ...context, projectRoot: linkRoot }
  );
  assert.equal(result.ok, false);
  const events = await journal.read({ afterSeq: 0 });
  const failure = events.find((event) => event.type === "tool_call_failed" && event.payload.tool_call_id === id);
  assert.equal(failure?.payload.technical?.rule, "safe_edit_disabled");
});
