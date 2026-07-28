# 故事时钟规范化（Part A）实施计划 · v2（按对抗性评审重写）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把每章"故事内时间"升级成结构化字段；新增零成本的**故事时钟**（累加每章"过了多久"）与确定性裁决（带年份日期倒退、同角色年龄倒退，均防误报）；并把算好的故事时钟**喂给既有 LLM fact-check**，让"三天后…当晚"这类相对时间穿帮被可靠抓出并一键修复。

**Architecture:** 责任分离三层——(1) 抽取只产局部好判断的字段；(2) 纯函数 `timeline-check.mjs` 本地算故事时钟 + 只对"能稳判不误报"的硬矛盾出确定性裁决（通知型）；(3) 相对漂移由 LLM fact-check 在拿到算好的时钟后判定并产出一键修复。`timeline-check` 依赖 `quality-gates` 的中文数解析；`quality-gates` 不反向依赖（故事时钟由 `agent-engine` 计算后作参数传入 `buildFactCheckMessages`，无循环依赖）。schema v1→v2 惰性迁移。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:test` + `node:assert/strict`。

参考 spec：`docs/superpowers/specs/2026-06-19-story-clock-and-consistency-audit-design.md`（§3、§4、§8、§10）。

**本版相对 v1 修掉的评审问题：** A1（Task 5 重复 import → 改为不再 import）、A2（确定性检查抓不到招牌场景 → 新增故事时钟并喂 LLM）、A3（跨年月日 / 空 subject 误报 → date 只判带年、age 只判带 subject）、A4（重复打扰 + 章号张冠李戴 → 只报"较晚一方=本章"的冲突）、A5（确定性命中无一键 → 诚实改通知型，一键走 LLM 路径）、A6（前端不认新类型 → 改 thread-renderer）、A7（在线门押概率 LLM → 不加易抖 fixture，以"时钟入提示词"单测作主回归）。

---

## 数据模型（v2 timeline 节点）

```
{
  chapter_no, events: [...],
  story_time_raw: "模型原话",
  time: {
    kind: "scene" | "flashback" | "parallel" | "dream",
    elapsed: "+3d" | "+0" | "+12h" | null,    // 相对上一 scene；token: +0 或 +<n>(h|d|w|mo|y)
    anchor: { type:"date"|"age"|"named", raw:"3月10日", subject:"主角"|null } | null,
    confidence: "high" | "low"
  }
}
```

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `src/core/timeline-check.mjs` | 纯函数：token/日期/锚点解析 + `computeStoryClock`/`describeStoryClock` + `checkTimeline`/`summarizeTimelineViolations` | 新建（Task 1-3） |
| `tests/timeline-check.test.mjs` | 上者单测 | 新建（Task 1-3） |
| `src/core/memory-extractor.mjs` | 抽取提示词 + 解析；产 v2 `time` | 改（Task 4） |
| `tests/memory-extractor.test.mjs` | 抽取解析单测 | 改（Task 4） |
| `src/core/continuity-store.mjs` | 合并/渲染/惰性迁移 v2 | 改（Task 5） |
| `tests/continuity-store.test.mjs` | 合并/迁移单测 | 改（Task 5） |
| `src/core/quality-gates.mjs` | `buildFactCheckMessages` 加 `storyClock` 参数 + 喂 time | 改（Task 6） |
| `tests/quality-gates.test.mjs` | 上者单测（**不新增 import**） | 改（Task 6） |
| `src/core/agent-engine.mjs` | `runFactCheck` 传时钟；`extractChapterMemory` 接检查器（只报本章） | 改（Task 7） |
| `tests/agent-engine.test.mjs` | 装配/过滤单测 | 改（Task 7） |
| `src/app-shell/thread-renderer.js` | 主动徽标认 `timeline_check` | 改（Task 8） |
| `tests/app-shell/app-shell-static.test.mjs` | 源码断言徽标已接 | 改（Task 8） |

---

## Task 1: 解析器（elapsed token + 日期 + 锚点）

**Files:** Create `src/core/timeline-check.mjs`、`tests/timeline-check.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `tests/timeline-check.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { parseElapsedToken, parseDateRaw, parseAnchorValue } from "../src/core/timeline-check.mjs";

test("parseElapsedToken: 合法 token 转小时", () => {
  assert.equal(parseElapsedToken("+0"), 0);
  assert.equal(parseElapsedToken("+12h"), 12);
  assert.equal(parseElapsedToken("+3d"), 72);
  assert.equal(parseElapsedToken("+2w"), 336);
  assert.equal(parseElapsedToken("+1mo"), 720);
  assert.equal(parseElapsedToken("+1y"), 8760);
});

test("parseElapsedToken: 非法/空返回 null", () => {
  assert.equal(parseElapsedToken(null), null);
  assert.equal(parseElapsedToken("三天后"), null);
  assert.equal(parseElapsedToken("-3d"), null);
  assert.equal(parseElapsedToken(""), null);
});

test("parseDateRaw: 带年份可比较，YYYYMMDD 单调（含跨年）", () => {
  const a = parseDateRaw("2021年3月10日");
  const b = parseDateRaw("2021年3月5日");
  assert.equal(a.comparable, true);
  assert.equal(b.comparable, true);
  assert.ok(a.value > b.value);
  // 跨年：2020年12月31日 应早于 2021年1月1日
  assert.ok(parseDateRaw("2020年12月31日").value < parseDateRaw("2021年1月1日").value);
  // 中文数字等价
  assert.equal(parseDateRaw("二千零二十一年三月五日").value, parseDateRaw("2021年3月5日").value);
});

test("parseDateRaw: 不带年份 → comparable:false（防跨年误报）", () => {
  assert.equal(parseDateRaw("3月10日").comparable, false);
  assert.equal(parseDateRaw("某天"), null);
  assert.equal(parseDateRaw("10日").comparable, false);
});

test("parseAnchorValue: age 取整数年龄，date 走日期，named/空→null", () => {
  assert.deepEqual(parseAnchorValue({ type: "age", raw: "20岁" }), { unit: "year", value: 20 });
  assert.deepEqual(parseAnchorValue({ type: "age", raw: "二十岁" }), { unit: "year", value: 20 });
  assert.equal(parseAnchorValue({ type: "date", raw: "2021年3月10日" }).comparable, true);
  assert.equal(parseAnchorValue({ type: "named", raw: "登基大典" }), null);
  assert.equal(parseAnchorValue(null), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/timeline-check.test.mjs`
