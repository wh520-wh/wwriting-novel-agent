# S2a 记忆链路 + S3 对话范式 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立连贯性记忆闭环（book_summary + continuity.md），并把产品交互重构为 Claude Code 式对话 agent（loop + 15 工具 + 确认机制 + 门禁对话化），单次交付。

**Architecture:** 引擎 `summarizing` 空过场阶段挂载记忆提取；新建 `src/core/chat/` 子系统承载 agent loop、JSON 工具协议、工具注册表；app-server 增 3 个 chat 端点（SSE）；本地门禁内建于 `reviewChapter`（与 word-count-gate 同形态），fact-check 结果以 agent 主动消息 + 预填 pending_action 呈现。

**Tech Stack:** Node 24 ESM（.mjs）、node:test + assert/strict、既有 ModelClient/CostTracker/event-log/project-store，无新外部依赖。

**Specs:** `../specs/2026-06-12-s2-memory-and-quality-gates-design.md`（S2a 部分）+ `../specs/2026-06-12-chat-agent-paradigm-design.md`（权威，含全部数据契约）+ `../specs/2026-06-12-software-maturity-roadmap-v3-design.md`

**纪律（每个任务收尾必做）：** `npm test` 全绿才能 commit；涉及 UI/服务端的 Phase 收尾跑 `npm run verify:app-shell` 与 `npm run verify:app-clickability`；最终验收跑 `npm run verify:local`。

---

## 现状接口速查（实施前必读，全部已核实）

| 接口 | 位置 | 签名/形态 |
|------|------|----------|
| ModelClient.generate | `src/core/model-client.mjs:55` | `generate({ project, stage, prompt, messages, metadata, signal })` → `{ text, raw, usageReport, costSummary, modelConfig }`；构造 `new ModelClient({ adapters, costTracker, ... })` |
| 一次性 client 模式 | `src/core/side-question.mjs:365` | `buildSideQuestionClient()`：adapters = openai-compatible + mock |
| 引擎 stage 机 | `src/core/agent-engine.mjs:138-146` | `case "summarizing": await completeChapter(...)` ← 记忆提取挂载点 |
| 门禁检查点 | `src/core/agent-engine.mjs:357-443` | `reviewChapter`：`runWordCountGate` → `runSkillChecks` → 失败 `needs_revision` + `quality_gate_failed` 事件 + `deriveFailureCard` |
| 章节记忆 | `src/core/chapter-memory.mjs` | `recordChapterMemory`、`buildContinuityPromptContext(projectRoot, currentChapterNo)`（现状=最近 `MAX_CONTEXT_CHAPTERS=4` 章头尾摘录）|
| prompt 组装 | `src/core/agent-engine.mjs:722-772` | `compileChapterPrompt`：`dynamicBlocks.project_memory = [bookSummary, continuityContext].join` |
| 事件日志 | `src/core/event-log.mjs` | `appendEvent(projectRoot, event)`、`readEvents(projectRoot, {limit})` |
| 项目存储 | `src/core/project-store.mjs` | `loadProject/loadState/saveState/loadChapterIndex/upsertChapter/writeCheckpoint` |
| 章节读取 | `src/core/app-dashboard.mjs` | `readChapterContent(projectRoot, chapterNo)` → `{ content, ... }` |
| 故障动作 | `src/core/failure-actions.mjs:8` | `applyFailureResolution(projectRoot, {command, args})`，command ∈ {pause-here, retry-segment, retry-with-prompt, fill-words, accept-current-words, skip-segment, accept-review-current, apply-review-suggestions, raise-budget, raise-cost-budget, raise-token-budget, switch-model, manual-review-handoff} |
| 设置更新 | `src/core/settings-runtime.mjs` | `updateProjectSettings(projectRoot, patch)`（含裸密钥拒绝等校验）|
| 指令展开 | `src/core/task-queue.mjs:247` | `expandInstruction(text, {currentChapter})` |
| 服务端辅助 | `src/core/app-server.mjs` | `readJsonBody(request)`、`serveJson(response, obj)`、`sendError(response, new HttpError(status, code, msg))`、`withProjectLock(context, projectRoot, fn)`、`context.runJobs` Map（key=resolve(projectRoot)，value=job 含 `.controller.abort()`）、`isJobRunning(job)`、`startProjectRun(projectRoot, project, context, task, meta)`、`resolveActiveProjectRoot(context)` |
| fs 工具 | `src/core/fs-utils.mjs` | `readJson(path, fallback)`、`writeJsonAtomic`、`writeFileAtomic`、`safeJoin(root, ...parts)`、`pathExists` |
| 字数 | `src/core/word-count.mjs` | `countEffectiveWords(content)` |
| 测试风格 | `tests/*.test.mjs` | `import test from "node:test"; import assert from "node:assert/strict";`，临时目录用 `fs.mkdtemp(path.join(os.tmpdir(), "wwriting-xxx-"))` |

## 文件结构（本计划锁定的分解）

```
新建：
  src/core/memory-extractor.mjs        提取调用的消息构造 + 输出解析（纯函数，无 IO）
  src/core/continuity-store.mjs        continuity.md/continuity_state.json 读写、合并、渲染
  src/core/quality-gates.mjs           title/word-cap 本地门禁 + fact-check 消息构造/解析（纯函数）
  src/core/chat/agent-protocol.mjs     parseAgentReply + buildSystemPrompt（工具文档生成）
  src/core/chat/tool-registry.mjs      工具注册表 + tool_permissions 检查
  src/core/chat/tools-read.mjs         6 个读工具
  src/core/chat/tools-write.mjs        6 个写工具
  src/core/chat/tools-control.mjs      3 个控制工具（server context 注入）
  src/core/chat/chat-store.mjs         chat_history.jsonl + chat_pending_action.json 存取
  src/core/chat/chat-context.mjs       上下文组装（系统提示+状态+记忆+历史窗口）
  src/core/chat/chat-agent.mjs         runChatTurn agent loop
  scripts/rebuild-memory.mjs           旧项目补建记忆
  scripts/verify-chat-online.mjs       真实 API 验收脚本
  tests/memory-extractor.test.mjs
  tests/continuity-store.test.mjs
  tests/quality-gates.test.mjs
  tests/chat-protocol.test.mjs
  tests/chat-tools.test.mjs
  tests/chat-store.test.mjs
  tests/chat-agent.test.mjs
  tests/fixtures/s2-corpus/            审计坏样本语料（楼层矛盾对、标题错乱等）
修改：
  src/core/agent-engine.mjs            summarizing 挂提取；reviewChapter 挂新门禁
  src/core/chapter-memory.mjs          MAX_CONTEXT_CHAPTERS 4 → 2（Phase 0 T4）
  src/core/app-server.mjs              /api/chat/send|confirm|history + 控制工具注入
  src/app-shell/api-client.js          chat API 封装
  src/app-shell/thread-renderer.js     对话气泡/工具卡/确认卡渲染
  src/app-shell/composer.js            默认输入走对话
  scripts/verify-app-clickability.cjs  对话 UI 探针
  package.json                         scripts: audit:rebuild-memory、verify:chat-online
```

**实施顺序硬约束：** Phase 0 → 1 → 2 → 3 → 4 → 5。Phase 内任务按编号顺序。每个任务独立提交。

---

# Phase 0 — S2a 连贯性记忆链路

## Task 1: memory-extractor 纯函数（消息构造 + 输出解析）

**Files:**
- Create: `src/core/memory-extractor.mjs`
- Test: `tests/memory-extractor.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// tests/memory-extractor.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { buildMemoryExtractionMessages, parseMemoryExtraction } from "../src/core/memory-extractor.mjs";

test("buildMemoryExtractionMessages 包含章节正文与既有记忆", () => {
  const messages = buildMemoryExtractionMessages({
    chapterNo: 9,
    chapterContent: "沈泽走到北围墙。",
    bookSummary: "# 全书摘要\n\n前八章概述。",
    continuityMarkdown: "## 刘康\n- 坠楼楼层: 六楼 (第1章)"
  });
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /JSON/u);
  const user = messages[1].content;
  assert.match(user, /沈泽走到北围墙/u);
  assert.match(user, /前八章概述/u);
  assert.match(user, /坠楼楼层/u);
  assert.match(user, /第 9 章/u);
});

test("parseMemoryExtraction 解析带围栏的合法输出", () => {
  const raw = '```json\n{"summary":"新摘要","facts":[{"entity":"刘康","attribute":"坠楼楼层","value":"六楼","chapter_no":1,"quote":"六楼。"}],"timeline":[{"chapter_no":9,"story_time":"十月下旬","events":["沈泽探查北围墙"]}],"characters":[{"name":"沈泽","traits":["谨慎"],"status":"存活","chapter_no":9}]}\n```';
  const parsed = parseMemoryExtraction(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary, "新摘要");
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.facts[0].entity, "刘康");
  assert.equal(parsed.timeline[0].chapter_no, 9);
  assert.equal(parsed.characters[0].name, "沈泽");
});

test("parseMemoryExtraction 对畸形输出返回 ok:false 不抛异常", () => {
  assert.equal(parseMemoryExtraction("我无法输出 JSON").ok, false);
  assert.equal(parseMemoryExtraction('{"summary": 123}').ok, false); // summary 必须是字符串
  assert.equal(parseMemoryExtraction("").ok, false);
});

test("parseMemoryExtraction 裁剪超长 summary 到 2000 字", () => {
  const long = "字".repeat(3000);
  const parsed = parseMemoryExtraction(JSON.stringify({ summary: long, facts: [], timeline: [], characters: [] }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary.length, 2000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/memory-extractor.test.mjs`
Expected: FAIL（Cannot find module …/memory-extractor.mjs）

- [ ] **Step 3: 实现**

```js
// src/core/memory-extractor.mjs
// 记忆提取的消息构造与输出解析。纯函数，无文件 IO，便于单测与回放。
export const MEMORY_SUMMARY_MAX_CHARS = 2000;
export const MEMORY_EXTRACT_STAGE = "memory_extract";

const SYSTEM_PROMPT = [
  "你是小说项目的记忆管理员。读完本章后更新全书记忆。",
  "只输出一个 JSON 对象（可用 ```json 围栏），不要输出其他内容。结构：",
  '{"summary":"全书滚动摘要(中文,<=2000字,覆盖到本章为止的主线、关键事实与未回收伏笔)",',
  '"facts":[{"entity":"实体名","attribute":"属性","value":"值","chapter_no":本章号,"quote":"原文短引(<=40字)"}],',
  '"timeline":[{"chapter_no":本章号,"story_time":"故事内时间","events":["事件"]}],',
  '"characters":[{"name":"角色名","traits":["标志性特征"],"status":"状态","chapter_no":本章号}]}',
  "facts 只收新增或被修正的客观设定（地点、数字、时间、生死、关系），不收主观评价。",
  "若本章与既有记忆冲突，照实提取本章版本，不要擅自调和。"
].join("\n");

export function buildMemoryExtractionMessages({ chapterNo, chapterContent, bookSummary, continuityMarkdown }) {
  const user = [
    `# 第 ${chapterNo} 章正文`,
    String(chapterContent ?? ""),
    "",
    "# 既有全书摘要",
    String(bookSummary ?? "(空)"),
    "",
    "# 既有设定档案",
    String(continuityMarkdown ?? "(空)"),
    "",
    `请基于第 ${chapterNo} 章更新记忆，输出 JSON。`
  ].join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user }
  ];
}

