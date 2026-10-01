// 工具目录（tools/tool-catalog.mjs）的完整性测试：三张视图同源、顺序稳定、
// 与真实工具服务的方法名对齐。新增工具时只该改 tool-catalog.mjs 一处——
// 这里把「改一处就够了」钉死：schema、方法名、标签三者缺一即红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { TOOL_LABELS, TOOL_METHODS, TOOL_SCHEMAS } from '../../src/tools/tool-catalog.mjs';
import { createDefaultToolsFactory } from '../../src/agent/run-controller.mjs';

test('TOOL_SCHEMAS 顺序稳定且每个条目都是合法的 function 声明', () => {
  // 顺序即模型看到的工具清单：拆分收敛时钉下这份顺序，之后不得悄悄变化。
  assert.deepEqual(
    TOOL_SCHEMAS.map((schema) => schema.function.name),
    [
      'list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'count_text',
      'read_skill', 'update_plan', 'append_chapter_segment', 'commit_chapter', 'rollback_chapter',
      'read_continuity', 'style_stats',
    ],
  );
  for (const schema of TOOL_SCHEMAS) {
    assert.equal(schema.type, 'function');
    assert.equal(typeof schema.function.description, 'string');
    assert.equal(schema.function.description.length > 0, true, `${schema.function.name} 缺描述`);
    assert.equal(typeof schema.function.parameters, 'object');
  }
});

test('三视图同源：每个模型工具都有标签与方法名，键集一致', () => {
  const schemaNames = TOOL_SCHEMAS.map((schema) => schema.function.name);
  for (const name of schemaNames) {
    assert.equal(typeof TOOL_LABELS[name], 'string', `${name} 缺人话标签`);
    assert.equal(typeof TOOL_METHODS[name], 'string', `${name} 缺方法名`);
  }
  assert.deepEqual(Object.keys(TOOL_METHODS).sort(), [...schemaNames].sort(),
    '方法名视图与 schema 视图必须是同一批工具');
});

test('极端工具只存在于标签里：模型看不到 schema，也没有方法可调（铁律 4）', () => {
  const schemaNames = new Set(TOOL_SCHEMAS.map((schema) => schema.function.name));
  const methodNames = new Set(Object.keys(TOOL_METHODS));
  for (const name of ['delete_file', 'delete_dir', 'clear_session', 'clear_history', 'reset_session', 'run_command']) {
    assert.equal(typeof TOOL_LABELS[name], 'string', `${name} 的确认卡需要人话标签`);
    assert.equal(schemaNames.has(name), false, `${name} 不该下发给模型`);
    assert.equal(methodNames.has(name), false, `${name} 不该有可调方法`);
  }
});

test('TOOL_METHODS 与默认工具工厂的方法名一一对应（目录 ↔ 运行时的隐式耦合钉成显式断言）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wwriting-catalog-'));
  try {
    // 工厂只要求两个服务的**接口**（read / commit / prepareRollback / readContinuity），
    // 这里只查方法存在性，不调用——替身给空实现即可。
    const skillService = { read: async () => ({}) };
    const chapterService = {
      commit: async () => ({}),
      prepareRollback: async () => null,
      readContinuity: () => ({}),
    };
    const tools = createDefaultToolsFactory(skillService, chapterService)({ projectRoot: root });
    for (const [name, method] of Object.entries(TOOL_METHODS)) {
      assert.equal(typeof tools[method], 'function', `${name} 声明的方法 ${method} 在默认工具工厂上不存在`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('三张视图都被冻结：运行时不许被意外改动', () => {
  assert.equal(Object.isFrozen(TOOL_SCHEMAS), true);
  assert.equal(Object.isFrozen(TOOL_METHODS), true);
  assert.equal(Object.isFrozen(TOOL_LABELS), true);
});
