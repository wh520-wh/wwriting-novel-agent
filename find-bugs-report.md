# WWriting Bug 搜寻报告

> 技能：`/whfind-bugs 3`（目标产出 3 个经对抗验证的真实 bug）
> 日期：2026-08-03

## 方法

1. **广撒网提议**：3 个探索 agent 并行扫 `agent-engine` / UI 层（failure-card、thread-renderer）/ writing-loop，各自带证伪尝试返回候选。两个独立 agent 交叉印证了 A、B 两个候选。
2. **对抗验证**：去重后挑 7 个候选，每个派**全新怀疑者子 agent**（无共享上下文，只给候选四要素 + 技能的 5 问反驳模板）独立读码反驳。
3. **两层过滤**：怀疑者裁决 + 主循环一眼认可。

### 结果概览

- **拒绝 1 个**（D）：触发条件被高估
- **降级 6 个**（A/B/C/E/F/H）：bug 本体真实，但严重性低于初判
- **报告 3 个**（A/B/H）：真实、用户可见性最高、最值得修
- 其余降级候选（C/E/F）列末尾备查

拒绝率约 1/7（完全拒绝）+ 部分降级，过滤器有效。

---

## 确认存活的 Bug

### Bug 1：drafting 阶段 loop-exhausted 时「跳过本段」是假按钮（中等可用性）

- **Location**：`src/core/failure-actions.mjs:39-49`（skip-segment case）+ `src/core/derive-failure-card.mjs:83`（选项生成）+ `src/core/agent-engine.mjs:1444-1445,1973`
- **Phenomenon**：`skip-segment` 与 `accept-current-words`/`accept-review-current` 共用分支，仅当 `current_stage ∈ ["reviewing","needs_revision","revising"]` 时推进到 finalizing；drafting 阶段走 else 分支 `return { resumeRun: false, message: "当前阶段无草稿可接受。" }`，且该 return 在 `saveState` 之前。但 `deriveFailureCard` 在 `loop-exhausted` 分支无条件 push `skip-segment`（derive-failure-card.mjs:83），不按 stage 过滤。drafting 阶段 8 次提交失败 -> `model_output_invalid` -> `blockProject` 设 `blocked_at_stage = current.current_stage = "drafting"`（agent-engine.mjs:1973）；`resumeableState`（failure-actions.mjs:132-138）把 stage 还原回 `"drafting"`，于是 stage 白名单检查失败。
- **Impact**：drafting 阶段连续 8 次提交失败触发 loop-exhausted 时，用户点「跳过本段」只得到 toast「当前阶段无草稿可接受」，状态不落盘、项目保持 blocked，按钮完全无效。用户需改点同卡片上的 retry-with-prompt / retry-segment / pause-here / lower-target-words 才能脱困。
- **Evidence**：`WRITING_AGENT_COMMIT_FAILURES = 8`（agent-engine.mjs:1311，硬编码默认生效）-> 1444-1445 `commitFailures >= 8` 返回 `model_output_invalid` -> `failWritingAgentLoop` -> `blockProject` 记 `blocked_at_stage="drafting"`；`resumeableState` 还原 `current_stage="drafting"`；failure-actions.mjs:44 `["reviewing","needs_revision","revising"].includes("drafting")` 为 false -> else 返回。`tests/failure-actions.test.mjs` 测了 `blocked_at_stage:"drafting"` 但只覆盖 raise-budget/raise-cost-budget；`accept-current-words` 测试用的是 `current_stage:"needs_revision"`；**无任何测试覆盖 drafting + skip-segment 组合**。
- **怀疑者裁决**：downgraded。bug 链路逐行核实属实，默认配置即生效，无测试覆盖，无「by design」注释豁免。但反对「死锁」定级--同卡片有 3-4 条无 stage 门禁的逃生口。正确定性为「可见的 UI/状态一致性缺陷（假按钮）」，非 major。
- **修复建议**：二选一--(a) `derive-failure-card.mjs:83` 按 stage 过滤，drafting 时不展示 skip-segment；(b) `failure-actions.mjs` 给 drafting 单独处理 skip-segment（如直接推进到下一段或 finalizing）。

---

### Bug 2：word-count-gate 失败卡上的「降低字数目标」不解决硬门禁，且 `runWordCountGate` 的 `targetWords` 参数是死代码（UX/设计问题）

- **Location**：`src/core/quality-gates.mjs:53-78`（runWordCountGate）+ `src/core/failure-actions.mjs:93-101`（lower-target-words）+ `src/core/derive-failure-card.mjs:78-81`（选项生成）+ `src/core/agent-engine.mjs:348,384,544,1375`（调用点）
- **Phenomenon**：`runWordCountGate(content, minWords, targetWords = null)` 的 `targetWords` 参数在函数体内**零次出现**，门禁只检查 `minWords`；4 个调用点全部只传 `project.min_words_per_chapter`。但 `lower-target-words`（failure-actions.mjs:96-98）只 patch `project_profile.target_words_per_chapter`（软目标），注释明说「不动 min_words_per_chapter 硬门禁」。loop-exhausted 由 `last_gate==="word-count-gate"` 驱动时（derive-failure-card.mjs:78）展示「降低本段字数目标到 X 字」选项。默认 `min=3000, target=3300`（project-store.mjs:37-38），降 target 到 `max(3000, round(3300*0.7))=3000` 被 clamp 回 min，门禁 3000 纹丝不动。label 写「本段」实际改的是章节级 target。
- **Impact**：草稿字数不足触发 word-count-gate 反复失败时，用户点「降低字数目标」期望门禁放宽，实际 `min_words` 不变、续跑后门禁仍按原值检查、可能再次 loop-exhausted。选项在默认配置下近 no-op（target 3300->3000 对齐到 min），且 label「本段」与实际改的章节级 target 不匹配，语境误导。
- **Evidence**：quality-gates.mjs:55-78 函数体只引用 `minWords`；agent-engine.mjs:348 `runWordCountGate(draft, project.min_words_per_chapter)`、384 同；failure-actions.mjs:94 注释「只降软目标 target_words_per_chapter，不动 min_words_per_chapter 硬门禁」；derive-failure-card.mjs:78 条件 `data.last_gate === 'word-count-gate' && data.target_words`；`failure-commands.mjs` 全量 14 命令无 `lower-min-words`；默认 target(3300)>min(3000)。`tests/failure-actions.test.mjs:113-129` 测了 target 被改/min 不变/低 clamp 到 min，但**未测续跑门禁是否真放宽**。
- **怀疑者裁决**：downgraded。技术事实全部属实（targetWords 死参数、选项不动 min、门禁续跑不变），但严重性被高估：「不动 min」是 `failure-actions.mjs:94` 注释明确的有意设计，文案说「目标」非「门槛」字面未撒谎，默认 target>min 非完全 no-op，用户有 skip-segment 等真正绕门禁的逃生口。定级为 UX/化妆品问题。
- **修复建议**：三选一--(a) 让该选项同时降 `min_words_per_chapter`（打破有意设计，需产品确认）；(b) 改 label 为「降低章节字数目标（不影响最低门槛）」明示；(c) 删除 `runWordCountGate` 的 `targetWords` 死参数避免接口欺骗。

---

### Bug 3：case C（`append_chapter_segment`）非散文内容立即 block 无重试，与 case A 不对称（低到中严重性）

- **Location**：`src/core/agent-engine.mjs:1414`（executeCommit 调 executeToolCall 无 try/catch）+ `1843-1857`（executeToolCall catch ToolValidationError->blockProject）+ `1503-1514`（case A 预检查可重试）/ `1534`（case C 走 executeCommit）+ `src/core/tool-runtime.mjs:42-58,93-96`（detectNonProseContent）+ `src/core/quality-gates.mjs:81-134`（assertToolCallForChapter）
- **Phenomenon**：模型以纯文本输出非散文（dispatchSingleToolCall case A）时，`detectNonProseContent` 在 executeCommit 前检查（agent-engine.mjs:1503），失败走 `rejectOutput` 递增 `commitFailures`、允许 8 次重试。但模型直接调 `append_chapter_segment` 传非散文（case C，agent-engine.mjs:1534）时，executeCommit->executeToolCall->appendChapterSegment 内 `detectNonProseContent` 抛 `ToolValidationError("non_prose_content")`（tool-runtime.mjs:93），executeToolCall catch 后**立即 blockProject->throw ProjectBlockedError**（agent-engine.mjs:1843-1857），绕过 `commitFailures` 计数器。executeCommit 对 executeToolCall 无 try/catch。`assertToolCallForChapter`（quality-gates.mjs:81-134）只校验结构不校验内容，挡不住。`append_chapter_segment` 在 `DRAFTING_ALLOWED_TOOLS` 和 `REVISING_ALLOWED_TOOLS`（agent-engine.mjs:1314-1334）都存在，case C 在「Put the chapter prose only in the tool input.content field」提示模式下是被要求的正常路径。
- **Impact**：case C 正常路径下，模型若偶尔在 content 里写入工具名（如角色是程序员的对话、模型思考泄漏、元叙事）或匹配 `NON_PROSE_PATTERNS`（"tool is not allowed" 等），项目**首次出现即 block**，模型无重试机会。同一错误在 case A 路径优雅重试 8 次，在 case C 路径致命 block，处理不对称。
- **Evidence**：executeToolCall:1843-1857 `catch (error) { if (error instanceof ToolValidationError) { await blockProject(...); throw new ProjectBlockedError(error.code); } }`；Grep 确认 executeToolCall 唯一调用点是 executeCommit:1414，无 try/catch 包裹；case C:1534->executeCommit->executeToolCall；assertToolCallForChapter 不检查 content；case A:1503-1514 预检查走 rejectOutput（commitFailures++，上限 8 见 1311）。`tests/tool-runtime.test.mjs:113-128` 只测工具函数本身抛 non_prose_content，**不测 executeToolCall 的 blockProject 行为**；`tests/agent-engine.test.mjs:246-264` 测 case A 非散文被拒后重试成功，**不测 case C + non_prose 端到端 block**。
- **怀疑者裁决**：downgraded。代码事实逐行核实属实，设计不对称 + 测试缺口真实，无「by design」注释解释为何 case C 升级为硬错误。但触发需三条件（模型选 case C + content 含特定 snake_case/英文短语 + 对中文小说误伤率注释自承「极低」），实际命中频率低。定级为低到中严重性。
- **修复建议**：二选一--(a) 在 case C 入口（dispatchSingleToolCall:1534 之前）加 `detectNonProseContent` 预检查，失败走 `rejectOutput` 与 case A 对齐；(b) 让 executeToolCall 对 `non_prose_content` 不走 blockProject，而是抛可重试错误让 commitFailures 计数。

---

## 被拒绝 / 降级未报告的候选（过滤器工作记录）

