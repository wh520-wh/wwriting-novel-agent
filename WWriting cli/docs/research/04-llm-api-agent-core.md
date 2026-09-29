# 在 Node.js 里接 LLM:API、流式、工具调用、上下文与成本(2025–2026 现状调研)

> 调研日期:2026-09-27。以官方文档一手资料为主(bigmodel.cn / platform.openai.com / platform.claude.com / ai-sdk.dev),价格为当时线上口径,落地前请以当日官方页复核。无法确认的说法均标注「未确认」。

## 核心结论(TL;DR)

1. **SDK 选型:传输层用 `openai` npm 包(`baseURL` 指向智谱),agent 循环自写。** GLM 的 `/api/paas/v4/chat/completions` 与 OpenAI Chat Completions 高度兼容(智谱官方文档直接演示用 openai npm 包连 GLM),单 provider 主力场景不需要 Vercel AI SDK 这样的多 provider 抽象;`@anthropic-ai/sdk` 仅在直连 Claude 时需要。
2. **智谱 GLM 关键差异**:工具参数分片流式需**显式** `tool_stream: true`(OpenAI 是默认行为);`tool_choice` 仅支持 `auto`;`finish_reason` 有 `sensitive` / `network_error` / `model_context_window_exceeded` 等自有取值;`thinking` 参数控制深度思考、思考文本在 `reasoning_content` 字段且默认多轮自动清除;**隐式上下文缓存全自动**,命中约 5 折。
3. **「停止」的实现**:每轮一个 `AbortController`,通过请求级 `signal` 传入;abort 后 SSE 读循环立即以 AbortError 收敛,流式中途取消已生成 token 仍计费。「打断」= abort 当前请求 + 队列新输入提升为下一轮首条消息,不建第二个 Agent 实例。
4. **Token 与成本**:预检用 `js-tiktoken`(o200k_base)粗估即可,**结算一律以响应 `usage` 字段为准**;GLM 官方口径 token:汉字 ≈ 1:1.6。会话成本 = 每轮 usage 分类累计(输入/输出/缓存命中)× 单价表,以 JSONL 追加进应用私有目录。
5. **上下文管理**:2026 年主力窗口 200K–1M;主流 agent CLI(Claude Code)在约 80% 用量处自动摘要压缩(auto-compact)。WWriting 的章节文件与 `WWRITING.md` 天然承担外部记忆,压缩可更激进(旧 tool_result 直接丢弃)。

---

## 一、SDK 选型对比

### 1.1 openai(npm)

