# ADR-0001: fact-check 从自动修复改为反馈喂回，建立反思闭环

- **状态**: Accepted
- **日期**: 2026-07-31
- **关联提交**: 评审 54e6a06 后的改造

## 背景

WWriting 写作 agent 引擎的 agent 三支柱中，**Feedback loop（反馈闭环）是断的**：

- `runFactCheck` 在 `reviewChapter` 里发现正文与设定矛盾后，由**代码自己**用 `indexOf + replace` 改正文文件，不让模型参与修改。
- 由此产生两个真 bug：
  1. **只改 `conflicts[0]`**，其余冲突记事件后丢弃，模型完全不知道还有其他矛盾。
  2. **引文 >200 字直接跳过**自动修复（`draft_quote_truncated`），因为 `indexOf + replace` 在长引文上会乱码。
- `skill check` 失败也直接打回 `needs_revision`，评判理由没有作为 feedback 喂给写作模型，模型被打回却不知道往哪个方向改。

横向对比成熟 agent 工具（Claude Code / Aider / Cursor），它们都有完整的"感知→决策→行动→**反思**"循环：改完跑验证、失败把结果喂回、再改。WWriting 缺"反思"这一环，本质是"带工具的流水线"，不是真 agent。

## 决策

把 fact-check 从"代码自动修复"改为"冲突喂回模型 + review↔revise 反思闭环"。具体七项子决策：

1. **范围**：fact-check + skill check 的失败结果都接进 `agent_loop_feedback` 通道。skill check 目前虽是空壳（仅 `suspense-ending` 一个本地检查器），但通道留好后，未来加检查器自动生效。
2. **流程**：走现有状态机。fact-check 发现冲突 → 进 `needs_revision` → `reviseChapter` 的 `runWritingAgentLoop` 接收 conflicts 作为 feedback → 模型用 `edit_chapter` 改 → 回 `reviewing` 再跑 fact-check 验证。天然形成 review↔revise 反思闭环。砍掉中间的 `indexOf + replace` 自动修复分支。
3. **feedback 内容**：每个冲突传 `{引文, 冲突对象, 来源章节, 建议方向, 严重度}`。`suggestion` 作为**方向参考**，**不直接当 `replace` 用**（fact-check 模型的建议可能不精确，尤其引文截断时）。写作模型是作者，自己决定怎么改才通顺。`replace_with` 可选字段不直接套用。
4. **终止条件**：进展检测 + 硬上限双保险。每轮记冲突数，**减少就继续、停滞/增加就提前终止**，硬上限 3 轮。对标 Aider：跑测试→失败喂回→再跑，看进展而非纯数轮次。
5. **软降级**：达到上限仍有冲突 → block 本章（项目 paused），事件 + 主动消息 + failure card 通知用户"第 N 章有未解决设定矛盾，请人工核对"。不静默放过、不硬改。对标 Claude Code：跑不过就停下来问用户。
6. **差异化 feedback**：第二轮起，feedback 附带"上次怎么改的 + 仍冲突"，让模型换思路而非重复。对标 Aider：把上次失败的 diff 和报错一起喂回。
7. **测试**：TDD 红绿切片先行。mock 模型第一次产出矛盾正文、第二次用 `edit_chapter` 改对。

## 后果

**正面**
- 修掉"只改第一个""长引文跳过"两个真 bug（模型改时不存在截断乱码问题，它能看上下文）。
- agent 三支柱的 Feedback loop 第一次闭环，WWriting 从"带工具的流水线"向"真 agent"迈出关键一步。
- `agent_loop_feedback` 通道验证可用后，未来 skill check 检查器接入是几行代码的事。

**负面 / 风险**
- token 成本上升：每轮 fact-check 验证 + feedback 喂回都是额外调用。用"feedback 只传摘要、模型按需 `read_chapter`"缓解。
- 循环不收敛风险：用进展检测 + 硬上限 3 轮 + 软降级兜底。
- 软降级会 block 本章，需要用户介入。这是有意为之（不静默放过），但意味着用户可能看到更多"需人工核对"的暂停。

## 替代方案（已否决）

- **引入 sub-agent（专门 critic 角色）**：否决。UAT 阶段反思闭环尚未跑通就上 sub-agent，要解决角色间通信、上下文同步、成本翻倍，是叠加复杂度。留到架构成熟后。
- **内嵌子循环（写完一段立即 fact-check）**：推迟。比"写完整章再 review"更及时，但改动更大。作为本 ADR 落地后的下一步，不在本次范围。
- **把 fact-check conflicts 并入 `quality_gate_failures` 字段**：否决。`quality_gate_failures` 已一词多义（字数、标题、skill check），再装 fact-check 会让模型分不清"结构问题"还是"事实矛盾"，改法不同。feedback 保持概念清晰。
- **保留自动修复作为兜底**：否决。自动修复的根本缺陷（只改第一个、长引文跳过、改完不通顺）无法在不引入复杂逻辑的前提下修复，且与"把修改权还给模型"的核心原则冲突。

## 实施状态

已落地（测试 47/47 绿）：

- **切片 1**：`runFactCheck` 砍掉自动 `indexOf+replace` 修复分支，只返回 conflicts。修掉"只改第一个""长引文跳过"两个 bug。
- **切片 2**：`reviewChapter` 任何 fact-check 冲突都进 `needs_revision`（`applyFactCheckHardFail` 重命名为 `applyFactCheckConflicts`，不再区分 hard/soft）。
- **切片 3**：端到端反思闭环跑通--fact-check 发现冲突 -> needs_revision -> 模型用 `edit_chapter` 改 -> 回 reviewing -> fact-check 无冲突 -> 完成。
- **决策 4/5**：硬上限 3 轮（`max_fact_check_rounds_per_chapter`）+ 软降级 `blockFactCheckUnresolved`（block 本章 + 主动消息 + failure card，交用户人工核对）。
- **决策 6（差异化 feedback）**：第二轮起冲突数未减少时 feedback 附带 `progress_hint`（"上次报 X 个，这次 Y 个--冲突未减少，请换一种改法"），让模型换思路而非重复。冲突数减少（模型在收敛）时不提示。

未实现（后续优化）：

- **进展检测**：决策 4 的"冲突数减少才继续、停滞提前终止"未做成硬逻辑。当前靠硬上限 3 轮 + 决策 6 的 progress_hint 软引导，但不强制提前终止。后续可加：冲突数停滞 N 轮 -> 提前软降级。

## 已知限制

- **revise 退出机制**：`runWritingAgentLoop` 退出条件是 `append_chapter_segment` 或 >=50 字正文；`edit_chapter` 属情况 D 执行后继续循环。模型改完矛盾后需 append 收尾退出（测试中如此模拟）。此限制可由"内嵌子循环"解决，留作下一步。
- **软降级范围**：`blockFactCheckUnresolved` 设 `project_status: blocked`，是项目级 block，非单章级。当前架构无"block 单章"机制。用户介入（改草稿或设定）后可恢复项目。

## 不在本次范围

- 矛盾一（状态机流水线）：UAT 阶段不动地基。
- 矛盾二（字数硬门禁）：下一阶段软化。
- 矛盾四（禁用词表）：低优先级。
- 横向对比发现的 B/C/D/E（planning agent 化、memory 检索化、终止条件模型自主、工具粒度）：后续阶段。
