# CLI 与上游统一行为规格的差距盘点

> 日期：2026-10-01 ｜ 依据：`D:/WWriting/docs/design/统一行为规格书.md`（现行契约，含三部分）+
> 两份历史规格书 + CLI 源码逐项核实（grep 验证，非臆断）。
> 用途：回答「下一步做什么」——这是选题清单，不是验收单。
> 状态：**历史记录**（记录于 2026-10-03 复核）｜下列「完全缺失」结论已过时：任务计划与写作领域工具（update_plan / append_chapter_segment / commit_chapter / finalize_revision / rollback_chapter / update_memory 等）现均已实现并有测试覆盖（`WWriting cli/tests/tools/`、`tests/agent/`）；本文件保留 2026-10-01 盘点时的当时值，不再更新。

## 结论

对话面的**交互骨架已基本对齐**（思考预览、排队/停止、YOLO/极端确认、权限生命周期、/init、
技能系统、`/` 菜单都在）。真正的差距集中在三处：

1. **任务计划（Visible Plan）完全缺失**——对话面最显眼的缺口，长篇写作的过程可见性刚需；
2. **写作领域工具集完全缺失**——上游把「章节即事务」做成了 7 个工具，CLI 只有通用文件工具，
   这是「把长篇小说写作当工程管理」的定位级差距；
3. **上下文管理停在「字符预算截断」**——上游已进到分片 journal + 自动压缩，CLI 超预算直接丢整轮。

## 一、已对齐（不用再做）

| 上游契约 | CLI 现状 |
| --- | --- |
| §4.9 思考项（两行预览、思考 N 秒、三态查看） | ✅ `onReasoningPreview` + `/reasoning` |
| §4.5 决策卡（普通三选 + extreme 抄写关卡） | ✅ 方向键选择器 + `DECISION_CHOICES` |
| §16 YOLO（跳过普通确认、可访问项目外） | ✅ agent-loop/decisions/permissions 均有 |
| §14–15 权限生命周期（active_input_id、同类授权、Run 结束失效） | ✅ |
| §13 /init 是普通聊天请求 + WWRITING.md 只读注入 | ✅ ADR-0007/0008 |
| §10 技能发现契约（三根、同名覆盖、read_skill、无启用开关） | ✅ 2026-10-01 T1–T4，ADR-0013/0014 |
| §4.7 `/` 补全菜单（前缀筛选、上下键、Tab） | ✅ c7299f2 |
| §20 写作风格 ID + 三个内置风格 | ✅ 12 内置包 + WWRITING.md 写作风格区 |
| §6.2 停止（清临时授权、写入保持完整） | ✅ /stop |

## 二、差距清单（按层分组，序号即建议优先级）

### A. 对话面（AgentSurface）

**A1. 任务计划（Visible Plan）——最优先**
- 上游：§4.2 + P10 + §4.9 计划行。`update_plan` 工具整表替换，`plan_updated` 落 journal，
  Run 结束保留可回看；生命周期已裁决（口径 A：新 Run 的 `run_started` 清空上一轮计划）。
- CLI：`update_plan`/`任务计划` 全仓 **零命中**——无工具、无事件、无展示。
- 终端形态要自行设计（没有顶栏 chip；候选：轮内计划行 + `/plan` 回看 + 重演画最后一份计划）。
  注意吸收 §32 另一件待裁决（search_files 标签口径 B）时别漏了计划行的同源图标。

**A2. Run 级重试**
- 上游：§4.1 failed/interrupted 显示 `重试`，**同一 run id 恢复**，不新建 Run。
- CLI：失败后没有任何重试入口（grep 到的「重试」全是网络层/注释）。用户只能重新打字。

**A3. `/now` 语义分歧（要裁决，不一定要改）**
- 上游：P3 已**退役** abort 式 promote——`立即` = 安全点优先调度，**不打断**正在执行的轮次
  （§6.2、§15：同一 run id 内切换 active_input_id）。
- CLI：`/now` = 「提升队首输入，**打断当前这一轮**」，且本项目 AGENTS.md 铁律 5 写的就是打断语义。
- 出路二选一：跟上游改成安全点切换；或写 ADR 记录「终端单 Agent 有意保留打断式」。
  现状两头规格打架，不能不管。

**A4. 小件**：会话改名（上游 renameSession，CLI 无）；web_search（上游有，CLI 无——要不要联网能力是产品决策）。

### B. Agent 内核（工具协议）

**B1. 写作领域工具集（定位级差距）**
上游注册表里 CLI 全缺的 7 个（§4.3 标签表）：

| 工具 | 上游语义 | 对 CLI 的意义 |
| --- | --- | --- |
| `read_continuity` | 读取前情 | 长篇防断裂的**核心**：新章开写前拿前情摘要，而不是靠历史预算赌 |
| `commit_chapter` / `rollback_chapter` | 章节提交/回滚 | 「章节即文件」→「章节即事务」：版本可回退 |
| `append_chapter_segment` | 写入章节内容 | 流式追加正文（CLI 现在用 write_file 全量覆盖） |
| `finalize_revision` | 入账章节 | 定稿入账 |
| `style_stats` | 统计文风 | 文风一致性检查（技能包的自动搭档） |
| `update_memory` | 更新设定 | 设定文件的受控更新 |

