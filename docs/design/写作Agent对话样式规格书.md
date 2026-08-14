# 写作 Agent 对话样式 · 设计规格书（AgentSurface）

> 用途：本文件是统一 Agent 架构下唯一对话面（AgentSurface）的最终设计约束，供其他模型 / 开发者 1:1 复刻或扩展该界面时使用。
> 状态：已实施（Task 8–10 落地；旧聊天线程、准备卡、完成卡、顶部活动条等全部删除）。

---

## 1. 产品定位

一个**只做一件事**的 Agent 对话界面：打开任意文件夹后，用户用自然语言下指令（"继续写第 3 章""帮我检查人物设定""/init"），Agent 自主决定读取哪些文件、运行哪些命令、修改哪些内容。**不存在独立的"开始写作"按钮、准备卡、章节完成卡或顶部运行面板**——写作通过聊天发起，章节阅读留在抽屉。

两个互相矛盾的需求必须同时满足：

- **过程可见**：当前这一轮模型在做什么（思考中、读取文件、运行命令、等待确认）实时可见，工具输出增量出现；
- **结果干净**：运行事实只出现在当前这一轮；Run 结束后只留下状态行、可回看的任务计划与对话消息，不残留过程噪音。

核心设计原则一句话：**执行状态只在当前 Agent 轮出现，项目事实只出现在抽屉。**

---

## 2. 设计原则（约束级）

| # | 原则 | 说明 |
|---|------|------|
| P1 | 单一对话面 | 聊天、写作、审核、初始化共用同一个输入框与对话流；斜杠菜单只负责补全输入，不建立第二套控制面 |
| P2 | 状态只出现在当前轮 | 顶部不显示队列派生状态、阶段、进度条或活动条；Run 状态只在对话内当前轮出现 |
| P3 | 排队与立即 | 运行中发送的输入进入 FIFO 队列：显示原文 + `排队` + `立即`；`立即` 打断当前轮并提升该输入（同一 Run），不创建第二个 Agent |
| P4 | 停止可预期 | 当前轮状态行提供 `停止`；停止中显示 `正在停止`，终态显示 `已停止`；进行中的写入保持完整 |
| P5 | 文案极简 | 正常状态 2–6 个字；错误只呈现一条用户可理解的事实；错误码、命令、退出码进入活动行的折叠详情 |
| P6 | 同一事实只显示一次 | 当前 Agent 轮优先，其次错误/确认卡，最后项目静态信息 |
| P7 | 成功不弹 Toast | 保存等普通成功以控件自身状态表达（如按钮短暂显示 `已保存`），不用成功 Toast 刷屏 |
| P8 | 警告不删除只缩短 | 权限、破坏性操作、鉴权失败和数据未保存类警告必须保留，可缩短 |
| P9 | 无头像、无署名行 | Agent 消息不带头像、不带署名行，直接以内容开始 |
| P10 | 折叠态即回看态 | Plan 为对话区右上方悬浮层，折叠态即回看态；Run 终态后保留可回看，无编辑入口 |

---

## 3. 整体布局

```
┌─ 顶栏：项目标题 + 状态（待命/已归档）+ 隐私/主题 ─────────────────────┐
│                                                                     │
│  [对话]   用户气泡（右侧）                                            │
│           Agent 消息（左侧，安全 GFM 渲染）                           │
│  [工作组]  ▾ 工作中  工作 12 秒（details/summary，可展开/折叠）        │
│             思考中 ▸（reasoning:turn-1）     —— 运行中最多两行扫光     │
│             已完成思考 ✓（reasoning:turn-1）—— 展开显示全文/空文案    │
│             ▸ 运行命令  npm test                    ✓                 │
│             ▸ 读取文件  chapter.md                                   │
│             任务计划  2/3（plan:run-1）                              │
│  [排队]    先改第三章  排队  [立即]                                    │
│  [composer] ┌ 输入消息（稳定三行） ──────────────────────┐             │
│             └────────────────────────────────────── [↑] ┘             │
└──────────────────────────────────────────────────────────────────────┘
```

