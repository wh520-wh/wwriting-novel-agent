# Progress

## 2026-07-12 产品收敛计划建立

### 本次完成

- 阅读并遵循 `planning-with-files-zh` 技能规则。
- 读取现有 `task_plan.md`、`findings.md`、`progress.md`，确认它们包含从 MVP、Codex 风格 UI、聊天 Agent 到故事时间线的历史记录。
- 结合现有源码和验收报告，确认当前阶段应从“新增能力”转向“已有能力产品化”。
- 在 `task_plan.md` 顶部新增当前产品收敛计划，分为发布可信度、第一章成功、模型库、信息架构、编辑闭环、故事记忆、成书交付和总验收八个阶段。
- 在 `findings.md` 记录产品判断、代码证据、已知风险和明确取舍。

### 当前状态

- 计划状态：规划完成，等待用户决定是否进入第一阶段实现。
- 当前阶段：阶段 0「发布与基础可信度」待执行。
- 本次未修改源码、测试、打包产物或用户已有临时文件。

### 下一步建议

1. 先执行阶段 0，修复自定义模型保存路径并让 `verify:local` 恢复为可用发布门槛。
2. 阶段 0 通过后，再进入阶段 1 的“创建项目后直接开始第一章”路径。
3. 每完成一个阶段，更新本文件、计划状态和对应验收证据。

## 2026-07-12 首章成功路径 Spec

### 本次完成

- 修复 WebBridge 的陈旧 PID 文件后恢复 daemon；当前 daemon 运行正常，但浏览器扩展尚未连接，因此未使用登录态网页内容。
- 公开检索入口超时后，改为读取 Sudowrite、Scrivener、Campfire 的官方页面；Novelcrafter 文档首页返回 308，未采信其内容。
- 将研究结论写入 `findings.md`，包括 Quick Start、项目级故事事实来源、作者任务式信息架构、资料可达和成书导出的可迁移原则。
- 新建 `docs/superpowers/specs/2026-07-12-first-chapter-success-design.md`，细化“创建/打开 → 准备写作 → 测试模型 → 开始第 1 章 → 阅读完成章节”的设计、状态模型、文件落点、错误处理和验收命令。
- 明确本 Spec 不修改核心 Agent 状态机、项目文件 schema、模型库结构和完整 Story Bible 编辑器。

### 当前状态

- 阶段 0：发布与基础可信度，仍待执行。
- 阶段 1：首次使用与第一章成功，Spec 已完成，等待用户确认后再写实施计划。
- 本次未修改源码、测试和打包产物。

## 2026-07-12 首章成功路径实施计划

### 本次完成

- 按 `writing-plans` 技能将首章成功 Spec 拆成 7 个可独立验证的实施任务。
- 计划采用 TDD 顺序：先锁定自定义模型保存基线，再实现纯 readiness 状态，随后接入准备卡、受控启动入口、dashboard 语义、Electron 点击探针和最终交付门槛。
- 自审修正两处范围遗漏：无项目状态必须在主区保留“新建小说 / 打开本地文件夹”；章节完成卡在任一 committed 章节完成后即可显示，不等待整本目标完成。
- 实施计划保存到 `docs/superpowers/plans/2026-07-12-first-chapter-success.md`。

### 当前状态

- 阶段 1：实施计划已完成并验收通过。
- 阶段 0 和阶段 1 的所有实现任务已执行完毕，进入发布前的最终收口状态。

## 2026-07-12 首章成功路径实现（Tasks 1-7）

### 本次完成

- **Task 1**：锁定自定义模型保存回归 — 新增回归测试断言自定义模型 base_url 和 model_id 在保存后 persist 到 dashboard；`scripts/verify-app-clickability.cjs` 扩展已有 Electron 点击链路覆盖新建项目和设置保存。
- **Task 2**：以 TDD 实现 `deriveWriteReadiness` — 新增 `src/app-shell/write-readiness.mjs` 纯函数模块，派生 10 种优先级顺序状态（no_project → project_read_only → running → blocked → completed → missing_model → invalid_model → demo → ready → connection_unknown）；`tests/app-shell/write-readiness.test.mjs` 覆盖全部状态和项目状态优先级。
- **Task 3**：接入准备卡与章节完成卡 — `index.html` 新增 `#write-readiness` 和 `#chapter-success` 卡片容器；`app.js` 整合 `deriveWriteReadiness` 渲染逻辑，准备卡按状态显示不同主按钮（写第 1 章/演示模型/配置模型/检查配置/测试连接等），完成卡仅使用 committed artifact 真值；`styles.css` 新增响应式卡片样式。
- **Task 4**：暴露受控的开始当前章节入口 — `composer.js` 新增 `startCurrentChapter()`，内部调用 `submitWritingCommand()` 复用现有写作提交路径；准备卡和完成卡按钮均使用 `composer.startCurrentChapter()`；`composer-intent.test.mjs` 验证请求 /api/commands/submit。
- **Task 5**：补齐 dashboard 与连接测试语义 — `app-server-probe.test.mjs` 新增项目初始化后 dashboard 断言和连接事件匹配测试；确认无新增 quick-start API。
- **Task 6**：增加真实 Electron 首章点击链路 — `verify-app-clickability.cjs` 新增 first-chapter-start 和 chapter-success-read 探针；`verify-app-shell.mjs` 扩展项目初始化后 dashboard 字段断言；`app-shell-static.test.mjs` 断言 6 个稳定卡片 ID 和 deriveWriteReadiness 导入。
- **Task 7**（本任务）：新增首次写作流程说明到用户指南；运行完整交付门槛。

