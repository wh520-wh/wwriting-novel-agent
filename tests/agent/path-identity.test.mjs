// 路径身份统一（第二十一轮）Task 1：根解析与失败闭环。
//
// 覆盖两条契约：
//   1. 取值口径 fail-closed：工具上下文缺 `resolved_project_root` 时，
//      受保护路径判定必须抛错（而不是静默退回未解析的根）；
//   2. 项目根不存在时该次工具调用整体被拒绝（path_resolution_failed），
//      journal 记到固定 rule，且绝不发生任何写入。
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

// 标准写作项目骨架 + journal 活动 Run（与 tests/agent/count-text.test.mjs 同款夹具）。
async function setup(t) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-path-identity-"));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
  const { projectRoot, project } = await createWritingProject(workspaceRoot, { slug: "novel" });
  const journal = createAgentJournal({ projectRoot });
  await journal.load();
  const runId = "run-1";
  const inputId = "input-1";
  await journal.appendBatch([
    { type: "run_started", run_id: runId, payload: { input_id: inputId } }
  ]);
  const tools = createToolRuntime({ journal, projectOperations: {}, skills: {} });
  const context = { projectRoot, project, run_id: runId, active_input_id: inputId };
  return { tools, journal, context, projectRoot, workspaceRoot };
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
