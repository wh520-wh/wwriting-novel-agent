# WWriting 全面优化设计

**日期:** 2026-06-01
**范围:** 前端架构、后端可靠性、测试补全、通信性能 — 共 17 项优化
**策略:** 3 组并行（A 后端 / B 前端+通信 / C 测试），组内串行，每组独立验证
**修订:** v5 — 修复计划审查发现的 5 项执行级问题

---

## 问题全景

### 🔴 关键问题（影响可靠性）

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| 1 | 模型调用无重试/超时 | `model-client.mjs`, `provider-adapters.mjs` | 一次网络抖动阻塞整个项目 |
| 2 | 假流式传输 | `provider-adapters.mjs` | `response.text()` 读完整个响应后才逐帧触发 onToken，不是真正流式 |
| 3 | 适配器硬编码 | `agent-engine.mjs:490-503` | 添加新 provider 必须改引擎 |
| 4 | 事件日志长项目性能 | `event-log.mjs` | `readEvents()` 全量读取，心跳循环每轮 O(n) |

### 🟡 架构债务（影响可维护性）

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| 5 | app.js 2652 行单体 | `app-shell/app.js` | 13 个可变模块级变量无所有权边界 |
| 6 | styles.css 1422 行 | `app-shell/styles.css` | 底部追加样式与原始定义冲突 |
| 7 | agent-engine 1083 行 | `core/agent-engine.mjs` | 4 个独立关注点混在一起 |
| 8 | 状态共享无锁 | `agent-engine`, `app-server`, `task-queue` | 并发读写 state.json 可能竞态 |

### 🟢 代码异味（影响代码质量）

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| 9 | 静默吞错误 | 多个 core 模块，10+ 处 `catch {}` | 掩盖真正的 I/O 错误 |
| 10 | HTTP 状态码+响应体不一致 | `app-server.mjs` | 状态码语义混乱，响应体混用 `message`/`error`/`code` |
| 11 | 前端组件重复逻辑 | `activity-strip.js`, `failure-card.js` | 常量/函数重复，实现不一致 |
| 12 | 轮询架构 | `app-shell/app.js` | 1.8s 轮询，请求串行，Set 无上限 |

### 🔵 测试盲区

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| 13 | npm test 遗漏 app-shell 测试 | `package.json` | 3 个测试文件永远不执行 |
| 14 | 若干核心模块缺少专门单测 | `cost-tracker`, `chapter-memory`, `retry-candidates`, `simple-yaml` 等 | 已有间接覆盖，但关键路径缺直接断言 |
| 15 | 前端组件无单元测试 | `components/` | 只靠 Electron 点击测试覆盖 |
| 16 | schema 迁移测试不足 | `task-queue` 等 | `app-server-probe.test.mjs` 已有 v1 队列路径覆盖，但缺专门迁移断言 |

---

## 优化方案：3 组并行

> **为什么是 3 组而非 4 组：** 原 D 组（通信性能）的 D1/D2/D3 都改 `app.js`，与 B 组（前端拆分）高概率冲突。已将 D1-D3 合并进 B 的对应模块抽取步骤，D4（组件渲染一致性）并入 B7。

### 组 A：后端可靠性（A1→A6 串行）

**目标:** 消除全部 🔴 关键问题 + 修复代码异味

#### A1: model-client 重试/超时

**设计:**
- `model-client.mjs` 的 `generate()` 增加内置重试逻辑
- 默认策略：指数退避，最多 3 次重试，仅对 429/502/503/网络错误重试
- 默认超时：120 秒（通过内部 `AbortController` 实现）
- 重试间隔：1s → 4s → 16s（指数退避 + 随机抖动）
- **不直接写 event-log** — ModelClient 没有 projectRoot 也没有事件记录依赖。改为暴露 `onRetry` 回调钩子，由 agent-engine 或调用方负责 appendEvent

