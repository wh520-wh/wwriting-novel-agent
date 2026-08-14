// src/core/memory-extractor.mjs —— 第九轮重塑：后台记忆提取器退役，本文件只保留
// update_memory 工具的参数归一化纯函数（无 IO、无消息构造、无 schema 注册）。
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

export function normalizeTimeField(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    kind: TIME_KINDS.has(v.kind) ? v.kind : "scene",
    elapsed: normalizeElapsed(v.elapsed),
    anchor: normalizeAnchor(v.anchor),
    confidence: v.confidence === "high" ? "high" : "low"
  };
}

function normalizeArray(value, mapFn, filterFn) {
  if (!Array.isArray(value)) return [];
  return value.map(mapFn).filter(filterFn).slice(0, 50);
}

function requiredString(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

// 工具参数归一化：条目级 chapter_no 缺省继承顶层 chapter_no；
// 各阈值与旧 schema 一致（quote≤80、events≤10、traits≤10、每数组≤50）。
export function normalizeMemoryUpdateArgs(args) {
  const topChapterNo = Number(args?.chapter_no) || null;
  const facts = normalizeArray(args?.facts, (item) => ({
    entity: requiredString(item?.entity),
    attribute: requiredString(item?.attribute),
    value: requiredString(item?.value),
    chapter_no: Number(item?.chapter_no) || topChapterNo,
    quote: String(item?.quote ?? "").slice(0, 80)
  }), (f) => f.entity && f.attribute && f.value);
  const timeline = normalizeArray(args?.timeline, (item) => ({
    chapter_no: Number(item?.chapter_no) || topChapterNo,
    story_time_raw: String(item?.story_time_raw ?? item?.story_time ?? "").slice(0, 120),
    events: Array.isArray(item?.events) ? item.events.map((e) => String(e)).slice(0, 10) : [],
    time: normalizeTimeField(item?.time)
  }), (t) => t.chapter_no !== null);
  const characters = normalizeArray(args?.characters, (item) => ({
    name: requiredString(item?.name),
    traits: Array.isArray(item?.traits) ? item.traits.map((t) => String(t)).slice(0, 10) : [],
    status: String(item?.status ?? ""),
    chapter_no: Number(item?.chapter_no) || topChapterNo
  }), (c) => Boolean(c.name));
  return { chapter_no: topChapterNo, facts, timeline, characters };
}
