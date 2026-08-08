# WWriting 统一 Journal、上下文窗口与自动压缩规格草案

> 状态：需求已确认，作为下一轮实施计划的规格基线。本轮只记录产品需求、提示词和验收合同，不修改核心代码。
> 范围：下一阶段统一规格中的 Journal 事件记录、模型上下文窗口识别与显示、自动压缩、压缩状态动效、运行态动效和已知对话 UI 缺陷。模型配置 UX 已由用户明确延期，不进入本轮实施计划。

## 1. 已确认目标

可靠性优先：完整 Journal 负责恢复与审计；模型上下文只保留当前轮继续执行所需的信息；上下文接近窗口上限时自动压缩，且过程在对话中可见。

## 2. Journal 与上下文的边界

- Journal 是追加式事件真相源，记录用户消息、Assistant 正文、reasoning 生命周期、工具活动与结果、任务计划、错误、取消、重试、恢复及恢复时间线元数据。
- 自动压缩不得删除原始 Journal 事件。压缩只创建新的派生上下文检查点，并记录来源事件范围和压缩结果。
- 原始 Journal 默认长期保留，不按天数或文件大小自动删除。用户可以主动清空某个工作区的对话历史；执行前必须明确提示不可恢复并提供可选导出入口，但不强制先导出。清理对话不得删除或改写创作文件、`WWRITING.md`、总纲、设定和章节。
- 首版以单工作区至少 `1,000,000` 个事件或 `2 GiB` Journal 为容量验收规模。打开工作区后应在验收环境中 `2s` 内显示最近对话，旧历史在后台索引并随滚动按需加载；不得为显示首屏把整个 Journal 读入内存。清空历史后创建新的 Session，创作文件保持不变。
- 崩溃导致的末尾半行可以自动丢弃；派生索引损坏时从 Journal 分段自动重建；某个中间分段损坏时隔离该段并在时间线显示历史缺口，但仍允许查看损坏点前后的完整分段，不能因此使整个工作区无法打开。
- `WWRITING.md`、总纲、设定和其他权威创作文件是耐久项目知识。压缩后按需重新读取，不能只依赖模型生成的摘要。
- transcript/历史消息是模型上下文输入；旧历史可以被结构化摘要替代，但最近交互、未闭合 tool-call 链和未解决 decision 必须受到保护。

## 3. 模型 ID 与窗口识别

### 3.1 本地标记

- 解析模型 ID 尾部连续的 `[...]` 段；其中任一段内容精确为 `1m` 或 `1M` 时，表示有效上下文窗口为 `1,000,000` tokens。当前不接受其他大小写或带空格写法。
- 没有该标记时，默认有效窗口为 `256,000` tokens。
- 其他末尾中括号标记（如 `[128k]`、`[foo]`）目前不解释其含义，但应从发送给供应商的模型 ID 中剥离。
- 连续标记全部剥离：`model[1m][1m]` 的传输名必须是 `model`；不能把任何 `[1m]` 字符发送到模型端。
- 模型配置列表可保留作者输入的原始显示字符串；模型请求、供应商能力判断和内部传输均使用剥离后的基础 ID。
- 中间位置的中括号不属于本轮处理范围；只处理模型 ID 尾部连续的 `[...]` 段。

### 3.2 不做的事情

- 不增加上下文窗口的手工配置字段或设置界面。
- 不维护已知模型能力表。
- 不把供应商 `/models` 元数据当成必需能力；后续如接入，只能作为非阻断提示来源。
- 当前只在 `256k` 与 `1M` 两档之间选择，其他窗口扩展另立需求。

### 3.3 统一字段语义

当前代码的 `max_context_tokens` 校验字段与 Prompt 装配使用的 `context_window` 不一致。下一轮计划必须先定义唯一的内部 `effective_context_window`，并在所有预算、快照、圆环和压缩事件中使用同一数值。

## 4. 上下文圆环与压缩阈值

