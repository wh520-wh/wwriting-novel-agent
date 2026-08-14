# 模型逻辑轮（第八轮）规格 v1：修订、回滚、权限透明与口径统一

> 日期：2026-08-14
> 状态：已完成产品语义确认（grilling 逐项确认），可据此编写实施计划
> 前置：UI 打磨轮（`docs/superpowers/plans/2026-08-14-restore-settings-sections.md`）执行完成后进行
> 来源：模型在真实写作项目（D:\aaaa111大学生1111，23 章）中自述的困难清单 + 逐条代码核实

## 一、背景与目标

写作模型在真实项目中自述了 7 条困难，经代码核实：

| # | 模型报的困难 | 核实结论 |
|---|---|---|
| 1 | 权限声明与实际打架（yolo + 可写根目录，edit_file 改章节却 permission_denied） | **属实**。prompt 声明 `permission_mode: yolo` + `writable_roots` 含项目根，但章节文件受"只能经专用工具写"纪律拦截；拒绝信息只说"当前权限不允许"，不告诉正确通道 |
| 2 | 章节协议只增不修（无任何工具能改已提交章节） | **属实**。只有 append_chapter_segment / commit_chapter |
| 3 | 草稿对账缺失（报 duplicate/content_mismatch 但不给 diff/来源） | **属实**（本轮只解决"修订可撤销"，diff 工具不引入） |
| 4 | 派生记忆永不更新（memory_update 永远 skipped/no_extractor） | **属实**。runtime 有提取 seam（Task 14），但生产链路 memoryExtractor 恒为 null → 永远 skipped |
| 5 | 字数口径不统一、门禁为空 | **半真**。actual_words 与 count_text 的 effective_count **同源**（同一函数 countEffectiveWords），但从没告诉模型；"门禁为空"是刻意设计（字数不是完成门禁），**本轮不翻案** |
| 6 | 无版本控制与回滚 | **属实** |
| 7 | 中断无断点恢复 | 会话层有 restored_transcript，任务级进度无持久化（**推迟第九轮**） |
| 附加 | Windows shell 输出 GBK 乱码 | **属实** |

**本轮目标**（grilling 确认的范围）：修订直编、确认入账、轻量版本库与模型回滚、权限透明（清单+拒绝指引）、字数口径透明化、GBK 修复。

**推迟到第九轮（不实现，仅预留）**：AI 自动记忆提取、UI 版本时间线/恢复按钮、任务断点恢复。详见 §七。

## 二、第一性原则目标模型

### 2.1 长期不变量（本轮新增/强化）

1. **正式章节文件可被直接编辑**：已提交章节是"可修改的成品"，不是"只读归档"。
2. **一切生效内容必须有账**：任何改变正式章节文件的操作，最终必须经入账（commit 或 finalize）使索引/校验码/checkpoint 一致；账与文件不一致是可检测、可修复的中间态。
3. **每次生效版本变化都留档**：快照 append-only，完整保留，回滚本身也是历史的一部分。
4. **权限边界显式声明**：哪些路径可写、哪些必须走专用工具、哪些只读，模型在每轮提示词中可见；拒绝信息必须指出合法通道。
5. **数字口径单一**：所有面向模型的字数数字（commit actual_words、count_text effective_count）同一口径，并明确告知等价关系。
6. **外部工具不引入**：版本库用自建轻量快照（§四 D3），不依赖 git（git 需项目级 init、管不了账本、有换行符/冲突坑）。

### 2.2 保留、重塑、替换、删除

| 判断 | 内容 |
|---|---|
| 保留 | append_chapter_segment / commit_chapter 草稿管线；草稿目录纪律；原子写；校验和；checkpoint；Task 14 记忆解耦（seam 不动，第九轮实装提取器） |
| 重塑 | 正式章节文件的写纪律（禁止 → 放行 + 入账义务）；prompt 章节纪律文案；permission_denied 错误信息（加合法通道）；shell 输出解码 |
| 替换 | 无 |
| 删除 | 正式章节文件在工具权限层的写拦截（保留 drafts/、索引、checkpoint、记忆档案的拦截） |

## 三、现状关键事实（实现前必须核实的位置）

- `src/core/agent/tools.mjs`：通用工具集含 write_file/edit_file/shell；权限判定在 permissionPolicy（:456-474 附近）；草稿目录拦截已验证（tests/agent/tools.test.mjs:794 "drafts/ 只能经 append_chapter_segment 写入：auto_edit 与 yolo 下直写也被拒"）——**正式章节文件的写拦截位置需实现时定位**（大概率与 draft_files 同类路径分类）。
- `src/core/agent/prompt.mjs:153`：现文案"不得用 write_file、edit_file 或 shell 直接写章节索引、正式章节文件、checkpoint、完成状态或草稿目录，绕过章节专用工具"——**与 D1 直接矛盾，必须改写**。
- `src/core/agent/prompt.mjs:79-80,120-128`：permission_mode / writable_roots 注入点。
- `src/core/word-count.mjs`：`countEffectiveWords()` 与 count_text 的 `effective_count` 同源（cjk + latin_words + numeric_tokens）。
- `src/core/project-operations/chapter.mjs:308,346,382,467,491`：actual_words 均取自 countEffectiveWords。
- `src/core/agent/runtime.mjs:144-177,263-269`：commitChapterWithDerivedMemory；memoryExtractor 默认 null。
- `src/core/project-store.mjs:136`：章节索引 quality_gate_results 恒 []（刻意设计，不动）。
- shell 工具执行体：位于 tools.mjs；当前子进程输出未做 GBK 解码（实现时确认 exec/spawn 编码路径）。

