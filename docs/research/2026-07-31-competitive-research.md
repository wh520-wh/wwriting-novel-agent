# Competitive Research: WWriting（本地优先的桌面端长篇小说写作智能体）

- **日期**：2026-07-31
- **模式**：Standard（定位决策，6+ 竞品，每竞品 ≥1 一手来源）
- **决策**：README 的差异化定位 —— "把长篇小说写作当作工程来管理的本地桌面智能体：真实交付、可验证、数据在你手里"

## Scope and Evidence Limits

- 竞品覆盖 9 个开源写作 agent / 框架（novel-bot、Novel-OS、SAGA、NovelClaw、Openwrite、novel-architect、AI-Novel-Writing-Assistant、novelforge-agent、Morpheus）和 3 个商业平台（Sudowrite、NovelCrafter、NovelAI）。
- 开源竞品的证据来自其 GitHub 仓库描述（一手来源）；商业竞品的功能/价格证据来自第三方评测（C 级，仅用于发现，价格以官网为准——2026 年中多家价格数据互相冲突）。
- 网络通道：WebSearch 可用；Tavily 检索当月限额已用完，未参与本次调研。
- 未做产品实操测评；本报告全部为桌面调研，不构成安装、基准测试或生产验证。

## Executive Conclusion

长篇小说写作 agent 赛道竞争激烈，**记忆与连贯性、多智能体分工、质量门禁**已是行业标配（[E1][E2][E3][E5]）。但没有任何主流竞品同时满足：**本地桌面 GUI + 文件即项目（用户直接读写 Markdown/TXT）+ 可验证的工程防线（真实字数校验、工具调用交付）+ 透明成本**。

- 商业平台（Sudowrite、NovelCrafter、NovelAI）把用户数据托管在云端，用户为订阅付费、为隐私让渡权利（[E7][E8][E9]）。
- 开源竞品集中在 CLI / 框架形态，要求用户自己配置环境（[E3][E5][E6]），面向开发者而非写作者。
- WWriting 的楔子（wedge）：**"小说写作的工程化桌面应用"** —— 像管理软件项目一样管理小说：章节状态机、真实字数门禁、checkpoint 恢复、成本统计；而作品以普通文件的形式完整留在用户自己的文件夹里（[E11]）。
- 最强威胁：NovelCrafter（BYOK + 世界构建，商业成熟度高，[E8]）；AI-Novel-Writing-Assistant（同为 Windows 桌面、新手向，[E10]）；novel-bot（文件即记忆的理念相似，[E1]）。

## Current Product Baseline

已落地能力（来源：项目 README、package.json、src/ 代码结构，[E11]）：

- Electron 桌面壳 + Codex 风格三栏界面，Windows 目录包与 NSIS 安装器。
- 章节状态机：规划 → 起草 → 审稿 → 修订 → 定稿 → 摘要。
- **真实字数统计门禁**：不信模型自报字数，字数不足触发补写。
- **工具调用写入**：模型必须通过工具调用交付章节，不能以聊天正文交付。
- checkpoint 断点恢复；成本与缓存报告（token、调用、成本估算、provider 缓存字段）。
- 本地项目文件夹持久化：章节正文写入 Markdown/TXT；空文件夹可在桌面端初始化为新项目。
- 受控网页搜索/抓取：默认禁网，来源快照标记为"不可信资料"。
- 技能运行时（manifest / hook / 启用 / 禁用 / 导入）+ 内置悬念结尾技能。
- OpenAI-compatible provider 适配层，内置 DeepSeek 与小米 MiMo 预设；API Key 存本机。
- 审查器：只读检查章节文件、checksum、字数、日志、checkpoint。

假设（未验证）："字数门禁 + 工具调用交付"的工程防线在竞品中不存在——需要以竞品公开文档为准，本次调研未发现任何竞品宣传同机制（[E1]-[E10] 均无此描述）。

## Competitor Comparison

