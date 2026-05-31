# WWriting 重试、小说列表与缓存一致性修复规格

## 概述

本规格把三个体验问题合并为一个交付边界：

1. **无法重试**：界面显示“已中断”并提供“重试”，但点击后后端返回“没有可重试的任务”。
2. **“我的小说”新增/删除逻辑不完整**：新建、打开、最近列表已有基础能力，但缺少与 Codex 线程列表一致的显式移除/删除体验。
3. **缓存信息和缓存利用不足**：项目已记录 `cache_report.json` 与模型 usage cache 字段，但 UI 表达弱，prompt cache key 稳定性和可观测性还不足。

目标是让“用户看到的可操作状态”与“后端实际可执行动作”完全一致，并把项目列表与缓存做成可靠、可解释、可验证的产品能力。

---

## 设计原则

- **可见即可执行**：只要 UI 显示“重试”，后端就必须能选出明确的恢复路径；否则 UI 不显示重试并解释原因。
- **列表行为贴近 Codex**：新建是创建一个可切换的工作对象；移除默认只从侧栏列表移除，不破坏本地文件；真正删除必须二次确认。
- **本地文件优先安全**：涉及项目文件夹删除时必须保守，默认不物理删除，且不允许删除工作区外项目，除非后续另设高风险确认流程。
- **缓存不伪造**：供应商没有返回缓存指标时，不显示假命中率；但要显示 cache key 是否稳定、prompt 是否频繁失效、哪些阶段可被缓存复用。
- **最小改动**：复用已有 `TaskQueue`、`app-state`、`cache_report.json`、`CacheKeyManager`，不引入 WebSocket/SSE 或外部依赖。

---

## 一、无法重试修复

### 1.1 当前诊断

现有前端判定来自 `computeAgentTruth(data)`：

- `project_status === "interrupted"` 时显示“已中断”并 `showRetry=true`。
- `project_status === "running"` 且 `agent_alive=false` 时也显示可重试。
- 顶栏重试调用 `POST /api/run/retry`，默认不传 `taskId`。

现有后端 `serveRunRetry()` 的任务选择主要依赖 `task_queue.json`：

- 有 stale `running` task 时重试该 task。
- 有唯一 `interrupted/cancelled` task 时重试该 task。
- 没有候选 task 时尝试 `queue.promoteNext()`。
- 如果队列为空且项目状态仍为 `interrupted/running`，最终 `task === null`，返回“没有可重试的任务”。

这解释了截图里的矛盾：项目级状态已经中断，但队列层没有可选 task，导致 UI 和 API 的可重试定义不一致。

### 1.2 Retry Candidate Resolver

新增唯一的后端判定函数：**Retry Candidate Resolver**。dashboard 和 `POST /api/run/retry` 必须复用同一套判定，前端不得再用另一套推断决定按钮是否可点。

建议输出结构：

```json
{
  "available": true,
  "code": "retry_available",
  "reason": "可从项目中断状态恢复。",
  "taskId": "task-...",
  "ambiguousTaskIds": [],
  "candidateSource": "queue_task"
}
```

失败或不可重试时：

```json
{
  "available": false,
  "code": "retry_still_running",
  "reason": "智能体仍在运行，请先停止当前任务。",
  "taskId": null,
  "ambiguousTaskIds": []
}
```

dashboard 新增字段必须直接来自 resolver：

```json
{
  "retry_available": false,
  "retry_code": "retry_still_running",
  "retry_unavailable_reason": "智能体仍在运行，请先停止当前任务。",
  "retry_task_id": null,
  "retry_ambiguous_task_ids": []
}
```

前端显示规则：

- `retry_available === true`：显示可点击“重试”。
- `retry_available === false` 且 `agent_alive === true`：不显示重试，只显示“停止”。
- `retry_available === false` 且有 `retry_unavailable_reason`：可在状态 tooltip 或 toast 中解释，不提供会失败的按钮。

### 1.3 修复语义

新增统一概念：**retry candidate**。

后端必须把以下情况都归一为候选：