export function parseMemoryExtraction(rawText) {
  const text = String(rawText ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  let data;
  try {
    data = JSON.parse(candidate);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (typeof data?.summary !== "string" || !data.summary.trim()) {
    return { ok: false, error: "missing_summary" };
  }
  const summary = data.summary.trim().slice(0, MEMORY_SUMMARY_MAX_CHARS);
  const facts = normalizeArray(data.facts, (item) => ({
    entity: requiredString(item.entity),
    attribute: requiredString(item.attribute),
    value: requiredString(item.value),
    chapter_no: Number(item.chapter_no) || null,
    quote: String(item.quote ?? "").slice(0, 80)
  }), (f) => f.entity && f.attribute && f.value);
  const timeline = normalizeArray(data.timeline, (item) => ({
    chapter_no: Number(item.chapter_no) || null,
    story_time: String(item.story_time ?? ""),
    events: Array.isArray(item.events) ? item.events.map((e) => String(e)).slice(0, 10) : []
  }), (t) => t.chapter_no !== null);
  const characters = normalizeArray(data.characters, (item) => ({
    name: requiredString(item.name),
    traits: Array.isArray(item.traits) ? item.traits.map((t) => String(t)).slice(0, 10) : [],
    status: String(item.status ?? ""),
    chapter_no: Number(item.chapter_no) || null
  }), (c) => Boolean(c.name));
  return { ok: true, summary, facts, timeline, characters };
}

function normalizeArray(value, mapFn, filterFn) {
  if (!Array.isArray(value)) return [];
  return value.map(mapFn).filter(filterFn).slice(0, 50);
}

function requiredString(value) {
  const s = String(value ?? "").trim();
  return s || null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/memory-extractor.test.mjs`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/core/memory-extractor.mjs tests/memory-extractor.test.mjs
git commit -m "feat(s2a): memory extraction message builder and tolerant parser"
```

## Task 2: continuity-store（设定档案存储：读写/合并/渲染/水位）

**Files:**
- Create: `src/core/continuity-store.mjs`
- Test: `tests/continuity-store.test.mjs`

**数据契约**（spec §8 与 S2 spec 组件 1）：结构化数据落 `memory/continuity.json`（机器读写），渲染产物落 `memory/continuity.md`（prompt/人读）。两者同步写，json 是事实源。水位独立 `memory/continuity_state.json`。

```json
// memory/continuity.json
{ "schema_version": 1,
  "facts": [{ "entity": "刘康", "attribute": "坠楼楼层", "value": "六楼", "chapter_no": 1, "quote": "六楼。", "conflict_with": null }],
  "timeline": [{ "chapter_no": 1, "story_time": "十月某周一", "events": ["刘康坠楼身亡"] }],
  "characters": [{ "name": "刘康", "traits": ["叼着不点的烟"], "status": "已死亡", "chapter_no": 1 }] }
// memory/continuity_state.json
{ "schema_version": 1, "last_extracted_chapter": 8, "updated_at": "ISO" }
```

- [ ] **Step 1: 写失败测试**

```js
// tests/continuity-store.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadContinuity, mergeExtraction, saveContinuity, renderContinuityMarkdown,
  loadContinuityState, saveContinuityState
} from "../src/core/continuity-store.mjs";

async function tmpProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-continuity-"));
  await fs.mkdir(path.join(root, "memory"), { recursive: true });
  return root;
}

test("loadContinuity 无文件时返回空结构", async () => {
  const root = await tmpProject();
  const data = await loadContinuity(root);
  assert.deepEqual(data.facts, []);
  assert.deepEqual(data.timeline, []);
  assert.deepEqual(data.characters, []);
});

test("mergeExtraction 新事实追加，同实体同属性新值标记冲突", () => {
  const base = { schema_version: 1, facts: [
    { entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1, quote: "六楼。", conflict_with: null }
  ], timeline: [], characters: [] };
  const merged = mergeExtraction(base, {
    facts: [{ entity: "刘康", attribute: "坠楼楼层", value: "十二楼", chapter_no: 2, quote: "十二楼。" }],
    timeline: [{ chapter_no: 2, story_time: "次日", events: ["去工地"] }],
    characters: [{ name: "老马", traits: ["观察敏锐"], status: "存活", chapter_no: 2 }]
  });
  const floors = merged.facts.filter((f) => f.attribute === "坠楼楼层");
  assert.equal(floors.length, 2);
  assert.equal(floors[1].conflict_with, "第1章: 六楼"); // 新条目标记与旧值冲突
  assert.equal(merged.timeline.length, 1);
  assert.equal(merged.characters[0].name, "老马");
});

test("mergeExtraction 同实体同属性同值去重（幂等，供 finalize 重跑）", () => {
  const base = { schema_version: 1, facts: [
    { entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1, quote: "六楼。", conflict_with: null }
  ], timeline: [], characters: [] };
  const merged = mergeExtraction(base, {
    facts: [{ entity: "刘康", attribute: "坠楼楼层", value: "六楼", chapter_no: 1, quote: "六楼。" }],
    timeline: [], characters: []
  });
  assert.equal(merged.facts.length, 1);
});

test("characters 同名合并：traits 并集、status 取新", () => {
  const base = { schema_version: 1, facts: [], timeline: [], characters: [
    { name: "刘康", traits: ["叼着不点的烟"], status: "存活", chapter_no: 1 }
  ] };
  const merged = mergeExtraction(base, {
    facts: [], timeline: [],
    characters: [{ name: "刘康", traits: ["放高利贷"], status: "已死亡", chapter_no: 1 }]
  });
  assert.equal(merged.characters.length, 1);
  assert.deepEqual(merged.characters[0].traits, ["叼着不点的烟", "放高利贷"]);
  assert.equal(merged.characters[0].status, "已死亡");
});

test("save + load 往返一致，且渲染 markdown 同步落盘", async () => {
  const root = await tmpProject();
  const data = mergeExtraction(await loadContinuity(root), {
    facts: [{ entity: "沈泽", attribute: "能力", value: "意念致死", chapter_no: 1, quote: "他去死就好了。" }],
    timeline: [{ chapter_no: 1, story_time: "十月", events: ["能力觉醒"] }],
    characters: [{ name: "沈泽", traits: ["谨慎"], status: "存活", chapter_no: 1 }]
  });
  await saveContinuity(root, data);
  const reloaded = await loadContinuity(root);
  assert.equal(reloaded.facts[0].value, "意念致死");
  const md = await fs.readFile(path.join(root, "memory", "continuity.md"), "utf8");
  assert.match(md, /沈泽/u);
  assert.match(md, /意念致死/u);
  assert.match(md, /第1章/u);
});

test("renderContinuityMarkdown 含冲突标记", () => {
  const md = renderContinuityMarkdown({ schema_version: 1, facts: [
    { entity: "刘康", attribute: "坠楼楼层", value: "十二楼", chapter_no: 2, quote: "", conflict_with: "第1章: 六楼" }
  ], timeline: [], characters: [] });
  assert.match(md, /⚠.*冲突.*第1章: 六楼/u);
});

test("水位读写", async () => {
  const root = await tmpProject();
  assert.equal((await loadContinuityState(root)).last_extracted_chapter, 0);
  await saveContinuityState(root, { last_extracted_chapter: 9 });
  assert.equal((await loadContinuityState(root)).last_extracted_chapter, 9);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/continuity-store.test.mjs`
Expected: FAIL（Cannot find module …/continuity-store.mjs）

- [ ] **Step 3: 实现**

```js
// src/core/continuity-store.mjs
// 连贯性设定档案：continuity.json 为事实源，continuity.md 为渲染产物（prompt 与人读）。
import { readJson, safeJoin, writeFileAtomic, writeJsonAtomic } from "./fs-utils.mjs";

export const CONTINUITY_SCHEMA_VERSION = 1;
export const MAX_FACTS_PER_ENTITY = 20;

const EMPTY = () => ({ schema_version: CONTINUITY_SCHEMA_VERSION, facts: [], timeline: [], characters: [] });

export async function loadContinuity(projectRoot) {
  const data = await readJson(safeJoin(projectRoot, "memory", "continuity.json"), EMPTY());
  return {
    schema_version: CONTINUITY_SCHEMA_VERSION,
    facts: Array.isArray(data.facts) ? data.facts : [],
    timeline: Array.isArray(data.timeline) ? data.timeline : [],
    characters: Array.isArray(data.characters) ? data.characters : []
  };
}

export async function saveContinuity(projectRoot, data) {
  await writeJsonAtomic(safeJoin(projectRoot, "memory", "continuity.json"), data);
  await writeFileAtomic(safeJoin(projectRoot, "memory", "continuity.md"), renderContinuityMarkdown(data));
  return data;
}

export function mergeExtraction(base, extraction) {
  const next = { ...EMPTY(), ...structuredClone(base) };
  for (const fact of extraction.facts ?? []) {
    const same = next.facts.find((f) => f.entity === fact.entity && f.attribute === fact.attribute && f.value === fact.value);
    if (same) continue; // 幂等：finalize 重跑不产生重复
    const prior = [...next.facts].reverse().find((f) => f.entity === fact.entity && f.attribute === fact.attribute);
    next.facts.push({
      entity: fact.entity, attribute: fact.attribute, value: fact.value,
      chapter_no: fact.chapter_no ?? null, quote: fact.quote ?? "",
      conflict_with: prior ? `第${prior.chapter_no}章: ${prior.value}` : null
    });
    enforceEntityCap(next.facts, fact.entity);
  }
  for (const node of extraction.timeline ?? []) {
    const dup = next.timeline.find((t) => t.chapter_no === node.chapter_no && t.story_time === node.story_time);
    if (!dup) next.timeline.push({ chapter_no: node.chapter_no, story_time: node.story_time ?? "", events: node.events ?? [] });
  }
  for (const ch of extraction.characters ?? []) {
    const existing = next.characters.find((c) => c.name === ch.name);
    if (existing) {
      existing.traits = [...new Set([...existing.traits, ...(ch.traits ?? [])])].slice(0, 10);
      if (ch.status) existing.status = ch.status;
      existing.chapter_no = ch.chapter_no ?? existing.chapter_no;
    } else {
      next.characters.push({ name: ch.name, traits: ch.traits ?? [], status: ch.status ?? "", chapter_no: ch.chapter_no ?? null });
    }
  }
  return next;
}

function enforceEntityCap(facts, entity) {
  const indices = facts.map((f, i) => (f.entity === entity ? i : -1)).filter((i) => i >= 0);
  while (indices.length > MAX_FACTS_PER_ENTITY) {
    facts.splice(indices.shift(), 1);
    for (let k = 0; k < indices.length; k += 1) indices[k] -= 1;
  }
}

export function renderContinuityMarkdown(data) {
  const lines = ["# 设定档案（continuity）", ""];
  const byEntity = new Map();
  for (const fact of data.facts) {
    if (!byEntity.has(fact.entity)) byEntity.set(fact.entity, []);
    byEntity.get(fact.entity).push(fact);
  }
  lines.push("## 事实");
  for (const [entity, facts] of byEntity) {
    lines.push(`### ${entity}`);
    for (const f of facts) {
      const conflict = f.conflict_with ? ` ⚠ 与既有记录冲突（${f.conflict_with}），以人工或门禁裁决为准` : "";
      lines.push(`- ${f.attribute}: ${f.value} (第${f.chapter_no}章)${conflict}`);
    }
  }
  lines.push("", "## 时间线");
  for (const t of [...data.timeline].sort((a, b) => (a.chapter_no ?? 0) - (b.chapter_no ?? 0))) {
    lines.push(`- 第${t.chapter_no}章 [${t.story_time}]: ${t.events.join("；")}`);
  }
  lines.push("", "## 角色");
  for (const c of data.characters) {
    lines.push(`- ${c.name}（${c.status || "状态未知"}）：${c.traits.join("、") || "无记录特征"}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function loadContinuityState(projectRoot) {
  const state = await readJson(safeJoin(projectRoot, "memory", "continuity_state.json"), {
    schema_version: CONTINUITY_SCHEMA_VERSION, last_extracted_chapter: 0, updated_at: null
  });
  return { ...state, last_extracted_chapter: Number(state.last_extracted_chapter) || 0 };
}

export async function saveContinuityState(projectRoot, patch) {
  const current = await loadContinuityState(projectRoot);
  const next = { ...current, ...patch, schema_version: CONTINUITY_SCHEMA_VERSION, updated_at: new Date().toISOString() };
  await writeJsonAtomic(safeJoin(projectRoot, "memory", "continuity_state.json"), next);
  return next;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/continuity-store.test.mjs`
Expected: PASS（7 tests）

- [ ] **Step 5: 提交**

```bash
git add src/core/continuity-store.mjs tests/continuity-store.test.mjs
git commit -m "feat(s2a): continuity store with conflict marking, entity cap, watermark"
```

## Task 3: 引擎集成——summarizing 阶段执行记忆提取

**Files:**
- Modify: `src/core/agent-engine.mjs`（138-146 行 stage 分发不动；521-542 行 `completeChapter` 前插入提取；`createModelRuntime` 区域看 544 行起）
- Test: `tests/agent-engine.test.mjs`（追加用例）

**行为规格：**
1. 新函数 `extractChapterMemory(projectRoot, project, state, runtime)`，在 `case "summarizing":` 分支中、`completeChapter` 之前调用。
2. 开关：`project.memory_extraction?.enabled !== false`（默认开）。mock provider（`active_model.provider === "mock"` 或未配置）时**跳过模型调用**，但仍把 `last_extracted_chapter` 推进（mock 长跑不破坏）——事件记 `memory_extract_skipped`。
3. 幂等：若 `continuity_state.last_extracted_chapter >= state.current_chapter_no`，直接跳过（finalize 重跑安全）。
4. 成功：`mergeExtraction` + `saveContinuity` + book_summary 整体重写 + 水位推进 + 事件 `memory_extract_completed`（data 含 facts_added 数）。
5. 失败（调用抛错/解析 ok:false 重试 1 次仍败）：事件 `memory_extract_failed`（severity warn）+ **不阻塞**，水位不动（下章补提由 Task 5 脚本或下次 summarizing 处理同章）——注意：水位不动时下一章 summarizing 只提取下一章自己，跳过的章留给 rebuild 脚本。简化为：失败也推进水位但事件里记 `lost_chapter`，避免重复半失败循环。**采用后者**。
6. 模型调用：`runtime.modelClient.generate({ project, stage: "memory_extract", messages, metadata: { memoryExtract: true, chapterNo } })`。`runtime` 即引擎现有 model runtime（含项目 costTracker → byStage 自动归因 `memory_extract`）。

- [ ] **Step 1: 写失败测试**（追加到 `tests/agent-engine.test.mjs` 末尾）

```js
// 追加 import（文件顶部已有的不重复加）：
import { loadContinuity, loadContinuityState } from "../src/core/continuity-store.mjs";

test("summarizing 阶段写入 book_summary 与 continuity（真实 provider 路径用注入的 fake client）", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-memx-"));
  const { projectRoot } = await createProject(root, {
    slug: "memx", title: "记忆测试", story_seed: "测试种子",
    target_chapters: 1, min_words_per_chapter: 10, target_words_per_chapter: 12, max_model_calls: 50
  });
  // 把项目改成"非 mock"以走提取路径，但注入 fakeClient 拦截真实网络。
  const project = await loadProject(projectRoot);
  project.active_model = { provider: "openai-compatible", model_name: "fake-model", base_url: "http://localhost:0", api_key_env: "FAKE_KEY" };
  await saveProject(projectRoot, project);
  const extraction = {
    summary: "第一章：主角能力觉醒。",
    facts: [{ entity: "沈泽", attribute: "能力", value: "意念致死", chapter_no: 1, quote: "他去死就好了" }],
    timeline: [{ chapter_no: 1, story_time: "十月", events: ["觉醒"] }],
    characters: [{ name: "沈泽", traits: ["谨慎"], status: "存活", chapter_no: 1 }]
  };
  const calls = [];
  const fakeClient = {
    generate: async ({ stage, messages }) => {
      calls.push(stage);
      if (stage === "memory_extract") {
        return { text: "```json\n" + JSON.stringify(extraction) + "\n```", usageReport: {} };
      }
      throw new Error(`unexpected stage ${stage}`);
    }
  };
  // 引擎跑不动真实写作（fake provider），这里直接调用导出的 extractChapterMemory。
  const { extractChapterMemory } = await import("../src/core/agent-engine.mjs");
  await extractChapterMemory(projectRoot, project, { current_chapter_no: 1 }, { modelClient: fakeClient });
  const summary = await fs.readFile(path.join(projectRoot, "memory", "book_summary.md"), "utf8");
  assert.match(summary, /能力觉醒/u);
  const continuity = await loadContinuity(projectRoot);
  assert.equal(continuity.facts[0].value, "意念致死");
  assert.equal((await loadContinuityState(projectRoot)).last_extracted_chapter, 1);
  // 幂等：重跑不再调用模型
  await extractChapterMemory(projectRoot, project, { current_chapter_no: 1 }, { modelClient: fakeClient });
  assert.equal(calls.filter((s) => s === "memory_extract").length, 1);
});

test("mock provider 跳过提取但推进水位", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-memskip-"));
  const { projectRoot } = await createProject(root, {
    slug: "memskip", title: "跳过测试", story_seed: "种子",
    target_chapters: 1, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const project = await loadProject(projectRoot);
  const { extractChapterMemory } = await import("../src/core/agent-engine.mjs");
  await extractChapterMemory(projectRoot, project, { current_chapter_no: 1 }, { modelClient: { generate: async () => { throw new Error("must not call"); } } });
  assert.equal((await loadContinuityState(projectRoot)).last_extracted_chapter, 1);
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "memory_extract_skipped"));
});

test("提取失败软跳过：事件 memory_extract_failed 且水位推进", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-memfail-"));
  const { projectRoot } = await createProject(root, {
    slug: "memfail", title: "失败测试", story_seed: "种子",
    target_chapters: 1, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  const project = await loadProject(projectRoot);
  project.active_model = { provider: "openai-compatible", model_name: "fake", base_url: "http://localhost:0", api_key_env: "FAKE_KEY" };
  await saveProject(projectRoot, project);
  const { extractChapterMemory } = await import("../src/core/agent-engine.mjs");
  await extractChapterMemory(projectRoot, project, { current_chapter_no: 1 }, {
    modelClient: { generate: async () => ({ text: "不是 JSON", usageReport: {} }) }
  });
  const events = await readEvents(projectRoot);
  assert.ok(events.some((e) => e.type === "memory_extract_failed"));
  assert.equal((await loadContinuityState(projectRoot)).last_extracted_chapter, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/agent-engine.test.mjs`
Expected: FAIL（extractChapterMemory is not exported / not a function）

- [ ] **Step 3: 实现**

在 `src/core/agent-engine.mjs` 顶部 import 区追加：

```js
import { buildMemoryExtractionMessages, parseMemoryExtraction } from "./memory-extractor.mjs";
import { loadContinuity, mergeExtraction, saveContinuity, loadContinuityState, saveContinuityState } from "./continuity-store.mjs";
import { readChapterContent } from "./app-dashboard.mjs";
```

（注意：`app-dashboard.mjs` 若 import agent-engine 会成环——核实后若成环，把 `readChapterContent` 的逻辑换成直接 `fs.readFile(chapter final_path)`：从 `loadChapterIndex` 取 `final_path` 读文件。实施时先 `node -e "import('./src/core/agent-engine.mjs')"` 验证无环。）

`case "summarizing":` 分支改为：

```js
        case "summarizing":
          await extractChapterMemory(projectRoot, project, state, runtime);
          await completeChapter(projectRoot, project, state);
          break;
```

新函数（放在 `completeChapter` 之前，并加入文件导出）：

```js
export async function extractChapterMemory(projectRoot, project, state, runtime) {
  const chapterNo = state.current_chapter_no;
  if (project.memory_extraction?.enabled === false) return;
  const watermark = await loadContinuityState(projectRoot);
  if (watermark.last_extracted_chapter >= chapterNo) return; // 幂等
  const provider = project.active_model?.provider ?? "mock";
  if (provider === "mock") {
    await saveContinuityState(projectRoot, { last_extracted_chapter: chapterNo });
    await appendEvent(projectRoot, {
      type: "memory_extract_skipped", project_id: project.project_id, chapter_no: chapterNo,
      stage: "summarizing", message: "mock provider，跳过记忆提取"
    });
    return;
  }
  try {
    const index = await loadChapterIndex(projectRoot);
    const entry = index.chapters.find((c) => c.chapter_no === chapterNo);
    const chapterPath = entry?.final_path ?? entry?.draft_path;
    const chapterContent = chapterPath ? await fs.readFile(chapterPath, "utf8") : "";
    const [bookSummary, continuity] = await Promise.all([
      readOptionalProjectText(projectRoot, "memory", "book_summary.md"),
      loadContinuity(projectRoot)
    ]);
    const messages = buildMemoryExtractionMessages({
      chapterNo, chapterContent,
      bookSummary, continuityMarkdown: renderForPrompt(continuity)
    });
    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed?.ok; attempt += 1) {
      const result = await runtime.modelClient.generate({
        project, stage: "memory_extract", messages,
        metadata: { memoryExtract: true, chapterNo, attempt }
      });
      parsed = parseMemoryExtraction(result.text);
    }
    if (!parsed.ok) throw new Error(`memory extraction parse failed: ${parsed.error}`);
    const merged = mergeExtraction(continuity, parsed);
    await saveContinuity(projectRoot, merged);
    await writeFileAtomic(safeJoin(projectRoot, "memory", "book_summary.md"), `# 全书摘要\n\n${parsed.summary}\n`);
    await saveContinuityState(projectRoot, { last_extracted_chapter: chapterNo });
    await appendEvent(projectRoot, {
      type: "memory_extract_completed", project_id: project.project_id, chapter_no: chapterNo,
      stage: "summarizing", message: `记忆已更新（新增事实 ${parsed.facts.length} 条）`,
      data: { facts_added: parsed.facts.length, timeline_added: parsed.timeline.length }
    });
  } catch (error) {
    await saveContinuityState(projectRoot, { last_extracted_chapter: chapterNo });
    await appendEvent(projectRoot, {
      type: "memory_extract_failed", project_id: project.project_id, chapter_no: chapterNo,
      stage: "summarizing", severity: "warn",
      message: `记忆提取失败（不影响写作，可用 audit:rebuild-memory 补建）：${error.message}`,
      data: { lost_chapter: chapterNo }
    });
  }
}

function renderForPrompt(continuity) {
  // prompt 里给紧凑版（完整渲染在 continuity.md）
  const facts = continuity.facts.map((f) => `- ${f.entity}/${f.attribute}: ${f.value} (第${f.chapter_no}章)`).join("\n");
  const chars = continuity.characters.map((c) => `- ${c.name}(${c.status}): ${c.traits.join("、")}`).join("\n");
  return [facts, chars].filter(Boolean).join("\n");
}
```

> `readOptionalProjectText`、`writeFileAtomic`、`safeJoin`、`appendEvent`、`loadChapterIndex`、`fs` 在 agent-engine.mjs 中均已存在/已 import；实施时核对，缺哪个补哪个 import。`readChapterContent` 不需要了（上面直接读 final_path），删掉该 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/agent-engine.test.mjs`
Expected: PASS（含 3 个新用例）

- [ ] **Step 5: 跑全量测试 + mock 端到端**

Run: `npm test` → 全绿；`npm run verify:mvp` → ok:true（mock 路径走 skipped 不破坏）

- [ ] **Step 6: 提交**

```bash
git add src/core/agent-engine.mjs tests/agent-engine.test.mjs
git commit -m "feat(s2a): wire memory extraction into summarizing stage with soft-fail watermark"
```

## Task 4: prompt 集成——project_memory 块改用新记忆，摘录减量

**Files:**
- Modify: `src/core/chapter-memory.mjs:4`（`MAX_CONTEXT_CHAPTERS` 4 → 2）
- Modify: `src/core/agent-engine.mjs:726-742`（compileChapterPrompt 读取 continuity.md）
- Test: `tests/chapter-memory.test.mjs`（更新常量断言）+ `tests/model-gateway.test.mjs` 不受影响

**行为规格：** `dynamicBlocks.project_memory` 组合顺序固定为 `[bookSummary, continuityMd, recentExcerpts]`——book_summary 和 continuity.md 内容增长缓慢（有界），放前部利好前缀缓存；最近 2 章头尾摘录放尾部（每章必变）。

- [ ] **Step 1: 改 `MAX_CONTEXT_CHAPTERS`**

```js
// src/core/chapter-memory.mjs:4
export const MAX_CONTEXT_CHAPTERS = 2;
```

若 `tests/chapter-memory.test.mjs` 有断言 4 的用例，更新为 2（先 `node --test tests/chapter-memory.test.mjs` 看失败点再改断言）。

- [ ] **Step 2: compileChapterPrompt 增读 continuity.md**

在 `agent-engine.mjs:726` 的 `Promise.all` 数组末尾追加一项，并解构为 `continuityMd`：

```js
  const [promptTemplate, bookSummary, draft, latestUserFeedback, planningSkillPrompts, stageSkillPrompts, continuityContext, continuityMd] = await Promise.all([
    /* ……既有 7 项不动…… */,
    readOptionalProjectText(projectRoot, "memory", "continuity.md")
  ]);
```

772 行 `project_memory` 改为：

```js
      project_memory: [bookSummary, continuityMd, continuityContext].filter(Boolean).join("\n\n"),
```

- [ ] **Step 3: 跑全量测试**

Run: `npm test`
Expected: PASS（若 prompt 快照类断言失败，按新组合顺序更新断言）

- [ ] **Step 4: mock 长跑回归（缓存契约不破坏）**

Run: `npm run verify:longrun`
Expected: ok:true 且 `stableChanged=false`（project_memory 本就是 dynamic 块，stable hash 不受影响）

- [ ] **Step 5: 提交**

```bash
git add src/core/chapter-memory.mjs src/core/agent-engine.mjs tests/
git commit -m "feat(s2a): project_memory prompt block uses book summary + continuity, recent excerpts cut to 2"
```

## Task 5: rebuild-memory 脚本（旧项目补建）

**Files:**
- Create: `scripts/rebuild-memory.mjs`
- Modify: `package.json`（scripts 增 `"audit:rebuild-memory": "node scripts/rebuild-memory.mjs"`）

**行为规格：** `node scripts/rebuild-memory.mjs <projectRoot> [--from 1] [--dry-run]`。按章顺序对每个 `status==="completed"` 且 `chapter_no > last_extracted_chapter` 的章节跑提取（复用 `extractChapterMemory`，临时构造 `state` 与 `runtime`）。`--dry-run` 只打印将处理的章节与预估调用数。模型 runtime 用与引擎一致的构造（OpenAICompatibleAdapter + 项目 costTracker——成本照常入账 byStage=memory_extract）。mock provider 直接报错退出（无意义）。

- [ ] **Step 1: 实现**

```js
// scripts/rebuild-memory.mjs
import path from "node:path";
import { loadProject, loadChapterIndex } from "../src/core/project-store.mjs";
import { loadContinuityState } from "../src/core/continuity-store.mjs";
import { extractChapterMemory } from "../src/core/agent-engine.mjs";
import { ModelClient } from "../src/core/model-client.mjs";
import { CostTracker } from "../src/core/cost-tracker.mjs";
import { OpenAICompatibleAdapter } from "../src/core/provider-adapters.mjs";
import { buildPricingTable } from "../src/core/model-pricing.mjs";
import { readJson, safeJoin } from "../src/core/fs-utils.mjs";

const args = process.argv.slice(2);
const projectRoot = path.resolve(args.find((a) => !a.startsWith("--")) ?? "");
const dryRun = args.includes("--dry-run");
const fromArg = args.indexOf("--from");
const fromChapter = fromArg >= 0 ? Number(args[fromArg + 1]) : 1;

if (!projectRoot) throw new Error("usage: node scripts/rebuild-memory.mjs <projectRoot> [--from N] [--dry-run]");

const project = await loadProject(projectRoot);
if ((project.active_model?.provider ?? "mock") === "mock") {
  throw new Error("项目未配置真实模型（active_model.provider=mock），补建记忆需要真实 API。");
}
const index = await loadChapterIndex(projectRoot);
const watermark = await loadContinuityState(projectRoot);
const targets = index.chapters
  .filter((c) => c.status === "completed" && c.chapter_no >= fromChapter && c.chapter_no > watermark.last_extracted_chapter)
  .sort((a, b) => a.chapter_no - b.chapter_no);

console.log(JSON.stringify({ projectRoot, chapters: targets.map((c) => c.chapter_no), estimatedCalls: targets.length, dryRun }));
if (dryRun || targets.length === 0) process.exit(0);

const existingCost = await readJson(safeJoin(projectRoot, "cost.json"), null);
const runtime = {
  modelClient: new ModelClient({
    costTracker: new CostTracker({ pricing: buildPricingTable(project), summary: existingCost }),
    adapters: { "openai-compatible": new OpenAICompatibleAdapter() }
  })
};
for (const chapter of targets) {
  console.log(`extracting chapter ${chapter.chapter_no}...`);
  await extractChapterMemory(projectRoot, project, { current_chapter_no: chapter.chapter_no }, runtime);
}
await runtime.modelClient.costTracker.writeProjectReport(projectRoot);
console.log(JSON.stringify({ ok: true, processed: targets.length }));
```

> 注意：`extractChapterMemory` 的水位幂等会让"逐章推进"天然成立；失败章也推水位并记 `lost_chapter` 事件，脚本继续后续章。

- [ ] **Step 2: package.json 加 script**

```json
"audit:rebuild-memory": "node scripts/rebuild-memory.mjs"
```

- [ ] **Step 3: dry-run 验证（用 .demo_runs 任一 mock 项目验证报错路径 + 用 s1-real-verify-mimo 验证列章）**

Run: `node scripts/rebuild-memory.mjs D:\WWriting\.demo_runs\s1-real-verify-mimo --dry-run`
Expected: JSON 输出 chapters:[1..10]（该项目水位为 0）、estimatedCalls:10、dryRun:true

- [ ] **Step 4: 提交**

```bash
git add scripts/rebuild-memory.mjs package.json
git commit -m "feat(s2a): rebuild-memory script for legacy projects"
```

---

# Phase 1 — 工具层

## Task 6: tool-registry（注册表 + 权限 + 文档生成）

**Files:**
- Create: `src/core/chat/tool-registry.mjs`
- Test: `tests/chat-tools.test.mjs`（本任务先建文件，后续任务追加用例）

**契约：** 工具定义 `{ name, kind: "read"|"write"|"control", description, params: {参数名: "说明"}, run(args, ctx) }`。`ctx` 至少含 `{ projectRoot, project }`；控制工具额外要求 `ctx.server`（Phase 3 注入）。执行入口 `executeTool(registry, name, args, ctx)` 统一做：存在性校验 → `tool_permissions` 检查 → 执行 → 包装 `{ ok, result }` 或 `{ ok: false, error, message }`（不抛异常）→ 写 `chat_tool_executed` 事件。

- [ ] **Step 1: 写失败测试**

```js
// tests/chat-tools.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createToolRegistry, executeTool, renderToolDocs, checkToolPermission } from "../src/core/chat/tool-registry.mjs";
import { createProject } from "../src/core/project-store.mjs";
import { readEvents } from "../src/core/event-log.mjs";

async function makeProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-chattools-"));
  const { projectRoot } = await createProject(root, {
    slug: "t", title: "工具测试", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  return projectRoot;
}

test("registry 注册与文档渲染", () => {
  const registry = createToolRegistry();
  registry.register({ name: "demo_read", kind: "read", description: "演示", params: { x: "数字" }, run: async () => ({ x: 1 }) });
  const docs = renderToolDocs(registry);
  assert.match(docs, /demo_read/u);
  assert.match(docs, /演示/u);
  assert.match(docs, /x: 数字/u);
});

test("executeTool 未知工具返回 ok:false 不抛", async () => {
  const registry = createToolRegistry();
  const projectRoot = await makeProject();
  const out = await executeTool(registry, "nope", {}, { projectRoot, project: { tool_permissions: {} } });
  assert.equal(out.ok, false);
  assert.equal(out.error, "unknown_tool");
});

test("read_only 项目拒绝 write/control 工具，放行 read", () => {
  const permsRO = { read_only: true, safe_edit: true };
  assert.equal(checkToolPermission({ kind: "read" }, permsRO).allowed, true);
  assert.equal(checkToolPermission({ kind: "write" }, permsRO).allowed, false);
  assert.equal(checkToolPermission({ kind: "control" }, permsRO).allowed, false);
  const noSafeEdit = { read_only: false, safe_edit: false };
  assert.equal(checkToolPermission({ kind: "write", name: "edit_chapter" }, noSafeEdit).allowed, false);
  assert.equal(checkToolPermission({ kind: "write", name: "queue_chapters" }, noSafeEdit).allowed, true);
});

test("executeTool 成功路径写 chat_tool_executed 事件", async () => {
  const registry = createToolRegistry();
  registry.register({ name: "demo_read", kind: "read", description: "演示", params: {}, run: async () => ({ ok: 1 }) });
  const projectRoot = await makeProject();
  const out = await executeTool(registry, "demo_read", {}, { projectRoot, project: { project_id: "p", tool_permissions: {} } });
  assert.equal(out.ok, true);
  const events = await readEvents(projectRoot);
  const evt = events.find((e) => e.type === "chat_tool_executed");
  assert.ok(evt);
  assert.equal(evt.data.tool, "demo_read");
  assert.equal(evt.data.ok, true);
});

test("executeTool 工具抛错被包装为 ok:false", async () => {
  const registry = createToolRegistry();
  registry.register({ name: "boom", kind: "read", description: "炸", params: {}, run: async () => { throw new Error("内部错误"); } });
  const projectRoot = await makeProject();
  const out = await executeTool(registry, "boom", {}, { projectRoot, project: { tool_permissions: {} } });
  assert.equal(out.ok, false);
  assert.equal(out.error, "tool_failed");
  assert.match(out.message, /内部错误/u);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/chat-tools.test.mjs`
Expected: FAIL（Cannot find module）

- [ ] **Step 3: 实现**

```js
// src/core/chat/tool-registry.mjs
// 对话 agent 的工具注册表：注册、权限检查、统一执行包装、文档生成。
import { appendEvent } from "../event-log.mjs";

// edit 类写工具受 safe_edit 控制；其余写工具只受 read_only 控制。
const SAFE_EDIT_TOOLS = new Set(["edit_chapter", "update_continuity", "update_outline"]);

export function createToolRegistry() {
  const tools = new Map();
  return {
    register(tool) {
      if (!tool?.name || !tool?.kind || typeof tool.run !== "function") {
        throw new Error("tool must have name, kind, run()");
      }
      tools.set(tool.name, tool);
    },
    get: (name) => tools.get(name) ?? null,
    list: () => [...tools.values()]
  };
}

export function checkToolPermission(tool, toolPermissions = {}) {
  if (tool.kind === "read") return { allowed: true };
  if (toolPermissions.read_only === true) {
    return { allowed: false, message: "项目处于只读模式（tool_permissions.read_only），不能执行修改或控制操作。" };
  }
  if (tool.kind === "write" && toolPermissions.safe_edit === false && SAFE_EDIT_TOOLS.has(tool.name)) {
    return { allowed: false, message: "项目关闭了安全编辑（tool_permissions.safe_edit=false），不能直接修改正文或设定。" };
  }
  return { allowed: true };
}

export async function executeTool(registry, name, args, ctx) {
  const tool = registry.get(name);
  let outcome;
  if (!tool) {
    outcome = { ok: false, error: "unknown_tool", message: `没有名为 ${name} 的工具。可用工具见系统提示。` };
  } else {
    const permission = checkToolPermission(tool, ctx.project?.tool_permissions ?? {});
    if (!permission.allowed) {
      outcome = { ok: false, error: "permission_denied", message: permission.message };
    } else {
      try {
        const result = await tool.run(args ?? {}, ctx);
        outcome = { ok: true, result };
      } catch (error) {
        outcome = { ok: false, error: error.code ?? "tool_failed", message: error.message };
      }
    }
  }
  await appendEvent(ctx.projectRoot, {
    type: "chat_tool_executed",
    project_id: ctx.project?.project_id ?? null,
    stage: "chat",
    message: `chat tool ${name}: ${outcome.ok ? "ok" : outcome.error}`,
    data: { tool: name, args_summary: summarizeArgs(args), ok: outcome.ok, error: outcome.ok ? null : outcome.error }
  }).catch(() => {});
  return outcome;
}

export function renderToolDocs(registry) {
  return registry.list().map((tool) => {
    const params = Object.entries(tool.params ?? {}).map(([k, v]) => `    ${k}: ${v}`).join("\n");
    return [`- ${tool.name} (${tool.kind}): ${tool.description}`, params].filter(Boolean).join("\n");
  }).join("\n");
}

function summarizeArgs(args) {
  const json = JSON.stringify(args ?? {});
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/chat-tools.test.mjs`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add src/core/chat/tool-registry.mjs tests/chat-tools.test.mjs
git commit -m "feat(s3): chat tool registry with permissions, wrapped execution, docs rendering"
```

## Task 7: 读工具 6 个

**Files:**
- Create: `src/core/chat/tools-read.mjs`
- Test: `tests/chat-tools.test.mjs`（追加）

**契约：** 导出 `registerReadTools(registry)`。所有读工具不取项目锁。返回值就是注入模型上下文的 result（注意紧凑：大文本截断由 chat-agent 层统一做，工具层只对 read_chapter 尊重 max_chars 默认 8000）。

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 tests/chat-tools.test.mjs
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { upsertChapter } from "../src/core/project-store.mjs";

async function makeProjectWithChapter() {
  const projectRoot = await makeProject();
  const chapterPath = path.join(projectRoot, "chapters", "001.md");
  await fs.mkdir(path.dirname(chapterPath), { recursive: true });
  await fs.writeFile(chapterPath, "# Chapter 001\n\n# 第一章\n\n刘康从六楼坠落。沈泽在食堂。", "utf8");
  await upsertChapter(projectRoot, { chapter_no: 1, status: "completed", final_path: chapterPath, actual_words: 20 });
  return projectRoot;
}

test("get_status 返回项目概览", async () => {
  const registry = createToolRegistry();
  registerReadTools(registry);
  const projectRoot = await makeProjectWithChapter();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "get_status", {}, { projectRoot, project });
  assert.equal(out.ok, true);
  assert.equal(out.result.target_chapters, 3);
  assert.equal(out.result.completed_chapters, 1);
});

test("read_chapter 读正文并尊重 max_chars", async () => {
  const registry = createToolRegistry();
  registerReadTools(registry);
  const projectRoot = await makeProjectWithChapter();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "read_chapter", { chapter_no: 1, max_chars: 10 }, { projectRoot, project });
  assert.equal(out.ok, true);
  assert.ok(out.result.content.length <= 11); // 10 + 截断符
  const missing = await executeTool(registry, "read_chapter", { chapter_no: 99 }, { projectRoot, project });
  assert.equal(missing.ok, false);
});

test("search_text 命中返回章节与摘录", async () => {
  const registry = createToolRegistry();
  registerReadTools(registry);
  const projectRoot = await makeProjectWithChapter();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "search_text", { query: "六楼" }, { projectRoot, project });
  assert.equal(out.ok, true);
  assert.equal(out.result.matches.length, 1);
  assert.equal(out.result.matches[0].chapter_no, 1);
  assert.match(out.result.matches[0].excerpt, /六楼/u);
});

test("read_continuity / read_outline / get_cost 在空项目不报错", async () => {
  const registry = createToolRegistry();
  registerReadTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  for (const name of ["read_continuity", "read_outline", "get_cost"]) {
    const out = await executeTool(registry, name, {}, { projectRoot, project });
    assert.equal(out.ok, true, `${name} should be ok`);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/chat-tools.test.mjs`
Expected: 新用例 FAIL（Cannot find module tools-read）

- [ ] **Step 3: 实现**

```js
// src/core/chat/tools-read.mjs
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
    name: "read_chapter", kind: "read",
    description: "读取指定章节正文。",
    params: { chapter_no: "章节号（整数）", max_chars: "可选，返回字符上限，默认 8000" },
    run: async (args, ctx) => {
      const chapterNo = Number(args.chapter_no);
      const index = await loadChapterIndex(ctx.projectRoot);
      const entry = (index.chapters ?? []).find((c) => c.chapter_no === chapterNo);
      const filePath = entry?.final_path ?? entry?.draft_path;
      if (!entry || !filePath || !(await pathExists(filePath))) {
        const error = new Error(`第 ${args.chapter_no} 章不存在或还没有正文。`);
        error.code = "chapter_not_found";
        throw error;
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/chat-tools.test.mjs`
Expected: PASS（9 tests）

- [ ] **Step 5: 提交**

```bash
git add src/core/chat/tools-read.mjs tests/chat-tools.test.mjs
git commit -m "feat(s3): six read tools (status/chapter/search/continuity/outline/cost)"
```

## Task 8: 写工具 6 个

**Files:**
- Create: `src/core/chat/tools-write.mjs`
- Test: `tests/chat-tools.test.mjs`（追加）

**契约：** 导出 `registerWriteTools(registry)`。写工具的 `run` 是**真正执行体**——确认流程在 chat-agent 层（Phase 2）：loop 看到 `kind!=="read"` 即落 pending_action，批准后才调 `executeTool`。`edit_chapter` 额外导出 `previewEditChapter(projectRoot, args)` 供确认卡渲染 before/after。

**edit_chapter 行为规格（最关键的工具）：**
1. `find` 在目标章正文中出现次数必须恰为 1：0 次 → `find_not_found`；≥2 次 → `find_not_unique`（错误信息含出现次数，提示模型给更长的 find）。
2. 执行前 `writeCheckpoint(projectRoot, { kind: "chat_edit", chapter_no, ... })`。
3. 替换后重算 `countEffectiveWords` 并 `upsertChapter` 更新 `actual_words` 与 `checksum`（sha256 同 chapter_index 现有格式 `sha256:<hex>`）。
4. 写 `chapter_edited_via_chat` 事件。

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 tests/chat-tools.test.mjs
import { registerWriteTools, previewEditChapter } from "../src/core/chat/tools-write.mjs";
import { loadChapterIndex } from "../src/core/project-store.mjs";

test("edit_chapter 唯一命中才执行，并更新 index 与 checkpoint", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProjectWithChapter();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  // 不唯一/不存在
  const dup = await executeTool(registry, "edit_chapter", { chapter_no: 1, find: "。", replace: "！" }, { projectRoot, project });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, "find_not_unique");
  const missing = await executeTool(registry, "edit_chapter", { chapter_no: 1, find: "不存在的句子", replace: "x" }, { projectRoot, project });
  assert.equal(missing.error, "find_not_found");
  // 成功
  const out = await executeTool(registry, "edit_chapter", { chapter_no: 1, find: "六楼", replace: "十二楼", reason: "统一楼层" }, { projectRoot, project });
  assert.equal(out.ok, true);
  const content = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.match(content, /十二楼/u);
  assert.doesNotMatch(content, /从六楼坠落/u);
  const index = await loadChapterIndex(projectRoot);
  const entry = index.chapters.find((c) => c.chapter_no === 1);
  assert.match(entry.checksum, /^sha256:/u);
  const checkpoints = await fs.readdir(path.join(projectRoot, "checkpoints"));
  assert.ok(checkpoints.length >= 1);
});

