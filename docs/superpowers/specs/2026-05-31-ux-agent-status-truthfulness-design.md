# WWriting 用户体验大改造设计规格

## 概述

本设计是 WWriting 桌面端的全面体验升级，解决三个核心问题：

1. **智能体状态假显示** — UI 必须真实反映运行状态，中断时提供重试
2. **工作流缺乏 Codex 式任务管理感** — 需要队列、阶段可见性、可中断
3. **缺乏上下文恢复感 + 信息层次混乱** — 打开项目不知道进展到哪

核心设计原则：**命令驱动 · 队列执行 · 阶段透明 · 自动接受 · 可中断可重试**

---

## 设计决策汇总

| 维度 | 决策 |
|---|---|
| 交互模式 | 命令驱动型（用户发指令→智能体执行→结果回显） |
| 任务执行模型 | 队列式（可提交多条指令排队，一次执行一个，完成后自动下一个） |
| 任务粒度 | 每个阶段=一个可见子任务（规划→写作→审稿→定稿→总结） |
| 入队方式 | 两种都支持：精确指令分别入队 + 笼统指令自动拆解 |
| 审批流程 | 自动接受（不强制审批门） |
| 取消能力 | 可中断正在运行的任务，已写内容保留为草稿 |
| 中断交互 | 对话流中任务卡片上的停止按钮 |
| 重试语义 | 从中断处继续（不重做已完成的工作） |
| 队列展示 | 内联在对话流中（任务卡片是对话的一部分） |
| 历史处理 | 对话流即历史（向上滚动看之前的任务卡片） |
| 通知方式 | 仅应用内显示 |
| 状态真实性 | 进程存活探针（精确）+ 心跳时间戳（进度展示） |
| 持久化 | 基于现有 run_log.jsonl + events 系统重建对话流 |

---

## 一、状态真实性系统

### 1.1 问题诊断

当前 `agent-engine.mjs` 的 `runProject()` 将 `project_status` 设为
`"running"` 写入 `agent_state.json`，然后进入主循环。如果进程崩溃
（API超时、未捕获异常、用户关闭窗口），状态文件残留 `"running"`，
前端轮询读到后永远显示"运行中"——这就是假显示。

没有心跳、没有超时检测、没有重试按钮。

### 1.2 进程存活探针

`app-server.mjs` 已有 `const runJobs = new Map()`。升级结构：

```javascript
// key: projectRoot (resolved path string)
// value:
{
  promise: Promise,
  startedAt: string,        // ISO 时间戳
  lastHeartbeat: string,    // agent-engine 通过回调更新
  status: 'running' | 'done' | 'error',
  error: null | string
}
```

`/api/dashboard` 响应新增字段：

```json
{
  "agent_alive": true,
  "agent_started_at": "2026-05-31T10:00:00Z",
  "agent_last_heartbeat": "2026-05-31T10:05:32Z",
  "agent_error": null
}
```

判定逻辑：
- `agent_alive === true` → 进程确实在跑
- `agent_alive === false` 且 `project_status === "running"` → **已中断**（状态文件残留）
- `agent_alive === false` 且 `project_status === "interrupted"` → **已中断**（正常捕获的异常）

### 1.3 心跳机制

`agent-engine.mjs` 的 `runProject` 主循环每个 step 完成后更新心跳：

```javascript
for (let step = 0; step < maxSteps; step++) {
  state = await loadState(projectRoot);
  state.last_heartbeat = new Date().toISOString();
  await saveState(projectRoot, state);
  // ... 原有 switch/case 逻辑
}
```

同时通过回调更新 `runJobs` Map 中的内存级心跳（避免前端每次都读磁盘）：

```javascript
// app-server 启动 runProject 时传入回调
const job = { promise: null, startedAt, lastHeartbeat: startedAt, status: 'running', error: null };
job.promise = runProject(projectRoot, {
  ...options,
  onHeartbeat: () => { job.lastHeartbeat = new Date().toISOString(); }
}).then(() => { job.status = 'done'; })
  .catch(err => { job.status = 'error'; job.error = err.message; });
runJobs.set(projectRoot, job);
```

### 1.4 优雅退出与异常恢复

`runProject` 用 try/catch 包裹，确保任何退出路径都正确更新状态：

```javascript
export async function runProject(projectRoot, options = {}) {
  state.project_status = "running";
  await saveState(projectRoot, state);
  try {
    // ... 主循环
  } catch (error) {
    state = await loadState(projectRoot);
    if (error instanceof ProjectBlockedError) {
      state.project_status = "blocked";
      state.blocked_reason = error.reason;
    } else {
      state.project_status = "interrupted";
      state.interrupted_reason = error.message;
      state.interrupted_at = new Date().toISOString();
    }
    await saveState(projectRoot, state);
    await appendEvent(projectRoot, { type: "project_interrupted", message: error.message });
    throw error;
  }
}
```

新增状态值 `"interrupted"` — 区别于 `"blocked"`（需要用户决策）和 `"idle"`（从未运行）。

### 1.5 重试 API

