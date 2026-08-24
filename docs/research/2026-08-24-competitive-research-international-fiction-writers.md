# Competitive Research: 国际主流 AI 小说写作工具 vs WWriting

- 日期：2026-08-24；模式：Standard（目标 6 家，实际可取证 5 家 direct/adjacent + 1 家 baseline；Novelizer 与 Epyllion 见 limits）
- 决策问题：WWriting 作为"本地优先、文件夹即工作区、agent 自主写作"的桌面工具，相对国外主流 AI 小说写作 SaaS，哪些是 table stakes、哪些差异点可被作者感知、哪些 gap 会阻碍采用。

## Executive Conclusion

国际市场的 AI 小说写作工具已分化为两种商业模式：**按量/订阅计量型**（Sudowrite credits、NovelAI Anlas）与 **BYO-key 工具型**（NovelCrafter、RaptorWrite）[E5][E6][E7]。WWriting 的"自带 Key + 无字数计量 + 本地文件夹"组合在这 5 家中唯一成立——NovelCrafter 允许自带模型但仍按席位收订阅费 [E2][E3]，RaptorWrite 免费但工作保存在其云端 [E7][E9]。最强的可感知差异是**计费透明度与数据归属**；最大的采用阻碍在内容供给侧：Sudowrite 以 Story Bible 引导流 + 12 个写作工具 + 1000+ 插件构成"素材与工作流密集"的获客面 [E4]，而 WWriting 目前只有写作风格技能。RaptorWrite 的"发送前可见 AI 将看到什么"上下文披露 [E8] 已验证了 WWriting 工作组条目方向的市场需求，值得继续加深而非新造。

## Current Product Baseline

WWriting（本地桌面，Electron）：单一 ProjectAgent 内核（聊天/写作循环、章节队列、停止恢复）、Journal 事件溯源（应用私有目录）、自研 ModelGateway（OpenAI 兼容 function calling，Key 仅存本机）、SKILL.md 插件化技能体系（12 个写作风格技能）、WWRITING.md 项目记忆、count_text 客观字数工具、章节版本快照（200 版上限、校验和防陈旧覆盖）、可见上下文压缩、权限确认体系、确定性导出（不经模型）。以上为已发布能力（README，v0.5.0）。

## Competitor Comparison

| Competitor | Category | Evidence | Lesson | Do Not Copy |
| --- | --- | --- | --- | --- |
| NovelCrafter | direct | [E1][E2][E3] | Codex 设定集 + 自动追踪 + 跨系列共享是长篇一致性的成熟信息模型；BYO key（含 OpenRouter 300+ 模型、LM Studio、Ollama 本地）已是品类标配 | 仍按席位收订阅费（$4/月起）的模式；纯 Web 端数据在厂商侧 |
| Sudowrite | direct | [E4][E5] | Story Bible 引导流（想法→大纲→beat→成章）降低上手门槛；credits 滚存 12 个月、取消后保留项目访问权是好的订阅礼节 | credit 计量心智（225k/月起步）与作者"改一处重生成"的成本焦虑 |
| NovelAI | adjacent | [E6] | 自训模型 + 图像生成（Diffusion V5）形成"世界可视化"生态位；Anlas 点数与订阅分层 | 文本工具线弱化为 Storyteller 单入口；以图像为中心的产品方向 |
| RaptorWrite | direct | [E7][E8][E9] | 免费工具 + OpenRouter BYO key + 无加价已被验证可行；"发送前看到 AI 将看到什么"的上下文披露、模型按任务分组（Model Collections）、提示词库、版本快照都是低成本高感知功能 | 云端保存导致的设置丢失类可靠性问题（C 级社区反馈，仅作发现线索） |
| Scrivener | baseline | [E10][E11] | 非 AI 时代的长篇基线：活页夹结构 + 卡片板 + 编译（Word/PDF/Epub/Kindle/FDX）+ 快照对比；一次性买断、按平台分别授权 | 无 AI；交互密度高、学习曲线陡（社区共识，未取证，不计入结论） |

## Cross-Market Patterns

- **Table stakes**：设定集/故事圣经类信息模型（NovelCrafter Codex、Sudowrite Story Bible）[E1][E4]；章节级版本快照（RaptorWrite、Scrivener 均有）[E8][E10]；多格式导出（Scrivener 编译为标杆）[E10]；BYO 模型选择权（NovelCrafter、RaptorWrite）[E2][E7]。
- **可感知差异点**：零计量计费（唯 WWriting，[E5][E6] 对照）[E12]；本地文件夹即工作区、数据物理归属作者（RaptorWrite 为云存储 [E9]，NovelCrafter 为 Web 端）；agent 式自主多步工作流（5 家均为"作者逐步驱动工具"形态，无自主循环与可见计划队列）[E13]。
- **采用阻碍 gap**：内容供给侧素材库（Sudowrite Brainstorm/1000+ 插件 [E4]）；跨系列设定共享 [E1]；图像类世界可视化（NovelAI [E6]）。
- **Non-goal**：WWriting 不做云端多人协作与订阅计量——与本地优先、数据自有的定位冲突（NovelCrafter 的协作席位 [E1] 与 Sudowrite 的 credit 体系 [E5] 明确不复制）。

## Prioritized Roadmap

### P0

把"自带 Key、零计量、数据在本地文件夹"做成与 5 家对照的可感知主张：全行业均在计量（credits/Anlas/席位订阅）[E3][E5][E6]，唯 WWriting 无中间商。验收信号：README/落地页新增一张与 NovelCrafter/Sudowrite/NovelAI/RaptorWrite 的计费机制与数据归属对照表。

### P1

1. 上下文来源披露：借 RaptorWrite 已验证的需求 [E8]，在对话轮次 UI 中显示"本轮注入了哪些文件/记忆"，与现有工作组条目融合。验收信号：任意一轮对话可展开查看该轮上下文来源清单。
2. 素材型技能包：对标 Sudowrite Brainstorm/插件生态 [E4]，用现有 SKILL.md 插件体系装载"起名器、脑洞/题材模板、场景描写素材"等低成本高感知技能。验收信号：内置技能目录新增 ≥3 个素材型技能且可在设置页启用。

### P2

1. 确定性导出扩展到 epub（对标 Scrivener 编译 [E10]，仍不经模型）。验收信号：导出菜单产出 .epub 且通过 epubcheck 校验。
2. 跨项目/系列级设定共享的研究（对标 Codex 跨书共享 [E1]）——仅预研，不承诺。验收信号：一份设计笔记说明"系列共享设定"如何映射到多工作区结构。

## Research Limits and Next Validation

- novelizer.ai 首页为无正文 SPA，两次抓取为空；未采用 Product Hunt 三方介绍作为能力证据。Novelizer 记为 unverified，不进对比表。
- "Epyllion" 在多轮检索中查无此写作产品（同名实体为 Matthew Ball 的投资机构与古典文学术语），从名单移除。
- NovelCrafter /pricing 页三次抓取超时/限流，分层价格细节 unverified；仅采用其首页"plans starting from 4 USD/m + 21 天免费试用"表述 [E3]。
- Scrivener 概览页未展示金额，一次性买断价格 unverified，未引用第三方报价。
- NovelAI 首页未出现其历史上知名的加密声明，本次未引用；如需引用应取其 docs 原文。
- Reddit 对 RaptorWrite"刷新丢设置"的批评为 C 级证据，仅作发现线索，未进入结论。
- 下一步验证建议：亲手注册 RaptorWrite 与 NovelCrafter 各 30 分钟，验证上下文披露与 Codex 自动追踪的真实体验；用 WWriting 打开两家的导出产物验证"零配置续写"。
