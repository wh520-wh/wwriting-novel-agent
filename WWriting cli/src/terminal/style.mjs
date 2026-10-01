// 调色与纯格式层：SGR 调色表、工具人话标签、以及全部「事件事实 → 一行中文」的纯函数。
// 这里是渲染知识里**可以脱离 stdout 独立存在**的那一层：select / input / terminal/replay
// 只 import 这一份，就不会把 markdown、事件事实、工具摘要拖进输入路径。
// 依赖纪律：本层只准 import metrics（全库唯一的宽度口径），不准碰任何有状态的模块。
import {
  clipToWidth, displayWidth, padDisplayEnd, resolveColumns, takeProseRows,
} from './metrics.mjs';
// 工具 → 人话标签的表住在 tools/tool-catalog.mjs（与 schema/方法名同一处定义，
// 新增工具只改一处）；这里只保留「标签 → 活动行文案」的拼装。
import { TOOL_LABELS } from '../tools/tool-catalog.mjs';

const ESC = '\x1b[';
export const STYLE = Object.freeze({
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  strike: `${ESC}9m`,
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
  // Markdown 的标签（markdown.mjs 的语义名 → 这里的样式）：
  italic: STYLE.italic,
  dim: STYLE.dim,
  strike: STYLE.strike,
  h1: `${STYLE.bold}${STYLE.underline}`,
  // 计划条目：完成 = 压暗 + 删除线（§4.2「实心勾 + 步骤删除线」）；进行中 = 强调色 + 加粗。
  done: `${STYLE.dim}${STYLE.strike}`,
  active: `${STYLE.accent}${STYLE.bold}`,
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

// 纯函数版配色。选择器（select.mjs）与渲染器共用同一份「什么算颜色」的实现，
// 免得两处对 NO_COLOR 的理解出现分歧。
export function paintText(text, tone = 'info', useColor = false) {
  const style = TONE[tone] ?? '';
  return useColor ? `${style}${text}${STYLE.reset}` : text;
}

// 活动行标签：有目标就带上目标，未知工具退回「工具 <name>」，不要静默吞掉信息。
export function activityLabel(tool, target = null) {
  const label = TOOL_LABELS[tool] ?? `工具 ${tool ?? ''}`.trim();
  return typeof target === 'string' && target !== '' ? `${label} ${target}` : label;
}

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
export const THINKING_PREVIEW_LINES = 2;
const THINKING_LABEL = '思考中';
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
