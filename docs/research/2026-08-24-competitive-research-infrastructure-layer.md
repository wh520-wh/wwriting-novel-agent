# Competitive Research: 基础设施层——网关 / 记忆 / 技能 / 流式协议 / 可观测（合并版）

- 日期：2026-08-24；模式：Standard（5 个基础设施项目：LiteLLM、Vercel AI SDK、mem0、Claude Skills、Langfuse）
- 决策问题：WWriting 的 ModelGateway、SKILL.md 技能体系、上下文压缩、成本统计四块基础设施，相对生态标准件的差距与下一步。

## Executive Conclusion

WWriting 自研的 ModelGateway 在"单供应商 + OpenAI 兼容"场景下功能完整，但生态标准件（LiteLLM）已把 **跨部署 fallback 路由、每 Key/项目预算、缓存** 做成开箱能力 [E1]——这是最直接可补的一层。技能体系方面，Claude Skills 的**渐进披露机制**（描述常驻预算 1% 上下文、正文调用时加载、<500 行指引）是 WWriting 四层技能覆盖之外最值得移植的运行时细节 [E4]。流式协议上，Vercel AI SDK 的 part 分类学（text/reasoning/tool-input 增量/审批事件）已成为事实归一化标准，AgentSurface 条目类型可与之对齐 [E2]。mem0 的"ADD-only 记忆 + 多信号检索"验证了**记忆只追加、不覆盖**的方向 [E3]，与批 1 发现的 append-only 设定账本互相印证。明确的 non-goal：不做云端 prompt 管理、LLM-as-a-judge 服务或托管网关。

## Current Product Baseline

WWriting：自研 ModelGateway（retry、超时、心跳、usage、成本记账、provider 缓存字段、OpenAI 兼容原生 function calling、供应商/模型两级管理、连接测试）；SKILL.md 技能体系（四层目录覆盖：全局/项目/用户/内置，同名优先级裁决）；可见上下文压缩（预算优先驱逐大工具输出，仪表盘显示占用与缓存命中率）；成本与缓存报告；Journal 事件溯源。

## Competitor Comparison

| Project | Layer | Evidence | Lesson | Do Not Copy |
| --- | --- | --- | --- | --- |
| LiteLLM | 模型网关 | [E1] | 统一 100+ provider 的 OpenAI 兼容面 + Router retry/fallback + 虚拟 Key/按项目用户记账 + 缓存 + 管理台开箱即用；8ms P95@1kRPS | 多租户网关与企业版商业模式（WWriting 单机本地） |
| Vercel AI SDK (streamText) | 流式协议 | [E2] | part 分类学：text/reasoning/tool-input 的 start/delta/end + tool-call/result/error + tool-approval-request/response；背压（按需生成）；smoothStream 变换 | 服务端框架绑定 |
| mem0 | 记忆层 | [E3] | 2026-04 起新算法：单遍 ADD-only 抽取（不覆盖、只累积）+ 实体链接 + 时间推理；多信号检索（语义+BM25+实体并行打分融合） | 云平台 benchmark 数字（OSS 不同实现） |
| Claude Skills | 技能/插件 | [E4] | 企业>个人>项目目录优先级；渐进披露三层（描述常驻、正文调用时载、引用文件按需）；清单预算为上下文 1%、超限先淘汰低频；SKILL.md <500 行指引；commands 已并入 skills；Agent Skills 开放标准跨工具 | 企业托管分发层 |
| Langfuse | 可观测 | [E5] | trace 聚合 LLM 调用+检索+agent 动作；prompt 版本化+双端缓存；评估（judge/代码/用户反馈/人工标注）+数据集；自托管 Docker | ee 目录商业许可；云端依赖方向 |

## Cross-Market Patterns

- **Table stakes（网关）**：统一 OpenAI 兼容面 [E1]（WWriting 已有）；retry/fallback [E1]（WWriting 有 retry、无跨部署 fallback）；成本记账（WWriting 已有，粒度到 Run/会话）。
- **记忆共识**：只追加不覆盖 [E3] 与批 1 的 append-only 设定账本结论互证；检索多信号融合（语义+关键词+实体）是下一步方向 [E3]。
- **技能机制标准**：渐进披露 + 目录优先级 + 命令并入技能 [E4]——WWriting 已有四层覆盖与 SKILL.md 组织，缺"清单预算/低频淘汰"与"命令即技能"的统一叙事。
- **流式协议归一化**：reasoning 流、工具输入增量流、审批事件流是三类必须独立建模的通道 [E2]（WWriting 已分思考/正文/工具，缺工具参数增量与审批事件的通道化）。
- **Non-goal**：云端 prompt 管理平台、LLM-as-a-judge 托管服务、多租户网关 [E1][E5]。

## Prioritized Roadmap

### P0

技能清单预算与渐进披露对齐：技能描述常驻占上下文设上限（对标 1% 上下文预算与超限淘汰低频技能 [E4]），正文仅调用时加载、引用文件按需读取，SKILL.md 保持 <500 行的编写规范。验收信号：技能清单加载有字节/条目上限并有低频淘汰逻辑的测试；内置技能均符合行数规范。

### P1

1. 网关补 fallback 路由与预算提醒：同一供应商多 endpoint 或跨供应商兜底一次失败 [E1]；每工作区成本上限达到阈值在仪表盘提示。验收信号：注入主端点故障的测试中自动 fallback 并在 Journal 记录；成本阈值触发的 UI 提示有验收用例。
2. 流式条目通道化：AgentSurface 工作组条目类型与 part 分类学对齐（工具参数增量、审批请求/响应作为独立通道）[E2]。验收信号：条目模型含五类通道（正文/思考/工具输入增量/工具结果/审批事件）且渲染各有归属。

### P2

Journal 增加 trace 视图：按 Run 聚合调用树（模型调用/工具/子 Run 的 token、成本、时长），完全本地实现，对标 Langfuse 的 trace 调试思想 [E5]。验收信号：仪表盘可按任一 Run 展开三层调用树并显示成本与耗时。

## Research Limits and Next Validation

- LiteLLM 许可证名未在页面明示（LICENSE 文件存在但未命名），商用参考前需查 LICENSE 原文。
- mem0 的图记忆（graph memory）未在取证内容中出现，未进入结论；LoCoMo/LongMemEval 分数为平台版数字，官方自注 OSS 用户"方向相似但数值不同"。
- Vercel AI SDK 仅取证 streamText 一页；provider 差异归一化的细节未展开。
- Langfuse 未取证 ee 功能清单与 trace 数据模型细节（spans/generations 术语未在页面出现）。
- 下一步验证：本地起 Langfuse Docker 对比 Journal 的信息完备度；用 LiteLLM router 配置模拟 WWriting 双供应商 fallback。
