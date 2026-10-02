// Inline 渲染（屏幕 writer）：完成内容进 scrollback，当前状态就地重绘，不切 alternate screen。
// 写出前让 composer 让位，写完恢复草稿；NO_COLOR 只关闭颜色，不关闭光标控制。
// 度量与排版是全库唯一的宽度口径（src/terminal/metrics.mjs）：渲染器消费它，
// 不再自己持有任何一份宽度判定。
import {
  clipToWidth, contentWidth, displayWidth, padDisplayEnd, proseRowWidth, resolveColumns, takeProseRows,
  CONTENT_INDENT, CONTENT_WIDTH_MAX,
} from './metrics.mjs';
// 正文 Markdown：GFM 子集语义的增量渲染（表格/列表/引用/标题/行内样式），见该模块头部说明。
import { createMarkdownWriter } from './markdown.mjs';
// 调色与纯格式层（SGR 表、工具人话标签、事件事实 → 一行中文）：本文件的输出形态都从它长出来。
// 分工：style.mjs 管「长什么样」，本文件管「把行写到 stdout」（让位/画回/实时区合成），
// 事件 → 渲染的翻译在 event-bridge.mjs——三种生命周期不再挤在一个文件里。
import {
  STYLE, THINKING_PREVIEW_LINES, activityLabel, paintText, planPanelLines, planTableLines,
  resolveColor, thinkingPreviewLines, thinkingPreviewWidth, userRows,
} from './style.mjs';

// 光标控制码：抹掉整行并把光标放回行首。
// （上移/下移由输入层负责——输入区是它的，框有几行只有它知道。）
const ERASE_LINE = '\r\x1b[K';

// 活动行标记：运行中 • / 完成 ✓ / 失败 ✗ / 已停止 −（对齐设计规格书 §4.3）。
const ACTIVITY_MARK = Object.freeze({ running: '•', done: '✓', failed: '✗', stopped: '−' });
const ACTIVITY_TONE = Object.freeze({ running: 'info', done: 'success', failed: 'error', stopped: 'warn' });

// 段首标记与续行缩进等宽，不增加署名或头像。
const PROSE_MARK = '▌';
const PROSE_LEAD = `${PROSE_MARK} `;

// 正文按完整行写出；不足一行的分片由 markdown writer 攒着，收尾时才强制写出。
export const PROSE_INDENT = CONTENT_INDENT;

// Markdown 的语义色名 → 渲染器的样式色调。markdown.mjs 不认识 ANSI，
// 这一张表是两边的唯一边界；NO_COLOR 由 paintText 统一兜底（只去标记，不去文字）。
const MARKDOWN_TONE = Object.freeze({
  bold: 'strong',
  em: 'italic',
  code: 'dim',
  strike: 'strike',
  h1: 'h1',
  rule: 'rule',
});

