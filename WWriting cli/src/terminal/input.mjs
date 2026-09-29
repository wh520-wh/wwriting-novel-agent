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
  USER_MARK, displayWidth, paintText, resolveColor, ruleLine,
} from './renderer.mjs';

// 提示符与用户行标记是同一个字符（renderer 的 USER_MARK），屏幕上「❯ 开头」永远是用户说的。
// 有颜色时用它上色：提示符是这条对话面上最需要一眼认出的东西。
const PLAIN_PROMPT = `${USER_MARK} `;
const MINTTY_ADVICE = '检测到 MinTTY 终端，请使用 Windows Terminal 或 winpty。';

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

// 输入区框线的一条（上框线 / 下框线都用它）。
export function ruleTextFor({ stdout, env = process.env, color } = {}) {
  return paintText(ruleLine({ columns: stdout?.columns }), 'info', resolveColor({ color, env, stdout }));
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

// createInputReader({ stdin, stdout, onSubmit, onControl, stderr, env, prompt })
//   onSubmit(text)     回车后的整行原文（未 trim；空行不触发）
//   onControl(name)    'interrupt'（Ctrl+C）| 'eof'（输入结束）
// 返回 { start, stop, suspend, resume, composer }。
//   start({ initialText }) 返回 { interactive, reason }；initialText 会像用户亲手敲的一样
//   填进输入框并提交（位置参数那条路用它，屏幕上因此也是同一个框）。
//   suspend/resume 用来把终端临时交给交互式命令（`/model` 向导），用完原样接回来。
export function createInputReader({
  stdin,
  stdout,
  stderr = null,
  env = process.env,
  onSubmit = null,
  onControl = null,
  prompt = null,
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

  const promptText = () => prompt ?? promptFor({ stdout, env });
  const rule = () => paintText(ruleLine({ columns: stdout.columns }), 'info', useColor);

  // 提示符的**纯文本**宽度。带色提示符里那些 `\x1b[36m` 在终端上不占列，但按字符数算会占 9 格——
  // 用它算光标列，typed 的字就会凭空右移一大截（踩过一次）。
  const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
  const plainPromptWidth = () => displayWidth((prompt ?? PLAIN_PROMPT).replace(ANSI, ''));

  function writeOut(text) {
    if (text !== '') stdout.write(text);
  }

  function emitControl(name) {
    if (typeof onControl === 'function') onControl(name);
  }

  // 光标此刻应该在输入行的第几列（1 基）。readline 重绘之后要把光标放回去，而它只管「输入行」
  // 这一格——下面那条线是我们加的，回到哪一列得我们自己算（按显示宽度，CJK 占 2 列）。
  function cursorColumn() {
    const columns = Number.isFinite(stdout.columns) && stdout.columns > 0 ? Math.floor(stdout.columns) : 80;
    const line = typeof rl?.line === 'string' ? rl.line : '';
    const cursor = Number.isInteger(rl?.cursor) ? Math.min(Math.max(0, rl.cursor), line.length) : line.length;
    const used = plainPromptWidth() + displayWidth(line.slice(0, cursor));
    return (used % columns) + 1;
  }

  // 补画下框线。readline 每次重绘都会用 clearScreenDown 把下面擦掉，所以每次重绘之后都要补一次。
  // `\r\n` 落到输入行下面那一格（画框时已经把它挤出来了，所以不会再滚屏），写完退回输入行。
  function paintBelowPrompt() {
    if (!areaDrawn || rl === null) return;
    writeOut(`\r\n${rule()}\r\x1b[1A\x1b[${cursorColumn()}G`);
  }

  // 实时区占几行。多数时候是 1（`思考中` 这种一行状态），思考预览会是 2 行。
  // 必须按**行数**算而不是写死 1：擦除时上移的格数取决于它，算少了框线就会残留在屏幕上。
  // 调用方（渲染器）负责把每一行都截到终端宽度以内——这里按 `\n` 数行，
  // 靠终端自动折行撑出来的行不在计数之内。
  function liveLineCount(text) {
    if (text === null) return 0;
    let lines = 1;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\n') lines += 1;
    }
    return lines;
  }

  // 擦掉整个输入区（含实时行），光标停在输入区原来的第一行——之后要么写 scrollback，要么重画输入区。
  function eraseArea() {
    if (!areaDrawn || rl === null) return;
    writeOut(`\r\x1b[${1 + liveLineCount(liveText)}A\x1b[0J`);
    areaDrawn = false;
  }

  // 在光标当前位置重画输入区：实时行（可选）→ 上框线 → 输入行 → 下框线。
  function drawArea(nextLive = liveText) {
    if (rl === null || !interactive) return;
    eraseArea();
    liveText = nextLive;
    if (liveText !== null) writeOut(`${liveText}\n`);
    writeOut(`${rule()}\n`);
    areaDrawn = true; // 先置位：下面的 refreshLine 会触发 paintBelowPrompt
    refreshLine();
  }

  // readline 的整行重绘（会连带触发我们挂在它上面的「补下框线」）。
  function refreshLine() {
    if (rl === null) return;
    if (typeof rl._refreshLine === 'function') rl._refreshLine();
    else rl.prompt(true);
  }

  // 给 readline 挂上「重绘之后补下框线」。
  // 用私有方法是为了不漏时机：敲字、粘贴、外部调用都会经过它，而 clearScreenDown 就发生在里面。
  // 拿不到这个入口时（非 TTY / 老版本）只是退化成「下框线在重绘后消失」，不影响输入本身。
  function attachAreaHooks(instance) {
    if (typeof instance._refreshLine !== 'function') return;
    const refresh = instance._refreshLine.bind(instance);
    instance._refreshLine = () => {
      refresh();
      paintBelowPrompt();
    };
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
    });
    attachAreaHooks(rl);

    rl.on('line', (line) => {
      // readline 已剥掉行尾；非 TTY 管道里仍可能有残留 \r。
      const text = typeof line === 'string' ? line.replace(/\r+$/, '') : '';
      // 回车这一刻 readline 已经换行：框的下沿留在屏幕上，光标停在它下面那一格。
      const hadBox = areaDrawn;
      areaDrawn = false;
      liveText = null;
      if (text.trim() === '') {
        // 空行一律丢弃：绝不能把空消息当一次提交送进 Agent。框直接在原处画回来。
        promptOnce();
        return;
      }
      // 走出框的下沿，之后的输出从这条线下面开始（屏幕上一个空行都不用留）。
      if (hadBox) writeOut('\n');
      if (typeof onSubmit === 'function') onSubmit(text);
      // 输入框在 Agent 跑的时候照样可用（提交是 fire-and-forget，不阻塞这里）；
      // 渲染器接下来写内容时会先 takeArea()，所以这里先把框画回来不会打架。
      promptOnce();
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
      }
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

  return { start, stop, suspend, resume, composer };
}
