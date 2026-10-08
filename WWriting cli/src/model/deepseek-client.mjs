// DeepSeek 官方流式客户端（OpenAI-compatible Chat Completions + SSE）。
// 固定请求 /chat/completions、stream: true、tools（存在时才下发）、AbortSignal；
// 逐行解析 SSE，跨 chunk 边界的半个 data: 行由缓冲区拼接，[DONE] 之后一律不再解析。
// reasoning_content 经独立的 onReasoning 回调出去：绝不进可见正文，也绝不进回喂给模型的 messages。
// 错误分两类呈现给用户：message 是一条中文事实（2–6 字级别的直白话），
// 状态码、原因等细节放进 details 供折叠详情使用；key 绝不出现在任何一处。
// baseUrl / apiKey / model 的归一化沿用 config.mjs 的同一份实现：
// 加载配置时算出来的地址与 key，必须就是发请求时用的那一个，绝不各算一遍。
import { normalizeBaseUrl, pickString } from './config.mjs';
import { effortRequestFields } from './effort.mjs';
import { resolveModelLimits } from './model-limits.mjs';

// 模型请求错误：code 供调用方判断（MODEL_ABORTED = 用户取消，不是故障）。
export class ModelRequestError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ModelRequestError';
    this.code = code;
    this.details = details;
  }
}

const noop = () => {};

// 把文本里出现的密钥替换掉：错误详情可能带上服务端回显的原文，先脱敏再外传。
function redact(text, secrets) {
  let out = typeof text === 'string' ? text : '';
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret !== '') out = out.split(secret).join('***');
  }
  return out;
}

function isAbortError(error, signal) {
  if (error && (error.name === 'AbortError' || error.code === 20 || error.code === 'ABORT_ERR')) return true;
  // signal 已中止时，底层抛出的网络类错误也应归为“用户取消”。
  return Boolean(signal && signal.aborted);
}

function abortError() {
  return new ModelRequestError('已取消本轮生成。', 'MODEL_ABORTED', { aborted: true });
}

function httpMessage(status) {
  if (status === 401 || status === 403) return 'API Key 无效或没有权限。输入 /model 重新设置。';
  if (status === 404) return '模型接口不存在或模型名不对，输入 /model 重新选一个。';
  if (status === 429) return '请求过于频繁或额度不足，请稍后重试。';
  if (status >= 500) return 'DeepSeek 服务暂时不可用，请稍后重试。';
  return '模型请求失败，请稍后重试。';
}

// usage 归一化：服务端字段名（snake_case）→ 本项目字段名（camelCase）。
// 三组数字各有各的用途，绝不混用：
//   · prompt/completion/total —— 花了多少钱；
//   · promptCacheHit/Miss     —— ADR-0006 的观测手段：「每轮重读 + 哈希短路」到底有没有保住前缀缓存。
//                                DeepSeek 的上下文缓存自动开启、按前缀完全匹配命中，而
//                                WWRITING.md 注入在 system 之后历史之前，它变一个字符后面整段历史全失效。
//   · reasoningTokens         —— D10(b)：思考强度可调之后，用户需要「强度真的变了」的客观证据。
//                                不泄漏思考内容，只给量（铁律 6 同源：客观数字不能只有模型知道）。
// 缺失一律是 null，不是 0：老事件、被中断的轮、不给这些字段的网关本来就没有，
// 编一个 0 出来会让人以为「这轮没命中缓存 / 没思考」。
function normalizeUsage(usage) {
  const toNumber = (value) => (Number.isFinite(value) ? value : null);
  const details = usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object'
    ? usage.completion_tokens_details
    : {};
  return {
    promptTokens: toNumber(usage.prompt_tokens ?? usage.promptTokens),
    completionTokens: toNumber(usage.completion_tokens ?? usage.completionTokens),
    totalTokens: toNumber(usage.total_tokens ?? usage.totalTokens),
    promptCacheHitTokens: toNumber(usage.prompt_cache_hit_tokens ?? usage.promptCacheHitTokens),
    promptCacheMissTokens: toNumber(usage.prompt_cache_miss_tokens ?? usage.promptCacheMissTokens),
    reasoningTokens: toNumber(details.reasoning_tokens ?? details.reasoningTokens ?? usage.reasoning_tokens),
  };
}