test("previewEditChapter 生成 before/after 摘录", async () => {
  const projectRoot = await makeProjectWithChapter();
  const preview = await previewEditChapter(projectRoot, { chapter_no: 1, find: "六楼", replace: "十二楼" });
  assert.equal(preview.ok, true);
  assert.match(preview.before, /六楼/u);
  assert.match(preview.after, /十二楼/u);
});

test("queue_chapters 复用 expandInstruction 入队", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "queue_chapters", { instruction: "写2章" }, { projectRoot, project });
  assert.equal(out.ok, true);
  assert.equal(out.result.queued, 2);
});

test("update_continuity 修改设定档案", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "update_continuity", { entity: "刘康", attribute: "坠楼楼层", value: "六楼", note: "用户裁决" }, { projectRoot, project });
  assert.equal(out.ok, true);
  const continuity = await (await import("../src/core/continuity-store.mjs")).loadContinuity(projectRoot);
  assert.equal(continuity.facts[0].value, "六楼");
});

test("update_settings 走 settings-runtime 校验（裸密钥被拒）", async () => {
  const registry = createToolRegistry();
  registerWriteTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const bad = await executeTool(registry, "update_settings", { patch: { api_key: "sk-real-key" } }, { projectRoot, project });
  assert.equal(bad.ok, false);
  const good = await executeTool(registry, "update_settings", { patch: { target_chapters: 12 } }, { projectRoot, project });
  assert.equal(good.ok, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/chat-tools.test.mjs`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

```js
// src/core/chat/tools-write.mjs
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { loadChapterIndex, upsertChapter, writeCheckpoint } from "../project-store.mjs";
import { loadContinuity, mergeExtraction, saveContinuity } from "../continuity-store.mjs";
import { updateProjectSettings } from "../settings-runtime.mjs";
import { expandInstruction } from "../task-queue.mjs";
import { countEffectiveWords } from "../word-count.mjs";
import { appendEvent } from "../event-log.mjs";
import { pathExists, safeJoin, writeFileAtomic } from "../fs-utils.mjs";

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

function locateFind(content, find) {
  if (!find) { const e = new Error("find 不能为空"); e.code = "bad_args"; throw e; }
  const first = content.indexOf(find);
  if (first < 0) { const e = new Error(`正文中找不到要替换的文字（find）。`); e.code = "find_not_found"; throw e; }
  const second = content.indexOf(find, first + 1);
  if (second >= 0) {
    const count = content.split(find).length - 1;
    const e = new Error(`要替换的文字出现了 ${count} 次，必须唯一。请提供更长、更具体的 find。`);
    e.code = "find_not_unique";
    throw e;
  }
  return first;
}

export async function previewEditChapter(projectRoot, args) {
  const { filePath } = await resolveChapterFile(projectRoot, args.chapter_no);
  const content = await fs.readFile(filePath, "utf8");
  const at = locateFind(content, String(args.find ?? ""));
  const find = String(args.find);
  const ctx = 60;
  const before = content.slice(Math.max(0, at - ctx), at + find.length + ctx);
  const after = before.replace(find, String(args.replace ?? ""));
  return { ok: true, chapter_no: Number(args.chapter_no), before, after };
}

export function registerWriteTools(registry) {
  registry.register({
    name: "edit_chapter", kind: "write",
    description: "对某章正文做一次精确替换。find 必须在该章唯一命中。",
    params: { chapter_no: "章节号", find: "要替换的原文（需唯一）", replace: "替换后的文字", reason: "修改原因（给读者看的说明）" },
    run: async (args, ctx) => {
      const { entry, filePath } = await resolveChapterFile(ctx.projectRoot, args.chapter_no);
      const content = await fs.readFile(filePath, "utf8");
      locateFind(content, String(args.find ?? ""));
      await writeCheckpoint(ctx.projectRoot, {
        kind: "chat_edit", chapter_no: entry.chapter_no,
        file: filePath, reason: args.reason ?? null, find: String(args.find).slice(0, 200)
      });
      const next = content.replace(String(args.find), String(args.replace ?? ""));
      await writeFileAtomic(filePath, next);
      const checksum = `sha256:${crypto.createHash("sha256").update(next).digest("hex")}`;
      const words = countEffectiveWords(next);
      await upsertChapter(ctx.projectRoot, { chapter_no: entry.chapter_no, actual_words: words, checksum });
      await appendEvent(ctx.projectRoot, {
        type: "chapter_edited_via_chat", project_id: ctx.project?.project_id ?? null,
        chapter_no: entry.chapter_no, stage: "chat",
        message: `第 ${entry.chapter_no} 章已按对话指令修改`,
        data: { reason: args.reason ?? null, words }
      });
      return { chapter_no: entry.chapter_no, replaced: 1, words };
    }
  });

  registry.register({
    name: "rewrite_chapter", kind: "write",
    description: "把某章整体重写的要求排成写作任务（由写作流水线执行）。",
    params: { chapter_no: "章节号", instructions: "重写要求" },
    run: async (args, ctx) => {
      const queue = await ctx.getTaskQueue(ctx.projectRoot);
      const task = await queue.enqueue(`重写第${Number(args.chapter_no)}章：${String(args.instructions ?? "").trim()}`, { mode: "write" });
      return { queued: 1, task_id: task.id ?? null };
    }
  });

  registry.register({
    name: "update_continuity", kind: "write",
    description: "修改设定档案中的一条事实（用户裁决冲突或修正记忆时用）。",
    params: { entity: "实体名", attribute: "属性", value: "新值", note: "备注" },
    run: async (args, ctx) => {
      const continuity = await loadContinuity(ctx.projectRoot);
      const merged = mergeExtraction(continuity, {
        facts: [{ entity: String(args.entity), attribute: String(args.attribute), value: String(args.value), chapter_no: null, quote: String(args.note ?? "chat 修订") }],
        timeline: [], characters: []
      });
      await saveContinuity(ctx.projectRoot, merged);
      return { entity: args.entity, attribute: args.attribute, value: args.value };
    }
  });

  registry.register({
    name: "update_outline", kind: "write",
    description: "更新写作目标说明（task_plan.md 追加一节计划修订）。",
    params: { chapter_no: "针对的章节号（可空）", plan: "新的计划内容" },
    run: async (args, ctx) => {
      const planPath = safeJoin(ctx.projectRoot, "task_plan.md");
      const existing = (await pathExists(planPath)) ? await fs.readFile(planPath, "utf8") : "# 任务计划\n";
      const heading = args.chapter_no ? `## 第 ${Number(args.chapter_no)} 章计划修订（chat）` : "## 计划修订（chat）";
      const next = `${existing.trimEnd()}\n\n${heading}\n\n${String(args.plan ?? "").trim()}\n`;
      await writeFileAtomic(planPath, next);
      return { updated: true };
    }
  });

  registry.register({
    name: "queue_chapters", kind: "write",
    description: "把写作指令排进任务队列（支持「写N章」「写到第N章」或自由指令）。",
    params: { instruction: "写作指令" },
    run: async (args, ctx) => {
      const state = await (await import("../project-store.mjs")).loadState(ctx.projectRoot);
      const instructions = expandInstruction(String(args.instruction ?? ""), { currentChapter: state.current_chapter_no ?? 1 });
      const queue = await ctx.getTaskQueue(ctx.projectRoot);
      for (const instruction of instructions) await queue.enqueue(instruction, { mode: "write" });
      return { queued: instructions.length, tasks: instructions };
    }
  });

  registry.register({
    name: "update_settings", kind: "write",
    description: "更新项目设置（走全套校验；不能写入裸 API key）。",
    params: { patch: "设置补丁对象，如 {target_chapters: 12}" },
    run: async (args, ctx) => {
      const result = await updateProjectSettings(ctx.projectRoot, args.patch ?? {});
      return { updated: true, keys: Object.keys(args.patch ?? {}), result: result?.ok ?? true };
    }
  });
}
```

> **实施注意**：`rewrite_chapter`/`queue_chapters` 用到 `ctx.getTaskQueue`——Phase 2 的 chat-agent 与 Phase 3 的 server 端点会把 `getTaskQueue` 放进 ctx；本任务测试里 `makeProject` 的 ctx 没有它，所以上面两个工具的测试在 Phase 2 ctx 完善后补（本任务测试只覆盖 edit/preview/update_continuity/update_settings + queue_chapters 需临时注入：测试里 `ctx.getTaskQueue = async (root) => createTaskQueue(root)`，从 `task-queue.mjs` 导入 `createTaskQueue`——实施时核对该工厂函数实际名称，`task-queue.mjs` 若导出的是类则 `new TaskQueue(root)` 后 `load()`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/chat-tools.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/chat/tools-write.mjs tests/chat-tools.test.mjs
git commit -m "feat(s3): six write tools with unique-find edit, checkpoint, validated settings"
```

## Task 9: 控制工具 3 个（server 注入型）

**Files:**
- Create: `src/core/chat/tools-control.mjs`
- Test: `tests/chat-tools.test.mjs`（追加）

**契约：** 导出 `registerControlTools(registry)`。控制工具依赖 `ctx.server = { runJobs, getTaskQueue, startProjectRun, projectLocks, testModel?, testRunProject? }`（Phase 3 由 app-server 注入；测试用 fake）。`ctx.server` 缺失时返回 `control_unavailable` 错误。

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 tests/chat-tools.test.mjs
import { registerControlTools } from "../src/core/chat/tools-control.mjs";

test("start_run 无 server 上下文时报 control_unavailable；有则启动", async () => {
  const registry = createToolRegistry();
  registerControlTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const noServer = await executeTool(registry, "start_run", {}, { projectRoot, project });
  assert.equal(noServer.ok, false);
  assert.equal(noServer.error, "control_unavailable");
  const calls = [];
  const server = {
    runJobs: new Map(),
    startProjectRun: async (...args) => { calls.push("start"); return { started: true }; },
    getTaskQueue: async () => ({ promoteNext: async () => ({ id: "t1", instruction: "写第1章" }) })
  };
  const out = await executeTool(registry, "start_run", {}, { projectRoot, project, server });
  assert.equal(out.ok, true);
  assert.deepEqual(calls, ["start"]);
});

test("pause_run 没有运行中任务时人话报错", async () => {
  const registry = createToolRegistry();
  registerControlTools(registry);
  const projectRoot = await makeProject();
  const project = await (await import("../src/core/project-store.mjs")).loadProject(projectRoot);
  const out = await executeTool(registry, "pause_run", {}, { projectRoot, project, server: { runJobs: new Map() } });
  assert.equal(out.ok, false);
  assert.match(out.message, /没有正在运行/u);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/chat-tools.test.mjs` → 新用例 FAIL

- [ ] **Step 3: 实现**

```js
// src/core/chat/tools-control.mjs
import path from "node:path";
import { loadProject } from "../project-store.mjs";
import { applyFailureResolution } from "../failure-actions.mjs";

function requireServer(ctx) {
  if (!ctx.server) {
    const e = new Error("当前会话无法控制写作任务（缺少服务端上下文）。");
    e.code = "control_unavailable";
    throw e;
  }
  return ctx.server;
}

function isJobRunning(job) {
  return Boolean(job && job.done !== true && job.controller && !job.controller.signal?.aborted);
}

export function registerControlTools(registry) {
  registry.register({
    name: "start_run", kind: "control",
    description: "开始或继续写作（取下一个队列任务交给流水线）。",
    params: {},
    run: async (_args, ctx) => {
      const server = requireServer(ctx);
      const key = path.resolve(ctx.projectRoot);
      if (isJobRunning(server.runJobs.get(key))) return { started: false, already_running: true };
      const queue = await server.getTaskQueue(ctx.projectRoot);
      const task = await queue.promoteNext();
      if (!task) { const e = new Error("任务队列为空，先用 queue_chapters 排任务。"); e.code = "queue_empty"; throw e; }
      const project = await loadProject(ctx.projectRoot);
      const status = await server.startProjectRun(ctx.projectRoot, project, server, task, { source: "chat_agent" });
      return { started: status.started !== false, task: task.instruction ?? null };
    }
  });

  registry.register({
    name: "pause_run", kind: "control",
    description: "暂停当前写作任务（在安全点停下，可随时继续）。",
    params: {},
    run: async (_args, ctx) => {
      const server = requireServer(ctx);
      const job = server.runJobs.get(path.resolve(ctx.projectRoot));
      if (!isJobRunning(job)) { const e = new Error("当前没有正在运行的写作任务。"); e.code = "not_running"; throw e; }
      job.controller.abort("chat_agent 请求暂停");
      return { paused: true };
    }
  });

  registry.register({
    name: "resolve_failure", kind: "control",
    description: "处理当前故障卡。command 见故障卡可用动作（如 retry-segment / fill-words / raise-cost-budget / switch-model）。",
    params: { command: "动作名", args: "动作参数对象（可空）" },
    run: async (args, ctx) => {
      requireServer(ctx);
      const result = await applyFailureResolution(ctx.projectRoot, { command: String(args.command ?? ""), args: args.args ?? {} });
      return { applied: true, result };
    }
  });
}
```

> **实施注意**：`isJobRunning` 的真实判定以 `app-server.mjs` 现有同名函数为准——实施时打开 app-server 找到它的实现，把这里的副本改成一致（或从 app-server 导出复用，避免语义漂移；优先导出复用）。`startProjectRun(projectRoot, project, context, task, meta)` 的第三参是 server context 本身。

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `node --test tests/chat-tools.test.mjs` → PASS

```bash
git add src/core/chat/tools-control.mjs tests/chat-tools.test.mjs
git commit -m "feat(s3): control tools start/pause/resolve-failure with server context injection"
```

---

# Phase 2 — Agent loop

## Task 10: agent-protocol（输出解析 + 系统提示）

**Files:**
- Create: `src/core/chat/agent-protocol.mjs`
- Test: `tests/chat-protocol.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// tests/chat-protocol.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentReply, buildSystemPrompt } from "../src/core/chat/agent-protocol.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";

test("parseAgentReply 纯文本", () => {
  const out = parseAgentReply("好的，第 9 章写到沈泽探查北围墙。");
  assert.equal(out.type, "text");
  assert.match(out.text, /北围墙/u);
});

test("parseAgentReply 围栏 JSON 工具调用（只取第一个）", () => {
  const raw = '我来查一下。\n```json\n{"tool_calls":[{"tool":"get_status","args":{}},{"tool":"get_cost","args":{}}]}\n```';
  const out = parseAgentReply(raw);
  assert.equal(out.type, "tool_call");
  assert.equal(out.call.tool, "get_status");
  assert.equal(out.dropped, 1);
  assert.match(out.leadText, /我来查一下/u);
});

test("parseAgentReply 裸 JSON 也可", () => {
  const out = parseAgentReply('{"tool_calls":[{"tool":"read_chapter","args":{"chapter_no":2}}]}');
  assert.equal(out.type, "tool_call");
  assert.equal(out.call.args.chapter_no, 2);
});

test("parseAgentReply 畸形 JSON 回落为文本", () => {
  const out = parseAgentReply('```json\n{"tool_calls": [{]}\n```');
  assert.equal(out.type, "text");
});

test("buildSystemPrompt 含工具文档与协议说明", () => {
  const registry = createToolRegistry();
  registry.register({ name: "get_status", kind: "read", description: "查状态", params: {}, run: async () => ({}) });
  const prompt = buildSystemPrompt(registry, { title: "测试书", projectStatus: "running" });
  assert.match(prompt, /get_status/u);
  assert.match(prompt, /tool_calls/u);
  assert.match(prompt, /测试书/u);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/chat-protocol.test.mjs` → FAIL

- [ ] **Step 3: 实现**

```js
// src/core/chat/agent-protocol.mjs
import { renderToolDocs } from "./tool-registry.mjs";

export function parseAgentReply(rawText) {
  const text = String(rawText ?? "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = fenced ? fenced[1].trim() : (text.startsWith("{") ? text : null);
  if (candidate) {
    try {
      const data = JSON.parse(candidate);
      if (Array.isArray(data?.tool_calls) && data.tool_calls.length > 0) {
        const [first, ...rest] = data.tool_calls;
        if (first?.tool) {
          return {
            type: "tool_call",
            call: { tool: String(first.tool), args: first.args ?? {} },
            dropped: rest.length,
            leadText: fenced ? text.slice(0, fenced.index).trim() : ""
          };
        }
      }
    } catch { /* fallthrough to text */ }
  }
  return { type: "text", text };
}

export function buildSystemPrompt(registry, snapshot = {}) {
  return [
    "你是 WWriting 的小说项目协作智能体。你和用户共同运营一个长篇写作项目。",
    "你可以直接回答，也可以调用工具查询或操作项目。",
    "",
    "## 调用工具的方式",
    "当需要工具时，输出一个 JSON 围栏块（一次只调用一个工具），格式：",
    '```json',
    '{"tool_calls":[{"tool":"工具名","args":{}}]}',
    '```',
    "工具结果会回给你，然后你继续决定下一步（再调工具或给出最终回答）。",
    "写类与控制类工具会先征求用户确认，被拒绝时请尊重用户决定。",
    "最终回答用中文，简洁、具体、基于工具返回的事实，不要编造。",
    "",
    "## 可用工具",
    renderToolDocs(registry),
    "",
    "## 当前项目快照",
    `书名：${snapshot.title ?? "未命名"}；状态：${snapshot.projectStatus ?? "unknown"}；` +
      `进度：${snapshot.completedChapters ?? "?"}/${snapshot.targetChapters ?? "?"} 章；当前第 ${snapshot.currentChapter ?? "?"} 章（${snapshot.currentStage ?? "?"}）。`
  ].join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `node --test tests/chat-protocol.test.mjs` → PASS（5 tests）

```bash
git add src/core/chat/agent-protocol.mjs tests/chat-protocol.test.mjs
git commit -m "feat(s3): agent protocol — tolerant reply parser and system prompt builder"
```

## Task 11: chat-store（历史 + pending action 持久化）

**Files:**
- Create: `src/core/chat/chat-store.mjs`
- Test: `tests/chat-store.test.mjs`

**契约（spec §8）：** `chat_history.jsonl` 每行一条消息 `{id, ts, role, content?, tool?, tool_calls?, ok?, result_summary?, usage?, cost?}`；`chat_pending_action.json` 单对象或不存在。追加用 `fs.appendFile`（含换行），读取容忍坏行（跳过）。

- [ ] **Step 1: 写失败测试**

```js
// tests/chat-store.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendChatMessage, readChatHistory, loadPendingAction, savePendingAction, clearPendingAction
} from "../src/core/chat/chat-store.mjs";

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), "wwriting-chatstore-")); }

test("append + read 往返，自动补 id/ts", async () => {
  const root = await tmp();
  await appendChatMessage(root, { role: "user", content: "你好" });
  await appendChatMessage(root, { role: "assistant", content: "你好，项目进度 8/10。", cost: 0.001 });
  const history = await readChatHistory(root);
  assert.equal(history.length, 2);
  assert.equal(history[0].role, "user");
  assert.ok(history[0].id);
  assert.ok(history[0].ts);
});

test("readChatHistory 支持 after 与 limit", async () => {
  const root = await tmp();
  for (let i = 0; i < 5; i += 1) await appendChatMessage(root, { role: "user", content: `m${i}` });
  const all = await readChatHistory(root);
  const after = await readChatHistory(root, { after: all[2].id });
  assert.equal(after.length, 2);
  const limited = await readChatHistory(root, { limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited[1].content, "m4"); // limit 取最近
});

test("坏行跳过不抛", async () => {
  const root = await tmp();
  await appendChatMessage(root, { role: "user", content: "好行" });
  await fs.appendFile(path.join(root, "chat_history.jsonl"), "不是json\n", "utf8");
  await appendChatMessage(root, { role: "user", content: "好行2" });
  const history = await readChatHistory(root);
  assert.equal(history.length, 2);
});

test("pending action 存取清", async () => {
  const root = await tmp();
  assert.equal(await loadPendingAction(root), null);
  const action = await savePendingAction(root, { tool: "edit_chapter", args: { chapter_no: 2 }, preview: { before: "a", after: "b" } });
  assert.ok(action.id);
  assert.equal(action.status, "pending");
  const loaded = await loadPendingAction(root);
  assert.equal(loaded.tool, "edit_chapter");
  await clearPendingAction(root);
  assert.equal(await loadPendingAction(root), null);
});
```

- [ ] **Step 2: 跑测试确认失败** → `node --test tests/chat-store.test.mjs` FAIL

- [ ] **Step 3: 实现**

```js
// src/core/chat/chat-store.mjs
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { pathExists, safeJoin, writeJsonAtomic, readJson } from "../fs-utils.mjs";

const HISTORY_FILE = "chat_history.jsonl";
const PENDING_FILE = "chat_pending_action.json";

export async function appendChatMessage(projectRoot, message) {
  const entry = {
    id: message.id ?? crypto.randomUUID(),
    ts: message.ts ?? new Date().toISOString(),
    ...message
  };
  await fs.appendFile(safeJoin(projectRoot, HISTORY_FILE), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export async function readChatHistory(projectRoot, { after = null, limit = 200 } = {}) {
  const file = safeJoin(projectRoot, HISTORY_FILE);
  if (!(await pathExists(file))) return [];
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  let result = messages;
  if (after) {
    const idx = result.findIndex((m) => m.id === after);
    result = idx >= 0 ? result.slice(idx + 1) : result;
  }
  if (limit > 0 && result.length > limit) result = result.slice(-limit);
  return result;
}

export async function loadPendingAction(projectRoot) {
  const data = await readJson(safeJoin(projectRoot, PENDING_FILE), null);
  return data && data.status === "pending" ? data : null;
}

export async function savePendingAction(projectRoot, action) {
  const entry = {
    id: action.id ?? crypto.randomUUID(),
    created_at: new Date().toISOString(),
    status: "pending",
    ...action
  };
  await writeJsonAtomic(safeJoin(projectRoot, PENDING_FILE), entry);
  return entry;
}

export async function clearPendingAction(projectRoot) {
  await writeJsonAtomic(safeJoin(projectRoot, PENDING_FILE), { status: "cleared" });
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `node --test tests/chat-store.test.mjs` → PASS（4 tests）

```bash
git add src/core/chat/chat-store.mjs tests/chat-store.test.mjs
git commit -m "feat(s3): chat store — jsonl history with tolerant reads, persistent pending action"
```

## Task 12: chat-context（上下文组装）

**Files:**
- Create: `src/core/chat/chat-context.mjs`
- Test: `tests/chat-agent.test.mjs`（本任务建文件）

**契约：** `buildChatContext({ projectRoot, project, registry, userMessage })` → `{ messages, snapshot }`。messages[0] 是系统提示（含工具文档+快照+记忆），随后是历史窗口（最近 20 条），最后是本轮 user 消息。记忆注入：`book_summary.md` 全文（≤2000 字有界）+ `continuity.md` 全文（实体上限已有界）。历史超窗口时，older 部分折叠为一条 `role:"system"` 的"早前对话提要"（v1 简化：取每条的前 80 字拼接，不调模型——零成本，够用；模型摘要列候补）。

- [ ] **Step 1: 写失败测试**

```js
// tests/chat-agent.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildChatContext } from "../src/core/chat/chat-context.mjs";
import { appendChatMessage } from "../src/core/chat/chat-store.mjs";
import { createToolRegistry } from "../src/core/chat/tool-registry.mjs";
import { registerReadTools } from "../src/core/chat/tools-read.mjs";
import { createProject, loadProject } from "../src/core/project-store.mjs";

async function makeProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-chatctx-"));
  const { projectRoot } = await createProject(root, {
    slug: "c", title: "上下文测试", story_seed: "种子",
    target_chapters: 3, min_words_per_chapter: 10, target_words_per_chapter: 12
  });
  return projectRoot;
}

test("buildChatContext 注入系统提示/记忆/历史/本轮消息", async () => {
  const projectRoot = await makeProject();
  await fs.writeFile(path.join(projectRoot, "memory", "book_summary.md"), "# 全书摘要\n\n主角觉醒。", "utf8");
  await appendChatMessage(projectRoot, { role: "user", content: "之前的问题" });
  await appendChatMessage(projectRoot, { role: "assistant", content: "之前的回答" });
  const registry = createToolRegistry();
  registerReadTools(registry);
  const project = await loadProject(projectRoot);
  const { messages, snapshot } = await buildChatContext({ projectRoot, project, registry, userMessage: "现在写到哪了？" });
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /主角觉醒/u);
  assert.match(messages[0].content, /get_status/u);
  assert.equal(messages.at(-1).role, "user");
  assert.equal(messages.at(-1).content, "现在写到哪了？");
  assert.equal(messages.length, 4); // system + 2 history + user
  assert.equal(snapshot.title, "上下文测试");
});

test("历史超 20 条折叠为提要", async () => {
  const projectRoot = await makeProject();
  for (let i = 0; i < 30; i += 1) await appendChatMessage(projectRoot, { role: "user", content: `历史消息${i}` });
  const registry = createToolRegistry();
  const project = await loadProject(projectRoot);
  const { messages } = await buildChatContext({ projectRoot, project, registry, userMessage: "新消息" });
  const digest = messages.find((m) => m.role === "system" && m.content.includes("早前对话提要"));
  assert.ok(digest);
  assert.match(digest.content, /历史消息0/u);
  const fullHistory = messages.filter((m) => m.content?.startsWith?.("历史消息") && !m.content.includes("提要"));
  assert.equal(fullHistory.length, 20);
});
```

- [ ] **Step 2: 跑测试确认失败** → `node --test tests/chat-agent.test.mjs` FAIL

- [ ] **Step 3: 实现**

```js
// src/core/chat/chat-context.mjs
import fs from "node:fs/promises";
import { loadChapterIndex, loadState } from "../project-store.mjs";
import { pathExists, safeJoin } from "../fs-utils.mjs";
import { readChatHistory } from "./chat-store.mjs";
import { buildSystemPrompt } from "./agent-protocol.mjs";

const HISTORY_WINDOW = 20;

export async function buildChatContext({ projectRoot, project, registry, userMessage }) {
  const [state, index, bookSummary, continuityMd, history] = await Promise.all([
    loadState(projectRoot).catch(() => ({})),
    loadChapterIndex(projectRoot).catch(() => ({ chapters: [] })),
    readOptional(safeJoin(projectRoot, "memory", "book_summary.md")),
    readOptional(safeJoin(projectRoot, "memory", "continuity.md")),
    readChatHistory(projectRoot, { limit: 200 })
  ]);
  const chapters = index.chapters ?? [];
  const snapshot = {
    title: project.title,
    projectStatus: state.project_status ?? "idle",
    completedChapters: chapters.filter((c) => c.status === "completed").length,
    targetChapters: project.target_chapters,
    currentChapter: state.current_chapter_no ?? null,
    currentStage: state.current_stage ?? null
  };
  const memorySection = [
    bookSummary ? `## 全书摘要\n${bookSummary}` : "",
    continuityMd ? `## 设定档案\n${continuityMd}` : ""
  ].filter(Boolean).join("\n\n");
  const systemContent = [buildSystemPrompt(registry, snapshot), memorySection].filter(Boolean).join("\n\n");

  const messages = [{ role: "system", content: systemContent }];
  const recent = history.slice(-HISTORY_WINDOW);
  const older = history.slice(0, Math.max(0, history.length - HISTORY_WINDOW));
  if (older.length > 0) {
    const digest = older.map((m) => `${m.role}: ${String(m.content ?? m.result_summary ?? "").slice(0, 80)}`).join("\n");
    messages.push({ role: "system", content: `## 早前对话提要\n${digest}` });
  }
  for (const m of recent) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: String(m.content ?? "") });
    } else if (m.role === "tool") {
      messages.push({ role: "user", content: `[工具 ${m.tool} 结果] ${String(m.result_summary ?? "")}` });
    }
  }
  messages.push({ role: "user", content: String(userMessage ?? "") });
  return { messages, snapshot };
}

async function readOptional(filePath) {
  return (await pathExists(filePath)) ? (await fs.readFile(filePath, "utf8")).trim() : "";
}
```

> tool 角色映射为 user 消息（OpenAI 兼容端点对自定义 role 兼容性差，统一文本协议）。

- [ ] **Step 4: 跑测试确认通过 + 提交**

```bash
git add src/core/chat/chat-context.mjs tests/chat-agent.test.mjs
git commit -m "feat(s3): chat context assembly with memory injection and history window"
```

## Task 13: chat-agent loop 核心

**Files:**
- Create: `src/core/chat/chat-agent.mjs`
- Test: `tests/chat-agent.test.mjs`（追加）

**契约：**

```
runChatTurn({ projectRoot, project, registry, modelClient, userMessage, server?, getTaskQueue?, onEvent? })
  → { reply, toolEvents, pendingAction, usage: { calls, cost } }
resumeChatTurn({ ..., approve: boolean })   // pending_action 的恢复入口
```

行为规格：
1. 入口先 `appendChatMessage(role:"user")`；若已有 pending_action → 拒绝新消息（返回提示"先处理待确认操作"），**除非** userMessage 为空（resume 场景）。
2. loop：`buildChatContext` → `modelClient.generate({ project, stage: "chat", messages, metadata: { chat: true, round } })` → `parseAgentReply`。
3. `type:"text"` → append assistant 消息（含 usage/cost 累计）→ 返回。
4. `type:"tool_call"`：
   - 读类 → `executeTool` → append tool 消息（result_summary = JSON 截 500 字）→ `onEvent({type:"tool_result",...})` → 回到 2（round+1）。
   - 写/控制类 → 若工具是 `edit_chapter` 先 `previewEditChapter` 生成 preview；`savePendingAction({tool, args, preview, lead_text})` → append assistant 消息（content=leadText+"待确认操作…"）→ 返回（pendingAction 非空）。
5. `resumeChatTurn(approve)`：读 pending_action → `approve=false`：clear + append tool 消息（ok:false, error:"user_rejected"）→ 回到 loop（让模型决定下一步）；`approve=true`：`executeTool`（ctx 含 server/getTaskQueue）→ clear → append tool 消息 → 回到 loop。
6. `maxToolRounds=8`：超限强制 append assistant"操作轮数达到上限，请把任务拆小"并返回。
7. usage 累计：每次 generate 的 `costSummary` 增量累计进返回值（cost 字段=本轮新增 estimatedCost 差值；v1 简化：累计 usageReport 的 token 与（modelConfig 有价时）estimateCost——直接复用 generate 返回的 costSummary.estimatedCost 前后差）。

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 tests/chat-agent.test.mjs
import { runChatTurn, resumeChatTurn } from "../src/core/chat/chat-agent.mjs";
import { registerWriteTools } from "../src/core/chat/tools-write.mjs";
import { loadPendingAction, readChatHistory as readHistory } from "../src/core/chat/chat-store.mjs";
import { upsertChapter } from "../src/core/project-store.mjs";

function scriptedClient(script) {
  let i = 0;
  return { generate: async () => ({ text: script[Math.min(i++, script.length - 1)], usageReport: {}, costSummary: { estimatedCost: 0 } }) };
}

async function makeChatProject() {
  const projectRoot = await makeProject();
  const chapterPath = path.join(projectRoot, "chapters", "001.md");
  await fs.mkdir(path.dirname(chapterPath), { recursive: true });
  await fs.writeFile(chapterPath, "# Chapter 001\n\n刘康从六楼坠落。", "utf8");
  await upsertChapter(projectRoot, { chapter_no: 1, status: "completed", final_path: chapterPath, actual_words: 8 });
  return projectRoot;
}

test("纯文本回复直接落历史", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["进度是 1/3 章。"]),
    userMessage: "进度如何？"
  });
  assert.equal(out.reply, "进度是 1/3 章。");
  assert.equal(out.pendingAction, null);
  const history = await readHistory(projectRoot);
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant"]);
});

test("读工具自动执行并回填后续轮", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"get_status","args":{}}]}\n```',
      "已完成 1 章，共 3 章。"
    ]),
    userMessage: "进度如何？"
  });
  assert.equal(out.reply, "已完成 1 章，共 3 章。");
  assert.equal(out.toolEvents.length, 1);
  assert.equal(out.toolEvents[0].tool, "get_status");
  assert.equal(out.toolEvents[0].ok, true);
});

