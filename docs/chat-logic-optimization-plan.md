# WWriting 对话逻辑与健壮性优化计划 v2

> 执行对象：本计划交给另一个编码模型执行。所有"现状"均标注了 `文件:行号`，行号可能随改动漂移，以符号名为准。
> 项目根目录：`D:/WWriting`。技术栈：Electron + Node（ESM，`src/core` 后端，`src/app-shell` 前端），无构建步骤，前端是原生 JS 模块。
> v2 变更：在 v1（删限制 + 卡片折叠）基础上，新增 bug 修复清单（§3）、中断恢复与重试体系对标 Codex 的打磨方案（§4）、Codex 差距总表（§7）。

---

## 0. 背景与总目标

本项目的对话体系由三套并行记录组成：

1. **聊天线程**：`chat_history.jsonl`（`src/core/chat/chat-store.mjs`），角色 `user` / `assistant` / `tool`；
2. **写作流水线**：`agent_state.json` 状态机 + `run_log.jsonl` 事件流 + `checkpoints/*.json` 快照（`src/core/agent-engine.mjs`）；
3. **记忆层**：`memory/book_summary.md`、`memory/continuity.md` 等。

**当前三类问题**：

- **草案期遗留的硬限制**不利于 agent：默认 200 次模型调用上限、chat 工具循环最多 8 轮、一次只执行第一个 tool call、每章最多 4 次修订、工具结果摘要截断 500 字等。主流 agent 工具（Codex CLI、Claude Code、Cursor）没有这类低上限硬闸门。
- **中断恢复靠人肉**：崩溃/断电后必须用户自己发现"已中断"并点重试；传输层重试不读 `Retry-After`、无总 deadline；长模型调用被误判"卡死"；存在若干会导致状态不一致的崩溃窗口。
- **对话流 UI 空间被卡片挤占**：章节完成卡、任务卡、工具卡全部展开渲染，不可折叠。

**总目标**：对标 Codex CLI / Claude Code 的健壮性水准——**崩了能自己爬起来，卡了能自己重试，用户永远知道 agent 在干什么**；同时去掉不合理的默认限制，释放 agent 能力；卡片可折叠，释放对话空间。这个工具的定位不变：专门写作的 agent。

**已核实的好底子（不要动）**：状态机按 stage+segment 断点续跑、segment marker 幂等去重（`tool-runtime.mjs:62-73`）、finalize 临界区保护（`agent-engine.mjs:547-549`）、`writeFileAtomic` + rename 重试（`fs-utils.mjs:50-94`）、故障卡→处置动作链路、心跳单一事实源 `computeAgentTruth`。这些是成熟 agent 的骨架，本计划只补缺口。

---

## 1. 执行前基线（必做）

```powershell
# 记录通过/失败清单作为基线，后续改动不得引入新失败
npm test
```

通读以下文件后再动手：

- `src/core/model-client.mjs`、`src/core/provider-adapters.mjs`（传输层重试）
- `src/core/chat/chat-agent.mjs`、`chat-store.mjs`、`agent-protocol.mjs`、`chat-context.mjs`（chat 链路）
- `src/core/agent-engine.mjs`（状态机、预算闸门、写作循环、记忆提取）
- `src/core/event-log.mjs`、`src/core/retry-candidates.mjs`、`src/core/failure-actions.mjs`（事件与恢复）
- `src/core/app-server.mjs`（API、job 管理、心跳、关停）
- `src/app-shell/thread-renderer.js`、`src/app-shell/agent-truth.mjs`（UI）

---

## 2. P0：删除/放宽草案期遗留限制

### 2.1 模型调用上限默认 200 → 默认不限

**现状**：`agent-engine.mjs:1719-1726` `withBudgetDefaults()` 里 `max_model_calls: 200`；`project-store.mjs:79` 新建项目同值；耗尽即 `blockProject("model_call_budget_exhausted")`（`agent-engine.mjs:1638-1648`）；顶栏显示"8/200 调用"（`app-shell/app.js:833`）。

