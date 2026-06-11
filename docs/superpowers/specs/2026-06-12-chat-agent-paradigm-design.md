# 对话范式设计：WWriting Chat Agent

日期：2026-06-12
状态：设计九节已与用户逐项确认（能力档位：全能协作者；实现路径：方案 A 一步到位；顺序：记忆先行 → 对话范式 → 门禁对话化）
关联：`2026-06-12-s2-memory-and-quality-gates-design.md`（S2a 记忆链路部分继续有效；门禁呈现层由本设计接管）、`2026-06-12-software-maturity-roadmap-v3-design.md`（路线图修订）

## 1. 问题与定位

用户反馈（2026-06-12，原话大意）："现在的 UX 不符合 agent 常用逻辑，我跟 AI 聊不了天，说什么它都只是麻木地执行写文章，没有像 Claude Code 那样根据聊天内容执行计划和操作的感觉。"

代码取证证实这不是体感偏差：

- 用户输入只有两条正则在"理解"（`task-queue.mjs` `expandInstruction`：「写到第N章」「写N章」），其余原样入队；
- `/ask` 旁路（`side-question.mjs`）能对话但被铁律锁死为只读分析——有嘴没手；
- 引擎是固定状态机流水线，对用户语言没有意图理解、没有计划制定、没有工具选择。

**定位转变：对话成为主界面，流水线降级为 agent 的一个工具。** 用户说话 → agent 理解 → 调工具（查/改/指挥）→ 汇报，即 Claude Code 的 agent loop 范式。

## 2. 架构总览

```
┌─ app-shell (UI) ─────────────────────────────┐
│ 对话线程（用户气泡/agent气泡/工具卡/确认卡/系统事件行） │
│ composer（对话输入，/命令保留为快捷方式）          │
└──────────────┬───────────────────────────────┘
               │ POST /api/chat/send (SSE)
               │ POST /api/chat/confirm
               │ GET  /api/chat/history
┌──────────────▼───────────────────────────────┐
│ chat-agent.mjs（新：agent loop 核心）           │
│  上下文组装 ←─ book_summary + continuity(S2a)  │
│  模型调用 ←─ ModelClient(stage="chat")         │
│  工具协议解析 → tool-registry.mjs（新）          │
│  pending_action 确认机制                       │
└──────┬──────────────┬────────────────────────┘
       │ 读类直接执行     │ 写类经确认
┌──────▼──────────────▼────────────────────────┐
│ 工具实现层（15 个工具，复用既有模块）：             │
│ project-store / app-dashboard / task-queue /  │
│ settings-runtime / failure-actions / 引擎控制   │
└───────────────────────────────────────────────┘
```

## 3. Agent loop（`src/core/chat-agent.mjs`）

每轮处理流程：

1. **上下文组装**：系统提示（角色 + 工具说明）+ 项目状态摘要（get_status 同源数据）+ `book_summary.md` + `continuity.md` 摘要 + 对话历史（最近 20 轮全文，更早压缩为摘要块）+ 本轮用户消息。
2. **模型调用**：`ModelClient.complete(stage="chat")`——复用重试、超时、成本归因、预算熔断全部既有设施。
3. **输出解析**（见 §4 协议）：纯文本 → 本轮结束，回复用户；工具调用 → 进入工具轮。
4. **工具轮**：读类/轻确认控制类立即执行；写类落盘 `pending_action` 并暂停 loop 等用户确认。工具结果（成功/失败/拒绝原因）以 tool 消息回填上下文，回到步骤 2。
5. **护栏**：`maxToolRounds = 8`（超限强制收口为文本回复并说明）；单个工具结果注入上下文前截断至 8000 字符；模型调用受既有 `max_cost`/`max_total_tokens` 熔断约束。

**确认是异步且持久的**：`pending_action` 落盘 `chat_pending_action.json`，应用重启后确认卡仍在。v1 简化：同一时刻最多一个 pending_action（新写操作在前一个未决时被拒绝并提示）。

## 4. 工具协议（provider 无关 JSON，不用原生 function calling）

**决策**：MiMo/DeepSeek 等 OpenAI 兼容端点的原生 tool calling 支持度参差，v1 用纯文本 JSON 协议——统一、可日志、可回放、便于 mock 测试。原生 function calling 列为候补优化。

**模型输出约定**（系统提示中规定）：

- 纯回复：直接输出文本。
- 调用工具：输出仅含一个 JSON 围栏块：

```json
{"tool_calls": [{"tool": "read_chapter", "args": {"chapter_no": 3}}]}
```

