import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileChapterPrompt } from "../src/core/agent-engine.mjs";
import { recordChapterMemory } from "../src/core/chapter-memory.mjs";
import { saveContinuity } from "../src/core/continuity-store.mjs";
import { safeJoin } from "../src/core/fs-utils.mjs";
import { createProject, loadProject, loadState, saveState } from "../src/core/project-store.mjs";
import { loadEnabledSkills } from "../src/core/skill-runtime.mjs";
import { chapterFileName } from "../src/core/tool-runtime.mjs";
import { DYNAMIC_BLOCK_ORDER, STABLE_BLOCK_ORDER } from "../src/core/prompt-compiler.mjs";

// M1 稳定区占比测量：真实项目 + 真实 compileChapterPrompt 编译路径，
// 统计 stable/dynamic 块字符占比（token proxy），推算稳态命中率上界
// （= stable 占比 + 动态区可复用部分；可复用部分本轮保守按 0）。
// 测量记录写入 gitignored 的 debug/measure-prompt-prefix.json。

const RECORD_PATH = path.resolve(import.meta.dirname, "../debug/measure-prompt-prefix.json");

// 用可重复的固定文本生成正文（字符数 ≈ approxChars），避免大段 fixture 文件
function prose(chapterNo, approxChars) {
  const sentence = `第${chapterNo}章叙述：雨落在窗台上，人物在灯下整理思绪，一句对白把场景往前推进一步。`;
  return sentence.repeat(Math.ceil(approxChars / sentence.length)).slice(0, approxChars);
}

// 与 runProject 同源的 runtime 构造方式：compileChapterPrompt 只消费 runtime.stepSkills
async function buildRuntime(projectRoot, project) {
  return { stepSkills: await loadEnabledSkills(projectRoot, project) };
}

// project_id 固定为常量：createProject 会随机生成 UUID 且被编入 current_task 的
// JSON（进而影响 dynamicHash），固定后测量记录跨运行字节一致（除 recorded_at）。
const MEASURE_PROJECT_ID = "project-measure";

function draftRequest(project, chapterNo, segmentNo, attempt = 1) {
  return {
    kind: "draft_segment",
    project_id: MEASURE_PROJECT_ID,
    chapter_no: chapterNo,
    segment_no: segmentNo,
    segment_target_words: Math.max(900, Math.ceil(project.target_words_per_chapter / 3)),
    allowed_tools: ["append_chapter_segment"],
    attempt
  };
}

async function compileScenario(projectRoot, project, state, runtime, request) {
  const compiled = await compileChapterPrompt(projectRoot, project, state, request, runtime);
  const total = compiled.blocks.reduce((sum, block) => sum + block.content.length, 0);
  const blocks = compiled.blocks.map((block) => ({
    name: block.name,
    kind: block.kind,
    chars: block.content.length,
    share: total > 0 ? block.content.length / total : 0
  }));
  const stableChars = blocks.filter((b) => b.kind === "stable").reduce((s, b) => s + b.chars, 0);
  const dynamicChars = blocks.filter((b) => b.kind === "dynamic").reduce((s, b) => s + b.chars, 0);
  return {
    compiled,
    blocks,
    stableChars,
    dynamicChars,
    stableShare: total > 0 ? stableChars / total : 0,
    dynamicShare: total > 0 ? dynamicChars / total : 0,
    totalChars: total
  };
}

