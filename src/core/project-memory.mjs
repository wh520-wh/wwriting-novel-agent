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

import { safeJoin } from "./fs-utils.mjs";

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

export function renderInitialProjectMemory({ title = "", confirmed = {}, files = {} } = {}) {
  return [
    "---",
    "schema_version: 1",
    "---",
    "",
    "# WWriting 项目记忆",
    "",
    "## 项目定位",
    title ? `- 项目：${title}` : "",
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
