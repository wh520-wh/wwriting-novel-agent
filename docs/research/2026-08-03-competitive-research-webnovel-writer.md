# Competitive Research: webnovel-writer（lingfengQAQ/webnovel-writer）对 WWriting 的参考价值与权威性判定

- **日期**：2026-08-03
- **模式**：Rapid（单一目标仓库深挖 + 权威性判定；1 个 direct 竞品，全部一手来源）
- **决策**：lingfengQAQ/webnovel-writer 是**社区认可度高、工程纪律强的中文网文 AI 写作头部开源参考仓库，但不是"权威标准"**。它的机制设计（事实入账、伏笔闭环、节奏管理、作者报告）值得 WWriting 系统性借鉴；它的代码不可复制（GPL-3.0 传染 + 语言栈/形态差异）。本报告的产出物是：9 条可复用优化建议（P0×2 / P1×3 / P2×4），每条带证据和验收信号。

## Scope and Evidence Limits

- 目标仓库证据全部来自 GitHub 一手来源：仓库元数据、README、架构文档、3 个 Agent 定义、长期记忆架构文档、CHANGELOG、提交历史、目录树、官方 Discussions（[E1]-[E12]）。
- 本地基线来自 WWriting README 与上一轮竞品调研报告（[E13][E14]）。
- 未读取目标仓库的 Python 实现源码（仅文档 + Agent 提示词 + 提交记录），机制级结论可靠，代码级细节未验证；未实测运行。
- 未抓取 v7 RFC 讨论全文（仅确认其存在与标题）；未逐一核对 README 中"200 万字量级"等宣传口径。

## Executive Conclusion

**权威性判定（分层）**：

| 维度 | 判定 | 证据 |
|---|---|---|
| 社区认可度 | **高**：6,277 stars / 1,080 forks / 31 open issues，Trendshift 上榜（badge 见其 README），v7 RFC 公开征集意见且有真实用户反馈帖（"伏笔和钩子强度有问题"） | [E1][E2][E12] |
| 工程严谨度 | **高**：版本化发布（v5.3 → v6.2.1）、CHANGELOG 分"作者视角/维护者视角"、774 个 pytest + 行为 eval + CI 工作流、Windows 兼容性专项修复（WinError 5 退避重试）、"只写当前代码里真实存在的能力"的文档纪律、自带学术文献调研（STORYTELLER 论文总结） | [E1][E8][E9][E10][E11] |
| 制度权威性 | **低**：单维护者业余项目，Vibe Coding 开发（Claude Code + Gemini CLI + Codex），非机构/官方出品；GPL-3.0 协议自带传染性 | [E15] |

**结论**：它是一个"社区公认的高质量参考实现"，不是"权威标准"。对 WWriting 而言，它的**机制设计**（写前合同 + 写后事实入账 + 投影链、防幻觉三定律、伏笔/钩子闭环、节奏红线、面向作者的最终报告）是目前调研范围内与本项目"可验证交付"哲学最接近、走得最深的竞品，值得系统性借鉴；它的**代码**不能复制（GPL-3.0 传染，且 Python 插件形态与 WWriting 的 Electron 桌面应用完全不同，[E1][E2]）。

**楔子验证**：WWriting 的差异化（本地桌面 GUI + 文件即项目 + 真实字数门禁 + 工具调用交付，[E13][E14]）不受 webnovel-writer 威胁——它形态相反（Claude Code 插件 + CLI + Python 环境要求，[E2]）。但它证明了"长篇一致性机制"在中文网文圈的真实需求与可行路径：**WWriting 的下一程不是再造工具形态，而是把 webnovel-writer 验证过的机制（事实入账、伏笔闭环、节奏管理）移植到"小白也能用的桌面壳"里**。

## Current Product Baseline

WWriting 已交付（[E13]，与 07-31 报告一致 [E14]）：

