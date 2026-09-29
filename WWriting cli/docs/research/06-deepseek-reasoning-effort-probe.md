# DeepSeek 思考强度与输出上限：官方适配记录

> 记录日期：2026-09-29　端点：`https://api.deepseek.com`　**未做真实端点实测**
> （用户决定：不花钱跑探针；按官方文档适配 + 本地测试钉死编码规则）。
> 这份文件是 `OFFICIAL_REASONING_CAPABILITIES` 与 `OFFICIAL_MODEL_LIMITS` 的出处。

## 官方「思考模式」文档的两张表（OpenAI 格式）

| | OpenAI 格式控制参数 |
|---|---|
| 思考模式开关 | `{"thinking": {"type": "enabled/disabled"}}` |
| 思考强度控制 | `{"reasoning_effort": "low/high/max"}`（**枚举不含 none**） |

（另有 Anthropic 格式 `{"output_config":{"effort":"low/high/max"}}` 与 Responses API 格式
`{"reasoning":{"effort":"none/low/high/max"}}`，后者 none 表示关闭思考。本项目用 OpenAI 格式。）

## 本项目据此的编码规则

- `none` → 只发 `thinking:{type:"disabled"}`，**不发** `reasoning_effort`（枚举里没有 none）。
- `low/high/max` → 双发 `reasoning_effort:<level>` + `thinking:{type:"enabled"}`。
- 四档是用户可见的档位词汇表；每个模型是否支持某一档由 `OFFICIAL_REASONING_CAPABILITIES` 决定。

## 上下文窗口与输出上限

| 模型 | contextWindow | maxOutputTokens |
|---|---|---|
| deepseek-v4-pro / deepseek-flash | 1 000 000 | 393 216（384K） |
| 其它官方 DeepSeek 模型 | 1 000 000 | 65 536（64K） |
| 非官方端点 / 未知模型 | 262 144（256K） | 65 536（64K） |

max_tokens 一律取该模型输出上限（「给足空间」）。

## 与官方文档可能不一致的地方（将来观测到就改这张表）

- 若某模型拒绝 `reasoning_effort`，或 `none` 档实际被忽略，改 `effort.mjs` 的表并在这里记一笔。
- **`max_tokens` 现在无条件下发**（P28「给足空间」）：每个请求都带 `max_tokens`，
  官方模型取上表的上限、非官方端点 / 未知模型取回落 **65,536**。改动前这个字段**不发**、
  由服务端默认兜底，所以 `base_url` 指向的网关模型若**真实输出上限低于 64K**（4K/8K 那类），
  现在会被 400 打回。`GET /models` 不返回能力信息、本地判不出上限，这是刻意接受的代价，
  记在 ADR-0009 的未决项里；将来的出路是给 `config.json` 加一个 `max_output_tokens`
  声明字段（与 `reasoning_effort_levels` 同一形状）。
- 这些数字会随时间窗漂移；本记录的价值是「我们在这一天按官方文档适配成了这样」。
