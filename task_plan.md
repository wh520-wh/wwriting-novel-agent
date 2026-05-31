# 独立作者长篇小说 Agent 桌面版详细计划

## 目标
打造类似 Codex / Claude Code 的桌面端小说写作 Agent。用户输入一句话、主体大纲或简短设定后，系统长期运行，连续生成几十到上百章，并将每章以 Markdown 文件保存到本地项目目录。

核心不是让模型一次性"记住并完成一部长篇"，而是让应用承担调度、记忆、校验和恢复职责：模型只负责当前小步骤，系统负责把小步骤串成可持续完成的大任务。

## 产品边界
- 面向独立作者，优先单机桌面体验；v1 聚焦章节连续生产，不做完整人物/世界观/地图/关系网编辑器。
- 支持自动连续模式和人工确认模式；支持项目级对话窗（类 Codex），用户可随时补充要求，Agent 按新指令继续跑。
- 支持多云模型可切换（后续可扩展本地模型）；支持导入写作 skill，但 v1 以内置工具和流程为主。

## 技术路线决策
不直接 fork 完整 GitHub Agent，也不完全从零造基础设施。
- 核心 Agent 机制自研：章节状态机、调度器、checkpoint、文件落盘、真实字数统计、补写 hook、skill 写作约束。
- 桌面壳层用成熟技术栈/模板（优先 Electron + React + TypeScript，后续可评估 Tauri）。
- 参考开源项目设计经验（多模型配置、会话 UI、任务日志、durable execution、人机确认），但不绑死在通用 coding agent 业务模型里。
- 原因：本产品核心是长篇章节生产线而非通用代码 Agent；fork coding agent 会继承 Git/diff/终端执行等不相关复杂度；全从零会拖慢验证；自研核心确保完成判断/文件写入/字数门禁/补写完全可控。

### 写作型 Agent 参考方向
优先参考写作/研究写作/长文创作型 Agent，而非 Aider/SWE-agent/OpenHands 代码 Agent：
- STORM / GPT Researcher（研究、资料、带来源长文）、WriteHERE（adaptive planning）、Novel-OS/book-os（长期记忆/设定/连续性）、Libriscribe/StoryCraftr（多阶段创作）、writing-helper（中文文风/Markdown）、LangGraph（长任务状态机/暂停恢复）、CrewAI/AgentScope（多角色原型）。
- 吸收原则：不照搬多 Agent 框架，先把章节生产线/状态机/落盘/字数门禁做稳；对文章类预留资料/来源/事实核查/审稿 artifact；对小说类强化文风/章节计划/连续性/伏笔/本地章节文件。

## 模型配置与缓存适配原则
本项目不是"多模型自动分工系统"。DeepSeek/Grok/MiMo 等都是同一写作 Agent 的可配置模型后端。
- 默认只有一个 `active writing model` 跑完整流程；不允许写死"Grok 审稿、DeepSeek 写作"这类阶段绑定。
- 高级用户可配 `stage_overrides`，但默认关闭；写作流程统一调用 `ModelClient`，不直接依赖具体 provider。
- Provider Adapter 负责各自 API、缓存、usage、成本和错误归一化。

```yaml
active_model:
  provider: deepseek
  model_name: deepseek-chat
  base_url: https://api.deepseek.com
  api_key_env: DEEPSEEK_API_KEY
  cache_mode: prefix
  max_context_tokens: 128000
  max_output_tokens: 8000
stage_overrides:
  outline: { enabled: false, provider: grok, model_name: grok-4-fast }
```

### Provider Adapter 与 UsageReport
真实接入时新增：`ModelClient`（唯一调用入口）、`OpenAICompatibleAdapter`、`DeepSeekAdapter`（prefix cache usage）、`GrokAdapter`（`x-grok-conv-id`/`prompt_cache_key`）、`MiMoAdapter`（大上下文/cache read-write/context tier）。统一响应归一化为 `text/raw/usage/cost`。
- `UsageReport` 至少含：provider/model、input/output/totalTokens、cached/cacheHit/cacheRead/cacheWriteTokens、reasoningTokens、cacheMetricsAvailable、cacheHitRate、rawUsage。
- provider 或中转 API 未返回缓存字段时必须记 `cacheMetricsAvailable: false`，不能伪造缓存命中率。

### Prompt Compiler 与缓存友好上下文
必须实现统一 `PromptCompiler`，不让各功能自己拼 prompt。标准顺序：
```text
[Stable] system_rules / goal / audience / style / source_summaries(project_memory) / outline(chapter_plan)
[Dynamic] current_task / selected_draft_fragment / latest_user_feedback / recent_trace_summary
```
- 稳定内容永远在前，动态内容永远在后；时间戳/随机 ID/最近日志/临时工具结果不能插在稳定前缀前。
- Prompt block 计算 hash，checkpoint 记 block hash 和 template version；`CacheKeyManager` 只在稳定块变化时提升 cache version；动态块变化不破坏稳定前缀缓存。

### 成本与缓存报告
每次模型调用都写成本与缓存事件。项目级 artifact：`cost.json`（总调用次数、输入/输出/缓存 token、估算成本，按 provider 和 stage 聚合）、`cache_report.json`（缓存模式、cache key、hit rate、是否拿到 provider 原生缓存字段）。UI 至少显示当前 provider/model、本轮与总成本、输入/输出 tokens、缓存命中 tokens 与命中率、是否返回可用缓存统计。

## 长跑 Agent 成熟化原则
难点不是模型回复，而是受控地让模型在真实本地环境循环：观察、决策、执行、验证、恢复。必须长期坚持：
- Goal 先行（启动前明确目标/范围/完成标准/停止条件）；最小权限（默认只读或受限写，联网/删除/装依赖/任意 shell 单独授权）。
- 工具可审计（所有调用有事件日志/输入摘要/输出/错误/耗时/关联 checkpoint）；状态可恢复（不依赖聊天上下文，状态/进度/工具结果/文件校验写本地）。
- 上下文分层（系统规则/目标/工作记忆/项目记忆/工具结果/长期摘要，旧历史定期压缩）；明确停止（连续同类失败/预算耗尽/需密钥或生产账号/越权/危险操作 → 暂停或 blocked）。
- 测试真实（不接受口头声称完成，须用文件/日志/checkpoint/测试证明）；执行与审查分离（成熟版加只读 Reviewer Agent，审查越权/伪完成/跳测试/上下文污染）。

### Goal Contract
每个项目运行前生成可持久化 goal contract，作为调度器、权限系统、UI 和 Reviewer 的共同判断依据：
```yaml
goal: "从一句话设定连续生成 100 章长篇小说"
scope: { allow_write: [drafts/**, chapters/**, memory/**, checkpoints/**], deny_write: [.env, secrets/**, outside_project_root] }
acceptance: ["每章正文必须落盘", "每章有效字数达标", "章节完成必须通过本地质量门禁"]
stop_conditions: ["连续 3 次同类模型输出错误", "预算或最大调用次数耗尽", "需要用户密钥、联网或危险操作"]
```