### 验证结果

| 门槛 | 结果 | 说明 |
|---|---|---|
| `npm test` | 通过 | 749 项全部通过 |
| `npm run verify:app-clickability` | 通过 | Electron 点击链路探针全部命中（含 first-chapter-start、chapter-success-read）|
| `npm run verify:app-shell` | 通过 | 包含 dashboard 字段断言、新 IA 断言、漂移守卫 |
| `npm run verify:desktop-shell` | 通过 | 桌面壳菜单接管与中文标签 |
| `npm run verify:electron-runtime` | 通过 | Electron smoke 模式加载 dashboard |
| `npm run verify:mvp` | 通过 | 3 章 mock 生成 |
| `npm run verify:longrun` | 通过 | 20 章 mock 一致性 |
| `npm run verify:faults` | 通过 | 8 章故障注入 |
| `npm run package:dir` | 通过 | 目录包构建成功 |
| `npm run verify:packaged-dir` | 通过 | 打包 exe smoke 测试通过 |
| `npm run package:installer` | 通过 | NSIS 安装器构建成功（102.6 MB） |
| `npm run verify:installer` | 通过 | 安装器文件头和体积校验通过 |
| `npm run verify:local` | **通过** | 12 步全绿，整体发布门槛通过 |

### 当前状态

- Phase 1 首章成功路径：完成。
- `verify:local` 全链路通过，可进入发布流程。
- 已更新 `docs/USER_GUIDE.zh-CN.md` 包含首次写作流程说明。

### 未解决风险

- 无阻塞性未解决问题。阶段 0（发布与基础可信度）和阶段 1（首次使用与第一章成功）均已实现并通过验收。
- 后续阶段（2-7）待规划和实现。

## 已完成（需求与决策）
- 产品方向：桌面端长篇小说写作 Agent；用户：独立作者；模式：自动连续写作 + 人工确认；输出：本地 Markdown 章节。
- 扩展：内置工具优先 + 支持 skill 导入。基础工具：网页搜索/抓取、本地文件、任务队列、checkpoint、日志。
- 核心风险：模型无法天然保证长时间连续完成任务，需应用层状态机和调度器兜底。
- `task_plan.md` 扩展为详细实施计划，补充连续完成机制：任务拆分、章节状态机、checkpoint/断点续跑、调度器循环、context package、质量门禁、真实字数统计与补写 hook、自动重试与降级、人工确认暂停点、skill hook 约束。

## 关键决策
- 模型自报字数一律不作完成依据；字数由本地统计器读正文实算，不足时 reviewing 阶段生成 word-count gate 把缺口返回模型补写。
- 章节正文必须经文件工具写入本地 Markdown/TXT，不经聊天回复交付；聊天窗口只用于指令/状态/摘要/日志/确认。
- 技术路线：自研小说 Agent 核心 + 复用成熟桌面骨架与开源设计经验，不 fork 完整 GitHub coding agent。
- 最小闭环：3 章生成、中途退出恢复、字数不足补写、最终落盘；单章内部 segment/scene 逐段生成追加。
- 模型正文输出必须经 `tool_call`（聊天正文视为错误通道）；文件写入须原子写入 + checksum + segment 去重 + 本地校验。
- 长跑须有预算/熔断/blocked 状态；实现前先建 mock model 和恢复测试。
- 模块边界：UI、项目存储、Agent 引擎、模型网关、工具运行时、Skill 运行时、上下文调度、质量门禁、UI 事件分离。
- 项目文件夹是最终事实来源，SQLite 仅作可重建索引/缓存；prompt 模板/checkpoint/项目 schema 都版本化；UI 经 `run_log.jsonl` 事件流同步状态。
- 已吸收 `shouldread.md`（1219 行版本）的 Goal Contract、权限分层、状态恢复、上下文压缩、配置分层、工具 hook、行为评测、Reviewer Agent，以及写作型 Agent 参考、active model 原则、PromptCompiler、ProviderAdapter、UsageReport、缓存策略、成本统计、缓存友好上下文。

## 第一版最小闭环实现
- 已建 Node.js MVP 骨架和静态 app shell；实现项目文件夹持久化（`project.yaml`/`agent_state.json`/`chapter_index.json`/checkpoint/`run_log.jsonl`）。
- 实现章节状态机、mock model、工具调用写章节、segment 去重、真实字数统计与补写；第 2 章中途模拟中断并从 checkpoint 恢复。
- 测试覆盖：3 章落盘、聊天正文通道拒绝、字数门禁补写、恢复去重、Markdown 字数统计、TXT 输出、项目根隔离。
- 验证：`npm test` 8 项通过；`verify:mvp` 生成 3 章（每章最低 3000 有效字）并验证中断恢复；app shell 预览服务返回 `WWriting` 页面通过。

## 下一步建议（早期）
- 接真实模型前先修自审风险：工具参数校验、slug 越界、blocked 持久化、预算熔断。
- 先实现 ModelClient/ProviderAdapter/PromptCompiler/UsageReport/CostTracker 的 mock 版，再接 DeepSeek 或 OpenAI-compatible。

