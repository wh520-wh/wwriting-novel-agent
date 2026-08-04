// /init 独立服务端流程（spec §1.4 P1-3 修订 + P2-5 旧项目迁移）：
// 不走 chat agent 的工具确认模型，直接调用模型生成 OUTLINE.md + SETTING.md，
// 与 blueprint_status: "complete" 一起原子提交。
//
// 关键语义：
// - 原子提交（spec §1.4 P1-2）：两文件先写临时名，全部成功后 rename + 改状态一起完成。
//   状态不进 complete 即视为未完成。rename 中途失败（仅第一份 rename 成功）时，第一份文件
//   可能已就位——此时状态保持 partial/none 并打 warn（重跑 /init 重新生成覆盖，可自愈），
//   不会出现"状态 complete 但文件不完整"；对 complete/legacy 项目重跑场景 tracked=false，
//   失败不回滚状态（内容被覆盖前旧蓝图仍完整可用，重跑即可恢复）。
// - 失败/取消恢复语义：生成进行中置 partial（拒绝并发写作），失败回滚到原值；
//   下次 /init 从头重试，不续传。
// - 单轮生成实现（一个 prompt 让模型一次输出两份文件内容，分隔符切分）。
//   题材字段分化模板是 Task 10 的内容，这里只在 prompt 里要求模型按题材自然分化。
// - 旧项目迁移（runBlueprintInitForLegacy）：对 legacy 项目（已有章节无 OUTLINE.md），
//   输入改为已有章节摘要 + continuity + task_plan.md，AI 反推生成蓝图初稿；
//   反推不保证与正文完全一致（返回 notice 提示用户对照确认）。
import fs from "node:fs/promises";
import path from "node:path";
import { loadContinuity, renderContinuityMarkdown } from "./continuity-store.mjs";
import { pathExists, safeJoin, writeFileAtomic } from "./fs-utils.mjs";
import { loadChapterIndex, loadProject, loadState, saveState } from "./project-store.mjs";

// 模型输出两块内容的分隔行（独立成行）。导出供测试 mock 复用，避免测试与实现漂移。
export const BLUEPRINT_SPLIT = "<<<BLUEPRINT_SPLIT>>>";

// spec §1.3 固定结构模板：OUTLINE.md 总纲区（锚点区）+ 章节骨架（事实区）
const OUTLINE_STRUCTURE = `# OUTLINE.md

## 一、总纲（锚点区 · 只增不改）
### 1. 主题与核心概念
### 2. 主线
### 3. 核心矛盾
### 4. 卷划分
### 5. [题材字段]（按题材自动加：修炼体系 / 异能等级 / 魔法体系 / 科技设定 / 历史背景 等）

## 二、章节骨架（事实区 · 跟正文走）
### 第一卷
- [ ] 第1章《标题》：计划（主要事件 / 爽点 / 伏笔埋设·回收）
`;

// spec §1.3 固定结构模板：SETTING.md 世界观 + 角色表 + 题材专属设定
const SETTING_STRUCTURE = `# SETTING.md

## 一、世界观（基础 · 所有题材）
### 1. 世界设定
### 2. 地理与时间线

## 二、角色表（基础 · 所有题材）
- 角色名：身份 / 性格 / 能力 / 与主角关系 / 当前状态

## 三、题材专属设定（按题材加）
`;

// 退化兜底：模型未按分隔符输出时，整段当 OUTLINE，SETTING 用结构骨架兜底
const SETTING_FALLBACK = `${SETTING_STRUCTURE.trim()}

> 本文件由 /init 生成：模型未按结构输出时保留骨架，可在对话中补充具体设定。
`;

// 新项目 /init：以 userRequirements + project.yaml 种子（title/story_seed）为输入生成蓝图。
export async function runBlueprintInit(projectRoot, { modelClient, userRequirements, onEvent, signal }) {
  return runBlueprintCommit(projectRoot, {
    modelClient,
    onEvent,
    signal,
    buildPrompt: (project) => buildBlueprintPrompt({ project, userRequirements })
  });
}

