# WWriting 小说智能体

桌面端长篇小说写作智能体。目标不是让模型一次性记住整本书，而是由本地应用负责调度、落盘、状态恢复、字数校验、成本统计和权限边界，让模型只完成当前小步骤。

当前项目已实现一个可本地验证的 Electron 桌面壳、Codex 风格三栏界面、章节生成状态机、技能系统、受控网页搜索/抓取、OpenAI-compatible 模型适配层、审查器和 Windows 打包流程。

## 目录

- [功能亮点](#功能亮点)
- [快速开始](#快速开始)
- [桌面端使用教程](#桌面端使用教程)
- [项目文件夹](#项目文件夹)
- [模型与联网配置](#模型与联网配置)
- [验证命令](#验证命令)
- [按钮点击回归防线](#按钮点击回归防线)
- [故障卡处理](#故障卡处理)
- [打包与桌面快捷方式](#打包与桌面快捷方式)
- [目录结构](#目录结构)
- [安全设计](#安全设计)
- [更多文档](#更多文档)

## 功能亮点

- 本地项目文件夹持久化，章节正文写入 Markdown/TXT 文件；空文件夹可在桌面端初始化为新项目。
- 章节状态机：规划、起草、审稿、修订、定稿、摘要。
- 真实字数统计：不相信模型自报字数，字数不足会触发补写门禁。
- 工具调用写入：模型不能直接用聊天正文交付章节。
- checkpoint 恢复：中断后可从当前章节和阶段继续。
- 成本和缓存报告：记录 token、模型调用、成本估算和 provider 缓存字段。
- 技能运行时：支持 manifest、hook、启用/禁用/导入。
- 内置悬念结尾技能：规划阶段设计钩子，审稿阶段检查章节结尾。
- 受控网页搜索/抓取：默认禁网，来源快照标记为不可信资料。
- OpenAI-compatible provider：内置 DeepSeek 官方和小米 MiMo 官方预设，前端填写 API Key 即可。
- 审查器：只读检查章节文件、checksum、字数、日志和 checkpoint。
- Codex 风格桌面布局：项目端、运行区、设置端分离。
- Electron 桌面入口、Windows 目录包和 NSIS 安装器。

## 快速开始

### 环境要求

- Windows 10/11
- Node.js 24 或更高版本
- npm

### 安装依赖

```powershell
npm install
```

### 启动浏览器预览

```powershell
npm run app:shell
```

启动后在浏览器打开终端输出的本地地址。浏览器预览支持手动输入项目文件夹路径。

### 启动 Electron 桌面端

```powershell
npm run desktop:electron
```

Electron 桌面端支持系统文件夹选择器，可以点击“打开本地文件夹”选择一个包含 `project.yaml` 的 WWriting 项目目录。若选择的是空文件夹，界面会显示“初始化新项目”，填写小说名、一句话大纲、章节数和每章最低字数后即可创建并自动打开。

## 桌面端使用教程

1. 启动桌面端：

```powershell
npm run desktop:electron
```

2. 在左侧项目栏中选择最近项目，或点击“打开本地文件夹”。

3. 中间项目端用于查看：

- 项目标题和故事种子。
- 完成章节数和总有效字数。
- 章节流水线。
- 最近运行事件。
- 技能管理。
- 资料搜索与网页抓取。

4. 右侧设置端用于配置：

- 模型供应商。
- 模型名。
- 基础 URL。界面会在输入框下方显示实际请求地址，例如 `https://api.deepseek.com/chat/completions`。
- API Key。用户直接在前端粘贴 key；应用保存到本机 secrets，项目文件只记录变量名。
- 最大输出 token。
- 最大模型调用次数。
- 联网权限。
- 搜索接口 URL 和搜索 key 环境变量名。

5. 保存设置时，设置卡片会显示“保存中/已保存/错误”反馈；成功后配置写入当前项目的 `project.yaml`，并在 `run_log.jsonl` 中记录设置变更事件。

更完整的操作说明见 [docs/USER_GUIDE.zh-CN.md](docs/USER_GUIDE.zh-CN.md)。

## 项目文件夹

一个 WWriting 项目目录至少包含：

```text
project.yaml
agent_state.json
run_log.jsonl
chapters/
drafts/
memory/
checkpoints/
skills/
prompts/
sources/
```

关键文件说明：

- `project.yaml`：项目配置、目标章节数、模型配置、权限配置、启用技能。
- `agent_state.json`：当前章节、当前阶段、预算、checkpoint。
- `memory/chapter_index.json`：章节索引、真实字数、checksum、质量门禁结果。
- `run_log.jsonl`：事件日志。
- `checkpoints/*.json`：可恢复的阶段快照。
- `chapters/`：最终章节文件。
- `drafts/`：草稿和规划文件。
- `sources/`：搜索/抓取来源快照。
- `cost.json`：模型调用成本汇总。
- `cache_report.json`：缓存 key 和 provider 缓存指标。

当前 GUI 支持打开已有 WWriting 项目目录，也支持把空文件夹初始化为新项目。已有项目目录必须包含有效 `project.yaml`；初始化普通文件夹时，为避免误写入，目标目录需要为空。显式打开 workspace 外项目时，项目内部文件读取仍通过安全路径校验。

## 模型与联网配置

模型配置在右侧设置端维护。界面提供 DeepSeek 官方、小米 MiMo 官方和自定义三类预设。选择预设后，供应商、基础 URL、默认模型和环境变量名会自动填好，用户只需要粘贴 API Key 并保存。

DeepSeek 官方预设：

```text
供应商: openai-compatible
模型: deepseek-v4-pro
基础 URL: https://api.deepseek.com
API Key: 粘贴你的 DeepSeek key
本机变量名: DEEPSEEK_API_KEY
```

OpenAI-compatible provider 默认会请求 `基础 URL + chat/completions`。例如基础 URL 填 `https://api.deepseek.com` 时，界面灰色提示会显示完整请求地址 `https://api.deepseek.com/chat/completions`。

小米 MiMo 官方预设：

```text
供应商: openai-compatible
模型: mimo-v2.5-pro
基础 URL: https://api.xiaomimimo.com/v1
API Key: 粘贴你的小米 MiMo key
本机变量名: XIAOMI_MIMO_API_KEY
```

API Key 不会写入 `project.yaml`。它保存在本机应用级 secrets 文件中；项目文件只保存 `DEEPSEEK_API_KEY` 或 `XIAOMI_MIMO_API_KEY` 这样的变量名。

联网默认关闭。要使用资料搜索或网页抓取，需要在设置端打开“允许联网”，并按需要配置搜索接口。

搜索配置示例：

```powershell
$env:WWRITING_SEARCH_ENDPOINT="https://hn.algolia.com/api/v1/search"
$env:WWRITING_SEARCH_QUERY_PARAM="query"
$env:WWRITING_SEARCH_LIMIT_PARAM="hitsPerPage"
$env:WWRITING_SEARCH_RESULTS_PATH="hits"
```

不要把真实 API key 写入 `project.yaml`、README、测试文件或计划文档。

## 验证命令

常用命令：

```powershell
npm test
npm run verify:app-shell
npm run verify:desktop-shell
npm run verify:electron-runtime
```

完整本地验收：

```powershell
npm run verify:local
```

注意：`verify:local` 会执行打包流程，耗时更长，并会更新 `dist-desktop/` 产物。

单项验证：

| 命令 | 作用 |
|---|---|
| `npm test` | 运行 54 个单元/集成测试 |
| `npm run verify:mvp` | 生成 3 章演示项目，验证字数、落盘和恢复 |
| `npm run verify:longrun` | 连续生成 20 章 mock 长跑 |
| `npm run verify:faults` | 注入模型错误和中断，再由审查器审查 |
| `npm run verify:app-shell` | 验证 GUI、项目打开、设置写回、技能和资料工具 |
| `npm run verify:desktop-shell` | 验证 Electron 安全开关、中文原生菜单和打包配置 |
| `npm run verify:electron-runtime` | 启动 Electron smoke 模式并加载本地仪表盘 |
| `npm run verify:app-clickability` | 启动真实 Electron 窗口并逐项点击关键按钮，防止“按钮看得到但点不动”回归 |
| `npm run verify:provider-online` | 使用真实 OpenAI-compatible provider 做在线验收 |
| `npm run verify:research-online` | 验证真实网页抓取和可配置搜索接口 |

真实 provider 在线验收示例：

```powershell
$env:WWRITING_PROVIDER_BASE_URL="https://api.deepseek.com"
$env:WWRITING_PROVIDER_MODEL="deepseek-chat"
$env:WWRITING_PROVIDER_API_KEY_ENV="DEEPSEEK_API_KEY"
$env:DEEPSEEK_API_KEY="你的密钥"
npm run verify:provider-online
```

真实研究工具在线验收示例：

```powershell
$env:WWRITING_RESEARCH_FETCH_URL="https://example.com"
$env:WWRITING_SEARCH_ENDPOINT="https://hn.algolia.com/api/v1/search"
$env:WWRITING_SEARCH_QUERY="writing agent"
$env:WWRITING_SEARCH_QUERY_PARAM="query"
$env:WWRITING_SEARCH_LIMIT_PARAM="hitsPerPage"
$env:WWRITING_SEARCH_RESULTS_PATH="hits"
$env:WWRITING_SEARCH_TITLE_PATH="title"
$env:WWRITING_SEARCH_URL_PATH="url"
$env:WWRITING_SEARCH_SNIPPET_PATH="author"
npm run verify:research-online
```

## 按钮点击回归防线

本项目多次出现过“按钮看得到但点不动”的回归，尤其是“设置”“新建小说”和抽屉/弹窗里的动态按钮。排查时不要只检查单个按钮的 `click` 监听，优先确认整个前端模块是否成功启动。

常见根因：

- `app.js` 的 ESM 依赖加载失败，导致动态导航没有渲染、事件监听没有绑定。已出现过的案例是 `components/failure-card.js` 引入 `../../shared/failure-commands.mjs`，但本地静态服务器没有正确服务 `/shared/*.mjs`。
- `.mjs` 没有返回 `text/javascript`，浏览器/Electron 拒绝加载模块。
- Electron 原生标题栏覆盖、CSS drag region、toast/scrim/隐藏弹窗拦截了鼠标事件。
- UI 改版后测试选择器漂移，测试没有继续点击真实可见按钮。

修 UI、静态资源服务、Electron 壳或打包配置后，至少运行：

```powershell
npm run verify:app-clickability
npm run verify:app-shell
npm run verify:desktop-shell
```

交付桌面快捷方式使用前运行：

```powershell
npm run verify:local
```

`verify:app-clickability` 会用真实 Electron 鼠标事件点击刷新、隐私、导航、新建小说、设置、API Key 控件、联网开关、章节/阅读器、资料按钮和命令栏。只有这项通过，才能说明关键按钮真的可点击。

## 故障卡处理

写作过程中出现字数不足、预算耗尽、模型服务异常等情况时，对话流里会出现故障卡。卡片上的按钮是真实操作：

- 补写 N 字：把缺口作为补写指令注入下一次生成。
- 接受当前字数继续 / 接受当前稿：跳过本次质量门禁，直接进入定稿。
- 提高预算到 N：同步更新运行预算和 `project.yaml`，并自动续跑。
- 去设置切换模型：打开设置弹窗换模型后再继续。
- 停在这里：干净暂停当前运行，状态显示「已暂停」，发送新指令即可恢复。

每次处理都会写入 `run_log.jsonl`（`failure_resolved` 事件）并把决定记录在 `failures.jsonl`。

## 打包与桌面快捷方式

生成 Windows 目录包：

```powershell
npm run package:dir
```

目录包输出：

```text
dist-desktop/win-unpacked/WWriting Novel Agent.exe
```

生成 NSIS 安装器：

```powershell
npm run package:installer
```

安装器输出：

```text
dist-desktop/WWriting Novel Agent-0.1.0-Setup.exe
```

验证打包产物：

```powershell
npm run verify:packaged-dir
npm run verify:installer
```

如果刚修改了源码但没有重新打包，桌面快捷方式指向的旧 exe 不会包含最新改动。需要重新运行 `npm run package:dir` 后，快捷方式指向的目录包 exe 才会更新。

## 目录结构

```text
D:\WWriting
├─ src/
│  ├─ app-shell/          # 桌面 GUI 前端
│  ├─ assets/             # 应用图标
│  ├─ core/               # Agent 引擎、项目存储、模型网关、技能、研究工具
│  └─ desktop/            # Electron 主进程和 preload
├─ scripts/               # 验证、打包、预览脚本
├─ tests/                 # Node test 测试
├─ docs/                  # 使用教程和扩展文档
├─ task_plan.md           # 长期计划和完成记录
├─ findings.md            # 设计发现、风险和决策
├─ progress.md            # 实现进度和验证记录
├─ package.json
└─ README.md
```

## 安全设计

- 默认禁网，只有配置允许后才调用搜索/抓取 adapter。
- 网页来源作为不可信资料保存，不作为系统指令执行。
- 明文 API key 不写入项目配置；前端填写的 key 只保存到本机应用级 secrets，项目里只保存环境变量名。
- 项目路径通过 `project.yaml` 校验；项目内部文件访问通过 `safeJoin`。
- 模型正文必须通过工具调用写入草稿，聊天正文会被拒绝。
- 字数由本地统计器计算，模型自报字数不作为完成证据。
- 审查器只读审查本地事实，不修改章节正文。

## 当前状态

本项目是本地可运行和可验证的桌面写作智能体原型。核心长跑、恢复、字数门禁、技能、研究工具、模型适配、GUI、Electron 运行时和 Windows 打包链路已经具备验证脚本。

仍适合作为后续增强的方向：

- 正式代码签名。
- 自动更新。
- 更多 provider/search 预设。
- 可见窗口人工 UX 巡检。
- 安装/卸载全流程手工验收。
- GUI 内的新建项目向导。

## 更多文档

- [完整使用教程](docs/USER_GUIDE.zh-CN.md)
- [任务计划](task_plan.md)
- [设计发现](findings.md)
- [进度记录](progress.md)