## 第一版最小可运行闭环
先证明"模型能被系统驱动着连续完成任务"，不先追求完整产品。
- 目标：新建项目输入一句话设定 → 设目标 3 章、单章最低 3000 有效字 → 自动创建章节队列 → Agent 工具写入 `drafts/001.draft.md`、本地统计字数、不足自动补写 → 过质量门禁写入 `chapters/001.md` → 继续下一章 → 第 2 章中途关闭应用、重启从 checkpoint 续 → 最终 3 个章节文件，UI 显示完成状态/总字数/日志/重试。
- 暂缓：完整人物/世界观编辑器、多人协作、Skill 市场、高级排版导出、复杂浏览器自动化。

## 模块边界
按以下模块拆分，避免 UI、模型调用、文件写入和状态机互相缠绕：
- `app-shell`（桌面窗口/导航/项目列表/设置页）、`project-store`（项目目录读写/schema 校验/迁移/索引重建）、`agent-engine`（状态机/调度器/任务队列/预算/恢复）、`model-gateway`（多供应商适配/重试/流式解析/工具调用解析）、`tool-runtime`（文件/网页/项目工具/权限检查/结果回传）、`skill-runtime`（manifest 解析/hook 匹配/priority 排序/quality gate 合并）、`context-scheduler`（上下文包构建/摘要读取/最近片段选择/token 预算）、`quality-gates`（字数统计/完整性/输出通道/悬念检查）、`ui-events`（运行事件推送前端）。
- 关键原则：UI 不直接推进章节状态只发 start/pause/resume/confirm 命令；模型不直接写文件只请求工具调用；工具不直接决定章节完成只返回事实；状态机是唯一能把章节推进到 completed 的模块。
- 桌面应用层面板：项目列表、项目对话窗（每项目独立 Agent 会话，章节正文不经聊天交付）、章节面板、运行面板、日志面板、Skill 面板、模型面板。

## 持久化层
每个小说项目本质是本地文件夹，应用在其上提供 Agent 能力。项目文件夹是最终事实来源；SQLite 仅作 UI 索引/任务队列/查询缓存，且必须能从文件夹重建。
```text
NovelProject/
  project.yaml  agent_state.json  run_log.jsonl  goal.md  audience.md  style.md
  sources.md  source_summaries.md  outline.md  cost.json  cache_report.json
  prompts/{planning,drafting,reviewing}.v1.md
  chapters/001.md ...   drafts/004.{planning,draft,review}.md
  memory/{book_summary,arc_summary,continuity,characters,world}.md
  memory/{active_state,chapter_index,open_threads}.json
  skills/suspense-chapter-end/skill.yaml   checkpoints/checkpoint-000123.json
```
- 所有重要状态落盘不依赖聊天上下文；每次模型调用前后写 checkpoint；章节正文先写 drafts 通过校验再移到 chapters；日志用 jsonl 便于增量追加和故障追踪；prompt 模板版本化并在 checkpoint 记 version+hash；项目 schema 有版本号，升级走迁移脚本。
- artifact 原则：`goal.md`/`audience.md`/`style.md` 定义目标/读者/文风；`sources.md`+`source_summaries.md` 用于资料（小说可空）；`outline.md` 先过审再进正文；`drafts/`+`review.md`+`revision_log.md` 分离初稿/审稿/修改；`continuity.md`/`characters.md`/`world.md` 用于连续性（v1 预留）。

## 章节正文输出通道
章节正文必须经工具写入本地文件，不能经 AI 聊天回复作为最终产物。
- AI 生成章节须调用文件写入工具（`write_chapter_draft`/`append_chapter_segment`/`finalize_chapter_file`）；聊天只显示状态/摘要/字数/检查结果/错误/确认问题。
- 正式章节默认本地 Markdown（也允许 TXT）；所有内容先写 `drafts/` 通过本地检查再移/复制到 `chapters/`；写文件工具返回实际路径/写入字节/有效字数/校验结果。
- `write_chapter_draft` 契约：input `project_id/chapter_no/format(md|txt)/mode(overwrite|append)/content`，output `path/bytes_written/actual_words/checksum/ok`。模型只在聊天输出正文而未调用写入工具，本轮视为失败，触发格式修复或重新要求工具写入。

## 模型工具调用协议
模型只能向运行层提交工具调用请求，由应用执行。输出须解析为三类之一：`tool_call`（请求调用工具）、`status_message`（短状态，不含完整正文）、`ask_user`（请求确认/补充）。生成章节正文时合法输出只能是 `tool_call`；出现大段正文但无工具调用判定为 `invalid_output_channel`，要求重新以工具调用写入。
```json
{"type":"tool_call","id":"call_000123","tool":"append_chapter_segment","input":{"project_id":"...","chapter_no":1,"segment_no":3,"content":"..."}}
{"type":"tool_result","call_id":"call_000123","ok":true,"path":"drafts/001.draft.md","actual_words":1840,"checksum":"sha256:..."}
```

## 文件一致性和原子写入
- 所有写入限制在项目根目录内，禁止相对路径跳出；写正式章节用临时文件 + 原子重命名；每次写入记 checksum/字节数/有效字数/工具调用 ID；追加段落记 segment_no 防重启重复追加；状态机推进前重新读取文件校验存在；`agent_state.json` 与文件系统冲突时以文件校验 + 最近 checkpoint 共同修复。
- 推荐顺序：write temp → fsync → rename temp→target → verify exists → count words → write checkpoint → advance state。

## 保障模型连续完成任务的核心机制

### 1. 大任务拆成可恢复的小任务
不要求模型"一口气写完整本书"，把目标拆成稳定任务单元：项目目标 → 章节计划队列 → 单章任务（章节规划 → 草稿 → 自检审查 → 修改补足 → 最终落盘 → 更新记忆 → 创建下一章）。每步有明确输入/输出/状态/验收，模型失败时只重跑当前小步骤，不重跑整章或整本书。
- 单章也分段生成：每章拆成 3-8 个 scene/segment 逐段 append 到草稿，本地统计字数后再生成下一段，达最低字数后进 review。每个 segment 有 segment_no、本段目标、建议字数、承接上段的最后 300-800 字、禁止重复提示、写入后的 checksum 和有效字数。绕开单次输出长度限制，中断时只重试当前 segment。

### 2. 任务状态机
每章走状态机，不靠模型"自觉继续"：
```text
queued → planning → planned → drafting → drafted → reviewing
→ needs_revision → revising → finalizing → summarizing → completed
（任意阶段可进入 paused / blocked / failed_retryable / failed_terminal）
```
转换要点：reviewing→needs_revision（字数不足/结尾无钩子/风格偏移/连续性问题）；needs_revision→revising（只修问题段或补缺）；reviewing→finalizing（通过）；finalizing→summarizing→completed（写正式章节并更新记忆）。应用关闭/超时/中断后重启从最后状态继续。

### 3. Checkpoint 和断点续跑
每次关键动作生成 checkpoint：调用模型前（输入上下文/任务 ID/章节号/阶段/模型配置）、返回后（原始输出/解析结果/错误）、写文件前（目标路径/草稿路径/预期字数）、状态转换后（旧→新状态/原因）。恢复判断：正式章节已存在且通过校验→completed；draft 存在但 review 未完成→从 reviewing 继续；输出存在但解析失败→从 parsing/reviewing 继续不重新生成；超时无输出→按 retry policy 重试当前阶段；连续失败超阈值→blocked 等用户处理或切模型。

