# Find-Bugs 报告（2026-07-30）

跨整个写作流程（Electron 主进程 / 静态服务 / 写作 agent 循环 / fact-check / 记忆检索 / 设置持久化 / 故障卡）
按 whfind-bugs skill 提案 -> 独立怀疑者反驳 -> 主循环 at-a-glance 终审。每个候选都派发了无上下文的 fresh skeptic。

## 确认 bug（5 个，按严重性排序）

### 1. [高] 写作 agent 循环里 `edit_chapter` / `read_chapter` 解析不到当前章 -> 核心能力失效

- **Location**: `src/core/chat/tools-write.mjs:18-19`（`resolveChapterFile`）、`src/core/chat/tools-read.mjs:57`（同款解析）、`src/core/agent-engine.mjs:1115`（prompt 承诺）、`1486`（注释宣称预期行为）、`1267/1277`（白名单）、`src/core/project-store.mjs:146-147`（draft_path/final_path 初始化为 null）、`src/core/tool-runtime.mjs:51-90`（appendChapterSegment 不写索引）、`src/core/agent-engine.mjs:567-568`（只有 finalizeChapter 才写 draft_path）
- **Phenomenon**: `edit_chapter` 与 `read_chapter` 都用 `entry?.final_path ?? entry?.draft_path` 从章节索引解析文件。草稿/修订阶段索引里这两字段都是 `null`（只有 `finalizeChapter` 才写入）。但 prompt 明说"也可以用 edit_chapter 修改本章已写部分"，注释也写"写作引擎自己 edit 当前章是预期行为"。模型一调 `edit_chapter` 改当前章，`resolveChapterFile` 读到 `null ?? null` -> 抛 `chapter_not_found`。
- **Impact**: prompt 承诺的能力每次必失败。修订阶段模型无法修改已写正文（`append_chapter_segment` 只能追加），无法修复标题门禁等需要"改现有文本"的失败，最坏耗尽 8 轮 -> `agent_loop_exhausted` -> 项目阻塞。错误信息"第 X 章不存在或还没有正文"还具误导性（章实际有正文）。`read_chapter` 同病，模型连自己写过什么都看不到。
- **Evidence**: `tools-write.mjs:18` `const filePath = entry?.final_path ?? entry?.draft_path;` + `:19` `if (!entry || !filePath || ...)`；`project-store.mjs:146-147` `draft_path: null, final_path: null`；`tool-runtime.mjs:51-90` 不调 `upsertChapter`；`agent-engine.mjs:567-568` 仅 finalizeChapter 写入；`:1486` 注释"写作引擎自己 edit 当前章是预期行为"；`:1115` prompt 文案。
- **Skeptic 裁定**: CONFIRMED MAJOR。独立 grep 确认 `draft_path` 仅在 finalizeChapter 写入；设计注释与 prompt 反向佐证"应能用却用不了"；默认配置即激活（白名单是硬编码常量）；无测试覆盖草稿中对当前章调 edit_chapter。

### 2. [中] 记忆提取失败仍推进水位，rebuild-memory 永远跳过该章 + 事件消息误导

- **Location**: `src/core/agent-engine.mjs:588`（幂等守卫）、`:649`（catch 里推进水位）、`scripts/rebuild-memory.mjs:26`（`> watermark` 严格大于过滤）、`agent-engine.mjs:653`（消息说"可用 audit:rebuild-memory 补建"）
- **Phenomenon**: `extractChapterMemory` 失败的 catch 块仍执行 `saveContinuityState({ last_extracted_chapter: chapterNo })`。`rebuild-memory.mjs` 用 `c.chapter_no > watermark.last_extracted_chapter`（严格 >）筛目标章。失败章水位已推进到 chapterNo，rebuild 永远跳过它（`chapterNo > chapterNo` 为假），`--from N` 也救不了（同样受水位过滤约束）。
- **Impact**: 一次瞬态 API 错误就永久丢该章的 continuity facts/timeline。事件消息明说"可用 audit:rebuild-memory 补建"，但 rebuild 根本补不了该章，除非手动编辑 `memory/continuity_state.json` 把水位置 0——这条恢复路径只写在某个 plan 文件里，事件消息和 UI 都没提。对非技术目标用户=事实性不可恢复。设计 spec 承诺的"下章补提"回补机制从未实现。
- **Evidence**: `agent-engine.mjs:588` `if (watermark.last_extracted_chapter >= chapterNo) return;`；`:649` `await saveContinuityState(projectRoot, { last_extracted_chapter: chapterNo });`（catch 内）；`rebuild-memory.mjs:26` `... && c.chapter_no > watermark.last_extracted_chapter`；`:653` 消息含"可用 audit:rebuild-memory 补建"。
- **Skeptic 裁定**: DOWNGRADED（从"永久数据丢失"降到"误导消息+缺失回补逻辑"）。代码事实逐字确认；水位推进是设计本意（spec+test 佐证），但承诺的"下章补提"从未实现，事件消息误导。章节正文不丢、写作继续，但记忆质量降级且恢复路径对小白不现实。主循环认可：保留为中危。

