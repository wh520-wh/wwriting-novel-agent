// ProjectAgent 公共接口测试（统一 Agent 内核计划 Task 6）。
//
// 本文件只通过公共 seam 驱动 Agent（tests/helpers/project-agent-harness.mjs 经
// src/core/agent/index.mjs 构造；本文件不 import 任何 agent 内部文件）。覆盖：
//   - Session/Run 生命周期：idle submit 创建 Run、active submit FIFO 排队、
//     open() 幂等、同项目单循环
//   - 立即（promote）：同一 Run、输入切换、顺序保持、等待原子操作
//   - 停止（stop）：run_cancelled + input_cancelled + grant 清除
//   - retry：同一 failed Run 用 transcript 继续
//   - 不同项目可并行（单一 agent 实例）
//   - Visible Plan：update_plan 事件与 projection
//   - 权限：普通写确认、grant 不跨输入、YOLO 不绕过 extreme、extreme 精确文字、
//     停止清除 grant、陈旧决策拒绝、promote 抢占待决决策
//   - 活动闭环（成功/失败/拒绝/抢占/停止）
//   - 章节提交一致性、质量门禁失败修订路径、新项目不创建旧状态文件、
//     maintenance 审计来源
//
// 说明：shell 属于 control 类，普通命令按冻结安全政策需要确认；需要"忙碌工具"
// 的并发/中断场景沿用前置计划 chat-activity 测试的做法（yolo 放行普通命令），
// 确认类场景用 write_file 表达。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EXTREME_COMMANDS } from "../fixtures/command-risk-corpus.mjs";
import { serializeSimpleYaml } from "../../src/core/simple-yaml.mjs";
import {
  LEGACY_STATE_FILE,
  VALID_MEMORY,
  createMockModelGateway,
  createProjectAgentHarness,
  createProjectRoot,
  eventsOfType,
  openPlainFolderHarness,
  pathExists,
  readEvents,
  readSession,
  sleep,
  tool,
  waitFor,
  waitForIdle
} from "../helpers/project-agent-harness.mjs";

const EXTREME_COMMAND = EXTREME_COMMANDS[0];

async function openHarness(t, options) {
  const h = await createProjectAgentHarness(options);
  t.after(() => h.cleanup());
  await h.agent.open({ projectRoot: h.projectRoot });
  return h;
}

// 活动闭环不变量：每个 input/tool/decision 都必须收敛到终态。
// Task 9：input 终态集合同时接纳新生命周期事件（input_completed/input_interrupted/
// input_withdrawn）与 legacy（input_consumed/input_cancelled）。
function assertActivityClosure(events) {
  const openInputs = new Set();
  const openTools = new Set();
  const openDecisions = new Set();
  for (const event of events) {
    if (event.type === "input_queued") {
      openInputs.add(event.payload.input_id);
    } else if (
      event.type === "input_consumed" ||
      event.type === "input_cancelled" ||
      event.type === "input_completed" ||
      event.type === "input_interrupted" ||
      event.type === "input_withdrawn"
    ) {
      assert.ok(openInputs.has(event.payload.input_id), `input 终态必须对应已排队 input: ${event.payload.input_id}`);
      openInputs.delete(event.payload.input_id);
    } else if (event.type === "tool_call_started") {
      openTools.add(event.payload.tool_call_id ?? event.payload.id);
    } else if (event.type === "tool_call_completed" || event.type === "tool_call_failed") {
      const id = event.payload.tool_call_id ?? event.payload.id;
      assert.ok(openTools.has(id), `tool 终态必须对应已开始 tool call: ${id}`);
      openTools.delete(id);
    } else if (event.type === "decision_requested") {
      openDecisions.add(event.payload.decision_id);
    } else if (event.type === "decision_resolved") {
      assert.ok(openDecisions.has(event.payload.decision_id), `decision 终态必须对应已请求 decision`);
      openDecisions.delete(event.payload.decision_id);
    }
  }
  assert.deepEqual([...openInputs], [], "每个 input 都必须收敛");
  assert.deepEqual([...openTools], [], "每个 tool call 都必须收敛");
  assert.deepEqual([...openDecisions], [], "每个 decision 都必须收敛");
}

async function waitForDecision(agent, projectRoot, count = 1) {
  const snapshot = await waitFor(agent, projectRoot, (session, snap) =>
    eventsOfType(snap.events, "decision_requested").length >= count
  );
  return eventsOfType(snapshot.events, "decision_requested")[count - 1];
}

// ---------------------------------------------------------------------------
// Session / Run 生命周期
// ---------------------------------------------------------------------------

test("idle submit 创建且只创建一个 Run；submit 落盘即返回", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "好的。" } }] });
  const result = await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat" });
  assert.equal(result.queued, false);
  assert.ok(result.input_id && result.run_id);
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.status, "running");
  assert.equal(session.active_run.id, result.run_id);
  assert.equal(session.active_run.active_input_id, result.input_id);
  assert.equal(session.active_run.workflow, "general");

  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_started").length, 1);
  assert.equal(eventsOfType(events, "run_completed").length, 1);
  assert.equal(eventsOfType(events, "input_completed").length, 1, "空闲提交的输入以 input_completed 终结");
  assertActivityClosure(events);
});

test("模型请求携带 modelConfig（provider/model_name/base_url/api_key_env 来自项目 active_model）", async (t) => {
  // 回归：Task 11 Step 4 真实模型短跑发现 gateway 契约要求 runtime 把
  // modelConfig 挂到 request 上（gateway/adapter 依赖 model_name/base_url/
  // api_key_env 选择模型与读取密钥），assemblePrompt 不负责回填。
  const h = await openHarness(t, {
    project: {
      active_model: {
        provider: "openai-compatible",
        model_name: "regression-model-7f2",
        base_url: "https://api.example.com/v1",
        api_key_env: "DEEPSEEK_API_KEY"
      }
    },
    gatewayScript: [{ reply: { text: "好。" } }]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  assert.ok(h.gateway.calls.length >= 1, "应产生至少一次模型调用");
  const request = h.gateway.calls[0].request;
  assert.ok(request && typeof request === "object", "请求对象应存在");
  assert.ok(request.modelConfig && typeof request.modelConfig === "object", "request 必须携带 modelConfig");
  assert.equal(request.modelConfig.provider, "openai-compatible");
  assert.equal(request.modelConfig.model_name, "regression-model-7f2");
  assert.equal(request.modelConfig.base_url, "https://api.example.com/v1");
  assert.equal(request.modelConfig.api_key_env, "DEEPSEEK_API_KEY");
  // 纯文本回复（无工具调用）必须携带最终回复文本：AgentSurface 据此渲染助手
  // 气泡（state.js 仅在 payload.text 非空时入对话），缺失则"简单任务→简明回答"
  // 在 UI 不可见（Task 11 代码审查发现并修复的死路径）。
  const events = await readEvents(h.agent, h.projectRoot);
  const completed = eventsOfType(events, "assistant_message_completed");
  assert.ok(completed.length >= 1, "纯文本回复应产生 assistant_message_completed");
  assert.equal(completed[0].payload.text, "好。", "assistant_message_completed 必须携带最终回复文本");
});

test("模型 ID 尾标解析：active_model 原样持久化，modelConfig 携带基础 ID 与有效上下文窗口", async (t) => {
  // Task 2 契约：设置/项目对象中的原始 model_name（含 [1m][foo] 尾标）保持不变；
  // gateway 只收到剥离尾标后的基础 ID；有效上下文窗口/压缩阈值由尾标解析。
  const h = await openHarness(t, {
    project: {
      active_model: {
        provider: "openai-compatible",
        model_name: "model[1m][foo]",
        base_url: "https://api.example.com/v1",
        api_key_env: "DEEPSEEK_API_KEY"
      }
    },
    gatewayScript: [{ reply: { text: "好。" } }]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  assert.ok(h.gateway.calls.length >= 1, "应产生至少一次模型调用");
  const request = h.gateway.calls[0].request;
  assert.ok(request.modelConfig && typeof request.modelConfig === "object", "request 必须携带 modelConfig");
  assert.equal(request.modelConfig.provider, "openai-compatible");
  assert.equal(request.modelConfig.configured_model_id, "model[1m][foo]");
  assert.equal(request.modelConfig.model_name, "model", "gateway 收到剥离尾标后的基础 ID");
  assert.equal(request.modelConfig.effective_context_window, 1_000_000);
  assert.equal(request.modelConfig.compaction_threshold, 967_000);
  assert.equal(request.modelConfig.window_source, "model_id_1m");
  assert.equal(request.modelConfig.base_url, "https://api.example.com/v1");
  assert.equal(request.modelConfig.api_key_env, "DEEPSEEK_API_KEY");
  // 持久配置不被改写（plan invariant 9）：内存项目对象与磁盘 project.yaml 的
  // 原始 model_name 都必须仍是 model[1m][foo]。
  assert.equal(h.project.active_model.model_name, "model[1m][foo]");
  const persisted = await fs.readFile(path.join(h.projectRoot, "project.yaml"), "utf8");
  assert.match(persisted, /model\[1m\]\[foo\]/u, "project.yaml 中的原始 model_name 保持不变");
});

// ---------------------------------------------------------------------------
// Task 6：统一上下文用量（context_usage_updated 预检/校准 + session 投影）
// ---------------------------------------------------------------------------

test("每次模型轮预检追加 context_usage_updated：估算唯一输入是装配完成的最终请求", async (t) => {
  // 单输入规则：currentInput 已由 assemblePrompt 放入最后一条 user message，这里
  // 只对 request.messages/tools 估算一次。payload 只含数字与模型基础 ID。
  const marker = "上下文门禁验收消息-7f3a";
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "好的。" } }] });
  await h.agent.submit({ projectRoot: h.projectRoot, text: marker, source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const usageEvents = eventsOfType(events, "context_usage_updated");
  assert.ok(usageEvents.length >= 1, "预检必须追加 context_usage_updated");
  const preflight = usageEvents[0].payload.usage;
  assert.equal(preflight.status, "ready");
  assert.equal(preflight.estimator, "local");
  assert.equal(preflight.approximate, true, "无 provider usage 时保持近似");
  assert.equal(preflight.effective_context_window, 256_000, "缺省模型身份窗口 256k");
  assert.equal(preflight.compaction_threshold, 204_800);
  assert.equal(preflight.window_source, "default_256k");
  assert.equal(preflight.model, "mock-writer", "payload 携带模型基础 ID");
  assert.ok(preflight.used_tokens >= preflight.raw_tokens, "used 含安全系数，恒 >= raw");
  assert.ok(Number.isFinite(preflight.ratio) && preflight.ratio > 0);
  assert.ok(!Number.isNaN(Date.parse(preflight.updated_at)), "updated_at 为 ISO-8601");
  // payload 绝不含 prompt 原文（单输入规则 + 脱敏契约）
  for (const event of usageEvents) {
    assert.ok(!JSON.stringify(event.payload).includes(marker), "context_usage_updated payload 不得含 prompt 原文");
  }
  // session 投影：context_usage 深拷贝最新 ContextUsage，context revision 随事件递增
  const session = await readSession(h.agent, h.projectRoot);
  assert.deepEqual(session.context_usage, usageEvents.at(-1).payload.usage, "投影是深拷贝，与最新事件一致");
  assert.equal(session.revisions.context, usageEvents.length, "每个事件 bump 一次 context revision");
  assert.ok(session.revisions.context >= 2, "一次模型轮 = 预检 + 校准两条事件");
});

test("provider 返回 input usage 后校准当前会话：approximate 变 false，估算按 EMA 倍率缩放", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      (request) => ({ text: "好。", usageReport: { inputTokens: 500 } })
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "校准验收", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const usageEvents = eventsOfType(events, "context_usage_updated");
  assert.ok(usageEvents.length >= 2, "预检 + 校准各一条");
  const preflight = usageEvents[0].payload.usage;
  const calibrated = usageEvents.at(-1).payload.usage;
  assert.equal(preflight.approximate, true);
  assert.equal(calibrated.approximate, false, "provider 有 input usage 时退出近似");
  assert.equal(calibrated.raw_tokens, preflight.raw_tokens, "同一请求，raw 不变");
  assert.ok(calibrated.used_tokens < preflight.used_tokens, "500/估算 < 0.5 被夹到 0.5，估算按倍率缩小");
  // session 投影带校准结果（供上下文圆环显示精确占用）
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.context_usage.approximate, false);
  assert.equal(session.context_usage.used_tokens, calibrated.used_tokens);
});

test("provider 无 input usage 时维持 approximate:true，不产生校准", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "普通回复" } }] });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "无 usage 验收", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const usageEvents = eventsOfType(events, "context_usage_updated");
  assert.ok(usageEvents.length >= 1);
  for (const event of usageEvents) {
    assert.equal(event.payload.usage.approximate, true, "无 input usage 不得退出近似");
  }
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.context_usage.approximate, true);
});