- 对话与 composer 共享 `--content-column: 1040px` 内容列，居中；模型菜单宽度受 `min(320px, calc(100vw - 32px))` 约束，左右各留 16px 视口安全区，长名称任意位置换行。
- Assistant 正文阅读宽度 720px（中文每行 ≈ 40 字）；消息垂直节奏：轮内 12px、轮间 28px（上一轮正文 → 下一轮用户气泡），回合边界以间距表达，不引入分隔线。
- 用户消息：右侧紧凑浅中性气泡，上限 `min(800px, calc(100% - 32px))`；Agent 消息：左侧无框正文；两者都无头像无署名。
- 未打开项目时：composer 禁用，对话区显示空会话提示 `新建或打开项目`；打开项目后提示消失，空会话不显示任何欢迎词或建议 chips。

---

## 4. 组件规格

### 4.1 状态行（当前 Run）

- 文案映射（2–6 字）：

| 状态 | 文案 |
|---|---|
| running（无未闭合模型轮） | `运行中` |
| running（有未闭合模型轮） | `思考中` |
| waiting_user | `等待确认` |
| interrupting | `正在打断` |
| stopping | `正在停止` |
| cancelled | `已停止` |
| interrupted | `已中断` |
| failed | `操作失败` |
| completed | `已完成` |

- 活动 Run 显示 `停止` 按钮（点击立即禁用防连点；请求失败或 Run 恢复后重新可用）；failed/interrupted 显示 `重试`（同一 run id 恢复，不新建 Run）。
- 终态只渲染一次状态横幅；重试恢复同一 run 后停止按钮重新出现。

### 4.2 任务计划（Visible Plan）

- 悬浮于对话区右上方覆盖层（第二图层）：不占网格轨道、不改变消息列宽，展开/折叠不压缩聊天记录；无任何编辑控件。
- 计划项为有序列表，每项 = 状态标记 + 步骤文本（可选描述）；标记 `✓`（completed）/ `•`（in_progress）/ `○`（pending）。
- 折叠态默认显示 3 项并智能选取：优先包含 `in_progress` 项，再取相邻步骤；无 `in_progress` 时取前三。展开态显示全部。
- 生命周期：新用户输入 → 旧计划退出悬浮层；`plan_updated` 到达 → 显示；Run 结束 → 保留供回看；无计划的简单任务不显示空面板。
- 窄视口（≤720px）降级为 composer 上方非模态浮层，仍不压缩消息列。

### 4.3 活动行（单条活动流）

- 同一 `activity_id` 合并到同一行，增量输出只更新文本不重建 DOM；最多保留 20 行，只移除最早的终态行，运行中的行永不丢弃。
- 行头 = 状态标记 + 人话标签：

| 工具 | 标签 |
|---|---|
| list_files | `查看文件列表` |
| search_files | `搜索「查询词」` / `搜索文件` |
| read_file | `读取文件 <相对路径>` / `读取文件` |
| write_file | `写入文件 <相对路径>` / `写入文件` |
| edit_file | `修改文件 <相对路径>` / `修改文件` |
| shell | `运行命令` |
| update_plan | `更新任务计划` |
| enter_workflow | `切换工作流` |
| append_chapter_segment | `写入章节内容` |
| commit_chapter | `提交章节` |
| commit_blueprint | `提交蓝图` |
| 其他 | `工具 <name>` / `调用工具中` |

- 标记：运行中 `•` / 完成 `✓` / 失败 `✗` / 已停止（取消类错误码 tool_cancelled、shell_cancelled）`已停止`。
- 点击行头展开折叠详情，字段顺序固定：**参数 → 命令 → 目录 → 退出码 → 耗时 → 错误**；输出区保留最后 64 KiB，截断前置 `（输出过长已截断）`。
- 私有推理正文不在此渲染：chain-of-thought / private_reasoning 等链式字段绝不进入活动行；reasoning 内容的唯一展示入口是 §4.9 的 `已完成思考` 项。

