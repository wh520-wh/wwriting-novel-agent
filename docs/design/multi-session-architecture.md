# 多会话架构与并行升级路径

> 记录于：2026-09-24｜状态：当前有效（Task 2–10 落地，本仓库当前行为为「同项目内多对话串行」）｜依据：src/core/agent/ 现行模块归属核对——submit / 串行门 → `run-control.mjs`，sessions() / deriveSessionTitle → `session-manager.mjs`，startLoop → `run-lifecycle.mjs`（Task 18 拆分）。本文记录会话注册表、会话分片存储、单流迁移、惰性创建与串行门的设计，并明确标注「所有对话可独立并行工作」的后续升级路径。
> 范围：后端 `src/core/agent/` 的会话数据模型与 Runtime 串行门、前端 `src/app-shell/` 的传输层、AgentSurface 多会话管理、左侧栏两级树与设置「已归档对话」；以及移除串行门所需的会话级文件锁与每会话独立 run 循环。

## 1. 已确认目标

- 多对话独立存在、互不串场：每个会话的事件流独立，seq 各自从 1 单调递增；前端每个会话有独立 state 实例，切换会话重建视图。
- 同一项目同一时刻最多一个 Run 执行（串行）：保证项目级状态（runId/controller/loopPromise、压缩收敛、checkpoint、记忆与章节事务）不被并发破坏。
- 惰性创建：未发消息不产生会话条目；品牌新项目打开后不建 journal、不建会话。
- 旧单流数据一次性迁移；旧世界 legacy 文件（agent_state.json / chat_history.jsonl）只读导入且永不再次写入。

## 2. 会话注册表（`sessions/index.json`）

- 实现：`src/core/agent/session-registry.mjs`。注册表是会话元数据真相源，位于应用私有 agentRoot 的 `sessions/index.json`（workspace 存储根下，不落项目目录）。
- 条目字段：`session_id` / `title` / `created_at` / `updated_at` / `archived_at`；`title` 缺省为「新对话」，惰性创建路径以首条消息摘要命名（`deriveSessionTitle`，`src/core/agent/session-manager.mjs`）。
- `sessions()` 列表附加 `run_status` 投影（`session-manager.mjs` 的 `sessions()`）：只对已物化会话读取其 journal 的 `active_run`——非终态 → `running`，`failed` → `failed`，其余 → `idle`。该投影是左侧栏状态点与前端 busy 复位的唯一数据源。
- 会话 CRUD（newSession/renameSession/archiveSession/restoreSession/deleteSession）全部委托注册表，经 HTTP 路由（`src/core/http/agent-routes.mjs`）与前端传输层（`src/app-shell/agent/api.js`）透出。

## 3. 会话分片存储（`sessions/<id>/segments/events/`）

- 实现：`src/core/agent/journal.mjs` + `src/core/agent/journal-segments.mjs`。每个会话一个独立 journal 目录：
  - `segments/events/*.jsonl` —— canonical 真相源（分段 JSONL，可轮转）；
  - `segments/transcript/*.jsonl` —— 模型消息链/历史摘要（含 legacy 导入的可见历史与错误事实，按 `legacy_id` 幂等去重）；
  - `journal-manifest.json` —— 派生数据（generation/roots/last seqs/gaps），可删除重建；
  - `session.json` —— 可重建的 Session/Run 投影，每次追加后原子重写（临时文件 + rename，`src/core/fs-utils.mjs` 的 `writeJsonAtomic`，Windows 兼容）。
- 事件 seq 每会话独立编号；崩溃对账（checkpoint 提交 marker 裁决、孤儿清理、非终态压缩收敛）在会话 load 后执行。

## 4. 单流迁移

- 旧单体 journal 迁移：`src/core/agent/journal-session-migration.mjs` 的 `migrateSingleSessionToRegistry`——把 agentRoot 顶层的旧 `session.json` / `events.jsonl` / `transcript.jsonl` 一次性搬入 `sessions/<id>/`，旧文件改名保留，迁移标记写入 `migration.json`（`sessions_migrated`，幂等）。
- 旧世界 legacy 导入：`src/core/agent/legacy-import.mjs` 的 `runLegacyImport`——只读导入 `agent_state.json`（blueprint_status 迁移进 project.yaml、未完成 Run 以 `legacy: true` 标记恢复）与 `chat_history.jsonl`（进 transcript），`migration.legacy_imported` 原子置位；旧文件保留不删除、完整跑一轮后不再写入。
- 迁移序列在 `runtime.mjs` 的 `migrateProjectData`（open/submit 前幂等执行）与 `reconcileSessionAfterLoad`（会话 load 后的 legacy 导入）中编排。

## 5. 惰性创建

- 设计动机：品牌新项目不产生空会话；会话条目与 journal 只在第一次有真实消息时物化。
- `submit` 无 `sessionId` 时的解析链（`run-control.mjs` `submit`）：显式 id 校验存在 → 缺省取最近活跃 → 都没有则 `registry.create({ title: deriveSessionTitle(text) })` 并 `session_created` 写入 journal。
- 前端「+」新建走 draft 占位（`src/app-shell/agent/index.js` 的 `newSessionPlaceholder` / `submitWithDraft`）：提交时先 `createSession` 落盘替换占位，再投递输入——占位是本地未落盘状态，后端不认识 draft id。

## 6. 串行门（project_busy）

