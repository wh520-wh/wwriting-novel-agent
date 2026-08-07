// src/core/project-memory.mjs —— WWRITING.md 项目记忆（任意工作区计划 Task 6）。
//
// 定位（SPEC §3）：WWRITING.md 是每个长期工作区的项目记忆入口，不是第二份总纲，
// 也不是聊天数据库。本模块只负责容错读取与稳定初始模板；**读函数不产生任何副作用**
// （不创建文件、不写磁盘）。只有调用方明确执行 /init（Task 7）或维护长期事实
// （Task 11）时才写文件。
//
// 容错语义（SPEC §11）：缺失返回空 context；不可读/损坏返回 unreadable 标记；
// 两者都不外抛原始错误（用户不得看到 ENOENT、堆栈或 Node.js 原始异常），也不得
// 阻止 prompt 装配。未知 schema_version 仍作为普通 Markdown 提供给模型，不硬失败。
import fs from "node:fs/promises";

import { safeJoin, writeFileAtomic } from "./fs-utils.mjs";

export const PROJECT_MEMORY_FILE = "WWRITING.md";

export async function readProjectMemory(projectRoot) {
  const target = safeJoin(projectRoot, PROJECT_MEMORY_FILE);
  try {
    const content = await fs.readFile(target, "utf8");
    return {
      exists: true,
      content,
      styleSkill: parseFrontmatterStyleSkill(content)
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, content: "", styleSkill: null };
    return { exists: false, content: "", styleSkill: null, unreadable: true };
  }
}

export function renderInitialProjectMemory({ title = "", positioning = "", confirmed = {}, files = {} } = {}) {
  const cleanTitle = String(title ?? "").trim();
  const cleanPositioning = String(positioning ?? "").trim();
  return [
    "---",
    "schema_version: 1",
    "---",
    "",
    "# WWriting 项目记忆",
    "",
    "## 项目定位",
    cleanTitle ? `- 项目：${cleanTitle}` : "",
    cleanPositioning ? `- 题材：${cleanPositioning}` : "",
    "",
    "## 当前有效要求",
    ...renderConfirmedRequirements(confirmed),
    "",
    "## 权威文件",
    ...renderKnownFiles(files),
    "",
    "## 当前进度",
    "",
    "## 持久事实",
    "",
    "## 待确认",
    ""
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}

// 合并写入 WWRITING.md（计划 Task 11：旧 project.yaml 一次性只读迁移使用）。
//
// 契约（brief Step 3 / SPEC §3）：文件缺失或空白时按 renderInitialProjectMemory()
// 重建稳定模板（SPEC §3.1 允许空白/损坏时重建）；文件已存在时**只在「权威文件」
// 稳定小节补充缺失且不冲突的索引**——不重排用户自由文本、不替换用户已写风格、
// 不把旧字段覆盖最新要求。冲突判定：同路径已被索引（任意标签）或同标签已被
// 用户指向其他路径时跳过；无缺失索引时返回原内容、不写盘（幂等，不触碰 mtime）。
export async function mergeProjectMemory(projectRoot, facts = {}) {
  const existing = await readProjectMemory(projectRoot);
  const nextContent = existing.exists && existing.content.trim() !== ""
    ? mergeAuthorityIndexes(existing.content, facts.files ?? {})
    : renderInitialProjectMemory({
        title: facts.title ?? "",
        positioning: facts.projectPositioning ?? "",
        confirmed: Object.fromEntries((facts.requirements ?? []).map((line, index) => [`req-${index}`, line])),
        files: facts.files ?? {}
      });
  if (nextContent === existing.content) {
    return nextContent;
  }
  await writeFileAtomic(safeJoin(projectRoot, PROJECT_MEMORY_FILE), nextContent);
  return nextContent;
}

// 只在「## 权威文件」小节末尾补充缺失且不冲突的 `- 标签：路径` 行。
// 小节不存在时在文件末尾追加一个小节（不重排已有内容）。
function mergeAuthorityIndexes(content, files) {
  const entries = Object.entries(files).filter(([, rel]) => typeof rel === "string" && rel.trim() !== "");
  if (entries.length === 0) return content;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => /^\s*##\s+权威文件\s*$/u.test(line));
  if (headingIndex === -1) {
    const tail = content.endsWith("\n") ? "" : eol;
    return `${content}${tail}${eol}${eol}## 权威文件${eol}${entries.map(([label, rel]) => `- ${label}：${rel}`).join(eol)}${eol}`;
  }
  let sectionEnd = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^\s*##\s/u.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  while (sectionEnd > headingIndex + 1 && lines[sectionEnd - 1].trim() === "") {
    sectionEnd -= 1;
  }
  const existingLines = lines.slice(headingIndex + 1, sectionEnd);
  const missing = entries.filter(([label, rel]) => {
    const pathUsed = existingLines.some((line) => {
      const separator = line.indexOf("：");
      return separator !== -1 && line.slice(separator + 1).trim() === rel;
    });
    const labelUsed = existingLines.some((line) => line.startsWith(`- ${label}：`));
    return !pathUsed && !labelUsed;
  });
  if (missing.length === 0) return content;
  const inserted = missing.map(([label, rel]) => `- ${label}：${rel}`);
  return [
    ...lines.slice(0, sectionEnd),
    ...inserted,
    ...lines.slice(sectionEnd)
  ].join(eol);
}

function renderConfirmedRequirements(confirmed) {
  return Object.values(confirmed)
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map((value) => `- ${value.trim()}`);
}

function renderKnownFiles(files) {
  return Object.entries(files)
    .filter(([, value]) => typeof value === "string" && value.trim() !== "")
    .map(([label, value]) => `- ${label}：${value.trim()}`);
}

function parseFrontmatterStyleSkill(content) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1] ?? "";
  return /^writing_style_skill:\s*([^\s#]+)\s*$/mu.exec(frontmatter)?.[1] ?? null;
}
