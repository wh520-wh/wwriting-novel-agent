// 渲染测试共用替身：内存 stdout、composer 假实现（takeArea/giveArea/setLive 协议）、
// 渲染器工厂、事件桥的 feed、临时目录登记。composer 协议只在这里复刻一份——
// 协议变了改这一处，不再每个测试文件各抄一份。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { createRenderer } from '../../src/terminal/renderer.mjs';

const tempRoots = [];

export async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

export async function cleanupTempRoots() {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempRoots.length = 0;
}

// 内存 stdout：只收字符串，便于断言「屏幕上出现了什么」。
// guard 用来捕捉「composer 还占着光标行时渲染器直接写 stdout」——那正是会擦掉用户已键入内容的动作。
// columns 默认 undefined 而不是 80：既有渲染器测试全都跑在 undefined 上（proseRowWidth 兜到 77），
// 给个默认值会悄悄改掉它们的折行位置。要断折行的用例自己传。
export function makeStdout({ tty = false, guard = null, columns = undefined } = {}) {
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

export function assertNoColor(text) {
  assert.equal(COLOR_CODE.test(text), false, `NO_COLOR 下不该出现颜色码：${JSON.stringify(text)}`);
}

// 假 composer：模拟输入层那块输入区（上框线 / 提示符 / 下框线，可能还有一行实时状态）。
// occupied 表示「输入区正显示在屏幕上」；渲染器每次写出之前必须先 takeArea 把它擦掉，
// 写完再 giveArea 画回来。动态行走 setLive——它贴在框的上方，仍在输入区里，不需要让位。
export function makeFakeComposer(line = '') {
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

export function makeRenderer({ tty = false, color, env = {}, composer = null, columns = undefined } = {}) {
  const guard = composer
    ? () => composer.isActive() && composer.occupied
    : null;
  const stdout = makeStdout({ tty, guard, columns });
  const renderer = createRenderer({ stdout, color, env, composer });
  return { renderer, stdout };
}

export function feed(bridge, type, data = {}, extra = {}) {
  bridge.handleEvent({ type, data, ...extra });
}