### 3. [中] 非阻塞故障卡的"停在这里/我来人工改"无法停止运行中的循环

- **Location**: `src/core/agent-engine.mjs:261-262`（findFreshPauseRequest 只匹配 "pause-here"）、`:92`（每步开头检查一次）、`src/core/failure-actions.mjs:10-12`（pause-here 与 manual-review-handoff 都 resumeRun:false）、`src/core/derive-failure-card.mjs:73`（"我来人工改"=manual-review-handoff）、`src/core/app-server.mjs:1549`（`message: command`）、`src/core/event-log.mjs:49`（limit:5 尾部读）
- **Phenomenon**: 非阻塞故障卡（标题门禁失败->kind 'unknown'->提供 pause-here；技能门禁失败->kind 'review-failed'->提供"我来人工改"=manual-review-handoff）展示时循环仍在跑（setStage needs_revision 后 return，下一步进 reviseChapter）。停止动作靠 findFreshPauseRequest 捕获事件。但 (a) findFreshPauseRequest 只匹配 `message === "pause-here"`，manual-review-handoff 永远不匹配；(b) pause-here 仅读最近 5 条事件，而一个 drafting/revise 步骤产生 6-7 条事件，pause-here 易被挤出 top-5。
- **Impact**: 用户点"我来人工改"期望停下手动处理，循环直接无视、继续修订/定稿；"停在这里"也可能被静默忽略。设计 plan 明说"运行中的暂停由引擎对 failure_resolved/pause-here 事件的时间窗检查完成"——但引擎只处理 pause-here，且窗口太小。
- **Evidence**: `failure-actions.mjs:10-12` 两命令都 `resumeRun:false`；`agent-engine.mjs:261-262` 只匹配 "pause-here"；`app-server.mjs:1549` `message: command`（manual-review-handoff 事件 message="manual-review-handoff"）；`derive-failure-card.mjs:73` manual-review-handoff 标签；`event-log.mjs:49` 尾部读 limit。
- **Skeptic 裁定**: DOWNGRADED（默认休眠：MockModel 不写标题门禁失败、enabled_skills 默认空->无技能门禁卡）。但代码事实与设计意图缺口均确认。主循环认可：对真实 API 用户（CLAUDE.md 强调的目标场景）非休眠，保留为中危 UX bug。

### 4. [低] `update_continuity` 用 chapter_no:null -> 后续 prompt 与 continuity.md 出现"(第null章)"

- **Location**: `src/core/chat/tools-write.mjs:153`（`chapter_no: null`）、`src/core/continuity-store.mjs:44/87`（merge 保留 null + 渲染 `(第${f.chapter_no}章)`）、`src/core/chapter-memory.mjs:116`、`src/core/agent-engine.mjs:660`、`src/core/quality-gates.mjs:230`（同款渲染）
- **Phenomenon**: update_continuity（chat 与修订 agent 白名单均可调）硬编码 `chapter_no: null`。mergeExtraction 原样保留 null。所有渲染路径都用无保护的 `(第${f.chapter_no}章)` -> 字面量"(第null章)"，污染 continuity.md 及后续写作/fact-check/记忆提取 prompt。还经 conflict_with 传播（"第null章: ..."）。timeline 路径有 `chapter_no !== null` 过滤，facts 路径没有——非对称说明是遗漏。
- **Impact**: 每次 update_continuity 后，所有后续模型 prompt 含"(第null章)"，困惑模型、降低 prompt 质量。无数据丢失、无崩溃。
- **Evidence**: `tools-write.mjs:153` `chapter_no: null`；`continuity-store.mjs:87` `(第${f.chapter_no}章)` 无 guard；`memory-extractor.mjs:66` timeline 过滤 null 而 facts（:60）不过滤。
- **Skeptic 裁定**: DOWNGRADED（cosmetic/prompt 污染，无数据丢失/崩溃）。代码事实确认，非对称佐证遗漏，可达且无测试覆盖。主循环认可：保留为低危。