test("模型从 1M 切到 256k：切换动作不追加压缩事件，下一次 submit 预检按新窗口重新计算", async (t) => {
  const h = await openHarness(t, {
    project: {
      active_model: {
        provider: "openai-compatible",
        model_name: "mock[1m][foo]",
        base_url: "https://api.example.com/v1",
        api_key_env: "DEEPSEEK_API_KEY"
      }
    },
    gatewayScript: [{ reply: { text: "第一轮" } }, { reply: { text: "第二轮" } }]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第一次", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  // 切换前：1M 档窗口
  let events = await readEvents(h.agent, h.projectRoot);
  let last = eventsOfType(events, "context_usage_updated").at(-1).payload.usage;
  assert.equal(last.effective_context_window, 1_000_000);
  assert.equal(last.compaction_threshold, 967_000);
  assert.equal(last.window_source, "model_id_1m");
  assert.equal(last.model, "mock");

  // 切换模型（1M → 256k）：只改 project.yaml，不追加任何 journal 事件
  h.project.active_model = { provider: "openai-compatible", model_name: "mock" };
  await fs.writeFile(path.join(h.projectRoot, "project.yaml"), serializeSimpleYaml(h.project), "utf8");
  events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "context_usage_updated").length, 2, "切换动作本身不追加 context 事件");

  await h.agent.submit({ projectRoot: h.projectRoot, text: "第二次", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  events = await readEvents(h.agent, h.projectRoot);
  last = eventsOfType(events, "context_usage_updated").at(-1).payload.usage;
  assert.equal(last.effective_context_window, 256_000, "下一次 submit 预检按新窗口重新计算");
  assert.equal(last.compaction_threshold, 204_800);
  assert.equal(last.window_source, "default_256k");
  assert.equal(last.model, "mock");
  // 压缩事件（Task 8 机制）在整个流程中都不出现：切换本身不触发压缩
  assert.equal(events.filter((event) => event.type.startsWith("context_compaction")).length, 0);
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.context_usage.effective_context_window, 256_000);
});

test("assistant tool_calls 以 OpenAI 线上格式进入后续模型请求", async (t) => {
  // 回归：Task 11 Step 4 真实模型验证发现 assistant tool_calls 以内部扁平形状
  // { id, name, arguments(对象) } 进入请求，DeepSeek/小米等 OpenAI-compatible
  // 提供方直接 400（missing field `type`）。线上格式要求
  // { id, type: "function", function: { name, arguments: JSON 字符串 } }。
  const h = await openHarness(t, {
    gatewayScript: [
      { reply: { toolCalls: [tool("read_file", { path: "OUTLINE.md" })] } },
      { reply: { text: "完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "读取大纲", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  assert.ok(h.gateway.calls.length >= 2, "应产生至少两轮模型调用");
  const second = h.gateway.calls[1].request;
  const assistant = (second.messages ?? []).find(
    (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
  );
  assert.ok(assistant, "第二轮请求应包含 assistant tool_calls 消息");
  const call = assistant.tool_calls[0];
  assert.equal(call.type, "function", "tool_call 必须带 type: function");
  assert.ok(call.function && typeof call.function === "object", "tool_call 必须带 function 包装");
  assert.equal(call.function.name, "read_file");
  assert.equal(typeof call.function.arguments, "string", "arguments 必须是 JSON 字符串");
  assert.ok(call.function.arguments.includes("OUTLINE.md"), "arguments 字符串应包含调用参数");
  // 工具轮之后终结回复同样要携带最终文本（供助手气泡渲染）。
  const events = await readEvents(h.agent, h.projectRoot);
  const completed = eventsOfType(events, "assistant_message_completed");
  assert.ok(completed.length >= 1, "应产生 assistant_message_completed");
  assert.equal(
    completed[completed.length - 1].payload.text,
    "完成。",
    "assistant_message_completed 必须携带最终回复文本"
  );
});

test("skillCatalog 每 Run 只发现一次（多轮模型轮次共享同一 catalog 记忆）", async (t) => {
  // 回归：Important 4 —— readSkillCatalog 在每个模型轮次的 prompt 装配时都会被
  // 调用；不记忆时两轮模型轮次 = 两次完整 catalog 发现（重读全部 SKILL.md）。
  // 记忆生效时底层 service.catalog 在整个 Run 内只执行一次。
  const h = await openHarness(t, {
    gatewayScript: [
      { reply: { toolCalls: [tool("read_file", { path: "OUTLINE.md" })] } },
      { reply: { text: "完成。" } }
    ]
  });
  let catalogCalls = 0;
  const originalCatalog = h.skills.catalog.bind(h.skills);
  // 计数包装挂在 harness 注入的同一 service 对象上（agent 持有同一引用）。
  h.skills.catalog = async ({ projectRoot }) => {
    if (projectRoot === h.projectRoot) catalogCalls += 1;
    return originalCatalog({ projectRoot });
  };
  await h.agent.submit({ projectRoot: h.projectRoot, text: "读取大纲", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  assert.ok(h.gateway.calls.length >= 2, "应产生至少两轮模型调用");
  assert.equal(catalogCalls, 1, "整个 Run 只发现一次 catalog（两轮轮次共享记忆）");
});

test("Provider 正文 token 在模型请求完成前进入 assistant_message_delta", async (t) => {
  let modelCompleted = false;
  const h = await openHarness(t, {
    gatewayScript: [async (request) => {
      assert.equal(request.stream, true, "Agent 模型轮次应显式启用 Provider 流式响应");
      assert.equal(typeof request.metadata?.onToken, "function");
      request.metadata.onToken("真");
      await sleep(120);
      request.metadata.onToken("实");
      await sleep(120);
      modelCompleted = true;
      return { text: "真实" };
    }],
    gatewayDelayMs: 0
  });

  await h.agent.submit({ projectRoot: h.projectRoot, text: "测试真实流式", source: "chat" });
  const during = await waitFor(
    h.agent,
    h.projectRoot,
    (_session, snapshot) => eventsOfType(snapshot.events, "assistant_message_delta").length > 0,
    { describe: "模型请求完成前收到正文增量" }
  );

  assert.equal(modelCompleted, false, "delta 必须来自在途 Provider token，不能等最终文本返回后再补发");
  assert.equal(eventsOfType(during.events, "assistant_message_delta")[0].payload.text, "真");

  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "assistant_message_delta").map((event) => event.payload.text).join(""), "真实");
  assert.equal(eventsOfType(events, "assistant_message_completed").at(-1).payload.text, "真实");
});

test("OpenAI-compatible SSE 经 Gateway 与 ProjectAgent 实时到达 journal", async (t) => {
  const fixture = await createProjectAgentHarness({
    project: {
      active_model: {
        provider: "openai-compatible",
        model_name: "integration-model",
        base_url: "https://provider.test/v1"
      }
    }
  });
  t.after(() => fixture.cleanup());

  const encoder = new TextEncoder();
  let providerFinished = false;
  const { createOpenAICompatibleAdapter } = await import("../../src/core/model/openai-compatible.mjs");
  const { createModelGateway } = await import("../../src/core/model/gateway.mjs");
  const { createProjectAgent } = await import("../../src/core/agent/index.mjs");
  const adapter = createOpenAICompatibleAdapter({
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.stream, true);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"直"}}]}\n\n'));
            setTimeout(() => {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"连"},"finish_reason":"stop"}]}\n\n'));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              providerFinished = true;
              controller.close();
            }, 140);
          }
        }),
        async text() {
          throw new Error("流式路径不应读取 response.text()");
        }
      };
    }
  });
  const gateway = createModelGateway({ adapter, retryMax: 0 });
  const agent = createProjectAgent({ modelGateway: gateway });
  await agent.open({ projectRoot: fixture.projectRoot });

  await agent.submit({ projectRoot: fixture.projectRoot, text: "验证纵向流式", source: "chat" });
  const during = await waitFor(
    agent,
    fixture.projectRoot,
    (_session, snapshot) => eventsOfType(snapshot.events, "assistant_message_delta").length > 0,
    { describe: "SSE 首 token 到达 journal" }
  );
  assert.equal(providerFinished, false, "首段 journal delta 必须早于 SSE 完成");
  assert.equal(eventsOfType(during.events, "assistant_message_delta")[0].payload.text, "直");

  await waitForIdle(agent, fixture.projectRoot);
  const events = await readEvents(agent, fixture.projectRoot);
  assert.equal(eventsOfType(events, "assistant_message_delta").map((event) => event.payload.text).join(""), "直连");
  assert.equal(eventsOfType(events, "assistant_message_completed").at(-1).payload.text, "直连");
});

test("流式 finish_reason=length → assistant_message_completed.payload.truncated === true", async (t) => {
  // 端到端桥接链路（Task 4）：adapter 透传 finish_reason → runtime 检测 → 完成事件
  // 带 truncated。usage 帧按 OpenAI 规范跟在 finish_reason 帧之后、[DONE] 之前，
  // 覆盖 Issue 1 的回归面（usage 帧不得把 finish_reason 覆盖成 null）。
  const fixture = await createProjectAgentHarness({
    project: {
      active_model: {
        provider: "openai-compatible",
        model_name: "integration-model",
        base_url: "https://provider.test/v1"
      }
    }
  });
  t.after(() => fixture.cleanup());

  const encoder = new TextEncoder();
  const { createOpenAICompatibleAdapter } = await import("../../src/core/model/openai-compatible.mjs");
  const { createModelGateway } = await import("../../src/core/model/gateway.mjs");
  const { createProjectAgent } = await import("../../src/core/agent/index.mjs");
  const adapter = createOpenAICompatibleAdapter({
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.stream, true);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"正文"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        }),
        async text() {
          throw new Error("流式路径不应读取 response.text()");
        }
      };
    }
  });
  const gateway = createModelGateway({ adapter, retryMax: 0 });
  const agent = createProjectAgent({ modelGateway: gateway });
  await agent.open({ projectRoot: fixture.projectRoot });

  await agent.submit({ projectRoot: fixture.projectRoot, text: "验证截断透传", source: "chat" });
  await waitForIdle(agent, fixture.projectRoot);
  const events = await readEvents(agent, fixture.projectRoot);
  const completed = eventsOfType(events, "assistant_message_completed").at(-1);
  assert.equal(completed.payload.text, "半截正文", "截断后的半截正文作为最终回复文本");
  assert.equal(completed.payload.truncated, true, "finish_reason=length 必须携带 truncated: true");
});

test("流式 finish_reason=stop → assistant_message_completed 不带 truncated", async (t) => {
  const fixture = await createProjectAgentHarness({
    project: {
      active_model: {
        provider: "openai-compatible",
        model_name: "integration-model",
        base_url: "https://provider.test/v1"
      }
    }
  });
  t.after(() => fixture.cleanup());

  const encoder = new TextEncoder();
  const { createOpenAICompatibleAdapter } = await import("../../src/core/model/openai-compatible.mjs");
  const { createModelGateway } = await import("../../src/core/model/gateway.mjs");
  const { createProjectAgent } = await import("../../src/core/agent/index.mjs");
  const adapter = createOpenAICompatibleAdapter({
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.stream, true);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"完整"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        }),
        async text() {
          throw new Error("流式路径不应读取 response.text()");
        }
      };
    }
  });
  const gateway = createModelGateway({ adapter, retryMax: 0 });
  const agent = createProjectAgent({ modelGateway: gateway });
  await agent.open({ projectRoot: fixture.projectRoot });

  await agent.submit({ projectRoot: fixture.projectRoot, text: "验证正常完成", source: "chat" });
  await waitForIdle(agent, fixture.projectRoot);
  const events = await readEvents(agent, fixture.projectRoot);
  const completed = eventsOfType(events, "assistant_message_completed").at(-1);
  assert.equal(completed.payload.text, "完整", "正常完成时正文完整");
  assert.equal("truncated" in completed.payload, false, "finish_reason=stop 不得携带 truncated 字段");
});

test("高频 token 合并写入 journal，拼接正文保持完整", async (t) => {
  const tokens = Array.from({ length: 200 }, (_, index) => String(index % 10));
  const text = tokens.join("");
  const h = await openHarness(t, {
    gatewayScript: [async (request) => {
      for (const token of tokens) request.metadata.onToken(token);
      return { text };
    }],
    gatewayDelayMs: 0
  });

  await h.agent.submit({ projectRoot: h.projectRoot, text: "高频流式", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const deltas = eventsOfType(events, "assistant_message_delta");
  assert.ok(deltas.length > 0 && deltas.length < 10, `200 个 token 应被显著合并，实际 ${deltas.length} 条事件`);
  assert.equal(deltas.map((event) => event.payload.text).join(""), text);
  assert.equal(eventsOfType(events, "assistant_message_completed").at(-1).payload.text, text);
});

test("正文 secret 跨 token 边界时增量与 completed 使用同一脱敏结果", async (t) => {
  const secret = "super-secret-token-77";
  const h = await openHarness(t, {
    secrets: [secret],
    gatewayScript: [async (request) => {
      request.metadata.onToken("hello super-secret-to");
      request.metadata.onToken("ken-77 world");
      return { text: `hello ${secret} world` };
    }],
    gatewayDelayMs: 0
  });

  await h.agent.submit({ projectRoot: h.projectRoot, text: "测试脱敏", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const streamed = eventsOfType(events, "assistant_message_delta").map((event) => event.payload.text).join("");
  const completed = eventsOfType(events, "assistant_message_completed").at(-1).payload.text;
  assert.equal(streamed, "hello [REDACTED] world");
  assert.equal(completed, streamed);
  assert.ok(!JSON.stringify(events).includes(secret));
});

test("停止后忽略 Gateway 迟到的正文 token", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [async (request, { signal }) => {
      request.metadata.onToken("停止前");
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => request.metadata.onToken("迟到内容"), 20);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
      return { text: "不可达" };
    }],
    gatewayDelayMs: 0
  });

  await h.agent.submit({ projectRoot: h.projectRoot, text: "开始后停止", source: "chat" });
  await waitFor(
    h.agent,
    h.projectRoot,
    (_session, snapshot) => eventsOfType(snapshot.events, "assistant_message_delta").length > 0,
    { describe: "停止前正文 token" }
  );
  await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
  await sleep(60);

  const events = await readEvents(h.agent, h.projectRoot);
  const streamed = eventsOfType(events, "assistant_message_delta").map((event) => event.payload.text).join("");
  assert.equal(streamed, "停止前");
  assert.ok(!streamed.includes("迟到内容"));
});

test("非流式 Gateway 只产生 completed，不把最终正文二次切块", async (t) => {
  const longText = "长回复".repeat(40) + "结尾";
  const h = await openHarness(t, {
    gatewayScript: [{ reply: { text: longText } }]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "写长一点", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const deltas = eventsOfType(events, "assistant_message_delta");
  assert.equal(deltas.length, 0, "没有 Provider token 回调时不得制造伪流式事件");
  const completed = eventsOfType(events, "assistant_message_completed");
  assert.ok(completed.length >= 1, "应产生 assistant_message_completed");
  assert.equal(completed[completed.length - 1].payload.text, longText);
});

test("工具调用后的新模型轮次重置临时正文，只保留最终答复", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async (request) => {
        request.metadata.onToken("正在读取资料……");
        return {
          text: "正在读取资料……",
          toolCalls: [tool("read_file", { path: "OUTLINE.md" })]
        };
      },
      async (request) => {
        request.metadata.onToken("这是最终答复。");
        return { text: "这是最终答复。" };
      }
    ],
    gatewayDelayMs: 0
  });

  await h.agent.submit({ projectRoot: h.projectRoot, text: "读取后回答", source: "chat" });
  const snapshot = await waitForIdle(h.agent, h.projectRoot);

  assert.equal(snapshot.session.active_run.assistant_text, "这是最终答复。");
  const completed = eventsOfType(snapshot.events, "assistant_message_completed");
  assert.equal(completed.at(-1).payload.text, "这是最终答复。");
});

test("运行中 submit 进入 FIFO 队列，不创建第二个 Run", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      { reply: { text: "第一条。" } },
      { reply: { text: "第二条。" } },
      { reply: { text: "第三条。" } }
    ],
    gatewayDelayMs: 40
  });
  const first = await h.agent.submit({ projectRoot: h.projectRoot, text: "A", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "B", source: "chat" });
  const result = await h.agent.submit({ projectRoot: h.projectRoot, text: "C", source: "chat" });
  assert.equal(result.queued, true, "运行中提交应排队");
  assert.equal(result.run_id, first.run_id, "排队不得创建新 Run");
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.queued_inputs.length, 2);
  assert.deepEqual(session.queued_inputs.map((item) => item.text), ["B", "C"], "FIFO 保持发送顺序");
  assert.equal(session.queued_inputs[0].status, "queued");
  assert.ok(!Number.isNaN(Date.parse(session.queued_inputs[0].queued_at)));

  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const queued = eventsOfType(events, "input_queued");
  const completed = eventsOfType(events, "input_completed");
  assert.equal(completed.length, 3);
  // 每条输入恰好一个终态事件（Task 9：input_started 激活 + input_completed 收敛，
  // 顺序与 queued 一致）
  assert.equal(completed[0].payload.input_id, queued[0].payload.input_id);
  assert.equal(completed[1].payload.input_id, queued[1].payload.input_id);
  assert.equal(completed[2].payload.input_id, queued[2].payload.input_id);
  assert.equal(eventsOfType(events, "run_started").length, 1, "全程只有一个 Run");
  assertActivityClosure(events);
});

test("open() 幂等：重复 open 不创建会话（惰性），提交后恰好一个 Session 且 Run 正常完成", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "好。" } }] });
  // Task 4 惰性创建：品牌新项目 open（含重复 open）不物化会话、不产生会话条目
  const before = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(before.sessions.length, 0, "open 后无会话条目");
  await h.agent.open({ projectRoot: h.projectRoot });
  const after = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(after.sessions.length, 0, "重复 open 不创建会话");
  const snap = await h.agent.snapshot({ projectRoot: h.projectRoot });
  assert.equal(snap.session, null, "无会话快照为空");
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "session_created").length, 1);
  assert.equal(eventsOfType(events, "run_completed").length, 1);
});

test("open() 恢复运行中的 Run：运行中重复 open 不产生第二个模型循环", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      { reply: { text: "第一条。" } },
      { reply: { text: "第二条。" } }
    ],
    gatewayDelayMs: 60
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "A", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "B", source: "chat" });
  const running = await readSession(h.agent, h.projectRoot);
  assert.equal(running.status, "running");
  // 运行中再次 open：恢复守卫不得启动第二个循环
  await h.agent.open({ projectRoot: h.projectRoot });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_completed").length, 1);
  assert.equal(eventsOfType(events, "model_turn_started").length, 2, "重复 open 不得产生额外模型轮次");
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// 立即（promote）
// ---------------------------------------------------------------------------

test("promote 保持同一 Run id，立即优先处理被提升输入且剩余输入保持顺序", async (t) => {
  const h = await openHarness(t, {
    project: { tool_permissions: { yolo: true } },
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000, purpose: "忙碌" })] } },
      { reply: { text: "优先处理第二条。" } },
      { reply: { text: "继续处理第一条。" } }
    ],
    gatewayDelayMs: 40
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第一条", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第二条", source: "chat" });
  const before = await readSession(h.agent, h.projectRoot);
  const runId = before.active_run.id;
  const queued = before.queued_inputs[0];
  assert.ok(queued, "第二条应排队");

  await h.agent.promote({ projectRoot: h.projectRoot, inputId: queued.id });
  const after = await readSession(h.agent, h.projectRoot);
  assert.equal(after.active_run.id, runId, "promote 不得创建新 Run");
  assert.equal(after.active_run.active_input_id, queued.id, "活动输入应切换为被提升输入");

  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const interrupts = eventsOfType(events, "interrupt_requested");
  const promoted = eventsOfType(events, "input_promoted");
  assert.equal(promoted.length, 1);
  const interruptIndex = events.findIndex((event) => event.type === "interrupt_requested");
  const promotedIndex = events.findIndex((event) => event.type === "input_promoted");
  assert.ok(interrupts.length >= 1 && interruptIndex < promotedIndex, "interrupt_requested 先于 input_promoted（同批次原子）");
  assert.ok(eventsOfType(events, "interrupt_safe_point_reached").length >= 1, "必须到达中断安全点");
  assert.equal(eventsOfType(events, "run_completed").length, 1);
  assert.equal(eventsOfType(events, "run_completed")[0].run_id, runId);
  const texts = h.gateway.calls.map((call) => JSON.stringify(call.request));
  const firstB = texts.findIndex((text) => text.includes("第二条"));
  const lastA = texts.map((text) => text.includes("第一条")).lastIndexOf(true);
  assert.ok(firstB >= 0 && lastA >= 0 && firstB < lastA, "被提升输入应先于被打断输入被处理");
  assertActivityClosure(events);
});