Expected: FAIL（`Cannot find module '../src/core/timeline-check.mjs'`）

- [ ] **Step 3: 写实现**

Create `src/core/timeline-check.mjs`:

```js
// 故事时钟：纯函数。token/日期/锚点解析 + 故事时钟累加 + 确定性时序裁决。无文件 IO。
import { parseChineseChapterNo } from "./quality-gates.mjs";

const UNIT_HOURS = { h: 1, d: 24, w: 168, mo: 720, y: 8760 }; // mo≈30d, y≈365d

// elapsed token → 小时数；"+0"→0；非法→null
export function parseElapsedToken(token) {
  if (token == null) return null;
  const s = String(token).trim();
  if (s === "+0" || s === "0") return 0;
  const m = /^\+(\d+)(h|d|w|mo|y)$/u.exec(s);
  if (!m) return null;
  return Number(m[1]) * UNIT_HOURS[m[2]];
}

function cnNum(seg) {
  const n = parseChineseChapterNo(seg);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function matchNum(s, pattern) {
  const m = new RegExp(pattern, "u").exec(s);
  return m ? cnNum(m[1]) : null;
}

// 日期原文 → { comparable, value }；value 为 YYYYMMDD 式单调序号；
// comparable 仅当带年份（不带年份的"X月Y日"跨年会误判，故不参与裁决）；完全无日期→null
export function parseDateRaw(raw) {
  const s = String(raw ?? "");
  const num = "([0-9〇零一二两三四五六七八九十百千]+)";
  const year = matchNum(s, num + "\\s*年");
  const month = matchNum(s, num + "\\s*月");
  const day = matchNum(s, num + "\\s*[日号]");
  if (year == null && month == null && day == null) return null;
  return { comparable: year != null, value: (year ?? 0) * 10000 + (month ?? 0) * 100 + (day ?? 0) };
}

// 锚点 → { unit:"year", value }（age）或 { comparable, value }（date）；不可解析→null
export function parseAnchorValue(anchor) {
  if (!anchor || typeof anchor !== "object") return null;
  const raw = String(anchor.raw ?? "");
  if (anchor.type === "age") {
    const n = cnNum(raw);
    return n == null ? null : { unit: "year", value: n };
  }
  if (anchor.type === "date") return parseDateRaw(raw);
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/timeline-check.test.mjs`
Expected: PASS（5 个 test）

- [ ] **Step 5: 提交**

```bash
git add src/core/timeline-check.mjs tests/timeline-check.test.mjs
git commit -m "feat(timeline): story-clock token/date/anchor parsers"
```

---

## Task 2: 故事时钟累加 `computeStoryClock` / `describeStoryClock`

**Files:** Modify `src/core/timeline-check.mjs`、`tests/timeline-check.test.mjs`

- [ ] **Step 1: 写失败测试**（追加到 `tests/timeline-check.test.mjs`）

```js
import { computeStoryClock, describeStoryClock } from "../src/core/timeline-check.mjs";

const sc = (chapter_no, elapsed, extra = {}) => ({
  chapter_no, events: ["e"], story_time_raw: extra.raw ?? "",
  time: { kind: extra.kind ?? "scene", elapsed, anchor: extra.anchor ?? null, confidence: extra.confidence ?? "high" }
});

test("computeStoryClock: 累加 elapsed 得第几天", () => {
  const { perChapter, latest } = computeStoryClock([
    sc(1, null), sc(2, "+1d"), sc(3, "+3d")
  ]);
  assert.equal(perChapter.get(1).day, 0);
  assert.equal(perChapter.get(2).day, 1);
  assert.equal(perChapter.get(3).day, 4);
  assert.equal(latest.chapter_no, 3);
  assert.equal(latest.certain, true);
});

test("computeStoryClock: 中间 elapsed=null 标记不确定", () => {
  const { latest } = computeStoryClock([sc(1, null), sc(2, null), sc(3, "+2d")]);
  assert.equal(latest.certain, false);
});

test("computeStoryClock: flashback 不进主链", () => {
  const { perChapter } = computeStoryClock([
    sc(1, null), sc(2, "+1d"), sc(3, "+0", { kind: "flashback" }), sc(4, "+2d")
  ]);
  assert.equal(perChapter.has(3), false);
  assert.equal(perChapter.get(4).day, 3);
});

test("describeStoryClock: 生成喂提示的摘要", () => {
  assert.match(describeStoryClock([sc(1, null), sc(2, "+3d")]), /第 ?2 ?章/u);
  assert.match(describeStoryClock([sc(1, null), sc(2, "+3d")]), /第 ?3 ?天/u);
  assert.equal(describeStoryClock([]), "");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/timeline-check.test.mjs`
Expected: FAIL（`computeStoryClock is not a function`）

- [ ] **Step 3: 写实现**（追加到 `src/core/timeline-check.mjs`）

