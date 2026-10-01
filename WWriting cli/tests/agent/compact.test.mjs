// 会话压缩执行测试：摘要由模型增量收集、去首尾空白、超长截断、空返回如实抛错。
// 模型客户端是脚本化假实现（只走 streamChat 契约），断言的是 compact.mjs 自己的行为。
import test from 'node:test';
import assert from 'node:assert/strict';

import { COMPACTION_SYSTEM_PROMPT, runCompaction } from '../../src/agent/compact.mjs';

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

test('runCompaction 超长截断到 maxChars', async () => {
  const model = makeModel(['长'.repeat(100)]);
  const digest = await runCompaction({ modelClient: model, messages: [{ role: 'user', content: 'x' }], maxChars: 50 });
  assert.equal(digest.length, 50);
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
