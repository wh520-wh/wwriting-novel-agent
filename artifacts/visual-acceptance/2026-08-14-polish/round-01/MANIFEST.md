# round7 视觉验收证据清单（真实渲染机器断言）

- 采集时间：2026-08-14T19:41:00.367Z
- 采集脚本：scripts/capture-visual-acceptance.cjs（--mode round7）
- 覆盖视口：1280x800、768x900、390x844
- 机器判据（不依赖视觉模型）：横向无溢出、关键 selector 无意外重叠、截图非空且尺寸=viewport、抽样 bitmap ≥2 种 RGB

| 视口 | 横向溢出 | 重叠 | 截图非空白 |
|---|---|---|---|
| 1280x800 | PASS | PASS | PASS |
| 768x900 | PASS | PASS | PASS |
| 390x844 | PASS | PASS | PASS |

PNG 清单（每视口：对话区 / 设置弹窗-模型分区 / 成本抽屉；rename editor 仅 rail 可见的桌面视口落盘）：

- `round7-1280x800.png`（对话区：queue B/C/D + priority pending + context popover）
- `rename-editor-1280x800.png`（会话行内改名编辑器：aria-label 重命名对话；≤880px rail 隐藏故无此图）
- `model-settings-1280x800.png`（弹窗内模型分区：超长 provider/model 名 + 密钥已配置 + 连接错误红字）
- `cost-panel-1280x800.png`（成本统一人民币元，无 $ / ¥）
- `round7-768x900.png`（对话区：queue B/C/D + priority pending + context popover）
- `model-settings-768x900.png`（弹窗内模型分区：超长 provider/model 名 + 密钥已配置 + 连接错误红字）
- `cost-panel-768x900.png`（成本统一人民币元，无 $ / ¥）
- `round7-390x844.png`（对话区：queue B/C/D + priority pending + context popover）
- `model-settings-390x844.png`（弹窗内模型分区：超长 provider/model 名 + 密钥已配置 + 连接错误红字）
- `cost-panel-390x844.png`（成本统一人民币元，无 $ / ¥）

机器 JSON：`visual-acceptance-round7.json`