新增 `POST /api/run/retry`：

- 检查 runJobs 中是否有活跃任务（status === 'running'），有则返回 409
- 将 `project_status` 从 `"interrupted"` 重置，恢复到中断前的 stage
- 重新启动 `runProject()`（从中断处继续，不重做已完成的工作）
- 返回 `{ ok: true, message: "已从中断处继续" }`

### 1.6 前端状态判定矩阵

| agent_alive | project_status | heartbeat 年龄 | 前端显示 |
|---|---|---|---|
| true | running | < 30s | 正常运行（绿色） |
| true | running | 30-60s | 运行中但响应慢（黄色） |
| true | running | > 60s | 疑似卡死（橙色 + 重试按钮） |
| false | running | 任意 | 已中断（红色 + 重试按钮） |
| false | interrupted | 任意 | 已中断（红色 + 重试按钮 + 原因） |
| false | blocked | 任意 | 需处理（橙色 + 处理入口） |
| false | idle | 任意 | 待命（灰色） |
| false | completed | 任意 | 已完成（绿色） |

---

## 二、Codex 风格任务队列系统

### 2.1 概念映射

| Codex 概念 | WWriting 映射 |
|---|---|
| 用户提交 task | 用户发送 `/write`、`/review` 或自然语言指令 |
| Task 在沙箱执行 | 智能体在后台完成章节流水线 |
| Task 状态可见 | 对话流中内联任务卡片，阶段级子任务进度 |
| Task 完成展示结果 | 结果摘要卡片（字数、用时、费用） |
| Accept/Reject | 自动接受，用户随时可回看 |

### 2.2 任务生命周期

```
queued → running → completed
                 → interrupted (可从中断处继续)
                 → cancelled (用户主动停止，草稿保留)
```

每个任务内部有子任务（阶段），对应 STAGE_ORDER：

```
任务：写第4章
├─ [✓] planning    规划完成 · 12s
├─ [●] drafting    写作中 · 段落 4/8
├─ [ ] reviewing   等待中
├─ [ ] finalizing  等待中
└─ [ ] summarizing 等待中
```

### 2.3 队列式执行

用户可以连续提交多条指令，系统按顺序执行：

```
用户: /write 写第4章，林夕出场
用户: /write 写第5章，林夕和主角第一次对话
用户: /review 审稿第3章

→ 队列：[写第4章(running)] → [写第5章(queued)] → [审稿第3章(queued)]
```

当前任务完成后自动开始下一个。用户可以取消队列中等待的任务。

### 2.4 指令拆解

笼统指令自动拆解为多个任务：

```
用户: /write 写到第8章

→ 系统拆解为：
  [写第4章] → [写第5章] → [写第6章] → [写第7章] → [写第8章]
```

精确指令直接入队：

```
用户: /write 写第4章，加入新角色林夕
→ 直接入队为一个任务
```

### 2.5 取消与中断

- **停止按钮**：任务卡片上显示，点击后中断当前运行
- **中断行为**：已写内容保留为草稿，状态变为 `cancelled`
- **队列中的任务**：可直接移除，无副作用
- **后端实现**：通过 AbortController 信号传递给 agent-engine

### 2.6 后端任务队列数据结构

```javascript
// 新增 task-queue.mjs
class TaskQueue {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.tasks = [];        // { id, instruction, status, stages, createdAt, ... }
    this.currentIndex = 0;
  }

  enqueue(instruction) { /* 添加任务到队列末尾 */ }
  cancel(taskId) { /* 取消指定任务 */ }
  abort() { /* 中断当前运行的任务 */ }
  next() { /* 完成当前任务后，启动下一个 */ }
  getState() { /* 返回队列快照供前端渲染 */ }
}
```

持久化：队列状态写入 `task_queue.json`，应用重启后可恢复。

---

## 三、对话流交互设计

### 3.1 任务卡片（内联在对话流中）

用户提交指令后，对话流中立即出现任务卡片：

**排队状态：**
```
┌─ 任务 #4 ─────────────────────────────────────────┐
│  /write 续写第4章，加入新角色"林夕"的出场           │
│  状态：排队中（前面还有 1 个任务）                   │
│  [取消]                                            │
└───────────────────────────────────────────────────┘
```

**运行状态：**
```
┌─ 任务 #4 · 运行中 ────────────────────────────────┐
│  /write 续写第4章                                   │
│  ┌────────────────────────────────────────────────┐│
│  │ ■■■■■■■■□□□□□  规划 → [写作] → 审稿 → 定稿    ││
│  └────────────────────────────────────────────────┘│
│  ├─ [✓] 规划    完成 · 12s                         │
│  ├─ [●] 写作    段落 4/8 · 最后活动 3s 前           │
│  ├─ [ ] 审稿    等待中                             │
│  └─ [ ] 定稿    等待中                             │
│  [停止]                                            │
└───────────────────────────────────────────────────┘
```

