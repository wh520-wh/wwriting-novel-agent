// 事件桥（event-bridge.mjs）单测：事件 → 渲染调用的**翻译**。
// 屏幕上「长什么样」的断言归 renderer.test.mjs（实时区面板、折行形态）；
// 这里断言「哪条事件翻译成哪次调用、文案与去向对不对」、包装器的透传，以及装配期契约校验。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createEventRenderer } from '../../src/terminal/event-bridge.mjs';
import { createRenderer } from '../../src/terminal/renderer.mjs';
import { screenText } from '../helpers/screen.mjs';
import { createRunController } from '../../src/agent/run-controller.mjs';
import { createSessionManager } from '../../src/session/session-manager.mjs';
import { createEventStore } from '../../src/session/event-store.mjs';
import { createWorkspaceStore } from '../../src/storage/workspace-store.mjs';
import {
  assertNoColor, cleanupTempRoots, feed, makeFakeComposer, makeRenderer, makeStdout, makeTempRoot,
} from './support.mjs';

after(cleanupTempRoots);

test('事件桥：模型 delta 变成正文、活动事件变成活动行、Run 终态变成状态行', () => {
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'run_started', { input_id: 'i-1', text: '写第一章' });
  feed(bridge, 'model_delta', { text: '第一章' });
  feed(bridge, 'model_delta', { text: '开始。' });
  feed(bridge, 'activity_started', { tool: 'read_file', target: '大纲.md' });
  feed(bridge, 'activity_finished', { tool: 'read_file', target: '大纲.md', ok: true });
  feed(bridge, 'model_delta', { text: '写好了。' });
  feed(bridge, 'run_completed', { text: '第一章开始。写好了。' });
  const text = stdout.text();
  assert.ok(text.includes('思考中'));
  assert.ok(text.includes('第一章开始。'), '正文按顺序落盘');
  assert.ok(text.includes('读取文件 大纲.md'), '活动行用中文标签');
  assert.ok(text.includes('✓'));
  assert.ok(text.includes('写好了。'), '活动之后到达的正文照样落盘');
  assert.ok(stdout.text().endsWith('已完成\n'), 'Run 结束留下终态（框线由输入区画）');
});

test('事件桥：排队输入、确认卡与失败/中断终态', () => {
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'input_queued', { input_id: 'i-2', text: '再写一章' });
  feed(bridge, 'decision_pending', {
    decision_id: 'dec-1',
    level: 'extreme',
    tool: 'delete_file',
    target: '草稿.md',
    choices: ['confirm', 'deny'],
    confirmation_text: '确认删除 a1b2c3',
  });
  feed(bridge, 'run_failed', { message: '网络连接失败，请稍后重试。', code: 'MODEL_NETWORK' });
  const text = stdout.text();
  assert.ok(text.includes('再写一章'));
  assert.ok(text.includes('确认删除 a1b2c3'), '极端确认文字必须展示原文');
  assert.ok(text.includes('操作失败'));
  assert.ok(text.includes('网络连接失败'), '失败只呈现一条用户可理解的事实');
  assert.ok(!text.includes('MODEL_NETWORK'), '错误码不进主文案');

  const second = makeRenderer();
  const bridge2 = createEventRenderer({ renderer: second.renderer });
  feed(bridge2, 'run_started', {});
  feed(bridge2, 'run_interrupted', { reason: 'user_stop' });
  assert.ok(second.stdout.text().endsWith('已停止\n'), '中断终态同样落盘');
});

test('事件桥：能开选择器时把普通确认交给 onDecision，极端确认仍只留在卡片上', () => {
  const { renderer, stdout } = makeRenderer();
  const seen = [];
  const bridge = createEventRenderer({
    renderer,
    onDecision: async (decision) => { seen.push(decision.decision_id); },
  });

  const write = {
    decision_id: 'dec-w', level: 'write', tool: 'write_file', target: '第一章.md',
    choices: ['once', 'input', 'deny'], confirmation_text: null,
  };
  feed(bridge, 'decision_pending', write);
  assert.deepEqual(seen, ['dec-w'], '普通确认交给交互入口（谁接上谁开选择器）');
  assert.ok(stdout.text().includes('需要确认：写入文件 第一章.md'));
  assert.equal(stdout.text().includes('回复'), false, '选项由选择器显示，卡片不再教怎么答');

  // 极端确认不走选择器：它要的是抄写当次确认文字（铁律 4），onDecision 一次都不该被叫到。
  feed(bridge, 'decision_pending', {
    decision_id: 'dec-x', level: 'extreme', tool: 'delete_file', target: '草稿.md',
    choices: ['confirm', 'deny'], confirmation_text: '确认删除 a1b2c3',
  });
  assert.deepEqual(seen, ['dec-w'], '极端确认不进选择器');
  assert.ok(stdout.text().includes('确认删除 a1b2c3'), '极端确认照旧展示原文');
});

