import { countEffectiveWords } from "./word-count.mjs";

export function runWordCountGate(content, minWords) {
  const actualWords = countEffectiveWords(content);
  if (actualWords >= minWords) {
    return {
      gate: "word-count-gate",
      status: "passed",
      actual_words: actualWords,
      min_words: minWords,
      shortfall: 0
    };
  }
  return {
    gate: "word-count-gate",
    status: "failed",
    actual_words: actualWords,
    min_words: minWords,
    shortfall: minWords - actualWords,
    instruction: `Chapter is short by ${minWords - actualWords} effective words. Continue through a file-writing tool; do not claim the word count is reached.`
  };
}

export function assertToolCallForChapter(output, context = {}) {
  if (!output || output.type !== "tool_call") {
    return {
      ok: false,
      code: "invalid_output_channel",
      message: "Chapter body must be written through a tool_call, not delivered in chat."
    };
  }

  const allowedTools = context.allowedTools ?? ["append_chapter_segment"];
  if (!allowedTools.includes(output.tool)) {
    return {
      ok: false,
      code: "unsupported_tool",
      message: `Unsupported tool for chapter writing: ${output.tool ?? "missing"}`
    };
  }
  if (!output.input || typeof output.input !== "object") {
    return {
      ok: false,
      code: "missing_tool_input",
      message: "Tool call input is required."
    };
  }

  const input = output.input;
  if (context.project_id && input.project_id !== context.project_id) {
    return {
      ok: false,
      code: "invalid_project_id",
      message: "Tool call project_id does not match the active project."
    };
  }
  if (!Number.isInteger(input.chapter_no) || input.chapter_no < 1) {
    return {
      ok: false,
      code: "invalid_chapter_no",
      message: "Tool call chapter_no must be a positive integer."
    };
  }
  if (context.chapter_no !== undefined && input.chapter_no !== context.chapter_no) {
    return {
      ok: false,
      code: "invalid_chapter_no",
      message: "Tool call chapter_no does not match the active chapter."
    };
  }
  if (!Number.isInteger(input.segment_no) || input.segment_no < 1) {
    return {
      ok: false,
      code: "invalid_segment_no",
      message: "Tool call segment_no must be a positive integer."
    };
  }
  if (context.segment_no !== undefined && input.segment_no !== context.segment_no) {
    return {
      ok: false,
      code: "invalid_segment_no",
      message: "Tool call segment_no does not match the expected next segment."
    };
  }
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    return {
      ok: false,
      code: "empty_content",
      message: "Tool call content must be a non-empty string."
    };
  }

  const maxContentChars = context.maxContentChars ?? 200_000;
  if (input.content.length > maxContentChars) {
    return {
      ok: false,
      code: "content_too_large",
      message: `Tool call content exceeds ${maxContentChars} characters.`
    };
  }

  return { ok: true };
}

// =============== S3 本地门禁：title + word-cap ===============

