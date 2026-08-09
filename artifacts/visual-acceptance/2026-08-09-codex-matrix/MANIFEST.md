# 视觉验收证据清单

- 采集时间：2026-08-09T06:42:45.556Z
- 采集脚本：scripts/capture-visual-acceptance.cjs（Task 13 改写）
- 主题：light（经 #theme-toggle 真实切换）
- 真实项目：D:\WWriting\.demo_runs\visual-acceptance-1786257765557\novel
- 普通文件夹场景：D:\WWriting\.demo_runs\visual-acceptance-1786257765557\普通文件夹（无 project.yaml；应用私有历史在 stateRoot）
- 覆盖视口：390x844、768x900、1280x800、1440x900（conversation-completed 四视口全覆盖）
- parallel_runtime_supported: false（当前 Runtime 串行执行工具；未制造并行截图。只有 MANIFEST 为 true 且 audit 同时列出两个开放 activity_id 时，两工具文字同时动才允许）

## 非主观检查结果

| 检查 | 结果 |
|---|---|
| 图片宽高与视口一致 | PASS（全部 PNG） |
| 像素非全白/全透明 | PASS |
| 页面无横向 overflow（四个视口） | PASS |
| 关键 selector bounding box 不相交 | PASS |

逐文件检查明细：

| 文件 | 图片尺寸 | 像素非空白 | 无横向溢出 | bbox 不相交 | 场景客观检查 |
|---|---|---|---|---|---|
| reasoning-running-t000-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| reasoning-running-t400-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| reasoning-running-t900-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| tool-after-reasoning-t000-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| tool-after-reasoning-t400-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| tool-after-reasoning-t900-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| conversation-completed-390x844.png | 390x844 | PASS | PASS | PASS | — |
| conversation-completed-768x900.png | 768x900 | PASS | PASS | PASS | — |
| conversation-completed-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| conversation-completed-1440x900.png | 1440x900 | PASS | PASS | PASS | — |
| markdown-fixture-1280x800.png | 1280x800 | PASS | PASS | PASS | markdown-table-scroll=PASS<br>task-list-states=PASS |
| markdown-fixture-390x844.png | 390x844 | PASS | PASS | PASS | markdown-table-scroll=PASS<br>task-list-states=PASS |
| settings-builtin-styles-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| settings-builtin-styles-390x844.png | 390x844 | PASS | PASS | PASS | — |
| settings-style-detail-1280x800.png | 1280x800 | PASS | PASS | PASS | builtin-style-detail=PASS |
| drawer-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| plain-folder-first-message-1280x800.png | 1280x800 | PASS | PASS | PASS | plain-folder-first-message=PASS |

场景客观检查说明：
- `sweep-direction`（reasoning-running / tool-after-reasoning）：三帧 PNG 中 label bbox 内的最暗列（扫光 ink 带）x 坐标严格递增（t000 < t400 < t900），机器证明扫光从左向右；相位由 Web Animations API pause+seek 固定（680/920/1160ms，1450ms 周期）。
- `markdown-table-scroll`（markdown-fixture）：Markdown 表格由独立容器承载（`overflow-x: auto`），表格保持 760px 宽；390px 视口必须出现真实容器内溢出（页面级不溢出）。
- `task-list-states`（markdown-fixture）：任务列表同时渲染 checked 与未勾选 checkbox（[x]/[ ] 两态）。
- `builtin-style-detail`（settings-style-detail）：只读详情正文非空，且无启用/删除/编辑控件。
- `plain-folder-first-message`（plain-folder-first-message）：标题非“读取失败”、无错误卡、用户/助手消息各 ≥1、Run 已完成、composer 可用；磁盘上文件夹根无 `project.yaml`、无 `.wwriting/agent`。

## 动效唯一性审计（live-indicator-audit.json）

