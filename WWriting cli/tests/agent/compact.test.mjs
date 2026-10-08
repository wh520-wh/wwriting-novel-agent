// 会话压缩执行测试：摘要由模型增量收集、去首尾空白、超长截断、空返回如实抛错。
// 模型客户端是脚本化假实现（只走 streamChat 契约），断言的是 compact.mjs 自己的行为。
import test from 'node:test';
import assert from 'node:assert/strict';

import { COMPACTION_SYSTEM_PROMPT, runCompaction, fitContext } from '../../src/agent/compact.mjs';

function makeModel(deltas, { record = null } = {}) {
  return {
    async streamChat({ messages, onDelta, tools }) {
      if (record) record({ messages, tools });
      for (const delta of deltas) onDelta(delta);
      return { text: deltas.join(''), toolCalls: [], usage: null };
    },
  };
}

test('runCompaction：拼增量、去空白、系统提示在前、不下发 tools', async () => {
  let seen = null;
  const model = makeModel(['主角', '拿到了钥匙。', '\n'], { record: ({ messages, tools }) => { seen = { messages, tools }; } });
  const digest = await runCompaction({
    modelClient: model,
    messages: [{ role: 'user', content: '写第一章' }, { role: 'assistant', content: '第一章好了。' }],
  });
  assert.equal(digest, '主角拿到了钥匙。');
  assert.equal(seen.tools, undefined, '压缩不给工具：它不是对话轮');
  assert.equal(seen.messages[0].role, 'system');
  assert.equal(seen.messages[0].content, COMPACTION_SYSTEM_PROMPT);
  assert.equal(seen.messages.length, 3, '对话消息原样跟在系统提示后');
});

test('摘要超过旧 6000 字符仍完整保留，末尾事实不被切掉', async () => {
  const text = `${'长'.repeat(8000)}最后一个伏笔仍未回收。`;
  const digest = await runCompaction({ modelClient: makeModel([text]), messages: [{ role: 'user', content: 'x' }] });
  assert.equal(digest, text);
});

test('跨窗口分批吸收所有原文；请求不超预算，失败与输出截断拒绝发布摘要', async () => {
  const seen = [];
  const model = makeModel(['已保留事实。'], { record: ({ messages }) => seen.push(messages) });
  const content = '🙂关键事实。'.repeat(1000) + '末尾线索';
  await runCompaction({ modelClient: model, messages: [{ role: 'user', content }], budgetChars: 3000 });
  assert.ok(seen.length > 1);
  assert.ok(seen.every((messages) => messages.reduce((n, m) => n + m.content.length, 0) <= 3000));
  const chunks = seen.map((messages) => messages.at(-1).content).join('');
  assert.equal(chunks, JSON.stringify({ role: 'user', content }));
  await assert.rejects(() => runCompaction({
    modelClient: { async streamChat({ onDelta }) { onDelta('半份摘要'); return { finishReason: 'length' }; } },
    messages: [{ role: 'user', content: 'x' }],
  }), /未完整/);
});

test('轮内窗口增长：压缩旧内容，当前指令与最新工具调用结果逐字保留', async () => {
  const calls = [];
  const model = makeModel(['前情和已执行操作的摘要。'], { record: ({ messages }) => calls.push(messages) });
  model.getLimits = () => ({ contextWindow: 20000, maxOutputTokens: 2000 });
  const current = { role: 'user', content: '继续写第二章，别动第一章' };
  const latest = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: '当前文件全文。' },
  ];
  const messages = [
    { role: 'system', content: '系统指令' }, { role: 'user', content: '[Project Memory: WWRITING.md]\n设定' },
    { role: 'user', content: '旧指令' }, { role: 'assistant', content: '章'.repeat(13000) }, current,
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] }, { role: 'tool', tool_call_id: 'c1', content: '旧工具结果'.repeat(1000) },
    ...latest,
  ];
  await fitContext({ modelClient: model, messages, tools: [], signal: null, prefixLength: 2 });
  assert.ok(calls.length > 0);
  assert.deepEqual(messages.slice(-3), [current, ...latest]);
  assert.match(messages[2].content, /前情和已执行操作/);
  assert.ok(calls.map((batch) => JSON.stringify(batch)).join('').includes('旧工具结果'));
});

test('模型空返回时如实抛错，绝不交一份空摘要', async () => {
  const model = makeModel(['   ']);
  await assert.rejects(
    () => runCompaction({ modelClient: model, messages: [{ role: 'user', content: 'x' }] }),
    /没有返回摘要/,
  );
});

test('没有模型或没有内容时给出可理解的中文错误', async () => {
  await assert.rejects(() => runCompaction({ modelClient: null, messages: [] }), /模型客户端/);
  await assert.rejects(() => runCompaction({ modelClient: makeModel(['x']), messages: [] }), /没有可压缩/);
});
