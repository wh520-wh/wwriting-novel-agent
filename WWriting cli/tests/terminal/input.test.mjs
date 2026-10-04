// 输入读取测试：Enter 发送、空行忽略、Ctrl+C 交给控制器（不硬编码退出）、
// 标准输入结束走同一套退出路径；MinTTY 特征时给一次性提示并走非交互分支。
// 全部用内存流（不是真实 TTY），真实 TTY 行为留给 Task 8 的 smoke script 与手测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import * as inputModule from '../../src/terminal/input.mjs';
import {
  createInputReader, detectMinTTY, isInteractiveTerminal, readOneLine,
} from '../../src/terminal/input.mjs';
import { createInputYielder } from '../../src/terminal/input-yield.mjs';
import { createRenderer } from '../../src/terminal/renderer.mjs';
import { noopScheduleTick } from './support.mjs';
import { screenText } from '../helpers/screen.mjs';

// 伪 TTY：readline 需要 isTTY / setRawMode 才能在回车与 Ctrl+C 上给出同样的行为。
function makeFakeTTY() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  stream.isRaw = false;
  stream.setRawMode = () => {};
  return stream;
}

// 内存输出：readline 在 terminal 模式下会监听 output 的事件，所以这里用真流当外壳，
// 只把 write 换成收集器，便于断言「屏幕上出现了什么」。
function makeSink({ tty = false } = {}) {
  const stream = new PassThrough();
  const chunks = [];
  stream.isTTY = tty;
  stream.columns = 80;
  stream.rows = 24;
  stream.write = (text) => {
    chunks.push(String(text));
    return true;
  };
  stream.text = () => chunks.join('');
  stream.chunks = chunks;
  return stream;
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('Tab 补全命令仍留在唯一输入框内，替换草稿不触发发送', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submitted = [];
  const reader = createInputReader({ stdin, stdout, env: {}, commands: ['/model', '/resume'],
    onSubmit: (text) => submitted.push(text) });
  reader.start();
  try {
    stdin.write('/mo\t');
    await tick();
    assert.ok(screenText(stdout.text()).includes('❯ /model'));
    reader.replaceDraft('/resume ');
    assert.deepEqual(submitted, []);
    stdin.write('\r');
    await tick();
    assert.deepEqual(submitted, ['/resume ']);
  } finally {
    reader.stop();
  }
});

test('Shift+Tab 不触发补全，作为 mode-cycle 控制事件上报（ADR-0020）', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submitted = [];
  const controls = [];
  const reader = createInputReader({ stdin, stdout, env: {}, commands: ['/model', '/resume'],
    onSubmit: (text) => submitted.push(text),
    onControl: (name) => controls.push(name) });
  reader.start();
  try {
    // 同一批字节里带着待补全的前缀：没有拦截的话 Shift+Tab 会把 /mo 补成 /model（实测行为）。
    stdin.write('/mo\x1b[Z');
    await tick();
    const screen = screenText(stdout.text());
    assert.ok(screen.includes('❯ /mo'), `草稿保持原样：${screen}`);
    assert.ok(!screen.includes('❯ /model'), `绝不能触发命令补全：${screen}`);
    assert.deepEqual(controls, ['mode-cycle']);
    assert.deepEqual(submitted, []);
    // 普通按键照常透传：拦截层不能吞掉别人的键。
    stdin.write('w\r');
    await tick();
    assert.deepEqual(submitted, ['/mow']);
  } finally {
    reader.stop();
  }
});

test('detectMinTTY 只认 MinTTY 特征，Windows Terminal / 普通终端不算', () => {
  assert.equal(detectMinTTY({ TERM_PROGRAM: 'mintty' }), true);
  assert.equal(detectMinTTY({ MSYSTEM: 'MINGW64', TERM: 'xterm-256color' }), true);
  assert.equal(detectMinTTY({ MSYSTEM: 'MINGW64', TERM: 'xterm-256color', WT_SESSION: 'x' }), false);
  assert.equal(detectMinTTY({ TERM_PROGRAM: 'Windows_Terminal' }), false);
  assert.equal(detectMinTTY({}), false);
  assert.equal(detectMinTTY(null), false);
});

