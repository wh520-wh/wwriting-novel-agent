import fs from "node:fs/promises";
import { loadChapterIndex, loadState } from "../project-store.mjs";
import { loadContinuity, loadContinuityState } from "../continuity-store.mjs";
import { readJson, safeJoin, pathExists } from "../fs-utils.mjs";

const DEFAULT_CHAPTER_CHARS = 8000;

export function registerReadTools(registry) {
  registry.register({
    name: "get_status", kind: "read",
    description: "项目当前状态：进度、阶段、运行状况、字数。",
    params: {},
    run: async (_args, ctx) => {
      const [state, index] = await Promise.all([loadState(ctx.projectRoot), loadChapterIndex(ctx.projectRoot)]);
      const chapters = index.chapters ?? [];
      return {
        title: ctx.project.title,
        project_status: state.project_status,
        current_chapter: state.current_chapter_no,
        current_stage: state.current_stage,
        completed_chapters: chapters.filter((c) => c.status === "completed").length,
        target_chapters: ctx.project.target_chapters,
        total_words: chapters.reduce((sum, c) => sum + Number(c.actual_words ?? 0), 0)
      };
    }
  });

  registry.register({
    name: "list_chapters",
    kind: "read",
    description: "列出所有章节的进度概览（章号、状态、字数、标题），一次看全局。",
    params: {},
    run: async (_args, ctx) => {
      const index = await loadChapterIndex(ctx.projectRoot);
      const chapters = (index.chapters ?? []).map((c) => ({
        chapter_no: c.chapter_no,
        status: c.status,
        actual_words: c.actual_words ?? 0,
        title: c.title ?? null
      }));
      return {
        total: chapters.length,
        completed: chapters.filter((c) => c.status === "completed").length,
        chapters
      };
    }
  });

  registry.register({
    name: "read_chapter", kind: "read",
    description: "读取指定章节正文。",
    params: { chapter_no: "章节号（整数）", max_chars: "可选，返回字符上限，默认 8000" },
    run: async (args, ctx) => {
      const chapterNo = Number(args.chapter_no);
      const index = await loadChapterIndex(ctx.projectRoot);
      const entry = (index.chapters ?? []).find((c) => c.chapter_no === chapterNo);
      const filePath = entry?.final_path ?? entry?.draft_path;
      if (!entry || !filePath || !(await pathExists(filePath))) {
        // 不抛错：写作 agent 可能在 drafting 时读当前章（草稿还没落盘/索引没更新），
        // 抛 chapter_not_found 会让模型陷入循环到 block。返回明确信息让模型知道该写而非读。
        return {
          chapter_no: chapterNo,
          status: entry?.status ?? "not_started",
          words: 0,
          content: "",
          note: `第 ${args.chapter_no} 章还没有正文（可能还在写，或尚未开始）。如果你在写这一章，直接输出正文即可，不需要先读它。`
        };
      }
      const raw = await fs.readFile(filePath, "utf8");
      const max = Number(args.max_chars) > 0 ? Number(args.max_chars) : DEFAULT_CHAPTER_CHARS;
      return {
        chapter_no: chapterNo, status: entry.status, words: entry.actual_words,
        truncated: raw.length > max,
        content: raw.length > max ? `${raw.slice(0, max)}…` : raw
      };
    }
  });

  registry.register({
    name: "search_text", kind: "read",
    description: "在全部章节正文中搜索文字，返回命中位置与上下文摘录（上限 20 条）。",
    params: { query: "要搜索的文字（按普通字符串匹配）" },
    run: async (args, ctx) => {
      const query = String(args.query ?? "").trim();
      if (!query) { const e = new Error("query 不能为空"); e.code = "bad_args"; throw e; }
      const index = await loadChapterIndex(ctx.projectRoot);
      const matches = [];
      for (const entry of index.chapters ?? []) {
        const filePath = entry.final_path ?? entry.draft_path;
        if (!filePath || !(await pathExists(filePath))) continue;
        const lines = (await fs.readFile(filePath, "utf8")).split("\n");
        for (let i = 0; i < lines.length && matches.length < 20; i += 1) {
          const col = lines[i].indexOf(query);
          if (col >= 0) {
            matches.push({
              chapter_no: entry.chapter_no, line: i + 1,
              excerpt: lines[i].slice(Math.max(0, col - 40), col + query.length + 40)
            });
          }
        }
        if (matches.length >= 20) break;
      }
      return { query, matches };
    }
  });

  registry.register({
    name: "read_continuity", kind: "read",
    description: "读取设定档案（事实/时间线/角色）。可指定 entity 只看某个实体。",
    params: { entity: "可选，实体名" },
    run: async (args, ctx) => {
      const data = await loadContinuity(ctx.projectRoot);
      const watermark = await loadContinuityState(ctx.projectRoot);
      if (args.entity) {
        return {
          entity: args.entity,
          facts: data.facts.filter((f) => f.entity === args.entity),
          character: data.characters.find((c) => c.name === args.entity) ?? null,
          last_extracted_chapter: watermark.last_extracted_chapter
        };
      }
      return { ...data, last_extracted_chapter: watermark.last_extracted_chapter };
    }
  });

  registry.register({
    name: "read_outline", kind: "read",
    description: "读取写作目标与任务计划（story_seed、目标章数、task_plan.md 若存在）。",
    params: {},
    run: async (_args, ctx) => {
      const taskPlanPath = safeJoin(ctx.projectRoot, "task_plan.md");
      const taskPlan = (await pathExists(taskPlanPath)) ? await fs.readFile(taskPlanPath, "utf8") : null;
      return {
        story_seed: ctx.project.story_seed,
        target_chapters: ctx.project.target_chapters,
        min_words_per_chapter: ctx.project.min_words_per_chapter,
        target_words_per_chapter: ctx.project.target_words_per_chapter,
        task_plan: taskPlan ? taskPlan.slice(0, 4000) : null
      };
    }
  });

  registry.register({
    name: "read_blueprint", kind: "read",
    description: "读取规划蓝图：OUTLINE.md（总纲 + 章节骨架）/ SETTING.md（世界观 + 角色 + 题材设定）。section 指定读哪份，默认两份都读。",
    params: { section: "outline | setting | all（默认 all）" },
    run: async (args, ctx) => {
      const outline = await fs.readFile(safeJoin(ctx.projectRoot, "OUTLINE.md"), "utf8").catch(() => null);
      const setting = await fs.readFile(safeJoin(ctx.projectRoot, "SETTING.md"), "utf8").catch(() => null);
      if (args.section === "outline") return { content: outline };
      if (args.section === "setting") return { content: setting };
      return { outline, setting };
    }
  });

  registry.register({
    name: "get_cost", kind: "read",
    description: "读取成本摘要：总花费、token、缓存命中、最近章节成本。",
    params: {},
    run: async (_args, ctx) => {
      const cost = await readJson(safeJoin(ctx.projectRoot, "cost.json"), null);
      if (!cost) return { available: false, message: "尚无成本数据。" };
      const byChapter = Object.entries(cost.byChapter ?? {}).slice(-5)
        .map(([no, v]) => ({ chapter_no: Number(no), calls: v.calls, estimated_cost: v.estimatedCost }));
      return {
        available: true, cost_available: cost.costAvailable === true,
        calls: cost.calls, total_tokens: cost.totalTokens, estimated_cost: cost.estimatedCost,
        cache_saved_cost: cost.cacheSavedCost, recent_hit_rates: cost.recentHitRates?.slice(-5) ?? [],
        recent_chapters: byChapter
      };
    }
  });
}
