#!/usr/bin/env node
// 在一个**真实 node 进程**里跑真实组合根（mode=main）或真实会话模块（mode=session），
// 把结果以一行 JSON 打到 stdout，然后立刻退出。
//
// 存在的理由：同进程内第二次调用 main() 覆盖不到「模块级缓存、残留文件句柄、跨进程会话锁」
// 这三样东西；只有真进程退出、再起第二个真进程，才能钉住「进程 A 真写入 → 真退出 →
// 进程 B --continue 读回历史」这条路径（Task 8 评审的 Important）。
//
//   mode=main    ：真实 main()（真组合根、真事件日志、真会话锁、真文件工具），注入伪 TTY 驱动对话；
//                  模型走真实 HTTP，由调用方起一个本地假 DeepSeek 服务。验收测试用。
//   mode=session ：只用真实 workspace/session 模块打开会话（openLatest 即 --continue 的选会话语义）、
//                  写入输入、读回事件日志里的输入历史。冒烟脚本用——它起不了模型服务。
//
// 用法：node run-cli-once.mjs '<JSON spec>'   或   node run-cli-once.mjs <spec.json>
// spec: { mode, appDataRoot, cwd, argv, lines, write, settleMs, deadlineMs }
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

const settleMs = 20;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readSpec(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  // PowerShell 的 Set-Content -Encoding UTF8 会带 BOM，JSON.parse 前先剥掉。
  const text = raw.trim().replace(/^\uFEFF/, '');
  return text.startsWith('{') ? JSON.parse(text) : null;
}

const arg = process.argv[2] ?? '';
const inlineSpec = readSpec(arg);
const spec = inlineSpec ?? JSON.parse((await readFile(arg, 'utf8')).replace(/^\uFEFF/, ''));
const mode = spec.mode ?? 'main';

// 结果只走真实 stdout（main() 的输出全被内存 sink 接住，不会混进来）。
// 屏幕/错误必须**实时**读 sink：waitFor 在写下一行之前就要看到当前屏幕。
let screenSource = null;
let stderrSource = null;
const screenText = () => (screenSource === null ? '' : screenSource.text());
const stderrText = () => (stderrSource === null ? '' : stderrSource.text());

function writeLine(payload) {
  const text = `${JSON.stringify({
    pid: process.pid,
    mode,
    screen: screenText(),
    stderr: stderrText(),
    ...payload,
  })}\n`;
  return new Promise((resolve) => { process.stdout.write(text, resolve); });
}

async function waitFor(needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (screenText().includes(needle)) return;
    if (Date.now() > deadline) throw new Error(`等待「${needle}」超时；屏幕：${screenText()}`);
    await wait(settleMs);
  }
}

// 伪 TTY：readline 需要 isTTY / setRawMode，才会给出与真实终端一致的回显与 Ctrl+C 行为。
function makeFakeTTY() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  stream.isRaw = false;
  stream.setRawMode = () => {};
  return stream;
}

// 内存输出：readline 在 terminal 模式下会监听 output 的事件，所以用真流当外壳、只替换 write。
function makeSink() {
  const stream = new PassThrough();
  const chunks = [];
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  stream.write = (text) => { chunks.push(String(text)); return true; };
  stream.text = () => chunks.join('');
  return stream;
}

// 一次真实 main()：按 spec.lines 逐步驱动（每步等屏幕出现标记再写下一行，不靠固定 sleep 猜时序）。
async function runMain() {
  const { main } = await import('../../../src/cli.mjs');
  const stdin = makeFakeTTY();
  const stdout = makeSink();
  const stderr = makeSink();
  screenSource = stdout;
  stderrSource = stderr;
  const done = main(spec.argv ?? [], {
    stdin,
    stdout,
    stderr,
    env: { APPDATA: spec.appDataRoot, NO_COLOR: '1' },
    cwd: spec.cwd,
  });
  for (const step of spec.lines ?? []) {
    if (step.await) await waitFor(step.await, step.timeoutMs ?? 20000);
    stdin.write(step.text);
    await wait(settleMs);
  }
  const code = await done;
  return { code };
}

// 一次真实会话读写：openLatest（== --continue）→ 可选写入一条输入 → 释放锁 → 读回事件日志。
async function runSession() {
  const { createWorkspaceStore } = await import('../../../src/storage/workspace-store.mjs');
  const { createSessionManager } = await import('../../../src/session/session-manager.mjs');
  const manager = createSessionManager({
    workspaceStore: createWorkspaceStore({ appDataRoot: spec.appDataRoot }),
  });
  const handle = await manager.openLatest(spec.cwd);
  const sessionId = handle.sessionId;
  const logPath = path.join(handle.directory, 'events.jsonl');
  if (typeof spec.write === 'string' && spec.write !== '') {
    await handle.submit({ text: spec.write });
  }
  // 退出前释放写锁：第二个进程能不能打开，就是「锁真的放了吗」的证据。
  await handle.close();
  const events = (await readFile(logPath, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  return {
    sessionId,
    inputs: events
      .filter((event) => event.type === 'input_submitted' || event.type === 'input_queued')
      .map((event) => event.data.text),
    eventTypes: events.map((event) => event.type),
  };
}

// 看门狗：真进程万一挂着，也要给调用方一个可判定的结果，而不是无限等待。
const watchdog = setTimeout(() => {
  void writeLine({ code: null, error: 'driver 等待超时' }).then(() => process.exit(1));
}, Number.isInteger(spec.deadlineMs) ? spec.deadlineMs : 30000);

try {
  const result = mode === 'session' ? await runSession() : await runMain();
  clearTimeout(watchdog);
  await writeLine(result);
  process.exit(0);
} catch (error) {
  clearTimeout(watchdog);
  await writeLine({ code: null, error: String(error?.message ?? error) });
  process.exit(1);
}
