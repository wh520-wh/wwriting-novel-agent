// 屏幕重演的取舍：哪些轮次重演、每轮重演什么。
//
// 两条不变量（P25 / P26）：
//   ① 重演的轮次集合与模型记得的轮次集合是**同一批**（同一份预算、同一套取舍）；
//   ② 屏幕上看得见的绝不少于模型记得的——「模型记得、屏幕看不到」是明确禁止的。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReplay } from '../../src/agent/replay.mjs';
import { DEFAULT_HISTORY_BUDGET_CHARS, buildHistoryMessages, projectTurns } from '../../src/agent/history.mjs';

let seq = 0;
function ev(type, data = {}, extra = {}) {
  seq += 1;
  return {
    schema_version: 1, seq, event_id: `ev_${seq}`,
    at: new Date(1700000000000 + seq * 1000).toISOString(),
    type, session_id: 'sess_1', run_id: extra.run_id ?? null, data,
  };
}
function reset() { seq = 0; }

function turn({ inputId, text, body, terminal = 'completed', reasoning = [] }) {
  const runId = `run_${inputId}`;
  const events = [ev('run_started', { input_id: inputId, text }, { run_id: runId })];
  for (const item of reasoning) {
    events.push(ev('reasoning_completed', item, { run_id: runId }));
  }
  // 正文一律也发一条 model_delta（R21）：run_interrupted / run_failed **不带 text**，
  // projectTurns 对这两种终态只改 terminal、不填 assistantText，
  // 正文的唯一来源就是 model_delta 的累加。少了这一条，「被停止的轮」根本重演不出正文，
  // 断言会在 undefined 上取 .text 直接 TypeError。
  // 对 completed 轮它也无害：projectTurns 以 run_completed.text 为权威全文，两者相同。
  if (body !== '') events.push(ev('model_delta', { text: body }, { run_id: runId }));
  if (terminal === 'completed') events.push(ev('run_completed', { text: body, rounds: 0, usage: null }, { run_id: runId }));
  if (terminal === 'interrupted') events.push(ev('run_interrupted', { reason: 'user_stop' }, { run_id: runId }));
  if (terminal === 'failed') events.push(ev('run_failed', { message: '连接中断', code: 'MODEL_NETWORK_ERROR' }, { run_id: runId }));
  return events;
}

test('一轮完整对话重演为：用户行 → 思考行 → 正文 → 收尾状态项（P24）', () => {
  reset();
  const { items } = buildReplay(turn({
    inputId: 'in_1', text: '写第一章', body: '第一章写好了。',
    reasoning: [{ text: '想想开头', started_at: new Date(1700000001000).toISOString() }],
  }));
  assert.deepEqual(items.map((item) => item.kind), ['user', 'thinking', 'prose', 'status']);
  assert.equal(items[0].text, '写第一章');
  assert.equal(items[2].text, '第一章写好了。');
  // status 项只带**判据**，不带文案（R5）：文案由终端层调 terminalStatusText 得出，
  // 这样事件桥与重演说的是同一句话，不会一个说「已停止」另一个说「已中断」。
  assert.deepEqual(items[3], { kind: 'status', terminal: 'completed', interruptReason: null, failCode: null });
});

test('思考项由 replay 自己扫事件得到，Turn 上没有任何 reasoning 字段（R1）', () => {
  reset();
  const events = turn({
    inputId: 'in_1', text: 'hi', body: '好。',
    reasoning: [{ text: '想', started_at: new Date(1700000001000).toISOString() }],
  });
  // 守门：history.mjs 的投影里绝不出现 reasoning（tests/agent/history.test.mjs:126 的同一条约束）。
  assert.equal(JSON.stringify(projectTurns(events)).includes('reasoning'), false);
  // 但重演仍然画得出思考行——因为它自己扫事件。
  assert.equal(buildReplay(events).items.filter((item) => item.kind === 'thinking').length, 1);
});

test('思考项按 run_id 归属到正确的轮次，不会串轮', () => {
  reset();
  const events = [
    ...turn({ inputId: 'in_1', text: '第一轮', body: '一。' }),
    ...turn({
      inputId: 'in_2', text: '第二轮', body: '二。',
      reasoning: [{ text: '只想了第二轮', started_at: new Date(1700000050000).toISOString() }],
    }),
  ];
  const { items } = buildReplay(events);
  // 顺序必须是：user(一) prose(一) status(一) user(二) thinking prose(二) status(二)
  assert.deepEqual(items.map((item) => item.kind),
    ['user', 'prose', 'status', 'user', 'thinking', 'prose', 'status']);
});

