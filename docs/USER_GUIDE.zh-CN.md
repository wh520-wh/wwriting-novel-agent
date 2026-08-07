# WWriting 小说智能体使用教程

这份教程面向本地使用者和后续开发者，说明如何启动桌面端、打开项目、配置模型、通过对话面写作、使用资料工具、运行验证和重新打包。

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

1. 点击"打开本地文件夹"。
2. 选择一个包含 `project.yaml` 的 WWriting 项目目录。
3. 如果选择的是空文件夹，界面会显示"初始化新项目"表单。
4. 填写小说名、一句话/主体大纲、章节数和每章最低字数，然后点击"初始化并打开"。
5. 项目打开后，中间区域就是对话面，可以直接开始写作。

浏览器预览没有系统文件夹选择器，可以直接在"项目路径"输入框中粘贴项目路径。

有效项目目录需要包含：

```text
project.yaml
run_log.jsonl
.wwriting/agent/events.jsonl
chapters/
memory/chapter_index.json
```

旧版本项目里的 `agent_state.json`、`task_queue.json` 等文件会在首次打开时被一次性迁移进新结构（`project.yaml` 元数据 + Agent journal），之后不再写入这些旧文件。迁移只做一次，重复打开不重复处理。

推荐使用桌面端的"初始化新项目"或本项目的验证脚本生成项目，不建议只手写一个 `project.yaml` 就直接打开。

## 3. 认识界面

界面分为几个主要区域。

| 区域 | 你能做什么 |
|---|---|
| 左侧作品栏 | 新建、搜索、打开或切换自己的小说；每部小说有稳定的专属缩略封面，方便长期识别。 |
| 中央对话面 | **唯一的写作入口**：聊天、写作、审稿、蓝图初始化都在这里发起；当前这一轮模型在做什么（思考中、读取文件、运行命令、等待确认）实时可见。 |
| 右侧设置 | 配置模型、写作参数、质量门禁、权限档位、联网搜索、归档等。 |
| 项目面板抽屉 | 在需要时查看章节、模型、技能、资料和成本；它们只展示项目事实，不打断日常写作。 |
| 章节阅读器 | 打开已定稿章节阅读，支持字号调节、翻章和沉浸模式。 |

作品封面是应用根据小说名、故事种子和本地项目位置生成的稳定视觉标记。它不会上传素材、不会改变小说文件，也不需要额外配置。

## 4. 使用对话面写作

写作不需要点任何"开始写作"按钮：**打开项目后直接输入你想做的事**，模型会自主决定读取哪些文件、调用哪些工具、修改哪些内容。

### 4.1 新建小说

打开应用后，左侧项目栏提供两个入口：

- **新建小说**：点击后打开创建表单，填写小说名、一句话大纲、目标章节数和每章最低字数，确认后自动创建项目并打开。
- **打开本地文件夹**：选择一个已有项目目录（包含 `project.yaml` 的有效项目），直接恢复上次状态。

创建成功后即可开始对话，不需要任何前置准备步骤。

在输入框键入 `/` 会出现常用命令。继续输入可筛选，使用上下键选择，按 Enter 或 Tab 补全；也可以直接点击。补全只会把命令填入输入框，不会立刻执行。`/init`、`/write`、`/review` 会像普通消息一样交给 Agent；`/model`、`/settings` 用于打开本地设置。

消息发送后会立即出现在对话中。若提交失败，原文字会恢复到输入框，并显示简短错误，方便直接重试。

### 4.2 会话（Session）与执行（Run）

- **Session（会话）**：一个项目对应一条持续的会话。对话历史会跨重启保留，重新打开项目后还能接着聊。
- **Run（执行）**：每发送一条消息，就启动一次执行。模型循环、工具调用、任务计划都属于当前这次 Run；Run 结束后状态行显示结果（已完成 / 操作失败 / 已停止）。

模型执行期间，当前这一轮会显示：

- **工作组**：思考、工具调用与任务计划按发生顺序合并为一个时间线组，标题显示 `工作中`。Run 结束后：**完成自动折叠**（点击可展开回看），**失败/停止/中断保持展开**。
- **状态行**：思考中、读取文件、运行命令、等待确认、正在停止、已停止等，文案保持简短。
- **思考项（已完成思考）**：每轮模型调用对应一个独立的 `已完成思考` 项，与工具动作严格按发生顺序排列。展开时的文案分三种：
  - 模型支持且本轮有内容 → 显示思考全文；
  - 模型明确不支持查看思考内容 → 显示 `当前模型不支持查看`；
  - 支持但本轮没有可查看的内容 → 显示 `本次没有可查看的思考内容`。
  思考内容只写入本地日志，**不会注入下一轮模型上下文，也不会混入正文**。