**改动**：
1. 两处默认值 `200 → null`（`consumeModelCallBudget` 已有 `Number.isFinite(maxCalls)` 判断，null 天然跳过封顶，确认无需额外改动）。
2. `app-shell/app.js:833`：上限为 null 时顶栏只显示 `8 调用`，不显示 `/∞`。
3. `app-shell/settings-modal.js:700` "模型调用上限"输入框保留，placeholder 改"留空 = 不限"。
4. `app-dashboard.mjs:104-105`、`app-shell/drawer-panels.js:161` 同步处理 null 显示。

**涉及测试**：`tests/budget-caps.test.mjs` 及 grep `max_model_calls` 命中的测试——"默认 200 封顶"断言改为"默认不封顶，显式设置后仍封顶"。**显式封顶行为必须保留且有测试覆盖**（用户自选的防跑飞保险）。

### 2.2 每章修订轮次默认 4 → 默认不限

**现状**：`agent-engine.mjs:1724`、`project-store.mjs:81` `max_revision_rounds_per_chapter: 4`，耗尽即 block（`agent-engine.mjs:1687-1700`）。

**改动**：默认值改 `null`，逻辑同 2.1。设置项保留（`settings-runtime.mjs:438`、`config-runtime.mjs:137`）。

### 2.3 chat 工具循环 8 轮上限 → 提高且可配置

**现状**：`chat-agent.mjs:11` `MAX_TOOL_ROUNDS = 8`；`chat-agent.mjs:71,91` 到顶强行收尾。注意 `chat-agent.mjs:91` 的轮数判定有口径混乱（`round` 与 `toolEvents.length` 双重计数，工具被拒/失败也占额度，实际可用轮数比 8 少）。

**改动**：
1. 默认 `32`，从运行时配置读取（key `chat_max_tool_rounds`，走 `config-runtime.mjs` 现有链路）。
2. 顺带修正双重计数：统一以"实际执行的工具调用次数"为准，被拒绝/失败的调用不占额度。

### 2.4 支持一次回复多个 tool calls

**现状**："一次只取第一个"——`agent-protocol.mjs:2,7`；`agent-engine.mjs:1198` 写作循环同样只取 `tool_calls[0]`。模型想读 3 个文件得来回 3 轮。

**改动**：
1. `agent-protocol.mjs`：解析返回 `tool_calls` 数组全部元素。
2. `chat-agent.mjs` `agentLoop`：一轮内顺序执行全部 read 类工具并逐条落盘 `role:"tool"` 消息；**遇到第一个 write/control 类工具即挂 pending，其后工具丢弃并在落盘消息注明 `skipped_after_pending`**（"写操作先确认"语义不变）。
3. `agent-engine.mjs:1198` 写作循环保持每轮一个工具（"提交一段正文才算数"语义不适合并行），注释更新为有意为之。

### 2.5 连续 3 次提交失败即阻断 → 放宽 + 失败反馈完整化

**现状**：`agent-engine.mjs:1379-1382`，`append_chapter_segment` 连续 3 次校验失败 → `ProjectBlockedError`。

**改动**：阈值提高到 `8`（配置 key `writing_max_segment_retries`）；确认每次失败的完整校验原因经 `agent_loop_feedback` 注入下一轮 prompt（`agent-engine.mjs:1133,1346-1353`）且无截断。到顶仍走故障卡，不变。

### 2.6 工具结果摘要 500 字截断 → 提高

**现状**：`chat-agent.mjs:173-176` `summarize()` 截 500 字符落盘；模型下一轮只能看到残篇，"读完就失忆"。

**改动**：落盘截断 `500 → 4000`；`chat-context.mjs` 拼 prompt 时对历史 tool 消息二次裁剪（单条 >4000 压到 1000，最近一条保留全文）——当轮看得全，上下文不爆炸。

### 2.7 历史窗口与读盘上限放宽

**现状**：`chat-store.mjs:18` 读盘 200 条；`chat-context.mjs:7` `HISTORY_WINDOW = 20`，digest 每行 80 字。

**改动**：读盘 `200 → 1000`；窗口 `20 → 40`；digest 每行 `80 → 160`。digest 机制本身保留（长项目防爆炸的正确设计）。

---

## 3. P0：Bug 修复清单

以下 bug 均为本次代码排查实锤，按严重度排序。每条独立可修、独立可测。

### 3.1 [高] 心跳只在 step 边界更新，长模型调用被误判"卡死"

