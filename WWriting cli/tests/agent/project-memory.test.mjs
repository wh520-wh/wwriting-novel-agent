// 项目记忆的读取、哈希与注入消息构造。
// 这些规则决定了「模型跨会话记得什么」与「前缀缓存命不命中」，逐条钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PROJECT_MEMORY_BUDGET_CHARS, PROJECT_MEMORY_FILE, PROJECT_MEMORY_MISSING_TEXT,
  PROJECT_MEMORY_SKELETON, PROJECT_MEMORY_TAG, authoritySection, buildMemoryInjection,
  memoryHash, readProjectMemory, truncateMemory,
} from '../../src/agent/project-memory.mjs';

const roots = [];
async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wwmemory-'));
  roots.push(dir);
  return dir;
}
test.after(async () => {
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test('文件存在时 state=present 且带回原文', async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, PROJECT_MEMORY_FILE), '# 记忆\n- 主角：沈砚\n', 'utf8');
  const read = await readProjectMemory(root);
  assert.deepEqual(read, { state: 'present', content: '# 记忆\n- 主角：沈砚\n', errorCode: null });
});

test('文件不存在是常态，不是错误：state=missing', async () => {
  const read = await readProjectMemory(await makeRoot());
  assert.deepEqual(read, { state: 'missing', content: '', errorCode: null });
});

test('读不出来时 state=unreadable 并带回错误码', async () => {
  const root = await makeRoot();
  // 用「WWRITING.md 是个目录」制造必然的读取失败：跨平台，且不需要改权限位。
  await fs.mkdir(path.join(root, PROJECT_MEMORY_FILE));
  const read = await readProjectMemory(root);
  assert.equal(read.state, 'unreadable');
  assert.ok(typeof read.errorCode === 'string' && read.errorCode !== '');
});

test('读函数绝不写盘：missing 之后目录里仍然没有 WWRITING.md（ADR-0007）', async () => {
  const root = await makeRoot();
  await readProjectMemory(root);
  assert.deepEqual(await fs.readdir(root), []);
});

test('CRLF 的 WWRITING.md 在读取边界归一成 \\n，下标区间仍能原样切回权威文件小节', async () => {
  // WWRITING.md 是手可编辑的文件（铁律 7），Windows 编辑器默认写 CRLF。
  const root = await makeRoot();
  await fs.writeFile(
    path.join(root, PROJECT_MEMORY_FILE),
    '## 当前有效要求\r\n- 第三人称\r\n\r\n## 权威文件\r\n- 总纲：OUTLINE.md\r\n\r\n## 持久事实\r\n'
      + `${'很长的一段持久事实。'.repeat(50)}\r\n`,
    'utf8',
  );
  const read = await readProjectMemory(root);
  assert.equal(read.state, 'present');
  assert.ok(!read.content.includes('\r'), '读回来必须是纯 \\n');
  const found = authoritySection(read.content);
  assert.equal(read.content.slice(found.start, found.end), found.text,
    'CRLF 下标错位会切坏记忆正文——这一条钉住读取边界已经把换行归一');
  assert.equal(found.text, '## 权威文件\n- 总纲：OUTLINE.md\n');
  // 端到端：截断用的是同一组下标，索引节必须完整保住（这个文件超预算才走截断）。
  const { text } = truncateMemory(read.content, 80);
  assert.ok(text.includes('- 总纲：OUTLINE.md'), '索引段不能被切坏');
  // 修复前这里会漏下半个 \r\n：下标错位让切剩的碎片带着 CR 进注入文本。
  assert.ok(!text.includes('\r'), '截断结果里不能留下孤立的 \\r');
});

