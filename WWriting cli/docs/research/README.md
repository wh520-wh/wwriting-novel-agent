# 调研文件索引

记录于：2026-10-08｜状态：当前有效｜依据：当前源码、`package.json` 与报告日期复核。本页索引历史调研，不代表当前技术选型或尚未完成的任务。

原调研日期：2026-09-27。方法：子代理联网调研与一手资料抓取；报告中的库版本、价格和建议为调研当日口径，落地前复核。当前 CLI 采用 Node 标准库的终端/网络实现及 `yaml` 依赖，具体入口见[使用说明](../../README.md)，验证见[项目状态](../../../docs/memory/project-progress.md#当前状态)。

## 文件清单

| 文件 | 主题 | 一句话核心结论 |
| --- | --- | --- |
| [01-node-cli-engineering.md](01-node-cli-engineering.md) | Node CLI 工程实践 | Node 24 起步合理;commander v15 + @clack/prompts;keytar 已废,API Key 用 0600 文件 + Windows DPAPI |
| [02-terminal-tui-architecture.md](02-terminal-tui-architecture.md) | 终端 TUI 架构与 Windows 兼容 | 用 Ink 7,inline 模式不用 alt screen;滚动区 = Static 输出进 scrollback + 小动态区;MinTTY 是最大 Windows 坑 |
| [03-ai-agent-cli-products.md](03-ai-agent-cli-products.md) | AI Agent CLI 产品横向对比 | 权限已收敛为「模式+规则+分类器」;无一产品做「输入精确确认文字」——这是 WWriting 独有设计;记忆全面趋同 AGENTS.md |
| [04-llm-api-agent-core.md](04-llm-api-agent-core.md) | LLM API、流式、工具调用、上下文与成本 | 传输层用 openai 包指向智谱 baseURL,agent 循环自写;GLM 流式工具分片需显式 `tool_stream: true`;停止 = AbortController |
| [05-longform-fiction-ai.md](05-longform-fiction-ai.md) | 长篇小说 AI 写作领域知识 | 超长上下文 ≠ 长篇能力,「计划→分章→字数预算」是学术共识;记忆系统收敛为「结构化条目 + 关键词触发注入 + token 预算」 |
| [06-deepseek-reasoning-effort-probe.md](06-deepseek-reasoning-effort-probe.md) | DeepSeek 思考强度与输出上限(适配记录,非实测) | OpenAI 格式下 `none` 只发 `thinking.type=disabled`、`low/high/max` 双发 `reasoning_effort`;官方端点 1M 上下文,最新模型输出 384K |
| ~~06-agent-safety-permissions.md~~ | Agent 权限与安全约束 | **未完成**(子代理派发被中断),主题清单见下节 |

## 调研时的建议（历史记录，不是实际选型）

1. **技术栈**:Node ≥ 24(ESM)+ commander v15 + Ink 7(React ≥ 19.2)+ openai npm 包(baseURL 指向智谱 GLM)。
2. **TUI 布局**:inline 模式;已完成内容用 `<Static>` 写入 scrollback,动态区只保留「活动行 + 状态行 + 输入框 + 叠加卡」。
3. **权限**:WWriting 的「同类授权仅当前输入生效」比业界更严格(差异化卖点);「输入精确确认文字」业界无先例,极端操作清单需自定义。
4. **记忆**:WWRITING.md 对齐 AGENTS.md 行业标准;小说设定条目参考 SillyTavern World Info / NovelCrafter Codex 的「关键词触发 + 预算注入」。
5. **字数**:count_text 主口径取「去空白字符数」,用 Intl.Segmenter 实现;LongWriter/AgentWrite 的「计划-分段-字数预算」是分章生成的学术依据。
6. **停止/打断**:每轮一个 AbortController;打断 = abort 当前请求 + 队列输入提升为下一轮首条消息。

## 当时未完成的调研：06 Agent 权限与安全约束

拟覆盖主题(将来可直接按此续做):
1. Claude Code 权限规则语法与求值顺序、hooks 硬约束、sandbox、bypassPermissions 事故案例;
2. 间接 prompt injection(OWASP LLM Top 10 2025)与「小说文本藏指令」场景分析;
3. 路径安全(项目目录限制、symlink/.. 逃逸、Windows 大小写与 UNC);
4. 「输入精确确认文字」的业界先例(GitHub 删库、Terraform destroy 等);
5. YOLO 模式的「不可跳过底线」产品对比;
6. 临时授权生命周期(sudo timestamp、"always allow" 作用域);
7. 原子写 / crash-safe 写入、审计日志。

注:03(产品对比)与 02(Windows 兼容)已覆盖上述部分内容,续做时可交叉引用、避免重复。
