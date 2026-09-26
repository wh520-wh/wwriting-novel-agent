# 2026-09-25 第二十一轮规格：路径身份统一（path-identity）

记录于：2026-09-25｜状态：当前有效｜依据：只读复核（源码逐行 + LF 归一字节实算）；决策经 2026-09-25 访谈确认（4 轮 15 问，全部取推荐项）

> 本文件是**规格**：写「改什么、为什么、怎么算改完」。**任务拆解、提交切分与执行顺序见后续计划文件**——按用户指令，计划在收到明确指令后另写，本文件不含可执行任务表。

## 一句话

把「路径身份」的判定基准从**手选路径字符串**改为**真实项目根**（解析目录链接后的物理位置），在比较点就地解析、解析失败即拒绝调用；顺带修掉同一处不对称导致的「项目内写入被误判项目外」与「工作区文本被误拒」。

## 背景

2026-09-25 只读健壮性抽查复核（覆盖 `src/` 122 个 `.js/.mjs` + 5 个 `.cjs`）确认的事实：

- `tools/index.mjs:645` 对**目标路径**做 `resolveFilesystemPath`（realpath），而 `runtime-helpers.mjs:228` 的 `isProtectedWritePath` 用的根是 `path.resolve(projectRoot)`。全仓 `grep realpath src/` 只命中 `fs-utils.mjs:31` 与 `skills/*`——**根从未被解析**。两侧口径不一致，比较必然落空。
- 同一缺陷同时有 fail-open 与 fail-closed 两种症状，证明它是漏处理而非有意保守：受保护路径保护整体失效（fail-open）；`readWorkspaceTextFile:351` 把项目内合法文件判成「工作区外」而拒绝（fail-closed）；`risk.mjs:79` 把项目内写入判成「项目外」，正常写作每次弹确认。
- 该缺陷**已在欠账 20-7 部分登记**（原文只点了 `run_log.jsonl` 与 `samePath` 不 realpath），本轮把范围订正为「以根为基准的全部比较点」。

产品现实：只发 Windows 安装包（`electron-builder --win nsis`），现实触发面是 Windows junction（`mklink /J`）或项目位于被重定向目录下。

## 决策

- **D1 基准 = 真实项目根**（ADR 0009）。凡判断「属不属于当前项目」「要不要保护」一律以 `resolveFilesystemPath(projectRoot)` 为基准。
- **D2 解析在比较点就地做**（ADR 0009）：每次工具调用在既有路径归一化处解析一次并写入工具上下文；**不缓存、不改写注册表**。理由：目录可能是事后建的链接，一次性归一让「打开时」与「使用时」的真相不同；且改注册表会波及界面显示路径。
- **D3 解析失败 ⇒ 拒绝该次工具调用**（fail-closed），给可行动中文文案，绝不退回未解析的根。⚠️ 该解析块**当前不在任何 try 内**（`index.mjs:716` 的 try 只包 `protectedCheck`，`:793` 的 try 在权限评估之后），异常会直接冒泡出 `execute()` ——必须显式处理。
- **D4 scope 判定与受保护判定同源**：`scope` / `target_class` / `grant_key` 一并改用真实项目根；不保留「保护失效但有确认兜底」的双口径。
- **D5 保护承诺面不变**：仍只覆盖 `write_file` / `edit_file` 与 shell 的 cwd 信号；**不**新增 shell 写目标检查（`echo > run_log.jsonl` 仍不在承诺内，登记 21-4）。
- **D6 测试平台口径 = Windows 专用**（与 `tools.test.mjs:702`、`:828` 既有口径一致，`skip: process.platform !== "win32"`）：依据是产品只发 Windows，posix 分支没有用户，不写永不执行的分支。
- **D7 缺口台账重算不在本轮**（ADR 0010 已定格口径，实现登记 21-3）。执行阶段若改动 `journal*` 模块即属越界。

## 变更面

体积余量为 LF 归一口径实算（2026-09-25）：`tools/index.mjs` 1035 行 / 44657 B（余 165 行 / 6543 B）；`runtime-helpers.mjs` 386 / 19484；`definitions-shell.mjs` 110 / 5724；`risk.mjs` 123 / 8055；`definitions-fs.mjs` 未测（改动仅两处调用点）。**紧的是行余量（165 行），改动应保持外科式**。

### 改动 1｜`src/core/agent/tools/index.mjs` 归一化块（现 `:640-649`）

- 解析真实项目根写入上下文（建议键名 `resolved_project_root`），整块包 `try`；失败返回可行动工具失败（建议 `code: "path_resolution_failed"`、`technical.rule: "project_root_unresolved"`）。
- 目标路径的解析基准改为真实项目根（`args.path` / `args.cwd` 两处）。
- **二次解析不可省**：`args.path` 可能是相对路径，且链接可能出现在**项目内部**（项目内 junction 指向项目外）——该方向今天有测试覆盖（`tools.test.mjs:702`），必须保持有效。
- **等价性论证（决定改动面大小）**：`args.path` 归一后是绝对路径，故 `run()` / `describeAction()` 里的 `path.resolve(context.projectRoot, args.path)` 对绝对路径返回自身，**这些行不需要改**。

