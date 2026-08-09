# Agent 压缩取消与失败语义调研

- 日期：2026-08-08
- 范围：OpenAI Codex、Anthropic Claude Code；Cursor 仅在存在可靠第一方资料时纳入
- 目的：为 WWriting 的自动/手动上下文压缩补齐取消、失败、发送解锁与历史替换语义
- 资料等级：官方产品文档、官方开源源码、官方仓库 CHANGELOG；不把社区讨论当作产品事实

## 结论先行

1. **取消压缩后，不应在用户按下 ESC 的瞬间立即恢复发送。** 更稳妥的状态是 `压缩进行中 → 正在取消 → 已取消`。只有底层压缩请求确认终止、压缩前快照仍是当前有效上下文、token 占用重新计算完成后，才恢复发送。
2. **恢复发送后也不应自动发送用户在压缩期间输入或排队的内容。** Codex TUI 的可验证做法是：压缩期间提交的消息进入队列；中断完成后，队列内容恢复到输入框，但不会自动发出。用户检查后再次主动发送。
3. **“失败不覆盖旧上下文”就是事务语义：旧上下文一直是有效版本，只有新摘要完整生成并通过校验后才一次性提交替换。** 生成摘要期间产生的半截文本、错误响应或取消结果都不能写成新的有效上下文。
4. **压缩失败与用户取消必须是两种不同结果。** 取消显示“已取消”，失败显示错误和“重试”；不能像早期 Claude Code 的缺陷那样，按 ESC 后仍弹“压缩失败”。
5. **公开资料没有证明 Codex 或 Claude Code 在取消请求发出的同一瞬间就允许新请求并发进入。** 因而“立即恢复发送”不是竞品事实，而是 WWriting 自己必须定义的并发策略。
6. Cursor 官方公开资料中未找到足以证明压缩取消、失败回滚或摘要替换事务语义的材料，本报告不据此推断 Cursor 行为。

## 一、公开可证事实

### 1. OpenAI Codex

#### 1.1 压缩是独立、可观测的生命周期

Codex App Server 的 `thread/compact/start` 会立即返回，请求进度通过标准 `turn/*` 和 `item/*` 通知流出；压缩本身有 `contextCompaction` item，经历 `item/started` 和 `item/completed`。同一套 App Server 还提供 `turn/interrupt`，成功后 turn 以 `status: "interrupted"` 结束。

来源：