| 文件 | 场景 | 状态 | openActivityIds | 动效文字 | 动效数 | groupHeaderAnimated |
|---|---|---|---|---|---|---|
| `reasoning-running-t000-1280x800.png` | reasoning-running | reasoning 运行中（思考中 + 扫光带位于左侧） | `["reasoning:d19a7b79-405b-4207-80f4-3f6632871629"]` | `["思考中"]` | 1 | false |
| `reasoning-running-t400-1280x800.png` | reasoning-running | reasoning 运行中（扫光带位于中部） | `["reasoning:d19a7b79-405b-4207-80f4-3f6632871629"]` | `["思考中"]` | 1 | false |
| `reasoning-running-t900-1280x800.png` | reasoning-running | reasoning 运行中（扫光带位于右侧） | `["reasoning:d19a7b79-405b-4207-80f4-3f6632871629"]` | `["思考中"]` | 1 | false |
| `tool-after-reasoning-t000-1280x800.png` | tool-after-reasoning | reasoning 已完成；工具运行中（read_skill + 扫光带位于左侧） | `["tool:57454a31-2593-44fa-abbf-871ad1fa5464"]` | `["正在调用 read_skill"]` | 1 | false |
| `tool-after-reasoning-t400-1280x800.png` | tool-after-reasoning | reasoning 已完成；工具运行中（扫光带位于中部） | `["tool:57454a31-2593-44fa-abbf-871ad1fa5464"]` | `["正在调用 read_skill"]` | 1 | false |
| `tool-after-reasoning-t900-1280x800.png` | tool-after-reasoning | reasoning 已完成；工具运行中（扫光带位于右侧） | `["tool:57454a31-2593-44fa-abbf-871ad1fa5464"]` | `["正在调用 read_skill"]` | 1 | false |
| `conversation-completed-390x844.png` | conversation-completed | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | `[]` | `[]` | 0 | false |
| `conversation-completed-768x900.png` | conversation-completed | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | `[]` | `[]` | 0 | false |
| `conversation-completed-1280x800.png` | conversation-completed | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | `[]` | `[]` | 0 | false |
| `conversation-completed-1440x900.png` | conversation-completed | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | `[]` | `[]` | 0 | false |
| `markdown-fixture-1280x800.png` | markdown-fixture | Markdown 渲染完成态（H1-H6/正文/链接/引用/代码/表格/任务列表） | `[]` | `[]` | 0 | false |
| `markdown-fixture-390x844.png` | markdown-fixture | Markdown 渲染完成态（窄视口表格容器内滚动） | `[]` | `[]` | 0 | false |
| `settings-builtin-styles-1280x800.png` | settings-builtin-styles | 设置页 Agent 技能分区：内置写作风格只读行（无启用/删除/编辑控件） | `[]` | `[]` | 0 | false |
| `settings-builtin-styles-390x844.png` | settings-builtin-styles | 设置页 Agent 技能分区（390x844 窄视口） | `[]` | `[]` | 0 | false |
| `settings-style-detail-1280x800.png` | settings-style-detail | 内置风格只读详情（完整正文，可滚动，无编辑/删除/启用控件） | `[]` | `[]` | 0 | false |
| `drawer-1280x800.png` | drawer | 顶部面板按钮打开的 drawer（章节分区 + 导出工具栏） | `[]` | `[]` | 0 | false |
| `plain-folder-first-message-1280x800.png` | plain-folder-first-message | 普通文件夹（无 project.yaml）打开并完成第一条消息 | `[]` | `[]` | 0 | false |

所有 sequential 场景（reasoning-running / tool-after-reasoning）捕获时动效文字均 ≤1，terminal 场景均 =0，展开工作组无 groupHeaderAnimated=true；任一违反采集脚本已退出 1。图片与 audit JSON 冲突时视觉验收判 FAIL。

## PNG 清单

