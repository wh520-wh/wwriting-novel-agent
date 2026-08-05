# WWriting 小说智能体使用教程

这份教程面向本地使用者和后续开发者，说明如何启动桌面端、打开项目、配置模型、使用资料工具、运行验证和重新打包。

## 1. 安装与启动

在项目根目录执行（将 `你的项目路径` 替换为实际克隆/存放目录）：

```powershell
cd 你的项目路径
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

| 区域 | 你能做什么 |
|---|---|
| 左侧作品栏 | 新建、搜索、打开或切换自己的小说；每部小说有稳定的专属缩略封面，方便长期识别。 |
| 中央创作工作台 | 回到一本书时先看到书名、故事种子、章节进度、累计字数和当前最适合做的动作。 |
| 创作记录与指令区 | 查看智能体实际执行过的写作过程、提出要求、调整方向或继续下一章。 |
| 右侧项目面板 | 在需要时查看章节、模型、运行、资料、成本和审查；它们不会打断日常写作。 |

作品封面是应用根据小说名、故事种子和本地项目位置生成的稳定视觉标记。它不会上传素材、不会改变小说文件，也不需要额外配置。

## 4. 首次写作流程

以下是从创建小说到完成第一章的完整路径。

### 4.1 新建小说

打开应用后，左侧项目栏提供两个入口：

- **新建小说**：点击后打开创建表单，填写小说名、一句话大纲、目标章节数和每章最低字数，确认后自动创建项目并切换到写作准备状态。
- **打开本地文件夹**：选择一个已有项目目录（包含 `project.yaml` 的有效项目），直接恢复上次写作状态。

创建成功后，页面会显示写作准备卡。

### 4.2 阅读准备卡

创建或重新打开小说后，最上方首先是"正在创作"工作台：它显示作品身份、已完成章节 / 目标章节、累计字数和下一步主按钮。模型尚未准备好时，主按钮会带你去设置；模型可用时，它会直接显示"开始写第 N 章"。

准备卡集中展示当前项目的核心状态：

- 小说标题和故事种子（过长时折叠，可展开阅读）
- 目标章节数和每章最低字数
- 当前模型名称和模型状态
- 项目可写状态（只读时会明确提示）
- 当前章节（新建项目为"第 1 章"）
- 下一步主动作按钮

准备卡根据模型和项目状态自动调整显示内容。

### 4.3 缺模型时配置并测试

如果准备卡显示"尚未配置模型"，需要先设置模型：

1. 点击主按钮"去配置并测试模型"，自动打开设置面板。
2. 选择预设（DeepSeek 官方、小米 MiMo 官方或自定义），填写配置。
3. 在 API Key 输入框粘贴你的密钥（密钥会安全保存在本机，不会写入项目文件）。
4. 点击保存，系统会自动测试连接。

测试成功后，准备卡状态会更新为"模型已连接"；如果连接失败，会显示分类后的中文原因和"重新测试"入口。

**注意**：密钥保存在本机（不写入项目文件，项目文件只存环境变量名）；保存后再次打开设置会完整回填，方便你确认已保存的密钥。请只在个人电脑上使用本工具。

### 4.4 真实模型与演示模型状态

- **真实模型**：配置合法的 `openai-compatible` 供应商，填写正确的 API Key，并通过连接测试后，准备卡显示"模型已连接"，主按钮显示"开始写第 1 章"。
- **演示模型**：在没有真实 API Key 时，系统内置的 mock 模型会自动激活。准备卡显示"演示模型"，主按钮显示"用演示模型写第 1 章"。

> **重要**：演示模型不代表已经连接真实供应商。它只用于预览界面和测试写作流程，不会调用任何外部 API。切换回真实模型需要重新配置 API Key。

### 4.5 开始第 1 章

确认模型状态后，点击主按钮"开始写第 1 章"：

1. 主按钮立即进入禁用状态，防止重复提交。
2. 顶部状态切换为"规划中"或"写作中"，显示当前阶段和进度条。
3. 页面出现"停止"入口，可在运行中随时中断。
4. 底部的运行活动面板实时展示智能体的工作状态、当前阶段和步骤。

启动后，页面会自动轮询 dashboard 更新运行进度。

### 4.6 运行中停止

运行过程中，可以通过"停止"按钮中断当前写作任务：

- 中断后正在进行的文件写入会原子完成，不会留下半截文件。
- 已写入的章节内容不会丢失，下次继续时会从 checkpoint 恢复。
- 停止后准备卡重新出现，显示当前项目和下一章信息。

### 4.7 完成后阅读

当 dashboard 确认正式章节文件已被提交后，页面显示章节完成卡：

- 显示"第 N 章已完成"、实际字数、文件格式和审查状态。
- 主按钮"阅读本章"：点击后打开应用内阅读器，展示干净的章节正文（无 segment 标记和标题编号）。
- 阅读器支持字号调节（A- / A+）、翻章（箭头键或点击左右）和"沉浸"宽屏模式。

> 完成判定依据是本地 artifact 真值（文件存在、字数达标、checksum 匹配），而不是模型在对话中说"写完了"。

完成后，创作工作台会出现"阅读第 N 章"入口；它与完成卡中的"阅读本章"打开同一个应用内阅读器。两处入口都只会在最终章节文件已确认保存后出现。

### 4.8 继续下一章

阅读完本章后，点击完成卡的"继续下一章"按钮：

- 系统自动将当前章节推进到下一章。
- 准备卡更新为下一章的信息。
- 如果已经达到目标章节数，完成卡会提示"当前目标已完成"，并提供"提高目标章节数"入口。

如果还没达到目标章节数，完成卡会显示"继续写第 N 章"。达到目标后，该按钮会消失，避免误以为应用会在原目标之外继续生成。

## 5. 配置模型

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

## 6. 使用联网搜索与网页抓取

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

## 7. 技能管理

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

## 8. 章节生成的核心规则

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

## 9. 常用验证流程

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

## 10. 打包

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

## 11. 在线 provider 验收

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

## 12. 在线研究工具验收

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

## 13. 常见问题

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

## 14. 开发注意事项

- 不要把 `node_modules/`、`.demo_runs/`、`dist-desktop/` 提交到仓库。
- 不要把真实 API key 写入项目文件。
- 不要绕过 `safeJoin` 直接拼接项目内部路径。
- 不要让网页内容进入系统提示层。
- 不要把模型聊天正文当成章节交付。
- 修改 Electron 主进程后，至少运行 `npm run verify:desktop-shell` 和 `npm run verify:electron-runtime`。
- 修改 app shell 后，至少运行 `npm run verify:app-shell`。

## 15. 技能系统（B1–B5 重构）

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

## 16. S4.5 对话体验速览

- **过程可见**：发送后占位气泡显示已耗时与智能体当前动作；每个工具动作完成即出现在对话流。
- **随时停止**：占位气泡上的「停止」按钮可中断本轮对话（进行中的文件写入会原子完成，不会留半截）。
- **稿块**：智能体输出的正文片段以衬线"文稿块"渲染并标注字数；隐私模式同样会模糊它。
- **修改确认**：编辑确认卡默认显示段落对照与改动摘要，可切换「行级详细」。
- **依据 chips**：回答下方「依据 · 第 N 章」可点击直达阅读器。
- **消息操作**：悬停气泡可复制 / 重新发送 / 重试本轮。
- **阅读器**：A− / A＋ 调字号（档位会记住）、‹ › 或 ← / → 翻章、「沉浸」加宽视图、选中正文可「问智能体」。
- **快捷键**：按 `?` 或点输入栏的 ⌨ 查看全部快捷键。
