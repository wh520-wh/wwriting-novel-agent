# 第十五轮规格：内核分区重构--三病灶同治与前端控制面重排（2026-08-23）

- 状态：已实现（2026-08-23，执行记录见文末）
- 输入：第 15 轮全库架构分析（本轮对话：后端内核 / 前端控制面 / 测试守卫三路深挖报告，行号见各节）、基线 `npm test` 1915/1915 全绿（80s）、需求对齐决策 D1-D7（本轮对话逐条拍板）、第十四轮 spec 惯例 [[2026-08-22-round14-skill-plugin-style-spec]]
- 一句话：以目标模型（六概念 + 单一真相源 + 投影 owner）为基准，把后端 runtime/journal/tools 三病灶与前端 view/state 双病灶一次重排到位，HTTP 业务下沉、gsap vendor 退役、守卫红线立线--除一处零成本例外外行为零变化，净删约 5,800 行。

## 决策记录（对齐拍板，逐条可溯）

- **D1 改造烈度：破立结合·边界冻结**。内部结构当新建的来设计；四条边界不动摇：Agent 19 方法公共接口（`src/core/agent/index.mjs`）、HTTP API、journal 磁盘格式与用户数据兼容、每波全量回归绿。它们是已验证的行为资产，不是历史包袱。
- **D2 范围：四包全量**。后端内核 / 前端控制面 / HTTP 下沉+app 入口化 / 守卫+欠账。CSS 分层（styles.css 2797 + agent.css 2250，两文件类名零交集）、session-sidebar（732）/drawer-panels（446）结构拆分为非目标。
- **D3 后端边界：三病灶同治**。runtime 拆分 + journal（reducer handler 表化、投影查询 API 收归 journal）+ tools（四域注册模块，execute/权限/期限/日志样板留 ToolRuntime 单点）。只拆 runtime 的话 journal/tools 仍是越权状态，概念完整性不闭合。
- **D4 验收标准：三层防线**。整壳契约测试（既有 1915 个）保行为；新拆出的纯函数模块各配薄单测钉住新 seam；前端波用 capture-all-ui 重建截图基线与 round-01 逐图对比保像素级不变。
- **D5 缓修项策略：严格等价 + 零成本例外**。拆分只搬不改；唯一预期例外 F17（timelineSeqs，view 拆分时该索引本来就要重写）。其余缓修项（F18-F22、08-18 审计 D/E/G/H/M3-M5）全部非目标，留待专门轮次。回归出问题时归因干净：只可能是搬动引入。
- **D6 守卫红线：1200 行 + 唯一例外**。拆分完成后 src/ 全部非 vendor、非 CSS 文件 ≤1200 行；唯一显式例外 `src/app-shell/settings-modal.js`（1517 行，D7 迁移后约 1300，结构拆分留下轮，例外登记在守卫测试注释里）。守卫目的是防复发不是惩罚存量。
- **D7 form-kit 深度：范式统一、结构不拆**。同一弹窗两套表单范式（概念问题）本轮收干净：settings-modal 迁移到共享 form 构建层；settings-modal 的结构拆分（尺寸问题，D2 非目标）继续留给下轮。两个问题分开处理，不互绑架。

## 术语

- **目标模型六概念**：Workspace（工作区）/ Session（会话）/ Input（输入）/ Run（运行）/ Tool Call（工具调用）/ Checkpoint·Compaction（检查点与压缩）。本轮一切模块边界以这六个概念的所有权划分。
- **三病灶**：`runtime.mjs`（3056 行单闭包，63 个嵌套函数）、`journal.mjs`（1982 行，`reduceEvent` 746 行 48 case）、`tools.mjs`（2123 行，14 个工具注册与执行/权限/样板挤在一处）。前端镜像病灶：`agent/view.js`（2363 行，约 70 个内部函数共享 30+ 闭包变量）、`agent/state.js`（`applyEventToState` 约 500 行 30+ 事件类型）。
- **投影查询**：从 journal 事实流派生状态的查询。owner 是 journal（reducer 内存投影），调用方不得自行 `read({afterSeq:0})` 全量扫事件重推导。
- **seam（缝）**：模块对外的公共接口边界。公共 seam 仅三个：`src/core/agent/index.mjs`、`src/app-shell/agent/index.js`、`src/core/skills/index.mjs`（守卫测试 `SURFACE_SEAM_TESTS` 既有白名单）。本轮新拆出的内部模块一律不得被本包之外 import。
- **整壳契约测试**：从公共 seam 驱动的既有 1915 个测试，本轮行为等价的主回归网，原则上不动。
- **prove-dead**：删除后全库（src/ tests/ scripts/）grep 证明零残留引用。
- **handler 表**：`{ [事件类型]: 处理函数 }` 映射表，取代巨型 switch/if 链；journal 与前端 state 同构同治。
- **零成本例外**：见 D5。本轮唯一预期例外是 F17（timelineSeqs 泄漏，`view.js:349`）。

