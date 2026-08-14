# Bug 修复第 7 轮规格 v3：Agent 核心收敛与稳定性修复

> 日期：2026-08-12
> 基线：`master` at `a4cf8bb`
> 状态：已完成产品语义确认，可据此编写实施计划
> 取代：本文件 v1/v2 中的工作流继承、abort 式「立即」和 `input_cancelled + input_promoted` 技术方案

## 一、目标

本轮不是继续修补旧 Agent 的隐藏模式，而是把系统收敛成一个用户能够自然理解的 Agent：

1. 用户只选择权限强度（Ask / Trusted / YOLO），不管理“写章节模式”“初始化模式”等内部状态。
2. Agent 每次读取当前消息、对话上下文和项目文件，自主决定回答、读写、执行命令或使用章节专用工具。
3. 每条用户输入只有一个明确生命周期；排队、撤回、优先处理、完成和中断都可回放、可恢复。
4. “立即”不粗暴取消正在进行的模型请求或已开始工具，而是在当前步骤的安全边界切换到指定消息。
5. 工具超时由系统自动处理，用户不需要盯着窗口，也不新增取消弹窗或额外按钮。
6. 正文和项目数据继续由确定性守卫保护；提示词只负责行为引导，不伪装成安全边界。
7. 修复报告中仍存活的高收益 bug，并完成模型设置页高/中严重性问题。

## 二、第一性原则目标模型

### 2.1 必须长期成立的不变量

1. **一个 Agent，一套工具目录**：同一 Agent 既能写章节，也能回答普通问题；任务类型不是持久模式。
2. **权限与任务分离**：Ask / Trusted / YOLO 只决定授权策略，不决定哪些业务工具存在。
3. **一个状态真相源**：Journal 是输入、Run、工具、模型轮次和队列状态的唯一真相源；前端只做投影。
4. **一条输入一个生命周期**：每条输入从排队开始，随后要么开始执行并完成/中断，要么在执行前撤回。
5. **一个用户动作一条权威路径**：“立即”“取消”“停止”分别对应优先处理、撤回排队输入、硬停止 Run，三者不复用模糊语义。
6. **已完成副作用不回滚**：安全落盘的文本、已完成工具结果和文件修改保留；系统不尝试伪事务回滚整个 Agent 任务。
7. **未开始的动作可以跳过**：收到优先输入后，不再启动旧输入的新模型请求或新工具。
8. **存储不变量由代码保证**：路径边界、项目身份、校验和、原子写入、回滚和索引一致性不能只靠提示词。
9. **派生记忆可重建**：章节摘要和连续性记忆失败不得阻止正文提交；用户确认的长期事实与派生摘要职责分离。

### 2.2 保留、重塑、替换、删除

| 判断 | 内容 |
|---|---|
| 保留 | Ask / Trusted / YOLO 权限策略；Journal 追加式存储；章节专用工具；正文路径保护；原子文件写；上下文压缩；手动停止 Run |
| 重塑 | 输入事件生命周期；优先消息调度；工具执行期限；统一 Agent prompt；长期记忆职责；UI 队列投影 |
| 替换 | abort 式 `promote()` 替换为安全点优先调度；workflow 工具白名单替换为单一工具目录 + 工具自身领域校验 |
| 删除 | `general/chapter/init` 持久工作流；`enter_workflow`；`workflow_changed`；Run 的 `workflow` 字段；`commit_blueprint` 与 `blueprint_status`；旧聊天自动迁移；被打断输入回队重跑 |

采用**有边界的干净替换**：保留 Journal、Runtime、ToolRuntime 和前端投影的主体，但替换“工作流门禁”和“输入抢占”两个模型错误的子系统，不重写整个 Agent。

## 三、核心架构决策

### 3.1 删除隐藏的任务工作流

#### 现状问题

当前代码把任务类型建模为 `general/chapter/init` Run 状态：

- `src/core/agent/workflows.mjs` 决定不同工作流可见的深工具；
- `enter_workflow` 是切换入口；
- `run.workflow` 和 `workflow_changed` 进入 Journal；
- `prompt.mjs` 按 workflow 注入不同政策；
- 新 Run 又固定回到 `general`，导致写作上下文中断并产生 `tool_not_allowed`。

v2 的“继承上一 Run workflow”只能让这个隐藏模式更黏，不能解决概念错误。用户并不需要理解或操作这些模式；YOLO 也不等于 chapter，它只是权限强度。

#### 目标

