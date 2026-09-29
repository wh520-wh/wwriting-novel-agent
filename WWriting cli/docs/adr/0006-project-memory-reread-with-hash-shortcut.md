# 项目记忆每轮重读，用内容哈希短路缓存失效

`WWRITING.md` 在**每一轮**开工前读一次。读出内容后算哈希，与上一轮注入的相同就
**复用那条一模一样的注入消息**（字节级一致），只有内容真的变了才重新注入。

**Context**：DeepSeek 的上下文缓存是**自动开启**的，按「前缀完全匹配」命中——
官方文档原文：*A subsequent request can hit the cache if it fully matches them*。
`WWRITING.md` 的注入位置在 system 之后、历史之前，所以**它变一个字符，后面整段历史
的前缀全部失效**。而 `/init` 干的就是改它。

**Considered Options**

- **读一次固化在对话里**（grokbuild 的做法，理由原文：*once placed, never replaced
  (would bust the KV-cache prefix)*）：前缀最稳，但 `/init` 写完同一会话不生效——自相矛盾。
- **会话开头注入 + 变更后事件刷新**：每次刷新都主动制造一次全量前缀失效，最贵。
- **每轮重读 + 内容哈希短路**（选中）：内容没变就不动消息（缓存照旧命中），
  内容变了才付一次前缀失效——而这个代价本来就该付。

**Consequences**

- 记忆永不过期：用户手工编辑 `WWRITING.md` 后，下一轮自动生效，不需要任何「刷新」命令。
- 判据是**内容**而不是事件。按事件触发（「刚 /init 过所以刷新」）会在内容其实没变时
  误判刷新，白丢一次缓存。
- `usage` 里要收下 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
  （DeepSeek 返回，当前客户端丢弃了）。它既是给用户看的省钱事实，也是验证本决策
  是否真的保住缓存的观测手段。
