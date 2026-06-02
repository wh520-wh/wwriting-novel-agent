# WWriting 小说智能体使用教程

这份教程面向本地使用者和后续开发者，说明如何启动桌面端、打开项目、配置模型、使用资料工具、运行验证和重新打包。

## 1. 安装与启动

在项目根目录执行：

```powershell
cd D:\WWriting
npm install
```

浏览器预览：

```powershell
npm run app:shell
```

Electron 桌面端：

```powershell
npm run desktop:electron
```

开发阶段推荐先用 `npm run desktop:electron`。它会直接读取当前源码，所以源码里的 UI、菜单和逻辑变更能立即看到。

## 2. 打开一个项目

桌面端左侧是项目栏。

操作步骤：

1. 点击“打开本地文件夹”。
2. 选择一个包含 `project.yaml` 的 WWriting 项目目录。
3. 如果选择的是空文件夹，界面会显示“初始化新项目”表单。
4. 填写小说名、一句话/主体大纲、章节数和每章最低字数，然后点击“初始化并打开”。
5. 项目打开后，中间区域会显示章节流水线、字数、模型调用、事件日志等信息。

浏览器预览没有系统文件夹选择器，可以直接在“项目路径”输入框中粘贴项目路径。

有效项目目录需要包含：

```text
project.yaml
agent_state.json
run_log.jsonl
memory/chapter_index.json
```

推荐使用桌面端的“初始化新项目”、本项目的创建逻辑或验证脚本生成项目，不建议只手写一个 `project.yaml` 就直接打开。状态文件、章节索引和日志文件缺失时，仪表盘能读取的信息会不完整。

## 3. 认识界面

界面分为四个主要区域。

| 区域 | 用途 |
|---|---|
| 左侧活动栏 | 切换项目、运行、技能、资料、设置等视图 |
| 项目侧栏 | 打开项目、查看最近项目、查看智能体状态 |
| 中间项目端 | 查看章节流水线、运行事件、技能管理、资料工具 |
| 右侧设置端 | 配置模型、预算、联网、搜索和审查状态 |

这种布局参考 Codex 桌面端：左边选上下文，中间处理当前项目，右侧管理设置和细节。

## 4. 配置模型

打开项目后，在右侧设置端填写模型配置。界面参考 Cherry Studio 的思路提供供应商预设：DeepSeek 官方、小米 MiMo 官方和自定义。

DeepSeek 官方预设会自动填入：

```text
供应商: openai-compatible
模型: deepseek-v4-pro
基础 URL: https://api.deepseek.com
本机变量名: DEEPSEEK_API_KEY
最大输出: 4096
最大调用: 200
```

基础 URL 下方会显示灰色的完整请求地址。OpenAI-compatible provider 默认请求 `基础 URL + chat/completions`，所以上面的例子会显示：

```text
完整请求地址：https://api.deepseek.com/chat/completions
```

小米 MiMo 官方预设会自动填入：

```text
供应商: openai-compatible
模型: mimo-v2.5-pro
基础 URL: https://api.xiaomimimo.com/v1
本机变量名: XIAOMI_MIMO_API_KEY
```

用户只需要在 `API Key` 输入框粘贴官方 key，然后保存。Key 会保存到本机应用级 secrets；项目文件只保存 `DEEPSEEK_API_KEY` 或 `XIAOMI_MIMO_API_KEY` 这样的变量名，不保存密钥值。

保存设置后，系统会：

- 写回当前项目的 `project.yaml`。
- 如果填写了 API Key，把 key 写入本机应用级 secrets，并注入当前运行进程。
- 写入 `project_settings_updated` 事件。
- 重新读取 effective config。
- 刷新右侧设置端和仪表盘数据。

保存过程中，设置卡片底部会显示当前状态：保存中、已保存或具体错误。模型配置保存成功后，运行时预算也会同步刷新。

## 5. 使用联网搜索与网页抓取

