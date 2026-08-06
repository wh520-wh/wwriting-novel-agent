# WWriting Novel Agent

**把长篇小说写作当作工程来管理的本地桌面智能体。**

WWriting 不是"你描述、它代写"的生成器。它是一个桌面写作工作台：所有写作都通过**同一个聊天对话面**（AgentSurface）发起——模型自主读取项目文件、调用工具、修改章节与蓝图，应用负责调度、落盘、状态恢复、字数校验、成本统计和权限边界。你随时能看到模型正在做什么，中断了可以从断点继续，写完的每一章都是你文件夹里真实存在的文件。

**数据在你手里，交付可验证。**

## 功能亮点

- **单一聊天对话面**：写作、审稿、蓝图初始化、提问都在同一个对话里发起；模型的状态（思考中、读取文件、运行命令、等待确认）实时显示在当前这一轮，排队中的输入显示原文 + `排队` + `立即`。
- **本地项目文件夹持久化**：章节正文写入 Markdown，任何编辑器都能打开；空文件夹可在桌面端初始化为新项目。
- **章节状态机**：规划 → 起草 → 审稿 → 修订 → 定稿 → 摘要。
- **真实字数校验门禁**：以本地统计的字数为准，字数不足触发补写；错误以一条事实呈现（如"本段 2380 字，低于 3200 字门槛"），技术细节折叠在活动详情里。
- **工具调用写入**：模型必须通过工具调用交付章节，聊天正文会被拒绝——从机制上防止"糊弄式交付"。
- **Journal 断点恢复**：Session/Run/队列/计划/决策全部记录在项目 journal 中，中断或重启后从断点继续，不丢进度。
- **任务计划可见**：当前 Run 的 Visible Plan 随执行实时更新，完成后折叠可回看。
- **跨项目并行**：每个项目独立会话与队列，不同项目可以并行运行。
- **确定性导出**："导出成书"直接走本地导出流程，不经过模型、不产生额外成本。
- **成本与缓存报告**：记录 token、模型调用、成本估算和 provider 缓存字段，用多少一目了然。
- **技能系统**：支持 manifest / hook / 启用 / 禁用，内置悬念结尾技能。
- **受控网页搜索/抓取**：默认禁网；来源快照标记为"不可信资料"，不作为系统指令执行。
- **OpenAI兼容格式模型接入**：内置 DeepSeek 官方、小米 MiMo 官方预设，粘贴 API Key 即可用；API Key 仅保存在本机。
- **可验证的开发文化**：900+ 个单元/集成测试 + 一键本地验收（`npm run verify:local`），连"按钮看得到但点不动"这类 UI 回归都有真实 Electron 点击防线。

## 快速开始

### 环境要求

- Windows 10/11
- Node.js 24 或更高版本（`npm run desktop:electron`）
- 也可以直接使用打包好的桌面安装包，无需 Node 环境

### 安装依赖

```powershell
npm install
```

### 启动浏览器预览

```powershell
npm run app:shell
```

启动后在浏览器打开终端输出的本地地址。

### 启动 Electron 桌面端

```powershell
npm run desktop:electron
```

桌面端支持系统文件夹选择器：选择一个包含 `project.yaml` 的 WWriting 项目目录，或选择空文件夹并填写小说名、一句话大纲、章节数和每章最低字数，初始化新项目后自动打开。

## 桌面端使用教程

1. 启动桌面端，在左侧项目栏选择最近项目，或点击"打开本地文件夹"。
2. 打开项目后，中间就是唯一的对话面：在输入框用自然语言下指令（"继续写第 3 章""帮我检查人物设定"），模型会自主决定读取哪些文件、运行哪些命令、修改哪些内容。
3. 运行中再发送的消息进入队列（显示原文 + `排队`）；点击 `立即` 会打断当前轮并优先执行这条消息，不会创建第二个 Agent；`停止` 会取消当前 Run 并清除临时授权。
4. 右侧设置端配置：模型供应商、模型名、基础 URL、API Key、写作参数、权限档位、质量门禁、联网搜索。
5. 左侧"项目面板"抽屉查看项目事实：章节目录与导出、模型配置、技能、资料、成本。

更完整的操作说明见 [docs/USER_GUIDE.zh-CN.md](docs/USER_GUIDE.zh-CN.md)。

### 聊天、Session 与 Run

- **Session**：一个项目对应一条持续的会话，对话历史跨重启保留。
- **Run**：每一条消息启动一次执行。模型循环、工具调用、Visible Plan 都属于当前 Run。
- **FIFO 队列**：运行中发送的消息先进先出排队，显示原文 + `排队` + `立即`。
- **`立即` 与 `停止`**：`立即` 打断当前轮、把排队消息提升为活动输入（同一 Run 内切换输入，不创建第二个 Agent）；`停止` 取消当前 Run 并清除本次的临时授权。
- **任务计划**：复杂任务开始后显示 Visible Plan，逐项标记完成状态；Run 结束后折叠，可展开回看。

