# Issue tracker：本地 Markdown

记录于：2026-09-26｜状态：当前有效｜依据：setup-matt-pocock-skills 首次配置（用户选定「本地 markdown」）

本仓库的 issue 与 spec 以 markdown 文件形式存放在仓库内 `.scratch/` 下。

**不使用 GitHub Issues 作为技能读写位置**：远端 `wh520-wh/wwriting-novel-agent` 虽已开通 Issues 且 `gh` 已登录，但它只作外部反馈入口；技能（`to-tickets` / `triage` / `to-spec`）一律读写 `.scratch/`。

## 约定

- 一个特性一个目录：`.scratch/<feature-slug>/`
- spec 是 `.scratch/<feature-slug>/spec.md`
- 实现 issue 一个 ticket 一个文件：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号；**绝不用单个合并的 tickets 文件**
- 分诊状态写在每个 issue 文件靠上位置的 `Status:` 行（角色串见 `docs/agents/triage-labels.md`）
- 评论与会话历史追加在文件底部 `## Comments` 标题下

## 当技能说「publish to the issue tracker」

在 `.scratch/<feature-slug>/` 下新建文件（目录不存在则创建）。

## 当技能说「fetch the relevant ticket」

读取给定路径的文件。用户通常会直接给路径或 issue 编号。

## Wayfinding 操作（供 `/wayfinder` 使用）

**map** 是一个文件，每个 ticket 对应一个 **child** 文件。

- **Map**：`.scratch/<effort>/map.md`（承载 Notes / Decisions-so-far / Fog 正文）
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号，问题写在正文中。`Type:` 行记录 ticket 类型（`research` / `prototype` / `grilling` / `task`）；`Status:` 行记录 `claimed` / `resolved`
- **Blocking**：靠上位置写 `Blocked by: NN, NN`。当它列出的每个文件都是 `resolved` 时，该 ticket 解除阻塞
- **Frontier**：扫描 `.scratch/<effort>/issues/`，取「未关闭、未阻塞、未被认领」的文件，编号最小者优先
- **Claim**：动工前先把 `Status: claimed` 写入并保存
- **Resolve**：在 `## Answer` 标题下追加答案，把 `Status` 置为 `resolved`，再把一行上下文指针（要点 + 链接）追加到 `map.md` 的 Decisions-so-far

## 与既有实践的关系

`docs/memory/project-progress.md` 的「当前欠账清单（只记不排）」是本仓库**轮次级的债务台账**，不是 issue tracker：它按轮次成节、只记不排，用于登记跨轮次的遗留项。

两者职责不同，不要求互相同步：

| | `.scratch/`（本文件） | `docs/memory/project-progress.md` |
| --- | --- | --- |
| 粒度 | 单个特性 / 任务 | 轮次 |
| 用途 | 可执行的 issue 与 spec | 遗留项登记（只记不排） |
| 读写的技能 | `to-tickets` / `triage` / `to-spec` | 人工维护 |

`.scratch/` 已在 `.gitignore` 中（过程产物不入库，见 `AGENTS.md`「工程收敛规则」）。
