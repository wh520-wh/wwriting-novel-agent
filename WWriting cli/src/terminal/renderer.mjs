// Inline 渲染：完成内容进 scrollback，当前状态就地重绘，不切 alternate screen。
// 写出前让 composer 让位，写完恢复草稿；NO_COLOR 只关闭颜色，不关闭光标控制。
// 度量与排版是全库唯一的宽度口径（src/terminal/metrics.mjs）：渲染器消费它，
// 不再自己持有任何一份宽度判定。
import {
  clipToWidth, contentWidth, displayWidth, padDisplayEnd, proseRowWidth, resolveColumns, takeProseRows,
  CONTENT_INDENT, CONTENT_WIDTH_MAX,
} from './metrics.mjs';
// 事件里读出的事实（终态形态、耗时口径）与历史投影共用同一份定义，见 src/agent/event-facts.mjs 的说明。
import { eventMillis, reasoningDurationMs, terminalOfEvent } from '../agent/event-facts.mjs';
// 工具结果摘要与 agent 历史投影共用同一份实现（见 src/tools/tool-summary.mjs 的说明）。
import { summarizeToolResult } from '../tools/tool-summary.mjs';

const ESC = '\x1b[';
const STYLE = Object.freeze({
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  accent: `${ESC}38;5;173m`,
  green: `${ESC}38;5;108m`,
  red: `${ESC}38;5;174m`,
  yellow: `${ESC}38;5;179m`,
  muted: `${ESC}38;5;246m`,
  rule: `${ESC}38;5;242m`,
  user: `${ESC}38;5;253m`,
  bgUserBand: `${ESC}48;5;236m`,
});

// 色调 → ANSI 颜色（SGR）。NO_COLOR 时 paint 直接返回原文。
// strong 是「加粗不加色」，用在面板标题上：即使没有颜色也依然是标题。
const TONE = Object.freeze({
  info: STYLE.muted,
  rule: STYLE.rule,
  strong: STYLE.bold,
  accent: STYLE.accent,
  success: STYLE.green,
  warn: STYLE.yellow,
  error: STYLE.red,
});

// 用户行标记：与输入提示符是同一个字符，视觉上「这一行是我说的」。
// 铁律 9 只说 Agent 消息不带头像与署名，用户行有自己的标记不冲突。
export const USER_MARK = '❯';

// `❯ ` 占两列：标记一列 + 空格一列。续行用两个空格对齐到正文起点，
// 于是「哪几行属于同一条用户消息」靠缩进就能看出来（grokbuild 的同款做法）。
const USER_MARK_WIDTH = 2;

// 每个视觉行补满内容列宽，避免长用户消息的背景色带在折行后断开。
export function userRows(text, { width = 76 } = {}) {
  const limit = Number.isFinite(width) && width > USER_MARK_WIDTH
    ? Math.floor(width)
    : 76;
  const bodyWidth = limit - USER_MARK_WIDTH;
  const source = String(text ?? '');
  const { rows, rest } = takeProseRows(source, { width: bodyWidth });
  const all = rest === '' ? rows : [...rows, rest];
  const lines = all.length === 0 ? [''] : all;
  return lines.map((row, index) => `${index === 0 ? `${USER_MARK} ` : '  '}${padDisplayEnd(row, bodyWidth)}`);
}

// 光标控制码：抹掉整行并把光标放回行首。
// （上移/下移由输入层负责——输入区是它的，框有几行只有它知道。）
const ERASE_LINE = '\r\x1b[K';

// 纯函数版配色。选择器（select.mjs）与渲染器共用同一份「什么算颜色」的实现，
// 免得两处对 NO_COLOR 的理解出现分歧。
export function paintText(text, tone = 'info', useColor = false) {
  const style = TONE[tone] ?? '';
  return useColor ? `${style}${text}${STYLE.reset}` : text;
}

// 活动行标记：运行中 • / 完成 ✓ / 失败 ✗ / 已停止 −（对齐设计规格书 §4.3）。
const ACTIVITY_MARK = Object.freeze({ running: '•', done: '✓', failed: '✗', stopped: '−' });
const ACTIVITY_TONE = Object.freeze({ running: 'info', done: 'success', failed: 'error', stopped: 'warn' });

