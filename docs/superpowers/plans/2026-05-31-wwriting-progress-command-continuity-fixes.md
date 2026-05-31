# WWriting Progress Command Continuity Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the user's running-writing experience by showing chapter-specific write progress, hiding the empty slash-command surface until it is needed, and making future chapter generation continue from prior chapters with less formulaic AI prose.

**Architecture:** Keep the existing Electron app shell and core writing state machine. UI changes stay in `src/app-shell`; writing-continuity changes add a small core memory module and enrich the existing prompt compiler path without changing HTTP APIs or rewriting existing chapters.

**Tech Stack:** Node.js ESM, Electron app shell, plain HTML/CSS/JS, `node:test`, existing WWriting core modules.

---

## Scope And Defaults

- Current directory `D:\WWriting` is not a git repository. Checkpoint steps below verify files and test output instead of running `git commit`.
- Existing generated chapters are not automatically rewritten. The continuity improvements affect newly generated chapters after the code change.
- No new external dependencies are introduced.
- No HTTP route or project settings schema change is required.

## File Structure

- Modify: `scripts/verify-app-shell.mjs`
  - Adds static app-shell assertions for the slash menu hidden rule and chapter-specific writing progress copy.
- Modify: `src/app-shell/app.js`
  - Changes the folded progress timeline from static `起草` to dynamic `写入第 X 章中`.
  - Marks the active writing meta as a special `writing` state so CSS can animate `Writing...`.
- Modify: `src/app-shell/styles.css`
  - Restores standard hidden behavior for the slash menu.
  - Adds active command item styling and `Writing...` dot animation.
- Modify: `tests/agent-engine.test.mjs`
  - Adds regression tests proving later chapter prompts receive prior chapter memory and anti-reboot/anti-AI-tone instructions.
- Create: `src/core/chapter-memory.mjs`
  - Owns read/write/format logic for durable chapter continuity memory.
- Modify: `src/core/project-store.mjs`
  - Initializes `memory/chapter_memory.json` for new projects.
- Modify: `src/core/agent-engine.mjs`
  - Records chapter memory after finalization.
  - Injects recent chapter memory and anti-reboot style constraints into drafting prompts.

---

### Task 1: App-Shell Regression Assertions

**Files:**
- Modify: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: Add failing assertions for the UI fixes**

In `scripts/verify-app-shell.mjs`, find the existing marker:

```js
  // PLACEHOLDER_CSS_ASSERT
```

Replace it with this block:

```js
  // Progress + command-menu fixes.
  assert.ok(css.includes("[hidden] { display: none !important; }"));
  assert.ok(css.includes(".slash-item.active"));
  assert.ok(css.includes("@keyframes writingDots"));
  assert.ok(css.includes(".step-meta.writing"));
  assert.ok(js.includes("function writingStepLabel"));
  assert.ok(js.includes("写入第"));
  assert.ok(js.includes("metaKind"));
```

- [ ] **Step 2: Run the app-shell verification and confirm it fails**

Run:

```powershell
npm run verify:app-shell
```

Expected: FAIL. At least one assertion should fail because the current CSS does not contain `[hidden] { display: none !important; }`, `.slash-item.active`, or `@keyframes writingDots`, and the current JS does not contain `function writingStepLabel`.

- [ ] **Step 3: Checkpoint**

Record in the implementation notes:

```text
Task 1 checkpoint: app-shell regression assertions added; verify:app-shell fails for the expected missing UI fix strings.
```

---

### Task 2: Dynamic Writing Progress And Slash Menu Display

