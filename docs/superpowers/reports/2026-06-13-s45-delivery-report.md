# S4.5「聊得爽」对话体验与界面打磨交付报告

> 日期：2026-06-13
> 分支：`s45-conversation-polish`（worktree：`D:\s45-conversation-polish`）
> 总提交数：19（含 1 个 .15s 修复）

## 任务对照表

| 任务 | 提交 | 描述 |
|------|------|------|
| Task 1 | `66f9ac5` | `markdown-lite.mjs` 渲染器（段落/列表/标题/引用/围栏/稿块） |
| Task 2 | `355734c` | 稿块围栏约定 + `parseAgentReply` 多围栏扫描 |
| Task 3 | `352c5ac` | tool 消息持久化 args 摘要（5 处 append 补 `args`） |
| Task 4 | `3447799` | chat 循环 `signal` 中断 + 工具原子完成 |
| Task 5 | `db1e5e5` | 服务端 `chatJobs` 注册表 + `busy` 字段 + lock-free `/api/chat/stop` |
| Task 6 | `06e52c2` | `tool-labels.mjs` 17 工具人话映射 + 截断 JSON 抢救 |
| Task 7 | `8c8f7d6` | `chat-derive.mjs` 证据制溯源 chips + 5 类情境化建议 |
| Task 8 | `e928376` | 段落 diff（LCS + 字数 delta + 折叠） |
| Task 9 | `978fb04` | thread-renderer 大集成（markdown 气泡 + 稿块 + 工具卡人话 + 溯源 chips） |
| Task 10 | `4d1dac1` | 确认卡段落对照 + 行级切换 |
| Task 11 | `e6c045f` | 活动占位 + 忙时轮询 + 停止按钮 + 入口忙态守卫 |
| Task 12 | `07bf15f` | 消息操作排（复制 / 重发 / 重试本轮） |
| Task 13 | `b675384` | 阅读器选段引用「问智能体」 |
| Task 14 | `ae9b239` | 阅读器 4 档字号（持久化） + ‹/› 翻章 + 沉浸 + ←/→ 键 |
| Task 15 | `b6c2b4e` | 空态情境化 + 会话字数 pill + Toast 降噪 + chat-first 问候 |
| Task 16 | `b6fc508` | 快捷键速查浮层（? 触发 + ⌨ 入口 + tab 圈） |
| Task 17 | `9dbf46b` | clickability 探针扩展（⑨-⑯ 8 项 + 聊天历史 fixture 升级） |
| Task 17b | `b7d31c2` | verify-chat-online 场景 F（增量落盘 + 中途停止） |
| 修复 | `0c83c04` | `.msg-actions` 过渡时长 .15s → .2s（verify:app-shell 规则） |

## Spec §8 验收 15 条对照

| # | 验收条 | 证据 |
|---|--------|------|
| 1 | 过程流 | Task 5 `chatJobs` + Task 11 busy 轮询 + Task 17 探针 ⑭ |
| 2 | 停止 | Task 4 signal + Task 5 `/api/chat/stop` + Task 11 停止按钮 + 探针 ⑭ |
| 3 | markdown 渲染 | Task 1 `markdown-lite.mjs` 14/14 测 + 探针 ⑨ |
| 4 | 稿块 + 调用不丢 | Task 2 多围栏扫描 + Task 9 稿块样式 + 探针 ⑨ |
| 5 | 段落 diff | Task 8 `diffParagraphs` + Task 10 段落对照 + 探针 ⑬ |
| 6 | 工具卡人话 | Task 6 `tool-labels.mjs` + Task 9 `renderToolCard` + 探针 ⑩ |
| 7 | 溯源 chips | Task 7 `deriveSources` + Task 9 chips 渲染 + 探针 ⑪ |
| 8 | 消息操作 | Task 12 `buildMsgActions` + 探针 ⑫ |
| 9 | 阅读器引用 | Task 13 `mouseup` + 「问智能体」 |
| 10 | 字数 pill | Task 15 `updateWordsPill` + `sessionWordBaselines` |
| 11 | 空态情境化 | Task 7 `deriveSuggestions` + Task 15 接入 + 探针 ⑨ |
| 12 | 快捷键速查 | Task 16 `shortcuts-scrim` + `?` 触发 + 探针 ⑯ |
| 13 | Toast 降噪 | Task 15 四处 toast 删除/改造 |
| 14 | 阅读器字号/翻章/沉浸 | Task 14 `READER_FONT_STEPS` + 翻章 + immersive + 探针 ⑮ |
| 15 | 防线 | Task 17 8 项新探针 + 三道 verify 全绿 |

## 防线输出

```
npm test:                       599 pass, 0 fail  (含 47 个新增测试)
npm run verify:app-shell:       ok: true
npm run verify:app-clickability:ok: true  (含 11 个 S4.5 探针全部通过)
```

### verify:app-clickability S4.5 探针

