# GitHub 开源长篇小说 / AI 写作竞品调研

- 调研日期：2026-07-21
- 范围：GitHub 上可公开访问、与“AI 小说、长篇叙事、故事圣经、角色一致性、RAG / 本地优先”直接相关的仓库；另选两款非 AI 叙事写作器作为基础体验标尺。
- 方法：逐个读取仓库 README，并抽查其仓库元数据与可下载 Release 链接。下文的“功能证据”均链接至仓库的一手 README 或 Releases；它们是维护者声明，**不等同于我已独立运行验证**。截至调研日，项目活跃度与可用性可能变化。

## 结论先行

WWriting 已经具备一个很少见、而且真正面向长篇生产的组合：**本地项目文件 + 逐章状态机 + 正文字数门禁 + checkpoint 恢复 + 调用成本/日志 + 可审计工具调用 + 默认禁网**。多数竞品擅长“生成、世界观、RAG 或编辑器”中的一两项；少数把一致性做成状态回写与门禁。WWriting 的差异化不该是“又一个能写小说的聊天框”，而应是：

> 面向个人作者的、可恢复、可核查、可控制成本的本地小说生产系统。

最直接的竞争压力来自 Vela（本地优先 + RAG + 完整编辑工作流）、天命（事实快照/变更声明/门禁）和 AI 小说作家（角色—蓝图引用、审稿、导入参考书）。它们说明用户已经会期待：可视化故事圣经、明确的一致性报告、可检索记忆和成熟的章节编辑体验。

## WWriting 的现有基线（用于比较）

本项目 README 说明：项目数据与章节正文落在本地目录；生成遵循“规划—起草—审稿—修订—定稿—摘要”状态机；字数由本地统计并作为门禁；有 checkpoint、运行日志、成本/缓存报告、受控检索抓取、OpenAI-compatible 适配和只读审查器。[项目 README](../../README.md)

这意味着以下建议优先增强可见性、编辑与一致性闭环，避免破坏已有的确定性与本地优先原则。

## 竞品清单与可核查证据

