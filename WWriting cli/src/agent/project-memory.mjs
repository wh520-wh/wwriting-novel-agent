// WWRITING.md 项目记忆：跨会话的「这部作品现在是什么状态」。
//
// 为什么需要它：会话内记忆（history.mjs）只让模型记得**这次会话里**发生过什么。
// 关掉终端明天再来，模型不知道主角叫沈砚、这座城叫临渊。本模块补的就是这一段——
// 每轮开工前读一次创作目录里的 WWRITING.md，作为一条带标记的独立消息注入上下文。
//
// 三条不可动摇的边界：
//   ① **只读，绝不写盘**（ADR-0007）。WWRITING.md 只能由模型经 write_file / edit_file 写入，
//      因此天然走权限确认；本模块连 writeFile 都不 import。骨架只是**一段文本**，
//      由 system prompt 交给模型，程序不拿它去创建任何文件。
//   ② **判据是内容不是事件**（ADR-0006）。哈希按**原文**算：内容没变就得到同一条
//      字节级一致的注入消息，DeepSeek 的前缀缓存照旧命中；内容变了才付一次前缀失效。
//      所以这里没有「刚 /init 过所以刷新」这类事件式判据，也没有「首轮」概念。
//   ③ **「缺失」是常态不是错误**（铁律 7：缺少 WWRITING.md 不影响聊天、读取与普通编辑）。
//      缺失时注入一条**字节恒定**的短提示——字节不变，缓存照样命中；用户中途删掉文件，
//      下一轮模型自然看到缺失并提议重建，不需要重启会话。
//      「读不出来」（权限、是个目录、编码坏）才是异常，走降级：不注入 + 一条中文事实。
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const PROJECT_MEMORY_FILE = 'WWRITING.md';

// 注入上限（字符数）。**独立于** DEFAULT_HISTORY_BUDGET_CHARS（24000）——那是会话历史的预算，
// 这是记忆的预算，两件事不该共用一个旋钮。
// 取 8000 的理由：WWRITING.md 是**索引**不是正文。8000 字已经能写下很长的要求清单；
// 它真要大，正确做法是它指向的外面那些文件（OUTLINE.md / SETTING.md）变大，而不是它自己变大。
export const PROJECT_MEMORY_BUDGET_CHARS = 8000;

// ADR-0008：作为**带标记的独立合成消息**注入，不塞进 system prompt。
// 标记的作用是「结构上可与真实用户输入区分」——历史投影、预算估算、渲染归属都靠它，
// 绝不靠「内容长得像不像」来猜。
export const PROJECT_MEMORY_TAG = '[Project Memory: WWRITING.md]';

// 缺失时注入的那条短提示。**必须字节恒定**：它是前缀缓存的一部分，
// 任何随时间/轮次变化的措辞都会让缓存每轮失效。
export const PROJECT_MEMORY_MISSING_TEXT = '本项目尚无 WWRITING.md。用户删除它表示要求重建记忆。';

