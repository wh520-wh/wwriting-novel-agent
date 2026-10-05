// Agent 循环测试：模型→工具→模型、工具结果回传、私有 reasoning 只落 reasoning_completed、
// 不进可见正文也不回喂模型、权限确认、Abort 在三个位置生效、原子写入可见性、单 Run 轮数硬限制。
// 模型客户端是脚本化的假实现（只走 streamChat 契约：onDelta 字符串 / onToolCall 原始 JSON /
// MODEL_ABORTED 抛错），文件工具、权限层与事件存储全部用真实模块 + 真实临时目录，
// 需要观察“rename 之前”时才给 fs 包一层记录壳——断言的是真实行为，不是 mock 自证。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgentLoop } from '../../src/agent/agent-loop.mjs';
import { DEFAULT_HISTORY_BUDGET_CHARS, buildHistoryMessages } from '../../src/agent/history.mjs';
import { createFileTools } from '../../src/tools/files.mjs';
import { createPermissionState } from '../../src/tools/permissions.mjs';
import { updatePlan } from '../../src/tools/plan.mjs';
import { createEventStore } from '../../src/session/event-store.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

const FIXED_MS = 1758900000000;
function makeClock() {
  let now = FIXED_MS;
  return () => (now += 1000);
}
function makeIdFactory(prefix = 'id') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

// 事件存储：先落一条 session_created，之后的事件才能带上 session_id。
async function makeStore(sessionDir) {
  const store = createEventStore({ sessionDir, clock: makeClock(), idFactory: makeIdFactory('evt') });
  await store.append({ type: 'session_created', session_id: 'sess-1', data: { title: '测试会话' } });
  return store;
}

// 假模型客户端：按脚本逐轮返回。思考正文经**独立的 onReasoning 回调**出去，
// 绝不混进 onDelta —— 与真实客户端（deepseek-client.mjs）把 reasoning_content
// 单独回调的行为一致：思考只落进 reasoning_completed 事件，绝不进可见正文、
// 也绝不进回喂给模型的 messages。不给 onReasoning 的调用点则丢弃它（等价于旧契约）。
function makeFakeModel(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async streamChat({ messages, tools, signal, onDelta, onToolCall, onUsage, onReasoning = () => {} }) {
      calls.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (step.holdUntilAbort) {
        await new Promise((resolve) => {
          if (signal && signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', resolve, { once: true });
        });
        const error = new Error('已取消本轮生成。');
        error.name = 'ModelRequestError';
        error.code = 'MODEL_ABORTED';
        throw error;
      }
      if (step.throw) throw step.throw;
      if (typeof step.reasoning === 'string' && step.reasoning !== '') onReasoning(step.reasoning);
      for (const delta of step.deltas ?? []) onDelta(delta);
      for (const call of step.toolCalls ?? []) onToolCall(call);
      if (step.usage) onUsage(step.usage);
      return {
        text: (step.deltas ?? []).join(''),
        toolCalls: step.toolCalls ?? [],
        usage: step.usage ?? null,
        finishReason: (step.toolCalls ?? []).length > 0 ? 'tool_calls' : 'stop',
      };
    },
  };
}