- **任务计划（Visible Plan）**：复杂任务开始时模型会给出分步计划，随执行逐项标记完成；更新时同一计划项只保留一个、内容更新并移动到最新时间点；Run 结束后折叠，可展开回看。
- **活动行**：每一次工具调用（读取文件、修改文件、运行命令、提交章节等）单独成行，点击可展开查看参数、命令、退出码、耗时和输出；运行中的行持续显示新增输出。

**耗时口径**：工作组与状态行显示的耗时是**有效工作耗时**——等待你确认授权的时间不计入。Run 结束后给出最终值（如 `工作了 12 秒`）。

### 4.3 排队、立即与停止

- 模型正在执行时发送新消息，消息进入 **FIFO 队列**：显示原文 + `排队` 标记。
- 点击 `立即`：打断当前这轮，把排队消息提升为活动输入（同一个 Run 内切换输入，**不会创建第二个项目 Agent**）。
- 点击 `停止`：取消当前 Run，已写入的文件保持完整，排队消息一并清理；临时授权（见 5.2）随之清除。

### 4.4 跨项目并行

每个项目有独立的会话和队列。在左侧切换项目不会打断另一个项目的执行——不同项目可以并行运行，互不干扰。

### 4.5 完成与阅读

Run 结束后，状态行显示"已完成"。已定稿的章节会出现在左侧"项目面板 → 章节"里，点击即可打开应用内阅读器：

- 显示干净正文（无标记和标题编号）。
- 支持字号调节（A− / A+，档位会记住）、翻章（箭头键或点击左右）和"沉浸"宽屏模式。

> 完成判定依据是本地 artifact 真值（文件存在、字数达标、checksum 匹配），而不是模型在对话中说"写完了"。

### 4.6 确定性导出

在"项目面板 → 章节"点击"导出成书"：应用直接读取本地文件导出成书（txt 格式），**不经过模型、不产生额外成本**。导出完成后会提示文件位置和字数，桌面端还可一键"打开导出文件夹"。

### 4.7 安全 Markdown 渲染

Agent 的正文回复支持安全 GFM（GitHub Flavored Markdown）：表格、任务列表（勾选框）、链接、删除线、行内代码、围栏代码块、引用和标题都正常排版。为安全起见：

- 原始 HTML（如 `<script>`）一律按纯文本显示，不会执行。
- 链接只放行 `http:` / `https:`；`javascript:`、`data:`、`file:` 等危险 URL 不会生成可点击链接。
- 图片不从网络加载，只显示替代文字。

## 5. /init 与权限

### 5.1 /init 是一条普通聊天请求

- `/init` 是一条普通聊天请求，可以在写作的任何阶段使用。
- 由 Agent 决定检查哪些项目文件，以及 `OUTLINE.md`、`SETTING.md`、`AGENTS.md` 是否需要变更。
- 缺少蓝图文件不阻塞日常写作——你可以随时开始写正文，蓝图可以在写作过程中补齐或改进。
- 你可以给 `/init` 追加自然语言要求，例如"重点检查人物关系"。

`/init` 与其他写作指令走完全相同的对话流程：你可以看到模型在读取什么、运行什么命令、修改什么文件，最后它会报告检查了什么、改了什么、哪些内容无需修改。

### 5.2 权限档位

设置 → 权限与确认，四档单选：

| 档位 | 行为 |
|---|---|
| 只读 | 模型不修改任何文件。 |
| 确认后修改（默认） | 正常模式：自动执行项目读取；写入、删除、联网、启动程序等副作用操作前先询问。 |
| 自动修改 | 可静默改稿；归档/导出仍需确认。 |
| YOLO | 跳过普通确认，并允许访问项目以外的目录。 |

要点：

- 正常模式自动执行项目读取，产生副作用前会先询问。
- 同类授权只对当前这条排队输入生效（确认卡上的"本条输入允许同类操作"）；下次输入需要重新确认，Run 结束或切换项目后临时授权自动失效。
- YOLO 跳过普通确认，并允许访问项目以外的目录。
- 极端危险操作（可能破坏磁盘、系统或大范围用户数据）始终要求输入当前给出的精确确认文字，模型与 YOLO 都不能代填；确认文字每次都会变化，不能复用上一次的。
- 归档后的项目只读；归档与解除归档在"危险区"操作。