// 段首标记与续行缩进等宽，不增加署名或头像。
const PROSE_MARK = '▌';
const PROSE_LEAD = `${PROSE_MARK} `;

// 计划表的三态标记（对齐上游 §4.2：completed 实心勾 / in_progress 箭头圆 / pending 空圆）。
const PLAN_MARK = Object.freeze({ completed: '✓', in_progress: '▶', pending: '○' });
const PLAN_TONE = Object.freeze({ completed: 'success', in_progress: 'accent', pending: 'info' });

// 工具 → 人话标签（设计规格书 §4.3；count_text 是本项目特有的客观字数工具；
// 极端工具按权限层的用词给中文，确认提示才不会出现「工具 delete_file」这种机器话）。
const TOOL_LABELS = Object.freeze({
  list_files: '查看文件列表',
  read_file: '读取文件',
  search_files: '搜索文件',
  write_file: '写入文件',
  edit_file: '修改文件',
  count_text: '统计字数',
  read_skill: '读取技能',
  update_plan: '更新计划',
  append_chapter_segment: '写入章节内容',
  commit_chapter: '提交章节',
  rollback_chapter: '回滚章节',
  read_continuity: '读取前情',
  style_stats: '统计文风',
  delete_file: '删除文件',
  delete_dir: '删除目录',
  clear_session: '清空会话',
  clear_history: '清空历史',
  reset_session: '重置会话',
  run_command: '运行命令',
});

// 正文按完整行写出；不足一行的分片留在缓冲，收尾时才强制写出。
export const PROSE_INDENT = CONTENT_INDENT;