1. 删除 `src/core/agent/workflows.mjs`。
2. 删除 `enter_workflow` 工具及其 schema、执行器、测试和脚本调用。
3. 停止产生 `workflow_changed`；新事件 schema 删除该事件类型。
4. `run_started` 不再携带 `workflow`，Run projection 不再存储 `workflow`。
5. `assemblePrompt` 不再接收 workflow；删除 `WORKFLOW_POLICIES`，改为一份统一的 Agent 任务政策。
6. Runtime 每轮向模型提供同一套生产工具：通用工具、`update_plan`、`append_chapter_segment`、`commit_chapter`；不再注册已退役的 `commit_blueprint`。
7. `append_chapter_segment`、`commit_chapter` 自己继续校验参数、项目身份、草稿、校验和和提交不变量。
8. `/init` 只是普通用户意图：Agent 读取项目并创建或更新 `WWRITING.md`，不是持久模式。
9. 章节相关动态上下文不再依赖 workflow 自动注入；Agent 根据 `WWRITING.md`、当前消息和文件事实按需读取。

#### 统一 prompt 必须包含

- 当前请求决定当前任务，不继承隐藏任务模式；
- 普通问题可以直接回答，文件任务按需读取和修改；
- 正式章节正文只能经 `append_chapter_segment` 写草稿，经 `commit_chapter` 提交；
- 不得用 `write_file`、`edit_file` 或 shell 绕过章节专用工具；
- 段号按顺序递增，禁止先写后段再补前段，完成前自查连续性；
- `WWRITING.md` 是长期项目事实入口，只有用户确认或文件可证的长期事实才能写入；
- 收到优先输入后，在当前模型请求或当前工具结束的安全边界停止旧输入，不启动新动作。

#### 切换策略

项目尚未发布，且用户已决定不保留旧聊天。本轮不为 workflow Journal 保留永久兼容层：启用新的 Agent 存储 generation，旧 generation 不导入、不展示、不进入模型上下文。项目正文、`WWRITING.md`、设置和技能不受影响。

### 3.2 重建输入生命周期

现有 `input_consumed` 同时表示“当前输入完成”和“队列输入开始”，`input_cancelled` 又被计划复用于撤回与被打断，语义不闭合。替换为以下事件：

| 事件 | 含义 |
|---|---|
| `input_queued` | 输入被系统接受，位于队列；尚未进入对话历史或模型 transcript |
| `input_started` | 输入离开队列，成为当前活动输入；此时进入用户可见对话历史和 transcript |
| `input_completed` | 活动输入正常完成 |
| `input_interrupted` | 活动输入在安全边界被优先消息截断；已完成输出与副作用保留，不自动重跑 |
| `input_withdrawn` | 排队输入被用户撤回；从用户和模型视角等同从未发送 |
| `priority_input_requested` | 用户要求某个排队输入在当前安全边界后优先开始 |

生命周期仅允许：

```text
queued -> started -> completed
queued -> started -> interrupted
queued -> withdrawn
```

约束：

1. 每条输入恰好一个终态：`completed`、`interrupted` 或 `withdrawn`。
2. `input_started` 是唯一把用户文本写入 transcript 的边界。
3. `input_queued` 只出现在“接下来”区域，不提前渲染为正式对话气泡。
4. `input_withdrawn` 保留不可见 Journal 事件以维持追加式重放，但 UI、模型历史和普通用户对话导出均不显示该输入；显式的原始 Journal/诊断导出可以保留撤回事件与文本，并必须标明这是运维审计数据，不是对话内容。
5. 撤回接口返回权威 `draft_text`。若 composer 已有文字，前端以换行追加撤回文本，绝不覆盖现有草稿。
6. 旧的 `input_consumed`、`input_cancelled`、`input_promoted` 在新 generation 中停止产生并从新 reducer 契约删除。
7. `/compact` 队列项也服从同一输入生命周期；压缩自身继续使用独立的 `context_compaction_*` 事件。

### 3.3 “立即”是安全点优先调度，不是 abort

#### 用户可见语义

假设 A 正在执行，B、C、D 位于“接下来”区域：