## 四、设计决策

### D1 放开正式章节直接编辑（edit_file / write_file）

**决策**：正式章节文件（章节索引 final_path 指向的正文 .md）允许 write_file / edit_file 写入；`edit_file`/`write_file` 均增加可选参数 `expected_checksum`（模型读取/上次写入获得的对应当前校验和），文件已被其他会话改动（校验和不匹配）时拒绝（错误码 `stale_checksum`），实现防覆盖。

**仍受保护（不可写）**：`drafts/` 草稿（只能经 append_chapter_segment）；章节索引、checkpoint、校验/状态文件、`project.yaml` 等系统文件；`memory/` 派生档案。

**义务**：编辑后必须调用 D2 的 `finalize_revision` 入账，否则账本不一致；系统在后续运行中可检测"正式文件 checksum 与索引不符"并提示模型入账。

**交互流程**：read_file 读正式章（返回含 checksum）→ 模型编辑 → finalize_revision（带 expected_checksum）→ 入账 + 存档。

### D2 确认修订工具 `finalize_revision`

**决策**：新增深工具 `finalize_revision`，语义 = "把当前正式章节文件的状态入账"。

- 参数：`project_id`、`chapter_no`、可选 `expected_checksum`。
- 校验：章节必须已提交（索引存在）；expected_checksum 与当前文件匹配（防覆盖）；内容跑 `detectNonProseContent`（防模型把工具名/内部字段复述进正文的事故，复用 append/commit 链路同一检测）。
- 入账动作：重算 actual_words / checksum → 更新章节索引（actual_words、checksum、updated_at）→ checkpoint → run_log。
- `memory_update` 字段：**保持现状**（未实装提取器时如实标记 skipped/no_extractor；第九轮实装后自动生效，无需改此工具）。
- 与 commit_chapter 的关系：commit 管"草稿 → 正式"；finalize 管"正式 → 重新入账"。两者成功后都触发 D3 存档。
- 对未提交/不存在的章节：拒绝（`chapter_not_committed`）。

### D3 轻量版本库（自建快照，append-only）

**决策**：每次"生效版本变化"（commit_chapter 成功、finalize_revision 成功、rollback_chapter 执行）时，把当前正式文件内容存档为快照；完整保留，不裁剪。

- 位置：`{projectRoot}/.versions/chapters/{chapter_no:03d}/v{n}.md`（n 从 1 递增）；同级 `manifest.json` 记录 `{version, timestamp, source: "baseline"|"commit"|"revision"|"rollback", checksum}`。
- 迁移（首次启用）：对每个已有正式章节，把当前内容存为 v1（source: baseline）。仅此一次，幂等（存在 v1 则跳过）。
- 目录 `.versions/` 为系统目录：模型只读（可 list/read 但不建议），不进正文索引；project-store 建项目时无需改动（惰性创建）。
- 不引入 git、不引入新依赖；快照为纯文件复制 + 原子写。
- diff：本轮不提供 diff 工具（用户优先级 2 的 diff 部分降级为"回滚可撤销"，第九轮 UI 时间线如需差异对比再评估）。

### D4 回滚工具 `rollback_chapter`（仅模型侧）

**决策**：新增工具 `rollback_chapter`（`project_id`、`chapter_no`、`version` 数字；省略 version = 上一版）。

- 流程：校验版本存在 → 快照内容原子写回正式文件 → 重新入账（复用 D2 的入账逻辑，含非散文校验）→ **存档为新版本**（append-only：回滚本身也是历史，时间线完整）。
- 权限：模型侧可自主调用（用户在 grilling 中确认"只做模型工具"；UI 恢复按钮/时间线推迟第九轮）。
- 错误：版本不存在 → `version_not_found`；无历史版本 → `no_versions`。

### D5 权限透明：清单 + 拒绝指引

**决策**：双管齐下。

1. **提示词可写性矩阵**（prompt.mjs 章节纪律段落改写，替换现 :153 文案）：

   ```
   项目文件可写性：
   - 正式章节文件（正文/*.md）：可读可写（write_file / edit_file）；修改后必须调用 finalize_revision 入账，否则账本不一致。
   - drafts/ 草稿：只能经 append_chapter_segment 写入，禁止直接修改。
   - 章节索引、checkpoint、校验/状态文件、project.yaml、memory/ 派生档案：只读，禁止写入。
   - WWRITING.md：仅用户确认或文件可证的长期事实可写。
   ```