### 4. 调度器负责"继续"
持续运行由调度器保证（while project.status==running：load state → find next task → build context → run skill hooks → call model → parse/validate → execute file tools → verify file+word count → write checkpoint → update state → decide next）。模型每次只收到"当前阶段要完成什么"，不需要知道跑了多久或在回复末尾说"我将继续"。

### 5. 上下文包 Context Package
每次调用前由 context scheduler 组装：固定层（项目设定/风格/启用 skill 指令/禁止事项和硬格式）、结构化记忆层（全书摘要/当前弧摘要/已完成章节索引/活跃角色状态/未收束伏笔）、最近上下文层（当前章已有内容/最近一章全文/相关历史片段）、当前任务层（章节号/本章目标/字数/节奏/结尾钩子/格式要求）、运行层（当前阶段/重试次数/启用工具/允许禁止动作）。用"摘要 + 最近全文 + 相关片段"避免被 token 上限拖死。

### 6. 质量门禁 Quality Gates
每章完成前自动检查：字数、完整性（标题/正文/自然结尾）、连续性（不违背前文摘要）、风格（符合指南和启用 skill）、悬念（启用 suspense skill 时最后 500 字须有钩子）、禁止项、文件（Markdown 写入成功/章节号连续）、输出通道（正文由文件工具写入而非聊天）。不通过则生成"修订任务"只修问题不整章重写。

### 7. 真实字数统计和补写 Hook
模型自报字数不可信，所有字数判断由本地统计器完成。默认规则：只统计章节正文（排除标题/frontmatter/注释/日志/审查报告），去除 Markdown 符号后统计可见正文，中文按汉字、英文按单词、数字按连续数字段，标点/空白/换行不计；项目可配但同项目内一致。
- 门禁流程：drafted → 本地统计器读草稿正文 → 对比 min/target → 不足则生成 word_count_shortfall hook → 模型收到实际/目标/缺口字数和补写要求 → 只补写缺口不重写 → 合并后重新统计。hook 必须含实际/目标/缺口字数、不允许虚报、补写位置建议、禁止废话凑字数。只有本地统计确认达标才能从 reviewing 进 finalizing。

```yaml
hook: word-count-gate
status: failed
actual_words: 2380
min_words: 3200
shortfall: 820
instruction: 在不改写全章前提下补写约 900-1100 字，加强中段冲突和结尾前情绪铺垫；不要声称已达字数，系统会重新统计。
```

### 8. 自动重试、模型降级与预算熔断
失败分类处理：网络/API 超时（延迟后重试同阶段）、输出为空（重试并降长度或切模型）、格式错误（追加格式修复提示）、字数不足（补写任务）、风格偏移（局部改写）、连续性冲突（审查修复）、多次失败（切备用模型或 blocked）。默认同阶段最多重试 3 次、第 2 次缩小范围、第 3 次切备用模型或请用户确认，所有失败写 run_log 和 checkpoint。
- 预算/熔断：项目级限制单次运行最大章节数、最大模型调用次数、最大 token/费用、单章最大补写轮数、单阶段最大失败次数；触发后自动暂停、写 blocked 原因、UI 显示卡点和建议、用户可继续/切模型/降要求/接管。

### 9. 人工确认模式
不是单独系统，而是调度器上的暂停点：每章大纲后/草稿后/每 5 章/质量检查失败/上下文摘要大幅变化时暂停。用户确认后章节从原状态继续，不重新开始。

### 10. Skill Hook 机制
Skill 不接管主流程，只在固定阶段注入策略或检查。
```yaml
name: suspense-chapter-end
version: 1.0.0
type: flow-control
enabled: true
priority: 50
scope: chapter
hooks:
  - { stage: planning, action: append_prompt, content: "本章大纲必须含结尾悬念设计..." }
  - { stage: reviewing, action: check, prompt: "检查最后 500 字是否含有效悬念/钩子..." }
params: { ending_window_chars: 500 }
conditions: { chapter_min: 1, chapter_max: null }
```
执行顺序：按 stage 匹配当前阶段 → 按 priority 排序 → `append_prompt` 改 context package、`check` 生成质量门禁结果、`post_process` 只处理草稿不直接覆盖正式章节。

### 11. 内置工具层
- 文件工具（读/写章节草稿/追加段落/写文件/追加/列目录/建目录/搜索/移动草稿到正式章节）、网页工具（搜索/抓取/正文抽取/保存来源快照）、运行工具（任务队列/暂停/恢复/重试/checkpoint/日志）、项目工具（读配置/读章节索引/更新记忆/生成下一章任务）。
- 工具由应用执行，模型只提请求；所有写入类工具记日志，必要时要求用户授权。

## 最小数据结构规格
- `project.yaml`：schema_version、project_id、title、root_path、output_format(md|txt)、target_chapters、min/target_words_per_chapter、run_mode(auto|confirm)、default_writer/reviewer_model、active_model、stage_overrides、cache_config、budget_config、enabled_skills、prompt_template_versions。
- `agent_state.json`：project_status(idle/running/paused/blocked/completed)、current_chapter_no、current_stage、current_segment_no、retry_counts、last_checkpoint_id、pending_user_confirmation、active_budget。
- `chapter_index.json`（每章）：chapter_no、title、status、draft_path、final_path、actual_words、checksum、quality_gate_results、created_at/updated_at。
- `checkpoint`：schema_version、checkpoint_id、timestamp、task_id、chapter_no、stage、segment_no、model_config、prompt_template_versions、context_package_hash、tool_calls、tool_results、state_before/after、error。

## 事件日志和 UI 同步
运行以事件驱动写入 `run_log.jsonl`，UI 通过事件流更新而非猜测文件状态。事件类型含 `project_started/paused`、`chapter_queued`、`stage_started`、`model_call_started/completed`、`tool_call_requested/completed`、`quality_gate_failed`、`revision_requested`、`checkpoint_written`、`chapter_completed`、`project_blocked/completed`，成本相关 `model_usage_recorded`、`cache_report_updated`、`budget_warning/exhausted`。每条至少含 event_id/timestamp/project_id/chapter_no/stage/severity/message/data。UI 只展示摘要，完整正文仍从章节文件打开。

## Prompt 与版本管理
关键提示词作为模板文件管理（planning/drafting/segment continuation/reviewing/revision/summarizing/tool correction），放项目 `prompts/` 或应用默认模板目录；每次调用记模板版本和 hash；改模板不影响已完成 checkpoint 可追溯性；prompt 只能描述任务和约束，不允许绕过工具写入/字数门禁/状态机。
- 版本迁移：`project.yaml`/`agent_state.json`/`chapter_index.json`/checkpoint 都含 schema_version；启动先检查版本，旧版本先备份再迁移，迁移只改元数据不改正文，失败则项目进 read-only 并提示修复。

