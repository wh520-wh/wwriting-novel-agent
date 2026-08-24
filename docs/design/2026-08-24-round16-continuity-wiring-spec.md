# 2026-08-24 第十六轮规格：长篇记忆接线与清欠收口（continuity-wiring）

## 一句话

把六月写成、八月控制面替换时断线的「前情小抄」以 `read_continuity` 工具形态接回（按需拉取、缓存零损失），给 continuity.json 增设伏笔台账并由 AI 在记忆三件套流程里自动记账；顺手清掉十五轮登记的全部结构欠账（R1 例外清零）与测试/文档债。

## 背景

- 八派探索结论：内核依赖图无环（该歇）、数据安全已是强项（writeFileAtomic 全覆盖）、缓修清单大幅缩水（M5/F22 已解决、F18 死链、其余继续缓）；唯一创造新价值的方向是写作域——`chapter-memory.mjs` 的 `buildContinuityPromptContext`/`buildRelevantFacts` 写好后零调用方，`run-pipeline.mjs:353` 硬编码 `dynamicContext: []`。
- 考古结论：旧控制面（曾调用这两个函数拼 dynamicBlocks.project_memory）在 78c313f「replace legacy agent and conversation control planes」被整体替换，连贯性注入随之孤儿化；替换理由（Task 7 工作流退役、模型自主读文件）**未点名连贯性注入**。接回不是翻案，是复原中断的设计——`buildRelevantFacts` 输出文案里至今写着「更多可用 read_continuity 工具按实体查」，该工具从未存在。
- 用户三决定（2026-08-24 访谈）：① 工具按需拉取而非每轮注入（缓存命中率优先）；② 伏笔台账由 AI 在记忆三件套里自动记；③ 完读率回放推十七轮。

## 决策

- **D1 连贯性供给走工具拉取，不做系统注入**（ADR 0007）。系统提示永久稳定 → 供应商前缀缓存零损失；小抄只在模型主动调用时进入对话历史，随历史自然缓存。新增 `read_continuity` 工具，`dynamicContext` 槽位保持空置。
- **D2 read_continuity 双模式**：无参 = 章节前情简报（`buildContinuityPromptContext`：近 2 章结尾 900 字摘录 + `buildRelevantFacts`：近 5 章 facts/12 角色/8 时间线 + 未回收伏笔 top 5）；`entity` 参数 = 按实体查全量 facts（兑现 chapter-memory.mjs:104 的历史文案）。当前章节号缺省 = 最新入账章节 + 1（读 chapter_index 派生）。
- **D3 伏笔 schema（continuity v2）**：`foreshadows: [{ content, planted_chapter, expected_payoff_hint?, status: "open"|"paid", paid_chapter? }]`。合并语义：`open` 条目按 content 去重后追加；`paid` 条目按 content 精确匹配最近的 open 条目置为 paid（paid_chapter = 本次 chapter_no）。存量 continuity.json 无字段默认 `[]`，不做迁移。渲染进 continuity.md 一个「伏笔台账」小节（open 在前按埋设章排序）。
- **D4 记账入口 = update_memory**：schema 增 `foreshadows` 数组（`additionalProperties: false` 需显式加），描述文案说明「新埋伏笔记 open、回收伏笔按原文 content 记 paid」；章节三工具的 memory_checklist 提醒文案加伏笔职责一句。
- **D5 防呆提醒不做**：先靠 T7 的模拟场景观察模型守不守「动笔前必查」规矩，常忘再补工具结果提醒（十六轮内不实现）。
- **D6 非目标里的 CSS**：结构债派实测 `.agent-markdown`/`.agent-surface` 等 5 处刻意跨文件耦合（agent.css:1-18 token 所有权设计），拆分无收益，R1 也不覆盖 CSS——从十五轮遗留候选中剔除。

## 任务

### 波A 主菜：记忆接线（T1-T7）