联网默认关闭。需要使用资料工具时：

1. 在右侧设置端勾选“允许联网”。
2. 如需搜索，填写搜索 URL。
3. 回到中间的“资料工具”视图。
4. 输入关键词并点击“搜索”，或输入 URL 并点击“抓取”。

搜索接口可以是通用 JSON API。验证脚本中使用过的公开示例：

```powershell
$env:WWRITING_SEARCH_ENDPOINT="https://hn.algolia.com/api/v1/search"
$env:WWRITING_SEARCH_QUERY_PARAM="query"
$env:WWRITING_SEARCH_LIMIT_PARAM="hitsPerPage"
$env:WWRITING_SEARCH_RESULTS_PATH="hits"
```

网页抓取结果会进入：

```text
sources/
sources.md
source_summaries.md
```

所有外部来源都会被标记为不可信资料。网页内容不会直接变成系统指令。

## 6. 技能管理

技能用于扩展写作流程，例如风格控制、章节结尾悬念、质量门禁或后处理。

当前内置示例：

```text
suspense-chapter-end
```

它会：

- 在 planning 阶段要求设计章节结尾悬念。
- 在 reviewing 阶段检查最后 500 个可见字符是否有钩子。
- 检查失败时阻止章节直接定稿。

技能 manifest 的核心结构：

```yaml
name: suspense-chapter-end
version: 1.0.0
type: flow-control
scope: chapter
hooks:
  - stage: planning
    action: append_prompt
    content: 本章大纲必须包含一个结尾悬念设计。
```

技能导入、启用和禁用都会更新 `project.yaml.enabled_skills`，并写入运行日志。

## 7. 章节生成的核心规则

WWriting 的核心原则是“应用负责连续完成，模型负责当前小步骤”。

章节不会因为模型说“我写完了”就完成。完成证据来自：

- 正式章节文件存在。
- 本地有效字数达标。
- checksum 匹配。
- 质量门禁通过。
- `run_log.jsonl` 有完成事件。
- checkpoint 有对应阶段记录。
- 审查器审查通过。

如果模型把正文直接发到聊天回复，而不是请求工具写入文件，系统会把它视为错误输出通道。

## 8. 常用验证流程

开发或修改 UI 后：

```powershell
node --check src/app-shell/app.js
npm run verify:app-shell
npm run verify:desktop-shell
npm run verify:electron-runtime
```

修改核心引擎或项目存储后：

```powershell
npm test
npm run verify:mvp
npm run verify:longrun
npm run verify:faults
```

准备本地完整交付前：

```powershell
npm run verify:local
```

注意：`verify:local` 会重新构建目录包和安装器。

## 9. 打包

生成目录包：

```powershell
npm run package:dir
```

生成安装器：

```powershell
npm run package:installer
```

验证产物：

```powershell
npm run verify:packaged-dir
npm run verify:installer
```

如果你只修改了源码但没有重新打包，`dist-desktop/win-unpacked/WWriting Novel Agent.exe` 不会自动更新。桌面快捷方式指向的是打包后的 exe，所以需要重新打包后才能看到新改动。

## 10. 在线 provider 验收

配置 DeepSeek 或其他 OpenAI-compatible provider：

```powershell
$env:WWRITING_PROVIDER_BASE_URL="https://api.deepseek.com"
$env:WWRITING_PROVIDER_MODEL="deepseek-chat"
$env:WWRITING_PROVIDER_API_KEY_ENV="DEEPSEEK_API_KEY"
$env:DEEPSEEK_API_KEY="你的密钥"
npm run verify:provider-online
```

验证脚本会检查：

- provider 是否能返回文本。
- usage 字段是否能归一化。
- cache 字段存在时是否能读取。
- 缺失缓存字段时不会伪造缓存命中率。

## 11. 在线研究工具验收

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

该验证会同时覆盖：