| # | 文件 | viewport | 状态 | 数据来源 | parallel_runtime_supported | 开放 activity / 动效数 | 期望文案 | SHA-256 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `reasoning-running-t000-1280x800.png` | 1280x800 | reasoning 运行中（思考中 + 扫光带位于左侧） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["reasoning:d19a7b79-405b-4207-80f4-3f6632871629"]` / 1 个动效 | 工作组展开；reasoning 运行态：label“思考中”+ 扫光带位于左侧 | `b15df6ca930f5e2bea6b9ac66ad2cdf513b5972428e4b58b1fb5cd2f9dc5491c` |
| 2 | `reasoning-running-t400-1280x800.png` | 1280x800 | reasoning 运行中（扫光带位于中部） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["reasoning:d19a7b79-405b-4207-80f4-3f6632871629"]` / 1 个动效 | 扫光带位于中部；文字不位移，容器不跳动 | `0eb489423fbc16860be7ae35cd7fc4b35ef55782638d9b4dae77571e2fb63bf9` |
| 3 | `reasoning-running-t900-1280x800.png` | 1280x800 | reasoning 运行中（扫光带位于右侧） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["reasoning:d19a7b79-405b-4207-80f4-3f6632871629"]` / 1 个动效 | 扫光带位于右侧；label“思考中”保持原位 | `9bcb30b805fdf9f80a3f856e4c5a8a280f1bfceefa8f17f202bf8124d85dbb1b` |
| 4 | `tool-after-reasoning-t000-1280x800.png` | 1280x800 | reasoning 已完成；工具运行中（read_skill + 扫光带位于左侧） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["tool:57454a31-2593-44fa-abbf-871ad1fa5464"]` / 1 个动效 | reasoning 已完成（“已完成思考”，无动画）；工具运行态“正在调用 read_skill”+ 扫光带位于左侧，唯一动效 | `f859387852196ce1484724e8b1c21061857c70b70a5e650ab0da508f86515fb5` |
| 5 | `tool-after-reasoning-t400-1280x800.png` | 1280x800 | reasoning 已完成；工具运行中（扫光带位于中部） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["tool:57454a31-2593-44fa-abbf-871ad1fa5464"]` / 1 个动效 | 扫光带位于中部；reasoning 完成态不动 | `77c9d49adeb06cc25e9e8771847d632440c131333611caf3caec643df8dbbe22` |
| 6 | `tool-after-reasoning-t900-1280x800.png` | 1280x800 | reasoning 已完成；工具运行中（扫光带位于右侧） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["tool:57454a31-2593-44fa-abbf-871ad1fa5464"]` / 1 个动效 | 扫光带位于右侧；reasoning 完成态不动 | `64f9d51bb381e118b9e9bd44993a52d8e5e755653b87098ec0f972177c413e82` |
| 7 | `conversation-completed-390x844.png` | 390x844 | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 390x844 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息 | `4d60c60b839d2dba4659ab6794e8754467d4ec44986072102818678c299ee2db` |
| 8 | `conversation-completed-768x900.png` | 768x900 | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 768x900 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息 | `08dedcf8f03e7a1ccbaf1cdae128838ff04a24670907f350ab2e89a9349e24c5` |
| 9 | `conversation-completed-1280x800.png` | 1280x800 | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 1280x800 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息 | `1341a579ca73c3a5ab48789a7746cad2ccc7818a35685a930f49886f7a86ad8e` |
| 10 | `conversation-completed-1440x900.png` | 1440x900 | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 1440x900 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息 | `132b919084734dbe0bb9aad0990fa994236b5ec04dc454e04be203690abca928` |
| 11 | `markdown-fixture-1280x800.png` | 1280x800 | Markdown 渲染完成态（H1-H6/正文/链接/引用/代码/表格/任务列表） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 1280x800：Markdown 全部角色排版完整，表格在容器内滚动、页面级不溢出 | `8107245831d4c1cc23bc6ce9607fc3e5791c5082db474eb7a469a73542976424` |
| 12 | `markdown-fixture-390x844.png` | 390x844 | Markdown 渲染完成态（窄视口表格容器内滚动） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 390x844 窄视口：宽 Markdown 表格容器内横向滚动、任务列表不遮挡/不溢出、页面级无横向溢出 | `028fe446934a1666af488a9c8795ed03648723b19077210a019a720955909ee5` |
| 13 | `settings-builtin-styles-1280x800.png` | 1280x800 | 设置页 Agent 技能分区：内置写作风格只读行（无启用/删除/编辑控件） | 真实 UI 点击打开设置 + 真实 /api/skills/catalog | false | `[]` / 0 个动效 | 设置页「Agent 技能」分区：内置写作风格分区展示三个只读行，无卡片套卡片、无启用开关 | `ada2969976b24ae9d50404fdb0ab7d53b59c1030420c3747fa7a3290ed11df46` |
| 14 | `settings-builtin-styles-390x844.png` | 390x844 | 设置页 Agent 技能分区（390x844 窄视口） | 真实 UI 点击打开设置 + 真实 /api/skills/catalog | false | `[]` / 0 个动效 | 390x844 窄视口设置技能分区：布局完整、无横向溢出、无遮挡 | `755bfd4e21767c8c73de5abe2d27a053b36050c5558007862412e6ced514e735` |
| 15 | `settings-style-detail-1280x800.png` | 1280x800 | 内置风格只读详情（完整正文，可滚动，无编辑/删除/启用控件） | 真实 UI 点击内置风格行 + 真实 /api/skills/:name 只读详情 | false | `[]` / 0 个动效 | 内置写作风格详情：完整 SKILL.md 正文经 agent-markdown 渲染，无启用/删除/编辑控件 | `51ed3f683b71f6baa1b99a510399d64b9a271e87503191595d9d8438a23ee061` |
| 16 | `drawer-1280x800.png` | 1280x800 | 顶部面板按钮打开的 drawer（章节分区 + 导出工具栏） | 真实 UI 点击顶部面板按钮（章节分区） | false | `[]` / 0 个动效 | drawer 章节分区：章节目录、导出成书工具条；顶部入口可点击、分区导航正常 | `f9362afc155b9941584152fa8c9643cdfca29260a7af80d4b1e272636ef24d9d` |
| 17 | `plain-folder-first-message-1280x800.png` | 1280x800 | 普通文件夹（无 project.yaml）打开并完成第一条消息 | 真实 /api/projects/open 普通文件夹 + 真实 UI 打开流程 + composer 发送第一条消息 | false | `[]` / 0 个动效 | 普通文件夹打开后可直接聊天：第一条“你好”已交换、无读取失败、无错误卡、composer 可用 | `e727a1f79316ce4a8bba70478452920bc675d151599ff8d3fbd2f4e915a77f69` |

## 场景内容契约说明

- reasoning-running / tool-after-reasoning 的慢工具为真实 read_skill（经注入的临时 root skills service，读真实的 SKILL.md，仅测试注入 5s 延迟）；运行态标签如实记录，不伪造“正在读取文件”。
- conversation-completed 在四个视口分别采集同一完成会话：用户消息、自动折叠工作组（工作了 N 秒）、最终正文与 composer，验证无横向溢出、无遮挡。
- settings-builtin-styles / settings-style-detail 覆盖设置页「Agent 技能」分区：三个内置写作风格只读行（均衡/快节奏易读/心理文学），点击行展开只读详情（完整 SKILL.md 正文，无启用开关、无编辑/删除控件、无卡片套卡片）。
- drawer 覆盖顶部「面板」按钮打开的章节分区（含导出成书工具条）；右侧常驻竖轨已删除，入口收敛到顶部按钮。
- plain-folder-first-message 覆盖普通文件夹（仅 notes.txt，无 project.yaml）打开后第一条“你好”：真实 /api/projects/open + 真实 UI 打开流程 + composer 发送。

## 环境说明

- 主题：light（经 #theme-toggle 真实切换）