**完成状态：**
```
┌─ 任务 #4 · 完成 ──────────────────────────────────┐
│  第4章「林夕初登场」                                │
│  字数：2,847 字 · 用时 3m12s · 8 次调用 · ¥0.12    │
│  [阅读全文]  [继续下一章]  [审稿修订]               │
│  ▸ 展开详细日志 (12 条事件)                         │
└───────────────────────────────────────────────────┘
```

**中断状态：**
```
┌─ 任务 #4 · 已中断 ────────────────────────────────┐
│  中断原因：API 请求超时 (deepseek-v4-pro)           │
│  中断位置：写作阶段 · 段落 5/8                      │
│  [从中断处继续]  [重新开始]  [放弃]                  │
└───────────────────────────────────────────────────┘
```

### 3.2 上下文恢复卡片

打开项目时，对话流顶部显示恢复卡片：

```
┌─────────────────────────────────────────────────────┐
│  我的小说                                            │
│  上次进展：第3章 · 审稿阶段 · 2小时前                │
│  总进度：3/12 章完成 · 18,432 字                     │
│  ──────────────────────────────────────────────────  │
│  [继续写作]  [查看章节]  [审稿]                      │
└─────────────────────────────────────────────────────┘
```

如果上次是中断状态，显示中断恢复卡片（见 3.1 中断状态）。

### 3.3 空状态引导

项目打开但对话流为空时：

```
┌─────────────────────────────────────────────────────┐
│  准备好了。你可以：                                   │
│                                                      │
│  /write   开始或续写章节                              │
│  /review  审稿修订                                   │
│  /ask     临时提问                                   │
│                                                      │
│  或者直接输入你的写作指令。                            │
└─────────────────────────────────────────────────────┘
```

### 3.4 对话流视觉节奏

- **用户气泡**：右对齐，深色背景，简洁
- **任务卡片**：全宽，带边框和阶段进度，是对话流的主体
- **系统事件**：居中，极小字号，灰色，不抢注意力
- **详细日志**：默认折叠在任务卡片内，点击展开

---

## 四、Topbar 与信息层次

### 4.1 信息层次原则

- **第一层（即时可见）**：项目名 + 状态 pill + 重试/停止按钮
- **第二层（扫一眼）**：进度条 + 章节/字数统计
- **第三层（需要时看）**：详细日志、模型配置、费用（在任务卡片和抽屉中）

### 4.2 Topbar 改造

```
┌──────────────────────────────────────────────────────────────┐
│  我的小说          [● 写作中·第3章] [停止]     [⚙] [📖]     │
│  ▰▰▰▰▰▰▰▱▱▱▱▱  3/12 章 · 18,432 字 · deepseek-v4-pro      │
└──────────────────────────────────────────────────────────────┘
```

状态 pill 颜色编码：绿色=运行中、黄色=响应慢、红色=中断、灰色=待命。

按钮逻辑：
- 运行中 → 显示 [停止]
- 中断/卡死 → 显示 [重试]
- 待命/完成 → 不显示额外按钮

---

## 五、技术约束与边界

- **不引入 WebSocket/SSE** — 保持轮询架构，通过心跳+探针解决真实性
- **不改变 agent_state.json 核心结构** — 只新增字段
- **向后兼容** — 旧项目无 last_heartbeat 时降级为纯状态文件判断
- **单进程模型** — app-server 和 agent-engine 同进程，runJobs Map 可靠
- **新增文件** — `task-queue.mjs`（队列管理）、`task_queue.json`（持久化）
- **新增 API** — `/api/run/retry`、`/api/queue/state`、`/api/queue/cancel`

---

## 六、实现优先级

### P0（核心 — 必须先做）
1. 后端：runJobs 结构升级 + 进程存活探针
2. 后端：agent-engine try/catch + interrupted 状态 + 心跳
3. 后端：`/api/run/retry` 端点（从中断处继续）
4. 前端：状态判定矩阵 + 真实性指示器 + 重试按钮
5. 前端：停止按钮（中断正在运行的任务）

### P1（Codex 工作流 — 紧随其后）
6. 后端：TaskQueue 类 + 队列持久化
7. 后端：队列 API（`/api/queue/state`、`/api/queue/cancel`）
8. 后端：指令拆解逻辑（笼统指令→多任务）
9. 前端：任务卡片组件（排队/运行/完成/中断四种状态）
10. 前端：阶段进度条 + 子任务列表

### P2（体验打磨）
11. 前端：上下文恢复卡片（session head 改造）
12. 前端：Topbar 进度条 + 状态 pill 改造
13. 前端：空状态引导卡片
14. 前端：对话流视觉节奏优化
15. 前端：任务完成结果摘要卡片

---

## 七、测试策略

- 后端：模拟 agent 崩溃 → 验证状态文件正确回退为 interrupted
- 后端：模拟心跳超时 → 验证 dashboard 返回正确的 agent_alive + heartbeat
- 后端：队列测试 → 提交多任务、取消、中断、恢复
- 前端：mock 各种状态组合 → 验证 UI 显示正确
- 集成：启动 agent → 中途 kill → 验证前端显示"已中断" + 重试可用
- 集成：提交 3 个任务 → 验证队列式执行 + 自动推进
