// 设定档案服务测试（update_memory 的落盘侧）。
// 全部用 os.tmpdir() 临时创作目录 + 真实文件系统，零 mock（失败注入只动 rename 一处）。
// 断言的是契约：两份档案恒等（I4）、合并幂等、冲突照实记、门禁点名文件、失败不留半文件。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { MemoryToolError, createMemoryService, renderContinuityMarkdown } from '../../src/tools/memory.mjs';

const tempRoots = [];
after(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeService(prefix, fsImpl = fs) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(projectRoot);
  return { service: createMemoryService({ fs: fsImpl }), projectRoot };
}

async function writeChapter(projectRoot, relPath, text = '第一章正文。') {
  const abs = path.join(projectRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
  return abs;
}

test('首次更新惰性创建 memory/：两份档案落盘，返回各组的实际新增计数', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-first-');
  await writeChapter(projectRoot, '第一章.md');
  const result = await service.update({
    projectRoot,
    path: '第一章.md',
    facts: [{ entity: '林昭', attribute: '身份', value: '青云门弟子', quote: '林昭拜入青云门' }],
    timeline: [{ story_time_raw: '黄昏', events: ['林昭入门', '领取腰牌'] }],
    characters: [{ name: '林昭', traits: ['执拗'], status: '初入青云门' }],
  });
  assert.deepEqual(result, {
    ok: true,
    path: '第一章.md',
    facts_added: 1,
    timeline_added: 1,
    characters_added: 1,
    timeline_violations: [],
  });
  const json = JSON.parse(await fs.readFile(path.join(projectRoot, 'memory', 'continuity.json'), 'utf8'));
  assert.equal(json.schema_version, 3);
  assert.deepEqual(json.facts[0], {
    entity: '林昭', attribute: '身份', value: '青云门弟子',
    path: '第一章.md', quote: '林昭拜入青云门', conflict_with: null,
  });
  assert.equal(json.timeline[0].path, '第一章.md');
  assert.deepEqual(json.timeline[0].events, ['林昭入门', '领取腰牌']);
  assert.deepEqual(json.characters[0], { name: '林昭', traits: ['执拗'], status: '初入青云门', path: '第一章.md' });
  // md 打印件逐字断言（独立手算的期望，不是复算渲染函数）。
  const md = await fs.readFile(path.join(projectRoot, 'memory', 'continuity.md'), 'utf8');
  assert.equal(
    md,
    [
      '# 设定档案（continuity）',
      '',
      '## 事实',
      '### 林昭',
      '- 身份: 青云门弟子 (第一章.md)',
      '',
      '## 时间线',
      '- 第一章.md [黄昏]: 林昭入门；领取腰牌',
      '',
      '## 角色',
      '- 林昭（初入青云门）：执拗',
      '',
      '## 伏笔台账',
      '- 无记录',
      '',
    ].join('\n'),
  );
});

test('I4：md 恒等于 json 的渲染打印件，跨多次更新不漂移', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-i4-');
  await writeChapter(projectRoot, '01.md');
  await service.update({ projectRoot, path: '01.md', facts: [{ entity: '甲', attribute: '身份', value: '樵夫' }] });
  await service.update({ projectRoot, path: '01.md', facts: [{ entity: '乙', attribute: '所在', value: '青云门' }] });
  const json = JSON.parse(await fs.readFile(path.join(projectRoot, 'memory', 'continuity.json'), 'utf8'));
  const md = await fs.readFile(path.join(projectRoot, 'memory', 'continuity.md'), 'utf8');
  assert.equal(md, renderContinuityMarkdown(json));
});

