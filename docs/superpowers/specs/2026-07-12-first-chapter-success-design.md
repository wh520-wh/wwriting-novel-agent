# 首章成功路径设计 Spec

日期：2026-07-12  
状态：设计完成，等待用户确认后进入实施计划  
范围：阶段 0 的产品阻塞项 + 阶段 1「首次使用与第一章成功」

## 1. 目标

把 WWriting 的首次使用路径收敛为一条可理解、可验证的作者工作流：

```text
创建/打开小说 → 看到写作准备状态 → 配置并测试模型
→ 开始第 1 章 → 看到真实运行进度 → 阅读完成章节
→ 继续下一章
```

本 Spec 不改变长篇 Agent 的状态机、章节文件格式或模型调用协议。它只负责把现有能力组织成“现在能不能开始写、为什么不能、下一步做什么”的产品入口。

## 2. 研究依据

本轮只采信 2026-07-12 实际读取成功的官方页面：

- Sudowrite Quick Start：
  `https://docs.sudowrite.com/getting-started/dQph1snuwbfMWG9wRjsNug/quick-start/2A4FjtiocrtxHPUyz6WZgR`
- Sudowrite Story Bible：
  `https://docs.sudowrite.com/using-sudowrite/1ow1qkGqof9rtcyGnrWUBS/what-is-story-bible/jmWepHcQdJetNrE991fjJC`
- Scrivener 官方概览：
  `https://www.literatureandlatte.com/scrivener/overview`
- Campfire 官方学习中心：
  `https://www.campfirewriting.com/learn`

得到的可迁移结论：

1. Quick Start 应先把用户带入写作动作，再逐步暴露项目组织和高级能力。
2. Story Bible 的价值不是“字段很多”，而是把项目核心事实集中保存，作为作者和 AI 可共同引用的来源。
3. Scrivener 把草稿、资料、结构和最终导出放进同一个项目工作区；用户不应在多个工具之间拼接完整流程。
4. 作者工具按人物、情节、时间线、世界观等任务表达，比直接展示底层模块名称更容易理解。

WWriting 只吸收这些交互原则，不引入云账号、复杂人物编辑器、拖拽式大纲系统或新的远程数据服务。

## 3. 当前代码边界

### 已有能力，直接复用

- 项目创建：`src/core/app-server.mjs` 的 `POST /api/projects/init`
- 项目打开：`POST /api/projects/open`
- 首页数据：`src/core/app-dashboard.mjs` 聚合项目、状态、章节、事件、模型、审查等 artifact
- 模型配置：`POST /api/settings/update`
- 模型列表：`GET /api/settings/models`
- 临时连接测试：`POST /api/settings/test-connection`
- 写作启动：`POST /api/commands/submit`
- 运行进度：`agent_state.json`、`summary.currentStage`、`summary.activityProgressPercent`
- 章节阅读：`GET /api/chapters/read`
- 现有下一步建议：`src/app-shell/chat-derive.mjs` 的 `deriveSuggestions`

### 本 Spec 允许新增的边界

- 一个纯函数模块，用 dashboard 数据派生写作准备状态。
- 首页准备卡和完成卡的 DOM/样式/交互。
- 对应单元测试、服务端集成测试、app-shell 静态断言和 Electron clickability 探针。

### 明确不改

- 不改 `project.yaml`、`agent_state.json`、`chapter_index.json` schema。
- 不改章节状态机和 `runProject()` 的调度逻辑。
- 不新增独立 onboarding 数据库或用户账号。
- 不在本轮实现模型库重构；模型复用属于后续阶段 2，只在这里显示当前可用模型并提供跳转。
- 不在本轮实现 Story Bible 编辑器；只显示准备写作所需的故事种子和已有状态。

## 4. 用户体验设计

### 4.1 无项目状态

保留现有左侧“新建小说”和“打开本地文件夹”入口，但主区空态只保留一个主要动作：

- 标题：`开始创作`
- 说明：`创建或打开一部小说，应用会保存章节并持续记住故事状态。`
- 主按钮：`新建小说`
- 次按钮：`打开本地文件夹`

不在无项目状态展示成本、缓存、权限或运行日志。

### 4.2 项目刚创建状态

项目初始化成功后，主区首屏显示“写作准备卡”，而不是只显示空聊天流。

卡片内容：

- 小说标题
- 故事种子，过长时折叠但可展开
- 目标章节数
- 每章最低字数
- 当前模型名称和模型状态
- 项目可写状态
- 当前章节：`第 1 章`
- 下一步主按钮

主按钮根据准备状态变化：