// 模拟推进到第 3 章：用真实存储（chapter_memory / continuity / drafts / run_log）写入
// 前两章的产物，让第 3 章的编译拿到与真实流水线一致的动态区输入。
async function simulateProgressToChapter3(projectRoot, project) {
  await recordChapterMemory(projectRoot, {
    chapterNo: 1,
    title: "第001章：雨夜来信",
    actualWords: 3100,
    content: prose(1, 3400)
  });
  await recordChapterMemory(projectRoot, {
    chapterNo: 2,
    title: "第002章：档案室的灰",
    actualWords: 3200,
    content: prose(2, 3500)
  });
  await saveContinuity(projectRoot, {
    schema_version: 1,
    facts: [
      { entity: "林晚", attribute: "身份", value: "临河小城的档案管理员", chapter_no: 1, quote: "她每天整理尘封的卷宗。" },
      { entity: "林晚", attribute: "旧识", value: "失踪二十年的父亲", chapter_no: 2, quote: "信纸上残留父亲的笔迹。" },
      { entity: "顾沉舟", attribute: "身份", value: "市图书馆馆长", chapter_no: 2, quote: "他知道那枚印章的来历。" }
    ],
    characters: [
      { name: "林晚", status: "正常", traits: ["冷静", "记性好"] },
      { name: "顾沉舟", status: "正常", traits: ["温和", "深藏不露"] }
    ],
    timeline: [
      { chapter_no: 1, story_time_raw: "雨夜", events: ["林晚收到一封没有署名的信"] },
      { chapter_no: 2, story_time_raw: "次日清晨", events: ["林晚在档案馆查到信纸上的水印标记"] }
    ]
  });
  await fs.writeFile(
    safeJoin(projectRoot, "drafts", chapterFileName(3, `draft.${project.output_format}`)),
    `# Chapter 003\n\n${prose(3, 3400)}`,
    "utf8"
  );
  // 反馈事件用固定 event_id/timestamp 直接写 run_log.jsonl（与 appendEvent 同构）：
  // appendEvent 会用真实时钟盖时间戳，latest_user_feedback 会把它编入文案，
  // 导致测量记录的 dynamicHash 跨运行漂移。固定后记录字节一致。
  await fs.appendFile(
    safeJoin(projectRoot, "run_log.jsonl"),
    `${JSON.stringify({
      event_id: "event-measure-1",
      timestamp: "2026-07-31T00:00:00.000Z",
      project_id: project.project_id,
      chapter_no: null,
      stage: null,
      severity: "info",
      message: "让顾沉舟在第三章结尾透露印章的线索。",
      data: {},
      type: "user_instruction_received"
    })}\n`,
    "utf8"
  );
  const state = await loadState(projectRoot);
  state.current_chapter_no = 3;
  state.current_stage = "drafting";
  state.current_segment_no = 2;
  await saveState(projectRoot, state);
  return state;
}

function recommendTarget(minStableShare) {
  const planTarget = 0.8;
  if (minStableShare >= planTarget) {
    return {
      plan_target: planTarget,
      recommendation: "confirm",
      suggested_target: planTarget,
      rationale: `实测各编译视角的稳定区占比均不低于 ${planTarget}，80% 参考目标可达，按原目标确认。`
    };
  }
  // 前缀缓存下稳态命中率不可能超过 stable 区占比（动态区可复用部分本轮保守按 0），
  // 建议目标取实测最低稳定占比向下取整到 5%（不设人为下限，忠于测量值）。
  const suggested = Math.floor(minStableShare * 20) / 20;
  return {
    plan_target: planTarget,
    recommendation: "adjust",
    suggested_target: suggested,
    rationale: `前缀缓存下稳态命中率不可能超过 stable 区占比（动态区可复用部分本轮保守按 0），`
      + `实测稳态视角最低 ${minStableShare.toFixed(3)} < ${planTarget}，建议把参考目标调整为 ${suggested}；`
      + `第 1 章视角占比更高（见 compiles），随记忆/草稿累积动态区膨胀后占比下探。`
      + `要保住 80% 目标需先抬高稳定区：把 skill_instructions（启用技能）、source_summaries、`
      + `outline、输出风格模板等纳入稳定区，或把 current_task 中稳定形态的内容（allowed_tools/`
      + `写作指令）移出动态 JSON。`
  };
}

