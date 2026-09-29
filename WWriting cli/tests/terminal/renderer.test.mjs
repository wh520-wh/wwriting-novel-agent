// Inline 渲染器测试：用户行 / 正文 / 活动行 / 状态行 / 排队行 / 确认提示都进 scrollback；
// 当前动态状态用 \r 重绘（有颜色时 \r\x1b[K），Run 结束换行留下终态；
// 流式正文按节流批次写；NO_COLOR 时一个 ANSI 字节都不输出。
// 最后一组用真实的 run controller + 真实事件存储验证事件桥（只有模型客户端是脚本化的假实现）。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEventRenderer, createRenderer, displayWidth, formatCacheHit, formatThinkingSeconds, formatUsage, padDisplayEnd, PROSE_INDENT, proseRowWidth, terminalStatusText, thinkingPreviewLines, thinkingPreviewWidth, userRows } from '../../src/terminal/renderer.mjs';
import { screenText } from '../helpers/screen.mjs';
import { VERSION, versionLine } from '../../src/version.mjs';
import { createRunController } from '../../src/agent/run-controller.mjs';
import { createSessionManager } from '../../src/session/session-manager.mjs';
import { createEventStore } from '../../src/session/event-store.mjs';
import { createWorkspaceStore } from '../../src/storage/workspace-store.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// 内存 stdout：只收字符串，便于断言「屏幕上出现了什么」。
// guard 用来捕捉「composer 还占着光标行时渲染器直接写 stdout」——那正是会擦掉用户已键入内容的动作。
// columns 默认 undefined 而不是 80：既有渲染器测试全都跑在 undefined 上（proseRowWidth 兜到 77），
// 给个默认值会悄悄改掉它们的折行位置。要断折行的用例自己传。
function makeStdout({ tty = false, guard = null, columns = undefined } = {}) {
  const chunks = [];
  const stray = [];
  return {
    isTTY: tty,
    columns,
    chunks,
    stray,
    write(text) {
      if (guard && guard()) stray.push(String(text));
      chunks.push(String(text));
      return true;
    },
    text() { return chunks.join(''); },
  };
}