1. 用户点击 D 的“立即”，请求立即被接受，D 被标记为下一条处理。
2. 系统不取消 A 当前正在进行的模型请求，让本次模型返回完整结果。
3. 如果模型返回普通最终文本，A 正常完成，随后立即开始 D。
4. 如果模型返回尚未开始的工具调用，全部跳过，不启动工具，A 记为 `interrupted`，随后开始 D。
5. 如果点击时已有工具正在执行，只等待当前工具完成或自动超时；同一模型轮次剩余尚未开始的工具全部跳过，随后开始 D。
6. 如果点击发生在工具结果已完成、下一次模型请求尚未发出之间，不再发 A 的下一次模型请求，直接切换到 D。
7. B、C 保持原相对顺序。A 不回队、不重跑。
8. 第一次“立即”被接受后，其余“立即”暂时禁用；D 真正开始后恢复。后端同时以 `priority_pending` 409 防御并发请求。

#### Runtime 契约

1. `priority_input_requested` 只设置 `priority_input_id`，不立刻改写 `active_input_id`。
2. 不调用项目级 `abortController()`；当前模型请求使用原 signal 完成。
3. 在以下边界检查 `priority_input_id`：模型响应完成后、每个工具开始前、每个工具结束后、下一次模型调用前。
4. 模型返回 tool calls 后，先持久化 assistant tool-call 记录；被跳过的每个调用追加对应 tool result，错误码为 `tool_skipped_for_priority_input`，保证 provider history 结构完整。
5. 如果旧输入未自然完成，原子追加 `input_interrupted(A)` + `input_started(D)`，同时清空 `priority_input_id`。
6. 如果 A 已以普通文本自然完成，原子追加 `input_completed(A)` + `input_started(D)`，不伪造中断。
7. A 已安全产生的 assistant 文本、reasoning、已完成工具结果和文件副作用进入历史，D 的模型请求能够看到。
8. 只有实际被截断的执行组显示 `Interrupted by the user`；已经完整返回的 reasoning 仍显示正常完成，不把完整 reasoning 伪装成被中断。
9. 现有“停止”继续作为可选的硬停止逃生口，但“立即”流程不要求用户再点击停止，也不新增按钮或确认弹窗。
10. 重启恢复时若 Journal 中存在尚未清除的 `priority_input_id`，先把无对应终态的孤儿模型/工具执行闭合为恢复错误，不重放其副作用；只要当前已无真实飞行中的模型或工具，就在第一个恢复安全点原子写入旧输入终态与优先输入的 `input_started`，避免优先队列永久卡住。
11. `submit`、`requestPriority`、`withdrawInput`、带 `runId` 的 `stop` 和工具完成回调都必须经同一 session Runtime mutex 做“重读 Journal 投影 -> 校验 -> `appendBatch`”；HTTP 层不得自行用旧快照判定。这样 priority、撤回和停止的并发胜者由持久事件顺序决定，而不是由内存时序猜测。
12. 所谓“原子切换”指相关事件放进同一个 `Journal.appendBatch`，由现有连续 seq、落盘前 dry-run 和崩溃重放契约保证；不引入第二套事务存储。

### 3.4 工具执行期限与自动回收

用户不负责盯着卡住的工具。Runtime 统一拥有每个工具调用的生命周期：

1. 默认空闲期限为 5 分钟：连续 5 分钟没有任何可观察活动即超时。
2. 默认绝对期限为 60 分钟：即使持续产生零碎输出，单次工具调用也不能无限运行。
3. 工具定义可以声明更短的期限；不得自行取消系统绝对上限。测试可注入毫秒级期限。
4. shell 的活动包括 stdout、stderr 和受控进程状态；超时必须终止整棵进程树并等待资源释放。
5. 普通工具通过独立 `AbortSignal` 接收取消；所有内部长操作应在合理边界响应 signal。
6. 原子文件替换一旦进入最终提交区间则完整收尾，不允许留下半写文件；其前后的准备工作可取消。
7. 超时写入结构化 `tool_timeout` 结果，不直接杀死整个 Run：
   - 有待处理优先输入时，收敛旧工具和输入后开始优先输入；
   - 无优先输入时，把超时结果交回模型，由 Agent 决定恢复、换方案或报告失败。
8. 不新增超时弹窗、确认框或专用取消按钮。

当前基线已有 3 个 Windows shell 进程树测试失败，证明“终止后进程仍占用 cwd/继续写文件”。这不是环境噪声，必须在本轮批 1 修复并恢复绿色基线。

### 3.5 模型请求期限

1. Gateway 的 per-attempt `timeoutMs` 保持“空闲超时”语义，默认 5 分钟。
2. 每个 SSE 帧（含空 delta、usage-only 和 tool-call 参数帧）都刷新内部活动时间；该刷新不依赖 Runtime 额外注册一个空回调。
3. `onActivity` 仍可向上通知，但 Gateway 必须无条件安装自己的内部活动包装器。
4. 单次 `gateway.complete` 的默认总期限改为 6 小时，并保留 `modelConfig.total_deadline_ms` 覆盖。
5. 用户手动停止仍可提前取消模型请求；“立即”不取消当前模型请求。