### 4.4 排队输入

- 行结构：用户原文 + `排队` 徽标 + `立即` 按钮；原文任意位置换行，不遮住 `立即`（grid 稳定轨道 `minmax(0,1fr) auto auto`）。
- `input_consumed` / `input_cancelled` 事件移除对应排队项。

### 4.5 决策卡

- 普通确认（kind=normal）：标题 + 描述 + 三选：`一次允许` / `本条输入允许同类操作` / `拒绝`。同类授权只对当前这条排队输入（active_input_id）生效。
- 极端危险确认（kind=extreme）：红色卡片，展示 `输入确认文字以执行：<当前确认文字>`；执行按钮在输入与当前确认文字精确匹配前禁用；`拒绝` 始终可用。
- 终态（resolved/superseded/cancelled）决策卡立即下架；extreme 卡不被重建，保留用户已输入的确认文字；已终结的 decision id 不能再应用（decide 只放行仍为 pending 的 decision_id）。

### 4.6 错误卡

- 标题 `操作失败` + 一条用户可理解的事实（message），如 `无法读取该文件，请检查路径后重试。`。
- 错误码、命令、退出码等技术字段不出现于主文案，位于活动行折叠详情。
- 新 Run 启动时错误卡清空。

### 4.7 Composer 与空会话

- placeholder：`输入消息`（无示例教学句）；输入区默认稳定三行，底部工具栏为 模型选择 / 权限模式 / 思考强度 三个紧凑下拉 + 带 `发送` 可访问名称的向上箭头按钮；Enter 发送、Shift+Enter 换行。
- composer 是单一的 8px 圆角命令台：输入区与底部工具栏共用外框，聚焦时只增强边框和焦点环，不改变尺寸。禁止恢复“单行输入框 + 外置文字按钮”的长条布局。
- 输入 `/` 时在 composer 上方显示紧凑补全菜单；支持前缀筛选、上下键、Enter、Tab、Esc 和鼠标选择。选择命令只把完整命令填入输入框，不自动执行。
- 补全项固定为 `/init`、`/write`、`/model`、`/settings`。其中 `/settings`、`/model` 精确发送时只打开本地设置；另外两项仍作为普通消息交给统一 Agent。
- 用户发送后立即显示本地用户气泡；正式 journal 事件到达后原位收敛，不能重复。提交失败时保留气泡、恢复原输入，并在气泡下显示一条简短错误，禁止静默吞掉失败。
- 未打开项目：输入框与发送按钮禁用，对话区显示 `新建或打开项目`。
- 打开项目：composer 可用；运行中保持可用（发送进入队列）。
- 三控件选择即保存为项目默认（模型走 model-switch，权限/思考强度走 settings/update）：正在执行的 Run 不变，从下一条输入生效；思考强度仅当模型已验证支持时显示 低/中/高，否则只显示 `自动` 且禁用，不伪装生效。

### 4.8 模型菜单（布局基线）

- 宽度 `min(320px, calc(100vw - 32px))`，视口左右各 16px 安全区，`max-height: min(520px, calc(100vh - 96px))`。
- 长名称 `white-space: normal; overflow-wrap: anywhere`，完整显示名走 `title`。

### 4.9 工作组（Agent Work Group）

- 一个 Run 的思考、工具调用、任务计划按发生顺序合并为一个**工作组**，插入对话时间流：`<details class="agent-work-group">`，`<summary>` 内为状态文案 + 耗时，正文为有序子项（`agent-work-item`）。工作组无框直出（无描边、无圆角包裹、无底色，直接展示在页面背景上；样式见 §7），不在组外加卡片容器。
- 工作组按组首事件 seq 插入时间线，未确认送达的用户消息（无 seq）固定靠后，工作组绝不出现在其上。
- summary 与明细内容轴与正文对齐（720px），容器保持全宽维持时间流节奏。
- 子项 id 与种类：`reasoning:<turn_id>` / `tool:<activity_id>` / `plan:<run_id>`；排序规则：reasoning/tool 以开始事件 seq 排序，完成事件不移动位置；plan 首次出现位置固定，每次 `plan_updated` 内容更新并移动到最新位置（同一任务 id 绝不重复添加）。
- 状态文案与展开默认值（投影给出，用户可在 DOM 侧覆盖）：