- 对话框运行态区域增加一个始终显示的圆环符号；项目打开后即出现，不只在 running 或接近阈值时出现，也不新增常驻文字面板。
- 圆环实时反映当前模型请求的估算输入上下文占用；悬停、键盘聚焦或点击圆环时显示锚定在圆环旁的轻量 popover。再次点击、点击外部或按 ESC 关闭；点击打开后应保持显示，便于用户移动鼠标阅读。
- popover 显示：已用 tokens、有效窗口、占比、窗口来源（默认 `256k` 或 ID 标记 `1M`）。
- popover 从圆环位置出现，使用短促 opacity + 轻微 scale/translate 过渡，不瞬间闪现、不弹跳、不改变周围布局；建议 120–180ms、无 overshoot。关闭沿同一路径返回。`prefers-reduced-motion` 下只保留短促淡入淡出或静态切换。
- 圆环空闲时静态；只有真实 running/压缩进行中时出现轻微状态过渡或活性反馈，不使用长期旋转、呼吸或花哨循环动画。
- 圆环分母是 `effective_context_window`；模型 system prompt、项目记忆、动态上下文、历史、工具定义、当前输入和协议开销计入分子。
- 发送前必须能在本地按实际待发送载荷估算占用，不能依赖供应商先返回 usage。供应商提供 usage 时用于校准后续估算；没有 usage 或没有对应 tokenizer 时采用带安全余量的统一估算，并在 popover 数值前显示 `约`，不得伪装为精确计数。
- 项目刚打开且尚未完成首次装配时，圆环仍显示窗口上限，已用量显示 `计算中` 或 `待校准`，不能用 `0` 冒充真实占用。
- 输出预留不伪装成已用输入，但压缩预算必须为输出和工具参数保留安全空间。
- 压缩阈值在用户点击发送时统一预检，先计算 `estimated_input = 当前 active context + 待发送内容 + 必须重注入内容`。满足任一条件时先压缩：`estimated_input >= 产品压缩点`，或 `estimated_input + 32,000 tokens 输出安全余量 >= effective_context_window`。压缩成功后再发送本条消息。模型切换本身不设置“需要压缩”状态，也不立即调用压缩模型。
- `256k` 档发送前压缩阈值固定为 `204,800` tokens（窗口的 `80%`）。
- `1M` 档采用当前调研中可核验的 Claude Code Sonnet 5 默认值，发送前压缩阈值固定为约 `967,000` tokens；不得把曾被讨论但未成为当前默认的 `400k` 写成竞品既定做法。
- 阈值是产品默认值，不在设置页暴露手工配置。圆环分母仍是完整的 `effective_context_window`，不得把 `967k` 压缩点伪装成 `1M` 窗口上限。
- 压缩后的 active context 目标为有效窗口约 `25%` 以下，但语义完整性优先；若为了保留未完成任务、关键决定或未闭合工具状态而略高于目标，只要仍显著低于触发阈值即可提交，不得为了命中百分比删除关键恢复信息。
- Journal 文件大小只用于分段/存储告警，不直接决定模型上下文压缩。
- 一个长 Run 内每次准备继续请求模型前也执行同一容量预检。若多轮模型调用或工具结果使预计占用达到阈值，则在当前工具链闭合或原子文件操作完成后的安全点启动同样可见的自动压缩；这是“通常等下一次用户发送”的防溢出例外，不能并发启动第二个 Run。

### 4.1 压缩后的显示与保留

- 自动压缩只替换模型下一轮使用的 active context，不删除或重写用户可见的原始对话时间线。
- 压缩后圆环立即按新的 active context 重新计算占用；较早的用户消息、Assistant 正文、工具活动和压缩事件仍保留在上方，可滚动回看。
- 完成事件主文案只显示 `已压缩完成`，不在对话中展示压缩前后 token、释放量、模型和耗时等详细数据；这些字段只保留在 Journal 元数据和诊断/验收接口中。
- 新 active context 至少由以下层组成：稳定系统与运行时政策重新注入、`WWRITING.md` 及权威项目知识重新装载、结构化压缩摘要、最近 `12` 轮用户/Assistant 原文、未完成任务与待确认事项、未闭合工具状态，以及必要的可重载文件引用。原始 Journal 不因这些派生层而裁剪。
- 一轮定义为一条用户输入及其对应的 Assistant 最终正文。最近 `12` 轮的对话正文优先保留原文；已经闭合的大型工具输出只保留摘要和 Journal 引用，未闭合工具状态完整保留。若 12 轮正文自身仍超过压缩目标，则从较早轮开始纳入结构化摘要，但至少保留最新 `2` 轮原文。

## 5. 自动压缩事件状态机

同一次压缩必须在 Journal 和对话时间线中形成一个完整事件，不得静默发生：