// 旧项目迁移（spec §1.4 P2-5）：legacy 项目（已有章节、无 OUTLINE.md）的 /init。
// 输入：已有章节摘要 + continuity + task_plan.md（而非 story_seed）；输出与 runBlueprintInit
// 相同（两份 markdown + 原子提交 + blueprint_status: complete）。
// 反推生成是估计，不保证与既有正文完全一致——返回值带 notice 提示用户对照确认。
export async function runBlueprintInitForLegacy(projectRoot, { modelClient, userRequirements, onEvent, signal }) {
  const legacyContext = await collectLegacyContext(projectRoot);
  const result = await runBlueprintCommit(projectRoot, {
    modelClient,
    onEvent,
    signal,
    buildPrompt: (project) => buildLegacyBlueprintPrompt({ project, userRequirements, context: legacyContext })
  });
  return {
    ...result,
    notice: "蓝图由已有章节反推生成，可能与正文不完全一致，请对照确认（可在对话中继续调整）。"
  };
}

// 原子提交脚手架（runBlueprintInit / runBlueprintInitForLegacy 共用）：
// 生成 -> 写临时文件 -> rename 两份 -> loadState 后置 complete，任一失败回滚状态、清理临时文件。
async function runBlueprintCommit(projectRoot, { modelClient, onEvent, signal, buildPrompt }) {
  onEvent?.({ type: "blueprint_init_started" });
  const state = await loadState(projectRoot);
  const hadState = Boolean(state);
  const originalStatus = state?.blueprint_status ?? "none";
  // spec §1.4：生成进行中置 partial，拒绝并发写作；失败时回滚到原值（测试断言：失败后为 none）。
  // 已经是 complete/legacy 的项目重跑 /init 不动状态（项目锁已串行化写操作）。
  const tracked = Boolean(state) && originalStatus !== "complete" && originalStatus !== "legacy";
  if (tracked) {
    await saveState(projectRoot, { ...state, blueprint_status: "partial" });
  }
  const tmpOutline = safeJoin(projectRoot, ".OUTLINE.md.tmp");
  const tmpSetting = safeJoin(projectRoot, ".SETTING.md.tmp");
  let renamesDone = 0;
  try {
    // 1. AI 生成 OUTLINE.md + SETTING.md 内容（单轮，题材字段分化指令在 prompt 里）
    const { outlineContent, settingContent } = await generateBlueprint(projectRoot, modelClient, { signal, buildPrompt });
    // 2. 原子提交：先写两文件到临时名，全部成功后 rename + 改状态一起完成
    await writeFileAtomic(tmpOutline, outlineContent);
    await writeFileAtomic(tmpSetting, settingContent);
    await fs.rename(tmpOutline, safeJoin(projectRoot, "OUTLINE.md"));
    renamesDone += 1;
    await fs.rename(tmpSetting, safeJoin(projectRoot, "SETTING.md"));
    renamesDone += 1;
    const latest = await loadState(projectRoot);
    if (!latest) {
      // 拒绝覆盖，防止 {...null} 清空状态文件。区分场景给出可行动提示：
      // 文件原本存在（生成中途被删）→ 重试可自愈；文件原本就不存在 → 项目状态损坏，重建。
      throw new Error(
        hadState
          ? "agent_state.json 在生成过程中消失：拒绝覆盖状态文件，请重试 /init"
          : "agent_state.json 缺失（项目状态损坏）：蓝图文件已生成但无法提交状态，请重建项目后再试"
      );
    }
    await saveState(projectRoot, { ...latest, blueprint_status: "complete" });
    return { outlineContent, settingContent };
  } catch (error) {
    if (renamesDone === 1) {
      // rename 中途失败：第一份文件已就位，状态不进 complete（重跑 /init 覆盖自愈）
      console.warn(`[blueprint-init] OUTLINE.md 已写入但 SETTING.md 未完成，状态未置 complete，重跑 /init 可自愈: ${projectRoot}`);
    }
    // 失败路径：清理临时文件、回滚状态，不留半蓝图（已 rename 的文件重跑会覆盖）
    await Promise.all([tmpOutline, tmpSetting].map((p) => fs.rm(p, { force: true }).catch(() => {})));
    if (tracked) {
      const latest = await loadState(projectRoot);
      if (latest) {
        await saveState(projectRoot, { ...latest, blueprint_status: originalStatus }).catch(() => {});
      }
    }
    throw error;
  }
}

