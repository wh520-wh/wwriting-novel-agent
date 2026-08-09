# 视觉验收证据清单

- 轮次：round-02
- 采集时间：2026-08-07T03:20:36.548Z
- 采集脚本：scripts/capture-visual-acceptance.cjs
- 测试项目：D:\WWriting\.worktrees\agent-work-log-skills\.demo_runs\visual-acceptance-1786072836548\novel
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

| 文件 | 图片尺寸 | 像素非空白 | 无横向溢出 | bbox 不相交 |
|---|---|---|---|---|
| 01-reasoning-running-1280x800-t000.png | 1280x800 | PASS | PASS | PASS |
| 01-reasoning-running-1280x800-t400.png | 1280x800 | PASS | PASS | PASS |
| 01-reasoning-running-1280x800-t900.png | 1280x800 | PASS | PASS | PASS |
| 02-tool-after-reasoning-1280x800-t000.png | 1280x800 | PASS | PASS | PASS |
| 02-tool-after-reasoning-1280x800-t400.png | 1280x800 | PASS | PASS | PASS |
| 02-tool-after-reasoning-1280x800-t900.png | 1280x800 | PASS | PASS | PASS |
| 03-plan-updated-1280x800.png | 1280x800 | PASS | PASS | PASS |
| 03b-plan-updated-2of3-1280x800.png | 1280x800 | PASS | PASS | PASS |
| 04-completed-collapsed-1280x800.png | 1280x800 | PASS | PASS | PASS |
| 05-reasoning-expanded-1280x800.png | 1280x800 | PASS | PASS | PASS |
| 06-settings-agent-skills-1280x800.png | 1280x800 | PASS | PASS | PASS |
| 07-chat-narrow-390x844.png | 390x844 | PASS | PASS | PASS |
| 08-settings-medium-768x900.png | 768x900 | PASS | PASS | PASS |
| 09-chat-wide-1440x900.png | 1440x900 | PASS | PASS | PASS |

## 动效唯一性审计（live-indicator-audit.json）

| 场景 | openActivityIds | visibleAnimatedLabels | 动效数 | groupHeaderAnimated |
|---|---|---|---|---|
| reasoning-running | `["reasoning:225885fc-5b49-4128-8a50-f223448b9740"]` | `["思考中"]` | 1 | false |
| tool-after-reasoning | `["tool:4ccdaefc-328a-4b84-83de-3a8a9100a764"]` | `["正在调用 read_skill"]` | 1 | false |
| completed | `[]` | `[]` | 0 | false |

所有 sequential 场景捕获时动效文字均 ≤1，terminal 场景均 =0，展开工作组无 groupHeaderAnimated=true；任一违反采集脚本已退出 1。

## PNG 清单

