# 视觉验收证据清单

- 轮次：round-03
- 采集时间：2026-08-07T04:40:17.214Z
- 采集脚本：scripts/capture-visual-acceptance.cjs
- 测试项目：D:\WWriting\.worktrees\agent-work-log-skills\.demo_runs\visual-acceptance-1786077617215\novel
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

场景客观检查说明：
- `reasoning-detail-scroll`（05）：展开的 reasoning 详情 `scrollHeight > clientHeight`，证明 320px 限高内层滚动区真实存在。
- `panel-button-single-line`（07）：390 窄屏顶栏「面板」按钮单行显示（`scrollHeight ≤ clientHeight` 且 `scrollWidth ≤ clientWidth`），不拆行。
- `settings-footer-clearance`（08）：768x900 设置技能列表滚到底后，最后一行与固定操作栏 `.spd-foot` bbox 不相交，且完整位于滚动视口内。

## 动效唯一性审计（live-indicator-audit.json）

| 场景 | openActivityIds | visibleAnimatedLabels | 动效数 | groupHeaderAnimated |
|---|---|---|---|---|
| reasoning-running | `["reasoning:f001ba2f-575d-4625-b518-7342034405ac"]` | `["思考中"]` | 1 | false |
| tool-after-reasoning | `["tool:36057d31-befb-44f3-b9b8-e9d41daa598d"]` | `["正在调用 read_skill"]` | 1 | false |
| completed | `[]` | `[]` | 0 | false |

所有 sequential 场景捕获时动效文字均 ≤1，terminal 场景均 =0，展开工作组无 groupHeaderAnimated=true；任一违反采集脚本已退出 1。

## PNG 清单

