// 历史投影与预算截断的纯函数测试。
// 这些规则决定了「模型记得多少」，每一条都对应一个明确的产品决定，因此逐条钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HISTORY_BUDGET_CHARS,
  buildDigestMessage,
  buildHistoryMessages,
  estimateChars,
  latestDigest,
  projectTurns,
} from '../../src/agent/history.mjs';

// —— 构造事件的助手：只填投影真正读的字段 ——

let seq = 0;
function ev(type, data = {}, extra = {}) {
  seq += 1;
  return {
    schema_version: 1,
    seq,
    event_id: `ev_${seq}`,
    at: new Date(1700000000000 + seq * 1000).toISOString(),
    type,
    session_id: 'sess_1',
    run_id: extra.run_id ?? null,
    data,
  };
}

function reset() {
  seq = 0;
}

// 一轮完整对话：用户 → 工具成功 → 正文 → 完成。
function completedTurn({ inputId = 'in_1', text = '写第一章', body = '第一章写好了。' } = {}) {
  return [
    ev('run_started', { input_id: inputId, text }, { run_id: `run_${inputId}` }),
    ev('activity_started', { tool: 'count_text', target: '第一章.md', call_id: 'c1' }, { run_id: `run_${inputId}` }),
    ev('activity_finished', { tool: 'count_text', target: '第一章.md', ok: true, result: '{"charsNoSpace":3210}' }, { run_id: `run_${inputId}` }),
    ev('run_completed', { text: body, rounds: 1, usage: { totalTokens: 1200 } }, { run_id: `run_${inputId}` }),
  ];
}

// —— 投影 ——

test('一整轮对话被投影成携带用户输入、工具与正文的 Turn', () => {
  reset();
  const turns = projectTurns(completedTurn());
  assert.equal(turns.length, 1);
  const [turn] = turns;
  assert.equal(turn.inputId, 'in_1');
  assert.equal(turn.userText, '写第一章');
  assert.equal(turn.assistantText, '第一章写好了。');
  assert.equal(turn.terminal, 'completed');
  assert.equal(turn.tools.length, 1);
  assert.deepEqual(turn.tools[0], {
    name: 'count_text',
    target: '第一章.md',
    ok: true,
    summary: '3210 字',
  });
});

test('工具失败轮被标为 ok=false 且带中文短摘要', () => {
  reset();
  const turns = projectTurns([
    ev('run_started', { input_id: 'in_1', text: '读一下' }, { run_id: 'run_1' }),
    ev('activity_started', { tool: 'read_file', target: '没有.md', call_id: 'c1' }, { run_id: 'run_1' }),
    ev('activity_finished', { tool: 'read_file', target: '没有.md', ok: false, code: 'TOOL_FAILED', message: '文件不存在。' }, { run_id: 'run_1' }),
    ev('run_completed', { text: '文件不存在。' }, { run_id: 'run_1' }),
  ]);
  assert.equal(turns[0].tools[0].ok, false);
  // 失败结果没有已知摘要字段 → summary 为 null（宁可不说，也不编数字）。
  assert.equal(turns[0].tools[0].summary, null);
});

test('被中断的轮保留已产生的可见文本，且标为 interrupted', () => {
  reset();
  const turns = projectTurns([
    ev('run_started', { input_id: 'in_1', text: '继续写' }, { run_id: 'run_1' }),
    ev('model_delta', { text: '他推开门，' }, { run_id: 'run_1' }),
    ev('model_delta', { text: '雨还在下。' }, { run_id: 'run_1' }),
    ev('run_interrupted', { reason: 'user_stop', rounds: 0 }, { run_id: 'run_1' }),
  ]);
  assert.equal(turns[0].terminal, 'interrupted');
  // 用户停止不代表那段话没说过：已产生的正文必须留下来。
  assert.equal(turns[0].assistantText, '他推开门，雨还在下。');
});

test('失败的轮标为 failed，且不丢已经产生的内容', () => {
  reset();
  const turns = projectTurns([
    ev('run_started', { input_id: 'in_1', text: '写' }, { run_id: 'run_1' }),
    ev('model_delta', { text: '开了个头。' }, { run_id: 'run_1' }),
    ev('run_failed', { message: '这一轮执行失败，请稍后重试。', code: 'RUN_FAILED' }, { run_id: 'run_1' }),
  ]);
  assert.equal(turns[0].terminal, 'failed');
  assert.equal(turns[0].assistantText, '开了个头。');
});

test('未闭合的轮标为 open（崩溃残留如实呈现，不猜测它成功）', () => {
  reset();
  const turns = projectTurns([
    ev('run_started', { input_id: 'in_1', text: '写到一半崩了' }, { run_id: 'run_1' }),
    ev('model_delta', { text: '半句' }, { run_id: 'run_1' }),
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].terminal, 'open');
});

