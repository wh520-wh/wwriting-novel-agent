# 2026-09-26 第二十二轮规格：UI/UX 与模型配置（对齐 ZCode 级体验）

记录于：2026-09-26｜状态：当前有效｜依据：访谈 3 轮拍板（含用户 2026-09-26 裁决：废止「每轮只处理一个收敛目标」、A/B/C 全部纳入本轮、密钥存储名从产品移除、界面美观度须达 ZCode 级、文案不得「为解释而解释」、内置模型只作候选池不入列表）+ 实机复现（真实后端 + 浏览器逐点驱动，5 次跑批）+ ZCode 3.14.3 源码侦察（Apache-2.0）+ 一轮独立对抗式审查（22 条，已并入）

> 本文件是**规格**：写「改什么、为什么、怎么算改完」。**任务拆解、提交切分与执行顺序见后续计划文件**，按用户指令，计划在收到明确指令后另写。
>
> **审查披露**：本轮只完成了一轮独立审查（漏项与半成品，22 条）。原计划的第二轮（锚点与数字的事实核查）**因子代理额度耗尽未执行**。文中所有 `file:line` 锚点由作者自行复核过，但**没有第二双眼睛**。执行期第一步应是对本文件锚点做一次机器核对。

## 审美立场（本轮界面判据的第一来源）

这一节先定主张，再谈实现。凡是与本节的冲突，以本节为准；凡是本节能回答的，不再写进决策重复一遍。

1. **界面不解释自己。** 能用控件状态表达的事，不写句子。锁用锁图标表达，禁用用灰控件表达，下一步用按钮的文案与可用态表达。凡属「我们做了什么」的自我说明，一律删。
2. **一条信息只出现一次。** 同一事实在两处出现即为冗余，删到一处。典型违例：厂商名同时出现在列表行、面板标题、面板正文里。
3. **默认不等于全量。** 列表只装用户放进去的东西。候选池放在「添加」入口里，不铺在主列表上。
4. **空态是邀请，不是说明书。** 空态只给一个可做的动作，不给一段解释。
5. **文案只在「不写就会做错」时出现。** 判据是反事实：删掉这句话，用户会不会做错？会，就留；不会，就是噪音。错误提示、状态后果、不可逆操作属于前者；背景介绍、能力自夸、流程复述属于后者。
6. **不用解释性口吻填补空白。** 稀疏的界面是设计，不是缺陷。宁少一句，不多一句。

本轮的验收文案判据：**逐条剔除「不写也不会做错」的字符串**，并把剔除清单列在提交说明里。

## 一句话

一次修完三条已复现的缺陷链（**项目/会话身份**、**模型配置**、**排版线条**），把模型配置按 ZCode 的成熟形态重做（目录只作候选池、三协议抽象、零人造标识符、列表只装用户放进来的模型），并按上节的审美立场重写界面文案与状态表达。

## 背景（已核实事实）

### 缺陷链 A：项目与会话身份

- **普通文件夹（无 `project.yaml`）被前端当成「没有项目」。** 后端 `app-dashboard.mjs:60-72` 对有 `projectRoot`、有 `sessions` 的普通文件夹**故意**返回 `hasProject:false`（合法工作区形态，SPEC §2.1），但 `app.js:736-742` 据此把 `currentProjectRoot` 置空、顶栏写「开始创作」，并在 `seedSessions` 之前 `return`。
- 连锁后果（实测）：`session-sidebar.mjs:595` 的 `if (!projectRoot) return;` 丢弃**全部**会话列表推送，普通文件夹里新建的对话**永远不出现在侧边栏**。证据：主区已生成对话与失败卡、后端 `/api/agent/sessions` 已返回该会话（`dcf01e66-...`），侧边栏仍「还没有对话」、顶栏仍「开始创作」。
- **活跃高亮按项目各自记账。** `session-sidebar.mjs:284` 用该项目自己缓存里的 `activeSessionId`（`sessionCache` 见 `:72`，写入点 `:597-600`），没有「只有当前项目才高亮」的判断。实测切到项目 B 后 DOM 里同时存在**两行 `.session-row.active`**（一行属 B、一行属 A）。
- **点加号零反馈。** 草稿态按设计不进列表（`session-sidebar.mjs:283` 过滤 `status === "draft"`），点「+」后列表无新行、原项目仍「还没有对话」，用户可感知的变化是「什么都没变」。
- **21-2 的项目锁键**：`src/core/agent/tools/index.mjs:846-847` 的 `projectLocks.runExclusive(context.projectRoot, ...)` 用**未解析**根作键，同一物理项目经链接路径与真实路径打开会拿到两把锁，并发写不被串行化。**订正**：本轮此前的草稿把位置误记为 `agent/index.mjs:847`（该文件全文 72 行），实为 `tools/index.mjs:846-847`；同一函数在 `:654-662` 已把解析后的真实根写入 `context.resolved_project_root`（round21 路径身份统一的产物），因此修法是**取现成值**，不新增解析。

### 缺陷链 B：模型配置