- **T1 read_continuity 工具**：注册进 `definitions-knowledge.mjs`（与 read_skill/count_text/update_memory 同域），interruptible: false；handler 组装 D2 两种模式；薄单测钉住简报组成与 entity 模式。
- **T2 政策硬规矩**：`prompt.mjs` UNIFIED_TASK_POLICY 增一行「动笔写任何章节之前，必须先调 read_continuity 获取前情简报」；断言提示文本含该规矩（防回归删除）。
- **T3 continuity v2**：`continuity-store.mjs` 四处（EMPTY/normalize/mergeExtraction/renderContinuityMarkdown）增 foreshadows；兼容性测试（无字段旧文件读写不炸、open/paid 合并语义、去重）。
- **T4 update_memory 扩展**：schema + description 增 foreshadows（definitions-knowledge.mjs:90）；memory_checklist 文案更新（definitions-chapter.mjs 三处）。
- **T5 前情简报含伏笔**：read_continuity 无参模式追加「未回收伏笔」段（open 按 planted_chapter 距今降序 top 5，带埋设章号与 expected_payoff_hint）。
- **T6 ADR 0007**：《连贯性供给走工具拉取而非系统注入》——决定、缓存论据、78c313f 考古结论、与 dynamicContext 槽位的关系。
- **T7 sim:user-flow 增场景**：mock 模式加「写第 2 章前模型调用了 read_continuity」断言（观察守规矩情况，为 D5 提供证据）；若现有 mock 驱动不支持工具调用循环，降级为「工具可调用 + 政策文本在场」断言并在执行记录登记偏差。

### 波B 结构清欠（T8-T10，拆分只搬不改）

- **T8 settings-modal 技能区一刀**：抽 738-1109 技能区为 `settings-modal-skills.js` 工厂（deps 对象传 9 个共享引用，见 settings-modal.js:742-760），1346 → 约 990 落红线内。
- **T9 app.js 抽主题/隐私块**：1114-1179（initThemeMode…applyPrivacyState，零共享可变态）抽独立模块，1197 → 约 1131，余量恢复。
- **T10 守卫例外清零**：`tests/architecture/dependency-rules.test.mjs:594-596` 删例外条目，:625 断言改 `size === 0`。R1 从「防复发+一例外」变为绝对线。

### 波C 测试与工程清扫（T11-T15）

- **T11 tests/helpers 共享层**：tmpdir 脚手架 + 假 agent ctx + makeEvent 事件工厂三件；新建测试一律使用，存量 54 处按触碰迁移、不强改。
- **T12 cards.mjs 行为测试**：唯一零覆盖分区补行为级单测。
- **T13 忙等根治**：`tools.test.mjs:67` 真 sleep 与 :171-172 忙等轮询换 `node:test` mock.timers。
- **T14 F18 死链删除**：`project-diagnostics.mjs:68` runningCount 及相悖的 waiting_user 文案（前端零消费方，已核实）。
- **T15 文档清扫**：`chat-logic-optimization-plan.md`/`find-bugs-report.md`（08-17 已过时的计划书，git 历史可找回）与未入库的 `UI美化建议.md`/`AICSS组件移植设计规格书.md`（早期设计稿，对应研究版已在 docs/research/）直接删除；`CLAUDE.md`（07-31）刷新对齐 AGENTS.md 与现实。

## 非目标

CSS 拆分（D6）、内核深挖、M3/M4/F19-F21 缓修项、真实 API 复跑、发布与打包事项、完读率回放（十七轮开场）、防呆提醒（D5）、伏笔管理 UI（对话内让 AI 改台账即可）。

## 验收门禁

1. `npm test` 全量全绿（基线 1953 + T1/T3/T5/T7/T12 新增）。
2. 守卫三规则全绿，R1 例外清单 `size === 0`。
3. UI 三件套 `verify:app-clickability` / `verify:app-shell` / `verify:desktop-shell` 全 0——**T8/T9 属入口类改动，必须过 clickability**（十五轮 refs 分桶教训：app-shell 单测不执行 app.js）。
4. `sim:user-flow` mock 模式 21/21 + T7 新场景。
5. 视觉基线 round-16 vs round-15 逐图对比无稳态回归（settings-modal/app.js 拆分应为像素级一致）。
6. 行数对账：settings-modal.js ≤1200 落线（唯一例外注销）、app.js ≤1150 余量恢复。

## 执行顺序与回归策略

波A → 波B → 波C。波A 是行为新增（有新测试）；波B 严格等价搬运（回归只能来自搬动，视觉基线兜底）；波C 纯测试/死链/文档。收口：全量回归 + 门禁 1-6 + WWRITING.md 十六回写。

## 遗留下轮

- 完读率回放（十七轮开场，与本轮共用 chapter_memory 数据底座）。
- 防呆提醒：视 T7 观察结果决定。
- 真实 API 模式 sim:user-flow 复跑与窗口口径实测（需 API key，本轮明示排除）。