**现状**：`job.lastHeartbeat` 只在 step 边界 `onHeartbeat` 更新（`app-server.mjs:1700-1704`）；而一次模型调用最坏 4 次重试 × 120s ≈ 9 分钟。`computeAgentTruth` 在心跳 >60s 即显示"疑似卡住"+停止按钮（`agent-truth.mjs:31-33`）。**一次正常的长推理（如 DeepSeek reasoner 写长段落）就会诱导用户停掉健康任务。**

**修法**：`model-client.mjs` 的流式读取循环里，每收到一个 SSE chunk 调一次注入的 `onActivity()` 回调；`app-server` 把该回调接到 `job.lastHeartbeat` 更新上。`computeAgentTruth` 判定逻辑不变（数据变准了，不是阈值放宽）。非流式路径在每次重试 attempt 开始时也回调一次。

**测试**：模拟 90s 流式响应，断言 `computeAgentTruth` 不产出 `slow/stale`。

### 3.2 [高] run_log.jsonl 写一半 + 读取端不容错，一行坏数据击穿恢复链路

**现状**：`appendEvent` 裸 `fs.appendFile`（`event-log.mjs:18`），崩溃可留半行 JSON；`readEvents` 两条路径裸 `JSON.parse`（`event-log.mjs:33,69`），解析失败直接 throw——`findFreshPauseRequest`（`agent-engine.mjs:258-269`）、`readLatestUserInstructions`（`agent-engine.mjs:1166-1176`）、dashboard 全部会被打死。对比 `readChatHistory` 有逐行 try/catch（`chat-store.mjs:23-25`），两处标准不一致。

**修法**：`readEvents` 改为逐行 try/catch，坏行跳过并累计 `skipped_lines` 计数（>0 时记一条 warn 日志/事件）；与 `readChatHistory` 对齐。可选：追加写前 `JSON.stringify` 后加 `\n` 已是单行原子追加，无需改写侧。

**测试**：构造含半行坏数据的 run_log，断言 pause 检测、user instruction 读取、dashboard 均正常工作。

### 3.3 [高] resumeChatTurn "执行→清 pending" 非原子，崩溃致写工具重复执行

**现状**：`chat-agent.mjs:44-56` 先 `executeTool` 后 `clearPendingAction`。崩溃落在两者之间 → 重启后确认卡复活 → 用户再点批准 → `edit_chapter` 二次改写、`rewrite_chapter` 重复入队。无幂等机制。

**修法**：pending action 增加 `idempotency_key`（创建时生成 UUID）；`executeTool` 前把 `{ key, status:"executing" }` 原子写入 pending 文件；工具执行成功后写 `{ status:"executed", result }`；`resumeChatTurn` 开头检查：若 pending 已是 `executed` 状态（按 key），跳过执行直接走"把已存结果落盘"分支。即"两阶段提交"式的最小幂等，不需要改工具本身。

**测试**：模拟"执行成功但 pending 未清"的恢复场景，断言重进 resume 不二次执行。

### 3.4 [中] chat 崩溃半轮无标记：用户消息发了没人理

**现状**：进程在 `agentLoop` 中途崩溃（非用户 abort）→ user 消息已落盘、无 assistant 回复、无 pending。重启后界面显示一条没有回应的用户消息，无任何提示也不续跑（`chat-agent.mjs:34-35`）。另外 `runChatTurn` 抛错（重试耗尽）时也不落任何 assistant 错误消息（`chat-agent.mjs:79-83` rethrow），刷新后同样"发了没人理"。

**修法**：
1. `runChatTurn` 开头先写 `{ role:"assistant", content:"", status:"generating", turn_id }` 占位（或单独的 `chat_turn_state.json`），正常结束覆写为正式回复；catch 里落 `{ role:"assistant", content:"（本轮失败：<错误摘要>，可重发）", status:"failed" }` 再 rethrow。
2. UI 加载历史时遇到末尾 dangling 的 `generating` 占位（进程已死），渲染为"上一轮被中断"条 + "重发"按钮（重发=把上一条 user 消息重新走 `runChatTurn`）。

**测试**：模拟崩溃遗留，断言 UI 显示中断条且重发可用。

### 3.5 [中] 预算次数与成本在崩溃点永久不一致

**现状**：`consumeModelCallBudget` 先扣 `model_calls` 再调用（`agent-engine.mjs:1669-1671`）；崩溃后次数已扣但 `cost.json` 的 token/成本没记（`writeProjectReport` 在 generate 成功后才执行，`agent-engine.mjs:952-954`）。

