# 故事时钟 Part A 收尾改进计划

> 目标：修复 Part A 验收中确认的 6 个点（2 个 P1、2 个 P2、2 个 P3），全部 TDD，不破坏既有 725 测试。
> 执行方式：superpowers TDD——每条先写失败测试，跑红，改实现，跑绿，最后全量回归。

## 背景

Part A 已交付（8 提交、725 测试全绿），但验收发现以下可改进点。本计划只做收尾打磨，不动架构。

---

## Fix 1（P1 Bug）：parseDateRaw "只有年份" 不应参与裁决

**问题**：`src/core/timeline-check.mjs:35` 仅凭"有年份"就 `comparable:true`。`parseDateRaw("2021年")` 返回 `{comparable:true, value:20210000}`，与 `2021年3月5日`(20210305) 比较会误报 `time_reversal`。粗粒度"只有年"不必然早于同年某月日，与 A3"宁缺毋滥"冲突。

**修复**：`comparable` 仅当"有年份 **且**（有月或有日）"时为 true。只有年无月日 → 仍返回对象但 `comparable:false`。

**Step 1 失败测试**（追加到 `tests/timeline-check.test.mjs`）：

```js
test("parseDateRaw: 只有年份不参与裁决（防误报）", () => {
  const onlyYear = parseDateRaw("2021年");
  assert.equal(onlyYear.comparable, false);
  // 只有年 vs 完整日期，不应触发可比
  assert.equal(parseDateRaw("2021年").comparable, false);
  // 有年有月有日仍可比
  assert.equal(parseDateRaw("2021年3月5日").comparable, true);
  // 有年有月无日也可比（粒度足够）
  assert.equal(parseDateRaw("2021年3月").comparable, true);
});
```

**Step 2 跑红**：`node --test tests/timeline-check.test.mjs` → FAIL（只有年 comparable 为 true）。

**Step 3 实现**：把 `timeline-check.mjs` 第 35 行

```js
  return { comparable: year != null, value: (year ?? 0) * 10000 + (month ?? 0) * 100 + (day ?? 0) };
```

改为：

```js
  return { comparable: year != null && (month != null || day != null), value: (year ?? 0) * 10000 + (month ?? 0) * 100 + (day ?? 0) };
```

**Step 4 跑绿**。

---

## Fix 2（P1 不对称）：migrateTimelineNode 复用 normalize 校验 time

**问题**：`src/core/continuity-store.mjs:15` 对已存在的 `time` 直接 `{ ...base, time: n.time }` 透传，不校验内部结构；而 `memory-extractor.mjs` 的 `normalizeTimeField` 严格白名单规范化。两侧"入口验、存储不验"不对称，外部污染的畸形 time 会一路透传到渲染/检查。

**修复**：把 `memory-extractor.mjs` 的 `normalizeTimeField` 导出，`continuity-store.mjs` 复用它校验所有 time（含已存在）。消除不对称，无循环依赖（memory-extractor 不反向依赖 continuity-store）。

**Step 1 失败测试**（追加到 `tests/continuity-store.test.mjs`）：

```js
test("migrateTimelineNode: 透传的畸形 time 被规范化", () => {
  const merged = mergeExtraction(
    { schema_version: 2, facts: [], timeline: [], characters: [] },
    { facts: [], characters: [], timeline: [
      { chapter_no: 5, story_time_raw: "x", events: ["e"],
        time: { kind: "weird", elapsed: "三天", anchor: "bad", confidence: "maybe" } } ] }
  );
  const t = merged.timeline[0].time;
  assert.equal(t.kind, "scene");
  assert.equal(t.elapsed, null);
  assert.equal(t.anchor, null);
  assert.equal(t.confidence, "low");
});
```

**Step 2 跑红**：`node --test tests/continuity-store.test.mjs` → FAIL（kind 仍 "weird"）。

**Step 3a 实现 memory-extractor**：把 `normalizeTimeField` 改为 `export function normalizeTimeField`（第 95 行）。

**Step 3b 实现 continuity-store**：
- 顶部加 import：`import { normalizeTimeField } from "./memory-extractor.mjs";`
- 把 `migrateTimelineNode` 第 15 行 `if (n.time && typeof n.time === "object") return { ...base, time: n.time };` 删除，统一走：

