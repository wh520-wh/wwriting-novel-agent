# 2026-08-21 第十二轮过程可见性聚焦审计（只记录，修复排入第十二轮）

- 性质：**只记录**，为第十二轮（过程可见性 + 过程美化）供 bug 候选清单；关联 [[2026-08-18-ui-backend-consistency-audit]]（第十一轮母账）、[[2026-08-20-agent-progress-narration-terminology]]、[[2026-08-20-competitive-research]]。
- 方法：3 个只读 Explore 子代理并行分面审计（对话流链路 / 工作组+reasoning / 状态真实性），主代理对高危项逐条读源码复核。子代理均按第十一轮元发现 0 纪律做了 node -e 求值/码点级复核，两份报告附带运行时复现。
- 范围边界：只审第十二轮要动的面；已挂账 D 全量/E/G/H/M3/M4/M5 与第十一轮已修项未重复报告。

## 高严重度

### F1. 终态 Run 的流式叙述气泡永久悬挂（对话流）
`state.js:470-485`（run_failed）、`:496-525`（run_completed/cancelled/interrupted）、`:378-387`（run_status_changed）均不清 `state.assistantStream`；清理点仅 339/374/432/721 四处。停止/失败/崩溃后，半截正文气泡带 `data-streaming="true"` 与实心光标永久停留（形态上仍像「正在生成」）；重载后重放复现；点「重试」则该段正文被静默删除（既不入 conversation 也不留痕）。**直接打在第十二轮叙述层主题上：叙述一多此 bug 必现。**【主代理复核坐实】

### F2. 崩溃恢复留下永久 running 的僵尸工作项（journal 恢复批次不闭合）
两条同根路径：
- `journal.mjs:1287-1311` buildDanglingRecoveryBatch 只写 permission_grant_cleared + decision_resolved + run_interrupted，不闭合 openToolCalls/openModelTurns；`work-items.mjs:542-551` Run 终态只 setGroupStatus 从不清扫组内 running 项 -> 重启后「思考中」「正在读取文件」永不终结，reasoning 已落盘的部分思考文本因 running 门禁永远无法展开，状态随 journal 永久固化；retry 复活后僵尸项重新进入 live 闪烁名单。
- `journal.mjs:1338-1344` buildPriorityRecoveryBatch 闭合 turn 但不带 reasoning_completed（打破 work-items.mjs:374-382 的 no-op 断言）；`:1335` 恢复批次 tool_call_failed payload 无 activity_id、error 为对象 -> `work-items.mjs:268-273` toolItem 返回 null，事件被静默丢弃。
子代理 node 运行时复现：中断组内 reasoning:turn-1 永久 running。【主代理复核坐实】

### F3. 崩溃落在「停止窗口 + 压缩在途」时 Run 永久卡死 stopping（状态机收敛缺口）
`runtime.mjs:483` process_restarted 收敛条件只覆盖 `status === "running"`，stopping/interrupting 残留不收敛；`journal.mjs:946` context_compaction_cancelled 保留 pending_input_id 使 hasPendingCompactionRecovery 恒真，锚定保守中断被永久跳过。后果：停止按钮 60s 超时后静默失败（view.js:749-756 无提示）、会话不可删不可清、UI 永远「工作中」+ 计时递增；唯一「解法」是再发一条消息（且该消息会被 input_cancelled 静默吞掉）。触发窗口窄（秒级）但不可自愈。【主代理复核坐实】

## 中严重度

### F4. waiting_user 的 Run 没有任何恢复入口（状态真实性）
`runtime.mjs:2621-2623` retry 只接受 failed/interrupted；view.js:760 重试按钮同口径；压缩行 cancelled 状态零按钮（view.js:58-66）而后端 retryCompaction 明明支持 cancelled（runtime.mjs:2663-2668）。process_restarted 收敛注释承诺「等待用户 retry/cancel」，实际界面只有「停止」。恢复能力存在但不可发现。与 E（侧边栏状态）互补：E 让「待命」可见，本条让它**可操作**。【主代理复核坐实】

### F5. SSE 收到服务端 error 事件后事件流永久死亡不重连（连接韧性）
`api.js:395-403` dispatchBlock 遇 error 事件 return false；`api.js:316-322` `if (!shouldReconnect) return` 直接终止重连循环--网络断开会退避重连，服务端主动 error 反而不重连。且错误被渲染成「操作失败」错误卡（view.js:1533-1546），connection_error 无 seq 不入 loadedEvents、rebuild 后凭空消失。流死时 Run 状态冻结在最后一帧（「工作中」可能永久显示）。【主代理复核坐实】

### F6. 工作组行 DOM 顺序从不重排（渲染完整性）
`view.js:1042` 一律 append、`:1354-1377` 只缺则建有则更新，无行级 insertBefore。长会话上滚前置分页后，更早的工具行排在组内最底部（投影序正确、DOM 乱序）；plan「移动到最新位置」契约在 DOM 上完全不生效。