test('事件桥：没有交互入口（非 TTY / 管道）时退回文字提示，卡片自己说清怎么答', () => {
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'decision_pending', {
    decision_id: 'dec-w', level: 'write', tool: 'write_file', target: '第一章.md',
    choices: ['once', 'input', 'deny'], confirmation_text: null,
  });
  assert.ok(stdout.text().includes('回复「一次允许」「本条输入允许同类操作」或「拒绝」'));
});

test('事件桥：交互入口自己抛错也不会变成未处理拒绝', async () => {
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({
    renderer,
    onDecision: async () => { throw new Error('终端已关闭'); },
  });

  feed(bridge, 'decision_pending', {
    decision_id: 'd', level: 'write', tool: 'write_file', target: 'x',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(stdout.text().includes('确认失败'), '兜底把故障收敛成一条事实');
});

test('事件桥：事件存储包装器把真实落盘的事件转发给渲染器', async () => {
  const appDataRoot = await makeTempRoot('wwriting-ev-');
  const sessionDir = path.join(appDataRoot, 's-1');
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  const factory = bridge.wrapEventStoreFactory((options) => createEventStore(options));
  const store = factory({ sessionDir });

  await store.append({ type: 'session_created', session_id: 's-1', data: { title: '第一章' } });
  await store.append({ type: 'run_started', data: { input_id: 'i-1', text: '写第一章' } });
  await store.appendBatch([
    { type: 'model_delta', data: { text: '第一章' } },
    { type: 'model_delta', data: { text: '开始。' } },
  ]);
  await store.append({ type: 'run_completed', data: { text: '第一章开始。' } });
  const text = stdout.text();
  assert.ok(text.includes('思考中'));
  assert.ok(text.includes('第一章开始。'));
  assert.ok(stdout.text().endsWith('已完成\n'));

  // 包装器必须原样保留事件存储的其它能力（不改上游模块）。
  const { events } = await store.readAll();
  assert.equal(events.length, 5);
  const projection = await store.currentProjection();
  assert.equal(projection.status, 'idle');
});

test('集成：真实 run controller 的正文与终态流进终端（模型客户端是脚本化假实现）', async () => {
  const appDataRoot = await makeTempRoot('wwriting-app-');
  const projectRoot = await makeTempRoot('wwriting-proj-');
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  const workspaceStore = createWorkspaceStore({ appDataRoot });
  const sessionManager = createSessionManager({
    workspaceStore,
    eventStoreFactory: bridge.wrapEventStoreFactory((options) => createEventStore(options)),
  });
  const modelClient = {
    async streamChat({ onDelta }) {
      onDelta('第一章');
      onDelta(' 长街灯火');
      onDelta('。');
    },
  };
  const controller = createRunController({ sessionManager, projectRoot, modelClient });

  await controller.open();
  const submitted = await controller.submit({ text: '写第一章' });
  await controller.close();
  const text = stdout.text();
  assert.equal(submitted.result.status, 'completed');
  assert.ok(text.includes('第一章 长街灯火。'), '可见正文逐 delta 落进渲染器');
  assert.ok(text.includes('已完成'));
  assertNoColor(text);
});

test('事件桥：模型未配置写成「未配置」这条事实，不是红色故障', () => {
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'run_failed', {
    code: 'MODEL_NOT_CONFIGURED',
    message: '尚未设置模型，请用 /model <模型名> 设置。',
  });
  renderer.close();

  const text = stdout.text();
  assert.ok(text.includes('未配置'), '短状态就是「未配置」');
  assert.ok(text.includes('尚未设置模型'), '详情说清下一步怎么做');
  assert.ok(!text.includes('操作失败'), '未配置不是故障');
  assert.ok(!text.includes('MODEL_NOT_CONFIGURED'), '错误码不进主文案');
  assert.ok(!text.includes('\x1b[31m'), '不用红色（NO_COLOR 下也没有颜色码）');
});

test('事件桥：其它 Run 失败仍然是「操作失败」', () => {
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'run_failed', { code: 'MODEL_HTTP_ERROR', message: 'DeepSeek 服务暂时不可用，请稍后重试。' });
  renderer.close();

  const text = stdout.text();
  assert.ok(text.includes('操作失败'));
  assert.ok(text.includes('DeepSeek 服务暂时不可用'));
});