**Files:**
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/styles.css`
- Test: `scripts/verify-app-shell.mjs`

- [ ] **Step 1: Update the folded progress groups**

In `src/app-shell/app.js`, replace the current `STEP_GROUPS` constant with:

```js
const STEP_GROUPS = [
  { id: "planning", name: "规划", detail: "拆解本章 · 悬念点", stages: ["queued", "planning", "planned"] },
  { id: "drafting", name: "写入章节", detail: "生成新章节文件", stages: ["drafting"] },
  { id: "reviewing", name: "审稿", detail: "质量门禁 · 结尾钩子", stages: ["reviewing", "needs_revision", "revising"] },
  { id: "finalizing", name: "定稿", detail: "checksum · 索引", stages: ["finalizing", "summarizing"] }
];
```

- [ ] **Step 2: Add the dynamic label helper**

In `src/app-shell/app.js`, place this helper immediately after `STEP_GROUPS`:

```js
function writingStepLabel(data, group, isActive) {
  if (group.id !== "drafting" || !isActive) {
    return group.name;
  }
  const chapterNo = Number(data.summary?.currentChapterNo ?? 0);
  if (!Number.isInteger(chapterNo) || chapterNo < 1) {
    return "写入章节中";
  }
  return `写入第 ${chapterNo} 章中`;
}
```

- [ ] **Step 3: Return `metaKind` from `computeSteps`**

In `src/app-shell/app.js`, replace the body of `computeSteps(data)` with:

```js
function computeSteps(data) {
  const summary = data.summary;
  const activeStage = summary.currentStage === "blocked" ? data.state?.blocked_at_stage : summary.currentStage;
  const activeIndex = STAGE_ORDER.indexOf(activeStage);
  const completed = summary.projectStatus === "completed";
  const blocked = summary.projectStatus === "blocked";
  return STEP_GROUPS.map((group, i) => {
    const groupMax = Math.max(...group.stages.map((s) => STAGE_ORDER.indexOf(s)));
    const isActive = group.stages.includes(activeStage);
    let status = "todo";
    let meta = "排队";
    let metaKind = null;
    if (completed || (activeIndex >= 0 && activeIndex > groupMax)) {
      status = "done";
      meta = "完成";
    } else if (isActive) {
      status = blocked ? "blocked" : "running";
      meta = blocked ? "受阻" : "进行中";
      if (!blocked && group.id === "drafting") {
        meta = "Writing";
        metaKind = "writing";
      }
    }
    return {
      name: writingStepLabel(data, group, isActive && !blocked),
      detail: group.detail,
      status,
      meta,
      metaKind,
      index: i + 1
    };
  });
}
```

- [ ] **Step 4: Mark the writing meta element**

In `renderSteps(block, data)`, replace:

```js
    meta.className = "step-meta";
    meta.textContent = step.meta;
```

with:

```js
    meta.className = `step-meta${step.metaKind ? ` ${step.metaKind}` : ""}`;
    meta.textContent = step.meta;
    if (step.metaKind === "writing") {
      meta.setAttribute("aria-label", "Writing...");
    }
```

- [ ] **Step 5: Add CSS for hidden elements, active slash items, and writing dots**

In `src/app-shell/styles.css`, after the reset block:

```css
button { font: inherit; color: inherit; cursor: pointer; background: none; border: none; }
input, textarea, select { font: inherit; color: inherit; }
ol, ul { margin: 0; padding: 0; list-style: none; }
```

add:

```css
[hidden] { display: none !important; }
```

Then replace:

```css
.slash-item:hover, .slash-item.sel { background: var(--hover); }
```

with:

```css
.slash-item:hover, .slash-item.active { background: var(--hover); }
```

After the existing `.step-meta` rule, add:

```css
.step-meta.writing {
  min-width: 66px;
  color: var(--accent);
}
.step-meta.writing::after {
  content: "...";
  display: inline-block;
  width: 18px;
  text-align: left;
  animation: writingDots 1.15s steps(4, end) infinite;
}

@keyframes writingDots {
  0% { content: ""; }
  25% { content: "."; }
  50% { content: ".."; }
  75%, 100% { content: "..."; }
}
```

Inside the existing `@media (prefers-reduced-motion: reduce)` block, add:

```css
  .step-meta.writing::after { animation: none; content: "..."; }
```

If the file has no `@media (prefers-reduced-motion: reduce)` block, append this block near the other global accessibility styles:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: .01ms !important;
  }
  .step-meta.writing::after { animation: none; content: "..."; }
}
```