## 2026-05-29 核心加固与模型网关基础层
- slug 安全校验：`createProject` 先验 slug 再用 workspace-safe join，非法 `../outside`/反斜杠不创建目录。
- 章节写入工具参数校验：`project_id`/`chapter_no`/`segment_no`/非空正文/最大长度执行前校验，非法 tool_call 不写 draft。
- blocked 持久化：连续 3 次无效输出写入 `project_status=blocked` + `project_blocked` 事件 + 带 `error.code` 的 checkpoint。
- 预算扣减与熔断：模型调用扣减 `active_budget.model_calls`，耗尽进 blocked；修订轮次按章计数受 `max_revision_rounds_per_chapter` 限制。
- 新增模型网关模块：`model-client`/`provider-adapters`/`prompt-compiler`/`usage-report`/`cost-tracker`/`cache-key-manager`.mjs。
- 验证默认所有阶段用 `active_model`（仅 `stage_overrides[stage].enabled===true` 才切换）；PromptCompiler 稳定块在前/动态块在后，CacheKeyManager 仅稳定块 hash 变化时升级 cache version；provider 无缓存字段时 `cacheMetricsAvailable=false`/`cacheHitRate=null` 不伪造。
- 验证：`npm test` 19 项通过；`verify:mvp` 通过。

## 2026-05-29 模型网关接入引擎与 20 章长跑
- 已将 ModelClient/PromptCompiler/CacheKeyManager/CostTracker 接入 agent-engine 章节生成路径（不再只停留在模块测试）；每次生成编译 prompt package、记 stable/dynamic block hash、生成 cache key、经 mock adapter 归一化 usage。
- 新增项目级 `cost.json`/`cache_report.json`；`run_log.jsonl` 记 `model_call_started/completed`、`model_usage_recorded`、`cache_report_updated`；checkpoint 扩展记 `prompt_block_hashes`/`model_calls`/`usage_reports`/`cost_summary`/`cache_report`/`cache_key`/`context_package_hash`。
- 新增 `tool_call_rejected` 事件（非法通道/伪造 project_id/错误参数留可审计记录）；新增 `verify:longrun`（20 章 mock 长跑一致性验证）。
- 验证：`npm test` 20 项；`verify:mvp` 通过；`verify:longrun` 通过（20 章，每章最低 300 有效字，验证章节索引/最终文件/segment 去重/checkpoint/usage/cost/cache report）。

## 2026-05-29 GUI 真实数据接入
- 新增 `app-dashboard.mjs` 从真实项目目录读 6 类 artifact 生成 dashboard 数据；`serve-app-shell.mjs` 新增 `/api/dashboard`（支持 `PROJECT_ROOT` 或自动选 workspace 内最近项目）。
- `index.html`/`styles.css`/`app.js` 改为真实数据驱动，展示项目状态/章节流水线/总字数/模型调用/token/成本/缓存/最近 checkpoint/事件日志。
- 新增 `app-dashboard.test.mjs`（汇总真实文件 + 拒绝读 workspace 外路径）；新增 `verify:app-shell`（启动预览服务请求 HTML/JS/dashboard JSON 冒烟）。
- 增强 Windows 原子写入：`writeFileAtomic` 的 rename 遇 `EPERM/EBUSY/EACCES` 短暂重试，修复长跑偶发 Windows 文件占用。
- 验证：`npm test` 22 项；`verify:mvp`/`verify:longrun` 通过；`verify:app-shell` 通过（样例项目完成章节数 2）。

## 2026-05-29 Skill Runtime
- 新增 `skill-runtime.mjs`：manifest 解析（JSON/YAML）、校验、启用加载、priority 排序、conditions 匹配；内置 `suspense-chapter-end` 示例 skill。
- 接入三类 hook：planning 阶段 `append_prompt`（生成 `drafts/NNN.planning.md` + `skill_hook_applied` 事件 + checkpoint `skill_hooks`）；reviewing 阶段 `check`（suspense-ending 检查末 500 可见字符，失败进 `needs_revision` 不 finalize）；post-process 阶段 `post_process`（仅处理 draft，finalize 前应用，不绕过状态机）。
- PromptCompiler stable block order 加入 `skill_instructions`。
- 验证：`npm test` 27 项（新增 manifest YAML/priority/conditions/内置 skill/引擎集成）；`verify:mvp`/`verify:longrun`/`verify:app-shell` 通过。

## 2026-05-29 受控网页搜索/抓取工具
- 新增 `research-tools.mjs`：受控 `searchWeb`/`fetchWebPage`、正文抽取、来源快照、prompt injection 检测、网络权限检查。
- 新增 `tool_permissions.network_allowed`（默认关闭，未授权抛 `NetworkPermissionError` 不调 adapter）；新项目创建 `sources/`、`sources.md`、`source_summaries.md`，结果只写资料层不进系统提示/正文。
- 搜索结果存 `sources/*.json` + `web_search_completed` 事件；抓取剥离 script/style/html、抽取正文、检测注入，写 `web_fetch_completed` 事件 + 快照 + 摘要；外部快照带 `untrusted: true` + data-only policy。
- 验证：`npm test` 32 项（默认拒绝联网/mock 搜索快照/mock 抓取/注入检测/非 http(s) 拒绝）；`verify:mvp`/`verify:longrun`/`verify:app-shell` 通过。

