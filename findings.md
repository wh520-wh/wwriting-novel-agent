# Findings

## 2026-07-12 产品收敛评估

### 当前判断

- 现有代码已覆盖本地项目、章节状态机、断点恢复、模型网关、聊天 Agent、资料工具、技能、质量门禁、审查、成本/缓存、阅读器、故事记忆、时间线和成书导出。
- 因此当前主要产品问题不是“能力缺失”，而是能力分散在技术面板和多个状态中，用户需要理解内部结构才能完成写作。
- 下一阶段应优先优化“创建小说到第一章成功”的路径，再做信息架构收敛和章节编辑闭环。
- 竞品可借鉴的是工作流表达：首次使用预检、模型可复用、生成后立即阅读/审查/修订、故事记忆可见、导出是明确出口；不需要照搬账号、云同步、多智能体或复杂编辑器。

### 代码证据

- `src/core/app-server.mjs` 已有项目、设置、模型切换、聊天、运行、章节阅读、技能和资料相关 API。
- `src/core/app-dashboard.mjs` 已聚合项目、章节、运行、成本、缓存、技能和审查信息，适合支撑重新组织后的工作台。
- `src/core/local-model-profiles.mjs` 与 `src/core/local-secrets.mjs` 已提供模型配置复用和本机密钥存储的基础。
- `src/core/book-export.mjs` 和 `src/app-shell/drawer-panels.js` 已有成书导出入口，不应重新设计一套导出系统。
- `src/core/continuity-store.mjs`、`src/core/chapter-memory.mjs`、`src/core/timeline-check.mjs` 和 `src/core/reviewer-agent.mjs` 已具备故事记忆和审查的底层能力，当前更需要可见化呈现。
- `src/app-shell/chat-derive.mjs` 已有基于项目状态的情境化建议，可复用于“下一步动作”设计。

### 现有风险

- 历史验收记录显示自定义模型预设存在空 `base_url` 保存路径问题，导致 `verify:app-clickability` 和 `verify:local` 不能稳定作为发布门槛。
- 历史验收中真实桌面人工点击和已打包应用的完整人工复验不足，自动化通过不能完全替代用户路径验收。
- 当前工作区存在用户已有修改和临时验收文件；本轮只更新规划文件，不处理这些无关变更。

### 产品取舍

- 先做复用现有 artifact/API 的呈现和路径收敛，不新建完整人物/世界观编辑器。
- 先做模型库与项目选择，不增加供应商编排或多 Agent 角色系统。
- 先做 Markdown/TXT 的可靠导出，不扩展 EPUB、PDF、云发布。
- 先做只读故事状态展示，修改仍走对话和确认，避免维护第二套记忆编辑模型。

### 2026-07-12 网页研究状态

- `kimi-webbridge` 守护进程已恢复运行，但当前 `extension_connected=false`，无法读取用户浏览器中的登录页面。
- 尝试通过 DuckDuckGo HTML 公开搜索入口检索 Sudowrite Story Bible 和 Novelcrafter 官方文档，两次请求均在 20 秒内超时，暂未把搜索结果当作证据。
- 后续只采信能直接读取的官方产品页或帮助文档，并记录 URL、页面标题、读取日期和可验证的产品行为；无法访问的来源标记为未验证。

### 已读取的公开官方页面

