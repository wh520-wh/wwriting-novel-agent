// 对话 agent 的写工具：edit_chapter、rewrite_chapter、update_continuity、update_outline、queue_chapters、update_settings。
// 错误码：chapter_not_found / bad_args / find_not_found / find_not_unique / tool_failed。
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadChapterIndex, loadState, upsertChapter, writeCheckpoint } from "../project-store.mjs";
import { loadContinuity, mergeExtraction, saveContinuity } from "../continuity-store.mjs";
import { updateProjectSettings } from "../settings-runtime.mjs";
import { expandInstruction } from "../task-queue.mjs";
import { countEffectiveWords } from "../word-count.mjs";
import { appendEvent } from "../event-log.mjs";
import { pathExists, safeJoin, writeFileAtomic } from "../fs-utils.mjs";
import { exportBook } from "../book-export.mjs";

async function resolveChapterFile(projectRoot, chapterNo) {
  const index = await loadChapterIndex(projectRoot);
  const entry = (index.chapters ?? []).find((c) => c.chapter_no === Number(chapterNo));
  const filePath = entry?.final_path ?? entry?.draft_path;
  if (!entry || !filePath || !(await pathExists(filePath))) {
    const error = new Error(`第 ${chapterNo} 章不存在或还没有正文。`);
    error.code = "chapter_not_found";
    throw error;
  }
  return { entry, filePath };
}

// bigram Dice 相似度：对照 Aider difflib.SequenceMatcher 的轻量替代，
// 用于 find 精确找不到时定位最相似片段，反馈给模型重试（不自动替换，避免小说正文误改）。
function bigrams(str) {
  const set = new Set();
  for (let i = 0; i < str.length - 1; i += 1) set.add(str.slice(i, i + 2));
  return set;
}

function diceSimilaritySets(ga, gb) {
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return (2 * inter) / (ga.size + gb.size);
}

function closestSnippet(content, find, maxLen = 80) {
  if (!find || find.length < 4) return null;
  const win = Math.min(Math.max(find.length, 8), maxLen);
  // find 在循环中不变，bigrams 预计算一次；原实现每轮重建 ga，是 O(N*m) 的纯浪费。
  const ga = bigrams(find);
  let best = null;
  const step = 1; // 步长 1 不漏最佳对齐（find_not_found 是低频错误路径，开销可接受）
  for (let i = 0; i + win <= content.length; i += step) {
    const sim = diceSimilaritySets(ga, bigrams(content.slice(i, i + win)));
    if (!best || sim > best.sim) best = { at: i, sim };
  }
  if (best && best.sim >= 0.5) {
    return content.slice(best.at, best.at + win).replace(/\s+/gu, " ").trim();
  }
  return null;
}

// 定位 find 在 content 中的位置。对照 Aider 的容错思路：
// - 精确唯一命中 -> 直接返回；
// - 精确多次命中 -> 允许 occurrence 消歧（默认仍报 find_not_unique，避免误改）；
// - 精确找不到 -> 报 find_not_found，但附最相似片段助模型重试（不自动模糊替换）。
function locateFind(content, find, options = {}) {
  if (!find) {
    const e = new Error("find 不能为空");
    e.code = "bad_args";
    throw e;
  }
  const positions = [];
  let idx = content.indexOf(find);
  while (idx >= 0) {
    positions.push(idx);
    idx = content.indexOf(find, idx + 1);
  }
  if (positions.length === 0) {
    const hint = closestSnippet(content, find);
    const e = new Error(
      hint
        ? `正文中找不到要替换的文字（find）。最相似片段：${hint}`
        : "正文中找不到要替换的文字（find）。"
    );
    e.code = "find_not_found";
    throw e;
  }
  if (positions.length > 1) {
    const occ = Number(options.occurrence);
    if (Number.isInteger(occ) && occ >= 1 && occ <= positions.length) {
      return { at: positions[occ - 1], length: find.length, occurrence: occ, total: positions.length };
    }
    const e = new Error(
      `要替换的文字出现了 ${positions.length} 次。请提供更长、更唯一的 find，或加 occurrence（1..${positions.length}）指定第几个。`
    );
    e.code = "find_not_unique";
    throw e;
  }
  return { at: positions[0], length: find.length, occurrence: 1, total: 1 };
}