test('非 TTY：start 报告非交互，但管道里的整行仍然送来，空行被忽略', async () => {
  const stdin = new PassThrough();
  const stdout = makeSink();
  const submitted = [];
  const controls = [];
  const reader = createInputReader({
    stdin,
    stdout,
    env: {},
    onSubmit: (text) => submitted.push(text),
    onControl: (name) => controls.push(name),
  });

  const status = reader.start();
  assert.equal(status.interactive, false);
  assert.equal(status.reason, null);

  stdin.write('写第一章\r\n');
  stdin.write('\r\n');
  stdin.write('   \n');
  stdin.write('写第二章\n');
  await tick();

  assert.deepEqual(submitted, ['写第一章', '写第二章']);

  reader.stop();
  stdin.end();
  await tick();
  assert.deepEqual(controls, [], 'stop 之后输入结束不应再报控制事件');
});

test('伪 TTY：Enter 发送、Ctrl+C 交给控制器、输入结束走同一条控制路径', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submitted = [];
  const controls = [];
  const reader = createInputReader({
    stdin,
    stdout,
    env: {},
    onSubmit: (text) => submitted.push(text),
    onControl: (name) => controls.push(name),
  });

  const status = reader.start();
  assert.equal(status.interactive, true);

  stdin.write('写第一章\r');
  await tick();
  assert.deepEqual(submitted, ['写第一章']);

  stdin.write('\x03');
  await tick();
  assert.deepEqual(controls, ['interrupt'], 'Ctrl+C 只上报，由控制器决定停还是退');

  stdin.end();
  await tick();
  assert.deepEqual(controls, ['interrupt', 'eof']);

  reader.stop();
});

test('密钥输入照常回显（刻意的取舍：隐藏回显那套太脆弱，用户也看不出自己粘进去没有）', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submitted = [];
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: (text) => submitted.push(text) });

  reader.start();
  stdin.write('/model key ');
  stdin.write('sk-abcdef123456');
  await tick();
  stdin.write('\r');
  await tick();

  const shown = stdout.text();
  assert.ok(shown.includes('sk-abcdef123456'), '这一行照常回显，用户能确认自己粘对了');
  assert.deepEqual(submitted, ['/model key sk-abcdef123456'], '提交的仍是整行原文');
  // 脱敏仍然只发生在展示环节（配置行、确认行），命令层有自己的一组用例。
  assert.equal(isSecretInputExists(), false, '输入层不再有「哪一行算密钥」这套规则');

  reader.stop();
});

// 上面那条断言的说明：隐藏回显需要覆写 readline 的私有出口，既脆弱又和「粘贴有没有生效」的
// 判断混在一起。功能撤掉之后，输入层不该再挑挑拣拣地决定哪一行不回显——所以这里直接钉住
// 「输入层不再导出这套规则」，防止将来有人半路把它加回来。
function isSecretInputExists() {
  return Object.prototype.hasOwnProperty.call(inputModule, 'isSecretInput');
}

test('伪 TTY：普通输入照常回显，不被密钥规则误伤', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submitted = [];
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: (text) => submitted.push(text) });

  reader.start();
  stdin.write('/model deepseek-chat');
  stdin.write('\r');
  await tick();
  stdin.write('模型的关键词是 key');
  await tick();
  stdin.write('\r');
  await tick();

  const shown = stdout.text();
  assert.ok(shown.includes('/model deepseek-chat'), '设置模型的命令要照常回显');
  assert.ok(shown.includes('模型的关键词是 key'), '普通正文要照常回显');
  assert.deepEqual(submitted, ['/model deepseek-chat', '模型的关键词是 key']);

  reader.stop();
});