// 新建时的骨架：照抄上游 renderInitialProjectMemory（D:/WWriting/src/core/project-memory.mjs:28-55）
// 的**六小节结构**与前导块。照抄的理由：`schema_version: 1` 让将来程序能稳定解析，
// 六个小节名是对「记忆里该有什么」的成熟划分（定位/要求/索引/进度/事实/待确认）。
// 它与事件日志的 EVENT_SCHEMA_VERSION 是**两套独立版本号**：那里加事件类型不必升它，
// 这里改骨架才升它。名字沿用上游的 `schema_version`，便于将来与桌面版互通。
//
// **与上游有一处有据的偏离（R13）**：上游只在 title / positioning 非空时才输出
// `- 项目：<值>` / `- 题材：<值>`，两值为空时那两行变成 ""，再被 :54 的
// `.filter((line, index, all) => line !== "" || all[index - 1] !== "")` 折叠掉——
// 所以上游的空骨架里**根本没有这两行**。本项目刻意保留它们的空形态：
// P2 要的是「小节固定、内容留空」，把行滤掉就等于没给模型留位置，它只能自己发明格式，
// 而「每次 /init 长得不一样」正是铁律 7 要防的事。
//
// 「## 权威文件」这一节是关键——它让 WWRITING.md 充当索引，指向 OUTLINE.md / SETTING.md，
// 模型再按需用 read_file 去读。这里**不记**字数与最后修改时间：那是会过期的数字，
// 记忆里写过期的数字比不写更糟。
//
// 这段文本**只经 system prompt 交给模型**，由模型用 write_file 写出去（经用户确认）。
// 本模块绝不拿它创建文件——那会绕过 permissions.mjs 的 WRITE_TOOLS 确认、违反 ADR-0007，
// 也会让 smoke-windows.ps1:281 那条「没有私自生成 WWRITING.md」的断言失去意义。
//
// 铁律 7 的「不生成固定蓝图」指的是**不预填内容**：小节固定，里面留空是允许的。
export const PROJECT_MEMORY_SKELETON = [
  '---', 'schema_version: 1', '---', '',
  '# WWriting 项目记忆', '',
  '## 项目定位', '- 项目：', '- 题材：', '',
  // 写作风格区（ADR-0014）：Agent 技能选型的落点——技能/修饰/流派三行，
  // 修饰与流派无则省略。空区留给模型按选型规则填，程序不预填（铁律 7）。
  '## 写作风格', '',
  '## 当前有效要求', '',
  '## 权威文件', '',
  '## 当前进度', '',
  '## 持久事实', '',
  '## 待确认', '',
].join('\n');

// 截断时在注入文本末尾追加的说明。模型也要知道自己拿到的是截断版，
// 否则它会以为「持久事实」那一节真的是空的。
const TRUNCATION_NOTE = '（本文已截断，完整内容请用 read_file 读 WWRITING.md。）';

