# UAT Remediation Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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

## Program Controls

### Source Of Truth

Use these artifacts in priority order:

1. `docs/superpowers/specs/2026-06-13-uat-remediation-design.md`
2. The three subsystem plans linked above
3. `WWriting-真实用户验收报告-2026-06-13.md`
4. Current source code and tests

If code and plan differ because the user changed the workspace after this plan was written, preserve the user
change and update the implementation approach. Do not silently restore the older shape.

### Worktree And Dirty-Tree Rules

The starting workspace already contains unrelated or prior UAT changes. At execution time:

1. Run `git status --short`.
2. Record every pre-existing path in the execution log.
3. Create an isolated worktree from commit `432899e` or the latest approved descendant.
4. Never stage `.uat_runs/`, the existing report, desktop runtime changes, or server-listen changes unless a
   later task explicitly owns them.
5. Before every commit, compare `git diff --cached --name-only` with the task file list.

Required record:

```text
Base commit:
Worktree path:
Branch:
Pre-existing dirty paths:
Executor:
Start time:
```

### Execution Batches

Implement in these reviewable batches:

| Batch | Child-plan tasks | Gate before next batch |
|---|---|---|
| A1 | Execution Core Tasks 1-2 | Contract and queue migration tests pass |
| A2 | Execution Core Tasks 3-4 | API boundary and single-chapter tests pass |
| A3 | Execution Core Tasks 5-7 | Cancellation and resume tests pass |
| A4 | Execution Core Task 8 | Full execution-core gate passes |
| B1 | State/UI Tasks 1-3 | Artifact and server-scope tests pass |
| B2 | State/UI Tasks 4-7 | Frontend generation and rendering tests pass |
| B3 | State/UI Task 8 | App Shell gate passes |
| C1 | Model Tasks 1-2 | Validation and transaction tests pass |
| C2 | Model Tasks 3-5 | Probe API and UI tests pass |
| C3 | Model Tasks 6-7 | Runtime guard and full model gate pass |
| R1 | Full automated verification | `npm test` and `verify:local` pass |
| R2 | Packaging | Installer builds and verifies |
| U1 | Desktop UAT | All evidence cases pass |
| Q1 | Independent review | No blocking findings |

Do not combine A, B, and C into one unreviewed implementation batch.

### Checkpoint Report After Each Batch

After each batch, record:

```markdown
## Batch A1

- Commit(s):
- Files changed:
- Tests run:
- Pass/fail:
- New behavior demonstrated:
- Known risk:
- Reviewer decision: continue / revise
```

When using `superpowers:subagent-driven-development`, the main agent performs both:

1. Spec compliance review.
2. Code quality and regression review.

Only then advance to the next batch.

### Test Result Capture

For every verification command, record:

```text
command
started_at
finished_at
exit_code
passed_count
failed_count
log_path
commit
```

Save long output under:

```text
.uat_runs/2026-06-13-remediation/logs/
```

Recommended names:

```text
01-execution-core-tests.txt
02-state-ui-tests.txt
03-model-config-tests.txt
04-npm-test.txt
05-verify-local.txt
06-package-installer.txt
07-verify-installer.txt
```

Do not treat a command as passing based only on partial terminal output. Record its final exit code.

### Evidence Directory Layout

Use:

```text
.uat_runs/2026-06-13-remediation/
├── manifest.json
├── logs/
├── screenshots/
├── state/
├── projects/
└── checksums/
```

`manifest.json`:

```json
{
  "uat_id": "2026-06-13-remediation",
  "app_commit": "full git sha",
  "installer_path": "absolute path",
  "installer_sha256": "hex",
  "windows_version": "value from Get-ComputerInfo",
  "started_at": "ISO timestamp",
  "completed_at": null,
  "cases": []
}
```

Each case entry:

```json
{
  "id": "UAT-01",
  "title": "单章任务边界",
  "project_root": "absolute path",
  "task_id": "task-...",
  "started_at": "ISO timestamp",
  "completed_at": "ISO timestamp",
  "result": "pass",
  "screenshots": ["screenshots/UAT-01-01-command.png"],
  "state_files": ["state/UAT-01-agent_state.json"],
  "logs": ["logs/UAT-01-events.jsonl"],
  "notes": ""
}
```

### UAT Case Matrix