// —— 活动行的「得到了什么」与终态的量 ——

test('工具行：成功时说出得到了什么；慢到值得说才补耗时', () => {
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  // 统计字数：那个数字是决定接着写还是收尾的依据（铁律 6），用户也必须在同一行看到。
  feed(bridge, 'activity_started', { tool: 'count_text', target: '第一章.md' }, { at: '2026-09-28T05:00:00.000Z' });
  feed(bridge, 'activity_finished',
    { tool: 'count_text', target: '第一章.md', ok: true, result: '{"charsNoSpace":3210}' },
    { at: '2026-09-28T05:00:00.400Z' });
  assert.ok(stdout.text().includes('✓ 统计字数 第一章.md · 3210 字'), '成功要说清结果');
  assert.ok(!stdout.text().includes('0 秒'), '毫秒级的耗时不报');

  // 慢工具：让人等了几秒，就值得说一句
  feed(bridge, 'activity_started', { tool: 'read_file', target: '大纲.md' }, { at: '2026-09-28T05:00:00.000Z' });
  feed(bridge, 'activity_finished',
    { tool: 'read_file', target: '大纲.md', ok: true, result: '{"path":"大纲.md","text":"a\\nb"}' },
    { at: '2026-09-28T05:00:05.000Z' });
  assert.ok(stdout.text().includes('✓ 读取文件 大纲.md · 2 行'), '行数也是「得到了什么」');
  assert.ok(stdout.text().includes('· 5 秒'), '超过 2 秒才报耗时');

  // 结果太大没带进事件：给个量级，比什么都不说强
  feed(bridge, 'activity_finished',
    { tool: 'read_file', target: '长文.md', ok: true, resultChars: 20480 },
    { at: '2026-09-28T05:00:05.000Z' });
  assert.ok(stdout.text().includes('约 20 KB'), '没带结果时说大小');

  renderer.close();
});

test('终态行带上本轮用量；连接类失败单独说「连接中断」', () => {
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'run_completed', { usage: { promptTokens: 800, completionTokens: 412, totalTokens: 1212 } });
  assert.ok(stdout.text().endsWith('已完成 · 1.2k tokens\n'), '用量跟在终态后面');

  feed(bridge, 'run_failed', { code: 'MODEL_NETWORK_ERROR', message: '连接不上 DeepSeek 服务，请检查网络后重试。' });
  const text = stdout.text();
  assert.ok(text.includes('连接中断：连接不上 DeepSeek 服务'), '连不上与「这一轮失败」是两回事');
  assert.ok(!text.includes('操作失败：连接不上'), '不该混成普通失败');

  // 没有 usage 的事件不该编一个 0 出来
  const bare = makeRenderer();
  const bareBridge = createEventRenderer({ renderer: bare.renderer });
  feed(bareBridge, 'run_completed', {});
  assert.ok(!bare.stdout.text().includes('tokens'), '拿不到用量就不显示');

  renderer.close();
});

// —— 终态行的客观数字 ——

test('run_completed 的终态行同时带上 tokens、思考量与缓存命中', () => {
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  createEventRenderer({ renderer }).handleEvent({
    type: 'run_completed', at: '2026-09-29T00:00:00.000Z',
    data: { text: '写好了。', usage: { totalTokens: 1200, reasoningTokens: 800, promptCacheHitTokens: 3400 } },
  });
  renderer.close();
  assert.equal(screenText(stdout.text()), '已完成 · 1.2k tokens（思考 800） · 缓存命中 3.4k');
});

test('没有缓存命中时终态行不出现「缓存」二字', () => {
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  createEventRenderer({ renderer }).handleEvent({
    type: 'run_completed', at: '2026-09-29T00:00:00.000Z',
    data: { text: '写好了。', usage: { totalTokens: 1200 } },
  });
  renderer.close();
  assert.equal(screenText(stdout.text()), '已完成 · 1.2k tokens');
});

test('未配置 / 操作失败这类终态都以新行收尾（框线交给输入区）', () => {
  for (const data of [
    { code: 'MODEL_NOT_CONFIGURED', message: '尚未配置 DeepSeek API Key，输入 /model 跟着走一遍就好。' },
    { code: 'MODEL_HTTP_ERROR', message: 'DeepSeek 服务暂时不可用，请稍后重试。' },
  ]) {
    const { renderer, stdout } = makeRenderer();
    const bridge = createEventRenderer({ renderer });
    feed(bridge, 'run_failed', data);
    assert.ok(stdout.text().endsWith('\n'), '终态以换行收尾');
    assert.equal(stdout.text().includes('─'), false, '渲染器不画线');
    renderer.close();
  }
});