// 有界轮询：待确认是异步产生的，不用 sleep 赌时序。
async function waitFor(predicate, { timeoutMs = 3000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待${label}超时。`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function readEvents(store) {
  return (await store.readAll()).events;
}

// 每个用例的公共装配：临时创作目录 + 事件存储 + 权限状态 + 循环。
async function setup({ prefix, yolo = true, script } = {}) {
  const root = await makeTempRoot(prefix);
  const projectRoot = path.join(root, 'novel');
  await fs.mkdir(projectRoot);
  const store = await makeStore(path.join(root, 'session'));
  const permissions = createPermissionState({ yolo, clock: makeClock(), idFactory: makeIdFactory('dec') });
  const model = makeFakeModel(script);
  return { root, projectRoot, store, permissions, model };
}

// 工具一律经工厂注入：循环用「带事件的权限桥」构造工具，确认才能带上 run_id 落进事件日志。
function makeLoop({ model, store, permissions, options = {}, fsImpl = null }) {
  return createAgentLoop({
    modelClient: model,
    toolsFactory: (toolOptions) => createFileTools({ ...toolOptions, ...(fsImpl ? { fs: fsImpl } : {}) }),
    eventStore: store,
    permissions,
    clock: makeClock(),
    idFactory: makeIdFactory('run'),
    ...options,
  });
}

test('只有文本的轮：可见文本进 model_delta，达到终态后循环结束', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-text-',
    script: [
      {
        deltas: ['第一章', '写好了。'],
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      },
    ],
  });
  const loop = makeLoop({ model, store, permissions });

  const result = await loop.run({
    projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写第一章',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.text, '第一章写好了。');
  assert.equal(result.message, null);
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 4, totalTokens: 14 });
  // 终态之后不再请求模型。
  assert.equal(model.calls.length, 1);

  const events = await readEvents(store);
  assert.deepEqual(events.map((event) => event.type), [
    'session_created', 'run_started', 'model_delta', 'model_delta', 'run_completed',
  ]);
  assert.deepEqual(
    events.filter((event) => event.type === 'model_delta').map((event) => event.data.text),
    ['第一章', '写好了。'],
  );
  assert.equal(events[1].data.input_id, 'in-1');
  assert.equal(events[1].data.text, '写第一章');
  assert.equal(events.at(-1).data.text, '第一章写好了。');
  assert.equal(events.at(-1).run_id, result.runId);
});

test('思考只经 reasoning_completed 落盘，绝不进任何一次发给模型的请求', async () => {
  // 必须跑出**第二次**模型请求才测得到这条不变量：循环把上一轮的助手/工具消息带进下一轮，
  // 泄漏只会在后一次请求里出现。只跑单轮的话，messages 在 streamChat 被调用的那一刻
  // 就被克隆了，此后追加什么都到不了那一次的 payload——断言恒绿（交叉验证抓到的空洞）。
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-reasoning-',
    script: [
      {
        deltas: ['先数一下'],
        reasoning: 'REASONING_SECRET_私思考',
        toolCalls: [{ id: 'call-1', name: 'count_text', arguments: JSON.stringify({ text: 'abc' }) }],
      },
      { deltas: ['可见结论'] },
    ],
  });
  const loop = makeLoop({ model, store, permissions });

  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '继续' });

  // 前提成立才谈得上判别：工具轮确实发生，循环确实发出了第二次请求。
  assert.equal(result.rounds, 1, '第一轮确实调用了工具');
  assert.equal(model.calls.length, 2, '工具调用后循环发出了第二次模型请求');

  const events = await readEvents(store);
  // 设计如此（ADR-0012 / P18 / P19）：思考文本按设计**全文**落进唯一一条 reasoning_completed 事件。
  const done = events.filter((event) => event.type === 'reasoning_completed');
  assert.equal(done.length, 1, '一个模型轮次恰好一条思考事件');
  assert.equal(done[0].data.text, 'REASONING_SECRET_私思考', '全文按设计落在那唯一一条事件里');
  // 真正的不变量：思考一个字都不进**任何一次**发给模型的 messages——逐次检查每一次请求。
  for (const [index, call] of model.calls.entries()) {
    assert.equal(
      JSON.stringify(call.messages).includes('REASONING_SECRET_私思考'), false,
      `第 ${index + 1} 次模型请求的 messages 里不得出现思考正文`,
    );
  }
  assert.equal(JSON.stringify(events).includes('可见结论'), true);
});

test('工具调用 → 工具结果回传模型 → 最终文本：循环在终态结束', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-tool-',
    script: [
      {
        deltas: ['我先写下来'],
        toolCalls: [{ id: 'call-1', name: 'write_file', arguments: JSON.stringify({ path: '第一章.md', content: '正文' }) }],
      },
      { deltas: ['已写入。'] },
    ],
  });
  const loop = makeLoop({ model, store, permissions });

  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写第一章' });

  assert.equal(result.status, 'completed');
  assert.equal(result.text, '我先写下来已写入。');
  assert.equal(result.rounds, 1);
  assert.equal(model.calls.length, 2);
  assert.equal(await fs.readFile(path.join(projectRoot, '第一章.md'), 'utf8'), '正文');

  // 工具结果真的回传给了模型：第二轮消息里有 role=tool 且带 tool_call_id 的结果。
  const round2 = model.calls[1].messages;
  const toolMessage = round2.find((message) => message.role === 'tool');
  assert.ok(toolMessage, '第二轮消息里必须有工具结果');
  assert.equal(toolMessage.tool_call_id, 'call-1');
  assert.match(toolMessage.content, /charsNoSpace/);
  // 助手那一条必须带上工具调用本身，否则服务端无法配对。
  const assistantMessage = round2.find((message) => message.role === 'assistant' && Array.isArray(message.tool_calls));
  assert.equal(assistantMessage.tool_calls[0].function.name, 'write_file');
  assert.equal(assistantMessage.tool_calls[0].id, 'call-1');
  // 工具声明确实下发了。
  assert.ok(Array.isArray(model.calls[0].tools));
  assert.ok(model.calls[0].tools.some((tool) => tool.function.name === 'write_file'));

  const events = await readEvents(store);
  const activityStart = events.find((event) => event.type === 'activity_started');
  const activityEnd = events.find((event) => event.type === 'activity_finished');
  assert.deepEqual(activityStart.data, { tool: 'write_file', target: '第一章.md', call_id: 'call-1' });
  // 工具结果摘要随活动一起落盘：终端那一行才能说出「得到了什么」（这里就是写入的字数）。
  assert.deepEqual(activityEnd.data, {
    tool: 'write_file',
    target: '第一章.md',
    ok: true,
    result: '{"path":"第一章.md","charsNoSpace":2}',
  });
  assert.equal(events.at(-1).type, 'run_completed');
});

test('工具结果包含客观字数：篇幅只由本地统计得出', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-count-',
    script: [
      { toolCalls: [{ id: 'c1', name: 'count_text', arguments: JSON.stringify({ text: '第一章 正文 abc' }) }] },
      { deltas: ['共 8 个字符'] },
    ],
  });
  const loop = makeLoop({ model, store, permissions });

  await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '统计一下' });

  const toolMessage = model.calls[1].messages.find((message) => message.role === 'tool');
  assert.deepEqual(JSON.parse(toolMessage.content).charsNoSpace, 8); // '第一章正文abc' 去空白共 8
});

test('工具参数不是合法 JSON：按工具错误处理并回传模型，不中断整轮', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-badargs-',
    script: [
      { toolCalls: [{ id: 'call-1', name: 'write_file', arguments: '{"path": "x.md", ' }] },
      { deltas: ['我换个写法。'] },
    ],
  });
  const loop = makeLoop({ model, store, permissions });

  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写' });

  assert.equal(result.status, 'completed');
  const toolMessage = model.calls[1].messages.find((message) => message.role === 'tool');
  const payload = JSON.parse(toolMessage.content);
  assert.equal(payload.code, 'TOOL_ARGS_INVALID');
  assert.match(payload.error, /[一-鿿]/);
  const finished = (await readEvents(store)).find((event) => event.type === 'activity_finished');
  assert.equal(finished.data.ok, false);
  assert.equal(finished.data.code, 'TOOL_ARGS_INVALID');
  // 参数没解析出来，绝不能落盘。
  assert.equal(existsSync(path.join(projectRoot, 'x.md')), false);
});

test('未知工具（含极端操作）不会被执行，只把中文事实回传模型', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-unknown-',
    script: [
      { toolCalls: [{ id: 'call-1', name: 'delete_file', arguments: JSON.stringify({ path: '第一章.md' }) }] },
      { deltas: ['那我不删了。'] },
    ],
  });
  await fs.writeFile(path.join(projectRoot, '第一章.md'), '正文', 'utf8');
  const loop = makeLoop({ model, store, permissions });

  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '删掉第一章' });

  assert.equal(result.status, 'completed');
  const toolMessage = model.calls[1].messages.find((message) => message.role === 'tool');
  const payload = JSON.parse(toolMessage.content);
  assert.equal(payload.code, 'TOOL_UNKNOWN');
  assert.match(payload.error, /[一-鿿]/);
  assert.equal(await fs.readFile(path.join(projectRoot, '第一章.md'), 'utf8'), '正文');
});

test('非 YOLO 写入：产生 decision_pending，确认后写入成功', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-decision-',
    yolo: false,
    script: [
      { toolCalls: [{ id: 'call-1', name: 'write_file', arguments: JSON.stringify({ path: '第一章.md', content: '正文' }) }] },
      { deltas: ['写好了。'] },
    ],
  });
  const loop = makeLoop({ model, store, permissions });

  const running = loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写第一章' });
  const pending = await waitFor(
    async () => (await readEvents(store)).find((event) => event.type === 'decision_pending'),
    { label: 'decision_pending' },
  );
  assert.equal(pending.data.level, 'write');
  assert.equal(pending.data.tool, 'write_file');
  assert.equal(pending.data.target, '第一章.md');
  assert.deepEqual(pending.data.choices, ['once', 'input', 'deny']);
  assert.equal(pending.data.confirmation_text, null);
  // 待确认期间绝不落盘。
  assert.equal(existsSync(path.join(projectRoot, '第一章.md')), false);

  permissions.decide({ decisionId: pending.data.decision_id, choice: 'once' });
  const result = await running;

  assert.equal(result.status, 'completed');
  assert.equal(await fs.readFile(path.join(projectRoot, '第一章.md'), 'utf8'), '正文');
  const events = await readEvents(store);
  const resolved = events.find((event) => event.type === 'decision_resolved');
  assert.equal(resolved.data.decision_id, pending.data.decision_id);
  assert.equal(resolved.data.allowed, true);
  assert.equal(resolved.data.choice, 'once');
});

test('达到单 Run 最大工具轮数：循环停止并写 run_failed', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-limit-',
    script: [
      { toolCalls: [{ id: 'c1', name: 'list_files', arguments: JSON.stringify({ path: '.' }) }] },
    ],
  });
  const loop = makeLoop({ model, store, permissions, options: { maxToolRounds: 2 } });

  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '一直列目录' });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'AGENT_ROUND_LIMIT');
  assert.match(result.message, /[一-鿿]/);
  assert.equal(result.rounds, 2);
  // 达到上限时不再发起新的模型请求（2 轮工具 + 1 次判定）。
  assert.equal(model.calls.length, 3);
  const events = await readEvents(store);
  assert.equal(events.at(-1).type, 'run_failed');
  assert.equal(events.at(-1).data.code, 'AGENT_ROUND_LIMIT');
  assert.equal(events.some((event) => event.type === 'run_completed'), false);
});

test('模型未配置：run_failed 带一条中文事实，错误码进详情', async () => {
  const { projectRoot, store, permissions } = await setup({ prefix: 'wwriting-loop-nomodel-', script: [] });
  const notConfigured = new Error('尚未设置模型，请用 /model <模型名> 设置。');
  notConfigured.name = 'ModelRequestError';
  notConfigured.code = 'MODEL_NOT_CONFIGURED';
  const model = makeFakeModel([{ throw: notConfigured }]);
  const loop = makeLoop({ model, store, permissions });

  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写' });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(result.message, '尚未设置模型，请用 /model <模型名> 设置。');
  const events = await readEvents(store);
  assert.equal(events.at(-1).type, 'run_failed');
  assert.equal(events.at(-1).data.message, '尚未设置模型，请用 /model <模型名> 设置。');
});

test('Abort 在模型流中：run_interrupted，终态为 cancelled', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-abort-stream-',
    script: [{ holdUntilAbort: true }, { deltas: ['不该出现'] }],
  });
  const loop = makeLoop({ model, store, permissions });
  const controller = new AbortController();

  const running = loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写', signal: controller.signal });
  await waitFor(async () => model.calls.length === 1, { label: '首个模型请求' });
  controller.abort();
  const result = await running;

  assert.equal(result.status, 'cancelled');
  assert.match(result.message, /[一-鿿]/);
  const events = await readEvents(store);
  const interrupted = events.find((event) => event.type === 'run_interrupted');
  assert.ok(interrupted);
  assert.equal(interrupted.data.reason, 'user_stop');
  assert.equal(events.some((event) => event.type === 'run_completed'), false);
  assert.equal(events.some((event) => event.type === 'run_failed'), false);
});

test('Abort 在确认等待中：待确认作废、文件不落盘、临时授权清空', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-abort-decision-',
    yolo: false,
    script: [
      { toolCalls: [{ id: 'call-1', name: 'write_file', arguments: JSON.stringify({ path: '第一章.md', content: '正文' }) }] },
      { deltas: ['不该出现'] },
    ],
  });
  const loop = makeLoop({ model, store, permissions });
  const controller = new AbortController();

  const running = loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写', signal: controller.signal });
  await waitFor(
    async () => (await readEvents(store)).find((event) => event.type === 'decision_pending'),
    { label: 'decision_pending' },
  );
  controller.abort();
  const result = await running;

  assert.equal(result.status, 'cancelled');
  // 硬要求：取消后绝不留下可继续执行的确认或临时授权。
  assert.deepEqual(permissions.pending(), []);
  assert.equal(permissions.grantFor({ tool: 'write_file' }), false);
  assert.equal(existsSync(path.join(projectRoot, '第一章.md')), false);
  const events = await readEvents(store);
  assert.equal(events.at(-1).type, 'run_interrupted');
});

test('Abort 在工具执行中（rename 之前）：文件保持原样，不留临时文件', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-abort-tool-',
    script: [
      {
        toolCalls: [{
          id: 'call-1',
          name: 'edit_file',
          arguments: JSON.stringify({ path: '第一章.md', oldText: '旧正文', newText: '新正文' }),
        }],
      },
      { deltas: ['不该出现'] },
    ],
  });
  await fs.writeFile(path.join(projectRoot, '第一章.md'), '旧正文', 'utf8');
  const controller = new AbortController();
  const seen = [];
  const fsImpl = {
    ...fs,
    writeFile: async (target, data, encoding) => {
      seen.push(['writeFile', path.basename(String(target))]);
      // 临时文件刚落盘就取消：rename 之前必须收住。
      if (String(target).includes('.tmp')) controller.abort();
      return fs.writeFile(target, data, encoding);
    },
    rename: async (from, to) => {
      seen.push(['rename', path.basename(String(to))]);
      return fs.rename(from, to);
    },
  };
  const loop = makeLoop({ model, store, permissions, fsImpl });

  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '改', signal: controller.signal });

  assert.equal(result.status, 'cancelled');
  assert.equal(await fs.readFile(path.join(projectRoot, '第一章.md'), 'utf8'), '旧正文');
  assert.deepEqual(seen.filter((entry) => entry[0] === 'rename'), []);
  const leftovers = (await fs.readdir(projectRoot)).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('Abort 在本轮第一个工具之后：剩下的工具调用不再执行', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-abort-midtools-',
    script: [
      {
        toolCalls: [
          { id: 'call-1', name: 'list_files', arguments: JSON.stringify({ path: '.' }) },
          { id: 'call-2', name: 'read_file', arguments: JSON.stringify({ path: '第一章.md' }) },
        ],
      },
      { deltas: ['不该出现'] },
    ],
  });
  await fs.writeFile(path.join(projectRoot, '第一章.md'), '正文', 'utf8');
  const controller = new AbortController();
  // 第一个工具（list_files）一读到目录就取消：本轮剩下的调用必须立刻收住。
  const fsImpl = {
    ...fs,
    readdir: async (...args) => {
      controller.abort();
      return fs.readdir(...args);
    },
  };
  const loop = makeLoop({ model, store, permissions, fsImpl });

  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '看看', signal: controller.signal });

  assert.equal(result.status, 'cancelled');
  const events = await readEvents(store);
  const started = events.filter((event) => event.type === 'activity_started');
  assert.deepEqual(started.map((event) => event.data.tool), ['list_files']);
  assert.equal(events.some((event) => event.data?.tool === 'read_file'), false);
  assert.deepEqual(events.filter((event) => event.type === 'activity_finished').map((event) => event.data.ok), [true]);
  assert.equal(events.at(-1).type, 'run_interrupted');
  // 取消之后不再向模型发请求。
  assert.equal(model.calls.length, 1);
});

test('写工具只在 rename 完成后可见：rename 之前目标仍是旧内容', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-atomic-',
    script: [
      {
        toolCalls: [{
          id: 'call-1',
          name: 'edit_file',
          arguments: JSON.stringify({ path: '第一章.md', oldText: '旧正文', newText: '新正文' }),
        }],
      },
      { deltas: ['改好了。'] },
    ],
  });
  await fs.writeFile(path.join(projectRoot, '第一章.md'), '旧正文', 'utf8');
  const controller = new AbortController();
  let visibleBeforeRename = '未观察';
  const seen = [];
  const fsImpl = {
    ...fs,
    writeFile: async (target, data, encoding) => {
      seen.push(['writeFile', path.basename(String(target))]);
      return fs.writeFile(target, data, encoding);
    },
    rename: async (from, to) => {
      visibleBeforeRename = existsSync(to) ? await fs.readFile(to, 'utf8') : null;
      seen.push(['rename', path.basename(String(to))]);
      return fs.rename(from, to);
    },
  };
  const loop = makeLoop({ model, store, permissions, fsImpl });

  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '改', signal: controller.signal });

  assert.equal(result.status, 'completed');
  assert.equal(visibleBeforeRename, '旧正文');
  assert.equal(await fs.readFile(path.join(projectRoot, '第一章.md'), 'utf8'), '新正文');
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0], 'writeFile');
  assert.match(seen[0][1], /^第一章\.md\.wwriting-.*\.tmp$/);
  assert.deepEqual(seen[1], ['rename', '第一章.md']);
  assert.deepEqual((await fs.readdir(projectRoot)).filter((name) => name.includes('.tmp')), []);
});

test('Run 结束即清空临时授权：本条输入的同类授权不带到下一轮', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-grants-',
    yolo: false,
    script: [
      { toolCalls: [{ id: 'call-1', name: 'write_file', arguments: JSON.stringify({ path: '第一章.md', content: '正文' }) }] },
      { deltas: ['写好了。'] },
    ],
  });
  const loop = makeLoop({ model, store, permissions });

  const running = loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写第一章' });
  const pending = await waitFor(
    async () => (await readEvents(store)).find((event) => event.type === 'decision_pending'),
    { label: 'decision_pending' },
  );
  // 「本条输入允许同类操作」：授权只在当轮有效。
  permissions.decide({ decisionId: pending.data.decision_id, choice: 'input' });
  assert.equal(permissions.grantFor({ inputId: 'in-1', tool: 'write_file' }), true);

  const result = await running;
  assert.equal(result.status, 'completed');
  assert.equal(permissions.grantFor({ inputId: 'in-1', tool: 'write_file' }), false);
  assert.deepEqual(permissions.pending(), []);
});

test('循环在事件里留下可回放的完整过程：9 类事件齐备', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-events-',
    yolo: false,
    script: [
      {
        deltas: ['开始'],
        toolCalls: [{ id: 'call-1', name: 'write_file', arguments: JSON.stringify({ path: '第一章.md', content: '正文' }) }],
      },
      { deltas: ['写好了。'] },
    ],
  });
  const loop = makeLoop({ model, store, permissions });

  const running = loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写第一章' });
  const pending = await waitFor(
    async () => (await readEvents(store)).find((event) => event.type === 'decision_pending'),
    { label: 'decision_pending' },
  );
  permissions.decide({ decisionId: pending.data.decision_id, choice: 'once' });
  await running;

  const types = new Set((await readEvents(store)).map((event) => event.type));
  for (const type of [
    'run_started', 'model_delta', 'activity_started', 'activity_finished',
    'decision_pending', 'run_completed',
  ]) {
    assert.equal(types.has(type), true, `缺少事件 ${type}`);
  }
  // 所有事件都带 run_id 与 session_id，可直接按轮回放。
  for (const event of await readEvents(store)) {
    if (event.type === 'session_created') continue;
    assert.equal(event.session_id, 'sess-1');
    assert.match(event.run_id, /^run_/);
  }
});

// —— 会话历史回放 ——
//
// 这一组用例钉住两件事：① 不传 history 时循环行为**逐字不变**（守门）；② 传了 history 时
// 它真的插在 system 与当轮输入之间，且「载入多少轮 / 省略多少轮 / 多少字符」是如实报出来的。

test('守门：不传 history 时 messages 恰好 [system, user] 两条，且不发 history_applied', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-nohistory-',
    script: [{ deltas: ['第一章写好了。'] }],
  });
  const loop = makeLoop({ model, store, permissions });

  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写第一章' });

  assert.equal(result.status, 'completed');
  // 默认行为就是 359 条基线里的那一条：system + 当轮输入，不多不少。
  assert.deepEqual(model.calls[0].messages.map((message) => message.role), ['system', 'user']);
  assert.equal(model.calls[0].messages[1].content, '写第一章');
  assert.match(model.calls[0].messages[0].content, /创作目录：/);
  const events = await readEvents(store);
  assert.deepEqual(events.map((event) => event.type), [
    'session_created', 'run_started', 'model_delta', 'run_completed',
  ]);
  // 没有历史就没有这件事可说：凭空发一条「载入 0 轮」只会变成噪音。
  assert.equal(events.some((event) => event.type === 'history_applied'), false);
});

test('注入 2 轮历史：顺序为 [system, h1, h2, 当前输入]，history_applied 的三个字段与实际一致', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-history-',
    script: [{ deltas: ['第三章写好了。'] }],
  });
  const loop = makeLoop({ model, store, permissions });
  const history = [
    { role: 'user', content: '写第一章' },
    { role: 'assistant', content: '第一章写好了。' },
    { role: 'user', content: '写第二章' },
    { role: 'assistant', content: '第二章写好了。' },
  ];

  const result = await loop.run({
    projectRoot, sessionId: 'sess-1', inputId: 'in-3', text: '写第三章', history,
  });

  assert.equal(result.status, 'completed');
  // 断言的是模型客户端**实际收到**的 messages，不是我们自己算出来的那个数组。
  const sent = model.calls[0].messages;
  assert.deepEqual(sent.map((message) => message.role), [
    'system', 'user', 'assistant', 'user', 'assistant', 'user',
  ]);
  assert.deepEqual(sent.slice(1).map((message) => message.content), [
    '写第一章', '第一章写好了。', '写第二章', '第二章写好了。', '写第三章',
  ]);
  assert.match(sent[0].content, /创作目录：/);

  // history_applied 紧跟在 run_started 之后，三个字段与真实容量的口径一致。
  const events = await readEvents(store);
  assert.equal(events[1].type, 'run_started');
  const applied = events.find((event) => event.type === 'history_applied');
  assert.ok(applied, '有历史时必须发 history_applied');
  assert.equal(applied.run_id, result.runId);
  assert.deepEqual(applied.data, {
    kept_turns: 2,
    truncated_turns: 0,
    chars: 22, // 四条 content 的字面长度之和：4+7+4+7
    digest_chars: 0,
    covered_turns: 0,
    truncated_exact: true,
    covered_exact: true,
  });
});

test('history_applied 用调用方传入的 historyMeta：截断数如实透传', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-history-meta-',
    script: [{ deltas: ['继续。'] }],
  });
  const loop = makeLoop({ model, store, permissions });
  const history = [{ role: 'user', content: '写第一章' }, { role: 'assistant', content: '好。' }];

  await loop.run({
    projectRoot, sessionId: 'sess-1', inputId: 'in-2', text: '继续',
    history, historyMeta: { keptTurns: 1, truncatedTurns: 7, chars: 8 },
  });

  const applied = (await readEvents(store)).find((event) => event.type === 'history_applied');
  // 字段原样透传，不让循环自己再算一遍——两处各算一次就会出现「屏幕说 1 轮、模型收到 3 轮」。
  assert.deepEqual(applied.data, {
    kept_turns: 1, truncated_turns: 7, chars: 8,
    digest_chars: 0, covered_turns: 0,
    truncated_exact: true, covered_exact: true,
  });
});

test('history 整段被截没（messages 空但 truncatedTurns > 0）仍要发 history_applied（猎捕报告 8）', async () => {
  // 最新一轮输入本身超预算时 buildHistoryMessages 返回空数组、truncatedTurns = N：
  // 模型以零上下文开工，「省略了 N 轮」恰恰是这一轮唯一要说的事实，不发就是一轮静默失忆。
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-history-emptied-',
    script: [{ deltas: ['从头写。'] }],
  });
  const loop = makeLoop({ model, store, permissions });

  const result = await loop.run({
    projectRoot, sessionId: 'sess-1', inputId: 'in-9', text: '写第一章',
    history: [], historyMeta: { keptTurns: 0, truncatedTurns: 5, chars: 0 },
  });

  assert.equal(result.status, 'completed');
  const applied = (await readEvents(store)).find((event) => event.type === 'history_applied');
  assert.ok(applied, '整段历史被截没时必须发 history_applied，否则用户看到的是正常回答');
  assert.deepEqual(applied.data, {
    kept_turns: 0, truncated_turns: 5, chars: 0,
    digest_chars: 0, covered_turns: 0,
    truncated_exact: true, covered_exact: true,
  });
  // 模型仍然以零上下文开工（截断是既定语义，这里只修「如实呈现」）。
  assert.deepEqual(model.calls[0].messages.map((message) => message.role), ['system', 'user']);
});

test('超长历史：截断后送模型的 messages 在预算内，且 truncated_turns > 0', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-history-budget-',
    script: [{ deltas: ['接着写。'] }],
  });
  const loop = makeLoop({ model, store, permissions });
  // 三轮各 12000 字符的正文：总共 36000 > 24000，最新一轮之外必然要丢。
  const big = (label) => `${label}${'字'.repeat(12000)}`;
  const history = [
    { role: 'user', content: '写第一章' },
    { role: 'assistant', content: big('一') },
    { role: 'user', content: '写第二章' },
    { role: 'assistant', content: big('二') },
    { role: 'user', content: '写第三章' },
    { role: 'assistant', content: big('三') },
  ];

  const built = buildHistoryMessagesFor(history);
  assert.deepEqual(built.meta.truncatedTurns > 0, true, '超预算时必须有轮次被省略');

  const result = await loop.run({
    projectRoot, sessionId: 'sess-1', inputId: 'in-4', text: '写第四章',
    history: built.messages, historyMeta: built.meta,
  });

  assert.equal(result.status, 'completed');
  const sent = model.calls[0].messages;
  const chars = sent.reduce((total, message) => total + message.content.length, 0);
  // 预算只约束历史；这里连 system 与当轮输入一起算，仍然远小于「三轮全量」的 36000 量级。
  assert.equal(chars <= DEFAULT_HISTORY_BUDGET_CHARS + 200, true, `实际 ${chars} 字符`);
  // 最新的那一轮必须在：丢掉的只能是最早的上下文。
  assert.equal(JSON.stringify(sent).includes(big('三')), true);
  const applied = (await readEvents(store)).find((event) => event.type === 'history_applied');
  assert.equal(applied.data.truncated_turns > 0, true);
  assert.equal(applied.data.kept_turns, built.meta.keptTurns);
});

// 超长历史的截断规则属于 history.mjs 的纯函数；这里只借它的输出构造「已经被截好」的输入，
// 不重复实现一遍预算逻辑（重复实现就会与纯函数的判断分歧）。
function buildHistoryMessagesFor(history) {
  const perTurn = history.length / 2;
  const turns = [];
  for (let i = 0; i < perTurn; i += 1) {
    turns.push({
      inputId: `in-${i + 1}`,
      runId: `run-${i + 1}`,
      userText: history[i * 2].content,
      assistantText: history[i * 2 + 1].content,
      tools: [],
      terminal: 'completed',
    });
  }
  const built = buildHistoryMessages(turns, { budgetChars: DEFAULT_HISTORY_BUDGET_CHARS });
  return {
    messages: built.messages,
    meta: { keptTurns: built.keptTurns, truncatedTurns: built.truncatedTurns, chars: built.usedChars },
  };
}

// —— 回归：落盘失败时必须 resolve 出终态，而不是 reject ——
//
// 终态事件是会话状态的收敛点（投影靠它清掉 active_run、把 run 标成结束）。
// 落盘本身可能失败（磁盘满 / EPERM）。若此时还把失败往上抛，run() 就是 reject 而不是
// resolve —— 调用方拿不到任何终态，投影永远停在 active、队列里那条输入也摘不掉。
// 所以终态的落盘必须是「尽力送达」：失败就吞掉，run() 仍然如实 resolve 出失败终态。
test('写盘失败：run 仍 resolve 出 failed 终态，绝不 reject（会话不能因磁盘故障僵死）', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-store-fail-',
    script: [{ deltas: ['写了一点'] }],
  });
  // 事件存储整体写不进去：run_started、终态一律抛错。这是磁盘满 / EPERM 的形状。
  const failing = {
    ...store,
    append: async () => { const error = new Error('EPERM: operation not permitted'); error.code = 'EPERM'; throw error; },
    appendBatch: async () => { const error = new Error('EPERM: operation not permitted'); error.code = 'EPERM'; throw error; },
    readAll: store.readAll.bind(store),
  };
  const loop = makeLoop({ model, store: failing, permissions });

  // 关键：这里刻意不 .catch —— reject 会让这个用例直接失败（那正是修复前的情况）。
  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写第一章' });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'EPERM');
  assert.equal(typeof result.message, 'string');
  assert.equal(result.message.length > 0, true);
});

// —— 项目记忆注入 ——
// ADR-0008：作为带标记的**独立合成消息**注入，位置在 system 之后、历史之前。
// 绝不塞进 system prompt 字符串——那样历史预算、回放投影、屏面统计全都看不见它。

function memoryOf(content, extra = {}) {
  return {
    message: { role: 'user', content: `[Project Memory: WWRITING.md]\n${content}` },
    hash: 'h1', omittedChars: 0, state: 'present', ...extra,
  };
}

function recordingLoop(seen) {
  return createAgentLoop({
    modelClient: {
      streamChat: async (options) => {
        seen.push(options.messages);
        return { text: '', toolCalls: [], usage: null };
      },
    },
    tools: {},
    eventStore: { append: async (partial) => partial },
  });
}

test('记忆消息落在 system 之后、历史之前、当轮输入之前', async () => {
  const seen = [];
  await recordingLoop(seen).run({
    projectRoot: '/novel', inputId: 'in_1', text: '写第二章',
    history: [{ role: 'user', content: '写第一章' }, { role: 'assistant', content: '第一章写好了。' }],
    memory: memoryOf('# 记忆\n- 主角：沈砚\n'),
  });
  assert.deepEqual(seen[0].map((message) => message.role), ['system', 'user', 'user', 'assistant', 'user']);
  assert.ok(seen[0][1].content.startsWith('[Project Memory: WWRITING.md]'));
  assert.equal(seen[0][2].content, '写第一章');
  assert.equal(seen[0][4].content, '写第二章');
});

test('没有记忆时 messages 与既有行为逐字一致（不多一个空位）', async () => {
  const seen = [];
  await recordingLoop(seen).run({ projectRoot: '/novel', inputId: 'in_1', text: '写第二章', memory: null });
  assert.deepEqual(seen[0].map((message) => message.role), ['system', 'user']);
});

test('system prompt 写明记忆职责、Q8 分工，并带上骨架原文', async () => {
  const seen = [];
  await recordingLoop(seen).run({ projectRoot: '/novel', inputId: 'in_1', text: 'hi', memory: null });
  const system = seen[0][0].content;
  for (const needle of [
    'WWRITING.md', 'schema_version: 1', '## 权威文件', '/init', '不得无理由整体覆盖', '报告',
    // Q8：与 AGENTS.md 的分工必须写在 prompt 里（草案定了「写清楚即可，不做运行时防御」，
    // 但没说写在哪——落点就是这里）。
    'AGENTS.md 是**规则**', '这部作品的当前状态', '绝不把规则抄进 WWRITING.md',
    // 记忆维护纪律两行（上游三件套的 CLI 两件化）：指路合法通道 + 提交后的固定顺序。
    'memory/ 记忆档案只读；设定档案请用 update_memory 工具更新',
    '提交/入账/回滚后必须依次：update_memory → 更新 WWRITING.md，两件缺一不得声称完成',
  ]) {
    assert.ok(system.includes(needle), `system prompt 缺：${needle}`);
  }
  assert.ok(system.includes('你是 WWriting 的写作 Agent'), '原有职责一句不少');
  assert.ok(system.endsWith('创作目录：/novel'), '创作目录仍然拼在最后');
});

test('每轮发一条 memory_applied，带上状态、字符数、省略量与是否命中缓存', async () => {
  const events = [];
  const loop = createAgentLoop({
    modelClient: { streamChat: async () => ({ text: '', toolCalls: [], usage: null }) },
    tools: {},
    eventStore: { append: async (partial) => { events.push(partial); return partial; } },
  });
  const memory = memoryOf('# 记忆\n', { omittedChars: 120 });
  await loop.run({ projectRoot: '/novel', inputId: 'in_1', text: '写第二章', memory, memoryCached: false });
  const applied = events.find((event) => event.type === 'memory_applied');
  assert.deepEqual(applied.data, {
    state: 'present',
    chars: memory.message.content.length,
    omitted_chars: 120,
    cached: false,
  });
});

test('记忆为 null（读失败降级）时不发 memory_applied', async () => {
  const events = [];
  const loop = createAgentLoop({
    modelClient: { streamChat: async () => ({ text: '', toolCalls: [], usage: null }) },
    tools: {},
    eventStore: { append: async (partial) => { events.push(partial); return partial; } },
  });
  await loop.run({ projectRoot: '/novel', inputId: 'in_1', text: '写第二章', memory: null });
  assert.equal(events.some((event) => event.type === 'memory_applied'), false);
});

test('记忆不计入历史轮数：history_applied 的 kept_turns 只看真历史', async () => {
  const events = [];
  const loop = createAgentLoop({
    modelClient: { streamChat: async () => ({ text: '', toolCalls: [], usage: null }) },
    tools: {},
    eventStore: { append: async (partial) => { events.push(partial); return partial; } },
  });
  await loop.run({
    projectRoot: '/novel', inputId: 'in_1', text: '写第二章',
    history: [{ role: 'user', content: '写第一章' }, { role: 'assistant', content: '好了。' }],
    memory: memoryOf('# 记忆\n'),
  });
  assert.equal(events.find((event) => event.type === 'history_applied').data.kept_turns, 1,
    '记忆是 role=user，但绝不是一轮对话');
});

// —— 思考正文只进日志（D14 采集层）——

function reasoningLoop(events) {
  return createAgentLoop({
    modelClient: {
      streamChat: async ({ onReasoning, onDelta }) => {
        onReasoning('先想想');
        onReasoning('主角的名字');
        onDelta('沈砚。');
        return { text: '沈砚。', toolCalls: [], usage: null };
      },
    },
    tools: {},
    eventStore: { append: async (partial) => { events.push(partial); return partial; } },
    clock: () => 1700000000000,
  });
}

test('一轮思考落一条 reasoning_completed，带全文、轮次起点时间戳与字数', async () => {
  const events = [];
  await reasoningLoop(events).run({ projectRoot: '/novel', inputId: 'in_1', text: '主角叫什么' });
  const done = events.filter((event) => event.type === 'reasoning_completed');
  assert.equal(done.length, 1, '一个模型轮次恰好一项（上游对话样式规格书:180）');
  assert.equal(done[0].data.text, '先想想主角的名字');
  // 字数是**全文长度**（P19：正文不截断）。'先想想主角的名字' 共 8 个字——
  // 任务简报这里写的是 9，是它自己的数数错误（已核对），此处按事实钉成 8。
  assert.equal(done[0].data.chars, 8);
  assert.equal(typeof done[0].data.started_at, 'string');
});

test('思考的增量逐片推给预览回调，但**一片都不落事件**（内容上屏与落盘是两条路）', async () => {
  const events = [];
  const previews = [];
  const loop = createAgentLoop({
    modelClient: {
      streamChat: async ({ onReasoning, onDelta }) => {
        onReasoning('先想想');
        onReasoning('主角的名字');
        onDelta('沈砚。');
        return { text: '沈砚。', toolCalls: [], usage: null };
      },
    },
    tools: {},
    eventStore: { append: async (partial) => { events.push(partial); return partial; } },
    clock: () => 1700000000000,
    onReasoningPreview: (delta) => previews.push(delta),
  });
  await loop.run({ projectRoot: '/novel', inputId: 'in_1', text: '主角叫什么' });

  assert.deepEqual(previews, ['先想想', '主角的名字'], '每一片都推给预览，顺序与到达一致');
  assert.equal(
    events.some((event) => event.type === 'reasoning_delta'), false,
    '预览走回调、不上日志：P18 不动，日志里仍然只有轮末那一条',
  );
  const done = events.filter((event) => event.type === 'reasoning_completed');
  assert.equal(done.length, 1);
  assert.equal(done[0].data.text, '先想想主角的名字');
});

test('不给预览回调时整条路不存在：循环照常跑，一个字节都不外泄', async () => {
  const events = [];
  await reasoningLoop(events).run({ projectRoot: '/novel', inputId: 'in_1', text: '主角叫什么' });
  assert.equal(events.filter((event) => event.type === 'reasoning_completed').length, 1);
});

test('started_at 是**本轮模型请求发起时**，不是第一个思考 delta 到达时（R4）', async () => {
  // 上游 :176 把 N 定义为 model_turn_started → reasoning_completed。
  // 用「第一个 delta 到达」当起点会把首 token 之前的整段等待少算掉——
  // 而那正是用户真正在等的时间，也是「强度调高了到底慢了多少」的全部信号。
  const events = [];
  const stamps = [];
  let now = 1700000000000;
  const loop = createAgentLoop({
    modelClient: {
      streamChat: async ({ onReasoning }) => {
        stamps.push('request');
        // 时钟在这里推进 3 秒，模拟「请求发出后 3 秒才有第一个思考 delta」：
        // 若实现把起点记在 delta 到达时，下面的断言就会读到推进后的时刻而变红。
        now += 3000;
        onReasoning('想');
        return { text: '好。', toolCalls: [], usage: null };
      },
    },
    tools: {},
    eventStore: { append: async (partial) => { events.push(partial); return partial; } },
    clock: () => now,
  });
  await loop.run({ projectRoot: '/novel', inputId: 'in_1', text: 'hi' });
  const done = events.find((event) => event.type === 'reasoning_completed');
  assert.equal(done.data.started_at, new Date(1700000000000).toISOString(),
    '起点是请求发起时（clock 还没被推进），不是 delta 到达时');
  assert.deepEqual(stamps, ['request']);
});

test('首 token 之前的等待被算进思考耗时（R4 的端到端证据）', async () => {
  const events = [];
  let now = 1700000000000;
  const loop = createAgentLoop({
    modelClient: {
      streamChat: async ({ onReasoning }) => {
        // 模拟「请求发出后 3 秒才有第一个思考 delta」。
        now += 3000;
        onReasoning('想');
        return { text: '好。', toolCalls: [], usage: null };
      },
    },
    tools: {},
    eventStore: { append: async (partial) => { events.push(partial); return partial; } },
    clock: () => now,
  });
  await loop.run({ projectRoot: '/novel', inputId: 'in_1', text: 'hi' });
  const done = events.find((event) => event.type === 'reasoning_completed');
  assert.equal(done.data.started_at, new Date(1700000000000).toISOString(),
    '起点是请求发起时（clock 还没被推进），不是 delta 到达时');
});

test('思考正文绝不进 model_delta，也绝不进 run_completed.text', async () => {
  const events = [];
  await reasoningLoop(events).run({ projectRoot: '/novel', inputId: 'in_1', text: '主角叫什么' });
  const deltas = events.filter((event) => event.type === 'model_delta').map((event) => event.data.text).join('');
  assert.equal(deltas, '沈砚。');
  assert.equal(events.find((event) => event.type === 'run_completed').data.text, '沈砚。');
});

test('不落 reasoning_delta：内容不实时上屏，增量事件没有消费者（P18）', async () => {
  const events = [];
  await reasoningLoop(events).run({ projectRoot: '/novel', inputId: 'in_1', text: '主角叫什么' });
  assert.equal(events.some((event) => event.type === 'reasoning_delta'), false);
});

test('这一轮没有思考时不发 reasoning_completed（不凭空造一项）', async () => {
  const events = [];
  const loop = createAgentLoop({
    modelClient: {
      streamChat: async ({ onDelta }) => {
        onDelta('好。');
        return { text: '好。', toolCalls: [], usage: null };
      },
    },
    tools: {},
    eventStore: { append: async (partial) => { events.push(partial); return partial; } },
  });
  await loop.run({ projectRoot: '/novel', inputId: 'in_1', text: 'hi' });
  assert.equal(events.some((event) => event.type === 'reasoning_completed'), false);
});

test('多轮工具调用：每个模型轮次各落一条 reasoning_completed', async () => {
  const events = [];
  let round = 0;
  const loop = createAgentLoop({
    modelClient: {
      streamChat: async ({ onReasoning, onToolCall }) => {
        round += 1;
        onReasoning(`第${round}轮思考`);
        if (round === 1) {
          // 工具调用必须经 onToolCall 回调交给循环：循环从回调收集，不看返回值
          // （任务简报这里只 return 了 toolCalls、没回调，那一轮会变成「没有工具调用」，
          // 循环直接结束，第二条 reasoning_completed 永远不会产生。已按契约补上回调。）
          const call = { id: 'c1', name: 'count_text', arguments: '{"text":"abc"}' };
          onToolCall(call);
          return { text: '', toolCalls: [call], usage: null };
        }
        return { text: '好了。', toolCalls: [], usage: null };
      },
    },
    tools: { countText: async () => ({ charsNoSpace: 3 }) },
    eventStore: { append: async (partial) => { events.push(partial); return partial; } },
  });
  await loop.run({ projectRoot: '/novel', inputId: 'in_1', text: '数一下' });
  assert.equal(events.filter((event) => event.type === 'reasoning_completed').length, 2);
});

test('被停止的轮：已经收到的思考正文仍然落盘（那是真实产出）', async () => {
  const events = [];
  const loop = createAgentLoop({
    modelClient: {
      streamChat: async ({ onReasoning }) => {
        onReasoning('想到一半');
        // 只抛 MODEL_ABORTED，**不要**先 abort signal（R22）：
        // signal 已 aborted 时 throwIfAborted() 会在进入 callModel **之前**就抛 RUN_ABORTED
        // （agent-loop.mjs:442），假 streamChat 根本不会被调用，onReasoning 也就永远不会触发，
        // 这条用例会断言一个不可能发生的情况。isAbortError(:159) 认 code === 'MODEL_ABORTED'，
        // 不需要 signal 配合。
        const error = new Error('已取消本轮生成。');
        error.code = 'MODEL_ABORTED';
        throw error;
      },
    },
    tools: {},
    eventStore: { append: async (partial) => { events.push(partial); return partial; } },
  });
  const result = await loop.run({ projectRoot: '/novel', inputId: 'in_1', text: 'hi' });
  assert.equal(result.status, 'interrupted');
  // 与 run_interrupted 保留已产生可见文本是同一条判断：用户停止不代表「那段思考没发生过」。
  const done = events.filter((event) => event.type === 'reasoning_completed');
  assert.equal(done.length, 1);
  assert.equal(done[0].data.text, '想到一半');
  // 顺序：思考事件必须排在终态之前，否则回放时会挂在没有归属的 run 上。
  const kinds = events.map((event) => event.type);
  assert.ok(kinds.indexOf('reasoning_completed') < kinds.indexOf('run_interrupted'));
});

// —— 技能目录块与 read_skill（ADR-0014）——

test('有技能时 system 消息在项目记忆段之后拼目录块，位于「创作目录」之前', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-skill-',
    script: [{ deltas: ['好。'] }],
  });
  const loop = makeLoop({
    model,
    store,
    permissions,
    options: {
      skillCatalog: [
        { name: 'genre-suspense', description: '悬疑流派公约', category: 'genre' },
        { name: 'show-dont-tell', description: '展示而非陈述', category: null },
      ],
    },
  });

  await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写第一章' });

  const system = model.calls[0].messages[0];
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes('[Available Skills]'));
  assert.ok(system.content.includes('- [流派] genre-suspense: 悬疑流派公约'), '有分类带标签');
  assert.ok(system.content.includes('- show-dont-tell: 展示而非陈述'), '无分类不带标签');
  assert.ok(system.content.includes('写作前分层定调'), '选型规则随目录注入');
  assert.ok(!system.content.includes('# 悬疑'), '正文绝不常驻');
  const memoryAt = system.content.indexOf('项目记忆');
  const skillsAt = system.content.indexOf('[Available Skills]');
  const cwdAt = system.content.indexOf('创作目录：');
  assert.ok(memoryAt !== -1 && skillsAt > memoryAt && cwdAt > skillsAt, '层序应为 项目记忆 → 技能目录 → 创作目录');
});

test('无技能（null 或空数组）时目录块整块省略，system 与旧行为逐字一致', async () => {
  const runWith = async (skillCatalog) => {
    const { projectRoot, store, permissions, model } = await setup({
      prefix: 'wwriting-loop-noskill-',
      script: [{ deltas: ['好。'] }],
    });
    const loop = makeLoop({ model, store, permissions, options: { skillCatalog } });
    await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写第一章' });
    // 两次装配的临时目录不同，把路径归一后再比（其余部分必须逐字一致）。
    return model.calls[0].messages[0].content.replaceAll(projectRoot, '创作目录');
  };

  const without = await runWith(null);
  const empty = await runWith([]);

  assert.equal(without, empty);
  assert.ok(!without.includes('[Available Skills]'), '空清单不造占位块');
});

test('read_skill 进下发工具清单，描述与参数照上游', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-skilltool-',
    script: [{ deltas: ['好。'] }],
  });
  const loop = makeLoop({ model, store, permissions });

  await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写第一章' });

  const schema = model.calls[0].tools.find((tool) => tool.function.name === 'read_skill');
  assert.ok(schema, 'read_skill 必须在下发的工具声明里');
  assert.equal(schema.function.description, '读取已发现 Agent Skill 的 SKILL.md 或其安全资源。');
  assert.deepEqual(schema.function.parameters.required, ['name']);
  assert.equal(schema.function.parameters.additionalProperties, false);
  assert.equal(
    schema.function.parameters.properties.resource.description,
    '默认 SKILL.md；也可为 references/...、scripts/...、assets/...',
  );
});

test('read_skill 往返：拿到技能正文进工具结果，未知名拿到可理解错误且不拖垮本轮', async () => {
  const { projectRoot, store, permissions, model } = await setup({
    prefix: 'wwriting-loop-skillrt-',
    script: [
      { toolCalls: [{ id: 'c1', name: 'read_skill', arguments: JSON.stringify({ name: 'genre-suspense' }) }] },
      { toolCalls: [{ id: 'c2', name: 'read_skill', arguments: JSON.stringify({ name: 'nope' }) }] },
      { deltas: ['完成。'] },
    ],
  });
  const tools = {
    readSkill: async ({ name }) => {
      if (name === 'nope') {
        const error = new Error('未发现技能: nope');
        error.code = 'skill_not_found';
        throw error;
      }
      return { name, resource: 'SKILL.md', content: '技能正文', bytes: 4 };
    },
  };
  const loop = createAgentLoop({
    modelClient: model,
    tools,
    eventStore: store,
    permissions,
    clock: makeClock(),
    idFactory: makeIdFactory('run'),
  });

  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '写第一章' });

  assert.equal(result.status, 'completed', '工具失败不是 Run 失败');
  const thirdRound = model.calls[2].messages;
  const toolMessages = thirdRound.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  const ok = JSON.parse(toolMessages[0].content);
  assert.equal(ok.content, '技能正文');
  assert.equal(ok.name, 'genre-suspense');
  const bad = JSON.parse(toolMessages[1].content);
  assert.equal(bad.code, 'skill_not_found');
  assert.equal(bad.error, '未发现技能: nope');

  const events = await readEvents(store);
  const started = events.filter((event) => event.type === 'activity_started' && event.data.tool === 'read_skill');
  assert.deepEqual(started.map((event) => event.data.target), ['genre-suspense', 'nope'], '活动行目标带技能名');
  const finished = events.filter((event) => event.type === 'activity_finished' && event.data.tool === 'read_skill');
  assert.equal(finished[0].data.ok, true);
  assert.equal(finished[1].data.ok, false);
  assert.equal(finished[1].data.code, 'skill_not_found');
});

// update_plan：活动行照常（started/finished + 结果摘要），紧随其后落一条 plan_updated
// 携带整表；空表不落；工具校验失败不是 Run 失败（错误作为工具结果回传）。
test('update_plan 工具：活动行之后落 plan_updated 整表；空表也落（模型显式清空）', async () => {
  const { projectRoot, store, permissions, model } = await setup({ prefix: 'wwriting-loop-plan-', script: [
    { toolCalls: [{ id: 'c1', name: 'update_plan', arguments: JSON.stringify({ steps: [
      { summary: '通读前两章', status: 'completed' },
      { summary: '写第三章', status: 'in_progress' },
      { summary: '检查衔接', status: 'pending' },
    ] }) }] },
    { toolCalls: [{ id: 'c2', name: 'update_plan', arguments: JSON.stringify({ steps: [] }) }] },
    { toolCalls: [{ id: 'c3', name: 'update_plan', arguments: JSON.stringify({ steps: [{ summary: '', status: 'x' }] }) }] },
    { deltas: ['按计划推进。'] },
  ] });
  const loop = createAgentLoop({
    modelClient: model,
    tools: { updatePlan },
    eventStore: store,
    permissions,
    clock: makeClock(),
    idFactory: makeIdFactory('run'),
  });

  const result = await loop.run({ projectRoot, sessionId: 'sess-1', inputId: 'in-1', text: '改这三章' });
  assert.equal(result.status, 'completed');

  const events = await readEvents(store);
  const plans = events.filter((event) => event.type === 'plan_updated');
  // 两次合法调用都落 plan_updated（整表替换：空表 = 模型显式清空，绝不能静默 no-op）；
  // 第三次校验失败只落 activity_finished。
  assert.equal(plans.length, 2);
  assert.equal(plans[0].run_id, result.runId);
  assert.equal(plans[0].data.items.length, 3);
  assert.equal(plans[0].data.items[1].summary, '写第三章');
  assert.deepEqual(plans[1].data.items, [], '空表照常落事件');

  // 顺序：plan_updated 紧跟在对应 activity_finished 之后（计划表画在活动行后面）。
  const types = events.map((event) => event.type);
  const firstFinish = types.indexOf('activity_finished');
  assert.equal(types[firstFinish + 1], 'plan_updated');

  // 活动行摘要说得出进度；校验失败那次的错误回传给了模型。
  const finished = events.filter((event) => event.type === 'activity_finished' && event.data.tool === 'update_plan');
  assert.equal(finished.length, 3);
  assert.match(finished[0].data.result, /"plan":\[/);
  assert.equal(finished[2].data.ok, false);
  assert.equal(finished[2].data.code, 'TOOL_PLAN_STEP_INVALID');
  const lastRound = model.calls.at(-1).messages;
  const badTool = lastRound.filter((message) => message.role === 'tool').pop();
  assert.match(JSON.parse(badTool.content).error, /步骤缺少说明/);
});
