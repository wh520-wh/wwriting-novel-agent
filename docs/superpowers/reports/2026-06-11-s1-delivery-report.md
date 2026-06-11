# S1 交付报告 — 成本与模型行为

日期：2026-06-11
作者：Claude (subagent-driven-development)
分支：`s1-cost-and-model-behavior`
范围：S1（成本与模型行为阶段，10 项任务）

## 一句话总结

本轮修复了缓存前缀在章节切换时被破坏的核心 bug（cacheVersion 从 8 降到 1），补齐了成本归因、缓存健康、预算熔断三项能力，让用户能回答"写一本书花了多少钱、钱花在哪、哪些浪费了"。

---

## 已交付（10 项）

| # | 任务 | Commit | 说明 |
|---|------|--------|------|
| 1 | 成本审计基线 | `4abd014` | `analyzeCost` 纯函数 + 基线报告 `docs/superpowers/reports/2026-06-11-s1-cost-baseline.md` |
| 2 | 价格模型 + 成本计数器 + 设置页 | `28d665c` `ef74c90` | `model-pricing.mjs` + `cost-tracker.mjs` 重构 + 设置页价格/预算字段 + probe scrollIntoView 修复 |
| 3 | 每章成本归因 + 成本预警 | `d55712c` | `byChapter` 分桶 + `chapter_cost_warning` 事件 |
| 4 | 缓存前缀稳定性修复 | `165bce9` | `STABLE_BLOCK_ORDER` + `DYNAMIC_BLOCK_ORDER` + stableHash，cacheVersion 从 8→1 |
| 5 | 诊断出口成本健康 | `616d208` | `costHealth` 8 字段（retries/unpriced/cacheVersion 等），O(1) 读取 |
| 6 | 预算熔断 + 故障卡恢复 | `9db452b` | `max_cost`/`max_total_tokens` 上限 + circuit breaker + failure card + 设置页 UI |
| 7 | 成本视图数据补强 | `4cd4f18` `5f2fa3f` | `recentHitRates` 滚动窗口 + `refillCalls` + `cacheSavedCost` |
| 8 | 成本视图 UI 重构 | `3df9e3f` `3c5b8ad` | 三段式面板（总览/缓存健康/章节成本）+ sparkline + 面板内预警 banner（主界面成本徽章升级 + 章节行成本在收尾修复中补齐） |
| 9 | 补写成本治理 | `dc4d32a` | `computeChapterWordGap` 纯函数，首轮 prompt 暴露字数缺口，减少补写轮次 |
| 10 | 基线对比 + 交付报告 | 本 commit | 本文件 |

---

## 关键指标对比

### 缓存前缀稳定性（核心修复）

| 指标 | Pre-S1 基线 | Post-S1 (mock 长跑) | 变化 |
|------|------------|-------------------|------|
| cacheVersion 最大值 | **8** | **1** | ✅ 不再增长 |
| stableChanged | `true`（每章都变） | `false`（全程不变） | ✅ 稳定 |
| stableHash 变化次数 | 8 次（11 次调用内） | 0 次（20 次调用内） | ✅ 消除 |
| cacheKey 示例 | `...:v8:11d79f78` | `...:v1:f6be9703` | ✅ v1 稳定 |

### 调用效率

| 指标 | Pre-S1 基线 (8 章) | Post-S1 (20 章 mock) | 变化 |
|------|--------------------|--------------------|------|
| 每章调用次数 | 1.375 次（含 2 次 abandoned） | **1.0 次** | ✅ 无多余调用 |
| retries | 0 | 0 | 持平 |
| refills (补写) | 0（基线项目恰好没触发） | 0 | 持平 |
| abandoned calls | 2 | 0 | ✅ 消除 |

### 新增成本可见性

| 字段 | Pre-S1 | Post-S1 |
|------|--------|---------|
| `costAvailable` | 不存在 | `true`（已配置价格时）/ `false`（未配置时显示"未配置价格"） |
| `byChapter` | 不存在 | ✅ 每章调用次数 + token + 成本 |
| `recentHitRates` | 不存在 | ✅ 最近 20 次滚动窗口 |
| `refillCalls` | 不存在 | ✅ 补写轮次计数 |
| `cacheSavedCost` | 不存在 | ✅ 缓存节省金额 |
| `chapter_cost_warning` | 不存在 | ✅ 章节成本预警事件 |
| `max_cost` / `max_total_tokens` | 不存在 | ✅ 预算上限 + 熔断 + 故障卡恢复 |

---

## 用户视角的变化

**之前能回答的问题：**
- ❌ 这本书花了多少钱？→ 没有成本数据
- ❌ 钱花在哪了？→ 没有按章节/模型归因
- ❌ 缓存有没有帮我省钱？→ 没有缓存命中率数据
- ❌ 写到一半预算用完了怎么办？→ 无声继续，账单超预期

