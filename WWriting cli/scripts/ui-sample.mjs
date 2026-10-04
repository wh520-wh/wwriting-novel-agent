// 排版走查样张：把一段富样张灌进真实渲染器，人工过目垂直节奏（ADR-0019）。
// 不参与自动化测试——它的产出是给眼睛看的，验收标准是「读起来像一篇排过版的稿子」。
//
// 用法：
//   node scripts/ui-sample.mjs              按当前环境上色（TTY 下）
//   NO_COLOR=1 node scripts/ui-sample.mjs   无色，看纯结构
//   node scripts/ui-sample.mjs | cat        重定向后颜色自动关闭
import { createRenderer } from '../src/terminal/renderer.mjs';

const SAMPLE = [
  '第三章的雨夜戏改完了：删掉了第二个闪回，把钩子从章尾提到了第二场。',
  '',
  '## 这一版做了什么',
  '- 开场直接落在雨水打在招牌上的特写，砍掉两段环境铺垫',
  '- 对话从 14 轮压到 9 轮，保留了邮差试探身份的那一段',
  '- 章尾钩子换成信封上的火漆印',
  '',
  '删改对照：',
  '| 位置 | 原稿 | 修改后 |',
  '|------|------|--------|',
  '| 第二场 | 闪回童年 | 直接进入对话 |',
  '| 章尾 | 雨停 | 火漆印 |',
  '',
  '保留原文的一段：',
  '> 雨水顺着邮差的帽檐往下淌，他在信封上按了个手印，像按在一份供词上。',
  '',
  '字数统计用的命令：',
  '```text',
  'count_text → 第三章.md → 3,214 字',
  '```',
  '下一步我按这个节奏改第四章。*如果你觉得删狠了，随时喊停。*',
].join('\n');

const renderer = createRenderer({ stdout: process.stdout, env: process.env });

renderer.printIntro({
  title: '排版走查样张',
  subtitle: 'ADR-0019 垂直节奏',
  rows: [['范围', '标题/表格/围栏/引用/列表/段落 + UI 边界']],
  bottomBorder: true,
});

renderer.printUser('把第三章的雨夜戏改短一点，保持钩子');
renderer.printAssistant(SAMPLE);
renderer.printActivity({ state: 'running', label: '写入文件 第三章.md' });
renderer.printActivity({ state: 'done', label: '写入文件 第三章.md', detail: '1,240 字' });
renderer.printAssistant('改完了。要我把同一套改法套到第四章吗？');
renderer.printStatus('已完成', { final: true, tone: 'success', note: '本轮 3,820 字' });

renderer.printReasoning('用户嫌雨夜戏拖。第二场闪回和主线无关，删掉后钩子可以提前……');
renderer.printPlan([
  { summary: '删第二场闪回', status: 'completed' },
  { summary: '压缩对话轮数', status: 'completed' },
  { summary: '第四章套用同款节奏', status: 'in_progress' },
]);
renderer.printDecision({ decision_id: 'demo', level: 'write', tool: 'write_file', target: '第四章.md' });

renderer.close();
