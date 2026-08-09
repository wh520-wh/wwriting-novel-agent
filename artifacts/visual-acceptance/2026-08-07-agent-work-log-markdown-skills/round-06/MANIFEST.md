# 视觉验收证据清单

- 轮次：round-06
- 采集时间：2026-08-07T05:39:22.456Z
- 采集脚本：scripts/capture-visual-acceptance.cjs
- 测试项目：D:\WWriting\.worktrees\agent-work-log-skills\.demo_runs\visual-acceptance-1786081162457\novel
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
- `markdown-table-scroll`（09b/09c，评审 P1-2）：Markdown 表格由独立容器承载（`overflow-x: auto`），表格保持 760px 宽；390px 视口必须出现真实横向溢出，列不会压缩为逐字换行。
- `task-list-states`（09b/09c，评审 P1-2）：任务列表同时渲染 checked 与未勾选 checkbox（[x]/[ ] 两态）。

评审补拍说明：09b-chat-wide-markdown-1440x900.png 与 09c-chat-table-narrow-390x844.png 为同场景追加带序号 PNG（计划 §Step 5 允许；不得省略需验收的文字角色，全部写入 MANIFEST）。

## 动效唯一性审计（live-indicator-audit.json）

| 场景 | openActivityIds | visibleAnimatedLabels | 动效数 | groupHeaderAnimated |
|---|---|---|---|---|
| reasoning-running | `["reasoning:48acb63d-34d0-417d-b589-4c919943decb"]` | `["思考中"]` | 1 | false |
| tool-after-reasoning | `["tool:b0fc0ac3-b658-49d7-85af-d3e5ef1b924e"]` | `["正在调用 read_skill"]` | 1 | false |
| completed | `[]` | `[]` | 0 | false |

所有 sequential 场景捕获时动效文字均 ≤1，terminal 场景均 =0，展开工作组无 groupHeaderAnimated=true；任一违反采集脚本已退出 1。

## PNG 清单

