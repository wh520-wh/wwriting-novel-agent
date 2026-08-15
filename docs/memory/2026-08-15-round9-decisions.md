# 第九轮决策记录：记忆体系重构 · 版本时间线与恢复 UI · 任务计划面板 · 断点恢复

> 日期：2026-08-15
> 设计规格来源：`docs/design/2026-08-15-round9-memory-ui-resume-spec.md`（v2）

---

## 一、规格 §10 决策总表（对齐记录）

| # | 决策 | 选择 |
|---|---|---|
| Q29 | update_memory 门禁 | A 轻量：只验章节存在；不比指纹、不强制 finalize |
| Q30 | 三件套是否全强制 | A 全强制（update_memory → book_summary → WORKLOG） |
| Q31 | book_summary 进版本库 | A 纳入 |
| Q22 | commit/finalize/rollback 结果的 memory_update 字段 | A 改为固定提醒行 `memory_checklist`（旧状态字段删除） |
| R1 | 版本时间线预览旧正文 | A 能预览（衬线渲染） |
| R2 | 恢复确认交互 | A 行内二次确认 |
| R3 | 时间线入口位置 | 两处：阅读器 + 抽屉章节列表 |
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
| D6 | 恢复后对话提示 | 插入事件（chapter_rolled_back / memory_file_restored，经 appendSystemEvent 入会话日志） |
| D7 | 时间线显示校验和 | 不显示 |
| T-UI | 任务列表 UI 展示 | 顶栏「任务计划 N/M」chip + 折叠下拉卡片 |

### 关键设计决策说明

- **三层记忆所有权**：AI 自由文本层（book_summary.md / WORKLOG.md）→ AI 直写，系统不锁不解析；系统结构化档案层（continuity.json/md）→ 仅 update_memory 工具更新；程序权威账本层（chapter_index / checkpoint / .versions / project.yaml）→ 系统代码独占写入。
- **三件套纪律**：commit_chapter / finalize_revision / rollback_chapter 成功后，模型必须依次调 update_memory → 更新 book_summary.md → 更新 WORKLOG.md，三件缺一不得声称完成。
- **缓存口径会话累计**：上下文圆环悬停显示的缓存命中率 = 整个对话累计 token 加权，重启归零。
- **版本恢复显式指定**：UI 时间线点哪行恢复哪行，不提供模糊的"回上一版"按钮。
- **抽屉记忆分区**：第五标签，三块展示（故事摘要/工作日志/设定档案），设定档案只读。
- **任务计划面板**：顶栏 chip 常驻显示进度，点击展开下拉卡片，Escape/外点收起。
- **sim 双模式**：默认 mock 模式无需 key；检测到 DEEPSEEK_API_KEY 时切换真实模式。
- **缓存红线**：记忆文件内容绝不进系统提示词/首条消息/上下文包。

---

## 二、任务/提交哈希对照表

| Task | 提交哈希 | 说明 |
|---|---|---|
| 1 | `26451fb` | test: 钉死真实 journal 顺序下用户消息必须排在工作组之前（第九轮回归） |
| 2 | `0776653` | fix: 工作组锚点迁移到所属 Run 的首个 input_started，消除工作组压在用户消息上方的排序错位（第九轮） |
| 3 | `34177cc` | feat(agent-ui): 已完成思考项整行折叠展开，与工具行交互对齐（第九轮） |
| 4 | `28b2b88` | fix(ui): .dpanel 防 grid/flex 压缩，章节目录抽屉滚轮恢复滚动（第九轮） |
| 5 | `3aa0c18` | feat: 上下文圆环悬停显示会话累计缓存命中率（第九轮） |
| 6 | `17d789d` | feat: 记忆文件迁移到项目根（book_summary 搬家 + WORKLOG 占位，第九轮） |
| 7 | `fc48675` | refactor: update_memory 落盘函数收缩（去水位/摘要/pending/指纹，第九轮） |
| 8 | `0cecd10` | refactor: memory-extractor 瘦身为 update_memory 参数校验（第九轮） |
| 9+10 | `c94af8e` | feat: update_memory 深工具与固定记忆维护提醒（第九轮） |
| review fix | `8592421` | chore: 清理第九轮 review 遗留注释与 not_wired 行为测试（九轮 Task 9/10 收尾） |
| 11 | `032f0e0` | feat: 提示词三件套记忆纪律与断点恢复纪律（第九轮） |
| 12 | `a0a550e` | feat: 记忆文件版本快照（200 上限，第九轮） |
| 13 | `0a2ede8` | chore: 删除重建记忆脚本与 memory_extraction 死配置（第九轮） |
| 14 | `b920eca` | test: 场景 32 断点续跑 + 场景 33 记忆三件套（第九轮） |
| 15 | `7ecc212` | feat: 版本时间线与恢复 HTTP 端点 + 系统事件注入（第九轮） |
| 16 | `98c955c` | feat: 版本时间线面板与阅读器历史入口（第九轮） |
| 16 fix | `c7592dd` | fix(agent-ui): 版本时间线面板复用单实例，避免重复点击累积（第九轮） |
| 17 | `66a0d50` | feat: 抽屉记忆分区与章节行历史入口、系统通知行（第九轮） |
| 18 | `68e98a0` | feat: 任务计划面板（顶栏 chip + 折叠下拉，第九轮） |
| 19 | `c16f093` | test: 第九轮 UI 新场景验证与视觉采集（版本时间线/记忆分区/计划面板） |
| 20 | `7858aa7` | feat: sim:user-flow 双模式与记忆三件套断言（第九轮） |
| consolidated fixes | `f250ad0` | chore: 第九轮 review 遗留小修（断点断言/HTTP 覆盖/死代码/测试补全） |
| regression fix | `58fa015` | fix: verify-unified-agent mock DOM 补 querySelectorAll，恢复 36 场景（第九轮回归） |
| gate sync | `b37d25e` | test: 同步第九轮门禁回归（state-notices seam 例外登记、事件类型计数 46） |

