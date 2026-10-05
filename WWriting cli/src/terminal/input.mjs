// 输入读取：唯一对话面的入口。Enter 发送，Shift+Enter 不承诺多行（首版不做多行编辑）。
//
// 输入区（框）长这样——实时状态（如果有）贴在框的上方，可以是一行，也可以是两行：
//
//     思考中 · 主角为什么不肯离开，这里需要一个理由
//              不然转折站不住
//     ────────────────────────────────
//     ❯ 写第一章
//     ────────────────────────────────
//
// 为什么要有下框线：一条上线加一个提示符，在长输出里「没有定位感」——用户找不到自己正在输入的
// 那一行。上下两条线把输入行框住；这条线同时就是「上一块到此结束」的分隔，所以屏幕上一个空行都不用留。
//
// 为什么输入区归输入层所有：readline 每次重绘（敲一个字、粘贴、外部调 _refreshLine）都会用
// clearScreenDown 把下方的内容一并擦掉，**必须在每次重绘之后**把下框线补回来。只有守着 readline
// 的这一层掌握那个时机，所以渲染器的协议是：
//     takeArea()  让出输入区（光标停在它原来的第一行，等待写 scrollback）
//     giveArea()  在光标当前位置把输入区重画回来
//     setLive()   设置框上方那一块实时状态（null = 不要；可以带换行，行数由它自己数）
// 渲染器因此不再自己算 ROW_UP/ROW_DOWN，也不必知道框有几行。
//
// 其余边界：
//   - Ctrl+C 只上报给控制器（onControl('interrupt')），这里不硬编码退出——有活动轮先停、空闲才退
//     是控制器的语义（D14），不是终端层的判断。
//   - 标准输入结束（管道读完 / Ctrl+Z 回车）同样只上报 onControl('eof')，退出路径与 Ctrl+C 共用。
//   - MinTTY（Git Bash 自带的终端）不是 Windows 控制台，readline 的原生行为不可靠；
//     检测到就输出一次「请使用 Windows Terminal 或 winpty」，然后走非交互分支，不消费输入。
//   - TTY 下 readline 自己回显输入行（含提示符），非 TTY 下不回显——调用方据此决定是否补用户行。
//   - 密钥输入**不再做隐藏回显**：那套做法（覆写 readline 的私有出口）既脆弱，又让屏幕上只剩
//     一个空提示符、用户根本看不出自己粘进去没有。代价是密钥会留在终端 scrollback 里，
//     这个取舍由用户拍板（见 decisions）。
import readline from 'node:readline';

import {
  USER_MARK, paintText, resolveColor,
} from './style.mjs';
import { displayWidth, resolveColumns, clipToWidth, fullWidthRuleLine, fullWidthRuleParts } from './metrics.mjs';
import { MENU_HINT, cycleIndex, slashMenu } from './menu.mjs';