## 2026-05-29 配置分层接入
- 新增 `config-runtime.mjs`：global/project/local/policy 四层归一化、合并、effective config 输出。
- 接入 agent-engine（运行时加载三层 config 文件挂到运行对象）、ModelClient（从 effective config 选模型，local 可覆盖 active model，阶段覆盖仍须显式 `enabled:true`）、网页工具权限（`searchWeb`/`fetchWebPage` 用 effective config 判断，policy 禁网覆盖项目和调用选项且不调 adapter）。
- 验证：`npm test` 38 项（配置优先级/legacy 归一化/policy 禁网覆盖/ModelClient effective config/权限不可绕过）；`verify:mvp`/`verify:longrun`/`verify:app-shell` 通过。

## 2026-05-29 Reviewer / 故障压测 / GUI 扩展 / Provider 传输层
- 新增只读 Reviewer Agent，审查本地事实（章节文件存在/真实字数达标/checksum 匹配/质量门禁通过/事件与 checkpoint 能否证明完成）；输出 `review/reviewer_report.json`（仅显式 `writeReport` 时生成，不改正文）。
- 新增确定性故障注入压测脚本（模拟首次聊天正文输出 + 重试工具调用 + 中断恢复，完成后自动跑 Reviewer）；dashboard 扩展返回 effective config/权限/enabled skills/hook 阶段/来源快照/注入警告数/Reviewer 状态；app shell 新增 Skill 管理区和资料工具区。
- 完成 OpenAI-compatible provider 可测试传输层（chat completions、API key/env、错误归一、usage/cache 抽取；真实联网仍需 key）。
- 验证：`npm test` 44 项；`verify:mvp`/`verify:longrun` 通过；`verify:faults` 通过（8 章/2 次注入/中断恢复/Reviewer 通过）；`verify:app-shell` 通过。

## 2026-05-29 Skill 管理操作
- 新增 `listProjectSkills`（dashboard 同时看内置/导入 skill、hook 阶段、是否启用）、`importProjectSkill`（复用 manifest 校验）；app shell Skill API 启用/禁用/导入都更新 `project.yaml.enabled_skills` + `skill_configuration_changed` 事件；前端 Skill 面板接入启用/禁用按钮。
- 验证：`npm test` 45 项；`verify:app-shell` 通过（覆盖禁用/重启用/导入刷新）。

## 2026-05-29 研究 Adapter、Provider 流式解析、桌面入口骨架
- 新增真实联网可用但默认受限的研究 adapter（直接抓取 adapter + 通用 JSON 搜索 API adapter）；app shell 研究 API 读 effective config、走 network permission/policy、调 adapter 并写快照与事件；资料工具 UI 加搜索/抓取控件。
- OpenAI-compatible provider 支持 `stream:true` SSE 聚合（抽取 token/usage/cache，在线仍需 key）；新增 Electron 桌面入口骨架 + preload + 离线验证脚本（真运行需装 `electron`）。
- 验证：`npm test` 50 项；`verify:app-shell` 通过；`verify:desktop-shell` 通过。

## 2026-05-29 模型、权限和研究配置管理
- 新增设置 runtime，统一校验并写回项目配置（模型/阶段覆盖/工具权限/预算/研究配置）；不保存明文 key 只存环境变量名；标准入口不能开 dangerous 权限。
- 新增 `POST /api/settings/update`（写回 `project.yaml` + `project_settings_updated` 事件）；app shell 模型面板加 provider/model/base URL/key env/输出上限/调用预算/联网权限/搜索 endpoint；dashboard 保存后即时刷新。
- 验证：`npm test` 53 项；`verify:app-shell` 通过。

## 2026-05-29 Electron 运行时与在线验证入口
- 安装 Electron npm 依赖；官方 binary 下载卡住后改镜像源完成；增强 smoke 模式（隐藏窗口加载 app shell 后自动退出）。
- 新增并通过 `verify:electron-runtime`（证明桌面运行时能启动加载本地 dashboard）；新增 `verify:provider-online` 与 `verify:research-online`（用户提供 key/endpoint/授权后的真实在线验收）。

## 2026-05-29 Electron 目录包打包
- 安装 `electron-builder` 并新增 `package:dir`；抽取 `app-server.mjs`，Electron 主进程改为内嵌启动 app server（不再 spawn 外部 Node 脚本）。
- 新增 `verify:packaged-dir`（验证打包 exe 隐藏启动加载 dashboard 自动退出）；初次打包被 winCodeSign 缓存下载卡住，改为 dir target + `signAndEditExecutable=false` 后稳定通过；清理构建残留进程。
- 验证：`package:dir` 通过（生成 `dist-desktop/win-unpacked/WWriting Novel Agent.exe`）；`verify:packaged-dir` 通过。

## 2026-05-29 本地总验收
- 新增 `verify:local` 作为不依赖真实 key 的总验收入口，覆盖测试/MVP/20 章长跑/故障注入/app shell/desktop shell/目录包构建/打包 exe 冒烟；本轮通过，耗时约 17.7 秒，`npm test` 53 项。

## 2026-05-29 真实网页抓取在线验收
- 用户授权联网后运行 `verify:research-online`：成功抓取 `https://example.com`（受控 `fetchWebPage` 写快照，抽取正文 144 字符），验证正文抽取链路；搜索 API 在线验收仍保留为需用户配置的外部项。

