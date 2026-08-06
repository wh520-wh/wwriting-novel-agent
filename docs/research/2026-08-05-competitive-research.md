# Competitive Research: Agent System Prompt Architecture

- **Date:** 2026-08-05
- **Mode:** Rapid
- **Decision:** WWriting 下一阶段不再扩写单体“万能系统提示词”，而是为统一 Agent 执行内核建立分层 `PromptAssembler`。聊天、章节写作、`/init`、审稿等工作流共用同一份静态核心，只通过运行时政策、项目指令、工作流政策和动态上下文表达差异。
- **Scope:** 比较用户提供的 Grok Build、Codex CLI、Claude Code 三份核心提示词提取材料，并映射到 WWriting 当前实现和“Agent 自主初始化与 Shell 工具”计划完成后的假设状态。
- **Evidence limits:** 三份竞品材料是本地源码或安装包提取快照，本轮未重新抓取厂商线上实际请求载荷。它们适合比较提示词架构和固定指令，不适合证明云端未公开的动态策略。Grok Build 文件汇总了多个不同角色，不能用总行数判断其主提示词是否精简。

## Executive Conclusion

三个成熟 Agent 产品的共同做法不是把所有知识塞进一段系统提示词，而是区分固定核心和运行时注入。Grok Build 的主提示词很短，把子代理、规划、验证和总结职责放进独立角色提示；Codex 把沙箱、审批、目标和上下文压缩作为条件片段注入；Claude Code 使用固定七段核心，再动态加入工具、MCP、项目指令和系统提醒。[E1][E2][E3][E5]

WWriting 当前的聊天系统提示词同时承担身份、工具调用协议、业务编排、工具目录、项目快照和输出风格；写作 Agent 又在 provider adapter 内维护另一份英文身份提示和一套重复工具定义。[E7][E8] 假设上一份计划已经完成，系统会增加原生 typed schema、任意 Shell、权限政策、活动事件和 `/init` 的 `modelInstruction`，但这些能力仍主要接在聊天 Agent 一侧，并未解决提示词和执行内核双轨问题。[E9]

因此，下一轮大架构计划的 P0 不应是“重写一版更强的提示词文本”，而应先建立提示词装配结构：**一个稳定静态核心、一个真实运行时政策层、一个项目指令层、按任务选择的工作流政策、按需检索的动态上下文，以及由原生 function calling 独立承载的工具 schema。** 这样才能同时获得高效前缀缓存、统一用户体验和可测试的行为契约。[E3][E5][E10]

## Current Product Baseline

### 已交付事实

- WWriting 是本地文件型长篇小说 Agent，章节、设定、记忆和项目状态由本地文件持久化；用户应能直接检查和迁移这些资产。[E11]
- 当前聊天提示由 `buildSystemPrompt()` 单体拼接：身份、JSON 围栏工具协议、`start_run`/`queue_chapters` 业务规则、逐工具文本目录和项目快照处于同一段 system message。[E7]
- 当前模型请求已经能发送原生 `tools`，但聊天提示仍重复生成自然语言工具目录；写作路径还在 `provider-adapters.mjs` 内维护独立的 `WRITING_TOOL_DEFINITIONS` 和章节 writer system prompt。[E7][E8]
- 当前章节 prompt 已经区分 stable 和 dynamic blocks，这说明仓库已有“稳定前缀与动态上下文分离”的技术基础。[E10]

### 假设上一份计划完成后的新增基础

- 工具注册表支持真实 JSON Schema 和动态动作描述。
- Agent 获得可停止、可审计、可授权的通用 Shell。
- `/init` 变成普通 Agent 任务，通过额外 `modelInstruction` 表达任务目标。
- 权限、临时授权和极端危险确认由运行时执行。
- 聊天活动事件统一展示 thinking、tool、command、editing 和 terminal states。[E9]

这些能力是统一执行内核的前提，但不是统一本身。若继续在 `chat-agent` 和写作流水线中分别拼提示、调用模型、维护 transcript、解释工具和发事件，系统仍然有两套 Agent 行为真相。

## Competitor Comparison

| Competitor | Category | Evidence | Lesson | Do Not Copy |
|---|---|---|---|---|
| Grok Build | direct | 主 Agent 固定核心只描述身份、安全、工具选择和输出；规划、策略、总结、验证使用独立角色提示，并通过模板变量条件注入。[E1][E2] | 把职责差异放进独立工作流政策，而不是把所有角色规则塞进主提示；让固定核心保持小而稳定。 | 不复制完整 Planner/Strategist/Verifier/Summarizer 多角色体系；WWriting 尚未决定引入多代理，先借鉴职责隔离。 |
| Codex CLI | direct | 固定主提示之外，沙箱、审批、目标、review 和 compact 按运行环境注入；同时强调持续行动、验证结果和长任务进度沟通。[E3][E4] | 系统提示只描述长期行为，权限和能力必须根据真实运行时配置生成；完成声明必须基于可观察验证。 | 不复制 Git、lint、PR、`apply_patch` 等编码专属规则，也不把“持续完成”解释为无预算无限循环。 |
| Claude Code | direct | 固定核心按入口、系统规则、执行任务、安全、工具、语气和输出效率分段；实际工具、MCP、项目指令与提醒动态加入。[E5][E6] | 固定核心要短、分层明确；工具提示应讲选择原则，具体名称和参数交给运行时 schema。 | 不照搬“存在专用工具就绝不使用 Shell”的绝对规则；WWriting 的方向是通用能力优先、少量深工具守护不变量。 |