// 颜色码（SGR）。NO_COLOR 只管颜色；抹行/上下移用的光标控制码不属于颜色，照常输出。
const COLOR_CODE = /\x1b\[[0-9;]*m/;

function assertNoColor(text) {
  assert.equal(COLOR_CODE.test(text), false, `NO_COLOR 下不该出现颜色码：${JSON.stringify(text)}`);
}

// 假 composer：模拟输入层那块输入区（上框线 / 提示符 / 下框线，可能还有一行实时状态）。
// occupied 表示「输入区正显示在屏幕上」；渲染器每次写出之前必须先 takeArea 把它擦掉，
// 写完再 giveArea 画回来。动态行走 setLive——它贴在框的上方，仍在输入区里，不需要让位。
function makeFakeComposer(line = '') {
  const state = { occupied: true, calls: [], violations: [] };
  let live = null;
  return {
    line,
    get occupied() { return state.occupied; },
    get calls() { return state.calls; },
    get violations() { return state.violations; },
    get live() { return live; },
    isActive: () => true,
    takeArea() {
      if (!state.occupied) state.violations.push('让位时输入区已经不在屏幕上');
      state.occupied = false;
      // 输入区整块被擦掉，贴在它上方那一行实时状态也跟着没了（真实实现同样如此）。
      live = null;
      state.calls.push('takeArea');
    },
    giveArea() {
      if (state.occupied) state.violations.push('画回时输入区已经在屏幕上');
      state.occupied = true;
      state.calls.push('giveArea');
    },
    setLive(text) {
      live = text ?? null;
      state.calls.push(`setLive:${live ?? 'null'}`);
    },
  };
}

// 可控定时器：流式节流依赖它，测试要能确定性地说「时间到了」。

function makeRenderer({ tty = false, color, env = {}, composer = null, columns = undefined } = {}) {
  const guard = composer
    ? () => composer.isActive() && composer.occupied
    : null;
  const stdout = makeStdout({ tty, guard, columns });
  const renderer = createRenderer({ stdout, color, env, composer });
  return { renderer, stdout };
}

// —— 静态输出进 scrollback ——

test('头部面板：标识、事实网格与提示一次落进 scrollback，列按显示宽度对齐', () => {
  const { renderer, stdout } = makeRenderer();

  renderer.printIntro({
    title: versionLine(),
    subtitle: '长篇写作智能体（命令行版）',
    rows: [['工作区', 'D:\\Novels\\星坠之城'], ['模型', 'deepseek-chat']],
    hint: '直接输入开始写作 · /help 查看命令',
  });
  renderer.close();

  const text = stdout.text();
  const lines = text.split('\n');
  assert.ok(text.includes(`WWriting ${VERSION}`), '面板标题是名称 + 版本');
  assert.ok(text.includes('长篇写作智能体'), '面板有一句说明这是什么');
  assert.ok(text.includes('D:\\Novels\\星坠之城'), '面板列出工作区');
  assert.ok(text.includes('deepseek-chat'), '面板列出当前模型');
  assert.ok(text.includes('/help 查看命令'), '面板给一句第一屏怎么用');
  assert.ok(text.includes('─'), '面板用横线分出段落');
  assert.ok(text.endsWith('\n'), '面板要换行收尾，不能和后面的输出挤在一行');
  assertNoColor(text);

  // 标签是 CJK（占 2 列），「工作区」比「模型」宽 2 列：值必须都从同一列开始，
  // 否则面板就是一个歪的表格。这条断言是 displayWidth / padDisplayEnd 存在的理由。
  const valueColumn = (value) => {
    const line = lines.find((item) => item.includes(value));
    return displayWidth(line.slice(0, line.indexOf(value)));
  };
  assert.equal(valueColumn('deepseek-chat'), valueColumn('D:\\Novels\\星坠之城'), '两行的值从同一显示列开始');

  // 有颜色时也一样只是静态几行，不参与动态行重绘（重绘会把光标移回上一行）。
  const colored = makeRenderer({ color: true });
  colored.renderer.printIntro({ title: versionLine(), rows: [['会话', 'sess_1']] });
  colored.renderer.close();
  const coloredText = colored.stdout.text();
  assert.ok(coloredText.includes(VERSION));
  assert.ok(!coloredText.includes('\x1b[A'), '面板不是动态行，不应产生光标上移');
});

test('渲染器不再自己画任何框线：那两条线归输入区（它才知道框有几行）', () => {
  const { renderer, stdout } = makeRenderer();

  renderer.printStatus('已完成', { final: true, tone: 'success' });
  const text = stdout.text();
  assert.ok(text.endsWith('已完成\n'), '终态行照常落进 scrollback，且到它就结束');
  assert.equal(text.includes('─'), false, '一条线都不该由渲染器写出来');
  assert.equal(typeof renderer.printInputRule, 'undefined', '那个接口已经撤掉');
});

test('用户行、正文、活动行、状态行、排队行、确认提示都进入 scrollback', () => {
  const { renderer, stdout } = makeRenderer();

  renderer.printUser('写第一章');
  renderer.printAssistant('第一章 长街灯火');
  renderer.printActivity({ state: 'done', label: '读取文件 大纲.md' });
  renderer.printQueue('把第二章也写了');
  renderer.printDecision({
    decision_id: 'dec-1',
    level: 'write',
    tool: 'write_file',
    target: '第一章.md',
    choices: ['once', 'input', 'deny'],
    confirmation_text: null,
  });
  renderer.printStatus('已完成', { final: true, tone: 'success' });
  renderer.close();

  const text = stdout.text();
  assert.ok(text.includes('写第一章'), '用户行');
  assert.ok(text.includes('第一章 长街灯火'), 'Agent 正文');
  assert.ok(text.includes('读取文件 大纲.md'), '活动行');
  assert.ok(text.includes('把第二章也写了'), '排队行原文');
  assert.ok(text.includes('排队'), '排队徽标');
  assert.ok(text.includes('第一章.md'), '确认提示');
  assert.ok(text.includes('回复「一次允许」「本条输入允许同类操作」或「拒绝」'), '没有选择器时，卡片负责说清怎么用文字答');
  assert.ok(text.includes('已完成'), '终态状态行');
  assertNoColor(text);
});

test('正文按「完整行」落盘：不足一行不写，遇到换行或攒满一行才写', () => {
  const { renderer, stdout } = makeRenderer();

  renderer.printUser('写第一章');
  renderer.printAssistant('第一');
  renderer.printAssistant('章');
  renderer.printAssistant('开始');
  assert.equal(stdout.chunks.length, 1, '半行先攒着：绝不为了早点显示而在句子中间断行');
  assert.ok(!stdout.text().includes('第一章开始'), '还没到一行，屏幕上不该出现');

  // 真实换行到齐 → 这一行立刻落盘（不必等攒满宽度）
  renderer.printAssistant('。\n');
  const text = stdout.text();
  assert.ok(text.includes('❯ 写第一章\n'), '用户行带提示符标记且独占一行');
  assert.ok(text.includes('▌ 第一章开始。\n'), '整行落盘，段首带模型标记、正文落在内容列（与头部面板的横线对齐）');

  // 没有换行也不会一直攒着：攒满一整行（按终端宽度算）就写出去，切点与终端自然折行一致
  const long = '字'.repeat(200);
  renderer.printAssistant(long);
  const rows = stdout.text().split('\n').filter((line) => line.includes('字'));
  assert.ok(rows.length >= 4, `长段落按行宽切开落盘（实际 ${rows.length} 行）`);
  assert.ok(rows[0].length <= 60, '每行都不超过行宽');

  renderer.close();
  assert.ok(stdout.text().endsWith('\n'), '收尾把最后那半行也吐出去');
});

test('正文落盘只看「有没有整行」：不足一行不写，换行一到立刻写', () => {
  const { renderer, stdout } = makeRenderer();

  // 64 个半角字符不到一行（默认行宽 77），所以一个字节都不写——
  // 不再像旧实现那样「按 64 字一批切开」，那正是段落中间凭空断行的原因。
  renderer.printAssistant('a'.repeat(64));
  assert.equal(stdout.chunks.length, 0, '不足一行就先攒着');

  renderer.printAssistant('换行\n');
  assert.equal(stdout.chunks.length, 1, '整行一次写出，不是一片一次');
  assert.ok(stdout.text().endsWith('a'.repeat(64) + '换行\n'));
});

test('普通确认卡：文字模式只列词不列数字，选择器模式只留「需要确认」一行', () => {
  // 文字模式（非 TTY / 管道 / 测试替身）：用户只能在同一个输入框里用文字答，
  // 卡片必须给一行提示——但**只能列词不能列数字**（铁律 11：数字直选是不宣传的隐藏别名）。
  const typed = makeRenderer();
  typed.renderer.printDecision({ decision_id: 'd1', level: 'write', tool: 'write_file', target: '第一章.md' });
  const typedText = typed.stdout.text();
  assert.ok(typedText.includes('需要确认：写入文件 第一章.md'));
  // 文字模式下这一行提示是唯一的发现面：三个选项的词都要在，否则中间那档彻底隐形。
  assert.ok(typedText.includes('回复「一次允许」「本条输入允许同类操作」或「拒绝」'), '要说清怎么用文字答，且三个选项都列全');
  assert.equal(/[0-9]/.test(typedText), false, `卡片里不得出现「回复 1/2/3」这类数字答法：${typedText}`);

  // 选择器模式：三个选项与按键提示由选择器自己显示，卡片不再多印一行。
  const picked = makeRenderer();
  picked.renderer.printDecision(
    { decision_id: 'd1', level: 'write', tool: 'write_file', target: '第一章.md' },
    { picker: true },
  );
  const pickedText = picked.stdout.text();
  assert.ok(pickedText.includes('需要确认：写入文件 第一章.md'));
  assert.equal(pickedText.includes('回复'), false, '选择器自己会显示选项，卡片不该再教一遍怎么答');
  assert.equal(/[0-9]/.test(pickedText), false);
});

test('极端确认卡原样不动：原文与拒绝出口都在，选择器模式也不改它', () => {
  const { renderer, stdout } = makeRenderer();

  // 极端确认是有意为之的抄写关卡（铁律 4），不是选择题：两种模式下卡片必须逐字一致。
  const extreme = {
    decision_id: 'd2',
    level: 'extreme',
    tool: 'delete_file',
    target: '草稿.md',
    confirmation_text: '确认删除 a1b2c3',
  };
  renderer.printDecision(extreme);
  const typed = stdout.text();
  const second = makeRenderer();
  second.renderer.printDecision(extreme, { picker: true });
  assert.equal(second.stdout.text(), typed, '极端确认的卡片不随选择器模式改变一个字节');
  assert.ok(typed.includes('删除文件 草稿.md'), '极端操作也要说人话');
  assert.ok(typed.includes('确认删除 a1b2c3'), '必须给出当次确认文字原文');
  assert.ok(typed.includes('原样回复'), '要说明这行文字得原样回复');
  assert.ok(typed.includes('拒绝'), '极端确认也要给出拒绝的出口');
});

test('活动行：运行中是当前动态行（不换行、可重绘），结束才落进 scrollback', () => {
  const { renderer, stdout } = makeRenderer();

  renderer.printActivity({ state: 'running', label: '读取文件 大纲.md' });
  const running = stdout.text();
  assert.ok(running.includes('读取文件 大纲.md'));
  assert.ok(!running.endsWith('\n'), '运行中的活动行是待重绘的动态行');

  renderer.printActivity({ state: 'done', label: '读取文件 大纲.md' });
  const text = stdout.text();
  assert.ok(text.includes('✓'), '完成标记');
  assert.ok(text.endsWith('\n'), '完成的活动行落进 scrollback');
});

test('活动行：失败带上一条原因，连续重复的一行合并成一行', () => {
  const { renderer, stdout } = makeRenderer();

  // 失败必须说清为什么：只写「✗ 删除文件 草稿.md」用户不知道发生了什么。
  renderer.printActivity({ state: 'failed', label: '删除文件 草稿.md', detail: '没有这个工具，已跳过这一步。' });
  const first = stdout.text();
  assert.ok(first.includes('✗ 删除文件 草稿.md'), '失败标记与中文工具名');
  assert.ok(first.includes('没有这个工具，已跳过这一步。'), '失败原因就是那条事实');

  // 模型反复重试同一个注定失败的工具时，中间只夹着一行运行中的动态行——
  // 那一行不该把合并打断，否则屏幕上就是十几行一模一样的「✗」。
  for (let i = 0; i < 4; i += 1) {
    renderer.printActivity({ state: 'running', label: '删除文件 草稿.md' });
    renderer.printActivity({ state: 'failed', label: '删除文件 草稿.md', detail: '没有这个工具，已跳过这一步。' });
  }
  assert.equal(stdout.text().match(/✗ 删除文件/g).length, 1, '连续重复的一行只留第一行');

  // 中间插入了别的内容之后，同样的一行要照常出现（不是全局去重）。
  renderer.printStatus('思考中', { final: true });
  renderer.printActivity({ state: 'failed', label: '删除文件 草稿.md', detail: '没有这个工具，已跳过这一步。' });
  assert.equal(stdout.text().match(/✗ 删除文件/g).length, 2, '中间有别的内容就不再算连续重复');
});

test('状态行重绘：改状态时先抹掉旧行，Run 结束换行留下终态', () => {
  const { renderer, stdout } = makeRenderer();

  renderer.printStatus('思考中');
  assert.equal(stdout.text(), '思考中');

  renderer.printStatus('等待确认');
  assert.ok(!stdout.text().endsWith('\n'), '实时状态行不换行');
  assert.match(stdout.text(), /\r\x1b\[K等待确认$/, '重绘前先抹掉旧状态再写新的');

  renderer.printStatus('已完成', { final: true, tone: 'success' });
  assert.ok(stdout.text().endsWith('已完成\n'), 'Run 结束留下终态');
});

test('写入终态前先把待发的正文吐出去，顺序不倒置', () => {
  const { renderer, stdout } = makeRenderer();

  renderer.printStatus('思考中');
  renderer.printAssistant('第一章写完');
  renderer.printStatus('已完成', { final: true, tone: 'success' });

  const text = stdout.text();
  assert.ok(text.indexOf('第一章写完') < text.indexOf('已完成'));
});

test('clearLive 抹掉动态行，close 收尾不留半行', () => {
  const { renderer, stdout } = makeRenderer();

  renderer.printStatus('思考中');
  renderer.clearLive();
  const afterClear = stdout.text();
  assert.ok(!afterClear.includes('思考中') || afterClear.includes('\r'), '动态行被抹掉');

  renderer.printStatus('已完成', { final: true, tone: 'success' });
  renderer.close();
  assert.ok(stdout.text().endsWith('\n'), '关闭后光标应停在新行');
});

// —— 颜色与 NO_COLOR ——

test('有颜色时状态行用 \\r\\x1b[K 重绘，用户行带上颜色', () => {
  const { renderer, stdout } = makeRenderer({ color: true });

  renderer.printUser('写第一章');
  renderer.printStatus('思考中');
  renderer.printStatus('已完成', { final: true, tone: 'success' });

  const text = stdout.text();
  assert.ok(text.includes('\r\x1b[K'), '动态行用 ANSI 清除');
  assert.match(text, /\x1b\[3\dm/, '用户行/状态行带颜色码');
});

test('NO_COLOR 时不上色：光标控制码照旧，颜色码一个都不出现', () => {
  const { renderer, stdout } = makeRenderer({ color: true, env: { NO_COLOR: '1' } });

  renderer.printUser('写第一章');
  renderer.printAssistant('正文');
  renderer.printActivity({ state: 'running', label: '读取文件' });
  renderer.printActivity({ state: 'failed', label: '写入文件' });
  renderer.printStatus('思考中');
  renderer.printStatus('操作失败', { final: true, tone: 'error', detail: '无法写入文件。' });
  renderer.printQueue('排队文本');
  renderer.printDecision({ decision_id: 'd', level: 'extreme', tool: 'delete_file', target: 'x', confirmation_text: '确认删除 abc123' });
  renderer.close();

  const text = stdout.text();
  assertNoColor(text);
  assert.ok(text.includes('写第一章'));
  assert.ok(text.includes('操作失败'));
  assert.ok(text.includes('\r\x1b[K'), '抹行是光标控制码，NO_COLOR 不禁用它');
});

test('NO_COLOR 下重绘不残留旧文案：每次改状态都先抹掉整行', () => {
  const { renderer, stdout } = makeRenderer({ env: { NO_COLOR: '1' } });

  renderer.printStatus('思考中');
  renderer.printStatus('已完成', { final: true, tone: 'success' });

  assert.ok(stdout.text().includes('\r\x1b[K'));
  assertNoColor(stdout.text());
});

// —— 与 composer（输入层行缓冲）的协作 ——

test('Run 进行中的渲染：动态行贴在上方，正文与终态写出时输入区成对让位 / 画回', () => {
  const composer = makeFakeComposer('写第二章');
  const { renderer, stdout } = makeRenderer({ composer });

  renderer.printStatus('思考中');                                     // 动态行 → 输入区上方那一行
  renderer.printStatus('等待确认');                                   // 动态行原地换掉
  renderer.printActivity({ state: 'running', label: '读取文件 大纲.md' }); // 动态行换成活动行
  renderer.printAssistant('第一章');                                  // 待发正文（不足一行，先攒着）
  renderer.printActivity({ state: 'done', label: '读取文件 大纲.md' });   // 活动终态落 scrollback
  renderer.printStatus('已完成', { final: true, tone: 'success' });    // Run 终态
  renderer.close();

  assert.deepEqual(stdout.stray, [], '任何一次写出都必须发生在输入区让位之后');
  assert.deepEqual(composer.violations, [], '让位与画回必须严格成对');
  assert.ok(composer.calls.includes('takeArea'));
  assert.equal(composer.calls.at(-1), 'giveArea', '收尾时输入区必须在屏幕上');
  // 动态行走 setLive，不占 scrollback；收尾时被清掉。
  assert.ok(composer.calls.includes('setLive:思考中'));
  assert.ok(composer.calls.includes('setLive:• 读取文件 大纲.md'));
  assert.equal(composer.live, null, 'Run 结束后没有残留的实时行');

  const text = stdout.text();
  assert.ok(text.includes('第一章'), '正文照样落盘');
  assert.ok(text.includes('读取文件 大纲.md'));
  assert.ok(text.includes('已完成'));
  assert.equal(text.includes('─'), false, '框线归输入区画，渲染器一条都不该写');
});

test('没有 composer（管道 / 非交互）时保持顺序直写，行为不变', () => {
  const { renderer, stdout } = makeRenderer();

  renderer.printStatus('思考中');
  renderer.printStatus('已完成', { final: true, tone: 'success' });

  assert.equal(stdout.stray.length, 0);
  assert.ok(stdout.text().includes('\r\x1b[K'));
  assert.ok(stdout.text().endsWith('已完成\n'));
});

test('活动行宽度闸门：超宽 label 的实时行被截到终端宽度以内（猎捕报告 7）', () => {
  const composer = makeFakeComposer('写第二章');
  const { renderer, stdout } = makeRenderer({ tty: true, composer, columns: 80 });
  // 模型给的原始参数直接拼进 label：嵌套目录 + 长中文标题在 80 列终端必然超宽。
  const longLabel = `读取文件 D:\\Novels\\嵌套目录\\再嵌套\\最终章\\${'雨'.repeat(30)}.md`;
  renderer.printActivity({ state: 'running', label: longLabel });

  const live = composer.live.replace(/\x1b\[[0-9;]*m/g, '');
  for (const row of live.split('\n')) {
    assert.ok(displayWidth(row) <= 79, `实时行 ${displayWidth(row)} 列，软折行会把首格留进 scrollback`);
  }

  // 完成行落 scrollback 的仍是全文（scrollback 自然折行无害，截断只发生在实时区）。
  renderer.printActivity({ state: 'done', label: longLabel });
  assert.ok(stdout.text().includes(longLabel), '终态活动行不许丢字');
});

test('composer 未激活（非交互输入）时退回顺序直写，不碰行缓冲', () => {
  const composer = makeFakeComposer('写第二章');
  composer.isActive = () => false;
  const { renderer, stdout } = makeRenderer({ composer });

  renderer.printStatus('思考中');
  renderer.close();

  assert.deepEqual(composer.calls, []);
  assert.ok(stdout.text().includes('思考中'));
  assert.equal(stdout.stray.length, 0, 'composer 没占屏幕，直写不构成覆盖');
});

// —— 事件桥 ——

function feed(bridge, type, data = {}, extra = {}) {
  bridge.handleEvent({ type, data, ...extra });
}

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

test('formatUsage 在思考 tokens 存在时追加「（思考 800）」', () => {
  assert.equal(formatUsage({ totalTokens: 1200 }), '1.2k tokens');
  assert.equal(formatUsage({ totalTokens: 1200, reasoningTokens: 800 }), '1.2k tokens（思考 800）');
  assert.equal(formatUsage({ totalTokens: 900, reasoningTokens: 300 }), '900 tokens（思考 300）');
  // 0 与 null 都不显示：这轮没思考，挂一个「思考 0」只会让人以为强度没生效。
  assert.equal(formatUsage({ totalTokens: 1200, reasoningTokens: 0 }), '1.2k tokens');
  assert.equal(formatUsage({ totalTokens: 1200, reasoningTokens: null }), '1.2k tokens');
  assert.equal(formatUsage(null), null);
});

test('formatCacheHit 只在真的命中了缓存时给出事实（铁律 3：命中 0 不占行）', () => {
  assert.equal(formatCacheHit({ promptCacheHitTokens: 3400 }), '缓存命中 3.4k');
  assert.equal(formatCacheHit({ promptCacheHitTokens: 800 }), '缓存命中 800');
  assert.equal(formatCacheHit({ promptCacheHitTokens: 0 }), null);
  assert.equal(formatCacheHit({}), null);
  assert.equal(formatCacheHit(null), null);
});

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

// —— 思考行（P20 / P21）——

test('formatThinkingSeconds：秒、四舍五入、最小 1（上游对话样式规格书:176）', () => {
  assert.equal(formatThinkingSeconds(12400), '思考 12 秒');
  assert.equal(formatThinkingSeconds(1200), '思考 1 秒', '最小 1 秒');
  assert.equal(formatThinkingSeconds(400), '思考 1 秒', '不足一秒也算思考过');
  assert.equal(formatThinkingSeconds(1500), '思考 2 秒', '四舍五入');
});

test('算不出耗时时回退「已完成思考」，绝不报一个 0 秒', () => {
  assert.equal(formatThinkingSeconds(null), '已完成思考');
  assert.equal(formatThinkingSeconds(NaN), '已完成思考');
  assert.equal(formatThinkingSeconds(0), '已完成思考');
  assert.equal(formatThinkingSeconds(-5), '已完成思考');
});

// —— 思考预览：内容在**当前轮**可见（实时区那块），但不进 scrollback ——

test('thinkingPreviewLines：没有内容时就是那一行状态；有内容时首行带前缀、续行按前缀宽度缩进', () => {
  assert.deepEqual(thinkingPreviewLines([], { columns: 80 }), ['思考中']);
  assert.deepEqual(thinkingPreviewLines([], { columns: 80 }), ['思考中'], '空数组与缺省一样');

  const one = thinkingPreviewLines(['主角为什么不肯离开'], { columns: 80 });
  assert.equal(one.length, 1);
  assert.equal(one[0], `思考中 · 主角为什么不肯离开`);

  const two = thinkingPreviewLines(['第一句', '第二句'], { columns: 80 });
  assert.equal(two.length, 2);
  assert.equal(two[0], '思考中 · 第一句');
  // 续行缩进 = 「思考中 · 」的显示宽度（3 个汉字 6 列 + 3 列分隔）→ 正文左对齐成一列
  assert.equal(two[1], `${' '.repeat(9)}第二句`);
  assert.equal(displayWidth(two[0].match(/^\S+ · /)[0]), 9);
});

test('thinkingPreviewLines：只显示末尾两行——旧的思考滚出实时区，不往上堆积', () => {
  const shown = thinkingPreviewLines(['一', '二', '三', '四'], { columns: 80 });
  assert.deepEqual(shown, ['思考中 · 三', `${' '.repeat(9)}四`]);
});

test('thinkingPreviewLines：终端太窄就退回只有状态行，绝不把正文挤成两三个字', () => {
  // `思考中 · ` 占 9 列，正文至少要 20 列才值得预览 → 29 列以下不做预览。
  assert.equal(thinkingPreviewWidth(29), 0, '正文只剩 19 列：不值得预览');
  assert.equal(thinkingPreviewWidth(30), 20, '刚好够一行 20 列的正文');
  assert.deepEqual(thinkingPreviewLines(['一句很长的话'], { columns: 29 }), ['思考中'], '没有内容可预览');
  assert.deepEqual(thinkingPreviewLines(['短'], { columns: 29 }), ['思考中'], '再短的话也不预览');
  assert.equal(thinkingPreviewLines(['短'], { columns: 30 })[0], '思考中 · 短');
  assert.equal(thinkingPreviewWidth(80), 80 - 9 - 1, '末尾留 1 列，避免触发终端自动折行');
});

test('thinkingPreviewLines：换行分支漏出的超宽长行在出口截到终端宽度以内（猎捕报告 6）', () => {
  // takeProseRows 的换行分支不切宽：一条 ≥72 显示列的完整逻辑行加上 9 列前缀
  // 就是 81 列的实时行，终端软折行多占一格物理行，擦除按 `\n` 数行——残留。
  const longRow = '雨'.repeat(40); // 80 显示列 > 预览宽 70
  const lines = thinkingPreviewLines([longRow], { columns: 80 });
  assert.equal(lines.length, 1);
  assert.ok(displayWidth(lines[0]) <= 79, `实时行 ${displayWidth(lines[0])} 列，会把首格留进 scrollback`);
  // 放得下的行一个字都不动
  assert.equal(thinkingPreviewLines(['主角为什么不肯离开'], { columns: 80 })[0], '思考中 · 主角为什么不肯离开');
});

test('printThinkingPreview：只在攒满一整行时才重绘（流式逐字到达不会把 readline 按住反复重排）', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, color: false, composer });

  renderer.printThinkingPreview('主角');
  renderer.printThinkingPreview('为什么不');
  renderer.printThinkingPreview('肯离开');
  assert.equal(
    composer.calls.filter((call) => call.startsWith('setLive:')).length, 0,
    '还没攒满一行：一个字节都不重绘',
  );

  renderer.printThinkingPreview('\n');
  const live = composer.calls.filter((call) => call.startsWith('setLive:'));
  assert.equal(live.length, 1, '换行一到就重绘一次');
  assert.equal(live[0], 'setLive:思考中 · 主角为什么不肯离开');
});

test('printThinkingPreview：同一份内容推两次只重绘一次', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, color: false, composer });

  renderer.printThinkingPreview('想好了\n');
  const first = composer.calls.filter((call) => call.startsWith('setLive:')).length;
  renderer.printThinkingPreview('\n\n');
  renderer.printThinkingPreview('\n');
  const second = composer.calls.filter((call) => call.startsWith('setLive:')).length;
  assert.equal(second, first, '空行不进预览，内容没变就不重绘');
});