- Sudowrite 文档首页：`https://docs.sudowrite.com/`，读取成功（HTTP 200，2026-07-12）。导航同时列出 Getting Started、Quick Start、Organizing Your Projects、Importing Files、Exporting Files、Story Bible、Series、Workflows 等主题，说明其产品入口围绕“快速开始 → 项目组织 → 故事资料 → 写作工作流 → 导出”展开。
- Scrivener 官方概览：`https://www.literatureandlatte.com/scrivener/overview`，读取成功（HTTP 200，2026-07-12）。页面将产品定位为从最初想法到最终稿的完整写作工具，并强调把写作者熟悉的工具整合到一个工作区；这支持 WWriting 把章节、资料、草稿和导出组织在同一项目中，而不是继续增加独立功能入口。
- Campfire 官方学习中心：`https://www.campfirewriting.com/learn`，读取成功（HTTP 200，2026-07-12）。导航包含 Character Development、Plotting & Outlining、Calendars & Timelines、Worldbuilding 等作者任务主题，说明故事结构和时间线应按作者任务呈现，而不是只暴露底层数据模块。
- Novelcrafter 文档首页：`https://docs.novelcrafter.com/`，请求返回 HTTP 308 Permanent Redirect，当前未采信其页面内容，待找到可直接读取的最终 URL 或恢复浏览器扩展后再补查。
- Sudowrite Quick Start：`https://docs.sudowrite.com/getting-started/dQph1snuwbfMWG9wRjsNug/quick-start/2A4FjtiocrtxHPUyz6WZgR`，读取成功（HTTP 200，2026-07-12）。官方导航将 Quick Start 与 Write、Rewrite、Brainstorm、First Draft、Expand、Chat、Workflows、Story Bible、Chapter Continuity、Exporting Files 并列，说明首次上手应先进入写作动作，再逐步暴露高级组织能力。
- Sudowrite Story Bible：`https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/what-is-story-bible/jmWepHcQdJetNrE991fjJC`，读取成功（HTTP 200，2026-07-12）。页面导航显示 Story Bible 由 Braindump、Genre、Style、Synopsis、Characters、Worldbuilding、Outline、Scenes 等结构组成，并有 Chapter Continuity 和 Visibility Settings；可借鉴其“结构化记忆可见、按需控制 AI 可见范围”的方向，但 WWriting 当前只先做只读摘要/连续性展示，不直接复制完整编辑器。

### 研究转化为产品约束

- Sudowrite 的 Story Bible 明确承担两个职责：把故事核心元素集中在一个地方，并作为作者和 AI 后续工作的事实来源；它还允许按项目开关、手动修改或让 AI 生成各字段。WWriting 的对应最小版本应是“项目级故事状态摘要 + 来源/更新时间 + 需要核对提示”，而不是另建完整人物卡系统。
- Sudowrite 的字段有明确依赖关系：故事种子影响概要，概要影响人物/世界观/大纲，大纲影响场景，场景影响正文。WWriting 已有 prompt、memory、continuity、timeline 和章节状态，但 UI 需要把“当前章节使用了哪些上下文”解释给用户，避免记忆像黑箱。
- Scrivener 官方概览：`https://www.literatureandlatte.com/scrivener/overview`，读取成功（HTTP 200，2026-07-12）。其 Corkboard 把章节/片段与摘要卡绑定，移动卡片同时调整稿件结构；Research 可以与正文并排查看；Compile 可以将项目合成为 Word、PDF、Final Draft 或纯文本等交付物。WWriting 当前不复制可自由拖拽的编辑器，而优先做章节摘要列表、资料与当前章节并排可达、Markdown/TXT 可靠导出。
- Campfire 页面已证实作者工具按 Character Development、Plotting & Outlining、Calendars & Timelines、Worldbuilding 等任务分类；因此 WWriting 的故事资料入口应面向“人物/情节/时间/来源”等作者问题，而不是直接暴露 `continuity-store`、`cache_report` 等内部模块名。

### 研究过程中的错误

| 错误 | 尝试次数 | 处理结果 |
|---|---:|---|
| DuckDuckGo HTML 公开搜索请求超时 | 2 | 改用可直接访问的官方文档 URL，并只采信 HTTP 200 页面 |
| PowerShell 提取 Sudowrite 正文时因弯引号导致字符串解析失败 | 1 | 改用双引号表达式重跑，成功读取 Story Bible 正文 |

## 已确认需求
- 工作区为空，无现成代码库；产品形态为桌面应用，目标用户是独立作者。
- 写作支持自动连续 + 人工确认两种模式；输出为本地 Markdown/TXT 章节（默认 Markdown）。
- 章节正文必须经工具写入本地文件，不通过 AI 聊天回复交付。
- 多云模型可切换；扩展策略为内置工具优先 + 保留 skill 导入接口。
- v1 聚焦章节持续生产，不做完整人物/世界观编辑器。

## 已确认架构方向
- 每个小说项目对应一个本地文件夹，有独立对话窗（类 Codex / Claude Code）。
- 自研小说 Agent 核心，不 fork 完整 GitHub coding agent；桌面壳、多模型配置、日志 UI 可参考成熟开源模板。
- 长跑不依赖模型记忆，而靠应用调度器、状态机、checkpoint 和本地文件。
- 上下文分层：固定层 + 结构化记忆层 + 最近上下文层 + 当前任务层 + 运行状态层。
- 章节生成流水线：planning → drafting → reviewing → revising → finalizing → summarizing；每章完成后更新全书摘要、章节索引、活跃状态与未收束伏笔。

