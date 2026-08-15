# 第九轮设计规格 v2：记忆体系重构 · 版本时间线与恢复 UI · 任务计划面板 · 断点恢复

> 文档性质：**设计规格文件**（Design Spec），不是执行计划。执行计划见 `docs/superpowers/plans/2026-08-15-第九轮-完整执行计划.md`。
> 版本：v2（对抗审查修正版）· 日期：2026-08-15 · 依据：第九轮需求对齐（多轮 grilling 决策 + 独立对抗审查报告）。
> 适用仓库：`D:\WWriting`，基线 master HEAD **`715ffde`**（第八轮欠账收尾已由收尾线入库：模型分区列宽修复 + 2026-08-14-polish 截图证据）。
> v2 修订记录：修正提示词对顶（H1）、rebuild-memory 去留（H2）、mock 模式断言矛盾（H3）、截图模式交付物（H4）、对话事件管道机制（H5）、工具描述同步（H6）、book_summary 消费者清单（M1）、保护边界简化（M2）、记忆版本库签名（M3）、落盘函数删除分支（M4）、settings 死配置（M6）、基线 HEAD（M7）、tmp 脚本（M8）、测试行号（M9）、场景 32 与 31b 区分（M10）；新增 §3.6 任务计划面板（用户追加需求）。

---

## 1. 目标与根本问题（第一性原理陈述）

### 1.1 本轮要修的根本问题

记忆体系的所有权错位：**由系统在背后发起一次独立模型调用来"理解"章节并提取记忆**（第八轮契约中的 memoryExtractor）。它与本项目两条已确立原则冲突：

1. "系统代码不替 AI 理解项目进度"——独立提取器正是系统发起的独立理解；
2. 写作与记忆分裂成两个 AI，记忆与正文脱节；独立调用上下文全新，提示词前缀缓存命中率低、费 token。

### 1.2 目标系统（设计完毕后的样子）

- **同一个写作模型在自己的工作流内自己维护记忆**：写完/提交/入账/回滚后，模型自己调记忆工具、自己读既有档案、自己产出更新内容。
- **系统只做三件事**：校验（轻量门禁）、确定性合并、落盘。**不做兜底**（无系统滞后检测、无自动补提取、无"维护任务"）。
- **权威账本仍归系统**：章节索引、checkpoint、版本库、项目配置、会话日志——一行不变。
- **人可读的记忆文件归 AI 自由维护**：故事摘要、工作日志，放开直写、系统不解析。

### 1.3 分层与所有权总表（领域模型）

| 层 | 文件 | 写者 | 保护 | 用途 |
|---|---|---|---|---|
| AI 自由文本层 | 项目根 `book_summary.md`（全书摘要：**故事讲到哪了**） | AI 用 write_file/edit_file 直写，系统不锁、不校验、不自动生成 | **放开** | 恢复写作时读它知道故事状态 |
| AI 自由文本层 | 项目根 `WORKLOG.md`（工作日志：**活干到哪了/下一步/注意点**） | 同上 | **放开** | 断点续跑时读它知道任务进度；用户也会看 |
| 系统结构化档案层 | `memory/continuity.json` + `memory/continuity.md`（设定档案：facts/timeline/characters，严格格式） | **只能通过 `update_memory` 工具修改**；系统校验+增量合并+落盘+重渲染 md | **锁** | 设定一致性；UI 只读展示 |
| 程序权威账本层 | `memory/chapter_index.json`、`memory/chapter_memory.json`、`checkpoints/`、`.versions/`、`project.yaml`、`.wwriting/`、`drafts/` | 系统 | **锁（现状不变）** | 权威状态 |

**核心不变量**（必须恒真）：
- I1：设定档案的每条记录只指向**真实存在的章节**（轻量门禁）。
- I2：权威账本文件只能被系统代码写入（模型任何通用工具都碰不到）。
- I3：AI 自由文本文件系统永不解析其内容、永不自动生成/修改。
- I4：`continuity.md` 恒等于 `continuity.json` 的渲染打印件（只有工具触发重印，无原件/打印件漂移）。
- I5：记忆内容永不进入系统提示词 / 首条消息 / 上下文包（缓存友好，见 §7.1）。

### 1.4 策略判定（preserve / reshape / replace / delete）

- **Preserve（保留）**：`mergeExtraction` 幂等合并与冲突标记（`continuity-store.mjs:41-71`）、`renderContinuityMarkdown`、`loadContinuity`、原子写+失败回滚机制、`checkTimeline` 时间线门禁、章节四件套事务（`chapter.mjs` commit/finalize）、`.versions/` 章节快照与 `rollbackChapter` 语义、journal 重放/retry/压缩 checkpoint、run_log 领域事件机制、`PROTECTED_RULES` 的 memory/ 目录级保护。
- **Reshape（重塑）**：
  - `commitChapterMemory`（`chapter.mjs:886-1002`）→ 收缩为 update_memory 的系统侧落盘函数（详见 §2.2）；
  - `memory-extractor.mjs` 的 normalize 逻辑 → 重塑为 `update_memory` 工具参数校验（§2.4/§2.2）；
  - `runtime.mjs` 派生记忆包装（148-220、311、343-353）→ 删除，commit/finalize/rollback 结果改为固定提醒行；
  - `tools.mjs` 的 `commit_chapter`（1430-1474）与 `finalize_revision`（1478-1525）工具 **description** → 删除 memory_update 语义、改为三件套提醒说明；
  - `prompt.mjs` `UNIFIED_TASK_POLICY` 157 行（memory/ 只读口径）与 167 行（"不保证全书摘要同步…由独立记忆提取或维护任务重建"）→ 改写为三件套纪律（§2.3）；
  - `simulate-user-flow.mjs` → mock 剧本补三件套步骤 + env 门控真实模式（§5.1）；
  - `verify-unified-agent.mjs` → 补记忆维护场景 + 场景 32（§4.3）。
