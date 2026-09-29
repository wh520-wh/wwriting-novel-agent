# Node.js 命令行工具工程实践调研(2025–2026 现状)

- 调研日期:2026-09-27。文中库版本与发布时间均为该日通过 npm registry / GitHub API 实测查询所得,后续会过期。
- 调研范围:Node 24 与 LTS 现状、参数解析、交互提示与 TUI、配置与凭据、ESM 与分发、clig.dev 规范、测试、日志调试。
- 用途:为 WWriting CLI(Node.js ≥ 24,ESM,Windows 主力环境)的实现选型提供依据。

## 核心结论(TL;DR)

1. **Node 24 是当下合理的最低版本**:2025-05-06 发布 Current,2025-10-28 进入 LTS(代号 Krypton),支持到 2028-04-30;自带 npm 11、V8 13.6、稳定 fetch/WebSocket、`node --run`、`--env-file`/`process.loadEnvFile()`。Node 20 将于 2026-04-30 EOL,不应再作为最低版本。[来源](https://endoflife.date/nodejs)、[Node 24.0.0 发布说明](https://nodejs.org/en/blog/release/v24.0.0)
2. **参数解析推荐 commander**:v15.0.0(2026-05-29)转 ESM-only、要求 Node ≥ 22.12.0(依赖 `require(esm)`),子命令/帮助/TS 类型完善,活跃维护;yargs 同样活跃(18.2.0)但 API 更重,且 yargs 16/17 被 Node 25.7/26 的变更打破过;clipanion v4 长期停留在 RC(2024-09 至今无正式版);`util.parseArgs` 适合零依赖场景但无子命令与自动 help。[Commander v15 release](https://github.com/tj/commander.js/releases/tag/v15.0.0)、[yargs#2509](https://github.com/yargs/yargs/issues/2509)
3. **交互提示推荐 @clack/prompts**:v1.8.1 活跃维护(2026-09-13 更新),体积小、默认样式好、ESLint create-config 等已从 Enquirer 迁移到它;inquirer 新版(`@inquirer/prompts` 8.7.2)同样活跃且带官方测试包 `@inquirer/testing`;**prompts 与 enquirer 已停止维护(2023 年起无更新),不要选**。「底部输入框 + 上方流式输出」的主流方案是 Ink 的 `<Static>`(Claude Code、Gemini CLI 均为 Ink 系),不引 React 时可用 readline + ANSI 重绘自制。[clack](https://github.com/bombshell-dev/clack)、[Ink](https://github.com/vadimdemedes/ink)
4. **配置目录用 env-paths 惯例**:Windows 下 config → `%APPDATA%`、data/cache/log → `%LOCALAPPDATA%`,Linux 走 XDG;conf 包提供原子写入与 schema 校验。**keytar 上游(atom/node-keytar)已随 Atom 停服归档,不再使用**;纯 Node CLI 的 API Key 本机存储没有单一公认继任者,现实方案是:0600 明文配置文件、Windows 上用 NAPI 包 `@primno/dpapi`(DPAPI)加密、或直接调用系统凭据库 CLI。[env-paths README](https://raw.githubusercontent.com/sindresorhus/env-paths/main/readme.md)、[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
5. **ESM 是 CLI 应用的默认选择**:应用(非库)没有下游消费者,ESM-only 无兼容负担;Node 22.12+ 已稳定 `require(esm)`,连 commander 这类库都因此敢 ESM-only。npm 包分发是主渠道(bin 字段 + `npm i -g` + npx);单文件二进制可选:Node SEA 仍是实验性(Stability 1.1)且限制多,**pkg 已弃档**;真要单文件优先 `bun build --compile`。[Node SEA 文档](https://nodejs.org/api/single-executable-applications.html)、[pkg(已归档)](https://github.com/vercel/pkg)
6. **clig.dev 是设计基线**:stdout 放结果、stderr 放日志与错误;`-h/--help` 全覆盖、退出码 0 成功/1 一般错误/2 用法错误;只在 stdin 是 TTY 时提示;危险操作用 dry-run、非平凡确认;`NO_COLOR`/非 TTY 时禁色;更新通知走 stderr 且可关闭。[clig.dev](https://clig.dev)
7. **测试:vitest 为主,node:test 为辅**:vitest 5.x 活跃;Node 24 的内置 test runner 已可用(commander 本身已从 Jest 迁到 node:test);交互测试用 `@inquirer/testing` / `ink-testing-library`,端到端 TUI 测试用 node-pty(v1.1.0 于 2026-08 终于发布,Windows 走 ConPTY)。[node-pty](https://github.com/microsoft/node-pty)
8. **日志:stderr + 分级 + 脱敏**:`--verbose/--debug/--quiet` 三档;开发调试用 `debug` 包(`DEBUG=wwriting:*`);若需结构化日志用 pino 的 `redact` 选项;API Key 绝不进环境变量、绝不进日志(clig.dev 明确反对密钥进 env,因为会泄漏到日志与子进程)。[debug](https://github.com/debug-js/debug)、[pino redaction](https://github.com/pinojs/pino/blob/main/docs/redaction.md)

---

## 1. Node 24 / 当前 LTS 现状

### 1.1 版本时间线(2026-09-27 实测,数据源 [endoflife.date API](https://endoflife.date/api/nodejs.json))

| 版本 | 发布 | 进入 LTS | EOL | 备注 |
| --- | --- | --- | --- | --- |
| Node 20 | 2023-04-18 | 2023-10-24 | **2026-04-30** | 即将 EOL,不要作为最低版本 |
| Node 22 (Jod) | 2024-04-24 | 2024-10-29 | 2027-04-30 | Maintenance |
| **Node 24 (Krypton)** | 2025-05-06 | **2025-10-28** | **2028-04-30** | 当前 Active LTS,最新 24.21.0(2026-09-08) |
| Node 25 | 2025-10-15 | — | 2026-06-01 | 已 EOL |
| Node 26 | 2026-05-05 | 2026-10-28(即将) | 2029-04-30 | 当前 Current,最新 26.10.0 |

### 1.2 与 CLI 开发直接相关的特性([Node 24.0.0 发布说明](https://nodejs.org/en/blog/release/v24.0.0))

- **V8 13.6 + npm 11 + Undici 7**:`Float16Array`、`RegExp.escape`、显式资源管理(`using`);npm 11 提升安装性能与安全。
- **URLPattern 成为全局对象**,无需 import,可用于解析/匹配 URL。
- **AsyncLocalStorage 改用 AsyncContextFrame 实现**,跨异步边界的上下文追踪更高效——如果 Agent 运行循环需要「当前这轮输入」的上下文(比如给每个 Agent 轮挂请求级状态),这是官方原生方案。
- **test runner 增强**:子测试自动等待、全局 setup/teardown(`--test-setup-hooks` 生态)、mock JSON 模块、`--test-timeout` 按单测试生效。
- **权限模型转稳**:`node --permission`(不再带 experimental 前缀),可限制 fs/child_process/worker,拒绝时抛 `ERR_ACCESS_DENIED`。对「只读自动、写需确认」的权限分级,可作为深度防御层(阻止 Agent 进程误写非授权路径),但不替代应用层确认流程。
- **fetch 走环境变量代理**:`NODE_USE_ENV_PROXY=1` 时 fetch 遵守 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量(24.0.0 引入)——对国内用户的代理环境是实用特性。
- 弃用清理:`url.parse()` 运行时弃用;`child_process.spawn/execFile` 的 args 数组参数弃用;`NODE_MODULE_VERSION` 更新为 137(原生模块需重编)。

### 1.3 更早引入、Node 24 已稳定可依赖的特性

- **fetch / WebSocket 客户端稳定**:fetch 自 Node 21/22 起无 flag 可用(基于 Undici);WebSocket 客户端自 Node 22 起稳定(全局 `WebSocket`)。调用 LLM 的 SSE 流式接口无需再引 `ws` 或 `node-fetch`。
- **`--env-file` 与 `process.loadEnvFile()`**:`node --env-file=.env app.js` 自 Node 20.6 起可用;`process.loadEnvFile()` 自 21.7.0 起可用。**注意:Node 不会默认自动加载 `.env`**,必须显式声明——网传「Node 24 默认加载 .env」经核实为误传(自动加载的提案未落地;`process.loadEnvFile()` 在文件缺失时还会抛错,[issue #61086](https://github.com/nodejs/node/issues/61086) 在要求非抛错选项)。另有 `--env-file-if-exists`(Node 22.9+)不抛错。
- **`node --run <script>`**:替代 `npm run` 的低开销脚本执行器,Node 22 引入、后续转稳定(具体转稳的小版本号未确认),CLI 项目自身开发脚本用它启动更快。
- **`util.parseArgs` 稳定**([Node 文档](https://nodejs.org/api/util.html#utilparseargsconfig)):支持 `strict`、`tokens` 返回原始 token,适合写一次性脚本;但没有子命令树、自动 help、类型推断,做完整 CLI 仍推荐框架。
- **`require(esm)` 稳定**(Node 22.12 起 unflagged):CJS 文件可以直接 require ESM 包——这是 commander 15 敢 ESM-only 的前提,也是判断「最低版本 ≥ 22.12 还是 ≥ 24」的关键技术点。

### 1.4 结论

以 **Node 24 为最低版本**合适:LTS 支持到 2028-04,覆盖项目开发周期;`engines` 写 `"node": ">=24"` 简单明确。若想更保守可用 `">=22.12.0"`(与 commander 15 的门槛一致),但项目无历史包袱,直接 24 即可。Node 26 将于 2026-10-28 进 LTS,届时再评估提升。

---

## 2. CLI 参数解析框架对比

### 2.1 维护状态实测(2026-09-27,npm registry)

| 包 | 最新版 | 最近更新 | engines | 状态 |
| --- | --- | --- | --- | --- |
| commander | 15.0.0 | 2026-09-02 | `>=22.12.0` | 活跃 |
| yargs | 18.2.0 | 2026-09-20 | `^20.19.0 \|\| ^22.12.0 \|\| >=23` | 活跃 |
| cac | 7.0.0 | 2026-02-27 | `>=20.19.0`,ESM-only | 活跃但节奏慢 |
| clipanion | 4.0.0-rc.4 | 2024-09-06 | — | **v4 停滞两年**(v3 仍可用) |
| oclif | 6.0.2 | 2026-09-25 | — | 活跃(重型框架) |

### 2.2 各家要点

- **commander**([GitHub README](https://github.com/tj/commander.js)):28k+ stars,2011 年至今持续维护;`program.command()` 声明子命令、`parseAsync()`、`action()` handler、内置 `--help` 生成、`--no-*` 取反选项、生命周期 hooks(`preAction` 等)、help 分组(`helpGroup`)、TS 类型增强(`@commander-js/extra-typings`)。v15(2026-05-29)**转 ESM-only**、要求 Node ≥ 22.12.0、测试从 Jest 迁到 node:test;v14 进入维护期(安全更新到 2027-05)([v15 release notes](https://github.com/tj/commander.js/releases/tag/v15.0.0))。v15 破坏性变更之一:仅单独的 `--no-*` 选项才把默认值设为 true,同时定义正反选项时不再隐式设默认。
- **yargs**:功能最全(自动校验、coercion、middleware、bash/zsh 补全),但 API 面大、心智负担重。值得记录的坑:**Node 25.7/26 的运行时变更打破了 yargs 16/17**([issue #2509](https://github.com/yargs/yargs/issues/2509),2026-02),yargs 18 是修复版——闭源依赖老版本 yargs 的工具在 Node 升级时被连坐,说明「依赖紧跟运行时演进的库」本身就是风险控制。
- **cac**:Vite 系工具用的轻量解析器,API 简洁(`.command()` + `.option()` 链式),v7 已 ESM-only;适合小工具,生态与文档不如 commander 厚。
- **clipanion**:TypeScript 优先、类/装饰器式命令定义(Yarn Berry 的 CLI 用它);但 v4 自 2024-09 停在 RC 没有正式发布,**新项目不建议押注**。
- **oclif**:Salesforce 系的全家桶框架(命令文件即类、插件系统、自动文档与测试脚手架);对多命令大 CLI 合适,对单命令聊天式 Agent 过重。
- **util.parseArgs**:零依赖,见 §1.3;配合手写子命令分发可用于极简 CLI,但自动 help、类型、补全都得自己写。
- **Stricli**(Bloomberg):TS codegen 风格的新框架,官方文档有与 yargs/commander/oclif 的[对比](https://bloomberg.github.io/stricli/docs/getting-started/alternatives);尚属小众,未纳入推荐。
- 第三方对比评测(secondary source,与本文实测数据一致):[Commander vs Yargs in 2026](https://www.pkgpulse.com/guides/commander-vs-yargs-2026)、[CLI Framework Comparison](https://www.grizzlypeaksoftware.com/library/cli-framework-comparison-commander-vs-yargs-vs-oclif-utxlf9v9)。

### 2.3 commander 的关键 API 与配置项(实现时直接对照)

- `new Command('wwriting')` 创建根命令;`program.name/version/description()` 驱动 `--help` 与 `--version`(`version` 读取 package.json 建议在构建时注入)。
- 子命令:`program.command('init', { isDefault: false })` 或 `.command('config <key> [value]')`(尖括号必选、方括号可选);每个子命令独立 `.option()/.action()`。
- 选项:`.option('-v, --verbose', '描述')`;布尔取反用 `.option('--no-color')`(解析后得到 `color: false`);带值选项 `.option('-p, --project <path>')`;环境变量兜底用 `.env('WW_DEBUG')`(v12+ 支持 option 级 env 回退)。
- 解析:`program.parseAsync(process.argv)`(异步 action handler 需要);`allowExcessArguments(false)` 收紧多余参数;`showSuggestionAfterError()` 默认开启拼错提示。
- 退出与错误:action 抛错时 commander 输出错误并 `exitCode = 1`;`program.exitOverride()` 可接管退出行为(自建错误呈现时必需,否则 commander 直接 process.exit,无法做「错误只呈现一条用户可理解的事实 + 详情折叠」)。
- TS 类型:推荐 `@commander-js/extra-typings`(随主包同步发版),从 `.option()` 链推导参数类型,免手写 interface。
- 生命周期:`program.hook('preAction', ...)` 适合放「权限检查 / journal 记录」这类横切逻辑。

### 2.4 斜杠命令的组织

斜杠命令(`/写`、`/init`)不是 argv 解析问题,而是单一输入文本的前缀路由:解析发生在 Agent 收到整行输入之后。argv 框架只服务于「启动参数」(`wwriting`,可选 `wwriting <project>`)。两者分层:启动参数用 commander;斜杠命令用自建的前缀匹配表(名称、别名、参数模式、权限级别、描述,同一张表驱动 Tab 补全与 help 列表)。clig.dev 的子命令一致性原则(相同含义用相同 flag、避免 update/upgrade 式含糊命名)同样适用于斜杠命令命名。

---

## 3. 交互式提示与终端 UI 布局

### 3.1 提示库维护状态实测(2026-09-27)

| 包 | 最新版 | 最近更新 | engines | 状态 |
| --- | --- | --- | --- | --- |
| @clack/prompts | 1.8.1 | 2026-09-13 | `>=20.12.0` | 活跃,社区首选 |
| @inquirer/prompts | 8.7.2 | 2026-09-07 | `>=23.5.0 \|\| ^22.13.0 \|\| ^20.17.0` | 活跃 |
| ink | 7.1.1 | 2026-07-16 | `>=22` | 活跃 |
| prompts | 2.4.2 | 2023-10-21 | — | **停更近 3 年,勿用** |
| enquirer | 2.4.1 | 2023-07-28 | — | **停更 3 年,勿用** |

- **@clack/prompts**([仓库](https://github.com/bombshell-dev/clack)、[文档](https://bomb.sh/docs/clack/basics/getting-started)):预置样式的封装(底层是可定制组件库 `@clack/core`),API:`intro/outro/text/select/multiselect/confirm/spinner/taskLog/stream/brandedSpinner`;`tasks()` 支持步骤化进度。体积小、默认观感好。ESLint 的 create-config 因 Enquirer 停更而从 Enquirer 迁移到 clack([issue](https://github.com/eslint/create-config/issues/229))。clack 仓库约 8k stars,发版频繁(2026-09-21 仍有 release PR)。
- **@inquirer/prompts**([Inquirer.js](https://github.com/SBoudrias/Inquirer.js)):老 inquirer 的现代重写,按 prompt 拆包(`@inquirer/confirm` 等),函数式 API,自带官方测试工具 `@inquirer/testing`(3.3.13,2026-09-07 更新):`render(prompt)` 返回 `{ answer, events, getScreen }`,用 `events.keypress('enter')` 驱动、`getScreen()` 断言画面。
- **Ink**([仓库](https://github.com/vadimdemedes/ink)):把 React 渲染到终端,组件 + hooks + Yoga flexbox 布局;`<Static>` 组件只渲染一次、适合不可变的历史输出,动态区域(输入框、spinner、状态行)由 React state 驱动重绘。配套框架 [pastel](https://github.com/vadimdemedes/pastel)(4.0.1,活跃)与 [ink-testing-library](https://github.com/vadimdemedes/ink/tree/main/packages/ink-testing-library)(4.0.0,2024-05 后未更新但可用)。Ink 7 要求 Node ≥ 22。
- 第三方对比(与实测一致):[Ink vs @clack/prompts vs Enquirer 2026](https://www.pkgpulse.com/guides/ink-vs-clack-vs-enquirer-interactive-cli-nodejs-2026)。

### 3.2 「底部输入框 + 上方流式输出」的实现路径

这是 Claude Code 式布局:已完成的输出像普通终端输出一样向上滚走(进 scrollback),屏幕底部常驻一个输入区。三种实现:

1. **Ink `<Static>` 模式**(Claude Code、Gemini CLI 的路线;Gemini CLI 直接 vendored 了一份打过补丁的 Ink):流式输出追加进 `<Static>`,输入框与状态行是最底部的动态组件。优点:交互体验最完整(单行输入编辑、历史、全键盘处理);代价:引入 React 渲染模型、要求输入框逻辑在 React 内实现,且 Windows Terminal 下对 emoji/宽字符的重绘角落问题仍需自测。
2. **readline + ANSI 自绘**(不引 React):用 `node:readline` 的 `question()`/`Interface` 做底部输入,流式输出直接 `console.log()` 到 scrollback,状态行用 `ansi-escapes`(7.3.0)+ `log-update` 风格在输入区上方重绘。这与当前 HTML 原型「composer 上方实时行」的交互模型一一对应,复杂度最低,长文流式输出天然进 scrollback。
3. **Alternate screen 全屏 TUI**(blessed/neo-blessed 路线):不适合本产品——整屏接管后流式长文不可回滚、与终端原生命令行习惯冲突,clig.dev 也建议输出优先人类可读、保留 scrollback。

### 3.3 readline 自绘方案的关键细节(方案 2 实现要点)

- 底部输入:`readline.createInterface({ input, output, prompt })` + `rl.prompt()`;流式输出到达时先 `rl.pause()` → 清当前输入行(`ansi-escapes.cursorLeft + eraseLine`)→ `console.log()` 输出 → 重绘 prompt 与已输入内容 → `rl.resume()`;这是 Claude Code 式「输出不打断输入」的最小实现。
- 实时状态行(composer 上方):`process.stdout.write` + `\r\x1b[K`(回车 + 擦行)覆盖重绘;结束轮次后输出终态状态行并换行,留在 scrollback。
- 中文输入:readline 自身按字符处理,IME 组合输入(Windows 上经 ConPTY 逐字提交)不依赖 raw mode 时无额外处理;若需要 Tab 补全斜杠命令,用 `rl.setCompleter()`(补全结果含中文时注意列宽)。
- 原始按键(可选):`input.setRawMode(true)` 捕获 Ctrl+C 以外的快捷键;开 raw mode 后 Ctrl+C 不再产生 SIGINT 而是读到 `\x03`,需要自行路由到「停止」逻辑——这与铁律 5 的停止契约要在同一处实现。

### 3.4 CJK 宽字符风险

CJK 双宽字符导致的终端错位是这类库的通病(根因是列宽计算,[同类案例](https://github.com/rclone/rclone/issues/2989));clack/inquirer/ink 内部均依赖 `string-width`(8.3.0,活跃)族包处理,但**具体到 clack 的中文错位 issue 未能检索到确证实例(未确认)**。WWriting 全中文文案下,任何提示库上线前必须实测:`select` 选项、`text` 输入回显、`spinner` 文本含中文时的对齐;不行就退回 readline 自绘(方案 2,行为完全可控)。

---

## 4. 配置与凭据存储

### 4.1 配置目录:XDG 与 Windows 的差异

- Linux 遵循 XDG Base Directory(`~/.config`、`~/.local/share`、`~/.cache`);**Windows 没有对应标准**,惯例映射是 `%APPDATA%`(Roaming,配置)与 `%LOCALAPPDATA%`(Local,数据/缓存/日志)。clig.dev 要求「遵循 XDG、别往主目录撒 dotfiles」,跨平台映射不要自己写。
- **env-paths**(4.0.0,2026-01 更新,ESM,Node ≥ 20)实测映射([README](https://raw.githubusercontent.com/sindresorhus/env-paths/main/readme.md)):
  | 类别 | Windows | Linux |
  | --- | --- | --- |
  | config | `%APPDATA%\<App>-nodejs\Config` | `~/.config/<app>-nodejs`(尊重 `$XDG_CONFIG_HOME`) |
  | data | `%LOCALAPPDATA%\...\Data` | `~/.local/share/...` |
  | cache/log/temp | `%LOCALAPPDATA%\...` | `~/.cache/...`、`~/.local/state/...`、`/tmp` |
  默认会给目录加 `-nodejs` 后缀(`suffix: ''` 可去掉);只返回路径不创建目录,需自行 `fs.mkdir({recursive: true})`。
- **conf**(15.1.0,2026-02,ESM):基于 env-paths 的键值存储,原子写、schema 校验、迁移钩子;适合存 UI 偏好等非敏感状态。
- **cosmiconfig**(10.0.1,2026-08,engines `^22.18 || >=24`):按约定搜索 `wwriting.config.*`/`package.json#wwriting` 等项目级配置。WWriting 的项目记忆是自有格式的 `WWRITING.md`(手工可编辑、不生成固定蓝图),**不需要** cosmiconfig 式的自动发现;工程配置(模型、温度、代理)量小时直接读写 JSON 文件即可。

### 4.2 API Key 本机存储(keytar 停维之后)

- **keytar 确认不可用**:上游 atom/node-keytar 随 Atom 停服归档([仓库](https://github.com/atom/node-keytar)),原生模块跨 Node 版本(N-API 137)维护负担转嫁用户,勿再引入。
- 现实方案梯队(纯 Node CLI,无 Electron):
  1. **0600 明文配置文件**(最常见):key 存 `envPaths('wwriting').config` 下的 JSON;POSIX `chmod 0600`;**Windows 无 POSIX 权限位**,文件在用户 profile 下默认受当前用户 ACL 保护,配合 `%APPDATA%` 语义可接受。Claude Code 等商业 CLI 默认即落本机文件/keychain(具体实现未公开,未确认)。
  2. **Windows DPAPI 加密**:[@primno/dpapi](https://github.com/primno/dpapi)(2.0.1,2025-01,N-API 预编译,Windows only)提供 `protectData/unprotectData`(CurrentUser 作用域),把 key 密文落盘、运行时解开;同机同用户才能解,优于明文。注意 N-API 包有 NODE_MODULE_VERSION 绑定,大版本升级要重装。
  3. **调用系统凭据库 CLI**:macOS `security add-generic-password`、Linux `secret-tool`(libsecret)、Windows PowerShell `cmdkey`/CredentialManager 模块——零原生依赖但子进程调用粗糙、错误处理繁琐,作为可选增强而非默认。
  4. **Electron `safeStorage`**([文档](https://www.electronjs.org/docs/latest/api/safe-storage)):仅 Electron 环境;Windows 底层即 DPAPI,Linux 无 keyring 服务时会退化为硬编码密钥加密(等于明文)——对本项目不适用,列出仅供对照。
- clig.dev 明确警告:**不要用环境变量传密钥**(会泄漏到日志、子进程、`docker inspect` 等)。对 LLM API Key 的落地:交互首次录入(回显关闭)→ 存本机 → 运行时直接读文件,`--key` 参数与环境变量最多作为 CI 逃生门并写明风险。

---

## 5. ESM/CJS、分发与发版

### 5.1 ESM/CJS 现状

- 生态结论:**库走 dual(CJS+ESM)仍是稳妥默认,CLI 应用 ESM-only 无任何负担**(应用没有下游 require 它)。sindresorhus 自 2021 年起 ~1000 个包全部 ESM-only 且从未回头([sindresorhus/meta#15](https://github.com/sindresorhus/meta/issues/15)),chalk 6(2026-09-27 更新)等一线工具链包均为 ESM-only。
- **`require(esm)` 改变了攻守**:Node 22.12+ 稳定支持 CJS 里 require ESM 包,commander 15 因此直接 ESM-only。2025–2026 新写 CLI 不需要再纠结 dual:直接 `"type": "module"`,`.js` 后缀 + ESM 语法。
- 注意点:ESM 中 `__dirname`/`__filename` 要用 `import.meta.dirname`(Node 20.11+)替代;顶层 await 可用。

### 5.2 npm 全局安装与 bin

- `"bin": { "wwriting": "./dist/cli.js" }` + 入口文件 `#!/usr/bin/env node` shebang;`npm i -g` 全局安装、`npx wwriting` 一次性运行(`-y` 跳过确认)。[npx 文档](https://docs.npmjs.com/cli/commands/npx)。
- `files` 字段白名单发布内容;`engines.node` 写 `"error"` 策略强制版本门槛。

### 5.3 发版工具

- **changesets**([@changesets/cli](https://github.com/changesets/changesets) 3.0.3,2026-09-14 更新):`.changeset/*.md` 意图文件 → `changeset version` 消费并生成 CHANGELOG → `changeset publish`;对 monorepo 支持最好,pnpm/vite/astro 系标配。
- 替代品:release-it(单包自动发版)、semantic-release(commit 驱动全自动)。单人维护的 CLI 用 changesets 最轻;本项目文档与代码同仓,changesets 的「意图文件进 review」模式也利于记录决策。

### 5.4 单文件二进制分发

| 方案 | 状态 | 要点 |
| --- | --- | --- |
| Node SEA | 实验性(Stability 1.1,[官方文档](https://nodejs.org/api/single-executable-applications.html)) | blob 注入 node 二进制;旧流程 `--experimental-sea-config` + postject,v25.5.0 起 `--build-sea` 一步生成;**注入脚本默认不能从文件系统加载模块**(须先 bundle 成单文件),原生插件要经 VFS/临时文件 `dlopen`;macOS 仅 arm64、须签名;Windows 须先去签名再注入 |
| bun build --compile | 活跃、体验最好 | 单命令产出含运行时的独立二进制,支持交叉编译 |
| deno compile | 成熟 | Deno 生态专属,不适用于 Node 项目 |
| vercel/pkg | **已弃档**([仓库](https://github.com/vercel/pkg)) | 官方建议迁移到 Node SEA |
| caxa 3.0.1 / nexe beta | 半停更(2023-11 / 2025-03) | 自解压或打包方案,不建议新项目采用 |

结论:**npm 包是主渠道,单文件二进制当前不值得做**——WWriting 目标用户是装了 Node 的开发者,npm 全局安装最顺;SEA 的限制(模块加载、签名、平台)与收益不成比例。若未来要给无 Node 环境的用户,优先评估 bun compile(需验证 ESM/原生依赖兼容性)。

---

## 6. CLI 通用设计规范(clig.dev)

[clig.dev](https://clig.dev) 全文要点中,与 WWriting 直接相关的:

- **输出分流**:结果与机器可读内容 → stdout;日志、错误、进度、更新通知 → stderr;`| jq`、重定向才不会脏。
- **退出码**:0 成功;1 一般错误;2(或 sysexits 64 起)用法错误;脚本靠退出码判断,错误类别要可区分。
- **help**:`-h` 与 `--help` 都要支持且等价,加在任何子命令后都要工作;无参数时显示简明帮助(示例先行);帮助进 stdout;`myapp help sub` 也要通。
- **错误呈现**:可预期的错误翻译成人话 + 下一步动作;意外错误给 debug 线索与反馈入口;拼错命令给「你是不是想…」建议但不代执行。这与铁律 3(错误只呈现一条用户可理解的事实、详情折叠)完全同向。
- **交互纪律**:只在 stdin 是 TTY 时提示;提供 `--no-input`;危险操作三级确认(轻度免确认、中度 dry-run、重度要求输入名称等非平凡确认 + `--confirm` 逃生门)——与铁律 4 的权限分级、极端操作「输入精确确认文字」互相印证。
- **颜色**:`NO_COLOR`、`TERM=dumb`、非 TTY、`--no-color` 时禁色;`FORCE_COLOR` 强制。
- **环境变量**:检查 `NO_COLOR`/`DEBUG`/`EDITOR`/`HTTP(S)_PROXY`/`NO_PROXY`/`TERM`/`COLUMNS`/`PAGER`;命名大写+下划线。
- **配置优先级**:flags > 环境变量 > 项目级配置 > 用户级配置 > 系统级配置。
- **更新通知**:低调、走 stderr、可用环境变量关闭;不打断交互(与 update-notifier 的 CI 自动跳过行为一致)。
- **不要**做:默认省略的万能子命令、任意缩写子命令、内置阻塞式遥测、依赖可能消失的外部服务。

SIGINT/优雅退出(补充自 Node 文档与社区惯例):注册 `process.on('SIGINT')` 后 Node 不再默认退出,清理逻辑要自担;Windows 上 Ctrl+C 由控制台模拟 SIGINT(Ctrl+Break → SIGBREAK),行为可用但要实测 Git Bash/Windows Terminal 组合;推荐模式:`SIGINT` 触发收敛(进行中的写入保持完整)→ 超时兜底 `process.exit(非零)`;**双击 Ctrl+C 立即强杀**是通用 UX 惯例;`process.on('exit')` 只能做同步清理。这直接对应铁律 5 的「停止干净收敛、不产生第二个 Agent」。

---

## 7. 测试方法

- **框架**:[vitest](https://vitest.dev)(5.0.2,2026-09-25 更新)为 ESM/TS 项目默认;Node 内置 `node:test` 已可用且免依赖——commander v15 自己都从 Jest 迁到了 node:test;两者可并存(单测 vitest,不引依赖的冒烟用 node:test)。
- **分层测试策略**(推荐):
  1. **纯逻辑**(字数统计、队列、权限判定、斜杠命令解析):普通单测,不碰终端;
  2. **提示/渲染组件**:`@inquirer/testing`(render/events/getScreen 断言)或 ink-testing-library;已知坑:Ink 的 `useInput` 在 `useEffect` 内注册 stdin 监听,`render()` 后立即 `stdin.write()` 会竞态,需先 await 一拍;
  3. **端到端 TUI**:[node-pty](https://github.com/microsoft/node-pty)(v1.1.0,2026-08-03 正式发布——该包此前近六年停在 1.0.0;1.2.0-beta 持续中)起伪终端跑真实二进制,断言屏幕快照;Windows 底层是 ConPTY(Win10 1809+),老旧/损坏的 ConPTY 构建上有兼容问题(生态中已有项目在旧 Windows 上禁用 node-pty 的先例)。
- **非 TTY 退化路径必须测**:stdin 非 TTY 时提示库应报错并提示改用 flags(见 §6 交互纪律),这是 CI 下跑测试的天然入口。
- 纯逻辑单测示例(字数与队列不碰终端,是回归主力):
  ```ts
  import { describe, it, expect } from 'vitest';
  describe('count_text', () => {
    it('按中文习惯统计字数', () => {
      expect(countText('你好世界 hello')).toMatchObject({ total: 9, cjk: 4 });
    });
  });
  ```
- Windows 专项:Git Bash(MSYS 路径)、Windows Terminal、cmd 三种宿主下的 Ctrl+C、颜色、宽字符各跑一遍冒烟;node-pty 测试在 CI 上建议只跑 Windows/Ubuntu 两个矩阵,macOS ConPTY 无关。

---

## 8. 日志与调试

- **分级与开关**:`--verbose`(常规详情)、`--debug`(最细)、`--quiet`(只留错误);同时尊重 `DEBUG` 环境变量命名空间惯例。
- **debug 库**([debug-js/debug](https://github.com/debug-js/debug) 4.4.3):`DEBUG=wwriting:*` 按命名空间开日志,输出自动走 stderr、支持 `DEBUG_COLORS`;开发期零成本,5 行接入,是 CLI 事实标准。
- **结构化日志**:需要持久日志文件时用 [pino](https://github.com/pinojs/pino)(10.3.1)——JSON 输出、异步写入、`redact` 选项按路径脱敏([redaction 文档](https://github.com/pinojs/pino/blob/main/docs/redaction.md)),如 `pino({ redact: ['req.headers.authorization', '*.apiKey'] })`;轻量场景 `redact-secrets`(1.0.0,2022 年后未更新,概念可借鉴:把含密字段替换为 `[REDACTED]`)。
- **脱敏规则**(落实铁律 8「API Key 只在本机」):密钥只在录入与写文件两处出现;日志对象统一过 sanitize 层(白名单字段而非黑名单);错误上报/堆栈打印前扫描 key 模式(sk-… 等);debug 日志文件放 `envPaths().log`(不进用户创作文件夹);`--verbose` 输出到 stderr 而非 stdout。

---

## 9. 对 WWriting CLI 的落地建议

结合项目铁律与上述调研,给出明确选型:

### 9.1 运行时与工程底座

- **Node `>=24`,`"type": "module"`(ESM-only)**。理由:LTS 到 2028-04;fetch/WebSocket/`--env-file`/`util.parseArgs` 全部免依赖可用;Node 20 临近 EOL。`engines` 锁死,配合 `engine-strict=true`。
- TypeScript 直接编译为单份 ESM 产物;发版用 **changesets**(单人仓库也够用,意图文件可沉淀决策)。
- 不做单文件二进制;npm 分发,`bin.wwriting` + shebang。

### 9.2 参数解析与斜杠命令

- 启动参数:**commander(v15)**。理由:最活跃 + 文档最厚 + 子命令/help/TS 全套现成;engines 与本项目最低版本一致(≥22.12);cac 轻但生态弱,yargs 重且踩过 Node 升级连坐的坑,clipanion v4 停滞。唯一注意:接受其 ESM-only(本项目本来就是 ESM)。
- 斜杠命令:**自建前缀路由表**,不塞进 commander。单张命令表(名称/别名/参数/权限级别/描述)同时驱动:输入解析、Tab 补全、`/help` 列表、权限分级判定(普通确认/极端操作映射)。

### 9.3 终端交互面(对应铁律 1/2)

- **推荐 readline + ansi-escapes 自绘(§3.2 方案 2)作为第一版**:与 HTML 原型「composer 上方实时行 + 轮内活动行」的交互模型同构;流式输出自然进 scrollback(满足「Run 结束只留状态行与可回看内容」);无 React 心智负担;中文宽字符行为完全自控。配 `picocolors`(1.1.1,dual 包、体积最小,比 chalk 6 ESM-only 更稳)处理颜色,自实现 `NO_COLOR`/TTY 判断。
- **权限确认卡、极端确认卡、FIFO 队列状态**:用 @clack/prompts 的组件化能力(`confirm`、`taskLog`、`stream`)——它是当前维护最活跃、体积最小的提示库,API 与「一次允许/本条输入允许同类/拒绝」的三选卡片可自然映射。上线前必须做中文宽字符实测(§3.3);若错位不可修,确认卡也退回 readline 自绘。
- 打断与停止:`SIGINT` 处理器实现「干净收敛」(清临时授权、保证写入完整、留下状态行),双击 Ctrl+C 强杀兜底;Windows Terminal/Git Bash 实测通过后才算完成。

### 9.4 数据与凭据(对应铁律 6/7/8)

- 目录:**env-paths**(`suffix: ''`),journal/会话/成本进 `data` 与 `log`,配置进 `config`;`WWRITING.md` 只放用户创作文件夹根。**绝不**用 `--env-file` 自动加载创作目录里的 `.env`(避免把私有数据混进创作文件夹的边界)。
- API Key:默认 **0600 JSON 文件(envPaths().config)**;Windows 增强:`@primno/dpapi` 加密落盘(可选特性,失败回退明文并提示);不引入 keytar;不用环境变量传 key(文档中明示)。
- 字数统计:`count_text` 保持自研(词元切分按中文习惯),不信任模型自报——与 CLI 生态无冲突,纯函数最容易测。

### 9.5 质量保障

- 测试:**vitest** 为主 + `node:test` 冒烟;权限分级、队列、打断是纯逻辑重点;`@inquirer/testing` 测确认卡;node-pty 端到端冒烟(Windows ConPTY)仅覆盖关键路径(启动横幅、权限卡、极端确认、运行终态),与现有「headless 截图自查」互补。
- 日志:`--verbose/--debug/--quiet` 三档 + `debug` 库命名空间;持久日志走 pino + `redact`,密钥白名单脱敏;全部输出 stderr,stdout 只留给正文与机器可读结果。
- 更新通知:`update-notifier`(7.3.1,ESM,Node ≥ 18)低调检查 npm registry,CI 自动跳过,通知走 stderr 且可关闭;不阻塞启动。

### 9.6 需要进一步验证的点(进入实现前)

1. @clack/prompts 在 Windows Terminal + Git Bash 下的中文宽字符渲染(决定确认卡走 clack 还是自绘);
2. Node 24 的 `--permission` 模型对「只读放行/写需确认」的辅助价值(能否低成本限制 Agent 子进程写路径);
3. `@primno/dpapi` 在 Node 24(N-API 137)下的预编译可用性;
4. Ink 方案作为备选的可行性(若未来交互复杂度超出 readline 自绘能力)。

---

## 附:主要来源清单

1. [Node.js 24.0.0 发布说明](https://nodejs.org/en/blog/release/v24.0.0)(官方)
2. [endoflife.date/nodejs API(版本时间线实测)](https://endoflife.date/api/nodejs.json)
3. [Node.js SEA 官方文档](https://nodejs.org/api/single-executable-applications.html)(官方)
4. [Node.js 读取环境变量指南(--env-file / loadEnvFile)](https://nodejs.org/learn/command-line/how-to-read-environment-variables-from-nodejs)(官方)
5. [util.parseArgs 文档](https://nodejs.org/api/util.html#utilparseargsconfig)(官方)
6. [clig.dev — Command Line Interface Guidelines](https://clig.dev)
7. [commander.js GitHub(README 实测:stars/engines/API)](https://github.com/tj/commander.js)
8. [Commander v15.0.0 release notes(ESM-only / Node ≥22.12 / node:test)](https://github.com/tj/commander.js/releases/tag/v15.0.0)
9. [yargs issue #2509:Node 25.7/26 打破 yargs 16/17](https://github.com/yargs/yargs/issues/2509)
10. [Stricli:替代方案对比文档](https://bloomberg.github.io/stricli/docs/getting-started/alternatives)
11. [@clack/prompts 仓库](https://github.com/bombshell-dev/clack)
12. [clack 官方文档](https://bomb.sh/docs/clack/basics/getting-started)
13. [ESLint create-config:Enquirer → clack 迁移 issue](https://github.com/eslint/create-config/issues/229)
14. [Inquirer.js 仓库(@inquirer/prompts / @inquirer/testing)](https://github.com/SBoudrias/Inquirer.js)
15. [Ink 仓库(<Static>/测试库)](https://github.com/vadimdemedes/ink)
16. [env-paths README(跨平台目录映射实测)](https://raw.githubusercontent.com/sindresorhus/env-paths/main/readme.md)
17. [conf 仓库](https://github.com/sindresorhus/conf)
18. [cosmiconfig 仓库](https://github.com/cosmiconfig/cosmiconfig)
19. [keytar 原始仓库(已归档)](https://github.com/atom/node-keytar)
20. [Electron safeStorage 文档(DPAPI/Keychain/libsecret)](https://www.electronjs.org/docs/latest/api/safe-storage)
21. [@primno/dpapi 仓库(Windows DPAPI NAPI 封装)](https://github.com/primno/dpapi)
22. [sindresorhus/meta#15:Pure ESM 立场讨论](https://github.com/sindresorhus/meta/issues/15)
23. [npm npx 文档](https://docs.npmjs.com/cli/commands/npx)(官方)
24. [changesets 仓库](https://github.com/changesets/changesets)
25. [vercel/pkg 仓库(已弃档)](https://github.com/vercel/pkg)
26. [node-pty 仓库(1.1.0 / ConPTY)](https://github.com/microsoft/node-pty)
27. [debug 仓库](https://github.com/debug-js/debug)
28. [pino redaction 文档](https://github.com/pinojs/pino/blob/main/docs/redaction.md)
29. [update-notifier 仓库](https://github.com/sindresorhus/update-notifier)
30. [Ink vs @clack/prompts vs Enquirer 2026(第三方对比)](https://www.pkgpulse.com/guides/ink-vs-clack-vs-enquirer-interactive-cli-nodejs-2026)
31. [Commander vs Yargs in 2026(第三方对比)](https://www.pkgpulse.com/guides/commander-vs-yargs-2026)
32. [Node.js issue #61086:loadEnvFile 缺文件抛错问题](https://github.com/nodejs/node/issues/61086)
