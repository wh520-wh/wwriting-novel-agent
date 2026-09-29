// DeepSeek 流式客户端测试：用假 fetchImpl 返回 DeepSeek 风格 data: 分片。
// 覆盖文本增量、跨 chunk 边界的半行拼接、工具调用分片、usage、[DONE] 之后的截断、
// 取消（AbortError）与非 2xx 的中文错误映射；绝不接触真实网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekClient, ModelRequestError } from '../../src/model/deepseek-client.mjs';

const API_KEY = 'sk-test0000000000TEST';
const MODEL = 'deepseek-chat';

function config(overrides = {}) {
  return { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: MODEL, apiKey: API_KEY, ...overrides };
}

// 把若干 SSE data 载荷打包成 DeepSeek 风格分片（每个事件后跟一个空行）。
function sseChunks(payloads) {
  return payloads.map((payload) => `data: ${payload}\n\n`);
}

// 假响应：body 为 ReadableStream，逐段吐出真实的分片边界。
function fakeResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    text: async () => chunks.join(''),
  };
}

// 记录请求的假 fetch；chunks 可为数组或 () => chunks（惰性构造）。
function fakeFetch(chunks, { status = 200, throwError = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throwError) throw throwError;
    // chunks 为函数时由调用方自己构造响应（例如需要流中途报错的场景）。
    return typeof chunks === 'function' ? chunks() : fakeResponse(chunks, { status });
  };
  return { calls, fetchImpl };
}

function lastBody(calls) {
  return JSON.parse(calls[calls.length - 1].init.body);
}

// 收集一轮流式回调，返回便于断言的聚合结果。
function collector() {
  const deltas = [];
  const toolCalls = [];
  const usages = [];
  return {
    deltas,
    toolCalls,
    usages,
    handlers: {
      onDelta: (text) => deltas.push(text),
      onToolCall: (call) => toolCalls.push(call),
      onUsage: (usage) => usages.push(usage),
    },
  };
}

async function run(fetchImpl, options = {}, clientConfig = {}) {
  const sink = collector();
  const client = createDeepSeekClient({ fetchImpl, config: config(clientConfig) });
  const result = await client.streamChat({
    messages: [{ role: 'user', content: '写一段开头' }],
    ...sink.handlers,
    ...options,
  });
  return { ...sink, result };
}

test('文本增量：多个 data 分片按序回调，正文完整拼接', async () => {
  const { calls, fetchImpl } = fakeFetch(sseChunks([
    JSON.stringify({ choices: [{ delta: { content: '第一章' } }] }),
    JSON.stringify({ choices: [{ delta: { content: '的雨' } }] }),
    '[DONE]',
  ]));

  const { deltas, result } = await run(fetchImpl);

  assert.deepEqual(deltas, ['第一章', '的雨']);
  assert.equal(result.text, '第一章的雨');
  const body = lastBody(calls);
  assert.equal(body.stream, true);
  assert.equal(body.model, MODEL);
});

test('请求固定打到 /chat/completions，带 Bearer 头，tools 存在时才下发', async () => {
  const { calls, fetchImpl } = fakeFetch(sseChunks(['[DONE]']));
  const tools = [{ type: 'function', function: { name: 'write_file' } }];

  await run(fetchImpl, { tools });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(lastBody(calls).tools, tools);
});

test('没有 tools 时不写入 tools 字段', async () => {
  const { calls, fetchImpl } = fakeFetch(sseChunks(['[DONE]']));

  await run(fetchImpl);

  assert.equal('tools' in lastBody(calls), false);
});