test('printThinkingPreview：两行封顶，旧行滚出去', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, color: false, composer });

  renderer.printThinkingPreview('第一句\n第二句\n第三句\n');
  assert.equal(
    composer.live, `思考中 · 第二句\n${' '.repeat(9)}第三句`,
    '实时区只有两行，最早那句滚出去',
  );
});

test('printThinkingPreview：思考内容只贴在实时区，**一个字节都不落 scrollback**', () => {
  const composer = makeFakeComposer();
  const { renderer, stdout } = makeRenderer({ tty: true, color: false, composer });

  renderer.printThinkingPreview('这是一段不该进滚动区的思考\n');
  renderer.close();

  assert.equal(stdout.text().includes('不该进滚动区'), false, '内容只在实时区，滚动区里没有');
  assert.ok(composer.live === null, 'close 之后实时区被收走');
});

test('printThinkingPreview：没有输入区（管道 / 非交互）时不预览——那里没有可以原地重画的一块', () => {
  const { renderer, stdout } = makeRenderer({ tty: false, color: false });
  renderer.printThinkingPreview('半句思考\n');
  renderer.close();
  assert.equal(stdout.text().includes('半句思考'), false, '顺序直写会把半句思考一行行塞进输出流');
});

test('printThinkingPreview：终端太窄时维持状态行，绝不输出会被自动折行的长行', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, color: false, composer, columns: 29 });
  const bridge = createEventRenderer({ renderer });

  bridge.handleEvent({ type: 'run_started', at: '2026-09-29T00:00:00.000Z', data: { text: 'hi' } });
  assert.equal(composer.live, '思考中');

  renderer.printThinkingPreview('一句很长的话\n');
  assert.equal(composer.live, '思考中', '放不下就不预览，而不是挤成两三个字一行');
  assert.equal(
    composer.calls.filter((call) => call.startsWith('setLive:')).length, 1,
    '一次多余的 setLive 都没有',
  );
});