- 真实网页抓取。
- 正文抽取。
- 来源快照写入。
- JSON 搜索接口字段映射。

## 12. 常见问题

### 左上角菜单还是英文

源码已经通过 Electron 主进程接管原生菜单。如果你运行的是旧的打包 exe，需要重新执行：

```powershell
npm run package:dir
```

然后再从目录包或桌面快捷方式启动。

### 打开文件夹失败

如果目标目录包含有效 `project.yaml`，可以直接打开。若目标目录是空文件夹，使用界面里的“初始化新项目”表单创建项目。若目标目录已有其他文件但没有 `project.yaml`，系统会拒绝初始化，以免误把普通资料目录改写成项目目录。

### 搜索或抓取失败

检查三件事：

- 设置端是否开启“允许联网”。
- 搜索 URL 是否是 `http` 或 `https`。
- 搜索 key 是否只填环境变量名，而不是明文 key。

### 模型调用失败

检查：

- `base_url` 是否正确。
- `model_name` 是否是供应商支持的模型。
- `api_key_env` 是否对应当前 PowerShell 进程里的环境变量。
- 当前项目预算是否耗尽。

### 章节字数不够

这是预期可恢复状态。系统会用本地统计器发现缺口，并通过质量门禁进入补写或修订流程。

## 13. 开发注意事项

- 不要把 `node_modules/`、`.demo_runs/`、`dist-desktop/` 提交到仓库。
- 不要把真实 API key 写入项目文件。
- 不要绕过 `safeJoin` 直接拼接项目内部路径。
- 不要让网页内容进入系统提示层。
- 不要把模型聊天正文当成章节交付。
- 修改 Electron 主进程后，至少运行 `npm run verify:desktop-shell` 和 `npm run verify:electron-runtime`。
- 修改 app shell 后，至少运行 `npm run verify:app-shell`。

## 14. 技能系统（B1–B5 重构）

### 14.1 自定义技能

在 `~/.wwriting/skills/<my-skill>/skill.yaml`（或 `skill.json`）写一个 manifest：

```yaml
name: my-style
version: 1.0.0
type: style
paths:
  - chapters/poetry/**
hooks:
  - stage: drafting
    action: append_prompt
    content: "在每章草稿后追加：'请加入俳句式的短句。'"
```

重启应用后，这个技能会在 `chapters/poetry/**` 目录下自动激活。技能来源优先级：

1. 内置（BUILTIN_SKILLS）
2. bundled-dist（`process.resourcesPath/skills`）
3. 用户（`~/.wwriting/skills`）
4. 项目（`<projectRoot>/skills`）

### 14.2 自定义输出风格

在 `~/.wwriting/output-styles/my-style.md` 写：

```markdown
---
name: My Style
description: 我的写作风格
---
正文作为 prompt 片段，追加到 system prompt 末尾。
```

在设置面板的"输出风格"下拉里选它。Bundled 默认两种风格：`creative`（创作）和 `review`（审稿）。

### 14.3 全局事件总线

5 个 CORE_EVENTS：

- `ModelCallStart` / `ModelCallComplete` — 模型调用生命周期
- `ChapterWritten` — 章节定稿
- `TaskFailed` — 任务失败
- `BackupNeeded` — 备份触发

订阅者：`cost-tracker`、`event-log`、`failures-store`。新订阅者只需 `on(CORE_EVENTS.X, handler)`。

### 14.4 新增内置 slash 命令

1. 创建 `src/app-shell/commands/<name>.mjs`，导出一个命令对象
2. 在 `src/app-shell/commands/index.mjs` 中 import 并 `registerCommand(...)`
3. 测试：`tests/command-registry.test.mjs` 增加用例

### 14.5 路径条件激活

技能 manifest 里的 `paths: [chapters/poetry/**]` 是 gitignore 风格匹配。当用户在 composer 提交时引用到匹配路径（如 markdown 链接），对应的技能会自动激活一次。