test('跨 chunk 边界的半个 data 行能被缓冲并正确拼接', async () => {
  // 一个事件被切成三刀：行首、行中、行尾，中间还夹着别的完整事件。
  const { fetchImpl } = fakeFetch([
    'data: {"choices":[{"delta":{"content":"前半"',
    '}}]}\n\ndata: {"choices":[{"delta":{"content":"中段"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"后',
    '半"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  const { deltas, result } = await run(fetchImpl);

  assert.deepEqual(deltas, ['前半', '中段', '后半']);
  assert.equal(result.text, '前半中段后半');
});

test('工具调用分片：id / name / arguments 分多次到达后合并为一次回调', async () => {
  const { fetchImpl } = fakeFetch(sseChunks([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ch01.md"}' } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ]));

  const { toolCalls, result } = await run(fetchImpl);

  assert.equal(toolCalls.length, 1);
  assert.deepEqual(toolCalls[0], { id: 'call_1', name: 'write_file', arguments: '{"path":"ch01.md"}' });
  assert.deepEqual(JSON.parse(toolCalls[0].arguments), { path: 'ch01.md' });
  assert.equal(result.finishReason, 'tool_calls');
});

test('usage：流末回调一次，字段归一化为驼峰', async () => {
  const { fetchImpl } = fakeFetch(sseChunks([
    JSON.stringify({ choices: [{ delta: { content: '正文' } }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } }),
    '[DONE]',
  ]));

  const { usages, result } = await run(fetchImpl);

  assert.equal(usages.length, 1);
  assert.deepEqual(usages[0], {
    promptTokens: 12, completionTokens: 34, totalTokens: 46,
    promptCacheHitTokens: null, promptCacheMissTokens: null, reasoningTokens: null,
  });
  assert.deepEqual(result.usage, {
    promptTokens: 12, completionTokens: 34, totalTokens: 46,
    promptCacheHitTokens: null, promptCacheMissTokens: null, reasoningTokens: null,
  });
});

// —— usage：缓存命中与思考 tokens ——
// ADR-0006 的 Consequences 原文要求收下 prompt_cache_hit_tokens / prompt_cache_miss_tokens：
// 它既是给用户看的省钱事实，也是验证「每轮重读 + 哈希短路」是否真保住缓存的观测手段。
// reasoning_tokens 则是 D10(b)：用户把强度调到 max 却看不见思考内容时，这是唯一的客观证据。

const RICH_USAGE_FRAME = JSON.stringify({
  choices: [],
  usage: {
    prompt_tokens: 5000, completion_tokens: 1200, total_tokens: 6200,
    prompt_cache_hit_tokens: 4800, prompt_cache_miss_tokens: 200,
    completion_tokens_details: { reasoning_tokens: 800 },
  },
});
const PLAIN_USAGE_FRAME = JSON.stringify({
  choices: [], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
});
const TEXT_FRAME = JSON.stringify({ choices: [{ delta: { content: '好' } }] });

test('usage 收下缓存命中/未命中与思考 tokens', async () => {
  const { fetchImpl } = fakeFetch(sseChunks([TEXT_FRAME, RICH_USAGE_FRAME]));
  const { usages } = await run(fetchImpl);
  assert.deepEqual(usages[0], {
    promptTokens: 5000, completionTokens: 1200, totalTokens: 6200,
    promptCacheHitTokens: 4800, promptCacheMissTokens: 200, reasoningTokens: 800,
  });
});

test('服务端没给这些字段时一律是 null，不编一个 0 出来', async () => {
  const { fetchImpl } = fakeFetch(sseChunks([TEXT_FRAME, PLAIN_USAGE_FRAME]));
  const { usages } = await run(fetchImpl);
  assert.deepEqual(
    { hit: usages[0].promptCacheHitTokens, miss: usages[0].promptCacheMissTokens, reasoning: usages[0].reasoningTokens },
    { hit: null, miss: null, reasoning: null },
  );
});

test('completion_tokens_details 不是对象时不炸', async () => {
  const { fetchImpl } = fakeFetch(sseChunks([
    TEXT_FRAME,
    JSON.stringify({ choices: [], usage: { total_tokens: 46, completion_tokens_details: null } }),
  ]));
  const { usages } = await run(fetchImpl);
  assert.equal(usages[0].reasoningTokens, null);
});

test('[DONE] 之后的数据不再解析', async () => {
  const { fetchImpl } = fakeFetch([
    'data: {"choices":[{"delta":{"content":"保留"}}]}\n\n',
    'data: [DONE]\n\n',
    'data: {"choices":[{"delta":{"content":"丢弃"}}]}\n\n',
  ]);

  const { deltas, result } = await run(fetchImpl);

  assert.deepEqual(deltas, ['保留']);
  assert.equal(result.text, '保留');
});

test('reasoning 私有字段不进可见文本，也不触发 onDelta', async () => {
  const { fetchImpl } = fakeFetch(sseChunks([
    JSON.stringify({ choices: [{ delta: { reasoning_content: '先想一遍' } }] }),
    JSON.stringify({ choices: [{ delta: { content: '成稿' } }] }),
    '[DONE]',
  ]));

  const { deltas, result } = await run(fetchImpl);

  assert.deepEqual(deltas, ['成稿']);
  assert.equal(result.text, '成稿');
});

test('取消：AbortError 映射为用户取消，而不是网络故障', async () => {
  const controller = new AbortController();
  const abortError = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const { fetchImpl } = fakeFetch([], { throwError: abortError });

  await assert.rejects(
    () => run(fetchImpl, { signal: controller.signal }),
    (error) => {
      assert.ok(error instanceof ModelRequestError);
      assert.equal(error.code, 'MODEL_ABORTED');
      assert.match(error.message, /[\u4e00-\u9fff]/);
      assert.equal(error.message.includes('网络'), false);
      return true;
    },
  );
});

test('取消：流中途被中断同样识别为用户取消', async () => {
  const controller = new AbortController();
  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
  let pulls = 0;
  const { fetchImpl } = fakeFetch(() => {
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        // 先正常吐出一帧，下一次拉取时才中断：模拟流中途被取消。
        pull(c) {
          pulls += 1;
          if (pulls === 1) {
            c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"已生成"}}]}\n\n'));
            return;
          }
          c.error(abortError);
        },
      }),
      text: async () => '',
    };
  });

  let error = null;
  const sink = collector();
  const client = createDeepSeekClient({ fetchImpl, config: config() });
  try {
    await client.streamChat({ messages: [{ role: 'user', content: '写' }], signal: controller.signal, ...sink.handlers });
  } catch (caught) {
    error = caught;
  }

  // 中断发生在流中途：中断前的增量已经送达，之后整体收敛为“用户取消”。
  assert.deepEqual(sink.deltas, ['已生成']);
  assert.equal(error && error.code, 'MODEL_ABORTED');
  assert.match(error.message, /[\u4e00-\u9fff]/);
});