### F7. plan chip 在 newSessionPlaceholder / 快照失败路径残留（对话流）
onPlanUpdated 全仓只有 2 个调用点（index.js:197/209）；`index.js:380-410` newSessionPlaceholder 只 resetState+view.reset 不通知 -> 有计划的会话点「新对话」后顶栏 chip 残留旧计划；switchSession 快照失败同样残留。第十一轮 B 项只覆盖了 applySnapshot 路径。【主代理复核坐实】

### F8. view.reset() 漏 rendered.notices：切会话后系统通知行丢失（对话流）
`view.js:410-415` 重置列表唯独没有 notices；syncNotices 以 revision 全等做门禁（:2238-2253）-> A/B 会话通知数恰好相同时 B 的通知一条不渲染。node 复现：A 显示 1 条、切 B 后 0 条。

### F9. isAgentRunning 只认 running + 阅读器面板一次性求值（门禁口径）
三处 `status === "running"` 字面同口径，但与后端串行门 hasNonTerminalRun 不同口径：waiting_user/stopping 期间「恢复此版」放行（409 兜底）；app.js:495 面板存续期不随 Run 状态更新（结束后按钮仍禁用）。

### F10. 同文本输入 pending 气泡被误删、POST 失败反馈不可见（对话流）
reconcilePendingSubmission 文本全等回退匹配（view.js:539-555）+ 失败路径写死在已脱离 DOM 的节点（:2029-2044）。触发需「完全相同文本 + 队列事件 + 请求失败」三重组合，命中率低。

### F11. 部分窗口下 plan 双投影不一致（工作组）
state.plan 投影包在 active_run 门禁里（state.js:406-427），work 投影不依赖 run_started 在场（work-items.mjs:483-507）-> 尾页窗口三面两真一假（chip 隐藏、组内 plan 在）。上滚补页自愈。

## 低严重度（本轮只记录，不排修复）

- **F12**. stopping/interrupting 无专属状态文案：组状态一律「工作中」、计时继续（work-items.mjs:141-149 无 case；view.js:819 计时含 stopping）。按停止后的收敛窗口内与事实不符。**建议随第十二轮状态真实化一并做（文案级改动）。**
- **F13**. 工具项 waiting「等待确认」是死代码：决策挂起时工具行仍「正在写入文件」（work-items.mjs 全文件不产生 waiting 态）。**建议随第十二轮一并接线（与决策卡联动）。**
- **F14**. unknown 能力模型 empty 文案「本次没有可查看的思考内容」归因误导（真话更接近「当前模型不支持查看」）；冻结契约明文如此，属 UX 取舍。
- **F15**. thinking_ms 只防负值/NaN 不防时钟前跳（work-items.mjs:362-366）。
- **F16**. Windows 路径大小写不一致时相对路径回退绝对路径（work-items.mjs:31-40）。
- **F17**. syncNotices 移除行不清 timelineSeqs（微量内存滞留，无功能影响）。
- **F18**. project-diagnostics runningCount 把终态 Run 计为 1、waiting_user 提示文案相悖（无 app-shell 消费方）。
- **F19**. retry 后前端镜像不恢复 active_input_id（无 UI 消费者，快照自愈）。
- **F20**. priority_input_requested 本地标记可被并发快照覆盖（后端 409 兜底自愈，窗口窄）。
- **F21**. 超长单轮流式 + 首屏 tail 页截断：流式气泡只见尾部增量，completed 全文自愈。
- **F22**. 侧边栏对 running/interrupting/stopping 无区分（E 机制的事实补充；前端能正确显示「待命」的唯一路径是对话内工作组状态行）。

## 附：死代码/信息性备注（不修，记录在案）

- start_seq/terminal_seq 只写不读（全 app-shell 无消费者）；getVisiblePlan 死导出（state.js:752）。
- 恢复批次 tool_call_failed payload 形状即使补 activity_id 也只能渲染「调用 unknown 失败」--与 F2 一并修才完整。

## 已查无发现的面（子代理覆盖声明）

多轮叙述气泡 seq 排序、空文本轮次边界、completed 全文 vs delta 冲突口径、truncated 渲染、时间线乱序稳定性、event_key 去重、快照/增量衔接无双重累积、队列 priority 展示、reasoning 脱敏前后端一致性、停止按钮移动/重渲、expanded/userToggled、duration 时钟同源、工具行渲染与截断、plan_updated 投影本体、run_status_changed reducer 强校验、决策卡与 waiting_user 联动、错误码可读呈现（compaction_source_exceeds_window/context_window_exceeded）。

## 主代理复核记录

