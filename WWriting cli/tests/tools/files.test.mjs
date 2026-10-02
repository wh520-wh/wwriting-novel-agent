// 文件工具测试：路径边界（.. 逃逸、绝对项目外路径、符号链接逃逸、目录写入）
// 与原子写入语义（同目录临时文件 + rename；取消发生在 rename 前不留半文件）。
// 全部落在 os.tmpdir() 的临时目录里；Windows 首发，路径断言一律用 node:path 的真实语义。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { createFileTools } from '../../src/tools/files.mjs';
import { createPermissionState } from '../../src/tools/permissions.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// project/ 是创作目录，outside/ 是它的一墙之隔：任何逃出 project/ 的访问都必须被拒。
async function makeLayout(prefix) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempRoots.push(base);
  const projectRoot = path.join(base, 'project');
  const outsideRoot = path.join(base, 'outside');
  await fs.mkdir(path.join(projectRoot, 'chapters'), { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.writeFile(path.join(outsideRoot, 'secret.md'), '外部秘密', 'utf8');
  return { base, projectRoot, outsideRoot };
}

async function listNames(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.map((entry) => entry.name);
}

// 写入会先解析路径再进权限层，待确认不是同步产生的：轮询到出现为止（有界，不成竞态）。
async function waitForPending(permissions) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const list = permissions.pending();
    if (list.length > 0) return list;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('权限层没有产生待确认');
}

// 写入门控必须注入权限层（未注入即 fail-closed），所以每个用例都带一份。
// 这里用真实的 permission state 并开 YOLO：只跳过普通确认，extreme 仍拦，与生产契约一致。
function allowWrites(inputId = 'in-1') {
  const permissions = createPermissionState({ yolo: true });
  permissions.beginInput({ inputId });
  return permissions;
}

// 记录型 fs：默认转发真实 fs 调用并记录顺序，供原子写入断言；overrides 可注入取消时机。
function makeRecordingFs(overrides = {}) {
  const calls = [];
  const impl = {};
  const names = ['mkdir', 'writeFile', 'rename', 'rm', 'readFile', 'stat', 'realpath', 'readdir'];
  for (const name of names) {
    impl[name] = async (...args) => {
      calls.push({ name, args });
      if (typeof overrides[name] === 'function') return overrides[name](...args);
      return fs[name](...args);
    };
  }
  return { impl, calls };
}