test('排过队的输入真正开跑时补一行用户行，当场敲的那条不重复', () => {
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  // 当场敲的那条：readline 已经回显过，run_started 不该再补一行
  feed(bridge, 'run_started', { input_id: 'i-live', text: '写第一章' });
  assert.ok(!stdout.text().includes('❯ 写第一章'), '当场敲的那条不重复');
  feed(bridge, 'run_completed', {});

  // 排队的那条：跑到它的时候要让人看得出「现在这条是它」
  feed(bridge, 'input_queued', { input_id: 'i-2', text: '写第二章' });
  assert.ok(stdout.text().includes('写第二章   排队'), '先有一条排队记录');
  feed(bridge, 'run_started', { input_id: 'i-2', text: '写第二章' });
  assert.ok(stdout.text().includes('❯ 写第二章'), '轮到它时补一行用户行');

  // 再开一轮同一条（不可能，但要证明补过就不会再补）
  feed(bridge, 'run_started', { input_id: 'i-2', text: '写第二章' });
  assert.equal(stdout.text().match(/❯ 写第二章/g).length, 1, '只补一次');

  // 撤回的排队输入不该以后误补
  feed(bridge, 'input_queued', { input_id: 'i-3', text: '写第三章' });
  feed(bridge, 'input_withdrawn', { input_id: 'i-3' });
  feed(bridge, 'run_started', { input_id: 'i-3', text: '写第三章' });
  assert.equal(stdout.text().match(/❯ 写第三章/g), null, '撤回过的不会再补');

  // 但「撤销」这件事必须在屏幕上有个交代：否则先前那行 `排队` 会永远挂着，
  // 用户以为它还在等，实际已经被丢掉了（无声丢数据）。
  assert.ok(stdout.text().includes('排队已取消'), '撤回应给出可见交代');

  renderer.close();
});

// —— 历史回放：只在真的省略了东西时才占一行 ——

test('省略了更早轮次时画出一行事实，未省略时不占屏幕', () => {
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  // 未省略：正常运转不需要每一轮都念一遍，屏幕上不该多出噪音。
  feed(bridge, 'run_started', { input_id: 'i-1', text: '写第一章' });
  feed(bridge, 'history_applied', { kept_turns: 2, truncated_turns: 0, chars: 800 });
  assert.ok(!stdout.text().includes('已载入前情'), '没省略就不占一行');

  // 省略了：用户必须知道模型少了多少前情（否则会以为它「记得但装傻」）。
  feed(bridge, 'run_started', { input_id: 'i-2', text: '写第二章' });
  feed(bridge, 'history_applied', { kept_turns: 6, truncated_turns: 4, chars: 24000 });
  const screen = screenText(stdout.text(), { cols: 100, rows: 40 });
  assert.ok(screen.includes('已载入前情'), '省略时画出一行');
  assert.ok(screen.includes('6 轮'), '说清保留了多少轮');
  assert.ok(screen.includes('省略更早 4 轮'), '说清省略了多少轮');

  renderer.close();
});

test('历史事实行不破坏输入框（让位与画回严格成对，收尾时框还在）', () => {
  const composer = makeFakeComposer();
  const { renderer, stdout } = makeRenderer({ tty: true, composer });
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'run_started', { input_id: 'i-1', text: '写' });
  feed(bridge, 'history_applied', { kept_turns: 1, truncated_turns: 9, chars: 24000 });
  feed(bridge, 'run_completed', {});

  const screen = screenText(stdout.text(), { cols: 100, rows: 40 });
  assert.ok(screen.includes('已载入前情'), '事实行在画面上');
  // 输入框归输入层所有：渲染器必须「让位 → 写 scrollback → 要回」，且收尾时框一定在屏幕上。
  assert.deepEqual(composer.violations, [], '让位与画回必须严格成对');
  assert.ok(composer.calls.includes('takeArea'), '写之前让位过');
  assert.equal(composer.calls.at(-1), 'giveArea', '收尾时输入框必须已画回');
  assert.equal(stdout.stray.length, 0, '渲染器绝不在 composer 占着光标行时直写');

  renderer.close();
});

// —— 排队输入开跑：把「排队」换成正常用户行 ——