- **「添加供应商」表单零 CSS。** `styles.css:1351-1369` 的输入框样式作用域是 `.model-settings-body section ...`，而该表单挂在 `aside` 下（`model-settings-page.js:588`）。实测：表单盒 661×74 装 12 个子元素，全部 `display:inline` / `inline-block`，落在 7 个不同基线（396/399、421/422/424、445/447）；Base URL 输入框宽 159px 而 `scrollWidth` 181，内容被截断。
- **密钥存储名被前端强制必填，后端并不要求。** `addProvider`（`model-settings-page.js:374-400`）前置拦截「名称、Base URL 与密钥环境变量名为必填项」；而 `POST /api/settings/providers` 只给 name + base_url **创建成功**（`api_key_env: ""`）。真实原因是实现细节：该 POST **有意忽略** `api_key`（`providers-routes.mjs:71`），密钥只能靠后续 PATCH 落盘，而 PATCH 需要桶名，否则 `400 invalid_api_key_env`（`:97-100`）。该名字只是 `~/.wwriting/secrets.json` 的存储键，用户**不需要**预先存在同名系统环境变量（应用自己注入 `process.env`，`:106`）。
- **该设计留下一个坑（已实测造出）**：env 名在创建时不校验、只在 PATCH 时校验，非法名穿过创建，留下「半配置供应商」（创建成功、密钥永远存不进去）。
- **无草稿保护，误退出静默丢数据（实测）**：在表单填 3 个字段后点「关闭」，**无任何确认直接关闭**；重开时名字、地址、env 名全空且表单收起。根因：值只活在 DOM 里（`model-settings-page.js:436-448` 从 `input.value` 现读），autosave 只在 `change`（失焦）触发（`dom-kit.js` 的 `bindAutosave`），且该表单**不在 `isDirty()` 覆盖范围**（`model-settings-page.js:503-518`）。`renderDetail` 每次重建并重置 `activeDraftRefs`（`:593-598`）。
- **「添加模型」没有模型 ID 输入。** `addModel` 直接 POST 字面量 `model_name: "new-model"`，弹提示让用户去名称框改名回车。
- **脏数据确认文案写错分区**：`settings-modal.js:812-814` 写死「放弃未保存的修改？」「写作参数有未保存的修改」「不保存并关闭」，而脏状态来自模型设置分区；该分区本就是即时生效，不存在「保存」语义。
- **两栏布局是死代码**：`styles.css:1305-1307` 主动把 `.model-settings-body` 压成单列。注释自述为过「1280 视口详情列 326px < 360px」的检查点。**已查明**：该检查点位于 `scripts/capture-visual-acceptance.cjs:2489-2491`，而该脚本头部 `:3-7` 自述已过时、运行必失败、不得用于视觉验收；窄屏兜底另已在 `styles.css:1461-1462` 存在。故删除 `:1307` 不会破坏窄屏行为。
- **`api_format` 硬编码遍布四处以上（订正：至少 9 处）**。此前草稿只列 4 处，遗漏了**致命的一处**：
  - `model-provider-store.mjs:10` 自带一份 `ALLOWED_API_FORMATS = new Set(["openai-chat-completions"])`，`:76` 用它判定，**不通过则 `normalizeProvider` 返回 `null`**，`:209` 抛 `invalid_provider`。后果：目录里任何非 OpenAI 协议的厂商**存盘即被静默丢弃**。
  - 同文件 `:388` 预设迁移路径亦写死。
  - `model-config-validation.mjs:3`（allow-list）、`:48`（仅 `openai-compatible` 分支才校验 base_url / api_key_env）、`:65-66`（报错文案「本轮仅支持 OpenAI Chat Completions 协议」）。
  - 前端整层：`model-settings-page.js:374`、`:548-551`、`:557`、`:664-668`（非法值回退 + toast）。不改这几处，目录厂商的协议落不了盘。
- **连接测试硬绑 OpenAI 协议**：`model-connection-test.mjs:11` 直接 `import { OpenAICompatibleAdapter }`，`:141-149` 硬构造。不列入变更面则「三协议可连接」的验收不可能通过。

### 缺陷链 C：排版线条（均为实测值）

| 现象 | 测量 |
|---|---|
| composer 右边比正文列宽 8px | `.agent-messages` 右缘 1248、`.agent-composer-shell` 右缘 1256，左缘同为 304。因 `agent.css` 的 `.agent-conversation` 用 `scrollbar-gutter: stable`，而 `styles.css:280` 的滚动条宽 8px，单向补偿 |
| 会话树连接线悬空 | `.session-group` 的 `border-left` 落在 x=**18**，而折叠箭头中心 26、项目图标中心 49、会话行左缘 28.7，与谁都不对齐 |
| 选中竖条压住状态点 | `.session-row.active::before` 占 28.7-31.7，`.session-status` 占 30.7-38.7，**重叠 1px**；伪元素在定位层、圆点在静态层，竖条盖住圆点左缘 |
| `.field-error` 无任何 CSS | `model-settings-page.js` 用了 4 处（609/645/724/763），两样式表**只有 `.spd-field-error`**（`styles.css:1170`） |
| 供应商名输入框宽 157px | 同面板宽 683px，其下 Base URL 满宽；`.provider-detail-head` 无布局规则，输入框退回默认 `size`。**恢复两栏后详情列更窄，此条会更糟**，必须与 `.dfield` 一起改 |
| 图标表缺 `lock` | `icons.js` 共 **19** 条路径（此前草稿记 20、审记录 18，均误），**无 `lock`**。D9 的锁定字段需要它 |

### 门禁实况（2026-09-26 实跑）