CLI 目前 = 通用 read/write/edit + count_text + read_skill。「章节即文件」的简化在短篇够用，
长篇的前情/回滚是工程化写作的真实缺口。**建议先做 read_continuity + commit/rollback。**

**B2. shell 工具**
- 上游：§18——项目目录为 cwd、增量输出、可停止、超时、1 MiB 流尾、密钥脱敏。
- CLI：无。跑个统计脚本/git 都得退出应用。工程定位下的明显缺口。

**B3. 成本累计（CostTracker）**：上游按项目跨 Run 累计（cost.json）；CLI 只有每轮 note。小件。

### C. 数据与会话层

**C1. 分片 journal（segments/events 可轮转）**
- 上游：§19 + §24——分段 JSONL 解决单文件无界增长，`journal-manifest.json` 可删重建。
- CLI：已知遗留「事件日志与 `messages` 无界增长」正是同一问题，上游方案现成。

**C2. 自动压缩（compaction）**
- 上游：《统一 Journal、上下文窗口与自动压缩规格草案》+ `/compact` 命令 + 压缩收敛/checkpoint 对账。
- CLI：ADR-0005 的**字符预算截断**（24000 字，超了丢整轮）。ADR-0005 解决的是「怎么数」，
  没解决「丢了怎么办」——长篇写到几十轮，早期设定全靠 WWRITING.md 手动承载。
  压缩（旧轮收敛成摘要保前情）是长篇场景的真实下一步。

**C3. 会话注册表（sessions/index.json）**：上游元数据真相源 + `run_status` 投影；CLI 的
`list()` 每次扫描目录投影。中件，可与 C1 同做。

**C4. 多供应商**：上游「模型配置供应商两级重构」（model-provider-store）；CLI 只有 DeepSeek。
要不要多供应商是产品决策；上游那半截未提交改动（process-feedback-fixes）就在这条线上。

## 三、明确不追的（设计差异，非缺口）

- **跨工作区并行**（§22–31）：终端单进程单会话范式，跨进程锁已保证串行安全。多会话（/resume
  切换）已覆盖核心需求；§29 的全并行上游自己也标了「未实施」。
- **惰性创建**（§26）：CLI 裸启动即新会话是 ADR-0010 的有意决策，空壳问题已修。
- **安全 GFM / 视觉规格**（§4.10、§7）：终端渲染按 ADR 已有的轻量 Markdown 口径，不搬 DOM 规格。

## 四、建议的动手顺序

1. **A1 任务计划**（对话面刚需，契约最全，含终端形态设计题 → 值得先走一轮 grill 定形态）
2. **B1 领域工具集**（先 read_continuity + commit/rollback_chapter）
3. **C2 自动压缩**（长篇上下文的真正出路）
4. **B2 shell**、**A2 重试**、**C1+C3 分片 journal + 注册表**、**A3 /now 裁决**、其余小件
5. **C4 多供应商**：等产品决策

## 五、2026-10-02 回填（B1 收尾 + A2 落地后的状态与偏差定稿）

- **A1 任务计划：已完成**（ADR-0017：实时区面板/chip + 滚动区全表并存；f98d83a）。
- **B1 写作领域工具集：7/7 齐**。本轮补齐 `finalize_revision`（入账章节）与 `update_memory`（更新设定），规格见
  `docs/design/2026-10-02-章节收尾与Run重试-规格.md`：
  - 适配偏差：无章节索引/校验和体系（`expected_checksum` 不做），章节引用以相对路径替代 `chapter_no`；
    门禁只校验章节文件存在（轻量门禁 Q29）；时间线冲突检测（`checkTimeline`）未搬，`timeline_violations` 恒空
    （空 ≠ 检测通过，与「检测失败≠检测通过」同源）；三件套的 CLI 两件化为 update_memory → 更新 WWRITING.md
    （`book_summary.md` / `WORKLOG.md` 不引入）。
  - 回滚目标扩为「最近一次生效版本」（提交或入账），安全网快照仍不作回滚目标；
    `read_continuity` 每章一行取最新生效版本，字段 `commits` 正名为 `chapters`。
  - `memory/` 目录级保护落地：通用写入/修改/追加/回滚工具命中即拒绝并指路 update_memory；
    **别名路径（junction/symlink）按真实路径判定**，绕不过去；读取照常放行。
  - 存储照上游：`memory/continuity.json` + `continuity.md`（I4 md≡json 打印件）；与桌面版同路径，
    桌面版留下的 `foreshadows` 原样保留并照实渲染；设定档案永不注入提示词。
- **A2 Run 级重试：已完成**（`/retry`）。**偏差定稿**：run_id **不复用**（思考重放按 run_id 归堆，
  复用会把失败尝试的思考并进重试轮）；「同一 run 恢复」由 `run_started.data.retry_of` + 复用原
  `input_id` 承载；判据为最近一条 `run_failed` 或非用户停止的 `run_interrupted`，已完成/用户停止
  不可重试；运行中与队列非空都拒绝（排到队尾不是「重试刚才那次」的语义）。
- **C2 自动压缩：已裁决不追**——ADR-0015 定手动 `/compact`。
- A3（/now 语义裁决）、B2（shell）、B3（成本）、A4（会话改名 / web_search）、C1+C3、C4 仍未动。