test('集成：Run 进行中的输出写在框上方，用户键入的内容与框都在（断言屏幕画面）', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submitted = [];
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: (text) => submitted.push(text) });
  reader.start();
  const screen = () => screenText(stdout.text(), { cols: 80, rows: 40 });

  // 空框：上下各一条线，提示符夹在中间
  assert.match(screen(), /^\s*─{20,}\n❯ *\n\s*─{20,}$/, '空框长这样：上框线 / ❯ / 下框线');

  // 用户先键入一半，还没回车
  stdin.write('写第二章');
  await tick();
  assert.match(screen(), /^\s*─{20,}\n❯ 写第二章\n\s*─{20,}$/, '键入的内容写在框里，框也跟着重画');

  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' }, composer: reader.composer, scheduleTick: noopScheduleTick });
  renderer.printStatus('思考中');
  renderer.printActivity({ state: 'running', label: '读取文件 大纲.md' });
  renderer.printAssistant('第一章开始了。\n');
  renderer.printStatus('已完成', { final: true, tone: 'success' });

  const shown = screen();
  assert.ok(shown.includes('第一章开始了。'), '正文照常出现');
  assert.ok(shown.includes('已完成'));
  assert.equal(submitted.length, 0, '渲染期间用户并没有回车，不能产生提交');
  // 关键的一条：渲染的输出都在框上方，用户键入的内容与整个框都还在屏幕上，且框是最后两行。
  assert.ok(
    shown.lastIndexOf('❯ 写第二章') > shown.lastIndexOf('第一章开始了。'),
    '用户的行缓冲在输出之下（框始终贴着屏幕底部）',
  );
  assert.match(shown, /\n❯ 写第二章\n\s*─{20,}$/, '框仍然收在屏幕最下方');

  // 输入框全程可用：补完再回车，提交的是完整的这一行
  stdin.write('，继续');
  await tick();
  assert.match(screen(), /❯ 写第二章，继续/, '补完的内容照常回显');
  stdin.write('\r');
  await tick();
  assert.deepEqual(submitted, ['写第二章，继续']);

  renderer.close();
  reader.stop();
});

test('MinTTY：给出一次性提示并走非交互分支，不消费输入', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const stderr = makeSink();
  const submitted = [];
  const reader = createInputReader({
    stdin,
    stdout,
    stderr,
    env: { TERM_PROGRAM: 'mintty' },
    onSubmit: (text) => submitted.push(text),
    onControl: () => {},
  });

  const status = reader.start();
  assert.equal(status.interactive, false);
  assert.equal(status.reason, 'mintty');
  assert.ok(stderr.text().includes('Windows Terminal') || stderr.text().includes('winpty'));
  assert.match(stderr.text(), /[\u4e00-\u9fff]/);

  stdin.write('写第一章\r');
  await tick();
  assert.deepEqual(submitted, [], '非交互分支不消费输入');
  reader.stop();
});

test('没有可用输入流时如实报告，不抛错', () => {
  const reader = createInputReader({ stdin: null, stdout: makeSink(), env: {}, onSubmit: () => {} });
  const status = reader.start();
  assert.equal(status.interactive, false);
  assert.equal(status.reason, 'no-stdin');
  assert.doesNotThrow(() => reader.stop());
});

test('缺少 stderr 时 MinTTY 提示退回到 stdout，绝不影响其它输出', () => {
  const stdout = makeSink({ tty: true });
  const reader = createInputReader({
    stdin: makeFakeTTY(),
    stdout,
    env: { TERM_PROGRAM: 'mintty' },
    onSubmit: () => {},
  });
  reader.start();
  assert.ok(stdout.text().includes('Windows Terminal') || stdout.text().includes('winpty'));
  reader.stop();
});

test('isInteractiveTerminal：TTY + stdout 也是 TTY + 非 MinTTY 才算可交互', () => {
  const stdin = makeFakeTTY();
  const ttyOut = makeSink({ tty: true });

  assert.equal(isInteractiveTerminal({ stdin, stdout: ttyOut, env: {} }), true);
  assert.equal(isInteractiveTerminal({ stdin, stdout: makeSink(), env: {} }), false, 'stdout 不是 TTY');
  assert.equal(isInteractiveTerminal({ stdin: null, stdout: ttyOut, env: {} }), false, '没有输入流');
  assert.equal(
    isInteractiveTerminal({ stdin, stdout: ttyOut, env: { TERM_PROGRAM: 'mintty' } }),
    false,
    'MinTTY 不算可交互',
  );
});

test('readOneLine：读一行就收手；box=true 时这一行也被上下两条线框住', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });

  const pending = readOneLine({ stdin, stdout, env: { NO_COLOR: '1' }, box: true });
  await tick();
  stdin.write('sk-value\r');

  assert.equal(await pending, 'sk-value');
  const screen = screenText(stdout.text(), { cols: 80, rows: 20 });
  assert.match(screen, /─{20,}\n❯ sk-value\n\s*─{20,}$/, '引导页问 Key 的那一行也框在两条线里');
});