## 2026-05-29 Provider / 搜索 / 安装器 / 最终验收收口
- 用一小时临时 DeepSeek key 运行 `verify:provider-online` 通过：返回 `{"ok":true,"source":"provider-online"}`，usage `prompt_tokens=20`/`completion_tokens=11`/`total_tokens=31`/`cached_tokens=0`；临时 key 只入单次 PowerShell 进程环境变量，结束后已清理并确认无残留。
- 扩展 `verify-research-online.mjs` 支持搜索 query/limit/结果路径/字段映射环境变量配置，用公开 JSON 搜索接口运行通过（抓取 144 字符 + 搜索返回 3 条）；按用户要求删除已吸收的 `shouldread.md`。
- 修复 Windows 下 Electron smoke 因 GPU/cache 初始化导致的打包 exe 冒烟失败（smoke 改为验证主进程内嵌 server + `/api/dashboard`，正常运行仍创建可见窗口）；重新生成目录包和 NSIS 安装器（`Setup.exe` 文件头有效、约 100.9 MB）；清理自有脚本 `shell:true`（剩余 `DEP0190` 警告来自 electron-builder 内部链路）。
- 最终验证：`verify:electron-runtime`/`package:dir`/`verify:packaged-dir`/`package:installer`/`verify:installer` 全通过；`verify:provider-online`（DeepSeek `deepseek-chat`）+ `verify:research-online`（真实抓取 + 真实搜索）通过；`verify:local` 通过（53 测试 + 3 章 MVP + 20 章长跑 + 8 章故障注入 + app/desktop shell + 目录包 + 打包 exe 冒烟 + NSIS 构建与产物验证）。

## 当前真实状态（阶段性收口）
- `task_plan.md` 必须实现的产品计划项已完成并有验证证据。后续增强（不阻塞）：正式代码签名、自动更新、更多 provider/search 预设、可见窗口人工 UX 巡检、真实安装/卸载手工验收。

## 2026-05-29 Codex 风格 UI / 汉化 / 项目路径打开
- 新 goal：UI 汉化 + Codex 风格布局 + 设置端/项目端分离 + 本地文件夹打开为项目路径。
- 重构 `index.html`（左活动栏/项目列表 + 中工作区 + 右设置检查器，文案改简中）、`app.js`（view 切换/项目列表/路径打开/Electron 文件夹选择器桥接/设置保存/Skill/资料工具/中文状态翻译）、`styles.css`（Codex 式三栏紧凑布局 + 响应式）。
- 扩展 `app-dashboard.mjs`（`loadProjectList`/`validateProjectRoot` + 支持显式打开 workspace 外部项目）、`app-server.mjs`（`/api/projects/list` + `/api/projects/open`，当前项目选择由服务端维护）、Electron（主进程系统文件夹 dialog + preload `selectProjectFolder()`）；更新 `verify-app-shell.mjs` 与 `app-dashboard.test.mjs`。
- 验证：`npm test` 54 项；`verify:app-shell`/`verify:desktop-shell`/`verify:electron-runtime`/`package:dir`/`verify:packaged-dir`/`package:installer`/`verify:installer` 全通过（安装器约 101.36 MB）。

## 2026-05-30 完整汉化与最终收口
- 按 `planning-with-files-zh` 恢复三份规划文档并逐项审计；进一步汉化残留英文标签：小说 Agent→小说智能体、Agent 状态→智能体状态、Skill 管理→技能管理、Provider→供应商、Key Env→密钥环境变量、Token→令牌、Checkpoint→检查点、Reviewer→审查器。
- 中文化部分服务端可见错误（无可用项目/请求过大/禁止访问/未找到/技能名无效/技能未安装/路径逃逸）；`verify-app-shell.mjs` 加完整汉化反向断言防回归；`app-dashboard.test.mjs` 适配中文错误文案。
- 确认桌面快捷方式 `C:\Users\32694\Desktop\WWriting Novel Agent.lnk` 指向 `dist-desktop\win-unpacked\WWriting Novel Agent.exe`。
- 验证：`verify:app-shell` 通过；`verify:local` 通过（54 测试 + 全链路）；产物 `win-unpacked\...exe` 约 226.9 MB、`Setup.exe` 约 101.36 MB。`planning-with-files-zh` 自带 `check-complete.ps1` 因中文字符串编码被 PowerShell 误读而解析失败（属技能脚本编码/宿主兼容问题，不影响验收）。

## 2026-05-30 原生菜单汉化与通篇审查
- 用户指出窗口左上角原生菜单仍显示 `File/Edit/View/Window/Exit`；确认是 Electron 原生应用菜单（非 app shell HTML），修复在 `electron-main.cjs`。
- 新增 `installLocalizedApplicationMenu()` 经 `Menu.buildFromTemplate`+`Menu.setApplicationMenu` 设中文菜单（文件/编辑/视图/窗口/退出及子项）；更新 `verify-desktop-shell.mjs` 静态断言主进程已接管菜单含中文标签；顺手中文化 README 面向用户的术语。
- 本轮按用户要求未重新打包（快捷方式仍指向上次 exe，菜单修复待后续打包生效）。
- 验证：`verify:desktop-shell`/`verify:app-shell`/`verify:electron-runtime` 通过；`npm test` 54 项；残留英文标签扫描未发现旧文案。

## 2026-05-30 GitHub 风格文档
- `README.md` 改写为 GitHub 首页式（定位/亮点/快速开始/桌面教程/项目文件夹/模型与联网配置/验证命令/打包/目录结构/安全设计/状态）；新增 `docs/USER_GUIDE.zh-CN.md` 详细中文教程；README 链接到指南并保留三份规划文档入口。