| 准备状态 | 展示 | 主动作 |
|---|---|---|
| `ready` | 模型已连接 | 开始写第 1 章 |
| `demo` | 演示模型 | 用演示模型写第 1 章 |
| `missing_model` | 尚未配置模型 | 去配置并测试模型 |
| `invalid_model` | 模型配置不完整 | 检查模型配置 |
| `connection_unknown` | 尚未测试连接 | 测试模型连接 |
| `project_read_only` | 项目不可修改 | 查看项目状态 |
| `running` | 正在写第 N 章 | 查看当前进度 |
| `blocked` | 需要处理问题 | 查看问题 |
| `completed` | 当前目标已完成 | 提高目标章节数 |

主按钮之外最多显示两个次要动作：`查看章节`、`打开故事资料`。不在首屏显示七个以上的技术入口。

### 4.3 模型状态规则

准备卡只展示可操作的结论，不暴露内部错误堆栈：

- 有合法 `active_model` 且不是 mock，且已有成功连接记录或本轮测试成功：`ready`
- `active_model.is_mock === true`：`demo`
- 没有 `active_model`：`missing_model`
- 有模型但字段校验失败：`invalid_model`
- 有模型但尚未测试，且当前没有可确认的连接状态：`connection_unknown`
- 测试返回 `authentication_failed`、`model_not_found`、`network_unreachable` 等分类错误：`invalid_model` 或 `connection_failed`，卡片显示分类后的中文原因和“重新测试”动作

连接测试继续使用现有临时 key 逻辑，测试候选配置不得写入项目或 secrets，key 不进入事件日志、toast 或 DOM 文本。

### 4.4 开始第一章

点击 `开始写第 1 章` 时，前端直接复用现有写作提交路径，发送明确的写作指令，例如：

```text
开始写第 1 章
```

不得新增第二条“快速启动 Agent”后端路径。既有 `isStartWritingIntent()`、`POST /api/commands/submit`、队列和 `runProject()` 继续负责真实启动。

点击后必须立即表现为：

- 主按钮进入 disabled/busy 状态，防止重复提交
- 顶部状态变为“规划中”或“写作中”
- 显示当前章节、当前阶段和活动进度
- 显示停止入口
- 页面开始复用现有 dashboard 轮询

### 4.5 第一章完成

当 dashboard 确认正式章节 artifact 已提交，主区显示章节完成卡：

- `第 1 章已完成`
- 实际字数
- 文件格式和章节状态
- 质量门禁/审查状态
- 主按钮：`阅读第 1 章`
- 次按钮：`继续写第 2 章`
- 有提醒时显示：`查看问题`

“完成”必须使用本地 artifact 真值，不使用模型回复中的“写完了”作为依据。

## 5. 写作准备状态模型

新增纯函数建议命名为 `deriveWriteReadiness(data)`，输入为 `/api/dashboard` 的完整响应，输出稳定、可渲染、可测试的对象：

```js
{
  key: "ready",
  label: "模型已连接",
  detail: "可以开始写第 1 章。",
  primaryAction: "start_chapter",
  primaryLabel: "开始写第 1 章",
  chapterNo: 1,
  modelLabel: "DeepSeek · deepseek-chat",
  blocking: false,
  reasonCode: null
}
```

派生顺序必须固定，避免前端不同区域各自推断出不同状态：

1. `hasProject === false` → `no_project`
2. `project.archived_at` 或有效配置明确为只读 → `project_read_only`
3. `summary.projectStatus === "running"` 或 chat busy → `running`
4. `summary.projectStatus === "blocked"` 或未解决 failure → `blocked`
5. 当前目标已完成 → `completed`
6. 缺 active model → `missing_model`
7. active model 非法 → `invalid_model`
8. mock model → `demo`
9. 有效真实模型且连接状态可确认 → `ready`
10. 其余 → `connection_unknown`

该函数只做状态派生，不调用网络、不读文件、不修改 dashboard、不启动任务。

## 6. 文件与模块设计

### 新增

- `src/app-shell/write-readiness.mjs`
  - 导出 `deriveWriteReadiness(data)`
  - 导出用于测试的状态常量或小型辅助函数
  - 不依赖 DOM、fetch、localStorage
- `tests/app-shell/write-readiness.test.mjs`
  - 覆盖无项目、缺模型、mock、可用模型、运行中、阻塞、完成、归档/只读和非法配置

### 修改

- `src/app-shell/app.js`
  - 在 `renderDashboard()` 统一调用 `deriveWriteReadiness()`
  - 负责准备卡和完成卡的 DOM 更新
  - 复用现有 `openSettingsModal()`、`openDrawerTab()`、`openReader()` 和 composer 写作提交方法
- `src/app-shell/composer.js`
  - 暴露一个受控的“开始当前章节”入口，内部仍调用现有 `submitWritingCommand()`
  - 保持自然语言提交和命令栏提交行为兼容