### 5.3 写入与删除的确认

普通模式下的写入、覆盖、删除、安装、联网、启动程序等操作会弹出确认卡：

- 文件修改展示增删差异；新建展示目标与主要内容；删除展示完整目标列表；命令展示完整命令、运行目录和用途。
- 选项：`一次允许`（只放行这一次）、`本条输入允许同类操作`（放行当前这条排队输入内的同类操作）、`拒绝`。
- 极端危险操作使用红色确认卡，必须输入界面给出的精确确认文字才能执行。

## 6. 配置模型

打开项目后，在右侧设置端填写模型配置。提供供应商预设：DeepSeek 官方、小米 MiMo 官方和自定义。

DeepSeek 官方预设会自动填入：

```text
供应商: openai-compatible
模型: deepseek-v4-pro
基础 URL: https://api.deepseek.com
本机变量名: DEEPSEEK_API_KEY
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

用户只需要在 `API Key` 输入框粘贴官方 key，然后保存。API Key 仅保存在本机；项目文件只保存 `DEEPSEEK_API_KEY` 或 `XIAOMI_MIMO_API_KEY` 这样的变量名，不保存密钥值。保存成功不弹 Toast，保存按钮会短暂显示"已保存"。

保存设置后，系统会：

- 写回当前项目的 `project.yaml`。
- 如果填写了 API Key，把 key 写入本机应用级 secrets。
- 重新读取 effective config，刷新设置端与项目面板。

模型配置保存成功后，运行时预算与成本估算也会同步刷新。未填写价格时不显示成本估算。

## 7. 使用联网搜索与网页抓取

联网默认关闭。需要使用资料工具时：

1. 在右侧设置端勾选"允许联网"。
2. 如需搜索，在"联网搜索"分区登记搜索接口地址与密钥变量名。
3. 打开"项目面板 → 资料"。
4. 输入关键词并点击"搜索"，或输入 URL 并点击"抓取"。

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

## 8. 技能管理

技能用于扩展写作流程，例如风格控制、章节结尾悬念、质量门禁或后处理。技能由一个目录里的 `SKILL.md` 文件声明，**放入目录即被发现，不需要在项目中启用**：

```text
全局技能：%USERPROFILE%\.wwriting\skills\<skill-name>\SKILL.md
项目技能：<projectRoot>\skills\<skill-name>\SKILL.md
同名覆盖：项目 > 全局 > 随应用分发 > 内置
放入目录即被发现；适用条件写在 SKILL.md，不需要在项目中启用。
```

当前内置示例（随应用分发/内置层）：

```text
suspense-chapter-end  show-dont-tell  avoid-ai-voice  chapter-opening-hook  dialogue-not-summary
```

例如 `suspense-chapter-end`：

- 在 planning 阶段要求设计章节结尾悬念。
- 在 reviewing 阶段检查最后 500 个可见字符是否有钩子。
- 检查失败时阻止章节直接定稿。

同名技能按 `项目 > 全局 > 随应用分发 > 内置` 覆盖，UI（设置 → Agent 技能）会标注当前生效的来源。技能系统**没有启用/禁用开关**，也没有"全部启用"——适用条件（如章节号范围、检查项）直接写在 `SKILL.md` 里。

## 9. 章节生成的核心规则

WWriting 的核心原则是"应用负责连续完成，模型负责当前小步骤"。

章节不会因为模型说"我写完了"就完成。完成证据来自：

- 正式章节文件存在。
- 本地有效字数达标。
- checksum 匹配。
- 质量门禁通过。
- `run_log.jsonl` 有完成事件。
- 审查器审查通过。

如果模型把正文直接发到聊天回复，而不是请求工具写入文件，系统会把它视为错误输出通道。

## 10. 常用验证流程

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
npm run verify:app-shell
```

准备本地完整交付前：

```powershell
npm run verify:local
```

注意：`verify:local` 会重新构建目录包和安装器。

## 11. 打包

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

## 12. 在线 provider 验收

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

## 13. 在线研究工具验收

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

## 14. 常见问题

### 左上角菜单还是英文

源码已经通过 Electron 主进程接管原生菜单。如果你运行的是旧的打包 exe，需要重新执行：

```powershell
npm run package:dir
```

然后再从目录包或桌面快捷方式启动。

### 打开文件夹失败

