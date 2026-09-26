# 项目进度与欠账清单

记录于：2026-09-05｜状态：当前有效｜承接：原仓库根 `WWRITING.md`「当前进度」逐字迁移（第九至十六轮）；第十七轮为 round18 回填；欠账清单为 2026-09-05 合并。
> 各轮数字均为当时值；当前基线见下节。本文件由 AGENTS.md「开工必读」指向，是轮次记录的唯一滚动入口。

## 当前基线（记录于 2026-09-24｜状态：当前有效｜依据：`npm test` 与 `wc -l`/`wc -c` 实跑，HEAD `e708b36`）

- 测试数：1992/1992（依据：`npm test` 实跑，exit 0，321s；前值 1986/1986 记录于 2026-09-05）
- 逻辑源码红线现状：全库 126 个 `.js/.mjs` **0 越线**（口径：≤1200 行且 ≤51200 字节，字节按 LF 归一）；行维度由架构测试 R1 机器强制，**字节维度自本轮起同样机器强制**（`tests/architecture/dependency-rules.test.mjs`）
- 逼近红线的文件（LF 归一字节 / 余量）：`src/app-shell/app.js` 48607B / 余 2593B、`src/core/agent/journal.mjs` 47577B / 余 3623B、`src/core/agent/journal-handlers.mjs` 50355B / 余 845B、`src/app-shell/model-settings-page.js` 50859B / 余 341B（依据：`wc -l` + `Buffer.byteLength(text.replace(/\r\n/g,"\n"))`）
- 本轮拆分出的新模块：`src/core/agent/run-control.mjs`（519 行 / 28899B）、`src/core/agent/journal-recovery.mjs`（162 / 8857B）、`src/core/agent/journal-queries.mjs`（123 / 6046B）、`src/app-shell/app-reader-view.js`（116 / 5214B）
- 样式体积现状：`src/app-shell/styles.css` 2613 行 / 83213B、`src/app-shell/agent/agent.css` 2171 行 / 57756B（依据：`wc -l`/`wc -c`，记录于 2026-09-24；**行数与 2026-09-05 登记值相同，即样式自第十七轮以来未再增长**）
- 依赖面：`dependencies` 3 个（`marked` / `yaml` / `yauzl`；本轮删除零引用的 `ignore`）
- 本地验收线：`npm run verify:unified-agent` 36/36 场景、exit 0（本轮修好了此前在场景 24 崩溃的遗留缺陷）

## 当前进度

