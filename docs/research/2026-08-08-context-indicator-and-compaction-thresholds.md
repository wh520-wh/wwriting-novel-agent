# Agent 上下文指示器与压缩阈值调研

- 日期：2026-08-08
- 范围：OpenAI Codex、Anthropic Claude Code；只记录官方文档、官方源码和官方仓库中的可验证事实
- 目的：为 WWriting 的上下文圆环、发送前预检和 256k/1M 压缩阈值提供依据

## 结论先行

1. 把上下文占用做成常驻轻量指示器是合理的。Claude Code VS Code 扩展已有 context indicator，CLI 也允许通过 status line 持续显示已用比例；详细信息则通过 `/context` 展开。
2. 官方产品没有给出统一的 hover/click 交互合同。WWriting 可以采用桌面端常见的 transient hover + click pin popover：悬停临时显示、点击固定、外部点击或 ESC 关闭。
3. 自动压缩放在“下一次发送前预检”是合理架构：先计算下一请求是否越过阈值，必要时完成压缩，再发送用户消息；不需要监听模型切换动作建立第二套机制。
4. Claude Code 当前公开的 Sonnet 5 1M 窗口默认压缩点约为 967K。400K 曾是官方团队公开讨论和建议实验的候选值，不是已经生效的当前默认。
5. 压缩后模型 active context 使用摘要，但项目规则、长期记忆和受预算保护的技能会重新注入；这支持 WWriting 把 Journal、`WWRITING.md` 与模型 active context 分层。

## Claude Code：上下文显示

Claude Code 的正式入口包括：

- `/context`：显示彩色网格、不同类别占用、优化建议和容量警告；`/context all` 展开完整明细。
- 自定义 status line：可读取 `context_window_size`、`used_percentage`、`remaining_percentage`、`total_input_tokens`、`total_output_tokens` 和 `current_usage`。
- VS Code 扩展：prompt box 提供 context indicator，显示已用窗口比例。

`used_percentage` 按输入侧计算：输入 token、cache creation input token 和 cache read input token；不把输出 token伪装成已经占用的输入上下文。`/compact` 后 `current_usage` 可能暂时为空，直到下一次 API 调用更新。

来源：

- [Claude Code Commands](https://code.claude.com/docs/en/commands)
- [Claude Code Status line](https://code.claude.com/docs/en/statusline)
- [Claude Code VS Code extension](https://code.claude.com/docs/en/vs-code)

官方没有说明内置 context indicator 支持 hover/click popover。因此 WWriting 的 hover/click 方案属于产品推断，不应写成竞品事实。

## Claude Code：自动压缩与 1M 阈值

Claude Code 支持 `/autocompact [auto|<tokens>]`、`--autocompact`、`autoCompactWindow` 和 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`。官方还提供百分比覆盖变量，但没有为所有模型公布一个统一默认百分比。

当前模型配置文档明确：Anthropic API 上 Sonnet 5 使用 1M 窗口，默认约在 967K 自动压缩；无法验证 1M 支持或显式禁用 1M 时按 200K 处理。

400K 的证据边界：Claude Code 团队成员曾在官方仓库置顶评论中表示“正在研究把默认值改为 400K”，并建议通过环境变量进行实验。这只能证明 400K 是官方讨论过的候选/实验值，不能证明它成为当前默认。

来源：

- [Claude Code Context window](https://code.claude.com/docs/en/context-window)
- [Claude Code Environment variables](https://code.claude.com/docs/en/env-vars)
- [Claude Code Model configuration：Sonnet 5 context window](https://code.claude.com/docs/en/model-config#sonnet-5-context-window)
- [Claude Code 官方仓库：400K 实验讨论](https://github.com/anthropics/claude-code/issues/45756#issuecomment-4231739206)

## Claude Code：压缩后保留什么

`/compact` 会把截至当前的会话压成结构化摘要；后续模型请求使用摘要，而不是把完整历史继续塞进窗口。官方说明：系统提示与 output style 不变；根级 `CLAUDE.md`、无路径规则和 auto memory 重新注入；路径规则和嵌套规则按再次读取的文件恢复；已调用 skill 在预算内重新注入。

本地 session transcript 会持续保存在应用目录，但官方没有承诺“每次压缩前的所有 JSONL 条目永远原样保留”。WWriting 若要求完整可回看，应把它写成自己的 Journal 产品合同，而不是借竞品含糊保证。

来源：

- [Claude Code Context window](https://code.claude.com/docs/en/context-window)
- [Claude Code Manage sessions](https://code.claude.com/docs/en/sessions)

## OpenAI Codex：可证边界

Codex 官方文档说明 `/compact` 用摘要替换较早上下文以释放 token，并且 Codex 会自动压缩。当前公开资料没有给出所有模型统一的默认压缩百分比，也没有把 context indicator 的 hover/click 交互写成产品合同。

Codex 官方源码可证明：压缩在候选 history 上生成摘要，成功后才替换 live history；取消和失败不会安装半截摘要。相关取消与事务细节见同目录《Agent 压缩取消与失败语义调研》。

来源：

- [Codex Slash commands：`/compact`](https://developers.openai.com/codex/cli/slash-commands#keep-transcripts-lean-with-compact)
- [Codex 本地压缩源码](https://github.com/openai/codex/blob/2e3a1702c2e7adea5f2ae9ea2799c625024b4fda/codex-rs/core/src/compact.rs#L242-L381)

## 对 WWriting 的产品建议

### 圆环与 popover

- 项目打开后圆环始终显示；空闲静态，running/压缩中才出现轻微活性反馈。
- hover 临时展示，点击固定；键盘 focus 等价于 hover，Enter/Space 等价于点击；外部点击和 ESC 关闭。
- popover 锚定圆环，以 120–180ms opacity + 2–4px translate/轻微 scale 进入和退出，无弹跳、无布局位移；减少动态时只淡入淡出。
- 显示 active context 已用量、有效窗口、百分比和窗口来源；不显示累计 Journal 大小。

### 触发架构

- 每次发送前统一计算 active context 占用与有效窗口。
- 超阈值则先创建压缩 turn；用户消息保存在本地待发送区，压缩成功后才发送。
- 模型切换、Journal 增长和工具输出不各自建立触发器；它们只改变下一次发送前读取的事实。
- 原始 Journal/对话时间线保留；圆环在压缩完成后显示新的 active context 占用。

### 阈值

- 256k 采用 80% 或 85% 属于 WWriting 产品取舍，当前竞品公开资料不能替产品决定。
- 1M 若采用 400K，是更保守、偏质量与成本控制的 WWriting 选择；可以引用“官方曾讨论过该实验值”，不能宣传为 Claude Code 当前默认。
- 压缩质量应通过“受保护信息类别 + 结构校验 + 耐久文件重注入”保障，不应只追求压到某个尽可能低的 token 百分比。