test("真实项目编译：第 1 章与第 3 章（模拟推进）的 stable/dynamic 占比测量并写入 debug 记录", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-prompt-prefix-"));
  const { projectRoot, project } = await createProject(root, { slug: "project" });
  const runtime = await buildRuntime(projectRoot, project);

  // 视角 A：第 1 章首段（全新项目，无记忆/反馈）
  const stateA = await loadState(projectRoot);
  stateA.current_stage = "drafting"; // 与真实流水线 drafting 阶段的 state 一致
  const resultA = await compileScenario(projectRoot, project, stateA, runtime, draftRequest(project, 1, 1));

  // 视角 B：第 3 章续写（真实存储推进后）
  const stateB = await simulateProgressToChapter3(projectRoot, project);
  const resultB = await compileScenario(projectRoot, project, stateB, runtime, draftRequest(project, 3, 2, 2));

  // 结构断言：块顺序稳定在前、动态在后；kind 只可能是 stable/dynamic；块名集合完整
  for (const result of [resultA, resultB]) {
    assert.ok(result.blocks.length >= 4, "编译结果应至少包含 4 个块");
    const stableNames = result.blocks.filter((b) => b.kind === "stable").map((b) => b.name);
    const dynamicNames = result.blocks.filter((b) => b.kind === "dynamic").map((b) => b.name);
    assert.deepEqual(
      stableNames,
      [...stableNames].sort((a, b) => STABLE_BLOCK_ORDER.indexOf(a) - STABLE_BLOCK_ORDER.indexOf(b)),
      "stable 块应按 STABLE_BLOCK_ORDER 排序"
    );
    assert.deepEqual(
      dynamicNames,
      [...dynamicNames].sort((a, b) => DYNAMIC_BLOCK_ORDER.indexOf(a) - DYNAMIC_BLOCK_ORDER.indexOf(b)),
      "dynamic 块应按 DYNAMIC_BLOCK_ORDER 排序"
    );
    const stableLast = result.blocks.map((b) => b.kind).lastIndexOf("stable");
    const dynamicFirst = result.blocks.map((b) => b.kind).indexOf("dynamic");
    assert.ok(stableLast < dynamicFirst, "stable 块应全部位于 dynamic 块之前");
    for (const block of result.blocks) {
      assert.ok(["stable", "dynamic"].includes(block.kind), `块 ${block.name} 的 kind 非法`);
    }
    assert.ok(result.stableShare > 0 && result.stableShare < 1, "stable 占比应在 (0,1) 内");
    assert.ok(Math.abs(result.stableShare + result.dynamicShare - 1) < 1e-9, "占比之和应为 1");
  }

  // 缓存性质：跨章 stable 区哈希不变（第 1 章 vs 第 3 章），dynamic 区哈希变化
  assert.equal(resultA.compiled.stableHash, resultB.compiled.stableHash, "跨章 stableHash 应保持不变");
  assert.notEqual(resultA.compiled.dynamicHash, resultB.compiled.dynamicHash, "跨章 dynamicHash 应变化");

  // 推算稳态命中率上界 = min 视角的 stable 占比（动态区可复用部分保守按 0）
  const minStableShare = Math.min(resultA.stableShare, resultB.stableShare);
  const record = {
    schema_version: 1,
    recorded_at: new Date().toISOString(),
    measurement: {
      method: "createProject(真实项目) + compileChapterPrompt(真实编译路径, 未 mock)",
      token_proxy: "JS string.length（UTF-16 code unit 字符数）",
      reusable_dynamic_share_assumed: 0,
      project_config: {
        title: project.title,
        story_seed: project.story_seed,
        output_format: project.output_format,
        target_chapters: project.target_chapters,
        min_words_per_chapter: project.min_words_per_chapter,
        target_words_per_chapter: project.target_words_per_chapter,
        output_style: project.output_style,
        enabled_skills: project.enabled_skills,
        prompt_template_versions: project.prompt_template_versions
      },
      environment_note: "本机无用户级 skills / output-styles，输出风格为内置 creative；source_summaries/outline 当前未参与编译",
      compiles: [resultA, resultB].map((result, i) => ({
        label: i === 0 ? "第 1 章首段（全新项目）" : "第 3 章续写（模拟推进 2 章后）",
        chapter_no: i === 0 ? 1 : 3,
        stage: i === 0 ? stateA.current_stage : stateB.current_stage,
        stable_hash: result.compiled.stableHash,
        dynamic_hash: result.compiled.dynamicHash,
        total_chars: result.totalChars,
        stable_chars: result.stableChars,
        dynamic_chars: result.dynamicChars,
        stable_share: result.stableShare,
        dynamic_share: result.dynamicShare,
        blocks: result.blocks
      })),
      stable_share_summary: {
        chapter1: resultA.stableShare,
        chapter3: resultB.stableShare,
        min: minStableShare
      },
      steady_state_hit_rate_upper_bound: {
        per_compile: [resultA.stableShare, resultB.stableShare],
        min: minStableShare
      }
    },
    reference_target: recommendTarget(minStableShare)
  };

  await fs.mkdir(path.dirname(RECORD_PATH), { recursive: true });
  await fs.writeFile(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const written = JSON.parse(await fs.readFile(RECORD_PATH, "utf8"));
  assert.equal(written.measurement.compiles.length, 2);
  assert.ok(written.measurement.steady_state_hit_rate_upper_bound.min > 0);
  assert.ok(["confirm", "adjust"].includes(written.reference_target.recommendation));
});