| 组状态 | summary 文案 | 默认展开 |
|---|---|---|
| running / interrupting / stopping | `工作中` | 展开 |
| waiting_user | `工作中` | 展开（等待授权期间不计时） |
| completed | `工作了 X 秒` | 折叠 |
| failed | `工作了 X 秒 · 失败` | 展开 |
| cancelled | `工作了 X 秒 · 已停止` | 展开 |
| interrupted | `工作了 X 秒 · 已中断` | 展开 |

- **耗时口径**：只显示**有效工作耗时**——`active_elapsed_ms` 累计 active（running/interrupting/stopping）区间，等待用户确认授权的时间不计入；终态时累计值即最终耗时。
- **思考项**：`model_turn_started` 创建 `reasoning:<turn_id>`，运行中标签 `思考中`（最多两行、按自然片段替换、不推动对话滚动）；`reasoning_completed` 到达后标签变为 **`已完成思考`**。展开详情的文案按可用性三态：
  - `available`（模型支持且本轮有已确认安全的内容）→ 显示思考全文；
  - `unsupported`（模型明确不支持查看）→ `当前模型不支持查看`；
  - `empty`（支持但本轮无内容）→ `本次没有可查看的思考内容`。
- 每个模型轮次恰好一个 `已完成思考` 项，与工具动作严格按事件 seq 交替排列；两个模型轮次产生两个独立思考项。
- reasoning 内容只经 `reasoning_delta` / `reasoning_completed` 进入 journal，**绝不写入下一轮模型上下文，也绝不混入 assistant 正文通道**。

### 4.10 安全 GFM（Markdown 渲染）

- 单一 marked 解析器路径（`gfm: true, breaks: true`），不再保留第二套渲染器；表格、任务列表、删除线、行内/围栏代码、引用、标题全部按 GFM 语义渲染。
- 安全拦截固定顺序：
  - raw HTML 整体转义为纯文本（`<script>` 不会执行）；
  - 链接只放行显式 `http:` / `https:`，其余 scheme（`javascript:` / `data:` / `file:` 等）不生成 `<a>`，只保留标签文字；合法链接带 `data-external-link`；
  - 图片不发起远程加载，只输出转义后的替代文字；
  - 代码块内容转义。
- 链接交给系统默认浏览器：view.js 对 `[data-external-link]` 事件委托 + `preventDefault`，Electron 走 preload 的 `openExternalUrl`（main 二次校验），普通浏览器回退 `window.open`。
- `稿`/`prose` 围栏块渲染为衬线文稿块（含 `peek` class 与字数标）；流式未闭合围栏按纯文本段落回退。
- 渲染产物宽度必须被 `--content-column: 1040px` 约束，表格/代码块在容器内滚动、不得撑破正文列。

---

## 5. 文案规范（UI Copy Audit 最终状态）

> 本节是**禁止项清单**：下面列出的文字只允许出现在本规格书（或禁止文案测试）中作为禁令示例，界面文案一律不得出现；完整删除清单见 UI Copy Audit 表。

- 正常状态尽量 2–6 个字；排队 `排队`、立即 `立即`、停止 `停止`、重试 `重试`。
- 不出现：`安全步骤`、`checkpoint`、`原子提交`、`等待任务收尾`、`继续思考`。
- 旧任务卡文案（如"前面还有 N 个任务""下一个执行"）、旧空线程示例、`/init` 专用生成中/成功文案、旧审查报告文案与旧章节空态教学句已全部删除，禁止在界面中复现或以教学句替代（完整清单见 UI Copy Audit 表）。
- 网络断线重连为静默处理（不显示长句文案）；若显示重试状态，只允许计数事实（如 `正在重试 2/5`），恢复后短暂显示 `已恢复`。
- 停止/恢复成功不弹 Toast；停止过程显示 `正在停止`，终态 `已停止`。
- 设置页：只保留字段标签和必要风险。归档说明 = `归档后项目只读。`；API Key 说明 = `API Key 仅保存在本机。`；成本说明 = `未填写价格时不显示成本估算。`；YOLO 确认 = `YOLO 会自动执行写入和控制操作。确认开启？`；模型切换确认 = `切换后将由新模型继续，本章文风可能变化。继续？`；普通保存成功 Toast 删除，保存按钮短暂显示 `已保存`。
- 章节空态 = `暂无章节`（无教学句）。
- 成功通常不弹 Toast。