**修法**：generate 失败/崩溃路径补记一条 `cost.json` 记录（`status:"failed"`，token 计 0 或用 provider 返回的部分 usage）；`writeProjectReport` 汇总时单列"失败调用次数"。同时把失败重试的 usage 损失显式化：`model-client.mjs:106` 目前只在成功后 `costTracker.record`，改为在每次 attempt 后若 provider 返回了 usage 就记录（部分 provider 在 429/5xx 响应里也带 usage）。

### 3.6 [中] 记忆提取三步非原子，崩溃重跑产生重复/冲突事实

**现状**：`agent-engine.mjs:628-634` `saveContinuity` → 写 book_summary → `saveContinuityState` 三步独立原子写。崩溃在中间 → 水位未推进 → 重跑提取；`mergeExtraction` 按 entity+attribute+value 去重（`continuity-store.mjs:43-58`），但模型两次提取措辞不同就会产生重复事实或 `conflict_with` 假阳性。

**修法**：提取结果先落 `memory/.pending-extraction-<chapter>.json`；成功完成全部三步后删除该文件；启动/恢复时若发现 pending extraction，按"已落盘部分跳过、未落盘部分补跑"完成剩余步骤（幂等收尾），而不是整章重跑提取。

### 3.7 [低] `accept-current-words` 在 drafting 阶段误报"已接受"

**现状**：`failure-actions.mjs:44` 只在 stage ∈ `reviewing/needs_revision/revising` 时推进 finalizing；其他 stage 静默无操作但仍返回 `resumeRun: true` + "已接受当前稿"——误导。

**修法**：非目标 stage 返回明确的错误消息（"当前阶段无草稿可接受"），不触发 resume。

### 3.8 [低] `readJsonBody` 超限截断后报模糊 400

**现状**：`app-server.mjs:1911-1920` 200KB 截断后直接 `JSON.parse`，大概率报解析错误而非"内容过大"。

**修法**：超限立即返回 413 + "请求体过大"；未超限时 parse 失败才报 400。

### 3.9 [低] `server-fatal` 命名误导

**现状**：`provider-adapters.mjs:56` 把 4xx（客户端错误）命名为 `server-fatal`，日志/事件语义误导排查。

**修法**：改名 `client-fatal`（grep 全库同步，含 `model-client.mjs:149-154` 的 `#isRetryable` 与事件 label `src/app-shell/utils.js` 附近）。纯改名，行为不变。

### 3.10 [存量] 桌面壳端口回退 stash 未合入

**现状**：UAT §5-3 记录：基线 stash `uat-execution-baseline-stash`（含 `listenWithFallback`）未合入，**4173 端口被占用时桌面壳硬失败**。

**修法**：先 `git stash show -p` 确认内容，与用户确认后合入（属于 git 变更，执行模型须先询问）；合入后跑 `verify:desktop-shell`。若用户不同意合入，至少在桌面壳启动失败时给出"端口被占用"的明确提示而不是硬崩。

---

## 4. P1：中断恢复与重试体系（对标 Codex）

Codex CLI / Claude Code 在这件事上的行业标准做法：**① 传输层自动重试读 `Retry-After`、有总 deadline；② 会话可 resume（`codex resume` / `claude --continue`），重启后接着上次跑；③ 每轮完整落盘（rollout/transcript），崩溃不丢上下文；④ 中断状态在 UI 一等公民化（明确显示、一键继续）**。本项目已有 ②③ 的骨架，按以下补齐。

### 4.1 启动时自动恢复（最高优先级，对标 `codex resume`）

**现状**：崩溃/断电后 `agent_state.json` 停在 `project_status:"running"`、`task_queue.json` 任务停在 `running`；**没有任何代码在服务启动时扫描恢复**。恢复完全依赖用户看到 `computeAgentTruth` 的"已中断"提示后手动点重试 → `/api/run/retry` → `resolveRetryCandidate`（`retry-candidates.mjs:29-32,42-55`）→ 建 recovery task（`app-server.mjs:1450-1477`）。这条手动链路本身是好的，不要改，只做自动化。

