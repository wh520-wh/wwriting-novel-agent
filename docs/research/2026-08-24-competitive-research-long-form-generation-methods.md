# Competitive Research: 长篇小说生成的方法论（论文与官方实现）

- 日期：2026-08-24；模式：Standard（6 个方法：4 篇 2024-2025 论文 + 2 个已核验官方实现）
- 决策问题：长篇生成的学术与工程方法中，哪些已被验证有效到值得进入 WWriting 的 agent 内核/技能设计，哪些只在小模型或特定数据集上成立。

## Executive Conclusion

2024-2025 年的方法论在两点上高度收敛：**"固定大纲→填充"是次优模式**——DOME 把规划与写作融合为动态分层大纲 [E2]，WriteHERE 证明去掉预定义工作流、让 agent 在写作中递归分解"检索/推理/写作"异构任务能稳定超过固定流水线 [E3]，StoryWriter 用专职 planning agent 动态决定每章写哪些事件 [E1]；**记忆与冲突检测正在结构化**——时间知识图谱记忆与自动冲突分析器 [E2]、事件关系大纲 [E1]、语言化 LSTM 记忆 [E6] 是同一方向的三种实现。对 WWriting 最直接的行动是把 Visible Plan 升级为"可修订计划"（模型可在写作中修订计划且修订可见），这与三篇论文的动态规划结论一致 [E1][E2][E3]。明确的 non-goal：不自训模型、不做 RL——LongWriter-Zero 与 Next-Chapter RL 属模型侧投入 [E4][E5]，WWriting 以 API 模型为主。

## Current Product Baseline

WWriting：ProjectAgent 内核（agent 循环 + Visible Plan + 章节队列）、WWRITING.md 项目记忆、count_text 客观字数工具、可见上下文压缩（预算优先驱逐大工具输出）、SKILL.md 技能体系、章节版本快照。计划当前为"随执行实时更新"，未定义"模型主动修订计划"的显式语义。

## Competitor Comparison

| Method | Category | Evidence | Lesson | Do Not Copy |
| --- | --- | --- | --- | --- |
| StoryWriter (arXiv 2506.16445) | direct 方法 | [E1] | 三 agent 分工（事件大纲/章节-事件分配/写作+动态历史压缩+反思）；写作时按当前事件压缩历史而非统一摘要 | 多 agent 拓扑本身（WWriting 单内核即可承载同语义） |
| DOME (arXiv 2412.13575) | direct 方法 | [E2] | 规划与写作融合的动态分层大纲；时间知识图谱存取生成内容；时间冲突分析器做自动一致性评测 | 时序 KG 工程量重，产品侧可用轻量时间线文件替代 |
| WriteHERE (arXiv 2503.08275) | direct 方法 | [E1 范式/E3] | 异构递归分解：检索/推理/写作交错执行，无预定义工作流；小说+技术报告双域验证；代码与 prompt 已开源 | 完全无工作流对普通用户太自由——WWriting 的技能即"可选工作流" |
| Next-Chapter Prediction RL (arXiv 2503.22828) | adjacent（模型侧） | [E4] | 写前推理=在浓缩信息上规划下一章；用无标注书库的完成似然改进作奖励；人评全面占优（科幻/奇幻最强） | RL 训练本身（模型侧） |
| LongWriter / AgentWrite (THUDM) | adjacent（模型侧+管道） | [E5] | plan→write 两段式；长度+质量双指标（GPT-4o judge）；纯 RL 32B 声称超百亿级模型长文能力 | 自训模型与 judge 依赖 |
| RecurrentGPT (arXiv 2305.13304) | direct 方法（早期基线） | [E6] | 每步产出"新段落+下段计划+短记忆更新+长记忆追加"——把'计划下一步'作为一等公民输出的最早范式 | 向量检索为中心的记忆（后续工作多用结构化状态替代） |

## Cross-Market Patterns

- **Table stakes（方法层）**：分层规划（大纲→章节→正文）；生成中的历史压缩/摘要；结构化状态存储（事件关系/知识图谱/冻结摘要/append-only 账本）。
- **已验证有效**：动态规划优于固定大纲 [E2][E3]；按当前事件相关性压缩历史优于统一摘要 [E1]；"下一段/下一章计划"作为每步显式输出 [E6]。
- **趋势**：评测从人评/GPT-judge 走向自动化——时间冲突分析器 [E2]、完成似然奖励 [E4]、长度+质量双指标 [E5]（推断见 [E8]）。
- **Non-goal**：自训模型与 RL 训练管线；引入外部 GPT-judge 依赖。

## Prioritized Roadmap

### P0

把 Visible Plan 升级为"可修订计划"：允许模型在写作中显式修订计划（新增/删除/重排待写章节与事件），修订作为事件记录并在 UI 可见。这是三篇 2025 论文的共同结论 [E1][E2][E3]。验收信号：一次写作 Run 中发生 ≥1 次计划修订且在 Journal 事件流与界面上可回看修订前后。

### P1

1. 压缩策略增加"与当前章节/事件相关性"优先级（对标 StoryWriter 的按事件动态压缩 [E1]，现策略仅按预算驱逐大工具输出）。验收信号：压缩决策记录相关性依据，验收语料含"关键设定在压缩后仍被引用"的断言。
2. 技能库新增"写前下一章规划"模式：每章开写前先产出该章计划（对标 Next-Chapter Prediction 的写前推理形态 [E4] 与 RecurrentGPT 的下段计划 [E6]）。验收信号：至少一个内置技能含写前规划步骤且产物落入项目文件。

### P2

审稿模式引入轻量冲突检查清单（时间线/实体状态/承诺未兑现），对标 DOME 冲突分析器的思想 [E2]，以现有自然语言审稿实现。验收信号：审稿提示词包含三类冲突检查项并有对应验收用例。

## Research Limits and Next Validation

- StoryWriter 评测无公开数值（摘要仅定性"显著优于基线"）；DOME/WriteHERE 的具体分数未从摘要提取，需读正文实验节复核。
- 2503.22828 的方法名称（RFTP/具体模型名）未从摘要确认；WriteHERE 作者列表（含 Schmidhuber）来自摘要页注记。
- 未覆盖 2026 年最新论文（检索以 2025 为主）；BookWorld（2504.14538）属交互模拟方向，判断与写作工作台相关性低而未纳入。
- 下一步验证：精读 StoryWriter 与 DOME 的实验节确认效果量级；用 WWriting 实测"可修订计划"技能在 50 章项目上的走形抑制效果。