```text
context_compaction_started
  -> context_compaction_running
  -> context_compaction_completed
                       \-> context_compaction_failed
                       \-> context_compaction_cancelled
```

### 5.1 文案顶替

- 开始阶段显示带文字动效的 `开始压缩`。
- 进入运行阶段后，原文字被同一位置的 `压缩进行中` 顶替，不同时显示两条。
- 完成阶段，`已压缩完成` 顶替 `压缩进行中`；对话中不展开 token、释放量或模型等详细数据。
- 失败阶段显示 `压缩失败` 和 `重试` 操作；发送按钮保持禁用，直到重试成功或用户明确取消/恢复到可用上下文。
- ESC 可以取消进行中的压缩。按下后先用同一位置的 `正在取消` 顶替 `压缩进行中`，发送继续禁用；只有底层请求确认终止、未完成摘要已丢弃且压缩前 checkpoint 校验仍有效后，才显示 `已取消` 并恢复发送。
- 压缩期间用户输入的文字不得丢失；取消完成后恢复到输入框，但不得自动发送。
- 取消完成后的发送策略按触发来源区分：
  - **自动压缩被取消**：恢复发送按钮。用户下一次点击发送时，不直接调用普通模型 turn，而是先重新触发自动压缩；本次消息暂存在本地待发送区，压缩成功后才发送。若再次取消，消息保留在输入框/待发送区，不自动发送。
  - **手动 `/compact` 被取消**：恢复正常发送，不设置“下一次必须压缩”的额外锁。下一次发送只有在上下文届时达到自动压缩阈值时，才按普通自动压缩规则处理。

### 5.2 ESC 键盘中断合同

当前实现没有把 ESC 接到 Agent Run：ESC 只负责关闭快捷键弹层、阅读器、设置、新建窗口、抽屉、composer 菜单和斜杠菜单；停止 Run 的能力只存在于“停止”按钮及其 stop API。下一轮必须补齐统一的 ESC 路由。

ESC 按以下优先级只执行一项动作，不能一次按键同时关闭界面并停止任务：

1. 有模态框、抽屉、菜单或斜杠菜单打开时，关闭最上层界面，不影响 Run。
2. 没有上层界面且正在压缩时，请求取消本次压缩；立即进入 `正在取消`，发送仍禁用。确认底层终止且旧 checkpoint 有效后，丢弃未完成摘要、记录 `context_compaction_cancelled`、显示 `已取消` 并恢复发送；后续是否在下一次发送前强制重压缩，由本次压缩的自动/手动触发来源决定。
3. 没有上层界面、没有压缩且当前 Run 活动时，ESC 等价于当前“停止”动作：进入 `正在停止`，在安全点取消当前模型/工具操作，最终收敛为 `已停止`。
4. 空闲态按 ESC 不产生事件、不显示 Toast。

键盘中断必须复用现有 stop/AbortSignal/进程树终止链路，不能创建第二套取消协议。按键后立即防重复触发；只有停止失败或 Run 恢复活动后才重新允许触发。进行中的原子文件提交仍必须完整结束，不能留下半写文件。

### 5.3 事件元数据

完成或失败事件应记录：触发原因（阈值/用户命令）、原始事件 seq 范围、压缩使用的模型基础 ID、压缩前估算占用、压缩后占用、释放量、摘要版本、耗时、错误/取消原因和结果校验信息。敏感内容按既有脱敏规则处理。

### 5.4 自动重试与熔断

- 一次自动压缩首次失败后，只允许再自动重试一次，即最多 2 次模型请求。
- 自动重试只处理网络中断、超时、429/5xx 等瞬时错误；结构校验失败、候选摘要丢失关键状态或持久化失败不盲目重复同一请求，直接进入失败状态。
- 第二次仍失败时熔断：显示 `压缩失败` 和 `重试`，禁用普通发送；之后只有用户主动点击重试才再次调用模型。
- 熔断后的失败状态同时提供 `取消`。取消不采用失败候选摘要；确认旧 checkpoint 仍有效后恢复输入。若失败源自自动压缩，下一次发送仍重新进入自动压缩门禁；若源自手动 `/compact`，恢复普通发送规则。
- 用户手动重试属于新的压缩 attempt，不计入上一 attempt 的自动重试次数。

### 5.5 `/compact` 排队语义

