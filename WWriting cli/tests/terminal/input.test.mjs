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
  assert.match(screen(), /^\s+─{20,}\n❯ *\n\s+─{20,}$/, '空框长这样：上框线 / ❯ / 下框线');

  // 用户先键入一半，还没回车
  stdin.write('写第二章');
  await tick();
  assert.match(screen(), /^\s+─{20,}\n❯ 写第二章\n\s+─{20,}$/, '键入的内容写在框里，框也跟着重画');

  const renderer = createRenderer({ stdout, env: { NO_COLOR: '1' }, composer: reader.composer });
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
  assert.match(shown, /\n❯ 写第二章\n\s+─{20,}$/, '框仍然收在屏幕最下方');

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
  assert.match(screen, /─{20,}\n❯ sk-value\n\s+─{20,}$/, '引导页问 Key 的那一行也框在两条线里');
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
  assert.match(screen(), /^\s+─{20,}\n❯ 写第一章\n\s+─{20,}\n\s+─{20,}\n❯ *\n\s+─{20,}$/, '上一行被框住 → 新框紧跟其后');

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
    /❯ 写第一章\n\s+─{20,}/,
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
    /^思考中 · 主角为什么不肯离开\n\s+这里需要一个转折\n\s+─{20,}\n❯ *\n\s+─{20,}$/,
    '两行实时状态都贴在框上方，框整体下移',
  );

  // 收成一行状态：上移的格数必须跟着变，否则会留下上一份的第二行
  reader.composer.setLive('思考中');
  await tick();
  assert.match(screen(), /^思考中\n\s+─{20,}\n❯ *\n\s+─{20,}$/, '换回一行时旧的第二行不残留');

  reader.composer.setLive(null);
  await tick();
  assert.match(screen(), /^\s+─{20,}\n❯ *\n\s+─{20,}$/, '收走实时区之后只剩框本身');

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