- **D. syncFailureCards 重建清空 textarea 输入** - **rejected**。核心机制「1.8s 轮询」在 retry-with-prompt 失败卡展示的常见场景（project_blocked + 无 chat）下不活动：`agent-truth.mjs:73-75` blocked 时 `refresh:false`，`run-presentation.mjs` blocked 是 terminal，`app.js:918-923` 四条件全 false->轮询停止。唯一能触发的是 chat-busy 轮询，需用户主动切上下文发 chat 消息，属窄边缘场景，且 prefillComposer 模板填充对用户可见非静默失败。
- **C. parseJsonOutputText 吞 JSON 包裹正文** - downgraded。代码事实成立（dispatchSingleToolCall case A 只查 message/text 不查 content），但触发需模型持续 8 次违反「直接输出正文文字」明确指令把正文包进 JSON，配置的 DeepSeek 正常中文散文路径下 `parseJsonOutputText` 不可达。理论存在实际罕见，属低优先级防御加固。
- **E. session.start 在 ProjectCancelledError 路径丢失 agent_end/agent_settled 事件** - downgraded。代码路径差异真实（throwIfAborted 抛 ProjectCancelledError 非 AbortError，catch 只认 AbortError 走 else re-throw 跳过 emit），但 UI 不消费 agent_end/agent_settled（前端 .js 零命中），靠 `project_cancelled` 事件 + `task.status` 检测 run 结束；runProject 无论哪条路径都 emit project_cancelled，session.status 回 idle，waitForIdle resolve。无 deadlock、无 UI 卡住、无用户可见影响，纯可观测性小缺口。
- **F. revision_budget_exhausted 的 raise-budget 选项完全无效且误导** - downgraded。链条 100% 成立（revision_budget_exhausted 落默认分支->label「提高预算到 400」->raise-budget 只改 max_model_calls->consumeRevisionBudget 检查未变的 max_revision_rounds_per_chapter->resume 立即重新 block），无设计豁免。但默认 `max_revision_rounds_per_chapter=null`（`Number.isFinite(null)` false->永不 block），且 `settings-modal.js:695-700` 前端 UI 不暴露该字段，仅手动编辑配置文件的高级用户可触发，影响面极小。

---

## 附：搜寻范围

探索 agent 与怀疑者共读取约 30 个文件，重点：`agent-engine.mjs`、`agent-output-parsing.mjs`、`agent-loop.mjs`、`writing-agent-session.mjs`、`agent-transcript.mjs`、`cancellation.mjs`、`provider-adapters.mjs`、`quality-gates.mjs`、`tool-runtime.mjs`、`failure-actions.mjs`、`derive-failure-card.mjs`、`failure-card.js`、`thread-renderer.js`、`app.js`、`agent-truth.mjs`、`run-presentation.mjs`、`settings-runtime.mjs`、`settings-modal.js`、`project-store.mjs`、`shared/failure-commands.mjs`，及 `tests/` 下相关测试。

---

## 第 3 轮（2026-08-06 · app-shell / AgentSurface 边界硬化）

未提交改动聚焦 `app-shell/{app.js,icons.js,styles.css,agent/{index,view,state,api}.js,agent/slash-commands.mjs}`。方法：广撒网提议 -> 单次批量自我对抗核查（本环境无子 agent 可派发，按技能「无子 agent 回退」从零重读代码逐条反驳，等价于第二 AI 视角）。报告 3，拒绝 1。

1. **submit 补快照不防项目切换**（中）：`agent/index.js:113-124` submit .then 无项目守卫 + `agent/api.js:121-124` openProject 只 abort SSE controller、不 abort pendingRequests + `agent/state.js:85-93` session_id 不等即 resetState+用快照事件重建 -> A 的补快照响应迟到时把 A 会话重建进 B。同根变体：`agent/index.js:42-51` onReconnect（预存在，非本轮新增）。
2. **submit 失败把旧文本灌进新项目输入框**（低-中）：`agent/view.js:776-783` .catch `if (input.value.length === 0) input.value = text;` 无项目守卫；view.reset() 已移除错误气泡（不可见），但 input 元素保留，A 的失败文本静默填进 B 的输入框。
3. **Enter/Tab 未守 isComposing**（中）：`agent/view.js` keydown 两处 Enter（菜单关->提交、菜单开->选命令）都不查 `event.isComposing`；中文 IME 按 Enter 确认候选即误发残缺文本/误选命令。`src/app-shell` 全仓 `isComposing|keyCode|composition` 零命中。提交路径预存在，斜杠菜单路径本轮新增。

被拒绝：inputId 对账「死代码」+ 重复文本并发 -- 经 FIFO text 匹配 + seq 顺序快照验证构造不出稳定孤儿气泡，inputId 匹配仍服务于 SSE 迟到事件，判健壮、不报告。

---

## 第 4 轮（2026-08-10 · 全技术栈穷尽，whfind-bugs 全流程）

方法：6 个 explore 子代理按区域广撒网（model 层 / http+SSE / project-operations / skills+shell / app-shell UI / desktop+config），产出约 30 个候选（含四要素）；随后分 5 批共 30 个**全新 skeptic 子代理**（无共享上下文、独立读码）逐一驳倒验证；主循环对存活者逐一眼把关。报告 18，拒绝/降级 12。

### 确认存活的 Bug（18 个，均通过 skeptic 反驳验证 + 主循环把关）

**B1（中）reveal-path IPC 安全边界锚在应用安装目录，所有项目外「打开文件夹」按钮必失败**
- Location：`src/desktop/electron-main.cjs:41-46`（rootDir=`path.resolve(__dirname,"..","..")`=D:/WWriting）+ `src/app-shell/drawer-panels.js:76-78`（导出文件夹，无 .catch→unhandled rejection）+ `src/app-shell/settings-modal.js:502-510`（项目文件夹）
- Phenomenon：`if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) throw new Error("路径不在项目工作区内")`；而调用方传的是用户项目根（系统对话框任选，app.js:595-605 无限制）。打包版 asar 下 rootDir 是只读 `resources/app.asar`，任何用户项目都不可能在它下面。
- Impact：两个按钮对任何 D:/WWriting 之外的项目 100% 失效——一个静默（无 catch），一个弹误导性错误 toast；而 `reveal-skill-directory`（electron-main.cjs:103-124）用 `validateProjectRoot()` 是正确写法，同族安全代码证明这是孤立疏漏。
- Skeptic：confirmed（moderate）。Q1 逐行核实 + Q4 打包版必现，Q2 同族安全写法佐证。

**B2（中）章节连续性记忆管线整体未接线——continuity.json/book_summary.md 永不落盘，prompt 却宣称已更新**
- Location：`src/core/project-operations/chapter.mjs:589`（commitChapterMemory，全 src 仅 3 处引用：定义/导入/注入，**零调用**）+ `src/core/agent/tools.mjs:13-15`（13 工具注册表无它）+ `src/core/agent/prompt.mjs:150`（"全书摘要…已由 commit_chapter 一致更新"）+ `src/core/chapter-memory.mjs:44,70`（buildRelevantFacts/buildContinuityPromptContext 同样零调用）
- Phenomenon：`commitChapter`（chapter.mjs:441-491）只写章节文件/chapter_memory.json/索引/checkpoint/run_log；`commitChapterMemory` 是 book_summary.md 与 continuity.* 的唯一非空写入方，却无任何调用路径；`scripts/rebuild-memory.mjs` 头部宣称模型会调用该深工具（实际未注册），正文用"如该工具不可用请直接说明"对冲，静默空转。
- Impact：跨章连续性事实/时间线/全书摘要永不生成——`buildRelevantFacts` 恒读空、`checkTimeline` 永不触发；模型被 prompt 误导向用户确认"记忆已维护"；压缩/换会话后跨章一致性不可恢复。接受测试（unified-agent:1101-1165）只断言 chapter_memory.json，恰好漏掉。
- Skeptic：downgraded（minor-to-moderate）→ 主循环认可为中。无数据丢失（从未写过），非硬失败，但产品能力 100% 惰性 + prompt 与实现直接矛盾。

**B3（低-中）连接测试的客户端断开检测是死代码——499「连接测试已取消」分支不可达**
- Location：`src/core/http/settings-routes.mjs:505-511`（`request.once("close", onRequestClose)`）+ `:606-608`（499 映射）+ `src/core/http/router.mjs`（readJsonBody）
- Phenomenon：router 的 `readJsonBody` 用 `for await` 在 handler 执行**前**消费完请求体并把 request 置为 destroyed（项目自己的注释 agent-routes.mjs:346-350 证实，Node 24 实测）——`close` 事件在挂载监听前就触发过，监听器永不触发；客户端断开只触发 response `close`（此处未挂）。
- Impact：点「测试连接」后关窗，探测照常跑满 30s+2s 重试，不取消；499 分支是纯死代码。无数据损坏，但探测取消功能与错误分支双双失效。
- Skeptic：confirmed，downgraded（cosmetic/minor）。skeptic 在本机 Node v24 实测复现（request close 在 body 完成时触发、断开时不再触发）。

**B4（低-中）网关空闲超时误杀纯工具调用流——长工具轮被整体重试、费用翻倍**
- Location：`src/core/model/gateway.mjs:135-146`（看门狗只看 lastActivityAt）+ `:176,180-197`（仅 onActivity 包装刷新）+ `src/core/model/openai-compatible.mjs:308-319`（工具帧不触发 onToken）+ 接线 `src/core/app-server.mjs:269`（onActivity=null）+ `src/core/agent/runtime.mjs:1487-1491`
- Phenomenon：生产接线不注入 onActivity；`lastActivityAt` 全库仅 3 处刷新（gateway.mjs:183/189/194），工具调用增量帧 `delta.content` 为 null → onToken 不调用。纯工具流（写章节时 arguments 含整章文本）逐帧不刷新 → 到 300s（默认 timeout_ms）被判"空闲"abort → 整请求透明重试（重新生成全部工具参数、重复计费）直到 totalDeadline（900s）耗尽。
- Impact：非思考型模型长工具生成（>5 分钟）被反复误杀重试，费用翻倍、Run 最终失败"Request exceeded total deadline"。gateway.mjs:168-171 自己的设计注释明确说"工具增量帧应计入活动"——实现与设计矛盾。
- Skeptic：confirmed（moderate）。Q1 逐行核实 + Q2 设计注释佐证。

**B5（低）fetchModelSecret 迟到响应跨供应商 tab 串写 API Key**
- Location：`src/app-shell/settings-modal.js:1541-1548`
- Phenomenon：`.then` 只捕获 `apiKeyEnvValue`，但写入目标 `settingsFields.apiKey` 是随 `renderSettingsDetail()` 每次重建的模块级可变引用；切换 tab 后迟到响应把旧 tab 的 key 写进新 tab 的空输入框（守卫只有"输入为空"）。
- Impact：快速切 tab 时 DeepSeek 的 key 落入 MiMo/自定义档案；若随后保存则凭据错配。窗口毫秒级，正确 key 不丢（global-model-settings.mjs:95 是 merge），可恢复。同文件 :1451/:1698-1708 有防串场安全先例，此处独缺。
- Skeptic：downgraded（low）。机制逐行确认，窗口极窄。

**B6（低）连接测试超时被误分类为 499「连接测试已取消」，request_timeout 分支真实流程不可达**
- Location：`src/core/model-connection-test.mjs:72-78`（探测自身 30s 定时器）+ `:282-285`（isCallerAbort 对任意 AbortError 返回 true）+ `src/core/http/settings-routes.mjs:606-608`
- Phenomenon：探测 30s 超时 abort → 网关 `signal?.aborted` 判外部取消抛 AbortError（gateway.mjs:244-246）→ isCallerAbort 重抛 → 路由映射 499"连接测试已取消"。代码自身意图（classifyError:299-301、错误文案"模型服务器响应超时（30 秒）"、测试标题"timeout is classified as request_timeout"）是反的。
- Impact：挂起的模型被探测时用户看到"已取消"而非"超时"。测试用注入 fake 绕过了真实网关路径（tests/model-connection-test.test.mjs:216-234），绿测掩盖真路径。
- Skeptic：confirmed，downgraded（minor）。Q1 端到端链路核实。

**B7（低）openReader 无响应守卫——快速翻章显示错章**
- Location：`src/app-shell/app.js:751-778`（+ `:282-283` openAdjacentChapter + `drawer-panels.js:125`）
- Phenomenon：`readerChapterNo = chapterNo` 在 await 之前置位；await 之后无条件 `refs.readerTitle/readerBody` 覆写，无 `if (readerChapterNo !== chapterNo) return`、无 abort。快连点（抽屉/上一章/下一章）时慢的旧响应后到，把标题+正文整体渲染成旧章；`readerChapterNo` 已是新值，继续翻页按错误索引错位。同文件 dashboard 有 dashboardRequestId+projectScope 双守卫，此处独缺。
- Skeptic：downgraded（minor）。竞态可达（路由无锁、磁盘读可乱序），概率低、瞬时、自愈。