F1/F2/F3/F4/F5/F7 六条由本人读源码逐条坐实（文件:行号与断言一致）；F6/F8-F11/F12-F22 采信子代理报告（其中 F6/F8/F10/F11 附 node 运行时复现，F8 为端到端复现）。按第十一轮元发现 0 纪律，本轮无任何字符串级「源码损坏」类结论，无需码点仲裁。

## 第十二轮修复优先级建议（供用户筛）

1. **叙述层主题（已锁）**：prompt elicitation + 排版 + **F1**（悬挂气泡是叙述通道自身的 bug）。
2. **状态真实化主题**：E + §4.3 + **F2 + F3 + F4**（崩溃/等待后的可恢复性与真实性，与 E 同族）+ **F5**（流死是状态谎言的放大器）+ **F12/F13**（文案与接线级）。
3. **美化顺手修**：**F6 + F7 + F8**（渲染完整性与残留，美化动同一批文件）。
4. **缓修/记录**：F9-F11、F14-F22。

## 2026-08-21 第十二轮修复记录（Task 14 收口复核，全项已修）

- **N1 叙述层 elicitation 已修**（a2d79fb）：`prompt.mjs` STATIC_CORE 引入里程碑级过程叙述政策，与「不只口头承诺」并行不冲突。**上下文成本基线（收口观察，下一轮对照）**：mock 用户流程场景 `events5` 内 `context_usage_updated` 共 20 个事件，`used_tokens` 首末值 6071→8323（差 2252），按任务口径「首末值差/轮数」= **≈113 tokens/轮**（本地估算含 1.08 系数 + 256 常项，`approximate:true`）。mock 确定性网关即发该事件（主流程 events5 内 20 条），真实模式此基线留待真实 API 补测校准；本轮**不做阈值判断**，仅记录为下一轮收紧对照。
- **N2 叙述排版与收尾已修**（00acce0 + 6f3ae8f）：Run 内非最终叙述气泡终态淡化一档，最终一条保持权重；`reasoning` empty 空文案纠偏（见 F14）。
- **N3 过程美化已修**（c107705 + 112d329）：三层视觉层级、状态语义色（running/completed/failed/cancelled/waiting_user 三处同色 token 化）、信息密度分级、动效收敛。
- **F1 已修**（b762dfd + 7f1f04d）：Run 终态定稿流式叙述气泡（含 run_status_changed 终态防御），retry 不再静默删正文。
- **F2 已修**（862a787）：崩溃恢复闭合孤儿 tool call/model turn，前端终态清扫 running 项。
- **F3 已修**（ecda698 + 0587c81）：process_restarted 收敛覆盖 stopping/interrupting，崩溃不再永久卡死 stopping。
- **F4 已修**（c9eaaad）：待命恢复入口可发现（等待确认接线 + 压缩行重试按钮）。
- **F5 已修**（8411ad4 + 888efce）：SSE 服务端错误退避重连（上限 5 次），错误卡区分连接中断，重连成功清卡。
- **F6/F7/F8 已修**（3163715 + c223dad 审查修补）：工作组行序对齐投影、plan chip 全路径清空、notices 跨会话重置。
- **F9 已修**（861c553 + 6a0f283 + b0be005）：恢复类操作门禁扩为非终态集，阅读器恢复点击复查。
- **F10/F11 已修**（40e3020 + fcb3b2c）：pending 气泡 FIFO 回填、plan 尾页投影口径统一。
- **F12/F13 已修**（c9eaaad + ead912a）：stopping「正在停止」/interrupting「正在中断」文案；等待确认同步更新工具行标签。
- **F14 已修**（00acce0）：reasoning empty 文案为「没有可查看的思考内容（本次无输出或该模型不支持）」，三态契约不动；USER_GUIDE / 写作Agent对话样式规格书 / AICSS 移植规格书同步文案。
- **F15/F16 已修**（40e3020）：thinking_ms 时长钳制防时钟前跳；win32 `relativeProjectPath` 段比较大小写不敏感。
- **E 待命可见已修**（6c4cb2e）：侧边栏报真实运行状态，busy 口径对齐非终态集，run 状态变化事件驱动刷新。
- **§4.3 重试可见已修**（ee330e0 + 8f1ea03）：网关重试经 `provider_retry` 事件可见「重试 n/m」，`FIXED_EVENT_TYPES` 计数连带 +1。
- **未修项**：无。F17-F22 属缓修记录（规格「非目标」明列，不排本轮）；真实 API 上下文成本基线留待真实模式补测。

### 收口新增：Node v25 FileHandle GC 根治（Sundry A）

