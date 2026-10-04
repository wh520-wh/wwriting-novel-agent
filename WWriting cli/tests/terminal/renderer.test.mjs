// Inline 渲染器（屏幕 writer）测试：用户行 / 正文 / 活动行 / 状态行 / 排队行 / 确认提示都进 scrollback；
// 当前动态状态用 \r 重绘（有颜色时 \r\x1b[K），Run 结束换行留下终态；
// 流式正文按「完整行」落盘；NO_COLOR 时一个 ANSI 字节都不输出。
// 分工：事件 → 渲染调用的翻译断言在 event-bridge.test.mjs（那里也负责事件桥契约），
// 纯格式函数在 style.test.mjs；本文件里少数用例借事件桥喂事件来驱动 writer，属正常穿越。
import test from 'node:test';
import assert from 'node:assert/strict';

import { PROSE_INDENT, createRenderer } from '../../src/terminal/renderer.mjs';
import { createEventRenderer } from '../../src/terminal/event-bridge.mjs';
import { displayWidth, proseRowWidth } from '../../src/terminal/metrics.mjs';
import { screenText } from '../helpers/screen.mjs';
import { VERSION, versionLine } from '../../src/version.mjs';
import { assertNoColor, feed, makeFakeComposer, makeRenderer, makeStdout } from './support.mjs';

// —— 静态输出进 scrollback ——

test('窄窗口首屏对齐且完整保留工作区路径与会话 ID', () => {
  const { renderer, stdout } = makeRenderer({ columns: 40 });
  const folder = 'D:\\小说\\长街灯火\\设定与资料\\第一卷';
  const session = '开始新会话 · 80a922de-22c1-43fa-95d6-001dc8807677';
  renderer.printIntro({ title: versionLine(), subtitle: '长篇写作智能体',
    rows: [['工作区', folder], ['会话', session]], bottomBorder: false });
  renderer.close();
  const rows = stdout.text().trimEnd().split('\n');
  assert.ok(rows.every((row) => displayWidth(row) < 40));
  const rowOf = (label) => rows.findIndex((row) => row.includes(label));
  const values = (start, end) => rows.slice(start, end).map((row) => row.replace(/^  (?:工作区|会话) +|^ +/, '')).join('');
  assert.equal(values(rowOf('工作区'), rowOf('会话')), folder);
  assert.equal(values(rowOf('会话'), rows.length), session);
});

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
  // 管道 / 非 TTY：没有实时区可挂，排队行仍要一处可见交代（setLiveQueue 的直写退路）。
  renderer.setLiveQueue([{ input_id: 'q-1', text: '把第二章也写了' }]);
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

// —— 正文 → UI 边界的呼吸空行（ADR-0019）——

test('正文之后接工具行/状态行：补一个空行再交棒；UI 行接 UI 行不补', () => {
  const { renderer, stdout } = makeRenderer();

  renderer.printAssistant('先看一眼。\n');
  renderer.printActivity({ state: 'done', label: '读取文件 大纲.md' });
  renderer.printActivity({ state: 'done', label: '读取文件 设定.md' });
  renderer.printStatus('已完成', { final: true, tone: 'success' });
  renderer.close();

  const lines = stdout.text().split('\n');
  const index = lines.indexOf('▌ 先看一眼。');
  assert.equal(lines[index + 1], '', '正文 → 工具行之间有一个空行');
  assert.equal(lines[index + 2], '✓ 读取文件 大纲.md', '空行之后才是工具行');
  assert.equal(lines.indexOf('✓ 读取文件 设定.md') - lines.indexOf('✓ 读取文件 大纲.md'), 1, '工具行 → 工具行紧排，不补空行');
  const status = lines.indexOf('已完成');
  assert.equal(lines[status - 1], '✓ 读取文件 设定.md', '终态行紧贴上一条 UI 行，中间不凭空多空行');
});

test('正文之后接用户行/决策卡：同样补一个空行；正文为空时什么都不补', () => {
  const { renderer, stdout } = makeRenderer();

  renderer.printUser('写第一章');
  renderer.printAssistant('好的。\n');
  renderer.printDecision({ decision_id: 'd1', level: 'write', tool: 'write_file', target: '第一章.md' });
  renderer.printUser('继续');
  renderer.close();

  const lines = stdout.text().split('\n');
  const prose = lines.indexOf('▌ 好的。');
  assert.equal(lines[prose + 1], '', '正文 → 决策卡之间有一个空行');
  assert.ok(lines[prose + 2].includes('需要确认'), '空行之后才是确认卡');
  const user = lines.indexOf('❯ 继续');
  assert.ok(lines[user - 1].includes('需要确认') || lines[user - 1].includes('拒绝'), '决策卡 → 用户行之间不补空行');
});