test('思考预览：一轮里的第二段思考从头攒，不接在第一段尾巴后面', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, color: false, composer });
  const bridge = createEventRenderer({ renderer });

  renderer.printThinkingPreview('第一轮的思考\n');
  // 模型轮次结束：预览到此为止（下一段由下一次模型请求重新开始）
  bridge.handleEvent({ type: 'reasoning_completed', at: '2026-09-29T00:00:05.000Z', data: { text: '第一轮的思考', started_at: '2026-09-29T00:00:00.000Z', chars: 6 } });
  renderer.printThinkingPreview('第二轮\n');
  assert.equal(composer.live, '思考中 · 第二轮', '新一段只有它自己那一行');
});

test('思考预览：Run 一开就把上一轮遗留的半段收走（不能从旧思考尾巴后面长出来）', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, color: false, composer });
  const bridge = createEventRenderer({ renderer });

  renderer.printThinkingPreview('上一轮被打断的思考\n');
  bridge.handleEvent({ type: 'run_started', at: '2026-09-29T00:00:00.000Z', data: { text: 'hi' } });
  renderer.printThinkingPreview('这一轮的思考\n');
  assert.equal(composer.live, '思考中 · 这一轮的思考');
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

test('printReasoning 灰显直出全文，不做 Markdown', () => {
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  renderer.printReasoning('主角叫**沈砚**，`临渊`是城名。');
  renderer.close();
  assert.equal(screenText(stdout.text()), '  主角叫**沈砚**，`临渊`是城名。',
    '标记原样保留：思考不是正文，不该被当成 Markdown 渲染');
});

