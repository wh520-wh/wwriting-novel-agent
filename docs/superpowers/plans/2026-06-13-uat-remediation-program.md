# UAT Remediation Program Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 按风险顺序完成 WWriting 真实用户验收问题修复，通过自动化、打包验证和带截图的桌面端复验，形成可追溯的最终验收结论。

**Architecture:** 本计划是三份可独立评审实施计划的总控索引。先修执行边界与取消语义，再处理项目状态隔离和文件真值，最后完成模型配置事务、连通性测试及运行前置检查。所有子计划完成后统一构建安装包，并使用 Computer Use 按真实用户路径复验。

**Tech Stack:** Node.js、Electron、原生 `node:test`、现有 verify/package 脚本、Computer Use

---

## Plan Set

1. [执行核心计划](./2026-06-13-uat-execution-core.md)
   - 单任务单章节合同
   - `cancelling`/`cancelled` 状态机
   - AbortSignal 全链路传播
   - checkpoint 与 final 文件恢复安全
2. [状态隔离与文件真值计划](./2026-06-13-uat-state-ui.md)
   - 显式项目请求作用域
   - 前端 generation 门禁
   - 文件存在性、校验和与展示一致
   - 取消中状态展示
3. [模型配置计划](./2026-06-13-uat-model-config.md)
   - MiMo/OpenAI-compatible 严格校验
   - 配置与 secret 事务保存
   - 测试连接与错误分类
   - 运行前模型预检

## Task 1: 建立隔离执行环境

**Files:**
- Read: `docs/superpowers/specs/2026-06-13-uat-remediation-design.md`
- Read: 本文 Plan Set 中的三份计划

**Step 1: 调用 worktree 技能**

使用 `superpowers:using-git-worktrees` 创建独立工作树。当前主工作区存在用户未提交修改，
不得移动、清理或覆盖这些文件。

**Step 2: 记录基线**

Run:

```bash
git status --short
git rev-parse --short HEAD
npm test
```

Expected: 保存基线 commit；测试通过，或把既有失败逐项记录为基线问题。

**Step 3: 确认执行顺序**

严格按以下顺序进入子计划：

1. `2026-06-13-uat-execution-core.md`
2. `2026-06-13-uat-state-ui.md`
3. `2026-06-13-uat-model-config.md`

执行每份计划时使用 `superpowers:executing-plans`；每完成一批任务后检查测试结果和 diff。

## Task 2: 执行核心修复

**Files:**
- Follow: `docs/superpowers/plans/2026-06-13-uat-execution-core.md`

**Step 1: 执行全部任务**

逐项完成执行核心计划中的红灯测试、最小实现、绿灯验证和提交。

**Step 2: 通过子系统门禁**

Run:

```bash
node --test tests/task-contract.test.mjs
node --test tests/task-queue.test.mjs
node --test tests/schema-migration.test.mjs
node --test tests/agent-engine.test.mjs
node --test tests/model-client-retry.test.mjs
node --test tests/tool-runtime.test.mjs
node --test tests/app-server-probe.test.mjs
```

Expected: 全部 PASS。

**Step 3: 检查提交边界**

Run: `git log --oneline --max-count=10`

Expected: 合同、队列、取消、恢复安全的提交可独立理解，没有混入 UI 或模型设置改动。

## Task 3: 执行状态隔离与文件真值修复

**Files:**
- Follow: `docs/superpowers/plans/2026-06-13-uat-state-ui.md`

**Step 1: 执行全部任务**

逐项完成后端 artifact truth、项目作用域、前端 generation、文件卡片和 cancelling UI。

**Step 2: 通过子系统门禁**

Run:

```bash
node --test tests/chapter-artifact.test.mjs
node --test tests/app-dashboard.test.mjs
node --test tests/app-server-probe.test.mjs
node --test tests/app-shell/project-scope.test.mjs
node --test tests/app-shell/app-shell-project-switch.test.mjs
node --test tests/app-shell/chapter-presentation.test.mjs
node --test tests/agent-truth.test.mjs
node --test tests/app-shell/thread-renderer.test.mjs
npm run verify:app-shell
```

Expected: 全部 PASS。

**Step 3: 检查 UI 语义**

确认任何 `artifact.state !== "committed"` 的章节都不能显示“已写入本地文件”或可点击打开按钮；
旧 generation 的响应不再写入 DOM。

## Task 4: 执行模型配置修复

**Files:**
- Follow: `docs/superpowers/plans/2026-06-13-uat-model-config.md`

**Step 1: 执行全部任务**

逐项完成配置校验、事务保存、连接测试 API/UI 和运行前置检查。

**Step 2: 通过子系统门禁**

Run:

```bash
node --test tests/model-config-validation.test.mjs
node --test tests/settings-runtime.test.mjs
node --test tests/model-connection-test.test.mjs
node --test tests/app-server-probe.test.mjs
node --test tests/app-shell/settings-modal.test.mjs
npm run verify:desktop-shell
```

Expected: 全部 PASS。

**Step 3: 安全检查**