// 读取响应体：优先按异步迭代逐块取（Node 的 ReadableStream 与测试注入的生成器都支持），
// 其次是 getReader()，最后退回 res.text() 一次性读。
async function* readChunks(response) {
  const body = response.body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield chunk;
    return;
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      if (typeof reader.releaseLock === 'function') reader.releaseLock();
    }
    return;
  }
  if (typeof response.text === 'function') {
    yield await response.text();
  }
}

function decodeChunk(decoder, chunk) {
  if (typeof chunk === 'string') return chunk;
  if (chunk == null) return '';
  return decoder.decode(chunk, { stream: true });
}

// 非 2xx 的错误正文尽量取出服务端给的原因，再脱敏后放进详情。
async function readErrorDetail(response, secrets) {
  let raw = '';
  try {
    if (typeof response.text === 'function') raw = await response.text();
  } catch {
    raw = '';
  }
  const text = redact(raw.slice(0, 500), secrets);
  if (text === '') return null;
  try {
    const parsed = JSON.parse(text);
    const message = parsed && parsed.error && parsed.error.message;
    return typeof message === 'string' && message !== '' ? message : text;
  } catch {
    return text;
  }
}

// createDeepSeekClient({ fetchImpl, config, clock, effort }) → { streamChat, listModels }。
// fetchImpl 可注入（测试与验收用假服务）；config 取 loadModelConfig 的返回值；
// clock 可注入（毫秒时间戳），只用于统计本轮耗时；
// effort 是本次请求要下发的思考档位（null = 不发任何思考字段，既有调用点行为不变）。
export function createDeepSeekClient({ fetchImpl = globalThis.fetch, config = {}, clock = Date.now, effort = null } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new ModelRequestError('模型客户端需要可用的网络请求实现。', 'MODEL_CLIENT_INVALID', {});
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const apiKey = pickString(config, 'apiKey');
  const model = pickString(config, 'model');
  const url = `${baseUrl}/chat/completions`;
  const modelsUrl = `${baseUrl}/models`;
  const secrets = apiKey === null ? [] : [apiKey];

  // 列出端点当前可用的模型（GET /models，与 /chat/completions 同一套鉴权与错误映射）。
  // 首次使用的引导页用它拿到**真实存在**的模型名，而不是把一个可能失效的名字硬编码进配置。
  // 只返回模型 id；非 2xx、响应不是 JSON、列表为空都给一条中文事实，细节进 details。
  async function listModels({ signal = null } = {}) {
    if (signal && signal.aborted) throw abortError();
    if (apiKey === null) {
      throw new ModelRequestError('尚未配置 DeepSeek API Key，输入 /model 跟着走一遍就好。', 'MODEL_NOT_CONFIGURED', {
        reason: 'missing_api_key',
      });
    }

    let response;
    try {
      response = await fetchImpl(modelsUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        signal,
      });
    } catch (error) {
      if (isAbortError(error, signal)) throw abortError();
      throw new ModelRequestError('无法连接 DeepSeek 服务，请检查网络后重试。', 'MODEL_NETWORK_ERROR', {
        url: modelsUrl,
        causeCode: error && error.code,
        detail: redact(error && error.message, secrets),
      });
    }

    const status = Number(response && response.status);
    if (!(status >= 200 && status < 300)) {
      const detail = await readErrorDetail(response, secrets);
      throw new ModelRequestError(httpMessage(Number.isFinite(status) ? status : 0), 'MODEL_HTTP_ERROR', {
        url: modelsUrl,
        status: Number.isFinite(status) ? status : null,
        detail,
      });
    }

    let payload;
    try {
      payload = typeof response.json === 'function' ? await response.json() : null;
    } catch (error) {
      throw new ModelRequestError('模型列表返回的内容无法解析。', 'MODEL_EMPTY_RESPONSE', {
        url: modelsUrl,
        detail: redact(error && error.message, secrets),
      });
    }

    const rows = payload && Array.isArray(payload.data) ? payload.data : [];
    const ids = [];
    for (const row of rows) {
      const id = pickString(row, 'id');
      if (id !== null && !ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0) {
      throw new ModelRequestError('端点没有返回可用的模型。', 'MODEL_EMPTY_RESPONSE', { url: modelsUrl });
    }
    return ids;
  }

  async function streamChat({
    messages = [],
    tools = null,
    signal = null,
    onDelta = noop,
    onReasoning = noop,
    onToolCall = noop,
    onUsage = noop,
  } = {}) {
    if (signal && signal.aborted) throw abortError();
    if (apiKey === null) {
      throw new ModelRequestError('尚未配置 DeepSeek API Key，输入 /model 跟着走一遍就好。', 'MODEL_NOT_CONFIGURED', {
        reason: 'missing_api_key',
      });
    }
    if (model === null) {
      throw new ModelRequestError('尚未设置模型，请用 /model <模型名> 设置。', 'MODEL_NOT_CONFIGURED', {
        reason: 'missing_model',
      });
    }
    // 模型名位置上放着一个 API Key（把 `/model <模型名>` 当成「设 Key」用，是很容易踩的一步）：
    // 本地就拦下来。否则请求会带着一个不存在的模型名出去，服务端回的却是「API Key 无效或没有权限」，
    // 用户会一路去查自己的 Key，越查越远。
    if (/^sk-/i.test(model)) {
      throw new ModelRequestError('模型名看起来是 API Key，请用 /model <模型名> 重新设置。', 'MODEL_NAME_INVALID', {
        reason: 'model_looks_like_key',
      });
    }
    if (!Array.isArray(messages)) {
      throw new ModelRequestError('消息格式不正确，无法发送给模型。', 'MODEL_REQUEST_INVALID', { reason: 'messages' });
    }

    const payload = {
      model,
      messages,
      stream: true,
      // DeepSeek 只在开启 include_usage 时才在流末给出用量。
      stream_options: { include_usage: true },
    };
    // 思考强度**双发**（P13）：reasoning_effort 是用户可见的档位，thinking.type 是防默认漂移的钉子。
    // 绝不赌服务端默认——2026-08 实测默认值按时间窗漂移，思考内容时有时无。
    //
    // 档位为 null（自动）或未知时 effortRequestFields 返回 null，这里一个 effort 字段都不加：
    // **不发 `reasoning_effort`、也不发 `thinking`**。这样不支持思考的端点永远收不到它可能拒收的字段。
    // （注意这不等于「payload 与上线前逐字一致」——`max_tokens` 现在恒定下发，见下面 max_tokens 一处。）
    //
    // 注意这里**不加 tool_choice**：思考模式下 tool_choice 的 required 与具名选择会返回 400。
    // 省略该字段即服务端默认（auto），当前不冲突；将来若想强制调某个工具，必须先关思考。
    const effortFields = effortRequestFields(effort);
    if (effortFields !== null) Object.assign(payload, effortFields);
    if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;
    // max_tokens 给足空间（Task 8）：取该模型的输出上限，而不是赌服务端默认
    // （默认值按时间窗/档位漂移）。历史和压缩通过 getLimits 读取同一份窗口记录。
    payload.max_tokens = resolveModelLimits({ baseUrl: config.baseUrl, model }).maxOutputTokens;

    const startedAt = clock();
    let response;
    let received = false;
    let text = '';
    let finishReason = null;
    let pendingUsage = null;
    const toolParts = new Map();

    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (isAbortError(error, signal)) throw abortError();
      throw new ModelRequestError('无法连接 DeepSeek 服务，请检查网络后重试。', 'MODEL_NETWORK_ERROR', {
        url,
        causeCode: error && error.code,
        detail: redact(error && error.message, secrets),
      });
    }

    if (!response || typeof response !== 'object') {
      throw new ModelRequestError('模型没有返回有效响应，请稍后重试。', 'MODEL_EMPTY_RESPONSE', { url });
    }
    const status = Number(response.status);
    if (!(status >= 200 && status < 300)) {
      const detail = await readErrorDetail(response, secrets);
      throw new ModelRequestError(httpMessage(Number.isFinite(status) ? status : 0), 'MODEL_HTTP_ERROR', {
        url,
        status: Number.isFinite(status) ? status : null,
        detail,
      });
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finished = false;

    // 处理一行 SSE：只认 data:，空行与 : 开头的注释（心跳）跳过。
    const handleLine = (rawLine) => {
      if (finished) return;
      const line = rawLine.replace(/\r+$/, '');
      if (line.trim() === '' || line.startsWith(':')) return;
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (data === '') return;
      if (data === '[DONE]') {
        finished = true;
        return;
      }
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        // 单行脏数据不中断整轮：跳过即可。
        return;
      }
      if (chunk === null || typeof chunk !== 'object') return;
      handleChunk(chunk);
    };

    const handleChunk = (chunk) => {
      if (chunk.usage && typeof chunk.usage === 'object') pendingUsage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (choice === null || typeof choice !== 'object') return;
      const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};
      // reasoning_content 是模型的思考过程（D14 的采集层）。
      //
      // 它经**独立的回调**出去，绝不进 text、绝不经 onDelta：上游对话样式规格书:181 的后半句
      // 「绝不混入 assistant 正文通道」在这里照守。调用方（agent-loop）把它写进
      // 一条 reasoning_completed 事件，只进日志，不进回喂给模型的 messages（P22）。
      //
      // 这里**不统计字数**（R10）：终态行的「思考 800」用的是服务端返回的
      // usage.completion_tokens_details.reasoning_tokens，与本地累加的字符数是两回事，
      // 混用就会违反铁律 6（客观数字，且不与模型自报的 token 数混为一谈）。
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
        onReasoning(delta.reasoning_content);
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        text += delta.content;
        onDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const part of delta.tool_calls) {
          if (part === null || typeof part !== 'object') continue;
          const index = Number.isInteger(part.index) ? part.index : 0;
          let entry = toolParts.get(index);
          if (entry === undefined) {
            entry = { id: null, name: '', arguments: '' };
            toolParts.set(index, entry);
          }
          if (typeof part.id === 'string' && part.id !== '') entry.id = part.id;
          const fn = part.function && typeof part.function === 'object' ? part.function : null;
          if (fn === null) continue;
          if (typeof fn.name === 'string' && fn.name !== '') entry.name = fn.name;
          // arguments 是逐片到达的 JSON 片段，按 index 累加成完整字符串。
          if (typeof fn.arguments === 'string') entry.arguments += fn.arguments;
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
        finishReason = choice.finish_reason;
      }
    };

    // try 只包住“取下一块”这一步：读流失败才归为响应中断；
    // 解析与 onDelta / onToolCall 都在 try 之外，下游回调抛错必须原样冒泡，
    // 不能被改写成“模型响应中断”而掩盖本地真实的 bug。
    const iterator = readChunks(response)[Symbol.asyncIterator]();
    try {
      while (true) {
        let next;
        try {
          next = await iterator.next();
        } catch (error) {
          if (isAbortError(error, signal)) throw abortError();
          throw new ModelRequestError('模型响应中断，请稍后重试。', 'MODEL_STREAM_ERROR', {
            url,
            causeCode: error && error.code,
            detail: redact(error && error.message, secrets),
          });
        }
        if (next.done) break;
        const piece = decodeChunk(decoder, next.value);
        if (piece === '') continue;
        received = true;
        buffer += piece;
        // 只按完整行切割，剩下的半个 data: 行继续留在缓冲区里等下一块。
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          handleLine(line);
          newlineIndex = buffer.indexOf('\n');
        }
      }
      // 流末没有换行结尾时，最后一帧也要处理。
      if (buffer.trim() !== '') handleLine(buffer);
    } finally {
      // 手写 while 没有 for await 的自动清理：循环体（含 onDelta / onToolCall）抛错时
      // 必须显式 return()，才能取消底层 ReadableStream、释放连接，并让 readChunks 里
      // 挂起的生成器（含 getReader 分支的 releaseLock）收尾。
      if (typeof iterator.return === 'function') {
        try {
          await iterator.return();
        } catch {
          // 清理失败绝不盖掉真正的原因（回调抛的错或读流失败）。
        }
      }
    }

    if (!received) {
      throw new ModelRequestError('模型没有返回任何内容，请稍后重试。', 'MODEL_EMPTY_RESPONSE', { url });
    }

    // 工具调用按 index 顺序回调一次完整结果。
    const toolCalls = [...toolParts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, entry]) => ({ id: entry.id, name: entry.name, arguments: entry.arguments }))
      .filter((call) => call.name !== '');
    for (const call of toolCalls) onToolCall(call);

    const usage = pendingUsage === null ? null : normalizeUsage(pendingUsage);
    if (usage !== null) onUsage(usage);

    return { text, toolCalls, usage, finishReason, durationMs: Math.max(0, clock() - startedAt) };
  }

  return { streamChat, listModels, getLimits: () => resolveModelLimits({ baseUrl, model }) };
}
