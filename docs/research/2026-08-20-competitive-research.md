# Competitive Research: Agent 过程可见性——过程叙述层（Progress Narration）

- 日期：2026-08-20；模式：**Rapid**（单一特性决策，3 家直接竞品 + 1 家邻近 + 1 条设计基线）
- 决策问题：WWriting 第十二轮「过程可见性」中，作者提出的「过程性的总结语言」（行业术语：**progress updates / 过程叙述**，设计学根名词 visibility of system status [E8]）应当怎么做——模型生成还是结构合成、什么粒度、上下文成本边界在哪。
- 证据边界：本网络环境下 Google/DuckDuckGo 反爬拦截、Bing CN 返回无关结果，检索路径仅限一手文档直取；Codex 官方站经 Web Archive 快照核对；纯案头调研，未做产品实测。术语深潜见配套笔记 [[2026-08-20-agent-progress-narration-terminology]]。

## Executive Conclusion

WWriting 缺的不是叙述管道，是** elicitation（引导模型开口）**：`assistant_message_delta` 全链路（runtime 每轮独立 writer -> 前端实时流式气泡）已经存在 [E6]，但系统提示词只要求「最终简洁说明」且明文抑制空谈 [E5]，导致模型整个 Run 沉默干活。市场分两派：Claude 系把模型每轮自述定义为官方 "progress updates" 一等通道 [E1]，配合逐 token 流式 [E2]；Codex 用内联计划 + 动作转写（transcript）的结构化层**替代**叙述层 [E3]，规避了叙述文本的上下文成本。Manus 的 todo.md 则根本不是 UI 进度，是给模型自己看的注意力机制 [E4]。

**楔子（wedge）**：WWriting 拥有一个竞品没有的起点——叙述通道零架构成本即可点亮，最小改动是提示词层一句话（P0）；而上下文成本约束（叙述文本进 provider history 并参与压缩，reasoning 则被排除 [E7]）决定了叙述应取里程碑粒度而非逐调用粒度，剩余的过程语言用零 token 的合成状态行补（P2）。

## Current Product Baseline

均为源码核对过的 shipped 事实（非计划、非宣称）：

| 层 | 现状 | 证据 |
|---|---|---|
| 计划层（CONTEXT.md「任务计划」） | `update_plan` 工具 + 顶栏 N/M chip，已上线 | [E5] |
| 事实层（CONTEXT.md「活动记录」） | 工作组条目：工具调用状态/标签/输出流，实时 | [E6] |
| 叙述层 | **渠道全通、elicitation 缺失**：每轮 `assistantWriter` 发 `assistant_message_delta`，前端实时累积成流式气泡；但提示词无任何过程叙述指示 | [E5] [E6] |

成本约束：assistant 正文进入 provider history 并参与压缩摘要，与 reasoning「绝不写入 provider history」形成对照 [E7]——每轮叙述 = 每轮上下文增长，且本产品有自动压缩子系统，成本是持续的。

## Competitor Comparison

| Competitor | Category | Evidence | Lesson | Do Not Copy |
|---|---|---|---|---|
| Claude Code / Claude Agent SDK | direct | [E1] [E2] | 叙述是模型原生行为：文档把「handle `AssistantMessage` to see what Claude is doing each turn」定义为 progress updates；partial streaming 专为「show progress during multi-step agent tasks」设计 | 无显式粒度契约——不要照搬成逐工具调用强制叙述（噪音 + 上下文成本） |
| OpenAI Codex | direct | [E3] | 结构化替代路线：内联计划（改前解释、可批准/拒绝）+ 恒时动作转写；省掉叙述的 token 成本 | 放弃叙述层即失去「为什么这么做」的语义解释，对写作场景（作者要理解 Agent 的取舍）代价更高 |
| Manus | adjacent | [E4] | todo.md 是「deliberate mechanism to manipulate attention」，把目标复诵进上下文末端防跑偏——上下文工程，非 UI 进度 | 把给模型看的机制误当给用户看的进度 |
| Cursor | direct | [E9] | agent overview 文档不承诺任何进度显示形态（负向证据：这层没有行业统一范式） | — |
| NN/g 十大启发式 | baseline | [E8] | 「The design should always keep users informed about what is going on」——本需求的正式设计学定义 | — |