## 连续完成任务的关键发现
- 持续运行由调度器负责，模型只反复完成小任务；单章拆成多个 segment/scene 逐段写入，不靠一次调用写完。
- 章节正文必须经文件工具落盘；无工具写入记录和本地校验即不算完成。模型自报字数不可信，须由本地统计器计算，不足时经质量门禁 hook 返回缺口补写。
- 进度写入 `agent_state.json` 和 checkpoint；正文先入 drafts 通过检查再进 chapters；每次状态转换写日志便于恢复排错。
- 质量门禁是连续生成关键，否则逐章漂移；自动重试须按错误类型处理，不简单重复同一提示词。
- 人工确认本质是状态机暂停点；长跑须有预算、熔断和 blocked 状态避免无限调用。
- 实现前应先做 mock model 和恢复测试，以区分问题来自模型还是状态机。

## 新增实现约束
- 最小闭环：3 章生成、中途退出恢复、字数不足补写、最终落盘。
- 项目文件夹是最终事实来源，SQLite 仅作 UI 索引/缓存且须可重建。
- 模块边界：app-shell、project-store、agent-engine、model-gateway、tool-runtime、skill-runtime、context-scheduler、quality-gates、ui-events。
- 模型输出分 `tool_call`/`status_message`/`ask_user`；生成正文只接受 `tool_call`，聊天正文视为错误通道。
- 文件写入用临时文件 + 原子重命名，记录 checksum、字节数、有效字数；每 segment 有 segment_no 防恢复重复追加。
- 项目数据含 `project.yaml`、`agent_state.json`、`chapter_index.json`、checkpoint；prompt 模板版本化并在 checkpoint 记版本+hash；项目文件需 schema_version 和迁移策略。
- UI 通过 `run_log.jsonl` 事件流更新；网页内容和导入 skill 均为不可信输入，只能经受控流程进入上下文。

## Skill 方向
- manifest 采用 `name/version/type/scope/hooks`，建议增 `enabled/priority/params/conditions`。
- `type` 覆盖 `style/flow-control/quality-gate/post-process`；`hooks.stage` 至少支持 `planning/reviewing/post_process`。
- skill 只追加策略、执行检查或后处理，不绕过主流程写正式章节。

## 基础工具方向
- 文件工具：读写追加、列目录/建目录、搜索、移动草稿。网页工具：搜索、抓取、正文抽取、保存来源快照。
- 运行工具：任务队列、暂停/恢复/重试、checkpoint、日志。项目工具：读配置、更新章节索引、更新结构化记忆、创建下一章任务。

## 技术路线判断
- 不 fork 完整 GitHub Agent（通用 coding agent 业务模型与小说生产线差异大），也不全从零做（桌面壳/多模型/日志 UI 有成熟方案）；推荐自研章节生产线核心 + 复用桌面模板 + 参考开源 Agent 的 durable execution、人机确认与日志设计。

## 已吸收的外部参考要点
- 长跑 Agent 本质是受控循环：observe/decide/execute/record/update memory/check stop condition；Goal 须可验证，越长跑越需明确范围与停止条件。
- 权限分层 read-only/safe edit/test allowed/network allowed/dangerous，默认最小权限；状态、工具日志、checkpoint、文件校验是可恢复可审计核心。
- 工具系统拆为受控工具 + BeforeToolUse/AfterToolUse 生命周期 hook；须测试越权、伪造完成、偷改测试、prompt injection；成熟版应有只读 Reviewer Agent（执行与审查分离）。
- 配置分 global/project/local/policy，不能被 prompt 或网页覆盖；UI 须展示目标、阶段、工具调用、测试结果、成本、预算与待确认操作。
- 写作型 Agent 优先参考 STORM、GPT Researcher、WriteHERE、Novel-OS、Libriscribe、StoryCraftr、writing-helper、LangGraph 等，而非代码 Agent；项目保存 goal/audience/style/sources/summaries/outline/draft/review/final/cost/cache report 等 artifact 作为记忆。
- DeepSeek/Grok/MiMo 作为同一 Writing Agent 的可配置 provider，不硬编码成写作角色；默认所有阶段用 active model，stage override 默认关闭。
- 须引入 PromptCompiler（稳定块在前、动态块在后，保 provider 前缀缓存）；Provider Adapter 归一化 usage/成本/缓存字段，无缓存字段时不伪造命中率；CacheKeyManager 仅因稳定块（goal/audience/style/source_summaries/outline/system_rules）变化升级 cache version。