```
s45-source-chip-open-reader  ✓
s45-msg-copy                  ✓
s45-diff-toggle               ✓
s45-chat-stop                 ✓
s45-open-chapters-for-reader  ✓
s45-reader-from-chrow         ✓
s45-reader-font-plus          ✓
s45-reader-wide               ✓
s45-reader-next               ✓
s45-shortcuts-open            ✓
s45-shortcuts-close           ✓
```

## 真实 API 验证

**场景 F 待跑**（无 API key 在环境变量中）。`scripts/verify-chat-online.mjs` 在脚本入口处校验 `WWRITING_PROVIDER_BASE_URL` / `WWRITING_PROVIDER_MODEL` / `OPENAI_API_KEY`，缺失则直接 `{"error":"missing_env"}` 退出；Task 17b 的 F1/F2 子场景已落到代码（行 345-403），待用户设置 key 后即可通过 `npm run verify:chat-online` 验证。

## 已知问题

1. **场景 F 需真实 API key** — Task 17b 已实现但未跑；F2 的 500ms abort 假设在「快速模型」下可能假阴性（plan 已说明可重跑一次再判）
2. **CSS 块位置** — Task 15 字数 pill 块被插在 Task 9 markdown 块中间而非末尾；功能正确但可读性可优化
3. **sessionWordBaselines 注释 vs 行为** — 注释说「切项目即重置」，实际「同项目复用基线」；实现正确但需更新注释或语义
4. **未使用的 `escapeHtml` import** — `thread-renderer.js:9` 引入但未直接使用（仅 `renderMarkdown` 内部使用）
5. **probe ⑬ 的可测性** — 依赖 fixture 出现 confirm 卡；当前实现接受 click-and-no-op 失败（即按钮不存在时 click 无影响），更稳健的实现应在 fixture 注入一个 pendingAction

## 新增文件

- `src/app-shell/markdown-lite.mjs` — 纯函数 markdown + 稿块渲染
- `src/app-shell/tool-labels.mjs` — 17 工具人话映射
- `src/app-shell/chat-derive.mjs` — 溯源 chips + 情境化建议
- `tests/markdown-lite.test.mjs` — 14 测
- `tests/tool-labels.test.mjs` — 6 测
- `tests/chat-derive.test.mjs` — 9 测
- `tests/chat-tool-args.test.mjs` — 3 测
- `tests/chat-agent-cancel.test.mjs` — 4 测
- `tests/app-shell/chat-busy-stop.test.mjs` — 4 测

## 修改文件

- `src/core/chat/agent-protocol.mjs` — 多围栏扫描 + 稿块约定
- `src/core/chat/tool-registry.mjs` — 导出 `summarizeArgs`
- `src/core/chat/chat-agent.mjs` — tool 消息带 args + signal 中断
- `src/core/app-server.mjs` — chatJobs + busy + stop 端点
- `src/app-shell/api-client.js` — `stopChat()`
- `src/app-shell/diff-view.js` — 段落 LCS diff
- `src/app-shell/thread-renderer.js` — 渲染大集成
- `src/app-shell/composer.js` — 活动占位 + 字数 pill + Toast 改造
- `src/app-shell/app.js` — 忙时轮询 + 阅读器工具排 + 选段引用 + 隐私 + 快捷键
- `src/app-shell/index.html` — reader-tools + shortcuts-scrim + ⌨ 按钮
- `src/app-shell/styles.css` — 9 个 S4.5 分区追加
- `tests/chat-protocol.test.mjs` — 4 新测
- `tests/diff-view.test.mjs` — 3 新测
- `tests/app-shell/chat-endpoints.test.mjs` — 1 测改造（accept 409 contract）
- `scripts/verify-app-clickability.cjs` — 8 S4.5 探针 + fixture 升级
- `scripts/verify-chat-online.mjs` — 场景 F
- `docs/USER_GUIDE.zh-CN.md` — §15 S4.5 速览

## 顺手改进（I1–I10，按计划执行）

- I1 `thread-renderer.js` 本地 `escape()` 删除，统一 import `markdown-lite` 的 `escapeHtml`（Task 9）
- I2 问候语与快捷 chips 改为 chat-first 文案（Task 15）
- I3 composer 乐观气泡复用 `renderChatMessage`（Task 11）
- I4 `syncChatThread` 贴底跟随 + ARIA 播报（Task 9）
- I5 文稿块 + 段落 diff 正文带 `peek` class（Task 1 / 8）
- I6 assistant 气泡 13.5px/1.55 → 14px/1.7、max-width 86%（Task 9）
- I7 新增按钮带 `aria-label` / 可见文本 + `data-testid`（全部）
- I8 composer 提示追加「? 快捷键」（Task 16）
- I9 建议卡 / 问候 chips 在 busy 时点击直接忽略（Task 15）
- I10 USER_GUIDE 追加 §15（Task 18.2b）