## 安全和权限边界
- 文件工具默认只读写项目根目录内文件；API Key 用系统安全存储或本地加密，不写项目明文；网页内容一律视为不可信资料只进资料层不作系统指令；Skill 导入前校验 manifest（未知字段保留但不执行），不获任意文件写权限只通过受控 hook 影响提示或门禁；高风险调用可在日志追踪。
- 权限模式（默认最小权限）：`read_only`（只读）、`safe_edit`（只写项目根内 drafts/chapters/memory/checkpoints/日志）、`test_allowed`（本地测试/验证脚本）、`network_allowed`（网页搜索抓取，默认关闭需授权）、`dangerous`（删除/改项目根外/装依赖/任意 shell，须人工确认）。MVP 必须：文件工具限项目根内、写入类全记事件日志和 checksum、删除/联网/任意 shell 不进 MVP 自动能力。
- Tool Hook 生命周期（工程安全层，与写作 skill 分开）：`BeforeToolUse`（检查权限/路径/预算/风险）、`AfterToolUse`（记结果/checksum/字数/耗时/错误）、`BeforeFinalizeChapter`（确认文件存在/字数达标/通道正确）、`BeforeFinish`（确认验收标准和测试证据）。
- 配置分层：`global_config`（全局模型/目录/界面）、`project_config`（章节目标/规则/skill/工具权限）、`local_config`（本机私有覆盖如 key 引用）、`policy_config`（强制安全策略）。判断顺序 policy 最高，其次 project/local/global；任何 prompt/网页/skill 都不能覆盖 policy。

## 自审风险修复清单（接真实模型前优先解决）
- P1 工具调用参数未校验：执行前校验 project_id=当前项目、chapter_no=状态机当前章、segment_no=current+1 或允许重放、content 非空且长度受限；失败写 `tool_call_rejected` 不推进状态；加测试。
- P1 项目 slug 可逃出 workspace：slug 只允许 `[A-Za-z0-9._-]`，禁 `.`/`..`/分隔符，项目根用 workspace 级 safe join 生成；加测试。
- P2 无效输出后未持久化 blocked：连续失败达阈值设 `project_status: blocked`，写 last_error/失败类型/次数/建议 + error checkpoint + `project_blocked` 事件；加测试。
- P3 预算字段未执行：每次调用前检查预算、调用后持久化扣减，支持 `max_model_calls`/`max_revision_rounds_per_chapter`/`max_elapsed_ms`，耗尽进 blocked/paused；加测试。

## 测试策略
- 单元：字数统计器（中英文/数字/Markdown/标题排除）、状态机（合法/非法转换/失败恢复）、文件工具（项目根限制/原子写入/segment 防重）、Skill hook（priority/conditions/结果合并）。
- 集成：mock 正常 3 章落盘、首次输出聊天正文被拒、字数不足触发补写、第 2 章中途退出重启恢复、文件已写但状态未推进时恢复修复。
- 长跑：连续 20 章一致性、随机注入超时/空输出/格式错误/工具失败、验证 segment 不重复追加/正文不留聊天/不跳字数门禁。
- Agent 行为评测（越权/伪造）：写出目录失败、非法 slug 不建目录、错误章节/segment 被拒、聊天正文不算完成、连续无效输出进 blocked 留 checkpoint、字数不足不能口头通过、恢复不重复 segment、预算耗尽暂停、网页/项目文件指令不能绕权限、测试失败不能改测试伪造通过。
- Reviewer Agent（成熟版）：执行 Agent 生成章节更新状态，Reviewer 只读 6 类 artifact 检查越权/落盘/跳门禁/伪完成，默认不改文件只生成报告。

## 实施阶段
- Phase 1 本地项目骨架：桌面壳层（Electron+React+TS）、项目目录结构、`project.yaml`/`agent_state.json`/`run_log.jsonl`、章节文件写入与索引、mock model 与最小测试框架。
- Phase 2 状态机与调度器：章节任务队列、状态机、checkpoint、暂停/恢复/断点续跑、失败分类与重试、预算限制/熔断/blocked 恢复提示。
- Phase 3 模型调用与上下文调度：多云模型配置、工具调用协议与 tool_result 回传、active model 与 stage_overrides（默认 active）、ModelClient/ProviderAdapter/UsageReport/CostTracker/CacheKeyManager、context package、PromptCompiler、各上下文层、输出解析与格式修复。
- Phase 4 章节生成流水线：planning/drafting/reviewing/revising/finalizing/summarizing、segment 逐段生成追加、正文经工具写入 MD/TXT 草稿和正式章节、真实字数统计与补写 hook、完整性/悬念检查、自动创建下一章。
- Phase 5 Skill 系统：manifest 读取、启用/禁用/项目绑定、planning/reviewing/post-process hook、内置 suspense-chapter-end。
- Phase 6 网页和文件工具：搜索/抓取/正文抽取、本地文件工具、来源快照、日志记录。
- Phase 7 可视化与稳定性：项目总览、章节流水线、连续性监控、错误恢复 UI、长跑压测、mock/恢复/长跑测试。

## 验收标准
输入一句话/大纲后自动创建队列连续写作；连续 ≥20 章时章节号/文件/状态/日志一致；每章正文实际存在于本地 drafts/chapters 文件（不只在 AI 回复）；模型未调写入工具而在聊天输出正文则该章不算完成；任意时刻关闭可从最近 checkpoint 恢复；单章失败只重试失败阶段不丢已完成章；字数不足由本地统计器发现并 hook 补写到目标（自报达标不算数）；单章支持分段生成；重复恢复/重试不重复追加 segment；skill 能 planning 追加要求并 reviewing 阻止不合格章；网页结果作资料进当前任务不污染全局系统提示；自动和人工确认模式都能推进；进度 UI 准确显示状态/完成数/告警/失败原因；切换 provider 时流程不依赖具体模型名；默认不强制分配模型给不同阶段；PromptCompiler 保证稳定前缀并记 block hash；每次真实请求记 token/成本/缓存字段，provider 不返回缓存字段时不伪造。

## 关键假设
v1 不追求一次生成整本书而是长期稳定推进；自研核心 + 复用桌面骨架；章节是最小业务交付单位、阶段是最小恢复单位；所有关键记忆落盘、聊天只作临时交互；正文交付通道是文件工具不是聊天；模型可失败/跑偏/中断故须校验/修订/恢复；模型可能虚构字数故须本地实际统计强制门禁；Skill 是策略扩展不是工具执行环境；v1 必须有 mock model 和恢复测试；默认最小权限、越权/联网/删除/危险 shell 须显式授权；模型后端是配置项不是 Agent 角色、active model 是默认执行模型、stage override 只是高级选项。

## 实现记录（按会话）
> 下列为逐会话落地记录。早期各会话原有「历史未完成列表」均已被后续记录关闭，此处只保留最终结论。

### 2026-05-29 Phase 2/3 核心加固
- Phase 2 风险修复落地：slug 越界防护、工具调用参数校验、连续无效输出 blocked 持久化、预算扣减与熔断，均实现并测试。
- Phase 3 模型网关基础层 mock 版：`ModelClient`、`MockProviderAdapter`、`OpenAICompatibleAdapter` skeleton、`PromptCompiler`、`UsageReport`、`CostTracker`、`CacheKeyManager`。
- 固化策略：默认所有阶段用 active_model（stage_overrides 默认关，仅 `enabled:true` 覆盖）；PromptCompiler 稳定块在前/动态块在后，CacheKeyManager 只因稳定块 hash 变化升级 cache version；provider 无缓存字段时 UsageReport 记 `cacheMetricsAvailable:false`/`cacheHitRate:null` 不伪造。
- 验证：`npm test` 19 项；`verify:mvp` 通过（3 章生成/中断恢复/3000 字门槛）。