- 首版只识别精确的 `/compact`，不支持附带“重点保留什么”等自由参数。
- 若没有早于受保护近期原文的可压缩历史，则不调用模型，在时间线显示 `无需压缩`。
- 当前 Run 活动时输入 `/compact`，不立即打断模型或工具操作，按普通消息一样进入队列并显示排队状态。
- 到达可取消操作或原子提交之后的安全点时，消费该队列项并启动手动压缩。
- `/compact` 队列项可以使用既有“立即”动作；若用户选择“立即”，先按现有中断协议安全打断当前轮，再执行手动压缩，不创建第二个并发 Run。
- 同一队列中存在多个 `/compact` 时，在第一个压缩成功后取消其余重复压缩项，避免连续无意义压缩。

## 6. 结构化压缩提示词草案

压缩调用默认使用当前正在使用的模型；压缩调用不执行工具，不写创作文件，只根据运行时提供的事件、历史和项目耐久知识生成新的上下文检查点。

压缩恢复必须遵守既有 `PromptAssembler` 分层纪律：Static Core、Runtime Policy、Project Instructions 和当前 Workflow Policy 由各自权威来源重新装配，不交给摘要模型改写；模型只生成早期 History 的结构化替代物。压缩结果随后与最近 `12` 轮原文、未闭合工具状态和按需重载的 Dynamic Context 组合，不能把所有层混成一段不可追溯的自由文本。

这里的“单次模型调用”准确语义是：一次压缩只有一个逻辑模型 turn，只产生一份候选摘要，不允许模型在压缩过程中调用工具或开始第二个 Agent 任务。网络超时、429/5xx 等瞬时传输错误可以沿用模型网关的有限重试，但这些重试仍属于同一个压缩 attempt；不能产生多个相互竞争的候选摘要，也不能无限重试。

“失败不覆盖旧上下文”采用候选摘要 + 原子提交：压缩开始时记录旧 `source_checkpoint_id`，新摘要先写入临时候选；只有模型完整结束、JSON/schema 校验通过、关键恢复字段未丢失、token 降到目标范围且 checkpoint 持久化成功后，才追加提交事件并把 active context 指针一次性切到新 checkpoint。模型失败、取消、输出半截、JSON 无效、摘要过长或持久化失败时，候选摘要作废，active context 始终保持指向旧 checkpoint；原始 Journal 事件从不删除。

```text
你正在为 WWriting 生成一个可恢复的上下文压缩检查点。

只依据输入材料中的可验证事实，不补造事实，不把模型猜测写成决定。
不要输出或重建私有 reasoning、思维链或隐藏分析；不要复制大段工具原文。
保留当前任务继续执行所必需的信息，并标明哪些内容已被省略、哪些信息需要重新读取文件确认。

请严格输出 JSON，不要输出 Markdown、解释文字或代码围栏：
{
  "schema_version": 1,
  "current_task": "当前仍要完成的用户目标",
  "user_confirmed_decisions": [],
  "verified_facts": [],
  "files_and_artifacts": [],
  "completed_steps": [],
  "pending_steps": [],
  "pending_decisions": [],
  "failures_and_recovery": [],
  "open_tool_calls": [],
  "recent_user_intent": "最近一条仍有效的用户意图",
  "omitted_information": [],
  "reload_from_workspace": []
}

字段要求：
- 数组元素短、可验证、可逐项恢复；没有内容时使用空数组。
- `open_tool_calls` 只记录未闭合调用的名称、id、参数摘要和下一步，不复制完整输出。
- `reload_from_workspace` 列出压缩后必须重新读取的 WWRITING.md、总纲、设定或其他权威文件。
- 不要把“可能”“大概”“应该”变成用户已确认决定。
```

运行时在模型摘要外层附加不可由模型伪造的元数据：源事件 seq、模型基础 ID、触发原因、token 计数、时间戳、摘要哈希和压缩状态。

## 7. 运行态动效

- 动效必须绑定真实状态：running/压缩进行中时显示，waiting_user、cancelled、failed、completed 时停止。
- 动效只作用于当前唯一活动标签或圆环，不给已完成历史事件持续加动画。
- `prefers-reduced-motion` 下保留静态状态标记和颜色变化，不使用循环动画。
- 状态文字替换不能改变行高、按钮尺寸或时间线布局。
- 运行态和压缩态只使用克制的渐入渐出、轻微位移/缩放或描边过渡；不使用弹跳、持续扫光、强呼吸或多个并行动效。
- 同一时刻只有当前活动状态图标/上下文圆环可以有轻微活性反馈；`开始压缩 → 压缩进行中 → 已压缩完成` 使用 `120–180ms` 的淡入淡出和轻微位移在同一位置顶替。工具行、reasoning 行和历史终态不做循环动效；`已压缩完成` 作为普通历史事件长期保留。

