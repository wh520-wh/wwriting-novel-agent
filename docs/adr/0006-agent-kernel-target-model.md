# ADR 0006: Agent 内核目标模型与模块归属

日期：2026-08-23  状态：已接受

## 背景
第十五轮前 runtime.mjs（3056 行）/journal.mjs（1982）/tools.mjs（2123）单闭包承载多域职责。

## 决策
- 六概念所有权：Workspace→workspaces store、Session→session-manager+journal、
  Input/Run→run-lifecycle+journal、Tool Call→tools/index、Checkpoint/Compaction→
  context-checkpoints+compaction。
- journal 是唯一事实源与投影 owner：派生查询走 journal 方法，
  调用方不得全量扫事件重推导（F2 口径）。
- 内部模块（runtime/journal-handlers/history-assembly/run-lifecycle/
  session-manager/tools/*/view/*）禁止包外 import（守卫 R3）。
- 新模块无磁盘写入（不变量 1）；公共 seam 三处不变。

## 后果
新事件类型只需改 journal-handlers handler 表 + state.js handler 表（对账断言钉住）；
新工具只需在对应 definitions 模块注册（registry 派生名单自动一致）。