test('readOneLine：回车得到空串（调用方据此「跳过」），输入结束得到 null', async () => {
  const empty = await (async () => {
    const stdin = makeFakeTTY();
    const pending = readOneLine({ stdin, stdout: makeSink({ tty: true }), env: {} });
    await tick();
    stdin.write('\r');
    return pending;
  })();
  assert.equal(empty, '', '空行是合法结果——引导页的「回车跳过」靠它');

  const ended = await (async () => {
    const stdin = makeFakeTTY();
    const pending = readOneLine({ stdin, stdout: makeSink({ tty: true }), env: {} });
    await tick();
    stdin.end();
    return pending;
  })();
  assert.equal(ended, null, '输入结束如实报告，不假装用户输入了空串');
});

test('回车之后：框收成一条下框线留在原地，下一个框画在输出下面', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submitted = [];
  const reader = createInputReader({ stdin, stdout, env: { NO_COLOR: '1' }, onSubmit: (text) => submitted.push(text) });
  reader.start();
  const screen = () => screenText(stdout.text(), { cols: 80, rows: 40 });

  stdin.write('写第一章\n');
  await tick();
  assert.deepEqual(submitted, ['写第一章']);
  // 交出去的那一行被两条线夹住收在 scrollback 里，下面紧跟新一框（它的上框线本来就是分隔）。
  assert.match(screen(), /^\s*─{20,}\n❯ 写第一章\n\s*─{20,}\n\s*─{20,}\n❯ *\n\s*─{20,}$/, '上一行被框住 → 新框紧跟其后');

  reader.stop();
});

test('位置参数：像用户亲手敲的一样填进输入框并提交（屏幕上也是同一个框）', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submitted = [];
  const reader = createInputReader({ stdin, stdout, env: { NO_COLOR: '1' }, onSubmit: (text) => submitted.push(text) });

  reader.start({ initialText: '写第一章' });
  await tick();

  assert.deepEqual(submitted, ['写第一章'], '启动即提交（不必等用户敲）');
  assert.match(
    screenText(stdout.text(), { cols: 80, rows: 30 }),
    /❯ 写第一章\n\s*─{20,}/,
    '屏幕上就是一行被框住的用户行，没有「另打一行」的痕迹',
  );

  reader.stop();
});

test('实时区可以有两行：框被顶到第三行，换回一行时不留残影（擦除按行数上移）', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const reader = createInputReader({ stdin, stdout, env: { NO_COLOR: '1' }, onSubmit: () => {} });
  reader.start();
  await tick();
  const screen = () => screenText(stdout.text(), { cols: 80, rows: 40 });

  // 思考预览那种两行实时区：`思考中 · <首行>` + 缩进对齐的续行
  reader.composer.setLive(['思考中 · 主角为什么不肯离开', `${' '.repeat(9)}这里需要一个转折`].join('\n'));
  await tick();
  assert.match(
    screen(),
    /^思考中 · 主角为什么不肯离开\n\s+这里需要一个转折\n\s*─{20,}\n❯ *\n\s*─{20,}$/,
    '两行实时状态都贴在框上方，框整体下移',
  );

  // 收成一行状态：上移的格数必须跟着变，否则会留下上一份的第二行
  reader.composer.setLive('思考中');
  await tick();
  assert.match(screen(), /^思考中\n\s*─{20,}\n❯ *\n\s*─{20,}$/, '换回一行时旧的第二行不残留');

  reader.composer.setLive(null);
  await tick();
  assert.match(screen(), /^\s*─{20,}\n❯ *\n\s*─{20,}$/, '收走实时区之后只剩框本身');

  reader.stop();
});

test('setLive 收到与屏幕上相同的一份时不重绘（思考预览会推得很密）', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const reader = createInputReader({ stdin, stdout, env: { NO_COLOR: '1' }, onSubmit: () => {} });
  reader.start();
  await tick();

  reader.composer.setLive('思考中');
  await tick();
  const writes = stdout.chunks.length;
  reader.composer.setLive('思考中');
  await tick();
  assert.equal(stdout.chunks.length, writes, '同一份内容不产生任何写出');

  reader.stop();
});

