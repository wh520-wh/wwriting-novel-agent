---
schema_version: 1
---

# WWriting 项目记忆

## 项目定位

- 项目：WWriting Novel Agent（写作 Agent 应用）
- 当前目标：持续迭代 Agent 核心能力与 UI 体验

## 当前有效要求

- 章节篇幅由用户配置（min_words_per_chapter / target_words_per_chapter）
- 写作流程：草稿 → 门禁检查 → 提交 → 入账（finalize_revision）→ 记忆维护三件套
- 记忆三件套纪律：提交/入账/回滚后必须依次完成 update_memory → 更新 book_summary.md → 更新 WORKLOG.md
- 断点恢复纪律：恢复上下文时先读 WORKLOG.md，从上次进行处继续

## 写作风格

- 技能：fast-readable（快节奏易读风格）

## 权威文件

- 正文：正文/（章节文件，系统保护）
- 故事摘要：book_summary.md（项目根目录，AI 自由维护）
- 工作日志：WORKLOG.md（项目根目录，AI 自由维护）
- 设定档案：memory/continuity.json | memory/continuity.md（仅 update_memory 工具更新）
- 章节索引：memory/chapter_index.json（系统维护，不可直接编辑）
- 章节记忆：memory/chapter_memory.json（系统维护，不可直接编辑）
- 检查点：checkpoints/（系统维护，不可直接编辑）
- 章节版本库：.versions/chapters/（系统维护，append-only，每章 200 版上限）
- 记忆文件版本库：.versions/memory/（系统维护，append-only，每文件 200 版上限）
- 项目配置：project.yaml（系统维护，不可直接编辑）

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
