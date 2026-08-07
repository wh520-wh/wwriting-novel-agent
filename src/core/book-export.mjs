// 成书导出：composeBook 纯函数（可单测），exportBook 做 IO。零依赖。
import fs from "node:fs/promises";
import { loadChapterIndex, loadProject } from "./project-store.mjs";
import { countEffectiveWords } from "./word-count.mjs";
import { pathExists, safeJoin, writeFileAtomic } from "./fs-utils.mjs";

const HEAD_TITLE_RE = /^\s{0,3}#{1,3}\s*第\s*[^\s章]+\s*章[^\n]*\n+/u; // 同标题门检判定的剥离版（识别「第 N 章」标题行）

// 剥离写作流水线产物（与 app-dashboard.stripChapterMarkup 同规则，导出路径此前遗漏）：
// 草稿英文头 `# Chapter 001` 与每段标记 `<!-- segment:N checksum:... -->` 不是正文。
function stripPipelineArtifacts(content) {
  return String(content)
    .replace(/<!--\s*segment:[^>]*-->/gu, "")
    .replace(/^#\s+Chapter\s+\d+\s*$/imu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function composeBook(chapters, { title, slug, format = "md", date = new Date() } = {}) {
  const sorted = [...chapters].sort((a, b) => a.chapter_no - b.chapter_no);
  const ymd = date.toISOString().slice(0, 10).replaceAll("-", "");
  const ext = format === "txt" ? "txt" : "md";
  const filename = `${slug}-${ymd}.${ext}`;
  const parts = [];
  if (ext === "md") {
    parts.push(`# ${title}`);
    for (const ch of sorted) {
      const body = stripPipelineArtifacts(ch.content).replace(HEAD_TITLE_RE, "");
      const heading = ch.title ? `## 第 ${ch.chapter_no} 章 ${ch.title}` : `## 第 ${ch.chapter_no} 章`;
      parts.push(`${heading}\n\n${body}`);
    }
    return { filename, content: `${parts.join("\n\n")}\n` };
  }
  parts.push(title);
  for (const ch of sorted) {
    const body = stripMarkdown(stripPipelineArtifacts(ch.content).replace(HEAD_TITLE_RE, ""));
    const heading = ch.title ? `第 ${ch.chapter_no} 章 ${ch.title}` : `第 ${ch.chapter_no} 章`;
    parts.push(`${heading}\n\n${body}`);
  }
  return { filename, content: `${parts.join("\n\n\n")}\n` };
}

function stripMarkdown(text) {
  return text
    .replace(/^\s{0,3}#{1,6}\s*/gmu, "")
    .replace(/\*\*([^*]*)\*\*/gu, "$1")
    .replace(/\*([^*]*)\*/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1");
}

export async function exportBook(projectRoot, { format = "md", fromChapter = 1, toChapter = Infinity } = {}) {
  const [project, index] = await Promise.all([loadProject(projectRoot), loadChapterIndex(projectRoot)]);
  const slug = project.root_path ? String(project.root_path).split(/[\\/]/u).filter(Boolean).pop() : "book";
  const chapters = [];
  const skipped = [];
  for (const entry of (index.chapters ?? [])) {
    if (entry.status !== "completed") continue;
    if (entry.chapter_no < fromChapter || entry.chapter_no > toChapter) continue;
    const filePath = entry.final_path ?? entry.draft_path;
    if (!filePath || !(await pathExists(filePath))) { skipped.push(entry.chapter_no); continue; }
    chapters.push({ chapter_no: entry.chapter_no, title: entry.title ?? "", content: await fs.readFile(filePath, "utf8") });
  }
  const { filename, content } = composeBook(chapters, { title: project.title, slug, format });
  const outPath = safeJoin(projectRoot, "exports", filename);
  await fs.mkdir(safeJoin(projectRoot, "exports"), { recursive: true });
  await writeFileAtomic(outPath, content);
  return { path: outPath, chapters: chapters.length, words: countEffectiveWords(content), skipped };
}