test("promote 校验排队输入：非排队/未知输入一律拒绝", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "好。" } }] });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "A", source: "chat" });
  await assert.rejects(
    () => h.agent.promote({ projectRoot: h.projectRoot, inputId: "ghost-input" }),
    /不在排队队列中/
  );
  await waitForIdle(h.agent, h.projectRoot);
  // 空闲（无活动 Run）时 promote 拒绝
  await assert.rejects(
    () => h.agent.promote({ projectRoot: h.projectRoot, inputId: "ghost-input" }),
    /没有可打断的活动 Run/
  );
});

// ---------------------------------------------------------------------------
// 停止
// ---------------------------------------------------------------------------

test("stop 取消当前 Run 并取消全部未消费输入；之后 submit 创建新 Run", async (t) => {
  const h = await openHarness(t, {
    project: { tool_permissions: { yolo: true } },
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000, purpose: "忙碌" })] } },
      { reply: { text: "完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "任务一", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "任务二", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (session, snap) =>
    eventsOfType(snap.events, "tool_call_started").length >= 1
  );
  const runId = (await readSession(h.agent, h.projectRoot)).active_run.id;
  await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const cancelled = eventsOfType(events, "run_cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].run_id, runId);
  assert.equal(cancelled[0].payload.reason, "user_stop");
  assert.equal(eventsOfType(events, "run_completed").length, 0);
  const inputCancelled = eventsOfType(events, "input_cancelled");
  assert.equal(inputCancelled.length, 2, "活动输入与排队输入都应取消");
  assertActivityClosure(events);

  // 停止后提交创建全新 Run
  const again = await h.agent.submit({ projectRoot: h.projectRoot, text: "新任务", source: "chat" });
  assert.equal(again.queued, false);
  assert.notEqual(again.run_id, runId);
  await waitForIdle(h.agent, h.projectRoot);
});

test("stop 清除全部 grant（permission_grant_cleared）", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "grant.txt"), content: "授权写入" })]
      }),
      { reply: { text: "写完。" } }
    ],
    gatewayDelayMs: 80
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "写入授权文件", source: "chat" });
  const decision = await waitForDecision(h.agent, h.projectRoot, 1);
  await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision.payload.decision_id, choice: "allow_input" });
  await waitFor(h.agent, h.projectRoot, (session, snap) =>
    eventsOfType(snap.events, "permission_grant_created").length >= 1
  );
  await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.ok(eventsOfType(events, "permission_grant_created").length >= 1, "allow_input 应创建 grant");
  assert.ok(eventsOfType(events, "permission_grant_cleared").length >= 1, "停止应清除 grant");
  assert.equal(eventsOfType(events, "run_cancelled").length, 1);
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

test("retry 用 transcript 继续同一 failed Run，完成后保持同一 id", async (t) => {
  const modelError = new Error("provider outage");
  modelError.code = "model_error";
  const h = await openHarness(t, {
    gatewayScript: [
      async (request) => {
        // 第一轮应包含用户原文
        assert.ok(JSON.stringify(request).includes("写一段话"));
        throw modelError;
      },
      async (request) => {
        // 重试轮次应复用 transcript 历史（用户消息仍可见）
        assert.ok(JSON.stringify(request).includes("写一段话"));
        return { text: "恢复成功。" };
      }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "写一段话", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const failed = eventsOfType(await readEvents(h.agent, h.projectRoot), "run_failed");
  assert.equal(failed.length, 1);
  const runId = failed[0].run_id;
  assert.equal(failed[0].payload.code, "model_error");
  assert.ok(failed[0].payload.input_id, "run_failed 应记录未终结输入");

  await h.agent.retry({ projectRoot: h.projectRoot, runId });
  const resumed = await readSession(h.agent, h.projectRoot);
  assert.equal(resumed.active_run.id, runId, "retry 必须恢复同一个 Run");
  assert.equal(resumed.active_run.status, "running");
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_completed").length, 1);
  assert.equal(eventsOfType(events, "run_completed")[0].run_id, runId);
  assert.equal(eventsOfType(events, "run_started").length, 2, "retry 是同 id 的第二次 run_started");
  assertActivityClosure(events);
});

test("retry 校验：运行中的 Run、未知 Run、已 completed 的 Run 一律拒绝", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      { reply: { text: "第一。" } },
      { reply: { text: "第二。" } }
    ],
    gatewayDelayMs: 60
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "A", source: "chat" });
  const running = await readSession(h.agent, h.projectRoot);
  await assert.rejects(
    () => h.agent.retry({ projectRoot: h.projectRoot, runId: running.active_run.id }),
    /无需重试/
  );
  await assert.rejects(
    () => h.agent.retry({ projectRoot: h.projectRoot, runId: "ghost-run" }),
    /不是当前会话的 Run|没有可恢复的 Run/
  );
  await waitForIdle(h.agent, h.projectRoot);
  await assert.rejects(
    () => h.agent.retry({ projectRoot: h.projectRoot, runId: running.active_run.id }),
    /只有 failed\/interrupted/
  );
});

// ---------------------------------------------------------------------------
// 并发
// ---------------------------------------------------------------------------

test("同一项目同一时刻只有一个模型轮次", async (t) => {
  const h = await openHarness(t, {
    project: { tool_permissions: { yolo: true } },
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000, purpose: "忙碌" })] } },
      { reply: { text: "第一条完成。" } },
      { reply: { text: "第二条完成。" } }
    ],
    gatewayDelayMs: 120
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第一条", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第二条", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  assert.ok(h.gateway.calls.length >= 2);
  const sorted = [...h.gateway.calls].sort((a, b) => a.startedAt - b.startedAt);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(
      sorted[i].startedAt >= sorted[i - 1].finishedAt,
      `同一项目模型轮次不得并发：call ${i - 1} 与 call ${i} 时间重叠`
    );
  }
});

test("串行活动契约：reasoning 与工具调用永不同时非空，且同一时刻最多一个工具", async (t) => {
  // 冻结当前 Runtime 的串行事实（Task 4 Step 6）：一个 reasoning turn + 两个
  // tool call 的完整事件序列中，openReasoning 与 openTools 永不同时非空，且
  // openTools.size <= 1。这证明 UI 默认只应出现一个动效；未来若 Runtime 真正
  // 改成并行工具，必须先显式修改这条 Runtime 契约测试，再允许 UI 的双工具
  // 动效分支被生产触发。
  const h = await openHarness(t, {
    gatewayScript: [
      async (request) => {
        request.metadata.onReasoningToken("先检查事实，");
        request.metadata.onReasoningToken("再决定步骤。");
        return { toolCalls: [tool("read_file", { path: "OUTLINE.md" })] };
      },
      async () => ({ toolCalls: [tool("list_files", { path: h.projectRoot })] }),
      { reply: { text: "完成。" } }
    ],
    gatewayDelayMs: 0
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "串行验证", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);

  const events = await readEvents(h.agent, h.projectRoot);
  const openReasoning = new Set();
  const openTools = new Set();
  const assertSerial = () => {
    assert.ok(
      openReasoning.size === 0 || openTools.size === 0,
      "reasoning 与工具调用不得同时非空"
    );
    assert.ok(openTools.size <= 1, "当前实现同一时刻最多一个工具");
  };
  for (const event of events) {
    if (event.type === "reasoning_delta") {
      openReasoning.add(event.payload.turn_id);
    } else if (event.type === "reasoning_completed") {
      openReasoning.delete(event.payload.turn_id);
    } else if (event.type === "tool_call_started") {
      openTools.add(event.payload.tool_call_id ?? event.payload.id);
    } else if (event.type === "tool_call_completed" || event.type === "tool_call_failed") {
      openTools.delete(event.payload.tool_call_id ?? event.payload.id);
    }
    assertSerial();
  }
  assert.deepEqual([...openReasoning], [], "reasoning 必须收敛");
  assert.deepEqual([...openTools], [], "工具调用必须收敛");
  // 冻结的 v2 turn 生命周期顺序：started -> reasoning_delta* -> reasoning_completed
  // -> model_turn_completed（reasoning 轮次里 reasoning_delta 可被批量合并成一条）。
  const turnLifecycle = events
    .filter((event) =>
      ["model_turn_started", "reasoning_delta", "reasoning_completed", "model_turn_completed"].includes(event.type)
    )
    .map((event) => event.type);
  const firstReasoningDelta = turnLifecycle.indexOf("reasoning_delta");
  const firstReasoningCompleted = turnLifecycle.indexOf("reasoning_completed");
  const firstTurnCompleted = turnLifecycle.indexOf("model_turn_completed");
  assert.ok(firstReasoningDelta !== -1, "reasoning 轮次应产生 reasoning_delta");
  assert.ok(
    turnLifecycle.indexOf("model_turn_started") < firstReasoningDelta,
    "reasoning_delta 必须位于 model_turn_started 之后"
  );
  assert.ok(
    firstReasoningDelta < firstReasoningCompleted && firstReasoningCompleted < firstTurnCompleted,
    "顺序必须为 started -> reasoning_delta* -> reasoning_completed -> model_turn_completed"
  );
});

test("同一 agent 实例下不同项目可并行运行", async (t) => {
  // 一个 agent 实例 + 一个 gateway，两个项目同时跑：模型轮次应时间重叠
  const h1 = await createProjectAgentHarness({ gatewayScript: [] });
  const h2 = await createProjectAgentHarness({ gatewayScript: [] });
  t.after(async () => {
    await h1.cleanup();
    await h2.cleanup();
  });
  const gateway = createMockModelGateway({ script: [{ reply: { text: "并行回复" } }], delayMs: 350 });
  const { createProjectAgent } = await import("../../src/core/agent/index.mjs");
  const agent = createProjectAgent({ modelGateway: gateway });
  await agent.open({ projectRoot: h1.projectRoot });
  await agent.open({ projectRoot: h2.projectRoot });
  await Promise.all([
    agent.submit({ projectRoot: h1.projectRoot, text: "项目一任务", source: "chat" }),
    agent.submit({ projectRoot: h2.projectRoot, text: "项目二任务", source: "chat" })
  ]);
  await Promise.all([
    waitForIdle(agent, h1.projectRoot),
    waitForIdle(agent, h2.projectRoot)
  ]);
  const calls = gateway.calls;
  assert.ok(calls.length >= 2, "两个项目都应产生模型轮次");
  const call1 = calls.find((call) => JSON.stringify(call.request).includes("项目一任务"));
  const call2 = calls.find((call) => JSON.stringify(call.request).includes("项目二任务"));
  assert.ok(call1 && call2, "两个项目的请求都应携带各自输入");
  const overlap = call1.startedAt <= call2.finishedAt && call2.startedAt <= call1.finishedAt;
  assert.ok(overlap, "不同项目的模型轮次应并发（时间重叠）");
});

test("工具调用与读取结果只瞬时提供给模型，持久 transcript/journal 不泄漏", async (t) => {
  const SECRET = "super-secret-token-77";
  const PRIVATE_CONTENT = "尚未公开的正文内容-42";
  let secretPath = null;
  const h = await openHarness(t, {
    secrets: [SECRET],
    gatewayScript: [
      async () => ({ toolCalls: [tool("read_file", { path: secretPath })] }),
      async (request) => {
        assert.ok(JSON.stringify(request).includes(PRIVATE_CONTENT), "下一模型轮次仍应收到完整读取结果");
        return { text: "读取完成。" };
      }
    ]
  });
  secretPath = path.join(h.projectRoot, `${SECRET}.md`);
  await fs.writeFile(secretPath, PRIVATE_CONTENT, "utf8");
  const submitted = await h.agent.submit({ projectRoot: h.projectRoot, text: "读取指定文件", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);

  const transcriptRaw = await fs.readFile(
    path.join(h.agentRoot, "sessions", submitted.session_id, "segments", "transcript", "00000001.jsonl"),
    "utf8"
  );
  assert.ok(!transcriptRaw.includes(SECRET), "transcript 不得保存工具参数中的 secret");
  assert.ok(!transcriptRaw.includes(PRIVATE_CONTENT), "transcript 不得保存 read_file 全文");
  const eventRaw = JSON.stringify(await readEvents(h.agent, h.projectRoot));
  assert.ok(!eventRaw.includes(SECRET), "journal 事件不得保存工具参数中的 secret");
  assert.ok(!eventRaw.includes(PRIVATE_CONTENT), "tool_call_completed 不得保存 read_file 全文");
});

// ---------------------------------------------------------------------------
// Visible Plan
// ---------------------------------------------------------------------------

test("update_plan 存入 journal 并反映在 Session projection", async (t) => {
  const plan = {
    explanation: "先核对已完成章节",
    items: [
      { id: "check", step: "检查已有章节", status: "in_progress" },
      { id: "fix", step: "修正冲突", status: "pending" },
      { id: "verify", step: "验证修改", status: "pending" }
    ]
  };
  const finalPlan = {
    explanation: "先核对已完成章节",
    items: [
      { id: "check", step: "检查已有章节", status: "completed" },
      { id: "fix", step: "修正冲突", status: "completed" },
      { id: "verify", step: "验证修改", status: "completed" }
    ]
  };
  const h = await openHarness(t, {
    gatewayScript: [
      { reply: { toolCalls: [tool("update_plan", plan)] } },
      { reply: { toolCalls: [tool("update_plan", finalPlan)] } },
      { reply: { text: "全部完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "检查并修正章节冲突", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (session) => session.active_run?.visible_plan?.items?.length === 3);
  const mid = await readSession(h.agent, h.projectRoot);
  assert.ok(mid.active_run.visible_plan, "运行中应有可见计划");
  assert.equal(mid.active_run.visible_plan.explanation, "先核对已完成章节");

  await waitForIdle(h.agent, h.projectRoot);
  const updates = eventsOfType(await readEvents(h.agent, h.projectRoot), "plan_updated");
  assert.equal(updates.length, 2);
  assert.ok(updates[updates.length - 1].payload.items.every((item) => item.status === "completed"));
  assertActivityClosure(await readEvents(h.agent, h.projectRoot));
});

test("简单任务不产生计划（未调用 update_plan 时无 plan 输出）", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "简单回答。" } }] });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.active_run.visible_plan, null, "简单运行不要求计划");
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "plan_updated").length, 0);
});

// ---------------------------------------------------------------------------
// 权限、确认与授权
// ---------------------------------------------------------------------------

test("普通写入暂停等待确认；拒绝后不落盘且 Run 继续", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "denied.txt"), content: "不应出现" })]
      }),
      { reply: { text: "好的，不写。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "写入一个文件", source: "chat" });
  const decision = await waitForDecision(h.agent, h.projectRoot, 1);
  const waiting = await readSession(h.agent, h.projectRoot);
  assert.equal(waiting.status, "waiting_user");
  assert.equal(waiting.active_run.status, "waiting_user");

  await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision.payload.decision_id, choice: "deny" });
  await waitForIdle(h.agent, h.projectRoot);
  assert.equal(await pathExists(path.join(h.projectRoot, "denied.txt")), false, "拒绝后不得写入");
  const events = await readEvents(h.agent, h.projectRoot);
  assert.ok(eventsOfType(events, "decision_resolved").some((event) => event.payload.choice === "deny"));
  assert.ok(eventsOfType(events, "tool_call_failed").some((event) => event.payload.error === "permission_denied"));
  assertActivityClosure(events);
});

test("allow_input 授权绑定当前输入，不跨入下一条排队输入", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "a.txt"), content: "A 内容" })]
      }),
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "b.txt"), content: "B 内容" })]
      }),
      { reply: { text: "第一条输入完成。" } },
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "c.txt"), content: "C 内容" })]
      }),
      { reply: { text: "第二条输入完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "先写入 A 和 B", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "再写入 C", source: "chat" });

  const decision1 = await waitForDecision(h.agent, h.projectRoot, 1);
  await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision1.payload.decision_id, choice: "allow_input" });
  const decision2 = await waitForDecision(h.agent, h.projectRoot, 2);
  assert.notEqual(decision2.payload.input_id, decision1.payload.input_id, "下一条输入必须重新请求确认");
  await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision2.payload.decision_id, choice: "allow" });
  await waitForIdle(h.agent, h.projectRoot);

  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    assert.equal(await pathExists(path.join(h.projectRoot, name)), true, `${name} 应已写入`);
  }
  const events = await readEvents(h.agent, h.projectRoot);
  const grants = eventsOfType(events, "permission_grant_created");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].payload.input_id, decision1.payload.input_id, "grant 必须绑定活动输入");
  assert.ok(eventsOfType(events, "permission_grant_cleared").length >= 1, "输入完成应清除 grant");
  assertActivityClosure(events);
});

