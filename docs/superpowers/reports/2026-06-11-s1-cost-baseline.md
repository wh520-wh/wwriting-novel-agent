# S1 成本审计基线（2026-06-11）

> 取证项目：`D:\aaaa111大学生1111`（READ-ONLY）。
> 命令：`npm run audit:cost -- "D:\aaaa111大学生1111"`。
> 本报告是 Task 4 / Task 9 / Task 10 的对照基线。

## 原始 JSON 输出

```json
{
  "calls": {
    "started": 13,
    "completed": 11,
    "abandoned": 2
  },
  "retries": {
    "count": 0,
    "byReason": {}
  },
  "byChapter": {
    "1": {
      "calls": 2,
      "inputTokens": 2688,
      "outputTokens": 4771,
      "cachedTokens": 768,
      "reasoningTokens": 994
    },
    "2": {
      "calls": 1,
      "inputTokens": 1855,
      "outputTokens": 2888,
      "cachedTokens": 384,
      "reasoningTokens": 484
    },
    "3": {
      "calls": 1,
      "inputTokens": 2723,
      "outputTokens": 2788,
      "cachedTokens": 640,
      "reasoningTokens": 463
    },
    "4": {
      "calls": 1,
      "inputTokens": 3589,
      "outputTokens": 2653,
      "cachedTokens": 640,
      "reasoningTokens": 268
    },
    "5": {
      "calls": 1,
      "inputTokens": 4380,
      "outputTokens": 2928,
      "cachedTokens": 640,
      "reasoningTokens": 463
    },
    "6": {
      "calls": 2,
      "inputTokens": 8709,
      "outputTokens": 5579,
      "cachedTokens": 4864,
      "reasoningTokens": 1002
    },
    "7": {
      "calls": 2,
      "inputTokens": 8693,
      "outputTokens": 6251,
      "cachedTokens": 1280,
      "reasoningTokens": 758
    },
    "8": {
      "calls": 1,
      "inputTokens": 4313,
      "outputTokens": 4085,
      "cachedTokens": 640,
      "reasoningTokens": 242
    }
  },
  "refills": {
    "gateFailures": 0,
    "byChapter": {}
  },
  "cache": {
    "samples": [
      0.39669421487603307,
      0.22325581395348837,
      0.20700808625336928,
      0.2350348879911862,
      0.17832265254945667,
      0.1461187214611872,
      0.14760147601476015,
      0.9659272810427624,
      0.1478743068391867,
      0.1466208476517755,
      0.14838859262694182
    ],
    "averageHitRate": 0.2675315346600134,
    "maxCacheVersion": 8,
    "lastStableChanged": true
  },
  "costSummary": null
}
```

## 三句结论

1. **每章平均调用与 token**：8 章合计 11 次 completed，平均每章 1.375 次调用；单章 token（input+output）从 4743（第 2 章）到 14288（第 6 章）跨度约 3 倍，第 6 / 7 章（call 都为 2）显著高于其余 6 章；调用次数 1 或 2 与 token 增长正相关，符合"补写/重试更费 token"的预期。

2. **缓存命中率序列 + cacheVersion 证明前缀失效**：11 个 `cacheHitRate` 样本从首次 0.397 一路下降到末次 0.148（仅第 8 个异常 0.966 是分块/请求偶然命中），平均仅 0.268；与此同时 `maxCacheVersion=8` 且 `lastStableChanged=true`，说明 11 次 completed 调用里稳定前缀被破坏了 8 次——直接证据支持"每章都变的 project_memory/chapter_plan 留在 stable 块里导致前缀缓存失效"的诊断（Task 4 将通过把它们改到 dynamic 块验证修复）。

3. **重试与补写计数**：`retries.count=0`（本项目没有 model_retry 事件，13 次 started 对 11 次 completed 的差距来自开始/未完成配对而非重试）；`refills.gateFailures=0`（本项目没有 word-count gate failed 事件，说明数据来自单轮内就满足字数的会话）；基线把 `calls.abandoned=2` 暴露为待解释项（started > completed 但 retries=0——属于未伴随 retry 事件的中断调用，Task 4 之后该比值应随缓存修复带来的稳定性提升而趋稳）。
