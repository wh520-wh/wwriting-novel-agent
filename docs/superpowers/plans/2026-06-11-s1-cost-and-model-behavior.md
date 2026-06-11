# S1「跑得省」成本与模型行为实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能回答"写这本书花了多少钱、钱花在哪、哪些是浪费"，并修复缓存前缀被每章破坏的问题，给预算加上金额/token 上限熔断。

**Architecture:** 三条线推进——① 取证：新建 `cost-audit` 模块从真实 `run_log.jsonl`/`cost.json`/`cache_report.json` 产出每章成本、重试、补写、缓存失效统计，先落基线报告；② 修复：价格表+成本诚实化（无价格时显示"未配置"而非 0）、每章成本归因、把每章都变的 `project_memory`/`chapter_plan` 从 stable 块移到 dynamic 块以保住前缀缓存；③ 控制：金额/token 预算熔断接入既有 blocked→故障卡→恢复链路。

**Tech Stack:** Node.js 24 内置 test runner、原生 ESM、现有 verify 脚本防线（`verify:app-shell`/`verify:app-clickability`/`verify:local`）。

**对应 spec:** `docs/superpowers/specs/2026-06-11-software-maturity-roadmap-v2-design.md` 的 S1 节。

**真实数据侦察结论（本计划事实依据，2026-06-11 取证于 `D:\aaaa111大学生1111`）：**

| # | 发现 | 证据 |
|---|------|------|
| 1 | 每次调用完整 usage 已在日志里（`model_usage_recorded.data.usage_report` 含 cacheHitRate/reasoningTokens/DeepSeek hit-miss），缺的是聚合与展示 | run_log.jsonl 实测 |
| 2 | 稳定前缀几乎每章被破坏：11 次调用 cacheVersion 升到 8；命中率首次 39.7% → 末次 14.8% | cache_report.json；根因在 `agent-engine.mjs:735-736` 把每章都变的 `project_memory`/`chapter_plan` 放进 stableBlocks |
| 3 | 成本恒为 0：无价格表，`estimateCost` 默认 0；`estimatedCost: null` 走兜底也是 0 | cost.json `estimatedCost: 0`；`cost-tracker.mjs:3-9` |
| 4 | provider 归因失真：byProvider 记 `openai-compatible` 而非真实供应商/模型 | cost.json；`model-client.mjs:99` 用 `modelConfig.provider` |
| 5 | 前端已预留金额预算钩子但后端不执行：`agent-truth.mjs:120` 读 `budget_config.max_cost`，`withBudgetDefaults` 只有调用次数 | `agent-engine.mjs:1107-1115` |
| 6 | 13 次 model_call_started 对 11 次 completed；model_retry 事件只进日志，无累计指标 | run_log.jsonl |

**Commit 策略：** 每个 Task 一个 commit，`git add` 只加该 Task 明确列出的文件，绝不 `git add -A`。

---

## 文件结构总览

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/core/cost-audit.mjs` | 纯函数：事件数组 + cost.json + cache_report.json → 每章成本/重试/补写/缓存健康审计结构 |
| `scripts/audit-cost.mjs` | 薄 CLI：读项目目录三个文件，调 cost-audit，打印 JSON 报告 |
| `src/core/model-pricing.mjs` | 价格归一化、按模型名解析价格、从 project 配置构建价格表 |
| `tests/cost-audit.test.mjs` | 审计统计单测（合成事件 fixture） |
| `tests/model-pricing.test.mjs` | 价格解析/校验单测 |
| `tests/cache-prefix-stability.test.mjs` | 跨章 stableHash 不变、cacheVersion 不升的回归 |
| `tests/budget-caps.test.mjs` | 金额/token 上限熔断 + 故障卡 + 恢复动作 |
| `docs/superpowers/reports/2026-06-11-s1-cost-baseline.md` | 真实项目审计基线（Task 1 产出） |
| `docs/superpowers/reports/2026-06-11-s1-delivery-report.md` | S1 交付报告（Task 8 产出） |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/core/cost-tracker.mjs` | estimateCost 缓存命中分价计费、无价格返回 null；record 增加 chapter/byModel/byChapter/unpricedCalls/costAvailable/retries；构造函数合并默认字段兼容旧 cost.json |
| `src/core/model-client.mjs` | record 透传 `metadata.chapterNo` |
| `src/core/agent-engine.mjs` | metadata 加 chapterNo；onRetry 调 costTracker.recordRetry；compileChapterPrompt 移 project_memory/chapter_plan 到 dynamic、current_task 加字数缺口字段；consumeModelCallBudget 加金额/token 熔断；createModelRuntime 构建价格表 |
| `src/core/prompt-compiler.mjs` | STABLE/DYNAMIC_BLOCK_ORDER 调整 |
| `src/core/settings-runtime.mjs` | budget_config 接受 max_cost/max_total_tokens；active_model.pricing 校验；同步白名单扩展 |
| `src/core/derive-failure-card.mjs` | cost/token 预算卡分类、动作、文案 |
| `src/core/failure-actions.mjs` | raise-cost-budget / raise-token-budget 副作用 |
| `src/shared/failure-commands.mjs` | 注册两个新命令 |
| `src/core/project-diagnostics.mjs` | costHealth 数据出口（O(1) 读，不扫全日志） |
| `src/core/app-dashboard.mjs` | summary 加 costAvailable |
| `src/app-shell/agent-truth.mjs` | spentCost 尊重 costAvailable |
| `src/app-shell/components/activity-strip.js` | cost 槽位空值守卫 |
| `src/app-shell/drawer-panels.js` | 成本面板：未配置价格提示、每章成本表、重试/缓存健康行 |
| `src/app-shell/settings-modal.js` | 价格三字段 + 金额/token 上限两字段 |
| `scripts/verify-app-clickability.cjs` | 播种成本预算故障卡 + 新设置控件点击路径 |
| `tests/cost-tracker.test.mjs` | 适配新语义（null 价格、costAvailable、byChapter） |
| `tests/model-gateway.test.mjs` | block order 断言按新契约更新（设计变更，非绕测试） |
| `tests/derive-failure-card.test.mjs` / `tests/failure-actions.test.mjs` | 新卡/新命令用例 |

---

## Task 1: 成本审计模块 + CLI + 真实基线报告

**Files:**
- Create: `src/core/cost-audit.mjs`
- Create: `scripts/audit-cost.mjs`
- Create: `tests/cost-audit.test.mjs`
- Create: `docs/superpowers/reports/2026-06-11-s1-cost-baseline.md`

- [ ] **Step 1: 写失败测试**

```js
// tests/cost-audit.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCost } from "../src/core/cost-audit.mjs";

function usageEvent(chapter, { input, output, cached, hitRate }) {
  return {
    type: "model_usage_recorded",
    chapter_no: chapter,
    stage: "drafting",
    data: {
      usage_report: {
        provider: "openai-compatible",
        model: "deepseek-v4-pro",
        inputTokens: input,
        outputTokens: output,
        cachedTokens: cached,
        cacheHitTokens: cached,
        cacheMetricsAvailable: true,
        cacheHitRate: hitRate
      }
    }
  };
}

const events = [
  { type: "model_call_started", chapter_no: 1 },
  usageEvent(1, { input: 1000, output: 2000, cached: 400, hitRate: 0.4 }),
  { type: "model_retry", data: { reason: "timeout", model: "deepseek-v4-pro" } },
  { type: "model_call_started", chapter_no: 1 },
  usageEvent(1, { input: 1200, output: 1800, cached: 100, hitRate: 0.083 }),
  { type: "quality_gate_failed", chapter_no: 1, message: "word-count gate failed", data: {} },
  { type: "model_call_started", chapter_no: 2 },
  usageEvent(2, { input: 1500, output: 2500, cached: 0, hitRate: 0 }),
  { type: "model_call_started", chapter_no: 2 }
];

test("analyzeCost 按章聚合 token 与调用次数", () => {
  const report = analyzeCost({ events });
  assert.equal(report.byChapter["1"].calls, 2);
  assert.equal(report.byChapter["1"].inputTokens, 2200);
  assert.equal(report.byChapter["1"].outputTokens, 3800);
  assert.equal(report.byChapter["2"].calls, 1);
});

test("analyzeCost 统计重试、未完成调用与补写门禁", () => {
  const report = analyzeCost({ events });
  assert.equal(report.calls.started, 4);
  assert.equal(report.calls.completed, 3);
  assert.equal(report.calls.abandoned, 1);
  assert.equal(report.retries.count, 1);
  assert.equal(report.retries.byReason.timeout, 1);
  assert.equal(report.refills.gateFailures, 1);
  assert.equal(report.refills.byChapter["1"], 1);
});

test("analyzeCost 汇总缓存命中率与版本变化", () => {
  const report = analyzeCost({
    events,
    cacheReport: {
      entries: { "p:drafting.v1": { cacheVersion: 8 } },
      last_call: { cacheHitRate: 0.083, stableChanged: true }
    }
  });
  assert.equal(report.cache.samples.length, 3);
  assert.ok(Math.abs(report.cache.averageHitRate - (0.4 + 0.083 + 0) / 3) < 1e-9);
  assert.equal(report.cache.maxCacheVersion, 8);
  assert.equal(report.cache.lastStableChanged, true);
});

test("analyzeCost 容忍缺失输入", () => {
  const report = analyzeCost({});
  assert.equal(report.calls.started, 0);
  assert.deepEqual(report.byChapter, {});
  assert.equal(report.cache.maxCacheVersion, null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/cost-audit.test.mjs`