// createRenderer({ stdout, color, env, composer })
//   composer 可选：{ isActive?(), takeArea(), giveArea(), setLive(text) }，由 createInputReader 提供。
//     isActive() 为真时屏幕上有一个输入框；takeArea/giveArea 必须成对出现。
// 返回 { printIntro, printUser, printAssistant, printReasoning, printPlan, setLivePlan,
//        resetMarkdown, printThinkingPreview, resetThinkingPreview, printActivity, printStatus,
//        printQueue, printDecision, clearLive, close }。
export function createRenderer({
  stdout,
  color,
  env = process.env,
  composer = null,
} = {}) {
  if (!stdout || typeof stdout.write !== 'function') {
    throw new Error('渲染器需要一个可写的 stdout。');
  }
  const useColor = resolveColor({ color, env, stdout });
  // 输入区的所有权在输入层：它自己算好框有几行、下框线画在哪。渲染器只负责
  // 「让位 / 写完 / 要回来」，因此不必知道 ROW_UP 该上移几格。
  // 契约在装配点校验：给了 composer 就必须给全三个方法——缺 setLive 的残缺 composer
  // 会在第一 条动态行到达时才炸出裸 TypeError，那已经是运行中段，排查成本高得多。
  let hook = null;
  if (composer !== null && composer !== undefined) {
    const missing = ['takeArea', 'giveArea', 'setLive'].filter((name) => typeof composer[name] !== 'function');
    if (missing.length > 0) throw new Error(`渲染器的 composer 缺少能力：${missing.join('、')}。`);
    hook = composer;
  }
  const usingComposer = () => hook !== null && (typeof hook.isActive !== 'function' || hook.isActive());

  let liveOpen = false; // 有一行「当前动态状态」还没被收尾
  let closed = false;
  // 实时区里的任务面板：当前计划（null = 没有，不占行）与是否在跑（运行中展开面板，
  // 空闲收成一行 chip）。对齐 §4.2 的顶栏常驻 chip：Run 结束保留供回看，新 Run 才清。
  let livePlan = null;
  let planActive = false;
  let liveBody = null; // 当前动态行（活动行 / 思考预览）的已上色文本；与计划面板合成实时区
  let lastLiveSet; // 上一次交给 setLive 的合成文本（去重；让位之后置回 undefined）
  // 正文渲染器（Markdown 增量）：半行、表格候选行由它攒着，能定的立刻吐出来。
  // 段首标记（▌）与续行缩进等宽，缩进/折行全在 markdown.mjs 里做，渲染器只负责写出。
  const md = createMarkdownWriter({
    columns: () => stdout.columns,
    leadMark: PROSE_LEAD,
    paint: (text, tone) => paint(text, MARKDOWN_TONE[tone] ?? tone),
  });
  // 上一行落进 scrollback 的活动行（用来合并连续重复的那一行）。任何别的输出都会把它清掉。
  let lastActivity = null;
  // 思考预览：thinkingDone 是已经攒满的完整行（只留末尾几行），thinkingPending 是还不够一行的尾巴，
  // thinkingPreviewOn 表示「实时区当前这一份就是思考预览」——下一片 delta 到达时据此判断
  // 是接着上一段画，还是另起一段（一轮里可以有多个模型轮次，各自有一段思考）。
  let thinkingDone = [];
  let thinkingPending = '';
  let thinkingPreviewOn = false;
  let lastThinkingLive = null; // 上一次真正画出去的那份文本，用来做「内容没变就不重绘」

  function write(text) {
    if (text === '') return;
    lastActivity = null;
    stdout.write(text);
  }

  function paint(text, tone) {
    return paintText(text, tone, useColor);
  }

  // 输入区框线由输入层画（它自己知道框有几行），这里不再有 printInputRule。

  // 开始写一行内容：让输入区把位置让出来——擦掉整块，光标停在它原来的第一行。
  // 之后调用方写出的内容必须以 `\n` 收尾，光标才会正好落在新内容的下一行，
  // 由 closeBlock 把输入区重画在那里。
  //
  // 注意「已经让出去了」要自己记：让位之后 isActive() 就变成假了（框不在屏幕上），
  // 收尾时若再问一次 isActive()，就会把框忘在擦掉的状态（踩过一次：终态行之后框再也不出现）。
  let tookArea = false;

  function openBlock() {
    if (usingComposer()) {
      if (!tookArea) {
        hook.takeArea();
        tookArea = true;
      }
      liveOpen = false; // 让位时输入区连同上方的实时行一起没了，那件事已经过去了
      liveBody = null; // 实时区被物理擦掉：动态行不再算数，等下一次 drawLive 重新挂
      lastLiveSet = undefined; // 输入层那侧的 live 也一并没了，去重记录跟着作废
      return;
    }
    if (liveOpen) {
      write(ERASE_LINE);
      liveOpen = false;
    }
  }

  // 一行写完：把输入区画回来（用户已键入的内容与光标位置都由 readline 恢复）。
  function closeBlock() {
    if (!tookArea) return;
    tookArea = false;
    hook.giveArea();
    // 写回之后再挂上剩下的实时内容：动态行归零了（openBlock 已清），但计划面板要常在——
    // 「运行中面板 / 空闲 chip」的持久性靠这一步，而不是只在 setLivePlan 那一刻出现。
    if (liveBody !== null || livePlan !== null) refreshLive();
  }

  // 动态行：此刻正在发生的事。有输入区时它贴在框的上方（输入层负责重画），
  // 没有输入区（管道）时用 \r\x1b[K 就地重绘。
  // 动态行不会清掉「上一行活动行」的记忆——否则同一件工具在同一轮里反复失败时，
  // 那十几行就没有一行是相邻的，合并无从谈起。
  function drawLive(text, tone = 'info') {
    // 宽度闸门（缺陷猎捕报告 7）：实时区一行都不许超宽，按行截断保持行数语义；
    // 完成后落 scrollback 的那一行不经过这里，仍是全文。
    const clipped = String(text ?? '').split('\n').map((line) => clipToWidth(line, resolveColumns(stdout.columns) - 1)).join('\n');
    const body = paint(clipped, tone);
    const kept = lastActivity;
    if (usingComposer()) {
      liveOpen = true;
      lastActivity = kept;
      liveBody = body;
      refreshLive();
      return;
    }
    if (liveOpen) write(ERASE_LINE);
    write(body);
    liveOpen = true;
    lastActivity = kept;
  }

  // 收掉动态行（Run 结束、确认答复等），保证不留下半行。
  // 注意：任务面板不属于「动态行」——动态行没了它还在（Run 结束保留 chip 供回看，§4.2）。
  function endLive() {
    if (!liveOpen) return;
    liveOpen = false;
    const kept = lastActivity;
    if (usingComposer()) {
      liveBody = null;
      refreshLive();
      lastActivity = kept;
      return;
    }
    write(ERASE_LINE);
    lastActivity = kept;
  }

  // 实时区合成：动态行在上、任务面板在下（与 CC 的 spinner 区同构：当前动作是标题，
  // 计划是结构，都贴着输入框）。没有 composer（管道）时不合成——多行面板在直写流里擦不干净。
  // 合成内容去重后才交给输入层：输入层每次 setLive 都会整块重画，没变化就不打扰。
  function refreshLive() {
    if (!usingComposer()) return;
    const lines = [];
    if (liveBody !== null) lines.push(...liveBody.split('\n'));
    if (livePlan !== null) lines.push(...planPanel());
    const next = lines.length === 0 ? null : lines.join('\n');
    if (next === lastLiveSet) return;
    lastLiveSet = next;
    hook.setLive(next);
  }

  // 计划面板与全表的文案/判据都在 style.mjs（计划文案唯一来源；ADR-0017 的两种形态不变），
  // 这里只喂当前状态与画笔。
  function planPanel() {
    return planPanelLines(livePlan, { active: planActive, width: proseRowWidth(stdout.columns) }, paint);
  }

  // 任务计划进实时区（事件桥与组合根调用）：items=null 清空（新 Run 开始），
  // active 控制「运行中展开面板」还是「收成一行 chip」——Run 结束保留 chip 供回看。
  function setLivePlan(items, { active = false } = {}) {
    if (closed) return;
    const next = Array.isArray(items) && items.length > 0 ? items : null;
    const nextActive = next !== null && active === true;
    if (next === livePlan && nextActive === planActive) return; // 幂等：没有变化就不动实时区
    livePlan = next;
    planActive = nextActive;
    refreshLive();
  }

  // 丢弃未完成的 Markdown 块状态（Run / 会话边界调用）：上一轮的半截围栏、表格候选行
  // 绝不允许泄漏进下一轮——那会把新正文整段当代码渲染（评审发现的跨轮状态泄漏）。
  function resetMarkdown() {
    md.reset();
  }


  // 把待发正文里「已经完整的行」落盘。
  //   force=false（流式途中）：只落完整行，半行继续攒——绝不为了「早点显示」在句子中间断行。
  //   force=true（要写别的行了 / Run 结束 / 关闭）：半行也得吐出去，否则顺序会倒置。
  // 一次 flush 里的所有行合并成一次写出：写出次数与「行数」同量级，而不是与「分片数」同量级。
  function flushProse({ force = false } = {}) {
    // 正文渲染全在 markdown writer 里：它自己攒半行与表格候选行、自己做折行与
    // 段首标记。渲染器只把「可以写出去的行」落盘——写出次数与行数同量级。
    const lines = force ? md.flush() : md.push('');
    if (lines.length === 0) return;
    openBlock();
    write(`${lines.join('\n')}\n`);
    closeBlock();
  }

  // 启动信息按内容列折行，完整保留路径与会话 ID，续行对齐值列。
  function printIntro({
    title = '', subtitle = null, rows = [], hint = null, banner = null, indent = 2, bottomBorder = true,
  } = {}) {
    if (closed) return;
    const pad = ' '.repeat(Math.max(0, indent));
    const bannerRows = Array.isArray(banner)
      ? banner.filter((row) => typeof row === 'string' && row !== '')
      : [];
    // 大字比内容列宽时，横线跟着放宽——否则大字会从线上探出去，看着像没对齐。
    const bannerCols = bannerRows.reduce((max, row) => Math.max(max, displayWidth(row)), 0);
    const width = Math.max(
      contentWidth(stdout.columns, { indent, fallback: CONTENT_WIDTH_MAX }),
      Math.min(bannerCols, resolveColumns(stdout.columns) - indent - 2),
    );
    const lines = [];
    // 大字用主色（与环境里其它强调同源）：一行一个 escape，五行而已。
    for (const row of bannerRows) lines.push(paint(row, 'accent'));
    if (title !== '') {
      if (subtitle && displayWidth(`${title}  ${subtitle}`) <= width) {
        lines.push(`${paint(title, 'strong')}  ${paint(subtitle, 'info')}`);
      } else {
        lines.push(...takeProseRows(`${title}\n`, { width }).rows.map((row) => paint(row, 'strong')));
        if (subtitle) lines.push(...takeProseRows(`${subtitle}\n`, { width }).rows.map((row) => paint(row, 'info')));
      }
      lines.push(paint('─'.repeat(width), 'rule'));
    }
    if (rows.length > 0) {
      const keys = rows.map(([key]) => String(key));
      const column = Math.min(Math.max(...keys.map((key) => displayWidth(key))) + 3, Math.max(0, width - 8));
      for (const [key, value] of rows) {
        const prefix = column >= displayWidth(key) ? padDisplayEnd(key, column) : '';
        if (prefix === '') lines.push(...takeProseRows(`${key}\n`, { width }).rows.map((row) => paint(row, 'info')));
        const values = takeProseRows(`${value ?? ''}\n`, { width: Math.max(1, width - displayWidth(prefix)) }).rows;
        for (let index = 0; index < values.length; index += 1) {
          lines.push(`${index === 0 ? paint(prefix, 'info') : ' '.repeat(displayWidth(prefix))}${values[index]}`);
        }
      }
      if (bottomBorder) lines.push(paint('─'.repeat(width), 'rule'));
    }
    if (typeof hint === 'string' && hint !== '') {
      lines.push(...takeProseRows(`${hint}\n`, { width }).rows.map((row) => paint(row, 'info')));
    }
    if (lines.length === 0) return;
    flushProse({ force: true });
    openBlock();
    write(`${pad}${lines.join(`\n${pad}`)}\n`);
    closeBlock();
  }

  // 用户记录使用中性底色和高对比正文；NO_COLOR 不输出颜色或补白。
  function printUser(text) {
    flushProse({ force: true });
    // 内容列宽 = 正文行宽 + 缩进：用户行与正文行因此在屏幕上同宽，所有块对齐成一列。
    const width = proseRowWidth(stdout.columns) + PROSE_INDENT;
    const rows = userRows(text, { width });
    openBlock();
    if (useColor) {
      write(`${rows.map((row) => `${STYLE.bgUserBand}${STYLE.user}${row}${STYLE.reset}`).join('\n')}\n`);
    } else {
      write(`${rows.map((row) => row.replace(/\s+$/, '')).join('\n')}\n`);
    }
    closeBlock();
  }

  // 正文：可多次调用。只落「完整行」，剩下的继续攒——流式感来自「一行一行冒出来」，
  // 而不是「每 60 毫秒把半句话切下来」。没有定时器，也就没有空转的事件循环。
  function printAssistant(text) {
    if (closed || typeof text !== 'string' || text === '') return;
    const lines = md.push(text);
    if (lines.length === 0) return;
    openBlock();
    write(`${lines.join('\n')}\n`);
    closeBlock();
  }

  // 完整行变化时才重绘预览；没有 composer 时不输出临时思考片段。
  function printThinkingPreview(delta) {
    if (closed || typeof delta !== 'string' || delta === '') return;
    if (!usingComposer()) return;
    if (!thinkingPreviewOn) {
      // 另起一段：上一段（如果有）已经由 resetThinkingPreview 收走了。
      thinkingDone = [];
      thinkingPending = '';
      thinkingPreviewOn = true;
      lastThinkingLive = null;
    }
    thinkingPending += delta;
    const width = thinkingPreviewWidth(stdout.columns);
    if (width === 0) return; // 太窄：维持只有 `思考中` 的老样子
    const { rows, rest } = takeProseRows(thinkingPending, { width });
    thinkingPending = rest;
    if (rows.length === 0) return;
    for (const row of rows) {
      // 空行不进预览：实时区只有两行，一段空白占掉一行纯属浪费。
      if (row.trim() !== '') thinkingDone.push(row);
    }
    while (thinkingDone.length > THINKING_PREVIEW_LINES) thinkingDone.shift();
    const next = thinkingPreviewLines(thinkingDone, { columns: stdout.columns }).join('\n');
    if (next === lastThinkingLive) return;
    lastThinkingLive = next;
    drawLive(next, 'info');
  }

  // 收走思考预览（模型轮次结束、Run 开始）：下一片 delta 到达时从头攒。
  // 不动屏幕上的实时行——该由谁接管就由谁接管（`思考 N 秒` 或下一件工具）。
  function resetThinkingPreview() {
    thinkingDone = [];
    thinkingPending = '';
    thinkingPreviewOn = false;
    lastThinkingLive = null;
  }

  // 思考全文：压暗直出，**不做 Markdown**。
  //
  // 为什么不复用 printAssistant：那一条会跑轻量 Markdown（`**加粗**`、`` `代码` ``、围栏块），
  // 而思考正文不是给用户读的正文。上游对话样式规格书:117 的原话是「私有推理正文绝不进入活动行；
  // reasoning 内容的唯一展示入口是 §4.9」——本节就是 §4.9 在终端里的唯一入口（P21）。
  // 压暗 + 保留原始标记，两者合起来才是「这一段不是正文」的硬信号。
  //
  // 只在 /reasoning 里被调用：终端没有折叠组件，默认一律只留一行「思考 N 秒」，
  // 全文按需重放。绝不在流式过程中调用它——流式那一段由 printThinkingPreview 负责，
  // 它把内容压在**实时区**里（就地重绘、不进滚动区），全文若跟着滚进去会把正文冲没。
  function printReasoning(text) {
    if (closed || typeof text !== 'string' || text === '') return;
    flushProse({ force: true });
    const width = proseRowWidth(stdout.columns);
    const { rows, rest } = takeProseRows(text, { width });
    const all = rest === '' ? rows : [...rows, rest];
    if (all.length === 0) return;
    const pad = ' '.repeat(PROSE_INDENT);
    openBlock();
    write(`${all.map((row) => (row.trim() === '' ? '' : paint(`${pad}${row}`, 'info'))).join('\n')}\n`);
    closeBlock();
  }

  // 计划表：update_plan 的可见产物。每次整表替换都把最新状态落进 scrollback——
  // 终端的 scrollback 就是「折叠态即回看态」（P10 的终端等价物：历史版本一直在上面，
  // 最新一份在最后）。/plan 与重演也调它，三处因此长一个样——文案唯一来源在 style.mjs。
  function printPlan(items) {
    if (closed || !Array.isArray(items) || items.length === 0) return;
    flushProse({ force: true });
    openBlock();
    write(`${planTableLines(items, proseRowWidth(stdout.columns), paint).join('\n')}\n`);
    closeBlock();
  }

  // 活动行：运行中的是当前动态行（会被下一次重绘覆盖）；终态行落进 scrollback，一条活动只留一行。
  // detail 是这一行的补充事实：失败时是原因，成功时是「得到了什么」（字数 / 行数）加耗时。
  // 连续两行完全相同（同一个工具、同一个目标、同一个结果）只留第一行：
  // 模型偶尔会反复重试同一个注定失败的工具，不合并就是十几行一模一样的「✗」刷屏。
  function printActivity({ state = 'done', label = '', detail = null } = {}) {
    const mark = ACTIVITY_MARK[state] ?? ACTIVITY_MARK.done;
    const tone = ACTIVITY_TONE[state] ?? 'info';
    const note = typeof detail === 'string' && detail !== '' ? ` · ${detail}` : '';
    const line = `${mark} ${label}${note}`;
    flushProse({ force: true });
    resetMarkdown(); // 工具行 = 消息边界：上一条消息里没闭合的围栏到此为止
    if (state === 'running') {
      drawLive(line, tone);
      return;
    }
    const signature = `${tone}|${line}`;
    if (signature === lastActivity) return;
    openBlock();
    write(`${paint(mark, tone)} ${paint(`${label}${note}`, state === 'done' ? 'info' : tone)}\n`);
    lastActivity = signature;
    closeBlock();
  }

  // 状态行：默认是当前 Run 的动态状态；final 时换行留下终态，
  // 也可以带一条用户能看懂的事实（错误只呈现一条）。
  // 终态之后不再画线：输入框自带上下两条线，它就是「上一块到此结束」的那条分隔。
  function printStatus(text, { final = false, tone = 'info', detail = null, note = null } = {}) {
    if (closed) return;
    const fact = typeof detail === 'string' && detail !== '' ? `${text}：${detail}` : text;
    // note 是行尾的补充量（如本轮 tokens），与「：一条事实」分开，免得事实被数字挤到看不清。
    flushProse({ force: true });
    if (!final) {
      drawLive(text, tone);
      return;
    }
    openBlock();
    const suffix = typeof note === 'string' && note !== '' ? ` · ${note}` : '';
    write(`${paint(fact, tone)}${suffix === '' ? '' : paint(suffix, 'info')}\n`);
    closeBlock();
  }

  // 排队行：原文 + 排队。说明这条输入已进 FIFO，不会另起一个 Agent。
  function printQueue(text) {
    flushProse({ force: true });
    openBlock();
    write(`${paint(`${text}   排队`, 'info')}\n`);
    closeBlock();
  }

  // 确认提示：普通确认给三个选项，极端确认必须展示当次确认文字原文（铁律 4）。
  //
  // 普通确认有两种形态，由调用方通过 picker 告诉这一层（它自己不认识选择器，也不 import select.mjs）：
  //   picker=true  —— 紧接着会有一个方向键选择器接管终端，选项与按键都由它显示，
  //                   卡片因此只留一行 `需要确认：<what>` 做 scrollback 记录；
  //   picker=false —— 非 TTY / 管道 / 测试替身：用户只能在同一个输入框里用文字答，
  //                   卡片必须给一行提示，且三个选项都要列全——这一行是那条路上唯一的发现面。
  //                   提示**只列词、不列数字**（铁律 11）：
  //                   「回复 1/2/3」那种答法会让人把自己的答案当成序号输进去。
  function printDecision(decision = {}, { picker = false } = {}) {
    flushProse({ force: true });
    openBlock();
    const { level = 'write', tool = null, target = null, confirmation_text: confirmation = null } = decision;
    const what = activityLabel(tool, target);
    if (level === 'extreme') {
      write(`${paint(`极端操作确认：${what}`, 'error')}\n`);
      if (typeof confirmation === 'string' && confirmation !== '') {
        write(`${paint('把下面这行原样回复以执行：', 'info')}${paint(confirmation, 'warn')}\n`);
      }
      write(`${paint('回复「拒绝」可取消。', 'info')}\n`);
    } else {
      write(`${paint(`需要确认：${what}`, 'warn')}\n`);
      // 文字模式只在非 TTY / 管道出现（那里没有选择器），这一行提示是唯一的**发现面**，
      // 所以三个选项都要列全——否则中间那档（本条输入允许同类操作）在这里彻底隐形，
      // 用户根本不知道它存在。仍旧只列词、不列数字（铁律 11）。
      if (picker !== true) write(`${paint('回复「一次允许」「本条输入允许同类操作」或「拒绝」', 'info')}\n`);
    }
    closeBlock();
  }

  // 抹掉动态行，并把待发正文收尾。
  function clearLive() {
    flushProse({ force: true });
    endLive();
  }

  // 收尾：冲掉待发正文（含最后那半行）、结束未闭合的行，让光标停在新行行首。
  function close() {
    if (closed) return;
    resetThinkingPreview();
    flushProse({ force: true });
    endLive();
    closed = true;
  }

  return {
    printIntro,
    printUser,
    printAssistant,
    printReasoning,
    printPlan,
    setLivePlan,
    resetMarkdown,
    printThinkingPreview,
    resetThinkingPreview,
    printActivity,
    printStatus,
    printQueue,
    printDecision,
    clearLive,
    close,
  };
}

