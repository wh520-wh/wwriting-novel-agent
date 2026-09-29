# AI Agent CLI 产品横向对比调研报告

调研日期:2026-09-27。方法:逐产品抓取官方文档与一手资料(code.claude.com、developers.openai.com、gemini-cli GitHub 仓库、aider.chat、opencode.ai、ampcode.com 等)。聚焦机制设计:权限、队列/打断、上下文压缩、记忆文件、会话恢复、工具扩展。所有产品均为 2025–2026 年在活跃迭代的状态,文档结构变动频繁,个别细节已标注「未确认」。

## 0. 核心结论(TL;DR)

1. **权限模式正在从「三档开关」演进为「模式 + 规则 + 分类器」三层体系**。Claude Code 现有 6 种模式(default/acceptEdits/plan/auto/dontAsk/bypassPermissions),在模式之下叠加 `Tool(specifier)` 粒度的 allow/ask/deny 规则,并引入 `auto` 模式用分类器模型替人审;Codex CLI 从 suggest/auto-edit/full-auto 收敛为 approval_policy × sandbox_mode 二维矩阵,并推出更细的 permission profiles。WWriting 的「普通模式只读自动放行 + 写副作用确认」与业界 `default`/`plan` 模式语义完全对齐,方向正确。
2. **「记住选择」全部有作用域边界,且几乎没有产品让文件类副作用获得永久授权**。Claude Code:Shell 命令按仓库永久记住(settings.local.json),文件修改只在当前会话内有效;Codex:「永远记住」仅限非危险类别;Gemini CLI 的跨会话授权是 beta 开关且默认关闭。WWriting「同类授权仅对当前这条输入生效」比所有产品都严格,是差异化安全卖点,可保留。
3. **无一产品提供「输入精确确认文字」的极端操作机制**——这是 WWriting 独有的设计。最接近的是各产品的 deny 规则与组织级 `disableBypassPermissionsMode`/`disableYoloMode`,即「硬禁令」而非「主动确认」。WWriting 需要自行定义极端操作清单(如批量删除章节、覆盖 WWRITING.md、清空 journal)。
4. **消息队列已分化为「排队(FIFO)」与「注入(steering)」两条通道**:Claude Code 默认 FIFO 排队、Ctrl+Enter 强制提前发送;Codex CLI 与 Amp 反过来,默认把新消息注入当前执行步(steering)、用专门键(Tab / Ctrl+Enter)排队到整轮结束;Esc 都是打断键。WWriting 的「排队 + 立即」双通道设计与 Codex/Amp 的双通道高度同构,且「立即」= steering + 打断,语义更重、更明确。
5. **上下文压缩三家都有自动化 + 手动双通道**:Claude(auto-compact 阈值触发 + `/compact [指令]` + microcompact 清工具结果)、Codex(自动压缩 + `/compact`)、Gemini(`/compress` + 自动压缩)。Aider 走另一条路:repo map 常驻压缩代码上下文,不做对话压缩。长篇小说写作必须做「章节滚动摘要」,可借鉴 Claude 的「压缩时可附加保留指令」。
6. **记忆文件机制全面趋同于 AGENTS.md 标准**(Linux 基金会旗下,60k+ 项目采用),三家 `/init` 全部遵循「已存在则改进、不盲目覆盖」。Claude Code 的 auto memory(MEMORY.md 索引 + 主题文件按需读)是最适合小说「卷→章」层级的参考模型。
7. **会话恢复各家都有,差异在持久化策略**:Claude 按目录自动存、支持命名/fork;Gemini 默认保留 30 天、支持会话分支点;Aider 干脆不做会话恢复,用 git auto-commit 兜底。WWriting 的 journal 断点恢复设计应吸收「命名会话 + fork」两点。

---

## 1. Claude Code(基准产品,资料最全)

### 1.1 权限模式与规则语法

**六种权限模式**(v2.1.200+ 起 `default` 有别名 `manual`):

| 模式 | 语义 |
| --- | --- |
| `default` | 每个工具首次使用时提示;工作目录内只读操作(读文件、Grep)不提示 |
| `acceptEdits` | 自动接受文件编辑及 `mkdir`/`touch`/`mv`/`cp` 等常见文件操作,仅限工作目录与 `additionalDirectories` 内 |
| `plan` | 只读规划模式:可读文件、跑只读命令,不改文件 |
| `auto` | 后台分类器模型审查动作,只拦截看起来有风险的操作(v2.1.283+) |
| `dontAsk` | 自动拒绝一切本会弹窗的操作(用于无人值守) |
| `bypassPermissions` | 跳过所有权限提示,「除少数任何模式都不自动放行的动作」;连 `.git`、`.claude` 等受保护路径也跳过,官方明确建议只在容器/VM 等隔离环境使用 |

**规则语法**(`settings.json` 的 `permissions.allow/ask/deny` 数组,格式 `Tool` 或 `Tool(specifier)`):

```json
{
  "permissions": {
    "allow": ["Bash(npm run lint)", "Bash(npm run test *)"],
    "deny": ["Read(./.env)", "Read(./.env.*)"]
  }
}
```

- **求值顺序:deny → ask → allow,先匹配先赢,与规则特异性无关**。宽的 `Bash(aws *)` deny 会压过窄的 `Bash(aws s3 ls)` allow;跨文件同理——任何范围的 deny 都压过任何 allow。
- Bash 匹配器细节:`Bash(npm run build)` 精确匹配(不匹配 `npm run build --watch`);`Bash(npm run *)` 前缀匹配;`:*` 后缀等价尾部通配(`Bash(npm run test:*)` 即 `Bash(npm run test *)`),且 `:*` 只在模式末尾被识别;`Bash(ls *)` 与 `Bash(ls*)` 语义不同(空格敏感)。复合命令按 `&&`、`||`、`;`、`|`、换行等拆分子命令,**每个子命令都要独立命中 allow 才放行,deny/ask 任一子命令命中即触发**。`timeout`、`nohup` 等包装器与安全环境变量赋值会被剥掉再匹配。
- 路径规则为 gitignore 风格,四种锚点:`//path`(文件系统绝对)、`~/path`(家目录)、`/path`(相对 settings 文件所在范围)、`path`(相对 cwd);裸文件名 `Read(.env)` 等价 `Read(**/.env)`,任意深度命中。
- **官方明确声明 Bash 规则只是文本匹配、不是安全边界**:`Bash(rm *)` 拦不住 `/bin/rm -rf build/` 或 `bash -c 'rm -rf build/'`;真正的边界要靠 OS 级沙箱或 PreToolUse hooks。