| # | 文件 | 绝对路径 | viewport | 场景 | 期望文案 | 对应规格 | SHA-256 |
|---|---|---|---|---|---|---|---|
| 1 | `01-reasoning-running-1280x800-t000.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\01-reasoning-running-1280x800-t000.png` | 1280x800 | reasoning-running | 工作组展开；reasoning 运行态：label“思考中”+ 扫光带位于左侧 | Task 15 验收矩阵「流式 reasoning」+ Step 5 场景 01 | `fa710d4a1dd85978499dc6550d407ed6f82c7de5622847a64a3002c0c4d8664e` |
| 2 | `01-reasoning-running-1280x800-t400.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\01-reasoning-running-1280x800-t400.png` | 1280x800 | reasoning-running | 扫光带位于中部；文字不位移，容器不跳动 | Task 15 Step 5 场景 01 / Step 7 验收第 6 条 | `f0a0ab2b3f264e36fdffa6dbd1bc3ce90784af196b8c36d8de59f6f440a0617d` |
| 3 | `01-reasoning-running-1280x800-t900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\01-reasoning-running-1280x800-t900.png` | 1280x800 | reasoning-running | 扫光带位于右侧；label“思考中”保持原位 | Task 15 Step 5 场景 01 / Step 7 验收第 6 条 | `e8847223ab5017c5b3540e1a8398877440234d5f8b9fef87e4af2a99f9ca0650` |
| 4 | `02-tool-after-reasoning-1280x800-t000.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\02-tool-after-reasoning-1280x800-t000.png` | 1280x800 | tool-after-reasoning | reasoning 已完成（“已完成思考”，无动画）；工具运行态“正在调用 read_skill”+ 扫光带位于左侧，唯一动效 | Task 15 Step 5 场景 02 / Step 6 动效唯一性 | `a836bdfbd282851dac432d2d8b9a2c1e4a7174d65b66ead059c8bba8908b2ae6` |
| 5 | `02-tool-after-reasoning-1280x800-t400.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\02-tool-after-reasoning-1280x800-t400.png` | 1280x800 | tool-after-reasoning | 扫光带位于中部；reasoning 完成态不动 | Task 15 Step 7 验收第 6 条 | `2452889ccb52d3e462f3331e7aff37631379915dca01abb59c53e0df1446e41b` |
| 6 | `02-tool-after-reasoning-1280x800-t900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\02-tool-after-reasoning-1280x800-t900.png` | 1280x800 | tool-after-reasoning | 扫光带位于右侧；reasoning 完成态不动 | Task 15 Step 7 验收第 6 条 | `3ff61bb5103f93da53a2445da4c4409850ef3260c05ae6290495b106cb6b39ff` |
| 7 | `03-plan-updated-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\03-plan-updated-1280x800.png` | 1280x800 | plan-updated | 任务计划 1/3：一个 completed（绿色勾选 icon，regular）+ 一个 in_progress（加粗）+ 一个 pending（常规） | Task 15 Step 5 场景 03 / Step 7 验收第 9 条 | `8ff321209a5546090aa873cde91e95c67622e6edd991642b35fda753b459d4bb` |
| 8 | `03b-plan-updated-2of3-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\03b-plan-updated-2of3-1280x800.png` | 1280x800 | plan-updated-2of3 | 任务计划 2/3：两个 completed + 一个 pending（与测试冻结契约 2/3 一致） | Task 15 Step 5 场景 03（2/3 计数；三态对比见 03-plan-updated） | `6a94a5631cbbe0f735b194209296bb903c84208a0b42a3800e4f6640e1dbe53a` |
| 9 | `04-completed-collapsed-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\04-completed-collapsed-1280x800.png` | 1280x800 | completed | 工作组完成态自动折叠：summary 显示“工作了 N 秒”，无任何扫光残留 | Task 15 Step 5 场景 04 / Step 6 终态 0 动效 | `7cc2c903f1464e20773c875956ba04452442060a91bd6a2229b522d37b0c4d58` |
| 10 | `05-reasoning-expanded-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\05-reasoning-expanded-1280x800.png` | 1280x800 | reasoning-expanded | 已完成思考详情展开：完整推理文本，max-height 320px 限高与内层滚动区（内容溢出 320px） | Task 15 Step 5 场景 05 / Step 7 验收第 2 条 | `93397a2d16fc0f1d504d3c400e262d012ba4a8b02988d05607d5818acc034d15` |
| 11 | `06-settings-agent-skills-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\06-settings-agent-skills-1280x800.png` | 1280x800 | settings-agent-skills | 设置页「Agent 技能」分区：全局/项目分段控件 + 技能列表；无启用开关、无卡片套卡片 | Task 15 Step 5 场景 06 / Step 7 验收第 5 条 | `b177888e95330401d6d9d1745fa0d4d08aadb6a3f40bd5be605ac74632a5114d` |
| 12 | `07-chat-narrow-390x844.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\07-chat-narrow-390x844.png` | 390x844 | chat-narrow | 390x844 窄屏聊天：对话/工作组/正文不遮挡、不横向溢出、控件不碰撞；顶栏「面板」单行 | Task 15 Step 5 场景 07 / Step 7 验收第 4 条 | `438530bfb34f6708d3453ca9439b60ebc74ef19f880a0cd2da1f75354ed95738` |
| 13 | `08-settings-medium-768x900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\08-settings-medium-768x900.png` | 768x900 | settings-medium | 768x900 设置页「Agent 技能」分区：布局完整、最后一行不遮挡/不溢出、与固定操作栏留有安全间距 | Task 15 Step 5 场景 08 / Step 7 验收第 4 条 | `54994646094d005998ec2c4498299916722eed454aa298a184a7e69ea6d5a217` |
| 14 | `09-chat-wide-1440x900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\09-chat-wide-1440x900.png` | 1440x900 | chat-wide | 1440x900 宽屏：H1-H6、正文、strong、链接、blockquote、inline code、fenced code 可见且排版完整 | Task 15 Step 5 场景 09 / Step 7 验收第 3、8 条 | `2ea9cb13c17e317edd0b2b39f76a1473f8dbff7b525a21da7e07db0f04779b00` |
| 15 | `09b-chat-wide-markdown-1440x900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\09b-chat-wide-markdown-1440x900.png` | 1440x900 | chat-wide-table | 1440x900：Markdown 任务列表（[x]/[ ]）与 760px 宽表格（窄视口由独立容器横向滚动） | Task 15 Step 5 场景 09（追加带序号 PNG）/ 验收矩阵「Markdown」 | `69f27ff930adbea4123c7b49ff8fe3ce9929a6279f490ac1373c4f208f8b1c53` |
| 16 | `09c-chat-table-narrow-390x844.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-06\09c-chat-table-narrow-390x844.png` | 390x844 | chat-table-narrow | 390x844 窄视口：宽 Markdown 表格横向滚动、任务列表不遮挡/不溢出 | Task 15 Step 5 场景 09（窄视口补拍）/ Step 7 验收第 4 条 | `5251695f842668dd46050038100b1204bf2916667ba720e6caafb6a7761f4ef3` |

## 场景内容契约说明

- 03-plan-updated-1280x800.png 显示三个计划状态（completed / in_progress / pending）以便比较字重与颜色；计划计数按冻结实现为 completed/total，三态时显示 `任务计划 1/3`。
- 03b-plan-updated-2of3-1280x800.png 为补充图（同场景追加带序号 PNG）：第二次 update_plan 后计划为 completed/completed/pending，计数 `任务计划 2/3`，与 tests/app-shell/agent-surface.test.mjs 的 2/3 冻结语义一致。
- 02-tool-after-reasoning 的慢工具为真实 read_skill（经注入的临时 root skills service，读真实的 SKILL.md，仅测试注入 5s 延迟）；read_file 无法被确定性延长，故运行态标签为“正在调用 read_skill”（Step 6 审计如实记录实际标签，不伪造“正在读取文件”）。
- 09-chat-wide-1440x900.png 覆盖 H1–H6、正文、strong、链接、blockquote、inline code、fenced code；若首屏放不下会自动追加 09b。

## 环境说明

- 无
