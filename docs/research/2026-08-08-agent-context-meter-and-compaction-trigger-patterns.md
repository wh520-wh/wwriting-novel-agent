# Agent 上下文占用显示与自动压缩触发模式调研

- 日期：2026-08-08
- 范围：OpenAI Codex、Anthropic Claude Code
- 目的：为 WWriting 的上下文圆环、`256K/1M` 窗口语义、自动压缩触发点、模型切换和 transcript 保留规则提供一手资料
- 证据口径：官方文档、官方开源源码、官方团队公开说明；严格区分产品事实与 WWriting 推断

## 结论先行

1. **“用户发送下一条消息时，先按当前模型窗口和当前占用做预检，超阈值则先压缩，再发送”符合成熟 Agent 的实现方向。** Codex 当前源码就在正常 turn 记录新用户消息之前执行 pre-sampling compaction；它不是先监听“模型切换”这个 UI 动作再立即收费压缩。
2. **但只在下一条消息前检查还不够。** Codex 还会在一个长 turn 的模型—工具循环中检查占用，并可在需要继续采样时进行 mid-turn 自动压缩，避免单个长任务自己撑爆窗口。
3. **没有一条公开的行业规则支持“所有 1M 窗口都在 400K 自动压缩”。** Codex 的公开默认算法是 90%；1M 对应 900K。Claude Code 当前对 Sonnet 5 公开的是约 967K。400K 曾由 Claude Code 团队作为拟议默认/实验值公开讨论，但不是可证实的已上线通用默认。
4. **若原话“100 万上下文在 400 万强制压缩”按字面理解，则永远不会在硬上限前触发。** 若实际想表达“40 万 / 400K”，它等于只用 40% 窗口、预留 60%，属于非常保守的 WWriting 产品选择，不能写成竞品惯例。
5. **上下文占用应描述“当前模型可见的活动上下文”，而不是磁盘 transcript 总量。** 压缩后活动上下文变小、圆环回落；旧消息仍可留在对话时间线和 Journal 中。Codex 的活动 history 与追加式 rollout 正是这两层；Claude Code 也明确区分活动上下文与本地 session transcript，但没有把“压缩后磁盘 JSONL 必定完整保留所有原文”公开成稳定契约。
6. **官方资料支持“常驻简略读数 + 按需详情”，但不支持把某个具体 hover/click 形式冒充竞品事实。** Codex CLI 常驻显示剩余百分比并用 `/status` 查看详情；Claude Code 有 `/context`、自定义 status line 和 VS Code context indicator。Codex/Claude Code 官方文档均未公开桌面圆环的 hover/click/popover 细节。

## 一、公开可证事实

### 1. OpenAI Codex