## 2026-05-30 Simplify 全项目代码审查
- 按 `Simplify` 角度单代理审查全项目（多代理规则限制下改单代理）。简化：`app-dashboard`/`reviewer-agent` 不再自建 `readProject` 改复用 `project-store.loadProject`；`event-log.readEvents` 支持缺失日志返回空数组 + `{limit}`，dashboard 删重复实现；`fs-utils` 新增 `isPathInside`，safeJoin/dashboard/app server/Reviewer 路径校验统一复用；`agent-engine` 新增 `withBudgetDefaults` 去重默认预算。
- 修复 `research-adapters.mjs`（`resultsPath` 非数组时返回空数组，避免 `.slice()` TypeError，加测试）；删除 `provider-adapters.mjs` 中 `prompt_cache_hit_tokens` 自引用 no-op 字段（原始字段仍经 spread 保留）。
- 验证：全项目 `node --check` 通过（53 文件）；`npm test` 55 项；`verify:app-shell`/`verify:desktop-shell`/`verify:electron-runtime`/`verify:mvp`/`verify:longrun`/`verify:faults` 通过。

## 2026-05-30 Codex 截图级 UI/UX 与第二仪表盘
- 新目标：Codex Desktop 风格 UI/UX + 参考 `D:\AI\deer-flow` 的第二仪表盘 + Simplify 子代理审查修复 + 重新打包。用 `define-goal` 建可验证目标，`planning-with-files-zh` 恢复三份文档；启动两个只读子代理调研 deer-flow 信息架构与当前 app shell 结构。
- 完成 Codex 风格 app shell 第一轮重构（浅色左导航/项目列表/中央圆角工作区/底部命令栏/独立设置页与状态检查器）；新增独立「仪表盘」视图（任务流/成本缓存/来源审查/技能/长跑进度/事件/检查点）；底部命令栏 `POST /api/commands/submit` 写入项目事件流（章节正文仍只经文件工具）。
- Simplify 子代理审查后修复：读取失败清旧数据但局部失败只显错不误清空；首次 `/api/dashboard` 自动选中项目服务端固化；任务流覆盖 `planned/needs_revision/post_process`；清空预算/搜索字段真正删除可选配置；`verify:app-shell` 改用可用端口 + DOM selector 一致性 + 第二仪表盘 + composer API 断言；保存 `max_model_calls` 同步到 `agent_state.active_budget` 运行时生效。
- 最终代码质量子代理（`019e74d4`）只读复审结论「代码质量评价：合格」，无 P0/P1/P2 阻塞，重点复核预算同步/运行时阻断/composer 拒空/dashboard `dashboardRequestId` 防旧响应覆盖/自动选中固化/任务流阶段/Codex shell 与第二仪表盘覆盖。
- 验证：`npm test` 58 项；相关 `node --check`、`verify:app-shell`/`verify:desktop-shell`/`verify:electron-runtime`/`verify:packaged-dir`/`verify:installer` 通过。

## 2026-05-30 verify:local 重跑 / Electron smoke 超时修复 / 打包交付
- 首次 `verify:local` 前置全过但 `verify:electron-runtime` 报 smoke 超时（单独运行曾通过，按偶发/超时诊断）。
- 根因：smoke 模式输出成功 JSON 后依赖 `app.quit()` 自然退出，Windows/Electron 下本地 server/fetch/Chromium 句柄偶发超 15 秒。修复：`electron-main.cjs` smoke 改为 `process.stdout.write()` 写完后关 server 并显式 `app.exit(0)`；`verify-electron-runtime.mjs`/`verify-packaged-dir.mjs` 超时阈值提到 30 秒并在超时输出 stdout/stderr。
- 重跑完整 `verify:local` 通过（58 测试 + 3 章 MVP + 20 章长跑 + 8 章故障注入 + app/desktop shell + electron runtime + package:dir + packaged-dir + package:installer + installer）。
- 产物：`win-unpacked\WWriting Novel Agent.exe` 约 226.9 MB；`Setup.exe` 101,359,537 bytes；图标源 `src/assets/app-icon.ico|png`。桌面快捷方式确认（TargetPath/WorkingDirectory/IconLocation 指向最新 exe）。后续增强：正式签名、自动更新、安装/卸载手工验收。

## 2026-05-30 空文件夹初始化与模型设置反馈
- 用户反馈：普通文件夹显示「不是有效项目」需补初始化入口；模型设置保存需明确反馈；基础 URL 要说明最终拼接处并灰字显示完整请求 URL。
- 实现 `POST /api/projects/init`（空文件夹初始化为项目，生成 `project.yaml`/`agent_state.json`/`memory/chapter_index.json`/`chapters/`/`drafts/`）；UI 打开失败后出「初始化新项目」表单（小说名/大纲/章节数/每章最低字数），成功后自动打开；设置端独立保存反馈（保存中→已保存到 project.yaml...）；基础 URL 下灰字完整请求地址（OpenAI-compatible 默认 `基础 URL/chat/completions`，mock 提示不需要）。
- 验证：相关 `node --check` 通过；`node --test project-store + app-dashboard` 7 项；`verify:app-shell` 通过；`npm test` 59 项；`verify:desktop-shell` 通过。待办：重新打包使快捷方式 exe 含最新 UI/API。