```js
function migrateTimelineNode(node) {
  const n = node && typeof node === "object" ? node : {};
  const base = {
    chapter_no: n.chapter_no ?? null,
    events: Array.isArray(n.events) ? n.events : [],
    story_time_raw: String(n.story_time_raw ?? n.story_time ?? "")
  };
  return { ...base, time: normalizeTimeField(n.time) };
}
```

**Step 4 跑绿**（注意：既有"v2 time 透传"测试 `merged.timeline[0].time.elapsed === "+3d"` 仍过，因为 normalizeTimeField 对合法 time 透传）。

---

## Fix 3（P2 隐患）：同章多节点导致故事时钟重复累加

**问题**：`mergeExtraction` 同 `chapter_no` 不同 events 指纹会 push 第二条，timeline 出现同章多 scene 节点。`sceneNodes` 排序后同章两个 scene 都进主链累加，`computeStoryClock`/`checkTimeline` 会重复累加/重复比较。这是既有逻辑（非本次引入），但时钟链路无防护。

**修复**：在 `sceneNodes` 内按 `chapter_no` 去重，保留每章第一条 scene（章号最小事件顺序已由 sort 保证稳定）。不动 `mergeExtraction` 既有去重指纹逻辑（避免破坏既有测试）。

**Step 1 失败测试**（追加到 `tests/timeline-check.test.mjs`）：

```js
test("computeStoryClock: 同章多节点不重复累加", () => {
  const { perChapter } = computeStoryClock([
    sc(1, null), sc(2, "+1d"), sc(2, "+1d"), sc(3, "+2d")
  ]);
  // 第2章被算两次 elapsed 会得到 day=2，正确应为 1
  assert.equal(perChapter.get(2).day, 1);
  assert.equal(perChapter.get(3).day, 3);
});
```

**Step 2 跑红**：`node --test tests/timeline-check.test.mjs` → FAIL（第2章 day=2）。

**Step 3 实现**：把 `timeline-check.mjs` 的 `sceneNodes` 改为按 chapter_no 去重（保留首个）：

```js
function sceneNodes(timeline) {
  const seen = new Set();
  return (Array.isArray(timeline) ? timeline : [])
    .filter((n) => n?.time?.kind === SCENE)
    .sort((a, b) => (a.chapter_no ?? 0) - (b.chapter_no ?? 0))
    .filter((n) => {
      if (n.chapter_no == null || seen.has(n.chapter_no)) return false;
      seen.add(n.chapter_no);
      return true;
    });
}
```

**Step 4 跑绿**（注意：既有"flashback 不进主链"测试 `perChapter.has(3)===false` 仍过，因为 flashback 被 kind 过滤）。

---

## Fix 4（P2 漏报）：纯单位中文数字"十"解析

**问题**：`timeline-check.mjs:16-19` 的 `cnNum` 复用 `parseChineseChapterNo`，其 `any && total>0` 检查使纯单位"十""百"返回 null，导致"十岁/十日/十月"解析失败（漏报方向，安全但覆盖缺口）。"十岁"是常见年龄表达。

**修复**：在 `timeline-check.mjs` 内新增独立的轻量中文数字解析 `parseCnNumber`，覆盖纯单位"十"（=10）、"二十"（=20）、"三百"（=300）等，不依赖 `parseChineseChapterNo`，避免改动 quality-gates 行为。`cnNum` 改用它。

**Step 1 失败测试**（追加到 `tests/timeline-check.test.mjs`）：

```js
test("parseAnchorValue/parseDateRaw: 纯单位中文数字'十'可解析", () => {
  assert.deepEqual(parseAnchorValue({ type: "age", raw: "十岁" }), { unit: "year", value: 10 });
  assert.equal(parseDateRaw("十日").value, 10);
  assert.equal(parseDateRaw("十月五日").value, 1005);
});
```

**Step 2 跑红**：`node --test tests/timeline-check.test.mjs` → FAIL（"十岁"返回 null）。

**Step 3 实现**：在 `timeline-check.mjs` 新增（替换 `cnNum` 实现，不再调 `parseChineseChapterNo`）：