test('超宽实时行：擦除按实测物理行数上移，不把折出来的行留在屏上（报告 5/7 残留族）', async () => {
  // 输入层不再信任调用方「每行都不超宽」的约定：超宽行会被终端自动折行，
  // 只按 \n 数行会少算物理行数，\x1b[0J 从块中间开抹就留下一截擦不掉的实时区。
  // 这条保证现在属于输入层自己（实测「剥色后显示宽度 ÷ 列数」）——
  // 就算调用方漏截宽，最多难看，不会再残留。
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const reader = createInputReader({ stdin, stdout, env: { NO_COLOR: '1' }, onSubmit: () => {} });
  reader.start();
  await tick();
  const screen = () => screenText(stdout.text(), { cols: 80, rows: 40 });

  // 一行 200 列（80 列终端折成 3 格物理行），没有换行符——旧实现按 1 行算
  reader.composer.setLive('超'.repeat(100));
  await tick();

  const before = stdout.chunks.length;
  reader.composer.takeArea();
  const seq = stdout.chunks.slice(before).join('');
  assert.match(seq, /\r\x1b\[4A\x1b\[0J/, `擦除应上移「实时 3 行 + 光标行 1」= 4 格，实际：${JSON.stringify(seq)}`);
  assert.doesNotMatch(screen(), /超超超/, '实时区折出来的任何一行都不该残留在画面上');

  reader.stop();
  stdin.end();
});

test('超宽实时行带颜色码：量测剥掉 SGR 再算宽度，颜色码不占列', async () => {
  // 渲染器传给 composer 的是上色后的文本：SGR 码本身不占列，
  // 实测必须先剥色再量显示宽度，否则颜色码会被当成可见字符多算行数。
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: () => {} });
  reader.start();
  await tick();

  reader.composer.setLive(`\x1b[2m${'超'.repeat(100)}\x1b[0m`);
  await tick();

  const before = stdout.chunks.length;
  reader.composer.takeArea();
  const seq = stdout.chunks.slice(before).join('');
  assert.match(seq, /\r\x1b\[4A\x1b\[0J/, `剥色后同样应上移 4 格，实际：${JSON.stringify(seq)}`);

  reader.stop();
  stdin.end();
});

test('start 之前渲染器直写的动态行：start 后不得残留在框的上方（Task 7 deferred）', async () => {
  // 渲染器带 composer 创建、但输入层还没 start 时，旧实现退回「管道式直写」，
  // 动态行直接落在屏幕上；start 之后框画在它下面，composer 时代的擦除只覆盖
  // composer 认识的实时区——start 前那一行永久残留（观感残留族，不影响提交内容）。
  // 修复后渲染器在 composer 存在时绝不直写动态行，这条用例断端到端画面。
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const reader = createInputReader({ stdin, stdout, env: { NO_COLOR: '1' }, onSubmit: () => {} });
  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' }, composer: reader.composer, scheduleTick: noopScheduleTick });

  renderer.printStatus('思考中', { final: false }); // start 之前到达的动态行
  reader.start();
  await tick();
  const screen = () => screenText(stdout.text(), { cols: 80, rows: 40 });
  assert.match(screen(), /^\s*─{20,}\n❯ *\n\s*─{20,}$/, '框本身照常画出来');

  renderer.printStatus('搜索文件', { final: false }); // start 之后：composer 协议
  await tick();
  assert.match(screen(), /^⠋ 搜索文件\n\s*─{20,}\n❯ *\n\s*─{20,}$/, '当前动态行贴在框上方（运行态带帧字符）');
  assert.doesNotMatch(screen(), /思考中/, 'start 前的动态行不得残留在画面上');

  reader.stop();
  stdin.end();
});

test('让位持有计数：嵌套让位只在最外层动终端（缺陷猎捕报告 4）', async () => {
  const calls = [];
  const fakeInput = {
    suspend: () => calls.push('suspend'),
    resume: () => calls.push('resume'),
  };
  const { withInputSuspended } = createInputYielder({ input: fakeInput });
  const order = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  // /model 向导让位期间，权限确认卡又到达一次：嵌套的 withInputSuspended。
  await withInputSuspended(async () => {
    order.push('outer-begin');
    const inner = withInputSuspended(async () => {
      order.push('inner-begin');
      await tick();
      order.push('inner-end');
    });
    await tick();
    await inner;
    order.push('outer-end');
  });

  // 内层既不 suspend（幂等无所谓）也不 resume（resume 不幂等——会真建第二个 readline）。
  assert.deepEqual(calls, ['suspend', 'resume']);
  assert.deepEqual(order, ['outer-begin', 'inner-begin', 'inner-end', 'outer-end']);
});

test('让位持有计数：内层抛错也不多还、不早还终端', async () => {
  const calls = [];
  const fakeInput = {
    suspend: () => calls.push('suspend'),
    resume: () => calls.push('resume'),
  };
  const { withInputSuspended } = createInputYielder({ input: fakeInput });
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  await withInputSuspended(async () => {
    await assert.rejects(
      () => withInputSuspended(async () => {
        await tick();
        throw new Error('内层失败');
      }),
      /内层失败/,
    );
    assert.deepEqual(calls, ['suspend'], '内层失败时不许把终端还给常驻输入');
  });
  assert.deepEqual(calls, ['suspend', 'resume']);
});

test('非交互（管道）：不画任何框线，也不多写换行', async () => {
  const stdin = new PassThrough();
  const stdout = makeSink();
  const submitted = [];
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: (text) => submitted.push(text) });
  reader.start();

  stdin.write('写第一章\n');
  await tick();

  assert.deepEqual(submitted, ['写第一章']);
  assert.equal(stdout.text().includes('─'), false, '管道里一条线都不该有');
  assert.equal(stdout.text().includes('❯'), false, '管道里也不画提示符');

  reader.stop();
});