| 门禁 | 结果 |
|---|---|
| `npm test` | exit 0，2001/2001（~66s） |
| `verify:unified-agent` | exit 0，36/36 |
| `verify:desktop-shell` | exit 0 |
| `verify:app-shell`（834 行 / 145 断言） | **exit 1**，`scripts/verify-app-shell.mjs:372`（欠账 21-7） |
| `verify:app-clickability`（623 行） | **exit 1**，`scripts/verify-app-clickability.cjs:180`（**未登记**） |

两条红的性质不同，指向同一处结构问题：

- `verify-app-shell.mjs` **从不启动浏览器**（grep `BrowserWindow` / `app.whenReady` / `loadURL` / `loadFile` 全空），靠手写 `MockElement`（`:223`）当 DOM，断言大量是对源码文本 `html.includes(...)`。它红的**不可归因**：21-7 原文即「是投影回退出『已完成思考』回退文案，还是夹具未产出耗时」；round20 还曾为修其**假红**给该桩补过 `insertBefore` / `parentNode` / `nextSibling` / `isConnected`。
- `verify-app-clickability.cjs:164` 是**全文件唯一一处坏守卫**：等 `#project-list.children.length > 0`，而 `index.html:43-50` 的静态启动骨架屏自带 3 个 `.skel-row`，该条件在页面加载瞬间即成立，随即查 `.proj-row` 与 `loadProjectList()` 抢跑。**6 次观测 5 红 1 绿**。同文件其他 12 处等待（`:181` / `:316` / `:367` 等）都等具体下游症状，写法正确。
- **类根因**：`app.js:1014` 的 `window.__wwritingMotionReady = true` 在 `await loadAll()`（`:1016`）**之前**置位，只表示「动效初始化完」。应用**没有任何一句真话叫「我准备好了」**，于是每个 harness 各自发明等待条件，各自可能抢跑。现有消费者共 5 处：`scripts/capture-visual-acceptance.cjs:1356` / `:2338` / `:2376`、`scripts/capture-all-ui.cjs:805`、`scripts/verify-app-clickability.cjs:159`。
- **视觉断言的错位**：`npm test` 中有 4 个文件共 **1105 行 / 274 断言**专锁样式值（`text-style-contract` 492/94、`ui-layout` 234/67、`ui-maturity-contract` 225/73、`codex-visual-contract` 154/40），断言如「`--r-lg` 12px」「顶栏发丝下边框」「运行区无横杠」。它们对上述 6 类真排版缺陷**零命中**（CSS 文本断言看不见布局），而本轮视觉重做会让其中一大批变红。唯一真渲染的 `capture-all-ui.cjs`（1266 行）**不在任何门禁内、无断言**；`capture-visual-acceptance.cjs` 已自述失效。

### ZCode 侦察结论（借鉴标的，Apache-2.0）

覆盖 `packages/provider`（4,827 行）、`provider-node`（1,895 行）、`services/src/model-provider`（5,141 行）、`ui/src/settings/model-provider-section`（12,562 行 + 页面 1,161 行）、目录 `config/provider/zcode-builtin.json`（6,212 行 / 186,892 B，`revision: 30`）。

**值得借鉴的四点：**

1. **三协议枚举**：`anthropic-messages` / `openai-chat-completions` / `openai-responses`（`provider-data-schema.ts:4-8`）；厂商到协议的映射**在目录数据里**（`config.api.type`），分发点单一（`model-execution.ts:350-372` 一个 switch）。
2. **厂商挑选 + 零人造标识符**：供应商卡片挑选（`ProviderTemplatePicker.tsx`，含一张「Create Custom Provider」卡）；ID 与名称由 `nextPersonalProviderId()` / `nextPersonalProviderLabel()` 自动派生去重（`config-service.ts:688-708`、`:744-757`）。**用户从不发明环境变量名，也不存在「密钥存储名」概念。**
3. **常见场景只需一个 key**：选中厂商后粘 API key 即完成；名称、Base URL、协议、模型清单继承自模板；已知厂商的连接字段渲染为**锁定只读**（`ProviderCardSections.tsx:208-241`，带锁图标）。
4. **模型能力与厂商条目分离**：厂商条目只有 `builtinModelIds: string[]`；能力在 5 组全局正则规则里，按 `(providerId, templateId, modelId, apiType, baseUrl)` 解析时匹配。读一个厂商条目**并不知道**它的模型行为。

**对 `ZCode源码分析报告.md` 的四处订正：**

| 报告原话 | 实况 |
|---|---|
| 「内置厂商模板 **21** 个」 | **20** 条 `templateRules`，仅 **12** 个不同品牌（zai / bigmodel / kimi / minimax / deepseek / qwen / xiaomi-mimo / openai / anthropic / xai / openrouter / opencode），其余为同品牌协议与套餐变体（zai×2、bigmodel×2、opencode×6）；另有 8 条 OAuth 套餐型 `providerRules` |
| 「每家厂商只是一个 JSON 配置模板」 | 条目确为一个模板，但**模型能力在 5 组全局规则**里，读条目不知道模型行为 |
| 「接入新厂商改配置即可，不用改代码」 | 仅对「已说三协议之一 + 静态 API key」的厂商成立；OAuth 套餐型、端点网关改写、新协议都需改代码 |
| （未提）目录是远端同步的 | 目录带 `revision`，有 bundled + LKG 缓存 + synchronizer，含发布与校验机制 |

**另两条影响决策的发现**：

