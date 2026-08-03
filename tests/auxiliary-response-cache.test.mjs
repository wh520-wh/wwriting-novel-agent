import assert from "node:assert/strict";
import test from "node:test";
import { ModelClient } from "../src/core/model-client.mjs";
import { OpenAICompatibleAdapter } from "../src/core/provider-adapters.mjs";

// Task 21 (L3) 收窄版确定性响应缓存测试：
// 仅「辅助调用（memoryExtract/factCheck）+ 无工具 + 非流式 + 显式 temperature=0 + attempt=0」
// 可缓存；命中不调 adapter、不 record 费用、usage 归零；reasoner 系模型不注入 temperature 也不缓存。

// 计数 adapter：记录调用次数、收到的 modelConfig 与 metadata（真实 adapter 形状）
function countingAdapter({ text = "辅助响应文本", usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } = {}) {
  const state = { calls: 0, seenConfigs: [], seenMetadata: [], failTimes: 0 };
  state.adapter = {
    async generate({ model, modelConfig, prompt, messages, stage, metadata, signal }) {
      state.calls += 1;
      state.seenConfigs.push(modelConfig);
      state.seenMetadata.push(metadata);
      if (state.failTimes > 0) {
        state.failTimes -= 1;
        throw new Error("模拟 provider 失败");
      }
      return { text, raw: { stage }, usage };
    }
  };
  return state;
}

function makeClient(adapter, { model = {}, client = {} } = {}) {
  return new ModelClient({
    adapters: { test: adapter },
    // 显式 temperature=0（2026-08-03 起默认不再注入）：本文件的缓存机制测试
    // 显式开启确定性缓存资格，语义与「用户显式配置 0」一致
    activeModel: { provider: "test", model_name: "aux-model", temperature: 0, ...model },
    retryMax: 0, // 本测试聚焦 L3 缓存，不需要网络重试
    ...client
  });
}

function auxRequest(overrides = {}) {
  return {
    project: {},
    stage: "memory_extract",
    messages: [{ role: "user", content: "提取本章记忆并更新设定档案" }],
    metadata: { memoryExtract: true, chapterNo: 1, attempt: 0 },
    ...overrides
  };
}

test("缓存命中：相同辅助请求第二次不调 adapter、usage 归零、费用不新增", async () => {
  const state = countingAdapter();
  const client = makeClient(state.adapter);
  const first = await client.generate(auxRequest());
  const second = await client.generate(auxRequest());

  assert.equal(state.calls, 1, "第二次应命中缓存，不再调 adapter");
  assert.equal(first.text, second.text, "命中响应文本应与首次一致");
  assert.equal(second.usageReport.inputTokens, 0, "命中 usage 应归零");
  assert.equal(second.usageReport.outputTokens, 0, "命中 usage 应归零");
  assert.equal(second.usageReport.totalTokens, 0, "命中 usage 应归零");
  assert.equal(second.costSummary.calls, 1, "命中不 record 费用：累计调用数应保持 1");
  assert.equal(client.costTracker.getSummary().calls, 1, "costTracker 累计调用数应保持 1");
});

test("重试豁免：attempt=1 的请求既不查缓存也不写缓存", async () => {
  const state = countingAdapter();
  const client = makeClient(state.adapter);

  // attempt=1 两次相同请求：每次都应调 adapter（不查缓存）
  const retryRequest = () => auxRequest({ metadata: { memoryExtract: true, chapterNo: 1, attempt: 1 } });
  await client.generate(retryRequest());
  await client.generate(retryRequest());
  assert.equal(state.calls, 2, "attempt=1 应豁免缓存查询");

  // attempt=1 的响应也不应写缓存：attempt=1 之后，attempt=0 相同请求仍要调 adapter
  await client.generate(auxRequest());
  assert.equal(state.calls, 3, "attempt=1 的响应不应写入缓存");

  // 反向：attempt=0 已缓存后，attempt=1 相同请求仍不命中（计划语义：重试预期新调用）
  await client.generate(auxRequest());
  await client.generate(retryRequest());
  assert.equal(state.calls, 4, "attempt=1 不应读取 attempt=0 的缓存");
});

