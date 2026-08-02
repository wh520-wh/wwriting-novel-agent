# Competitive Research: WWriting x DeepSeek Agent API 兼容性

- **日期**：2026-08-01
- **模式**：Rapid（单一模型提供商、单一工程决策）
- **决策**：先把模型输出收敛为可验证的标准 JSON/原生 tool contract，再把 Agent 做成可恢复、可重放、可观测的多轮状态机；用户端只保留自然语言入口。
- **范围**：DeepSeek 官方 API 文档与 WWriting 当前实现的兼容性核对。此报告不是价格承诺、生产压测或安全认证。

## Scope and Evidence Limits

- 研究边界是 DeepSeek 官方 Chat Completions、Thinking Mode、Tool Calls、JSON Output、上下文缓存、限速与错误文档；没有把无关写作产品硬凑进比较表。
- DeepSeek 文档页面存在编码显示异常，但 HTML 中的标题、参数名、模型名、价格和限制均可直接提取；以官方页面当前内容为准。
- 当前环境没有 DEEPSEEK_API_KEY 或在线 provider 环境变量，因此不能把本地 Mock、请求形状验证或文档核对描述成真实 DeepSeek 线上验收。[E15]
- 研究日期为 2026-08-01；价格、模型别名、Beta 能力和并发限制需要在发布前重新抓取。

## Executive Conclusion

DeepSeek 的 OpenAI-compatible Chat Completions、原生 Tool Calls、JSON Output 和 Thinking Mode 足以承载 WWriting 的 Agent 架构。[E1][E2][E3][E4][E5] 但“用户只说一句话就能创作小说”并不意味着模型可以自由输出文本：稳定交付必须由应用层把自然语言意图编译成任务契约，把模型输出限制在 JSON 或原生工具调用，再由本地状态机、权限、字数门禁和文件写入完成副作用。

当前 WWriting 已有不错的控制平面：OpenAI-compatible adapter、SSE、原生章节工具、字数/标题/fact-check 门禁、checkpoint 和 Agent session。[E9][E11][E13] 最大风险不是“没有 Agent”，而是契约还没有统一：聊天、记忆提取、fact-check 依赖提示词中的 JSON 围栏；模型连接探测固定注入 temperature: 0；写作 Agent 每轮重新编译提示词，尚未保存 DeepSeek thinking tool-call 轮次要求的 reasoning_content + assistant tool_calls + tool result 原始消息链。[E2][E10][E12][E13]

因此，DeepSeek 可以跑通，但当前只能说“协议与本地 Mock 路径基本可行，真实 DeepSeek 端到端尚未验收”。工程级顺序应是：

1. 建立统一 JSON contract 和 schema 校验；
2. 按模型能力裁剪 temperature/top_p，显式管理 thinking/reasoning_effort；
3. 保存并回放完整多轮 tool transcript；
4. 将 planning、memory、fact-check 和用户意图全部接入结构化输出；
5. 最后再做重试、幂等、checkpoint、限速、指标和自然语言 UX 收口。

## Current Product Baseline

- 已落地：provider-adapters.mjs 发送 OpenAI-compatible 请求，支持 Bearer、SSE、usage、reasoning_content 兜底，并把章节工具映射为原生 tools/tool_choice。[E9]
- 已落地：章节写作通过 append_chapter_segment 等工具或受控正文通道提交，本地执行器校验 project/chapter/segment/content，并运行字数、标题、word-cap、fact-check 门禁。[E11][E13]
- 已落地：WritingAgentSession 与 runAgentLoop 具备最大轮数、连续只读升级为 commit-only、steer、abort、follow-up 和 settled 事件。[E13]
- 已落地但不够强：memory-extractor.mjs、quality-gates.mjs、chat/agent-protocol.mjs 要求模型输出 JSON，但主要依靠提示词、围栏解析和宽松归一化，而不是 API response_format/strict schema。[E11][E12]
- 风险：model-connection-test.mjs 的 probe 请求无条件带 temperature: 0；DeepSeek thinking mode 官方说明这些采样参数会被忽略，且 v4-pro 的思考模式默认开启。[E2][E10]
- 风险：完整写作预检读取本地 secrets；独立系统环境变量没有被完整映射到应用级 secrets 时，会返回 configuration_missing。[E14]
- 风险：自然语言“开始写第 3 章”会进入写作命令解析，但任务契约按当前章节顺序拒绝跳章；这属于产品语义保护，不是模型失败。[E14][E15]
- 未验证：本地环境没有在线 API 配置，verify-provider-online 不能证明 DeepSeek 真实调用通过。[E15]

## Competitor Comparison