## 自审风险
- P1：工具调用参数未校验——真实模型可能写错章节、跳 segment、伪造 project_id 或传空正文，须在工具执行前强校验。
- P1：项目 slug 可逃出 workspace——须限制字符集，项目根目录由 workspace 级 safe join 生成。
- P2：连续无效输出后直接抛错，未持久化 blocked 状态、错误 checkpoint 和 project_blocked 事件。
- P3：active_budget 已建模但未执行扣减/熔断，需接入模型调用计数、补写轮数和运行时长限制。

## 模型/缓存风险
- 把 provider 当 Agent 角色会让流程被模型名绑死，切换模型即破坏流程。
- 各功能各自拼 prompt 会破坏稳定前缀，降低 DeepSeek/Grok/MiMo 缓存命中。
- 不记录原始 usage 和 `cacheMetricsAvailable` 会让 UI 误导用户相信不存在的缓存收益；动态日志/时间戳/随机 ID 放 prompt 前部会持续打碎缓存。

## 2026-05-29 实现后发现
- 工具参数校验须同时在模型输出 gate（让模型重试）和工具运行层（防绕过 gate 的内部调用直接写盘）。
- blocked 不能只靠异常，须落盘到 `agent_state.json`/`run_log.jsonl`/checkpoint，否则重启后无法解释停止原因。
- 预算扣减须在真实调用之前；`max_model_calls=0` 时应在首次调用前进入 blocked。
- Provider adapter 只管 API 差异和 usage 归一化，不是写作角色；写作流程由单一 Writing Agent 状态机控制。
- Prompt cache 依赖稳定前缀：动态任务、最新反馈、trace 摘要不能放稳定块之前。缓存命中率以 provider 原生字段为准，无字段则显示不可用。

## 2026-05-29 模型网关接入发现
- 模型网关须进入 agent-engine 实际生成路径才有价值，否则 checkpoint/成本/缓存报告与真实章节状态脱节。
- prompt block hash、usage report、cache key 最好随 checkpoint 保存，否则恢复时不知当时上下文和成本。
- `cost.json`/`cache_report.json` 应作项目级 artifact，重启后可直接读取显示。
- 20 章长跑能暴露单章 MVP 看不出的累积问题（章节索引、cache version、事件数量、segment 去重、成本统计一致性）。
- `tool_call_rejected` 应作专门审计事件；只记 `quality_gate_failed` 对 UI/reviewer 不够直接。

## 2026-05-29 GUI 接入发现
- GUI 不直接猜文件系统状态，经独立 dashboard 数据层读 artifact，便于 Electron/Tauri 化复用同一边界。
- 进度可视化最小数据来自 `chapter_index.json`/`agent_state.json`/`run_log.jsonl`；成本缓存读 `cost.json`/`cache_report.json`。
- `/api/dashboard` 须限制项目路径在 workspace 内，否则成任意本地文件读取入口。
- GUI 冒烟须实际启动服务并请求 HTML/JS/JSON 三类资源，`node --check` 不足以证明可用。
- Windows 长跑 `fs.rename` 可能短暂 `EPERM`；原子写入保留 fsync+rename，并对短暂占用做有限重试。

## 2026-05-29 Skill Runtime / 网页工具 / 配置分层发现
- Skill 是策略扩展层非工具执行环境，runtime 只允许 append_prompt/check/post_process；manifest 校验先于执行，未知字段保留给 UI/审计但不自动可执行。
- planning hook 落盘为章节 planning artifact 并进 PromptCompiler 稳定块；reviewing hook 须成为质量门禁（失败时阻止 finalize 进入修订）；post_process 只处理 draft 不覆盖正式章节。
- 网页工具默认关闭网络（未授权时 adapter 调用前失败）；搜索/抓取结果写入 `sources/`、`sources.md`、`source_summaries.md` 资料层，不进 system prompt；来源快照记 `untrusted: true` + data-only policy，正文抽取剥离 script/style/HTML 并对疑似注入打警告。
- 配置分层须进入实际调用路径，否则留 policy 被绕过风险；`policy_config` 是硬边界（即使开启网络，`forbid_network` 仍在 adapter 调用前失败）；`read_only` 须联动关闭 `safe_edit`；legacy 字段兼容到 `tool_permissions`/`budget_config`；ModelClient 经 effective config 选模型，不读散落 `active_model`。