**改动**：
1. `app-server.mjs` 启动流程末尾加 `recoverInterruptedProjects()`：扫描 `recentProjects`（`app-state.mjs`），对每个项目检测崩溃残留（复用 `resolveRetryCandidate` 的两种判定：`stale_queue_task` / `project_state` running 但无存活 runner）。
2. 检测到残留 → **不自动续跑**，而是把该项目标记为 `recovery_pending` 并注入 dashboard 数据；前端在项目卡/顶栏显示醒目横幅："上次写作被中断，从第 N 章第 M 段继续？ [继续写作] [查看状态]"。点"继续写作"走现有 `/api/run/retry` 链路。
3. 设置项 `auto_resume_on_start`（默认 `false`）：开启后启动即自动续跑，无需点击。默认 false 是因为续跑=烧钱，必须用户知情——这也是 Codex 的行为（resume 是显式命令）。
4. 判定"无存活 runner"的依据：进程内 job 注册表 + 心跳时间戳（复用 `agent-truth.mjs` 的判定，避免两套标准）。

**测试**：模拟 state=running + 无 runner 的启动，断言横幅出现、点击后续跑、auto_resume 开启时自动续跑。

### 4.2 传输层重试打磨（对标 Codex 的 retry 策略）

**现状**（`model-client.mjs:68-146`）：已有指数退避（1s 起步 ×2、jitter、封顶 16s、最多 4 次）+ 五档错误分类（`provider-adapters.mjs:39-62`），骨架合格。四个缺口：

1. **不读 429 的 `Retry-After` 头**：`#retryWait` 按固定公式退避。修法：`provider-adapters.mjs` 抛出 `ProviderTransportError` 时携带 `retryAfterMs`（解析 `Retry-After` 秒数或 HTTP-date）；`#retryWait` 优先取 `max(retryAfterMs, 计算退避)`。
2. **无总 deadline**：最坏 4×120s+退避 ≈ 9 分钟才失败。修法：加 `totalDeadlineMs`（默认 300s，可按 stage 配置：chat 120s、writing 600s），与 per-attempt 超时并行检查，超总 deadline 直接抛 `timeout`。
3. **per-attempt 超时不按 stage/模型可配**：慢推理模型写长段落 120s 不够。修法：`timeoutMs` 支持按 stage 覆盖（`stage_overrides` 已有模型覆盖先例，`model-client.mjs:30-54`），writing 阶段默认提到 300s。
4. **连接测试单次探测**：`model-connection-test.mjs:7,55-73` 固定 10s、`maxAttempts:1`，一次抖动就报"连接失败"。修法：改为 `maxAttempts: 2`（间隔 2s），与主链路同套错误分类。
5. **流式截断静默吞掉**：`provider-adapters.mjs:154-157` malformed SSE frame 只计数不报错，内容被截断也按成功返回。修法：流结束时若 `malformedFrames > 0` 或缺失 `data: [DONE]`/finish_reason，抛 `network` 类错误（走重试），并把截断内容长度记入事件。

**测试**：mock provider 分别返回 429+Retry-After、挂起到超时、半截 SSE 流，断言重试行为、总 deadline 生效、截断触发重试。

### 4.3 重试时的用户可见性（对标 Codex 的 "Retrying (2/4)…" 行）

**现状**：`model-client` 已有 `onRetry` 回调和 `recordRetry` 计数（`agent-engine.mjs:890`），但 UI 只显示静态状态，用户不知道 agent 是在跑还是在重试——容易误判卡死去点停止。

**改动**：`onRetry` 事件接入状态行（`app-shell/composer.js` 状态渲染处）：显示"网络重试中 (2/4)，下次尝试 8s 后"；重试成功恢复常态显示；重试耗尽走现有故障卡。chat 链路在输入框状态区显示同款。

### 4.4 优雅关停补强

**现状**：`server.close` → `abortActiveJobs`（`app-server.mjs:270-274`）只覆盖正常 close；Electron 被杀/断电不经过这里。

**改动**：Electron 主进程（`src/desktop/`）`before-quit` / `window-all-closed` 钩子里先调本地关停 API（或直接向 server 进程发 SIGTERM 并等待 ≤3s）再退出；等不到也照常退出（恢复靠 4.1）。这把"正常关停"的覆盖率从"只有用户优雅关闭"扩到"关窗口/退出应用"。