### 改动 2｜`fileAction`（`index.mjs:110-121`）与 shell 的 `targetClass`（`definitions-shell.mjs:38`）

`resolveProjectScope(root, target)` 的 root 改传真实项目根 ⇒ `scope`、`target_class`、`grant_key` 随之纠正（授权键变化见「用户可见变化」）。

### 改动 3｜比较点的取值口径（`runtime-helpers.mjs`）

新增一个取值函数，**键缺失即抛错**（不留退回原根的分支，D3）：

```js
function projectRootForChecks(context) {
  const resolved = context.resolved_project_root;
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw toolError("path_resolution_failed", "无法确认项目位置，已拒绝本次操作。", { rule: "project_root_unresolved" });
  }
  return resolved;
}
```

落点 5 处，各自的抛错后果已逐点核实为 fail-closed：

| 落点 | 抛错后被谁兜住 |
|------|----------------|
| `fileProtectedCheck`（`:283`） | `index.mjs:716` 的 try/catch → `permission_denied` 拒绝 |
| `isProtectedShellCwd` 调用处（`definitions-shell.mjs:53-56`） | 同上（shell 的 `protectedCheck`） |
| `isSafeEditContentPath` 调用处（`definitions-fs.mjs:199`、`:250`） | `index.mjs:678` 的 try/catch → 工具失败 |
| `readWorkspaceTextFile`（`:351`） | 工具错误直接失败 |

### 改动 4｜测试脚手架

- `tests/agent/tools.test.mjs#setup`（`:84`）与 `tests/helpers/project-agent-harness.mjs` 造出的工具上下文必须带 `resolved_project_root`。**不填即报错是有意设计**：把「忘了填」变成显式失败，而不是静默退回原根。
- 新增一条断言：上下文缺该键时 `fileProtectedCheck` 抛错。

## 测试设计

新文件 `tests/agent/path-identity.test.mjs`（`npm test` 的 `tests/agent/*.test.mjs` glob 自动覆盖；`tests/agent/` 依规则 A2 享有内部 seam 权利，无需登记 `SURFACE_SEAM_TESTS`）。

- **主表（表驱动）**：8 条受保护规则 × 2 种项目根（真实根 / junction 根）。目标路径取自 `runtime-helpers.mjs:233-262`：`.wwriting/agent/…`、`checkpoints/…`、`memory/chapter_index.json`、`drafts/…`、`.versions/…`、`memory/continuity.json`、`project.yaml`、`run_log.jsonl`。
  - 每条断言 `write_file` 失败 **且 `technical.rule` 等于对应规则名**——只断言「失败」会让用错规则蒙对。
- **夹具**：`tests/helpers.mjs#createWritingProject` 建标准骨架 + `fs.symlink(realRoot, linkRoot, "junction")`（Windows junction 无需特权）。两种根跑同一张表。
- **反向断言 1（防误伤）**：junction 根下写正式章节 `chapters/001.md`，在 `auto_edit: true` 下必须**成功**——同时钉住 D4（scope 已改用真实根）。
- **反向断言 2（fail-closed）**：上下文缺 `resolved_project_root` → 抛错而非放行。
- **反向断言 3（不回归）**：项目内 junction 指向项目外时仍判项目外（保持 `tools.test.mjs:702` 语义）。
- **可证伪要求**：先写测试、确认在旧代码下变红，再实现（项目既有 TDD 惯例，round20 阶段一同款要求）。

## 验收门禁与完成判据

门禁（四条，全绿才算过）：

1. `npm test` 全量 —— 基线 1992/1992（2026-09-24 实跑值；本轮只加不减）
2. `npm run verify:unified-agent` —— 36/36
3. `npm run verify:app-shell` —— exit 0
4. `npm run verify:desktop-shell` —— exit 0

完成判据（三条硬判据）：

1. 新测试在旧代码下变红、实现后全绿（可证伪，非「永不失败的断言」）。
2. 上述四条门禁全绿。
3. 无新增越线文件：`src/**/*.{js,mjs}` 每份 ≤1200 行且 ≤51200 字节（LF 归一，R1 机器强制）。

## 用户可见变化

只在 `CHANGELOG.md` 记一条，不做界面提示、不做迁移：

- junction 项目的项目内写入不再弹「项目外」确认。
- 既有授权键（形如 `write:outside:<盘符>`）失效一次，需重新确认。
- 此前因保护失效而能写入的受保护文件（`memory/`、`.versions/`、`run_log.jsonl`、`project.yaml`、`checkpoints/`、`.wwriting/agent/`）现在会被拒——这本就是产品约定。

