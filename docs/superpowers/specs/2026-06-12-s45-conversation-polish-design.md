# S4.5「聊得爽」对话体验与界面打磨 spec

日期：2026-06-12
定位：插在 S4（已闭环）与 S5（发得出）之间的体验成熟化阶段。S3 把对话范式立起来了，S4.5 让对话**好用、可信、有写作工具的质感**。
来源：2026-06-12 头脑风暴（A1–A4 / B1–B3 / C2–C5 / D1–D2 全收，**用户明确剔除 C1 暗色主题**）。

## 1. 背景与代码取证

S3/S4 交付后的对话体验停在"功能正确"层面。以下事实全部经代码核实：

| # | 事实 | 位置 |
|---|------|------|
| F1 | 后端无 SSE/流式；前端 1.8s 轮询 `/api/dashboard` 聚合 | `src/app-shell/app.js:16,890` |
| F2 | 发消息后插静态"思考中..."占位，整个 agent 循环期间零反馈，结果一次性砸出 | `src/app-shell/composer.js:521-597` |
| F3 | **tool 消息在循环内逐条实时 append 到 `chat_history.jsonl`**；`/api/chat/history` 读历史**不取项目锁** | `src/core/chat/chat-agent.mjs:112`、`src/core/app-server.mjs:823-831` |
| F4 | `/api/chat/send`、`/api/chat/confirm` 在 `withProjectLock` 内同步跑完整循环才返回 | `src/core/app-server.mjs:777,802` |
| F5 | `modelClient.generate` 已接受外部 `signal` 并与超时合并（`AbortSignal.any`） | `src/core/model-client.mjs:55-82` |
| F6 | chat 循环无任何取消机制；写作 run 已有 `job.controller.abort()` 先例 | `src/core/chat/chat-agent.mjs`、`app-server.mjs:912-928` |
| F7 | assistant 文本渲染只支持段落/粗体/行内代码 | `src/app-shell/thread-renderer.js:832-842` |
| F8 | 工具卡渲染为 `工具 read_chapter ✓` + 折叠 `<pre>`（原始 JSON 截断） | `thread-renderer.js:884-905` |
| F9 | tool 消息只存 `tool/ok/result_summary`，**不存调用参数** | `chat-agent.mjs:112-115` |
| F10 | `parseAgentReply` 只取**第一个**围栏判定 tool call；第一个围栏若非 JSON 则整体当纯文本，后续围栏里的 tool call 会丢失 | `src/core/chat/agent-protocol.mjs:7-8` |
| F11 | 消息气泡无任何操作（复制/重试/引用） | `thread-renderer.js:844-905` |
| F12 | 阅读器排版讲究（Georgia/宋体衬线、1.95 行高、首字下沉、段首缩进），但无字号调节/翻章/沉浸；对话内的小说正文仍是 13.5px UI sans | `styles.css:1259-1267,1730-1743`、`app.js:749-781` |
| F13 | 空态建议卡固定 3 条硬编码 | `thread-renderer.js:39-61` |
| F14 | diff 确认卡只有行级 LCS | `src/app-shell/diff-view.js` |
| F15 | 工具共 17 个：read 6（get_status/read_chapter/search_text/read_continuity/read_outline/get_cost）、write 8（edit_chapter/rewrite_chapter/update_continuity/update_outline/queue_chapters/update_settings/export_book/archive_project）、control 3（start_run/pause_run/resolve_failure） | `src/core/chat/tools-*.mjs` |
| F16 | chat 历史响应形如 `{ ok, messages, pendingAction }`，无忙态字段 | `app-server.mjs:823-831` |

## 2. 目标与设计总则

1. **过程可见**：用户在 agent 循环期间能看到它在干什么，且随时能停。
2. **写作质感**：小说正文在对话里以文稿样貌出现，diff 以段落对照出现，字数增量可见。
3. **说人话**：工具活动、来源依据用写作者语言表达，技术细节收进展开层。
4. **交互以对话为先**（继承路线图 v3 原则）：所有新触点优先做成对话流内的行为。
5. **零新依赖**：不引第三方库；markdown、diff、映射表全部自写纯函数 + 单测。
6. **向后兼容**：`chat_history.jsonl` 旧记录必须照常渲染（新字段一律可选、缺失时降级）。

## 3. 分项设计

### A1+A2 · 过程流与可中断（最高优先级）