- 第九轮完成（2026-08-15）：记忆体系重构 / 版本时间线与恢复 UI / 任务计划面板 / 断点恢复
- 详见：docs/memory/2026-08-15-round9-decisions.md
- 第十轮 UI 修补已并入主干（2026-08-16）：窄顶栏保留项目标题 / 计划浮层置顶 / 窄窗口设置关闭按钮 / 紧凑内存空态 / 视觉验收脚本加固（7 个提交，经 merge --no-ff 合入 master，1857 测试全绿）
- 第十一轮完成（2026-08-20）：前后端一致性修复（两份 08-18 审计的 A/B/C/M1/M2/D 简化/F + 压缩发现 1），7/7 落地
- 详见：docs/superpowers/reports/2026-08-20-第十一轮一致性修复-acceptance-report.md
- 第十二轮完成（2026-08-21）：过程可见性与过程美化（N1 里程碑叙述 / N2 排版收尾 / N3 美化 / N4 状态真实化 / F1-F16 修复包），全量回归 178/178，收口根治 Node v25 FileHandle GC 文件级失败
- 详见：docs/memory/2026-08-21-process-visibility-audit.md（含修复记录，未修项：无）
- 第十三轮完成（2026-08-22）：模型高级配置与模型信息统一（F1 高级预设项 256k/64k 缺省 / F2 窗口权威字段化 / F3 [1m] 尾标淘汰迁移 / F4 八成压缩阈值 / F5 缺省输出 64k / F6 显示单源「厂商 / 模型名」），全量回归 1921/1921。
- 第十四轮完成（2026-08-22）：技能全插件化与网文风格体系，F1-F9 全部落地，回归 1915/1915。
- 第十五轮完成（2026-08-23）：**内核分区重构——三病灶同治与前端控制面重排**（24 任务 / 28 提交，全部落地，回归 1953/1953）。
  - **波A 后端内核**（Task 1-10）：微工具单源 `agent-utils`（fail/codedError/clock/idFactory/normalizeAt/sleep）、常量单源与死代码清除（COMPACTION_EVENT_TYPES 死副本删除）、journal 投影查询四方法收归（hasTerminalEvent/findInputMeta/isIdleInitiatedRun/findTerminalInputId，调用方不得全量扫事件重推导 F2 口径）、`reduceEvent` 48 case 拆 handler 表 `journal-handlers`（对账断言钉死）、tools 四域注册拆分 `tools/`（fs/shell/chapter/knowledge 四 definitions，registry 派生工具名单）、runtime 四步拆分（history-assembly → run-lifecycle → session-manager → buildCompactionSource 归位 compaction + processInput/processCompact 拆 run-pipeline）。终态 runtime 1142 行（原 3056）、journal 1183（原 1982）、tools/index 1032（原 2123）。
  - **波B 前端控制面**（Task 11-20）：dom-kit 共享层（el/bindAutosave/fieldError/focusTrap/showConfirmLayer/createToaster 单源）、settings-modal 迁 form-kit（D7 范式统一）、toast 单源、state.js 事件 handler 表 + CONNECTION_ERROR_CODES 单源、view 四分区（timeline 546 / work-group 827 / cards 298 / composer 531，view.js 从 2363 瘦到 452）、**gsap 退役换 CSS transition**（vendor/ 5629 行删除，motion-runtime 9 个 API 逐字保持、未 setup 同步早退契约保留）、唯一行为例外 F17（timelineSeqs 泄漏修复）。
  - **波C HTTP 下沉与组装根**（Task 21-22）：switchModelByReference/buildModelProfile 迁 settings-runtime、buildProjectList 迁 project-listing、migrateLegacyProjectOnOpen 迁 project-model-migration、runResearch 迁 research-tools、assertNotArchived 单源；app.js 入口化 `bootApp(root)` + refs 分四桶（rail/drawer/reader/settings）。
  - **波D 守卫与收口**（Task 23-24）：守卫三规则立线——R1 src 文件 ≤1200 行（settings-modal.js 唯一登记例外，其余全库落线）、R2 npm test glob 覆盖全部测试目录、R3 agent 内部模块 seam 禁令；欠账回写（WWRITING/压缩审计发现 2 订正）+ ADR 0006 落档。
  - **验收门禁**：`npm test` 1953/1953（基线 1915 + 38 个薄单测）；UI 三件套（verify:app-clickability / verify:app-shell / verify:desktop-shell）全 0；`sim:user-flow` 21/21（mock 模式）；视觉基线 round-15 vs round-14 逐图像素对比 26/49 完全一致，其余为动效中间帧与动态内容，无稳态回归。
  - **过程记录**：Task 22 首版 refs 分桶有运行时接线缺陷（createSettingsModal/createDrawerPanels 契约是 `ctx.refs` 却裸传分桶对象 → bootApp 崩溃、页面不可用），由 verify:app-clickability 的 motion-ready 超时捕获并回修（292a55e）——**入口化/分桶类改动必须过 clickability，app-shell 单测与静态验证不执行 app.js**；R1 红线红灯时 app.js 以注释/空白净化缩容至 1198（不放宽红线）；验收时发现计划遗漏 `tests/agent/run-lifecycle.test.mjs`（计划文件清单与步骤自相矛盾），已补薄单测（d8a0c10）。
  - **规模**：113 文件 +12,604/-15,340（净 -2,736，含搬迁重计；其中 gsap/vendor 单删 5,629 行）。
  - **详见**：规格与执行记录 `docs/design/2026-08-23-round15-kernel-partition-spec.md`（5 条偏差全部回填）、`docs/adr/0006-agent-kernel-target-model.md`、视觉验收截图 `artifacts/visual-acceptance/2026-08-23-round15/round-01/`。
  - **遗留下轮**：settings-modal 结构拆分（D6/D7 登记的 1347 行例外）；真实 API 模式 sim:user-flow 复跑（需 DEEPSEEK_API_KEY）；新 provider 接入前的窗口口径回归（发现 2 已字段化，仍需实测兜底）。