test("YOLO 跳过普通确认但不跳过 extreme 确认", async (t) => {
  const h = await openHarness(t, {
    project: { tool_permissions: { yolo: true } },
    gatewayScript: [
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "yolo-note.txt"), content: "YOLO 写入" })]
      }),
      { reply: { toolCalls: [tool("shell", { command: EXTREME_COMMAND, timeout_ms: 5000, purpose: "高危" })] } },
      { reply: { text: "完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "写入并执行高危命令", source: "chat" });
  const decision = await waitForDecision(h.agent, h.projectRoot, 1);
  assert.ok(decision.payload.confirmation_text && decision.payload.confirmation_text.length > 0);
  assert.equal(await pathExists(path.join(h.projectRoot, "yolo-note.txt")), true, "YOLO 应放行普通写入");
  await h.agent.decide({
    projectRoot: h.projectRoot,
    decisionId: decision.payload.decision_id,
    choice: decision.payload.confirmation_text
  });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "decision_requested").length, 1, "YOLO 下普通写入不请求确认，extreme 必须确认");
  assert.equal(
    eventsOfType(events, "tool_call_completed").filter((event) => event.payload.name === "shell").length,
    1
  );
  assertActivityClosure(events);
});

test("extreme 确认必须使用当前决策的精确生成文字；历史文字与错误文字拒绝", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: EXTREME_COMMAND, timeout_ms: 5000, purpose: "高危一" })] } },
      { reply: { toolCalls: [tool("shell", { command: EXTREME_COMMAND, timeout_ms: 5000, purpose: "高危二" })] } },
      { reply: { text: "完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "执行两个高危命令", source: "chat" });
  const decision1 = await waitForDecision(h.agent, h.projectRoot, 1);
  const text1 = decision1.payload.confirmation_text;
  await assert.rejects(
    () => h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision1.payload.decision_id, choice: "不匹配的文字" }),
    /不匹配|无法执行/
  );
  await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision1.payload.decision_id, choice: text1 });

  const decision2 = await waitForDecision(h.agent, h.projectRoot, 2);
  const text2 = decision2.payload.confirmation_text;
  assert.ok(text2 && text2 !== text1, "每次 extreme 动作必须生成全新确认文字");
  await assert.rejects(
    () => h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision2.payload.decision_id, choice: text1 }),
    /不匹配|无法执行/
  );
  await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision2.payload.decision_id, choice: text2 });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "decision_resolved").length, 2);
  // 已终结 decision 不得再次生效
  await assert.rejects(
    () => h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision1.payload.decision_id, choice: text1 }),
    /已终结|不存在|过期/
  );
  assertActivityClosure(events);
});

test("promote 抢占待决决策：决策作废（cancelled）且被提升输入继续执行", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "a.txt"), content: "A 内容" })]
      }),
      { reply: { text: "第二条完成。" } },
      async () => ({
        toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "a.txt"), content: "A 内容修订" })]
      }),
      { reply: { text: "第一条完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "写入 A", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第二条", source: "chat" });
  const decision1 = await waitForDecision(h.agent, h.projectRoot, 1);
  const waiting = await readSession(h.agent, h.projectRoot);
  assert.equal(waiting.status, "waiting_user");
  const queued = waiting.queued_inputs[0];

  await h.agent.promote({ projectRoot: h.projectRoot, inputId: queued.id });
  // 被抢占决策已终态：旧 decide 一律拒绝
  await assert.rejects(
    () => h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision1.payload.decision_id, choice: "allow" }),
    /已终结|不存在|过期/
  );
  const decision2 = await waitForDecision(h.agent, h.projectRoot, 2);
  assert.equal(decision2.payload.input_id, decision1.payload.input_id, "重新处理被打断输入时应重新请求确认");
  await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision2.payload.decision_id, choice: "allow" });
  await waitForIdle(h.agent, h.projectRoot);
  assert.equal(await pathExists(path.join(h.projectRoot, "a.txt")), true);
  const events = await readEvents(h.agent, h.projectRoot);
  const resolved = eventsOfType(events, "decision_resolved");
  assert.equal(resolved.length, 2);
  assert.ok(resolved.some((event) => event.payload.choice === "cancelled"), "被抢占决策应收敛为 cancelled");
  assert.equal(eventsOfType(events, "run_completed").length, 1);
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// 活动闭环（成功/失败/拒绝/抢占/停止）
// ---------------------------------------------------------------------------

test("活动 id 在成功、失败、拒绝、抢占与停止时闭环", async (t) => {
  // 成功：read_file
  {
    const h = await openHarness(t, {
      gatewayScript: [
        async () => ({
          toolCalls: [tool("read_file", { path: path.join(h.projectRoot, "project.yaml") })]
        }),
        { reply: { text: "读完了。" } }
      ]
    });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "读取配置", source: "chat" });
    await waitForIdle(h.agent, h.projectRoot);
    assert.ok(eventsOfType(await readEvents(h.agent, h.projectRoot), "tool_call_completed").length >= 1);
    assertActivityClosure(await readEvents(h.agent, h.projectRoot));
  }
  // 失败：未知工具 -> tool_call_failed
  {
    const h = await openHarness(t, {
      gatewayScript: [
        { reply: { toolCalls: [{ id: "call_unknown_1", name: "no_such_tool", arguments: {} }] } },
        { reply: { text: "换个方式。" } }
      ]
    });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "调用不存在的工具", source: "chat" });
    await waitForIdle(h.agent, h.projectRoot);
    assert.ok(eventsOfType(await readEvents(h.agent, h.projectRoot), "tool_call_failed").length >= 1);
    assertActivityClosure(await readEvents(h.agent, h.projectRoot));
  }
  // 拒绝：deny -> decision_resolved，文件不落盘
  {
    const h = await openHarness(t, {
      gatewayScript: [
        async () => ({
          toolCalls: [tool("write_file", { path: path.join(h.projectRoot, "no.txt"), content: "x" })]
        }),
        { reply: { text: "好。" } }
      ]
    });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "写入", source: "chat" });
    const decision = await waitForDecision(h.agent, h.projectRoot, 1);
    await h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision.payload.decision_id, choice: "deny" });
    await waitForIdle(h.agent, h.projectRoot);
    assertActivityClosure(await readEvents(h.agent, h.projectRoot));
  }
  // 抢占：promote
  {
    const h = await openHarness(t, {
      project: { tool_permissions: { yolo: true } },
      gatewayScript: [
        { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000, purpose: "忙碌" })] } },
        { reply: { text: "处理第二条。" } },
        { reply: { text: "处理第一条。" } }
      ]
    });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "第一条", source: "chat" });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "第二条", source: "chat" });
    const session = await readSession(h.agent, h.projectRoot);
    await h.agent.promote({ projectRoot: h.projectRoot, inputId: session.queued_inputs[0].id });
    await waitForIdle(h.agent, h.projectRoot);
    assert.equal(eventsOfType(await readEvents(h.agent, h.projectRoot), "input_promoted").length, 1);
    assertActivityClosure(await readEvents(h.agent, h.projectRoot));
  }
  // 停止
  {
    const h = await openHarness(t, {
      project: { tool_permissions: { yolo: true } },
      gatewayScript: [
        { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000, purpose: "忙碌" })] } },
        { reply: { text: "完成。" } }
      ]
    });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "任务", source: "chat" });
    await h.agent.submit({ projectRoot: h.projectRoot, text: "排队任务", source: "chat" });
    await waitFor(h.agent, h.projectRoot, (session, snap) =>
      eventsOfType(snap.events, "tool_call_started").length >= 1
    );
    await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
    await waitForIdle(h.agent, h.projectRoot);
    const events = await readEvents(h.agent, h.projectRoot);
    assert.equal(eventsOfType(events, "run_cancelled").length, 1);
    assert.ok(eventsOfType(events, "input_cancelled").length >= 1);
    assertActivityClosure(events);
  }
});

// ---------------------------------------------------------------------------
// R5-5：截断工具参数拒绝 / 普通截断正文保留展示
// ---------------------------------------------------------------------------

test("R5-5：arguments_complete=false 的工具调用不执行，以 truncated_args_rejected 唯一闭合，Run 继续", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      {
        reply: {
          toolCalls: [
            {
              id: "call_truncated_1",
              name: "write_file",
              arguments: { path: "truncated.txt", content: "不应出现" },
              arguments_complete: false
            }
          ]
        }
      },
      { reply: { text: "好的，参数不完整，我重新规划。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "截断场景", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  // 未进入 ToolRuntime：不产生 tool_call_started，目标文件不得落盘
  assert.equal(eventsOfType(events, "tool_call_started").length, 0, "不完整参数的工具调用不得启动");
  assert.equal(await pathExists(path.join(h.projectRoot, "truncated.txt")), false, "被拒绝的工具不得执行");
  assertActivityClosure(events);
  // Run 继续：下一模型轮次产出最终正文
  const completed = eventsOfType(events, "assistant_message_completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.text, "好的，参数不完整，我重新规划。");
  // transcript：持久化 assistant tool call 恰好一个对应结果（truncated_args_rejected）
  const session = await readSession(h.agent, h.projectRoot);
  const records = await readTranscriptFile(path.join(h.agentRoot, "sessions", session.session_id));
  const results = records.filter((record) => record.role === "tool" && record.tool_call_id === "call_truncated_1");
  assert.equal(results.length, 1, "每个持久化 assistant tool call 必须恰好一个 tool 结果");
  const result = JSON.parse(results[0].content);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "truncated_args_rejected");
  assertNoDanglingToolCalls(records);
});

test("R5-5：max_tokens 截断的普通正文保留 truncated:true 照常展示（不进入拒绝路径）", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [{ reply: { text: "半截正文", raw: { finish_reason: "length" } } }]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "写长文", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const completed = eventsOfType(events, "assistant_message_completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.text, "半截正文", "截断正文仍照常展示");
  assert.equal(completed[0].payload.truncated, true, "正文截断透传 truncated:true");
  assert.equal(eventsOfType(events, "tool_call_started").length, 0, "正文截断不涉及工具调用拒绝");
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// 章节提交
// ---------------------------------------------------------------------------

// Task 12：Agent prompt 只注入技能目录摘要（name/description）；完整 SKILL.md
// 正文只经 read_skill 按需读取。
test("Agent prompt 注入技能目录摘要，完整正文只在 read_skill 结果出现", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async (request) => {
        const system = (request.messages ?? []).find((message) => message.role === "system")?.content ?? "";
        assert.ok(system.includes("[Available Skills]"), "system 应包含技能目录块");
        assert.ok(system.includes("- suspense-chapter-end: "), "目录块包含内置技能 name/description");
        assert.ok(system.includes("每章结尾都要留下悬念钩子"), "目录块包含内置技能 description");
        assert.ok(!system.includes("本章计划必须包含一个结尾悬念钩子"), "目录块不得注入正文 Instructions");
        assert.ok(!system.includes("三连排比堆砌"), "目录块不得注入正文完整示例");
        return { reply: { text: "已读技能目录。" } };
      }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "有哪些技能", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
});

const CHAPTER_CONTENT = `# 第一章 雨夜来信

雨夜，雨声突然变大。林深猛地推开门，冲进老宅的客厅。他浑身湿透，抹了一把脸，低声道：“信上说，老宅的钟会在午夜敲十三下。”烛光下，墙上的照片里竟是多年不见的父亲。他正要细看，门外却传来一阵急促的敲门声。`;

test("章节提交一致更新正式文件、索引、记忆与 checkpoint", async (t) => {
  const h = await openHarness(t, {
    project: { min_words_per_chapter: 50, target_words_per_chapter: 80 },
    gatewayScript: [
      async () => ({
        toolCalls: [
          tool("append_chapter_segment", {
            project_id: h.project.project_id ?? null,
            chapter_no: 1,
            segment_no: 1,
            content: CHAPTER_CONTENT
          })
        ]
      }),
      async () => ({
        toolCalls: [tool("commit_chapter", { project_id: h.project.project_id ?? null, chapter_no: 1 })]
      }),
      { reply: { text: "第一章已完成提交。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "正式写第一章", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.ok(
    eventsOfType(events, "tool_call_completed").some((event) => event.payload.name === "commit_chapter"),
    "commit_chapter 应成功"
  );
  assert.ok(eventsOfType(events, "checkpoint_linked").length >= 1, "提交必须链接 checkpoint");

  const finalPath = path.join(h.projectRoot, "chapters", "001.md");
  assert.equal(await pathExists(finalPath), true);
  assert.ok((await fs.readFile(finalPath, "utf8")).includes("雨夜来信"));
  const index = JSON.parse(await fs.readFile(path.join(h.projectRoot, "memory", "chapter_index.json"), "utf8"));
  const entry = index.chapters.find((chapter) => chapter.chapter_no === 1);
  assert.ok(entry && entry.status === "completed");
  assert.ok(Number(entry.actual_words) >= 50);
  const memory = JSON.parse(await fs.readFile(path.join(h.projectRoot, "memory", "chapter_memory.json"), "utf8"));
  assert.ok(memory.chapters.some((chapter) => chapter.chapter_no === 1));
  const checkpoints = await fs.readdir(path.join(h.projectRoot, "checkpoints"));
  assert.ok(checkpoints.some((name) => name.endsWith(".json")));
  assertActivityClosure(events);
});

test("短章节首次提交即成功：字数/标题/技能 checker 不再拒绝提交", async (t) => {
  // Task 10：commit_chapter 只保留存储安全约束。第一次 commit 就成功，不进入
  // 任何修订/门禁重试路径；Agent 一轮完成章节提交。
  const h = await openHarness(t, {
    project: { min_words_per_chapter: 100, target_words_per_chapter: 120 },
    gatewayScript: [
      async () => ({
        toolCalls: [
          tool("append_chapter_segment", {
            project_id: h.project.project_id ?? null,
            chapter_no: 1,
            segment_no: 1,
            content: "雨夜，一封信。"
          })
        ]
      }),
      async () => ({
        toolCalls: [tool("commit_chapter", { project_id: h.project.project_id ?? null, chapter_no: 1 })]
      }),
      { reply: { text: "第一章提交完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "写满一章", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const failed = eventsOfType(events, "tool_call_failed").filter((event) => event.payload.name === "commit_chapter");
  assert.equal(failed.length, 0, "短章节提交不得失败（无字数/质量门禁）");
  assert.equal(
    eventsOfType(events, "tool_call_completed").filter((event) => event.payload.name === "commit_chapter").length,
    1,
    "首次提交即成功"
  );
  const finalPath = path.join(h.projectRoot, "chapters", "001.md");
  assert.equal(await pathExists(finalPath), true, "正式文件应落盘");
  const index = JSON.parse(await fs.readFile(path.join(h.projectRoot, "memory", "chapter_index.json"), "utf8"));
  const entry = index.chapters.find((chapter) => chapter.chapter_no === 1);
  assert.deepEqual(entry.quality_gate_results, [], "索引不得记录任何门禁结果");
  assert.equal(eventsOfType(events, "run_completed").length, 1, "一轮完成，无修订重试");
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// 统一工具目录（Task 7）：先写章节再问普通问题，同一 Run 同一工具集
// ---------------------------------------------------------------------------

test("先写章节再问普通问题：同一 Run 完成写作与回答，不切换工作流", async (t) => {
  // Task 7 行为验收：章节写作不再需要进入 chapter 工作流；写完章节后同一条
  // Run 直接消费普通问题，工具目录与写作轮完全相同（无 enter_workflow）。
  const h = await openHarness(t, {
    project: { min_words_per_chapter: 50, target_words_per_chapter: 80 },
    gatewayScript: [
      async () => ({
        toolCalls: [
          tool("append_chapter_segment", {
            project_id: h.project.project_id ?? null,
            chapter_no: 1,
            segment_no: 1,
            content: CHAPTER_CONTENT
          })
        ]
      }),
      async () => ({
        toolCalls: [tool("commit_chapter", { project_id: h.project.project_id ?? null, chapter_no: 1 })]
      }),
      async () => ({ text: "第一章已提交。" }),
      async (request) => {
        // 普通问题轮：工具目录与写作轮完全相同（统一目录，无工作流切换）
        const names = (request.tools ?? []).map((def) => def?.function?.name).filter(Boolean);
        for (const deep of ["update_plan", "append_chapter_segment", "commit_chapter"]) {
          assert.ok(names.includes(deep), `普通问题轮也必须暴露 ${deep}`);
        }
        assert.ok(!names.includes("enter_workflow"), "统一目录不得包含 enter_workflow");
        assert.ok(!names.includes("commit_blueprint"), "统一目录不得包含 commit_blueprint");
        return { text: "我是一个本地小说写作助手。" };
      }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "正式写第一章", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你是做什么的？", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_started").length, 1, "写作与普通问题必须共用同一 Run");
  assert.equal(eventsOfType(events, "workflow_changed").length, 0, "统一模式不再产生 workflow_changed");
  assert.ok(
    eventsOfType(events, "tool_call_completed").some((event) => event.payload.name === "commit_chapter"),
    "章节应已提交"
  );
  assert.equal(await pathExists(path.join(h.projectRoot, "chapters", "001.md")), true, "正式章节文件应落盘");
  assert.ok(
    eventsOfType(events, "assistant_message_completed").some((event) => (event.payload?.text ?? "").includes("本地小说写作助手")),
    "普通问题应得到文本回答"
  );
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.active_run.status, "completed");
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// WWRITING.md 项目记忆（Task 6：runtime 每模型轮重新读取）
// ---------------------------------------------------------------------------

test("WWRITING.md 内容注入 system 层；缺失时不出现记忆块且不阻止聊天", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async (request) => {
        // 第一轮：WWRITING.md 尚不存在 -> 不出现 Project Memory 块（缺失不阻止聊天）
        const system = (request.messages ?? []).find((m) => m.role === "system")?.content ?? "";
        assert.ok(!system.includes("[Project Memory: WWRITING.md]"), "缺失的 WWRITING.md 不得出现记忆块");
        await fs.writeFile(
          path.join(h.projectRoot, "WWRITING.md"),
          "# WWriting 项目记忆\n\n- 项目：雨夜小说\n- 当前目标：完成第一章初稿\n",
          "utf8"
        );
        return { toolCalls: [tool("read_file", { path: "OUTLINE.md" })] };
      },
      async (request) => {
        // 第二轮：写入后重新读取 -> 记忆块与正文进入 system
        const system = (request.messages ?? []).find((m) => m.role === "system")?.content ?? "";
        assert.ok(system.includes("[Project Memory: WWRITING.md]"), "写入后应出现 Project Memory 层");
        assert.ok(system.includes("- 项目：雨夜小说"), "记忆正文应进入 system");
        assert.ok(system.includes("- 当前目标：完成第一章初稿"), "记忆正文完整进入 system");
        return { text: "已读取项目记忆。" };
      }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "继续写作", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  assert.equal(await pathExists(path.join(h.projectRoot, "WWRITING.md")), true);
  const events = await readEvents(h.agent, h.projectRoot);
  assertActivityClosure(events);
});

test("两次模型轮之间改写 WWRITING.md，后续轮次 request 必须包含新内容", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async (request) => {
        // 第一轮 prompt 已装配（无记忆）；落盘 v1 供第二轮读取
        await fs.writeFile(
          path.join(h.projectRoot, "WWRITING.md"),
          "# WWriting 项目记忆\n\n- 版本：v1\n",
          "utf8"
        );
        return { toolCalls: [tool("read_file", { path: "OUTLINE.md" })] };
      },
      async (request) => {
        // 第二轮必须读到 v1
        const system = (request.messages ?? []).find((m) => m.role === "system")?.content ?? "";
        assert.ok(system.includes("- 版本：v1"), "第二轮请求必须包含 v1 记忆内容");
        // 模拟用户在两次模型轮之间手工改写 WWRITING.md
        await fs.writeFile(
          path.join(h.projectRoot, "WWRITING.md"),
          "# WWriting 项目记忆\n\n- 版本：v2\n- 新目标：改写第三章\n",
          "utf8"
        );
        return { toolCalls: [tool("read_file", { path: "SETTING.md" })] };
      },
      async (request) => {
        // 第三轮必须读到改写后的 v2（每模型轮重新读取，不依赖上下文残留）
        const system = (request.messages ?? []).find((m) => m.role === "system")?.content ?? "";
        assert.ok(!system.includes("- 版本：v1"), "旧内容不得残留");
        assert.ok(system.includes("- 版本：v2"), "第三轮请求必须包含改写后的 v2 内容");
        assert.ok(system.includes("- 新目标：改写第三章"), "改写内容应在同一轮生效");
        return { text: "已根据最新记忆继续。" };
      }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "继续写作", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "model_turn_started").length, 3, "应有三轮模型轮次");
  assertActivityClosure(events);
});

test("不可读 WWRITING.md（目录占位）不阻止模型轮次", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async (request) => {
        const system = (request.messages ?? []).find((m) => m.role === "system")?.content ?? "";
        assert.ok(!system.includes("[Project Memory: WWRITING.md]"), "不可读记忆不注入，但不阻止 prompt");
        return { text: "继续。" };
      }
    ]
  });
  await fs.mkdir(path.join(h.projectRoot, "WWRITING.md"), { recursive: true });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "继续任务", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_completed").length, 1, "不可读记忆不得导致 Run 失败");
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// /init 初始化技能（Task 7）：维护 WWRITING.md，不生成固定蓝图
// ---------------------------------------------------------------------------

test("/init 在空目录创建 WWRITING.md，不生成固定蓝图", async (t) => {
  const h = await openPlainFolderHarness({
    gatewayScript: [
      { reply: { toolCalls: [tool("list_files", { path: "." })] } },
      { reply: { toolCalls: [tool("write_file", { path: "WWRITING.md", content: VALID_MEMORY })] } },
      { reply: { text: "已建立项目记忆。" } }
    ]
  });
  t.after(() => h.cleanup());
  await h.agent.submit({ projectRoot: h.projectRoot, text: "/init" });
  await waitForIdle(h.agent, h.projectRoot);
  assert.equal(await pathExists(path.join(h.projectRoot, "WWRITING.md")), true);
  for (const name of ["project.yaml", "OUTLINE.md", "SETTING.md", "AGENTS.md"]) {
    assert.equal(await pathExists(path.join(h.projectRoot, name)), false);
  }
});

test("/init 在已有文件目录先读目录与已有记忆，只更新 WWRITING.md", async (t) => {
  const h = await openPlainFolderHarness({
    gatewayScript: [
      { reply: { toolCalls: [tool("list_files", { path: "." })] } },
      { reply: { toolCalls: [tool("read_file", { path: "WWRITING.md" })] } },
      { reply: { toolCalls: [tool("write_file", { path: "WWRITING.md", content: VALID_MEMORY })] } },
      { reply: { text: "已更新项目记忆。" } }
    ]
  });
  t.after(() => h.cleanup());
  // 已有创作文件 + 已有记忆：模型必须读取真实文件，且更新后仍不得生成固定蓝图
  await fs.mkdir(path.join(h.projectRoot, "正文"), { recursive: true });
  await fs.writeFile(path.join(h.projectRoot, "正文", "第001章.md"), "雨夜，信在桌上。\n", "utf8");
  await fs.writeFile(path.join(h.projectRoot, "WWRITING.md"), VALID_MEMORY, "utf8");
  await h.agent.submit({ projectRoot: h.projectRoot, text: "/init" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const toolNames = eventsOfType(events, "tool_call_completed").map((event) => event.payload?.name);
  assert.ok(toolNames.includes("list_files"), "应先读取目录");
  assert.ok(toolNames.includes("read_file"), "应先读取已有记忆");
  assert.ok(toolNames.includes("write_file"), "应写入更新后的 WWRITING.md");
  const readIndex = toolNames.indexOf("read_file");
  const writeIndex = toolNames.indexOf("write_file");
  assert.ok(writeIndex > readIndex, "写记忆前必须先读取已有记忆，不得盲目覆盖");
  assert.equal(await fs.readFile(path.join(h.projectRoot, "WWRITING.md"), "utf8"), VALID_MEMORY, "WWRITING.md 应被更新");
  for (const name of ["project.yaml", "OUTLINE.md", "SETTING.md", "AGENTS.md"]) {
    assert.equal(await pathExists(path.join(h.projectRoot, name)), false, `不得创建固定蓝图 ${name}`);
  }
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// 审计来源与存储
// ---------------------------------------------------------------------------

test("maintenance source 走同一流程且记录审计来源", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "维护完成。" } }] });
  const result = await h.agent.submit({ projectRoot: h.projectRoot, text: "重建章节记忆", source: "maintenance" });
  assert.equal(result.queued, false);
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const queued = eventsOfType(events, "input_queued");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.source, "maintenance", "input_queued 应记录审计来源");
  assert.equal(eventsOfType(events, "run_completed").length, 1);
  assertActivityClosure(events);
});

test("非法 source 与空输入一律拒绝（source 不能绕过权限）", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "好。" } }] });
  await assert.rejects(
    () => h.agent.submit({ projectRoot: h.projectRoot, text: "x", source: "script" }),
    /source 只允许/
  );
  await assert.rejects(
    () => h.agent.submit({ projectRoot: h.projectRoot, text: "   ", source: "chat" }),
    /非空/
  );
  await assert.rejects(
    () => h.agent.submit({ projectRoot: "", text: "x", source: "chat" }),
    /projectRoot/
  );
});