| 项目（类别） | 一手功能证据 | 可借鉴点 | 不宜直接照搬到 WWriting |
| --- | --- | --- | --- |
| [Vela](https://github.com/heider-x/vela)（本地优先 AI 写作 IDE） | README 明确列出本地 RAG、SQLite/轻量向量引擎、角色跨章节状态、自动大纲、起草、重写、审阅和 `Rewrite → Refine → Review` 管线；也列出 OpenAI/DeepSeek/Gemini/Claude/Ollama 等 BYOK 适配与 [Releases](https://github.com/heider-x/vela/releases)。[README：功能与本地 RAG](https://github.com/heider-x/vela#-核心特性--key-features) | 做“记忆来源卡”：本章 prompt 实际召回了哪些设定、章节和原因；将 WWriting 现有 sources/memory 变成可检索且可检查的工作面。 | 不应为了“AI IDE”外观把核心状态机改成自由编辑器驱动；不应把向量检索当成事实真相，仍须经过现有审查/门禁。 |
| [天命 / Tianming](https://github.com/zy-zmc/tianming-novel-ai-writer)（千章一致性） | README 把“结构化事实快照、章节变更声明、引用校验、一致性校验、向量召回”写为核心机制，且描述角色位置、外貌、秘密、时间线等字段；提供 [Releases](https://github.com/zy-zmc/tianming-novel-ai-writer/releases)。[README：校验与事实状态](https://github.com/zy-zmc/tianming-novel-ai-writer#-核心机制) | 将 WWriting 的章节摘要扩为受版本控制的“事实变更集”：人物位置/关系、时间、道具、秘密、伏笔等；把“通过/失败”关联到具体冲突与可修复动作。 | 不建议一开始复制 15+ 维固定 schema；不同题材的状态复杂度不同，字段过重会让作者维护负担超过收益。 |
| [AI 小说作家](https://github.com/EthanYoQ/AI-Novel-Writer)（本地桌面生产线） | README 描述“前提→角色→世界观→蓝图→草稿→审稿→修稿→定稿”，角色/世界观/蓝图互相引用、改设定标红、结构化审稿、向量检索或 SQLite FTS；有 Windows [v0.2.0 Release](https://github.com/EthanYoQ/AI-Novel-Writer/releases/tag/v0.2.0)。[README：能力表](https://github.com/EthanYoQ/AI-Novel-Writer#-核心能力) | 添加“设定变更影响面”：编辑某角色、地点或规则时，直接列出受影响蓝图/章节，并可创建复核任务。 | 其 README 主打“无审查/仿写”；WWriting 不应把规避模型政策或对受版权保护作品的风格复制作为产品卖点。 |
| [马良 AI 写作](https://github.com/Deng-m1/MaliangAINovalWriter)（在线富编辑器/平台） | README 宣称四级 `作品→卷→章节→场景`、富文本连续滚动、设定关系网络、设定快照、AI 剧情分支、调用日志和成本统计；支持私有 key 与多个模型。[README：主要功能](https://github.com/Deng-m1/MaliangAINovalWriter#-主要功能) | 借鉴“卷—章—场景”的作者导航、设定历史对比、每次调用的可理解成本面板；这些与 WWriting 现有日志能力天然匹配。 | 不要引入其面向平台运营的 RBAC、公共模型池、积分/用户后台；WWriting 的核心是个人本地工具，不是 SaaS。 |
| [NovelClaw](https://github.com/iLearn-Lab/NovelClaw)（可观察的长篇工作台） | README 将持续会话、运行检查、章节产物、故事板、世界/角色面板和可编辑 memory bank 作为主工作面；可在任务页查看 `worker.log`、`progress.log`、章节与下载产物。[README：工作流与运行检查](https://github.com/iLearn-Lab/NovelClaw#workflow-) | 将 WWriting 已有 `run_log.jsonl`、checkpoint、审查结果做成“本次生成的证据时间线”，让作者无需读 JSON 就能判断 AI 做了什么。 | 不必复制其多服务/多端口/会话式 Web 架构；这会牺牲 Electron 本地桌面端的部署简单性。 |
| [Kimi Writer](https://github.com/Doriandarko/kimi-writer)（自主写作 agent） | README 将 agent 的“规划—写作—审阅—继续直到完成”过程、逐字符内容流、工具调用进度及章节文件作为功能列出。[README：Features](https://github.com/Doriandarko/kimi-writer#features) | 采用更好的“正在做什么”语言：规划、起草、审稿、补写、落盘分别有进度与可中止点；增强用户对长跑任务的信任。 | 不要使用“直到完成”的黑箱自治承诺；WWriting 应保留预算、调用次数、字数门禁和用户确认。 |
| [NovelClaw 的前置方式之外：AI-Practical-Lab/novel-writer](https://github.com/AI-Practical-Lab/novel-writer)（Skill 化流程） | README 公开了从创意到合稿的步骤、YAML 角色卡/关系图、章节后角色检查、章节验证脚本以及 `final.md`/`final.docx` 输出结构。[README：功能与目录](https://github.com/AI-Practical-Lab/novel-writer#功能特点) | 把 WWriting 的技能 manifest 进一步产品化：每项技能声明输入/输出/会写哪些文件/验收条件，允许作者在项目内启用。 | 不把整个创作体验退化成命令式 skill 集；普通作者仍需要 GUI 引导、预览与一键恢复。 |
| [Jieice/ai-novel-writer](https://github.com/Jieice/ai-novel-writer)（网文工作流） | README 给出“建项目→学习风格→写章节→同步→发布”流程，包含大纲、人物、风格指南和 TXT 发布导出。[README：工作流与技能](https://github.com/Jieice/ai-novel-writer#技能说明) | 提供明确导出目标（TXT/Markdown/Word）与导出前检查清单；把写作完成感从“文件在目录里”升级为“可以交稿”。 | 不应把“降重/规避 AI 检测”当产品承诺；质量、真实性和作者控制比检测博弈更可持续。 |
| [BlinkDL/AI-Writer](https://github.com/BlinkDL/AI-Writer)（本地小说生成模型） | README 说明 RWKV 中文网文模型、CPU/GPU 本地运行、网页界面，并明确模型仅根据有限上下文续写；也提供模型 Release 链接。[README](https://github.com/BlinkDL/AI-Writer#ai-writer) | 保持对模型限制的诚实说明；为本地模型增加“上下文窗口/预估能力/降级策略”提示，避免作者误以为模型天然记住全书。 | 不要将旧式“末尾 N 字续写”作为长篇记忆方案；WWriting 已有状态、摘要和审查，必须继续以结构化上下文为中心。 |
| [Paddle-AI-Writer](https://github.com/JunnYu/Paddle-AI-Writer)（中文本地模型替代） | 该仓库在 GitHub 描述中声明使用改造 GPT/Paddle 进行网文小说生成，是 BlinkDL 项目的本地运行替代路线。[仓库与源码](https://github.com/JunnYu/Paddle-AI-Writer) | 将模型层与写作编排层保持解耦：未来可扩展本地模型，但不让模型供应商决定项目文件与验证逻辑。 | 不要自行维护/分发大模型权重作为主交付；它会显著增加下载、硬件兼容、版权与支持成本。 |
| [Novel Studio](https://github.com/ldblckrs-258/novel-studio)（浏览器本地优先） | README 明确“数据在浏览器 IndexedDB、无账号/无服务端存储”，并列出备份加密、跨设备同步、章节/小说/角色三段分析及“上下文→方向→大纲→写作→审阅→重写”六步管线，另支持 WebGPU 本地推理。[README：Features](https://github.com/ldblckrs-258/novel-studio#features) | 研究“本地备份/恢复/迁移”的可见反馈；WWriting 可将项目目录备份做成定期快照及恢复演练。 | 不要把文件型项目换成 IndexedDB 单一存储；作者需要可被版本控制、可迁移、可在文件系统检查的 Markdown/TXT 资产。 |
| [Quoll Writer](https://github.com/garybentley/quollwriter)（传统桌面长篇写作） | 源码 README 描述项目树：Book、Chapter、Scene、OutlineItem、Character、ResearchItem 等对象，并且目录/类名可在源码中交叉检查。[README：项目对象结构](https://github.com/garybentley/quollwriter#overview) | 在不强迫作者使用 AI 的情况下，完善章节、场景、人物、研究资料之间的清晰信息架构；AI 只是其中一个工作区。 | 不必复刻成熟传统编辑器的全部对象与格式设置；优先实现能驱动一致性、生成与审查的最小实体集。 |
| [bibisco Community](https://github.com/andreafeccomandi/bibisco)（传统故事圣经） | README 说明可组织章节/场景、管理修订、导出 PDF/DOCX/TXT，并建模 premise、fabula、叙事线和地理/时间/社会设定，且强调深入角色资料。[README](https://github.com/andreafeccomandi/bibisco#what-is-bibisco) | 把“故事圣经”做得作者可读、可手动维护：尤其时间线、叙事线、人物动机，而不是只有供模型检索的隐性 JSON。 | 不要把 WWriting 变成先填完百科全书才能写第一章的工具；应支持渐进补全与按需门禁。 |
| [novelWriter](https://github.com/vkbo/novelWriter)（纯文本小说编辑器） | README 明确为由多个小文本文件组成的小说编辑器，使用类 Markdown 写作格式、评论/梗概/交叉引用元数据，并强调人类可读的文件与版本控制/同步适配；仓库提供 [Release](https://github.com/vkbo/novelWriter/releases)。[README](https://github.com/vkbo/novelWriter/blob/main/README.md#novelwriter) | 保持项目资产可读、可迁移、Git 友好；让章节、笔记、索引以轻量统一元数据串联。 | 不能退化成纯文本工具；WWriting 的 AI 协作、可恢复任务、配置复用仍是核心，且 GPL-3.0 代码不可直接混用。 |
| [Manuskript](https://github.com/olivierkes/manuskript)（传统长篇规划器） | README 列出 premise 逐级扩展、角色/情节/世界管理、索引卡、章节场景重排、故事线、模板、自动保存开放文本格式，以及 HTML/ePub/ODT/DOCX 导入导出。[README：Features](https://github.com/olivierkes/manuskript/blob/develop/README.md#features) | 用“一句话 premise → 大纲 → 场景卡”的渐进向导降低新书启动门槛，并补强出版导出。 | 避免菜单式堆叠功能；它没有可验证 AI 记忆/事实闭环，不能解决 WWriting 面向的长篇自动化一致性问题，且 GPL-3.0 不可直接复用。 |

## 跨项目模式：市场在解决什么

| 用户的真实痛点 | 竞品的典型回答 | WWriting 的机会 |
| --- | --- | --- |
| 长篇会遗忘、人物会跑偏 | Vela 的本地 RAG；天命的事实快照/变更声明；AI 小说作家的互锁蓝图 | 不只“检索相关文本”，而是显示“本章可修改的事实、引用证据、冲突原因、修复后会更新什么”。 |
| 作者不信任黑箱生成 | NovelClaw 的运行日志和产物面；Kimi Writer 的进度 | 把现有 run log、checkpoint、真实字数、成本、门禁失败统一成一张作者看得懂的任务收据。 |
| 写作/审稿/修稿断裂 | Vela 的三段后处理；AI 小说作家的审稿报告 | 把状态机变为可见、可回退、可比较的版本流程；审稿结论必须链接回具体文本和事实。 |
| 本地资料和 key 不敢交给云端 | Vela、Novel Studio、AI 小说作家 | 强化 WWriting 的“项目在本地、联网默认关闭、云端调用显式可见”的产品表达，并提供备份/迁移。 |
| 从设定到交稿缺少结构 | 马良的卷/章/场景；bibisco/Quoll 的故事对象；Jieice 的发布流程 | 用轻量故事圣经和导出前质量清单补齐前后两端，避免扩大为平台后台。 |

## 建议路线（按优先级）

### P0：把已有竞争力变成作者看得到的证据

1. **生成收据 / 任务时间线**：每一章聚合阶段、模型、耗时、真实字数、成本、读取了哪些上下文、门禁结果、文件落盘路径和 checkpoint。来源是已有 `run_log.jsonl`、成本报告和状态机，不必另造一套执行系统。
2. **门禁失败可操作化**：把“字数不足/审稿冲突/模型失败”展示为带证据的故障卡，并提供“补写多少、接受例外、回到蓝图、换模型、从 checkpoint 恢复”等明确动作。
3. **本地配置可确认**：继续落实 API key 和模型配置的完整可见、持久、跨项目复用体验；这正是个人本地工具与 SaaS 平台的差异。

### P1：做“可解释的一致性”，不是泛化 RAG

1. **事实变更集（最小 schema）**：先支持人物（状态/位置/关系）、时间、地点、道具、秘密/伏笔六类；每章提交前由模型提出变更，作者可确认，审查器再决定是否写入。
2. **引用与影响图**：章节蓝图、角色卡、世界观条目和已写章节之间保存显式引用。设定变更后列出影响章节，先标为“需要复核”而非自动改文。
3. **检索证据面板**：若引入向量检索，必须显示召回片段、来源、分数/理由及是否被本章采纳；本地全文检索作为无 embedding 的可用降级。

### P2：补齐作者工作台而非堆功能

1. 卷—章—场景导航与故事板，保持 Markdown/TXT 作为事实源。
2. 可读的故事圣经（角色、地点、规则、时间线、伏笔），允许边写边生长。
3. 导出前检查（未解决冲突、缺失摘要、未通过审稿、章节顺序）以及 DOCX/PDF/TXT/Markdown 导出。

## 验收指标（避免“功能看起来很多”）

- 作者可在 30 秒内回答：本章为何使用这些上下文、花了多少成本、是否已安全落盘、从哪里恢复。
- 修改一个角色规则后，系统能列出全部受影响蓝图/章节，并且**不自动篡改正文**。
- 在关闭联网、未配置 embedding 的机器上，仍能完成新建项目、章节写作、审查、恢复和全文检索。
- 每个审稿/一致性告警都能链接至“冲突的事实 + 正文片段 + 可执行修复动作”，而不只是给一个分数。
- 20 章中断后恢复的长跑，状态、字数、成本、事实快照和章节文件相互一致。

## 调研限制与后续核验

本报告侧重公开仓库的一手自述，未运行第三方代码、未评估许可证兼容性、未做安全审计，也未验证其声明的千章/百万字效果。若进入具体功能选型，下一步应挑选 Vela、天命、AI 小说作家三个方向，各自完成一次本地安装、离线模式、导入/检索、单章生成、故障恢复和数据导出的可重复体验测试，再决定是否借鉴实现细节。
