# WWriting 三组件 UX 增强设计规格

## 概述

本规格针对三个使用痛点，引入**三个互相独立**的前端组件：

1. **活动条（Activity Strip）** — 运行中实时显示"在干什么 / 还要多久"
2. **故障卡（Failure Card）** — 出错/blocked 后给出"一句话原因 + 具体下一步"
3. **快捷动作栏（Quick Rail）** — 把高级功能从抽屉里 promote 到常驻入口

设计边界：**保留三栏布局，加独立组件**，不重写主对话流、不改后端 schema 版本、不引入新依赖。

## 与已有 spec 的关系

| 项 | 已有 `ux-agent-status-truthfulness` spec | 本 spec |
|---|---|---|
| `agent_alive` / 心跳 / `interrupted` 状态 | 定义并落地（必须先做） | **直接消费**，不重复定义 |
| `task_queue.json` / TaskQueue / 队列 API | 定义并落地 | **不依赖**（活动条只读 `agent_state.json` 和 `run_log.jsonl`） |
| 任务卡（队列内联在对话流） | 覆盖"正常路径"任务展示，**包含中断态恢复按钮** | **不并存**；详见 §1.2.1 互斥规则 |
| Topbar 状态 pill + 进度条 | 项目级状态 | **保留**；活动条聚焦 segment/工具级粒度，是顶栏的补充而非替代 |
| 抽屉常驻 / 信息架构重排 | 未覆盖 | 由 Quick Rail 补齐 |

**前置依赖**：本 spec 假设 `ux-agent-status-truthfulness` 的 P0 已落地（`agent_alive` 字段、`interrupted` 状态、`/api/run/retry` 已可用）。如果未落地，活动条仍可工作但 ETA/blocked 判定会退化为纯磁盘读。

---

## 设计决策汇总

| 维度 | 决策 |
|---|---|
| 改造规模 | 中等：加独立组件，三栏布局不动 |
| 后端 schema 变更 | 仅扩展 `/api/dashboard` 返回字段，不升级 schema_version |
| 新增 artifact | `failures.jsonl`（纯衍生，可重建） |
| 新增依赖 | 零（vanilla JS + CSS，复用现有色板） |
| 组件耦合 | 三个组件互相独立，可分别落地、分别回滚 |
| 数据派生 | 全部前端，集中在 `agent-truth.mjs` |
| 安全边界 | 所有 action 走现有 `/api/commands/submit`，复用旁路询问的隔离机制 |
| 测试栈 | 沿用 Node test + `verify:app-shell`，**不**引入浏览器无头测试（`/browse` 在该环境不可用） |
| 上线节奏 | 三个独立 PR：故障卡 → 活动条 → Quick Rail |

---

## 一、活动条（Activity Strip）

### 1.1 问题诊断

顶栏只有"项目状态药丸"和"已完成章节"两个粒度，运行中用户无法回答：
"它现在在写哪一段？""刚才调了什么工具？""预计还要多久？""这一章烧了多少钱？"

`run_log.jsonl` 里有完整事件，但用户不会去翻日志。

### 1.2 位置与可见性

主列顶栏正下方常驻一条横向带，高度运行中 36px / idle 28px。

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ● drafting   │ 第 7 章 · seg 3/5 │ → write_segment │ 02:14 / ~05:30 │ ¥0.18 │ [▾]
└──────────────────────────────────────────────────────────────────────────┘
   阶段药丸       任务定位          最近工具调用       时间             成本
