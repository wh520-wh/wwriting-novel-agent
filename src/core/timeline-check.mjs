// 故事时钟：纯函数。token/日期/锚点解析 + 故事时钟累加 + 确定性时序裁决。无文件 IO。

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

const CN_DIGITS = { "〇":0,"零":0,"一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9 };
const CN_UNITS = { "十":10,"百":100,"千":1000 };

// 独立中文数字解析（含纯单位"十"=10），不依赖章号解析器。
// 注：阿拉伯数字按"首个数字串"提取（与旧 parseChineseChapterNo 一致，兼容 "20岁" 这种带后缀的 raw）；
// 中文数字循环中忽略非数位/单位字符（如 "岁""月""日"），以兼容带后缀的 age raw。
function parseCnNumber(seg) {
  const s = String(seg ?? "").trim();
  if (!s) return null;
  const arabic = s.match(/[0-9]+/u);
  if (arabic) return Number(arabic[0]);
  let total = 0, section = 0, hasDigit = false;
  for (const ch of s) {
    if (ch in CN_DIGITS) { section = CN_DIGITS[ch]; hasDigit = true; }
    else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (section === 0) section = 1; // "十" → 1*10
      total += section * unit;
      section = 0;
    }
    // 其他字符忽略（与旧解析器一致，兼容 "岁"/"月"/"日" 等后缀）
  }
  total += section;
  return hasDigit || total > 0 ? total : null;
}

function cnNum(seg) {
  const n = parseCnNumber(seg);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function matchNum(s, pattern) {
  const m = new RegExp(pattern, "u").exec(s);
  return m ? cnNum(m[1]) : null;
}

// 日期原文 → { comparable, value }；value 为 YYYYMMDD 式单调序号；
// comparable 仅当年/月/日齐全（完整绝对日期）。只有年或年+月粒度过粗：
// 月粒度（"2021年10月"）相对同月具体日（"2021年10月5日"）可前可后，非稳判，混比会误报倒退，故不参与确定性裁决（留给 LLM 路径）。完全无日期→null
export function parseDateRaw(raw) {
  const s = String(raw ?? "");
  const num = "([0-9〇零一二两三四五六七八九十百千]+)";
  const year = matchNum(s, num + "\\s*年");
  const month = matchNum(s, num + "\\s*月");
  const day = matchNum(s, num + "\\s*[日号]");
  if (year == null && month == null && day == null) return null;
  return { comparable: year != null && month != null && day != null, value: (year ?? 0) * 10000 + (month ?? 0) * 100 + (day ?? 0) };
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
  return `截至第 ${latest.chapter_no} 章，故事时钟约为第 ${Math.round(latest.day)} 天${approx}`;
}

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
