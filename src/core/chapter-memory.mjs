import { readJson, safeJoin, writeJsonAtomic } from "./fs-utils.mjs";

export const CHAPTER_MEMORY_SCHEMA_VERSION = 1;
export const MAX_CONTEXT_CHAPTERS = 2;
export const OPENING_EXCERPT_CHARS = 420;
export const ENDING_EXCERPT_CHARS = 900;

export async function loadChapterMemory(projectRoot) {
  const memory = await readJson(safeJoin(projectRoot, "memory", "chapter_memory.json"), {
    schema_version: CHAPTER_MEMORY_SCHEMA_VERSION,
    chapters: []
  });
  return normalizeMemory(memory);
}

export async function recordChapterMemory(projectRoot, chapter) {
  const memory = await loadChapterMemory(projectRoot);
  const chapterNo = Number(chapter.chapterNo);
  if (!Number.isInteger(chapterNo) || chapterNo < 1) {
    throw new Error("chapterNo must be a positive integer.");
  }
  const clean = cleanChapterText(chapter.content);
  const entry = {
    chapter_no: chapterNo,
    title: chapter.title ?? `第${String(chapterNo).padStart(3, "0")}章`,
    actual_words: Number(chapter.actualWords ?? 0),
    checksum: chapter.checksum ?? null,
    opening_excerpt: clipStart(clean, OPENING_EXCERPT_CHARS),
    ending_excerpt: clipEnd(clean, ENDING_EXCERPT_CHARS)
  };
  const chapters = [
    ...memory.chapters.filter((item) => item.chapter_no !== chapterNo),
    entry
  ].sort((a, b) => a.chapter_no - b.chapter_no);
  const next = {
    schema_version: CHAPTER_MEMORY_SCHEMA_VERSION,
    chapters
  };
  await writeJsonAtomic(safeJoin(projectRoot, "memory", "chapter_memory.json"), next);
  return next;
}

export async function buildContinuityPromptContext(projectRoot, currentChapterNo) {
  const memory = await loadChapterMemory(projectRoot);
  const activeChapterNo = Number(currentChapterNo);
  const previous = memory.chapters
    .filter((chapter) => chapter.chapter_no < activeChapterNo)
    .slice(-MAX_CONTEXT_CHAPTERS);
  const lines = [
    "recent_completed_chapters:",
    `- 当前目标章节：第 ${activeChapterNo} 章。`
  ];
  if (previous.length === 0) {
    lines.push("- 第 1 章可以建立初始处境一次；后续章节必须承接已有场景和因果。");
    return lines.join("\n");
  }
  lines.push("- 继续上一章留下的动作、后果、线索或情绪压力，不要把本章写成新的第一章。");
  for (const chapter of previous) {
    lines.push(`\n### 第 ${chapter.chapter_no} 章：${chapter.title}`);
    lines.push(`字数：${chapter.actual_words}`);
    lines.push(`开头摘录：${chapter.opening_excerpt}`);
    lines.push(`上一章落点：${chapter.ending_excerpt}`);
  }
  return lines.join("\n");
}

// 检索式记忆注入：只取最近 N 章的 facts + 角色状态 + 近期 timeline，
// 避免全量 continuity.md 随章节增长膨胀挤占上下文。模型需要更多细节时调 read_continuity。
export function buildRelevantFacts(continuity, currentChapterNo, options = {}) {
  const recentWindow = options.recentWindow ?? 5;
  const maxFacts = options.maxFacts ?? 40;
  const maxCharacters = options.maxCharacters ?? 12;
  const maxTimeline = options.maxTimeline ?? 8;
  const chapterNo = Number(currentChapterNo);
  const lowerBound = chapterNo - recentWindow;

  const recentFacts = (continuity?.facts ?? [])
    .filter((f) => {
      const fNo = Number(f.chapter_no);
      return fNo >= lowerBound && fNo < chapterNo;
    })
    .sort((a, b) => Number(a.chapter_no) - Number(b.chapter_no));

  let selected = recentFacts;
  if (selected.length < maxFacts) {
    const older = (continuity?.facts ?? [])
      .filter((f) => Number(f.chapter_no) < lowerBound)
      .sort((a, b) => Number(b.chapter_no) - Number(a.chapter_no));
    selected = [...selected, ...older].slice(0, maxFacts);
  } else {
    selected = recentFacts.slice(-maxFacts);
  }

  const characters = (continuity?.characters ?? []).slice(0, maxCharacters);
  const recentTimeline = (continuity?.timeline ?? [])
    .filter((t) => Number(t.chapter_no) >= lowerBound)
    .slice(-maxTimeline);

  if (selected.length === 0 && characters.length === 0 && recentTimeline.length === 0) {
    return "";
  }

  const lines = ["## 相关设定（精选近期，更多可用 read_continuity 工具按实体查）"];

  if (selected.length > 0) {
    lines.push("", "### 关键事实");
    const byEntity = new Map();
    for (const f of selected) {
      if (!byEntity.has(f.entity)) byEntity.set(f.entity, []);
      byEntity.get(f.entity).push(f);
    }
    for (const [entity, facts] of byEntity) {
      lines.push(`- ${entity}:`);
      for (const f of facts) {
        const conflict = f.conflict_with ? ` ⚠${f.conflict_with}` : "";
        lines.push(`  - ${f.attribute}: ${f.value} (第${f.chapter_no}章)${conflict}`);
      }
    }
  }

  if (characters.length > 0) {
    lines.push("", "### 角色状态");
    for (const c of characters) {
      lines.push(`- ${c.name}（${c.status || "状态未知"}）：${(c.traits ?? []).join("、") || "无记录特征"}`);
    }
  }

  if (recentTimeline.length > 0) {
    lines.push("", "### 近期时间线");
    for (const t of recentTimeline) {
      const when = t.story_time_raw || "";
      lines.push(`- 第${t.chapter_no}章${when ? ` [${when}]` : ""}: ${(t.events ?? []).join("；")}`);
    }
  }

  return lines.join("\n");
}

function normalizeMemory(memory) {
  const chapters = Array.isArray(memory?.chapters)
    ? memory.chapters
        .map((chapter) => ({
          chapter_no: Number(chapter.chapter_no),
          title: String(chapter.title ?? ""),
          actual_words: Number(chapter.actual_words ?? 0),
          checksum: chapter.checksum ?? null,
          opening_excerpt: String(chapter.opening_excerpt ?? ""),
          ending_excerpt: String(chapter.ending_excerpt ?? "")
        }))
        .filter((chapter) => Number.isInteger(chapter.chapter_no) && chapter.chapter_no > 0)
        .sort((a, b) => a.chapter_no - b.chapter_no)
    : [];
  return {
    schema_version: CHAPTER_MEMORY_SCHEMA_VERSION,
    chapters
  };
}

function cleanChapterText(content) {
  return String(content ?? "")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/^#\s+Chapter\s+\d+\s*$/gimu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function clipStart(text, maxChars) {
  const source = normalizeExcerpt(text);
  return source.length > maxChars ? `${source.slice(0, maxChars)}…` : source;
}

function clipEnd(text, maxChars) {
  const source = normalizeExcerpt(text);
  return source.length > maxChars ? `…${source.slice(-maxChars)}` : source;
}

function normalizeExcerpt(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}