### 3.6 项目记忆职责

| 数据 | 职责 | 是否权威 | 失败影响 |
|---|---|---|---|
| `WWRITING.md` | 用户确认或项目文件可证的长期要求、权威文件索引和当前阶段 | 是，长期入口 | 不应由普通章节提交随意改写 |
| `memory/book_summary.md` | 从已提交章节提取的可重建剧情摘要 | 否，派生数据 | 提取失败不阻止正文提交 |
| continuity 数据 | 人物、时间线和连续性事实的可重建投影 | 否，派生数据 | 可重试或重建 |
| 正式章节与索引 | 用户作品和提交事实 | 是 | 由确定性事务保护 |

`commit_chapter` 只负责正文、章节索引、项目身份、校验和、原子写入与回滚。章节提交后的独立记忆提取成功时更新 `book_summary.md` 和 continuity；失败只记录可恢复错误，不回滚正文。Prompt 删除“commit_chapter 已一致更新全书摘要”的虚假宣称。

### 3.7 Legacy 边界

用户已确认项目未发布，旧对话不保留、不导入、不提示：

1. 删除 `src/core/agent/legacy-import.mjs` 及调用、测试、脚本、marker 和死辅助代码。
2. 删除项目内 `.wwriting/agent` 到应用私有目录的旧 Agent Journal 自动复制路径，即停止调用并删除 `migrateProjectAgentStorage` 及其聊天迁移测试。
3. 删除 Journal 单体 `events.jsonl/transcript.jsonl` 到 segments 的自动聊天迁移；新 generation 只读取新格式。
4. 保留 `project.yaml -> WWRITING.md/settings` 的确定性项目资料迁移；它不导入聊天内容。
5. 保留技能 manifest 到 `SKILL.md` 的迁移；它与聊天历史无关。
6. 保留项目正文、总纲、设定、技能和设置；切换 generation 只影响 Agent 对话存储。
7. 删除 legacy 后，全库负向断言：生产代码和验证脚本不得再引用已退役聊天迁移入口。

### 3.8 退役旧蓝图事务

`commit_blueprint` 原本把 `OUTLINE.md`、`SETTING.md` 和 `project.yaml.blueprint_status` 绑定成一次旧初始化事务。现在 `/init` 已是普通意图，`WWRITING.md` 承担长期入口，代码中已没有生产流程消费这项事务或状态；继续隐藏保留只会制造第二套初始化模型。

1. 删除 `commit_blueprint` 的 schema、ToolRuntime 注册、Runtime wiring、work item 标签和提示词残留。
2. 删除 `src/core/project-operations/blueprint.mjs` 及其专属测试；同步移除 `chapter.mjs` 中只为识别该旧工具输出而存在的模式。
3. 从 `project.yaml` 的新项目默认值和运行时领域模型中删除 `blueprint_status`，不再推断、迁移或更新该运行态字段。
4. 旧项目中已存在的 `blueprint_status` 不参与任何决策；确定性 `project.yaml -> WWRITING.md/settings` 迁移明确忽略它。若现有 YAML 保存器会保留未知字段，可以原样留存而不专门重写用户文件，但生产代码不得读取它。
5. `OUTLINE.md` 与 `SETTING.md` 保留为普通、权威的项目文件，由 Agent 按用户意图通过通用文件工具创建或修改；它们不再依赖“蓝图完成”状态才可使用。
6. 删除仅用于证明旧工具“被拒绝”或迁移 `blueprint_status` 的测试、夹具和验证脚本，改为负向断言生产工具目录和运行态均不存在这些概念。

### 3.9 正文保护与已接受风险

1. `write_file` / `edit_file` 对 `chapters/`、`drafts/` 的确定性保护继续保留。
2. 章节专用工具始终可见，但只能按自身 schema 和领域校验执行。
3. shell 静态解析无法可靠覆盖 `cd` 链、变量、脚本和外部程序；本轮不新增启发式目标扫描。
4. 因此 YOLO shell 仍可能绕过正文保护或写到项目外。这是**未修复的高风险能力边界**，只以 prompt 纪律降低概率，不得在报告中写成安全保证。
5. 段号乱序只以 prompt 和模型自查防御；系统不加连续性门禁，作为明确接受的残留风险记录。

## 四、修复范围

### 4.1 核心替换项