## 执行记录（回填）

**概况**：波A 主菜（T1-T7）与波B（T8-T10）、波C（T11-T15）全部落地；T20-T24 追加 whfind-bugs #1-#5 紧急修复入波D；收口任务（执行期编号 T25）回填本文档并提交。本轮 18 个提交（a652052 → 3ee1cd2）。**编号漂移说明**：提交信息与守卫注释中的 T10-T13/T15-T18 为执行期编号，与计划编号差 2-3 位——计划 T8/T9（波B 拆分）执行期落为 T11/T12，计划 T10（守卫清零）为 T13，计划 T12/T13/T14/T15 分别执行期为 T15/T16/T17/T18。文件头「T12/T15」等双编号口径为计划原文，保持原样。

### 预登记偏差八条实际状态

1. **① T11 makeEvent 合并推迟**：未做，遗留登记照旧（helpers 共享层仅 tmpdir 脚手架 + 假 agent ctx 落地，事件工厂留待后续轮次顺带）。
2. **② T13 收窄（sleep 保留、waitForEvents 改迭代上限）**：T16 落地——`tools.test.mjs:170` `waitForEvents` 去墙钟，`maxPolls = 500` 迭代上限（成功路径零等待，失败 500 次轮询到点断言）；真 sleep 用例保留。tools.test.mjs 单跑 69/69 绿。
3. **③ Task 1 裁撤**：无代码、无提交（sim 冒烟观察所需，直接在 T7 补断言）。
4. **④ T4 checklist 落点**：`MEMORY_CHECKLIST` 常量（`src/core/agent/runtime.mjs:89`）+ `definitions-chapter.mjs` 三处文案（:144/:191/:239，均含「update_memory（含新埋（open）与回收（paid）的伏笔）」）+ 两处逐字断言同步，T8 落地。
5. **⑤ continuity schema v3 且 mergeExtraction 版本归一**：`src/core/continuity-store.mjs` `CONTINUITY_SCHEMA_VERSION = 3`，normalize/mergeExtraction/render 四处归一，open 去重追加、paid 精确匹配置位语义按 D3 实现，T2 落地。
6. **⑥ 缺省章号来源统一为 chapter_memory**：T5 实际落地为 `chapter-memory.mjs:195-197` 从 `memory.chapters.at(-1)?.chapter_no + 1` 派生（读 `memory/chapter_memory.json`），**规格 D2 原文「读 chapter_index 派生」此处订正为「读 chapter_memory 派生」**（chapter_index 是索引数组，缺省章号口径以 chapter_memory 入账章节为准）。
7. **⑦ whfind-bugs #1-#5 入波D**：T20-T24 落地（对应 `docs/memory/2026-08-24-bug-hunt-report.md`）；#6/#7 遗留十七轮；#2 次要面（密钥脱敏名单可变容器）遗留。
8. **⑧ 归档文件名互不影响**：新归档 `docs/memory/2026-08-24-bug-hunt-report.md` 与旧 `docs/find-bugs-report.md`（08-17 已删）命名空间分离，T18 落地。

### 执行期新发现（本轮实测）