```

### 1.3 五个槽位

> **术语**：spec 全文用 `stage` 与源码对齐——`agent_state.current_stage` / `dashboard.summary.currentStage` 是真实字段。"阶段"在中文文案里保留，但不要在代码或字段名里用 `phase`。

| 槽 | 内容 | 数据来源 | 缺数据时 |
|---|---|---|---|
| 阶段药丸 | `summary.currentStage` + 颜色（同 topbar 状态色） | `dashboard.summary.currentStage` 优先；fallback `state.current_stage` | 整条隐藏 |
| 任务定位 | "第 N 章 · seg M/总段数" | `state.current_chapter_no` + `chapter_index.json[N].segments_planned` | 显示"第 N 章"，省略 segment |
| 最近工具调用 | 工具名 + 状态符号（→ 进行中 / ✓ 完成 / ✗ 失败） | `dashboard.recent_tool_events[0]`（新增字段） | 槽位空白 |
| 时间 | "已用 / 预计" | 已用：当前阶段进入时间；预计：最近 5 章同阶段中位数 | 预计显示 `—`，**不假装能预测** |
| 成本 | 当前章节累计 | `cost.json` 章节增量 | 显示 `—` |

### 1.4 状态规则

- **运行中**：完整显示，36px。
- **idle / 完成**：折叠为单行摘要"第 N 章 已完成 · 累计 ¥X · 耗时 Y 分钟"，28px。
- **blocked / interrupted**：阶段药丸变红 + "需处理"文案 + 右侧出现"查看处方"链接（点击滚动到对应故障卡 + 高亮 1.2s）。

  > **职责区分**：顶栏状态药丸反映**项目级**状态（运行 / 待命 / 中断 / 完成），活动条阶段药丸反映**当前阶段**（planning/drafting/reviewing/…）。两者都可能变红——顶栏红表示"整个项目卡住了"，活动条红表示"当前这个阶段失败了"。颜色重复是有意的：让用户在任何视线焦点都能看到故障信号。
- **隐私模式开启**：任务定位、工具名打码（成 `█████`），时间/成本不变。

### 1.5 交互

- 点击阶段药丸 → 展开 6 行迷你时间线（最近 6 个阶段切换 + 进入时间）。
- 点击任务定位 → 滚动到对应章节卡 + 高亮。
- 点击成本 → 打开 Quick Rail 的"成本"抽屉。
- 工具名变化时轻闪一下（150ms 背景过渡），不滚动、不动画堆叠。

### 1.6 派生函数（前端）

```js
// src/app-shell/agent-truth.mjs
// 现有 computeAgentTruth 不动；本期新增 3 个 named exports（deriveActivity / deriveFailures / deriveBadges）
export function deriveActivity(dashboard) {
  // dashboard 包含: state, summary, recent_tool_events, cost, chapter_index, agent_alive
  return {
    stage,            // string | null  (字段名 stage，与源码对齐)
    chapterNo,        // number | null
    segCurrent,       // number | null
    segTotal,         // number | null
    lastTool: { name, status: 'pending'|'ok'|'failed', ts } | null,
    elapsedMs,        // number | null
    etaMs,            // number | null  // null 不显示
    spentCost,        // number | null
    mode: 'running' | 'idle' | 'blocked' | 'interrupted' | 'completed'
  };
}
```

> **关键约束**：不重写 `computeAgentTruth`；新派生函数完全 additive。`agent-truth.mjs` 现有调用方（topbar 状态药丸等）零影响。

### 1.7 后端扩展

`/api/dashboard` 响应新增字段：

```json
{
  "recent_tool_events": [
    { "id": "evt_123", "type": "tool_call", "tool": "write_segment", "status": "pending", "ts": "..." }
  ]
}
```

后端实现：读 `run_log.jsonl` 最后 20 条 `tool_call*` / `file_write*` 事件，按 ts 倒序返回。

---

## 二、故障卡（Failure Card）

### 2.1 问题诊断

当前 `tool_call_rejected` / `quality_gate_failed` / `project_blocked` 等事件以 toast 一闪而过，或埋在事件流抽屉里。用户既看不懂英文 code，也不知道按哪里恢复。

### 2.1.1 与任务卡的互斥规则（关键）

任务卡（来自 `ux-agent-status-truthfulness` spec §3.1）已经会在 `interrupted` 状态下渲染「从中断处继续 / 重新开始 / 放弃」三个按钮。如果故障卡再独立渲染另一组按钮，**同一事件产出两组可交互入口，命令大概率不一致**。

**互斥规则**（写到两份 spec 的互引段落）：

- 故障卡**嵌入到对应任务卡内部**，作为 `task-card > .interrupt-section` 的内容渲染——不在 thread 中独立成卡。
- 任务卡的「从中断处继续 / 重新开始 / 放弃」三个按钮**整体被故障卡的 actions 替代**（同一 `eventId` 只能产出一组 actions）。
- 同一 `eventId` 不得同时产出 `task-card-actions` 和 `failure-card-actions`——以 `eventId` 在 `task-queue.json` 和 `failures.jsonl` 之间做去重协议。
- 若任务卡因数据缺失无法定位（例如 TaskQueue 未实现），故障卡降级为 thread 中独立卡片，但顶部加 "无关联任务"标签提醒。

### 2.2 数据模型

```ts
FailureCard = {
  id: string,              // 与 run_log 事件 id 一致；幂等去重键
  seq: number,             // 当章节内的故障序号 #N
  chapterNo: number,
  kind: 'words-short' | 'tool-rejected' | 'budget-exhausted'
      | 'provider-error' | 'review-failed' | 'unknown',
  title: string,           // 一句话人话标题
  body: string,            // 2-4 行：是什么 / 智能体停在哪 / 等你做什么
  ts: string,              // ISO
  actions: Action[],       // 1-3 个；按顺序展示
  diagnostics: {
    eventId: string,
    tool: string | null,
    promptHash: string | null,
    logPath: string,       // 相对项目根的路径，可点击复制
    rawError: string | null
  },
  resolution: null | {     // 用户选择后填充
    action: string,
    submittedAt: string
  }
}