| 情况 | 候选来源 | 行为 |
|---|---|---|
| live job 仍在运行，包含心跳超时但进程仍 alive | 无 | `retry_available=false`，只允许停止；`/api/run/retry` 返回 409 |
| stale queue task: `task.status="running"` 且无 live job | 该 task | 继续该 task |
| 唯一 `interrupted/cancelled` queue task | 该 task | `queue.retry(task.id)` 后继续 |
| 多个 `interrupted/cancelled` queue task | 无歧义候选 | 返回 400，要求传 `taskId` |
| 项目级 `project_status="interrupted"`，但队列为空 | 合成恢复 task | 从当前 `agent_state.json` 恢复运行 |
| 项目级 stale `project_status="running"`，但队列为空且无 live job | 合成恢复 task | 标记为恢复运行并继续 |
| 项目级 `project_status="cancelled"`，但队列为空 | 合成恢复 task | 允许从已停止位置继续，保留取消原因作为恢复元数据 |
| `project_status="blocked/completed"` | 无 | 返回 400，不可重试 |

“合成恢复 task”不是虚假队列项。它必须落盘为一个真实 queue task，以便后续 dashboard、任务卡片和自动推进都能看到同一份状态。

建议生成规则：

```js
{
  instruction: state.last_user_instruction ?? inferInstructionFromState(state),
  mode: "write",
  status: "running",
  currentStage: state.current_stage ?? "queued",
  error: state.interrupted_reason ?? state.cancelled_reason ?? null,
  recovery: {
    source: "project_state",
    projectStatus: state.project_status,
    chapterNo: state.current_chapter_no,
    stage: state.current_stage
  }
}
```

如果 `last_user_instruction` 不存在，使用保守文案：`继续当前写作任务`。该文案只用于任务卡片展示，不进入模型提示词替代真实上下文。

### 1.4 TaskQueue Schema 要求

恢复 task 需要 `task_queue.json` 能稳定保存恢复元数据。当前 `normalizeTask()` 会只保留固定字段，因此本修复必须同步升级队列 schema。

建议升级为 `schema_version: 2`，新增字段：

```json
{
  "source": "project_state_recovery",
  "recovery": {
    "source": "project_state",
    "projectStatus": "interrupted",
    "chapterNo": 2,
    "stage": "drafting",
    "reason": "API timeout",
    "createdAt": "2026-05-31T06:34:00.000Z"
  }
}
```

规则：

- 旧 `schema_version: 1` 文件可原样加载；缺少 `source/recovery` 时视为普通任务。
- `normalizeTask()` 必须保留 `source`、`recovery` 和已有 `result`，不得吞掉恢复元数据。
- 新增内部方法，例如 `queue.createRecoveryTask({ instruction, mode, currentStage, recovery })`，避免通过手写 JSON 拼任务。
- 同一项目同一时间只能有一个 `running` task；创建恢复 task 前必须再次加载队列并确认没有 live/stale running 冲突。

### 1.5 API 合同

`POST /api/run/retry`

请求：

```json
{}
```

或：

```json
{ "taskId": "task-..." }
```

成功响应：

```json
{
  "ok": true,
  "message": "已从中断处继续。",
  "task": {
    "id": "task-...",
    "status": "running",
    "recovery": {
      "source": "project_state"
    }
  }
}
```

失败响应必须带机器可读 `code`：

| code | HTTP | 文案 |
|---|---:|---|
| `retry_already_running` | 409 | 智能体正在运行中，无需重试。 |
| `retry_still_running` | 409 | 智能体仍在运行，请先停止当前任务。 |
| `retry_not_allowed_status` | 400 | 当前项目状态不可重试。 |
| `retry_ambiguous_task` | 400 | 存在多个可重试任务，请指定 taskId。 |
| `retry_invalid_task_id` | 400 | 只能重试已中断或已停止的任务。 |
| `retry_project_unavailable` | 404 | 当前没有可恢复的小说项目。 |
| `retry_start_failed` | 500 | 重试任务已创建，但启动失败。 |
| `retry_no_candidate` | 400 | 当前没有可重试的任务。 |

前端 `handleRetry()` 需要按 `code` 展示更具体的 toast，并刷新 dashboard，避免用户连续点击得到重复错误。

### 1.6 状态一致性要求

- `computeAgentTruth(data)` 不再单独决定 `showRetry`；它必须结合 dashboard 的 `retry_available/retry_code`。
- `retry_available === true` 时，`/api/run/retry` 在同一状态下必须返回 200，除非请求期间另一个 live job 抢先启动。
- `agent_alive === true` 时，即便心跳超过 60 秒，P0 也不提供重试，只提供停止。强制重启属于 P2 独立功能。
- 如果后端确定不可重试，dashboard 应提供 `retry_available=false`、`retry_code` 和 `retry_unavailable_reason`，前端据此隐藏或禁用重试。
- 重试成功后清理 `interrupted_reason/interrupted_at/cancelled_reason/cancelled_at`，但不得删除草稿、章节索引、事件日志、cost、cache report。
- 旧项目没有 `task_queue.json` 时，首次重试会创建该文件并写入恢复 task。