| 竞品 | 分类 | 证据 | 借鉴（Lesson） | 不照搬（Do Not Copy） |
|---|---|---|---|---|
| novel-bot（GitHub 开源） | direct | [E1] | 文件即记忆：SOUL.md / WORLD.md 作为可编辑 Markdown，用户可读可改 | CLI 形态；单一模型链，无 GUI 工作台 |
| Novel-OS（GitHub 开源） | direct | [E2] | 确定性连续性引擎 + 多角色审校流水线；MIT 许可 | 5 角色重多智能体架构对普通作者过重 |
| SAGA（GitHub 开源） | direct | [E3] | 本地优先 + 知识图谱 + 矛盾检测循环，理念接近 | 依赖 Neo4j/LangGraph 重型栈；未生产就绪 |
| NovelClaw（GitHub 开源） | adjacent | [E4] | 可检查的工作区：运行日志、进度痕迹、可观察输出 | 动态记忆银行系统复杂度高 |
| Openwrite（GitHub 开源，中文） | direct | [E5] | 事务化提交安全、单数据源、层级大纲 | CLI；37 维审核对小白过重 |
| novel-architect（GitHub 开源，中文网文） | adjacent | [E6] | 确定性 state guard + 文学判断结合；实战打磨（140 章） | 纯 skill 形态，无独立应用 |
| AI-Novel-Writing-Assistant（开源，Windows 桌面） | direct | [E10] | 新手向全流程（灵感→完本）的桌面产品化思路 | 全自动代写定位，作者掌控感弱 |
| Sudowrite（商业） | baseline | [E7] | Story Bible 概念 = 长期记忆的产品化样板 | 云端订阅 + 专有模型锁死 + 内容审查 |
| NovelCrafter（商业） | direct | [E8] | BYOK 模式 = 自带模型按量付费、模型自由 | 数据托管云端；Codex 世界构建学习曲线陡 |
| NovelAI（商业） | baseline | [E9] | 隐私承诺 + 无审查定位是明确卖点 | 自研模型、偏引导式生成、长结构弱 |

## Cross-Market Patterns

**Table stakes（标配，不做差异化宣传）**：多章节记忆/连贯性、质量审校门禁、章节流水线、多模型支持（OpenAI-compatible）、断点/checkpoint。

**Recognizable differentiators（WWriting 独有或领先）**：
- 文件即项目：作品 = 本地文件夹里的 Markdown/TXT，任何编辑器可打开（[E11]；对比 [E7][E8] 云端托管、[E3][E5] CLI 要求自建环境）。
- 真实字数校验门禁：以文件实际字数为准，模型自报不作数，不足强制补写（[E11]；竞品无一宣传此机制，[E1]-[E10]）。
- 工具调用写入防线：模型只能通过工具调用交付章节，从机制上防止"聊天糊弄"（[E11]）。
- 桌面 GUI + 零环境配置 + Windows 一键安装（[E11]；开源竞品多为 CLI，[E3][E5]）。
- 默认禁网 + 来源快照标"不可信"：防资料幻觉的务实做法（[E11]）。

**Adoption-blocking gaps（WWriting 当前短板）**：
- 生态：无故事圣经/人物卡的成型管理（NovelCrafter Codex、Sudowrite Story Bible 领先，[E7][E8]）。
- 平台：仅 Windows 桌面，无网页版（对比商业三强跨平台，[E7][E8][E9]）。
- 社区：尚无用户反馈闭环与模板市场（对比 novel-architect 有 140 章实战背书，[E6]）。

**Non-goals（明确不做）**：不做云托管写作；不做自研模型；不做"一键全自动完本"的代写定位；不做内容审查（由用户选择的模型政策决定）。

## Prioritized Roadmap

### P0
推荐：以"本地优先 + 可验证交付"为 README 与产品第一句定位，并把"字数门禁 + 工具调用写入 + checkpoint"打包成可见的"交付保障"叙事（[E11]，对比 [E7][E8][E9] 云端托管、[E1][E3] CLI）。
接受信号：README 首页 5 秒内能说出"数据在本地、交付可验证"两个差异点；竞品对照表出现在 README。

### P1
推荐：补齐故事圣经（角色/设定/伏笔）的可编辑视图，落盘为项目内 Markdown 文件，保持文件即项目原则（[E7][E8] 的世界构建被反复提及，[E11] 有 memory/ 目录基础）。
接受信号：用户能在界面中维护角色卡并在起草阶段自动注入；重启后数据仍在该项目文件夹中可被外部编辑器打开。

### P2
推荐：技能生态与模板市场（续写/风格/悬念钩子等技能包一键导入，[E11] 已有技能运行时；参照 [E6] 实战打磨路径）。
接受信号：任意用户可把自建技能导出为一个可分享的 zip，另一用户导入后无需改代码即可使用。

## Research Limits and Next Validation

- 商业平台价格为 2026 年中第三方数据，多家来源互相冲突（Sudowrite 出现 $10 与 $19/$29/$59 两种口径），以官网为准；本报告不引用具体价格做对比结论。
- 所有"竞品无字数门禁/无工具交付防线"的声明是基于公开文档的推断（inference），未逐一实测；建议对 top 3 威胁（NovelCrafter、AI-Novel-Writing-Assistant、novel-bot）做一次实操对比后升级为 fact。
- 未评估的维度：商业化路径、社区运营、跨平台支持成本。
