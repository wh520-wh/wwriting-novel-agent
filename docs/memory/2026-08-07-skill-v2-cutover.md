# 2026-08-07 技能 v2（SKILL.md）切换与一次性迁移

- 关联：[[2026-08-07-agent-work-log-markdown-and-skills]]（plan，§2.5 SKILL.md 最小 schema、Task 11）
- 分支：`agent-work-log-skills`（工作树 `D:\WWriting\.worktrees\agent-work-log-skills`）
- 提交：`feat: migrate legacy skills to SKILL.md`（Task 11）

## 背景

技能从旧 manifest（`skill.json` / `skill.yaml` / `skill.yml`）一次性迁移到 `SKILL.md`，
不建立双轨运行时：**旧 manifest 只作为迁移输入；新运行时只读取 SKILL.md。**

- 新格式见 plan §2.5：`name`/`description`/`version` 顶层 frontmatter；
  `scope`/`priority`/`hooks` 在 `metadata.wwriting`；`append_prompt.content` →
  正文 Instructions；`check.prompt` → 正文 Review checklist（保留 checker id）。
- 旧运行时 `src/core/skill-runtime.mjs`（`BUILTIN_SKILLS` + 旧 manifest 加载器）
  在 Task 12 删除。

## 迁移行为（`src/core/skills/legacy-migration.mjs`）

幂等管线（任一步失败不删除源文件）：

1. 扫描旧 manifest（`json > yaml > yml` 优先级；同名多 manifest 只迁移一次，全部入 backup）
2. 解析为统一中间对象
3. 原子写 `SKILL.md`
4. 重新调用 `readSkillFile` 验证（目录名必须与 frontmatter `name` 一致）
5. 移动旧文件到 `<userHome>/.wwriting/migrations/skills-v2-backup/<scope>/<name>/`
   （跨盘 rename 失败时复制成功后删除源文件）
6. 原子写 migration marker（`<backupRoot>/<scope>/migration-marker.json`）

marker 至少包含 `schema_version: 2`、`completed_at`、`migrated[]`、`failed[]`。
**单个技能迁移失败不阻止其他技能**；失败项写入 `failed[]`，catalog 通过
`migration_errors` 暴露给 UI。live 目录已有合法 SKILL.md 的技能只备份旧 manifest，
绝不改写已验证文件（幂等）。

接入：`skillService.catalog/read/importSkill/removeSkill` 工作前统一调用
`ensureMigrated({ projectRoot, userHome })`。全局迁移 Promise 每进程每个 userHome
只创建一次；项目迁移 Promise 按 canonical projectRoot 缓存。新 catalog 只在迁移
完成后运行，永远不读取 `skill.json/yaml/yml`。

## 版本时间线（删除 migrator 的依据）

| 版本 | 状态 |
|---|---|
| v0.5.0 | **首次引入并自动迁移**：启动/打开项目时 `ensureMigrated` 自动把旧 manifest 迁到 SKILL.md，live 目录只剩 SKILL.md + 资源 |
| v0.6.x | **仍保留 migrator**：支持从 v0.5.0 之前版本直接升级到 v0.6.x 的用户自动迁移 |
| v0.7.0 | **删除 `legacy-migration.mjs`**：从更旧版本（< v0.5.0）直接升级到 v0.7.0 的用户**需先运行 v0.6 或独立迁移脚本**再升级 |

## 删除 migrator 的完成条件

1. bundled / global / project 的 live 目录均无旧 manifest：
   - bundled：构建期由 Task 10 直接落地五个内置 SKILL.md（`src/skills/`），不含旧 manifest；
   - global（`<userHome>/.wwriting/skills`）与 project（`<projectRoot>/skills`）：
     各 live 技能目录只允许 `SKILL.md` 与 `scripts/`、`references/`、`assets/` 资源。
2. 全量测试不再引用 `enabled_skills`（旧启用集合概念已删除，新模型无 enable/disable）。

## 注意事项

- 迁移失败项在 `migration_errors` 中按次进程缓存；进程重启后从 marker 文件可重新读取完整记录。
- project 的备份统一落在 `<userHome>/.wwriting/migrations/skills-v2-backup/project/`，
  不散落在项目目录；跨盘（project 与 home 不同盘）时以复制-删除方式搬运。
- 旧 manifest 的 `enabled: false` 语义不再存在：所有迁移后的技能都会出现在 catalog 中。
- 删除 migrator 前必须先检查 bundled/global/project 三处 live 目录与测试引用（见完成条件）。