**「Yes, and don't ask again」的持久化作用域**(对 WWriting 极有参考价值):

| 操作类型 | 记住多久、存在哪 |
| --- | --- |
| Bash 命令 | **按仓库永久**,存到 git 仓库根 `.claude/settings.local.json`,对整个仓库(含 worktree/子目录)的未来会话生效 |
| WebFetch 域名 | 按域名永久,同上 |
| **文件修改** | **仅当前会话,不持久化** |
| Web 搜索 | 按仓库永久 |
| 复合命令 | 按子命令拆分保存(最多 5 条规则) |

来源:[Permissions](https://code.claude.com/docs/en/permissions)、[Settings](https://code.claude.com/docs/en/settings)

### 1.2 Hooks 机制

用户定义的 shell 命令/HTTP 端点/MCP 工具/LLM 提示,挂在生命周期事件上:`PreToolUse`(可阻断工具调用)、`PostToolUse`、`UserPromptSubmit`(可拒绝输入)、`PermissionRequest`、`Stop`、`SessionStart/End`、`PreCompact/PostCompact` 等 20+ 事件。配置为 事件 → matcher → handlers 三层:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "if": "Bash(rm *)",
                  "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh" }]
    }]
  }
}
```

- 处理器从 stdin 收 JSON(`tool_name`、`tool_input`、`permission_mode` 等),可输出 `permissionDecision: allow/deny/ask`。
- **exit code 2 是强制阻断**:连 JSON 里 `"permissionDecision": "allow"` 都无法覆盖 exit 2 的阻断效果。
- **hooks 不能越过权限规则**:命中 deny/ask 规则时,即使 hook 返回 allow 也照样拦;但 exit 2 的阻断 hook 可以压过 allow 规则。
- 对 WWriting 的意义:hooks 是「用户可编程的权限扩展点」,若未来做「写到卷宗目录外即拦截」类需求,这是成熟范式。

来源:[Hooks Reference](https://code.claude.com/docs/en/hooks)

### 1.3 斜杠命令、/init 与记忆体系

- 内置命令:`/init`(自动生成起始 CLAUDE.md;若已存在则分析代码库并**建议改进而非覆盖**,还能导入 Cursor/Copilot/AGENTS.md 规则)、`/permissions`(查看/增删权限规则)、`/memory`(查看与编辑记忆文件)、`/compact`、`/clear`、`/context`(上下文占用可视化)、`/rewind`、`/resume`、`/rename`、`/statusline`(用自然语言生成状态栏脚本)等。
- 自定义命令:`.claude/commands/*.md` 文件,支持 `$ARGUMENTS` 占位与 frontmatter(可限定 `allowed-tools`);斜杠菜单的本质是**输入补全**,不存在第二控制面——与 WWriting P1 一致。
- **CLAUDE.md 四级记忆**:企业策略级 → 用户级 `~/.claude/CLAUDE.md` → 项目级 `./CLAUDE.md`(进版本库)→ 本地级 `./CLAUDE.local.md`(gitignore,个人偏好)。加载时自上而下拼接、不覆盖;子目录 CLAUDE.md **惰性加载**(Claude 读到该目录文件时才载入)。
- `@path/to/import` 导入语法,递归最多 4 层;官方建议单文件控制在 200 行内,**超过 4 MiB 直接跳过**。
- AGENTS.md 仅在项目内无任何 CLAUDE.md 时作为回退读取(可配置)。
- Auto memory(v2.x 新增,默认开):Claude 自动把 user/feedback/project/reference 四类笔记写入 `~/.claude/projects/<项目>/memory/`,由 `MEMORY.md` 做索引(**仅加载前 200 行 / 25KB**),主题文件按需读取。**这个「索引 + 按需展开」结构对小说的「分卷大纲 + 章节摘要」是直接可抄的模型。**

来源:[Slash Commands](https://code.claude.com/docs/en/slash-commands)、[Memory](https://code.claude.com/docs/en/memory)、[Best Practices](https://code.claude.com/docs/en/best-practices)

### 1.4 上下文压缩

- **auto-compact**:对话接近上下文窗口阈值时自动把旧历史摘要化;阈值可在模型配置里调整,触发前有可见警告。
- **`/compact [指令]`**:手动压缩,可附保留指令,如 `/compact Focus on code samples and API usage`;CLAUDE.md 里可写常设压缩偏好。空会话会拒绝("Not enough messages to compact")。
- **microcompact**:清理旧工具调用结果、保留对话文本,这是「工具结果膨胀」这一 LLM CLI 特有问题的专门解法(小说 CLI 对应「长文件内容膨胀」)。
- **`/clear` 是最便宜的新开始**:官方强调压缩「要读一遍全部对话」,而 `/clear` 零成本;最佳实践章节的原话:"A clean session with a better prompt almost always outperforms a long session with accumulated corrections"。
- `/context` 可视化各块占用(记忆文件、MCP 工具定义等)。

来源:[Costs & Context](https://code.claude.com/docs/en/costs)、[Best Practices](https://code.claude.com/docs/en/best-practices)

### 1.5 会话持久化与恢复

- 自动保存;`claude -r <session-id|name>` 恢复指定会话,`claude -c` 恢复当前目录最近一次;`--fork-session` 恢复时创建新 session ID(试错不污染原会话);`/rename` + `--name` 给会话命名;`--no-session-persistence` 关闭持久化(print 模式)。
- **checkpoint/rewind**:每轮改文件前自动存检查点,`Esc+Esc` 或 `/rewind` 恢复对话+代码到任意检查点;**官方注明 checkpoint 不覆盖 Bash 命令造成的改动**——工具实现层的改动要另想办法兜底。

来源:[CLI Reference](https://code.claude.com/docs/en/cli-reference)、[Best Practices](https://code.claude.com/docs/en/best-practices)

### 1.6 消息队列与打断

- **Esc = 打断**:中途停止响应,「保留已完成的工作」;在权限卡上 Esc = 拒绝。
- **运行中输入默认进 FIFO 队列**:按 Enter 排队,灰色显示,按输入顺序发送;工具调用进行中则等当前调用结束后在同一轮内消费,轮结束时仍有排队则自动继续发送。命令类输入与 `!` shell 命令排队到整轮结束、逐条执行。
- **Ctrl+Enter = 强制立即发送**:队列消息立刻发出,草稿排队垫后;若队首是 shell 命令则直接打断当前轮。
- **Up 键从输入框首行可以把已排队消息取回编辑**——防呆细节。
- `Shift+Tab` 循环切换权限模式;`Ctrl+B` 把运行中 Bash/agent 移入后台。

来源:[Interactive Mode](https://code.claude.com/docs/en/interactive-mode)

### 1.7 沙箱、状态栏与其他

- **沙箱**:macOS Seatbelt / Linux bubblewrap,OS 级文件+网络隔离;`autoAllowBashIfSandboxed` 默认 true——**沙箱内命令免确认**,这是「用硬边界换少打扰」的思路;网络走代理域名白名单,首次访问新域名仍弹窗。Windows 原生不支持(需 WSL2)。
- **statusline**:settings.json 配 `statusLine.command`,脚本从 stdin 收 JSON(含 `model.display_name`、`cost.total_cost_usd`、`context_window.used_percentage` 等),300ms 防抖,本地执行零 token。**WWriting 的 composer 上方实时行可参考其输入结构。**
- `--dangerously-skip-permissions`:等价 `--permission-mode bypassPermissions`;官方文档持续强调仅限隔离环境,组织可用 `permissions.disableBypassPermissionsMode: "disable"` 全局禁用。

来源:[Sandboxing](https://code.claude.com/docs/en/sandboxing)、[Status Line](https://code.claude.com/docs/en/statusline)、[Permissions](https://code.claude.com/docs/en/permissions)

---

## 2. OpenAI Codex CLI

### 2.1 审批与沙箱演进

- 早期三档 suggest / auto-edit / full-auto(2025 年 4 月起)已演进为**二维矩阵**:
  - `approval_policy`: `untrusted`(未列入白名单的命令都要批)| `on-request`(模型自行决定何时请求)| `never`(永不请求,失败即止)+ 细粒度 `granular` 配置;`on-failure` 已弃用。
  - `sandbox_mode`: `read-only` | `workspace-write`(工作区可写、默认禁网)| `danger-full-access`。
- 沙箱实现:macOS Seatbelt,Linux Landlock + seccomp。workspace-write 下可用 `[sandbox_workspace_write] network_access = true` 单独开网。
- **审批决策 UI 四选项**:一次批准 / 本会话所有同类 / **永远记住 / 否决**——与 WWriting 三档几乎同构,但「永远」有类别限制,危险类别不给永久选项。
- 逃生通道:`codex exec --full-auto`、`codex --dangerously-bypass-approvals-and-sandbox`(别名 `--yolo`),同样建议仅在隔离环境使用。

### 2.2 权限 profiles(beta,粒度最细的业界方案)

`codex --profile read-only / workspace / danger-full-access` 预设三档;自定义 profile 可按 **绝对路径 / cwd / 工作区** 分别设 `disk_write` 与 `disk_read`,`net` 单独放行或禁用,mode 取值 `deny-only` | `per-user-approval`;Windows 下另有驱动器/路径粒度规则。Bash 层面支持「仅允许列出的命令前缀、其余走审批」的白名单模式。这是目前业界把「路径粒度」做得最深的权限系统。

### 2.3 AGENTS.md、记忆与压缩

- AGENTS.md 共同发起方。发现顺序:当前目录起逐级向上,**最近者赢**;monorepo 常放 88+ 个分目录 AGENTS.md(OpenAI 自家仓库即如此);`project_doc_max_bytes` 默认 **16 KiB**(旧版文档曾为 4 KiB,现行值 16 KiB,不同版本文档有过出入)——**记忆文件超限静默截断,是所有产品的共识做法**。回退文件名可用 `project_doc_fallback_filenames = ["CLAUDE.md"]`。
- Memories 功能(beta):`memories.enabled` 开启后自动生成/更新 AGENTS.md 与跨会话记忆,存 `~/.codex/memories`;更新前弹卡片供审批,可从卡片跳转编辑。**「记忆更新本身也是一个要审批的写副作用」,这个定位值得 WWriting 借鉴——WWRITING.md 的 /init 更新也应走确认。**
- 上下文压缩:自动压缩(auto-compaction)+ `/compact` 手动;`model_auto_compact_token_limit` 可调阈值;压缩时保留摘要与文件列表。`/init` 生成 AGENTS.md。
- Hooks 支持(`codex hooks`,beta),`requirements.toml` 里 `allow_managed_hooks_only = true` 可只允许受管 hooks。

### 2.4 会话与队列(与 WWriting 最相关的部分)

- 会话:`codex resume`(浏览器式选择历史)/ `codex resume --last` / `codex fork`(复制会话改名)/ `codex apply`(把会话中改动落到本地);`history.persistence = "save-all" | "none"`。
- **消息双通道**(官方文档原话):按 **Enter = steering**,消息注入当前执行步("agent will see it at the next tool-call boundary");按 **Tab = 排队**到整轮结束,队列项在界面最左栏显示 `[Q]` 标记。
- **Esc+Esc = 打开「编辑之前的消息」**:回滚到该轮的检查点重答,**每次交互轮自动有 checkpoint**——打断不是丢弃,而是可回滚的分支。
- 其他:`/review`、`/plan`、`/diff`、`/mention`、`/memory`、`/permissions`、`/status`、`CTRL+T` 显示 token 用量;自定义 prompts 放 `~/.codex/prompts/name.md`;MCP 经 `mcp_servers` 配置并可按工具单独审批。

来源:[Codex CLI Features](https://developers.openai.com/codex/cli/features)、[Permissions](https://developers.openai.com/codex/permissions)、[Config Reference](https://developers.openai.com/codex/config-reference)、[AGENTS.md](https://agents.md/)

---

## 3. Gemini CLI

### 3.1 审批模式与 YOLO

- 四种 approval mode:`default`(逐个确认)| `auto_edit`(自动批准编辑类工具)| `plan`(只读)| `yolo`(全部自动批准)。`--approval-mode=yolo` 是现行写法,旧的 `--yolo`/`-y` 已标记弃用。
- **YOLO 可被组织/用户硬禁**:`security.disableYoloMode: true`(settings.json)「Disable YOLO mode, even if enabled by a flag」——与 Claude 的 disableBypassPermissionsMode 同构,**「YOLO 必须可被策略关闭」已成业界铁律**。
- 「总是允许」分级:`security.disableAlwaysAllow` 控制是否提供 Always allow 选项;`security.enablePermanentToolApproval: true`(beta)才允许「所有未来会话」级授权,默认关;`security.toolSandboxing`(beta)提供沙箱。
- settings.json 中 `general.defaultApprovalMode` 设默认档(此处不能直接设 yolo,只能命令行开)。

### 3.2 Checkpointing 与 /restore

- 默认关闭,`settings.json` 里 `"checkpointing": { "enabled": true }` 开启;依赖 git(用影子仓库 `~/.gemini/history/<project_hash>` 存快照,不碰用户自己的 git)。
- 修改文件的工具执行前**自动存检查点**:git 快照 + 对话历史 + 待执行工具调用(JSON 存 `~/.gemini/tmp/<hash>/checkpoints`)。
- `/restore` 单独执行列出检查点;`/restore <file>` **恢复文件 + 恢复对话 + 把原工具调用重新弹出来让你改参重发/忽略**——「恢复后重新提议原调用」是独有细节,对小说写作「回滚这一章重生成」场景非常贴切。

### 3.3 GEMINI.md 记忆与 /memory

- 三层:全局 `~/.gemini/GEMINI.md` → 工作区及其父目录 → **JIT 子目录**(工具触到某目录时才扫描该目录及祖先的 GEMINI.md,直到受信根)。全部文件**拼接后随每个 prompt 发送**,不是「最近者赢」。
- `@file.md` 导入语法;`context.fileName` 可改文件名甚至换用 `["AGENTS.md", "GEMINI.md"]` 列表(兼容 AGENTS.md 标准)。
- `/memory show` 显示拼接后的完整记忆;`/memory reload` 强制重扫。(旧版文档有 `/memory add`「保存事实到 GEMINI.md」,现行文档已不列,**未确认当前是否仍提供**。)

### 3.4 会话与压缩

- 会话自动保存到 `~/.gemini/tmp/<project_hash>/chats/`(prompts、响应、工具执行、token 统计);`gemini --resume [n|uuid]`、`--list-sessions`、`--delete-session`;交互内 `/resume` 打开 Session Browser(可搜索、预览);**`/resume save <name>` 可建命名分支点**。
- 保留策略:`general.sessionRetention`(默认 30 天,可配 maxAge/maxCount)——**显式的会话保留期设计,其他产品没有**。
- `/compress`:源码定义为 "Compresses the context by replacing it with a summary",别名 `summarize`/`compact`;另有自动压缩(hooks-system 的 compress-auto 集成测试佐证)。
- MCP 支持 OAuth,extensions 体系可打包分发;hooks 体系(beta)事件与 Claude 类似。

来源:[Gemini CLI settings](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md)、[Checkpointing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md)、[GEMINI.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md)、[Session Management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)、[/compress 源码](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/commands/compressCommand.ts)

---

## 4. Aider(老牌结对编程 CLI,思路最「工程师」)

- **确认模式**:`--yes-always`「Always say yes to every confirmation」是唯一的全局跳过开关;无分模式体系。这是**最粗粒度**的方案——WWriting 不应学它把所有确认收拢成一个布尔值,但它证明了「一键全允许」的需求真实存在,可以作为 YOLO 的用户心智参照。
- **git 即安全网**:auto-commits 默认开启,每次 LLM 修改文件自动 commit;dirty-commits 默认开启,编辑前先把你未提交的改动单独 commit,**保证任何时刻都可回滚**;聊天内 `/undo`(撤销上次改动)、`/diff`、`/commit`、`/git`(跑任意 git 命令)。commit message 用弱模型按 Conventional Commits 生成;attribution 默认在 author/committer 名追加 `(aider)` 并加 `Co-authored-by` trailer(均为默认开)。
- **CONVENTIONS.md**:`--read CONVENTIONS.md` 或 `/read` 载入约定文件,标记为**只读文件**参与 prompt 缓存;`.aider.conf.yml` 里 `read: [CONVENTIONS.md, anotherfile.txt]` 常驻加载。与 CLAUDE.md 的区别:**Aider 没有「自动注入的记忆文件」,一切约定都是显式加入对话的只读文件**——机制更简单透明,但少了层级与惰性加载。
- **lint/test hook**:`--auto-lint`(默认 true)改动后自动 lint,**错误回喂 LLM 自动修复**;`--auto-test`(默认 false)+ `--test-cmd` 同理;`--lint-cmd "python: flake8 ..."` 按语言配置。这是「写完即验证」闭环的最早 CLI 实现,WWriting 的「客观字数统计后再补写」是同构思路(工具产出的客观信号回流给 Agent 决策)。
- 其他:repo map(tree-sitter 提取符号)常驻压缩代码上下文;`--watch-files` 监听 `# ai:` 注释;`/read` 加入的只读文件不能被 Agent 修改(原生只读概念)。

来源:[Aider Options](https://aider.chat/docs/config/options.html)、[Git Integration](https://aider.chat/docs/git.html)、[Conventions](https://aider.chat/docs/usage/conventions.html)

---

## 5. 新兴 Agent CLI:opencode、Crush、Amp

### 5.1 opencode(配置驱动,规则最细)

- 权限三值 `allow/ask/deny`,键覆盖 `edit/bash/webfetch/websearch/lsp/question` 等,另有两个**独有的安全哨兵**:`external_directory`(工作区外路径,默认 ask)与 `doom_loop`(**同一工具调用以相同输入重复 3 次即触发 ask**——针对 Agent 卡死循环的确认,值得直接抄)。
- bash 支持模式串对象写法,**last match wins**:`{"*": "ask", "git *": "allow", "rm *": "deny"}`;`.env` 默认读拒绝(`*.env.example` 放行)。
- ask 触发时 UI 三选项:once / **always(存为模式串,如 `git status*`,仅本会话)** / reject;`--auto` 自动批准一切非 deny。
- Agent 级权限覆盖(subagent build 可单独禁 `git push *`),Markdown frontmatter 也能声明权限。
- 记忆:AGENTS.md 优先于 CLAUDE.md(类目内 first-match-wins),全局 `~/.config/opencode/AGENTS.md`,原生回退兼容 `~/.claude/CLAUDE.md` 与 `~/.claude/skills/`;`/init` 扫描仓库生成/更新 AGENTS.md,官方原话是 **改进已有文件 "in place instead of blindly replacing it"**。

来源:[opencode Permissions](https://opencode.ai/docs/permissions/)、[opencode Rules](https://opencode.ai/docs/rules/)

### 5.2 Crush(Charm 出品,工作区共享权限队列)

- **默认一切工具调用都要问**;`crushrc` 里 `permissions allow view ls grep edit ...` 白名单、`permissions deny bash ...` **直接把工具从 Agent 上下文里隐藏**;`--yolo` 全跳过(官方警告 "Be very, very careful")。
- **Workspace 概念**:同一 `--cwd` 的多个客户端共享 session 列表、消息历史、**权限队列**、LSP/MCP 状态——权限卡可以作为跨端共享状态存在(终端 + 其他客户端都能看到同一个待批队列)。
- 初始化分析代码库生成 AGENTS.md(可改名);全局 `~/.config/crush/CRUSH.md` + 工具无关的 `~/.config/AGENTS.md`;`.crushignore` 用 gitignore 语法限制可见文件。
- LSP 集成把语言服务器上下文喂给 Agent;MCP 支持 http/stdio/sse 三传输与 OAuth。

来源:[Crush README](https://github.com/charmbracelet/crush)

### 5.3 Amp(Sourcegraph 出品,线程与远端执行)

- **threads 是一等公民**:一条线程一个 URL,web/CLI/macOS/iOS 同一 agent 同一线程;orbs 为每线程起云上机器,"Send a prompt, close your laptop, and the agent keeps working"。
- **消息默认是 steering 型**:"any message you send is steered: it is sent after the current step instead of waiting for the agent to completely finish";**Ctrl/⌘+Enter 才排队**到整轮结束;**Esc 两次打断**。与 Codex 一致地选择了「注入优先、排队其次」,与 Claude Code 相反。
- Handoff:让 agent 把相关上下文带进一条全新线程继续——比压缩更激进的「换会话不丢上下文」方案。
- 权限:默认高度自动化,交互内以 steering 为主;详细权限模式未见单独文档页(**未确认**)。

来源:[Amp Manual](https://ampcode.com/manual)、[Amp Threads](https://ampcode.com/docs/threads)

---

## 6. 共性设计提炼(六个维度对比)

### 6.1 权限确认的粒度与「记住选择」的作用域

| 产品 | 确认粒度 | 记住选择的作用域 | 危险操作的硬闸 |
| --- | --- | --- | --- |
| Claude Code | 工具 + specifier(Bash 命令文本、路径通配、域名) | Bash/WebFetch 域名:按仓库永久(settings.local.json);**文件修改:仅本会话** | deny 规则;组织级 disableBypassPermissionsMode;OS 沙箱 |
| Codex CLI | approval_policy × sandbox 矩阵;profiles 支持绝对路径级写权限 | 一次 / 会话 / 永久(危险类别不给永久) | danger-full-access 需显式;deny-only profile;`--yolo` 别名即自警 |
| Gemini CLI | 工具类 + 参数级(yolo/auto_edit/plan/default) | 一次 / 会话;**跨会话授权是 beta 开关,默认关** | security.disableYoloMode 硬禁 YOLO |
| Aider | 几乎无确认;`--yes-always` 一键全放 | 不适用(全部交给 git) | git diff 可审计,无硬闸 |
| opencode | 工具 + 模式串(last-match-wins)+ doom_loop 哨兵 | once / 会话内 always;无永久 | deny 规则;agent 级 deny |
| Crush | 默认全问;工具级 allow/deny | allow 列表持久于 crushrc | deny = 工具直接从上下文移除;--yolo 自警 |
| Amp | 默认自动化,steering 为主 | thread 级(**未确认**,无独立权限文档页) | 无公开硬闸 |

**共性规律**:a) 都区分「工具类型」与「具体参数」两级; b) 「永久记住」都倾向只给低危类别(命令白名单、域名),**文件写入类副作用没有一家敢给永久授权**; c) YOLO/bypass 类开关必须可被配置硬禁; d) 纯文本匹配规则都自我声明不是安全边界,真边界在 OS 沙箱。

### 6.2 打断与消息队列的交互模式

| 产品 | 运行中输入的默认行为 | 显式排队 | 打断 | 打断后状态 |
| --- | --- | --- | --- | --- |
| Claude Code | **FIFO 排队**(Enter) | 默认即是;Ctrl+Enter 反向强制提前发送 | Esc;Esc+Esc 清输入/rewind | 保留已完成工作,可继续对话 |
| Codex CLI | **steering 注入当前步**(Enter) | Tab 排队,`[Q]` 标记 | Esc;Esc+Esc 编辑旧消息并回滚到该轮 | 每轮自动 checkpoint,可回滚重答 |
| Gemini CLI | 运行中输入多进排队(细节文档未详,**未确认**) | — | Esc 取消当前操作 | 提供 /restore 恢复 |
| Aider | 基本串行,少有运行中输入场景 | — | Ctrl+C | — |
| Amp | **steering 注入**(默认) | ⌘/Ctrl+Enter 排队 | Esc×2 | 当前 step 结束后生效 |
| Crush | 客户端共享权限队列;输入排队细节未详(**未确认**) | — | — | — |

**共性规律**:队列与 steering 是一对共生通道,成熟产品(Claude、Codex、Amp)都两个都做了,只是默认值相反;打断键统一是 Esc 系;**打断不等于销毁——要么保留已完成工作(Claude),要么回滚到检查点(Codex)**。WWriting 的「停止时进行中的写入保持完整」与前者同源。

### 6.3 上下文压缩策略

| 产品 | 自动压缩 | 手动压缩 | 特色机制 |
| --- | --- | --- | --- |
| Claude Code | auto-compact(阈值可配) | `/compact [保留指令]` | microcompact 专清工具结果;`/context` 占用可视化 |
| Codex CLI | auto-compaction(阈值 `model_auto_compact_token_limit`) | `/compact` | 压缩保留摘要+文件清单;记忆文件超限截断 |
| Gemini CLI | 自动压缩 | `/compress`(别名 summarize/compact) | /restore 可恢复到压缩前对话 |
| Aider | 无对话压缩 | — | repo map 常驻压缩代码上下文 |
| Amp | 无公开自动压缩(**未确认**) | — | handoff 新线程带上下文 |

**共性规律**:压缩都带「可附加指令」;压缩 ≠ 免费(要重读全部对话),`/clear` 才是零成本;压缩前后会话仍是同一个(session id 不变)。对小说写作的推论:**压缩时必须带上「故事连贯性约束」(人名/伏笔/时间线),这正是 WWriting 用章节摘要文件替代模型自报摘要的机会**。

### 6.4 记忆文件机制

| 产品 | 文件名 | 层级 | /init 类命令行为 | 惰性加载 |
| --- | --- | --- | --- | --- |
| Claude Code | CLAUDE.md(回退 AGENTS.md) | 企业 → 用户 → 项目 → local;@import 4 层 | 生成起始文件;**已存在则建议改进不覆盖**;可导入 Cursor/Copilot 规则 | 子目录 CLAUDE.md 读到才载;rules/*.md 按路径 frontmatter |
| Codex CLI | AGENTS.md | 最近者赢,逐级向上 | `/init` 生成;memories beta 可自动更新(需审批) | 无(每轮取最近一个文件) |
| Gemini CLI | GEMINI.md(可换名/换 AGENTS.md) | 全局 → 工作区及父目录 → JIT 子目录;全部拼接 | — | JIT:工具触到目录才载该目录记忆 |
| Aider | CONVENTIONS.md(显式 read) | 无层级 | — | 无;只读+prompt 缓存 |
| opencode | AGENTS.md(回退 CLAUDE.md) | 项目根 + 全局 | 生成/原地更新,不盲目替换 | glob 可列分目录文件 |
| Crush | AGENTS.md(默认)+ CRUSH.md | 项目 + 全局 | 初始化创建 | — |

**共性规律**:a) 文件名全面收敛到 AGENTS.md(Linux 基金会标准),旧名靠回退兼容; b) **三家 /init 全部承诺不盲目覆盖**——印证 WWriting「/init 谨慎更新、不生成固定蓝图」; c) 记忆膨胀是公认敌人(Claude 建议 ≤200 行、Codex 16KiB 截断); d) 「索引 + 按需展开」(Claude auto memory、Gemini JIT)是处理大体量项目知识的唯一可行解。

### 6.5 会话恢复

| 产品 | 存储 | 恢复方式 | 特色 |
| --- | --- | --- | --- |
| Claude Code | 本地,按目录组织 | `-r <id|name>`、`-c`、/resume | 命名会话、fork-session、checkpoint/rewind(代码+对话) |
| Codex CLI | 本地 | `codex resume` 选择器、`--last`、fork、apply | 轮级 checkpoint,Esc-Esc 回滚重答 |
| Gemini CLI | `~/.gemini/tmp/<hash>/chats/` | `--resume [n|uuid]`、Session Browser | 命名分支点 `/resume save`;30 天保留策略可配 |
| Aider | 无(依赖 git 历史) | — | auto-commit 兜底一切 |
| opencode | 本地 | /sessions、share 链接 | 会话可分享 |
| Amp | 云端 threads | `amp threads continue T-…` | 跨客户端续接、远端 orb 继续跑 |

**共性规律**:命名(便于语义检索)+ fork(试错隔离)+ 检查点(打断可回滚)是三个最高频特性;**保留期策略**只有 Gemini 做成显式配置——应用私有数据有生命周期管理,这与 WWriting「journal 不进创作文件夹」的数据边界意识一致。

### 6.6 MCP / 工具扩展

| 产品 | 扩展机制 | 权限联动 |
| --- | --- | --- |
| Claude Code | MCP + 自定义命令 + skills + plugins + hooks | `mcp__server__*` 进权限规则;工具可整体 deny 出上下文 |
| Codex CLI | `mcp_servers` 配置;prompts 目录;hooks beta | per-tool 审批;标记需交互的工具由 prompt-tool 代答有安全限制 |
| Gemini CLI | extensions 打包分发(含 MCP/OAuth) | per-tool always-allow |
| Aider | 无 MCP;靠 lint/test 命令 hook | — |
| opencode | MCP(本地/远程)+ agents + skills | MCP 工具进 permission 键空间 |
| Crush | MCP 三传输 + OAuth + LSP | `--disabled-tools` 按工具禁用 |
| Amp | 内置工具 + MCP + plugins | — |

**共性规律**:MCP 工具名(带 server 前缀)必须能进权限系统,否则第三方工具会绕过确认;「把整个 MCP server 拒之门外」(deny 掉从上下文移除)是省 token 与安全的双关设计。

---

## 7. 各产品小结:值得 WWriting 抄什么

### Claude Code
**抄**:① 权限规则「deny → ask → allow 先匹配先赢」的求值模型(极端操作做成最高优先级层);② 「记住选择」分级作用域(Bash 永久按仓库、文件修改仅会话);③ auto memory 的「索引文件 ≤200 行 + 主题文件按需读」结构。
**不抄**:① `bypassPermissions` 这种一键全跳模式(WWriting 用 YOLO 时必须保留极端操作闸);② 规则语法的过度复杂(*、:*、空格敏感、wrapper 剥离——对小说场景收益低)。

### Codex CLI
**抄**:① steering / 队列双通道的明确键位分工(对应 WWriting「立即」/「排队」);② 轮级 checkpoint + Esc-Esc 回滚重答;③ 记忆文件超限截断 + memories 更新需审批。
**不抄**:① approval_policy 与 sandbox_mode 二维矩阵的复杂度(小说场景不需要网络/文件系统正交);② `--yolo` 别名淡化危险感的命名。

### Gemini CLI
**抄**:① checkpoint 的「恢复后把原工具调用重新弹出让用户改参重发」;② `security.disableYoloMode` 式的 YOLO 硬禁开关;③ 会话保留期策略(30 天可配)。
**不抄**:① 「所有 GEMINI.md 拼接全量注入」(小说上下文大,必须惰性);② 文档频繁重构导致行为不稳定的教训。

### Aider
**抄**:① dirty-commits「动手前先把用户已有改动存好」的思路(对应 WWriting 停止时保持写入完整);② lint/test 闭环的「客观信号回流」(对应 count_text 字数复核);③ 只读文件显式标记(/read 进缓存不可改)。
**不抄**:① `--yes-always` 全局布尔(会埋掉极端操作确认);② 无会话恢复(git 兜底不适用于 journal 断点恢复场景)。

### opencode
**抄**:① `doom_loop` 哨兵(同参重复 3 次触发确认——长篇小说 Agent 循环生成时高发);② last-match-wins 的权限模式串;③ /init「原地改进不盲目替换」的表述与实现。
**不抄**:① 权限键过细(lsp/question/skill 都进权限面,小说 CLI 用不上)。

### Crush
**抄**:① deny = 从 Agent 上下文直接移除工具(省 token 又安全);② 默认全问的保守起点,用户逐步放行;③ 权限队列作为 workspace 共享状态(未来多端).
**不抄**:① `--yolo` 无分级的全跳过。

### Amp
**抄**:① steering 默认注入当前 step(如果实测「排队到轮尾」让用户等太久,可考虑把「立即」细化为「注入下一步」而非「全打断」);② threads 跨端续接(远期);③ handoff 带上下文开新线程(对应「换一卷重开会话」)。
**不抄**:① 权限默认过于自动化,与 WWriting 权限分级铁律冲突。

---

## 8. 对 WWriting CLI 的落地建议(直接印证与提醒)

### 8.1 权限分级:被印证的部分

- **「普通模式只读自动放行」与业界 default/plan 模式完全同源**,Claude Code 明确「工作目录内只读操作不提示」,Codex 的 read-only sandbox 同理。WWriting 的读章节/查大纲自动放行是行业共识,不是激进设计。
- **「写副作用先确认(一次/本条输入允许同类/拒绝)」与 Codex 的「一次批准/会话所有/永远/否决」同构**。WWriting 少了「永久」档——建议保留现状(刻意收紧),但可在 WWRITING.md 之外的**应用配置**(非创作文件夹)里给「本机白名单」留扩展位,对标 Claude 把命令白名单存 settings.local.json 的做法。
- **「同类授权仅对当前这条输入生效」比全部竞品严格**。业界最严的也只是「会话内有效」。这是安全卖点:小说场景里「允许改写本章结尾」这类授权一旦跨输入复用,极易被误用到下一章。代价是确认频率变高,建议用「同类操作聚合展示」(一张确认卡列清楚影响的文件范围)缓解,而不是放宽作用域。
- **「YOLO 永不跳过极端操作」**目前无竞品有此机制,但三个佐证支持其合理性:Claude 的 bypass 仍保留「少数任何模式都不自动放行的动作」;Codex 的危险类别不给「永远记住」选项;两家都有组织级 YOLO 硬禁开关。**实现建议:极端操作做成独立规则层,在模式判定之前求值**(对标 deny-first 求值顺序),任何模式/授权标记都无法越过;极端清单至少含:删除多章、覆盖 WWRITING.md、清空/回滚 journal、写入创作文件夹之外。
- **「输入精确确认文字」**为业界唯一,注意两点:确认文字必须是「本次动态生成」(如「删除第 12-18 章」)而非固定口令,防止复用旧授权文本;UI 上要防粘贴截断与全半角差异导致的假失败。

### 8.2 FIFO 队列与打断:被印证与需注意的部分

- **双通道是成熟形态**:Claude(FIFO 默认 + 强制提前)与 Codex/Amp(steering 默认 + 显式排队)殊途同归。WWriting「排队(默认)+ 立即(打断提升)」成立,且语义清晰。两点借鉴:① Claude 允许 **Up 键取回已排队消息编辑**——小说输入长(改稿意见动辄百字),这个防呆必须有;② 「立即」执行时要明确它对已排队项的次序影响(插队后原队首是否保持),Codex 的 `[Q]` 可视标记值得抄。
- **打断 ≠ 销毁**:Esc 保留已完成工作(Claude)、轮级 checkpoint 回滚(Codex)。WWriting 的「停止干净收敛、进行中写入保持完整」应落实为:**每个写副作用以文件为单位原子化**(整章写完才落盘/或写临时文件后原子改名),Journal 记录到「操作」粒度而非「轮」粒度,这样打断后的半成品状态可描述、可恢复。
- **注意 token 浪费**:steering 的价值在于避免整轮作废;WWriting 的「立即」打断一轮长写作会丢弃大量生成 token,Codex 的折中(下一步边界注入)可作为「立即」的温和变体选项(如「下段落注入」),但默认语义仍应是全打断,保证用户预期简单。

### 8.3 WWRITING.md 与记忆:直接可抄的结构

- **/init 行为已获三家背书**:生成起始文件;已存在则分析后建议改进、绝不盲目覆盖;可选择性导入外部规则(对标 Claude 导入 Cursor/Copilot)。WWriting 还应加一条竞品没有的:**/init 的写入本身走写副作用确认**(Codex memories 更新需审批是先例)。
- **层级设计建议**:用户级(写作偏好:人称/文风)→ 项目级 WWRITING.md(世界观/基调/硬约束)→ 卷/章级文件**惰性加载**(对标 Claude 子目录惰性 + Gemini JIT:Agent 读到某章才载入该章摘要与伏笔表)。不要学 Gemini 全量拼接——长篇小说的设定集体量必然超出窗口。
- **索引 + 按需展开**抄 Claude auto memory:WWRITING.md 只做索引(卷列表、人物卡指针、伏笔追踪指针),章节摘要/人物详情放独立文件按需读;单文件控制在 200 行内,超限拆分。
- **膨胀警告要写进 /init 的生成逻辑**:Claude 官方原话 "Bloated CLAUDE.md files cause Claude to ignore your actual instructions"——/init 生成的骨架宁小勿全,「不生成固定蓝图」正是防膨胀。