官方 Node/TS SDK,由 OpenAPI 规范自动生成,Apache-2.0([GitHub: openai/openai-node](https://github.com/openai/openai-node))。

- 运行时要求:Node 22/24 LTS(最低 v22,Node 20 已弃),另支持 Deno/Bun/Workers;浏览器默认禁用(CLI 无关)。
- 两套 API:
  - `client.chat.completions.create({...})` — 旧标准,官方声明长期支持;**所有 OpenAI 兼容第三方端点(智谱/DeepSeek/Qwen 等)只覆盖这套**,Responses API 的服务端会话(`previous_response_id`)与内置工具在兼容层不可用。
  - `client.responses.create({...})` — OpenAI 主推的新 API(指令、工具、reasoning 项统一在 `output` 数组),仅 OpenAI 官方可用。
- 流式:`stream: true` 后 `for await (const event of stream)`,SDK 内部完成 SSE 解析。
- 可靠性:默认 `maxRetries: 2`,指数退避;触发条件为连接错误、408、409、429、≥500;client 级与请求级均可覆盖(设 0 关闭)。默认 `timeout` 10 分钟(超时抛 `APIConnectionTimeoutError` 且同样参与重试)。
- 取消:请求级 `signal: AbortSignal`,可中断响应体读取过程。
- 关键配置:`baseURL`(接 GLM 就改这一项 + `apiKey`)、自定义 `fetch`/`fetchOptions`(代理场景)、`withResponse()` 取原始 Response。

### 1.2 @anthropic-ai/sdk

官方 TypeScript SDK,MIT([GitHub: anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript))。

- 核心 API:`client.messages.create({ model, max_tokens, messages })`,`max_tokens` 必填(与 OpenAI 不同)。
- 流式:`client.messages.stream()` 助手类 + 事件式 `create({ stream: true })`;事件模型见第四章。
- 提供 `client.messages.countTokens()`(官方 token 计数,见第六章)。
- 运行时:Node 20 LTS+、TS ≥ 5.0;`maxRetries` 默认 2(指数退避)、`timeout` 默认 10 分钟、请求级 `abortSignal`,与 openai-node 同一工程模式。
- 与 OpenAI 格式**不兼容**(content blocks、tool_use/tool_result 结构),多 provider 复用时需要适配层或引入 AI SDK。

### 1.3 Vercel AI SDK(当前 v7)

TypeScript 多 provider 工具包([官方文档:Introduction](https://ai-sdk.dev/docs/introduction))。2026 年主线为 **v7**。

- Provider 抽象:`@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/google` 等数十家;第三方兼容端点走 `@ai-sdk/openai-compatible` 的 `createOpenAICompatible({ name, apiKey, baseURL })`——这是接 GLM 的标准姿势(社区示例普遍如此配置智谱)。
- Agent 抽象([Loop Control 文档](https://ai-sdk.dev/docs/agents/loop-control)):
  - `ToolLoopAgent` 默认 `stopWhen: isStepCount(20)` 防失控;内置停止条件 `isStepCount(n)` / `hasToolCall(...names)` / `isLoopFinished()`,可自定义 `StopCondition`(如按累计 token 估算成本超阈值即停)。
  - `prepareStep` 每步前动态改模型、`maxOutputTokens`、`temperature`、`activeTools`、`toolChoice`,或 override `messages` 做步骤级上下文压缩(配合 `pruneMessages`)。
  - 工具带 `execute` 则由 SDK 执行并自动回传结果;支持 tool approvals(工具审批)——语义上对应 WWriting 的权限分级。
  - 强制工具调用模式:`toolChoice: 'required'` + 一个无 execute 的 `done` 工具,被调用即终止。
- 成本与批评:抽象层厚,社区对其包体积有批评(两个包约 186 kB;见 [hyperknot 博客](https://blog.hyperknot.com/));错误与原始响应被包装,处理 GLM 特有字段(`reasoning_content`、`sensitive`)需穿透 provider 扩展点。原生子包按 provider 拆分,未用到的 provider 不必安装。

### 1.4 手写 fetch + SSE

- 优点:零依赖;Node ≥ 24 的原生 `fetch` + `ReadableStream` 完全够用;对 abort、状态行、权限确认点有绝对控制权;处理 GLM 特有字段无类型阻碍。
- 缺点:需自行实现 SSE 分帧缓冲(见 4.1)、指数退避、错误类型化、连接超时——这些恰是 openai 包久经考验的部分。
- 折中(本项目采用):**openai 包做传输层,SSE 解析/重试/超时/abort 白拿;agent 循环、队列、权限、状态行全部自写。**

### 1.5 社区主流推荐(2025–2026)

- 综述类对比的共识:直连官方 SDK 延迟最低、特性最全(少一层抽象);AI SDK 适合多 provider 快速切换产品(改 model 标识符即换厂商);OpenAI/Anthropic 各自还有面向多步 Agent 的上层 Agents SDK(带 tracing/guardrails),但那是重型方案。
- 终端 Agent CLI(Claude Code、Codex CLI 等)均为自研循环 + 自家传输;GLM 国际站官方 quick-start 直接给 [openai npm 包连 GLM 的 Node.js 示例](https://docs.z.ai/guides/overview/quick-start)。

---

## 二、智谱 GLM API 重点调研(bigmodel.cn,2026-09 现状)

### 2.1 端点与鉴权

- 国内主站:`POST https://open.bigmodel.cn/api/paas/v4/chat/completions`;用 OpenAI SDK 时 `baseURL: 'https://open.bigmodel.cn/api/paas/v4/'`(SDK 自动追加 `/chat/completions`)。
- 国际站 Z.ai:`https://api.z.ai/api/paas/v4/chat/completions`;GLM Coding Plan 订阅走专用端点(见 docs.z.ai devpack 教程,不可直接用默认端点)。
- 鉴权:`Authorization: Bearer <API_KEY>`,API Key 只存本机(符合铁律 8)。
- 依据:[对话补全 API 参考](https://docs.bigmodel.cn/api-reference/模型-api/对话补全.md)、[Z.ai Quick Start](https://docs.z.ai/guides/overview/quick-start)。

### 2.2 请求参数(对话补全)

| 参数 | 说明 |
| --- | --- |
| `model` | 如 `glm-5.3`、`glm-5.2`、`glm-5.3-flash` 等 |
| `messages` | `system`/`user`/`assistant`/`tool` 四角色;不能只含 system/assistant |
| `tools` | 最多 **128** 个;type 支持 `function`、`retrieval`、`web_search`、`mcp` |
| `tool_choice` | **默认且仅支持 `auto`**(无 required/指定函数) |
| `thinking` | `{ type: "enabled"|"disabled", clear_thinking }`,`clear_thinking` 默认 true |
| `reasoning_effort` | `max/xhigh/high/medium/low/minimal/none`;GLM-5.3 系列仅 `max/high/low` |
| `stream` | SSE 流式,默认 false |
| `tool_stream` | **工具调用参数是否随流分片,默认 false** |
| `max_tokens` | GLM-5.3 系列最大 131072(128K),建议 ≥1024 |
| `temperature` | [0,1] 限两位小数(GLM-5.3 默认 1.0,GLM-4.5 系列默认 0.6) |
| `top_p` / `do_sample` | [0.01,1];`do_sample:false` 时忽略采样参数 |
| `response_format` | `text` 或 `json_object` |
| `stop` | 最多 4 个停止词 |
| `request_id` / `user_id` | 请求/用户标识,可用于对账 |

依据:[对话补全 API 参考](https://docs.bigmodel.cn/api-reference/模型-api/对话补全.md)。

### 2.3 模型与定价(元/百万 token,标准 API,[官方价格页](https://docs.bigmodel.cn/cn/guide/start/pricing.md))

| 模型 | 输入 | 输出 | 上下文 | 缓存命中价 | 备注 |
| --- | --- | --- | --- | --- | --- |
| GLM-5.3 | 8 | 28 | 1M | 2 | 强制思考;reasoning_effort 仅 low/high/max |
| GLM-5.3-Flash | 0.8 | 2.8 | 1M | 0.23 | 混合思考,强制 |
| GLM-5.3-FlashX | 2 | 7 | 1M | 0.57 | |
| GLM-5.2 | 8 | 28 | 1M | 2 | 思考可关 |
| GLM-5.1 | 6/8 | 24/28 | 1M | 1.3/2 | 以 32K 输入分档 |
| GLM-5 | 4/6 | 18/22 | — | 1/1.5 | 32K 分档 |
| GLM-5-Turbo | 5/7 | 22/26 | — | 1.2/1.8 | 32K 分档 |
| GLM-4.7 | 2/3/4 | 8/14/16 | — | 0.4/0.6/0.8 | 输入 32K、输出 0.2K 双档 |
| GLM-4.7-Flash | 免费 | 免费 | 200K | 免费 | 开发调试可用 |
| GLM-4.5-Air | 0.8/1.2 | 2/8 | 128K | 0.16/0.24 | 分档 |

- Batch API 标准价 5 折;**缓存折扣与免费额度仅适用标准 API,Coding Plan/资源包不适用**。
- GLM-5(2026-02 开源旗舰)为 744B/40B MoE,窗口 200K,DSA 稀疏注意力;GLM-5.2 起带 1M 窗口(来源:智谱发布材料与模型页,窗口数已与价格表互证)。

### 2.4 工具调用([官方指南](https://docs.bigmodel.cn/cn/guide/capabilities/function-calling.md))

- 请求:`tools: [{ type: "function", function: { name, description, parameters(JSON Schema) } }]`;`tool_choice: "auto"`。
- 响应:`choices[0].message.tool_calls[]`,含 `id`、`function.name`、`function.arguments`(JSON 字符串,需 `JSON.parse`);**命中工具时 `content` 为 null**。
- 回传:assistant 消息(含 tool_calls)原样入历史,然后每个调用对应一条 `{ role: "tool", tool_call_id, content: JSON.stringify(result) }`,再发起下一轮请求。
- 官方安全建议:输入校验、权限控制、错误以 `{ success, error, error_code }` 结构回传——与 WWriting 权限分级(铁律 4)天然契合。
- 是否支持 `parallel_tool_calls` 参数:官方文档未列,**未确认**;但流式增量按 `index` 分组说明一轮可返回多个 tool_calls。

### 2.5 流式与 tool_stream([官方指南](https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool.md))

- `stream: true` → `text/event-stream`,`data: [DONE]` 结束;每个 chunk 为 ChatCompletionChunk,`choices[].delta` 增量字段:`content`、`role`、`reasoning_content`、`tool_calls`。
- **`tool_stream` 默认 false**:不开时工具调用参数不随流分片(相当于流式中一次性给出);要 OpenAI 式增量拼接必须显式 `tool_stream: true`。
- delta.tool_calls 拼接规则:`index` 分组;`id` / `function.name` 只出现在首片;`function.arguments` 逐片追加(`+=`);流结束后拼接结果应为完整 JSON。
- chunk 内也含 `usage` 与 `content_filter`(role/level 0–3);**usage 统计在最后一个 chunk 返回**。

### 2.6 thinking / 深度思考([官方指南](https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md))

- `thinking: { type: "enabled" | "disabled" }`;GLM-4.5 及以上支持。行为差异:GLM-5.2/5.1/5/4.6/4.5 为「模型自动判断是否思考」,GLM-5.3/5.3-FLASH/4.7 为「强制思考」,且 **GLM-5.3 系列传 `disabled` 直接报错**。
- 思考文本位置:非流式 `message.reasoning_content`,流式 `delta.reasoning_content` **先于** `delta.content` 输出;思考 token 计入 `completion_tokens` 计费。
- `clear_thinking`(默认 true):多轮时自动清除历史 reasoning_content,防止 CoT 膨胀上下文(与 DeepSeek「禁止回传 reasoning_content」殊途同归,GLM 是自动清)。
- `reasoning_effort`(GLM-5.2+):`max/xhigh/high/medium/low/minimal/none`;GLM-5.3 系列仅接受 `max/high/low`,其余报错(Coding Plan 下会映射不报错)。

### 2.7 上下文缓存(隐式,[官方指南](https://docs.bigmodel.cn/cn/guide/capabilities/cache.md))

- **全自动隐式缓存**,无需任何参数;要求请求间前缀**完全一致**,官方建议稳定前缀 ≥ 500 token(两三句话的短 system 命中不了)。
- 异步生效:首个请求建立缓存(`cached_tokens: 0`),稍候的后续请求才可能命中——冷启动轮吃不到缓存。
- 计费:命中部分约 **5 折**,新内容标准价;`usage.prompt_tokens_details.cached_tokens` 查看命中量(示例:prompt 1075 中 1024 命中)。
- 布局最佳实践:稳定知识(规范/设定)放 system 前部,多变内容放 user 消息——小说 CLI 把 `WWRITING.md` 与写作规范放 system 正合适。

### 2.8 与 OpenAI SDK 的兼容细节与坑清单

1. `tool_choice` 仅 `auto`:无法强制调工具,「必须调用工具」的语义只能靠 prompt 约束。
2. `tool_stream` 默认 false,与 OpenAI 流式工具调用默认分片的行为不同。
3. `finish_reason` 自有取值:`sensitive`(内容安全拦截)、`network_error`(推理异常)、`model_context_window_exceeded`(超窗口);openai 包的 TS 类型不含这些字符串,需按宽类型处理。
4. 工具调用轮 `content` 为 null,文本拼接逻辑要判空。
5. `temperature` 上限 1.0(OpenAI 到 2.0)。
6. 错误体 `{ error: { code, message } }`;HTTP 200 表业务成功;具体错误码枚举未在本次抓取页面列出(官方有错误码文档,落地时补查)。
7. `reasoning_content` 不在 openai 包类型中,TS 下用模块扩充(module augmentation)或包装层收窄。
8. 隐式缓存异步生效,会话首轮必然全价。
9. 流式 usage 在最后一个 chunk,且 OpenAI 的 `stream_options: { include_usage: true }` 在 GLM 侧非必需(带不带都有;**未确认** GLM 对该参数的兼容行为)。

---

## 三、OpenAI 兼容生态的通用差异

- **base_url 约定**:OpenAI SDK 自动追加 `/chat/completions`,因此 baseURL 应以版本段结尾:智谱 `https://open.bigmodel.cn/api/paas/v4/`、DeepSeek `https://api.deepseek.com`(或 `/v1`)、Qwen(DashScope 兼容模式)`https://dashscope.aliyuncs.com/compatible-mode/v1`、Moonshot `https://api.moonshot.cn/v1`。
- **`reasoning_content` 是事实标准**(DeepSeek-R1 于 2025 带火,与 `content` 平级;流式为 `delta.reasoning_content`,先于正文输出)。OpenAI 官方走另一套(Responses API 的 reasoning 项)。中文系厂商(GLM、Qwen3 等)多跟 DeepSeek 约定。注意:[DeepSeek 明确禁止把 reasoning_content 回传进后续请求](https://api-docs.deepseek.com/guides/reasoning_model),GLM 用 `clear_thinking` 自动清——**适配层一律不要把该字段持久化进 messages**。
- **tool_call id 格式不一**:OpenAI 为 `call_<随机串>`,各家生成的 id 形态不同(有函数名加序号等)。铁则:**回传时原样使用模型给的 id,不自行构造**。
- **usage 字段**:prompt/completion/total_tokens 全家通用;OpenAI 附加 `prompt_tokens_details.cached_tokens`、`completion_tokens_details.reasoning_tokens`;GLM 有 `cached_tokens`;部分兼容端点流式缺 usage——成本累计要容错(缺省按 0 并标记「未计量」)。
- **`data: [DONE]` 是通用哨兵**,但个别实现可能漏发;解析器必须以「流关闭(读循环正常结束)」为最终信号,不能只等 [DONE]。
- **流式 tool_calls**:OpenAI 默认分片;GLM 需 `tool_stream: true`;更老的兼容端点甚至整块返回,拼接代码要兼容「单片即完整」的情况。

---

## 四、流式:SSE 协议与实现要点

### 4.1 SSE 协议要点(手写时;协议定义见 [MDN: Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events))

- 响应头 `Content-Type: text/event-stream`;事件以空行(`\n\n`)分帧;字段 `event:` / `data:` / `id:` / `retry:`;OpenAI 系全部为匿名事件,只看 `data:` 行;`data: [DONE]` 为哨兵;`: ` 开头为注释/心跳行,直接跳过。
- 解析要点:**跨 chunk 的半帧必须留在 buffer 里**(TCP 分片不保证按帧对齐),按 `\n\n` 切帧后逐帧提取 `data:` 再 `JSON.parse`。
- Node 侧两种读法:`res.body.getReader()` 手动循环,或 `for await (const chunk of res.body)`(ReadableStream 是 async iterable)。用 openai 包则全部内置。
- SSE 规范自带 `Last-Event-ID` 断线续传机制,但 LLM 服务商**均未实现流式续传**,不可依赖。

### 4.2 delta 拼接的常见坑

- tool_calls 增量按 **`index`** 对齐,不是按 id(id 可能只在首片出现,甚至为空);一轮多个并行工具调用靠 index 区分。
- `function.arguments` 是字符串分片,必须 `+=` 累加,不能覆盖;流结束才 `JSON.parse`。
- 首片可能只有 index 而无 id/name;有的实现首片 arguments 为空串 `""`,拼接时统一处理。
- 文本 `delta.content` 直接拼接;`delta.reasoning_content` 走独立通道(渲染到状态行/折叠区),**不进 messages**。
- usage:GLM 在最后一个 chunk 自带;OpenAI 需 `stream_options: { include_usage: true }`,此时最后一个 chunk 的 `choices` 为空数组、只含 usage——遍历代码要容忍空 choices。

### 4.3 断线与重试

- 主流兼容 API **不支持流式断点续传**:连接中断后已生成部分不可恢复,只能整请求重试(重新计费、重新生成)。SDK 的自动重试只覆盖「未收到响应头」的失败;**收到响应头后中途断流,SDK 不会自动重试**——应用层需检测「流提前关闭且未收到 finish_reason/[DONE]」,再决定报错或重发。
- 缓解手段:
  1. 稳定前缀(系统提示/项目设定)利于重试后吃缓存;
  2. 工具轮中间结果先落盘(journal),重试从最近一致状态恢复;
  3. OpenAI 官方 Responses API 有 `previous_response_id` 免重传历史(仅官方端点可用)。
- GLM 的 `request_id` 可用于对账;是否提供幂等语义:**未确认**。

### 4.4 AbortController 与「停止」(对应铁律 5)

- 标准姿势:`const ac = new AbortController(); fetch(url, { signal: ac.signal }); ac.abort()` 后正在 `read()` 的 Promise 以 AbortError reject。openai 包与 @anthropic-ai/sdk 均为请求级 `signal`/`abortSignal` 参数,内部对监听做弱引用共享。
- 计费语义:abort 发生在响应头之前 → 请求取消,基本无费用;**发生在流式中途 → 已生成 token 照常计费**,本地只拿到部分增量。
- 收敛流程(停止):`ac.abort()` → catch AbortError(区分正常结束)→ 停止状态行 → 拼接已收到的完整段落并标注「已中断」(对应「进行中的写入保持完整」)→ 清除本轮临时授权 → 记录 usage(如有)。**不杀进程、不丢已写文件。**
- 每轮创建新 AbortController;队列中等待的输入不占用 signal;由同一 abort 触发的本地工具任务也要接同一个 signal,避免「请求停了、工具还在写文件」。

### 4.5 背压

- LLM 流速(几十至数百 token/s)远低于终端渲染能力,CLI 场景通常无真实背压;但仍应按事件顺序 `await` 写出(渲染/写文件),避免无界缓冲;大响应落盘用流式写入而非全量攒内存。
- openai 包的 `Stream` 是 async iterable,天然逐事件消费;手写实现切忌 `res.text()` 一次性读完再处理。

---

## 五、工具调用规范:OpenAI vs Anthropic

| 维度 | OpenAI(Chat Completions) | Anthropic(Messages) |
| --- | --- | --- |
| 工具定义 | `tools[].function { name, description, parameters }` | `tools[] { name, description, input_schema }`,name 正则 `^[a-zA-Z0-9_-]{1,64}$` |
| 模型侧输出 | `message.tool_calls[] { id, function: { name, arguments: 字符串 } }` | `content[]` 中 `type: "tool_use" { id, name, input: 对象 }` |
| 结果回传 | `role: "tool"` 消息 + `tool_call_id` + `content`(字符串) | 下一条 **user** 消息里 `tool_result` block `{ tool_use_id, content, is_error }` |
| 强制/约束 | `tool_choice: "auto"|"none"|"required"|{ type:"function", function:{name} }` | `tool_choice: auto/any/tool/none`(`any`=必须用某工具) |
| 并行控制 | `parallel_tool_calls`(默认 true,置 false 关闭) | 默认并行;`disable_parallel_tool_use` 附加在 tool_choice 上 |
| schema 严格化 | `strict: true`(Structured Outputs);要求 `additionalProperties: false`、所有字段 required、根为 object | `strict: true`(strict tools;各家 beta 进度不一,**未确认**全面 GA) |
| 循环停止信号 | `finish_reason: "tool_calls"` | `stop_reason: "tool_use"`(另有 `pause_turn` 长任务暂停,需原样回传续跑) |
| 流式 | `delta.tool_calls[].index` + `function.arguments` 分片;新 Responses API 为 `function_call_arguments.delta` 事件 | `content_block_delta` 的 `input_json_delta.partial_json` 分片 |
| 计费 | 工具定义/结果均按普通 token 计 | 同左;工具轮的 tool_use/tool_result 全部占上下文 |

依据:[OpenAI Function Calling 指南](https://platform.openai.com/docs/guides/function-calling)、[Anthropic Implement tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use)。

- 通用铁律(两家一致):`arguments`/`input` 都是**模型生成的 JSON,必须 try/parse + schema 校验**;解析失败把错误文本作为工具结果回传让模型自纠,而不是抛异常终止循环。
- 错误回传:OpenAI 侧在 `role:"tool"` 的 content 里写错误 JSON;Anthropic 侧用 `is_error: true`;GLM 官方建议 `{ success:false, error, error_code }` 结构。
- 并行调用语义:一轮可能返回多个 tool_calls,**全部执行完再一次性回传**,不要逐个回传触发多轮。
- Anthropic 特有:context editing beta(`context-management-2025-06-27`,自动清除旧 tool_result)、1M 上下文 beta(`context-1m-2025-08-07`,Sonnet 4/4.5;Opus 4.5 需高用量等级)、tool runner beta 自带自动压缩与 `pause_turn` 处理。

---

## 六、Token 计数

- **js-tiktoken**:[npm](https://www.npmjs.com/package/js-tiktoken) 纯 JS 移植,当前 1.0.21(约一年未更新,但格式稳定),778 个依赖者;前身 `@dqbd/tiktoken`。API:`encodingForModel('gpt-4o')` / `getEncoding('o200k_base')` / `encode(text)`;`js-tiktoken/lite` 子包按需加载 ranks 减小体积。官方 Rust tiktoken 仅发 Python([openai/tiktoken](https://github.com/openai/tiktoken)),JS 生态事实标准就是 js-tiktoken。
- 各家 tokenizer 可得性:OpenAI 系有公开编码映射(o200k_base / cl100k_base);**Anthropic 未公开 tokenizer**,精确计数用 `client.messages.countTokens({ model, messages })`(@anthropic-ai/sdk 内置);**GLM 未公开 tokenizer**,js-tiktoken 结果仅供参考。
- GLM 估算:官方口径 **token:汉字 ≈ 1:1.6**,即 1 token ≈ 1.6 个汉字、1 汉字 ≈ 0.6 token;实际用量以返回 `usage` 为准([智谱平台介绍](https://docs.bigmodel.cn/cn/guide/start/introduction))。
- 中文经验值:o200k_base 约 **0.75–1 token/汉字**(比 cl100k 明显改善,大量 CJK 常用字已并入词表);cl100k_base 约 1–1.5+ token/汉字;Anthropic 约 1 token ≈ 0.7–0.8 汉字(**未确认**,官方无公开数据)。以上均为经验值,随文本风格浮动。
- 给 WWriting 的实用策略:
  - 预检(决定补写/收尾)用本地字符数 × 0.625(GLM 口径)做粗估,或 js-tiktoken 取上界;
  - 每轮结束用真实 `usage` 校准「本会话 token/字符比」,越到后面越准;
  - **count_text 返回的是字符数(客观字数),与 token 是两个语义**,界面与日志里分开呈现,不要混用。

---

## 七、上下文窗口管理

### 7.1 2026 年窗口现状

| 模型 | 窗口 | 备注 |
| --- | --- | --- |
| GLM-5.3 / 5.2 / 5.1 | 1M | 输出 `max_tokens` 上限 128K(131072) |
| GLM-4.7-Flash / FlashX | 200K | 免费档 |
| OpenAI GPT-4.1 / GPT-5.x / 4o | 1M / 400K / 128K | |
| Anthropic Sonnet/Opus | 200K 标准 | Sonnet 4/4.5 有 1M beta;Opus 4.5 1M beta 需 Tier 4 |
| Google Gemini 2.5 Pro | 1M–2M | |

- 窗口含输入 + 输出 + 思考 + 工具中间内容;超限直接报错(GLM 有专门的 `model_context_window_exceeded`)。

### 7.2 Prompt caching 三家机制对比

| | OpenAI([指南](https://platform.openai.com/docs/guides/prompt-caching)) | Anthropic([指南](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) | GLM(bigmodel) |
| --- | --- | --- | --- |
| 方式 | 全自动;≥1024 token 前缀精确匹配;可加 `prompt_cache_key` 提高命中(~15 req/min 溢出到其他缓存机) | **显式** `cache_control: {type:"ephemeral"}` 断点(整个请求 ≤4 个) | 全自动隐式,无需参数 |
| TTL | 内存 5–10 分钟,偶发 1 小时;gpt-5.x/4.1 支持 `prompt_cache_retention: "24h"` | 默认 5 分钟,可声明 `ttl:"1h"` | 未公开;异步生效 |
| 价格 | 命中输入最高约 **90% off**(随模型不同,早期模型 50–75%) | 写入 1.25x(5m)/ 2x(1h);**读取 0.1x** | 命中约 **5 折** |
| 最低门槛 | 1024 token | 1024 token(Sonnet/Opus),Haiku 2048 | 建议 ≥500 token |
| 观测字段 | `usage.prompt_tokens_details.cached_tokens` | `usage.cache_read_input_tokens` / `cache_creation_input_tokens` | `usage.prompt_tokens_details.cached_tokens` |

- 通用设计结论:稳定前缀(system/规范/设定)放最前,动态内容放后,**消息顺序不做无关重排**——三家都受益。

### 7.3 长对话压缩:主流 agent CLI 的做法

- **Claude Code**:Auto-compact 默认在约 **80%** 上下文用量处触发(官方 [model-config 文档](https://code.claude.com/docs/en/model-config) FAQ 口径),阈值可经 auto-compact window 调整;`/compact` 手动触发、`/autocompact` 打开设置;1M 窗口模型阈值绝对值外移。压缩 = 用一次单独的模型调用把历史总结成结构化摘要,后续会话以摘要开场([context-window 文档](https://code.claude.com/docs/en/context-window))。
- **Anthropic API 侧**:context editing beta 自动清理旧 tool_result + memory tool beta;tool runner beta 自带自动压缩。
- **策略归纳**:主流是「阈值触发摘要(auto-compact)」为主,辅以两种手段——①整段历史→结构化摘要;②旧 tool_result 替换为占位符(裁剪)。直接截断(丢旧消息)最简单但伤长程连续性,一般只作摘要失败的兜底。
- **WWriting 优势**:章节是文件、设定在 `WWRITING.md`,历史对话的大部分信息可从磁盘再取回。因此压缩可更激进:「读过某文件」的旧 tool_result 直接丢,只保留「写过/改过什么」的动作记录;摘要由 Flash 档模型生成控成本。

---

## 八、可靠性与成本

### 8.1 限流、重试与超时

- 429 处理:指数退避(基值 ~0.5–1s,×2 递增,上限 30–60s)+ 抖动(jitter);**尊重响应的 `Retry-After` 头**——openai / @anthropic-ai/sdk 均已内置。
- SDK 默认重试 2 次,仅对连接错误、408、409、429、≥500 生效;应用层需再包一层「轮次级」恢复逻辑:流中断(见 4.3)与工具轮失败由应用决定重试与恢复点,不依赖 SDK。
- 超时:两家 SDK 默认 10 分钟。写作场景「长输出 + 强制思考」可能逼近上限,建议显式放宽或完全用 AbortSignal 自控节奏。
- GLM 侧 HTTP 非 200 即请求失败;业务态错误(如内容安全)以 `finish_reason: sensitive` 形式出现在 200 响应内——重试逻辑必须区分「可重试的传输错误」与「不可重试的业务拦截」。

### 8.2 usage 字段解析

- 非流式:`response.usage`;流式:GLM 最后一个 chunk 自带,OpenAI 需 `stream_options: { include_usage: true }`(该 chunk `choices` 为空数组)。
- 核心字段:`prompt_tokens` / `completion_tokens` / `total_tokens`;明细:`prompt_tokens_details.cached_tokens`(OpenAI、GLM)、`completion_tokens_details.reasoning_tokens`(OpenAI)、`cache_read_input_tokens` / `cache_creation_input_tokens`(Anthropic)。GLM 深度思考输出计入 `completion_tokens`。
- 容错:兼容端点可能缺 usage 或流式不给——累计时按 0 处理并标记「未计量」,不要让成本统计抛错。

### 8.3 计价表获取与会话成本累计

- 单价来源:各家 pricing 页人工维护;社区机器可读源:[LiteLLM 的 model_prices_and_context_window.json](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)(覆盖主流模型含 GLM 系;更新及时度**未确认**,启动时应校验数据内的时间戳)。
- 会话级成本累计实现思路(对应铁律 8,数据只进应用私有目录):
  1. 单价表 `{ model: { input, output, cached_input, cache_write, cache_read } }`(元/百万 token),随应用内置 + 可选远程更新;
  2. 每轮收到 usage → 按「输入(含命中/未命中)/输出(含思考)/缓存」分类累加;
  3. 费用 = Σ(分类 token ÷ 1e6 × 对应单价);GLM 命中部分用 5 折价,OpenAI 用折扣价,Anthropic 读写分开算;
  4. 持久化为 JSONL 追加写(journal 同级目录):`{ ts, model, usage, cost, request_id }`;
  5. 会话汇总 = 重放 JSONL;断点恢复时重放 usage 记录即可还原累计值,无需额外状态。
- Coding Plan(订阅制)与按量计费口径不同:订阅下成本展示建议以 token 数为准,不折算金额。

---

## 九、对 WWriting CLI 的落地建议

### 9.1 SDK 选型:openai 包 + 自写 agent loop(推荐)

- **传输层用 `openai` npm 包**:`new OpenAI({ apiKey, baseURL: 'https://open.bigmodel.cn/api/paas/v4/' })`,白拿 SSE 解析、指数退避重试、10 分钟超时、AbortSignal、错误类型化;对 `reasoning_content` 与 GLM 特有 `finish_reason` 用 module augmentation 扩类型,或在 Provider 包装层收窄成自有类型。
- **agent loop 自写**(项目分区 agent/):`while` 循环 = 请求 → 流式消费(delta 渲染 + 拼接)→ 有 tool_calls?过权限分级后执行工具(铁律 4)→ 以 role:tool 回传 → 继续 : 到达终态退出。停止条件:finish_reason = stop / length / sensitive / 超窗;外加步数上限与累计 token 上限双保险(参考 AI SDK 的 stopWhen 思想,自己实现一个 20 行的 StopCondition 即可,不必引框架)。
- **不引入 Vercel AI SDK v7 作为核心**:主力单 provider(GLM)、TUI 需要逐 delta 驱动状态行与活动行(铁律 2)、权限确认点必须插在「工具执行前」——自写循环对这三点都是直配;若未来确需多 provider,`createOpenAICompatible` 是现成迁移路径,届时再评估。
- Anthropic 备选 provider:仅当接 Claude 时新增 `@anthropic-ai/sdk`,按第五章映射表写独立 AnthropicProvider;不要为了「以后可能用」提前引入。
- 手写 fetch + SSE 仅在极端定制(自定义代理/内核级流控)时考虑。

### 9.2 GLM 接入要点清单

- baseURL 以 `/` 结尾;`Authorization: Bearer <key>` 直用;Key 存本机配置文件,绝不写入创作目录(铁律 8)。
- 模型档位建议:写作主循环 **GLM-5.3**(1M 窗口、强制思考;日常 `reasoning_effort: high`,难点 `max`),或 **GLM-5.2**(思考可关,价格同 5.3 但更灵活);压缩/摘要等辅助任务用 **GLM-5.3-Flash**(0.8/2.8 元/百万);开发调试可用免费的 GLM-4.7-Flash。
- 流式请求固定带 `tool_stream: true`;`delta.reasoning_content` 驱动「思考中」状态行,**不写入 messages**(`clear_thinking` 默认已清)。
- `finish_reason` 全集处理:stop 正常收尾;tool_calls 进工具轮;length 提示续写或调大 max_tokens;sensitive 静默告知用户本轮被拦截(错误文案极简,详情折叠,铁律 3);model_context_window_exceeded 触发压缩;network_error 走重试。
- 缓存友好布局:`WWRITING.md` + 写作规范 + 项目设定摘要放 system 前部(稳定前缀 ≥500 token 才可能吃到 5 折),章节正文与工具结果放消息尾部;每轮不要打乱消息顺序。
- `count_text` 的客观字数在本地实现(纯字符统计,不调 API);上下文预算用 token 估算(第六章)。

### 9.3 停止 / 打断的实现(对应铁律 5)

- **停止**:每轮创建一个 AbortController;「停止」→ `controller.abort()` → catch AbortError(与正常流结束区分开)→ 收敛:保留已完整段落并标注「已中断」、清除本轮临时授权、记录已收到的 usage、状态行置终态。已落盘的写入保持完整,不杀进程。
- **打断(「立即」)**:abort 当前请求 + 把新输入从队列提升为下一轮的首条 user 消息;队列其余输入保持 FIFO;同一个 Agent 实例、同一个循环,绝不建第二个 Agent(铁律 5)。
- **竞态防护**:传给模型请求的 signal 同样传给本轮在执行的工具任务(尤其写文件类),abort 时一并取消或等待其干净收尾。
- 队列:运行中的输入 append 进 FIFO(原文 + 「排队」标签);每轮收敛后检查队头,有则立刻开下一轮。

### 9.4 Token 与成本方案

- 预检估算:本地字符数 × 0.625(GLM 官方 1:1.6 反推)或 js-tiktoken(o200k_base)取上界;**展示给用户的字数永远是 count_text 的字符数**,token 只用于预算判断。
- 结算:每轮 usage 分类累计(输入/输出/缓存命中/思考);单价表内置(第九章 8.3 结构)+ LiteLLM JSON 可选远程更新;JSONL 追加进应用私有目录(与 journal 同级,不进创作文件夹);会话汇总与断点恢复均靠重放 JSONL。
- 上下文管理:auto-compact 阈值建议 **0.8**(对齐 Claude Code);GLM-5.3 虽有 1M 窗口,仍建议叠加绝对量上限(如 200K 先触发)控制长会话成本;压缩 = 一次 Flash 调用生成结构化摘要 + 丢弃旧 tool_result(章节与设定都在磁盘,可随时重读);截断仅作兜底。

---

## 十、参考来源

1. [智谱对话补全 API 参考](https://docs.bigmodel.cn/api-reference/模型-api/对话补全.md)
2. [智谱 Function Calling 指南](https://docs.bigmodel.cn/cn/guide/capabilities/function-calling.md)
3. [智谱流式工具输出指南](https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool.md)
4. [智谱深度思考指南](https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md)
5. [智谱上下文缓存指南](https://docs.bigmodel.cn/cn/guide/capabilities/cache.md)
6. [智谱模型价格页](https://docs.bigmodel.cn/cn/guide/start/pricing.md)
7. [智谱平台介绍(token 换算口径)](https://docs.bigmodel.cn/cn/guide/start/introduction)
8. [智谱文档索引 llms.txt](https://docs.bigmodel.cn/llms.txt)
9. [Z.ai GLM API Quick Start(国际站端点与 openai npm 示例)](https://docs.z.ai/guides/overview/quick-start)
10. [openai(openai-node)GitHub](https://github.com/openai/openai-node)
11. [@anthropic-ai/sdk GitHub](https://github.com/anthropics/anthropic-sdk-typescript)
12. [Vercel AI SDK 文档:Introduction(v7)](https://ai-sdk.dev/docs/introduction)
13. [Vercel AI SDK 文档:Agent Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
14. [OpenAI Function Calling 指南](https://platform.openai.com/docs/guides/function-calling)
15. [OpenAI Prompt Caching 指南](https://platform.openai.com/docs/guides/prompt-caching)
16. [Anthropic Implement tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use)
17. [Anthropic Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
18. [Anthropic Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
19. [DeepSeek Thinking Mode(reasoning_content 约定)](https://api-docs.deepseek.com/guides/reasoning_model)
20. [js-tiktoken(npm)](https://www.npmjs.com/package/js-tiktoken)
21. [openai/tiktoken(官方分词器仓库)](https://github.com/openai/tiktoken)
22. [Claude Code model-config(auto-compact 阈值)](https://code.claude.com/docs/en/model-config)
23. [Claude Code context-window](https://code.claude.com/docs/en/context-window)
24. [MDN: Server-sent events(SSE 协议)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
25. [LiteLLM model_prices_and_context_window.json(社区计价表)](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
26. [THUDM/z-ai-sdk-typescript(智谱官方 TS SDK,未发布)](https://github.com/THUDM/z-ai-sdk-typescript)
27. [hyperknot 博客(AI SDK 包体积批评)](https://blog.hyperknot.com/)