Action = {
  label: string,           // 中文动词，不出现 retry/skip 等英文
  command: SubmitCommand,  // 走 /api/commands/submit
  destructive?: boolean    // true → 按钮加红色边线
}
```

### 2.3 六种 kind 与处方模板

模板**写在前端**（用户可见文案）+ 命令名**写在前后端共享白名单常量文件**（命令安全边界）。

**事实校准**（源码读取后的真实事件结构，agent-engine.mjs:301-340, 806-841, 927-961）：

- `project_blocked` 事件：`type='project_blocked'`，`message=<reason>`（具体取值见下），`data=<arbitrary>`，由 `blockProject(reason, data)` 统一写入
- `quality_gate_failed` 事件：`type='quality_gate_failed'`，`message='word-count gate failed'` 或 `'skill quality gate failed'`，`data=gate` 或 `data: { failed_gates }`，`data.kind`/`data.failed_gates[0].kind` 表示具体门禁名
- `tool_call_rejected` 事件：`type='tool_call_rejected'`，由 ToolValidationError 或 model_output_invalid 路径写入
- **不存在** `provider_error` 独立事件类型；provider 异常落入 `project_blocked.message=<error.code>`

| UI kind | 源事件 → 判定字段 | 标题文案 | actions（按顺序） |
|---|---|---|---|
| `words-short` | `quality_gate_failed.message='word-count gate failed'` | 字数不足 | "补写 X 字" / "接受当前字数继续" / "跳过本段" |
| `tool-rejected` | `tool_call_rejected.*` 或 `project_blocked.message in {'model_output_invalid','unsupported_tool'}` | 工具调用被拒 | "让它重试" / "改提示词后重试" / "停在这里我手动处理" |
| `budget-exhausted` | `project_blocked.message in {'model_call_budget_exhausted','revision_budget_exhausted'}` | 预算已用尽 | "提高预算到 X" / "停在这里" |
| `provider-error` | `project_blocked` 且 `message` 不在上述已知集合内（兜底为 provider/网络异常） | 模型服务出错 | "重试当前段" / "切换备用模型" / "停在这里" |
| `review-failed` | `quality_gate_failed.message='skill quality gate failed'` | 审稿未通过 | "让它按建议改写" / "接受当前稿" / "我来人工改" |
| `unknown` | 其余 `project_blocked` / `quality_gate_failed` | 出现异常 | "重试" / "停在这里" |

**判定算法（前端 `deriveFailureCard`）**：按上表从上到下匹配；任何字段缺失或匹配失败 → `kind=unknown`，渲染最小 action 集。**不修改 agent-engine**——本期不引入 `reason` 字段，只对现有 `message` 做字符串映射。

> **后续可选改进（不在本期）**：在 `blockProject` 加 `category` 枚举字段提升匹配稳定性，避免依赖 `message` 字面值。

**命令白名单与参数 schema**（共享常量文件 `src/shared/failure-commands.mjs`，前后端各 import；verify-app-shell 字面值守卫）：

```js
// src/shared/failure-commands.mjs
export const FAILURE_COMMANDS = {
  'retry-segment':           { args: {} },
  'retry-with-prompt':       { args: { prompt: { type: 'string', maxLength: 2000 } } },
  'pause-here':              { args: {} },
  'accept-current-words':    { args: {} },
  'skip-segment':            { args: {} },
  'fill-words':              { args: { targetWords: { type: 'integer', min: 1, max: 50000 } } },
  'raise-budget':            { args: { newMaxModelCalls: { type: 'integer', min: 1, max: 10000 } } },
  'switch-model':            { args: { modelId: { type: 'string', source: 'allowed-models-only' } } },
  'apply-review-suggestions':{ args: {} },
  'accept-review-current':   { args: {} },
  'manual-review-handoff':   { args: {} }
};
```

**后端校验流程**（`/api/commands/submit` 入口）：

1. `command` 必须在 `FAILURE_COMMANDS` 的 key 中，否则 400 + 写 `command_rejected` 审计事件
2. 按 schema 校验 `args`：类型、长度、min/max 上界
3. `source: 'allowed-models-only'` 表示 `modelId` 必须在当前 effective config 的 model 列表中（不能切到任意 provider）
4. `failureId` 必须能在 `failures.jsonl` 中找到对应记录，且 `resolution === null`（未消费）——防止重放与命令猜测攻击
5. 校验通过后写 `failure_resolved` 事件 + 更新 `failures.jsonl` 中该条的 `resolution` 字段（原子重写）

### 2.4 渲染位置

故障卡按 `ts` 插入到 thread 对话流中——与 task card / 用户消息按时间合流，**不脱离上下文**。点击 "处理后" 不消失，变灰显示"已选：补写 513 字 · 02:18"作为历史。

### 2.5 生成与生命周期

- 后端 `agent-engine` 在写 `tool_call_rejected` / `quality_gate_failed` / `project_blocked` 事件时，**同时**调用 `deriveFailureCard(event, state, chapterIndex)` 写入 `failures.jsonl`。
- 失败时不阻塞主流程；`failures.jsonl` 是纯衍生文件，前端可从 `run_log.jsonl` 即时派生兜底。
- 前端从 `/api/dashboard.failures` 取数；按 `id` 去重；自动恢复（非用户处理）的事件显示"已自动恢复"摘要而非交互卡。

**写入前清洗（关键安全 / 性能边界）**：

- `title` ≤ 80 字符
- `body` ≤ 500 字符
- `diagnostics.rawError` ≤ 500 字符（**provider 远程返回内容可控**，需强制截断）
- 所有字符串字段写入前 `.replace(/[\u0000-\u001f\u007f]/g, ' ')`，去除控制字符
- `/api/dashboard.failures` 服务端只返回最近 **N=10 条未处理 + 最近 5 条已处理**，避免单 dashboard 响应膨胀到 MB 级
- 长项目下 `failures.jsonl` 按章节归档：每完成一章移到 `failures.archive.jsonl`（首次实现可以不做，监控增长率后再决定）

### 2.6 API

```
POST /api/commands/submit
Body: { projectRoot, command, args, failureId }
Response: { ok: true, jobId? } | { ok: false, error }
```

复用现有受控入口；新增的命令名走前后端同步白名单，**前端永远不直接修改 `agent_state.json`**。

### 2.7 与现有 toast 的关系

- toast 仅承担"非阻塞性提醒"（保存成功、设置已变更）。
- 所有可能让用户卡住的事件**改为故障卡**，toast 不再承担。
- 旧的 `*_rejected` 事件在事件流（drawer · 运行）里仍可看到，作为审计来源。

### 2.8 安全

- `body` / `title` / `diagnostics.*` 强制 `textContent` 渲染，禁止 HTML 注入。
- `diagnostics.logPath` 仅显示与"复制路径"，不提供前端文件读取入口。
- 所有 action 必须落到命令白名单，未知 command 在 `/api/commands/submit` 入口拒绝并写审计事件。

---

## 三、快捷动作栏（Quick Rail）

### 3.1 问题诊断

技能管理、资料搜索、成本分析、Reviewer 输出全部藏在抽屉 + 抽屉内 tab 切换两层之下。用户既不知道有这些功能，知道了也不愿意每次都点两下。

### 3.2 位置

主列右边缘常驻 48px 窄条。drawer 打开时 Quick Rail 仍可见，对应图标变"选中"态。

```
┌──┐
│📖│  章节
│🧩│  技能
│📎│  资料
│💰│  成本
│🔍│  审查
│  │
│⚙ │  设置（分组底）
└──┘
```

### 3.3 五个槽位 + 徽章

| 槽 | 触发抽屉视图 | 徽章规则 | 徽章数据 |
|---|---|---|---|
| 章节 | `drawer/chapters` | 完成/总数；运行中变化时轻闪 | `chapter_index.json` |
| 技能 | `drawer/skills`（新增 tab） | 启用数，无启用时不显示数字 | `project.yaml.skills` |
| 资料 | `drawer/research`（新增 tab） | 自上次打开后新增来源数；红点 | `sources/` 目录 + localStorage 时间戳 |
| 成本 | `drawer/cost`（新增 tab） | 预算占比 ≥80% 琥珀；超出红色 | `cost.json` + `project.yaml.budget` |
| 审查 | `drawer/reviewer`（新增 tab） | 有未读 Reviewer 报告时红点 | `reviewer_report.json` + localStorage 时间戳 |
| 设置 | `settings-modal` | 无徽章 | — |

### 3.4 两种交互层级（用户成本递增）

1. **悬停浮窗预览（200ms 延迟）**：显示该槽位 4–6 行摘要。例如成本浮窗：

   ```
   今日 ¥1.23
   本章 ¥0.18
   预算剩余 ¥48.77 / 50.00
   平均每章 ¥0.09
   ```

   鼠标移开自动消失。**不点开抽屉就能瞄一眼**——可发现性的关键。
2. **左键单击**：打开对应 drawer tab。

**显式不做**：右键上下文菜单 / "钉为常驻面板"——挪到未决问题，避免占测试矩阵但不实现。

### 3.5 键盘

- `Alt+1..5` 分别对应五个槽位。
- `Esc` 关闭 drawer 和任何浮窗预览。
- 键位写入帮助菜单（属于"可发现性"配套）。

### 3.6 抽屉 tab 变更

| 操作 | 现状 | 变更 |
|---|---|---|
| `drawer/chapters` | 已有 | 不变 |
| `drawer/model` | 已有 | 不变（不在 Quick Rail，因为模型走顶级设置弹窗） |
| `drawer/run` | 已有 | 不变 |
| `drawer/skills` | 无 | **新增**（见 3.6.1） |
| `drawer/research` | 无 | **新增**（见 3.6.1） |
| `drawer/cost` | 无 | **新增**（见 3.6.1） |
| `drawer/reviewer` | 无 | **新增**（见 3.6.1） |

#### 3.6.1 新增 tab 的最小可行内容

本期每个新 tab 只做"信息呈现 + 基础操作"，不重写后端逻辑：

| Tab | 最小内容 | 数据源 |
|---|---|---|
| `drawer/skills` | 已启用 / 可用未启用两个分组；每项显示 name·version·type；启用/禁用切换按钮 | `project.yaml.skills` + 现有 `/api/skills` |
| `drawer/research` | 来源列表（标题 + 域名 + 抓取时间）；点击展开摘要；"新增"小红点 | `sources/` 目录 + `sources.md` |
| `drawer/cost` | 今日 / 本章 / 累计三块数字；按章节柱状条；预算条 | `cost.json` + `project.yaml.budget` |
| `drawer/reviewer` | 最新 reviewer 报告全文 + 历史报告下拉切换 | `reviewer_report.json` + `reviewer_reports/*.json` |

**显式不做**：技能导入向导、来源全文阅读器、成本图表导出、reviewer 报告 diff——属于后续迭代。

### 3.7 顶栏按钮收敛

- **移除时机**：与 Quick Rail 同一个 PR（P2）一并落地，**不能在 P1 PR 提前移除**——否则 P1（活动条）上线后到 P2 之间有"成本槽点击无目标"的窗口期（§1.5 活动条点击成本依赖 Quick Rail 已存在）。
- P2 PR 内：移除顶栏 `章节` 和 `面板` 按钮，保留 `停止 / 重试 / 隐私`，同时挂载 Quick Rail。
- 窄屏（<1100px）：Quick Rail 折叠为顶栏右侧单图标按钮，点击展开为覆盖式快捷菜单。
- **P1 阶段**：活动条点击成本/章节槽位 fallback 到现有 drawer 按钮的目标（章节抽屉 / `drawer/run`）。

### 3.8 徽章数据派生

```js
// agent-truth.mjs 扩展（现有 computeAgentTruth 不动，新增 named exports）
export function deriveBadges(dashboard, projectRoot, lastSeen) {
  // lastSeen = { research: ts, reviewer: ts }, 由调用方从 localStorage 取
  return {
    chapters: { done, total, ticking: boolean },
    skills: { enabledCount },
    research: { newSinceLastVisit },         // 与 lastSeen.research 比对计算
    cost: { used, budget, pct, level: 'normal'|'warning'|'over' },
    reviewer: { hasUnread, lastReportTs }
  };
}
```

**localStorage key 规范**（多窗口 / 多项目下不互相清空）：

- key 形如 `wwriting:lastSeen:<sha256(projectRoot).slice(0,16)>:<tab>`
  - 例：`wwriting:lastSeen:8a3f9c7e1b2d4e5f:research`
- 仅存 ISO 时间戳字符串，不超过 32 字节/项
- 监听 `window.addEventListener('storage', ...)`：另一窗口写入同 key 时即时更新当前窗口徽章，避免脏读
- 不写入项目文件——纯本地客户端状态

---

## 四、跨切关注点

### 4.1 数据流

```
[ agent-engine ]──写──▶ run_log.jsonl
                    └──▶ agent_state.json
                    └──▶ chapter_index.json
                    └──▶ cost.json
                    └──▶ failures.jsonl  (新增·纯衍生)
        │
        ▼
[ /api/dashboard ] ── 聚合 ──▶ DashboardSnapshot {
        ...existing,
        recent_tool_events,            // 新增
        failures,                       // 新增
        sources_summary,                // Quick Rail 资料徽章用
        reviewer_summary                // Quick Rail 审查徽章用
}
        │
        ▼
[ 前端 agent-truth.mjs ]
  ├─ deriveActivity()  → 活动条
  ├─ deriveFailures()  → 故障卡（与 thread 事件按 ts 合流）
  └─ deriveBadges()    → Quick Rail 徽章
        │
        ▼
[ 三个独立组件渲染 ]
```

### 4.2 轮询节奏

- 运行中：现有节奏（~1s）。
- idle：退化为 5s（节省 CPU）。
- 用户提交命令后：立即额外拉一次。
- **不引入新 WebSocket / SSE**。

**idle 短路返回**（新增字段必须有 mtime 短路，否则长项目 idle 下每 5s 重读三套全量磁盘内容）：

| 字段 | 短路依据 | idle 时行为 |
|---|---|---|
| `recent_tool_events` | `run_log.jsonl` mtime ≤ 上次返回时刻 | 返回上次缓存（响应体头部加 `cached: true`） |
| `sources_summary` | `sources/` 目录 mtime ≤ 上次返回时刻 | 同上 |
| `reviewer_summary` | `reviewer_report.json` mtime ≤ 上次返回时刻 | 同上 |
| `failures` | `failures.jsonl` mtime ≤ 上次返回时刻 | 同上 |

服务端在 `/api/dashboard` 内存里维护这四个 mtime 缓存（按 projectRoot 分桶）；项目切换时清空。

### 4.3 错误处理与降级

| 失败点 | 行为 |
|---|---|
| `failures.jsonl` 损坏 | 跳过损坏行；前端从 `run_log` 即时派生兜底；活动条 / Quick Rail 不受影响 |
| `/api/dashboard` 5xx | 三个组件维持上次成功快照 + 顶部细灰条"连接中断 · 重连中"；**不清空数据** |
| `cost.json` 缺失 | 活动条成本槽显示 `—`；Quick Rail 成本槽骨架 |
| `chapter_index.json` 缺失 | 任务定位仅显示"第 N 章"，省略 segment |
| action 提交失败 | 故障卡上方红条 + 重试链接；**不替换原卡** |
| 数据未加载完 | 骨架灰点，**不显示 0**（避免误导"完成 0/100"） |
| 窄屏 | Quick Rail 折叠；活动条紧凑模式（隐藏 ETA 和成本） |
| 隐私模式 | 任务定位、工具名、故障 body 打码；ts/cost 不变 |

### 4.4 安全边界

- 所有 action 走现有受控 `/api/commands/submit`，命令名走前后端同步白名单。
- 故障卡渲染全部 `textContent`，禁止 HTML/Markdown 注入。
- Quick Rail 徽章计算完全前端，不暴露新 API 路径；现有 `/api/dashboard` 路径校验保持不变。
- `failures.jsonl` 写入走原子重命名（与现有章节文件写入一致）。

### 4.5 性能预算

- 活动条派生函数：单次调用 ≤ 5ms（cold path），≤ 1ms（warm path）。
- `recent_tool_events` 后端固定取 20 条，避免长项目读全量日志。
- Quick Rail 悬停浮窗 lazy 渲染——首次悬停才渲染节点，不预创建 5 个浮窗。

---

## 五、测试策略

| 测试 | 形式 | 覆盖 |
|---|---|---|
| `tests/app-shell/activity-strip.test.js` | 单元（jsdom 或纯函数） | `deriveActivity` 各 phase + 缺数据降级 + ETA 缺失显示 `—` + 隐私模式打码 |
| `tests/app-shell/failure-card.test.js` | 单元 | 6 种 kind 模板渲染 + `id` 幂等去重 + action 命令格式 + 已处理状态展示 |
| `tests/app-shell/quick-rail.test.js` | 单元 | `deriveBadges` 阈值（80%/100% 成本）+ 未读判定 + 窄屏折叠 + 键盘 `Alt+1..5` |
| `tests/app-shell/agent-truth-derive.test.js` | 单元 | 真实 `/api/dashboard` fixture → 三个 derive 函数稳定输出 |
| `tests/api/dashboard-extended.test.js` | 单元 | `recent_tool_events` / `failures` 字段在 artifact 缺失时返回空数组而非 5xx |
| `tests/api/failure-actions.test.js` | 单元 | 命令白名单：白名单内通过，白名单外拒绝并写审计事件 |
| `verify:app-shell` 扩展 | 端到端（无浏览器） | DOM id 一致 + 三个组件挂载 + 故障卡点击触发 `/api/commands/submit` + 命令白名单前后端字面值一致守卫（见下） |

**白名单字面值守卫实现**：

```js
// scripts/verify-app-shell.mjs 内增加
import { FAILURE_COMMANDS } from '../src/shared/failure-commands.mjs';
import { FAILURE_COMMANDS as FE_COMMANDS } from '../src/app-shell/components/failure-card.js';
import assert from 'node:assert';
const a = Object.keys(FAILURE_COMMANDS).sort().join(',');
const b = Object.keys(FE_COMMANDS).sort().join(',');
assert.strictEqual(a, b, '前后端命令白名单已漂移');
```

前端组件直接 `import { FAILURE_COMMANDS } from '../../shared/failure-commands.mjs'`，确保单一来源——上面的守卫退化为防呆。

**不引入**：浏览器无头测试、视觉回归（与现有项目栈一致；`/browse` 在该环境不可用，已记录于 memory）。

---

## 六、实现优先级与上线节奏

按"用户痛感强度 × 实现独立性"排序：

### P0 — 故障卡（独立 PR #1）

直接消除"出错不知道下一步"的硬痛点，最具体可验证。
- 后端：`failures.jsonl` 写入 + `/api/dashboard.failures` 字段 + 命令白名单 + `/api/commands/submit` 接受 failureId
- 前端：`failure-card.js` 组件 + 6 种 kind 模板 + thread 内合流插入
- 测试：单元 + 命令白名单守卫

### P1 — 活动条（独立 PR #2）

可见性升级；可以复用 PR #1 加的 `recent_tool_events` 字段。
- 后端：`recent_tool_events` 字段（如 PR #1 已经引入则无变更）
- 前端：`activity-strip.js` 组件 + `deriveActivity` + 顶栏下方挂载
- 测试：单元 + fixture 派生测试

### P2 — Quick Rail（独立 PR #3）

入口重组；依赖前两步的派生函数与 dashboard 字段。
- 后端：`/api/dashboard` 新增 `sources_summary` / `reviewer_summary`；drawer 新增 tab 数据端点
- 前端：`quick-rail.js` 组件 + `deriveBadges` + drawer 新增 tab 视图 + 顶栏按钮收敛 + 键盘绑定
- 测试：单元 + 端到端挂载

每个 PR 都有独立价值；任何一个被砍其他不受影响。

---

## 七、YAGNI 显式声明

本期**不做**：

- 主题切换 / 暗黑模式（不在本期痛点）
- 重写 composer / slash 命令系统
- 引入新组件库（React / Vue / Web Components）
- Quick Rail 的"钉为常驻面板"（预留菜单项但不实现）
- 重排现有 drawer 三个 tab（chapters / model / run）顺序——只新增 tab
- 故障卡的"AI 自动诊断"——所有处方模板写死，不调模型
- 活动条的 ETA 机器学习预测——只用历史中位数，无数据显示 `—`
- 跨项目通知 / 桌面通知 / 邮件提醒

---

## 八、未决问题

| 问题 | 当前倾向 | 待定原因 |
|---|---|---|
| `failures.jsonl` 是否应该 GC 历史？ | 按章节归档（每完成一章移到 `failures.archive.jsonl`） | 等长跑数据看实际增长率 |
| Quick Rail 五个槽位是否允许用户自定义？ | 不允许（避免选择疲劳） | 等用户反馈是否有强需求 |
| 故障卡命令成功后是否提示"正在处理中"？ | 是；卡片变灰 + 显示选择 + 顶部加进度指示 | 与活动条信息可能重复，需协调 |
| Quick Rail 右键菜单 / "钉为常驻面板" | 本期不实现；移到后续迭代 | 与本期可发现性目标无关，避免占测试矩阵 |
| 多窗口同时打开同一项目的 localStorage 写竞态 | 监听 `storage` 事件即时同步 | 是否还需要 BroadcastChannel 视实际并发情况 |
| `blockProject` 是否加 `category` 枚举字段提升匹配稳定性 | 本期不做（前端字符串映射够用） | 待 unknown 比例 > 10% 时再加 |