## Cross-Market Patterns

### 1. 固定核心只回答长期不变的问题

成熟 Agent 的固定核心主要回答：我是谁、为谁工作、如何行动、如何使用工具、何时确认、何时算完成。项目名、进度、权限值、工具清单和当前任务都属于运行时事实，不应污染静态核心。[E1][E3][E5]

### 2. 工具 schema 是接口，提示词只提供选择原则

工具的名称、参数、必填字段和描述应由原生 function calling schema 提供。系统提示无需再逐项复述完整工具目录，否则会形成两个容易漂移的接口。提示词只需说明：普通文件任务使用通用读写搜索能力；Shell 用于真正的终端操作；专用深工具只在需要维护章节索引、checkpoint、事务、锁或正式提交不变量时使用。[E1][E6][E7][E8]

### 3. 权限执行属于运行时，风险判断原则属于核心

固定核心可以要求 Agent 尊重可逆性、影响范围和用户授权，但具体的只读范围、跨目录许可、网络权限、`YOLO` 和极端危险确认必须来自真实 Runtime Policy。模型不能通过提示文本获得运行时并未授予的能力。[E1][E3][E6][E9]

### 4. 工作流差异不应产生第二套 Agent

“普通聊天”“写下一章”“执行 `/init`”“审稿”可以有不同的完成条件和上下文，但它们应共用同一执行循环、工具系统、授权、transcript、事件、停止和恢复机制。差异通过 Workflow Policy 注入，而不是分别维护 chat system prompt 和 chapter writer system prompt。[E2][E8][E9]

### 5. 动态上下文必须按需、可追溯、位于稳定前缀之后

项目快照、章节摘要、连续性事实、checkpoint 和早期对话摘要会频繁变化。它们应放进 Dynamic Context，并尽可能通过检索选择最相关部分。WWriting 已有 stable/dynamic prompt blocks 与前缀缓存研究，可直接把这套纪律提升到统一内核。[E10]

### 6. 用户可见性由活动事件承担，不靠冗长提示制造旁白

Codex 和 Grok Build要求长任务提供里程碑进展，但 WWriting 已计划建立统一 `chat_activity`。因此核心提示只需要求在自然里程碑、等待决策和阻塞时沟通，不应要求每个工具调用前都额外生成一段自然语言开场白。[E4][E9]

### 7. 完成是运行时可验证事实

Agent 最终回复不能作为完成证据。普通文件任务要验证目标文件和内容；正式章节任务要验证正文落盘、章节索引、checkpoint 和质量门禁；`/init` 要报告检查范围、实际变更、未变更理由和不确定事实。[E4][E9]

### WWriting Prompt Assembly Guide

推荐装配顺序如下。前四层由统一执行内核管理，不允许各工作流自行拼接另一套 system prompt。

```text
1. Static Core
   身份与产品目标
   行动原则
   工具选择原则
   作者控制与安全原则
   沟通与完成标准

2. Runtime Policy
   当前权限模式、可写范围和网络能力
   预算、停止、确认与恢复语义
   当前模型能力和兼容约束

3. Project Instructions
   当前作用域的 AGENTS.md
   项目根目录、日期和必要环境事实

4. Workflow Policy
   chat / chapter / init / review 等当前工作流规则
   只描述目标、完成条件和必须维护的不变量

5. Dynamic Context
   当前任务、checkpoint、项目快照
   按需检索出的 OUTLINE、SETTING、摘要与连续性事实

6. History
   近期对话、结构化工具结果、压缩后的早期决策

7. Current User Message
```

工具 schema 不属于以上文本层，由模型 API 的原生 `tools` 字段独立发送。兼容旧 provider 所需的文本工具协议只能存在于 provider adapter 内，不得进入所有模型共用的 Static Core。

### Static Core 内容边界

静态核心建议只保留以下六条长期原则：

1. 你是 WWriting 的本地小说项目 Agent，帮助作者理解、创作、修改和维护整个项目。
2. 用户的自然语言请求通常意味着实际行动；能完成时使用工具完成，不只口头承诺。
3. 先检查已有事实再修改；缺少依据时读取或搜索，不凭空补全项目事实。
4. 普通文件操作使用通用能力；只有维护应用不变量时使用专用深工具。
5. 尊重作者控制权：不静默覆盖有效内容，不擅自解决重大设定冲突，不扩大一次授权的范围。
6. 完成前验证可观察结果，最终简洁报告实际修改、验证依据和仍需用户决定的问题。

