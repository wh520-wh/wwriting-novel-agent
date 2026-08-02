import { countEffectiveWords } from "./word-count.mjs";
import { formatChapterRef } from "./continuity-store.mjs";
import { registerSchema, parseStructuredOutput } from "./structured-output.mjs";

// 注册 fact_check@v1 schema（模块加载时执行一次，registerSchema 幂等）
registerSchema("fact_check", "v1", {
  normalize: (data) => {
    const conflicts = Array.isArray(data?.conflicts) ? data.conflicts : [];
    return {
      conflicts: conflicts.map((c) => {
        const rawQuote = String(c.draft_quote ?? "");
        return {
          draft_quote: rawQuote.slice(0, 200),
          // 引文超 200 字会被截断；自动修复用截断后的引文做 indexOf+replace 会留下后半段造成乱码，
          // 调用方据此后退为只报告、不自动改。
          draft_quote_truncated: rawQuote.length > 200,
          conflicts_with: String(c.conflicts_with ?? "").slice(0, 200),
          prior_chapter: Number(c.prior_chapter) || null,
          severity: c.severity === "low" ? "low" : "high",
          suggestion: String(c.suggestion ?? "").slice(0, 400),
          replace_with: String(c.replace_with ?? "").slice(0, 200)
        };
      }).filter((c) => c.draft_quote && c.conflicts_with)
    };
  },
  validate: (n) => ({ ok: true })  // conflicts 可为空数组，不缺字段即合法
});

// =============== 字数门禁：word-count-gate ===============

const PADDING_RISK_RATIO = 0.15; // 差距占 minWords 比例 < 15% 时判定为"接近达标，容易靠注水补齐"

// 注册 word_count@v1 schema（模块加载时执行一次，registerSchema 幂等）
// 契约对象即 runWordCountGate 的返回值；供调用方用 parseStructuredOutput 结构化解析门禁结果（含 padding_risk）。
registerSchema("word_count", "v1", {
  normalize: (data) => {
    const status = data?.status === "passed" ? "passed" : data?.status === "failed" ? "failed" : null;
    return {
      gate: "word-count-gate",
      status,
      actual_words: Number(data?.actual_words) || 0,
      min_words: Number(data?.min_words) || 0,
      shortfall: Number(data?.shortfall) || 0,
      padding_risk: Boolean(data?.padding_risk),
      instruction: String(data?.instruction ?? "")
    };
  },
  validate: (n) => (n.status
    ? { ok: true }
    : { ok: false, code: "missing_field", field: "status", message: "word_count 结果缺少 status（passed|failed）" })
});

export function runWordCountGate(content, minWords) {
  const actualWords = countEffectiveWords(content);
  if (actualWords >= minWords) {
    return {
      gate: "word-count-gate",
      status: "passed",
      actual_words: actualWords,
      min_words: minWords,
      shortfall: 0,
      padding_risk: false
    };
  }
  const shortfall = minWords - actualWords;
  const paddingRisk = shortfall / minWords < PADDING_RISK_RATIO;
  const baseInstruction = `Chapter is short by ${shortfall} effective words. Continue through a file-writing tool; do not claim the word count is reached.`;
  // 防注水约束：差距占 minWords 比例 < 15% 时判定为"接近达标、容易靠注水补齐"，追加中文指令（文案中文，供 UI/日志展示）
  const antiPaddingNote = " 新增情节或对话推进内容，不要重复已有句子、堆砌冗余描写或用注水文字凑数。";
  return {
    gate: "word-count-gate",
    status: "failed",
    actual_words: actualWords,
    min_words: minWords,
    shortfall,
    padding_risk: paddingRisk,
    instruction: paddingRisk ? baseInstruction + antiPaddingNote : baseInstruction
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
        any = true;
      } else if (unit >= 10) {
        section += (lastDigit || 1) * unit;
        lastDigit = 0;
        // 纯单位（如「十」=10、「二十」=20）也算有数字：与 timeline-check.parseCnNumber 一致，
        // 否则「第十章」解析为 null 会被 runTitleGate 的 foundNum===null 分支绕过（合法数字标题漏检）。
        any = true;
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
  '{"conflicts":[{"draft_quote":"本章内一句触发冲突的原文","conflicts_with":"既有设定/时间线中的对应记录","prior_chapter":既有章节号,"severity":"high|low","suggestion":"修复建议（说明改哪边、为什么）","replace_with":"用于直接替换 draft_quote 的修正后原文（保持句式，只改冲突值；若无法给出精确替换则留空字符串）"}]}',
  "只报客观叙述层的设定冲突（地点、数字、时间、生死、关系）。",
  "豁免：回忆/闪回/角色撒谎/隐喻/旁白不算矛盾。",
  "若提供了「故事时钟」，据其判断本章的时间叙述（如「当晚」「次日」「三天后」）是否与已推进的天数矛盾。",
  "若没有冲突，输出 {\"conflicts\":[]}。",
  "不要输出其他内容。"
].join("\n");

export function buildFactCheckMessages({ chapterNo, draft, facts, timeline, storyClock }) {
  const timelineLines = (timeline ?? []).map((t) => {
    const time = t.time ?? {};
    const when = t.story_time_raw ?? t.story_time ?? "";
    const extra = [time.elapsed, time.anchor?.raw, time.kind && time.kind !== "scene" ? time.kind : null].filter(Boolean).join("·");
    return `- ${formatChapterRef(t.chapter_no)} [${when}${extra ? `·${extra}` : ""}]: ${(t.events ?? []).join("；")}`;
  }).join("\n") || "(空)";
  const user = [
    `# 第 ${chapterNo} 章正文`,
    String(draft ?? ""),
    "",
    "# 既有事实",
    (facts ?? []).map((f) => `- ${f.entity}/${f.attribute}: ${f.value} (${formatChapterRef(f.chapter_no)})`).join("\n") || "(空)",
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

// parseFactCheck 委托 structured-output，error 保持字符串 + error_code/error_field（向后兼容）
export function parseFactCheck(rawText) {
  const result = parseStructuredOutput("fact_check", "v1", rawText);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error.message ?? result.error.code,   // 字符串，agent-engine.mjs:770 的 ${parsed?.error} 不破
      error_code: result.error.code,
      error_field: result.error.field ?? null
    };
  }
  return { ok: true, conflicts: result.data.conflicts };
}
