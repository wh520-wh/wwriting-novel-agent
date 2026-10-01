# 技能目录块只注入摘要进 system 消息，正文经 read_skill 渐进读取

12 个内置技能包全量常驻 system prompt 会浪费上下文且多数不适用。决定照搬上游
做法：system 消息里只注入 `[Available Skills]` 摘要块——每技能一行
`- [基座|修饰|流派] name: description`（无分类不带标签），外加一段分层选型
规则（基座恰选一、修饰 0–3、流派按题材；选型结果写入 WWRITING.md 写作风格区，
全文分层经 read_skill 读取）；SKILL.md 正文绝不进 system prompt。

**Considered Options**

- **全量注入正文**：实现最简，但一次写作通常只用到 2–4 个包，其余全是上下文
  噪声；且上游已把「摘要 + 渐进读取」定为文案与工具契约，照搬即对齐。
- **摘要块进独立的合成消息**（与 ADR-0008 的项目记忆同形）：被否——项目记忆
  之所以独立成消息，是要参与历史预算与回放排除（它是用户可变的项目内容）；
  技能清单是应用控制的有界元数据（每技能一行摘要），与 BASE_SYSTEM_PROMPT
  同层、不参与预算，塞进消息反而制造第二种合成消息。
- **摘要块拼在 system 消息末尾（选中）**。已知偏差：上游层序把 Available
  Skills 放在 Task Policy 之前，CLI 的政策文本长在 BASE_SYSTEM_PROMPT 内部，
  不为插队拆常量，块拼在 `PROJECT_MEMORY_PROMPT` 之后（system 末尾）。

**Consequences**

- `read_skill` 成为新的下划线工具：只读、自动放行（与上游一致，按项目只读
  分级）；按 active 清单解析名字，被覆盖副本不可读；路径安全规则照抄上游
  （realpath 不可逃逸技能目录、SKILL.md ≤512KiB、其他资源 ≤1MiB、二进制
  asset 不进上下文，只报路径与字节数）。
- 清单按 runId 缓存、读取失败返空数组不阻塞（照抄上游 runtime 语义）：会话
  中途增删技能目录，下一轮输入生效。
- 模型行为从此依赖这套 prompt 契约；改块格式或选型规则文案属于改契约，需要
  连带评估 WWRITING.md 写作风格区的读写两侧。
