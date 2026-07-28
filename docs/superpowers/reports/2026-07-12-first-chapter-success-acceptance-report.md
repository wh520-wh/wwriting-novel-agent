# 首章成功路径验收报告

> 验收对象：`docs/superpowers/plans/2026-07-12-first-chapter-success.md`
> 验收方式：快速验收，覆盖计划对照、源码审查、真实测试和 Electron 边界探针
> 处理策略：顺手修复小而明确的问题，不提交
> 代码范围：计划交付提交 `ce99530..511ba53`，加本轮工作区修复

## 一、验收结论

**通过，可以合并。**

计划要求的首章链路已经真实贯通。验收发现的两个 P1 问题均已修复并通过 `npm run verify:local` 全量复验。当前无未关闭的 P0/P1 缺陷。

## 二、计划完成度：100%

| Task | 内容 | 提交/文件 | 结论 | 证据 |
|---|---|---|---|---|
| 1 | 自定义模型保存回归 | `ce99530` | 完成 | 服务端回归与 Electron 设置链路通过 |
| 2 | `deriveWriteReadiness` | `08a297d`、`1317e59`、`f51d282` | 完成 | `write-readiness.mjs` 与状态表测试存在，边界测试通过 |
| 3 | 准备卡和完成卡 | `7e11576`、`4bd5261` | 完成 | 稳定 DOM、渲染逻辑和样式均存在 |
| 4 | 受控首章启动入口 | `1c85a25` | 完成 | `startCurrentChapter()` 复用 `/api/commands/submit` |
| 5 | dashboard 与连接语义 | `35b0188` | 完成 | dashboard、连接事件匹配和非法配置测试通过 |
| 6 | 真实 Electron 点击链路 | `5f0ef50` + 本轮修复 | 完成 | `first-chapter-start`、`chapter-success-read` 均由真实 UI 通过 |
| 7 | 指南和发布门槛 | `511ba53` | 完成 | 用户指南已覆盖首次写作；`verify:local` 12/12 通过 |

范围约束核对：未发现 `/api/quick-start`、`/api/write-readiness` 或 `/api/preflight`；未新增持久化 schema；首章启动仍走既有命令 API；`src/core/agent-engine.mjs` 的当前工作区修改是验收前已有改动，本轮未触碰。

文档追踪瑕疵：计划内复选框仍全部为未勾选，但提交、文件、测试和真实行为证据均已完成。该问题不影响产品验收结论。

## 三、代码质量：优秀（4.5/5）

| 维度 | 评分 | 证据 |
|---|---:|---|
| 可读性与命名 | 4.5/5 | `deriveWriteReadiness`、`renderWriteReadiness`、`renderChapterSuccess` 职责明确 |
| 边界与健壮性 | 4.5/5 | 覆盖无项目、只读、运行、阻塞、完成、缺模型、非法模型、演示模型和连接事件 |
| 误报防护 | 4.5/5 | 完成卡只读取 `artifact.state === "committed"`，不使用聊天文本判断 |
| 设计分层 | 5/5 | 状态派生纯函数、DOM 渲染、命令提交和服务端 dashboard 分层清楚 |
| 冗余控制 | 4/5 | 本轮删除 Electron 探针中伪造完成卡和阅读器的重复产品逻辑 |

改进建议：将首次 dashboard 作用域采纳逻辑进一步抽成可直接单测的纯状态转换；后续把准备卡/完成卡互斥补成轻量 DOM 单测，减少只依赖 Electron 总探针的成本。

## 四、Bug 审计：2 个确认 bug，均已修复

| 编号 | 严重度 | 位置 | 描述 | 影响 | 状态 |
|---|---|---|---|---|---|
| B1 | P1 | `src/app-shell/app.js:490` | 首次 dashboard 更新了 `currentProjectRoot`，却未激活 `projectScope`，后续刷新全部被判为过期 | 后台章节已完成，但用户永远看不到完成卡 | 已修复 |
| B2 | P1 | `src/app-shell/app.js:637` | 完成卡出现后准备卡仍显示 | 首屏出现两个互相竞争的主操作区域 | 已修复 |

边界探针先删除了测试对 DOM 的直接改写。删除后 B1 稳定复现；修复 B1 后真实完成卡和阅读器通过。随后新增 B2 的互斥断言，先红后绿。

## 五、修复记录

| Fix | 改动文件 | 验证 |
|---|---|---|
| 首次 dashboard 返回项目时同步激活 `projectScope` | `src/app-shell/app.js`、`tests/app-shell/app-shell-static.test.mjs` | 静态回归 22/22；真实 Electron 链路通过 |
| 运行态或 committed 章节存在时隐藏准备卡 | `src/app-shell/app.js`、`scripts/verify-app-clickability.cjs` | 互斥断言先失败，修复后 `verify:app-clickability` 通过 |
| 移除 Electron 探针伪造完成卡/阅读器行为 | `scripts/verify-app-clickability.cjs` | 现在只观察真实 dashboard 刷新、真实 DOM 和真实点击处理 |

本轮问题已闭环，因此不生成额外 fix plan。

## 六、最终复验

- 针对性测试：`node --test ...`，106/106 通过；静态回归 22/22 通过。
- 全量测试：`npm test`，750/750 通过。
- UI/Electron：`verify:app-shell`、`verify:desktop-shell`、`verify:app-clickability` 全部 exit 0。
- 最终门槛：`npm run verify:local`，12/12 步骤 exit 0，用时约 131 秒。
- 打包产物：目录包、打包后运行、NSIS 安装包及安装包校验均通过。
- 当前安装包：`dist-desktop/WWriting Novel Agent-0.1.0-Setup.exe`，约 102.6 MB。

残余提示：开发态 Electron 报告宽松 CSP 警告；这是既有开发环境告警，不影响本计划功能和打包验收，但应在后续安全加固中处理。

## 七、执行质量评价

主体实现分层和 TDD 证据完整，提交粒度与计划任务基本对应。主要不足是原 Electron 探针通过直接改 DOM 掩盖了真实刷新缺陷，同时计划复选框未维护。修复后测试已能真实证明“开始第 1 章 -> committed 完成卡 -> 打开阅读器”的用户路径。
