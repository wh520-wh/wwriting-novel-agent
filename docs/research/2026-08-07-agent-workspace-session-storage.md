# Agent 工具的工作区、会话存储与规则边界

- 日期：2026-08-07
- 调研对象：OpenAI Codex、Anthropic Claude Code、Cursor
- 来源原则：官方产品文档、官方源码、第一方支持资料优先
- 问题：一个普通文件夹是否应当立即可聊天；聊天记录放在哪里；项目规则与应用级配置如何分层

## 结论先行

三个产品的共同模式很明确：**文件夹负责提供工作上下文，应用私有目录负责保存会话与索引，项目规则文件只负责增强行为，不是开始聊天的资格门槛。**

因此，WWriting 不应要求新工作区预先存在 `project.yaml`、`.wwriting/agent/events.jsonl` 或任何固定目录结构。用户选择一个可访问文件夹后就应当可以发送第一条消息。项目内配置缺失、损坏或不存在时，最多表示“没有项目级增强配置”，不能导致聊天入口失效。

## 对照表

| 产品 | 文件夹如何成为工作区 | 会话/聊天记录 | 项目内规则 | 应用级配置 |
| --- | --- | --- | --- | --- |
| OpenAI Codex | CLI 把启动目录视为当前项目，也可用 `-C/--cd` 指定；IDE 把已打开的 folder/workspace 视为本地项目 | 本地 transcript 保存在 `CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`；SQLite 是可查询的元数据索引 | `AGENTS.md`、`.codex/config.toml`，均为可选增强；项目配置只在可信项目中加载 | `~/.codex/config.toml` 保存个人默认值；项目配置覆盖用户配置 |
| Claude Code | 官方入门直接要求 `cd your-project && claude`；未要求 Git、manifest 或预生成文件 | 明确保存在 `~/.claude/projects/<project>/<session>.jsonl`，默认 30 天；用于 `--continue`、`--resume` | `CLAUDE.md` / `.claude/CLAUDE.md` 是提示词指导；`.claude/settings.json` 是项目设置；都不是启动门槛 | `~/.claude/settings.json` 是全局设置；`~/.claude/` 还保存 UI 状态、会话、历史和自动记忆 |
| Cursor | 官方快速开始是“选择一个文件夹”，随后 Agent 搜索和读取该文件夹 | 官方支持回复显示当前本地 Agent transcript 位于 `~/.cursor/projects/<slug>/agent-transcripts/`，侧栏列表来自 workspace storage 中的会话索引；这是当前实现细节，不是公开稳定 API | `.cursor/rules/*.mdc` 或根/子目录 `AGENTS.md`；项目规则用于共享上下文 | User Rules 在 Cursor 设置中维护，适用于所有项目；团队规则由仪表盘管理 |

## OpenAI Codex

### 任意目录可以成为项目上下文

OpenAI 的“Projects and chats”文档明确写明：Codex CLI 将启动时所在目录视为当前 chat 的 project；可以直接在目标目录运行 `codex`，也可以用 `--cd`/`-C` 指定。IDE 扩展把 IDE 当前打开的 folder 或 workspace 视为 local project。文档没有要求该目录必须是 Git 仓库，也没有要求存在项目描述文件。

Codex 桌面端的 local project 可以挂载一个或多个文件夹；主文件夹用于新 chat 的默认工作目录、Git 操作，以及自动发现 `AGENTS.md`、skills 和 `config.toml`。这里的措辞是“自动发现”，不是“缺失时禁止聊天”。

来源：