`journal-segments.mjs` 原在 `load()` 末尾 eager open 一个活动段写句柄常驻 `activeSegment.fd`；会话加载后若再无 append，该打开句柄随 store 被 GC 时被回收，Node v25 报 `A FileHandle object was closed during garbage collection`（未显式 close）。最小根因修复：load 不再常驻打开，句柄生命周期完全惰性（append 写入前按需重开、rotate 在 fd 为 null 时以 `r+` 重开做 fsync），无任何读取路径依赖预开句柄——行为不变、消除 GC 泄漏。`journal-recovery` + `project-agent` 两文件级 fail 消失（178/178 通过）。

- 已知环境 flake：tests/agent/compaction.test.mjs 全量并行时偶发 ENOTEMPTY rmdir（teardown 竞态，单跑稳定，下轮可考虑 h.cleanup 容错）。

## 2026-08-22 补测：N1 真实 API 上下文成本基线（收口遗留项闭环）

第十二轮收口时 mock 基线 ≈113 tokens/轮（events5 内 20 个事件），真实模式留待补测。本日经 opencode zen 网关（deepseek-v4-flash，`MODEL_BASE_URL` 环境变量接入，sim 脚本新增支持）跑两遍真实用户流程（`npm run sim:user-flow`），口径与 mock 完全一致：全量快照内 `context_usage_updated` 的 `used_tokens` 首末差 / 事件数。

| 样本 | 耗时 | 结果 | 事件数 | used_tokens | 基线 |
|---|---|---|---|---|---|
| 一 | 184s | 13/14（章节写到根级 prologue_draft.md，交付断言字面失败） | 116 | 6071 -> 17633 | ≈99.7 tokens/轮 |
| 二 | 595s | 14/14（chapters/第一章.md 交付 + 记忆三件套维护） | 66 | 6071 -> 70796 | ≈980.7 tokens/轮 |

- **结论**：真实两样本相差一个数量级，每轮增长的主要驱动是**工具结果体量**（样本二写了整章，正文随 write_file/回读进入上下文），叙述政策本身（STATIC_CORE 固定政策文案 + 模型叙述输出）不是主导项。下一轮「收紧对照」应在**同流程**下对比（mock 定脚本，或真实运行控制章节长度），不能拿两次独立真实运行的原始值直接比。mock 基线 113 与样本一（短篇流程）同量级。
- **叙述行为两样本均成立**：写正文/初始化前存在里程碑叙述正文经 assistant 通道流出（「收到 /init，我先检查工作区里有没有已存在的项目配置…」「我先创建好项目基础目录，再写章节…」），seq 均先于对应 write_file 完工事件。
- 顺带观察：真实模型行为方差大（样本一 54 次工具调用、大量 list_files 探索、自创根级路径；样本二 49 次调用、大量 search_files、标准 chapters/ 惯例）；校准链路正常（`approximate` true/false 混合，provider usage 的 EMA 校准生效）；网关 cache_hit_rate 样本一 0.92 / 样本二 0.61。两样本均无 run_failed / blocked，主链路 4 个 run 全部完成。
- 测量脚本沉淀：`scripts/measure-context-baseline.mjs`（journal events 目录 -> 基线 / 分轮增长 / 叙述行为提取），下一轮对照直接复用。
- sim 脚本适配（两处）：`MODEL_BASE_URL` 支持任意 OpenAI 兼容网关；「章节已交付」断言兼容根级 .md 交付（排除 WWRITING.md / book_summary.md / WORKLOG.md 非章节文件），「反问/空谈不算交付」判定不变（成文 + count_text 客观核对组合）。

## 2026-08-22 环境收尾：两个已知 flake 修复 + 状态回写

- **compaction.test.mjs ENOTEMPTY（上节已知 flake）已修**：teardown 的 recursive rm 改走 `rmTree`（`fs.rm` 的 `maxRetries: 10, retryDelay: 100` 线性退避--Windows 句柄延迟释放竞态的标准库容错，默认 maxRetries=0 不重试）。harness 两个 cleanup 与 compaction 测试的直连 teardown 统一走它（`makeTmpDir` 内注册 `t.after`）。3 连跑 38/38 稳定。其余测试文件的直连 `fs.rm` 未动（无观察到 flake，`rmTree` 可后续渐进采用）。
- **tools.test.mjs 假时钟用例偶发超时已修**（第十一轮验收报告记录项）：定长 `sleep(30)` 等定时器注册在并行负载下会输给调度竞态（advance 先于注册 -> 定时器永不到期 -> 挂到 15s 超时）。改为轮询 `fake.pendingTimers()` 直到空闲+绝对两个期限定时器注册完成（tools.mjs supervisor 内同步连续注册，计数精确为 2）再 advance。3 连跑 68/68 稳定。
- **文档状态回写**：WWRITING.md「当前进度」补第十一、十二轮；第十二轮规格状态行「待实现」->「已实现并收口」。
- **全量回归**：`npm test` 1914/1914 通过（0 失败，71s）。