- 章节状态机（规划→起草→审稿→修订→定稿→摘要）、真实字数门禁、工具调用写入防线、checkpoint 断点恢复。
- 本地项目文件夹持久化（Markdown/TXT）、成本与缓存报告、技能系统（manifest/hook）、受控网页搜索/抓取（默认禁网、来源标"不可信"）。
- OpenAI-compatible 模型适配（DeepSeek/小米 MiMo 预设）、Electron 三栏 GUI、1002 测试 + `verify:local` 验收链。
- 代码层已具备的部分基础（与本次借鉴点的关系）：`continuity-store.mjs`（连续性存储）、`memory-extractor.mjs`（记忆提取）、`reviewer-agent.mjs` + `quality-gates.mjs`（审查/门禁）、`chapter-memory.mjs`（章节记忆）。

WWriting 明确规划中但未交付（[E13]）：故事圣经（角色/设定/**伏笔**管理）、技能生态、更多 provider 预设。

**对比结论**：WWriting 拥有"工程防线"（字数/工具调用/断点），缺的是"**内容防线**"——事实入账、伏笔闭环、节奏管理、文风记忆。这正是 webnovel-writer 最强的部分（[E3][E4][E6][E7]）。

## Competitor Comparison

| 竞品 | 分类 | 证据 | 借鉴（Lesson） | 不照搬（Do Not Copy） |
|---|---|---|---|---|
| webnovel-writer（Claude Code 插件，Python） | direct（同为中文网文 AI 写作，机制最接近） | [E1]-[E12] | ① 写后事实入账：data-agent 提取 accepted_events/state_deltas/entity_deltas，经 CHAPTER_COMMIT 驱动 state/index/summary/memory 投影链，`projection_log.jsonl` 记录哪一路没同步（[E3][E6]）；② 伏笔/钩子闭环：open_loop_created/closed、promise_created/paid_off 事件枚举 + 写前 urgent_loops（≤5 章未回收必须处理）（[E4][E6]）；③ 节奏管理：Strand Weave（主线 60%/感情 20%/世界观 20%）+ 断档红线（Quest 连续 ≤5 章、Fire 断档 ≤10 章）（[E3]）；④ 作者视角报告：四态（已完成/部分完成/需要你处理/未完成）+ 跳过项/自动处理项透明化（[E8]）；⑤ 审查纪律：只报可验证问题、每 issue 带 evidence、severity/blocking 分级、无问题维度显式 pass（[E5]）；⑥ 项目级文风记忆：/webnovel-learn + style_contract，写前注入写后沉淀（[E4][E7]）；⑦ 行为 eval 文化：agents/evals + 测试项目（[E11][E8]）；⑧ 37 题材模板 + 复合题材规则（[E2]）；⑨ 语义检索：embedding + rerank + BM25 回退，无 key 可降级（[E2]）；⑩ 文档纪律：文档只写"当前代码里真实存在"的能力（[E7]） | GPL-3.0 代码传染（[E1]）；Claude Code 插件形态 + Python 环境门槛（[E2]）；事件审计链的完整复杂度对小白作者过重——机制要包进 WWriting 的壳里，只暴露"伏笔清单/节奏提示"；节奏红线做提示不做强制阻断（WWriting 保持写作自由） |

## Cross-Market Patterns

**Table stakes（行业标配，07-31 已确认 [E14]）**：记忆/连贯性、多智能体分工、质量门禁、多模型支持。webnovel-writer 全都有，且是中文网文圈落地最深的一个。

**webnovel-writer 的差异化机制（WWriting 缺、值得补）**：
- 事实入账制：章节不只交付正文，还交付"这章发生了什么"（事件/状态变更/实体变更），作为后续一切的唯一事实源（[E3][E6]）。
- 伏笔/钩子是**一等公民**：有事件枚举、紧急度（0-100）、到期强制处理（[E6][E4]）。
- 节奏可度量：Strand 占比 + 断档红线，把"节奏感"变成可检查的数据（[E3]）。
- 项目级文风记忆：用户可教系统"这本书怎么写更好"（/webnovel-learn），写前自动注入（[E4][E7]）。
- 三层记忆（working/episodic/semantic）+ 压缩与冲突检查（active/outdated/contradicted/tentative）（[E7]）。

**Adoption-blocking gaps（webnovel-writer 自身短板，WWriting 不应复制）**：
- 依赖 Claude Code 生态 + Python 环境，小白门槛高（[E2]）。
- 单维护者 + Vibe Coding，长期维护与路线风险（[E1][E2]）。
- 事件审计链复杂度高，学习/排障成本大（[E3] 的投影链 + 多处日志）。

**Non-goals（WWriting 明确不做）**：
- 不复制 GPL-3.0 代码，只借鉴机制（[E1]）。
- 不做 Claude Code 插件形态，保持独立桌面应用（[E13]）。
- 不做强制性的节奏阻断（WWriting 的定位是工程保障而非写作审判官）。
- 不把事件审计链全量搬进产品可见层；机制包在壳里，用户只看"伏笔清单/一致性警告"。

## Prioritized Roadmap

### P0

**R1：写后事实入账（"这章发生了什么"结构化事件）**
把 webnovel-writer 的 data-agent 机制（[E3][E6]）以最小形态落到 WWriting：每章定稿后，从正文提取结构化事件（事件类型枚举简化版：伏笔埋设/回收、承诺建立/兑现、角色状态变化、力量突破、关系变化、世界规则揭示），写入项目 `memory/` 下的事件文件，供后续章节上下文注入和审查使用。本地已有 `memory-extractor.mjs` 与 `chapter-memory.mjs` 可作落点（[E13]）。
- 证据：[E3][E6]
- 验收信号：写完一章后项目 `memory/` 出现结构化事件文件；下一章起草上下文自动注入上章未回收的伏笔与关键状态。

**R2：审查器输出纪律化（evidence 必填 + 逐维结论）**
本地 `reviewer-agent.mjs`/`quality-gates.mjs` 的审查输出升级为 webnovel-writer 的规范（[E5]）：每条 issue 必须带正文引用 evidence；severity（critical/high/medium/low）+ blocking 分级；审查维度固定为可验证维度（设定一致性/时间线/叙事连贯/角色一致性/逻辑），无问题维度也必须显式输出 pass。
- 证据：[E5]
- 验收信号：审查报告每条 issue 含 evidence 字段；无问题维度显示 pass；blocking 仅用于可确认的事实矛盾。

### P1

**R3：伏笔/悬念闭环**
在 R1 事件流之上建立伏笔登记与到期提醒：伏笔带紧急度（0-100）与埋设章号，起草前注入"urgent loops"（剩余 ≤5 章或超期的必须处理，可选伏笔 ≤5 条）（[E4][E6]）。
- 证据：[E4][E6]
- 验收信号：项目视图/资料区可查伏笔清单与到期状态；写章任务书自动列出未回收伏笔及紧急度。

**R4：节奏管理（三线占比 + 断档提醒）**
按 Strand Weave 简化版（[E3]）在项目视图展示最近 N 章的三线（主线/感情线/世界观线）占比与断档提示（如"感情线已 8 章未推进"），提示不阻断。
- 证据：[E3]
- 验收信号：项目视图显示三线占比图表；断档超过红线时出现非阻断性提示。

**R5：项目级文风记忆**
用户可在设置/技能层记录"这本书的文风偏好/写法经验"，写前自动注入起草上下文，写后可沉淀（对应 /webnovel-learn + style_contract，[E4][E7]）。
- 证据：[E4][E7]
- 验收信号：设置里可新增一条文风偏好；起草任务书自动包含该偏好；偏好存项目文件夹可被外部编辑。

### P2

**R6：题材模板库**
新建项目时可选题材（对照 37 题材 + 复合题材规则，[E2]），初始化大纲与设定骨架带题材规则。
- 证据：[E2]
- 验收信号：新建项目弹窗可选 ≥10 个题材模板；选题后初始化的大纲/设定包含该题材的规则条目。

**R7：项目内语义检索（可选，默认关闭）**
资料区支持对项目文件夹做 embedding 语义检索，未配置 embedding key 时自动回退 BM25 关键词（[E2]），延续 WWriting"默认禁网、可控启用"的隐私原则（[E13]）。
- 证据：[E2]
- 验收信号：配置 key 后资料区可语义检索；未配置时关键词检索可用且界面说明降级原因。

**R8：写章链路行为 eval**
仿 agents/evals（测试项目 + 断言，[E11]），把写章链路的关键断点（上下文注入、事实入账、审查阻断、断点续跑）做成可自动运行的评估，纳入 `npm run verify` 体系（[E13]）。
- 证据：[E8][E11]
- 验收信号：新增 `verify:writing-eval` 且通过；评估覆盖写章链路 ≥4 个关键断点。

**R9：面向作者的最终报告四态升级**
写章/审查结束的故障卡升级为四态（已完成/部分完成/需要你处理/未完成）+ 三段式（产物与完成情况、遇到的问题、下一步建议），并透明列出"系统自动处理过的事"（[E8]）。
- 证据：[E8]
- 验收信号：写章结束报告按四态呈现；跳过项与自动处理项可见；用户无需读日志即可判断下一步。

## Research Limits and Next Validation

- **未读 Python 实现源码**：机制结论基于文档 + Agent 提示词 + 提交记录（一手但非代码级）；若采纳 R1-R5，建议再按需读对应模块源码（`scripts/data_modules/memory/`、`chapter_commit`、projection writers）做实现级对齐。
- **审查口径不一致**：overview.md 称"六维审查"（[E3]），reviewer.md 实际只查 5 维（[E5]）——本报告按 reviewer.md（可验证维度）记录，落地时以本地需求为准。
- **v7 RFC 全文未抓取**：仅确认存在与标题（[E12]）；v7 涉及架构重写与 story repo spec，建议在启动大改前跟踪其公示结论。
- **宣传口径未验证**："200 万字量级连载"、Trendshift 上榜均为其 README 声明（[E2]），未独立核实。
- **未实测运行**：本报告全部为桌面调研（文档/元数据/代码结构），不构成安装、基准测试或生产验证。高投入方向（R1/R3）建议先在测试项目上做一次端到端试跑再定实现方案。
- **时效**：数据截至 2026-08-03；该仓库更新活跃（2026-08-02 仍有推送），下次复用本报告前应先核对版本与 v7 进展。

## Reference 复用清单（给后续会话直接用）

以下条目把本报告结论折叠成"下一步可直接执行"的引用，避免重复调研：

1. **目标仓库地址**：https://github.com/lingfengQAQ/webnovel-writer （GPL-3.0，Python，Claude Code 插件；6.2.1，v7 RFC 公示中）
2. **权威性判定速查**：社区认可高（6.3k stars/Trendshift）、工程严谨高（774 tests/行为 eval/版本纪律）、制度权威低（单维护者 Vibe Coding）→ 参考机制不抄代码
3. **机制借鉴清单**：R1 事实入账（data-agent event 枚举见其 `agents/data-agent.md` §7）→ R2 审查纪律（`agents/reviewer.md`）→ R3 伏笔闭环（context-agent 的 urgent_loops 规则）→ R4 节奏红线（`docs/architecture/overview.md` Strand Weave）→ R5 文风记忆（`docs/memory/long-term-memory-architecture-v2.md`）
4. **落地落点**：本地 `src/core/memory-extractor.mjs`、`chapter-memory.mjs`、`continuity-store.mjs`、`reviewer-agent.mjs`、`quality-gates.mjs` 是 R1/R2/R3 的天然挂载点
5. **对应本地文档**：上一轮行业定位见 `docs/research/2026-07-31-competitive-research.md`（"故事圣经"P1 缺口与本报告 R3/R4 直接衔接）
6. **下次复用前必做**：核对目标仓库版本（≥6.2.1 时看 CHANGELOG 增量）；若 v7 已定稿，先读其 RFC 结论再启动大改