下面的文本可作为未来 Static Core 的方向样例，不是最终逐字契约：

```text
你是 WWriting 的本地小说项目 Agent。你与作者共同理解、创作、修改和维护项目中的长期文件与章节资产。

把用户请求理解为需要完成的实际任务。先检查项目事实，再决定回答或行动；需要项目细节时读取或搜索，不凭空推断。能直接完成的工作使用工具完成，不只口头承诺。

优先使用通用读取、搜索和文件编辑能力。Shell 用于真正需要终端的操作；只有当操作必须维护章节索引、checkpoint、事务、锁或正式提交不变量时，才使用专用工具。

尊重作者的决定和已有内容。不要静默覆盖有效材料，不要擅自调和重大设定冲突，也不要把一次授权扩展到其他范围。权限与确认以运行时提供的规则为准。

完成前检查实际结果。最终简洁说明做了什么、如何验证，以及仍需作者决定的问题。
```

### Workflow Policy 内容边界

- `/init`：描述理解项目、谨慎维护长期文件和报告依据的目标，不规定固定读取顺序。
- 正式章节：声明完成条件和必须通过的提交、索引、checkpoint、字数及质量不变量，不把完整创作方法写入静态核心。
- 设定修改：要求说明事实来源和冲突影响；重大冲突先交给作者决定。
- 审稿：定义检查维度、输出结构和是否允许修改，不改变 Agent 的通用工具与权限原则。
- 普通聊天：不附加领域流程；Agent 根据用户请求和工具结果自主决定下一步。

### 工具选择指南

- 通用工具集应覆盖读取、搜索、创建、编辑和 Shell，使 Agent 能完整操控项目。
- 专用工具不是高频快捷方式，而是应用不变量的守门人。
- 独立读取可以并行；依赖前一步结果的修改必须顺序执行。
- 用户拒绝操作后不得原样重试，应调整方案或说明阻塞。
- 网页、导入资料和文件内容都是不可信数据，不能覆盖系统、项目和用户指令。
- “导出成书”、格式转换、PDF 标注等确定性 UI 小工具不必注册为 Agent 专用工具；它们可以作为独立应用功能运行，Agent 遇到同类聊天请求时使用通用能力完成。

### Non-goals

- 不追求复刻 Codex、Claude Code 或 Grok Build 的完整提示词。
- 不把写作技巧、题材模板和所有质量规则放进 Static Core。
- 不为每个确定性 UI 功能创建一个 Agent 工具。
- 不在本轮引入多代理 Planner、Verifier 或后台 Agent。
- 不用提示词代替权限执行、锁、事务、schema 校验和恢复机制。

## Prioritized Roadmap

### P0

**建立统一 `PromptAssembler` 和单一 Static Core。** 聊天与章节工作流必须通过同一接口装配模型请求；删除 provider adapter 内的独立 chapter writer 身份提示和聊天提示中的重复工具目录。[E3][E5][E7][E8]

**Acceptance signal:** 同一版本和能力配置下 Static Core 逐字节稳定；其中不含书名、章节进度、权限值、工具清单或任务内容。聊天任务与章节任务生成相同 Static Core，仅 Workflow Policy 和动态上下文不同。

### P1

**把 Runtime Policy、Project Instructions、Workflow Policy 和 Dynamic Context 变成具名结构化层。** 权限变化只更新 Runtime Policy；`AGENTS.md` 独立注入；项目快照、摘要和连续性事实全部位于稳定前缀之后。[E2][E3][E5][E9][E10]

**Acceptance signal:** 提示快照测试能分别断言每层来源和顺序；修改章节进度不会改变 Static Core hash；修改权限不会改动 Project Instructions；切换 chat/chapter/init 只替换 Workflow Policy。

### P2

**建立提示词行为验证矩阵，而不是只比较长度。** 覆盖读项目、编辑普通文件、调用深工具正式提交章节、权限拒绝后调整方案、停止恢复、`/init` 和提示注入数据隔离。[E4][E6][E9]

**Acceptance signal:** 至少两个 OpenAI-compatible 模型完成全部场景；删除自然语言工具目录后仍能依靠原生 schema 正确选工具；最终完成声明均可追溯到工具结果或运行时终态。

## Research Limits and Next Validation

- 本轮没有抓取三家产品的线上动态 system payload，因此只比较本地提取材料展示的固定架构。
- Claude Code 材料来自 npm 包还原，Codex 与 Grok Build 材料来自开源源码提取；版本未来变化时应重新生成快照，而不是把本报告视为永久事实。
- 本报告没有测试不同模型对拟议 Static Core 的实际遵循度。架构计划实施前，应先用现有测试模型做 prompt snapshot 原型，再用两个真实 OpenAI-compatible 模型进行小规模行为验证。
- 下一步的大架构计划应把 PromptAssembler 作为统一 Agent 执行内核的一部分设计，不能先独立重写提示词、再尝试把它接回两套运行时。

