// 版本号测试：单一来源、显示位置、以及「看完就走」的无副作用承诺。
//
// 为什么值得单独测：
//   1. 版本号在 package.json 与 src/version.mjs 各存一份（避免 import JSON 的语法差异），
//      两者必须一致——这里就是那个防漂移的闸门；
//   2. --version 被启动器脚本用来「更新之后读版本」，它必须零副作用：
//      不建会话、不写私有目录、不碰创作目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { APP_NAME, VERSION, versionLine } from '../src/version.mjs';
import { USAGE_TEXT } from '../src/cli/args.mjs';
import { main } from '../src/cli.mjs';

const CLI_ROOT = path.resolve(import.meta.dirname, '..');

// 收集输出的假 io；stdin 故意留空，验证 --version 不会去碰输入。
function fakeIo({ env = {}, cwd = CLI_ROOT } = {}) {
  const out = [];
  const err = [];
  return {
    io: {
      stdin: null,
      stdout: { write: (text) => { out.push(text); return true; } },
      stderr: { write: (text) => { err.push(text); return true; } },
      env,
      cwd,
    },
    text: () => out.join(''),
    errors: () => err.join(''),
  };
}

test('版本号与 package.json 一致（单一来源防漂移）', async () => {
  const raw = await fs.readFile(path.join(CLI_ROOT, 'package.json'), 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(VERSION, manifest.version, 'src/version.mjs 的 VERSION 必须等于 package.json 的 version');
  assert.equal(APP_NAME, 'WWriting');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/, '版本号应为三段式语义化版本');
});

test('versionLine 是「名称 空格 版本」的一行', () => {
  assert.equal(versionLine(), `${APP_NAME} ${VERSION}`);
  assert.equal(versionLine(), 'WWriting 0.1.0');
});

test('--version 打印版本、退出码 0、stderr 干净', async () => {
  const io = fakeIo();
  const code = await main(['--version'], io.io);
  assert.equal(code, 0);
  assert.equal(io.text().trim(), versionLine());
  assert.equal(io.errors(), '');
});

test('-v 与 --version 等价', async () => {
  const io = fakeIo();
  assert.equal(await main(['-v'], io.io), 0);
  assert.equal(io.text().trim(), versionLine());
});

test('--version 零副作用：不建会话、不写私有 APPDATA、不动创作目录', async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wwriting-version-appdata-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wwriting-version-cwd-'));
  try {
    const io = fakeIo({ env: { APPDATA: appDataRoot }, cwd: workspace });
    assert.equal(await main(['--version'], io.io), 0);

    // 私有目录里一个字节都不该多出来（组合根根本没被装配）。
    assert.deepEqual(await fs.readdir(appDataRoot), [], 'APPDATA 不应被写入');
    // 创作目录同样保持原样，不会冒出 WWRITING.md 之类的东西。
    assert.deepEqual(await fs.readdir(workspace), [], '创作目录不应被写入');
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('--version 与其它参数同给时不报互斥错误（看完就走，优先级同 --help）', async () => {
  const io = fakeIo();
  const code = await main(['--version', '--resume', 's-001'], io.io);
  assert.equal(code, 0);
  assert.equal(io.text().trim(), versionLine());
});

test('--help 的第一行带版本号', () => {
  assert.match(USAGE_TEXT, new RegExp(`^${APP_NAME} ${VERSION.replace(/\./g, '\\.')}`));
  assert.ok(USAGE_TEXT.includes('--version'), '帮助里应列出 --version');
});