test('input_started 把排队行换成用户行，run_started 不再重复补', () => {
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'input_queued', { input_id: 'i-9', text: '写第三章' });
  assert.ok(stdout.text().includes('写第三章   排队'), '先有排队记录');

  // 轮到它了：开跑标记把那一行变成有主的用户行。
  feed(bridge, 'input_started', { input_id: 'i-9', text: '写第三章' });
  assert.ok(stdout.text().includes('❯ 写第三章'), '换成用户行');

  // 紧接着的 run_started 不该再补第二行（屏幕上只该出现一次）。
  feed(bridge, 'run_started', { input_id: 'i-9', text: '写第三章' });
  assert.equal(stdout.text().match(/❯ 写第三章/g).length, 1, '只出现一次');

  renderer.close();
});

test('input_started 对当场敲的输入不发用户行（readline 已经回显过）', () => {
  const { renderer, stdout } = makeRenderer();
  const bridge = createEventRenderer({ renderer });

  // 没排过队、也带 text：这属于「不该画」的情形，交给 readline 负责。
  feed(bridge, 'input_started', { input_id: 'i-live', text: null });
  assert.ok(!stdout.text().includes('❯'), '没有原文就不画用户行');

  renderer.close();
});

// —— 项目记忆：Q13 注入的消息完全不画，截断时例外 ——

function memoryScreen(data) {
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  createEventRenderer({ renderer }).handleEvent({
    type: 'memory_applied', at: '2026-09-29T00:00:00.000Z', data,
  });
  renderer.close();
  return screenText(stdout.text());
}

test('正常载入记忆时屏幕上一个字节都不写（Q13）', () => {
  assert.equal(memoryScreen({ state: 'present', chars: 42, omitted_chars: 0, cached: false }), '');
});

test('命中缓存时同样不占行：正常运转的事不需要每轮汇报（铁律 3）', () => {
  assert.equal(memoryScreen({ state: 'present', chars: 42, omitted_chars: 0, cached: true }), '');
});

test('缺失也不占行：那是常态，启动面板的「记忆」一行已经说过（D6）', () => {
  assert.equal(memoryScreen({ state: 'missing', chars: 60, omitted_chars: 0, cached: false }), '');
});

test('截断时如实说一句，数字进 detail（D2③，与历史截断同构）', () => {
  // 主文案 5 字（铁律 3 的 2–6 字）。草案 D2③ 给的是「已载入项目记忆」= 7 字，
  // 它自称「守住 2–6 字」但自己算错了——它引的同构对象「已载入前情」是 5 字（R7）。
  assert.equal(
    memoryScreen({ state: 'present', chars: 8000, omitted_chars: 3200, cached: false }),
    '已载入记忆：过长 · 已省略 3200 字符',
  );
});

test('读不出来时给一条降级事实，与「缺失」区分开（D4③ / R2）', () => {
  assert.equal(
    memoryScreen({ state: 'unreadable', chars: 0, omitted_chars: 0, cached: false }),
    '记忆未载入：本轮按无记忆继续',
  );
});

function reasoningScreen(event) {
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  createEventRenderer({ renderer }).handleEvent(event);
  renderer.close();
  return screenText(stdout.text());
}

test('reasoning_completed 落一行终态「思考 N 秒」，N 从事件时间戳差算（P20）', () => {
  assert.equal(reasoningScreen({
    type: 'reasoning_completed',
    at: '2026-09-29T00:00:12.000Z',
    data: { text: '想了一会儿', started_at: '2026-09-29T00:00:00.000Z', chars: 5 },
  }), '思考 12 秒');
});

test('没有 started_at 时回退「已完成思考」（grokbuild 防 0ms 的同一条判断）', () => {
  assert.equal(reasoningScreen({
    type: 'reasoning_completed', at: '2026-09-29T00:00:12.000Z',
    data: { text: '想了一会儿', started_at: null, chars: 5 },
  }), '已完成思考');
});

test('思考行是终态行，不是会被重绘抹掉的动态行', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  const bridge = createEventRenderer({ renderer });
  bridge.handleEvent({ type: 'run_started', at: '2026-09-29T00:00:00.000Z', data: { text: 'hi' } });
  bridge.handleEvent({
    type: 'reasoning_completed', at: '2026-09-29T00:00:05.000Z',
    data: { text: '想', started_at: '2026-09-29T00:00:00.000Z', chars: 1 },
  });
  renderer.close();
  // 动态行「思考中」被抹掉，终态行留在 scrollback。
  assert.ok(screenText(stdout.text()).includes('思考 5 秒'));
});

test('思考正文不经事件桥进 scrollback：reasoning_completed 只留一行「思考 N 秒」', () => {
  // 思考内容可见的**唯一**入口是 printThinkingPreview（贴在实时区、随下一件事消失）。
  // 落进滚动区的只有这一行结论——max 档几万字符若跟着滚进去，正文整段都会被冲走（ADR-0012）。
  const shown = reasoningScreen({
    type: 'reasoning_completed', at: '2026-09-29T00:00:12.000Z',
    data: { text: '主角其实早就死了，这是伏笔', started_at: '2026-09-29T00:00:00.000Z', chars: 13 },
  });
  assert.equal(shown.includes('主角其实早就死了'), false);
  assert.equal(shown, '思考 12 秒');
});