### 8.4 上下文与会话

- **压缩是长篇刚需**:建议提供 `/compact [指令]`(如「保留全部伏笔与人物关系」)+ auto-compact 阈值;压缩产物应落盘为「会话摘要文件」进 journal(应用私有区),而不是只留在上下文里,这样断点恢复时摘要可用。竞品都不落盘摘要,WWriting 可做出差异。
- **客观字数(Agent 不自报)**与 Aider lint 闭环、Claude 「给 Claude 一个可运行的检查」同源;进一步可把 count_text 结果作为 auto-compact/补写决策的输入信号。
- **会话恢复抄三点**:命名会话(`/rename`,按卷命名)、fork(试错版不污染原稿会话)、Gemini 式保留期策略(journal 自动清理可配)。

### 8.5 提醒(避免踩竞品踩过的坑)

1. **不要用文本匹配做安全边界**:文件路径规则之外,工具实现层必须做真实路径校验(对标 Claude 对 Bash 规则的免责声明)。
2. **不要发明第二个控制面**:所有竞品都是单一输入面 + 斜杠补全,权限卡/队列/状态行都是当前轮的临时 UI,不设常驻面板——与 WWriting 铁律 1/2 一致,坚守即可。
3. **状态行照抄输入结构**:statusline 的 stdin JSON(model、cost、context used_percentage)证明「进程外脚本 + 结构化输入」是可维护的做法,WWriting 实时行可预留同样接口。
4. **文档即契约**:竞品普遍因文档重构让老用户困惑;WWriting 的权限语义(模式/规则/极端清单)应写成随版本演进的规格文件,而不是散在 help 文本里。

