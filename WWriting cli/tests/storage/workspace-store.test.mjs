// 工作区私有存储测试：路径大小写规则、workspace ID 稳定性、目录布局与路径隔离。
// 全部使用 os.tmpdir() 下的临时目录，绝不触碰真实 %APPDATA%，也绝不在项目根生成 .wwriting。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  canonicalWorkspacePath,
  workspaceIdForPath,
  createWorkspaceStore,
  resolveAppDataRoot,
} from '../../src/storage/workspace-store.mjs';

// 临时目录登记：测试结束时统一删除。
const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// 注入固定时钟：毫秒时间戳，created_at 断言完全确定。
const FIXED_MS = 1758900000000;
const fixedClock = () => FIXED_MS;

test('workspaceIdForPath：格式为 ws_ 加 32 位十六进制，且对同一路径稳定', () => {
  const id = workspaceIdForPath(path.join(os.tmpdir(), 'ww-id-novel'));
  assert.match(id, /^ws_[0-9a-f]{32}$/);
  assert.equal(workspaceIdForPath(path.join(os.tmpdir(), 'ww-id-novel')), id);
});

test('workspaceIdForPath：不同路径得到不同 ID', () => {
  const a = workspaceIdForPath(path.join(os.tmpdir(), 'ww-id-a'));
  const b = workspaceIdForPath(path.join(os.tmpdir(), 'ww-id-b'));
  assert.notEqual(a, b);
});

test('workspaceIdForPath：算法为对规范化路径做 SHA-256 取前 32 位', () => {
  const root = path.join(os.tmpdir(), 'ww-id-algo');
  const expected = 'ws_' + createHash('sha256').update(canonicalWorkspacePath(root)).digest('hex').slice(0, 32);
  assert.equal(workspaceIdForPath(root), expected);
});

test('canonicalWorkspacePath：绝对化相对路径', () => {
  const canonical = canonicalWorkspacePath('ww-canonical-rel');
  assert.equal(path.isAbsolute(canonical), true);
  const expected = process.platform === 'win32'
    ? path.resolve('ww-canonical-rel').toLowerCase()
    : path.resolve('ww-canonical-rel');
  assert.equal(canonical, expected);
});

test('同一 Windows 路径不同大小写得到同一 workspace ID 和同一工作区目录', { skip: process.platform !== 'win32' }, async () => {
  const tempRoot = await makeTempRoot('wwriting-store-case-');
  const lower = path.join(tempRoot, 'project');
  const upper = path.join(tempRoot, 'PROJECT');

  assert.equal(workspaceIdForPath(lower), workspaceIdForPath(upper));
  const canonical = canonicalWorkspacePath(upper);
  assert.equal(path.isAbsolute(canonical), true);
  assert.equal(canonical, canonical.toLowerCase());

  const store = createWorkspaceStore({ appDataRoot: tempRoot, clock: fixedClock });
  const first = await store.ensure(lower);
  const second = await store.ensure(upper);
  assert.equal(first.workspaceId, second.workspaceId);
  assert.equal(first.workspaceDir, second.workspaceDir);
  assert.equal(existsSync(path.join(second.workspaceDir, 'workspace.json')), true);
});

test('ensure 建立固定目录布局，且全部位于传入的 appDataRoot', async () => {
  const tempRoot = await makeTempRoot('wwriting-store-layout-');
  const projectRoot = path.join(tempRoot, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });

  const store = createWorkspaceStore({ appDataRoot: tempRoot, clock: fixedClock });
  const result = await store.ensure(projectRoot);

  assert.match(result.workspaceId, /^ws_[0-9a-f]{32}$/);
  assert.equal(result.created, true);
  const expectedDir = path.join(tempRoot, 'WWriting', 'workspaces', result.workspaceId);
  assert.equal(result.workspaceDir, expectedDir);
  assert.equal(existsSync(path.join(expectedDir, 'sessions')), true);
  assert.equal(existsSync(path.join(expectedDir, 'locks')), true);

  const config = JSON.parse(await fs.readFile(path.join(expectedDir, 'workspace.json'), 'utf8'));
  assert.equal(config.workspace_id, result.workspaceId);
  assert.equal(config.root, canonicalWorkspacePath(projectRoot));
  assert.equal(config.created_at, new Date(FIXED_MS).toISOString());
});