**B8（低，安全）shell 命令 scope 只看 cwd——auto 档下项目内命令可静默写项目外任意路径**
- Location：`src/core/shell/risk.mjs:54-56` + `src/core/agent/tools.mjs:216-220,1041-1056`
- Phenomenon：scope 仅由 `isWithin(root, resolvedCwd)` 决定，命令的重定向目标不参与判定；`echo x > D:\Users\Public\evil.txt`（项目 cwd 内）→ `write:project:project-root` → auto_edit 档自动放行无弹窗；确认弹窗也只展示 `targets:[classified.cwd]` 不展示真实写目标。
- Impact：auto 档（非默认，默认 confirm）下 agent 可静默写项目外任意路径，超出该档"可静默改稿"的承诺语义。文件工具走 `resolveProjectScope`（risk.mjs:79-89）精确到目标路径，shell 独缺。
- Skeptic：downgraded（low/moderate，限 auto 档）。tools.mjs:255-258 注释承认 cwd 是"有意"的粗粒度信号，但 auto_edit×重定向的授权组合未文档化。

**B9（低）app-state.json 非原子覆写 + recordRecentProject 无锁读-改-写**
- Location：`src/core/app-state.mjs:54-60,62-86`
- Phenomenon：`fsp.writeFile` 直接覆写（非 tmp+rename）；recordRecentProject 先 load 后 save 无互斥。项目自身安全写法在别处：session-registry.mjs:8-9（互斥+writeJsonAtomic）、fs-utils.mjs:79（writeFileAtomic）。
- Impact：open 与 init 重叠时后写覆盖先写（丢最近项目条目/lastProjectRoot 回退）；写中途崩溃 → 状态文件损坏 → 下次启动最近项目列表全丢（loadAppState 只回落空列表不修复）。自愈、影响限"最近项目"派生元数据。
- Skeptic：downgraded（minor）。Q1 核实 + Q2 违反自身约定。

**B10（低）project-lock 的 tails Map 清理是死代码——`tails.get(key) === current` 恒 false**
- Location：`src/core/project-lock.mjs:13,20-22`
- Phenomenon：`tails.set(key, previous.then(() => current, () => current))` 存的是 `.then()` 派生出的**新 Promise**，而清理判断比较的是原始 `current` 对象——引用恒不等，`tails.delete` 永不执行。
- Impact：每个被加锁过的项目路径永久留一个已 settle 条目；进程内增长有界（按用户实际打开过的项目数）、每条约几百字节，无用户可见症状，但意图中的清理确实失效。
- Skeptic：confirmed（minor/cosmetic）。Q1 直接读码核实（line 13 vs 20-22）。

**B11（低）output_style 设置是全库唯一的"死设置"——选择输出风格无任何效果**
- Location：`src/app-shell/settings-modal.js:386,1961` + `src/core/settings-runtime.mjs:218-219` + `src/core/output-style-loader.mjs`
- Phenomenon：全 src grep `output_style` 只有写入/校验/默认值，**零消费方**；唯一消费者 `prompt-compiler.mjs` 已在 ec56f8d 整体删除（diff 可见被删的 `project.output_style ?? "creative"` 注入逻辑）。真正的风格机制走 `writing_style_skill` + read_skill（prompt.mjs:164-167）。UI 与 `docs/USER_GUIDE.zh-CN.md:443-455`（§16.2）仍宣称该下拉生效。
- Impact：用户选非默认/自定义风格（含 `~/.wwriting/output-styles/*.md`）保存后行为不变，UI 承诺了不存在的功能；迁移不完整且无废弃提示。
- Skeptic：confirmed，downgraded（minor）。Q1 穷尽 grep + Q2 迁移缺失证据（git 历史）。

**B12（低）设置分区渲染的无守卫异步续作——内容写进错误分区**
- Location：`src/app-shell/settings-modal.js:357-417`（renderWritingSection 在 :388 await fetchOutputStyles 后无条件 append）+ `:1203-1245`（技能详情 await 后无条件 replaceChildren）
- Phenomenon：两个 await 之后的续作都不检查"当前是否仍在该分区"。代码库自己承认此类竞态并给出安全先例（:684-688 `if (settingsSection !== "danger" ...) return` + 测试 settings-modal.test.mjs:1832），这两条路径独缺。
- Impact：切分区期间迟到续作把写作参数字段 append 进技能区/把当前分区擦掉换成旧技能详情；瞬态、自愈、无持久破坏。
- Skeptic：downgraded（low）。竞态类真实（有守卫先例），窗口窄、无测试覆盖。

**B13（低）项目移除后 groupEls/sessionCache 不清理——带监听器的 DOM 子树泄漏**
- Location：`src/app-shell/session-sidebar.mjs:60,247-255,183` + `src/app-shell/app.js:534-546`
- Phenomenon：`groupEls`/`sessionCache` 只增不减（模块内无任何 delete/clear 路径，作者在别处用 delete 的地方证明是疏漏而非风格）；`listEl.replaceChildren()` 只丢 DOM 视图，Map 强引用整棵带 click/keydown/op 按钮监听的子树；rerenderGroup 因 parentNode 为 null 跳过但不删条目。
- Impact：长会话反复"创建/移除项目"累积 detached 子树；量级小（每项目几十~几百 KB，占 Electron 常驻内存 <1-2%），DevTools 可见 detached listeners。
- Skeptic：downgraded（low）。机制核实，影响被量级与"会话级缓存"设计意图消解。

**B14（低）model-profiles.json 24 条硬上限静默丢弃最旧模型；upsert 无锁读-改-写**
- Location：`src/core/local-model-profiles.mjs:16-28`
- Phenomenon：`models: [saved, ...models].slice(0, 24)` 无注释无提示，保存第 25 个模型时静默淘汰最旧者；upsert 是 load→filter→写整包的 RMW，无互斥（writeJsonAtomic 只保证单次写原子）。
- Impact：模型清单超过 24 个时用户无感知丢失；并发写者（settings-modal 保存 vs 侧边栏切换）理论可丢更新——单窗口 UI 下 scrim 挡住重叠，实际不可达。
- Skeptic：downgraded（low）。cap 是真实静默淘汰（触发需 ≥25 个模型），竞态部分被 UI 互斥证伪。

**B15（低）stop 路由快照校验与停止对象之间 TOCTOU——误停新 Run**
- Location：`src/core/http/agent-routes.mjs:150-159` + `src/core/agent/runtime.mjs:2139-2155,1721-1751`
- Phenomenon：快照校验通过 A 的 runId，但 `agent.stop` 不接收 runId（runtime.mjs:2152 在互斥区内重读 `session.active_run`、无身份比对）；`advanceOrComplete`（:1721-1751）在 A 完成时自动消费队列推进 B 开跑，无需用户操作。
- Impact：排队两条消息、在 A 完成瞬间点停止 → 校验的是 A、停的是 B：A 正常完成（用户想停的没停成），B 被 input_cancelled 文本回 draft（可重发）。窗口毫秒级、后果可恢复。同族 retry/promote 都显式传 runId，stop 独缺。
- Skeptic：confirmed（minor）。Q1 逐行核实，Q2 路由注释"runId 必须与活动 Run 一致"的防护意图恰被竞态击穿。

**B16（低）非流式请求（压缩）无看门狗保护——timeout_ms 对压缩退化为硬墙钟上限**
- Location：`src/core/model/gateway.mjs:133-160`（heartbeat 不刷新 lastActivityAt）+ `src/core/agent/compaction.mjs:165-167,259`（stream:false, retryMax:0）
- Phenomenon：非流式请求无 SSE 帧、无任何回调 → lastActivityAt 冻结在 attempt 起点 → timeout_ms（默认 300s）成为每 attempt 硬上限；超时即 abort，retryMax:0 直接失败。注意这不是回归：fc5e3cb 之前是**所有请求**硬 120s 上限，空闲语义只改善流式，非流式仍硬上限。
- Impact：大项目（≥200k token）+ 慢思考模型压缩单请求 >5 分钟 → abort → `context_compaction_failed` → Run 进 waiting_user 输入滞留；可恢复（有 retry/cancel 逃生口、无数据丢失），慢模型配置下可触发。
- Skeptic：downgraded（low）。机制核实，非回归 + 失败路径有设计兜底。

**B17（低）退出路径 server.close 无超时——菜单/Cmd+Q 首次退出被吞**
- Location：`src/desktop/electron-main.cjs:188-206` + `src/core/app-server.mjs:171`
- Phenomenon：`/api/shutdown`（app-server.mjs:171）是空实现（注释宣称"优雅终止活跃任务"，实际不 abort 任何东西）；`await new Promise(resolve => server.close(resolve))` 无超时无 closeAllConnections（对比 tests/helpers/http-test.mjs:32-36 项目自己知道要先断开连接）。关窗路径其实干净（renderer 先销毁、socket 随窗口关闭），**菜单退出路径**才挂：SSE 连接活着 → server.close 阻塞 → 首次 Cmd+Q/菜单退出被静默忽略，第二次才生效。
- Impact：macOS 常用退出手势（Cmd+Q）首次点击无效、窗口保持，需点两次；无数据丢失。skeptic 驳正了原候选的"关窗后进程残留"错误机制（model 调用是 fire-and-forget，HTTP 连接最多持 10s）。
- Skeptic：downgraded（minor）。Q1 纠正机制，Q2/Q4 确认真实缺陷在菜单退出路径。

**B18（低）runSave 的 finally+700ms 定时器覆盖分区自身按钮状态——技能区出现死按钮+弹窗自动关闭**
- Location：`src/app-shell/settings-modal.js:1967-1995` + `:313-319,326-327,1863-1866`
- Phenomenon：`finally { settingsSave.disabled = false }` 与 700ms 定时器（只守 `seq !== saveSequence`）无条件执行；`setSettingsSection` 不 bump saveSequence。保存请求在途/700ms 窗口内切到技能/危险分区（该分区把按钮渲染为 disabled+"无需保存"，且 saveSettings 对其早退）→ 按钮被重新启用成死按钮 + 弹窗自动关闭打断当前分区。成功路径的自动关闭本是设计行为（注释 1977-1978），跨分区时变成打扰；失败路径的死按钮自愈于下次切分区。
- Skeptic：confirmed，downgraded（cosmetic/minor）。Q1 核实 + Q2 违反自身意图注释（:337-339"确保不会出现死按钮死角"）。

### 被拒绝 / 降级未报告的候选（过滤器工作记录）

