# 视觉验收证据清单

- 轮次：round-04
- 采集时间：2026-08-07T05:14:22.438Z
- 采集脚本：scripts/capture-visual-acceptance.cjs
- 测试项目：D:\WWriting\.worktrees\agent-work-log-skills\.demo_runs\visual-acceptance-1786079662439\novel
- 覆盖视口：1280x800、768x900、390x844、1440x900
- parallel_runtime_supported: false（当前 Runtime 串行执行工具；未制造并行截图；只有 MANIFEST 为 true 且 audit 同时列出两个开放 activity_id 时，两工具文字同时动才允许）

## 非主观检查结果

| 检查 | 结果 |
|---|---|
| 图片宽高与视口一致 | PASS（全部 PNG） |
| 像素非全白/全透明 | PASS |
| 页面无横向 overflow | PASS |
| 关键 selector bounding box 不相交 | PASS |

逐文件检查明细：

| 文件 | 图片尺寸 | 像素非空白 | 无横向溢出 | bbox 不相交 | 场景客观检查 |
|---|---|---|---|---|---|
| 01-reasoning-running-1280x800-t000.png | 1280x800 | PASS | PASS | PASS | — |
| 01-reasoning-running-1280x800-t400.png | 1280x800 | PASS | PASS | PASS | — |
| 01-reasoning-running-1280x800-t900.png | 1280x800 | PASS | PASS | PASS | — |
| 02-tool-after-reasoning-1280x800-t000.png | 1280x800 | PASS | PASS | PASS | — |
| 02-tool-after-reasoning-1280x800-t400.png | 1280x800 | PASS | PASS | PASS | — |
| 02-tool-after-reasoning-1280x800-t900.png | 1280x800 | PASS | PASS | PASS | — |
| 03-plan-updated-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| 03b-plan-updated-2of3-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| 04-completed-collapsed-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| 05-reasoning-expanded-1280x800.png | 1280x800 | PASS | PASS | PASS | reasoning-detail-scroll=PASS |
| 06-settings-agent-skills-1280x800.png | 1280x800 | PASS | PASS | PASS | — |
| 07-chat-narrow-390x844.png | 390x844 | PASS | PASS | PASS | panel-button-single-line=PASS |
| 08-settings-medium-768x900.png | 768x900 | PASS | PASS | PASS | settings-footer-clearance=PASS |
| 09-chat-wide-1440x900.png | 1440x900 | PASS | PASS | PASS | — |
| 09b-chat-wide-markdown-1440x900.png | 1440x900 | PASS | PASS | PASS | markdown-table-scroll=PASS<br>task-list-states=PASS |
| 09c-chat-table-narrow-390x844.png | 390x844 | PASS | PASS | PASS | markdown-table-scroll=PASS<br>task-list-states=PASS |

场景客观检查说明：
- `reasoning-detail-scroll`（05）：展开的 reasoning 详情 `scrollHeight > clientHeight`，证明 320px 限高内层滚动区真实存在。
- `panel-button-single-line`（07）：390 窄屏顶栏「面板」按钮单行显示（`scrollHeight ≤ clientHeight` 且 `scrollWidth ≤ clientWidth`），不拆行。
- `settings-footer-clearance`（08）：768x900 设置技能列表滚到底后，最后一行与固定操作栏 `.spd-foot` bbox 不相交，且完整位于滚动视口内。
- `sweep-direction`（01/02，评审 P1-1）：三帧 PNG 中 label bbox 内的最暗列（扫光 ink 带）x 坐标严格递增（t000 < t400 < t900），机器证明扫光从左向右；相位由 Web Animations API pause+seek 固定（680/920/1160ms，1450ms 周期）。
- `markdown-table-scroll`（09b/09c，评审 P1-2）：Markdown 表格的横向滚动容器存在（`overflow-x: auto` + `display:block`，plan Step 5 方案）；单元格在 760px 正文列内换行、不撑破列。
- `task-list-states`（09b/09c，评审 P1-2）：任务列表同时渲染 checked 与未勾选 checkbox（[x]/[ ] 两态）。

评审补拍说明：09b-chat-wide-markdown-1440x900.png 与 09c-chat-table-narrow-390x844.png 为同场景追加带序号 PNG（计划 §Step 5 允许；不得省略需验收的文字角色，全部写入 MANIFEST）。

## 动效唯一性审计（live-indicator-audit.json）