test('ensure 幂等：重复调用不覆盖已有 workspace.json', async () => {
  const tempRoot = await makeTempRoot('wwriting-store-idem-');
  const projectRoot = path.join(tempRoot, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });

  const store = createWorkspaceStore({ appDataRoot: tempRoot, clock: fixedClock });
  const first = await store.ensure(projectRoot);
  assert.equal(first.created, true);
  const second = await store.ensure(projectRoot);
  assert.equal(second.created, false);

  // 手工改写后再次 ensure：内容保持原样，绝不盲目覆盖（项目记忆规则）。
  const workspaceJson = path.join(second.workspaceDir, 'workspace.json');
  await fs.writeFile(workspaceJson, '{"workspace_id":"手工内容"}\n', 'utf8');
  await store.ensure(projectRoot);
  assert.equal(await fs.readFile(workspaceJson, 'utf8'), '{"workspace_id":"手工内容"}\n');
});

test('不同项目根得到不同工作区目录：路径互相隔离', async () => {
  const tempRoot = await makeTempRoot('wwriting-store-isolation-');
  const rootA = path.join(tempRoot, 'novel-a');
  const rootB = path.join(tempRoot, 'novel-b');
  await fs.mkdir(rootA, { recursive: true });
  await fs.mkdir(rootB, { recursive: true });

  const store = createWorkspaceStore({ appDataRoot: tempRoot, clock: fixedClock });
  const a = await store.ensure(rootA);
  const b = await store.ensure(rootB);

  assert.notEqual(a.workspaceId, b.workspaceId);
  assert.notEqual(a.workspaceDir, b.workspaceDir);
  assert.equal(existsSync(path.join(a.workspaceDir, 'sessions')), true);
  assert.equal(existsSync(path.join(b.workspaceDir, 'sessions')), true);
});

test('ensure 不在项目根生成 .wwriting，也不新增任何文件', async () => {
  const tempRoot = await makeTempRoot('wwriting-store-cleanroot-');
  const projectRoot = path.join(tempRoot, 'novel');
  await fs.mkdir(projectRoot, { recursive: true });

  const store = createWorkspaceStore({ appDataRoot: tempRoot, clock: fixedClock });
  await store.ensure(projectRoot);

  assert.equal(existsSync(path.join(projectRoot, '.wwriting')), false);
  assert.deepEqual(await fs.readdir(projectRoot), []);
});

test('directoryFor / sessionsRoot / configPath：纯计算不落盘', async () => {
  const tempRoot = await makeTempRoot('wwriting-store-paths-');
  const projectRoot = path.join(tempRoot, 'novel');
  const store = createWorkspaceStore({ appDataRoot: tempRoot, clock: fixedClock });

  assert.equal(store.configPath, path.join(tempRoot, 'WWriting', 'config.json'));

  const id = workspaceIdForPath(projectRoot);
  const workspaceDir = path.join(tempRoot, 'WWriting', 'workspaces', id);
  assert.equal(store.directoryFor(projectRoot), workspaceDir);
  assert.equal(store.directoryFor(projectRoot, 'workspace'), workspaceDir);
  assert.equal(store.directoryFor(projectRoot, 'sessions'), path.join(workspaceDir, 'sessions'));
  assert.equal(store.directoryFor(projectRoot, 'locks'), path.join(workspaceDir, 'locks'));
  assert.equal(store.sessionsRoot(projectRoot), store.directoryFor(projectRoot, 'sessions'));

  // 纯计算：调用后不产生任何目录。
  assert.equal(existsSync(path.join(tempRoot, 'WWriting')), false);
});

test('directoryFor：未知目录类型抛中文错误', () => {
  const tempRoot = path.join(os.tmpdir(), 'wwriting-store-unknown-kind');
  const store = createWorkspaceStore({ appDataRoot: tempRoot, clock: fixedClock });
  assert.throws(() => store.directoryFor(path.join(tempRoot, 'novel'), 'nope'), /[\u4e00-\u9fff]/);
});

test('空项目根路径抛中文错误', () => {
  assert.throws(() => workspaceIdForPath(''), /[\u4e00-\u9fff]/);
  assert.throws(() => canonicalWorkspacePath('   '), /[\u4e00-\u9fff]/);
});

test('resolveAppDataRoot：优先 APPDATA，缺失时回退到用户目录下的 AppData/Roaming', () => {
  assert.equal(resolveAppDataRoot({ APPDATA: 'D:\\PortableData' }), 'D:\\PortableData');
  assert.equal(resolveAppDataRoot({}), path.join(os.homedir(), 'AppData', 'Roaming'));
  assert.equal(resolveAppDataRoot({ APPDATA: '   ' }), path.join(os.homedir(), 'AppData', 'Roaming'));
});