- 后端：`run-control.mjs` `submit` 在项目互斥锁内检查——目标会话之外若有任一已物化会话存在非终态 `active_run`，立即 `throw fail("project_busy", ...)`，且零副作用（被拒提交不新建会话、不改任何事件流）。同会话提交不受影响，仍走 FIFO 队列。
- 前端：
  - submit 收到 `project_busy`（HTTP 409）时自动 `setBusy(true)`（`agent/index.js`）；
  - 侧边栏 `session-sidebar.mjs` 的 `syncBusy` 用 `run_status` 投影推导：当前项目「其他会话」存在 `running` → busy；`view.js` `syncComposer` 据此禁用发送键并改占位文案为「另一个对话正在运行」（输入框不锁，草稿可继续编辑）。
- busy 复位：SSE 事件流按当前会话订阅，其他会话的终态事件不会到达本会话流——busy 期间侧边栏每 5s 周期重拉会话列表（`startBusyRefresh`）作为复位兜底；`onRunTerminal`（当前会话终态）与 openProject/switchSession 后的刷新也承担复位。

## 7. 为什么当前串行（正确性前提，非性能取舍）

- 同一项目的所有会话共享一个 run 循环骨架与**项目级**运行状态：`state.runId` / `state.controller`（AbortController）/ `state.loopPromise`（`run-lifecycle.mjs` `startLoop` 的簿记字段都挂在 `state` 上），以及项目互斥锁 `state.mutex`、压缩收敛、checkpoint、项目记忆与章节事务。
- 若两个会话的循环并发推进，两套模型轮次会并发写同一项目级状态与项目文件（记忆、章节草稿/正式文件、checkpoint），而当前没有会话级隔离的锁来仲裁这些写——「同项目同一时刻最多一个 Run」用最少的机制把并发面收掉，保证项目级不变量不被破坏。
- 前端侧对应：其他会话运行中禁用发送键（busy），把「并发输入」也在入口拦掉。

## 8. 后续升级：所有对话可独立并行工作

> ⚠️ **明确标注：后续升级——所有对话可独立并行工作。** 本文档当前状态下产品的真实行为是「同项目串行」（第 6、7 节）；以下为计划中的升级路径，**尚未实施**，不是现状描述。

- 移除 `project_busy` 串行门：`run-control.mjs` `submit` 的互斥锁内门禁检查、HTTP 409 透出、前端 `setBusy` / `composerBusy` / 侧边栏 busy 周期刷新全部删除（会话状态点与活跃高亮保留）。
- 引入会话级文件锁：以 `sessions/<id>/` 下的锁文件（或锁目录）仲裁同一会话内的队列/压缩/checkpoint，替代「项目互斥锁内启动循环」的全局串行前提；项目级锁只保留注册表写与迁移。
- 每会话独立 run 循环：`runId` / `controller` / `loopPromise` 从项目级 `state` 移到会话级 `sessionState`，`startLoop` 不再要求「全项目无其他飞行循环」；stop/cancel/retry/压缩收敛全部按会话寻址。
- 需要重新审计的共享面（并行后才暴露）：上下文预算与压缩收敛、checkpoint 对账、项目记忆写入、章节事务与正式文件落盘——这些要么下沉为会话级互斥，要么串行化到项目级事务边界，不能两个 Run 同时写。
- 前端并行化：会话切换不再受 busy 约束；同一项目可同时展示两个运行中状态点（`run_status` 投影天然支持多 running）。
- 升级验收建议：双会话并发互不干扰（各自 seq 单调、事件不串场）、同会话 FIFO 语义不变、跨会话文件写入无撕裂（复用 verify-unified-agent 的原子写入检查）、busy 相关 UI 逻辑全部移除后无残留。

## 9. 与既有缺陷修复的关系

- Task 1 修复的 read_file 重复展示（同一文件读取在工作组时间线重复渲染）与多会话改造同源：旧单流架构下事件流与视图渲染缺少会话级边界。多会话把事件流按会话隔离、seq 独立编号，渲染路径（`src/app-shell/agent/` 的 work-items/视图）按会话重建，从结构上消除了跨会话/跨分片重复的土壤；该修复随 Task 1 独立落地，是本次多会话改造的前置清理。

## 关键实现位置索引

| 能力 | 实现位置 |
|---|---|
| 会话注册表 | `src/core/agent/session-registry.mjs`（`sessions/index.json`） |
| 会话分片 journal | `src/core/agent/journal.mjs`、`journal-segments.mjs` |
| 单流迁移 | `src/core/agent/journal-session-migration.mjs`、`runtime.mjs` `migrateProjectData` |
| legacy 只读导入 | `src/core/agent/legacy-import.mjs` `runLegacyImport` |
| 惰性创建 / 串行门 | `src/core/agent/run-control.mjs` `submit` |
| run_status 投影 | `src/core/agent/session-manager.mjs` `sessions()` |
| 会话 HTTP CRUD | `src/core/http/agent-routes.mjs` |
| 前端传输层 | `src/app-shell/agent/api.js` |
| AgentSurface 多会话 | `src/app-shell/agent/index.js`（switchSession/submitWithDraft/setBusy） |
| 两级侧边栏 + busy | `src/app-shell/session-sidebar.mjs`（syncBusy/5s 刷新/折叠持久化） |
| composer busy 态 | `src/app-shell/agent/view.js` `syncComposer` |