- **ZCode 不做端点模型发现**：全仓无 `${baseUrl}/models` 请求，`listModels` 只是进程内注册表列举；「Test」是发一次真实模型请求。
- **ZCode 把自定义供应商的 API key 明文存在 `~/.zcode/v2/provider_config.json`**（仅 OAuth 凭据走 `credentials.json` 的 AES-256-GCM）。**这条不抄**：WWriting 现有独立 `~/.wwriting/secrets.json` 更好，保持。

## 决策

### A. 项目与会话身份

- **D1 普通文件夹取「语义分离」档，且必须保留首次接线。** 把「有没有项目配置」与「有没有打开项目根」拆成两个判断，`currentProjectRoot` 始终等于作者打开的项目根；顶栏显示项目名。**不新增**视觉标识或徽标。
  - **硬不变量**：`app.js:744` 的 `const firstLoad = currentProjectRoot !== data.projectRoot;` 与 `:745-748` 的 `agentSurface.openProject()` 是**唯一**接线点。若只把 `:737` 的置空改成赋值，普通文件夹首次加载时 `firstLoad` 变 `false`，**composer 与 SSE 永不接线**。因此必须另立一个「上次打开过的根」记录来触发 openProject，**不得**借用 `currentProjectRoot` 承担这个语义。
  - **名称数据来源**：普通文件夹的 dashboard 返回 `project: null`（`app-dashboard.mjs:63-72`），只有 `projectRoot`。**取后端补 `name` 字段**（复用 `buildProjectList` 已有的 `path.basename` 口径），前端不自行派生，避免尾分隔符 / UNC / 盘根三类边界各写一遍。
  - **故意保持 `hasProject` 语义的站点**（本轮只读不动，防止顺手扩 scope）：`settings-modal.js:264`、`:282`、`:792`、`:897`、`drawer-panels.js:23`。
- **D2 活跃会话全局唯一，且消除第二状态源。** `CONTEXT.md` 已定义「活跃会话全应用同一时刻只有一个，项目自身不保留记号」。现状 `sessionCache`（`session-sidebar.mjs:72`）按项目存 `activeSessionId`，`:597-600` 写入、`:284` 取用，这是**第二个状态源**。取**删除该字段**（缓存只存 `sessions`），高亮改由应用级当前活跃 id 判定。仅做渲染抑制而保留缓存字段，与术语定义冲突，不接受。
- **D3 加号必须有可见、可证伪的反馈。** 形态：点「+」后在会话列表当前项目组内**插入一行草稿行**，沿用既有 `.session-row` 样式并加 `.session-draft`（该类已存在于 `styles.css:1898`），文案为「新对话」，次级灰字；发送首条消息后该行被真实会话替换。**验收**：点「+」后 500ms 内 `.session-draft` 行出现；发送后该行消失且真实会话行出现。
  - 与 D14 的关系：`.session-draft` 的样式规则**已存在**，本轮只改其呈现，不新增规则块；若确需微调，走「改值」而非新增。
- **D4 项目锁键用现成的真实根（一行）。** `src/core/agent/tools/index.mjs:846-847` 改为 `context.resolved_project_root ?? context.projectRoot`。不新增解析调用，不改锁注册表。**不做**路径归一的显示面部分（留在欠账 21-2 单独排）。

### B. 模型配置

- **D5 立三协议缝，并收口全部硬编码站点。** 在 gateway 与 app-server 之间按 `api_format` 分发适配器；实现 `anthropic-messages` 与 `openai-responses`，`openai-chat-completions` 复用 `openai-compatible.mjs`。**变更面必须含**（缺一即失败）：
  - `model-provider-store.mjs:10`（store 自带 allow-list）、`:76`（静默丢弃点）、`:207`、`:209`、`:350`、`:388`
  - `model-config-validation.mjs:3`、`:48`、`:65-66`
  - `app-server.mjs:319`（显式拒绝非 `openai-compatible`）
  - **`model-connection-test.mjs:11` 与 `:141-149`**（否则连接测试仍用 OpenAI 形状打 Anthropic 端点）
  - 前端 `model-settings-page.js:374`、`:548-551`、`:557`、`:664-668`
  - **第四项 `gemini-generate-content` 的处置**：本轮**删除**该选项（无实现计划，留着就是死旋钮，与 round14 删除 `output_style` 的口径一致）。
  - **「不做会坏掉什么」的可证伪答案**：今天用 Anthropic 协议端点，`ALLOWED_API_FORMATS` 直接拒绝，应用**完全不可用**；这类用户（含大量中转站）没有任何绕行路径。