| ID | Defect | User action | UI evidence | Disk/log evidence | Pass condition |
|---|---|---|---|---|---|
| UAT-00 | Startup regression | Launch packaged app | Main window, no JS error dialog | Runtime log and listening port | Interactive within 15 seconds |
| UAT-01 | P1-01 task boundary | Submit `写第1章` | Task finishes and UI returns idle | Only `001.md`; no chapter-2 model metadata | No automatic chapter 2 |
| UAT-02 | Range splitting | Submit `写三章` | Three queued task cards | Three task contracts for 1,2,3 | Each task single-chapter |
| UAT-03 | Jump rejection | Submit `写第3章` while current is 1 | Actionable missing-range error | Queue/index/state unchanged | No task starts |
| UAT-04 | P1-02 immediate stop | Stop during fact-check | `正在取消` within 500ms | `stop_requested_at` and one event | API/UI acknowledgement under 500ms |
| UAT-05 | Cancellation convergence | Wait after UAT-04 | `草稿已保留` | `cancelled`, no committed final | Under 5s when provider obeys abort |
| UAT-06 | Resume | Resume UAT-05 | Chapter completes | No duplicate drafting call; one final file | Resume from saved stage |
| UAT-07 | P1-03 artifact truth | Remove/corrupt final file in fixture | Invalid warning, no reader action | Checksum/path mismatch | No false success card |
| UAT-08 | P1-04 project isolation | Delay A refresh, switch to B | Only B content/toasts | Requests carry roots | A response discarded |
| UAT-09 | P2-01 invalid settings | Clear MiMo base URL | Inline field error | Project/secrets byte-identical | Invalid candidate not saved |
| UAT-10 | MiMo connectivity | Enter temporary key, test | Success and latency | Redacted audit event | No key persisted by test |
| UAT-11 | Bad-key diagnosis | Test invalid key | Authentication message | Event code only, no key | Stable classification |
| UAT-12 | Restart durability | Restart after completed/resumed chapter | Same chapter truth | Index, checksum, file consistent | No duplicate completion event |

### Screenshot Rules

Every screenshot must:

1. Include enough application chrome to identify WWriting.
2. Include the relevant project title or path.
3. Show the full status text, not a cropped icon.
4. Avoid exposing API keys.
5. Be captured after waiting for the UI to settle.
6. Have a paired state/log snapshot taken within 30 seconds.

Filename:

```text
UAT-<case>-<sequence>-<short-description>-<yyyyMMdd-HHmmss>.png
```

Example:

```text
UAT-04-01-cancelling-20260613-142233.png
```

### State Evidence Capture

For a project case, copy these files after the screenshot:

```text
agent_state.json
task_queue.json
memory/chapter_index.json
run_log.jsonl
checkpoints/<latest>.json
```

For file-truth cases also record:

```powershell
Get-FileHash -Algorithm SHA256 '<project>\\chapters\\001.md'
Get-Item '<project>\\chapters\\001.md' | Select-Object FullName,Length,LastWriteTimeUtc
```

Never edit the evidence copy after capture.

### Pass, Limited Pass, Fail

Final classification:

| Result | Rule |
|---|---|
| Pass | All P1/P2 cases pass, all release gates pass, no open blocking review finding |
| Limited pass | All P1 cases pass; only documented non-blocking P2/environment issue remains |
| Fail | Any P1 case fails, package cannot launch, secret leaks, or evidence is insufficient |

An automation pass cannot override a failed desktop UAT case. A screenshot alone cannot override contradictory
state or disk evidence.

### Report Template

The final report must use:

```markdown
# WWriting 真实用户验收报告

## 1. 验收摘要
- 结论：
- 应用 commit：
- 安装包：
- SHA-256：
- 环境：
- 时间：

## 2. 自动化验证
| 命令 | 结果 | 通过/失败 | 日志 |

## 3. 真实用户用例
### UAT-01 单章任务边界
- 前置条件：
- 操作步骤：
- 预期：
- 实际：
- 结果：
- 截图：
- 状态/日志证据：

## 4. 缺陷复测映射
| 原缺陷 | 对应用例 | 结果 | 证据 |

## 5. 遗留风险

## 6. 发布建议
```

### Program Definition Of Done

The program is complete only when:

1. All three child plans are implemented and their gates pass.
2. Full tests and packaging pass on the final commit.
3. Packaged application UAT runs against that same commit.
4. Installer SHA-256 and app commit appear in the report.
5. Every original defect maps to at least one passing UAT case.
6. Evidence includes screenshot, logs/state, and disk artifact where applicable.
7. No API key appears in repository diff, logs, screenshots, events, or report.
8. Independent review has no unresolved blocking finding.

### Design Coverage Matrix