**解析规则**（`parseAgentReply`，宽容模式）：剥离 ```json 围栏后解析；存在顶层 `tool_calls` 数组 → 工具轮（v1 每轮只取第一个调用，多余的忽略并告知模型）；解析失败或无该字段 → 视为纯文本回复。连续 2 次解析失败 → 该轮降级为纯文本直出。

**工具结果回填格式**：

```json
{"tool": "read_chapter", "ok": true, "result": {"content": "...", "words": 3294}}
{"tool": "edit_chapter", "ok": false, "error": "user_rejected", "message": "用户拒绝了此操作"}
```

## 5. 工具集 v1（15 个）

### 读类（自动执行）

| 工具 | 参数 | 返回 | 实现复用 |
|------|------|------|---------|
| `get_status` | — | project_status、current_chapter、stage、completed/target、活跃故障摘要 | app-dashboard `loadDashboardData` |
| `read_chapter` | chapter_no, max_chars? | 章节正文（默认截 8000 字符）、字数、状态 | `readChapterContent` |
| `search_text` | query, scope?("chapters"\|"all") | [{chapter_no, line, excerpt}]，纯本地搜索，上限 20 条 | 新实现（fs 逐章扫描） |
| `read_continuity` | entity? | continuity.md 全文或指定实体分区 | S2a 产物 |
| `read_outline` | chapter_no? | 章节计划/大纲 | project-store |
| `get_cost` | — | cost.json 摘要（总额、byChapter 末 5 章、命中率） | cost.json 直读 |

### 写类（需确认卡）

| 工具 | 参数 | 行为 | 安全 |
|------|------|------|------|
| `edit_chapter` | chapter_no, find, replace, reason | find 在该章必须唯一命中，否则拒绝（语义同 Claude Code 的 Edit）；改后更新字数与 checksum 进 chapter_index | 改前写 checkpoint；确认卡显示 before/after 摘录 |
| `rewrite_chapter` | chapter_no, instructions | 入队整章重写任务（带指示语） | 队列任务，流水线执行 |
| `update_continuity` | entity, attribute, value, note | 修改设定档案对应条目，记修订来源 chat | 原子写 |
| `update_outline` | chapter_no, plan | 更新该章计划 | 原子写 |
| `queue_chapters` | instruction | 复用 `expandInstruction` 展开入队 | 既有链路 |
| `update_settings` | patch | 走 settings-runtime 全套校验（拒绝裸密钥等既有规则） | 既有校验 |

### 控制类（轻确认：确认卡，但无 before/after 预览）

| 工具 | 行为 |
|------|------|
| `start_run` | 等价"开始/继续写作"按钮 |
| `pause_run` | 等价暂停 |
| `resolve_failure` | action+args 透传 failure-actions 既有动作集 |

### 权限接通

`project.yaml` 的 `tool_permissions` 正式生效：`read_only: true` → 全部写类/控制类工具直接拒绝（人话解释）；`safe_edit: false` → `edit_chapter`/`update_continuity`/`update_outline` 拒绝。每次工具执行写 run_log 事件 `chat_tool_executed`（含工具名、参数摘要、结果状态）。

## 6. 与流水线的并发规则

- 写类工具执行包在 `withProjectLock` 内（既有锁）。
- 流水线运行中：对**正在生成的章节**的 `edit_chapter` 直接拒绝（"第 9 章正在生成，完成后再改"）；其他章节的写操作在锁可用间隙执行；`queue_chapters`/`update_settings` 随时允许（队列与设置层本就支持运行中变更）。
- 读类工具永远可用，不取锁。

## 7. 统一时间线 + 门禁对话化

- **渲染层合并，存储不复制**：对话线程 = `chat_history.jsonl` ∪ `run_log.jsonl` 按时间戳排序渲染。章节完成、预算预警、熔断、故障等系统事件以系统消息行呈现。
- **门禁对话化**（S2 门禁的最终呈现形态）：fact-check 在章节 drafting 后运行（S2 spec 既定机制不变），发现矛盾时不再走故障卡，而是写一条 agent 主动消息进 chat_history（"第 9 章写了十二楼，但第 2 章设定是六楼，建议统一为六楼"）并附预填好的 `edit_chapter` pending_action——一键修复。title/word-cap 本地门禁的警告同样以系统消息进时间线。
- 既有故障卡机制保留（熔断、provider 错误等非门禁场景仍用），呈现位置迁入对话流。

## 8. 对话历史与数据契约

**`chat_history.jsonl`**（项目根，append-only，原子追加）：

```json
{"id":"uuid","ts":"ISO8601","role":"user","content":"把第2章的六楼改成十二楼"}
{"id":"uuid","ts":"ISO8601","role":"assistant","content":"...","tool_calls":[{"tool":"edit_chapter","args":{}}],"usage":{"inputTokens":1,"outputTokens":1},"cost":0.0012}
{"id":"uuid","ts":"ISO8601","role":"tool","tool":"edit_chapter","ok":true,"result_summary":"第2章 1 处替换完成"}
```

**`chat_pending_action.json`**（项目根，单对象或 null）：

```json
{"id":"uuid","created_at":"ISO8601","tool":"edit_chapter","args":{"chapter_no":2,"find":"六楼","replace":"十二楼","reason":"用户指示统一楼层"},"preview":{"before":"…从六楼坠落…","after":"…从十二楼坠落…"},"status":"pending"}
```

**上下文窗口策略**：最近 20 轮（user/assistant/tool 各算一轮）原文进上下文；更早内容首次溢出时生成对话摘要块（一次模型调用，stage="chat"），此后滚动更新。

## 9. API 端点（app-server 扩展）

| 端点 | 方法 | 行为 |
|------|------|------|
| `/api/chat/send` | POST `{message}` | SSE 流式响应：`text_delta`（流式文本）、`tool_started`、`tool_result`、`pending_action`、`done`（含本轮 usage/cost） |
| `/api/chat/confirm` | POST `{action_id, approve}` | 批准 → 执行工具并恢复 agent loop（同样 SSE）；拒绝 → 拒绝原因回填 loop |
| `/api/chat/history` | GET `?after=<id>&limit=` | 分页读取 chat_history |

既有 `/api/commands/submit`、`/api/commands/ask` 保留兼容（composer 的 `/write` `/ask` 前缀变为对话内快捷方式，底层逐步统一到 chat/send）。

## 10. UI（app-shell）

- **thread-renderer 升级**：新增气泡类型——用户消息、agent 流式消息（含 markdown 渲染）、工具执行卡（折叠态显示工具名+状态，展开显示参数与结果摘要）、确认卡（before/after 预览 + 执行/取消按钮）、系统事件行（复用现状）。
- **composer**：默认输入即对话；`/` 前缀命令保留（提示菜单已有 command-registry）。
- **成本脚注**：每条 agent 回复尾部小字显示本轮花费（沿用 costAvailable guard：未配价格只显示 token）。
- **clickability 防线**：确认卡按钮、工具卡展开、对话滚动加载全部加入 `verify:app-clickability` 探针（CLAUDE.md 既有要求）。

## 11. 成本与标价

- 每轮对话 1~9 次模型调用（1 + 工具轮），byStage=`chat` 独立归因；对话摘要调用同标签。
- 预估每轮成本 ¥0.005-0.03（视上下文长度），UI 实时可见。
- agent loop 受 maxToolRounds + 既有预算熔断双约束；熔断触发时 agent 以文本说明停止原因。

## 12. 验收标准（方案 A 单次验收，全面覆盖）

1. **理解可溯源**（真实 API）：连续问"现在写到哪了/主角是谁/花了多少钱"，回答内容与工具返回一致（比对 run_log 的 chat_tool_executed 记录），无幻觉编造。
2. **编辑落地**（真实 API）："把第 2 章六楼改成十二楼" → 确认卡 before/after 正确 → 批准 → 文件实际变更 + checkpoint 存在 + chapter_index checksum 更新。
3. **指挥落地**："大纲第 11 章改成 X，然后写到 13 章" → 大纲文件更新 + 队列 3 个任务 + 流水线启动。
4. **门禁对话化**：用 S2 语料（A1 楼层矛盾）注入 → 章节完成后 agent 主动发矛盾提案消息 → 一键修复执行成功。
5. **拒绝路径**：read_only 项目中请求编辑 → 人话拒绝；流水线生成中编辑当前章 → 人话拒绝。
6. **并发安全**：流水线运行中聊天查询正常、对其他章编辑成功、对当前章编辑被拒。
7. **持久性**：pending_action 未决时杀进程重启 → 确认卡恢复显示，批准后正常执行；chat_history 完整。
8. **成本归因**：byStage 出现 chat 且金额>0；每条回复显示成本脚注。
9. **既有防线**：`npm test`、`verify:mvp`、`verify:longrun`、`verify:app-shell`、`verify:app-clickability`（含新探针）、`verify:local` 全过。
10. **协议鲁棒**：mock 模型输出畸形 JSON → 降级纯文本不崩溃；工具名不存在 → 错误回填 loop 由模型自行修正。

## 13. 风险与控制

| 风险 | 控制 |
|------|------|
| 一次性交付集成风险（用户选择方案 A） | 内部按依赖分层实施（记忆→loop+读→写+确认→门禁→UI），每层全量测试通过才进下层；只是不设中间用户验收门 |
| 模型 JSON 协议输出不稳定 | 宽容解析 + 连续失败降级纯文本 + 协议测试用畸形样本回归 |
| edit_chapter 改坏正文 | find 唯一性强制 + checkpoint 前置 + 确认卡 before/after 人审 |
| agent loop 成本失控 | maxToolRounds=8 + 单结果截断 + 既有熔断 + 每轮成本可见 |
| 对话 UI 大改引发点不动回归 | clickability 探针随新控件同步扩展（既有硬防线） |
| 流水线与编辑竞态 | withProjectLock + 当前生成章节编辑拒绝规则 |

## 14. 明确不做（v1）

语音输入、多项目跨聊天、写作之外的无人值守自主决策、插件/工具市场、向量检索记忆、原生 function calling（候补）、多 pending_action 并行、对话分支/回溯编辑。
