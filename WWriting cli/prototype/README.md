# WWriting CLI · 交互原型

单文件 HTML 原型（`index.html`，零依赖、不联网、不调用模型），演示 WWriting 命令行版的交互与文案。
交互与文案依据上游规格：`D:\WWriting\docs\design\写作Agent对话样式规格书.md`、`Agent自主初始化与命令行工具规格书.md`。

## 打开方式

直接双击 `index.html`，或：

```powershell
start D:\"WWriting cli"\prototype\index.html
```

## 可以试什么

| 演示 | 操作 |
| --- | --- |
| 完整写作流 | 点「▶ 完整演示 · 写第 3 章」：任务计划悬浮层 → 读记忆/提纲/前章 → 写入确认卡 → 正文增量输出 → `count_text` 客观字数 1,382 → 补写 → 2,047 → 提交章节（校验和 + 快照）→ 更新记忆 |
| /init | 输入 `/init`（有斜杠自动补全菜单）：建立 WWRITING.md 项目记忆，不生成固定蓝图 |
| 权限分级 | 写入前出现琥珀色确认卡：一次允许 / 本条输入允许同类操作 / 拒绝 |
| 极端操作 | 点「极端操作确认」：红色卡片，必须输入当次给出的精确确认文字才能执行 |
| 队列与打断 | 运行中再发一条消息 → 显示 `排队`；「立即」打断当前轮并提升输入；「停止」/ Ctrl+C 干净收敛并清除临时授权 |
| 斜杠命令 | `/cost` `/skills` `/model` `/export` `/compact`（可取消）`/plan` `/yolo`（Shift+Tab 同）`/stop` `/clear` `/help` |
| 文件引用 | 输入 `@` 弹出工作区文件补全 |
| 其他 | `↑`/`↓` 历史；活动行点击展开折叠详情（参数/校验和/耗时）；任务计划点击标题展开/收起 |

## 截图自检

`_shot_*.png` 为无头浏览器验证截图（横幅 / 权限卡 / YOLO 全流程终态 / 极端确认卡）。
修改 `index.html` 后的最小验证：

```bash
sed -n '/^<script>$/,/^<\/script>$/p' index.html | sed '1d;$d' > /tmp/proto.js && node --check /tmp/proto.js
```