### 2026-05-29 模型网关接入引擎 + 20 章长跑
- mock ModelClient 接入 agent-engine 实际生成路径（状态机仍主控，调用经网关/prompt 编译/cache key/usage 归一化/成本统计）；checkpoint 扩展记 context_package_hash/prompt_block_hashes/model_calls/usage_reports/cost_summary/cache_report/cache_key。
- 项目级 `cost.json`/`cache_report.json` 写入；新增 `verify:longrun`（20 章 mock 一致性）；新增 `tool_call_rejected` 审计事件。

### 2026-05-29 GUI 真实数据接入
- 新增 `app-dashboard.mjs`（读 6 类 artifact 生成 dashboard，拒读 workspace 外路径）；`serve-app-shell.mjs` 加 `/api/dashboard`（支持 PROJECT_ROOT）；前端展示项目总览/章节流水线/模型/预算/成本/缓存/checkpoint/事件，正文仍只从章节文件读。
- 新增 `verify:app-shell` GUI 冒烟；修复 Windows 原子写入 rename 遇 `EPERM/EBUSY/EACCES` 重试。

### 2026-05-29 Skill Runtime
- manifest 读取与校验（JSON/YAML，校验 name/version/type/scope/hooks，未知字段保留不执行）；启用与项目绑定（`enabled_skills` 控制，内置 skill 写入项目 `skills/`）；hook priority 排序 + conditions 匹配。
- 三类 hook：`append_prompt`（planning 生成文件并进 prompt stable block `skill_instructions`）、`check`（reviewing 生成质量门禁结果，失败阻止 finalize）、`post_process`（finalize 前只处理 draft）；内置 `suspense-chapter-end`（planning 要求结尾悬念，reviewing 检查末 500 可见字符）。
- 验证：`npm test` 27 项；`verify:mvp`/`verify:longrun`/`verify:app-shell` 通过。

### 2026-05-29 受控网页搜索/抓取工具
- 新增网页工具底层 runtime（`searchWeb`/`fetchWebPage`/正文抽取/来源快照/注入检测/事件日志）；`network_allowed` 默认关（未授权不调 adapter）；新项目建 `sources/`+`sources.md`+`source_summaries.md`，结果只进资料层。
- 注入隔离：外部快照带 `untrusted:true` + data-only policy，正文抽取剥离 active content 并记注入警告；抓取只允许 http/https 拒 `file://`。受控 adapter 架构，真实联网需授权接入。
- 验证：`npm test` 32 项；`verify:mvp`/`verify:longrun`/`verify:app-shell` 通过。

### 2026-05-29 配置分层
- 新增 `config-runtime.mjs`（global/project/local/policy 归一化合并）；legacy 字段（network_allowed/safe_edit/read_only/dangerous/test_allowed/max_model_calls）归一到 tool_permissions 或 budget_config。
- policy 最高优先级：`forbid_network` 强制禁用 network_allowed、`read_only` 强制关 safe_edit、`forbid_dangerous` 强制禁危险权限；接入 agent-engine（生成 effective_config）、ModelClient（从 effective config 选模型，local 可覆盖，阶段覆盖须 enabled:true）、网页工具（policy 禁网覆盖项目和调用选项且不调 adapter）。
- 验证：`npm test` 38 项；`verify:mvp`/`verify:longrun`/`verify:app-shell` 通过。

### 2026-05-29 Reviewer / 故障压测 / GUI 扩展 / Provider 传输层
- 新增 `reviewer-agent.mjs`（只读审查项目状态/索引/章节文件/字数/checksum/质量门禁/事件/checkpoint，发现伪完成/落盘缺失/字数不足/路径越界/blocked 证据缺失），仅显式 `writeReport` 时写 `review/reviewer_report.json` 不改正文。
- 新增 `verify-fault-injection.mjs` + `verify:faults`（确定性注入错误通道 + 中断恢复 + Reviewer 复审）；dashboard 扩展返回 effective config/权限/enabled skill/hook 阶段/来源快照/注入警告数/Reviewer 状态；app shell 加 Skill 管理区和资料工具区；`OpenAICompatibleAdapter` 扩为可测试传输层（base URL/key env/chat completions/错误归一/usage 抽取，mock fetchImpl 验证）。
- 验证：`npm test` 44 项；`verify:mvp`/`verify:longrun`/`verify:faults`/`verify:app-shell` 通过。

### 2026-05-29 Skill 管理操作
- 新增 `listProjectSkills`（列内置+导入 skill 并标记启用）、`importProjectSkill`（复用 manifest 校验）；app shell API `POST /api/skills/{enable,disable,import}` 更新 `enabled_skills`、写日志事件、限路径在 workspace 内；UI 接入启用/禁用。
- 验证：`npm test` 45 项；`verify:app-shell` 通过。

### 2026-05-29 研究 Adapter / 流式 Provider / 桌面壳骨架
- 新增 `research-adapters.mjs`：`DirectFetchAdapter`（真实 HTTP 抓取，受 network_allowed/policy 约束）、`JsonSearchApiAdapter`（通用 JSON 搜索 endpoint/参数名/结果路径映射/key env/错误归一）、`createResearchAdapter`（从 research_config 组合）。
- 研究工具接入 app shell API `POST /api/research/{search,fetch}`（读 effective config、走权限检查、写快照和事件）；资料工具 UI 加搜索/抓取控件；OpenAI-compatible 加 `stream:true` SSE 解析（聚合 token/onToken/usage/cache）；新增 Electron 入口骨架（`electron-main.cjs` 启动本地 server 加载窗口，`electron-preload.cjs` context isolation）+ `verify:desktop-shell` 离线验证。
- 验证：`npm test` 50 项；`verify:app-shell`/`verify:desktop-shell` 通过。

### 2026-05-29 模型/权限/研究配置管理
- 新增 `settings-runtime.mjs`（受控配置补丁更新 active_model/stage_overrides/tool_permissions/budget_config/research_config）；拒绝保存明文 key（只允许 api_key_env/search_api_key_env）；拒绝从标准面板开 dangerous，`read_only=true` 联动关 safe_edit。
- app shell `POST /api/settings/update`（写回 project.yaml + `project_settings_updated` 事件 + 返回 effective config）；模型面板加 provider/model/base URL/key env/max output/max calls/network permission/search endpoint/search key env。
- 验证：`npm test` 53 项；`verify:app-shell` 通过。

### 2026-05-29 Electron 运行时与在线验证入口
- 安装 Electron npm 依赖 + `package-lock.json`（`node_modules/` 仍被 .gitignore）；官方 binary 下载卡住后改镜像源完成；smoke 模式（`WWRITING_ELECTRON_SMOKE=1`）隐藏窗口加载 app shell 输出 JSON 后自动退出。
- 新增并通过 `verify:electron-runtime`；新增在线验证入口 `verify:provider-online`（用户提供 base URL/model/key env）和 `verify:research-online`（用户授权联网验证抓取和可选搜索）。
- 验证：`npm test` 53 项；mvp/longrun/faults/app-shell/desktop-shell/electron-runtime 通过。

### 2026-05-29 Electron 目录包打包
- 安装 `electron-builder` + `package:dir`（Windows dir target 生成 `dist-desktop/win-unpacked`）；Electron 主进程改为进程内启动 `createAppShellServer`（不再 spawn 外部 Node），新增 `app-server.mjs` 集中承载 dashboard/Skill/settings/research API + 静态服务。
- 新增 `verify:packaged-dir`（验证打包 exe smoke 启动加载 dashboard 自动退出）；初次因 winCodeSign 缓存下载卡住，配 `win.signAndEditExecutable=false` 后稳定通过。