test('suspend/resume 承接半行草稿：光标在行尾时原样接回（缺陷猎捕报告 3）', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submitted = [];
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: (text) => submitted.push(text) });
  reader.start();
  await tick();

  stdin.write('我正在写');
  await tick();
  // 权限确认卡到达：让位（草稿此刻必须被带走，而不是随 readline 一起销毁）
  reader.suspend();
  reader.resume();
  await tick();

  // 恢复后继续敲剩下的半句、回车：提交的必须是完整一行
  stdin.write('到一半');
  await tick();
  stdin.write('\r');
  await tick();

  assert.deepEqual(submitted, ['我正在写到一半']);
  assert.match(stdout.text(), /我正在写/, '恢复后的屏幕上要能看到接回来的草稿');
  reader.stop();
  stdin.end();
});

test('suspend/resume 承接半行草稿：光标停在行中时回到原位（缺陷猎捕报告 3）', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submitted = [];
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: (text) => submitted.push(text) });
  reader.start();
  await tick();

  stdin.write('我正在写');
  await tick();
  stdin.write('\x1b[D\x1b[D'); // 光标左移两格：停在「正」与「在」之间
  await tick();

  reader.suspend();
  reader.resume();
  await tick();

  stdin.write('到一半');
  await tick();
  stdin.write('\r');
  await tick();

  // 草稿与光标位置一起恢复：新字插在中间，而不是被挤到行尾
  assert.deepEqual(submitted, ['我正到一半在写']);
  reader.stop();
  stdin.end();
});

test('长输入折行后，擦除按物理行数上移，不把输入行留一半在屏上（缺陷猎捕报告 5）', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: () => {} });
  reader.start();
  await tick();

  // 提示符 2 列 + 80 列汉字 = 82 列 → 在 80 列终端折成 2 格物理行
  stdin.write('汉'.repeat(40));
  await tick();

  const before = stdout.chunks.length;
  reader.composer.takeArea(); // 渲染器写 scrollback 前让位：这里触发 eraseArea
  const seq = stdout.chunks.slice(before).join('');
  // 擦除要上移「实时行 0 + 输入物理行 2」= 2 格；旧实现写死 1，\x1b[0J 从块中间开抹，
  // 重复的输入行与游离框线会永久留在屏幕上。
  assert.match(seq, /\r\x1b\[2A\x1b\[0J/, `擦除序列应为上移 2 格，实际：${JSON.stringify(seq)}`);

  reader.stop();
  stdin.end();
});

test('未折行的短输入，擦除仍上移 1 格（回归：折行修复不得影响常规路径）', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: () => {} });
  reader.start();
  await tick();

  stdin.write('写第一章');
  await tick();

  const before = stdout.chunks.length;
  reader.composer.takeArea();
  const seq = stdout.chunks.slice(before).join('');
  assert.match(seq, /\r\x1b\[1A\x1b\[0J/, `擦除序列应为上移 1 格，实际：${JSON.stringify(seq)}`);

  reader.stop();
  stdin.end();
});