test('会话收尾（close）不补尾空行', () => {
  const { renderer, stdout } = makeRenderer();
  renderer.printAssistant('最后一句。\n');
  renderer.close();
  assert.ok(stdout.text().endsWith('▌ 最后一句。\n'), '正文落盘即收尾，尾部没有多余空行');
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
  assert.match(text, /\x1b\[38;5;\d+m/, '用户行/状态行带颜色码');
});

test('NO_COLOR 时不上色：光标控制码照旧，颜色码一个都不出现', () => {
  const { renderer, stdout } = makeRenderer({ color: true, env: { NO_COLOR: '1' } });

  renderer.printUser('写第一章');
  renderer.printAssistant('正文');
  renderer.printActivity({ state: 'running', label: '读取文件' });
  renderer.printActivity({ state: 'failed', label: '写入文件' });
  renderer.printStatus('思考中');
  renderer.printStatus('操作失败', { final: true, tone: 'error', detail: '无法写入文件。' });
  renderer.setLiveQueue([{ input_id: 'q-1', text: '排队文本' }]);
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

test('composer 在但输入区没激活：动态行攒着不直写（直写了 start 后就是没人认领的残留）', () => {
  // Task 7 deferred 的行位假设：input.start() 之前渲染过非 final 动态行，直写落在屏幕上；
  // start 之后框画在它下面，输入层的擦除永远够不着它——残留一行谁也管不了的状态。
  // 修复 = 所有权归一：composer 存在，动态行就只走 composer 协议；未激活（start 前 /
  // 让位期间）就攒在 liveBody 里，激活后经 setLive 上屏或被新状态替换，绝不落字节流。
  const composer = makeFakeComposer('');
  let active = false;
  composer.isActive = () => active;
  const { renderer, stdout } = makeRenderer({ env: { NO_COLOR: '1' }, composer });

  renderer.printStatus('思考中', { final: false });
  assert.equal(stdout.text(), '', '未激活时动态行不得直写进字节流');

  // scrollback 照常直写：start 前没有框可让（启动面板、重演都走这条路，不受影响）。
  renderer.printUser('写第一章');
  assert.ok(stdout.text().includes('写第一章'), 'start 前的 scrollback 仍按顺序直写');

  // 激活后动态行经 setLive 上屏；攒着的旧状态已被替换，既没直写过也不得复活。
  active = true;
  renderer.printStatus('搜索文件', { final: false });
  assert.equal(composer.live, '搜索文件', '激活后动态行走 composer 协议');
  assert.ok(!stdout.text().includes('思考中'), '未上屏的旧动态行不得出现在字节流里');
  assert.ok(!stdout.text().includes('搜索文件'), '动态行不占 scrollback，只走 setLive');

  renderer.close();
  assert.equal(composer.live, null, '收尾后实时行清空');
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

test('composer 在但从未激活：动态行攒着，既不直写也不惊动 composer', () => {
  // 管道 / 非交互会话由组合根传 composer: null（走「没有 composer」的直写路）。
  // 只要 composer 在，动态行就只走 composer 协议——未激活就攒着。直写会让
  // start 之后框上方多一行输入层永远擦不到的残留（Task 7 deferred 的行位假设）。
  const composer = makeFakeComposer('写第二章');
  composer.isActive = () => false;
  const { renderer, stdout } = makeRenderer({ composer });

  renderer.printStatus('思考中');
  renderer.close();

  assert.deepEqual(composer.calls, [], '从未激活就没人接 setLive，一次都不该惊动 composer');
  assert.equal(stdout.text(), '', '未激活时动态行不得直写进字节流');
  assert.equal(stdout.stray.length, 0);
});

// —— 思考预览：内容在**当前轮**可见（实时区那块），但不进 scrollback ——

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
  assert.match(stdout.text(), /\x1b\[38;5;246m/, '思考使用可读的辅助文字色');
});

test('printReasoning 空文本一个字节都不写', () => {
  const stdout = makeStdout({ tty: false });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  renderer.printReasoning('');
  renderer.close();
  assert.equal(stdout.text(), '');
});

// —— 用户消息的背景色带（P17）——

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
  // 正文渲染（markdown.mjs）只加左缩进、**从不右补白**，
  // 所以正文行的显示宽度随内容长短变化，而色带行是补白到固定宽度的。
  // 两者真正必须一致的是**左边界**（都从第 2 列起）与**色带自身的等宽**。
  const stdout = makeStdout({ tty: true, columns: 60 });
  const renderer = createRenderer({ stdout, color: true, env: {} });
  renderer.printUser('一'.repeat(200));
  renderer.close();

  // 等宽这条必须断在**原始字节**上：补白就是行尾空格，而 screenText 会把每行行尾空格剥掉
  // （tests/helpers/screen.mjs:126），拿还原后的画面量「等宽」只会量到 58/10 ——
  // 尾行短是 screenText 的剥空格，不是色带断了。
  const rows = [...stdout.text().matchAll(/\x1b\[48;5;236m\x1b\[38;5;253m([^\n]*?)\x1b\[0m/g)].map((match) => match[1]);
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

// —— 任务计划表（update_plan 的可见产物） ——

test('printPlan：标题带进度，三态标记各就各位，长步骤折行对齐', () => {
  const { renderer, stdout } = makeRenderer({ columns: 100 });
  renderer.printPlan([
    { summary: '通读前两章，确认时间线没有矛盾', status: 'completed' },
    { summary: '写第三章' + '，这一步的说明很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长', status: 'in_progress' },
    { summary: '检查衔接', status: 'pending' },
  ]);
  renderer.close();
  const text = screenText(stdout.text());
  const rows = text.split('\n');
  assert.match(rows[0], /^任务计划 1\/3$/);
  assert.match(rows[1], /^  ✓ 通读前两章，确认时间线没有矛盾$/);
  assert.match(rows[2], /^  ▶ 写第三章/);
  assert.ok(rows.length > 4, '长步骤要折行而不是挤成一行');
  assert.match(rows[3], /^ {4}/, '折行续行对齐到正文列');
  const pendingRow = rows.find((row) => row.includes('检查衔接'));
  assert.match(pendingRow, /^  ◌ 检查衔接$/, 'pending 是虚线圆（§4.2）');
});

test('printPlan：完成项压暗加删除线、进行中加粗（§4.2 的条目形态）', () => {
  const { renderer, stdout } = makeRenderer({ columns: 100, color: true });
  renderer.printPlan([
    { summary: '通读前两章', status: 'completed' },
    { summary: '写第三章', status: 'in_progress' },
    { summary: '检查衔接', status: 'pending' },
  ]);
  renderer.close();
  const text = stdout.text();
  assert.ok(text.includes('\x1b[2m\x1b[9m通读前两章'), '完成 = 压暗 + 删除线');
  assert.ok(text.includes('\x1b[38;5;173m\x1b[1m写第三章'), '进行中 = 强调色 + 加粗');
  assert.ok(text.includes('\x1b[38;5;246m检查衔接'), '未开始 = 常规压暗');
});

test('printPlan 空表与非法输入一个字节都不写', () => {
  const { renderer, stdout } = makeRenderer();
  renderer.printPlan([]);
  renderer.printPlan(null);
  renderer.printPlan('坏的');
  renderer.close();
  assert.equal(stdout.text(), '');
});

test('事件桥：composer 缺 setLive 在渲染器装配期炸出来', () => {
  const stdout = makeStdout({ tty: true });
  assert.throws(
    () => createRenderer({ stdout, composer: { takeArea() {}, giveArea() {} } }),
    /composer 缺少能力：setLive/,
  );
});

// —— 实时区任务面板（运行中展开 / 空闲 chip / 新 Run 清空） ——

test('实时区计划面板：运行中展开条目；Run 结束收成一行 chip 保留；新 Run 清空', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, env: { NO_COLOR: '1' }, composer });
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'run_started', { input_id: 'i-1', text: '改这三章' });
  feed(bridge, 'plan_updated', {
    items: [
      { summary: '通读前两章', status: 'completed' },
      { summary: '核对时间线', status: 'completed' },
      { summary: '写第三章', status: 'in_progress' },
      { summary: '检查衔接', status: 'pending' },
    ],
  });
  const panel = composer.live;
  assert.ok(panel.includes('任务计划 2/4'), '面板标题带进度');
  assert.ok(panel.includes('已完成 2 步'), '完成项收成一行汇总（不逐条占行）');
  assert.ok(panel.includes('▶ 写第三章'), '进行中项在面板里');
  assert.ok(panel.includes('◌ 检查衔接'), '未开始项在面板里');

  feed(bridge, 'run_completed', {});
  const chip = composer.live;
  assert.equal(chip.split('\n').length, 1, 'Run 结束收成一行 chip');
  assert.ok(chip.includes('任务计划 2/4'), 'chip 保留供回看（§4.2）');
  assert.ok(chip.includes('写第三章'), 'chip 带上当前步骤，一眼看到进度');

  feed(bridge, 'run_started', { input_id: 'i-2', text: '继续' });
  assert.equal(composer.live.includes('任务计划'), false, '新 Run 清空上一轮计划（口径 A）');
  assert.ok(composer.live.includes('思考中'), '新 Run 的实时行照常是「思考中」');
  renderer.close();
});

test('实时区计划面板：动态行在上、面板在下；完成全部时收一句「全部完成」', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, env: { NO_COLOR: '1' }, composer });
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'run_started', { input_id: 'i-1', text: '改这三章' });
  feed(bridge, 'plan_updated', { items: [{ summary: '写第三章', status: 'in_progress' }] });
  feed(bridge, 'activity_started', { tool: 'read_file', target: '第一章.md' });
  const live = composer.live.split('\n');
  assert.ok(live[0].includes('读取文件 第一章.md'), '动态行在上');
  assert.ok(live[1].includes('任务计划 0/1'), '面板在下');

  feed(bridge, 'plan_updated', { items: [{ summary: '写第三章', status: 'completed' }] });
  assert.ok(composer.live.includes('全部完成'), '全部完成时收一句');
  renderer.close();
});

