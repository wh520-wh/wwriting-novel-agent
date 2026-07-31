# Competitive Research: 小米 MiMo 缓存适配（WWriting 的 DeepSeek 缓存优化的姊妹平台）

- **日期**：2026-07-31
- **模式**：Rapid（单一功能决策：MiMo 缓存适配是否值得做、怎么做；4 个竞品 + 每竞品 ≥1 一手来源）
- **决策**：**值得做，且是比 DeepSeek 更划算的缓存优化对象**——MiMo 缓存机制与 DeepSeek 完全同构（隐式前缀缓存），但价格杠杆更大（120 倍 vs 50 倍价差），现有前缀稳定性工程零改造直接复用；唯一缺口是「MiMo 模式识别」与「价格表补全」。

## Scope and Evidence Limits

- 调研对象：小米 MiMo 开放平台（mimo.mi.com / api.xiaomimimo.com）的上下文缓存机制、价格、API 行为；对照 DeepSeek / Anthropic / OpenAI / 阿里云百炼四家的官方缓存文档。
- 网络通道：WebSearch 可用；Tavily 当月额度已耗尽，未参与本次调研；Anthropic/OpenAI 文档经 301 重定向后抓取成功。
- **未验证项（诚实声明）**：① MiMo 的 usage 响应字段名（`prompt_cache_hit_tokens` 是否存在）无官方 API reference 可直接确认——官方落地页与文档未公开字段级 JSON 示例，仅第三方文档（DeepInfra）列出「Cached input tokens」独立计费桶；② MiMo 缓存 TTL 精确值官方未公开，只由小米团队媒体披露「小时至天级」；③ 「实测命中率 93%」为小米团队自述（[E5] 媒体转述），非第三方独立测评；④ 全部为桌面调研，未用真实 MiMo key 实测，不构成安装、基准测试或生产验证。
- 既有调研复用：DeepSeek 缓存细节以本次抓取的官方 KV Cache 文档为准（[E6]），并复用同日 CodeWhale 调研报告（`docs/research/2026-07-31-codewhale-deepseek-cache.md`）与 WWriting M1 前缀测量（[E11]）。

## Executive Conclusion

**MiMo 是 WWriting 缓存优化最理想的第二平台，适配成本极低、收益杠杆最大**：

- 缓存机制与 DeepSeek 同构：**隐式（implicit）前缀缓存**，公共前缀完整匹配即命中，无需任何手动开关（[E1][E2][E6]）。WWriting 已落地的稳定前缀工程（STABLE_BLOCK_ORDER 物理前置 + L1 字节级防线 + L3 辅助调用确定性缓存）**对 MiMo 直接有效，零机制改造**（[E10][E11]）。
- **价格杠杆比 DeepSeek 更大**：MiMo-V2.5 命中 0.02 vs 未命中 1.00 元/M（50 倍）；MiMo-V2.5-Pro 命中 0.025 vs 3.00（**120 倍**，[E1]）。同样的前缀命中率下，MiMo-Pro 用户每百万 token 省 2.975 元，是 DeepSeek-Pro 用户（省 2.975…）同档——价差绝对值相同但倍率最高，且 MiMo 缓存 TTL 更长（媒体披露小时至天级，[E5]），跨章节命中窗口更大。
- **已发货适配的确认与缺口**：OFFICIAL_PRICING 已含 mimo-v2.5 与 mimo-v2.5-pro 且价格与官方完全一致（[E1][E10]）；L3 确定性缓存对 MiMo 生效的前提成立（MiMo 支持 temperature 参数，[E3][E4]，不在 isReasonerModel 名单，[E10]）。**缺口**：① `isDeepSeekMode` 只认 DeepSeek，MiMo 用户享受不到 D2 低命中率提示——而 MiMo 价差 120 倍、是最需要提示的人群（[E10]）；② 价格表缺新型号 `mimo-v2.5-pro-ultraspeed`（0.075/9/18，application-only beta，[E1]）；③ MiMo 的 usage 缓存字段未实测，L2 累计命中率在 MiMo 上是否显示正确待在线验证（[E12 缺口]）。
- **最强威胁（对适配的干扰项）**：MiMo 的 Token Plan 订阅制（token-plan-cn.xiaomimimo.com）是另一计费体系，缓存优化对按量付费用户才成立；若用户走订阅制，命中率优化不省钱（[E1 页内 Token Plan 说明]）。MiMo-V2 系列已于 2026-06-30 下线，勿为旧型号适配（[E1]）。