test("写工具落 pending_action 并暂停，approve 后执行并继续", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  const first = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient([
      '```json\n{"tool_calls":[{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"十二楼","reason":"统一"}}]}\n```'
    ]),
    userMessage: "把第1章六楼改成十二楼"
  });
  assert.ok(first.pendingAction);
  assert.equal(first.pendingAction.tool, "edit_chapter");
  assert.match(first.pendingAction.preview.after, /十二楼/u);
  assert.ok(await loadPendingAction(projectRoot));
  const resumed = await resumeChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["已把第 1 章的六楼改为十二楼。"]),
    approve: true
  });
  assert.equal(resumed.reply, "已把第 1 章的六楼改为十二楼。");
  assert.equal(await loadPendingAction(projectRoot), null);
  const content = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.match(content, /十二楼/u);
});

test("拒绝路径：reject 回填 user_rejected", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(['```json\n{"tool_calls":[{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"九楼","reason":"x"}}]}\n```']),
    userMessage: "改楼层"
  });
  const resumed = await resumeChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["好的，保持六楼不变。"]),
    approve: false
  });
  assert.equal(resumed.reply, "好的，保持六楼不变。");
  const content = await fs.readFile(path.join(projectRoot, "chapters", "001.md"), "utf8");
  assert.match(content, /六楼/u);
});