// 单轮生成：拼 prompt -> 模型输出 -> 分隔符切分 -> 空内容校验（Minor 6：空输出不得置 complete）。
async function generateBlueprint(projectRoot, modelClient, { signal, buildPrompt }) {
  const project = await loadProject(projectRoot).catch(() => null);
  const prompt = buildPrompt(project);
  const response = await modelClient.generate({
    project: project ?? {},
    stage: "planning",
    prompt,
    metadata: { blueprintInit: true },
    signal
  });
  const result = splitBlueprintOutput(response?.text ?? "");
  assertNonEmptyBlueprint(result);
  return result;
}

function buildBlueprintPrompt({ project, userRequirements }) {
  const requirement = String(userRequirements ?? "").trim()
    || "（用户未提供具体要求，按通用东方玄幻方向规划）";
  const title = project?.title ? `书名：${project.title}` : null;
  const seed = project?.story_seed ? `故事种子：${project.story_seed}` : null;
  return [
    "你是长篇小说的规划引擎。请根据用户需求，按下面的固定结构生成两份蓝图文件的内容（markdown 格式）。",
    "内容必须贴合用户需求的题材并具体填充，不要留空占位。",
    "",
    "第一份 OUTLINE.md 结构（必须保留以下标题层级）：",
    OUTLINE_STRUCTURE,
    "第二份 SETTING.md 结构（必须保留以下标题层级）：",
    SETTING_STRUCTURE,
    "输出要求：",
    `1. 第一份是 OUTLINE.md 的完整内容，第二份是 SETTING.md 的完整内容，两份之间用单独一行 ${BLUEPRINT_SPLIT} 分隔，除此之外不要输出任何说明文字。`,
    "2. 总纲区「5. 题材字段」按题材自然分化（如修真→修炼境界体系，科幻→科技设定，都市→异能等级，历史→时代背景）。",
    "3. 章节骨架先规划第一卷的 3-5 章，每章一行「- [ ] 第N章《标题》：主要事件 / 爽点 / 伏笔」。",
    "4. 角色表列出 3-5 个主要角色。",
    "",
    ...[title, seed, `用户需求：${requirement}`].filter(Boolean)
  ].join("\n");
}

// 旧项目反推 prompt：以已有章节摘要 + continuity + task_plan.md 为证据反推蓝图初稿
// （spec §1.4 P2-5：不保证与正文完全一致，用户需对照确认）。
function buildLegacyBlueprintPrompt({ project, userRequirements, context }) {
  const requirement = String(userRequirements ?? "").trim();
  const title = project?.title ? `书名：${project.title}` : null;
  const chapterLines = context.chapterSummaries.length
    ? context.chapterSummaries.join("\n")
    : "（未读取到章节内容）";
  const continuityText = context.continuityText ?? "（无设定档案）";
  const taskPlan = context.taskPlan ? `任务计划（task_plan.md）：\n${context.taskPlan}` : null;
  return [
    "你是长篇小说的规划引擎。该项目是已有章节产出的旧项目（升级迁移），请根据已有章节反推生成两份蓝图文件（markdown 格式）。",
    "注意：反推生成是估计，不保证与既有正文完全一致，用户会对照确认。内容必须基于下面的章节与设定证据具体填充，不要留空占位。",
    "",
    "第一份 OUTLINE.md 结构（必须保留以下标题层级）：",
    OUTLINE_STRUCTURE,
    "第二份 SETTING.md 结构（必须保留以下标题层级）：",
    SETTING_STRUCTURE,
    "输出要求：",
    `1. 第一份是 OUTLINE.md 的完整内容，第二份是 SETTING.md 的完整内容，两份之间用单独一行 ${BLUEPRINT_SPLIT} 分隔，除此之外不要输出任何说明文字。`,
    "2. 总纲区「5. 题材字段」按题材自然分化（如修真→修炼境界体系，科幻→科技设定，都市→异能等级，历史→时代背景）。",
    "3. 章节骨架覆盖已有章节（从章节摘要反推主要事件 / 爽点 / 伏笔），每章一行「- [ ] 第N章《标题》：主要事件 / 爽点 / 伏笔」。",
    "4. 角色表列出从正文与设定档案中出现的 3-5 个主要角色。",
    "",
    "已有章节摘要：",
    chapterLines,
    "设定档案（continuity）：",
    continuityText,
    ...[title, taskPlan, requirement ? `用户补充要求：${requirement}` : null].filter(Boolean)
  ].join("\n");
}