test('实时区计划面板：多步超窗口时收进「… 还有 N 步」，已完成的收成一行汇总', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, env: { NO_COLOR: '1' }, composer });
  const bridge = createEventRenderer({ renderer });

  feed(bridge, 'run_started', { input_id: 'i-1', text: '长计划' });
  const items = [];
  for (let i = 1; i <= 12; i += 1) items.push({ summary: `第 ${i} 步`, status: 'completed' });
  items.push({ summary: '正在做的一步', status: 'in_progress' });
  feed(bridge, 'plan_updated', { items });
  const panel = composer.live;
  assert.ok(panel.includes('已完成 12 步'), '完成项汇总成一行');
  assert.ok(panel.includes('正在做的一步'), '当前步骤必须在面板里');
  assert.ok(panel.split('\n').length <= 7, '面板有行数上限');
  renderer.close();
});

test('面板持久性：写 scrollback（让位/画回）之后面板重新挂上', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, env: { NO_COLOR: '1' }, composer });
  renderer.setLivePlan([{ summary: '写第三章', status: 'in_progress' }], { active: true });
  assert.ok(composer.live.includes('▶ 写第三章'));

  renderer.printUser('用户插了一句话'); // 一次完整的让位 → 写 scrollback → 画回
  assert.ok(composer.live !== null && composer.live.includes('▶ 写第三章'),
    `写完 scrollback 面板必须重挂：${composer.live}`);
  renderer.close();
});