**AbortSignal 组合语义（关键）：**
调用链已有外部 AbortSignal（用户停止/项目取消）。generate() 内部需要组合两个 signal：
- **外部 signal（调用方传入）：** 用户点击停止、项目取消。**不可重试** — 外部 abort 立即终止，返回 `AbortError`（或包装为 `UserAbortError`），调用方能区分。
- **内部 timeout signal：** 120 秒超时。**可重试** — 超时触发时按策略重试（重置 timeout），直到耗尽重试次数。
- **组合方式：** 创建内部 `AbortController`，用 `AbortSignal.any([externalSignal, timeoutSignal])` 组合（Node 20+ 支持）。每次重试创建新的 timeout controller 但复用同一个 external signal。
- **错误区分：** `ProviderTransportError` 增加 `reason` 字段：`'user-abort'` / `'timeout'` / `'network'` / `'server'`。重试逻辑只对 `'timeout'` / `'network'` / `'server'(429/502/503)` 重试，`'user-abort'` 直接抛出。

**文件变更:**
- `src/core/model-client.mjs` — 增加重试包装器 + `onRetry` 回调 + signal 组合
- `src/core/provider-adapters.mjs` — `ProviderTransportError` 增加 `reason` 字段，区分 user-abort / timeout / network / server
- `src/core/agent-engine.mjs` — `createModelRuntime` 传入 `onRetry` 回调记录到 event-log
- `tests/model-client-retry.test.mjs` — 新增测试：重试/超时/退避、用户 abort 不重试、超时可重试、reason 字段正确

#### A2: 真正 SSE 流式读取

**设计:**
- `provider-adapters.mjs` 的 `OpenAICompatibleAdapter.generate()` 当 `stream: true` 时，改用 `response.body.getReader()` 增量读取
- 实现：`ReadableStream` → `TextDecoder` → 逐行解析 SSE `data:` 帧 → 实时调用 `onToken` 回调
- 保持非流式路径不变（`stream: false` 仍走 `response.text()`）
- **usage 提取（关键）：** OpenAI-compatible 流式响应需要显式传 `stream_options: { include_usage: true }` 才稳定返回 usage。实现时：当 provider config 支持时，在请求体中加入 `stream_options`；不支持时 usage 为空对象但不报错。从最后一个 SSE chunk（`choices` 为空但 `usage` 非空的 chunk）提取 usage。
- 返回值：流式完成后返回 `{ text: 累积文本, usage: { prompt_tokens, completion_tokens, total_tokens } | {}, finishReason }`

**文件变更:**
- `src/core/provider-adapters.mjs` — 重写流式分支，使用 `ReadableStream` 增量解析 + `stream_options` 支持
- `tests/provider-adapters.test.mjs` — 新增测试：验证 `onToken` 在完整响应结束前被多次调用；验证 `stream_options` 被传入；验证无 usage chunk 时不报错

#### A3: 事件日志性能优化（保持默认兼容）

**设计:**
- `readEvents()` **无参数时保持现有全量读取语义** — 所有现有调用者（测试、reviewer-agent、脚本）依赖此行为
- **保持调用点不变** — agent-engine 心跳循环已经是 `readEvents(projectRoot, { limit: 5 })`，不需要改调用方
- **优化底层实现：** 当传入 `{ limit }` 时走尾部读取（`fs.stat` 获取文件大小 → `fs.open` + `read` 从末尾反向扫描 N 字节 → 解析最后 N 条完整行），替代当前的全量读取再 slice
- 无 limit 时保持现有 `fs.readFile` + `split` 全量读取路径
- 新增 `tailEvents(projectRoot, n)` 作为便捷方法，等价于 `readEvents(projectRoot, { limit: n })`

**文件变更:**
- `src/core/event-log.mjs` — limit 参数触发尾部读取优化（不改签名，只改实现分支）
- `tests/event-log.test.mjs` — 新增测试（尾部读取、limit 参数、大文件性能、边界情况、无 limit 仍全量）

#### A4: 适配器注入（保持直接调用兼容）

