// 启动参数测试：默认目录、--cwd 绝对化、位置消息、--resume、互斥参数与未知参数错误。
// 错误断言的核心：必须是中文人话，绝不打印 Node 堆栈。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArgsError, USAGE_TEXT, parseArgs } from '../../src/cli/args.mjs';
import { main } from '../../src/cli.mjs';

// 测试基准目录（绝对路径），避免依赖运行位置。
const BASE = path.resolve(process.cwd(), 'test-base');

// 构造可注入的 io：stdout/stderr 收集到数组，便于断言输出内容。
// env 可覆盖（组合根装配起来之后，main 会往 APPDATA 里放私有数据，测试必须给它一个临时目录）。
function fakeIo({ env = {} } = {}) {
  const out = [];
  const err = [];
  const io = {
    stdin: null,
    stdout: { write: (text) => { out.push(text); return true; } },
    stderr: { write: (text) => { err.push(text); return true; } },
    env,
    cwd: BASE,
  };
  return { io, out, err };
}

// 临时 APPDATA：应用私有数据只允许落在这里，测试结束后删掉。
async function withTempAppData(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wwriting-cli-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// 断言错误信息是中文人话：含汉字、不含堆栈帧、不带 "Error:" 前缀。
function assertChineseHumanMessage(text) {
  assert.match(text, /[\u4e00-\u9fff]/, '错误信息应为简体中文');
  assert.doesNotMatch(text, /\n?\s+at /, '错误信息不应包含 Node 堆栈');
  assert.doesNotMatch(text, /^Error:/, '错误信息不应带 Error: 前缀');
}

// —— 启动语义（P23：对齐 claude -c）——
// 反转前：不带参数 = 继续最近会话。反转后：不带参数 = 开一个全新会话。
// 为什么改：启动脚本双击出来的窗口默认应该是全新对话；「接着上次」是一个**显式**的选择，
// 该由 -c 表达，而不是由「什么都没写」表达。什么都不写被当成「接着上次」，
// 会让用户在不知情的情况下续上一个几个月前的会话。

test('不带参数 = 开一个全新会话', () => {
  const parsed = parseArgs([], BASE);
  assert.equal(parsed.cwd, BASE);
  assert.equal(parsed.help, false);
  assert.deepEqual(
    { prompt: parsed.prompt, resume: parsed.resume, continueLatest: parsed.continueLatest },
    { prompt: null, resume: null, continueLatest: false },
  );
});

test('-c 与 --continue 都表示接着最近会话', () => {
  assert.equal(parseArgs(['-c'], '/novel').continueLatest, true);
  assert.equal(parseArgs(['--continue'], '/novel').continueLatest, true);
});

test('带一条消息 = 全新会话 + 首条输入', () => {
  const parsed = parseArgs(['写第一章'], '/novel');
  assert.deepEqual({ prompt: parsed.prompt, continueLatest: parsed.continueLatest },
    { prompt: '写第一章', continueLatest: false });
});

test('-c 与一条消息互斥：接着上次会话就不该再塞一条新输入', () => {
  assert.throws(() => parseArgs(['-c', '写第一章'], '/novel'), ArgsError);
  assert.throws(() => parseArgs(['写第一章', '-c'], '/novel'), ArgsError);
});

test('-c 与 --resume 互斥', () => {
  assert.throws(() => parseArgs(['-c', '--resume', 'abc123'], '/novel'), ArgsError);
});

test('--resume 仍然要一个会话 ID', () => {
  assert.equal(parseArgs(['--resume', 'abc123'], '/novel').resume, 'abc123');
  assert.throws(() => parseArgs(['--resume'], '/novel'), ArgsError);
  assert.throws(() => parseArgs(['--resume', '-c'], '/novel'), ArgsError);
});

test('--cwd 可与 -c 组合', () => {
  // 断言里用 path.resolve 而不是字面量：cwd 走的是 path.resolve 绝对化，在 Windows 上
  // `path.resolve('/', '/novel')` 是 `D:\novel` 而不是 `/novel`（与前一条 --cwd 用例同一套基准目录写法）。
  const parsed = parseArgs(['--cwd', 'novel', '-c'], BASE);
  assert.deepEqual(
    { cwd: parsed.cwd, continueLatest: parsed.continueLatest },
    { cwd: path.resolve(BASE, 'novel'), continueLatest: true },
  );
});

test('用法文本里写清了新的启动形式', () => {
  assert.match(USAGE_TEXT, /wwriting\s+开一个全新会话|wwriting\s+$/m);
  assert.match(USAGE_TEXT, /-c, --continue/);
});

test('省略基准目录时默认取 process.cwd()', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.cwd, process.cwd());
});