test("新项目不创建旧状态文件，Agent 状态只落在应用私有 agentRoot/sessions/<id>（新分段格式）", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "好。" } }] });
  const result = await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  assert.equal(await pathExists(path.join(h.projectRoot, LEGACY_STATE_FILE)), false);
  assert.equal(await pathExists(path.join(h.projectRoot, ".wwriting", "agent")), false, "新会话不得写回项目内 .wwriting/agent");
  // 多会话布局（Task 4）：journal 落在应用私有 agentRoot/sessions/<id>/ 下。
  // 每会话独立存储根：segments/ + journal-manifest.json + session.json + migration.json
  const sessionDir = path.join(h.agentRoot, "sessions", result.session_id);
  for (const name of ["session.json", "migration.json", "journal-manifest.json"]) {
    assert.equal(await pathExists(path.join(sessionDir, name)), true, `${name} 应落在应用私有 agentRoot/sessions/<id>`);
  }
  assert.equal(await pathExists(path.join(sessionDir, "segments", "events")), true, "segments/events 应存在");
  assert.equal(await pathExists(path.join(sessionDir, "segments", "transcript")), true, "segments/transcript 应存在");
  assert.equal(await pathExists(path.join(h.agentRoot, "events.jsonl")), false, "新项目不得创建单体 events.jsonl");
  assert.equal(await pathExists(path.join(h.agentRoot, "transcript.jsonl")), false, "新项目不得创建单体 transcript.jsonl");
});

test("旧 .wwriting/agent 中间损坏：open() 拒绝迁移但允许新会话（journal 落应用私有目录）", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());
  // 构造中间损坏的旧 journal（seq 1、2 合法，第 3 行损坏，其后还有合法行——
  // 末行半行是崩溃痕迹会被容忍，只有中段损坏才触发拒绝）
  const legacyDir = path.join(h.projectRoot, ".wwriting", "agent");
  await fs.mkdir(legacyDir, { recursive: true });
  const legacyEvents = [
    JSON.stringify({ schema_version: 1, seq: 1, event_id: "e1", session_id: "legacy-s", run_id: null, project_root: h.projectRoot, type: "session_created", at: new Date().toISOString(), payload: {} }),
    JSON.stringify({ schema_version: 1, seq: 2, event_id: "e2", session_id: "legacy-s", run_id: null, project_root: h.projectRoot, type: "input_queued", at: new Date().toISOString(), payload: { input_id: "i1", text: "旧" } }),
    "{broken",
    JSON.stringify({ schema_version: 1, seq: 3, event_id: "e3", session_id: "legacy-s", run_id: null, project_root: h.projectRoot, type: "input_queued", at: new Date().toISOString(), payload: { input_id: "i2", text: "后" } })
  ].join("\n") + "\n";
  await fs.writeFile(path.join(legacyDir, "events.jsonl"), legacyEvents, "utf8");

  await h.agent.open({ projectRoot: h.projectRoot });
  // 惰性创建：open() 不物化会话（损坏的旧数据不被迁移、不产生会话条目）
  const { sessions } = await h.agent.sessions({ projectRoot: h.projectRoot });
  assert.equal(sessions.length, 0, "损坏旧数据不产生会话条目");
  // 首条消息物化新会话：私有目录 sessions/<id>/ 从零创建（迁移被拒、目标目录保持干净）
  const result = await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const sessionDir = path.join(h.agentRoot, "sessions", result.session_id);
  assert.equal(await pathExists(path.join(sessionDir, "journal-manifest.json")), true, "新 journal 落应用私有目录（新分段格式）");
  assert.equal(await pathExists(path.join(sessionDir, "segments", "events")), true, "新 journal 应创建 segments/events");
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "session_created").length, 1, "新会话以私有目录为准");
  assert.equal(await fs.readFile(path.join(legacyDir, "events.jsonl"), "utf8"), legacyEvents, "旧 journal 必须保持字节不变");
});

// ---------------------------------------------------------------------------
// 规格审查修复验证：promote×stop、transcript 闭合、滞留输入、终态结果
// ---------------------------------------------------------------------------

// 读取 transcript 全部记录（新分段格式：segments/transcript/ 下的所有 segment）。
async function readTranscriptFile(agentRoot) {
  const dir = path.join(agentRoot, "segments", "transcript");
  const names = (await fs.readdir(dir).catch(() => [])).filter((name) => /^\d{8}\.jsonl$/u.test(name)).sort();
  const records = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(dir, name), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      records.push(JSON.parse(line));
    }
  }
  return records;
}

// 每条 assistant tool_calls 消息的每个 tool_call_id 之后必须有对应 tool 结果。
function assertNoDanglingToolCalls(records) {
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record?.role !== "assistant" || !Array.isArray(record.tool_calls) || record.tool_calls.length === 0) continue;
    for (const toolCall of record.tool_calls) {
      const id = toolCall?.id ?? toolCall?.tool_call_id ?? null;
      if (id === null) continue;
      const hasResult = records.slice(i + 1).some((item) => item?.role === "tool" && item.tool_call_id === id);
      assert.ok(hasResult, `transcript 存在悬空 tool_calls：${id} 没有对应的 tool 结果`);
    }
  }
}

// prompt messages 里每条 assistant tool_calls 消息的 tool_call_id 之后必须有 tool 结果。
function assertWellFormedHistory(messages) {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;
    for (const toolCall of message.tool_calls) {
      const id = toolCall?.id ?? null;
      if (id === null) continue;
      const hasResult = messages.slice(i + 1).some((item) => item?.role === "tool" && item.tool_call_id === id);
      assert.ok(hasResult, `prompt 历史存在悬空 tool_calls：${id}`);
    }
  }
}

test("stop 后 promote 被拒：stopping 状态上的提升无效且不写入 input_promoted", async (t) => {
  const h = await openHarness(t, {
    project: { tool_permissions: { yolo: true } },
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000, purpose: "忙碌" })] } },
      { reply: { text: "完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "任务一", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "任务二", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (session, snap) =>
    eventsOfType(snap.events, "tool_call_started").length >= 1
  );
  const queued = (await readSession(h.agent, h.projectRoot)).queued_inputs[0];
  // stop 在途中（stub shell 窗口内 Run 处于 stopping）：promote 必须被拒
  const stopPromise = h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
  await assert.rejects(
    () => h.agent.promote({ projectRoot: h.projectRoot, inputId: queued.id }),
    /停止|stopping|没有可打断/
  );
  await stopPromise;
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_cancelled").length, 1, "停止仍应取消 Run");
  assert.equal(eventsOfType(events, "input_promoted").length, 0, "promote 被拒后不得写入 input_promoted");
  assertActivityClosure(events);
});

test("promote 中断后 transcript 无悬空 tool_calls（未执行工具补 cancelled 记录）", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      async () => ({
        toolCalls: [
          tool("write_file", { path: path.join(h.projectRoot, "a.txt"), content: "A" }),
          tool("write_file", { path: path.join(h.projectRoot, "b.txt"), content: "B" })
        ]
      }),
      { reply: { text: "第二条完成。" } },
      { reply: { text: "第一条完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "写入 A 和 B", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第二条", source: "chat" });
  const decision1 = await waitForDecision(h.agent, h.projectRoot, 1);
  const queued = (await readSession(h.agent, h.projectRoot)).queued_inputs[0];
  await h.agent.promote({ projectRoot: h.projectRoot, inputId: queued.id });
  // 被抢占的决策已终态：旧 decide 一律拒绝
  await assert.rejects(
    () => h.agent.decide({ projectRoot: h.projectRoot, decisionId: decision1.payload.decision_id, choice: "allow" }),
    /已终结|不存在|过期/
  );
  await waitForIdle(h.agent, h.projectRoot);
  // 被中断的工具调用链必须完整闭合（工具 1 已执行失败、工具 2 补 cancelled 记录）
  const transcript = await readTranscriptFile(h.agentRoot);
  assertNoDanglingToolCalls(transcript);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_completed").length, 1);
  assertActivityClosure(events);
});