| # | 文件 | 绝对路径 | viewport | 场景 | 期望文案 | 对应规格 | SHA-256 |
|---|---|---|---|---|---|---|---|
| 1 | `01-reasoning-running-1280x800-t000.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\01-reasoning-running-1280x800-t000.png` | 1280x800 | reasoning-running | 工作组展开；reasoning 运行态：label“思考中”+ 扫光动画，摘要最多两行 | Task 15 验收矩阵「流式 reasoning」+ Step 5 场景 01 | `096e82cf85eccfa43bfac2f1668785a2ab39edb7fa03c2a0d200a064b8f177a1` |
| 2 | `01-reasoning-running-1280x800-t400.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\01-reasoning-running-1280x800-t400.png` | 1280x800 | reasoning-running | 同 t000；扫光从左向右移动，文字不位移，容器不跳动 | Task 15 Step 5 场景 01 / Step 7 验收第 6 条 | `8c4496489849c371b3d01e7a4ddbf6d7be4b90dca7c1402e28cbc5558791335d` |
| 3 | `01-reasoning-running-1280x800-t900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\01-reasoning-running-1280x800-t900.png` | 1280x800 | reasoning-running | 同 t000；文本按自然片段替换，label“思考中”保持原位 | Task 15 Step 5 场景 01 / Step 7 验收第 6 条 | `864688ce6afcd9dc016381ab323326df994ab037b55865b61b93f08ccdc5b079` |
| 4 | `02-tool-after-reasoning-1280x800-t000.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\02-tool-after-reasoning-1280x800-t000.png` | 1280x800 | tool-after-reasoning | reasoning 已完成（“已完成思考”，无动画）；工具运行态“正在调用 read_skill”+ 扫光，唯一动效 | Task 15 Step 5 场景 02 / Step 6 动效唯一性 | `9c48b0da248c2eeff7f5cca0e80735102cc67910d6c6c6ecb1f29a7a1d0d8158` |
| 5 | `02-tool-after-reasoning-1280x800-t400.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\02-tool-after-reasoning-1280x800-t400.png` | 1280x800 | tool-after-reasoning | 同 t000；工具扫光移动，reasoning 完成态不动 | Task 15 Step 7 验收第 6 条 | `b14e71e90bb5d274ad7d9cd08ce8ce402ae3733c0adf135df0bb4585b14d0f84` |
| 6 | `02-tool-after-reasoning-1280x800-t900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\02-tool-after-reasoning-1280x800-t900.png` | 1280x800 | tool-after-reasoning | 同 t000；工具扫光移动，reasoning 完成态不动 | Task 15 Step 7 验收第 6 条 | `674e59195d34b9aad90035b1045c630fe8ad5c2866616992521974b68427b432` |
| 7 | `03-plan-updated-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\03-plan-updated-1280x800.png` | 1280x800 | plan-updated | 任务计划 1/3：一个 completed（绿色勾选 icon，regular）+ 一个 in_progress（加粗）+ 一个 pending（常规） | Task 15 Step 5 场景 03 / Step 7 验收第 9 条 | `ad5206fd16cf7009823d356c6866b1fdef0c967cb231c798c85efc6eb4c5bc78` |
| 8 | `03b-plan-updated-2of3-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\03b-plan-updated-2of3-1280x800.png` | 1280x800 | plan-updated-2of3 | 任务计划 2/3：两个 completed + 一个 pending（与测试冻结契约 2/3 一致） | Task 15 Step 5 场景 03（2/3 计数；三态对比见 03-plan-updated） | `334b834e01afa6a0c15b243f04528756db7af52dd39c80479e8f55f72c92cf42` |
| 9 | `04-completed-collapsed-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\04-completed-collapsed-1280x800.png` | 1280x800 | completed | 工作组完成态自动折叠：summary 显示“工作了 N 秒”，无任何扫光残留 | Task 15 Step 5 场景 04 / Step 6 终态 0 动效 | `7ca394fe0dd6fd6ec88a31232491b19e93c15b6574d4fe677a3fd665cc8030c9` |
| 10 | `05-reasoning-expanded-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\05-reasoning-expanded-1280x800.png` | 1280x800 | reasoning-expanded | 已完成思考详情展开：完整推理文本，max-height 320px 限高与滚动区 | Task 15 Step 5 场景 05 / Step 7 验收第 2 条 | `7cbf6920c17b4a156a0acd216094ef87cfa3c6e9f6fa96a9b2920f60d4f662a8` |
| 11 | `06-settings-agent-skills-1280x800.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\06-settings-agent-skills-1280x800.png` | 1280x800 | settings-agent-skills | 设置页「Agent 技能」分区：全局/项目分段控件 + 技能列表；无启用开关、无卡片套卡片 | Task 15 Step 5 场景 06 / Step 7 验收第 5 条 | `bb615693e09cce6bbc8a4976789b3e8edd07d6ec5a55b8e7e4d9b20b0fbe4a7b` |
| 12 | `07-chat-narrow-390x844.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\07-chat-narrow-390x844.png` | 390x844 | chat-narrow | 390x844 窄屏聊天：对话/工作组/正文不遮挡、不横向溢出、控件不碰撞 | Task 15 Step 5 场景 07 / Step 7 验收第 4 条 | `e1fa8b09cab4bc8ef5afcae50787fc0a6e61d1a6535b6d17e473b599e874d45c` |
| 13 | `08-settings-medium-768x900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\08-settings-medium-768x900.png` | 768x900 | settings-medium | 768x900 设置页「Agent 技能」分区：布局完整、无遮挡/溢出/碰撞 | Task 15 Step 5 场景 08 / Step 7 验收第 4 条 | `0c24f4ef90b7a9cdff166f0bd4fd0f5fc957566ae6a4ff5882f11c9c389d354c` |
| 14 | `09-chat-wide-1440x900.png` | `D:\WWriting\artifacts\visual-acceptance\2026-08-07-agent-work-log-markdown-skills\round-02\09-chat-wide-1440x900.png` | 1440x900 | chat-wide | 1440x900 宽屏：H1-H6、正文、strong、链接、blockquote、inline code、fenced code 全部可见且排版完整 | Task 15 Step 5 场景 09 / Step 7 验收第 3、8 条 | `d858a3bb05f3f9de91b4a4af376ee8df17a39a0e08108a0705dfdf7fff2b6001` |

## 场景内容契约说明

- 03-plan-updated-1280x800.png 显示三个计划状态（completed / in_progress / pending）以便比较字重与颜色；计划计数按冻结实现为 completed/total，三态时显示 `任务计划 1/3`。
- 03b-plan-updated-2of3-1280x800.png 为补充图（同场景追加带序号 PNG）：第二次 update_plan 后计划为 completed/completed/pending，计数 `任务计划 2/3`，与 tests/app-shell/agent-surface.test.mjs 的 2/3 冻结语义一致。
- 02-tool-after-reasoning 的慢工具为真实 read_skill（经注入的临时 root skills service，读真实的 SKILL.md，仅测试注入 5s 延迟）；read_file 无法被确定性延长，故运行态标签为“正在调用 read_skill”（Step 6 审计如实记录实际标签，不伪造“正在读取文件”）。
- 09-chat-wide-1440x900.png 覆盖 H1–H6、正文、strong、链接、blockquote、inline code、fenced code；若首屏放不下会自动追加 09b。

## 环境说明

- 无