test("条件排除：带工具的写作调用不缓存（即使携带辅助标记）", async () => {
  const state = countingAdapter();
  const client = makeClient(state.adapter);

  // 真实写作调用：metadata 只带 toolRequest
  const writing = () => auxRequest({
    stage: "drafting",
    metadata: { toolRequest: { kind: "draft_segment", project_id: "p", chapter_no: 1, segment_no: 1, attempt: 1 } }
  });
  await client.generate(writing());
  await client.generate(writing());
  assert.equal(state.calls, 2, "带工具的写作调用不缓存");

  // 防御纵深：即使误带辅助标记 + 工具，仍不缓存
  const mixed = () => auxRequest({
    stage: "drafting",
    metadata: {
      memoryExtract: true, chapterNo: 1, attempt: 0,
      toolRequest: { kind: "draft_segment", project_id: "p", chapter_no: 1, segment_no: 1 }
    }
  });
  await client.generate(mixed());
  await client.generate(mixed());
  assert.equal(state.calls, 4, "带工具请求即使带辅助标记也不缓存");
});

test("条件排除：请求体不同不命中；chat / side_question 不缓存", async () => {
  const state = countingAdapter();
  const client = makeClient(state.adapter);

  await client.generate(auxRequest({ messages: [{ role: "user", content: "内容 A" }] }));
  await client.generate(auxRequest({ messages: [{ role: "user", content: "内容 B" }] }));
  assert.equal(state.calls, 2, "messages 不同不应命中");

  // 不同章节（chapterNo 参与 key）也不命中
  await client.generate(auxRequest({ metadata: { memoryExtract: true, chapterNo: 2, attempt: 0 } }));
  assert.equal(state.calls, 3, "chapterNo 不同不应命中");

  // chat / side_question 不属于辅助集合
  const chat = () => ({ project: {}, stage: "chat", messages: [{ role: "user", content: "你好" }], metadata: { chat: true, round: 0 } });
  await client.generate(chat());
  await client.generate(chat());
  assert.equal(state.calls, 5, "chat 调用不缓存");

  const side = () => ({ project: {}, stage: "side_question", messages: [{ role: "user", content: "查一下" }], metadata: { sideQuestion: true } });
  await client.generate(side());
  await client.generate(side());
  assert.equal(state.calls, 7, "side_question 调用不缓存");
});

test("base_url 不同不命中：会话中切换端点不误用旧端点缓存", async () => {
  const state = countingAdapter();
  const client = makeClient(state.adapter, { model: { base_url: "https://api.deepseek.com" } });

  await client.generate(auxRequest());
  await client.generate(auxRequest());
  assert.equal(state.calls, 1, "相同 base_url 相同请求应命中缓存");

  // 会话中切换端点（官方 → 中转，同名模型）：缓存键应区分 base_url
  client.activeModel = { ...client.activeModel, base_url: "https://relay.example.com/v1" };
  await client.generate(auxRequest());
  assert.equal(state.calls, 2, "端点切换后相同请求不应命中旧端点缓存");

  // 切回原端点：应命中原端点缓存
  client.activeModel = { ...client.activeModel, base_url: "https://api.deepseek.com" };
  await client.generate(auxRequest());
  assert.equal(state.calls, 2, "端点恢复后应命中原端点缓存");
});

test("条件排除：stream=true 的辅助请求不缓存", async () => {
  const state = countingAdapter();
  const client = makeClient(state.adapter, { model: { stream: true } });
  await client.generate(auxRequest());
  await client.generate(auxRequest());
  assert.equal(state.calls, 2, "流式辅助请求不缓存");
});

test("temperature 注入策略：默认不注入（厂商默认）；显式 0 保留确定性缓存；显式非 0 尊重用户值不缓存", async () => {
  // 默认（用户未配置 temperature）：不注入，用厂商接口默认值（2026-08-03 用户决定）；
  // 不满足显式 temperature=0 的确定性前提，不缓存
  // （makeClient 默认带 temperature=0 仅为本文件缓存机制测试的显式约定，这里显式清空模拟用户未配置）
  const state1 = countingAdapter();
  const client1 = makeClient(state1.adapter, { model: { temperature: undefined } });
  await client1.generate(auxRequest());
  assert.equal(state1.seenConfigs[0].temperature, undefined, "默认不注入 temperature，用厂商接口默认值");
  await client1.generate(auxRequest());
  assert.equal(state1.calls, 2, "默认无 temperature=0，不满足确定性前提，不缓存");

  // 用户显式配置 temperature=0：尊重用户值，并保留确定性缓存资格
  const stateZero = countingAdapter();
  const clientZero = makeClient(stateZero.adapter, { model: { temperature: 0 } });
  await clientZero.generate(auxRequest());
  assert.equal(stateZero.seenConfigs[0].temperature, 0, "用户显式配置的 temperature=0 应保留（确定性缓存资格）");
  await clientZero.generate(auxRequest());
  assert.equal(stateZero.calls, 1, "显式 temperature=0 满足确定性前提，应可缓存");

  // 用户已显式配置非 0 temperature：尊重用户值，不覆盖；temperature≠0 则不缓存
  const state2 = countingAdapter();
  const client2 = makeClient(state2.adapter, { model: { temperature: 0.7 } });
  await client2.generate(auxRequest());
  await client2.generate(auxRequest());
  assert.equal(state2.seenConfigs[0].temperature, 0.7, "用户配置的 temperature 不应被覆盖");
  assert.equal(state2.calls, 2, "temperature≠0 不满足确定性前提，不缓存");

  // v4-flash（官方按 thinking 处理，R1）：不注入 temperature 也不缓存(同 reasoner)
  const state3 = countingAdapter();
  const client3 = makeClient(state3.adapter, {
    model: { model_name: "deepseek-v4-flash", base_url: "https://api.deepseek.com", temperature: undefined }
  });
  await client3.generate(auxRequest());
  await client3.generate(auxRequest());
  assert.equal(state3.seenConfigs[0].temperature, undefined, "v4-flash 官方按 thinking 处理，不应注入 temperature");
  assert.equal(state3.calls, 2, "v4-flash 不满足显式 temperature=0，不缓存");
});