test("retry 时 prompt 历史不含畸形消息（tool_calls 链完整闭合）", async (t) => {
  const modelError = new Error("provider outage");
  modelError.code = "model_error";
  const h = await openHarness(t, {
    gatewayScript: [
      async () => ({
        toolCalls: [tool("read_file", { path: path.join(h.projectRoot, "project.yaml") })]
      }),
      { error: modelError },
      { reply: { text: "恢复成功。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "读取配置", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const runId = eventsOfType(await readEvents(h.agent, h.projectRoot), "run_failed")[0].run_id;
  await h.agent.retry({ projectRoot: h.projectRoot, runId });
  await waitForIdle(h.agent, h.projectRoot);
  const calls = h.gateway.calls;
  for (const call of calls) {
    assertWellFormedHistory(call.request.messages ?? []);
  }
  assert.equal(eventsOfType(await readEvents(h.agent, h.projectRoot), "run_completed").length, 1);
});

// ---------------------------------------------------------------------------
// Task 3：工具错误不杀死 Run；未执行调用唯一闭合；timeout 回给模型；Journal 写失败致命
// ---------------------------------------------------------------------------

test("executor throw → Run 继续；同一响应后续调用以 tool_skipped_after_failure 唯一闭合", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [
      {
        reply: {
          toolCalls: [
            tool("read_file", { path: "missing.md" }),
            tool("read_file", { path: "OUTLINE.md" }),
            tool("list_files", { path: "." })
          ]
        }
      },
      { reply: { text: "已处理工具失败。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "读文件", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);

  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_failed").length, 0, "工具失败不得杀死 Run");
  assert.equal(eventsOfType(events, "run_completed").length, 1, "Run 必须正常完成");
  assert.ok(h.gateway.calls.length >= 2, "工具失败后必须继续下一轮模型调用");
  assertActivityClosure(events);

  // 每个持久化 assistant tool call 恰好一个 tool result（唯一闭合）；第二个与
  // 第三个调用从未启动，以 tool_skipped_after_failure 闭合而非真实执行
  const sessionId = (await readSession(h.agent, h.projectRoot)).session_id;
  const transcript = await readTranscriptFile(path.join(h.agentRoot, "sessions", sessionId));
  const resultCounts = new Map(); // tool_call_id -> tool result 数量
  let failedFirst = null;
  let skippedCount = 0;
  for (const record of transcript) {
    if (record?.role === "assistant") {
      for (const tc of record.tool_calls ?? []) resultCounts.set(tc?.id, 0);
      continue;
    }
    if (record?.role === "tool") {
      resultCounts.set(record.tool_call_id, (resultCounts.get(record.tool_call_id) ?? 0) + 1);
      const parsed = JSON.parse(record.content ?? "{}");
      if (parsed.error?.code === "file_not_found") failedFirst = parsed;
      if (parsed.error?.code === "tool_skipped_after_failure") skippedCount += 1;
    }
  }
  assert.deepEqual([...resultCounts.values()], [1, 1, 1], "3 个调用各恰好 1 个 tool result（不得重复/悬空）");
  assert.ok(failedFirst, "第一个调用应以真实失败结果闭合");
  assert.ok(
    /文件不存在：.+missing\.md/u.test(failedFirst.error.message),
    `失败消息应含解析后的目标路径：${failedFirst.error.message}`
  );
  assert.equal(failedFirst.tool_call_id, [...resultCounts.keys()][0], "失败结果应回传原 tool_call_id");
  assert.equal(skippedCount, 2, "后续两个未启动调用以 tool_skipped_after_failure 闭合");
  assertNoDanglingToolCalls(transcript);
});

test("tool_timeout 结果回给模型后继续下一轮（Run 不被杀死）", async (t) => {
  // 直接经公共 seam 构造 agent：注入毫秒级工具期限，让真实 agent 循环内产生
  // ToolRuntime 的 tool_timeout（harness 固定 5 分钟默认期限，无法在测试内触发）
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-timeout-run-"));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
  const { projectRoot } = await createProjectRoot(workspaceRoot, {
    tool_permissions: { yolo: true }
  });
  const { createWorkspaceStore } = await import("../../src/core/workspaces/store.mjs");
  const { createSkillService } = await import("../../src/core/skills/index.mjs");
  const store = createWorkspaceStore({ stateRoot: path.join(workspaceRoot, "user-data") });
  const skills = createSkillService({
    userHome: path.join(projectRoot, ".test-skill-home"),
    resourcesPath: null
  });
  const gateway = createMockModelGateway({
    script: [
      { reply: { toolCalls: [tool("shell", { command: "hang", timeout_ms: 1000, purpose: "慢命令" })] } },
      { reply: { text: "超时已处理。" } }
    ],
    delayMs: 0
  });
  // 挂起桩：期限 abort 传导后立即收尾（抛 shell_cancelled，executeWithDeadline 按
  // timeout 结论收口）；无 abort 时 3s 兜底收尾，避免实现缺失时测试悬挂
  const shell = async ({ signal } = {}) => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    throw Object.assign(new Error("命令已停止。"), { code: "shell_cancelled", durationMs: 0 });
  };
  const { createProjectAgent } = await import("../../src/core/agent/index.mjs");
  const agent = createProjectAgent({
    modelGateway: gateway,
    shell,
    skills,
    agentStorageRootFor: (root) => store.agentRootFor(root),
    toolIdleTimeoutMs: 60,
    toolAbsoluteTimeoutMs: 5000
  });
  await agent.open({ projectRoot });
  await agent.submit({ projectRoot, text: "执行慢命令", source: "chat" });
  await waitForIdle(agent, projectRoot);

  assert.ok(gateway.calls.length >= 2, "tool_timeout 后必须继续下一轮模型调用");
  assert.ok(
    JSON.stringify(gateway.calls[1].request).includes("tool_timeout"),
    "timeout 结果必须回给模型（下一轮请求历史含 tool_timeout）"
  );
  const events = await readEvents(agent, projectRoot);
  assert.equal(eventsOfType(events, "run_failed").length, 0, "tool_timeout 不得杀死 Run");
  assert.equal(eventsOfType(events, "run_completed").length, 1, "Run 必须正常完成");
  const failed = eventsOfType(events, "tool_call_failed")[0];
  assert.equal(failed.payload.error, "tool_timeout");
  assert.equal(failed.payload.technical.kind, "idle");
  assertActivityClosure(events);
});

test("appendTranscript 失败进入 failRun（Journal 写失败保持致命，不被吞掉）", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "第一次。" } }] });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "第一次", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);

  // 让 transcript segment 存储不可写：目录换成同名文件 → 后续 appendTranscript 必然
  // 失败（ENOTDIR/ENOENT）；events 存储保持可用 → failRun 的 run_failed 仍能落盘
  const session = await readSession(h.agent, h.projectRoot);
  const transcriptRoot = path.join(h.agentRoot, "sessions", session.session_id, "segments", "transcript");
  await fs.rm(transcriptRoot, { recursive: true, force: true });
  await fs.writeFile(transcriptRoot, "broken", "utf8");

  await h.agent.submit({ projectRoot: h.projectRoot, text: "第二次", source: "chat" });
  await waitFor(
    h.agent,
    h.projectRoot,
    (_session, snap) => eventsOfType(snap.events, "run_failed").length >= 1,
    { describe: "appendTranscript 失败后 Run 收敛到 run_failed" }
  );
  const events = await readEvents(h.agent, h.projectRoot);
  const failed = eventsOfType(events, "run_failed").at(-1);
  assert.equal(failed.payload.code, "runtime_error", "appendTranscript 失败必须以 runtime_error 收敛到 failRun");
  assert.equal(failed.payload.input_id, eventsOfType(events, "input_queued").at(-1).payload.input_id);
  const sessionAfter = await readSession(h.agent, h.projectRoot);
  assert.equal(sessionAfter.active_run.status, "failed", "Run 必须进入 failed 终态（session.status 对所有终态统一为 idle）");
  assert.equal(sessionAfter.status, "idle");
});

test("并发 submit 不滞留输入：Run 终结后队列恒为空且全部输入收敛", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [{ reply: { text: "好。" } }],
    gatewayDelayMs: 20
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "首发", source: "chat" });
  // 密集提交洪泛：部分落在运行中（排队），部分可能落在终结窗口——任何情况下
  // 输入都不得滞留跨 Run 边界
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      h.agent.submit({ projectRoot: h.projectRoot, text: `洪泛-${index}`, source: "chat" })
    )
  );
  await waitForIdle(h.agent, h.projectRoot);
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.status, "idle");
  assert.deepEqual(session.queued_inputs, [], "Run 终结后不得滞留排队输入");
  const events = await readEvents(h.agent, h.projectRoot);
  const queued = eventsOfType(events, "input_queued");
  const completed = eventsOfType(events, "input_completed");
  const cancelled = eventsOfType(events, "input_cancelled");
  const withdrawn = eventsOfType(events, "input_withdrawn");
  const interrupted = eventsOfType(events, "input_interrupted");
  assert.equal(queued.length, 13);
  assert.equal(
    completed.length + cancelled.length + withdrawn.length + interrupted.length,
    queued.length,
    "每条输入都必须收敛到恰好一个终态"
  );
  assertActivityClosure(events);
});

test("promote 与 stop 竞态：终态时不误报成功（promoted: false 或明确拒绝）", async (t) => {
  const h = await openHarness(t, {
    project: { tool_permissions: { yolo: true } },
    gatewayScript: [
      { reply: { toolCalls: [tool("shell", { command: "stub", timeout_ms: 30000, purpose: "忙碌" })] } },
      { reply: { text: "完成。" } }
    ]
  });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "任务一", source: "chat" });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "任务二", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (session, snap) =>
    eventsOfType(snap.events, "tool_call_started").length >= 1
  );
  const queued = (await readSession(h.agent, h.projectRoot)).queued_inputs[0];
  // 立即挂 rejection 处理器（避免竞态窗口内的 unhandled rejection）：promote 与
  // stop 并发，任一方先落盘都是合法结果——test 下方同时容忍拒绝与 promoted:false。
  const promotePromise = h.agent.promote({ projectRoot: h.projectRoot, inputId: queued.id }).then(
    (value) => value,
    (error) => ({ rejected: error })
  );
  const stopResult = await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
  assert.equal(stopResult.cancelled, true);
  const promoteResult = await promotePromise;
  if (promoteResult.rejected) {
    assert.match(promoteResult.rejected.message, /停止|没有可打断/, "stopping 预检查或终态拒绝");
  } else {
    assert.equal(typeof promoteResult.promoted, "boolean");
    if (promoteResult.promoted === false) {
      assert.ok(["terminal", "gone"].includes(promoteResult.reason), "promoted:false 必须带终态原因");
    }
  }
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_cancelled").length, 1, "stop 必须生效");
  assertActivityClosure(events);
});

// ---------------------------------------------------------------------------
// 其他公共接口校验
// ---------------------------------------------------------------------------

test("snapshot 支持 afterSeq/limit 分页", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "好。" } }] });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const full = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
  const page = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: full.events.length - 1, limit: 1 });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].seq, full.events.length);
  assert.equal(page.session.last_seq, full.events.length);
  const empty = await h.agent.snapshot({ projectRoot: h.projectRoot, afterSeq: full.events.length, limit: 10 });
  assert.equal(empty.events.length, 0);
});

test("promote/stop 在 Run 终结后的竞态不悬挂（幂等拒绝或安全返回）", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "好。" } }] });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "任务", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  // 空闲时 stop 安全无操作
  const stopped = await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
  assert.equal(stopped.cancelled, false);
  // 空闲时 promote 拒绝
  await assert.rejects(
    () => h.agent.promote({ projectRoot: h.projectRoot, inputId: "ghost" }),
    /没有可打断的活动 Run/
  );
});

// ---------------------------------------------------------------------------
// Task 8：上下文压缩运行时集成（自动门禁、/compact、取消/重试、重启恢复）
// ---------------------------------------------------------------------------

function validCompactionSummary() {
  return {
    schema_version: 1,
    current_task: "完成第三章初稿",
    user_confirmed_decisions: ["主角改名为林默"],
    verified_facts: ["林默 17 岁"],
    files_and_artifacts: ["chapters/003.md"],
    completed_steps: ["拟定第三章大纲"],
    pending_steps: ["写完第三章结尾"],
    pending_decisions: ["第三章是否保留梦境场景"],
    failures_and_recovery: [],
    open_tool_calls: [],
    recent_user_intent: "继续写第三章",
    omitted_information: [],
    reload_from_workspace: ["WWRITING.md"]
  };
}

// 达到 256k 档发送前压缩阈值（204_800）且低于硬窗口（224_000）的待发送文本；
// 系统层开销约 3-5k tokens，195_000 CJK 字符估算 ≈ 214k（含 1.08 安全系数）。
const AUTO_COMPACT_INPUT = "汉".repeat(195_000);
// 压缩后仍超过硬窗口（估算 + 32_000 输出余量 ≥ 256_000）的输入。
const OVER_HARD_WINDOW_INPUT = "汉".repeat(240_000);

// 逐轮播种 transcript（/compact 与自动压缩需要 >12 轮历史才非 noop）。
async function seedTurns(h, count) {
  for (let i = 0; i < count; i += 1) {
    await h.agent.submit({ projectRoot: h.projectRoot, text: `第 ${i} 轮输入`, source: "chat" });
    await waitForIdle(h.agent, h.projectRoot);
  }
}

function compactionAwareEntry(compactionReply, normalReply) {
  return (request) => {
    if (request.metadata?.stage === "context_compaction") {
      if (typeof compactionReply === "function") return compactionReply(request);
      return { text: JSON.stringify(compactionReply) };
    }
    if (typeof normalReply === "function") return normalReply(request);
    return { text: normalReply };
  };
}

function compactionSummaryScript({ count = 40, compactionReply = validCompactionSummary(), normalReply = "正常回复。" } = {}) {
  return Array.from({ length: count }, () => compactionAwareEntry(compactionReply, normalReply));
}

// C1 修复：预置 transcript（在 session journal 首次 load 之前直接写入
// sessions/<id>/segments/transcript，避免逐轮 submit 的成本）。写入极短轮次记录——
// 8005 条估算约 111k tokens，远低于 204_800 软阈值：估算门禁永远不触发，只有
// "尾部页溢出"门禁能触发首压。多会话布局下必须先 newSession 拿到 sessionId，
// 预置进该会话目录（journal 首次 load 前写入，store 才能在 load 时读到）。
async function seedTranscriptRecords(h, count, content = "一", sessionId) {
  const { createJournalSegmentStore } = await import("../../src/core/agent/journal-segments.mjs");
  const sessionDir = path.join(h.agentRoot, "sessions", sessionId);
  const root = path.join(sessionDir, "segments", "transcript");
  const store = createJournalSegmentStore({
    root,
    streamName: "transcript",
    manifestPath: path.join(sessionDir, "journal-manifest.json")
  });
  await store.load();
  const records = [];
  for (let i = 1; i <= count; i += 1) {
    records.push({ transcript_seq: i, role: i % 2 === 1 ? "user" : "assistant", content });
  }
  await store.append(records);
}

// I1 修复：超大 transcript 首次压缩的 sourceMaterial 必须按窗口预算封顶——压缩
// 请求自身能装进窗口，绝不被 provider 拒绝（那会让 Run 永久卡在 waiting_user）。
test("I1：超大 transcript 首压 sourceMaterial 按窗口预算封顶（压缩请求可装进窗口）", async (t) => {
  const h = await createProjectAgentHarness({
    gatewayScript: compactionSummaryScript({ count: 20 }),
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());
  // 8005 条、每条 50 CJK 字符（一轮 ≈100 tokens）：估算（尾部 8000 条）≈ 440k
  // tokens 超过软阈值，必然触发压缩；但 8005 条逐字拼接的 sourceMaterial 若不加
  // 封顶会远超 256k 窗口（400k+ 字符），provider 会拒绝请求。
  // 多会话布局：先 newSession 拿 sessionId，预置 transcript 进该会话目录
  //（journal 首次 load 前写入），再 open(sessionId) 物化会话后提交。
  const seeded = await h.agent.newSession({ projectRoot: h.projectRoot, title: "播种" });
  await seedTranscriptRecords(h, 8005, "章".repeat(50), seeded.session_id);
  await h.agent.open({ projectRoot: h.projectRoot, sessionId: seeded.session_id });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat", sessionId: seeded.session_id });
  await waitForIdle(h.agent, h.projectRoot);
  const compactionCall = h.gateway.calls.find((call) => call.request.metadata?.stage === "context_compaction");
  assert.ok(compactionCall, "必须发生压缩模型调用");
  const sourceMaterial = String(compactionCall.request.messages[1].content ?? "");
  assert.ok(
    sourceMaterial.length < 300_000,
    `sourceMaterial 必须按预算封顶（实际 ${sourceMaterial.length} 字符；未封顶约 500k+）`
  );
  // 压缩请求能装进 256k 窗口：sourceMaterial（≈130k tokens）+ 指令 + 输出余量
  const events = await readEvents(h.agent, h.projectRoot);
  const compactionEvents = events.filter((event) => event.type.startsWith("context_compaction"));
  assert.deepEqual(
    compactionEvents.map((event) => event.type),
    ["context_compaction_started", "context_compaction_running", "context_compaction_completed"],
    "封顶后压缩必须正常完成"
  );
  assert.equal(eventsOfType(events, "run_completed").length, 1, "压缩后输入继续并完成");
  const session = await readSession(h.agent, h.projectRoot);
  assert.ok(session.active_context_checkpoint_id, "active checkpoint 必须建立");
});

test("C1：transcript 超过无 checkpoint 尾部页（高轮次/低 token）→ 估算未达阈值也强制首压", async (t) => {
  const h = await createProjectAgentHarness({
    gatewayScript: compactionSummaryScript({ count: 20 }),
    gatewayDelayMs: 0
  });
  t.after(() => h.cleanup());
  // 预置 8005 条极短轮次（无 checkpoint）：估算 ≈111k tokens < 204_800 软阈值，
  // 但 transcript 已超出 buildHistory 的尾部页（8000）——不压缩会把最旧记录静默
  // 排除出 prompt，且永远不会触发估算门禁。
  const seeded = await h.agent.newSession({ projectRoot: h.projectRoot, title: "播种" });
  await seedTranscriptRecords(h, 8005, "一", seeded.session_id);
  await h.agent.open({ projectRoot: h.projectRoot, sessionId: seeded.session_id });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat", sessionId: seeded.session_id });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const compactionEvents = events.filter((event) => event.type.startsWith("context_compaction"));
  assert.deepEqual(
    compactionEvents.map((event) => event.type),
    ["context_compaction_started", "context_compaction_running", "context_compaction_completed"],
    "尾部页溢出必须触发一次完整首压（估算低于软阈值也必须压缩）"
  );
  const completed = compactionEvents.at(-1);
  assert.equal(completed.payload.trigger, "automatic");
  assert.equal(completed.payload.error_code, null);
  // 压缩成功后原输入继续并完成，active checkpoint 建立
  assert.equal(eventsOfType(events, "run_completed").length, 1, "首压后输入继续并完成");
  assert.equal(eventsOfType(events, "input_completed").length, 1);
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.active_context_checkpoint_id, completed.payload.checkpoint_id, "压缩后 active checkpoint 必须建立");
  const checkpointFile = path.join(h.agentRoot, "sessions", seeded.session_id, "checkpoints", `context-${completed.payload.checkpoint_id}.json`);
  assert.equal(await pathExists(checkpointFile), true, "checkpoint 正式文件必须落盘");
});