test('合并幂等：重复调用不产生重复条目，计数如实归零', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-idem-');
  await writeChapter(projectRoot, '01.md');
  const args = {
    projectRoot,
    path: '01.md',
    facts: [{ entity: '甲', attribute: '身份', value: '樵夫' }],
    timeline: [{ events: ['进山'] }],
    characters: [{ name: '甲', traits: ['沉默'], status: '健康' }],
  };
  await service.update(args);
  const repeat = await service.update(args);
  assert.deepEqual(repeat, {
    ok: true, path: '01.md',
    facts_added: 0, timeline_added: 0, characters_added: 0,
    timeline_violations: [],
  });
  // 事件串变化（同章新增一条时间线）才再记一条。
  const extended = await service.update({ ...args, timeline: [{ events: ['进山', '遇袭'] }] });
  assert.equal(extended.timeline_added, 1);
  const json = JSON.parse(await fs.readFile(path.join(projectRoot, 'memory', 'continuity.json'), 'utf8'));
  assert.equal(json.facts.length, 1);
  assert.equal(json.timeline.length, 2);
  assert.equal(json.characters.length, 1);
});

test('同属性不同值：照实标冲突不调和，conflict_with 指向旧记录', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-conflict-');
  await writeChapter(projectRoot, '01.md');
  await service.update({ projectRoot, path: '01.md', facts: [{ entity: '甲', attribute: '身份', value: '樵夫' }] });
  const second = await service.update({ projectRoot, path: '01.md', facts: [{ entity: '甲', attribute: '身份', value: '青云门弟子' }] });
  assert.equal(second.facts_added, 1);
  const json = JSON.parse(await fs.readFile(path.join(projectRoot, 'memory', 'continuity.json'), 'utf8'));
  assert.equal(json.facts.length, 2, '两条都保留，不悄悄覆盖');
  assert.equal(json.facts[1].conflict_with, '01.md: 樵夫');
  const md = await fs.readFile(path.join(projectRoot, 'memory', 'continuity.md'), 'utf8');
  assert.match(md, /⚠ 与既有记录冲突（01\.md: 樵夫）/);
});

test('characters 按名合并：traits 去重合并、status 取最新，合并不算新增', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-char-');
  await writeChapter(projectRoot, '01.md');
  await service.update({
    projectRoot, path: '01.md',
    characters: [{ name: '林昭', traits: ['执拗', '重诺'], status: '受伤' }],
  });
  const second = await service.update({
    projectRoot, path: '01.md',
    characters: [{ name: '林昭', traits: ['重诺', '多疑'], status: '康复' }],
  });
  assert.equal(second.characters_added, 0, '按名合并的是同一角色');
  const json = JSON.parse(await fs.readFile(path.join(projectRoot, 'memory', 'continuity.json'), 'utf8'));
  assert.equal(json.characters.length, 1);
  assert.deepEqual(json.characters[0].traits, ['执拗', '重诺', '多疑']);
  assert.equal(json.characters[0].status, '康复');
});

test('单实体 facts 上限 20：超出后最早的一条被淘汰', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-cap-');
  await writeChapter(projectRoot, '01.md');
  const facts = Array.from({ length: 21 }, (_, i) => ({
    entity: '甲', attribute: `属性${String(i + 1).padStart(2, '0')}`, value: `值${i + 1}`,
  }));
  await service.update({ projectRoot, path: '01.md', facts });
  const json = JSON.parse(await fs.readFile(path.join(projectRoot, 'memory', 'continuity.json'), 'utf8'));
  const mine = json.facts.filter((f) => f.entity === '甲');
  assert.equal(mine.length, 20);
  assert.equal(mine.some((f) => f.attribute === '属性01'), false, '最早的一条被淘汰');
  assert.equal(mine.some((f) => f.attribute === '属性21'), true);
});

test('阈值照上游：quote≤80、events≤10、traits≤10、每数组≤50、非法时间字段归一', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-thresh-');
  await writeChapter(projectRoot, '01.md');
  await service.update({
    projectRoot,
    path: '01.md',
    facts: Array.from({ length: 55 }, (_, i) => ({
      entity: `实体${i}`, attribute: 'a', value: 'v', quote: '引'.repeat(100),
    })),
    timeline: [{
      events: Array.from({ length: 12 }, (_, i) => `事件${i}`),
      story_time_raw: '原'.repeat(200),
      time: { kind: 'bogus', elapsed: 'yesterday', anchor: { type: 'age', raw: '十'.repeat(80), subject: '林昭' }, confidence: 'medium' },
    }],
    characters: Array.from({ length: 55 }, (_, i) => ({
      name: `角色${i}`, traits: Array.from({ length: 15 }, (_, j) => `特征${j}`),
    })),
  });
  const json = JSON.parse(await fs.readFile(path.join(projectRoot, 'memory', 'continuity.json'), 'utf8'));
  assert.equal(json.facts.length, 50);
  assert.equal(json.facts[0].quote.length, 80);
  assert.equal(json.timeline.length, 1);
  assert.equal(json.timeline[0].events.length, 10);
  assert.equal(json.timeline[0].story_time_raw.length, 120);
  assert.deepEqual(json.timeline[0].time, {
    kind: 'scene', elapsed: null, confidence: 'low',
    anchor: { type: 'age', raw: '十'.repeat(60), subject: '林昭' },
  });
  assert.equal(json.characters.length, 50);
  assert.equal(json.characters[0].traits.length, 10);
});