test("maxToolRounds 护栏", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  const loopForever = '```json\n{"tool_calls":[{"tool":"get_status","args":{}}]}\n```';
  const out = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(Array(20).fill(loopForever)),
    userMessage: "随便"
  });
  assert.match(out.reply, /上限/u);
  assert.equal(out.toolEvents.length, 8);
});

test("已有 pending_action 时新消息被挡", async () => {
  const projectRoot = await makeChatProject();
  const project = await loadProject(projectRoot);
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(['```json\n{"tool_calls":[{"tool":"edit_chapter","args":{"chapter_no":1,"find":"六楼","replace":"五楼","reason":"x"}}]}\n```']),
    userMessage: "改"
  });
  const blocked = await runChatTurn({
    projectRoot, project, registry,
    modelClient: scriptedClient(["should not be called"]),
    userMessage: "再改点别的"
  });
  assert.match(blocked.reply, /待确认/u);
  assert.ok(blocked.pendingAction);
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL（runChatTurn not found）

- [ ] **Step 3: 实现**

```js
// src/core/chat/chat-agent.mjs
import { buildChatContext } from "./chat-context.mjs";
import { parseAgentReply } from "./agent-protocol.mjs";
import { executeTool } from "./tool-registry.mjs";
import { previewEditChapter } from "./tools-write.mjs";
import { appendChatMessage, loadPendingAction, savePendingAction, clearPendingAction } from "./chat-store.mjs";

export const MAX_TOOL_ROUNDS = 8;
const RESULT_SUMMARY_CHARS = 500;

export async function runChatTurn(options) {
  const { projectRoot, userMessage } = options;
  const existing = await loadPendingAction(projectRoot);
  if (existing) {
    return {
      reply: "还有一个待确认操作没处理（见确认卡）。请先确认或取消，再发新消息。",
      toolEvents: [], pendingAction: existing, usage: { calls: 0, cost: 0 }
    };
  }
  await appendChatMessage(projectRoot, { role: "user", content: String(userMessage ?? "") });
  return await agentLoop(options, []);
}

export async function resumeChatTurn(options) {
  const { projectRoot, project, registry, approve, server, getTaskQueue } = options;
  const pending = await loadPendingAction(projectRoot);
  if (!pending) {
    return { reply: "没有待确认的操作。", toolEvents: [], pendingAction: null, usage: { calls: 0, cost: 0 } };
  }
  let outcome;
  if (approve === true) {
    outcome = await executeTool(registry, pending.tool, pending.args, { projectRoot, project, server, getTaskQueue });
  } else {
    outcome = { ok: false, error: "user_rejected", message: "用户拒绝了此操作。" };
  }
  await clearPendingAction(projectRoot);
  const toolEvent = { tool: pending.tool, ok: outcome.ok, error: outcome.ok ? null : outcome.error };
  await appendChatMessage(projectRoot, {
    role: "tool", tool: pending.tool, ok: outcome.ok,
    result_summary: summarize(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
  });
  options.onEvent?.({ type: "tool_result", ...toolEvent });
  return await agentLoop({ ...options, userMessage: null }, [toolEvent]);
}

async function agentLoop(options, toolEvents) {
  const { projectRoot, project, registry, modelClient, server, getTaskQueue, onEvent } = options;
  let totalCost = 0;
  let calls = 0;
  for (let round = 0; round < MAX_TOOL_ROUNDS + 1; round += 1) {
    const { messages } = await buildChatContext({ projectRoot, project, registry, userMessage: latestPrompt(options, round) });
    const result = await modelClient.generate({
      project, stage: "chat", messages, metadata: { chat: true, round }
    });
    calls += 1;
    totalCost += Number(result.costSummary?.estimatedCost ?? 0) || 0;
    const parsed = parseAgentReply(result.text);
    if (parsed.type === "text") {
      await appendChatMessage(projectRoot, { role: "assistant", content: parsed.text, cost: totalCost || undefined });
      return { reply: parsed.text, toolEvents, pendingAction: null, usage: { calls, cost: totalCost } };
    }
    // tool_call
    if (toolEvents.length >= MAX_TOOL_ROUNDS) break;
    const tool = registry.get(parsed.call.tool);
    const isRead = tool?.kind === "read";
    if (tool && !isRead) {
      let preview = null;
      if (parsed.call.tool === "edit_chapter") {
        try { preview = await previewEditChapter(projectRoot, parsed.call.args); }
        catch (error) {
          // preview 失败（find 不唯一等）按工具失败回填，让模型修正参数
          const outcome = { ok: false, error: error.code ?? "preview_failed", message: error.message };
          toolEvents.push({ tool: parsed.call.tool, ok: false, error: outcome.error });
          await appendChatMessage(projectRoot, { role: "tool", tool: parsed.call.tool, ok: false, result_summary: outcome.message });
          onEvent?.({ type: "tool_result", tool: parsed.call.tool, ok: false });
          continue;
        }
      }
      const pending = await savePendingAction(projectRoot, {
        tool: parsed.call.tool, args: parsed.call.args, preview, lead_text: parsed.leadText ?? ""
      });
      const note = [parsed.leadText, `（待确认操作：${parsed.call.tool}，请在确认卡上批准或取消）`].filter(Boolean).join("\n");
      await appendChatMessage(projectRoot, { role: "assistant", content: note, cost: totalCost || undefined });
      onEvent?.({ type: "pending_action", action: pending });
      return { reply: note, toolEvents, pendingAction: pending, usage: { calls, cost: totalCost } };
    }
    const outcome = await executeTool(registry, parsed.call.tool, parsed.call.args, { projectRoot, project, server, getTaskQueue });
    const event = { tool: parsed.call.tool, ok: outcome.ok, error: outcome.ok ? null : outcome.error };
    toolEvents.push(event);
    await appendChatMessage(projectRoot, {
      role: "tool", tool: parsed.call.tool, ok: outcome.ok,
      result_summary: summarize(outcome.ok ? outcome.result : { error: outcome.error, message: outcome.message })
    });
    onEvent?.({ type: "tool_result", ...event });
  }
  const capped = "操作轮数达到上限，我先停在这里。请把任务拆小一点，或直接告诉我下一步。";
  await appendChatMessage(projectRoot, { role: "assistant", content: capped });
  return { reply: capped, toolEvents, pendingAction: null, usage: { calls, cost: totalCost } };
}

function latestPrompt(options, round) {
  // 首轮使用原始消息；后续轮 buildChatContext 的历史里已含工具结果，给空提示让模型继续。
  if (round === 0 && options.userMessage) return options.userMessage;
  return "（继续：基于上面的工具结果决定下一步——继续调用工具或给出最终回答。）";
}

function summarize(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return json.length > RESULT_SUMMARY_CHARS ? `${json.slice(0, RESULT_SUMMARY_CHARS)}…` : json;
}
```