Expected: FAIL，`Cannot find module .../cost-audit.mjs`

- [ ] **Step 3: 最小实现**

```js
// src/core/cost-audit.mjs
export function analyzeCost({ events = [], costSummary = null, cacheReport = null } = {}) {
  const calls = { started: 0, completed: 0, abandoned: 0 };
  const retries = { count: 0, byReason: {} };
  const byChapter = {};
  const refills = { gateFailures: 0, byChapter: {} };
  const samples = [];

  for (const event of events) {
    if (event.type === "model_call_started") calls.started += 1;
    if (event.type === "model_retry") {
      retries.count += 1;
      const reason = event.data?.reason ?? "unknown";
      retries.byReason[reason] = (retries.byReason[reason] ?? 0) + 1;
    }
    if (event.type === "quality_gate_failed" && event.message === "word-count gate failed") {
      refills.gateFailures += 1;
      const key = String(event.chapter_no ?? "unknown");
      refills.byChapter[key] = (refills.byChapter[key] ?? 0) + 1;
    }
    if (event.type === "model_usage_recorded") {
      calls.completed += 1;
      const usage = event.data?.usage_report ?? {};
      const key = String(event.chapter_no ?? "unknown");
      byChapter[key] ??= { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
      byChapter[key].calls += 1;
      byChapter[key].inputTokens += usage.inputTokens ?? 0;
      byChapter[key].outputTokens += usage.outputTokens ?? 0;
      byChapter[key].cachedTokens += usage.cachedTokens ?? 0;
      byChapter[key].reasoningTokens += usage.reasoningTokens ?? 0;
      if (typeof usage.cacheHitRate === "number") samples.push(usage.cacheHitRate);
    }
  }
  calls.abandoned = Math.max(0, calls.started - calls.completed);

  const versions = Object.values(cacheReport?.entries ?? {})
    .map((entry) => entry.cacheVersion)
    .filter((v) => Number.isFinite(v));
  return {
    calls,
    retries,
    byChapter,
    refills,
    cache: {
      samples,
      averageHitRate: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null,
      maxCacheVersion: versions.length ? Math.max(...versions) : null,
      lastStableChanged: cacheReport?.last_call?.stableChanged ?? null
    },
    costSummary
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/cost-audit.test.mjs`
Expected: PASS 全绿

- [ ] **Step 5: 写 CLI**

```js
// scripts/audit-cost.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { analyzeCost } from "../src/core/cost-audit.mjs";

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error("用法: node scripts/audit-cost.mjs <项目目录>");
  process.exit(1);
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

const logText = await readFile(path.join(projectRoot, "run_log.jsonl"), "utf8").catch(() => "");
const events = logText
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const costSummary = await readJsonOrNull(path.join(projectRoot, "cost.json"));
const cacheReport = await readJsonOrNull(path.join(projectRoot, "cache_report.json"));

const report = analyzeCost({ events, costSummary, cacheReport });
console.log(JSON.stringify(report, null, 2));
```

`package.json` scripts 增加一行（放在 `"verify:app-shell"` 之后）：

```json
"audit:cost": "node scripts/audit-cost.mjs"
```

- [ ] **Step 6: 对真实项目跑基线并落报告**

Run: `npm run audit:cost -- "D:\aaaa111大学生1111"`
Expected: 输出 JSON；calls.started=13、completed=11、cache.maxCacheVersion=8 与侦察一致。

把输出整理进 `docs/superpowers/reports/2026-06-11-s1-cost-baseline.md`：原始 JSON + 三句结论（每章平均调用与 token、缓存命中率序列与 cacheVersion 证明前缀失效、重试与补写次数）。该报告是 Task 4/7/8 的对照基线。

- [ ] **Step 7: 全量回归 + Commit**

Run: `npm test`
Expected: 全绿（纯新增，不应影响既有 329+ 项）

```powershell
git add src/core/cost-audit.mjs scripts/audit-cost.mjs tests/cost-audit.test.mjs package.json docs/superpowers/reports/2026-06-11-s1-cost-baseline.md
git commit -m "feat(cost-audit): per-chapter/retry/refill/cache audit module, CLI and real-project baseline"
```

---

## Task 2: 价格表与成本诚实化

**Files:**
- Create: `src/core/model-pricing.mjs`
- Create: `tests/model-pricing.test.mjs`
- Modify: `src/core/cost-tracker.mjs`
- Modify: `tests/cost-tracker.test.mjs`
- Modify: `src/core/settings-runtime.mjs`
- Modify: `src/core/agent-engine.mjs:543-547`（createModelRuntime）
- Modify: `src/core/app-dashboard.mjs:95`
- Modify: `src/app-shell/settings-modal.js:133-145,369-377`
- Modify: `src/app-shell/agent-truth.mjs:96`
- Modify: `src/app-shell/components/activity-strip.js:33`
- Modify: `src/app-shell/drawer-panels.js`（两处 `估算成本`）

**设计要点：** 价格不硬编码进代码（模型价格随供应商变化，写死必然过期）。价格作为用户配置存在 `active_model.pricing`，设置页填写；没填价格时成本显示"未配置价格"，绝不显示 0——这是 spec 的诚实化原则。

- [ ] **Step 1: 写 model-pricing 失败测试**

```js
// tests/model-pricing.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { buildPricingTable, normalizePricing, resolvePricing } from "../src/core/model-pricing.mjs";

test("normalizePricing 接受正数价格并保留币种", () => {
  const p = normalizePricing({ input_per_million: 2, output_per_million: 8, cache_hit_per_million: 0.5 });
  assert.deepEqual(p, { input_per_million: 2, output_per_million: 8, cache_hit_per_million: 0.5, currency: "CNY" });
});

test("normalizePricing 拒绝缺输入/输出价或非正数", () => {
  assert.equal(normalizePricing({ input_per_million: 2 }), null);
  assert.equal(normalizePricing({ input_per_million: -1, output_per_million: 8 }), null);
  assert.equal(normalizePricing(null), null);
});

test("resolvePricing 精确匹配优先，其次最长前缀", () => {
  const table = {
    "deepseek-v4": { input_per_million: 1, output_per_million: 2, currency: "CNY" },
    "deepseek-v4-pro": { input_per_million: 3, output_per_million: 6, currency: "CNY" }
  };
  assert.equal(resolvePricing("deepseek-v4-pro", table).input_per_million, 3);
  assert.equal(resolvePricing("deepseek-v4-pro-max", table).input_per_million, 3);
  assert.equal(resolvePricing("mimo-v2.5", table), null);
});

test("buildPricingTable 从 active_model 与启用的 stage_overrides 取价", () => {
  const table = buildPricingTable({
    active_model: { model_name: "mimo-v2.5-pro", pricing: { input_per_million: 1, output_per_million: 4 } },
    stage_overrides: {
      outline: { enabled: true, model_name: "deepseek-chat", pricing: { input_per_million: 2, output_per_million: 8 } },
      reviewing: { enabled: false, model_name: "x", pricing: { input_per_million: 9, output_per_million: 9 } }
    }
  });
  assert.ok(table["mimo-v2.5-pro"]);
  assert.ok(table["deepseek-chat"]);
  assert.equal(table["x"], undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/model-pricing.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 model-pricing**

```js
// src/core/model-pricing.mjs
function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizePricing(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = positiveNumber(raw.input_per_million);
  const output = positiveNumber(raw.output_per_million);
  if (input === null || output === null) return null;
  const normalized = { input_per_million: input, output_per_million: output, currency: raw.currency ?? "CNY" };
  const cacheHit = positiveNumber(raw.cache_hit_per_million);
  if (cacheHit !== null) normalized.cache_hit_per_million = cacheHit;
  return normalized;
}

