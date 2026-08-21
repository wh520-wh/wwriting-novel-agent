# Agent 过程叙述（Progress Narration）术语与实现调研

- 日期：2026-08-20
- 缘起：第十二轮「过程可见性」grilling 第一个实质输入--作者想要「过程性的总结语言」，需要先定术语、再看主流 agents 怎么做、最后对照 WWriting 现状。
- 方法：Anthropic / OpenAI / Manus 一手文档逐页核对（WebFetch），术语逐条带出处；WWriting 侧读 `prompt.mjs`、`runtime.mjs`、`state.js`、`work-items.mjs` 源码核对。

## 1. 术语结论

作者说的「过程性的总结语言」，行业里有三层对应术语：

| 术语 | 出处 | 含义 |
|---|---|---|
| **Progress updates** | Anthropic Agent SDK 官方文档（agent-loop 页） | 「handle `AssistantMessage` to see what Claude is doing each turn, including which tools it called」--模型每一轮自己说的话，是官方定义的进度更新通道 |
| **Partial message streaming** | Anthropic Agent SDK（streaming 页） | `includePartialMessages`（TS）/ `include_partial_messages`（Py）开启后逐 token 流出 `SDKPartialAssistantMessage`，文档明说用于「chat interfaces that need to show progress during multi-step agent tasks」 |
| **Visibility of system status** | Nielsen 十大可用性启发式第 1 条（Norman《设计心理学》同源） | 「过程可见性」本身的设计学正式名称：系统应在合理时间内让用户持续知道正在发生什么 |

未证实的记忆项：旧版 Agent SDK 文档页（docs.claude.com/en/api/agent-sdk/messages）曾用「interim messages / agentic messages」称呼过程中产生的 assistant 消息；该页现已迁移（code.claude.com 上 404），本轮未能重新验证，**引用时以 agent-loop 页的 "progress updates" 为准**。

## 2. 主流 agents 的做法（一手核对）

- **Claude（Agent SDK / Claude Code）**：叙述层是模型自己写的文字（调用工具前「Let me check the file…」这类 preamble），经 `AssistantMessage` 逐轮流出、partial streaming 逐字流出；另有 TodoWrite 三态任务清单做计划层（本仓库 `2026-08-02-mainstream-agent-patterns-and-optimization.md` 已详述）。叙述 = 模型生成，计划/活动 = 结构化。
- **OpenAI Codex**（developers.openai.com/codex/cli/features，archive 核对）：走结构化路线，叙述色彩淡--「Watch Codex explain its plan before making a change」内联计划 + 「Codex always surfaces a transcript of its actions」动作转写。进度 = 计划 + 转写，不是模型即兴解说。
- **Manus**（manus.im 博客 Context Engineering）：todo.md 的作用被明确描述为**上下文工程机制而非 UI**--「reciting its objectives into the end of the context」「a deliberate mechanism to manipulate attention」，是给模型自己看防跑偏的，不是给用户看的进度条。博文中没有 UI 进度叙述内容。
- **对照结论**：头部产品把「过程可见」拆成**计划层**（TodoWrite / Codex plan）、**叙述层**（Claude 的 between-tool-call 文字；Codex 基本放弃这层）、**事实层**（transcript / 工具调用记录）三层。叙述层只有 Claude 系做且是模型原生行为，其余家基本用结构化层替代。

## 3. WWriting 现状对照（源码核对）

三层映射到 CONTEXT.md 既有词汇：

| 层 | CONTEXT.md 词汇 | 现状 | 缺口 |
|---|---|---|---|
| 计划层 | 任务计划 | `update_plan` + 顶栏 chip（N/M） | 已有 |
| 事实层 | 活动记录 | 工作组条目（工具调用状态/标签/输出流） | 已有 |
| **叙述层** | （无对应词） | **渠道全通，elicitation 缺失** | **本轮候选** |

关键事实（`prompt.mjs` / `runtime.mjs` / `state.js`）：

1. **叙述通道端到端已存在**：runtime 每个 Provider 轮次建独立 `assistantWriter`（`runtime.mjs:1734-1742`，事件 `assistant_message_delta`/`assistant_message_completed`，带稳定 turn id）；`state.js:304-339` 把 delta 实时累积成流式气泡、completed 定稿入 conversation。模型若在工具调用之间说话，前端**今天就能逐字显示**。
2. **提示词从不让模型在过程中开口**：`prompt.mjs:57` 只要求「最终简洁说明实际完成的内容」；`prompt.mjs:49`「能直接完成的工作使用工具完成，不只口头承诺」实际在抑制说话。结果：模型整个 Run 沉默干活，作者只能看工作组条目机械跳动，直到最后一段总结--这就是作者感到「缺过程性总结语言」的根源。
3. **叙述文本会进 provider history**：与 reasoning「绝不写入 provider history」（`runtime.mjs:1730` 附近注释）不同，assistant 正文是公开内容，进入 transcript、参与压缩摘要（`runtime.mjs:896-925` 的 `assistant_text` 字段）。**每轮叙述 = 每轮上下文增长**，长跑 + 自动压缩子系统下是持续成本。
4. 已有的**合成式叙述**：工作组条目标签（「正在读取文件 X」「已运行命令 Y」）是从结构化事件确定性生成的零成本状态语言；作者想要的「总结语言」是模型生成的语义性叙述（会说「为什么」），两者不同层。

## 4. 待 grill 的开放问题

1. 要模型自己的话（语义、会说为什么、贵、进上下文）还是更丰富的合成状态行（确定性、免费、只说事实）--还是两层各司其职？
2. 叙述粒度：每个工具调用前 / 每个计划步骤 / 每个 Provider 轮次？
3. 上下文代价：叙述文本进 provider history 且参与压缩，长跑项目的累积成本是否接受（Codex 用结构化替代叙述正是为了省这个）？
4. 与既有三层的排版关系：叙述气泡与工作组条目按时间 interleaved（现状通道即是如此），还是收进条目内部？
