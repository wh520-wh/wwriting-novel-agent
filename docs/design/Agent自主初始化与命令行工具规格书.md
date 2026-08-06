# Agent 自主初始化与命令行工具规格书

状态：已实施（统一 Agent 内核 Task 1–11 落地）  
日期：2026-08-06  
关联：`docs/design/写作Agent对话样式规格书.md`（AgentSurface 对话面约束）

## 概述

WWriting 已把写作控制面收敛为**单一 Agent 内核 + 单一对话面**。本规格描述最终统一架构下 `/init`、自主读取政策、权限生命周期（`active_input_id`）、YOLO / extreme 与 stop/立即 的契约。旧蓝图门禁、旧队列派生"排队中"、旧任务卡与旧准备卡均已删除；本规格只描述最终状态，不记录被取代的实现。

## 1. /init 是普通聊天请求

- `/init` 是一条普通聊天请求，可以在写作的任何阶段使用；模型判断需要时也会自主执行蓝图相关工作，软件不强制用户先运行 `/init`。
- Agent 决定检查哪些项目文件，以及 `OUTLINE.md`、`SETTING.md`、`AGENTS.md` 是否需要变更。
- 缺少蓝图文件不阻塞日常写作。
- `/init` 与其他指令走完全相同的 Agent 循环与事件流：可见的思考/活动/确认/错误状态、同一队列、同一停止机制；保留用户发送的 `/init` 原文与附加要求。
- 已有蓝图文件应优先改进和补齐，不得无理由整体覆盖；模型必须报告检查依据与实际变更。

## 2. 自主读取政策（normal 模式）

- 正常模式自动执行项目读取（查看目录、读取文件、搜索、只读检查命令）。
- 产生副作用的操作（写入、覆盖、删除、安装、联网、启动外部程序、访问项目外目录）先请求确认。
- 确认卡提供三种选择：`一次允许`、`本条输入允许同类操作`、`拒绝`。

## 3. 权限生命周期（active_input_id）

- 同一时刻只有一个活动输入（`active_input_id`）；排队输入按 FIFO 排列，`立即` 提升时切换 `active_input_id`，**不创建第二个项目 Agent**。
- 同类授权（allow_input）只对当前这条排队输入生效：Run 结束、输入被消费/取消或切换项目后，临时授权自动失效。
- 跨 Run 成本由 `cost.json` / CostTracker 按项目累计，与临时授权无关。

## 4. YOLO 与 extreme

- YOLO 跳过普通确认，并允许访问项目以外的目录；UI 文案统一使用大写 `YOLO`，确认文案：`YOLO 会自动执行写入和控制操作。确认开启？`
- 极端危险操作（可能破坏磁盘、系统或大范围用户数据的操作）始终要求输入**当前给出的精确确认文字**：
  - 红色确认卡，执行按钮在输入与 `confirmation_text` 精确匹配前禁用；
  - 确认文字每次变化，模型与 YOLO 都不能代填或自动放行；
  - 已终结的 decision id 不能再应用（decide 只放行仍为 pending 的 decision_id）。

## 5. stop 与立即

- `停止` 取消当前 Run 并清除临时授权；停止中显示 `正在停止`，终态 `已停止`；进行中的文件写入保持完整。
- `立即` 打断当前轮并提升一条排队消息为活动输入（同一 run id 内切换 `active_input_id`），不创建第二个项目 Agent。
- 暂停/恢复成功不弹 Toast；停止按钮点击即禁用防连点，仅停止失败或 Run 恢复后重新可用。

## 6. 工具与事件协议

- 工具事件统一状态：运行中、完成、失败、取消（取消类错误码 `tool_cancelled` / `shell_cancelled` 收敛为 `已停止` 标记）。
- Shell 默认运行目录为当前项目；支持增量输出、停止与明确的结束状态；输出按片段进入当前轮，不等待命令结束。
- 可能包含密钥的参数在持久化日志中脱敏；错误码、命令、退出码只在活动行折叠详情中出现，主文案只说用户可理解的事实。
- 私有推理字段（reasoning / chain-of-thought）不作为产品功能：界面只展示"思考中"状态与可验证的活动/结果。

## 7. 数据与恢复

- Session/Run/queue/plan/decision 的真相源是 Agent journal（`<projectRoot>/.wwriting/agent/events.jsonl`，`session.json` 为可重建投影）。
- provider 消息连续性由 `transcript.jsonl` 承担；模型循环、workflow、stop/立即 由 ProjectAgent（`src/core/agent/`，`createProjectAgent` seam）编排。
- 旧项目首次打开时执行一次性只读 legacy 导入（幂等，`migration.json` 标记）；新项目不再产生 `agent_state.json`、`task_queue.json`、`failures.jsonl`、`chat_history.jsonl`。
- 不同项目各自持有独立 journal 实例与队列，互不共享锁，可以并行运行（跨项目并行）。

## 8. 蓝图文件（由 /init 维护）

- `OUTLINE.md`（故事大纲）、`SETTING.md`（世界观与设定）、`AGENTS.md`（项目写作说明）为可持续维护的项目事实；`commit_blueprint` 一致提交三者与 `project.yaml.blueprint_status`。
- 蓝图缺失不阻塞写作；`blueprint_status` 只作为事实信息存在于 `project.yaml`，不控制作者能否写作。

## 9. 验证要点（对应验收）

- 新项目无蓝图仍可写作；`/init` 进入普通聊天 Agent 且可重复运行；已有蓝图不被盲目覆盖。
- 普通确认、input 级同类授权与授权清理；YOLO 跳过普通确认但不跳过 extreme；fresh 精确文字确认不可复用、不可由模型代填。
- Shell cwd/超时/增量输出/进程树停止/1 MiB 独立流尾；密钥与 journal 详情脱敏。
- 同一 activity 合并、私有推理不渲染；`/init` 保留用户原文并使用同一个 Agent 循环。
- 跨项目并行；stop 取消当前 Run 并清除临时授权；`立即` 保持同一 run id。