**设计:**
- `agent-engine.mjs` 的 `createModelRuntime()` 改为接收可选 `options.adapters` 参数（普通对象，与 ModelClient 现有的 `this.adapters[provider]` 索引方式一致）
- **保留默认适配器 fallback（关键）：** `runProject()` 也被测试（agent-engine.test.mjs）和脚本（verify:mvp、verify:longrun、verify:faults）直接调用，不经过 app-server。如果 createModelRuntime() 不保留默认适配器，这些调用路径会全部断裂。实现：`options.adapters` 为 undefined 时，使用当前的默认实例化逻辑（`new OpenAICompatibleAdapter()` + `new MockProviderAdapter()`）；传入时使用传入值。app-server 启动时可传入自定义 adapters 来扩展或覆盖默认值。
- 引擎做 `adapters[providerName]` 查找（不是 Map.get）
- 不新增 `provider-registry.mjs` 模块 — 注册逻辑简单（2 个适配器），放在 app-server 启动代码中即可

**文件变更:**
- `src/core/agent-engine.mjs` — `createModelRuntime` 接受可选 `options.adapters`，无则用默认
- `src/core/app-server.mjs` — 启动时可构建 adapters 对象注入（可选，不强制）

#### A5: 静默 catch 改为结构化日志

**设计:**
- 统一使用 `console.error` 或 `console.warn` 替代空 `catch {}`
- 关键路径（项目加载、设置保存、状态读取）的 catch 必须记录错误信息
- 非关键路径（如缓存读取）可以保留空 catch 但加注释说明意图
- 不引入日志框架，保持轻量

**文件变更:**
- `src/core/app-server.mjs` — 逐个检查 catch 块
- `src/core/app-state.mjs`
- `src/core/skill-runtime.mjs`
- `src/core/side-question.mjs`
- `src/core/app-dashboard.mjs`

#### A6: HTTP 状态码 + 响应体统一

**设计:**
- 状态码规范：400 = 客户端输入错误，409 = 状态冲突（如"未运行"时点停止），500 = 服务器内部错误
- **响应体统一格式：** `{ ok: false, code: "ERROR_CODE", message: "人类可读信息", details?: any }`
  - 成功响应保持现有格式不变
  - 错误响应统一用此结构，前端可按 `code` 分类处理
- 创建 `HttpError` 工具类：`new HttpError(400, 'PROJECT_NAME_REQUIRED', '项目名不能为空')`
- 所有路由的 catch 块统一调用 `sendError(res, err)`

**文件变更（仅后端）:**
- `src/core/app-server.mjs` — 统一所有路由的错误码 + 响应体格式
- `src/core/http-error.mjs` — 新工具类
- **不改前端** — 前端 `readResponseJson` 的 `ok` 字段适配由 B 组在提取 `api-client.js` 时负责，避免 A/B 并行冲突

---

### 组 B：前端架构拆分 + 通信优化（B1→B8 串行）

**目标:** 消除 🟡 架构债务 + 修复 🟢 代码异味

> **与原方案的关键区别：** D 组的通信优化（请求并行化、renderedKeys 内存控制、submitFailureAction 统一）已合并进 B 组对应步骤，避免并行修改 app.js 产生冲突。

#### 拆分顺序

1. **B1: `utils.js` + `api-client.js`** — 纯函数提取，零风险
   - `utils.js` (~120 行): formatNumber, formatCompact, formatMoney, formatTime, statusClass, pathEquals, pathBaseName, resolveModelEndpoint, ensureTrailingSlash, isEnvironmentVariableName, compactObject, cssEscape, translateStage, translateReviewStatus, translateSkillType, translateSourceKind, translateEventType
   - `api-client.js` (~34 行): getJson, postJson, readResponseJson — 提取时适配 A6 的 `{ ok: false, code, message }` 错误格式（readResponseJson 检查 `ok` 字段）
   - **含 D3：** 提取时将 `submitFailureAction` 的 raw fetch 改为使用 `postJson`

2. **B2: `icons.js`** (~50 行) — ICON_PATHS + icon() 函数