**机制**：复用 F3 事实——循环内 tool 消息实时落盘、history 端点不持锁。前端在 chat 忙时持续轮询 history，工具消息按既有去重指纹增量上屏，自然形成过程流。**不做 token 级 SSE**（model-client 是缓冲式，改造收益比不过轮询方案；列为后续阶段候选）。

**后端**：

1. `app-server.mjs` 新增内存注册表 `chatJobs: Map<resolvedProjectRoot, { controller: AbortController, startedAt: string }>`（仿 `runJobs`）。`serveChatSend` / `serveChatConfirm` 进入处理时注册，`finally` 中清除。
2. `/api/chat/history` 响应增加 `busy: boolean`、`busySince: string|null`（从 chatJobs 读取）。
3. 新端点 `POST /api/chat/stop`：取 `chatJobs.get(root)` 并 `controller.abort("用户停止")`；无忙时返回 409。
   **硬约束：此端点绝不进入 `withProjectLock`** —— send 正持有锁直到循环结束，stop 入锁即死锁到循环自然结束，按钮形同虚设。
4. `chat-agent.mjs`：`runChatTurn` / `resumeChatTurn` / `agentLoop` 接受 `signal`：
   - 每轮 round 开始与每次 `executeTool` 前检查 `signal.aborted`；
   - `modelClient.generate({ ..., signal })` 透传（F5 已支持，可掐断进行中的模型调用）；
   - 中断时 append 一条 assistant 消息 `（已停止。）` 并返回 `{ cancelled: true, ... }`；
   - **已开始执行的写工具不打断**（文件操作让它原子完成，abort 只在边界生效），保证不产生半写文件。
5. tool 消息补 `args` 字段（复用 `summarizeArgs` 截断 200 字符）——同时服务 D2。

**前端**（`composer.js` `sendChatMessageWithUX` + `app.js`）：

1. 发送后立即启动忙时轮询：`renderDashboard` 的 `ensureRefreshLoop` 条件并入 `data.chatHistory?.busy === true`。
2. "思考中"占位升级为活动占位：
   - 文案 = `思考中 · 已 N 秒`（1s 本地计时），当轮询带来新 tool 消息时占位上方即已增量出现人话工具行（D2 渲染），占位本身追加回显最近一条活动（如 `已读取第 3 章，继续思考…`）；
   - 占位右侧内嵌**停止**按钮 → `POST /api/chat/stop`；409 时按钮置灰并 toast；
   - send 的 await 返回仍是本轮权威结束信号：成功/失败/取消都按现有清理路径移除占位（轮询只是过程补充，不改变结束语义）。
3. 渲染竞态兜底：增量上屏全部走 `syncChatThread` 既有指纹去重，不新加直插路径。

### A3 · Markdown 渲染补全

新建 `src/app-shell/markdown-lite.js`，导出纯函数 `renderMarkdown(text): string`（HTML 字符串）：

- 支持：段落、`**粗体**`、`` `行内代码` ``、`## / ###` 标题（降级渲染为 `<h4>/<h5>`）、`- ` 无序列表、`1. ` 有序列表、`> ` 引用、`---` 分隔线、``` 普通围栏（`<pre><code>`）、```稿 文稿块（见 B1）。
- 安全顺序不变：**先整体 escape 再做结构转换**（沿用 F7 现实现的防注入顺序）。
- 解析失败/不识别的结构按纯文本段落回退，绝不抛错。
- `thread-renderer.js` 的 `renderAssistantText` 改为委托此模块；旧事件流的 `agent-say` 保持纯文本不动。

### B1 · 文稿块（产品身份）