test('--cwd 相对路径按基准目录绝对化', () => {
  const parsed = parseArgs(['--cwd', 'novel'], BASE);
  assert.equal(parsed.cwd, path.resolve(BASE, 'novel'));
  assert.equal(path.isAbsolute(parsed.cwd), true);
});

test('--cwd 绝对路径原样保留', () => {
  const absolute = path.resolve(BASE, 'novel');
  const parsed = parseArgs(['--cwd', absolute], BASE);
  assert.equal(parsed.cwd, absolute);
});

test('位置消息：直接给消息即开始新会话', () => {
  const parsed = parseArgs(['写第一章'], BASE);
  assert.equal(parsed.prompt, '写第一章');
  assert.equal(parsed.resume, null);
  assert.equal(parsed.continueLatest, false);
});

test('--resume 记录会话 ID 且不视为继续最近会话', () => {
  const parsed = parseArgs(['--resume', 's-001'], BASE);
  assert.equal(parsed.resume, 's-001');
  assert.equal(parsed.prompt, null);
  assert.equal(parsed.continueLatest, false);
});

test('--continue 显式继续最近会话', () => {
  const parsed = parseArgs(['--continue'], BASE);
  assert.equal(parsed.continueLatest, true);
});

test('--cwd 可与其他参数组合', () => {
  const withResume = parseArgs(['--cwd', 'novel', '--resume', 's-001'], BASE);
  assert.equal(withResume.cwd, path.resolve(BASE, 'novel'));
  assert.equal(withResume.resume, 's-001');

  const withPrompt = parseArgs(['--cwd', 'novel', '写第一章'], BASE);
  assert.equal(withPrompt.cwd, path.resolve(BASE, 'novel'));
  assert.equal(withPrompt.prompt, '写第一章');
});

test('--help 标记为帮助', () => {
  const short = parseArgs(['-h'], BASE);
  const long = parseArgs(['--help'], BASE);
  assert.equal(short.help, true);
  assert.equal(long.help, true);
});

test('--version 标记为版本请求，且与 --resume 同给不触发互斥', () => {
  const short = parseArgs(['-v'], BASE);
  const long = parseArgs(['--version'], BASE);
  assert.equal(short.version, true);
  assert.equal(long.version, true);
  assert.equal(short.help, false);
  // 看完就走：与 --help 同级，跳过互斥检查（启动器脚本会这么用）。
  assert.equal(parseArgs(['--version', '--resume', 's-001'], BASE).version, true);
  assert.equal(parseArgs([], BASE).version, false);
});

test('--help / --version 优先于互斥检查：三个冲突参数一起给也只看帮助', () => {
  assert.equal(parseArgs(['-h', '-c', '写第一章'], '/novel').help, true);
  assert.equal(parseArgs(['-v', '--resume', 'abc', '-c'], '/novel').version, true);
});

test('互斥：消息与 --resume 不能同时给出', () => {
  assert.throws(() => parseArgs(['--resume', 's-001', '写第一章'], BASE), (error) => {
    assert.ok(error instanceof ArgsError);
    assertChineseHumanMessage(error.message);
    return true;
  });
});

test('互斥：消息与 --continue 不能同时给出', () => {
  assert.throws(() => parseArgs(['--continue', '写第一章'], BASE), (error) => {
    assert.ok(error instanceof ArgsError);
    assertChineseHumanMessage(error.message);
    return true;
  });
});

test('互斥：--resume 与 --continue 不能同时给出', () => {
  assert.throws(() => parseArgs(['--resume', 's-001', '--continue'], BASE), (error) => {
    assert.ok(error instanceof ArgsError);
    assertChineseHumanMessage(error.message);
    return true;
  });
});

test('未知参数报中文错误并指出该参数', () => {
  assert.throws(() => parseArgs(['--foo'], BASE), (error) => {
    assert.ok(error instanceof ArgsError);
    assert.ok(error.message.includes('--foo'), '错误信息应包含未知参数名');
    assertChineseHumanMessage(error.message);
    return true;
  });
});

