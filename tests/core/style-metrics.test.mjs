// tests/core/style-metrics.test.mjs —— round17 第二部分 T2（本轮唯一必留检查）。
// 已知坏样本逐词手算对账；阈值为 v1 启发值（style-metrics.mjs 头注释）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeStyleMetrics, HEDGING_CAP_PER_1000, SENTENCE_CV_FLOOR, HEDGING_WORDS
} from "../../src/core/style-metrics.mjs";

// 逐词手算：可见文本 = 两句中文。
// S1 "他仿佛愣住了，似乎有些莫名。" CJK=12；S2 "他不禁后退…下意识摸向口袋。"
// CJK=46（他不禁后退5 不由得握紧拳6 缓缓吸气4 微微发抖4 瞬间顿悟4 顿时安静4
//          淡淡一笑4 轻轻放下4 隐隐作痛4 下意识摸向口袋7）。
// effective_count = 58；词表命中各 1 次，共 13；per_1000 = 13000/58 = 224.14。
const BAD_SOURCE = `---
title: hidden
---
<!-- segment:1 -->
他仿佛愣住了，似乎有些莫名。
他不禁后退，不由得握紧拳，缓缓吸气，微微发抖，瞬间顿悟，顿时安静，淡淡一笑，轻轻放下，隐隐作痛，下意识摸向口袋。`;

test("已知坏样本：词表计数、per_1000 与 words 直方图逐词对账", () => {
  const m = analyzeStyleMetrics(BAD_SOURCE);
  assert.equal(m.effective_count, 58);
  assert.equal(m.hedging.total, 13);
  assert.equal(m.hedging.per_1000, 224.14);
  assert.equal(m.hedging.over, true);
  assert.equal(m.hedging.cap_per_1000, HEDGING_CAP_PER_1000);
  // 直方图省略 0 次词（悄然/不由自主），按次数降序、次数同按词序（此处全 1，按码点序）。
  assert.deepEqual(Object.keys(m.hedging.words),
    ["下意识", "不由得", "不禁", "仿佛", "似乎", "微微", "淡淡", "瞬间", "缓缓", "莫名", "轻轻", "隐隐", "顿时"]);
  // 句数 2 < 3 → cv 不判定。
  assert.deepEqual(m.sentences, { count: 2, mean_length: 29, cv: null, floor: SENTENCE_CV_FLOOR, below_floor: false });
  // 各短句二字窗口互不相同 → 0 排比命中。
  assert.deepEqual(m.parallel, { count: 0, hits: [] });
});

test("同样本改写后密度下降 ≥50%（调研 P0 验收信号的 fixture 镜像）", () => {
  const good = analyzeStyleMetrics(`他愣住了。雨不停。他后退，握紧拳，吸气，发抖，顿悟，安静，一笑，放下，作痛，摸向口袋。`);
  const bad = analyzeStyleMetrics(BAD_SOURCE);
  assert.equal(good.hedging.total, 0);
  assert.equal(good.hedging.per_1000, 0);
  assert.equal(good.hedging.over, false);
  assert.ok(bad.hedging.per_1000 > 0 && good.hedging.per_1000 <= bad.hedging.per_1000 / 2);
});

test("句长变异：均匀句长 cv<0.4 触发 below_floor，长短交错不触发", () => {
  const uniform = analyzeStyleMetrics("山很高。河很宽。路很长。");
  // 3 句各 3 字：mean=3, std=0, cv=0 < 0.4。
  assert.equal(uniform.sentences.count, 3);
  assert.equal(uniform.sentences.mean_length, 3);
  assert.equal(uniform.sentences.cv, 0);
  assert.equal(uniform.sentences.below_floor, true);

  const varied = analyzeStyleMetrics("山。河流非常宽阔绵延不绝，望不到边际，一直流向天边与大海的尽头。路长。");
  // 句长 [1,27,2]：mean=10，std=√(434/3)=12.03，cv=1.20。
  assert.equal(varied.sentences.cv, 1.2);
  assert.equal(varied.sentences.below_floor, false);
});

test("三连排比：「他握住刀，握住恨，握住命。」命中 prefix=握住；非排比 0 命中", () => {
  const hit = analyzeStyleMetrics("他握住刀，握住恨，握住命。");
  assert.equal(hit.parallel.count, 1);
  assert.deepEqual(hit.parallel.hits[0], { prefix: "握住", repeat: 3, excerpt: "他握住刀，握住恨，握住命。" });

  const miss = analyzeStyleMetrics("他握住刀。她看着远处，风吹过来，云散开了。");
  assert.equal(miss.parallel.count, 0);
});

test("空文本 / 纯标点 / 单句：不炸、cv=null、per_1000=0", () => {
  for (const src of ["", "。，！", "他走了。"]) {
    const m = analyzeStyleMetrics(src);
    assert.equal(m.hedging.total, 0);
    assert.equal(m.hedging.per_1000, 0);
    assert.equal(m.hedging.over, false);
    assert.equal(m.sentences.cv, null);
    assert.equal(m.sentences.below_floor, false);
    assert.equal(m.parallel.count, 0);
  }
  assert.equal(analyzeStyleMetrics("").sentences.count, 0);
});

test("frontmatter 与代码块被剥离不计", () => {
  const m = analyzeStyleMetrics("---\ntitle: 仿佛\n---\n正文干干净净。\n\n```text\n仿佛 似乎 缓缓\n```\n\n收束一句。");
  assert.equal(m.hedging.total, 0);
  assert.equal(m.effective_count, 10);
  assert.deepEqual(HEDGING_WORDS.length, 15);
});
