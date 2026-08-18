# 2026-08-18 自动压缩（compaction）模块审计记录

- 性质：**只记录，不修复**（用户明确指示）。关联：[[2026-08-18-real-api-stress-check]]（事故链与已修部分）。
- 审计范围：`compaction.mjs`（协调器）、`context-window.mjs`（门禁/估算/校准）、`runtime.mjs` 压缩源材料与预检段、`context-checkpoints.mjs`（提交时序）、`compaction-prompt.mjs`（保护窗口选择）、`model-identity.mjs`（窗口解析）。
- 方法：全文件通读 + 对照 2026-08-18 真实事故的 journal 事件逐帧核对（事件 3330-3343）。

## 结论

骨架正确，工程纪律高（事件单写者、WAL 级提交时序、故障注入测试、取消竞态显式裁决）。存在一个**设计盲区**与一个**外部假设风险**，均已量化触发条件，暂不修复。

## 判定为正确的部分

1. 门禁分层：软阈值 204,800（窗口 80%）触发压缩；`估算+32k 输出余量 ≥ 窗口` 才硬失败；每输入至多压缩一次；压缩后仍超硬窗口才 failRun（`context-window.mjs:68-77`、`runtime.mjs:1680-1690`）。
2. 协调器事件纪律：压缩事件单写者；固定 payload 字段完整性守卫；取消竞态 I5（指针切换后绝不误报取消，避免双终态）；attempt 1 对瞬时传输错误（network/timeout/429/5xx）才自动重试一次；进程重启后凭 journal 事件重建 entry（`compaction.mjs`）。
3. 检查点提交时序：writeJsonAtomic -> hash 读回复核 -> 提交 marker（预写 event_id）-> 原子指针替换 -> 指针后步骤 best-effort 交 `reconcileAfterCrash` 裁决（`context-checkpoints.mjs:460` 起），每步带故障注入 hook。
4. 防递归：摘要轮次按 `COMPACTION_SOURCE_BUDGET_RATIO=0.5` 窗口预算封顶、保护轮在源材料里只带 200 字符预览、压缩请求自身超窗快速失败（`compaction_source_exceeds_window`，不发 provider）（`runtime.mjs:863-995`）。
5. 保护窗口语义：默认保护 12 轮/下限 2 轮/未闭合工具链不可驱逐；驱逐判定用摘要化后的 token（注释明确"驱逐判定不得使用原文 token"）（`compaction-prompt.mjs:286-331`）。
6. 实测背书：2026-08-18 修复后 19 万 token 峰值正常运转、四章连写零失败。

## 发现 1【设计盲区，中危】volatile 大工具输出是压缩的盲区

事故链（journal 3330-3343 已逐帧核对）：

1. `persistentToolResult` 持久化 transcript 时**剥掉 read_file 正文只留 content_length**（read_skill/shell stdout/stderr/search excerpt 同理，`runtime.mjs:1020-1046`）；
2. 压缩重建轮次（`buildTurnsFromTranscript`）因此看不到大输出，"少数轮次 + 超大工具输出"逃生舱（`runtime.mjs:853-861`，靠 `summarized_output===true` 触发）对这些工具**永远不触发**--而它们恰是唯一能产生大输出的工具；
3. 真实占用来自装配时无条件追加的 volatileRecords（`runtime.mjs:675`），压缩对它无能为力 -> noop -> 仍超硬窗口 -> run_failed；
4. 下一条输入 volatile 过期 -> 自愈。这就是 2026-08-18 事故的第二根因（第一根因 read_file 1MB 上限已修，`MAX_TOOL_RESULT_CHARS=100k`）。

**残余触发面**：大会话历史（约 9 万 token 以上）+ 一次新鲜满额（100k CJK）读取仍会走 noop->failRun->自愈。

**若将来修复的方案**（已想清，未实施）：装配时对 volatile 工具记录套用与 transcript 轮次相同的 2000-token 摘要化（超阈值降级为摘要 + journal 引用），盲区即闭合。

**dogfood 识别特征**：run_failed(context_window_exceeded) + 下一条消息自愈 + journal 里紧邻 `context_compaction_noop`。

## 发现 2【外部假设，中危，当前被预设掩盖】上下文窗口一刀切 256k

`model-identity.mjs`：只解析模型 ID 尾标 `[1m]`（->1M），其余**一律按 256k**，无按模型查表、无 API 反馈学习。当前安全仅因 DeepSeek/MiMo 预设真实窗口够大（2026-08-18 实测 19 万 token 请求通过）。

若接入真实窗口 <224k 的 provider（市面常见 128k）：

- 预检放行（估算低于错误的 256k 口径）；
- 压缩永不触发（真实限制低于 204,800 阈值，估算永远先撞 API 而不是阈值）；
- API 400 且 adapter 无"input too long"类错误映射（`openai-compatible.mjs` 只处理输出侧 finish_reason=length），作者看到不可诊断的失败。

**前置条件**：接入任何新 provider 前必须解决（按模型查表，或把 provider 超长错误反馈进窗口口径）。

## 小刺（低危，记录在案）

- `compactionThresholdOf` 只有两档（256k/1M），窗口取其他值时阈值 204,800 可能高于 0.8×window 甚至 window 本身；`shouldCompact` 第二条件兜底，实际影响小。
- `observeProviderUsage` 校准夹在 0.5-2.0，极端 tokenizer 差异会低估；有 1.08 系数与 32k 余量垫底。

## 复查锚点

- 逃生舱判定：`runtime.mjs:853-862`；volatile 装配：`runtime.mjs:648-676`；transcript 剥离：`runtime.mjs:1020-1048`。
- 相关测试：`tests/agent/compaction.test.mjs`（含 summarize_output 断言 271/302/334）、`tests/agent/context-checkpoints.test.mjs`、`tests/agent/context-window.test.mjs`。
