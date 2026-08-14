# 模型逻辑轮（第八轮）决策记录与第九轮待办

> 日期：2026-08-14
> 关联规格：`docs/design/2026-08-14-model-logic-round8-spec.md`

## 一、第八轮决策摘要（已确认，勿重复提问）

来源：写作模型在真实项目（D:\aaaa111大学生1111，23 章）自述困难清单，经逐条代码核实后 grilling 确认：

1. **放开正式章节直接编辑**：edit_file / write_file 可写正式章节文件（正文/*.md）；`edit_file` 加可选 `expected_checksum` 防覆盖（stale_checksum）；drafts/ 草稿、索引、checkpoint、记忆档案仍受保护。
2. **确认修订工具 `finalize_revision`**：改完正式章后必须调用入账（重算字数/校验码、更新索引/checkpoint、非散文校验、触发存档）。
3. **轻量版本库（自建快照，不用 git）**：`.versions/chapters/{no}/v{n}.md` + manifest；commit/finalize/rollback 每次生效版本变化都存档，append-only 完整保留；首次启用迁移基线 v1。
4. **回滚工具 `rollback_chapter`（仅模型侧）**：按版本恢复 + 重新入账 + 存档为新版本。**用户明确：UI 时间线/恢复按钮不做，推迟第九轮**。
5. **权限透明**：prompt 增加"项目文件可写性矩阵"（替换原"不得用 write_file/edit_file 绕过"文案）；permission_denied 信息带合法通道指引。
6. **字数口径透明化**：告知模型 actual_words 与 count_text effective_count 是同一口径；**不把字数做成硬门禁**（既定设计不翻案）。
7. **GBK 修复**：shell 输出 Windows 下按 GBK 解码为 UTF-8（TextDecoder，不引新依赖）。

## 二、第九轮待办（用户指定：本轮不实现，第九轮规划时自动带上）

1. **AI 自动记忆提取**（对应困难 4"永远 skipped"）：实装生产 memoryExtractor——当前模型 + 增量更新（读"新章 + 现有摘要"合并输出），commit/finalize 后自动触发，失败标记可重试、不阻塞提交；届时 memory_update 不再 skipped。用户原话：第九轮问到时"你就知道了，你就可以自动写进去，说是自动提取第九轮要做"。
2. **UI 版本时间线 + 恢复按钮**：阅读页 / 项目详情页双入口，读 `.versions/` 展示历史与恢复；第八轮只做模型侧 rollback_chapter。
3. **任务断点恢复**（困难 7）：模型工作进度持久化，中断后可续；工作量和自动提取相当，故同排第九轮。

## 三、执行顺序提醒

- 第八轮执行需在 UI 打磨轮（`docs/superpowers/plans/2026-08-14-restore-settings-sections.md`）完成之后。
- 第八轮执行时按 CLAUDE.md 门禁：跑 `verify:app-shell`、`verify:app-clickability`、`verify:desktop-shell`，交付前 `verify:local`。

## 四、模块 C 执行完成

- 模块 C 已执行完成（含对抗审查修订）；`finalize_revision` / `rollback_chapter` / `.versions/` 基线迁移与账本漂移检测均已落地，`simulate-user-flow.mjs` 已补修订入账正向场景（正式章节可直接编辑 + finalize_revision 入账 + checkpoint_linked）。