test('孤立的 activity 事件被忽略且不抛错', () => {
  reset();
  const turns = projectTurns([
    ev('activity_started', { tool: 'read_file', call_id: 'c1' }),
    ev('activity_finished', { tool: 'read_file', ok: true, result: '{"text":"x"}' }),
    ev('session_created', { title: '' }),
  ]);
  assert.deepEqual(turns, []);
});

test('非数组与非对象输入不会让投影崩掉', () => {
  assert.deepEqual(projectTurns(null), []);
  assert.deepEqual(projectTurns(undefined), []);
  assert.deepEqual(projectTurns([null, 42, 'x']), []);
});

test('投影里绝不出现 reasoning 字段（私有字段不得从这条路径回流）', () => {
  reset();
  // 即便某天日志里混进了 reasoning，投影也必须不采纳它——这是铁律层面的约束，值得有守门用例。
  const turns = projectTurns([
    ev('run_started', { input_id: 'in_1', text: '写' }, { run_id: 'run_1' }),
    ev('model_delta', { text: '正文。', reasoning_content: '我在想……' }, { run_id: 'run_1' }),
    ev('run_completed', { text: '正文。' }, { run_id: 'run_1' }),
  ]);
  const seen = JSON.stringify(turns);
  assert.ok(!seen.includes('reasoning'));
  assert.ok(!seen.includes('我在想'));
});

test('多轮按时间正序投影，工具按 call_id 正确配对', () => {
  reset();
  const turns = projectTurns([
    ...completedTurn({ inputId: 'in_1', text: '第一条', body: '一' }),
    ...completedTurn({ inputId: 'in_2', text: '第二条', body: '二' }),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].userText, '第一条');
  assert.equal(turns[1].userText, '第二条');
  assert.equal(turns[0].tools[0].summary, '3210 字');
});

test('call_id 缺失时按顺序把结果配回最后一条未收尾的调用', () => {
  reset();
  const turns = projectTurns([
    ev('run_started', { input_id: 'in_1', text: '写' }, { run_id: 'run_1' }),
    ev('activity_started', { tool: 'count_text' }, { run_id: 'run_1' }),
    ev('activity_finished', { tool: 'count_text', ok: true, result: '{"charsNoSpace":7}' }, { run_id: 'run_1' }),
    ev('run_completed', { text: '好' }, { run_id: 'run_1' }),
  ]);
  assert.equal(turns[0].tools[0].summary, '7 字');
});

// —— 预算与截断 ——

test('预算充足时全量保留，truncatedTurns 为 0', () => {
  reset();
  const turns = projectTurns([
    ...completedTurn({ inputId: 'in_1', text: '第一条', body: '一' }),
    ...completedTurn({ inputId: 'in_2', text: '第二条', body: '二' }),
  ]);
  const result = buildHistoryMessages(turns, { budgetChars: DEFAULT_HISTORY_BUDGET_CHARS });
  assert.equal(result.truncatedTurns, 0);
  assert.equal(result.keptTurns, 2);
  assert.equal(result.messages.length, 4); // 每轮 user + assistant
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[0].content, '第一条');
});

test('预算只够最近一轮时，只保留最新的一轮并如实记录省略数', () => {
  reset();
  const turns = projectTurns([
    ...completedTurn({ inputId: 'in_1', text: '第一条', body: '一' }),
    ...completedTurn({ inputId: 'in_2', text: '第二条', body: '二' }),
  ]);
  const oneTurnCost = estimateChars([
    { role: 'user', content: '第二条' },
    { role: 'assistant', content: '· count_text 第一章.md · 3210 字\n\n二' },
  ]);
  const result = buildHistoryMessages(turns, { budgetChars: oneTurnCost });
  assert.equal(result.keptTurns, 1);
  assert.equal(result.truncatedTurns, 1);
  // 保下来的是最新的那一轮（离「现在」最近）。每轮是 [user, assistant]，user 在下标 0。
  assert.equal(result.messages[0].content, '第二条');
});

test('返回的消息按时间正序（最早的在前）', () => {
  reset();
  const turns = projectTurns([
    ...completedTurn({ inputId: 'in_1', text: '最早', body: 'A' }),
    ...completedTurn({ inputId: 'in_2', text: '中间', body: 'B' }),
    ...completedTurn({ inputId: 'in_3', text: '最新', body: 'C' }),
  ]);
  const result = buildHistoryMessages(turns, { budgetChars: DEFAULT_HISTORY_BUDGET_CHARS });
  const users = result.messages.filter((m) => m.role === 'user').map((m) => m.content);
  assert.deepEqual(users, ['最早', '中间', '最新']);
});