test('面板窗口：进行中项排在窗口之外时也要可见（两侧给省略行）', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, env: { NO_COLOR: '1' }, composer });
  const items = [];
  for (let i = 1; i <= 6; i += 1) items.push({ summary: `待办 ${i}`, status: 'pending' });
  items.push({ summary: '★ 正在进行的一步', status: 'in_progress' });
  renderer.setLivePlan(items, { active: true });
  const panel = composer.live;
  assert.ok(panel.includes('★ 正在进行的一步'), `进行中项必须在场：${panel}`);
  assert.ok(panel.includes('… 前面还有'), `被裁掉的头部要有交代：${panel}`);
  renderer.close();
});

test('空计划（整表替换）：实时区收起，/plan 回到「暂无」口径', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, env: { NO_COLOR: '1' }, composer });
  renderer.setLivePlan([{ summary: '写第三章', status: 'in_progress' }], { active: true });
  assert.ok(composer.live.includes('任务计划'), '先有面板');
  renderer.setLivePlan([]);
  assert.equal(composer.live, null, '空表 = 显式清空');
  renderer.close();
});

test('窄终端：截断带省略号，不把半截步骤名当完整名', () => {
  const composer = makeFakeComposer();
  const stdout = makeStdout({ tty: true });
  stdout.columns = 24;
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' }, composer });
  renderer.setLivePlan([{ summary: '核对第三章时间线与人物动机是否前后一致', status: 'in_progress' }], { active: false });
  renderer.close();
  assert.ok(composer.live.includes('…'), `截断要可见：${composer.live}`);
  assert.ok(composer.live.includes('核对'), '截断前的内容仍在');
});