export function memoryHash(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

// 三态 → 内容哈希（ADR-0006 的短路判据）。**按原文算，不按注入文本算**：
// 判据是「WWRITING.md 的内容变没变」，不是「截断后的文本变没变」。
// 单独抽出来是为了让调用方（run-controller 的 loadMemory）能在**构造注入消息之前**先比哈希——
// 否则每次缓存命中都要白跑一遍截断（超预算时那是整份切行 + 逐行正则 + 拼回 8KB）。
// 规则仍然只有这一处：buildMemoryInjection 也调它。
// unreadable 没有哈希可言（内容读不出来），返回 null = 永不命中缓存。
export function memoryHashFor({ state, content = '' } = {}) {
  if (state === 'missing') return memoryHash(PROJECT_MEMORY_MISSING_TEXT);
  if (state === 'present') return memoryHash(content);
  return null;
}

// WWRITING.md 是**手可编辑**的文件（铁律 7），Windows 上的编辑器写出来默认是 CRLF。
// 所以真实文件进本模块的唯一入口先统一换行，再往下走——authoritySection 的「行号 → 字符下标」
// 是按**每个换行符占 1 个字符**逐行累加的（`lines[index].length + 1`），CRLF 下每行要多占 1 个字符，
// 累出来的下标会整体前移；而 truncateMemory 恰恰用这组下标从原文里把「## 权威文件」整节切出来，
// 下标错位切出来的就是**被切坏的记忆正文**，不只是少算几个字符。
// 归一放在读取边界而不是 authoritySection 里：这里一并把 memoryHash / authoritySection /
// truncateMemory / buildMemoryInjection 都放进同一个 `\n` 的世界，谁都不必再猜换行是什么形态。
function normalizeNewlines(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

// 读一次 WWRITING.md。**不产生任何副作用**：不创建文件、不写盘、不碰 mtime。
// 三态是刻意的：missing 与 unreadable 必须分开——前者是常态（注入固定提示），
// 后者是异常（降级为无记忆 + 一条中文事实）。
export async function readProjectMemory(projectRoot, { fs: fsImpl = { readFile } } = {}) {
  const target = path.join(projectRoot, PROJECT_MEMORY_FILE);
  try {
    const content = await fsImpl.readFile(target, 'utf8');
    return { state: 'present', content: typeof content === 'string' ? normalizeNewlines(content) : '', errorCode: null };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'missing', content: '', errorCode: null };
    return { state: 'unreadable', content: '', errorCode: error?.code ?? 'UNKNOWN' };
  }
}

// 定位「## 权威文件」整节（含标题行，到下一个 ## 或文件末尾为止）。
// 返回**文本 + 下标区间**而不只是文本（R10）：截断时要按区间把这一节从原文里摘出来，
// 用 String.replace(text, '') 只替换第一处——文件里更早处若抄了同样一段（用户在
// 「持久事实」里备份索引是很自然的写法），删掉的就是错的那一段。
//
// 这一节是截断时唯一必须保住的部分：它让 WWRITING.md 充当**索引**，
// 指向 OUTLINE.md / SETTING.md，模型再按需用 read_file 去读——索引指向真相，正文可以截。
//
// 两个正则提到模块顶层：它们是**逐行**跑的（几万行的文件就是几万次求值），
// 而正则字面量每次求值都会新造一个 RegExp 对象。
const AUTHORITY_HEADING = /^\s*##\s+权威文件\s*$/;
const SECTION_HEADING = /^\s*##\s/;

export function authoritySection(content) {
  const source = String(content ?? '');
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => AUTHORITY_HEADING.test(line));
  if (start === -1) return { text: '', start: null, end: null };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (SECTION_HEADING.test(lines[index])) { end = index; break; }
  }
  // 小节末尾的空行不算内容：留着会让截断后的文本多出无意义的空行。
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  // 行号 → 字符下标。逐行累加而不是用 indexOf(text)：文件里可能有多处相同文本，
  // indexOf 会指到第一处去，那正是 String.replace 犯的同一个错。
  let charStart = 0;
  for (let index = 0; index < start; index += 1) charStart += lines[index].length + 1;
  let charEnd = charStart;
  for (let index = start; index < end; index += 1) charEnd += lines[index].length + 1;
  // 每行都按「行内容 + 1 个换行符」累加，这对「后面还有行」的行是精确的；但**文件最后一行可能不带换行符**
  // （手工编辑、部分编辑器保存出来就是这样），那时这个 +1 多算了 1 个字符，下标会越过真实正文。
  // 夹到 source.length：常规情形下这是恒等操作，只有末行缺换行符时才会真正生效。
  charEnd = Math.min(charEnd, source.length);
  // text 直接切原文这一段，而不是 join 回头再补一个 '\n'：这样 `content.slice(start, end) === text`
  // 就是**构造出来的**，任何输入都成立，不必再依赖「join 的结果恰好等于原文那一段」这个巧合——
  // 末行缺换行符时那个巧合不成立（切出来没有 '\n'，join 出来的却有一个）。
  // 末尾带换行符的常规情形下，这里的切法与原先的 join + '\n' 字节完全一致。
  return { text: source.slice(charStart, charEnd), start: charStart, end: charEnd };
}