---

## 附:来源清单(去重 23 个)

1. [Claude Code Permissions](https://code.claude.com/docs/en/permissions)
2. [Claude Code Settings](https://code.claude.com/docs/en/settings)
3. [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
4. [Claude Code Memory](https://code.claude.com/docs/en/memory)
5. [Claude Code Interactive Mode](https://code.claude.com/docs/en/interactive-mode)
6. [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)
7. [Claude Code Costs & Context](https://code.claude.com/docs/en/costs)
8. [Claude Code Status Line](https://code.claude.com/docs/en/statusline)
9. [Claude Code Sandboxing](https://code.claude.com/docs/en/sandboxing)
10. [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices)
11. [Codex CLI Features](https://developers.openai.com/codex/cli/features)
12. [Codex Permissions](https://developers.openai.com/codex/permissions)
13. [Codex Config Reference](https://developers.openai.com/codex/config-reference)
14. [AGENTS.md 标准](https://agents.md/)
15. [Gemini CLI Settings](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md)
16. [Gemini CLI Checkpointing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md)
17. [Gemini CLI GEMINI.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md)
18. [Gemini CLI Session Management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)
19. [Gemini CLI /compress 源码](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/commands/compressCommand.ts)
20. [Aider Options](https://aider.chat/docs/config/options.html)
21. [Aider Git](https://aider.chat/docs/git.html) / [Conventions](https://aider.chat/docs/usage/conventions.html)
22. [opencode Permissions](https://opencode.ai/docs/permissions/) / [Rules](https://opencode.ai/docs/rules/)
23. [Crush README](https://github.com/charmbracelet/crush) / [Amp Manual](https://ampcode.com/manual) / [Amp Threads](https://ampcode.com/docs/threads)
