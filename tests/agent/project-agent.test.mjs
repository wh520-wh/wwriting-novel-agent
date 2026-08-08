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
import path from "node:path";
import test from "node:test";

import { EXTREME_COMMANDS } from "../fixtures/command-risk-corpus.mjs";
import {
  LEGACY_STATE_FILE,
  VALID_MEMORY,
  createMockModelGateway,
  createProjectAgentHarness,
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
function assertActivityClosure(events) {
  const openInputs = new Set();
  const openTools = new Set();
  const openDecisions = new Set();
  for (const event of events) {
    if (event.type === "input_queued") {
      openInputs.add(event.payload.input_id);
    } else if (event.type === "input_consumed" || event.type === "input_cancelled") {
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
  assert.equal(eventsOfType(events, "input_consumed").length, 1);
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
  const consumed = eventsOfType(events, "input_consumed");
  assert.equal(consumed.length, 3);
  // 第一条输入由完成消费收敛；后两条由「切换激活」消费（Task 2 语义：每条 input
  // 恰好一个终态事件，顺序与 queued 一致）
  assert.equal(consumed[0].payload.input_id, queued[0].payload.input_id);
  assert.equal(consumed[1].payload.input_id, queued[1].payload.input_id);
  assert.equal(consumed[2].payload.input_id, queued[2].payload.input_id);
  assert.equal(eventsOfType(events, "run_started").length, 1, "全程只有一个 Run");
  assertActivityClosure(events);
});

test("open() 幂等：重复 open 不创建第二个 Session，也不干扰已完成 Run", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "好。" } }] });
  const before = await readSession(h.agent, h.projectRoot);
  await h.agent.open({ projectRoot: h.projectRoot });
  const after = await readSession(h.agent, h.projectRoot);
  assert.equal(after.session_id, before.session_id);
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
  await h.agent.submit({ projectRoot: h.projectRoot, text: "读取指定文件", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);

  const transcriptRaw = await fs.readFile(
    path.join(h.agentRoot, "segments", "transcript", "00000001.jsonl"),
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
        toolCalls: [tool("enter_workflow", { workflow: "chapter", reason: "用户要求正式写作第一章" })]
      }),
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
        toolCalls: [tool("enter_workflow", { workflow: "chapter", reason: "正式写作" })]
      }),
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

test("新项目不创建旧状态文件，Agent 状态只落在应用私有 agentRoot（新分段格式）", async (t) => {
  const h = await openHarness(t, { gatewayScript: [{ reply: { text: "好。" } }] });
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
  assert.equal(await pathExists(path.join(h.projectRoot, LEGACY_STATE_FILE)), false);
  assert.equal(await pathExists(path.join(h.projectRoot, ".wwriting", "agent")), false, "新会话不得写回项目内 .wwriting/agent");
  // 新格式 journal：segments/ + journal-manifest.json + session.json + migration.json
  for (const name of ["session.json", "migration.json", "journal-manifest.json"]) {
    assert.equal(await pathExists(path.join(h.agentRoot, name)), true, `${name} 应落在应用私有 agentRoot`);
  }
  assert.equal(await pathExists(path.join(h.agentRoot, "segments", "events")), true, "segments/events 应存在");
  assert.equal(await pathExists(path.join(h.agentRoot, "segments", "transcript")), true, "segments/transcript 应存在");
  assert.equal(await pathExists(path.join(h.agentRoot, "events.jsonl")), false, "新项目不得创建单体 events.jsonl");
  assert.equal(await pathExists(path.join(h.agentRoot, "transcript.jsonl")), false, "新项目不得创建单体 transcript.jsonl");
});

test("旧 .wwriting/agent 中间损坏：open() 拒绝迁移但允许新会话（journal 落应用私有目录）", async (t) => {
  const h = await createProjectAgentHarness({ gatewayScript: [{ reply: { text: "好。" } }] });
  t.after(() => h.cleanup());
  // 构造中间损坏的旧 journal（seq 1、2 合法，第 3 行损坏）
  const legacyDir = path.join(h.projectRoot, ".wwriting", "agent");
  await fs.mkdir(legacyDir, { recursive: true });
  const legacyEvents = [
    JSON.stringify({ schema_version: 1, seq: 1, event_id: "e1", session_id: "legacy-s", run_id: null, project_root: h.projectRoot, type: "session_created", at: new Date().toISOString(), payload: {} }),
    JSON.stringify({ schema_version: 1, seq: 2, event_id: "e2", session_id: "legacy-s", run_id: null, project_root: h.projectRoot, type: "input_queued", at: new Date().toISOString(), payload: { input_id: "i1", text: "旧" } }),
    "{broken"
  ].join("\n") + "\n";
  await fs.writeFile(path.join(legacyDir, "events.jsonl"), legacyEvents, "utf8");

  await h.agent.open({ projectRoot: h.projectRoot });
  // 新会话仍可建立：私有目录从零创建 session（迁移被拒、目标目录保持干净）
  const session = await readSession(h.agent, h.projectRoot);
  assert.ok(session.session_id, "open() 必须允许新会话");
  assert.equal(await pathExists(path.join(h.agentRoot, "journal-manifest.json")), true, "新 journal 落应用私有目录（新分段格式）");
  assert.equal(await pathExists(path.join(h.agentRoot, "segments", "events")), true, "新 journal 应创建 segments/events");
  await h.agent.submit({ projectRoot: h.projectRoot, text: "你好", source: "chat" });
  await waitForIdle(h.agent, h.projectRoot);
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
  const consumed = eventsOfType(events, "input_consumed");
  const cancelled = eventsOfType(events, "input_cancelled");
  assert.equal(queued.length, 13);
  assert.equal(consumed.length + cancelled.length, queued.length, "每条输入都必须收敛");
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
  const promotePromise = h.agent.promote({ projectRoot: h.projectRoot, inputId: queued.id });
  const stopResult = await h.agent.stop({ projectRoot: h.projectRoot, reason: "user_stop" });
  assert.equal(stopResult.cancelled, true);
  let promoteResult;
  try {
    promoteResult = await promotePromise;
  } catch (error) {
    promoteResult = { rejected: error };
  }
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
