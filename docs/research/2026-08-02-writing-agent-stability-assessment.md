# WWriting 写作 Agent 稳定性评估报告

- 日期：2026-08-02
- 范围：写作循环控制流（agent-loop / writing-agent-session / agent-engine）、内容质量保障链路（fact-check / 字数门禁 / 连贯性记忆）、provider 兼容层已知债务核实
- 方法：3 个并行只读代码调研子代理分别核实控制流、质量链路、已知债务清单，逐条对照当前源码验证，非仅采信历史记忆文字
- 结论摘要：核心闭环（自查资料→写作→自我核对→冲突打回）机制健全，是这个软件区别于"一次性对话式生成"类工具的核心卖点；已识别 5 类具体瑕疵风险，其中 2 类是设计取舍（已知限制），2 类是待补硬化项，1 类是子系统尚在收敛（DeepSeek 兼容层）

## 1. 三层控制流架构现状

```
agent-loop.mjs          领域无关 turn 循环（模型响应 → 工具执行 → 下一轮，事件化）
writing-agent-session.mjs  控制平面：start/steer/followUp/abort/waitForIdle
agent-engine.mjs         唯一领域适配层：runWritingAgentLoop + dispatchSingleToolCall 四分支
```

四分支（`dispatchSingleToolCall`）：A 直接文本输出当正文 / B 工具不在白名单 / C 提交 `append_chapter_segment` / D 白名单内 read/edit/update 工具。

### 1.1 已核实：session.abort() 中断链路

- `writing-agent-session.mjs:162` 的 `abort()` 触发 `abortController.abort()`，signal 一路传到 `model-client.mjs:144`（`AbortSignal.any`）和 `provider-adapters.mjs:124` 的 `fetch(..., {signal})`，理论上能打断进行中的 HTTP 请求。
- 但**没有任何生产代码调用点**会主动触发 `session.abort()`——全局搜索仅测试文件手动调用。真正的用户"停止"走的是另一条独立通道：`app-server.mjs` 的 `job.controller.abort()` → `runProject(options.signal)` → `runWritingAgentLoop` 的 `request.signal`，与 `WritingAgentSession` 内部 `abortController` 是两套独立信号。
- **判断**：日常"停止"按钮是能用的（走另一条通道），但 `WritingAgentSession.abort()` 本身是预留但未接线的能力，属于技术债而非用户可感知的故障。

### 1.2 已核实：工具执行异常不计入失败计数

- `agent-engine.mjs:1687-1701` `dispatchSingleToolCall` 的 catch 块只返回 `{ok:false, summary:"tool_error"}`，不调用 `rejectOutput`，不计入 `commitFailures`。
- 校验失败/权限拒绝有计数上限（`WRITING_AGENT_COMMIT_FAILURES=8`），但工具执行异常（比如文件系统报错）没有独立计数器。
- **风险**：若模型反复调用同一工具触发同一类异常，会一直空转直到 `WRITING_AGENT_MAX_TURNS=24`（agent-engine.mjs:1428）硬顶耗尽才停，而不是提早识别"这条路走不通"并降级处理。

### 1.3 已核实：24 轮耗尽 / 多 tool_calls 边界行为

- 24 轮耗尽：`agent-loop.mjs` 返回 `outcome="exhausted"` → `failWritingAgentLoop` → 抛 `ProjectBlockedError("agent_loop_exhausted")`。pending transcript 文件**不会被清理**，半成品保留供恢复；用户可通过故障卡"重试当前段"触发续跑，不会丢已完成部分。
- 并行 tool_calls：`agent-engine.mjs:1781-1819` side 段顺序执行，某个 tool_call 抛错时正确回填 `{ok:false,error}`，后续 tool_call 继续执行，不会级联跳过；只有 `append_chapter_segment` 已提交后，后续 tool_calls 才统一标记 `skipped_after_commit`。逻辑自洽，未发现新边界漏洞。
- 网络层重试：`model-client.mjs` 对 429/502/503/504/timeout/network 做指数退避重试（`retryMax=3` 默认，含 jitter 与 Retry-After），超过重试上限后明确抛错，状态置为 `interrupted` 并生成故障卡，不会悄悄放弃或卡死。

### 1.4 前端遗留死代码（不影响后端稳定性）

- `app.js` 的 `handleQuick`"查看正文"分支判定逻辑仍在文件中，但已无按钮会生成触发它的 label（该快捷入口已在 `dd39574` 删除）。已完成章节仍可通过文件卡"打开阅读"正常查看，纯遗留死代码，无功能影响。

## 2. 内容质量保障链路

这是这个软件区别于"一次性对话式生成"类 AI 写作工具的核心机制。

### 2.1 fact-check 反思闭环 —— 机制健全

- 冲突判断是**模型自主判断**，不是关键词/正则匹配：`buildFactCheckMessages`（quality-gates.mjs:248）把正文 + 既有 facts/timeline 一并喂给模型，用结构化输出 schema 解析出 conflicts。
- 3 轮打满仍有冲突时，**不会软放行发布**：`blockFactCheckUnresolved`（agent-engine.mjs:845-871）把 project_status 设为 `blocked`，写故障卡片，抛 `ProjectBlockedError`。用户能看到明确的"有冲突未解决"提示，不会带着已知矛盾内容被静默发布。

### 2.2 fact-check 进展检测 —— 有缺口（已知限制，非 bug）

