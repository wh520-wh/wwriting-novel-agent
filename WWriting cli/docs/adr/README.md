# 架构决策记录（ADR）

这个目录记录**为什么这么做**——尤其是那些「未来某个人会觉得这里写反了、想把它改回去」
的决定。**改代码之前先看这里。**

格式很简单：一条决定 + 当时可选的做法 + 后果。不写实现细节（实现细节在代码注释里）。

| 编号 | 决定 |
| --- | --- |
| [0001](./0001-event-log-is-the-only-source-of-truth.md) | 会话状态以事件日志为唯一真相源 |
| [0002](./0002-private-data-stays-out-of-the-novel-folder.md) | 私有数据只进应用私有目录，创作目录只由模型经权限确认后写入 |
| [0003](./0003-input-area-owns-its-own-rows.md) | 输入区（含上下框线）归输入层所有，渲染器通过 composer 协议借用 |
| [0004](./0004-onboarding-triggers-on-missing-config-file.md) | 首次引导按「config.json 不存在」触发，不按「未配置」触发 |
| [0005](./0005-history-budget-counts-characters-not-tokens.md) | 历史回放按字符预算，不引 tokenizer |
| [0006](./0006-project-memory-reread-with-hash-shortcut.md) | 项目记忆每轮重读，用内容哈希短路缓存失效 |
| [0007](./0007-project-memory-lives-in-the-novel-folder.md) | `WWRITING.md` 属于作品，进创作目录 |
| [0008](./0008-project-memory-injected-as-tagged-message.md) | 项目记忆作为带标记的独立消息注入，不塞进 system prompt |
| [0009](./0009-effort-four-levels-deviate-from-upstream-copy-spec.md) | `/effort` 直通 API 四档，刻意偏离上游的「低/中/高」文案规格 |
| [0010](./0010-bare-launch-starts-a-new-session.md) | 裸启动开一个全新会话，「接着上次」由 `-c` 显式表达 |
| [0011](./0011-screen-replay-shares-the-model-memory-budget.md) | 屏幕重演与模型记忆共用同一份预算 |
| [0012](./0012-reasoning-is-journaled-but-never-sent-back.md) | 思考正文全量落盘、只经命令查看、绝不回喂模型 |
| [0013](./0013-skill-discovery-three-roots-project-overrides-builtin.md) | 技能发现裁剪为三根：内置 / 全局 / 项目，项目可覆盖内置 |
| [0014](./0014-skill-catalog-summary-in-system-message-progressive-read-skill.md) | 技能目录块只注入摘要进 system 消息，正文经 read_skill 渐进读取 |
| [0015](./0015-compact-manual-only-no-auto-compaction.md) | `/compact` 只做手动触发，CLI 不做自动压缩 |
| [0016](./0016-markdown-incremental-block-parser-no-marked.md) | 正文 Markdown 用自写的增量块级解析，不引 marked |
| [0017](./0017-plan-lives-in-live-area-panel-plus-scrollback.md) | 任务计划在终端 = 实时区常驻面板 / chip + 滚动区全表 |
| [0018](./0018-terminal-motion-discipline.md) | 终端动效纪律 = 唯一受控 spinner，运行态才推进，终态 0 循环动效 |
| [0019](./0019-prose-vertical-rhythm.md) | 正文垂直节奏 = 致密块矩阵 + 正文→UI 单空行，模型原文空行照旧透传 |
| [0020](./0020-permission-mode-shift-tab.md) | Shift+Tab 二态环切换权限模式（普通 ↔ YOLO），进 YOLO 需确认卡，仅空闲可切 |
| [0021](./0021-ctrl-s-immediate-submit.md) | Ctrl+S 立即提交：草稿成为下一条活动输入，有活动轮先打断（终端侧有意偏离上游 P3） |
| [0022](./0022-slash-menu-enter-submits.md) | 斜杠菜单回车提交原文，有意偏离上游 §4.7 的「Enter 只填入不执行」 |
| [0023](./0023-now-interrupt-promote.md) | `/now` 保留打断式提升（裁决 A3）：打断当前轮、同一 drain 接手，有意偏离上游 P3 |

> 0006–0008 是 `WWRITING.md` 项目记忆的设计决策（铁律 7）。并发写语义已随 Q12 拍板（最后写者赢，
> 防线是确认卡显示变更）；`/init` 更新契约经 2026-09-28 对抗性审查收敛为
> 「prompt 职责 + 确认卡 diff（程序只读）」，程序写盘的路线已被否决。

## 正在进行的设计

| 草案 | 内容 |
| --- | --- |
| [`docs/design/2026-09-28-wwriting-md-项目记忆-设计草案.md`](../design/2026-09-28-wwriting-md-项目记忆-设计草案.md) | 第一部分：`WWRITING.md` 项目记忆（铁律 7）；第二部分：`/effort` 思考强度切换 |

## 什么时候该加一条

三条**都**要满足，缺一条就别加：

1. **难逆转**——将来改主意代价明显。
2. **没有上下文会觉得奇怪**——未来读者看着代码会想「他们为什么这么干？」。
3. **是真实取舍**——当年确实有别的做法，是按具体理由选的。

容易逆转的（改一下就回去了）、不奇怪的、只有一个明显做法的，都不需要 ADR。

## 与其它文档的分工

- `AGENTS.md` —— 铁律（产品与规格约束），是**规范性**的，不是解释。
- `docs/superpowers/plans/` —— 某次改动的实施计划，做完即为历史记录。
- **本目录** —— 决定背后的理由，**长期有效**。
- `.superpowers/sdd/` —— 本地规划账本（**不进版本库**，见 `.gitignore`）。
  注意：那里的裁决只有本机可见，凡是值得留给后来人的，**要落到这里**。