> **已知简化（记录进代码注释）**：续轮的"（继续…）"提示会作为 user 消息存在于上下文末尾但不落 chat_history（buildChatContext 的 userMessage 参数不持久化）；首轮 user 消息已在 runChatTurn 落盘。**实施时注意**：round>0 时 buildChatContext 的历史里已有刚 append 的 tool 消息，因此 messages 末尾会是 `[…tool结果, user(继续提示)]`，语义正确。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/chat-agent.test.mjs`
Expected: PASS（8 tests：2 context + 6 loop）

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm test` → 全绿

```bash
git add src/core/chat/chat-agent.mjs tests/chat-agent.test.mjs
git commit -m "feat(s3): chat agent loop with read auto-exec, write confirmation, round cap"
```

---

# Phase 3 — 服务端与门禁对话化

## Task 14: /api/chat/send + /api/chat/confirm + /api/chat/history 端点

**Files:**
- Modify: `src/core/app-server.mjs`（路由区 134-172 行附近加 3 条；handler 加在 serveSideQuestion 附近；server context 注入）
- Test: `tests/app-shell/`（参考既有 app-server 测试文件组织；若无独立 app-server 测试，新建 `tests/app-shell/chat-endpoints.test.mjs`，用 node:http 起真实 server 实例——参考 `verify-app-shell.mjs` 的启动方式）

