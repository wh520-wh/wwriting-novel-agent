# 调研报告:终端 TUI 架构与 Windows 兼容(2025–2026 现状)

> 调研日期:2026-09-27。范围:Ink 深度调研、备选方案、终端协议、键盘/IME/粘贴、Windows 兼容、颜色主题、开源 agent CLI 对照。结论服务于 WWriting CLI(Node.js ≥ 24)的技术选型。所有结论均附来源;未核实的说法单独标注「未确认」。

---

## 核心结论(TL;DR)

1. **用 Ink,不纠结**。Ink(Node 侧「React for CLI」)是 agent CLI 的事实标准:Claude Code、Gemini CLI、Qwen Code、GitHub Copilot CLI、Nanocoder 都在用([Ink README](https://github.com/vadimdemedes/ink))。当前最新大版本 **Ink 7**(7.1.1,2026-07-16),要求 **Node ≥ 22、React ≥ 19.2**([npm registry](https://registry.npmjs.org/ink/7.1.1)、[GitHub Releases](https://github.com/vadimdemedes/ink/releases))。
2. **不用 alternate screen**。对话型 agent CLI 普遍留在 inline(主缓冲)模式以保留终端 scrollback;Ink 官方明示 alt screen 下「scrollback 不可用」([Ink README](https://github.com/vadimdemedes/ink)、[MS Learn VT 文档](https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences))。
3. **滚动区 = 终端 scrollback + Static 输出**。已完成的消息逐条用 Ink `<Static>`(或等价手法)一次性写入并交还 scrollback;动态区只保留「当前活动行 + 状态行 + 输入框 + 叠加卡」这一小块,每帧只重绘这一小块([Ink ink.tsx 源码](https://github.com/vadimdemedes/ink/blob/master/src/ink.tsx))。
4. **Enter/Shift+Enter 依赖 kitty keyboard protocol(CSI u)**,Ink 7 内置 `kittyKeyboard` 选项(默认 auto,自动探测、超时 200ms 回退 legacy);老终端用「反斜杠+Enter」兜底,Claude Code 另提供 `/terminal-setup` 给 iTerm2/VSCode/WezTerm 改键([Ink README](https://github.com/vadimdemedes/ink)、[kitty 协议文档](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)、[Claude Code 终端配置文档](https://code.claude.com/docs))。
5. **大段粘贴靠 bracketed paste**(`?2004h/l`),粘贴内容作为一次事件合并送达;Windows Terminal 1.7(2021)起支持;Ink 7 提供 `usePaste` hook([WT 1.7 发布公告](https://devblogs.microsoft.com/commandline/windows-terminal-preview-1-7-release/)、[Ink README](https://github.com/vadimdemedes/ink))。
6. **中文 IME 由终端进程负责组合,应用收到的是已上屏字符**;Ink 的 `useCursor` 用 `string-width` 定位光标以支持宽字符/IME。真实坑:Windows Terminal v1.23.13503 曾导致搜狗/讯飞选词框不显示([linux.do 帖](https://linux.do));MinTTY 下 IME/输入行为独立成体系(见 §4.2)。
7. **Windows 最大坑是 Git Bash 的 MinTTY**:它不是 Win32 控制台,`node.exe` 看到的 `isTTY=false`,交互式 CLI 会假死,需 `winpty` 桥接([nodejs/node#3006](https://github.com/nodejs/node/issues/3006))。Claude Code 官方要求 native Windows 必装 Git for Windows(作 shell),但用户终端建议用 Windows Terminal([Claude Code Setup 文档](https://code.claude.com/docs))。
8. **Windows 信号语义**:可靠的是 SIGINT(Ctrl+C)与 SIGBREAK(Ctrl+Break);SIGTERM 只可监听不可触发;SIGHUP 在关窗时触发但约 10 秒后强杀;raw 模式下 Ctrl+C 不产生 SIGINT([Node process 文档](https://nodejs.org/api/process.html)、[Node tty 文档](https://nodejs.org/api/tty.html))。
9. **颜色**:用 `supports-color`(chalk 系,Ink 内部同源)分级降级 truecolor/256/16;尊重 `NO_COLOR` 与 `FORCE_COLOR`;主题提供深/浅两套前景色且**不输出背景色**(inline 模式必须透出终端自身背景)([supports-color](https://github.com/chalk/supports-color)、[no-color.org](https://no-color.org/))。
10. **非 Node 阵营已定型**:Codex CLI 重写为 Rust+ratatui,opencode/Crush 用 Go+Bubble Tea([openai/codex](https://github.com/openai/codex)、[sst/opencode](https://github.com/sst/opencode));对 Node 项目而言,Ink 没有同量级的替代者,blessed/neo-blessed 已停更([OpenReplay](https://blog.openreplay.com/building-terminal-interfaces-nodejs))。

---

## 1. Ink 深度调研

### 1.1 版本现状与时间线

- npm `latest` = **7.1.1**(2026-07-16);`engines: node >=22`,`peerDependencies: react >=19.2.0`([npm registry](https://registry.npmjs.org/ink/7.1.1))。
- 关键版本:[GitHub Releases](https://github.com/vadimdemedes/ink/releases) 数据——
  - v5.2.1:2025-04-29(Ink 5 末期,Node 18+/React 18)
  - **v6.0.0:2025-05-29**,主打 React 19 支持([JavaScript Weekly #738](https://javascriptweekly.com/issues/738))
  - v6.1.0–v6.8.0:2025-07 至 2026-02,滚动修复与小特性
  - **v7.0.0:2026-04-08**;v7.0.x→v7.1.1:2026-04 至 2026-07
- Ink 7 的关键新能力(来自 [master README](https://github.com/vadimdemedes/ink)):
  - `alternateScreen` render 选项(需要 alt screen 时才用)
  - `kittyKeyboard`: `'auto' | 'enabled' | 'disabled'`,auto 模式发 `CSI ? u` 探测、200ms 超时回退 legacy;flags 支持 disambiguate / report-event-types / report-alternate-keys / report-all-keys / report-associated-text;**Shift+Enter 与 Enter 的区分正需要它**
  - `usePaste()` hook:粘贴与逐键输入分流;`useBoxMetrics()`:拿到盒子在屏幕上的绝对位置(配合光标定位/悬浮层);`useAnimation()`
  - `Box` 的 `contentOffsetX/contentOffsetY`:**官方支持视口滚动**(大内容在固定高度盒子里滚动)
  - `incrementalRendering`(增量重绘,只更新脏行)、`maxFps`(默认 30)、`interactive`(检测 CI/非 TTY 自动退化)、`suspendTerminal`/`resume`(把终端交还给子进程,如 $EDITOR)

### 1.2 渲染模型:Static vs Dynamic

- Ink 是自定义 React reconciler + Yoga(flexbox)布局。每次状态变更:重新走一遍 React 渲染与 Yoga 布局,生成新帧;输出时**与上一帧按行 diff,只重写变化的行**(源码里以约 64 行为块分批写);若某行高度变化,从该行起重写到底部([src/renderer.ts](https://github.com/vadimdemedes/ink/blob/master/src/renderer.ts))。
- **`<Static>` 组件是长对话场景的支柱**:放入其中的内容按序号只输出一次,直接写 stdout 并进入终端 scrollback,之后不再参与重绘;退出时 Static 输出并入常规输出避免重复(有专门修复,见 [src/ink.tsx](https://github.com/vadimdemedes/ink/blob/master/src/ink.tsx) 中 `fullStaticOutput` 与 issue #397 引用)。
- 由此形成 agent CLI 的标准双区结构:**Static 区(对话历史,追加即忘)+ 动态区(输入框/活动行/状态行,每帧重绘)**。

### 1.3 输入与常用 hooks

- `useInput(onInput, options)`:逐键回调,自动解析常见 ESC 序列为具名键(up/down/return/tab 等);**多字符输入(典型即粘贴)默认合并为一次调用**;`options.isActive` 控制监听;Ink 默认在 Ctrl+C 时退出(`exitOnCtrlC`,可关掉自管)([Ink README](https://github.com/vadimdemedes/ink))。
- `useStdin()`:拿 `stdin`、`setRawMode`、`isRawModeSupported()`(非 TTY 如管道下为 false,必须降级);`useStdout()`、`useStderr()`;`useFocus()`/`useFocusManager()`(多输入区焦点);`useApp().exit()`。
- `useCursor(show, onFocus)`:在文本框中显式放置终端光标,**README 明确该 API 用于 IME(输入法组合)支持**——组合字符串中的光标位置需用 `string-width` 按显示宽度计算。
- Ink 默认 `patchConsole`,把 `console.log` 重定向进渲染流,避免打乱画面;有 `debug` 模式输出到文件。
- 务实纪律:任何直接写 `process.stdout` 的代码(比如自己打印工具输出)都会撕碎帧缓冲——**所有输出必须进 React 组件**;需要「绕过渲染打印」的场景(如 `suspendTerminal` 交出终端跑 `$EDITOR`/子进程)是 Ink 7 的一等公民 API,退出后重绘即可([Ink README](https://github.com/vadimdemedes/ink))。

### 1.6 测试与调试

- [ink-testing-library](https://github.com/vadimdemedes/ink):`render(<App/>)` 返回 `frames`(逐帧字符串)与 `stdin.write()` 模拟按键,可对「权限确认卡文案、状态行文案」做快照断言——与本项目「状态文案表」验收天然契合。
- 调试:开启 `patchConsole` 的 debug 落盘,或用 `NODE_ENV` 分支把帧写到文件排查差分重绘;CI(无 TTY)下 Ink 的 `interactive` 检测(`is-in-ci` + `stdout.isTTY`)会自动退化为一次性静态输出,可作为「冒烟跑通」的测试路径。

### 1.4 滚动区与大文本

- Ink 5/6 时代没有内置滚动列表,滚动是各项目自建(社区方案如 [ink-virtual-list](https://www.npmjs.com/package/ink-virtual-list));**Ink 7 起官方提供 `contentOffsetX/Y`**,可在固定高度的 Box 内滚动超出内容。
- Claude Code / Gemini CLI 的选择是「不与应用内滚动较劲」:已完成输出交给 scrollback(Static 化),用户用终端自带滚轮回看;应用内只保留小动态区。
- 性能坑与优化(证据:[renderer.ts](https://github.com/vadimdemedes/ink/blob/master/src/renderer.ts) 的全树布局模型、[ink.tsx](https://github.com/vadimdemedes/ink/blob/master/src/ink.tsx) 的 Static 实现;社区对 Claude Code 闪烁/卡顿的讨论广泛存在,如 [HN 相关评论](https://news.ycombinator.com/),未确认具体帖):
  - 动态区越大、状态变更越频繁,每帧 Yoga 布局+diff 成本越高;长对话全放动态区会明显卡顿;
  - 对策:**追加式内容走 Static;动态组件 `memo`;流式 token 用节流(或 Ink 7 `maxFps`)合帧;活动行 spinner 用最小 DOM**;
  - Ink 7 的 `incrementalRendering` 只重写脏行,直写 stdout 的 Static 部分零成本。

### 1.5 不用 React 的替代方案(Node 生态)

- **blessed / neo-blessed:事实停更**。blessed 多年无实质维护,neo-blessed/reblessed 只有零星兼容修复;新项目不推荐([OpenReplay: Building Terminal Interfaces with Node.js](https://blog.openreplay.com/building-terminal-interfaces-nodejs))。
- **terminal-kit**:功能全(双缓冲 ScreenBuffer、输入解析)但维护节奏慢、API 偏底层,2025–2026 无活跃大版本(同上文;另见 [cronvel/terminal-kit](https://github.com/cronvel/terminal-kit))。
- **纯手写 ANSI**:做一个「能滚动的对话流+输入框+悬浮卡」至少要自己实现:行差分重绘、宽字符测量、SGR 状态机、bracketed paste、kitty 协议、resize 事件——等于重写 Ink 的下层。仅适合输出型小工具。
- 结论:**Node 生态里没有「第二主流」**。跨语言对照:Rust 的 ratatui(OpenAI Codex CLI 已重写为 Rust+ratatui,[openai/codex](https://github.com/openai/codex))与 Go 的 Bubble Tea(opencode、Charmbracelet 自家的 Crush,[sst/opencode](https://github.com/sst/opencode))是 2025 年的另外两条主流路线,但对本项目意味着放弃 Node/复用上游 core 的前提。

---

## 2. 终端协议基础

### 2.1 Alternate screen vs inline

- `CSI ?1049h/l` 切换主/备缓冲;**备缓冲没有 scrollback**——这是 MS Learn 官方文档明确定义的行为([Console Virtual Terminal Sequences](https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences));Ink README 同样警告 alt screen 下 scrollback 不可用([Ink README](https://github.com/vadimdemedes/ink))。
- **对话型 agent CLI 普遍不用 alt screen 的原因**:对话历史本质是「应该沉淀到 scrollback 的日志」;进 alt screen 后用户无法用终端滚轮回看,退出即消失,与「章节即文件、过程可回看」的产品直觉相悖。vim/htop 这类「全屏编辑/监控」场景才需要 alt screen。
- 现状佐证:Gemini CLI 把 alt screen 做成**可选设置**(`alternateScreenBufferMode`,默认关),并在试验新的 terminal buffer 渲染架构([google-gemini/gemini-cli 源码 settingsSchema.ts](https://github.com/google-gemini/gemini-cli));Claude Code 保持 inline,提供 Ctrl+O/Ctrl+E 之类的「展开/回看」而非全屏接管(广泛使用经验,未确认官方文档明确表述)。

### 2.2 「滚动区 + 底部输入区」的三种实现手法

1. **Static 派(推荐,主流 agent CLI 采用)**:历史输出顺序打印(进 scrollback);光标始终在底部动态区,每帧「上移 N 行 + 擦除 + 重绘」。无需任何滚动区协议,resize 天然安全。
2. **DECSTBM 派**:`CSI t; r` 设置滚动 margins,让顶部区域滚动、底部状态/输入行固定不动——MS Learn 文档明确举了「顶部标题栏/底部状态栏」这一用途,且主/备缓冲的 margins 相互独立([MS Learn VT 文档](https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences))。代价:scrollback 行为在各终端不一致(部分终端只把滚出 margins 的行写入 scrollback 时表现不同),跨终端回归成本高;Ink 本身不使用该协议。
3. **alt screen 全屏派**:自己接管整个画面做内部滚动(Gemini CLI 的可选模式、Codex/opencode 部分模式)。牺牲 scrollback 换取画面完全可控。

### 2.3 Bracketed paste(`CSI ?2004h/l`)

- 启用后,终端把粘贴内容包在 `ESC[200~` 与 `ESC[201~` 之间送达;应用可区分「粘贴」与「逐键输入」,粘贴中的换行不会误触发提交,自动缩进不会层层叠加。Windows Terminal 自 **1.7(2021-03)** 起支持 paste filtering 与 bracketed paste([WT 1.7 发布公告](https://devblogs.microsoft.com/commandline/windows-terminal-preview-1-7-release/));kitty/iTerm2/WezTerm 等早已支持。
- Windows Terminal 1.24/1.25 进一步增加**空 bracketed paste**(无文本粘贴,如剪贴板为图片时也发送括号对),供 agent CLI 检测图片粘贴([microsoft/terminal releases](https://github.com/microsoft/terminal/releases))。
- Node/Ink 侧:Ink ≤6 中多字符一次性到达 `useInput`;**Ink 7 的 `usePaste()` 把粘贴独立成事件**,可拿到完整粘贴文本并单独处理([Ink README](https://github.com/vadimdemedes/ink))。

### 2.4 键盘输入编码三代对比

| 编码 | 原理 | 能区分 Shift+Enter? | 支持面 |
| --- | --- | --- | --- |
| Legacy(VT100 系) | 单字节控制字符 + ESC 序列;Ctrl+字母与控制字符混叠 | 否(与 Enter 同码) | 所有终端的公共底线 |
| win32-input-mode | Windows 自有:ConPTY 输入缓冲逐键上报键码+修饰符 | 是(Windows 内部) | Windows Terminal/ConPTY 生态,应用层一般不直接消费 |
| kitty protocol(CSI u) | `CSI key; modifiers u` + 渐进增强 flags + `CSI ? u` 探测 | 是(modifier 位域) | kitty/alacritty/foot/ghostty/iTerm2/**Windows Terminal 1.25+**/WezTerm/xterm.js/rio/Warp 等([kitty 文档](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)) |

工程含义:**Ink 7 的 `kittyKeyboard: 'auto'` 已经把「探测→启用→回退」封装好**,应用只需同时保留 legacy 兜底键位(反斜杠续行),不必自己实现协议状态机。

---

## 3. 键盘与输入

### 3.1 Node 侧按键解析

- 基础设施:`tty.ReadStream` + `setRawMode(true)` 进入逐字节输入;**raw 模式下终端禁用回显与特殊处理,且 Ctrl+C 不再产生 SIGINT**,需要应用自己处理 `\x03`([Node tty 文档](https://nodejs.org/api/tty.html));`readline` 的 keypress 事件在其上解析常见序列。Ink 的 `useInput` 建立在同等机制上并补齐 ESC 序列解析与焦点管理。
- 非 TTY 环境(stdin 是管道)下 raw mode 不可用,`useStdin().isRawModeSupported()` 返回 false——**必须保留非交互降级路径**(管道喂长文本给 CLI 是真实用法)([Ink README](https://github.com/vadimdemedes/ink))。
- legacy 编码下的常见序列(来自 [MS Learn VT 文档输入序列](https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences) 一节,各终端基本一致):方向键 `ESC[A/B/C/D`(application 模式 `ESC O A` 等)、Ctrl+方向 `ESC[1;5A`、Backspace `0x7F`、Insert/Delete/PageUp/PageDown `ESC[2~/3~/5~/6~`、F1–F4 `ESC O P..S`、F5–F12 `ESC[15~..24~`、Alt 为 `ESC` 前缀;**Home/End 在不同终端有 `ESC[H`/`ESC[F`/`ESC[1~`/`ESC[4~` 多种变体**,解析务必走库(useInput/readline)而非手写正则。

### 3.2 Enter / Shift+Enter 与 kitty keyboard protocol

- Legacy 编码下 Shift+Enter 与 Enter 发送相同字节,应用无法区分;这正是 kitty keyboard protocol 要解决的歧义之一(同时解决 Ctrl+字母与控制字符混叠、Esc 与序列前缀难分等)([kitty 协议文档](https://sw.kovidgoyal.net/kitty/keyboard-protocol/))。
- 协议要点:CUI 编码 `CSI unicode-key-code ; modifiers u`,modifiers 为位域(shift=1/alt=2/ctrl=4…加 1);渐进增强 flags 由 `CSI = flags ; mode u` 设置,支持 `CSI ? u` 查询与压栈/出栈;探测方式是「协议查询 + DA1」一起发,只收到 DA1 应答即为不支持(同上)。
- 终端支持面(kitty 文档官方列表):kitty、**alacritty、foot、ghostty、iTerm2、Microsoft Terminal、rio、Warp、WezTerm、xterm.js**,以及 crossterm/bubbletea/textual 等库(同上)。Windows Terminal 在 **1.25(2026-03 起的版本)** 实现 kitty keyboard protocol,设置里可关闭,关联 tracking issue [#19817](https://github.com/microsoft/terminal/issues/10741)([WT releases](https://github.com/microsoft/terminal/releases);1.22/1.23/1.24 稳定版不支持)。
- **Claude Code 的务实兜底**(值得抄):`/terminal-setup` 自动为 iTerm2/VSCode/WezTerm 配置 Shift+Enter 换行;Windows Terminal(新版)原生可用;任意终端通用的 fallback 是「行尾反斜杠 + Enter」表示续行([Claude Code 终端配置文档](https://code.claude.com/docs)、[ClaudeLog](https://www.claudelog.com))。Ink 7 则把探测/启用协议做成了 `kittyKeyboard` 一个选项。

### 3.3 大段多行粘贴(小说文本场景)

- 正确姿势:启用 bracketed paste → 粘贴整体作为单事件到达 → 应用内做「粘贴确认卡」(显示字符数,让用户确认插入),避免缩进/换行被逐键解释破坏。
- 性能:粘贴 1 万行小说文本时,不要为每个字符重渲染;Ink 7 `usePaste` 一次拿到全文后再更新一次输入框即可;超长文本建议截断显示「已粘贴 N 字符」([Ink README](https://github.com/vadimdemedes/ink))。
- 无 bracketed paste 的终端(极老环境):粘贴退化为快速逐键输入,Ink ≤6 的合并行为(`useInput` 一次收到多字符)已是最后防线;WWriting 可在输入框加显式「粘贴」快捷键读剪贴板兜底(Windows 下 `powershell Get-Clipboard`,未确认跨平台统一方案)。

### 3.4 中文 IME 在各终端下的坑

- 机制:IME 组合(拼音串→候选→上屏)发生在**终端进程内**(Windows Terminal/ConPTY 走 TSF,MinTTY 自带 IME 处理),应用在 raw 模式下收到的是**已上屏的 UTF-8 字符**;因此 CLI 应用通常不需要也无法参与组词。应用要做的是**光标位置正确**(宽字符占 2 列)——Ink 的 `useCursor` + `string-width` 即为此设计([Ink README](https://github.com/vadimdemedes/ink))。
- 真实坑清单:
  - Windows Terminal v1.23.13503 一次更新导致**搜狗/讯飞输入法选词框在 WT 中不显示**(微软自带拼音正常),降级或等修复解决——说明 WT 的 IME 链路仍在打磨,须用新版并纳入测试([linux.do 讨论](https://linux.do))。
  - WT 1.24/1.25 修复了多起 IME 组合输入问题(韩文 IME #20039、组合中输入覆盖已有文本 #20041 等)([WT releases](https://github.com/microsoft/terminal/releases))。
  - MinTTY:IME 由 MinTTY 自己处理,上屏后才发给应用;MinTTY 同时有 §4.2 的 isTTY 大坑,组合问题应先解决 TTY 问题。
  - kitty protocol 的 `report-associated-text` flag 可让应用直接拿到按键对应文本,规避部分组合歧义;但对 IME 组合态的帮助有限(kitty 文档对 preedit 的支持描述见 [kitty 协议文档](https://sw.kovidgoyal.net/kitty/keyboard-protocol/);在 WT 实现中的覆盖程度**未确认**)。

---

## 4. Windows 兼容

### 4.1 ConPTY 与 Windows Terminal 现状

- ConPTY(伪控制台)是 Windows 10 1809+ 提供的 PTY 机制:宿主程序通过两根管道与 `CreatePseudoConsole` 创建的缓冲交换 VT 字节流,使「终端模拟器托管控制台程序」成为可能;官方文档要求读写管道各用独立线程,否则易死锁([Creating a Pseudoconsole session](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session))。
- 对 CLI 应用(我们这一侧)而言,ConPTY 的意义是:只要用户跑在 Windows Terminal 或任何 ConPTY 感知终端里,`node.exe` 看到的就是正常 TTY + VT 序列,行为接近 Unix;`ENABLE_VIRTUAL_TERMINAL_PROCESSING` 使 conhost/WT 解释 ANSI([MS Learn VT 文档](https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences))。
- [node-pty](https://github.com/microsoft/node-pty)(微软官方,VS Code 内置终端同款):npm 稳定版 **1.1.0**,1.2.0-beta 活跃开发中,内置 ConPTY DLL 已更新到 1.25 系([npm](https://www.npmjs.com/package/node-pty)、[releases](https://github.com/microsoft/node-pty/releases))。**用途界定**:仅当 CLI 需要「托管一个交互式子终端」(如 `!` 逃逸进 shell、内嵌编辑器)才需要它;渲染自身 UI 不需要。Claude Code 是否用 node-pty 未确认。
- 核心 API([node-pty README](https://github.com/microsoft/node-pty)):`spawn(file, args, {name, cols, rows, cwd, env})` 返回 `IPty`;`pty.onData`(VT 字节流)、`pty.onExit`、`pty.write(data)`、`pty.resize(cols, rows)`、`pty.kill()`。Windows 上要求 Win10 1809+(纯 ConPTY 路线);npm 包带预编译二进制,1.2.0-beta 改进了 prebuilds 分发(升级 Node 大版本时注意 ABI 匹配)。
- Windows Terminal 1.24/1.25(2025–2026)与本调研相关的变更:kitty keyboard protocol(#19817)、IME 组合修复、空 bracketed paste、ConPTY 宽字符输出死锁修复([WT releases](https://github.com/microsoft/terminal/releases))。

### 4.2 Git Bash(MinTTY)与 cmd/PowerShell 的差异坑

- **MinTTY(Git Bash 默认终端)不是 Win32 控制台**,而是 MSYS pty:原生 `node.exe` 在其下 stdin/stdout 是管道,`process.stdin.isTTY === false`,交互式 REPL/提示直接假死;经典修复是 Git for Windows 自带的 `winpty node` 桥接([nodejs/node#3006](https://github.com/nodejs/node/issues/3006))。
- 影响推演:Ink 依赖 raw mode 与 TTY 检测,在 MinTTY 直跑会走「非交互」分支;`winpty` 桥接下可用但 resize/颜色偶有瑕疵(社区普遍经验,**未确认系统测试**)。
- Claude Code 的官方答案是**要求但绕开**:native Windows 必须装 Git for Windows(用它提供 bash 执行工具命令),`CLAUDE_CODE_GIT_BASH_PATH` 可指定路径;而 UI 运行环境推荐 Windows Terminal/PowerShell([Claude Code Setup 文档](https://code.claude.com/docs))。
- cmd/PowerShell:作为宿主时跑在 conhost 或 WT 中,均为 ConPTY 路径,行为一致;老 conhost(未设默认终端)也支持 VT 序列但功能面较窄(§2 所列协议大多可用, kitty protocol 仅 WT 新版支持)。
- **运行环境检测表**(建议启动时采集并打进 journal/诊断信息):

| 特征 | 判定 |
| --- | --- |
| `process.stdout.isTTY === false` 且 `MSYSTEM` 存在 | MinTTY(Git Bash 直跑),触发 §7.4 指引 |
| `MSYSTEM` 存在且 `isTTY === true` | WT/其他 ConPTY 宿主里的 Git Bash profile,正常 |
| `WT_SESSION` 存在 | Windows Terminal |
| `TERM_PROGRAM === 'vscode'` | VS Code 集成终端(xterm.js,支持 bracketed paste;Shift+Enter 需改键) |
| `TERM=dumb` 或 CI 变量 | 非交互,退化为静态输出 |

注意:不能单凭 `MSYSTEM` 判 MinTTY——WT 的 Git Bash profile 同样有 `MSYSTEM`;`isTTY=false` 才是 MinTTY 直跑的特征信号(§4.3 的 Node TTY 判定,[nodejs/node#3006](https://github.com/nodejs/node/issues/3006))。

### 4.3 Node 24 下的 stdout/TTY/ANSI

- Node 24(2025-04 发布,2025-10 进入 LTS「Krypton」):V8 13.6、npm 11、URLPattern 全局化、权限模型转正([OpenJSF 公告](https://openjsf.org/blog/nodejs-24-released))。满足 Ink 7 的 `node >=22` 要求。
- TTY/颜色判定:`process.stdout.isTTY`;`getColorDepth([env])` 返回 1/4/8/24 级;`hasColors()`;环境变量 `FORCE_COLOR=0/1/2/3` 强制分级,`NO_COLOR`、`NODE_DISABLE_COLORS` 禁用([Node tty 文档](https://nodejs.org/api/tty.html))。
- raw 模式在 Windows 需要 CONIN$ 写权限(正常从 stdin 获取即可);`'io'` 二进制 I/O 模式 Windows 不支持(本项目用不到)(同上)。
- Node 在 Windows 控制台下对 stdout 自动启用 VT 处理(libuv 行为),故现代 Node + WT/conhost 下 ANSI 输出开箱即用(普遍经验;官方单页未逐字表述,**未确认**,但与 §4.1 的 ConPTY/VT 文档一致)。

### 4.4 SIGINT/SIGTERM/Ctrl+C 与优雅退出

- [Node process 文档](https://nodejs.org/api/process.html) 权威结论:
  - Windows 无 POSIX 信号,只有模拟:SIGINT(Ctrl+C,所有平台支持)、SIGBREAK(Ctrl+Break,仅 Windows)、SIGHUP(关控制台窗口时;**即使装了监听器,Windows 约 10 秒后仍无条件杀进程**)。
  - SIGTERM 在 Windows「可监听、不可触发」;`process.kill(pid, 'SIGTERM'/'SIGINT')` 在 Windows 上是无条件终止。
  - **raw 模式下 Ctrl+C 不产生 SIGINT**,`\x03` 作为普通输入到达应用。
  - POSIX 上一旦 `process.on('SIGINT')` 装了监听器,默认「重置终端 + 128+n 退出」行为被移除——必须自己负责恢复终端状态。
- 优雅退出设计(综合):Ink 场景建议 `exitOnCtrlC: false` 自管 Ctrl+C(停止当前 Run、清理临时授权、确认写入完整后 `app.exit()`);`process.on('exit')` 里只做**同步**收尾(恢复终端模式、flush journal);SIGBREAK/SIGHUP 作补充;关窗/kill -9 场景放弃内联收尾,靠「journal 每步落盘」保证可恢复(与本项目铁律 5 的「停止时进行中写入保持完整」对齐)。

---

## 5. 颜色与主题

- **检测**:[chalk/supports-color](https://github.com/chalk/supports-color)(Ink/chalk 同源)按 `FORCE_COLOR` → `NODE_DISABLE_COLORS`/`NO_COLOR`/`TERM=dumb` → `COLORTERM=truecolor|24bit` → `TERM` 后缀(`-256color`)→ CI 检测分级 level 0–3(具体优先级以库 README 为准;Node 内建 `getColorDepth`/`hasColors` 可作无依赖兜底,见 [Node tty 文档](https://nodejs.org/api/tty.html))。
- **NO_COLOR 约定**:变量存在且非空即应禁用颜色(值被忽略),只影响颜色不影响粗体/下划线;用户配置与命令行参数应可覆盖它([no-color.org](https://no-color.org/))。Ink 的 chalk 底层已内置处理。
- **主题惯例**(主流 agent CLI):Claude Code 提供 `/config` 主题切换(dark/light/daltonic 色盲模式);Gemini CLI 同类设置。共同点是**跟随终端**:inline 模式下不输出背景色、只调前景/强调色,使应用在任何终端背景下都不突兀;切换主题是「换一组 SGR 前景色映射」,而非自绘整屏(广泛使用经验;Claude Code 主题列表见 [code.claude.com/docs](https://code.claude.com/docs))。
- 程序化探测终端深浅色可用 OSC 10/11 查询默认前景/背景色,但**回应支持参差不齐、Node 侧无现成库**,主流 agent CLI 均未自动探测而是让用户选(未确认有 2025–2026 的新标准落地)。
- **主题设计细则**(供 WWriting 文案与视觉规格落地):
  - 建立语义化颜色 token(`danger/warning/success/info/dim/accent`),底层映射 ANSI 16 色,truecolor 终端再做微调;两级实现,单测断言只针对语义 token。
  - 次要信息用 `dim`(SGR 2 或 256 色灰阶),避免大面积低对比;浅色终端下纯黑前景 + 浅灰背景对比不足是常见事故,需两套前景映射分别校验。
  - spinner/进度条在 Ink `maxFps: 30` 下足够流畅,不必追求 60fps。
  - 静态区(scrollback 里的历史)与动态区必须共用同一 token 集,否则回看历史时颜色突变。
  - 对照:Claude Code 主题含 daltonic(色盲)模式,Gemini CLI 同类设置——三套(dark/light/daltonic)是 agent CLI 的当前基准([code.claude.com/docs](https://code.claude.com/docs))。

---

## 6. 典型开源实现对照

### 6.1 Claude Code(闭源,Ink 基准实现)

- 技术构成:TypeScript,UI 为 React + Ink([Ink README 使用者列表](https://github.com/vadimdemedes/ink);[The Pragmatic Engineer: How Claude Code is built, 2025-09](https://newsletter.pragmaticengineer.com/how-claude-code-is-built);源码逆向系列如 [layer5.io 分析](https://layer5.io)、[Reid Barber 逆向笔记](https://reidbarber.com))。
- 组织方式(与本项目铁律高度一致):单一对话流;已完成轮次沉淀进 scrollback(Static 派);输入框常驻底部,上方为实时状态/活动行;权限确认卡、计划悬浮层以组件形式叠加在动态区;`/terminal-setup` 解决 Shift+Enter;主题经 `/config` 切换;Windows 依赖 Git Bash 作 shell、UI 推荐 WT。

### 6.2 Gemini CLI(开源 Apache-2.0,Ink)

- [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli):React+Ink 实现,对话流 + 底部输入 + 页脚状态;其设置 schema 含 `alternateScreenBufferMode`(默认 inline)与试验性新 terminal buffer 渲染架构(源码 `packages/cli/src/config/settingsSchema.ts`,[fossies 镜像](https://fossies.org/) 可查)。证明「Ink + inline + Static 化」在超长对话下可行,同时示范了 alt screen 作为可选模式的做法。

### 6.3 Nanocoder(开源社区,Ink)

- [Nanocoder-AI/Nanocoder](https://github.com/Nanocoder-AI/Nanocoder)(npm `@nanocollective/nanocoder`):社区维护的 local-first 编码 agent,Ink UI,多 provider;支持以 ACP(Agent Client Protocol)server 模式运行、让编辑器接管 UI——说明「TUI 之外留一个协议出口」是可行的架构扩展([Nanocoder 文档](https://docs.nanocollective.org))。

### 6.4 非 Node 对照

- [OpenAI Codex CLI](https://github.com/openai/codex):早期 TS/Ink,2025 年重写为 **Rust + ratatui**(workspace 化、严格 lint)。动机含性能与分发,但代价是放弃 JS 生态复用。
- [opencode](https://github.com/sst/opencode) / [Crush](https://github.com/charmbracelet/crush):**Go + Bubble Tea**(Charm 生态;opencode 主开发被 Charm 收编是社区报道,未确认一手声明)。Bubble Tea 的 Elm 架构适合全屏 TUI,同样走非 Node 路线。

> 对照结论:凡以「长对话流 + 底部输入 + 偶发悬浮确认」为形态的 Node CLI,清一色 Ink;形态相同的 Rust/Go 实现存在,但那是团队整体技术栈选择,不是 Ink 的能力缺口。

### 6.5 共性模式小结(三例对照)

- **渲染栈**:全部 React + Ink;全部 inline 为主(alt screen 至多是可选模式)。
- **历史输出**:全部「追加即忘」——Static 化/等价直写,交还 scrollback;动态区始终压在几行到十几行。
- **输入框**:底部常驻单实例;多行输入用「换行键(Shift+Enter/反斜杠续行)」而非 alt screen 编辑器。
- **悬浮确认**:权限/工具确认卡直接以组件叠加在动态区上方,不用弹窗、不切屏——与本项目铁律 4 的「普通模式先确认」实现方式一致。
- **扩展出口**:Nanocoder 的 ACP 模式提示:把「渲染层」与「agent 内核」从第一天就按进程/协议解耦,未来接编辑器或 GUI 不必重写内核(对 WWriting「复用上游 core 设计」的规划是直接背书)。

---

## 7. 对 WWriting CLI 的落地建议

### 7.1 选型

- **用 Ink 7.x(≥7.1.1)+ React 19.2**。理由:与 Claude Code/Gemini CLI 同栈、形态直接对标;Node ≥ 24 满足其 engines;Ink 7 的 `kittyKeyboard`/`usePaste`/`contentOffset`/`incrementalRendering` 恰好覆盖本项目四个硬需求(Shift+Enter、粘贴、计划悬浮层、长对话性能)。不要引入 blessed/terminal-kit,也不要手写 ANSI 层。
- 渲染选项:`{ exitOnCtrlC: false, kittyKeyboard: 'auto', maxFps: 30, interactive: 自动 }`;`alternateScreen` 不用。

### 7.2 滚动区与布局(铁律 2 的实现)

- **inline 模式 + Static 派**:每完成一个对话块(助手回复、工具结果、状态行终态)就移入 `<Static>` 区,一次性写入并交还 scrollback;动态区只保留:当前活动行(轮内活动,如「正在写 第3章」)+ 状态行 + 输入框 + 叠加卡(权限确认/任务计划)。这同时满足「状态只在当前轮」与「Run 结束只留状态行」。
- 应用内滚动(计划悬浮层、超长确认卡):用 Ink 7 `Box maxHeight + contentOffsetY` 自绘视口;不要试图接管整个对话流的滚动。
- 折行统一走 Ink/`wrap-ansi`,宽字符测量交给 `string-width`(中文、emoji 计列),避免差分重绘时列数错位。
- 结构示意(伪代码,表达分区与叠加关系):

```jsx
<Static items={finishedBlocks}>{b => <FinishedBlock .../>}</Static>
<Box flexDirection="column">          {/* 动态区:每帧重绘,越矮越好 */}
  {running && <ActivityLine label="正在写" detail={`第${n}章`} />}  {/* 轮内活动行 */}
  {planOpen && <PlanOverlay items={plan} />}                        {/* 任务计划悬浮层 */}
  {confirm && <PermissionCard {...confirm} />}                      {/* 权限确认卡 */}
  <StatusBar text={statusText} />                                   {/* 状态行(2–6 字) */}
  <Composer value={draft} onPaste={handlePaste} />                  {/* 输入框 */}
</Box>
```

要点:运行状态只存在于动态区(铁律 2);Run 结束时把状态行与活动行一并「结转」进 Static,动态区回到纯输入框。

### 7.3 输入、粘贴与 IME

- 键盘:`useInput` + `kittyKeyboard: 'auto'`;Enter 提交,Shift+Enter 换行(协议可用时),**同时实现反斜杠续行兜底**;提供 WW 版 `/terminal-setup`(至少覆盖 VSCode 终端与 iTerm2/WezTerm 的改键引导)。
- 粘贴:`usePaste` 接管;粘贴超过阈值(如 500 字)弹「粘贴确认卡」显示字符数(呼应铁律 6 的客观计数:确认卡里的字数用同一 `count_text` 逻辑预估);粘贴内容中的换行不触发提交。
- IME:光标定位一律用 `useCursor`(按显示宽度);不要自己逐字节处理 UTF-8。测试矩阵:WT + 微软拼音、WT + 搜狗(注意 v1.23.13503 回归)、macOS iTerm2/自带终端、Git Bash(MinTTY)。

### 7.4 Windows 规避清单

1. **启动自检**:`process.stdout.isTTY` 为 false 且 `process.env.MSYSTEM` 存在(MinTTY 特征)时,输出一条人话指引:「检测到 Git Bash (MinTTY),请在 Windows Terminal 中运行,或使用 winpty 启动」([nodejs/node#3006](https://github.com/nodejs/node/issues/3006))。
2. 发布 `winpty` 启动垫片(npm bin wrapper 调 `winpty node ...`)作为 MinTTY 兜底;文档推荐 WT/PowerShell(对齐 Claude Code 的「Git Bash 只作 shell,不作 UI 宿主」策略)。
3. 不依赖 SIGTERM;Ctrl+C 走自管(raw 模式 `\x03` + Ink `exitOnCtrlC:false`);补充监听 SIGBREAK;`on('exit')` 只做同步收尾(恢复终端、flush 状态)。**journal 每个动作即时落盘**,使关窗强杀后可恢复——这是对 SIGHUP 10 秒强杀的唯一可靠防御。
4. 颜色:经 chalk/supports-color 自动分级;`NO_COLOR`/`FORCE_COLOR` 透传尊重;主题提供深/浅/色盲三套前景色映射,不画背景色;`/theme` 命令即时切换。
5. 版本底线:文档注明「Windows Terminal ≥ 1.25 获得 kitty protocol(Shift+Enter 原生可用);旧版用反斜杠续行」([WT releases](https://github.com/microsoft/terminal/releases))。

### 7.5 验证要求(呼应本项目验证标准)

- 每次改动后除现有 `node --check` + headless 截图外,补终端侧手测清单:① WT+微软拼音输入中文→光标位置正确;② 大段粘贴(≥5000 字)不卡帧、确认卡字符数正确;③ Shift+Enter/反斜杠续行两路都通;④ MinTTY 下自检提示出现;⑤ Ctrl+C 停止后 journal 完整、终端无残留帧;⑥ `NO_COLOR=1` 下无 ANSI 色码。

---

## 附录 A:关键转义序列速查(WWriting 会用到的)

| 序列 | 名称/用途 | 备注 |
| --- | --- | --- |
| `CSI ?1049h/l` | 备缓冲进/出 | 本项目不用;测试时需确认退出后画面复原 |
| `CSI t;r r` | DECSTBM 滚动区 | 备选手法,Ink 不用;主/备缓冲 margins 独立 |
| `CSI ?2004h/l` | bracketed paste 开/关 | 粘贴确认卡的触发源 |
| `CSI ?25l/h` | 光标隐藏/显示 | 输入框自绘光标时(配合 `useCursor`) |
| `CSI ?u` / `CSI =flags;mode u` | kitty 协议查询/设置 | Ink 7 已封装,勿手写 |
| `SGR 38;2;r;g;b / 48;2;...` | truecolor 前/背景 | 经 chalk/supports-color 降级 |
| `CSI 2 J` / `CSI 0 J` | 清屏/清光标以下 | 退出清理;ConPTY 下注意与 scrollback 的交互 |
| `OSC 0;title ST` | 设置窗口标题 | 显示「WWriting · 第N章」级上下文 |

来源:[MS Learn VT 文档](https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences)、[kitty 协议文档](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)。

## 附录 B:建议版本基线(2026-09)

| 组件 | 基线 | 依据 |
| --- | --- | --- |
| Node.js | ≥ 24(LTS「Krypton」) | 项目前提;Ink 7 要求 ≥22([OpenJSF](https://openjsf.org/blog/nodejs-24-released)) |
| ink | 7.1.x | [npm](https://registry.npmjs.org/ink/7.1.1) |
| react | 19.2.x | Ink 7 peerDependencies |
| node-pty(仅当需托管子终端) | 1.1.0 稳定 / 1.2.0-beta 跟进 | [npm](https://www.npmjs.com/package/node-pty) |
| 用户终端 | Windows Terminal ≥ 1.25(可选体验)/ conhost 兜底 | [WT releases](https://github.com/microsoft/terminal/releases) |

## 8. 未确认/存疑事项

1. Claude Code 是否使用 node-pty 托管子进程、其 Ink 是否为内部 fork(逆向社区有此说法,无官方声明)。
2. Windows Terminal kitty protocol 实现对 `report-associated-text`(IME 文本)等高级 flag 的覆盖程度。
3. Node 在 Windows 上「自动启用 stdout VT 处理」未见单页官方逐字表述(与 libuv/ConPTY 文档一致,风险低)。
4. opencode 主开发者加入 Charmbracelet 一事来自社区报道,未核对一手声明。
5. OSC 10/11 深浅色自动探测在 2025–2026 是否已有 Node 侧成熟方案。
6. supports-color 各环境变量的精确优先级请以其 README 为准(本次抓取超时,未逐字复核)。

## 9. 主要来源

1. [vadimdemedes/ink(README,含使用者列表与全部 hooks/render 选项)](https://github.com/vadimdemedes/ink)
2. [Ink Releases(版本时间线)](https://github.com/vadimdemedes/ink/releases) / [v7.0.0](https://github.com/vadimdemedes/ink/releases/tag/v7.0.0)
3. [npm registry: ink@7.1.1(engines/peerDeps)](https://registry.npmjs.org/ink/7.1.1) / [npm: ink(使用者与旧版 README)](https://www.npmjs.com/package/ink)
4. [ink src/renderer.ts(差分重绘实现)](https://github.com/vadimdemedes/ink/blob/master/src/renderer.ts) / [src/ink.tsx(Static/fullStaticOutput)](https://github.com/vadimdemedes/ink/blob/master/src/ink.tsx)
5. [The Pragmatic Engineer: How Claude Code is built](https://newsletter.pragmaticengineer.com/how-claude-code-is-built)
6. [Claude Code 文档(Setup/终端配置)](https://code.claude.com/docs)
7. [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
8. [Nanocoder-AI/Nanocoder](https://github.com/Nanocoder-AI/Nanocoder) / [Nanocoder 文档(ACP)](https://docs.nanocollective.org)
9. [openai/codex](https://github.com/openai/codex) / [sst/opencode](https://github.com/sst/opencode)
10. [MS Learn: Console Virtual Terminal Sequences(alt screen/DECSTBM/SGR/启用方式)](https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences)
11. [MS Learn: Creating a Pseudoconsole session(ConPTY)](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)
12. [microsoft/terminal Releases(1.24/1.25:kitty protocol、IME、空 bracketed paste)](https://github.com/microsoft/terminal/releases) / [kitty protocol tracking issue #10741→#19817](https://github.com/microsoft/terminal/issues/10741)
13. [Windows Terminal Preview 1.7(bracketed paste 支持)](https://devblogs.microsoft.com/commandline/windows-terminal-preview-1-7-release/)
14. [kitty keyboard protocol 规范](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)
15. [nodejs/node#3006(MinTTY isTTY 坑与 winpty)](https://github.com/nodejs/node/issues/3006)
16. [Node.js 官方文档:process(信号)](https://nodejs.org/api/process.html) / [tty(raw 模式/颜色环境变量)](https://nodejs.org/api/tty.html)
17. [OpenJS Foundation: Node.js 24 发布公告](https://openjsf.org/blog/nodejs-24-released)
18. [microsoft/node-pty](https://github.com/microsoft/node-pty) / [npm: node-pty](https://www.npmjs.com/package/node-pty)
19. [no-color.org](https://no-color.org/) / [chalk/supports-color](https://github.com/chalk/supports-color)
20. [OpenReplay: Building Terminal Interfaces with Node.js(blessed 停更现状)](https://blog.openreplay.com/building-terminal-interfaces-nodejs)
21. [linux.do:WT v1.23.13503 第三方输入法选词框问题](https://linux.do)
22. [ClaudeLog:Shift+Enter 与 /terminal-setup 实操](https://www.claudelog.com) / [JavaScript Weekly #738(Ink 6.0)](https://javascriptweekly.com/issues/738)