- `applyFactCheckConflicts`（agent-engine.mjs:816-821）冲突数未减少时，只追加一句 `progress_hint` 文本提示模型换思路，**不会**提前终止循环——即使第一轮就已发现"这个方向走不通"，仍会硬跑满 3 轮才停。
- **影响**：不影响结果正确性（3 轮打满一样会 block），只是可能多花一点时间和 token。

### 2.3 字数门禁 —— 仍是 hard gate（潜在注水风险）

- `reviewChapter`（agent-engine.mjs:376-398）`gate.status==="failed"` 直接打回 `needs_revision` 重写，尚未改成 warning+目标的软门禁。
- 重写指令（quality-gates.mjs:46）只说"继续写"，**没有防注水约束**。
- **风险**：如果项目设置的目标字数偏高，模型有较大概率靠堆砌描写、重复交代来凑字数，而不是被明确禁止这么做。这是内容质量层面用户最容易感知到的瑕疵来源。

### 2.4 revise 退出机制 —— 部分健全

- revise 阶段模型执行 `edit_chapter` 后不强制要求立即以 `append` 收尾，理论上可能"一直 edit 不提交"，但 `WRITING_AGENT_MAX_TURNS=24` 硬顶兜底，不会无限空转，只是可能白耗轮次。

### 2.5 跨章连贯性记忆 —— 机制健全，核心卖点

- 非从零生成：`chapter-memory.mjs` 提供最近 2 章（`MAX_CONTEXT_CHAPTERS=2`）首尾摘录 + `buildRelevantFacts`（agent-engine.mjs:1177）按窗口检索式注入 continuity 事实/角色/时间线。
- 属于轻量记忆检索机制，区别于纯粹靠对话上下文堆砌的工具，但检索窗口较小（近 5 章、≤40 条 facts），长篇多线索一致性仍依赖 fact 抽取质量本身，不是万能保证。

## 3. Provider 兼容层已知债务核实

### 3.1 v4-flash L3 缓存 —— 已解决（commit 515ffda）

`provider-adapters.mjs` 的 `resolveModelCapabilities` 已把 v4-flash 与 `supportsThinking` 一并从 `supportsTemperature/supportsTopP` 中排除，`model-client.mjs` 的 L3 缓存判据同步。这是**有意为之的正确降级**（不是缓存失效的 bug），而非需要"放开"的债务。

### 3.2 DeepSeek 兼容线仍在收敛中 —— 需要用户注意

最近 15 条 commit 里，涉及 `provider-adapters`/`agent-engine` 的有 7 条连续修复（45bdb21→c86fde6→37d0861→7fddde5→fdafd82→515ffda→bbc7fd2），集中在"并行 tool_calls 处理""thinking 模型温度参数""tool_choice 策略"这一条链路上反复调整。属于"边修边发现新分支"模式，说明该子系统还没有完全稳定收敛。

**用户可感知影响**：主要使用 DeepSeek 系列思考型模型（v4-pro / reasoner）写作时，中途报错概率略高于非思考型模型，不代表整体不可用。

### 3.3 供应商适配覆盖面 —— 仍是限制点

目前只有 `OpenAICompatibleAdapter` 一套通用逻辑，capability 净化（thinking/temperature/tool_choice 特殊处理）**仅对 DeepSeek 有专属分支**。MiMo 仅在缓存折扣提示里识别，未接入 capability 矩阵；未见 Kimi/GLM/Qwen 等其他供应商的专属判据。

**影响**：所有非 DeepSeek 供应商默认"全能力开放"。若未来接入的供应商也有 thinking/推理模型的参数限制，同样的坑不会被提前排掉，需要出问题后手动补分支——这是一种"被动发现"式的债务积累模式，不是自动检测。

### 3.4 测试覆盖 —— 未发现明显遗漏

`agent-engine`/`writing-agent-session`/`tool-runtime` 相关测试文件未发现 `.skip`/`xdescribe`/`xit` 或实质性 TODO/FIXME 标记。当前 `npm test` 1029 个测试，1028 通过、1 个偶发失败（`failure-resolve-flow.test.mjs` 单独运行时通过，判定为并发测试间的资源竞争抖动，非本次评估相关的真实回归）。

## 4. 风险分级汇总

| 优先级 | 问题 | 类型 | 用户可感知影响 |
|---|---|---|---|
| P1 | 字数硬门禁可能导致注水 | 待补硬化 | 高字数目标下正文啰嗦、重复 |
| P1 | DeepSeek 思考模型兼容线仍在收敛 | 子系统未稳定 | 偶发写作中途报错，需重试 |
| P2 | 工具执行异常不计入失败计数 | 待补硬化 | 罕见情况下空转到 24 轮才报错，而非提早失败 |
| P2 | 非 DeepSeek 供应商无 capability 特殊处理 | 覆盖面限制 | 换用有推理限制的新供应商时可能重蹈同类坑 |
| P3 | fact-check 进展检测未硬化 | 已知限制（非 bug） | 多花时间/token，不影响正确性 |
| P3 | session.abort() 未接线 | 技术债 | 无（真实停止走另一条通道，功能不受影响） |

## 5. 关联文档

- 计划文档：[docs/superpowers/plans/2026-08-01-standardized-output-and-agent-stability.md](../superpowers/plans/2026-08-01-standardized-output-and-agent-stability.md)（已落地：structured-output 契约层 + agent-transcript 多轮恢复）
- ADR-0001：[docs/superpowers/adr/0001-fact-check-feedback-loop.md](../superpowers/adr/0001-fact-check-feedback-loop.md)
- 后续优化思路见：[docs/research/2026-08-02-mainstream-agent-patterns-and-optimization.md](2026-08-02-mainstream-agent-patterns-and-optimization.md)