**行为规格：**
1. 路由（在 140 行 `/api/commands/submit` 之前插入）：

```js
    if (url.pathname === "/api/chat/send" && request.method === "POST") {
      await serveChatSend(request, response, { workspace, selected, runJobs, getTaskQueue, testModel, testRunProject, projectLocks, startProjectRunFn: startProjectRun });
      return;
    }
    if (url.pathname === "/api/chat/confirm" && request.method === "POST") {
      await serveChatConfirm(request, response, { workspace, selected, runJobs, getTaskQueue, testModel, testRunProject, projectLocks, startProjectRunFn: startProjectRun });
      return;
    }
    if (url.pathname === "/api/chat/history" && request.method === "GET") {
      await serveChatHistory(url, response, { workspace, selected });
      return;
    }
```

2. **v1 传输决策：POST 返回完整 JSON（非 SSE）**。SSE 流式文本列为 Phase 4 增强（spec §10 流式仅作用于文本渲染；JSON 一次返回 + 前端逐字渲染动画可达 90% 体验，规避 Electron/代理的 SSE 缓冲坑）。响应体：

```json
{ "ok": true, "reply": "…", "toolEvents": [{"tool":"get_status","ok":true}], "pendingAction": null|{...}, "usage": {"calls":2,"cost":0.004} }
```

3. handler 实现（模式与 serveCommandSubmit 一致）：

```js
async function serveChatSend(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const message = String(body.message ?? "").trim();
    if (!message) throw new Error("请输入消息。");
    if (message.length > 4000) throw new Error("消息过长。");
    const projectRoot = await resolveActiveProjectRoot(context);
    const project = await loadProject(projectRoot);
    const registry = buildChatRegistry();
    const modelClient = buildChatModelClient(project, projectRoot);
    const result = await runChatTurn({
      projectRoot, project, registry, modelClient,
      userMessage: message,
      server: chatServerContext(context),
      getTaskQueue: context.getTaskQueue
    });
    await serveJson(response, { ok: true, ...result });
  } catch (error) {
    sendError(response, new HttpError(400, "BAD_REQUEST", error.message));
  }
}

async function serveChatConfirm(request, response, context) {
  try {
    const body = await readJsonBody(request);
    const projectRoot = await resolveActiveProjectRoot(context);
    const project = await loadProject(projectRoot);
    const registry = buildChatRegistry();
    const modelClient = buildChatModelClient(project, projectRoot);
    const result = await resumeChatTurn({
      projectRoot, project, registry, modelClient,
      approve: body.approve === true,
      server: chatServerContext(context),
      getTaskQueue: context.getTaskQueue
    });
    await serveJson(response, { ok: true, ...result });
  } catch (error) {
    sendError(response, new HttpError(400, "BAD_REQUEST", error.message));
  }
}

async function serveChatHistory(url, response, context) {
  try {
    const projectRoot = await resolveActiveProjectRoot(context);
    const after = url.searchParams.get("after") ?? null;
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const messages = await readChatHistory(projectRoot, { after, limit });
    const pendingAction = await loadPendingAction(projectRoot);
    await serveJson(response, { ok: true, messages, pendingAction });
  } catch (error) {
    sendError(response, new HttpError(400, "BAD_REQUEST", error.message));
  }
}

function chatServerContext(context) {
  return {
    runJobs: context.runJobs,
    getTaskQueue: context.getTaskQueue,
    startProjectRun: (projectRoot, project, _server, task, meta) =>
      context.startProjectRunFn(projectRoot, project, context, task, meta)
  };
}

function buildChatRegistry() {
  const registry = createToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  registerControlTools(registry);
  return registry;
}

function buildChatModelClient(project, projectRoot) {
  // 与引擎一致的适配器集合 + 项目级 costTracker（byStage=chat 归因进 cost.json）。
  // 注意：读取既有 cost.json 作为 summary 起点，loop 结束由调用方落盘——
  // v1 简化：chat 调用结束后 writeProjectReport（在 serveChatSend/Confirm 的 result 返回前）。
  // 实施时把 writeProjectReport 调用加进两个 handler：await client.costTracker.writeProjectReport(projectRoot);
  /* 完整实现见 Step 3 */
}
```

`buildChatModelClient` 完整实现：

```js
function buildChatModelClient(project, projectRoot) {
  return readJson(safeJoin(projectRoot, "cost.json"), null).then((existingCost) => new ModelClient({
    costTracker: new CostTracker({ pricing: buildPricingTable(project), summary: existingCost }),
    adapters: {
      "openai-compatible": new OpenAICompatibleAdapter(),
      mock: new MockProviderAdapter({ response: () => ({ text: "（mock 模型不支持对话，请在设置里配置真实模型。）" }) })
    }
  }));
}
```

（注意它是 async——两个 handler 里 `const modelClient = await buildChatModelClient(project, projectRoot);`，且 turn 结束后 `await modelClient.costTracker.writeProjectReport(projectRoot);`。imports 需补：`runChatTurn/resumeChatTurn`、`createToolRegistry/registerReadTools/registerWriteTools/registerControlTools`、`readChatHistory/loadPendingAction`、`buildPricingTable`、`CostTracker`、`MockProviderAdapter` 若未引入。）

- [ ] **Step 1: 写失败测试**（`tests/app-shell/chat-endpoints.test.mjs`：起 server（复用既有 app-shell 测试的启动 helper——打开 `tests/app-shell/` 现有测试文件抄启动方式），POST /api/chat/send（mock 项目 → 模型返回 mock 提示文本）断言 200 + reply 非空 + chat_history.jsonl 落盘；GET /api/chat/history 断言 messages.length>=2）

- [ ] **Step 2: 跑测试确认失败** → `node --test tests/app-shell/chat-endpoints.test.mjs` FAIL

- [ ] **Step 3: 按上述代码实现**（路由 + 3 handler + 2 builder + imports）

- [ ] **Step 4: 跑测试 + 全量** → 目标测试 PASS；`npm test` 全绿；`npm run verify:app-shell` ok:true

- [ ] **Step 5: 提交**

```bash
git add src/core/app-server.mjs tests/app-shell/chat-endpoints.test.mjs
git commit -m "feat(s3): chat send/confirm/history endpoints with project cost attribution"
```

## Task 15: 本地门禁 title-gate + word-cap-gate 内建于 reviewChapter

**Files:**
- Create: `src/core/quality-gates.mjs`
- Modify: `src/core/agent-engine.mjs`（reviewChapter：359 行 `runWordCountGate` 之后插入两个本地门禁）
- Test: `tests/quality-gates.test.mjs`

**行为规格：**
- `runTitleGate(content, chapterNo)`：扫描行首 `#{1,3}\s*第([一二三四五六七八九十百零0-9]+)章`，解析章号（中文数字转换覆盖一～九百九十九），≠ chapterNo → `{ gate:"chapter-title-gate", status:"failed", found_title, expected_chapter, line }`；无错 → passed。**硬门禁**：失败走既有 `needs_revision` 路径（与 word-count gate 失败同处理：插入 `last_quality_gate_results`）。
- `runWordCapGate(content, { targetWords, maxWords, outputPricePerMillion })`：`maxWords = project.max_words_per_chapter ?? target*1.5`；超标 → `{ gate:"word-cap-gate", status:"warning", actual_words, max_words, overflow_words, overflow_cost_estimate }`（**软门禁**：只记 `quality_gate_results` + `quality_gate_warning` 事件，不拦截）。`outputPricePerMillion` 从 `project.active_model?.pricing?.output_per_million` 取，无价则 `overflow_cost_estimate: null`（按中文 1 字≈1.5 token 估算：`overflow_words * 1.5 / 1e6 * price`，注释写明是粗估）。
- reviewChapter 集成点（359 行后）：

```js
  const titleGate = runTitleGate(draft, state.current_chapter_no);
  if (titleGate.status === "failed") {
    /* 与 word-count gate 失败完全相同的处理块，gate 数组换成 [gate, titleGate] */
  }
  const wordCapGate = runWordCapGate(draft, {
    targetWords: project.target_words_per_chapter,
    maxWords: project.max_words_per_chapter,
    outputPricePerMillion: project.active_model?.pricing?.output_per_million ?? null
  });
  if (wordCapGate.status === "warning") {
    await appendEvent(projectRoot, {
      type: "quality_gate_warning", project_id: project.project_id,
      chapter_no: state.current_chapter_no, stage: "reviewing", severity: "warn",
      message: `第 ${state.current_chapter_no} 章超出字数上限（${wordCapGate.actual_words}/${wordCapGate.max_words}）`,
      data: wordCapGate
    });
  }
  /* 后续 upsertChapter 的 quality_gate_results 数组追加 titleGate 与 wordCapGate（非 failed 也记录，供 UI 展示） */
```

- [ ] **Step 1: 写失败测试**（用例：`runTitleGate` 对 001 语料样本「## 第二章（第1章续）」在 chapterNo=1 时 failed、found_title 含"第二章"；正确标题 passed；中文数字"第十二章"解析为 12。`runWordCapGate` 超标 warning + overflow 计算正确（3300 目标、默认 1.5 倍=4950、实际 5147 → overflow 197）；有价时 cost 估算>0；不超标 passed）

测试数据直接固化审计语料：