- 第十六轮完成（2026-08-24）：**长篇记忆接线与清欠收口——连贯性供给工具化与结构债清零**（21 任务 / 18 提交 + 收口回写，全部落地，回归 1974/1974）。
  - **波A 主菜**（T1-T7）：`read_continuity` 工具接回六月断线的「前情小抄」（D1 工具拉取而非系统注入，ADR 0007；无参 = 近 2 章 900 字摘录 + 近 5 章 facts/12 角色/8 时间线 + 未回收伏笔 top 5；entity 参数 = 按实体查全量）；伏笔台账 continuity v3（`foreshadows` open 去重追加 / paid 精确匹配置位，存量无字段默认 `[]` 不迁移）；update_memory schema 扩 foreshadows + memory_checklist 三处文案含伏笔职责；sim 插针「写第 2 章前必查」断言（22/22）；防呆提醒按非目标不做，观察留十七轮。
  - **波B 结构清欠**（执行期 T11-T13）：settings-modal 技能区一刀抽 `settings-modal-skills.js`（404 行，deps 九引用）；app.js 主题/隐私块抽 `theme-privacy.js`（72 行，1197→1130、init 早位 :107，行为不变）；**守卫 R1 例外清零、红线绝对化**——全库扫描 124 文件全部 ≤1200（最大 journal.mjs 1184），逐文件断言无例外清单。
  - **波C 测试/工程清扫**（执行期 T14-T18）：cards.mjs 补零覆盖 5 测试 + SURFACE_SEAM_TESTS 登记；waitForEvents 去墙钟改迭代上限（tools.test.mjs 69/69）；F18 死字段 5 个（runningCount 等）+ waiting_user 相悖分支删除；四文档删除（AICSS/UI 美化两处路径订正 git rm）+ 死链 8 处命中全为历史记录文件有意保留 + CLAUDE.md 刷新 51 行（按用户要求不入库）。
  - **波D whfind-bugs 紧急修复**（T20-T24）：#1 投影查询改 readTail 尾部窗口（修 10 万事件会话卡死）+ 兄弟点 compaction loadEntry；#2 UI 保存密钥即时注入 env（修首次配置必重启，脱敏名单可变容器遗留）；#3 手动 in-run 取消只终结 compact item、队列存活；#4 dashboard 读取前冲刷脏成本（修 cost.json 全程陈旧，错误分层 leaf 诚实抛/wrapper 吞错）；#5 compaction failed 态诚实拒绝 + 文案进可透传白名单。
  - **验收门禁**：`npm test` 1974/1974（基线 1953 + 波A/波C 增量）；UI 三件套全 0（verify:app-clickability 21/21 点击 + 21/21 预期，verify:app-shell / verify:desktop-shell exit 0）；`sim:user-flow` 22/22（mock 模式，T7 场景插针后 21→22）；视觉基线 round-16 vs round-15 无稳态差异（round-01 51 文件）；行数对账 settings-modal.js 994（≤1200）、app.js 1130（≤1150 余量 20）。
  - **过程记录**：提交/守卫注释 T10-T13/T15-T18 为执行期编号，与计划编号差 2-3 位（T8/T9 拆分落为 T11/T12 等），文件头双编号口径保持原样；verify-app-shell 静态契约 SKILL_SOURCE_LABELS 断言未随波B 迁移指向旧文件 → T14.1 修复（改指向 settings-modal-skills.js）；T24 守卫初版纯状态检查被质量审查抓出死路（failed→cancel→submit 永久锁死）→ 收窄为「run 非终态 + failed」才拒（3ee1cd2）；规格 D2 原文「chapter_index 派生」实测订正为「chapter_memory 派生」（chapter-memory.mjs:195-197）。
  - **规模**：79 文件 +1,396/-1,269（净 +127，测试增量为主，不含竞争研究产物）。
  - **详见**：规格与执行记录 `docs/design/2026-08-24-round16-continuity-wiring-spec.md`（8 条预登记偏差全部回填 + 执行期新发现）、`docs/adr/0007-continuity-supply-via-tool-pull.md`、bug 报告 `docs/memory/2026-08-24-bug-hunt-report.md`、视觉基线 `artifacts/visual-acceptance/2026-08-24-round16/round-01/`。