- **D6 能力矩阵带协议维度。** `capabilities.mjs` 的 reasoning 三态与窗口 / 输出口径必须按协议分派。现状 resolver 以 `matcher(modelConfig)` 匹配，DeepSeek resolver（`:40-49`）只看 `model_name`。**必须写明**：`api_format` 从 profile（`model-config-validation.mjs:21`）进入能力判定的**具体位置**，以及新增哪些 resolver 规则。不得让新协议静默沿用 OpenAI 形态。
- **D7 目录只作候选池，模型列表只装用户放进来的东西。** 现有 2 条预设扩成**内置厂商目录**（数据文件，按协议分组）：
  - 目录是**身份与连接信息**的唯一来源：名称、分组、协议、Base URL、**候选模型 ID 列表**、图标键。
  - **候选模型不进主列表。** 列表只呈现「已添加」的模型。候选池只在两个入口出现：点「添加模型」后的可搜索选择器，或「拉取模型」的结果。
  - **与既有预设的关系**：目录**取代** `model-presets.mjs` 的硬编码预设（原 2 条降级为目录里的 2 条），`ensurePresetProviders` 的种子逻辑改为「首启只播种目录里标了 `seeded` 的条目（= 原 2 条预设），但**不播种模型**」。既有用户已落盘的模型不受影响（迁移只加不减）。
    - **订正（记录于 2026-09-26｜依据：原型实机验证）**：本条此前写作「首启按目录播种**供应商**」，照字面执行会把整个目录（原型里 10 家）**全部塞进主列表**，与审美立场第 3 条（默认不等于全量）直接冲突。故种子改为**按条目标记**：只有原 2 条预设 `seeded: true`，其余厂商只能经「添加供应商」的候选池进入。新用户仍看到原 2 家供应商，但其模型列表为空；老用户已落盘模型不删除。
  - **数据文件规格**：`src/core/model/vendor-catalog.json`，含 `schemaVersion` 与 `revision`；条目形状 `{ id, nameMap:{zh-CN}, group, api:{type, baseUrl}, candidateModelIds:[], logoKey, seeded? }`。**不做** ZCode 那套远端同步 / LKG / 84 条正则能力规则。
- **D8 密钥存储名从产品里彻底移除。** `addProvider` 删除必填校验与表单字段；服务端在 `api_key_env` 为空时**按供应商编号生成**。编号来源是现成的 `model-provider-store.mjs:18` 的 `newProviderId()`，其值形如 `pv_<16 hex>`，天然满足 `providers-routes.mjs:14` 的 `^[A-Za-z_][A-Za-z0-9_]*$`。**故直接取 `api_key_env = provider.id`**，不新增命名规则。
  - **硬顺序**：生成点必须先落地，前端字段后删。反向或同时拆两个提交，会让用户粘的密钥**永远存不进去**（`providers-routes.mjs:97-100` 的 400）。
  - **变更面必须含 `src/core/http/providers-routes.mjs`**（此前草稿只把它列在体积表里）。
  - **既有空 env 供应商的迁移规则**：读路径（`buildModelProfile` 查 secrets）对空 env 视为未配置密钥，不做回填；写路径（下次 PATCH）自然补上生成的编号。
  - **连带删除**：`invalid_api_key_env` 400 路径、`keyStatusText` 的 ENV 变体、详情页「使用环境变量名」勾选框。**明示代价**：自定义供应商失去「指向系统已有环境变量」的能力；目录厂商不受影响（其记录自带 env 名）。此代价登记在「本轮可见变化」。
- **D9 目录厂商的连接字段锁定只读。** 选中目录内厂商时，Base URL 与协议渲染为带锁的只读行，只有密钥可编辑；要改走「中转站 / 自建服务」路径。
  - **图标资产**：`icons.js` 现 19 条路径，**无 `lock`**。本轮需新增 `lock` 一条（同规格：24 viewBox、stroke 1.7、round）。这是 D9 的隐含依赖，必须登记。
- **D10 模型只能经「添加」入列，且必须能手填 ID。**
  - 删除 `addModel` 的 `model_name: "new-model"` 占位写法。
  - 「添加模型」给出两个来源：**从目录候选里挑**（可搜索，不铺开）与**手填模型 ID**。
  - 「拉取模型」保留但降为次级入口（ZCode 不做端点发现；该能力对中转站有价值，删除属另一决策）。
  - **验收**：新建连接的厂商，模型列表为**空态**；空态只给一个动作（添加模型），不写解释段落。
- **D11 草稿不丢，落点明确。** 把「添加供应商」表单纳入 `isDirty()`；弹窗内未提交内容在**内存**中存活。草稿对象由 `model-settings-page.js` 持有（模块级 `let draft`），键为 `(providerId | "new")`，在 `renderDetail`（`:593-598`）重建时**读取并回填**，而不是重置。切换分区回来仍在；切换供应商时**保留各自草稿**。密钥字段**不落 localStorage**（明文密钥进浏览器存储是安全问题）。关闭前明确告知将丢失什么。**不做** localStorage 草稿持久化。
- **D12 脏确认文案与按钮按分区生成。** 模型分区的确切字符串（依审美立场第 5 条，只保留「不写就会做错」的信息）：
  - 标题：「关闭设置？」
  - 正文：「模型设置里未提交的内容会丢失。」
  - 按钮：「继续编辑」/「关闭」
  - 写作参数分区沿用既有「保存 / 不保存」语义。两分区不得共用一套写死文案。

### C. 排版与视觉

- **D13 模型分区改「列表 + 面板」两栏，并删除死规则。**
  - 删除 `styles.css:1305-1307`（其动机对应的检查点位于已自述失效的 `capture-visual-acceptance.cjs:2489-2491`；窄屏兜底已在 `styles.css:1461-1462`）。
  - **分区内部形态**（取代此前草稿的「恢复 280px 供应商栏」）：设置为分区导航之后，模型分区自身是「厂商列表 + 连接面板」两栏。**最小宽度**：列表 ≥ 300px、面板 ≥ 340px；不足时按 `styles.css:1461-1462` 的既有断点降为单栏。
    - **锚点订正与实宽核算（记录于 2026-09-26｜依据：实读 `styles.css:1036`、原型在 1440 视口实测）**：分区导航是 **256px**（`grid-template-columns: 256px minmax(0,1fr)`），此前稿记 212px 系笔误。弹窗 1000 − 导航 256 − 分区内边距 36 = 708px，再减滚动条预留 8px 得 700px；取 300 + 20 + 380，**面板实得 378.7px ≥ 340 ✓**。**视口不足 1180px 降单栏**（实测 1000px 视口单栏成立、零横向溢出）。
    - **两条由实宽反推的形态结论（执行期直接照做，不必再试错）**：① **协议不做三列并排**——三列时每列可用 112px，而 `/v1/chat/completions` 需 132px，实测被截断，且「Anthropic Messages」换行；改**按行排**（单选钮 + 名字 + 端点），每行 36px，不换行不截断。② **左列供应商列表不做灰底卡片**（只有几行却配满高卡片，会变成一整块空灰）；模型区灰底**撑满面板剩余高度、空态在区内居中**，让空态读作「留给模型的位置」而不是「缺口」。