test('lastReasoning 给出上一次跑完的那一轮的思考全文与耗时', () => {
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  const bridge = createEventRenderer({ renderer });
  assert.equal(bridge.lastReasoning(), null, '还没跑过任何一轮');
  bridge.handleEvent({ type: 'run_started', at: '2026-09-29T00:00:00.000Z', data: { text: 'hi' } });
  assert.equal(bridge.lastReasoning(), null, '正在跑的这一轮还不算「上一轮」');
  bridge.handleEvent({
    type: 'reasoning_completed', at: '2026-09-29T00:00:05.000Z',
    data: { text: '第一段思考', started_at: '2026-09-29T00:00:00.000Z', chars: 5 },
  });
  bridge.handleEvent({
    type: 'reasoning_completed', at: '2026-09-29T00:00:09.000Z',
    data: { text: '第二段思考', started_at: '2026-09-29T00:00:06.000Z', chars: 5 },
  });
  // 这一轮还没结束：即便已经攒了半截思考，它也不算「上一轮」，不返回给 /reasoning
  // （契约见 renderer.mjs lastReasoning 处的注释）。
  assert.equal(bridge.lastReasoning(), null, '在跑的这一轮的半截思考不返回');
  bridge.handleEvent({ type: 'run_completed', at: '2026-09-29T00:00:10.000Z', data: { text: '好了。' } });
  assert.deepEqual(bridge.lastReasoning(), [
    { text: '第一段思考', durationMs: 5000 },
    { text: '第二段思考', durationMs: 3000 },
  ]);
});

test('新一轮开始后 lastReasoning 换成新一轮的，旧的不再可见', () => {
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  const bridge = createEventRenderer({ renderer });
  bridge.handleEvent({ type: 'run_started', at: '2026-09-29T00:00:00.000Z', data: { text: 'a' } });
  bridge.handleEvent({
    type: 'reasoning_completed', at: '2026-09-29T00:00:05.000Z',
    data: { text: '旧思考', started_at: '2026-09-29T00:00:00.000Z', chars: 3 },
  });
  bridge.handleEvent({ type: 'run_completed', at: '2026-09-29T00:00:06.000Z', data: { text: '' } });
  bridge.handleEvent({ type: 'run_started', at: '2026-09-29T00:01:00.000Z', data: { text: 'b' } });
  bridge.handleEvent({
    type: 'reasoning_completed', at: '2026-09-29T00:01:02.000Z',
    data: { text: '新思考', started_at: '2026-09-29T00:01:00.000Z', chars: 3 },
  });
  bridge.handleEvent({ type: 'run_completed', at: '2026-09-29T00:01:03.000Z', data: { text: '' } });
  assert.deepEqual(bridge.lastReasoning(), [{ text: '新思考', durationMs: 2000 }]);
});

test('这一轮没有思考时 lastReasoning 是 null（不是空数组）', () => {
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  const bridge = createEventRenderer({ renderer });
  bridge.handleEvent({ type: 'run_started', at: '2026-09-29T00:00:00.000Z', data: { text: 'a' } });
  bridge.handleEvent({ type: 'run_completed', at: '2026-09-29T00:00:01.000Z', data: { text: '好。' } });
  assert.equal(bridge.lastReasoning(), null);
});

test('上一轮没思考时不得重放更早那一轮的思考（猎捕报告 9）', () => {
  // 跑 1 有思考 → /effort none → 跑 2 无思考 → /reasoning：回退到跑 1 的思考
  // 会让用户把它当成刚才那份回答的推理——正是比不回答更糟的假事实。
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  const bridge = createEventRenderer({ renderer });

  bridge.handleEvent({ type: 'run_started', at: '2026-09-29T00:00:00.000Z', data: { text: 'a' } });
  bridge.handleEvent({
    type: 'reasoning_completed', at: '2026-09-29T00:00:05.000Z',
    data: { text: '第一轮的思考', started_at: '2026-09-29T00:00:00.000Z', chars: 6 },
  });
  bridge.handleEvent({ type: 'run_completed', at: '2026-09-29T00:00:06.000Z', data: { text: '一。' } });
  assert.deepEqual(bridge.lastReasoning(), [{ text: '第一轮的思考', durationMs: 5000 }]);

  // 第二轮：没有任何思考行
  bridge.handleEvent({ type: 'run_started', at: '2026-09-29T00:01:00.000Z', data: { text: 'b' } });
  bridge.handleEvent({ type: 'run_completed', at: '2026-09-29T00:01:05.000Z', data: { text: '二。' } });
  assert.equal(bridge.lastReasoning(), null, '上一轮没思考就答没有，不回退到更早那一轮');
});