- 第十七轮完成（2026-08-28 至 08-30，2026-09-05 回填）：**UI 一致性收敛 + 去 AI 腔可度量升级**（双线；规格 `docs/design/2026-08-28-round17-spec.md`；规模口径：窗口提交 43 个，其中带 round17 标记 30 个，另含 v0.5.1 发布提交与 2401ba8/dcf4faf 等无标记尾部提交；记录于 2026-09-05｜依据：git log）。
  - **第一部分 UI 一致性收敛**（app-shell）：隐私模式整体删除（入口/状态/peek/data-away 全链路；对齐决议：承诺与实现长期不符，修复价值低于维护成本故废弃）；暗色硬编码色收敛（新增 `--ink-shadow`/`--ink-scrim` 三元组 token 共 9 处替换、亮色 `::selection` 改 accent 派生、`.sw-dot` 恒白刻意保留并注释）；按钮基元 `.btn`/`.btn--primary`/`.btn--sm`（6+ 套平行实现全量改名不留别名，36/28px 两档，agent.css 重复定义合并）；设计 token 归并（字阶严格 7 档零新增、字重 4 档、圆角 token 去重 3 档+胶囊）；死代码清理（topbar-sub 隐藏元素、`.sp-av`、`.sp-item`/`.sp-name`、孤儿 spin keyframes；补创建弹窗 spinner 与 create-status 校验错误可见）；上下文圆环 28→32 单点回退（4eed87d）。
  - **第二部分 去 AI 腔可度量升级**（core/skills）：`style-metrics.mjs` 纯函数模块（修饰词密度/句长 CV/三连排比候选，O(n²) 上限注释与顶层契约冻结四键）；`readWorkspaceTextFile` 共享读取器；`style_stats` 只读工具注册（工具不变量 15→16，注册顺序契约保持；ADR 0008：只读工具、不建程序化门禁）；`avoid-ai-voice` v2.0.0（量化阈值 + style_stats 审校反馈环，质量审查后补 below_floor 维度指令）。
  - **尾部修复**：DeepSeek v4 思考模式钉死 + 思考回传契约 + 零思考轮「未思考」标签（2401ba8）；六维度审查修复（复用/简化/效率/层次/可用，安全零发现，dcf4faf）；runtime.mjs 悬空注释残句删除（2ae01d8）。
  - **配套**：ADR 0008；竞品调研 `docs/research/2026-08-29-competitive-research-ai-voice.md`；输入证据 46 张截图当时入库（5dcde30），2026-09-05 按「过程产物不入库」规则移出 Git（0f9307b），本地保留。
  - **验收门禁**：门禁 1 全量 1982 pass / 0 fail（2026-08-29，round17 规格执行记录）；门禁 4 反馈环 10 样本 10/10 达标（修饰词密度前均值 82.81/千字 → 后 0；CV 0.37 → 0.51；排比候选 2 → 0；逐段数据 `artifacts/now/round17-acceptance/manual-verification.md`）；最终全量以「当前基线」1986/1986 为准（2026-09-05 实跑）。