- **P2 导出相对路径静默丢章** - **rejected**。索引全部由 safeJoin 绝对路径写入（当前/旧版/基线 commit 均如此，14+ 个真实 demo_run 索引全绝对），仓库无任何相对路径产出方，前提不成立；`resolveInsideRoot` 容忍相对路径只是读者侧防御。
- **H3 SSE 写已销毁 response 崩溃** - **rejected**。skeptic 在 Node v24 实测：客户端断开后连续 15 次 `response.write()` 返回 false、不抛错、不发 error 事件、进程存活——`ERR_STREAM_DESTROYED` 语义不适用于 ServerResponse；外层 try/catch 是既定安全网。无心跳子项降为理论性。
- **P4 提交/导出字数系统性不一致** - **rejected**。导出路径不是"剔除标题"而是**加回**自己的 `# 书名`+`## 第 N 章` 再重计（book-export.mjs:26,29 vs word-count.mjs:19 保留标题文字）；skeptic 实跑函数，默认管线方向反转为导出+403 字/100 章；两侧口径都是冻结契约（word-count.mjs:6-9 注释 + 测试断言"标题文字计入有效字数"）。
- **S6 structured-output 只取首个围栏/大写 ```JSON``` 失败** - **rejected**。`extractJsonCandidate`→`parseStructuredOutput`→`parseMemoryExtraction` 在生产 **零调用**（引用的 agent-engine.mjs 已删除，记忆提取走工具参数路径 chapter.mjs:582"runtime 已完成模型提取"）；纯死代码，正则缺陷不可达。
- **D5 simple-yaml 破坏嵌套 YAML** - downgraded（low）。解析器机制属实，但 `''` 是 falsy → app-server.mjs:220 的 `!effective.active_model` 兜底照常触发，行为等价"未配置模型"（一等支持状态）；仓库无任何写入方产出嵌套 YAML，project.yaml 被设计为只读兼容输入（config-runtime.mjs:50、migration.mjs:168），需用户手写不支持格式才触发。
- **H2 SSE 缺省 sessionId 跨会话 seq 污染** - downgraded（theoretical）。机制属实且代码注释自认（agent-routes.mjs:374-376），但前端按注释处方执行：切会话即 abort 重建并显式带 sessionId（index.js:310-311、api.js:322），draft 占位无活流；`setLastActive` 全 src 零调用，单窗口无法制造 getLastActive 翻转。
- **D2 GET 读路径写回 project.yaml** - downgraded（minor/cosmetic）。写回是文档化设计意图（global-model-settings.mjs:104-111、app-server.mjs:176 注释、测试断言覆盖）；生产模型写入走 workspace settings.json（settings-routes.mjs:265-267"无活跃消费者"），project.yaml 分支实际死；竞态需全局-项目同时有差异才触发。
- **M3 官方定价链路断开、成本面板恒"未配置价格"** - downgraded（cosmetic/tech-debt）。事实链成立（CostTracker 无 pricing、UI 不传 pricing、OFFICIAL_PRICING 零读方），但删价格输入是 d65f8b5 明确的产品决定且测试断言"不渲染价格字段"，"未配置价格"是设计好的诚实展示（cost-panel.test.mjs:195）；残留仅 stale 注释 + 死函数。
- **M5 SSE 多行 data: 折行代理丢参数** - downgraded（minor/theoretical）。逐行解析是有意约定（测试 :608 依赖无空行分隔的多帧）；现实折行两边 JSON 片段都过不了 :295-301 的 parse 门 → 整帧按 malformed 丢弃（设计好的降级模式），"input:null 静默丢参"需折行边界恰好落在完整 JSON token 之后（此时规范解析器也失败）。
- **S2 SKILL.md frontmatter 块标量内 `---` 误判闭合** - downgraded（low）。朴素扫描属实，但主后果被证伪：name 在前的正常布局下截断的 frontmatter **能正常解析**（skeptic 用项目自带 yaml 包实跑），技能仍被发现、只是 description 截断；仅"分隔线在 name 之前"才整技能静默跳过。默认内置技能全单行 description，需第三方导入+特定写法。
- **D3 workspace settings.json 并发 RMW 覆盖** - downgraded（theoretical）。代码层无锁属实（createMutex 在 journal/session-registry 用、store.mjs 不用），但声称的触发面被证伪：settings-modal **从不写 settings.json**（无 tool_permissions，写的是 project.yaml），唯一可并发的是相邻两个 composer 下拉，本地请求 10-50ms 对人类双击间隔不可达；迁移 Step 5 是 RMW 保序写入。
- **M4 [1m] 尾标破坏官方价补缺** - downgraded（latent）。机制链 100% 属实（精确查表不剥尾标 vs 成本侧前缀匹配），但当前 UI 不发送 pricing（与 B11 同根），抛错路径只有手工构造 HTTP body 才可达；恢复价格输入后才会成为用户可见 bug。
- **S4/S5 记忆提取 timeline 章号归一丢记录 / continuity 去重吞新引文** - 未派 skeptic（同属 B2 记忆管线未接线的下游，管线不通时二者均不可达，作 B2 的注脚记录）。
- **P5 chapter-artifact 缓存无界 / P6 锁无超时 / U6 抽屉动画竞态 / 其余低优先记录** - 未达报告门槛或与已报告项同根，保留在会话记录。

### 附：搜寻范围

5 批共 36 个子代理（6 explore + 30 skeptic），覆盖 src/core（model/http/project-operations/skills/shell/workspaces/desktop 关联）、src/app-shell（不含 agent/，前轮已审）、src/desktop、src/shared，及 tests/ 对应断言。skeptic 全部独立读码，2 项做过本机 Node v24 实测（H1、H3）。


---

## 第 5 轮（2026-08-11 · 全技术栈第二轮，聚焦上轮未审计面）

方法：6 个 explore 子代理聚焦上轮未系统覆盖的区域（agent 核心 journal/session-registry/stream-writer/legacy-import、tools/prompt/runtime 工具与提示面、model 适配器细节、http 路由协议细节、app-shell/agent 死角 + scripts、skills importer/legacy-migration + 迁移/研究工具），产出约 25 个候选；随后 4 批共 24 个**全新 skeptic 子代理**逐一批驳；主循环把关。报告 18（与第 4 轮不雷同），拒绝/降级 7。skeptic 有 4 项做过本机 Node v24 实测（C1/C2/M1 相关流式与 413 行为）。

### 确认存活的 Bug（18 个）

**R5-1（重大，legacy 升级路径）legacy 旧数据在每个新会话重复导入——未完成 Run 被重复自动执行**
- Location：`src/core/agent/legacy-import.mjs:266-269`（幂等判定读 `journal.readMigration()`）+ `src/core/agent/runtime.mjs:303`（每会话独立 storageRoot → 独立 migration.json）+ `:456-457`（reconcileSessionAfterLoad 每会话调 runLegacyImport）
- Phenomenon：migration.json 按会话级 journal 目录生成，而 legacy 文件（chat_history.jsonl/task_queue.json）在项目根、只读从不消费；reconcileSessionAfterLoad 对每个会话每次 open/submit 都调用，幂等检查永远为新会话放行。
- Impact：旧项目里新建第二个会话 → 同一份旧对话历史再次导入；`importUnfinishedRun` 把同一个未完成 Run 重新导入并在 open/submit 时**自动 startLoop 执行**（实测：open 即返回 status:"running" 并跑完写第一章）。旧任务在每个新会话里重复执行，真实模型调用 + 写文件副作用。
- Skeptic：**confirmed（major for legacy 项目，实证复现 open/submit 双路径）**。Q1 逐行核实 + Q3 真实 runtime 复现。测试全为单会话，零覆盖。

**R5-2（中-低）ZIP 技能导入：多顶层目录包（含 `__MACOSX/`）整体误拒，报误导性「缺少 SKILL.md」**
- Location：`src/core/skills/importer.mjs:165-170`（topLevels.size===1 才剥离前缀）+ `:181-186` + `:207-209`
- Phenomenon：stripPrefix 仅当顶层条目唯一时生效；`技能目录 + __MACOSX/`（或 + README.md）→ stripPrefix=null → SKILL.md 落到 staging/<目录>/ 而非根 → `readSkillNameOnly(staging)` 抛 `skill_file_not_found` → 整包 400。
- Impact：macOS Finder/归档工具生成的技能包（带 __MACOSX 元数据）是常见形态，导入必失败且错误信息误导；无绕过手段。
- Skeptic：**confirmed（minor-to-moderate，实证复现 A/B 失败、对照组通过）**。Q4 触发面真实（ZIP 导入是一等功能），Q5 无数据丢失故不升 major。

**R5-3（低-理论）流式解码缺 TextDecoder 末次 flush——末块多字节字符可能被吞**
- Location：`src/core/model/openai-compatible.mjs:325`（唯一 decode 带 {stream:true}）+ `:337-344`（无无参 decode() 冲刷）+ `src/app-shell/agent/api.js:337`（同款模式）
- Phenomenon：`{stream:true}` 解码会把不完整多字节序列缓存在 TextDecoder 内部，循环结束后从不 flush；末块若以中文字节中间结束，尾部字节永久丢弃。
- Impact：正常流以 finish_reason+[DONE]（ASCII）结尾故实际不触发；真实损失需连接在 CJK 字符中途被切断——此时本来就会触发响亮的截断错误（:347-354），缺 flush 反而避免了 `�` 垃圾。属卫生性缺项，两处流式实现均无。
- Skeptic：downgraded（minor/theoretical）。Q1 机制与语义实证确认，Q3 现实流不产生该损失。

**R5-4（低）network_allowed 提示面与执行层脱节——yolo 档下「关闭联网」不生效，prompt 宣称与实际相反**
- Location：`src/core/agent/runtime.mjs:1319`（只发 allowed|denied，confirm 从不产生）+ `src/core/agent/tools.mjs:182-222`（defaultPermissionPolicy 无 network 分支）+ `src/core/agent/prompt.mjs:79,91`
- Phenomenon：network_allowed 只进 prompt 文案；shell curl/wget 在 ask 档仍弹确认、yolo 档静默放行；`network_allowed=false`+yolo 时 prompt 写 denied 而实际放行。注：research 端点有硬拦截（research-tools.mjs:172-178 assertNetworkAllowed→403），故「执行层从不联动」仅限于 agent shell 工具。
- Impact：UI「联网权限」开关对 shell 工具无授权/禁用效力；提示文案与实际行为矛盾（方向保守，模型被告知 denied 后自我限制）。
- Skeptic：downgraded（cosmetic）。Q1 核实 + Q2 设计意图注释（联网权限属资料搜索功能），无 UI 开关、无测试覆盖。

**R5-5（低）截断/畸形工具参数静默以空对象 `{}` 执行——工具轮不透传截断**
- Location：`src/core/model/openai-compatible.mjs:403`（parseToolCallArguments 失败返 null）+ `src/core/agent/tools.mjs:348-349`（null → {}）+ `src/core/agent/runtime.mjs:1613-1657`（工具轮无 finish_reason 检查）
- Phenomenon：finish_reason=length 把 arguments 截断 → null → `parseToolArguments(null)` 返 `{}` → 工具以空参执行（read_file 读项目根目录、edit_file find 为空等）。后果并非静默破坏——各工具对 {} 都大声报错（not_a_file/bad_args/EISDIR）——但错误是误导性的，且工具轮从不显示截断提示（文本轮才有）。
- Impact：截断时用户看到「路径是目录」类工具错误而非「输出截断」；模型重试自愈。
- Skeptic：downgraded（minor）。Q1 机制核实，Q5 中心危害被工具 run 实现驳倒（均大声失败）。

**R5-6（低）NON_PROSE_PATTERNS 英文短语误杀正当英文小说正文**
- Location：`src/core/project-operations/chapter.mjs:185-190`（`\btool is not allowed\b`、`\bonly allowed tool\b`、`\ballowed tools include\b`）+ `:273-280`
- Phenomenon：整段正文对短语 regex 做大小写不敏感词边界匹配；skeptic 实证 `"The tool is not allowed in Sector 7."` 等普通英语对白/设定即命中 → append_chapter_segment 拒绝。
- Impact：英文小说用户正文含这些短语时章节写入被拒；但拒绝是工具错误返回模型（tools.mjs:1703-1710）、无失败计数、模型改写即过——非死锁。属测试钉死行为（chapter.test.mjs:132-151 断言拒绝）、设计注释自认的误伤面（只剔了 shell）。
- Skeptic：downgraded（low）。Q1 实证 + Q5 可恢复 + Q2 by-design 权衡。