test('思考项的耗时从事件时间戳差算（P20），算不出时 durationMs 为 null', () => {
  reset();
  const events = turn({
    inputId: 'in_1', text: 'hi', body: '好。',
    reasoning: [{ text: '想', started_at: new Date(1700000001000).toISOString() }],
  });
  // reasoning_completed 是 events[1]，它的 at 比 started_at 晚 1 秒（ev() 每条 +1000ms）。
  const { items } = buildReplay(events);
  const thinking = items.find((item) => item.kind === 'thinking');
  assert.equal(thinking.durationMs, 1000);

  reset();
  const noStart = buildReplay(turn({
    inputId: 'in_2', text: 'hi', body: '好。', reasoning: [{ text: '想', started_at: null }],
  }));
  assert.equal(noStart.items.find((item) => item.kind === 'thinking').durationMs, null);
});

test('一轮里两段思考 → 两项，按事件顺序', () => {
  reset();
  const { items } = buildReplay(turn({
    inputId: 'in_1', text: 'hi', body: '好。',
    reasoning: [
      { text: '一', started_at: null },
      { text: '二', started_at: null },
    ],
  }));
  assert.equal(items.filter((item) => item.kind === 'thinking').length, 2);
});

test('没有思考时不凭空造一项', () => {
  reset();
  const { items } = buildReplay(turn({ inputId: 'in_1', text: 'hi', body: '好。' }));
  assert.deepEqual(items.map((item) => item.kind), ['user', 'prose', 'status']);
});

test('工具过程行不重演（P24：它们是过程，不是内容）', () => {
  reset();
  const runId = 'run_in_1';
  const events = [
    ev('run_started', { input_id: 'in_1', text: '数一下' }, { run_id: runId }),
    ev('activity_started', { tool: 'count_text', target: '第一章.md', call_id: 'c1' }, { run_id: runId }),
    ev('activity_finished', { tool: 'count_text', target: '第一章.md', ok: true, result: '{"charsNoSpace":3210}' }, { run_id: runId }),
    ev('run_completed', { text: '3210 字。', rounds: 1, usage: null }, { run_id: runId }),
  ];
  const { items } = buildReplay(events);
  assert.deepEqual(items.map((item) => item.kind), ['user', 'prose', 'status']);
  // 判据必须只能来自工具行：'3210 字。' 是正文本身（run_completed.text），任何非 prose 项
  // 都不该含它——但工具行的摘要是 '· count_text 第一章.md · 3210 字'（无句号），
  // 所以按它判会漏掉"重演了工具行"这个回归。用具名工具与被操作文件名来判，才是这条的靶心。
  const mentionsToolRow = items.some((item) => {
    const text = JSON.stringify(item);
    return text.includes('count_text') || text.includes('第一章.md');
  });
  assert.equal(mentionsToolRow, false, '工具过程行（含工具名/目标文件名）绝不能被重演');
});

test('被停止的轮：正文照实重演，状态项带上「用户停止」这个判据', () => {
  reset();
  const { items } = buildReplay(turn({
    inputId: 'in_1', text: '写第一章', body: '写了一半', terminal: 'interrupted',
  }));
  assert.equal(items.find((item) => item.kind === 'prose').text, '写了一半',
    '被停止不代表「那段话没说过」（与 history.mjs 的 projectTurns 同一条判断）');
  assert.deepEqual(items.at(-1),
    { kind: 'status', terminal: 'interrupted', interruptReason: 'user_stop', failCode: null });
});

test('失败的轮：状态项带上错误码作判据，但**判据不等于文案**（铁律 3 由终端层守）', () => {
  reset();
  const { items } = buildReplay(turn({ inputId: 'in_1', text: 'hi', body: '', terminal: 'failed' }));
  // agent 层如实带出 code，让终端层能区分「连接中断」与「操作失败」（R5）；
  // 它自己**不拼文案**，所以错误码不会从这里直接漏到屏幕上。
  assert.deepEqual(items.at(-1),
    { kind: 'status', terminal: 'failed', interruptReason: null, failCode: 'MODEL_NETWORK_ERROR' });
});

test('未闭合的轮（崩溃残留）标为 open，不猜它成功了', () => {
  reset();
  const events = [ev('run_started', { input_id: 'in_1', text: 'hi' }, { run_id: 'run_in_1' })];
  const { items } = buildReplay(events);
  assert.deepEqual(items.at(-1),
    { kind: 'status', terminal: 'open', interruptReason: null, failCode: null });
});

test('正文为空的轮不重演空正文行', () => {
  reset();
  const { items } = buildReplay(turn({ inputId: 'in_1', text: 'hi', body: '' }));
  assert.equal(items.some((item) => item.kind === 'prose'), false);
});

