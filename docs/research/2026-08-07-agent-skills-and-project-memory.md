# Agent 技能、项目记忆与知识恢复

- 调研日期：2026-08-07
- 调研对象：OpenAI Codex、Anthropic Claude Code、Cursor
- 来源原则：官方产品文档、官方源码；Cursor 会话路径仅引用第一方支持说明
- 研究问题：系统技能如何管理；技能如何发现和调用；项目知识如何持久化；新对话、恢复、压缩、模型切换后怎样重新获得知识

## 结论先行

三类产品把“可重复的方法”和“项目长期事实”分成了不同层：技能负责工作流，`AGENTS.md`、`CLAUDE.md`、Rules 或 memory 负责持续上下文，会话 transcript 负责恢复一段具体对话。它们并不把 transcript 当作唯一项目记忆，也不要求项目先具备某个 Agent 文件才能聊天。

对于内置技能，公开且稳定的控制面通常是查看、调用、禁用，或创建自定义版本；“直接修改内置文件”不是三者共同支持的产品契约。Codex 的系统技能会由内置版本刷新，Claude Code 明确支持同名自定义技能覆盖 bundled skill，Cursor 只说明 built-in skills 由 Cursor 管理，没有公布编辑、删除或同名覆盖契约。

对 WWriting 最重要的推断是：

1. 每个工作区应在项目根目录维护一份 `WWRITING.md`，但它不是聊天门槛；缺失或损坏不能阻止第一条消息。
2. 三个内置写作风格技能可以查看，但不能删除、覆盖、直接编辑或通过项目开关停用；技能存在不等于当前激活。
3. 不建立全局默认、工作区默认和当前对话覆盖三层设置。模型根据用户自然语言和小说上下文选择风格，并把稳定选择写入项目长期文件。
4. 写作风格只影响小说正文，不改变 Agent 与用户讨论任务时的聊天语气。
5. 新对话、压缩、换模型和 Run 重试后，项目知识都应从 `WWRITING.md` 及其引用的权威创作文件重新装载，不能依赖某个模型的隐含状态。

以上四点是基于竞品事实做出的 **WWriting 产品推断**，不是竞品已经统一采用的实现标准。

## 事实对照

| 产品 | 内置/系统技能 | 自定义与覆盖 | 自动与显式调用 | 长期项目知识 | 自动记忆 |
| --- | --- | --- | --- | --- | --- |
| OpenAI Codex | 系统技能随 Codex 捆绑；本地实现安装到 `CODEX_HOME/skills/.system`，升级安装会先清理旧目录再写入嵌入版本 | repo、user、admin skill 可新增；同名不合并，选择器可能同时显示；可按路径禁用，但没有同名覆盖系统技能的公开语义 | description 匹配时隐式调用；CLI/IDE 通过 `/skills` 或 `$skill-name` 显式调用；先加载名称、描述、路径，再按需读正文 | `AGENTS.md` 或提交到项目的文档 | 本地 memories 默认关闭；Codex 从合格历史对话后台生成，位于 `~/.codex/memories/` |
| Claude Code | bundled skills/commands 可查看和调用；可整体禁用或按技能设置调用策略；没有直接编辑 bundled 内容的官方入口 | personal、project、plugin skills；enterprise > personal > project；同名自定义 skill 可覆盖 bundled skill | description 匹配可自动调用；`/skill-name` 显式调用；可设为仅用户调用；先列 name/description，再加载正文 | `CLAUDE.md`、`.claude/rules/*.md` | Claude 按 repository 自动维护 `~/.claude/projects/<project>/memory/MEMORY.md` 及 topic files |
| Cursor | built-in skills “由 Cursor 管理”，与用户技能并列显示 | 项目级和用户级 skill 均是可编辑文件；官方没有公布 built-in 的删除、编辑或同名覆盖契约 | Agent 根据上下文自动选择；`/skill-name` 显式调用；`disable-model-invocation: true` 可改为仅显式调用；资源渐进加载 | `.cursor/rules/*.mdc`、`AGENTS.md`、User/Team Rules | 官方 Rules 文档明确说模型本身不会跨 completion 保留记忆；本次未发现等价于 Claude Auto Memory 的公开项目 memory 契约 |

