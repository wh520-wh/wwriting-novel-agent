# 会话状态以事件日志为唯一真相源

每个会话的状态（当前轮、队列、权限授权、已写正文）都存在
`%APPDATA%\WWriting\workspaces\<id>\sessions\<sid>\events.jsonl` 里。`state.json` 只是
可随时重建的投影缓存——删掉它不丢任何东西。进程重启后 `--continue` 能恢复会话、
回放历史、接着消费队列，全部依赖这一条。

**Considered Options**

- **直接序列化状态快照**（写 `state.json` 当真相）：实现更简单，但恢复语义会变得不可定义——
  写到一半崩溃时，快照要么落后要么半截，无法判断「用户说过的那句话到底算不算数」。
- **事件日志 + 投影缓存**（选中）：追加是原子的、顺序有保证，且崩溃点天然可判定。

**Consequences**

- 新增能力通常是「新增事件类型」而不是「改 schema」。`applyEvent` 的 `default` 分支已经
  明确「未知事件类型只推进 `updated_at` / `last_seq`」，就是为这类扩展留的口子；因此
  **加事件类型不需要升 `EVENT_SCHEMA_VERSION`**。
- 任何「读回来看看」的功能都不该另建一份存储。历史回放就是照这条做的：它完全派生于
  `events.jsonl`，没有第二份对话记录。
- 日志与 `messages` 目前都无界增长，这是本决策已知的代价（见 `docs/superpowers/plans/`
  里的 deferred 清单），不是疏忽。
