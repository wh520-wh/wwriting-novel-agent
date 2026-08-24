# Competitive Research: GitHub 开源长篇小说生成 Agent 的代码实现架构

- 日期：2026-08-24；模式：Standard（5 个高取证仓库；langgraph 多智能体小说框架仅在话题页发现、未取证，见 limits）
- 决策问题：开源写作 agent 在内核循环、长篇一致性、断点恢复、人机协作面上的已验证做法中，哪些值得 WWriting 吸收，哪些是失败/不可迁移模式。

## Executive Conclusion

开源社区对"长篇一致性"已收敛出一套事实标准：**分层冻结摘要 + 实体状态文件 + 写前上下文装配 + 写后校验**——AI_NovelGenerator 的向量检索状态追踪 [E1][E2]、Long-Novel-GPT 的大纲→章节→正文逐层扩写 [E5][E6]、long-novel-writer 的六层冻结摘要与 Canon Ledger [E11] 是同一思路的三代实现。最值得 WWriting 吸收的是 long-novel-writer 的 **append-only 设定账本与 POV known_by 追踪** [E11]——它直接命中"百万字后期走形"痛点且天然适配 SKILL.md 体系。所有项目都是流水线/技能形态，无一采用 WWriting 式事件溯源 + 断点恢复内核 [E13]；AI_NovelGenerator 的维护停摆 [E4] 也印证单维护者流水线项目的脆弱性。明确的 non-goal：不引入 50 线程级并行生成。

## Current Product Baseline

WWriting：ProjectAgent 内核（agent 循环 + 章节队列 + 停止恢复）、Journal 事件溯源（应用私有目录、会话独立事件流）、ModelGateway（OpenAI 兼容 function calling）、SKILL.md 技能体系（四层目录覆盖裁决）、WWRITING.md 项目记忆、count_text 字数工具、章节版本快照（200 版/校验和）、可见上下文压缩、串行 Run。

## Competitor Comparison

| Competitor | Category | Evidence | Lesson | Do Not Copy |
| --- | --- | --- | --- | --- |
| AI_NovelGenerator (YILING0013) | direct | [E1][E2][E3][E4] | 四步 GUI 流水线（设定→目录→草稿→定稿）+ character_state/global_summary 持久化 + 向量库随章更新 + 一致性校对；按任务路由多模型 | AGPL-3.0 传染性；单维护者项目 2025-09 起维护受限、重构拖延 |
| Long-Novel-GPT (MaoXiaoYuZ) | direct | [E5][E6][E7] | "50 章×200 字并行薄草稿→逐层扩写至 2k 字"的并行策略；实时显示调用费用；导入旧作重写；RAG 同步剧情摘要 | 无 License 文件（法律上不可复用）；"达到签约门槛"是需用户监督的自述 |
| RecurrentGPT (aiwaves-cn) | direct | [E8][E9] | LSTM 语言化：每步产出"新段落+下段计划+短记忆更新+长记忆追加"，长记忆落盘可语义检索；人机共写可选续写方向 | 学术 demo 形态（gradio/CLI），GPL-3.0 |
| long-novel-writer (jiaw-Zh) | direct | [E10][E11] | 以 SKILL 形态交付的完整长篇方法论：六层冻结摘要、实体文件、Canon Ledger（5 个 append-only 文件）、POV known_by、9 步写前协议、8 项语义校验（可独立 subagent）、20 章副线提醒、每 50 章快照 | 85 stars 早期项目；无 License 显示 |
| LongWriter (THUDM) | adjacent（方法/模型侧） | [E12] | AgentWrite plan→write 两段式数据管道；LongBench-Write 质量+长度双指标（GPT-4o judge）；纯 RL 的 LongWriter-Zero-32B | 需自训模型/GPU，属模型侧而非产品侧 |

## Cross-Market Patterns

- **Table stakes（开源长篇生成）**：设定/角色状态持久化文件 [E2][E11]；写前装配上下文（25k–40k token 典型用量）[E11]；向量检索召回相关章节 [E1][E8]；分章流水线 [E1][E5]。
- **可感知差异点（WWriting 已有）**：断点恢复与事件溯源（全部 5 家均无）[E13]；权限确认；可见压缩；200 版快照 + 校验和（long-novel-writer 的 50 章快照粒度远粗于 WWriting）[E11]。
- **失败/脆弱模式**：单维护者流水线项目停摆 [E4]；无 License 的"高星不可用" [E7]；并行线程数作为卖点但线上 demo 被限速 [E6]。
- **素材形态**：社区贡献的作者风格 prompt（如天蚕土豆风格）可经 issue 提交 [E7]；题材分支 prompt 包（网文爽点/严肃文学双模式）[E11]——与 WWriting 技能体系的素材化方向一致。
- **Non-goal**：不做 50 线程并行生成——与"同项目串行 Run、共享写面一致"的设计冲突 [E6]。

## Prioritized Roadmap

### P0

吸收 long-novel-writer 的 Canon Ledger 与 POV known_by 机制进 WWriting 技能层：append-only 的 facts/promises/progression/timeline 文件由模型在章节提交时追加，写前协议装配，WWRITING.md 索引。验收信号：内置或示例技能包含 append-only 设定账本与 POV 追踪字段，且 /init 会建立对应文件结构。

### P1

1. 引入"薄草稿并行→逐层扩写"作为可选技能模式（对应 Long-Novel-GPT 的分层扩写 [E5][E6]，但在串行 Run 内以队列实现）。验收信号：一个技能定义两段式流程，count_text 校验扩写后字数达标。
2. ModelGateway 补"按任务路由模型"预设（对标 AI_NovelGenerator 的架构/大纲/草稿/定稿/审校五路路由 [E3]）。验收信号：设置页可为写作/审校/压缩分别指定默认模型。

### P2

把 LongBench-Write 式"长度+质量"双指标纳入 WWriting 的验收语料（GPT-as-judge 不引入，用既有审稿模式替代 judge）。验收信号：验收语料新增同时断言字数区间与语义检查项的用例。

## Research Limits and Next Validation

- langgraph 多智能体小说框架（topics 页发现）与 NovelForge、novel-pro 未逐个取证，仅记为存在；RhythmicWave/NovelForge 的世界观构建细节未核。
- Long-Novel-GPT 与 long-novel-writer 页面均未显示最后提交日期，活跃度判断未完成；star 数来自页面快照（1.2k / 85）。
- 两仓库未显示 License（Long-Novel-GPT 无 license、long-novel-writer 未显示），代码不可直接复用，只能吸收机制思想——已在结论中按"机制借鉴"处理。
- 下一步验证：clone long-novel-writer 与 AI_NovelGenerator dev 分支做源码级走读；实测 Long-Novel-GPT Docker 部署的百万字流程与费用显示。
