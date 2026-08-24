# Competitive Research: UI/UX 与设计规范——按钮 / 界面模式 / 桌面交互 / Diff 视图（合并版）

- 日期：2026-08-24；模式：Standard（6 个取证来源：Ant Design、shadcn/ui、VS Code、GitHub PR 审查、Scrivener、RaptorWrite）
- 决策问题：WWriting 的 AgentSurface 与设置页应采用什么量级的 UI 规范数值与界面模式；diff/版本、命令入口、双栏工作区各用什么已验证范式。

## Executive Conclusion

桌面应用的 UI 规范数值在两大设计系统上高度收敛：**控件高度 24/32/40、圆角 4/6/8、每视图至多一个主按钮**（AntD token [E2]），WWriting 可直接采纳为 token 表。界面模式上，写作工具的基线是**双栏/多文档 + 侧边结构树**（Scrivener 的 binder+corkboard [E5]、RaptorWrite 的大纲+正文并排 [E6]），而 WWriting 当前以单对话面为主——双栏是值得做的可选布局而非重构。diff/审查语义的金标准是 GitHub 的**两段式（pending 私有意见 → 提交生效）+ suggestion 建议块 + Viewed 折叠** [E4]，恰好映射到审稿子代理的意见呈现。命令入口收敛于**统一命令面板**（VS Code [E3]）。明确的 non-goal：不做三方合并工具与云端协作审查流。

## Current Product Baseline

WWriting：AgentSurface 单一对话面（对话、工作组条目、Visible Plan、队列、`立即`/`停止`、权限确认卡）、左侧两级树（项目/会话）、顶部"面板"抽屉（章节目录与导出、模型配置、资料、成本仪表盘）、设置页（供应商/模型两级管理）。无公开的设计 token 表；无命令面板；无 diff 视图（版本恢复为快照式）。

## Competitor Comparison

| Source | 领域 | Evidence | Lesson | Do Not Copy |
| --- | --- | --- | --- | --- |
| Ant Design Button | 设计系统数值 | [E2] | 数值级规范可直接抄：controlHeight 32/40/24、paddingInline 15/7、borderRadius 6/8/4、lineWidth 1、fontWeight 400、iconGap 8、colorPrimary #1677ff、colorError #ff4d4f、禁用态 rgba(0,0,0,0.04/0.25)、loading 不透明度 0.65；规范语"一节内至多一个主按钮" | 16 种预设色（写作用不上） |
| shadcn/ui Button | 设计系统结构 | [E1] | 变体枚举（default/secondary/destructive/outline/ghost/link）× 尺寸枚举（default/xs/sm/lg/icon 四档）的正交结构；Tailwind v4 把按钮 cursor 改回 default 的兼容注意点 | 需要读源码才有 class 串（文档页不含） |
| VS Code 命令面板 | 桌面交互 | [E3] | 一个交互窗口承载命令/文件/符号/行号跳转（前缀切换），"?"列出可用命令；键盘优先是桌面工具的默认预期 | 面板可拖拽等次要特性 |
| GitHub PR 审查 | diff/版本 UI | [E4] | unified/split 双视图且偏好持久化；行级蓝图标评论 + 多行拖选；```suggestion 建议块可一键应用；意见先 pending（仅自己可见）再提交；Viewed 折叠 + 进度条；提交三态 Comment/Approve/Request changes；作者不能自批 | 分支保护/规则集等仓库治理 |
| Scrivener | 写作软件基线（非 AI） | [E5] | 活页夹结构树 + 卡片板（拖动卡片即重排手稿）+ 大纲元数据视图；Compile 多格式导出；快照 + Compare；自动保存/开关备份 | 交互密度与学习曲线 |
| RaptorWrite | 写作 agent 界面 | [E6] | Multi-Document View（大纲与正文并排）；发送前预览 AI 将看到的上下文；版本快照；提示词库 | 云端保存的可靠性问题 |

## Cross-Market Patterns

- **数值收敛**：控件三档高度（24/32/40）、圆角三档（4/6/8）、主按钮唯一性原则 [E2]；变体×尺寸正交枚举 [E1]。
- **写作工具布局基线**：结构树（章节/设定）+ 编辑/对话主区 + 可选第二文档栏（Scrivener binder [E5]、RaptorWrite 多文档 [E6]）。
- **审查/建议语义**：pending→submit 两段、建议块可应用、完成即折叠（GitHub [E4]）——与 WWriting 权限确认卡、审稿意见天然同构。
- **桌面键盘入口**：统一命令面板是桌面生产工具标配 [E3]。
- **Non-goal**：三方合并工具、云端协作审查、多光标编辑器。

## Prioritized Roadmap

### P0

建立 WWriting 设计 token 表并落文档：控制高度 24/32/40、圆角 4/6/8、间距/图标距 8、主色/危险色、禁用与 loading 态（对标 AntD 数值 [E2]）、按钮变体×尺寸正交枚举（对标 shadcn [E1]）、"每个视图至多一个主按钮"写入规范。验收信号：docs/design 出现 token 表，且 AgentSurface/设置页现有按钮全部可映射到该表（差异项列改造清单）。

### P1

1. 审稿/修改建议的 diff 呈现：对标 GitHub suggestion 块与行级评论 [E4]——审稿意见按章节片段给出"建议替换块"，采纳时走既有写入校验（校验和/版本快照）。验收信号：至少一类审稿意见以"原文→建议"块呈现，采纳后自动生成版本快照。
2. 统一命令面板（Ctrl+K / Ctrl+Shift+P）：聚合切换会话/工作区、打开各面板、选择技能、导出成书、开始/停止 Run（对标 VS Code [E3]）。验收信号：一个入口覆盖 ≥6 个高频操作，全键盘可达有验收用例。

### P2

双栏可选布局：左侧结构树（章节/设定/WWRITING.md）+ 右侧对话面，列宽可调（对标 Scrivener binder [E5] 与 RaptorWrite 多文档视图 [E6]），默认仍为单对话面。验收信号：设置中可切换双栏布局，切换后既有功能全部可用。

## Research Limits and Next Validation

- Claude Artifacts 官方公告页（anthropic.com/news、claude.com/blog）均 404/重定向失败，agent 对话+产物窗口模式未取得官方原文，未进入结论（以 RaptorWrite 多文档视图替代该证据位）。
- shadcn/ui 的具体 class 串（h-9 px-4 等）在文档页未展示，需读组件源码补充；本次仅采信变体/尺寸枚举。
- 未取证 Fluent 2 / Material 3（官方规范站为重 JS 渲染，预期难抓）；设计数值仅以 AntD 为准，多系统交叉验证留待后续。
- 下一步验证：用 AntD token 表跑一次 AgentSurface 现状差距审计；命令面板做一次纸面原型用户测试。
