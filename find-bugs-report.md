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