| Design requirement | Implementation task | Automated evidence | Desktop evidence |
|---|---|---|---|
| 5.1 task contract | Execution Core 1-3 | `task-contract`, queue, API tests | UAT-01/02 |
| 5.2 parsing rules | Execution Core 1 and 3 | Chinese/Arabic range and ambiguity tests | UAT-02/03 |
| 5.3 chapter order | Execution Core 1 and 3 | `chapter_gap`, passed-chapter tests | UAT-03 |
| 5.4 execution boundary | Execution Core 4 | Capturing model metadata | UAT-01 |
| 6.1 two-phase stop | Execution Core 6 | Idempotent stop/state tests | UAT-04/05 |
| 6.2 signal propagation | Execution Core 5 | Fact-check, memory, retry abort tests | UAT-04 |
| 6.3 cancellation classification | Execution Core 5 | Abort is not degraded/retried | UAT-05 |
| 6.4 forbidden post-stop work | Execution Core 5-6 | No next call/stage/task tests | UAT-05 |
| 7 checkpoint recovery | Execution Core 7 | Resume and duplicate-write tests | UAT-06/12 |
| 8 artifact truth | State/UI 1-2 and 6 | File/index/checksum tests | UAT-07 |
| 9 project isolation | State/UI 3-5 | Delayed A / fast B tests | UAT-08 |
| 9.4 scoped toast | State/UI 5 | Stale toast suppression test | UAT-08 |
| 10 static config | Model 1-2 and 6 | Validation/blocked-run tests | UAT-09 |
| 10.3 connection test | Model 3-5 | Probe/API/UI tests | UAT-10/11 |
| 11 migration | Execution Core 2 and 7 | v2-to-v3 and legacy cancel tests | UAT-12 |
| 12 observability | Execution Core 3/6/7, Model 4 | Event and timing assertions | UAT-04/10 |
| 13 packaged UAT | Program 5-6 | Packaging logs | UAT-00 through UAT-12 |
| 15 release gate | Program 7 | Final command set and review | Final report |

No design section from 5 through 16 may remain without a mapped implementation task and evidence source.

### Task 1: 建立隔离执行环境

**Files:**
- Read: `docs/superpowers/specs/2026-06-13-uat-remediation-design.md`
- Read: 本文 Plan Set 中的三份计划

- [ ] **Step 1: 调用 worktree 技能**

使用 `superpowers:using-git-worktrees` 创建独立工作树。当前主工作区存在用户未提交修改，
不得移动、清理或覆盖这些文件。

- [ ] **Step 2: 记录基线**

Run:

```bash
git status --short
git rev-parse --short HEAD
npm test
```

Expected: 保存基线 commit；测试通过，或把既有失败逐项记录为基线问题。

- [ ] **Step 3: 确认执行顺序**

严格按以下顺序进入子计划：

1. `2026-06-13-uat-execution-core.md`
2. `2026-06-13-uat-state-ui.md`
3. `2026-06-13-uat-model-config.md`

执行每份计划时使用 `superpowers:executing-plans`；每完成一批任务后检查测试结果和 diff。

### Task 2: 执行核心修复

**Files:**
- Follow: `docs/superpowers/plans/2026-06-13-uat-execution-core.md`

- [ ] **Step 1: 执行全部任务**

逐项完成执行核心计划中的红灯测试、最小实现、绿灯验证和提交。

- [ ] **Step 2: 通过子系统门禁**

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

- [ ] **Step 3: 检查提交边界**

Run: `git log --oneline --max-count=10`

Expected: 合同、队列、取消、恢复安全的提交可独立理解，没有混入 UI 或模型设置改动。

### Task 3: 执行状态隔离与文件真值修复

**Files:**
- Follow: `docs/superpowers/plans/2026-06-13-uat-state-ui.md`

- [ ] **Step 1: 执行全部任务**

逐项完成后端 artifact truth、项目作用域、前端 generation、文件卡片和 cancelling UI。

- [ ] **Step 2: 通过子系统门禁**

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

- [ ] **Step 3: 检查 UI 语义**

确认任何 `artifact.state !== "committed"` 的章节都不能显示“已写入本地文件”或可点击打开按钮；
旧 generation 的响应不再写入 DOM。

### Task 4: 执行模型配置修复

**Files:**
- Follow: `docs/superpowers/plans/2026-06-13-uat-model-config.md`

- [ ] **Step 1: 执行全部任务**

逐项完成配置校验、事务保存、连接测试 API/UI 和运行前置检查。

- [ ] **Step 2: 通过子系统门禁**

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

- [ ] **Step 3: 安全检查**

Run:

```bash
rg -n "sk-[A-Za-z0-9]|temporary-test-key|ephemeral-key" src tests docs
git diff --check
```

Expected: `src` 和 `docs` 中没有真实 key；测试中的固定假 key 仅存在于测试输入，
且不会进入快照、日志或响应断言。

### Task 5: 执行完整自动化与打包门禁

**Files:**
- Modify only if verification exposes a defect covered by the approved design.

- [ ] **Step 1: 完整单元与集成测试**

Run: `npm test`