## 同族比较点盘点（本轮不修，附理由）

| 位置 | 是否受同一缺陷影响 | 本轮处置 |
|------|-------------------|----------|
| `app-dashboard.mjs:240`/`:440`、`app-server.mjs:414`、`chapter-artifact.mjs:32`、`project-listing.mjs:91`/`:105` | 受影响（workspace 层） | 不修：属项目身份层 → 登记 21-2 |
| `fs-utils.mjs:43` `safeJoin` 家族（全部内部调用） | 不受影响 | 目标由根派生，上游传真实根时包含性恒真；无用户可控输入，非安全边界 |
| `skills/skill-file.mjs:67`/`:214` | 已正确 | 不动（全仓样板：先 realpath 再比包含性） |
| `runtime-helpers.mjs:78` 与 `app-state.mjs:120` 两份 `samePath` | 受大小写口径影响 | 不修 → 登记 21-1 |
| `journal-segments.mjs:188-189` 隔离时静默吞 rename 错（会重复记 gap） | 无关（隔离路径） | 不修 → 登记 21-5 |

## 非目标

缺口台账重算（ADR 0010，实现排后）、项目身份层、大小写口径与两份 `samePath` 合一、shell 写目标承诺扩大、版本快照兜底、忙门与项目锁合并、体积腾挪（除完成判据第 3 条外不主动拆文件）、任何 UI 改动、真实 API 复跑、发布与打包。

## 偏离记录（执行期回填）

| 计划行 | 实际做法 | 理由 | 记录于 |
|--------|----------|------|--------|
| 规格「改动 4」：测试脚手架必须携带 `resolved_project_root` | 未给 `tests/agent/tools.test.mjs#setup` 与 `tests/helpers/project-agent-harness.mjs` 加该字段；改用「上下文缺该键即抛错」的断言钉住 fail-closed | `execute()` 为每次调用本地填入该键，5 个消费点全在 `execute()` 内部；harness 的上下文由 `run-pipeline.mjs:729` 现场生成，加字段是无消费的死代码 | 2026-09-25 |
| 计划 Task 2 Step 3：目标解析另设 `try/catch` | 提前到 Task 1 修复轮实现（并入同一个 `try` 块，`code:"path_resolution_failed"` / `rule:"target_path_unresolved"`） | Task 1 审查发现目标解析的异常仍会逃出 `execute()`，与本轮「失败闭环」目标直接冲突；若留在 Task 2，Task 1 将交付一个半闭合的归一化块 | 2026-09-25 |
| 规格「改动 1」未写、计划 Task 2 Step 3 补的一步：shell 即使不传 cwd 也把 `args.cwd` 设成真实项目根 | 照计划实现 | 缺此步则 junction 项目里无 cwd 的 shell 命令，其默认 cwd 仍落在未解析的链接根上被判「项目外」——正是 D4 要消灭的症状 | 2026-09-25 |
| 计划 Task 2 Step 2：确认 junction 保护主表在旧比较逻辑下变红 | 该表在 Task 2 实现前**已绿**（受保护路径的取值口径属 Task 1 交付物）；本任务真红灯来自另 4 处：只读工具 fail-closed、shell cwd 保护 fail-open、auto_edit 误确认、`safe_edit_target` 误判 | 完成判据 1（新测试在旧代码下变红）由 Task 1 满足；主表在本任务中充当防回归护栏 | 2026-09-25 |
| 计划 Task 1 Step 3：「从 `index.mjs`、`definitions-fs.mjs`、`definitions-shell.mjs` 三个文件导入」`projectRootForChecks` | Task 1 只在本文件定义导出 + 由 `fileProtectedCheck` 消费；三个文件的实际 import 延到 Task 2 有真实消费点时再加 | Task 1 加 import 就是无用 import（死代码）；该句描述的是整轮结束时的状态 | 2026-09-25 |
| 规格「验收门禁与完成判据」门禁 3：`npm run verify:app-shell` exit 0 | 本轮实测 exit 1，失败在 `scripts/verify-app-shell.mjs:372`（「思考项完成态标签应为 思考 N 秒」）；在 round21 之前的提交 `65bcf1e` 上以 Node 22 与 Node 25 独立复现同一断言，判定为**既有失败、与本轮改动无关**（断言由 `069ffa0` 引入） | 用户 2026-09-25 裁定：接受现状并登记为欠账 21-7，不在本轮修——修它属 app-shell 投影改动，与规格「非目标」中的「任何 UI 改动」冲突。另三条门禁本轮实测全绿：`npm test` 2000/2000、`verify:unified-agent` 36/36、`verify:desktop-shell` exit 0 | 2026-09-25 |
