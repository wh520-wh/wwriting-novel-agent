# 缺陷狩猎报告（whfind-bugs 5）

日期：2026-08-01　范围：`src/core` + `src/app-shell`（约 28k 行）
方法：提出候选（4 要素）→ 新鲜 skeptical 子代理逐一反驳（11 个候选，7+4 两轮）→ 主循环 at-a-glance 把关 → 仅报告幸存者。
筛选结果：**1 个确认（major）**，5 个机制属实但降级（minor，列入拒绝日志），5 个被反驳（拒绝日志）。

---

## ✅ 确认（1）— 通过 skeptical 子代理 + 主循环把关 + 可复现

### BUG-1（major）：崩溃后「继续写作」按钮必然失败，新指令排队后永不启动

**Location**
- `src/core/retry-candidates.mjs:22-27`（taskId 分支：只接受 interrupted/cancelled）
- `src/core/retry-candidates.mjs:29-31`（stale-running 分支：把 running 任务当作可重试候选）
- `src/core/app-server.mjs:1541-1595`（serveRunRetry；`stale_queue_task` 分支只在不带 taskId 时可达）
- `src/core/app-server.mjs:317-345`（serveDashboard 把 retry_task_id 广播给前端）
- `src/app-shell/app.js:1236-1250`（handleRetry 永远回传 retry_task_id）
- `src/core/task-queue.mjs:92-94`（promoteNext 被 stale running 任务阻塞）
- `src/core/app-server.mjs:1266-1275`（启动失败仍回「指令已记录，写作任务已开始。」）

**Phenomenon**
硬崩溃（kill -9）后：`task_queue.json` 里任务停留在 `running`，`agent_state.json` 为 `project_status: "running"`，无存活 runner。
- 仪表盘 `resolveRetryCandidate`（不带 taskId）命中 stale-running 分支 → `retry_available: true` + `retry_task_id = 该 running 任务`（`retry-candidates.mjs:29-31`）；
- 前端 `handleRetry` 把该 id 回传（`app.js:1238-1240`）；
- `serveRunRetry` 再次进入 `resolveRetryCandidate`（带 taskId）→ 任务状态 `running` 不在 `["interrupted","cancelled"]` → **必然 400 `retry_invalid_task_id`「只能重试已中断或已停止的任务。」**；
- 服务端 `stale_queue_task` 分支（真正能处理 stale 任务的逻辑）只有请求**不带** taskId 时才可达——而前端只要仪表盘广播了 id 就必定带上——该分支对 UI 流程是死代码；
- 次级效应：stale running 任务属于 `ACTIVE_STATUSES`，`promoteNext` 返回 null → 用户新提交的写作指令入队后**永不启动**，响应却回「指令已记录，写作任务已开始。」（`started:false`）。

**Impact（用户可见）**
崩溃恢复是本产品主打能力（README「断点恢复」；docs/chat-logic-optimization-plan.md §4.1 明确把 `retry-candidates.mjs:29-32` 的 stale 链路当作唯一手动恢复路径并评为「最高优先级」，且无任何文档化的手工清 task_queue.json 步骤）。在该场景下：
1. 恢复横幅「继续写作」与顶栏「重试」按钮**确定性报错**；
2. 新指令被静默吞掉（排队不启动），并给出误导性的成功提示；
3. 项目卡死，只能手工编辑 task_queue.json 自救。

**Evidence**
- `retry-candidates.mjs:24` `if (!selected || !["interrupted", "cancelled"].includes(selected.status))` vs `:30` `if (staleRunning && ["running","interrupted","cancelled"].includes(state.project_status))` —— 同一 `running` 状态被「广播为可重试」又被「拒绝为不可重试」；
- `app.js:1240` `postJson("/api/run/retry", resolvedTaskId ? { taskId: resolvedTaskId } : {})`；
- `task-queue.mjs:7` `ACTIVE_STATUSES = new Set(["running", "cancelling"])`；`:92-94` promoteNext 提前返回 null；
- 崩溃落盘路径：`promoteNext` 在启动 runner 前已 `writeJsonAtomic` 保存 `running`（`task-queue.mjs:100-104`）；`startProjectRun` 先写 `project_status:"running"`（`app-server.mjs:1749`）；`recoverInterruptedProjects`（`app-server.mjs:944-986`）只打标记、不清理任何状态；`TaskQueue.load` 的迁移只对 v<3 生效（`task-queue.mjs:21,329-365`），当前 v3 文件原样保留 `running`；`createRecoveryTask` 对存在 ACTIVE 任务返回 null（`task-queue.mjs:58-60`）。
- 测试只各自覆盖单一半：`tests/retry-candidates.test.mjs:116-127`（stale 候选被广播）、`:174-184`（非 terminal taskId 被拒）——没有端到端「仪表盘 → 点击重试」用例；`tests/app-server-probe.test.mjs:397-465` 只测不带 taskId 的形状。