Expected: 全部 PASS。

- [ ] **Step 2: 本地发布验证**

Run: `npm run verify:local`

Expected: MVP、长跑、故障、App Shell、桌面壳、Electron runtime、可点击性和打包目录验证全部通过。

- [ ] **Step 3: 构建安装包**

Run:

```bash
npm run package:installer
npm run verify:installer
```

Expected: 安装包成功生成且验证退出码为 0。

- [ ] **Step 4: 记录构建产物**

Run:

```bash
git rev-parse HEAD
git status --short
```

记录完整 commit、安装包路径、文件大小和 SHA-256，写入最终验收报告。

### Task 6: 使用 Computer Use 执行真实用户复验

**Files:**
- Create: `.uat_runs/2026-06-13-remediation/`
- Modify: `WWriting-真实用户验收报告-2026-06-13.md`

- [ ] **Step 1: 调用桌面验收技能**

使用 `computer-use:computer-use` 启动打包后的 WWriting，而不是开发服务器。
截图统一保存到 `.uat_runs/2026-06-13-remediation/screenshots/`，文件名使用
`01-launch.png`、`02-project-switch.png` 等可排序格式。

- [ ] **Step 2: 验收冷启动**

1. 双击安装版应用或用户桌面快捷方式。
2. 验证无 `EACCES 127.0.0.1:4173` 主进程弹窗。
3. 截取应用首页、任务栏和无错误弹窗的完整桌面证据。

Expected: 应用在 15 秒内可交互，且只出现一个主窗口。

- [ ] **Step 3: 验收项目切换**

1. 打开项目 A，等待 dashboard 和线程记录出现。
2. 立即切换项目 B。
3. 等待所有网络请求和轮询稳定。
4. 截图 B 的项目名、章节列表和线程区域。

Expected: 页面没有项目 A 的标题、章节内容、toast 或文件卡片。

- [ ] **Step 4: 验收文件真值**

1. 在测试项目中准备一条索引为 completed 但最终稿缺失的章节。
2. 打开 dashboard 和对应线程。
3. 截图章节警告与禁用的文件操作。
4. 恢复真实文件并刷新，再截图可用文件卡片。

Expected: 缺失时不显示“已写入本地文件”；恢复后才显示成功状态和打开操作。

- [ ] **Step 5: 验收 MiMo 配置**

1. 打开设置并选择 MiMo 预设。
2. 输入当次有效的临时测试 key。
3. 点击“测试连接”，截图成功结果和延迟。
4. 保存，关闭并重新打开设置，确认 key 不回显。
5. 使用错误 key 再测试，截图可操作的鉴权错误。

Expected: 成功和失败均有明确反馈；错误测试不覆盖原有有效配置；截图和日志不出现完整 key。

- [ ] **Step 6: 验收单章边界与取消**

1. 提交只写第 N 章的命令。
2. 观察任务完成，确认 N+1 未自动启动。
3. 提交另一章，在模型请求或修订期间点击停止。
4. 截图 `正在取消`，再截图终态。
5. 重复点击停止，确认结果幂等。
6. 重启应用，确认没有半成品冒充 final，也没有重复完成事件。

Expected: 单任务只产出合同指定章节；取消在 10 秒内进入终态；重启后数据一致。

- [ ] **Step 7: 更新验收报告**

报告必须包含：

- 应用版本、commit、安装包 SHA-256、测试日期与环境
- 每个验收用例的前置条件、步骤、预期、实际、结论
- 对应截图的相对路径与截图时间
- 自动化命令及通过数量
- 未解决问题、风险等级和是否阻断发布
- 最终结论：通过、有限通过或不通过

### Task 7: 完成前独立复核

**Files:**
- Review: 本次全部代码、测试、截图和验收报告

- [ ] **Step 1: 调用验证技能**

使用 `superpowers:verification-before-completion`，重新执行其要求的最新验证，
不得引用旧终端输出声称通过。

- [ ] **Step 2: 调用代码评审技能**

使用 `superpowers:requesting-code-review` 检查：

- 取消竞态与重复终态
- 跨项目读写
- final 文件与 checkpoint 一致性
- secret 泄漏
- 预检是否错误消耗任务
- 测试是否真实覆盖验收失败路径

- [ ] **Step 3: 最终门禁**

Run:

```bash
npm test
npm run verify:local
npm run verify:installer
git diff --check
git status --short
```

Expected: 验证全部通过；工作区仅包含本计划批准的改动和明确列出的验收证据。

- [ ] **Step 4: 提交最终报告**

```bash
git add WWriting-真实用户验收报告-2026-06-13.md .uat_runs/2026-06-13-remediation
git commit -m "docs: record remediation UAT evidence"
```