### 7.1 无框视觉基线

- 去掉 Assistant 消息、工具活动行和 reasoning 行外围的明显彩色边框与大面积底色，使内容直接融入对话背景。
- 用户消息仍可保留紧凑的中性气泡；Assistant 正文保持无框正文；警告和错误只在确有语义时使用既有 amber/red 令牌，不把运行态做成彩色卡片。
- 活动、reasoning 与压缩事件通过排版、间距、图标、短分隔线和状态文字建立层级，不依赖重复卡片容器。
- 最终实现必须同时验收浅色/深色、窄窗口与 `prefers-reduced-motion`，并确保状态替换不引起布局跳动。

## 8. 已知 UI 缺陷，列入下一轮计划

截图显示：助手回复正文在默认视图中没有显示，用户只有展开活动区后才能看到内容；界面只留下 `Worked for 50秒` 和空白活动区域。下一轮必须建立真实 DOM 回放，确认是 Assistant 正文事件未投影、正文节点被错误折叠、还是终态渲染入口丢失，并补充默认折叠态的视觉回归验收。

同时禁止任何非中文污染文案（例如误出现 `નિર્ણ`）；所有运行态和压缩状态文案必须通过界面文案回归测试。

ESC 需要增加真实交互回归：分别覆盖“关闭最上层菜单但不停止 Run”“压缩中取消压缩”“普通运行中停止 Run”“空闲态无操作”，并验证连续按键只产生一个取消/停止闭环。

## 9. 延期范围：模型配置 UX

- 本轮不改模型配置层级、供应商管理、连接测试、保存流程、删除策略或备用模型/自动故障转移。
- 已确认但延期的既有决定继续保留：API Key 默认完整回写、不做掩码保存；模型配置与工作目录解耦；模型切换从下一条输入生效。
- 本轮仅因上下文窗口识别而处理模型 ID 的本地后缀解析：设置和选择器保留原始显示值，供应商请求使用剥离尾部连续 `[...]` 后的基础 ID。这不构成模型配置 UX 改造。

## 10. 实施边界补充

- 分段大小、段命名、稀疏索引格式和常驻内存上限由实施计划固定，不再作为产品设置暴露。
- 不增加“单条消息过大”的独立产品功能。内部只做防循环保护：同一待发送输入最多触发一次自动压缩；压缩后重新估算，若已低于硬窗口则继续发送，即使仍高于软阈值也不重复压缩；若仍超过硬窗口，则复用现有提交失败与输入恢复流程，不拆分、不截断、不自动换模型。
- 运行态只允许当前活动文字或上下文圆环出现克制的过渡/活性反馈；历史终态、reasoning 行和工具行不做持续动画。
- 无框视觉按浅色/深色、空闲/运行/失败/取消、窄窗口和减少动态模式组成固定验收矩阵。
- 工具活动顺序、Assistant 最终正文可见性、非中文污染文案和 ESC 停止链均必须先建立真实事件链复现，再实施修复和视觉验收。

## 11. 实现证据（Task 14）

> 状态：计划 14 个任务全部实现，下列证据均为本机实际执行结果。未运行或待人工
> 审查的检查如实标注，绝不把未执行的命令写成通过。

### 11.1 自动验证门（2026-08-08 执行）

| 命令 | 结果 | 输出要点 |
|---|---|---|
| `npm test` | PASS，0 failed | tests 1407 / pass 1407 / fail 0（含 Task 14 新增 5 项端到端验收） |
| `npm run verify:unified-agent` | exit 0 | 统一 Agent 依赖规则、Journal 恢复、模型调用契约 26+1 场景全通过 |
| `npm run verify:app-shell` | exit 0 | 真实 app shell 加载、普通文件夹首条消息、GFM、工作组投影、技能 catalog 全通过 |

### 11.2 Journal 容量基准（scripts/benchmark-agent-journal.mjs）

脚本只写传入的临时 `--project-root`，执行前拒绝工作区根/磁盘根/用户目录，流式
分批 append、不在内存构造百万数组，测量在独立子进程冷启动进行，默认测量后删除
专用临时目录（`--keep` 保留）。原始 JSON 存档（本分支 `.superpowers/` 目录）：
`benchmark-1m-result.json` 与 `benchmark-2gib-result.json`。