// 提示符与用户行标记是同一个字符（renderer 的 USER_MARK），屏幕上「❯ 开头」永远是用户说的。
// 有颜色时用它上色：提示符是这条对话面上最需要一眼认出的东西。
const PLAIN_PROMPT = `${USER_MARK} `;
const MINTTY_ADVICE = '检测到 MinTTY 终端，请使用 Windows Terminal 或 winpty。';
// SGR 序列是本代码库唯一的颜色通道（paintText 家族）：量宽度前剥掉它，颜色码才不会被
// 当成可见字符占列（提示符宽度、实时区行数两处共用）。
const ANSI_SGR = /\u001b\[[0-9;]*[A-Za-z]/g;

// 提示符（带色版）。颜色判据与渲染器共用 resolveColor，NO_COLOR 下一律纯文本。
export function promptFor({ stdout, env = process.env, color } = {}) {
  return paintText(PLAIN_PROMPT, 'accent', resolveColor({ color, env, stdout }));
}

// MinTTY 特征：TERM_PROGRAM 直接自报，或 MSYS/MinGW 环境（Git Bash）但没有 Windows Terminal 标记。
// 只读环境变量，纯函数，便于单测。
export function detectMinTTY(env) {
  if (!env || typeof env !== 'object') return false;
  const program = typeof env.TERM_PROGRAM === 'string' ? env.TERM_PROGRAM.toLowerCase() : '';
  if (program === 'mintty') return true;
  const hasWindowsTerminal = typeof env.WT_SESSION === 'string' && env.WT_SESSION !== '';
  return !hasWindowsTerminal && typeof env.MSYSTEM === 'string' && env.MSYSTEM !== '' && typeof env.TERM === 'string' && env.TERM !== '';
}

// 能不能给出可交互的对话面：TTY + stdout 也是 TTY + 不是 MinTTY 环境 + 有输入流。
// 抽成纯函数是因为首次引导要在「还没建 readline」时先判断一次（它自己接管终端），
// 两处必须是同一份判据，否则会出现「引导以为能交互、输入层以为不能」的分歧。
export function isInteractiveTerminal({ stdin, stdout, env = process.env } = {}) {
  if (detectMinTTY(env)) return false;
  if (!stdin || typeof stdin.on !== 'function') return false;
  return Boolean(stdin.isTTY && stdout && stdout.isTTY);
}

// 输入区框线的一条（上框线 / 下框线都用它）。全宽口径：占满终端横轴（列数 − 1），
// 与实时区截宽、输入行折行同一份宽度事实；`❯ ` 提示符顶格落在第 1–2 列。
export function ruleTextFor({ stdout, env = process.env, color } = {}) {
  return paintText(fullWidthRuleLine({ columns: stdout?.columns }), 'rule', resolveColor({ color, env, stdout }));
}

// 读一行：给「一次问一个问题」的流程用（首次引导问 API Key、手输模型名）。
//
// 为什么单独建一个 readline 而不复用 createInputReader：对话面的 readline 是一台常驻状态机
// （提示符、回显、Ctrl+C、队列），而这里是「问一句、拿一行、就结束」。混在一起就得在两套语义
// 之间来回切换；而且引导跑在对话面之前，此时根本还没有常驻 readline。
//
// box=true 时把这一行也用上下两条线框住（与对话面同一个观感；引导页里那一行同样是「要你输入」）。
// 返回用户输入的那一行原文（可能是空串——回车即跳过）；stdin 不可用时返回 null。
export async function readOneLine({
  stdin,
  stdout,
  env = process.env,
  prompt = null,
  box = false,
} = {}) {
  const terminal = isInteractiveTerminal({ stdin, stdout, env });
  const useBox = box === true && terminal;
  const promptText = prompt ?? promptFor({ stdout, env });
  // resume 状态要还回去：真实的 readline 会把输入流 resume，
  // 关闭之后若不恢复，后续写进来的数据会因为「没有人监听 data」而被丢掉。
  const wasFlowing = Boolean(stdin) && stdin.readableFlowing === true;
  if (useBox) stdout.write(`${ruleTextFor({ stdout, env })}\n`);
  const iface = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal,
    prompt: terminal ? promptText : undefined,
  });

  try {
    const line = await new Promise((resolve) => {
      iface.once('line', resolve);
      iface.once('close', () => resolve(null));
      if (terminal) iface.prompt();
    });
    if (useBox) {
      // 回车时 readline 已经写了换行（光标在新行行首）；Ctrl+C 结束的路径上光标还停在提示符那一行，
      // 所以那一种情况要先换行再画线，免得线挤在提示符后面。
      stdout.write(line === null ? `\r\n${ruleTextFor({ stdout, env })}\n` : `${ruleTextFor({ stdout, env })}\n`);
    }
    return typeof line === 'string' ? line.replace(/\r+$/, '') : null;
  } finally {
    iface.close();
    if (!wasFlowing && typeof stdin.pause === 'function') stdin.pause();
  }
}