test('同样的内容得到同样的哈希，差一个字符就不同', () => {
  // 钉**字面量摘要**而不是 memoryHash('abc') === memoryHash('abc')：后者是同一纯函数算两遍，
  // 恒真（只有引入随机盐才会红）。字面量能把「hash 算法/编码被悄悄换掉」这条回归打红。
  assert.equal(memoryHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(memoryHash('abc'), memoryHash('abd'));
  assert.equal(memoryHash('abc').length, 64);
});

test('骨架照抄上游的六小节结构，且不预填任何内容', () => {
  assert.ok(PROJECT_MEMORY_SKELETON.startsWith('---\nschema_version: 1\n---\n'));
  assert.ok(PROJECT_MEMORY_SKELETON.includes('# WWriting 项目记忆'));
  // 写作风格区（T4）：技能分区选型结果的落点（技能/修饰/流派三行），空区留给模型填。
  for (const section of ['## 项目定位', '## 写作风格', '## 当前有效要求', '## 权威文件', '## 当前进度', '## 持久事实', '## 待确认']) {
    assert.ok(PROJECT_MEMORY_SKELETON.includes(section), `缺小节 ${section}`);
  }
  const styleAt = PROJECT_MEMORY_SKELETON.indexOf('## 写作风格');
  assert.ok(styleAt > PROJECT_MEMORY_SKELETON.indexOf('## 项目定位') && styleAt < PROJECT_MEMORY_SKELETON.indexOf('## 当前有效要求'), '风格区属于「这部作品是什么」，紧跟项目定位');
  // R13：这两行**不是**逐字来自上游。上游 renderInitialProjectMemory 只在 title / positioning
  // 非空时才输出 `- 项目：<值>`，两值为空时那两行变成 ""，再被 project-memory.mjs:54 的
  // .filter() 折叠掉——上游的空骨架里根本没有它们。本项目刻意保留空行：
  // P2 要的是「小节固定、内容留空」，滤掉就等于没有位置可填，模型只能自己发明格式。
  assert.ok(PROJECT_MEMORY_SKELETON.includes('- 项目：'), '保留空的项目行（有据的偏离，不是照抄）');
  assert.ok(PROJECT_MEMORY_SKELETON.includes('- 题材：'), '保留空的题材行');
  // 铁律 7：小节固定，但绝不预填内容。
  assert.ok(!PROJECT_MEMORY_SKELETON.includes('玄幻'), '不预填题材');
  assert.ok(!/\d+\s*章/.test(PROJECT_MEMORY_SKELETON), '不预填章节数');
  assert.ok(!/\d+\s*字/.test(PROJECT_MEMORY_SKELETON), '不预填字数');
  assert.ok(PROJECT_MEMORY_SKELETON.endsWith('\n'));
});

test('authoritySection 定位「## 权威文件」整节（含标题），返回文本与下标区间', () => {
  const content = [
    '## 当前有效要求', '- 第三人称', '',
    '## 权威文件', '- 总纲：OUTLINE.md', '- 设定：SETTING.md', '',
    '## 当前进度', '- 第一章已完成', '',
  ].join('\n');
  const found = authoritySection(content);
  assert.equal(found.text, '## 权威文件\n- 总纲：OUTLINE.md\n- 设定：SETTING.md\n');
  assert.equal(content.slice(found.start, found.end), found.text, '下标区间必须能原样切回这一段');
});

test('没有「## 权威文件」小节时 text 为空串、区间为 null', () => {
  const found = authoritySection('## 当前进度\n- 写着\n');
  assert.deepEqual({ text: found.text, start: found.start, end: found.end }, { text: '', start: null, end: null });
});

test('文件里更早处引用了同样的文本时，定位到的仍是真正的那一节（R10）', () => {
  // 用户在「持久事实」里抄了一份索引当备忘——String.replace 会删掉错的那一段，
  // 按下标定位不会。这是审查抓出来的一条真 bug。
  const content = [
    '## 持久事实',
    '- 备份一下索引：',
    '## 权威文件',
    '- 抄的：COPY.md',
    '',
    '## 权威文件',
    '- 总纲：OUTLINE.md',
    '',
  ].join('\n');
  const found = authoritySection(content);
  // 取**第一个**真正的小节标题。两个都长得一样时，取靠前那个是可接受的确定性行为，
  // 关键是：切出来的必须是「从某个标题行到下一个 ## 之前」的完整一段，不能是拼接的碎片。
  assert.equal(content.slice(found.start, found.end), found.text);
  assert.ok(found.text.startsWith('## 权威文件\n'));
  assert.ok(found.text.includes('- 抄的：COPY.md'));
});

test('「## 权威文件」落在文件末尾且末行不带换行符时，下标仍精确、切出来的是原样片段', () => {
  // 手工编辑的 WWRITING.md 末行常常没有换行符（铁律 7：它是手可编辑的文件）。
  // 这种输入下「每行 +1 个换行符」的下标累加会把末尾那个不存在的换行符也算进去，
  // 区间于是越过真实正文——截断正是按这组下标从原文里摘索引段的，越界就会切出不存在的字符。
  const content = `## 持久事实\n${'很长的一段持久事实。'.repeat(20)}\n\n## 权威文件\n- 总纲：OUTLINE.md`;
  const found = authoritySection(content);
  assert.equal(content.slice(found.start, found.end), found.text, '下标区间必须能原样切回这一段');
  assert.equal(found.text, '## 权威文件\n- 总纲：OUTLINE.md', 'text 就是原文那一段，不凭空补换行符');
  assert.equal(found.end, content.length, '区间末端不能越过原文长度');
  assert.ok(!found.text.endsWith('\n'), '原文末行没有换行符，切出来就不该有');
  // 超预算走截断时，索引段必须是原文的**原样片段**（不能多出原文里不存在的字符）。
  const { text, omittedChars } = truncateMemory(content, 100);
  const segment = text.slice(text.indexOf('## 权威文件'), text.indexOf('\n\n（本文已截断'));
  assert.ok(content.includes(segment), `索引段必须原样来自原文，实际切出 ${JSON.stringify(segment)}`);
  assert.ok(omittedChars > 0);
});

test('不超预算时原样返回，omittedChars 为 0', () => {
  assert.deepEqual(truncateMemory('短内容', 100), { text: '短内容', omittedChars: 0 });
});

test('超预算时保住「## 权威文件」整节，其余取前 N 字符，并如实报省略量', () => {
  const authority = '## 权威文件\n- 总纲：OUTLINE.md\n';
  const content = `## 当前有效要求\n- 第三人称\n\n${authority}\n## 持久事实\n${'很长的一段持久事实。'.repeat(200)}`;
  const { text, omittedChars } = truncateMemory(content, 200);
  assert.ok(text.includes('- 总纲：OUTLINE.md'), '索引段是价值最高的部分，必须保住');
  assert.ok(text.startsWith('## 当前有效要求'), '其余部分从头取');
  assert.ok(text.includes('（本文已截断'), '模型也要知道自己拿到的是截断版');
  assert.ok(omittedChars > 0);
  assert.ok(text.length <= 200 + 40, '注入文本大致守在预算内（说明行是小常数开销）');
});

test('预算连权威文件小节都放不下时，只留小节', () => {
  const authority = `## 权威文件\n${'- 文件：OUTLINE.md\n'.repeat(50)}`;
  const { text } = truncateMemory(`## 当前进度\n- 写着\n\n${authority}`, 80);
  assert.ok(text.startsWith('## 权威文件'), '索引优先于一切');
});

test('默认预算就是 PROJECT_MEMORY_BUDGET_CHARS', () => {
  const content = 'x'.repeat(PROJECT_MEMORY_BUDGET_CHARS + 10);
  const byDefault = truncateMemory(content);
  const byExplicit = truncateMemory(content, PROJECT_MEMORY_BUDGET_CHARS);
  // 与「显式传入同一常量」的结果逐字相同，才真的测到「默认参数就是它」——
  // 只断言 omittedChars >= 10 的话，默认值被悄悄改成 5000 也照样绿。
  assert.equal(byDefault.text, byExplicit.text);
  assert.equal(byDefault.omittedChars, byExplicit.omittedChars);
  assert.ok(byDefault.omittedChars >= 10);
});

test('present：注入带标记的独立 user 消息，内容是标记行 + 原文', () => {
  const built = buildMemoryInjection({ state: 'present', content: '# 记忆\n- 主角：沈砚\n' });
  assert.equal(built.message.role, 'user');
  assert.equal(built.message.content, `${PROJECT_MEMORY_TAG}\n# 记忆\n- 主角：沈砚\n`);
  assert.equal(built.hash, memoryHash('# 记忆\n- 主角：沈砚\n'));
  assert.deepEqual({ omittedChars: built.omittedChars, state: built.state }, { omittedChars: 0, state: 'present' });
});

test('missing：注入一条字节恒定的短提示（前缀缓存照样命中）', () => {
  const a = buildMemoryInjection({ state: 'missing', content: '' });
  const b = buildMemoryInjection({ state: 'missing', content: '' });
  assert.equal(a.message.content, `${PROJECT_MEMORY_TAG}\n${PROJECT_MEMORY_MISSING_TEXT}\n`);
  assert.equal(a.message.content, b.message.content);
  assert.equal(a.hash, b.hash);
});

test('unreadable：不注入任何消息（降级为无记忆），但 state 如实带出', () => {
  const built = buildMemoryInjection({ state: 'unreadable', content: '' });
  assert.deepEqual({ message: built.message, hash: built.hash, state: built.state },
    { message: null, hash: null, state: 'unreadable' });
});

test('注入消息的总长守在预算内——标记行也算在里面（R10）', () => {
  const content = `## 权威文件\n- 总纲：OUTLINE.md\n\n## 持久事实\n${'x'.repeat(PROJECT_MEMORY_BUDGET_CHARS * 2)}`;
  const built = buildMemoryInjection({ state: 'present', content });
  assert.ok(built.message.content.length <= PROJECT_MEMORY_BUDGET_CHARS,
    `实际 ${built.message.content.length}，上限 ${PROJECT_MEMORY_BUDGET_CHARS}`);
  assert.ok(built.message.content.startsWith(`${PROJECT_MEMORY_TAG}\n`));
});

test('缺失提示的注入消息也在预算内（它本来就短，但要钉住这条不变量）', () => {
  const built = buildMemoryInjection({ state: 'missing', content: '' });
  assert.ok(built.message.content.length <= PROJECT_MEMORY_BUDGET_CHARS);
});

test('哈希按**原文**算：截断版与原文哈希相同，因此内容没变就复用同一条消息（ADR-0006）', () => {
  const content = `## 权威文件\n- 总纲：OUTLINE.md\n\n## 持久事实\n${'x'.repeat(PROJECT_MEMORY_BUDGET_CHARS + 500)}`;
  const first = buildMemoryInjection({ state: 'present', content });
  const second = buildMemoryInjection({ state: 'present', content });
  assert.equal(first.hash, memoryHash(content));
  assert.equal(first.hash, second.hash);
  assert.equal(first.message.content, second.message.content, '字节级一致才叫短路');
  assert.ok(first.omittedChars > 0);
});
