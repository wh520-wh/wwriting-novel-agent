# WWriting 项目级工作约束

记录于：2026-09-24｜状态：当前有效｜适用范围：本仓库开发、文档维护与项目记忆。

> 原仓库根 `WWRITING.md`（项目记忆）自 2026-09-05 起并入本文件与 `docs/memory/project-progress.md` 后删除。应用在用户写作工作区创建的同名 `WWRITING.md`（`src/core/project-memory.mjs` 的 `PROJECT_MEMORY_FILE`）是产品行为，与被删的仓库根文件无关，不受影响。

## 开工必读

- 工程收敛规则见下文「工程收敛规则」节，先读它再分析、修改或制定计划；不要只读本摘要就开始改代码。
- 项目进度、各轮验收数字与当前欠账清单在 `docs/memory/project-progress.md`；轮次详情见 `docs/design/` 与 `docs/memory/` 对应文件。
- 每轮只处理一个收敛目标，优先复用和删除已证实冗余的代码。拆分应减少共享状态和阅读负担，不能只按文件大小搬代码；保留恢复、权限和数据安全行为。
- 测试保护可观察行为与安全不变量。删除或合并测试前，确认仍有检查覆盖原有失败场景；不得为减少测试数量而牺牲回归防线。
- 产品调整优先保障「打开工作区 → 发消息 → 写入章节 → 恢复 → 验证交付」，不得把收敛建议视为删除现有功能的授权。

## 工程收敛规则（给后续模型）

- **先删后拆**：只有存在至少两个独立调用方、独立状态边界或独立验收目标时才拆模块；单一调用链的薄包装、转发层和“未来可能复用”的接口直接删除。拆分后每个模块必须有单一职责、短入口和最小公开面。
- **体积红线是认知红线**：口径为逻辑源码（`.js`/`.mjs`）单文件超过 1200 行或约 50 KiB；超线时先停止加功能，优先删除重复逻辑、合并状态和下沉纯函数；不得为了过线制造无意义文件。每次拆分都要说明调用边界和删除量。**两个维度都已机器强制**（`tests/architecture/dependency-rules.test.mjs` 的 R1：≤1200 行且 ≤51200 字节，零例外）；**字节一律按 LF 归一口径量**（`Buffer.byteLength(text.replace(/\r\n/g,"\n"))`）——本仓没有 `.gitattributes` 且 `core.autocrlf=true`，同一 blob 在不同 checkout 上可能是 LF 或 CRLF，按工作树裸字节判定会误报（`app.js` 即实例：LF 48607B vs CRLF 检出 ≈49627B）。改 `src/` 下 `js/mjs` 前先确认余量。（记录于 2026-09-24｜依据：round20 阶段四——字节维度此前无任何强制，导致 `runtime.mjs`/`journal.mjs`/`app.js` 基线即越 50KiB 长期无人发现）
- **样式体积追踪线**：`src/app-shell/styles.css` 与 `src/app-shell/agent/agent.css` 登记现状值（2613 行 / 83213B、2171 行 / 57756B，记录于 2026-09-24｜依据：`wc -l` + LF 归一 `wc`；与 2026-09-05 登记值持平，即样式自第十七轮以来未再增长），超线即适用「先停止加样式，优先删重复」义务。**量化目标线仍未定**：原计划由第二十轮审计轮测定后回填，该轮只测得上述现状值、未定阈值；目标值需专项决定，不得臆造。
- **测试只锁行为**：新增测试必须对应用户可见行为、数据安全不变量或曾经复现的回归；禁止仅为提高覆盖率、记录任务编号或复制实现细节而新增薄测试。重复断言合并，历史过程说明写文档，不写测试。
- **产品优先级**：默认顺序是“稳定打开工作区 → 发消息 → 稳定写入章节 → 可恢复 → 可验证交付”。新功能若不能改善这条主路径，必须先证明不会增加主路径复杂度；否则延后。
- **过程产物不入库**：截图、跑批输出、临时报告和本地验收产物写入 `artifacts/` 或 `.local/`，默认不纳入 Git；只有能作为长期产品规格、用户文档或可复现夹具的材料才提交。
- **文档必须时间标注**：凡是会变化的数字、状态、架构结论、验收结果，都在同一条记录前加 `记录于 YYYY-MM-DD`，并使用 `状态：当前有效|历史记录|待复核`。历史轮次不得伪装成当前状态。
- **文档数字来源**：测试数、文件数、版本号和验收结果必须来自对应命令或发布脚本；README 只写当前值，轮次记录写当时值。若无法自动生成，提交前必须用命令复核并同步所有语言版本。
- **给便宜模型的输出格式**：先列“删什么 / 为什么 / 影响”，再改代码；每轮只处理一个收敛目标；改动后运行最小相关测试，并报告实际命令、结果和未处理项。禁止顺手扩 scope。

## CodeGraph 启用规则（记录于 2026-09-06）