- 第十八至十九轮（round18/round19）记录补记（2026-09-24，依据：git log）：这两轮以文档与工程治理为主——项目记忆并入 `AGENTS.md` 并删除仓库根 `WWRITING.md`（`8a4cbce`）、README 双语统计基线注（`beeb212`）、R1 口径订正为逻辑源码 + 样式体积追踪线（`1110762`）、六条治理约束入库（`f515966`）、过程产物移出 Git（`0f9307b`）。其**端到端收尾改动（README 双语重写、`.github/` 模板、CONTRIBUTING/SECURITY/LICENSE、`docs/images/` 素材、三处 Windows/满载测试稳定性修复）在 round20 开工前才落盘**，拆为 5 个 commit（`5c899c6`、`d95b5f9`、`2b9e939`、`f83f4c9`、`1711223`），随后才切出 round20 分支。
- 第二十轮完成（2026-09-24，round20）：**审计修复与收敛清理 + 体积红线收口**（27 提交，fast-forward 合入 master `e708b36`；计划与执行账本 `docs/superpowers/plans/2026-09-24-round20-audit-fixes-and-cleanup.md` 与被忽略的 `.superpowers/sdd/2026-09-24-round20-audit-fixes-and-cleanup/progress.md`；依据 `artifacts/audit-2026-09-23-full-stack.md` 修订版）。
  - **阶段一 缺陷修复（Task 1-5）**：C1 `requireSessionId` 拒绝含 `/\`、`..`、NUL 的 sessionId（此前 `DELETE /api/agent/sessions/..%2F..%2F<目标>` 可递归删除任意目录）；C3 记忆版本恢复覆盖前补 `pre_restore` 快照（此前两次快照之间的编辑被不可逆抹掉），并把读取失败收窄为**仅 ENOENT 免存档、其余上抛**（恢复 fail-closed）；C2 本地 HTTP 校验 `Host` 头拒绝 DNS rebinding（403 `HOST_REJECTED`）；C4 `retry`/`retryCompaction` 复用项目串行门（此前会话 A 运行中可对 B 的 failed Run retry，导致「停止 A」实际 abort B）；新增公共 API `agent.projectBusy({projectRoot})` 收窄 rollback/restore 忙门（此前 `snapshot` 缺省只解析最近活跃单会话，漏判非活跃会话）。
  - **阶段二 顺手加固（Task 6-8）**：win32 `ensureProject` Map 键小写归一（消除大小写变体双 state/双锁写同一物理 journal）；`run_log.jsonl` 纳入 `write_file`/`edit_file` 写保护名单（审计账本此前可被 Agent 改写）；删除 `settings-modal.js` 的死 re-export。
  - **阶段三 过度工程清理（Task 9-17）**：测试 adapter 迁出 `src/`（`mock.mjs` 115 行此前会被 `files: src/**/*` 打进发布包）；删除生产零调用模块与死函数/死导出（`chapter-presentation.mjs`、`utils.js` 三函数、`readChapterDraft`/`rethrowIfCancelled`/`COMMIT_STEPS`）；`cost-tracker` 深拷贝改 `structuredClone`；`session-registry` 复用 `agent-utils` 的 `codedError`；`api-client` 三函数抽 `request` 共核（逐键等价，拒绝改变请求形状）；`cost-panel` 的 `el` 收敛为 `dom-kit` 薄适配；删除零引用依赖 `ignore`（依赖 4→3）。
  - **阶段四 红线收口（Task 18-22，执行期追加）**：触发事实——`AGENTS.md` 红线是「≤1200 行**或**约 50KiB」，行维度早有机器强制、**字节维度无任何强制**，导致三个文件基线即越线长期无人发现。收口结果：`runtime.mjs` 1194 行/65060B → **702 行/37523B**（拆出 `run-control.mjs`）；`journal.mjs` 1183/60409B → **925/47577B**（去重两个恢复批次构建器的逐字重复段 + 拆出 `journal-recovery.mjs`/`journal-queries.mjs`）；`app.js` 1111/52580B → **1020/48607B**（等价合并 + 折出 `app-reader-view.js`）。同时**修好长期红的验收线** `npm run verify:unified-agent`（根因是脚本内最小 DOM 桩缺 `insertBefore`/`parentNode`/`nextSibling`/`isConnected`，非生产缺陷；补桩后 36/36 场景绿），并给架构测试 R1 加上 **51200 字节断言（LF 归一口径）** 与前缀式 seam 名单（`journal` 覆盖全部 journal* 模块）。
  - **验收门禁**：`npm test` 1992/1992 pass / 0 fail（合并后复跑）；`npm run verify:unified-agent` 36/36、exit 0；测试数 1996→1992 的 −7 经逐文件 `git grep -c` 核对，全部来自计划内有意删除（Task 10 删 `chapter-presentation.test.mjs` 3 例 + 静态断言 1 例；Task 11 删 3 个 `hashKey` 死代码用例），其余 121 个测试文件计数完全相同，无静默覆盖丢失。
  - **规模**：整分支 49 文件 +1967/−1277（其中阶段一/二按 TDD 要求强制新增失败测试约 400 行，故「净删」口径对 `tests/` 不适用）；仅 `src/` 26 文件 +1182/−1263（净 −81 行）。
  - **过程记录（重要，给后续模型）**：①**计划自带的逐字测试有 2 处是无法失败的断言**——Task 1 的诱饵目录建在 `fs.rm` 真实落点之外、Task 6 的大小写变体在 `C:\` 上恒等于原路径（永远 skip）；②**实现子代理 3 次拒绝照抄计划代码**且理由成立——`api-client` 改写会给 POST/DELETE 新增 `cache` 指令并把「错误字段键恒存在」改成「可缺失」、`app.js` 的 `/[\\/]+$/g` 会放宽路径语义、`session-registry` 的 import 路径是笔误；③**终审抓到修复波自己引入的 Critical 回归**——抽取 `adjacentChapterNo` 后调用点又取了一次 `.chapter_no`，导致阅读器「上一章/下一章」失效，而全仓无测试覆盖该路径（已修 + 补可证伪导航用例）；④**裁决先例确立**：当计划的逐字代码与「测试必须能被证伪／不得为覆盖率加薄测试」冲突时，以全局约束为准，并在实现报告中标注偏离了哪一行、为什么（用户 2026-09-24 确认）。
  - **遗留（本轮未做，已登记）**：见下节新增欠账。

## 当前欠账清单（2026-09-05 合并 r16+r17，只记不排）


| # | 事项 | 来源 | 状态与去向 |
|---|------|------|-----------|
| 1 | 完读率回放（共用 chapter_memory 底座） | r16 | r17 未认领，悬空；待分级表排优先级 |
| 2 | 防呆提醒（视 sim 冒烟观察决定） | r16 | 观察项；r17 sim mock 22/22 无新触发，保持观察 |
| 3 | 真实 API 模式 sim:user-flow 复跑 | r16 | 阻塞：需 DEEPSEEK_API_KEY |
| 4 | whfind-bugs #6（段尾 64KB 撕裂行） | r16 | 数据安全，未修 |
| 5 | whfind-bugs #7（run_log UTF-8 块边界） | r16 | 数据安全，未修 |
| 6 | 脱敏名单次要面（runtime 级可变 secrets 容器） | r16 | 未修 |
| 7 | T22 活体路径与 retry-after-cancel 覆盖 | r16 | 测试覆盖债，归测试治理清单（r19） |
| 8 | session-sidebar.mjs 维护契约注释订正（buildRecoveryHint 语义分歧） | r16 | 候选 r20 顺带 |
| 9 | T11 makeEvent 事件工厂合并 | r16 | 已消解（2026-09-05 grep `src/` 无 makeEvent 定义） |
| 10 | 人类语料基线校准（20-30 段真人 vs AI 盲测反推人类区间，校准两阈值常量） | r17 | 未启动 |
| 11 | P1 事实/来源可验证性自检清单（审校流程） | r17 | 未启动 |
| 12 | P2 第三方检测 API 集成可行性评估（仅局部风险扫描，非门禁） | r17 | 未启动 |
| 13 | UI 指标展示（前提：指标经实机验证有区分度） | r17 | 未启动 |
| 14 | UI 第二批：动效单轨化（motion-runtime.js 与 CSS transition 双轨，motion-runtime 现存）+ 间距 token 化（27 个像素值） | r17 §2.2 | 未启动 |
| 15 | CHANGELOG 与版本号 | r17 | 常设流程项，归属 ship 流程（登记归属，非欠账） |

> 排序原则：优先级不在本清单内定，由产品功能分级表（主路径/恢复能力/验证能力/增强功能，r19 交付）裁决。

## 第二十轮（round20）新增欠账（记录于 2026-09-24｜状态：当前有效｜共 12 项，只记不排）

| # | 事项 | 类型 | 状态与去向 |
|---|------|------|-----------|
| 20-1 | `docs/design/multi-session-architecture.md` §4 与末尾索引仍引用已退役符号（`migrateProjectData` / `legacy-import.mjs` / `journal-session-migration.mjs` / `runLegacyImport`；已核实 `src/` 零命中） | 文档陈旧 | 该文档标「状态：当前有效」，属伪事实；下一轮以「加已退役标注」方式订正（符号已删、迁移语义留历史说明） |
| 20-2 | R3 seam 扫描器只认字面量 import；`scripts/benchmark-agent-journal.mjs:161/:270` 用计算式动态 import 直连 `journal.mjs`/`journal-segments.mjs`，落在盲区 | 守卫盲区 | 本轮按「不得缩名单绕过」未扩扫描器；扩扫描器会真红（该脚本确为包外直连），需连同 `path.join` 拼接与 `tests/agent/` 豁免口径一并设计 |
| 20-3 | 贴近字节红线的文件：`journal-handlers.mjs` 余 845B（LF 归一实算，正确） | 体积债 | 下一批字节收口对象（口径：≤51200B，LF 归一；R1 已机器强制，破线即红）。**2026-09-25 订正**：原记 `model-settings-page.js` 余 341B（50859B）属 **CRLF 误测**——该值恰等于 LF 值 49921B 加上该文件行数 938（把 `\r` 计入了）；LF 归一实算为 938 行 / 49921B、余 1279B，**不属紧迫对象** |
| 20-4 | 新增导航用例未在 `finally` 恢复 `globalThis.document`，向同文件后续测试泄漏全局 DOM 桩 | 测试卫生 | 本轮已记为 Minor（658/658 全绿，无实际连带失败）；下一轮按同仓既有 `try/finally` 恢复惯例订正 |
| 20-5 | `pre_restore` 去重口径与章节侧不一致（用「≠即将写入内容」而非比最新 checksum），常见场景会存一份与最新版本字节相同的冗余版，挤占 200 版上限 | 一致性 | 本轮为计划逐字口径，未改；属低频优化，非正确性问题 |
| 20-6 | `project_busy`/`session_busy` 已进 `SAFE_PUBLIC_ERROR_CODES` 白名单，而同样「程序写死、不拼底层异常」的 `agent_running` 未进，导致版本回滚/恢复的 409 对直连客户端只显示通用脱敏文案 | 一致性 | 既有行为，需独立评估后决定是否扩白名单 |
| 20-7 | `run_log.jsonl` 保护面不完整：`isProtectedShellCwd` 未纳入（shell 仍可 `echo >`）、`samePath` 不 `realpath`（符号链接可绕）、非 win32 不折叠大小写 | 安全边界 | **2026-09-25 部分关闭**：复核把「realpath 缺失」的范围扩大为「**以根为基准的全部比较点**都未解析根」（受保护路径 8 条规则 / `safe_edit=false` 内容保护 / shell cwd / 工作区文本读取 / scope 判定），经访谈确认为缺陷、**已由第二十一轮按 ADR 0009 修复并验收（提交 `c38df05`/`83512aa`/`cca9124`）**；余项拆出——shell 写目标承诺 → 21-4，大小写口径与两份 `samePath` → 21-1 |
| 20-8 | `dist-desktop/win-unpacked/…/app.asar` 与 `.codegraph/codegraph.db` 仍含本轮已删符号名 | 构建产物 | 均为 gitignore 的构建/缓存产物，重新打包即消失，无需处理 |
| 20-9 | `docs/superpowers/specs/2026-07-18-composer-draft-design.md` 状态为「待实现」，且把本轮已删除的 `hashKey` 当作可复用现存算法 | 后续踩空点 | 按该规格实施时会踩空（`hashKey` 已随 Task 11 删除）；建议在下一次触及 composer-draft 前先订正规格 |
| 20-10 | `src/app-shell/utils.js` 的 `ensureTrailingSlash` 在 `src/`/`tests/`/`scripts/` 内无导入方 | 死代码候选 | 本轮 Task 11 范围外（其同名函数在 `openai-compatible.mjs` 是本地函数，非同一导出）；归入后续审计项 |
| 20-11 | 环境有 14 个 `extraneous` npm 顶层包（`npm uninstall` 残留），`node_modules` 与锁文件不完全一致 | 环境 | 下一轮开工前 `npm ci` 收敛，避免后续验收被误导 |
| 20-12 | `styles.css` / `agent.css` 的**量化目标值仍未定**（`AGENTS.md` 记载「由第二十轮审计轮测定后回填，不得臆造阈值」） | 规则待决 | 本轮只登记现状（2613 行/83213B、2171 行/57756B，与 2026-09-05 相同即未再增长），**未定阈值**；需专项测定后回填 `AGENTS.md` |

> 另：原欠账清单第 8 项（`session-sidebar.mjs` 维护契约注释订正 / `buildRecoveryHint` 语义分歧）在本轮 Task 5 被**部分**订正——该注释已补「rollback/restore 忙门已改为经 `agent.projectBusy` 消费 `hasNonTerminalRun`」口径；`buildRecoveryHint` 的语义分歧本身未验证是否已消解，暂不关闭。

## 第二十一轮（round21）登记项（记录于 2026-09-25｜状态：待实现，只记不排）

来源：2026-09-25 只读健壮性抽查复核 + 同日访谈（4 轮 15 问）。本轮范围＝路径身份统一（规格 `docs/design/2026-09-25-round21-path-identity-spec.md`，ADR 0009）；下列为本轮**明确不做**但已定性的余项。

**执行结果（记录于：2026-09-25｜状态：当前有效）**：本轮范围（工具层路径身份统一，ADR 0009）**已实现并验收**。实现提交 `c38df05`（根解析与失败闭环）、`83512aa`（目标路径解析异常收口）、`cca9124`（5 处比较点全部切到真实根）；新增 `tests/agent/path-identity.test.mjs`（8 用例，含 5 个 win32-only junction 用例）；未触碰任何 `journal*` 模块；`src/**/*.{js,mjs}` 无新增越线文件。四条门禁本轮实测：`npm test` **2000/2000（exit 0）**、`npm run verify:unified-agent` **36/36（exit 0）**、`npm run verify:desktop-shell` **exit 0**、`npm run verify:app-shell` **exit 1（既有失败，见 21-7，经用户裁定接受并登记）**。下表 21-1…21-7 为本轮明确不做、已定性的余项。

| # | 事项 | 类型 | 状态与去向 |
|---|------|------|-----------|
| 21-1 | 路径比较的大小写口径未定；`samePath` 有两份实现（`runtime-helpers.mjs:78` 私有、`app-state.mjs:120` 导出）；macOS 默认大小写不敏感，`.versions/` 变体仍可绕 | 安全边界 | 产品只发 Windows，现实触发面低；需先定各平台折叠口径再动，避免改比较语义牵动既有断言（20-7 余项） |
| 21-2 | 项目身份层未归一：`validateWorkspaceRoot`（`app-dashboard.mjs:256`）只 `path.resolve`、前端 `normalizeProjectPath`（`app.js:846`）只去尾斜杠、最近项目与选中态比较用不解析的 `samePath` | 可用性 | 同一物理项目经不同路径打开会出现「项目未选中」；修法会改动界面显示的路径，属可见变化，需单独决策 |
| 21-3 | journal 缺口台账损坏即静默丢（`journal-segments.mjs:128`/`:138`，gaps 唯一来源 `journal.mjs:384`）：段文件仍在磁盘，缺口却从 API 与恢复逻辑同时消失 | 数据完整性 | 口径已定格（ADR 0010：manifest 是派生数据，从段文件按 seq 断层重算，generation 归属可由 `historyDir` 目录名还原）；实现待排 |
| 21-4 | shell 写面未纳入受保护路径承诺：`echo > run_log.jsonl` 仍可改审计账本 | 安全边界 | 20-7 余项；扩面需解析命令行，误伤合法命令的风险与工作量都更大，需独立评估 |
| 21-5 | `journal-segments.mjs:188-189` 隔离坏段时两次 `rename` 静默吞错：Windows 上改名失败则段文件留在原名、却已移出内存列表且 gap 照记，下次 load 重扫会**再记一条 gap** | 一致性 | 方向保守（多报缺口，不丢数据）；本轮复核新发现 |
| 21-6 | `versions.mjs:22` 经 `readJson` 裸 `JSON.parse`，坏 manifest 直接抛错，缺「仅按 `v{n}.md` 列目录」的降级兜底；`versions.mjs:29` 两步写、崩溃孤儿版被下次覆盖的后果是**时间线少一版**（正文不受影响） | 恢复语义 | 抽查第 4 项的收窄结论；其中「无上限」属 `AGENTS.md` 既定规格，不作为缺陷 |
| 21-7 | `npm run verify:app-shell` 既有失败：`scripts/verify-app-shell.mjs:372` 断言「思考项完成态标签应为 思考 N 秒」不成立 | 验收门禁 | 2026-09-25 于 round21 执行期发现；已在 round21 之前的提交 `65bcf1e` 上以 Node 22 / Node 25 独立复现同一断言，与本轮改动无关（断言由 `069ffa0` 引入）。需独立一轮定位：是投影回退出「已完成思考」回退文案，还是夹具未产出耗时 |

> 排序原则同前：优先级不在本清单内定。