export async function previewEditChapter(projectRoot, args) {
  const { filePath } = await resolveChapterFile(projectRoot, args.chapter_no);
  const content = await fs.readFile(filePath, "utf8");
  const find = String(args.find ?? "");
  const loc = locateFind(content, find, args);
  const replace = String(args.replace ?? "");
  const ctx = 60;
  const beforeStart = Math.max(0, loc.at - ctx);
  const beforeEnd = loc.at + loc.length + ctx;
  const before = content.slice(beforeStart, beforeEnd);
  // 用 loc.at 精确 slice 替换，避免 before 里含多个 find 时 replace 误换第一个
  const after = content.slice(beforeStart, loc.at) + replace + content.slice(loc.at + loc.length, beforeEnd);
  return { ok: true, chapter_no: Number(args.chapter_no), before, after };
}

export function registerWriteTools(registry) {
  registry.register({
    name: "edit_chapter",
    kind: "write",
    description: "对某章正文做一次精确替换。find 唯一命中时直接替换；出现多次时加 occurrence 指定第几个；找不到时返回最相似片段助你重试。",
    params: {
      chapter_no: "章节号",
      find: "要替换的原文（尽量唯一；不唯一时配合 occurrence）",
      replace: "替换后的文字",
      occurrence: "find 出现多次时，指定第几个（从 1 开始）",
      reason: "修改原因（给读者看的说明）"
    },
    run: async (args, ctx) => {
      const { entry, filePath } = await resolveChapterFile(ctx.projectRoot, args.chapter_no);
      // 运行中章编辑检查
      if (ctx.server?.runJobs) {
        const key = path.resolve(ctx.projectRoot);
        const job = ctx.server.runJobs.get(key);
        if (job?.status === "running") {
          const state = await loadState(ctx.projectRoot);
          if (state.current_chapter_no === Number(args.chapter_no)) {
            const e = new Error(`第 ${args.chapter_no} 章正在写作中，请等写作完成后再编辑。`);
            e.code = "chapter_busy";
            throw e;
          }
        }
      }
      const content = await fs.readFile(filePath, "utf8");
      const find = String(args.find ?? "");
      const loc = locateFind(content, find, args);
      // 先校验再副作用：writeCheckpoint 在 locateFind 通过后才写
      await writeCheckpoint(ctx.projectRoot, {
        kind: "chat_edit",
        chapter_no: entry.chapter_no,
        file: filePath,
        reason: args.reason ?? null,
        find: find.slice(0, 200)
      });
      const replace = String(args.replace ?? "");
      // 用 loc.at 精确 slice 替换，支持 occurrence 消歧定位
      const next = content.slice(0, loc.at) + replace + content.slice(loc.at + loc.length);
      await writeFileAtomic(filePath, next);
      const checksum = `sha256:${crypto.createHash("sha256").update(next).digest("hex")}`;
      const words = countEffectiveWords(next);
      await upsertChapter(ctx.projectRoot, {
        chapter_no: entry.chapter_no,
        actual_words: words,
        checksum
      });
      await appendEvent(ctx.projectRoot, {
        type: "chapter_edited_via_chat",
        project_id: ctx.project?.project_id ?? null,
        chapter_no: entry.chapter_no,
        stage: "chat",
        message: `第 ${entry.chapter_no} 章已按对话指令修改`,
        data: { reason: args.reason ?? null, words }
      });
      return { chapter_no: entry.chapter_no, replaced: 1, words };
    }
  });

  registry.register({
    name: "rewrite_chapter",
    kind: "write",
    safeDuringRun: true,
    description: "把某章整体重写的要求排成写作任务（由写作流水线执行）。",
    params: {
      chapter_no: "章节号",
      instructions: "重写要求"
    },
    run: async (args, ctx) => {
      const queue = await ctx.getTaskQueue(ctx.projectRoot);
      const task = await queue.enqueue(
        `重写第${Number(args.chapter_no)}章：${String(args.instructions ?? "").trim()}`,
        { mode: "write" }
      );
      return { queued: 1, task_id: task.id ?? null };
    }
  });

  registry.register({
    name: "update_continuity",
    kind: "write",
    description: "修改设定档案中的一条事实（用户裁决冲突或修正记忆时用）。",
    params: {
      entity: "实体名",
      attribute: "属性",
      value: "新值",
      note: "备注"
    },
    run: async (args, ctx) => {
      const state = await loadState(ctx.projectRoot);
      const chapterNo = Number.isInteger(state.current_chapter_no) ? state.current_chapter_no : null;
      const continuity = await loadContinuity(ctx.projectRoot);
      const merged = mergeExtraction(continuity, {
        facts: [
          {
            entity: String(args.entity),
            attribute: String(args.attribute),
            value: String(args.value),
            chapter_no: chapterNo,
            quote: String(args.note ?? "chat 修订")
          }
        ],
        timeline: [],
        characters: []
      });
      await saveContinuity(ctx.projectRoot, merged);
      return { entity: args.entity, attribute: args.attribute, value: args.value };
    }
  });

  registry.register({
    name: "update_outline",
    kind: "write",
    description: "更新写作目标说明（task_plan.md 追加一节计划修订）。",
    params: {
      chapter_no: "针对的章节号（可空）",
      plan: "新的计划内容"
    },
    run: async (args, ctx) => {
      const planPath = safeJoin(ctx.projectRoot, "task_plan.md");
      const existing = (await pathExists(planPath)) ? await fs.readFile(planPath, "utf8") : "# 任务计划\n";
      const heading = args.chapter_no
        ? `## 第 ${Number(args.chapter_no)} 章计划修订（chat）`
        : "## 计划修订（chat）";
      const next = `${existing.trimEnd()}\n\n${heading}\n\n${String(args.plan ?? "").trim()}\n`;
      await writeFileAtomic(planPath, next);
      return { updated: true };
    }
  });

  registry.register({
    name: "queue_chapters",
    kind: "write",
    safeDuringRun: true,
    description: "把写作指令排进任务队列（支持「写N章」「写到第N章」或自由指令）。",
    params: { instruction: "写作指令" },
    run: async (args, ctx) => {
      const state = await loadState(ctx.projectRoot);
      const instructions = expandInstruction(String(args.instruction ?? ""), {
        currentChapter: state.current_chapter_no ?? 1
      });
      const queue = await ctx.getTaskQueue(ctx.projectRoot);
      for (const instruction of instructions) {
        await queue.enqueue(instruction, { mode: "write" });
      }
      return { queued: instructions.length, tasks: instructions };
    }
  });

  registry.register({
    name: "update_settings",
    kind: "write",
    description: "更新项目设置（走全套校验；不能写入裸 API key）。",
    params: { patch: "设置补丁对象，如 {target_chapters: 12}" },
    run: async (args, ctx) => {
      const result = await updateProjectSettings(ctx.projectRoot, args.patch ?? {});
      return {
        updated: true,
        keys: Object.keys(args.patch ?? {}),
        result: result?.ok ?? true
      };
    }
  });

  registry.register({
    name: "export_book", kind: "write", safeDuringRun: true,
    description: "把已完成章节合成一本书，导出到项目 exports/ 文件夹（md 或 txt）。",
    params: { format: "md 或 txt（默认 md）", from_chapter: "起始章（可空）", to_chapter: "结束章（可空）" },
    run: async (args, ctx) => {
      return await exportBook(ctx.projectRoot, {
        format: args.format === "txt" ? "txt" : "md",
        fromChapter: Number(args.from_chapter) > 0 ? Number(args.from_chapter) : 1,
        toChapter: Number(args.to_chapter) > 0 ? Number(args.to_chapter) : Infinity
      });
    }
  });

  registry.register({
    name: "archive_project", kind: "write",
    description: "归档或解除归档本项目。归档后项目只读（仍可查询与导出）。",
    params: { archived: "true 归档 / false 解除归档" },
    run: async (args, ctx) => {
      if (args.archived === true || args.archived === "true") {
        const job = ctx.server?.runJobs?.get(path.resolve(ctx.projectRoot));
        if (job?.status === "running") {
          const e = new Error("写作任务正在运行，请先暂停或等它完成，再归档。");
          e.code = "project_busy";
          throw e;
        }
      }
      const archivedAt = (args.archived === true || args.archived === "true") ? new Date().toISOString() : null;
      await updateProjectSettings(ctx.projectRoot, { archived_at: archivedAt });
      await appendEvent(ctx.projectRoot, {
        type: archivedAt ? "project_archived" : "project_unarchived",
        project_id: ctx.project?.project_id ?? null, stage: "chat",
        message: archivedAt ? "项目已归档（只读）" : "项目已解除归档"
      });
      return { archived: Boolean(archivedAt), archived_at: archivedAt };
    }
  });
}