- 仅两种情况可建议 `codegraph init`：用户在新项目根目录写出第一行有效代码后，或用户明确要求「初始化 CodeGraph」。只建议、等确认，不代替用户决定。
- 禁止在刚建的空文件夹或系统目录（如 `/home`、`C:\Users`）自动执行 `codegraph init`。
- 绝对禁止在存在父级 `.codegraph` 目录的子文件夹中运行 `codegraph init`，防止嵌套索引互相污染。
- 用户确认某项目已运行过 `codegraph init` 后，该项目内所有代码查询直接用 CodeGraph（MCP 工具或 `codegraph` CLI）自行完成，不再要求用户手动敲命令。

## 写作工作区约定（自 WWRITING.md 逐字迁入，记录于 2026-09-05）

以下约定描述应用创建的写作工作区，不要求维护本仓库时创建小说文件。

- 项目：WWriting Novel Agent（写作 Agent 应用）
- 当前目标：持续迭代 Agent 核心能力与 UI 体验
- 章节篇幅由用户配置（min_words_per_chapter / target_words_per_chapter）
- 写作流程：草稿 → 门禁检查 → 提交 → 入账（finalize_revision）→ 记忆维护三件套
- 记忆三件套纪律：提交/入账/回滚后必须依次完成 update_memory → 更新 book_summary.md → 更新 WORKLOG.md
- 断点恢复纪律：恢复上下文时先读 WORKLOG.md，从上次进行处继续
- 技能：fast-readable（快节奏易读风格）
- 权威文件：
  - 正文：正文/（章节文件，系统保护）
  - 故事摘要：book_summary.md（项目根目录，AI 自由维护）
  - 工作日志：WORKLOG.md（项目根目录，AI 自由维护）
  - 设定档案：memory/continuity.json | memory/continuity.md（仅 update_memory 工具更新）
  - 章节索引：memory/chapter_index.json（系统维护，不可直接编辑）
  - 章节记忆：memory/chapter_memory.json（系统维护，不可直接编辑）
  - 检查点：checkpoints/（系统维护，不可直接编辑）
  - 章节版本库：.versions/chapters/（系统维护，append-only，完整保留不裁剪）
  - 记忆文件版本库：.versions/memory/（系统维护，append-only，每文件 200 版上限）
  - 项目配置：project.yaml（系统维护，不可直接编辑）
  - 审计账本：run_log.jsonl（项目根目录，系统维护，不可直接编辑；记录于 2026-09-24｜依据：round20 Task 7 将 `run_log.jsonl` 纳入 `write_file`/`edit_file` 写保护名单）

## 文档时间与数字规则

- 可变事实使用 `记录于：YYYY-MM-DD｜状态：当前有效/历史记录/待复核｜依据：命令、版本或提交` 标注；整篇同一基线可放在顶部，不同基线按段标注。
- 「当前有效」只表示在所标日期与基线上确认有效，不能推断对当前代码仍成立；影响本次决策时必须复核。
- 测试数、文件规模、版本和验收结果必须注明统计口径及来源；同步中英文 README。历史轮次的数字保留当时值，不能替换成今天的结果。
- 无日期、依据不明或与代码冲突的结论视为待复核，不得猜测或补造验证日期。未重跑的测试应标注「最近一次验证」，不能宣称本轮全绿。
- 新增或修改文档时执行上述规则；本文件是工程规则的唯一入口，规则变更只改这里，不再维护第二份规则文件。

# Ponytail, lazy senior dev mode

You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.

Before writing any code, stop at the first rung that holds:

1. Does this need to be built at all? (YAGNI)
2. Does it already exist in this codebase? Reuse the helper, util, or pattern that's already here, don't re-write it.
3. Does the standard library already do this? Use it.
4. Does a native platform feature cover it? Use it.
5. Does an already-installed dependency solve it? Use it.
6. Can this be one line? Make it one line.
7. Only then: write the minimum code that works.

The ladder runs after you understand the problem, not instead of it: read the task and the code it touches, trace the real flow end to end, then climb.

Bug fix = root cause, not symptom: a report names a symptom. Grep every caller of the function you touch and fix the shared function once — one guard there is a smaller diff than one per caller, and patching only the path the ticket names leaves a sibling caller still broken.

Rules:

- No abstractions that weren't explicitly requested.
- No new dependency if it can be avoided.
- No boilerplate nobody asked for.
- Deletion over addition. Boring over clever. Fewest files possible.
- Shortest working diff wins, but only once you understand the problem. The smallest change in the wrong place isn't lazy, it's a second bug.
- Question complex requests: "Do you actually need X, or does Y cover it?"
- Pick the edge-case-correct option when two stdlib approaches are the same size, lazy means less code, not the flimsier algorithm.
- Mark deliberate simplifications that cut a real corner with a known ceiling (global lock, O(n²) scan, naive heuristic) with a `ponytail:` comment naming the ceiling and upgrade path.

Not lazy about: understanding the problem (read it fully and trace the real flow before picking a rung, a small diff you don't understand is just laziness dressed up as efficiency), input validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs (the platform is never the spec ideal, a clock drifts, a sensor reads off), anything explicitly requested. Lazy code without its check is unfinished: non-trivial logic leaves ONE runnable check behind, the smallest thing that fails if the logic breaks (an assert-based demo/self-check or one small test file; no frameworks, no fixtures). Trivial one-liners need no test.

(Yes, this file also applies to agents working on the ponytail repo itself. Especially to them.)
