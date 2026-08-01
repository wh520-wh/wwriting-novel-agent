# WWriting Novel Agent

**把长篇小说写作当作工程来管理的本地桌面智能体。**

WWriting 不是"你描述、它代写"的生成器。它是一个桌面写作工作台：由应用负责调度、落盘、状态恢复、字数校验、成本统计和权限边界，让模型只完成当前小步骤——你随时能看到作品进度，中断了可以从断点继续，写完的每一章都是你文件夹里真实存在的文件。

**数据在你手里，交付可验证。**

## 与其他工具的区别

市面上的 AI 写作工具分成两类：云订阅平台（Sudowrite、NovelCrafter、NovelAI）把作品托管在云端，按月付费、专有模型、内容受平台审查；开源 CLI 框架（novel-bot、Novel-OS、SAGA 等）功能强大，但要求自己搭环境、在终端里操作。

WWriting 走第三条路：

| 维度 | WWriting | 云订阅平台 | 开源 CLI 框架 |
|---|---|---|---|
| 作品存在哪 | **你本地的文件夹**，Markdown/TXT 普通文件 | 云端服务器 | 本地文件 |
| 交付是否可验证 | **真实字数门禁 + 工具调用写入 + 审查器**，模型自报字数不作数 | 生成即算完成 | 部分有质量门，无字数硬校验 |
| 模型怎么来 | **自带 API Key**，OpenAI-compatible，DeepSeek / 小米 MiMo 预设，按量付费 | 专有模型，订阅费 | 自带 API Key |
| 使用门槛 | **桌面应用**，Windows 一键安装，全程可视化 | 网页，学习曲线陡 | 终端 + Python 环境 |
| 隐私与审查 | 默认禁网，数据不出本机 | 内容受平台审查 | 由模型政策决定 |
| 成本透明度 | 每次调用记录 token 与成本 | 订阅 + 积分，难以预估 | 不统计 |

一句话：**云平台把作品锁在它的服务器里，CLI 框架把门槛架在终端里，WWriting 把作品和验证都放在你自己的电脑上。**

## 功能亮点

- **本地项目文件夹持久化**：章节正文写入 Markdown/TXT，任何编辑器都能打开；空文件夹可在桌面端初始化为新项目。
- **章节状态机**：规划 → 起草 → 审稿 → 修订 → 定稿 → 摘要。
- **真实字数校验门禁**：以本地统计的字数为准，字数不足触发补写；故障卡上可"补写 N 字"或"接受当前稿"。
- **工具调用写入**：模型必须通过工具调用交付章节，聊天正文会被拒绝——从机制上防止"糊弄式交付"。
- **Checkpoint 断点恢复**：中断后从当前章节和阶段继续，不丢进度。
- **成本与缓存报告**：记录 token、模型调用、成本估算和 provider 缓存字段，用多少一目了然。
- **技能系统**：支持 manifest / hook / 启用 / 禁用 / 导入，内置悬念结尾技能。
- **受控网页搜索/抓取**：默认禁网；来源快照标记为"不可信资料"，不作为系统指令执行。
- **OpenAI-compatible 模型接入**：内置 DeepSeek 官方、小米 MiMo 官方预设，粘贴 API Key 即可用；API Key 只存本机。
- **可验证的开发文化**：1002 个单元/集成测试 + 一键本地验收（`npm run verify:local`），连"按钮看得到但点不动"这类 UI 回归都有真实 Electron 点击防线。

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
2. 中间项目端查看：项目标题与故事种子、完成章节数与总有效字数、章节流水线、最近运行事件、技能管理、资料搜索与网页抓取。
3. 右侧设置端配置：模型供应商、模型名、基础 URL、API Key、最大输出 token、最大模型调用次数、联网权限、搜索接口。
4. 保存设置后，设置卡片会显示"保存中/已保存/错误"反馈，配置写入当前项目的 `project.yaml` 并记入 `run_log.jsonl`。

更完整的操作说明见 [docs/USER_GUIDE.zh-CN.md](docs/USER_GUIDE.zh-CN.md)。

## 项目文件夹（文件即项目）

一个 WWriting 项目目录至少包含：

```text
project.yaml        # 项目配置、目标章节数、模型配置、权限配置、启用技能
agent_state.json    # 当前章节、当前阶段、预算、checkpoint
run_log.jsonl       # 事件日志
chapters/           # 最终章节文件
drafts/             # 草稿和规划文件
memory/             # 章节索引、真实字数、checksum、质量门禁结果
checkpoints/        # 可恢复的阶段快照
sources/            # 搜索/抓取来源快照
skills/             # 项目技能
cost.json           # 模型调用成本汇总
cache_report.json   # 缓存 key 与 provider 缓存指标
```

## 模型与联网配置

- 预设：DeepSeek 官方、小米 MiMo 官方、自定义（OpenAI-compatible）。
- API Key 不写入 `project.yaml`，只保存在本机应用级 secrets，项目文件里只记环境变量名。
- 联网默认关闭；需要资料搜索/抓取时在设置端打开"允许联网"并配置搜索接口。

## 安全设计

- 默认禁网，只有配置允许后才调用搜索/抓取 adapter。
- 网页来源作为不可信资料保存，不作为系统指令执行。
- 明文 API Key 不写入项目配置。
- 项目路径通过 `project.yaml` 校验，项目内部文件访问通过 `safeJoin`。
- 模型正文必须通过工具调用写入草稿，聊天正文会被拒绝。
- 字数由本地统计器计算，模型自报字数不作为完成证据。

## 验证命令

```powershell
npm test                            # 1002 个单元/集成测试
npm run verify:local                # 完整本地验收（含打包，较慢）
npm run verify:app-shell            # GUI、项目打开、设置写回、技能、资料工具
npm run verify:app-clickability     # 真实 Electron 窗口逐项点击关键按钮
npm run verify:desktop-shell        # Electron 安全开关、中文菜单、打包配置
npm run verify:provider-online      # 真实 OpenAI-compatible provider 在线验收
npm run verify:research-online      # 真实网页抓取与可配置搜索接口验收
```

## 目录结构

```text
src/
├─ app-shell/          # 桌面 GUI 前端（Codex 风格三栏）
├─ assets/             # 应用图标
├─ core/               # Agent 引擎、项目存储、模型网关、技能、研究工具
└─ desktop/            # Electron 主进程和 preload
scripts/               # 验证、打包、预览脚本
tests/                 # Node test 测试
docs/                  # 使用教程与设计文档
```

## 竞品调研

产品定位基于 [docs/research/2026-07-31-competitive-research.md](docs/research/2026-07-31-competitive-research.md)：调研了 9 个开源写作 agent（novel-bot、Novel-OS、SAGA、NovelClaw、Openwrite、novel-architect、AI-Novel-Writing-Assistant 等）和 3 个商业平台（Sudowrite、NovelCrafter、NovelAI），结论是：**记忆与连贯性、质量门禁、多智能体已是行业标配，但"本地桌面 GUI + 文件即项目 + 可验证交付"的组合是空白**。

## 当前状态

本地可运行、可验证的桌面写作智能体。核心长跑、恢复、字数门禁、技能、研究工具、模型适配、GUI、Electron 运行时和 Windows 打包链路均已具备验证脚本。

后续增强方向：故事圣经（角色/设定/伏笔管理）、技能生态（技能包导出/导入）、更多 provider 预设、正式代码签名与自动更新。

## 更多文档

- [完整使用教程（中文）](docs/USER_GUIDE.zh-CN.md)
- [English README](README.en.md)
- [竞品调研报告](docs/research/2026-07-31-competitive-research.md)