- **Replace（替换）**：记忆写入路径——后台提取器整体退役，由模型自调用 `update_memory` 工具取代。
- **Delete（删除）**：
  - `memory/.pending-extraction-*.json` 暂存机制（`chapter.mjs:890-897,966`）；
  - `continuity_state.json` 的 `last_extracted_chapter`/`extracted_chapters` 水位——**continuity_state.json 整体退役**（不再读写；`continuity-store.mjs:112-139` 的 load/saveContinuityState 删除；磁盘上旧项目的残留文件不动、无害）；
  - `memory-extractor.mjs` 的 SYSTEM_PROMPT（39-53）与 `buildMemoryExtractionMessages`（55-72）、`parseMemoryExtraction`（75-86）与 registerSchema 注册（无消费者后连带删除）；
  - `runtime.mjs` 派生记忆包装（148-220）与 `memoryExtractor` 注入参数（311）；
  - `app-server.mjs` 未接线的提取器组合根；
  - **`scripts/rebuild-memory.mjs` 整体删除** + `package.json` 的 `audit:rebuild-memory` 命令（其写 `memory/book_summary.md` 且提示词承诺"由独立记忆提取或维护任务重建"——正是被消灭的架构；执行时 grep 确认无其他引用一并删）；
  - **`src/core/settings-runtime.mjs:113-170,315` 的 `memory_extraction` 设置节 + `tests/settings-runtime.test.mjs:251-285` 对应用例**（提取器退休后语义悬空的死配置）。

---

## 2. 模块 ①：记忆体系重构规格

### 2.1 文件布局与迁移

| 变化 | 内容 |
|---|---|
| 新增 | 项目根 `WORKLOG.md`：新项目创建时写入占位 `# WORKLOG` 一行；老项目打开时若无则补建。 |
| 迁移 | `memory/book_summary.md` → 项目根 `book_summary.md`（老项目自动搬家）。若两处都有：**根目录版优先**，`memory/` 里的旧版改名 `book_summary.md.bak` 留底，一字不丢。迁移幂等（根已存在且无旧版时不动作）。 |
| 不变 | `memory/continuity.json`、`memory/continuity.md`、`memory/chapter_index.json`、`memory/chapter_memory.json` 路径与格式不变。 |

**必须同步修改的消费者（搬家影响面，执行时逐项核对）**：
- `src/core/project-store.mjs:74`（`createProjectAt` 初始化写 `memory/book_summary.md` → 改为写项目根 `book_summary.md` 并新增 `WORKLOG.md` 占位）；
- `tests/helpers/project-agent-harness.mjs:150`（fixture 写 `memory/book_summary.md` → 根目录）；
- `scripts/simulate-user-flow.mjs:183`（`buildProperProject` 写 `memory/book_summary.md` → 根目录）；
- `tests/agent/project-agent.test.mjs:1593` 与 `tests/project-operations/chapter.test.mjs:746-985` 中读 `memory/book_summary.md` 的断言（→ 根目录）。

### 2.2 新工具 `update_memory`（深工具，第六个）

**归属**：项目专属深工具（deep）。现有深工具五件套：`update_plan` / `append_chapter_segment` / `commit_chapter` / `finalize_revision` / `rollback_chapter`；本轮起六件套。UI 卡片标题「更新设定档案」。

**系统侧落盘函数**：由 `commitChapterMemory` 收缩重写为新函数（建议导出名 `updateMemoryFromExtraction`，`projectOperations` 已暴露 `commitChapterMemory` 字段（`runtime.mjs:343-353`），接线零成本）。重写后：
- **删除**：pending 读取（890-897）、`expectedChapterChecksum` 指纹校验（910-921）、水位计算与 `continuity_state.json` 写入（930-942、948、964-965）、`book_summary.md` 写入（929、947、963）、`summary_updated` 返回字段；
- **新增**：引用章节存在性门禁（见下）；
- **保留**：`loadContinuity` → `mergeExtraction` → 原子写 `continuity.json` + `continuity.md`（renderContinuityMarkdown）→ 失败备份回滚 → `checkTimeline` violations 过滤本章（989-991）。

**参数 schema**（重塑自 `memory_extraction@v1` normalize，**不含 summary 字段**——摘要归自由文本层）：

```jsonc
{
  "chapter_no": 1,              // 本次更新针对的章节（门禁校验 + 返回报告用）
  "facts": [                    // 只交"本章新增或被修正"的客观设定
    { "entity": "实体名", "attribute": "属性", "value": "值",
      "chapter_no": 1, "quote": "原文短引(≤80字)" }
  ],
  "timeline": [
    { "chapter_no": 1, "story_time_raw": "故事内时间原话",
      "events": ["事件"], 
      "time": { "kind": "scene|flashback|parallel|dream", "elapsed": "+0|+3d|...|null",
                "anchor": {"type":"date|age|named","raw":"原文","subject":"age 时填"} | null,
                "confidence": "high|low" } }
  ],
  "characters": [
    { "name": "角色名", "traits": ["特征"], "status": "状态", "chapter_no": 1 }
  ]
}
```

（阈值与 `memory-extractor.mjs` normalize 一致：quote ≤80、facts/timeline/characters 各 ≤50 条、events ≤10、traits ≤10；normalize 函数即参数校验实现，工具执行前先过一遍再落盘。）

