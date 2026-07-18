# 输入框草稿功能设计

- 日期：2026-07-18
- 状态：待实现
- 关联：高频回归 [[clickability-flaky-hover]] 不涉及；本功能碰输入框事件链路，实现后必须跑 verify:app-clickability / verify:app-shell / verify:desktop-shell。

## 1. 背景与目标

WWriting 的输入框（`#composer-input`）目前没有任何草稿持久化机制。用户在输入框打了字但还没发送时，一旦切换项目、关闭应用、或页面刷新，内容即丢失。

本功能为输入框增加"按项目隔离"的草稿持久化：未发送的文字自动保存到 localStorage，切走再切回、重启应用都能恢复；发送成功后自动清除。

## 2. 用户故事

- 在 A 小说输入框打了半段指令，切到 B 小说再切回 A，半段指令还在。
- 关闭应用明天再开，昨天没发完的话还在输入框。
- 点发送成功后，草稿清掉，输入框空着等下一条。
- 发送失败时，刚才那句话还原回输入框（现有行为），并且也作为草稿存下来（断电也不丢）。

## 3. 现状

- `src/app-shell/composer.js` 全文（980 行）无 `localStorage` / `sessionStorage` 调用，无 draft / 草稿 字样。
- `src/app-shell/app.js` 用 localStorage 存：阅读器字号（`ww:reader:fontsize`）、隐私开关（`ww:privacy`）、各项目最后查看时间（`wwriting:lastSeen:*`，见 `src/app-shell/components/last-seen.js`）。
- 项目切换统一走 `commitProjectSwitch()`（app.js:594），其调用的 `clearTransientState()`（app.js:583）会 `composerInput.value = ""`——这是草稿丢失的核心点。
- 发送成功后多处 `composerInput.value = ""`（composer.js:710 / 743 / 785 / 823）；发送失败还原 `value = savedContent`（composer.js:880）。

## 4. 设计决策

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| D1 | 隔离粒度 | 按 projectRoot 哈希隔离，无项目时不存 | 与 last-seen.js 一致；多项目并列时不串味 |
| D2 | 存储 key | `wwriting:composer:draft:${hashKey(projectRoot)}` | 复用 last-seen.js 的 hashKey 算法，命名空间统一 |
| D3 | 存什么 | `textarea.value` 原文，不加工 | 斜杠命令前缀、换行都原样保留 |
| D4 | 写时机 | input 事件 + 200ms 防抖；兜底：项目切换前、pagehide/visibilitychange | 边打边存断电不丢；兜底防防抖未触发（发送瞬间防抖已覆盖，无需额外存）|
| D5 | 清时机 | 发送成功后；input 防抖发现空串时删 key | 发出去的话不再占位；空串等同无草稿 |
| D6 | 恢复时机 | 项目切换后（commitProjectSwitch 之后）；应用首次加载项目 | 切回即恢复，启动即恢复 |
| D7 | 恢复后 | 调 autoGrowComposer + updateSubmitState + 聚焦 | UI 跟上，光标就位 |
| D8 | 发送失败还原字 | 还原后主动触发一次 saveDraft（即时，不等防抖） | 断电也不丢这句失败的话 |
| D9 | localStorage 不可用 | try/catch 静默降级，功能退化为不持久化 | 与现有 localStorage 用法一致 |
| D10 | 空项目（无 projectRoot）| 不读不写草稿 | 全局草稿会跨项目污染，无意义 |

## 5. 方案选型

- **方案 A（采用）**：新建 `src/app-shell/composer-draft.mjs`，导出 `saveDraft / loadDraft / clearDraft`。composer.js 在 input 防抖和发送成功处调用；app.js 在项目切换前后协调。
  - 优点：职责单一、可单测、与 last-seen.js 模式对齐、不污染 composer.js 主流程。
- **方案 B（否）**：内联进 composer.js。composer.js 已 980 行，职责混合，且跨项目协调需暴露更多内部接口。
- **方案 C（否）**：把 last-seen.js 扩成通用 project-kv。属无关重构，违反"不做无关重构"原则。

## 6. 模块设计：composer-draft.mjs

伪代码：

```js
const DRAFT_PREFIX = "wwriting:composer:draft:";

function hashKey(projectRoot) { /* 与 last-seen.js 完全一致的 FNV-1a 实现 */ }

export function saveDraft(projectRoot, text) {
  if (!projectRoot) return;
  const key = DRAFT_PREFIX + hashKey(projectRoot);
  const t = String(text ?? "");
  try {
    if (t === "") localStorage.removeItem(key);
    else localStorage.setItem(key, t);
  } catch { /* 不可用则降级 */ }
}

export function loadDraft(projectRoot) {
  if (!projectRoot) return "";
  try {
    return localStorage.getItem(DRAFT_PREFIX + hashKey(projectRoot)) ?? "";
  } catch { return ""; }
}

export function clearDraft(projectRoot) {
  if (!projectRoot) return;
  try { localStorage.removeItem(DRAFT_PREFIX + hashKey(projectRoot)); } catch {}
}
```

`hashKey` 与 last-seen.js 完全一致。为避免两份实现漂移，**将 hashKey 从 last-seen.js 提取到共享 util**（`src/app-shell/utils/project-key.mjs`），last-seen.js 与 composer-draft.mjs 都从它导入。这是一处"服务于当前目标的小改进"，不是无关重构。