**R5-7（中-低）needs_history_clear 降级会话无守卫——submit 后重启，追加事件从投影消失**
- Location：`src/core/agent/journal.mjs:1136-1144`（降级空投影置 needs_history_clear）+ `:1342`（续号 max(last_seq, store.lastSeq)）+ `:1115`（重启恒走空降级分支）+ `src/core/agent/runtime.mjs:2004-2046`（submit 无降级守卫）
- Phenomenon：中段坏段+锚点无效时打开为只读降级（文件头注释「绝不追加恢复事件」），但全库无任何 submit 守卫（grep needs_history_clear 仅 journal 内部）；降级会话上提交的消息以健康尾段续号追加、投影重放一次，重启后锚点带 needs_history_clear → 恒空分支 → 追加事件从投影消失（段文件仍在、历史分页可见，但会话状态/活动 Run 归零）。
- Impact：降级期间的用户输入与 Run 状态重启后静默重置，会话状态与事件日志长期不一致。触发需中段坏段+无效锚点双条件（罕见），事件未删（可恢复）。
- Skeptic：downgraded（moderate-to-minor）。Q1 全链核实、Q3 独立、Q4 无 append→restart 测试、Q5 罕见双失败+非硬丢失。

**R5-8（中-低）研究工具对无 sources.md 的项目首次调用必失败且永不自愈**
- Location：`src/core/research-tools.mjs:201-204,206-224`（裸 `fs.appendFile`）+ `src/core/project-store.mjs:79-80`（唯一创建点）+ `src/core/workspaces/migration.mjs:108-159`（迁移不复制）
- Phenomenon：appendFile 不创建缺失文件；sources.md/source_summaries.md 只在 createProject 初始化；迁移/手工打开的旧项目永无此文件 → 首次联网搜索/抓取 → ENOENT → 400 code="ENOENT"（project-routes.mjs:152-157），无兜底创建，永久失败。
- Impact：旧项目/任意文件夹打开的项目的资料搜索功能必挂；快照已写入但接口报错（诡异状态）。sources.md 只写不读（无数据丢失），触发需 network_allowed 开启。
- Skeptic：**confirmed（moderate，borderline minor）**。Q1 全链核实，触发形状被项目自身测试夹具证实（arbitrary-workspace.test.mjs 的 legacy 项目无 sources.md）。

**R5-9（低）Enter 键绕过压缩发送门禁——压缩在途时消息被静默排队**
- Location：`src/app-shell/agent/view.js:1598-1602`（按钮按 compactionBlocked 置灰）+ `:1700-1705`（Enter 只查 composerBusy 不查 compactionBlocked）+ `src/core/agent/runtime.mjs:1962-2055`（submit 无压缩态拒绝）
- Phenomenon：Task 8 的 busy 门禁注释明说「发送键/回车一律不提交」，Task 11 的压缩门禁只挡按钮；Enter 直接 submit → 输入 FIFO 排队（压缩完成后照发）或压缩取消时被连带取消（无 draft 回填）。
- Impact：用户以为被拦截的消息实际已发出；取消场景消息留在时间线无回复且草稿未恢复。非静默（input_queued 立即可见）、无新 Run 竞态（不变量保证压缩阻塞期 run 非终态）。
- Skeptic：downgraded（minor/cosmetic）。Q1 核实 + Q2 同族 Task 8 安全先例，Q5 最坏后果轻微。

**R5-10（低）write_file/edit_file 的 content/replace 无运行时类型校验——对象参数静默写成 "[object Object]"**
- Location：`src/core/agent/tools.mjs:946-949,987-989`（`String(args.content ?? "")`）+ `:923-930,960-969`（schema 声明 string 但全库无 schema 校验，parseToolArguments 只查顶层对象）
- Phenomenon：schema 只用于 prompt；运行时无任何类型校验（grep ajv/zod 零命中）。弱模型对 content 传对象/数组 → `String({})` → "[object Object]" 覆写目标文件，`{ok:true}`，确认弹窗只显示路径。
- Impact：文件内容静默损坏（无备份/撤销）；触发需模型违反自身 schema（低概率）；恶意模型本可直接传任意字符串，故不新增能力。同族安全写法 requireStringArg 在深工具处使用，此处独缺。
- Skeptic：downgraded（minor）。Q1 核实 + Q2 作者自己在 occurrence 处做了运行时复核（:990），证明是疏漏；Q4 默认 confirm 档+低概率。

**R5-11（低）受保护内置技能名的大小写变体绕过保留名保护（Windows）**
- Location：`src/core/skills/index.mjs:116-120` + `catalog.mjs:76`（精确大小写 `has()`）+ `skill-file.mjs:134`（目录名==name 精确匹配）+ `skill-file.mjs:154`（设备名检查用了 `iu` 旗标——作者知道 Windows 大小写不敏感）
- Phenomenon：`Balanced`/`FAST-READABLE` 大小写变体技能可导入、与内置 `balanced` 并存为两个 active 技能、项目版可被删除/替换——「三个写作风格保留名不可由项目层激活」冻结契约（catalog.mjs:18-25）可绕过。
- Impact：需 Windows + 用户刻意构造；内置技能保持完整可用，无覆盖/冒充/删除；影响是名字身份层级而非安全沙箱（技能不执行脚本）。
- Skeptic：downgraded（low）。Q1 全链核实、Q4 Windows-only+刻意触发、Q5 无实质危害。

**R5-12（低-装饰性）终态事件经快照路径到达时不触发 onRunTerminal——侧边栏状态点滞留「运行中」**
- Location：`src/app-shell/agent/index.js:157-167`（applySnapshot 只调 clearEscapeLatch）+ `:228-246`（onRunTerminal 只在 applyEvent 路径）
- Phenomenon：run_completed/failed/cancelled 若经 submit 后补快照或断线重连快照送达（lastSeq 已推进、SSE 不再重发）→ onRunTerminal 不触发。但 composerBusy 只对**其他**会话置位且由 5s 轮询复位（session-sidebar.mjs:111-120,514-516），不依赖该钩子。
- Impact：残留影响仅为当前会话侧边栏 8px 状态点/气泡滞留「运行中」，任何交互自愈；对话时间线本身正确（reduceSnapshot 重建）。作者已为 ESC latch 补过快照路径（I4），此处不对称。
- Skeptic：downgraded（cosmetic）。Q1 机制核实，Q1/Q4 驳倒 composerBusy 影响。

**R5-13（低）project-scope 技能迁移 marker/backup 缺项目维度——多项目串扰**
- Location：`src/core/skills/legacy-migration.mjs:93-95,191-195`（backup 路径只有 scope 无 projectRoot）+ `:326-334`（readMigrationMarker 无 projectRoot 参数）+ `src/core/skills/index.mjs:91-95`（有 projectRoot 却不传）+ `settings-routes.mjs:633-643`（migration_errors 用共享 marker 重读）
- Phenomenon：所有项目的 project-scope 迁移状态共用同一 marker 与 backup 目录；后迁移项目覆盖 marker → 设置页「迁移失败」显示别的项目的失败项；不同项目同名技能旧 manifest 备份互相覆盖（fs.rename 在 POSIX 和 Windows 都替换）。
- Impact：UI 显示他人项目迁移错误/自身失败被掩；备份覆盖仅在「两个项目同名技能」时发生，且全库无任何代码回读 backup（无自动回滚功能）——「备份即回滚依据」是手动安全网，被后项目销毁。触发需 v0.5.0 升级+≥2 项目。
- Skeptic：**confirmed（low）**。Q1 全链核实（含 Windows rename 语义修正），Q4 多项目测试缺口（legacy-migration.test.mjs:326-361 用不同名技能），Q5 降级。

**R5-14（重大，触发即发生）execute() 未捕获异常路径杀死整个 Run——retry 因悬空 tool_calls 链永久失败**
- Location：`src/core/agent/tools.mjs:1459-1465`（resolveFilesystemPath 在 parseToolArguments 的 try/catch 之外）+ `fs-utils.mjs:25-41`（只消化 ENOENT/ENOTDIR，EACCES/ELOOP 上抛）+ `tools.mjs:1809-1836,1713-1724`（appendEvent 失败 rethrow）+ `src/core/agent/runtime.mjs:1636`（调用点无 try/catch）+ `:1841-1854`（startLoop catch → failRun runtime_error）
- Phenomenon：路径预解析/决策事件写入抛异常（symlink 环、EACCES、EIO、journal 写失败）→ 逃过 execute 的全部错误收敛 → Run 以 runtime_error 失败；assistant tool_calls 已落盘（runtime.mjs:1581-1592）但无 tool 结果 → 悬空链；retry 时 buildHistory 保留该链（无 input_id、非 volatile）、dropOrphanToolMessages 只丢孤儿 tool 结果不丢 assistant tool_calls → provider 400（client-fatal 不重试）→ **同一会话每次 submit 都失败，需清历史才恢复**。
- Impact：一次 symlink 环/不可遍历目录即永久瘫痪该会话。代码自身把此形态列为硬不变量（runtime.mjs:1021-1023 注释「provider 会拒绝、retry 复用历史时同样受影响」），所有其他退出路径都调 closeDroppedToolCalls，唯独此路径漏。
- Skeptic：**confirmed（major-when-triggered，低概率触发）**。Q1 全链逐行核实 + Q2 文档化不变量被违。

**R5-15（低）shell 大输出截断不对称——终态事件/transcript 携带完整 stdout 绕过 1 MiB 折叠**
- Location：`src/core/agent/tools.mjs:58,145-163,1713-1724`（auditToolResult 只折叠 read_file/read_skill/search_files）+ `runtime.mjs:961-978`（persistentToolResult 同缺）+ `src/core/shell/runtime.mjs:19,52-56`（源侧各有 1 MiB 上限）
- Phenomenon：1 MiB 截断只作用于 tool_output_delta；tool_call_completed 与 transcript 对 shell 存完整 stdout/stderr（源侧各 1 MiB 上限）。
- Impact：非无界——每 shell 调用最坏约 5 MiB（delta 1M+completion 2M+transcript 2M），段文件 16 MiB 轮换，UI 64 KiB 上限（work-items.mjs:74）。真实缺陷是对称性缺口：delta 保留**首**1 MiB、终态保留**尾**1 MiB 重复存储，且不折叠为 content_length；tools.test.mjs:962 只断言 delta。
- Skeptic：downgraded（minor）。Q1 修正「无界」说法，Q5 留真实但次要的不对称。

**R5-16（低，纵深防御）GET /api/settings/model-secret 的 ?env= 无白名单——可读进程任意环境变量**
- Location：`src/core/http/settings-routes.mjs:345-358`（`process.env[envName]` 无校验）+ `src/app-shell/settings-modal.js:1533,2042`（前端只传固定预设/内部配置槽，无自由输入框）
- Phenomenon：env 查询参数直接作 process.env 下标；任何能触达 127.0.0.1:4173 的进程可读 PATH/USERPROFILE/任意 env。但同用户本地进程本可直接读 `~/.wwriting/secrets.json`（边际泄漏≈0）；浏览器跨源被 SOP 挡（无 CORS），DNS rebinding 受 PNA 缓解；返回明文 key 是设计行为（设置页完整显示，CLAUDE.md 明确）。
- Impact：纵深防御缺口——secret 返回端点缺注册槽白名单；无当前可利用的用户可见路径。
- Skeptic：downgraded（minor/defense-in-depth）。Q1 核实机制、Q1 驳倒「自由输入框」前提、Q5 威胁模型不成立。

