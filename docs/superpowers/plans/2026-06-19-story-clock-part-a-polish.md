# 故事时钟 Part A 收尾改进计划（eval2 · 第二次验收）

> 目标：修复第二次验收确认的 1 个 P1 bug（B1：日期混合粒度误报），TDD，不破坏既有 731 测试，**不动 `comparable` 契约**。
> 执行方式：superpowers TDD——先写失败测试，跑红，改实现，跑绿，最后全量回归。
>
> **本文件为第二次验收（eval2-with-skill）的收尾计划。** 上一版 polish（6 个 Fix）已落地于 commit `43ab4e9`，见 git 历史；本版只处理上一版遗留的 B1。

## 背景

Part A 已交付（8 feat 提交 + 1 fix 提交 `43ab4e9`，731 测试全绿）。第一次验收的 Fix 1 把 `comparable` 从「有年份」收紧为「有年份 **且**（有月或有日）」，并**刻意保留** `parseDateRaw("2021年3月").comparable === true`（测试 `tests/timeline-check.test.mjs:155` 锁定，注释"粒度足够"）。

但这一决定留下一个盲区：**月粒度日期（无日，`value` 末两位=0）参与裁决时，会被排到该月月初，与同月的日粒度日期比较时产生假倒退。** 这就是 B1。曾有一次尝试（commit `895e6b8`）通过把 `comparable` 改成「必须年月日齐全」来修 B1，但那**改动了 `comparable` 契约**、会破坏 `:155` 测试，已被 `4764866` revert。当前代码状态以 `4764866` 为准，B1 仍存在。

本计划按 skill 原则#6「最小改动、保护既有契约」：**不改 `comparable` 语义，只在比较处按粒度对齐。**

---

## Fix 1（P1 Bug）：日期混合粒度比较产生假倒退（B1）

**问题**：`src/core/timeline-check.mjs:121-137` 的 `date_regression` 循环里，`lastDate` 与当前日期都直接比 `parsed.value`。月粒度日期（如 "2021年3月"）`value = 20210300`（日位=0），会被排到 3 月 1 日之前；当故事里先出现 "2021年3月15日"（`20210315`）、再出现 "2021年3月"（`20210300`）时，`20210300 < 20210315` 触发 `time_reversal`。但 "2021年3月" 可能指 3 月任意一天（含 15 日之后），并非确定倒退 → **误报**，违反 A3「宁缺毋滥」。

探针证据（修复前）：
```
ch3=2021年3月15日, ch5=2021年3月  => violations: 1 [{"type":"time_reversal","ch":5,"prior":3}]   ← 误报
parseDateRaw("2021年3月") => {"comparable":true,"value":20210300}                                ← 契约保留，不动
```

**修复**：`comparable` 契约**不变**（仍「有年且(有月或有日)」）。在 `checkTimeline` 的比较处按「双方最粗公共粒度」对齐：双方均有日 → 比完整 `value`；任一为月粒度 → 只比年月（`Math.floor(value/100)`）。这样同月混比判等不报（消误报），而「3 月→2 月」这类月粒度真实倒退仍能抓到（保覆盖，契合上一版「粒度足够」的意图）。

> **契约影响声明（按 skill 原则#6）**：本 Fix **不改 `parseDateRaw` / `comparable` 的语义或返回形状**，不触及 `parseAnchorValue`、渲染、fact-check 等消费方。改动仅限 `checkTimeline` 内部 `date_regression` 循环。`hasDay`/`monthValue` 在循环内由 `value` 派生（日位 1-31，0 表无日），不外泄。

**Step 1 失败测试**（追加到 `tests/timeline-check.test.mjs` 末尾）：

```js
test("checkTimeline: 月粒度与日粒度混比不误报倒退（B1）", () => {
  // 同年同月：日粒度在前、月粒度在后；月粒度可能落在该月任意一天，不应判倒退
  const { violations } = checkTimeline([
    an(3, "scene", { type: "date", raw: "2021年3月15日" }),
    an(5, "scene", { type: "date", raw: "2021年3月" })
  ]);
  assert.equal(violations.length, 0);
});

test("checkTimeline: 月粒度之间真实倒退仍报（防过度收窄）", () => {
  // 行为锁定：修复不得把月粒度日期整体踢出裁决（否则与上一版"粒度足够"意图相悖）
  const { violations } = checkTimeline([
    an(3, "scene", { type: "date", raw: "2021年3月" }),
    an(5, "scene", { type: "date", raw: "2021年2月" })
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, "time_reversal");
  assert.equal(violations[0].chapter_no, 5);
});
```