test('printReasoning 有颜色时整段压暗', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, color: true, env: {} });
  renderer.printReasoning('想了一会儿');
  renderer.close();
  assert.match(stdout.text(), /\x1b\[2m/, 'muted 是「这一段不是正文」的硬信号');
});

test('printReasoning 空文本一个字节都不写', () => {
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  renderer.printReasoning('');
  renderer.close();
  assert.equal(stdout.text(), '');
});

test('terminalStatusText 是事件桥与重演共用的那一份：四种终态 + 崩溃残留', () => {
  assert.deepEqual(terminalStatusText({ terminal: 'completed' }), { text: '已完成', tone: 'success' });
  assert.deepEqual(terminalStatusText({ terminal: 'interrupted', interruptReason: 'user_stop' }), { text: '已停止', tone: 'warn' });
  assert.deepEqual(terminalStatusText({ terminal: 'interrupted', interruptReason: 'aborted' }), { text: '已中断', tone: 'warn' });
  assert.deepEqual(terminalStatusText({ terminal: 'failed', failCode: 'MODEL_NETWORK_ERROR' }), { text: '连接中断', tone: 'error' });
  assert.deepEqual(terminalStatusText({ terminal: 'failed', failCode: 'MODEL_STREAM_ERROR' }), { text: '连接中断', tone: 'error' });
  // `未配置` 是唯一一种「用户自己能修好」的终态，所以它连出路提示一起长在这一处：
  // 事件桥按键取用 `hint`，绝不匹配主文案的文字（改一个字就会静默丢掉那条提示）。
  assert.deepEqual(terminalStatusText({ terminal: 'failed', failCode: 'MODEL_NOT_CONFIGURED' }), {
    text: '未配置',
    tone: 'warn',
    hint: '用 /model 设置模型与 API Key 后重试。',
  });
  assert.deepEqual(terminalStatusText({ terminal: 'failed', failCode: 'RUN_FAILED' }), { text: '操作失败', tone: 'error' });
  assert.deepEqual(terminalStatusText({ terminal: 'open' }), { text: '未正常结束', tone: 'warn' });
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

// —— 用户消息的背景色带（P17）——

test('userRows 首行带 ❯ 前缀、续行缩进对齐（grokbuild 的同款做法）', () => {
  const rows = userRows('写第一章', { width: 20 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0], `❯ ${padDisplayEnd('写第一章', 18)}`);
  assert.equal(displayWidth(rows[0]), 20, '每一行都补白到内容列宽');
});

test('超出宽度时逐行切分，续行用两个空格对齐到正文起点', () => {
  const rows = userRows('一二三四五六七八九十', { width: 8 });
  assert.equal(rows.length > 1, true);
  assert.ok(rows[0].startsWith('❯ '));
  for (const row of rows.slice(1)) assert.ok(row.startsWith('  '), '续行缩进对齐');
  for (const row of rows) assert.equal(displayWidth(row), 8, '所有行同宽，色带才是齐的');
});

test('CJK 宽度算对：补白按显示宽度而不是字符数', () => {
  const [row] = userRows('临渊', { width: 12 });
  assert.equal(displayWidth(row), 12);
  assert.equal(row, `❯ ${padDisplayEnd('临渊', 10)}`);
});

test('空文本也给出恰好一行（色带不会凭空消失）', () => {
  const rows = userRows('', { width: 10 });
  assert.equal(rows.length, 1);
  assert.equal(displayWidth(rows[0]), 10);
});

test('有颜色时每行都铺背景色并以 reset 收尾', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, color: true, env: {} });
  renderer.printUser('写第一章');
  renderer.close();
  const raw = stdout.text();
  assert.match(raw, /\x1b\[48;5;236m/, '中性暗底');
  assert.match(raw, /\x1b\[0m/, '每行收尾必须 reset，否则底色会漏到后面的正文上');
});

test('长消息折行后每个视觉行都有底色（否则第二行会露白）', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, color: true, env: {} });
  renderer.printUser('一'.repeat(300));
  renderer.close();
  const bands = stdout.text().split('\x1b[48;5;236m').length - 1;
  const lines = screenText(stdout.text()).split('\n').filter((line) => line !== '');
  assert.equal(bands, lines.length, '视觉行数 = 色带数');
  assert.ok(lines.length > 1);
});