test('门禁：引用的章节文件不存在 → 一行中文事实拒绝并点名文件，零写入', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-gate-');
  await assert.rejects(
    () => service.update({ projectRoot, path: '09.md', facts: [{ entity: '甲', attribute: 'a', value: 'v' }] }),
    (error) => {
      assert.equal(error instanceof MemoryToolError, true);
      assert.equal(error.code, 'CHAPTER_NOT_FOUND');
      assert.match(error.message, /09\.md/);
      return true;
    },
  );
  await assert.rejects(() => fs.stat(path.join(projectRoot, 'memory')), { code: 'ENOENT' }, '门禁失败不建 memory/');
});

test('门禁：条目级 path 引用的章节也要存在', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-gate-entry-');
  await writeChapter(projectRoot, '01.md');
  await assert.rejects(
    () => service.update({
      projectRoot,
      path: '01.md',
      facts: [{ entity: '甲', attribute: 'a', value: 'v', path: 'absent.md' }],
    }),
    (error) => {
      assert.equal(error.code, 'CHAPTER_NOT_FOUND');
      assert.match(error.message, /absent\.md/);
      return true;
    },
  );
});

test('门禁：文件存在即放行，不要求先提交或入账（轻量门禁，Q29）', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-gate-light-');
  await writeChapter(projectRoot, '草稿.md');
  const result = await service.update({ projectRoot, path: '草稿.md', facts: [{ entity: '甲', attribute: 'a', value: 'v' }] });
  assert.equal(result.ok, true);
});

test('空参数拒绝：三组都没有有效条目就不写盘', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-empty-');
  await writeChapter(projectRoot, '01.md');
  await assert.rejects(
    () => service.update({ projectRoot, path: '01.md' }),
    (error) => {
      assert.equal(error.code, 'MEMORY_UPDATE_EMPTY');
      assert.equal(typeof error.message, 'string');
      assert.notEqual(error.message, '');
      return true;
    },
  );
  await assert.rejects(() => fs.stat(path.join(projectRoot, 'memory')), { code: 'ENOENT' });
});

test('原子写失败不留半文件：md 落盘失败时 json 回滚（无旧文件则不新建）', async () => {
  const failingRename = async (from, to) => {
    if (path.basename(to) === 'continuity.md') {
      throw Object.assign(new Error('模拟权限拒绝'), { code: 'EPERM' });
    }
    return fs.rename(from, to);
  };
  const fsImpl = { ...fs, rename: failingRename };
  const { service, projectRoot } = await makeService('wwriting-mem-rollback-', fsImpl);
  await writeChapter(projectRoot, '01.md');
  await assert.rejects(
    () => service.update({ projectRoot, path: '01.md', facts: [{ entity: '甲', attribute: 'a', value: 'v' }] }),
    (error) => {
      assert.equal(error instanceof MemoryToolError, true);
      assert.equal(error.code, 'MEMORY_WRITE_FAILED');
      assert.match(error.message, /保持原样/);
      return true;
    },
  );
  await assert.rejects(() => fs.stat(path.join(projectRoot, 'memory', 'continuity.json')), { code: 'ENOENT' });
  const leftovers = (await fs.readdir(path.join(projectRoot, 'memory'))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '不留临时文件');
});