---

## 6. 状态机与行为约束

### 6.1 Run 生命周期

```
输入 → run_started（状态行出现）→ 模型轮 + 工具活动（增量输出）
     → run_completed（已完成）| run_failed（操作失败 + 错误卡 + 重试）
     → run_cancelled（已停止）| run_interrupted（已中断 + 重试）
```

### 6.2 排队 / 立即 / 停止

```
运行中发送新消息 → input_queued（对话出现用户气泡 + 队列行）
  ├─ 立即 → interrupt_requested → input_promoted（同一 run id 切换 active_input_id）
  │         → interrupt_safe_point_reached（回到运行中）
  └─ 停止 → run_status_changed(stopping) → 活动 cancelled 收敛 → run_cancelled
```

- 停止只针对当前 run id；重试恢复同一 run id，不产生第二个 Run。
- 暂停/恢复成功不弹 Toast；停止在途时按钮禁用防连点。

### 6.3 事件驱动

- AgentSurface 只消费 snapshot({ session, events }) 与 SSE 增量事件；不轮询 dashboard、不读队列文件、不做业务正则决策（Rule 4/5）。
- 输入成功后 AgentSurface 主动补拉一次增量 snapshot；SSE 继续承担实时事件流。消息首次可见性不能只依赖 SSE 长连接。
- `/settings`、`/model` 精确输入只打开设置对应分区，不创建 Run；其余任何斜杠前缀字符串（含 `/init`、`/write`）都是普通输入。
- 运行事实与排队状态由 journal 事件驱动，顶栏不再显示队列派生状态。
- 助手正文以 `assistant_message_delta` 增量到达、`assistant_message_completed` 定稿；前端对累积正文做 Markdown 增量渲染（rAF 合帧节流，安全 GFM 见 §4.10），断线重连由快照/回放保证一致；reasoning 内容的展示只经 §4.9 的 `已完成思考` 项。

---

## 7. 视觉规格（与背景融合的现代控制台）