test('非 2xx：401 给出中文可读错误，状态码与技术细节放在详情里且不回显 key', async () => {
  const { fetchImpl } = fakeFetch([JSON.stringify({ error: { message: 'Authentication Fails, incorrect api key' } })], { status: 401 });

  await assert.rejects(() => run(fetchImpl), (error) => {
    assert.ok(error instanceof ModelRequestError);
    assert.equal(error.code, 'MODEL_HTTP_ERROR');
    assert.match(error.message, /[\u4e00-\u9fff]/);
    assert.equal(error.details.status, 401);
    const detail = JSON.stringify(error.details);
    assert.equal(detail.includes(API_KEY), false);
    assert.equal(detail.includes('Authorization'), false);
    return true;
  });
});

test('非 2xx：429 与 500 分别给出对应的中文事实', async () => {
  const tooMany = fakeFetch(['{"error":{"message":"rate limit"}}'], { status: 429 });
  await assert.rejects(() => run(tooMany.fetchImpl), (error) => {
    assert.equal(error.code, 'MODEL_HTTP_ERROR');
    assert.match(error.message, /频繁|额度|重试/);
    return true;
  });

  const serverError = fakeFetch(['{"error":{"message":"internal"}}'], { status: 503 });
  await assert.rejects(() => run(serverError.fetchImpl), (error) => {
    assert.equal(error.code, 'MODEL_HTTP_ERROR');
    assert.match(error.message, /暂时不可用|稍后重试/);
    return true;
  });
});

test('网络故障映射为网络错误，不伪装成取消', async () => {
  const { fetchImpl } = fakeFetch([], { throwError: Object.assign(new TypeError('fetch failed'), { code: 'ENOTFOUND' }) });

  await assert.rejects(() => run(fetchImpl), (error) => {
    assert.equal(error.code, 'MODEL_NETWORK_ERROR');
    assert.match(error.message, /[\u4e00-\u9fff]/);
    return true;
  });
});

test('未配置 API Key 或未设置模型：抛中文错误且不发起请求', async () => {
  const noKey = fakeFetch(sseChunks(['[DONE]']));
  await assert.rejects(() => run(noKey.fetchImpl, {}, { apiKey: null }), (error) => {
    assert.equal(error.code, 'MODEL_NOT_CONFIGURED');
    assert.match(error.message, /[\u4e00-\u9fff]/);
    assert.equal(error.message.includes(API_KEY), false);
    return true;
  });
  assert.equal(noKey.calls.length, 0);

  const noModel = fakeFetch(sseChunks(['[DONE]']));
  await assert.rejects(() => run(noModel.fetchImpl, {}, { model: null }), (error) => {
    assert.equal(error.code, 'MODEL_NOT_CONFIGURED');
    assert.match(error.message, /[\u4e00-\u9fff]/);
    return true;
  });
  assert.equal(noModel.calls.length, 0);
});