// Task 2（模型配置优化）请求体级验证：经 ModelClient → 真实 OpenAI 兼容 adapter → 桩 fetch 捕获请求体。
// 默认不注入 temperature（用厂商接口默认值）；仅用户显式配置的值会进入请求体。
function bodyCaptureAdapter() {
  const captured = [];
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ choices: [{ message: { content: "OK" } }] });
        },
      };
    }
  });
  return { captured, adapter };
}

function bodyRequest(overrides = {}) {
  return {
    project: {},
    stage: "memory_extract",
    prompt: "你好",
    messages: [{ role: "user", content: "提取本章记忆" }],
    metadata: { memoryExtract: true, chapterNo: 1, attempt: 0 },
    ...overrides
  };
}

test("默认不注入 temperature：用户未配置时请求体不带 temperature 字段", async () => {
  const { captured, adapter } = bodyCaptureAdapter();
  const client = new ModelClient({
    adapters: { "openai-compatible": adapter },
    activeModel: {
      provider: "openai-compatible", model_name: "deepseek-chat",
      base_url: "https://api.deepseek.com/v1", api_key: "sk-test"
    }
  });
  await client.generate(bodyRequest());
  assert.equal("temperature" in captured[0], false, "默认不注入 temperature，请求体不应带 temperature 字段");
});

test("用户显式配置 temperature 时注入该值", async () => {
  const { captured, adapter } = bodyCaptureAdapter();
  const client = new ModelClient({
    adapters: { "openai-compatible": adapter },
    activeModel: {
      provider: "openai-compatible", model_name: "deepseek-chat",
      base_url: "https://api.deepseek.com/v1", api_key: "sk-test",
      temperature: 1.1
    }
  });
  await client.generate(bodyRequest());
  assert.equal(captured[0].temperature, 1.1, "用户显式配置的 temperature 应注入请求体");
});

test("reasoner 系模型（v4-pro / deepseek-reasoner）不注入 temperature 也不缓存；显式 0 也不缓存", async () => {
  for (const model_name of ["deepseek-v4-pro", "deepseek-reasoner"]) {
    // 未配置 temperature：不注入
    const state = countingAdapter();
    const client = makeClient(state.adapter, {
      model: { model_name, base_url: "https://api.deepseek.com", temperature: undefined }
    });
    await client.generate(auxRequest());
    await client.generate(auxRequest());
    assert.equal(state.seenConfigs[0].temperature, undefined, `${model_name} 不应注入 temperature（thinking 模式不支持该参数）`);
    assert.equal(state.calls, 2, `${model_name} 不满足显式 temperature=0，不缓存`);

    // 显式配置 temperature=0：值虽合法，但模型 supportsTemperature=false，
    // 确定性前提不成立，同样不缓存
    const stateZero = countingAdapter();
    const clientZero = makeClient(stateZero.adapter, { model: { model_name, base_url: "https://api.deepseek.com", temperature: 0 } });
    await clientZero.generate(auxRequest());
    await clientZero.generate(auxRequest());
    assert.equal(stateZero.seenConfigs[0].temperature, 0, `${model_name} 应尊重用户显式配置的 temperature=0`);
    assert.equal(stateZero.calls, 2, `${model_name} supportsTemperature=false，显式 0 也不缓存`);
  }
});