**R5-17（低）composer 草稿持久化是死代码——切会话/项目时未发送文本被丢弃**
- Location：`src/app-shell/composer-draft.mjs:1-56`（saveDraft/loadDraft/clearDraft 全库零生产调用）+ `src/app-shell/agent/view.js:362`（reset() 清空 input）+ `tests/app-shell/agent-surface.test.mjs:551`（清空行为被测试钉死）
- Phenomenon：草稿模块 + 6 个绿测存在，但无任何生产接线；view.reset() 无条件 `input.value=""`，切会话/项目/占位时丢弃未发送文本。
- Impact：长草稿误点其他会话即丢失。但清空是**有意设计且测试断言**（「未发送草稿不得跨会话/项目泄漏」），文档从不承诺持久化——真缺陷是模块写完从未接线（feature 未完成/代码卫生）。
- Skeptic：downgraded（minor）。Q1 核实死代码 + Q2 行为 by-design 且测试钉死。

**R5-18（低）已存在但非法的 SKILL.md 遮蔽合法旧 manifest——技能迁移失败且 UI 滞留到重启**
- Location：`src/core/skills/legacy-migration.mjs:174-177`（存在即验证、非法则抛、不回退 manifest）+ `:61-87,106-115`（migrateScope catch 后 resolve 带 failed[]，不 reject）
- Phenomenon：合法旧 skill.json + 损坏 SKILL.md 并存时，迁移只验证 SKILL.md 抛错 → 该技能 failed、旧 manifest 不备份不替换；失败记录进磁盘 marker，设置页显示到下次进程启动。migrateScope 实际 resolve（技能级错误被 catch），进程内缓存不阻塞其他操作；UI 走 marker 重读（index.mjs:91-100 注释明确不依赖进程内缓存）。
- Impact：损坏文件被「绝不改写已存在的 SKILL.md」设计原则（:13-14,175）保护，属有意取舍；用户修好文件后需重启才消失。无数据丢失、自愈于重启。
- Skeptic：downgraded（minor）。Q1 驳倒「缓存拒绝 promise」主机制，Q2 by-design 注释，Q5 低概率+可自愈。

### 被拒绝 / 降级未报告的候选（过滤器工作记录）

- **C1 readJsonBody 逐 chunk UTF-8 损坏 → 400** - **rejected**。skeptic 实测：U+FFFD 是合法 JSON 字符，`JSON.parse` 永不失败，400 分支经此不可达；且回环部署下 ~64KB 内单 chunk 送达（16KB highWaterMark 是流控阈值非块大小），需 ~21K CJK 字符单条消息才可能见 U+FFFD 静默替换——残余为卫生性缺项。
- **C2 413 单位错误 + 抛错销毁 socket** - **rejected（b）/ trivial（a）**。skeptic 在本机 Node v24 实测：超大 body 5/5 送达 413、`response.destroyed` 恒 false、socket 存活——项目自己的注释（agent-routes.mjs:346-350）正是对 Node 24 销毁语义的勘误。(a) UTF-16 vs 字节命名不符属实但 composer 不可达（~66K 字单条）。
- **A4 stream-writer 吞错致 reasoning 永久缺块** - **rejected**。前提被驳倒：UI 侧 work-items.mjs:346 在 reasoning_completed 做全文对齐（`item.text = payload.text`），与正文路径对称；「stop 后 in-flight 增量被 requireActiveRun 拒」竞态不可达——stop 先写 stopping（非终态）、终态在 finish() 排空之后才落，FIFO 互斥保证顺序。吞错本身 by-design（stream-writer.mjs:12 + 测试钉死）且无害。
- **V5 api.js streamEvents 末事件丢弃 / \r\n 停滞 / 快照 URL 畸形** - **rejected**。服务器恒写 `\n\n`（agent-routes.mjs:369/380/390），干净关闭时残余为空、异常关闭残余是不可解析的截断 JSON；`\r\n` 需仓库不存在的非契约 server；畸形 URL 所有调用方都在有守卫的非空 open 之后（app.js:549、api.js:291），不可达。残余为 api.js:146 的 `&` 拼接代码味。
- **C3 /api/shutdown 无鉴权 CSRF DoS** - **downgraded（low）**。主诉被驳倒：shutdown handler 是空实现，真实关停是用户 before-quit 的 server.close()，网页打 shutdown 无效果；残余 DNS-rebinding 数据读取（含明文 key）真实但需恶意域名+受害者浏览+浏览器不拦 public→private（PNA 缓解中），纵深防御项。
- **C5 diagnostics 内部错误错标 404 no_project** - **downgraded（latent）**。catch 过宽属实，但全 repo 前端对 /api/diagnostics 零消费方（grep 无命中），「抽屉显示没有项目」不可发生；loader 的 JSON 解析全部自带守卫；残余是与 router「未知错误→500」约定不一致的一行清理项。
- **C6 之外的 M3（requiresAutoToolChoice 未消费）/ M4（非流式 finish_reason 未归一化）/ M6（mock 契约差异）/ T6（ask 档深工具 auto_allow）/ S4/S5（记忆提取下游）** - 潜伏或与已报告同根，保留在会话记录，未达报告门槛。

### 附：搜寻范围

第 5 轮共 30 个子代理（6 explore + 24 skeptic），覆盖 src/core/agent 全核心（journal/journal-segments/session-registry/stream-writer/workflows/legacy-import/context-window）、tools.mjs 全文 1875 行、prompt.mjs、runtime.mjs 全文 2617 行、model 适配器全 5 文件、http 路由全 4 文件 + router、app-shell/agent 全 9 文件、scripts 全部、skills 全套 + 迁移/研究工具。skeptic 独立读码，4 项 Node v24 实测（C1/C2 的 413 与 JSON、M1 的 TextDecoder、流式 chunk 边界）。

---

## 第 6 轮（2026-08-12 · 模型配置供应商两级重构完成后状态核查）

方法：按 `docs/superpowers/plans/2026-08-11-model-config-provider-refactor.md`（19 任务，分支 `feat/model-config-provider-refactor`，35 提交，每任务经独立 spec/质量双审）完成全部重构后，对历史报告逐条 grep 核实当前代码状态（非凭记忆）；同时记录重构执行中发现并修复的问题。基线 `npm test` 全绿（1624/1624）。

### 历史 Bug 状态更新（与本次重构相关）

**已修复（重构直接消除）：**

- **B3（连接测试客户端断开检测死代码 499 分支不可达）→ 已修复**（Task 11/B3）。`settings-routes.mjs` 的 `request.once("close", onRequestClose)` 死代码块已删除（grep 零命中），handler 改为 `({ body })`；客户端断开交由 fetch 侧处理。499 分支保留为「调用方取消」语义。
- **B6（连接测试超时被误分类为 499）→ 已修复**（Task 11/B6）。`model-connection-test.mjs` 探测定时器置位 `timedOut` 标志后 abort；`isCallerAbort` 仅对外部传入 signal 已中止返回 true；`classifyError` 三路（timedOut / timeoutSignal.aborted / `reason==="timeout"`）→ `request_timeout` → 路由映射 504（settings-routes.mjs:392,495-496,517）。测试改为走真实定时器路径的回归用例（原测试用注入 fake 绕过真路径的问题一并修复）。
- **B14（model-profiles.json 24 条硬上限 + upsert 无锁 RMW）→ 已修复**（Task 1/17）。v1 `local-model-profiles.mjs` 已删除（cutover）；v2 `model-provider-store.mjs` 无条数上限（`normalizeProviderStore` 不做 slice）；store 模块的 5 个 RMW 入口全部经模块级 `createMutex().run()` 串行（`withStoreLock`，model-provider-store.mjs:116-123，入口 :148/172/183/196/214），8 路并发 upsert 无丢失更新的测试钉死。**例外（核查确认）**：`ensurePresetProviders`（model-presets.mjs:67）的 load+save 不经 `withStoreLock`（模块注释自认，以启动期一次性执行为由）——对 store 模块自身的写入口成立，「所有读-改-写」若读作全局则夸大。
- **B5（fetchModelSecret 迟到响应跨供应商 tab 串写 API Key）→ 已消除（随功能删除）**（Task 17）。`fetchModelSecret` 与 settings-modal 模型区块一并删除，`GET /api/settings/model-secret` 端点删除（grep 零命中）——串写面不存在；密钥管理走新设置页 PATCH `{ api_key }` → secrets.json。
- **R5-16（GET /api/settings/model-secret ?env= 无白名单读进程任意环境变量）→ 已消除（随功能删除）**（Task 17）。与 B5 同一端点（model-secret）的两个问题随端点删除一并消失。
- **D2（GET 读路径写回 project.yaml）→ 已修复**（Task 7）。写回式同步（`refreshProjectModelFromGlobal`/`syncProjectModelFromGlobal`/`differsFromCurrent`）全库删除（grep 零命中）；项目 `active_model` 只存 `{provider_id, model_id}` 引用、运行时解析，按 model_name 匹配写回的机制不复存在。
- **D5（simple-yaml 破坏嵌套 YAML → app-server 兜底）→ 相关兜底已删除**（Task 5/8）。`effectiveWorkspaceConfigFor` 的 `getDefaultLocalModelProfile` 兜底块删除（Task 5）；dispatch 未配置模型改为抛 `ProviderConfigurationError("未配置模型：请先在模型设置中选择模型。")`（app-server.mjs:282-283），无任何静默回落路径；「未配置」成为一等状态（聊天框显示、点击弹选择器）。

**部分改善（机制链部分修复，剩余不在本重构范围）：**

- **M3（官方定价链路断开、成本面板恒「未配置价格」）→ 部分改善**。`OFFICIAL_PRICING` 获得首个消费者：`model-presets.mjs` 种子（Task 2）给预设模型带官方价落盘；`cost-tracker.mjs:2,67` 的 `resolvePricing(model, pricing)` 消费路径存在。但成本面板展示链（CostTracker 实例的 pricing 注入、前端 cost-panel 读取）未在本重构范围内改动/验证，「未配置价格」是否已消失需另行核查。
- **M4（[1m] 尾标破坏官方价补缺）→ 部分改善/仍潜伏**。预设种子侧已修正（presetModel 用无尾标 model_name 精确查表，Task 2）；保存路径的补缺逻辑与成本侧前缀匹配未改；UI 仍不发送 pricing（与 M3 同根），触发面依旧为手工构造 HTTP body。

**仍存活（本次重构未触及）：**

- 第 3 轮 3 项（submit 补快照项目切换 / 失败文本灌入新项目输入框 / Enter 未守 isComposing）
- 第 4 轮 B1（reveal-path IPC 边界）、B2（章节连续性记忆管线零接线）、B4（网关空闲超时误杀纯工具流——gateway.mjs 未被本分支改动）、B7-B13、B15-B18
- 第 5 轮 R5-1 ~ R5-15、R5-17、R5-18

### 重构执行中发现并修复的问题（追溯记录）

重构过程中各任务的 spec/质量审查独立验证发现并修复了以下问题（均在分支内修复，测试锁定）：