- [Codex App Server：Trigger thread compaction](https://developers.openai.com/codex/app-server/#trigger-thread-compaction)
- [Codex App Server：Interrupt a turn](https://developers.openai.com/codex/app-server/#interrupt-a-turn)
- [Codex App Server：Turn events](https://developers.openai.com/codex/app-server/#turn-events)

可证边界：官方文档证明了“压缩是 turn/item 生命周期的一部分”和“进行中的 turn 可以被 interrupt”。文档没有单独写出“ESC 必然映射到压缩 turn 的 interrupt”，也没有规定取消确认前输入框是否可用。

#### 1.2 Codex TUI 在压缩期间排队用户消息，而不是并发发送

官方 TUI 测试明确模拟了 `/compact` 正在运行时提交一条用户消息。系统尝试 steer 后收到 `cannot steer a compact turn`，并把消息保留在队列中。这说明压缩 turn 被视为不可 steer 的独占工作，用户输入不能直接并发进入该 turn。

来源：

- [Codex TUI `compact_queues_user_messages_snapshot` 测试](https://github.com/openai/codex/blob/2e3a1702c2e7adea5f2ae9ea2799c625024b4fda/codex-rs/tui/src/chatwidget/tests/slash_commands.rs#L2962-L2991)

#### 1.3 中断完成后，队列内容回到输入框，但不会自动发送

Codex TUI 的官方测试模拟 ESC 触发的 turn interruption：中断通知到达后，排队消息按顺序恢复到 composer，队列被清空，并断言没有新的 outbound operation。这是目前最直接的第一方交互证据。

来源：

- [Codex TUI `interrupt_restores_queued_messages_into_composer` 测试](https://github.com/openai/codex/blob/2e3a1702c2e7adea5f2ae9ea2799c625024b4fda/codex-rs/tui/src/chatwidget/tests/composer_submission.rs#L1752-L1781)
- [Codex TUI ESC interrupt 测试](https://github.com/openai/codex/blob/2e3a1702c2e7adea5f2ae9ea2799c625024b4fda/codex-rs/tui/src/chatwidget/tests/composer_submission.rs#L1143-L1176)

可证边界：这证明“中断确认后恢复编辑、但不自动提交”。它不是所有 Codex 客户端必须遵循的公开协议保证，但可作为 WWriting 的直接产品参考。

#### 1.4 Codex 本地压缩具有“成功后提交”的事务边界

本地压缩源码先克隆现有 history，在克隆上附加压缩提示并请求模型。遇到 `Interrupted`、`TurnAborted`、预算耗尽或重试耗尽时直接返回错误。只有模型请求成功完成、摘要文本构造完毕后，才调用 `replace_compacted_history(...)` 替换有效历史并发出 `item/completed`。

来源：

- [Codex 本地压缩：克隆历史、错误提前返回、成功后替换](https://github.com/openai/codex/blob/2e3a1702c2e7adea5f2ae9ea2799c625024b4fda/codex-rs/core/src/compact.rs#L242-L381)

因此，在这些失败/取消路径上，新摘要没有成为有效上下文；旧 history 仍是 live history。这里的“事务”是根据官方源码控制流得出的实现事实，而不是官方文档使用的产品术语。

#### 1.5 Codex 远程压缩也把“安装新历史”作为成功后的语义边界

远程压缩先完成 `run_remote_compact_attempt(...)`，取得 `new_history` 后才处理并调用 `replace_compacted_history(...)`。源码注释直接把 install 称为“compact endpoint 输出成为 live history 的语义边界”。失败测试还验证：预回合自动压缩失败后，不会继续发起压缩后的模型请求，当前 turn 停止并报错。

来源：

- [Codex 远程压缩：成功后安装新历史](https://github.com/openai/codex/blob/2e3a1702c2e7adea5f2ae9ea2799c625024b4fda/codex-rs/core/src/compact_remote.rs#L201-L299)
- [Codex 远程压缩失败测试：失败后不执行 post-compaction 请求](https://github.com/openai/codex/blob/2e3a1702c2e7adea5f2ae9ea2799c625024b4fda/codex-rs/core/tests/suite/compact_remote.rs#L3919-L4005)

### 2. Anthropic Claude Code

Claude Code 的完整当前文档页面在本次环境中无法直接读取，因此以下只采用 Anthropic 官方 GitHub 仓库的第一方 CHANGELOG，不扩展到社区 issue。

#### 2.1 ESC 可以发生在 conversation compaction 期间，取消不应显示为失败

Claude Code 2.1.133 修复了“在 conversation compaction 期间按 ESC，会错误显示 `Error compacting conversation` 通知”的问题。这证明：

- ESC 是压缩期间的有效用户操作；
- 产品预期应把用户取消和压缩失败分开；
- 取消不能落成红色失败事件。

来源：

- [Claude Code CHANGELOG 2.1.133](https://github.com/anthropics/claude-code/blob/2bb60696142b493eafaeacfe00eac51d16c50c4f/CHANGELOG.md#L1867-L1870)

#### 2.2 中断完成后，队列应继续流转

同一版本还修复了 Remote Control 的 stop/interrupt 没有像本地 ESC 一样完整取消 CLI session，导致 queued messages 在中断后永远无法前进的问题。可证事实是：本地 ESC 的完整取消路径是参考行为，中断完成后排队消息不应永久堵塞。

来源：

- [Claude Code CHANGELOG 2.1.133：remote interrupt 与 local Esc 对齐](https://github.com/anthropics/claude-code/blob/2bb60696142b493eafaeacfe00eac51d16c50c4f/CHANGELOG.md#L1867-L1870)

这里不能进一步证明 Claude Code 会“自动发送”队列内容，还是只恢复为待发送状态；CHANGELOG 没有公开这层细节。

#### 2.3 压缩进度、边界和失败应可见

Claude Code 的第一方变更记录显示：远程客户端后来补上了 compaction progress 和 post-compaction boundary，避免 silent pause；`/context` 会显示超窗警告，失败的 `/compact` 会显示为错误；自动压缩连续失败设有 3 次熔断，避免无限重试。

来源：

- [Claude Code 2.1.224：显示压缩进度和压缩后边界](https://github.com/anthropics/claude-code/blob/2bb60696142b493eafaeacfe00eac51d16c50c4f/CHANGELOG.md#L43-L47)
- [Claude Code 2.1.216：失败的 `/compact` 显示为错误](https://github.com/anthropics/claude-code/blob/2bb60696142b493eafaeacfe00eac51d16c50c4f/CHANGELOG.md#L272-L277)
- [Claude Code 2.1.76：自动压缩连续失败三次后熔断](https://github.com/anthropics/claude-code/blob/2bb60696142b493eafaeacfe00eac51d16c50c4f/CHANGELOG.md#L3114-L3119)
- [Claude Code 2.1.89：连续压缩后立即再次填满时停止并给出可操作错误](https://github.com/anthropics/claude-code/blob/2bb60696142b493eafaeacfe00eac51d16c50c4f/CHANGELOG.md#L2728-L2733)

#### 2.4 Claude Code 未公开的细节

在本轮可验证第一方资料中，没有找到以下公开保证：

- 取消压缩后旧上下文以何种内存/持久化事务机制恢复；
- 摘要是否在校验后原子替换；
- 取消确认前发送按钮是否禁用；
- 压缩失败后是立即允许普通发送，还是必须先重试/新建会话；
- 排队消息在压缩取消后是自动发送还是只恢复到输入框。

这些均不能写成“Claude Code 就是这样做的”。

### 3. Cursor

本轮在 Cursor 的公开官方资料和官方 GitHub 资产中，没有找到足以验证以下行为的第一方材料：压缩期间 ESC/interrupt、取消后的发送解锁、失败保留旧上下文、摘要替换的事务边界。因此本报告不把 Cursor 纳入行为结论，也不采用论坛或第三方文章补齐空白。

## 二、“失败不覆盖旧上下文”到底是什么意思

它不是“失败后把已经被覆盖的旧上下文再恢复回来”，而是更严格的设计：**在压缩成功提交之前，根本不允许覆盖发生。**

建议把一次压缩理解成数据库事务：

1. 读取当前有效上下文，记录 `source_checkpoint_id`、事件序号范围和 token 统计。
2. 从该快照生成候选摘要；旧上下文继续是唯一有效版本。
3. 对候选摘要做完整性校验，例如：响应完整结束、非空、结构版本正确、关键恢复字段存在、来源 checkpoint 没有变化。
4. 校验通过后，一次性写入新的 compaction checkpoint，并把 active context 指针切到新版本。
5. 任一步失败或取消，都丢弃候选摘要，不移动 active 指针，不删除旧事件，不改变压缩前上下文。

所以它具体排除以下危险行为：

- 模型只输出半截摘要时，就边流式接收边覆盖旧 history；
- 先清空/裁剪旧上下文，再去请求摘要；
- 压缩请求失败后留下一个空摘要或不完整摘要，却把占用量显示为已经下降；
- 用户 ESC 后把已生成的半截摘要当作“勉强成功”；
- 压缩失败事件写入后，恢复时间线却无法定位压缩前的有效 checkpoint。

Journal 仍应追加记录 `compaction.started`、`compaction.cancel_requested`、`compaction.cancelled` 或 `compaction.failed`，但这些事件不等于 active context 已被替换。只有 `compaction.committed` 才能改变 active context 指针。

## 三、WWriting 产品推断与建议

以下是基于上述事实作出的 WWriting 决策建议，不冒充竞品公开事实。

### 3.1 建议的取消状态机

```text
compressing
  ├─ ESC → cancel_requested / cancelling
  │           ├─ 底层确认中止 + 快照校验通过 → cancelled → idle
  │           └─ 无法确认中止或回滚校验失败 → cancel_failed → blocked
  ├─ 摘要成功并校验通过 → committing → completed → idle
  └─ 请求/校验失败 → failed
```

交互规则：

- `compressing` 和 `cancelling` 期间，发送按钮保持禁用；输入框可继续编辑，提交动作进入本地待发送区，不触发模型调用。
- 用户按 ESC 后，立即把文案从“压缩进行中”顶替成“正在取消”，避免用户误以为已经取消完成。
- 收到取消确认并验证 active context 仍指向压缩前 checkpoint 后，显示“已取消”，恢复发送。
- 恢复发送时，不自动发出压缩期间的草稿或队列消息；把它们放回输入框，等待用户再次确认发送。这与 Codex TUI 的可验证交互最接近。
- 如果取消确认超时，不能假装成功；保留“正在取消”或进入“取消失败”，提供重试取消/重新载入会话，不允许产生第二个并发 turn。

### 3.2 建议的失败状态

压缩失败后是否禁用普通发送，要区分两类：

1. **安全失败**：底层请求已经结束，active context 明确仍是旧 checkpoint，旧上下文仍未超过供应商硬限制。显示“压缩失败 · 重试”，普通发送可以恢复，但下一次发送前若仍高于自动压缩阈值，应再次先压缩，不能绕过容量门禁。
2. **阻断失败**：无法证明旧 checkpoint 仍有效、旧上下文已接近/超过硬上限、取消状态不确定，或提交阶段持久化失败。发送保持禁用，只允许重试压缩、恢复 checkpoint、导出日志或新建窗口。

这比“一旦失败就永远禁用发送”更可用，也比“失败后无条件恢复发送”更安全。

### 3.3 对当前需求的直接回答

- “取消压缩恢复压缩前上下文，但不要立即恢复发送”这个判断是对的，但应准确写成：**不要在 ESC 按下瞬间恢复；等取消完成并验证旧 checkpoint 后恢复。**
- 恢复后不要自动续发队列消息；只恢复输入能力，让用户主动再次发送。
- “失败不覆盖旧上下文”应改写成可验收的契约：**压缩采用候选摘要 + 原子提交；在 `compaction.committed` 前，active context 始终指向压缩前 checkpoint；失败和取消不得移动该指针。**

## 四、建议写入下一轮计划的验收标准

1. 压缩中按 ESC，100 ms 内 UI 进入“正在取消”，发送仍禁用。
2. 只有收到取消完成信号并完成 checkpoint 校验后，状态才变为“已取消”，发送恢复。
3. 压缩期间输入的文字不丢失；取消后回到输入框，不自动发送。
4. 取消事件不得显示为“压缩失败”，失败事件不得显示为“已取消”。
5. 压缩模型流式返回半截摘要后断流，active context checkpoint 不变。
6. 压缩请求返回错误、结构校验失败、持久化失败、用户取消时，均不得写入 `compaction.committed`。
7. 只有候选摘要完整、结构校验通过且持久化成功后，才原子切换 active context，并更新圆环占用量。
8. 安全失败允许恢复普通发送；但若仍高于自动压缩阈值，下一 turn 必须先重新压缩。
9. 阻断失败保持发送禁用，并明确给出“重试压缩/恢复 checkpoint/新建窗口”操作。
10. 自动压缩连续失败应有有限重试和熔断，不能无限调用模型；具体次数属于 WWriting 配置，Claude Code 的公开参考值为连续 3 次。

## 五、证据强度摘要

| 结论 | 证据强度 | 说明 |
|---|---:|---|
| Codex 压缩可被通用 turn interrupt 中断 | 高 | 官方 App Server 文档 |
| Codex 压缩期间消息排队、不并发 steer | 高 | 官方源码测试 |
| Codex 中断后队列回输入框且不自动发送 | 高 | 官方源码测试；是 TUI 实现事实 |
| Codex 失败/取消前不替换有效 history | 高 | 官方源码控制流与失败测试 |
| Claude Code 压缩期间 ESC 是有效取消操作 | 中高 | 官方 CHANGELOG 明确描述相关缺陷修复 |
| Claude Code 取消不应显示为压缩失败 | 中高 | 官方 CHANGELOG 明确描述 |
| Claude Code 失败时一定保留旧上下文 | 未公开 | 无可验证公开保证 |
| Claude Code 取消后是否自动发送队列 | 未公开 | CHANGELOG 只证明队列不应永久堵塞 |
| Cursor 的对应语义 | 未公开 | 未找到可靠第一方材料 |