- `src/app-shell/index.html`
  - 只增加稳定的准备卡/完成卡容器和可访问标签
- `src/app-shell/styles.css`
  - 增加准备卡、阻塞状态、完成卡和响应式布局样式
- `tests/app-shell/app-shell-static.test.mjs`
  - 断言容器、按钮可访问名称和模块引用存在
- `scripts/verify-app-clickability.cjs`
  - 增加真实点击链路：新建项目 → 看到准备卡 → 点击开始第一章 → 看到运行态
- `scripts/verify-app-shell.mjs`
  - 增加 dashboard readiness 字段和项目初始化后首屏断言
- `docs/USER_GUIDE.zh-CN.md`
  - 补充“创建小说后如何开始第一章”和模型未配置时的处理说明

不新增后端 API。若实施中发现现有 dashboard 无法区分 `connection_unknown` 和 `connection_failed`，优先通过已有事件/配置字段派生；只有无法保持正确语义时，才单独评估 API 字段变更。

## 7. 错误与边界处理

- 初始化成功但 dashboard 刷新失败：保留项目初始化成功的 toast，同时显示“项目已创建，但读取状态失败”，允许刷新，不重复初始化。
- 开始按钮被重复点击：前端禁用是第一道防线，服务端既有运行 job 去重是第二道防线；不得创建两个运行任务。
- 模型测试进行中关闭设置：沿用现有 abort 逻辑，不把取消显示成连接失败。
- 模型配置保存失败：准备卡继续显示保存前的有效状态，不显示假成功；错误按字段或分类显示。
- 项目已归档：只允许查询和导出，准备卡不显示“开始写作”。
- 目标章节已完成：显示提高目标章节数的入口，不向 `/api/commands/submit` 发送无效的继续指令。
- mock 模型：明确标记为“演示模型”，允许测试完整 UI/流程，但不能误标为真实模型已连接。
- 章节文件已写入但 dashboard 轮询尚未更新：以 artifact 真值和既有 dashboard 收敛逻辑为准，完成卡不得依赖聊天气泡文本。

## 8. 测试与验收

### 单元测试

- `node --test tests/app-shell/write-readiness.test.mjs`
- 验证派生顺序和每个状态的 `primaryAction` 不漂移。

### 服务端/集成测试

- `node --test tests/app-server-probe.test.mjs tests/app-dashboard.test.mjs`
- 创建项目后读取 dashboard，确认故事种子、目标章节、当前章节和模型状态可被前端使用。
- 使用 mock model 提交“开始写第 1 章”，确认只创建第 1 章任务，并最终存在正式章节 artifact。
- 配置失败时确认不会写入半成品设置。

### App shell 测试

- `npm run verify:app-shell`
- 断言准备卡容器、主动作、状态文案和现有接口引用。

### 真实 Electron 点击验收

- `npm run verify:app-clickability`
- 新增探针至少覆盖：
  1. 点击“新建小说”打开表单。
  2. 创建项目后准备卡可见。
  3. 缺模型时点击“去配置并测试模型”打开设置。
  4. 使用 mock fixture 时点击“开始写第 1 章”进入运行态。
  5. 运行态显示停止按钮，完成 fixture 后出现阅读入口。

### 交付前

```powershell
npm test
npm run verify:app-clickability
npm run verify:app-shell
npm run verify:desktop-shell
npm run verify:local
```

完成标准不是“页面出现了按钮”，而是按钮能命中真实 Electron 事件链，并导致预期的项目状态或 UI 状态变化。

## 9. 非目标与后续拆分

- 阶段 2“模型库与项目选择”单独写 spec，不在本 Spec 中改全局模型配置结构。
- 阶段 3“写作 / 故事资料 / 项目管理”信息架构单独写 spec，避免和首章路径同时改动所有导航。
- 阶段 5“故事记忆可见化”单独写 spec，先确认只读展示的数据来源和冲突表达，再决定是否开放编辑。
- 阶段 6“成书交付”单独写 spec，先围绕现有 Markdown/TXT 导出，不扩展复杂格式。

## 10. 设计自审

- 范围单一：只覆盖首章成功路径和其必要的发布阻塞，不包含模型库、完整故事圣经、导航大重构和导出系统重做。
- 数据边界明确：首选现有 dashboard 和 API，不新增持久化 schema。
- 状态来源统一：所有首页动作由 `deriveWriteReadiness()` 派生，避免多个 UI 分支各自猜测。
- 失败路径明确：未配置、配置错误、连接失败、只读、运行中、阻塞、目标完成均有具体动作。
- 验收可执行：包含纯函数、服务端、app-shell、真实 Electron 和本地总验收命令。
- 未验证来源已排除：Novelcrafter 官方文档首页返回 308，未把其内容写入设计结论。