```js
const SCENE = "scene";

function sceneNodes(timeline) {
  return (Array.isArray(timeline) ? timeline : [])
    .filter((n) => n?.time?.kind === SCENE)
    .sort((a, b) => (a.chapter_no ?? 0) - (b.chapter_no ?? 0));
}

// 沿 scene 链累加 elapsed → { perChapter:Map<chapter_no,{day,certain}>, latest }
export function computeStoryClock(timeline) {
  const scenes = sceneNodes(timeline);
  const perChapter = new Map();
  let day = 0;
  let certain = true;
  scenes.forEach((n, i) => {
    if (i > 0) {
      const hrs = parseElapsedToken(n.time.elapsed);
      if (hrs == null) certain = false;
      else day += hrs / 24;
    }
    perChapter.set(n.chapter_no, { day: Math.round(day * 10) / 10, certain });
  });
  const last = scenes[scenes.length - 1];
  const latest = last ? { chapter_no: last.chapter_no, ...perChapter.get(last.chapter_no) } : null;
  return { perChapter, latest };
}

// 故事时钟摘要行（喂给 fact-check 提示）；空→""
export function describeStoryClock(timeline) {
  const { latest } = computeStoryClock(timeline);
  if (!latest) return "";
  const approx = latest.certain ? "" : "（部分时间未言明，为下界）";
  return `截至第 ${latest.chapter_no} 章，故事时钟约为第 ${latest.day} 天${approx}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/timeline-check.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/timeline-check.mjs tests/timeline-check.test.mjs
git commit -m "feat(timeline): accumulate running story-clock from elapsed"
```

---

## Task 3: 确定性裁决 `checkTimeline`（防误报）

**Files:** Modify `src/core/timeline-check.mjs`、`tests/timeline-check.test.mjs`

只判 `confidence:"high"`、`kind:"scene"`：date_regression 只比带年份完整日期；age_regression 只比填了 subject 的年龄。

- [ ] **Step 1: 写失败测试**（追加到 `tests/timeline-check.test.mjs`）

```js
import { checkTimeline, summarizeTimelineViolations } from "../src/core/timeline-check.mjs";

const an = (chapter_no, kind, anchor, confidence = "high") => ({
  chapter_no, events: ["e"], story_time_raw: anchor?.raw ?? "",
  time: { kind, elapsed: null, anchor, confidence }
});

