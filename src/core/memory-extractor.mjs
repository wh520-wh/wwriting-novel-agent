// 记忆提取的消息构造与输出解析。纯函数，无文件 IO，便于单测与回放。
export const MEMORY_SUMMARY_MAX_CHARS = 2000;
export const MEMORY_EXTRACT_STAGE = "memory_extract";

const SYSTEM_PROMPT = [
  "你是小说项目的记忆管理员。读完本章后更新全书记忆。",
  "只输出一个 JSON 对象（可用 ```json 围栏），不要输出其他内容。结构：",
  '{"summary":"全书滚动摘要(中文,<=2000字,覆盖到本章为止的主线、关键事实与未回收伏笔)",',
  '"facts":[{"entity":"实体名","attribute":"属性","value":"值","chapter_no":本章号,"quote":"原文短引(<=40字)"}],',
  '"timeline":[{"chapter_no":本章号,"story_time":"故事内时间","events":["事件"]}],',
  '"characters":[{"name":"角色名","traits":["标志性特征"],"status":"状态","chapter_no":本章号}]}',
  "facts 只收新增或被修正的客观设定（地点、数字、时间、生死、关系），不收主观评价。",
  "若本章与既有记忆冲突，照实提取本章版本，不要擅自调和。"
].join("\n");

export function buildMemoryExtractionMessages({ chapterNo, chapterContent, bookSummary, continuityMarkdown }) {
  const user = [
    `# 第 ${chapterNo} 章正文`,
    String(chapterContent ?? ""),
    "",
    "# 既有全书摘要",
    String(bookSummary ?? "(空)"),
    "",
    "# 既有设定档案",
    String(continuityMarkdown ?? "(空)"),
    "",
    `请基于第 ${chapterNo} 章更新记忆，输出 JSON。`
  ].join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user }
  ];
}

export function parseMemoryExtraction(rawText) {
  const text = String(rawText ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  let data;
  try {
    data = JSON.parse(candidate);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (typeof data?.summary !== "string" || !data.summary.trim()) {
    return { ok: false, error: "missing_summary" };
  }
  const summary = data.summary.trim().slice(0, MEMORY_SUMMARY_MAX_CHARS);
  const facts = normalizeArray(data.facts, (item) => ({
    entity: requiredString(item.entity),
    attribute: requiredString(item.attribute),
    value: requiredString(item.value),
    chapter_no: Number(item.chapter_no) || null,
    quote: String(item.quote ?? "").slice(0, 80)
  }), (f) => f.entity && f.attribute && f.value);
  const timeline = normalizeArray(data.timeline, (item) => ({
    chapter_no: Number(item.chapter_no) || null,
    story_time: String(item.story_time ?? ""),
    events: Array.isArray(item.events) ? item.events.map((e) => String(e)).slice(0, 10) : []
  }), (t) => t.chapter_no !== null);
  const characters = normalizeArray(data.characters, (item) => ({
    name: requiredString(item.name),
    traits: Array.isArray(item.traits) ? item.traits.map((t) => String(t)).slice(0, 10) : [],
    status: String(item.status ?? ""),
    chapter_no: Number(item.chapter_no) || null
  }), (c) => Boolean(c.name));
  return { ok: true, summary, facts, timeline, characters };
}

function normalizeArray(value, mapFn, filterFn) {
  if (!Array.isArray(value)) return [];
  return value.map(mapFn).filter(filterFn).slice(0, 50);
}

function requiredString(value) {
  const s = String(value ?? "").trim();
  return s || null;
}