test('多轮按时间正序重演', () => {
  reset();
  const { items } = buildReplay([
    ...turn({ inputId: 'in_1', text: '写第一章', body: '好了。' }),
    ...turn({ inputId: 'in_2', text: '写第二章', body: '也好了。' }),
  ]);
  const users = items.filter((item) => item.kind === 'user').map((item) => item.text);
  assert.deepEqual(users, ['写第一章', '写第二章']);
});

test('空日志 → 没有任何重演项，omittedTurns 为 0', () => {
  reset();
  assert.deepEqual(buildReplay([]), { items: [], omittedTurns: 0, keptTurns: 0 });
});

test('只有 session_created 之类非轮次事件 → 同样没有重演项', () => {
  reset();
  const { items } = buildReplay([ev('session_created', { title: '' })]);
  assert.deepEqual(items, []);
});

test('重演的轮次集合与模型记得的**是同一批**（P25 / P26）', () => {
  reset();
  const events = [];
  for (let index = 0; index < 40; index += 1) {
    events.push(...turn({
      inputId: `in_${index}`,
      text: `第${index}轮输入${'x'.repeat(400)}`,
      body: `第${index}轮正文${'y'.repeat(1200)}`,
    }));
  }
  const budget = 6000;
  const { items, omittedTurns, keptTurns } = buildReplay(events, { budgetChars: budget });
  const turns = projectTurns(events);
  const built = buildHistoryMessages(turns, { budgetChars: budget });
  assert.equal(keptTurns, built.keptTurns, '保留的轮数必须一致');
  assert.equal(omittedTurns, built.truncatedTurns, '省略的轮数必须一致');

  const replayedUsers = items.filter((item) => item.kind === 'user').map((item) => item.text);
  const modelUsers = built.messages.filter((message) => message.role === 'user').map((message) => message.content);
  assert.deepEqual(replayedUsers, modelUsers, '屏幕上重演的用户行 = 模型记得的用户输入，一字不差');
});

test('默认预算就是模型记忆的那一份（DEFAULT_HISTORY_BUDGET_CHARS）', () => {
  reset();
  const events = [];
  for (let index = 0; index < 60; index += 1) {
    events.push(...turn({ inputId: `in_${index}`, text: `输入${index}`, body: 'y'.repeat(3000) }));
  }
  const { keptTurns } = buildReplay(events);
  const built = buildHistoryMessages(projectTurns(events), { budgetChars: DEFAULT_HISTORY_BUDGET_CHARS });
  assert.equal(keptTurns, built.keptTurns);
  assert.equal(keptTurns, 60, '默认完整重演，不再套用旧 24000 字符上限');
});

test('被省略的更早轮次如实计入 omittedTurns（供渲染层说明「省略了多少」）', () => {
  reset();
  const events = [];
  for (let index = 0; index < 30; index += 1) {
    events.push(...turn({ inputId: `in_${index}`, text: `输入${index}`, body: 'y'.repeat(3000) }));
  }
  const { omittedTurns, keptTurns } = buildReplay(events, { budgetChars: 6000 });
  assert.equal(omittedTurns + keptTurns, 30);
  assert.ok(omittedTurns > 0);
});

test('P26：屏幕重演的用户行与正文，逐轮覆盖模型拿到的那一批', () => {
  reset();
  const events = [];
  for (let index = 0; index < 12; index += 1) {
    events.push(...turn({ inputId: `in_${index}`, text: `第${index}轮输入`, body: `第${index}轮正文${'y'.repeat(900)}` }));
  }
  const budget = 6000;
  const { items, keptTurns } = buildReplay(events, { budgetChars: budget });
  const built = buildHistoryMessages(projectTurns(events), { budgetChars: budget });

  // ① 轮次集合一致（P25）。
  assert.equal(keptTurns, built.keptTurns);
  assert.ok(keptTurns > 0 && keptTurns < 12, '预算确实在起作用，不是全都重演');

  // ② 用户行逐条相同、顺序相同。
  const replayedUsers = items.filter((item) => item.kind === 'user').map((item) => item.text);
  const modelUsers = built.messages.filter((message) => message.role === 'user').map((message) => message.content);
  assert.deepEqual(replayedUsers, modelUsers);

  // ③ 逐轮比对正文——**不是**比总字数。
  // 原计划这里写的是 `replayedChars >= modelChars || replayedChars > 0`，那是恒真式：
  // 只要重演了任何东西就通过，等于什么都没测（R11）。
  const replayedProse = items.filter((item) => item.kind === 'prose').map((item) => item.text);
  const modelAssistants = built.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => String(message.content));
  assert.equal(modelAssistants.length, replayedProse.length);
  modelAssistants.forEach((content, index) => {
    // 模型的 assistant 消息里除了正文还折进了工具行（history.mjs 的 turnMessages），
    // 所以断言的是「正文那一段被屏幕覆盖」，不是两个字符串相等。
    const prose = replayedProse[index];
    assert.ok(content.includes(prose) || prose.length >= content.length,
      `第 ${index} 轮：屏幕 ${prose.length} 字，模型 ${content.length} 字`);
  });
});