```js
const TITLE_BAD_SAMPLE = "# 第一章\n\n正文…\n\n## 第二章（第1章续）\n\n续写正文…"; // 来自真实项目 001 章
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 quality-gates.mjs**（`runTitleGate`/`runWordCapGate` + 中文数字解析 `parseChineseChapterNo`，全部纯函数）+ reviewChapter 集成

- [ ] **Step 4: 跑测试 + `npm run verify:mvp`**（mock 章节标题规范，应全过）

- [ ] **Step 5: 提交**

```bash
git add src/core/quality-gates.mjs src/core/agent-engine.mjs tests/quality-gates.test.mjs
git commit -m "feat(s3): built-in title gate (hard) and word-cap gate (soft) in reviewChapter"
```

## Task 16: fact-check 门禁 + agent 主动提案消息

**Files:**
- Modify: `src/core/quality-gates.mjs`（增 `buildFactCheckMessages`/`parseFactCheck` 纯函数）
- Modify: `src/core/agent-engine.mjs`（reviewChapter 本地门禁后增 fact-check 调用）
- Test: `tests/quality-gates.test.mjs`（追加）
- Create: `tests/fixtures/s2-corpus/`（语料：`a1-floor-conflict.json`、`a2-time-conflict.json`、`good-flashback.json` 等，每个含 `{draft, continuity_facts, expect: "conflict"|"pass"}`）

**行为规格：**
1. 开关：`project.fact_check?.enabled !== false`（默认开）且 provider 非 mock 且 `continuity.facts.length > 0`，三者任一不满足 → 跳过（事件 `fact_check_skipped`，mock 长跑零成本不变）。
2. `buildFactCheckMessages({ chapterNo, draft, facts, timeline })`：system 要求只输出 JSON `{"conflicts":[{"draft_quote","conflicts_with","prior_chapter","severity":"high"|"low","suggestion"}]}`；明确豁免规则——"回忆/闪回/角色撒谎不算矛盾，只报客观叙述层的设定冲突"。
3. `parseFactCheck(text)` 宽容解析（同 parseMemoryExtraction 风格）：失败 → `{ok:false}`。
4. 引擎集成（reviewChapter 内、skill checks 之后、成功路径 upsertChapter 之前）：调用 `runtime.modelClient.generate({ stage: "fact_check", ... })`，解析失败重试 1 次，仍失败 → 事件 `fact_check_skipped`（reason: parse_failed）不阻塞。
5. 有 conflicts 且 `project.fact_check?.hard === true` → 走 needs_revision（conflicts 注入 `last_quality_gate_results`，修订 prompt 已会带 quality_gate_failures——既有链路）。
6. 有 conflicts 且软模式（默认）→ ①事件 `quality_gate_warning`（data 含 conflicts）；② `quality_gate_results` 记 warning；③ **agent 主动消息**：`appendChatMessage(projectRoot, { role: "assistant", content: 人话矛盾说明 + 修复建议, proactive: "fact_check", chapter_no })`——若首条 conflict 的 `draft_quote` 在本章唯一命中，则同时 `savePendingAction({ tool: "edit_chapter", args: { chapter_no, find: draft_quote, replace: suggestion 中的目标值, reason: "fact-check 矛盾修复" }, preview })`（仅当当前无 pending；有则只发消息不占确认位）。
7. 人话模板：`第 ${chapterNo} 章可能与既有设定矛盾：「${draft_quote}」 ↔ ${conflicts_with}（第 ${prior_chapter} 章）。建议：${suggestion}`。

- [ ] **Step 1: 固化语料 + 写失败测试**（语料 JSON 用本计划"现状速查"前的审计事实：A1 楼层（draft 含"从十二楼坠落"，facts 含 六楼@ch1）、A2 时间（draft"前天晚上十一点"，timeline ch1 午间）、good-flashback（draft"他想起第一次见刘康时…"，不应报矛盾——测试只断言 buildFactCheckMessages 含豁免规则文本 + parseFactCheck 对模型输出的解析，**不在单测里调真实模型**；拦截率验证在 Task 21 verify:chat-online）

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**（纯函数 + 引擎集成 + agent 主动消息）

- [ ] **Step 4: 跑全量 + `npm run verify:mvp`**（mock 跳过路径不影响）

- [ ] **Step 5: 提交**

```bash
git add src/core/quality-gates.mjs src/core/agent-engine.mjs tests/quality-gates.test.mjs tests/fixtures/s2-corpus
git commit -m "feat(s3): fact-check gate with proactive chat proposal and one-click fix prefill"
```

---

# Phase 4 — UI（app-shell）

## Task 17: api-client 增 chat 函数 + thread-renderer 渲染对话

**Files:**
- Modify: `src/app-shell/api-client.js`（增 `sendChatMessage(message)`、`confirmChatAction(approve)`、`fetchChatHistory(after)` —— 按既有 `postJson/getJson` 封装风格）
- Modify: `src/app-shell/thread-renderer.js`（676 行；增 4 种消息渲染：user 气泡、assistant 气泡（markdown 轻渲染：段落+粗体+代码块即可，复用现有渲染工具函数）、tool 执行卡（折叠：`工具名 ✓/✗`，点击展开 result_summary）、确认卡（before/after 双栏 + 「执行」「取消」按钮，data-testid="chat-confirm-approve"/"chat-confirm-reject"））
- Modify: `src/app-shell/styles.css`（气泡/卡片样式，跟随现有设计 token）
- Test: `tests/app-shell/` 若有 DOM 测试设施则加渲染单测；否则以 Task 19 探针为验收

**行为规格：** thread 数据源 = `fetchChatHistory()` 的 messages ∪ 现有事件流，按 ts 排序混排；`pendingAction` 非空时在 thread 末尾渲染确认卡；确认卡按钮调 `confirmChatAction(true|false)` 后刷新 thread。assistant 消息有 `cost` 字段时尾部渲染 `<span class="chat-cost">本轮 ¥0.0042</span>`（cost 为空/0 不渲染——沿用 costAvailable 守则）。`proactive:"fact_check"` 消息加警示徽标。

- [ ] **Step 1: 实现 api-client 三函数**
- [ ] **Step 2: 实现 thread-renderer 四种渲染 + styles**
- [ ] **Step 3: 手动冒烟**：`npm run app:shell` 起静态服务，浏览器发消息（mock 项目会得到 mock 提示文本），确认气泡/历史/刷新不报错
- [ ] **Step 4: 提交**

```bash
git add src/app-shell/api-client.js src/app-shell/thread-renderer.js src/app-shell/styles.css
git commit -m "feat(s3): chat thread rendering — bubbles, tool cards, confirm card, cost footnote"
```

## Task 18: composer 默认对话输入

**Files:**
- Modify: `src/app-shell/composer.js`（270 行）
- Modify: `src/app-shell/commands/index.mjs` / `command-registry.mjs`（如需注册新默认行为）

**行为规格：** 无前缀输入 → `sendChatMessage`（原默认是 write 指令）。`/write` `/ask` `/review` 前缀行为不变（兼容）。发送后输入框立即清空 + thread 出现用户气泡 + "思考中"占位，响应到达替换为 assistant 气泡。错误（400/网络）→ thread 内错误行 + 输入框恢复内容。

- [ ] **Step 1: 实现**
- [ ] **Step 2: 手动冒烟**（同 Task 17 Step 3 流程，确认默认输入走 chat、/write 仍走旧链路）
- [ ] **Step 3: 提交**

```bash
git add src/app-shell/composer.js src/app-shell/commands src/app-shell/command-registry.mjs
git commit -m "feat(s3): composer defaults to chat agent, slash commands preserved"
```

## Task 19: clickability 探针扩展

**Files:**
- Modify: `scripts/verify-app-clickability.cjs`

**行为规格（CLAUDE.md 硬防线）：** 新增探针序列：①composer 输入"你好"回车 → 等待 thread 出现 user 气泡与 assistant 回复（mock 文本）；②构造 pending_action（直接写 `chat_pending_action.json` 测试夹具到探针项目）→ 刷新 → 断言确认卡可见且 `chat-confirm-approve`/`chat-confirm-reject` 均可收到 trusted click；③工具卡展开点击。沿用现有探针的写法与超时参数（打开该文件抄现有 probe 结构）。

- [ ] **Step 1: 实现探针**
- [ ] **Step 2: 跑 `npm run verify:app-clickability`** → ok:true（含新探针）
- [ ] **Step 3: 跑 `npm run verify:app-shell`、`npm run verify:desktop-shell`** → ok:true
- [ ] **Step 4: 提交**

```bash
git add scripts/verify-app-clickability.cjs
git commit -m "test(s3): clickability probes for chat composer, confirm card, tool card"
```

---

# Phase 5 — 验收

## Task 20: 协议鲁棒与并发安全测试补全

**Files:**
- Test: `tests/chat-agent.test.mjs`（追加）

**用例清单（每条独立 test）：**
1. 模型输出畸形 JSON（`{"tool_calls": [{]}`）→ 按纯文本回复处理，不崩（已部分覆盖，补 loop 层断言：reply 即原文）。
2. 模型调用未知工具 → tool 消息 `unknown_tool` 回填 → 下轮模型可见错误（scriptedClient 第二轮返回文本，断言 toolEvents[0].error === "unknown_tool"）。
3. `read_only: true` 项目（写 project.tool_permissions 后 saveProject）→ edit_chapter 不落 pending、直接以 permission_denied 回填（**实施注意**：当前 loop 先落 pending 再确认时才 executeTool——必须在落 pending 之前先 `checkToolPermission`，拒绝时直接回填。调整 agentLoop：写/控制分支开头加权限预检。本用例就是锁这个行为的）。
4. 流水线运行中编辑当前生成章：`edit_chapter` 增加运行中检查——`ctx.server?.runJobs` 有运行 job 且 `args.chapter_no === state.current_chapter_no` → 拒绝（error: `chapter_busy`，message 人话）。测试用 fake server.runJobs + state。**实施**：在 tools-write.mjs 的 edit_chapter run 开头加检查（读 loadState 比对）。
5. pending_action 跨进程持久：savePendingAction 后新建一套 registry/loop 对象执行 resumeChatTurn（approve=true）→ 执行成功（已实质覆盖，补显式用例）。

- [ ] **Step 1: 写测试（先红）** → **Step 2: 按注记修 agentLoop 权限预检 + edit_chapter busy 检查（变绿）** → **Step 3: `npm test` 全绿** → **Step 4: 提交**

```bash
git add tests/chat-agent.test.mjs src/core/chat/chat-agent.mjs src/core/chat/tools-write.mjs
git commit -m "feat(s3): permission precheck before pending, busy-chapter edit guard, robustness cases"
```

## Task 21: verify:chat-online 真实 API 验收脚本 + 语料拦截率

**Files:**
- Create: `scripts/verify-chat-online.mjs`
- Modify: `package.json`（`"verify:chat-online": "node scripts/verify-chat-online.mjs"`）

**行为规格：** 环境变量同 `verify-provider-online.mjs`（WWRITING_PROVIDER_BASE_URL/MODEL/API_KEY_ENV）。流程：
1. 临时目录建项目（target 3 章、min 50 字——便宜），active_model 写真实 provider + 价格三字段（从 env `WWRITING_PRICING_INPUT/OUTPUT/CACHE_HIT` 读，缺省 3/6/0.025）。
2. 预置第 1 章正文（固化语料：含"刘康从六楼坠落"）+ continuity.json（六楼@ch1 事实）+ chapter_index。
3. **场景 A 理解**：`runChatTurn("这本书现在写到第几章？刘康是从几楼坠落的？")` → 断言 reply 含"六楼"且 toolEvents 含 read 工具（证明答案来自工具非编造）。
4. **场景 B 编辑**：`runChatTurn("把第1章的六楼改成十二楼")` → 断言 pendingAction.tool==="edit_chapter" → `resumeChatTurn(approve:true)` → 断言文件已改 + checkpoint 存在。
5. **场景 C fact-check 拦截率**：对 `tests/fixtures/s2-corpus/` 每条语料调 `buildFactCheckMessages` + 真实模型 + `parseFactCheck` → 统计：A1/A2 必须 conflicts 非空（2/2 拦截），good 样本 conflicts 为空（0 误杀）。
6. 输出 JSON 报告（含逐场景结果 + 总成本）到 stdout，并写 `docs/superpowers/reports/2026-06-XX-s3-chat-online-verification.json`。

- [ ] **Step 1: 实现脚本** → **Step 2: 配置真实 key 跑通**（需要用户提供 key 时申请）：`npm run verify:chat-online` → 全场景 pass → **Step 3: 提交**

```bash
git add scripts/verify-chat-online.mjs package.json docs/superpowers/reports/
git commit -m "test(s3): real-API chat verification — comprehension, edit flow, fact-check corpus rates"
```

## Task 22: 全量防线 + 交付报告

- [ ] **Step 1: 全量验证**

```powershell
npm test                          # 全绿
npm run verify:mvp                # ok:true
npm run verify:longrun            # ok:true, stableChanged=false
npm run verify:app-shell          # ok:true
npm run verify:app-clickability   # ok:true（含 chat 探针）
npm run verify:local              # ok:true（全量 12+ 项）
```

- [ ] **Step 2: 写交付报告** `docs/superpowers/reports/2026-06-XX-s2a-s3-delivery-report.md`：任务清单与 commit 对照表、spec 验收 10 条逐条核对（含真实 API 证据）、语料拦截率/误杀率、对话每轮实测成本、已知问题与后续建议（含：SSE 流式候补、对话摘要模型化候补、多 pending 候补）。

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/reports/
git commit -m "docs(s3): s2a+s3 delivery report with real-API evidence"
```

---

## 计划自审记录（writing-plans Self-Review）

1. **Spec 覆盖核对**：S2a spec 组件 1（memory-extractor）→ Task 1-3；continuity 契约 → Task 2；prompt 集成 → Task 4；rebuild 脚本 → Task 5。S3 spec §3 loop → Task 13；§4 协议 → Task 10；§5 工具 15 个 → Task 7(6)+8(6)+9(3)；§5 权限 → Task 6+20；§6 并发 → Task 20 用例 4；§7 时间线/门禁对话化 → Task 15-17；§8 契约 → Task 11；§9 端点 → Task 14；§10 UI → Task 17-19；§11 成本 → Task 14（writeProjectReport）+17（脚注）；§12 验收 10 条 → Task 20-22；S2 spec 的 title/word-cap/fact-check 判定 → Task 15-16；语料 → Task 16+21。**缺口：spec §9 SSE 流式被降级为 v1 JSON 整段返回**——已在 Task 14 行为规格 2 写明决策理由并列入交付报告候补项，属有记录的范围裁剪而非遗漏。
2. **占位符扫描**：Task 14 Step 1、Task 15-21 的部分 Step 用行为规格+用例清单替代整段代码——它们的代码契约（函数名/参数/返回/错误码/集成点行号）均已写死，留给实施者的是机械展开，符合"不再做架构决策"标准；关键复杂体（loop、store、协议、工具、引擎集成）均有完整代码。
3. **类型一致性核对**：`executeTool(registry, name, args, ctx)` 签名在 Task 6/8/9/13/20 一致；`ctx={projectRoot, project, server?, getTaskQueue?}` 一致；`runChatTurn/resumeChatTurn` 返回形状在 Task 13/14 一致；`pending_action` 字段在 Task 11/13/17/19 一致；`stage` 标签 `memory_extract`/`fact_check`/`chat` 与 spec 一致。
4. **已知实施期核对点**（计划内已标注）：app-dashboard 循环依赖（Task 3）、task-queue 工厂函数名（Task 8）、isJobRunning 复用（Task 9）、app-shell 测试启动 helper（Task 14）、现有探针结构（Task 19）。