---

## 二、“我的小说”新增与删除逻辑

### 2.1 当前诊断

已有能力：

- `POST /api/projects/init` 可以初始化新小说，并通过 `recordRecentProject()` 记入最近列表。
- `POST /api/projects/open` 可以打开已有小说，并记入最近列表。
- `GET /api/projects/list` 从 `app-state.json` 的 `recentProjects` 渲染“我的小说”。
- `forgetRecentProject()` 已能从最近列表移除项目并更新 `lastProjectRoot`。

缺口：

- UI 没有项目行级菜单或删除按钮。
- 服务端没有 `/api/projects/forget` 或 `/api/projects/delete`。
- “移除列表”和“删除本地文件”语义没有区分。
- 删除当前选中项目后，产品合同没有明确规定下一个选中项目。

### 2.2 与 Codex 一致的产品语义

“我的小说”应像 Codex 左侧线程列表一样：

- 点击项目行：切换到该小说。
- 新建小说：在侧栏顶部保留主按钮；创建成功后插入列表并选中新小说。
- 行级更多菜单：提供“从列表移除”和“删除本地项目”。
- 从列表移除：只修改 app-state，不删除任何小说文件。
- 删除本地项目：高风险动作，需要确认项目标题或明确确认短语，且默认只允许删除工作区内项目。
- 删除或移除当前项目后：自动选中列表中下一个可用项目；如果没有项目，进入空状态/新建状态。

### 2.3 API 合同

#### `POST /api/projects/forget`

只从 `app-state.json` 移除项目。

请求：

```json
{ "projectRoot": "D:\\WWriting\\novels\\example" }
```

响应：

```json
{
  "ok": true,
  "selectedProjectRoot": "D:\\WWriting\\novels\\another",
  "projects": []
}
```

规则：

- 不使用 `validateProjectRoot()`，因为被移除的 recent 项目可能已经被用户移动或删除；如果强制要求 `project.yaml` 存在，坏路径反而移不掉。
- 只做路径规范化、请求体大小限制、空路径拒绝，以及与 `recentProjects/selected` 的路径匹配；不得因为项目已失效而返回失败。
- 如果移除的是当前选中项目，`selected` 切换到 `forgetRecentProject()` 返回的 `lastProjectRoot`。
- 如果目标不在最近列表，也返回 `ok=true`，保持幂等。
- `selectedProjectRoot` 为 `null` 时，app shell 进入空状态，不得自动扫描工作区打开最新项目。

### 2.4 Dashboard 选择语义

为了让“从列表移除”与 Codex 线程列表一致，需要取消 app-shell 场景下的隐式项目扫描。

规则：

- 启动时仍可从 `app-state.json.lastProjectRoot` 恢复上次项目。
- 当 `selected === null` 且最近列表为空时，`GET /api/dashboard` 返回 `hasProject=false`。
- `loadDashboardData()` 的 `findLatestProjectRoot()` 兜底只能用于显式兼容入口，不能在 app-shell 已经有 `stateRoot` 的列表语义下自动选中项目。
- `resolveActiveProjectRoot()` 在运行、重试、停止、队列等写操作中不得扫描工作区兜底；没有 selected 时返回明确错误码。
- 只有用户执行 `open/init` 后，项目才进入“我的小说”列表。

#### `POST /api/projects/delete`

物理删除项目目录。P0 不实现，只在 spec 中定义；实现时必须满足以下条件：

请求：

```json
{
  "projectRoot": "D:\\WWriting\\novels\\example",
  "confirmTitle": "小说标题"
}
```

规则：

- 只允许删除 `workspaceRoot` 内部项目。
- 必须存在 `project.yaml` 且 `confirmTitle` 与项目标题完全一致。
- 如果项目有 live job，返回 409，要求先停止任务；此时不得修改 recent、selected 或本地文件。
- 删除成功后再从最近列表移除；如果删除失败，不得让项目从列表中消失。若实现采用“先移除再删除”的流程，失败时必须回滚 `app-state.json`。
- 删除后刷新项目列表，并按 `/api/projects/forget` 的选择规则更新 selected。
- 使用安全删除策略；不得通过字符串拼接调用 shell 删除。

### 2.5 前端交互

每个项目行增加一个小型更多按钮：

