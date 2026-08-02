# 主流 Agent 设计思路对照与 WWriting 优化方向

- 日期：2026-08-02
- 参考对象：`C:\Users\32694\Desktop\claudecode2.1.88`（Claude Code 2.1.88，`@anthropic-ai/claude-code` 官方包）——业界主流 agent 产品的公开可验证设计
- 说明：该包的 `cli.js` 是 13MB 压缩后的产物代码，不适合逐行代码复用；本文档提炼的是它对外暴露的**工具接口契约**（`sdk-tools.d.ts`，2719 行，含 `TodoWriteInput/Output`、`AgentInput/Output`、`AskUserQuestionInput`、`ExitPlanModeInput`、`TaskStopInput` 等结构化定义）和公开文档中的架构模式，作为"主流 agent 怎么做可交互、可中断、状态透明"的设计参照，不是照抄实现
- 目标：把这些经过大规模验证的模式，映射到 [2026-08-02-writing-agent-stability-assessment.md](2026-08-02-writing-agent-stability-assessment.md) 里identified 的具体瑕疵上

## 1. 任务可见性：TodoWrite 三态模型 → 写作进度对用户可见

**Claude Code 的做法**：`TodoWriteInput`（sdk-tools.d.ts:523-529）强制每个任务是 `pending | in_progress | completed` 三态之一，且要求"当前只能有一个 in_progress"。这不是给 Claude 自己看的内部状态，是**直接渲染给用户**的任务清单，用户在任务执行的任何时刻打开界面都能看到"现在在做第几步、还剩几步"。

**WWriting 现状**：写作循环的进度（第几段、第几轮 fact-check、24 轮硬顶还剩几轮）目前分散在 activity-strip 的"阶段/位置/动作"文字里（本轮 UI 优化已加），但没有一个**任务级**的清单视图——用户看到的是"正在动作 X"，看不到"这一章总共要过几道关、现在走到哪一道"。

**优化方向**：写作循环内部已经是清晰的阶段机（queued→planning→drafting→reviewing→finalizing→summarizing）+ 子循环（segment 段数、fact-check 轮数）。把这个既有状态机映射成一个用户可读的三态任务清单（"第 3 段：进行中"、"事实核对第 1/3 轮：等待"、"字数达标：完成"），比现在的单行文字状态更符合用户对"agent 在干什么"的直觉预期。这是纯前端渲染层改造，后端阶段机不用动。

## 2. 中断与恢复：显式停止信号 + 断点续跑

**Claude Code 的做法**：`TaskStopInput`/`TaskStopOutput` 是独立的工具契约，"停止一个任务"是一等公民操作，不是"关掉进程"这种粗暴手段；配合 `AgentOutput` 里的 `status: "async_launched"` + `outputFile`，长任务可以异步跑、随时查看进度、随时显式停止，停止后台任务不等于丢失已完成的工作。

**WWriting 现状**（对照评估报告 §1.1、§1.3）：已经有类似的骨架——`job.controller.abort()` → `runProject(signal)` 是"停止"的主路径，pending transcript 文件在中断时不清理，24 轮耗尽也保留半成品供恢复。**这部分设计思路已经和主流 agent 一致**，缺的是两点：

1. `WritingAgentSession.abort()` 这条内部信号线预留了但没接到任何生产调用点，等于有两套停止机制但只有一套真正被用户触发。应该收敛成一条：`app-server` 的 controller.abort() 应该是唯一入口，`WritingAgentSession` 内部要么直接消费同一个 AbortSignal（用 `AbortSignal.any` 组合，计划文档里已经提到这个思路但标为"未来债务"），要么删掉这条不会被触发的死代码，二选一，不要留着两条平行但只有一条通电的线。
2. 停止之后，用户看到的应该是"已停止，第 3 段写到一半，可以继续"，而不是单纯的"idle"。这和本轮 UI 优化里"停止状态要一眼看出来"的要求是同一件事的延伸——不只是视觉上区分 idle/running，还要在停止态下告诉用户"停在哪一步，能不能续"。

## 3. 结构化输出契约：schema 校验优先于自由文本解析

**Claude Do 的做法**：所有工具输入输出都是 JSON Schema 定义（`sdk-tools.d.ts` 全文件），模型的每一次工具调用天生走结构化通道，不存在"模型输出一段文本，程序猜它是不是在描述一次工具调用"的模糊地带。

