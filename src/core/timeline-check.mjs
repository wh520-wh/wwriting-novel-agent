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