- **D14 字阶与间距单一 owner。** 不新增像素字级、不写 inline `font-size`。**现存违例清理**：`dom-kit.js:194` 的 inline `fontSize:"13px"`。间距沿用 4px 基数（4 / 8 / 12 / 16 / 20-24）。新增样式以**改值 / 删重复**为主，不新增规则块。
- **D15 逐条修五类线条与尺寸缺陷**：composer 与正文列右缘对齐（含 `scrollbar-gutter` 的单向补偿）；树连接线对齐到折叠箭头中心；选中竖条与状态点不再重叠；`.field-error` 并入既有 `.spd-field-error`（注意：`field-error` → `spd-field-error` 是 4×「spd-」= **+16 字节**，不是节省，此前草稿记错）；**供应商名输入框改用 `.dfield`**（`styles.css:940-944` 的 `width:100%`），纳入几何验收。
  - **追加（记录于 2026-09-26｜依据：原型实测有无滚动条差 8px）**：模型分区的详情列同样要 `scrollbar-gutter: stable` 并配等宽补偿——否则「列表内容长一截/短一截」会让两栏列宽来回跳 8px，属本次要修的对齐失败类。

### D. 门禁与就绪契约

- **D16 就绪信号唯一且语义明确。** 在 `<html>` 上落 `data-app-state`，取值 `ready` / `error`；`ready` 仅在 `loadAll()` **resolve 之后**置位，`loadAll()` 抛错时置 `error`（**不得**让「就绪」永不置位，否则各 harness 只能靠超时失败）。**移除** `app.js:1014` 在 `await` 之前置位的 `__wwritingMotionReady`，或明确保留它**只表示动效**、不得作为数据就绪使用（二选一，取前者，避免第二个信号被误读）。
  - **5 处消费者必须一起改**：`capture-visual-acceptance.cjs:1356` / `:2338` / `:2376`、`capture-all-ui.cjs:805`、`verify-app-clickability.cjs:159`。
- **D17 修 clickability 的唯一坏守卫并补一条行为断言。** `:164` 改为等真正的项目行（与该文件其余 12 处写法一致）；补「点完加号后侧边栏出现会话行」断言（该不变量正是 A 链漏网的原因）。**不**再给 `MockElement` 补方法。
  - **前置依赖**：D16 → D17；D1 + D3 → D17（断言的对象要先存在）。
- **D18 修剪而非重写样式断言。** **保留清单**（这些编码真行为，站得住）：对比度 ≥4.5:1 类（`text-style-contract` 的对比度用例）、禁 raw hex、token 三层结构、`ui-layout.test.mjs:176-200` 的「无横向溢出 / 长内容换行」类（`overflow-wrap` 与被截断输入框属**同一失败类别**，必须保留）。
  - **删除范围**：断言具体像素 / 圆角 / 边框存在的那一批（`codex-visual-contract` 的「提供 `--r-lg` 12px」「顶栏发丝下边框」「运行区无横杠」等）。
  - **顺序**：C 链视觉改动**先于** D18（否则删完之后无法判断哪些断言是「因视觉重做而失效」、哪些是「真回归」）。
  - 按 `AGENTS.md`「删除测试前确认失败场景仍有覆盖」：逐条落表，说明删掉的断言原本锁什么、该场景由谁接管。
- **D19 删除 `verify-app-shell.mjs`（记录于：2026-09-26｜状态：当前有效｜依据：用户本轮明确选择删除）**：删除前把它独有的可观察失败场景逐条交给现有行为测试或真实 Electron 检查；移除脚本、npm 命令及活跃文档中的运行指令，不改写历史轮次记录。

### E. 借鉴边界