test('下游回调抛错必须原样冒泡，不能被改写成模型响应中断', async () => {
  const boom = new Error('渲染器炸了');
  const { fetchImpl } = fakeFetch(sseChunks([
    JSON.stringify({ choices: [{ delta: { content: '第一章' } }] }),
    '[DONE]',
  ]));

  let caught = null;
  try {
    await run(fetchImpl, { onDelta: () => { throw boom; } });
  } catch (error) {
    caught = error;
  }

  // 抛出的必须是回调自己抛的那个对象，连包装都不许有。
  assert.equal(caught, boom);
  assert.equal(caught instanceof ModelRequestError, false);
  assert.equal(caught && caught.code, undefined);
});

test('工具调用回调抛错同样原样冒泡', async () => {
  const boom = new Error('工具执行器炸了');
  const { fetchImpl } = fakeFetch(sseChunks([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] } }] }),
    '[DONE]',
  ]));

  await assert.rejects(
    () => run(fetchImpl, { onToolCall: () => { throw boom; } }),
    (error) => {
      assert.equal(error, boom);
      assert.equal(error instanceof ModelRequestError, false);
      return true;
    },
  );
});

test('回调抛错后异步迭代器被关闭，底层响应流被取消（不漏连接）', async () => {
  const boom = new Error('渲染器炸了');
  const encoder = new TextEncoder();
  let cancelled = false;
  const { fetchImpl } = fakeFetch(() => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"第一章"}}]}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    }),
    text: async () => '',
  }));

  let caught = null;
  try {
    await run(fetchImpl, { onDelta: () => { throw boom; } });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, boom);
  assert.equal(cancelled, true);
});

test('流中途读失败（TypeError）映射为响应中断，不裸抛底层错误', async () => {
  const encoder = new TextEncoder();
  let pulls = 0;
  const { fetchImpl } = fakeFetch(() => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      pull(c) {
        pulls += 1;
        if (pulls === 1) {
          c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"已生成"}}]}\n\n'));
          return;
        }
        c.error(Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }));
      },
    }),
    text: async () => '',
  }));

  await assert.rejects(() => run(fetchImpl), (error) => {
    assert.ok(error instanceof ModelRequestError);
    assert.equal(error.code, 'MODEL_STREAM_ERROR');
    assert.match(error.message, /[\u4e00-\u9fff]/);
    assert.equal(error.details.causeCode, 'ECONNRESET');
    return true;
  });
});