本节源码事实基于 OpenAI 官方仓库 2026-08-08 的提交 [`dd916428`](https://github.com/openai/codex/commit/dd916428cd738001049e95d13854b80b78878065)。

#### 1.1 常驻简略读数，命令查看详情

Codex TUI footer 的公开实现直接渲染 `"{percent}% context left"`；百分比未知但 token 已知时退化为 `"{tokens} used"`。`/status` 卡片显示“剩余百分比 + 已用 token / 窗口 token”。

来源：

- [Codex TUI footer：context window line](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/tui/src/bottom_pane/footer.rs#L999-L1010)
- [Codex `/status`：Context window 详情](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/tui/src/status/card.rs#L394-L410)
- [Codex CLI slash commands：`/status`、`/statusline`、`/compact`](https://learn.chatgpt.com/docs/developer-commands?surface=cli)

Codex 对“占用百分比”的计算还预留了 12K baseline，不把这部分直接算成用户可消耗区：先从窗口和已用量两侧减去 baseline，再计算剩余百分比。这证明 UI 百分比可以是“有效可用窗口”的产品读数，而不必机械地做 `raw_tokens / advertised_window`。

来源：[Codex token usage 百分比计算](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/tui/src/token_usage.rs#L10-L51)

可证边界：公开资料证明的是 CLI 常驻文字读数和命令详情；没有公开证明 Codex 桌面端上下文圆环的 hover、click、popover 或动画规则。

#### 1.2 新 turn 在记录用户消息前预检

Codex `run_turn` 先调用 `run_pre_sampling_compact(...)`，随后才处理并记录本轮用户输入。源码注释还明确留下 TODO：未来应把即将进入的用户消息和 context reinjection 估算进去，以便在它们会把会话推过阈值时提前压缩。

来源：[Codex `run_turn`：pre-turn compaction 先于本轮用户输入](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/core/src/session/turn.rs#L151-L189)

`run_pre_sampling_compact` 会读取当前活动上下文占用；若自动压缩预算或有效窗口已经耗尽，就在正常采样步骤创建前执行 `PreTurn` 压缩。

来源：[Codex pre-sampling compaction 判定](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/core/src/session/turn.rs#L987-L1015)

这与 WWriting 提出的主路径高度一致：

```text
用户点击发送
  → 读取当前模型窗口与当前活动占用
  → 超阈值：先压缩
  → 压缩提交成功：再记录并发送用户消息
  → 未超阈值：直接发送
```

#### 1.3 Codex 还支持 mid-turn 压缩

一次 Agent turn 可能包含多轮“模型请求 → 工具调用 → 工具结果 → 再次模型请求”。Codex 在每次采样后重新收集 token 状态；如果模型或排队输入要求继续采样且已触及阈值，就执行 `MidTurn` 自动压缩，再继续本 turn。

来源：[Codex post-sampling 检查与 mid-turn compaction](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/core/src/session/turn.rs#L374-L455)

所以，“只在用户下一次发送时压缩”适合普通跨 turn 场景，但不能作为唯一保险丝。否则一个已经开始的长工具链仍可能超过硬窗口。

#### 1.4 模型降档在下一 turn 压缩，不在切换动作发生时立即压缩

Codex 当前公开实现有显式的 model-downshift 分支：当新模型窗口更小、模型 slug 已变化且当前活动上下文超过新模型限制时，在下一 turn 的 pre-sampling 阶段用之前模型执行压缩。

来源：[Codex smaller-context model 的 pre-turn compaction](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/core/src/session/turn.rs#L1051-L1142)

可证事实是“压缩发生在下一 turn 采样前”，不是用户刚点模型选择器就立即发生。WWriting 可以不保留“检测模型切换动作”的专用产品状态，而统一成“发送前按当前窗口重判”；这会得到相同的用户时机，但实现上比 Codex 的专用 downshift 分支更通用。

#### 1.5 Codex 的公开默认阈值是 90%，不是 400K

Codex `ModelInfo` 的公开契约写明：未指定 `auto_compact_token_limit` 时，从 context window 推导 90%；即使服务或配置给出更高值，也钳制到窗口的 90%。

来源：[Codex `auto_compact_token_limit()`](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/protocol/src/openai_models.rs#L414-L479)

当前官方模型元数据中，`gpt-5.4` 的默认窗口是 272K、最大可覆盖到 1M；`auto_compact_token_limit` 为空，因此由 90% 规则推导。若有效窗口显式设为 1M，阈值就是 900K，而不是 400K。

来源：[Codex `gpt-5.4` 模型元数据](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/models-manager/models.json#L448-L474)

仓库里出现的 `400_000` 是“服务端声明最大窗口为 400K 时，用户配置 1M 必须钳制到 400K”的测试样例，不是 1M 模式的自动压缩阈值。

来源：[Codex context override clamp 测试](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/models-manager/src/model_info_tests.rs#L248-L274)

#### 1.6 压缩是可观察的事件，不应静默

Codex App Server 的 `thread/compact/start` 立即返回；实际进度通过标准 turn/item 通知流出。客户端会收到 `contextCompaction` 的 `item/started` 和 `item/completed`，官方 README 直接要求客户端在压缩期间基于这些通知显示进度 UI；自动压缩也会产生同类 item。

来源：

- [Codex App Server：Trigger thread compaction](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/app-server/README.md#L808-L821)
- [Codex App Server：自动 `contextCompaction` item](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/app-server/README.md#L1576-L1587)

#### 1.7 活动 history 被替换，但原始 rollout 仍追加保留

Codex 压缩成功后把活动 history 替换成 `replacement_history`，同时把一个包含该 replacement history 的 `CompactedItem` 追加到持久化 rollout；rollout recorder 用 append 模式写 JSONL。因此，模型后续看到的是压缩后的活动上下文，但早先已经写入 rollout 的原始事件不会因为本次压缩被原地覆写或删除。

来源：

- [Codex `replace_compacted_history`：切换 live history 并追加 CompactedItem](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/core/src/session/mod.rs#L3310-L3354)
- [Codex rollout recorder：append 模式](https://github.com/openai/codex/blob/dd916428cd738001049e95d13854b80b78878065/codex-rs/rollout/src/recorder.rs#L1583-L1612)

这是“上方原始对话仍在，圆环展示新的活动上下文占用”的直接架构参考。不过保留仍受显式删除、归档/清理或未来 retention 策略影响，不能把它扩大成“Codex 永不删除任何历史”。

### 2. Anthropic Claude Code

#### 2.1 `/context` 是官方的按需详情入口

Claude Code 官方把 `/context [all]` 定义为彩色网格：可视化当前上下文使用情况、按类别拆分、显示优化建议和容量警告；默认折叠逐项内容，`/context all` 展开全部。若已超过窗口，较新版本还会显示超出量及可释放空间的命令。

来源：[Claude Code interactive mode：`/context`](https://code.claude.com/docs/en/commands)

#### 2.2 status line 提供可自定义的常驻上下文读数

Claude Code status line 从 stdin 接收 JSON，可读取：

- `context_window.context_window_size`：通常 200K，扩展模型为 1M；
- `used_percentage`、`remaining_percentage`；
- `current_usage`：input、cache creation、cache read 等当前活动上下文数据。

`used_percentage` 只按 input/cache token 计算，不包含 output。`current_usage` 在首个 API 响应前，以及 `/compact` 完成到下一次 API 调用之间可以为 `null`。status line 会在新的 assistant 消息和 `/compact` 完成后刷新。

来源：[Claude Code status line](https://code.claude.com/docs/en/statusline)

若用户通过 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 把自动压缩窗口设得小于模型完整窗口，status line 的 `used_percentage` 仍按完整模型窗口计算，所以它不再等于“距离压缩阈值还有多少”。

来源：[Claude Code environment variables](https://code.claude.com/docs/en/env-vars)

这个细节对 WWriting 很重要：圆环必须明确表示“完整活动窗口占用”还是“自动压缩预算占用”。两者不能共用同一个百分比却不给说明。

#### 2.3 VS Code 有 context indicator，但交互细节未公开

Claude Code VS Code 扩展的官方文档说明 prompt box 有 context indicator，显示已使用窗口的比例；需要时会自动 compact，也可以执行 `/compact`。

来源：[Claude Code VS Code extension](https://code.claude.com/docs/en/vs-code)

可证边界：官方没有说明该 indicator 的 hover、click、popover 或动效。CLI status line 可以通过自定义脚本输出 OSC 8 可点击链接，但那是脚本能力，不等于上下文读数自身是可点击控件。Claude Code 唯一明确文档化的内置详情入口是 `/context`。

#### 2.4 自动压缩窗口现在是明确可配置的 token 值

Claude Code 当前提供：

- `/autocompact [auto|<tokens>]`：查看或设置当前及后续会话的自动压缩窗口，并保存到用户设置；
- `--autocompact`：仅本次启动；
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`：最高优先级环境变量。

接受范围为 100K–1M。命令/flag 可用 `200000`、`500k`、`1M` 或 100–1000（按千）等形式；环境变量只接受纯整数。

来源：

- [Claude Code context window and auto-compaction](https://code.claude.com/docs/en/context-window)
- [Claude Code `/autocompact`](https://code.claude.com/docs/en/commands)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)

未配置自定义值时，官方一般表述为“在模型上下文限制处压缩”，不同模型/托管平台存在例外，并没有公开一个跨所有模型通用的默认百分比。

#### 2.5 当前 1M 的公开精确示例约为 967K，不是 400K

Claude Code 官方模型配置文档说明：Sonnet 5 在 Anthropic API 上始终使用 1M context，默认自动压缩阈值约为 967K tokens；未验证 1M 的 LLM gateway 或显式禁用 1M 时，回退到 200K 模式。

来源：[Claude Code model configuration：Sonnet 5 context window](https://code.claude.com/docs/en/model-config#sonnet-5-context-window)

另有 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 可把触发点提前到 1–100%，但不能把它推迟到产品默认百分比之后；它只适用于本来就在硬限制前压缩的会话。

来源：[Claude Code environment variables](https://code.claude.com/docs/en/env-vars)

400K 并非凭空出现：2026-04-12，Claude Code 官方仓库的团队成员在 pinned discussion 中说团队正在研究把默认改为 400K、同时允许用户配置到 1M，并建议用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000 claude` 实验。措辞是“正在研究”和实验建议，不是宣布 400K 已成为正式默认。

来源：[Claude Code issue #45756：团队关于 400K 默认候选的说明](https://github.com/anthropics/claude-code/issues/45756#issuecomment-4231739206)

因此截至 2026-08-08，严谨表述只能是：

- 400K 是 Claude Code 团队公开讨论过的 1M 会话默认候选/实验值；
- 它不是当前官方文档中的通用默认；
- 当前有明确数字的 Sonnet 5 默认约为 967K；
- 其他 1M 模型不能擅自补成 400K、900K 或某个统一百分比。

#### 2.6 Claude Code 的活动上下文会被摘要替换

`/compact` 与自动压缩使用同一类机制：总结当前对话以释放上下文。恢复自摘要时，官方更具体地描述为“summary + 最近 exchanges + 最多 5 个最近读取文件”；摘要遗漏的信息不再位于 Claude 的活动上下文中。

来源：

- [Claude Code `/compact`](https://code.claude.com/docs/en/commands)
- [Claude Code context window](https://code.claude.com/docs/en/context-window)
- [Claude Code sessions：Resume from summary](https://code.claude.com/docs/en/sessions)

压缩后 system prompt、output style 不变；项目根 `CLAUDE.md`、无 paths 规则和 auto memory 会从磁盘重新注入。paths 规则和子目录 `CLAUDE.md` 要到再次读取匹配文件时才恢复；已调用 skill body 按限额重注入。

来源：[Claude Code context window：What persists across compaction](https://code.claude.com/docs/en/context-window)

这说明“合理压缩”不是只生成一段自由文本，而是要明确哪些稳定规则重注入、哪些近期原文保留、哪些内容只存在于摘要里。

#### 2.7 本地 transcript 持续保存，但完整保留不是公开稳定契约

Claude Code 官方说明 CLI 工作时持续保存本地 transcript，默认位于 `~/.claude/projects/<project>/<session-id>.jsonl`，每行记录 message、tool use 或 metadata，默认留存 30 天；raw schema 属于内部格式。

来源：[Claude Code sessions：How sessions work](https://code.claude.com/docs/en/sessions)

但官方文档没有明确承诺：执行 `/compact` 后，所有压缩前原始消息仍必定完整保留在 JSONL。因此可证结论只能分两层：

- 活动模型上下文：肯定不再保留全文，已被摘要和近期内容替换；
- 磁盘 transcript：持续保存，但压缩前全文是否永远完整保留，不是 Anthropic 公布的稳定契约。

## 二、对照表

| 问题 | Codex 公开事实 | Claude Code 公开事实 |
| --- | --- | --- |
| 常驻简略占用 | TUI footer 可显示 `% context left` | 自定义 status line；VS Code context indicator |
| 按需详情 | `/status` 显示百分比与 used/total | `/context` 彩色网格、分类与建议 |
| hover/click/popover | 未公开桌面端细节 | 未公开 indicator 交互细节 |
| 手动压缩 | `/compact` / `thread/compact/start` | `/compact [focus instructions]` |
| 新 turn 前预检 | 明确存在，且先于记录用户消息 | 文档确认自动压缩，未公开同等源码级时序 |
| turn 内继续采样前检查 | 明确存在 mid-turn compaction | 官方资料未公开同等细节 |
| 模型切到小窗口 | 下一 turn pre-sampling 可压缩 | 活动窗口随当前模型/配置变化；精确内部时序未公开成文档契约 |
| 默认阈值 | 模型元数据未给值时为窗口 90% | 无跨模型统一百分比；Sonnet 5 1M 示例约 967K |
| 1M 在 400K 压缩 | 否；公开算法对应 900K | 400K 是团队讨论/实验候选，不是当前通用默认 |
| 压缩进度事件 | `contextCompaction` started/completed | `/context`、进度/边界已有官方能力说明，但协议细节不同 |
| 活动上下文 | 被 replacement history 替换 | 被 structured summary + 近期内容替换 |
| 原始 transcript | rollout 追加保留旧事件，压缩另加 checkpoint | session JSONL 持续保存；压缩后完整原文保留未公开为稳定保证 |

## 三、WWriting 产品推断与建议

以下是基于上述事实作出的 WWriting 设计建议，不是竞品公开事实。

### 3.1 采用“容量预检”，不采用“模型切换事件触发”

用户提出的原则合理，建议写成单一、不依赖 UI 动作的门禁：

```text
before_user_turn:
  window = resolveWindow(requestModelId)       // 256K 或 1M
  usage = activeContextUsage()
  if usage >= compactThreshold(window):
      compact(previous_active_context)
      if committed:
          enqueue_and_send(user_message)
      else:
          apply cancel/failure policy
  else:
      enqueue_and_send(user_message)
```

优点：恢复会话、重启应用、外部改配置或任何非 UI 切换路径都不会漏判。模型从 1M 切到 256K 后也无需提前写入“需要压缩”状态；用户下一次发送自然按 256K 重判。

同时补一条硬保护：一个 turn 内若工具结果或多轮采样使活动上下文逼近硬上限，应允许 mid-turn 压缩；不能等下一条用户消息。

### 3.2 圆环表示活动上下文，不表示 Journal/transcript 总量

建议语义：

- 圆环分母：本窗口当前请求模型的活动 context window（无标记 256K；识别到末尾 `[1m]`/`[1M]` 为 1M）；
- 圆环分子：下一次模型请求将携带的活动上下文估算量；
- 压缩成功：分子按新活动上下文重新计算，圆环回落；
- 上方历史和 Journal：保持原始事件，不因圆环回落而删除；
- tooltip/popover 必须用“当前上下文”或“模型可见上下文”，避免用户误以为旧消息被删除。

若未来要同时显示“距自动压缩阈值”，不要偷偷把圆环分母从完整窗口换成压缩预算。可在详情中分两行：

```text
当前上下文  198K / 256K（77%）
自动压缩点  218K（85%）
```

### 3.3 圆环交互采用通用 tooltip + 可固定 popover

官方竞品资料不足以证明一个既定交互，所以建议明确作为 WWriting 自己的设计：

- 始终显示静态圆环；运行时只做克制的透明度/描边过渡，不做持续旋转；
- hover 或键盘 focus：短延迟后淡入轻量 tooltip，展示 `已用 / 总量 / 百分比`；
- click、Enter 或 Space：把同一详情固定为 popover，允许鼠标移入；再次点击、点击外部或 ESC 关闭；
- tooltip/popover 用 120–180ms 的 opacity + 轻微 translate/scale 过渡，避免瞬间闪现；
- `prefers-reduced-motion` 下取消位移和缩放，仅保留极短淡入淡出；
- 不在默认详情中展示压缩耗时、模型、释放量等用户已经明确不需要的信息；压缩事件正文只显示“开始压缩 / 压缩进行中 / 已压缩完成 / 压缩失败 / 已取消”等状态。

### 3.4 阈值不要把 400K 写成行业既定值

若 WWriting 当前只区分 256K 和 1M，建议先选择一种可解释规则并保持一致：

| 方案 | 256K 触发 | 1M 触发 | 评价 |
| --- | ---: | ---: | --- |
| 统一 85% | 217.6K | 850K | 简单、好解释，预留 15% 给用户输入、工具结果和模型输出 |
| 统一 80% | 204.8K | 800K | 更保守，适合工具输出波动大但会更频繁压缩 |
| Codex 风格 90% | 230.4K | 900K | 利用率高，需要可靠的 mid-turn 防线和输出预留 |
| 1M 固定 400K | — | 400K | 只使用 40%，不是当前竞品通用默认；只有在实测证明长上下文质量/成本明显恶化时才合理 |

基于“尽量不丢上下文”的用户目标，1M 在 400K 就压缩与目标存在张力。更合理的首版是 80%–85%，再根据真实压缩质量、失败率、长上下文成本和模型表现调参；若要采用 400K，应把原因写成 WWriting 的质量/成本策略，而不是“Claude Code 就这样”。

### 3.5 发送前判断要计入待发送内容和输出余量

仅判断“当前已用量是否超过阈值”仍有边界漏洞：当前 84.9%，用户一次粘贴大段文本后可能直接越过 85%。建议门禁至少使用：

```text
projected_usage = current_active_context
                + estimated_pending_user_input
                + required_system_or_memory_reinjection
                + reserved_output_headroom
```

Codex 源码当前也把“估算待进入内容”列为 pre-turn compaction 的待完善项，因此 WWriting 应把它直接写入验收，而不要重复这个已知缺口。

### 3.6 “合理压缩”要定义保留层，而不只定义提示词

建议压缩产物至少分为：

1. 稳定约束：系统规则、项目指令、用户确认的产品决策；从权威存储重新注入，不完全依赖摘要模型回忆。
2. 结构化摘要：目标、已确认决策、未决问题、当前计划、关键事实、错误/恢复点。
3. 近期原文：最近若干用户/Assistant exchanges，避免刚发生的细节被摘要损伤。
4. 活动引用：最近读取的重要文件/片段或可重载引用，而不是把所有大段工具输出继续塞回窗口。
5. Journal 指针：记录本次摘要覆盖的 event seq 范围、source checkpoint、summary version，允许追溯但不默认重放全文。

这比“请总结上文”更接近 Claude Code 公布的“summary + recent exchanges + recent files”和 Codex 的 replacement-history/checkpoint 模型。

## 四、建议写入下一轮计划的验收标准

1. 圆环始终可见；无模型响应前能显示确定的窗口上限和“占用量待首个响应校准”，不能伪造精确 token。
2. 圆环显示活动模型上下文；Journal/transcript 总量不参与圆环百分比。
3. hover/focus 显示 tooltip；click/Enter/Space 固定 popover；ESC/外部点击关闭；过渡克制且支持 reduced motion。
4. 用户发送前，系统按请求模型 ID 解析出的当前窗口重判，不依赖是否发生过模型切换事件。
5. 判断计入待发送消息、必要重注入和输出余量；达到阈值时先压缩，提交成功后才发送用户消息。
6. 从 1M 切到 256K，不在切换动作发生时立即压缩；下一次发送前按 256K 重判。
7. 单个长 Agent turn 内达到硬保护线时，可 mid-turn 压缩，避免等待下一次用户发送。
8. 压缩 started/running/completed/failed/cancelled 是 Journal 和对话框中的可见事件，不静默发生。
9. 压缩成功后圆环按 replacement context 回落；旧时间线和 Journal 事件仍可查看。
10. 压缩摘要必须包含结构版本、来源 seq/checkpoint 和明确保留段；遗漏字段或校验失败不得提交。
11. 不把“1M 在 400K 压缩”写成行业事实；若采用必须记录为 WWriting 的显式产品参数与理由。
12. 用户口述的“400 万”在实现前必须按产品决定澄清为 `400K`、`4M` 或其他值；1M 窗口若阈值为 4M，应由校验直接拒绝。

## 五、证据边界摘要

| 结论 | 证据强度 | 说明 |
| --- | ---: | --- |
| Codex 新 turn 前会做自动压缩预检 | 高 | 官方源码，时序明确 |
| Codex 长 turn 中可 mid-turn 压缩 | 高 | 官方源码，时序明确 |
| Codex 默认自动压缩算法为窗口 90% | 高 | 官方协议源码及注释 |
| Codex 1M 默认在 400K 压缩 | 否 | 官方公开实现不支持；对应算法为 900K |
| Claude Code Sonnet 5 1M 默认约 967K | 高 | 当前官方模型配置文档 |
| Claude Code 400K 是当前通用默认 | 否 | 仅为团队公开讨论/实验候选 |
| Codex/Claude Code 桌面圆环使用 hover+click popover | 未公开 | 不能据现有官方资料断言 |
| Codex 压缩不覆写旧 rollout 事件 | 高 | 官方 append-only recorder 与 CompactedItem 流程 |
| Claude Code 压缩后 JSONL 永久完整保留全部旧原文 | 未公开 | 仅能证明 session transcript 持续保存 |