### /init 与权限

- `/init` 是一条普通聊天请求，可以在写作的任何阶段使用。
- 由 Agent 决定检查哪些项目文件，以及 `OUTLINE.md`、`SETTING.md`、`AGENTS.md` 是否需要变更。
- 缺少蓝图文件不阻塞日常写作。
- 普通权限档（确认后修改）自动执行项目读取，产生副作用前会先询问。
- 同类授权只对当前这条排队输入生效（`本条输入允许同类操作`），下次输入需要重新确认。
- YOLO 跳过普通确认，并允许访问项目以外的目录。
- 极端危险操作始终要求输入当前给出的精确确认文字，模型与 YOLO 都不能代填。

## 项目文件夹（文件即项目）

一个 WWriting 项目目录至少包含：

```text
project.yaml        # 项目身份、配置、blueprint_status
run_log.jsonl       # 章节提交、蓝图提交、导出等领域审计
cost.json           # 模型调用成本累计
chapters/           # 最终章节文件
drafts/             # 草稿和规划文件
memory/             # 章节索引、真实字数、checksum、质量门禁结果
checkpoints/        # 章节一致性阶段快照
sources/            # 搜索/抓取来源快照
skills/             # 项目技能
OUTLINE.md          # 蓝图：故事大纲（可由 /init 创建或改进）
SETTING.md          # 蓝图：世界观与设定（可由 /init 创建或改进）
AGENTS.md           # 项目写作说明（可由 /init 创建或改进）
.wwriting/agent/    # Agent journal：events.jsonl（真相源）、session.json（投影）、
                    #   transcript.jsonl（模型消息链）、migration.json（一次性迁移标记）
```

旧版本项目的 `agent_state.json`、`task_queue.json` 等文件在首次打开时会被一次性迁移进新结构，之后不再写入。

## 模型与联网配置

- 预设：DeepSeek 官方、小米 MiMo 官方、自定义（OpenAI-compatible）。
- API Key 不写入 `project.yaml`，仅保存在本机；项目文件里只记录环境变量名。
- 联网默认关闭；需要资料搜索/抓取时在设置端打开"允许联网"并配置搜索接口。

## 安全设计

- 默认禁网，只有配置允许后才调用搜索/抓取 adapter。
- 网页来源作为不可信资料保存，不作为系统指令执行。
- 明文 API Key 不写入项目配置。
- 项目路径通过 `project.yaml` 校验，项目内部文件访问通过 `safeJoin`。
- 普通模式自动执行只读操作；写入、删除、安装、联网、启动程序等副作用操作需要确认。
- 极端危险操作（可能破坏磁盘、系统或大范围用户数据）必须由用户输入当前确认文字才能继续。
- 模型正文必须通过工具调用写入草稿，聊天正文会被拒绝。
- 字数由本地统计器计算，模型自报字数不作为完成证据。

## 验证命令

```powershell
npm test                            # 900+ 个单元/集成测试
npm run verify:local                # 完整本地验收（含打包，较慢）
npm run verify:app-shell            # GUI、项目打开、设置写回、技能、资料工具
npm run verify:app-clickability     # 真实 Electron 窗口逐项点击关键按钮
npm run verify:desktop-shell        # Electron 安全开关、中文菜单、打包配置
npm run verify:provider-online      # 真实 OpenAI-compatible provider 在线验收
npm run verify:research-online      # 真实网页抓取与可配置搜索接口验收
npm run sim:user-flow             # 用户真实操作全链路模拟（需 DEEPSEEK_API_KEY，默认 flash 模型）
```

## 目录结构

```text
src/
├─ app-shell/          # 桌面 GUI 前端（AgentSurface 对话面 + 导航 + 设置 + 阅读器）
├─ assets/             # 应用图标
├─ core/               # Agent journal/runtime、项目存储、模型网关、技能、研究工具
└─ desktop/            # Electron 主进程和 preload
scripts/               # 验证、打包、预览脚本
tests/                 # Node test 测试
docs/                  # 使用教程与设计文档
```

## 当前状态

本地可运行、可验证的桌面写作智能体。核心长跑、恢复、字数门禁、技能、研究工具、模型适配、GUI、Electron 运行时和 Windows 打包链路均已具备验证脚本。

后续增强方向：故事圣经（角色/设定/伏笔管理）、技能生态（技能包导出/导入）、更多 provider 预设、正式代码签名与自动更新。

## 更多文档

- [完整使用教程（中文）](docs/USER_GUIDE.zh-CN.md)
- [写作 Agent 对话样式规格书](docs/design/写作Agent对话样式规格书.md)
- [Agent 自主初始化与命令行工具规格书](docs/design/Agent自主初始化与命令行工具规格书.md)
- [English README](README.en.md)