- **D20 只借鉴设计，不移植代码。** 用 WWriting 的词汇与写法实现（`CONTEXT.md` 的供应商 / 模型 / 项目根 / 普通文件夹 / 会话）。**不搬运**任何 ZCode 文件，因此不产生 Apache-2.0 归属义务。若执行期某文件最终落成接近逐字的移植，必须在该文件与本仓 `LICENSE` / `NOTICE` 补归属声明，**不得抹除归属**。
- **D21 明确不抄清单**：ZCode 的产品名 / 版本 / UI 文案 / i18n 键 / 品牌写法 / agent 自述身份串；`packages/provider` + `provider-node` + 5,141 行 `model-provider` 的实现；Vercel AI SDK 与 `@ai-sdk/*` 补丁（WWriting 运行时依赖只允许 marked / yaml / yauzl）；目录远端同步与 LKG 机制；84 条正则能力体系；**其把 API key 明文写进 provider 配置文件的做法**；其「headers 不暴露到 UI」的限制（不复制该缺陷，也不新增该功能）。
- **D23 厂商 logo 必须内置（硬要求，不得拖延或无视）。**
  - **图标源实测结果（订正，记录于 2026-09-26｜依据：逐 slug 实跑 HTTP 状态码）**：Simple Icons（CC0 图标，商标权仍归各家）实测可取 **9** 家：`anthropic` / `deepseek` / `moonshotai` / `minimax` / `alibabacloud` / `qwen` / `openrouter` / `baidu` / **`xiaomi`**（此前稿漏记 `xiaomi`；404 的是 `xiaomi-mimo`，故**小米 MiMo 有真实 logo**）；**缺 4 个 slug：`openai`、`xai`、`zhipu`、`zai`（均 404，OpenAI 为商标政策下架）**，即**3 个品牌**（OpenAI / xAI / 智谱，其中 zhipu 与 zai 同品牌）。
  - 因此**不能只靠一个图标源**：缺口三家用官方品牌 / press kit 资产补，并统一登记来源与授权口径。
  - **降级规则**：无 logo 的厂商用首字母中性标（与图标同规格圆角方块），**不得**留空、不得用通用机器人图标。**首字母取大写**（`xAI` → `X`）：小写 `x` 在小方块里会被读成关闭按钮。
  - **载体**：logo 以 SVG 路径内联进 `icons.js` 同级的独立表（不引网络请求、不引新依赖）。深浅色两态都要可读（单色 `currentColor`）。
  - **渲染口径**：厂商 logo 是**填充字形**，必须 `fill: currentColor; stroke: none`，**不得**走 `icon()` 那条描边渲染路径（该函数对每个路径强制 `fill:none; stroke-width:1.7`，会把 logo 画没）。
  - **原型已落地（记录于 2026-09-26｜依据：`docs/mockups/vendor-logos.js` 由脚本抓取生成、无手工转录，已随原型实机验证）**：7 家有真实字形（Anthropic / DeepSeek / Kimi / MiniMax / 通义千问 / 小米 / OpenRouter），OpenAI / xAI / 智谱按上述降级规则走首字标——**这是缺口演示，不是终态**，最终实现必须补齐这三家的官方资产。生成脚本可复用：`for s in <slug…>; do curl -sS "https://cdn.simpleicons.org/$s" | 提取 path d; done`。

## 变更面（含体积预算与必须的先后顺序）

红线（`tests/architecture/dependency-rules.test.mjs` R1，零例外）：逻辑源码 ≤1200 行且 ≤51200 B（LF 归一）。实测余量：

| 文件 | 行 | LF 字节 | 字节余量 |
|---|---|---|---|
| `src/app-shell/model-settings-page.js` | 938 | 49921 | **1279** ← 最紧 |
| `src/app-shell/app.js` | 1020 | 48607 | 2593 |
| `src/app-shell/settings-modal.js` | 989 | 45427 | 5773 |
| `src/app-shell/session-sidebar.mjs` | 732 | 33930 | 17270 |
| `src/core/http/providers-routes.mjs` | 192 | 11597 | 39603 |

记录于：2026-09-26｜依据：`node -e` 按 `Buffer.byteLength(text.replace(/\r\n/g,"\n"),"utf8")` 与 LF 归一行数实算。

- **D22 拆点定死，不留到「越线再说」。** 因为 R1 是**机器强制零例外**，而中间提交也必须绿，所以「实测越线才拆」与验收条件相冲。
  - **决定**：`model-settings-page.js` 本轮**必须先拆后改**。拆除对象：**模型行渲染**（`renderModelRows` 及其私有件）下沉为 `src/app-shell/model-rows.mjs`；**删除量**：从原文件移出该函数体与仅它使用的辅助函数，原文件同轮内不得反弹（移出后原文件余量应回到 ≥3 KB）。
  - **调用边界**：新模块只被 `model-settings-page.js` 一处调用（单一调用链）。按 `AGENTS.md`「先删后拆」要求 ≥2 独立调用方或独立状态边界，**本拆点以「字节红线强制」为例外理由登记**，不宣称它满足一般拆分标准。
  - `styles.css` 与 `agent/agent.css` 以改值 / 删重复为主，不新增规则块。

**硬顺序约束（拆提交时必须遵守，反向即产生坏中间态）：**

1. **D8 生成点先落地，前端字段后删。** 否则密钥写不进去。
2. **D5 适配器与全部 allow-list 站点同轮落地**，不得先删 allow-list、后写适配器（中途所有非 OpenAI 厂商存盘即被丢弃）。
3. **D16 先于 D17。**
4. **D1 + D3 先于 D17 的新断言**（断言对象要先存在）。
5. **C 链视觉改动先于 D18 修剪**。
6. **D22 拆点先于 B 链对 `model-settings-page.js` 的改动。**

## 必须同步更新的既有测试

按 `AGENTS.md`「测试只锁行为」与「删除测试前确认失败场景仍有覆盖」。以下测试锁的是**被本轮改变的契约**，须逐条改写（改写而非删除，除注明者）：