test('单轮就超预算时：屏幕重演全文，模型拿到截尾——方向是安全的（屏幕 ⊇ 模型）', () => {
  reset();
  const events = turn({ inputId: 'in_1', text: '写一整章', body: 'z'.repeat(20000) });
  const budget = 5000;
  const { items } = buildReplay(events, { budgetChars: budget });
  const built = buildHistoryMessages(projectTurns(events), { budgetChars: budget });
  const replayedChars = items.filter((item) => item.kind === 'prose').reduce((n, item) => n + item.text.length, 0);
  const modelChars = built.messages
    .filter((message) => message.role === 'assistant')
    .reduce((n, message) => n + String(message.content).length, 0);
  assert.equal(replayedChars, 20000);
  assert.ok(modelChars < replayedChars, `模型 ${modelChars} 字应当少于屏幕 ${replayedChars} 字`);
});

test('P26 的已知残余缺口：工具摘要进了模型上下文但不重演（R11，钉住它而不是盖过去）', () => {
  reset();
  const runId = 'run_in_1';
  const events = [
    ev('run_started', { input_id: 'in_1', text: '数一下' }, { run_id: runId }),
    ev('activity_started', { tool: 'count_text', target: '第一章.md', call_id: 'c1' }, { run_id: runId }),
    ev('activity_finished', { tool: 'count_text', target: '第一章.md', ok: true, result: '{"charsNoSpace":3210}' }, { run_id: runId }),
    ev('run_completed', { text: '数完了。', rounds: 1, usage: null }, { run_id: runId }),
  ];
  const { items } = buildReplay(events);
  const modelAssistant = buildHistoryMessages(projectTurns(events)).messages
    .find((message) => message.role === 'assistant').content;
  const replayedProse = items.filter((item) => item.kind === 'prose').map((item) => item.text).join('');

  assert.ok(modelAssistant.includes('3210'), '模型上下文里有工具摘要');
  assert.equal(replayedProse.includes('3210'), false, '屏幕重演里没有（P24 明确不重演工具行）');
  // 这条用例的意义是**把缺口钉在测试里**：谁哪天想声称「P26 完全成立」，会先撞红这一条。
  // P26 的适用范围因此要限定为「对话内容」，工具摘要这层残余如实记在 ADR-0011。
});

test('当前计划：与投影同一口径——run_started 清空、plan_updated 整表替换', () => {
  reset();
  const events = [
    ...turn({ inputId: 'in_1', text: '改这三章', body: '改完了。' }),
    ev('plan_updated', { items: [{ summary: '改第二章', status: 'completed' }] }, { run_id: 'run_in_1' }),
    // 第二轮把计划更新成两步（整表替换，第一版的单步表消失）。
    ...turn({ inputId: 'in_2', text: '再检查一遍', body: '查完了。' }),
    ev('plan_updated', {
      items: [{ summary: '改第二章', status: 'completed' }, { summary: '检查衔接', status: 'in_progress' }],
    }, { run_id: 'run_in_2' }),
  ];
  const { plan } = buildReplay(events);
  assert.deepEqual(plan, [
    { summary: '改第二章', status: 'completed' },
    { summary: '检查衔接', status: 'in_progress' },
  ]);
});

test('没有计划、或最后一段被新 Run 清空时，plan 为 null（绝不拿旧计划冒充当前）', () => {
  reset();
  const { plan: none } = buildReplay(turn({ inputId: 'in_1', text: 'hi', body: '好。' }));
  assert.equal(none, null);

  reset();
  const stale = [
    ...turn({ inputId: 'in_1', text: '改这三章', body: '改完了。' }),
    ev('plan_updated', { items: [{ summary: '改第二章' }] }, { run_id: 'run_in_1' }),
    // 后面又开了一轮、但没立计划：旧计划不得冒充当前状态（口径 A）。
    ...turn({ inputId: 'in_2', text: '接着聊', body: '好。' }),
  ];
  assert.equal(buildReplay(stale).plan, null);
});
