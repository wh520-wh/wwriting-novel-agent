// /init 独立服务端流程（spec §1.4 P1-3 修订）：
// 不走 chat agent 的工具确认模型，直接调用模型生成 OUTLINE.md + SETTING.md，
// 与 blueprint_status: "complete" 一起原子提交。
//
// 关键语义：
// - 原子提交（spec §1.4 P1-2）：两文件先写临时名，全部成功后 rename + 改状态一起完成；
//   任一失败则状态回滚（测试断言：失败后为 none），不留半蓝图。
// - 失败/取消恢复语义：生成进行中置 partial（拒绝并发写作），失败回滚到原值；
//   下次 /init 从头重试，不续传。
// - 本 Task 用单轮生成实现（一个 prompt 让模型一次输出两份文件内容，分隔符切分）。
//   题材字段分化模板是 Task 10 的内容，这里只在 prompt 里要求模型按题材自然分化。
import fs from "node:fs/promises";
import { safeJoin, writeFileAtomic } from "./fs-utils.mjs";
import { loadProject, loadState, saveState } from "./project-store.mjs";

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

export async function runBlueprintInit(projectRoot, { modelClient, userRequirements, onEvent, signal }) {
  onEvent?.({ type: "blueprint_init_started" });
  const state = await loadState(projectRoot);
  const originalStatus = state?.blueprint_status ?? "none";
  // spec §1.4：生成进行中置 partial，拒绝并发写作；失败时回滚到原值（测试断言：失败后为 none）。
  // 已经是 complete/legacy 的项目重跑 /init 不动状态（项目锁已串行化写操作）。
  const tracked = Boolean(state) && originalStatus !== "complete" && originalStatus !== "legacy";
  if (tracked) {
    await saveState(projectRoot, { ...state, blueprint_status: "partial" });
  }
  const tmpOutline = safeJoin(projectRoot, ".OUTLINE.md.tmp");
  const tmpSetting = safeJoin(projectRoot, ".SETTING.md.tmp");
  try {
    // 1. AI 生成 OUTLINE.md + SETTING.md 内容（单轮，题材字段分化指令在 prompt 里）
    const { outlineContent, settingContent } = await generateBlueprint(projectRoot, modelClient, userRequirements, { signal });
    // 2. 原子提交：先写两文件到临时名，全部成功后 rename + 改状态一起完成
    await writeFileAtomic(tmpOutline, outlineContent);
    await writeFileAtomic(tmpSetting, settingContent);
    await fs.rename(tmpOutline, safeJoin(projectRoot, "OUTLINE.md"));
    await fs.rename(tmpSetting, safeJoin(projectRoot, "SETTING.md"));
    const latest = await loadState(projectRoot);
    await saveState(projectRoot, { ...latest, blueprint_status: "complete" });
    onEvent?.({ type: "blueprint_init_completed" });
  } catch (error) {
    // 失败路径：清理临时文件、回滚状态，不留半蓝图
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

// 单轮生成：把用户需求 + project.yaml 种子（title/story_seed）+ spec §1.3 结构模板拼进 prompt，
// 让模型一次输出两份 markdown 内容，按 BLUEPRINT_SPLIT 分隔。
async function generateBlueprint(projectRoot, modelClient, userRequirements, { signal }) {
  const project = await loadProject(projectRoot).catch(() => null);
  const prompt = buildBlueprintPrompt({ project, userRequirements });
  const response = await modelClient.generate({
    project: project ?? {},
    stage: "planning",
    prompt,
    metadata: { blueprintInit: true },
    signal
  });
  return splitBlueprintOutput(response?.text ?? "");
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

function normalizeDoc(content, header) {
  const trimmed = String(content ?? "").trim();
  const body = trimmed.startsWith(header) ? trimmed : `${header}\n\n${trimmed}`;
  return body.endsWith("\n") ? body : `${body}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