### 2026-05-29 本地总验收 + 在线验收 + NSIS 安装器
- 新增 `verify:local` 串行执行所有不需真实 key 的本地验收（test/mvp/longrun/faults/app-shell/desktop-shell/package:dir/verify:packaged-dir），通过，`npm test` 53 项。
- `verify:research-online` 抓取 `https://example.com` 抽取 144 字符（无需 key）；扩展支持搜索 query/limit/结果路径/字段映射后用公开 JSON 接口（hn.algolia.com）验证搜索返回 3 条。
- DeepSeek 在线验收：临时 key 只入进程环境变量、结束清理无残留；`verify:provider-online` 通过，返回 `{"ok":true,"source":"provider-online"}`，usage prompt=20/completion=11/total=31/cached=0。
- NSIS：`build.win.target` 保留 dir+nsis，新增 `package:installer`（`electron-builder --win nsis` 生成 `Setup.exe`）和 `verify:installer`（检查 MZ 文件头 + 体积 >1MB），约 100.9 MB。
- Electron smoke 稳定性修复：Windows 隐藏 BrowserWindow 触发 GPU/cache 初始化失败致 `verify:packaged-dir` 偶发失败；smoke 改为不创建窗口只验证主进程内嵌 server + `/api/dashboard`，加独立临时 userData + `--no-sandbox`/`--disable-gpu` 等开关；正常运行仍创建可见窗口并保留 contextIsolation:true/nodeIntegration:false。
- 最终 `verify:local` 通过（53 测试 + 全链路含 NSIS 构建与产物验证）；删除已吸收的 `shouldread.md`。

### 2026-05-29 Codex 风格 UI 与项目路径打开
- app shell 汉化 + 布局重构（左活动栏/项目列表/中工作区/右设置检查器）；设置端与项目端分离；新增 `GET /api/projects/list`、`POST /api/projects/open`（显式打开可在 workspace 外但须有效 project.yaml，内部文件仍走 safeJoin）；Electron preload `selectProjectFolder()` 系统文件夹选择器，浏览器保留路径输入。
- 验证：`npm test` 54 项；app-shell/desktop-shell/electron-runtime/packaged-dir/installer 通过；重新打包目录包 + NSIS。

### 2026-05-30 完整汉化与最终状态审计
- 残留英文标签替换为中文（Agent/Skill 管理/Provider/Key Env/Token/Checkpoint/Reviewer 等），`verify:app-shell` 加反向断言防回归；四区 Codex 布局、设置端/项目端分离、本地文件夹作项目路径均具证据。
- 桌面交付证据：目录包 exe + NSIS 安装器 + 桌面快捷方式（指向目录包 exe）+ 图标 `src/assets/app-icon.{ico,png}`（打包用 ico）。`verify:local` 通过（54 测试 + 全链路）。当前必须计划项无，剩余为发布增强（签名/自动更新/更多预设/人工 UX 巡检/安装卸载手工验收）。

### 2026-05-30 原生菜单汉化
- 左上角 `File/Edit/View/Window/Exit` 是 Electron 默认原生菜单（非 app shell DOM）；在 `electron-main.cjs` 经 `Menu.buildFromTemplate`+`Menu.setApplicationMenu` 接管为中文（文件/编辑/视图/窗口及子项）；`verify:desktop-shell` 覆盖菜单接管与中文标签防回归。
- 本轮未重新打包（修复进源码和开发运行时，待后续打包写入 exe）；验证 `verify:desktop-shell`/`verify:app-shell`/`verify:electron-runtime` 通过，`npm test` 54 项。

### 2026-05-30 Codex 截图级 UI/UX 与第二仪表盘
- 目标：app shell 升级到截图级信息架构（浅色统一侧边栏/图标+文字导航/项目分组/当前项目圆角高亮/中央圆角工作面/底部命令栏/右侧设置端分离）+ 独立「仪表盘」视图（参考 `D:\AI\deer-flow` 的 dashboard/flow/run/metrics，展示任务流/运行状态/章节流水线/成本缓存/来源快照/审查/技能/长跑健康度，作总览不取代项目端）。子代理策略：只读 explorer 调研，主代理负责设计/集成/验证/打包。
- 已实现：浅色 Codex 左导航/项目列表/中央工作区/底部命令栏/独立设置页/状态检查器/独立第二仪表盘；`POST /api/commands/submit`（命令写入项目事件流，章节正文仍经文件工具）；deer-flow 风格本地化（任务流/成本缓存/来源审查/技能/长跑进度/检查点）。
- Simplify 子代理修复：composer 空操作、无项目/读取失败/局部失败状态混淆、快速刷新旧响应覆盖、窄屏标题挤出、任务流缺 planned/needs_revision、dashboard 预算与设置端不一致、清空搜索/预算不生效、首次 dashboard 自动项目未固化、`max_model_calls` 只改 UI 不改运行时预算。
- 最终代码质量子代理（`019e74d4`）只读复审「代码质量评价：合格」，确认 `max_model_calls` 同步 `agent_state.active_budget` 且 runProject 真实按预算阻断，composer/dashboard 并发刷新（dashboardRequestId）/自动项目固化/可选字段清空/任务流阶段/验证覆盖均无阻塞。
- 验证：`npm test` 58 项；node --check / app-shell / desktop-shell / electron-runtime / packaged-dir / installer 通过；新增 settings-runtime（预算写运行状态+可选字段清空）、agent-engine（设置预算真实阻断）、app-dashboard（读 effective budget）测试。

### 2026-05-30 最终交付（Codex UI + 第二仪表盘）
- 状态：完成。`verify:local` 通过：test 58 + mvp/longrun/faults/app-shell/desktop-shell/electron-runtime/package:dir/packaged-dir/package:installer/installer 全绿。
- 产物：`win-unpacked\WWriting Novel Agent.exe` + `Setup.exe`，桌面快捷方式指向目录包 exe（图标来自 exe 第 0 个资源）。完成核心需求：Codex 浅色 UI/UX、原生菜单汉化、设置端/项目端分离、打开本地文件夹作项目、独立第二仪表盘、底部命令栏受控 API、`max_model_calls` 同步运行时预算并真实阻断、目录包/安装器/快捷方式可用。

### 2026-05-30 项目初始化与设置反馈
- 目标：空文件夹可在 UI 初始化为项目；模型设置保存有明确反馈；基础 URL 下展示实际请求地址。
- 实现：`project-store.createProjectAt(projectRoot, options)`、`app-dashboard.canInitializeProjectRoot()`（只接受不含 project.yaml 的空文件夹）、`POST /api/projects/init`（生成 project.yaml/agent_state.json/memory/chapter_index.json/chapters/drafts）；UI 打开失败显示初始化表单（小说名/大纲/章节数/每章字数）成功后自动打开；设置端独立保存状态（保存中/已保存/错误）；基础 URL 灰字实时展示 `base_url + chat/completions`（mock 提示不需要）。
- 验证：相关 node --check、`node --test project-store+app-dashboard` 7 项、app-shell、`npm test` 59 项、desktop-shell 通过。打包：首次 `verify:local` 在 package:dir 因运行中 exe 锁定 `d3dcompiler_47.dll` 失败，关进程释放锁后 package:dir/packaged-dir/electron-runtime/installer 通过；README + 指南补充。

