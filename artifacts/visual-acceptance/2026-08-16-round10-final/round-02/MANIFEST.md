# 视觉验收证据清单

- 采集时间：2026-08-16T08:57:36.259Z
- 采集脚本：scripts/capture-visual-acceptance.cjs（Task 13 改写）
- 主题：light（经 #theme-toggle 真实切换）
- 真实项目：D:\WWriting\.round10-wt\.demo_runs\visual-acceptance-1786870656260\novel
- 普通文件夹场景：D:\WWriting\.round10-wt\.demo_runs\visual-acceptance-1786870656260\普通文件夹（无 project.yaml；应用私有历史在 stateRoot）
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
| conversation-completed-390x844.png | 390x844 | PASS | PASS | PASS | narrow-topbar-title=PASS |
| conversation-completed-768x900.png | 768x900 | PASS | PASS | PASS | — |
| conversation-completed-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| conversation-completed-1440x900.png | 1440x900 | PASS | PASS | PASS | — |
| markdown-fixture-1280x800.png | 1280x800 | PASS | PASS | PASS | markdown-table-scroll=PASS<br>task-list-states=PASS |
| markdown-fixture-390x844.png | 390x844 | PASS | PASS | PASS | markdown-table-scroll=PASS<br>task-list-states=PASS |
| settings-builtin-styles-1280x800.png | 1280x800 | PASS | PASS | PASS | settings-builtin-visible=PASS |
| settings-builtin-styles-390x844.png | 390x844 | PASS | PASS | PASS | settings-builtin-visible=PASS |
| settings-style-detail-1280x800.png | 1280x800 | PASS | PASS | PASS | builtin-style-detail=PASS |
| drawer-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| version-panel-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| version-panel-confirm-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| memory-tab-1280x800.png | 1280x800 | PASS | PASS | PASS | memory-cards-ready=PASS |
| plan-panel-open-1280x800.png | 1280x800 | PASS | PASS | PASS | plan-dropdown-topmost=PASS |
| plan-panel-collapsed-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| plain-folder-first-message-1280x800.png | 1280x800 | PASS | PASS | PASS | plain-folder-first-message=PASS |

场景客观检查说明：
- `sweep-direction`（reasoning-running / tool-after-reasoning）：三帧 PNG 中 label bbox 内的字形列质心 x（浅色 = 列内最暗 <128，深色 = 列内最亮 >128）三帧互不相同且跨度 ≥2px，机器证明扫光带随相位移动；相位由 Web Animations API pause+seek 固定（680/920/1160ms 按实际动画周期等比换算）。Round10 起产品动画为 agent-label-shine（muted↔透明渐变，无旧版 ink 暗带），方向由关键帧决定，不预设左→右。
- `markdown-table-scroll`（markdown-fixture）：Markdown 表格由独立容器承载（`overflow-x: auto`），表格保持 760px 宽；390px 视口必须出现真实容器内溢出（页面级不溢出）。
- `task-list-states`（markdown-fixture）：任务列表同时渲染 checked 与未勾选 checkbox（[x]/[ ] 两态）。
- `builtin-style-detail`（settings-style-detail）：只读详情正文非空，且无启用/删除/编辑控件。
- `plain-folder-first-message`（plain-folder-first-message）：标题非“读取失败”、无错误卡、用户/助手消息各 ≥1、Run 已完成、composer 可用；磁盘上文件夹根无 `project.yaml`、无 `.wwriting/agent`。

## 动效唯一性审计（live-indicator-audit.json）