- 全局使用中性冷白/浅灰结构层：侧栏略厚、主内容区保持安静白面；深色模式使用中性炭灰。绿色只承担语义和焦点，不作为大面积主题色；警告和错误继续复用 amber/red 语义色。
- 次级操作默认融入所在背景，只在 hover、focus、active 或 selected 时出现浅色反馈。禁止把新建、搜索、项目计数、隐私、主题、停止、重试、立即等入口做成一排常驻描边胶囊。
- 新建小说是侧栏行式入口；项目列表是紧凑行，当前项目仅用浅背景和字重表示；顶栏隐私/主题使用图标按钮，文字通过 title/可访问名称保留。
- AgentSurface 与主内容背景同层。用户消息使用浅中性紧凑气泡，Agent 回复保持无框正文；发送按钮独立使用高对比主操作色，不能借用用户气泡颜色。
- Agent 工作过程（思考/工具/计划）以无框折叠组承载：summary 一行状态 + 耗时（muted 12.5px，内容轴与正文 720px 对齐，hover 浅色反馈），展开为明细列表；无描边、无圆角包裹、无底色，直接展示在页面背景上；用户消息使用紧凑中性气泡；Assistant 正文保持无框直出，不包卡片。
- Assistant 正文排版（正文神圣）：衬线 `var(--serif)`（Noto Serif SC / Songti SC / STSong / SimSun）、15px、行高 ≥2.0，仅 `<strong>` 加粗，UI 元素不得与正文混排。
- 活动记录位于无框工作组的展开明细列表内；禁止每条活动行各包一张重复卡片。
- 运行态与压缩态使用紧凑状态条（状态点+两字状态+右侧动作按钮）；禁止横贯对话区的全宽水平分隔线。
- 空 Run、空活动列表和空队列必须完全隐藏，不能留下横线、占位条或状态装饰。
- 对话与 composer 共享 `--content-column: 1040px`；窄视口（≤560px）排队行改双行网格，无重叠。
- 正文/输出区等宽字体 `var(--mono)`；UI 文字无衬线。
- Composer 是唯一常规浮动操作材料：12px 圆角、轻边界、克制阴影和半透明模糊；斜杠菜单从 composer 左下锚点出现。减少透明度时必须切换为实色表面。
- 动效从简：按下反馈在 80–100ms 内发生；新消息与菜单只允许短促 opacity/translate 动效，不循环、不弹跳。状态变化不改变行高，按钮/标记尺寸不随状态抖动。
- 必须同时支持 `prefers-reduced-motion`、`prefers-reduced-transparency` 和 `prefers-contrast: more`；减弱动态后保留静态/颜色反馈，高对比模式使用实色表面与明确边界。
- “思考中”使用短促、可降级的流动点反馈（三点闪烁），不得展示任何私有推理文本；必须支持 `prefers-reduced-motion`（减弱后静态呈现）。
- **动效唯一性**：当前 Runtime 串行执行工具——可见扫光数量最多 1（reasoning 或工具文字二选一），终态/折叠工作组为 0；只有运行时真实存在两个同时开放的 `activity_id` 才允许数量为 2。完成折叠或用户手动折叠时必须立即移除工作组内的残余扫光。
- 同一时刻最多一个活性动效目标（当前活动项或状态点），终态 0 循环动效。

---

## 8. 架构所有权（Truth 归属）

| Truth | Owner |
|---|---|
| 项目身份、配置、模型选择（旧项目兼容；新工作区不创建） | `project.yaml` / 应用私有 workspace settings |
| 项目记忆（当前有效要求、风格 ID、权威文件索引） | `<projectRoot>/WWRITING.md` |
| 小说正文、设定、索引、checkpoint | 项目文件与 project operations |
| Session、Run、queue、plan、decision | 应用私有 Agent journal（`<userData>/workspaces/<id>/agent/`） |
| provider 消息连续性 | transcript |
| 模型循环、workflow、stop/立即 | ProjectAgent |
| 跨 Run 成本累计 | `cost.json` / CostTracker |
| 章节提交、导出等领域审计 | `run_log.jsonl`（旧项目兼容） |
| 折叠状态 | AgentSurface 本地 UI 状态 |

---

## 9. 给其他模型的实现约束（Checklist）

1. 对话、活动、Plan、queue、决策/错误卡、composer 全在 `src/app-shell/agent/`（view.js 渲染，state.js 纯 reducer，index.js 唯一外部 seam）。
2. 活动行合并、20 行上限、64 KiB 输出尾、字段顺序、停止防连点、终态单横幅、extreme 卡不重建均为验收契约，不得放宽。
3. 文案改动必须遵守第 5 节；删除文案不得以教学句替代。
4. 新组件颜色从既有令牌派生，保持低饱和纸感；不得引入第三种错误色。
5. reasoning 内容只经 §4.9 的 `已完成思考` 项展示；chain-of-thought / private_reasoning 等链式字段永不进入派生状态与 DOM，reasoning 永不注入下一轮模型上下文。
6. 新增事件类型先入 journal 固定事件表，再在 state.js 归约、view.js 渲染；未知类型一律忽略。

---

## 10. 技能发现契约（Skills）

技能由目录中的 `SKILL.md` 声明，放入目录即被发现，**不需要在项目中启用**（verbatim）：