**WWriting 现状**：写作路径（`agent-engine.mjs` 的 `dispatchSingleToolCall`）已经用原生 `tool_calls` 结构化调用，且已经落地了 `structured-output.mjs` 契约层（memory/fact-check 走版本化 schema + 可分类错误码，2026-08-01 计划已完成）。**这一条已经对齐主流做法**，是这几轮迭代里最扎实的部分。

**仍有缺口**（对照评估报告 §2.3）：字数门禁校验目前是布尔判断（达标/不达标），没有 schema 化的"质量维度"概念。可以借鉴同样的 schema 思路，把"字数达标"拆成结构化的 `{word_count, target, status: "under"|"met"|"padding_risk"}`，让重写指令里天然带有"不要靠重复注水凑数"的显式约束，而不是现在的"继续写"这种自由文本提示——这是评估报告里 P1 优先级问题的具体落地方式，不是另起一套机制。

## 4. 用户可交互：显式提问而非静默假设

**Claude Code 的做法**：`AskUserQuestionInput` 是独立工具，遇到"这里有歧义、我不该自己拍板"的分支时，会主动暂停执行、结构化地列出选项，等用户选择后再继续，而不是自己猜一个答案往下走。`ExitPlanModeInput` 则是另一种交互闸门：复杂任务先出计划，用户确认后才真正动手。

**WWriting 现状**：写作循环内部的分支决策（fact-check 冲突怎么改、字数不够怎么补）全部是模型自主决定+自动重试，用户在循环跑完之前看不到、也插不上手。这是"自动驾驶"和"主流 agent 强调的人在回路"之间的一个真实差距，但**不建议照搬**——小说写作和写代码不一样，用户通常不想在每一段里被打断问"这句要不要改"，那样反而破坏创作体验。

**折中方向**：只在真正高风险的分支引入确认闸门，不要全面搬"每个决策都问用户"：
- fact-check 3 轮打满仍冲突 → block 并展示冲突详情（评估报告确认已经这么做，机制健全，不用改）
- 24 轮耗尽、工具连续异常这类"agent 自己都不确定还能不能继续"的情况 → 应该像 `AskUserQuestion` 一样给用户一个明确的选择而不是只有"重试"一个按钮：继续重试 / 跳过本段人工写 / 降低本段字数目标，这是可以直接加的交互点，且和现有故障卡片机制（failure-card.js）天然契合，改动量小。

## 5. 权限分级：默认最小权限，逐级放权

**Claude Code 的做法**：工具调用默认受权限系统约束（只读优先），敏感操作（写文件、执行命令）需要显式授权或用户确认，这是整个产品能让用户"敢用"的信任基础。

**WWriting 现状**：已经有 4 级权限模型（只读/确认后修改/自动修改/YOLO，`permission-tiers.mjs`），这套设计**已经对齐主流思路**，本轮 UI 优化也把它的文案做了清理。真正的缺口不在权限分级本身，而在评估报告 §3.3 提到的：这套权限校验目前只覆盖工具白名单，还没有按"供应商能力"再加一层——比如某供应商的模型不支持某个工具的调用方式，目前是靠 DeepSeek 专属分支硬编码识别，不是通用的能力探测机制。这个可以留到后续供应商适配债务一起处理，不是本轮紧急项。

## 6. 小结：哪些已经对齐、哪些是真缺口

| 主流模式 | WWriting 现状 | 结论 |
|---|---|---|
| 结构化工具调用 + schema 校验 | 已落地（structured-output.mjs + 原生 tool_calls） | 对齐，继续保持 |
| 断点恢复 / 半成品不丢 | 已落地（pending transcript + checkpoint） | 对齐，继续保持 |
| 权限分级 | 已落地（4 级 tier） | 对齐，继续保持 |
| 任务清单可见性 | 有阶段机但无用户可读清单视图 | 真缺口，纯前端改造 |
| 显式停止信号单一入口 | 两条平行信号线，只一条通电 | 真缺口，需收敛 |
| 高风险分支用户可选择 | 24 轮耗尽/连续异常只有"重试" | 真缺口，可低成本加选项 |
| 质量校验 schema 化（字数） | 仍是布尔 gate，无结构化质量维度 | 真缺口，对应评估报告 P1 |

下一步的执行计划见：[docs/superpowers/plans/2026-08-02-agent-stability-and-usability-hardening.md](../superpowers/plans/2026-08-02-agent-stability-and-usability-hardening.md)