**门禁（轻量门禁，Q29=A）**：只校验章节存在——`chapter_no` 与所有条目内 `chapter_no` 引用的章节，满足其一即可：chapter_index 有记录 **或** 正式章节文件存在于磁盘。不存在 → 工具错误 `chapter_not_found`（错误文案点名"第 N 章文件不存在"，模型改章号或先写章再重试）。**不**比对正文指纹、**不**强制先 finalize 入账。

**合并（复用现有件）**：`mergeExtraction`——facts 按 entity+attribute+value 去重、同属性不同值标 `conflict_with` 冲突标记（照实记、不调和）、timeline 按章号+事件串去重、characters 按名合并 traits（≤10）与最新 status、单实体 facts 上限 20。幂等：重复调用安全。

**返回**：`{ ok, chapter_no, facts_added, timeline_added, characters_added, timeline_violations }`（去掉 `summary_updated`；`timeline_violations` 沿用"较晚一方=本章"过滤语义，供模型自查）。

**错误码**：`chapter_not_found`、`extraction_missing`（空参数）保留；`chapter_checksum_mismatch` 删除。

### 2.3 提交/入账/回滚后的记忆维护纪律（Q30=A，三件全强制）

提示词强约束：`commit_chapter` / `finalize_revision` / `rollback_chapter` 成功后，模型**必须按顺序**完成三件事：

1. 调 `update_memory`（本章新增/修正的设定）；
2. 更新 `book_summary.md`（故事讲到哪：主线、关键事实、未回收伏笔）；
3. 更新 `WORKLOG.md`（活干到哪：刚完成什么、下一步打算、临时决策、注意点；建议要素不强制格式）。

**提示词改写点（必须改，现行文字与新契约直接对顶）**：
- `src/core/agent/prompt.mjs:157`：「系统文件只读：…memory/ 记忆档案…」→ 改为「memory/ 记忆档案只读；设定档案请用 update_memory 工具更新」；
- `src/core/agent/prompt.mjs:167`：删除「但不保证全书摘要与连续性档案同步——它们是派生数据，由提交后的独立记忆提取或维护任务重建，不要声称 commit 已更新全书摘要」整句，替换为「提交/入账/回滚后必须依次：update_memory → 更新 book_summary.md → 更新 WORKLOG.md，三件缺一不得声称完成」。

**固定提醒行（Q22=A）**：三个深工具（commit/finalize/rollback）的返回结果里保留一行固定提醒（内容写死，不随状态变化）：

> `记忆维护：请依次 update_memory → 更新 book_summary.md → 更新 WORKLOG.md`

实现位置：runtime 层在 `commitChapter`/`finalizeChapter`/`rollbackChapter` 结果上附加 `memory_checklist` 字段（替代删除的派生包装）；**三个工具的 description 同步改写**（`tools.mjs:1432/1481/1528 附近`），删除 `memory_update`（ok/skipped/failed）语义描述。旧的 `memory_update:{status:ok|skipped|failed}` 字段**删除**。

**回滚特殊性**：回滚后正文退回旧版，记忆/摘要/日志可能对应旧内容——三件套同样强制执行，模型按回滚后的正文重述。

### 2.4 （删除清单并入 §1.4，此处从略）

### 2.5 路径保护边界（简化设计：目录级保护不变）

- `PROTECTED_RULES.memory_files`（`tools.mjs:113`）**保持目录级保护**：`memory/` 下全部文件（含迁移产生的 `book_summary.md.bak`、旧项目残留的 `continuity_state.json`）通用工具只读——书摘要搬走后 memory/ 内不再有任何需要放开 AI 直写的文件，逐文件解锁反而留漏洞。
- 拒绝文案（`PROTECTED_DENIAL_MESSAGES.memory_files`，`tools.mjs:123`）改为：「记忆档案为系统文件，只读；设定档案请用 update_memory 工具更新。」
- `SAFE_EDIT_CONTENT_REL`（`tools.mjs:104`）的 `memory` 条目保留不动。
- 根目录 `book_summary.md`、`WORKLOG.md` 是普通文件，write_file/edit_file 天然可写，无需新规则。
- 读取侧不变：模型可 read_file 读任何记忆文件。

### 2.6 版本快照扩展（Q31=A + C1=A + d1=A）

- **纳入**：`WORKLOG.md` 与 `book_summary.md` 在 `commitChapter` / `finalizeChapter` / `rollbackChapter` 的派生归档阶段存档（与章节快照同点、同"失败不阻塞"语义）。
- **布局**：`.versions/memory/worklog/`、`.versions/memory/book_summary/`，各含 `v{n}.md`（当时文件全文）与 `manifest.json`：
  `{ "file": "worklog"|"book_summary", "versions": [ { "version": 1, "timestamp": ISO, "source": "commit"|"revision"|"rollback", "checksum": sha256 } ] }`
- **函数（签名级，新增于 versions.mjs 或新模块 `memory-versions.mjs`）**：
  - `snapshotMemoryFile({ projectRoot, file, content, source }) -> { version }`（追加 v{n}.md + manifest；版本数超上限删最老版本文件并重写 manifest）；
  - `listMemoryVersions({ projectRoot, file }) -> { file, versions }`（无版本 → 空数组；manifest 缺失 → `no_versions`）；
  - `readMemoryVersion({ projectRoot, file, version }) -> { file, version, content, checksum }`（不存在 → `version_not_found`）；
  - 内部常量 `MEMORY_VERSION_CAP = 200`。
- **上限（d1=A）**：每文件保留**最近 200 版**，超限删最老（幂等：`nextVersion` 继续递增，版本号不复用）。
- **不纳入（C1=A）**：设定档案 continuity 不进版本库——追加式+冲突标记已可纠错，范围控制。
- 章节快照机制（`.versions/chapters/`，append-only）不变。

### 2.7 提示词与缓存友好规则（结构红线，§7 展开）

