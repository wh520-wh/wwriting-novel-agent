# 第十二轮规格：过程可见性与过程美化（2026-08-21）

- 状态：已实现并收口（2026-08-21，F1-F16/E/§4.3/N1-N3 全部落地，全量回归 178/178；修复记录见 [[2026-08-21-process-visibility-audit]] 末节）
- 输入：[[2026-08-20-agent-progress-narration-terminology]]（术语深潜）、[[2026-08-20-competitive-research]]（竞品决策报告）、[[2026-08-21-process-visibility-audit]]（聚焦审计，F 编号出处）、[[2026-08-18-ui-backend-consistency-audit]]（E 项母账）
- 一句话：把作者从「看条目机械跳动」变为「听 Agent 说为什么」，同时把状态谎言与渲染残缺一次清干净。

## 术语与三层模型

- **过程叙述（progress narration）**：模型在执行过程中自己写的说明文字（做什么、为什么），经既有 `assistant_message_delta/completed` 通道流出，与私有推理（reasoning，永不入 provider history）严格分离。
- 三层：**计划层**（任务计划 chip，已有）／**叙述层**（本轮新建）／**事实层**（工作组条目，已有）。

## 目标

1. 叙述层点亮：里程碑级模型叙述，Claude Code 式力度。
2. 过程区 + 对话流整体美化：三层视觉层级、状态色语义、信息密度分级、动效收敛。
3. 状态真实化：E（待命可见）、§4.3（重试可见）、崩溃/等待后的收敛与恢复。
4. 修复包：审计 F1-F11 全修 + F12-F16 小修（取舍见「非目标」）。

## 非目标（明确不做）

- 不暴露私有推理；不做 Codex 式全量 transcript 对等；不做全应用（设置/抽屉/阅读器）美化。
- 不做真实 API 检查（用户决定）。
- 不动 retry API 的 waiting_user 拒绝语义（只做可发现性，见 N4）。
- 缓修记录在案：F17（timelineSeqs 泄漏）、F18（diagnostics 口径）、F19（active_input_id 镜像）、F20（priority 快照竞态）、F21（超长单轮 tail 截断，completed 自愈）。F22 并入 E。
- 不设单独视觉验收轮：一次做到位，用户单次人工验收（见「验收策略」）。

## N1 叙述层 elicitation（提示词）

`prompt.mjs` Runtime Policy 区（:57 附近）新增一条（措辞按现有政策行风格）：

> 过程叙述：开始新的计划步骤、读取关键材料或转换工作方向时，先用一两句话说明这一步要做什么、为什么，让作者不展开细节也能跟上进度；简单的单步操作和连续同类调用不必逐次说明；不要复述工具结果原文；最终答复仍按完成条件给出。

约束：与既有「能直接完成的工作使用工具完成，不只口头承诺」（:49）不冲突--那条禁止**只说不做**，本条要求**边做边说**。简单任务允许全程沉默直接作答（无强制叙述下限）。

上下文成本（审计 E7 / 调研 [E7]）：叙述正文进 provider history 并参与压缩。纪律由「一两句话 + 里程碑粒度」约束，落地后观察 `context_usage_updated` 增速，必要时下一轮收紧。

## N2 叙述排版与收尾

- **运行中**：叙述经既有流式气泡实时渲染（零新机制，时间线已按 seq 交错）。叙述气泡用次级正文色（明显区别于工具条目的紧凑条目样式与状态色）。
- **Run 终态后**：该 Run 内**非最终**一条 assistant 气泡淡化一档（次级色），最终一条保持正常权重。实现锚点：view 按 Run 事件窗口（firstSeq..终态 seq）归属气泡，终态时打 narration 类。
- **视觉分离铁律**（用户点名）：叙述=行文、常规字体、次级色；工具/思考条目=紧凑行、状态图标、参数等宽展示。字号/字重/颜色/留白四维至少三维不同。

## N3 过程美化（过程区 + 对话流）

沿第十轮 AICSS 设计语言深化，四个交付：

1. **三层视觉层级**：叙述气泡/最终正文/工作组条目的 token 化对比（AICSS tokens）。
2. **状态色语义统一**：running/completed/failed/cancelled/waiting_user 在状态点、条目图标、组状态行三处同色同义。
3. **信息密度分级**：折叠摘要行一眼可读（状态 + 目标 + 耗时），展开才见参数/输出；`relativeProjectPath` 相对路径口径保持。
4. **动效收敛**：shimmer 仅 live 项；折叠/展开平滑；无信息量动效删除。

## N4 状态真实化

### E：待命可见
- 后端：`runtime.mjs:2929` 附近 sessions() 不再把非终态折叠为 running，报告真实状态（waiting_user 等）。
- 前端：`session-sidebar.mjs` RUN_STATUS_LABELS 补全状态键；**busy 判定显式用非终态集**（不再依赖「折叠为 running 恰好匹配 project_busy」的副作用，审计 L4）。
- 刷新：run 状态变化事件驱动侧边栏轻量刷新（沿用第十一轮 A 的读时失效模式）。

### §4.3：重试可见（「重试 n/m」）
- 网关重试时发 journal 事件 `provider_retry`（payload: attempt、max_attempts；gateway.mjs 已有 attempts 跟踪，需加回调或运行时观测点）。`FIXED_EVENT_TYPES` 计数连带 +1，测试同步。
- 前端合成瞬态行（run header 或当前工作组 summary），非模型文本、不入 provider history、Run 终态即消失。

### F12/F13：状态文案与接线
- groupStatusText 补 stopping「正在停止」、interrupting「正在中断」；openWorkItemIds 压制列表补 interrupting。
- waiting_user 且存在待决决策时，对应 running 工具项置 waiting「等待确认」（决策解决后按结果流转）。