**Step 2 跑红**：`node --test tests/timeline-check.test.mjs` → 第一条 FAIL（`violations.length` 实测 1，预期 0）。第二条当前已绿（行为锁定，修复后仍须绿）。

**Step 3 实现**：把 `src/core/timeline-check.mjs` 中 `date_regression` 循环（`let lastDate = null;` 那段）

old:
```js
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
```

new:
```js
  // date_regression：仅比较带年份日期；混合粒度时取粗粒度比较（防"日 vs 同月月粒度"假倒退）。
  // 注：comparable 契约不变（有年且(有月或有日)即 true）；此处只在比较时按粒度对齐。
  let lastDate = null; // { value, monthValue, hasDay, chapter_no, raw }
  for (const n of scenes) {
    if (n.time.anchor?.type !== "date") continue;
    const parsed = parseAnchorValue(n.time.anchor);
    if (!parsed || !parsed.comparable) continue;
    const hasDay = parsed.value % 100 !== 0;            // 末两位为日(1-31)；0 表无日(月粒度)
    const monthValue = Math.floor(parsed.value / 100);  // YYYYMM
    if (lastDate) {
      // 双方均有日 → 比完整值；任一为月粒度 → 比年月（避免 day=0 排到月初造成假倒退）
      const cur = hasDay && lastDate.hasDay ? parsed.value : monthValue;
      const prev = hasDay && lastDate.hasDay ? lastDate.value : lastDate.monthValue;
      if (cur < prev) {
        violations.push({
          type: "time_reversal", chapter_no: n.chapter_no, prior_chapter: lastDate.chapter_no,
          severity: "high", detail: `${n.time.anchor.raw} < ${lastDate.raw}`,
          suggestion: `第${n.chapter_no}章的时间（${n.time.anchor.raw}）早于第${lastDate.chapter_no}章（${lastDate.raw}）。若非回忆/闪回，建议调整其一以保持时间顺序。`
        });
      }
    }
    if (!lastDate || parsed.value >= lastDate.value) {
      lastDate = { value: parsed.value, monthValue, hasDay, chapter_no: n.chapter_no, raw: n.time.anchor.raw };
    }
  }
```

**Step 4 跑绿**：`node --test tests/timeline-check.test.mjs` → 全绿（含两条新测试）。

---

## 全量回归（最后执行）

```bash
node --test tests/*.test.mjs tests/app-shell/*.test.mjs
```

Expected: 全绿（既有 731 + 本次新增 2 条 = 733 全通过）。

完成后单次提交（显式 add，不用 `-A`）：
```bash
git add src/core/timeline-check.mjs tests/timeline-check.test.mjs docs/superpowers/plans/2026-06-19-story-clock-part-a-polish.md
git commit -m "fix(timeline): compare dates at common granularity to kill mixed-granularity false reversal (B1)"
```

## Self-Review

- 本 Fix 防什么：消除「月粒度 vs 同月日粒度」比较的假 `time_reversal` 误报（B1），与 A3「宁缺毋滥」一致 ✓
- 补什么：同时锁定「月粒度之间真实倒退仍报」，防止未来有人把修复做成「月粒度整体踢出裁决」的过度收窄 ✓
- 有失败测试先行（第一条 B1 用例修复前实测 1 violation，预期 0 → 红）✓
- 不破坏既有测试：`checkTimeline: 带年份日期倒退报 time_reversal`（双方均有日，走完整值比较，行为不变）、`不带年份月日不误报`（`comparable:false` 提前 continue，不变）、闪回/低置信/空 subject 等路径均不变 ✓
- **不动 `comparable` 契约**：`parseDateRaw` / `parseAnchorValue` 一字未改；`"2021年3月".comparable` 仍为 `true`（`:155` 测试仍绿）。改动仅在 `checkTimeline` 内部 ✓
- 不动无关既有逻辑（age_regression 循环、sceneNodes 去重、computeStoryClock 均不动）✓
