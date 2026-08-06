// Task 6 Step 1: reasoning ticker 单测（fake clock，无 DOM）。
//
// 覆盖（brief Step 1 逐条）：
//   - 自然断点为换行或 。！？.!?；;
//   - 当前片段至少停留 dwellMs（默认 800ms）
//   - 积压时只保留最新完整片段
//   - finish 立即停止 timer 并返回未展示的文本
//   - 未完成尾段与后续增量拼接成完整片段；reset 清空状态；dwellMs 可配置。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReasoningTicker } from "../../src/app-shell/agent/reasoning-ticker.mjs";

// 确定性 fake clock：setTimeout/clearTimeout 由 advance(ms) 驱动。
function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { id, fn, at }
  return {
    now: () => now,
    advance(ms) {
      now += ms;
      const due = [...timers.values()]
        .filter((t) => t.at <= now)
        .sort((a, b) => a.at - b.at);
      for (const t of due) {
        if (!timers.has(t.id)) continue;
        timers.delete(t.id);
        t.fn();
      }
    },
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  };
}

test("自然断点：换行与中英文标点都切分完整语义片段", () => {
  const displays = [];
  const clock = createFakeClock();
  const ticker = createReasoningTicker({ onDisplay: (t) => displays.push(t), scheduler: clock });
  for (const chunk of ["先检查\n", "再核对。", "是否准确？", "OK!", "无误.", "然后?", "分号；", "末尾;", "再验证。"]) {
    ticker.push(chunk);
    clock.advance(800);
  }
  assert.deepEqual(
    displays,
    ["先检查\n", "再核对。", "是否准确？", "OK!", "无误.", "然后?", "分号；", "末尾;", "再验证。"],
    "换行与 。！？.!?；; 都是完整片段断点"
  );
  ticker.finish();
});

test("当前片段至少停留 dwellMs（默认 800ms），首片段立即显示", () => {
  const displays = [];
  const clock = createFakeClock();
  const ticker = createReasoningTicker({ onDisplay: (t) => displays.push(t), scheduler: clock });
  ticker.push("第一。");
  assert.deepEqual(displays, ["第一。"], "首个完整片段立即显示，不等 dwellMs");
  ticker.push("第二。");
  assert.deepEqual(displays, ["第一。"], "停留期间到达的新片段不打断当前显示");
  clock.advance(400);
  assert.deepEqual(displays, ["第一。"], "不足 800ms 仍不切换");
  clock.advance(400);
  assert.deepEqual(displays, ["第一。", "第二。"], "满 800ms 后切换");
  ticker.finish();
});

test("积压时只保留最新完整片段", () => {
  const displays = [];
  const clock = createFakeClock();
  const ticker = createReasoningTicker({ onDisplay: (t) => displays.push(t), scheduler: clock });
  // 单次 burst 含三个完整片段：只保留最新一个，中间片段直接丢弃
  ticker.push("甲。乙。丙。");
  assert.deepEqual(displays, ["丙。"], "burst 只显示最新完整片段");
  clock.advance(800);
  assert.deepEqual(displays, ["丙。"], "积压已清空，不重复显示");
  // 分次到达：先显示 甲。，积压只保留最新 丙。
  ticker.push("甲。");
  assert.deepEqual(displays, ["丙。", "甲。"]);
  ticker.push("乙。");
  ticker.push("丙。");
  assert.deepEqual(displays, ["丙。", "甲。"], "计时期间只更新积压的最新片段");
  clock.advance(800);
  assert.deepEqual(displays, ["丙。", "甲。", "丙。"], "dwell 结束后显示积压的最新片段");
  ticker.finish();
});

test("finish 立即停止 timer 并返回未展示的文本", () => {
  const displays = [];
  const clock = createFakeClock();
  const ticker = createReasoningTicker({ onDisplay: (t) => displays.push(t), scheduler: clock });
  ticker.push("完整。");
  ticker.push("未完"); // 无断点 → 留在 carry
  const leftover = ticker.finish();
  assert.equal(leftover, "未完", "finish 返回未展示的 carry");
  clock.advance(5000);
  assert.deepEqual(displays, ["完整。"], "finish 后不再显示任何片段");
  // 积压中存在未展示的完整片段时，finish 同样返回（不延迟折叠）
  const clock2 = createFakeClock();
  const displays2 = [];
  const ticker2 = createReasoningTicker({ onDisplay: (t) => displays2.push(t), scheduler: clock2 });
  ticker2.push("A。");
  ticker2.push("B。"); // 计时中积压
  const leftover2 = ticker2.finish();
  assert.equal(leftover2, "B。", "finish 返回未展示的完整片段");
  clock2.advance(5000);
  assert.deepEqual(displays2, ["A。"], "finish 不延迟折叠、不再显示");
});

test("未完成尾段与后续增量拼接成一个完整片段", () => {
  const displays = [];
  const clock = createFakeClock();
  const ticker = createReasoningTicker({ onDisplay: (t) => displays.push(t), scheduler: clock });
  ticker.push("先检查");
  assert.deepEqual(displays, [], "无断点时不显示");
  ticker.push("事实。");
  assert.deepEqual(displays, ["先检查事实。"], "尾段与后续增量拼接后切分");
  ticker.finish();
});

test("dwellMs 可配置", () => {
  const displays = [];
  const clock = createFakeClock();
  const ticker = createReasoningTicker({ onDisplay: (t) => displays.push(t), dwellMs: 200, scheduler: clock });
  ticker.push("一。");
  clock.advance(199);
  assert.deepEqual(displays, ["一。"]);
  clock.advance(1);
  assert.deepEqual(displays, ["一。"], "到期无积压则停止计时");
  ticker.push("二。");
  assert.deepEqual(displays, ["一。", "二。"], "无计时器时新片段立即显示");
  ticker.finish();
});

test("reset 清空计时与状态", () => {
  const displays = [];
  const clock = createFakeClock();
  const ticker = createReasoningTicker({ onDisplay: (t) => displays.push(t), scheduler: clock });
  ticker.push("遗留"); // 未完成尾段留在 carry
  ticker.reset();      // 丢弃 carry / pending，停止 timer
  ticker.push("甲。");
  assert.deepEqual(displays, ["甲。"], "reset 丢弃遗留 carry，不拼出「遗留甲。」");
  ticker.push("乙。");
  assert.deepEqual(displays, ["甲。"], "重置后的新片段同样遵守 dwell");
  clock.advance(800);
  assert.deepEqual(displays, ["甲。", "乙。"], "dwell 结束后显示新片段");
  clock.advance(800);
  assert.deepEqual(displays, ["甲。", "乙。"], "reset 前遗留的计时不触发");
  ticker.finish();
});
