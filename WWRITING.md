---
schema_version: 1
writing_style_skill: fast-readable
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