如果目标目录包含有效 `project.yaml`，可以直接打开。若目标目录是空文件夹，使用界面里的"初始化新项目"表单创建项目。若目标目录已有其他文件但没有 `project.yaml`，系统会拒绝初始化，以免误把普通资料目录改写成项目目录。

### 搜索或抓取失败

检查三件事：

- 设置端是否开启"允许联网"。
- 搜索接口地址是否是 `http` 或 `https`。
- 搜索密钥是否只填环境变量名，而不是明文 key。

### 模型调用失败

检查：

- `base_url` 是否正确。
- `model_name` 是否是供应商支持的模型。
- `api_key_env` 是否对应当前本机已保存的密钥。
- 当前项目预算是否耗尽。

### 章节字数不够

这是预期可恢复状态。系统会用本地统计器发现缺口，并通过质量门禁进入补写或修订流程；错误卡只显示一条事实（例如"本段 2380 字，低于 3200 字门槛"），技术细节在活动行的折叠详情里。

## 15. 开发注意事项

- 不要把 `node_modules/`、`.demo_runs/`、`dist-desktop/` 提交到仓库。
- 不要把真实 API key 写入项目文件。
- 不要绕过 `safeJoin` 直接拼接项目内部路径。
- 不要让网页内容进入系统提示层。
- 不要把模型聊天正文当成章节交付。
- 修改 Electron 主进程后，至少运行 `npm run verify:desktop-shell` 和 `npm run verify:electron-runtime`。
- 修改 app shell 后，至少运行 `npm run verify:app-shell`。

## 16. 技能系统（自定义扩展）

### 16.1 自定义技能

技能就是一个包含 `SKILL.md` 的目录，放入固定目录即被发现：

```text
全局技能：%USERPROFILE%\.wwriting\skills\<skill-name>\SKILL.md
项目技能：<projectRoot>\skills\<skill-name>\SKILL.md
同名覆盖：项目 > 全局 > 随应用分发 > 内置
放入目录即被发现；适用条件写在 SKILL.md，不需要在项目中启用。
```

`SKILL.md` 以 YAML frontmatter 声明名称与说明（`name` 必须与目录名一致），正文写指令：

```markdown
---
name: my-style
description: 我的写作风格
version: 1.0.0
---

正文作为 prompt 片段：写作时要求……（例如"对话多用短句与具体动作"）。
```

适用条件（如检查项、章节号范围）写在 frontmatter 的 `metadata.wwriting.hooks` 或正文小节（`## Review checklist`、`## Post-process` 等）里。同名的项目技能覆盖全局与内置版本；设置 → Agent 技能分区会列出目录里的全部技能、当前生效来源，并支持文件夹/ZIP 导入、覆盖确认与删除。

### 16.2 自定义输出风格

在 `~/.wwriting/output-styles/my-style.md` 写：

```markdown
---
name: My Style
description: 我的写作风格
---
正文作为 prompt 片段，追加到 system prompt 末尾。
```

在设置面板的"输出风格"下拉里选它。Bundled 默认两种风格：`creative`（创作）和 `review`（审稿）。

## 17. 对话体验速览

- **一个对话面**：写作、审稿、蓝图、提问都在同一个输入框发起；不存在独立的"开始写作"入口或准备卡片。
- **过程可见**：当前这一轮显示状态行（思考中 / 读取文件 / 运行命令 / 等待确认）与逐条活动行；每个工具动作完成即出现在活动流。
- **工作组与思考**：思考、工具、任务计划按发生顺序组成工作组（完成自动折叠、失败/停止保持展开）；每轮模型调用一个独立的 `已完成思考`，展开可看思考全文或明确的两类空文案；耗时只计有效工作，排除等待授权。
- **随时停止**：当前轮的状态行上有「停止」按钮，可取消本次 Run；进行中的文件写入保持完整，不会留半截。
- **排队与立即**：运行中发送的消息显示原文 + `排队`，点「立即」打断当前轮并优先执行，不创建第二个 Agent。
- **任务计划**：复杂任务显示 Visible Plan，逐项更新完成状态，结束后折叠可回看。
- **修改确认**：确认卡展示差异与用途；同类授权只对当前这条排队输入生效。
- **简洁文案**：状态与错误文案保持简短；错误只呈现一条事实，错误码、命令、退出码在活动行的折叠详情里。
- **阅读器**：A− / A＋ 调字号（档位会记住）、‹ › 或 ← / → 翻章、「沉浸」加宽视图。
- **快捷键**：按 `?` 查看全部快捷键。