| 测试 | 锁的旧契约 | 处置 |
|---|---|---|
| `tests/http/providers-routes.test.mjs:233-255` | `invalid_api_key_env` 两条 400 路径 | 改写为「空 env 时服务端自动生成编号且密钥落盘成功」 |
| `tests/core/model-config-validation.test.mjs:153` | 文案「本轮仅支持 OpenAI…」 | 改写为三协议均可通过校验 |
| `tests/app-shell/model-settings-page.test.mjs:370` | 必须渲染「使用环境变量名」开关 | **删除**，改断言「不存在该控件」 |
| 同上 `:838-850` | `addProvider` 需要 env | 改写为「三字段即可创建」 |
| 同上 `:845-850` | POST body 含 `api_key_env` | 改写为 body 不含该字段 |
| `tests/core/model-provider-store.test.mjs` | store 的 allow-list | 改写为三协议均可入 store |

**新增行为断言（只加这一条，不新增测试文件）**：`verify-app-clickability.cjs` 的「点加号后侧边栏出现会话行」。

## 本轮可见变化（需用户确认）

`AGENTS.md` 与欠账 21-2 先例要求可见行为变化单列。以下逐条列出前 / 后差异与代价：

| # | 变化 | 前 | 后 | 代价 |
|---|---|---|---|---|
| 1 | 顶栏项目标题 | 普通文件夹显示「开始创作」 | 显示文件夹名 | 需后端补 `name` 字段（D1） |
| 2 | 会话列表活跃高亮 | 可同时高亮两个项目的会话 | 全局唯一 | 无 |
| 3 | 点「+」 | 无任何可见变化 | 出现「新对话」草稿行 | 无 |
| 4 | 模型设置布局 | 单列堆叠 | 列表 + 面板两栏 | 窄屏降单栏（D13） |
| 5 | 厂商建立方式 | 手搓内联表单 | 目录挑选为默认路径 | 目录数据须维护（D7） |
| 6 | 密钥存储名 | 必填字段 | **整个概念消失** | 自定义供应商失去「指向系统环境变量」能力（D8） |
| 7 | 接口协议 | 三项 disabled | 三项可选 | 协议适配器为主路径新增（D5） |
| 8 | 模型入列方式 | 目录内置模型直接列出 | 仅用户添加的入列 | 新建连接后模型列表为**空态**（D7/D10） |
| 9 | 「拉取模型」 | 主按钮 | 次级入口 | 无 |
| 10 | 模型分区脏确认文案 | 「写作参数…不保存并关闭」 | 模型分区专属文案与按钮 | 无 |

## 验收

- **门禁口径**：`npm test` + `verify:unified-agent` + `verify:desktop-shell` + `verify:app-clickability` 四条**全绿**为准；D19 已裁定删除旧 `verify:app-shell`，执行前按该项完成覆盖交接。
- **A 链行为验收**（可证伪）：普通文件夹点「+」，500ms 内出现 `.session-draft` 行；发一条消息后该行被真实会话行替换，侧边栏可见该会话；顶栏显示文件夹名而非「开始创作」。开两个项目并切换，全文只有**一个** `.session-row.active`。
- **B 链行为验收**（可证伪）：只填名称 + Base URL + 密钥即可创建成功（无 env 名输入）；`~/.wwriting/secrets.json` 出现该密钥且 `api_key_saved: true`；三协议均可保存并通过连接测试；点「添加模型」出现模型 ID 输入与目录候选选择器，**不出现** `new-model` 占位行；新建连接的模型列表为空态；表单填内容后关闭，要么有确认、要么内容仍在。
- **C 链几何验收**（数值化）：composer 右缘与 `.agent-messages` 右缘差 **0px**；树连接线 x 落在折叠箭头中心 ±1px；选中竖条与状态点**无重叠**；供应商名输入框宽度等于其列宽。
- **审美验收**：以「审美立场」六条为判据逐屏人工判定，并附**剔除文案清单**（哪些字符串因「不写也不会做错」被删）。视觉采集用 `capture-all-ui.cjs` 重采截图，**不以断言代理观感**。
- **原型基线（记录于 2026-09-26｜依据：`docs/mockups/round22-model-config-preview.html` + `docs/mockups/vendor-logos.js`，浏览器逐状态实跑）**：原型已落地并验证通过——三协议按行排（无截断）、空态只有「添加模型」、产品界面里不存在「密钥存储名 / 环境变量」字样、锁定行带锁、401 行内错误、拉取在途转圈、关闭确认用 D12 文案、1180px 以下降单栏且零横向溢出、高亮唯一。**14 条「不写也不会做错」的字符串剔除清单**写在原型页面下方的注解区，执行期照单清理。原型是**形态与文案的基线**，不是要移植的代码（D20）。
  - 原型自身的几何取自产品真实值：弹窗 1000×760、导航 256px、滚动条 8px、控件 36/32px；所有图标路径逐条可溯源到 `icons.js` 或 `index.html` 内联（唯一例外 `lock` 已登记为待新增），厂商字形由脚本从 Simple Icons 抓取生成。
- **明确不做**：新增任何锁样式值或锁像素的断言；为视觉改动新增测试文件；搬运 ZCode 代码。

## 本轮不做（登记）

- ZCode 目录的远端同步 / LKG 发布机制；其 5 组 84 条能力正则体系；`api.headers` 暴露到 UI。
- 路径归一的显示面部分（欠账 21-2 剩余项）、大小写折叠口径（21-1）、受保护路径规则侧 realpath（21-8）。
- localStorage 草稿持久化（D11 明确排除）。
- 端点模型发现（ZCode 不做；WWriting 保留既有「拉取模型」但降级）。