- 默认只显示标题、模型、状态点；hover/focus 时显示更多按钮。
- 菜单项：
  - `打开`
  - `从列表移除`
  - `删除本地项目...`
- 选中项目被移除后，thread 清空并重建新选中项目的 dashboard。
- 删除失败时保留当前视图，toast 显示后端 `message`。
- P0 至少提供键盘可访问的“从列表移除”入口；P1 再完善菜单动画、焦点陷阱和删除确认弹层。

空列表文案：

```text
还没有小说，点上方「新建小说」开始
```

列表不应自动扫描并加入工作区内所有项目，除非用户打开或创建过；这保持 Codex 式“最近工作对象”列表语义。

---

## 三、缓存优化

### 3.1 当前诊断

已有能力：

- `CacheKeyManager` 根据 `projectId + templateVersion + stableHash` 生成 cache key。
- `writeCacheReport()` 写入 `cache_report.json`。
- `normalizeUsageReport()` 解析常见 cache usage 字段。
- dashboard 读取 `cache_report.json` 并展示 `cacheHitRate`。

缺口：

- UI 只关注供应商命中率，无法解释“为什么没有命中”。
- `stableHash` 是否真的稳定缺少回归测试覆盖。
- 动态内容、章节上下文、验证反馈如果误入 stable block，会导致 cache version 频繁变化。
- 没有阶段级缓存摘要，用户不知道哪类调用在复用缓存。

### 3.2 缓存目标

缓存优化分为两层：

1. **Prompt cache key 稳定性**：同一项目、同一阶段模板、同一稳定上下文下，多次调用保持相同 `cacheKey/cacheVersion`。
2. **缓存可观测性**：即使供应商不返回命中指标，UI 也能显示“缓存键稳定/已变更/供应商未返回指标”。

### 3.3 Prompt 分块与兼容要求

现有 `PromptCompiler` 已经区分 `stableBlocks` 与 `dynamicBlocks`，并返回 `blocks`、`blockHashes`、`stableHash`、`dynamicHash`。本规格不是重写 prompt compiler，而是补齐报告结构、UI 摘要和回归测试。

分块规则：

| block 类型 | 是否进入 stableHash | 示例 |
|---|---|---|
| `stable` | 是 | 世界观、人物设定、写作规则、章节目标、固定技能约束 |
| `dynamic` | 否 | 本次 attempt、validation feedback、临时错误、当前时间 |
| `ephemeral` | 否 | 仅当后续确有 trace id/调试标记需要进入 prompt 时再新增；P0 不要求实现 |

要求：

- `stableHash` 只由 `stable` block 计算。
- `dynamicHash` 由 dynamic block 计算，仅用于诊断；完整 prompt hash 仍由现有 `context_package_hash` 表达。
- 保留现有 `cache_report.last_call.promptBlockHashes` 的兼容语义：它仍是 `{ blockName: hash }` 字符串 map，不能改成对象数组，避免破坏现有 checkpoint 和测试。
- 新增结构化字段 `cache_report.last_call.promptBlocks`：

```json
[
  { "name": "system_rules", "kind": "stable", "hash": "sha256:..." },
  { "name": "current_task", "kind": "dynamic", "hash": "sha256:..." }
]
```

- 同一章节重试时，如果只是 attempt/validation feedback 改变，`cacheVersion` 不增加。

### 3.4 Dashboard/UI 展示

新增缓存摘要字段：

```json
{
  "cacheSummary": {
    "available": true,
    "providerMetricsAvailable": false,
    "cacheKey": "project:drafting.v1:v1:abcd",
    "cacheVersion": 1,
    "stableChanged": false,
    "stableChangedReason": null,
    "lastTemplateVersion": "drafting.v1",
    "hitRate": null,
    "cachedTokens": 0,
    "explanation": "缓存键稳定；供应商未返回命中指标"
  }
}
```

`stableChanged` 定义为：**本次模型调用导致 `cacheVersion` 相比同一 `projectId + templateVersion` 的上一条 cache entry 增加**。为了支持这个字段，cache report 或 `CacheKeyManager.update()` 需要保留上一条 `stableHash/cacheVersion`，并输出 `stableChangedReason`：

- `null`：没有变化。
- `stable_hash_changed`：稳定块 hash 改变。
- `template_version_changed`：模板版本改变。
- `first_call`：该模板首次调用，不算失效。

UI 规则：