test('baseUrl / apiKey / model 沿用 config.mjs 的同一份归一化', async () => {
  const trailing = fakeFetch(sseChunks(['[DONE]']));
  await run(trailing.fetchImpl, {}, { baseUrl: 'https://custom.example.com/' });
  assert.equal(trailing.calls[0].url, 'https://custom.example.com/chat/completions');

  const blank = fakeFetch(sseChunks(['[DONE]']));
  await run(blank.fetchImpl, {}, { baseUrl: '   ', apiKey: `  ${API_KEY}  `, model: `  ${MODEL}  ` });
  // 空白端点回落到官方默认；带空白的 key 与模型名先 trim 再用。
  assert.equal(blank.calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(blank.calls[0].init.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(JSON.parse(blank.calls[0].init.body).model, MODEL);
});

test('空响应体给出中文错误，不静默返回空结果', async () => {
  const { fetchImpl } = fakeFetch([]);

  await assert.rejects(() => run(fetchImpl), (error) => {
    assert.equal(error.code, 'MODEL_EMPTY_RESPONSE');
    assert.match(error.message, /[\u4e00-\u9fff]/);
    return true;
  });
});

// —— GET /models：首次引导用它拿「真实存在」的模型名，而不是代码里写死的名字 ——

// 假 JSON 响应：listModels 只看 status 与 json()。
function fakeJsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test('listModels：GET /models，带 Bearer 鉴权，返回去重后的模型 id', async () => {
  const { calls, fetchImpl } = fakeFetch(() => fakeJsonResponse({
    object: 'list',
    data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }],
  }));

  const models = await createDeepSeekClient({ fetchImpl, config: config() }).listModels();

  assert.deepEqual(models, ['deepseek-chat', 'deepseek-reasoner']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/models');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${API_KEY}`);
});

test('listModels：端点规范化与流式请求一致（尾斜杠不会拼出 //models）', async () => {
  const { calls, fetchImpl } = fakeFetch(() => fakeJsonResponse({ data: [{ id: 'm' }] }));

  await createDeepSeekClient({
    fetchImpl,
    config: config({ baseUrl: 'https://api.deepseek.com///' }),
  }).listModels();

  assert.equal(calls[0].url, 'https://api.deepseek.com/models');
});

test('listModels：没有 key 时不发请求，直接给未配置的中文事实', async () => {
  const { calls, fetchImpl } = fakeFetch(() => fakeJsonResponse({ data: [] }));

  await assert.rejects(
    () => createDeepSeekClient({ fetchImpl, config: config({ apiKey: null }) }).listModels(),
    (error) => {
      assert.equal(error.code, 'MODEL_NOT_CONFIGURED');
      assert.match(error.message, /[\u4e00-\u9fff]/);
      assert.ok(!error.message.includes(API_KEY));
      return true;
    },
  );
  assert.equal(calls.length, 0, '未配置就不该发请求');
});

test('listModels：非 2xx 只给一条中文事实，key 不出现在任何地方', async () => {
  const { fetchImpl } = fakeFetch(() => fakeJsonResponse(
    { error: { message: `bad key ${API_KEY}` } },
    { status: 401 },
  ));

  await assert.rejects(
    () => createDeepSeekClient({ fetchImpl, config: config() }).listModels(),
    (error) => {
      assert.equal(error.code, 'MODEL_HTTP_ERROR');
      assert.equal(error.message, 'API Key 无效或没有权限。输入 /model 重新设置。');
      const dumped = JSON.stringify(error.details);
      assert.ok(!dumped.includes(API_KEY), '服务端回显的 key 也要脱敏');
      return true;
    },
  );
});

test('listModels：列表为空或结构不对时给中文事实，不返回空数组当成功', async () => {
  for (const payload of [{ object: 'list', data: [] }, { object: 'list' }, null]) {
    const { fetchImpl } = fakeFetch(() => fakeJsonResponse(payload));
    await assert.rejects(
      () => createDeepSeekClient({ fetchImpl, config: config() }).listModels(),
      (error) => {
        assert.equal(error.code, 'MODEL_EMPTY_RESPONSE');
        assert.match(error.message, /[\u4e00-\u9fff]/);
        return true;
      },
    );
  }
});

test('listModels：连不上时是网络类中文事实，不是裸的 fetch 错误', async () => {
  const { fetchImpl } = fakeFetch([], { throwError: new TypeError('fetch failed') });

  await assert.rejects(
    () => createDeepSeekClient({ fetchImpl, config: config() }).listModels(),
    (error) => {
      assert.equal(error.code, 'MODEL_NETWORK_ERROR');
      assert.match(error.message, /[\u4e00-\u9fff]/);
      return true;
    },
  );
});

// —— 思考强度双发（P13）——
// 绝不赌服务端默认：2026-08 实测默认值按时间窗漂移，思考内容时有时无。

const ONE_FRAME = [JSON.stringify({ choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] })];

async function bodyWith(effort) {
  const { fetchImpl, calls } = fakeFetch(sseChunks(ONE_FRAME));
  const client = createDeepSeekClient({
    fetchImpl,
    config: config({}),
    ...(effort === undefined ? {} : { effort }),
  });
  await client.streamChat({ messages: [{ role: 'user', content: 'hi' }] });
  return lastBody(calls);
}

test('low/high/max 双发 reasoning_effort 与 thinking.type=enabled；none 只发 thinking.type=disabled', async () => {
  for (const level of ['low', 'high', 'max']) {
    const body = await bodyWith(level);
    assert.equal(body.reasoning_effort, level);
    assert.deepEqual(body.thinking, { type: 'enabled' });
  }
  // 官方 OpenAI 格式的 reasoning_effort 枚举不含 none：关思考只靠 thinking.type。
  const noneBody = await bodyWith('none');
  assert.equal('reasoning_effort' in noneBody, false);
  assert.deepEqual(noneBody.thinking, { type: 'disabled' });
});

test('档位为 null（自动）时 payload 里两个思考字段都不出现', async () => {
  const body = await bodyWith(null);
  assert.equal('reasoning_effort' in body, false);
  assert.equal('thinking' in body, false);
});

test('不传 effort 选项时同样两个字段都不出现（既有调用点不受影响）', async () => {
  const body = await bodyWith(undefined);
  assert.equal('reasoning_effort' in body, false);
  assert.equal('thinking' in body, false);
});