// createInputReader({ stdin, stdout, onSubmit, onControl, stderr, env, prompt, commands })
//   onSubmit(text, { immediate })  回车后的整行原文（未 trim；空行不触发）。
//                                  immediate=true 表示这次提交来自 Ctrl+S（「立即」语义在
//                                  控制器，输入层只负责把标记原样交出去）
//   onControl(name)    'interrupt'（Ctrl+C）| 'eof'（输入结束）| 'mode-cycle'（Shift+Tab）
// 返回 { start, stop, suspend, resume, composer }。
//   start({ initialText }) 返回 { interactive, reason }；initialText 会像用户亲手敲的一样
//   填进输入框并提交（位置参数那条路用它，屏幕上因此也是同一个框）。
//   suspend/resume 用来把终端临时交给交互式命令（`/model` 向导、权限确认卡），用完原样接回来；
//   suspend 时已键入的半行草稿会被带走，resume 时连光标位置一起写回输入框（不提交）。
export function createInputReader({
  stdin,
  stdout,
  stderr = null,
  env = process.env,
  onSubmit = null,
  onControl = null,
  prompt = null,
  menuCommands = [],
} = {}) {
  const noticeTarget = stderr ?? stdout;
  // 颜色判据与渲染器共用同一份（NO_COLOR 一律不上色），算一次就够。
  const useColor = resolveColor({ env, stdout });
  let rl = null;
  let interactive = false;
  let closing = false;
  // stop() 之后不许再 resume()：退出路径上不能再把输入框建回来。
  let disposed = false;
  // 输入区此刻画在屏幕上吗？框上方那一行的实时状态是什么？
  let areaDrawn = false;
  let liveText = null;
  // 上框线右端的常驻标签（权限模式，工单 02）：{ text, tone } | null。随 drawArea 重绘；
  // 标签长在框线行内，行数不变，擦除几何不受影响——变了只是整块多画一次。
  let ruleTag = null;
  // 下框线最后一次补画时的输入物理行数（paintBelowPrompt 维护）。快速回显路径靠
  // 「当前行数 ≠ 它」发现框线没跟上折行（真机 ConPTY 走查发现的顶穿残留）。
  let paintedRows = 0;
  // 联想菜单（工单 04/05）：menuText 是屏幕上那一帧预上色文本（null = 没画/已收），
  // paintedMenuRows 是**那一帧**的物理行数——擦除按它走（旧高纪律）：菜单变矮时若按
  // 新高上移，旧菜单的顶部行会残留在块顶之上（缺陷 10 同族）。menuSelected 跨键保持
  // 高亮位，行变化后由内核钳回合法位。menuDismissed 是 Esc 的收起标记：收起之后
  // 行内容一变就解封（「再打字重开」）；menuLineSeen 用来发现「行变了」。
  let menuText = null;
  let paintedMenuRows = 0;
  let menuSelected = 0;
  let menuDismissed = false;
  let menuLineSeen = null;
  // suspend 前带走的半行草稿（缺陷猎捕报告 3）。suspend 会真的关掉 readline：
  // 已键入的半行既不在缓冲也不在历史里，不显式承接就是无声销毁——屏幕上和缓冲里双双消失。
  // 恢复时原样写回（含光标位置）。带控制字符的半行不接（会被 readline 当按键解释）；
  // 那种输入本来就进不了正常草稿——Tab 已在拦截层吞掉（工单 06），这条正则留作兜底。
  let draftBackup = null;

  const promptText = () => prompt ?? promptFor({ stdout, env });
  const rule = () => paintText(fullWidthRuleLine({ columns: stdout.columns }), 'rule', useColor);

  // 上框线（可带右端常驻标签）：线与标签分别上色，版式由 fullWidthRuleParts 定。
  // 下框线永远素线——标签只在上框线，快速补线路径（paintBelowPrompt）不加变量。
  const topRule = () => {
    const parts = fullWidthRuleParts({ columns: stdout.columns, tag: ruleTag?.text ?? '' });
    if (parts.tag === '') return paintText(parts.rule, 'rule', useColor);
    return `${paintText(parts.rule, 'rule', useColor)} ${paintText(parts.tag, ruleTag?.tone ?? 'info', useColor)}${parts.pad}`;
  };

  // 提示符的**纯文本**宽度。带色提示符里那些 `\x1b[36m` 在终端上不占列，但按字符数算会占 9 格——
  // 用它算光标列，typed 的字就会凭空右移一大截（踩过一次）。
  const plainPromptWidth = () => displayWidth((prompt ?? PLAIN_PROMPT).replace(ANSI_SGR, ''));

  function writeOut(text) {
    if (text !== '') stdout.write(text);
  }

  function emitControl(name) {
    if (typeof onControl === 'function') onControl(name);
  }

  // 光标此刻应该在输入行的第几列（1 基）。readline 重绘之后要把光标放回去，而它只管「输入行」
  // 这一格——下面那条线是我们加的，回到哪一列得我们自己算（按显示宽度，CJK 占 2 列）。
  function cursorColumn() {
    const columns = resolveColumns(stdout.columns);
    const line = typeof rl?.line === 'string' ? rl.line : '';
    const cursor = Number.isInteger(rl?.cursor) ? Math.min(Math.max(0, rl.cursor), line.length) : line.length;
    const used = plainPromptWidth() + displayWidth(line.slice(0, cursor));
    return (used % columns) + 1;
  }

  // 补画下框线。readline 每次重绘都会用 clearScreenDown 把下面擦掉，所以每次重绘之后都要补一次。
  // 输入行折行时 readline 重绘完光标停在**逻辑位置**（可能在第 1 格物理行）——先下移到
  // 输入行的最后一格物理行再画线，否则框线压在正文第 2 格上把字盖掉（复核新发现，
  // 与猎捕报告 5 同族：报告只点名了擦除侧，补线侧同一假设）。down === 0（光标在最后一格，
  // 绝大多数敲字路径）保持既有字节序列逐字不变。
  // clearBelow：画线**之前**先在新框线行的行首清屏到底——快速回显补线用。退格/变列之后
  // 旧框线可能留在更下方的物理行上，不抹掉就是第二条框线；放画线前且光标在行首，也避开
  // 「满行待换行时 \x1b[J 从框线末格开抹」的坑。常规重绘路径不需要（readline 刚清过屏）。
  function paintBelowPrompt({ clearBelow = false } = {}) {
    if (!areaDrawn || rl === null) return;
    const { totalRows, cursorRow } = inputLayout();
    const down = Math.max(0, totalRows - cursorRow);
    const clear = clearBelow ? '\x1b[J' : '';
    writeOut(down > 0
      ? `\r\x1b[${down}B\r\n${clear}${rule()}\r\x1b[${down + 1}A\x1b[${cursorColumn()}G`
      : `\r\n${clear}${rule()}\r\x1b[1A\x1b[${cursorColumn()}G`);
    paintedRows = totalRows;
  }

  // 实时区占几**物理行**。多数时候是 1（`思考中` 这种一行状态），思考预览是 2 行；
  // 超宽的行会被终端自动折行，所以这里按「剥掉颜色码后的显示宽度 ÷ 可用列数」逐行实测，
  // 不再信任调用方「每行都不超宽」的约定——只按 `\n` 数行的话，调用方漏截宽就会少算，
  // 擦除少上移，`\x1b[0J` 从块中间开抹，实时区折出来的行永久残留（报告 5/7 的残留族）。
  // 量测收进输入层之后：调用方漏截宽最多难看（终端自己折行），不再留下擦不干净的块。
  // （渲染器 drawLive 仍按行截宽——那是为了避开「正好占满末列」的待换行卡顿，
  // 与这里的擦除正确性是两道独立的闸。）
  function liveRows(text) {
    if (text === null) return 0;
    const columns = resolveColumns(stdout.columns);
    let rows = 0;
    for (const line of String(text).split('\n')) {
      const width = displayWidth(line.replace(ANSI_SGR, ''));
      rows += Math.max(1, Math.ceil(width / columns));
    }
    return rows;
  }

  // 输入行折行后的几何：与 cursorColumn 同一套显示宽度算术与迟滞语义（used 落在整行
  // 边界上时光标还留在上一格）。totalRows 是整行占用的物理行数，cursorRow 是光标所在
  // 的物理行号（1 基）。擦除（上移到块顶）与补下框线（下移到块底）共用这一份。
  function inputLayout() {
    const columns = resolveColumns(stdout.columns);
    const line = typeof rl?.line === 'string' ? rl.line : '';
    const cursor = Number.isInteger(rl?.cursor) ? Math.min(Math.max(0, rl.cursor), line.length) : line.length;
    const usedTotal = plainPromptWidth() + displayWidth(line);
    const usedToCursor = plainPromptWidth() + displayWidth(line.slice(0, cursor));
    return {
      totalRows: Math.floor(Math.max(0, usedTotal - 1) / columns) + 1,
      cursorRow: Math.floor(Math.max(0, usedToCursor - 1) / columns) + 1,
    };
  }

  // 擦掉整个输入区（含实时行与联想菜单），光标停在输入区原来的第一行——之后要么写
  // scrollback，要么重画输入区。上移 = 实时区物理行数（实测）+ 菜单**在屏**行数（旧高，
  // 变矮的菜单靠它清掉顶部残行）+ 光标所在的输入物理行号。写死 1 在长行折行后少上移
  // k−1 格，`\x1b[0J` 会从输入块中间开抹，留下重复的输入行与游离框线（缺陷猎捕报告 5）。
  function eraseArea() {
    if (!areaDrawn || rl === null) return;
    writeOut(`\r\x1b[${liveRows(liveText) + paintedMenuRows + inputLayout().cursorRow}A\x1b[0J`);
    areaDrawn = false;
  }

  // 在光标当前位置重画输入区：实时行（可选）→ 联想菜单（可选）→ 上框线（可带标签）→
  // 输入行 → 下框线。菜单行数在写出后记账（paintedMenuRows = 现在屏幕上的那一帧）。
  function drawArea(nextLive = liveText) {
    if (rl === null || !interactive) return;
    eraseArea();
    liveText = nextLive;
    if (liveText !== null) writeOut(`${liveText}\n`);
    if (menuText !== null) writeOut(`${menuText}\n`);
    paintedMenuRows = menuText === null ? 0 : liveRows(menuText);
    writeOut(`${topRule()}\n`);
    areaDrawn = true; // 先置位：下面的 refreshLine 会触发 paintBelowPrompt
    refreshLine();
  }

  // readline 的整行重绘（会连带触发我们挂在它上面的「补下框线」）。
  function refreshLine() {
    if (rl === null) return;
    if (typeof rl._refreshLine === 'function') rl._refreshLine();
    else rl.prompt(true);
  }

  // 给 readline 挂上「重绘之前锚定块顶、重绘之后补下框线」。
  // 用私有方法是为了不漏时机：敲字、粘贴、外部调用都会经过它，而 clearScreenDown 就发生在里面。
  //
  // 锚定（真机 ConPTY 抓包定位的缺陷，与报告 5/10 同族）：readline 的整行重绘从「光标所在的
  // 物理行」起笔、且从不向上回看。输入行不折行时光标就在块首，这个假设天然成立；输入行一折行，
  // 重绘便从块中起画——旧物理行留在原处（旧帧残留）、下框线跟着锚点漂移。所以每次重绘前先
  // 把光标移回输入块首行并清屏到底，readline 的假设重新成立，残留无从产生。
  //
  // 但「光标所在行」**不能**用 rl.cursor 推算：行尾追加（粘贴、连续打字）走 readline 的
  // 快速路径——文本直接回显到屏幕、真实光标随折行下沉，却完全不经过 _refreshLine，
  // 行模型不知道屏幕已经变了（真机实测：165 字符粘贴后 rl.cursor=0，屏幕光标在第 3 行）。
  // 所以单独跟踪**真实光标**对应的行内位置 realCursor：经过 _writeToOutput 的纯文本写入
  // （快速路径回显）按追加推进，refresh 重画后与 rl.cursor 对齐。锚定按真实位置算行，
  // 模型与屏幕分叉多少都能锚回块顶。
  // 拿不到 _refreshLine 这个入口时（非 TTY / 老版本）退化成既有行为，不影响输入本身。
  function attachAreaHooks(instance) {
    if (typeof instance._refreshLine !== 'function') return;
    const refresh = instance._refreshLine.bind(instance);
    let realCursor = 0;      // 真实光标在行内的逻辑位置（与屏幕上的物理行一一对应）
    let inRefresh = false;   // refresh() 自己的写入不算回显（提示符可能也是纯文本）
    if (typeof instance._writeToOutput === 'function') {
      const writeOutput = instance._writeToOutput.bind(instance);
      instance._writeToOutput = (string_) => {
        writeOutput(string_);
        if (!inRefresh && typeof string_ === 'string' && !string_.includes('\u001b') && rl !== null) {
          const lineLength = typeof rl.line === 'string' ? rl.line.length : 0;
          realCursor = Math.min(lineLength, realCursor + string_.length);
          // 快速回显补线（真机 ConPTY 走查发现）：行尾打字/粘贴逐字回显，正文折上新物理行
          // 却不经过 _refreshLine，下框线留在旧位置被正文顶穿，残段和正文挤在同一行。
          // 行数没变一个字节都不动；变了先从光标处清掉本行残段，再按新几何把框线画回
          // 最后一格物理行之下。退格（缩回方向）走整行重绘，由刷新路径自愈，到不了这里。
          if (areaDrawn) {
            const { totalRows } = inputLayout();
            if (totalRows !== paintedRows) {
              writeOut('\x1b[K');
              paintBelowPrompt({ clearBelow: true });
            }
          }
        }
      };
    }
    instance._refreshLine = () => {
      if (areaDrawn && rl !== null) {
        // 真实光标可能因行变短而越过行尾：先钳回。按它算出所在物理行，上移到输入块首行；
        // 实时行与上框线在更上方，不能清到；清屏到底只覆盖输入行、下框线与更下方。
        const line = typeof rl.line === 'string' ? rl.line : '';
        realCursor = Math.max(0, Math.min(realCursor, line.length));
        const columns = resolveColumns(stdout.columns);
        const anchorRow = Math.floor(Math.max(0, plainPromptWidth() + displayWidth(line.slice(0, realCursor)) - 1) / columns) + 1;
        writeOut(anchorRow > 1 ? `\r\x1b[${anchorRow - 1}A\x1b[0J` : '\r\x1b[0J');
      }
      inRefresh = true;
      try {
        refresh();
      } finally {
        inRefresh = false;
      }
      // refresh 重画并按行模型把光标放回 rl.cursor：真实位置自此与模型一致。
      if (areaDrawn && rl !== null && Number.isInteger(rl.cursor)) realCursor = rl.cursor;
      paintBelowPrompt();
    };
  }

  // Shift+Tab（\x1b[Z，Node 归一为 { name:'tab', shift:true }）：切换权限模式（ADR-0020）。
  // Ctrl+S（\x13，raw 模式下 readline 对它静默忽略）：立即提交当前草稿（工单 03）。
  // 两者都必须赶在 readline 内部消费**之前**拦下：配了 completer 时 Shift+Tab 与 Tab 一样
  // 触发命令补全（实测），短路掉就不会。包私有方法与 attachAreaHooks 同一纪律；拿不到
  // _ttyWrite 这个入口（非 TTY / 老版本）就退化成既有行为，不影响输入本身。
  // 与 Enter 触发 /model 向导同一调用栈深度：控制回调里可能同步 suspend（真关 readline），
  // 这条路今天每一条斜杠命令都在走，不是新风险。
  function attachKeysHook(instance) {
    if (typeof instance._ttyWrite !== 'function') return;
    const ttyWrite = instance._ttyWrite.bind(instance);
    // 转义歧义窗口的合并残骸判据：Esc 与下一键同批到达时，Node 把两键归一成
    // meta+<键>——单字符（字母/数字）与「语义键」都在内。本应用不用 Alt 组合键，
    // 宁可放弃它们也不能丢字或丢意图（escapeCodeTimeout 收口之外的双保险）。
    const META_DEBRIS_NAMES = new Set(['space', 'backspace', 'delete', 'tab', 'return', 'enter']);
    const isMetaDebris = (key) => key && key.meta === true && key.ctrl !== true
      && typeof key.name === 'string'
      && (key.name.length === 1 || META_DEBRIS_NAMES.has(key.name));
    const handleKey = (s, key) => {
      // —— 先于 readline 消费的拦截（Shift+Tab / Ctrl+S / 菜单态按键 / Tab）——
      if (key && key.name === 'tab' && key.shift === true) {
        emitControl('mode-cycle');
        return;
      }
      if (key && key.ctrl === true && key.name === 's') {
        submitImmediate();
        return;
      }
      if (key && menuOpen() && (key.name === 'up' || key.name === 'down')) {
        // 菜单态方向键 = 移动高亮（循环），绝不翻历史；不交给 readline。
        const state = slashMenu({ line: rl.line, commands: menuCommands, selected: menuSelected });
        if (state.open) {
          menuSelected = cycleIndex(state.index, key.name === 'up' ? -1 : 1, state.matches.length);
          menuText = renderMenu({ ...state, index: menuSelected });
          if (areaDrawn) drawArea();
          return;
        }
      }
      if (key && menuOpen() && key.name === 'escape') {
        // Esc = 收起菜单；行内容一变即重开（refreshMenu 的解封纪律）。
        menuDismissed = true;
        refreshMenu();
        return;
      }
      if (key && key.name === 'tab' && key.shift !== true) {
        // Tab：菜单开着 = 补全高亮项（补全后带尾空格，token 结束菜单随之收起）；
        // 菜单关着 = 吞掉（保持「普通文本里 Tab 无操作」，也绝不让字面 \t 进草稿）。
        if (menuOpen()) {
          const state = slashMenu({ line: rl.line, commands: menuCommands, selected: menuSelected });
          if (state.open && typeof state.completion === 'string') {
            rl.line = state.completion;
            rl.cursor = rl.line.length;
            refreshLine();
            refreshMenu();
          }
        }
        return;
      }
      if (key && (key.name === 'return' || key.name === 'enter')) {
        // 回车接受之前抹菜单：此刻行模型与屏幕几何都还有效（eraseMenuInPlace 的前提）。
        eraseMenuInPlace();
      }
      ttyWrite(s, key);
      refreshMenu();
    };
    instance._ttyWrite = (s, key) => {
      // 合并残骸剥掉 meta 后**重走一遍拦截层**（tab→补全纪律、return→提交簿记都由
      // 这里承接）。单字符的 s 必须换成裸字符——原始 s 带着 \x1b 前缀，直插会污染行模型。
      if (isMetaDebris(key)) {
        const plainS = key.name === 'space' ? ' '
          : (key.name.length === 1 ? key.name : s);
        handleKey(plainS, { ...key, meta: false });
        return;
      }
      handleKey(s, key);
    };
  }

  // 提交簿记：回车（line 事件）与 Ctrl+S 共用同一份——擦框、越过框沿、回调、重画框。
  // 两路只有一个差别：回车的换行回显由 readline 自己写过了，Ctrl+S 由调用方先补。
  // 两条丢弃闸：空行（trim 后为空）绝不当提交送进 Agent；裸斜杠 `/` 也不提交——
  // 菜单退役了「空 / 回车开弹窗」的旧交互（工单 06），回车在这里就是无操作。
  function emitSubmission(text, { immediate = false } = {}) {
    const hadBox = areaDrawn;
    areaDrawn = false;
    liveText = null;
    if (text.trim() === '' || text.trim() === '/') {
      promptOnce();
      return;
    }
    // 走出框的下沿，之后的输出从这条线下面开始（屏幕上一个空行都不用留）。
    if (hadBox) writeOut('\n');
    if (typeof onSubmit === 'function') onSubmit(text, { immediate });
    // 输入框在 Agent 跑的时候照样可用（提交是 fire-and-forget，不阻塞这里）；
    // 渲染器接下来写内容时会先 takeArea()，所以这里先把框画回来不会打架。
    promptOnce();
  }

  // Ctrl+S：把当前草稿按「立即」语义交出去。拦截发生在 readline 消费 \x13 之前，
  // 行模型与屏幕都还停在草稿上——屏幕簿记按回车接受时的同一套走：光标先到行尾
  // （整行重绘，与 readline 的 accept 一致），自己补换行回显，再走共用簿记。
  // 空草稿（含纯空白）无操作且不动屏幕：空判先于一切。
  function submitImmediate() {
    if (rl === null || !interactive) return;
    const line = typeof rl.line === 'string' ? rl.line : '';
    if (line.trim() === '') return;
    eraseMenuInPlace(); // 菜单不进历史；此刻行模型还在，几何有效
    if (Number.isInteger(rl.cursor) && rl.cursor !== line.length) {
      rl.cursor = line.length;
      refreshLine();
    }
    writeOut('\r\n');
    rl.line = '';
    rl.cursor = 0;
    emitSubmission(line.replace(/\r+$/, ''), { immediate: true });
  }

  // —— 联想菜单（工单 04 内核之上的一层）：渲染、随键重算、提交时抹除 ——

  // 内核状态 → 预上色的菜单整块文本。行 = [❯/空格][命令名][说明]；说明按剩余宽度截断
  // （实时区纪律：菜单一行都不许软折行，折行会让擦除几何失效）；末尾固定一行按键提示。
  // 行数按终端高度封顶，超出的用滑动窗口承载——高亮项必须始终在场。
  function renderMenu(state) {
    const width = Math.max(1, resolveColumns(stdout.columns) - 1);
    const totalRows = Number.isFinite(stdout.rows) && stdout.rows > 0 ? stdout.rows : 24;
    // 实时区（动态行/排队/计划面板）与输入框都要留在同一屏里：菜单封顶扣掉实时区
    // 已占的物理行——不然忙碌大实时区时整块（实时+菜单+框）高过屏高，每敲一键都有
    // 块顶行被推进 scrollback（复查确立）。兜底 3 行保证菜单在矮终端仍可用。
    const maxRows = Math.max(3, totalRows - 6 - liveRows(liveText));
    const room = Math.max(1, maxRows - 1); // 提示行固定占一行
    const { matches, index } = state;
    let start = 0;
    if (matches.length > room) start = Math.max(0, Math.min(index - (room >> 1), matches.length - room));
    const rows = [];
    for (let i = start; i < matches.length && rows.length < room; i += 1) {
      const selected = i === index;
      const mark = selected ? `${USER_MARK} ` : '  ';
      const nameRoom = Math.max(0, width - displayWidth(mark));
      const name = clipToWidth(String(matches[i].name ?? ''), Math.max(1, nameRoom));
      const used = displayWidth(mark) + displayWidth(name);
      const description = typeof matches[i].description === 'string' ? matches[i].description : '';
      const desc = description !== '' ? clipToWidth(`  ${description}`, Math.max(0, width - used)) : '';
      const tone = selected ? 'accent' : 'info';
      rows.push(`${paintText(`${mark}${name}`, tone, useColor)}${desc === '' ? '' : paintText(desc, tone, useColor)}`);
    }
    rows.push(paintText(clipToWidth(MENU_HINT, width), 'info', useColor));
    return rows.join('\n');
  }

  // 菜单随行内容重算：打字、粘贴、删减全部经过 _ttyWrite，这里是唯一的出口。
  // 内容没变就不动屏幕；变了整块重画（drawArea 的擦除按 paintedMenuRows 旧高走）。
  // Esc 收起（menuDismissed）在行内容一变时解封；非交互 / 没配清单时不启用；
  // 让位期间 areaDrawn 为假，只记账不画屏。
  function refreshMenu() {
    if (rl === null || !interactive || menuCommands.length === 0) return;
    const line = typeof rl.line === 'string' ? rl.line : '';
    if (line !== menuLineSeen) {
      menuLineSeen = line;
      menuDismissed = false;
    }
    const state = slashMenu({ line, commands: menuCommands, selected: menuSelected });
    menuSelected = state.index;
    const next = state.open && !menuDismissed ? renderMenu(state) : null;
    if (next === menuText) return;
    menuText = next;
    if (areaDrawn) drawArea();
  }

  // 菜单此刻开没开（拦截层用）：以屏幕上那一帧为准——refreshMenu 在每次按键后都会刷新它。
  const menuOpen = () => menuText !== null;

  // 菜单不进历史：回车接受 / Ctrl+S 交出草稿**之前**把菜单行从屏幕上清成空行。
  // 必须在行模型还有效的时刻调用（两处调用点都在拦截层，几何此刻算得准）。
  // inline 渲染抹不掉 scrollback 的行，只能清空它们——空行落在实时区与用户行之间。
  function eraseMenuInPlace() {
    const rows = paintedMenuRows;
    menuText = null;
    menuSelected = 0;
    paintedMenuRows = 0;
    if (rows === 0 || !areaDrawn || rl === null) return;
    const { cursorRow } = inputLayout();
    // 上移到菜单顶：光标行 → 输入块顶（cursorRow − 1）→ 越过顶框线（1）→ 菜单 rows 行。
    writeOut(`\r\x1b[${cursorRow + rows}A`);
    for (let i = 0; i < rows; i += 1) {
      writeOut(i === rows - 1 ? '\x1b[2K' : '\x1b[2K\n');
    }
    // 光标回出发格：菜单底行 → 下移 cursorRow + 1 格（输入块顶 + 原光标所在物理行）→ 原列。
    writeOut(`\x1b[${cursorRow + 1}B\x1b[${cursorColumn()}G`);
  }

  // 给渲染器用的输入区协作钩子。非交互（管道）时 isActive() 为 false，渲染器走顺序直写。
  const composer = {
    isActive: () => rl !== null && interactive && areaDrawn,
    // 让出输入区：整块擦掉，光标停在它原来的第一行，渲染器从这里往下写 scrollback。
    takeArea: () => {
      eraseArea();
      liveText = null;
    },
    // 把输入区画回来（用户已键入的内容与光标位置由 readline 恢复）。
    giveArea: () => {
      drawArea(null);
    },
    // 框上方那一块实时状态（可多行）：null 表示「没有正在发生的事」。
    setLive: (text) => {
      if (rl === null || !interactive) return;
      const next = typeof text === 'string' && text !== '' ? text : null;
      // 与屏幕上那份一模一样就不重画：调用方按行推送，重复的一份只该被丢掉，
      // 否则每推一次都要 readline 整块重排一次（思考预览会推得很密）。
      if (areaDrawn && next === liveText) return;
      drawArea(next);
    },
    // 上框线右端的常驻标签（权限模式，工单 02）：null = 不画。文本或色调变了才整块重画；
    // 没在画（未启动 / 让位中）时只记状态，等 drawArea 时自然带上。
    setRuleTag: (tag) => {
      const next = tag && typeof tag.text === 'string' && tag.text !== ''
        ? { text: tag.text, tone: typeof tag.tone === 'string' ? tag.tone : 'info' }
        : null;
      const same = (ruleTag === null && next === null)
        || (ruleTag !== null && next !== null && ruleTag.text === next.text && ruleTag.tone === next.tone);
      if (same) return;
      ruleTag = next;
      if (areaDrawn) drawArea();
    },
  };

  // 画一次输入框（已经画着就不动），用来把提示符放到刚写完的输出下面。
  function promptOnce() {
    if (!interactive || rl === null || areaDrawn) return;
    drawArea();
  }

  function start({ initialText = null } = {}) {
    if (rl !== null) return { interactive: true, reason: null };

    if (detectMinTTY(env)) {
      // 提示只给一次，写完就走非交互分支：让上层照常给出非交互的错误处理。
      if (noticeTarget && typeof noticeTarget.write === 'function') noticeTarget.write(`${MINTTY_ADVICE}\n`);
      return { interactive: false, reason: 'mintty' };
    }
    if (!stdin || typeof stdin.on !== 'function') return { interactive: false, reason: 'no-stdin' };

    interactive = isInteractiveTerminal({ stdin, stdout, env });
    closing = false;
    areaDrawn = false;
    liveText = null;
    rl = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: interactive,
      prompt: interactive ? promptText() : undefined,
      // 转义歧义窗口收口（工单 06）：默认 500ms 会让「Esc 后 500ms 内的下一个字」被
      // 吞掉、Esc 与方向键被合并成无效序列——菜单把 Esc 变成常用键之后不可接受。
      // 50ms 内完整序列（方向键等）单次写入到达，不受影响。
      escapeCodeTimeout: 50,
    });
    attachAreaHooks(rl);
    attachKeysHook(rl);

    rl.on('line', (line) => {
      // readline 已剥掉行尾；非 TTY 管道里仍可能有残留 \r。回车这一刻 readline 已经
      // 换行（框的下沿留在屏幕上），提交簿记与 Ctrl+S 共用 emitSubmission。
      const text = typeof line === 'string' ? line.replace(/\r+$/, '') : '';
      emitSubmission(text);
    });

    // 有 SIGINT 监听时 readline 不会自行关闭，Ctrl+C 完全交给我们处理。
    rl.on('SIGINT', () => {
      emitControl('interrupt');
      promptOnce();
    });

    rl.on('close', () => {
      rl = null;
      interactive = false;
      areaDrawn = false;
      if (closing) return;
      emitControl('eof');
    });

    if (interactive) {
      promptOnce();
      // 位置参数（`wwriting "写第一章"`）：像用户亲手敲的一样填进输入框并提交，
      // 屏幕上因此也是同一个框、同一行用户行。
      if (typeof initialText === 'string' && initialText !== '') {
        rl.write(initialText);
        rl.write(null, { name: 'return' });
      } else if (draftBackup !== null) {
        // suspend 前的半行草稿：原样写回，光标也回到原位（不提交，等用户自己按回车）。
        const draft = draftBackup;
        draftBackup = null;
        rl.write(draft.line);
        if (draft.cursor < draft.line.length) {
          rl.cursor = draft.cursor;
          refreshLine();
        }
        // 恢复的草稿若处于命令位置，菜单按当前行内容重建（用户故事 9：恢复后重建）。
        refreshMenu();
      }
    } else {
      draftBackup = null; // 非交互接回：这半行没有去处，别让它迟到地出现在下一次 start 里。
    }
    return { interactive, reason: null };
  }

  // 临时交出终端，给交互式命令（`/model` 向导里的选择器）用。
  // 必须是「关掉 readline」而不是 pause：pause 之后只要有人 resume 输入流，
  // readline 仍会跟着一起吃键（在同一套按键上再起一个读取者，方向键会被它当正文收走）。
  // 交出期间 composer.isActive() 为假，渲染器退回顺序直写——正是向导想要的干净画面。
  function suspend() {
    if (rl === null) return;
    eraseArea();
    const current = rl;
    // 关掉之前把半行草稿带走（缺陷猎捕报告 3）：resume 时 start() 会把它写回输入框。
    const line = typeof current.line === 'string' ? current.line : '';
    const restorable = line !== '' && !/[\u0000-\u001f\u007f]/.test(line);
    draftBackup = restorable
      ? {
        line,
        cursor: Number.isInteger(current.cursor)
          ? Math.min(Math.max(0, current.cursor), line.length)
          : line.length,
      }
      : null;
    // 菜单是纯输入 UI：让位期间它随输入区消失，状态一并清掉（含 Esc 的收起标记——
    // 恢复后按恢复的草稿重建，用户故事 9；只清 menuText 的话，让位前按过 Esc 而
    // 恢复的草稿逐字节相同时菜单会保持收起）。resume 后 start() 里 refreshMenu 重建。
    menuText = null;
    paintedMenuRows = 0;
    menuDismissed = false;
    menuLineSeen = null;
    rl = null;
    interactive = false;
    liveText = null;
    closing = true;
    current.close();
    closing = false;
  }

  // 原样接回来：重建 readline 并把输入框画回屏幕。
  function resume() {
    if (disposed || rl !== null) return { interactive: false, reason: 'suspended' };
    return start();
  }

  function stop() {
    disposed = true;
    // 退出前把输入框收掉：屏幕上不留一个空的、不会再有人用的框。
    eraseArea();
    const current = rl;
    rl = null;
    interactive = false;
    liveText = null;
    if (current === null) return;
    closing = true;
    current.close();
    closing = false;
  }

  function replaceDraft(text) {
    if (rl === null || !interactive) return;
    rl.line = String(text);
    rl.cursor = rl.line.length;
    refreshLine();
    refreshMenu(); // 行模型直改不走 _ttyWrite：菜单按新行内容重算（复查确立的唯一残留入口）
  }

  return { start, stop, suspend, resume, composer, replaceDraft };
}
