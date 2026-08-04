// spec §1.7 跑偏核对（P1-6 / P1-7 / P2-10）：
// - runFactCheck 读 OUTLINE.md 总纲区（主线/核心矛盾）注入 buildFactCheckMessages
// - parsed.deviation = 软提示，不进 needs_revision，只写作者报告（proactive 消息 + reportHint）
// - 首章无 facts 时跑偏核对仍执行（只需 OUTLINE.md），事实矛盾维度跳过（现有行为）
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runFactCheck } from "../src/core/agent-engine.mjs";
import { buildFactCheckMessages, parseFactCheck } from "../src/core/quality-gates.mjs";
import { readChatHistory as readChatHist } from "../src/core/chat/chat-store.mjs";
import { loadContinuity, saveContinuity } from "../src/core/continuity-store.mjs";
import { readEvents } from "../src/core/event-log.mjs";
import { loadProject, loadState, saveProject } from "../src/core/project-store.mjs";
import { createWritingProject } from "./helpers.mjs";

const OUTLINE_SAMPLE = `# OUTLINE.md

## 一、总纲（锚点区 · 只增不改）
### 1. 主题与核心概念
复仇与救赎
### 2. 主线
主角为父复仇
### 3. 核心矛盾
复仇 vs 宽恕
### 4. 卷划分
第一卷 1-10 章

## 二、章节骨架（事实区 · 跟正文走）
### 第一卷
- [ ] 第1章《登场》：主角踏上复仇之路
`;

const FACT = { entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1, quote: "六楼。", conflict_with: null };

// 与 agent-engine.test.mjs 的 makeFactCheckProject 同构：非 mock provider + 预存 continuity。
// facts: [] 表示"首章无事实"；outline: null 表示不写 OUTLINE.md。
async function makeProject(prefix, { facts = [FACT], outline = OUTLINE_SAMPLE } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const { projectRoot } = await createWritingProject(root, {
    slug: "dev", title: "跑偏核对测试", story_seed: "种子",
    target_chapters: 2, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const project = await loadProject(projectRoot);
  project.active_model = { provider: "openai-compatible", model_name: "fake", base_url: "http://localhost:0", api_key_env: "FAKE_KEY" };
  await saveProject(projectRoot, project);
  await saveContinuity(projectRoot, { schema_version: 1, facts, timeline: [], characters: [] });
  if (outline !== null) {
    await fs.writeFile(path.join(projectRoot, "OUTLINE.md"), outline, "utf8");
  }
  return { projectRoot, project };
}

function modelClientReturning(text) {
  return { modelClient: { generate: async () => ({ text, usageReport: {} }) } };
}

const DEVIATION_REPLY = JSON.stringify({
  conflicts: [],
  deviation: { detected: true, description: "主角在酒楼喝茶，未推进复仇主线" }
});

test("buildFactCheckMessages 注入总纲参照段", () => {
  const messages = buildFactCheckMessages({
    chapterNo: 1, draft: "正文", facts: [], timeline: [],
    outlineContext: "主线：主角复仇"
  });
  assert.ok(messages.some((m) => m.content.includes("主线：主角复仇")), "总纲内容应出现在消息里");
  assert.equal(messages[1].role, "user", "用户消息位置不变（向后兼容）");
});

test("parseFactCheck 解析 deviation 字段，缺省降级为未检测", () => {
  const parsed = parseFactCheck(JSON.stringify({
    conflicts: [], deviation: { detected: true, description: "与主线无关" }
  }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.deviation, { detected: true, description: "与主线无关" });

  const legacy = parseFactCheck(JSON.stringify({ conflicts: [] }));
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.deviation, { detected: false, description: "" }, "旧模型不返回 deviation 时不报错");
});

test("runFactCheck 读 OUTLINE.md 总纲并注入模型消息", async () => {
  const { projectRoot, project } = await makeProject("dev-outline-");
  let capturedMessages = null;
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async ({ messages }) => {
      capturedMessages = messages;
      return { text: JSON.stringify({ conflicts: [], deviation: { detected: false, description: "" } }), usageReport: {} };
    } }
  }, "第一章正文。");
  assert.ok(capturedMessages, "模型应被调用");
  assert.ok(capturedMessages.some((m) => m.content.includes("主角为父复仇")), "主线应注入模型消息");
  assert.ok(capturedMessages.some((m) => m.content.includes("复仇 vs 宽恕")), "核心矛盾应注入模型消息");
  assert.equal(out.deviation.detected, false);
  assert.equal(out.reportHint, null, "未检测到偏离时不写提示");
});