| 场景 | openActivityIds | visibleAnimatedLabels | 动效数 | groupHeaderAnimated |
|---|---|---|---|---|
| reasoning-running | `["reasoning:eacf1894-203c-47d3-9ede-bddc66859bbb"]` | `["思考中"]` | 1 | false |
| tool-after-reasoning | `["tool:45ed7f95-5924-415f-963a-f4479e43689d"]` | `["正在调用 read_skill"]` | 1 | false |
| completed | `[]` | `[]` | 0 | false |

所有 sequential 场景捕获时动效文字均 ≤1，terminal 场景均 =0，展开工作组无 groupHeaderAnimated=true；任一违反采集脚本已退出 1。

## PNG 清单

| # | 文件 | 绝对路径 | viewport | 场景 | 期望文案 | 对应规格 | SHA-256 |
|---|---|---|---|---|---|---|---|
| 1 | `01-reasoning-running-1280x800-t000.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\01-reasoning-running-1280x800-t000.png` | 1280x800 | reasoning-running | 工作组展开；reasoning 运行态：label“思考中”+ 扫光带位于左侧 | Task 15 验收矩阵「流式 reasoning」+ Step 5 场景 01 | `f5be981f236e6076f53b013e7328c2ecf155faaeb1bc4f9492f37a1bd89b4266` |
| 2 | `01-reasoning-running-1280x800-t400.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\01-reasoning-running-1280x800-t400.png` | 1280x800 | reasoning-running | 扫光带位于中部；文字不位移，容器不跳动 | Task 15 Step 5 场景 01 / Step 7 验收第 6 条 | `07d6669ff8a584223a6fc9e0378c2667140c4a923a61a6930e6dfad83eaa48dd` |
| 3 | `01-reasoning-running-1280x800-t900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\01-reasoning-running-1280x800-t900.png` | 1280x800 | reasoning-running | 扫光带位于右侧；label“思考中”保持原位 | Task 15 Step 5 场景 01 / Step 7 验收第 6 条 | `01eaf66b16d5d1b2311cf8a41194e476dc7f0f7671d9abef88562496029882eb` |
| 4 | `02-tool-after-reasoning-1280x800-t000.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\02-tool-after-reasoning-1280x800-t000.png` | 1280x800 | tool-after-reasoning | reasoning 已完成（“已完成思考”，无动画）；工具运行态“正在调用 read_skill”+ 扫光带位于左侧，唯一动效 | Task 15 Step 5 场景 02 / Step 6 动效唯一性 | `a836bdfbd282851dac432d2d8b9a2c1e4a7174d65b66ead059c8bba8908b2ae6` |
| 5 | `02-tool-after-reasoning-1280x800-t400.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\02-tool-after-reasoning-1280x800-t400.png` | 1280x800 | tool-after-reasoning | 扫光带位于中部；reasoning 完成态不动 | Task 15 Step 7 验收第 6 条 | `2452889ccb52d3e462f3331e7aff37631379915dca01abb59c53e0df1446e41b` |
| 6 | `02-tool-after-reasoning-1280x800-t900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\02-tool-after-reasoning-1280x800-t900.png` | 1280x800 | tool-after-reasoning | 扫光带位于右侧；reasoning 完成态不动 | Task 15 Step 7 验收第 6 条 | `3ff61bb5103f93da53a2445da4c4409850ef3260c05ae6290495b106cb6b39ff` |
| 7 | `03-plan-updated-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\03-plan-updated-1280x800.png` | 1280x800 | plan-updated | 任务计划 1/3：一个 completed（绿色勾选 icon，regular）+ 一个 in_progress（加粗）+ 一个 pending（常规） | Task 15 Step 5 场景 03 / Step 7 验收第 9 条 | `6ab89ba29198c812ff093bd07e0882b72cece81f163ad1205b8d022601b163d0` |
| 8 | `03b-plan-updated-2of3-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\03b-plan-updated-2of3-1280x800.png` | 1280x800 | plan-updated-2of3 | 任务计划 2/3：两个 completed + 一个 pending（与测试冻结契约 2/3 一致） | Task 15 Step 5 场景 03（2/3 计数；三态对比见 03-plan-updated） | `e7ccc6b6c920a193a76cc3834bab5f26c69448171f0ae910be0c80b51051e386` |
| 9 | `04-completed-collapsed-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\04-completed-collapsed-1280x800.png` | 1280x800 | completed | 工作组完成态自动折叠：summary 显示“工作了 N 秒”，无任何扫光残留 | Task 15 Step 5 场景 04 / Step 6 终态 0 动效 | `a0135e65388d804db118242d082b3ec708e86629fdf7803f7158b60658bed66f` |
| 10 | `05-reasoning-expanded-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\05-reasoning-expanded-1280x800.png` | 1280x800 | reasoning-expanded | 已完成思考详情展开：完整推理文本，max-height 320px 限高与内层滚动区（内容溢出 320px） | Task 15 Step 5 场景 05 / Step 7 验收第 2 条 | `c7ab27474e66716f036c7e049a8c4d50101ee5e971ccc71f4ce890d2748dc49a` |
| 11 | `06-settings-agent-skills-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\06-settings-agent-skills-1280x800.png` | 1280x800 | settings-agent-skills | 设置页「Agent 技能」分区：全局/项目分段控件 + 技能列表；无启用开关、无卡片套卡片 | Task 15 Step 5 场景 06 / Step 7 验收第 5 条 | `8854d6700ff5400058602144542b1986d89a0292791a8e0fb2b63ad73208b4ce` |
| 12 | `07-chat-narrow-390x844.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\07-chat-narrow-390x844.png` | 390x844 | chat-narrow | 390x844 窄屏聊天：对话/工作组/正文不遮挡、不横向溢出、控件不碰撞；顶栏「面板」单行 | Task 15 Step 5 场景 07 / Step 7 验收第 4 条 | `13b750aa4343476614893310fe2968448edbe801718d43d3d080ab3514ae63f2` |
| 13 | `08-settings-medium-768x900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\08-settings-medium-768x900.png` | 768x900 | settings-medium | 768x900 设置页「Agent 技能」分区：布局完整、最后一行不遮挡/不溢出、与固定操作栏留有安全间距 | Task 15 Step 5 场景 08 / Step 7 验收第 4 条 | `7dae2347ac80a6c86513b4abe0126108eb2263b39fefa4ac76e80380b95f993e` |
| 14 | `09-chat-wide-1440x900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\09-chat-wide-1440x900.png` | 1440x900 | chat-wide | 1440x900 宽屏：H1-H6、正文、strong、链接、blockquote、inline code、fenced code 可见且排版完整 | Task 15 Step 5 场景 09 / Step 7 验收第 3、8 条 | `eadda90c7cd08b1912aba42657e0e2cc21d3cb1595f880f89382ac507f6e335d` |
| 15 | `09b-chat-wide-markdown-1440x900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\09b-chat-wide-markdown-1440x900.png` | 1440x900 | chat-wide-table | 1440x900：Markdown 任务列表（[x]/[ ]）与宽表格（超 760px 列，横向滚动容器） | Task 15 Step 5 场景 09（追加带序号 PNG）/ 验收矩阵「Markdown」 | `48918e5aa3ecb2013ae96a48a55ffe60d490b523f3fb99ab9ad7f42b53f2304a` |
| 16 | `09c-chat-table-narrow-390x844.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-04\09c-chat-table-narrow-390x844.png` | 390x844 | chat-table-narrow | 390x844 窄视口：宽 Markdown 表格横向滚动、任务列表不遮挡/不溢出 | Task 15 Step 5 场景 09（窄视口补拍）/ Step 7 验收第 4 条 | `4b3b2b42b837907846c393823ff53beb66d434d45ecc2e3d0ab35cf5ac86f866` |

## 场景内容契约说明

- 03-plan-updated-1280x800.png 显示三个计划状态（completed / in_progress / pending）以便比较字重与颜色；计划计数按冻结实现为 completed/total，三态时显示 `任务计划 1/3`。
- 03b-plan-updated-2of3-1280x800.png 为补充图（同场景追加带序号 PNG）：第二次 update_plan 后计划为 completed/completed/pending，计数 `任务计划 2/3`，与 tests/app-shell/agent-surface.test.mjs 的 2/3 冻结语义一致。
- 02-tool-after-reasoning 的慢工具为真实 read_skill（经注入的临时 root skills service，读真实的 SKILL.md，仅测试注入 5s 延迟）；read_file 无法被确定性延长，故运行态标签为“正在调用 read_skill”（Step 6 审计如实记录实际标签，不伪造“正在读取文件”）。
- 09-chat-wide-1440x900.png 覆盖 H1–H6、正文、strong、链接、blockquote、inline code、fenced code；若首屏放不下会自动追加 09b。

## 环境说明

- 无