## 2026-05-29 Reviewer / 故障压测 / Provider / Skill 管理发现
- Reviewer Agent 只读运行事实，检查文件/索引/日志/checkpoint 能否互证；章节完成须同时满足正式文件存在、字数达标、checksum 匹配、质量门禁通过、事件日志和 checkpoint 证据存在。
- 故障注入压测（偶发聊天输出、重试、中断恢复）比普通长跑更能验证状态机只重跑当前小步骤。
- Provider adapter 先做可测试传输层，不把真实网络/key 作单测前提；OpenAI-style usage 有嵌套差异（如 `prompt_tokens_details.cached_tokens`）须抽取到统一字段。
- Skill 管理须列出「可用但未启用」的 skill；导入复用 manifest 校验和 hook 白名单；启用/禁用写回 `project.yaml` + `skill_configuration_changed` 事件；管理 API 限制路径在 workspace 内。

## 2026-05-29 研究 Adapter / 流式 Provider / 设置管理发现
- 搜索抓取分层：底层 adapter 可有真实 HTTP，执行入口仍走 `searchWeb`/`fetchWebPage` 的权限/快照/注入隔离；通用搜索 adapter 须可配置结果路径和字段映射避免锁死供应商；研究 API 读 effective config，前端只提交 query/url 不提交权限。
- 流式 provider 第一步价值是可审计聚合（解析 SSE、保存最终文本/usage/cache 字段）；Electron 壳保留 context isolation、禁用 nodeIntegration，经本地服务边界复用 dashboard/API。
- API key 设计为环境变量引用而非明文，避免项目成密钥泄漏载体；`dangerous` 权限不出现在普通设置面板须单独授权；设置变更作事件写入 `run_log.jsonl`；模型面板须同时配 provider 与 model_name。

## 2026-05-29 Electron / 在线验收发现
- Electron npm 包安装成功 ≠ 运行时可用，须确认 `node_modules/electron/path.txt` 和 `dist/` 二进制存在。
- 官方 binary 下载可能受 CDN 影响长时间无响应；验证脚本应快速报告 `electron_binary_missing` 避免挂住。
- 桌面 smoke 隐藏窗口、加载本地 dashboard、输出机器可读 JSON 并自动退出。
- 在线 provider/搜索验收单独成脚本并依赖环境变量，不把真实 key 写入项目配置/计划/fixture。
- 镜像源下载属外部依赖，成功后仍用 `verify:electron-runtime` 证明 Electron 真能启动。

## 2026-05-29 打包发现
- 打包不能依赖主进程 `spawn(process.execPath, node-script)`（打包后 execPath 是应用 exe），服务应作主进程内模块启动。
- `electron-builder --dir` 可能触发 winCodeSign 下载或 exe 资源编辑；目录包验收可关 `signAndEditExecutable`，签名/installer 作后续发布策略。
- 目录包可用性验证 exe 本身（`verify:packaged-dir` 用 smoke 启动打包 exe），不只检查文件存在；打包输出和 builder cache 加入 `.gitignore`。
- `verify:local` 作总验收命令降低恢复后漏跑风险，但真实 provider/search 仍单独在线验收。

## 2026-05-29 在线研究 / 最终收口发现
- 真实网页抓取可不依赖搜索供应商或 key，作网络工具最小在线验收；搜索 API 验收需 endpoint/字段映射/key，不可与抓取混称。
- 在线抓取结果仍走来源快照和 data-only policy，不因来源公开就进系统指令层。
- 真实 provider 在线验收用 OpenAI-compatible 契约覆盖 DeepSeek（base URL/model/key env 可配置即可），核心 Agent 不硬编码 provider 名。
- 临时 key 坚持「只进进程环境变量」，验收后主动检查环境变量和项目文件避免残留。
- 通用 JSON 搜索 adapter 须暴露 query/limit/结果路径/字段映射给验证脚本，才能证明「可配置搜索供应商」能力。
- CI/无人值守 smoke 尽量不创建 BrowserWindow（优先验主进程/内嵌服务/dashboard API），正常桌面运行保留可见窗口；Windows 上 smoke 用独立临时 `userData`、禁用 GPU/cache 并在脚本执行前经命令行开关生效。
- NSIS 产物验证检查可执行文件头和体积（非只看文件名）；完整安装/卸载、签名、自动更新属发布级验收。`verify:local` 应含安装器构建与产物验证。

