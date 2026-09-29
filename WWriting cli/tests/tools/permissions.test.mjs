// 权限生命周期测试：一次允许 / 本条输入允许同类 / 拒绝 / YOLO 跳过普通确认但绝不跳过极端确认，
// 以及 Run 结束、停止、输入切换后授权必须清空。
// 铁律 4：极端操作必须输入当次显示的精确确认文字，模型与 YOLO 都不得代填。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import { classifyOperation, createPermissionState, PermissionError } from '../../src/tools/permissions.mjs';

const projectRoot = path.join(os.tmpdir(), 'ww-perm-project');

function stateWithInput(inputId = 'in-1', options = {}) {
  const state = createPermissionState(options);
  state.beginInput({ inputId });
  return state;
}

// 断言抛出的权限错误带预期 code——code 只给调用方判断，用户看到的是中文 message。
function assertCode(code) {
  return (error) => error instanceof PermissionError && error.code === code;
}

test('classifyOperation：读取类工具是 read，写入类工具是 write', () => {
  assert.equal(classifyOperation({ tool: 'read_file', target: 'chapters/ch01.md', projectRoot }), 'read');
  assert.equal(classifyOperation({ tool: 'list_files', target: '.', projectRoot }), 'read');
  assert.equal(classifyOperation({ tool: 'search_files', target: '.', projectRoot }), 'read');
  assert.equal(classifyOperation({ tool: 'count_text', projectRoot }), 'read');
  assert.equal(classifyOperation({ tool: 'write_file', target: 'chapters/ch01.md', projectRoot }), 'write');
  assert.equal(classifyOperation({ tool: 'edit_file', target: 'chapters/ch01.md', projectRoot }), 'write');
});

test('classifyOperation：删除与清空会话数据是 extreme', () => {
  assert.equal(classifyOperation({ tool: 'delete_file', target: 'chapters/ch01.md', projectRoot }), 'extreme');
  assert.equal(classifyOperation({ tool: 'clear_session', projectRoot }), 'extreme');
  assert.equal(classifyOperation({ tool: 'clear_history', projectRoot }), 'extreme');
});

test('classifyOperation：项目外访问一律 extreme，读取也不例外', () => {
  const outside = path.join(os.tmpdir(), 'outside', 'secret.md');
  assert.equal(classifyOperation({ tool: 'read_file', target: outside, projectRoot }), 'extreme');
  assert.equal(classifyOperation({ tool: 'read_file', target: '../outside/secret.md', projectRoot }), 'extreme');
  assert.equal(classifyOperation({ tool: 'write_file', target: outside, projectRoot }), 'extreme');
});

test('classifyOperation：未知工具按极端处理，不默认放行', () => {
  assert.equal(classifyOperation({ tool: 'run_command', target: 'rm -rf /', projectRoot }), 'extreme');
  assert.equal(classifyOperation({ tool: '随便什么新工具', projectRoot }), 'extreme');
  assert.equal(classifyOperation({ projectRoot }), 'extreme');
});

test('读取类操作自动放行，不产生待确认', async () => {
  const state = stateWithInput('in-1');
  const result = await state.request({ inputId: 'in-1', tool: 'read_file', target: 'chapters/ch01.md', projectRoot });

  assert.equal(result.allowed, true);
  assert.equal(result.level, 'read');
  assert.deepEqual(state.pending(), []);
});

test('一次允许：本次放行，下一次同类操作仍要确认', async () => {
  const state = stateWithInput('in-1');
  const args = { inputId: 'in-1', tool: 'write_file', target: 'chapters/ch01.md', projectRoot };

  const first = state.request(args);
  await null;
  const [decision] = state.pending();
  assert.equal(decision.level, 'write');
  assert.deepEqual(decision.choices, ['once', 'input', 'deny']);
  state.decide({ decisionId: decision.decision_id, choice: 'once' });
  assert.equal((await first).allowed, true);

  const second = state.request(args);
  await null;
  assert.equal(state.pending().length, 1, '一次允许不留下同类授权');
  state.decide({ decisionId: state.pending()[0].decision_id, choice: 'deny' });
  assert.equal((await second).allowed, false);
});

test('本条输入允许同类操作：同一输入内后续同类操作不再询问', async () => {
  const state = stateWithInput('in-1');
  const args = { inputId: 'in-1', tool: 'write_file', target: 'chapters/ch01.md', projectRoot };

  const first = state.request(args);
  await null;
  state.decide({ decisionId: state.pending()[0].decision_id, choice: 'input' });
  assert.equal((await first).allowed, true);
  assert.equal(state.grantFor({ inputId: 'in-1', tool: 'write_file' }), true);

  const second = await state.request({ ...args, target: 'chapters/ch02.md' });
  assert.equal(second.allowed, true);
  assert.equal(second.reason, 'granted');
  assert.deepEqual(state.pending(), []);
});