| 编号 | 项目 | 处理 |
|---|---|---|
| C1 | 隐藏 workflow 门禁 | 删除 `general/chapter/init`、`enter_workflow`、workflow prompt/Journal/工具过滤 |
| C2 | 输入生命周期歧义 | 用 queued/started/completed/interrupted/withdrawn 替换 consumed/cancelled/promoted 复用 |
| C3 | “立即”错误 abort | 改为当前模型/工具结束后的安全点优先调度 |
| C4 | 单条撤回 | 新增 `withdrawInput` Runtime API、HTTP route、前端回填与不可见投影 |
| C5 | 工具卡死依赖用户 | 统一 5 分钟空闲 + 60 分钟绝对期限，shell 终止进程树 |
| C6 | 旧聊天兼容层 | 新 storage generation，删除全部聊天自动迁移 |
| C7 | 记忆职责混乱 | 正文提交与派生摘要解耦，明确四类数据职责 |
| C8 | 旧蓝图事务残留 | 删除 `commit_blueprint`、`blueprint_status`、blueprint 模块与仅为其存在的迁移/测试 |

### 4.2 原报告 A 组（24 项，全部保留）

| # | 项 | 修复口径 |
|---|---|---|
| 1 | B1 reveal-path IPC 安全边界 | reveal 类 IPC 统一使用 `validateProjectRoot()` 白名单 |
| 2 | B2 “全书摘要”零接线 | 按 3.6 修正职责与 prompt，不伪造 commit 保证 |
| 3 | B4 纯工具流空闲超时 | Gateway 无条件接入内部 `onActivity` 刷新，覆盖所有 SSE 帧 |
| 4 | B7 openReader 无响应守卫 | await 后校验项目 scope 和 `readerChapterNo` |
| 5 | B9 app-state 非原子覆写 | `writeFileAtomic` + `recordRecentProject` 串行化 |
| 6 | B10 project-lock tails 清理 | 用派生 promise 正确删除；通过可实例化 registry seam 测试，不暴露生产诊断 API |
| 7 | B12 设置分区无守卫异步 | await 续作校验当前分区 generation |
| 8 | B13 session-sidebar 泄漏 | 移除项目时清理 cache、DOM 引用和监听；用实例 seam 观测 |
| 9 | B15 stop 路由 TOCTOU | `agent.stop` 接收并原子校验 `runId`，HTTP 不做快照后再停止 |
| 10 | B17 退出 server.close 无超时 | 抽 `closeServerGracefully`，超时后 `closeAllConnections` |
| 11 | B18 runSave finally 覆盖按钮 | 分区 generation/save sequence 条件化收尾 |
| 12 | R5-1 legacy 重复导入 | 按 3.7 删除全部旧聊天迁移 |
| 13 | R5-2 ZIP 多顶层误拒 | 仅忽略白名单元数据项（`__MACOSX`、`.DS_Store`、顶层 README）；多个真实技能根仍拒绝 |
| 14 | R5-3 TextDecoder flush | 两处无参 `decode()` 冲刷；不完整尾字节产生 U+FFFD 视为“不静默丢字节”的接受行为 |
| 15 | R5-5 截断工具参数 | tool-call 级完整性标记；截断参数以 `truncated_args_rejected` 拒绝，普通截断文本保留并提示 |
| 16 | R5-7 `needs_history_clear` | snapshot 透出；前端显示“此对话已损坏”并禁发；后端 submit 同时拒绝 |
| 17 | R5-8 research `sources.md` | 先实证 ENOENT 来源，再确保父目录和文件存在 |
| 18 | R5-9 Enter 绕过压缩门禁 | keydown 与按钮共用同一 `canSubmit` 判定 |
| 19 | R5-10 write_file 类型校验 | content/replace 复用 `requireStringArg` |
| 20 | R5-11 技能名大小写绕过 | Windows 下名称比较统一大小写归一 |
| 21 | R5-12 onRunTerminal 快照缺失 | 终态刷新 Agent snapshot 与 dashboard |
| 22 | R5-13 技能 marker 缺项目维度 | marker key 使用 canonical projectRoot 的稳定 hash |
| 23 | R5-14 execute 异常杀死 Run | 工具错误转结构化结果；Journal 写失败保持致命；未执行调用全部闭合 |
| 24 | R5-15 shell 输出截断不对称 | delta 与终态统一携带 `content_length` 和截断元数据 |

第 3 轮已修复的项目切换守卫、失败回填 generation 和 IME composing 守卫继续移出本轮，仅在报告中标记已修复。