## 2026-05-30 追加体验最终打包 / 密钥环境变量误填修复
- 追加体验打包：首次 `verify:local` 因 `d3dcompiler_47.dll` 被运行中的 exe 锁定致 `package:dir` 失败；关闭进程释放锁后续完打包（`package:dir`/`verify:packaged-dir`/`verify:electron-runtime`/`package:installer`/`verify:installer` 通过）；产物 226.9 MB / `Setup.exe` 101,361,253 bytes；README + 指南补充空文件夹初始化/新项目表单/设置反馈/基础 URL 说明。
- 密钥误填修复：用户把真实 `sk-...` 填进「密钥环境变量」框致后端英文报错，供应商字段也易误填模型名。UI 改「密钥环境变量名（不是密钥）」+ 占位 `XIAOMI_MIMO_API_KEY` + 说明真实 key 先存 Windows 环境变量这里只填变量名；供应商字段加说明（OpenAI 兼容填 `openai-compatible`）；前端保存前拦截真实 key/非法变量名/供应商与模型填成同一模型名；`settings-runtime` 校验错误改中文。README + 指南加小米 Mimo 示例。
- 验证：相关 `node --check`、`node --test settings-runtime` 4 项、`verify:app-shell`、`npm test` 59 项、`verify:desktop-shell` 通过；关闭桌面进程后 `package:dir`/`verify:packaged-dir`/`package:installer`/`verify:installer` 通过；`Setup.exe` 101,361,820 bytes。

## 2026-05-30 Cherry Studio 风格模型预设配置
- 用户要求模仿 Cherry Studio：预设 DeepSeek 和 MiMo 官方配置，用户只填 API Key。
- 设置端新增 provider preset cards（DeepSeek 官方 / 小米 MiMo 官方 / 自定义）：DeepSeek 自动填 `openai-compatible`/`https://api.deepseek.com`/默认 `deepseek-v4-pro`/`DEEPSEEK_API_KEY`；MiMo 填 `https://api.xiaomimimo.com/v1`/默认 `mimo-v2.5-pro`/`XIAOMI_MIMO_API_KEY`；模型字段改下拉；新增 `API Key` password 框。
- 新增 `local-secrets.mjs`（API Key 存本机应用级 secrets 文件并注入进程环境变量，`project.yaml` 只存变量名）；Electron secrets root 指向 `app.getPath("userData")`，预览服务支持 `WWRITING_SECRETS_ROOT`；`/api/settings/update` 接收前端 key 存 secrets 后剥离 raw key；`agent-engine` 默认注册 `OpenAICompatibleAdapter` 使 DeepSeek/MiMo 进真实调用路径。README + 指南同步。
- 验证：相关 `node --check`、`node --test local-secrets+settings-runtime+provider-adapters` 10 项、`verify:app-shell` 通过；完整：`npm test` 60 项、`verify:desktop-shell`/`package:dir`/`verify:packaged-dir`/`verify:electron-runtime`/`package:installer`/`verify:installer` 通过；产物 226.9 MB / `Setup.exe` 101,363,351 bytes。

## 2026-05-30 命令栏真实启动工作流与 Codex 式运行进度
- 用户反馈：命令栏发消息后应像 Codex 一样开始工作（不只记事件），前端需明显「工作中」+ 进度条 + 步骤推进。
- 后端：`POST /api/commands/submit` 记 `user_instruction_received` 后真实启动后台 `runProject()`；运行 job 去重（已有任务时只记指令提示「正在运行中」）；已完成项目记 `project_run_skipped` 提示加章节数；已阻塞项目提示先处理阻塞；后台异常写回 `project_status=blocked` + `project_blocked`/`project_run_failed`（避免 UI 永远「工作中」）；命令栏最新写作要求进 `latest_user_feedback` 动态 prompt 块。
- 前端：新增 `run-activity` 工作流面板（智能体正在工作/当前阶段/进度条/阶段步骤）；`activityProgressPercent` 按章内阶段推进（首章运行也有非 0 进度）；阶段顺序修正为真实状态机；运行中自动轮询 dashboard（完成/阻塞/错误后停）；事件显示补 `project_run_*`。
- 验证：相关 `node --check`、`node --test agent-engine+app-dashboard` 18 项、`verify:app-shell`（覆盖真实命令启动/章节写入/已完成跳过/provider 失败转阻塞）、`npm test` 62 项、`verify:desktop-shell`/`verify:electron-runtime` 通过；最终打包 `package:dir`/`verify:packaged-dir`/`package:installer`/`verify:installer` 通过；产物 226,869,248 bytes（2026-05-30 02:55:18）/ `Setup.exe` 101,365,541 bytes（02:55:47）。

## 2026-05-30 会话1：UI 高质量化 + 工作流闭环 + UX 优化
- 验证工作流跑通：init 空文件夹 → 命令栏提交 → runProject → 2 章过字数门禁落盘 `chapters/*.md`。
- 新增应用内章节阅读器（后端 `readChapterContent` + `GET /api/chapters/read`；前端章节卡片点击/键盘打开阅读浮层，剥离 segment 标记与标题分段排版）；UI 逼近 Codex（内联 SVG 图标、自增长 textarea + 发送提示、Toast 通知、聚焦环/hover 抬升/浮层动画）。
- 验证：`npm test` 64 项（含 readChapterContent 单测）；`verify:app-shell` 通过（含章节阅读 live 测试 + 新 DOM/CSS 断言）；`verify:local` 11 步全绿，重新打包目录包 + NSIS 安装器（含新 UI）。