| 数据集 | 命令 | 结果 JSON |
|---|---|---|
| 1,000,000 小事件（约 379 MB） | `node scripts/benchmark-agent-journal.mjs --events 1000000 --project-root D:/WWriting/.tmp/wwriting-journal-benchmark-1m` | `{ events: 1000000, bytes: 378781990, open_tail_ms: 239, read_previous_page_ms: 2, rss_delta_mb: 51.3, segments: 41, index_rebuild_ms: 2061 }` |
| 2 GiB 大工具摘要（约 2.17 GiB） | `node scripts/benchmark-agent-journal.mjs --events 1000000 --bytes 2147483648 --project-root D:/WWriting/.tmp/wwriting-journal-benchmark-2gib` | `{ events: 1000000, bytes: 2331798717, open_tail_ms: 340, read_previous_page_ms: 3, rss_delta_mb: 62.9, segments: 140, index_rebuild_ms: 14120 }` |

| 门槛 | 目标 | 1M 实际 | 2 GiB 实际 | 结论 |
|---|---|---|---|---|
| 打开 + 尾部 200 事件 | `open_tail_ms <= 2000` | 239 | 340 | PASS |
| 首屏常驻内存增量 | `rss_delta_mb < 200` | 51.3 | 62.9 | PASS |
| 向前 200 事件分页 | `read_previous_page_ms <= 500` | 2 | 3 | PASS |

说明：`index_rebuild_ms` 为删除全部 `.index.json` 派生索引后 inline 全量重建耗时
（1M 约 2.1s / 2 GiB 约 14s）；生产路径使用 inline 模式——load 期间同步重建
缺失/损坏的索引（索引是派生数据，可重建；打开耗时由尾部截断与有界读取保证，
上述 1M 打开仅 239ms）。background 模式是 store 层能力（load 立即返回、尾部
健康段先可读、索引重建作为受 AbortSignal 保护的后台任务继续），当前无生产调用方
传入 `rebuildMode`，其行为由 `journal-segments.mjs` 与
`tests/agent/journal-recovery.test.mjs` 覆盖。中间坏段
隔离后前后健康段可读、工作区可打开同样由 journal-recovery 测试覆盖，不属于本
基准脚本的数值门槛。

### 11.3 端到端验收（tests/acceptance/unified-agent.test.mjs，Task 14 新增 5 项）

| 场景 | 断言要点 |
|---|---|
| 1M 窗口完整链 | `model[1M][foo]` → provider 捕获基础 ID `model`、`configured_model_id` 保留原文；context ring 分母 1,000,000（`window_source=model_id_1m`）；预检估算 ≥ 967,000 且低于硬窗口；压缩事件 `started→running→completed` 先出现、无普通 turn；active checkpoint 切换且正式文件落盘；原输入随后发送；旧消息仍可 `beforeSeq` 向上分页 |
| 256k 自动取消 → 下次发送重新触发 | 第一次自动压缩挂起取消 → `input_cancelled(compaction_cancelled)` + `run_cancelled` + idle；下一次发送重新触发压缩门禁并成功、active 指针切换 |
| 手动 `/compact` 取消 → composer 可发 | 手动压缩进行中取消 → 会话 idle、不切换 active 指针；随后普通提交立即完成 |
| 自动两次网络失败 → 失败行可重试/取消 | 同一 attempt 两次瞬时传输错误后熔断 `context_compaction_failed(provider_transport_error)`；Run `waiting_user`（发送门禁禁用）；cancel → idle；再次提交重新触发并成功 |
| ESC 停止普通 Run | `run_cancelled` 收敛当前 Run、活动与排队输入全部取消、无 `run_completed`、活动闭环 |

### 11.4 视觉验收矩阵（5 行）

> 本机（Windows，可见桌面会话）Electron 可见窗口 `capturePage` 可用，但 offscreen
> 渲染抛 `UnknownVizError`（与 CI 无头环境一致），因此 `capture-visual-acceptance.cjs`
> 的 offscreen 采集在本机不可运行；改用可见窗口驱动真实 app shell 采集 5 行矩阵
>（临时工具 `.tmp/capture-compaction-matrix.cjs`，未提交）。全部 5 行已采集为真实
> 渲染像素，等待人工/多模态复核，本表如实标注验证方式。