test('writeFile：项目内相对路径写入成功，并返回本地统计的字数', async () => {
  const { projectRoot } = await makeLayout('ww-files-write-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites() });

  const result = await tools.writeFile({ path: 'chapters/ch01.md', content: '第一章 雨下了一整夜。\n' });

  assert.equal(result.path, 'chapters/ch01.md');
  assert.equal(result.charsNoSpace, '第一章雨下了一整夜。'.length);
  assert.equal(await fs.readFile(path.join(projectRoot, 'chapters/ch01.md'), 'utf8'), '第一章 雨下了一整夜。\n');
});

test('writeFile：拒绝 .. 逃逸，且磁盘上不产生任何文件', async () => {
  const { projectRoot, outsideRoot } = await makeLayout('ww-files-dotdot-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites() });

  await assert.rejects(
    () => tools.writeFile({ path: '../outside/escape.md', content: '不该落盘' }),
    (error) => error.code === 'TOOL_PATH_OUTSIDE_PROJECT',
  );
  assert.deepEqual(await listNames(outsideRoot), ['secret.md']);
});

test('readFile：拒绝 .. 逃逸与绝对项目外路径', async () => {
  const { projectRoot, outsideRoot } = await makeLayout('ww-files-outside-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites() });
  const outsideFile = path.join(outsideRoot, 'secret.md');

  await assert.rejects(
    () => tools.readFile({ path: '../outside/secret.md' }),
    (error) => error.code === 'TOOL_PATH_OUTSIDE_PROJECT',
  );
  await assert.rejects(
    () => tools.readFile({ path: outsideFile }),
    (error) => error.code === 'TOOL_PATH_OUTSIDE_PROJECT',
  );
  // 项目内的绝对路径仍然可用（相对化后落在 projectRoot 内）。
  const inside = path.join(projectRoot, 'chapters', 'ch01.md');
  await tools.writeFile({ path: 'chapters/ch01.md', content: '雨' });
  assert.equal((await tools.readFile({ path: inside })).text, '雨');
});

test('readFile/listFiles/writeFile：拒绝符号链接逃逸（链接在项目内，实体在项目外）', async (t) => {
  const { projectRoot, outsideRoot } = await makeLayout('ww-files-symlink-');
  const linkPath = path.join(projectRoot, 'linkdir');
  try {
    // junction：目录级链接，Windows 无管理员权限也能建；POSIX 上退化成普通符号链接。
    await fs.symlink(outsideRoot, linkPath, 'junction');
  } catch (error) {
    t.skip(`当前环境无法创建符号链接：${error.code}`);
    return;
  }
  if (!(await fs.lstat(linkPath)).isSymbolicLink()) {
    t.skip('当前环境没有生成真正的符号链接，跳过');
    return;
  }

  const tools = createFileTools({ projectRoot, permissions: allowWrites() });
  for (const call of [
    () => tools.readFile({ path: 'linkdir/secret.md' }),
    () => tools.listFiles({ path: 'linkdir' }),
    () => tools.writeFile({ path: 'linkdir/new.md', content: 'x' }),
  ]) {
    await assert.rejects(call, (error) => error.code === 'TOOL_PATH_OUTSIDE_PROJECT');
  }
  assert.deepEqual(await listNames(outsideRoot), ['secret.md']);
});

test('writeFile：目标为目录时拒绝，且不破坏该目录', async () => {
  const { projectRoot } = await makeLayout('ww-files-dir-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites() });

  await assert.rejects(
    () => tools.writeFile({ path: 'chapters', content: 'x' }),
    (error) => error.code === 'TOOL_TARGET_IS_DIRECTORY',
  );
  // 创作目录根本身也是目录：不允许当成文件覆盖写入。
  await assert.rejects(
    () => tools.writeFile({ path: '.', content: 'x' }),
    (error) => error.code === 'TOOL_TARGET_IS_DIRECTORY',
  );
  assert.deepEqual(await listNames(path.join(projectRoot, 'chapters')), []);
});

test('writeFile：先写同目录临时文件再 rename，完成后不留临时文件', async () => {
  const { projectRoot } = await makeLayout('ww-files-atomic-');
  const { impl, calls } = makeRecordingFs();
  const tools = createFileTools({ projectRoot, permissions: allowWrites(), fs: impl });

  await tools.writeFile({ path: 'chapters/ch01.md', content: '雨' });

  const target = path.join(projectRoot, 'chapters', 'ch01.md');
  const writes = calls.filter((call) => call.name === 'writeFile');
  const renames = calls.filter((call) => call.name === 'rename');
  assert.equal(writes.length, 1);
  assert.equal(renames.length, 1);

  const tmpPath = writes[0].args[0];
  assert.notEqual(tmpPath, target);
  assert.equal(path.dirname(tmpPath), path.dirname(target));
  assert.match(path.basename(tmpPath), /^ch01\.md\..+\.tmp$/);
  assert.deepEqual(renames[0].args, [tmpPath, target]);
  assert.ok(calls.indexOf(writes[0]) < calls.indexOf(renames[0]));

  assert.deepEqual(await listNames(path.join(projectRoot, 'chapters')), ['ch01.md']);
});

test('writeFile：取消发生在 rename 之前时不留下半文件', async () => {
  const { projectRoot } = await makeLayout('ww-files-cancel-');
  const controller = new AbortController();
  const { impl } = makeRecordingFs({
    // 临时文件刚写完、rename 之前被取消：这是最容易留下半文件的时刻。
    writeFile: (...args) => {
      controller.abort();
      return fs.writeFile(...args);
    },
  });
  const tools = createFileTools({ projectRoot, permissions: allowWrites(), signal: controller.signal, fs: impl });

  await assert.rejects(
    () => tools.writeFile({ path: 'chapters/ch01.md', content: '未完成的章节' }),
    (error) => error.name === 'AbortError' && error.code === 'TOOL_ABORTED',
  );

  const entries = await listNames(path.join(projectRoot, 'chapters'));
  assert.deepEqual(entries, []);
});

test('writeFile：signal 已中止时直接拒绝，不创建任何文件', async () => {
  const { projectRoot } = await makeLayout('ww-files-preabort-');
  const controller = new AbortController();
  controller.abort();
  const tools = createFileTools({ projectRoot, permissions: allowWrites(), signal: controller.signal });

  await assert.rejects(
    () => tools.writeFile({ path: 'chapters/ch01.md', content: 'x' }),
    (error) => error.code === 'TOOL_ABORTED',
  );
  assert.deepEqual(await listNames(path.join(projectRoot, 'chapters')), []);
});

test('路径参数：空值、非字符串和空串一律拒绝', async () => {
  const { projectRoot } = await makeLayout('ww-files-arg-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites() });

  for (const bad of [undefined, null, '', '   ', 42, {}]) {
    await assert.rejects(
      () => tools.readFile({ path: bad }),
      (error) => error.code === 'TOOL_PATH_INVALID',
      `path=${String(bad)} 应被拒绝`,
    );
  }
});

test('readFile：文件不存在与目标是目录分别给出可理解的错误', async () => {
  const { projectRoot } = await makeLayout('ww-files-read-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites() });

  await assert.rejects(
    () => tools.readFile({ path: 'chapters/missing.md' }),
    (error) => error.code === 'TOOL_TARGET_NOT_FOUND',
  );
  await assert.rejects(
    () => tools.readFile({ path: 'chapters' }),
    (error) => error.code === 'TOOL_TARGET_IS_DIRECTORY',
  );
});

test('listFiles：返回项目内相对路径，递归可展开，项目外路径被拒', async () => {
  const { projectRoot, outsideRoot } = await makeLayout('ww-files-list-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites() });
  await tools.writeFile({ path: 'chapters/ch01.md', content: '一' });
  await tools.writeFile({ path: 'chapters/ch02.md', content: '二' });

  const flat = await tools.listFiles({ path: '.' });
  assert.deepEqual(flat.entries.map((entry) => entry.path), ['chapters/']);

  const nested = await tools.listFiles({ path: '.', recursive: true });
  assert.deepEqual(nested.entries.map((entry) => entry.path), ['chapters/', 'chapters/ch01.md', 'chapters/ch02.md']);
  assert.equal(nested.entries[0].type, 'dir');
  assert.equal(nested.entries[1].type, 'file');

  await assert.rejects(
    () => tools.listFiles({ path: outsideRoot }),
    (error) => error.code === 'TOOL_PATH_OUTSIDE_PROJECT',
  );
});

test('searchFiles：按行命中并给出行号，结果数可限制', async () => {
  const { projectRoot } = await makeLayout('ww-files-search-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites() });
  await tools.writeFile({ path: 'chapters/ch01.md', content: '第一章 开端\n他走进了雨里。\n' });
  await tools.writeFile({ path: 'chapters/ch02.md', content: '第二章 雨\n雨停了。\n又下雨。\n' });

  const found = await tools.searchFiles({ pattern: '雨' });
  assert.deepEqual(found.matches, [
    { path: 'chapters/ch01.md', lineNumber: 2, text: '他走进了雨里。' },
    { path: 'chapters/ch02.md', lineNumber: 1, text: '第二章 雨' },
    { path: 'chapters/ch02.md', lineNumber: 2, text: '雨停了。' },
    { path: 'chapters/ch02.md', lineNumber: 3, text: '又下雨。' },
  ]);
  assert.equal(found.truncated, false);

  const limited = await tools.searchFiles({ pattern: '雨', maxResults: 2 });
  assert.equal(limited.matches.length, 2);
  assert.equal(limited.truncated, true);

  await assert.rejects(
    () => tools.searchFiles({ pattern: '' }),
    (error) => error.code === 'TOOL_PATTERN_INVALID',
  );
});

test('editFile：替换唯一片段，未命中与多处命中分别报错，replaceAll 全替换', async () => {
  const { projectRoot } = await makeLayout('ww-files-edit-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites() });
  await tools.writeFile({ path: 'chapters/ch01.md', content: '雨下了一整夜。\n雨停了。\n' });

  const edited = await tools.editFile({ path: 'chapters/ch01.md', oldText: '雨停了。', newText: '天亮了。' });
  assert.equal(edited.replacements, 1);
  assert.equal(await fs.readFile(path.join(projectRoot, 'chapters/ch01.md'), 'utf8'), '雨下了一整夜。\n天亮了。\n');

  await assert.rejects(
    () => tools.editFile({ path: 'chapters/ch01.md', oldText: '不存在', newText: 'x' }),
    (error) => error.code === 'TOOL_EDIT_NOT_FOUND',
  );
  await assert.rejects(
    () => tools.editFile({ path: 'chapters/ch01.md', oldText: '。', newText: '！' }),
    (error) => error.code === 'TOOL_EDIT_AMBIGUOUS',
  );
  // 被拒的编辑不得改动磁盘内容。
  assert.equal(await fs.readFile(path.join(projectRoot, 'chapters/ch01.md'), 'utf8'), '雨下了一整夜。\n天亮了。\n');

  const all = await tools.editFile({ path: 'chapters/ch01.md', oldText: '雨', newText: '雪', replaceAll: true });
  assert.equal(all.replacements, 1);
  assert.equal(await fs.readFile(path.join(projectRoot, 'chapters/ch01.md'), 'utf8'), '雪下了一整夜。\n天亮了。\n');

  await assert.rejects(
    () => tools.editFile({ path: 'chapters/missing.md', oldText: 'a', newText: 'b' }),
    (error) => error.code === 'TOOL_TARGET_NOT_FOUND',
  );
});

test('editFile：替换串里的 $&/$$ 等序列按字面落盘，不得解释为替换模式', async () => {
  // String.prototype.replace 的替换串会把 $$/$&/$`/$' 解释成替换模式（split/join 不会），
  // 同一个 newText 曾因 replaceAll 开关落盘成两种内容（缺陷猎捕报告第 1 条）。
  const { projectRoot } = await makeLayout('ww-files-edit-pattern-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites() });
  await tools.writeFile({ path: 'chapters/ch01.md', content: '开头\n旧句子\n结尾\n' });

  await tools.editFile({ path: 'chapters/ch01.md', oldText: '旧句子', newText: '新$&句子' });
  assert.equal(await fs.readFile(path.join(projectRoot, 'chapters/ch01.md'), 'utf8'), '开头\n新$&句子\n结尾\n');

  await tools.editFile({ path: 'chapters/ch01.md', oldText: '新$&句子', newText: '$$2000' });
  assert.equal(await fs.readFile(path.join(projectRoot, 'chapters/ch01.md'), 'utf8'), '开头\n$$2000\n结尾\n');

  // 替换串里出现被替换的原文也要能正常落盘（split/join 语义下这是合法的一步替换）。
  await tools.editFile({ path: 'chapters/ch01.md', oldText: '$$2000', newText: '$$2000元' });
  assert.equal(await fs.readFile(path.join(projectRoot, 'chapters/ch01.md'), 'utf8'), '开头\n$$2000元\n结尾\n');
});

test('countText：文件工具直接暴露本地字数统计', async () => {
  const { projectRoot } = await makeLayout('ww-files-count-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites() });
  await tools.writeFile({ path: 'chapters/ch01.md', content: '第一章 雨下了一整夜。\n' });

  const text = (await tools.readFile({ path: 'chapters/ch01.md' })).text;
  const counted = tools.countText({ text });
  assert.equal(counted.charsNoSpace, '第一章雨下了一整夜。'.length);
  assert.equal(counted.hanzi, '第一章雨下了一整夜'.length);
});

test('createFileTools：工作区路径为空时直接报错', () => {
  assert.throws(() => createFileTools({ projectRoot: '' }), /创作目录/);
});

test('写入门控：未注入权限层时 fail-closed，拒绝且不落盘', async () => {
  const { projectRoot } = await makeLayout('ww-files-noperm-');
  await fs.writeFile(path.join(projectRoot, 'chapters', 'ch01.md'), '雨停了。', 'utf8');
  const tools = createFileTools({ projectRoot });

  await assert.rejects(
    () => tools.writeFile({ path: 'chapters/ch02.md', content: '不该落盘' }),
    (error) => error.code === 'TOOL_WRITE_UNAUTHORIZED',
  );
  await assert.rejects(
    () => tools.editFile({ path: 'chapters/ch01.md', oldText: '雨', newText: '雪' }),
    (error) => error.code === 'TOOL_WRITE_UNAUTHORIZED',
  );
  // 门在任何写盘动作之前：既没有目标文件，也没有临时文件。
  assert.deepEqual(await listNames(path.join(projectRoot, 'chapters')), ['ch01.md']);

  // 注入了但不是可用的权限层（没有 request 入口）同样不放行。
  const broken = createFileTools({ projectRoot, permissions: {} });
  await assert.rejects(
    () => broken.writeFile({ path: 'chapters/ch02.md', content: '不该落盘' }),
    (error) => error.code === 'TOOL_WRITE_UNAUTHORIZED',
  );

  // 读取不受影响：只读自动放行。
  assert.equal((await tools.readFile({ path: 'chapters/ch01.md' })).text, '雨停了。');
});

test('写入门控：注入权限层并确认后正常写入，同一条输入内同类操作不再询问', async () => {
  const { projectRoot } = await makeLayout('ww-files-permgrant-');
  const permissions = createPermissionState();
  permissions.beginInput({ inputId: 'in-1' });
  const tools = createFileTools({ projectRoot, permissions });

  const writing = tools.writeFile({ path: 'chapters/ch01.md', content: '第一章' });
  const [decision] = await waitForPending(permissions);
  assert.equal(decision.level, 'write');
  assert.equal(decision.tool, 'write_file');
  assert.equal(decision.target, 'chapters/ch01.md');
  permissions.decide({ decisionId: decision.decision_id, choice: 'input' });

  const result = await writing;
  assert.equal(result.path, 'chapters/ch01.md');
  assert.equal(await fs.readFile(path.join(projectRoot, 'chapters/ch01.md'), 'utf8'), '第一章');

  const second = await tools.writeFile({ path: 'chapters/ch02.md', content: '第二章' });
  assert.equal(second.charsNoSpace, 3);
  assert.deepEqual(permissions.pending(), []);
});

test('写入门控：拒绝时拒绝且不落盘，临时文件也不留', async () => {
  const { projectRoot } = await makeLayout('ww-files-permdeny-');
  const permissions = createPermissionState();
  permissions.beginInput({ inputId: 'in-1' });
  const tools = createFileTools({ projectRoot, permissions });
  const chapters = path.join(projectRoot, 'chapters');
  await fs.writeFile(path.join(chapters, 'ch01.md'), '雨停了。', 'utf8');

  const writing = tools.writeFile({ path: 'chapters/ch02.md', content: '不该落盘' });
  const [deniedWrite] = await waitForPending(permissions);
  permissions.decide({ decisionId: deniedWrite.decision_id, choice: 'deny' });
  await assert.rejects(() => writing, (error) => error.code === 'TOOL_WRITE_DENIED');

  const editing = tools.editFile({ path: 'chapters/ch01.md', oldText: '雨', newText: '雪' });
  const [deniedEdit] = await waitForPending(permissions);
  assert.equal(deniedEdit.tool, 'edit_file');
  permissions.decide({ decisionId: deniedEdit.decision_id, choice: 'deny' });
  await assert.rejects(() => editing, (error) => error.code === 'TOOL_WRITE_DENIED');

  assert.deepEqual(await listNames(chapters), ['ch01.md']);
  assert.equal(await fs.readFile(path.join(chapters, 'ch01.md'), 'utf8'), '雨停了。');
});

test('写入门控：输入切换后待确认作废，写入被拒且不落盘', async () => {
  const { projectRoot } = await makeLayout('ww-files-permexpire-');
  const permissions = createPermissionState();
  permissions.beginInput({ inputId: 'in-1' });
  const tools = createFileTools({ projectRoot, permissions });

  const writing = tools.writeFile({ path: 'chapters/ch01.md', content: '不该落盘' });
  await waitForPending(permissions);
  permissions.beginInput({ inputId: 'in-2' }); // 输入切换：这条待确认立即作废

  await assert.rejects(() => writing, (error) => error.code === 'TOOL_WRITE_DENIED');
  assert.deepEqual(await listNames(path.join(projectRoot, 'chapters')), []);
});

// —— append_chapter_segment 与 rollback_chapter 的落盘 ——

test('appendFile 追加到已有文件：拼接后原子落盘，字数按拼接后的全文算', async () => {
  const { projectRoot } = await makeLayout('wwriting-files-append-');
  await fs.writeFile(path.join(projectRoot, 'chapters', 'ch01.md'), '第一段。', 'utf8');
  const tools = createFileTools({ projectRoot, permissions: allowWrites('in-1') });

  const out = await tools.appendFile({ path: 'chapters/ch01.md', content: '第二段。' });

  assert.equal(await fs.readFile(path.join(projectRoot, 'chapters', 'ch01.md'), 'utf8'), '第一段。第二段。');
  assert.equal(out.charsNoSpace, 8);
});

test('appendFile 对不存在的文件等同首次写入', async () => {
  const { projectRoot } = await makeLayout('wwriting-files-append-new-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites('in-1') });
  const out = await tools.appendFile({ path: 'chapters/new.md', content: '开篇。' });
  assert.equal(await fs.readFile(path.join(projectRoot, 'chapters', 'new.md'), 'utf8'), '开篇。');
  assert.equal(out.charsNoSpace, 3);
});

test('appendFile 空内容拒绝、目录拒绝、未经确认一个字节都不写', async () => {
  const { projectRoot } = await makeLayout('wwriting-files-append-guard-');
  const tools = createFileTools({ projectRoot, permissions: allowWrites('in-1') });
  await assert.rejects(() => tools.appendFile({ path: 'chapters/a.md', content: '' }), (error) => error.code === 'TOOL_CONTENT_INVALID');
  await assert.rejects(() => tools.appendFile({ path: 'chapters', content: 'x' }), (error) => error.code === 'TOOL_TARGET_IS_DIRECTORY');

  // 权限拒绝路径：拒绝后文件保持原样。
  await fs.writeFile(path.join(projectRoot, 'chapters', 'keep.md'), '原样', 'utf8');
  const permissions = createPermissionState({ yolo: false });
  permissions.beginInput({ inputId: 'in-1' });
  const gated = createFileTools({ projectRoot, permissions });
  const writing = gated.appendFile({ path: 'chapters/keep.md', content: '追加' });
  const pending = await waitForPending(permissions);
  await permissions.decide({ decisionId: pending[0].decision_id, choice: 'deny' });
  await assert.rejects(() => writing, (error) => error.code === 'TOOL_WRITE_DENIED');
  assert.equal(await fs.readFile(path.join(projectRoot, 'chapters', 'keep.md'), 'utf8'), '原样');
});

test('restoreFile 授权标签是「回滚章节」：确认卡说的是回滚，不是写入文件', async () => {
  const { projectRoot } = await makeLayout('wwriting-files-restore-');
  await fs.writeFile(path.join(projectRoot, 'chapters', 'ch01.md'), '旧版本', 'utf8');
  const permissions = createPermissionState({ yolo: false });
  permissions.beginInput({ inputId: 'in-1' });
  const tools = createFileTools({ projectRoot, permissions });

  const restoring = tools.restoreFile({ path: 'chapters/ch01.md', content: '提交过的内容' });
  const pending = await waitForPending(permissions);
  // 确认卡按工具名取标签：用户必须知道自己在确认一次回滚（而不是又一次普通写入）。
  assert.equal(pending[0].tool, 'rollback_chapter');
  await permissions.decide({ decisionId: pending[0].decision_id, choice: 'once' });
  const out = await restoring;

  assert.equal(await fs.readFile(path.join(projectRoot, 'chapters', 'ch01.md'), 'utf8'), '提交过的内容');
  assert.equal(out.charsNoSpace, 6);
});

// —— memory/ 目录级保护（设定档案只有 update_memory 一条写通道）——

const MEMORY_DENIAL = '记忆档案为系统文件，只读；设定档案请用 update_memory 工具更新。';

test('memory/ 只读：四类写工具命中一律拒绝并指路 update_memory，确认卡不出现', async () => {
  const { projectRoot } = await makeLayout('wwriting-files-memory-');
  const permissions = createPermissionState({ yolo: true });
  permissions.beginInput({ inputId: 'in-1' });
  const tools = createFileTools({ projectRoot, permissions });

  const attempts = [
    () => tools.writeFile({ path: 'memory/continuity.json', content: '{}' }),
    () => tools.editFile({ path: 'memory/continuity.md', oldText: '旧', newText: '新' }),
    () => tools.appendFile({ path: 'memory/continuity.md', content: '追加' }),
    () => tools.restoreFile({ path: 'memory/continuity.json', content: '回滚' }),
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt, (error) => {
      assert.equal(error.code, 'TOOL_PROTECTED_DIR');
      assert.equal(error.message, MEMORY_DENIAL);
      return true;
    });
  }
  // 保护在授权之前：连待确认都不产生（普通确认卡不出现）。
  assert.deepEqual(permissions.pending(), []);
  assert.deepEqual(await listNames(path.join(projectRoot, 'chapters')), [], '零写入');
});

test('memory/ 保护与越界判定互不绕过', async () => {
  const { projectRoot, outsideRoot } = await makeLayout('wwriting-files-memory-edge-');
  const permissions = createPermissionState({ yolo: true });
  permissions.beginInput({ inputId: 'in-1' });
  const tools = createFileTools({ projectRoot, permissions });

  // 越界优先：路径解析在先，项目外就是项目外，不管路径长什么样。
  await assert.rejects(
    () => tools.writeFile({ path: '../outside/memory/x.md', content: 'x' }),
    (error) => error.code === 'TOOL_PATH_OUTSIDE_PROJECT',
  );
  // 中段 .. 落回 memory/ 内：仍是保护拒绝，不是普通写入。
  await assert.rejects(
    () => tools.writeFile({ path: 'chapters/../memory/continuity.json', content: 'x' }),
    (error) => error.code === 'TOOL_PROTECTED_DIR',
  );
  // memory/ 目录本身也不可当写入目标（含将来 delete_dir 的落点）。
  await assert.rejects(
    () => tools.writeFile({ path: 'memory', content: 'x' }),
    (error) => error.code === 'TOOL_PROTECTED_DIR',
  );
  // 同形前缀不是保护对象：memoryx/ 是普通文件区。
  await fs.mkdir(path.join(projectRoot, 'memoryx'), { recursive: true });
  await tools.writeFile({ path: 'memoryx/01.md', content: '普通区' });
  assert.deepEqual(await listNames(outsideRoot), ['secret.md']);
});

test('memory/ 读取放行：读文件、列表、搜索都照常', async () => {
  const { projectRoot } = await makeLayout('wwriting-files-memory-read-');
  await fs.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'memory', 'continuity.json'), '{"facts": []}', 'utf8');
  await fs.mkdir(path.join(projectRoot, 'memory', 'sub'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'memory', 'sub', 'note.md'), '设定笔记在此', 'utf8');
  const tools = createFileTools({ projectRoot, permissions: allowWrites() });

  const file = await tools.readFile({ path: 'memory/continuity.json' });
  assert.equal(file.text, '{"facts": []}');
  const listing = await tools.listFiles({ path: 'memory', recursive: true });
  assert.deepEqual(listing.entries.map((entry) => entry.path).sort(), ['memory/continuity.json', 'memory/sub/', 'memory/sub/note.md']);
  const found = await tools.searchFiles({ pattern: '设定笔记', path: 'memory' });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].path, 'memory/sub/note.md');
});

test('memory/ 保护按真实路径生效：项目内的目录别名（junction/symlink）绕不过去', async () => {
  const { projectRoot } = await makeLayout('wwriting-files-memory-alias-');
  await fs.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  const alias = path.join(projectRoot, 'mem');
  try {
    await fs.symlink(path.join(projectRoot, 'memory'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    // 平台不支持创建别名（权限 / 文件系统限制）：这条件测不了，如实跳过而不是假装通过。
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error?.code)) return;
    throw error;
  }
  const permissions = createPermissionState({ yolo: true });
  permissions.beginInput({ inputId: 'in-1' });
  const tools = createFileTools({ projectRoot, permissions });

  // 经别名写入 = 写进 memory/：拒绝且指路合法通道，确认卡不出现。
  await assert.rejects(
    () => tools.writeFile({ path: 'mem/continuity.json', content: '{}' }),
    (error) => {
      assert.equal(error.code, 'TOOL_PROTECTED_DIR');
      assert.equal(error.message, MEMORY_DENIAL);
      return true;
    },
  );
  await assert.rejects(() => fs.stat(path.join(projectRoot, 'memory', 'continuity.json')));
  assert.deepEqual(permissions.pending(), []);
  // 经别名读取仍放行（别名不是写通道，读取从来不受保护限制）。
  await fs.writeFile(path.join(projectRoot, 'memory', 'continuity.json'), '{"facts": []}', 'utf8');
  const read = await tools.readFile({ path: 'mem/continuity.json' });
  assert.equal(read.text, '{"facts": []}');
});