test('原子写失败回滚：有旧档案时逐字恢复', async () => {
  const failingRename = async (from, to) => {
    if (path.basename(to) === 'continuity.md') {
      throw Object.assign(new Error('模拟权限拒绝'), { code: 'EPERM' });
    }
    return fs.rename(from, to);
  };
  // 建档用真实 fs 成功写入；失败注入只作用于第二次更新的服务。
  const { service, projectRoot } = await makeService('wwriting-mem-rollback-old-');
  await writeChapter(projectRoot, '01.md');
  await service.update({ projectRoot, path: '01.md', facts: [{ entity: '甲', attribute: 'a', value: 'v' }] });
  const before = await fs.readFile(path.join(projectRoot, 'memory', 'continuity.json'), 'utf8');
  const failingService = createMemoryService({ fs: { ...fs, rename: failingRename } });
  await assert.rejects(
    () => failingService.update({ projectRoot, path: '01.md', facts: [{ entity: '乙', attribute: 'b', value: 'w' }] }),
    () => true,
  );
  const after = await fs.readFile(path.join(projectRoot, 'memory', 'continuity.json'), 'utf8');
  assert.equal(after, before, '回滚后与旧档案逐字一致');
});

test('伏笔台账照实渲染：桌面版留下的非空 foreshadows 不能被吞掉（I4）', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-foreshadow-');
  await writeChapter(projectRoot, '01.md');
  // 直接种一份「桌面版格式」的档案：章号 + 未收/已收各一条。
  await fs.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'memory', 'continuity.json'), `${JSON.stringify({
    schema_version: 3,
    facts: [], timeline: [], characters: [],
    foreshadows: [
      { content: '断刃的来历', planted_chapter: 2, expected_payoff_hint: '祖辈旧事', status: 'open', paid_chapter: null },
      { content: '失踪的驿马', planted_chapter: 1, expected_payoff_hint: '', status: 'paid', paid_chapter: 5 },
    ],
  }, null, 2)}\n`, 'utf8');

  await service.update({ projectRoot, path: '01.md', facts: [{ entity: '甲', attribute: 'a', value: 'v' }] });
  const md = await fs.readFile(path.join(projectRoot, 'memory', 'continuity.md'), 'utf8');
  assert.match(md, /- 【未收】第2章埋设：断刃的来历（回收提示：祖辈旧事）/);
  assert.match(md, /- 【已收】第1章埋设 → 第5章回收：失踪的驿马/);
  assert.equal(md.includes('- 无记录'), false, '有内容就不该说无记录');
  // I4：md 仍恒等于 json 渲染。
  const json = JSON.parse(await fs.readFile(path.join(projectRoot, 'memory', 'continuity.json'), 'utf8'));
  assert.equal(md, renderContinuityMarkdown(json));
});

test('档案形状异常（合法 JSON 但不是对象）→ 拒绝且零写入，绝不静默当空档案覆盖', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-shape-');
  await writeChapter(projectRoot, '01.md');
  await fs.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
  const jsonPath = path.join(projectRoot, 'memory', 'continuity.json');
  await fs.writeFile(jsonPath, '[]', 'utf8');

  await assert.rejects(
    () => service.update({ projectRoot, path: '01.md', facts: [{ entity: '甲', attribute: 'a', value: 'v' }] }),
    (error) => {
      assert.equal(error.code, 'MEMORY_CONTINUITY_UNREADABLE');
      assert.equal(error.details.errorCode, 'JSON_SHAPE_INVALID');
      return true;
    },
  );
  assert.equal(await fs.readFile(jsonPath, 'utf8'), '[]', '损坏的档案原样保留，绝不覆盖');
});

test('顶层 path 必填：缺了就拒绝，不靠条目级 path 兜底', async () => {
  const { service, projectRoot } = await makeService('wwriting-mem-path-');
  await writeChapter(projectRoot, '01.md');
  await assert.rejects(
    () => service.update({ projectRoot, facts: [{ entity: '甲', attribute: 'a', value: 'v', path: '01.md' }] }),
    (error) => {
      assert.equal(error.code, 'MEMORY_PATH_INVALID');
      assert.match(error.message, /章节路径/);
      return true;
    },
  );
  await assert.rejects(() => fs.stat(path.join(projectRoot, 'memory')), { code: 'ENOENT' });
});
