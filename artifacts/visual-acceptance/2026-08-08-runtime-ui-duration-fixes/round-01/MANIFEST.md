# 视觉验收证据清单

- 采集时间：2026-08-07T18:16:41.393Z
- 采集脚本：scripts/capture-visual-acceptance.cjs（Task 13 改写）
- 真实项目：D:\WWriting\.demo_runs\visual-acceptance-1786126601393\novel
- 普通文件夹场景：D:\WWriting\.demo_runs\visual-acceptance-1786126601393\普通文件夹（无 project.yaml；应用私有历史在 stateRoot）
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
| `reasoning-running-t000-1280x800.png` | reasoning-running | reasoning 运行中（思考中 + 扫光带位于左侧） | `["reasoning:f30a3ed7-fd61-4c76-80b0-9f857a3bcd02"]` | `["思考中"]` | 1 | false |
| `reasoning-running-t400-1280x800.png` | reasoning-running | reasoning 运行中（扫光带位于中部） | `["reasoning:f30a3ed7-fd61-4c76-80b0-9f857a3bcd02"]` | `["思考中"]` | 1 | false |
| `reasoning-running-t900-1280x800.png` | reasoning-running | reasoning 运行中（扫光带位于右侧） | `["reasoning:f30a3ed7-fd61-4c76-80b0-9f857a3bcd02"]` | `["思考中"]` | 1 | false |
| `tool-after-reasoning-t000-1280x800.png` | tool-after-reasoning | reasoning 已完成；工具运行中（read_skill + 扫光带位于左侧） | `["tool:4b31aa10-8255-46bf-b66e-776aefdece46"]` | `["正在调用 read_skill"]` | 1 | false |
| `tool-after-reasoning-t400-1280x800.png` | tool-after-reasoning | reasoning 已完成；工具运行中（扫光带位于中部） | `["tool:4b31aa10-8255-46bf-b66e-776aefdece46"]` | `["正在调用 read_skill"]` | 1 | false |
| `tool-after-reasoning-t900-1280x800.png` | tool-after-reasoning | reasoning 已完成；工具运行中（扫光带位于右侧） | `["tool:4b31aa10-8255-46bf-b66e-776aefdece46"]` | `["正在调用 read_skill"]` | 1 | false |
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
| 1 | `reasoning-running-t000-1280x800.png` | 1280x800 | reasoning 运行中（思考中 + 扫光带位于左侧） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["reasoning:f30a3ed7-fd61-4c76-80b0-9f857a3bcd02"]` / 1 个动效 | 工作组展开；reasoning 运行态：label“思考中”+ 扫光带位于左侧 | `47553ff9a9dcc0051a7dc17f0a56b0b3810a0eb7953a96065251c7af8611a1df` |
| 2 | `reasoning-running-t400-1280x800.png` | 1280x800 | reasoning 运行中（扫光带位于中部） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["reasoning:f30a3ed7-fd61-4c76-80b0-9f857a3bcd02"]` / 1 个动效 | 扫光带位于中部；文字不位移，容器不跳动 | `92102cd50af2c83bb5653dd5872e549f81194f32118576d431eedb3a97f55e30` |
| 3 | `reasoning-running-t900-1280x800.png` | 1280x800 | reasoning 运行中（扫光带位于右侧） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["reasoning:f30a3ed7-fd61-4c76-80b0-9f857a3bcd02"]` / 1 个动效 | 扫光带位于右侧；label“思考中”保持原位 | `ce8642b575705751745b1b15e88753b9da21a5b8b499ed72816d8342dda5083e` |
| 4 | `tool-after-reasoning-t000-1280x800.png` | 1280x800 | reasoning 已完成；工具运行中（read_skill + 扫光带位于左侧） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["tool:4b31aa10-8255-46bf-b66e-776aefdece46"]` / 1 个动效 | reasoning 已完成（“已完成思考”，无动画）；工具运行态“正在调用 read_skill”+ 扫光带位于左侧，唯一动效 | `6e016df171cf0bdad5a5938c19da599c057d16362e9259b57c0a105ae7292744` |
| 5 | `tool-after-reasoning-t400-1280x800.png` | 1280x800 | reasoning 已完成；工具运行中（扫光带位于中部） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["tool:4b31aa10-8255-46bf-b66e-776aefdece46"]` / 1 个动效 | 扫光带位于中部；reasoning 完成态不动 | `c8aca0f0523675730122da1483a5399e21818c053f53321e6f16e8fa2f36792c` |
| 6 | `tool-after-reasoning-t900-1280x800.png` | 1280x800 | reasoning 已完成；工具运行中（扫光带位于右侧） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["tool:4b31aa10-8255-46bf-b66e-776aefdece46"]` / 1 个动效 | 扫光带位于右侧；reasoning 完成态不动 | `70f636a25ae0287b74e655cf96cb0b4620a5804ac13ee223a36786049be380c5` |
| 7 | `conversation-completed-390x844.png` | 390x844 | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 390x844 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息 | `b067a53f4791068c557fa6d2cd8fdd90c99295c8648a891e8bc341b2a2e61197` |
| 8 | `conversation-completed-768x900.png` | 768x900 | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 768x900 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息 | `39b24eb8c73a722b539f6683b28cb97a0963d38243be6b6657589b67546ba9db` |
| 9 | `conversation-completed-1280x800.png` | 1280x800 | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 1280x800 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息 | `f42dbc712602f42755ddd123520ee2895e54dd34acdaa2bc098ecd949adb46bf` |
| 10 | `conversation-completed-1440x900.png` | 1440x900 | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 1440x900 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息 | `76d5e755a07f2f35331d6c84e210e6845ddf90bdaac6fe49007b8eae1fe95086` |
| 11 | `markdown-fixture-1280x800.png` | 1280x800 | Markdown 渲染完成态（H1-H6/正文/链接/引用/代码/表格/任务列表） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 1280x800：Markdown 全部角色排版完整，表格在容器内滚动、页面级不溢出 | `36c815bcc195a97d41d2ff62528898f8deda576240b903441839f6e4ea808b69` |
| 12 | `markdown-fixture-390x844.png` | 390x844 | Markdown 渲染完成态（窄视口表格容器内滚动） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 390x844 窄视口：宽 Markdown 表格容器内横向滚动、任务列表不遮挡/不溢出、页面级无横向溢出 | `2a85dcb5219881884b2717fbe7cc08a1995de00c068c84b4bd7a18740b9bcf53` |
| 13 | `settings-builtin-styles-1280x800.png` | 1280x800 | 设置页 Agent 技能分区：内置写作风格只读行（无启用/删除/编辑控件） | 真实 UI 点击打开设置 + 真实 /api/skills/catalog | false | `[]` / 0 个动效 | 设置页「Agent 技能」分区：内置写作风格分区展示三个只读行，无卡片套卡片、无启用开关 | `65b2a9431f31af361cdba6b2bbedf2f2093119a4c65736cd5f31c910ae154f55` |
| 14 | `settings-builtin-styles-390x844.png` | 390x844 | 设置页 Agent 技能分区（390x844 窄视口） | 真实 UI 点击打开设置 + 真实 /api/skills/catalog | false | `[]` / 0 个动效 | 390x844 窄视口设置技能分区：布局完整、无横向溢出、无遮挡 | `9d5995cf8766a36c865b081ffbad97fa2c011894a655bfa0ac0ff8efcb69c68e` |
| 15 | `settings-style-detail-1280x800.png` | 1280x800 | 内置风格只读详情（完整正文，可滚动，无编辑/删除/启用控件） | 真实 UI 点击内置风格行 + 真实 /api/skills/:name 只读详情 | false | `[]` / 0 个动效 | 内置写作风格详情：完整 SKILL.md 正文经 agent-markdown 渲染，无启用/删除/编辑控件 | `f833c48c809fe78859c5e0e4c98d6c49f45c3dba0e0375a1bf9414f5106f4a2d` |
| 16 | `drawer-1280x800.png` | 1280x800 | 顶部面板按钮打开的 drawer（章节分区 + 导出工具栏） | 真实 UI 点击顶部面板按钮（章节分区） | false | `[]` / 0 个动效 | drawer 章节分区：章节目录、导出成书工具条；顶部入口可点击、分区导航正常 | `c3f41fe1941c0bbb8354ea47a92c12611df7ef783ee4eec531d9c4c3f630d83e` |
| 17 | `plain-folder-first-message-1280x800.png` | 1280x800 | 普通文件夹（无 project.yaml）打开并完成第一条消息 | 真实 /api/projects/open 普通文件夹 + 真实 UI 打开流程 + composer 发送第一条消息 | false | `[]` / 0 个动效 | 普通文件夹打开后可直接聊天：第一条“你好”已交换、无读取失败、无错误卡、composer 可用 | `e3edd2fe039360bf4cdefb72a4bb915c4b8482266e0162d652d0abd5ca9e5c15` |

## 场景内容契约说明

- reasoning-running / tool-after-reasoning 的慢工具为真实 read_skill（经注入的临时 root skills service，读真实的 SKILL.md，仅测试注入 5s 延迟）；运行态标签如实记录，不伪造“正在读取文件”。
- conversation-completed 在四个视口分别采集同一完成会话：用户消息、自动折叠工作组（工作了 N 秒）、最终正文与 composer，验证无横向溢出、无遮挡。
- settings-builtin-styles / settings-style-detail 覆盖设置页「Agent 技能」分区：三个内置写作风格只读行（均衡/快节奏易读/心理文学），点击行展开只读详情（完整 SKILL.md 正文，无启用开关、无编辑/删除控件、无卡片套卡片）。
- drawer 覆盖顶部「面板」按钮打开的章节分区（含导出成书工具条）；右侧常驻竖轨已删除，入口收敛到顶部按钮。
- plain-folder-first-message 覆盖普通文件夹（仅 notes.txt，无 project.yaml）打开后第一条“你好”：真实 /api/projects/open + 真实 UI 打开流程 + composer 发送。

## 环境说明

- 无
