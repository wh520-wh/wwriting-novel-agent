# 长篇小说 AI 写作领域调研:记忆、一致性、字数、工作流(2025–2026)

> 调研日期:2026-09-27。方法:WebSearch + 官方文档/论文一手抓取;Node.js 字数统计方案在本机(Node v25.2.1)实测验证。
> 用途:为 WWriting CLI(终端长篇小说写作 Agent)的记忆系统、上下文组装、count_text 与伏笔/人物跟踪提供设计依据。

---

## 核心结论(TL;DR)

1. **超长上下文 ≠ 长篇生成能力。** Lost in the Middle(2023)证明模型对上下文首尾信息利用最好;Chroma 的 Context Rot(2025)在 18 个模型上证明:保持任务难度不变、只增加输入长度,性能普遍非线性衰减,干扰信息越多衰减越快。把百万字塞进上下文是错误方向,**「检索 + 按需注入」仍是 2025–2026 的工程共识**。
2. **单次生成上限受 SFT 数据约束,约 2000 词。** LongWriter(Bai et al., 2024)证明这是对齐数据稀缺问题而非能力问题;其 AgentWrite「计划(分段+字数预算)→ 逐节执行」流水线可产出 2 万词连贯输出——这正是「按章生成、每章 2000–6000 字」网文节奏的学术依据。
3. **记忆系统的行业收敛形态是「结构化条目 + 触发注入 + token 预算」。** SillyTavern World Info / NovelAI Lorebook 用关键词触发(扫描最近 N 条消息/字符),NovelCrafter Codex 用别名自动识别 + 场景关联注入,Sudowrite Story Bible 用大纲→beats→章节流水线。关键词触发确定性最强,向量检索只宜作补充。
4. **一致性维护的工程最佳实践是「不变的 bible + 每章验证后更新的状态快照 + 时间线」。** Claude Book 框架的三个机制值得直接借鉴:bible 与 state 分离、`state/current` 符号链接指向最新快照、写手之外的独立审校代理做验证门禁。
5. **中文字数口径:网文平台计费按「含标点的字符数(不含空格)」。** count_text 主口径建议为「去空白后的字符数」,与 Word「字符数(不计空格)」、起点计费口径对齐;实现用 Node 原生 `Intl.Segmenter`(grapheme 粒度)避免 emoji/代理对误差,已本地验证。
6. **网文实际约束:单章 2000–4000 字为主流,日更 4000–6000 字,百万字量级需要分卷。** 中文 AI 产品(彩云小梦、阅文作家助手、番茄 AI 助手)均已把「大纲→细纲→正文」流程化,但「30 章后遗忘设定」的长期一致性仍是公认硬伤——这是 WWriting 的核心机会点。

---

## 一、长文本生成的学术与工程结论

### 1.1 超长上下文的实际利用:Lost in the Middle 与 Context Rot

