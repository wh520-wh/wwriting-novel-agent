// src/core/style-metrics.mjs —— 客观风格统计（round17 第二部分 T1）。
// 纯函数、无 IO；复用 word-count.mjs 的 Markdown 剥离与口径（import，不复制）。
// 唯一消费入口是 style_stats 工具（definitions-knowledge.mjs）与测试；提交路径、
// 技能运行时、权限政策零改动（ADR 0008：参考值不是门禁）。
//
// ponytail: 两个阈值为 v1 启发值，非人类基线——待 20-30 段真人/AI 中文段落盲测
// 反推「人类区间」后校准（调研 Next Validation）；朴素切句不处理英文缩写省略号
// 歧义，对话引号内标点会把对白切碎（中文小说语境可接受）；排比只抓「二字 CJK
// 前缀连开」型（含一字主语前置），漏后缀式排比与变长首语重复，升级路径是词级
// n-gram 相似度。
import { stripMarkdownForCount, analyzeTextCount } from "./word-count.mjs";

export const HEDGING_CAP_PER_1000 = 5.0;
export const SENTENCE_CV_FLOOR = 0.4;
export const HEDGING_WORDS = [
  "仿佛", "似乎", "不禁", "不由得", "莫名", "悄然", "缓缓", "微微",
  "瞬间", "顿时", "淡淡", "轻轻", "隐隐", "不由自主", "下意识"
];

// 句末/短句切分。中英文标点都收（调研字符类只列了半角！?，全角在实际中文语料
// 中占多数，取并集是同尺寸的边角正确版）。
// 句子保留句末终结符（冻结契约：excerpt 含句末标点）；句长口径是
// effective_count，标点本就不计，保留对统计无副作用。
const SENTENCE_SPLIT = /[^。！？!?…；;]+[。！？!?…；;]*/gu;
const CLAUSE_SPLIT = /[，,、;；:：]+/u;

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const isHan = (ch) => /\p{Script=Han}/u.test(ch);

function countOccurrences(haystack, needle) {
  let count = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    count += 1;
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return count;
}

function splitSentences(visible) {
  return (visible.match(SENTENCE_SPLIT) ?? []).map((s) => s.trim()).filter(Boolean);
}

function analyzeHedging(visible, effectiveCount) {
  // 冻结契约：words 省略 0 次词，按次数降序、次数同按码点序（对象键插入序即输出序）。
  const words = Object.fromEntries(HEDGING_WORDS
    .map((word) => [word, countOccurrences(visible, word)])
    .filter(([, n]) => n > 0)
    .sort(([wa, na], [wb, nb]) => nb - na || (wa < wb ? -1 : 1)));
  const total = Object.values(words).reduce((a, b) => a + b, 0);
  // per_1000 先取整位再比较 over，保证展示值与判定一致（5.0 不会配 over=true）。
  const per1000 = effectiveCount > 0 ? round((total / effectiveCount) * 1000, 2) : 0;
  return {
    total,
    per_1000: per1000,
    cap_per_1000: HEDGING_CAP_PER_1000,
    over: per1000 > HEDGING_CAP_PER_1000,
    words
  };
}

function analyzeSentences(visible) {
  const sentences = splitSentences(visible);
  const lengths = sentences.map((s) => analyzeTextCount(s).effective_count);
  const count = sentences.length;
  const mean = count > 0 ? lengths.reduce((a, b) => a + b, 0) / count : 0;
  // 句数 < 3 或全空句（mean=0）时 cv 不判定——分母为 0 不是数据。
  const cv = count >= 3 && mean > 0
    ? round(Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / count) / mean, 2)
    : null;
  return {
    count,
    mean_length: count > 0 ? round(mean, 1) : 0,
    cv,
    floor: SENTENCE_CV_FLOOR,
    below_floor: cv !== null && cv < SENTENCE_CV_FLOOR
  };
}

// 三连排比候选：句内切短句，取每短句下标 0/1 处的二字 CJK 窗口（下标 1 容纳
// 「他握住刀」式一字主语），同一窗口连开 ≥3 个短句即命中，只列举不判定。
function detectParallelInSentence(sentence) {
  const clauses = sentence.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);
  if (clauses.length < 3) return null;
  const windows = clauses.map((c) => {
    const set = new Set();
    for (const start of [0, 1]) {
      const pair = c.slice(start, start + 2);
      if (pair.length === 2 && isHan(pair[0]) && isHan(pair[1])) set.add(pair);
    }
    return set;
  });
  let best = null;
  for (let i = 0; i < clauses.length - 2; i++) {
    for (const candidate of windows[i]) {
      let run = 1;
      while (i + run < clauses.length && windows[i + run].has(candidate)) run += 1;
      if (run >= 3 && (best === null || run > best.repeat)) best = { prefix: candidate, repeat: run };
    }
  }
  return best;
}

function analyzeParallel(visible) {
  const hits = [];
  for (const sentence of splitSentences(visible)) {
    const hit = detectParallelInSentence(sentence);
    if (hit) {
      hits.push({ ...hit, excerpt: sentence.length > 40 ? `${sentence.slice(0, 40)}…` : sentence });
    }
  }
  return { count: hits.length, hits };
}

export function analyzeStyleMetrics(source) {
  const visible = stripMarkdownForCount(source);
  const { effective_count } = analyzeTextCount(source);
  const hedging = analyzeHedging(visible, effective_count);
  return {
    effective_count,
    // 顶层镜像 hedging.per_1000（fixture P0 验收信号 good.per_1000 ≤ bad.hedging.per_1000/2 直接读顶层）。
    per_1000: hedging.per_1000,
    hedging,
    sentences: analyzeSentences(visible),
    parallel: analyzeParallel(visible)
  };
}
