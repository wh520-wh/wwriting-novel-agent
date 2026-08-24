# Competitive Research: 市场面——潜在威胁 Watchlist 与素材/模板市场（合并版）

- 日期：2026-08-24；模式：Standard（3 个 watchlist 对象：Kimi/Moonshot、Notion AI、NotebookLM；3 个素材市场参照：Sudowrite、RaptorWrite、Long-Novel-GPT）
- 决策问题：跨界大厂/通用 agent 产品在多近的未来会侵蚀"本地长篇写作 agent"生态位；市面素材（模板/生成器/风格包）以什么形态存在、WWriting 技能体系如何承接。

## Executive Conclusion

Watchlist 按威胁近远排序：**Kimi 最近**——K3（2.8T 参数、原生多模态、1M-token 上下文）+ Agent/Multi-Agent 产品线 + macOS/Windows 桌面端，已把"长上下文 + agent + 桌面"三要素集齐 [E2]；**Notion Agent 居中**——任务级 agent + 跨应用搜索已上线并按 credits 计价 [E1]；**NotebookLM 最远**——定位是"基于你文档的研究助理"，是检索-综述型而非生成-交付型 [E3]。共同点是三者都没有"本地文件夹 + 自带 Key + 零计量 + 长篇工作流"的组合——WWriting 的窗口仍在但需在对外材料中说清。素材市场已收敛为三形态：**生成器**（起名/标题/脑洞）、**模板库**（题材/结构）、**风格 prompt 包**（作者风格，社区贡献）[E4][E5][E6]，三者都能被 SKILL.md 体系无损承载。明确的 non-goal：不做跨应用连接器搜索、不做音频概述类功能。

## Current Product Baseline

WWriting：本地桌面、任意 OpenAI 兼容网关、自带 Key、零计量、默认禁网；SKILL.md 插件化技能体系（12 个写作风格技能，四层目录覆盖）；WWRITING.md 项目记忆；无素材/生成器类技能；无对外 watchlist 对照说明。

## Competitor Comparison

| Player | Category | Evidence | Lesson | Do Not Copy |
| --- | --- | --- | --- | --- |
| Kimi (Moonshot AI) | potential（最近） | [E2] | K3 2.8T/原生多模态/1M-token 上下文（2026-07）；Agent、Agent Swarm、Multi-Agent、Parallel Agent 产品线；macOS/Windows 桌面端 + Document/Slides/Sheets 工作流 | 通用全家桶方向；平台绑定 |
| Notion AI | potential（居中） | [E1] | AI blocks/Research Mode/AI Meeting Notes；Notion Agent 接管整任务；Enterprise Search 跨 Slack/GitHub；Custom Agents $10/1000 credits（2026-05 起计价） | credits 计价；workspace 锁定 |
| NotebookLM | potential（最远） | [E3] | "AI-first notebook, grounded in your own documents"；摘要/提问/生成想法三功能；引用带原文引语可核查；声明数据不用于训练 | 检索综述型，非创作交付型 |
| Sudowrite | 素材市场参照 | [E4] | Plugins "1,000+ new ways to write"（含模拟读者、小说转剧本）；Brainstorm 生成名字/物品/标题并从点赞学习偏好；Visualize 角色图生成 | 插件生态的维护成本 |
| RaptorWrite | 素材市场参照 | [E5] | Prompt Library 一键保存复用；Model Collections 按任务分组模型；免费课程作为分发漏斗（安装课含连接 API Key 教学） | 课程捆绑获客的摩擦 |
| Long-Novel-GPT | 素材市场参照 | [E6] | 作者风格 prompt（如天蚕土豆风格大纲写作、草稿润色）经 GitHub issue 社区征集分发 | 无 License 状态限制了素材再分发 |

## Cross-Market Patterns

- **威胁共性**：长上下文（1M）+ agent 产品线 + 桌面端在通用大厂集齐 [E1][E2]，"agent 自主工作流"独占窗口在收窄——与批 1 国内调研（岱宗"写作圈 Cursor"、蛙蛙智能蛙）判断一致。
- **WWriting 的护城河组合**：本地文件夹、自带任意 Key、零计量、长篇垂直工作流（队列/断点/版本/权限）——watchlist 三家均无此组合 [E1][E2][E3]。
- **素材三形态**：生成器（点一下出结果）、模板库（填空起步）、风格包（约束生成）[E4][E5][E6]；社区贡献素材用最小摩擦渠道（issue/插件市场）分发。
- **Non-goal**：跨应用连接器搜索、音频概述、通用办公全家桶。

## Prioritized Roadmap

### P0

在 README/官网建立"与通用 agent 的区别"对照小节：对 Kimi/Notion/NotebookLM 各一行（本地 vs 云、零计量 vs credits、长篇垂直 vs 通用任务），并在能力表标注 watchlist 已集齐的要素（长上下文/agent/桌面）。验收信号：README 出现 watchlist 对照小节且每个判断可回链到本报告证据。

### P1

素材技能三件套（SKILL.md 承载三形态）：生成器型（起名/标题/脑洞，一次调用出多个候选）、模板型（题材/卷结构模板，/init 可选）、风格包型（作者风格 prompt，对标社区风格包 [E6]）。验收信号：新增 ≥3 个素材型技能，其中至少 1 个生成器型，且均可在设置页启用与被 WWRITING.md 记录。

### P2

预研"超大上下文模式"开关：当接入 1M 级模型（如 Kimi K3 [E2]）时允许"全设定注入"替代部分压缩场景，评估成本与一致性取舍。验收信号：一份设计笔记给出 1M 窗口下写前装配与压缩预算的两套参数与成本估算；跨应用搜索与音频概述列为 non-goal。

## Research Limits and Next Validation

- NotebookLM 证据为 2023 发布公告原文（Audio Overviews 等后续功能未取证）；notebooklm.google.com 对当前出口地区重定向不可用，产品现状未核实。
- Notion AI 的 per-member 加购价格未在页面出现，仅有 plan 内含与 credits 计价两条事实。
- Kimi K3 的产品可用性（哪些能力已随桌面端发布）未逐项核实，仅采信官网能力列表。
- 素材市场未取证 NovelAI 的 lorebook 生态与中文侧素材站（国内工具素材面已由批 1 国内独立工具报告覆盖）。
- 下一步验证：安装 Kimi 桌面端实测长文档写作流；跟踪 Notion Custom Agents 计价后的创作者使用反馈。