## Current Product Baseline

已发货（来源：WWriting 源码，[E10]）：

- `OFFICIAL_PRICING` 已收录 mimo-v2.5（1.00/2.00/0.02 元/M）与 mimo-v2.5-pro（3.00/6.00/0.025），`fillOfficialPricing` 自动补缺、不覆盖用户已填值。
- 稳定前缀工程：compileChapterPrompt 稳定块物理前置（system_rules/goal/audience/style/skill_instructions/source_summaries/outline），L1 写作入口字节级防线测试。
- L3 辅助调用确定性缓存：memory_extract/fact_check + temperature=0 注入 + LRU 256 + attempt 豁免；`isReasonerModel` 名单只含 DeepSeek thinking 系（deepseek-v4*/reasoner），**MiMo 不在名单 → 已自动享受 L3 缓存**。
- L2 成本面板「累计命中率」（token 加权、chat 排除）；D2 低命中率提示仅当 `isDeepSeekMode`（base_url 含 api.deepseek.com + 模型前缀 deepseek-）。
- M1 实测：跨章稳定前缀份额 10.2%、章内 66.6%（[E11]）。

假设（未验证）：MiMo usage 字段兼容 DeepSeek 风格 `prompt_cache_hit_tokens` 或 OpenAI 风格 `cached_tokens`——usage-report 已有双字段回退（[E10]），但 MiMo 实测未做（见 Research Limits）。

## Competitor Comparison

| 平台 | 类别 | 证据 | 借鉴（Lesson） | 不照搬（Do Not Copy） |
|---|---|---|---|---|
| 小米 MiMo（调研对象） | direct | [E1][E2][E3][E4][E5] | 隐式前缀缓存 + 120 倍价差 + 更长 TTL（媒体披露）→ 缓存优化的最高价值平台；temperature 支持 → L3 确定性缓存可直接覆盖 | 不承诺 93% 命中率（自述）；不做订阅制（Token Plan）专属适配 |
| DeepSeek（WWriting 已适配） | direct | [E6] | 同一隐式前缀机制（自动开启、前缀完整单元匹配、TTL 几小时到几天）→ MiMo 复用全部现有适配 | 其 reasoner 系不支持 temperature 的坑（MiMo 没有此坑，勿把 isReasonerModel 名单误扩到 MiMo） |
| Anthropic Claude | adjacent | [E7] | 显式 cache_control 断点 + 预热（max_tokens=0）是「主动管理缓存」的范式样板 | 显式断点机制与 MiMo/DeepSeek 隐式机制不互通，需独立适配层；5 分钟短 TTL 不适合写作循环的跨章复用 |
| OpenAI | adjacent | [E8] | 隐式缓存（≥1024 token 自动）+ cached_tokens 字段回退语义 | 30 分钟 TTL 对长时写作会话太短；不引入其显式模式复杂度 |
| 阿里云百炼（国产对照） | adjacent | [E9] | 显式 ephemeral cache_control 与隐式并存、命中 20% 计费 → 国内平台「缓存已成标配定价」 | 5 分钟显式 TTL 同 Anthropic，不适合写作场景 |

## Cross-Market Patterns

- **Table stakes（标配）**：国内主流平台（DeepSeek/MiMo/百炼）均已默认提供隐式前缀缓存并按「命中/未命中」分档计价（[E1][E6][E9]）；usage 缓存字段解析与命中折扣成本核算已是任何成本面板的底线能力（[E6][E8][E10]）。
- **Recognizable differentiators（WWriting 可展示）**：静态内容前置 + 前缀字节级稳定（各家官方文档一致建议：固定 prompt 放最前、避免前缀内插入变动内容，[E6][E7][E8]）——WWriting 的稳定前缀工程正好命中，且 M1 已测出量化基线（[E11]）；对 MiMo（120 倍价差）这个数字卖点比 DeepSeek 更强。
- **Adoption-blocking gaps（缺口）**：MiMo 用户没有低命中率提示（isDeepSeekMode 只认 DeepSeek）→ 前缀断裂时用户多付 120 倍且无任何提示；这是本轮最优先修的缺口（[E10]）。
- **Non-goals（明确不做）**：不做 MiMo 专属提示词改造（机制同构，复用现有前缀工程即可）；不做 MiMo 订阅制（Token Plan）计费适配；不承诺「MiMo 命中率 ≥93%」（那是平台自述，客户端可达值取决于前缀稳定性）；不做 Anthropic 显式 cache_control 注入（本轮，写作循环 TTL 不匹配，见 P2）。