| 文件 | 场景 | 状态 | openActivityIds | 动效文字 | 动效数 | groupHeaderAnimated |
|---|---|---|---|---|---|---|
| `reasoning-running-t000-1280x800.png` | reasoning-running | reasoning 运行中（思考中 + 扫光带位于左侧） | `["reasoning:2c5276cb-efd3-4026-a8c6-affe6a1a8395"]` | `["思考中"]` | 1 | false |
| `reasoning-running-t400-1280x800.png` | reasoning-running | reasoning 运行中（扫光带位于中部） | `["reasoning:2c5276cb-efd3-4026-a8c6-affe6a1a8395"]` | `["思考中"]` | 1 | false |
| `reasoning-running-t900-1280x800.png` | reasoning-running | reasoning 运行中（扫光带位于右侧） | `["reasoning:2c5276cb-efd3-4026-a8c6-affe6a1a8395"]` | `["思考中"]` | 1 | false |
| `tool-after-reasoning-t000-1280x800.png` | tool-after-reasoning | reasoning 已完成；工具运行中（read_skill + 扫光带位于左侧） | `["tool:3273b876-bbf9-447b-bd24-b9df84782ccf"]` | `["正在调用 read_skill"]` | 1 | false |
| `tool-after-reasoning-t400-1280x800.png` | tool-after-reasoning | reasoning 已完成；工具运行中（扫光带位于中部） | `["tool:3273b876-bbf9-447b-bd24-b9df84782ccf"]` | `["正在调用 read_skill"]` | 1 | false |
| `tool-after-reasoning-t900-1280x800.png` | tool-after-reasoning | reasoning 已完成；工具运行中（扫光带位于右侧） | `["tool:3273b876-bbf9-447b-bd24-b9df84782ccf"]` | `["正在调用 read_skill"]` | 1 | false |
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
| `version-panel-1280x800.png` | version-panel | 版本时间线展开（含恢复按钮） | `[]` | `[]` | 0 | false |
| `version-panel-confirm-1280x800.png` | version-panel-confirm | 恢复按钮确认态（确认恢复？） | `[]` | `[]` | 0 | false |
| `memory-tab-1280x800.png` | memory-tab | 抽屉记忆分区（摘要/日志/设定档案三块） | `[]` | `[]` | 0 | false |
| `plan-panel-open-1280x800.png` | plan-panel-open | 任务计划面板展开态 | `[]` | `[]` | 0 | false |
| `plan-panel-collapsed-1280x800.png` | plan-panel-collapsed | 任务计划面板收起态（仅 chip） | `[]` | `[]` | 0 | false |
| `plain-folder-first-message-1280x800.png` | plain-folder-first-message | 普通文件夹（无 project.yaml）打开并完成第一条消息 | `[]` | `[]` | 0 | false |

所有 sequential 场景（reasoning-running / tool-after-reasoning）捕获时动效文字均 ≤1，terminal 场景均 =0，展开工作组无 groupHeaderAnimated=true；任一违反采集脚本已退出 1。图片与 audit JSON 冲突时视觉验收判 FAIL。

## PNG 清单