// 超限时的截断（P4 的选项 a）：保住「## 权威文件」小节，其余从头取，取到预算用完为止。
// 不选「从头截 N 字符」是因为那可能把最有价值的索引段截掉；
// 不选「只注入路径 + 小节标题」是因为那会多一次工具往返，而 8000 字符本来就够放索引。
//
// budgetChars 是**留给文件内容的**预算，调用方（buildMemoryInjection）已经先扣掉了标记行的长度，
// 所以「注入消息的总长 ≤ PROJECT_MEMORY_BUDGET_CHARS」这条不变量由调用方守住（R10）。
export function truncateMemory(content, budgetChars = PROJECT_MEMORY_BUDGET_CHARS) {
  const source = String(content ?? '');
  const budget = Number.isFinite(budgetChars) && budgetChars > 0
    ? Math.floor(budgetChars) : PROJECT_MEMORY_BUDGET_CHARS;
  if (source.length <= budget) return { text: source, omittedChars: 0 };

  const found = authoritySection(source);
  // 按下标区间摘出索引段，剩下的部分按原文顺序从头取（R10：不用 String.replace）。
  const rest = found.start === null
    ? source
    : `${source.slice(0, found.start)}${source.slice(found.end)}`;
  // 预留的是「说明行 + 拼装开销」：说明行本身，加上它前面那处 "\n\n"、末尾补的那个 "\n"，
  // 再加上正文段与索引段之间**可能**还有的一处 "\n\n"。按最坏情况（三段都在）预留，
  // 否则注入总长会溢出预算——R10 的不变量是按「≤ 预算」硬断言的，不留余量。
  const noteCost = TRUNCATION_NOTE.length + 5;
  const room = budget - noteCost - found.text.length;

  let head = '';
  let keptAuthority = found.text;
  if (room > 0) {
    head = rest.slice(0, room);
  } else {
    // 预算连权威文件小节都放不下：索引优先于一切，正文一个字不留，小节自己也截到放得下。
    keptAuthority = found.text.slice(0, Math.max(0, budget - noteCost));
  }

  const parts = [];
  if (head !== '') parts.push(head.replace(/\s+$/, ''));
  if (keptAuthority !== '') parts.push(keptAuthority.replace(/\s+$/, ''));
  parts.push(TRUNCATION_NOTE);

  // omittedChars 报的是「原文里有多少字符没进注入文本」。说明行不计入——它不是原文的一部分。
  // 这个数字要客观（铁律 6）：按真正保留下来的原文字符数算，不估算。
  const keptSourceChars = head.length + keptAuthority.length;
  return { text: `${parts.join('\n\n')}\n`, omittedChars: Math.max(0, source.length - keptSourceChars) };
}

// 三态 → 一条注入消息（或 null）。
//
// 返回的 hash 一律按**原文**算，不按注入文本算：ADR-0006 的短路判据是「WWRITING.md 的内容
// 变没变」，而不是「注入文本变没变」。内容没变 → 哈希没变 → 复用上一条字节级一致的消息。
export function buildMemoryInjection({ state, content = '', budgetChars = PROJECT_MEMORY_BUDGET_CHARS } = {}) {
  if (state === 'unreadable') {
    // 降级为「无项目记忆」（D3 的选项 a）：message 为 null，本轮照常跑。
    // 失忆好过开不了工。
    //
    // **注意这里返回的是一个对象，不是 null**（R2）：调用方（agent-loop）据此仍然发一条
    // memory_applied 事件，好让渲染层说出那一条降级事实。返回 null 会让那条分支变成死代码——
    // 而这条事实必须落进 scrollback（final: true），不能走会被重绘抹掉的动态行。
    return { message: null, hash: null, omittedChars: 0, state: 'unreadable' };
  }
  if (state === 'missing') {
    return {
      message: { role: 'user', content: `${PROJECT_MEMORY_TAG}\n${PROJECT_MEMORY_MISSING_TEXT}\n` },
      hash: memoryHashFor({ state }),
      omittedChars: 0,
      state: 'missing',
    };
  }
  if (state !== 'present') return { message: null, hash: null, omittedChars: 0, state: 'none' };
  // 预算先扣掉标记行（R10）：标记行是注入消息的一部分，不扣就会超出 8000 这个承诺。
  const room = Math.max(0, budgetChars - PROJECT_MEMORY_TAG.length - 1);
  const { text, omittedChars } = truncateMemory(content, room);
  return {
    message: { role: 'user', content: `${PROJECT_MEMORY_TAG}\n${text}` },
    hash: memoryHashFor({ state, content }),
    omittedChars,
    state: 'present',
  };
}