### 4.3 模型设置与 UI 高/中项

以下探索项仍纳入第 7 轮：

1. 设置页缺失 CSS、模型行横向溢出。
2. 设置页焦点陷阱、ARIA、键盘操作和窄窗口 popover 边界。
3. 密钥框显示“已配置”状态，不回显密钥。
4. 成本统一人民币“元”，保留两位小数。
5. 非法/空值不得在失焦保存时静默丢弃。
6. 会话重命名移除 `window.prompt`，使用应用内可访问编辑控件。
7. Run 终态刷新顶栏进度、章节抽屉、成本面板和 dashboard。
8. 测试连接/拉取模型先提交并验证当前表单值，不读取陈旧保存值。
9. 设置关闭时如有未保存修改，使用现有确认机制阻止静默丢失。
10. 模型、权限、思考强度切换失败显示 toast，不静默回退。
11. 保存提示与真实交互一致：支持 Enter 就实现 Enter，否则删除错误提示。
12. v1 -> v2 provider 首次并发迁移使用单一锁和确定性 ID，避免双迁移悬空引用。
13. `POST /api/settings/update` 不再接受后静默丢弃 `active_model`；删除旧入口或正确转发到新引用模型接口，二选一且全库唯一。
14. 密钥输入增加“使用环境变量名”显式开关，默认关闭；关闭时一律按明文密钥处理。
15. 英文技术错误改为中文，不新增“打开模型设置”按钮。

低严重性候选仍不排期：顶栏隐藏副标题死代码、toast 图标、切会话草稿、窄视口侧栏、阅读模式窄窗、设置路径换行、加载态、供应商输入宽度、侧栏移除确认、归档 composer、当前项目高亮、禁用协议说明、clearGrants 无界增长、addProvider 半成品、分离结果节点、损坏 store 写侧毒化等。

### 4.4 明确保持现状的已知项

以下项目已被审计，但不应被实现者当成“漏修”。它们不改变本轮的核心状态模型，或需要独立的产品授权边界；`find-bugs-report.md` 中仍保留证据和后续入口。

| 项目 | 本轮决定 | 原因与边界 |
|---|---|---|
| B8 shell 可写项目外 | 保持现状 | 可靠覆盖 shell 重定向、脚本和子进程需要真实沙箱；本轮只诚实保留 YOLO 高风险边界，不用启发式解析伪装保护。 |
| B11 `output_style` 死设置 | 保持现状 | 这是旧设置/文档清理议题，不应混入 Agent 执行内核替换；实际风格机制仍是写作风格技能。 |
| B16 非流式无真实活动信号 | 保持现状 | 非流式 provider 不提供中途事件，Gateway 只能使用总期限或人工 heartbeat，不能把它误称为真实进展；本轮 6 小时总期限降低误杀但不消除可观测性缺口。 |
| R5-4 shell 联网权限提示面 | 保持现状 | shell 网络能力的授权模型需与权限产品设计一起重做；research 工具硬拦截保持不变。 |
| R5-6 `NON_PROSE_PATTERNS` 误伤 | 保持现状 | 属明确接受的章节工具内容过滤取舍，另行评估是否完全删除该过滤。 |
| R5-17 composer 草稿死代码 | 保持现状 | 当前“不跨会话/项目保留未发送草稿”是被测试钉住的产品行为；死模块清理可单独进行。 |
| R5-18 非法 `SKILL.md` 遮蔽旧 manifest | 保持现状 | 现行原则不自动覆盖用户已存在的文件；修复需要先确定是否允许自动修复损坏用户文件。 |
| M3/M4 成本定价展示链 | 保持现状 | 官方定价与成本面板接线已另有模型配置范围，本轮不扩大到成本产品功能。 |

### 4.5 工作计时显示

`formatDuration(ms)` 统一服务运行态和终态：

- `0-59 秒`：`N 秒`
- `1-59 分`：`N 分 M 秒`
- `>= 1 小时`：`N 小时 M 分 S 秒`
- 不省略尾零，例如 `1 分 0 秒`、`1 小时 0 分 0 秒`
- 继续使用现有每秒刷新机制

先改写 `tests/app-shell/agent/work-items.test.mjs` 中旧断言并确认红，再实现格式函数。

## 五、文件边界

实施计划至少覆盖以下所有权边界，具体行号以计划编写时的代码为准：