### F4：恢复入口可发现
- 压缩行 cancelled 状态加「重试压缩」按钮（后端 retryCompaction 已支持，runtime.mjs:2663-2668）。
- waiting_user Run 状态区加提示文案（「等待你的指令：发送消息继续」类）。

## N5 修复包（行为规格）

| # | 行为定义 | 锚点 | 验收 |
|---|---|---|---|
| F1 | Run 终态/waiting_user 时，未定稿 assistantStream 定稿为带「已中断」标记的正式气泡（复用 truncated 渲染）；run_started 重置前先定稿残留，retry 不再静默删正文 | state.js:378-525、view.js:685-696 | 停止/失败/重载/重试四场景无悬挂光标气泡，半截正文保留可见 |
| F2 | 前端：run 终态清扫组内 running 项→cancelled（reasoning「思考已停止」/工具「已停止」）；journal：priority 恢复批次 tool_call_failed 补 activity_id 与 message、闭合 turn 时配对 reasoning_completed | work-items.mjs:542-551、journal.mjs:1287-1344 | 恢复批次重放后零 running 项；F2 两路径 node 测试 |
| F3 | process_restarted 收敛扩为：running→waiting_user（现状）；stopping/interrupting→run_interrupted(reason: process_restarted)；消除 hasPendingCompactionRecovery 永真锚定 | runtime.mjs:452-490、journal.mjs:946 | stopping+压缩在途崩溃重放测试：收敛 interrupted、可 retry、可删会话 |
| F5 | 服务端 error 事件改退避重连（与网络断开同路径），连续 5 次服务端错误停止并出「连接中断」卡（区别「操作失败」）；重连成功清卡 | api.js:310-322/395-403、view.js:1533-1546 | 错误事件后流恢复；永久故障不无限重连 |
| F6 | updateWorkGroup 对已存在行按投影序重排（行级 insertBefore） | view.js:1042/1354-1377 | 跨页加载后 DOM 序=投影序 |
| F7 | newSessionPlaceholder 与 switchSession 快照失败路径通知 onPlanUpdated(null) | index.js:380-410/362-365 | 两路径后顶栏 chip 清空 |
| F8 | view.reset() 重置 rendered.notices | view.js:410-415 | A/B 会话同通知数时切换后 B 通知正常渲染 |
| F9 | isAgentRunning 与后端 409 判定扩为非终态集（与 hasNonTerminalRun 同口径）；阅读器 version panel 的 agentRunning 随 run 状态更新 | index.js:602-604、project-routes.mjs:452/508、app.js:495 | waiting_user/stopping 期间恢复按钮禁用；Run 结束后按钮解禁 |
| F10 | pending 气泡匹配弃用文本全等回退，改 FIFO 回填 input_id；POST 失败渲染在仍在 DOM 的节点 | view.js:539-555/2029-2044 | 同文本双发+第二次失败场景出现失败气泡 |
| F11 | state.plan 投影移除 active_run 在场门禁（与 work 投影口径一致） | state.js:104-111/406-427 | 尾页窗口 chip 与组内 plan 一致呈现 |
| F14 | reasoning empty 态文案改为不误导表述（「没有可查看的思考内容（本次无输出或该模型不支持）」类） | view.js:833-838 | 文案更新，三态契约不动 |
| F15 | thinking_ms 加上限钳制（时钟前跳防护） | work-items.mjs:362-366 | 前跳时间戳不出「思考数小时」 |
| F16 | win32 下 relativeProjectPath 段比较大小写不敏感（显示保持原样） | work-items.mjs:31-40 | 大小写不一致路径仍得相对路径摘要 |

## 任务拆分（建议实现序）

1. **Task 1 后端状态真实化**：F3、F2(journal 侧)、E(后端 sessions)、F9(后端 409 口径)、§4.3(事件发射)。
2. **Task 2 前端状态真实化**：F1、F2(前端清扫)、F4、F5、F12、F13、E(前端)。
3. **Task 3 叙述层**：N1(prompt)+N2(收尾淡化)+§4.3(前端行)。
4. **Task 4 渲染完整性与杂修**：F6、F7、F8、F10、F11、F14、F15、F16。
5. **Task 5 过程美化**：N3 全部 + 决定性视觉状态测试。
6. **Task 6 收口**：sim 全量（mock+脚本化叙述场景）、npm test 全绿、审计断言清单复核。

## 验收策略（无单独视觉验收轮）

- **可跑检查（每 Task 落地即留）**：F1-F11 各带最小回归测试（上表验收列）；叙述管线用脚本化 mock 场景（模型在工具间发叙述）断言气泡交错渲染与终态淡化；视觉层级用第十轮式决定性视觉状态测试钉住。
- **sim 全量 + `npm test` 全绿**为交付门槛。
- 用户单次人工验收：一次跑章 + 一次停止/重试 + 一次切换会话，覆盖三条主线。

## 风险与权衡

- **叙述上下文成本**：里程碑纪律约束，观察 context_usage 增速，必要时下轮收紧（已在 N1 记录缓解路径）。
- **F5 重连风暴**：永久性服务端错误退避重连必须带上限（5 次），否则从「流死」变成「无限重连」。
- **E 后端口径变更**：sessions() 报真实状态后，所有消费方（侧边栏 busy、诊断）必须显式适配非终态集，防止折叠副作用消失后 busy 语义漂移。
- **F9 后端 409 扩口径**：会拒绝以前放行的 waiting_user/stopping 期间操作（这正是目的），回归测试需同步预期。