## 目标

- F1 常量与微工具单源化（三病灶公共地基，先行）
- F2 journal 投影查询收敛（4 处全量扫描改 journal 查询方法）
- F3 journal reducer handler 表化（48 case 按域拆表，journal-handlers.mjs）
- F4 tools 四域注册拆分（`src/core/agent/tools/` 子目录，工具名单单源派生）
- F5 runtime 拆分（history-assembly / run-lifecycle / session-manager 独立，runtime 回归编排内核）
- F6 dom-kit + form-kit 收敛（toast/focusTrap/confirmLayer/el/bindAutosave 单源，settings-modal 迁 form-kit）
- F7 state.js 事件 handler 表化 + 连接 code 集合单源
- F8 view.js 四分区拆分（timeline / work-group / cards / composer，含 F17 例外修复）
- F9 gsap 退役（motion-runtime API 不变、实现换 CSS transition，删 5629 行 vendor）
- F10 HTTP 业务下沉（模型切换/项目列表/迁移/检索归域模块，assertNotArchived 单源）
- F11 app.js 入口化（bootApp 显式入口 + refs 按域分组）
- F12 守卫加固（1200 行红线、test glob 覆盖守卫、内部模块 seam 守卫）
- F13 欠账回写与过时记录订正（WWRITING.md 十四轮进度、压缩审计发现 2 状态、死代码清零）

## 非目标（明确不做）

- **零行为变化边界**：不改 prompt 文本、不改工具语义与权限判定、不改 HTTP API 路径与响应形状、不改 journal 事件 schema 与磁盘格式、不改 UI 渲染结果（F17 例外只影响内部 Map 索引，不改任何像素）。
- **不引框架/构建步/新依赖**：不引 React/Vue、不加打包器、不引 eslint/dependency-cruiser（守卫扩展现有 `tests/architecture/dependency-rules.test.mjs`，它已在解析 import）。runtime 依赖只有 4 个（ignore/marked/yaml/yauzl），保持不变。
- **不拆**：session-sidebar.mjs、drawer-panels.js、settings-modal.js 结构、两个 CSS 文件、既有测试大文件（agent-surface 5495 / project-agent 3231 / journal-recovery 3006 行的拆分是测试编排问题，本轮只新增薄单测不拆旧测试）。
- **不修**：F18-F22、08-18 审计 D/E/G/H/M3-M5（触发条件未到，留专门轮次）；`app-server.mjs:45` staticRoot 的 cwd 默认值（开发便利，组合根已显式传参）；tools 注册项 `interruptible` 默认值反转（未来语义风险大于样板收益）。
- **不动**：`src/core/agent/index.mjs` 的 19 方法转发层（它就是 D1 冻结的 seam 本身）；model 层（十三轮刚收口）、skills 层（十四轮刚收口）。

## 承重不变量（写明防误改）