---

## 三、门禁结果

| 门禁 | 结果 | 说明 |
|---|---|---|
| `npm test` | **1838 通过 / 1 fail** | 唯一失败为 `settings-dom-contract.test.mjs`（`.model-settings-body` 280px grid 断言）——基线 worktree（715ffde）实测确认属第九轮前已存在的预存失败。首跑时的另两个失败为本轮引入并已修复（`b37d25e`）：FIXED_EVENT_TYPES 计数 44→46 同步；state-notices seam 例外登记 |
| `npm run verify:unified-agent` | **36/36 通过** | 含场景 32 断点续跑、场景 33 记忆三件套；真实模型场景跳过（未配置 DEEPSEEK_API_KEY） |
| `npm run verify:app-shell` | **exit 0** | gfm/workGroup/skillsCatalog/plainFolderJournal 全 true，task25 六项全 true |
| `npm run verify:desktop-shell` | **exit 0** | electronPackageInstalled/packageDirScript/packageInstallerScript 全 true |
| `npm run verify:app-clickability` | **exit 0** | 20/20 按钮 expectationPassed，含阅读器/抽屉记忆标签/时间线历史入口/任务计划面板路径 |
| `node scripts/simulate-user-flow.mjs` | **20/20 通过（mock）** | 记忆三件套 + cache_hit_rate 断言全通过；真实模式未执行（本环境无 DEEPSEEK_API_KEY） |

---

## 四、已知边界

- 同 Run 多排队输入分段（Part A 遗留）
- 缓存命中率重启归零（会话内存态）
- 多模态视觉验收未执行/PASS 与否（由用户另行安排，审图手册路径：artifacts/visual-acceptance/2026-08-15-round9/round-01/multimodal-review-prompt.md）
- capture-visual-acceptance 本环境于既有场景 08 超时中断（新场景已产出 4/5 PNG；version-panel-confirm 因 fixture 无已入账章节版本未能产出；完整运行需用户环境重跑）
- retry 且首个 input_started 缺失的组不迁移锚点（Task 2 设计内行为，防御性判定，正常 journal 不出现）
- MODEL_NAME 覆盖为 runtime modelConfig 层职责（适配器构造器不接收模型名；sim 真实模式默认 deepseek-v4-flash 由项目设置决定）
- 记忆迁移 .bak rename 对 EEXIST/EPERM 的兜底依赖 pathExists 检查（逻辑正确，未来可显式处理）
- sim 真实模式主 agent 仍走 mock、仅 revAgent 走真实 API，故 `run_completed >= 1` 口径正确（真实模式下主 agent 的 gatewayScript 由 mock 驱动，revAgent 的工具调用走真实 DeepSeek API）

---

## 五、执行方式说明

- **开发模式**：subagent-driven development，每任务实现 + 规格审查 + 质量审查
- **基线**：master `715ffde`（第八轮欠账收尾已完成）
- **分支**：`round9/2026-08-15-full-execution`（未合并 master）
- **HEAD**：`58fa015`（23 个提交，含 1 个 review fix + 1 个 regression fix）