test('折行输入且光标在行中时，下框线画在最后一格物理行之下，不压住正文（复核新发现）', async () => {
  // 输入折成 2 格物理行、光标在第 1 格（Ctrl+A 回行首）时，readline 重绘后光标停在
  // 第 1 格——paintBelowPrompt 若直接「\r\n 画线」，框线会画在正文第 2 格上，把字盖掉。
  // 与猎捕报告 5 同族（擦除侧修了，补线侧当时不在报告范围内）。
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: () => {} });
  reader.start();
  await tick();

  stdin.write('汉'.repeat(40)); // 82 列 → 2 格物理行
  await tick();
  stdin.write('\x01'); // Ctrl+A：光标回行首（第 1 格物理行）
  await tick();

  const before = stdout.chunks.length;
  reader.composer.setLive('思考中'); // 触发重画 → readline 重绘 → 补下框线
  const seq = stdout.chunks.slice(before).join('');

  // 补线前先下移 1 格到输入行的最后一格物理行；回程上移 2 格（而非写死 1 格）回到光标行。
  assert.match(seq, /\r\x1b\[1B\r\n/, `补线前应先下移 1 格，实际：${JSON.stringify(seq)}`);
  assert.match(seq, /\r\x1b\[2A\x1b\[\d+G/, `补线后应上移 2 格回到光标行，实际：${JSON.stringify(seq)}`);

  reader.stop();
  stdin.end();
});

test('连续打字折行时下框线跟着走：快速回显不重绘也不许把框线顶穿（真机 ConPTY 走查发现）', async () => {
  // readline 的「行尾追加」快速路径逐字回显、不经过 _refreshLine：正文折上新物理行时
  // 下框线还留在旧位置——正文把框线残段顶得和正文挤在同一行，回车后这帧永久留在滚动
  // 历史。输入层在快速回显的出口上按行数变化补线：行数没变一个字节都不动；变了先清
  // 残段再按新几何画线。退格（缩回方向）走整行重绘，由既有刷新路径自愈，不在此列。
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const reader = createInputReader({ stdin, stdout, env: { NO_COLOR: '1' }, onSubmit: () => {} });
  reader.start();
  await tick();
  const lines = () => screenText(stdout.text(), { cols: 80, rows: 40 }).split('\n');

  stdin.write('汉'.repeat(40)); // 提示符 2 列 + 80 列 → 第 40 个字把正文折上第 2 格物理行
  await tick();

  let rows = lines();
  assert.ok(rows.every((line) => !(line.includes('汉') && line.includes('─'))),
    `正文与旧框线残段不得挤在同一行：${JSON.stringify(rows)}`);
  const lastTextRow = rows.reduce((found, line, index) => (line.includes('汉') ? index : found), -1);
  assert.match(rows[lastTextRow + 1] ?? '', /^\s*─+$/, '下框线必须紧跟最后一格物理行');

  stdin.write('灯'); // 再补一个字：框线跟着挪，依旧干净
  await tick();
  rows = lines();
  assert.ok(rows.every((line) => !(line.includes('灯') && line.includes('─'))),
    `补字后正文与框线残段不得挤在同一行：${JSON.stringify(rows)}`);

  stdin.write('\x7f\x7f'); // 退格缩回 1 格物理行：框线回到上一格之下，不许残留第二条框线
  await tick();
  rows = lines();
  const ruleRows = rows.filter((line) => /^\s*─+\s*$/.test(line)).length;
  const textRows = rows.filter((line) => line.includes('汉')).length;
  assert.equal(textRows, 1, `缩回后正文只剩一格物理行：${JSON.stringify(rows)}`);
  assert.equal(ruleRows, 2, `上下各一条框线，不得多残一条：${JSON.stringify(rows)}`);

  reader.stop();
  stdin.end();
});

test('折行粘贴后光标回行首再补字：旧帧不残留，下框线紧贴最后一行（真机 ConPTY 缺陷回归）', async () => {
  // readline 的「行尾追加」快速路径会把整段粘贴直接回显到屏幕（不经过 _refreshLine），
  // 真实光标随折行下沉而行模型不知情；Ctrl+A 把模型光标拉回行首后，下一次重绘从块中
  // 起画——旧物理行残留在上方、下框线漂移。真机 ConPTY 抓包定位，修复 = 重绘前按真实
  // 光标行锚定块顶。本用例在假 TTY 上走同一条 readline 代码路径钉住最终画面。
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: () => {} });
  reader.start();
  await tick();

  stdin.write('啊'.repeat(118)); // 提示符 2 列 + 236 列 = 238 → 80 列下折 3 格物理行
  await tick();
  stdin.write('\x01'); // Ctrl+A：光标回行首
  await tick();
  stdin.write('xyz'); // 行首插入：整行再重画一次
  await tick();

  const lines = screenText(stdout.text(), { cols: 80, rows: 40 }).split('\n');
  const promptLines = lines.filter((line) => line.includes('❯'));
  assert.equal(promptLines.length, 1, `屏幕上只能有一帧输入行，实际 ${promptLines.length} 帧：\n${lines.join('\n')}`);
  assert.ok(promptLines[0].startsWith('❯ xyz'), `行首插入的 xyz 应出现在输入行首，实际：${JSON.stringify(promptLines[0])}`);

  // 下框线必须紧贴最后一个非空行（中间不得隔着残留行或空行）
  const linesTrimmed = lines.map((line) => line.trim());
  const lastRuleIndex = linesTrimmed.reduce((found, line, index) => (/^─+$/.test(line) ? index : found), -1);
  assert.ok(lastRuleIndex > 0, '屏幕上应有下框线');
  const aboveRule = lines[lastRuleIndex - 1].trim();
  assert.ok(aboveRule !== '', `下框线的上一行应为输入内容，实际为空行：\n${lines.join('\n')}`);

  reader.stop();
  stdin.end();
});