test('拒绝：本次不执行，且不留授权', async () => {
  const state = stateWithInput('in-1');
  const pending = state.request({ inputId: 'in-1', tool: 'edit_file', target: 'chapters/ch01.md', projectRoot });
  await null;
  state.decide({ decisionId: state.pending()[0].decision_id, choice: 'deny' });

  const result = await pending;
  assert.equal(result.allowed, false);
  assert.equal(result.choice, 'deny');
  assert.equal(state.grantFor({ inputId: 'in-1', tool: 'edit_file' }), false);
});

test('输入切换：授权失效，上一输入遗留的待确认被取消', async () => {
  const state = stateWithInput('in-1');
  const args = { inputId: 'in-1', tool: 'write_file', target: 'chapters/ch01.md', projectRoot };

  const first = state.request(args);
  await null;
  state.decide({ decisionId: state.pending()[0].decision_id, choice: 'input' });
  await first;
  assert.equal(state.grantFor({ inputId: 'in-1', tool: 'write_file' }), true);

  // 换一条工具拿待确认：write_file 已被授权，不会再产生待确认。
  const stale = state.request({ ...args, tool: 'edit_file' });
  await null;
  assert.equal(state.pending().length, 1);
  state.beginInput({ inputId: 'in-2' });

  assert.equal((await stale).allowed, false, '旧输入的待确认不得继续执行');
  assert.equal(state.grantFor({ inputId: 'in-2', tool: 'write_file' }), false);
  assert.equal(state.grantFor({ inputId: 'in-1', tool: 'write_file' }), false);

  const second = state.request({ inputId: 'in-2', tool: 'write_file', target: 'chapters/ch01.md', projectRoot });
  await null;
  assert.equal(state.pending().length, 1, '新输入必须重新确认');
  state.decide({ decisionId: state.pending()[0].decision_id, choice: 'deny' });
  assert.equal((await second).allowed, false);
});

test('clearInput（Run 结束或停止）：清空授权并取消待确认', async () => {
  const state = stateWithInput('in-1');
  const pending = state.request({ inputId: 'in-1', tool: 'write_file', target: 'chapters/ch01.md', projectRoot });
  await null;
  state.decide({ decisionId: state.pending()[0].decision_id, choice: 'input' });
  await pending;
  assert.equal(state.grantFor({ inputId: 'in-1', tool: 'write_file' }), true);

  const interrupted = state.request({ inputId: 'in-1', tool: 'edit_file', target: 'chapters/ch02.md', projectRoot });
  await null;
  assert.equal(state.pending().length, 1);
  state.clearInput();

  assert.equal((await interrupted).allowed, false);
  assert.equal(state.grantFor({ inputId: 'in-1', tool: 'write_file' }), false);
  assert.deepEqual(state.pending(), []);
});

test('YOLO：跳过普通确认，但状态可见', async () => {
  const state = stateWithInput('in-1');
  state.setYolo(true);
  assert.equal(state.isYolo(), true);

  const result = await state.request({ inputId: 'in-1', tool: 'write_file', target: 'chapters/ch01.md', projectRoot });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'yolo');
  assert.deepEqual(state.pending(), []);

  state.setYolo(false);
  assert.equal(state.isYolo(), false);
  const again = state.request({ inputId: 'in-1', tool: 'write_file', target: 'chapters/ch01.md', projectRoot });
  await null;
  assert.equal(state.pending().length, 1, '关掉 YOLO 后恢复确认');
  state.decide({ decisionId: state.pending()[0].decision_id, choice: 'deny' });
  assert.equal((await again).allowed, false);
});

test('YOLO 仍拦截极端操作，必须输入精确确认文字', async () => {
  const state = stateWithInput('in-1', { yolo: true });
  assert.equal(state.isYolo(), true);

  const pending = state.request({ inputId: 'in-1', tool: 'delete_file', target: 'chapters/ch01.md', projectRoot });
  await null;
  const [decision] = state.pending();
  assert.equal(decision.level, 'extreme');
  assert.deepEqual(decision.choices, ['confirm', 'deny']);
  assert.ok(typeof decision.confirmation_text === 'string' && decision.confirmation_text.length > 0);

  state.decide({ decisionId: decision.decision_id, choice: 'confirm', text: decision.confirmation_text });
  assert.equal((await pending).allowed, true);
});