## 2026-05-29 Codex 风格 UI 升级发现
- 设置端与项目端须信息架构分离：模型 provider/key env/预算/联网/搜索集中在设置端，项目端承载章节流水线/事件/Skill/资料工具。
- 本地文件夹打开分两层：浏览器预览用路径输入，Electron 用 preload + IPC 系统选择器，最终都走同一 `/api/projects/open` 受控入口。
- 允许打开 workspace 外部项目时不复用「必须在 workspace 内」判定，但用 `project.yaml` 校验项目根，内部文件访问仍走 `safeJoin`。
- Codex 布局关键是稳定工作台结构（活动栏切模式、项目栏选上下文、中间当前任务、右侧检查器），非深色主题。
- UI 验证须检查 HTML 汉化文案、前端项目打开逻辑、服务端列表/打开 API、设置写回和打包后 smoke。

## 2026-05-30 汉化 / 原生菜单 / Simplify 审查发现
- 「完整汉化」须检查残留英文技术标签（已修 Provider/Key Env/Token/Skill 管理/Agent 状态/Checkpoint/Reviewer 等），验证脚本含正向 + 反向断言；后端用户可见错误尽量中文化，字段名/函数名/文件名/包名保持工程语义不属汉化范围。
- 截图里 `File/Edit/View/Window/Exit` 是 Electron/Chromium 原生菜单，须在主进程经 `Menu.buildFromTemplate`+`Menu.setApplicationMenu` 接管并纳入 `verify:desktop-shell`（`verify:app-shell` 覆盖不到）。
- 全项目简化优先处理共享边界（项目文件读取、事件日志读取、路径边界判断），重复会让安全修复漏改；`readEvents` 自己处理「文件不存在」正常状态而非每个调用方 `.catch(()=>[])`；路径判断集中在 `fs-utils.isPathInside`/`safeJoin`；配置型 adapter 对非数组返回空结果；usage 归一化保留原始 spread 避免无意义自引用字段。

## 2026-05-30 Codex UI 与第二仪表盘审查发现
- 第二仪表盘吸收分层思路（顶部 KPI、任务流、成本/缓存、运行明细、来源/审查、设置快照）非照搬；Codex 风格是浅色侧边栏、低边框、高密度项目列表、中央圆角工作面 + 底部命令栏（命令栏须有受控提交路径，章节正文仍只由文件工具落盘）。
- 局部操作失败不复用全局读取失败处理（否则小错误清空指标并误标阻塞）；首次 `/api/dashboard` 自动选中项目须在服务端固化为 selected project；任务流须覆盖真实阶段（queued/planned/planning/drafting/reviewing/needs_revision/revising/post_process/finalizing/summarizing）。
- 保存 `max_model_calls` 须同步更新 `agent_state.active_budget`（保留已消耗 `model_calls`）；合并型设置须支持空字符串归一为「删除字段」；`verify:app-shell` 须含 DOM/HTML id 一致性检查、随机端口、composer API 与仪表盘断言，更强是真实浏览器/Electron 交互 smoke。

## 2026-05-30 旁路询问（Side Question）设计发现
- 命门是隔离：临时提问只读，绝不经任何路径写正文/章节/agent_state.json/计划文件，也不启动/打断 run。三重保证：(1) handleSideQuestion 只调读类函数 + 只 append 独立 side_questions.md；(2) 不 import saveState/upsertChapter/runProject；(3) ModelClient 注入一次性 `new CostTracker()`，开销不落 cost.json。
- 分析与修改在入口分流：detectMainTaskImpact 用改写/改设定正则识别「其实想改主线」的提问，标记待确认变更，由用户点「加入正式写作任务」才走 /api/commands/submit；前端镜像后端解析但后端始终权威，两侧用同一套常量正则并由 verify-app-shell 漂移守卫逐字校验（前缀 /ask /side /q，禁用 /btw）。
- 离线可用是底线：未配在线模型时本地合成标注「旁路分析·离线模式」的回答；模型失败降级须暴露 modelError 并写入日志。Agent 状态映射为待命/规划中/写作中/审稿中/保存中/已完成/需处理，顶栏与命令栏共用 agentPhaseLabel。
- 测试须证伪不变量：在线模型路径全项目快照（除 side_questions.md 外文件 sha256 前后一致，证 cost.json 不被写）、真实 buildSideQuestionClient 路径（stub fetch 走生产装配）、缺失 agent_state.json 容错——结构稳固但未来回归可能静默破坏。