test('Ctrl+S：立即提交当前草稿——onSubmit 带 immediate 标记、草稿清空、空框画回', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submissions = [];
  const reader = createInputReader({
    stdin, stdout, env: {},
    onSubmit: (text, options) => submissions.push([text, options]),
  });
  reader.start();
  try {
    stdin.write('写第一章');
    await tick();
    stdin.write('\x13');
    await tick();
    assert.deepEqual(submissions, [['写第一章', { immediate: true }]],
      'Ctrl+S 原样上交草稿与立即标记');
    const screen = screenText(stdout.text());
    assert.ok(!screen.includes('\x13'), '拦截必须发生在 readline 消费之前：\x13 不进草稿');
    assert.match(screen, /❯ 写第一章\n\s*─{20,}\n\s*─{20,}\n❯ *\n\s*─{20,}$/,
      '旧行留在历史里，新框照常画回');
  } finally {
    reader.stop();
  }
});

test('Ctrl+S：空白草稿无操作——不提交、一个字节都不写', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submissions = [];
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: (text) => submissions.push(text) });
  reader.start();
  try {
    stdin.write('   ');
    await tick();
    const before = stdout.text();
    stdin.write('\x13');
    await tick();
    assert.deepEqual(submissions, [], '空白草稿不触发提交');
    assert.equal(stdout.text(), before, '空判先于一切：屏幕纹丝不动');
  } finally {
    reader.stop();
  }
});

test('Ctrl+S：光标在行中时整行原样提交（先到行尾再接受，与回车同状态）', async () => {
  const stdin = makeFakeTTY();
  const stdout = makeSink({ tty: true });
  const submissions = [];
  const reader = createInputReader({ stdin, stdout, env: {}, onSubmit: (text) => submissions.push(text) });
  reader.start();
  try {
    stdin.write('写第一章啊');
    await tick();
    stdin.write('\x01'); // Ctrl+A：光标回行首
    await tick();
    stdin.write('\x13');
    await tick();
    assert.deepEqual(submissions, ['写第一章啊'], '整行原文提交，不留半截残段');
    const lines = screenText(stdout.text(), { cols: 80, rows: 40 }).split('\n');
    const promptLines = lines.filter((line) => line.includes('❯ 写'));
    assert.equal(promptLines.filter((line) => line.trim() !== '❯ 写第一章啊').length, 0,
      `历史里那行必须完整：${JSON.stringify(lines)}`);
  } finally {
    reader.stop();
  }
});
