# Agent 自主初始化与命令行工具规格书

状态：已实施（统一 Agent 内核 Task 1–11 落地）  
日期：2026-08-06  
关联：`docs/design/写作Agent对话样式规格书.md`（AgentSurface 对话面约束）

## 概述

WWriting 已把写作控制面收敛为**单一 Agent 内核 + 单一对话面**。本规格描述最终统一架构下 `/init`、自主读取政策、权限生命周期（`active_input_id`）、YOLO / extreme 与 stop/立即 的契约。旧蓝图门禁、旧队列派生"排队中"、旧任务卡与旧准备卡均已删除；本规格只描述最终状态，不记录被取代的实现。

## 1. /init 是普通聊天请求

- `/init` 是一条普通聊天请求，可以在写作的任何阶段使用；模型判断需要时也会自主建立项目记忆，软件不强制用户先运行 `/init`。
- `/init` 负责创建或谨慎更新项目根的 `WWRITING.md`（项目记忆入口），**不生成固定蓝图**、不要求预先填写题材、章节数或字数。
- 已有的 `OUTLINE.md`、`SETTING.md`、`AGENTS.md` 只作为普通权威文件被索引进 `WWRITING.md`，不强制存在；缺少 `WWRITING.md`、总纲或章节不影响聊天、读取与普通文件编辑。
- `/init` 与其他指令走完全相同的 Agent 循环与事件流：可见的思考/活动/确认/错误状态、同一队列、同一停止机制；保留用户发送的 `/init` 原文与附加要求。
- 已有记忆与创作文件应优先读取、谨慎合并，不得无理由整体覆盖；模型必须报告检查依据与实际变更。
- `WWRITING.md` 是用户可查看、可手工编辑的项目记忆：Agent 负责日常创建、整理、去重和更新；用户删除它表示要求重新建立记忆，不表示该目录不再是工作区。

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

- Session/Run/queue/plan/decision 的真相源是**应用私有 Agent journal**（`<userData>/workspaces/<workspace-id>/agent/events.jsonl`，`session.json` 为可重建投影）；应用私有历史不进入创作目录。
- provider 消息连续性由 `transcript.jsonl` 承担；模型循环、workflow、stop/立即 由 ProjectAgent（`src/core/agent/`，`createProjectAgent` seam）编排。
- 旧项目首次打开时执行一次性只读 legacy 导入（幂等，`migration.json` 标记）；新工作区不再产生 `project.yaml`、`agent_state.json`、`task_queue.json`、`failures.jsonl`、`chat_history.jsonl`。
- 不同工作区各自持有独立 journal 实例与队列，互不共享锁，可以并行运行（跨工作区并行）。

## 8. 项目记忆与权威文件（/init 维护）

- `<projectRoot>/WWRITING.md` 是每个长期工作区的项目记忆入口：当前有效要求、写作风格 ID、进度和权威文件索引都在这里；它不是第二份总纲，也不是聊天数据库。
- `OUTLINE.md`（故事大纲）、`SETTING.md`（世界观与设定）、`AGENTS.md`（项目写作说明）不再是强制蓝图三件套；已存在时作为普通权威文件由 `/init` 索引进 `WWRITING.md`，新项目不预生成空占位文件。
- 写作风格（如 `fast-readable`）确定后写入 `WWRITING.md` 的稳定技能 ID；三个内置风格（`balanced` / `fast-readable` / `psychological-literary`）随应用分发、只读不可删除，通过自然语言指定或由模型判断选择。

## 9. 验证要点（对应验收）

- 普通文件夹（无 `project.yaml`）可发送第一条消息；`/init` 在无任何小说文件的目录可创建 `WWRITING.md`，且不生成固定蓝图；已有记忆不被盲目覆盖。
- 普通确认、input 级同类授权与授权清理；YOLO 跳过普通确认但不跳过 extreme；fresh 精确文字确认不可复用、不可由模型代填。
- Shell cwd/超时/增量输出/进程树停止/1 MiB 独立流尾；密钥与 journal 详情脱敏。
- 同一 activity 合并、私有推理不渲染；`/init` 保留用户原文并使用同一个 Agent 循环。
- 跨工作区并行；stop 取消当前 Run 并清除临时授权；`立即` 保持同一 run id。