test("自动压缩：达到阈值先压缩（started→running→completed），成功后继续原输入并完成 Run", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: compactionSummaryScript(),
    gatewayDelayMs: 0
  });
  await seedTurns(h, 13);
  await h.agent.submit({ projectRoot: h.projectRoot, text: AUTO_COMPACT_INPUT, source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const compactionEvents = events.filter((event) => event.type.startsWith("context_compaction"));
  assert.deepEqual(
    compactionEvents.map((event) => event.type),
    ["context_compaction_started", "context_compaction_running", "context_compaction_completed"],
    "自动压缩事件顺序必须严格为 started → running → completed"
  );
  const completed = compactionEvents.at(-1);
  assert.equal(completed.payload.trigger, "automatic");
  assert.equal(completed.payload.attempt, 1);
  assert.equal(completed.payload.summary_schema_version, 1);
  assert.equal(completed.payload.error_code, null);
  assert.equal(completed.payload.cancel_reason, null);
  // 压缩调用形状：stream:false、无工具、metadata 固定
  const compactionCall = h.gateway.calls.find((call) => call.request.metadata?.stage === "context_compaction");
  assert.ok(compactionCall, "必须有一次压缩模型调用");
  assert.equal(compactionCall.request.stream, false);
  assert.equal(compactionCall.request.tools, undefined);
  assert.equal(compactionCall.request.metadata.cacheable, false);
  // 压缩成功后输入继续：普通模型调用 + input_completed + run_completed
  const normalCalls = h.gateway.calls.filter((call) => call.request.metadata?.stage !== "context_compaction");
  assert.equal(normalCalls.length, 14, "13 轮播种 + 1 轮压缩后继续");
  assert.equal(eventsOfType(events, "input_completed").length, 14);
  assert.equal(eventsOfType(events, "run_completed").length, 14);
  // active context 指针切换 + checkpoint 文件落盘 + 投影
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.active_context_checkpoint_id, completed.payload.checkpoint_id, "completed 必须切换 active 指针");
  assert.equal(session.compaction.state, "completed");
  assert.equal(session.compaction.trigger, "automatic");
  const checkpointFile = path.join(h.agentRoot, "sessions", session.session_id, "checkpoints", `context-${completed.payload.checkpoint_id}.json`);
  assert.equal(await pathExists(checkpointFile), true, "checkpoint 正式文件必须落盘");
});

test("I5：压缩已完成后的 cancel 同 id 不得误报取消（输入继续、Run 正常完成、无 run_cancelled）", async (t) => {
  let releaseNormal;
  const normalGate = new Promise((resolve) => { releaseNormal = resolve; });
  const script = [];
  for (let i = 0; i < 13; i += 1) script.push(() => ({ text: `回复 ${i}` }));
  script.push(compactionAwareEntry(validCompactionSummary(), async () => {
    await normalGate; // 压缩完成后挡住原输入的模型轮，制造稳定窗口
    return { text: "压缩后继续。" };
  }));
  script.push(() => ({ text: "后续回复。" }));
  const h = await openHarness(t, { gatewayScript: script, gatewayDelayMs: 0 });
  await seedTurns(h, 13);
  await h.agent.submit({ projectRoot: h.projectRoot, text: AUTO_COMPACT_INPUT, source: "chat" });
  // 压缩已 completed、原输入模型轮被 normalGate 挡住（run 仍 running）
  await waitFor(h.agent, h.projectRoot, (session) => session.compaction?.state === "completed" && session.active_run?.status === "running", { describe: "压缩 completed 且输入在途" });
  const completedEvent = (await readEvents(h.agent, h.projectRoot)).find((e) => e.type === "context_compaction_completed");
  assert.ok(completedEvent, "压缩必须已完成");
  const result = await h.agent.cancelCompaction({ projectRoot: h.projectRoot, compactionId: completedEvent.payload.compaction_id });
  assert.equal(result.status, "completed", "已完成压缩的取消请求必须报告实际完成（不得误报取消）");
  releaseNormal();
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  assert.equal(eventsOfType(events, "run_cancelled").length, 0, "已完成的压缩不得收敛出 run_cancelled");
  assert.equal(eventsOfType(events, "input_cancelled").length, 0, "已完成的压缩不得收敛出 input_cancelled");
  assert.equal(eventsOfType(events, "run_completed").length, 14, "原输入照常继续并完成");
  assert.equal(eventsOfType(events, "input_completed").length, 14);
});

test("自动压缩失败：Run 进入 waiting_user（不悬挂/不自动重启），重试成功后只继续原输入一次，cancel 后输入终态回 draft", async (t) => {
  const script = [];
  for (let i = 0; i < 13; i += 1) script.push(() => ({ text: `回复 ${i}` }));
  script.push(() => {
    const error = new Error("压缩响应不是合法 JSON");
    error.code = "compaction_json";
    throw error;
  });
  script.push(compactionAwareEntry(validCompactionSummary(), "重试后正常回复。"));
  for (let i = 0; i < 6; i += 1) script.push(() => ({ text: "后续回复。" }));
  const h = await openHarness(t, { gatewayScript: script, gatewayDelayMs: 0 });
  await seedTurns(h, 13);
  await h.agent.submit({ projectRoot: h.projectRoot, text: AUTO_COMPACT_INPUT, source: "chat" });
  const failed = await waitFor(
    h.agent,
    h.projectRoot,
    (session) => session.compaction?.state === "failed" && session.active_run?.status === "waiting_user",
    { describe: "压缩失败" }
  );
  // 失败后：Run waiting_user、输入无终态、不调用普通模型
  assert.equal(failed.session.status, "waiting_user");
  assert.equal(failed.session.active_run.status, "waiting_user");
  assert.ok(failed.session.active_run.active_input_id, "输入保持 pending（无终态，可重试）");
  const beforeRetry = await readEvents(h.agent, h.projectRoot);
  assert.equal(beforeRetry.filter((event) => event.type === "input_cancelled").length, 0, "失败不得终结输入");
  assert.equal(beforeRetry.filter((event) => event.type === "run_cancelled").length, 0, "失败不得取消 Run");
  assert.equal(h.gateway.calls.length, 13, "13 轮播种 + 1 次失败压缩调用（结构失败不自动重试）；失败后不调用普通模型");
  const failedEvent = beforeRetry.find((event) => event.type === "context_compaction_failed");
  assert.equal(failedEvent.payload.error_code, "compaction_json");
  // 再次 open()（幂等重启路径）不得自动调用普通模型
  await h.agent.open({ projectRoot: h.projectRoot });
  assert.equal(h.gateway.calls.length, 13, "open() 后不自动调用普通模型");
  // 重试：压缩成功 → 恢复 running → 只继续原输入一次 → Run 完成
  await h.agent.retryCompaction({ projectRoot: h.projectRoot, compactionId: failedEvent.payload.compaction_id });
  await waitForIdle(h.agent, h.projectRoot);
  const afterRetry = await readEvents(h.agent, h.projectRoot);
  const retryStarted = afterRetry.filter((event) => event.type === "context_compaction_started").at(-1);
  assert.equal(retryStarted.payload.attempt, 2, "手动重试是新 attempt");
  assert.equal(retryStarted.payload.compaction_id, failedEvent.payload.compaction_id, "重试继续同一 compaction");
  assert.equal(afterRetry.filter((event) => event.type === "context_compaction_completed").length, 1);
  assert.equal(eventsOfType(afterRetry, "input_completed").length, 14, "原输入只继续一次并完成");
  assert.equal(eventsOfType(afterRetry, "run_completed").length, 14);
});

test("自动压缩失败后取消：input_cancelled(compaction_cancelled) + run_cancelled，文本回 draft，会话 idle", async (t) => {
  const script = [];
  for (let i = 0; i < 13; i += 1) script.push(() => ({ text: `回复 ${i}` }));
  script.push(() => {
    const error = new Error("压缩响应不是合法 JSON");
    error.code = "compaction_json";
    throw error;
  });
  const h = await openHarness(t, { gatewayScript: script, gatewayDelayMs: 0 });
  await seedTurns(h, 13);
  await h.agent.submit({ projectRoot: h.projectRoot, text: AUTO_COMPACT_INPUT, source: "chat" });
  await waitFor(h.agent, h.projectRoot, (session) => session.compaction?.state === "failed" && session.active_run?.status === "waiting_user", { describe: "压缩失败且 Run 收敛 waiting_user" });
  const failedEvent = (await readEvents(h.agent, h.projectRoot)).find((event) => event.type === "context_compaction_failed");
  await h.agent.cancelCompaction({ projectRoot: h.projectRoot, compactionId: failedEvent.payload.compaction_id });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const cancelled = eventsOfType(events, "input_cancelled").filter(
    (event) => event.payload.reason === "compaction_cancelled"
  );
  assert.equal(cancelled.length, 1, "取消必须终结该输入（reason compaction_cancelled）");
  assert.equal(eventsOfType(events, "run_cancelled").length, 1, "Run 必须 cancelled");
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.status, "idle");
  assert.equal(session.active_context_checkpoint_id, null, "失败/取消不得切换 active 指针");
  assert.equal(session.compaction.state, "failed", "取消不改写失败压缩的投影（历史失败保留）");
  assert.equal(
    events.filter((event) => event.type === "input_queued" && event.payload.text === AUTO_COMPACT_INPUT).length,
    1
  );
});

test("自动压缩取消（ESC 复用 AbortController）：cancel_requested 先于 cancelled，输入取消、Run cancelled、draft 恢复", async (t) => {
  const script = [];
  for (let i = 0; i < 13; i += 1) script.push(() => ({ text: `回复 ${i}` }));
  script.push((request, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    })
  );
  const h = await openHarness(t, { gatewayScript: script, gatewayDelayMs: 0 });
  await seedTurns(h, 13);
  await h.agent.submit({ projectRoot: h.projectRoot, text: AUTO_COMPACT_INPUT, source: "chat" });
  await waitFor(h.agent, h.projectRoot, (_session, snap) => eventsOfType(snap.events, "context_compaction_running").length > 0, { describe: "压缩进行中" });
  const started = (await readEvents(h.agent, h.projectRoot)).find((event) => event.type === "context_compaction_started");
  await h.agent.cancelCompaction({ projectRoot: h.projectRoot, compactionId: started.payload.compaction_id });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const compactionEvents = events.filter((event) => event.type.startsWith("context_compaction"));
  assert.deepEqual(
    compactionEvents.map((event) => event.type),
    ["context_compaction_started", "context_compaction_running", "context_compaction_cancel_requested", "context_compaction_cancelled"],
    "running 中取消必须 cancel_requested 先于 cancelled"
  );
  assert.equal(compactionEvents.at(-1).payload.cancel_reason, "user_cancel");
  const cancelled = eventsOfType(events, "input_cancelled").filter((event) => event.payload.reason === "compaction_cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(eventsOfType(events, "run_cancelled").length, 1);
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.status, "idle");
  assert.equal(session.active_context_checkpoint_id, null, "取消不切换 active 指针");
});

