# 多会话 UI 视觉验收证据清单

- 采集时间：2026-08-09T19:40:50.740Z
- 采集脚本：.tmp/capture-multi-session-acceptance.cjs（Task 11 构造）
- 主题：light
- 真实项目：D:\WWriting\.demo_runs\visual-multisession-1786304450740\novel
- 覆盖视口：1280x800
- parallel_runtime_supported: false（当前 Runtime 串行执行；跨会话由 project_busy 门禁与前端 busy 态表达，不做并行截图）

## 非主观检查结果

| 检查 | 结果 |
|---|---|
| 图片宽高与视口一致 | PASS（全部 PNG） |
| 像素非全白/全透明 | PASS |
| 页面无横向 overflow | PASS |
| 场景 DOM 断言（multi-session-dom-audit.json） | PASS |
| 动效残留审计（terminal 场景可见动效文字 = 0） | PASS |

## 场景内容契约说明

- two-level-tree-expanded：左侧栏两级树展开态——项目折叠组（chevron aria-expanded=true）→「对话」组头（+ 新建）→ 两个真实会话行（title = 首条消息摘要的惰性创建）与活跃高亮、idle 状态点。
- conversation-list-collapsed：点击 chevron 收起后会话组整体隐藏（DOM 移除），项目行与收起箭头保留，aria-expanded=false。
- running-send-disabled：会话 A（梳理第一章大纲）运行中（gateway hold）→ 切到会话 B 后 busy：发送键禁用、输入占位「另一个对话正在运行」、侧边栏 A 状态点 running、B 活跃高亮。
- busy 复位：release 后 A 终态事件不达 B 会话流，经侧边栏 5s 周期刷新兜底复位（发送键恢复、占位恢复、A 状态点离开 running），已在采集内验证。

## PNG 清单

| # | 文件 | viewport | 状态 | 期望文案 | SHA-256 |
|---|---|---|---|---|---|
| 1 | `two-level-tree-expanded-1280x800.png` | 1280x800 | 两级树展开态：项目折叠组 →「对话」组头（+ 新建）+ 两个会话行（活跃高亮 + 状态点） | 左侧栏项目行 chevron 展开（aria-expanded=true），会话组可见：组头「对话」+ 会话「梳理第一章大纲」「写第二章的开头」，当前活跃会话高亮 | `42ffc17eb5e6af474a8277c25681666e87de31a2095753a07fae7688f627574d` |
| 2 | `conversation-list-collapsed-1280x800.png` | 1280x800 | 对话列表折叠态：项目行 chevron 收起（aria-expanded=false），会话组整体隐藏 | 左侧栏只显示项目行 + 收起箭头，无「对话」组头与会话行；chevron aria-expanded=false | `34608d85aa0add2784df16af30fe84fbbe682af5a55660d2095f64bc68a37149` |
| 3 | `running-send-disabled-1280x800.png` | 1280x800 | 运行中发送禁用态：会话 A 运行中（侧边栏 running 状态点），切到会话 B 后 busy——发送键禁用、输入占位「另一个对话正在运行」 | 左侧栏会话 A 状态点运行中、会话 B 活跃高亮；composer 发送键禁用（greyed），输入框占位文案为「另一个对话正在运行」 | `b1c76da0db32bc9ea4ba27857682697bac57b424cef09a44242f7218da1c808f` |

## 环境说明

- busy 复位经 5s 周期刷新兜底验证：A 会话终态事件不达 B 会话流，侧边栏周期重拉后 setBusy(false)、发送键恢复
