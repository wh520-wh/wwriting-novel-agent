# S1 真实 API 验证报告 — MiMo 续写实测

日期：2026-06-11
执行：Claude（用户提供 MiMo 测试 key）
方法：复制真实项目 `D:\aaaa111大学生1111`（READ-ONLY，原项目未动）到 `.demo_runs/s1-real-verify-mimo/`，配置真实价格三字段后用 `runProject` 续写第 9、10 章至全书完成。

## 一句话结论

S1 缓存修复在真实 MiMo prefix cache 上验证通过（同章命中率 14.8% → 71.2%），成本归因三维数据全部准确落盘；同时实测暴露并修复了一个计费 bug（cacheHitTokens 字段回退失效导致成本高估 14%、缓存节省恒为 0），并取证了跨章缓存断点这一下个优化靶点。

## 验证环境

| 项 | 值 |
|----|-----|
| 模型 | mimo-v2.5-pro（`https://api.xiaomimimo.com/v1`） |
| 价格 | 输入 3 元/M，缓存命中 0.025 元/M，输出 6 元/M（2026-05-27 官方永久降价后牌价） |
| 预算上限 | max_cost 20 元 / max_total_tokens 1M（防失控，未触发） |
| 冒烟 | `verify:provider-online` 通过，usage 含 `prompt_tokens_details.cached_tokens` |

## S1 验收逐条核对

| 验收标准 | 结果 |
|----------|------|
| 跑真实多章项目后能回答总花费/每章花费 | ✅ 3 次调用共 ¥0.0832（修复后口径）；第 9 章 ¥0.0461（2 次调用），第 10 章 ¥0.0371（1 次调用） |
| 缓存节省多少 | ⚠️→✅ 实测暴露 cacheSavedCost 恒 0 的 bug，已修复（`e935501`），回放确认节省 ¥0.0137 |
| 浪费在哪 | ✅ retries=0、refills=0、abandoned=0，本次跑零浪费 |
| 缓存前缀稳定 | ✅ 升级一次性 bump v8→v9 后全程 `stableChanged=false`，3 次调用版本不增长 |
| 预算熔断 | ✅ 上限配置生效且未误熔断（宽松上限下全书正常完成） |

## 缓存指标实测

| 指标 | Pre-S1 基线（真实 DeepSeek 8 章） | 本次（真实 MiMo 续写 2 章） |
|------|----------------------------------|------------------------------|
| cacheVersion | 8（每章 +1） | 9（升级一次性 bump 后稳定） |
| stableChanged | true（每章都变） | **false（全程）** |
| 命中率 | 14.8% | 冷启动 0% → 同章续写 **71.2%** → 跨章 10.2% |

### 升级语义修正（勘误 S1 交付报告）

S1 交付报告写"升级到 S1 代码后该项目缓存前缀将稳定在 v1"——**表述错误**。旧项目 cache_report 已有 v8 记录，且 S1 重排了 stable block 集合，升级后第一次调用必然检测到 stableHash 变化并 bump 到 v9，**此后稳定**。"v1"只适用于新建项目。判定标准应为"升级后只 bump 一次，随后不再增长"，本次实测符合。

### 新发现：跨章缓存断点（下个成本优化靶点）

命中率序列 `[0, 71.2%, 10.2%]` 的结构含义：

- 同章内 segment 续写：stable 前缀完整复用，命中 4096 token（71.2%）。
- 跨章调用：仅命中 512 token 固定头部（system_rules/goal/style 开头）。`project_memory`（章节记忆逐章追加）与 `chapter_plan`（新章计划）位于 prompt 中段且跨章必变，前缀缓存从该点断裂。
- 对每章仅 1-2 次调用的常态写作，跨章是主要调用模式——**当前缓存收益主要来自章内续写，跨章收益受限**。优化方向（留给后续阶段）：内容块按变化频率重排、project_memory 稳定化（只追加不重排）、低频块前置。

## 实测暴露并修复的 bug

**现象**：cost.json 中 `cachedTokens: 4608` 但 `cacheSavedCost: 0`；`estimatedCost: 0.096912` 精确等于无缓存折扣公式结果（高估 14%）。

**根因链**（[usage-report.mjs](../../../src/core/usage-report.mjs) ↔ [cost-tracker.mjs](../../../src/core/cost-tracker.mjs)）：

1. MiMo 只返回 `prompt_tokens_details.cached_tokens`，不提供 `prompt_cache_hit_tokens`（DeepSeek 专有字段）。
2. `normalizeUsageReport` 的 `firstNumber` 把缺失的 `cacheHitTokens` 规约为 **0**（而非 undefined）。
3. 下游 `estimateCost`/`cacheSavedCost` 的回退链 `cacheHitTokens ?? cachedTokens` 对 0 不生效（`0 ?? 4096` 仍是 0），缓存折扣永远算不上。
4. 命中率显示正确纯属侥幸：该处用的是 `||` 回退。

**为什么 mock 与 DeepSeek 测不出**：mock 不出缓存字段；DeepSeek 提供显式 hit 字段走主路径；既有测试用例同时传两个字段。只有"仅 cached_tokens"的 provider 才暴露——印证路线图"必须真实 API 验证"原则。

**修复**（commit `e935501`）：`normalizeUsageReport` 中 `cacheHitTokens` 回退链末尾加 `cachedTokens`，单点修复全下游；新增 3 条测试覆盖 MiMo 风格 usage 与显式字段优先级。453/453 测试通过，`verify:mvp` 通过。

**回放验证**（真实 3 次调用过修复后链路）：

| 字段 | 修复前落盘 | 修复后回放 |
|------|-----------|-----------|
| estimatedCost | ¥0.096912 | **¥0.083203**（−14.1%） |
| cacheSavedCost | 0 | **¥0.013709** |

## 低优先级备注

- `cacheMetricsAvailable` 判定偏宽松：adapter 展开产生值为 undefined 的 `cached_tokens` 键，`Object.hasOwn` 即判 true（首次调用无缓存字段时也标 available）。实害有限（命中率 0 事实上正确），记录待整。
- `chapters/1` 空目录在原项目即存在（非本次产生），疑似历史路径拼接残留，待排查来源。
- 本次每章调用数 1-2 次、输出 token 占比 53%（8295/15714 输入），输出是成本大头；叠加存量章节字数普遍超标（详见 S2 审计），字数上限控制兼具质量与成本双重价值。

## 与 S2 审计的交接

本次验证同时完成了 S2 审计任务的取证（存量 8 章 + 新跑 2 章），坏样本清单与缺口分析另行输出（S2 spec 的输入），核心类别：跨章事实矛盾（楼层/死亡时间）、章内标题错乱、时间线跳跃、字数超标、标志性细节跨角色复制、题材漂移、book_summary 写入链路缺失、chapter_memory 仅头尾摘录无语义摘要。