| 子系统 | 主要文件 | 责任 |
|---|---|---|
| Agent prompt | `src/core/agent/prompt.mjs` | 单一任务政策、记忆职责、章节工具纪律 |
| Workflow/蓝图退役 | `src/core/agent/workflows.mjs`、`src/core/agent/tools.mjs`、`src/core/project-operations/blueprint.mjs`、`src/core/project-store.mjs` | 删除 workflow、蓝图工具与 `blueprint_status`，保留普通总纲/设定文件 |
| 输入与调度 | `src/core/agent/runtime.mjs`、`src/core/agent/journal.mjs` | 新输入事件、优先安全点、Run 收敛 |
| 公共 API | `src/core/agent/index.mjs`、`src/core/http/agent-routes.mjs` | `withdrawInput`、带 runId 的 stop、错误码映射 |
| 前端投影 | `src/app-shell/agent/state.js`、`view.js`、`api.js`、`work-items.mjs` | “接下来”区域、立即/取消、草稿回填、计时、终态文案 |
| 工具期限 | `src/core/agent/tools.mjs`、`src/core/shell/*` | 独立 signal、活动时钟、绝对期限、Windows 进程树回收 |
| 模型期限 | `src/core/model/gateway.mjs`、`openai-compatible.mjs` | SSE 活动、6 小时总期限、截断信号 |
| Legacy 删除 | `src/core/agent/legacy-import.mjs`、`src/core/workspaces/migration.mjs`、相关调用方 | 删除所有聊天迁移，保留项目资料迁移 |
| 记忆 | `src/core/project-operations/chapter.mjs`、相关 maintenance 路径 | 正文提交与派生记忆解耦 |
| 桌面与状态 | `src/desktop/electron-main.cjs`、`src/core/app-state.mjs` | reveal 边界、优雅关闭、原子近期项目状态 |
| 设置页 | `src/app-shell/model-settings-page.js`、`settings-modal.js`、CSS、settings routes/store | 高/中 UI、保存、迁移和密钥语义 |

删除生产概念时同步删除或改写：`tests/agent/workflows.test.mjs`、prompt/tools/runtime/journal/acceptance 测试、`scripts/verify-unified-agent.mjs`、benchmark/measure 脚本和架构负向测试。不能只让旧测试“宽松通过”。

## 六、验收矩阵

### 6.1 架构负向验收

全库生产代码和生产验证脚本不得再出现：

- `enter_workflow`
- `workflow_changed`
- `WORKFLOW_POLICIES`
- `WORKFLOW_POLICY_RECORDS`
- `allowedDeepTools`
- 新 `run_started.payload.workflow`
- `runLegacyImport`
- `migrateProjectAgentStorage`
- `commit_blueprint`
- `blueprint_status` 的生产读取、写入或新项目默认值

旧聊天 generation 不出现在会话列表、snapshot、SSE、历史导出或模型上下文。

### 6.2 Agent 行为验收

1. 同一会话先正式写章节、再问普通问题，无模式切换工具、无 `tool_not_allowed`，两者都能完成。
2. 普通请求能直接使用通用工具；章节请求能直接使用章节专用工具。
3. `write_file`、`edit_file` 仍不能写受保护正文路径。
4. A 运行时 B/C/D 排队，D 点“立即”后：当前模型请求完整返回，未开始工具不执行，D 下一条开始，B/C 顺序不变。
5. 工具执行中点“立即”：当前工具完成或超时，剩余工具不启动，随后开始优先输入。
6. 实际被截断的 A 终态为 `input_interrupted`，不回队、不自动重跑；已完成文本和工具结果进入 D 的上下文。
7. A 已自然返回最终文本时终态为 `input_completed`，不得错误显示 interrupted。
8. 优先请求 pending 时第二次“立即”后端返回 409，前端按钮禁用；第一条优先输入开始后恢复。
9. 撤回排队消息后，“接下来”区域消失该项，正式历史和模型 transcript 从未包含它，composer 追加撤回文本且不覆盖现有草稿。
10. stop 与 priority、submit、withdraw 并发时，每条输入仍恰好一个终态，Run 也只有一个终态。
11. 崩溃重放后 `priority_input_id`、队列和活动输入一致，不重复执行已完成工具。
12. `commit_blueprint` 不在工具目录、提示词、运行态或生产验证脚本中；新建项目没有 `blueprint_status`，既有字段不会驱动行为。

### 6.3 超时验收