- **v1/v2 存储文件冲突**（Task 6）：`model-profiles.json` 同时被 v1 写回同步与 v2 store 使用；v2 的 v1→v2 自动迁移写回会破坏仍活着的 v1 视图、并产生一次性随机 provider id 的悬空引用。修复：迁移路径用只读加载器 `loadProviderStoreReadOnly`（只认持久化 v2，v1/未知按空清单——mock 归零不依赖清单），v1→v2 转换由运行时首次调用完成，幂等自愈。**核查注**：该只读加载器无直接测试（迁移测试全部注入 `storeLoader`），只读/不写回行为仅代码层面确认（project-model-migration.mjs:30-43，仅 readJson+normalize）。
- **`[1m]` 窗口信号丢失**（Task 5 修复轮）：`toRequestConfig` 剥离 `[1m]` 尾标后，运行时 `parseModelIdentity` 推导上下文窗口的输入丢失 → 1M 模型被按 256k 处理（潜在提前压缩/硬窗口误杀）。修复：解析器保留原始 model_name，剥离职责归 `model-identity.mjs` 唯一权威（与 `stripWindowMarkers` 语义对齐为剥全部尾部标记）。
- **null active_model 不回落全局默认**（Task 5 修复轮）：新建项目无 active_model 时不再使用全局默认模型（旧 `getDefaultLocalModelProfile` 行为）。修复：`resolveActiveModel(null, store)` 走 `resolveDefaultModel`，无默认才是未配置。
- **删除预设复活**（Task 2/3）：按「清单无预设 id 即种子」实现会让用户删除的预设复活（计划代码与自身测试矛盾）。修复：store 增加 `seeded_preset_ids` 跟踪字段，删除不复活；迁移时记录全部预设 id（迁移用户不被打扰）。
- **独立供应商重复模型丢运行期字段**（Task 3 修复轮）：同 base_url+model_name 的 v1 旧条目第二条的 temperature 等字段被静默丢弃（与官方分支不对称）。修复：find-or-create 后无条件合并运行期字段；`max_context_tokens` → `context_window` 映射补上。
- **默认指针/角标缺陷**（Task 14 修复轮）：列表点击供应商丢 `default_model`（「默认」角标消失）；停用模型可被设为默认（产生悬空指针）。修复：点击保留 default_model；store/路由/前端三层拒绝停用模型设默认（`model_disabled`）。
- **providers-routes remove 500→404**（Task 11 附带）：删除不存在供应商下的模型时，store 裸抛错经 wrap 落 500。修复：`providerOf` 预守卫 → 404 `provider_not_found`。
- **模型设置页骨架期缺陷**（Task 12 修复轮）：新页零 CSS 且抽屉入口被 scrim 遮挡（用户点击「打开模型设置」无可见反应）；`refresh()` 无错误守卫（静默失败面）。修复：overlay 样式（z-index 110，高于抽屉 50/设置 100）+ 抽屉先关闭 + `res.ok`/`Array.isArray` 守卫 + toast。
- **密钥/环境变量名校验**（Task 10/13 修复轮）：PATCH api_key 时 env 名未按 secrets 层正则校验（非法名被静默过滤、落盘无提示）；pull-models 的 URL 构造在 try 外（scheme 缺失误报 400 invalid_provider）。修复：路由与前端统一 `API_KEY_ENV_NAME` 正则前置校验；URL 构造入 try 映射 `pull_failed`。
- **设置页搜索框绕过占位**（Task 8 修复轮）：旧弹窗模型区占位期间，搜索输入仍可重渲染旧模型列表并触发真实 `model-select` 写。修复：section 为 model 时搜索监听 no-op。**后续修正（核查确认）**：Task 17 cutover（9cf93ab）把 `settingsSearch` 输入框及其监听器整体删除（当前 HEAD 无搜索监听），该 no-op 机制已被「删除」取代，绕过面更彻底；96787b6 附带的守卫测试亦已改写。

### 附：核查范围

grep 核实（`request.once("close")` / `local-model-profiles` / `global-model-settings` / `fetchModelSecret` / `model-secret` / `refreshProjectModelFromGlobal` / `slice(0, 24)` / `getDefaultLocalModelProfile` 等在 src 零命中或仅注释残留）；`OFFICIAL_PRICING` / `createMutex` / `resolvePricing` 消费方确认；`npm test` 1624/1624 全绿。仍存活项未重新逐行复核（沿用原报告证据），仅确认其相关模块未被本分支改动。

> **独立核查结论（2026-08-12）**：本第 6 节经独立 skeptic 子代理逐条对抗验证（19 项：17 项完全属实，2 项表述精度问题——已按上文「核查注/例外/后续修正」就地修正），全部行号引用精确，`npm test` 计数与实测一致。M3/M4 的「部分改善/未验证」框架经证保守诚实（成本面板展示链确未触碰）。

---

## 第 7 轮（2026-08-13 · 批 1-3 修复完成后状态核查）

方法：按 `docs/design/2026-08-12-bugfix-round7-spec.md`（8 项核心概念 C1-C8 + 24 项原报告 A 组 + 设置页/计时，分 4 批）执行批 1-3，共 17 个提交（基线 `a4cf8bb` → HEAD `a935eaa`）：批 1 恢复执行内核可信度（`c12d296` shell 进程树 → `5795e2e` 截断参数拒绝，5 提交）；批 2 原子切换输入状态机（`38101a7` 闭合生命周期 → `e1f227a` 单一 Agent 架构测试，7 提交）；批 3 记忆/Legacy 清理与高收益 bug（`25f2d67` 删旧聊天迁移 → `a935eaa` 技能与工具数据边界，5 提交）。批 1 先以 3 项 Windows shell 进程树失败建立红色基线，批 1 结束恢复全绿。本报告逐项对照规格核实当前代码（grep + 行级阅读 + 事件/API 签名核对），并运行门禁：`npm test` 1693/1693（0 fail）、`npm run verify:unified-agent` 34/34（0 fail）。以下按「已修复 / 已删除旧概念 / 明确接受风险」三分类记录；第 4 批（设置页 15 项、工作计时、UI 渲染验收）尚未执行，单列「计划中」。

### 已修复（本批落地并经代码核实）

**核心概念 C 项：**

- **C2（输入生命周期歧义）→ 已修复**（批 2）。新生命周期对**普通文本输入**只产生六类事件 `input_queued/input_started/input_completed/input_interrupted/input_withdrawn/priority_input_requested`（journal.mjs 事件类型清单）；每条普通文本输入恰好一个终态，`input_started` 是唯一把文本写入 transcript 的边界，撤回输入对正式历史与模型 transcript 无痕（verify 场景 28）。**限定**：`/compact` 队列项不套用该六事件契约——安全点激活走 `input_promoted(reason:"compact_safe_point")`、收尾由 `processCompact`/压缩收敛以 `input_consumed`/`input_cancelled` 终结，是新世代对 /compact 的独立事件路径（详见下方「已删除旧概念」注）。
- **C3（「立即」安全点优先调度）→ 已修复**（批 2）。`requestPriority` → `priority_input_requested` 只标记 `priority_input_id`，不 abort 在途模型请求；在模型响应完成/工具开始前/工具结束后/下次模型调用前的安全边界切换；未开始工具以 `tool_skipped_for_priority_input` 闭合、不启动；`input_interrupted` 不自动重跑（verify 场景 29a/29b/29c + 30 的 priority_pending 409 + 31a/31b 崩溃重放）。
- **C4（单条撤回）→ 已修复**（批 2）。`withdrawInput` Runtime API + HTTP 路由 + 前端回填：`input_withdrawn` 不可见于 UI/模型历史/导出，`draft_text` 权威回填且不覆盖 composer 现有草稿。
- **C5（工具期限）→ 已修复**（批 1）。统一 5 分钟空闲 + 60 分钟绝对期限，工具经独立 AbortSignal 接收取消，超时写入结构化 `tool_timeout` 结果（不杀 Run）；shell 超时/停止终止整棵进程树并等待资源释放（3 项 Windows 红色基线恢复全绿，`c12d296`）。
- **C7（记忆职责）→ 已修复**（批 3，`ce9cc73`）。`commitChapterMemory` 由 runtime 注入 `memoryExtractor` 接线（chapter.mjs:587-594，runtime.mjs:63,126-143）；`commit_chapter` 提交成功后单独触发派生提取，提取失败只记录可恢复维护错误、不回滚正文；prompt 删除「commit_chapter 已一致更新全书摘要」的虚假宣称；`WWRITING.md` 不被章节摘要自动污染。

**原报告 A 组（第 4 轮 B 项 + 第 5 轮 R5 项）：**

- **B1（reveal IPC 边界锚错）→ 已修复**（批 3，`40e353f`）。reveal 类 IPC 统一走 `validateProjectRoot()` 白名单（electron-main.cjs:58,126-129），项目外「打开文件夹」按钮不再失败。
- **B2（章节连续性记忆零接线）→ 已修复**（批 3，`ce9cc73`，同 C7）。`commitChapterMemory` 落盘路径随 `memoryExtractor` 接线启用，`commit_chapter` 成功后独立触发派生提取（book_summary.md/continuity 不再永不落盘）；prompt 删除虚假宣称、改为如实声明「不保证 commit 已更新全书摘要，派生数据由提交后独立提取或维护任务重建」（prompt.mjs:159）；`scripts/rebuild-memory.mjs` 校准为维护路径（只重建派生记忆，不触碰正文/索引/WWRITING.md）。注：旧的 `buildContinuityPromptContext`/`buildRelevantFacts` prompt 上下文注入助手保持无生产消费方——符合规格 §3.1.9「章节相关动态上下文不再自动注入，Agent 按需读取文件」的新设计，非疏漏。
- **B4（网关空闲超时误杀纯工具流）→ 已修复**（批 1，`eb15741`）。Gateway 无条件安装内部活动包装器，所有 SSE 帧（含工具参数帧）刷新 `lastActivityAt`，不依赖外部 `onActivity` 注入；非流式请求加 heartbeat 通知；单次请求总期限默认改为 6 小时（`total_deadline_ms` 可覆盖）。
- **B7（openReader 无响应守卫）→ 已修复**（批 3，`21eab73`）。await 后校验项目 scope 与 `readerChapterNo`，慢响应不再覆写错章。
- **B9（app-state 非原子覆写）→ 已修复**（批 3，`40e353f`）。`writeFileAtomic` 落盘 + 模块级 mutex 串行化 `recordRecentProject`（app-state.mjs:10-13,72）。
- **B10（project-lock tails 死清理）→ 已修复**（批 3，`40e353f`）。以派生 promise 正确比对并删除条目（project-lock.mjs:8-27），测试经可实例化 registry seam 观测。
- **B12（设置分区无守卫异步）→ 已修复**（批 3，`21eab73`）。await 续作校验 `sectionGeneration`（settings-modal.js:231,265,592-594,782-794）。
- **B13（session-sidebar 泄漏）→ 已修复**（批 3，`21eab73`）。移除项目时清理缓存/DOM 引用/折叠记录并封存（`sessionSidebar.removeProject`，app.js:596-601）。
- **B15（stop 路由 TOCTOU）→ 已修复**（批 2，`e025db8`）。`agent.stop` 接收并可校验 `runId`（agent/index.mjs:16-17，runtime.mjs:2419+ 在项目互斥锁内重读投影、`run.id !== runId` 即 `run_not_found`），HTTP 层不再「快照后再停止」，杜绝误停新 Run。
- **B17（server.close 无超时）→ 已修复**（批 3，`40e353f`）。抽 `closeServerGracefully`（server-start.cjs:11），超时后 `closeAllConnections`（electron-main.cjs:222-223），菜单退出不再被吞。
- **B18（runSave finally 覆盖按钮）→ 已修复**（批 3，`21eab73`）。`saveSequence` 条件化收尾，跨分区不复活死按钮/不自动关弹窗（settings-modal.js:89）。
- **R5-2（ZIP 多顶层误拒）→ 已修复**（批 3，`a935eaa`）。仅忽略白名单元数据项（`__MACOSX` 镜像子树、顶层 `.DS_Store`、顶层 README），多个真实技能根仍拒绝（importer.mjs:102-111,179-214）。
- **R5-3（TextDecoder 缺 flush）→ 已修复**（批 1，`5795e2e`）。两处流式实现无参 `decode()` 冲刷（openai-compatible.mjs:340-343、api.js:368-371）；不完整尾字节解码为 U+FFFD 属明确接受的「不静默丢字节」行为。
- **R5-5（截断工具参数静默空对象）→ 已修复**（批 1，`5795e2e`）。tool-call 级完整性标记，截断参数以 `truncated_args_rejected` 拒绝执行，普通截断文本保留并提示。
- **R5-7（needs_history_clear 无守卫）→ 已修复**（批 3，`21eab73`）。snapshot 透出 `needs_history_clear`（state.js:765-769）；前端显示「此对话已损坏」并禁发（view.js:206,1719-1723 + index.js:459-466 第二道防线）；后端 submit 拒绝契约不变。
- **R5-8（research 无 sources.md 必失败）→ 已修复**（批 3，`a935eaa`）。先 `ensureDir` 父目录并创建缺失文件（带头部，与 createProject 初始化一致）再追加，首次调用不再 ENOENT（research-tools.mjs:203-216）。
- **R5-9（Enter 绕过压缩门禁）→ 已修复**（批 3，`21eab73`）。keydown 与发送按钮共用同一 `canSubmit` 判定（view.js:1829-1833），busy/压缩阻塞/对话损坏任一即禁发。
- **R5-10（write_file 类型校验）→ 已修复**（批 3，`a935eaa`）。content/replace 复用 `requireStringArg` 运行时类型校验（tools.mjs:1010,1050），对象参数不再静默写成 "[object Object]"。
- **R5-11（技能名大小写绕过）→ 已修复**（批 3，`a935eaa`）。Windows 下名称比较统一大小写归一（skill-file.mjs:133），保留名保护不可绕过。
- **R5-12（onRunTerminal 快照缺失）→ 已修复**（批 3，`21eab73`）。Run 终态统一刷新：`maybeRefreshAfterTerminal` 补拉 Agent snapshot + `onRunTerminal` 转发 `refreshSessions()` 与 `loadDashboard({background:true})`（app.js:118-124），后台刷新失败只 toast 不渲染错误页。
- **R5-13（技能迁移 marker 缺项目维度）→ 已修复**（批 3，`a935eaa`）。backup/marker 按 canonical projectRoot 的稳定 hash（前 12 位）分目录，多项目互不串扰（legacy-migration.mjs:11,39-47）。
- **R5-14（execute 异常杀 Run）→ 已修复**（批 1，`d6fcdbc`）。路径预解析/决策事件写入等异常收敛为结构化工具错误，不再逃过 execute 错误收敛杀 Run；Journal 写失败保持致命；未执行调用全部闭合（`closeDroppedToolCalls`，runtime.mjs:1037），悬空 tool_calls 链不再永久瘫痪会话。
- **R5-15（shell 输出截断不对称）→ 已修复**（批 3，`a935eaa`）。delta 与终态统一携带 `content_length` + `truncated` 元数据，折叠语义对称（tools.mjs:76,185-192,757-795）。
- **第 3 轮 3 项 → 已修复**（批 3，`21eab73` 及此前提交；规格 §4.2 注明「继续移出本轮，仅在报告中标记已修复」）。submit 补快照防项目切换：`isCurrentProjectScope` 双代次（projectGeneration + sessionGeneration）守卫（index.js:135-150）；失败回填 generation 守卫：`submissionGeneration !== viewGeneration` 即丢弃（view.js:1793-1794,1805-1806）；Enter/Tab 守 `isComposing`（view.js:1817）。
- **R5-1（legacy 重复导入）→ 随 C6 旧聊天兼容层整体删除而消除**（批 3，`25f2d67`；详见下方「已删除旧概念」）。

