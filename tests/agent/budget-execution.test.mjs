// 预算执行回归（2026-10-03 补强，访谈拍板语义）：
// - budget_config.enabled 默认关闭：不限制调用数，runtime.budget 注入空对象；
// - 开启且配置 max_model_calls：每次模型请求前检查 Run 内累计，达到上限以
//   run_failed(code=budget_exhausted) 结束且不再发起请求；
// - retry = 重新给预算：计数清零后重新累计，不需要调大配置。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectAgent } from "../../src/core/agent/index.mjs";
import { createProjectRoot } from "../helpers/project-agent-harness.mjs";
import { serializeSimpleYaml } from "../../src/core/simple-yaml.mjs";

async function makeProject(budgetConfig) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ww-budget-"));
  const { projectRoot, project } = await createProjectRoot(workspace, { slug: "novel" });
  if (budgetConfig) {
    await fs.writeFile(
      path.join(projectRoot, "project.yaml"),
      serializeSimpleYaml({ ...project, budget_config: budgetConfig })
    );
  }
  return { projectRoot };
}

async function waitStatus(agent, projectRoot, expected) {
  let snapshot;
  for (let i = 0; i < 300; i++) {
    snapshot = await agent.snapshot({ projectRoot });
    if (snapshot.session?.active_run?.status === expected) return snapshot;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`Run 未在预期时间内进入 ${expected}（当前 ${snapshot?.session?.active_run?.status}）`);
}

test("预算默认关闭：不限制调用数，runtime budget 注入空对象", async () => {
  const { projectRoot } = await makeProject();
  let calls = 0;
  const budgets = [];
  const agent = createProjectAgent({ modelGateway: { async complete(request) {
    const systemText = request.messages.find((m) => m.role === "system")?.content ?? "";
    budgets.push(systemText.match(/^budget: (.*)$/mu)?.[1] ?? null);
    if (++calls < 3) return { toolCalls: [{ id: `t${calls}`, name: "read_file", arguments: { path: "WORKLOG.md" } }] };
    return { text: "完成" };
  } } });
  await agent.submit({ projectRoot, text: "查看工作日志" });
  await waitStatus(agent, projectRoot, "completed");
  assert.equal(calls, 3);
  assert.ok(budgets.every((b) => b === "{}"), `未启用时 budget 注入应为空对象：${budgets.join(",")}`);
});

test("预算启用达到上限：不再发起请求，以 budget_exhausted 失败", async () => {
  const { projectRoot } = await makeProject({ enabled: true, max_model_calls: 2 });
  let calls = 0;
  const budgets = [];
  const agent = createProjectAgent({ modelGateway: { async complete(request) {
    const systemText = request.messages.find((m) => m.role === "system")?.content ?? "";
    budgets.push(systemText.match(/^budget: (.*)$/mu)?.[1] ?? null);
    if (++calls <= 2) return { toolCalls: [{ id: `t${calls}`, name: "read_file", arguments: { path: "WORKLOG.md" } }] };
    return { text: "完成" };
  } } });
  await agent.submit({ projectRoot, text: "查看工作日志" });
  const snapshot = await waitStatus(agent, projectRoot, "failed");
  assert.equal(calls, 2, "达到上限后不得再发起模型请求");
  const failed = snapshot.events.find((e) => e.type === "run_failed");
  assert.ok(failed, "应产生 run_failed 事件");
  assert.equal(failed.payload.code, "budget_exhausted");
  assert.ok(String(failed.payload.error).includes("已达到模型调用上限"));
  assert.ok(budgets.some((b) => b.includes('"max_model_calls":2')), "runtime budget 注入上限与已用次数");
});

test("retry 后预算清零重新计数（重新给预算）", async () => {
  const { projectRoot } = await makeProject({ enabled: true, max_model_calls: 1 });
  let calls = 0;
  const agent = createProjectAgent({ modelGateway: { async complete() {
    calls += 1;
    return { toolCalls: [{ id: `t${calls}`, name: "read_file", arguments: { path: "WORKLOG.md" } }] };
  } } });
  await agent.submit({ projectRoot, text: "查看工作日志" });
  const failed = await waitStatus(agent, projectRoot, "failed");
  assert.equal(calls, 1, "第 1 次调用后即达限失败");
  const runId = failed.session.active_run.id;
  await agent.retry({ projectRoot, runId });
  await waitStatus(agent, projectRoot, "failed");
  assert.equal(calls, 2, "retry 清零计数：重新允许 1 次调用，而非立即再失败");
});

test("上一个 Run 用掉部分预算后，submit 新输入获得全新预算（Run 内累计）", async () => {
  const { projectRoot } = await makeProject({ enabled: true, max_model_calls: 2 });
  let calls = 0;
  const agent = createProjectAgent({ modelGateway: { async complete() {
    calls += 1;
    return { text: `第 ${calls} 次完成` };
  } } });
  // Run A：1 次调用后正常完成（2/2 额度只用掉 1）
  await agent.submit({ projectRoot, text: "任务一" });
  await waitStatus(agent, projectRoot, "completed");
  assert.equal(calls, 1);
  // Run B：不清零的话剩余额度只有 1 且计数 1>=1 会在第一轮请求前立即达限失败；
  // 新 Run 必须重新拿到完整额度（无工具轮，1 次调用完成）
  await agent.submit({ projectRoot, text: "任务二" });
  await waitStatus(agent, projectRoot, "completed");
  assert.equal(calls, 2, "Run B 从零重新计数（Run A 1 次 + Run B 1 次）");
});