test('不认识的档位值不会漏进 payload', async () => {
  const body = await bodyWith('turbo');
  assert.equal('reasoning_effort' in body, false);
  assert.equal('thinking' in body, false);
});

test('payload 里仍然没有 tool_choice（思考模式下 required 与具名选择会 400）', async () => {
  const body = await bodyWith('max');
  assert.equal('tool_choice' in body, false);
});

test('带 tools 时 tools 与思考字段并存，互不覆盖', async () => {
  const { fetchImpl, calls } = fakeFetch(sseChunks(ONE_FRAME));
  const client = createDeepSeekClient({ fetchImpl, config: config({}), effort: 'max' });
  await client.streamChat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'count_text', parameters: { type: 'object' } } }],
  });
  const body = lastBody(calls);
  assert.equal(body.reasoning_effort, 'max');
  assert.equal(body.tools.length, 1);
});

// —— max_tokens：给足空间，不赌服务端默认（Task 8）——

test('payload 带 max_tokens，官方端点最新模型给 393216', async () => {
  const { fetchImpl, calls } = fakeFetch(sseChunks(ONE_FRAME));
  const client = createDeepSeekClient({ fetchImpl, config: config({ model: 'deepseek-v4-pro' }) });
  await client.streamChat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(lastBody(calls).max_tokens, 393_216);
});

test('payload 的 max_tokens 对非官方端点走保守值 65536', async () => {
  const { fetchImpl, calls } = fakeFetch(sseChunks(ONE_FRAME));
  const client = createDeepSeekClient({
    fetchImpl,
    config: config({ baseUrl: 'https://gateway.example/v1', model: 'deepseek-v4-pro' }),
  });
  await client.streamChat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(lastBody(calls).max_tokens, 65_536);
});

// —— 采集 reasoning_content ——
// 采集是渲染的前提（D14 的第 1 层）。两条铁律照守：
// 思考正文**绝不进 text**、**绝不混入可见正文通道**（上游对话样式规格书:181 的后半句）。

test('reasoning_content 经 onReasoning 逐片回调，且一个字都不进 onDelta', async () => {
  const reasoning = [];
  const { fetchImpl } = fakeFetch(sseChunks([
    JSON.stringify({ choices: [{ delta: { reasoning_content: '先想想' } }] }),
    JSON.stringify({ choices: [{ delta: { reasoning_content: '主角的名字' } }] }),
    JSON.stringify({ choices: [{ delta: { content: '沈砚。' }, finish_reason: 'stop' }] }),
  ]));
  const { deltas, result } = await run(fetchImpl, { onReasoning: (delta) => reasoning.push(delta) });
  assert.deepEqual(reasoning, ['先想想', '主角的名字']);
  assert.deepEqual(deltas, ['沈砚。']);
  assert.equal(result.text, '沈砚。', '返回值里的 text 只含可见正文');
  assert.equal(result.text.includes('先想想'), false, '思考正文绝不混入可见正文');
});

test('没给 onReasoning 时思考正文被丢弃，行为与上线前一致', async () => {
  const { fetchImpl } = fakeFetch(sseChunks([
    JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] }),
    JSON.stringify({ choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] }),
  ]));
  const { deltas, result } = await run(fetchImpl);
  assert.deepEqual(deltas, ['好']);
  assert.equal(result.text, '好');
});

test('reasoning_content 是空串时不回调（不制造零长度的片段）', async () => {
  const reasoning = [];
  const { fetchImpl } = fakeFetch(sseChunks([
    JSON.stringify({ choices: [{ delta: { reasoning_content: '' } }] }),
    JSON.stringify({ choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] }),
  ]));
  await run(fetchImpl, { onReasoning: (delta) => reasoning.push(delta) });
  assert.deepEqual(reasoning, []);
});

test('onReasoning 抛错时原样冒泡，不被改写成「模型响应中断」', async () => {
  const { fetchImpl } = fakeFetch(sseChunks([
    JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] }),
  ]));
  // deepseek-client.mjs:326-328 的注释写明了这条契约：解析与回调都在 try 之外，
  // 下游回调抛错必须原样冒泡，不能被掩盖成本地看不懂的「响应中断」。
  await assert.rejects(
    run(fetchImpl, { onReasoning: () => { throw new Error('下游炸了'); } }),
    /下游炸了/,
  );
});