### 4.5 用户重试路径的体验收敛

**现状**：`retry-segment` / `retry-with-prompt` 等故障卡动作实现良好（接着草稿续跑、无次数限制），保留。两个小改进：

1. `retry-segment` 连续对**同一 segment** 失败 3 次后，故障卡的推荐动作从"重试"改为"换提示词重试 / 换模型 / 跳过"（`src/shared/failure-commands.mjs` 已有这些命令，只是排序/推荐问题）——避免用户无意义地点同一个按钮。判定依据：`run_log` 里该 segment 的连续 `quality_gate_failed` 事件计数。
2. `retry-with-prompt` 的输入框在故障卡上直接内嵌（现状需多一步操作，确认 `failure-card.js` 组件现状后实现），降低使用门槛。

---

## 5. P1：对话记录完整性（操作全程可回放）

### 5.1 新增完整 transcript 记录（对标 Codex rollout 文件）

**现状**：`chat_history.jsonl` 只存工具结果摘要，模型原始输出（tool_calls 围栏原文、推理文本）不落盘，无法逐字回放排查；写作链路 checkpoint 只存 hash 不存原文。

**改动**：
1. 新增 `src/core/chat/transcript-store.mjs`：每轮往项目目录 `chat_transcript.jsonl` 追加 `{ id, ts, turn_id, request_messages, raw_response, parsed_tool_calls, usage }`。
2. `chat-agent.mjs` 在 `modelClient.generate` 返回后写入；`resumeChatTurn` 同理。
3. 写入失败只 warn 不阻断主流程。
4. 纯落盘供排查，不加 UI；`AGENTS.md` 补一句该文件的存在与用途。

### 5.2 pending 未处理时新消息不再硬挡回

**现状**：`chat-agent.mjs:27-33` pending 存在时新消息直接被拒。

**改动**：服务端接受新消息，自动在 `chat_history.jsonl` 落 `{ role:"tool", tool: pending.tool, ok:false, result_summary:"因新指令自动取消", superseded:true }`，pending 状态置 `superseded`，再以新消息继续 agentLoop。UI（`renderConfirmCard`，`thread-renderer.js:983` 附近）对 `superseded` 卡渲染置灰态"已被新指令取消"。

---

## 6. P2：对话卡片可折叠

**现状**（全部不可折叠，完整占高）：
- 章节完成卡：`src/app-shell/index.html:114-117` 静态模板；
- 任务卡：`thread-renderer.js:240` `renderQueueCards`；
- 工具卡：`thread-renderer.js:949` `renderToolCard`；
- 确认卡：`thread-renderer.js:983` `renderConfirmCard`（**不折叠**，需用户立即操作）。

**改动**：
1. 三类卡片（章节完成、任务、工具）统一加折叠头：一行摘要（图标+标题+关键数字，如"第 1 章已完成 · 3,979 字"）+ 展开/收起箭头；点击头部切换。
2. **默认状态**：已完成/已结束类（章节完成、已完成任务、ok 工具调用）默认折叠；进行中任务、失败工具、确认卡默认展开。
3. 折叠状态按卡片 id 存 `localStorage`（key 前缀 `wwriting.card.fold.`），重载后保持。
4. 折叠用 `hidden` 属性或 `display:none` 切换 body 区域，**不留任何 `pointer-events:none` 中间态**（本项目高频回归就是浮层吃点击，见 AGENTS.md）。
5. 动画可省略，优先简单可靠。

---

## 7. 与 Codex / Claude Code 的差距总表（执行时对照自查）

| 能力 | Codex/Claude Code | 本项目现状 | 本计划条目 |
|---|---|---|---|
| 崩溃后恢复 | `codex resume` / `--continue` 显式续跑 | 有手动重试链路，无启动时检测提示 | §4.1 |
| 传输重试 | 指数退避 + 尊重 Retry-After + 总 deadline | 有退避，无 Retry-After/总 deadline | §4.2 |
| 重试可见性 | UI 显示 "Retrying (n/m)" | 只有计数，UI 不可见 | §4.3 |
| 每轮完整落盘 | rollout/transcript 文件 | 只有摘要，原始输出丢失 | §5.1 |
| 中断状态 UI | 一等公民，一键继续 | 流水线侧有（agent-truth），chat 侧无 | §3.4 |
| 长任务活性判定 | 流式活动即心跳 | step 边界才心跳，长调用误判卡死 | §3.1 |
| 写操作幂等 | 工具执行幂等/确认一次性 | pending 恢复可致重复执行 | §3.3 |
| 日志容错 | 坏行跳过 | run_log 坏行击穿全链路 | §3.2 |
| 人工上限 | 无（或极高默认） | 200 调用/8 轮/4 次修订硬闸门 | §2 |
| 审批模式 | 多档（read-only/auto/full-access） | 已有 yolo/auto_edit 两档，够用 | 不动 |
| 流式输出 UI | 逐 token 渲染 | 已有 SSE 流式（保留） | 不动 |