3. **B3: `thread-renderer.js`** (~700 行) — 最大拆分
   - 通过 context 对象注入依赖：`{ refs, renderedKeys, askEntries, liveBlock, lastDashboard }`
   - 导出 `syncThread`, `renderEmptyThread`, `syncFailureCards`, `updateLiveAgentBlock` 等
   - **含 D2：** 提取时为 `renderedKeys` 增加上限控制（5000 条，超限清除最早 50%）

4. **B4: `drawer-panels.js`** (~414 行) — 所有面板渲染

5. **B5: `settings-modal.js`** (~307 行) — 设置弹窗

6. **B6: `composer.js`** (~246 行) — 命令解析 + 提交
   - composer 只负责命令解析和提交，不涉及 loadDashboard

7. **B7: CSS 整理 + 组件一致性**
   - 合并底部追加的重复样式回原始位置
   - 将重复的暗色渐变统一为 CSS 变量 `--btn-gradient`
   - 建立字号体系：`--text-xs`(11px) 到 `--text-2xl`(24px)
   - 将硬编码的 scrollbar/focus-ring 颜色变量化
   - **含 D4：** `activity-strip.js` 的 `root.innerHTML = ''` 改为 `root.replaceChildren()`

8. **B8: app.js 最终瘦身**
   - 入口只负责：refs 缓存、初始化布线、loadAll/loadDashboard 编排、renderDashboard 协调、overlay/privacy/refresh 基础设施、bootstrap
   - loadDashboard 的两个请求保持串行（queue 依赖 dashboard 的 hasProject 判断，真正优化需后端合并，超出本 spec 范围）
   - 确认各模块边界清晰，现有 smoke/clickability 流程行为不回退

**文件变更:**
- `src/app-shell/app.js` — 逐模块提取
- `src/app-shell/utils.js` — 新
- `src/app-shell/api-client.js` — 新
- `src/app-shell/icons.js` — 新
- `src/app-shell/thread-renderer.js` — 新
- `src/app-shell/drawer-panels.js` — 新
- `src/app-shell/settings-modal.js` — 新
- `src/app-shell/composer.js` — 新
- `src/app-shell/styles.css` — 去重 + 变量化
- `src/app-shell/components/activity-strip.js` — replaceChildren

**每步验证:**
```powershell
npm run verify:app-shell
npm run verify:app-clickability
```

---

### 组 C：测试补全（C1 立即执行，C2-C4 在 A/B 完成后补充）

**目标:** 补充 🔵 测试覆盖盲区

#### C1: 修复 npm test glob（全项目前置，立即执行）

**设计:**
- `package.json` 的 test script 改为 `"node --test tests/*.test.mjs tests/app-shell/*.test.mjs"`

**文件变更:**
- `package.json`

#### C2: 核心模块补充单测

> **说明:** `event-log`、`fs-utils`、`usage-report`、`quality-gates`、`prompt-compiler` 已有直接或间接测试覆盖。以下列出的是真实缺口。

**新增测试文件:**
- `tests/cost-tracker.test.mjs` — 成本累加、预算检查、报告生成（目前仅通过 agent-engine 间接覆盖）
- `tests/chapter-memory.test.mjs` — 文件格式、摘录提取、跨章连续性、损坏/缺失文件路径（目前仅通过 agent-engine 的 memory continuity 测试间接覆盖）
- `tests/retry-candidates.test.mjs` — 候选选择算法（stale running / interrupted / ambiguous 分支，目前 app-server-probe 有间接覆盖但缺直接断言）
- `tests/simple-yaml.test.mjs` — YAML 解析器的基本语法、边界情况（目前通过 project-store 和 skill-runtime 间接覆盖）

#### C3: 前端组件测试（无依赖，可立即执行）

**设计:**
- `failure-card.js` 和 `activity-strip.js` 现在已经是独立组件文件，可立即补测，不依赖 B 组的拆分工作
- 使用 Node.js 内置 test runner + 简单 DOM 模拟（不需要 JSDOM/heavy 框架）
- 为每个组件测试：渲染输出、事件绑定、状态更新
- 优先覆盖 `failure-card.js`（有业务逻辑：命令白名单、时间格式化）和 `activity-strip.js`（有 STAGE_LABEL 映射和工具事件渲染）

