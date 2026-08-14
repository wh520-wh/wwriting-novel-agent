import { readJson, safeJoin, writeFileAtomic, writeJsonAtomic } from "./fs-utils.mjs";
import { normalizeTimeField } from "./memory-extractor.mjs";

export const CONTINUITY_SCHEMA_VERSION = 2;
export const MAX_FACTS_PER_ENTITY = 20;

// 章号渲染兜底：chapter_no 为 null（如 chat 修订、模型漏填）时不再输出 "(第null章)"。
export function formatChapterRef(chapterNo) {
  const n = Number(chapterNo);
  return Number.isInteger(n) && n > 0 ? `第${n}章` : "未标章号";
}

const EMPTY = () => ({ schema_version: CONTINUITY_SCHEMA_VERSION, facts: [], timeline: [], characters: [] });

function migrateTimelineNode(node) {
  const n = node && typeof node === "object" ? node : {};
  const base = {
    chapter_no: n.chapter_no ?? null,
    events: Array.isArray(n.events) ? n.events : [],
    story_time_raw: String(n.story_time_raw ?? n.story_time ?? "")
  };
  return { ...base, time: normalizeTimeField(n.time) };
}

export async function loadContinuity(projectRoot) {
  const data = await readJson(safeJoin(projectRoot, "memory", "continuity.json"), EMPTY());
  return {
    schema_version: CONTINUITY_SCHEMA_VERSION,
    facts: Array.isArray(data.facts) ? data.facts : [],
    timeline: (Array.isArray(data.timeline) ? data.timeline : []).map(migrateTimelineNode),
    characters: Array.isArray(data.characters) ? data.characters : []
  };
}

export async function saveContinuity(projectRoot, data) {
  await writeJsonAtomic(safeJoin(projectRoot, "memory", "continuity.json"), data);
  await writeFileAtomic(safeJoin(projectRoot, "memory", "continuity.md"), renderContinuityMarkdown(data));
  return data;
}

export function mergeExtraction(base, extraction) {
  const next = { ...EMPTY(), ...structuredClone(base) };
  for (const fact of extraction.facts ?? []) {
    const same = next.facts.find((f) => f.entity === fact.entity && f.attribute === fact.attribute && f.value === fact.value);
    if (same) continue;
    const prior = [...next.facts].reverse().find((f) => f.entity === fact.entity && f.attribute === fact.attribute);
    next.facts.push({
      entity: fact.entity, attribute: fact.attribute, value: fact.value,
      chapter_no: fact.chapter_no ?? null, quote: fact.quote ?? "",
      conflict_with: prior ? `${formatChapterRef(prior.chapter_no)}: ${prior.value}` : null
    });
    enforceEntityCap(next.facts, fact.entity);
  }
  for (const node of extraction.timeline ?? []) {
    const incoming = migrateTimelineNode(node);
    const fp = incoming.events.join("¦");
    const dup = next.timeline.find((t) => t.chapter_no === incoming.chapter_no && (t.events ?? []).join("¦") === fp);
    if (!dup) next.timeline.push(incoming);
  }
  for (const ch of extraction.characters ?? []) {
    const existing = next.characters.find((c) => c.name === ch.name);
    if (existing) {
      existing.traits = [...new Set([...existing.traits, ...(ch.traits ?? [])])].slice(0, 10);
      if (ch.status) existing.status = ch.status;
      existing.chapter_no = ch.chapter_no ?? existing.chapter_no;
    } else {
      next.characters.push({ name: ch.name, traits: ch.traits ?? [], status: ch.status ?? "", chapter_no: ch.chapter_no ?? null });
    }
  }
  return next;
}

function enforceEntityCap(facts, entity) {
  const indices = facts.map((f, i) => (f.entity === entity ? i : -1)).filter((i) => i >= 0);
  while (indices.length > MAX_FACTS_PER_ENTITY) {
    facts.splice(indices.shift(), 1);
    for (let k = 0; k < indices.length; k += 1) indices[k] -= 1;
  }
}

export function renderContinuityMarkdown(data) {
  const lines = ["# 设定档案（continuity）", ""];
  const byEntity = new Map();
  for (const fact of data.facts) {
    if (!byEntity.has(fact.entity)) byEntity.set(fact.entity, []);
    byEntity.get(fact.entity).push(fact);
  }
  lines.push("## 事实");
  for (const [entity, facts] of byEntity) {
    lines.push(`### ${entity}`);
    for (const f of facts) {
      const conflict = f.conflict_with ? ` ⚠ 与既有记录冲突（${f.conflict_with}），以人工或门禁裁决为准` : "";
      lines.push(`- ${f.attribute}: ${f.value} (${formatChapterRef(f.chapter_no)})${conflict}`);
    }
  }
  lines.push("", "## 时间线");
  for (const t of [...data.timeline].sort((a, b) => (a.chapter_no ?? 0) - (b.chapter_no ?? 0))) {
    const node = migrateTimelineNode(t);
    const tags = [node.time.elapsed, node.time.kind !== "scene" ? node.time.kind : null].filter(Boolean).join("·");
    const meta = tags ? ` [${tags}]` : "";
    const when = node.story_time_raw || (node.time.anchor?.raw ?? "");
    lines.push(`- ${formatChapterRef(node.chapter_no)}${when ? ` [${when}]` : ""}${meta}: ${node.events.join("；")}`);
  }
  lines.push("", "## 角色");
  for (const c of data.characters) {
    lines.push(`- ${c.name}（${c.status || "状态未知"}）：${c.traits.join("、") || "无记录特征"}`);
  }
  lines.push("");
  return lines.join("\n");
}
