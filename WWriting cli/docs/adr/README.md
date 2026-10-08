# 架构决策记录（ADR）

记录于：2026-10-08｜状态：当前有效｜依据：统一行为规格书 §34 与 CLI 实现复核。条目记录当时为什么选择某种做法；被替代的决定不再约束当前行为。当前状态与验证见[项目记忆](../../../docs/memory/project-progress.md#当前状态)。

这个目录记录**为什么这么做**——尤其是那些「未来某个人会觉得这里写反了、想把它改回去」
的决定。**改代码之前先看这里。**

格式很简单：一条决定 + 当时可选的做法 + 后果。不写实现细节（实现细节在代码注释里）。

| 编号 | 决定 |
| --- | --- |
| [0001](./0001-event-log-is-the-only-source-of-truth.md) | 会话状态以事件日志为唯一真相源 |
| [0002](./0002-private-data-stays-out-of-the-novel-folder.md) | 私有数据只进应用私有目录，创作目录只由模型经权限确认后写入 |
| [0003](./0003-input-area-owns-its-own-rows.md) | 输入区（含上下框线）归输入层所有，渲染器通过 composer 协议借用 |
| [0004](./0004-onboarding-triggers-on-missing-config-file.md) | 首次引导按「config.json 不存在」触发，不按「未配置」触发 |
| [0005](./0005-history-budget-counts-characters-not-tokens.md) | 历史：固定小字符预算已取消；当前按模型窗口估算，见统一书 §34 |
| [0006](./0006-project-memory-reread-with-hash-shortcut.md) | 项目记忆每轮重读，用内容哈希短路缓存失效 |
| [0007](./0007-project-memory-lives-in-the-novel-folder.md) | `WWRITING.md` 属于作品，进创作目录 |
| [0008](./0008-project-memory-injected-as-tagged-message.md) | 项目记忆作为带标记的独立消息注入，不塞进 system prompt |
| [0009](./0009-effort-four-levels-deviate-from-upstream-copy-spec.md) | `/effort` 直通 API 四档，刻意偏离上游的「低/中/高」文案规格 |
| [0010](./0010-bare-launch-starts-a-new-session.md) | 裸启动开一个全新会话，「接着上次」由 `-c` 显式表达 |
| [0011](./0011-screen-replay-shares-the-model-memory-budget.md) | 历史：默认完整重演；模型仅在接近窗口时使用摘要，见统一书 §34 |
| [0012](./0012-reasoning-is-journaled-but-never-sent-back.md) | 思考正文全量落盘、只经命令查看、绝不回喂模型 |
| [0013](./0013-skill-discovery-three-roots-project-overrides-builtin.md) | 技能发现裁剪为三根：内置 / 全局 / 项目，项目可覆盖内置 |
| [0014](./0014-skill-catalog-summary-in-system-message-progressive-read-skill.md) | 技能目录块只注入摘要进 system 消息，正文经 read_skill 渐进读取 |
| [0015](./0015-compact-manual-only-no-auto-compaction.md) | 历史：仅手动压缩已被自动压缩 + 手动入口替代，见统一书 §34 |
| [0016](./0016-markdown-incremental-block-parser-no-marked.md) | 正文 Markdown 用自写的增量块级解析，不引 marked |
| [0017](./0017-plan-lives-in-live-area-panel-plus-scrollback.md) | 任务计划在终端 = 实时区常驻面板 / chip + 滚动区全表 |
| [0018](./0018-terminal-motion-discipline.md) | 终端动效纪律 = 唯一受控 spinner，运行态才推进，终态 0 循环动效 |
| [0019](./0019-prose-vertical-rhythm.md) | 正文垂直节奏 = 致密块矩阵 + 正文→UI 单空行，模型原文空行照旧透传 |
| [0020](./0020-permission-mode-shift-tab.md) | Shift+Tab 二态环切换权限模式（普通 ↔ YOLO），进 YOLO 需确认卡，仅空闲可切 |
| [0021](./0021-ctrl-s-immediate-submit.md) | Ctrl+S 立即提交：草稿成为下一条活动输入，有活动轮先打断（终端侧有意偏离上游 P3） |
| [0022](./0022-slash-menu-enter-submits.md) | 斜杠菜单回车提交原文，有意偏离上游 §4.7 的「Enter 只填入不执行」 |
| [0023](./0023-now-interrupt-promote.md) | `/now` 保留打断式提升（裁决 A3）：打断当前轮、同一 drain 接手，有意偏离上游 P3 |
| [0024](./0024-append-only-single-file-bounded-reads.md) | 会话存储保持 append-only 单文件：读侧有界化，不分片、不建注册表（有意偏离上游 §19/§24） |

> 0006–0008 是 `WWRITING.md` 项目记忆的设计决策（铁律 7）。并发写语义已随 Q12 拍板（最后写者赢，
> 防线是确认卡显示变更）；`/init` 更新契约经 2026-09-28 对抗性审查收敛为
> 「prompt 职责 + 确认卡 diff（程序只读）」，程序写盘的路线已被否决。

## 历史设计来源

| 草案 | 内容 |
| --- | --- |
| [`docs/design/2026-09-28-wwriting-md-项目记忆-设计草案.md`](../design/2026-09-28-wwriting-md-项目记忆-设计草案.md) | 原访谈与审查记录；功能已在源码中存在，未采纳细节不自动转为待办 |

## 什么时候该加一条

三条**都**要满足，缺一条就别加：

1. **难逆转**——将来改主意代价明显。
2. **没有上下文会觉得奇怪**——未来读者看着代码会想「他们为什么这么干？」。
3. **是真实取舍**——当年确实有别的做法，是按具体理由选的。

容易逆转的（改一下就回去了）、不奇怪的、只有一个明显做法的，都不需要 ADR。

## 与其它文档的分工

- 本地 `AGENTS.md`：工程规则；不承担产品进度。
- [统一行为规格书](../../../docs/design/统一行为规格书.md)：现行行为契约。
- [项目状态](../../../docs/memory/project-progress.md)：当前验证和已确认待办。
- 本目录：设计理由；相关决定被替代时，标注历史并指向现行契约。