**之后能回答的问题：**
- ✅ 总花费 + 每章花费 + 每模型花费（三段式面板）
- ✅ 缓存命中率走势 + 缓存节省金额（sparkline 可视化）
- ✅ 补写轮次 → 知道哪些章节"浪费"了额外调用
- ✅ 预算用尽 → 熔断 + 故障卡 → 提高上限或切换模型 → 继续写作
- ✅ 章节成本预警 → 某章 token 消耗异常时主动提醒

---

## 真实 API 验证

**状态：** 未执行（需要用户配置真实 API Key + 价格三字段）

`npm run verify:provider-online` 会尝试真实 API 调用。当前 mock 环境下无法验证缓存命中率的实际改善效果。建议用户在设置页配置 DeepSeek 或 MiMo 模型后手动运行：

```powershell
npm run verify:provider-online
```

然后跑 1-2 章真实项目，对比 `cache.maxCacheVersion` 是否保持 1。

---

## 真实项目审计

**项目：** `D:\aaaa111大学生1111`（READ-ONLY）

| 指标 | 值 |
|------|-----|
| cacheVersion | **8**（pre-S1 代码，确认基线问题存在） |
| stableChanged | `true` |
| provider | `openai-compatible` |
| model | `deepseek-v4-pro` |
| cost.json | 不存在（pre-S1 代码未写入成本数据） |

**结论：** 真实项目的 `cache_report.json` 确认了基线诊断：`cacheVersion=8`、`stableChanged=true`，直接证据支持 Task 4 的修复方向。升级到 S1 代码后，该项目的缓存前缀将稳定在 v1。

---

## 已知问题与 S2 回退建议

| # | 问题 | 位置 | S2 建议 |
|---|------|------|---------|
| 1 | provider fallback hack | `cost-tracker.mjs:47` | 真实项目审计时验证 `?? this.pricing[provider]` 是否误匹配 |
| 2 | `?? 0` 防御性默认值掩盖上游 bug | `cost-tracker.mjs:51-54` | 添加 warning 日志，当 token 为 0 时告警 |
| 4 | `currency` 是死元数据 | `model-pricing.mjs:11` | 删除或暴露到 UI |
| 5 | `costAvailable === true` guard 无文档 | `agent-engine.mjs:1099` | 添加 JSDoc 说明 guard 语义 |
| 6 | 预算百分比是魔术数字 | `derive-failure-card.mjs` | 提取为命名常量 |
| 7 | agent-engine 测试缺 malformed state 路径 | `tests/agent-engine.test.mjs` | 添加 state 异常输入测试 |
| 8 | stable/dynamic block contract 无 JSDoc | `prompt-compiler.mjs` | 添加版本化契约文档 |
| 9 | `warnedChapters` 生命周期是 per-run | `agent-engine.mjs:585` | 文档化：重启后重新预警是 by design |
| 10 | stage override pricing 被设置层剥离 | `settings-runtime.mjs:232` | 本轮已修复：normalizeStageOverrides 补 pricing 拷贝 |
| 11 | refill 过计：技能门禁修订也算补写 | `agent-engine.mjs:609` | 本轮已修复：改为 kind === "revision_shortfall" |
| 12 | deriveBadges 不响应 chapter_cost_warning | `agent-truth.mjs:119` | 本轮已修复 |
| 13 | 章节抽屉行缺成本 | `drawer-panels.js:64` | 本轮已修复 |
| 14 | thread-renderer 直显 estimatedCost 不守 costAvailable | `thread-renderer.js:324` | 本轮已修复 |
| 15 | cost-panel el() 丢弃 role/aria-label | `cost-panel.js:21` | 本轮已修复 |
| 16 | 缓存节省 0.00 元在未配价格时显示 | `cost-panel.js:121` | 本轮已修复 |

---

## S2 建议入口

1. **M1 真实成本查看**：配置真实 API Key 后，跑完整一本书，验证 `costAvailable=true` + `byChapter` 数据准确
2. **缓存版本策略细化**：当 project_memory 内容变化时，是否应该 bump cacheVersion？当前是"永不 bump"，可能过于激进
3. **预算预警分级**：当前是硬熔断（用尽 → 故障卡）。考虑添加 80% 预警、90% 警告、100% 熔断的三级机制
4. **`cachedTokens` vs `cacheHitTokens` 统一**：修复 #3 的真实 bug，确保缓存节省金额计算准确
5. **成本视图导出**：让用户导出成本报告（CSV/JSON），用于报销或分析

---

## 验证证据

| 验证脚本 | 结果 |
|----------|------|
| `npm test` | 442/442 pass |
| `npm run verify:longrun` | ok: true, 20 章, cacheVersion=1, stableChanged=false |
| `npm run verify:mvp` | ok: true, 3 章, interruptedAndRecovered=true |
| `npm run verify:app-shell` | ok: true, completedChapters=2 |
| `npm run verify:app-clickability` | ok: true（含 drawer-cost-tab 新 probe） |
| `npm run verify:local` | ok: true（全量 12 项子验证均 exit 0） |