### 已删除旧概念（workflow/legacy/blueprint 生产代码零引用；输入生命周期旧事件对的退役范围有明确边界，见下）

- **C1（隐藏 workflow 门禁）→ 已删除**（批 2，`90acb0d`）。`src/core/agent/workflows.mjs` 整体删除；`enter_workflow` 不再注册（tools.test.mjs 负向断言「已删除」）；`workflow_changed` 生产零引用；`WORKFLOW_POLICIES` 删除；`run_started` 不再携带 `workflow`；运行时每轮提供同一套生产工具目录（verify 场景 27 断言执行流不出现目录外工具）。
- **C6（旧聊天兼容层）→ 已删除**（批 3，`25f2d67`）。`legacy-import.mjs`（277 行）、`journal-session-migration.mjs`（207 行）及专属测试删除；`migrateProjectAgentStorage` 与项目内 `.wwriting/agent` 复制路径删除；旧 flat 单体/项目内旧布局/旧单体 Journal 三种布局均不导入（verify 场景 13：零会话条目、旧文件字节不变、snapshot/导出/模型请求无旧文本；场景 14：新项目不创建旧状态文件）。
- **C8（旧蓝图事务）→ 已删除**（批 2，`d89c48d`）。`commit_blueprint` 不注册；`blueprint.mjs` 及其专属测试删除；`blueprint_status` 无生产读写、新项目默认值不含（verify 场景 14 负向断言）；`OUTLINE.md`/`SETTING.md` 保留为普通项目文件（verify 场景 16：`/init` 用通用工具创建 `WWRITING.md`，无固定蓝图文件）。
- **旧输入生命周期事件**：`input_consumed`/`input_promoted` 不再由普通文本输入产生——前端「立即」已整体切换 `requestPriority`（agent/index.js:584-586 注释「旧 promote 概念已删除」），旧 `promote` HTTP 端点与 runtime 路径（interrupt_requested + input_promoted，runtime.mjs:2294）保留为兼容入口（verify 场景 4、acceptance 仍覆盖该兼容路径）。**但二者并未彻底退役：`/compact` 队列项在新世代仍走旧事件对**——安全点激活 `input_promoted(reason:"compact_safe_point")`（runtime.mjs:1936，Task 8 注释自述「消费但不给终态、由 processCompact 收尾」），收尾 `input_consumed`（processCompact noop 分支 :1339、手动压缩成功 :1359、手动压缩完成收敛 :2626），恢复路径的陈旧记录也以 `input_consumed` 消费跳过（:1986）；这是新世代对 /compact 的既定设计路径，不是兼容残留。journal.mjs reducer 对三者保留 legacy 分支（FIXED_EVENT_TYPES 清单仍含 input_consumed/input_cancelled/input_promoted，注释自述接纳原因）。`input_cancelled` 语义收窄为「硬停止/压缩取消」的收敛终态（stop 与压缩取消路径仍产生，verify 场景 5 断言），不再承担「立即打断」语义（由 `input_interrupted` 承担）。注：若 Task 26 以「新 generation 生产路径 0 命中」为负向扫描口径，上述 /compact 事件路径需届时另行明确处理——本报告只记录现状，不承诺届时必改。

### 明确接受的风险（保持现状，不写成已修复）

- **B8（shell 可写项目外，YOLO 高风险边界）**：静态解析无法可靠覆盖 `cd` 链、变量、脚本和外部程序，本轮不新增启发式目标扫描；YOLO 档下 shell 仍可能绕过正文保护或写到项目外，只以 prompt 纪律降低概率——**不得视为安全保证**（规格 §3.9.4）。
- **B11（output_style 死设置）**：`output_style` 是全库唯一「死设置」（settings-modal 写入/校验/默认值齐全、全 src 零消费方，唯一消费者 prompt-compiler 已在历史提交删除）；UI 与用户指南仍宣称该下拉生效，用户选择后行为不变。属旧设置/文档清理议题，实际风格机制是 `writing_style_skill` + `read_skill`，不混入 Agent 执行内核替换——本轮保持现状（规格 §4.4）。
- **段号连续性**：不以系统门禁防御，只靠 prompt 纪律与模型自查（prompt 要求段号按顺序递增、完成前自查连续性）——明确接受的残留风险（规格 §3.9.5），不得写成已修复。
- **B16（非流式无真实活动信号）**：非流式 provider 不提供中途事件，Gateway 只能用总期限或人工 heartbeat，不误称真实进展；批 1 已把默认总期限延至 6 小时以降低误杀（B4 修复的组成部分），但不消除可观测性缺口（规格 §4.4）。
- **R5-4（shell 联网权限提示面）**：`network_allowed` 只进 prompt 文案、对 shell 工具无授权/禁用效力；授权模型需与权限产品设计一起重做；research 工具硬拦截保持不变（规格 §4.4）。
- **R5-6（NON_PROSE_PATTERNS 误伤）**：章节工具内容过滤的明确取舍（测试钉死行为），另行评估是否删除该过滤（规格 §4.4）。
- **R5-17（composer 草稿死代码）**：当前「不跨会话/项目保留未发送草稿」是被测试钉住的产品行为；死模块清理可单独进行（规格 §4.4）。
- **R5-18（非法 SKILL.md 遮蔽旧 manifest）**：现行「绝不改写已存在的 SKILL.md」原则不自动覆盖用户文件；修复需先确定是否允许自动修复损坏用户文件（规格 §4.4）。
- **M3/M4（成本定价展示链）**：保持现状，本轮不扩大到成本产品功能（规格 §4.4）。M3 预设种子侧已在模型配置重构中部分改善（第 6 轮已记录 `OFFICIAL_PRICING` 首个消费者），成本面板展示链（CostTracker pricing 注入、前端读取）仍维持「未配置价格」的诚实展示。

### 计划中（批 4 未执行，不写成已修复）

- 模型设置页 15 项高/中（规格 §4.3：CSS/溢出、焦点陷阱/ARIA、密钥「已配置」状态、成本人民币元、空值保存、会话重命名去 `window.prompt`、终态刷新顶栏/抽屉/成本面板、测试连接先提交表单、未保存确认、切换失败 toast、保存提示一致性、v1→v2 并发迁移单锁、`active_model` 静默丢弃、密钥 env 显式开关、英文错误中文化）——Task 19-22，批 4。
- 工作计时 `formatDuration` 统一（规格 §4.5）——Task 24，批 4。
- UI/真实渲染验收（规格 §6.5：1280x800/768x900/390x844 布局、键盘焦点顺序/陷阱/Escape、Electron smoke 会话重命名、密钥不回显、视觉截图归档到 `artifacts/visual-acceptance`）——Task 25，批 4。

### 门禁结果（Task 18）

- `npm test`：**1693/1693 通过，0 fail**（以 0 fail 为基线，不以固定总数为准——本轮删除旧 workflow/legacy 测试并新增回归，总数自第 6 轮 1624 变化）。
- `npm run verify:unified-agent`：**34/34 通过，0 fail**（含批 1-3 新增场景 13 旧存储不导入、27 章节工具后普通问答、27b 受保护正文路径、28 queued 撤回、29a/29b/29c 优先调度、30 第二 priority 409、31a/31b 崩溃重放，以及保留的兼容路径场景 4 promote/场景 5 停止取消）。

### 附：核查范围

grep 核实（`enter_workflow`/`workflow_changed`/`WORKFLOW_POLICIES`/`commit_blueprint`/`blueprint_status`/`runLegacyImport`/`migrateProjectAgentStorage` 在 src 与 scripts 零命中或仅负向断言；`output_style` 全 src 零消费方核实）；修复签名行级核对（`validateProjectRoot`/`writeFileAtomic`/`closeServerGracefully`/`requireStringArg`/`content_length`/`truncated_args_rejected`/`needs_history_clear`/`__MACOSX` 白名单/hash marker/sectionGeneration/saveSequence/isCurrentProjectScope/submissionGeneration/`isComposing` 等均在预期文件命中并附 Task 编号注释）；`input_consumed/input_promoted` 不再由普通文本输入产生，但 /compact 队列项（runtime.mjs:1936 激活、:1339/:1359/:2626 收敛）与恢复路径陈旧记录（:1986）仍在生产使用，旧 promote 兼容端点（:2294）保留；`input_cancelled` 仍由 stop/压缩取消路径产生（语义收窄）。门禁实测：`npm test` 1693/1693、`verify:unified-agent` 34/34 全绿。批 4 项目未执行，本报告不将其列为已修复。