---

## 8. 不做的事（明确排除）

- 不改 `run_log.jsonl` / `checkpoints` / `reviewer-agent` 审计体系本身（只修它的容错，§3.2）；
- 不改工具调用文本协议（json 围栏）本身，只改"取几个"；
- 不动 `tool_permissions.dangerous` 硬封印（`tool-registry.mjs:27-29`）；
- 不引入多会话/多线程聊天（"新对话"按钮 `app.js:444` 行为先核实并在 PR 描述说明，超范围）；
- 不做数据库迁移，JSONL 只增字段不改旧字段语义；
- 不做 task_plan.md 里的阶段 2-7 产品功能（模型库、信息架构等），那是另一条线；
- 不追求逐 token 级别的 UI 重写，现有 SSE 流式保留。

---

## 9. 验证清单（全部必跑）

```powershell
npm test                          # 全量单测，不得有基线外新失败
npm run verify:app-clickability   # 关键防线：真实 Electron 逐按钮点击（AGENTS.md 要求）
npm run verify:app-shell
npm run verify:desktop-shell
```

手工冒烟（真实窗口做，不只看代码）：

1. 新建小说 → 写第 1 章 → 顶栏不显示 `/200`，只显示已用次数；
2. chat 里让 agent 连续读多个文件 → 一轮内完成；超过 8 轮工具调用不被强行收尾；
3. 写作中途**直接杀进程** → 重启应用 → 出现"上次写作被中断"横幅 → 点继续 → 从断点 segment 续跑且不重复已写内容；
4. 写作中途杀掉进程（chat 有未回消息）→ 重启 → 该轮显示"被中断"条 + 重发可用；
5. 模拟长模型调用（>60s）→ 状态行**不**误报"疑似卡住"；
6. 拔网/断网触发重试 → 状态行显示"网络重试中 (n/m)"，恢复后自动继续；
7. 章节完成卡默认折叠，点击展开，刷新后状态保持；
8. 确认卡弹出时直接发新消息 → 旧卡置灰"已被新指令取消"，新指令正常执行；
9. 设置里显式填模型调用上限 = 5 → 第 6 次调用仍正确触发预算故障卡（确认 §2.1 没把显式上限改坏）；
10. 确认卡点击批准后**立即杀进程** → 重启 → 再点批准不重复执行写操作（§3.3 幂等）。

---

## 10. 建议提交顺序

1. **§3.2 + §3.1**（日志容错 + 心跳误判）——影响面最大、风险最低，先行；
2. **§2.1 + 2.2**（默认不限预算）+ 测试更新；
3. **§2.3 + 2.4**（轮次 + 多工具）；
4. **§2.5 + 2.6 + 2.7**（写作容错 + 截断 + 窗口）；
5. **§4.2**（传输层重试打磨）；
6. **§4.1 + §3.4**（启动恢复横幅 + chat 半轮标记）——恢复体验闭环；
7. **§3.3 + 3.5 + 3.6**（幂等 + 计费一致 + 记忆原子性）；
8. **§3.7 + 3.8 + 3.9**（小 bug 清扫）；
9. **§5.1 + 5.2**（transcript + pending 语义）；
10. **§4.3 + 4.4 + 4.5**（重试可见性 + 关停 + 重试体验）；
11. **§6**（卡片折叠）；
12. **§3.10**（端口回退 stash，需用户确认，最后处理）。

每步独立可回滚；每步跑 `npm test`，涉及 UI/Electron 的步（1、6、10、11）必须加跑 `verify:app-clickability` + `verify:app-shell`，全部完成后跑 `verify:desktop-shell`。