| 行 | 主题 | 宽度 | 状态 | 动效 | 截图 | 验证方式 |
|---|---|---|---:|---|---|---|---|
| 1 浅色 | 桌面 | 空闲 | normal | `light-desktop-idle.png` | 已采集，待人工复核；自动化：theme=light + 圆环挂载 + 无横向溢出 |
| 2 深色 | 桌面 | running | normal | `dark-desktop-running.png` | 已采集，待人工复核；自动化：theme=dark + 运行态文字 + 无横向溢出 |
| 3 浅色 | 窄窗 | 压缩中 | normal | `light-narrow-compacting.png` | 已采集，待人工复核；自动化：真实 13 轮历史 + 195K 输入触发压缩 + 压缩行「压缩进行中」+ 无横向溢出 |
| 4 深色 | 窄窗 | 失败/取消 | normal | `dark-narrow-failed-cancelled.png` | 已采集，待人工复核；自动化：失败行 + 重试/取消按钮 + 终态 0 循环动画 |
| 5 任意 | 桌面 | 压缩中 | reduced | `reduced-running-compacting.png` | 已采集，待人工复核；自动化：`--force-prefers-reduced-motion` 真实命中 + 0 循环动画 |

截图目录：`artifacts/visual-acceptance/2026-08-08-compaction-matrix/`（本分支未提交的
本地证据，`matrix-rows.json` 记录每行状态、自动化断言与待复核标注）。

自动化断言映射（不依赖图片即可判定行的状态/主题/宽度/动效语义）：
- 状态/主题/压缩行/文案：`tests/app-shell/agent-surface.test.mjs`、
  `tests/app-shell/agent-context-ring.test.mjs`（圆环分母、`已压缩完成` 不显示 token
  明细、运行态全中文、无 `Worked for`/`નિર્ણ`/英文 running 文案均有 DOM/CSS 断言）。
- 宽度/布局：`tests/app-shell/app-shell-static.test.mjs` + `verify:app-shell`
  （1040px 内容列、视口钳制、无横向溢出契约）。
- reduced-motion：agent.css 的 `prefers-reduced-motion` 规则由
  `agent-surface.test.mjs` 覆盖；本矩阵第 5 行另以 `--force-prefers-reduced-motion`
  真实命中并断言 0 个循环动画。

额外人工验收项（hover/focus/click pinned/外部点击/ESC 关闭 popover、工具活动在
正文之前、`已压缩完成` 不显示 token、无污染文案）由下列自动化覆盖：
- 工具活动顺序在正文之前：`tests/acceptance/unified-agent.test.mjs`
  （tool-before-answer 回放，真实事件链）。
- 压缩行文案与动作按钮：`tests/app-shell/agent-surface.test.mjs`。
- ESC 停止/取消链：`tests/acceptance/unified-agent.test.mjs`（ESC 停止普通 Run、
  压缩取消）+ `tests/app-shell/agent-surface.test.mjs`（handleEscape 去重锁）。

### 11.5 视觉验收发现并修复的真实缺陷

严格模式下 ES 模块对 SVG `<circle>` 执行 `className = ...` 赋值，在本机 Electron
（Chromium）抛 `Cannot set property className of #<SVGElement> which has only a
getter`：`src/app-shell/agent/context-ring.js` 在启动创建圆环时即崩溃，导致整个
app shell 无法加载（纯 DOM mock 测试因 mock 允许任意元素赋值 className 而漏过）。
已修复：改用 `classList.add()`（真实 DOM 与测试 mock 均兼容），修复后 5 行矩阵
全部可采集，`tests/app-shell/*` 302 项全通过。该缺陷由本任务的真实 Electron 视觉
验收发现，属于计划「圆环始终显示」验收项的落地。

### 11.6 延期与未做事项

- 模型配置 UX（供应商管理、连接测试、窗口手工输入、能力表）：按 §9 继续标记延期，
  本轮未顺手修改。
- `capture-visual-acceptance.cjs`（offscreen 采集）在本机因 `UnknownVizError` 不可
  运行，未产出其 17 张固定证据；5 行矩阵由可见窗口驱动脚本替代采集（见 11.4）。
- 基准脚本的 `index_rebuild_ms` 是 inline 全量重建数值；background 重建的「尾部先
  显示」语义由测试覆盖而非基准数值（见 11.2 说明）。