test("自动压缩后仍超硬窗口：failRun(context_window_exceeded)，不重复压缩，输入可恢复", async (t) => {
  const h = await openHarness(t, { gatewayScript: compactionSummaryScript(), gatewayDelayMs: 0 });
  await seedTurns(h, 13);
  await h.agent.submit({ projectRoot: h.projectRoot, text: OVER_HARD_WINDOW_INPUT, source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const compactions = events.filter((event) => event.type.startsWith("context_compaction"));
  assert.equal(compactions.length, 3, "只压缩一次（started/running/completed），不重复压缩");
  const failed = eventsOfType(events, "run_failed");
  assert.equal(failed.length, 1, "仍超硬窗口必须 failRun");
  assert.equal(failed[0].payload.code, "context_window_exceeded");
  assert.equal(eventsOfType(events, "input_cancelled").length, 0, "输入保持可恢复（未终结）");
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.active_run.status, "failed");
  assert.equal(
    session.active_context_checkpoint_id,
    events.find((event) => event.type === "context_compaction_completed").payload.checkpoint_id
  );
});

test("submit 只把精确 text === '/compact' 识别为压缩指令；'/compact now' 是普通输入", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [{ reply: { text: "普通回复。" } }, { reply: { text: "普通回复 2。" } }],
    gatewayDelayMs: 0
  });
  // 空闲 + 无可压缩历史：直接 noop，不调用模型
  await h.agent.submit({ projectRoot: h.projectRoot, text: "/compact", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  let events = await readEvents(h.agent, h.projectRoot);
  const noop = eventsOfType(events, "context_compaction_noop");
  assert.equal(noop.length, 1, "无可压缩历史必须 noop");
  assert.equal(noop[0].payload.trigger, "manual");
  assert.equal(noop[0].payload.reason, "nothing_to_compact");
  assert.equal(h.gateway.calls.length, 0, "noop 不调用模型");
  const queued = eventsOfType(events, "input_queued");
  assert.equal(queued[0].payload.kind, "compact", "input_queued 必须带 kind:\"compact\"");
  // "/compact now" 是普通输入：正常模型调用
  await h.agent.submit({ projectRoot: h.projectRoot, text: "/compact now", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  events = await readEvents(h.agent, h.projectRoot);
  const queuedNow = eventsOfType(events, "input_queued").at(-1);
  assert.equal(queuedNow.payload.kind, undefined, "/compact now 不是压缩指令");
  assert.equal(h.gateway.calls.length, 1, "/compact now 走普通模型调用");
});

test("手动 /compact：有可压缩历史时启动手动压缩（trigger manual），成功后 Run 完成", async (t) => {
  const h = await openHarness(t, { gatewayScript: compactionSummaryScript(), gatewayDelayMs: 0 });
  await seedTurns(h, 13);
  await h.agent.submit({ projectRoot: h.projectRoot, text: "/compact", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const compactionEvents = events.filter((event) => event.type.startsWith("context_compaction"));
  assert.deepEqual(
    compactionEvents.map((event) => event.type),
    ["context_compaction_started", "context_compaction_running", "context_compaction_completed"]
  );
  const completed = compactionEvents.at(-1);
  assert.equal(completed.payload.trigger, "manual");
  assert.equal(completed.payload.source_checkpoint_id, null);
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.active_context_checkpoint_id, completed.payload.checkpoint_id);
  assert.equal(session.status, "idle");
  // compact item 被消费（processCompact 的 legacy input_consumed）；13 轮播种走
  // 新生命周期 input_completed
  const compactQueued = eventsOfType(events, "input_queued").at(-1);
  assert.equal(compactQueued.payload.kind, "compact");
  assert.equal(eventsOfType(events, "input_completed").length, 13, "13 轮播种完成");
  assert.equal(eventsOfType(events, "input_consumed").length, 1, "compact item 消费");
});

test("运行中 /compact 排队不打断当前模型/工具；重复 compact item 在安全点取消（duplicate_compact）", async (t) => {
  const h = await openHarness(t, {
    gatewayScript: [{ reply: { text: "第一条。" }, repeat: true }],
    gatewayDelayMs: 60
  });
  const first = await h.agent.submit({ projectRoot: h.projectRoot, text: "第一条输入", source: "chat" });
  await sleep(30);
  // 运行中追加两个 /compact：排队，不打断
  const c1 = await h.agent.submit({ projectRoot: h.projectRoot, text: "/compact", source: "chat" });
  assert.equal(c1.queued, true);
  const c2 = await h.agent.submit({ projectRoot: h.projectRoot, text: "/compact", source: "chat" });
  assert.equal(c2.queued, true);
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  const queued = eventsOfType(events, "input_queued");
  assert.equal(queued.filter((event) => event.payload.kind === "compact").length, 2, "两个 /compact 排队");
  assert.equal(queued[1].payload.kind, "compact");
  assert.equal(queued[2].payload.kind, "compact");
  // 第二个重复 compact 在安全点被取消
  const duplicates = eventsOfType(events, "input_cancelled").filter((event) => event.payload.reason === "duplicate_compact");
  assert.equal(duplicates.length, 1, "后续重复 compact item 追加 input_cancelled(duplicate_compact)");
  assert.equal(duplicates[0].payload.input_id, c2.input_id);
  // 第一个 compact：无可压缩历史 → noop（不调用模型）
  assert.equal(eventsOfType(events, "context_compaction_noop").length, 1);
  // 第一条输入正常完成，未被打断
  assert.equal(eventsOfType(events, "assistant_message_completed").length, 1);
  assert.equal(h.gateway.calls.length, 1, "只有第一条输入的普通模型调用，压缩不调用模型");
  assert.equal(eventsOfType(events, "run_completed").length, 1);
  assert.equal(first.run_id, c1.run_id, "/compact 排队不创建第二个 Run");
});

test("手动 /compact 失败：compact item 无终态，Run waiting_user 保存 resume_run_status；取消后恢复 idle", async (t) => {
  const script = [];
  for (let i = 0; i < 13; i += 1) script.push(() => ({ text: `回复 ${i}` }));
  script.push(() => {
    const error = new Error("5xx");
    error.code = "provider_transport_error";
    error.reason = "server-retryable";
    throw error;
  });
  script.push(() => {
    const error = new Error("timeout");
    error.code = "provider_transport_error";
    error.reason = "timeout";
    throw error;
  });
  const h = await openHarness(t, { gatewayScript: script, gatewayDelayMs: 0 });
  await seedTurns(h, 13);
  await h.agent.submit({ projectRoot: h.projectRoot, text: "/compact", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (session) => session.compaction?.state === "failed" && session.active_run?.status === "waiting_user", { describe: "手动压缩失败且 Run 收敛 waiting_user" });
  const failedSession = await readSession(h.agent, h.projectRoot);
  assert.equal(failedSession.status, "waiting_user");
  assert.equal(failedSession.active_run.status, "waiting_user");
  assert.equal(h.gateway.calls.length, 13, "13 轮播种 + 手动压缩熔断（瞬时错误自动重试一次 → 2 次请求，失败调用不记录）");
  const events = await readEvents(h.agent, h.projectRoot);
  const failed = eventsOfType(events, "context_compaction_failed").at(-1);
  assert.equal(failed.payload.trigger, "manual");
  assert.equal(failed.payload.attempt, 1);
  const compactItemId = eventsOfType(events, "input_queued").at(-1).payload.input_id;
  assert.equal(eventsOfType(events, "input_completed").length, 13, "13 轮播种完成，compact item 未被消费");
  assert.equal(
    eventsOfType(events, "input_cancelled").filter((event) => event.payload.input_id === compactItemId).length,
    0,
    "compact item 无终态（可重试/可取消）"
  );
  // 取消 → input_cancelled + run_cancelled → idle（空闲发起的手动压缩）
  await h.agent.cancelCompaction({ projectRoot: h.projectRoot, compactionId: failed.payload.compaction_id });
  await waitForIdle(h.agent, h.projectRoot);
  const after = await readEvents(h.agent, h.projectRoot);
  const cancelledInputs = eventsOfType(after, "input_cancelled").filter((event) => event.payload.reason === "compaction_cancelled");
  assert.equal(cancelledInputs.length, 1);
  assert.equal(eventsOfType(after, "run_cancelled").length, 1);
  const session = await readSession(h.agent, h.projectRoot);
  assert.equal(session.status, "idle", "取消后 composer 立即可发（idle）");
});

test("重启恢复：进程在压缩 running 中重启，不自动调用普通模型；未完成 attempt 追加 cancelled(process_restarted)，Run 收敛 waiting_user", async (t) => {
  const script = [];
  for (let i = 0; i < 13; i += 1) script.push(() => ({ text: `回复 ${i}` }));
  script.push((request, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    })
  );
  const h = await openHarness(t, { gatewayScript: script, gatewayDelayMs: 0 });
  await seedTurns(h, 13);
  await h.agent.submit({ projectRoot: h.projectRoot, text: "/compact", source: "chat" });
  await waitFor(h.agent, h.projectRoot, (_session, snap) => eventsOfType(snap.events, "context_compaction_running").length > 0, { describe: "压缩进行中（重启前）" });
  const started = (await readEvents(h.agent, h.projectRoot)).find((event) => event.type === "context_compaction_started");

  // 模拟进程重启：同一 projectRoot/agentRoot 上创建全新 agent 实例
  const bGateway = createMockModelGateway({ script: [], delayMs: 0 });
  const { createProjectAgent } = await import("../../src/core/agent/index.mjs");
  const b = createProjectAgent({
    modelGateway: bGateway,
    skills: h.skills,
    agentStorageRootFor: (root) => h.store.agentRootFor(root)
  });
  const opened = await b.open({ projectRoot: h.projectRoot });
  assert.equal(opened.status, "waiting_user", "重启后 Run 收敛为 waiting_user");
  assert.equal(bGateway.calls.length, 0, "重启绝不自动调用普通模型");
  const bEvents = await readEvents(b, h.projectRoot);
  const restartCancelled = eventsOfType(bEvents, "context_compaction_cancelled").filter(
    (event) => event.payload.cancel_reason === "process_restarted"
  );
  assert.equal(restartCancelled.length, 1, "未完成 attempt 追加 cancelled(process_restarted)");
  assert.equal(restartCancelled[0].payload.compaction_id, started.payload.compaction_id);
  const bSnapshot = await b.snapshot({ projectRoot: h.projectRoot, afterSeq: 0, limit: 100000 });
  assert.equal(bSnapshot.session.compaction.state, "cancelled");
  assert.equal(bSnapshot.session.active_run.status, "waiting_user");
  assert.ok(bSnapshot.session.active_run.active_input_id, "输入保持 pending（等待用户 retry/cancel）");
  // 取消收敛 → idle（composer 立即可发）
  await b.cancelCompaction({ projectRoot: h.projectRoot, compactionId: started.payload.compaction_id });
  const idle = await waitFor(b, h.projectRoot, (session) => session.status === "idle", { describe: "重启后取消收敛 idle" });
  assert.equal(idle.session.compaction.state, "cancelled");
  assert.equal(eventsOfType(idle.events, "run_cancelled").length, 1);
});

test("运行中手动 /compact 取消：input_cancelled(compaction_cancelled) + 恢复 resume_run_status(running)，Run 继续完成", async (t) => {
  const script = [];
  for (let i = 0; i < 13; i += 1) script.push(() => ({ text: `回复 ${i}` }));
  script.push(async () => {
    await sleep(120);
    return { text: "继续输入完成。" };
  });
  script.push((request, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    })
  );
  const h = await openHarness(t, { gatewayScript: script, gatewayDelayMs: 0 });
  await seedTurns(h, 13);
  // 运行中排队 /compact（不打断当前输入）
  const first = await h.agent.submit({ projectRoot: h.projectRoot, text: "继续输入", source: "chat" });
  await sleep(30);
  const compact = await h.agent.submit({ projectRoot: h.projectRoot, text: "/compact", source: "chat" });
  assert.equal(compact.queued, true);
  // 第一个输入完成 → 安全点消费 compact → 手动压缩进入 running → ESC 取消
  await waitFor(h.agent, h.projectRoot, (_session, snap) => eventsOfType(snap.events, "context_compaction_running").length > 0, { describe: "手动压缩进行中" });
  const started = (await readEvents(h.agent, h.projectRoot)).find((event) => event.type === "context_compaction_started");
  assert.equal(started.payload.trigger, "manual");
  await h.agent.cancelCompaction({ projectRoot: h.projectRoot, compactionId: started.payload.compaction_id });
  await waitForIdle(h.agent, h.projectRoot);
  const events = await readEvents(h.agent, h.projectRoot);
  // 取消收敛：input_cancelled(compaction_cancelled) + 恢复 resume_run_status
  const cancelled = eventsOfType(events, "input_cancelled").filter((event) => event.payload.reason === "compaction_cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].payload.input_id, compact.input_id);
  assert.equal(eventsOfType(events, "run_cancelled").length, 0, "in-run 取消不得取消整个 Run");
  assert.equal(eventsOfType(events, "run_completed").length, 14, "Run 恢复 running 后继续完成");
  assert.equal(eventsOfType(events, "input_completed").length, 14, "13 轮播种 + 继续输入完成");
  assert.equal(first.run_id, compact.run_id, "/compact 排队不创建第二个 Run");
});

// ---------------------------------------------------------------------------
// Task 10：安全点优先调度（SPEC 3.3/6.2）。工具在途超时 + 优先输入收敛；
// 优先切换必须清空旧输入 grant（不得泄漏给后续输入）。
// ---------------------------------------------------------------------------

test("Task 10 工具在途超时 + 优先输入：tool_timeout 结果入历史后切换到优先输入（A input_interrupted，D 开始）", async (t) => {
  // 直接经公共 seam 构造 agent：注入毫秒级工具期限，让真实 agent 循环内产生
  // tool_timeout（harness 固定 5 分钟默认期限，无法在测试内触发）
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-priority-timeout-"));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
  const { projectRoot } = await createProjectRoot(workspaceRoot, {
    tool_permissions: { yolo: true }
  });
  const { createWorkspaceStore } = await import("../../src/core/workspaces/store.mjs");
  const { createSkillService } = await import("../../src/core/skills/index.mjs");
  const store = createWorkspaceStore({ stateRoot: path.join(workspaceRoot, "user-data") });
  const skills = createSkillService({
    userHome: path.join(projectRoot, ".test-skill-home"),
    resourcesPath: null
  });
  const gateway = createMockModelGateway({
    script: [
      {
        reply: {
          toolCalls: [
            tool("shell", { command: "hang", timeout_ms: 1000, purpose: "慢命令" }),
            tool("read_file", { path: "OUTLINE.md" })
          ]
        }
      },
      { reply: { text: "D 完成。" } },
      { reply: { text: "B 完成。" } }
    ],
    delayMs: 0
  });
  // 挂起桩：期限 abort 传导后立即收尾（抛 shell_cancelled，executeWithDeadline 按
  // timeout 结论收口）；无 abort 时 3s 兜底收尾，避免实现缺失时测试悬挂
  const shell = async ({ signal } = {}) => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    throw Object.assign(new Error("命令已停止。"), { code: "shell_cancelled", durationMs: 0 });
  };
  const { createProjectAgent } = await import("../../src/core/agent/index.mjs");
  const agent = createProjectAgent({
    modelGateway: gateway,
    shell,
    skills,
    agentStorageRootFor: (root) => store.agentRootFor(root),
    toolIdleTimeoutMs: 150,
    toolAbsoluteTimeoutMs: 5000
  });
  await agent.open({ projectRoot });
  const a = await agent.submit({ projectRoot, text: "A 任务", source: "chat" });
  const b = await agent.submit({ projectRoot, text: "B 任务", source: "chat" });
  const d = await agent.submit({ projectRoot, text: "D 任务", source: "chat" });
  // 工具在途（shell 挂起）时点 D 的「立即」：只等待当前工具超时，不 abort
  await waitFor(agent, projectRoot, (_session, snap) =>
    eventsOfType(snap.events, "tool_call_started").some((event) => event.payload.name === "shell")
  );
  const pri = await agent.requestPriority({ projectRoot, inputId: d.input_id });
  assert.equal(pri.priority_pending, true);
  await waitForIdle(agent, projectRoot);

  const events = await readEvents(agent, projectRoot);
  const failed = eventsOfType(events, "tool_call_failed").find((event) => event.payload.name === "shell");
  assert.equal(failed.payload.error, "tool_timeout", "当前工具以 tool_timeout 收敛（等待超时，不 abort）");
  assert.equal(
    eventsOfType(events, "tool_call_started").length,
    1,
    "同一轮剩余未开始工具不启动（read_file 从未开始）"
  );
  assert.equal(
    eventsOfType(events, "input_interrupted").filter((event) => event.payload.input_id === a.input_id).length,
    1,
    "A input_interrupted（有优先输入时不把超时结果交回模型，直接收敛）"
  );
  const started = eventsOfType(events, "input_started").map((event) => event.payload.input_id);
  assert.deepEqual(started, [a.input_id, d.input_id, b.input_id], "优先输入 D 随后开始，B 顺序不变");
  assert.equal(eventsOfType(events, "run_completed").length, 1);
  assertActivityClosure(events);
});

test("Task 10 优先切换清空旧输入 grant：D 的同类写文件必须重新确认（grant 不跨输入泄漏）", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await openHarness(t, {
    gatewayScript: [
      // A call 1：write_file a.txt → 决策 allow_input → grant 绑定 A
      { reply: { toolCalls: [tool("write_file", { path: "a.txt", content: "A 内容" })] } },
      // A call 2（在途）：返回 write_file c.txt → 被优先切换跳过
      async () => {
        await gate;
        return { toolCalls: [tool("write_file", { path: "c.txt", content: "C 内容" })] };
      },
      // D call 1：write_file d.txt → 必须重新请求决策（grant 已清空）
      { reply: { toolCalls: [tool("write_file", { path: "d.txt", content: "D 内容" })] } },
      { reply: { text: "D 完成。" } },
      { reply: { text: "B 完成。" } }
    ],
    gatewayDelayMs: 0
  });
  const a = await h.agent.submit({ projectRoot: h.projectRoot, text: "A 任务", source: "chat" });
  const b = await h.agent.submit({ projectRoot: h.projectRoot, text: "B 任务", source: "chat" });
  const d = await h.agent.submit({ projectRoot: h.projectRoot, text: "D 任务", source: "chat" });
  // A 的写文件请求确认 → allow_input 创建 grant → a.txt 落盘 → A call 2 在途
  const decision1 = await waitForDecision(h.agent, h.projectRoot, 1);
  await h.agent.decide({
    projectRoot: h.projectRoot,
    decisionId: decision1.payload.decision_id,
    choice: "allow_input"
  });
  await waitFor(
    h.agent,
    h.projectRoot,
    (_session, snap) => eventsOfType(snap.events, "tool_call_completed").length >= 1,
    { describe: "A 的 a.txt 写入完成" }
  );
  // A call 2 在途时点 D 的「立即」
  const pri = await h.agent.requestPriority({ projectRoot: h.projectRoot, inputId: d.input_id });
  assert.equal(pri.priority_pending, true);
  release();
  // D 的写文件：grant 必须已被优先切换清空 → 触发新的决策确认
  const decision2 = await waitForDecision(h.agent, h.projectRoot, 2);
  await h.agent.decide({
    projectRoot: h.projectRoot,
    decisionId: decision2.payload.decision_id,
    choice: "allow"
  });
  await waitForIdle(h.agent, h.projectRoot);

  const events = await readEvents(h.agent, h.projectRoot);
  // 优先切换原子收敛：A input_interrupted，D 下一条开始，B 顺序不变
  assert.equal(
    eventsOfType(events, "input_interrupted").filter((event) => event.payload.input_id === a.input_id).length,
    1,
    "A input_interrupted"
  );
  const started = eventsOfType(events, "input_started").map((event) => event.payload.input_id);
  assert.deepEqual(started, [a.input_id, d.input_id, b.input_id], "D 下一条开始，B 顺序不变");
  assert.equal(eventsOfType(events, "input_completed").filter((event) => event.payload.input_id === d.input_id).length, 1);
  // A 的 grant 在切换批次被清除（reason: input_interrupted）
  const grantCleared = eventsOfType(events, "permission_grant_cleared").filter(
    (event) => event.payload.input_id === a.input_id
  );
  assert.ok(grantCleared.length >= 1, "优先切换必须清除旧输入 grant");
  // D 的写文件需要新的决策（未复用 A 的 grant）
  assert.equal(eventsOfType(events, "decision_requested").length, 2, "A 与 D 各自请求决策（grant 不跨输入）");
  // 副作用：a.txt/d.txt 落盘，被跳过的 c.txt 从未执行
  assert.equal(await pathExists(path.join(h.projectRoot, "a.txt")), true, "A 已完成的写文件副作用保留");
  assert.equal(await pathExists(path.join(h.projectRoot, "d.txt")), true, "D 的写文件完成");
  assert.equal(await pathExists(path.join(h.projectRoot, "c.txt")), false, "被优先切换跳过的工具不得执行");
  assertActivityClosure(events);
});