test("deviation 软提示：不进 needs_revision，只写作者报告", async () => {
  const { projectRoot, project } = await makeProject("dev-soft-");
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, modelClientReturning(DEVIATION_REPLY), "主角在酒楼喝茶。");
  assert.equal(out.deviation.detected, true);
  assert.equal(out.conflicts.length, 0);
  assert.ok(out.reportHint.includes("偏离主线"), `reportHint 应含偏离主线提示，实际：${out.reportHint}`);

  const state = await loadState(projectRoot);
  assert.notEqual(state.current_stage, "needs_revision", "deviation 不阻断写作");
  const events = await readEvents(projectRoot);
  assert.ok(!events.some((e) => e.type === "quality_gate_failed"), "deviation 不产生 gate failed 事件");
  assert.ok(events.some((e) => e.type === "fact_check_deviation"), "应有 deviation 提示事件");
  const history = await readChatHist(projectRoot);
  const hint = history.find((m) => m.proactive === "fact_check");
  assert.ok(hint, "作者报告应有主动消息");
  assert.match(hint.content, /偏离主线/u);
});

test("首章无 facts：跑偏核对仍执行（对照总纲），事实矛盾维度跳过", async () => {
  const { projectRoot, project } = await makeProject("dev-nofacts-", { facts: [] });
  let calls = 0;
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => {
      calls += 1;
      return { text: DEVIATION_REPLY, usageReport: {} };
    } }
  }, "开篇写村中琐事。");
  assert.equal(calls, 1, "无 facts 时模型仍应被调用（跑偏维度只需总纲）");
  assert.ok(out.deviation, "跑偏维度仍执行");
  assert.equal(out.deviation.detected, true);
  assert.ok(out.reportHint.includes("偏离主线"));
  const events = await readEvents(projectRoot);
  assert.ok(!events.some((e) => e.type === "fact_check_skipped"), "不应跳过 fact-check");
});

test("无 facts 且无 OUTLINE.md：保持跳过（回归，现有行为不变）", async () => {
  const { projectRoot, project } = await makeProject("dev-skip-", { facts: [], outline: null });
  let calls = 0;
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => { calls += 1; return { text: "{}", usageReport: {} }; } }
  }, "正文。");
  assert.equal(out, null);
  assert.equal(calls, 0, "无对照依据时模型不应被调用");
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "fact_check_skipped"));
});

test("模型未返回 deviation：降级为未检测，不报错不阻断", async () => {
  const { projectRoot, project } = await makeProject("dev-legacy-");
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => ({ text: JSON.stringify({ conflicts: [] }), usageReport: {} }) }
  }, "正文。");
  assert.deepEqual(out.deviation, { detected: false, description: "" });
  assert.equal(out.reportHint, null);
  assert.equal(out.conflicts.length, 0);
});

test("deviation 与 conflicts 同报：conflicts 仍走硬阻断返回，deviation 不放大冲突", async () => {
  const { projectRoot, project } = await makeProject("dev-both-");
  const out = await runFactCheck(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => ({
      text: JSON.stringify({
        conflicts: [{ draft_quote: "从十二楼坠落", conflicts_with: "坠楼楼层: 六楼", prior_chapter: 1, severity: "high", suggestion: "改回六楼", replace_with: "从六楼坠落" }],
        deviation: { detected: true, description: "本章脱离主线" }
      }), usageReport: {}
    }) }
  }, "刘康从十二楼坠落。");
  assert.equal(out.conflicts.length, 1, "conflicts 照常返回");
  assert.equal(out.deviation.detected, true);
  assert.ok(out.reportHint.includes("偏离主线"));
  // 既有 continuity 不受影响
  const continuity = await loadContinuity(projectRoot);
  assert.equal(continuity.facts.length, 1);
});