// 中文数字解析：一～九百九十九（覆盖常用范围）
const CN_DIGITS = { "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
const CN_UNITS = { "十": 10, "百": 100, "千": 1000, "万": 10000 };

export function parseChineseChapterNo(text) {
  if (text == null) return null;
  const s = String(text);
  // 阿拉伯数字：直接取
  const arabic = s.match(/[0-9]+/u);
  if (arabic) {
    const n = Number(arabic[0]);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  // 中文数字：逐字符累计
  let result = 0;
  let section = 0;
  let lastDigit = 0;
  let any = false;
  for (const ch of s) {
    if (Object.prototype.hasOwnProperty.call(CN_DIGITS, ch)) {
      lastDigit = CN_DIGITS[ch];
      any = true;
    } else if (Object.prototype.hasOwnProperty.call(CN_UNITS, ch)) {
      const unit = CN_UNITS[ch];
      if (unit === 10000) {
        result = (result + section + lastDigit) * unit;
        section = 0;
        lastDigit = 0;
      } else if (unit >= 10) {
        section += (lastDigit || 1) * unit;
        lastDigit = 0;
      }
    }
  }
  const total = result + section + lastDigit;
  return any && total > 0 ? total : null;
}

export function runTitleGate(content, chapterNo) {
  // 扫描所有行首 #{1,3}\s*第(...)+章；若任一标题与期望章号不一致，则失败
  const lines = String(content ?? "").split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^\s{0,3}#{1,3}\s*第\s*([^\s章节章]+?)\s*章/u.exec(line);
    if (m) {
      hits.push({ foundText: `第${m[1]}章`, foundNum: parseChineseChapterNo(m[1]), line: i + 1 });
    }
  }
  if (hits.length === 0) {
    return { gate: "chapter-title-gate", status: "passed", found_title: null, line: 0 };
  }
  // 第一个标题必须匹配 chapterNo；其它任何标题的章号不等于 chapterNo 也视为串章失败
  for (const hit of hits) {
    if (hit.foundNum !== null && hit.foundNum !== chapterNo) {
      return {
        gate: "chapter-title-gate",
        status: "failed",
        found_title: hit.foundText,
        expected_chapter: chapterNo,
        line: hit.line
      };
    }
  }
  const first = hits[0];
  return { gate: "chapter-title-gate", status: "passed", found_title: first.foundText, line: first.line };
}

export function runWordCapGate(actualWords, { targetWords, maxWords, outputPricePerMillion } = {}) {
  const actual = Number(actualWords) || 0;
  const target = Number(targetWords) || 0;
  const max = Number(maxWords) > 0 ? Number(maxWords) : Math.round(target * 1.5);
  if (actual <= max) {
    return {
      gate: "word-cap-gate",
      status: "passed",
      actual_words: actual,
      max_words: max,
      overflow_words: 0,
      overflow_cost_estimate: null
    };
  }
  const overflow = actual - max;
  let cost = null;
  if (Number.isFinite(Number(outputPricePerMillion)) && Number(outputPricePerMillion) > 0) {
    // 中文 1 字 ≈ 1.5 token 粗估
    cost = overflow * 1.5 / 1e6 * Number(outputPricePerMillion);
  }
  return {
    gate: "word-cap-gate",
    status: "warning",
    actual_words: actual,
    max_words: max,
    overflow_words: overflow,
    overflow_cost_estimate: cost
  };
}

// =============== S3 fact-check 门禁（纯函数部分） ===============

const FACT_CHECK_SYSTEM_PROMPT = [
  "你是小说事实核查员。读完本章后比对既有设定档案，挑出本章与既有事实/时间线之间的客观冲突。",
  "只输出一个 JSON 对象（可用 ```json 围栏），结构：",
  '{"conflicts":[{"draft_quote":"本章内一句触发冲突的原文","conflicts_with":"既有设定/时间线中的对应记录","prior_chapter":既有章节号,"severity":"high|low","suggestion":"修复建议（说明改哪边、目标值）"}]}',
  "只报客观叙述层的设定冲突（地点、数字、时间、生死、关系）。",
  "豁免：回忆/闪回/角色撒谎/隐喻/旁白不算矛盾。",
  "若没有冲突，输出 {\"conflicts\":[]}。",
  "不要输出其他内容。"
].join("\n");

export function buildFactCheckMessages({ chapterNo, draft, facts, timeline }) {
  const user = [
    `# 第 ${chapterNo} 章正文`,
    String(draft ?? ""),
    "",
    "# 既有事实",
    (facts ?? []).map((f) => `- ${f.entity}/${f.attribute}: ${f.value} (第${f.chapter_no}章)`).join("\n") || "(空)",
    "",
    "# 既有时间线",
    (timeline ?? []).map((t) => `- 第${t.chapter_no}章 [${t.story_time}]: ${(t.events ?? []).join("；")}`).join("\n") || "(空)"
  ].join("\n");
  return [
    { role: "system", content: FACT_CHECK_SYSTEM_PROMPT },
    { role: "user", content: user }
  ];
}

export function parseFactCheck(rawText) {
  const text = String(rawText ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  let data;
  try {
    data = JSON.parse(candidate);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  const conflicts = Array.isArray(data?.conflicts) ? data.conflicts : [];
  const normalized = conflicts
    .map((c) => ({
      draft_quote: String(c.draft_quote ?? "").slice(0, 200),
      conflicts_with: String(c.conflicts_with ?? "").slice(0, 200),
      prior_chapter: Number(c.prior_chapter) || null,
      severity: c.severity === "low" ? "low" : "high",
      suggestion: String(c.suggestion ?? "").slice(0, 400)
    }))
    .filter((c) => c.draft_quote && c.conflicts_with);
  return { ok: true, conflicts: normalized };
}