2. **拒绝信息带合法通道**：permission_denied / permission_error 的 message 在命中"章节文件保护"规则时，附指引（如"草稿只能经 append_chapter_segment 写入；正式章节文件可经 edit_file 编辑，随后调用 finalize_revision 入账"）。通用拒绝保持原样。

**契约影响**：prompt 文案变化 → 检查依赖该文案的测试（prompt.test.mjs、workflows.test.mjs、agent-surface 相关断言）。

### D6 字数口径透明化

**决策**：告知模型两个数字是同一口径。

- `count_text` 工具描述/返回注释：注明"effective_count 与 commit_chapter 记录的 actual_words 为同一口径（countEffectiveWords：中文字符 + 英文单词 + 数字记号）"。
- `commit_chapter` / `finalize_revision` 结果说明：注明 actual_words 即该口径。
- 实现为描述文案 + 返回结构注释，不改数值逻辑、不加门禁判定（保持"字数不是完成门禁"设计）。

### D7 GBK 输出修复

**决策**：shell 工具在 Windows 下子进程 stdout/stderr 按系统活动代码页（GBK/cp936）解码为 UTF-8 后返回模型；非 Windows 保持 UTF-8。

- 实现：子进程输出以 Buffer 收集，Windows 上用 `TextDecoder("gbk")` 解码（Node 内置 TextDecoder 支持 gbk 标签，**不引入新依赖**）；或按 `chcp` 探测后选择。实现时以最小改动为准。
- 验收：模拟 GBK 字节流输出（如 `Get-Content` 中文文件）在工具结果中不乱码。

## 五、协议与接口定义（汇总）

| 工具 | 变更 |
|---|---|
| `edit_file` | 新增可选参数 `expected_checksum`；正式章节文件写放行；stale_checksum 拒绝 |
| `write_file` | 正式章节文件写放行；可选 `expected_checksum` 防整章覆盖（同 edit_file，stale_checksum 拒绝） |
| `finalize_revision` | **新增**（深工具）：project_id / chapter_no / expected_checksum? → 入账 + 存档 |
| `rollback_chapter` | **新增**（深工具）：project_id / chapter_no / version? → 恢复 + 入账 + 存档 |
| `count_text` | 描述注明口径等价（无行为变化） |
| `commit_chapter` | 描述/结果注明 actual_words 口径（无行为变化） |
| shell | Windows 输出 GBK → UTF-8 解码 |
| prompt（system 层） | 可写性矩阵替代原章节纪律文案；permission_mode/writable_roots 声明保留 |

错误码新增：`stale_checksum`、`chapter_not_committed`、`version_not_found`、`no_versions`。

## 六、测试与验收

- **红测先行**（每项改动先写失败测试）：
  - tools.test.mjs：正式章节文件 edit_file 放行（yolo/auto/confirm 下）；drafts/ 仍拒；expected_checksum 防覆盖（stale_checksum）；rollback/finalize 的 schema 与权限。
  - chapter.test.mjs（project-operations）：finalize 入账（actual_words/checksum/索引/checkpoint）；快照存档（v1 基线迁移幂等、每次生效版本递增、manifest 正确）；rollback（写回 + 入账 + 新版本存档、版本不存在错误）。
  - prompt.test.mjs：可写性矩阵文案存在；"正式章节可编辑 + 必须入账"语义；不再存在"禁止编辑正式章节"旧文案。
  - 新增 GBK 测试：模拟 GBK 字节流 → 结果不乱码。
  - runtime/agent 集成：finalize/rollback 在工具目录中注册、深工具纪律（统一目录）断言更新。
- **回归**：`npm run verify:app-shell`、`npm run verify:app-clickability`（UI 无改动，跑通防回归）、`verify:desktop-shell`；交付前 `npm run verify:local`。
- 受影响既有断言排查：prompt 文案（prompt.test.mjs / workflows.test.mjs / agent-surface.test.mjs 中引用的纪律句）、工具目录断言（tools.test.mjs DEEP_NAMES、verify-unified-agent.mjs 工具列表）、simulate-user-flow.mjs（如引用旧纪律文案需同步）。

## 七、第九轮预留（不实现，仅登记）

以下三项用户已明确推迟到第九轮，届时按本规格 §一 与记忆文件 `docs/memory/2026-08-14-model-logic-round8-decisions.md` 自动纳入规划：

1. **AI 自动记忆提取**：实装生产 memoryExtractor（当前模型 + 增量更新：读"新章 + 现有摘要"合并输出），commit/finalize 后自动触发，失败标记可重试、不阻塞提交；届时 memory_update 不再 skipped。
2. **UI 版本时间线 + 恢复按钮**：阅读页 / 项目详情页双入口，读取 `.versions/` 展示历史与恢复操作（本轮只做模型侧 rollback_chapter）。
3. **任务断点恢复**：模型工作进度（写到哪、改到哪）持久化，中断后可续。