**新增测试文件:**
- `tests/app-shell/failure-card-render.test.mjs`
- `tests/app-shell/activity-strip-render.test.mjs`

#### C4: Schema 迁移测试（补充覆盖）

**设计:**
- `app-server-probe.test.mjs` 已有 `schema_version: 1` 的队列路径覆盖
- 补充专门的迁移断言：创建 v1 格式 fixture → 验证加载后自动迁移到 v2 → 验证数据完整性
- 覆盖实际存在的 schema 文件：
  - `task_queue.json` — 已有 v1→v2 迁移路径，补专门断言
  - `agent_state.json` — 如有版本字段，补迁移测试
  - `chapter_memory.json` — 如有格式变更历史，补迁移测试
- **不测 project.json** — 项目配置是 `project.yaml`，不是 JSON；状态是 `agent_state.json`

**新增测试文件:**
- `tests/schema-migration.test.mjs`

---

## 实施策略

### 并行执行

| 组 | 依赖 | Agent 数 | 说明 |
|---|------|---------|------|
| A（后端可靠性） | 无 | 1 agent | A1→A6 串行 |
| B（前端+通信） | 无 | 1 agent | B1→B8 串行，D 已合并入对应步骤 |
| C（测试补全） | C1 无依赖；C3 无依赖（failure-card/activity-strip 已是独立文件）；C2 依赖 A3（event-log 变更） | 1 agent | 先执行 C1+C3，C2 等 A3 完成后补充 |

### 验证策略

每个组完成后必须跑：

```powershell
npm test
```

```powershell
npm run verify:app-shell
```

```powershell
npm run verify:app-clickability
```

全部完成后跑：

```powershell
npm run verify:local
```

### 风险控制

1. **前端拆分风险最高** — 每提取一个模块后立即跑 `verify:app-clickability`，失败则回滚该步
2. **后端重试逻辑** — 需要测试重试计数器、退避时间、AbortSignal 组合（用户 abort vs timeout）、onRetry 回调
3. **SSE 流式改造** — 需要 Mock SSE 服务器或精心构造的测试数据；需验证 `stream_options` 兼容性
4. **事件日志尾部读取** — 保持无参 readEvents 全量语义不变，只在有 limit 时走优化路径
5. **适配器注入兼容性** — 必须验证 `runProject()` 直接调用路径（测试 + 脚本）不受影响

---

## 成功标准

### 功能验收（必须全部通过）
- [ ] `npm test` 通过（含修复后的 app-shell 测试）
- [ ] `verify:app-clickability` 通过（所有按钮可点击、功能正常）
- [ ] `verify:app-shell` 通过
- [ ] `verify:local` 通过

### 架构验收（模块边界清晰）
- [ ] app.js 入口只负责初始化/布线/协调，渲染、API、composer、settings、drawer 各有明确模块
- [ ] styles.css 无重复规则（`.pill.completed`/`.pill.blocked` 等）
- [ ] 组件使用统一的 DOM 清理策略（`replaceChildren`）

### 可靠性验收
- [ ] model-client 有重试（429/502/503）+ 超时（120s）+ onRetry 回调
- [ ] AbortSignal 组合正确：用户 abort 不重试直接抛出，timeout 可重试，reason 字段可区分
- [ ] provider-adapters 真正流式：onToken 在响应结束前被调用；流式请求含 `stream_options.include_usage`
- [ ] event-log 支持 `readEvents({ limit })` 尾部读取，无参仍全量
- [ ] createModelRuntime 无 options.adapters 时开箱可用（测试/脚本直接调用不中断）
- [ ] 无空 `catch {}` 在关键路径（项目加载、设置保存、状态读取）
- [ ] HTTP 错误响应体统一为 `{ ok: false, code, message, details? }`

### 测试验收
- [ ] `npm test` 覆盖 `tests/app-shell/*.test.mjs`（不再遗漏）
- [ ] cost-tracker、chapter-memory、retry-candidates、simple-yaml 有专门单测
- [ ] schema 迁移有专门断言