## 7. 集成点

### 7.1 composer.js

- `createComposer` 闭包内新增 `draftTimer` 与 `persistDraft()`（200ms 防抖读 `refs.composerInput.value` + `ctx.getCurrentProjectRoot()` 调 `saveDraft`）。
- 在 `return` 暴露 `persistDraft`（供 app.js input listener 调用）、`flushDraft()`（即时存，取消防抖）、`restoreDraftIfAny(projectRoot)`、`clearDraftForCurrent()`。
- 发送成功清空处（710 / 743 / 785 / 823）以及 uiOnly 命令执行后清空（648）：抽私有 `clearComposerInput()` 函数——清 value + autoGrow + updateSubmitState + clearDraft(currentRoot) + 取消防抖定时器。五处替换为调用它。
- 发送失败还原处（880）：`value = savedContent` 后调 `saveDraft(currentProjectRoot, savedContent)`（即时存，不等防抖）。
- `restoreDraftIfAny(projectRoot)`：读 `loadDraft`，若非空则填入 input + autoGrow + updateSubmitState + focus。

### 7.2 app.js

- 现有 input listener（app.js:300-302）末尾追加 `composer.persistDraft()`。
- `commitProjectSwitch(projectRoot)`（app.js:594）：在 `clearTransientState()` **之前**，把当前输入框内容存到**旧** projectRoot 草稿（用切换前的 `currentProjectRoot`）；在 `clearTransientState()` **之后**，调 `composer.restoreDraftIfAny(projectRoot)` 从**新** projectRoot 恢复。
  - 旧 root 在函数入口捕获：`const prevRoot = currentProjectRoot;`
- `clearTransientState()`（app.js:583）：保持清空输入框行为不变，不在此处做草稿恢复（恢复放在 commitProjectSwitch，避免 clearTransientState 被其他路径调用时误恢复）。
- 首次加载（`renderDashboard` firstLoad 分支，app.js:811-818）：项目首次出现时调 `composer.restoreDraftIfAny(currentProjectRoot)`。
- pagehide / visibilitychange 兜底：注册 window 监听，隐藏时调 `composer.flushDraft()`（即时存，取消防抖）。

### 7.3 hashKey 提取

- 新建 `src/app-shell/utils/project-key.mjs`，导出 `hashKey(projectRoot)`。
- `last-seen.js` 与 `composer-draft.mjs` 都改为从它导入。
- 行为保持不变（同一 root 产出同一 key）。

## 8. 数据格式与存储

- 单 key 存纯文本字符串（`textarea.value`）。
- 不存元数据（时间戳等）——YAGNI，恢复时不需要。
- 容量：单条指令通常 < 10KB，localStorage 单 key 限额远超。
- 不做版本号；未来若格式变再加。

## 9. 错误处理

- 所有 localStorage 操作 try/catch，失败静默降级（功能退化为本次会话内不持久化，不报错给用户）。
- projectRoot 为空时所有操作 no-op。
- 恢复时不验证内容格式——直接填入 textarea，原文是什么就是什么。

## 10. 测试策略

### 10.1 单元测试（新建 `tests/app-shell/composer-draft.test.mjs`）

- saveDraft → loadDraft 往返一致。
- 空串 saveDraft 等同 clearDraft（loadDraft 返回 ""）。
- 不同 projectRoot 互不干扰（隔离）。
- clearDraft 后 loadDraft 返回 ""。
- projectRoot 为空时 no-op。
- localStorage 抛异常时不崩（mock 抛错）。
- hashKey 与 last-seen.js 一致（同一 root 同一 key）。

### 10.2 集成测试

- 模拟 input 事件 → 防抖后 localStorage 有值。
- 发送成功 → 草稿清空。
- 切项目 → 旧项目草稿保留、新项目草稿恢复。
- 发送失败还原 → 草稿即写入。

### 10.3 回归验证（CLAUDE.md 硬要求）

- `npm run verify:app-clickability`：输入框点击/输入链路没坏。
- `npm run verify:app-shell`：静态结构没坏。
- `npm run verify:desktop-shell`：桌面壳没坏。

## 11. 验收标准

1. 在 A 项目输入框打字 → 切到 B 项目 → 切回 A，A 的字还在。
2. 在 A 项目输入框打字 → 关闭应用 → 重开应用打开 A，字还在。
3. 输入框打字 → 点发送成功 → 输入框空、localStorage 该项目 draft key 被删。
4. 输入框打字 → 发送失败 → 字还原回输入框、localStorage 有该草稿。
5. 无项目时输入框打字 → 不写任何 draft key。
6. localStorage 不可用（mock 抛错）→ 应用不崩，功能降级为本次会话不持久化。
7. verify:app-clickability / verify:app-shell / verify:desktop-shell 全绿。

## 12. 非目标（YAGNI）

- 不做草稿历史/版本（只存最新一条）。
- 不做"有未发送内容"的 UI 提示（用户未提此需求）。
- 不做草稿导出/迁移。
- 不做服务端/数据库持久化（本地个人用，localStorage 足够，符合用户偏好）。
- 不做跨设备同步。