test('没有 composer（管道）时不合成面板：面板不写进直写流', () => {
  const stdout = makeStdout({ tty: true });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' } });
  const bridge = createEventRenderer({ renderer });
  feed(bridge, 'run_started', { input_id: 'i-1', text: '写' });
  feed(bridge, 'plan_updated', { items: [{ summary: '写第三章', status: 'in_progress' }] });
  renderer.close();
  const text = screenText(stdout.text());
  assert.ok(text.includes('任务计划 0/1'), '滚动区全表照常');
  assert.equal(text.includes('▶ 写第三章\n任务计划'), false);
});

// —— 排队行进实时区：开跑后不留「排队」残影 ——

test('setLiveQueue（composer）：排队行贴在实时区，与动态行合成；一条都不进 scrollback', () => {
  const composer = makeFakeComposer('写第二章');
  const { renderer, stdout } = makeRenderer({ tty: true, composer });

  renderer.printStatus('思考中');
  renderer.setLiveQueue([
    { input_id: 'q-1', text: '把第二章也写了' },
    { input_id: 'q-2', text: '再补一段结尾' },
  ]);

  const live = composer.live.replace(/\x1b\[[0-9;]*m/g, '');
  assert.deepEqual(live.split('\n'), [
    '思考中',
    '把第二章也写了   排队',
    '再补一段结尾   排队',
  ], '多条排队按 FIFO 各占一行，动态行在上');
  assert.equal(stdout.text().includes('排队'), false, '实时区不是 scrollback：历史里没有残影');
});

test('setLiveQueue（composer）：轮到开跑的行消失、其余保留；撤空后实时区不留空壳', () => {
  const composer = makeFakeComposer();
  const { renderer, stdout } = makeRenderer({ tty: true, composer });

  renderer.setLiveQueue([
    { input_id: 'q-1', text: '第一条排队' },
    { input_id: 'q-2', text: '第二条排队' },
  ]);
  // 轮到 q-1：整表替换为剩下的那条——开跑的实时区行自然消失。
  renderer.setLiveQueue([{ input_id: 'q-2', text: '第二条排队' }]);
  let live = composer.live.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(live.includes('第一条排队'), false, '开跑的行消失');
  assert.ok(live.includes('第二条排队   排队'), '其余保留');

  renderer.setLiveQueue([]);
  assert.equal(composer.live, null, '撤空后实时区不留空壳');
  assert.equal(stdout.text().includes('排队'), false, '全程零 scrollback 残影');
});

test('setLiveQueue：与计划面板合成的顺序是 动态行 → 排队行 → 计划面板', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, composer });

  renderer.setLivePlan([{ summary: '写第三章', status: 'in_progress' }], { active: true });
  renderer.printStatus('思考中');
  renderer.setLiveQueue([{ input_id: 'q-1', text: '插队的事' }]);

  const live = composer.live.replace(/\x1b\[[0-9;]*m/g, '');
  const rows = live.split('\n');
  const at = (needle) => rows.findIndex((row) => row.includes(needle));
  assert.ok(at('思考中') !== -1 && at('插队的事') !== -1 && at('写第三章') !== -1, live);
  assert.ok(at('思考中') < at('插队的事'), '动态行在排队行之上');
  assert.ok(at('插队的事') < at('写第三章'), '排队行在计划面板之上');
});

test('setLiveQueue：超宽原文在实时区被截到终端宽度以内', () => {
  const composer = makeFakeComposer();
  const { renderer } = makeRenderer({ tty: true, composer, columns: 40 });

  renderer.setLiveQueue([{ input_id: 'q-1', text: `把这一章${'雨'.repeat(60)}写完` }]);
  const live = composer.live.replace(/\x1b\[[0-9;]*m/g, '');
  for (const row of live.split('\n')) {
    assert.ok(displayWidth(row) <= 39, `实时行 ${displayWidth(row)} 列，软折行会把首格留进 scrollback`);
  }
  assert.ok(live.includes('排队'), '截断的是原文，徽标仍在');
});

test('setLiveQueue（管道）：新加入的条目直写一行，重复同步不重写', () => {
  const { renderer, stdout } = makeRenderer();

  renderer.setLiveQueue([
    { input_id: 'q-1', text: '第一条排队' },
    { input_id: 'q-2', text: '第二条排队' },
  ]);
  // 整表替换重复同步（如开跑时同步剩余列表）：已经写过的不再写第二遍。
  renderer.setLiveQueue([{ input_id: 'q-2', text: '第二条排队' }]);
  renderer.close();

  const text = stdout.text();
  assert.equal(text.match(/第一条排队   排队/g).length, 1);
  assert.equal(text.match(/第二条排队   排队/g).length, 1);
});
