# 项目状态、验证与历史记录

记录于：2026-10-14｜状态：当前有效｜依据：v0.5.5 桌面源码更新、本地打包与下列分日期验证日志；此前组件圆角与表面记录保留原基线，CLI 状态仍沿用 2026-10-08 验证。

本文件是项目维护记忆，按“当前状态 → 已确认待办 → 最近变更 → 历史记录”阅读。它不代替[行为规格](../design/统一行为规格书.md)或[领域词汇](../../CONTEXT.md)。测试结果表示所列日期和范围的验证；未重跑的结果不能代表当前工作树全绿。

## 当前状态

- 桌面版与 CLI 各自有运行入口、模型适配、会话存储和测试；根目录 `npm test` 不包含 CLI。版本与依赖以各自 `package.json` 为准：本次复核桌面版 `0.5.5` / Node ≥24，CLI `0.1.0` / Node ≥22；CLI 已有 `yaml` 运行时依赖。
- CLI 已取消固定小历史窗口，接近模型窗口才自动压缩；完整行为见[统一书 §34](../design/统一行为规格书.md#34-cli-长篇上下文与自动压缩)。写作工作区的 `WWRITING.md` 是作品记忆，与本文件的工程记忆分开。

| 入口 | 最近一次验证 | 结果 | 依据与边界 |
|---|---|---|---|
| 桌面全量 `npm test`，v0.5.5 本地更新前 | 2026-10-14 | 2096/2096，exit 0 | `.local/reading-update-full-tests.log`；包含本轮跟读、等待、选区/键盘、操作焦点、重复渲染、复制反馈和聊天切换回归；正常本机权限，不包含 CLI |
| v0.5.5 Windows x64 安装器 / 本地可运行包更新 | 2026-10-14 | 构建、产物检查及启动冒烟 exit 0 | `npm run package:installer`、`npm run verify:installer`、`npm run verify:packaged-dir`、`.local/reading-update-artifact-check.cjs`；对应 `.local/reading-update-build-installer.log`、`.local/reading-update-installer-check.log`、`.local/reading-update-packaged-smoke.log` 与 `.local/reading-update-artifact-check.json`；包内版本与四个改动源码逐字节匹配，更新工作区 `dist-desktop/win-unpacked`，未发现已登记安装版或快捷方式，未执行安装器安装或上传 Release 附件 |
| 聊天切换跟随 / 时间线 / 阅读跟随 / 定稿 / 架构定向检查 | 2026-10-14 | 251/251，exit 0 | `node --test tests/app-shell/agent-surface.test.mjs tests/app-shell/view-timeline.test.mjs tests/app-shell/agent-stream-finalize.test.mjs tests/architecture/dependency-rules.test.mjs`；`.local/ai-chat-follow-targeted.log`；新增四路径行为用例在旧实现下失败（`.local/ai-chat-follow-before-tests.log`）；覆盖缓存/首次聊天、新对话占位、项目切换及原回放阅读不跳动用例，不代表全量 |
| Electron 聊天切换与回放定向检查 | 2026-10-14 | 16 场景通过，exit 0，renderer errors 0 | `.local/ai-chat-follow-check.cjs`（复用 `.local/ai-reading-check.html`）、`.local/ai-chat-follow-electron.stdout.log`、`artifacts/ai-chat-follow-2026-10-14/result.json`；深浅主题 × 1280/391px × 首次聊天/缓存聊天/占位/项目四路径，通过真实 AgentSurface 公共入口调用、本地模拟 API；新聊天默认落底，空白聊天立即隐藏旧按钮，每场景同时复核回放保留可见正文锚点（误差 ≤1px）；旧实现切换后仍距底部 826px（同目录 `baseline.json`），不调用模型或修改作品 |
| 静止正文 / 连续复制反馈 / 时间线 / 阅读跟随 / 定稿 / Markdown / 架构定向检查 | 2026-10-14 | 286/286，exit 0 | `node --test tests/app-shell/view-timeline.test.mjs tests/app-shell/agent-surface.test.mjs tests/app-shell/agent-stream-finalize.test.mjs tests/app-shell/markdown-lite.test.mjs tests/architecture/dependency-rules.test.mjs`；`.local/ai-idle-feedback-targeted.log`；两项回归在各自旧实现下失败（`.local/ai-stream-idle-before-tests.log`、`.local/ai-copy-feedback-before-tests.log`），覆盖选区释放补齐、跟随、同文本定稿、最近一次复制反馈、不同消息独立计时与重置清理；不代表全量 |
| Electron 长回复输入 / 连续复制反馈定向检查 | 2026-10-14 | 4 输入场景 + 4 复制场景通过，exit 0，renderer errors 0 | `.local/ai-stream-idle-check.cjs`、`.local/ai-copy-feedback-check.cjs`（复用 `.local/ai-reading-check.html`）；对应 `.local/ai-stream-idle-electron.stdout.log`、`.local/ai-copy-feedback-electron.stdout.log` 与 `artifacts/ai-stream-idle-2026-10-14/result.json`、`artifacts/ai-copy-feedback-2026-10-14/result.json`；深浅主题 × 1280/391px，20855 字符本地正文，12 次原生光标移动导致的 DOM 修改由基线 36 次降至各场景 0 次，正文节点/末尾光标保持，阅读偏移 0px；新输出、选区释放和定稿正常，连续复制提示按最新成功恢复且焦点保持；隐藏 offscreen，模拟剪贴板，不调用模型 |
| 消息操作焦点 / 时间线 / 阅读跟随 / 定稿 / 架构定向检查 | 2026-10-14 | 248/248，exit 0 | `node --test tests/app-shell/view-timeline.test.mjs tests/app-shell/agent-surface.test.mjs tests/app-shell/agent-stream-finalize.test.mjs tests/architecture/dependency-rules.test.mjs`；`.local/ai-actions-targeted-tests.log`；新增一个行为用例在旧实现下失败（`.local/ai-actions-before-tests.log`），覆盖复制/分支的在途防重入、成功/失败恢复与聊天切换后的旧响应；不包含 UI、desktop、后端或 CLI 全量 |
| Electron 消息操作焦点定向检查 | 2026-10-14 | 16 操作场景 + 4 Tab 场景 + 流式复制通过，exit 0，renderer errors 0 | `.local/ai-actions-focus-check.cjs`（复用 `.local/ai-reading-check.html`）、`.local/ai-actions-focus-electron.stdout.log`、`artifacts/ai-actions-focus-2026-10-14/result.json`；深浅主题 × 1280/391px × 复制/分支 × 成功/失败，原生 Enter（含字符事件）激活，Tab 可前进且旧操作完成不抢回焦点；焦点保留，阅读偏移 ≤1px，失败可重试，流式生成继续、分支仍禁用；旧实现真实 DOM 确认焦点丢失（同目录 `baseline.json`），模拟剪贴板及分支请求，不调用真实模型 |
| 桌面生成阅读交互收口，全部 app-shell / architecture | 2026-10-14 | 708/708，exit 0 | `node --test tests/app-shell/*.test.mjs tests/architecture/*.test.mjs`；`.local/ai-maturity-ui-tests.log`；前置六文件定向检查 290/290（`.local/ai-maturity-targeted.log`）；首字前阶段、选区恢复与焦点检查在改动前失败，修复后通过，覆盖此前两项改动；不包含 desktop、CLI 或后端全量 |
| Electron 生成阅读交互动态检查 | 2026-10-14 | 12 阅读场景 + 8 流程组合通过，exit 0，renderer errors 0 | `.local/ai-maturity-check.cjs`（复用 `.local/ai-reading-check.html`）、`.local/ai-maturity-electron.stdout.log`、`artifacts/ai-maturity-2026-10-14/result.json`；12 场景复核跟随/提示，8 组合为深浅主题 × 1280/391px × 减少动态开/关，均覆盖等待→思考→正文→停止、持续输出保留选区、流式/已定稿选区补齐、焦点恢复与原生 PageUp/PageDown；隐藏 offscreen、本机权限、本地确定性文本 |
| 桌面上翻期间生成提示 / 阅读跟随 / 时间线 / 定稿 / 架构定向测试 | 2026-10-14 | 246/246，exit 0 | `node --test tests/app-shell/agent-surface.test.mjs tests/app-shell/view-timeline.test.mjs tests/app-shell/agent-stream-finalize.test.mjs tests/architecture/dependency-rules.test.mjs`；`.local/ai-generating-cue-tests.log`；生成提示用例在旧显示逻辑下失败，加入显示逻辑后通过，覆盖定稿、停止、失败及回到最新；含上一项滚动回归，不代表全量 |
| Electron 生成提示真实 DOM 定向检查 | 2026-10-14 | 12 场景通过，exit 0，renderer errors 0 | `.local/ai-generating-cue-check.cjs`（复用 `.local/ai-reading-check.html`）、`.local/ai-generating-cue-electron.stdout.log`、`artifacts/ai-generating-cue-2026-10-14/result.json`；深浅主题 × 1280/391px 窗口 × 上翻 2/20/48px；提示完整可见，按钮高度保持 29px，追加及定稿时阅读偏移均为 0px，点击恢复跟随；隐藏 offscreen 窗口、正常本机权限、本地确定性文本 |
| 桌面生成结果阅读跟随 / 时间线 / 定稿 / 架构定向测试 | 2026-10-14 | 245/245，exit 0 | `node --test tests/app-shell/agent-surface.test.mjs tests/app-shell/view-timeline.test.mjs tests/app-shell/agent-stream-finalize.test.mjs tests/architecture/dependency-rules.test.mjs`；`.local/ai-reading-tests.log`；新增轻微上翻回归用例在旧容差下失败，修复后通过，涵盖追加、定稿、快照回放及恢复跟随；不代表全量 |
| Electron 阅读跟随真实 DOM 定向检查 | 2026-10-14 | 6 场景通过，exit 0，renderer errors 0 | `.local/ai-reading-check.cjs` / `.html`、`.local/ai-reading-electron.stdout.log`、`artifacts/ai-reading-2026-10-14/result.json`；深浅主题分别上翻 2/20/48px，追加及定稿时 scrollTop 变化均为 0px，点击最新后继续跟随；offscreen 隐藏窗口持续绘制、正常本机权限、本地确定性文本，不调用真实模型 |
| 桌面组件圆角 / 表面，UI / desktop / architecture | 2026-10-12 | 711/711，exit 0 | `node --test tests/app-shell/*.test.mjs tests/desktop/*.test.mjs tests/architecture/*.test.mjs`；`.local/apple-design-ui-tests.log`；包含当前圆角契约与既有布局、交互、主题检查，不等于全量 |
| Electron 圆角 / 表面界面验收 | 2026-10-12 | exit 0，renderer errors 0 | `.local/apple-design-review.cjs`、`.local/apple-design-after.stdout.log`、`artifacts/apple-design-2026-10-12/after/layout.json`；隐藏窗口持续绘制，1440/1280/1024/768/391px 无横向溢出、发送可命中；菜单可点击、浅色阴影实际生效、三项显示偏好生效；设置页 768/391px 滚动区无横向溢出、关闭可命中 |
| 桌面全量 `npm test`，v0.5.4 构建前 | 2026-10-12 | 2089/2089，exit 0 | `.local/release-full-tests.log`；包含生成阶段、文稿定稿、分支继承/重启/失败清理、普通文件夹配置和本轮圆角/表面契约，运行在正常权限下；不包含 CLI |
| v0.5.4 Windows x64 安装器 / 打包后启动 | 2026-10-12 | 构建、产物检查及启动冒烟 exit 0 | `npm run package:installer`、`npm run verify:installer`、`npm run verify:packaged-dir`；`.local/release-build-installer.log`、`.local/release-packaged-smoke.log`；`.local/release-artifact-check.json` 确认包内版本及 25 个改动源码与工作区逐字节一致 |
| Electron AI 内容界面验收，UI 缺陷修复后 | 2026-10-12 | exit 0，renderer errors 0 | `.local/ui-bug-repro.cjs`、`.local/ui-bug-repro.stdout.log`、`artifacts/ui-bug-fixes-2026-10-12/result.json` / `probe.json`；实际 CSS 视口 1440/1280/768/391px；模型/权限状态正确，深浅颜色、长模型名发送、复制/分支、选区与原地定稿复核；滚动区贴右、输入框左右 14–24px |
| 桌面 UI 缺陷 / 配置 / HTTP / 架构定向测试 | 2026-10-12 | 331/331，exit 0 | `.local/ui-bug-fixes-tests.log`；包含首次快照保留选项、普通文件夹配置显示/保存/读回、既有 UI 字体和布局；本次发布全量前执行，上述全量已包含这些改动 |
| 桌面点击验收，组件圆角 / 表面优化后 | 2026-10-12 | 20 项通过，exit 0 | `scripts/verify-app-clickability.cjs`；`.local/apple-design-clickability.stdout.log` / `.stderr.log`；包含长模型名的窄窗发送与权限菜单、浅色输入台与设置浮层阴影有效；隐藏窗口持续绘制，不修改用户作品 |
| 桌面最新布局 / 字体 / 架构定向测试 | 2026-10-12 | 256/256，exit 0 | `node --test tests/app-shell/ui-layout.test.mjs tests/app-shell/agent-surface.test.mjs tests/app-shell/text-style-contract.test.mjs tests/app-shell/codex-visual-contract.test.mjs tests/architecture/dependency-rules.test.mjs`；`.local/ai-content-layout-tests.log`；本次发布全量前调整全宽布局并复核，上述全量已包含这些改动 |
| 桌面 UI / desktop / architecture 定向测试 | 2026-10-08 | 707/707，exit 0 | `.local/ui-tests-final.log`；不等于全量通过，未重新打包 |
| CLI 全量，Node v25.2.1 | 2026-10-08 | 1049/1049，exit 0 | `.local/cli-full-after-fix-2026-10-08.log`；先在干净环境（不设 `NO_COLOR`）复跑到 1046/1049，3 项失败全部是验收驱动器退出时的 libuv 句柄断言（0xC0000409），当日修复 `run-cli-once.mjs` 退出时序后全量全绿 |
| CLI 记忆 / 压缩 / 模型定向测试 | 2026-10-08 | 228/228，exit 0 | `.local/cli-memory-final.log`；真实本地 HTTP/SSE 验收另 1/1（`.local/cli-memory-http.log`），模型为确定性夹具 |
| CLI 输入历史 / 输入框 / 菜单，推送前复核 | 2026-10-08 | 70/79，9 项失败 | `node --test tests/storage/input-history.test.mjs tests/terminal/input.test.mjs tests/terminal/menu.test.mjs`，Node v25.2.1；`.local/document-review/push-terminal-tests.log`。**同日复核：原命令重跑 79/79 全通过，该 9 项失败不复现**（同 Node v25.2.1、干净环境），疑与当日执行环境的终端/环境变量差异相关；该行保留当日原始记录 |

补充口径（记录于：2026-10-08｜依据：当日全量日志与探针实测）：CLI 全量验收须在**未设 `NO_COLOR`** 的环境跑——子进程虽显式声明 `NO_COLOR=1`，验收用例自身要断言上色行为，执行环境带这个变量时会压掉颜色用例（当日第一轮 4 项失败即此来源，已实测坐实）。

## 已确认待办

记录于：2026-10-08｜状态：当前有效｜依据：本会话临时目录探针、上述日志及当前规则。只列已确认的未完成事项；旧欠账未复核的部分留在历史表，不推定仍有缺陷。

| 事项 | 当前证据 | 下一步 |
|---|---|---|
| 桌面章节版本清单损坏与孤儿版本恢复 | **2026-10-08 探针实测（本轮）**：坏清单 `listChapterVersions` 抛 SyntaxError——版本时间线接口 500、章节目录加载降级；清单记到 v1 而磁盘有 v1/v2 时，新快照分配 v2 **覆盖孤儿**（探针脚本 `.local/version-probe/probe.mjs`）。全分支史核过：`versions.mjs` 仅 3 个提交，均未触碰此二场景。当前 `versions.mjs:25` 仍 `readJson` 裸抛、`:33` 仍按清单分配版本号。**仍未修复** | 修复后核验孤儿版保留与坏清单降级；不等同于当前正文丢失 |
| 桌面日志尾行修复与边界缺口恢复复核 | `truncateTrailingPartial` 仍只扫描末尾 64KiB；缺口重建目前只覆盖健康段之间的断层，首/尾隔离段仍依赖清单。本轮已核对源码，未重跑故障探针 | 分别复核历史报告 #6 和 21-3 的边界场景；不能用 UTF-8 解码修复或中间断层重建来关闭它们 |
| 当前版本真实模型长篇验证 | 2026-10-08 两轮工作均未调用付费模型；较早真实连写记录不能替代当前验证 | 验证连写、修订、重启、压缩后的事实与伏笔保留，并记录作者干预 |
| 图标与图形单一来源（统一书 §7.10） | **2026-10-30 已实施**：图标几何全部收进 `src/app-shell/icons.js`（26 个字形，24 网格、按尺寸换算笔画 1.9/1.7/1.5/1.2）；`index.html` 的 14 处内联 SVG 改为 `data-icon` 占位，启动时 `hydrateIcons()` 注入；任务三态、计划 chip 图标与搜索地球从 `components/task-icons.mjs`、`plan-panel.js`、`work-group.mjs` 迁入同一表；4 处 `border+rotate` 拼的折叠箭头改为 `--caret-down` SVG mask。项目内无位图图标，`vendor-logos.js` 保持填充路径 | 后续新增图标只改 `icons.js`；禁止在视图文件写第二份 `<svg>` |
| 桌面视觉语言改版（统一书 §7 暖灰 4/3/1/1） | **2026-10-30 已实施并收口**：token 换暖灰、4 档文字/3 档填充/单一线/单浮层阴影、8/12/16 圆角、760px 内容列；输入台拆成「44px 单行外壳（输入框 + 发送键）+ 框下 32px 状态行（模型/权限/思考强度 + 上下文环）」，`autoGrow` 上限 180px；用户气泡去边框去阴影；侧栏 280→252、选中态改填充；顶栏 48→36 透明无底线；工作组一组一卡；空状态/创建弹窗删解释性文案；`window-colors.cjs` 同步暖灰，原生标题栏不再断层。实测：输入台 1112×136 → 760×94、发送键 34→28。验证（2026-10-30）：app-shell+architecture 712、其余非桌面 1344、acceptance 29、desktop 6，合计 2091 全绿；`verify:app-clickability` exit 0；截图 5 宽度 × 明暗 renderer errors 0。**按项目实际未做**：工具组卡头换计数摘要（会丢状态契约）、侧栏搜索收图标与底部收菜单（需新增弹层）、计划 chip 迁移（挂载点耦合）、侧栏时间分组（会丢项目层级）——理由见 `artifacts/ui-style-review-2026-10-30/ui-style-review.md` §10 | 后续若要「状态 + 摘要」并存，先定文案格式再动 `work-items.mjs` |
| 样式量化目标 | 当前仅有体积追踪值，目标阈值尚未决定 | 测量后再决定；不擅自补造阈值 |

记录于：2026-10-12｜状态：当前有效｜依据：Node 遍历根 `src/`，按 LF 归一统计 `.js/.mjs`（`split("\n").length` 含末尾空行，UTF-8 字节）。逻辑源码 126 文件，0 越线；近字节红线文件：`model-settings-page.js` 51048B、`app.js` 50360B、`journal-handlers.mjs` 50150B。样式现状：`styles.css` 2682 行 / 88656B，`agent.css` 2148 行 / 53078B。清除过期过程注释、合并重复声明并复用原样式，未新增依赖或源码模块。

## 最近变更

### v0.5.5 源码与本地桌面包更新（记录于：2026-10-14｜状态：当前有效｜依据：2096 项桌面全量检查、构建与包内源码核验）

- 桌面版与锁文件同步升级至 0.5.5，包含本次会话的生成阅读优化；双语 README 改用已发布 Windows x64 安装包的通用下载指引，避免将本地构建版本误写为已上传的 Release 附件。依赖与 CLI 未改动。
- 更新工作区可运行程序 `dist-desktop/win-unpacked/WWriting Novel Agent.exe`，文件元数据 FileVersion=0.5.5 / ProductVersion=0.5.5.0；构建安装器 `dist-desktop/WWriting Novel Agent-0.5.5-Setup.exe`，101972427 字节，SHA-256 `d3128b23ed44c02218a958c1da62654c708377d7bde4eda5fea4d2276228ee68`，Authenticode 状态 NotSigned。四个本轮改动源码在 `app.asar` 内与工作区原文逐字节一致；已验证打包程序启动，未在本机运行安装器。
- 推送前扫描范围为待提交文件与最近 200 条历史，日志保存在忽略的 `.local/reading-update-*-scan.json`；临时脚本、截图、日志、缓存与安装器继续忽略。验证范围见顶部，不代表 CLI 或真实在线模型长篇的新一轮验收；本轮只推送源码，本地构建产物不上传 GitHub Release。

### 聊天切换跟随状态（记录于：2026-10-14｜状态：当前有效｜依据：251 项定向检查与 Electron 16 场景）

- 修复旧聊天上翻后，暂停跟读及“回到最新”按钮泄漏到另一条聊天的问题。共用 `view.reset` 默认恢复跟读并隐藏旧按钮；`index.applySnapshot` 的视图重建显式保留阅读状态，继续保障快照回放不打断阅读。内部重置参数用于区分两种已存在的入口，无新增产品配置、持久状态、模块、依赖或样式。
- 本轮生产源码净增 4 行，`view.js` 为 505 行 / 23742B、`index.js` 为 779 行 / 40148B（Node 按 LF 归一统计，含末尾空行）；新增一个行为用例覆盖四个切换路径，既有重建保持阅读用例也通过。真实页面按正文锚点检查回放，不把补入历史后的 scrollTop 合理变化当作阅读跳动。
- 验证范围见顶部，过程产物继续忽略；未重跑 UI、desktop、后端或 CLI 全量，未调用真实模型，未重新打包安装版。

### 静止正文与连续复制反馈（记录于：2026-10-14｜状态：当前有效｜依据：286 项定向检查与 Electron 4+4 场景）

- 移动输入框光标会触发文档 `selectionchange`，旧实现每次都重新解析长回复并重建末尾光标；帧入口复用已有 `renderedStreamText`，正文未变化时只保留原滚动处理。约 2 万字符回复旁的 12 次光标移动在旧实现产生 36 次 DOM 修改，修复后深浅/宽窄四场景均为 0；保留新输出、正文选区补齐、跟随及原地定稿。
- 连续复制时，旧成功计时器会提前撤除新一轮“已复制”提示；每个按钮仅保留最近一次成功的恢复计时器，继续沿用全局集合在重置/销毁时清理。新增两个可证伪的行为用例，均在对应旧逻辑下失败。
- 本轮生产源码净增 5 行，仅修改 `view/timeline.mjs`，当前 665 行 / 29087B（Node 按 LF 归一统计，含末尾空行）；无新模块、依赖、样式或持久状态。过程产物继续忽略；只确认冗余解析与 DOM 更新被消除，不宣称真实模型吞吐、GPU 帧率或全量通过，未重新打包安装版。

### 消息操作焦点优化（记录于：2026-10-14｜状态：当前有效｜依据：248 项定向检查与 Electron 操作/Tab/流式检查）

- 修复键盘复制及分支时，原生 `disabled` 使按钮立刻失焦的问题；共用消息操作只替换三行，使用 `aria-disabled` 和既有点击入口防重入，完成或失败后恢复操作。自然保留焦点与 Tab 顺序，不加焦点恢复逻辑；流式分支锚点门槛、复制原文与旧响应代次守卫继续保留。
- 生产文件 `view/timeline.mjs` 为 660 行 / 28865B（Node 按 LF 归一统计，含末尾空行）；无新增源码模块、依赖、样式或持久状态。一个新增行为用例覆盖复制/分支的三种结果，验证与截图见顶部，过程产物继续忽略。
- 本轮未重复运行 UI 全量、desktop、后端或 CLI 全量，未调用真实模型、真实剪贴板或实际分支接口；屏幕阅读器实际播报未验证，未重新打包安装版。

### 生成阅读交互收口（记录于：2026-10-14｜状态：当前有效｜依据：708 项界面/架构检查与 Electron 12+8 场景）

- 首字前使用“等待模型回复”，收到思考文本后切到“思考中”，公开正文到达后显示“正在生成”；复用 `reasoningLabel` 与已有事件投影，零思考、终态与重试行为继续保留。正文有选区时仍暂缓 DOM 更新；明确回到最新才解除对话内选区、立即补齐内容并恢复跟读，普通渲染与对话外选区保持。
- 对话区可通过 Tab 聚焦并有“聊天记录”可访问名称，使用浏览器原生 PageUp/PageDown；回到最新按钮隐藏后将焦点交回对话且不额外滚动。三处生产文件净增 10 行（Node 按 LF 归一比较本项开始/结束行数，含注释清理），无新模块、依赖、样式或持久状态；更新既有阶段/键盘检查，新增一个可证伪的选区恢复用例。
- 验证范围见顶部，临时脚本、日志、截图继续忽略。已测的等待、生成、阅读、选区、停止与定稿交互可以收口；此结论不代表真实模型长时间输出、网络异常或 GPU 帧率已验证。未重跑 CLI、后端/desktop 全量或真实模型长篇验证，未重新打包安装版。

### 上翻期间生成提示（记录于：2026-10-14｜状态：当前有效｜依据：246 项定向测试与 Electron 12 场景检查）

- 作者上翻时，工作组里的“正在生成”可能在视野外；复用输入台上方的按钮显示“正在生成 · 回到最新”，定稿、停止或失败后恢复原文案。生产源码只增加两行，直接取真实正文流状态并跳过相同文案的 DOM 写入，无新样式、依赖或状态字段。
- 新增一个行为用例覆盖生成提示、终态撤除、按钮复用及点击恢复；Electron 深浅主题与宽窄窗口检查见顶部，截图在 `artifacts/ai-generating-cue-2026-10-14/generating-*.png`。源码与规格已同步；本项未重跑桌面全量、CLI 或真实模型长篇验证，未重新打包安装版。

### 生成结果阅读跟随（记录于：2026-10-14｜状态：当前有效｜依据：245 项定向测试与 Electron 六场景检查）

- 原距底部 48px 内仍会自动跟随，轻微上翻回看会被新内容拉回末尾；`view.js` 仅将容差收紧至 1px，沿用已有跟随状态、阅读锚点和“回到最新”按钮。生成、定稿、回放保持阅读位置，滚到底或点击按钮恢复跟读；新增一个行为回归用例并调整既有底部边界夹具。
- 本轮验证见顶部。CodeGraph 对时间线的索引已过期，定位后直接读取当前源码；Electron 隔离权限下在加载前退出，改用正常本机权限及既有 offscreen 持续绘制方式完成检查。生产源码只改一行，无样式、依赖或模块增量；未重跑桌面全量、CLI 或真实模型长篇验证，未重新打包安装版。

### v0.5.4 安装器构建与发布前验证（记录于：2026-10-12｜状态：当前有效｜依据：版本清单、全量测试与打包产物）

- 桌面版本升级至 0.5.4，修正锁文件旧版本未同步的问题，更新双语 README 下载名和 CHANGELOG；依赖版本未变。安装器包含 AI 内容生成、思考与成果反馈、复制/聊天分支、普通文件夹配置修复、全宽输入台与本轮圆角/表面优化。
- 全量测试与打包后启动见顶部。Windows x64 产物 `dist-desktop/WWriting Novel Agent-0.5.4-Setup.exe`，101972156 字节，SHA-256 `680ed9ca633201a2faf6f7c5fdc77fe5d2bd8c5a13c92e4e67e2caef9b724693`；打包程序元数据 FileVersion=0.5.4，包内版本正确，25 个改动源码逐字节匹配。安装器为 NotSigned；本轮验证打包程序启动，没有在本机执行安装流程。
- 发布前扫描当前待推送文件与最近 200 条历史：密钥类命中为测试夹具；进程产物、截图与构建文件继续忽略。本轮新增内容未检出实际密钥或个人资料；既有公开 CLI 规格中的本机路径经与 origin/main 比对确认未改动，不扩展本轮范围去删除文件或重写历史。扫描原始结果仅保存在忽略的 `.local/release-*-scan.json`。
- CLI 本轮未改动/未重跑，独立全量仍以顶部 2026-10-08 记录为准；此前本地提交的验收驱动器退出修复随 main 一并推送。本次安装包与桌面全量不代表 CLI 新一轮验证或真实在线模型长篇验收。

### 组件圆角与表面优化（记录于：2026-10-12｜状态：当前有效｜依据：711 项定向测试、20 项点击验收及 Electron 实际绘制）

- 圆角复用现有三档 token：小控件 10px、卡片/用户气泡 14px、大表面 20px；输入台、首页入口、设置、新建、阅读与快捷键浮层保持层级一致。嵌套模型列表使用外层 20px / 行卡 14px / 控件 10px，窄窗全屏设置继续直角贴边。主入口与当前聊天用轻表面突出，其余次级入口保持克制。
- 调整中性侧栏与深色表面明度、分层阴影、输入台留白与焦点反馈；菜单使用高不透明度材料和局部模糊，模态遮罩轻柔模糊背景。正文仍无框、AI 阅读列和上一轮全宽输入台 / 右缘滚动区保持，未增加依赖、配置或业务逻辑。
- 修复浅色共用阴影变量语法：逗号分隔的 `--ink-shadow` 与 `rgb(... / alpha)` 不兼容，导致浏览器计算 `box-shadow: none`；改用匹配的 `rgba(...)`。当前输入台、用户消息和菜单均实际绘制阴影，仓库点击验收增加输入台 / 设置浮层检查，防止只有源码声明而没有渲染效果。
- 验证及范围见顶部。截图在 `artifacts/apple-design-2026-10-12/before/` 与 `after/`，复核首页、设置、新建、对话、菜单、抽屉和窄窗；减少透明度关闭模糊，高对比使用实色/明确边界，减少动态停止入场动画。样式合计较本轮开始减少 1268B（LF 归一），删除重复发送按钮声明和过期过程注释。CodeGraph 查询未给出有效 CSS 定位，回退直接检索两份样式表。
- 未重新跑桌面全量、未重新打包安装版，CLI 未改动/未重跑；软件渲染夹具不代表真实 GPU 性能，本轮未作帧率结论。

### 截图复核后的桌面 UI 缺陷修复（记录于：2026-10-12｜状态：当前有效｜依据：失败复现、331 项测试、20 项点击验收与持续绘制截图）

- 修复首个聊天快照清掉已加载选项：重建视图后恢复模型、权限和思考强度。回归用例先失败后通过。
- 修复普通文件夹有模型却显示未配置：dashboard 在普通文件夹分支复用运行时配置解析，并返回模型档案。修复普通文件夹保存思考强度走旧 `project.yaml` 导致 400；改为私有设置白名单持久保存，随后保存权限仍保留模型/思考强度，HTTP 用例从失败转通过，文件夹未创建 `project.yaml`。
- 修复长模型名在窄窗挤出发送按钮：391px 实测工具栏宽 420px、发送按钮 x=391px 不可命中；工具栏取消最小内容宽度，窄窗优先省略模型名并保留权限/思考标签。删除重复阅读宽度声明抵消样式增量；仓库点击验收加入长名称场景。
- 更正旧截图证据：`artifacts/ai-content-2026-10-12/` 的主题切换截图混入隐藏窗口停帧时的旧背景，不能作为主题视觉通过的证据；旧验收也未断言完成后的配置状态。此次使用隐藏窗口的 offscreen 持续绘制，浅色“回到最新”对比度 15.57:1，深色按钮/侧栏均 ≥4.5:1。首句没有删除线标记/样式，平台字体查询为 Microsoft YaHei UI，未改字体。
- 最新结果见上表；选区、原段落/文本节点、原地定稿、文稿排版、实际文件写入、原生复制、分支导航和减少动态再次通过，阅读偏移 0px，分支未调用模型。截图改用 `artifacts/ui-bug-fixes-2026-10-12/complete-light-1440.png` / `complete-dark-390.png`。未重新打包安装版、未调用真实在线模型，CLI 未改动/未重跑；不宣称桌面所有页面已无 UI 缺陷。

### AI 生成内容、思考态与回复快捷操作（记录于：2026-10-12｜状态：当前有效｜依据：当前源码、全量日志与 Electron 验收）

- 正文按帧更新变化节点，选择中的正文暂缓 DOM 更新，解除后显示最新内容；原地定稿保留消息、段落和文本节点，流式消息不重播入场。工具轮次的公开正文也会定稿并进入模型历史，后续模型轮次不再清除它。
- `稿`/`prose` 在流式和完成态共用衬线结构，闭合后仅显示字数；AI 说明使用无衬线排版。显式文稿不会被后续保存说明误标为淡化叙述。
- 思考摘要停留 1800ms，160ms 透明度淡入，删除位移与强制 reflow；真实正文到达即切到 `正在生成`。上翻阅读时以 AI 正文维护锚点，完成不强制收起工作组，思考预览转为静态。真实写入/草稿/提交/入账成功单独显示成果行，提交/入账有章号时可打开阅读器。
- 回复增加 `复制内容` 与 `分支到新聊天` 快捷图标。分支以 seq + event_id 校验源回复，只继承此前可见 user/assistant 消息，并保存脱敏模型上下文；不复制工具、授权或思考。原聊天保持，作品文件共享；创建不调用模型，支持再分支、重启、失效锚点/日志缺口拒绝和失败清理。
- 删除对话滚动区和输入台的 1040px 外框限制，滚动条贴聊天画布右缘，输入外框左右仅留主题边距；“回到最新”一起靠右。消息/状态仍封顶 1040px，AI 正文最多 720px；移除窄窗重复的全宽声明。此次样式继续净减。
- 验证：桌面全量见上表；Electron 用本地模型夹具和临时工作区，经真实 API/SSE 检查选区保留、先前段落/文本节点保留、原地定稿、排版一致、真实文件落盘、中文原生复制（模拟页面焦点，验证后恢复剪贴板）、分支导航、深浅主题、四个视口与减少动态。完成后阅读锚点偏移 0.2px，模型调用仅原任务 2 次、分支 0 次。滚动区右缘间距 0px，输入框左右分别 24/24/16.9/14px，正文宽度不超过 720px。截图与结果在 `artifacts/ai-content-2026-10-12/`，宽屏布局为 `complete-light-1440.png`，快捷图标近景为 `reply-actions-light.png`。
- 环境边界：首次隔离执行中 GPU 子进程退出 `0xC0000135`，Electron 原生异常 `0x80000003`；同一隔离夹具在正常权限下启动并完成验收。隔离全量的 4 项进程树终止失败在正常权限下通过。临时诊断代码已从验收脚本移除；未修改产品 GPU 启动策略、未重新打包安装版、未调用真实模型或验证 GPU 帧率，CLI 本轮未改动/未重跑。

### CLI 全量转绿与状态复核（记录于：2026-10-08｜状态：当前有效｜依据：当日全量日志、驱动器探针与源码核对）

- **旧记录已失效**：上文「CLI 长篇上下文」条目内的 1034/1036 与 13 项失败是当时快照；同日复核后 CLI 全量为 **1049/1049**（干净环境、修驱动器退出时序后，`WWriting cli` 目录执行，日志 `.local/cli-full-after-fix-2026-10-08.log`）。
- **修复一项既有抖动**：验收驱动器 `tests/acceptance/helpers/run-cli-once.mjs` 写完结果行直落 `process.exit()`，与流/套接字句柄收尾竞态，Windows 上偶发 libuv 断言（0xC0000409）。探针复现 6/20，修后 20+40 连跑全 0；整装 `main-path.test.mjs` 5 连跑全绿。修复记录已回填 `WWriting cli/docs/repair/2026-09-29-缺陷猎捕修复记录.md`（该项此前登记为「未修，只记录」）。**该改动尚未提交。**
- **两项排除**：斜杠菜单验收的「飘」不成立（10 连跑 + 当日全量均稳过；上文 Node v24 日志里那次 8.4 秒失败是「草稿清空」等待超时，未再复现）；上文「推送前复核」行原命令重跑 79/79 全通过（9 项失败不复现）。另：`NO_COLOR=1` 执行环境会压掉颜色用例——全量验收须在未设该变量的环境跑。
- 逐项证据与待办更新见上两节；本次未动桌面端与统一行为规格书。

### 文档与项目记忆整理（记录于：2026-10-08｜状态：当前有效｜依据：本轮文档差异与内容复核）

- 增加当前状态和验证范围入口；旧基线与欠账分区转为历史，已关闭项注明后续证据，未知项不假称已修或仍有问题。
- 两端 README 修正固定历史预算、依赖、测试范围和数据传输说明；测试数量集中在本文件，领域词汇与维护规则分别留在各自入口。
- 本轮只修改文档，不重跑运行时测试。18 份相关文档的 110 个本地文件链接/标题锚点检查通过（Node 脚本扫描，结果 `.local/document-review/link-check.json`）；`git diff --check` 通过。包版本/依赖来自两端清单，已有测试结果核对对应日志；历史记录未改当时数字。模型配置旧偏好迁入本地 `AGENTS.md` 并保留待复核来源，`CLAUDE.md` 原文备份在 `.local/document-review/CLAUDE.before.md`。

### CLI 长篇上下文与自动压缩（记录于 2026-10-08｜状态：当前有效｜依据：本轮实现、本地行为测试和 HTTP/SSE 验收）

- 删除生产入口固定 24000 字符历史裁剪与 8000 字符项目记忆裁剪；完整装入尚未被摘要覆盖的可见历史，默认屏幕重演也完整保留。原始日志不删、私有 reasoning 不回流。
- 复用既有模型窗口/输出上限表，按可用输入窗口估算容量，计入系统、技能、记忆、当前指令与工具。接近窗口时自动收敛较早轮次，尽量保留近期完整原文；工具轮内也检查窗口，保留当前指令和最新完整工具交换。不新增依赖或配置。
- 删除摘要 6000 字符硬截断；超长历史按窗口分批吸收，空摘要、输出被截断、请求失败或停止时均不发布摘要。自动摘要复用 `digest_compacted` 事件和既有覆盖边界，重启继续使用；手动 `/compact` 保留。
- 最终相关验证：`node --test tests/agent/history.test.mjs tests/agent/compact.test.mjs tests/agent/run-controller.test.mjs tests/agent/agent-loop.test.mjs tests/agent/project-memory.test.mjs tests/agent/replay.test.mjs tests/model/model-limits.test.mjs tests/model/deepseek-client.test.mjs` **228/228，exit 0**（CLI 目录执行，Node v25.2.1，日志 `.local/cli-memory-final.log`）；`node --test --test-name-pattern="超过旧历史预算" tests/acceptance/main-path.test.mjs` **1/1，exit 0**（真实本地 HTTP/SSE，日志 `.local/cli-memory-http.log`）。覆盖长历史、模型窗口切换、摘要跨请求分批、近期全文、重启摘要、压缩失败/停止、长项目记忆和工具交换完整性。
- **⚠ 该行已过时（2026-10-08 晚复核）**：CLI 全量现为 **1049/1049**；下方 1034/1036 与 13 项失败为当日较早快照，作历史保留——全量检查：CLI `npm test` 在 Node v25.2.1 为 **1034/1049**；其中旧历史截断验收已按新契约修订，颜色失败与执行环境 `NO_COLOR=1` 相关。清除该子进程环境变量后，用 Node v24.19.0 执行 `--test tests/**/*.test.mjs` 为 **1036/1049，13 项失败**（日志 `.local/cli-memory-node24.log`）：9 项终端输入、1 项斜杠菜单验收、3 项 Windows 子进程退出（libuv 断言）。这些路径未在本轮修改，未宣称全仓全绿；本轮最终定向测试通过后未再跑全量。
- 9 个改动源码文件通过 `node --check` 与 LF 归一体积检查（≤1200 行、≤51200B），`git diff --check` 通过。现行契约写入统一行为规格书 §34，原固定预算/仅手动压缩/回放预算 ADR 标为历史。
- 验证边界：未调用付费模型，未验证摘要的实际文学信息保留质量。窗口数据沿用既有能力表，第三方端点仍用既有保守回落；字符估算不是精确 token 计数。单份项目记忆、当前输入或最新工具交换本身超窗时明确失败，不静默截断。

### 桌面 UI 优化（记录于 2026-10-08｜状态：当前有效｜依据：本轮源码、相关测试与 Electron 实机截图）

- 视觉：细化中性侧栏、品牌标记、首页展示字阶、入口卡片、设置导航和浮层阴影；原生标题栏颜色对齐深浅主题。沿用现有字体、图标与 CSS，不新增依赖。
- 动效：首页分层短暂入场、菜单/按钮反馈；复用 motion-runtime 处理浮层反向，取消旧回调、忽略子元素过渡事件。删除整页入场、重复浮层声明和常驻 will-change；减少动态时发送图标停止旋转。
- 可见缺陷：修复宽屏多余“更多”按钮、抽屉立即消失及窄窗残影、重复窗口控制留白、零尺寸 SVG 占行导致底部裁切、窄窗发送换行及菜单越界/裁切。
- 验证：`node --test tests/app-shell/*.test.mjs tests/desktop/*.test.mjs tests/architecture/*.test.mjs` 707/707，exit 0（日志 `.local/ui-tests-final.log`）；`npm run verify:app-clickability` exit 0，新增窄窗发送/权限菜单命中检查（日志 `.local/ui-clickability-final.log`）。本轮未重跑全仓 `npm test`，未重新打包安装包。
- 视觉证据：`.local/ui-review.cjs` 使用隔离临时工作区及确定性模型夹具，经实际应用 API/SSE 渲染首页、设置、新建、对话、菜单和抽屉；截图在 `artifacts/ui-polish-2026-10-08/after/`。普通动效下抽屉快速重开通过；五档实际 CSS 视口宽 1442/1282/1026/770/392px 无横向溢出，发送按钮在视口内且中心可命中；渲染器错误为 0。真实在线模型与 GPU 性能不在本轮验证范围。
- 样式净量：`styles.css` 2690 行 / 89606B，`agent.css` 2193 行 / 58397B；口径为 LF 归一后的 `split("\n").length`（含末尾空行）与 `Buffer.byteLength`。相较本轮开工实测合计减少 488B；历史登记值保留原日期与口径。

## 历史记录

以下保留当时的数字、决策与原始欠账，供追溯使用；表里的“未修”“未启动”等仅表示当时状态，后续关闭说明见对应行。继续工作先看顶部，不从这里直接领取任务。

### 历史基线（记录于 2026-09-24｜状态：历史记录｜依据：`npm test` 与 `wc -l`/`wc -c` 实跑，HEAD `e708b36`）

- 测试数：1992/1992（依据：`npm test` 实跑，exit 0，321s；前值 1986/1986 记录于 2026-09-05）→ **滚动更新：2081/2081**（记录于 2026-10-03｜依据：`npm test` 实跑 exit 0，127.9s，`.local/logic-review/full-test-final.log`；中间值 2016/2016 见 round22、2039/2039 见 round23）
- 逻辑源码红线现状：全库 126 个 `.js/.mjs` **0 越线**（口径：≤1200 行且 ≤51200 字节，字节按 LF 归一）；行维度由架构测试 R1 机器强制，**字节维度自本轮起同样机器强制**（`tests/architecture/dependency-rules.test.mjs`）
- 逼近红线的文件（LF 归一字节 / 余量）：`src/app-shell/app.js` 48607B / 余 2593B、`src/core/agent/journal.mjs` 47577B / 余 3623B、`src/core/agent/journal-handlers.mjs` 50355B / 余 845B、`src/app-shell/model-settings-page.js` 50859B / 余 341B（依据：`wc -l` + `Buffer.byteLength(text.replace(/\r\n/g,"\n"))`）
- 本轮拆分出的新模块：`src/core/agent/run-control.mjs`（519 行 / 28899B）、`src/core/agent/journal-recovery.mjs`（162 / 8857B）、`src/core/agent/journal-queries.mjs`（123 / 6046B）、`src/app-shell/app-reader-view.js`（116 / 5214B）
- 样式体积现状：`src/app-shell/styles.css` 2724 行 / 89372B、`src/app-shell/agent/agent.css` 2193 行 / 58757B（依据：LF 归一字节（去 CR 后按 UTF-8 计数），记录于 2026-09-28；较 2026-09-24 登记值净增来自 round21/22 与本轮 web_search 来源行预置样式 363B，原「样式自第十七轮以来未再增长」一句已失效）
- 依赖面：`dependencies` 3 个（`marked` / `yaml` / `yauzl`；本轮删除零引用的 `ignore`）
- 本地验收线：`npm run verify:unified-agent` 36/36 场景、exit 0（本轮修好了此前在场景 24 崩溃的遗留缺陷）

### 历史轮次进度（第九至二十轮）

- 第九轮完成（2026-08-15）：记忆体系重构 / 版本时间线与恢复 UI / 任务计划面板 / 断点恢复
- 详见：docs/memory/2026-08-15-round9-decisions.md
- 第十轮 UI 修补已并入主干（2026-08-16）：窄顶栏保留项目标题 / 计划浮层置顶 / 窄窗口设置关闭按钮 / 紧凑内存空态 / 视觉验收脚本加固（7 个提交，经 merge --no-ff 合入 master，1857 测试全绿）
- 第十一轮完成（2026-08-20）：前后端一致性修复（两份 08-18 审计的 A/B/C/M1/M2/D 简化/F + 压缩发现 1），7/7 落地
- 详见：docs/superpowers/reports/2026-08-20-第十一轮一致性修复-acceptance-report.md
- 第十二轮完成（2026-08-21）：过程可见性与过程美化（N1 里程碑叙述 / N2 排版收尾 / N3 美化 / N4 状态真实化 / F1-F16 修复包），全量回归 178/178，收口根治 Node v25 FileHandle GC 文件级失败
- 详见：docs/memory/2026-08-21-process-visibility-audit.md（含修复记录，未修项：无）
- 第十三轮完成（2026-08-22）：模型高级配置与模型信息统一（F1 高级预设项 256k/64k 缺省 / F2 窗口权威字段化 / F3 [1m] 尾标淘汰迁移 / F4 八成压缩阈值 / F5 缺省输出 64k / F6 显示单源「厂商 / 模型名」），全量回归 1921/1921。
- 第十四轮完成（2026-08-22）：技能全插件化与网文风格体系，F1-F9 全部落地，回归 1915/1915。
- 第十五轮完成（2026-08-23）：**内核分区重构——三病灶同治与前端控制面重排**（24 任务 / 28 提交，全部落地，回归 1953/1953）。
  - **波A 后端内核**（Task 1-10）：微工具单源 `agent-utils`（fail/codedError/clock/idFactory/normalizeAt/sleep）、常量单源与死代码清除（COMPACTION_EVENT_TYPES 死副本删除）、journal 投影查询四方法收归（hasTerminalEvent/findInputMeta/isIdleInitiatedRun/findTerminalInputId，调用方不得全量扫事件重推导 F2 口径）、`reduceEvent` 48 case 拆 handler 表 `journal-handlers`（对账断言钉死）、tools 四域注册拆分 `tools/`（fs/shell/chapter/knowledge 四 definitions，registry 派生工具名单）、runtime 四步拆分（history-assembly → run-lifecycle → session-manager → buildCompactionSource 归位 compaction + processInput/processCompact 拆 run-pipeline）。终态 runtime 1142 行（原 3056）、journal 1183（原 1982）、tools/index 1032（原 2123）。
  - **波B 前端控制面**（Task 11-20）：dom-kit 共享层（el/bindAutosave/fieldError/focusTrap/showConfirmLayer/createToaster 单源）、settings-modal 迁 form-kit（D7 范式统一）、toast 单源、state.js 事件 handler 表 + CONNECTION_ERROR_CODES 单源、view 四分区（timeline 546 / work-group 827 / cards 298 / composer 531，view.js 从 2363 瘦到 452）、**gsap 退役换 CSS transition**（vendor/ 5629 行删除，motion-runtime 9 个 API 逐字保持、未 setup 同步早退契约保留）、唯一行为例外 F17（timelineSeqs 泄漏修复）。
  - **波C HTTP 下沉与组装根**（Task 21-22）：switchModelByReference/buildModelProfile 迁 settings-runtime、buildProjectList 迁 project-listing、migrateLegacyProjectOnOpen 迁 project-model-migration、runResearch 迁 research-tools、assertNotArchived 单源；app.js 入口化 `bootApp(root)` + refs 分四桶（rail/drawer/reader/settings）。
  - **波D 守卫与收口**（Task 23-24）：守卫三规则立线——R1 src 文件 ≤1200 行（settings-modal.js 唯一登记例外，其余全库落线）、R2 npm test glob 覆盖全部测试目录、R3 agent 内部模块 seam 禁令；欠账回写（WWRITING/压缩审计发现 2 订正）+ ADR 0006 落档。
  - **验收门禁**：`npm test` 1953/1953（基线 1915 + 38 个薄单测）；UI 三件套（verify:app-clickability / verify:app-shell / verify:desktop-shell）全 0；`sim:user-flow` 21/21（mock 模式）；视觉基线 round-15 vs round-14 逐图像素对比 26/49 完全一致，其余为动效中间帧与动态内容，无稳态回归。
  - **过程记录**：Task 22 首版 refs 分桶有运行时接线缺陷（createSettingsModal/createDrawerPanels 契约是 `ctx.refs` 却裸传分桶对象 → bootApp 崩溃、页面不可用），由 verify:app-clickability 的 motion-ready 超时捕获并回修（292a55e）——**入口化/分桶类改动必须过 clickability，app-shell 单测与静态验证不执行 app.js**；R1 红线红灯时 app.js 以注释/空白净化缩容至 1198（不放宽红线）；验收时发现计划遗漏 `tests/agent/run-lifecycle.test.mjs`（计划文件清单与步骤自相矛盾），已补薄单测（d8a0c10）。
  - **规模**：113 文件 +12,604/-15,340（净 -2,736，含搬迁重计；其中 gsap/vendor 单删 5,629 行）。
  - **详见**：规格与执行记录 `docs/design/2026-08-23-round15-kernel-partition-spec.md`（5 条偏差全部回填）、`docs/adr/0006-agent-kernel-target-model.md`、视觉验收截图 `artifacts/visual-acceptance/2026-08-23-round15/round-01/`。
  - **遗留下轮**：settings-modal 结构拆分（D6/D7 登记的 1347 行例外）；真实 API 模式 sim:user-flow 复跑（需 DEEPSEEK_API_KEY）；新 provider 接入前的窗口口径回归（发现 2 已字段化，仍需实测兜底）。
- 第十六轮完成（2026-08-24）：**长篇记忆接线与清欠收口——连贯性供给工具化与结构债清零**（21 任务 / 18 提交 + 收口回写，全部落地，回归 1974/1974）。
  - **波A 主菜**（T1-T7）：`read_continuity` 工具接回六月断线的「前情小抄」（D1 工具拉取而非系统注入，ADR 0007；无参 = 近 2 章 900 字摘录 + 近 5 章 facts/12 角色/8 时间线 + 未回收伏笔 top 5；entity 参数 = 按实体查全量）；伏笔台账 continuity v3（`foreshadows` open 去重追加 / paid 精确匹配置位，存量无字段默认 `[]` 不迁移）；update_memory schema 扩 foreshadows + memory_checklist 三处文案含伏笔职责；sim 插针「写第 2 章前必查」断言（22/22）；防呆提醒按非目标不做，观察留十七轮。
  - **波B 结构清欠**（执行期 T11-T13）：settings-modal 技能区一刀抽 `settings-modal-skills.js`（404 行，deps 九引用）；app.js 主题/隐私块抽 `theme-privacy.js`（72 行，1197→1130、init 早位 :107，行为不变）；**守卫 R1 例外清零、红线绝对化**——全库扫描 124 文件全部 ≤1200（最大 journal.mjs 1184），逐文件断言无例外清单。
  - **波C 测试/工程清扫**（执行期 T14-T18）：cards.mjs 补零覆盖 5 测试 + SURFACE_SEAM_TESTS 登记；waitForEvents 去墙钟改迭代上限（tools.test.mjs 69/69）；F18 死字段 5 个（runningCount 等）+ waiting_user 相悖分支删除；四文档删除（AICSS/UI 美化两处路径订正 git rm）+ 死链 8 处命中全为历史记录文件有意保留 + CLAUDE.md 刷新 51 行（按用户要求不入库）。
  - **波D whfind-bugs 紧急修复**（T20-T24）：#1 投影查询改 readTail 尾部窗口（修 10 万事件会话卡死）+ 兄弟点 compaction loadEntry；#2 UI 保存密钥即时注入 env（修首次配置必重启，脱敏名单可变容器遗留）；#3 手动 in-run 取消只终结 compact item、队列存活；#4 dashboard 读取前冲刷脏成本（修 cost.json 全程陈旧，错误分层 leaf 诚实抛/wrapper 吞错）；#5 compaction failed 态诚实拒绝 + 文案进可透传白名单。
  - **验收门禁**：`npm test` 1974/1974（基线 1953 + 波A/波C 增量）；UI 三件套全 0（verify:app-clickability 21/21 点击 + 21/21 预期，verify:app-shell / verify:desktop-shell exit 0）；`sim:user-flow` 22/22（mock 模式，T7 场景插针后 21→22）；视觉基线 round-16 vs round-15 无稳态差异（round-01 51 文件）；行数对账 settings-modal.js 994（≤1200）、app.js 1130（≤1150 余量 20）。
  - **过程记录**：提交/守卫注释 T10-T13/T15-T18 为执行期编号，与计划编号差 2-3 位（T8/T9 拆分落为 T11/T12 等），文件头双编号口径保持原样；verify-app-shell 静态契约 SKILL_SOURCE_LABELS 断言未随波B 迁移指向旧文件 → T14.1 修复（改指向 settings-modal-skills.js）；T24 守卫初版纯状态检查被质量审查抓出死路（failed→cancel→submit 永久锁死）→ 收窄为「run 非终态 + failed」才拒（3ee1cd2）；规格 D2 原文「chapter_index 派生」实测订正为「chapter_memory 派生」（chapter-memory.mjs:195-197）。
  - **规模**：79 文件 +1,396/-1,269（净 +127，测试增量为主，不含竞争研究产物）。
  - **详见**：规格与执行记录 `docs/design/2026-08-24-round16-continuity-wiring-spec.md`（8 条预登记偏差全部回填 + 执行期新发现）、`docs/adr/0007-continuity-supply-via-tool-pull.md`、bug 报告 `docs/memory/2026-08-24-bug-hunt-report.md`、视觉基线 `artifacts/visual-acceptance/2026-08-24-round16/round-01/`。
- 第十七轮完成（2026-08-28 至 08-30，2026-09-05 回填）：**UI 一致性收敛 + 去 AI 腔可度量升级**（双线；规格 `docs/design/2026-08-28-round17-spec.md`；规模口径：窗口提交 43 个，其中带 round17 标记 30 个，另含 v0.5.1 发布提交与 2401ba8/dcf4faf 等无标记尾部提交；记录于 2026-09-05｜依据：git log）。
  - **第一部分 UI 一致性收敛**（app-shell）：隐私模式整体删除（入口/状态/peek/data-away 全链路；对齐决议：承诺与实现长期不符，修复价值低于维护成本故废弃）；暗色硬编码色收敛（新增 `--ink-shadow`/`--ink-scrim` 三元组 token 共 9 处替换、亮色 `::selection` 改 accent 派生、`.sw-dot` 恒白刻意保留并注释）；按钮基元 `.btn`/`.btn--primary`/`.btn--sm`（6+ 套平行实现全量改名不留别名，36/28px 两档，agent.css 重复定义合并）；设计 token 归并（字阶严格 7 档零新增、字重 4 档、圆角 token 去重 3 档+胶囊）；死代码清理（topbar-sub 隐藏元素、`.sp-av`、`.sp-item`/`.sp-name`、孤儿 spin keyframes；补创建弹窗 spinner 与 create-status 校验错误可见）；上下文圆环 28→32 单点回退（4eed87d）。
  - **第二部分 去 AI 腔可度量升级**（core/skills）：`style-metrics.mjs` 纯函数模块（修饰词密度/句长 CV/三连排比候选，O(n²) 上限注释与顶层契约冻结四键）；`readWorkspaceTextFile` 共享读取器；`style_stats` 只读工具注册（工具不变量 15→16，注册顺序契约保持；ADR 0008：只读工具、不建程序化门禁）；`avoid-ai-voice` v2.0.0（量化阈值 + style_stats 审校反馈环，质量审查后补 below_floor 维度指令）。
  - **尾部修复**：DeepSeek v4 思考模式钉死 + 思考回传契约 + 零思考轮「未思考」标签（2401ba8）；六维度审查修复（复用/简化/效率/层次/可用，安全零发现，dcf4faf）；runtime.mjs 悬空注释残句删除（2ae01d8）。
  - **配套**：ADR 0008；竞品调研 `docs/research/2026-08-29-competitive-research-ai-voice.md`；输入证据 46 张截图当时入库（5dcde30），2026-09-05 按「过程产物不入库」规则移出 Git（0f9307b），本地保留。
  - **验收门禁**：门禁 1 全量 1982 pass / 0 fail（2026-08-29，round17 规格执行记录）；门禁 4 反馈环 10 样本 10/10 达标（修饰词密度前均值 82.81/千字 → 后 0；CV 0.37 → 0.51；排比候选 2 → 0；逐段数据 `artifacts/now/round17-acceptance/manual-verification.md`）；最终全量以「当前基线」1986/1986 为准（2026-09-05 实跑）。

- 第十八至十九轮（round18/round19）记录补记（2026-09-24，依据：git log）：这两轮以文档与工程治理为主——项目记忆并入 `AGENTS.md` 并删除仓库根 `WWRITING.md`（`8a4cbce`）、README 双语统计基线注（`beeb212`）、R1 口径订正为逻辑源码 + 样式体积追踪线（`1110762`）、六条治理约束入库（`f515966`）、过程产物移出 Git（`0f9307b`）。其**端到端收尾改动（README 双语重写、`.github/` 模板、CONTRIBUTING/SECURITY/LICENSE、`docs/images/` 素材、三处 Windows/满载测试稳定性修复）在 round20 开工前才落盘**，拆为 5 个 commit（`5c899c6`、`d95b5f9`、`2b9e939`、`f83f4c9`、`1711223`），随后才切出 round20 分支。
- 第二十轮完成（2026-09-24，round20）：**审计修复与收敛清理 + 体积红线收口**（27 提交，fast-forward 合入 master `e708b36`；计划与执行账本 `docs/superpowers/plans/2026-09-24-round20-audit-fixes-and-cleanup.md` 与被忽略的 `.superpowers/sdd/2026-09-24-round20-audit-fixes-and-cleanup/progress.md`；依据 `artifacts/audit-2026-09-23-full-stack.md` 修订版）。
  - **阶段一 缺陷修复（Task 1-5）**：C1 `requireSessionId` 拒绝含 `/\`、`..`、NUL 的 sessionId（此前 `DELETE /api/agent/sessions/..%2F..%2F<目标>` 可递归删除任意目录）；C3 记忆版本恢复覆盖前补 `pre_restore` 快照（此前两次快照之间的编辑被不可逆抹掉），并把读取失败收窄为**仅 ENOENT 免存档、其余上抛**（恢复 fail-closed）；C2 本地 HTTP 校验 `Host` 头拒绝 DNS rebinding（403 `HOST_REJECTED`）；C4 `retry`/`retryCompaction` 复用项目串行门（此前会话 A 运行中可对 B 的 failed Run retry，导致「停止 A」实际 abort B）；新增公共 API `agent.projectBusy({projectRoot})` 收窄 rollback/restore 忙门（此前 `snapshot` 缺省只解析最近活跃单会话，漏判非活跃会话）。
  - **阶段二 顺手加固（Task 6-8）**：win32 `ensureProject` Map 键小写归一（消除大小写变体双 state/双锁写同一物理 journal）；`run_log.jsonl` 纳入 `write_file`/`edit_file` 写保护名单（审计账本此前可被 Agent 改写）；删除 `settings-modal.js` 的死 re-export。
  - **阶段三 过度工程清理（Task 9-17）**：测试 adapter 迁出 `src/`（`mock.mjs` 115 行此前会被 `files: src/**/*` 打进发布包）；删除生产零调用模块与死函数/死导出（`chapter-presentation.mjs`、`utils.js` 三函数、`readChapterDraft`/`rethrowIfCancelled`/`COMMIT_STEPS`）；`cost-tracker` 深拷贝改 `structuredClone`；`session-registry` 复用 `agent-utils` 的 `codedError`；`api-client` 三函数抽 `request` 共核（逐键等价，拒绝改变请求形状）；`cost-panel` 的 `el` 收敛为 `dom-kit` 薄适配；删除零引用依赖 `ignore`（依赖 4→3）。
  - **阶段四 红线收口（Task 18-22，执行期追加）**：触发事实——`AGENTS.md` 红线是「≤1200 行**或**约 50KiB」，行维度早有机器强制、**字节维度无任何强制**，导致三个文件基线即越线长期无人发现。收口结果：`runtime.mjs` 1194 行/65060B → **702 行/37523B**（拆出 `run-control.mjs`）；`journal.mjs` 1183/60409B → **925/47577B**（去重两个恢复批次构建器的逐字重复段 + 拆出 `journal-recovery.mjs`/`journal-queries.mjs`）；`app.js` 1111/52580B → **1020/48607B**（等价合并 + 折出 `app-reader-view.js`）。同时**修好长期红的验收线** `npm run verify:unified-agent`（根因是脚本内最小 DOM 桩缺 `insertBefore`/`parentNode`/`nextSibling`/`isConnected`，非生产缺陷；补桩后 36/36 场景绿），并给架构测试 R1 加上 **51200 字节断言（LF 归一口径）** 与前缀式 seam 名单（`journal` 覆盖全部 journal* 模块）。
  - **验收门禁**：`npm test` 1992/1992 pass / 0 fail（合并后复跑）；`npm run verify:unified-agent` 36/36、exit 0；测试数 1996→1992 的 −7 经逐文件 `git grep -c` 核对，全部来自计划内有意删除（Task 10 删 `chapter-presentation.test.mjs` 3 例 + 静态断言 1 例；Task 11 删 3 个 `hashKey` 死代码用例），其余 121 个测试文件计数完全相同，无静默覆盖丢失。
  - **规模**：整分支 49 文件 +1967/−1277（其中阶段一/二按 TDD 要求强制新增失败测试约 400 行，故「净删」口径对 `tests/` 不适用）；仅 `src/` 26 文件 +1182/−1263（净 −81 行）。
  - **过程记录（重要，给后续模型）**：①**计划自带的逐字测试有 2 处是无法失败的断言**——Task 1 的诱饵目录建在 `fs.rm` 真实落点之外、Task 6 的大小写变体在 `C:\` 上恒等于原路径（永远 skip）；②**实现子代理 3 次拒绝照抄计划代码**且理由成立——`api-client` 改写会给 POST/DELETE 新增 `cache` 指令并把「错误字段键恒存在」改成「可缺失」、`app.js` 的 `/[\\/]+$/g` 会放宽路径语义、`session-registry` 的 import 路径是笔误；③**终审抓到修复波自己引入的 Critical 回归**——抽取 `adjacentChapterNo` 后调用点又取了一次 `.chapter_no`，导致阅读器「上一章/下一章」失效，而全仓无测试覆盖该路径（已修 + 补可证伪导航用例）；④**裁决先例确立**：当计划的逐字代码与「测试必须能被证伪／不得为覆盖率加薄测试」冲突时，以全局约束为准，并在实现报告中标注偏离了哪一行、为什么（用户 2026-09-24 确认）。
  - **遗留（本轮未做，已登记）**：见下节新增欠账。

### 历史欠账清单（记录于：2026-09-05｜状态：历史记录｜依据：r16+r17 合并）

状态列保留当时口径；2026-10-08 已核对的关闭项补记在对应行，未补记的项为待复核，不能直接当作当前欠账。


| # | 事项 | 来源 | 状态与去向 |
|---|------|------|-----------|
| 1 | 完读率回放（共用 chapter_memory 底座） | r16 | r17 未认领，悬空；待分级表排优先级 |
| 2 | 防呆提醒（视 sim 冒烟观察决定） | r16 | 观察项；r17 sim mock 22/22 无新触发，保持观察 |
| 3 | 真实 API 模式 sim:user-flow 复跑 | r16 | 阻塞：需 DEEPSEEK_API_KEY |
| 4 | whfind-bugs #6（段尾 64KB 撕裂行） | r16 | 2026-10-08 复核：当前尾行修复仍只扫描末尾 64KiB；这不是 UTF-8 跨块解码问题，不能因 `c181dce` 关闭。影响需按原报告 #6 复现，本轮未跑故障探针 |
| 5 | whfind-bugs #7（run_log UTF-8 块边界） | r16 | 当时未修；2026-10-03 审计尾读按字节定位后解码，见十三组修复记录（`c181dce`） |
| 6 | 脱敏名单次要面（runtime 级可变 secrets 容器） | r16 | 当时未修；2026-10-03 密钥即时脱敏已关闭，见十三组修复记录（`89fd733`） |
| 7 | T22 活体路径与 retry-after-cancel 覆盖 | r16 | 测试覆盖债，归测试治理清单（r19） |
| 8 | session-sidebar.mjs 维护契约注释订正（buildRecoveryHint 语义分歧） | r16 | 候选 r20 顺带 |
| 9 | T11 makeEvent 事件工厂合并 | r16 | 已消解（2026-09-05 grep `src/` 无 makeEvent 定义） |
| 10 | 人类语料基线校准（20-30 段真人 vs AI 盲测反推人类区间，校准两阈值常量） | r17 | 未启动 |
| 11 | P1 事实/来源可验证性自检清单（审校流程） | r17 | 未启动 |
| 12 | P2 第三方检测 API 集成可行性评估（仅局部风险扫描，非门禁） | r17 | 未启动 |
| 13 | UI 指标展示（前提：指标经实机验证有区分度） | r17 | 未启动 |
| 14 | UI 第二批：动效单轨化（motion-runtime.js 与 CSS transition 双轨，motion-runtime 现存）+ 间距 token 化（27 个像素值） | r17 §2.2 | 未启动 |
| 15 | CHANGELOG 与版本号 | r17 | 常设流程项，归属 ship 流程（登记归属，非欠账） |

> 排序原则：优先级不在本清单内定，由产品功能分级表（主路径/恢复能力/验证能力/增强功能，r19 交付）裁决。

### 第二十轮（round20）新增欠账（记录于 2026-09-24｜状态：历史记录｜共 12 项，只记不排）

| # | 事项 | 类型 | 状态与去向 |
|---|------|------|-----------|
| 20-1 | `docs/design/multi-session-architecture.md` §4 与末尾索引仍引用已退役符号（`migrateProjectData` / `legacy-import.mjs` / `journal-session-migration.mjs` / `runLegacyImport`；已核实 `src/` 零命中） | 文档陈旧 | 该文档标「状态：当前有效」，属伪事实；下一轮以「加已退役标注」方式订正（符号已删、迁移语义留历史说明） **后续复核：2026-09-28 已转历史；2026-10-08 又核对并移除统一书中的同类退役入口引用。** |
| 20-2 | R3 seam 扫描器只认字面量 import；`scripts/benchmark-agent-journal.mjs:161/:270` 用计算式动态 import 直连 `journal.mjs`/`journal-segments.mjs`，落在盲区 | 守卫盲区 | 本轮按「不得缩名单绕过」未扩扫描器；扩扫描器会真红（该脚本确为包外直连），需连同 `path.join` 拼接与 `tests/agent/` 豁免口径一并设计 |
| 20-3 | 贴近字节红线的文件：`journal-handlers.mjs` 余 845B、`model-settings-page.js` 余 341B | 体积债 | 下一批字节收口对象（口径：≤51200B，LF 归一；R1 已机器强制，破线即红）。**2026-09-25 订正**：原记 `model-settings-page.js` 余 341B（50859B）属 **CRLF 误测**——该值恰等于 LF 值 49921B 加上该文件行数 938（把 `\r` 计入了）；LF 归一实算为 938 行 / 49921B、余 1279B，**不属紧迫对象** |
| 20-4 | 新增导航用例未在 `finally` 恢复 `globalThis.document`，向同文件后续测试泄漏全局 DOM 桩 | 测试卫生 | 本轮已记为 Minor（658/658 全绿，无实际连带失败）；下一轮按同仓既有 `try/finally` 恢复惯例订正 |
| 20-5 | `pre_restore` 去重口径与章节侧不一致（用「≠即将写入内容」而非比最新 checksum），常见场景会存一份与最新版本字节相同的冗余版，挤占 200 版上限 | 一致性 | 本轮为计划逐字口径，未改；属低频优化，非正确性问题 |
| 20-6 | `project_busy`/`session_busy` 已进 `SAFE_PUBLIC_ERROR_CODES` 白名单，而同样「程序写死、不拼底层异常」的 `agent_running` 未进，导致版本回滚/恢复的 409 对直连客户端只显示通用脱敏文案 | 一致性 | 既有行为，需独立评估后决定是否扩白名单 |
| 20-7 | `run_log.jsonl` 保护面不完整：`isProtectedShellCwd` 未纳入（shell 仍可 `echo >`）、`samePath` 不 `realpath`（符号链接可绕）、非 win32 不折叠大小写 | 安全边界 | **2026-09-25 部分关闭**：复核把「realpath 缺失」的范围扩大为「**以根为基准的全部比较点**都未解析根」（受保护路径 8 条规则 / `safe_edit=false` 内容保护 / shell cwd / 工作区文本读取 / scope 判定），经访谈确认为缺陷、**已由第二十一轮按 ADR 0009 修复并验收（提交 `c38df05`/`83512aa`/`cca9124`）**；余项拆出——shell 写目标承诺 → 21-4，大小写口径与两份 `samePath` → 21-1 **后续复核：2026-10-03 受保护路径真实身份与 shell 标识拦截已落地；非 Windows 大小写余项仍不据此关闭。** |
| 20-8 | `dist-desktop/win-unpacked/…/app.asar` 与 `.codegraph/codegraph.db` 仍含本轮已删符号名 | 构建产物 | 均为 gitignore 的构建/缓存产物，重新打包即消失，无需处理 |
| 20-9 | `docs/superpowers/specs/2026-07-18-composer-draft-design.md` 状态为「待实现」，且把本轮已删除的 `hashKey` 当作可复用现存算法 | 后续踩空点 | 按该规格实施时会踩空（`hashKey` 已随 Task 11 删除）；建议在下一次触及 composer-draft 前先订正规格 |
| 20-10 | `src/app-shell/utils.js` 的 `ensureTrailingSlash` 在 `src/`/`tests/`/`scripts/` 内无导入方 | 死代码候选 | 本轮 Task 11 范围外（其同名函数在 `openai-compatible.mjs` 是本地函数，非同一导出）；归入后续审计项 **后续复核：2026-10-08 rg 核对 utils.js 无 ensureTrailingSlash，候选已消解。** |
| 20-11 | 环境有 14 个 `extraneous` npm 顶层包（`npm uninstall` 残留），`node_modules` 与锁文件不完全一致 | 环境 | 下一轮开工前 `npm ci` 收敛，避免后续验收被误导 |
| 20-12 | `styles.css` / `agent.css` 的**量化目标值仍未定**（`AGENTS.md` 记载「由第二十轮审计轮测定后回填，不得臆造阈值」） | 规则待决 | 本轮只登记现状（2613 行/83213B、2171 行/57756B，与 2026-09-05 相同即未再增长），**未定阈值**；需专项测定后回填 `AGENTS.md` |

> 另：原欠账清单第 8 项（`session-sidebar.mjs` 维护契约注释订正 / `buildRecoveryHint` 语义分歧）在本轮 Task 5 被**部分**订正——该注释已补「rollback/restore 忙门已改为经 `agent.projectBusy` 消费 `hasNonTerminalRun`」口径；`buildRecoveryHint` 的语义分歧本身未验证是否已消解，暂不关闭。

### 第二十一轮（round21）登记项（记录于 2026-09-25｜状态：历史记录）

来源：2026-09-25 只读健壮性抽查复核 + 同日访谈（4 轮 15 问）。本轮范围＝路径身份统一（规格 `docs/design/2026-09-25-round21-path-identity-spec.md`，ADR 0009）；下列为本轮**明确不做**但已定性的余项，只记不排。

**执行结果（记录于：2026-09-25｜状态：历史记录）**：本轮范围（工具层路径身份统一，ADR 0009）**已实现并验收**。实现提交 `c38df05`（根解析与失败闭环）、`83512aa`（目标路径解析异常收口）、`cca9124`（5 处比较点全部切到真实根）；新增 `tests/agent/path-identity.test.mjs`（9 用例，含 5 个 win32-only junction 用例）；未触碰任何 `journal*` 模块；`src/**/*.{js,mjs}` 无新增越线文件。四条门禁本轮实测：`npm test` **2001/2001（exit 0）**、`npm run verify:unified-agent` **36/36（exit 0）**、`npm run verify:desktop-shell` **exit 0**、`npm run verify:app-shell` **exit 1（既有失败，见 21-7，经用户裁定接受并登记）**。下表 21-1…21-8 为本轮明确不做、已定性的余项。

| # | 事项 | 类型 | 状态与去向 |
|---|------|------|-----------|
| 21-1 | 路径比较的大小写口径未定；`samePath` 有两份实现（`runtime-helpers.mjs:78` 私有、`app-state.mjs:120` 导出）；macOS 默认大小写不敏感，`.versions/` 变体仍可绕 | 安全边界 | 产品只发 Windows，现实触发面低；需先定各平台折叠口径再动，避免改比较语义牵动既有断言（20-7 余项） |
| 21-2 | 项目身份层未归一：`validateWorkspaceRoot`（`app-dashboard.mjs:256`）只 `path.resolve`、前端 `normalizeProjectPath`（`app.js:846`）只去尾斜杠、最近项目与选中态比较用不解析的 `samePath` | 可用性 | 同一物理项目经不同路径打开会出现「项目未选中」；修法会改动界面显示的路径，属可见变化，需单独决策。另含 `index.mjs:847` 的项目锁键（`projectLocks.runExclusive(context.projectRoot, …)` 用的是**未解析**根）：同一物理项目经链接路径与真实路径打开会拿到两把锁，并发写不被串行化。 **后续复核：2026-10-03 身份/锁键/busy 贯通已落地；2026-10-08 复核 physicalPathKey 调用。** |
| 21-3 | journal 缺口台账损坏即静默丢（`journal-segments.mjs:128`/`:138`，gaps 唯一来源 `journal.mjs:384`）：段文件仍在磁盘，缺口却从 API 与恢复逻辑同时消失 | 数据完整性 | 口径已定格（ADR 0010：manifest 是派生数据，从段文件按 seq 断层重算，generation 归属可由 `historyDir` 目录名还原）；实现待排 **后续复核：2026-10-03 已实现健康段之间断层的重建；2026-10-08 源码确认首/尾隔离段仍依赖清单，该边界待复核，不能整项关闭。** |
| 21-4 | shell 写面未纳入受保护路径承诺：`echo > run_log.jsonl` 仍可改审计账本 | 安全边界 | 20-7 余项；扩面需解析命令行，误伤合法命令的风险与工作量都更大，需独立评估 **后续复核：2026-10-03 shell 受保护路径标识硬拒绝已落地；不承诺完整命令解析器。** |
| 21-5 | `journal-segments.mjs:188-189` 隔离坏段时两次 `rename` 静默吞错：Windows 上改名失败则段文件留在原名、却已移出内存列表且 gap 照记，下次 load 重扫会**再记一条 gap** | 一致性 | 方向保守（多报缺口，不丢数据）；本轮复核新发现 |
| 21-6 | `versions.mjs:22` 经 `readJson` 裸 `JSON.parse`，坏 manifest 直接抛错，缺「仅按 `v{n}.md` 列目录」的降级兜底；`versions.mjs:29` 两步写、崩溃孤儿版被下次覆盖的后果是**时间线少一版**（正文不受影响） | 恢复语义 | 抽查第 4 项的收窄结论；其中「无上限」属 `AGENTS.md` 既定规格，不作为缺陷 |
| 21-7 | `npm run verify:app-shell` 既有失败：`scripts/verify-app-shell.mjs:372` 断言「思考项完成态标签应为 思考 N 秒」不成立 | 验收门禁 | **2026-09-27 更新（round22）：旧检查器已按用户裁决删除（D19），该欠账随之关闭——148 条断言四类交接见 round22 Task 10 提交说明；下表原始记录保留为历史。** 2026-09-25 于 round21 执行期发现；已在 round21 之前的提交 `65bcf1e` 上以 Node 22 / Node 25 独立复现同一断言，与本轮改动无关（断言由 `069ffa0` 引入）。需独立一轮定位：是投影回退出「已完成思考」回退文案，还是夹具未产出耗时 |
| 21-8 | 受保护路径的**规则侧**未 realpath：`isProtectedWritePath` / `isProtectedShellCwd`（`runtime-helpers.mjs`）用 `path.join(root, rel)` 纯字符串拼规则路径，只对 `root` 做了 realpath。若受保护目录自身是目录链接（例如把 `.versions/`、`drafts/` 用 `mklink /J` 重定向到另一块盘——这正是本产品用户使用 junction 的典型动机），目标已解析到链接外、规则路径仍指向链接点，包含性比较落空，该子树直写保护退化为「项目外→确认」，在 `yolo:true` 下等同全开 | 安全边界 | 2026-09-25 round21 终审发现。**非本轮引入**（改动前目标侧一直在 realpath，同样如此），也**不违反 ADR 0009 的决定 1**（决定只承诺「以真实项目根为基准」，未承诺规则侧解析）。同属「一侧解析、一侧不解析」的不对称，只是下沉一层；与 `tools.test.mjs:702`「项目内链接指向项目外走项目外确认」的有意取舍相邻。修法（对规则根懒解析后再比较）会改变既有保护语义与每次调用的系统调用数，需独立一轮评估 **后续复核：2026-10-03 规则与目标两侧解析真实身份已落地，见十三组修复记录。** |

> 排序原则同前：优先级不在本清单内定。

### 第二十二轮（round22）完成记录（记录于：2026-09-27｜状态：历史记录）

**范围**：SPEC `docs/design/2026-09-26-round22-ui-ux-and-model-config-spec.md` 的 A/B/C 三条缺陷链 + D1-D23 交互原型落地 + 截图圆点/竖条修复 + 旧检查器退役。分支 `codex/round22-ui-model-config`（自 `adad63a` 切出，独立工作树 `D:\WWriting-round22`），12 个任务全部完成、逐任务提交。

**用户可见变化**（与 SPEC「本轮可见变化」表一致）：普通文件夹顶栏显示文件夹名并可接线会话（D1）；点「+」立即出现「新对话」草稿行（D3）；活跃会话高亮全应用唯一（D2）；模型设置为列表+面板两栏、窄屏降单栏（D13）；新增厂商目录与「添加供应商」候选池（D7）；密钥存储名概念从产品移除（D8）；目录厂商连接字段只读带锁（D9）；模型只能经「添加模型」（可搜索候选/手填 ID）入列（D10）；三协议可选（OpenAI Chat Completions / Anthropic Messages / OpenAI Responses，D5）；模型分区专属脏确认文案（D12）；composer 与正文列右缘对齐、树线对齐箭头中心、竖条与状态点不再重叠（D15）。

**验收证据（记录于 2026-09-27，均为实跑）**：
- `npm test`：**2016/2016（exit 0）**（前值 2001/2001，round21）
- `npm run verify:unified-agent`：exit 0；`npm run verify:desktop-shell`：exit 0
- `npm run verify:app-clickability`：**19/19 期望通过（exit 0）**，含新增 D17 断言（草稿行 500ms、首条消息真实行、全文档唯一高亮）
- 几何探针（`artifacts/round22/geom-probe.cjs`，真实 Electron，1440/1180/1000/390 四视口）：无横向溢出、圆点与竖条间隙 **8px（≥4）**、树线对箭头中心 **0.5px（≤1）**、composer 右缘差 **0px**
- 模型设置流程探针（`artifacts/round22/model-flow-probe.cjs`）：目录搜索→点选入列→只读连接行带锁→空态仅「添加模型」→手填 ID 入列，截图 `artifacts/round22/model-flow/`（5 张）；全量 UI 采集 `artifacts/round22/full-ui/`（48 张，MANIFEST.json）
- 原型注解区字符串未移植进产品（`rg` 复核，仅代码注释存留说明）；从产品界面剔除的解释性字符串：「使用环境变量名」开关及其全部文案、密钥存储名输入与「已填环境变量名（…）」状态变体、new-model 占位提示——保留的提示均为「删掉会做错」类（已配置/未配置、必填校验、模型 ID 必填、连接结果行）

**D23 状态：未完成（7/10 真实 logo）**：7 家取自 Simple Icons（CC0，来源与日期见 `src/app-shell/vendor-logos.js` 头注）；OpenAI / xAI / 智谱三家 Simple Icons 实测 404，且其官方品牌资产需事先书面许可、本轮无法合法确认，按 D23 降级规则用大写首字母中性标。后续需用户取得授权后补齐。

**退役与新增**：`scripts/verify-app-shell.mjs` 已删（148 断言四类交接表见 Task 10 提交 `chore: retire brittle app shell verifier`）；21-7 欠账随之关闭。新增文件：`src/core/model/anthropic-messages.mjs`、`src/core/model/openai-responses.mjs`、`src/core/model/vendor-catalog.json`、`src/app-shell/vendor-logos.js`、`src/app-shell/model-rows.mjs`、`tests/model/protocol-adapters.test.mjs`。R1 红线：全库 0 越线（`app.js` 本轮压缩至 50236B，余 964B）。

**欠账与限制**（只记不排）：① D23 缺口三家 logo（见上）；② 候选模型 ID 为目录候选示意，未逐家实测可用性（连接测试与真实 Agent 调用按协议闭环，但未经真实厂商密钥端到端验证——如实标注，不冒称）；③ `verify:provider-online` / `verify:research-online` 本轮未跑（需真实密钥/外网，不在门禁四条内）。

### 第二十三轮（round23）完成记录（记录于：2026-09-28｜状态：历史记录）

**范围**：无预设 SPEC——用户指令「从 AI 对话里的过程性反馈这个模块大量找 bug，先不修复」→ 全模块审计（源码通读 + 真实 Electron 探针实测，拒绝只靠读代码下结论）→ `to-tickets` 开 8 张工单 → 子 agent 逐单实现 → 双轴 code-review → 顺带把四份规格对齐现行代码并**合并为单一契约文件**。工单与探针产物在 `.scratch/process-feedback-fixes/issues/`、`.local/probe/`（均不入库）。

**提交链**：`4ff3f16`（工单01 行上限）→ `c4fe12e`（05 下拉点击）→ `5945565`（06 搜索行样式）→ `e2439ca`（04 工具标签）→ `72db92b`（03 计划整表替换）→ `9dda235`（02 增量渲染）→ `d7017d2`（评审跟进）→ `bfed23f`（规格对齐）→ `0c84603`（规格合并）。

**用户可见变化**：① 工作组恢复规格验收契约「单组 ≤ 20 行」（`711f368` 丢失的 MAX_ROWS=20 + trimmedIds）：一次 Run 几十次工具调用不再无限堆高过程列表；只裁最早终态行，运行/等待行永不丢，被裁项不复活，快照单帧收敛。② 长会话生成更跟手：过程反馈按组修订号增量渲染（`WORK_INERT_EVENTS` 惰性白名单，漏列只浪费不失效），实测 40 run × 75 工具（投影 3040 项）单事件成本 6041→42 次 stringify、12.4ms→4.3ms；正文/思考增量事件（约每 24ms 一条）不再触发整段历史重走。③ 计划口径统一：模型删掉的步骤立即从工作组计划行消失（原按 id 合并保留 → 与 chip 出现 2/4 vs 1/2 两个进度），description 省略即清空。④ 7 个注册工具补中文标签（入账章节/回滚章节/统计字数/统计文风/读取前情/读取技能/更新设定——此前界面直接显示 `finalize_revision` 等内部名）。⑤ 计划下拉内部点击不再收起面板（可选中复制）。⑥ 计划行不参与 20 行裁剪（评审发现的回归，负向验证）。⑦ CJK 状态词竖排与本段同窗口的早期修复：主进程解码崩溃（ff6af01）、Esc 冲刷死按 + 供应商不存在文案（fdd4fc8）、8 处竖排（3dcc935/1f6aa5c）。

**规格维护模式变更（本round最重要的一条）**：三份现行规格（样式规格书、/init 规格书、multi-session-architecture）合并为唯一契约文件 `docs/design/统一行为规格书.md`（§1–§11 对话面编号不变，内核 §12–§21，多会话 §22–§31）；卷首维护规则=行为改动只改它一处+对照物模型（与代码冲突以代码+测试为准回改）；三份旧文件降级历史并放墓碑；`docs/design/README.md` 建索引；AGENTS.md（本地）加唯一入口指针。合并前先做了 20 处对齐修订（bfed23f：状态横幅已废、组状态文案、立即=优先调度、input 事件集、任务计划 chip、/compact、空态文案、模型菜单 max-height、重连口径、journal 分段布局等）。

**验收证据（记录于 2026-09-28，均为实跑）**：
- `npm test` 全量 **2039/2039（exit 0）**（前值 2016/2016，round22；本轮 +23 用例）
- Electron 探针（`.local/probe/run-probe2/5/6.cjs`）：门控正确性（惰性事件 0 重走、脏组 42 次 stringify、新工具行即时出现且标签正确）+ 20 行上限（DOM 3040→800 行）
- 计划一致性脚本（`plan-probe.mjs`）：groupRow=chip=2、removedStepStillInGroupRow=false
- 双轴 code-review（Standards/Spec 子代理并行）：Spec 轴发现计划行裁剪回归（已修+负向验证）；Standards 轴 3 条文档/测试问题（已处理）
- R1 红线：全库 0 越线；`work-group.mjs` 872 行/43089B、`work-items.mjs` 665 行/32995B、`state.js` 950 行/44071B（LF 归一）

**欠账与限制（只记不排）**：① 工单 07 **已裁决并实现**（2026-09-28 口径 A：新 Run 清空 chip，沿用 F7/F11 口径；`state.js`+`index.js`+2 用例，统一书 §4.2 已定稿）；② 工单 08 **已裁决**（口径 B：维持「query 不进标签」，统一书 §4.3 已注记，无代码改动）；③ 四项明确不做并记录理由：失败文案行内+详情双显（碰字段顺序验收契约）、rev 跨 state 实例比较（生产路径必 reset，已契约化注释）、`activityToRun`/`turnToRun` 不回收、stopping 期间停止按钮可点（后端幂等）；④ web_search 特化分支当前不可达（注册表无此工具），来源行样式为规格预置（+363B）；⑤ round22 遗留 D23 三家 logo 不变。

### 降级可见性修复（记录于：2026-10-02｜状态：历史记录）

**范围**：用户点名的三处「降级方向对但不可见」灰色地带，全部走已有通道，无新模块/新依赖/新 CSS。

- **journal 投影写失败**（原 `projection_write_error` 可观察字段零消费方）：agent snapshot 响应新增 `projection_write_error`（`src/core/agent/runtime.mjs`）；前端 `state.js` reduceSnapshot 镜像、`view.js` 在 runSection 顶部渲染提示行（复用 `system-notice` 样式，agent.css 零新增）。
- **章节版本基线迁移失败**（原仅 console.warn）：run-pipeline 把最近一次结果记入项目内存态 `state.baselineMigrationError`（成功自愈即清除，每轮模型请求重试，重启后失败自然重现故不持久化），经同一 snapshot 字段 `baseline_migration_error` 下发、同一提示行渲染。
- **供应商清单 JSON 损坏静默置空**：两条读路径都补 console 告警——写路径 `model-provider-store.mjs` `readRawStore`（SyntaxError 原本连 warn 都没有，且下次保存会用空清单覆盖原文件）、只读路径 `project-model-migration.mjs` `loadProviderStoreReadOnly`（SyntaxError 原被显式排除在告警外）；降级语义本身不变。

**规格**：统一行为规格书 §19 新增「维护级降级必须可观察」条款。

**验收证据（记录于 2026-10-02，均为实跑）**：
- 新增 3 个测试：`project-agent.test.mjs` 端到端快照契约（破坏 .versions 与 session.json → 两字段非空、Run 仍完成）、`model-provider-store.test.mjs` 扩展（损坏 → 空清单 + 告警）、`model-project-migration.test.mjs`（只读路径损坏告警）、`agent-surface.test.mjs`（提示行非空显示/null 收起）——共 4 个。
- 相关回归：project-agent 91/91、agent-surface 203/203、model-provider-store + model-project-migration 34/34、architecture R1 + journal-recovery + diagnostics 112/112。全量 `npm test` 本轮未跑（改动面小且已过定向回归）。

**欠账与限制（只记不排）**：工作区另有五个文件与本任务无关的未提交改动（`utils.js` 删 `ensureTrailingSlash`、`journal-queries.mjs` `isIdleInitiatedRun` 单遍扫描重构、`run-pipeline.mjs` 删 `needsCompletionTerminal` 薄委托、`agent-routes.mjs` title 校验重构、`model-provider-store.mjs` id 工厂去导出），本轮修复叠加其上，提交时需一并处理。

### 五项最小维护可见性/完整性修复（记录于：2026-10-02｜状态：历史记录）

**范围**：用户点名的五个灰色地带最小修复（几行级、不建新子系统），主题=「检测失败≠检测通过、恢复不许说谎、没做要可见」。

1. **drift 检测失败哨兵**：`detectLedgerDrift` 失败时 run-pipeline 注入 `{issue:"drift_check_unavailable"}` 哨兵（原先是空数组=模型无从区分"没漂移"和"没检测成"）；`buildLedgerDriftNote` 加分支渲染"检测不可用"注记。
2. **三件套传感器（不拦截）**：`run-lifecycle.mjs` 新增 `senseMemoryMaintenanceLag`——Run 收尾（`run_completed` 落盘后、项目互斥锁内）扫 journal 尾部 500 条找最后一次章节生效工具事件（commit_chapter/finalize_revision/rollback_chapter），比对 `WORKLOG.md`/`book_summary.md` mtime；没跟上 → run_log.jsonl 落 `memory_maintenance_lag` 审计事件 + `state.memoryMaintenanceLag`（下轮 prompt 注入 `[Memory Maintenance]` 注记一次即清除；条件仍在则下次 Run 收尾重新检出）。模型自主维护性质不变。
3. **readChapterVersion 读回验证**：manifest checksum 与实际内容不符抛 `version_checksum_mismatch`（先例 draft_checksum_mismatch）；旧 manifest 缺 checksum 跳过验证。回滚路径因此拒绝恢复被直接改动的版本文件。
4. **event-log 尾行/中间行区分**：`readEvents` 全量与尾读两条路径都区分——文件末尾未终结行（写入中断）容忍；中间行损坏落 `event_log_corruption` 审计事件（追加失败不影响读取）。尾读首块判定文件是否以换行结尾。
5. **restoreGeneration 拒绝说谎**：目标目录非空时抛错——原先落空继续 updateManifest 会把 manifest 改成"已恢复旧 generation"而目录里是新数据。fd 关闭时机随之下沉到真正移回的分支（异常分支不动 store 内存状态，新 generation 仍可追加）。

**测试（新增 5 个）**：ledger-drift 哨兵注记、versions 读回校验、event-log 中间行落事件+尾行容忍（全量+尾读双路径）、journal-segments restoreGeneration 拒绝、project-agent 三件套传感器端到端（commit 后不维护 → run_log 事件 + 下轮 system prompt 含注记）。

**验收证据（记录于 2026-10-02，均为实跑）**：
- ledger-drift + event-log + versions：23/23；journal-segments：18/18；project-agent + prompt + journal-recovery：226/226；project-routes + architecture R1 + diagnostics + dashboard：40/40；acceptance unified-agent：29/29。
- 全量 `npm test` 未跑（定向回归覆盖全部触碰模块）。

**已知上限（只记不排）**：① 传感器只扫尾部 500 条事件，最后一次章节生效早于该窗口时本轮跳过检测（下次 commit 重新入窗）；② run_log 有中间行损坏时每次读取都会追加一条 corruption 事件（审计文件自身不可写时静默、console 告警保留）；③ 三件套注记在工作区内每次 Run 至多注入一次，模型持续忽略时依赖每次 Run 收尾的 run_log 事件累积可见性。

### 实现逻辑补强十三组修复 + v0.5.3 发布（记录于：2026-10-03｜状态：历史记录）

**范围**：以 `.local/logic-review/2026-10-03-实现逻辑补强分析.md` 的 16 个探针为输入（全部实机复现、逐项源码核查），经同日访谈拍板 Q1–Q7 后形成 SPEC `.scratch/logic-review-fixes/spec.md`（分析、探针、SPEC 均不入库）。主题是一类「系统说谎」缺陷：既有承诺没有兑现——中文静默损坏、版本库兜底名不副实、预算配置是摆设、受保护面可绕过。范围仅限根项目（Agent 内核与工作区）；同一发布窗口内 CLI 子项目的工作（章节收尾与 Run 重试等）由 `WWriting cli/docs/` 下各自规格记录，不在此登记。

**提交链**：`c181dce`（数据与一致性补强：中文跨块无损/恢复临界区/读回校验/快照写序/提交中断补齐/伏笔重开/journal 缺口派生与锚点修复）→ `89fd733`（执行控制与身份贯通：预算开关/受保护路径/密钥即时脱敏/物理路径身份/导出缺章警示）→ `c0051d9`（统一书新增 §33 补强行为契约节，修订 reasoning 回传/legacy-import/§32 陈旧表述）→ `8aa1cdc`（v0.5.3：版本号、CHANGELOG、README 双语下载名同步）。规模：75 文件 +3481/−214（依据：`git diff --shortstat 3bc6220..8aa1cdc`）。

**用户可见变化**：
1. **中文跨块无损**：HTTP 请求体按字节累计、按字节判上限（1MB，约 22 万汉字）后整包解码；审计日志尾读按字节定位完整换行再解码。任意网络/读取分块下逐字不差（此前一个汉字横跨 64KB 块边界被解码成替换符，JSON 仍合法故无任何报错）。
2. **恢复临界区**：记忆恢复「读当前 → pre_restore 快照 → 覆盖」整体进同一把项目写锁（busy 检查移入锁内，对外仍 409），章节回滚同样收进临界区——恢复窗口内的新写入不再被静默覆盖。
3. **历史读回校验**：记忆版本与 CLI 章节账本读回时核对 checksum/内容指纹，不一致抛专用错误；旧记录缺字段跳过校验（无法核对≠损坏），且不在返回值里假称已校验。
4. **版本快照写序**：到达 200 版上限时改为先原子写新版本、再写裁剪后清单、最后尽力清理旧文件；任何失败路径下既有历史全部保留（此前先删最老一版，写入失败即永久丢失）。
5. **提交中断幂等补齐**：重复提交分支返回成功前核查 checkpoint 与 chapter_completed 审计事件，缺项按当前内容幂等补齐，补记在审计事件里可区分。
6. **伏笔重开**（Q1=A 只修工具能力）：提交 open 伏笔时若存在同内容已回收条目，置回未收并清回收章号（保留埋设章号与提示）；回滚后的设定维护仍由模型自主执行，不建自动回退系统。
7. **预算执行**（Q2/Q3/Q7）：设置抽屉新增默认关闭的预算开关与模型调用数上限编辑 UI；开启后每次模型请求前累计检查，达到上限以失败结束（专用错误码、中文写明次数），重试清零重新计数；`max_cost`/`max_total_tokens` 保留可存但不执行（注释标示「暂未生效」）。
8. **受保护路径统一真实身份**（Q4=A）：写保护规则与被检目标两侧同解析 junction/symlink（版本目录本身被换成目录链接时不再写穿）；shell 命令文本含受保护路径标识即硬拒绝，优先级高于权限模式（YOLO 不绕过；读取改用读工具，接受误报）。
9. **密钥即时脱敏**：保存/轮换密钥同步刷新运行中 Runtime 的脱敏名单（改共享最新值，一次性与流式共用）——运行中新增的密钥不再以明文进入持久日志。
10. **缺章导出**（Q5=A）：导出响应携带缺章清单，前端在成功提示外给 warning 级「导出不完整：缺第 X 章」；导出拒绝语义不变。
11. **journal 缺口台账派生重建**（按 ADR 0010）：用健康段序号断层、隔离段与代际历史重建缺口元数据，清单文件损坏不再导致缺口消失；不新增第二真相源。

    记录于：2026-10-08｜状态：待复核｜依据：当前 `journal-segments.mjs` 源码。以上为当时记录；实际重建覆盖健康段之间的断层，首/尾隔离段仍依赖清单，不能据此宣称所有缺口均可恢复，见顶部待办与 ADR 0010 的实现状态补注。
12. **项目身份贯通**（按 ADR 0009）：workspace 身份、锁键、busy 判定统一真实物理路径，旧 workspace ID 下的数据提供兼容查找/迁移，界面保留原选路径展示。
13. **journal 锚点重放**：修正锚点增量重放与降级重放两处「声明后循环内重新赋值」的变量错误，长历史恢复不再整体退回全量扫描。

**过程记录**：9 轮子代理交叉审查（A–J 各组 + journal 专项）发现并修复 4 个严重问题（预算跨 Run 计数泄漏、shell cwd junction 方向性回归、HTTP 请求体上限误收窄、journal 跨流 gap 融合）与若干一般/建议项；锚点回归测试经回归副本验证具备区分度。探针脚本 `.local/logic-review/probes.mjs` 本体断言「全部复现」，验证侧以反转断言与新契约场景执行，未改探针口径。

**验收证据（记录于 2026-10-03；数字来源：SPEC 执行记录与会话内实跑日志）**：
- 根目录全量 `npm test` **2081/2081（exit 0）**，127.9s（依据：`.local/logic-review/full-test-final.log`，2026-10-03 19:46 实跑；前值 2050，净增 31 个回归测试）。
- 审计探针 **16/16 符合期望**（13 缺陷场景不复现 + 3 新契约场景生效）。
- CLI 侧相关测试绿；4 个预存输入行为失败不在本轮范围（需 Windows Terminal/ConPTY 实机验收）。
- 统一行为规格书 §33 落地（`c0051d9`），本轮全部行为契约改动同步写进契约。

**发布（v0.5.3）**：版本号、CHANGELOG（含此前挂「未发布」的两条路径身份修复）、README 双语下载名（`WWriting Novel Agent-0.5.3-Setup.exe`）已提交并推送（`8aa1cdc` 在 origin/master）。安装器本机构建一度失败并已解决：electron-builder 26.8.1 解压 winCodeSign 时 `7za` 建不了 darwin 符号链接（账户无符号链接特权，报「客户端没有所需的特权」，4 次重试后 EXIT=1）——app-builder 的缓存命中只检查 `<缓存>/winCodeSign/winCodeSign-2.6.0/` 目录**是否存在**（不做完整性校验），把一份完整 winCodeSign 载荷（rcedit-x64.exe + win signtool）补进 `.electron-builder-cache/winCodeSign/` 即跳过下载解压；默认缓存（`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\`）本就含可命中载荷，故只有设了 `ELECTRON_BUILDER_CACHE` 的 `package:installer` 受影响。产物 `dist-desktop/WWriting Novel Agent-0.5.3-Setup.exe`（101,972,222 字节，构建日志 `.local/logic-review/build-installer-3.log`），`npm run verify:installer` 通过；打包后 exe 元数据正确（ProductName=WWriting Novel Agent、FileVersion=0.5.3）。本机无代码签名证书，产物 `NotSigned`（安装时会有未知发布者提示）。**GitHub Release v0.5.3 已发布**（同日补记：`https://github.com/wh520-wh/wwriting-novel-agent/releases/tag/v0.5.3`，Latest；资产 `WWriting.Novel.Agent-0.5.3-Setup.exe` 101,972,222 字节，下载校验 200/长度一致；标签 v0.5.3 打在发布提交 `8aa1cdc` 上；说明正文即上方 CHANGELOG v0.5.3 节）。

**欠账与限制（只记不排）**：① 设定档案的自动回退系统（事实/角色特征的失效与替换契约）明确不做；② `max_cost`/`max_total_tokens` 只存不执行；③ 记忆三件套传感器增强（continuity 维度、重启信号重建）不做；④ 长项目每轮重读章节的性能优化先测真实规模；⑤ CLI 四个输入行为测试失败待实机 ConPTY 验收；⑥ 完整 shell 命令解析器、新沙箱、第二套预算配置、第二套缺口真相源、内容质量门禁均明确不做；⑦ 验证边界：未做收费模型调用、断电持久性、安装器的实机安装验收（本轮只到构建与产物校验）；⑧ 打包环境未治本——winCodeSign 的根因是账户缺符号链接特权（可开 Windows 开发者模式，或管理员身份解压一次），当前用缓存补齐绕过，换机器或清缓存后需重做该步。
