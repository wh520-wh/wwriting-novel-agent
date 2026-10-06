// /export（规格 2026-10-07 T3）：markdown 形态（纯函数）与落盘（重名后缀链）。
// buildExportMarkdown 消费的是 agent/replay.mjs 的重演项——这里用构造好的 items 钉形态，
// 「哪些轮次」的取舍由 replay.test.mjs 钉，两边不重复。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildExportMarkdown, writeExportFile } from '../../src/terminal/export.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

test('buildExportMarkdown：头部 meta、用户/思考/正文/状态四类项、计划附加', () => {
  const markdown = buildExportMarkdown({
    items: [
      { kind: 'user', text: '写第一章' },
      { kind: 'thinking', durationMs: 12_400 },
      { kind: 'prose', text: '临渊城的雨下了三天。' },
      { kind: 'status', terminal: 'completed' },
      { kind: 'status', terminal: 'interrupted', interruptReason: 'user_stop' },
    ],
    plan: [
      { text: '列大纲', status: 'completed' },
      { text: '写正文', status: 'in_progress' },
      { text: '收尾', status: 'pending' },
    ],
    meta: {
      sessionId: 'sess-9',
      title: '长夜灯',
      exportedAt: new Date(2026, 9, 7, 15, 30),
      turns: 1,
    },
  });

  // 头部：meta 四行 + 分隔线；标题缺失时占位「—」。
  assert.match(markdown, /^# 对话导出\n/);
  assert.match(markdown, /- 会话：sess-9/);
  assert.match(markdown, /- 标题：长夜灯/);
  assert.match(markdown, /- 导出时间：2026-10-07 15:30/);
  assert.match(markdown, /- 轮数：1/);
  // 用户段、思考行（与屏幕同一份文案）、正文原样、终态行（R5 同源）。
  assert.match(markdown, /## 用户\n\n写第一章/);
  assert.match(markdown, /\*思考 12 秒\*/);
  assert.ok(markdown.includes('临渊城的雨下了三天。'));
  assert.match(markdown, /\*已完成\*/);
  assert.match(markdown, /\*已停止\*/);
  // 计划：完成打勾、进行中注明、待办空框。
  assert.match(markdown, /## 任务计划\n\n- \[x\] 列大纲\n- \[ \] 写正文（进行中）\n- \[ \] 收尾/);
});

test('buildExportMarkdown：无标题/无计划/空 items 也不产生空洞段落', () => {
  const markdown = buildExportMarkdown({
    items: [{ kind: 'user', text: '写第一章' }],
    plan: null,
    meta: { sessionId: null, title: '', exportedAt: new Date(2026, 0, 2, 3, 4), turns: 1 },
  });
  assert.match(markdown, /- 会话：—/);
  assert.match(markdown, /- 标题：—/);
  assert.ok(!markdown.includes('任务计划'), '没有计划就不出计划节');
  assert.ok(!markdown.includes('思考'), '没有思考项就不出思考行');
});

test('writeExportFile：落创作目录根、重名自动后缀、绝不覆盖已有文件', async () => {
  const root = await makeTempRoot('wwriting-export-');
  let now = 0;
  const clock = () => now;

  const first = await writeExportFile({ projectRoot: root, markdown: '第一份', clock });
  assert.equal(first.name, '对话导出-19700101-080000.md');
  assert.equal(await fs.readFile(path.join(root, first.name), 'utf8'), '第一份');

  // 同一时刻再来一份：自动 -2，不覆盖第一份。
  const second = await writeExportFile({ projectRoot: root, markdown: '第二份', clock });
  assert.equal(second.name, '对话导出-19700101-080000-2.md');
  assert.equal(await fs.readFile(path.join(root, first.name), 'utf8'), '第一份');

  // 下一秒：干净的新名字。
  now = 1000;
  const third = await writeExportFile({ projectRoot: root, markdown: '第三份', clock });
  assert.equal(third.name, '对话导出-19700101-080001.md');
});

test('writeExportFile：写不进去如实抛中文事实', async () => {
  const root = await makeTempRoot('wwriting-export-fail-');
  const failing = {
    writeFile: async () => {
      const error = new Error('EPERM');
      error.code = 'EPERM';
      throw error;
    },
  };
  await assert.rejects(
    () => writeExportFile({ projectRoot: root, markdown: 'x', clock: () => 0, fsImpl: failing }),
    /无法写入导出文件/,
  );
});