- 记忆文件内容**绝不**进系统提示词、首条消息、上下文包；模型按需 read_file。
- 三件套是提交对话**尾部**的工具调用，不破坏前缀缓存。
- 开发期提示词可迭代修改；**成型版冻结后保持稳定**（工具未上线，开发期改提示词不受限）。

### 2.8 WWRITING.md 纪律

- 定位不变：长期项目记忆入口（项目定位/当前有效要求/权威文件清单/当前进度/持久事实/待确认），**不是进度日志**。
- 写纪律：只写"用户确认过或文件可证"的长期事实；模型可维护其内容（纪律约束，不设路径写禁区）。
- 本轮执行时按新职责更新一次 WWRITING.md（记忆体系现状、权威文件清单、当前进度）。

---

## 3. 模块 ②：UI 版本时间线 + 恢复 + 抽屉「记忆」分区 + 任务计划面板

### 3.1 服务端端点（`src/core/http/project-routes.mjs`，路由 handler 一律 `async ({body,query,...})`）

| 端点 | 语义 |
|---|---|
| `GET /api/chapters/versions?project_id=&chapter_no=` | 章节版本列表（version/timestamp/source/checksum；UI 不显示 checksum） |
| `GET /api/chapters/versions/content?project_id=&chapter_no=&version=` | 指定版本正文（衬线预览用） |
| `POST /api/chapters/rollback` | UI 恢复章节：`{project_id, chapter_no, version?}`，经 `withProjectLock`（`project-routes.mjs:123-128`）+ `resolveActiveWriteProjectRoot` + `assertNotArchived`（参照 export-book 413-421 模式）；复用 `rollbackChapter` 全语义 |
| `GET /api/memory/versions?project_id=&file=worklog\|book_summary` | 记忆文件版本列表 |
| `GET /api/memory/versions/content?project_id=&file=&version=` | 指定版本内容（预览） |
| `POST /api/memory/versions/restore` | UI 恢复记忆文件：`{project_id, file, version}`；写回文件 + run_log 领域审计 |
| `GET /api/memory/files/content?project_id=&file=worklog\|book_summary\|continuity` | 记忆文件当前内容读取（抽屉「记忆」分区三块展示用；file 白名单，防任意路径读） |

**运行中互斥（c3=A）**：两个恢复类 POST 在执行前检查该项目会话 `active_run.status === "running"` → 返回 409 `{code:"agent_running"}`，UI 表现为恢复按钮禁用并提示「写作进行中，暂停后恢复」。读取类 GET 不受限。

**对话事件注入（d6=A，机制补齐——审查发现 run_log 与对话 SSE 是两条管道）**：
- run_log（`event-log.mjs` appendEvent）是**项目领域审计**，不进对话 SSE；对话事件走 **session journal**。
- 新增 agent 门面方法：`agent.appendSystemEvent({ projectRoot, type, payload }) -> { seq }`——向项目活跃会话的 journal 追加系统事件（`run_id: null`）。journal reducer 放行白名单类型：`chapter_rolled_back`、`memory_file_restored`（执行时若 reducer 拒绝未知类型，则把这两类加入其允许列表，不改其他校验）。
- HTTP 恢复成功路径：领域操作（rollbackChapter / 写回记忆文件）成功后调 `appendSystemEvent`（type `chapter_rolled_back` payload 含 from/to_version，或 `memory_file_restored` payload 含 file/from/to_version）；**事件注入失败不阻塞恢复结果返回**（仅记日志），避免把审计问题变成用户操作失败。
- 前端：这两类事件渲染为「已恢复」系统事件行（复用既有系统事件渲染路径），AI 在事件流中同样可见（据此知道正文/记忆已变，自行补三件套）。

**错误码映射**（`router.mjs` STATUS_* 集合补充）：`no_versions → 404`、`version_not_found → 404`、`already_current → 409`、`agent_running → 409`（STATUS_400/404 现有集合见 `router.mjs:33-65`）。

### 3.2 前端入口与时间线面板

**入口（两处）**：
1. 阅读器 `#reader-tools` 按钮排新增「历史」按钮（现有排：`A−/A＋/上一章/下一章/沉浸`（`index.html:102-107`）；「历史」放在「沉浸」之后、「关闭」按钮之前——注意「关闭」（`#reader-close`）是 `reader-tools` **外**的兄弟按钮）。
2. 抽屉「章节」分区每章行（`buildChapterRow`，`drawer-panels.js:102-133`）尾部新增「历史」小按钮。

**时间线面板**（三处入口共用同一组件，实现建议 `src/app-shell/components/version-panel.js`）：
- 每行：版本号 `vN`、时间、来源标签（提交/入账/回滚/回滚前存档/基线）、字数（`count_text` 口径 = 中文字符+英文单词+数字记号）。**不显示校验和（d7）**。
- 点行 → 展开预览面板：旧正文**衬线渲染**（正文神圣：衬线 15px、行高 ≥2.0；UI 与正文不混排），只读。
- 恢复按钮（r2=A）：行内二次确认——点「恢复此版」→ 按钮变「确认恢复？」→ 再点才执行；成功不弹 Toast，面板与正文区刷新到恢复后内容；AI 运行中 → 按钮禁用+提示（§3.1）。
- 文案 2-6 字；错误提示只写后果。
- 版本语义与模型侧一致：显式指定版本恢复（点哪行恢复哪行）；缺省"上一版"仅保留在模型工具 `rollback_chapter` 侧，UI 不提供模糊的"回上一版"按钮。

### 3.3 抽屉「记忆」分区（m1=A，第五标签，位置最后 d5=A）