```js
const CN_DIGITS = { "〇":0,"零":0,"一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9 };
const CN_UNITS = { "十":10,"百":100,"千":1000 };

// 独立中文数字解析（含纯单位"十"=10），不依赖章号解析器
function parseCnNumber(seg) {
  const s = String(seg ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0, section = 0, hasDigit = false;
  for (const ch of s) {
    if (ch in CN_DIGITS) { section = CN_DIGITS[ch]; hasDigit = true; }
    else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (section === 0) section = 1; // "十" → 1*10
      total += section * unit;
      section = 0;
    } else return null;
  }
  total += section;
  return hasDigit || total > 0 ? total : null;
}

function cnNum(seg) {
  const n = parseCnNumber(seg);
  return Number.isInteger(n) && n > 0 ? n : null;
}
```

注意：若 `import { parseChineseChapterNo }` 此后不再被使用，**移除该 import 行**（避免 lint 未用警告），但要确认 `parseDateRaw` 的注释/逻辑无其他引用。

**Step 4 跑绿**（确认既有中文数字测试"二千零二十一年三月五日"仍过）。

---

## Fix 5（P3 可读性）：describeStoryClock 整数化天

**问题**：`describeStoryClock` 直接拼 `latest.day`，产出"第 0.5 天""第 3.5 天"，喂 LLM 的提示词里出现小数天有点怪。

**修复**：展示时整数化——day 为整数直接显示；非整数显示"约第 N 天"或取整。取整用 `Math.round`，文案保持"约为第 N 天"。

**Step 1 失败测试**（追加到 `tests/timeline-check.test.mjs`）：

```js
test("describeStoryClock: 小数天整数化展示", () => {
  assert.match(describeStoryClock([sc(1, null), sc(2, "+12h")]), /第 1 天/u);
  assert.doesNotMatch(describeStoryClock([sc(1, null), sc(2, "+12h")]), /0\.5/);
});
```

**Step 2 跑红**：`node --test tests/timeline-check.test.mjs` → FAIL（出现"第 0.5 天"）。

**Step 3 实现**：把 `describeStoryClock` 中的

```js
  return `截至第 ${latest.chapter_no} 章，故事时钟约为第 ${latest.day} 天${approx}`;
```

改为：

```js
  return `截至第 ${latest.chapter_no} 章，故事时钟约为第 ${Math.round(latest.day)} 天${approx}`;
```

**Step 4 跑绿**（注意：既有 describeStoryClock 测试断言 `/第 ?3 ?天/u`，`Math.round(3)=3` 仍过）。

---

## Fix 6（P3 一致性）：裸 "0" 统一为 "+0"

**问题**：`parseElapsedToken` 接受裸 `"0"`→0，而 `normalizeElapsed` 把 `"0"` 规范成 `"+0"`。两侧对裸 0 处理不一致（功能等价，但语义不统一）。

**修复**：`parseElapsedToken` 仍接受 `"0"`（向后兼容已存数据），但 `normalizeElapsed` 保持产出 `"+0"`。**此条不必改代码**——只需补一条测试锁定"两侧对裸 0 等价"的契约，防止未来漂移。

**Step 1 契约测试**（追加到 `tests/timeline-check.test.mjs`）：

```js
test("parseElapsedToken: 裸 0 与 +0 等价（契约锁定）", () => {
  assert.equal(parseElapsedToken("0"), parseElapsedToken("+0"));
  assert.equal(parseElapsedToken("0"), 0);
});
```

**Step 2**：直接跑绿（无需改实现）。

---

## 全量回归（最后执行）

```bash
node --test tests/*.test.mjs tests/app-shell/*.test.mjs
```

Expected: 全绿（既有 725 + 本次新增全部通过）。

完成后用 `git add -A && git commit -m "fix(timeline): tighten date comparability, normalize migrated time, dedup scene nodes, parse CN unit digits, integer-day clock"` 单次提交收尾。

## Self-Review

- Fix 1 防误报（与 A3 一致）✓；Fix 2 消除入口/存储不对称 ✓；Fix 3 防重复累加 ✓；Fix 4 补漏报覆盖（不改 quality-gates）✓；Fix 5 可读性 ✓；Fix 6 契约锁定 ✓。
- 所有修复均有失败测试先行；不破坏既有测试（已逐条核对既有断言）。
- 不动 mergeExtraction 既有去重指纹逻辑（Fix 3 在读取侧去重，风险更低）。