- **T11/T12（波B 拆分）**：settings-modal 技能区抽 `settings-modal-skills.js`（404 行，deps 九引用）；主题/隐私块抽 `theme-privacy.js`（72 行，零共享可变态）；app.js 1197→1130，init 前移到 :107 早位接线（行为不变）；jsdom 区单跑 661/661 全绿。
- **T13（守卫清零）**：R1 例外清单删除、断言改逐文件 ≤1200 红线绝对化（`dependency-rules.test.mjs:597/619-625`）；收口实测扫描 124 文件全落线，最大 1184（`src/core/agent/journal.mjs`）。注释「第十六轮 T10」为计划原文字样（拆分实为 T11/T12），保持。
- **T14（verify-app-shell 静态契约）**：契约的 SKILL_SOURCE_LABELS 断言仍指向旧 settings-modal.js，未随波B 迁移 → T14.1 修复（断言改拉取 `settings-modal-skills.js`，`verify-app-shell.mjs:74/114`）。clickability 21/21；视觉基线归档 `artifacts/visual-acceptance/2026-08-24-round16/round-01/`（51 文件，与 round-15 无稳态差异）。
- **T15（cards 补覆盖）**：`tests/app-shell/view-cards.test.mjs` 新增 5 测试 + SURFACE_SEAM_TESTS 登记（`dependency-rules.test.mjs:362`）；jsdom 区从 T12 的 656 增至实测 661（656+5）；质量环修正 syncQueue 断言钉死行关联（e25ef90）。
- **T17（F18 死链删除）**：summarizeSession 删 5 个死字段（runningCount/interruptedCount/cancelledCount/blockedCount/completedCount）+ `waiting_user` 相悖文案分支（前端零消费，F4 渲染点承担提示）；后续事项——`session-sidebar.mjs:44-46` 维护契约注释仍把 buildRecoveryHint 列入同步名单，已与新语义分歧（runActive 不再含 waiting_user），留十七轮顺带订正。
- **T18（文档清扫）**：四文档删除（含两处路径订正：AICSS/UI 美化建议实际在 `docs/design/` 且被跟踪，git rm 处理）；根 `find-bugs-report.md` 归档至 `docs/memory/`；`CLAUDE.md` 刷新 63→51 行且按用户要求（`.gitignore:16`）不入库仅落工作树；死链 grep 残留 8 处命中全部为历史记录文件（round10/12/9 规格、竞争研究、既往 plans），有意保留不编辑。
- **T20（兄弟点顺带修）**：除 journal.mjs 四投影助手外，按 AGENTS.md「grep 全部调用方」顺带修复同 bug 类兄弟点 `compaction.mjs:407` loadEntry（readTail 尾部窗口）；守卫测试扩展为两文件循环断言，compaction.test.mjs mock 补 readTail。
- **T22（取消语义实测适配）**：手动 in-run 取消只终结 compact item、队列存活；测试断言 `.at(-1)+reason` 过滤（open() 对账先落 process_restarted 事件的实测适配）；活体路径与 retry-after-cancel 覆盖留十七轮。
- **T23（dashboard 陈旧成本冲刷）**：dashboardLoader 用 `options.projectRoot`（非 workspaceRootArg——多项目工作区正确性）；flushDirty 错误处理分层（leaf 诚实抛、wrapper 吞错+warn）；测试补无脏不写断言。
- **T24（守卫死路收窄）**：守卫初版纯状态检查被质量审查抓出死路（failed→cancel→submit 永久锁死）→ 收窄为「run 非终态 + failed」才拒（3ee1cd2）；compaction_failed_blocked 进 SAFE_PUBLIC_ERROR_CODES 白名单（六 code 同待遇，不加 STATUS_409）；文案被测试钉死。

### 全量门禁实测（收口 T25）

| 门禁 | 结果 |
| --- | --- |
| `npm test` | exit 0，**1974/1974** 全绿（基线 1953 + 波A/波C 增量） |
| `node --test "tests/architecture/*.test.mjs"`（裸目录在 Node v25 报错，用 glob 引号形式） | exit 0，16/16（守卫三规则 R1/R2/R3 全绿，R1 零例外） |
| `npm run sim:user-flow` | exit 0，**22/22** 阶段（T7 场景插针后 21→22） |
| `npm run verify:app-clickability` | exit 0，**21/21** 点击 + 21/21 expectationPassed（控制台 set-title-bar-theme 未注册噪音为既有项，不影响退出码） |
| `npm run verify:app-shell` | exit 0 |
| `npm run verify:desktop-shell` | exit 0 |
| 行数对账 | settings-modal.js **994**（≤1200）、app.js **1130**（≤1150 余量 20） |
| 视觉基线 | capture-all-ui 已在 T14 采样归档，本轮不重跑 |

### 提交清单（关键节点，a652052 → 3ee1cd2 共 18 个）

- a652052 技能区拆出 settings-modal-skills（T11）→ d350a4e 主题/隐私块抽 theme-privacy（T12）→ 36d638a R1 例外清零（T13）→ 3c2f2f4 verify-app-shell 契约指向新模块（T14）→ c46f6ed/e25ef90 cards 测试+seam 登记、syncQueue 断言钉死（T15）→ 899e136 waitForEvents 去墙钟（T16）→ fc7d180 F18 死字段删除（T17）→ a223a6d 文档清扫+CLAUDE.md 对齐（T18）→ 133f2ac/7a92917 readTail 尾部窗口（T20 + 兄弟点）→ 303677d 密钥即时注入（T21）→ 677e95a 手动取消保队列（T22）→ 9e7a2fd/8d548c5 成本冲刷（T23）→ 2ee423b/f3100de/3ee1cd2 守卫收窄+文案白名单（T24）。