### 2026-05-30 密钥环境变量误填修复
- 用户把真实 `sk-...` key 填进「密钥环境变量」框致英文报错。UI 改「密钥环境变量名（不是密钥）」+ 示例 `XIAOMI_MIMO_API_KEY`；供应商字段说明 OpenAI 兼容填 `openai-compatible`；前端保存前拦截真实 key/非法变量名/供应商与模型填成同一值；`settings-runtime` 错误改中文；README+指南加小米 Mimo 示例（openai-compatible / mimo-v2-pro / `https://api.xiaomimimo.com/v1` / `XIAOMI_MIMO_API_KEY`）。
- 验证：相关 node --check、`node --test settings-runtime` 4 项、app-shell、`npm test` 59 项、desktop-shell 通过；打包 package:dir/packaged-dir/installer 通过。

### 2026-05-30 Cherry Studio 风格模型预设
- 目标：参考 Cherry Studio 供应商预设，内置 DeepSeek 官方和小米 MiMo 官方，用户只填 API Key。
- 预设：DeepSeek（openai-compatible / `https://api.deepseek.com` / 默认 deepseek-v4-pro，可选 deepseek-v4-flash/deepseek-chat / `DEEPSEEK_API_KEY`）；MiMo（openai-compatible / `https://api.xiaomimimo.com/v1` / 默认 mimo-v2.5-pro，可选 mimo-v2-pro / `XIAOMI_MIMO_API_KEY`）。
- 实现：设置页三个 provider card（DeepSeek/MiMo/自定义）选中自动填充；新增 `API Key` password 框；key 不写 project.yaml，由 `local-secrets.mjs` 存本机应用级 `secrets.json` 并注入进程环境变量；Electron secrets 存 `app.getPath("userData")`，浏览器可经 `WWRITING_SECRETS_ROOT`；`agent-engine` 默认注册 openai-compatible adapter（DeepSeek/MiMo 可走真实 provider）；README+指南改为「前端填 key 存本机 secrets」。
- 验证：相关 node --check、`node --test local-secrets+settings-runtime+provider-adapters` 10 项、app-shell 通过；`npm test` 60 项、desktop-shell/package:dir/packaged-dir/electron-runtime/installer 通过。

### 2026-05-30 命令栏真实启动工作流与运行进度
- 目标：底部命令栏提交后真实启动写作 Agent，前端明显显示工作中/进度条/阶段推进。
- 后端：`POST /api/commands/submit` 启动后台 `runProject()`；项目路径级 `runJobs` 防重复启动；completed/blocked 项目返回明确状态不假报 started；后台异常写回 blocked + `project_blocked/project_run_failed` 事件；命令消息进下次 prompt 动态块 `latest_user_feedback`。
- 前端：`run-activity` 面板（工作流状态/当前阶段/活动进度条/步骤）；活动进度独立于全书完成度（`activityProgressPercent` 表示章内阶段推进，首章运行也可见）；阶段顺序对齐状态机；提交后切运行视图自动轮询 dashboard（完成/阻塞停）。
- 验收要点：fresh idle 项目提交出现 project_run_started/started/finished/chapter_completed 且正文真实写入 `chapters/001.{md,txt}`；completed 项目返回 completed=true/started=false + `project_run_skipped`；provider 失败显示 blocked 不一直工作中；运行中全书 0% 时活动进度条仍可见；命令栏文本出现在后续 compiled prompt。
- 验证：相关 node --check、`node --test agent-engine+app-dashboard` 18 项、app-shell、`npm test` 62 项、desktop-shell/electron-runtime 通过；打包 package:dir/packaged-dir/installer 通过；产物 226,869,248 bytes / `Setup.exe` 101,365,541 bytes。

### 2026-05-30 会话1：UI 高质量化 + 工作流闭环 + UX
- 工作流闭环已验证跑通：空文件夹 init → 命令栏 submit → runProject → 第 1、2 章过字数门禁（2016≥1500）真实写入 `chapters/001.md`、`002.md`。最大 UX 缺口：无法应用内阅读章节。
- 实现章节阅读器（闭合写作闭环）：后端 `readChapterContent()`（读章节索引/定位/`isPathInside` 校验 final/draft 在项目根内/剥离 `# Chapter NNN` 与 `<!-- segment:* -->`/返回干净正文+元数据/草稿正式自动降级）+ `GET /api/chapters/read?chapter=N`（复用 resolveActiveProjectRoot）；前端点击/键盘打开阅读浮层（标题/草稿正式徽标/字数/格式/分段，支持 Esc/遮罩/关闭）。
- UI 逼近 Codex：导航/刷新/设置/提交换内联 SVG 图标；命令栏升级自增长 textarea（Enter 发送/Shift+Enter 换行/高度复位）；右下角 Toast（命令/设置/技能/资料/打开项目成功失败）；聚焦环/hover 抬升/浮层与 Toast 动画。
- 验证：`npm test` 64 项（新增 readChapterContent 干净正文+路径安全单测）；app-shell 通过（章节阅读 API live + 缺失章节 400 + textarea/Toast/SVG/reader DOM/CSS 断言）；闭环 live 验证 `GET /api/chapters/read?chapter=1` 返回 2016 字干净正文无 segment 标记；`verify:local` 11 步全绿，重新打包（exe 约 216 MB / Setup 约 96.7 MB，04:46）。备注：mock 输出占位重复文本（设计如此），配真实 key 后同一闭环产真实正文；本机 /browse 无法启动 headless，改用代码审查 + API live + 单测/集成验证。

### 2026-05-30 会话2：按 Codex 操作逻辑全面重构 UI/UX
- 用 Electron capturePage 截图（`screenshot-app.cjs`）确认问题：metrics + 工作流 chips + 章节网格在所有 tab 永久堆叠；右侧检查器全是开发者指标；8 个导航项多数对作者无意义；无新手引导。
- 整屏重写 index.html/styles.css/app.js：左侧=我的小说（新建主按钮 + 打开本地文件夹 + 最近项目 + 设置入口 + 状态点）；主区=当前小说，顶部分段标签 写作台/章节/运行/设置；移除右侧检查器；新手起始页 hero（一句话设定 + 章节数 + 每章字数 + 保存文件夹 + 开始创作主按钮）；写作台=进度卡 + 实时活动卡 + 动态 feed；运行 tab 集中模型/成本/缓存/令牌/检查点/权限/审查/来源/任务流/技能/资料/事件；14px 基准 + 单一强调色（靛蓝）+ 近黑主按钮 + 动画；create/settings 隐藏命令栏。
- 验证：截图确认五屏整洁；`verify-app-shell.mjs` 重写断言匹配新 IA（含反向断言禁旧拥挤导航与开发者术语）通过；`verify:local` 11 步全绿；重新打包（exe 216.4 MB / Setup 96.7 MB，05:07-05:08）。