export function resolvePricing(modelName, table = {}) {
  if (!modelName) return null;
  if (table[modelName]) return table[modelName];
  let best = null;
  for (const key of Object.keys(table)) {
    if (modelName.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : null;
}

export function buildPricingTable(project = {}) {
  const table = {};
  const candidates = [project.active_model, ...Object.values(project.stage_overrides ?? {}).filter((o) => o?.enabled === true)];
  for (const model of candidates) {
    const pricing = normalizePricing(model?.pricing);
    if (model?.model_name && pricing) table[model.model_name] = pricing;
  }
  return table;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/model-pricing.test.mjs`
Expected: PASS

- [ ] **Step 5: 改 cost-tracker 测试（先红）**

`tests/cost-tracker.test.mjs` 改三处既有断言并加新用例：

```js
// 替换原 "estimateCost defaults pricing to 0 when missing"
test("estimateCost 没有价格表时返回 null 而不是 0", () => {
  assert.equal(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), null);
});

// 替换原 "CostTracker defaults unknown provider pricing to 0"
test("CostTracker 未配置价格时累计 unpricedCalls 且 costAvailable=false", () => {
  const tracker = new CostTracker({ pricing: {} });
  tracker.record({
    stage: "s",
    usageReport: { provider: "p", model: "unknown-model", inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000, cachedTokens: 0 }
  });
  const s = tracker.getSummary();
  assert.equal(s.estimatedCost, 0);
  assert.equal(s.unpricedCalls, 1);
  assert.equal(s.costAvailable, false);
});

// 新增
test("estimateCost 缓存命中按 cache_hit 价计费", () => {
  const cost = estimateCost(
    { inputTokens: 1_000_000, outputTokens: 0, cacheHitTokens: 400_000 },
    { input_per_million: 2, output_per_million: 8, cache_hit_per_million: 0.5 }
  );
  // 60 万未命中 ×2/M + 40 万命中 ×0.5/M = 1.2 + 0.2 = 1.4
  assert.equal(cost, 1.4);
});

test("CostTracker 按模型名解析价格并记 byModel", () => {
  const tracker = new CostTracker({ pricing: { "deepseek-v4": { input_per_million: 2, output_per_million: 8, currency: "CNY" } } });
  tracker.record({
    stage: "drafting",
    usageReport: { provider: "openai-compatible", model: "deepseek-v4-pro", inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cachedTokens: 0 }
  });
  const s = tracker.getSummary();
  assert.equal(s.estimatedCost, 2);
  assert.equal(s.costAvailable, true);
  assert.equal(s.byModel["deepseek-v4-pro"].calls, 1);
});

test("CostTracker 兼容缺新字段的旧 cost.json", () => {
  const tracker = new CostTracker({ summary: { calls: 5, inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, estimatedCost: 0, byProvider: {}, byStage: {} } });
  const s = tracker.getSummary();
  assert.equal(s.unpricedCalls, 0);
  assert.deepEqual(s.byModel, {});
  assert.deepEqual(s.byChapter, {});
});

test("CostTracker.recordRetry 累计 retries", () => {
  const tracker = new CostTracker();
  tracker.recordRetry();
  tracker.recordRetry();
  assert.equal(tracker.getSummary().retries, 2);
});
```

注意：原 "record accumulates" / "groups by provider and stage" 等用例的 usageReport 没有 `estimatedCost` 且无价格 → 现在 estimatedCost 保持 0、unpricedCalls 增加，原断言 `s.estimatedCost > 0` 的那条（第 58-75 行的 openai 定价用例）pricing key 从 `openai`（provider）改为按模型名匹配仍能命中 provider 兜底，断言不变。

Run: `node --test tests/cost-tracker.test.mjs`
Expected: FAIL（新语义未实现）

- [ ] **Step 6: 实现 cost-tracker 新语义**

```js
// src/core/cost-tracker.mjs 全文替换
import { safeJoin, writeJsonAtomic } from "./fs-utils.mjs";
import { resolvePricing } from "./model-pricing.mjs";

export function estimateCost(usageReport, pricing = null) {
  if (!pricing) return null;
  const input = usageReport.inputTokens ?? 0;
  const output = usageReport.outputTokens ?? 0;
  const cacheHit = Math.min(usageReport.cacheHitTokens ?? usageReport.cachedTokens ?? 0, input);
  const inputPerMillion = pricing.input_per_million ?? 0;
  const outputPerMillion = pricing.output_per_million ?? 0;
  const cacheHitPerMillion = pricing.cache_hit_per_million ?? inputPerMillion;
  const cost =
    ((input - cacheHit) / 1_000_000) * inputPerMillion +
    (cacheHit / 1_000_000) * cacheHitPerMillion +
    (output / 1_000_000) * outputPerMillion;
  return Number(cost.toFixed(8));
}

const SUMMARY_DEFAULTS = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  estimatedCost: 0,
  pricedCalls: 0,
  unpricedCalls: 0,
  costAvailable: false,
  retries: 0,
  byProvider: {},
  byModel: {},
  byStage: {},
  byChapter: {}
};

export class CostTracker {
  constructor({ pricing = {}, summary = null } = {}) {
    this.pricing = pricing;
    this.summary = { ...structuredClone(SUMMARY_DEFAULTS), ...(summary ?? {}) };
    this.summary.byModel ??= {};
    this.summary.byChapter ??= {};
  }

  record({ stage = "unknown", chapter = null, usageReport }) {
    const provider = usageReport.provider ?? "unknown";
    const model = usageReport.model ?? "unknown";
    const pricing = resolvePricing(model, this.pricing) ?? this.pricing[provider] ?? null;
    const cost = usageReport.estimatedCost ?? estimateCost(usageReport, pricing);
    const priced = cost != null;
    this.summary.calls += 1;
    this.summary.inputTokens += usageReport.inputTokens;
    this.summary.outputTokens += usageReport.outputTokens;
    this.summary.totalTokens += usageReport.totalTokens;
    this.summary.cachedTokens += usageReport.cachedTokens;
    if (priced) {
      this.summary.pricedCalls += 1;
      this.summary.estimatedCost = Number((this.summary.estimatedCost + cost).toFixed(8));
    } else {
      this.summary.unpricedCalls += 1;
    }
    this.summary.costAvailable = this.summary.unpricedCalls === 0 && this.summary.calls > 0;
    const bucketCost = priced ? cost : 0;
    addToBucket(this.summary.byProvider, provider, usageReport, bucketCost);
    addToBucket(this.summary.byModel, model, usageReport, bucketCost);
    addToBucket(this.summary.byStage, stage, usageReport, bucketCost);
    if (chapter != null) {
      addToBucket(this.summary.byChapter, String(chapter), usageReport, bucketCost);
    }
    return this.getSummary();
  }

  recordRetry() {
    this.summary.retries += 1;
    return this.summary.retries;
  }

  getSummary() {
    return JSON.parse(JSON.stringify(this.summary));
  }

  async writeProjectReport(projectRoot) {
    return writeJsonAtomic(safeJoin(projectRoot, "cost.json"), this.getSummary());
  }
}

function addToBucket(buckets, key, usageReport, cost) {
  buckets[key] ??= {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    estimatedCost: 0
  };
  buckets[key].calls += 1;
  buckets[key].inputTokens += usageReport.inputTokens;
  buckets[key].outputTokens += usageReport.outputTokens;
  buckets[key].totalTokens += usageReport.totalTokens;
  buckets[key].cachedTokens += usageReport.cachedTokens;
  buckets[key].estimatedCost = Number((buckets[key].estimatedCost + cost).toFixed(8));
}
```

- [ ] **Step 7: 跑通 cost-tracker + 受影响测试**

Run: `node --test tests/cost-tracker.test.mjs tests/cost-double-count.test.mjs tests/model-gateway.test.mjs tests/model-client-retry.test.mjs`
Expected: PASS。若 model-gateway/cost-double-count 对 summary 形状有 deepEqual 断言，按新增字段（pricedCalls/unpricedCalls/costAvailable/retries/byModel/byChapter）更新期望对象——属于本设计的契约扩展，需在 commit message 注明。

- [ ] **Step 8: 接线 — 引擎构建价格表、设置校验、UI 诚实显示**

`src/core/agent-engine.mjs` 顶部 import 增加：

```js
import { buildPricingTable } from "./model-pricing.mjs";
```

`createModelRuntime`（543 行起）改两行：

```js
  const existingCost = await readJson(safeJoin(projectRoot, "cost.json"), null);
  const existingCacheReport = await readJson(safeJoin(projectRoot, "cache_report.json"), { entries: {} });
  const costTracker = options.costTracker ?? new CostTracker({ pricing: buildPricingTable(project), summary: existingCost });
```

并在 `onRetry` 回调（570 行起）`appendEvent` 之前加一行：

```js
        costTracker.recordRetry?.();
```

`src/core/settings-runtime.mjs`：在 `normalizeSettingsPatch` 中 `patch.active_model` 既有处理之后加 pricing 校验（import `normalizePricing` from `./model-pricing.mjs`）：

```js
  if (patch.active_model?.pricing !== undefined) {
    if (patch.active_model.pricing === null) {
      // 允许清除价格
    } else {
      const pricing = normalizePricing(patch.active_model.pricing);
      if (!pricing) {
        throw new SettingsValidationError("invalid_pricing", "价格必须是正数：每百万 token 的输入价和输出价必填，缓存命中价可选。");
      }
      normalized.active_model = { ...(normalized.active_model ?? patch.active_model), pricing };
    }
  }
```

`src/core/app-dashboard.mjs:95` 改为：

```js
      estimatedCost: cost?.estimatedCost ?? 0,
      costAvailable: cost?.costAvailable ?? false,
```

`src/app-shell/agent-truth.mjs:96` 改为：

```js
  const spentCost = summary.costAvailable ? (summary.estimatedCost ?? null) : null;
```

`src/app-shell/components/activity-strip.js:33-34` 加守卫：

```js
    if (activity.spentCost != null) {
      const costEl = appendSlot(root, 'cost', `￥${activity.spentCost.toFixed(2)}`);
      if (onClickCost) { costEl.style.cursor = 'pointer'; costEl.addEventListener('click', onClickCost); }
    }
```

`src/app-shell/drawer-panels.js` 两处 `appendKv(kv, "估算成本", formatMoney(summary.estimatedCost))` 改为：

```js
    appendKv(kv, "估算成本", summary.costAvailable ? formatMoney(summary.estimatedCost) : "未配置价格");
```

`src/app-shell/settings-modal.js`：`renderSettingsDetail` 中 `settingsFields.maxCalls` 一行之后加三个字段（值取自 `active.pricing`）：

```js
    const pricing = active.pricing ?? {};
    settingsFields.priceInput = settingField("输入价（元/百万 token）", "number", { value: pricing.input_per_million ?? "" });
    settingsFields.priceOutput = settingField("输出价（元/百万 token）", "number", { value: pricing.output_per_million ?? "" });
    settingsFields.priceCacheHit = settingField("缓存命中价（元/百万 token，可选）", "number", { value: pricing.cache_hit_per_million ?? "" });
    const priceHint = document.createElement("div");
    priceHint.className = "spd-hint";
    priceHint.textContent = "按供应商定价页填写。不填则成本显示为未配置价格，不会按 0 计算。";
```

把 `settingsFields.priceInput.field, settingsFields.priceOutput.field, settingsFields.priceCacheHit.field, priceHint` 插入 178-182 行的 `append(...)` 列表中 `settingsFields.maxCalls.field` 之前。`saveSettings` 的 `active_model: compactObject({...})` 内增加：

```js
          pricing: settingsFields.priceInput.input.value && settingsFields.priceOutput.input.value
            ? compactObject({
                input_per_million: Number(settingsFields.priceInput.input.value),
                output_per_million: Number(settingsFields.priceOutput.input.value),
                cache_hit_per_million: settingsFields.priceCacheHit.input.value ? Number(settingsFields.priceCacheHit.input.value) : undefined
              })
            : undefined,
```

- [ ] **Step 9: 回归验证**

Run: `npm test`
Expected: 全绿
Run: `npm run verify:app-shell`
Expected: `ok: true`
Run: `npm run verify:app-clickability`
Expected: `ok: true`（设置弹窗新字段不挡既有路径）

- [ ] **Step 10: Commit**

```powershell
git add src/core/model-pricing.mjs src/core/cost-tracker.mjs src/core/settings-runtime.mjs src/core/agent-engine.mjs src/core/app-dashboard.mjs src/app-shell/agent-truth.mjs src/app-shell/components/activity-strip.js src/app-shell/drawer-panels.js src/app-shell/settings-modal.js tests/model-pricing.test.mjs tests/cost-tracker.test.mjs
git commit -m "feat(pricing): user-configured model pricing, cache-hit aware cost, honest unpriced display"
```

---

## Task 3: 每章成本归因

**Files:**
- Modify: `src/core/model-client.mjs:105`
- Modify: `src/core/agent-engine.mjs:611-615`
- Modify: `src/app-shell/drawer-panels.js`（renderCostPanel）
- Test: `tests/cost-tracker.test.mjs`（byChapter 用例已在 Task 2 加）、`tests/agent-engine.test.mjs`

- [ ] **Step 1: 写失败测试（引擎透传 chapter）**

`tests/agent-engine.test.mjs` 的 `CapturingModelClient`（38 行起）已捕获 prompt；让它同时捕获 metadata，并加断言。`generate({ prompt, metadata })` 内加 `this.metadatas.push(metadata);`（constructor 加 `this.metadatas = [];`），找到使用 CapturingModelClient 的既有测试，在其末尾追加：

```js
  assert.ok(client.metadatas.every((m) => Number.isInteger(m.chapterNo) && m.chapterNo >= 1));
```

Run: `node --test tests/agent-engine.test.mjs`
Expected: FAIL（metadata 无 chapterNo）

- [ ] **Step 2: 实现透传**

`src/core/agent-engine.mjs` `runModelGatewayCall` 的 metadata（611 行）加一行：

```js
    metadata: {
      toolRequest: request,
      cacheKey: cacheEntry.cacheKey,
      cacheVersion: cacheEntry.cacheVersion,
      chapterNo: state.current_chapter_no
    }
```

`src/core/model-client.mjs:105` 改为：

```js
        const costSummary = this.costTracker.record({ stage, chapter: metadata.chapterNo ?? null, usageReport });
```

- [ ] **Step 3: 跑测试确认通过**

Run: `node --test tests/agent-engine.test.mjs tests/model-gateway.test.mjs tests/cost-double-count.test.mjs`
Expected: PASS

- [ ] **Step 4: 成本面板显示每章成本**

`src/app-shell/drawer-panels.js` 的 `renderCostPanel`（处理 `drawerTab === "cost"` 的函数）：在既有"估算成本" kv 之后追加每章表：

```js
    const byChapter = data.cost?.byChapter ?? {};
    const chapterKeys = Object.keys(byChapter).sort((a, b) => Number(a) - Number(b));
    if (chapterKeys.length) {
      const chapterPanel = dpanel("每章成本");
      const ckv = document.createElement("dl");
      ckv.className = "kv";
      for (const key of chapterKeys) {
        const row = byChapter[key];
        const costText = data.summary?.costAvailable ? formatMoney(row.estimatedCost) : "未配置价格";
        appendKv(ckv, `第 ${key} 章`, `${row.calls} 次调用 · ${formatNumber(row.totalTokens)} tokens · ${costText}`);
      }
      chapterPanel.body.append(ckv);
      panels.push(chapterPanel.panel);
    }
```

（`panels.push` 按该函数既有的面板收集方式接入；若它直接 `replaceChildren(a.panel, b.panel)`，把 `chapterPanel.panel` 追加到该调用末尾。）

- [ ] **Step 5: 每章成本预警（spec 明确要求）**

先写失败测试（追加到 `tests/agent-engine.test.mjs`）：

```js
test("maybeWarnChapterCost 在当前章 token 超前几章均值 2 倍时告警一次", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-warn-"));
  const { projectRoot } = await createProject(workspace, {
    title: "预警", story_seed: "t", target_chapters: 5, min_words_per_chapter: 300
  });
  const project = { project_id: "p1" };
  const state = { current_chapter_no: 3, current_stage: "drafting" };
  const runtime = { warnedChapters: new Set() };
  const costSummary = {
    byChapter: {
      "1": { totalTokens: 1000 }, "2": { totalTokens: 1200 },
      "3": { totalTokens: 5000 }
    }
  };
  await maybeWarnChapterCost(projectRoot, project, state, costSummary, runtime);
  await maybeWarnChapterCost(projectRoot, project, state, costSummary, runtime); // 第二次不重复告警
  const events = await readEvents(projectRoot, { limit: 20 });
  const warnings = events.filter((e) => e.type === "chapter_cost_warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].data.chapter_total_tokens, 5000);
  await fs.rm(workspace, { recursive: true, force: true });
});
```

（`maybeWarnChapterCost` 加入 agent-engine 的 import 列表；该文件既有测试已 import `readEvents`/`createProject`。）

Run: `node --test tests/agent-engine.test.mjs` → FAIL 后实现：

`src/core/agent-engine.mjs` 新增导出函数（放在 `runModelGatewayCall` 之后），并在 `runModelGatewayCall` 的 `writeProjectReport`（624-626 行）之后调用 `await maybeWarnChapterCost(projectRoot, project, state, gatewayResult.costSummary, runtime);`：

```js
export async function maybeWarnChapterCost(projectRoot, project, state, costSummary, runtime) {
  const chapterKey = String(state.current_chapter_no);
  if (runtime.warnedChapters?.has(chapterKey)) return;
  const byChapter = costSummary?.byChapter ?? {};
  const current = byChapter[chapterKey];
  const others = Object.entries(byChapter)
    .filter(([key]) => key !== chapterKey)
    .map(([, bucket]) => bucket.totalTokens ?? 0);
  if (!current || others.length < 2) return;
  const average = others.reduce((a, b) => a + b, 0) / others.length;
  if (average > 0 && (current.totalTokens ?? 0) > average * 2) {
    runtime.warnedChapters?.add(chapterKey);
    await appendEvent(projectRoot, {
      type: "chapter_cost_warning",
      severity: "warn",
      project_id: project.project_id,
      chapter_no: state.current_chapter_no,
      stage: state.current_stage,
      message: `第 ${state.current_chapter_no} 章 token 消耗已超过前几章平均值的 2 倍`,
      data: {
        chapter_total_tokens: current.totalTokens ?? 0,
        average_other_chapters: Math.round(average)
      }
    });
  }
}
```

`createModelRuntime` 返回对象（579-583 行）加 `warnedChapters: new Set()`。用 token 而非金额做预警阈值：未配置价格时也能预警，配置了价格时 token 与金额单调相关。预警事件走既有事件流进 UI 最近事件，不新建界面。

Run: `node --test tests/agent-engine.test.mjs` → PASS

- [ ] **Step 6: 验证 + Commit**

Run: `npm test`，`npm run verify:app-shell`
Expected: 全绿、`ok: true`

```powershell
git add src/core/model-client.mjs src/core/agent-engine.mjs src/app-shell/drawer-panels.js tests/agent-engine.test.mjs
git commit -m "feat(cost): per-chapter cost attribution, chapter cost warning event and cost panel breakdown"
```

---

## Task 4: 缓存稳定前缀修复（最大成本杠杆）

**Files:**
- Modify: `src/core/prompt-compiler.mjs:3-20`
- Modify: `src/core/agent-engine.mjs:727-768`（compileChapterPrompt）
- Modify: `tests/model-gateway.test.mjs`（block order 断言）
- Create: `tests/cache-prefix-stability.test.mjs`

**背景：** 真实数据证明 `project_memory`（书摘+连贯性，每章完成后更新）和 `chapter_plan`（含"第 N 章"）放在 stable 块里，导致 11 次调用 cacheVersion 升到 8、命中率跌到 14.8%。把它们改为 dynamic 块后，真正稳定的前缀（system_rules/goal/style/skill_instructions）跨章字节不变，provider 前缀缓存才能持续命中。块在 prompt 中的相对顺序不变（它们仍然排在 current_task 之前），只是分类和渲染标签变化。**既有项目升级后第一次调用会有一次性 stableHash 变化（标签变更），属预期，写进交付报告。**

- [ ] **Step 1: 写失败测试**

```js
// tests/cache-prefix-stability.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { DYNAMIC_BLOCK_ORDER, PromptCompiler, STABLE_BLOCK_ORDER } from "../src/core/prompt-compiler.mjs";

test("project_memory 与 chapter_plan 属于 dynamic 顺序且不在 stable 顺序", () => {
  assert.ok(!STABLE_BLOCK_ORDER.includes("project_memory"));
  assert.ok(!STABLE_BLOCK_ORDER.includes("chapter_plan"));
  assert.deepEqual(DYNAMIC_BLOCK_ORDER.slice(0, 2), ["project_memory", "chapter_plan"]);
  assert.ok(DYNAMIC_BLOCK_ORDER.indexOf("chapter_plan") < DYNAMIC_BLOCK_ORDER.indexOf("current_task"));
});

test("跨章只变 project_memory/chapter_plan 时 stableHash 不变", () => {
  const compiler = new PromptCompiler({ templateVersion: "drafting.v1" });
  const stableBlocks = { system_rules: "rules", goal: "goal", style: "style" };
  const a = compiler.compile({
    stableBlocks,
    dynamicBlocks: { project_memory: "第一章摘要", chapter_plan: "Chapter 1 of 10.", current_task: "{}" }
  });
  const b = compiler.compile({
    stableBlocks,
    dynamicBlocks: { project_memory: "第一二章摘要，内容已变化", chapter_plan: "Chapter 2 of 10.", current_task: "{}" }
  });
  assert.equal(a.stableHash, b.stableHash);
  assert.notEqual(a.dynamicHash, b.dynamicHash);
  // 渲染顺序仍是 memory/plan 在 current_task 之前
  const memoryIndex = b.prompt.indexOf("内容已变化");
  const taskIndex = b.prompt.indexOf("current_task");
  assert.ok(memoryIndex !== -1 && memoryIndex < taskIndex);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/cache-prefix-stability.test.mjs`
Expected: FAIL（两个 name 还在 STABLE_BLOCK_ORDER）

- [ ] **Step 3: 改 prompt-compiler 顺序契约**

```js
// src/core/prompt-compiler.mjs:3-20 替换
export const STABLE_BLOCK_ORDER = [
  "system_rules",
  "goal",
  "audience",
  "style",
  "skill_instructions",
  "source_summaries",
  "outline"
];

export const DYNAMIC_BLOCK_ORDER = [
  "project_memory",
  "chapter_plan",
  "current_task",
  "selected_draft_fragment",
  "latest_user_feedback",
  "recent_trace_summary"
];
```

- [ ] **Step 4: 改引擎块分类**

`src/core/agent-engine.mjs` `compileChapterPrompt`（727-768 行）：把 `project_memory`、`chapter_plan` 两个键从 `stableBlocks` 对象移到 `dynamicBlocks` 对象开头，内容表达式不变：

```js
  const compiled = compiler.compile({
    stableBlocks: {
      system_rules:
        promptTemplate ||
        "Chapter body must be written through the append_chapter_segment tool. Chat body text is not a valid deliverable.",
      goal: project.story_seed ?? project.title ?? "Untitled writing project",
      style: styleRulesText,
      skill_instructions: skillInstructions
    },
    dynamicBlocks: {
      project_memory: [bookSummary, continuityContext].filter(Boolean).join("\n\n"),
      chapter_plan: [`Chapter ${state.current_chapter_no} of ${project.target_chapters}.`, chapterContinuityRule].join("\n"),
      current_task: JSON.stringify(
        // ……原 JSON 内容原样保留……
```

- [ ] **Step 5: 修正 block order 既有断言**

Run: `node --test tests/model-gateway.test.mjs tests/cache-prefix-stability.test.mjs`
若 model-gateway 测试断言了旧顺序（project_memory/chapter_plan 在 stable 列表中），把期望更新为 Step 3 的新契约。这是设计变更（见本 Task 背景），不是为过测试而改测试；commit message 必须引用本计划。

- [ ] **Step 6: 端到端验证 cacheVersion 不再膨胀**

加引擎级回归（追加到 `tests/cache-prefix-stability.test.mjs`，bootstrap 模式仿照 `tests/agent-engine.test.mjs`：tmp 目录 + `createProject` + mock `runProject` 跑 2 章），断言：

```js
// 跑完 2 章后
const cacheReport = JSON.parse(await fs.readFile(path.join(projectRoot, "cache_report.json"), "utf8"));
for (const entry of Object.values(cacheReport.entries)) {
  assert.equal(entry.cacheVersion, 1, "稳定前缀不应随章节推进而失效");
}
assert.equal(cacheReport.last_call.stableChanged, false);
```

Run: `node --test tests/cache-prefix-stability.test.mjs`
Expected: PASS
Run: `npm run verify:longrun`
Expected: 通过（20 章 mock 长跑后人工检查 demo 项目 cache_report.json 的 cacheVersion 为 1）

- [ ] **Step 7: 全量回归 + Commit**

Run: `npm test`
Expected: 全绿

```powershell
git add src/core/prompt-compiler.mjs src/core/agent-engine.mjs tests/cache-prefix-stability.test.mjs tests/model-gateway.test.mjs
git commit -m "fix(cache): reclassify per-chapter memory/plan as dynamic blocks to preserve stable prefix cache"
```

---

## Task 5: 诊断与成本面板接入健康指标

**Files:**
- Modify: `src/core/project-diagnostics.mjs`
- Modify: `src/app-shell/drawer-panels.js`（renderCostPanel）
- Test: `tests/project-diagnostics.test.mjs`

**边界：** M1 确立"读最近事件不许全量扫日志"。所以诊断端点只用 O(1) 的 `cost.json`/`cache_report.json` 读数（retries 已由 Task 2 进入 cost.json）；全量深审计留在 `npm run audit:cost` CLI。

- [ ] **Step 1: 写失败测试**

`tests/project-diagnostics.test.mjs` 追加（沿用该文件既有 tmp 项目搭建方式）：

```js
test("diagnostics 暴露 costHealth 且不读全量日志", async () => {
  // 在既有 tmp 项目 fixture 上写入 cost.json 与 cache_report.json
  await fs.writeFile(path.join(projectRoot, "cost.json"), JSON.stringify({
    calls: 10, retries: 3, unpricedCalls: 10, costAvailable: false,
    inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, estimatedCost: 0,
    byProvider: {}, byModel: {}, byStage: {}, byChapter: {}
  }));
  await fs.writeFile(path.join(projectRoot, "cache_report.json"), JSON.stringify({
    entries: { "p:drafting.v1": { cacheVersion: 8 } },
    last_call: { cacheHitRate: 0.14, stableChanged: true }
  }));
  const diagnostics = await loadProjectDiagnostics(projectRoot);
  assert.equal(diagnostics.costHealth.retries, 3);
  assert.equal(diagnostics.costHealth.costAvailable, false);
  assert.equal(diagnostics.costHealth.maxCacheVersion, 8);
  assert.equal(diagnostics.costHealth.lastCacheHitRate, 0.14);
});
```

Run: `node --test tests/project-diagnostics.test.mjs`
Expected: FAIL

- [ ] **Step 2: 实现 costHealth**

`src/core/project-diagnostics.mjs`：`loadProjectDiagnostics` 的 `Promise.all` 增加两个并行读取（用 `node:fs/promises` 的 readFile + JSON.parse，失败回 null 的小帮手 `readJsonOrNull`，放本文件底部）：

```js
  const [state, events, failures, queueState, costSummary, cacheReport] = await Promise.all([
    /* 既有四项不动 */,
    readJsonOrNull(path.join(projectRoot, "cost.json")),
    readJsonOrNull(path.join(projectRoot, "cache_report.json"))
  ]);
```

返回对象增加：

```js
    costHealth: {
      calls: costSummary?.calls ?? 0,
      retries: costSummary?.retries ?? 0,
      unpricedCalls: costSummary?.unpricedCalls ?? 0,
      costAvailable: costSummary?.costAvailable ?? false,
      estimatedCost: costSummary?.estimatedCost ?? 0,
      maxCacheVersion: maxCacheVersion(cacheReport),
      lastCacheHitRate: cacheReport?.last_call?.cacheHitRate ?? null,
      lastStableChanged: cacheReport?.last_call?.stableChanged ?? null
    },
```

帮手函数：

```js
function maxCacheVersion(cacheReport) {
  const versions = Object.values(cacheReport?.entries ?? {})
    .map((entry) => entry.cacheVersion)
    .filter((v) => Number.isFinite(v));
  return versions.length ? Math.max(...versions) : null;
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
```

（顶部补 `import { readFile } from "node:fs/promises"; import path from "node:path";`）

- [ ] **Step 3: 跑通**

Run: `node --test tests/project-diagnostics.test.mjs`
Expected: PASS

- [ ] **Step 4: 成本面板显示健康行**

`renderCostPanel` 在每章成本表之前追加（数据走 dashboard 已透传的 `data.cost`，不新加请求）：

```js
    const retries = data.cost?.retries ?? 0;
    appendKv(kv, "重试次数", retries > 0 ? `${retries}（重试会重复消耗 token）` : "0");
    const lastHit = data.cacheSummary?.lastHitRate ?? data.cost?.lastCacheHitRate ?? null;
```

若 `cacheSummaryText` 已表达命中率则只加"重试次数"一行，避免重复信息。

- [ ] **Step 5: 验证 + Commit**

Run: `npm test`，`npm run verify:app-shell`
Expected: 全绿

```powershell
git add src/core/project-diagnostics.mjs src/app-shell/drawer-panels.js tests/project-diagnostics.test.mjs
git commit -m "feat(diagnostics): cost health (retries, unpriced, cache version) without full log scan"
```

---

## Task 6: 金额与 token 预算熔断 + 故障卡恢复

**Files:**
- Modify: `src/core/agent-engine.mjs:1045-1115`（consumeModelCallBudget / withBudgetDefaults）
- Modify: `src/core/settings-runtime.mjs:39-56,250-258`（syncBudgetConfigToState / normalizeBudgetConfig）
- Modify: `src/core/derive-failure-card.mjs`
- Modify: `src/core/failure-actions.mjs`
- Modify: `src/shared/failure-commands.mjs`
- Modify: `src/app-shell/settings-modal.js`
- Modify: `scripts/verify-app-clickability.cjs`
- Create: `tests/budget-caps.test.mjs`
- Modify: `tests/derive-failure-card.test.mjs`、`tests/failure-actions.test.mjs`

**语义：** `max_cost`（元）与 `max_total_tokens` 默认不设（null = 不限制）。熔断检查在每次模型调用前（`consumeModelCallBudget`），读 cost.json 累计值；金额上限只在 `costAvailable === true` 时可执行（没配价格就没法按钱熔断，设置页 hint 说明）。超限走既有 `blockProject` → 故障卡 → resolve 自动续跑链路。

- [ ] **Step 1: 写失败测试**

```js
// tests/budget-caps.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProject } from "../src/core/agent-engine.mjs";
import { MockModel } from "../src/core/mock-model.mjs";
import { createProject, loadState } from "../src/core/project-store.mjs";
import { updateProjectSettings } from "../src/core/settings-runtime.mjs";
import { readEvents } from "../src/core/event-log.mjs";

async function setupProject(budgetConfig) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-budget-"));
  const { projectRoot } = await createProject(workspace, {
    title: "预算熔断",
    story_seed: "test",
    target_chapters: 2,
    min_words_per_chapter: 300
  });
  await updateProjectSettings(projectRoot, { budget_config: budgetConfig });
  return { workspace, projectRoot };
}

test("超过 max_total_tokens 时项目进入 blocked(token_budget_exhausted)", async () => {
  const { workspace, projectRoot } = await setupProject({ max_total_tokens: 1 });
  // 预置已超限的 cost.json
  await fs.writeFile(path.join(projectRoot, "cost.json"), JSON.stringify({
    calls: 1, totalTokens: 99999, inputTokens: 1, outputTokens: 1, cachedTokens: 0,
    estimatedCost: 0, costAvailable: false, unpricedCalls: 1, pricedCalls: 0, retries: 0,
    byProvider: {}, byModel: {}, byStage: {}, byChapter: {}
  }));
  await runProject(projectRoot, { model: new MockModel() }).catch(() => {});
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "blocked");
  assert.equal(state.blocked_reason, "token_budget_exhausted");
  const events = await readEvents(projectRoot, { limit: 50 });
  assert.ok(events.some((e) => e.type === "project_blocked" && e.message === "token_budget_exhausted"));
  await fs.rm(workspace, { recursive: true, force: true });
});

test("配置了价格且超过 max_cost 时进入 blocked(cost_budget_exhausted)", async () => {
  const { workspace, projectRoot } = await setupProject({ max_cost: 0.5 });
  await fs.writeFile(path.join(projectRoot, "cost.json"), JSON.stringify({
    calls: 1, totalTokens: 100, inputTokens: 50, outputTokens: 50, cachedTokens: 0,
    estimatedCost: 1.2, costAvailable: true, unpricedCalls: 0, pricedCalls: 1, retries: 0,
    byProvider: {}, byModel: {}, byStage: {}, byChapter: {}
  }));
  await runProject(projectRoot, { model: new MockModel() }).catch(() => {});
  const state = await loadState(projectRoot);
  assert.equal(state.blocked_reason, "cost_budget_exhausted");
  await fs.rm(workspace, { recursive: true, force: true });
});

test("costAvailable=false 时 max_cost 不熔断（无法按钱计量）", async () => {
  const { workspace, projectRoot } = await setupProject({ max_cost: 0.5 });
  await fs.writeFile(path.join(projectRoot, "cost.json"), JSON.stringify({
    calls: 1, totalTokens: 100, inputTokens: 50, outputTokens: 50, cachedTokens: 0,
    estimatedCost: 0, costAvailable: false, unpricedCalls: 1, pricedCalls: 0, retries: 0,
    byProvider: {}, byModel: {}, byStage: {}, byChapter: {}
  }));
  const result = await runProject(projectRoot, { model: new MockModel() });
  assert.ok(result);
  const state = await loadState(projectRoot);
  assert.notEqual(state.project_status, "blocked");
  await fs.rm(workspace, { recursive: true, force: true });
});
```

（`createProject`/`runProject` 的参数形状若与 `tests/agent-engine.test.mjs` 既有 fixture 不同，以该文件为准对齐——意图是：建 mock 项目 → 设预算 → 预置 cost.json → 跑一步 → 断言 blocked 原因。）

Run: `node --test tests/budget-caps.test.mjs`
Expected: FAIL（熔断未实现）

- [ ] **Step 2: 引擎实现熔断**

`src/core/agent-engine.mjs` `withBudgetDefaults`（1107 行）：

```js
function withBudgetDefaults(state) {
  return {
    model_calls: 0,
    max_model_calls: 200,
    revision_rounds_by_chapter: {},
    max_revision_rounds_per_chapter: 4,
    max_cost: null,
    max_total_tokens: null,
    ...(state.active_budget ?? {})
  };
}
```

`consumeModelCallBudget`（1045 行）在既有 maxCalls 检查之后、`budget.model_calls += 1` 之前插入：

```js
  const costSummary = await readJson(safeJoin(projectRoot, "cost.json"), null);
  const maxTokens = budget.max_total_tokens;
  if (Number.isFinite(maxTokens) && (costSummary?.totalTokens ?? 0) >= maxTokens) {
    await blockProject(projectRoot, project, current, "token_budget_exhausted", {
      total_tokens: costSummary?.totalTokens ?? 0,
      max_total_tokens: maxTokens,
      ...data
    });
    throw new ProjectBlockedError("token_budget_exhausted");
  }
  const maxCost = budget.max_cost;
  if (Number.isFinite(maxCost) && costSummary?.costAvailable === true && costSummary.estimatedCost >= maxCost) {
    await blockProject(projectRoot, project, current, "cost_budget_exhausted", {
      estimated_cost: costSummary.estimatedCost,
      max_cost: maxCost,
      ...data
    });
    throw new ProjectBlockedError("cost_budget_exhausted");
  }
```

- [ ] **Step 3: settings-runtime 接受新字段**

`normalizeBudgetConfig`（250 行）加：

```js
  copyOptionalPositiveNumber(normalized, config, "max_cost");
  copyOptionalPositiveInteger(normalized, config, "max_total_tokens");
```

若 `copyOptionalPositiveNumber` 不存在，仿照 `copyOptionalPositiveInteger` 实现（接受正的有限数，允许小数）。`syncBudgetConfigToState`（44 行）的 key 列表改为：

```js
  for (const key of ["max_model_calls", "max_revision_rounds_per_chapter", "max_cost", "max_total_tokens"]) {
```

- [ ] **Step 4: 跑通熔断测试**

Run: `node --test tests/budget-caps.test.mjs tests/settings-runtime.test.mjs`
Expected: PASS

- [ ] **Step 5: 故障卡 + 恢复动作（先红后绿）**

`tests/derive-failure-card.test.mjs` 加：

```js
test("cost_budget_exhausted 事件产出可恢复的成本预算卡", () => {
  const card = deriveFailureCard({
    id: "e1", type: "project_blocked", message: "cost_budget_exhausted",
    chapter_no: 3, data: { estimated_cost: 1.21, max_cost: 1 }
  }, { current_chapter_no: 3 });
  assert.equal(card.kind, "budget-exhausted");
  assert.match(card.body, /1\.21/);
  assert.equal(card.actions[0].command, "raise-cost-budget");
  assert.equal(card.actions[0].args.newMaxCost, 2);
});
```

`tests/failure-actions.test.mjs` 加（仿既有 raise-budget 用例）：

```js
test("raise-cost-budget 写入 budget_config.max_cost 并要求续跑", async () => {
  const result = await applyFailureAction(projectRoot, { command: "raise-cost-budget", args: { newMaxCost: 2 } });
  assert.equal(result.resumeRun, true);
  const project = await loadProject(projectRoot);
  assert.equal(project.budget_config.max_cost, 2);
});
```

实现——`src/core/derive-failure-card.mjs`：

`classifyKind` 的 project_blocked 分支扩展：

```js
    if (message === 'model_call_budget_exhausted' || message === 'revision_budget_exhausted'
      || message === 'cost_budget_exhausted' || message === 'token_budget_exhausted') return 'budget-exhausted';
```

`actionsForKind` 的 `budget-exhausted` 分支改为按 message 分流：

```js
    case 'budget-exhausted': {
      if (event.message === 'cost_budget_exhausted') {
        const currentMax = data.max_cost ?? 1;
        return [
          { label: `提高成本上限到 ¥${currentMax * 2}`, command: 'raise-cost-budget', args: { newMaxCost: currentMax * 2 } },
          { label: '停在这里', command: 'pause-here', args: {} }
        ];
      }
      if (event.message === 'token_budget_exhausted') {
        const currentMax = data.max_total_tokens ?? 100000;
        return [
          { label: `提高 token 上限到 ${currentMax * 2}`, command: 'raise-token-budget', args: { newMaxTotalTokens: currentMax * 2 } },
          { label: '停在这里', command: 'pause-here', args: {} }
        ];
      }
      const current = data.max_model_calls ?? data.max ?? 200;
      return [
        { label: `提高预算到 ${current * 2}`, command: 'raise-budget', args: { newMaxModelCalls: current * 2 } },
        { label: '停在这里', command: 'pause-here', args: {} }
      ];
    }
```

`bodyForKind` 的 budget 分支同样分流，给出人话（金额卡：`已花约 ¥X，达到你设置的 ¥Y 上限`；token 卡同理）。

`src/core/failure-actions.mjs` 加两个 case（仿 raise-budget，71-77 行）：

```js
    case "raise-cost-budget": {
      await updateProjectSettings(projectRoot, { budget_config: { max_cost: args.newMaxCost } });
      await saveResumeableState(projectRoot);
      return { resumeRun: true, message: `成本上限已提高到 ¥${args.newMaxCost}，继续写作。` };
    }

    case "raise-token-budget": {
      await updateProjectSettings(projectRoot, { budget_config: { max_total_tokens: args.newMaxTotalTokens } });
      await saveResumeableState(projectRoot);
      return { resumeRun: true, message: `token 上限已提高到 ${args.newMaxTotalTokens}，继续写作。` };
    }
```

`src/shared/failure-commands.mjs`：把 `raise-cost-budget`、`raise-token-budget` 加入命令清单（与 `raise-budget` 同组；该文件是前后端共用契约，漏注册会导致后端 400「未知命令」——这正是 6-10 修过的回归类型）。

- [ ] **Step 6: 设置页与点击防线**

`settings-modal.js`：`settingsFields.maxCalls` 之后加两个字段并入 append 列表与 saveSettings patch：

```js
    settingsFields.maxCost = settingField("成本上限（元，需先配置价格）", "number", { value: budgetConfig.max_cost ?? "" });
    settingsFields.maxTokens = settingField("token 总量上限", "number", { value: budgetConfig.max_total_tokens ?? "" });
```

```js
        budget_config: {
          max_model_calls: settingsFields.maxCalls.input.value,
          max_cost: settingsFields.maxCost.input.value,
          max_total_tokens: settingsFields.maxTokens.input.value
        },
```

`scripts/verify-app-clickability.cjs`：在播种故障卡的地方（参考既有扁平卡播种，约 50 行）增加一张成本预算卡：

```js
{
  id: "seed-cost-budget",
  kind: "budget-exhausted",
  title: "预算已用尽",
  body: "第 1 章已花约 ¥1.21，达到你设置的 ¥1 上限。",
  actions: [
    { label: "提高成本上限到 ¥2", command: "raise-cost-budget", args: { newMaxCost: 2 } },
    { label: "停在这里", command: "pause-here", args: {} }
  ]
}
```

并把点击断言扩展到该卡第一个按钮（trusted click 后预期出现成功 toast / resolve 请求，与既有故障卡断言一致）；设置弹窗断言增加：新 5 个输入框（3 价格 + 2 上限）可见、可聚焦、可输入。

- [ ] **Step 7: 验证 + Commit**

Run: `npm test`
Expected: 全绿
Run: `npm run verify:app-clickability`
Expected: `ok: true`（含新卡和新输入框路径）

```powershell
git add src/core/agent-engine.mjs src/core/settings-runtime.mjs src/core/derive-failure-card.mjs src/core/failure-actions.mjs src/shared/failure-commands.mjs src/app-shell/settings-modal.js scripts/verify-app-clickability.cjs tests/budget-caps.test.mjs tests/derive-failure-card.test.mjs tests/failure-actions.test.mjs
git commit -m "feat(budget): cost and token caps with circuit breaker, failure card recovery and settings UI"
```

---

## Task 7: 补写成本治理（首轮就知道字数缺口）

**Files:**
- Modify: `src/core/agent-engine.mjs:687-773`（compileChapterPrompt）
- Test: `tests/agent-engine.test.mjs`（CapturingModelClient prompt 断言）

**背景：** 基线显示字数门禁失败触发补写轮（每轮都是一次完整模型调用）。现在模型首轮只知道 `segment_target_words`，不知道"整章还差多少字到最低门槛"。把实算缺口放进 current_task，让模型首轮分配好篇幅，减少补写轮。效果由 `audit:cost` 的 refills 指标在真实短跑中对比（Task 8）。

- [ ] **Step 1: 写失败测试**

`tests/agent-engine.test.mjs` 使用 CapturingModelClient 的测试追加断言：

```js
  const lastPrompt = client.prompts.at(-1);
  assert.match(lastPrompt, /"chapter_words_written":\s*\d+/);
  assert.match(lastPrompt, /"chapter_words_remaining_to_minimum":\s*\d+/);
```

Run: `node --test tests/agent-engine.test.mjs`
Expected: FAIL

- [ ] **Step 2: 实现**

`compileChapterPrompt`：draft 读取后（691-707 行的 Promise.all 之后）加：

```js
  const chapterWordsWritten = countEffectiveWords(draft);
  const chapterWordsRemaining = Math.max(0, (project.min_words_per_chapter ?? 0) - chapterWordsWritten);
```

（`countEffectiveWords` 若未在引擎中 import，则顶部加 `import { countEffectiveWords } from "./word-count.mjs";`）

`current_task` JSON（740-760 行）加两个字段：

```js
          chapter_words_written: chapterWordsWritten,
          chapter_words_remaining_to_minimum: chapterWordsRemaining,
```

`styleRules`（709-715 行）追加一条：

```js
    "字数规划：current_task 里的 chapter_words_remaining_to_minimum 是整章距最低门槛的实算缺口；请在本段就把字数缺口填上，不要依赖事后补写。",
```

- [ ] **Step 3: 跑通 + 全量回归**

Run: `node --test tests/agent-engine.test.mjs`
Expected: PASS
Run: `npm test && npm run verify:mvp`
Expected: 全绿（mvp 含字数门禁补写路径，确认行为未破坏）

- [ ] **Step 4: Commit**

```powershell
git add src/core/agent-engine.mjs tests/agent-engine.test.mjs
git commit -m "feat(refill): expose real chapter word gap in current_task to reduce refill rounds"
```

---

## Task 8: 基线对比、真实 API 验证与 S1 交付报告

**Files:**
- Create: `docs/superpowers/reports/2026-06-11-s1-delivery-report.md`

- [ ] **Step 1: mock 长跑对比缓存修复**

Run: `npm run verify:longrun`
然后对 demo 项目目录跑 `npm run audit:cost -- <demo项目路径>`（路径在 verify:longrun 输出里）。
Expected: `cache.maxCacheVersion === 1`、`refills` 与基线可比。记录数字。

- [ ] **Step 2: 全量本地验证**

Run: `npm test`、`npm run verify:app-shell`、`npm run verify:app-clickability`、`npm run verify:local`
Expected: 全部 `ok: true`。任何例外按 spec 规则记录原因、影响、后续处理。

- [ ] **Step 3: 真实 API 短跑（spec 硬性要求，不许只用 mock 宣布通过）**

前置：用户在设置页配置真实模型（DeepSeek 或 MiMo）+ API Key + 价格三字段。
Run: `npm run verify:provider-online`
然后真实跑 1-2 章的小项目，对其跑 `npm run audit:cost`，记录：
- 每章成本是否可见且非 0（验收：UI 能回答"花了多少"）。
- `cache.maxCacheVersion` 是否保持 1、命中率序列对比基线 39.7%→14.8% 是否改善。
- refills 轮次对比基线。
此步需要真实密钥与少量真实花费，须用户在场或授权后执行。

- [ ] **Step 4: 写交付报告并 Commit**

`docs/superpowers/reports/2026-06-11-s1-delivery-report.md` 包含：已完成任务清单、验证证据表（命令/结果/数字）、基线 vs 修复后对比表（cacheVersion、命中率、refills、每章成本可见性）、已知限制（金额熔断依赖价格配置；既有项目升级后一次性 stableHash 变化）、S2 建议入口。

```powershell
git add docs/superpowers/reports/2026-06-11-s1-delivery-report.md
git commit -m "docs(s1): delivery report with baseline comparison and real-API verification evidence"
```

---

## 验收对照（spec S1 节）

| spec 验收 | 由哪个 Task 满足 |
|----------|----------------|
| UI 能回答总花费/每章花费/缓存节省/浪费在哪 | Task 2（诚实成本）+ Task 3（每章）+ Task 5（重试/缓存健康） |
| 重试与补写成本占比量化报告 | Task 1（audit:cost CLI）+ Task 8（报告） |
| 金额/token 上限熔断且可从故障卡恢复 | Task 6 |
| 每章成本预警 | Task 3 Step 5（chapter_cost_warning 事件） |
| 改动前后同一项目缓存命中率基准对比 | Task 1（基线）+ Task 4（修复）+ Task 8（对比） |
| 真实 API 短跑验证 | Task 8 Step 3 |

## 风险提示（执行者必读）

1. **block order 是版本化契约**：Task 4 改的是设计契约（spec 风险节已声明），改测试断言时 commit message 必须引用本计划，禁止顺手改其他断言。
2. **不要动用户真实项目**：`D:\aaaa111大学生1111` 只读（audit），任何写操作只发生在 tmp/demo 目录。
3. **UI 改动必跑 clickability**：CLAUDE.md 防线，新增的每个可点控件都要进探针。
4. **旧 cost.json 含历史双重记账数据**（嵌套项目实测 mock+unknown 各 39 次）：本计划不回写修正历史数据，audit 报告中如实标注即可。