**Skeptic 裁决**：CONFIRMED（Q1 全链路逐行核对；Q2 设计文档 §4.1 明确将此链路定为预期恢复路径；Q4 说明集成测试为何漏网）。**主循环把关**：认可——机制、链路、影响均可从代码直读复现。
**复现**（node REPL 实跑真实模块）：
```
DASHBOARD (no taskId): {"retry_available":true,"retry_task_id":"task-1",...}
RETRY CLICK (taskId): {"available":false,"code":"retry_invalid_task_id","status":400,"reason":"只能重试已中断或已停止的任务。"}
promoteNext: null — blocked by stale running task   (写第4章=queued 永不启动)
```

**修复方向（未实施）**：`resolveRetryCandidate` 的 taskId 分支放行 stale `running` 任务（与无 taskId 分支一致），或前端在 retry_task_id 来自 stale 候选时不回传 taskId；`serveCommandSubmit` 在 `promoteNext` 返回 null 时如实报错而非回「已开始」。

### ✅ 修复记录（2026-08-01，已实施并全量测试通过：1009/1009）

| 修复 | 改动 | 回归测试 |
|------|------|----------|
| BUG-1 核心 | `retry-candidates.mjs` taskId 分支对 stale `running` 任务（项目状态 running/interrupted/cancelled 且无存活 job）放行，返回 `stale_queue_task` 候选 | `tests/retry-candidates.test.mjs` 新增「dashboard→retry 闭环」与「idle 状态仍拒绝」两条 |
| BUG-1 次级 1 | `serveCommandSubmit`：`promoteNext` 返回 null（残留任务阻塞）时如实返回「未能自动启动」而非「写作任务已开始」 | 现有 app-server 测试覆盖通过 |
| BUG-1 次级 2 | auto_resume_on_start 路径：`createRecoveryTask` 为 null 时回退续跑残留 `running` 任务（不放行 `cancelling`） | 现有测试覆盖通过 |
| R1 | `chat-context.mjs` 过滤空 content 的 assistant 占位消息（status=generating）后再组装模型上下文 | 新增「占位消息不进模型上下文」测试 |
| R2 | 三处 timeline 渲染改 `formatChapterRef`：`continuity-store.mjs:102`、`chapter-memory.mjs:133`、`quality-gates.mjs:249` | 新增「null 章号 → 未标章号」测试 ×2 |
| R3 | `queue_chapters` 对 `expandInstruction` 返回 `[]`（「写到第N章」N<当前章）抛 `bad_args` 报错，不再静默 `{queued:0}` | 新增「早于当前章报错」测试 |
| R5 | `cost-tracker.mjs` `addToBucket` 补 `?? 0` 守卫，与 summary 路径一致，防 NaN 入桶 | 新增「缺 token 字段桶内不产生 NaN」测试 |

---

## ❌ 拒绝日志（11 个候选，每条一行原因）

### 机制属实、降级为 minor（5 个）——skeptic 核实了代码事实，降级理由是可达性/严重性