1. **协议约定**：`agent-protocol.mjs` `buildSystemPrompt` 增加一条——"输出小说正文、草稿或改写片段时，用 \```稿 围栏包裹正文，正文外的说明放围栏外"。
2. **解析器加固**（修 F10）：`parseAgentReply` 从"只看第一个围栏"改为**扫描全部围栏，取第一个能 `JSON.parse` 且含 `tool_calls` 的**作为工具调用；其余围栏原样保留在文本中。无任何围栏可解析时整体按文本处理（现有行为）。既有单围栏用例行为不变，须有回归测试。
3. **渲染**：markdown-lite 把 ```稿 围栏渲染为 `<div class="manuscript-block">`：衬线（与 `.reader-body` 同 `Georgia/Songti SC` 栈）、15.5px、行高 1.95、段首缩进 2em、底部右对齐小字号字数标（`N 字`）。
4. **确认卡正文同质感**：`edit_chapter` 之外的 preview before/after 文本块、以及 B2 段落对照中的正文，统一套衬线正文样式。

### B2 · Diff 确认卡文学化

1. `diff-view.js` 新增纯函数 `diffParagraphs(before, after)`：按 `\n{2,}` 分段后做段级 LCS，返回 `{ type: "keep"|"del"|"add", text }[]`。
2. 新增 `summarizeDiff(rows)`：返回 `{ changedParagraphs, addedChars, removedChars }`。
3. 确认卡（`renderConfirmCard`）对 `edit_chapter`：
   - 默认**段落视图**：变更段渲染为前/后对照（删除段浅红、新增段浅绿，正文用衬线），连续未变段折叠为一行 `…未改动的 N 段…`；
   - 顶部摘要行：`改动 N 段 · −X 字 / +Y 字`；
   - 提供「行级详细」切换，切回现有 `renderDiff` 行级视图；
   - 两个视图按钮均有 `data-testid` 供探针。

### B3 · 字数仪表（会话新增字数）

- `composer.js` 维护 per-project 会话基线：首次拿到某项目 dashboard 时记 `sessionBaseline = summary.totalWords`（内存 Map，切项目/重启即重置——会话语义，不持久化）。
- status pills 区新增 `本次 +N 字` pill：`N = totalWords - sessionBaseline`，`N <= 0` 时隐藏。数据全来自现有 dashboard，零后端改动。

### C2 · 空态建议情境化

- 新建纯函数 `deriveSuggestions(data): {label, message}[]`（放 `thread-renderer.js` 或独立模块，可单测），按优先级取前 3 条：
  1. 已归档 → `导出成书` / `解除归档`
  2. 有 needs_revision 章节 → `处理待修订章节`
  3. 全部目标完成 → `导出成书` / `提高目标章节数再续写`
  4. 写作中段（completedChapters ≥ 1）→ `续写下一章（第 N 章）` / `回顾上一章结尾` / `目前花了多少钱`
  5. 新项目（无完成章节）→ `排 5 章试写` / `这本书的设定是什么？` / `帮我完善大纲`
- `buildSuggestionCards` 改为消费该函数；显示时机不变（有项目且 chat 历史为空）。

### C3 · 快捷键速查浮层

- 触发：`?`（Shift+/，且焦点不在 input/textarea）或 composer 栏新增 `⌨` 小按钮。
- 内容：Enter 发送 / Shift+Enter 换行 / `/` 斜杠命令 / Ctrl+. 隐私模式 / Esc 关闭浮层 / 阅读器 ←→ 翻章（C5）/ `?` 本浮层。
- 实现复用既有 scrim+卡片+focus trap+Esc 模式（同 settings/create 弹窗），Esc 关闭链最前判断。
- **不做 Ctrl+K 命令面板**（与 slash 菜单功能重复，YAGNI）。

### C4 · Toast 降噪

原则：**UI 内已可见的状态变化不再弹成功 toast**。逐调用点处理（机制不动）：

| 调用点 | 现状 | 改为 |
|--------|------|------|
| `applyTier` 切换权限档 | toast 成功 | 不弹（mode pill 本身已变 + 短动效） |
| `openProject` 打开小说 | toast 成功 | 不弹（标题/对话流已切换） |
| `setPrivacyMode` | toast 提示 | 不弹（按钮态+模糊效果即时可见）；首次开启保留一次说明 |
| `cancelQueuedTask` | toast 成功 | 不弹（任务卡状态即时刷新） |
| 错误类 toast | — | 全部保留 |
| 结果不在视野内的成功（导出路径、归档完成等） | — | 保留 |

### C5 · 阅读器升级

1. **字号档位**：reader-head 增加 `A−`/`A+`，四档（14 / 15.5（默认）/ 17 / 19px），行高随档位映射（1.9 / 1.95 / 2.0 / 2.0），持久化 `localStorage("ww:reader:fontsize")`。
2. **翻章**：reader-head 增加 `‹ 上一章`/`下一章 ›`，绑定 ←/→ 键（仅 reader 打开时）；可读章节序列取自 `lastDashboard.chapters` 中 `actual_words > 0` 的章；边界禁用。
3. **沉浸模式**：「沉浸」toggle 切换 `reader--wide` class（宽度 720px → `min(96vw, 1100px)`，隐藏 path/meta 行）；Esc 行为不变。

### D1 · 回答溯源 chips

- 前端纯函数 `deriveSources(messages, assistantMessage)`：取该 assistant 消息**之前、最近一条 user 消息之后**的 `ok === true` 的 read 类 tool 消息，映射为 chips（按工具去重）：
  - `read_chapter` → `第 N 章`（N 取自 tool 消息 `args`），**可点击** → `openReader(N)`；
  - `read_continuity` → `设定记忆`；`read_outline` → `大纲`；`search_text` → `全文搜索`；`get_status` → `项目状态`；`get_cost` → `成本台账`（以上不可点，hover 显示 result 摘要）。
- 渲染于 assistant 气泡底部：`依据 · 第 3 章 · 设定记忆`。无来源时整行不渲染。
- 旧历史 tool 消息无 `args` → `read_chapter` chip 显示为不可点的 `章节`。

### D2 · 工具卡人话化

- 新建 `src/app-shell/tool-labels.mjs`：17 个工具（F15 全量）→ `{ label(args, result), runningLabel(args), icon }` 映射，例如：
  - `read_chapter` → `读取了第 {args.chapter} 章`；`search_text` → `搜索「{args.query}」`；`edit_chapter` → `修改第 {args.chapter} 章`；`start_run` → `启动写作任务`；`export_book` → `导出成书`；未知工具回退 `工具 {name}`。
- `renderToolCard` 改造：summary 行 = `icon + 人话 + ✓/✗`；技术名、args 摘要、原始 result JSON 全部收进 `<details>` 展开区；失败时错误信息保持现有展示。
- 依赖 A1-后端第 5 条的 `args` 字段；缺失时回退现有渲染。

### A4 · 消息操作

1. **气泡操作排**（hover/focus 显现，不占常驻空间）：
   - assistant / user / 稿块：`复制`（`navigator.clipboard.writeText`，失败 toast）；
   - user 气泡：`重新发送`；
   - 最后一条 assistant：`重试本轮` = 找到其前最近一条 user 消息内容重发；
   - 重发/重试统一走 `sendChatMessageWithUX`，busy 时按钮禁用（依赖 A1 的 busy 状态）。
2. **阅读器选段引用**：`reader-body` `mouseup` 后若有非空选区，在选区附近浮出「问智能体」按钮；点击 → 关闭 reader → composer 预填：
   ```
   关于第 N 章这段：
   > {选中文本，截断 500 字}
   ```
   并聚焦输入框。选区清空/再点击空白则按钮消失。

## 4. 后端接口变更汇总

| 变更 | 类型 | 兼容性 |
|------|------|--------|
| `/api/chat/history` 响应 + `busy`/`busySince` | 扩展 | 纯增量 |
| `POST /api/chat/stop` 新端点（**锁外执行**） | 新增 | — |
| `agentLoop`/`runChatTurn`/`resumeChatTurn` 接受 `signal`，中断落「已停止」消息并返回 `cancelled: true` | 扩展 | 不传 signal 时行为不变 |
| tool 消息追加 `args`（截断 200 字符） | 扩展 | 旧记录无此字段，前端降级 |
| `buildSystemPrompt` 增加稿块约定 | 扩展 | — |
| `parseAgentReply` 多围栏扫描 | **行为变化** | 单围栏用例须回归通过 |

无存储迁移：`chat_history.jsonl` 与 `chat_pending_action.json` 结构仅做可选字段增量。

## 5. 错误处理

- `/api/chat/stop`：无忙循环 → 409 `CONFLICT`；前端按钮置灰 + 轻提示。
- abort 时序：模型调用被掐断 → AbortError 在 `agentLoop` 捕获 → 落「已停止」→ send 响应 `{ ok: true, cancelled: true }`（不是 500）。
- 忙时轮询请求失败：静默忽略（现有 catch 模式），下一拍重试。
- 稿块围栏未闭合：按普通文本渲染。
- clipboard 失败（权限/环境）：toast 错误，不抛。
- 翻章越界：按钮禁用，键盘事件忽略。
- 旧历史缺 `args`：工具卡/溯源 chips 按降级路径渲染，不报错。

## 6. 测试与防线

**单元测试**（`node --test`，新增文件入 `tests/` 与 `tests/app-shell/`）：

- `markdown-lite`：标题/列表/引用/分隔线/围栏/稿块/转义注入/未闭合围栏回退。
- `agent-protocol`：多围栏扫描（稿块在前+tool call 在后不丢调用）、单围栏回归、纯文本回归。
- `chat-agent`：fake modelClient + signal——轮间中断、模型调用中中断、写工具执行中不打断、「已停止」消息落盘、`cancelled: true` 返回。
- `diff-view`：`diffParagraphs` 段级语义、`summarizeDiff` 字数统计。
- `tool-labels`：17 工具全覆盖 + 未知工具回退。
- `deriveSuggestions`：5 类项目状态各返回正确建议组。
- `deriveSources`：消息窗口边界（上一 user 之后）、read-only 过滤、去重、无 args 降级。
- HTTP 级：`/api/chat/history` busy 字段、`/api/chat/stop` 忙/非忙两态（慢速 fake model 制造忙窗口）。

**clickability 探针扩展**（`scripts/verify-app-clickability.cjs`，项目铁律）：

- 消息操作按钮（复制/重发）、确认卡段落/行级切换、阅读器 A−/A+/上一章/下一章/沉浸、快捷键浮层开与关（`?` 与 ⌨ 按钮）、过程流停止按钮存在性、建议卡（既有探针沿用）。

**防线命令**（UI/Electron 改动后必跑，继承 CLAUDE.md）：

```powershell
npm test
npm run verify:app-shell
npm run verify:app-clickability
npm run verify:desktop-shell
```

交付桌面前：`npm run verify:local`。

**真实 API 短跑**：`verify:chat-online` 增加场景 F（发送期间轮询 history 断言 `busy: true` 且 tool 消息增量出现；停止后断言「已停止」消息）。无 key 时如实标注待跑（沿 S4 惯例）。

## 7. 明确不做

- token 级 SSE / 流式输出（候选后续阶段，本期轮询过程流覆盖主要价值）
- 暗色主题（用户剔除）
- Ctrl+K 命令面板（与 slash 菜单重复）
- 阅读器内直接编辑正文、独立行距调节
- 消息编辑/对话分支回溯（路线图 v3 明确不做）
- 移动端/窄屏专项适配（维持现有折叠逻辑）

## 8. 验收清单

1. 发送消息后 ≤2s 进入忙态展示；agent 每执行一个工具，对话流在下一拍轮询内出现对应人话工具行；占位显示已耗时与最新活动。
2. 占位上的停止按钮可终止循环：进行中的模型调用被掐断，对话流落「（已停止。）」，send 响应 `cancelled: true`，UI 恢复可输入。
3. assistant 消息的列表/标题/引用/分隔线正确渲染；注入文本（`<script>` 等）始终被转义。
4. 含 ```稿 围栏的回复以衬线文稿块渲染并显示字数标；稿块+工具调用混排时调用不丢失。
5. `edit_chapter` 确认卡默认段落对照视图 + `改动 N 段 · −X/+Y 字` 摘要行，可切换行级视图。
6. 工具卡显示人话标签（17 工具全映射），原始 JSON 在展开区；旧历史（无 args）不报错。
7. assistant 回答下方出现来源 chips；点击章节 chip 打开阅读器对应章。
8. 任意气泡可复制；user 气泡可重发；最后一条 assistant 可重试本轮；busy 期间操作禁用。
9. 阅读器内选中正文出现「问智能体」，点击后 composer 预填引用并聚焦。
10. status pills 出现 `本次 +N 字`（写入新内容后增长；新会话归零隐藏）。
11. 空态建议卡随 5 类项目状态变化（至少验证新项目/写作中/已归档三态）。
12. `?` 与 ⌨ 按钮均能打开快捷键速查，Esc 关闭。
13. C4 表中 4 个成功 toast 不再弹出；错误 toast 全部保留。
14. 阅读器字号四档调节并在重启后保持；←/→ 翻章；沉浸模式切换生效。
15. `npm test` 全绿；`verify:app-shell`、`verify:app-clickability`（含新增探针）`ok: true`。

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| `/api/chat/stop` 误入项目锁导致死锁 | spec 红线 + HTTP 测试用慢速 fake model 验证忙时 stop 立即生效 |
| `parseAgentReply` 行为变化回归 | 保留全部既有用例 + 新增多围栏用例；解析失败路径始终回退纯文本 |
| 轮询增量与 send 返回的竞态产生重复气泡 | 全部上屏走 `syncChatThread` 指纹去重；禁止新增直插路径 |
| 忙时轮询拉满 1.8s 间隔造成请求堆积 | 轮询仅 GET history+dashboard（现有节奏不变）；busy 期间不额外加密度 |
| 写工具执行中 abort 产生半写文件 | abort 只在循环边界与模型调用处生效，运行中的 `executeTool` 不打断 |
| clipboard 在 Electron file:// 环境失败 | 探针覆盖 + 失败 toast 降级路径 |