test('--cwd 缺少目录值报中文错误', () => {
  assert.throws(() => parseArgs(['--cwd'], BASE), (error) => {
    assert.ok(error instanceof ArgsError);
    assertChineseHumanMessage(error.message);
    return true;
  });
});

test('--resume 缺少会话 ID 报中文错误', () => {
  assert.throws(() => parseArgs(['--resume'], BASE), (error) => {
    assert.ok(error instanceof ArgsError);
    assertChineseHumanMessage(error.message);
    return true;
  });
});

test('--resume 不得把后续参数名当作会话 ID 吞掉', () => {
  assert.throws(() => parseArgs(['--resume', '--continue'], BASE), (error) => {
    assert.ok(error instanceof ArgsError);
    assertChineseHumanMessage(error.message);
    return true;
  });
});

test('--cwd 不得把后续参数名当作目录吞掉', () => {
  assert.throws(() => parseArgs(['--cwd', '--resume', 's-001'], BASE), (error) => {
    assert.ok(error instanceof ArgsError);
    assertChineseHumanMessage(error.message);
    return true;
  });
});

test('--resume 与 --cwd 的空字符串值视为缺值报中文错误', () => {
  for (const argv of [['--resume', ''], ['--cwd', '']]) {
    assert.throws(() => parseArgs(argv, BASE), (error) => {
      assert.ok(error instanceof ArgsError);
      assertChineseHumanMessage(error.message);
      return true;
    });
  }
});

test('main：--resume 后跟参数名报中文错误并返回非零退出码', async () => {
  const { io, out, err } = fakeIo();
  const code = await main(['--resume', '--continue'], io);
  assert.equal(code, 2);
  assert.deepEqual(out, []);
  assert.equal(err.length, 1);
  assertChineseHumanMessage(err[0]);
});

test('多余的位置消息报中文错误', () => {
  assert.throws(() => parseArgs(['写第一章', '再写一段'], BASE), (error) => {
    assert.ok(error instanceof ArgsError);
    assertChineseHumanMessage(error.message);
    return true;
  });
});

test('main：--help 输出中文用法并返回 0，不启动 Agent', async () => {
  const { io, out, err } = fakeIo();
  const code = await main(['--help'], io);
  assert.equal(code, 0);
  const text = out.join('');
  assert.match(text, /启动形式/);
  assert.match(text, /--cwd/);
  assert.match(text, /--resume/);
  assert.match(text, /--continue/);
  assert.deepEqual(err, []);
});

test('main：互斥参数错误走 stderr，返回非零退出码且无堆栈', async () => {
  const { io, out, err } = fakeIo();
  const code = await main(['--resume', 's-001', '--continue'], io);
  assert.equal(code, 2);
  assert.deepEqual(out, []);
  assert.equal(err.length, 1);
  assertChineseHumanMessage(err[0]);
});

test('main：未知参数错误返回非零退出码且无堆栈', async () => {
  const { io, err } = fakeIo();
  const code = await main(['--foo'], io);
  assert.notEqual(code, 0);
  assert.equal(err.length, 1);
  assertChineseHumanMessage(err[0]);
});

// main() 现在是真正的组合根（Task 8）：没有可交互终端时不再「回显一行就返回 0」，
// 而是一条中文事实 + 非零退出码。Task 1 的 brief 已写明 io 注入就是「便于测试非 TTY 错误」。
// 这里使用临时 APPDATA，确保测试不会碰真实的应用私有目录。
test('main：没有可交互终端时给出一条中文事实并返回非零退出码', async () => {
  await withTempAppData(async (appDataRoot) => {
    const { io, out, err } = fakeIo({ env: { APPDATA: appDataRoot } });
    const code = await main([], io);
    assert.notEqual(code, 0);
    assert.notEqual(code, 2, '非交互不是参数错误');
    assert.deepEqual(out, [], '非交互错误不该往 stdout 写东西');
    assert.equal(err.length, 1);
    assertChineseHumanMessage(err[0]);
  });
});

test('main：位置消息与 --cwd 组合被接受，同样以非交互事实收场而不是参数错误', async () => {
  await withTempAppData(async (appDataRoot) => {
    const { io, err } = fakeIo({ env: { APPDATA: appDataRoot } });
    const code = await main(['--cwd', 'novel', '写第一章'], io);
    assert.notEqual(code, 0);
    assert.notEqual(code, 2, '参数本身合法，不该报参数错误');
    assert.equal(err.length, 1);
    assertChineseHumanMessage(err[0]);
  });
});