- [ ] **Step 6: Run the app-shell verification**

Run:

```powershell
npm run verify:app-shell
```

Expected: PASS for the assertions added in Task 1. Existing unrelated app-shell assertions must also pass.

- [ ] **Step 7: Checkpoint**

Record in the implementation notes:

```text
Task 2 checkpoint: app shell now hides the slash menu when hidden, highlights active slash items, and shows chapter-specific Writing progress.
```

---

### Task 3: Engine Regression Tests For Continuity Prompts

**Files:**
- Modify: `tests/agent-engine.test.mjs`

- [ ] **Step 1: Add a test for recent chapter memory in later prompts**

In `tests/agent-engine.test.mjs`, after the existing test named `engine includes command-bar instructions in the next model prompt`, add:

```js
test("engine feeds previous chapter memory into later chapter prompts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-continuity-prompt-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 2,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  const modelClient = new CapturingModelClient();

  await runProject(projectRoot, { modelClient });

  const memory = JSON.parse(await fs.readFile(path.join(projectRoot, "memory", "chapter_memory.json"), "utf8"));
  assert.equal(memory.schema_version, 1);
  assert.equal(memory.chapters.length, 2);
  assert.equal(memory.chapters[0].chapter_no, 1);
  assert.ok(memory.chapters[0].ending_excerpt.includes("capture"));

  const secondChapterPrompt = modelClient.prompts.find((prompt) => prompt.includes('"chapter_no": 2'));
  assert.ok(secondChapterPrompt);
  assert.ok(secondChapterPrompt.includes("recent_completed_chapters"));
  assert.ok(secondChapterPrompt.includes("上一章落点"));
  assert.ok(secondChapterPrompt.includes("不要把本章写成新的第一章"));
  assert.ok(secondChapterPrompt.includes("普通大学生突然获得神力"));
  assert.ok(secondChapterPrompt.includes("不是梦"));
  assert.ok(secondChapterPrompt.includes("神性"));
});
```

- [ ] **Step 2: Add a test that first-chapter prompts do not require previous memory**

In the same file, add this test immediately after the previous one:

```js
test("engine allows chapter one to establish the premise once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-first-chapter-prompt-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 1,
    min_words_per_chapter: 200,
    target_words_per_chapter: 260
  });
  const modelClient = new CapturingModelClient();

  await runProject(projectRoot, { modelClient });

  const firstPrompt = modelClient.prompts.find((prompt) => prompt.includes('"chapter_no": 1'));
  assert.ok(firstPrompt);
  assert.ok(firstPrompt.includes("第 1 章可以建立初始处境一次"));
  assert.ok(firstPrompt.includes("segment_continuity_required"));
});
```

- [ ] **Step 3: Run the focused engine tests and confirm they fail**

Run:

```powershell
npm test -- tests/agent-engine.test.mjs
```

Expected: FAIL. The new tests should fail because `memory/chapter_memory.json`, `recent_completed_chapters`, and the anti-reboot Chinese instructions do not exist yet.

- [ ] **Step 4: Checkpoint**

Record in the implementation notes:

```text
Task 3 checkpoint: continuity prompt tests added; focused engine test run fails for the expected missing memory/prompt behavior.
```

---

### Task 4: Chapter Continuity Memory Module

**Files:**
- Create: `src/core/chapter-memory.mjs`
- Modify: `src/core/project-store.mjs`
- Test: `tests/agent-engine.test.mjs`

- [ ] **Step 1: Create the memory module**

Create `src/core/chapter-memory.mjs` with this complete content:

```js
import { readJson, safeJoin, writeJsonAtomic } from "./fs-utils.mjs";

export const CHAPTER_MEMORY_SCHEMA_VERSION = 1;
export const MAX_CONTEXT_CHAPTERS = 4;
export const OPENING_EXCERPT_CHARS = 420;
export const ENDING_EXCERPT_CHARS = 900;

export async function loadChapterMemory(projectRoot) {
  const memory = await readJson(safeJoin(projectRoot, "memory", "chapter_memory.json"), {
    schema_version: CHAPTER_MEMORY_SCHEMA_VERSION,
    chapters: []
  });
  return normalizeMemory(memory);
}

export async function recordChapterMemory(projectRoot, chapter) {
  const memory = await loadChapterMemory(projectRoot);
  const chapterNo = Number(chapter.chapterNo);
  if (!Number.isInteger(chapterNo) || chapterNo < 1) {
    throw new Error("chapterNo must be a positive integer.");
  }
  const clean = cleanChapterText(chapter.content);
  const entry = {
    chapter_no: chapterNo,
    title: chapter.title ?? `第${String(chapterNo).padStart(3, "0")}章`,
    actual_words: Number(chapter.actualWords ?? 0),
    checksum: chapter.checksum ?? null,
    opening_excerpt: clipStart(clean, OPENING_EXCERPT_CHARS),
    ending_excerpt: clipEnd(clean, ENDING_EXCERPT_CHARS)
  };
  const chapters = [
    ...memory.chapters.filter((item) => item.chapter_no !== chapterNo),
    entry
  ].sort((a, b) => a.chapter_no - b.chapter_no);
  const next = {
    schema_version: CHAPTER_MEMORY_SCHEMA_VERSION,
    chapters
  };
  await writeJsonAtomic(safeJoin(projectRoot, "memory", "chapter_memory.json"), next);
  return next;
}

export async function buildContinuityPromptContext(projectRoot, currentChapterNo) {
  const memory = await loadChapterMemory(projectRoot);
  const activeChapterNo = Number(currentChapterNo);
  const previous = memory.chapters
    .filter((chapter) => chapter.chapter_no < activeChapterNo)
    .slice(-MAX_CONTEXT_CHAPTERS);
  const lines = [
    "recent_completed_chapters:",
    `- 当前目标章节：第 ${activeChapterNo} 章。`
  ];
  if (previous.length === 0) {
    lines.push("- 第 1 章可以建立初始处境一次；后续章节必须承接已有场景和因果。");
    return lines.join("\n");
  }
  lines.push("- 继续上一章留下的动作、后果、线索或情绪压力，不要把本章写成新的第一章。");
  for (const chapter of previous) {
    lines.push(`\n### 第 ${chapter.chapter_no} 章：${chapter.title}`);
    lines.push(`字数：${chapter.actual_words}`);
    lines.push(`开头摘录：${chapter.opening_excerpt}`);
    lines.push(`上一章落点：${chapter.ending_excerpt}`);
  }
  return lines.join("\n");
}

function normalizeMemory(memory) {
  const chapters = Array.isArray(memory?.chapters)
    ? memory.chapters
        .map((chapter) => ({
          chapter_no: Number(chapter.chapter_no),
          title: String(chapter.title ?? ""),
          actual_words: Number(chapter.actual_words ?? 0),
          checksum: chapter.checksum ?? null,
          opening_excerpt: String(chapter.opening_excerpt ?? ""),
          ending_excerpt: String(chapter.ending_excerpt ?? "")
        }))
        .filter((chapter) => Number.isInteger(chapter.chapter_no) && chapter.chapter_no > 0)
        .sort((a, b) => a.chapter_no - b.chapter_no)
    : [];
  return {
    schema_version: CHAPTER_MEMORY_SCHEMA_VERSION,
    chapters
  };
}

function cleanChapterText(content) {
  return String(content ?? "")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/^#\s+Chapter\s+\d+\s*$/gimu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function clipStart(text, maxChars) {
  const source = normalizeExcerpt(text);
  return source.length > maxChars ? `${source.slice(0, maxChars)}…` : source;
}

function clipEnd(text, maxChars) {
  const source = normalizeExcerpt(text);
  return source.length > maxChars ? `…${source.slice(-maxChars)}` : source;
}