| # | 文件 | 绝对路径 | viewport | 场景 | 期望文案 | 对应规格 | SHA-256 |
|---|---|---|---|---|---|---|---|
| 1 | `01-reasoning-running-1280x800-t000.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\01-reasoning-running-1280x800-t000.png` | 1280x800 | reasoning-running | 工作组展开；reasoning 运行态：label“思考中”+ 扫光动画，摘要最多两行 | Task 15 验收矩阵「流式 reasoning」+ Step 5 场景 01 | `f167f2ad9b8f42fb290dfa6049548a1858cc3e9cc8df0e4afd5e53e85521ee6a` |
| 2 | `01-reasoning-running-1280x800-t400.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\01-reasoning-running-1280x800-t400.png` | 1280x800 | reasoning-running | 同 t000；扫光从左向右移动，文字不位移，容器不跳动 | Task 15 Step 5 场景 01 / Step 7 验收第 6 条 | `e47cfe46830ced11f5e8e80b808119b3569986b046e21312102261a758ce89b0` |
| 3 | `01-reasoning-running-1280x800-t900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\01-reasoning-running-1280x800-t900.png` | 1280x800 | reasoning-running | 同 t000；文本按自然片段替换，label“思考中”保持原位 | Task 15 Step 5 场景 01 / Step 7 验收第 6 条 | `dfd5c08f2d37cb8ba44b14455bb747757140c2b1ede133685e0c04f45775ebc3` |
| 4 | `02-tool-after-reasoning-1280x800-t000.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\02-tool-after-reasoning-1280x800-t000.png` | 1280x800 | tool-after-reasoning | reasoning 已完成（“已完成思考”，无动画）；工具运行态“正在调用 read_skill”+ 扫光，唯一动效 | Task 15 Step 5 场景 02 / Step 6 动效唯一性 | `df1bb4bea50cd8259ac64667fea585fcabab1c56fbd57f44d70c920e6d773142` |
| 5 | `02-tool-after-reasoning-1280x800-t400.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\02-tool-after-reasoning-1280x800-t400.png` | 1280x800 | tool-after-reasoning | 同 t000；工具扫光移动，reasoning 完成态不动 | Task 15 Step 7 验收第 6 条 | `f077cc983a2d5e903c2dd2425d7175334eaab4fc15fa6173f3637331615a7f81` |
| 6 | `02-tool-after-reasoning-1280x800-t900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\02-tool-after-reasoning-1280x800-t900.png` | 1280x800 | tool-after-reasoning | 同 t000；工具扫光移动，reasoning 完成态不动 | Task 15 Step 7 验收第 6 条 | `b79f0a77b5f875c06f6f0041d040ece3b3566664ef546260ad5316867ed576f3` |
| 7 | `03-plan-updated-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\03-plan-updated-1280x800.png` | 1280x800 | plan-updated | 任务计划 1/3：一个 completed（绿色勾选 icon，regular）+ 一个 in_progress（加粗）+ 一个 pending（常规） | Task 15 Step 5 场景 03 / Step 7 验收第 9 条 | `a6e9857970c13593d4229af3bde6caf42d2ee4a2bda6604b919af10a81600851` |
| 8 | `03b-plan-updated-2of3-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\03b-plan-updated-2of3-1280x800.png` | 1280x800 | plan-updated-2of3 | 任务计划 2/3：两个 completed + 一个 pending（与测试冻结契约 2/3 一致） | Task 15 Step 5 场景 03（2/3 计数；三态对比见 03-plan-updated） | `8807b0b8a6ee2db4767a7b75af8985dbddf98a07f44f3a8cdcf55f12170787f4` |
| 9 | `04-completed-collapsed-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\04-completed-collapsed-1280x800.png` | 1280x800 | completed | 工作组完成态自动折叠：summary 显示“工作了 N 秒”，无任何扫光残留 | Task 15 Step 5 场景 04 / Step 6 终态 0 动效 | `12609979de5244fe77eee68487dd383c218408280de69101aa192790e7ae6873` |
| 10 | `05-reasoning-expanded-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\05-reasoning-expanded-1280x800.png` | 1280x800 | reasoning-expanded | 已完成思考详情展开：完整推理文本，max-height 320px 限高与内层滚动区（内容溢出 320px） | Task 15 Step 5 场景 05 / Step 7 验收第 2 条 | `442cb43f803add468530b527382c98837d8d3091ac50112741f4b73a5f32a8ef` |
| 11 | `06-settings-agent-skills-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\06-settings-agent-skills-1280x800.png` | 1280x800 | settings-agent-skills | 设置页「Agent 技能」分区：全局/项目分段控件 + 技能列表；无启用开关、无卡片套卡片 | Task 15 Step 5 场景 06 / Step 7 验收第 5 条 | `729bfa4f9ee1387ca61193a66e94b0d1e0bcf3c978ca5d997342eca07637544d` |
| 12 | `07-chat-narrow-390x844.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\07-chat-narrow-390x844.png` | 390x844 | chat-narrow | 390x844 窄屏聊天：对话/工作组/正文不遮挡、不横向溢出、控件不碰撞；顶栏「面板」单行 | Task 15 Step 5 场景 07 / Step 7 验收第 4 条 | `00637a7344448dc96a82cb57ac702d569cd933f01bc6faa5fd3ed16141a4627b` |
| 13 | `08-settings-medium-768x900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\08-settings-medium-768x900.png` | 768x900 | settings-medium | 768x900 设置页「Agent 技能」分区：布局完整、最后一行不遮挡/不溢出、与固定操作栏留有安全间距 | Task 15 Step 5 场景 08 / Step 7 验收第 4 条 | `e76a17f41793fefd621a643302985755c06305bf8f74651457754ca10ce3de20` |
| 14 | `09-chat-wide-1440x900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-03\09-chat-wide-1440x900.png` | 1440x900 | chat-wide | 1440x900 宽屏：H1-H6、正文、strong、链接、blockquote、inline code、fenced code 全部可见且排版完整 | Task 15 Step 5 场景 09 / Step 7 验收第 3、8 条 | `d858a3bb05f3f9de91b4a4af376ee8df17a39a0e08108a0705dfdf7fff2b6001` |

## 场景内容契约说明

- 03-plan-updated-1280x800.png 显示三个计划状态（completed / in_progress / pending）以便比较字重与颜色；计划计数按冻结实现为 completed/total，三态时显示 `任务计划 1/3`。
- 03b-plan-updated-2of3-1280x800.png 为补充图（同场景追加带序号 PNG）：第二次 update_plan 后计划为 completed/completed/pending，计数 `任务计划 2/3`，与 tests/app-shell/agent-surface.test.mjs 的 2/3 冻结语义一致。
- 02-tool-after-reasoning 的慢工具为真实 read_skill（经注入的临时 root skills service，读真实的 SKILL.md，仅测试注入 5s 延迟）；read_file 无法被确定性延长，故运行态标签为“正在调用 read_skill”（Step 6 审计如实记录实际标签，不伪造“正在读取文件”）。
- 09-chat-wide-1440x900.png 覆盖 H1–H6、正文、strong、链接、blockquote、inline code、fenced code；若首屏放不下会自动追加 09b。

## 环境说明

- 无