## Prioritized Roadmap

### P0
- **R1：缓存折扣平台识别推广**——把 DeepSeek 专属的缓存感知推广为「缓存折扣平台」层：新增 `isCacheDiscountedPlatform`（或 isMiMoMode）判据（base_url 含 api.xiaomimimo.com / token-plan-*.xiaomimimo.com + 模型前缀 mimo-），D2 低命中率提示对 MiMo 用户生效（MiMo 价差 120 倍、最需要提示 [E1][E10]）。
  验收信号：单元测试覆盖 mimo 三态（官方 API / Token Plan / 非 MiMo）；`verify:app-shell` 断言 mimo base_url 配置下成本面板出现低命中率提示文案；DeepSeek 行为不回归。
- **R2：价格表补全新型号**——OFFICIAL_PRICING 增加 `mimo-v2.5-pro-ultraspeed`（0.075/9/18 元/M，application-only beta [E1]）；若用户配了该型号即自动补全（与既有 fill 逻辑一致，零额外机制）。
  验收信号：`tests/model-pricing.test.mjs` 新增用例断言 fillOfficialPricing 补全三字段；未收录模型仍不补填（负向不回归）。

### P1
- **R3：MiMo 缓存字段在线验证**——用真实 MiMo key 跑一轮「同前缀两次调用」，确认 usage 返回 `prompt_cache_hit_tokens`（DeepSeek 风格）还是 `cached_tokens`（OpenAI 风格）或两者皆无；据此确认 L2 累计命中率在 MiMo 上显示正确（[E6][E8][E10]）。
  验收信号：在线验证用例（如 `verify:chat-online` 的 mimo 变体）断言第二次调用 usage 含缓存命中字段且成本面板命中率非零；若字段缺失，记录为「MiMo 无命中率可观测」并回退 ×2% 折算（不造假数字）。

### P2
- **R4：显式缓存平台适配侦察（Anthropic 类）**——调研并设计 cache_control 显式断点注入（Anthropic 范式：断点放静止内容末尾、max_tokens=0 预热 [E7]），评估写作循环「章节内多次调用、跨章间隔长」下的 TTL 匹配性。本轮不做实现（5 分钟 TTL 与写作节奏不匹配的结论待验证）。
  验收信号：调研产出存档到 docs/research/，含「断点放置策略 + 预热时机」设计草案；若实测 TTL 确实过短则记录为不做项。

## Research Limits and Next Validation

- **MiMo usage 字段名未验证**：官方文档无字段级 API reference；DeepInfra 文档列为「Cached input tokens」第三计费桶（C 级，仅用于发现）。需真实调用验证（R3）。
- **MiMo 缓存 TTL 无官方精确值**：「小时至天级」出自小米团队媒体披露（[E5]，官方 presentation 的媒体转述，B 级）；按量付费模式下跨章间隔（分钟到小时）大概率在 TTL 内，但未实测。
- **93% 命中率为平台自述**：小米团队称「实测平均 93%、高频用户 >95%」[E5]——这是服务器侧前缀复用的可达上限，客户端实际命中率由前缀稳定性决定（WWriting M1 测得跨章 10.2%/章内 66.6%，[E11]）。
- **Tavily 不可用**：本月 keyless 额度耗尽，检索仅用 WebSearch；未能抓取 MiMo 官方 API reference 深层页（可能不存在公开页面）。
- **下一步 hands-on 验证（最重要的两个）**：① 真实 MiMo key 验证 usage 字段与 L2 面板（R3）；② 同章修订场景对比「前缀工程开/关」两轮的命中率与成本差（复用 R1 落地后现有 cache_report 数据），用真实数字支撑 README 卖点。