- 有供应商命中率：显示 `缓存命中 25%`。
- 无供应商命中率但 cache key 稳定：显示 `缓存键稳定`。
- cache version 增加：显示 `缓存已刷新 v2`，tooltip 解释稳定上下文变化。
- 没有 `cache_report.json`：显示 `缓存待生成`。

### 3.5 验证要求

- 模型 gateway 测试覆盖：
  - stable block 不变、dynamic block 变化时，`cacheVersion` 保持不变。
  - stable block 变化时，`cacheVersion` 增加。
  - `promptBlockHashes.system_rules` 等字段保持字符串 hash。
  - `promptBlocks` 暴露 `{ name, kind, hash }`，能区分 stable/dynamic。
  - provider 返回 OpenAI compatible `cached_tokens` / `cache_read_input_tokens` 时，usage report 正确归一。
  - provider 不返回 cache 字段时，不伪造命中率。
- dashboard 测试覆盖：
  - `cache_report.json` 缺失时返回可渲染的空摘要。
  - cache key 稳定但无供应商指标时，摘要说明“供应商未返回指标”。
- app-shell 静态验证覆盖：
  - 缓存 UI 文案由 `cacheSummary` 驱动，不直接从裸 `cacheHitRate` 拼接假百分比。

---

## 四、交付优先级

### P0：必须先修

1. 新增 Retry Candidate Resolver，dashboard 与 `/api/run/retry` 共用同一候选选择规则。
2. 升级 TaskQueue schema，支持项目级中断/停止但队列为空时创建并保留恢复 task 元数据。
3. 调整前端 retry 显示：live job 仍 alive 时不显示重试，只显示停止；强制重启不进入 P0。
4. 增加 `/api/projects/forget`，前端提供可访问的“从列表移除”入口。
5. 取消 app-shell selected 为空时的 workspace 自动扫描，确保移除最后一个项目后进入空状态。
6. 增加缓存摘要 `cacheSummary`，保留 `promptBlockHashes` 兼容字段，并新增结构化 `promptBlocks`。

### P1：随后完成

1. 项目行级更多菜单完善键盘访问、焦点管理和确认弹层。
2. 补齐 stable/dynamic hash、`promptBlocks`、`stableChangedReason` 的测试和 UI 解释文案。
3. 任务卡片和顶栏重试按钮都按同一个 retry candidate 结果渲染。

### P2：可延期

1. 物理删除本地项目 `/api/projects/delete`。
2. 阶段级缓存趋势面板。
3. 缓存失效原因 diff 视图。
4. force restart：对仍 alive 但长时间无心跳的 job 提供显式“停止并重启”流程。

---

## 五、验收标准

1. 截图中的状态：顶栏显示“已中断”时点击“重试”，不再出现“没有可重试的任务”；若能恢复则启动任务，若不能恢复则顶栏不显示可点击重试。
2. live job 仍 `agent_alive=true` 时，即便心跳超时也不显示“重试”；用户只能先停止任务。
3. 旧项目没有 `task_queue.json` 且 `agent_state.json.project_status="interrupted"` 或 `"cancelled"` 时，`POST /api/run/retry` 创建恢复 task 并返回 200。
4. 恢复 task 的 `source/recovery` 字段写入 `task_queue.json` 后再次加载不丢失。
5. 多个中断任务同时存在且没有传 `taskId` 时，后端返回 `retry_ambiguous_task`，前端提示用户从具体任务卡片重试。
6. “我的小说”列表可以移除项目；移除不会删除本地文件；刷新后项目不再出现。
7. 已被移动或删除的 recent 项目也可以从列表移除。
8. 移除当前项目后自动打开下一个最近项目；没有项目时显示空状态，dashboard 不自动扫描工作区重新打开项目。
9. 缓存区域不再把缺失指标显示成 0% 命中；供应商未返回指标时显示“缓存键稳定”或“缓存待生成”。
10. `cache_report.last_call.promptBlockHashes` 保持字符串 map，新增 `promptBlocks` 暴露 block 类型。
11. 所有新增 API 都有 `node:test` 覆盖；其中 `/api/projects/forget` 必须有服务器级测试，不只测 `app-state`；app-shell 静态验证覆盖新增 DOM/文案/事件绑定。

---

## 六、非目标

- 不在本轮引入云同步、回收站、项目归档或全文搜索。
- 不改变小说正文、章节索引、事件日志的存储格式。
- 不引入外部缓存服务；本规格只优化 prompt cache key、供应商 cache metrics 解析与 UI 可观测性。
- 不要求所有供应商都返回缓存命中率；供应商缺失指标时只展示真实可推断信息。