- [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172)(Liu et al., 2023,被引 6600+):将 needle 放在 20 个不同位置测试,性能呈 **U 形曲线**——开头和结尾的信息利用最好,中段显著下降;文档越多、位置越靠中,召回越差。这是「重要内容放首尾」的实证基础。
- [Context Rot](https://www.trychroma.com/research/context-rot)(Chroma, 2025-07):对 18 个 LLM(GPT-4.1、Claude 4、Gemini 2.5、Qwen3 等)做了 8 种输入长度 × 11 个 needle 位置、共 19 万+次调用的受控实验:
  - **保持任务难度不变,仅增加输入长度,所有模型性能都下降**,且不均匀、非线性——即使最简单任务。
  - needle 与问题的**语义相似度越低,随长度增长衰减越快**;语义检索任务在长上下文中比词汇匹配更脆弱。
  - 1 个干扰句即可降低性能,4 个更糟;不同模型对干扰的反应差异大(Claude 系幻觉率最低、倾向弃答;GPT 系最易自信地答错)。
  - 反直觉发现:**打乱 haystack 顺序(破坏文本连贯性)反而提升性能**,18 个模型一致——注意力机制受输入结构影响。
  - 结论:所谓「长上下文已解决」只是 NIAH 这类简单词汇检索的假象;**上下文工程(信息的呈现方式)比信息是否存在更关键**。
- 工程含义:2024–2025 的 [RULER](https://arxiv.org/abs/2404.06654) 等基准与 [ACL 2025 的位置偏置缓解工作](https://aclanthology.org/2025.findings-acl.316.pdf)也持续确认位置偏置仍未被训练侧根治。对 WWriting:上下文组装必须控制总长度(几千到几万 token),并把「本章细纲、上一章结尾」放在最前/最后,而非把前 50 章原文堆进去。

### 1.2 单次输出长度上限与 LongWriter / AgentWrite

- [LongWriter: Unleashing 10,000+ Word Generation from Long Context LLMs](https://arxiv.org/abs/2408.07055)(Bai et al./清华, 2024):
  - 受控实验发现:现有模型无论多大上下文,**单次生成都难超约 2000 词**,根因是 SFT 对齐数据里长输出样本稀缺——是数据问题,不是能力问题。
  - **AgentWrite** 流水线:先让模型输出结构化写作计划(分段 + 每段字数预算),再逐段执行,可连贯生成 20000+ 词。
  - 配套发布 LongBench-Write 基准、LongWriter-6K 微调数据(输出 2k–32k 词)与 LongWriter-GLM(9B,经 DPO 后超过更大的专有模型)。代码:[github.com/THUDM/LongWriter](https://github.com/THUDM/LongWriter)。
- 后续:LOGIC(2025-11, ACL Anthology)把「大纲生成」单独建模、通过模仿学习改进长文大纲质量(来源:[aclanthology.org](https://aclanthology.org),具体页未逐字核对,未确认细节)。
- 工程含义:**不需要也不应该追求「一次生成一章 6000 字」的模型能力**——把章拆成场景/节拍、给每节字数预算、逐节生成再拼装,是学术验证过的正确路径,且与网文「章末留钩」的节奏天然契合。

### 1.3 早期长篇生成方法(2022–2023):三条可借鉴的骨架

| 方法 | 论文 | 核心机制 | 对 WWriting 的可借鉴点 |
| --- | --- | --- | --- |
| Re3 | [Re3: Generating Longer Stories With Recursive Reprompting and Revision](https://arxiv.org/abs/2210.06774)(Yang et al., EMNLP 2022) | 先生成设定( premises )+人物+大纲,再「递归重提示+修订」,从大纲逐段展开成 2000+ 词故事,段落间用大纲控制连贯 | 设定/大纲/正文三层分离;逐段回查大纲的「修订」步骤 |
| Dramatron | [Co-Writing Screenplays and Theatre Scripts with Language Models](https://arxiv.org/abs/2209.14958)(Mirowski et al./DeepMind, IUI 2023) | 按剧本故事语法的**层级 prompt 链**:logline→人物→剧情→场景描述→对白,每层输出作为下一层上下文;与行业编剧共同写作评估 | 「每层只吃上层产物」的层级生成链;人机各管各层的协作模式 |
| RecurrentGPT | [Interactive Generation of (Arbitrarily) Long Text](https://arxiv.org/abs/2305.13304)(Zhou et al., 2023) | 用自然语言模拟 RNN 循环:每段生成时维护「短期记忆(上一段摘要)+ 下一段计划」,每步更新 | 「短记忆+下一步计划」的滚动状态;每段重规划使人工可随时干预——与 WWriting 单轮对话面天然契合 |

### 1.4 2025–2026 新进展:多智能体与状态跟踪成为主线

综述与论文集合:[A Survey on LLMs for Story Generation](https://mariateleki.github.io/pdf/EXTENDED_A_Survey_on_LLMs_for_Story_Generation.pdf)、[Awesome-Story-Generation](https://github.com/yingpengma/Awesome-Story-Generation)。

- [StoryWriter](https://arxiv.org/abs/2506.16445)(清华团队, 2025-06):三个 agent——大纲 agent(事件级提纲)→ 规划 agent(把事件编排进各章,保证多线交织)→ 写作 agent(**动态压缩故事历史**后写作);构建了平均 8000 词、约 6000 篇的 LongStory 数据集并微调 GLM/Llama,质量显著超基线。「章节级事件编排 + 动态历史压缩」与我们规划的「卷纲+滚动摘要」同构。
- [CreAgentive](https://arxiv.org/html/2509.26461v1)(2025-09):Initialization → Story Generation → Writing 三阶段多 agent 工作流,面向多类型长篇小说。
- [StoryBox](https://ojs.aaai.org/index.php/AAAI/article/view/40288/44249)(AAAI 2026):多 agent 仿真做「自底向上 + 自顶向下」混合长篇生成。
- [BookWorld](https://arxiv.org/html/2504.14538v1)(2025-04):从小说构建交互式 agent 社会——反向应用:用「人物状态仿真」辅助作者校验人物行为一致性。
- 实践侧:Claude Code 写作框架流行,代表是 [Claude Book](https://hackernoon.com/claude-book-a-multi-agent-framework-for-writing-novels-with-claude-code)(开源:[ThomasHoussin/Claude-Book](https://github.com/ThomasHoussin/Claude-Book),详见第四节)。

---

## 二、记忆系统设计(本章重点)

### 2.1 SillyTavern World Info / Lorebook——关键词触发注入的完整参数学

一手来源:[官方文档 World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)、社区完整指南([TavernSprite](https://tavernsprite.com/blog/sillytavern-lorebooks-world-info-guide))。

条目结构与触发机制(全部为官方字段):

- **Key(主键)**:逗号分隔关键词,默认不区分大小写,支持 JS 正则;**key 本身不进入上下文**,只有触发后的 Entry Content 注入——内容必须自足。
- **keysecondary(可选过滤键)**:与主键做 AND ANY / AND ALL / NOT ANY / NOT ALL 四种逻辑,缩小误触发。
- **Scan Depth(扫描深度)**:检查最近 N 条聊天消息是否有 key(条目级可覆盖);0=不扫,1=仅最后一条。
- **Recursive Scan(递归扫描)**:已激活条目的内容中出现的其他条目 key 可以级联激活,受 Max Recursion Steps 限制(0=仅受预算限制,1=禁用,2=递归一层);每条可设 Non-recursable / Prevent further recursion / Delay until recursion。用途:提到「某组织」时自动带出「该组织的据点」。
- **Insertion Position(插入位置)**:Before/After Char Defs、Top/Bottom of Author's Note、**@ D 指定深度**(距上下文末尾第 N 条)等——这是对抗 Lost in the Middle 的直接手段。
- **Insertion Order**:同位置多条目的排序,数值越大越靠近上下文末尾、影响越大。
- **Probability(触发概率 %)**:100=必插(默认),可做随机事件。
- **Budget(token 预算)**:限定 World Info 可用 token;超预算时按「Constant 条目 > Order 大者 > 直接命中 > 递归命中」取舍——**预算内优先级淘汰是必抄的机制**。
- **Timed Effects**:Sticky(激活后保持 N 消息)/ Cooldown / Delay——解决「人物出场后几章内应持续记住其设定」的问题。
- **Constant(🔵 常驻)**:无条件注入;**Vectorized(🔗)**:用向量相似度替代关键词检测。
- **对中文的关键告警(官方原文)**:`Match whole words`(整词匹配)对中文、日文这类无空格语言**有负面影响,建议关闭**——中文关键词匹配应当用子串匹配。
- 向量检索在 ST 中的定位:只替代 key 检测,官方明说「想要确定性结果请用关键词」。

### 2.2 NovelAI Lorebook——同一范式的商业化变体

一手来源:[NovelAI 官方文档 Lorebook](https://docs.novelai.net/en/text/lorebook)、[官方博客](https://blog.novelai.net/lorebook-generation-custom-context-menu-more-da7f49817ef3)。

- **Activation Keys(激活键)**:没有 key 的条目模型永远不会读到。
- **Search Range(搜索范围)**:按**字符数**(而非消息条数)向回扫描正文找 key——比 ST 的「条数」更贴合纯文本写作场景。
- **Trigger %**:激活概率,可做低频事件。
- **Insertion Position / Key-Relative Insertion**:条目可插在上下文固定位置或**相对 key 出现位置**偏移 ±N(如 -4),官方博客将其列为新特性——让设定紧挨着提及处,再次呼应首尾/就近原则。
- **Cascading Activation(级联激活)**= ST 的递归扫描;**Force Activation**=手动钉住;**Priority + Budget**:预算内按优先级淘汰。
- 与 SillyTavern 的差异: NovelAI 面向「一条连续正文」,扫描单位是字符;ST 面向「对话」,扫描单位是消息条数。WWriting 面向章节文件,应取 NovelAI 的字符口径(对本章文本 + 最近章节文本做扫描)。

### 2.3 NovelCrafter Codex——「别名识别 + 场景关联」的编辑器路线

一手来源:[NovelCrafter 官方文档 Codex](https://www.novelcrafter.com/docs/codex);辅助:[Inkfluence AI 对比文](https://www.inkfluenceai.com)、[ShakespeareAI 对比文](https://shakespeareai.net)。

- Codex 是「Story Bible & World Builder」:条目分类型(人物/地点/物品/组织等),**每个条目可挂别名(al aliases)与昵称**,系统在正文中自动检测提及(mentions)并高亮;条目间可建 Relations(关系),支持 custom fields。
- **Progressions(进展)**:条目的信息可随剧情演进挂载「在某章之后新增/变更的设定」——即「人物在第 10 章受伤,第 10 章后所有注入都带伤势」。这是对「状态随章节变化」最优雅的产品化,WWriting 的人物状态跟踪应采用同构设计。
- 注入逻辑:AI 看到的上下文 = 当前场景相关的 Codex 条目(按 mentions/别名识别)+ 场景摘要 + prompt 组件(codex calls、series context 等)。**不靠 token 预算海选,靠「本场景提及了谁」精确定位**;代价是需要别名表维护准确。
- 商业模式:BYOK(自带 API key),AI 成本走用户自己的 key——与 WWriting CLI 的本地 CLI 形态一致。

### 2.4 Sudowrite Story Bible——「大纲→beats→章节」的流水线路线

一手来源:[Sudowrite 官方文档](https://docs.sudowrite.com/)。

- Story Bible 组成:Braindump(脑暴倾倒)→ Genre / Style(类型与风格)→ Synopsis(梗概)→ Characters(角色,含 Portraits 画像)→ Worldbuilding → Outline → Scenes & Draft。
- 生成链:Sudowrite 把 synopsis 扩写成结构化 bible + **逐章 beat sheet(节拍表)**,Chapter Generator 按 beats 逐个执行、可连续执行多个 beat 生成整章(社区评测与讨论见 [getconch.ai](https://www.getconch.ai) 等综述,细节以官方文档为准)。
- 特点:**风格可训练/生成**(以样本文本生成风格描述,让输出贴近作者声线);**bible 是生成层的持久数据集**而非检索库。
- 社区口碑:prose 质量口碑最好,但按字数 credit 计费、长稿连续性弱于 Codex 类方案(见 2.5 末尾与第七节)。

### 2.5 触发注入 vs 向量检索 vs 混合:长篇场景的选型

| 维度 | 关键词触发(ST/NovelAI) | 别名/场景关联(NovelCrafter) | 向量检索 |
| --- | --- | --- | --- |
| 确定性 | 高(命中即注入,可复现) | 高(依赖别名表完整性) | 低(召回随语义漂移) |
| 维护成本 | 中(要选好 key、防误触发) | 中(要维护别名表) | 低(免维护但难调试) |
| 中文友好 | 好(子串匹配即可;整词匹配须关) | 好(中文别名天然子串) | 一般(中文分词/嵌入质量影响大) |
| 长处 | 跨章远距触发(伏笔词再现) | 「本章提到谁就带谁」,精准 | 同义转述、代词回指场景 |
| 短板 | 提及的别称/代词抓不到 | 新别名未登记就漏 | 假阳性注入、不可解释 |

- 结论:**关键词/别名触发为主干,向量检索为可选增强**(处理「他」「那个人」类回指与转述)。ST 官方与 NovelCrafter 的实践都把向量法当扩展而非默认;中文网文人名短、别称多,别名表是第一公民。
- 产品口碑侧证:2025–2026 多份对比([StravoAI 年度榜](https://stravoai.com)、[chapter.pub 对比](https://blog.chapter.pub)等,未逐字核对原文)把 NovelCrafter 列为长篇小说首选,理由正是 Codex 连续性管理 + BYOK;Sudowrite 被指「credit 消耗快、长稿连续性弱」;NovelAI 上下文窗口小(数千 token 量级,依赖 Lorebook 精打细算),适合互动续写而非整本管理(社区通行说法,未在官方页面确认具体数字)。

---

## 三、章节化工作流与上下文组装

### 3.1 层级组织:大纲→卷→章→场景

中文网文行业的标准层级(来源:网文写作教程与工具抽象,[知乎结构讨论](https://www.zhihu.com)、[大纲完全教程](https://www.scribd.com)等二手汇总;开源工具 [novel-helper](https://github.com/XFSeven7/novel-helper) 的界面抽象与此一致):

```text
全书(总纲:题材/核心爽点/主线矛盾/结局)
 └─ 卷(卷纲:一个主冲突/一张地图/一个 BOSS)
     └─ 章(章纲:事件+冲突+钩子,2000–4000 字)
         └─ 场景/节拍(细纲:地点、出场人物、对话要点、情绪曲线)
```

- 知乎讨论抽象出的更细颗粒:`情绪 → 刺激反应单元 → 场景 → 章 → 故事 → 卷 → 整本`,每层服务读者情绪——网文的「章」本质是情绪单元而非字数单元。
- 常规技法:**开篇黄金三章**(前三章决定签约/推荐)、**章末留钩**(每章结尾抛出悬念)——细纲层就应包含「本章钩子」字段。

### 3.2 每次生成的上下文组装策略

综合 ST 插入位置体系、StoryWriter 的动态历史压缩、Claude Book 的状态快照,长篇章节生成的上下文拼装公式(从上到下):

```text
[系统提示:写作规范/禁区]                      ← 常驻
[风格规则 + 风格样本对话]                      ← 常驻(风格一致性,见 4.2)
[全书梗概 + 本卷卷纲]                          ← 常驻(百~千字级)
[卷级/阶段级前情摘要(summary of summaries)]   ← 滚动更新
[最近 2–3 章逐章摘要]                          ← 滚动更新
[相关设定条目:本章细纲/文本触发的 Codex 条目]  ← 触发注入,受 token budget 限制
[上一章结尾原文(500–1000 字)]                 ← 保证文风衔接
[本章细纲:场景列表/出场人物/目标/字数预算/钩子] ← 最近生成,放末尾
```

要点:① 本章任务指令与上一章结尾放在**末尾**(Lost in the Middle:尾部注意力最强);② 全局性内容放开头;③ 中段只放触发命中的设定条目;④ 总预算固定(如 8k–16k token),超预算按优先级淘汰(ST Budget 模式)。

### 3.3 滚动摘要(summary of summaries)

- 通行模式([hinterbuild 上下文管理文](https://hinterbuild.com)、[StackAI 记忆模式](https://www.stackai.com)等):**最近 2–4 轮/章保留原文 → 每章末压缩成逐章摘要 → 更早内容合并为卷级摘要**;层次化摘要逐级合并,即「摘要梯子(Summarization Ladder)」。
- 已知代价:[The Summary Tax](https://tianpan.co) 一类工程反思指出,频繁触发的递归压缩本身会成为推理成本大头——**应在章节边界(固定点)做摘要,而不是按 token 阈值随机触发**,这也符合「Run 结束只留状态行」的产品节奏。
- 摘要必须结构化:摘要不只是自然语言,应同时产出「状态 diff」(谁受伤了/谁知道什么/伏笔埋没埋),否则细节在摘要链中漂失(Claude Book 的 state 目录就是为此存在)。

### 3.4 网文行业实际工作流参考

- 人类作者节奏(一手报道):唐家三少长期稳定 **3000 字/章、日更 6000 字**(腾讯新闻《网络文学"破壁者"访谈》,经搜狐转载页面检索到);志鸟村回忆 2005 年前后流行日更八千到一万(百度百科·网络作家条目,未确认原话);AI 时代有作者「手搓 2000 字 + AI 扩写到 4000 字」(搜狐 2026-09 报道 [「规模大到失控」,唐家三少急了](https://m.sohu.com))。
- 飞卢/起点的运营口径:上架首订章节建议拉到 **8000–10000 字**,平时章节 4000–6000 字(起点论坛攻略帖,社区口径未确认)。
- AI 参与后的流程(中国新闻周刊等报道汇总):世界观搭建→大纲→章节细纲→正文输出已可全自动,但「没有人味儿」与批量灌水(「48 小时 500 万字」)正被平台整治([搜狐 2026-09-13](https://www.sohu.com) 报道检索到)。

---

## 四、一致性维护

### 4.1 人物状态 / 时间线 / 伏笔的跟踪方法

三种主流载体(按工程化程度递增):

1. **Markdown 文件族(Claude Code 实践)**:[Book Bible playbook](https://claudecodehq.com/playbooks/book-bible) 的结构——`characters/` 每角色一文件(外貌/性格/声线/关系/弧线/出场记录)、`timeline.md`(事件+日期+后续影响)、`world-rules.md`(已确立规则)、`plot-outline.md`;并强制流程:写某角色场景前必读其文件、引用过去事件前必查 timeline、发现矛盾必须标记、新设定确立后立即更新、**未经作者批准不得更改已确立事实**;提供 `/check`(场景对照 canon)、`/inconsistency`(全库矛盾扫描)命令。该文强调:**模糊的时间线是连续性错误的最大来源**。
2. **状态快照 + 符号链接(Claude Book 框架,[HackerNoon](https://hackernoon.com/claude-book-a-multi-agent-framework-for-writing-novels-with-claude-code))**:
   - 四目录:`bible/`(生成期间永不变:风格规则、禁用元素、人物声线与对话范例)、`state/`(人物位置/物品/知识/关系,**每章验证后生成带版本快照**)、`story/`(大纲+章节)、`timeline/`;
   - `state/current` 符号链接始终指向最新已验证快照——任何 agent「写第 15 章」时读 current 即获得前 14 章全部事实,**无需 10 万 token 上下文**;
   - **验证门禁**:审校子代理(只验证不写作)通过后才更新状态并进入下一章;连续性 lint 甚至抓出过大纲自相矛盾。
3. **结构化表/知识图谱**:中文社区的「百万字不烂尾」三件套为知识图谱、三级大纲、角色状态追踪([maliangwriter 综述](https://maliangwriter.com),未确认方法论细节);开源 [novel-creator-skill](https://github.com/leenbj/novel-creator-skill) 用「记忆同步→一致性检查→风格校准→校稿」五层协同;[novelwriting-kit](https://github.com/lihongwen/novelwriting-kit) 主打 100+ 章的人物弧线跟踪。

### 4.2 风格一致性

- **风格描述 + 样本对话**:Sudowrite 的 Style 可由样本文本生成风格规则;Claude Book 的 bible 要求**每个主要人物带对话范例**,并维护「AI 高频词禁用表」。
- **机械检测 + 重写**:Claude Book 用本地小模型(Ministral 8B)做困惑度门禁诊断「平淡文本」(PPL<22 的单句、σ<14 的低方差窗口、连续 4+ 句 PPL<30 等),再用九种重写技术(Verbalized Sampling 取尾部、人物声线、句法倒装、感官细节等)修复——它的定位是「诊断平文本」而非「检测 AI 文」。WWriting 可先做廉价脚本级检查(高频词、对话占比、重复度)。
- 中文社区同类:LCAS V3.1 等提示词方案针对「主题漂移、逻辑断裂、设定遗忘」三大症候([阿里云开发者社区](https://developer.aliyun.com),未确认方案细节)。

### 4.3 连续性错误的常见类型

综合 [Jenova 的根因分析](https://www.jenova.ai)(未确认原文链接深层页面)与各实践文,长篇 AI 写作的连续性错误清单:

- **人物漂移**:性格、说话方式逐章滑向「统计平均人设」;
- **知识状态错误**:角色知道了 ta 不该知道的事(只跟踪「在哪里」不跟踪「知道什么」所致);
- **时间线断裂**:日期/年龄/季节冲突,或事件先后矛盾;
- **设定违背**:已确立的世界规则(魔法代价、科技水平)被后续章节违反;
- **伏笔遗失**:埋了不收,或收得与埋设矛盾;
- **称谓/专名漂移**:同一角色/地点的名字写法不一致(中文尤甚:别称、昵称、职称混用)。

根因共识:LLM 逐 token 生成只优化局部合理性;上下文滚动时细节先于主旨丢失——所以**状态必须外置为可检索文件,而不是指望上下文或摘要记住**。

---

## 五、中文与网文特有知识

### 5.1 中文字数统计的正确口径

Word 口径([知乎《一文搞懂 MS Word 字数统计》](https://zhuanlan.zhihu.com/p/565782691)):

- Word 统计框 8 项中关键三项的关系:**字数 = 中文字符和朝鲜语单词 + 非中文单词**;
- 「中文字符和朝鲜语单词」**包含全角标点**——故大于纯汉字数;
- 「字符数(不计空格)」= 汉字 + 英文字符 + 标点,不含空格;翻译行业与维普查重(中文论文)都以它为计费/计费口径。

网文平台口径:

- 起点 VIP 章节**按千字计费**(通行说法千字 3 起点币即 3 分/千字,早期千字 2 分,见 [网络文学网站盈利模式分析](https://www.cnblogs.com/anf/p/5069941.html));计费字数为**含标点的章节字数**(作者社区通行说法;起点官方规则页未检索到一手原文,**未确认**);作者月度更新字数按「公众章节字数 + VIP 章节字数」统计(百度知道口径,**未确认**)。
- 混排细节:空格不计(去空白后统计);半角标点/英文字母按字符计入;emoji 罕见但实现上按 grapheme 计 1。

### 5.2 网文写作的实际约束

- **单章字数**:2000–4000 字为主流(2000/3000/4000 一档);唐家三少 3000 字/章 × 日更两章;AI 辅助作者单章 4000+ 字。番茄/起点对单章下限常见 2000 字(平台运营口径,社区通行,**未确认**)。
- **更新节奏**:日更 4000–6000 字为可持续区间;上架首订章 8000–10000 字拉订阅;日更万字以上为高强度模式,行业存在过劳问题。
- **长篇量级**:男频文动辄百万字起步(同一搜狐报道),对应 300–500 章——**「卷」是百万字规模的必要组织层**。
- 节奏技法:黄金三章定生死、章末留钩、上架章加量——这些应成为 WWriting 细纲模板的内置字段。

### 5.3 中文网文 AI 产品现状(2024–2026)

| 产品 | 主体 | 现状与要点 | 来源 |
| --- | --- | --- | --- |
| 彩云小梦 | 彩云科技 | 2021 年起的 AI 续写老牌产品;2024-11 上线 V3.5(自研 DCFormer),上下文从前文 2000 字提升至 10000 字、世界观设定最长 10000 字;每步生成 3 条分支可选;已接入 DeepSeek R1、豆包;定位转向「续写+角色扮演陪伴」 | [官网](https://www.xiaomengai.com)、[量子位报道](https://www.qbitai.com/2024/11/218315.html) |
| 阅文「作家助手」+「妙笔」 | 阅文集团 | 2023-07 发布行业首个网文大模型「阅文妙笔」,作家助手提供描写生成、情节建议(每周调用数十万次);2025-02 接入 DeepSeek-R1 | 行业报道汇总(腾讯新闻检索到,**原文未逐字核对**) |
| 番茄小说 AI 助手 | 字节/番茄 | App 内置 AI 扩写、AI 改写、自定义描写、AI 续写;被认为是最积极推动 AIGC 融合的平台 | 头条新闻 2025-06 报道检索到,**未确认原文** |
| 平台整治 | 各平台 | 2025–2026 治理「AI 批量拆解爆款、填充灌文」(48 小时 500 万字),限制纯 AI 灌水 | [搜狐 2026-09-13](https://www.sohu.com) 检索到 |

- 中文写作模型口碑(社区实测汇总):Claude 中文文学性与长程一致性公认最强(「30 章后才出现遗忘设定」的对比描述见 [什么值得买实测文](https://post.smzdm.com),检索摘要,**原文未逐字核对**);国产长上下文(Kimi、GLM 系列)以百万字文档处理为卖点,但「能读」不等于「能写好」([chooseai 实测](https://www.chooseai.net)等,未确认)。
- 核心缺口(社区共识):国内产品聚焦「扩写/续写/润色」单点能力,**缺少以「项目记忆 + 章节状态」为核心的整本工程管理**——与 WWriting 定位正面互补。

---

## 六、字数统计的工程实现(Node.js)

### 6.1 关键 API 与实测

`Intl.Segmenter` 在 Node 16+ 原生可用(本机 Node v25.2.1 实测),`granularity` 支持 `grapheme` / `word` / `sentence`。实测样例(混合中文、英文、emoji、全半角标点):

```js
const text = '她推开门,雨声涌了进来。\n"你还回来吗?" she asked. English mixed 混排……emoji:🔥 测试abc123。';

text.length;                                   // 69  —— UTF-16 code unit 数(emoji 占 2,会多算)
[...new Intl.Segmenter('zh', {granularity:'grapheme'}).segment(text)].length;
                                               // 68  —— 用户感知字符数(emoji 算 1)
[...new Intl.Segmenter('zh', {granularity:'word'}).segment(text)]
    .filter(s => s.isWordLike).length;         // 20  —— 词级切分(中文按词,英文按词,标点被排除)
text.replace(/\s/g, '').length;                // 62  —— 去空白字符数(含标点)= 网文/平台口径
(text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
                                               // 19  —— 纯 CJK 汉字数
```

### 6.2 count_text 推荐口径与实现要点

1. **主口径:`charsNoSpace` = 去除所有空白(空格/换行/制表)后的 grapheme 字符数(含标点)**。对齐 Word「字符数(不计空格)」与起点「含标点计费」口径,是「作者在平台后台看到的字数」的最佳代理。
2. **辅助口径同报**:`hanzi`(纯汉字)、`words`(Intl.Segmenter word 粒度 + isWordLike,供中英混排参考)、`graphemes`(感知字符数)。一次调用返回结构化 JSON,模型按主口径做篇幅决策。
3. 实现要点:
   - 用 `[...new Intl.Segmenter('zh', {granularity:'grapheme'}).segment(s)].length` 代替 `s.length`,避免 emoji/代理对双计;纯 ASCII 高频路径可快表优化。
   - 去空白正则 `/\s/g` 即可;不必区分全半角标点(平台口径本来就含标点)。
   - `count_text` 应按「章节文件路径」统计而非信任模型粘贴文本,并在返回值中同时给「本章已有字数 / 目标字数 / 差额」,直接支撑「补写还是收尾」的决策。
4. 参考 Word/维普/翻译行业对齐关系:「字符数(不计空格)」是各口径中覆盖面最全的([知乎](https://zhuanlan.zhihu.com/p/565782691));「字数」(Word 语义)会漏掉标点,不适合网文场景。

---

## 七、AI 长篇产品现状(2025–2026)与借鉴点

| 产品/方案 | 形态 | 2025–2026 现状 | 值得 WWriting 借鉴的一点 |
| --- | --- | --- | --- |
| Sudowrite | 商业 SaaS | prose 质量口碑最好;Braindump→bible→beats→章节流水线;credit 计费、长稿连续性弱 | **beats(节拍)粒度**:大纲与正文之间的中间层;风格由样本生成 |
| NovelCrafter | SaaS + BYOK | 年度榜常列长篇第一;Codex 别名识别 + Progressions 状态演进 | **Progressions**:设定条目挂「某章之后生效」的演进;场景关联注入 |
| NovelAI | 商业应用 | 微调小模型续写体验好,上下文小,重 Lorebook 管理 | **Search Range 按字符扫描 + Key-Relative Insertion(就近注入)** |
| SillyTavern | 开源自托管 | 角色扮演生态标准件;World Info 参数学最完整 | **token budget 内的优先级淘汰、递归扫描、Sticky/Cooldown、中文关整词匹配** |
| Claude Code + 文件(实践) | 开发者自建 | Book Bible playbook、Claude Book 等框架流行 | **bible/state 分离、current 快照链接、验证门禁、廉价 lint + LLM 审校分层** |
| 通用 LLM 直写 | ChatGPT/Claude 网页版 | 单 prompt 仅 1000–2000 词;长对话靠摘要续命,细节流失明显([Medium 实录](https://medium.com/aimonks/how-i-wrote-a-whole-book-with-chatgpt-in-less-than-3-hours-798139987617)、[r/singularity 讨论](https://www.reddit.com/r/singularity/comments/151hicw/writers_are_screwed_100k_context_claude_is_a)) | 反面教材:没有外置记忆的裸对话撑不起长篇 |
| 彩云小梦 / 作家助手 / 番茄 | 中文产品 | 分支续写、扩写、润色单点强;整本项目记忆缺失 | 分支续写交互(可作 WWriting 远期参考);平台侧 AI 流程已教育了用户 |

---

## 八、对 WWriting CLI 的落地建议

### 8.1 记忆系统:三层文件 + 触发注入

```text
<项目>/                     # 创作文件夹(章节即文件)
  WWRITING.md               # 记忆入口:全书梗概、风格约定、当前进度(用户可查看可手工编辑)
  outline/                  # 总纲、卷纲、章纲(细纲)
  chapters/                 # 第001章.md ……
  codex/                    # 设定条目,一物一文件
    characters/<名>.md
    locations/<名>.md  items/…  factions/…
  state/
    characters-status.md    # 人物当前状态(位置/伤势/知情/关系)
    timeline.md             # 章节级时间线
    foreshadowing.md        # 伏笔台账
  summaries/                # 逐章摘要 + 卷级摘要(滚动摘要落盘)
<应用私有目录>               # journal/会话/成本——绝不进创作文件夹
```

- **条目格式**:YAML frontmatter(`name`、`aliases: []`、`type`、`keys: []`、`priority`)+ 正文(条目内容必须自足,key 不注入);借鉴 Codex 的 **Progressions 字段**:`since_chapter: N` 之后的段落表示第 N 章后生效的状态——上下文组装时按「当前章 ≥ N」决定注入哪个版本。
- **触发机制**:对「本章细纲 + 上一章结尾 + 最近摘要」做**中文子串匹配**(名称 + 别名 + keys),命中即注入;支持手动 `pin`(Force Activation)与常驻条目(Constant)。**不做整词匹配**(ST 官方对中文的告警);向量检索留作可选扩展,不进 MVP。
- **递归触发**(二期):命中条目内容里提到的其他条目名可级联激活,限一层(ST Max Recursion Steps=2 的保守用法)。
- **token 预算**:设定条目区设硬预算(如 3000 token),超预算按 `priority` + 命中位置淘汰(ST Budget 模式)。

### 8.2 上下文组装策略(每章生成)

按 3.2 公式实现,并遵守:① 章节任务与上一章结尾原文(500–1000 字)放上下文**末尾**;② 风格规则/全书梗概放开头;③ 设定条目居中且受预算控制;④ **摘要在章节边界固定生成**(逐章摘要 → 每 10–20 章合并卷级摘要),摘要同时产出结构化状态 diff 供 state/ 更新;⑤ 每章生成用 AgentWrite 两步:先生成本章场景级计划(每场景字数预算),再逐场景生成——单次生成控制在 1000–2000 字,拼装成章后用 count_text 校验总长。

### 8.3 count_text:口径与实现

- 主口径 **charsNoSpace(去空白字符数,含标点)**;同报 hanzi / words / graphemes(实现见第六节,已实测)。
- 工具签名建议:`count_text({ files: string[] | { target, draft } }) → { charsNoSpace, hanzi, words, perFile[] }`,返回差额与达标判定,模型不得自报字数。
- 目标字数来自细纲的 `target_words` 字段(章纲模板内置 2000/3000/4000 档与「上架章 8000+」提示)。

### 8.4 伏笔/人物跟踪的数据结构建议

- **人物**:`codex/characters/<名>.md` 静态设定 + `state/characters-status.md` 动态状态表(字段:`人物 | 位置 | 伤势/状态 | 知情事项 | 关系变动 | 最近出场章`)。状态表每章完成后由 agent 生成 diff 提案,经确认(权限分级)后落盘——即 Claude Book 的「验证门禁 + 快照」模式,快照历史存应用私有目录、当前态留在创作文件夹供用户查阅编辑。
- **时间线**:`state/timeline.md` 一张表(`章节 | 故事内日期 | 事件 | 影响`),强制每章更新;写作前「引用过去事件必查时间线」写进系统提示(Book Bible 规则)。
- **伏笔**:`state/foreshadowing.md` 台账(`id | 埋设章 | 描述 | 状态(埋设/回收) | 计划回收位置`);埋设时登记、回收时勾销,卷纲生成时把「未回收伏笔」注入规划上下文——这是关键词触发解决不了的远距一致性,必须靠台账而非检索。
- **一致性检查**:提供 `/check` 式显式命令(写前对照 canon)与章末自动 lint(廉价脚本查专名写法漂移、称谓不一致 + LLM 审校查逻辑矛盾),矛盾报告只呈现一条用户可理解的事实,详情折叠。

### 8.5 风险与未验证项

- 起点官方计费规则原文未检索到,「含标点计费、千字 3 点」为社区通行口径,落地文档中应注明来源等级;
- 国内平台 AI 工具(作家助手/番茄)的能力细节基于 2025–2026 报道,未做一手实测;
- 向量检索在中文长篇的增益未实测,不进入 MVP 结论。

---

## 附:主要来源清单(一手来源加粗)

1. **[Lost in the Middle (arXiv 2307.03172)](https://arxiv.org/abs/2307.03172)**
2. **[Context Rot (Chroma, 2025)](https://www.trychroma.com/research/context-rot)**
3. **[LongWriter / AgentWrite (arXiv 2408.07055)](https://arxiv.org/abs/2408.07055)** 与 [THUDM/LongWriter](https://github.com/THUDM/LongWriter)
4. **[Re3 (arXiv 2210.06774)](https://arxiv.org/abs/2210.06774)**
5. **[Dramatron (arXiv 2209.14958)](https://arxiv.org/abs/2209.14958)**
6. **[RecurrentGPT (arXiv 2305.13304)](https://arxiv.org/abs/2305.13304)**
7. **[StoryWriter (arXiv 2506.16445)](https://arxiv.org/abs/2506.16445)**
8. **[CreAgentive (arXiv 2509.26461)](https://arxiv.org/html/2509.26461v1)**、**[StoryBox (AAAI 2026)](https://ojs.aaai.org/index.php/AAAI/article/view/40288/44249)**、**[BookWorld (arXiv 2504.14538)](https://arxiv.org/html/2504.14538v1)**
9. [Awesome-Story-Generation](https://github.com/yingpengma/Awesome-Story-Generation)、[A Survey on LLMs for Story Generation](https://mariateleki.github.io/pdf/EXTENDED_A_Survey_on_LLMs_for_Story_Generation.pdf)
10. **[SillyTavern World Info 官方文档](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)**、[TavernSprite 社区指南](https://tavernsprite.com/blog/sillytavern-lorebooks-world-info-guide)
11. **[NovelAI Lorebook 官方文档](https://docs.novelai.net/en/text/lorebook)**、**[NovelAI 博客:Cascading Activation 等](https://blog.novelai.net/lorebook-generation-custom-context-menu-more-da7f49817ef3)**
12. **[NovelCrafter Codex 官方文档](https://www.novelcrafter.com/docs/codex)**、[Inkfluence 对比](https://www.inkfluenceai.com)、[ShakespeareAI 对比](https://shakespeareai.net)
13. **[Sudowrite 官方文档](https://docs.sudowrite.com/)**
14. **[Book Bible playbook (claudecodehq)](https://claudecodehq.com/playbooks/book-bible)**
15. **[Claude Book 框架 (HackerNoon)](https://hackernoon.com/claude-book-a-multi-agent-framework-for-writing-novels-with-claude-code)** 与 [ThomasHoussin/Claude-Book](https://github.com/ThomasHoussin/Claude-Book)
16. **[一文搞懂 MS Word 字数统计 (知乎)](https://zhuanlan.zhihu.com/p/565782691)**
17. **[彩云小梦官网](https://www.xiaomengai.com)**、**[量子位:彩云小梦 V3.5](https://www.qbitai.com/2024/11/218315.html)**
18. [搜狐:「规模大到失控」,唐家三少急了(2026-09)](https://m.sohu.com)
19. [网络文学网站盈利模式分析(起点千字计费)](https://www.cnblogs.com/anf/p/5069941.html)
20. [hinterbuild:Context Window Management](https://hinterbuild.com)、[StackAI 记忆模式](https://www.stackai.com)、[The Summary Tax](https://tianpan.co)
21. [novel-helper(网文大纲工具)](https://github.com/XFSeven7/novel-helper)、[novel-creator-skill](https://github.com/leenbj/novel-creator-skill)、[novelwriting-kit](https://github.com/lihongwen/novelwriting-kit)
22. [Medium:How I Wrote a Whole Book with ChatGPT](https://medium.com/aimonks/how-i-wrote-a-whole-book-with-chatgpt-in-less-than-3-hours-798139987617)、[r/singularity 讨论](https://www.reddit.com/r/singularity/comments/151hicw/writers_are_screwed_100k_context_claude_is_a)
23. [ACL Findings 2025:Mitigate Position Bias](https://aclanthology.org/2025.findings-acl.316.pdf)、[RULER (arXiv 2404.06654)](https://arxiv.org/abs/2404.06654)