标签顺序：`章节 / 模型 / 资料 / 成本 / 记忆`。新增标签需同步三处：`index.html:84-88`（dtab 按钮）、`drawer-panels.js` `renderDrawerBody`（14-25 分派）、`app.js` `drawerTab` 状态/active（247-268）。

分区内容三块：
1. **故事摘要**（`book_summary.md`）：markdown 渲染、滚动；右上「历史」按钮 → 时间线面板（§3.2 组件复用，预览衬线）。
2. **工作日志**（`WORKLOG.md`）：同上。
3. **设定档案**（`continuity.md` 渲染）：**只读**（c2=A，用户不可编辑；纠错方式 = 告诉 AI）；冲突标记（`⚠ 与既有记录冲突…`）醒目呈现。

### 3.4 UI 质量硬标准（用户要求：大厂级质感，不粗糙）

- 一切遵守 `docs/design/写作Agent对话样式规格书.md`：正文神圣、折叠态即终态、错误分级（网络错误琥珀自动重试、4xx 红卡手动重试）、错误文案只写后果。
- 视觉体系：沿用现有 design token（`styles.css` 变量：`--surface/--ink/--muted/--line/--accent/--r/--shadow-pop/--sans/--serif` 等），新组件不引入新字体/新色彩体系；间距/圆角/层级与既有 drawer/settings/reader 一致。
- 三视口适配：390×844 / 768×900 / 1280×800 / 1440×900 均无横向溢出、无重叠、按钮可见可点。
- 按钮真实可点（trusted click 链路）——`verify:app-clickability` 既有防线，新 UI 全部纳入。

### 3.5 视觉验收流程（多模态验收不阻塞本轮完成，d4；采集模式修正）

1. 扩展 `scripts/capture-visual-acceptance.cjs` 的 **campaign 场景集**（默认模式，**不用 `--mode round7`**——round7 模式只产机器断言 JSON，不产 multimodal-review-prompt.md；campaign 模式在 1627-1628 行产审图手册）：新增场景——版本时间线面板（展开态/预览态/「确认恢复？」态）、抽屉「记忆」分区、任务计划面板（chip 收起态 + 展开态）、阅读器「历史」入口。新增场景需改的位置：场景函数（参照 05-settings-builtin-styles 范式 1459-1491）+ MANIFEST expectedFiles 数组（1631-1652）+ multimodal-review-prompt 文案。
2. 采集命令（每轮新目录、禁止覆盖）：

   ```powershell
   node scripts/capture-visual-acceptance.cjs --output artifacts/visual-acceptance/2026-08-15-round9/round-01
   ```

   预期 exit 0；机器断言（横向溢出/重叠/非空白/动效唯一性）先行把关。
3. 证据目录自动产出 `MANIFEST.md` + `live-indicator-audit.json` + **`multimodal-review-prompt.md`**——这份审图手册是执行模型的交付物之一：执行模型完工后向用户报告手册所在路径，用户复制给独立多模态模型验收。
4. 多模态模型返回 FAIL → 执行模型按其 findings 修复、递增 round 号重采，直至 PASS 或用户裁决。**多模态 PASS 不阻塞"本轮完成"的判定**（用户拍板 d4），但审图手册必须已产出。

### 3.6 任务计划面板（Task List UI，用户追加需求——一次做到位、可折叠不遮挡、大厂质感）

**数据源**：`update_plan` 工具的 visible_plan（挂在 active_run；journal 内 `plan_updated` 事件驱动）。前端维护"当前计划"投影：取**最后一次** plan_updated 的快照，跨 Run 保留（计划是任务的持久视图）；计划被清空（update_plan 提交空列表）或从无计划 → 面板隐藏。

**形态**：
- **常驻 chip**：顶栏（topbar）右侧、上下文圆环左侧，显示「任务计划 N/M ▾」，其中 N=已完成数、M=总项数；计划存在时恒显示（用户随时看得见进度），无计划隐藏。chip 细边框 + 浅底（`--surface-2`）+ 12.5px muted 文案，与顶栏其他 tbtn 同高。
- **展开 = 下拉卡片**：点击 chip 展开，**绝对定位覆盖层**（锚定 chip 下方右对齐），不挤压、不改动对话布局；max-height 40vh 内滚；条目：状态图标（✓ 完成 muted+删除线 / ● 进行中 accent+1.2s 呼吸动效 / ○ 待办）+ 文本；条目顺序与计划一致（进行中不重排）。
- **折叠逻辑**（深度决策）：默认折叠；点击 chip 或 Enter/Space 展开；**展开后点击卡片外部、Escape、再次点击 chip 均收起**；新的 plan_updated 到达时若展开则原位更新 + 新变化高亮 1.2s；Run 结束**不自动收起**（用户可能正在看）；焦点关闭后归还 chip。z-index 低于 drawer/settings scrim（用现有层级变量 + 100 档位内选取，保证不遮挡弹窗）。
- **不遮挡保证**：卡片只在展开时占用屏幕（position:absolute），收起态只有 chip 一行；窄视口（≤720px）chip 文本省略号，卡片 `max-width: min(360px, calc(100vw - 32px))`。
- **a11y**：chip `role="button"` + `aria-expanded` + `aria-label="任务计划"`；Enter/Space 切换；Escape 关闭；展开态内条目是纯展示行（不接收 Tab）。
- **动效**：展开/收起 180ms 透明度+位移过渡，经 motion-runtime 尊重 `prefers-reduced-motion`（沿用既有 motion 钩子）。
- **视觉**：卡片 `--surface` + `--shadow-pop` + 圆角 `--r`；条目间距 8px、图标 14px；夜间主题由变量驱动，无需额外适配代码。