| Competitor / baseline | Category | Evidence | Lesson | Do Not Copy |
|---|---|---|---|---|
| DeepSeek Chat Completions | baseline/provider | [E1][E5] | OpenAI-compatible endpoint 可直接接入；模型与参数能力必须按 capability registry 管理 | 不要把所有 OpenAI 参数静默地发给每个模型 |
| DeepSeek Thinking Mode | baseline/provider | [E2] | reasoning_content 是多轮思考上下文的一部分；tool-call 轮次必须原样回传 | 不要只取 content 或把 reasoning 当普通正文 |
| DeepSeek Tool Calls | baseline/provider | [E3][E5] | assistant.tool_calls 与 role=tool/tool_call_id 构成闭环；strict 是 Beta 能力 | 不要只在提示词里模拟工具调用 |
| DeepSeek JSON Output | baseline/provider | [E4][E5] | response_format=json_object 可保证合法 JSON，但仍需 prompt 中出现 json、合理 max_tokens，并处理空内容 | 不要把合法 JSON 当作业务 schema 已通过 |
| WWriting 当前 Agent | local baseline | [E9][E11][E13] | 已有控制平面和本地门禁，适合向“应用验证副作用、模型提出决策”演进 | 不要把更多自由文本提示词误当成稳定性 |

## Cross-Market Patterns

**Table stakes**：OpenAI-compatible 请求、原生 tools、JSON 输出、thinking/reasoning 兼容、usage/cost 记录、限速和错误重试。[E1][E2][E3][E4][E5][E7][E8]

**WWriting 的可观察差异**：作品和 checkpoint 保存在用户本地文件夹，章节交付经过真实字数门禁、权限和工具写入；这比“模型生成了一段文本”更接近可验证的 Agent 工作流。[E9][E11][E13]

**当前采用阻塞点**：结构化输出还没有统一 contract；planning 尚未形成真正的大纲产物；thinking tool transcript 没有作为一等状态保存；在线连接测试和完整写作使用了不同的配置来源。[E2][E10][E12][E14][E15]

**Non-goals**：本阶段不训练自有模型、不迁移到 Responses API、不把 DeepSeek strict Beta 当作唯一生产保障、不引入云端作品存储、不让模型直接获得任意文件系统权限。

## Prioritized Roadmap

### P0

1. **统一结构化输出 contract**。[E3][E4][E5][E11][E12] Acceptance signal：memory、fact-check、intent、planning 四类请求都能通过同一套版本化 JSON 校验；非法 JSON、缺字段、超枚举值、截断和空内容均产生可分类事件，不得直接写入项目。
2. **实现 DeepSeek capability-aware request builder**。[E2][E5][E10] Acceptance signal：thinking 请求不再依赖固定 temperature: 0；v4-flash/pro、deepseek-chat 的 thinking、reasoning_effort、tool_choice、response_format 组合在单元测试中逐项验证。
3. **保存完整 tool transcript 并支持恢复**。[E2][E3][E13] Acceptance signal：任意一次工具调用后进程中断，恢复请求包含原 assistant tool_calls、必要的 reasoning_content、tool_call_id 和 tool result，且重放不会重复写入。

### P1

1. **将 planning 变成真实模型阶段**。[E4][E11] Acceptance signal：用户只输入故事种子时，系统生成并持久化版本化大纲 JSON；章节任务只能引用已批准大纲版本。
2. **统一自然语言意图编译器**。[E4][E12][E14] Acceptance signal：用户输入“开始写”“继续”“改一下上一章”均落为可解释的 intent JSON 和任务契约；跳章、越权、缺配置在执行前被阻断。
3. **补齐错误、限速、成本和幂等控制**。[E6][E7][E8] Acceptance signal：429/500/网络超时按 Retry-After 与指数退避处理；同一 idempotency key 不产生重复章节段；每次请求记录 usage、cache 命中和最终成本。
4. **建立 DeepSeek 在线契约测试与故障注入**。[E2][E3][E4][E7][E8][E15] Acceptance signal：真实 key 下完成 probe、JSON、tool、thinking、断点恢复五条 smoke；无 key 时测试明确返回配置缺失而不是假成功。

### P2

1. **模型能力注册表与配置 UI 收口**。[E1][E2][E5][E6] Acceptance signal：模型选择后 UI 显示支持的 thinking/tool/JSON/Responses、价格观察日期和风险提示；不兼容组合在发送前被禁用。
2. **可观测性与回放工具**。[E2][E3][E7][E8] Acceptance signal：可按 run/chapter/model 查看请求摘要、状态转移、失败卡、token/cost、重试和 transcript hash；敏感 prompt/API key 不出日志。
3. **长篇稳定性基准与发布门禁**。[E11][E13][E15] Acceptance signal：固定故事种子连续生成 10 章，恢复/重试/取消/重复点击场景均可重放，核心指标达到发布阈值后才允许默认开启高级 Agent。

## Research Limits and Next Validation

- 真实 DeepSeek 线上链路尚未在本环境验收；需要由产品验收方提供临时 key 或在隔离环境运行 verify-provider-online、verify-chat-online。
- DeepSeek strict tool schema 当前是 Beta；生产实现应以本地 schema 校验为最终边界，strict 只作为增强。[E3][E5]
- 官方价格页显示 v4-flash 输入缓存命中/未命中/输出为 0.02/1/2，v4-pro 为 0.025/3/6（每百万 tokens），并发限制为 2500/500；页面同时提示高峰价格与限制可能变化。[E6]
- Responses API 当时只支持 v4-flash，不应作为本阶段 v4-pro 的迁移路径。[E6]
- 下一步不是继续堆提示词，而是按下方实施计划把 contract、能力矩阵、transcript、恢复和验证串成一条可测链路。