## OpenAI Codex：可证事实

### 技能发现与调用

Codex 的技能采用渐进披露：启动时只把技能的 `name`、`description` 和路径放入上下文，选中后才读取完整 `SKILL.md`，references 和 scripts 继续按需读取。技能既可以由任务与 description 匹配而自动调用，也可以在 CLI/IDE 中通过 `/skills` 或 `$skill-name` 显式调用。

本地技能的公开作用域包括 repo `.agents/skills`、用户 `$HOME/.agents/skills`、管理员 `/etc/codex/skills` 和 OpenAI bundled system skills。两个技能同名时不会合并，可能同时出现在选择器中。因此 Codex 没有“项目同名技能自动替换系统技能”的公开保证。

用户可以用 `[[skills.config]]` 按 `SKILL.md` 路径设置 `enabled = false`，无需删除文件。

来源：

- [OpenAI：Build skills](https://learn.chatgpt.com/docs/build-skills)

### 系统技能的可编辑边界

Codex 官方源码把系统技能安装到 `CODEX_HOME/skills/.system`。安装内置技能时，代码会先移除现有系统技能目录，再从编译进产品的资源写入。因此这些文件在本地实现上可以被检查，但直接改写或删除不是稳定扩展方式，后续刷新可能恢复内置版本。

这项结论需要分两层理解：

- **竞品事实**：源码确实清理并重写 `.system`；官方配置支持按路径禁用 skill。
- **产品推断**：WWriting 不应把“修改安装目录里的内置技能文件”设计成用户定制入口。

来源：

- [OpenAI Codex 源码：系统技能安装与刷新](https://github.com/openai/codex/blob/4ee41929eaf4fc1e5662c9b4befd05230688ca62/codex-rs/skills/src/lib.rs#L63-L93)
- [OpenAI：Build skills，Enable or disable local Codex skills](https://learn.chatgpt.com/docs/build-skills#enable-or-disable-local-codex-skills)

### 项目规则与自动记忆

Codex 把必须稳定生效的项目指导放在 repo root 或嵌套目录中的 `AGENTS.md`，把跨对话的辅助回忆放在 local memories。官方明确要求：必须遵守的团队规则应进入 `AGENTS.md` 或提交到仓库的文档，memory 只是 recall layer，不能作为唯一真相来源。

Local memories 默认关闭。启用后，Codex 从合格的历史聊天中后台提取内容、对生成字段做 secret redaction，并把 summaries、durable entries、recent inputs 和 supporting evidence 存到 `~/.codex/memories/`。官方把这些文件定义为 generated state：可以检查，但不应把手工编辑作为主要控制面。`memories.use_memories` 控制未来 session 是否注入已有 memories。

来源：

- [OpenAI：AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [OpenAI：Memories](https://learn.chatgpt.com/docs/customization/memories)

### 新对话、恢复、压缩和模型

- 新对话：repo `AGENTS.md`/项目文档是耐久来源；启用 local memories 时，已有 memory 可进入未来 session。
- 恢复：`/resume` 恢复保存的 chat；项目文件仍从当前磁盘状态读取。
- 压缩：`/compact` 用摘要替换较早上下文，Codex 也会自动压缩。当前官方 manual 没有像 Claude Code 那样公开逐层“压缩后重注入矩阵”。
- 模型切换：本次未找到足够精确的公开恢复协议，不能声称某个模型内部状态会被保留。可依赖的耐久层仍是 transcript、磁盘上的 `AGENTS.md`/项目文档和 memory files。

最后两项中“官方未公开细节”本身是调研边界，不应由 WWriting 用猜测补齐。

来源：

- [OpenAI：Slash commands in Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [OpenAI：Projects and chats](https://learn.chatgpt.com/docs/projects)

## Anthropic Claude Code：可证事实

### 内置技能、覆盖与调用策略

Claude Code 区分固定逻辑的 built-in commands 和以提示词工作流实现的 bundled skills。官方提供两类管理入口：`disableBundledSkills` 可整体禁用 bundled skills（`/doctor` 例外），`skillOverrides` 可按技能设为 `on`、`name-only`、`user-invocable-only` 或 `off`。

自定义 skills 可以放在 `~/.claude/skills/<name>/SKILL.md`、项目 `.claude/skills/<name>/SKILL.md` 或插件中。优先级为 enterprise > personal > project；这些层级还可以用同名 skill 覆盖 bundled skill。Claude Code 会监听 skill 文件的新增、修改和删除，使变更在当前 session 生效。

自动调用依赖 description；`/skill-name` 是显式调用。`disable-model-invocation: true` 禁止模型自动调用但保留用户调用。上下文开始时只列 name/description，真正调用后才加载 skill body。

来源：

- [Anthropic：Extend Claude with skills](https://code.claude.com/docs/en/skills)

### 项目规则与 Auto Memory

人工维护的耐久项目指导放在 `CLAUDE.md`、`.claude/CLAUDE.md` 或 `.claude/rules/*.md`。Auto memory 与这些规则、session transcript 是不同层：Claude 为每个 repository 在 `~/.claude/projects/<project>/memory/` 维护 `MEMORY.md` 和 topic files，启动时把 `MEMORY.md` 前 200 行或 25 KB 放入上下文，其余 topic files 按需读取。

会话 transcript 位于 `~/.claude/projects/<project>/<session>.jsonl`，保存完整消息、tool calls 和 tool results。它用于恢复某次会话，不等于经过整理的项目长期记忆。

来源：

- [Anthropic：How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Anthropic：Explore the .claude directory](https://code.claude.com/docs/en/claude-directory#application-data)

### 压缩后的知识恢复

Claude Code 对压缩后的重注入公开得最具体：

- system prompt 与 output style 不变；
- project-root `CLAUDE.md` 和无路径规则从磁盘重新注入；
- Auto memory 从磁盘重新注入；
- path-scoped rules 与 nested `CLAUDE.md` 要等再次读取匹配文件后重载；
- 已调用的 skill bodies 按预算重新注入，单个最多 5,000 tokens、合计 25,000 tokens，超出时先移除最旧项。

因此，“压缩摘要”不是项目知识的唯一恢复来源，磁盘规则和 Auto memory 仍是独立耐久层。

来源：

- [Anthropic：What survives compaction](https://code.claude.com/docs/en/context-window#what-survives-compaction)

### 恢复与模型切换

恢复 session 时，Claude Code 默认恢复完整 conversation history，包括 tool calls/results，并继续使用原 model；已退役、不在 allowlist 或启动参数显式覆盖时除外。标准 settings 文件会在启动时重新读取。

对于超过 100,000 tokens 且闲置较久的 session，用户可选择 Resume from summary。此时 Claude Code 用 summary、最近 exchanges 和最多五个最近读取的文件替代完整历史；摘要遗漏内容将不再留在模型上下文中。

在 session 内使用 `/model` 会立即切换模型。若已经有历史输出，新模型会重新读取完整 history；这再次说明稳定项目知识不应绑定在某个模型的内部状态上。

来源：

- [Anthropic：Manage sessions](https://code.claude.com/docs/en/sessions)
- [Anthropic：Model configuration](https://code.claude.com/docs/en/model-config)

### Output style 不等于小说文笔风格

Claude Code 的 output style 会直接修改主对话 system prompt，影响 Claude 每次怎样响应；官方例子是 Explanatory、Learning 和自定义交流格式。它可以让 Claude 扮演 writing assistant，但默认语义仍是整个主对话的输出风格。

因此它只能证明“把风格指令注入 system prompt”是可行机制，不能证明 WWriting 应让小说文笔风格影响所有聊天回复。对于 WWriting，用户所说的风格是 **小说正文的文笔**，不是 Agent 解释计划、询问澄清或报告工具结果时的语气，这两者必须在产品语义上分离。

来源：

- [Anthropic：Adapt Claude Code to your workflow with output styles](https://code.claude.com/docs/en/output-styles)

## Cursor：可证事实

### 技能目录、自动调用和查看

Cursor 自动从以下位置发现 skills：

- 项目级 `.agents/skills/`、`.cursor/skills/`
- 用户级 `~/.agents/skills/`、`~/.cursor/skills/`
- 兼容目录 `.claude/skills/`、`.codex/skills/` 及对应用户级目录

Agent 根据上下文和 skill description 判断是否调用，也可以通过 `/skill-name` 显式调用。`disable-model-invocation: true` 会把 skill 变成仅显式调用。官方还建议把详细材料放进 references，使资源只在需要时加载。

用户可在 sidebar 的 Customize > Skills 查看已发现的项目和插件 skills。Cursor 2.4 的 `/migrate-to-skills` 会把动态 rules 及 user/workspace slash commands 转换到 `.cursor/skills/`；原 slash commands 会带 `disable-model-invocation: true`，保留显式调用语义。

来源：

- [Cursor：Skills](https://cursor.com/docs/skills)

### 内置技能管理边界

Cursor 官方只说明 built-in skills “managed by Cursor”，会与用户添加的 skills 并列显示，其中部分可以自动调用，全部可通过 `/` 搜索调用。本次没有在官方 Skills 文档中找到以下稳定契约：

- 删除单个 built-in skill；
- 直接编辑 built-in skill 内容；
- 用同名项目/用户 skill 覆盖 built-in skill；
- 独立禁用某个 built-in skill。

因此这些能力应标为 **未公开**，不能根据自定义 skills 是磁盘文件，就推断 built-in skills 也可编辑或覆盖。

来源：

- [Cursor：Skills，Built-in Cursor skills](https://cursor.com/docs/skills#built-in-cursor-skills)

### Rules 是持久提示层，不是自动记忆

Cursor 官方明确说，大语言模型不会在 completions 之间自行保留记忆，Rules 在 prompt 层提供持续、可复用上下文。Project Rules 放在 `.cursor/rules/*.mdc`，可 Always Apply、按 relevance、按文件 glob 或通过 `@` 手动应用；简单项目也可使用 root/子目录 `AGENTS.md`。User Rules 在设置中跨项目生效，Team Rules 由团队管理。

本次未发现 Cursor 官方文档承诺一个由 Agent 持续维护、按项目自动注入、等价于 Claude Auto Memory 的文件。可证能力是 rules、skills、保存的 chat transcript/checkpoint；“Cursor 没有任何记忆能力”则超出了证据，应避免绝对表述。

来源：

- [Cursor：Rules](https://cursor.com/docs/rules)

### 新对话、恢复、压缩和模型

项目 skills 与 rules 都来自磁盘，可在新的 Agent 上下文中重新发现。Cursor 当前会把 Agent transcripts 与 workspace 会话索引放在应用私有存储中，但路径是第一方支持披露的当前实现细节，不是稳定 API。

本次官方文档没有给出与 Claude Code 同等精度的以下协议：压缩后哪些 rule/skill body 会重新注入、切换模型时怎样重放上下文、恢复聊天时各层状态的优先顺序。因此 WWriting 不能把未公开行为当作设计依据。

来源：

- [Cursor：Agent overview](https://cursor.com/docs/agent/overview)
- [Cursor 第一方支持：transcripts 与 sidebar workspace storage](https://forum.cursor.com/t/agents-sidebar-empty-222-transcripts-still-on-disk-windows/162757/16)

## 知识恢复矩阵

下表只列公开可证行为；“未公开”不等于产品一定不支持。

| 场景 | OpenAI Codex | Claude Code | Cursor |
| --- | --- | --- | --- |
| 新对话 | 重读适用 `AGENTS.md`/项目文档；启用 memories 时可注入已有 memory | 重读适用 `CLAUDE.md`/rules，并注入 repo Auto memory | 从项目重新发现适用 rules/`AGENTS.md`/skills；无公开 Auto Memory 契约 |
| 恢复会话 | `/resume` 恢复保存 chat；项目文件取当前磁盘状态 | 恢复完整 history、tool calls/results、通常恢复 model；标准 settings 重读 | transcript/checkpoint 可恢复，但公开文档未说明各持久层的精确优先级 |
| 上下文压缩 | `/compact` 和自动压缩；逐层重注入细节未公开 | root rules、Auto memory、受预算约束的 invoked skills 从磁盘重注入；path-scoped 内容按需重载 | 精确重注入协议未公开 |
| 模型切换 | 精确恢复协议未公开 | 新模型重新读取现有 history；磁盘规则与 memory 不依附于原模型 | 精确恢复协议未公开 |

## 对 WWriting 的产品推断

本节全部是基于上述事实和已经确认的产品方向作出的 WWriting 设计结论，不代表三家竞品采用了相同实现。

### 1. 项目根目录维护 `WWRITING.md`

每个工作区在项目根目录维护一份可随小说文件夹迁移的 `WWRITING.md`。它由 Agent 日常更新，用户可以查看和手工编辑；详细总纲、人物设定、世界观和章节内容仍保存在各自权威文件中，`WWRITING.md` 只保存当前有效要求、进度和文件索引，不能变成第二份总纲。

该文件按需创建，不是工作区准入条件：

- 任意可访问文件夹都能立即发送第一条消息；
- `/init` 必须检查、创建或谨慎更新 `WWRITING.md`；
- 普通任务发现跨对话仍需保留的新事实时，Agent 也应维护它，不要求用户先运行 `/init`；
- 文件缺失、损坏或暂时不可写时不能暴露底层 `ENOENT`，也不能阻止普通聊天；
- 删除该文件表示项目记忆需要重建，不表示文件夹不再是合法工作区。

会话 transcript、event log、恢复点和索引继续保存在应用私有目录，并通过稳定 workspace ID 与项目路径关联，不能再依赖项目内 `.wwriting/agent/events.jsonl`。

### 2. 内置写作风格技能只负责小说正文

`balanced`、`fast-readable`、`psychological-literary` 作为应用级系统技能分发，使用稳定 ID。用户可以查看名称、用途和完整提示词，但不能删除、覆盖、直接编辑或通过项目开关停用。技能“存在”不等于“当前激活”。

三个技能只在生成、续写、改写、润色或审核小说正文时生效；讨论剧情、解释修改、询问用户和报告工具结果时不应用小说文风。

### 3. 风格选择不建立设置层级

WWriting 不提供全局默认、工作区默认、当前对话覆盖或输入框风格选择器。用户明确指定时按自然语言要求选择；用户没有指定时，模型根据题材、目标读者、节奏与用户描述自主判断。

第一次确定小说风格后，把精确技能 ID 和小说特有的补充要求写入总纲及项目记忆。用户以后用自然语言调整风格时，Agent 更新当前有效说明；只有用户明确限定范围时才记录章节或阶段范围。

第一版不增加 `/balanced` 等可见斜杠命令。自然语言明确指定和模型按 description 自动选择已经覆盖核心用例。

### 4. 渐进加载与统一恢复

会话启动时只注入三个内置风格的名称、描述、稳定 ID，以及“仅作用于小说正文”的路由规则。真正需要写作时，再根据 `WWRITING.md` 和总纲记录的技能 ID 读取完整 `SKILL.md`。

以下事件都属于恢复边界：新对话、上下文压缩、模型切换、Run 重试、进程恢复，以及从没有完整上下文的历史会话继续。每次进入恢复边界都重新读取 `WWRITING.md`；准备写正文时再按其中的索引读取总纲、设定和风格技能。不能依赖模型“应该还记得”。

### 5. 最小产品合同

1. 任意可访问文件夹都可以立即开始聊天。
2. 每个工作区按需创建项目根目录 `WWRITING.md`，但它不是聊天门槛。
3. `/init` 和日常 Agent 都知道并维护 `WWRITING.md`，无需用户反复提醒。
4. 三个内置风格可查看但不可删除、覆盖、直接编辑或停用。
5. 风格由模型自动判断或用户自然语言指定，不增加设置层级和斜杠命令。
6. 写作风格只作用于小说正文，不改变 Agent 日常交流语气。
7. `WWRITING.md`、总纲等创作文件与应用私有 transcript 分层保存。
8. 新对话、恢复、压缩、模型切换都从同一项目记忆入口恢复项目知识。

## 证据边界

- Codex 系统技能刷新行为来自固定 commit 的官方源码，后续实现可能变化。
- Claude Code 对 skill 压缩预算和 session 恢复的说明是当前官方产品契约，WWriting 不必复制其具体 token 数字。
- Cursor 没有公开某项契约时，本报告写“未公开/未找到”，不把它等同于“不存在”。
- “每项目一个 memory 文件”“内置写作风格只读可派生”“stable ID”“原子写和 schema version”均为 WWriting 产品推断。