// 收集旧项目证据：章节索引 + 正文头部摘要（无索引时扫 chapters/ 目录兜底）+ continuity + task_plan.md。
async function collectLegacyContext(projectRoot) {
  const chapterSummaries = await collectChapterSummaries(projectRoot);
  const continuity = await loadContinuity(projectRoot).catch(() => null);
  const taskPlan = await fs.readFile(safeJoin(projectRoot, "task_plan.md"), "utf8").catch(() => null);
  return {
    chapterSummaries,
    continuityText: continuity ? renderContinuityMarkdown(continuity) : null,
    taskPlan: String(taskPlan ?? "").trim() || null
  };
}

async function collectChapterSummaries(projectRoot) {
  const summaries = [];
  const index = await loadChapterIndex(projectRoot).catch(() => ({ chapters: [] }));
  for (const entry of index?.chapters ?? []) {
    const p = entry.final_path ?? entry.draft_path;
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : safeJoin(projectRoot, p);
    const summary = await readChapterHead(abs, entry.chapter_no, entry.title);
    if (summary) summaries.push(summary);
  }
  if (summaries.length === 0) {
    // 兜底：极老的项目可能没有 chapter_index.json，直接扫 chapters/ 目录（只认 .md/.txt 章节文件）
    const dir = safeJoin(projectRoot, "chapters");
    if (await pathExists(dir)) {
      const names = (await fs.readdir(dir))
        .filter((name) => /\.(md|txt)$/i.test(name))
        .sort();
      for (const name of names) {
        const summary = await readChapterHead(safeJoin(dir, name), null, name);
        if (summary) summaries.push(summary);
      }
    }
  }
  return summaries;
}

const CHAPTER_HEAD_CHARS = 120;

async function readChapterHead(absPath, chapterNo, title) {
  try {
    const content = await fs.readFile(absPath, "utf8");
    const head = content.replace(/\s+/gu, " ").trim().slice(0, CHAPTER_HEAD_CHARS);
    if (!head) return null;
    const rawTitle = String(title ?? "").trim();
    const label = chapterNo ? `第${chapterNo}章` : (rawTitle || path.basename(absPath));
    // 标题已含书名号或与标签重复（如标题即文件名）时不再包一层，避免 `- 001.md《001.md》：`
    const titlePart = rawTitle && rawTitle !== label && !rawTitle.includes("《") ? `《${rawTitle}》` : "";
    return `- ${label}${titlePart}：${head}${content.length > CHAPTER_HEAD_CHARS ? "…" : ""}`;
  } catch {
    return null;
  }
}

function splitBlueprintOutput(text) {
  const parts = String(text ?? "").split(new RegExp(`^\\s*${escapeRegExp(BLUEPRINT_SPLIT)}\\s*$`, "m"));
  if (parts.length >= 2) {
    return {
      outlineContent: normalizeDoc(parts[0], "# OUTLINE.md"),
      settingContent: normalizeDoc(parts[1], "# SETTING.md")
    };
  }
  // 退化：模型没按分隔符输出，整段当 OUTLINE，SETTING 用骨架兜底（不阻塞 /init 完成）
  return {
    outlineContent: normalizeDoc(text, "# OUTLINE.md"),
    settingContent: SETTING_FALLBACK
  };
}

// Minor 6：空输出不得"成功"——任一文件只有 header 没有内容时抛错，状态保持 partial/none，不置 complete。
function assertNonEmptyBlueprint({ outlineContent, settingContent }) {
  for (const [name, doc] of [["OUTLINE.md", outlineContent], ["SETTING.md", settingContent]]) {
    const body = String(doc ?? "").split("\n").slice(1).join("\n").trim();
    if (!body) {
      throw new Error(`蓝图生成失败：${name} 内容为空，未提交（请重试 /init）`);
    }
  }
}

function normalizeDoc(content, header) {
  const trimmed = String(content ?? "").trim();
  const body = trimmed.startsWith(header) ? trimmed : `${header}\n\n${trimmed}`;
  return body.endsWith("\n") ? body : `${body}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