test("容量上限：LRU 逐出最久未使用条目", async () => {
  const state = countingAdapter();
  const client = makeClient(state.adapter, { client: { responseCacheSize: 2 } });

  // 三个不同请求填满容量（2），最早请求被逐出
  const me1 = () => auxRequest({ metadata: { memoryExtract: true, chapterNo: 1, attempt: 0 } });
  const me2 = () => auxRequest({ metadata: { memoryExtract: true, chapterNo: 2, attempt: 0 } });
  const fc1 = () => auxRequest({ stage: "fact_check", metadata: { factCheck: true, chapterNo: 1, attempt: 0 } });
  await client.generate(me1());
  await client.generate(me2());
  await client.generate(fc1());
  assert.equal(state.calls, 3, "容量填满前应全部直调 adapter");

  // me1 是最久未使用：已被逐出，重新调 adapter
  await client.generate(me1());
  assert.equal(state.calls, 4, "被逐出的条目应重新调 adapter");

  // 最近使用的 fc1 仍应命中（此时缓存 = {fc1, me1}）
  await client.generate(fc1());
  assert.equal(state.calls, 4, "仍驻留的条目应命中缓存");

  // 继续验证 LRU 逐出顺序：fc1 命中后被刷新到最新；随后请求 me2 → 逐出 me1
  // （此时缓存 = {fc1, me2}）；fc1 仍驻留应命中，me1 已被逐出应重新调 adapter
  await client.generate(me2());
  await client.generate(fc1());
  await client.generate(me1());
  assert.equal(state.calls, 6, "me1 被逐出后应重新调 adapter（fc1 命中、me2 命中）");
});

test("失败响应不写缓存：首次调用失败后相同请求仍调 adapter", async () => {
  const state = countingAdapter();
  state.failTimes = 1; // 第一次调用抛错
  const client = makeClient(state.adapter);
  await assert.rejects(() => client.generate(auxRequest()), /模拟 provider 失败/);
  await client.generate(auxRequest());
  assert.equal(state.calls, 2, "失败的调用不应写缓存，第二次仍应调 adapter");
  // 第二次成功后入缓存
  await client.generate(auxRequest());
  assert.equal(state.calls, 2, "成功响应入缓存后第三次应命中");
});

// Task 8（模型配置优化）onActivity 流式通道测试：onActivity 从无参心跳升级为
// 「带 delta 的心跳」——流式分支每个解析出的事件把新增正文文本回调出去（空串也回调）。

// 桩 fetch 返回 SSE chunk 的流式 adapter（沿用本文件 bodyCaptureAdapter 的真实
// OpenAICompatibleAdapter + 桩 fetch 写法；SSE chunk 模式同 provider-adapters.test.mjs）。
function streamingDeltaAdapter(sseChunks) {
  return new OpenAICompatibleAdapter({
    baseUrl: "https://api.example.test/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new Error("streaming path should not call response.text()"); },
      body: {
        getReader() {
          const chunks = sseChunks.map((c) => new TextEncoder().encode(c));
          let index = 0;
          return {
            read() {
              if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
              return Promise.resolve({ done: false, value: chunks[index++] });
            }
          };
        }
      }
    })
  });
}

function streamingDeltaClient(sseChunks, onActivity) {
  return new ModelClient({
    adapters: { "openai-compatible": streamingDeltaAdapter(sseChunks) },
    activeModel: {
      provider: "openai-compatible", model_name: "m",
      base_url: "https://api.example.test/v1", stream: true
    },
    retryMax: 0,
    heartbeatMs: 0, // 聚焦流式 delta，关闭间隔心跳避免 undefined 混入
    onActivity
  });
}

test("onActivity 收到流式 delta 文本", async () => {
  const deltas = [];
  const client = streamingDeltaClient([
    'data: {"choices":[{"delta":{"content":"他推"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"开门，"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"灯光漏进来"}}]}\n\n',
    "data: [DONE]\n\n"
  ], (d) => deltas.push(d));
  await client.generate({ project: {}, stage: "drafting", prompt: "写", messages: [] });
  assert.deepEqual(deltas, ["他推", "开门，", "灯光漏进来"]);
});

test("onActivity 空串也回调：usage-only 帧无正文仍上报（reasoning_content 兜底）", async () => {
  const deltas = [];
  const client = streamingDeltaClient([
    'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n',
    "data: [DONE]\n\n"
  ], (d) => deltas.push(d));
  await client.generate({ project: {}, stage: "drafting", prompt: "写", messages: [] });
  assert.deepEqual(deltas, ["思考中", ""]);
});