**测试与验收**：app-shell 单测（无计划隐藏 / chip 文本 N/M / 展开收起 / 状态类与删除线 / 外点与 Escape 关闭 / plan_updated 原位更新）；`verify:app-shell` 静态断言（chip 容器与 aria 属性存在）；`verify:app-clickability` 路径（展开 → Escape 收起 → chip 复位）；capture 截图（chip 收起态 + 展开态，≥1280 与 390 两视口）。

### 3.7 测试与验证脚本更新

- `tests/app-shell/` 新单测：时间线面板渲染/确认态切换/禁用态（参照 `settings-modal.test.mjs:161-190` 的 `createSettingsModalForTest` mock 范式：MockElement refs + getJsonImpl/postJsonImpl/confirmImpl 注入）、任务计划面板单测（§3.6）。
- `scripts/verify-app-shell.mjs`：新增 DOM/静态断言（reader-scrim、记忆 tab、时间线面板、任务计划 chip）。
- `scripts/verify-app-clickability.cjs`：**补阅读器点击路径（当前完全没有，必须补）**——打开 drawer → 点 `.chrow.completed` → 断言 `#reader-scrim` show + `#reader-title` 内容 → 「历史」按钮 → 时间线面板 → 关闭；新增任务计划 chip 展开/Escape 路径。注：本脚本重试函数名是 `clickAndReadStable`（435）；受限沙箱下 Electron 会 mojo 0x5 启动失败（环境限制非代码缺陷），验收以非受限环境运行为准。

---

## 4. 模块 ③：任务断点恢复

### 4.1 原则（b1=A，不加新界面）

- **不建系统任务进度文件、不做系统持久化进度指针**（原则：系统不替 AI 理解进度）。
- 进度真相源 = `WORKLOG.md`（AI 自由写）+ 权威产物（chapter_index.json / .versions/ / 记忆档案，模型 read_file 自读）。
- 恢复 = 既有 retry 链路 + 提示词纪律；崩溃恢复仍"一律标 interrupted 等用户 retry，绝不自动续跑"（现状不变）。

### 4.2 提示词纪律（写入 writer 提示词，与 §2.3 同一提示词改写任务）

- 恢复上下文时（会话重开/重试/续跑）**先读 `WORKLOG.md`**，从"上次进行到 X、next"继续；已完成工具不重放（系统侧不变量继续由 verify-unified-agent 31a/31b 保障）。
- 读摘要（book_summary）恢复故事状态、读日志（WORKLOG）恢复任务进度——提示词必须教 AI 区分两者用途（Q26）。

### 4.3 测试缺口补齐（与 31b 明确区分）

- **场景 31b（现有，会话级）**：崩溃时已完成工具落盘、下一模型轮在途 → 重放后不重复工具（`verify-unified-agent.mjs:1674`）。
- **场景 32（新增，任务级）**：mock 流程「写章 commit_chapter 入账 → 模拟崩溃（丢弃实例重建）→ 用户重试续写」，断言：
  1. 重试 Run 的 gatewayScript 首动作 = `read_file` 读 `WORKLOG.md`（演示断点纪律入口）；
  2. 该章在 chapter_index 仅一条记录、run_log 仅一条 `chapter_revised`/`chapter_completed`（**已入账修订不二次入账**）；
  3. `.versions` 该章快照不因重试而重复（版本数不变）；
  4. 最终 `run_completed`。
  与 31b 不重叠：31b 覆盖"在途工具不重放"，32 覆盖"已入账成果不重复 + 续跑入口纪律"。

---

## 5. 真实 API 回归与 API Key 配置（d3：要做真实 API 回归）

### 5.1 sim:user-flow 增强规格

现状：`scripts/simulate-user-flow.mjs` 为确定性 mock 驱动、无需 key（第八轮重写所致）。本轮增强为**双模式**：

- **默认 mock 模式**：无需 API key、确定性、免费。**mock 剧本同步扩展记忆三件套步骤**——阶段 8（修订入账）的剧本在 `finalize_revision` 之后追加：`update_memory`（facts/timeline/characters 各一条）→ `edit_file` 更新 `book_summary.md` → `edit_file` 更新 `WORKLOG.md`（路径为根目录，与 §2.1 迁移一致）。这样"两模式共同断言"才有意义（旧剧本从不调记忆工具，直接加断言必 FAIL）。
- **真实模型模式（env 门控）**：检测到环境变量 `DEEPSEEK_API_KEY` 时，将 mock gateway 替换为真实 `OpenAICompatibleAdapter({ apiKeyEnv: "DEEPSEEK_API_KEY" })`（与 `verify-unified-agent.mjs:1742-1773` 既有模式同形）；模型默认 `deepseek-v4-flash`，`MODEL_NAME` 环境变量可覆盖。
- **两模式共同断言（本轮新增）**：提交/入账后模型完成记忆维护三件套——`update_memory` 被调用、根目录 `book_summary.md` 与 `WORKLOG.md` 内容更新、`continuity.json` facts 增加且落盘校验通过；另有 Part A 修复四的 `context_usage_updated.usage.cache_hit_rate` 字段断言（工作组分计划 Task 5 原 Step 5 已并入本任务，见执行计划）。
- 真实模式额外产出：`cache_report.json` 缓存命中数据，作为 §7.2 的实测依据。

### 5.2 教用户配置 API Key（写给用户的操作步骤，执行模型不得替用户配置）

Key = DeepSeek 官方 API key（`sk-` 开头）。放进**本机环境变量**，不写进任何项目文件（不进 git）。

**方法 1（临时，仅当前窗口）**：打开 PowerShell，输入：

```powershell
$env:DEEPSEEK_API_KEY="sk-你的key"
npm run sim:user-flow
```

**方法 2（永久，命令行，推荐）**：