### 5. [低] fact-check 自动修复把 draft_quote 截断到 200 字 -> 替换后正文残留后半段

- **Location**: `src/core/quality-gates.mjs:255`（`draft_quote: ...slice(0, 200)`）、`:260`（`replace_with: ...slice(0, 200)`）、`src/core/agent-engine.mjs:755/760`（用截断后的 first.draft_quote 做 indexOf 和 replace）
- **Phenomenon**: parseFactCheck 把 draft_quote/replace_with 截断到 200 字。自动修复用截断后的 `first.draft_quote` 在正文里 indexOf + replace。若模型返回的 draft_quote > 200 字，只匹配并替换前 200 字，原引文 201 字之后的尾部留在正文里，产生乱码，随后被定稿进章节。
- **Impact**: 模型返回长引文时，自动修复静默损坏章节正文。中文"一句"很少超 200 字，触发概率低；一旦触发是静默数据损坏。无测试覆盖 >200 字场景。
- **Evidence**: `quality-gates.mjs:255/260` slice(0,200)；`agent-engine.mjs:755` `draft.indexOf(first.draft_quote)`、`:760` `.replace(first.draft_quote, first.replace_with)`；无任何重读原始未截断引文的路径。
- **Skeptic 裁定**: DOWNGRADED（低概率：prompt 要"一句"，中文句极少 >200 字）。代码事实确认，真实 API 用户默认开启 fact-check+软自动修复。主循环认可：保留为低危防御性缺口（应拒收超长引文或截断时跳过自动修复）。

## 派发前已剔除的候选（过滤器生效记录）

- **mergeExtraction 同 chapter_no 不同 events 累积重复 timeline 节点**: 剔除。水位幂等守卫使正常流程不会重提同章，重复节点不会累积（derived/dormant）。
- **provider-adapters 强制 tool_choice=append_chapter_segment 使 read/edit 工具不可达**: 剔除。是设计选择（确保章节交付），read/edit 是 auto tool_choice 模型的附加能力，非 bug。
- **serveStatic 路径穿越**: 剔除。`isPathInside`（root + path.sep 后缀）防护稳健，前缀绕过不成立。
- **extractChapterMemory mock-skip 推进水位**: 并入 #2（同根因：水位推进无实质提取）。
- **fact-check 自动修复用内存 draft 而非磁盘 content**: 剔除。两者在 reviewChapter 链路中一致（中间无写入），onlyHit 检查有效。

## 修复优先级建议

1. **#1** edit_chapter/read_chapter 对当前章回退到 `drafts/` 目录解析（参照 `readDraft`/`appendChapterSegment` 的 `safeJoin(projectRoot, "drafts", ...)`），或在 appendChapterSegment 后把 draft_path 写进索引。
2. **#2** 失败 catch 不要推进水位（或推进但 rebuild-memory 加 `--force`/`--ignore-watermark`），并修正事件消息别再误导"可用 rebuild 补建"。
3. **#3** findFreshPauseRequest 同时匹配 manual-review-handoff；limit 从 5 提到 ≥30 或改用专门 pause 标志位。
4. **#4** 渲染 facts 时 `f.chapter_no ?? "?"` 或跳过章号后缀；update_continuity 传入合理 chapter_no。
5. **#5** parseFactCheck 对超长 draft_quote 返回校验失败（拒收），或 runFactCheck 检测到截断时跳过自动修复。