```text
全局技能：%USERPROFILE%\.wwriting\skills\<skill-name>\SKILL.md
项目技能：<projectRoot>\skills\<skill-name>\SKILL.md
同名覆盖：项目 > 全局 > 随应用分发 > 内置
放入目录即被发现；适用条件写在 SKILL.md，不需要在项目中启用。
```

- 只扫描直接子目录中的 `SKILL.md`；无 `SKILL.md` 的目录不是技能，静默跳过。
- `SKILL.md` frontmatter：`name`（必填，必须与目录名一致）、`description`；`version` 与 `metadata.wwriting.hooks` 为可选扩展，未知 metadata 保留但不执行。
- 跨层同名由优先级解决，catalog 返回 `active`（最高优先级副本）与 `shadowed`（被覆盖的底层副本），UI 显示当前生效来源；**没有启用/禁用集合，没有“全部启用”开关**。
- 适用条件（如章节号范围、检查项）写在 `SKILL.md` 的 `metadata.wwriting.hooks` / 正文小节，不经过项目配置。
- 设置 → Agent 技能分区 = catalog/import/delete 唯一入口：文件夹/ZIP 导入、重名覆盖提示、打开目录、删除。
- 旧 manifest（skill.yaml/json）只在迁移时作为输入，迁移后 live 目录只有 `SKILL.md`，旧文件只存在于 migration backup。

---

## 11. 实现证据（Codex 风格 UI 改版，2026-08-09）

> 状态：按 `docs/superpowers/plans/2026-08-09-codex-style-ui-redesign.md` 逐任务实施，
> 下列证据均为本机实际执行结果。截图矩阵的**人工过目**尚未执行（本环境无多模态），
> 如实标注待复核，绝不把未执行的检查写成通过。

### 11.1 视觉契约测试（全部通过）

- `tests/app-shell/codex-visual-contract.test.mjs`：新基线源码级契约（无横杠/工作卡片/状态小条/压缩条/composer 卡片/顶栏发丝线），逐任务追加断言。
- `tests/app-shell/text-style-contract.test.mjs`：圆角 ≤12px、对话画布非纯白冷调、卡片白底允许、字级/对比度/1040px/无 raw hex 保留。
- `tests/app-shell/agent-surface.test.mjs`：工作组卡片契约、composer 卡片契约随动重定。
- **工作组无框化修订（2026-08-14，模块 B 打磨）**：上述"工作组卡片"契约已随 B3 同步改为"工作组无框直出"——`agent.css` 移除描边/圆角/底色/阴影，summary 与明细内容轴收至 720px 与正文对齐，容器保持全宽；`codex-visual-contract.test.mjs`/`agent-surface.test.mjs` 的对应断言由"细边框圆角卡片"改写为无框断言 `border:0`/`border-radius:0`/`background:transparent`（B1 另修工作组时间线排序，见 §4.9）。
- 全量 `npm test`：0 failed（详见 11.2）。

### 11.2 自动验证门

- `npm test` → 0 failed（基线 1420 用例通过；新增 codex-visual-contract 后只增不减）。
- 硬三件套全部 exit 0：
  - `npm run verify:app-clickability`
  - `npm run verify:app-shell`
  - `npm run verify:desktop-shell`

### 11.3 截图矩阵（待人工过目）

`node scripts/capture-visual-acceptance.cjs --output artifacts/visual-acceptance/2026-08-09-codex-matrix` ——
产物目录已生成，五场景 + 浅/深 × 桌面/窄窗截图需人工过目确认：无横杠、卡片成型、正文仍衬线。

> 采集脚本本次有一处稳健性修复（非产品行为改动）：`submitViaComposer` 原先只等 composer
> input 存在就开始命中测试，而项目打开前 composer 处于 `hidden`（display:none），send 按钮
> rect 全零、`elementFromPoint` 落在视口原点返回 `<html>`，间歇失败。已加"composer 可见且
> 发送可用"等待护栏（与 verify-app-clickability 的 waitForComposerEnabled 同款），
> 修复后连续采集稳定 exit 0。