test('预算极小（连一轮都放不下）时返回空数组而不是 null', () => {
  reset();
  const turns = projectTurns(completedTurn());
  const result = buildHistoryMessages(turns, { budgetChars: 1 });
  assert.deepEqual(result.messages, []);
  assert.equal(result.keptTurns, 0);
  assert.equal(result.usedChars, 0);
});

test('已用字符数不超过预算（单轮超预算时按尾部截断正文）', () => {
  reset();
  const longBody = '甲'.repeat(5000);
  const turns = projectTurns(completedTurn({ text: '指令', body: longBody }));
  const result = buildHistoryMessages(turns, { budgetChars: 1000 });
  assert.ok(result.usedChars <= 1000, `usedChars=${result.usedChars} 应不超过 1000`);
  assert.equal(result.keptTurns, 1);
  // 原则①：用户输入永不被截断。
  assert.equal(result.messages[0].content, '指令');
  // 原则②：截的是正文尾部 —— 保留的是结尾那段。
  assert.ok(result.messages[1].content.endsWith('甲'));
});

test('空轮次数组返回空结果且不抛错', () => {
  const result = buildHistoryMessages([], { budgetChars: 1000 });
  assert.deepEqual(result.messages, []);
  assert.equal(result.truncatedTurns, 0);
  assert.equal(result.keptTurns, 0);
  assert.deepEqual(buildHistoryMessages(null).messages, []);
});

test('没有产出的轮次仍生成一对消息（空 content 会被服务端拒绝，用占位说明）', () => {
  reset();
  const turns = projectTurns([
    ev('run_started', { input_id: 'in_1', text: '在吗' }, { run_id: 'run_1' }),
    ev('run_completed', { text: '' }, { run_id: 'run_1' }),
  ]);
  const result = buildHistoryMessages(turns, { budgetChars: 1000 });
  assert.equal(result.messages.length, 2);
  assert.ok(result.messages[1].content.length > 0);
});

test('estimateChars 只量 content 的字面长度', () => {
  assert.equal(estimateChars([]), 0);
  assert.equal(estimateChars(null), 0);
  assert.equal(estimateChars([{ role: 'user', content: 'abc' }, { role: 'assistant', content: 'de' }]), 5);
});

test('工具调用被折成 assistant 的可读陈述，且不含参数原文', () => {
  reset();
  const turns = projectTurns([
    ev('run_started', { input_id: 'in_1', text: '写第一章' }, { run_id: 'run_1' }),
    ev('activity_started', { tool: 'write_file', target: '第一章.md', call_id: 'c1' }, { run_id: 'run_1' }),
    ev('activity_finished', { tool: 'write_file', target: '第一章.md', ok: true, resultChars: 20000 }, { run_id: 'run_1' }),
    ev('run_completed', { text: '第一章写好了。' }, { run_id: 'run_1' }),
  ]);
  const result = buildHistoryMessages(turns, { budgetChars: 1000 });
  const assistant = result.messages[1].content;
  assert.ok(assistant.includes('write_file 第一章.md'));
  assert.ok(assistant.includes('约 '));
  assert.ok(assistant.includes('第一章写好了。'));
});

// —— 终态的原因与错误码进投影（供重演与事件桥共用同一份文案，R5）——

test('被停止的轮带上 interruptReason，失败的轮带上 failCode', () => {
  reset();
  const [stopped] = projectTurns([
    ev('run_started', { input_id: 'in_1', text: '写' }, { run_id: 'run_1' }),
    ev('run_interrupted', { reason: 'aborted' }, { run_id: 'run_1' }),
  ]);
  assert.equal(stopped.interruptReason, 'aborted');
  assert.equal(stopped.failCode, null);

  reset();
  const [failed] = projectTurns([
    ev('run_started', { input_id: 'in_2', text: '写' }, { run_id: 'run_2' }),
    ev('run_failed', { message: '连接中断', code: 'MODEL_NETWORK_ERROR' }, { run_id: 'run_2' }),
  ]);
  assert.equal(failed.failCode, 'MODEL_NETWORK_ERROR');
  assert.equal(failed.interruptReason, null);
});

test('正常完成与未闭合的轮两者都是 null', () => {
  reset();
  const [completed] = projectTurns(completedTurn());
  assert.deepEqual({ r: completed.interruptReason, c: completed.failCode }, { r: null, c: null });
});

test('这两个字段**只用于选文案**，绝不进回喂给模型的 messages', () => {
  reset();
  const turns = projectTurns([
    ev('run_started', { input_id: 'in_1', text: '写' }, { run_id: 'run_1' }),
    ev('run_failed', { message: '连接中断', code: 'MODEL_NETWORK_ERROR' }, { run_id: 'run_1' }),
  ]);
  const joined = buildHistoryMessages(turns).messages.map((m) => m.content).join('\n');
  assert.equal(joined.includes('MODEL_NETWORK_ERROR'), false, '错误码不进模型上下文（铁律 3 同源）');
});