test('重构后事件桥的三条终态行文案逐字未变（回归护栏）', () => {
  const cases = [
    [{ type: 'run_completed', data: { text: '好。' } }, '已完成'],
    [{ type: 'run_interrupted', data: { reason: 'user_stop' } }, '已停止'],
    [{ type: 'run_interrupted', data: { reason: 'aborted' } }, '已中断'],
    [{ type: 'run_failed', data: { code: 'MODEL_NETWORK_ERROR', message: '无法连接 DeepSeek 服务，请检查网络后重试。' } },
      '连接中断：无法连接 DeepSeek 服务，请检查网络后重试。'],
    [{ type: 'run_failed', data: { code: 'MODEL_NOT_CONFIGURED' } }, '未配置：用 /model 设置模型与 API Key 后重试。'],
  ];
  for (const [event, expected] of cases) {
    const stdout = makeStdout({ tty: false });
    const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
    createEventRenderer({ renderer }).handleEvent({ ...event, at: '2026-09-29T00:00:00.000Z' });
    renderer.close();
    assert.equal(screenText(stdout.text()), expected, `${event.type} / ${JSON.stringify(event.data)}`);
  }
});

test('事件桥：plan_updated 把整表交给 printPlan 画出来', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  const bridge = createEventRenderer({ renderer });
  bridge.handleEvent({
    type: 'plan_updated', at: '2026-10-01T00:00:00.000Z',
    data: { items: [{ summary: '写第四章', status: 'in_progress' }] },
  });
  renderer.close();
  assert.ok(screenText(stdout.text()).includes('任务计划 0/1'));
  assert.ok(screenText(stdout.text()).includes('▶ 写第四章'));
});

test('事件桥：渲染器缺能力在装配期炸出来并列出缺什么（不静默降级）', () => {
  const minimal = { printStatus: () => {}, printUser: () => {}, printActivity: () => {} };
  assert.throws(
    () => createEventRenderer({ renderer: minimal }),
    /缺少能力.*printPlan.*setLivePlan/,
    '契约缺失必须在装配点暴露',
  );
  // 残缺替身要显式声明 partial——「我知道我给的是残缺渲染器」；喂到的事件它自己得接得住。
  const usable = { ...minimal, printPlan: () => {}, setLivePlan: () => {}, resetThinkingPreview: () => {} };
  const bridge = createEventRenderer({ renderer: usable, partial: true });
  bridge.handleEvent({ type: 'plan_updated', at: '2026-10-01T00:00:00.000Z', data: { items: [{ summary: 'x' }] } });
});

test('事件桥 resetSessionState：切会话后旧计划的终态事件不再回流实时区', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, env: { NO_COLOR: '1' }, composer });
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'run_started', { input_id: 'i-1', text: 'A 会话的任务' });
  feed(bridge, 'plan_updated', { items: [{ summary: 'A 的步骤', status: 'in_progress' }] });
  feed(bridge, 'run_completed', {});
  assert.ok(composer.live.includes('A 的步骤'), 'A 的 chip 在');

  // 组合根切会话：清桥内状态 → 播种新会话（无计划）。
  bridge.resetSessionState();
  renderer.setLivePlan(null);
  assert.equal(composer.live, null, 'B 会话没有计划，实时区干净');

  // A 会话停止旧轮产生的迟到终态（run_interrupted 在 close 之后才到）：不得把 A 的计划挂回来。
  feed(bridge, 'run_interrupted', { reason: 'stopped' });
  assert.equal(composer.live, null, `旧计划不得回流：${composer.live}`);
  renderer.close();
});

test('history_applied 带会话压缩事实：摘要覆盖与省略各说各的', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  const bridge = createEventRenderer({ renderer });
  bridge.handleEvent({
    type: 'history_applied', at: '2026-10-01T00:00:00.000Z',
    data: { kept_turns: 2, truncated_turns: 0, chars: 500, digest_chars: 120, covered_turns: 4 },
  });
  renderer.close();
  const detail = screenText(stdout.text());
  assert.ok(detail.includes('已载入前情'), '有摘要就要说，哪怕没省略轮次');
  assert.ok(detail.includes('2 轮'));
  assert.ok(detail.includes('摘要覆盖 4 轮'));
  assert.ok(detail.includes('含会话摘要'));
});