| # | 候选 | 裁决 | 拒绝原因（skeptic 证据要点） |
|---|------|------|------------------------------|
| R1 | 空 assistant 占位消息泄漏进每次 chat API 请求（`chat-agent.mjs:49-52` 写 `content:""` 占位 → `chat-context.mjs:48-51` 无过滤推入 messages） | **downgraded** | 机制 100% 属实（含 `provider-adapters.mjs:418-437` 透传）；但影响为轻微上下文污染，供应商拒绝纯属推测；团队自己在 `agent-engine.mjs:1284-1293` 有「空 content 归一 null」的惯例，此处是漏网。建议一行过滤修复。 |
| R2 | timeline 节点 `chapter_no` 为 null 时三处渲染 `第null章`（`continuity-store.mjs:102`、`chapter-memory.mjs:133`、`quality-gates.mjs:249`），绕过 `formatChapterRef` 兜底（`:8-11`） | **downgraded** | 代码事实属实，`formatChapterRef` 只用于 facts；但生产管道唯一 timeline 入口 `memory-extractor.mjs:24` 过滤了 null 章（git 历史自首版起），chat 修订只写 facts 不写 timeline → 仅 legacy/手改数据可达，纯文本污染。 |
| R3 | `expandInstruction`「写到第N章」N<current 返回 `[]`，`queue_chapters` 静默 `{queued:0}`（`task-queue.mjs:299-305,443-448` vs countMatch 分支有守卫 `:310-313`） | **downgraded** | 事实属实；但主用户路径 `compileWritingTasks`（`task-contract.mjs:98-105`）对同样输入明确抛错，模型也能在自己的工具结果里看到 `{queued:0}` → 仅反馈缺口，非功能损坏。 |
| R4 | `runTitleGate` 放过解析不出章号的标题（`quality-gates.mjs:186-196`，`foundNum===null` 绕过；`parseChineseChapterNo("零")→null`） | **downgraded** | 显式 `!== null` 守卫 + no-hits→passed 是必然设计（管线自带英文标题 `# Chapter 001` 永远不匹配正则）；「第十章」这类合法标题也会 null → 若改为 fail 反而误伤。 |
| R5 | `cost-tracker.mjs:152-155` `addToBucket` 无守卫 `+=`（对比 summary 路径 `?? 0`），缺字段 → NaN 入桶、cost.json 变 null | **downgraded** | 不一致属实；但全部 4 个生产调用方（model-client 成功/失败路径）都传规约后的数值字段，测试同样全数传递 → 实际不可达，读者端均 null 容错。 |

### 被反驳（6 个）——wrong mechanism / by-design / 不可达