function normalizeExcerpt(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}
```

- [ ] **Step 2: Initialize chapter memory for new projects**

In `src/core/project-store.mjs`, add this import near the other imports:

```js
import { CHAPTER_MEMORY_SCHEMA_VERSION } from "./chapter-memory.mjs";
```

After the existing creation of `memory/chapter_index.json`:

```js
  await writeJsonAtomic(safeJoin(target, "memory", "chapter_index.json"), {
    schema_version: SCHEMA_VERSION,
    chapters: []
  });
```

add:

```js
  await writeJsonAtomic(safeJoin(target, "memory", "chapter_memory.json"), {
    schema_version: CHAPTER_MEMORY_SCHEMA_VERSION,
    chapters: []
  });
```

- [ ] **Step 3: Run focused project-store tests**

Run:

```powershell
npm test -- tests/project-store.test.mjs
```

Expected: PASS. Existing project creation behavior remains valid, and the new memory file does not break project creation.

- [ ] **Step 4: Checkpoint**

Record in the implementation notes:

```text
Task 4 checkpoint: chapter memory module exists, new projects initialize chapter_memory.json, project-store tests pass.
```

---

### Task 5: Inject Continuity Memory And Anti-AI-Tone Rules

**Files:**
- Modify: `src/core/agent-engine.mjs`
- Test: `tests/agent-engine.test.mjs`

- [ ] **Step 1: Import chapter memory helpers**

In `src/core/agent-engine.mjs`, add this import with the other core imports:

```js
import { buildContinuityPromptContext, recordChapterMemory } from "./chapter-memory.mjs";
```

- [ ] **Step 2: Record memory after finalization**

In `finalizeChapter(projectRoot, project, state)`, immediately after:

```js
  const result = await finalizeChapterFile(projectRoot, project, state.current_chapter_no);
```

add:

```js
  await recordChapterMemory(projectRoot, {
    chapterNo: state.current_chapter_no,
    title: `第${String(state.current_chapter_no).padStart(3, "0")}章`,
    actualWords: result.actual_words,
    checksum: result.checksum,
    content: postProcess.content
  });