test('history_applied 无摘要不提摘要（老文案逐字不变）', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  const bridge = createEventRenderer({ renderer });
  bridge.handleEvent({
    type: 'history_applied', at: '2026-10-01T00:00:00.000Z',
    data: { kept_turns: 1, truncated_turns: 1, chars: 500 },
  });
  renderer.close();
  const shown = screenText(stdout.text());
  assert.ok(shown.includes('1 轮 · 省略更早 1 轮'));
  assert.equal(shown.includes('摘要'), false);
});

// —— 排队行进实时区：装配缝上的契约（渲染器的画法在 renderer.test.mjs） ——

test('排队全生命周期（composer）：排队行只在实时区，开跑换成用户行，滚动历史零残影', () => {
  const composer = makeFakeComposer();
  const { renderer, stdout } = makeRenderer({ tty: true, env: { NO_COLOR: '1' }, composer });
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'run_started', { input_id: 'i-1', text: '写第一章' });
  feed(bridge, 'input_queued', { input_id: 'i-2', text: '写第二章' });
  assert.ok(composer.live.includes('写第二章   排队'), '排队行挂在实时区');
  assert.equal(stdout.text().includes('排队'), false, '滚动历史里没有排队残影');

  // 轮到它：实时区那一行消失，滚动历史出现一条用户行——同一原文只有一份记录。
  feed(bridge, 'input_started', { input_id: 'i-2', text: '写第二章' });
  assert.equal(composer.live, null, '实时区的排队行随开跑消失');
  assert.equal(stdout.text().match(/写第二章/g).length, 1, '只在用户行里出现一次');

  // 补一条并撤回：实时区消失，「排队已取消」终态事实保留。
  feed(bridge, 'input_queued', { input_id: 'i-3', text: '写第三章' });
  assert.ok(composer.live.includes('写第三章   排队'));
  feed(bridge, 'input_withdrawn', { input_id: 'i-3' });
  assert.equal(composer.live, null, '撤回后实时区不再挂着它');
  const text = stdout.text();
  assert.ok(text.includes('排队已取消'), '撤回应给出可见交代');

  renderer.close();
});

test('排队行与未收尾的动态行共存：dispatcher 不互相覆盖', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, env: { NO_COLOR: '1' }, composer });
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'run_started', { input_id: 'i-1', text: '写第一章' });
  feed(bridge, 'input_queued', { input_id: 'i-2', text: '排队的那条' });
  const live = composer.live;
  assert.ok(live.includes('思考中'), '动态行仍在');
  assert.ok(live.includes('排队的那条   排队'), '排队行在');
  assert.ok(live.indexOf('思考中') < live.indexOf('排队的那条'), '动态行在上、排队行在下');

  renderer.close();
});

test('history_applied 的诚实计数：窗口截断给「N+」，旧摘要只说覆盖不报数（规格 2026-10-06 D4）', () => {
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  const bridge = createEventRenderer({ renderer });

  // 有界读被字节上限截断：省略数只知下界 → 「N+ 轮」，不冒充精确值。
  feed(bridge, 'run_started', { input_id: 'i-1', text: '写第一章' });
  feed(bridge, 'history_applied', { kept_turns: 6, truncated_turns: 4, truncated_exact: false, chars: 24000 });
  let screen = screenText(stdout.text(), { cols: 100, rows: 40 });
  assert.ok(screen.includes('省略更早 4+ 轮'), '截断窗口只知下界，说「N+」');

  // 旧摘要事件没有 covered_total：只说覆盖了，不编数字。
  feed(bridge, 'run_started', { input_id: 'i-2', text: '写第二章' });
  feed(bridge, 'history_applied', {
    kept_turns: 1, truncated_turns: 0, chars: 300,
    digest_chars: 500, covered_turns: 0, covered_exact: false,
  });
  screen = screenText(stdout.text(), { cols: 100, rows: 40 });
  assert.ok(screen.includes('摘要覆盖更早前情'), '不冒充精确覆盖数');
  assert.ok(!screen.includes('摘要覆盖 0 轮'));

  // 缺省（旧事件无新字段）视为精确——旧行为逐字不变。
  feed(bridge, 'run_started', { input_id: 'i-3', text: '写第三章' });
  feed(bridge, 'history_applied', { kept_turns: 2, truncated_turns: 3, chars: 24000 });
  screen = screenText(stdout.text(), { cols: 100, rows: 40 });
  assert.ok(screen.includes('省略更早 3 轮'));

  renderer.close();
});