| # | 文件 | viewport | 状态 | 数据来源 | parallel_runtime_supported | 开放 activity / 动效数 | 期望文案 | SHA-256 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `reasoning-running-t000-1280x800.png` | 1280x800 | reasoning 运行中（思考中 + 扫光带位于左侧） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["reasoning:2c5276cb-efd3-4026-a8c6-affe6a1a8395"]` / 1 个动效 | 工作组展开；reasoning 运行态：label“思考中”+ 扫光带位于左侧 | `4af2844f2c6d960c5b521227d8155876f7119ca02900d53bc20369b04f33b089` |
| 2 | `reasoning-running-t400-1280x800.png` | 1280x800 | reasoning 运行中（扫光带位于中部） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["reasoning:2c5276cb-efd3-4026-a8c6-affe6a1a8395"]` / 1 个动效 | 扫光带位于中部；文字不位移，容器不跳动 | `53103d416aee7abcfca2135542850e4b1eb073a3ba5d08a12d9024e229a170d6` |
| 3 | `reasoning-running-t900-1280x800.png` | 1280x800 | reasoning 运行中（扫光带位于右侧） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["reasoning:2c5276cb-efd3-4026-a8c6-affe6a1a8395"]` / 1 个动效 | 扫光带位于右侧；label“思考中”保持原位 | `0837ec509e201fed5cf1156265e75d3353e9c42c639b7f97b6bfef73f4dc56d3` |
| 4 | `tool-after-reasoning-t000-1280x800.png` | 1280x800 | reasoning 已完成；工具运行中（read_skill + 扫光带位于左侧） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["tool:3273b876-bbf9-447b-bd24-b9df84782ccf"]` / 1 个动效 | reasoning 已完成（“已完成思考”，无动画）；工具运行态“正在调用 read_skill”+ 扫光带位于左侧，唯一动效 | `74240196492532e4861d305f11c09e557198efce6a4b168895578a4c9042bc0c` |
| 5 | `tool-after-reasoning-t400-1280x800.png` | 1280x800 | reasoning 已完成；工具运行中（扫光带位于中部） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["tool:3273b876-bbf9-447b-bd24-b9df84782ccf"]` / 1 个动效 | 扫光带位于中部；reasoning 完成态不动 | `34bdac6e77978bc0eb1f6d1eedb13cdd6c355c10190ff5c84fae4c99c854a970` |
| 6 | `tool-after-reasoning-t900-1280x800.png` | 1280x800 | reasoning 已完成；工具运行中（扫光带位于右侧） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `["tool:3273b876-bbf9-447b-bd24-b9df84782ccf"]` / 1 个动效 | 扫光带位于右侧；reasoning 完成态不动 | `a24c6526ee522c64bdae34cac827cd0eed83038619c556f0c5e2bae31022560e` |
| 7 | `conversation-completed-390x844.png` | 390x844 | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 390x844 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息 | `28a468c5bc6495ab05ac5f75a68519931e659ad94c5516286ddb045ec68eb15c` |
| 8 | `conversation-completed-768x900.png` | 768x900 | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 768x900 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息 | `b1ac8380faaff1da164bed6a7113d453972631b25e1fa891ddc22d18e9016e08` |
| 9 | `conversation-completed-1280x800.png` | 1280x800 | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 1280x800 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息 | `14f6ca4ccf2ab6429d48bcfa4eca3db2235310b3dbc7a4697037e1ed8a417e89` |
| 10 | `conversation-completed-1440x900.png` | 1440x900 | 会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 1440x900 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息 | `2f7883c7bb428fab61cddbf4652e844c77f8ad070d49077196265dc747b7acf1` |
| 11 | `markdown-fixture-1280x800.png` | 1280x800 | Markdown 渲染完成态（H1-H6/正文/链接/引用/代码/表格/任务列表） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 1280x800：Markdown 全部角色排版完整，表格在容器内滚动、页面级不溢出 | `8c0065daa0616122e4f034955914326faefdc3c9380d6f140817c00d9ea979aa` |
| 12 | `markdown-fixture-390x844.png` | 390x844 | Markdown 渲染完成态（窄视口表格容器内滚动） | testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染 | false | `[]` / 0 个动效 | 390x844 窄视口：宽 Markdown 表格容器内横向滚动、任务列表不遮挡/不溢出、页面级无横向溢出 | `570403fb7644cab9cf556bbaca82af9c5f935ea30bf6f7d7ba4003d1e27f2228` |
| 13 | `settings-builtin-styles-1280x800.png` | 1280x800 | 设置页 Agent 技能分区：内置写作风格只读行（无启用/删除/编辑控件） | 真实 UI 点击打开设置 + 真实 /api/skills/catalog | false | `[]` / 0 个动效 | 设置页「Agent 技能」分区：内置写作风格分区展示三个只读行，无卡片套卡片、无启用开关 | `05f879db2f6c3671aa6b7738c907f1d55bed160bb69f6f9cc9e9b0f55253857b` |
| 14 | `settings-builtin-styles-390x844.png` | 390x844 | 设置页 Agent 技能分区（390x844 窄视口） | 真实 UI 点击打开设置 + 真实 /api/skills/catalog | false | `[]` / 0 个动效 | 390x844 窄视口设置技能分区：布局完整、无横向溢出、无遮挡 | `3bd293a84f410654168b3612b0027c637adc8ad9b2c1832eb9f1ca9a22cd126c` |
| 15 | `settings-style-detail-1280x800.png` | 1280x800 | 内置风格只读详情（完整正文，可滚动，无编辑/删除/启用控件） | 真实 UI 点击内置风格行 + 真实 /api/skills/:name 只读详情 | false | `[]` / 0 个动效 | 内置写作风格详情：完整 SKILL.md 正文经 agent-markdown 渲染，无启用/删除/编辑控件 | `a8db2cd973470f6fab3683563cea4bca902a66ad29e3f817597d5849e37c8933` |
| 16 | `drawer-1280x800.png` | 1280x800 | 顶部面板按钮打开的 drawer（章节分区 + 导出工具栏） | 真实 UI 点击顶部面板按钮（章节分区） | false | `[]` / 0 个动效 | drawer 章节分区：章节目录、导出成书工具条；顶部入口可点击、分区导航正常 | `03b9d4095227e40b7b0cd66a28eadb901643d5858d4be40ac153a7764d1ee89c` |
| 17 | `version-panel-1280x800.png` | 1280x800 | 版本时间线展开（含恢复按钮） | 真实 UI 点击抽屉章节行历史按钮 + version-panel 组件（暂无历史版本或含版本列表） | false | `[]` / 0 个动效 | 版本行显示 vN/时间/来源，无校验和；恢复按钮行内二次确认；fixture 无版本时显示「暂无历史版本」 | `17ae42d1587bd20b98d4d3b5c7afec3d0b77a89efdb5bc30fba1749ea823e9af` |
| 18 | `version-panel-confirm-1280x800.png` | 1280x800 | 恢复按钮确认态（确认恢复？） | 真实 UI 点击抽屉章节行历史按钮 + version-panel 组件（暂无历史版本或含版本列表） | false | `[]` / 0 个动效 | 行内二次确认，不弹窗 | `9a8f63093e372dcc2df719b6759fe055ba183045671ffd38b8d88413ac08859f` |
| 19 | `memory-tab-1280x800.png` | 1280x800 | 抽屉记忆分区（摘要/日志/设定档案三块） | 真实 UI 点击抽屉记忆分区 tab（data-dtab=memory） | false | `[]` / 0 个动效 | 三块卡片：故事摘要、工作日志（各带历史按钮）、设定档案只读 | `e438adb029331c9498a29c06d1a0bed63a1bbffc66da1d793aac34a4658ad07d` |
| 20 | `plan-panel-open-1280x800.png` | 1280x800 | 任务计划面板展开态 | 真实 UI 点击顶栏任务计划 chip + plan-panel 组件展开/收起 | false | `[]` / 0 个动效 | chip 进度 N/M + 条目状态图标/删除线/进行中高亮 | `6e99fc65de8cefd5ff8b4bfdb82577c17ded6a4672d7d02ec9fb6e3a65195656` |
| 21 | `plan-panel-collapsed-1280x800.png` | 1280x800 | 任务计划面板收起态（仅 chip） | 真实 UI 点击顶栏任务计划 chip + plan-panel 组件展开/收起 | false | `[]` / 0 个动效 | 仅顶栏 chip，无遮挡 | `cca93111a00d147303d2ab81008e2a8dbda599fdd512c3491ff06275d2ab1638` |
| 22 | `plain-folder-first-message-1280x800.png` | 1280x800 | 普通文件夹（无 project.yaml）打开并完成第一条消息 | 真实 /api/projects/open 普通文件夹 + 真实 UI 打开流程 + composer 发送第一条消息 | false | `[]` / 0 个动效 | 普通文件夹打开后可直接聊天：第一条“你好”已交换、无读取失败、无错误卡、composer 可用 | `1c9b7681a3d7873799c3a4228681b11967049ab2d3fb7a5e419ef1bb53f75c44` |