## Cross-Market Patterns

- **Table stakes**：计划层 + 工具调用事实层。三家直接竞品均具备；WWriting 已具备，不构成差异化。
- **可识别的差异化**：模型原生叙述（Claude 系独有且是模型行为不是 UI 功能）；结构化转写 + 内联计划审批（Codex）。WWriting 的差异化位置：叙述渠道已在但从未点亮——同价位产品中没有「一句话提示词改动即获得叙述层」的先例可抄，也无需抄。
- **无人解决的缺口**：叙述的粒度/保留/成本没有一家做成可配置 UX；Codex 干脆绕开。WWriting 有压缩子系统，反而最有动机把「里程碑粒度 + 廉价合成层」做成明确规格。
- **压力测试**：更强的竞手（Anthropic）为什么没把这个位置做没？因为对他们而言叙述是模型默认行为，不构成产品决策；对 WWriting 而言它是被提示词显式抑制掉的 [E5]，点亮即是可观察的差异（作者从「看条目机械跳动」变为「听 Agent 说为什么」）。
- **非目标（non-goal）**：① 不做 Codex 式全量 transcript UI 对等；② 不暴露私有推理（CONTEXT.md 词汇表红线：任务计划/活动记录均不含私有推理过程）；③ 不做逐工具调用粒度的模型叙述。

## Prioritized Roadmap

以下为证据支撑的候选路线，进入 grilling/spec 前待作者确认（前一轮已提出三个待答问题：模型话 vs 合成行、粒度、排版）。

### P0

提示词层引入**里程碑级**过程叙述 elicitation：在 `prompt.mjs` 增加「计划步骤推进时用一两句话说明正在做什么与为什么」类指示，复用既有 `assistant_message_delta` 通道，零架构改动 [E1] [E5] [E6]。
**验收信号**：sim（或真实）Run 的 journal 事件序中断言——至少一个 `tool_call_completed` 之前存在非空 `assistant_message_completed`，且前端零改动时会话流渲染出与工作组条目交错的叙述气泡。

### P1

定叙述显示政策并做 UI 接线/视觉验收：粒度锚定里程碑（对照 [E8] 的及时反馈要求与 [E7] 的上下文成本，避免逐调用）；叙述气泡与工作组条目按事件 seq 交错；Run 结束后叙述的保留/收起形态明确 [E2] [E6]。
**验收信号**：规格文档写明粒度与保留规则；Run 进行中叙述气泡与工作组条目按事件时间交错渲染，视觉验收截图通过（沿用第十轮视觉验收惯例）。

### P2

零 token 合成状态行增强：从结构化事件派生更丰富的过程语言（含重试可见性「重试 n/m」，接 chat-logic-optimization-plan §4.3），不经过模型、不产生 provider history 增量 [E3] [E7]。
**验收信号**：重试进行中 UI 出现「重试 n/m」状态行，且该行纯前端事件合成（journal 无新事件类型、无上下文增长）。

## Research Limits and Next Validation

- **搜索边界**：Google/DuckDuckGo 反爬、Bing CN 无关结果，全部证据来自一手文档直取，无搜索发现路径；竞品清单可能遗漏（如 Devin、GitHub Copilot agent mode 未覆盖）。
- **Codex 证据经 Web Archive 核对**：live 站点在本网络重定向异常，置信 medium；快照为 2025 年内版本，非当前实时页面。
- **旧版 Agent SDK「interim/agentic messages」术语页**迁移后 404，未能再验证，未纳入对比（agent-loop 页 "progress updates" 为准 [E1]）。
- **Cursor** 仅核对 agent overview 一页，不排除其他文档页有进度形态描述。
- **纯案头调研**：本报告不含任何安装、实测、基准或生产验证；P1 显示政策定稿前建议对 Claude Code 与 Codex CLI 各做一次 hands-on 观察（叙述粒度、停留时长、收起行为），作为规格的直接输入。
- **下一验证**：P0 验收信号（sim delivery 断言）即是第一个可执行验证点。