1. **journal 是唯一事实源**：一切派生状态可从事件流重建（`session.json` 本身是可重建投影）。本轮新模块**不得自建第二份持久状态**--history-assembly/run-lifecycle/session-manager 全部无磁盘写入，状态要么在 journal 投影、要么是 Run 生命周期内的内存瞬态。
2. **公共 seam 冻结**：`src/core/agent/` 内部新模块（history-assembly/run-lifecycle/session-manager/journal-handlers/tools/*）只允许被 `src/core/agent/` 内 import；`src/app-shell/agent/view/` 新分区模块只允许被 view 壳 import。F12 守卫钉死。
3. **行为等价口径**：除 F17 外，本轮一切 diff 不改变可观测行为--事件序列逐字节一致、HTTP 响应一致、UI 渲染一致。回归出问题 = 搬动引入，双向二分定位。

---

## 波A：后端内核（F1-F5）

### F1 常量与微工具单源化

删除清单（行号为当前基线）：

- `COMPACTION_EVENT_TYPES` 双定义逐字重复：保留 `compaction.mjs:33`（压缩域 owner），删除 `context-checkpoints.mjs:102` 并改为 import。
- `PLAN_STATUSES` 双定义：保留 `journal.mjs:136`（事件域 owner，已 export），删除 `tools.mjs:94` 本地副本（`tools.mjs:1288/1316` 两处消费改 import）。
- checkpoint 文件前缀双定义：删除 `runtime.mjs:153` `CHECKPOINT_FILE_PREFIX`，统一走 `context-checkpoints.mjs:78` `FORMAL_PREFIX`；`runtime.mjs:677` `readCheckpointFile` 自拼路径改为经 checkpoint store API 取文件，绕过 store 的私有路径拼接消除。
- 工具名单双真相源：`runtime.mjs:112-125`（`GENERAL_TOOL_NAMES`/`DEEP_TOOL_NAMES`/`PRODUCTION_TOOL_NAMES`）整段删除。消费点 `runtime.mjs:1069`（allowedDefinitions）与 `:1971`（`allowed_tool_names` 快照字段）改从 ToolRuntime 注册表派生（registry 是唯一真相源，名单随注册自动一致--与 F4 配合落地）。
- 微工具四重复制：`fail`/`defaultClock`/`normalizeAt` 在 journal.mjs/runtime.mjs/tools.mjs/compaction 等约 4 处各写一份，收敛到新 `src/core/agent/agent-utils.mjs`（预计 <50 行）。
- 过时注释与死代码：`tools.mjs:6`「恰好 13 个工具」、`:804`「五个 deep」（现为 8 通用 + 6 深）；`tools.mjs:102` `CHAPTERS_DIR_REL`（注释自认无用）；`runtime.mjs:107-125` 一带的旧 promote 注释残留。

行为口径：纯删除与 import 改向，事件序列零变化。prove-dead 清单：`COMPACTION_EVENT_TYPES`（context-checkpoints 内定义）、`PLAN_STATUSES`（tools.mjs 内定义）、`CHECKPOINT_FILE_PREFIX`、`GENERAL_TOOL_NAMES|DEEP_TOOL_NAMES|PRODUCTION_TOOL_NAMES`、`CHAPTERS_DIR_REL`。

### F2 journal 投影查询收敛

现状：runtime.mjs 四处 `journal.read({ afterSeq: 0, limit: 100000 })` 全量扫事件重推导，与 journal reducer 职责重叠：

| 调用点 | 现职责 | 归宿（journal 查询 API） |
|---|---|---|
| `needsCompletionTerminal`（:1092，扫描 :1093） | 判 Run 是否已有终局事件 | `journal.hasTerminalEvent(runId, inputId)` |
| `findInputMeta`（:1297，扫描 :1298） | 按 inputId 找输入元数据 | `journal.findInputMeta(inputId)` |
| `isCompactRunIdleInitiated`（:1317，扫描 :1318） | 判压缩 Run 是否 idle 发起 | `journal.isIdleInitiatedRun(runId)` |
| `findTerminalInputId`（:2575，扫描 :2576） | 找 Run 的终局 inputId | `journal.findTerminalInputId(runId)` |

实现口径：查询优先读 reducer 内存投影；投影不持有的信息（如 input 元数据索引）在 reducer 内补建（session 投影增加按 inputId/runId 的索引 Map），**不加磁盘格式、不改事件 schema**（D1）。`snapshot`（:2790，raw read :2838）是 API 表面，保留直读。runtime 四个函数体替换为单行委托，函数名可保留为薄别名（调用点不动，diff 最小）。

验收：新增 `tests/agent/journal-queries.test.mjs` 薄单测（四查询的正/反路径）；既有 journal-recovery/project-agent 测试零改动全绿。

### F3 journal reducer handler 表化

- `journal.mjs:309-1076` `reduceEvent`（746 行、48 个事件 case）拆为 handler 表，迁至新 `src/core/agent/journal-handlers.mjs`：`{ [eventType]: (session, event, side) => void }` 映射 + 按域分组（transcript / run 生命周期 / 队列与优先 / 计划 / 决策与授权 / 压缩 / 会话元数据）。未知事件类型的现行为（原样忽略或 fail，以现状为准）保留为表尾默认分支。
- 随迁常量与投影构造器（handler 的自然内聚件，非尺寸游戏）：`FIXED_EVENT_TYPES`（:64）、`SESSION_STATUSES`（:116）、`RUN_STATUSES`（:125）、`PLAN_STATUSES`（:136）、`TERMINAL_RUN_STATUSES`（:138）、`COMPACTION_NON_TERMINAL_STATES`（:141）、`WORK_CLOCK_ACTIVE_STATUSES`（:164）、`TERMINAL_EVENT_TO_STATUS`（:166）、`RUN_STATUS_TO_SESSION`（:178）、`createEmptySession`（:221）、`createRun`（:251）、`transitionWorkClock`（:277）、`activateInput`（:286）全部迁入 journal-handlers.mjs 并由其 export。
- `journal.mjs` 保留：微工具（改用 F1 的 agent-utils）、`createSideState`、`buildProcessRestartedConvergence`（:1077）、`createAgentJournal` 工厂（:1090-1982：storage/anchor/append/read/轮转/迁移）。行数预期：journal.mjs ≈1150-1200，journal-handlers.mjs ≈950-1000，双双落红线内。
- journal.mjs 同时增收 transcript 落盘策略三件（从 runtime 迁入，journal 是 transcript 记录 owner）：`redactTranscriptRecord`（runtime :1025）、`appendSafeTranscript`（:1033）、`persistentToolResult`（:1037），作为 `createAgentJournal` 的新增方法（`appendTranscript` 已存在于工厂内，语义对齐）。

**对账纪律**：拆前数 case 数（48），拆后 handler 表键数必须相等--写进 `tests/agent/journal-handlers.test.mjs` 薄单测断言（`FIXED_EVENT_TYPES` 每个类型在表中有 handler），迁移漏 case 直接红灯。

### F4 tools 四域注册拆分

新目录 `src/core/agent/tools/`，`tools.mjs` 保留 ToolRuntime 内核并改名 `tools/index.mjs`（re-export `createToolRuntime`，runtime.mjs import 路径一处改）：

| 新文件 | 注册工具（现 tools.mjs 行号） | 预计行数 |
|---|---|---|
| `tools/definitions-fs.mjs` | list_files(:814)、search_files(:849)、read_file(:928)、write_file(:971)、edit_file(:1022) | ~550 |
| `tools/definitions-shell.mjs` | shell(:1101) | ~180 |
| `tools/definitions-chapter.mjs` | update_plan(:1272)、append_chapter_segment(:1360)、commit_chapter(:1404)、finalize_revision(:1452)、rollback_chapter(:1502) | ~450 |
| `tools/definitions-knowledge.mjs` | read_skill(:1193)、count_text(:1235)、update_memory(:1552) | ~250 |

- `tools/index.mjs`（原 tools.mjs 主体）保留单点：`createToolRuntime`（:478）的 execute 主流程、权限判定（:1690-1850 集中区）、`executeWithDeadline`（:1606）、`toolFailureResult`（:176）、registry 构建器、`appendStarted`/`appendFailed` 事件样板。四个 definitions 模块以 `register(builder)` 形式向 registry 注册，`createToolRuntime` 组装时依序调用。
- **failTool 样板收敛**：`tools.mjs:1732-1841` 的 13 处「appendStarted → try → appendFailed → toolFailureResult」三连重复，抽 `failTool()` 一内助函数，每处缩为一行调用（预计净删 ~60 行）。
- 工具名单单源：registry 注册完成后导出 `toolNames()`（或工厂实例属性），runtime 的 allowedDefinitions/`allowed_tool_names`（F1 已删常量的两个消费点）从这里取。
- 全局单例显式化：`tools.mjs:485` 默认参数直接引用全局 `skillService` 的隐藏依赖，改为必须由调用方传入（runtime 组装处已持有 skills service，传入即可；缺省值删除）。
- `memory-extractor.mjs` 名不副实（仅 `normalizeMemoryUpdateArgs` 被 update_memory 消费）：函数迁入 `tools/definitions-knowledge.mjs`，旧文件删除。
- `src/core/agent/tools/` 内部模块受 seam 守卫约束（仅 tools/index.mjs 与 runtime.mjs 可用，F12 钉死）。

**对账纪律**：注册数 14 写进薄单测断言（`tests/agent/tools-registry.test.mjs`：四 definitions 注册并集 = 14 个名字，与既有快照 `allowed_tool_names` 断言互为交叉验证）。

### F5 runtime 拆分（本轮架构主体）

`runtime.mjs` 3056 行 → 编排内核 + 四个域模块。共享闭包状态显式化为 context 对象传入（模块间不再共享闭包）：

| 新/改模块 | 迁入内容（现 runtime.mjs 行号） | 预计行数 |
|---|---|---|
| `agent/history-assembly.mjs`（新） | transcriptToMessages(:599)、buildHistory(:646)、readCheckpointFile(:677)、checkpointToMessages(:685)、buildTurnsFromTranscript(:700)、collectOpenToolCalls(:762)、summarizeLargeToolMessages(:783)、degradeVolatileToolRecords(:806) | ~330 |
| `agent/run-lifecycle.mjs`（新） | isAbort(:1111)、closeDroppedToolCalls(:1121)、closePrioritySkippedToolCalls(:1144)、closeSkippedToolCalls(:1168)、switchToPriorityAtSafePoint(:1208)、cancelRunForStop(:1250)、failRun(:1280)、convergeCompactionCancelled(:1341)、advanceOrComplete(:2065)、runLoop(:2121)、startLoop(:2189)、waitForFirstTurn(:2247)、waitForIdle(:2268) | ~600 |
| `agent/session-manager.mjs`（新） | sessions(:2928)、newSession(:2959)、renameSession(:2967)、archiveSession(:2976)、restoreSession(:2985)、deleteSession(:2999)、appendSystemEvent(:3023)、syncSessionRegistry(:193)、autoNameSessionIfDefault(:214)、deriveSessionTitle(:174) | ~330 |
| `compaction.mjs`（增收） | buildCompactionSource(:822-1023) 整段迁入（依赖 journal/checkpointStore 显式传参） | +~210（总 ~770） |
| `runtime.mjs`（保留内核） | createAgentRuntime 骨架(:236)、ensureProject(:272)、会话物化与崩溃对账(:343-488)、readProjectInstructions/loadProjectSafe/permissionModeOf/modelConfigOf(:522-598)、processCompact(:1389)、processInput(:1506-2059，委托 history-assembly 与 run-lifecycle 后预计 ~450)、公共 API 编排（open/submit/requestPriority/withdrawInput/decide/stop/retry/retryCompaction/cancelCompaction/snapshot/exportHistory/clearHistory :2282-2927） | ~950 |

- context 对象口径：`history-assembly` 收 `{ journal, checkpointStore, storageRoot, redactor }`；`run-lifecycle` 收 `{ state, sessionState, journal, toolRuntime, abort 信号访问器 }`；`session-manager` 收 `{ state, registry, journal 物化入口 }`。字段以实现时真实依赖为准，spec 只约束「显式传参、不共享闭包、不落盘」。
- `ensureUserMessageInTranscript`(:1076)、`needsCompletionTerminal` 等查询薄别名留在 runtime（F2 已委托 journal）。
- `runtime.mjs` 头部 1-31 行的 300 字状态机注释：随拆分改写为各模块头部短注释，每模块只描述自己的不变量（注释密度跟随仓库惯例）。
- 目标行数：runtime.mjs ≈950，全部新模块 <1200（D6 红线）。命名可在实现时微调，职责边界不变。

**每步纪律**：F5 按「先迁 history-assembly（纯转换，最安全）→ run-lifecycle → session-manager → buildCompactionSource」四步走，每步一提交、全量回归绿再走下一步。

---

## 波B：前端控制面（F6-F9）

### F6 dom-kit + form-kit 收敛（先行，view 先瘦身）

新 `src/app-shell/dom-kit.js`（前端共享层，浏览器模块）收编：

- `el(tag, props, children)` hyperscript：从 `model-settings-page.js:570-584` 上提（对齐其签名，成为全前端唯一 DOM 构建入口；view.js/settings-modal 的 createElement 样板在本轮触碰的函数内顺势替换，不做全量替换运动）。
- `bindAutosave`（model-settings-page.js:85-123）与 `fieldError`（:528-535）上提为 form-kit 部分。
- toast 单源：`view.js:315` showToast 与 `app.js:1186` toast 三处实现合一（含 ctx 注入路径）。
- focusTrap 单源：`app.js:1081-1093` trapTab 与 `settings-modal.js:154` bindModalTabTrap 合一。
- confirmLayer 单源：`settings-modal.js:711-804` 与 `:1270-1340` 文件内自重复的确认弹层合一。
- **D7 范式统一**：`settings-modal.js:1350-1383` `settingField` 迁移到 dom-kit form 构建层（结构不拆：settings-modal 仍是单闭包，预计 1517→~1300，保持 D6 唯一例外身份）；`model-settings-page.js` 改 import dom-kit（自身 el/bindAutosave/fieldError 定义删除）。

行为口径：UI 渲染零变化（F9 之前的动效行为也零变化）。prove-dead：`settingField`、文件内重复 `bindModalTabTrap|trapTab`、`showToast` 多处定义。

### F7 state.js 事件 handler 表化 + 连接 code 单源

- `state.js:263-767` `applyEventToState`（约 500 行、30+ 事件类型）拆为同文件内 handler 表（state.js 总量 ~893，表化后不超红线，无需新文件）。事件类型按域分组注释（与 journal-handlers 域划分同语言，同一概念同一命名）。
- 连接类 code 集合单源：`state.js:277-278` 注释自认「与 view.js isConnectionError 需两处同改」--集合提为 state.js 导出常量 `CONNECTION_ERROR_CODES`，view.js 改 import，注释删除。手工同步散弹点消除。
- **对账纪律**：拆前事件类型数写进断言（`tests/app-shell/` 新增薄单测：每个已知事件类型在表中有 handler；与 journal `FIXED_EVENT_TYPES` 的前端消费子集对账）。

### F8 view.js 四分区拆分（含 F17 零成本例外）

`view.js` 2363 行 → 壳 + 四分区模块，新目录 `src/app-shell/agent/view/`。共享闭包状态（30+ 变量）显式化为 context 对象；各分区以 `createXxxView(ctx)` 工厂返回自己的 sync 函数，壳的 `render`（:2322-2340）仍按修订号增量早退，**分区增量 reconcile 模式零改动**：

| 新文件 | 迁入内容（现 view.js 行号） | 预计行数 |
|---|---|---|
| `view/timeline.mjs` | 消息流与滚动：distanceFromBottom(:439)–clearHistoryLoadError(:501) 滚动簇、createMessageBubble(:520)、reconcilePendingSubmission(:553)、removeFailedBubble(:576)、insertTimeline(:590)、syncMessages(:645)、scheduleStreamRender(:671)、renderStreamNow(:680)、syncStream(:707)、syncGaps(:2153)、压缩行四件 buildCompactionRow(:2172)/updateCompactionRow(:2192)/runCompactionAction(:2236)/syncCompactionRows(:2255) | ~500 |
| `view/work-group.mjs` | 当前 Run 过程展示：placeRunControls(:726)、renderRunHeader(:746)、syncRun(:813)、groupLiveElapsedMs(:854)–syncWork(:1443) 全簇、clearWorkGroupTimers(:367) | ~700 |
| `view/cards.mjs` | 决策/错误/队列卡：buildDecisionCard(:1486)、syncDecisions(:1561)、syncErrors(:1593)、syncQueue(:1666)、withdrawQueuedInput(:1732)、appendWithdrawnDraft(:1746) | ~280 |
| `view/composer.mjs` | 输入区：createComposerMenu(:229)、slash 菜单簇(:1753-1822)、composer 菜单交互簇(:1823-1925)、fillMenu/setMenuValue(:1873-1925)、syncComposerControls(:1926)、syncControlValues(:1998)、canSubmit(:2011)、syncComposer(:2020)、setBusy(:2043)、restoreComposerText(:2051)、submitFromComposer(:2056)、setComposerOptions(:2147) | ~500 |
| `view.js`（壳） | createAgentView 骨架(:73)、reset(:375)/destroy(:424)、render(:2322)、syncContext(:2293)、syncNotices(:2305)、setLoadingEarlier(:2342)、createEmptyAction(:117)、ctx 组装 | ~500 |

- **F17 零成本例外（D5 唯一预期）**：`timelineSeqs` Map（:349，DOM 节点→seq 索引）在 timeline 分区重写时修正泄漏（部分移除路径未 delete 条目，节点被 GC 但 Map 强引用滞留）；修复以「节点移除路径全覆盖 delete」为口径，并在 timeline 薄单测钉住（add/remove 后 Map 尺寸归零断言）。不改任何渲染输出。
- `agent/index.js`、`work-items.mjs`、`reasoning-ticker.mjs`、`context-ring.js` 本轮不动（边界已清晰）。
- 分区文件受 seam 守卫约束：仅 view.js 壳可 import（F12 钉死）。
- **每步纪律**：按 timeline → work-group → cards → composer 四步走，每步一提交 + 全量回归 + UI 三件套。

### F9 gsap 退役

- `motion-runtime.js` 对外语义 API 不变：`openDrawer/closeDrawer/openModal/closeModal/setupMotion`（消费点仅 `app.js:296/317/1065/1072` 与 `settings-modal.js:130/1238`，全部零改动）。
- 实现替换：gsap 调用 → CSS transition + class 切换；MOTION token（motion-runtime.js:14-23 时长/缓动）映射为等值 CSS `transition-duration`/`transition-timing-function`；`prefers-reduced-motion` 分支保留（instant token 语义）。`context-ring.js:12-13` 的全局 `self` 限制注释随之删除（不再依赖全局注入）。
- 删除 `src/app-shell/vendor/gsap.js`（5629 行/185KB）与 `src/app-shell/vendor/` 目录。
- 验收：动效手感等值靠视觉基线对比兜底（D4）；prove-dead：`vendor/gsap|from "./vendor`、`gsap` 标识符全库清零。若替换后 motion-runtime 退化为纯一行转发再评估是否保留（预期保留：语义 API + reduced-motion 分支有真实价值）。

---

## 波C：HTTP 下沉与组装根（F10-F11）

### F10 HTTP 业务下沉

路由层只留路由/序列化，业务归域模块：

- `settings-routes.mjs:207-255` `switchModelByReference`（模型解析+能力冲突检测）→ 迁入 `settings-runtime.mjs`（419 行，增收后 ~600）；`settings-routes.mjs:91` `buildModelProfile` 随迁（它是模型档案构建逻辑，路由只是序列化）。
- `project-routes.mjs:170` `buildProjectList` → 迁入新 `src/core/project-listing.mjs`（或 workspaces store 方法，以实现时内聚度定）；`:115` `migrateLegacyProjectOnOpen` → 迁入既有 `project-model-migration.mjs`；`:143` `runResearch` → 迁入既有 `research-tools.mjs`（网络外呼本就属它）。
- `assertNotArchived` 双定义（project-routes.mjs:127 / settings-routes.mjs:196）→ 单源到 workspaces 域。
- `agent-routes.mjs` 与 `router.mjs` 不动（表驱动+统一错误映射已干净；SSE 轮询属传输细节）。

### F11 app.js 入口化

- 顶层过程式脚本（import 时执行 43 个 addEventListener、refs 大对象 :23-83、实例化 :85-227 全部内联）改为显式 `bootApp(root)` 入口：`app.js` 尾部一行 `bootApp(document)` 触发，测试可显式调用（既有整壳测试经 index.html 加载路径零改动）。
- refs 按域分组：rail / drawer / reader / settings 四组 getter，替代单一大对象。
- 结构不拆（D2：app.js 不做分区拆分，仅入口化与分组；1209 行预计 → ~1100）。trapTab/toast 已由 F6 收走。

---

## 波D：守卫与欠账（F12-F13）

### F12 守卫加固（`tests/architecture/dependency-rules.test.mjs` 扩展）

- **R1 文件规模红线**：src/ 全部 `.mjs/.js/.cjs`（排除 `vendor/`、`*.css`、`tests/`）≤1200 行；唯一例外清单 `[{ file: "src/app-shell/settings-modal.js", reason: "D6/D7：结构拆分留下轮，本轮仅范式迁移" }]` 写死在测试常量。守卫文件自身若超 1200 行则拆规则文件（守卫测试不受红线约束，但遵循同纪律）。
- **R2 test glob 覆盖守卫**：读 `package.json` test 脚本的 11 个目录 glob，遍历 `tests/` 下含 `*.test.mjs` 的目录，断言全部被 glob 覆盖--新增测试目录忘记登记时红灯（现状静默跳过）。
- **R3 内部模块 seam 守卫**：`src/core/agent/` 下除 `index.mjs` 外的全部模块（含新 tools/、view/ 子目录）禁止被 `src/core/agent/` 之外 import；`src/app-shell/agent/view/*` 仅允许 view.js 壳 import。沿用既有 `analyzed` Map + 常量清单模式，每规则一个 `test()` 块。

### F13 欠账回写与过时记录订正

- `WWRITING.md` 当前进度区补第十四轮完成条目（技能全插件化与网文风格体系，git `7de984c` 已收口）。
- `docs/memory/2026-08-18-compaction-audit.md` 发现 2（256k 一刀切）状态订正：第十三轮 `resolveModelLimits`（model-identity.mjs:22）已字段化修复，注记「已修」而非删除（审计历史保留）。
- 死代码与过时注释清零盘点（F1/F4 已清大头，此处收尾 grep 全库）：`memory-extractor` 旧路径、`interruptible` 注释口径、runtime 头部长注释拆分后的残留。
- **ADR 0006**（收口时写）：目标模型六概念所有权 + 三病灶归属 + journal 投影 owner 不变量，作为后续轮次的架构基准锚点。

---

## 任务拆分（建议实现序）

1. **波A**：F1 常量/微工具单源 → F2 journal 查询 → F3 journal handler 表 → F4 tools 四域注册 → F5 runtime 四步拆分。每 F 一提交（F5 四步各一提交），波末全量回归 + prove-dead 清零。
2. **波B**：F6 dom-kit/form-kit → F7 state 事件表 → F8 view 四步拆分 → F9 gsap 退役。每步一提交 + 全量回归；波末全量回归 + UI 三件套（verify:app-clickability / verify:app-shell / verify:desktop-shell）+ capture-all-ui round-02 视觉对比。
3. **波C**：F10 HTTP 下沉 → F11 app.js 入口化。波末全量回归 + prove-dead。
4. **波D**：F12 守卫三规则 → F13 欠账回写 + ADR 0006。终局收口：全量回归 + sim 冒烟 + WWRITING.md 十五回写。

提交纪律：沿用 Task/F# 前缀直接 master；每波独立可收口、可暂停（波间无未完成耦合）。

## 验收策略

- **每波收口**：`npm test` 全量绿（基线 1915，新增薄单测允许总数上涨；预期新增 ~8 个测试文件：journal-queries / journal-handlers / tools-registry / 各新模块薄测 / state 事件表对账 / view 分区薄测）+ 该波 prove-dead 清单 grep 清零。
- **对账断言**（防迁移漏 case）：journal 48 case ↔ handler 表键数；tools 注册 14 ↔ toolNames()；state 事件类型 ↔ handler 表键数；`FIXED_EVENT_TYPES` 全类型有 handler。
- **波B 视觉基线**：`node scripts/capture-all-ui.cjs --output artifacts/visual-acceptance/2026-08-2X-round15/round-01`，与 `artifacts/visual-acceptance/2026-08-23-round14/round-01` 逐图目检对比 + 用户抽查；差异仅允许出现在动效瞬时帧（F9），稳态像素必须一致。
- **终局收口**：`npm run sim:user-flow` 冒烟 + `npm test` 全量 + WWRITING.md 回写 + ADR 0006 落档 + 守卫三规则全绿（含 D6 例外登记）。
- **行数对账**：终态 `wc -l` 全部 src 文件落红线内（预期：runtime ~950 / journal ~1150 / journal-handlers ~980 / tools/index ~800 / view 壳 ~500 / 四分区各 ≤700 / settings-modal ~1300 唯一例外）。

## 风险与权衡

- **拆分本身是高风险动作**：三层防线（D4）+ 严格等价（D5）+ 每步一提交全量回归 + 每波可暂停。回归出问题时 git 定位到单提交，双向二分。
- **闭包状态显式化传参遗漏**：编译期不可查（无 TS），靠整壳契约测试覆盖行为面 + 新 seam 薄单测兜底；context 字段以实现时真实依赖为准，宁多传不猜。
- **handler 表迁移漏 case**：对账断言钉死（case 数/键数相等），这是 F3/F7 的验收红线而非建议。
- **gsap→CSS transition 手感差异**：token 等值映射 + reduced-motion 保留 + 视觉基线对比；若个别动效手感不可接受，回退为该动效保留 JS 补间（~50 行以内自写，不引库）。
- **journal 补投影索引的内存代价**：input/run 索引 Map 是会话内存态，随会话生命周期释放；相比现状每次全量扫事件（O(n) 读盘）是净优化。`ponytail:` 若超大会话（数万事件）内存吃紧，升级路径是把索引持久化为 session.json 投影字段（需破 D1 边界，届时单独立项）。
- **settings-modal 迁 form-kit 的 diff 控制**：只换表单构建函数内部实现，不动分区结构与事件绑定；F6 独立提交，回归失败可单独回退。
- **净删量预期**：gsap 5629 + failTool/常量/确认弹层/表单样板收敛 ~300，合计净删约 5,800-6,000 行；其余为平移。拆分新增的 import/工厂样板 ~200 行已在估计内。

---

## 执行记录（2026-08-23 回填）

- **终态**：`npm test` 1951/1951 全绿（基线 1915 + 36 个薄单测）；UI 三件套 `verify:app-clickability` / `verify:app-shell` / `verify:desktop-shell` 全部退出码 0；`sim:user-flow` 21/21 通过（mock 模式——真实 API 模式需 `DEEPSEEK_API_KEY` 环境变量，本机未配置，接入 key 后建议复跑一遍）。
- **行数对账**（R1 口径 split("\n") 终态）：runtime.mjs 1142 / journal.mjs 1183 / journal-handlers.mjs 1094 / tools/index.mjs 1032 / view.js 452 / timeline.mjs 546 / work-group.mjs 827 / cards.mjs 298 / composer.mjs 531 / settings-modal.js 1347（唯一例外，D6/D7）——其余全部 ≤1200。app.js 入口化后 1211 超线，按守卫红线回 Task 22 收整（注释/空白净化，c7e53b0，终态 1198）。
- **偏差记录**：
  1. `memory-extractor` 删除名不符实：`src/core/agent/memory-extractor.mjs` 在 git 历史中从未存在（Task 5 提交 ffbd5b8 未触任何 memory-extractor 文件）；实际共享纯函数单源是第九轮的 `src/core/memory-extractor.mjs`（`normalizeTimeField` 被 continuity-store、`normalizeMemoryUpdateArgs` 被 definitions-knowledge 消费），保留不动——「函数迁入 definitions-knowledge」落地为「definitions-knowledge import 共享模块」，非函数体搬迁。
  2. R3（Task 23）豁免口径适配：计划原样会对 `tests/agent/*`（内部 seam 测试，规则 A2 既有授权）与 `SURFACE_SEAM_TESTS`（前端分区单测名单）误报；落地豁免二者（属「包内测试」语义），与既有规则 A/A2/B/E 一致。
  3. Task 22 运行时接线回修（292a55e）：`createSettingsModal`/`createDrawerPanels` 契约是 `ctx.refs`（工厂内直接读 `ctx.refs.settingsScrim`/`ctx.refs.drawerBody`），首版把分桶对象裸传，bootApp 抛「undefined 属性读」导致页面完全不可用；缺陷由 `verify:app-clickability` 捕获（motion ready 超时），回修为 `{ refs: settingsRefs }`/`{ refs: drawerRefs }`。**教训：app-shell 单测与静态验证都不执行 app.js 模块——入口化/分桶类改动必须过 clickability，且截图基线须在修复后采集。**
  4. 视觉基线结论：round-15/round-01（refs 修复后重采）vs round-14/round-01 逐图像素对比——26 张完全一致（0 差异），其余差异均为动效中间帧（抽屉 scrim 渐变的亚像素偏移）、动态内容（光标闪烁、`ui-capture-<时间戳>` 演示路径、设置页动态计数、mockup 自播放演示停在异帧）——无稳态像素回归。
  5. Task 8 测试文件计划自相矛盾：文件清单列 `tests/agent/run-lifecycle.test.mjs`（新建），步骤却只有「跑既有测试」，执行依步骤未创建；2026-08-23 验收补齐薄单测（isAbort 三口径 + closeDroppedToolCalls 闭合形状）。