## 2026-05-30 会话2：按 Codex 操作逻辑全面重构 UI/UX
- 解决盲改：新增 `scripts/screenshot-app.cjs` 用 Electron capturePage 逐屏截图验证观感。
- 整屏重写 `index.html`/`styles.css`/`app.js`：左侧「我的小说」+ 主区分段标签（写作台/章节/运行/设置）+ 新手起始页 hero + 移除右侧开发者检查器（技术信息集中到「运行」tab）；统一设计 token、聚焦环、hover/脉冲/浮层/Toast 动画、自增长命令栏。
- 重写 `verify:app-shell` 断言匹配新 IA 并通过；`verify:local` 11 步全绿；重新打包目录包 + NSIS（05:07-05:08）。

## 2026-05-30 会话3：持久会话 + 防窥模式 + 高级感视觉
- 持久会话：新增 `app-state.mjs`（recents + lastProjectRoot 持久化到 `userData/app-state.json`）；app-server 启动恢复上次项目；open/init 记录；`projects/list` 改为 recents；重开应用自动回到上次小说。
- 防窥：topbar 隐私开关 + `.peek` 模糊（正文/设定/动态），hover 解模糊，Ctrl+. 快捷键，失焦加强，localStorage 记忆。高级感：渐变背景、frosted 顶栏、hero 强调条、渐变按钮/品牌标、tabular 数字。
- 验证：`npm test` 68 项（含 app-state 单测）；`verify:app-shell` 加重开恢复 + recents + 隐私断言并通过；`verify:local` 11 步全绿；重新打包目录包 + NSIS（06:08）。

## 2026-05-30 会话5：Codex 对话式终稿落地真前端 + 重打 exe（进行中）
- 触发：Claude Design handoff bundle（设计稿单文件 HTML 原型已先做出但属孤立产物）；用户指出本项目实际打包成 exe，确认目标＝把 Codex 设计落进真应用 `src/app-shell/` 并重打 exe。effort：ultracode。
- 恢复上下文：读 task_plan/progress/findings，确认成熟项目（会话4，79 测试，已交付 exe）。子代理 af5201ff 勘探出 app.js/app-server 地图：真前端原生 JS、半 Codex、四标签页+三模式输入框；后端无对话/SSE 端点仅 1.8s 轮询，对话流须前端聚合 events+chapters+summary。
- 已做：备份旧 index.html/app.js/styles.css 到 `_backup-pre-codex-*`；用设计终稿 styles.css 覆盖（894 行）；index.html 开始重写为 Codex 骨架（rail 完成，主列进行中）。
- 待续：完成 index.html 主列（topbar/thread/composer/drawer/reader/settings/toast）→ 重写 app.js 表现层 → 改 verify:app-shell 断言 → 验证 → 对抗审计 → 重打 exe。

## 2026-05-30 会话4：旁路询问（Side Question）+ Agent 状态细化
- 需求：企业级正经产品观感 + 主写作进行中可「旁路询问」，不打断、不污染主线。
- 后端：新增 `side-question.mjs`（解析/影响检测/只读上下文/在线分析或离线合成/独立 side_questions.md 日志/agentPhaseLabel）；`app-server.mjs` 新增 `POST /api/commands/ask`，submit 加 mode 与 fromSideQuestion。隔离铁律：只读不写正文/章节/agent_state/计划文件，一次性 CostTracker 不污染 cost.json，已完成项目不被重启。
- 前端：命令栏三模式（写作/旁路询问/审稿）+ 实时意图识别 + 状态行；旁路问答面板（临时提问 / 待确认变更两类，改主线给「加入正式写作任务/仅作参考」）；顶栏与命令栏状态点细化为待命/规划中/写作中/审稿中/保存中/已完成/需处理。测试新增 `side-question.test.mjs`（8 项）；`npm test` 75 项；`verify:app-shell` 扩展静态断言 + `/api/commands/ask` 实测通过。删除一次性截图脚本与 demo 产物。
- 对抗式审计（多智能体工作流：多维评审 → 逐发现反驳验证）：第一轮三维确认 6 条，独立验证者逐条确认全部 low 级、全不触及核心隔离铁律。已全修——state 空值兜底、前后端漂移守卫（verify-app-shell 逐字比对后端常量/正则）、合并重复导入、modelError 改为暴露并写日志、readOptionalText 死分支折叠、chapter_index 改用 loadChapterIndex。新增 3 测试（modelError 暴露 / 模型失败降级只写 side_questions.md / 缺失 agent_state.json 不崩溃）；`npm test` 77 项；`verify:app-shell`（含漂移守卫）通过。
- 第二轮补缺审计完备性复核：核心隔离铁律「结构上稳固、无真实漏洞」，仅存测试覆盖缺口。补强：在线模型路径全项目快照不变性测试（除 side_questions.md 外文件 sha256 前后逐字节一致，证 cost.json 不被写）、真实 buildSideQuestionClient 路径测试（stub fetch 走生产装配、验 base_url 与不污染文件）、UX 漏报正则扩充（写成/改编/黑化/洗白/写死/让…在一起等，前后端同步、漂移守卫保证一致）。`npm test` 79 项（side-question 共 12 项）；`verify:app-shell` 通过。
- 最终交付：`verify:local` 11 步全绿（含两次打包与产物校验）；重新打包并签名，产物 `win-unpacked\WWriting Novel Agent.exe`（约 226.9 MB）+ `Setup.exe`（约 96.7 MB），2026-05-30 14:24 重建。三份规划文档已精炼至约一半篇幅（总结性压缩，保留全部实质决策与验证证据）。