Run:

```bash
rg -n "sk-[A-Za-z0-9]|temporary-test-key|ephemeral-key" src tests docs
git diff --check
```

Expected: `src` 和 `docs` 中没有真实 key；测试中的固定假 key 仅存在于测试输入，
且不会进入快照、日志或响应断言。

## Task 5: 执行完整自动化与打包门禁

**Files:**
- Modify only if verification exposes a defect covered by the approved design.

**Step 1: 完整单元与集成测试**

Run: `npm test`

Expected: 全部 PASS。

**Step 2: 本地发布验证**

Run: `npm run verify:local`

Expected: MVP、长跑、故障、App Shell、桌面壳、Electron runtime、可点击性和打包目录验证全部通过。

**Step 3: 构建安装包**

Run:

```bash
npm run package:installer
npm run verify:installer
```

Expected: 安装包成功生成且验证退出码为 0。

**Step 4: 记录构建产物**

Run:

```bash
git rev-parse HEAD
git status --short
```

记录完整 commit、安装包路径、文件大小和 SHA-256，写入最终验收报告。

## Task 6: 使用 Computer Use 执行真实用户复验

**Files:**
- Create: `.uat_runs/2026-06-13-remediation/`
- Modify: `WWriting-真实用户验收报告-2026-06-13.md`

**Step 1: 调用桌面验收技能**

使用 `computer-use:computer-use` 启动打包后的 WWriting，而不是开发服务器。
截图统一保存到 `.uat_runs/2026-06-13-remediation/screenshots/`，文件名使用
`01-launch.png`、`02-project-switch.png` 等可排序格式。

**Step 2: 验收冷启动**

1. 双击安装版应用或用户桌面快捷方式。
2. 验证无 `EACCES 127.0.0.1:4173` 主进程弹窗。
3. 截取应用首页、任务栏和无错误弹窗的完整桌面证据。

Expected: 应用在 15 秒内可交互，且只出现一个主窗口。

**Step 3: 验收项目切换**

1. 打开项目 A，等待 dashboard 和线程记录出现。
2. 立即切换项目 B。
3. 等待所有网络请求和轮询稳定。
4. 截图 B 的项目名、章节列表和线程区域。

Expected: 页面没有项目 A 的标题、章节内容、toast 或文件卡片。

**Step 4: 验收文件真值**

1. 在测试项目中准备一条索引为 completed 但最终稿缺失的章节。
2. 打开 dashboard 和对应线程。
3. 截图章节警告与禁用的文件操作。
4. 恢复真实文件并刷新，再截图可用文件卡片。

Expected: 缺失时不显示“已写入本地文件”；恢复后才显示成功状态和打开操作。

**Step 5: 验收 MiMo 配置**

1. 打开设置并选择 MiMo 预设。
2. 输入当次有效的临时测试 key。
3. 点击“测试连接”，截图成功结果和延迟。
4. 保存，关闭并重新打开设置，确认 key 不回显。
5. 使用错误 key 再测试，截图可操作的鉴权错误。

Expected: 成功和失败均有明确反馈；错误测试不覆盖原有有效配置；截图和日志不出现完整 key。

**Step 6: 验收单章边界与取消**

1. 提交只写第 N 章的命令。
2. 观察任务完成，确认 N+1 未自动启动。
3. 提交另一章，在模型请求或修订期间点击停止。
4. 截图 `正在取消`，再截图终态。
5. 重复点击停止，确认结果幂等。
6. 重启应用，确认没有半成品冒充 final，也没有重复完成事件。

Expected: 单任务只产出合同指定章节；取消在 10 秒内进入终态；重启后数据一致。

**Step 7: 更新验收报告**

报告必须包含：

- 应用版本、commit、安装包 SHA-256、测试日期与环境
- 每个验收用例的前置条件、步骤、预期、实际、结论
- 对应截图的相对路径与截图时间
- 自动化命令及通过数量
- 未解决问题、风险等级和是否阻断发布
- 最终结论：通过、有限通过或不通过

## Task 7: 完成前独立复核

**Files:**
- Review: 本次全部代码、测试、截图和验收报告

**Step 1: 调用验证技能**

使用 `superpowers:verification-before-completion`，重新执行其要求的最新验证，
不得引用旧终端输出声称通过。

**Step 2: 调用代码评审技能**

使用 `superpowers:requesting-code-review` 检查：

- 取消竞态与重复终态
- 跨项目读写
- final 文件与 checkpoint 一致性
- secret 泄漏
- 预检是否错误消耗任务
- 测试是否真实覆盖验收失败路径

**Step 3: 最终门禁**

Run:

```bash
npm test
npm run verify:local
npm run verify:installer
git diff --check
git status --short
```

Expected: 验证全部通过；工作区仅包含本计划批准的改动和明确列出的验收证据。

**Step 4: 提交最终报告**

```bash
git add WWriting-真实用户验收报告-2026-06-13.md .uat_runs/2026-06-13-remediation
git commit -m "docs: record remediation UAT evidence"
```