- [OpenAI：Projects and chats](https://learn.chatgpt.com/docs/projects)

### 会话数据与工作目录分离

Codex 官方源码把本地会话拆成两个兼容层：rollout JSONL 是可持久回放的记录格式，SQLite state DB 是用于快速 list/read 的元数据索引。源码在写入新会话时从 `codex_home` 构造 `sessions/YYYY/MM/DD`，文件名为 `rollout-<timestamp>-<conversation_id>.jsonl`。这意味着 transcript 的持久化根属于 Codex 自己，而不是当前项目目录。

来源：

- [OpenAI Codex 源码：LocalThreadStore 的存储契约](https://github.com/openai/codex/blob/4ee41929eaf4fc1e5662c9b4befd05230688ca62/codex-rs/thread-store/src/local/mod.rs#L87-L101)
- [OpenAI Codex 源码：从 CODEX_HOME 构造 sessions 路径](https://github.com/openai/codex/blob/4ee41929eaf4fc1e5662c9b4befd05230688ca62/codex-rs/rollout/src/recorder.rs#L1547-L1574)

### 规则与配置按作用域分层

Codex 推荐用 `AGENTS.md` 保存可共享、持久的仓库指导；个人默认配置位于 `~/.codex/config.toml`，仓库特定配置位于 `.codex/config.toml`。项目配置从项目根到当前目录逐层加载，越近的配置优先；不可信项目跳过项目范围 `.codex/` 配置，但用户级配置仍可工作。

来源：

- [OpenAI：AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [OpenAI：Config basics](https://learn.chatgpt.com/docs/config-file/config-basic)

## Anthropic Claude Code

### 项目入口就是一个目录

Claude Code 官方 Overview 的入门方式是进入任意项目目录后运行 `claude`：

```bash
cd your-project
claude
```

该入口不要求预先存在 `.claude/`、`CLAUDE.md`、Git 仓库或 manifest。`CLAUDE.md` 是可选的持续指导；`/init` 只是帮助生成它，而不是首次聊天初始化协议。

来源：

- [Anthropic：Claude Code Overview](https://code.claude.com/docs/en/overview)

### 会话记录明确保存在应用目录

Anthropic 的 application data 文档比多数 Agent 产品更明确：

- `~/.claude/projects/<project>/<session>.jsonl` 保存完整会话，包括消息、tool call 和 tool result。
- `~/.claude/projects/<project>/<session>/subagents/` 保存子代理 transcript。
- `~/.claude/history.jsonl` 保存输入过的 prompt 及其项目路径，用于历史召回。
- transcript 默认按 `cleanupPeriodDays` 在 30 天后清理。
- 删除 `~/.claude/projects/` 会失去过去会话的 resume/continue/rewind，但不会阻止新会话。

Claude Code 的 common workflows 同时确认：每个 conversation 都保存在本地；`claude --continue` 恢复当前目录最近的会话，`claude --resume` 打开选择器。

来源：

- [Anthropic：Explore the .claude directory，Application data](https://code.claude.com/docs/en/claude-directory#application-data)
- [Anthropic：Common workflows，Resume previous conversations](https://code.claude.com/docs/en/common-workflows#resume-previous-conversations)
- [Anthropic：Data usage，Local caching](https://code.claude.com/docs/en/data-usage#data-retention)

### 指导文件与强制配置是两类东西

Claude Code 明确区分：

- `CLAUDE.md` 是加载进模型上下文的指导，不是强制执行配置。
- `.claude/settings.json` 管理权限、环境变量、hooks、模型等项目设置。
- `.claude/settings.local.json` 是个人的项目覆盖，通常被 gitignore。
- `~/.claude/settings.json` 是用户全局默认。

项目可以完全没有这些文件，仍然能开始新会话。它们只改变 Agent 如何工作。

来源：

- [Anthropic：How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Anthropic：Claude Code settings](https://code.claude.com/docs/en/settings)

## Cursor

### 快速开始只要求选择文件夹

Cursor 官方 Quickstart 的第一步是打开应用、登录并“选择一个文件夹”；随后 Agent 就可以搜索仓库、读取相关文件并解释代码库。文档没有要求先创建 `.cursor/` 或任何项目 manifest。

来源：

- [Cursor：Quickstart](https://cursor.com/docs/get-started/quickstart)

### 会话数据由应用保存，但当前实现有索引与 transcript 两层

Cursor 的公开产品文档没有把本地会话目录声明为稳定接口。第一方支持论坛在 2026 年 7 月对丢失侧栏会话的问题给出的说明是：

- transcript 仍在 `~/.cursor/projects/<slug>/agent-transcripts/` 下的 JSONL 文件中。
- Agents 侧栏不是直接扫描 transcript，而是读取 workspace storage 中的 session index。
- 索引损坏或升级后丢失时，transcript 可以仍然存在，但侧栏会显示为空。

这能证明 Cursor 也把会话数据放在应用私有目录，而不是要求项目目录提供记录文件；但具体路径和索引结构属于当前实现细节，不应被 WWriting 当成需要照抄的长期格式。

来源：

- [Cursor 第一方支持：Agents sidebar empty，transcripts still on disk](https://forum.cursor.com/t/agents-sidebar-empty-222-transcripts-still-on-disk-windows/162757/16)

### 项目规则可共享，用户规则跨项目

Cursor 项目规则保存在 `.cursor/rules/*.mdc` 并进入版本控制；简单场景也支持项目根或子目录的 `AGENTS.md`。User Rules 在 Cursor 的设置界面维护，应用于所有项目。规则在提示词层面提供持久上下文，并非创建或识别工作区的必要文件。

来源：

- [Cursor：Rules](https://cursor.com/docs/rules)

## 对 WWriting 的产品决策启示

### 1. `文件夹 = 工作区 = 项目`

用户选择任何可访问目录后，应立即得到一个可聊天的工作区。是否存在 Git、小说骨架、`project.yaml`、`.wwriting/`、章节目录或历史文件，都不能参与“能否发送第一条消息”的判定。

### 2. 会话持久化属于应用，不属于小说文件夹

建议把以下数据放在 WWriting 的应用数据根目录，并以规范化后的文件夹身份关联：

- chat/thread transcript
- Agent event log
- 会话索引与标题
- checkpoint、临时 tool result、失败恢复状态
- 工作区个人设置，如当前模型、写作风格和权限默认值

项目目录只保存用户创作的正文、设定、资料，以及用户明确选择共享/导出的规则文件。这样不会污染任意打开的目录，也不会因为工作区缺少 `.wwriting/agent/events.jsonl` 而出现 ENOENT。

### 3. 应用必须拥有并创建自己的存储结构

首次发送消息时，应用应当自行确保会话存储根和索引存在。即使索引缺失或损坏，也应能重建索引或开始新会话；不能把底层 `ENOENT` 和绝对路径直接暴露给普通用户。Cursor 的 transcript/索引分离问题说明：索引必须可恢复，不能成为历史记录唯一的真相来源。

### 4. 项目规则是可选增强，不是 schema 门禁

后续若保留或新增 WWriting 项目规则，应明确分成：

- 应用级默认：所有工作区共用，例如新工作区默认写作风格。
- 工作区个人覆盖：由应用私有存储保存，例如某本小说的默认写作风格，不影响其他小说。
- 对话临时覆盖：只影响当前对话。
- 可共享项目规则：只有用户需要版本控制或团队共享时，才写入项目目录。

写作风格片段应只在“生成或改写小说正文”的任务中注入，不应改变 AI 与用户讨论需求、解释方案时的对话语气。这一作用域也应作为工作区设置，而不是项目能否聊天的前置文件。

### 5. 目录移动需要身份迁移策略

三类产品都将会话与项目路径关联。若 WWriting 只用绝对路径作唯一键，目录重命名或移动后会看起来像一个新项目。更稳妥的产品语义是：路径用于定位，应用维护稳定 workspace ID，并在用户重新选择已移动目录时提供关联或迁移，而不是丢失历史。

## 取舍边界

- 不建议把所有设置都写进项目目录：这会污染普通文件夹，并混淆“个人偏好”和“可共享项目规则”。
- 不建议完全隐藏项目规则能力：当用户需要把小说写作约束随项目备份或协作时，显式导出/共享规则仍有价值。
- 不建议依赖单一 SQLite 索引保存全部历史：JSONL/append-only transcript 加可重建索引的模式更抗损坏，但具体格式应由 WWriting 自己的恢复与迁移需求决定。
- 本文只给出产品边界与公开事实，不构成实现计划。
