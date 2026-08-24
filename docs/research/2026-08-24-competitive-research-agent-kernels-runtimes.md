# Competitive Research: Agent 内核与运行时架构（合并版）

- 日期：2026-08-24；模式：Standard（6 个运行时/框架：Claude Agent SDK、OpenCode、Gemini CLI、Cline、Aider、LangGraph）
- 决策问题：成熟 agent 运行时在内核循环、权限、会话持久化/恢复、子代理/命令/钩子等运行时能力上的已验证设计，哪些是 WWriting 内核的下一步，哪些明确不做。

## Executive Conclusion

2025-2026 的 agent 运行时已在六件事上形成生态标配：**权限分档、会话持久化与恢复、项目级记忆文件、自定义命令、子代理、MCP 扩展**——Claude Agent SDK 把它们打包为库 [E1]，Gemini CLI 与 OpenCode 以 Apache/MIT 开源实现同构能力 [E2][E3]。WWriting 的 Journal 事件溯源 + 断点恢复在"恢复"维度上与 Gemini checkpointing [E3]、LangGraph durable execution [E6] 同级甚至更细，权限体系（按输入粒度授权、极端操作精确确认）仍是全场最严格之一 [E4 对照]。最值得补的是**子代理**：Claude/OpenCode 均将其作为运行时一等公民 [E1][E2]，且与批 1 调研发现的"独立审校代理防自我合理化"（long-novel-writer）直接呼应——WWriting 的写后校验目前缺少独立上下文。明确的 non-goal：不引入 MCP 全量生态与联网工具市场（与默认禁网、本地优先冲突）。

## Current Product Baseline

WWriting：ProjectAgent 单内核（循环 + 章节队列 + `立即`/`停止`）、Journal 事件溯源（会话独立事件流、可轮转、session.json 可重建投影）、权限四档（只读自动/确认/YOLO/极端精确确认文字）、SKILL.md 技能体系（四层目录覆盖）、WWRITING.md 项目记忆、200 版章节快照 + 校验和、同项目串行 Run。

## Competitor Comparison

| Runtime | Category | Evidence | Lesson | Do Not Copy |
| --- | --- | --- | --- | --- |
| Claude Agent SDK | baseline（生态标杆） | [E1] | 运行时能力清单的事实标准：agent loop / permissions / sessions（resume or fork）/ subagents / hooks / skills+memory / MCP / plugins 打包为库 | Python/TS 单语言生态；托管沙箱方向（Managed Agents） |
| OpenCode | direct（开源运行时） | [E2] | 以"内置 agent"表达权限档（build 全权 / plan 只读、拒绝编辑、bash 需确认）；200.6k stars MIT 验证开源运行时的市场 | YOLO 一键安装脚本的激进默认 |
| Gemini CLI | direct（开源运行时） | [E3] | Conversation checkpointing 保存/恢复复杂会话；GEMINI.md 项目记忆；custom commands + extensions 双层自定义；三种认证档对应免费额度 | 1M 上下文依赖特定模型供应商 |
| Cline | direct（IDE agent） | [E4] | "Every action requires your explicit approval" 的极简人控话术 + BYOK；以 SDK + 多壳（VS Code/CLI/Kanban）复用同一内核 | 文档首页未展示 plan/act 与 checkpoint 细节（取证边界） |
| Aider | direct（终端 agent） | [E5] | repo map 让模型在大型项目导航；每次变更自动 git commit 生成信息，用熟悉的 git 工具 diff/undo AI 改动；自动 lint/test 钩子 | 终端形态的受众局限 |
| LangGraph | adjacent（框架） | [E6] | "durable execution"：失败后从精确断点自动恢复；human-in-the-loop 可在任何时点检查并**修改** agent 状态；短期工作记忆 + 跨会话长期记忆分层 | 图编排抽象对写作场景过重 |

## Cross-Market Patterns

- **Table stakes（运行时）**：权限分档 [E1][E2][E4]；会话保存/恢复/检查点 [E1][E3][E6]；项目级记忆文件（GEMINI.md / .claude 记忆 ↔ WWRITING.md）[E1][E3]；自定义命令 [E1][E3]；子代理 [E1][E2]。
- **WWriting 已对齐或领先**：事件溯源粒度的恢复（多数为快照式 checkpoint）[E3 对照]；按输入粒度授权与极端操作精确确认（全场未见第二家）[E4 对照]；版本快照带校验和（Aider 用 git、Gemini 用 checkpoint，粒度均粗于 200 版/文件）[E5]。
- **WWriting 缺口**：子代理（无独立上下文的审校/查证执行体）[E1][E2]；会话 fork（从历史点分支新对话）[E1]；hooks（生命周期回调，如 Aider 的自动 lint/test [E5]、Claude hooks [E1]）。
- **Non-goal**：MCP 工具市场与联网扩展生态；把内核改造成图编排框架 [E6]。

## Prioritized Roadmap

### P0

引入受限"审稿子代理"：只读、独立上下文、由主 Run 在写后校验时派生，产出结构化意见（冲突清单/POV 越界/未兑现伏笔），意见回流主对话。对标 Claude subagents 的运行时地位 [E1] 与 OpenCode @general 子代理 [E2]，并回应批 1 调研发现的"独立校验防自我合理化"结论。验收信号：审稿以独立只读子代理执行，Journal 记录派生关系，产出含分类意见清单。

### P1

1. 自定义斜杠命令：允许用户/项目定义 `/命令`（放入技能目录或 WWRITING.md 索引），对标 custom commands 生态标配 [E1][E3]。验收信号：用户可在项目内定义一个命令并在输入框触发。
2. 会话 fork：从任意历史消息点派生分支对话（原会话不动），对标 sessions "resume or fork" [E1]。验收信号：任一历史消息可"从这里分支"，新会话继承到此为止的上下文与文件状态索引。

### P2

hooks 预研：章节提交前/工具调用前的用户自定义回调（如自动跑 count_text、格式检查），对标 Aider 自动 lint/test [E5] 与 Claude hooks [E1]。验收信号：一份设计笔记定义 ≥2 个钩子点与失败语义；MCP 生态与图编排改造明确列为 non-goal。

## Research Limits and Next Validation

- Cline 的 Plan/Act 模式与 checkpoints 细节未从 docs 首页取证（首页为营销概览），仅采用"每步显式批准 + BYOK"两条事实。
- OpenCode 的 client/server 架构、会话存储与 compaction 未在 README 呈现，需查 opencode.ai/docs；本报告只采信 README 明示内容。
- Aider 的 edit formats（diff/whole）、/undo 命令与 tree-sitter repo map 机制未在仓库页取证（在 aider.chat 文档），未进入结论。
- LangGraph time-travel 与 checkpoint 具体语义未从重定向页取证，仅采用 README 的 durable execution / HITL 描述。
- 下一步验证：读 OpenCode docs 的会话存储与插件章节；实测 Gemini CLI checkpoint 的恢复粒度与 WWriting Journal 恢复对比。