### 2026-05-30 会话3：持久会话 + 防窥模式 + 高级感视觉
- 持久会话：新增 `app-state.mjs`（userData 持久化 `app-state.json`：recentProjects 上限 12 + lastProjectRoot，原子写，record/forget/load）；`app-server` 启动未显式指定项目时恢复上次有效小说（校验 project.yaml）；打开/初始化写入 recents；`/api/projects/list` 改返回持久化 recents（合并当前选中、校验存在、标注 external），不再扫描 workspace 噪声项目；Electron 生产端 stateRoot=secretsRoot=userData，重开即恢复。
- 防窥：topbar 隐私开关（眼睛图标），`.app[data-privacy=on]` 对 `.peek`（设定/章节正文/动态事件）加 blur，hover/focus 解模糊，Ctrl/Cmd+. 切换，窗口失焦（data-away）隐私模式下强制加强，localStorage 记忆。高级感：双色径向+线性渐变背景、frosted 顶栏、hero 强调渐变条、品牌标/主按钮/发送键渐变内高光、metric tabular-nums。
- 验证：`npm test` 68 项（新增 app-state 4 项）；app-shell 通过（privacy DOM/CSS/JS、`ww:privacy`、recents ≤12 含已打开项目、重开新进程仅共享 secretsRoot 后 `/api/dashboard` 恢复上次项目）；截图复核；`verify:local` 11 步全绿；重新打包（exe 216.5 MB / Setup 96.8 MB，06:08）。

### 2026-05-30 会话5：Codex 对话式终稿落地真前端 + 重打 exe（进行中）
- 来源：Claude Design 导出 handoff bundle（`claude.ai/design`），最终意图「完全重构 UI 模仿 Codex，左栏项目、右侧对话流」，落点是真应用 `src/app-shell/` 并重打 exe（非根目录孤立 HTML 原型）。用户确认方向＝「把 Codex 设计落进真应用并重打 exe」。effort：ultracode。
- 现状勘探（子代理 af5201ff 已出地图）：真前端是**原生 JS**（app.js 58KB，非 React），DOM 走 `refs`+`querySelector`，渲染靠 renderXXX；已是"半 Codex"（左栏项目 + 写作台/章节/运行/设置四标签页 + 三模式输入框 main/side_question/review）。
- 关键约束：① 后端**无对话/消息端点、无 SSE**，只有 1.8s 轮询 `/api/dashboard`；对话流须前端用 `events[]`（含 `user_instruction_received`）+ `chapters[]` + `summary` 聚合，**后端不动**。② 不破坏核心铁律：旁路询问只读、正文只经文件工具落盘、最小权限。③ 设计是 React 原型，真前端是原生 JS，须复刻视觉/交互而非搬代码。
- 阶段计划：
  - P1 视觉基座：用设计终稿 styles.css 覆盖（894 行 Codex 视觉系统）。【完成】已备份旧三件套到 `_backup-pre-codex-*`。
  - P2 骨架：重写 index.html 为 Codex 结构（.rail/.thread/.composer/.drawer），静态写死、动态留空容器。【进行中】
  - P3 行为层：重写 app.js 表现层（左栏项目/对话流聚合/单输入框+斜杠菜单/右抽屉章节·模型·运行/设置弹窗/阅读器），复用网络层 getJson/postJson、命令解析 parseUserCommand、轮询 ensureRefreshLoop、中文映射、showToast、隐私模式。
  - P4 验证：node --check + `verify:app-shell`（须改断言匹配新 IA）+ `npm test` + `verify:local`。
  - P5 对抗式审计（ultracode）：Workflow 多维评审 → 逐发现反驳验证（隔离铁律不破坏、轮询不泄漏旧响应、斜杠解析前后端一致、无障碍）。
  - P6 重打 exe：`package:installer` + `verify:installer`。
- 验收：五屏（项目流/对话流/抽屉章节·模型·运行/设置/阅读器）视觉对齐设计终稿；提交指令真实启动 runProject 并在对话流逐步显现进度；旁路询问内联同一对话流且不污染主线；exe 重建可用。

### 2026-05-30 会话4：旁路询问（Side Question）+ Agent 状态细化
- 目标：更像企业级正经产品 + 主写作进行中可旁路询问，不打断、不污染主线。铁律：(1) 旁路询问只读上下文回答，绝不改正文/章节/agent_state.json/task_plan.md/progress.md/cost.json/checkpoints，不启动或打断 run；(2) 记录写独立 `side_questions.md`（与 run_log.jsonl 分开）；(3) 含改主线设定诉求时不直接执行，标记「待确认变更」由用户确认后才转正式任务；(4) 命令栏分模式 + 顶栏 Agent 状态细化。
- 实现：`side-question.mjs`（parseUserCommand 按模式 + /ask /side /q /review /write 前缀路由禁用 /btw、detectMainTaskImpact 改写/改设定正则、collectSideQuestionContext 只读收集、handleSideQuestion 在线分析或离线/mock 合成、appendSideQuestionLog、agentPhaseLabel；用一次性 `new CostTracker()` 构造 ModelClient 不污染 cost.json）；`app-server` 加 `POST /api/commands/ask`，submit 加 mode(write/review) 与 fromSideQuestion；前端命令栏三模式 + 实时意图识别 + 状态行、旁路问答面板（临时提问/待确认变更两类，改主线给「加入正式写作任务/仅作参考」）、状态点按 agentPhaseLabel 细化。
- 对抗式审计（Workflow 多维评审 → 逐发现反驳验证）：第一轮三维确认 6 条，独立验证者逐条确认全部 low 级、全不触及核心铁律。已全修（均在 side-question.mjs + 一条前后端漂移）：state 空值兜底 `loadState().then(s=>s??{}).catch(()=>({}))`；前后端漂移守卫（verify-app-shell 直接 import 后端 SIDE_QUESTION_PREFIXES/REVIEW_PREFIXES/WRITE_PREFIXES/MAIN_TASK_IMPACT_PATTERN 与 app.js 源文本逐字比对，不采用跨层共享模块因静态服务器拒 serve .mjs）；合并重复 fs-utils 导入；`context.modelError` 改为真正暴露并写 side_questions.md「模型调用降级」段；`readOptionalText` 死分支折叠；chapter_index 改用 `loadChapterIndex`。
- 第二轮补缺审计完备性复核：核心隔离铁律「结构上稳固、无真实漏洞」，仅测试覆盖缺口。补强：在线模型路径全项目快照不变性测试（除 side_questions.md 外文件 sha256 前后逐字节一致，证 cost.json 不被写）、真实 buildSideQuestionClient 路径测试（openai-compatible + stub globalThis.fetch 走生产装配，验只调一次 base_url/答案正确/不污染文件）、缺失 agent_state.json 容错；`MAIN_TASK_IMPACT_PATTERN` 扩充（写成/改编/黑化/洗白/复活/写死/赐死/领便当/让…在一起/分手/退场，前端镜像 + 漂移守卫保证一致）。
- 验证：`npm test` 79 项全过（side-question 共 12 项）；`verify:app-shell`（含漂移守卫与扩充正则 + `/api/commands/ask` 实测：普通问答/改主线待确认/已完成项目不被重启/side_questions.md 落盘）通过。已删一次性截图脚本与 demo 产物。
- 最终交付：`verify:local` 11 步全绿（含两次打包与产物校验），重新打包并签名，产物 `win-unpacked\WWriting Novel Agent.exe`（约 226.9 MB / 226,869,248 bytes）+ `Setup.exe`（约 96.7 MB），2026-05-30 14:24 重建。三份规划文档已总结性精炼至约一半篇幅，保留全部实质决策与验证证据。