// 轻量 Markdown：标题与强调加粗，代码压暗。NO_COLOR 只去掉标记，保留文字。
const FENCE = /^\s*```/;
export function renderProseRow(row, { code = false, color = false, indent = PROSE_INDENT, lead = null } = {}) {
  const pad = ' '.repeat(Math.max(0, indent));
  const source = String(row ?? '');
  // 空行不留缩进：段间的空行就是空行，不该带一串尾随空格（复制正文时尤其碍眼）。
  if (source.trim() === '') return '';
  // 代码块再往里让 2 格：只靠压暗不够，缩进才是「这一段不是正文」的硬信号。
  if (code) return `${' '.repeat(Math.max(0, indent) + 2)}${paintText(source, 'info', color)}`;
  const head = lead === null ? pad : lead;
  const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(source);
  const body = heading === null ? source : heading[2];
  const styled = body
    .replace(/\*\*([^*]+)\*\*/g, (whole, inner) => (color ? `\x1b[1m${inner}${STYLE.reset}` : inner))
    .replace(/`([^`]+)`/g, (whole, inner) => (color ? `\x1b[2m${inner}${STYLE.reset}` : inner));
  if (heading !== null) return `${head}${color ? `${STYLE.bold}${styled}${STYLE.reset}` : styled}`;
  return `${head}${styled}`;
}

// 活动行标签：有目标就带上目标，未知工具退回「工具 <name>」，不要静默吞掉信息。
export function activityLabel(tool, target = null) {
  const label = TOOL_LABELS[tool] ?? `工具 ${tool ?? ''}`.trim();
  return typeof target === 'string' && target !== '' ? `${label} ${target}` : label;
}

// 与历史投影共用工具结果摘要。
export { summarizeToolResult };

function formatTokens(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`;
}

// 用量 → 一行后缀（`1.2k tokens（思考 800）`）。拿不到就不显示：老事件或被中断的那些本来就没有 usage，
// 编一个 0 出来只会让人以为这轮没花钱。
// 思考量放在括号里而不是并列一项：它是 totalTokens 的**组成部分**，并列会让人以为要相加。
// 这也是 D10(b) 的全部意义——用户把强度调到 max 却看不见思考内容时，
// 这个数字是「强度真的变了」的唯一客观证据。
export function formatUsage(usage) {
  const total = usage && Number.isFinite(usage.totalTokens) ? usage.totalTokens : null;
  if (total === null || total <= 0) return null;
  const reasoning = usage && Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : 0;
  return `${formatTokens(total)} tokens${reasoning > 0 ? `（思考 ${formatTokens(reasoning)}）` : ''}`;
}

// 前缀缓存命中量 → 一行后缀。ADR-0006 的观测手段：WWRITING.md 每轮重读，
// 内容没变就复用同一条字节级一致的注入消息，缓存应当持续命中。
// **只在真的命中了才占行**（铁律 3）：命中 0 是常态（会话第一轮、内容刚变过），
// 每轮都写「缓存命中 0」会在屏幕上堆成噪音。
export function formatCacheHit(usage) {
  const hit = usage && Number.isFinite(usage.promptCacheHitTokens) ? usage.promptCacheHitTokens : 0;
  return hit > 0 ? `缓存命中 ${formatTokens(hit)}` : null;
}

// 连不上 / 流中途断掉，与「这一轮跑失败」是两回事：前者用户能做的只有检查网络、稍后重试。
// 文案因此分开（设计规格书 §4.6 要求把连接类错误单独呈现）。
const CONNECTION_FAILURES = new Set(['MODEL_NETWORK_ERROR', 'MODEL_STREAM_ERROR']);

// 一串「补充事实」拼成一行后缀：` · 3210 字 · 4 秒`。空的一律不占位。
export function joinNotes(notes) {
  const kept = notes.filter((note) => typeof note === 'string' && note !== '');
  return kept.length === 0 ? null : kept.join(' · ');
}

// 耗时的呈现口径：只报「慢到值得说」的那一档。
// 毫秒级的工具行上挂一个「0.02 秒」只是噪音；超过 2 秒才说明用户刚才确实等了一会儿。
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 2000) return null;
  const seconds = Math.round(ms / 1000);
  return `${seconds} 秒`;
}

// 终态那一句 + 它的色调 + （只在需要时）一条出路。**事件桥与屏幕重演共用这一份**（R5）。
//
// 为什么必须共用：原计划让 src/agent/replay.mjs 自己写一张 TERMINAL_STATUS 表，
// 结果重演把所有中断都说成「已停止」、所有失败都说成「操作失败」，而事件桥是区分的
// （`已中断` vs `已停止` 看 data.reason，`连接中断` 看 CONNECTION_FAILURES，`未配置` 看 code）。
// 于是重启后重演出来的历史**比用户当时看到的更不准**——那比重演更糟，
// 因为它让用户以为上次是正常停的，其实是连接断了。
//
// 入参用「轮次形态」而不是「事件形态」：Turn 有 terminal / interruptReason / failCode，
// 事件桥与历史投影都用 agent/event-facts.mjs 的 terminalOfEvent 把自己那条事件映射成同一个形状。
// 映射只有一处，文案因此也只有一处。
//
// `hint` 是「用户接下来该做什么」，**只有 `未配置` 带它**：那是唯一一种用户自己能修好的终态。
// 它和主文案一起长在这一处，事件桥按键取用——绝不让调用方去匹配主文案的**文字**
// （改一个字、或本地化，那条分支就会静默失效，用户丢掉唯一的出路提示）。
// 重演不画它：历史轮上冒出一句操作指引是噪音，路径指引只对「刚刚发生的事」有意义。
export function terminalStatusText({ terminal, interruptReason = null, failCode = null } = {}) {
  if (terminal === 'completed') return { text: '已完成', tone: 'success' };
  if (terminal === 'interrupted') {
    // `aborted` 是「模型侧取消」（如立即打断），`user_stop` 是用户按了停止——
    // 两者在屏幕上必须能分开，否则用户看不出是自己停的还是被顶掉的。
    return interruptReason === 'aborted'
      ? { text: '已中断', tone: 'warn' }
      : { text: '已停止', tone: 'warn' };
  }
  if (terminal === 'failed') {
    if (failCode === 'MODEL_NOT_CONFIGURED') {
      // 不是故障：引导页允许跳过 Key，用户就是想先进来写点东西。怎么配由 hint 说。
      return { text: '未配置', tone: 'warn', hint: '用 /model 设置模型与 API Key 后重试。' };
    }
    return CONNECTION_FAILURES.has(failCode)
      ? { text: '连接中断', tone: 'error' }
      : { text: '操作失败', tone: 'error' };
  }
  // 崩溃残留（run_started 没有终态）：如实说它没结束，绝不猜它成功了。
  return { text: '未正常结束', tone: 'warn' };
}

// 思考耗时四舍五入，最小 1 秒；没有可信耗时时只报已完成。
export function formatThinkingSeconds(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '已完成思考';
  return `思考 ${Math.max(1, Math.round(ms / 1000))} 秒`;
}

// 思考预览仅占实时区最近两行，全文落盘并通过 /reasoning 查看。
const THINKING_PREVIEW_LINES = 2;
export const THINKING_LABEL = '思考中';
// 前缀 `思考中 · ` 与续行缩进等宽，两行的正文因此左对齐成一列（CJK 按显示宽度算）。
const THINKING_PREFIX = `${THINKING_LABEL} · `;
const THINKING_INDENT = ' '.repeat(displayWidth(THINKING_PREFIX));
// 一行正文至少要有这么多列才值得预览；放不下就退回只有状态行的老样子，
// 绝不把正文挤成每行两三个字（那既读不懂，又会与终端自动折行抢行数）。
const THINKING_MIN_BODY = 20;

// 预览正文一行能放多少显示列；0 表示这个宽度下不做预览。
export function thinkingPreviewWidth(columns) {
  const cols = resolveColumns(columns);
  const body = cols - displayWidth(THINKING_PREFIX) - 1; // 末尾留 1 列，避免触发终端自动折行
  return body >= THINKING_MIN_BODY ? body : 0;
}

// 思考实时区仅保留最后两行。
export function thinkingPreviewLines(rows, { columns } = {}) {
  const body = thinkingPreviewWidth(columns);
  if (body === 0) return [THINKING_LABEL];
  const shown = (Array.isArray(rows) ? rows : []).slice(-THINKING_PREVIEW_LINES);
  if (shown.length === 0) return [THINKING_LABEL];
  // 出口再截一次宽（缺陷猎捕报告 6）：takeProseRows 的换行分支不切宽，一条完整的
  // 逻辑行可能比预览宽度更长，前缀一加就超出终端宽度。预览是临时的，截断不丢正文。
  return shown.map((row, index) => {
    const clipped = clipToWidth(row, body);
    return index === 0 ? `${THINKING_PREFIX}${clipped}` : `${THINKING_INDENT}${clipped}`;
  });
}

// NO_COLOR 的判定：只要环境里出现了这个变量就按关闭颜色处理（宁可不上色，也不要污染管道输出）。
// color 显式传入时也压不过 NO_COLOR——要求是不输出颜色码，不是尽量不输出。
export function resolveColor({ color, env, stdout }) {
  if (env && env.NO_COLOR !== undefined && env.NO_COLOR !== null) return false;
  if (typeof color === 'boolean') return color;
  return Boolean(stdout && stdout.isTTY);
}

// createRenderer({ stdout, color, env, composer })
//   composer 可选：{ isActive?(), takeArea(), giveArea(), setLive(text) }，由 createInputReader 提供。
//     isActive() 为真时屏幕上有一个输入框；takeArea/giveArea 必须成对出现。
// 返回 { printIntro, printUser, printAssistant, printReasoning, printThinkingPreview,
//        resetThinkingPreview, printActivity, printStatus, printQueue, printDecision,
//        clearLive, close }。
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
  const hook = composer
    && typeof composer.takeArea === 'function'
    && typeof composer.giveArea === 'function'
    ? composer
    : null;
  const usingComposer = () => hook !== null && (typeof hook.isActive !== 'function' || hook.isActive());

  let liveOpen = false; // 有一行「当前动态状态」还没被收尾
  let pending = '';
  // 正文当前是否在围栏代码块里（逐行的轻量 Markdown 用）。
  let inCode = false;
  // 「上一行写出去的是正文」。段落的第一行才带模型标记——连续的行是同一段，
  // 每行都顶一个 `▌` 会把屏幕糊成一片竖线；空行或任何别的输出都会另起一段。
  // 与 lastActivity 同一个套路：状态挂在 write() 上，谁写出别的行谁就把它清掉。
  let proseOpen = false;
  let closed = false;
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
    proseOpen = false;
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
      hook.setLive(body);
      return;
    }
    if (liveOpen) write(ERASE_LINE);
    write(body);
    liveOpen = true;
    lastActivity = kept;
  }

  // 收掉动态行（Run 结束、确认答复等），保证不留下半行。
  function endLive() {
    if (!liveOpen) return;
    liveOpen = false;
    const kept = lastActivity;
    if (usingComposer()) {
      hook.setLive(null);
      lastActivity = kept;
      return;
    }
    write(ERASE_LINE);
    lastActivity = kept;
  }


  // 把待发正文里「已经完整的行」落盘。
  //   force=false（流式途中）：只落完整行，半行继续攒——绝不为了「早点显示」在句子中间断行。
  //   force=true（要写别的行了 / Run 结束 / 关闭）：半行也得吐出去，否则顺序会倒置。
  // 一次 flush 里的所有行合并成一次写出：写出次数与「行数」同量级，而不是与「分片数」同量级。
  function flushProse({ force = false } = {}) {
    if (pending === '') return;
    const width = proseRowWidth(stdout.columns);
    // 快速通道：连一行都还没攒够、也没有换行时直接返回。
    // 每个字的显示宽度至少占 1 列，所以「字符数 < 行宽」必然攒不满一行——
    // 于是每次 delta 到达都不必扫一遍显示宽度（流式逐字到达时这一条最省）。
    if (!force && pending.length < width && !pending.includes('\n')) return;
    const { rows, rest } = takeProseRows(pending, { width });
    pending = rest;
    const ready = force && pending !== '' ? [...rows, pending] : rows;
    if (force) pending = '';
    if (ready.length === 0) return;

    const lines = [];
    // 本批第一行是不是「段首」由进批时的 proseOpen 决定，之后由本批自己的行决定：
    // 空行收段（下一行重新带标记），围栏行不算正文行、也不打断这一段。
    let opened = proseOpen;
    for (const row of ready) {
      // 围栏行本身不显示，只切换「这段是代码」——代码块因此只剩缩进与压暗两件事。
      if (FENCE.test(row)) {
        inCode = !inCode;
        continue;
      }
      const blank = row.trim() === '';
      lines.push(renderProseRow(row, {
        code: inCode, color: useColor, lead: !opened && !blank && !inCode ? PROSE_LEAD : null,
      }));
      opened = !blank;
    }
    if (lines.length === 0) return; // 这一批全是围栏行：不写，也就不用为了空写而重绘一次

    openBlock();
    write(`${lines.join('\n')}\n`);
    closeBlock();
    proseOpen = opened; // write() 刚把它清掉了，这里按本批最后一行的实际情形写回
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
    pending += text;
    flushProse();
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
  // 最新一份在最后）。/plan 与重演也调它，三处因此长一个样。
  function printPlan(items) {
    if (closed || !Array.isArray(items) || items.length === 0) return;
    flushProse({ force: true });
    const width = proseRowWidth(stdout.columns);
    const done = items.reduce((count, item) => (item?.status === 'completed' ? count + 1 : count), 0);
    openBlock();
    write(`${paint('任务计划', 'strong')} ${paint(`${done}/${items.length}`, 'info')}\n`);
    for (const item of items) {
      const status = PLAN_MARK[item?.status] ? item.status : 'pending';
      const summary = typeof item?.summary === 'string' ? item.summary : '';
      // 长步骤按正文列宽折行，续行对齐到标记后的正文列（与用户行续行同一个做法）。
      const { rows, rest } = takeProseRows(`${summary}\n`, { width: Math.max(1, width - 4) });
      const all = rest === '' ? rows : [...rows, rest];
      const lines = all.length === 0 ? [''] : all;
      for (let index = 0; index < lines.length; index += 1) {
        const head = index === 0 ? `  ${paint(PLAN_MARK[status], PLAN_TONE[status])} ` : '    ';
        write(`${head}${paint(lines[index], PLAN_TONE[status])}\n`);
      }
    }
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

// —— 事件桥 ——
//
// Agent 循环不提供渲染回调，实时过程只落进事件日志（Task 6 的 D16）。
// 这里做最小适配：把「事件」翻成上面的渲染调用，并提供一个包装器，
// 让 Task 8 在装配会话管理器时把事件存储套一层，落盘成功的事件同时流向渲染器。
// 不改任何上游模块。
//
// createEventRenderer({ renderer, label, onDecision })
//   onDecision(decision) 可选，普通确认（非 extreme）到达时的**交互入口**。谁把它接上，谁就负责
//   把终端让给方向键选择器并把结果交回控制器——但它属于组合根（要 suspend/resume 常驻 readline、
//   要摸 io.stdin/stdout），所以这一层只转交事件，绝不认识选择器。
//   缺省 null = 当前终端给不出选择器：卡片退回「按文字答」的提示，既有路径一个字节不变。
export function createEventRenderer({ renderer, label = activityLabel, onDecision = null } = {}) {
  if (!renderer) throw new Error('事件桥需要可用的渲染器。');
  // 有交互入口 = 会用选择器。卡片据此少印一行提示（选项由选择器自己显示）。
  const pickerMode = typeof onDecision === 'function';
  // 排过队的输入：input_id → 原文。它们真正开跑时要补一行用户行（见 run_started）。
  const queuedInputs = new Map();
  // 工具耗时使用事件时间戳，不依赖刷新时刻。
  let activityStartedAt = null;
  // /reasoning 只重放本进程已完成轮次；全文仍存于事件日志。
  let currentRunReasoning = [];
  let lastRunReasoning = null;
  // 是否有一轮正在跑。run_started 置真、三条终态事件（run_completed / interrupted / failed）归假。
  // 它只服务 lastReasoning：**正在跑的那一轮不算「上一轮」**——见 run_started 处的注释，
  // 那是本函数的契约，之前只有注释没有代码兑现它。
  let runInFlight = false;

  function handleEvent(event) {
    if (!event || typeof event.type !== 'string') return;
    const data = event.data ?? {};
    switch (event.type) {
      case 'run_started': {
        // 排队输入开始后补上用户行；input_started 已补过时不会重复。
        const queuedText = typeof data.input_id === 'string' ? queuedInputs.get(data.input_id) : null;
        if (typeof queuedText === 'string') {
          queuedInputs.delete(data.input_id);
          renderer.printUser(queuedText);
        }
        // 新一轮开始：上一轮的思考到此为止，成为 /reasoning 的重放对象。
        // 正在跑的这一轮不算「上一轮」——它还没结束，重放半截思考会误导人。
        // lastReasoning() 用 runInFlight 兑现这条契约：在跑时只认 lastRunReasoning。
        lastRunReasoning = currentRunReasoning.length > 0 ? currentRunReasoning : null;
        currentRunReasoning = [];
        runInFlight = true;
        // 思考预览另起一段：上一轮被打断时留下的半段（还挂在 thinkingPreviewOn 上）
        // 绝不能接着算进这一轮，否则新用户的思考会从旧思考的尾巴后面长出来。
        renderer.resetThinkingPreview();
        renderer.printStatus('思考中');
        break;
      }
      case 'input_started': {
        // 队列里的一条输入真正开跑：把排队时的记录换成正常的用户行。
        // 这一刻起它的输出有主了，屏幕上不该再留一个「排队」的残影。
        const startedText = typeof data.input_id === 'string' && typeof data.text === 'string'
          ? data.text
          : (typeof data.input_id === 'string' ? queuedInputs.get(data.input_id) : null);
        if (typeof data.input_id === 'string') queuedInputs.delete(data.input_id);
        if (typeof startedText === 'string' && startedText !== '') renderer.printUser(startedText);
        break;
      }
      case 'history_applied': {
        // 只有实际省略前情（或带会话摘要）时才说明，正常载入不增加噪音。
        const kept = Number.isFinite(data.kept_turns) ? data.kept_turns : 0;
        const dropped = Number.isFinite(data.truncated_turns) ? data.truncated_turns : 0;
        const covered = Number.isFinite(data.covered_turns) ? data.covered_turns : 0;
        const digestChars = Number.isFinite(data.digest_chars) ? data.digest_chars : 0;
        if (dropped > 0 || digestChars > 0) {
          // final: true —— 这是落进 scrollback 的一条事实，不是会被重绘抹掉的动态行。
          // 动态行只属于「此刻正在发生的事」，而「这一轮记得多少」是已经确定的结果。
          renderer.printStatus('已载入前情', {
            final: true,
            tone: 'info',
            detail: joinNotes([
              kept > 0 ? `${kept} 轮` : null,
              covered > 0 ? `摘要覆盖 ${covered} 轮` : null,
              dropped > 0 ? `省略更早 ${dropped} 轮` : null,
              digestChars > 0 ? `含会话摘要` : null,
            ]),
          });
        }
        break;
      }
      case 'memory_applied': {
        // 记忆只在读取失败或截断时提示，数字与原因放在 detail。
        if (data.state === 'unreadable') {
          // 主文案 5 字，事实进 detail（铁律 3）。final: true 是这条的全部意义（R2）：
          // 「这一轮模型没有记忆」是已经确定的结果，必须落进 scrollback，
          // 不能走会被下一次重绘抹掉的动态行。
          renderer.printStatus('记忆未载入', { final: true, tone: 'warn', detail: '本轮按无记忆继续' });
          break;
        }
        const omitted = Number.isFinite(data.omitted_chars) ? data.omitted_chars : 0;
        if (omitted > 0) {
          renderer.printStatus('已载入记忆', {
            final: true, tone: 'info', detail: `过长 · 已省略 ${omitted} 字符`,
          });
        }
        break;
      }
      case 'reasoning_completed': {
        // 一个模型轮次恰好一项思考（上游对话样式规格书:180）。
        // 耗时从**事件时间戳差**算（P20）：起点是 started_at（= 本轮模型请求发起时，R4），
        // 终点是这条事件自己的 at。算法与重演共用一份（agent/event-facts.mjs）——
        // 当场说 13 秒、重启后重演说 12 秒，就是两条算法了。
        const durationMs = reasoningDurationMs(data.started_at, event.at);
        // 预览到此为止：这一段的结论是下面那行 `思考 N 秒`，实时区里那份半截文本
        // 不该再跟着下一次模型请求一起长下去（一个 Run 可以有多个模型轮次）。
        renderer.resetThinkingPreview();
        // 终态行、压暗、不落动态行：它是已经确定的结果，不是「此刻正在发生的事」。
        renderer.printStatus(formatThinkingSeconds(durationMs), { final: true, tone: 'info' });
        currentRunReasoning.push({
          text: typeof data.text === 'string' ? data.text : '',
          durationMs,
        });
        break;
      }
      case 'model_delta':
        if (typeof data.text === 'string') renderer.printAssistant(data.text);
        break;
      case 'plan_updated':
        // update_plan 落的最新整表。渲染器没有这个能力时（测试替身 / 自定义渲染器）
        // 安静跳过，不让事件桥崩掉（与 /reasoning 的 printReasoning 同一条防御）。
        if (typeof renderer.printPlan === 'function') renderer.printPlan(data.items);
        break;
      case 'activity_started':
        activityStartedAt = eventMillis(event.at);
        renderer.printActivity({ state: 'running', label: label(data.tool, data.target) });
        break;
      case 'activity_finished': {
        const state = data.aborted === true ? 'stopped' : data.ok === true ? 'done' : 'failed';
        // 失败说清「为什么」，成功说清「得到了什么」（字数 / 行数 / 命中数）；
        // 慢到值得说的那一档再补上耗时。铁律 3：一条事实，就一条。
        const detail = state === 'failed'
          ? (data.message ?? null)
          : joinNotes([summarizeToolResult(data), formatDuration(eventMillis(event.at) - activityStartedAt)]);
        renderer.printActivity({ state, label: label(data.tool, data.target), detail });
        activityStartedAt = null;
        break;
      }
      case 'input_queued':
        if (typeof data.input_id === 'string' && typeof data.text === 'string') {
          queuedInputs.set(data.input_id, data.text);
        }
        if (typeof data.text === 'string') renderer.printQueue(data.text);
        break;
      case 'input_withdrawn':
        // 撤回的排队输入永远不会开跑：别让它以后误补一行用户行。
        //
        // 但它必须**在屏幕上有个交代**：排队时已经写过一行 `排队`，若这里只是悄悄把它从
        // 追踪表里删掉，那一行就会永远挂在屏幕上，用户以为它还在等，实际已经被丢掉了
        // （一种无声的丢数据）。所以给一条终态事实，把那一条的归属说清楚。
        if (typeof data.input_id === 'string') {
          if (queuedInputs.has(data.input_id)) {
            renderer.printStatus('排队已取消', { final: true, tone: 'warn', detail: '这条输入不会执行' });
          }
          queuedInputs.delete(data.input_id);
        }
        break;
      case 'decision_pending': {
        // 确认提示承载状态，普通确认交给选择器；极端确认始终要求精确文字。
        renderer.printDecision(data, { picker: pickerMode });
        if (pickerMode && data.level !== 'extreme') {
          // 同步调用（Promise.resolve(fn()) 先执行 fn）：让选择器在本次 append 返回之前就接管终端。
          // 兜底 catch 只防「连 onDecision 自己都抛」这一层——绝不能让交互失败变成未处理拒绝（Node 会终止进程）。
          Promise.resolve(onDecision(data)).catch((error) => {
            renderer.printStatus('确认失败', { final: true, tone: 'warn', detail: error?.message ?? null });
          });
        }
        break;
      }
      case 'decision_resolved':
        // 答复之后紧接着就是工具结果或正文，不需要额外的实时状态行。
        break;
      case 'run_completed':
      case 'run_interrupted':
      case 'run_failed': {
        // 三条终态共用一份文案与色调（terminalStatusText）：屏幕重演要用**同一个函数**，
        // 否则重演出来的历史会比用户当时看到的更不准（R5）。
        //
        // 这一轮到此结束：/reasoning 从这一刻起把本轮思考当「上一轮」（runInFlight 归假）。
        runInFlight = false;
        // 事件形态 → 轮次形态的映射只有一处定义（agent/event-facts.mjs）：历史投影也调它。
        // 各写一份就会出现「新增一种终态原因，当场显示与重启重演各自解释」（R5）。
        const status = terminalStatusText(terminalOfEvent(event));
        // `未配置` 不是故障：引导页允许跳过 Key，用户就是想先进来写点东西。
        // 出路提示与那句主文案长在同一处（terminalStatusText 的 hint）——
        // 这里按键取用，绝不拿渲染出来的**文字**当控制流判据（改一个字那条分支就静默失效）。
        // 事件自己带的 message（只有 run_failed 有）比通用提示更具体，优先用它。
        // 铁律 3：错误只呈现一条事实。
        const detail = typeof data.message === 'string' && data.message !== ''
          ? data.message
          : (status.hint ?? null);
        renderer.printStatus(status.text, {
          final: true,
          tone: status.tone,
          note: joinNotes([formatUsage(data.usage), formatCacheHit(data.usage)]),
          detail,
        });
        break;
      }
      default:
        break;
    }
  }

  // 包装 Task 3 的 eventStoreFactory：落盘成功的事件转发给渲染器，其余能力原样透传。
  function wrapEventStoreFactory(eventStoreFactory) {
    if (typeof eventStoreFactory !== 'function') {
      throw new Error('事件桥需要 Task 3 的事件存储工厂。');
    }
    return (options) => {
      const store = eventStoreFactory(options);
      return {
        ...store,
        async append(partial) {
          const event = await store.append(partial);
          if (event) handleEvent(event);
          return event;
        },
        async appendBatch(partials) {
          const events = await store.appendBatch(partials);
          for (const event of events ?? []) handleEvent(event);
          return events;
        },
      };
    };
  }

  // /reasoning 的取值口。返回 null 表示「本次进程内没有可查看的思考」，
  // 命令层据此给出上游 empty 态那句原文，而不是自己编一句话。
  //
  // 契约：只给**已经跑完的上一轮**。正在跑的那一轮即使已经攒了半截思考也不算——
  // 它还会变，重放一个没成型的片段会误导人（与 run_started 处那条注释同一个契约）。
  // 跑完之后（runInFlight 归假）本轮才刚被当成「上一轮」，此时才可返回：
  // 「刚跑完就 /reasoning」是最常见的路径，那一刻 currentRunReasoning 还没被下一轮换掉。
  function lastReasoning() {
    if (runInFlight) return lastRunReasoning;
    // 上一轮没思考就答没有（缺陷猎捕报告 9）：回退到 lastRunReasoning 会把更早那一轮的
    // 思考重放出来——/effort none 或换到不回 reasoning_content 的端点之后，用户会把
    // 第一次跑的思考当成刚才那份回答的推理。回退成 null，命令层走 empty 态。
    return currentRunReasoning.length > 0 ? currentRunReasoning : null;
  }

  return { handleEvent, wrapEventStoreFactory, lastReasoning };
}