1. 可注入时钟下，工具 5 分钟无活动产生 `tool_timeout`。
2. 持续输出的工具在 60 分钟绝对期限仍被回收。
3. Windows shell 超时/停止后，子进程不再写文件，cwd 可立即删除，无残留 handle。
4. 原子文件提交在最终 rename 区间不被截成半文件。
5. 工具超时但无优先输入时，模型收到结构化错误并可继续 Run。
6. 纯 tool-call SSE 帧持续刷新 Gateway 空闲时钟，不被误杀。

### 6.4 记忆与 Legacy 验收

1. `commit_chapter` 成功不依赖摘要提取成功。
2. 提取失败后正文与索引保持成功，维护任务可重建 `book_summary.md` 和 continuity。
3. `WWRITING.md` 不被普通章节摘要自动污染。
4. 旧 flat-file、项目内旧 Agent Journal 和旧单体 Journal 均不导入。
5. `project.yaml` 的确定性项目事实和设置仍可迁入 `WWRITING.md/settings`。

### 6.5 UI 与真实渲染验收

DOM mock 负责状态和交互；它不能代替视觉与 Electron 行为验收。本轮还必须：

1. 在 1280x800、768x900、390x844 检查模型设置页、队列区域和 context popover，无横向溢出或文字重叠。
2. 检查键盘焦点顺序、焦点陷阱、Escape 关闭和屏幕阅读器名称。
3. 用 Electron smoke 验证会话重命名不依赖 `window.prompt`。
4. 检查密钥已配置状态不泄漏明文。
5. 保存截图或审计产物到现有 `artifacts/visual-acceptance` 结构。

### 6.6 测试基线

2026-08-12 实测 `npm test`：1624 项中 1621 通过、3 项失败，均指向 Windows shell 进程树未完全终止。实施开始先以这 3 项建立红色基线，批 1 结束必须全绿；最终不得沿用文档旧称的“当前 1624/1624”。

最终验证至少包括：

```text
npm test
npm run verify:unified-agent
npm run verify:app-shell
```

涉及 Electron 的项再运行对应 smoke；测试数量允许随删除旧 workflow 测试和新增回归测试变化，因此验收以“0 fail”而非固定总数为准。

## 七、执行顺序

### 批 1：恢复执行内核可信度

1. 修复 Windows shell 进程树终止和 cwd 释放，恢复绿色基线。
2. 引入统一工具期限与 `tool_timeout`。
3. R5-14 工具异常收敛。
4. B4 Gateway 活动时钟和 6 小时总期限。
5. R5-5 工具参数截断拒绝。

### 批 2：删除旧工作流并切换输入状态机

1. 新 Agent storage generation，停止旧聊天迁移。
2. 删除 workflow 模块、工具、prompt 层、Journal 字段和工具过滤。
3. 同时删除旧蓝图事务、`blueprint_status` 运行态与专属迁移；`OUTLINE.md`、`SETTING.md` 改为普通项目文件。
4. 引入新输入生命周期事件及 reducer。
5. 实现安全点优先调度、单条撤回和并发收敛。
6. 改写前端 queue/conversation 投影和 work item 终态。
7. 更新 acceptance、脚本和架构负向测试。

这一批必须作为一个原子子系统实施和评审，不能把 Journal、Runtime、HTTP 和前端分别交付成长期不一致状态。

### 批 3：记忆、Legacy 清理与高收益 bug

1. 完成所有旧聊天迁移代码、marker、测试夹具和脚本删除。
2. 明确 `WWRITING.md` / book summary / continuity 职责并修正文案。
3. B1、B7、B9、B10、B13、B15、B17 和 R5-2/3/7/8/9/10/11/12/13/15。

### 批 4：设置页、UI 和计时

1. 模型设置页全部高/中项。
2. 设置保存与 provider 并发迁移。
3. 工作计时格式。
4. DOM、真实 viewport 和 Electron smoke 验收。

每一批单独形成可测试的稳定提交；后批失败不得迫使前批以半成品状态存在。完成后更新 `find-bugs-report.md` 第 7 节：区分“已修复”“已删除旧概念”“明确接受的风险”，不得把 prompt 纪律描述成确定性保护。

## 八、明确不做

1. 不新增用户可见任务模式选择器。
2. 不为写章节、审稿、初始化等每类任务创建持久 workflow。
3. 不新增“工具卡住了怎么办”的按钮、弹窗或确认步骤。
4. 不实现整次 Agent 任务的文件副作用回滚。
5. 不用启发式 shell 命令解析冒充完整沙箱。
6. 不给段号增加强制连续性门禁。
7. 不保留旧聊天兼容层或迁移提示。
8. 不以固定测试数量代替零失败和行为验收。