test('NO_COLOR 下一个 ANSI 字节都不输出，且不留行尾补白', () => {
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  renderer.printUser('写第一章');
  renderer.close();
  assert.equal(/\x1b\[[0-9;]*m/.test(stdout.text()), false);
  assert.equal(stdout.text(), '❯ 写第一章\n', '无底色就不需要补白，保持与上线前逐字一致');
});

test('色带每一行等宽，且左边界与正文的缩进列对齐', () => {
  // **不要**断言「色带宽度 == 正文宽度」：那是个假前提（审查抓出来的）。
  // renderProseRow（renderer.mjs:196-210）只加左缩进、**从不右补白**，
  // 所以正文行的显示宽度随内容长短变化，而色带行是补白到固定宽度的。
  // 两者真正必须一致的是**左边界**（都从第 2 列起）与**色带自身的等宽**。
  const stdout = makeStdout({ tty: true, columns: 60 });
  const renderer = createRenderer({ stdout, color: true, env: {} });
  renderer.printUser('一'.repeat(200));
  renderer.close();

  // 等宽这条必须断在**原始字节**上：补白就是行尾空格，而 screenText 会把每行行尾空格剥掉
  // （tests/helpers/screen.mjs:126），拿还原后的画面量「等宽」只会量到 58/10 ——
  // 尾行短是 screenText 的剥空格，不是色带断了。
  const rows = [...stdout.text().matchAll(/\x1b\[48;5;236m\x1b\[36m([^\n]*?)\x1b\[0m/g)].map((match) => match[1]);
  assert.ok(rows.length > 1, '长消息确实折成了多个视觉行');
  const widths = new Set(rows.map((row) => displayWidth(row)));
  assert.equal(widths.size, 1, `色带每个视觉行必须等宽，实际得到 ${[...widths].join('/')}`);
  assert.deepEqual([...widths], [proseRowWidth(60) + PROSE_INDENT], '每行都补满内容列宽');

  // 左边界：❯ 落在第 0 列、续行缩进两格。画面上除了这两个缩进，色带行不该再有别的缩进
  // （「❯ 与续行的两个空格就是它的左边界」，见 renderer.mjs 的 ruleLine 缩进注释）。
  const lines = screenText(stdout.text(), { cols: 60 }).split('\n').filter((line) => line !== '');
  assert.equal(lines.length, rows.length, '视觉行数与色带数一一对应');
  for (const line of lines) {
    const indent = displayWidth(line) - displayWidth(line.replace(/^ +/, ''));
    assert.ok(indent === 0 || indent === 2, `色带行只允许 0 或 2 格缩进，实际 ${indent}`);
  }
});

test('色带左边界与正文左边界同列（屏幕上所有块对齐成一列）', () => {
  const stdout = makeStdout({ tty: true, columns: 60 });
  const renderer = createRenderer({ stdout, color: true, env: {} });
  renderer.printUser('用户说的话');
  renderer.printAssistant('模型的正文');
  renderer.close();
  const lines = screenText(stdout.text(), { cols: 60 }).split('\n').filter((line) => line !== '');
  const userLine = lines.find((line) => line.includes('用户说的话'));
  const proseLine = lines.find((line) => line.includes('模型的正文'));
  // 用户行的 ❯ 落在第 0 列、正文落在缩进 2 列——正文起点因此与「❯ 」之后的文本起点对齐，
  // 这正是 ruleLine 的缩进注释里说的同一件事（renderer.mjs:99-101）。
  assert.equal(userLine.indexOf('用户说的话'), 2);
  assert.equal(proseLine.indexOf('模型的正文'), 2);
});