```powershell
setx DEEPSEEK_API_KEY "sk-你的key"
```

然后**重开** PowerShell（新窗口才生效）。验证：`echo $env:DEEPSEEK_API_KEY` 应显示 key。

**方法 3（永久，图形界面）**：Windows 设置 → 系统 → 关于 → 高级系统设置 → 环境变量 → "用户变量"新建 → 变量名 `DEEPSEEK_API_KEY`、变量值 `sk-你的key` → 确定 → 重开终端。

**换模型（可选）**：`$env:MODEL_NAME="模型名"` 或 `setx MODEL_NAME "模型名"`。

**执行模型何时跑真 API**：等用户说"key 已配好"再跑 `npm run sim:user-flow`（带 key 自动进真实模式）；未配好时只跑 mock 模式，不视为失败。

---

## 6. 测试改写与门禁总账（执行时必须同步）

| 位置 | 动作 |
|---|---|
| `src/core/agent/prompt.mjs:157,167` | 改写（§2.3 原文替换） |
| `src/core/agent/tools.mjs` commit/finalize/rollback 三工具 description | 删 memory_update 语义、加三件套提醒说明 |
| `tests/agent/workflows.test.mjs:18` | `UNIFIED_DEEP_NAMES` 五件套 → 六件套（加 `update_memory`） |
| `tests/agent/project-agent.test.mjs:1451/1510/1552/1600` | **四个**派生记忆用例改写为新契约（提交结果含 `memory_checklist` 提醒行；无 memory_update 字段；模型调 update_memory 后档案更新） |
| `tests/project-operations/chapter.test.mjs:746-985` | commitChapterMemory 契约改写（只写 continuity 两文件；无摘要/水位/pending；章节存在门禁用例；幂等；冲突标记）；986 起为其他用例勿动 |
| `tests/memory-extractor.test.mjs` | 删除（normalize 已迁入工具参数校验，用例迁入 tools.test.mjs） |
| `tests/continuity-store.test.mjs` | 保留 merge/render 用例；删除 loadContinuityState/saveContinuityState 相关用例 |
| `tests/agent/tools.test.mjs` | 新增 update_memory 参数校验/门禁/深工具注册用例 |
| `tests/project-operations/versions.test.mjs` 或新 `tests/project-operations/memory-versions.test.mjs` | 新增 §2.6 三函数 + 200 上限用例 |
| `tests/settings-runtime.test.mjs:251-285` | 删除 memory_extraction 设置节用例 |
| `tests/helpers/project-agent-harness.mjs:150`、`tests/agent/project-agent.test.mjs:1593` | book_summary 路径搬家同步 |
| `scripts/verify-unified-agent.mjs` | 补记忆维护场景（提交后三件套断言）+ 场景 32（§4.3） |
| `scripts/simulate-user-flow.mjs` | §5.1 双模式 + mock 剧本三件套步骤 + 断言 |
| `scripts/verify-app-shell.mjs`、`scripts/verify-app-clickability.cjs`、`scripts/capture-visual-acceptance.cjs` | §3.5/§3.7 场景与断言 |
| `package.json`（`audit:rebuild-memory`）、`scripts/rebuild-memory.mjs` | 删除（执行时 grep 无其他引用后删） |

---

## 7. 贯穿约束

### 7.1 缓存友好（结构红线，最终成型版必须满足）

1. 每次提交都在变的内容（WORKLOG/book_summary/continuity）**绝不**进系统提示词、首条消息、上下文包——保证每章首调也能命中稳定前缀（规则/目标/风格/技能）。
2. 记忆三件套 = 提交对话尾部的工具调用，增量成本仅新增内容，前缀缓存不受影响。
3. 废弃独立提取器本身即一次缓存成本削减（少一次全新上下文调用）。
4. 提示词开发期可改；成型版冻结后保持稳定（反复改提示词=反复清缓存）。

### 7.2 缓存可见性（两处并存，口径不同，互不替代）

- **成本面板（不动，c7）**：已显示项目级累计命中率/最近 20 次/低命中提示（`components/cost-panel.js`）。
- **上下文圆环悬停（Part A 修复四，工作组分计划已覆盖）**：新增**会话级**累计命中率「缓存命中率：X%」——口径=整个对话累计 token 加权，事件随 `context_usage_updated.usage.cache_hit_rate` 送达，重启归零不显示。该任务已并入第九轮执行计划（Task 5），其 sim:user-flow 断言并入 Task 20。
- 真实 API 回归（§5.1）产出 `cache_report.json` 实测数据供验收报告引用。

### 7.3 门禁硬性命令（CLAUDE.md 延续）

改 UI/Electron/静态服务后必跑：`npm run verify:app-clickability`、`npm run verify:app-shell`、`npm run verify:desktop-shell`。改核心链路后必须同步 `scripts/simulate-user-flow.mjs`。交付前 `npm run verify:local`。受限沙箱口径（Electron mojo 0x5 / shell 管道 EPERM 假失败）与收尾清单 §2.2/§3.2 一致，验收以非受限环境为准。

### 7.4 打包

本轮**不打包**（c6）：完成后由**用户自己运行仓库根 `publish-and-run.bat`** 出桌面版。执行模型只保证源码态全部验证绿。

---

## 8. 验收条件（d4：多模态不阻塞；其余由设计判断）