test("checkTimeline: 带年份日期倒退报 time_reversal", () => {
  const { violations } = checkTimeline([
    an(3, "scene", { type: "date", raw: "2021年3月10日" }),
    an(5, "scene", { type: "date", raw: "2021年3月5日" })
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, "time_reversal");
  assert.equal(violations[0].chapter_no, 5);
  assert.equal(violations[0].prior_chapter, 3);
});

test("checkTimeline: 不带年份月日（跨年）不误报", () => {
  const { violations } = checkTimeline([
    an(3, "scene", { type: "date", raw: "12月20日" }),
    an(5, "scene", { type: "date", raw: "1月5日" })
  ]);
  assert.equal(violations.length, 0);
});

test("checkTimeline: 闪回不算倒流", () => {
  const { violations } = checkTimeline([
    an(3, "scene", { type: "date", raw: "2021年3月10日" }),
    an(5, "flashback", { type: "date", raw: "2021年3月5日" })
  ]);
  assert.equal(violations.length, 0);
});

test("checkTimeline: 同 subject 年龄倒退报 anchor_conflict", () => {
  const { violations } = checkTimeline([
    an(2, "scene", { type: "age", raw: "20岁", subject: "主角" }),
    an(6, "scene", { type: "age", raw: "18岁", subject: "主角" })
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, "anchor_conflict");
  assert.equal(violations[0].chapter_no, 6);
});

test("checkTimeline: 空 subject 的不同年龄不串桶误报", () => {
  const { violations } = checkTimeline([
    an(2, "scene", { type: "age", raw: "40岁", subject: null }),
    an(6, "scene", { type: "age", raw: "18岁", subject: null })
  ]);
  assert.equal(violations.length, 0);
});

test("checkTimeline: 低置信不判", () => {
  const { violations } = checkTimeline([
    an(3, "scene", { type: "date", raw: "2021年3月10日" }, "high"),
    an(5, "scene", { type: "date", raw: "2021年3月5日" }, "low")
  ]);
  assert.equal(violations.length, 0);
});

test("summarizeTimelineViolations: 用传入章号、含建议", () => {
  const note = summarizeTimelineViolations(
    [{ type: "time_reversal", chapter_no: 5, prior_chapter: 3, severity: "high", detail: "", suggestion: "建议调整其一" }], 5);
  assert.match(note, /第 ?5 ?章/u);
  assert.match(note, /建议/u);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/timeline-check.test.mjs`
Expected: FAIL（`checkTimeline is not a function`）

- [ ] **Step 3: 写实现**（追加到 `src/core/timeline-check.mjs`）

```js
// timeline[] (v2) → { violations:[{type,chapter_no,prior_chapter,detail,severity,suggestion}] }
export function checkTimeline(timeline) {
  const violations = [];
  const scenes = sceneNodes(timeline).filter((n) => n.time?.confidence === "high");

  // date_regression：仅比较带年份完整日期（防跨年误报）
  let lastDate = null; // { value, chapter_no, raw }
  for (const n of scenes) {
    if (n.time.anchor?.type !== "date") continue;
    const parsed = parseAnchorValue(n.time.anchor);
    if (!parsed || !parsed.comparable) continue;
    if (lastDate && parsed.value < lastDate.value) {
      violations.push({
        type: "time_reversal", chapter_no: n.chapter_no, prior_chapter: lastDate.chapter_no,
        severity: "high", detail: `${n.time.anchor.raw} < ${lastDate.raw}`,
        suggestion: `第${n.chapter_no}章的时间（${n.time.anchor.raw}）早于第${lastDate.chapter_no}章（${lastDate.raw}）。若非回忆/闪回，建议调整其一以保持时间顺序。`
      });
    }
    if (!lastDate || parsed.value >= lastDate.value) {
      lastDate = { value: parsed.value, chapter_no: n.chapter_no, raw: n.time.anchor.raw };
    }
  }

  // age_regression：仅比较填了 subject 的年龄，按 subject 分组（防串桶误报）
  const lastAge = new Map(); // subject -> { value, chapter_no }
  for (const n of scenes) {
    if (n.time.anchor?.type !== "age") continue;
    const subject = n.time.anchor.subject;
    if (!subject) continue;
    const parsed = parseAnchorValue(n.time.anchor);
    if (!parsed) continue;
    const prev = lastAge.get(subject);
    if (prev && parsed.value < prev.value) {
      violations.push({
        type: "anchor_conflict", chapter_no: n.chapter_no, prior_chapter: prev.chapter_no,
        severity: "high", detail: `${subject}年龄 ${parsed.value} < ${prev.value}`,
        suggestion: `第${n.chapter_no}章中${subject}的年龄（${parsed.value}）小于第${prev.chapter_no}章（${prev.value}）。若非回忆/闪回，建议核对年龄。`
      });
    }
    if (!prev || parsed.value >= prev.value) lastAge.set(subject, { value: parsed.value, chapter_no: n.chapter_no });
  }

  return { violations };
}

// 取首条冲突生成 agent 主动提示文案（章号由调用方传入，确保与"较晚一方"一致）
export function summarizeTimelineViolations(violations, chapterNo) {
  if (!Array.isArray(violations) || violations.length === 0) return "";
  const v = violations[0];
  const more = violations.length > 1 ? `（另有 ${violations.length - 1} 处）` : "";
  return `第 ${chapterNo} 章可能存在时间线矛盾：${v.suggestion}${more}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/timeline-check.test.mjs`
Expected: PASS（全部）

- [ ] **Step 5: 提交**

```bash
git add src/core/timeline-check.mjs tests/timeline-check.test.mjs
git commit -m "feat(timeline): deterministic date/age regression checks (false-positive guarded)"
```

---

## Task 4: memory-extractor 产出并解析 v2 `time`

**Files:** Modify `src/core/memory-extractor.mjs:5-14`、`:56-60`；Test `tests/memory-extractor.test.mjs`

- [ ] **Step 1: 写失败测试**（追加到 `tests/memory-extractor.test.mjs`）

```js
test("parseMemoryExtraction: 解析 v2 结构化 time", () => {
  const raw = JSON.stringify({ summary: "s", facts: [],
    timeline: [{ chapter_no: 9, story_time_raw: "三天后的傍晚", events: ["探查"],
      time: { kind: "scene", elapsed: "+3d", anchor: { type: "date", raw: "3月10日", subject: null }, confidence: "high" } }],
    characters: [] });
  const t = parseMemoryExtraction(raw).timeline[0];
  assert.equal(t.story_time_raw, "三天后的傍晚");
  assert.equal(t.time.kind, "scene");
  assert.equal(t.time.elapsed, "+3d");
  assert.equal(t.time.anchor.type, "date");
  assert.equal(t.time.confidence, "high");
});

test("parseMemoryExtraction: 旧 story_time 降级为 raw + 默认 low time", () => {
  const raw = JSON.stringify({ summary: "s", facts: [],
    timeline: [{ chapter_no: 9, story_time: "十月下旬", events: ["探查"] }], characters: [] });
  const t = parseMemoryExtraction(raw).timeline[0];
  assert.equal(t.story_time_raw, "十月下旬");
  assert.equal(t.time.kind, "scene");
  assert.equal(t.time.elapsed, null);
  assert.equal(t.time.anchor, null);
  assert.equal(t.time.confidence, "low");
});

test("parseMemoryExtraction: 非法 time 字段降级不抛", () => {
  const raw = JSON.stringify({ summary: "s", facts: [],
    timeline: [{ chapter_no: 1, events: ["e"], story_time_raw: "x",
      time: { kind: "weird", elapsed: "三天", anchor: "bad", confidence: "maybe" } }], characters: [] });
  const t = parseMemoryExtraction(raw).timeline[0];
  assert.equal(t.time.kind, "scene");
  assert.equal(t.time.elapsed, null);
  assert.equal(t.time.anchor, null);
  assert.equal(t.time.confidence, "low");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/memory-extractor.test.mjs`
Expected: FAIL（`t.time` undefined）

- [ ] **Step 3a: 改 SYSTEM_PROMPT**（替换 `src/core/memory-extractor.mjs` 第 5-14 行）

```js
const SYSTEM_PROMPT = [
  "你是小说项目的记忆管理员。读完本章后更新全书记忆。",
  "只输出一个 JSON 对象（可用 ```json 围栏），不要输出其他内容。结构：",
  '{"summary":"全书滚动摘要(中文,<=2000字,覆盖到本章为止的主线、关键事实与未回收伏笔)",',
  '"facts":[{"entity":"实体名","attribute":"属性","value":"值","chapter_no":本章号,"quote":"原文短引(<=40字)"}],',
  '"timeline":[{"chapter_no":本章号,"story_time_raw":"故事内时间的原话","events":["事件"],',
  '"time":{"kind":"scene|flashback|parallel|dream","elapsed":"相对上一幕过了多久","anchor":{"type":"date|age|named","raw":"原文","subject":"谁(age 时填,否则 null)"}或 null,"confidence":"high|low"}}],',
  '"characters":[{"name":"角色名","traits":["标志性特征"],"status":"状态","chapter_no":本章号}]}',
  "facts 只收新增或被修正的客观设定（地点、数字、时间、生死、关系），不收主观评价。",
  "time.kind：推进当前主线=scene；回忆/闪回=flashback；同时/另一视角=parallel；梦境/虚构=dream。",
  'time.elapsed：相对上一个 scene 过了多久，规范成 "+0"(同时/当日) 或 "+数字h/d/w/mo/y"(如 "+3d"、"+12h")；说不清填 null。',
  "time.anchor：原文给了绝对时间才填（绝对日期/角色年龄/具名时点），age 必须在 subject 写明是谁；否则 anchor 填 null，不要把相对时间塞进 anchor。",
  "time.confidence：对该幕时间判断有把握=high，模糊/拿不准=low。回忆请用 kind=flashback，不要用负的 elapsed。",
  "若本章与既有记忆冲突，照实提取本章版本，不要擅自调和。"
].join("\n");
```

- [ ] **Step 3b: 加 time 规范化函数**（插入在 `parseMemoryExtraction` 之后、`normalizeArray` 之前）

```js
const TIME_KINDS = new Set(["scene", "flashback", "parallel", "dream"]);
const ANCHOR_TYPES = new Set(["date", "age", "named"]);

function normalizeElapsed(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === "+0" || s === "0") return "+0";
  return /^\+(\d+)(h|d|w|mo|y)$/u.test(s) ? s : null;
}

function normalizeAnchor(value) {
  if (!value || typeof value !== "object") return null;
  const type = ANCHOR_TYPES.has(value.type) ? value.type : null;
  const raw = String(value.raw ?? "").trim();
  if (!type || !raw) return null;
  const subject = value.subject == null ? null : (String(value.subject).slice(0, 40) || null);
  return { type, raw: raw.slice(0, 60), subject };
}

function normalizeTimeField(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    kind: TIME_KINDS.has(v.kind) ? v.kind : "scene",
    elapsed: normalizeElapsed(v.elapsed),
    anchor: normalizeAnchor(v.anchor),
    confidence: v.confidence === "high" ? "high" : "low"
  };
}
```

- [ ] **Step 3c: 改 timeline 解析块**（替换第 56-60 行）

```js
  const timeline = normalizeArray(data.timeline, (item) => ({
    chapter_no: Number(item.chapter_no) || null,
    story_time_raw: String(item.story_time_raw ?? item.story_time ?? "").slice(0, 120),
    events: Array.isArray(item.events) ? item.events.map((e) => String(e)).slice(0, 10) : [],
    time: normalizeTimeField(item.time)
  }), (t) => t.chapter_no !== null);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/memory-extractor.test.mjs`
Expected: PASS（旧测试因 `story_time` 回落仍过 + 3 新测试过）

- [ ] **Step 5: 提交**

```bash
git add src/core/memory-extractor.mjs tests/memory-extractor.test.mjs
git commit -m "feat(memory): extract structured story-time (kind/elapsed/anchor/subject)"
```

---

## Task 5: continuity-store 合并/渲染/迁移 v2

**Files:** Modify `src/core/continuity-store.mjs`；Test `tests/continuity-store.test.mjs`

- [ ] **Step 1: 写失败测试**（追加到 `tests/continuity-store.test.mjs`）

```js
test("mergeExtraction: 写入 v2 timeline（raw + time）", () => {
  const merged = mergeExtraction(
    { schema_version: 2, facts: [], timeline: [], characters: [] },
    { facts: [], characters: [], timeline: [
      { chapter_no: 5, story_time_raw: "三日后", events: ["上工地"],
        time: { kind: "scene", elapsed: "+3d", anchor: null, confidence: "high" } } ] }
  );
  assert.equal(merged.timeline.length, 1);
  assert.equal(merged.timeline[0].story_time_raw, "三日后");
  assert.equal(merged.timeline[0].time.elapsed, "+3d");
});

test("loadContinuity: v1 节点惰性迁移为 v2", async () => {
  const root = await tmpProject();
  await fs.writeFile(path.join(root, "memory", "continuity.json"), JSON.stringify({
    schema_version: 1, facts: [], characters: [],
    timeline: [{ chapter_no: 1, story_time: "十月", events: ["觉醒"] }]
  }), "utf8");
  const data = await loadContinuity(root);
  assert.equal(data.schema_version, 2);
  const t = data.timeline[0];
  assert.equal(t.story_time_raw, "十月");
  assert.equal(t.time.kind, "scene");
  assert.equal(t.time.confidence, "low");
  assert.equal(t.time.elapsed, null);
});

test("renderContinuityMarkdown: 时间线优先 raw 并带 time 摘要", () => {
  const md = renderContinuityMarkdown({ schema_version: 2, facts: [], characters: [], timeline: [
    { chapter_no: 5, story_time_raw: "三日后", events: ["上工地"],
      time: { kind: "scene", elapsed: "+3d", anchor: null, confidence: "high" } } ] });
  assert.match(md, /第5章/u);
  assert.match(md, /三日后/u);
  assert.match(md, /\+3d/u);
  assert.match(md, /上工地/u);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/continuity-store.test.mjs`
Expected: FAIL（`schema_version` 仍 1 / `t.time` undefined / md 无 `+3d`）

- [ ] **Step 3a: 升版本号 + 迁移工具**

`src/core/continuity-store.mjs` 第 3 行改为：

```js
export const CONTINUITY_SCHEMA_VERSION = 2;
```

在 `EMPTY`（第 6 行）之后新增：

```js
function migrateTimelineNode(node) {
  const n = node && typeof node === "object" ? node : {};
  const base = {
    chapter_no: n.chapter_no ?? null,
    events: Array.isArray(n.events) ? n.events : [],
    story_time_raw: String(n.story_time_raw ?? n.story_time ?? "")
  };
  if (n.time && typeof n.time === "object") return { ...base, time: n.time };
  return { ...base, time: { kind: "scene", elapsed: null, anchor: null, confidence: "low" } };
}
```

- [ ] **Step 3b: loadContinuity 迁移 + 升版本**（替换第 8-16 行）

```js
export async function loadContinuity(projectRoot) {
  const data = await readJson(safeJoin(projectRoot, "memory", "continuity.json"), EMPTY());
  return {
    schema_version: CONTINUITY_SCHEMA_VERSION,
    facts: Array.isArray(data.facts) ? data.facts : [],
    timeline: (Array.isArray(data.timeline) ? data.timeline : []).map(migrateTimelineNode),
    characters: Array.isArray(data.characters) ? data.characters : []
  };
}
```

- [ ] **Step 3c: mergeExtraction timeline 块**（替换第 37-40 行）

```js
  for (const node of extraction.timeline ?? []) {
    const incoming = migrateTimelineNode(node);
    const fp = incoming.events.join("¦");
    const dup = next.timeline.find((t) => t.chapter_no === incoming.chapter_no && (t.events ?? []).join("¦") === fp);
    if (!dup) next.timeline.push(incoming);
  }
```

- [ ] **Step 3d: renderContinuityMarkdown 时间线块**（替换第 77-80 行）

```js
  lines.push("", "## 时间线");
  for (const t of [...data.timeline].sort((a, b) => (a.chapter_no ?? 0) - (b.chapter_no ?? 0))) {
    const node = migrateTimelineNode(t);
    const tags = [node.time.elapsed, node.time.kind !== "scene" ? node.time.kind : null].filter(Boolean).join("·");
    const meta = tags ? ` [${tags}]` : "";
    const when = node.story_time_raw || (node.time.anchor?.raw ?? "");
    lines.push(`- 第${node.chapter_no}章${when ? ` [${when}]` : ""}${meta}: ${node.events.join("；")}`);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/continuity-store.test.mjs`
Expected: PASS（旧"次日"那条 `timeline.length===1` 仍成立 + 3 新测试过）

- [ ] **Step 5: 提交**

```bash
git add src/core/continuity-store.mjs tests/continuity-store.test.mjs
git commit -m "feat(continuity): v2 timeline schema with lazy v1 migration"
```

---

## Task 6: fact-check 喂入故事时钟（修 A1：不重复 import）

**Files:** Modify `src/core/quality-gates.mjs`（`FACT_CHECK_SYSTEM_PROMPT` 加一行、`buildFactCheckMessages` 加 `storyClock` 参数与时间线渲染）；Test `tests/quality-gates.test.mjs`

> **A1 关键：`tests/quality-gates.test.mjs:3` 已 import `buildFactCheckMessages`，本任务测试直接用，严禁再写 import。**

- [ ] **Step 1: 写失败测试**（追加到 `tests/quality-gates.test.mjs` 末尾，**不加 import**）

```js
test("buildFactCheckMessages: 注入故事时钟 + 时间线带 raw/elapsed/anchor", () => {
  const messages = buildFactCheckMessages({
    chapterNo: 9, draft: "案发当晚他就到了。",
    facts: [{ entity: "刘康", attribute: "生死", value: "死亡", chapter_no: 1 }],
    timeline: [{ chapter_no: 7, story_time_raw: "三天后", events: ["抵达工地"],
      time: { kind: "scene", elapsed: "+3d", anchor: { type: "date", raw: "3月10日", subject: null }, confidence: "high" } }],
    storyClock: "截至第 7 章，故事时钟约为第 3 天"
  });
  const user = messages[1].content;
  assert.match(user, /三天后/u);
  assert.match(user, /\+3d/u);
  assert.match(user, /故事时钟/u);
  assert.match(user, /第 3 天/u);
});

test("buildFactCheckMessages: 无 storyClock 不渲染时钟段、兼容旧 story_time", () => {
  const messages = buildFactCheckMessages({
    chapterNo: 2, draft: "x", facts: [{ entity: "a", attribute: "b", value: "c", chapter_no: 1 }],
    timeline: [{ chapter_no: 1, story_time: "十月", events: ["e"] }]
  });
  const user = messages[1].content;
  assert.match(user, /十月/u);
  assert.doesNotMatch(user, /故事时钟/u);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/quality-gates.test.mjs`
Expected: FAIL（user 无 `故事时钟`）

- [ ] **Step 3a: FACT_CHECK_SYSTEM_PROMPT 加一行**

把 `src/core/quality-gates.mjs` 中该行：

```js
  "豁免：回忆/闪回/角色撒谎/隐喻/旁白不算矛盾。",
```

改为（在其后插入一行）：

```js
  "豁免：回忆/闪回/角色撒谎/隐喻/旁白不算矛盾。",
  "若提供了「故事时钟」，据其判断本章的时间叙述（如「当晚」「次日」「三天后」）是否与已推进的天数矛盾。",
```

- [ ] **Step 3b: buildFactCheckMessages 加 storyClock + 时间线渲染**（替换 `buildFactCheckMessages` 第 217-227 行整段）

```js
export function buildFactCheckMessages({ chapterNo, draft, facts, timeline, storyClock }) {
  const timelineLines = (timeline ?? []).map((t) => {
    const time = t.time ?? {};
    const when = t.story_time_raw ?? t.story_time ?? "";
    const extra = [time.elapsed, time.anchor?.raw, time.kind && time.kind !== "scene" ? time.kind : null].filter(Boolean).join("·");
    return `- 第${t.chapter_no}章 [${when}${extra ? `·${extra}` : ""}]: ${(t.events ?? []).join("；")}`;
  }).join("\n") || "(空)";
  const user = [
    `# 第 ${chapterNo} 章正文`,
    String(draft ?? ""),
    "",
    "# 既有事实",
    (facts ?? []).map((f) => `- ${f.entity}/${f.attribute}: ${f.value} (第${f.chapter_no}章)`).join("\n") || "(空)",
    "",
    "# 既有时间线",
    timelineLines,
    ...(storyClock ? ["", "# 故事时钟", String(storyClock)] : [])
  ].join("\n");
  return [
    { role: "system", content: FACT_CHECK_SYSTEM_PROMPT },
    { role: "user", content: user }
  ];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/quality-gates.test.mjs`
Expected: PASS（旧 fact-check 测试 + 2 新测试全过；无重复 import 报错）

- [ ] **Step 5: 提交**

```bash
git add src/core/quality-gates.mjs tests/quality-gates.test.mjs
git commit -m "feat(factcheck): inject computed story-clock into fact-check prompt"
```

---

## Task 7: agent-engine 接入（runFactCheck 传时钟；extract 只报本章）

**Files:** Modify `src/core/agent-engine.mjs`；Test `tests/agent-engine.test.mjs`

> 设计取舍：相对漂移一键修复走 `runFactCheck`（已喂时钟）；确定性命中走 `extractChapterMemory` 内**通知型**（修 A4：仅报 `chapter_no === 本章` 的冲突 → 天然去重 + 标题章号正确）。

- [ ] **Step 1: 加导入**（紧邻 `from "./quality-gates.mjs"` 那行之后）

```js
import { checkTimeline, summarizeTimelineViolations, describeStoryClock } from "./timeline-check.mjs";
```

- [ ] **Step 2: runFactCheck 注入时钟**（在 `buildFactCheckMessages({ chapterNo: ..., draft, facts: ..., timeline: ... })` 调用，约第 726-729 行，加 `storyClock`）

把：

```js
        messages: buildFactCheckMessages({
          chapterNo: state.current_chapter_no, draft,
          facts: continuity.facts, timeline: continuity.timeline
        }),
```

改为：

```js
        messages: buildFactCheckMessages({
          chapterNo: state.current_chapter_no, draft,
          facts: continuity.facts, timeline: continuity.timeline,
          storyClock: describeStoryClock(continuity.timeline)
        }),
```

- [ ] **Step 3: extractChapterMemory 接确定性通知**（替换约第 658-661 行：从 `const merged = ...` 到 `await saveContinuityState(...)`）

```js
    const merged = mergeExtraction(continuity, parsed);
    await saveContinuity(projectRoot, merged);
    await writeFileAtomic(safeJoin(projectRoot, "memory", "book_summary.md"), `# 全书摘要\n\n${parsed.summary}\n`);
    await saveContinuityState(projectRoot, { last_extracted_chapter: chapterNo });

    // 故事时钟确定性检查：只报"较晚一方=本章"的冲突（去重 + 标题章号正确）
    const { violations } = checkTimeline(merged.timeline);
    const newViolations = violations.filter((v) => v.chapter_no === chapterNo);
    if (newViolations.length > 0) {
      await appendEvent(projectRoot, {
        type: "quality_gate_warning", project_id: project.project_id, chapter_no: chapterNo,
        stage: "summarizing", severity: "warn",
        message: `时间线检查发现 ${newViolations.length} 处疑似矛盾`,
        data: { violations: newViolations }
      });
      await appendChatMessage(projectRoot, {
        role: "assistant", content: summarizeTimelineViolations(newViolations, chapterNo),
        proactive: "timeline_check", chapter_no: chapterNo
      });
    }
```

- [ ] **Step 4: 写装配/过滤单测**（追加到 `tests/agent-engine.test.mjs`）

```js
test("timeline-check 装配 + 只报本章的过滤逻辑", async () => {
  const mod = await import("../src/core/timeline-check.mjs");
  const timeline = [
    { chapter_no: 3, events: ["e"], story_time_raw: "", time: { kind: "scene", elapsed: null, anchor: { type: "date", raw: "2021年3月10日" }, confidence: "high" } },
    { chapter_no: 5, events: ["e"], story_time_raw: "", time: { kind: "scene", elapsed: null, anchor: { type: "date", raw: "2021年3月5日" }, confidence: "high" } }
  ];
  const all = mod.checkTimeline(timeline).violations;
  assert.equal(all.length, 1);
  // 抽取第 5 章时只报较晚一方=5 的冲突
  assert.equal(all.filter((v) => v.chapter_no === 5).length, 1);
  // 抽取第 3 章时不会冒出该冲突（避免重复打扰）
  assert.equal(all.filter((v) => v.chapter_no === 3).length, 0);
  assert.match(mod.describeStoryClock(timeline), /故事时钟|第/u);
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/agent-engine.test.mjs tests/timeline-check.test.mjs`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/core/agent-engine.mjs tests/agent-engine.test.mjs
git commit -m "feat(agent): feed story-clock to fact-check; notify-only deterministic timeline conflicts"
```

---

## Task 8: 前端主动徽标认 `timeline_check`（修 A6）

**Files:** Modify `src/app-shell/thread-renderer.js:921-926`；Test `tests/app-shell/app-shell-static.test.mjs`

- [ ] **Step 1: 写失败测试**（追加到 `tests/app-shell/app-shell-static.test.mjs`）

```js
test("thread-renderer 主动徽标认 timeline_check 类型", () => {
  assert.match(threadRendererSource, /timeline_check/, "thread-renderer 应识别 timeline_check 主动消息");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/app-shell/app-shell-static.test.mjs`
Expected: FAIL（源码未含 `timeline_check`）

- [ ] **Step 3: 改 thread-renderer**（替换 `src/app-shell/thread-renderer.js` 第 921-926 行）

把：

```js
    if (message.proactive === "fact_check") {
      const badge = document.createElement("span");
      badge.className = "chat-proactive-badge";
      badge.textContent = "fact-check";
      bubble.append(badge);
    }
```

改为：

```js
    const proactiveBadge = { fact_check: "fact-check", timeline_check: "时间线" };
    if (message.proactive && proactiveBadge[message.proactive]) {
      const badge = document.createElement("span");
      badge.className = "chat-proactive-badge";
      badge.textContent = proactiveBadge[message.proactive];
      bubble.append(badge);
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/app-shell/app-shell-static.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/app-shell/thread-renderer.js tests/app-shell/app-shell-static.test.mjs
git commit -m "feat(app-shell): render timeline_check proactive badge"
```

---

## Task 9: 全量回归 + 真实 API 观察（修 A7：不押概率门）

> **A7：不把无锚点的相对冲突 fixture 加进 100% 拦截在线门**（模型一抖即红）。相对漂移机制的**稳定回归信号是 Task 6 的"故事时钟入提示词"单测**；端到端效果用真实 API**观察**（不 gating）。

- [ ] **Step 1: 跑单测全量**

Run: `node --test tests/*.test.mjs tests/app-shell/*.test.mjs`
Expected: PASS（既有 599 条 + 本计划新增全部通过；若失败回对应 Task 修复重跑）

- [ ] **Step 2: 桌面壳回归（CLAUDE.md 铁律；本计划改了 thread-renderer）**

Run（依次）：
```bash
npm run verify:app-shell
npm run verify:app-clickability
```
Expected: 均 ok（`verify:app-clickability` 偶发 hover 抖动 ok:false 重跑一次，见记忆 clickability-flaky-hover）。

- [ ] **Step 3: 迁移自检（有 v1 项目时）**

对一个已有 v1 项目：必要时把 `memory/continuity_state.json` 的 `last_extracted_chapter` 置 0，再跑 `npm run audit:rebuild-memory <projectRoot>`。
Expected: `continuity.json` timeline 节点出现 `story_time_raw` + `time`；`continuity.md` 正常渲染（含 `[+Xd]` 标签）；无报错。
无 v1 项目则依赖 Task 5 惰性迁移单测，记录说明。

- [ ] **Step 4: 真实 API 观察（有 key 时；§8#3b，不 gating）**

Run: `npm run verify:chat-online`
Expected（观察，非硬门）：场景 C 既有 fixture 仍过；另在真实项目里构造"第 7 章=案发三天后、第 9 章草稿写'案发当晚'"，确认起草第 9 章时 fact-check 借故事时钟判出冲突并给 `replace_with`。记录结果。
无 key 则跳过并记"待联网观察"，不阻塞合并。

---

## Self-Review（对照 spec 自检）

**1. Spec 覆盖（§4 Part A + §8）**
- §4.1 抽取改造 → Task 4 ✓
- §4.2 合并/渲染/兼容 → Task 5 ✓
- §4.3 故事时钟模块（computeStoryClock + checkTimeline 两类裁决）→ Task 2、3 ✓；**clock_anchor_conflict（§4.3 标注"低频"）本期不实装**——粗粒度日期 ordinal 与 elapsed 互校易引入新误报，与 A3"宁缺毋滥"原则冲突，后置（已在此披露，不再"悄悄换语义"）。
- §4.4 两路径（通知型确定性 + LLM 喂时钟一键修复 + 前端徽标）→ Task 6/7/8 ✓
- §4.5 迁移 → Task 5 + Task 9 Step 3 ✓
- §8#1 结构正确 → Task 4、5 ✓；#2 时钟+确定性（含跨年不误报、空 subject 不误报、闪回豁免、低置信不判）→ Task 2、3 ✓；#3a 确定性通知（标题=较晚章、不重复刷）→ Task 7 Step 4 ✓；#3b LLM 喂时钟一键（时钟入提示词单测 + 真实 API 观察）→ Task 6 Step 1 + Task 9 Step 4 ✓；#4 迁移 → Task 5 + Task 9 Step 3 ✓；#5 不增调用（抽取调用次数不变、检查零调用）✓；#10 全量 verify → Task 9 ✓

**2. 占位符扫描**：无 TBD/TODO；每步给出完整可粘贴代码与确切命令/预期。✓

**3. 类型一致性**：`time{kind,elapsed,anchor{type,raw,subject},confidence}` 跨 Task 4（产）/5（存迁）/6（读）/2-3（检查）命名一致；`parseElapsedToken`/`parseDateRaw`/`parseAnchorValue`/`computeStoryClock`/`describeStoryClock`/`checkTimeline`/`summarizeTimelineViolations` 跨 Task 与 agent-engine 调用一致；violation `{type,chapter_no,prior_chapter,detail,severity,suggestion}` Task 3 定义、Task 7 过滤/消费一致；`buildFactCheckMessages` 新增 `storyClock` 参数在 Task 6 定义、Task 7 传入一致。✓

**4. 评审硬伤对账**：A1 Task 6（不再 import，显式告警）✓；A2 Task 2+6（故事时钟喂 LLM）✓；A3 Task 3（date 仅带年、age 仅带 subject + 专门反例测试）✓；A4 Task 7（仅报本章 + 传入章号）✓；A5 Task 7（确定性诚实改通知型，一键归 LLM 路径）✓；A6 Task 8 ✓；A7 Task 9（不押概率门，单测作主信号）✓。

**无法本地验证项**：§8#3b 端到端（真实模型确实凭时钟判出"当晚"冲突）依赖联网，标注为观察步（Task 9 Step 4），不 gating。