| # | 候选 | 裁决 | 拒绝原因 |
|---|------|------|----------|
| R6 | `appendChapterSegment` 仅按 segment 号去重，崩溃恢复后模型重提交不同内容被静默丢弃（`tool-runtime.mjs:62-73`） | **rejected** | 按 segment 号幂等是文档化设计（`agent-engine.mjs:1621-1622`），且有测试钉死 first-write-wins（`tests/tool-runtime.test.mjs:11-31` 同段号不同内容断言丢弃）；崩溃窗口为微秒级且无任何注入点模拟。 |
| R7 | `chapter-artifact.mjs:52` 全局校验和缓存 key=path+size+mtimeMs，同尺寸同毫秒改写返回旧校验和 | **rejected** | win32/NTFS 实测 40 次同尺寸连写 0 碰撞（mtime 100ns 精度，最小间隔 5.1ms）；索引校验和与文件写入同一调用内原子更新（`tools-write.mjs:154-161`）。 |
| R8 | `search_text` 每行只报首个命中 + 满 20 条后不再扫描后续章节（`tools-read.mjs:88-102`） | **rejected** | 20 条上限在工具描述中明示；early-break 与「全扫取前 20」结果集等价；该工具不在写作白名单（仅 chat），且 edit_chapter 独立重扫全文定位（`tools-write.mjs:142`）。 |
| R9 | `upsertChapter` 缺 chapter_no 时写入 `chapter_no:undefined` 垃圾条目（`project-store.mjs:136-159`） | **rejected** | 全部 13 个生产调用点逐一点验均传整数；chat/tool-runtime 路径调用前有校验；消费者（chapter-memory/timeline-check/read_chapter/export）均过滤或跳过非整数条目。 |
| R10 | `structured-output.mjs:75-78` 只取第一个 ``` 围栏，模型输出双围栏（先解释后 JSON）时解析失败 | **rejected→downgraded** | 正则行为实测属实；但 prompt 契约明示「只输出一个 JSON 对象」，双围栏即违约；两端都有 2 次重试 + 软失败 + `audit:rebuild-memory` 补救，非静默丢失。 |
| R11 | `agent-loop.mjs` 仅在循环顶部检查 `signal.aborted`，停止信号与工具执行之间存在竞态窗口 | **rejected** |（未派发子代理，主循环自审放弃：窗口微秒级；模型调用路径本身在 abort 时抛 AbortError 已覆盖主要停止路径；「草稿已保留」语义下多写一段属设计接受。） |

---

## 结论

- 14 个候选 → 1 确认（major，崩溃恢复主链路损坏）+ 5 个机制属实 minor（建议修复：R1 一行过滤、R2 三处改 `formatChapterRef`、R3 补守卫、R5 补 `?? 0`）+ 8 个被反驳/降级。
- 本次目标「5 个 bug」：诚实的输出是 **1 个 major + 5 个已验证的 minor 硬化项**；未人为凑数。
- 若需要，R1/R2/R3/R5 四处为低风险硬化修复，可作为下一轮改动；BUG-1 建议优先修（恢复功能当前确定性损坏）。

---

## 第二轮狩猎（2026-08-01，目标 1 个）

聚焦上一轮未覆盖区域：simple-yaml、app-state、desktop/electron、book-export、cost-audit、side-question、config-runtime。2 个候选均经 fresh skeptic 反驳；**0 个 major 确认**，2 个机制全确认但严重性降级。

### 机制确认、降级为 minor（2 个）

| # | 候选 | 裁决 | 拒绝原因（skeptic 证据要点） |
|---|------|------|------------------------------|
| S3 | 导出成书未剥离流水线产物：`# Chapter 001` 英文头 + `<!-- segment:N checksum:... -->` 标记进入每本导出的书（`book-export.mjs:7,18,26` vs 写入端 `tool-runtime.mjs:58,74,112-115`） | **downgraded** | 机制端到端实测确认（composeBook 真实内容输出含两者；`.demo_runs` 真实章节文件含标记；`HEAD_TITLE_RE` 只匹配第N章，`# Chapter 001` 不匹配）；兄弟路径 `app-dashboard.mjs:229-237` stripChapterMarkup 恰好剥离这两样 → 明确是遗漏非设计；导出是默认功能（工具栏按钮 + chat 工具），每次导出 100% 复现。但无数据丢失/无功能损坏 → 内容污染属 cosmetic/minor。值得修：复用兄弟剥离规则即可。 |
| S2 | `simple-yaml.mjs:40-45` parseValue 无守卫 `JSON.parse`：手写 `{provider: mock}`/`[写作]`/JSON 后跟注释 → 整个 project.yaml 解析抛错 → loadProject 抛错 → 该项目仪表盘/设置 500 | **downgraded** | 抛错机制实测确认；但文档从不引导手改 project.yaml（README/CLAUDE 均只描述应用自写），应用自写永远合法 JSON；一处引用方（autoResume 读取）实际已被 try/catch 保护；项目列表/恢复路径容错，文件可修复恢复 → 低概率健壮性缺口。 |

### 结论（第二轮）

- 未发现 major 级新 bug；S3 是机制最扎实的一条（**每次导出必然复现**，且兄弟路径已有正确剥离规则，修复成本极低），建议顺手修掉。
- 若要凑「1 个 bug」：S3 属真实缺陷（确定性、用户可见），只是未达 major 门槛——按技能流程记入拒绝日志，不冒充确认项。

### ✅ 第二轮修复记录（2026-08-01，已实施并全量测试通过：1011/1011）

| 修复 | 改动 | 回归测试 |
|------|------|----------|
| S3 | `book-export.mjs` 新增 `stripPipelineArtifacts`（与 `app-dashboard.stripChapterMarkup` 同规则）：剥离 `<!-- segment:N ... -->` 标记、`# Chapter 001` 草稿头、规整空行；md/txt 两个分支共用 | 新增「composeBook 剥离流水线产物」测试（真实流水线内容，md+txt 双格式断言） |
| S2 | `simple-yaml.mjs` `parseValue` 的 `JSON.parse` 加 try/catch：手写/遗留的非严格 JSON 值（无引号键、无引号数组值、JSON 后跟注释）回退为原始字符串，与解析器整体宽松行为一致，整个 project.yaml 不再因单个值解析失败 | 新增「非严格 JSON 值宽松回退而非抛错」测试（三种手写形态 + 严格 JSON 不受影响） |