test('极端确认：确认文字必须完全相等，前后空白或少一个字都不行', async () => {
  const state = stateWithInput('in-1');
  const pending = state.request({ inputId: 'in-1', tool: 'delete_file', target: 'chapters/ch01.md', projectRoot });
  await null;
  const [decision] = state.pending();
  const exact = decision.confirmation_text;

  for (const wrong of [`${exact} `, ` ${exact}`, exact.slice(0, -1), exact.slice(1), '确认删除']) {
    assert.throws(
      () => state.decide({ decisionId: decision.decision_id, choice: 'confirm', text: wrong }),
      assertCode('PERMISSION_CONFIRMATION_MISMATCH'),
      `确认文字「${wrong}」应被拒绝`,
    );
    assert.equal(state.pending().length, 1, '输错后仍可重输，确认不失效');
  }

  state.decide({ decisionId: decision.decision_id, choice: 'confirm', text: exact });
  assert.equal((await pending).allowed, true);
});

test('极端确认：模型不得代填确认文字，YOLO 也不得代填', async () => {
  const state = stateWithInput('in-1', { yolo: true });
  const modelGuess = '确认删除';
  const pending = state.request({
    inputId: 'in-1',
    tool: 'delete_file',
    target: 'chapters/ch01.md',
    projectRoot,
    // 模型试图自带确认文字：接口不接受，内部仍生成当次确认文字。
    confirmationText: modelGuess,
  });
  await null;
  const [decision] = state.pending();

  assert.notEqual(decision.confirmation_text, modelGuess);
  assert.throws(
    () => state.decide({ decisionId: decision.decision_id, choice: 'confirm', text: modelGuess }),
    assertCode('PERMISSION_CONFIRMATION_MISMATCH'),
  );

  state.decide({ decisionId: decision.decision_id, choice: 'confirm', text: decision.confirmation_text });
  assert.equal((await pending).allowed, true);
});

test('极端确认：不接受一次允许或同类授权这类普通选项', async () => {
  const state = stateWithInput('in-1');
  const pending = state.request({ inputId: 'in-1', tool: 'clear_session', projectRoot });
  await null;
  const [decision] = state.pending();

  for (const choice of ['once', 'input']) {
    assert.throws(
      () => state.decide({ decisionId: decision.decision_id, choice }),
      assertCode('PERMISSION_INVALID_CHOICE'),
      `选项 ${choice} 不得用于极端操作`,
    );
  }
  assert.throws(
    () => state.decide({ decisionId: decision.decision_id, choice: 'confirm' }),
    assertCode('PERMISSION_CONFIRMATION_MISMATCH'),
  );

  state.decide({ decisionId: decision.decision_id, choice: 'deny' });
  assert.equal((await pending).allowed, false);
});

test('decide：未知、已处理或属于上一条输入的 decision_id 一律失效', async () => {
  const state = stateWithInput('in-1');
  const pending = state.request({ inputId: 'in-1', tool: 'write_file', target: 'chapters/ch01.md', projectRoot });
  await null;
  const [decision] = state.pending();

  assert.throws(
    () => state.decide({ decisionId: 'dec_不存在', choice: 'once' }),
    assertCode('PERMISSION_DECISION_NOT_FOUND'),
  );

  state.beginInput({ inputId: 'in-2' });
  assert.throws(
    () => state.decide({ decisionId: decision.decision_id, choice: 'once' }),
    assertCode('PERMISSION_DECISION_EXPIRED'),
  );
  assert.equal((await pending).allowed, false);

  const reuse = state.request({ inputId: 'in-2', tool: 'write_file', target: 'chapters/ch01.md', projectRoot });
  await null;
  const [second] = state.pending();
  state.decide({ decisionId: second.decision_id, choice: 'once' });
  await reuse;
  assert.throws(
    () => state.decide({ decisionId: second.decision_id, choice: 'once' }),
    assertCode('PERMISSION_DECISION_CLOSED'),
  );
});

test('每次极端确认的确认文字都不同，不能靠记住上一句蒙混', async () => {
  const state = stateWithInput('in-1');
  const first = state.request({ inputId: 'in-1', tool: 'delete_file', target: 'chapters/ch01.md', projectRoot });
  await null;
  const firstText = state.pending()[0].confirmation_text;
  state.decide({ decisionId: state.pending()[0].decision_id, choice: 'confirm', text: firstText });
  await first;

  const second = state.request({ inputId: 'in-1', tool: 'delete_file', target: 'chapters/ch02.md', projectRoot });
  await null;
  const secondText = state.pending()[0].confirmation_text;
  assert.notEqual(secondText, firstText);
  assert.throws(
    () => state.decide({ decisionId: state.pending()[0].decision_id, choice: 'confirm', text: firstText }),
    assertCode('PERMISSION_CONFIRMATION_MISMATCH'),
  );

  state.decide({ decisionId: state.pending()[0].decision_id, choice: 'confirm', text: secondText });
  assert.equal((await second).allowed, true);
});