```

- [ ] **Step 3: Read continuity context while compiling prompts**

In `compileChapterPrompt(projectRoot, project, state, request)`, replace the current `Promise.all` declaration:

```js
  const [promptTemplate, bookSummary, draft, latestUserFeedback, planningSkillPrompts, stageSkillPrompts] = await Promise.all([
```

with:

```js
  const [promptTemplate, bookSummary, draft, latestUserFeedback, planningSkillPrompts, stageSkillPrompts, continuityContext] = await Promise.all([
```

Then add this item as the last entry in the same `Promise.all` array:

```js
    buildContinuityPromptContext(projectRoot, state.current_chapter_no)
```

The end of the array should look like:

```js
    collectSkillPromptHooks(projectRoot, project, state.current_stage, {
      chapter_no: state.current_chapter_no,
      stage: state.current_stage
    }),
    buildContinuityPromptContext(projectRoot, state.current_chapter_no)
  ]);
```

- [ ] **Step 4: Add explicit writing style and continuity rules**

Inside `compileChapterPrompt`, after:

```js
  const skillInstructions = [planningSkillPrompts.content, stageSkillPrompts.content].filter(Boolean).join("\n\n");
```

add:

```js
  const styleRules = [
    `Output format: ${project.output_format}. Minimum effective words per chapter: ${project.min_words_per_chapter}.`,
    "叙事连续性：第 2 章及以后必须承接上一章落点，不要把本章写成新的第一章，不要重复介绍主角和世界观。",
    "段落连续性：segment_no 大于 1 时，直接续写 selected_draft_fragment 的最后动作、对话或悬念，不要另起一个开头。",
    "去 AI 腔：减少抽象宣告，用具体动作、环境细节、人物选择和后果推进剧情。",
    "禁用高频套路词和套话，除非用户原始设定强制要求：普通大学生突然获得神力、不是梦、三天了、你不是唯一一个、代价、神性、命运逼近、神秘力量。"
  ].join("\n");
  const chapterContinuityRule = state.current_chapter_no > 1
    ? `第 ${state.current_chapter_no} 章必须从第 ${state.current_chapter_no - 1} 章留下的后果、线索或情绪压力继续推进。`
    : "第 1 章可以建立初始处境一次；不要在同一章后续段落重复开场。";
```

- [ ] **Step 5: Use the new style and memory blocks in the prompt**

In the `compiler.compile({ stableBlocks, dynamicBlocks })` call, replace:

```js
      style: `Output format: ${project.output_format}. Minimum effective words per chapter: ${project.min_words_per_chapter}.`,
      skill_instructions: skillInstructions,
      project_memory: bookSummary,
      chapter_plan: `Chapter ${state.current_chapter_no} of ${project.target_chapters}.`
```

with:

```js
      style: styleRules,
      skill_instructions: skillInstructions,
      project_memory: [bookSummary, continuityContext].filter(Boolean).join("\n\n"),
      chapter_plan: [`Chapter ${state.current_chapter_no} of ${project.target_chapters}.`, chapterContinuityRule].join("\n")
```

In the `current_task` JSON object, after:

```js
          validation_feedback: request.validation_feedback
```

add a trailing comma to that line and then add:

```js
          segment_continuity_required: request.segment_no > 1,
          chapter_continuity_required: request.chapter_no > 1,
          forbidden_reboot_patterns: [
            "普通大学生突然获得神力",
            "不是梦",
            "三天了",
            "你不是唯一一个",
            "代价",
            "神性"
          ]
```

- [ ] **Step 6: Run the focused engine tests**

Run:

```powershell
npm test -- tests/agent-engine.test.mjs
```

Expected: PASS. The tests added in Task 3 should now pass, and existing engine tests should remain green.

- [ ] **Step 7: Checkpoint**

Record in the implementation notes:

```text
Task 5 checkpoint: finalized chapters are recorded into chapter memory, later prompts include recent_completed_chapters and anti-reboot style rules, agent-engine tests pass.
```

---

### Task 6: Full Verification

**Files:**
- No additional source changes in this task.

- [ ] **Step 1: Run all unit tests**

Run:

```powershell
npm test
```

Expected: PASS. All `tests/*.test.mjs` files complete successfully.

- [ ] **Step 2: Run app-shell verification**

Run:

```powershell
npm run verify:app-shell
```

Expected: PASS. Static UI assertions, dashboard smoke checks, side-question checks, and chapter reader checks all complete successfully.

- [ ] **Step 3: Run MVP verification**

Run:

```powershell
npm run verify:mvp
```

Expected: PASS. The end-to-end local writing workflow still creates project files, writes chapters through the tool path, and passes reviewer checks.

- [ ] **Step 4: Manual UI smoke check**

Run the app shell:

```powershell
npm run app:shell
```

Open the printed local URL in a browser and verify these visible behaviors:

```text
1. With the composer empty, no thin blank command bar appears above the composer.
2. Typing "/" opens the command menu.
3. Using ArrowDown changes the highlighted command row.
4. During drafting, the progress row reads "写入第 X 章中" and the right status reads "Writing...".
5. Existing completed chapters remain unchanged on disk.
```

- [ ] **Step 5: Final checkpoint**

Record in the implementation notes:

```text
Task 6 checkpoint: npm test, verify:app-shell, verify:mvp, and manual UI smoke check passed.
```

---

## Self-Review Notes

- Spec coverage:
  - `起草` user perception is handled by Task 2 dynamic copy.
  - Empty command surface is handled by Task 2 hidden CSS and slash active styling.
  - Multi-chapter incoherence is handled by Tasks 4 and 5 through durable chapter memory and prompt injection.
  - AI-tone repetition is handled by Task 5 style rules and forbidden pattern list.
  - Existing chapters are not rewritten; Task 6 manual check verifies this.
- Placeholder scan:
  - This plan contains exact file paths, exact snippets, exact commands, and expected outcomes.
- Type consistency:
  - `chapterNo`, `actualWords`, and `ending_excerpt` names are defined in `chapter-memory.mjs` and used consistently from `agent-engine.mjs`.