## 场景内容契约说明

- reasoning-running / tool-after-reasoning 的慢工具为真实 read_skill（经注入的临时 root skills service，读真实的 SKILL.md，仅测试注入 5s 延迟）；运行态标签如实记录，不伪造“正在读取文件”。
- conversation-completed 在四个视口分别采集同一完成会话：用户消息、自动折叠工作组（工作了 N 秒）、最终正文与 composer，验证无横向溢出、无遮挡。
- settings-builtin-styles / settings-style-detail 覆盖设置页「Agent 技能」分区：三个内置写作风格只读行（均衡/快节奏易读/心理文学），点击行展开只读详情（完整 SKILL.md 正文，无启用开关、无编辑/删除控件、无卡片套卡片）。
- drawer 覆盖顶部「面板」按钮打开的章节分区（含导出成书工具条）；右侧常驻竖轨已删除，入口收敛到顶部按钮。
- plain-folder-first-message 覆盖普通文件夹（仅 notes.txt，无 project.yaml）打开后第一条“你好”：真实 /api/projects/open + 真实 UI 打开流程 + composer 发送。
- version-panel 覆盖第九轮版本时间线面板：点击章节历史按钮打开版本面板（fixture 无版本时显示「暂无历史版本」），有版本时可点击恢复按钮触发行内二次确认（确认恢复？）。
- memory-tab 覆盖第九轮抽屉记忆分区：点击记忆 tab 展示三块卡片（故事摘要、工作日志、设定档案）。
- plan-panel 覆盖第九轮任务计划面板：顶栏 chip 展示进度（任务计划 N/M ▾），点击展开条目列表，再次点击收起；fixture 无 plan 事件时 chip 隐藏。

## 环境说明

- fixture 预置第 1 章已完成 + baseline v1 版本（版本时间线场景数据源）
- 主题：light（经 #theme-toggle 真实切换）