test('思考事件被投影**整个忽略**：既不进 Turn，也不进 messages（R1 / P22）', () => {
  reset();
  const turns = projectTurns([
    ev('run_started', { input_id: 'in_1', text: '写' }, { run_id: 'run_1' }),
    ev('reasoning_completed', { text: '我在想主角的名字', started_at: null, chars: 8 }, { run_id: 'run_1' }),
    ev('run_completed', { text: '正文。' }, { run_id: 'run_1' }),
  ]);
  assert.equal(turns.length, 1);
  assert.equal(JSON.stringify(turns).includes('我在想'), false);
  const joined = buildHistoryMessages(turns).messages.map((m) => m.content).join('\n');
  assert.equal(joined.includes('我在想'), false);
});

// —— 会话压缩（/compact）：摘要注入与覆盖判定 ——

test('buildDigestMessage：标记与文本只有一处拼法', () => {
  const message = buildDigestMessage('主角已拿到钥匙');
  assert.equal(message.role, 'user');
  assert.match(message.content, /^\[会话摘要\]\n主角已拿到钥匙$/);
});

test('latestDigest 取最后一条；畸形与空摘要跳过；没有时为 null', () => {
  const first = { type: 'digest_compacted', data: { digest: '第一份', through_seq: 5 } };
  const second = { type: 'digest_compacted', data: { digest: '第二份', through_seq: 12 } };
  assert.equal(latestDigest([]), null);
  assert.equal(latestDigest([{ type: 'run_started', data: {} }]), null);
  assert.equal(latestDigest([{ type: 'digest_compacted', data: { digest: '', through_seq: 3 } }]), null);
  assert.equal(latestDigest([{ type: 'digest_compacted', data: { digest: 'x' } }]).throughSeq, 0);
  assert.equal(latestDigest([first, second]).text, '第二份');
  assert.equal(latestDigest([first, second]).throughSeq, 12);
});

test('projectTurns 给每轮带 startSeq（压缩按它判覆盖）', () => {
  const events = [
    { type: 'run_started', seq: 3, run_id: 'run_1', data: { input_id: 'in_1', text: '写第一章' } },
    { type: 'run_completed', seq: 4, run_id: 'run_1', data: { text: '写好了', rounds: 0, usage: null } },
  ];
  const [turn] = projectTurns(events);
  assert.equal(turn.startSeq, 3);
});

test('buildHistoryMessages：摘要插在最前、计入预算，无轮次时摘要独占', () => {
  const digest = buildDigestMessage('前情：主角已拿到钥匙');
  const turns = projectTurns([
    ...turn({ inputId: 'in_1', text: '写第一章', body: '第一章好了。' }),
    ...turn({ inputId: 'in_2', text: '写第二章', body: '第二章好了。' }),
  ]);
  const withDigest = buildHistoryMessages(turns, { budgetChars: DEFAULT_HISTORY_BUDGET_CHARS, digest });
  assert.equal(withDigest.messages[0].content.startsWith('[会话摘要]'), true);
  assert.equal(withDigest.keptTurns, 2);
  assert.equal(withDigest.usedChars, estimateChars([digest]) + estimateChars(withDigest.messages.slice(1)));

  // 预算被摘要吃掉一大半：room 连最新一轮的**用户输入**都放不下时（原则②不触发），
  // 轮次一个都不装，摘要独占——「同一本账」意味着摘要真的在挤占轮次的空间。
  const tight = buildHistoryMessages(turns, { budgetChars: estimateChars([digest]) + 3, digest });
  assert.equal(tight.keptTurns, 0);
  assert.deepEqual(tight.messages, [digest]);

  // room 还装得下用户输入时，最新一轮按原则②部分保留（既有语义不因摘要改变）。
  const partial = buildHistoryMessages(turns, { budgetChars: estimateChars([digest]) + 5, digest });
  assert.equal(partial.keptTurns, 1);

  // 没有轮次时摘要独占上下文（压缩后立刻新开会话轮的形状）。
  const digestOnly = buildHistoryMessages([], { digest });
  assert.deepEqual(digestOnly.messages, [digest]);
});

function turn({ inputId, text, body }) {
  const runId = `run_${inputId}`;
  return [
    { type: 'run_started', seq: nextSeq(), run_id: runId, data: { input_id: inputId, text } },
    { type: 'model_delta', seq: nextSeq(), run_id: runId, data: { text: body } },
    { type: 'run_completed', seq: nextSeq(), run_id: runId, data: { text: body, rounds: 0, usage: null } },
  ];
}
let digestSeqCounter = 100;
function nextSeq() {
  digestSeqCounter += 1;
  return digestSeqCounter;
}