1. `npm test` 全绿（含 §6 全部新/改测试）。
2. `npm run verify:unified-agent` 全绿：现有 34 场景 + 新增记忆维护场景 + 场景 32（非受限环境口径；受限沙箱下场景 21 假失败规则同收尾清单 §2.2）。
3. `npm run verify:app-shell`、`npm run verify:desktop-shell` exit 0。
4. `npm run verify:app-clickability` 非受限环境 exit 0、全点击 expectationPassed（含新 reader/时间线/记忆分区/任务计划面板路径）。
5. `node scripts/simulate-user-flow.mjs` mock 模式 exit 0（含三件套断言）；用户配好 key 后真实模式 exit 0（含三件套断言与 cache_report 产出）。
6. 视觉证据交付：`artifacts/visual-acceptance/2026-08-15-round9/round-01`（或修复后最新 round）产出 MANIFEST + live-indicator-audit.json + **multimodal-review-prompt.md**（campaign 模式），执行模型向用户报告**审图手册路径**（用户转多模态验收；PASS 与否不阻塞本轮完成判定）。
7. 用户自行运行 `publish-and-run.bat`（执行模型不代跑）。
8. 文档交付：本规格落盘 `docs/design/2026-08-15-round9-memory-ui-resume-spec.md`；WWRITING.md 更新；决策记录写 `docs/memory/2026-08-15-round9-decisions.md`；find-bugs-report.md 第九轮章节（执行计划 Task 21 模板）。

---

## 9. 与第八轮欠账收尾的协调（已落地，更新）

- 第八轮欠账收尾**已完成并入库**：commit `715ffde`（模型分区列宽修复 + capture 脚本 drawer close 修复 + 2026-08-14-polish/round-01 截图证据）。该批 PNG 的**多模态审阅**由用户另行安排，不属于第九轮执行范围。
- 第九轮基线 = master `715ffde`。
- 三个诊断临时脚本（`scripts/tmp-repro-workgroup-order.mjs`、`scripts/tmp-drawer-wheel-probe.cjs`、`scripts/tmp-drawer-wheel-probe-chrome.mjs`）均为**未跟踪文件**，由第九轮执行计划的最终清理任务删除（注意：未跟踪文件 `git rm` 会报错，直接删文件；若届时已被他人删除则幂等跳过）。

---

## 10. 决策总表（对齐记录，执行时逐条可查）

| # | 决策 | 选择 |
|---|---|---|
| Q29 | update_memory 门禁 | A 轻量：只验章节存在；不比指纹、不强制 finalize |
| Q30 | 三件套是否全强制 | A 全强制（update_memory → book_summary → WORKLOG） |
| Q31 | book_summary 进版本库 | A 纳入 |
| Q22 | commit/finalize/rollback 结果的 memory_update 字段 | A 改为固定提醒行 `memory_checklist`（旧状态字段删除） |
| R1 | 版本时间线预览旧正文 | A 能预览（衬线渲染） |
| R2 | 恢复确认交互 | A 行内二次确认 |
| R3 | 时间线入口位置 | 两处：阅读器 + 抽屉章节列表（执行模型自定，UI 必须大厂级质感） |
| B1 | 断点恢复界面 | A 不加新界面（retry + 提示词纪律） |
| B2 | 第八轮三项欠账 | 收尾清单已执行（715ffde 入库）；PNG 多模态审阅用户另行安排 |
| B3 | 记忆旧版恢复界面 | B 本轮一起做（摘要/日志的时间线+恢复） |
| M1 | 记忆入口 | A 抽屉新增「记忆」分区（第五标签） |
| M2 | book_summary 位置 | A 挪到项目根目录（老项目自动搬家，.bak 留底） |
| C1 | continuity 进版本库 | A 不进 |
| C2 | 设定档案 UI 可编辑 | A 只读 |
| C3 | AI 运行中恢复 | A 禁止并提示（409 agent_running） |
| C4 | 版本库上限 | 每文件 200 版，超限删最老（d1=A） |
| C5→d3 | 真实 API 回归 | 做：sim:user-flow 加 env 门控真实模式；规格含教用户配 key 步骤 |
| C6 | 打包 | 用户自行 publish-and-run.bat |
| C7 | 成本面板缓存命中 | 面板已有显示，本轮不动（圆环会话命中率另由 Part A 修复四做） |
| D2 | 摘要搬家撞车 | 根目录版优先，memory 旧版改名 .bak 留底 |
| D4 | 完工判定 | 多模态审图不阻塞；执行模型交付审图手册路径即可 |
| D5 | 「记忆」标签位置 | 五个标签最后 |
| D6 | 恢复后对话提示 | 插入事件（章节：chapter_rolled_back；记忆文件：memory_file_restored；经 appendSystemEvent 入会话日志） |
| D7 | 时间线显示校验和 | 不显示 |
| T-UI | 任务列表 UI 展示（用户追加） | 顶栏「任务计划 N/M」chip + 折叠下拉卡片，本规格 §3.6 设计，执行模型直接实现不再对齐 |

## 11. 标注为假设的剩余细节（执行模型可在实现时定夺，不偏离规格主约束）

1. 时间线面板在三处入口复用同一组件实现（建议 `src/app-shell/components/version-panel.js`）。
2. 固定提醒行最终字段名与文案（建议：字段 `memory_checklist`，文案 `记忆维护：请依次 update_memory → 更新 book_summary.md → 更新 WORKLOG.md`）。
3. update_memory 允许"文件已存在但未入账"的章节（轻量门禁的自然推论）。
4. 记忆文件恢复后是否强制 AI 立即补记忆——不强制，靠对话事件+下一轮自然感知（与"不兜底"一致）。
5. 真实 API 模式模型默认 `deepseek-v4-flash`（`MODEL_NAME` 可覆盖）。
6. 任务计划面板的具体实现模块名（建议 `src/app-shell/components/plan-panel.js`）与状态投影落在 state.js 的命名（建议 `state.plan`）。
7. `appendSystemEvent` 的 journal 放行实现：若 reducer 现行为拒绝未知类型，则扩允许列表仅含本章两个类型。
